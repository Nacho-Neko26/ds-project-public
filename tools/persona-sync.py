# -*- coding: utf-8 -*-
"""把 QQ 机器人的人格文件同步到本机的 DSH 全局人格里。

人格的源头是服务器上那份（/root/qq-agent/persona/persona.md），
本机 ~/.dsh/AGENT.md 里用一对标记圈出「同步区」，
这个脚本只替换标记之间的内容，标记外面你自己写的部分一个字都不动。

每天 04:00 由计划任务 DSH-Persona-Sync 跑一次。
手动跑：python tools/persona-sync.py
只看看不写：python tools/persona-sync.py --dry-run
"""
import argparse
import datetime as dt
import os
import re
import subprocess
import sys

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_MD = os.path.join(os.path.expanduser("~"), ".dsh", "AGENT.md")
REMOTE = "/root/qq-agent/persona/persona.md"
BEGIN = "<!-- persona:begin 以下内容由 tools/persona-sync.py 每天 04:00 从 QQ 机器人同步，别手改 -->"
END = "<!-- persona:end -->"


def fetch_persona() -> str:
    """直接用 SFTP 取文件。

    一开始是拿子进程调 tools/rc.py 的，但在计划任务（无控制台）里跑时
    subprocess 的 stdout 会变成 None，干脆改成复用 rc 的凭证/连接逻辑自己连。
    """
    sys.path.insert(0, os.path.join(WORKSPACE, "tools"))
    import rc  # noqa: E402  复用同一套 secrets 解析与密钥连接

    ip, user, pwd = rc.load_creds()
    client, _how = rc.connect(ip, user, pwd)
    try:
        sftp = client.open_sftp()
        with sftp.open(REMOTE, "rb") as f:
            raw = f.read()
        sftp.close()
    finally:
        client.close()

    body = raw.decode("utf-8")
    if len(body) < 200:
        raise RuntimeError(f"拉回来的人格只有 {len(body)} 字节，像是空文件，放弃覆盖")
    return body


def render_block(body: str, stamp: str) -> str:
    # 把一级标题降成二级，避免和 AGENT.md 自己的「# 你是谁」打架
    demoted = re.sub(r"^# ", "## ", body, flags=re.M)
    return f"{BEGIN}\n<!-- synced: {stamp} -->\n\n{demoted}\n\n{END}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    a = ap.parse_args()

    body = fetch_persona()
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    block = render_block(body, now)

    if not os.path.exists(AGENT_MD):
        raise SystemExit(f"找不到 {AGENT_MD}")

    with open(AGENT_MD, "r", encoding="utf-8") as f:
        old = f.read()

    if BEGIN in old and END in old:
        pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)
        new = pattern.sub(lambda _: block, old, count=1)
        action = "替换已有同步区"
    else:
        new = old.rstrip("\n") + "\n\n" + block + "\n"
        action = "首次写入同步区"

    changed = new != old
    print(f"[{now}] persona {len(body)} 字节 · {action} · {'内容有变化' if changed else '内容没变'}")

    if a.dry_run:
        print("--- dry-run，不写文件 ---")
        print(block[:400])
        return
    if not changed:
        return

    backup = AGENT_MD + ".bak-persona-sync"
    with open(backup, "w", encoding="utf-8", newline="\n") as f:
        f.write(old)
    with open(AGENT_MD, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    print(f"已写入 {AGENT_MD}（旧版备份 -> {os.path.basename(backup)}）")


if __name__ == "__main__":
    main()
