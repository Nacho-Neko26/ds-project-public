#!/usr/bin/env python3
"""远程执行命令的小工具。

用法:
    python tools/rc.py "命令1" "命令2" ...

凭证从 secrets/server.md 读，不写死、不进命令行历史。
优先用密钥 .ssh/id_ed25519，不行再退回密码。
"""

import os
import re
import sys
import pathlib

import paramiko

ROOT = pathlib.Path(__file__).resolve().parent.parent
SECRETS = ROOT / "secrets" / "server.md"
KEY = ROOT / ".ssh" / "id_ed25519"


def load_creds():
    text = SECRETS.read_text(encoding="utf-8")
    ip = re.search(r"公网 IP \| `([0-9.]+)`", text)
    user = re.search(r"登录用户 \| `([^`]+)`", text)
    pwd = re.search(r"## root 密码.*?```\n(.+?)\n```", text, re.S)
    if not ip or not user:
        raise SystemExit("secrets/server.md 里找不到 IP 或用户名")
    return ip.group(1), user.group(1), (pwd.group(1).strip() if pwd else None)


def connect(ip, user, password):
    last = None
    if KEY.exists():
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(ip, username=user, key_filename=str(KEY), timeout=15,
                      allow_agent=False, look_for_keys=False)
            return c, "key"
        except Exception as e:
            last = e
    if password:
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(ip, username=user, password=password, timeout=15,
                      allow_agent=False, look_for_keys=False)
            return c, "password"
        except Exception as e:
            last = e
    raise SystemExit(f"连接失败: {last}")


def run_script(client, path, args):
    local = pathlib.Path(path)
    remote = "/tmp/" + local.name
    sftp = client.open_sftp()
    sftp.put(str(local), remote)
    sftp.close()
    cmd = f"bash {remote} {' '.join(args)}"
    print(f"$ (uploaded {local.name}) {cmd}")
    _, out, err = client.exec_command(cmd, timeout=1800)
    print(out.read().decode("utf-8", "replace").rstrip())
    e = err.read().decode("utf-8", "replace")
    if e.strip():
        print("[stderr] " + e.rstrip())


def main():
    ip, user, pwd = load_creds()
    client, how = connect(ip, user, pwd)
    print(f"# connected {user}@{ip} via {how}", file=sys.stderr)
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "--script":
            run_script(client, sys.argv[2], sys.argv[3:])
            return
        if len(sys.argv) > 1 and sys.argv[1] == "--put":
            sftp = client.open_sftp()
            sftp.put(sys.argv[2], sys.argv[3])
            sftp.close()
            print(f"# uploaded {sys.argv[2]} -> {sys.argv[3]}")
            return
        if len(sys.argv) > 1 and sys.argv[1] == "--get":
            sftp = client.open_sftp()
            sftp.get(sys.argv[2], sys.argv[3])
            sftp.close()
            print(f"# downloaded {sys.argv[2]} -> {sys.argv[3]}")
            return
        for cmd in sys.argv[1:]:
            print(f"$ {cmd}")
            _, out, err = client.exec_command(cmd, timeout=120)
            o = out.read().decode("utf-8", "replace")
            e = err.read().decode("utf-8", "replace")
            if o:
                print(o.rstrip())
            if e.strip():
                print("[stderr] " + e.rstrip())
            print()
    finally:
        client.close()


if __name__ == "__main__":
    main()
