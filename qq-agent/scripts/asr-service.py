#!/usr/bin/env python3
"""
SenseVoice 本地语音转写服务。

桥把 QQ 语音解成 16k 单声道 wav，POST 到 127.0.0.1:3912/asr，这里返回文字。
常驻进程，模型只加载一次（int8，约 230MB，2 核 CPU 上 5 秒语音大概 0.5 秒出结果）。

为什么不用云端 ASR：百炼的语音识别要么走公网 url、要么走 SDK 上传，还得另算钱；
这条链路只在本机跑，录到的语音不出服务器。

用法：
  POST /asr        body = {"path":"/abs/x.wav"} 或 {"b64":"<base64 wav>"}
  返回             {"text":"...","ms":123,"duration":3.2}
  GET  /health     {"ok":true,"model":"...","loadMs":...}
"""
import base64
import json
import os
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

MODEL_DIR = os.environ.get(
    "ASR_MODEL_DIR",
    "/opt/asr/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
)
HOST = os.environ.get("ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ASR_PORT", "3912"))
MAX_BYTES = 40 * 1024 * 1024

_lock = threading.Lock()
_t0 = time.time()
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=os.path.join(MODEL_DIR, "model.int8.onnx"),
    tokens=os.path.join(MODEL_DIR, "tokens.txt"),
    num_threads=2,
    use_itn=True,
    language="auto",
    debug=False,
)
LOAD_MS = int((time.time() - _t0) * 1000)


def read_wave_any(path):
    """读 16k 单声道 16bit wav，转成 float32 波形；不是的话返回 None，
    让上层用 ffmpeg 先转（桥那边已经转过再发过来）。"""
    try:
        with wave.open(path, "rb") as w:
            if w.getnchannels() != 1 or w.getframerate() != 16000 or w.getsampwidth() != 2:
                return None
            frames = w.readframes(w.getnframes())
    except Exception:
        return None
    if not frames:
        return None
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(path):
    samples = read_wave_any(path)
    if samples is None:
        raise ValueError("wav 必须是 16k 单声道")
    started = time.time()
    with _lock:
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        text = stream.result.text or ""
    return {
        "text": text.strip(),
        "ms": int((time.time() - started) * 1000),
        "duration": round(len(samples) / 16000.0, 2),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 少写点日志
        return

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json({"ok": True, "model": MODEL_DIR, "loadMs": LOAD_MS})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/asr"):
            self._json({"error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BYTES:
                self._json({"error": "body 为空或太大"}, 400)
                return
            raw = self.rfile.read(length)
            tmp = None
            try:
                if self.headers.get("content-type", "").startswith("application/json"):
                    payload = json.loads(raw.decode("utf-8"))
                    if payload.get("path"):
                        path = payload["path"]
                    elif payload.get("b64"):
                        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                        tmp.write(base64.b64decode(payload["b64"]))
                        tmp.close()
                        path = tmp.name
                    else:
                        self._json({"error": "要 path 或 b64"}, 400)
                        return
                else:
                    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                    tmp.write(raw)
                    tmp.close()
                    path = tmp.name
                self._json(transcribe(path))
            finally:
                if tmp is not None:
                    try:
                        os.unlink(tmp.name)
                    except OSError:
                        pass
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)


if __name__ == "__main__":
    print(f"[asr] 模型加载 {LOAD_MS}ms，监听 {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
