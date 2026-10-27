# 表情素材包：怎么装

仓库里只有**索引**（`workspace/stickers/*.jsonl`），图片本体约 389MB，不进 git。
想把「共享图库·大肥鱼」那 300 多张补齐，照下面做。

## 目录结构长什么样

```
workspace/stickers/
  files/                 ← 真正的图片，文件名是 md5.webp/gif/jpg（桥发图时按名字取）
  nekowhale/             ← 猫鲸素材原图（321 张 GIF，素材包主体）
  collected/             ← 从群里收集的原图（带原始文件名）
  _shared.jsonl          ← 共享图库索引，每行一条，靠 `file` 字段指到 files/
  group_<群号>.jsonl     ← 各群收到的图索引
  private_<QQ>.jsonl     ← 私聊收到的图索引
```

索引行格式（一行一条，追加式）：

```json
{"t":"2026-10-22T08:16:35.619Z","uid":0,"name":"大肥鱼图库",
 "seg":{"type":"image","data":{"summary":"气鼓鼓叉腰，额头怒气符号，蒸汽直冒"}},
 "local":"/root/qq-agent/workspace/memes/dafeiyu-001/memes/angry/shengqi.jpg",
 "tag":"angry","file":"files/shengqi.jpg","digest":"fcda6697eb151b7c"}
```

- `file` 是相对 `stickers/` 的路径，**索引和文件必须对得上**，否则发图报错。
- `seg.data.summary` 是给模型看的描述，模型靠它挑图——描述写得越具体，她挑得越准。
- `local` 只是来源记录，跑起来不读它。

## 装法一：有素材包（推荐）

拿 `mingyue-stickers.tar.gz`（找号主要，或从旧服务器 `/root/qq-agent/workspace/stickers` 打包），然后：

```bash
cd /root/qq-agent/workspace
tar xzf /tmp/mingyue-stickers.tar.gz      # 解出来是 stickers/
chown -R root:root stickers
cd /root/qq-agent && node scripts/sticker-doctor.mjs   # 检查索引与文件是否一一对应
```

`sticker-doctor.mjs` 输出 `缺失 N / 索引 M`：缺失为 0 就是齐了。

## 装法二：从旧服务器搬

```bash
# 在旧机上
cd /root/qq-agent/workspace && tar czf /tmp/stickers.tgz stickers
# 拉到新机（本机中转）
scp root@旧IP:/tmp/stickers.tgz .
scp stickers.tgz root@新IP:/tmp/
ssh root@新IP 'cd /root/qq-agent/workspace && tar xzf /tmp/stickers.tgz'
```

## 装法三：什么也不装

跑是能跑的，只是「共享图库」是空的：她不会主动甩表情，但群友发的图照样会被收进
`group_*.jsonl` 并能在对话里转发（`__SEND_MEDIA__`）。用几天就自己攒起来了。

## 加新图（手工）

```bash
cd /root/qq-agent/workspace/stickers
cp 你的图.gif files/自己的名字.gif
# 然后在对应会话的 jsonl 末尾追加一行（字段别漏 digest，按 md5 前 16 位）
printf '{"t":"%s","uid":0,"name":"手工添加","seg":{"type":"image","data":{"summary":"一句话描述这张图"}},"tag":"","file":"files/自己的名字.gif","digest":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$(md5sum files/自己的名字.gif | cut -c1-16)" >> _shared.jsonl
node /root/qq-agent/scripts/sticker-doctor.mjs
```

## 踩过的坑

- **索引在、文件不在** → 她挑到这张图时发送失败，日志里是 `file not found`。一定跑一次 doctor。
- **文件名重复**：`files/` 里按 digest 命名，手工加图别覆盖已有名字。
- **GIF 太大**：QQ 单文件限制，超过 5MB 的动图发不出去，先压。
- **`.bak` 文件别提交**：那是清理微信表情前的备份，`_shared.jsonl.bak` 之类已进 `.gitignore`。
