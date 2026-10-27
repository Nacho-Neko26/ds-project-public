# 聊天规则与线上事故：接话、思考泄漏、复读、分条

> 从 `AGENTS.md` 拆出来的跑手册（2026-10-26 用户要求精简），内容原样搬来，没有删改。
> 需要时按 `AGENTS.md` 的索引打开；改这里的规则要同步改 `qq-agent/src/` 对应代码。

## 4. 已知取舍

- NapCat **不装任何插件**，只当哑终端协议端；所有业务逻辑留在桥里。
- **好感度怎么涨（2026-10-25 定稿，用户原话「加上时间戳，只扫描过去一小时的……聊天用户全标记为「+」，
  触发扣分标记由「+」改为「-」，每天四点对所有标记为「+」的用户好感加 5」）**：
  - 每个人当天有一个二元标记 `person.dayMark`：正常聊天记为 `+`，说了胖/嘴贱/拿生气开玩笑
    就**改写成 `-`**（当天不再加）。
  - 每轮聊天都更新 `person.lastChatAt`（毫秒时间戳）。
  - 桥的 ticker 每 10 分钟跑一次 `settleHourlyAll()`（`src/index.mjs`），只给
    「`dayMark === '+'` 且 `lastChatAt` 在过去 1 小时内」的人 **+1**，按 `hourKey` 去重。
  - **这条路每天最多 5 分**（`FAVOR.hourlyDailyCap`，用户 2026-10-25 要求）：加满 5 分后
    当天再聊也不再给；但 **04:00 的日结照给**（前一天标记是 `+` 就 +5），不受这条路影响
    （2026-10-25 用户明确改了这条：以前是「加满就不日结」，现在是「日结照补」）。
  - **一天所有加分方式加起来封顶 20**（`FAVOR.dailyGainCap`）：每小时 +1、日结 +5、夸奖、
    首聊都算在里面；好感 <50 的人同样封顶 20，只是每次增量打五折。用 `ignoreCap: true`
    发的一次性补偿（比如 2026-10-25 全员 +10）不计入这个额度。
  - 每天 04:00 的 `settleDailyChat()` 给前一天标记为 `+` 的人 **+5**。
  - `#好感度` 被查时先给被查的人结算当前这一小时，所以显示的是实时分。
  - 手动补跑：`node scripts/hourly-once.mjs`（幂等，同一小时跑多次只加一次）。
- **好感按「人」不按「群」（2026-10-25 用户定，原话「每个群聊好感度对同一个人是统一的，
  除了主人 <OWNER_QQ> 的私聊」）**：同一个 QQ 号在 `<GROUP_ID_2>` 和 `<GROUP_ID_1>` 里好感一致，
  私聊各算各的。做法照 `_nicknames.json` 的老路子——好感相关字段单独存
  `workspace/profiles/_favor-shared.json`，`loadProfiles` 读群档时覆盖、`saveProfiles` 写回
  （`src/anger.mjs` 的 `SHARED_FAVOR_FIELDS` / `favorIsShared`，只有 `group:` 前缀共享）。
  一起共享的还有 `hourKey` / `hourlyGainToday` / `dayMark` 这些额度字段，否则同一个小时
  两个群各加一次、一天能加两倍。基准群是 **<GROUP_ID_2>（涛涛阿姨的爱心小窝）**，
  迁移脚本 `node scripts/unify-favor.mjs`（加 `--dry` 只打印不写）。
- **记忆有两套（2026-10-25 定）**：`meow-memory` 插件装在服务器 headless profile 里，库在
  `/root/qq-agent/workspace/.dsh-meow/memory.db`（首轮自动注入 + 关键词命中，长期记忆）；桥自己的
  `workspace/memory/memories.jsonl` 保留做「每 60 条消息自动学一次」的速记，注入额度 `injectChars`
  已从 700 降到 350。两套不互相导入（jsonl 的 64 条已一次性迁进 meow-memory：soul 30 / fact 34）。
  别问「为什么有两套」，也别把 jsonl 删掉——自动学习还靠它。
- 表情指令：模型输出 `__SEND_STICKER__ <n>` 独占一行；解析器也容忍 `#4` / `S17` / `#S17`。
- 每轮延迟云上约 **2.8~3.6 秒**（8 秒那个是迁移前 Windows 上的旧数据）。
- `ackOnSlow` 保持**关闭**（用户决定）。
- **怒气不再一句话就炸（2026-10-23）**：用户反馈「好好聊着突然开始怼人」。根因在
  `src/anger.mjs` 的刺激判断——`fat`/`rude` 一句就直接 `raiseTo = 2`。现在改成「热值」：
  说胖/嘴贱各 +2、催 +1、拿生气开玩笑 +4；攒到 **3 才 Lv1、6 才 Lv2、9 才 Lv3**；
  正常说话 -1，每 6 分钟自然 -1；好感 <20 门槛降 1。自动消气/被好感 70 软化时热值一并清。
  回归测试：`node tools/test-anger-heat.mjs`。

## 5. 群聊什么时候接话（2026-10-25 改定）

用户 2026-10-25 原话：「开口前先判断这句话是不是对你说的。必应的三种情况：① 被 @；② 被叫你的名字或外号；③【对你说】栏里有人直接问你。都不满足时，只有话题真的很有趣才概率接话（20%~40%），否则沉默。」

- 规则落在两处，**必须一起改**：`qq-agent/persona/persona.md` 的「## 群里怎么接话（QQ 和微信同一套规则）」，
  以及 `src/agent.mjs` 的 `buildPrompt()` 群聊分支 `rules.push(...)`（约 333-362 行）。
- **旧的「默认倾向是接，不是忍」已作废**（那是 2026-10-23 的规则）。`config.eye.keywordOnly`
  仍是 `false`，硬过滤层不拦，接不接由模型按三条件自己判。
- `config.persona.aliases`：鲸鱼娘/小鲸鱼/哦鲸鲸/DeepSeek酱/大肥鱼/溟月——点名就算跟自己有关。
  **「史莱姆」是阮沐的别名、「主人」是祈羽（号主本人），都不是在叫它**（2026-10-25 用户纠正）。
- `reply.cooldownMs.group` = 3000，`debounceMs.group` = 2500。
- at 段由 `src/render.mjs` 渲染成 `@你` / `@号主` / `@群友` / `@全体成员`；`@号主`、`@群友` 不是叫它。
- 空 @ 走 `recentContext`（`src/index.mjs` 的 bareAt 分支），不强制回复。
- 输出纪律：一条消息不换行；停顿就发两条（`<分>` 或两行短句，各 ≤20 字、合计 ≤40 字，`src/util.mjs`
  的 `splitMessages` 会自动拆）；不回成对话体/剧本；不复述对方署名。
- **接话概率按群可配（2026-10-25 用户定）**：`config.json` → `reply.groupChance`，
  形如 `{"default":[0.2,0.4],"<GROUP_ID_2>":[0.2,0.4],"<GROUP_ID_1>":[0.6,0.8]}`（数组是「下限,上限」）。
  **鲸鱼小屋 = <GROUP_ID_1>**（config 里只存群号，群名要去 `data/` 里 grep 才知道），
  2026-10-25 用户要求把它上调到 0.6~0.8。
  `src/agent.mjs` 的 `groupChanceLabel(cfg, chat.key)` 读它拼进群聊 prompt，写成「20%~40%」这种文案；
  群号没配就回落 `default`，配坏了也回落，不报错。改完要重启 `qq-bridge`（config 启动时读）。
  单测：`node scripts/test-group-chance.mjs`。

## 12. 思考过程不许发到聊天里（2026-10-25，第二次抓）

**症状**：私聊 22:14:58 那条（3 条 / 112 字）把模型写给自己的权衡发出去了：
> 他发了个表情，估计就是随便逗一下。我回一句就好。
> 就发个「[表情]」，多半是求回应呢……本鲸也甩一张？不过默认先不发，这轮就纯说话，显得有点小傲娇。
> 嗯，挺短的一句话，简短点回。唔，甩个表情过来就想把本鲸晾在那儿？说句话嘛。

只有最后一句该发。前两段把桥注入的提示词原文（「默认先不发」「这轮就纯说话」）也复述了出来——
说明模型把「怎么决策」和「说什么」写在同一份 final 文本里。

**根因**：`src/agent.mjs` 的 `parseRunEvents()` 只取 `ev.type === 'final'` 的 `text` 整段当正文，
中间没有任何切分；prompt 首条「只输出正文」约束太弱。

**两层防护（改一处不够）**：
1. **prompt**：`agent.mjs:349-357` 的 rules 第二条——「你写下的每一个字都会原样发到 QQ」，
   明令不许写分析/权衡/计划，并给反例；内心戏要用角色的话说。
2. **桥侧兜底**：`src/thinking-guard.mjs` 的 `stripThinkingLeak(text)`，在 `sendText()`（`index.mjs:698`）
   里先跑它、再跑 `scrubDirectiveLeaks()`。按行 → 按句删「自述规划」片段：
   - STRONG 单条即判：`回一句就好`、`简短(点|地)?(回|说)`、`默认(先)?不发|先不发`、`甩一张|配一张`、`素材(当|就)没看见`
   - WEAK 要凑 ≥2 条：`估计|多半|大概`、`这轮|这一轮`、`要不要(发|甩|配)`、`(我|本鲸)(该|就|先|再)(回|说|答|发)`、`(他|她|对方)(发了|在问|这是)`
   - 只有一段时**不切**（风险大于收益）；指令行（`__XXX_`、`<SKIP>`）原样保留；清完为空就不发这轮。
   - 剥掉时日志留 `[思考] 剥掉自述片段：112字 → 21字`，可据此判断是 prompt 没管住还是兜底接住了。
3. **人格第 17 条**：`persona/persona.md` 说话方式加「不许把想的过程写进消息」，persona-sync 已刷进
   `C:\Users\14381\.dsh\AGENT.md:80`。

**验收**：`node scripts/test-thinking-guard.mjs`（8 条，含真实泄漏原文 → 只剩最后一句；两行短句不误删；
单段不动；指令行保留；全思考清空）。本机/服务器均 pass=8。桥 22:20:44 重启 active、已登录 <BOT_QQ>。

**注意**：如果把 WEAK 的 `估计是` 写成固定两字，真实泄漏那句「估计**就**是随便逗一下」匹配不到——
现在是 `估计|多半|大概` 不加「是」，改规则时别收紧回去。


## 17. 复读机：反复发同一种句式（2026-10-26 修）

- **症状**（用户原话）：「现在在qq聊天时你经常重复发格式相似的句子」。抓到的样本是连续 9 条都长成
  「（叹词），本鲸……」两小句结构，而且同一句话在不同时间出现两遍。
- **主因在桥，不在人格**：`src/index.mjs` 的 `sendText()` 10-26 新增了「把自己的话也塞进
  `session.recentContext`（`self: true`）」。群里被 @ 时 flush 分支会拿整圈 `recentContext`
  减去 `session.buffer` 灌回待处理队列——**而 buffer 每轮清空，所以 missing 恒真、60 条全灌**，
  她自己上一轮说的话就变成【新消息】里的【你】标签进了 prompt，模型顺着自己的句式往下说。
  同时 `handleBatch` 第 1 步把它们也 `history.append` 了一遍，于是 history 里同一句有
  `{role:'bot',name:'溟月'}` 与 `{role:'assistant',name:'你'}` 两份，用户消息也被重复记录
  （10-26 当天 (t,text) 重复行 72/384；assistant 行首次出现 2026-10-26 07:17:07）。
- **三处改动**（`qq-agent/src/index.mjs`）：
  1. flush 分支 `const missing = ctx.filter((c) => !c.self && !session.buffer.some(...))` —— 只带回别人说的话（出现 2 处，都改了）。
  2. `handleBatch` 写 history 前用 `session.seenMsgIds`（Set，超 800 条裁到 400）按
     `messageId || uid|time|text` 去重，一句只写一次，并记录实际写入数 `appended`。
  3. `history.transcript(..., { excludeLast: appended })` —— 原来传的是 `batch.length`，
     去重后 batch.length 大于实际写入数，会把正常上下文多吃掉几条。
- **人格**（`qq-agent/persona/persona.md`）：口癖从「最多用两次」收回「最多用一次」；补回
  「别每条都用同一个骨架（连着三条『（叹词），本鲸……』就是复读）」「不要每句都描写尾巴/耳朵」
  「一日最多偶尔带一次动作」「别每句都引用回复，__QUOTE__ 只在指代不清时用」。
- **上下文窗口**（`config/config.json` 的 `context`）：`maxMessages` 30→20、`maxChars` 4000→3200、
  `maxAgeMinutes` 60→45、`maxPromptChars` 14000→12000——自己的话进了历史后占比变高，缩窗口降自我回声。
- **历史清洗**：`/root/tmp/hist-dedupe.py`（本机 `D:\DSH\tmp\hist-dedupe.py`）按 `(t,text)` 去重、
  先备份 `.bak-dedupe-<ts>`。实测 <GROUP_ID_1> 276→215（删 61）、<GROUP_ID_2> 47→36（删 11）、私聊 61 无重复。
  跑法（**必须先停桥**，否则和 append 抢写）：
  `systemctl stop qq-bridge && python3 /root/tmp/hist-dedupe.py && systemctl start qq-bridge`。
- **验收证据**：部署后 md5 一致（index.mjs `b7d97b3b…`、config `1e9779a1…`、persona `7dc74c49…`），
  服务器 `node --check` 通过，`qq-bridge` active（12:26:59 起，NRestarts=0，已登录 <BOT_QQ>），
  三个 history 文件 `dup 0`；`POST /api/action {"op":"text"}` 发一条后 history 只多 1 行 bot。
  **风格是否真收敛要看群里下一轮**——日志里数「assistant 行是否还增长」「(t,text) 是否重现」即可。
- **坑**：`tmp/pull_files.py` 是**双向覆盖**的，它会把服务器版本直接写回本机同名文件（不备份、
  不问 md5 谁新）。这次就把刚改好的 `src/index.mjs` / `config/config.json` 冲掉了，靠重做才恢复。
  以后先 `cp 文件 文件.bak-<日期>` 再跑它，或者干脆用 `python tools/rc.py "md5sum …"` 只读比对。

## 18. 该断成两条却发成一长条（2026-10-26 修）

- **症状**：用户在 QQ 里贴回自己（机器人）发的一条原话，说「可以在『号』后面就另发一条」——
  那句是「唔…翻唱也一样卡在队列外面呀祈羽，写不进那个目录就是排不上号，要不你等等，能写了本鲸第一个唱给你听」
  （48 字，一整行），实际发成了一长条。
- **根因不在模型，在切分**：`sendText()`（`src/index.mjs:718`）先用 `splitMessages()` 认 `<分>`/`|||`/空行/
  **正好两行且每行 ≤20 字**，再用 `chunkText(p, reply.maxCharsPerMessage)` 限长，而
  `maxCharsPerMessage` 是 **700** —— 模型写成一整行、且超过 40 字时，两条规则都不命中，于是一条长消息直接发出去。
- **修法（三层，2026-10-26 上线）**：
  1. `src/util.mjs` 新增 `splitOverlongMessage(text, {softMin:40, softMax:90, cut:34})`：
     40~90 字的单条在「34 字以内最后一个标点」处断成两条；**>90 字的功能性长文不动**
     （提醒、翻唱回执那种不能被切成九段）；没有标点不硬切。
  2. `sendText()` 里接在 `splitMessages()` 之后：`splitMessages → splitOverlongMessage → chunkText`。
     阈值可配：`config.json` 的 `reply.softSplit: {min,max,cut}`（不配走默认）。
  3. 两行短句的门槛从「每行 ≤20、合计 ≤40」放宽到 **每行 ≤28、合计 ≤56**（`util.mjs` 的
     `SHORT_LINE_MAX` / `SHORT_TOTAL_MAX`）——模型常写两行各 25 字，原来也不拆。
- **为什么是 34**：用户那句 48 字里第二个逗号在索引 30，正好断在「号，」后面，切出来 31+18 字。
- **日志**：切开时 `journalctl -u qq-bridge` 会有一行 `[分条] 2 条：31/18字`，这是端到端验收的唯一凭据
  （history 里仍然只记一条整句，别拿 history 行数当证据）。
- **验收**：`node scripts/test-split-overlong.mjs` 10 条断言本机全绿；服务器 md5 一致
  （util.mjs `50fc35f6…`、index.mjs `95190530…`）；`POST /api/action {"op":"text"}` 发那句原话，
  journal 出现 `[分条] 2 条：31/18字`，QQ 侧真的收到两条。
- **坑**：用 `python tools/rc.py "H=…; echo $H"` 时 `$H` 会被本地/远端两层引用吃掉（报
  `$H: No such file or directory`），要么写死路径，要么把脚本上传后再跑。
