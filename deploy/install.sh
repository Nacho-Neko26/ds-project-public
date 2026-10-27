#!/usr/bin/env bash
# 溟月 QQ 机器人 · 一键部署（Ubuntu 22.04 / Debian 12，root 执行）
#
#   bash deploy/install.sh --qq <BOT_QQ> --owner <OWNER_QQ> --api-key sk-xxx
#
# 做六件事：装 Node22+Docker → 部署桥 → 装 DeepSeek Harness → 配 NapCat → 起服务 → 打印扫码指引
# 幂等：重复跑不会弄坏已有数据（workspace/ 下已有档案不会被覆盖）
set -euo pipefail

# ---------- 默认参数（命令行可覆盖）----------
QQ_ACCOUNT="<BOT_QQ>"
OWNER_UID="<OWNER_QQ>"
API_KEY=""
OFFICIAL_KEY=""        # 可选：官方 key，只用于查余额（中转 key 查官方余额会 401）
DEST="/root/qq-agent"
NAPCAT_DIR="/root/napcat"
DSH_VERSION="0.2.1-rc.2"
WS_PORT="3001"
WEBUI_PORT="6099"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
用法: bash deploy/install.sh --api-key <KEY> [选项]

必填:
  --api-key <sk-xxx>     DeepSeek API Key（也可 --api-key - 从 stdin 读，或设环境变量 DEEPSEEK_API_KEY）

可选:
  --official-key <sk-xxx> 可选。官方 key，只用于查账户余额；不填就用 --api-key 查（走中转时查不到）
  --qq <QQ号>            机器人 QQ 号，默认 <BOT_QQ>
  --owner <QQ号>         号主 QQ 号（唯一能命令她的人），默认 <OWNER_QQ>
  --dest <路径>          桥安装目录，默认 /root/qq-agent
  --napcat-dir <路径>    NapCat 目录，默认 /root/napcat
  --dsh-version <版本>   DSH 版本，默认 0.2.1-rc.2（改了要先在测试机验证）
  --ws-port <端口>       OneBot WebSocket 端口，默认 3001
  --webui-port <端口>    NapCat WebUI 端口，默认 6099
  --help                 显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --qq) QQ_ACCOUNT="$2"; shift 2 ;;
    --owner) OWNER_UID="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --official-key) OFFICIAL_KEY="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --napcat-dir) NAPCAT_DIR="$2"; shift 2 ;;
    --dsh-version) DSH_VERSION="$2"; shift 2 ;;
    --ws-port) WS_PORT="$2"; shift 2 ;;
    --webui-port) WEBUI_PORT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

step() { printf '\n\033[1;36m==== %s ====\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
step "0/7 前置检查"
[[ $EUID -eq 0 ]] || die "请用 root 跑（sudo bash deploy/install.sh ...）"
command -v systemctl >/dev/null || die "这台机器没有 systemd，脚本不适用"
[[ -f "$REPO_DIR/qq-agent/src/index.mjs" ]] || die "找不到 qq-agent/src/index.mjs，请在仓库根目录跑本脚本"

if [[ -z "$API_KEY" ]]; then
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    API_KEY="$DEEPSEEK_API_KEY"
  else
    read -r -p "DeepSeek API Key: " API_KEY
  fi
fi
[[ "$API_KEY" == sk-* ]] || die "API Key 看起来不对（应以 sk- 开头）"
ok "仓库: $REPO_DIR"

# ---------- 1. Node 22 ----------
step "1/7 Node.js 22"
need_node=1
if command -v node >/dev/null; then
  cur="$(node -v | sed 's/^v//' | cut -d. -f1)"
  # 镜像源坏了的话，桥和 DSH 都起不来，所以这里严格 >=22
  [[ "$cur" -ge 22 ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  warn "安装 Node.js 22 ..."
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    die "只支持 apt 系；请手动装 Node 22 后重跑"
  fi
fi
ok "node $(node -v)"

# ---------- 2. Docker + NapCat ----------
step "2/7 Docker 与 NapCat"
if ! command -v docker >/dev/null; then
  warn "安装 Docker ..."
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "docker 起不来：systemctl status docker"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

# 已有容器就别重建（重建会丢挂载卷里的 QQ 登录态）
if docker ps -a --format '{{.Names}}' | grep -qx napcat; then
  warn "已存在 napcat 容器，跳过创建（要重建请先 docker rm -f napcat）"
else
  mkdir -p "$NAPCAT_DIR"/data/{qq,config,plugins,voice}
  WS_TOKEN="$(openssl rand -hex 12)"
  WEBUI_TOKEN="$(openssl rand -hex 6)"
  cat > "$NAPCAT_DIR/docker-compose.yml" <<EOF
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: "${WEBUI_TOKEN}"
      ACCOUNT: "${QQ_ACCOUNT}"
      NAPCAT_UID: "0"
      NAPCAT_GID: "0"
    ports:
      - "127.0.0.1:${WEBUI_PORT}:6099"
      - "127.0.0.1:${WS_PORT}:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
      - ./data/voice:/app/voice
EOF
  docker compose -f "$NAPCAT_DIR/docker-compose.yml" up -d >/dev/null
  ok "napcat 容器已创建（WebUI token: $WEBUI_TOKEN）"
fi

# ---------- 3. 部署桥 ----------
step "3/7 部署桥到 $DEST"
mkdir -p "$DEST"
# 代码、人设、脚本、配置永远覆盖成仓库版本；workspace/ 里是运行数据，只补不覆盖
for d in src persona scripts patches docs config; do
  [[ -d "$REPO_DIR/qq-agent/$d" ]] && mkdir -p "$DEST/$d" && cp -a "$REPO_DIR/qq-agent/$d/." "$DEST/$d/"
done
cp -a "$REPO_DIR/qq-agent/package.json" "$DEST/package.json"
[[ -f "$REPO_DIR/qq-agent/headless-config.yml" ]] && cp -a "$REPO_DIR/qq-agent/headless-config.yml" "$DEST/"
if [[ -d "$REPO_DIR/qq-agent/workspace" ]]; then
  mkdir -p "$DEST/workspace"
  cp -an "$REPO_DIR/qq-agent/workspace/." "$DEST/workspace/" 2>/dev/null || true   # -n：不覆盖现场数据
fi
mkdir -p "$DEST"/{workspace/incoming,logs,data}

# token 与 QQ 号写进配置（配置里的 token 是占位符，真 token 只在宿主机上）
WS_TOKEN="${WS_TOKEN:-$(grep -oP '(?<=token: ")[^"]+' "$NAPCAT_DIR/docker-compose.yml" 2>/dev/null || true)}"
[[ -n "$WS_TOKEN" ]] || WS_TOKEN="$(openssl rand -hex 12)"
node -e '
const fs = require("fs");
const p = process.argv[1], ws = process.argv[2], qq = Number(process.argv[3]), owner = Number(process.argv[4]);
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.napcat = cfg.napcat || {};
cfg.napcat.wsUrl = "ws://127.0.0.1:" + process.argv[5];
cfg.napcat.token = ws;
if (!cfg.persona.ownerUids || !cfg.persona.ownerUids.length) cfg.persona.ownerUids = [owner];
if (!cfg.trusted || !cfg.trusted.length) cfg.trusted = [qq, owner];
fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + "\n");
' "$DEST/config/config.json" "$WS_TOKEN" "$QQ_ACCOUNT" "$OWNER_UID" "$WS_PORT"
ok "config.json 已写入（ws:$WS_PORT）"

# 语音/听语音靠这台机器上的两个本地服务（TTS 3911 / ASR 3912），新机器默认没有。
# 没有就关掉对应开关：聊天天照常，只是不发语音条、听不懂语音消息——总比每轮报错强。
TTS_UP=0; ASR_UP=0
if ss -ltn 2>/dev/null | grep -q ":3911 "; then TTS_UP=1; fi
if ss -ltn 2>/dev/null | grep -q ":3912 "; then ASR_UP=1; fi
node -e '
const fs = require("fs");
const p = process.argv[1], tts = process.argv[2] === "1", asr = process.argv[3] === "1";
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
if (!tts) { cfg.voice.enabled = false; if (cfg.music) cfg.music.mode = "text"; }
if (!asr) { cfg.asr.enabled = false; }
fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + "\n");
' "$DEST/config/config.json" "$TTS_UP" "$ASR_UP"
[[ "$TTS_UP" == 1 ]] || warn "没检测到 TTS 服务(3911)：已关闭语音回复，聊天正常。要补见 docs/qq-voice.md"
[[ "$ASR_UP" == 1 ]] || warn "没检测到 ASR 服务(3912)：已关闭语音转写，收到语音消息只回一句听不懂"

# OneBot 配置：NapCat 只在 data/config 里找 onebot11_<QQ>.json
mkdir -p "$NAPCAT_DIR/data/config"
node -e '
const fs = require("fs");
const [qq, port, token] = process.argv.slice(1);
const cfg = {
  network: {
    httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [],
    websocketServers: [{
      name: "qq-agent", enable: true, host: "0.0.0.0", port: Number(port),
      messagePostFormat: "array", reportSelfMessage: false, token,
      enableForcePushEvent: true, debug: false, heartInterval: 30000,
    }],
    plugins: [],
  },
  musicSignUrl: "", enableLocalFile2Url: false, parseMultMsg: false,
};
fs.writeFileSync(process.argv[4], JSON.stringify(cfg, null, 2) + "\n");
' "$QQ_ACCOUNT" "$WS_PORT" "$WS_TOKEN" "$NAPCAT_DIR/data/config/onebot11_${QQ_ACCOUNT}.json"
ok "OneBot 配置已写入 onebot11_${QQ_ACCOUNT}.json"

# ---------- 4. DeepSeek Harness ----------
step "4/7 DeepSeek Harness $DSH_VERSION"
if npm ls -g --depth=0 2>/dev/null | grep -q "@deepseek-ai/dsh@${DSH_VERSION}"; then
  ok "已安装"
else
  warn "npm 全局安装中（几分钟）..."
  npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" >/dev/null
fi
NODE_ROOT="$(npm root -g)"

# 桥不依赖 dsh 的 shim 能不能执行，只读它拿 NODE_PATH 和 bin.js 路径；
# 桥认死 ~/.dsh-runtime/dsh/node_modules/.bin/dsh.cmd，所以这里按那个形状造一个兼容布局。
RUNTIME_DIR="$HOME/.dsh-runtime/dsh/node_modules"
mkdir -p "$RUNTIME_DIR/.bin" "$RUNTIME_DIR/@deepseek-ai"
ln -sfn "$NODE_ROOT/@deepseek-ai/dsh" "$RUNTIME_DIR/@deepseek-ai/dsh"
cat > "$RUNTIME_DIR/.bin/dsh.cmd" <<EOF
@ECHO off
SET NODE_PATH=${NODE_ROOT}
node "%~dp0\\..\\@deepseek-ai\\dsh\\lib\\bin.js" %*
EOF
ok "兼容布局: $RUNTIME_DIR"

# 凭证：headless profile 没挂 credentials 插件，只能走环境变量，桥从这个文件读
CRED="$HOME/.dsh/.credentials.yaml"
mkdir -p "$HOME/.dsh"
# 三个 key 各管一件事：
#   DEEPSEEK_API_KEY      桥跑 agent 用（官方 key 或中转 key 都行）
#   RELAY_API_KEY         走中转站时用；填成同一个值，什么时候切中转都不用再改
#   DEEPSEEK_OFFICIAL_KEY 只给余额播报用：中转 key 去 api.deepseek.com 查余额会 401
if [[ -f "$CRED" ]] && grep -q 'DEEPSEEK_API_KEY' "$CRED"; then
  warn "$CRED 已有 DEEPSEEK_API_KEY，跳过（要换 key 请手动改）"
else
  {
    echo "version: 1"
    echo "refs:"
    echo "  DEEPSEEK_API_KEY: ${API_KEY}"
    echo "  RELAY_API_KEY: ${API_KEY}"
    if [[ -n "$OFFICIAL_KEY" ]]; then echo "  DEEPSEEK_OFFICIAL_KEY: ${OFFICIAL_KEY}"; fi
  } > "$CRED"
  chmod 600 "$CRED"
  ok "凭证写入 $CRED (600)"
  [[ -n "$OFFICIAL_KEY" ]] || warn "没给 --official-key：余额播报会用主 key 查，走中转时会 401（不影响聊天）"
fi

# ---------- 5. systemd ----------
step "5/7 systemd 服务 qq-bridge"
cat > /etc/systemd/system/qq-bridge.service <<EOF
[Unit]
Description=Blue Whale QQ Bridge (NapCat + DeepSeek)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=${DEST}
ExecStart=$(command -v node) ${DEST}/src/index.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now qq-bridge >/dev/null
sleep 3
systemctl is-active --quiet qq-bridge && ok "qq-bridge 已启动" || warn "qq-bridge 起不来，看 journalctl -u qq-bridge -n 50"

# ---------- 6. 自检 ----------
step "6/7 自检"
node --check "$DEST/src/index.mjs" && ok "语法 OK"
( cd "$DEST" && timeout 20 node src/doctor.mjs 2>&1 | tail -15 ) || warn "doctor 有告警（多数要在扫码后才消失）"

# ---------- 7. 下一步 ----------
step "7/7 接下来：扫码登录 QQ"
cat <<EOF
  1) 取二维码（容器里的图不在挂载卷里，必须 docker cp）：
       docker cp napcat:/app/napcat/cache/qrcode.png ${NAPCAT_DIR}/data/qrcode.png
     用要当机器人的 QQ 扫它。二维码约 2 分钟失效，慢了重取。

  2) 扫码成功后等 30 秒，确认桥连上了：
       journalctl -u qq-bridge -n 30 --no-pager | grep -E '已连接|已登录'

  3) 在 QQ 里对 $QQ_ACCOUNT 发一句话，应当收到回复。

  常用命令：
       systemctl restart qq-bridge          # 改完配置重启桥
       journalctl -u qq-bridge -f           # 实时日志（含每轮耗时）
       docker logs --tail 100 napcat        # QQ 侧日志
       ssh -L ${WEBUI_PORT}:127.0.0.1:${WEBUI_PORT} -L 3899:127.0.0.1:3899 root@<本机IP>   # 看面板

  表情素材包（可选）：见 qq-agent/docs/stickers-INSTALL.md
EOF
