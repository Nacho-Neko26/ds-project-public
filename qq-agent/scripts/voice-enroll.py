#!/usr/bin/env python3
"""
百炼「声音复刻」小工具：用自己的录音建一个专属音色，拿到 voice_id 填进配置。

用法（在服务器上跑，需要 DASHSCOPE_API_KEY）：
    python3 scripts/voice-enroll.py create /root/my-voice.mp3 --prefix mingyue
    python3 scripts/voice-enroll.py list
    python3 scripts/voice-enroll.py delete <voice_id>

音频要求（官方）：
    WAV(16bit) / MP3 / M4A，10~20 秒最合适（最长 60 秒），≥16kHz，单人说话、无 BGM、不是唱歌。
    本地文件直接转 Base64 Data URI 提交，不用先传公网。

关键点（2026-10-23 查文档确认）：
    - 音色在创建时绑定 target_model，不能跨模型用。这里默认绑 qwen-audio-3.1-tts-flash，
      和 tts-service.py 现在用的模型一致。
    - 创建音色免费，合成按模型计费。
    - 音色默认长期有效，账号上限 1000 个。
"""
import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import requests

DEFAULT_BASE = os.environ.get("BAILIAN_BASE_URL", "https://dashscope.aliyuncs.com/api/v1")
TARGET_MODEL = os.environ.get("BAILIAN_TTS_MODEL", "qwen-audio-3.1-tts-flash")
MAX_BYTES = 10 * 1024 * 1024


def headers():
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        # 服务端把密钥放在 /root/.bailian.env
        for line in Path("/root/.bailian.env").read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("DASHSCOPE_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not key:
        sys.exit("没有 DASHSCOPE_API_KEY（环境变量和 /root/.bailian.env 里都没有）")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def call(base, payload, timeout=60):
    r = requests.post(f"{base}/services/audio/tts/customization",
                      headers=headers(), json=payload, timeout=timeout)
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text[:500]}
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    return data


def to_data_uri(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"文件不存在：{path}")
    size = p.stat().st_size
    if size > MAX_BYTES:
        sys.exit(f"文件太大（{size/1024/1024:.1f}MB > 10MB），截短一点")
    raw = p.read_bytes()
    ext = p.suffix.lower().lstrip(".")
    mime = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4"}.get(ext, "audio/mpeg")
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def cmd_create(args):
    audio = args.url if args.url else to_data_uri(args.audio)
    payload = {
        "model": "voice-enrollment",
        "input": {
            "action": "create_voice",
            "target_model": args.model,
            "prefix": args.prefix,
            "audio": audio,
        },
    }
    print(f"提交复刻请求（target_model={args.model}）…")
    data = call(args.base, payload)
    voice_id = data.get("output", {}).get("voice_id")
    if not voice_id:
        sys.exit(f"没拿到 voice_id：{json.dumps(data, ensure_ascii=False)[:600]}")
    print(f"voice_id = {voice_id}")

    for i in range(60):
        q = call(args.base, {"model": "voice-enrollment",
                             "input": {"action": "query_voice", "voice_id": voice_id}})
        st = q.get("output", {}).get("status")
        print(f"  状态：{st}")
        if st == "OK":
            break
        if st != "DEPLOYING":
            sys.exit(f"音色不可用：{json.dumps(q, ensure_ascii=False)[:600]}")
        time.sleep(2)
    else:
        sys.exit("等太久还没好，稍后用 list 再查")

    print()
    print("搞定。把它填进 config/config.json：")
    print(f'  "voice": {{ "bailian": {{ "voice": "{voice_id}" }} }}')
    print("或者直接改 tts-service 的环境变量 BAILIAN_TTS_VOICE，然后重启服务。")


def cmd_list(args):
    data = call(args.base, {"model": "voice-enrollment", "input": {"action": "list_voice"}})
    voices = data.get("output", {}).get("voices") or data.get("output", {}).get("voice_list") or []
    if not voices:
        print(json.dumps(data, ensure_ascii=False)[:800])
        return
    for v in voices:
        print(f'{v.get("voice_id")}  model={v.get("target_model")}  status={v.get("status")}  '
              f'created={v.get("gmt_create")}')


def cmd_delete(args):
    data = call(args.base, {"model": "voice-enrollment",
                            "input": {"action": "delete_voice", "voice_id": args.voice_id}})
    print(json.dumps(data, ensure_ascii=False)[:600])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create")
    c.add_argument("audio", nargs="?", help="本地音频文件")
    c.add_argument("--url", help="也可以直接给公网音频 URL")
    c.add_argument("--prefix", default="mingyue", help="音色名前缀（≤10 字符）")
    c.add_argument("--model", default=TARGET_MODEL, help="绑定到哪个 TTS 模型")
    c.set_defaults(func=cmd_create)

    l = sub.add_parser("list")
    l.set_defaults(func=cmd_list)

    d = sub.add_parser("delete")
    d.add_argument("voice_id")
    d.set_defaults(func=cmd_delete)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
