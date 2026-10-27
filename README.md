# 溟月 · QQ 聊天机器人（完整可复刻版）

一个**跑在自己服务器上的 QQ 机器人**，人格是一只叫「溟月」的蓝色鲸鱼娘。
它不是关键词机器人：每条消息都真的跑一次 DeepSeek Harness agent——读人设、翻记忆、调工具，再以她的口吻回你。

仓库里是她「重新活过来」需要的一切：桥的源码、人设、记忆库、群知识库、表情库索引、部署脚本、运维手册。

---

## 快速部署（Linux 服务器，约 10 分钟）

前提：一台 Ubuntu/Debian 服务器（root）、一个能扫码登录的 QQ 号、一个 DeepSeek API Key。

> 仓库是**公开**的，直接 clone 即可；部署脚本不会带上任何人的聊天数据。

```bash
git clone https://github.com/Nacho-Neko26/ds-project-public.git
cd ds-project-public
sudo bash deploy/install.sh --qq <机器人QQ> --owner <号主QQ> --api-key sk-你的key
# 可选：末尾再加 --official-key sk-官方key（只给余额播报用，不填也能聊）
```

脚本自动做：装 Node 22 / Docker → 起 NapCat 容器 → 部署桥到 `/root/qq-agent` → 装 DeepSeek Harness
→ 生成 OneBot token 与配置 → 注册 systemd `qq-bridge` → 打印扫码指引。

扫完码，跑一次自检：

```bash
systemctl status qq-bridge
journalctl -u qq-bridge -n 30 --no-pager    # 出现「NapCat 已连接」「已登录账号」就是活的
```

在 QQ 里跟她说句话，她就会回。

> 参数怎么调：`bash deploy/install.sh --help`（端口、DSH 版本、安装目录）。手工分步部署见 `docs/`。

---

## 仓库结构

```
deploy/               一键安装 / 升级 / 排障
  install.sh          部署脚本（幂等，可重跑）
  upgrade.sh          升级桥（自动备份 + 语法检查 + 回滚命令）
  README.md           部署细节、卸载、故障对照表
qq-agent/             桥本体（Node 22，零外部依赖）
  src/*.mjs           收消息、攒上下文、跑 agent、发出去、记账、表情、语音、好感度…
  persona/            人设 persona.md + 语料底本 corpus.md
  config/             config.json（token 已脱敏）+ config.example.json
  workspace/          她的「记忆」：记忆库、群知识库、好感度档案、表情索引、日记
  docs/               运维手册：改语音 / 改接话规则 / 命令清单 / 记忆知识库 / 表情库
  scripts/            运维调试脚本
  patches/            DSH profile patch（把人设注进 headless 会话）
docs/                 复刻指南、好感度档位、表情包安装法
tools/                日常运维小工具（远程执行、上传、人设同步、聊天记录回传）
存档/                 DSgalgame 项目自己的存档
```

## 她会什么

聊天接梗 · 看图 · 语音（TTS）· 发和存表情包 · 搜网页查天气 · 定时提醒 · 点歌翻唱 · 写日记和说说 ·
群管理（撤回自己的消息）· 记好感度（分档决定听不听话）· 记忆注入 + 群知识库 · 余额监控 ·
`#` 指令系统（主人和白名单可用）

规则细节在 `qq-agent/docs/`：改语音看 `qq-voice.md`，改接话规则看 `qq-chat-rules.md`，
加命令看 `qq-commands.md`，记忆/知识库看 `qq-memory-knowledge.md`，装表情看 `stickers-INSTALL.md`。

## 表情素材包

图片本体（约 389MB）不进 git，仓库里只有索引。装法见
[`qq-agent/docs/stickers-INSTALL.md`](qq-agent/docs/stickers-INSTALL.md)；不装也能跑，
只是「共享图库」是空的，她会从群里慢慢自己攒。

## 架构一句话

```
QQ ──NapCat(docker, OneBot11 WS :3001)──► 桥(src/index.mjs) ──spawn──► DSH headless agent
                                              ▲                          │
                                              └──── 人设+记忆+知识库 ◄────┘
```

桥负责：会话上下文、白名单、指令、表情/语音、好感度、记账；agent 负责：说话和调工具。

## 存档的提交方式（记忆库）

`memory.db` 是 SQLite，运行时数据先写进 `-wal`。直接提交会漏数据，所以先合并：

```bash
python -c "import sqlite3;c=sqlite3.connect(r'qq-agent/workspace/.dsh-meow/memory.db');print(c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone());c.close()"
git add -A && git commit -m "存档：<说明>"
```

`-wal` / `-shm` / `*.log` 已在 `.gitignore` 排除。

## 安全

- 所有端口只绑 `127.0.0.1`，外网不可达；看面板走 SSH 隧道。
- API Key、OneBot token、QQ 登录态都不在仓库里：token 安装时现场随机生成，key 由你传入。
- 白名单：只有 `config.json` 的 `lists` / `trusted` 里的会话才会被接，陌生人一律不理。

## 许可

私人项目。代码随便看，人格设定和语料别直接拿去商用。
