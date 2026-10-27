# 17. 看动图：把 QQ 动图拆帧成一张拼图再喂给模型

日期：2026-10-24　范围：`src/media.mjs` / `src/animation.mjs` / `src/index.mjs` / `scripts/test-animation.mjs`

## 17.1 症状

群里有人发动图（GIF / 动态 WebP / QQ 的「动画表情」），机器人只当静态图看，回的话经常和动作对不上（比如动图是人摔下去，它回「这张图好清楚」）。

## 17.2 根因（实测，不是猜）

`src/index.mjs` 的 `resolveImages` 里本来就有动图分支：`resolveAnimatedSheet(file, ...)` → 多帧就抽帧拼图 → 提示模型用 `read_image` 看整张拼图。但那个分支**从来没被走到过**，因为扩展名不对：

- `src/media.mjs:downloadImage` 从 **url** 猜扩展名。云端 `workspace/stickers/*.jsonl` 里的真实 url 长这样：`https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...&rkey=...`——**没有后缀**，于是 `extMatch` 落空，一律存成 `.jpg`。
- 老的 `resolveAnimatedSheet` 用 `path.extname(file)` 判断，只看 `.gif` / `.webp`，`.jpg` 直接 `return null`。
- 于是每张动图都走「静态图」分支，模型看到的是第一帧，且**没有任何日志**（第二个静默失败的 P0，和 §16 的 `materializeSeg` 同类）。
- 顺带一处配置读错：`ffmpegPath` 读的是 `cfg.raw?.voice?.ffmpeg`，而 ffmpeg 是 ASR 那块的配置（`src/asr.mjs` 的 `ASR_DEFAULTS.ffmpeg`），`voice` 段里没这个键 → 永远退回字符串 `'ffmpeg'`，靠 PATH 碰运气。

## 17.3 改法（三处，都不改行为契约）

1. **按文件头定真身**（`src/media.mjs`）：下载完不信任 url，`sniffImageExt(buf)` 读前 12 字节认 GIF8 / RIFF-WEBP / PNG / JPEG / BMP，用真实格式命名落盘。新增 `findCached(hash, destDir)`：命中缓存时扫 `hash.*`，发现扩展名和文件头不符（历史那批 `.jpg`）就**就地改名**，不重新下载。
2. **按内容判动图**（`src/animation.mjs`）：新增 `imageKindOf(file)`（文件头优先、后缀兜底、文件不存在返回 `'other'`），`resolveAnimatedSheet` 的门禁从「扩展名是 .gif/.webp」换成「内容 kind 是 gif/webp」。这样历史下载的那批 `.jpg` 动图**不用重下**也能拆帧。
3. **不再静默 + 配置读对**（`src/index.mjs`）：`ffmpegPath` 改成 `cfg.raw?.asr?.ffmpeg || cfg.raw?.voice?.ffmpeg || 'ffmpeg'`；拆帧失败且 kind 确实是动图时打一条 `[动图] 拆帧失败（gif，ffmpeg=...），退回看第一帧` 的 warn。

其余保持不变：最多抽 8 帧、最多 4 列、单格宽 ≤1600/列数、白底 pad、从左到右从上到下、拼图存 `workspace/incoming/<内容hash>-sheet.png`（同内容复用）、失败一律退回原图逻辑不阻塞回复。

## 17.4 验证

- 本机 `node scripts/test-animation.mjs` → **44 过 / 0 挂**：抽帧均匀且首尾必含、网格 ≤4 列、滤镜串含 `select` / `scale+pad` / `tile`、五种文件头嗅探、缓存里 `.jpg` 伪装的 GIF 被改名、静态图不触发 ffprobe、单帧 gif 返回 null、两种提示文案。
- 云端临时目录（`/tmp/animtest`，不碰线上服务）用真 ffmpeg 跑端到端：`ffmpeg -f lavfi -i testsrc=size=120x120:rate=10:duration=2` 生成 20 帧 GIF →
  - `src.gif` → `{frames: 8, sheet: .../75b98a8b2e6e3d98-sheet.png}`
  - 同内容复制成 `fake.jpg` → 一样认出 `kind = gif` 并拆出**同一张**拼图（缓存复用）
  - `ffprobe` 拼图尺寸 = **1600x800**（4 列 x 2 行），肉眼看帧序从左到右递增，符合设计。
- 本机其余测试无变化：test-memehub 22 / test-favor 18 / test-sleep 13 / archive / speakers 全绿；test-anger、test-balance、test-blindtalk、test-selfname 依旧是仓里原有的红（只 import anger.mjs / balance.mjs / fs，与本次无关）。

## 17.5 部署与回滚

改动 3 个源文件 + 1 个新测试，无配置项新增、无数据结构变更、不碰 `data/expression.json`，因此：

1. 云端备份：`tar czf /root/qq-agent-backup-pre-animation-<ts>.tgz -C /root/qq-agent src scripts`。
2. 上传 `src/media.mjs`、`src/animation.mjs`、`src/index.mjs`、`scripts/test-animation.mjs`，逐个 `node --check`。
3. 云端跑 `node scripts/test-animation.mjs`（本机没有 ffmpeg，只有云端能跑真拆帧那一段）。
4. `systemctl restart qq-bridge`，看 4 分钟日志无 error。
5. 回滚：`tar xzf <备份> -C /root/qq-agent && systemctl restart qq-bridge`。

## 17.6 已知限制（说清楚，不假装全能）

- **商城表情 `mface` 多半看不到**：NapCat 给的 `mface` 段通常没有 `url`，拿不到文件就只剩「[对方发了个表情包]」这句兜底。要真看，得让 NapCat 下发文件或改走别的接口，属于另一件事。
- 拼图会**丢中间帧的精细内容**：20 帧取 8 帧是采样，动作跨度极大（如快速旋转）时可能看不出差别；需要更多帧就调 `buildFilmstrip` 的 `maxFrames`，代价是图更大、read_image 更慢。
- 动图只在**收消息**这一侧处理；机器人自己发出去的动图素材没走拆帧（不需要）。

## 17.7 上线记录 2026-10-24 21:56（云端 <SERVER_IP> · /root/qq-agent · node v22.20.0）

- 备份：`/root/qq-agent-backup-pre-animation-20261024-215659.tgz`（206K，含 src + scripts）。
- 上传 4 个文件并逐个 `node --check` 全过：`src/media.mjs`、`src/animation.mjs`、`src/index.mjs`、`scripts/test-animation.mjs`。
- 云端单测：`test-animation` **44 过 / 0 挂**；回归 `test-memehub` 22 过 / 0 挂、`test-favor` 18 过。
- `systemctl restart qq-bridge` → `active`；重启后 2 分钟内 `error|traceback|failed` 计数 **0**、`NRestarts=0`、`[动图]` warn 计数 0；日志正常登录 <BOT_QQ>、余额 51.89 CNY。
- 存量体检：`workspace/incoming` 154 个文件里，按文件头嗅探 **27 个其实是 GIF/WebP 动图**（其中若干文件名是 `.jpg`，如 `04ef3799b0bead69.jpg`）——这些历史上都被当成静态图看过第一帧。改完之后同样的文件会被直接拆帧，不用重下。
- 回滚：`tar xzf /root/qq-agent-backup-pre-animation-20261024-215659.tgz -C /root/qq-agent && systemctl restart qq-bridge`。
