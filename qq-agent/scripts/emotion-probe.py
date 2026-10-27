#!/usr/bin/env python3
"""情绪标签探针：量每个 [tag] 对音高、语速、能量的实际影响。

同一句文本，反复换标签合成，量中位基频、时长、响度。
模型 seed 固定，同一输入结果确定，所以差异是真实的。

用法（云上）: /opt/bailian/bin/python3 /root/qq-agent/scripts/emotion-probe.py
"""
import json
import os
import subprocess

import dashscope
import numpy as np
from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

dashscope.api_key = os.environ.get("DASHSCOPE_API_KEY", "")
MODEL = os.environ.get("BAILIAN_TTS_MODEL", "qwen-audio-3.1-tts-flash")
VOICE = os.environ.get("BAILIAN_TTS_VOICE", "baiqinglan_v3.1")
OUT = "/tmp/emo-probe"
os.makedirs(OUT, exist_ok=True)

SENT = "诶，你咋才回啊，我都等半天了。"
TAGS = {
    "none": SENT,
    "excited": f"[excited]{SENT}",
    "sad": f"[sad]{SENT}",
    "amazed": f"[amazed]{SENT}",
    "tired": f"[tired]{SENT}",
    "curious": f"[curious]{SENT}",
    "empathetic": f"[empathetic]{SENT}",
    "serious": f"[serious]{SENT}",
    "whispers": f"[whispers]{SENT}",
    "reluctantly": f"[reluctantly]{SENT}",
    "mischievously": f"[mischievously]{SENT}",
    "bored": f"[bored]{SENT}",
}


def synth(text):
    s = SpeechSynthesizer(
        model=MODEL, voice=VOICE,
        format=AudioFormat.MP3_24000HZ_MONO_256KBPS,
    )
    return s.call(text, timeout_millis=60000)


def pcm(path):
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def analyze(x):
    sr, win, hop = 16000, 800, 160
    f0, rms = [], []
    for i in range(0, max(1, len(x) - win), hop):
        fr = x[i:i + win]
        if len(fr) < win:
            break
        r = float(np.sqrt(np.mean(fr ** 2)))
        rms.append(r)
        fr = fr - fr.mean()
        if r < 0.01:
            f0.append(0.0)
            continue
        ac = np.correlate(fr, fr, "full")[win - 1:]
        lo, hi = int(sr / 400), int(sr / 90)
        seg = ac[lo:hi]
        lag = int(np.argmax(seg)) + lo
        f0.append(float(sr / lag) if seg.max() > 0.3 * ac[0] else 0.0)
    v = [f for f in f0 if f > 0]
    v.sort()
    med = v[len(v) // 2] if v else 0
    voiced_s = len(v) * hop / sr
    return {
        "dur": round(len(x) / sr, 2),
        "f0_med": round(med),
        "f0_p10": round(v[int(len(v) * 0.1)]) if v else 0,
        "f0_p90": round(v[int(len(v) * 0.9)]) if v else 0,
        "rms": round(float(np.mean(rms)), 4),
        "chars_per_s": round(len([c for c in SENT if '\u4e00' <= c <= '\u9fa5']) / voiced_s, 2) if voiced_s else 0,
    }


res = {}
for name, text in TAGS.items():
    path = os.path.join(OUT, f"{name}.mp3")
    try:
        data = synth(text)
        with open(path, "wb") as f:
            f.write(data)
        res[name] = analyze(pcm(path))
    except Exception as e:  # noqa: BLE001
        res[name] = {"error": f"{type(e).__name__}: {str(e)[:100]}"}
    print(name, json.dumps(res[name], ensure_ascii=False))

base = res.get("none", {})
if "f0_med" in base:
    print("\n--- 与无标签对比 ---")
    for k, v in res.items():
        if k == "none" or "f0_med" not in v:
            continue
        dp = (v["f0_med"] - base["f0_med"]) / base["f0_med"] * 100
        dd = v["dur"] - base["dur"]
        print(f"{k:15s} f0 {v['f0_med']}Hz ({dp:+.0f}%)  dur {v['dur']}s ({dd:+.2f}s)  "
              f"cps {v['chars_per_s']}  rms {v['rms']}")

with open(os.path.join(OUT, "emotion.json"), "w") as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
