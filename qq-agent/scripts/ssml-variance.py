#!/usr/bin/env python3
"""SSML 复测：先量「同一句话多次合成的自然抖动」，再判断标签差异是否超出抖动。

单次比对会被播报随机性骗到（同一句两次合成也差 0.2~0.5 秒），
所以每组跑 N 次，看均值和标准差。

用法（云上）: /opt/bailian/bin/python3 /root/qq-agent/scripts/ssml-variance.py
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
OUT = "/tmp/ssml-var"
os.makedirs(OUT, exist_ok=True)
N = int(os.environ.get("PROBE_N", "4"))

CASES = {
    "plain": "诶，你咋才回啊，我都等半天了。",
    "break1500": '诶，<break time="1500ms"/>你咋才回啊，<break time="1500ms"/>我都等半天了。',
    "break400": '诶，<break time="400ms"/>你咋才回啊，<break time="400ms"/>我都等半天了。',
    "emph": '诶，你<emphasis level="strong">咋才回</emphasis>啊，我都等半天了。',
    "slow": '<prosody rate="slow">诶，你咋才回啊，我都等半天了。</prosody>',
    "xslow": '<prosody rate="x-slow">诶，你咋才回啊，我都等半天了。</prosody>',
}


def synth(text):
    s = SpeechSynthesizer(
        model=MODEL, voice=VOICE,
        format=AudioFormat.MP3_24000HZ_MONO_256KBPS,
        additional_params={"enable_ssml": True},
    )
    return s.call(text, timeout_millis=60000)


def pcm(path):
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def longest_silence(x, thr=0.006):
    hop = 160
    hop_s = hop / 16000
    env = [float(np.sqrt(np.mean(x[i:i + hop] ** 2))) for i in range(0, len(x) - hop, hop)]
    best = run = 0
    for v in env:
        if v < thr:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return round(best * hop_s, 2)


stats = {}
for name, text in CASES.items():
    durs, sils = [], []
    for i in range(N):
        try:
            data = synth(text)
        except Exception as e:  # noqa: BLE001
            print(name, i, "ERR", type(e).__name__, str(e)[:120])
            continue
        p = os.path.join(OUT, f"{name}-{i}.mp3")
        with open(p, "wb") as f:
            f.write(data)
        x = pcm(p)
        durs.append(len(x) / 16000)
        sils.append(longest_silence(x))
    if not durs:
        stats[name] = {"error": True}
        continue
    stats[name] = {
        "n": len(durs),
        "dur_mean": round(float(np.mean(durs)), 2),
        "dur_sd": round(float(np.std(durs)), 2),
        "dur_min": round(min(durs), 2),
        "dur_max": round(max(durs), 2),
        "sil_mean": round(float(np.mean(sils)), 2),
        "sil_max": round(max(sils), 2),
    }
    print(name, json.dumps(stats[name]))

base = stats.get("plain", {})
print("\n--- 与 plain 比较（差值的绝对值 vs plain 自身标准差）---")
for k, v in stats.items():
    if k == "plain" or "dur_mean" not in v or "dur_mean" not in base:
        continue
    d = v["dur_mean"] - base["dur_mean"]
    sig = "有效" if abs(d) > max(2 * base["dur_sd"], 0.15) else "在抖动范围内，不可信"
    print(f"{k:12s} Δdur={d:+.2f}s  Δsil={v['sil_mean']-base['sil_mean']:+.2f}s  → {sig}")

with open(os.path.join(OUT, "stats.json"), "w") as f:
    json.dump(stats, f, ensure_ascii=False, indent=2)
