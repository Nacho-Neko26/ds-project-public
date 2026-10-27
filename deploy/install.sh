#!/usr/bin/env bash
# 溟月 QQ 机器人 · 一键部署（Ubuntu 22.04 / Debian 12，root 执行）
#
#   bash deploy/install.sh --qq 100000002 --owner 100000001 --api-key sk-xxx
#
# 做六件事：装 Node22+Docker → 部署桥 → 装 DeepSeek Harness → 配 NapCat → 起服务 → 打印扫码指引
# 幂等：重复跑不会弄坏已有数据（workspace/ 下已有档案不会被覆盖）
set -euo pipefail

# ---------- 默认参数（命令行可覆盖）----------
# QQ 号和号主号故意不设默认值：留着别人的号最容易部署完发现登错人、白名单也错。
QQ_ACCOUNT=""
OWNER_UID=""
MODULES="all"          # all = 全装；否则逗号分隔的模块 id
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
  --modules <列表>       装哪些功能模块，逗号分隔；不填 = 全装（跟以前一样）
                         可选值见 --list-modules，例如 --modules core,chat,memory,admin
                         core 总是会装上。没选的模块会在 config.json 里关掉，并裁掉它用不到的文档
  --list-modules         只打印模块清单，不安装
  --official-key <sk-xxx> 可选。官方 key，只用于查账户余额；不填就用 --api-key 查（走中转时查不到）
  --qq <QQ号>            机器人 QQ 号。不填就现场问（没有默认值，避免误部署到别人的号上）
  --owner <QQ号>         号主 QQ 号（唯一能命令她的人）。不填就现场问
  --dest <路径>          桥安装目录，默认 /root/qq-agent
  --napcat-dir <路径>    NapCat 目录，默认 /root/napcat
  --dsh-version <版本>   DSH 版本，默认 0.2.1-rc.2（改了要先在测试机验证）
  --ws-port <端口>       OneBot WebSocket 端口，默认 3001
  --webui-port <端口>    NapCat WebUI 端口，默认 6099
  --help                 显示本帮助
EOF
}

list_modules() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [id, v] of Object.entries(m)) {
      if (id.startsWith("_")) continue;
      const tag = v.required ? "（必装）" : "";
      console.log(`  ${id.padEnd(12)}${tag} ${v.title}`);
      console.log(`  ${" ".repeat(12)}${v.desc}`);
    }
  ' "$REPO_DIR/deploy/modules.json"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --qq) QQ_ACCOUNT="$2"; shift 2 ;;
    --owner) OWNER_UID="$2"; shift 2 ;;
    --modules) MODULES="$2"; shift 2 ;;
    --list-modules) list_modules; exit 0 ;;
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

# QQ 号与号主号没有默认值：问到为止，总比装完发现登的是别人的号强
if [[ -z "$QQ_ACCOUNT" ]]; then
  read -r -p "机器人 QQ 号: " QQ_ACCOUNT
fi
[[ "$QQ_ACCOUNT" =~ ^[0-9]{5,12}$ ]] || die "机器人 QQ 号不像 QQ 号：$QQ_ACCOUNT"
if [[ -z "$OWNER_UID" ]]; then
  read -r -p "号主 QQ 号（唯一能命令她的人）: " OWNER_UID
fi
[[ "$OWNER_UID" =~ ^[0-9]{5,12}$ ]] || die "号主 QQ 号不像 QQ 号：$OWNER_UID"

# 模块清单：默认全装；指定了就检查 id 都存在，且把 core 补进去
[[ -f "$REPO_DIR/deploy/modules.json" ]] || die "找不到 deploy/modules.json"
if [[ "$MODULES" == "all" ]]; then
  SELECTED="$(node -e 'const m=require(process.argv[1]);console.log(Object.keys(m).filter(k=>!k.startsWith("_")).join(","))' "$REPO_DIR/deploy/modules.json")"
else
  SELECTED="$MODULES"
fi
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const sel = process.argv[2].split(",").map(s => s.trim()).filter(Boolean);
  const known = Object.keys(m).filter(k => !k.startsWith("_"));
  const bad = sel.filter(s => !known.includes(s));
  if (bad.length) { console.error("未知模块: " + bad.join(", ") + "\n可选: " + known.join(", ")); process.exit(1); }
  if (!sel.includes("core")) sel.unshift("core");
  console.log(sel.join(","));
' "$REPO_DIR/deploy/modules.json" "$SELECTED" > /tmp/.mq-modules \
  || die "模块名有错，用 --list-modules 看可选值"
SELECTED="$(cat /tmp/.mq-modules)"; rm -f /tmp/.mq-modules
ok "仓库: $REPO_DIR"
ok "模块: $SELECTED"

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

# config.json 是「这台机器自己的配置」，公开仓里不发它，只有通用模板 config.example.json。
# 已有就留着（重复安装不能冲掉现场白名单），没有就从模板生成一份。
if [[ ! -f "$DEST/config/config.json" ]]; then
  [[ -f "$DEST/config/config.example.json" ]] || die "缺 config/config.example.json，没法生成配置"
  cp -a "$DEST/config/config.example.json" "$DEST/config/config.json"
  ok "config.json 由 config.example.json 生成"
fi

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

# 按选中的模块改开关、裁资产。
# 注意：只改 overrides 里点名的键，没点名的段一个字都不动——否则会把别人手工调的参数冲掉。
# 没选的模块：它 overrides 里的每个 X.enabled 一律写 false；不写的话模块默认值是 true，等于没关。
# 全装时整段不改：全装就该跟不加 --modules 之前一模一样（比如 memeHub 默认是关的，不该被打开）。
if [[ "$MODULES" != "all" ]]; then
node -e '
  const fs = require("fs");
  const [modsPath, cfgPath, selArg, destArg] = process.argv.slice(1);
  const mods = JSON.parse(fs.readFileSync(modsPath, "utf8"));
  const sel = selArg.split(",");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

  const setPath = (obj, dotted, val) => {
    const parts = dotted.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  };

  // 先全部关掉（只关 overrides 里出现过的 .enabled 键），再按选中项逐个打开
  const allEnabledKeys = new Set();
  for (const [id, v] of Object.entries(mods)) {
    if (id.startsWith("_") || !v.overrides) continue;
    for (const k of Object.keys(v.overrides)) if (k.endsWith(".enabled")) allEnabledKeys.add(k);
  }
  for (const k of allEnabledKeys) setPath(cfg, k, false);
  for (const id of sel) {
    const v = mods[id];
    if (!v || !v.overrides) continue;
    for (const [k, val] of Object.entries(v.overrides)) setPath(cfg, k, val);
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4) + "\n");
  console.log("  ✓ 模块开关已写入 config.json");
' "$REPO_DIR/deploy/modules.json" "$DEST/config/config.json" "$SELECTED" "$DEST" \
  || die "写模块开关失败"
else
  ok "全模块安装：config.json 保持模板原样，不额外改开关"
fi

# 裁资产：只装选中模块 assets 里列的文档和可选服务脚本。
# persona/persona.md 永远留着——agent.mjs 缺了它会直接抛「人设文件不存在」。
# src/ 一个文件都不删：index.mjs 静态 import 了全部模块，删了就起不来。
# 全装（没指定 --modules）时整段跳过：既然要一模一样的完整版，就没有该裁的东西。
if [[ "$MODULES" == "all" ]]; then
  ok "全模块安装，文档/脚本一个不裁"
else
node -e '
  const fs = require("fs"), path = require("path");
  const [modsPath, selArg, destArg] = process.argv.slice(1);
  const mods = JSON.parse(fs.readFileSync(modsPath, "utf8"));
  const sel = selArg.split(",");
  const keep = new Set(["persona/persona.md"]);
  for (const id of sel) {
    const v = mods[id];
    if (v && Array.isArray(v.assets)) for (const a of v.assets) keep.add(a);
  }
  let removed = 0;
  for (const f of fs.readdirSync(path.join(destArg, "docs"))) {
    if (!f.endsWith(".md")) continue;
    const rel = "docs/" + f;
    if (!keep.has(rel)) { fs.rmSync(path.join(destArg, rel), { force: true }); removed++; }
  }
  for (const f of fs.readdirSync(path.join(destArg, "scripts"))) {
    if (!f.endsWith(".py")) continue;
    const rel = "scripts/" + f;
    if (!keep.has(rel)) { fs.rmSync(path.join(destArg, rel), { force: true }); removed++; }
  }
  console.log("  ✓ 裁掉 " + removed + " 个用不到的文档/脚本");
' "$REPO_DIR/deploy/modules.json" "$SELECTED" "$DEST" \
  || die "裁资产失败"
fi

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
