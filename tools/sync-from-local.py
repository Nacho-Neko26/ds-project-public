#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本机母本 qq-agent 的最新代码同步进复刻仓库副本（D:\\DSH\\ds-project-repo）。

规则：
  - 只同步「代码 / 人设 / 文档 / 配置」，不同步运行态（logs、data、napcat、tmp、qrcode、incoming）
  - config/config.json 里的 OneBot token 一律换成 <ONEBOT_WS_TOKEN> 再入库
  - 跳过 .bak*、临时探针 _*.mjs、chk.mjs
  - workspace/ 下的运行数据（记忆库、知识库、日记、表情）不在此脚本范围，由服务器拉取后单独提交

用法：python D:\\DSH\\tmp\\sync-to-repo.py [--dry-run]
"""
import filecmp
import json
import re
import shutil
import sys
from pathlib import Path

LIVE = Path(r"C:\Users\14381\Documents\deepseek-harness\default-workspace\qq-agent")
REPO = Path(r"D:\DSH\ds-project-repo\qq-agent")
DRY = "--dry-run" in sys.argv

# 需要整目录同步的子目录
DIRS = ["src", "scripts", "persona", "patches"]
# 需要单文件同步
FILES = [
    "package.json",
    "headless-config.yml",
    "supervisor.mjs",
    "start-all.cmd",
    "start-all.ps1",
    "start-bridge.cmd",
    "start-napcat.cmd",
    "stop-all.ps1",
]

# 脱敏替换：真 token / 服务器 IP 一律换成占位符再入库
SECRETS = [
    (re.compile(r"<ONEBOT_WS_TOKEN>"), "<ONEBOT_WS_TOKEN>"),
    (re.compile(r"<NAPCAT_WEBUI_TOKEN>"), "<NAPCAT_WEBUI_TOKEN>"),
    (re.compile(r"47\.111\.108\.4"), "<SERVER_IP>"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "<DEEPSEEK_API_KEY>"),
]

TEXT_EXT = {".mjs", ".py", ".md", ".json", ".yml", ".yaml", ".sh", ".cmd", ".ps1", ".jsonl"}

# 这些文件保留仓库里的版本，不用母本覆盖：
#   scripts/deploy-notify.mjs —— 母本里写死了真 token，仓库版改成从 src/config.mjs 读，更适合复刻
KEEP_REPO = {"scripts/deploy-notify.mjs"}

SKIP_PATTERNS = [
    re.compile(r"\.bak"),
    re.compile(r"(^|/)_[^/]*\.mjs$"),
    re.compile(r"(^|/)chk\.mjs$"),
    re.compile(r"(^|/)tmp"),
]

changed, added, same = [], [], 0


def skipped(rel: str) -> bool:
    return any(p.search(rel) for p in SKIP_PATTERNS)


def scrub(p: Path):
    """把入库文件里的真 token / IP 换成占位符。"""
    if p.suffix.lower() not in TEXT_EXT or not p.exists():
        return False
    try:
        raw = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False
    new = raw
    for pat, rep in SECRETS:
        new = pat.sub(rep, new)
    if new != raw:
        if not DRY:
            p.write_text(new, encoding="utf-8", newline="")
        return True
    return False


def put(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not DRY:
        shutil.copy2(src, dst)
        scrub(dst)


def sync_file(src: Path, rel: str):
    global same
    if skipped(rel):
        return
    if rel in KEEP_REPO and (REPO / rel).exists():
        same += 1
        return
    dst = REPO / rel
    if not dst.exists():
        added.append(rel)
        put(src, dst)
    elif not filecmp.cmp(src, dst, shallow=False):
        changed.append(rel)
        put(src, dst)
    else:
        same += 1


for d in DIRS:
    root = LIVE / d
    if not root.exists():
        continue
    for f in sorted(root.rglob("*")):
        if f.is_file():
            sync_file(f, f.relative_to(LIVE).as_posix())

for name in FILES:
    f = LIVE / name
    if f.exists():
        sync_file(f, name)

# docs：只增不删（仓库里那几份手册 live 没有，保留）
docs = LIVE / "docs"
if docs.exists():
    for f in sorted(docs.rglob("*")):
        if f.is_file():
            sync_file(f, f.relative_to(LIVE).as_posix())

# config/config.json → 脱敏
cfg_live = LIVE / "config" / "config.json"
cfg_repo = REPO / "config" / "config.json"
if cfg_live.exists():
    data = json.loads(cfg_live.read_text(encoding="utf-8"))
    tok = data.get("napcat", {}).get("token")
    if tok:
        data["napcat"]["token"] = "<ONEBOT_WS_TOKEN>"
    text = json.dumps(data, ensure_ascii=False, indent=4) + "\n"
    old = cfg_repo.read_text(encoding="utf-8") if cfg_repo.exists() else ""
    if text != old:
        changed.append("config/config.json (脱敏)")
        if not DRY:
            cfg_repo.write_text(text, encoding="utf-8")
    else:
        same += 1

print(f"== {'DRY-RUN' if DRY else '已同步'} ==")
print(f"新增 {len(added)} 个：")
for x in added:
    print("  +", x)
print(f"改动 {len(changed)} 个：")
for x in changed:
    print("  ~", x)
print(f"未变 {same} 个")
