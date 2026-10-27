#!/usr/bin/env python3
"""SSML 探针：在真实的百炼 TTS 服务上试 <break> / <emphasis> / <prosody> 是否真的生效。

对每条 SSML 各合成一次，并合成一版「去标签的纯文本」作对照，比对时长与波形：
  听不出的指标就用时长差与能量包络差来量。

用法（云上）: /opt/bailian/bin/python3 /root/qq-agent/scripts/ssml-probe.py
"""
import hashlib
import json
import os
import subprocess

import dashscope
import numpy as np
from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

dashscope.api_key = os.environ.get("DASHSCOPE_API_KEY", "")
MODEL = os.environ.get("BAILIAN_TTS_MODEL", "qwen-audio-3.1-tts-flash")
VOICE = os.environ.get("BAILIAN_TTS_VOICE", "baiqinglan_v3.1")
OUT = "/tmp/ssml-probe"
os.makedirs(OUT, exist_ok=True)

CASES = {
    "plain": "诶，你咋才回啊，我都等半天了。",
    "break040": '诶，<break time="400ms"/>你咋才回啊，<break time="400ms"/>我都等半天了。',
    "break1500": '诶，<break time="1500ms"/>你咋才回啊，<break time="1500ms"/>我都等半天了。',
    "emph": "诶，你<emphasis level=\"strong\">咋才回</emphasis>啊，我都等半天了。",
    "prosody_slow": '<prosody rate="slow">诶，你咋才回啊，我都等半天了。</prosody>',
    "prosody_pitch": '<prosody pitch="high">诶，你咋才回啊，我都等半天了。</prosody>',
}


def synth(text):
    s = SpeechSynthesizer(
        model=MODEL,
        voice=VOICE,
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


def envelope(x, hop=160):
    n = len(x) // hop
    return np.array([float(np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2))) for i in range(n)])


def silences(x, thr=0.006, min_s=0.08):
    """返回超过 min_s 的静音段（开始秒, 长度秒）"""
    hop_s = 0.01
    env = envelope(x)
    out, run = [], 0
    for i, v in enumerate(env):
        if v < thr:
            run += 1
        else:
            if run * hop_s >= min_s:
                out.append((round((i - run) * hop_s, 2), round(run * hop_s, 2)))
            run = 0
    if run * hop_s >= min_s:
        out.append((round((len(env) - run) * hop_s, 2), round(run * hop_s, 2)))
    return out


res = {}
for name, text in CASES.items():
    try:
        data = synth(text)
    except Exception as e:  # noqa: BLE001
        res[name] = {"error": f"{type(e).__name__}: {e}"}
        print(name, "ERROR", res[name]["error"])
        continue
    path = os.path.join(OUT, f"{name}.mp3")
    with open(path, "wb") as f:
        f.write(data)
    x = pcm(path)
    dur = len(x) / 16000
    env = envelope(x)
    res[name] = {
        "bytes": len(data),
        "sha": hashlib.sha256(data).hexdigest()[:12],
        "dur_s": round(dur, 2),
        "silences": silences(x),
        "rms": round(float(np.sqrt(np.mean(x ** 2))), 4),
        "env_len": len(env),
    }
    print(name, json.dumps(res[name], ensure_ascii=False))

# 结论比对：BREAK 是否真的拉开静音，EMPH 是否比 plain 长
base = res.get("plain", {})
print("\n--- 对照 ---")
for k in ("break040", "break1500", "emph", "prosody_slow", "prosody_pitch"):
    r = res.get(k, {})
    if "dur_s" in r and "dur_s" in base:
        print(f"{k}: dur {r['dur_s']}s vs plain {base['dur_s']}s  Δ={r['dur_s']-base['dur_s']:+.2f}s  "
              f"silences={r['silences']}  sha={r['sha']} (plain {base['sha']})")
    else:
        print(k, r)

with open(os.path.join(OUT, "result.json"), "w") as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
