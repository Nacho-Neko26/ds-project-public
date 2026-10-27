#!/usr/bin/env bash
# 升级桥：拉新代码 → 备份 → 覆盖 → 语法检查 → 重启 → 打日志
#   sudo bash deploy/upgrade.sh              # 只更新桥代码
#   sudo bash deploy/upgrade.sh --dsh 0.2.1-rc.2   # 顺带升 DSH（先看下面的注意）
#
# 注意：升级 DSH 有风险——桥里可能有依赖旧版行为的地方（headless 参数、session 目录名）。
#       生产机升级前先在测试机跑通；出问题用同一个 --dsh <旧版本> 回滚。
set -euo pipefail

DEST="/root/qq-agent"
DSH_VERSION=""
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --dsh) DSH_VERSION="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

step() { printf '\n\033[1;36m==== %s ====\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 跑"
[[ -d "$DEST/src" ]] || die "$DEST 不存在，先跑 install.sh"

step "1/4 备份当前代码"
BK="$DEST/.backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
for d in src persona config scripts patches; do
  [[ -d "$DEST/$d" ]] && cp -a "$DEST/$d" "$BK/" 2>/dev/null || true
done
ok "已备份到 $BK"

step "2/4 覆盖新代码"
for d in src persona config scripts patches docs; do
  [[ -d "$REPO_DIR/qq-agent/$d" ]] || continue
  mkdir -p "$DEST/$d"
  cp -a "$REPO_DIR/qq-agent/$d/." "$DEST/$d/"
done
# 配置文件里存着本机 token，别用仓库里的占位符覆盖它
if [[ -f "$BK/config/config.json" ]]; then
  cp -a "$BK/config/config.json" "$DEST/config/config.json"
  warn "保留了本机 config.json（仓库版是脱敏模板）"
fi
ok "代码已更新"

step "3/4 语法检查"
for f in "$DEST"/src/*.mjs; do
  node --check "$f" || die "语法错误：$f（回滚：cp -a $BK/. $DEST/ && systemctl restart qq-bridge）"
done
ok "全部通过"

if [[ -n "$DSH_VERSION" ]]; then
  step "3.5 升级 DSH → $DSH_VERSION"
  npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" >/dev/null
  NODE_ROOT="$(npm root -g)"
  ln -sfn "$NODE_ROOT/@deepseek-ai/dsh" "$HOME/.dsh-runtime/dsh/node_modules/@deepseek-ai/dsh"
  ok "DSH 已升到 $DSH_VERSION"
fi

step "4/4 重启并验证"
systemctl restart qq-bridge
sleep 4
if systemctl is-active --quiet qq-bridge; then
  ok "qq-bridge running"
else
  warn "起不来，下面是要回滚就用的命令："
  echo "    cp -a $BK/. $DEST/ && systemctl restart qq-bridge"
fi
journalctl -u qq-bridge -n 30 --no-pager
