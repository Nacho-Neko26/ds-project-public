#!/usr/bin/env python3
"""端到端验收：走真实 HTTP /tts，验证 SSML 与情绪标签到底有没有落地。

量四件事：
  1. <break time="0.4s"/> 是否真的产生 ~0.4 秒静音（拿掉标签的同句作对照）
  2. <emphasis> 是否改变该句的时长/能量
  3. emotion 是否真的改变音高/时长（gentle vs happy vs sleepy）
  4. 语速是否落在 180~220 字/分

用法（云上）: /opt/bailian/bin/python3 /root/qq-agent/scripts/e2e-accept.py
"""
import json
import subprocess
import urllib.request

import numpy as np

URL = "http://127.0.0.1:3911/tts"
SR = 24000


def tts(**payload):
    req = urllib.request.Request(
        URL, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def pcm(mp3_bytes):
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error",
         "-f", "mp3", "-i", "pipe:0",
         "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
        input=mp3_bytes, capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode()[-300:])
    return np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def pauses(x, thr=0.008, min_s=0.15):
    hop = 480  # 20ms
    env = [float(np.sqrt(np.mean(x[i:i + hop] ** 2))) for i in range(0, len(x) - hop, hop)]
    runs, run = [], 0
    for v in env:
        if v < thr:
            run += 1
        else:
            if run * 0.02 >= min_s:
                runs.append(round(run * 0.02, 2))
            run = 0
    if run * 0.02 >= min_s:
        runs.append(round(run * 0.02, 2))
    return runs


def f0med(x):
    win, hop = 800, 160
    v = []
    for i in range(0, max(1, len(x) - win), hop):
        fr = x[i:i + win]
        if len(fr) < win:
            break
        fr = fr - fr.mean()
        if np.sqrt(np.mean(fr ** 2)) < 0.01:
            continue
        ac = np.correlate(fr, fr, "full")[win - 1:]
        lo, hi = int(16000 / 400), int(16000 / 90)
        seg = ac[lo:hi]
        lag = int(np.argmax(seg)) + lo
        if seg.max() > 0.3 * ac[0]:
            v.append(float(16000 / lag))
    v.sort()
    return round(v[len(v) // 2]) if v else 0


def chars(s):
    return len([c for c in s if '\u4e00' <= c <= '\u9fff'])


def speech_seconds(x, thr=0.008, hop=480):
    """有声时长（扣掉停顿）——衡量真正的语速，别把停顿算进去"""
    env = [float(np.sqrt(np.mean(x[i:i + hop] ** 2))) for i in range(0, len(x) - hop, hop)]
    return sum(0.02 for v in env if v >= thr)


report = {}

# 1. break：同句有/无标签
plain = "诶你咋才回啊我都等半天了"
brk = '诶<break time="0.4s"/>你咋才回啊<break time="0.4s"/>我都等半天了'
for name, text in (("no_break", plain), ("with_break", brk)):
    x = pcm(tts(text=text, emotion="none", intensity=0))
    sec = speech_seconds(x)
    report[name] = {
        "dur": round(len(x) / SR, 2),
        "pauses": pauses(x),
        "cpm_total": round(chars(plain) / (len(x) / SR) * 60),
        "cpm_speech": round(chars(plain) / sec * 60) if sec else 0,
    }
    print(name, json.dumps(report[name], ensure_ascii=False))

# 2. emphasis
emph = "诶你<emphasis>咋才回</emphasis>啊我都等半天了"
x = pcm(tts(text=emph, emotion="none", intensity=0))
report["emphasis"] = {"dur": round(len(x) / SR, 2), "pauses": pauses(x)}
print("emphasis", json.dumps(report["emphasis"], ensure_ascii=False))

# 3. 情绪
SENT = "诶，你咋才回啊，我都等半天了"
for emo in ("none", "gentle", "happy", "sleepy", "calm", "encouraging"):
    x = pcm(tts(text=SENT, emotion=emo, intensity=0.7))
    sec = speech_seconds(x)
    report[f"emo_{emo}"] = {
        "dur": round(len(x) / SR, 2),
        "f0": f0med(x),
        "cpm_speech": round(chars(SENT) / sec * 60) if sec else 0,
        "rms": round(float(np.sqrt(np.mean(x ** 2))), 4),
    }
    print(emo, json.dumps(report[f"emo_{emo}"], ensure_ascii=False))

# 4. 小结
print("\n--- 小结 ---")
nb, wb = report["no_break"], report["with_break"]
print(f"break 0.4s x2: 时长 {nb['dur']}→{wb['dur']}s 静音段 {nb['pauses']} → {wb['pauses']}")
base = report["emo_none"]
for k, v in report.items():
    if not k.startswith("emo_") or k == "emo_none":
        continue
    dp = (v["f0"] - base["f0"]) / base["f0"] * 100
    dd = v["dur"] - base["dur"]
    print(f"{k[4:]:12s} f0 {dp:+5.0f}%  dur {dd:+.2f}s  cpm {v['cpm_speech']}  rms {v['rms']}")
speeds = [v["cpm_speech"] for k, v in report.items() if "cpm_speech" in v and k != "with_break"]
print(f"语速范围(有声): {min(speeds)} ~ {max(speeds)} 字/分（目标 180~220）")

with open("/tmp/e2e-accept.json", "w") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
