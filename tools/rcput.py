"""用 SFTP 把本地文件传到云服务器（凭证复用 tools/rc.py 的 secrets/server.md）。

用法：python tools/rcput.py <本地文件> <远端路径>
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import rc  # noqa: E402


def main():
    if len(sys.argv) < 3:
        print("用法：python tools/rcput.py <本地文件> <远端路径>")
        return 2
    ip, user, password = rc.load_creds()
    client, _how = rc.connect(ip, user, password)
    try:
        sftp = client.open_sftp()
        try:
            sftp.put(sys.argv[1], sys.argv[2])
        finally:
            sftp.close()
    finally:
        client.close()
    print(f"ok {sys.argv[1]} -> {sys.argv[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
