"""用 SFTP 把本地文件传到虚拟机（比 vmput.py 的 base64 管道稳，大文件也不会撑爆通道）。

用法：python tools/vmsftp.py <本地文件> <远端路径>
"""

import json
import os
import sys

import paramiko

CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "secrets", "vm.json")


def main():
    if len(sys.argv) < 3:
        print("用法：python tools/vmsftp.py <本地文件> <远端路径>")
        return 2
    with open(CFG, encoding="utf-8") as fh:
        cfg = json.load(fh)
    local, remote = sys.argv[1], sys.argv[2]

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(cfg["host"], 22, cfg["user"], cfg["password"], timeout=15)
    try:
        sftp = client.open_sftp()
        try:
            sftp.put(local, remote)
        finally:
            sftp.close()
    finally:
        client.close()
    print(f"ok {local} -> {remote}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
