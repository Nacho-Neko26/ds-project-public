# 指令与功能：# 命令、工作项、翻唱、清唱、发文件、RVCMAX

> 从 `AGENTS.md` 拆出来的跑手册（2026-10-26 用户要求精简），内容原样搬来，没有删改。
> 需要时按 `AGENTS.md` 的索引打开；改这里的规则要同步改 `qq-agent/src/` 对应代码。

## 6. 2026-10-23 新加的几样（细节看 `qq-agent/README.md`）

全部是「模型单独输出一行指令 → 桥去做事」，指令行不会发出去：

| 能力 | 指令 / 触发 | 代码 | 要点 |
|---|---|---|---|
| 定时提醒 | `__REMIND__ {"at":"...","text":"..."}` | `src/reminders.mjs` | `data/reminders.json`，30s ticker；群里好感 ≥50 就能设（2026-10-26 从 70 降下来），号主/可信不看分；到点群里会 @ 发起人 |
| 群管理 | `__ADMIN__ {"op":"recall"/"mute"/"card"...}` | `src/admin.mjs` | **只有号主能触发**；机器人只是 member，禁言/改别人名片做不了，撤自己的可以 |
| 点歌 | `__MUSIC__ 歌名 歌手` | `src/music.mjs` | 音乐卡片必须自己填 title/image/audio 走 `type:"custom"`；只给 `{type:"163",id}` 会被签名服务回「缺少 title」→ 1200 |
| 每天说说 | 每天 23:20 自动 | `src/qzone.mjs` | `data/qzone.json` 记 lastDay；素材只用号主私聊 + 日记 + 群摘要，不用群聊原文 |
| 查好感度 | `#好感度` | `src/favor.mjs` `renderFavorCard` + `src/index.mjs` 的 1.7 | 任何用户都能查，不走模型；只认「@它」或「谁都没 @」的消息，`@号主 #好感度` 不算；返回当前分、档位、下一档差多少、后面各档功能 |

- 控制台新增：`GET /api/reminders`、`POST /api/reminders/cancel`、`GET /api/qzone`、
  `POST /api/qzone/post {dryRun|force}`、`POST /api/simulate`（调试注入，需 `control.simulate=true`）。
- 顺手修了个**早就存在的 TDZ bug**：`handleBatch` 里 `toolRule` 用了还没 `let` 的 `toolMode`，
  导致每条消息都 `Cannot access 'toolMode' before initialization`。已把 `toolMode` 提到前面。
  以后改这段注意声明顺序。

### 主人的 # 命令（2026-10-23 改成独立通道）

- 私聊里**以 `#` 开头**的消息 = 命令，不进聊天流程，也不走人设。其余消息仍然是聊天。
- 以前的坑：只给它「全套工具」，人设还挂着，模型会拿角色口吻推脱
  （实测 `#发一段语音` → 「嗓子今天罢工了」）。工具是给了，但它根本没调用。
- 现在的分流（`handleOwnerCommand`，`src/index.mjs`）：**全部交给没有人设的 DSH**，
  `#语音` / `#表情` / `#说说` 也不例外（2026-10-23 用户要求统一走 DSH）。
  桥内能力不在 DSH 的工具集里，所以桥在本地控制台开了 `POST /api/action` 给它调：
  `{"op":"voice","text":"…"}` / `{"op":"sticker","ref":"12"}` / `{"op":"qzone"}`，
  默认发到主人私聊，可加 `"chat":"group:群号"`。这段已经写进 DSH 的 prompt 了。
  实测：无效 op 返回 `不认识的 op`，`{"op":"voice","text":"…"}` 能正常发出语音。
- 权限：`agent.commandPermissionMode`，默认 `workspace-write`（能读能跑命令，
  写文件只限 `/root/qq-agent/workspace`）。要改 config/src 得改成 `danger-full-access`，
  等于把 root 权限交给一条 QQ 消息，慎重。
- 实测：`#看看服务器磁盘还剩多少` → 它自己跑 `df -h`，回「40G 已用 11G，剩 27G，29%」。

### 空 @（2026-10-23 用户定）

- 群里**只 @ 不说话**（没有任何文字/图片/语音段）→ 意思是「看我刚才说的那些」，不是要回一个「@」。
- 桥的处理：拿最近 5 分钟的 `recentContext`（最多 6 条）当这一轮的内容，**不设强制回复**，
  由模型自己判断要不要接；前面没有可接的就直接忽略，一个字都不发。
- prompt 里会加一句「别点破这个 @」，避免回「你艾特我干嘛」。
- 实现见 `src/index.mjs` 的 `bareAt` 分支和 `bareAtHint`。

### 称呼（2026-10-23 用户定）

- **不许再用「小 + 名字第一个字」**（会把「最伟大的顾鹤」叫成「小最」）。现在走
  `pickNoun()`（`src/diary.mjs`）：先取「的/の」后面那截，去掉括号、emoji、修饰前缀、语气尾巴，
  再挑 2~4 个汉字的名词；没有汉字就用拉丁词（Nacho → Nacho）。实测：
  阮沐の史莱姆→阮沐、超级bt兔子→兔子、麻辣小土豆→小土豆、最伟大的顾鹤→顾鹤、抢了知了的橘子→橘子。
  和机器人自己的名字/自称/外号撞车的一律跳过，避免把群友叫成自己；这份黑名单就是
  `allNames()`（`src/character.mjs`）= 名字「溟月」+ 自称「我」+ `config.json` 的
  `persona.aliases`（现在只有 鲸鱼娘/小鲸鱼/哦鲸鲸/DeepSeek酱）。**「史莱姆」不在里面**——
  那是阮沐的别名，不是她的（2026-10-26 用户纠正）；「大肥鱼」「蓝鲸娘」也只是叫法，
  没进 aliases，别凭印象往黑名单里加。
- **优先级：本人/号主明确要求的叫法 > 自动外号。** 模型输出 `__NICK__ {"name":"X"}`
  （自己改名）或 `__NICK__ {"uid":123,"name":"X"}`（号主给别人改），存进 `person.callOverride`。
  `__NICK__ {"name":""}` = 不要外号，叫名字。
- 护栏：只有当消息里真的提到称呼（叫我/别叫/不叫/改名/外号…）才认这条指令，
  否则模型会把「我叫什么？」也当成改名。
- 一次性重算老档案：`node scripts/nick-refresh.mjs`（先停桥）。

### 知识库（2026-10-24 建，只记群里的东西）

- 位置 `/root/qq-agent/workspace/.dsh-knowledge/`：`group.json` = 库「群里的新知识」，
  `selection.json` 的 `enabled` 数组决定注入哪些库（现在是 `["group"]`，教程库 welcome 已关掉）。
- **只记群聊里长出来的**：新梗、群友外号/称呼偏好、口头禅、内部玩笑、群里定下的约定。
  **不记**联网查到的资料、通用知识、教程、一次性闲聊。用户 2026-10-24 原话：
  「本机不需要知识库，在服务器上建立知识库记录QQ群聊里面的新知识就行（群聊内的梗，称呼之类）
  如果是联网查的资料不用存」。
- 结构：`k1` 根（规则与边界）→ `k2` 怎么写一条 / `k3` 群友的称呼与外号 / `k4` 群里的梗。
  模型新写的东西挂到对应伞节点下面。
- 桥的引导在 `src/agent.mjs` 的群聊分支 `rules.push(...)`，写明 `base="group"` 和两条红线
  （写什么格式、不记什么）。改引导要动这段，`node --check` 后再重启。
- **排查第一现场是 `activity.log`**：每行一次 `knowledge_read` / `knowledge_write_node`，
  带 session id、耗时、字符数。想知道「模型到底用没用知识库」先看它，别看日志猜。
- 换库/加库：改 `selection.json` 的 `enabled` 即可，重启 `qq-bridge` 生效；
  JSON 结构照 `welcome.json`（`version` / `id` / `name` / `nodes[]` / `links[]`，
  节点字段 `id` `parent` `title` `body` `change` `at`）。

### 偷图（memeHub）：入库 ≠ 可用（2026-10-24 修）

- 群里别人发的图会自动进 `data/expression.json` 的 `emojiCollection`，但**新图默认停在
  `state: "pending"`，模型发图只认 `active`**（`expression.mjs:803`），所以看起来「收了图但一张都用不上」。
- 根因：`expression.mjs:714` 的 `if (force || !c.reviewPoolEnabled || trustedSource) hub.pendingTag.push(d);`
  —— `reviewPoolEnabled` 默认 `true`，群友又不是可信来源 → 新图**不进打标队列**；
  另一条补录路径要求同一张被见 ≥ `reviewPoolMinHits` 次。
- **当前收录规则**（用户 2026-10-24 定，原话「被发过三次以上的图，或者@你发的，让你存的，涩涩也要存」）：
  - `reviewPoolMinHits: 3` —— 同一张被见 3 次以上自动进队；
  - 消息 **@ 了机器人**（`meta.atMe`；群聊分支 `index.mjs:2228` 传 `mentioned`）或**文本要求存**
    （`wantsSaveText()` 正则，`index.mjs:2105/2228`）→ **直接入队**，不看次数；
  - **涩涩不再删**：`HARD_BLOCK_TAGS` 命中只打 `item.nsfw = true`、`state='active'`（`expression.mjs:768`）。
- 打标节奏：`takeTagJobs` 每轮只发 1 个（锁视觉成本），所以新图要等一两轮对话才能用上。
- 排查三处：`data/expression.json` 的 `emojiCollection` state 分布、`memeHub.pendingTag` 长度、
  日志里的 `[memeHub] 入库 / 打标 … → active`。

### 表情重复：目录去重 + 刚发过不列（2026-10-25 修）

- 症状：老是发同一张。根因不在模型挑图，在**目录本身**：`stickerCatalog()` 原来直接取
  `readJsonl(...)` 的**最后 N 条**（本会话 8 条、共享库 16 条），同一张图被收过多次就占多个
  编号；而 `selfUsedCount` / `lastUsedAt`（`expression.mjs:821/826`）**全仓库没有任何地方递增**，
  所以「刚发过的」从来没被抑制。
- 现在：`src/sticker-usage.mjs` 记台账 `data/sticker-usage.json`（原子写，保留最近 300 键）；
  `stickerCatalog` 先 `uniqueRows`（同键只留最新编号）再 `pickFresh`（25 分钟内发过的先不列，
  剩不到 3 条就放开）；`sendStickerToCurrent` 发完 `recordUse`；`stickerHint` 加了一句「挑图别连着发同一张」。
  窗口可调：`config.json` 的 `stickers.freshWindowMs`（不配就是 25 分钟）。
- 实测（服务器真实库）：`group_<GROUP_ID_2>.jsonl` 157 条→去重 130，四库合计 272→227，
  重复图 45 张——这就是「总发同一张」的直观来源。回归测试 `scripts/test-sticker-usage.mjs`。
- **注意**：`sendStickerToCurrent` 里的 `recordUse` 只做过代码级检查，第一次真发图后要看
  `data/sticker-usage.json` 有没有出现，才算端到端确认。

### 表情只会发老几张：目录里没标签（2026-10-25 修）

- 症状：新偷的图进了库，但 QQ 里永远只发共享图库那几张（haixiu.jpg / wuyu.jpg / deyi.jpg…）。
- 根因：`labelOf(seg)` 对收到的图片只看 `seg.data.summary`，而 NapCat 收到的图 summary 是 `[图片]`，
  所以目录里每条都是「图片」——模型分不清哪张是哪张，只能挑共享图库里**带文件名**的那几张
  （所以 `data/sticker-usage.json` 里全是 `haixiu.jpg` 这类名字，没有 hash 名的）。
- 现在 `index.mjs` 加了 `stickerLabel(row)`：先按 `resolveStickerPath` 找到本地文件，
  用 `hashFile()`（sha256 前 16 位）去查 `workspace/.cache/image-desc.json` 的描述，
  没有再查 `data/expression.json` 里同 digest 的 `summary` / `tags`，都查不到才退回「图片」。
  查过的路径缓存进内存 `stickerLabelCache`，一轮内不重复算 hash。
  **不额外花 token**——用的都是之前看图时已经付过钱的描述缓存。
- 顺带：`config.json` 的 `expression.memeHub.reviewPoolMinHits` 从 3 改成 **1**，
  否则群友发的图 frequency 到不了 3，永远不进 `memeHub.pendingTag` 队列（实测 28 张 pending、
  队列却是 0），也就永远没有摘要。已手动把 12 张 pending 补进队列（`expression.json.bak-backfill`）。
- 首轮证据：离线复算两个群的最近 6 张，标签命中 6/6（例：「一只举着手机在笑…」）。
  桥启动后第一轮聊天的日志里会出现一行 `[目录] 首次构建：…`，那是新标签的样子，可据此复核。

### 指令行写畸形会漏成正文（2026-10-25 修）

- 症状：群里真的发出去一行 `__SEND-STICKER--S4`。模型把 `__SEND_STICKER__ S4` 写成了
  `__SEND-STICKER--S4`（横线代替下划线、`__` 位置也错），原来的正则只认标准写法，
  于是这行被当成正文发了。
- 现在三层防护，改指令相关代码时别拆：
  1. `src/directives.mjs` 的 `normalizeDirectiveLines()`：把 `__SEND-STICKER--S4` /
     `__SEND STICKER_ S4` / `__send-sticker__ #12` 统一成 `__SEND_STICKER__ …`，
     在 `handleBatch` 里**最先**跑（`extractDirectives(normalizeDirectiveLines(text))`）。
  2. `extractStickerDirective()` 的正则放宽到 `_{0,2}SEND[-_ ]*STICKER[-_ ]*_{0,2}\s*[-_ ]*#?(\S+)`。
  3. `sendText()` 发送前过一遍 `scrubDirectiveLeaks()`：含指令标记的**整行丢弃**——
     宁可少一句，也不能把 JSON / 编号漏给对面（`__VOICE_META__` 那种会连 JSON 一起漏）。
- 回归：`node --input-type=module -e "…"` 直接 import 两个函数跑用例（本机/服务器都过）。

### 动图拆帧：默认 16 帧（4×4，2026-10-25）

- 用户原话（m00096）：「看动图可以设置成看16帧吗，现在长一点的图看不全」。
  原来是 8 帧（4×2），长 GIF 中间过程全漏。
- 现在 `src/animation.mjs` 的 `buildFilmstripPlan()` / `buildFilmstrip()` / `resolveAnimatedSheet()`
  默认 **maxFrames = 16**，`gridDims(16)` = 4 列 × 4 行。
- **高度也吃了上限 `maxHeight`（默认 1600）**：竖图（9:16）按比例算每格会到 700+，4 行拼出来
  高 2800+，视觉模型整张压小反而更糊。现在 `tileH = min(round(tileW*aspect), floor(maxHeight/rows))`，
  压矮的部分用 `pad…color=white` 补白、不变形。结果：不论横竖，拼图都不超过 `maxWidth × maxHeight`。
- **帧数进文件名**：`sheetPathFor(hash, outDir, frames)` → `-sheet16.png`（不传 frames 仍是老的
  `-sheet.png`）。不这么做，8 帧时代的老拼图会被 16 帧直接复用。升级时已把服务器
  `/root/qq-agent/workspace/incoming/*-sheet.png` 那 18 张旧缓存（40M）删掉。
- 配置项（`config/config.json` 可选，不配就走默认）：
  ```json
  "animation": { "frames": 16, "maxWidth": 1600, "maxHeight": 1600 }
  ```
  `src/index.mjs` 约 588 行读 `cfg.raw.animation`，改完要重启 `qq-bridge`。
- 实测（服务器 322 张 nekowhale GIF，最大 211 帧 / 300×300）：拼图 16 帧、1600×1600、
  3.0~3.8MB PNG、耗时 52~56ms。单测 `node scripts/test-animation.mjs` 48 条全绿（本机/服务器都跑过）。

## 9. 往群里发文件（2026-10-25 探明，已实发成功）

桥自己**没有**文件能力（`src/` 里没有任何 upload / sendFile），真正能走的是 NapCat 的 OneBot 接口：

1. 文件先放进**容器挂载点** `/root/napcat/data/voice/`（容器内是 `/app/voice/`）。
   其它挂载：`data/qq` → `/app/.config/QQ`、`data/config` → `/app/napcat/config`、
   `data/plugins` → `/app/napcat/plugins`。
2. 用 **Node 22 内置 `WebSocket`**（桥零依赖，服务器上也没有 ws 包）连
   `ws://127.0.0.1:3001?access_token=<onebot token>`，发一条：
   `{"action":"upload_group_file","params":{"group_id":<GROUP_ID_1>,"file":"/app/voice/x.pptx","name":"x.pptx"},"echo":"..."}`
   `file` 必须是**容器内路径**；成功回 `{"status":"ok","retcode":0,"data":{"file_id":...}}`。
3. 母本脚本 `tmp/upload-group-file.mjs`（连 WS、打印 RESP、按 retcode 退出），
   批量壳 `tmp/upload-all.sh`。流程：`python tmp/put3.py <本地> napcat/data/voice/<名字>`
   → `python tools/rc.py "bash /root/napcat/data/voice/upload-all.sh"`。
4. 群号：鲸鱼小屋 `<GROUP_ID_1>`、涛涛阿姨的爱心小窝 `<GROUP_ID_2>`。
5. 坑：WS 只绑 127.0.0.1，只能从服务器上跑；`onebot11_*.json` 的 `messagePostFormat: array`
   不影响上传。

## 11. # 命令 / # 工作项（2026-10-25 用户定）

用户原话：「我想要任意#指令名称都作为要执行的工作项，#+三个固定指令（比如好感度）作为必须执行的命令，
当然都要看对方好感度权限够不够」。

- **三个固定命令**：`#好感度`、`#心情`（谁都能查）、`#同步`（只给号主）。桥内直接答，不走模型。
- **其它任意 `#名称 …`**：当工作项，交给没有人设的 DSH 真干活（`runWorkItem`）。
  写法兼容 `#看看磁盘`、`# 看看磁盘`、`#提醒 明天八点叫我`（名称=提醒，extra=后面那句）。
  正则：`/^[#＃]\s*([^\s#＃]{1,20})(?:\s+([\s\S]*))?$/`——名字取到第一个空格为止，剩下全是 extra。
- **好感门槛**（`index.mjs` 顶部常量函数）：`agent.commandFavor` 默认 **70**（= `FAVOR.friend`），
  不够就回「这条得等好感 70 以上才办（现在 XX）」；号主 / `config.trusted` 不看分，一律执行。
- **干活权限**：号主/可信 → `agent.commandPermissionMode`（默认 `workspace-write`）；
  普通群友 → 强制 `read-only`，只准看不准改。
- **用她的嘴**：`POST /api/action` 现在要带 `"by":"发起人QQ号"`，桥按好感判断
  （`agent.actionVoiceFavor` 默认 = `agent.voiceFavor` 默认 35）。号主/可信放行；不带 by 的老调用放行。
  判断函数是 `actionGate({by, favor, isTrusted, need})`，每次调用会在日志里留
  `[action] op=… by=… favor=… → allow/deny`。
- 单测：`actionGate()` 与 `matchCommandLine()` 都是纯函数，可以直接 import 验。
- 坑一：用 `rc.py --script` 执行的 .sh 里带 python heredoc，bash 会先展开 `$` 和反引号，
  Markdown 里的反引号内容会被吃掉（本节被写坏过一次）。**写文档用 write/edit，别走 shell heredoc。**
- 坑二：`import("...")` 这种双引号在 PowerShell 下会被吃掉，测试要写成脚本文件 + 单引号 JS。
- 坑三：`curl -X POST … -d '{…}'` 在 rc.py 管道下会挂住，加 `--max-time 10` 并 `base64 -w0` 取回。

## 14. 点歌翻唱（`#翻唱 歌名`，2026-10-25 上线）

QQ 里发 **`#翻唱 起风了`**（私聊或群里都行，`#翻唱` 不带歌名会回用法）。
得等好感 90 以上，号主不受限。桥回一句「排上了」，之后本机跑完，成品直接发回同一个会话。

**为什么绕一圈**：翻唱流水线吃显卡，服务器是纯 CPU（10 秒的片段要 766 秒），
真正的算力在本机；而本机没有公网入口，所以只让它**拉**任务，桥不需要连它。

链路（拉模式，双向都靠服务器磁盘做信箱）：

| 角色 | 动作 |
|---|---|
| 桥 `src/cover.mjs` | 写 `data/cover/queue/<id>.json`（歌名/会话/发起人）；`sent/<id>.json` 留一份会话信息 |
| 本机 `tools/cover-agent.py` | 每 15s SFTP 扫队列 → **先删队列文件**再跑 → `D:\DSH\翻唱工具` 跑 cover.py → 转 192k mp3 → 传 `done/cover-<id>.mp3` + `done/cover-<id>.json` |
| 桥 watcher | 每 15s 扫 `done/*.json` → **≤ `cover.voiceMaxSeconds`（默认 180s）就发语音条（record）**，更长发文件（`upload_private_file`/`upload_group_file`）→ 删两个文件 |

- 本机执行器由计划任务 **`DSH-Cover-Agent`** 常驻（登录后 1 分钟起 + 每 10 分钟兜底），
  安装脚本 `tools/install-cover-agent.ps1`，日志 `cover/cover.log`，状态 `cover/state.json`。
- **本机没开机**：队列没人取，超过 30 分钟桥会清掉（避免第二天开机突然蹦出一堆老歌）。
- 翻唱本体在 `D:\DSH\翻唱工具\翻唱工具`，已改 GPU 版（torch 2.14.1+cu130 + onnxruntime-gpu 1.31，
  `sep_worker.py` / `rvc_infer.py` 改成自动选 cuda、显存不够退回 CPU）。
  实测 5:26 的歌整首 **210 秒**（改前纯 CPU 光 10 秒片段就 766 秒）。
- 换音色：把 `<音色名>_s700.onnx` 丢进 `models\`，命令里会让本机用 `--voice <音色名>`；
  现在只有自带 `keroro`。成品保留最近 10 首（`/root/napcat/data/voice/cover-*.mp3`）。
- 输出响度按 **−14 LUFS / True Peak −1.0 dBFS** 归一，单声道 44.1kHz。
  2026-10-26 按「人声要能听清」调过：混音默认 `--vocal-gain 1.8`、`--inst-gain 0.45`
  （旧 1.15/0.55，人声相对伴奏响约 +5.6dB），人声再叠 `VOX_TAIL`（2.5kHz +2.5dB + 轻压缩）。
  **`amix` 必须带 `normalize=0`** —— ffmpeg 默认会把两路各压一半，人声就是被这条吃掉的。
  试过 sidechain 闪避（伴奏随人声下沉），频段指标更好看但整曲 LRA 从 2.9 涨到 5.5，怕「发飘」没采用。

## 15. 清唱（`#清唱 歌名`，2026-10-26 上线）

只出人声、不叠伴奏。和 `#翻唱` 共用同一条队列、同一个好感门槛（90，号主豁免），
区别只在任务对象里多一个 `mode` 字段：

| 命令 | `mode` | 本机跑法 |
|---|---|---|
| `#翻唱 歌名` | `vocal` | `cover.py <歌>` → 人声 + 伴奏混音 |
| `#清唱 歌名` | `acappella` | `cover.py <歌> --acappella` → 只拿换声后的人声，音量 + 峰值限制 + −16 LUFS |

改到的四个文件：`翻唱工具\scripts\cover.py`（新增 `--acappella`，在混音段之前直接出 `${base}-${voice}-acappella.wav`，
单声道 44.1k）、本机 `tools\cover-agent.py`（`run_cover(song, voice, mode)` 拼参数）、
桥 `src/cover.mjs`（`enqueueCover` 存 `mode`，日志/失败文案按「翻唱/清唱」区分）、
桥 `src/index.mjs`（`FIXED_COMMANDS` 加 `清唱`，与 `翻唱` 同一个分支）。

- 实测：5:26 的歌清唱整首 **273 秒**（比混音版慢一分钟，多走一遍人声后处理）。
- **判据是频段**：清唱版 30–250Hz 只剩 ~10% 能量、打击密度 0.4~1.4 次/秒且不规律；
  混音版同一段是 63% 能量、2.7~3.0 次/秒规律打击 —— 说明伴奏和鼓确实被剥掉了。

## 16. RVCMAX 界面（2026-10-26）

去掉了顶部「其他」标签页和「永久免费」标语，登录/会员/激活全保留。`resources/app` 是指向 `D:/DSH/rvcmax-work/app` 的 junction（原 asar 备份 `app.asar.orig`，回滚改回来）；启动前必须 `unset ELECTRON_RUN_AS_NODE`。细节见 `D:/DSH/rvcmax-work/README.md`。

