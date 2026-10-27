#!/usr/bin/env python3
"""百炼 TTS 本地服务。

只监听 127.0.0.1，给桥提供 POST /tts：
  {
    "text": "...",                 # 可含 <break time="0.4s"/> / <emphasis>词</emphasis>
    "instruction": "...",          # 自然语言指令（语感/场景）
    "voice": "...",                # 音色 ID，留空用默认
    "emotion": "gentle",           # 情绪标签，见 EMOTIONS
    "intensity": 0.6,              # 0~1，情绪强度
    "rate": 1.0, "pitch": 1.0,     # 可选，再叠一层语速/音高
    "volume": 50                   # 可选
  }
返回 audio/mpeg。

为什么要自己切段：
  实测 <break time="1500ms"/> 只比自然停顿多 0.19 秒，1500ms 并没有被当真；
  所以我们把带 break 的稿子拆开、各自合成 PCM、再按毫秒拼真静音，
  停顿时长由我们说了算，不靠模型猜。

为什么要用 PCM：
  分段各出一段 mp3 再拼，每段解码都有 priming 残差，接缝处会咔哒；
  拿 PCM 直接拼样点，最后只编码一次。

密钥走环境变量 DASHSCOPE_API_KEY，由 systemd 的 EnvironmentFile 注入。
"""
import json
import os
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dashscope
import numpy as np
from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

MODEL = os.environ.get("BAILIAN_TTS_MODEL", "qwen-audio-3.1-tts-flash")
VOICE = os.environ.get("BAILIAN_TTS_VOICE", "baiqinglan_v3.1")
PORT = int(os.environ.get("BAILIAN_TTS_PORT", "3911"))
SR = 24000
# 默认语速系数。实测 speech_rate=1.0 是 ~250 字/分，比「180~220」的要求快；
# 0.88 大约落在 ~220，0.85 约 210。可用 BAILIAN_TTS_RATE 或请求里的 rate 覆盖。
DEFAULT_RATE = float(os.environ.get("BAILIAN_TTS_RATE", "0.88"))
dashscope.api_key = os.environ.get("DASHSCOPE_API_KEY", "")

# 情绪 → 官方副语言标签 + 韵律增量。
# 数字是用 scripts/emotion-probe.py 在真模型上量出来的方向：
#   excited   f0 -8%  +0.39s  响度 +12%
#   sad       f0 -15% +1.44s
#   amazed    f0 +6%
#   tired     f0 -19% +1.20s
#   curious   f0 ±0%  +0.80s
#   empathetic f0 -6% +0.15s
#   serious   f0 -17% +0.39s
#   whispers  f0 -34% 响度 -65%
# 这里只做「标签 + 一点参数微调」，不重复标签已经做的事。
EMOTIONS = {
    # happy 的 [excited] 标签实测 f0 +18%、响度 +21%，在 QQ 的 22kbps AMR 里就是破。
    # 2026-10-23 用户「太激动容易破」，标签去掉，只留一点点参数变化。
    "happy":       {"tag": "",             "rate": 1.02, "pitch": 1.00, "vol": 50},
    "sad":         {"tag": "[sad]",        "rate": 0.92, "pitch": 0.96, "vol": 46},
    "surprised":   {"tag": "[amazed]",     "rate": 1.02, "pitch": 1.03, "vol": 52},
    "gentle":      {"tag": "[empathetic]", "rate": 0.95, "pitch": 0.99, "vol": 47},
    "calm":        {"tag": "[serious]",    "rate": 0.94, "pitch": 0.96, "vol": 48},
    "confused":    {"tag": "[curious]",    "rate": 0.93, "pitch": 1.00, "vol": 49},
    "encouraging": {"tag": "[empathetic]", "rate": 1.00, "pitch": 1.02, "vol": 52},
    "sleepy":      {"tag": "[tired]",      "rate": 0.90, "pitch": 0.95, "vol": 45},
    "soft":        {"tag": "[whispers]",   "rate": 0.98, "pitch": 0.98, "vol": 38},
    "none":        {"tag": "",             "rate": 1.00, "pitch": 1.00, "vol": 50},
}

BREAK_RE = re.compile(r'<\s*break\s+time\s*=\s*"([0-9.]+)\s*(ms|s)"\s*/?\s*>', re.I)
EMPH_RE = re.compile(r"<\s*emphasis(?:\s+level\s*=\s*\"[^\"]*\")?\s*>(.*?)<\s*/\s*emphasis\s*>", re.I | re.S)
TAG_ANY_RE = re.compile(r"</?\s*(?!break|emphasis)[a-zA-Z][^>]*>")

# 停顿方式：默认用「……」交给模型自己顿（用户选定的做法）。
# 设 BAILIAN_TTS_BREAKS=1 才会启用「按 <break> 切段、插精确静音」那条路——
# 那条路实测能做到 0.4s 就是 0.46s，但拼段会有接缝感，用户已否决。
ENABLE_BREAKS = os.environ.get("BAILIAN_TTS_BREAKS", "0") == "1"


def parse_duration(val, unit):
    v = float(val)
    return v / 1000.0 if unit.lower() == "ms" else v


def split_segments(text):
    """按 <break time> 切段，返回 [(文本, 段后静音秒数)]"""
    out = []
    pos = 0
    for m in BREAK_RE.finditer(text):
        seg = text[pos:m.start()]
        pause = parse_duration(m.group(1), m.group(2))
        out.append((seg, pause))
        pos = m.end()
    out.append((text[pos:], 0.0))
    # 去掉空段，但保留静音（空段 + 静音 = 独立停顿）
    merged = []
    for seg, pause in out:
        if not seg.strip() and merged:
            merged[-1] = (merged[-1][0], merged[-1][1] + pause)
        else:
            merged.append((seg, pause))
    return merged


def extract_emphasis(text):
    """收集 <emphasis> 里的词，并从正文里去掉标签（保留文字）。"""
    words = [m.group(1).strip() for m in EMPH_RE.finditer(text) if m.group(1).strip()]
    return words


def strip_tags(text):
    """去掉不认识的标签，但**保留 <emphasis>**——
    模型原生就认这个标签（实测同一句话带不带 emphasized 段，时长差 0.2~0.6 秒），
    交给它自己处理比重写成自然语言指令更准。"""
    text = TAG_ANY_RE.sub("", text)
    text = BREAK_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def rms_np(x):
    return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0


def normalize(x, target_db=-1.5, ceiling=0.97):
    """段间响度拉平，避免切段后一句响一句轻"""
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak <= 1e-6:
        return x
    x = x / peak * 10 ** (target_db / 20)
    return np.clip(x, -ceiling, ceiling)


def fade_out(x, ms=120):
    n = min(len(x), int(SR * ms / 1000))
    if n <= 1:
        return x
    ramp = np.linspace(1.0, 0.0, n, dtype=np.float32) ** 1.5
    x = x.copy()
    x[-n:] *= ramp
    return x


def trim_edges(x, thr=0.004, keep_ms=25):
    """掐掉段首段尾的静音。

    百炼每段自带一点开头/结尾静音；不掐掉的话，我们插的 0.4s 会和它叠加，
    实测会变成 0.7s。掐完再拼，停顿时长才是我们写多少就是多少。
    """
    if len(x) == 0:
        return x
    env = np.abs(x)
    idx = np.nonzero(env > thr)[0]
    if len(idx) == 0:
        return x[:0]
    keep = int(SR * keep_ms / 1000)
    a = max(0, idx[0] - keep)
    b = min(len(x), idx[-1] + 1 + keep)
    return x[a:b]


def synth_pcm(text, instruction, voice, rate, pitch, vol):
    s = SpeechSynthesizer(
        model=MODEL, voice=voice,
        format=AudioFormat.PCM_24000HZ_MONO_16BIT,
        speech_rate=rate, pitch_rate=pitch, volume=vol,
        instruction=instruction or None,
    )
    data = s.call(text, timeout_millis=60000)
    if not data:
        raise RuntimeError("empty audio")
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def pcm_to_mp3(pcm, loudness=None):
    raw = (np.clip(pcm, -1, 1) * 32767).astype(np.int16).tobytes()
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        out = f.name
    try:
        cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y",
               "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0"]
        # 峰值留 3dB 余量（2026-10-23 修「QQ 里听着破」）：
        # QQ 会把语音重编码成 16kHz 的 SILK，源信号顶在 -0.8dBFS 这种位置时，
        # 重采样 + 低码率编码的过冲会削波，听感就是「破/劈」。
        # alimiter 只削峰，level=false 保持整体电平不变，不会把音量压小；
        # 要更响仍然走 loudness="loud"（现在 config 里是关的）。
        filters = []
        # 2026-10-24 用户听感定稿：**原版音色更好**，不要 loudnorm 那套「推轻 + 压动态」。
        # 所以响度链回到原样：5.2k 削一刀 + 6.8k 低通 + volume +3dB + alimiter 0.708（峰值 −3dBFS）。
        # 实测这条是 −13.6 LUFS / TP −3.7 / LRA 0.3~1.0。
        # 唯一保留的改动是输出 24kHz（见下面），因为那是纯损失，不改变音色。
        if loudness == "loud":
            filters.append(f"loudnorm=I=-15:TP=-1.0:LRA=11")
        else:
            # TTS 在 5.2kHz 有个固定尖峰。
            filters.append("equalizer=f=5200:t=q:w=1.2:g=-4")
            filters.append("lowpass=f=6800:poles=2")
            filters.append("volume=3dB")
            filters.append("alimiter=limit=0.708:level=false")
        cmd += ["-af", ",".join(filters)]
        # 2026-10-24 修正：之前出 16kHz，但 NapCat 转 silk 用的是
        # `-ar 24000 -c:a ntsilk_s16le`（在 napcat.mjs 的 convertToNTSilkTct 里），
        # 等于我们先把 24k 降成 16k、NapCat 再升回 24k，白丢 8~12kHz 还多一次重采样。
        # 现在直接出 24kHz（源 PCM 本来就是 SR=24000，零重采样）。
        # 96kbps：源给足余量，QQ 那边还要再压一次，源头越干净编码器越不容易出错。
        cmd += ["-c:a", "libmp3lame", "-b:a", "96k", "-ar", "24000", "-ac", "1", out]
        p = subprocess.run(cmd, input=raw, capture_output=True)
        if p.returncode != 0:
            raise RuntimeError(f"ffmpeg encode failed: {p.stderr[-300:]!r}")
        with open(out, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def emotion_params(emotion, intensity, rate0, pitch0, vol0):
    emo = EMOTIONS.get((emotion or "none").lower(), EMOTIONS["none"])
    t = max(0.0, min(1.0, float(intensity if intensity is not None else 0.65)))
    rate = rate0 * (1 + (emo["rate"] - 1) * t)
    pitch = pitch0 * (1 + (emo["pitch"] - 1) * t)
    vol = vol0 + (emo["vol"] - 50) * t
    return emo["tag"], round(rate, 3), round(pitch, 3), int(max(0, min(100, round(vol))))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b"ok")
        elif self.path == "/emotions":
            self._send(200, json.dumps(EMOTIONS, ensure_ascii=False).encode(), "application/json")
        else:
            self._send(404, b"not found")

    def do_POST(self):
        if self.path != "/tts":
            return self._send(404, b"not found")
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:  # noqa: BLE001
            return self._send(400, f"bad json: {e}".encode())

        raw_text = (payload.get("text") or "").strip()
        if not raw_text:
            return self._send(400, b"empty text")
        if not dashscope.api_key:
            return self._send(500, b"missing DASHSCOPE_API_KEY")

        voice = payload.get("voice") or VOICE
        instruction = payload.get("instruction") or None
        tag, rate, pitch, vol = emotion_params(
            payload.get("emotion"), payload.get("intensity"),
            float(payload.get("rate") or DEFAULT_RATE),
            float(payload.get("pitch") or 1.0),
            float(payload.get("volume") or 50),
        )

        emph = extract_emphasis(raw_text)

        def instruction_for(text):
            """只有本段真的含有这个词，才要求加重，别把重音撒到别的句子上。"""
            hit = [w for w in emph if w and w in text][:2]
            if not hit:
                return instruction
            add = f"把「{'、'.join(hit)}」说得重一点、慢一点"
            return f"{instruction}；{add}" if instruction else add

        # 停顿默认交给模型自己按「……」处理：整段一次合成，不切、不插静音。
        # 只有在 BAILIAN_TTS_BREAKS=1 时才按 <break> 切段并插精确静音。
        if ENABLE_BREAKS:
            segments = split_segments(raw_text)
        else:
            segments = [(raw_text, 0.0)]

        pieces = []
        for seg, pause in segments:
            t = strip_tags(seg)
            pieces.append([t, pause])
        pieces = [p for p in pieces if p[0]]

        if not pieces:
            return self._send(400, b"empty text after stripping tags")

        def one(text):
            return synth_pcm(f"{tag}{text}" if tag else text,
                             instruction_for(text), voice, rate, pitch, vol)

        try:
            if len(pieces) == 1:
                pcm = one(pieces[0][0])
            else:
                with ThreadPoolExecutor(max_workers=min(3, len(pieces))) as ex:
                    outs = list(ex.map(one, [p[0] for p in pieces]))
                chunks = []
                for i, (piece, audio) in enumerate(zip(pieces, outs)):
                    a = normalize(trim_edges(audio))
                    chunks.append(a)
                    pause = pieces[i][1]
                    if pause > 0:
                        chunks.append(np.zeros(int(SR * pause), dtype=np.float32))
                pcm = np.concatenate(chunks)
            if len(pcm) < SR * 0.1:
                raise RuntimeError("audio too short")
            pcm = fade_out(pcm, 120 if len(pieces) > 1 else 60)
            mp3 = pcm_to_mp3(pcm, payload.get("loudness"))
        except Exception as e:  # noqa: BLE001
            return self._send(502, f"tts failed: {type(e).__name__}: {e}".encode())

        self._send(200, mp3, "audio/mpeg")

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"bailian tts on 127.0.0.1:{PORT} model={MODEL} voice={VOICE}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
