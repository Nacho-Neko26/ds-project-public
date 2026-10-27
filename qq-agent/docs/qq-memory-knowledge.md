# 记忆、知识库、认人、#同步、表情包导入

> 从 `AGENTS.md` 拆出来的跑手册（2026-10-26 用户要求精简），内容原样搬来，没有删改。
> 需要时按 `AGENTS.md` 的索引打开；改这里的规则要同步改 `qq-agent/src/` 对应代码。

## 7. #同步：本机 ↔ 服务器（记忆库 + 知识库，2026-10-25）

主人在 QQ 私聊发 **`#同步`**，就是把她在服务器上攒的「记忆库」和「知识库」跟本机这份对一遍。

- **范围**（用户 2026-10-25 选「只要记忆库和知识库」）：`memory.db` 的七张内容表
  `soul/user/project/fact/lesson/topic/rules` + `.dsh-knowledge/*.json` 的知识库节点。
  会话账本（`windows`/`dream_*`）、日记、群档案、好感度、表情索引、图片都不搬。
- **链路**：桥收到 `#同步` 只写一个标记（`data/sync/pending.json`，因为它连不到本机）→
  本机计划任务 `DSH-Chat-Sync`（**登录后 2 分钟跑一次，之后每 30 分钟一次**）跑
  `tools/chat-sync.py --watch-once` → 有标记就同步、清标记，并通过桥的
  `POST /api/action {"op":"text"}` 代发一句「同步好了 …」。
  标记不会丢：本机关着就等它下次开机（2 分钟后那次）补。
- **合并规则**：按 `id` 合并、`updated_at`（知识库是节点 `at`）新的赢；**日常回传方向只挑
  `soul/user/rules` 三层**，本机写代码攒的 fact/lesson/project 默认不往她上下文里灌——
  要全量推得显式加 `--push-all`（2026-10-25 用户说「同步到服务器」，273 条全层级推过一次）。
  `selection.json`（哪个库注入）**属于各端本地配置，不搬**。本机已把 `group` 库打开。
- **文件**：`tools/chat-sync.py`（引擎）、`tools/install-chat-sync.ps1`（注册计划任务，
  非管理员、走 `schtasks /xml`）、`sync/state.json`（两个游标）、`sync/last-report.md`
  （每次的明细）、`sync/last-run.log`（追加日志，UTF-8；PowerShell `Get-Content` 会显示成乱码，别慌）。
- **常用**：`python tools/chat-sync.py --dry-run --force`（只看会搬什么）、`--force`（重建基线）、
  `schtasks /Run /TN DSH-Chat-Sync`（手动催一次）。
- **坑**：`Register-ScheduledTask` 在本机没有管理员权限会报 `拒绝访问`，必须用
  `schtasks /Create /XML`；桥的 `/api/action` 原来没有 `text`，为了回报同步结果加的。

## 8. 认人：一个 QQ 号一份身份（2026-10-25）

**身份键是 QQ 号，不是名字。** 同一个人在鲸鱼小屋叫「沐·枫逸萧」、在涛涛阿姨的爱心小窝叫
「史莱姆」，都是 `<MEMBER_QQ_1>`：好感、档案、「关于他」的印象同一份。被问「A 和 B 是不是一个人」，
看 QQ 号答；不同 QQ 号就算同名也不是一个人。

- **身份表** `workspace/profiles/_identities.json`：`{uid: {aliases:[最多8], chats:[...], updatedAt}}`。
  谁给桥发一条消息（`enqueue()` 里）就记一次名片，`__NICK__` 改名也记。
  - 记名字时**顺带拆短叫法**（`deriveAliases`）：去括号/emoji → 「的 / の」后面那截 → 太长的
    中文名取末尾 3 字（`麻辣小土豆(づ ●─● )づ` → `麻辣小土豆`/`小土豆`）；带符号的原形
    （`沐·枫逸萧`、`Y.C`）保留；纯 QQ 号、空格子不收。
- **每轮 prompt 注入「【认人】」一节**（`renderIdentityBlock`，最多 10 人 × 4 个叫法）：只给本条
  消息相关的人——本批发送者 + 文本里被叫到名字的人（`resolveMentions` 按别名匹配），行尾写
  「—— 都是同一个人」，模型据此回答「他们是不是同一个人」。
- **关于他跨群一份** `workspace/profiles/_about-shared.json`：记事本写 `about` 时同步进去，
  `renderNotebook` 优先读共享那份，标题「【关于他】（按 QQ 号记的，不分群，你可以信）」。
- **代码**：`src/identity.mjs`（新）、`src/index.mjs`（enqueue 记账 / 组 prompt）、
  `src/agent.mjs`（`buildPrompt` 收 `identity` 并 push）、`src/favor.mjs`（读共享 about）。
- **一次性迁移**：`node scripts/unify-identity.mjs --dry` 先看，去掉 `--dry` 真写（扫
  `profiles/*.json` 的 displayName + `notebook/*.json` 的 about）。**必须读
  `loadConfig().agentCwd`**——写成 `process.cwd()` 会把表写到 `/root/qq-agent/profiles/`
  （真实目录是 `/root/qq-agent/workspace/profiles/`），2026-10-25 踩过。
- **测试**：`node scripts/test-identity.mjs`（15 条断言，本机/服务器都绿）。
- **边界**：两人真用同一个昵称时纯文本分不开（档案按 uid 分得开）；`SFTP 根是 /root`，
  `rc.py --get` 要用相对路径，`/tmp/...` 拿不到。
- **主人＝祈羽（<OWNER_QQ>）；顾鹤＝小知（<MEMBER_QQ_4>），不是同一个人（2026-10-25 用户纠正）。**
  事故：模型自己输出 `__NICK__ {"name":"顾鹤"}`，把号主的 `callOverride` 改成了「顾鹤」
  （`by:"self"`），`_nicknames.json` 跟着脏，于是在 QQ 里一直管主人叫顾鹤。修法两层：
  ① 数据层——`_nicknames.json` 与三份 `group_*.json` / `private_<OWNER_QQ>.json` 的
  `callOverride` 改回「祈羽」，`_identities.json` 里 <OWNER_QQ> 只留 祈羽/祈羽Nacho/nacho，
  顾鹤 记到 <MEMBER_QQ_4>；
  ② 代码层——`src/index.mjs` 的 `for (const n of dir.nicks)` 开头加护栏：
  `if (ownerUids.includes(targetUid)) { note('warn', ...); continue; }`，号主的叫法**模型不许自己改**。
  以后再加群友，先确认 uid，别靠名字。

## 10. 记忆注入：现在没有这套了（2026-10-26 修正）

**下面这段「记忆每天只注入一次」是历史记录，2026-10-26 已作废，别照着排查。**

- 当初的问题：每个 QQ 回合一开头恒定慢 **21 秒**。根因是 `meow-memory` 插件在
  `agent/pre-step` 里判断「这是会话第一轮」，把 soul 31 条 + user 16 条 + 全局 rules
  整块塞进 prompt（约 1.5 万 token，其中约 9800 是它的注入）。单摘它，同一句话从 21s 掉到 2.9s。
- 当时的做法（现已不存在）：04:00 维护时用「只回复两个字：收到」开一个 daily 会话
  （sid 写 `workspace/.dsh-meow/daily.json`），之后每轮 `--session-id` 续用，
  让 meow-memory 认得 `priorUser > 0` 而不再插首轮快照。

**2026-10-26 的真实状态**：

- **代码里已经没有任何 `--session-id` / `daily.json` 逻辑**（`grep -rn 'sessionId\|daily\.json' qq-agent/src` 零命中）。
  `src/agent.mjs` 的 `run()` 传的是裸 prompt，**每轮都是新会话**，上下文天然不累积。
- 服务器残留 `workspace/.dsh-meow/daily.json`，内容停在 `{"daykey":"2026-10-25",...}`——
  那是历史文件，不会再更新，**看到它别以为机制还在跑**。
- headless profile 的 `package.json` 里 **`meow-memory: ^0.31.1` 仍然在依赖里**（没卸），
  但实际没在注入：audit 里每轮 `usage.in` 约 4700~7300、`journalctl` 里的耗时 3~5 秒，
  离 1.5 万 token / 21 秒差得远。
- 所以「为什么记忆没注入」这类问题**不用查了**，本来就不注入。
  **要盯的反而是「哪天它又开始了」**：判断线只有两条 —— `journalctl -u qq-bridge` 每轮的
  「（xxxxms）」突然回到十几秒，或 audit 的 `usage.in` 涨到 1.5 万以上。
  真发生了就去 headless profile 把 `meow-memory` 从 `package.json` 摘掉（有
  `package.json.bak-tokenplugins-20261026` 可对照），然后重启不必要，下一轮 spawn 就生效。
- **需要长期记忆的地方**：桥自己那套 `workspace/memory/memories.jsonl`（每 60 条自动学一次，
  注入 `injectChars` 350 字）；`memory.db`（434KB，soul/fact 等）只有 DSH 桌面会话在用，
  跟 QQ 桥无关。
- 老细节（21 秒怎么量出来的、`dream-debug.log` 怎么读、临时测试钩子）留在
  `AGENTS.md.bak-20261026-slim`，需要考古再看，别再写回现役文档。

### 表情包换成 nekowhale 322 张（2026-10-25 导入）

- 来源：<https://github.com/Loping151/dsh-nekowhale-stickers>（大肥鱼哈基米表情包，代码 Apache-2.0，**知识库素材 CC BY-NC 4.0，分发必须保留作者链接**：B站 space.bilibili.com/103739 + kiriyuki.com）。
- 导入脚本 `qq-agent/tools/import-nekowhale.mjs`：拉 `meta/nekowhale.json`（jsdelivr 镜像，官方源 kiriyuki.com），逐张下载
  `https://kiriyuki.com/media/gif/<pack>/<stem>.gif?h=<hash>` 到 `workspace/stickers/nekowhale/<hash>.gif`（322 张 / 389MB），
  再往 `workspace/stickers/_shared.jsonl` 追加一行（字段 `hash/emotion/tags/use/en/dir/pack/stem` + `seg.data.summary`）。
  幂等：按 hash 和本地文件跳过已导入的。
- 挑选机制移植自其 `src/core/search.ts` → `qq-agent/src/sticker-score.mjs`：查询词对 `name 6 / tags 5 / emotion 4 / text 4 / use 3 / en 2 / desc 1 / dir 2`
  做子串匹配取最高权重求和，多词再乘「命中覆盖率²」，只命中一个词的图会被压下去。
- 接线：`stickerCatalog(key, hintText)` 拿到这一轮对方的话，对共享图库先 `pickFresh` 去重去刚发过的，再 `rankRows` 取前 16；
  没有查询词就退回「最近 N 条」。`stickerCatalog` 里旧的 `uniqueRows`/`freshWindowMs` 逻辑不变。
- **GIF 必须带 `sub_type: 1`**：`materializeSeg` 里 `/\.gif$/i` 时给图片段加 `sub_type:1`，否则 QQ 里显示成普通图片而不是表情。
- 发一条验证：`curl -X POST 127.0.0.1:3899/api/action -d '{"op":"sticker","ref":"S126","chat":"group:<GROUP_ID_1>"}'`；
  索引 = `_shared.jsonl` 行号（322 张从 24 开始，例 `S126`=3N05_摸鱼、`S109`=16N12_不够吃、`S335`=TT02_比心）。
- 已实发：2026-10-25 往鲸鱼小屋发了 S126 摸鱼 / S109 不够吃 / S335 比心，`data/sticker-usage.json` 记了 3 个 hash 键。

### 表情：只在「无语 / 激动」时随机发（2026-10-25 改定）

- 症状：表情发得太勤、太规律（原来固定「2~3 轮最多一张」）。用户原话：「现在发表情频率高了一点，
  或者说太规律了，希望可以改成随机几句发一次表情，在表达无语或者激动情绪时发送，然后就是被要求时发送」。
- 情绪点只有两类，判断在 `qq-agent/src/sticker-moment.mjs` 的 `stickerMoment(text)`（纯函数）：
  `「无语」` = 无语/服了/离谱/麻了/醉了/好家伙/绷不住/emmm/……/...；
  `「激动」` = 哈哈/笑死/笑不活/好耶/太棒/绝了/牛啊/厉害/哇啊/哇！/激动/燃/冲/666/yyds；其余一律返回空串。
- 随机门同文件：`stickerSelfGate(lastAt, now, rng)`——距上次发图不到 `SELF_STICKER_GAP_MS`（1 分钟）直接否，
  过了再掷 `SELF_STICKER_CHANCE`（0.35）；`lastStickerAt(loadUsage(cfg.dataDir))` 取台账里最近一次发图时间。
- `src/index.mjs` 的 `stickerHint(key, hintText, {allowed})`（约 485–500 行）：
  `mayPick = Boolean(moment) && stickerSelfGate(lastStickerAt(loadUsage(cfg.dataDir)))`；
  mayPick 才写「这一轮可以配一张」，否则写「【表情默认不发】……素材当没看见，只说话」。
- `persona.md`「转发表情」节同步改成「不用等主人点名，但不是每轮都发。只有两种情绪……一分钟内发过就别再发」，
  **两处要一起改**，只改一处效果会减半。对方点名要图不受随机门限制，照发。
- 验收：`node --check src/index.mjs src/sticker-moment.mjs` + `node scripts/test-sticker-moment.mjs`
  （13 条断言，本机/服务器都跑）+ 服务器 `systemctl restart qq-bridge`。
  **真效果要看群里下一轮**：`data/sticker-usage.json` 出现新 hash 键才算端到端生效。


## 好感度 / 心情也走同步（2026-10-27 加）

- 用户原话：「同步服务器与本机好感度心情记忆的记录」。记忆和知识库本来就同步，缺的是这两样运行时数据。
- 数据在哪：好感度 `/root/qq-agent/workspace/profiles/*.json`（`_favor-shared.json` 是跨会话总表，
  `group_<群号>.json` / `private_<QQ号>.json` 是单会话表，结构是 `{"people": {uid: {...}}}`，
  另有 `_identities.json` / `_nicknames.json`）；心情 `/root/qq-agent/data/emotion.json`（valence/arousal/emotion）。
- 现在 `tools/chat-sync.py` 的 `sync_runtime_state()` 会把它们拉到本机同名位置：
  `qq-agent/workspace/profiles/` 与 `qq-agent/data/emotion.json`。
  合并规则：同一个 uid 取时间更新的那份（`_entry_ts` 依次看 `lastChatAt` / `updatedAt` / `at` / `since`），
  本地独有的 uid 保留；`group_*` / `private_*` 必须先钻进 `people` 一层再按 uid 合并，**整块比会把本地独有的人吃掉**。
  写之前留 `.bak-sync-<时间戳>`，最多留 5 份。
- 触发：`do_state_sync()` 挂在 `main().one()` 里，**每次运行都跑**，包括计划任务用的 `--watch-once`；
  不依赖 `#同步` 打的 pending 标记（否则几天不同步就成旧账）。
- 验收：`python tools/chat-sync.py` 第一遍报「好感度更新 N 条 · 心情已更新」，第二遍必须报
  「好感度更新 0 条 · 心情无变化」；再跑 `D:/DSH/tmp/cmp_state.py` 逐 uid 比对，六个档案 diff 全 0 才算对上。
- 只做服务器→本机：本机的 qq-agent 计划任务是 Disabled，好感度只会由服务器累加，不需要反向推。
