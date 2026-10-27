# 复刻指南：把一个 QQ 号接上 AI，并挂到云服务器

> 读者：另一个 AI（或人）。目标：照这份文档从裸机走到「QQ 里发一句话，AI 用人设回过来」，一次成功。
> 规则：每一节末尾有 **验收** 命令。**卡住就停在那一步排查，不要往下走** —— 后面的步骤都依赖前面的。
> 占位符：`<QQ号>`、`<服务器公网IP>`、`<token>`、号主QQ、群号 这些**都要换成你自己的**，本文不含任何真实账号数据。
> 更新时间：2026-10-25，按当时线上实际状态核对过（版本、端口、路径、配置字段均为实测值）。

---

## 0. 一句话架构

```
手机 QQ ──▶ QQ 服务器
                │
                ▼
      NapCat 容器（注入 NTQQ，做协议端）
                │  OneBot 11 WebSocket，127.0.0.1:3001，带 token
                ▼
      桥 /root/qq-agent/src/index.mjs（Node 22，零依赖）
                │  每收到一轮消息：拼 prompt → spawn 一次子进程
                ▼
      dsh --profile headless + 人设补丁（personaPrefix）
                │  一次调用 = 一次 agent 运行，结果从 stdout 拿
                ▼
      桥把文字/表情/语音按 QQ 消息段发回去
```

三个关键设计，别改：

1. **NapCat 只当哑终端**，不装任何插件；所有业务逻辑都在桥里。协议端升级/换实现时桥不用动。
2. **每条消息起一个新 `dsh headless` 进程**（one-shot）。换来进程隔离、崩了不污染下一条；代价是每轮多 1~2 秒冷启动（云上实测整轮 **2.8~3.6 秒**）。
3. **所有服务端口只绑 127.0.0.1**，公网只开 22。看面板一律走 SSH 隧道。这不是洁癖：OneBot 裸奔在公网等于把 QQ 号送人。

---

## 1. 硬事实表（复刻时照抄）

| 项 | 值 |
|---|---|
| QQ 号 | `<QQ号>`（**必须用小号**；昵称随时会变，验收只认 `user_id`，别按昵称判断） |
| 云 | 阿里云 ECS（按量付费），地域选离自己近的 |
| 公网 IP | `<服务器公网IP>` |
| 系统 | Ubuntu 22.04.5 LTS，2 vCPU / 3.5G 内存 + 2G swap / 40G 盘，时区 `Asia/Shanghai` |
| 登录 | `root`，**只认密钥**（`PasswordAuthentication no`） |
| Node | v22.20.0（`/usr/local/bin/node`，tar 包放 `/usr/local/lib/nodejs/node-v22.20.0-linux-x64`） |
| pnpm | 10.13.1（`/usr/local/bin/pnpm`） |
| DSH | `@deepseek-ai/dsh@0.2.1-rc.2`，全局装在 `/usr/local/lib/nodejs/node-v22.20.0-linux-x64/lib/node_modules` |
| NapCat | docker 镜像 `mlikiowa/napcat-docker:latest`，容器名 `napcat` |
| 桥 | systemd `qq-bridge` → `/root/qq-agent/src/index.mjs` |
| NapCat 数据 | `/root/napcat/data/{qq,config,plugins,voice}` |
| OneBot 配置 | `/root/napcat/data/config/onebot11_<QQ号>.json`（**文件名必须等于登录账号**） |
| DSH 家目录 | `/root/.dsh`（凭证 `.credentials.yaml` 600，profile 在 `profiles/headless`） |
| 桥工作目录 | `/root/qq-agent/workspace`（DSH 的 cwd，也是唯一可写区） |

### 用到的网址（全部实测可达）

| 用途 | 网址 |
|---|---|
| DeepSeek API Key 申请 | https://platform.deepseek.com/api_keys |
| DSH npm 包 | https://www.npmjs.com/package/@deepseek-ai/dsh |
| npm 国内镜像 | https://registry.npmmirror.com |
| Node 官方 tar 包镜像 | https://npmmirror.com/mirrors/node/ |
| Docker CE 阿里云镜像源 | https://mirrors.aliyun.com/docker-ce/linux/ubuntu |
| NapCat 镜像（Docker Hub） | https://hub.docker.com/r/mlikiowa/napcat-docker |
| NapCat 仓库 / 文档 | https://github.com/NapNeko/NapCatQQ · https://napneko.github.io |
| OneBot 11 协议（看清楚字段再解析） | https://github.com/botuniverse/onebot-11 |
| 阿里云 ECS 控制台（安全组、密钥、到期提醒） | https://ecs.console.aliyun.com |
| 扫码用的解码链接（登录日志里抓） | `https://txz.qq.com/p?k=...` |



| 端口 | 用途 | 凭证 |
|---|---|---|
| 3001 | OneBot 11 WebSocket | token `<自己生成一串，桥与 NapCat 两边必须一致>` |
| 6099 | NapCat WebUI | token `<自己生成一串>` |
| 3899 | 桥控制台（含记忆面板） | 无，靠回环 + 隧道 |
| 3911 | 百炼 TTS 服务（可选） | 无 |
| 3912 | SenseVoice ASR（可选） | 无 |

看面板：

```bash
ssh -L 6099:127.0.0.1:6099 -L 3899:127.0.0.1:3899 root@<服务器公网IP>
# 然后本机开 http://127.0.0.1:3899 和 http://127.0.0.1:6099
```

---

## 2. 最小路径（只要「能聊」，约 30 分钟）

如果你只想验证链路，按这 6 步，**跳过第 7、8 节的所有增强**：

1. 装机：Docker + Node 22（§4.1、§4.2）
2. 装 DSH + 兼容布局 + 凭证 + headless profile（§4.3、§4.4）
3. 起 NapCat 容器，扫一次码登录（§5）
4. 上传桥代码 + 最小 config（§6.1、§6.2）
5. 起桥，跑验收（§6.4、§7）
6. 注册 systemd，开机自启（§6.5）

最小可用只需要这些文件：`src/`、`config/config.json`、`persona/persona.md`、`package.json`。
桥是**零 npm 依赖**的（用 Node 22 内置 WebSocket），不需要 `npm install`。

---

## 3. 前置条件（缺一样都做不成）

- 一个**小号 QQ**（别拿主号试：NapCat 是注入 NTQQ 的第三方实现，有风控封号风险）。
- 一台公网 Linux（1 核 2G 起；3.5G 内存能同时跑 NapCat + 桥 + 可选 TTS/ASR）。
- 一个 DeepSeek API Key（余额要够，每轮走一次模型）。
- 一台能扫码的手机（登录、掉线重登都要）。

---

## 4. 服务器基础

### 4.1 Docker（阿里云镜像源）

```bash
apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg jq
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg \
  | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu jammy stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

**验收**：`docker version --format '{{.Server.Version}}'` 和 `docker compose version` 都有输出。

### 4.2 Node 22 + pnpm

用 tar 包（别用 `apt install nodejs`，版本太老，桥用了 Node 22 内置 WebSocket）：

```bash
apt-get install -y -qq git ffmpeg
VER=v22.20.0
curl -fsSL --retry 3 -o /tmp/node.tar.xz https://npmmirror.com/mirrors/node/${VER}/node-${VER}-linux-x64.tar.xz
mkdir -p /usr/local/lib/nodejs && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
ln -sfn /usr/local/lib/nodejs/node-${VER}-linux-x64 /usr/local/lib/nodejs/current
for b in node npm npx corepack; do ln -sf /usr/local/lib/nodejs/current/bin/$b /usr/local/bin/$b; done
npm config set registry https://registry.npmmirror.com
corepack enable && corepack prepare pnpm@10 --activate
```

**验收**：`node -v` 是 `v22.20.0`；`pnpm -v` 有版本号。

### 4.3 DSH + 「兼容布局」（这一步最容易被漏，漏了桥必挂）

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.2 --registry=https://registry.npmmirror.com
G=/usr/local/lib/nodejs/node-v22.20.0-linux-x64/lib/node_modules
```

DSH 装好后，`dsh` 命令可用。但**桥不调用 `dsh` 命令**：它去读
`~/.dsh-runtime/dsh/node_modules/.bin/dsh.cmd`（一个 Windows 批处理 shim），
从里面正则抠出 `NODE_PATH=...`，然后自己用 `node <...>/@deepseek-ai/dsh/lib/bin.js` 起进程。
所以 Linux 上必须手工造这个布局：

```bash
DEST=/root/.dsh-runtime/dsh/node_modules
mkdir -p "$DEST/@deepseek-ai" "$DEST/.bin"
ln -sfn "$G/@deepseek-ai/dsh" "$DEST/@deepseek-ai/dsh"

cat > "$DEST/.bin/dsh.cmd" <<EOF
@ECHO off
SET NODE_PATH=$G
node "%~dp0\\..\\@deepseek-ai\\dsh\\lib\\bin.js" %*
EOF

ln -sfn "$G/@deepseek-ai/dsh/lib/bin.js" /usr/local/bin/dsh
chmod +x "$G/@deepseek-ai/dsh/lib/bin.js"
```

（想换位置可以设环境变量 `QB_DSH_BIN_DIR`，桥会读它。）

### 4.4 headless profile + 凭证

**凭证**（headless profile 不挂 credentials 插件，桥只能从环境变量/文件注入）：

```bash
mkdir -p /root/.dsh && chmod 700 /root/.dsh
cat > /root/.dsh/.credentials.yaml <<'EOF'
version: 1
refs:
  DEEPSEEK_API_KEY: sk-你的key
EOF
chmod 600 /root/.dsh/.credentials.yaml
```

**profile**（`--profile headless` 用的就是 `~/.dsh/profiles/headless`）：

```bash
# 从内置模板复制一份出来（profile 不会自动创建，直接跑会报 does not exist）
dsh --profile headless --from-default-profile headless --dump-config >/dev/null

cat > /root/.dsh/profiles/headless/package.json <<'EOF'
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    }
  }
}
EOF

cd /root/.dsh/profiles/headless && pnpm install --registry=https://registry.npmmirror.com
```

想加插件（记忆、知识库等）用（`dsh plugin` 就是把参数原样转给 profile 目录里的 pnpm，profile 不存在时会先初始化）：

```bash
dsh plugin --profile headless add meow-memory
dsh plugin --profile headless add dsh-knowledge-canvas
```

加完打开 `/root/.dsh/profiles/headless/package.json`，确认 `dsh.profile.bundles` 里有对应包名（只装依赖不列进 bundles 等于没挂）。

**验收**（一次真实模型调用，会花钱）：

```bash
cd /root/qq-agent/workspace 2>/dev/null || cd /root
DSH_HOME=/root/.dsh DEEPSEEK_API_KEY=$(grep -oP 'DEEPSEEK_API_KEY:\s*\K\S+' /root/.dsh/.credentials.yaml) \
  dsh headless "只回三个字：在的"
```

看到 `在的` 就对了。报 `401/余额` 是 key 的问题，报 `profile does not exist` 是上面 profile 没建。

---

## 5. NapCat：把 QQ 挂上去

### 5.1 目录与 OneBot 配置

```bash
QQ=你的QQ号                  # 必须与登录账号一致，文件名也用它
BASE=/root/napcat
mkdir -p "$BASE/data/config" "$BASE/data/qq" "$BASE/data/plugins" "$BASE/data/voice"

cat > "$BASE/data/config/onebot11_${QQ}.json" <<'EOF'
{
  "network": {
    "httpServers": [],
    "httpSseServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "qq-agent",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "PASTE_SAME_TOKEN",
        "enableForcePushEvent": true,
        "debug": false,
        "heartInterval": 30000
      }
    ],
    "websocketClients": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false
}
EOF
```

- `host: "0.0.0.0"` 是**容器内**监听，映射出来只到宿主机 `127.0.0.1`，别被吓到。
- `messagePostFormat: "array"` 必须是 array，桥按消息段解析。
- `token` 要和桥的 `config.json` → `napcat.token` 完全一致，否则握手 401。
- 文件名里的 QQ 号必须和登录账号一致。

### 5.2 compose（线上实际版本）

```yaml
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: "PASTE_WEBUI_TOKEN"
      ACCOUNT: "你的QQ号"
      NAPCAT_UID: "0"
      NAPCAT_GID: "0"
    ports:
      - "127.0.0.1:6099:6099"   # WebUI
      - "127.0.0.1:3001:3001"   # OneBot WS
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
      - ./data/voice:/app/voice   # 发语音时 NapCat 要读的目录
```

```bash
cd /root/napcat && docker compose up -d && sleep 20 && docker compose logs --tail 40 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g'
```

**验收**：`ss -tlnp | grep -E '3001|6099'` 两行都在，且都是 `127.0.0.1`。

### 5.3 扫码登录（三条取码路径，按可靠性排序）

二维码约 **2 分钟**换一次。人扫慢了就白搭，所以优先给链接。

**① 从日志抠解码链接（最稳，手机点开直接拉起 QQ）**

```bash
docker logs --tail 300 napcat 2>&1 | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -oE 'https://txz.qq.com/p\?k=[^ ]+' | tail -1
```

**② 取缓存图（放大后才能被 GUI 预览）**

```bash
# 容器内的 qrcode.png 不在挂载卷里，宿主机没有，必须 docker cp
docker cp napcat:/app/napcat/cache/qrcode.png /root/napcat/data/qrcode.png
# 原图只有 147px 且是 jpeg 冒充 png，多半预览不出来；放大成真 PNG
ffmpeg -y -i /root/napcat/data/qrcode.png -vf "scale=640:640:flags=neighbor" \
  -pix_fmt gray -frames:v 1 /root/qq-login-qr.png
```

**③ WebUI** `http://127.0.0.1:6099`（走隧道），token 见上；二维码有时不刷新，别只信它。

登录成功后：

**验收**：

```bash
cd /root/qq-agent && node scripts/online-selftest.mjs
# 期望：登录: {"user_id":你的QQ号,"nickname":"..."}
```

失败长什么样：

| 日志 | 含义 |
|---|---|
| `[Login] Login Error,ErrType: 1 ErrCode: 3` + 反复刷二维码 | 登录态过期，**重新扫**，不是端口问题 |
| 桥报 `Received network error or non-101` | 3001 在监听但没登录成，握手被拒 —— 同样是去扫码 |
| `docker ps` 里容器反复重启 | 看 `docker logs napcat`，多半是 qq 卷权限或磁盘满 |

---

## 6. 桥：消息路由 + 人设 + 发送

### 6.1 代码

把仓库里的 `qq-agent/`（`src/ docs/ scripts/ config/ persona/ package.json`）放到 `/root/qq-agent`。
**零依赖**，不用 npm install。上传方式见 §8（必须用 SFTP，且 SFTP 的根是 `/root`）。

### 6.2 最小 config（`config/config.json`）

完整文件很长（限流、防抖、好感度、表情、语音…），复刻只需要这些键，其余可缺省：

```json
{
  "napcat": { "wsUrl": "ws://127.0.0.1:3001", "token": "与 NapCat 同一串" },
  "lists": {
    "privateAllow": [号主QQ],
    "groupAllow": [{ "groupId": 群号, "mode": "full" }]
  },
  "trusted": [号主QQ],
  "reply": {
    "silenceToken": "<SKIP>",
    "debounceMs": { "private": 0, "group": 2500 },
    "cooldownMs": { "private": 0, "group": 3000 }
  },
  "context": { "maxMessages": 14, "maxChars": 2800, "maxAgeMinutes": 40, "maxPromptChars": 9000 },
  "agent": {
    "profile": "headless",
    "taskTimeoutMs": 180000,
    "maxConcurrent": 2,
    "cwd": "workspace",
    "jsonEvents": true,
    "commandPermissionMode": "workspace-write"
  },
  "persona": { "file": "persona/persona.md", "ownerUids": [号主QQ] },
  "control": { "port": 3899, "host": "127.0.0.1" }
}
```

要点：

- `lists` 之外的人**完全不处理**：不调模型、不花钱、不记日志。
- 上面四处 `号主QQ / 群号` 要换成纯数字（JSON 里不能留中文占位），`token` 换成 §5.1 那串。
- `trusted` 是**高危项**：那个号发消息就能在 `/root/qq-agent/workspace` 里读写文件、跑命令。只放自己。
- `agent.cwd = "workspace"` 是相对 `/root/qq-agent` 的；DSH 的 `workspace-write` 权限就锁在这。
- `agent.profile` 必须是 `headless`（对应 §4.4 的 profile）。
- `persona.file` 必须存在，缺了桥直接抛 `人设文件不存在`。

### 6.3 人设注入机制（改 persona 不用重启）

桥每次跑模型前，把 `persona/persona.md` 写成两个补丁文件：

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false   # 纯聊天路径关掉，每轮省 ~80 token
    personaPrefix: "<整篇人设，JSON 字符串形式>"
```

然后 `dsh --profile headless --patch patches/generated-chat.yml "<prompt>"`。
**改 persona.md 下一条消息就生效**；改 `config.json` 必须重启桥（启动时读一次）。

### 6.4 起桥 + 验收

```bash
cd /root/qq-agent && node src/index.mjs
```

**验收**（另开一个 shell）：

```bash
curl -s http://127.0.0.1:3899/api/status | head -c 500
```

里面有连接状态、账号、当前会话数。控制台页面 `http://127.0.0.1:3899` 也能看状态、急停、重载配置。
日志在 `logs/audit-*.jsonl`：每一轮「收到什么 / 回不回 / 回了什么 / 耗时 / token」。

常见「发消息没反应」：不在白名单、冷却中、模型输出 `<SKIP>`、`dsh` 报错（审计日志 `action: failed`）。

### 6.5 systemd（挂服务器的正式方式）

```ini
# /etc/systemd/system/qq-bridge.service
[Unit]
Description=Blue Whale QQ Bridge (NapCat + DeepSeek)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=/root/qq-agent
ExecStart=/usr/local/bin/node /root/qq-agent/src/index.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now qq-bridge
```

**验收**：`systemctl is-enabled qq-bridge` → `enabled`；`systemctl status qq-bridge` 是 `active (running)`。
NapCat 由 compose 的 `restart: unless-stopped` 负责，开机顺序靠 `After=docker.service`。

---

## 7. 端到端验收（五道闸，一道都别跳）

| 闸 | 验什么 | 命令 | 通过标准 |
|---|---|---|---|
| G1 | 端口 | `ss -tlnp \| grep -E '3001\|3899'` | 两行、都 127.0.0.1 |
| G2 | QQ 登录 | `node scripts/online-selftest.mjs` | 返回 `user_id:你的QQ号` |
| G3 | 模型通道 | §4.4 的 `dsh headless "只回三个字"` | 有文字回来 |
| G4 | 桥 | `curl -s 127.0.0.1:3899/api/status` | `connected:true`、`self.user_id:你的QQ号`、`paused:false` |
| G5 | 真消息 | 手机给机器人私聊发一句 | `journalctl -u qq-bridge -f` 出现生成+发送；手机收到回复 |

G5 才是真正“成功”的唯一证据。前四道闸全绿但 G5 不通，去看审计日志里那一轮的 `usage`/`error`。

---

## 8. 远程操作通道（我在本机怎么碰服务器）

服务器是**纯密钥登录**，凭证放 `secrets/server.md`（ACL 仅当前用户），不进对话、不进 git。

- **跑命令**：`python tools/rc.py "<shell 命令>"`，可传多条。走 paramiko，优先密钥 `.ssh/id_ed25519`。
- **跑脚本**：`python tools/rc.py --script tools/xxx.sh`（上传到 `/tmp` 再 bash，**只能传 shell 脚本**；传 `.mjs` 会被 bash 当脚本跑，报语法错）。
- **传单个文件**：`python tmp/put3.py <本地> <相对 /root 的路径>`。

**三个必须知道的坑**：

1. **SFTP 的根是 `/root`，不是 `/`**。所以 `put3.py qq-agent/src/index.mjs qq-agent/src/index.mjs` 才对；写 `/root/...` 绝对路径会 `FileNotFoundError: [Errno 2] No such file`。
2. `rc.py --put/--get` **不可用**（paramiko 的 `sftp.put` 在这个环境对绝对路径失败，`--get` 还会先把本地文件清成 0 字节）。只信 `put3.py` + `rc.py --script`。
3. **绝不要**用 `base64 -d /tmp/xxx > /root/.../file` 这种写法：part 文件不存在时重定向会**先把目标截成 0 字节**（历史上就这样清空过服务器上的 `index.mjs`，靠本机母本才恢复）。

上传后必须对一遍：

```bash
python tools/rc.py "md5sum /root/qq-agent/src/index.mjs"
# 和本机 md5 比较
```

### 改代码的标准流程

1. **先判断谁新**：两边各跑一次 `md5sum src/*.mjs config/config.json`。两边代码**不一定同步**（有些改动是直接改在服务器上的）。
2. 服务器新 → `tmp/pull_files.py` 拉回本机再改；本机新 → 往上覆盖。
3. 本机 `node --check src/index.mjs`。
4. `tmp/put3.py` 上传 → `md5sum` 核对 → `systemctl restart qq-bridge`。
5. 看 `journalctl -u qq-bridge -n 50`，再真发一条消息。

---

## 9. 坑清单（现象 → 根因 → 正确做法）

| # | 现象 | 根因 | 做法 |
|---|---|---|---|
| 1 | `dsh: profile "x" does not exist` | profile 不会自动建 | `dsh --profile x --from-default-profile headless --dump-config` 再改 package.json |
| 2 | 桥报 `dsh 入口未找到` | Linux 上没有 `.dsh-runtime/dsh/node_modules/.bin/dsh.cmd` | 补 §4.3 的兼容布局 |
| 3 | 握手 401 / `non-101` | OneBot token 与桥不一致，或没登录成 | 先对 token，再扫码 |
| 4 | 每 2 分钟刷二维码 | 登录态过期（`ErrType: 1 ErrCode: 3`） | 扫码；别查端口、别重启容器硬试 |
| 5 | 二维码给人看扫不出来 | 容器内 147px、jpeg 冒充 png | `docker cp` + ffmpeg 放大，或直接给 `txz.qq.com/p?k=` 链接 |
| 6 | 脚本输出 `UnicodeEncodeError: 'gbk'` | Windows 端 GBK 编码跑 docker 日志里的方块字符 | `PYTHONIOENCODING=utf-8` + `sed` 去色 + 过滤 `[█▀▄ ]` 行 |
| 7 | 上传报 `No such file` | SFTP 根是 `/root` | 用相对 `/root` 的路径 |
| 8 | 服务器文件变 0 字节 | base64 重定向截断 | 用 `put3.py`；先 `md5sum` 核对 |
| 9 | 回复慢/超时 | `dsh` 冷启动 + 模型；`taskTimeoutMs` 180s | 正常 2.8~3.6s；超时看审计日志 |
| 10 | 改了 config 不生效 | config 只在启动时读 | `systemctl restart qq-bridge` |
| 11 | 群里刷屏 | 删了人设里「不该说话的时候」或 `<SKIP>` 逻辑 | 保留该节；群聊 `debounceMs` 2500、`cooldownMs` 3000 |
| 12 | 工具报错 `Cannot access 'toolMode' before initialization` | `handleBatch` 里 TDZ | `toolMode` 的 `let` 必须在使用前（已修，别改回去） |
| 13 | 时间类功能（提醒、静默时段）错乱 | 服务器非东八区 | `timedatectl set-timezone Asia/Shanghai` |
| 14 | 断线重连无效 | 3001 只绑回环，公网连不上 | 远端一律走 SSH 隧道，不要试图开公网端口 |

---

## 10. 可选增强（不影响主链路，按需再加）

| 能力 | 服务/文件 | 依赖 |
|---|---|---|
| 发语音 / 听语音 / 长期记忆 / 群知识库 | **见另一份文档 `语音·记忆·知识库-复刻指南.md`** | 主链路通了再上，装法在那份里逐条给了 |
| 表情库 | `data/expression.json` + `workspace/stickers/*.jsonl` | 群友发图自动收，@ 它或发满 3 次入队打标 |
| 每天说说 | `src/qzone.mjs`，23:20 | 隐私防火墙默认开，命中人名/学号就不发 |
| 好感度 | `src/favor.mjs`，`#好感度` 查 | 按人共享，不按群 |

这些都只依赖「主链路已通」，加装时**不要动** §6 的启动路径。

---

## 11. 成本与风险（务必转告用户）

1. **ECS 是按量付费的免费试用**（3 个月）。到期或超额度会**自动扣费，不会停机**，需要自己去控制台设提醒。
2. **封号**：NapCat 不是官方客户端。高频、群发、长时间在线都可能触发风控，用小号。
3. **它会用号主的号说话**：人设里写了不承诺、不借钱、不约见面，但不可能 100% 可靠。白名单只放熟人。
4. **`trusted` 等于把 shell 交给一条 QQ 消息**。只放自己，权限模式保持 `workspace-write`。
5. **API Key** 曾以明文出现在调试记录里，建议轮换后只保留在 `.credentials.yaml`（600）。

---

## 12. 出问题先看哪里（决策树）

```
QQ 里发消息没回
├─ ss | grep 3001 没监听        → docker compose ps / docker logs napcat（登录或容器问题）
├─ 3001 在，桥日志报 non-101     → 登录态过期，扫码（§5.3）
├─ 桥日志有「收到」没「发送」
│   ├─ 审计日志 action=skip      → 正常，模型判断不该接话
│   ├─ action=failed + dsh 报错  → G3 单独跑一次 dsh，查 key/profile/网络
│   └─ 白名单外                 → config.lists
└─ 桥没收到事件                  → OneBot 配置里的端口/token/账号对不对
```

---

## 附：文件清单（`/root/qq-agent`）

```
src/            桥的全部逻辑（index/agent/onebot/render/expression/voice/...）
config/         唯一常改的配置
persona/        人设 persona.md（每日轮转出 persona.yesterday.md）
patches/        运行时生成的人设/工具补丁（不要手改）
data/           history 审计、reminders、expression、selfwake、favor 状态
workspace/      DSH 的 cwd：日记、记忆、群档案、素材、incoming
logs/           audit-*.jsonl
scripts/        运维脚本（online-selftest、voice-*、asr-service、tts-service…）
```
