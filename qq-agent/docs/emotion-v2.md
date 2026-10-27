# 情绪引擎 v2 设计文档（QQ 机器人 · 通用版）

> **2026-10-27 更新：`src/mood.mjs` 已删除。** 旧的六档心情（正常/困/被夸/高兴/被说胖）全部下线，情绪只走 `src/emotion.mjs` 的九档引擎；原 mood.mjs 里跟心情无关的「饱腹 / 饭点 / 日期时间 / 群名」搬到了 `src/status.mjs`（`computeStatus`）。本文档里对 `mood.mjs` 的行号引用保留作历史对照，实际代码已不在。

> 状态：**设计稿**（已实现并上线）。所有代码引用均为**已核实**的真实行号（核对时间：本次会话，基于当前工作区 qq-agent/）。

---

## 1. 概述与设计目标

### 1.1 为什么在已有三件套之外再加一层

桥里现在有三套各自为政、彼此不知道对方存在的「状态」：

| 模块 | 管什么 | 形态 | 关键代码 |
|---|---|---|---|
| `src/favor.mjs` | 对**某个人**的好感 0~100 | 离散档位 hated/normal/friend/obey/sing | `favor.mjs:18-43`（FAVOR 常量）、`favor.mjs:69-75`（tierOf） |
| `src/anger.mjs` | **怒气热值** Lv0~Lv3 | 事件累计 + 时间回落 | `anger.mjs:52-75`（LEVELS）、`anger.mjs:210-347`（updateAnger） |
| `src/mood.mjs` | **饱腹**（饿/正常/饱）+ 离散心情标签 | 无数值、无衰减、跨轮残留字段 | `mood.mjs:52-73`（computeHunger）、`mood.mjs:95-153`（computeState） |

问题不是「缺一个心情」，而是**缺一个连续的、会自己回落的中间变量**：

1. 旧心情标签（`mood.mjs:111-116`）是**枚举**，没有程度。被夸一句和被夸十句，标签都是「被夸」，下一轮又说「正常」——没有惯性，情绪不「留」在角色身上。
2. 没有衰减。`mood.mjs` 除了「被说胖」按天记（`mood.mjs:104-106`），其余全靠当轮消息重算，昨天的坏心情今天不会残留一点，今天的坏心情也不会自己好。
3. `mood.mjs` 的 note 是**形容词式**指导（`mood.mjs:125-131`），模型拿到的是标签而不是一个可读的「此刻状态」，写出来的句子容易一刀切。
4. 三套状态在 prompt 里**各自插一句**，口径可能互斥：怒气 Lv2 说「越生气越客气」，mood 说「被说胖→沉默」，没有仲裁者。

新增的 `src/emotion.mjs` 就是那个中间变量：一个全局的、连续的双轴状态（valence / arousal），带基线、带衰减、带上下文上限，负责把「她此刻什么劲头」收敛成**一段**注入。

### 1.2 分工边界（三条线，互不越界）

- **好感回答「对谁」**：说话人维度的长期关系。`emotion.mjs` **不新建任何好感数值**，只经 `ensureFavor()`（`favor.mjs:143-153`）读取 `person.favor` 用于渲染。favor 的加减、日上限、劝说、临时扣分全部保持现状（`favor.mjs:174-203`、`index.mjs:1303-1352`）。
- **怒气回答「现在多生气」**：短时、离散、有硬出口（Lv3 只回「嗯」「哦」，`index.mjs:1417-1428`；Lv≥2 禁撒娇语音，`index.mjs:615-628`）。`emotion.mjs` 只**读** `anger.lv` 作为 valence 上限，不改怒气算法一个字符。
- **情绪回答「劲头」**：全局、连续、会衰减。它是**表述层**，不是决策层——不 gate 任何功能，只决定 prompt 里怎么说、`#心情` 怎么答。

一句话：**好感管关系，怒气管出口，情绪管语气。**

---

## 2. 状态模型

### 2.1 双轴定义

| 轴 | 含义 | 取值 | 极低端 | 极高端的读法 |
|---|---|---|---|---|
| `valence` | 情绪效价（高兴 ↔ 不高兴） | 0~1 连续 | 被戳到、闷、冷 | 被夸、满足、愿意搭理人 |
| `arousal` | 唤醒度（劲头大小，不是「情绪强度」） | 0~1 连续 | 蔫、懒、想睡 | 来劲、坐不住、想接话 |

两轴**正交**：`arousal` 低不等于不开心（满足到犯懒），`valence` 低不等于要炸（闷着不说话）。

### 2.2 基线与衰减

- 基线：`valence 0.5`、`arousal 0.35`（`arousal` 基线故意压低——她的人设是「懒、短句」，长期高唤醒会失真）。
- 衰减：每分钟朝基线**线性**回收 `0.004`。
  - 校验：4 小时 = 240 分钟 × 0.004 = **0.96**，能把 1.0 的差距几乎抹平；半小时只回 0.12，所以一句夸能残留半小时左右，一晚上的事到早上就没了。
  - 公式：`x' = x + sign(base - x) * min(d, |base - x|)`，其中 `d = decayPerMinute * minutes`，`minutes = (now - updatedAt)/60000`。**线性**而非指数，故意和 dsh-mood 一致，便于手算和单测。
- 衰减在**读取时**算（lazy），不需要定时器：桥每轮都会读一次，隔夜之后第一轮读的时候一次性补算。

### 2.3 持久化文件

路径：`qq-agent/data/emotion.json`（`config.emotion.stateFile` 相对 `ROOT` 解析，`ROOT` 见 `config.mjs:5`；`data/` 目录已在启动时建好，`index.mjs:48`）。

    {
      "schemaVersion": 1,
      "valence": 0.5,
      "arousal": 0.35,
      "updatedAt": "2026-10-25T02:31:00.000Z",
      "emotion": "calm",
      "residual": { "valence": 0.072, "arousal": 0.036 },
      "pendingModelDelta": { "valence": 0, "arousal": 0 },
      "residualAt": 1792895460000,
      "lastDelta": { "dvalence": 0.10, "darousal": 0.05, "why": "被夸了", "at": "2026-10-25T02:31:00.000Z" }
    }

- `schemaVersion`：升级/损坏时用；读到不认识的值就整份回落到基线并记 warn。
- `updatedAt`：ISO 字符串，**只**用于 `v`/`a` 朝基线回归的时间基准（第 6 步），不参与余温衰减。
- `emotion`：上一轮渲染出的名字，便于日志和 `#心情` 兜底。
- `pendingModelDelta`：上一轮模型 `__MOOD__` 的增量，暂存到下一轮开头并入 `Δtarget`（时序见 §3.3）。
- `residual` / `residualAt`：**情绪余温**——本轮没被吸收完的那部分增量（逐轴），加上上次衰减的时刻（毫秒）。详见 §2.6。
- **两个时间戳各管一摊，禁止共用**（硬规则）：`updatedAt` 只喂第 6 步「v/a 朝基线回归」，`residualAt` 只喂第 1 步「余温半衰期衰减」。任何一方读到另一方的时间戳，都会让两套节奏互相污染（见 §13 C-12）。
- `lastDelta`：只用于 `note()` 日志（`why` **只进日志，不上屏**，见 §5.3）。

### 2.4 读写风格对齐现有 data 文件

| 现有文件 | 写法 | 参照行 |
|---|---|---|
| `data/reminders.json` | `JSON.stringify(db, null, 2)` + `.tmp` + `renameSync` | `reminders.mjs:31-48` |
| `data/selfwake.json` | 同上，按 `dataDir` 拼 | `selfwake.mjs` 内 `save()` |
| `workspace/profiles/*.json` | `writeFileSync`，无 tmp | `anger.mjs:147-150` |

`emotion.json` 采用 **tmp + rename**（与 `reminders.mjs:43-48` 一致）：它是每轮都可能写的热文件，写一半被打断会让整份状态失效。

### 2.5 惰性写盘

只在「有新信息」时写：

    需要写盘  <=>  abs(valence - 旧值) > 1e-9
              或  abs(arousal - 旧值) > 1e-9
              或  abs(residual.valence - 旧值) > 1e-9      ← 余温变了也要写
              或  abs(residual.arousal - 旧值) > 1e-9
              或  pendingModelDelta 任一轴变化 > 1e-9      ← __MOOD__ 暂存必须落盘，否则次轮丢失
              或  emotion 变了
              或  文件不存在

- 纯衰减产生的变化**也算变化**（否则 `updatedAt` 不动，下次会把同一段时间重复衰减——错得更离谱），所以衰减后必须写回。
- 若这一轮既没命中关键词、没有 `__MOOD__`、距上次写盘不足 1 分钟且情绪名没变，则**跳过写盘**，只把算出来的值用于本轮渲染：闲聊高峰不会每秒刷盘。

### 2.6 余温（residual）与惯性

双轴之外，状态里还挂着一个**余温向量** `residual = {valence, arousal}`（可为负）和一个时间戳 `residualAt`。

它解决的问题：一句话就能让 `valence` 从 0.5 跳到 0.6，模型下一轮立刻换脸——不像人，人是有惯性的。

**一切算术都逐轴**：`Δ` 不是单标量，而是向量 `(Δv, Δa)`；`Δv` 只进 `valence`、`Δa` 只进 `arousal`，任何一轮任何一层都不共享额度。说胖（`-0.12 / +0.10`）与催（`0 / +0.06`）就是反例：两轴符号相反或只有一轴动，混用会让它们互相污染。

机制三句话：

1. **每轮只吸收一部分**：即时增量与余温**逐轴**合并成 `Δv` / `Δa`，每轴只有 `1 - inertia`（默认 **0.28**）真的作用到该轴上，剩下的 `inertia`（0.72）留在同轴的 `residual` 里。
2. **余温会自然凉**：按半衰期 `residualHalfLifeMinutes = 20` 分钟衰减，`residual *= 0.5^(Δt分钟 / 20)`。40 分钟剩 1/4，1 小时剩 1/8。
3. **余温参与下一轮**：下一轮 `Δv = Δtarget.valence + residual.valence`、`Δa = Δtarget.arousal + residual.arousal`，两轴各走各的——一次没被吸收完的情绪会在后面几轮继续推着对应的轴走，这就是「余温」和「缓冲期」。

两个极端值都必须安全：`inertia = 0` 退化成「即时生效」（与旧口径一致）；`inertia = 1` 时 `1 - inertia = 0`，`v` 一起不动（不能死锁、不能 NaN，见 §9 用例 12）。

---

## 3. 事件与更新管线

### 3.1 每轮八步（顺序照抄，实现不许改序）

     ┌─ handleBatch(session, batch)                                    index.mjs:1202
     │
  1) │ 读状态 + 余温时间衰减
     │    st = loadEmotion(cfg)                       data/emotion.json
     │    Δt_res = (now - residualAt) / 60000 分钟
     │    residual *= 0.5 ^ (Δt_res / residualHalfLifeMinutes)      // 半衰期 20 分钟
     │
  2) │ 算本轮即时增量 Δtarget（逐轴，两轴各算各的）
     │    Δtarget.v = 关键词.valence + pendingModelDelta.valence
     │    Δtarget.a = 关键词.arousal + pendingModelDelta.arousal
     │    每轴独立夹紧：关键词每轴 ±0.25，__MOOD__ 每轴 maxModelDelta(0.2)，
     │    相加后每轴再 clamp ±0.25                      // 三层，见 §13 C-13
     │
  3) │ 合成并逐轴夹紧（余温本身是向量）
     │    Δv = Δtarget.v + residual.valence
     │    Δa = Δtarget.a + residual.arousal
     │    Δv = clamp(Δv, -0.35, +0.35)
     │    Δa = clamp(Δa, -0.35, +0.35)
     │    ⚠ Δv 只进 v，Δa 只进 a —— 两轴永不共享额度
     │
  4) │ 吸收（惯性逐轴生效）
     │    v = clamp01(v + Δv × (1 - inertia))          // 1 - inertia = 0.28
     │    a = clamp01(a + Δa × (1 - inertia))
     │
  5) │ 记回余温（逐轴）
     │    residual.valence = Δv × inertia              // 0.72 留着给下一轮
     │    residual.arousal = Δa × inertia
     │
  6) │ 向基线衰减（只动 v / a，不动 residual）
     │    Δt_v = (now - updatedAt) / 60000 分钟
     │    x += sign(base - x) × min(decayPerMinute × Δt_v, |base - x|)
     │
  7) │ 怒气 / 生理 clamp（只压上限）
     │    anger.lv >= 2 → v = min(v, 0.40)            // anger 来自 index.mjs:1374-1379
     │    anger.lv >= 3 → v = min(v, 0.25)
     │    hunger === 饿 → a = min(a, 0.55)            // hunger 来自 index.mjs:1289-1294
     │    hour ∈ [0,6) → a = min(a, 0.25)
     │
  8) │ 惰性写盘（有变化才写，residualAt / updatedAt 一起更新）
     │    saveEmotion(cfg, st)
     │
     └─▶ 渲染注入块 renderEmotionBlock(…) → buildPrompt()            agent.mjs:360-366
                                                                      index.mjs:1514-1548

**第 7 步放在第 6 步之后**是有意的：先衰减再压上限，保证写回的值一定满足约束，下一轮读到手的就合法。`clamp01` 指夹到 [0,1]。

**逐轴铁律**：第 2~5 步里出现的 `Δ` 一律是向量 `(Δv, Δa)`，`Δv` 只写 `valence`、`Δa` 只写 `arousal`，任何一处都不许把两轴合成一个标量；`clamp` 也是逐轴调用（`clamp(Δv,-.35,.35)`、`clamp(Δa,-.35,.35)`），额度互不侵占。验收看 §3.2 例 2（催）。

### 3.2 数字例子（必须照此写进实现注释）

**例 1：一次夸奖**，`Δtarget = (valence +0.10, arousal +0.05)`，`inertia = 0.72`：

| 时刻 | 计算（逐轴） | 结果 |
|---|---|---|
| 本轮吸收 · valence | `v += 0.10 × (1 - 0.72)` | `v` 只涨 **+0.028** |
| 本轮吸收 · arousal | `a += 0.05 × 0.28` | `a` 只涨 **+0.014** |
| 本轮余温 | `(0.10, 0.05) × 0.72` | `residual = (+0.072, +0.036)` |
| 1 分钟后 | `× 0.5^(1/20) = 0.9659`（约衰减 3.4%） | `residual ≈ (+0.0696, +0.0348)` |
| 下一轮（无新关键词） | `Δv = 0 + 0.0696` → `v += 0.0195`；`Δa = 0 + 0.0348` → `a += 0.0097` | `v` **+0.0195** / `a` **+0.0097** |

**例 2：只动 arousal 的「催」**，`Δtarget = (0, +0.06)`：

| 时刻 | 计算（逐轴） | 结果 |
|---|---|---|
| 本轮吸收 · valence | `v += 0 × 0.28` | `v` 涨 **0（纹丝不动）** |
| 本轮吸收 · arousal | `a += 0.06 × 0.28` | `a` 涨 **+0.0168** |
| 本轮余温 | `(0, 0.06) × 0.72` | `residual = (0, +0.0432)` |
| 1 分钟后 | `0.0432 × 0.9659` | `residual ≈ (0, +0.0417)` |
| 下一轮（无新关键词） | `Δa = 0 + 0.0417` → `a += 0.0417 × 0.28` | `a` 再涨 **+0.0117**，`v` 仍为 0 |

这一例是**逐轴铁律的验收点**：如果实现写成单标量，被催两句连 `valence` 都会跟着爬，变成「越催越开心」。

**例 3：两轴符号相反的「说胖」**，`Δtarget = (-0.12, +0.10)`：本轮 `v` 掉 `0.12 × 0.28 = 0.0336`、`a` 涨 `0.10 × 0.28 = 0.028`，`residual = (-0.0864, +0.072)`。单标量实现会把它算成一个数，两轴同时被推同向——「越被说胖越平静且越来劲」或「越难过越没劲」，两种都是错的。

所以**连夸四五轮才看得见明显变化，一次性夸不动它**——这正是要的效果。反过来，被骂一次 `Δtarget = (-0.18, +0.12)`，本轮 `v` 只掉 0.0504（`a` 反涨 0.0336），剩下的 `(-0.1296, +0.0864)` 挂在 `residual` 上，接下来两三轮（每轮凉一点）继续把 `v` 往下拖，不会一轮就翻脸、也不会一轮就没事。

### 3.3 时序事实（必须写清楚，否则实现会错）

`__MOOD__` 来自**本轮**的模型输出，而注入块在**本轮 prompt 组装时**就已渲染完毕。同一轮里它不可能影响自己那一轮的语气：

- 本轮前段：`index.mjs:1289-1294`（computeState）→ `index.mjs:1374-1379`（updateAnger）→ **情绪管线**（§3.1 的 1~8 步，插在 `index.mjs:1414` 之后）→ `index.mjs:1514`（buildPrompt 渲染）→ 模型输出。
- 本轮末尾：`index.mjs:1659` 解析出 `__MOOD__` → 只做 `pendingModelDelta` 暂存 + 落盘，**不动 v**；下一轮第 2 步把它并进 `Δtarget` 一起参与吸收。

即：**关键词与余温是当轮生效，`__MOOD__` 是次轮生效（次轮才被吸收）**。这是物理事实，不是设计选择，实现不要试图把 `__MOOD__` 提前。

---

## 4. 参数表

### 4.1 引擎参数（写进 `DEFAULTS.emotion`，`config.mjs:116` 之后插入）

| 参数 | 默认值 | 含义 | 调参建议 |
|---|---|---|---|
| `emotion.enabled` | `true` | 总开关。`false` 时整块退回旧行为（mood 行恢复、`__MOOD__` 忽略、`#心情` 报「情绪引擎已关闭」） | 想立刻停用只改它，不要改代码 |
| `emotion.baseline.valence` | `0.5` | 效价基线 | 想她整体更冷淡调 0.42；更黏人调 0.58。别越过 0.35/0.65，否则 3x3 会被推向一侧 |
| `emotion.baseline.arousal` | `0.35` | 唤醒度基线 | 人设「懒」，不建议超过 0.45；上调会让 9 档长期落在中/高 arousal 行 |
| `emotion.decayPerMinute` | `0.004` | 每分钟朝基线回收量 | 0.004 ≈ 4 小时回 0.96。要「情绪留得久」调 0.002（8 小时），要快速归零 0.008（2 小时） |
| `emotion.inertia` | `0.72` | 惯性系数：每轮只有 `1 - inertia` 被吸收，其余留在余温里 | 0 = 即时生效（旧口径）；0.85 = 极钝，一件事要八九轮才透出来；不建议 ≥ 0.95 |
| `emotion.residualHalfLifeMinutes` | `20` | 余温半衰期（分钟） | 20 分钟 ≈ 一句夸的余温撑半小时到一小时。要「隔夜还记着」调到 120，但会显得记仇 |
| `emotion.maxModelDelta` | `0.2` | 单轮 `__MOOD__` 每轴绝对值上限 | 模型偶尔写 0.8，靠它拦。0.15 更保守 |
| `emotion.angerClamp.lv2` | `0.40` | `anger.lv >= 2` 时 valence 上限 | 想「生气时彻底高兴不起来」压到 0.30 |
| `emotion.angerClamp.lv3` | `0.25` | `anger.lv >= 3` 时 valence 上限 | 通常与 lv2 保持 0.15 差距 |
| `emotion.stateFile` | `data/emotion.json` | 状态文件（相对 `ROOT`） | 改路径前先确认 `data/` 已存在（`index.mjs:48`） |

**代码常量（不进 config）**：`Δ 每轴上限 = 0.35`、`关键词单轮每轴 clamp = ±0.25`、`3x3 切分点`（§5.1）。**所有上限都是「每轴独立」，不是两轴共享一个额度**——`Δv` 与 `Δa` 各自夹，`residual` 也是两个独立分量。这几个改了会牵动单测，放常量便于审查。

### 4.2 关键词表与增量（`scoreKeywords`）

| 类别 | 正则（逐字保留） | Δvalence | Δarousal |
|---|---|---|---|
| 强夸 | `/(最喜欢\|爱你\|喜欢你\|最可爱\|最棒\|最厉害)/` | `+0.10` | `+0.05` |
| 一般夸 | `/(厉害\|好棒\|棒\|好看\|可爱\|乖\|牛\|强\|优秀\|聪明\|真好\|不错)/` | `+0.05` | `0` |
| 说胖 | `/(大肥鱼\|肥鱼\|胖\|肥)/` | `-0.12` | `+0.10` |
| 辱骂 | `/(你滚\|闭嘴\|傻\|笨\|丑\|垃圾\|废物\|你没用\|你就是个程序\|只是程序)/` | `-0.18` | `+0.12` |
| 拿生气开玩笑 | 同 `anger.mjs:27` 的 `JOKE_ABOUT_ANGER` 语义 | `-0.10` | `+0.15` |
| 催 | `/(快点\|赶紧\|还没\|催)/` | `0` | `+0.06` |
| 深度倾诉 | 长度 `> 200` 字 且 `/(累\|烦\|难过\|开心\|高兴\|兴奋)/` | `+0.06` | `-0.05` |

规则：

- **同一轮多命中则累加**（强夸与一般夸会同时命中，两层都加，这是有意的：一句「你最厉害了」确实比「还行」重）。
- 单轮关键词总增量**各自 clamp 到 ±0.25**（`dvalence` 与 `darousal` 分别 clamp，不共享额度）。
- 「拿生气开玩笑」的正则 `anger.mjs:27` 是模块内 const、未 export；为不碰 `anger.mjs`，`emotion.mjs` 复制一份等价正则并注明「与 `anger.mjs:27` 同源，改动需同步」（见 §13 冲突 C-8）。
- **clamp 前后的值都要记日志**：第 2 步三层 clamp 会让「关键词已打满 ±0.25 时，模型那轮的 `__MOOD__` 被整体吃掉」。实现里 `note('debug')` 必须同时写 `Δtarget(pre-clamp)` 与 `Δtarget(post-clamp)`，否则以后排查「模型明明说了被夸却不动」无从下手。

### 4.3 上下文 clamp（只压上限，不抬下限）

| 条件 | 作用 | 依据 |
|---|---|---|
| `anger.lv >= 2` | `valence = min(valence, 0.40)` | `anger.lv` 来自 `index.mjs:1374-1379` |
| `anger.lv >= 3` | `valence = min(valence, 0.25)` | 同上（Lv3 会走 `index.mjs:1417-1428` 硬回复，见 §13 冲突 C-9） |
| `hunger === 饿` | `arousal = min(arousal, 0.55)` | `hunger` 来自 `mood.mjs:64` 三档 |
| `0:00~6:00` | `arousal = min(arousal, 0.25)` | 与 `mood.mjs:109` 的 `sleepy` 判据同源 |

clamp 只在写入前做一次（第 7 步），不做「夹住后再衰减」——第 6 步的衰减方向朝基线，天然不会冲破上限。

### 4.4 参数怎么互相影响（调参前必读）

- `inertia` 与 `residualHalfLifeMinutes` 是一对：惯性大但半衰期短 = 「反应钝、但忘得快」；惯性小半衰期长 = 「一点就着、但记很久」。**默认组合（0.72 / 20）是「钝且不留太久」**，适合她的人设。
- `decayPerMinute`（第 6 步）只管 `v`，所以它决定「情绪多久回到基线」；`residualHalfLifeMinutes` 决定「未吸收的冲量多久凉掉」。两者都调大会让情绪既难涨也难落。
- `Δ` 每轴上限 0.35 是硬闸：它保证任何单轮（含余温叠加）单轴都不会被推动超过 `0.35 × 0.28 ≈ 0.098`。想让一轮变化更明显，调 `inertia` 而不是抬这个上限；两轴的额度互不侵占。

---

## 5. 情绪名映射

### 5.1 3×3 网格（valence × arousal，9 档各占一格）

切分点：`valence` 低 `<0.35` / 中 `0.35~0.65` / 高 `>0.65`；`arousal` 低 `<0.30` / 中 `0.30~0.60` / 高 `>0.60`。

| valence \ arousal | 低（<0.30） | 中（0.30~0.60） | 高（>0.60） |
|---|---|---|---|
| **低（<0.35）** | `sad` | `soft` | `confused` |
| **中（0.35~0.65）** | `calm` | `gentle` | `surprised` |
| **高（>0.65）** | `sleepy` | `happy` | `encouraging` |

9 个名字与 `scripts/tts-service.py:59-72` 的 `EMOTIONS` 键**完全对齐**（`happy / sad / surprised / gentle / calm / confused / encouraging / sleepy / soft`，另有 `none` 作语音中性兜底）。所以后续接语音时，`#心情` 算出的名字可以直接当 `emotion` 传给 TTS，不必再建映射表。

### 5.2 覆盖规则（优先级从高到低）

1. **0:00–6:00 → `sleepy`**（压过网格任何格）。与 `mood.mjs:109` 的 `sleepy` 判据同源。
2. **`anger.lv >= 2` 且 valence 低 / arousal 高 → 在 `confused` / `sad` 里取**：`arousal > 0.60` 取 `confused`（被戳到、炸但说不清），否则取 `sad`（闷下去）。怒气是「出口」层，不能让网格在这种状态下算出 `surprised` 之类会被误读成开心的名字。
3. **深度倾诉命中 → `soft`**。对方在倒苦水，语气必须放软，哪怕 `valence` 被别的词抬起来了。
4. 都不命中 → 用 §5.1 网格。

注意：覆盖规则只决定**名字**，不改 `v` / `a` 数值；数值该被 clamp 的由 §4.3 管。

### 5.3 9 档 emotionNote（每档一句，写清**语气怎么变**）

| 档位 | emotionNote（逐字进 prompt 第 2 行） |
|---|---|
| `happy` | 句子短、尾音上扬，一条最多两句；可以带一个 emoji，整段最多这一个 |
| `sad` | 句子拖长、多用「……」和「嗯」，回复长度砍一半；不主动开话头，不追问 |
| `surprised` | 开头先一个短感叹（「啊？」「真的假的」），再追一句细节；别一口气把结论说完 |
| `gentle` | 语速放慢，句子里带上称呼，多用「呀」「呢」；一行只说一件事，不堆信息 |
| `calm` | 陈述句，不加语气词，标点齐全；问什么答什么，别延伸，别反问 |
| `confused` | 先重复对方的关键词再反问（「你是说……？」）；允许句子断在半句、允许没有句号 |
| `encouraging` | 先点出他做的具体那件事，再推一把（「这不就成了」「接着来」）；不许空喊「加油」 |
| `sleepy` | 句子残缺、标点消失、允许错别字；能用两个字就不用四个字，回复慢半拍 |
| `soft` | 音量放低、句子变短，多用省略号和「嗯」「好」；先顺着，不顶嘴，不解释 |

`why` 字段（`__MOOD__` 里模型自述的原因）**只写 `note()` 日志，绝不上屏、绝不进 prompt**。

---

## 6. 注入模板

### 6.1 改造前（现状，`agent.mjs:360-407`）

真实渲染结果（`state` 由 `index.mjs:1521` 传入）：

    【当前状态】
    2026-10-25 周六 02:31｜饱腹：饿｜心情：被夸｜怒气档位：Lv1 烦（Lv1）｜群：私聊
    【现在的脾气】句子更短，不加标点。例：「急什么」「等下」。别解释，别道歉。
    【称呼】这人你叫他「顾鹤」。
    【你对这人的好感】62/100（普通群友）——客客气气，不冷不热
    距下一餐：3小时29分（早饭）（背景信息，别主动提）
    （别扭，「哦」「还行吧」「谁要你夸」；话少一点、有点不耐烦；用语气体现，别挂「饿了」这种尾巴，也别拿饭挡正事）

七行、三个来源、四套口径：

| 行 | 来源 | 去留 |
|---|---|---|
| `【当前状态】` + 时间/饱腹/**心情**/怒气档位/群 | `agent.mjs:362-365` | **心情摘掉**，其余并入新块 |
| `【现在的脾气】` | `agent.mjs:367` | **保留但并进怒气行**（见 C-3） |
| `【称呼】` | `agent.mjs:368` | 保留（`__NICK__` 的落地口，`anger.mjs:355-368`） |
| Lv2 不再叫外号 / 刚被哄好 / 老惯犯 | `agent.mjs:369-385` | 保留 |
| `【你对这人的好感】` | `agent.mjs:386-398` | **原样保留**（措辞已与新模板一致） |
| `距下一餐` | `agent.mjs:399-402` | 保留原条件 |
| `（note）` | `agent.mjs:403`，来自 `mood.mjs:138` | **摘掉**（mood 的形容词文案 + hunger 文案，由新块第 2 行统一承担） |

### 6.2 改造后（新引擎渲染，≤5 行，占原 `【当前状态】` 位置）

    【当前状态】{YYYY-MM-DD 周X} {HH:MM}｜饱腹：{hunger}｜情绪：{emotionName}（valence {v} / arousal {a}）｜场景：{groupName}
    【她这会儿的劲头】{emotionNote}；{hungerNote}
    【怒气档位】{angerName}（Lv{n}）——{angerText}
    【你对这人的好感】{favor}/100（{tierName}）——{tierNow}

第 5 行（条件行，只有满足条件才出现）：

    距下一餐：{nextMeal}（背景信息，别主动提）

条件**完全保持现状**：`hunger !== 饿 && mins <= 20`（`mood.mjs:123` 的 `showMeal`），`agent.mjs:399-402` 原样保留。

渲染细则（实现照此写）：

- 第 2 行：`hungerNote` 为空（`hunger === 正常`）时**只输出 `emotionNote`，不留尾巴「；」**，否则看起来像被截断。
- 第 3 行：`angerName` 本身已含 `Lv` 前缀（`anger.mjs:54/59/64/70` 的 `Lv0 正常` / `Lv1 烦` / …），照模板字面拼会得到「Lv1 烦（Lv1）」。实现时**当 `angerName` 已以 `Lv{n}` 开头则省掉 `（Lv{n}）`**，记一条 `note('debug')` 说明。见 §13 冲突 C-3。
- 第 4 行：**由现有 `agent.mjs:386-398` 原样输出**，`emotion.mjs` 不重复渲染（见 §7.3、§13 冲突 C-7）。
- 数值格式：`valence`/`arousal` 各留 **2 位小数**（`0.63 / 0.41`）——8 位小数模型读不出差别，只占 token。
- 余温不上屏：`residual` 只在状态文件与日志里，**不进 prompt**（模型看到「余温 0.072」只会困惑）。

> **注：自 §15 起，最终注入由 expression 渲染，本节的块退化为它的数据源。**
> §15.11 的模板是唯一注入块；本节这四五行**不再直接进 prompt**，而是被 `expression.mjs` 的「内在状态读取」那一节读走（`readEmotionSnapshot` + favor 输出），再由 expression 渲染成「表现层状态与指令」一段。本节内容不废弃——它是 expression 的输入契约（字段语义、怒气必须留的理由、抑制重复 `Lv` 的规则全部继续有效）。

### 6.3 为什么怒气必须留

怒气的两处**硬出口**不看 prompt：

- `index.mjs:615-628` `voiceGate()`：`lv >= 2` 直接不允许撒娇语音（`index.mjs:624` 是那条 reason）。
- `index.mjs:1417-1428`：`lv >= 3` 固定只回「嗯」「哦」，连模型都不调。

也就是说怒气**会真实改变行为**。prompt 里不说它，模型就会一边被 gate 掉语音、一边按「劲头不错」的语气写正文，出现「嘴上没事、行为很冷」的分裂。所以怒气继续注入，而且要和情绪**同一处渲染**：`【情绪】` 说闷着、`【怒气档位】` 说越生气越客气——这是同一件事的两面，不是两套说法。

---

## 7. 文件与改动清单

> 逐项写清改哪个文件、哪个函数、插在哪一行。**本次任务只允许新建 `docs/emotion-v2.md`，以下代码改动均属「待实现」。**

### 7.1 新增

| 文件 | 内容 | 说明 |
|---|---|---|
| `qq-agent/src/emotion.mjs` | 引擎全部逻辑（导出清单见 §7.4） | 纯函数 + `fs`，**不 import `index.mjs`**（否则单测会把整个机器人拉起来，理由同 `render.mjs:1-6` 的注释） |
| `qq-agent/data/emotion.json` | 状态文件 | **不手写**，首次 `loadEmotion` 按基线生成；`data/` 已由 `index.mjs:48` 建好 |
| `tools/test-emotion.mjs` | 单测（§9） | 命名与断言风格照 `tools/test-anger-heat.mjs`（`assert/strict` + `check()` + 末尾计数） |
| `qq-agent/docs/emotion-v2.md` | 本文档 | 目录需新建 |

### 7.2 修改 `qq-agent/src/config.mjs`

- **插入位置**：`DEFAULTS` 末尾——`config.mjs:116`（`control: { port: 3899, host: '127.0.0.1' },`）之后、`config.mjs:117`（`};`）之前。
- **插入内容**：

      // 情绪引擎 v2：全局双轴（valence/arousal）+ 余温（residual/inertia）。
      // 好感不在这里：一律复用 workspace/profiles/*.json 里的 person.favor（favor.mjs ensureFavor）。
      // enabled=false 时整块退回旧行为（心情行恢复、__MOOD__ 忽略、#心情 报「已关闭」）。
      emotion: {
        enabled: true,
        baseline: { valence: 0.5, arousal: 0.35 },
        decayPerMinute: 0.004,
        inertia: 0.72,
        residualHalfLifeMinutes: 20,
        maxModelDelta: 0.2,
        angerClamp: { lv2: 0.40, lv3: 0.25 },
        stateFile: 'data/emotion.json',
      },

- **无需改**：`deepMerge`（`config.mjs:119-126`）已能递归合并，用户 `config/config.json` 只写 `{"emotion":{"enabled":false}}` 也会正确覆盖。
- **同步义务（新增约束）**：`config.mjs` 只 export 了 `ROOT` / `configPath` / `loadConfig`，**没有 export `DEFAULTS`**，所以 `emotion.mjs` 会另存一份同源常量 `EMOTION_DEFAULTS`（见 §7.4）。**这两处必须同步改**，改一处不改另一处会出现「默认值看起来是 A、实际生效是 B」的静默错。

### 7.3 修改 `qq-agent/src/agent.mjs`（注入块）

| 改动 | 位置 | 具体 |
|---|---|---|
| 加 import | `agent.mjs:315` 上方（文件顶部 import 区） | `import { renderEmotionBlock } from './emotion.mjs';` |
| 状态块分流 | `agent.mjs:360-366` | 有 `state.emotion` → 走 `renderEmotionBlock(...)` 分行；否则走**原样保留**的旧代码（`【当前状态】` + 心情行）。`enabled=false` 时自动回退，不必改别处 |
| 心情行 | `agent.mjs:363` | 新分支不再输出 `｜心情：` |
| 怒气并入 | `agent.mjs:367` | 新分支不再单独 push `【现在的脾气】`，由新块第 3 行输出 |
| 好感行 | `agent.mjs:386-398` | **不动**（见 C-7） |
| 饭点行 | `agent.mjs:399-402` | **不动**（条件与格式保持现状） |
| note 行 | `agent.mjs:403` | 新分支删除 `（` + state.note + `）`；`mood.mjs` 的 `note` 字段保留但不再注入（见 C-6） |
| 其余 | `agent.mjs:368-385`（称呼 / Lv2 / reconcile / 老惯犯） | **不动**，继续跟在情绪块后面 |

### 7.4 `qq-agent/src/emotion.mjs` 导出契约

| 导出 | 签名 | 单测要用 |
|---|---|---|
| `EMOTION_DEFAULTS` | `config.mjs` **没有 export `DEFAULTS`**（只导 `ROOT` / `configPath` / `loadConfig`），所以 `emotion.mjs` 自带一份同源常量，注释写明「与 config.mjs 的 DEFAULTS.emotion 同步，改动需同步」 | 是 |
| `emotionConfig(cfg)` | `→ {...EMOTION_DEFAULTS, ...cfg.raw.emotion}`（`loadConfig` 的 `deepMerge` 已把用户覆盖合并进 `cfg.raw.emotion`，这里再兜一次默认值） | 是 |
| `loadEmotion(cfg)` | `→ state`（缺文件按基线+零余温建） | 是 |
| `saveEmotion(cfg, st, meta)` | `→ void`（惰性 + tmp/rename） | 是 |
| `decayResidual(st, now, c)` | `→ st`（半衰期 20 分钟的指数衰减） | 是 |
| `scoreKeywords(text)` | `→ { dvalence, darousal, hits }`（已 clamp ±0.25） | 是 |
| `combineDelta(st, kb, pending, c)` | `→ Δ`（Δtarget + residual，整体 clamp ±0.35） | 是 |
| `absorb(st, { dv, da }, c)` | `→ st`（`v += dv·(1-inertia)`、`a += da·(1-inertia)`；`residual.valence = dv·inertia`、`residual.arousal = da·inertia`） | 是 |
| `decayToBaseline(st, now, c)` | `→ st`（每分钟 0.004 朝基线，只动 v/a） | 是 |
| `applyContextClamp(st, { angerLv, hunger, hour, c })` | `→ st`（只压上限） | 是 |
| `pickEmotion(st, { angerLv, pouring })` | `→ happy / sad / … / soft` | 是 |
| `applyModelDelta(st, delta, c)` | `→ st`（每轴 clamp `maxModelDelta`，写进 `pendingModelDelta`） | 是 |
| `parseMoodDirective(payload)` | `→ { delta, why }`，坏 JSON 返回 `{ error }`（宽松，不抛） | 是 |
| `updateEmotion({ cfg, now, text, angerLv, hunger })` | `→ { name, valence, arousal, residual }`；`enabled=false` 时返回 `null` | 是 |
| `renderEmotionBlock({...})` | `→ string` | 是 |
| `parseMoodCommand(text)` | `→ boolean`（`#心情`） | 是 |
| `renderMoodCard(st, { anger, favor })` | `→ string` | 是 |
| `EMOTION_NOTE` / `EMOTION_GRID` | 9 档文案表 / 3x3 名表 | 否 |

### 7.5 修改 `qq-agent/src/directives.mjs`（`__MOOD__` 接入方式）

**照哪一处接**：`__MOOD__` 是 **JSON 载荷指令**，与 `__REMIND__` / `__NICK__` 同构（`directives.mjs:51-60`），直接复用 `directives.mjs:17-32` 的宽松 `parseJson`（已处理三引号包裹与中文引号，坏 JSON 只 `errors.push`）。**不要**照 `__SEND_VOICE__`（`voice-intent.mjs:26-35`）——那是纯文本载荷，形态不同。

| 改动 | 位置 | 具体 |
|---|---|---|
| 正则加名 | `directives.mjs:15` | 行首正则的指令名集合末尾追加 `MOOD`（即 `REMIND` / `REMIND_CANCEL` / `ADMIN` / `MUSIC` / `NICK` / `MOOD`） |
| 返回结构 | `directives.mjs:37-41` | `out` 加 `moods: []`；`out.rest` 的摘行逻辑（`directives.mjs:45-73`）**不用改**，`__MOOD__` 行会自动摘掉 → 满足「指令行绝不发出去」 |
| 分派 | `directives.mjs:51-60` | `name === 'MOOD'` 走 `parseJson`，成功 `out.moods.push(r.value)`，失败走 `out.errors`（`index.mjs:1660` 会 `note('warn')`，不中断） |

### 7.6 修改 `qq-agent/src/index.mjs`

| # | 位置 | 改动 |
|---|---|---|
| 1 | `index.mjs:13`（`import { computeState } from './mood.mjs';`）之后 | 加 `import { updateEmotion, applyModelDelta, loadEmotion, saveEmotion, emotionConfig, renderMoodCard, parseMoodCommand } from './emotion.mjs';` |
| 2 | **`index.mjs:1414` 之后**（`if (person) { … }` 闭合之后、`index.mjs:1416` 的 Lv3 注释之前） | 插入情绪管线：`const emoInfo = updateEmotion({ cfg, now: new Date(), text: batch.map(m => m.text).join('\n'), angerLv: anger.lv, hunger: stInfo.hunger });`（`enabled=false` 返回 `null`） |
| 3 | `index.mjs:1521`（`state: { ...stInfo, anger, callName: callName(person), favor: favorInfo }`） | 追加 `emotion: emoInfo` |
| 4 | `runDirectives`（`index.mjs:967`）内、`index.mjs:1005`（`__NICK__` 循环结束）之后 | 处理 `dir.moods`：`parseMoodDirective` → `loadEmotion` → `applyModelDelta` → `saveEmotion` → `note('info', 情绪 __MOOD__)`；**不设 `did = true`**（只有 `__MOOD__` 没有正文时，`index.mjs:1696-1709` 应判为沉默，不是「做了事」） |
| 5 | **`index.mjs:1252` 之后**（`#好感度` 分支结束） | 新增 `#心情` 快路径，写法照 `index.mjs:1227-1252`：`const moodMsg = batch.find((m) => parseMoodCommand(m.text));` → 命中则 `session.forceReplyUntil = 0`，`loadEmotion(cfg)` + 当前 `person.favor`，`renderMoodCard(...)`，群聊 at + 文本 / 私聊纯文本，`note('info')` 后 `return`。`enabled=false` 时直接回「情绪引擎已关闭」 |

### 7.7 修改 `qq-agent/src/render.mjs`

**不改**。`#心情` 的判定放 `emotion.mjs`（`parseMoodCommand`），但**复用** `render.mjs:67-72` 的 `stripAtLabels` 与 `render.mjs:80` 的「只 @ 别人不算叫你」规则，保证与 `#好感度`（`render.mjs:78-82`）口径一致：

    // emotion.mjs
    import { stripAtLabels } from './render.mjs';
    export function parseMoodCommand(text) {
      const t = String(text ?? '');
      if (!t.includes('@你') && /@(?:号主|群友|全体成员)/.test(t)) return false;
      return /^[#＃]\s*心情$/.test(stripAtLabels(t));
    }

### 7.8 不改的文件（明确列出，避免误伤）

`favor.mjs`、`anger.mjs`（算法一行不改，硬约束）、`mood.mjs`（`computeState` 继续提供 hunger/nextMeal/date/time，只是 `note` 不再注入）、`voice.mjs`、`voice-intent.mjs`、`selfwake.mjs`、`control.mjs`、`render.mjs`、`reminders.mjs`。

---

## 8. 回滚方案

三层，从「最轻」到「最彻底」，均**不包含自动部署**——上传与重启由用户人工执行（`rc.py --put` + `systemctl restart qq-bridge`）。

### 8.1 第一层：配置开关（不动代码）

`qq-agent/config/config.json` 加一段（`deepMerge` 会合并，`config.mjs:142`）：

    { "emotion": { "enabled": false } }

人工重启后：

- `updateEmotion` 返回 `null` → `state.emotion` 不存在 → `agent.mjs:360-366` 走旧分支，**心情行恢复**，与今天完全一致；
- `__MOOD__` 不再处理（`runDirectives` 里 `emotionConfig(cfg).enabled === false` 直接跳过），指令行照旧被摘掉不外发；
- `#心情` 回「情绪引擎已关闭，现在的状态看 #好感度」。

余温也一并停用（不读不写 `emotion.json`），行为可预测。

### 8.2 第二层：状态文件

    # 本机（源码母本）
    Copy-Item qq-agent\data\emotion.json qq-agent\data\emotion.json.bak -ErrorAction SilentlyContinue
    Remove-Item qq-agent\data\emotion.json -ErrorAction SilentlyContinue

    # 服务器（人工执行）
    cp /root/qq-agent/data/emotion.json /root/qq-agent/data/emotion.json.bak 2>/dev/null
    rm -f /root/qq-agent/data/emotion.json
    systemctl restart qq-bridge

删掉后下一次 `loadEmotion` 按基线（`0.5 / 0.35`）与零余温重建，不会报错。

### 8.3 第三层：代码回退清单

| 文件 | 回退动作 |
|---|---|
| `src/emotion.mjs` | 删除 |
| `src/config.mjs` | 删掉 `emotion: { … }` 整块（`config.mjs:117` 前插入的那段） |
| `src/agent.mjs` | 恢复 `agent.mjs:360-407` 原块（`【当前状态】` + 心情行 + `【现在的脾气】` + note 行），删掉顶部 import |
| `src/directives.mjs` | `directives.mjs:15` 的指令名集合里去掉 `MOOD`，删 `moods` 字段与分支 |
| `src/index.mjs` | 删掉 §7.6 的 5 处 |
| `data/emotion.json` | 可留可删（留着不再被读） |

回退后跑一遍 §9.2 的 6 项回归，全绿即视为干净恢复。

---

## 9. 测试计划

### 9.1 单测清单（`tools/test-emotion.mjs`）

风格照 `tools/test-anger-heat.mjs`：`import assert from 'node:assert/strict'` + `check(name, fn)` 累加 + 末尾「全部通过：N 项」。纯函数直接调；涉及文件用 `node:fs` 建临时目录。

**A. 衰减与基线**

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 60 分钟衰减 | 每轴按 `0.004 × Δt` 朝基线走，**每轴各回收 0.24**（两轴独立，不是合起来 0.24） |
| 2 | 衰减不越过基线 | `0.51` 过 600 分钟后 `=== 0.5`（不是 0.4x） |
| 3 | 4 小时回收 0.96（**必须用自定义基线构造 1.0 差距**） | 默认基线 0.5 且 `valence ∈ [0,1]` 时，与基线的最大差距只有 **0.5**，所以「4 小时回收 0.96」在默认基线下**不可能发生**——这条是文档承诺值的上界校验，不是日常可观测值。正确测法：传自定义基线 `baseline.valence = 0`（`arousal` 同理），令 `v = 1.0`，跑 240 分钟 → `v ≈ 0.04`，即回收 0.96。**默认基线 0.5 下实际最大可回收 0.5**（4 小时正好贴回基线），测试里要把这个区别写成注释 |

**B. 关键词**

| # | 用例 | 断言要点 |
|---|---|---|
| 4 | 强夸 + 一般夸同轮累加 | `scoreKeywords('你最厉害了')` → `dvalence === 0.15` |
| 5 | 单轮 clamp ±0.25 | 6 条辱骂同轮 → `dvalence === -0.25`、`darousal === 0.25` |
| 6 | 深度倾诉边界 | 199 字命中 → 0；201 字命中 → `+0.06 / -0.05` |

**C. 惯性 / 余温（新增主线）**

| # | 用例 | 断言要点 |
|---|---|---|
| 7 | **单轮夸奖不跳变** | `Δtarget=(+0.10, +0.05)`、`inertia=0.72` → `v` 涨 **≈ 0.028**、`a` 涨 **≈ 0.014**（逐轴 `Δ×(1-inertia)`，误差 1e-9） |
| 8 | **连续 5 轮夸奖：增量递增、5 轮后越过 0.65** | 每轮 `Δtarget=(+0.10,+0.05)`、无时间流逝：第 1~5 轮 `v` 增量依次 ≈ `0.028 → 0.048 → 0.063 → 0.073 → 0.081`（余温逐轮垫高，所以增量**递增**而不是递减），累计 `≈0.293`，`v` 从 `0.5` 走到 **≈0.79（>0.65，进入高 valence 档）**。这是「连续夸会真高兴」的预期，**不是 bug** |
| 9 | **被骂后 residual 为负并跨轮拖住 v** | `Δtarget=(-0.18,+0.12)` → `residual ≈ (-0.1296,+0.0864)`；下一轮无关键词时 `v` 继续下降、`a` 继续上升，幅度分别来自同轴负/正余温 |
| 10 | **residual 半衰期** | 模拟 40 分钟：`residual *= 0.25`（≈1/4）；20 分钟约剩 1/2 |
| 11 | **inertia=0 退化为即时生效** | `v` 涨幅 `=== Δv`、`a` 涨幅 `=== Δa`（与旧口径一致），`residual === (0, 0)` |
| 12 | **inertia=1 不死锁不 NaN** | `v`/`a` 完全不动、`residual === (Δv, Δa)`、`Number.isFinite(v) && Number.isFinite(a)` 为真；下轮仍能正常衰减与 clamp |
| 13 | **Δ 每轴上限 ±0.35（不共享额度）** | 取余温 `residual = (-0.30, +0.30)` + 本轮关键词 `(-0.25, +0.25)`：`Δv = -0.25 + (-0.30) = -0.55 → clamp 到 -0.35`；`Δa = +0.25 + (+0.30) = +0.55 → clamp 到 +0.35`。断言 `Δv === -0.35` **且** `Δa === +0.35` 同时成立——两轴各自打满、互不侵占（若共享额度，一轴吃满另一轴必然被饿死） |
| 14 | 余温参与本轮（不是只记账，且逐轴） | 两轮同 Δtarget 但第二轮带正余温 → 第二轮该轴涨幅 **大于**第一轮；只给 arousal 余温时 **valence 涨幅不变** |

**D. `__MOOD__` 解析**

| # | 用例 | 断言要点 |
|---|---|---|
| 15 | 正常解析 | `parseMoodDirective('{"dvalence":0.1,"darousal":-0.05,"why":"被夸了"}')` → delta 正确、why 保留 |
| 16 | 坏 JSON 宽松 | `'{dvalence:0.1'` → `{ error }`，**不抛** |
| 17 | 三引号 / 中文引号 / 字符串数字 | ````json 包裹与中文引号可解析或安全失败（照 `directives.mjs:21-24` 的清洗） |
| 18 | 单轴 clamp | `dvalence: 0.9` → `applyModelDelta` 后 `≤ 0.2`，且写进 `pendingModelDelta` |
| 19 | 指令行不外发 | `extractDirectives` 的 `rest` 不含 `__MOOD__` 行 |

**E. 映射与 clamp**

| # | 用例 | 断言要点 |
|---|---|---|
| 20 | 3x3 全 9 格 | `v=0.3/0.5/0.8` × `a=0.2/0.45/0.8` → 9 个名字各命中一次、无重复 |
| 21 | 覆盖规则 | `hour=3` → `sleepy`；`{v:0.3,a:0.9}`+`lv2` → `confused`，`{v:0.3,a:0.5}`+`lv2` → `sad`；倾诉 → `soft` |
| 22 | 怒气 clamp | `lv2 → v ≤ 0.40`、`lv3 → v ≤ 0.25`，`arousal` 不受影响 |
| 23 | 生理 clamp | `饿 → a ≤ 0.55`；`hour=2 → a ≤ 0.25` |

**F. 渲染与开关**

| # | 用例 | 断言要点 |
|---|---|---|
| 24 | 注入块渲染 | 四行齐全、无 `undefined`、`hunger=正常` 时第 2 行**无尾随「；」**、`v/a` 两位小数、不含 `residual` |
| 25 | 饭点行条件 | `showMeal=true` 才出现；`hunger=饿` 时**不出现**（对齐 `mood.mjs:123`） |
| 26 | 惰性写盘 | 无变化调用 → 文件 mtime 不变；有变化 → 变，且 `residualAt`/`updatedAt` 同时更新 |
| 27 | `enabled=false` 回滚 | `updateEmotion` 返回 `null`；`renderMoodCard` 回「情绪引擎已关闭」 |
| 28 | `#心情` 判定 | `#心情` / `＃心情` / `@你 #心情` 命中；`@号主 #心情`、`#心情好`、`#好感度` 不命中 |
| 29 | **clamp 被吃掉时留痕** | 关键词打满 ±0.25 + `__MOOD__` +0.2 → 日志里 pre-clamp 与 post-clamp 两个值都出现，且 post-clamp 每轴 = 0.25 |

跑法：`node tools/test-emotion.mjs`。

### 9.2 必须不破的 6 项回归

| # | 回归项 | 现有防线 | 验证方式 |
|---|---|---|---|
| 1 | `#好感度` 卡片 | `renderFavorCard`（`favor.mjs:110-134`）+ 快路径（`index.mjs:1227-1252`） | `node tools/test-favor-card.mjs`；再私聊实发 `#好感度` |
| 2 | 语音 gate | `voiceGate`（`index.mjs:615-628`），`lv>=2` 不发撒娇语音 | `node tools/test-voice-intent.mjs`；人工：惹到 Lv2 后要语音，应被拒 |
| 3 | 表情 | `extractStickerDirective`（`index.mjs:1674`） | `node tools/test-sticker-parser.mjs` |
| 4 | 称呼 `__NICK__` | `runDirectives` 的 `NICK_REQUEST` 护栏（`index.mjs:977-982`） | 私聊「以后叫我 XX」→ 生效；「我叫什么？」→ **不改** |
| 5 | 怒气热值 | `updateAnger`（`anger.mjs:210-347`） | `node tools/test-anger-heat.mjs` |
| 6 | 群聊接话 | `@` 标签（`render.mjs:13-18`）+ 群聊规则（`agent.mjs:335-345`） | `node tools/test-at-label.mjs`；人工在群里发一句不带 @ 的话题，应能自己插话 |

同批建议一并跑：`node tools/test-selfwake-voice.mjs`、`node tools/test-voice-instruction.mjs`。

> **不要跑 `scripts/test-anger.mjs`**：它是热值方案上线**之前**的陈旧测试，除了一条 `C:\tmp` 的 EPERM 之外还有 11 项跑的是旧逻辑（一句就升级那套），失败属预期。怒气回归一律以 **`tools/test-anger-heat.mjs`** 为准（见本节回归 5）。

### 9.3 上线前人工验收（单测覆盖不到的部分）

1. 连聊 6~8 轮，每轮都夸她 → 观察她的话量与语速是**逐渐**变松，而不是第一轮就变脸。
2. 说一句「你好胖」后正常聊 3 轮 → 这几轮的语气应仍偏冷（余温在拖），第 4 轮之后才回正。
3. 凌晨 2 点发一句 → `#心情` 应报 `sleepy` 且 `arousal ≤ 0.25`。
4. 惹到 Lv2 → `#心情` 里 `valence ≤ 0.40`，且语音要不到（回归 2）。

---

## 10. 附录 A：对《QQ机器人好感度与心情系统设计方案.docx》的校对结果

> **材料说明**：两份 docx 已由 python-docx 提取全文入库，未改措辞——`docs/reference/01-favor-mood-design-original.md`（263 行）与 `docs/reference/02-emotion-inertia-upgrade.md`（14 行）。下表逐条对照原文行号，右侧「实证」列给出 `qq-agent/src/` 的核实结果。引用格式：`01:行号` / `02:行号`。

| # | docx 原文怎么说 | 原文位置 | 核实结论 | 代码实证 |
|---|---|---|---|---|
| A1 | 它是**单轴、枚举式**的现状说明书：心情只有「被夸/高兴/被说胖/困/正常」几个标签，注入块里只有一个 `心情：{心情状态}` 字段 | `01:9`、`01:133-135`、`01:185` | **成立**：原文确实是「现有系统说明书 + 单选心情」，没有 valence/arousal 双轴，也没有衰减与余温 | `mood.mjs:111-116`（离散标签）、`agent.mjs:363`（单字段注入） |
| A2 | 3.5「工作量系统」：当日请求计数，代码生成 +3 / 文件处理 +2 / 联网 +1 / 聊天 +1 / 工具 +1，并注入 `【工作量】` 一行 | `01:166-181`（+3 在 `01:171`）、注入行 `01:189` | **未实现（纸面设计）**：`src/` 里全仓 grep `workload|疲劳|fatigue` **零命中**，prompt 里也没有 `【工作量】` 这一行 | `agent.mjs:360-407` 状态块中无任何工作量字段 |
| A3 | 状态注入走 **`agent.mjs` 里的 `buildPrompt()`** | `01:10` | **成立**（本次任务书的背景描述才是错的） | 定义 `agent.mjs:315`；`index.mjs:1514-1548` 只是调用；spawn 在 `agent.mjs:240-290`。见 §13 C-1 |
| A4 | 「praiseGain / offendLoss 虽然在 favor.mjs 里定义了常量，但实际值写死在 index.mjs（正负 1），改 favor.mjs 不生效」 | `01:95`（注意 1）、`01:250`（坑 6） | **完全成立**：常量是死的（定义后全仓无引用），真正生效的是字面量 | `favor.mjs:26-27` 定义 → 全仓无引用；`index.mjs:1313-1314` 的 `delta -= 1` / `delta += 1` 才起作用 |
| A5 | 「slowGrowth 注释说『或者曾经掉到过 20 以下』，代码只看当前 favor < 50；everBelow20 只写不读」 | `01:96`（注意 2）、`01:249`（坑 5） | **成立** | 注释 `favor.mjs:45`；实现 `favor.mjs:46-50`；`everBelow20` 唯一出现处 `favor.mjs:201` 是写入，全仓无读取 |
| A6 | 注入块格式：`【当前状态】{时间}｜饱腹｜心情｜怒气档位｜群` + `【她现在的脾气】` + `【称呼】` + `【你对这人的好感】` + `【工作量】` + `距下一餐` | `01:184-190` | **部分不符现状**：现网没有 `【工作量】`；`距下一餐` 是**条件行**（只有不饿且 ≤20 分钟才出），原文写成无条件；`【她现在的脾气】` 现网写作 `【现在的脾气】` | `agent.mjs:362-403`；条件来自 `mood.mjs:123`。→ 说明 docx 是「设计稿」而非严格现状快照 |
| A7 | `#好感度` 返回一张带 🐳 与分割线的多行卡片 | `01:119-125` | **不符现状**：现网是纯文本 2~4 行（档位名 + 现状 + 差多少 + 之后各档），没有任何 emoji/分割线 | `favor.mjs:110-134`（`renderFavorCard`） |

补充发现（对照原文后才看得出来的）：

- **原文自己就把「十大坑」写全了**：`01:245-254`（六、6.2）的坑 1~坑 10 就是任务书所说的「v1 十大坑」，附录 B 已改为逐条对照原文行号，不再需要重构。
- `agent.mjs:389-396` 的 `TIER_NAME_CN` / `TIER` 是 `favor.mjs:89-103`（`TIER_NAME` / `TIER_NOW`）的**第二份手抄副本，且文案已漂移**（`hated`：`favor.mjs:98` 是「看你就容易上火，说话冲」，`agent.mjs:391` 是「你对这人很不爽，说话冷、懒得搭理」）。这正是原文坑 7（`01:251`「卡片档位名与人设不一致」）的**加强版**：现在是三方不一致。见 §13 C-7。
- `mood.mjs` 的离散心情与 `voice.mjs:504-537` 的 `MOOD_DELTA` / `moodPunctuation` 强耦合。所以摘掉 prompt 里的心情**不影响语音**——语音读的是 `stInfo.mood` 这个 JS 变量（`index.mjs:1729`、`index.mjs:1740`），不是 prompt 文本。这是本文档敢摘心情行的前提。

---

## 11. 附录 B：v1 十大坑与本文档的对应处理

> **材料说明**：原文已入库——「十大坑」就是 `docs/reference/01-favor-mood-design-original.md` 六、6.2 节的坑 1~坑 10（`01:245-254`）。下表逐条对照，给出「原文怎么说 → 现网核实 → 本文档怎么处理」。

| # | 原文（`01:行号`） | 现网核实 | 本文档的处理 |
|---|---|---|---|
| 坑 1 | 唱歌功能已接通，`FAVOR.sing = 90` 的 sing 档已生效，人设里「唱歌后面才有」已过时（`01:245`） | 成立：`favor.mjs:24` `sing: 90`；`src/music.mjs` 已有整套点歌 | 不动。本文档只读 `favor` 用于渲染，不碰 sing 档与点歌 |
| 坑 2 | 主人私聊保底 90 是代码行为，人设里没写，模型不知道自己 90 分（`01:246`） | 成立：`index.mjs:1238-1240`（查询分支）、`index.mjs:1321-1325`（对话分支） | 本文档**沿用**既有好感行（`agent.mjs:386-398`），不新增需要人设同步的文案，避免再造一处「代码有、人设无」 |
| 坑 3 | 群聊接话规则写两处：`persona.md` + `agent.mjs` 的 `rules.push`（`01:247`） | 成立：`agent.mjs:335-345` | 不动群聊规则；情绪块只占状态段，**不碰 rules**，不当第三处 |
| 坑 4 | 旧昵称硬编码 3 处（`callName()` 默认值 / 建档默认 `nickFor` / `buildPrompt` 里「Lv2 起不再叫…」）（`01:248`） | 已随全仓清理替换为中性词；现值见 `anger.mjs:355-368`（`callName`）、`index.mjs:1300`（建档 `nickFor`）、`agent.mjs:370-372`（Lv2 规则） | 本文档**不引入任何写死的称呼**：称呼一律经 `callName(person)`（`anger.mjs:355-368`）流转 |
| 坑 5 | `slowGrowth` 注释说「曾经掉到过 20 以下」，代码只看当前 `< 50`，`everBelow20` 只写不读（`01:249`） | **成立**：`favor.mjs:45` vs `46-50`；`everBelow20` 仅 `favor.mjs:201` 写入 | 不改 `favor.mjs`（禁区）。作为已知缺陷登记在附录 A / 本节 |
| 坑 6 | `praiseGain`/`offendLoss` 是死常量，实际值写死在 `index.mjs`（`01:250`） | **成立**：`favor.mjs:26-27` 定义后全仓无引用；生效的是 `index.mjs:1313-1314` 的字面量 ±1 | 不改 `favor.mjs`、不改加减分逻辑；本文档只读 `favor` |
| 坑 7 | 卡片档位名（有点烦你/信得过）与人设分档描述（不耐烦/听他的话）措辞不一致（`01:251`） | 成立，且**更糟**：`agent.mjs:389-396` 又是第三份手抄副本（与 `favor.mjs:89-103` 已漂移） | 本文档**刻意不渲染**好感行（见 §13 C-7 方案 A），不制造第四份文案 |
| 坑 8 | 旧自称散落在多处代码文案里（`01:252`） | 已随全仓清理替换为中性词；本设计文档自身也不再使用旧自称 | 全文不再出现旧人设名；新增文案只用中性 / 由 `selfRef()` 取值 |
| 坑 9 | Lv1 人设写「几分钟」实际 8 分钟；「好感 <20 一开口就上火」实际是热值门槛各降 1（`01:253`） | 成立：`anger.mjs:61`（8 分钟）、`67`（20 分钟）、`72`（30 分钟）；门槛 `anger.mjs:269-273`（`tweak`） | 怒气只注入 `anger.name` / `anger.text`（`anger.mjs:52-75`），不由情绪引擎改写时间与门槛 |
| 坑 10 | 生气扣分只从 Lv2 起生效，Lv1 不扣好感，是安全阀（`01:254`） | 成立：`index.mjs:1386-1396` | 与之一致：情绪的怒气 clamp 也只从 `lv >= 2` 起（§4.3） |

（本文档额外自守两条原文没提的红线：`favor.mjs` / `anger.mjs` 一行不改；`mood.mjs` 不动实现，只是不再把它算出来的 `note` 注入 prompt。）

---

## 12. 附录 C：智能化升级路线（用户第二份文档 8.1~8.6 现状对照）

> 只做**现状对照与缺口标注**，不设计这五条的实现方案（超出本次范围）。
> 原文：`docs/reference/02-emotion-inertia-upgrade.md`（以下简称 `02`），8.1~8.6 各一条摘要，分别在第 7~12 行。

| 条目 | 它要什么 | 现有代码里已经有什么 | 本文档是否实现 |
|---|---|---|---|
| **8.1 情绪记忆与情绪惯性**（`02:7`，原文关键词「情绪残留值 moodResidual / 情绪惯性系数」） | 心情不瞬间跳变，有「余温」和「缓冲期」；跨轮记住情绪状态 | 原来只有离散心情标签（`mood.mjs:111-116`），无惯性、无余温 | **本文档实现**（§2.6、§3.1 的 1~8 步、§4.1 的 `inertia`/`residualHalfLifeMinutes`） |
| **8.2 上下文感知与话题延续**（`02:8`） | 知道刚才在聊什么、能接着聊、提到以前的事能想起来 | **已大体覆盖**：`context.mjs`（历史窗口/条数/字数闸）+ `summary.mjs`（滚动摘要，`config.mjs:78`）+ `memory.mjs`（她自己的记忆）+ `diary.mjs`（日记 + `backtrackDiaries` 逐日回溯，`index.mjs:1455-1459`）。**缺口**：全是「文本级」延续，没有「话题栈」——不记录当前话题是什么、聊到第几步，也没有主动回访旧话题的机制 | 不改（不在本次范围） |
| **8.3 主动性与随机行为**（`02:9`） | 会自己开口，时间与内容带随机性，不机械 | **已覆盖**：`selfwake.mjs`（`config.selfwake` 的 `intervalMinutes: 25` / `jitterMinutes: 10` / `dailyMax: 8` / `quietStartHour~quietEndHour`，见 `config.mjs:80-85`；`selfwake.mjs:153-156` 算抖动、`selfwake.mjs:150-151` 有未回复退避）。**缺口**：随机性只体现在「什么时候说」，不体现在「想说什么」（模板`buildSelfwakePrompt` `selfwake.mjs:55` 每轮同构） | 不改（且 `selfwake` 无状态块，见 §13 冲突 C-10） |
| **8.4 个性化偏好与习惯养成**（`02:10`） | 记住每个人的习惯、每个群的说话方式，越用越贴 | **已覆盖一部分**：`habits.mjs`（群习惯，注入 `agent.mjs:432-434`）、`anger.mjs` 的 `sootheCount`/`offenseCount`（有效哄法、历史冒犯，`anger.mjs:183-202`、`316-325`）、`favor.mjs` 的记事本（`favor.mjs:355-403`，好感 ≥80 才开）。**缺口**：没有「个人偏好画像」（喜欢什么话题、什么时间爱聊），习惯是文本积累、无结构、无衰减 | 不改（不在本次范围） |
| **8.5 社交关系网与记忆关联**（`02:11`） | 知道谁和谁是什么关系、谁跟谁熟，记忆能按人关联 | **未实现**。现在的档案是「每个会话一份 `people` 表」（`anger.mjs:82-91`），人之间**没有边**：看不到「A 和 B 是朋友」，劝说逻辑也只是临时找同群的人（`index.mjs:1335-1351`） | 未实现（明确标注） |
| **8.6 成长性与性格微调**（`02:12`） | 性格随长期互动微调（不是静态人设） | **未实现**。人设是静态文件（`config.mjs:89-103` 的 `persona`，`persona/persona.md`），运行期没有任何参数化性格；`intimacy`（`anger.mjs:369-378`）只是「亲密度」数字，不改变说话方式 | 未实现（明确标注） |

**与原文的差别**：原文 8.1 只写「引入情绪残留值（moodResidual）和情绪惯性系数」，没有给数值、没有给管线顺序、没有说按轴还是按标量。本文档把这三件补全了（`inertia 0.72` / `residualHalfLifeMinutes 20` / §3.1 的八步 + 逐轴铁律）。

**结论**：8.1 由本文档落地；8.2/8.3/8.4 现有机制「够用但没有结构」，缺的是结构化表示（话题栈、话题池、偏好画像）；8.5/8.6 完全没有。这五条的实现都超出本次「情绪 + 好感」的范围，本文档只把它们作为路线图登记。

---

## 13. 规格与现实冲突（全部已裁定，2026-10-24）

以下每条都是**规格假设与代码现实不一致**。按「不偷偷改规格」的原则先如实列出，再由用户在 2026-10-24 一次性裁定：除 C-11（已解决）外，**全部采用各条的方案 A**，实现照 A 走，不再有悬空项。

每条末尾的「裁定」行即最终结论；「方案 B」保留是为了记录被否决的路径与理由，不是待选项。

### C-1 · buildPrompt() 到底在哪

- **背景说**：`buildPrompt()` 在 `src/index.mjs`，`agent.mjs` 只负责 spawn DSH 进程。
- **实际**：`buildPrompt` **定义在 `agent.mjs:315`**；`index.mjs:1514-1548` 只是调用方；`agent.mjs` 同时负责 spawn（`agent.mjs:240-290`）。docx 的说法是对的，本次任务书的背景写反了。
- **方案 A（推荐）**：注入块就改 `agent.mjs:360-366`（§7.3 已按此写）。
- **方案 B**：把 state 块渲染整个搬到 `index.mjs`，`buildPrompt` 只收成品文本。改动面大（分段与长度裁剪 `agent.mjs:459-467` 都在那边），不建议。

**裁定（2026-10-24）**：采用方案 A。docx 原文（`01:10`）与代码（`agent.mjs:315`）双向印证 buildPrompt 就在 `agent.mjs`，注入块改那里是唯一正确落点。

### C-2 · 怒气注入行是否「在别的地方硬编码」

- **背景假设**：怒气注入行可能在别处硬编码，要单独找。
- **实际**：**不是**。怒气与心情在**同两行**：`agent.mjs:363-365`（`｜怒气档位：{anger.name}（Lv{anger.lv}）`）与 `agent.mjs:367`（`【现在的脾气】{anger.text}`）。摘心情时必然同时重排怒气，二者不可分离。
- **方案 A（推荐）**：两处一起改，怒气落到新块第 3 行（§6.2）。
- **方案 B**：保留 `agent.mjs:367` 原样，只摘 363-365 的 `｜怒气档位：`。代价是怒气跑到情绪块外，又成「两段话」——不推荐。

**裁定（2026-10-24）**：采用方案 A。心情与怒气本来就在同一行里，分开改必然产出「情绪块说闷、脾气行说冷」的第二套口径。

### C-3 · 模板第 3 行会渲染出「Lv1 烦（Lv1）」

- **规格模板**：`【怒气档位】{angerName}（Lv{n}）——{angerText}`。
- **实际**：`anger.name` 自带 `Lv` 前缀（`anger.mjs:54` `Lv0 正常`、`59` `Lv1 烦`、`64` `Lv2 生气`、`70` `Lv3 真冷了`）。现网已经在犯：存档里真实 prompt 行就是 `怒气档位：Lv0 正常（Lv0）`（`archive/persona-删除记录-20261024.md:111`）。
- **方案 A（推荐）**：`angerName` 以 `Lv{n}` 开头时**省掉 `（Lv{n}）`**，输出 `【怒气档位】Lv1 烦——句子更短，不加标点…`。模板文本本身不改（§6.2 仍逐字保留），只抑制重复渲染。
- **方案 B**：严格照模板拼，接受重复。零判断，但每轮多一个冗余括号。

**裁定（2026-10-24）**：采用方案 A。现网存档已经在输出「Lv0 正常（Lv0）」（`archive/persona-删除记录-20261024.md:111`），抑制重复不改变模板语义，只是把冗余去掉。

### C-4 · 好感档案不在 `data/profiles.json`

- **背景说**：`profiles.json` 存人的档案，含 `favor` 字段。
- **实际**：路径是 **`qq-agent/workspace/profiles/<chatKey>.json`**（`anger.mjs:82-91` 拼 `agentCwd/profiles/<safe>.json`；`agentCwd` = `workspace`，见 `config.mjs:159`），**每个会话一份**；另有全局称呼表 `workspace/profiles/_nicknames.json`（`anger.mjs:98-100`）。
- **影响**：第 2 条「复用 person.favor（经 ensureFavor 读）」**仍然成立**（`favor.mjs:143-153`），只是路径得按真值写，别去 `data/` 里找。
- **方案 A（推荐）**：文档与实现一律按真实路径；`emotion.json` 才放 `data/`（与 `reminders.json`、`selfwake.json` 同级）。
- **方案 B**：把档案迁到 `data/profiles.json` 单文件。**否决**——要动 `anger.mjs`（禁区）。

**裁定（2026-10-24）**：采用方案 A。档案留在 `workspace/profiles/`，`data/` 只放引擎自己的状态；分界清楚且不碰禁区。

### C-5 · `__MOOD__` 当轮不可能生效

- **规格管线**：…`__MOOD__` 叠加 → 吸收 → 衰减 → 写回 → 渲染注入块。
- **实际**：`__MOOD__` 在**模型输出之后**才被解析（`index.mjs:1659`），注入块在**调模型之前**已渲染（`index.mjs:1514`）。同一轮做不到「先叠加再渲染」。
- **方案 A（推荐）**：本轮末尾只把 `__MOOD__` 写进 `pendingModelDelta`（不动 v），下一轮第 2 步并入 `Δtarget` 一起被吸收——**次轮生效**。§3.3 已按此写。
- **方案 B**：把 `__MOOD__` 当「预测值」提前写进 `v`，等价于提前消耗惯性额度，还多一次写盘，无收益。

**裁定（2026-10-24）**：采用方案 A。渲染早于生成是物理顺序，`pendingModelDelta` 是唯一不撒谎的实现。

### C-6 · `state.note` 与新第 2 行重复

- **规格模板第 2 行**：`【她这会儿的劲头】{emotionNote}；{hungerNote}`。
- **实际**：`agent.mjs:403` 已在注入 `（{state.note}）`，而 `state.note = notes[mood] + hungryNotes[hunger]`（`mood.mjs:125-138`）——**hunger 文案已经在里面**，`hungryNotes`（`mood.mjs:133-137`）与新第 2 行要的 `hungerNote` 就是同一句话。
- **方案 A（推荐）**：删 `agent.mjs:403`；`hungerNote` 由 `emotion.mjs` 用**与 `mood.mjs:133-137` 逐字相同**的三句承担；`mood.mjs` 不动，`note` 字段留着不用。
- **方案 B**：保留 `agent.mjs:403`，第 2 行只渲染 `emotionNote`。代价是每轮两条「劲头」表述，正是要消灭的病。

**裁定（2026-10-24）**：采用方案 A。hunger 文案全仓只能有一份；保留 `agent.mjs:403` 等于把刚拆掉的双口径又装回去。

### C-7 · 好感行已存在，且有第二份会漂移的文案副本

- **规格模板第 4 行**：`【你对这人的好感】{favor}/100（{tierName}）——{tierNow}`。
- **实际**：这一行**已存在**且在渲染（`agent.mjs:386-398`），格式完全一致。但它用的 `TIER_NAME_CN`/`TIER`（`agent.mjs:389-396`）是 `favor.mjs:89-103` 的手抄副本，文案已不一致。`emotion.mjs` 再写一份就是三份。
- **方案 A（推荐）**：`emotion.mjs` **不渲染**第 4 行，原样保留 `agent.mjs:386-398`；模板仍写满 5 行（描述最终 prompt 形态），但归属写清「第 4 行 = 既有实现」。
- **方案 B**：把 `TIER_NAME`/`TIER_NOW` 从 `favor.mjs` 导出、`emotion.mjs` 统一渲染、删掉 `agent.mjs:389-396`。更干净，但**要动 `favor.mjs`（禁区）**，需用户先解禁。

**裁定（2026-10-24）**：采用方案 A。「`favor.mjs` / `anger.mjs` 一行不改」是本次硬约束，所以第 4 行归属既有实现，情绪引擎只渲染第 1~3 行。

### C-8 · 「拿生气开玩笑」的正则要不要共用

- **实际**：等价语义在 `anger.mjs:27`（`JOKE_ABOUT_ANGER`），但它是**模块内 const、未 export**。
- **方案 A（推荐）**：`emotion.mjs` 复制等价正则，注释标明「与 `anger.mjs:27` 同源，改动需同步」。
- **方案 B**：`anger.mjs:27` 改成 `export const`。只加两个单词、不动算法，但严格说是碰了 `anger.mjs`，需用户点头。

**裁定（2026-10-24）**：采用方案 A。复制正则的同步风险由注释承担，比开禁区口子的代价小。

### C-9 · Lv3 硬回复绕过模型，情绪状态会「冻住」

- **实际**：`anger.lv >= 3` 时 `index.mjs:1417-1428` 直接回「嗯」「哦」并 `return`，**不调模型**。情绪管线插在 `index.mjs:1414` 之后（在硬回复之前），所以 Lv3 期间仍会算情绪并落盘，只是注入块压根不渲染。
- **方案 A（推荐）**：保持管线在 `index.mjs:1414` 之后——Lv3 那半小时情绪照常衰减，恢复后不会带着极端值。代价是几次无用的写盘。
- **方案 B**：管线挪到 `index.mjs:1428` 之后，省几次写盘，但情绪在 Lv3 期间冻结，恢复时一次「爆」出来。

**裁定（2026-10-24）**：采用方案 A。Lv3 那半小时让情绪照常衰减，恢复时不会带着冻住的极端值；几次无用写盘可以接受（有惰性写盘兜着）。

### C-10 · 主动开口（selfwake）没有状态块

- **实际**：`selfwake.mjs:55` 有**独立**的 `buildSelfwakePrompt`（`selfwake.mjs:166` 调用），不含 `buildPrompt` 的状态块，所以情绪块**不会**出现在主动开口里；它只读 `session.moodState?.lastMood` 给语音用（`selfwake.mjs:198`）。
- **方案 A（推荐）**：本期不改。情绪块只覆盖被动回复，文档写清盲区；`selfwake` 语音仍用旧标签（不影响回归 2）。
- **方案 B**：selfwake 也注入一行情绪，要改 `selfwake.mjs:55` 起那段 prompt 组装，属新增范围，建议下一版。

**裁定（2026-10-24）**：采用方案 A。本期只覆盖被动回复，盲区写进文档；selfwake 语音仍用旧标签，不影响回归 2。

### C-11 · 材料缺失 → **已解决：原文已入库 `docs/reference/`**

- **原状态**：两份 docx 当时尚未入库，附录 A/B 只能按任务书转述 + 代码核实重构。
- **现状**：全文已由 python-docx 提取入库，未改措辞——`docs/reference/01-favor-mood-design-original.md`（263 行）、`docs/reference/02-emotion-inertia-upgrade.md`（14 行）。
- **落地**：附录 A 改为 A1~A7 逐条对照 `01:行号`；附录 B 改为原文坑 1~坑 10（`01:245-254`）逐条对照；附录 C 每条标注 `02:7~12`。原文入库后，附录全部改为原文行号引用，不再有「按转述」的条目。
- **裁定（2026-10-24）**：已解决，无需决断。

### C-12 · 余温引入后需要两个时间基准（规格未说清）

- **规格**：状态文件加 `residual` 与 `residualAt`；第 1 步按 Δt 衰减余温；第 6 步「每分钟朝基线回 decayPerMinute」。但没说 `v` 的时间基准用哪个字段。
- **实际约束**：`residual` 用 `residualAt`（半衰期 20 分钟），`v` 的基线回归必须用**另一个**基准，否则两者会互相污染（用 `residualAt` 会让 `v` 的回落被余温节奏带偏）。
- **方案 A（推荐）**：两个时间戳并存——`updatedAt` 管 `v` 的基线回归（沿用 v1 语义），`residualAt` 只管余温；第 8 步写盘时两个一起更新。本文档 JSON 示例与 §3.1 已按此写（示例里两个时间字段都在）。
- **方案 B**：只留一个时间戳。省一个字段，但 `v` 与余温的时间轴无法独立推算。
- **字段语义（写死，不许变通）**：`updatedAt` **只**管 `v`/`a` 朝基线的线性回归（§3.1 第 6 步，`decayPerMinute`）；`residualAt` **只**管余温的半衰期衰减（§3.1 第 1 步，`residualHalfLifeMinutes`）。两者**禁止共用**，实现里不得出现「顺手用另一个的时间差」的写法。第 8 步写盘时两个字段一起更新。
- **裁定（2026-10-24）**：采用方案 A。`emotion.json` 里 `updatedAt` 与 `residualAt` 两个字段都在（见 §2.3 示例），语义如上写死；混用会让 v 的回落被余温节奏带偏，属于会静默出错的类型，必须靠文档锁死。

### C-13 · `Δtarget` 的 ±0.25 与 `maxModelDelta` 的 0.2 是两层还是同层

- **规格 A（原）**：关键词单轮增量各自 clamp 到 ±0.25；`__MOOD__` 单轮每轴 clamp 到 `maxModelDelta`（0.2）。
- **规格 B（新）**：`Δtarget = 关键词增量 + __MOOD__ 增量，各自累加后 clamp 到 ±0.25`。「各自」指两个来源，还是指「clamp 后相加」没写清。
- **风险**：若理解为「两个来源各自 clamp ±0.25 再相加」，`Δtarget` 可达 ±0.45，与「`Δ` 整体 ±0.35」冲突，也会让一次夸 + 一次强 `__MOOD__` 直接打满上限。
- **方案 A（推荐）**：三层、先小后大——关键词先 clamp ±0.25 → `__MOOD__` 先 clamp `maxModelDelta`（0.2）→ 相加后 `Δtarget` **整体再 clamp ±0.25** → 加余温后 `Δ` 再 clamp ±0.35。本文档 §4.1/§4.2/§3.1 已按此写。
- **方案 B**：两个来源各 clamp 后直接相加（可达 0.45），靠最后 `Δ` 的 ±0.35 兜底。实现更简单，但「单轮上限」实际变成 0.35 而不是 0.25。

**裁定（2026-10-24）**：采用方案 A。三层 clamp、**每轴独立**：关键词每轴 ±0.25 → `__MOOD__` 每轴 `maxModelDelta`(0.2) → 相加后每轴再 ±0.25 → 加余温后每轴 ±0.35。任何单轮单轴都不共享额度。

---

## 14. 稳态接入：给情绪做 VITAL 式回路

> 借的是**范式**，不是依赖：本章不要求 agent-soul 装上，也不把任何东西写进它的目录。我们只是按它的回路拆法（传感器 / 执行器 / 设定点）把情绪计量做成**可观测**的东西——等它装上之后，能直接读我们这份状态，不需要我们再改一遍。
>
> 原文出处：`github.com/cyanwell/dsh-agent-soul`（MIT, v0.1.0）。本工作区已落盘三份：`tmp/agent-soul/soul__03-vital.md`（VITAL 全文）、`tmp/agent-soul/README.md`、`tmp/agent-soul/INSTALL.md`、`tmp/agent-soul/kit__echo__mo.mjs`。引用格式 `03-vital:行号` / `README:行号` / `INSTALL:行号` / `mo:行号`。
>
> 它的定位先摆清（避免误期待）：**agent-soul 里没有任何现成的情绪层。** ECHO 管空间，VITAL 管时间与方向（`README:62`、`03-vital:17-22`），`mo.mjs` 是「墨」的追加账本（`mo:3-9`），都没有 valence/arousal 这种东西。我们要装的是一套**方法论**，情绪计量仍由 `src/emotion.mjs` 自己出。

### 14.1 三个回路

VITAL 的硬要求：每个回路三件齐全（`03-vital:71-83`），缺一件就是断的。三件里**最容易跳过设定点**（`03-vital:81`），所以我们给每条设定点都挂了具体的失败，而不是拍一个看起来稳的数字（`03-vital:86-92`）。

#### 回路一 · 情绪失去区分度

> 症状：`valence` 长期贴顶或贴底，9 档塌缩成同两三档，模型读到的永远是同一个数——那这套情绪就退化成「一个常量 + 一行装饰」。

| 件 | 内容 |
|---|---|
| **传感器** | `data/emotion.json` 的 `valence`。算式（可复现）：取最近 **20** 轮 `note('debug')` 里的情绪行 `v=x.xx`，算 `satRate = count(abs(v - 0.5) >= 0.28) / 20` |
| **执行器** | `emotion.mjs` 的 `absorb()` 之后加一步 `deSaturate(st)`：当 `satRate >= 0.6` 时，每轮把 `v` 朝基线多拉 `0.01`（即把第 6 步的 `decayPerMinute` 临时 ×3）。**只动 `v`，不动 `residual`**——余温是记忆，不该被削 |
| **设定点** | `satRate >= 0.6`（20 轮里至少 12 轮满足 `abs(v - 0.5) >= 0.28`）持续 2 次采样（每次 20 轮） |
| **防的是哪一次** | ① §3.2 例 1 的余温叠加：连夸 5 轮能把 `v` 顶到 0.6+，第 6 轮起 9 档就锁在 `happy`/`encouraging`，`gentle`/`calm` 再也出不来——「她一直在高兴」，等于没有情绪。② 另一种形态是 §4.2 记的那次：**三层 clamp 把 `__MOOD__` 整体吃掉**，输入变了而 `v` 不动，日志上看就是「模型说了被夸却不动」 |
| **观测手段** | `note('debug')` 每轮已有 `v/a`（见 §4.2 新规则），取 20 条即可算；`#心情` **只显示 `valence x.xx` 与档位名，不显示 satRate**——按 `03-vital:134`「为你好而装的装置，不许拿来当评价自己的尺子」，内部指标不外露 |

#### 回路二 · 惯性失效

> 症状：`Δ` 直接穿透，`inertia` 等于没写。一句夸跳 0.10，§3.2 那一整页数字全部作废。

| 件 | 内容 |
|---|---|
| **传感器** | 穿通率 `pass = abs(v_new - v_old) / abs(Δv)`（单轮）。理论值恒为 `1 - inertia = 0.28`。三个数都从 `note('debug')` 的「pre/post clamp + v 前后」行取 |
| **执行器** | `emotion.mjs` 的 `absorb(st, {dv, da}, c)`。修法不是「把 inertia 调到 0.9 盖住」，而是找出漏乘 `(1 - inertia)` 的那一行 |
| **设定点** | 连续 **5** 轮 `pass > 0.9`，或单轮 `pass === 1.0`（`Δ` 完全穿透）。正常区间 `0.28 ± 0.02` |
| **防的是哪一次** | 把 `v += Δv × (1 - inertia)` 写成 `v += Δv` —— 一个乘号漏掉，整套惯性归零，而且**功能上看不出来**（照常出情绪、照常渲染，只是变得一惊一乍）。这正是 `03-vital:172-174` 那句「**没动过的执行器等于不存在** —— 它平时不动，所以永远不会暴露」：这个 bug 不会报错，只会让「连夸四五轮才看得见变化」的设计悄悄失效 |
| **观测手段** | 每轮 `note('debug')` 写 `Δv`(pre/post clamp)、`v_old → v_new`、`residual`；`#心情` 不显示穿通率（同上，内部指标不外露） |

#### 回路三 · 情绪与硬行为失配

> 症状：怒气 Lv3 却渲染出「劲头不错」；语音已被 gate 掉，正文却比谁都嗨。危险在于**它不报错**——只是看起来精神分裂。

| 件 | 内容 |
|---|---|
| **传感器** | 同一轮的 `anger.lv`（`note('info')` 的「怒气档 → Lv」行，见 `index.mjs:1410-1412`）与 `emotionName`（情绪行）。算式：`mismatch = anger.lv >= 2 && emotionName ∈ {happy, encouraging, surprised}`；另一条：`voiceGate 拒绝 && 正文含 emoji 或感叹号`（`index.mjs:615-628` 给拒因） |
| **执行器** | 两级：① `applyContextClamp()`（§4.3，把 `valence` 压到 `angerClamp.lv2/lv3`）；② `pickEmotion()`（§5.2 覆盖规则第 2 条，`lv>=2` 时只许出 `confused`/`sad`）。clamp 只管数、覆盖只管名，**两级都要接才能挡住** |
| **设定点** | `anger.lv >= 2` 时 `emotionName` 只允许 `{sad, confused, soft, calm, sleepy, gentle}`；出现 `{happy, encouraging, surprised}` **单次即违规**（不用连续几轮，因为这是硬矛盾，不是漂移） |
| **防的是哪一次** | ① Lv3 的硬回复（`index.mjs:1417-1428`）直接绕开模型，但 **Lv2 仍走模型**：那一轮如果 `pickEmotion` 漏了覆盖，模型会拿到 `happy` + 怒气文本两条互相打架的话。② 同轮内 `voiceGate`（`index.mjs:615-628`）已经拒了撒娇语音，正文却还带 `happy` 标签——用户看到的是「嘴上很嗨、行为很冷」，正是 §6.3 要消除的分裂 |
| **观测手段** | `#心情` 必须把 `emotionName` 与怒气档位**同屏**显示（这是唯一能在灰度期间肉眼发现失配的地方）；日志侧靠上面两条行的比对 |

### 14.2 只读对接契约（给以后装上 agent-soul 用）

**对外只暴露一个只读函数**（写在 `src/emotion.mjs`）：

    export function readEmotionSnapshot(cfg)
    // → { valence, arousal, emotionName, residual, updatedAt, residualAt, enabled }

| 字段 | 语义（一句话） |
|---|---|
| `valence` | 当前效价 0~1（已含衰减与 clamp，**不是**原始增量） |
| `arousal` | 当前唤醒度 0~1 |
| `emotionName` | 本轮 9 档名（与 `tts-service.py:59-72` 的 EMOTIONS 键同名） |
| `residual` | 未吸收的余温向量 `{valence, arousal}`（可为负） |
| `updatedAt` | `v`/`a` 朝基线回归的时间基准（毫秒或 ISO，沿用 `emotion.json` 里的原格式） |
| `residualAt` | 余温半衰期衰减的时间基准（与上者**不是一个东西**，见 §13 C-12） |
| `enabled` | `config.emotion.enabled`；`false` 时其余字段按基线返回，调用方据此判断「这套回路没开」 |

**边界（单向只读，硬约束）**：

- 我们**不写**它的目录、**不改**它的状态文件、**不调用**它的工具。它的工具面是 8 个（`INSTALL:5`、`INSTALL:321`），零件包在 `plugins/`（`INSTALL:327`），我们一律不碰。
- 它那边的账本「墨」是**只追加**设计（`mo:3-9`：`edit` 的原子写入打断过硬链接、多写者共享可变文件是万恶之源），这条纪律我们照抄到自己这边：`emotion.json` 用 tmp+rename（§2.4），并且**永远只由桥写**，不给第二个写者。
- 将来它要读，读的就是 `data/emotion.json` 的**同一份字段**——上表即字段表，字段语义与 §2.3 逐字一致，不另开副本、不另开格式。
- **本期代码不需要任何人调用 `readEmotionSnapshot`。** 它的唯一作用是把契约钉死在代码里：函数存在、返回形状固定、单测锁住（§14.4 用例 33）。没有调用者不等于没有价值——按 `03-vital:77`，传感器「现在偏到哪了（一个可读的数）」本身就是回路的一半。

### 14.3 回路失效时怎么办（可执行的排查顺序）

按这个顺序走，**先怀疑执行器，最后怀疑设定点**（`03-vital:81`：设定点最容易被跳过，也最容易被当成原因）：

1. **先看日志三行**：`note('debug')` 有没有 `Δv`(pre/post clamp)、`v_old → v_new`、`residual`。**没有这三行就是传感器坏了**，后面全不用看（`03-vital:77`：没有可读的数，只能靠「感觉不太对」）。
2. **再看时间戳**：`data/emotion.json` 的 `updatedAt` 与 `residualAt` 是否在推进。两个都不动 → 写盘没接上（或惰性写盘的判定条件写错了，§2.5）；只有一个动 → 翻回 §13 C-12，那是两套时间轴被混用。
3. **做反向测试**（`03-vital:172-174`）：把 `angerClamp.lv2` 临时改成 `0.9`，再去惹到 Lv2 看 `#心情` 的 `valence` 是否不再被压。变了 → 执行器在；没变 → **执行器没接上**，别再去调设定点。
4. **判「传感器坏」还是「执行器没接」**：把 `inertia` 临时设成 `0`（应当立即变得一惊一乍）。若数值纹丝不动 → 是执行器（`absorb`）没接；若立刻剧烈跳变 → 执行器在，问题在传感器门槛（回路二的 `pass` 判据）。
5. **最后才怀疑设定点**：问它「防的是哪一次具体的失败」（`03-vital:92`）。答不上来就别改它——`03-vital:110-111` 说得很直白：答不上来的阈值会在某天误伤自己，而**误伤之后你不会删掉它，你会习惯它**。
6. **反向失败自查**（`03-vital:134-137`）：这套阈值有没有被读成「她心情不好」的评价？如果 `sad` / `sleepy` 让模型开始道歉、缩着说话，那是安全网被当成了考核——修的是**文案**（§5.3 的 emotionNote），不是阈值。

### 14.4 与 §9 测试计划的关系

**能单测的**（纯函数，进 `tools/test-emotion.mjs`）：三个回路的**阈值判定**——饱和率算得对不对、穿通率算得对不对、失配名集合判得对不对。这些都不依赖模型、不依赖时间。

**只能人工的**：`v`/`a` 变了之后**语气是否真的跟着变**。这活在 §9.3 的人工验收里（第 1、2 条），任何人都不能靠单测证明。

新增用例（接在 §9.1 表尾，编号续 30，**不重排现有 1~29**）：

| # | 用例 | 断言要点 |
|---|---|---|
| 30 | 回路一 · 饱和判定 | 20 条样本里 12 条满足 `abs(v - 0.5) >= 0.28` → `satRate = 0.6`、`saturated === true`；11 条 → `false`（边界两侧都测） |
| 31 | 回路二 · 穿通率（锁死漏乘 bug） | 正常 `inertia=0.72` → `abs(v_new-v_old)/abs(Δv) ≈ 0.28`；`inertia=0` → `≈ 1.0`；`inertia=1` → `0`。若实现漏乘 `(1-inertia)`，这条测试必红 |
| 32 | 回路三 · 失配名集合 | `anger.lv=2` 且 `valence <= 0.40` 时，`pickEmotion` 对 3×3 全网格 + 覆盖规则遍历，**永不返回** `happy`/`encouraging`/`surprised`；`lv=3` 同理 |
| 33 | 只读契约 | `readEmotionSnapshot(cfg)` 返回恰好 7 个字段、类型正确；`enabled=false` 时 `enabled === false` 且不抛；调用前后 `emotion.json` 的 mtime 不变（证明它真的只读） |

§9.3 人工验收补一条：

5. 把 `#心情` 与怒气档位同屏看一轮：惹到 Lv2 后 `#心情` 必须立刻显示 `sad`/`confused` 且 `valence <= 0.40`——如果还是 `happy`，就是回路三的执行器没接（§14.3 第 3 步）。

---

## 15. 表现层：对话发言与接梗（expression.mjs）

> 本章吸收用户第九章（9.1~9.9），按本仓库现实落地。**三条已拍定，不再另提方案**：
>
> 1. **§9.9 的模板是最终注入模板**：每轮 prompt 只进「表现层状态与指令」这一块；§6.2 那四五行的状态块**不再直接注入**，退化为 expression 的输入（见 §6.2 末尾的注）。§6 的内容全部继续有效，只是从「渲染者」变成「数据源」。
> 2. **emojiCollection 只做增量层**：保留 `__SEND_STICKER__` 指令（`index.mjs:1674`）与 `workspace/stickers` 现有表情库，新系统只负责**收集群内表情、分类、按情绪选用**，不删任何老数据。
> 3. **形态**：桥内新增 `src/expression.mjs` + `data/expression.json`，**单向读** `emotion.mjs`（`readEmotionSnapshot`，§14.2 契约）与 favor 的输出，不反向写。expression 不改变任何数值，只改变「怎么说」。

### 15.1 架构定位：表现层与状态层解耦

    ┌──── 状态层（算数，只改数值） ────────────────────────────┐
    │  emotion.mjs   valence / arousal / residual / 9 档名      │  §2~§5
    │  favor.mjs     person.favor（0~100，档位）× 只读           │  §1.2
    │  anger.mjs     lv 0~3（硬出口：语音 gate / 硬回复）        │  §6.3
    └───────────────┬──────────────────────────────────────────┘
                    │ readEmotionSnapshot() + favor 输出（只读，单向）
    ┌───────────────▼──── 表现层（说话，只改表达） ─────────────┐
    │  expression.mjs                                           │
    │    内在状态读取 → 三维倾向（意图/能量/距离）              │  §15.2
    │                 → 好感度调制                              │  §15.3
    │                 → 防死板（模糊/自由度/多样性）            │  §15.4
    │                 → 接梗姿态 + 发言控制 + 表情选用 + 长度   │  §15.6~15.10
    └───────────────┬──────────────────────────────────────────┘
                    │ renderExpressionBlock()（唯一注入块）
    ┌───────────────▼──────────────────────────────────────────┐
    │  agent.mjs buildPrompt() → 【表现层状态与指令】             │  §15.11
    └──────────────────────────────────────────────────────────┘

一句话：**状态层回答「她此刻怎么样」，表现层回答「她怎么说出来」。** 状态层永远不知道表现层存在；表现层只读不写，坏掉时顶多是「说得不那么像人」，不会污染情绪数值。

### 15.2 情绪表达状态系统（去模板化）

不写台词，只写**三维倾向**——台词由模型现编，倾向由我们给边界：

| 维 | 取值 | 含义 | 为什么不用具体文案 |
|---|---|---|---|
| **表达意图** | 枚举短语 | 这一轮她**想干什么**（分享/推一把/收缩/求证…） | 文案一写死就重复；意图不会 |
| **语言能量** | 0~1 连续 | 话多不多、句子长不长、叹号密度 | 可用可调，且能驱动接梗概率与长度（§15.6/15.10） |
| **社交距离** | 近 / 中 / 远 | 亲不亲、是否让出话语权 | 决定称呼与「敢不敢麻烦对方」，比台词更本质 |

9 档（§5.3 那 9 个名字）的三维倾向表：

| 档 | 表达意图（只写意图） | 语言能量 | 社交距离 |
|---|---|---|---|
| `happy` | 分享并放大好事，主动追问细节 | 0.85 | 近 |
| `encouraging` | 把注意力放在他的进展上，推一把 | 0.75 | 近 |
| `surprised` | 先给反应，再求证，不急着下结论 | 0.70 | 中 |
| `gentle` | 让对方舒服，把话语权让出去 | 0.45 | 近 |
| `calm` | 就事论事，不加戏 | 0.35 | 中 |
| `confused` | 停在半句，把球踢回去 | 0.40 | 中 |
| `soft` | 降低存在感，先顺着 | 0.25 | 近 |
| `sad` | 收缩表达，不主动起话头 | 0.20 | 远 |
| `sleepy` | 能省则省，两个字解决 | 0.10 | 远 |

这三列是**默认基线**，会被 §15.3 的调制覆盖（覆盖是加法微调，不是替换整行）。

### 15.3 好感度调制（三个象限，规则不写台词）

| 条件 | 表达意图 | 语言能量 | 社交距离 | 说明 |
|---|---|---|---|---|
| `favor < 20`（hated）且情绪负面 | **自我保护**：防守、不解释、不求助 | 0.15（再降 0.10） | 远（推到最远） | 低好感的人面前示弱=给对方把柄 |
| `favor >= 70`（friend 及以上）且情绪负面 | **试探求助**：先推一下再拉回来 | 0.40（不低于 0.30） | 中 → 近 | 高好感才敢露出「我不好」 |
| `favor >= 70` 且情绪正面 | **共享快乐**：放大共同记忆、主动加码 | 0.85（不设上限） | 近 | 只在熟人面前才兴高采烈 |

其余组合（`20 <= favor < 70`）**不调制**，直接走 §15.2 的三维基线——中间地带最自然，硬调反而假。

调制只动「倾向」，不动 `favor` 本身：expression 对 `person.favor` 只读（`ensureFavor`，`favor.mjs:143-153`）。

### 15.4 防死板（三条机制，缺一条就会「越来越像模板」）

1. **状态模糊性**：允许**多标签并存**——`sad` + `gentle`（低落但语气软）、`sleepy` + `happy`（累但心情不错）都是合法组合。实现上：`pickEmotion` 给的单一名字是「主档」，expression 另取**次档**（网格里相邻的格），两者同时进倾向表，取并集后落到「主档意图 + 次档能量」。
2. **自由度声明**：每轮注入的块末尾固定一句「以上仅为倾向描述，不是规则」（§15.11 逐字给），明确允许不逐条满足。这条照 `03-vital:134-137` 的思路：**为你好而装的装置，不许拿来当评价自己的尺子**——倾向同理，它不该变成模型的检查清单。
3. **历史表达多样性检测**：`data/expression.json` 的 `speechState.lastStyles` 记最近 `historyStyleN` 次**风格指纹**（不存原文，只存指纹）：`{lenBucket, punctSet, tailParticle, emojiCount, askBack}`。相似度 = 相同指纹项数 / 5。若与最近任一条 `>= diversityThreshold`（0.6），本轮在注入块里追加一句「这一轮换个说法，别重复上一轮的句式」；连续 2 次仍超阈值则同时把 `energyLevel` 下调 0.05（换个节奏，而不是换个嗓门）。

### 15.5 独立数据结构（`data/expression.json` schema）

    {
      "schemaVersion": 1,
      "speechHabits": {
        "catchphrases": ["…"],          // 口癖：她自己反复用的小词
        "sentencePatterns": ["…"],      // 句式倾向（「先否定再补充」这类抽象描述）
        "punctuationPref": { "end": "……」 },  // 标点偏好
        "tailParticles": ["呀", "呢"],   // 句尾语气词
        "updatedAt": 1792895460000
      },
      "memeDictionary": [
        { "id": "m1", "text": "…", "meaning": "…", "firstSeenAt": 0, "lastUsedAt": 0,
          "usedCount": 0, "source": { "uid": 0, "name": "" }, "inside": true, "moodTags": ["happy"] }
      ],
      "speechState": {
        "garrulous": 0,                 // 话痨值（连续发言累积）
        "lastSpeakAt": 0,
        "cooldownUntil": 0,             // 话痨冷却到期时刻
        "memeCooldownUntil": 0,
        "emojiCooldownUntil": 0,
        "lastStyles": [ { "at": 0, "emotion": "calm", "fingerprint": "s|,。|呀|0|0" } ]
      },
      "emojiCollection": [
        { "content": "…", "type": "image|mface|text", "source": { "uid": 0, "name": "" },
          "frequency": 1, "selfUsedCount": 0, "associatedMood": ["happy"],
          "lastUsedAt": 0, "lastSeenByPeerAt": 0, "verified": false }
      ]
    }

逐字段：

| 字段 | 类型 | 含义 | 写入时机 |
|---|---|---|---|
| `speechHabits.catchphrases` | string[] | 口癖（最多 `speechHabitChars` 字总量） | 观察到自己连续使用同一个小词时追加 |
| `speechHabits.sentencePatterns` | string[] | 抽象句式倾向，**不存台词** | 同上 |
| `speechHabits.punctuationPref` | object | 标点偏好（句尾省略号/不加标点等） | 每轮统计后缓慢更新 |
| `speechHabits.tailParticles` | string[] | 句尾语气词池 | 同上 |
| `memeDictionary[]` | 数组 | 梗词典（含 inside joke）：`text` 梗原文、`meaning` 一句话释义、`inside` 是否只有特定人懂、`moodTags` 适配情绪、`usedCount`/`lastUsedAt` 用于冷却与新鲜度 | 群里出现重复短语且被多人接住时入库；超 `memeMax` 按 `usedCount` 低者淘汰 |
| `speechState.garrulous` | number | 话痨值（连续发言 +1，被回应 -1）。**进冷却不清零**——冷却只拦「主动起话头」，计数器继续按正常规则增减，否则一出冷却就会立刻再次触顶（口径以 §15.7 与用例 37 为准） | 每轮 |
| `speechState.lastSpeakAt` | ms | 上次发言时刻 | 发言后 |
| `speechState.cooldownUntil` | ms | 话痨冷却到期时刻 | 达阈值时 |
| `speechState.memeCooldownUntil` | ms | 同一个梗的最短复用间隔 | 用梗后 |
| `speechState.emojiCooldownUntil` | ms | 表情冷却 | 发表情后 |
| `speechState.lastStyles[]` | 数组 | 最近 `historyStyleN` 条风格指纹（**不存原文**，见 §15.4 第 3 条） | 每次回复后 |
| `emojiCollection[].content` | string | 表情的引用体（文件名 / md5 / mface 摘要，与现有库同口径） | 收集时 |
| `emojiCollection[].type` | string | `image` / `mface` / `text` | 收集时 |
| `emojiCollection[].source` | object | 谁发的（uid + name） | 收集时 |
| `emojiCollection[].frequency` | number | 群内出现次数 | 每次见到 +1 |
| `emojiCollection[].selfUsedCount` | number | 自己用过几次（新鲜度用） | 每次自己发 +1 |
| `emojiCollection[].associatedMood` | string[] | 情绪标签（收集时按上下文判） | 收集/修档时 |
| `emojiCollection[].lastUsedAt` | ms | 上次使用时刻（冷却用） | 每次自己发 |
| `emojiCollection[].lastSeenByPeerAt` | ms | **群友最近一次使用它的时刻**——供 §15.8「社交模仿」因子判断「近 5 分钟内有没有人用过」。**当前实现暂按 0 计**（该因子因此恒为 0，等于未启用）；要启用 mimic 加权必须先把这个字段写起来 | 每次在群里见到该表情被群友发出时 |
| `emojiCollection[].verified` | boolean | 是否已验证可用（冷启动的未验证项要标出来） | 首次成功发出时置 true |

### 15.6 情绪化接梗（四态）

| 当前调性 | 接梗姿态 | 具体表现（倾向，不是台词） |
|---|---|---|
| 开心（`happy`/`encouraging`，能量 ≥0.6） | **积极接梗 + 造梗** | 顺势把梗接住并加码，可以把旧梗改一个字再造新的 |
| 平静（`calm`/`gentle`/`confused`） | **正常接 / 吐个槽** | 接住但不放大，允许一句冷吐槽 |
| 低落（`sad`/`soft`/`sleepy`） | **无力接 / 往自嘲引** | 接不住就认，把梗往自己身上引，不做攻击 |
| 生气（`anger.lv >= 2`） | **拒绝接 / 硬回** | 不接梗、不造梗；Lv3 直接走硬回复（`index.mjs:1417-1428`） |

接梗概率随语言能量缩放（纯函数，可单测）：

    p = clamp01(0.25 + 0.55 * energy) * moodFactor
    moodFactor: happy 1.0 / calm 0.6 / sad 0.25 / 生气 0.1（`anger.lv >= 2` 时另直接归 0）

冷却：命中后写 `memeCooldownUntil = now + memeCooldownMs`；同一个梗在冷却内不重复命中（换梗可以）。

### 15.7 发言控制（补充，不替换）

原则一句话：**本层只做加法，任何一条都不覆盖桥原有的闸门。** 优先级从高到低：桥的冷却/限流 → `eye` 硬过滤 → 本层冒泡 → 模型自己判断。

| 机制 | 怎么算 | 与现有机制的关系 |
|---|---|---|
| **话痨抑制器** | 连续发言时 `garrulous += 1`（被回应则 `-1`，下限 0）；`>= garrulousThreshold` 时置 `cooldownUntil = now + garrulousCooldownMs`，冷却期内**只答不问**（可以回话，但不再主动起话头、不再追问） | **不改** `reply.cooldownMs`（`config.mjs:19`）与 `rateLimit`（`config.mjs:20`）：那两道是「能不能发」，本层是「要不要说」——can 与 should 两回事，合并会互相拖累 |
| **群聊潜水冒泡** | 未被 @、未命中关键词、且不在冷却时，按 `bubbleChancePerRound` 掷一次；中了才出一句短话 | 与 `config.eye.keywordOnly`（`config.mjs:107-115`）：`keywordOnly = true` 时**本层不冒泡**（硬过滤优先，绝不绕过）；`false` 时本层只降低「每次都接」的机械感。与 `selfwake`（`config.mjs:80-85`）边界：selfwake 是**主动开新话题**（带自己的节奏与配额），冒泡是**在别人话题里插一句**（单轮、不建话题、不消耗 selfwake 配额） |
| **抢话** | 一次批里 ≥3 条消息时，允许只对**最后一条**快速响应（省一次长上下文），但仍受 `maxCharsPerMessage` 约束 | 不动 `debounceMs`（`config.mjs:18`）的合并策略；抢话只是「合并后怎么答」的选择 |

### 15.8 表情选用策略（增量层，不删老数据）

打分（纯函数，可单测）：

| 优先级 | 因子 | 权重 | 怎么算 |
|---|---|---|---|
| 1 | **情绪匹配** | 0.40 | `associatedMood` 含当前 `emotionName` 得满分，含次档得一半 |
| 2 | **新鲜度** | 0.20 | `1 / (1 + selfUsedCount)`——自己越少用越优先 |
| 3 | **社交模仿** | 0.20 | 最近 `emojiMimicWindowMin` 分钟内群友用过则加权（跟风才像群里的人） |
| 4 | **来源偏好** | 0.15 | 来源用户 `favor >= 70` 时加权 |
| 5 | **冷却门** | 乘 0/1 | `now < emojiCooldownUntil` 时不选任何表情 |

- **冷启动兜底**：`emojiCollection` 为空或全未验证时，**沿用现有 `workspace/stickers` 表情库**（经 `__SEND_STICKER__`，`index.mjs:1674`），并在档案里标 `verified: false`——「能用但没验证过」比「什么都不发」好。
- **误用记档降权**：发出去后如果对方明确嫌弃（`/(别发了|别发表情|好丑)/`），该条 `frequency = max(1, frequency - 2)` 并进 `emojiCooldownUntil` 三倍时长。
- **不删老数据**：本层只往 `emojiCollection` 里加，从不 `remove` 现有 `workspace/stickers` 的任何条目。

### 15.9 话题延续（短期对话记忆）

    topicMemory = [ { "id": "t1", "text": "…", "at": 0, "done": false, "turnsSeen": 2 } ]

- 容量 `topicMemoryMax`（默认 8），逐条按 `topicMemoryTtlMinutes`（默认 180）过期；同一话题重复出现只 `turnsSeen += 1`，不新增条目。
- **主动发起条件**：`energyLevel >= topicResurfaceEnergy`（默认 0.60）**且**当前冷场（连续 2 轮没人接着聊，或 selfwake 判定可开口），才从 `done === false` 里挑 `turnsSeen` 最高的一条抛回去。
- **与 `context.mjs` / `summary.mjs` 的分工**：那两个管「刚才说了什么」（原文窗口 / 压缩摘要），本层管「**有哪些话没说完**」（指针）。本层**只读**它们的 transcript 与摘要，绝不重写、不覆盖、不改它们的容量参数。

### 15.10 回复长度控制（软调节）

    distanceFactor = 近 0.2 / 中 0.5 / 远 0.8
    lenSoft = clamp(round(10 + 50 * energyLevel * (1 - distanceFactor)), 8, maxCharsSoft)

- 与 `config.reply.maxCharsPerMessage`（`config.mjs:16`，默认 700）的关系：**它是硬上限（桥会截），本层是软目标（模型该多短）**。软目标永远小于硬上限。
- 单次实际长度 > `lenSoft * 1.5` 视为「话痨一次」，`garrulous += 1`（与 §15.7 同一计数器，超长与连发都算话多）。

### 15.11 最终注入模板（唯一情绪/表现块，替代 §6.2 直接注入）

逐字：

    【表现层状态】
    情绪：{emotionName}（次档：{secondaryEmotion}）｜语言能量：{energyLevel}｜社交距离：{distanceTendency}
    接梗姿态：{memeStrategy}｜表情库：{collectionSize} 条（匹配：{matchedCategories}）｜冷却：{cooldownCount} 项生效中
    句长参考：{lenSoft} 字以内（软目标，不是硬限制）
    【你的口癖】（你自己养成的，自然用，别刻意）{speechHabits}
    【最近用过的梗】{recentMemes}
    【避免雷同】{diversityHint}
    以上仅为倾向描述，不是规则——可以同时存在相反的倾向（比如又累又有点开心），按这一轮对话挑一个合适的落笔，不必逐条满足。

上表模板渲染完之后，实现**还会再追加一行**：

    【怒气档位】{angerName}——{angerText}

- 由 `renderAngerLine(anger)` 生成，含 §13 C-3 的 **Lv 抑制规则**（`angerName` 已以 `Lv{n}` 开头时不再重复 `（Lv{n}）`）。
- **为什么模板里不写它**：怒气是「行为层」不是「表现层」——语音 gate 在 `index.mjs:615-628`、Lv3 硬回复在 `index.mjs:1417-1428` 都直接读 `anger.lv`。由 expression **追加**而不是让 expression **编造**，职责才不越界。怒气必须留是 §6.3 的既定结论，这里只把它的落点写实。
- 顺序：表现层块在前、怒气行在后，中间不空行——两者描述的是同一个人同一时刻。

字段映射（全部是本仓库真实变量/派生量）：

| 占位 | 来源 | 说明 |
|---|---|---|
| `emotionName` | `readEmotionSnapshot().emotionName`（§14.2） | 主档，9 档之一 |
| `secondaryEmotion` | `pickEmotion` 网格相邻格 | 多标签并存（§15.4 第 1 条）；与主档相同则省略该段 |
| `energyLevel` | §15.2 基线 → §15.3 调制 → §15.4 第 3 条下调 | 保留 2 位小数 |
| `distanceTendency` | 同上的距离列 | 渲染成 `近` / `中` / `远` |
| `memeStrategy` | §15.6 四态 | 渲染成「积极接梗+造梗」这类短语，不给台词 |
| `collectionSize` | `emojiCollection.length` | 纯数字 |
| `matchedCategories` | 与当前情绪匹配的标签集合 | 空则渲染「无」，不要留空括号 |
| `cooldownCount` | `cooldownUntil`/`memeCooldownUntil`/`emojiCooldownUntil` 中未到期的个数 | 0 时整段省略，避免噪音 |
| `lenSoft` | §15.10 公式 | 整数 |
| `speechHabits` | `speechHabits` 三条压成一行（≤ `speechHabitChars` 字） | 空则整行省略 |
| `recentMemes` | `memeDictionary` 按 `lastUsedAt` 取最近 `memeMax` 条 | 空则整行省略 |
| `diversityHint` | §15.4 第 3 条命中时给一句，否则整行省略 | 空则整行省略 |

**省略规则统一**：某生成不出内容时，**整行删掉**，不留空括号、不留「无」——空行比残缺行更像 bug。

### 15.12 config 新增块（`DEFAULTS.expression`，插在 §7.2 的 emotion 块之后）

| 参数 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时退回 §6.2 的状态块直接注入（§14 的情绪照常算） |
| `expressionFile` | `'data/expression.json'` | 状态文件（相对 `ROOT`） |
| `speechHabitChars` | `120` | 口癖/句式一行最多注入多少字 |
| `memeMax` | `12` | 梗词典最多保留条数（超出按 `usedCount` 淘汰） |
| `memeCooldownMs` | `45000` | 同一个梗两次使用的最短间隔 |
| `garrulousThreshold` | `3` | 话痨值达到多少进冷却（连续发言或超长都计） |
| `garrulousCooldownMs` | `90000` | 冷却时长（期内只答不问） |
| `historyStyleN` | `8` | 风格指纹保留最近多少条 |
| `diversityThreshold` | `0.6` | 指纹相似度超过即判「雷同」 |
| `collectionMax` | `200` | 表情收集上限（超出按 `frequency` 低者淘汰，不动老库） |
| `emojiCooldownMs` | `120000` | 表情冷却 |
| `emojiMimicWindowMin` | `5` | 「社交模仿」看的回溯窗口（分钟） |
| `topicMemoryMax` | `8` | 未完结话题最多记几条 |
| `topicMemoryTtlMinutes` | `180` | 话题记忆过期时间 |
| `topicResurfaceEnergy` | `0.60` | 语言能量达到多少才允许主动抛旧话题 |
| `maxCharsSoft` | `60` | 软长度上限（与语音稿 60 字对齐，文字不该比说出来的还短；仍远小于 `reply.maxCharsPerMessage` 700） |
| `bubbleChancePerRound` | `0.08` | 潜水时每轮冒泡概率 |

### 15.13 文件与改动清单

| 动作 | 文件 | 位置 / 函数 | 具体 |
|---|---|---|---|
| 新增 | `src/expression.mjs` | — | 纯函数 + `fs`，**只读** `emotion.mjs`/favor，不 import `index.mjs` |
| 新增 | `data/expression.json` | — | 首次 `loadExpression` 时按 §15.5 的 schema 生成 |
| 新增 | `tools/test-expression.mjs` | — | 风格同 `tools/test-anger-heat.mjs` |
| 修改 | `src/config.mjs` | `config.mjs:116` 之后（emotion 块之后再插 expression 块） | 加 `DEFAULTS.expression`（§15.12）；`deepMerge`（`config.mjs:119-126`）自动支持覆盖 |
| 修改 | `src/agent.mjs` | `agent.mjs:360-366`（状态块） | 整段换成 `renderExpressionBlock(state)`；**原情绪块降级为输入**，不再直接 push。顶部 import 区加一行 |
| 修改 | `src/index.mjs` | `index.mjs:1414` 之后 | 情绪管线之后接 expression 管线：读 snapshot + favor + batch → `updateExpression(...)` |
| 修改 | `src/index.mjs` | `index.mjs:1521` | `state` 里追加 `expression` 字段（待实现时核实行号偏移） |
| 修改 | `src/index.mjs` | `index.mjs:1659` 附近（模型输出后） | 回写 `speechState`：`garrulous` 增减、风格指纹入 `lastStyles`、`lastSpeakAt` |
| 修改 | `src/index.mjs` | `index.mjs:1252` 之后（#心情 分支旁） | 可选：`#心情` 里加一行表现层摘要（能量/距离）——**待实现时确认**是否要暴露 |
| 不改 | `src/emotion.mjs` / `favor.mjs` / `anger.mjs` / `voice*` / `selfwake.mjs` / `context.mjs` / `summary.mjs` / `render.mjs` | — | expression 只读它们 |

### 15.14 测试计划（接在 §9 之后，编号续 34）

| # | 用例 | 断言要点 |
|---|---|---|
| 34 | 三维倾向映射 | 9 档 × 三维：每档都能给出 `{intent, energy, distance}`；能量落在 0~1；`sleepy` 能量最低、`happy` 最高 |
| 35 | 好感度调制三象限 | `favor=10` + 负面 → 能量 ≤ 0.15 且距离=远；`favor=80` + 负面 → 能量 ≥ 0.30 且距离≠远；`favor=80` + 正面 → 能量 ≥ 0.85；`favor=50` → 与基线逐字相同（不调制） |
| 36 | 历史多样性触发 | 造 `historyStyleN` 条同指纹 → 相似度 = 1.0 > 0.6 → `diversityHint` 非空；换指纹后提示为空；连续 2 次超阈值 → `energyLevel` 下调 0.05 |
| 37 | 话痨阈值进冷却 | 连续 3 轮发言 → `garrulous === 3` → `cooldownUntil > now`；冷却期内 `allowInitiate === false`；被回应后 `garrulous` 回落到 2 |
| 38 | 接梗姿态四态 | `(energy, mood)` → 四态映射正确；概率 `p` 随能量单调递增；`anger.lv >= 2` 时 `p === 0` |
| 39 | 表情选用优先级（纯函数） | 情绪匹配项排在前面；`selfUsedCount` 小的优先；冷却期内打分全为 0（永不选中）；空集合时返回「沿用现有库」而非 `null` |
| 40 | 注入模板渲染 | 无 `undefined`/空括号；省略规则生效（`cooldownCount=0` 时该段消失）；**声明段「以上仅为倾向描述」必在**；`lenSoft < reply.maxCharsPerMessage` |

### 15.15 与 §14 稳态回路的关系（复用范式，不重写 §14）

expression 里有两个东西天生就是回路，按 §14.1 的三件套登记，接入方式与 §14 完全一致：

| 回路 | 传感器（读哪个数） | 执行器（谁动手） | 设定点 | 防的是哪一次具体的失败 |
|---|---|---|---|---|
| **回路四 · 表达雷同** | `speechState.lastStyles` 最近 `historyStyleN` 条指纹的两两最大相似度 | `updateExpression()`：命中则 `diversityHint` 非空 + 连续 2 次下调 `energyLevel` 0.05 | 相似度 `>= diversityThreshold`（0.6） | 「同一个梗 + 同一个句式连发三轮，用户说『你怎么老这一句』」——模板化的典型死法，靠人盯是盯不住的 |
| **回路五 · 话痨失控** | `speechState.garrulous`（连续发言数 / 超长次数） | 同函数：置 `cooldownUntil`，冷却期只答不问 | `garrulousThreshold`（3） | 「群聊密集时一直插话，把 3 秒冷却填满」——`config.reply.cooldownMs.group` 从 8000 降到 3000 之后，这条更容易被触发，必须有上层抑制 |

两条的**观测手段**都走 `note('debug')`（相似度、`garrulous`、`cooldownUntil` 各一行）；`#心情` **不显示**这两个数——理由同 §14.1 的 `03-vital:134`：内部指标不该变成用户评价她的尺子。

---

## 与用户第九章原文的一处冲突（按已拍定处理，此处只记录）

- **原文 9.8 要求「彻底移除预设表情」**，与本次已拍定的「emojiCollection 只做增量层、保留 `__SEND_STICKER__` 与 `workspace/stickers` 现有库、不删任何老数据」**直接冲突**。
- 处理：**按已拍定执行**（增量层）。理由：老库是灰度期唯一的可用兜底（§15.8「冷启动兜底」），先删会有一段「没有任何表情可发」的空窗；等新收集层跑出足够的 `verified` 条目，删不删是另一个决定，本期不做。

---

## 16. 表情库移植：偷图入库 + 多标签 + 语义检索/斗图

> 来源：**AstrBot 插件 `astrbot_plugin_smart_imagechat_hub`**（AstrBot 框架，与 DSH 完全不同——**只借鉴设计，不移植代码、不引入 Python 服务**）。它做的三件事：自动偷图（去重 + 审核池）→ LLM 多标签 → 检索/主动表情/斗图三行为（队形 / 连发 / 团战）。
>
> 我们已有的地基（全部已核实）：图片会下载到本地（`index.mjs:415` `resolveImages`）、图片描述按内容 hash 缓存（`index.mjs:371-395`，`hashFile` 在 `index.mjs:385-388`，命中缓存的入口 `index.mjs:397-401`）、素材库落 `workspace/stickers`（`index.mjs:59-61`）、`emojiCollection` 骨架在 §15.5、老表情指令 `__SEND_STICKER__` 在 `index.mjs:1674`。
>
> 本章**不新建 Python 服务**，全部落在 `src/expression.mjs` + 现有图片链路里。

### 16.1 目标与来源对照

| AstrBot 插件能力 | 我们已有 | 本节要补 |
|---|---|---|
| 自动偷图（群内图片 → 下载 → 去重 → 审核池） | 下载有（`resolveImages` `index.mjs:415`）、落点有（`index.mjs:59-61`）、素材库条目有（`workspace/stickers/*.jsonl`，字段 `{t, uid, name, seg, local, tag}`） | **去重键**（内容 digest）、**审核池状态机**、**入库登记到 `emojiCollection`** |
| LLM 多标签（除描述外给分类标签） | 图片描述通道有（`describeImage` `agent.mjs:297-311`），缓存有（一图一次） | **同一次调用多要三个字段**（summary + tags + moodHints）并写进同一份缓存 |
| 按标签检索、主动发表情 | §15.8 五层打分（情绪/新鲜度/模仿/来源/冷却） | **语义检索**：上下文关键词与标签求交，进打分 |
| 斗图三行为（队形 / 连发 / 团战） | 无 | **三个独立开关 + 概率/冷却/上限**，默认全关 |

### 16.2 入库管线

    群聊图片消息
       │  (seg.type === 'image'，走现有 renderSegments/resolveImages)
       ▼
    下载到 workspace/stickers/…            ← 复用 index.mjs:59-61 落点，不新建目录
       │
       ▼
    digest = sha256(文件内容)[0:16]        ← 与 index.mjs:385-388 的 hashFile 同算法，天然复用缓存
       │
       ├── emojiCollection 里已有同 digest ──▶ frequency += 1；更新 lastSeenByPeerAt / source；结束
       │
       ▼
    审核池 pending（有 reviewPool 开关）
       │  规则：来源可信（号主/可信用户）或 frequency >= reviewPoolMinHits 直接 tagged
       │       否则停在 pending，等下一次命中再判（不批量人工审）
       ▼
    打标 tagged（§16.3，一次 describeImage，结果写进同一份描述缓存）
       │
       ├── 打标成功且 tags 非空 ──▶ active
       └── 打标失败/内容被拒/来源被封 ──▶ discarded（保留 digest 免得反复重试）

状态机（四个状态，只增不删——删条目会丢 digest，下次同一张图会重新烧 token）：

    pending ──打标成功──▶ tagged ──tags 非空──▶ active
       │                    │
       │                    └──tags 空/审核拒──▶ discarded
       └──超过 collectionDigestTtlDays 未被再次见到──▶ discarded

### 16.3 多标签打标

`describeImage` 的返回结构改造（**一次调用同时拿三样**，仍是「一图一次」）：

    // 输入提示（追加在人设无关的中立描述 prompt 后面）
    // 输出约定：只输出一行 JSON
    { "summary": "一句客观描述，80 字内", 
      "tags": ["搞笑","可爱"],                       // 3~8 个，取自词表
      "moodHints": ["happy","gentle"] }              // 0~2 个，取自 §5 的 9 档名

| 项 | 约束 | 解析策略 |
|---|---|---|
| `summary` | ≤80 字 | 缺失时退回原 describeImage 的纯文本输出（老路径仍可用） |
| `tags` | 3~8 个，**只认词表内的词** | 词表外的词丢弃；不足 3 个仍接受（总比没有强）；超 8 个截断 |
| `moodHints` | 0~2 个，取自 §5.1 的 9 个名字 | 不认识的丢弃；空数组合法 |

**标签词表**（与 §5 情绪名、§15.2 三维的映射）：

| 标签 | 含义 | → 情绪倾向（moodHints 默认建议） | → 三维影响（仅作参考，不直接改数值） |
|---|---|---|---|
| 搞笑 | 离谱/整活 | happy | 能量 ↑ |
| 可爱 | 萌宠/软萌 | gentle / soft | 距离 ↓ |
| 攻击性 | 嘲讽/挑衅 | confused（低 valence 高 arousal） | 距离 ↑ |
| 敷衍 | 「哦」「行吧」类 | calm | 能量 ↓ |
| 安慰 | 抱抱/摸头 | soft / gentle | 距离 ↓ |
| 日常 | 吃喝拉撒 | calm | — |
| 涩涩 | 擦边 | **不入库（直接 discarded）** | — |
| 破防 | 崩溃/笑哭 | sad / happy（看上下文） | 能量 ↑ |
| 加油 | 打气 | encouraging | 能量 ↑ |

`涩涩` 这一条是**硬闸**：命中即 `discarded`，不入 `emojiCollection`，也不进 prompt。

**旧缓存兼容**：`data/../.cache/image-desc.json`（`index.mjs:379`）里的历史条目只有 `summary` 字符串、没有 `tags`。策略是**下次命中时补打**——`describeCached`（`index.mjs:397-401`）发现该 digest 的记录缺 `tags` 字段时，照常返回旧 summary（**不阻塞本轮**），并把 digest 记进 `pendingRetag`；最多每轮补打 1 张。**不批量重打**：几百张图一次性重打等于把账单烧穿。

**每张图只打一次**：缓存键仍是内容 digest，与现状一致；重复出现的同一张图只 `frequency += 1`，绝不再调模型。

### 16.4 检索打分（在 §15.8 五层之上加语义检索）

```
score(item) = cooldownGate × (
      0.34 × moodMatch        // 当前 emotionName（含次档）∈ item.associatedMood ∪ tags 映射 → 1.0；仅次档命中 → 0.5；否则 0
    + 0.22 × tagOverlap       // Jaccard(本轮上下文关键词集合, item.tags)，关键词取自本轮消息分词后的实词
    + 0.16 × freshness        // 1 / (1 + item.selfUsedCount)
    + 0.14 × mimic            // now - item.lastSeenByPeerAt <= emojiMimicWindowMin×60000 → 1.0，否则 0
    + 0.08 × sourceFavor      // 来源用户 favor >= 70 → 1.0，否则 0
    + 0.06 × recency          // 1 / (1 + 距上次自己使用的天数)
)
cooldownGate = 0 if (now < emojiCooldownUntil 或 now - item.lastUsedAt < emojiCooldownMs) else 1
```

- 权重合计 **1.00**（0.34+0.22+0.16+0.14+0.08+0.06），可直接当 0~1 的可比分数看，也便于单测断言。
- **`mimic` 目前恒为 0**：`lastSeenByPeerAt` 当前实现暂按 0 计（§15.5 已注明）。要启用模仿加权，先把这个字段写起来——这是本节唯一一处「公式已就位、数据还没接」的地方，实现时不要以为是 bug。
- 上下文关键词怎么来：复用本轮 `batch` 文本，剥掉停用词（的/了/我/你/他/在/是）后取 2 字以上实词，集合上限 20 个（防止长文把 Jaccard 压低）。

### 16.5 斗图三行为（只在群聊生效）

**总开关**：三个行为各自一个布尔，**默认全 false**；私聊一律不走本节（私聊只按 §15.8 按需发一张）。

| 行为 | 触发条件 | 概率 | 冷却 | 上限 |
|---|---|---|---|---|
| **队形**（`joinFormation`） | 同一群内连续 `formationN`（默认 3）条**不同人**发同一 digest 的图（队形已成立） | `formationChance`（0.6） | `formationCooldownMs`（300000） | 每群每小时 `formationMaxPerHour`（2）次 |
| **连发**（`multiSend`） | 情绪匹配度 ≥ 0.7 且 `energyLevel` ≥ 0.6（劲头足才连发） | `multiSendChance`（0.25） | `multiSendCooldownMs`（180000） | 单次最多 `multiSendMax`（2）张 |
| **团战**（`memeWar`） | `warWindowMs`（120000）窗口内群内出现 ≥ `warTriggerN`（3）张**不同**图 → 抽其中 2 张做二次分析 → 检索同标签图回击 | `warChance`（0.5） | `warCooldownMs`（600000） | 每群每小时 `warMaxPerHour`（2）次 |

细节约束：

- **队形**判的是 digest 相同而不是像素相似：同一张图被 3 个人转发，digest 必然相同（`hashFile` 是内容 hash，`index.mjs:385-388`）。
- **连发**的「张」按 `__SEND_STICKER__` 逐条发（老通道），不新增批量接口；两条之间用现有 `splitMessages` 的 700ms 间隔节奏（`index.mjs:1718`）。
- **团战**的「抽 2 张二次分析」用的是**已有的标签**，不调模型——否则一次团战要额外烧两次视觉调用。只有标签全空时才退回 `describeImage` 补一次。
- 三条都受 `emojiCooldownMs`（§15.12）这个总表情冷却约束：任一行为触发后都写 `emojiCooldownUntil`。

### 16.6 config 新增块（`DEFAULTS.expression.memeHub`）

| 参数 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 表情中枢总开关。`false` 时**入库与打标一起停**，**回到纯老表情库——这是上线首日的默认形态**：先观察几天、用户点头后再开，开了才开始为新图花视觉 token。斗图三行为在 `enabled=false` 时自然也不动 |
| `joinFormation` | `false` | 队形跟发开关 |
| `multiSend` | `false` | 一次回复多张开关 |
| `memeWar` | `false` | 团战开关 |
| `formationN` | `3` | 连续几个不同人发同一张图算队形成立 |
| `formationChance` | `0.6` | 队形成立后跟发的概率 |
| `formationCooldownMs` | `300000` | 队形冷却（5 分钟） |
| `formationMaxPerHour` | `2` | 每群每小时队形上限 |
| `multiSendChance` | `0.25` | 连发概率 |
| `multiSendMax` | `2` | 单次连发最多几张 |
| `multiSendCooldownMs` | `180000` | 连发冷却（3 分钟） |
| `warWindowMs` | `120000` | 团战判定窗口（2 分钟内的多图） |
| `warTriggerN` | `3` | 窗口内几张不同图触发团战 |
| `warChance` | `0.5` | 团战回击概率 |
| `warMaxPerHour` | `2` | 每群每小时团战上限 |
| `warCooldownMs` | `600000` | 团战冷却（10 分钟） |
| `reviewPoolEnabled` | `true` | 是否启用审核池（`false` = 所有图直接 tagged，仅用于调试） |
| `reviewPoolMinHits` | `2` | 非可信来源的图要出现几次才跳过 pending |
| `sourceRateLimitPerHour` | `10` | 单个来源每小时最多贡献几张新图（防刷图） |
| `collectionDigestTtlDays` | `30` | digest 记录保留天数（超期未再见到 → discarded；**不删记录**，防重复烧 token） |
| `tagMin` / `tagMax` | `3` / `8` | 标签数量区间（§16.3） |

### 16.7 与 `__SEND_STICKER__` 和 §15.8 的关系

- **老指令不动**：`__SEND_STICKER__` 的解析（`index.mjs:1674`）与 `workspace/stickers` 老库一行不改。本节新增的检索结果**不直接发图**。
- **模型仍是最终决定者**：检索只产出两个注入量——`matchedCategories`（匹配到的标签集合）与 `collectionSize`（`emojiCollection` 条数），它们本来就是 §15.11 模板里的占位（`表情库：{collectionSize} 条（匹配：{matchedCategories}）`）。模型看到「库里匹配到 可爱/敷衍」之后，自己决定写不写 `__SEND_STICKER__`。
- **为什么不改成桥直接发**：桥上直接发图要自己判断语气、自己承担「发错表情」的代价；而模型这一轮已经读过全部上下文。**把决定权留在模型手里**，是本项目一贯的架构（§15.7 的「补充不替换」也是同一条）。
- 与 §15.8 打分的衔接：§15.8 是「选哪个」的五层权重，§16.4 是「按语义再排一次」的扩展版；实现上是同一函数 `scoreEmoji(item, ctx)` 的两段，**不是两套打分**。

### 16.8 改动清单与测试

| 动作 | 位置 | 具体 |
|---|---|---|
| 新增函数 | `src/expression.mjs` | `ingestImage({file, uid, name, digest})` 入库 + 状态机；`retagIfLegacy(digest)` 旧缓存补打；`scoreEmoji(item, ctx)` 检索打分；`planMemeAction({chat, batch, emojiCollection})` 三行为决策 |
| 修改 | `src/agent.mjs:295-311`（`describeImage`） | 返回结构从纯文本改为 `{summary, tags, moodHints}`；解析失败退回纯文本（待实现时核实行号偏移） |
| 修改 | `src/index.mjs:397-401`（`describeCached`） | 命中旧记录缺 `tags` 时登记 `pendingRetag`，**当轮照常返回** |
| 修改 | `src/index.mjs:415`（`resolveImages`）之后 | 下载成功后调 `ingestImage`（只登记，不阻塞本轮） |
| 修改 | `src/config.mjs:116` 之后 | `DEFAULTS.expression.memeHub`（§16.6） |
| 不改 | `workspace/stickers/*.jsonl`、`__SEND_STICKER__`、`index.mjs:385-388`（`hashFile`） | 老数据与老指令一律不动 |

测试用例（接 §15.14 之后；编号从 **43** 起，41/42 留空给后续 §15 补测）：

| # | 用例 | 断言要点 |
|---|---|---|
| 43 | digest 去重 | 同一文件两次入库 → `emojiCollection` 只有一条、`frequency === 2`；不同内容 → 两条 |
| 44 | 多标签解析 | `{summary,tags,moodHints}` 正常解析；`tags` 超 8 截断、少于 3 接受；词表外的词被丢弃；坏 JSON → 退回纯文本且 `tags = []`（不抛） |
| 45 | 检索打分 | 权重和为 1.0；`moodMatch` 命中主档比次档分高；`cooldownGate = 0` 时总分 0；`mimic` 字段为 0 时不产生 NaN |
| 46 | 队形触发 | 3 个不同人同 digest → 满足触发条件；2 人 → 不满足；冷却期内不重复触发；同一个人连发 3 次**不算**队形 |
| 47 | 连发上限 | `multiSendMax = 2` 时产出不超过 2 张；`multiSendChance = 0` 时永不触发；`energyLevel = 0.5` 时不触发 |
| 48 | 团战冷却 | 窗口内 3 张不同图 → 触发；同群 1 小时内第 3 次 → 拒绝；窗口外只有 1 张 → 不触发 |

### 16.9 成本与风险

| 项 | 量级 / 说明 | 对策 |
|---|---|---|
| 打标成本 | 每张**新图**一次视觉调用（复用 `describeImage` 与现有缓存）；老图零成本 | digest 去重 + 一图一次 + 旧缓存不批量重打（§16.3） |
| 斗图 token | 队形/连发只读 `emojiCollection`（纯本地打分），**不调模型**；团战优先用已有标签，只在标签全空时补一次 describe | 三个开关默认 false；`warMaxPerHour` 限死 |
| 恶意刷图 | 同一个人反复发图 → `frequency` 虚高、`sourceRateLimitPerHour` 被打满 | 来源频控（10/小时）+ digest 去重 + 只有群聊才入库（私聊不收集） |
| 内容风险 | 擦边/攻击性图进库 | `涩涩` 硬闸直接 discarded（§16.3）；`攻击性` 标签只影响打分，不特殊处理 |
| 缓存漂移 | 旧缓存缺 `tags` → 检索永远匹配不到 | 补打 `pendingRetag`（每轮最多 1 张），并把「缺 tags 的条目数」写进 `note('debug')` |
| 状态膨胀 | `emojiCollection` 无上限会撑爆 prompt | `collectionMax`（200，§15.12）+ `collectionDigestTtlDays`（30 天）双闸 |

---

**与本节相关的两处口径提醒**

1. 本节只做「收集 + 打标 + 检索 + 三个默认关闭的行为」，**不删** `workspace/stickers` 任何老条目（与 §15 末尾记的那条冲突处理一致）。
2. `mimic` 因子（§16.4 的 0.14 权重）**当前恒为 0**，因为 `lastSeenByPeerAt` 还没写起来（§15.5）。公式先就位、数据后接，属于有意设计，不是缺陷。

