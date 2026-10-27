#!/usr/bin/env python3
"""确认 SDK 的 speech_rate / pitch_rate / volume 参数是否真的生效。

这三个是官方参数（0.5~2.0），比 SSML 的 prosody 靠谱；用于把语速
从实测 ~255 字/分 压到 180~220 的目标区间。

用法（云上）: /opt/bailian/bin/python3 /root/qq-agent/scripts/rate-probe.py
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
OUT = "/tmp/rate-probe"
os.makedirs(OUT, exist_ok=True)

SENT = "诶，你咋才回啊，我都等半天了。"
CHARS = len([c for c in SENT if '\u4e00' <= c <= '\u9fa5'])
CASES = {
    "rate1.00": dict(speech_rate=1.0),
    "rate0.90": dict(speech_rate=0.9),
    "rate0.85": dict(speech_rate=0.85),
    "rate0.80": dict(speech_rate=0.8),
    "pitch0.90": dict(pitch_rate=0.9),
    "pitch1.10": dict(pitch_rate=1.1),
    "vol40": dict(volume=40),
}


def synth(**kw):
    s = SpeechSynthesizer(
        model=MODEL, voice=VOICE,
        format=AudioFormat.MP3_24000HZ_MONO_256KBPS, **kw,
    )
    return s.call(SENT, timeout_millis=60000)


def pcm(path):
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def f0med(x):
    sr, win, hop = 16000, 800, 160
    v = []
    for i in range(0, max(1, len(x) - win), hop):
        fr = x[i:i + win]
        if len(fr) < win:
            break
        fr = fr - fr.mean()
        if np.sqrt(np.mean(fr ** 2)) < 0.01:
            continue
        ac = np.correlate(fr, fr, "full")[win - 1:]
        lo, hi = int(sr / 400), int(sr / 90)
        seg = ac[lo:hi]
        lag = int(np.argmax(seg)) + lo
        if seg.max() > 0.3 * ac[0]:
            v.append(float(sr / lag))
    v.sort()
    return round(v[len(v) // 2]) if v else 0


res = {}
for name, kw in CASES.items():
    p = os.path.join(OUT, f"{name}.mp3")
    try:
        data = synth(**kw)
        with open(p, "wb") as f:
            f.write(data)
        x = pcm(p)
        dur = len(x) / 16000
        res[name] = {
            "dur": round(dur, 2),
            "cpm": round(CHARS / dur * 60),   # 字/分钟，按总时长算（含停顿）
            "f0_med": f0med(x),
            "rms": round(float(np.sqrt(np.mean(x ** 2))), 4),
        }
    except Exception as e:  # noqa: BLE001
        res[name] = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
    print(name, json.dumps(res[name], ensure_ascii=False))

with open(os.path.join(OUT, "rate.json"), "w") as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
