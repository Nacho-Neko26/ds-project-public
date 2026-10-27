# -*- coding: utf-8 -*-
"""把服务器上改过的 qq-agent 代码自动同步回本机母本。

判断规则（重要）：
  1. 比对服务器与本机 md5，相同就跳过；
  2. 不同时，如果本机文件在「上次同步之后」被本地改过 → 认定我正在本机编辑，
     跳过不覆盖（要强行以服务器为准加 --force）；
  3. 覆盖前把本机旧版备份成 <文件名>.bak-sync-<时间戳>，每文件最多留 5 份；
  4. 每次都往 sync/code-sync.log 追一行结论，好回溯。

用法（在 default-workspace 下）：
  python tools/sync-from-server.py                  # 默认 qq-agent 的 src/*.mjs + config/config.json
  python tools/sync-from-server.py --dry            # 只看差异，不动文件
  python tools/sync-from-server.py --files src/index.mjs src/agent.mjs
  python tools/sync-from-server.py --force          # 本机改过也以服务器为准
"""
import argparse
import base64
import hashlib
import json
import sys
import time
from pathlib import Path

WS = Path(__file__).resolve().parent.parent

# pythonw.exe 下 sys.stdout 是 None，print 会直接崩；计划任务就是用它跑的，所以先兜底
_LOG_DIR = WS / 'sync'
_LOG_DIR.mkdir(parents=True, exist_ok=True)
if sys.stdout is None:
    sys.stdout = open(_LOG_DIR / 'code-sync-cron.log', 'a', encoding='utf-8')
    sys.stderr = sys.stdout

sys.path.insert(0, str(WS / 'tools'))
import rc  # noqa: E402

REMOTE_ROOT = '/root/qq-agent'
LOCAL_ROOT = WS / 'qq-agent'
DEFAULT_GLOBS = ['src/*.mjs', 'config/config.json']
STATE_FILE = WS / 'sync' / 'code-state.json'
LOG_FILE = WS / 'sync' / 'code-sync.log'
KEEP_BACKUPS = 5


def md5_bytes(b):
    return hashlib.md5(b).hexdigest()


def log(line):
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(f'[{stamp}] {line}\n')


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding='utf-8')


def prune_backups(path):
    baks = sorted(path.parent.glob(path.name + '.bak-sync-*'))
    for old in baks[:-KEEP_BACKUPS]:
        try:
            old.unlink()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', nargs='*', help='相对 /root/qq-agent 的路径')
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    creds = rc.load_creds()
    cli, mode = rc.connect(*creds)
    try:
        if args.files:
            remote_files = []
            for pat in args.files:
                cmd = f'cd {REMOTE_ROOT} && ls -1 {pat} 2>/dev/null'
                out = cli.exec_command(cmd)[1].read().decode().split()
                remote_files.extend(out)
        else:
            remote_files = []
            for pat in DEFAULT_GLOBS:
                out = cli.exec_command(f'cd {REMOTE_ROOT} && ls -1 {pat} 2>/dev/null')[1].read().decode().split()
                remote_files.extend(out)
        remote_files = sorted(set(remote_files))
        if not remote_files:
            print('服务器上没有匹配的文件')
            log('skip 没有匹配文件')
            return 0

        cmd = f'cd {REMOTE_ROOT} && md5sum ' + ' '.join(remote_files)
        lines = cli.exec_command(cmd)[1].read().decode().strip().splitlines()
        remote_md5 = {}
        for ln in lines:
            parts = ln.split()
            if len(parts) >= 2:
                remote_md5[parts[-1]] = parts[0]

        state = load_state()
        changed = 0
        skipped = 0
        added = 0
        detail = []

        for rel in remote_files:
            rmd5 = remote_md5.get(rel)
            if not rmd5:
                continue
            local = LOCAL_ROOT / rel
            if not local.exists():
                added += 1
            else:
                lmd5 = md5_bytes(local.read_bytes())
                if lmd5 == rmd5:
                    state[rel] = {'md5': rmd5, 'lastSync': state.get(rel, {}).get('lastSync', 0)}
                    continue
                last_sync = state.get(rel, {}).get('lastSync', 0)
                if not args.force and local.stat().st_mtime > last_sync:
                    skipped += 1
                    detail.append(f'跳过 {rel}（本机在上次同步后改过，可能是本地在编辑）')
                    continue

            if args.dry:
                detail.append(f'会拉 {rel}  {rmd5}')
                changed += 1
                continue

            b64 = cli.exec_command(f'base64 -w0 {REMOTE_ROOT}/{rel}')[1].read().decode().strip()
            data = base64.b64decode(b64)
            if md5_bytes(data) != rmd5:
                detail.append(f'校验失败 {rel}，写入中止')
                log(f'FAIL {rel} md5 不一致')
                continue
            local.parent.mkdir(parents=True, exist_ok=True)
            if local.exists():
                stamp = time.strftime('%Y%m%d-%H%M%S')
                bak = local.with_name(local.name + f'.bak-sync-{stamp}')
                bak.write_bytes(local.read_bytes())
                prune_backups(local)
            local.write_bytes(data)
            state[rel] = {'md5': rmd5, 'lastSync': time.time()}
            changed += 1
            detail.append(f'拉回 {rel}  {len(data)} 字节')

        if not args.dry:
            save_state(state)

        summary = f'拉回 {changed} / 跳过 {skipped} / 新增 {added}'
        print(summary)
        for d in detail:
            print('  ' + d)
        log(summary + (' | ' + '; '.join(detail) if detail else ''))
        return 0
    finally:
        try:
            cli.close()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
