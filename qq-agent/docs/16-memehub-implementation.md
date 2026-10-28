# 16 表情中枢（memeHub）实现设计

> 状态：**待你审阅，未动代码**
> 日期：2026-10-24
> 上游设计：`docs/emotion-v2.md` §16（1206–1400 行）
> 本文只解决「§16 怎么落地」：精确到文件/函数/行号、数据结构、迁移、测试、回滚。§16 已经写好的理念不重复。

---

## 0. 一句话

把「群友发的图」变成机器人自己的表情库：**内容去重入库 → 一次视觉调用打多标签 → 检索打分 → 交给模型决定发不发**；同时修掉现在「表情一条都发不出去」的 P0 数据问题。

---

## 1. 核实到的事实（2026-10-24 实测，行号为本机当前值）

| 事实 | 位置 |
|---|---|
| 素材库根目录 `stashDir = cfg.agentCwd/stickers` | `src/index.mjs:61` |
| 共享图库文件 `_shared.jsonl` | `src/index.mjs:319` |
| 目录注入 `stickerCatalog` / `stickerHint` | `src/index.mjs:340` / `:367` |
| `stickerHint` 调用点（进 prompt 的 extra） | `src/index.mjs:1634` |
| `__SEND_STICKER__` 抽取 / 执行 | `src/index.mjs:596` / `:614` |
| `__SEND_STICKER__` 调用点 | `src/index.mjs:1773` |
| 发送物化 `materializeSeg(seg, localPath)` | `src/index.mjs:558` |
| 图片描述缓存 `descCacheFile` / `hashFile` / `describeCached` | `src/index.mjs:379` / `:387` / `:396` |
| 下载 + 描述主链路 `resolveImages`（动图分支在 `:437`） | `src/index.mjs:405` |
| `resolveIncoming` | `src/index.mjs:469`，调用点 `:2048`、`:2168` |
| 读图通道 `describeImage(file, hint)` | `src/agent.mjs:297–312` |
| `emojiCollection` 字段（初始化 / 归一化 / 打分 / 注入） | `src/expression.mjs:75` / `:102` / `:289` / `:428–432` |
| 表现层注入模板 `renderExpressionBlock` | `src/expression.mjs:385` |
| `DEFAULTS.expression` | `src/config.mjs:134–152` |
| 老图库现状 | `workspace/stickers`：共享 24 / 群 16 / 私 9 = 49 条，**全部 `type:image`、`data` 只有 summary、无 url** |
| 老图库条目 `local` | 全是 Windows 绝对路径 `C:\Users\14381\DSH-Plugin\dsh-meme\memes\dafeiyu-001\...` |
| 种子脚本 | `scripts/import-dsh-meme-pack.mjs`（把 `index.db` 的 24 条写成绝对路径，无 url、无 digest） |

### 1.1 三条必须先说清的前置问题

**P0：表情发不出去（现在就是坏的）。**
`materializeSeg` 的顺序是 `local 存在 → 用`／`否则 seg.data.url 下载`／`都不行 → return seg`（`src/index.mjs:560–565`）。云端是 Linux，`C:\...` 不存在、也没有 url，于是把一个只有 summary 的 image 段丢给 SnowLuma，**静默失败且无日志**。§16 做得再好，检索出来的图仍然发不出去。

**P0：本机没有验收基线。**
`test-emotion.mjs` / `test-expression.mjs` / `test-animation.mjs` 在本机**不存在**（`scripts/` 下只有 test-anger / test-favor / test-balance 等 12 个老测试）。记忆里「33 + 9 + 14 项全绿」是在别处跑的。改造前必须先拿到或重建这三个测试，否则改完无法证明没回归。

**P1：没有版本控制。**
`qq-agent` 不是 git 仓库。改动前只能靠 `archive/` 手工备份。

---

## 2. 范围

做：
- 群聊图片入库（去重 / 审核池 / 四态机）
- 多标签打标（复用一次 `describeImage`，扩成 `{summary, tags, moodHints}`）
- 检索打分（六因子）与 `matchedCategories` 注入升级
- 斗图三行为（队形 / 连发 / 团战），默认全关
- 修 P0 图库路径，让表情真的能发出去

不做：
- 不碰 `__SEND_STICKER__` 老通道与 `workspace/stickers/*.jsonl` 老数据（只**追加**字段）
- 不新建 Python 服务，不引入 AstrBot 代码
- 不做图片相似度（只做内容 digest 相同判定）
- 私聊不入库（只收集群图）

---

## 3. 三处需要你拍板的分歧

### 3.1 斗图三行为：谁发？（关键）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（建议）** | 桥只产出**建议**，注入 prompt 一行：`【斗图】队形已成立（3 人发同一张），库里 S12/S15 可用`，仍由模型写 `__SEND_STICKER__` | 与 §16.7「模型是最终决定者」一致；发错表情的风险由模型承担；不新增发送通道 | 模型可能不理；需要它多写一行 |
| B | 桥直接调发送（像 AstrBot） | 队形成立必然跟发，效果更像人 | 桥要自己判断语气；发错就是「机器人乱刷图」；绕过现有 `materializeSeg` 容错 |

我建议 **A**，理由：本项目一贯是「桥给倾向、模型落笔」（§15.7 同一条）。但 A 有代价——斗图这事讲究快，模型多犹豫一轮就冷了。这条你来定。

### 3.2 打分公式：改老的还是并存？

老公式（`src/expression.mjs:305`）实测是**四项**：`0.40 moodMatch + 0.20 freshness + 0.20 mimic(恒 0) + 0.15 source`，权重和 0.95。§16.4 的新公式是**六项**、和 1.00。

| 方案 | 说明 |
|---|---|
| **A（建议）** | 老 `scoreEmojis` **一行不改**；新增 `scoreEmojiV2(item, ctx)` 走 `memeHub.enabled` 开关切换。`enabled=false` 时行为与今天完全一致，零回归 |
| B | 直接把老公式换成六项 | 少一套代码，但已有测试/观感全部要重调 |

我建议 **A**：`memeHub.enabled` 默认 `false`，这样上线首日行为和今天一模一样，开关只影响新库。

**最终决定：B**（用户 2026-10-24 看过代码后指定「3.2 使用 B 方案」）。落地形态：六因子成为**唯一**打分器，老 `scoreEmojis` 退化成薄壳（`return scoreEmojiV2(collection, opts)`），`memeHub.enabled` 只管入库/打标/斗图建议，不再决定用哪套公式。B 方案必须补两处，否则会踩坑：

1. **无标签中性化**：某条表情没 `tags`（老库 49 条全是这样），或当前上下文提不出实词时，Jaccard 无从计算。此时把 `tagOverlap` 的 0.22 按比例摊给其余五因子（`rest / (1 - 0.22)`），`parts.tagOverlap` 记 `null`。否则老库和未打标条目一律被压在 0.78 以下，`moodMatch` 命中也赢不过新库。
2. **`pickEmoji` 兜底**：`scoreEmojiV2` 只看 `state==='active'`，而新库刚部署时条目都是 `pending`/`tagged`。所以 `pickEmoji` 在收到 `reason:'no-active'` 时用 `{ includeInactive: true }` 再算一次（只排除 `discarded`），避免头几天一个表情都选不出来。

### 3.3 老图库怎么修？

| 方案 | 说明 |
|---|---|
| **A（建议）** | 图片复制一份到 `workspace/stickers/files/<basename>`，jsonl **只追加** `"file":"files/xxx.jpg"` 字段；`materializeSeg` 解析顺序改成 `file(相对 stashDir) → local → url`。老字段一个不删，可回滚 |
| B | 去掉 local，全部改成 base64 存进 jsonl | jsonl 会膨胀到几十 MB，每轮读库都变慢 |

走 **A**。同时改 `scripts/import-dsh-meme-pack.mjs`：以后导入就复制文件 + 写相对路径 + 写 digest，不再产生坏条目。

---

## 4. 数据结构

### 4.1 `emojiCollection` 条目（存于 `data/expression.json`）

```json
{
  "digest": "a1b2c3d4e5f60718",
  "file": "stickers/collected/a1b2c3d4e5f60718.jpg",
  "state": "active",
  "summary": "气鼓鼓叉腰，额头怒气符号",
  "tags": ["搞笑", "攻击性"],
  "moodHints": ["confused"],
  "associatedMood": ["confused"],
  "source": { "uid": 12345, "name": "群友A", "favor": 62, "trusted": false },
  "firstSeenAt": 0, "lastSeenByPeerAt": 0,
  "frequency": 2,
  "lastUsedAt": 0, "selfUsedCount": 0,
  "verified": true
}
```

- `state`：`pending | tagged | active | discarded`（四态，只增不删；删条目会丢 digest → 同一张图重新烧 token）
- `file` 是**相对 `cfg.agentCwd` 的路径**，不存绝对路径
- `mimic` 因子要真正可用：本轮入库/再见时写 `lastSeenByPeerAt`，这是 §16.4 里唯一「公式已就位、数据没接」的字段
- 上限 `collectionMax=200`，超限按 `lastUsedAt` 最旧 + `frequency` 最低淘汰（淘汰是唯一允许删的情况，删前把 file 留着不删，防图被误删后又想恢复）

### 4.2 打标缓存升级（`workspace/.cache/image-desc.json`）

```json
{ "<digest>": { "v": 2, "text": "…", "tags": ["…"], "moodHints": ["…"], "at": 0 } }
```

- 老记录没有 `v`/`tags` → 视为 legacy：**照常返回 text 不阻塞本轮**，把 digest 放进 `pendingRetag`，每轮最多补打 1 张
- 一图一次：缓存键仍是内容 digest

### 4.3 标签词表（只认这 9 个，词表外的丢弃）

`搞笑 / 可爱 / 攻击性 / 敷衍 / 安慰 / 日常 / 涩涩 / 破防 / 加油`
其中 `涩涩` 是硬闸：命中即 `discarded`，文件也不保留。

---

## 5. 管线

```
群消息带图
  → renderSegments 出 images[]
  → resolveImages 下载到 incomingDir                      [现有 :405]
  → digest = hashFile(file)                              [复用 :387]
  → ingestImage({digest, file, uid, name, trusted})      [新增 expression.mjs]
       ├ 库里已有 digest → frequency++ / lastSeenByPeerAt=now → 结束
       ├ 来源够可信(号主|trusted) 或 frequency≥reviewPoolMinHits → tagged
       └ 否则 pending（不参加检索，等下次命中再判）
  → 打标：describeImage 一次返回 {summary,tags,moodHints} → 写缓存 → active / discarded
  → 检索：scoreEmojiV2(item, ctx)（ctx 含 emotionName/secondary/上下文关键词集/now）
  → 注入：matchedCategories = active 条目命中的 tags ∪ mood
  → 模型看到「表情库：N 条（匹配：可爱、敷衍）」自己决定写不写 __SEND_STICKER__
```

关键约束：
- 入库**不阻塞本轮回复**：`ingestImage` 同步登记，打标异步排队（失败的图停在 `tagged` 等下一轮，不阻塞对话）
- 打标失败不重试超过 3 次，之后降级 `discarded` 并记 `note('warn')`
- 上下文关键词：本轮 batch 文本去停用词（的/了/我/你/他/在/是），取 2 字以上实词，集合上限 20

---

## 6. 文件级改动清单

| 文件 | 动作 | 具体 |
|---|---|---|
| `src/expression.mjs` | 新增 | `ingestImage()`、`retagIfLegacy()`、`scoreEmojiV2()`、`planMemeAction()`、`EMOJI_TAGS` 词表 |
| `src/expression.mjs` | 修改 | `updateExpression`（`:406`）里选打分函数：`memeHub.enabled ? V2 : 老`；`matchedCategories` 收集改成「active 条目 tags ∪ mood」 |
| `src/agent.mjs` | 修改 | `describeImage`（`:297–312`）prompt 改为要求「只输出一行 JSON」，返回 `{text, tags, moodHints}`；解析失败退回纯文本（`tags: []`，不抛） |
| `src/index.mjs` | 修改 | `describeCached`（`:396`）读写 v2 缓存结构 + legacy 登记 `pendingRetag` |
| `src/index.mjs` | 修改 | `resolveImages`（`:405`）/ `resolveIncoming`（`:469`）多传一个 `meta = {chatKey, uid, name, isGroup, trusted}`，下载成功后调 `ingestImage`（**仅群聊**） |
| `src/index.mjs` | 修改 | `materializeSeg`（`:558`）解析顺序改 `file → local → url`，`file` 相对 `stashDir`；三种都失败时 `note('warn', ...)` |
| `src/index.mjs` | 修改 | 斗图建议注入：`stickerHint`（`:367`）或 `extra`（`:1634`）追加一行【斗图】 |
| `src/config.mjs` | 修改 | `DEFAULTS.expression`（`:134`）后追加 `memeHub: {...}`（§7） |
| `scripts/import-dsh-meme-pack.mjs` | 修改 | 复制文件到 `workspace/stickers/files/`，写 `file` 相对路径 + `digest` |
| 新增脚本 | 新增 | `scripts/migrate-stickers-files.mjs`：把现有 49 条按 `local` 复制进 `files/` 并追加 `file` 字段（幂等，可反复跑） |
| `workspace/stickers/*.jsonl` | **只追加** | 不改老字段 |

---

## 7. 配置（`DEFAULTS.expression.memeHub`，全部照 §16.6）

`enabled: false`（总闸，false 时入库+打标一起停）｜`joinFormation / multiSend / memeWar: false`｜`formationN:3, formationChance:0.6, formationCooldownMs:300000, formationMaxPerHour:2`｜`multiSendChance:0.25, multiSendMax:2, multiSendCooldownMs:180000`｜`warWindowMs:120000, warTriggerN:3, warChance:0.5, warMaxPerHour:2, warCooldownMs:600000`｜`reviewPoolEnabled:true, reviewPoolMinHits:2`｜`sourceRateLimitPerHour:10`｜`collectionDigestTtlDays:30`｜`tagMin:3, tagMax:8`

---

## 8. 测试计划

先补基线：`scripts/test-emotion.mjs`、`scripts/test-expression.mjs`、`scripts/test-animation.mjs` 重建（本机缺失，见 §1.1）。新增用例编号接 §16.8：

| # | 用例 | 断言要点 |
|---|---|---|
| 43 | digest 去重 | 同文件两次入库 → 一条、`frequency===2`；不同内容 → 两条 |
| 44 | 多标签解析 | 正常解析；tags 超 8 截断、少于 3 接受；词表外丢弃；坏 JSON → 退回纯文本且 `tags=[]` 不抛 |
| 45 | 检索打分 | 六项权重和 1.00；主档 > 次档；冷却门 0 时总分 0；`mimic=0` 不出 NaN |
| 46 | 队形 | 3 个**不同人**同 digest → 成立；2 人 → 不成立；同一人刷 3 次 → 不成立；冷却内不重复 |
| 47 | 连发 | `multiSendMax:2` 不超 2 张；`chance:0` 永不触发；`energyLevel 0.5` 不触发 |
| 48 | 团战 | 窗口内 3 张不同图 → 触发；同群 1 小时第 3 次 → 拒；窗口外单张 → 不触发 |
| 49 | 图库物化（P0） | 条目只有 `file` 时能取到绝对路径；只有 `local` 且不存在时记 warn；都不行时返回原 seg 且不抛 |
| 50 | 涩涩硬闸 | tags 含涩涩 → state=discarded、不进 collection、文件删除 |
| 51 | 审核池 | 非可信来源首次 → pending 且不参与检索；frequency 到阈值 → active |
| 52 | legacy 补打 | 无 tags 的旧缓存照常返回 text；每轮最多补打 1 张；补打后缓存版本升 v2 |

## 9. 成本

- 每张**新图**一次视觉调用（复用 `describeImage` 与 digest 缓存），老图零成本
- 队形/连发只读本地 `emojiCollection`，**不调模型**
- 团战优先用已有标签，标签全空才补一次 describe
- 三行为默认全关；`enabled=false` 时新图不花任何视觉 token

## 10. 部署与回滚

改动前先整目录备份：`cp -r src scripts workspace/stickers archive/pre-memehub-<ts>/`（无 git，只能手工备份）

部署顺序（**不自动上线，等你看完代码再定时机**）：

1. 本机跑全回归（老 12 个 + 新 43–52）
2. 先只上「P0 图库修复」（`materializeSeg` + `migrate-stickers-files.mjs` + 同步 `files/` 到云端），验证表情真能发出去
3. 再上 §16 代码，`memeHub.enabled=false` 观察一轮
4. 你点头后开 `enabled=true`，只看打分/匹配是否合理，三行为仍全关
5. 三行为逐个开（先连发，最后团战）

回滚：`archive/pre-memehub-<ts>/` 覆盖回去；云端 `files/` 目录可保留（对老逻辑无害）。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 云端代码已和本机分叉（Oct 23 旧版） | 上云前逐文件 diff `src/`，**不盲覆盖**；缺依赖文件会让 qq-bridge 起不来（踩过） |
| 打标 JSON 解析不稳 | 宽容解析（取第一个 `{` 到最后一个 `}`）；失败退回纯文本，绝不抛 |
| 表情库噪音大 | `pending` 不入 prompt；`discarded` 保留 digest 防重烧；`collectionMax 200` 封顶 |
| 状态文件膨胀 | `data/expression.json` 只存摘要与标签，不存图片字节 |
| 无 git 改坏 | 改动前整目录备份；每步可单独回滚 |

## 12 实现状态（2026-10-24）

用户 2026-10-24 拍板：3.1 A / 3.2 **B**（看过代码后改成 B）/ 3.3 A。

| 项 | 状态 | 位置 |
| --- | --- | --- |
| 配置块 + 总闸（默认关） | 已实现 | `src/config.mjs` DEFAULTS.expression.memeHub；`src/expression.mjs` MEMEHUB_DEFAULTS / memeHubConfig |
| 入库四态机 + digest 去重 + 速率限制 | 已实现 | `src/expression.mjs` ingestImage |
| 打标落库 + 涩涩硬闸 | 已实现 | `src/expression.mjs` tagEmoji（命中即 discarded 且删图） |
| 审核池（minHits 才打标）+ legacy 补打 | 已实现 | ingestImage 尾部 + takeTagJobs |
| 六因子打分（B：唯一打分器） | 已实现 | `src/expression.mjs` scoreEmojiV2 / EMOJI_V2_WEIGHTS；老 scoreEmojis 已退化为薄壳；pickEmoji 走新公式 + includeInactive 兜底 |
| 斗图三行为（只出建议） | 已实现 | `src/expression.mjs` planMemeAction / renderMemeHint |
| describeImage 一次带回 summary+tags+moodHints | 已实现 | `src/agent.mjs` describeImage（要求一行 JSON）；解析在 parseDescPayload |
| 描述缓存 v2 | 已实现 | `src/index.mjs` describeCached（{v:2,text,tags,moodHints}） |
| 群图入库挂点 | 已实现 | `src/index.mjs` resolveImages（`meta.isGroup` 才入库） |
| 打标驱动（每轮最多 1 张） | 已实现 | `src/index.mjs` tagPendingMemes，回复后 fire-and-forget |
| P0 物化 file→local→url + 失败留痕 | 已实现 | `src/index.mjs` materializeSeg；路径解析抽到 `src/stickerfile.mjs` |
| 老图库迁移 | 已实现 | `scripts/migrate-stickers-files.mjs`（幂等，`--dry` 可预演） |
| 图库导入改相对路径 | 已实现 | `scripts/import-dsh-meme-pack.mjs`（复制到 stickers/files/ + digest） |
| 单测 43–52 | 已实现 | `scripts/test-memehub.mjs`，20 项全绿 |

本机预演结果：`node scripts/migrate-stickers-files.mjs --dry` → 49 条里 38 条可迁移、3 条源文件缺失、0 条已有 file。

**没做的事**：没有部署、没有改 `config/config.json` 的用户配置（`memeHub.enabled` 在默认值里是 false），没有跑云端。上线前仍按 §10 的 5 步走。

### 上线记录 2026-10-24 21:44（云端 <SERVER_IP> · /root/qq-agent · node v22.20.0）

- 备份：云端 `/root/qq-agent-backup-pre-memehub-20261024-214444.tgz`（222K，含 src/scripts/config/data/expression.json/workspace/stickers）；本机 `archive/pre-memehub-20261024-214320/`。
- 上传前先逐文件 diff 云端旧版，确认 `config.mjs`/`index.mjs`/`agent.mjs` 的删除行全部是本次改动，无云端分叉（§11 风险已排除）。
- 上传 8 个文件：`src/{config,expression,index,agent,stickerfile}.mjs`、`scripts/{migrate-stickers-files,import-dsh-meme-pack,test-memehub}.mjs`；云端 `node --check` 全过。
- 云端跑单测 `node scripts/test-memehub.mjs` → 22 过 / 0 挂。
- 迁移：`workspace/stickers` 227 条 image 记录 → 170 条拿到 `file` 且全部能解析，实际复制 168 个文件到 `workspace/stickers/files/`；余下 57 条记录既无 `file` 也无 `local`（历史占位记录），物化时会留一条 warn，不再静默。
- 重启 `qq-bridge`：`ActiveState=active / SubState=running / NRestarts=0`，登录成功（<BOT_QQ>），4 分钟内 `error|traceback|failed` 计数 0。
- 当前 `memeHub.enabled=false`（云端 `config/config.json` 没有 `memeHub` 块，走 `DEFAULTS` 默认 = 关）；入库/打标/斗图三行为全部未开。
- 回滚：`tar xzf /root/qq-agent-backup-pre-memehub-20261024-214444.tgz -C /root && systemctl restart qq-bridge`。

### 开闸记录 2026-10-24 22:27（云端 · enabled = true）

- 用户指令（m00671）：「开闸吧可以偷图了」→ 只开入库 + 打标；斗图三行为（joinFormation / multiSend / memeWar）仍为 false。
- 改动：云端 `config/config.json` 原本**没有** `expression` 节（全部走 DEFAULTS），本次新增
  `expression.memeHub = { enabled: true, joinFormation: false, multiSend: false, memeWar: false }`，
  其余 19 个键继续走 `MEMEHUB_DEFAULTS`（reviewPoolEnabled true / minHits 2 / sourceRateLimitPerHour 10 / collectedSubdir collected）。
- 备份：`config/config.json.bak-20261024-222657`；落盘前先核对云端文件与本地副本一致（防止拉取后被改）。
- 生效校验：`node -e` 读回 `memeHub.enabled = true | formation false | multiSend false | memeWar false | reviewPool true minHits 2 | rateLimit/h 10`；重启后 `active`、`NRestarts=0`、2 分钟内 error 计数 0。
- 开闸前隔离演练（`/tmp/ingtest` 假 cfg + 云端真实动图 `04ef3799b0bead69.jpg`，不碰线上数据）：
  第 1 次 `ingestImage` → `{ok:true, reason:'new', state:'pending'}`（陌生来源只进审核池）；
  第 2 次 → `{reason:'seen'}`，`frequency=2` 达到 `reviewPoolMinHits` 进 pendingTag；
  `takeTagJobs` → `kind:'new'`、`file:'stickers/collected/212398f602df7850.gif'`；
  `tagEmoji(['搞笑','可爱'], ['happy'])` → `{state:'active'}`，落盘文件存在，`activeCountOf = 1`。
- 线上基线：`data/expression.json` 里 `emojiCollection` 0 条、`memeHub` 为空壳；`workspace/stickers/collected/` 尚未创建（第一张真图进来时才建）。
- 成本：每张新图最多触发 1 次 headless 描述调用（`takeTagJobs(cfg,1)` 每轮 1 个），陌生来源还要「见过 2 次」才进打标队列；`sourceRateLimitPerHour=10` 兜住刷图。
- 回滚：`cp config/config.json.bak-20261024-222657 config/config.json && systemctl restart qq-bridge`（不改代码，入库/打标立即停）。
