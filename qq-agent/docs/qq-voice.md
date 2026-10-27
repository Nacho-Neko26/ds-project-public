# 语音：TTS 合成 / 音色 / 响度 / 语速 / 听语音（ASR）

> 从 `AGENTS.md` 拆出来的跑手册（2026-10-26 用户要求精简），内容原样搬来，没有删改。
> 需要时按 `AGENTS.md` 的索引打开；改这里的规则要同步改 `qq-agent/src/` 对应代码。

## 3. 语音：能发，还听不见

- **发语音（已上线）**：模型输出 `__SEND_VOICE__ <口语稿>`（可配 `__VOICE_META__`），
  桥渲染后发一条 record。
  - **当前默认 `style: "bailian"`**：走百炼 Qwen-Audio-TTS。音色 2026-10-24 换成自建的
    `qwen-audio-3.1-tts-flash-ref1-b8d440e9…`（用浏览器播放目标声线、WASAPI loopback 录
    120 秒，切 4.3s~17.5s 那段 13.2 秒建的）；旧的号主音色 `...-bailian-52a4940f…`
    （2026-10-23 用他 195 秒录音 117.0s 起裁 15 秒建，`tools/cut-ref.py`）备份在服务器
    `config/config.json.bak-voice`。换参考音频的路子：`python3 scripts/voice-enroll.py create
    <音频> --prefix <名字>` → 拿 `voice_id` 填 `config.json` 的 `voice.bailian.voice` →
    `systemctl restart qq-bridge`（桥会把 voice 传给 tts-service，覆盖服务端默认）。
    **参数基本回原声**：`pitch: 1.0`（试过 0.93/0.90 都嫌太低，用户 2026-10-23
    「不要刻意压低」定了回原声）、`rate: 1.0`、
    `loudness` 空、`balance: false`、`emphasis: false`、`vary: false`、
    `defaultInstruction` 是三条语气指令的池子（每次随机挑一条）、`instructions: {"困": ""}`。
    2026-10-23 用户说之前「声音发飘/有波动」，根因是**两道 loudnorm 叠加**
    （服务端 `LRA=11` + 桥端 `LRA=18 + alimiter`），外加 `pitch 0.93` 降调、
    `defaultEmotion: happy` 强制 `[excited]`。现在合成出来是什么就是什么，不压不调。
    桥把 text + 按心情拼的 `instruction` POST 给本机服务 `127.0.0.1:3911/tts`，拿回 mp3。
  - **响度（2026-10-23 修）**：`bailian.loudness = "loud"` 时 ffmpeg 走
    `loudnorm=I=-15:TP=-1.0:LRA=11`，实测同一句话 **−26.8 → −15.5 LUFS**（响约 11dB）。
    之前的坑：单句合成路径**根本没调 `normalize()`**（只有多段分支调了），所以一直偏轻；
    峰值只有 −7.9dB。**现在默认关了**（`loudness: ""`），代价是音量比之前小；
    要在 QQ 里更响，只加峰值归一，别再叠动态压缩。
  - **默认情绪兜底（已移除）**：`defaultEmotion` / `defaultIntensity` 删了。
    模型自己写 `__VOICE_META__` 的 emotion 仍然有效，只是不再强行给每句套 `[excited]`。
  - **音高是分档的**：这个接口对 `pitch_rate` 会量化，0.98/0.96/0.95/0.92 生成的文件
    MD5 完全一样，只有 0.94/0.93/0.90 才跳档。所以「稍微降一点」要么没变化、要么直接跳一档。
    现在是 **1.0**（原声，不压）。0.93/0.90 都试过，用户嫌太低，2026-10-23 明确「不要刻意压低」。
  - **自己建音色**：`scripts/voice-enroll.py create <音频> --prefix <名字>`，
    音频 10~20 秒、单人、无 BGM、≥16kHz；音色绑定 `target_model`（现在是 `qwen-audio-3.1-tts-flash`），
    换模型要重建；建音色免费，合成按模型计费。
    **音色按账号 + 地域隔离**：别人的 `xxx-bailian-<hash>` 调不通，报 `Engine error [411]`；
    先用 `voice-enrollment list_voice` 确认 ID 在不在自己账号下。
  - 心情 → 指令：**日常有三条平淡语气指令的池子**（`defaultInstruction` 是数组，每次随机挑一条）：
    「平常说话的语气，自然、平静，语速正常」/「日常聊天，放松，别刻意起伏」/「轻声一点、平稳一点，像随口应一句」。
    `instructions` 里只有一条空的 `困`（困的时候纯原声平读）。
    **方向是「平淡」**：用户 2026-10-23 说「太激动容易破」，撒娇/起伏那几条都删了。
    不要启用 `[laughing]` / 委屈语气——用户明确说不行。
  - **语音质量优先的处理链（2026-10-24 定稿）**：`tts-service.py` 的 `pcm_to_mp3` 依次走
    `equalizer=f=5200:t=q:w=1.2:g=-4`（削齿音）→ `lowpass=f=6800:poles=2`（切高频嘶声）
    → `volume=3dB` → `alimiter=limit=0.708:level=false`（峰值 −3dBFS），
    输出 **24kHz / 96kbps**。实测 −14.2 LUFS / TP −3.7 dBFS。
    **采样率必须 24k**：NapCat 转 silk 用的是 `-ar 24000 -c:a ntsilk_s16le`
    （`napcat.mjs` 的 `convertToNTSilkTct`），百炼源 PCM 本身也是 24k。
    原来输出 16k 等于 24k→16k→24k 白转两道、还丢 8~12kHz——这才是「QQ 里破音」的主因，
    2026-10-24 只改这一项就修好了。**要动响度/音色必须先给两档试听让人挑**：
    同日试过 `loudnorm=I=-16:TP=-4:LRA=7` + deesser + 低通 7.2k 的「推轻压动态」方案，
    用户听完原话「我感觉原版更好」，整套已回退，别再自作主张。
  - **语境化 + 情绪化（2026-10-23 上线）**：模型输出两行（都不显示成文字）：
    ```
    __VOICE_META__ {"emotion":"gentle","intensity":0.6,"scene":"凌晨一点，窝在被窝里"}
    __SEND_VOICE__ 诶……<emphasis>你咋才回</emphasis>啊……我都等半天了
    ```
    `extractVoiceDirective()` 解析：meta 走 JSON（坏 JSON 不阻塞发送），旧写法
    `__VOICE_SCENE__ 纯文本` 仍兼容。`composeInstruction()` 把 scene 拼进指令。
    `emotion` 只认这 9 个：happy/sad/surprised/gentle/calm/confused/encouraging/sleepy/soft。
  - **停顿方式 = 「……」**（用户 2026-10-23 明确选定）。不要用 `<break>` 插静音。
    `tts-service.py` 里那条「按 `<break>` 切段 + 插精确静音」的代码**默认关闭**，
    要开必须设 `BAILIAN_TTS_BREAKS=1`。为什么关：它确实能做到 0.4s→0.46s，
    但拼段有接缝感，用户听了不要。不开时 `<break>` 标签会被剥掉，整段一次合成。
  - **情绪标签是真有效的杠杆**（`scripts/emotion-probe.py` 实测，seed 固定、结果确定）：
    happy→`[excited]` f0 +18% / 响度 +21%；sleepy→`[tired]` f0 −18% / +1.78s；
    calm→`[serious]` f0 −14%；gentle→`[empathetic]` f0 +3%（很轻）；
    soft→`[whispers]` f0 −34% / 响度 −65%。映射表在 `tts-service.py` 的 `EMOTIONS`，
    intensity 会把参数向中性插值。
    **happy 的 `[excited]` 已于 2026-10-23 去掉**（用户「太激动容易破」）——现在 happy 只是
    轻微提速 +0.02、音量不抬，不再把 f0 顶高 18%。`surprised` 的 `[amazed]`（+6%）保留。
  - **`<emphasis>` 有效，且要保留在文本里**：`strip_tags()` 故意不剥它，交给模型原生处理；
    剥掉只留自然语言「说重一点」反而没用（实测带标签比不带宽 +0.9s，停顿也变大）。
  - **语速 `bailian.rate`**：实测 speech_rate=1.0 约 250 字/分（偏快），0.88 约 220、
    0.85 约 210。**现在是 1.0（原速，跟参考录音一致）**——2026-10-23 用户要「按原声」，
    嫌快再往 0.88/0.85 降。用 `speech_rate` 参数，不用 SSML prosody
    （prosody `slow` 无效，`x-slow` 又慢过头 +64%）。
  - **SSML 实测边界**（`scripts/ssml-variance.py`，同一输入结果确定、sd=0）：
    `<prosody rate="slow">` 无效（−0.09s）；`rate="x-slow"` 有效但过慢；`<break>` 不按毫秒兑现
    （要 1500ms 只多 0.19s）。真正好用的是情绪标签 + `<emphasis>` + `speech_rate` 参数。
  - **体检脚本 `scripts/voice-quality-check.mjs`**（`--send` 发 QQ）：渲染后量响度
    （`measureFile`）、量音高曲线（`pitchCurve`，需要 numpy——已装在 `/opt/bailian`）、
    量语速和停顿次数，最后跟一条「无场景无起伏指令」的平读对照比。
    2026-10-23 首次体检结论：`音高起伏/中心带占比/逐帧抖动` 语境版与平读几乎一样，
    说明**「重音」和「别匀速同音调」这两条指令对 Qwen-Audio-TTS 几乎无效**；
    真正起作用的是**响度动态(LRA)**：语境版 3.1~6.8 LU vs 平读 1.1 LU。
  - **旧的 `BALANCE_CHAIN` 已经不在代码里**：现在 `tts-service.py` 只做
    `normalize()`（峰值）或 `loudness:"loud"`（LUFS），没有那串 `loudnorm+LRA18+alimiter`
    的均衡链。看到旧笔记提到它，按「已移除」理解。
  - **轻度降噪：没做，有意为之**。TTS 本来就是合成音，没有底噪可降；`master()` 那条
    （高通70/低通7600/压缩/loudnorm/垫 −52dB 粉噪）是 edge-tts 时代给假「人味」的，
    百炼链路不走它。要给百炼加降噪，得先有实测证据说它糊。
  - 百炼服务：systemd `bailian-tts`，脚本 `qq-agent/scripts/tts-service.py`，
    venv `/opt/bailian`，密钥在 `/root/.bailian.env`（600）。健康检查 `curl 127.0.0.1:3911/health`。
  - 语音稿规范写在 `src/index.mjs` 的 `voiceHint()`：要像微信随口说，给了好坏例子
    （「诶……你咋才回啊」 vs 「你怎么现在才回复我」），按心情换说法，刚发过会劝退。
  - **主人点名要语音（2026-10-23 修）**：`voiceHint` 原来硬性要求「心情必须是高兴」，
    不满足就直接告诉模型「这轮不发语音」——跟 `ownerRule` 的「他让你发语音就照办」打架，
    模型永远挑更具体的那条，于是主人说「发句语音听听」它每次都用「嗓子罢工」推掉。
    现在 `asksForVoice()`（`src/voice-intent.mjs`）认出请求后直接放行（绕过心情/时段/怒气/冷却）；
    模型要是还不写 `__SEND_VOICE__`，发送阶段会拿它正文第一句兜底合成一条。
    测试：`node tools/test-voice-intent.mjs`。
  - **「心情必须高兴」已删（2026-10-23 晚）**：这条是语音发不出来的主因——`lastMood` 几乎
    永远不是「高兴」，等于把语音锁死。**字数限制也删了**（原来写死 12 字，用户说不是他设的）。
    现在只剩：非 0~6 点、不是 Lv≥2 生气。示例从写死 `"emotion":"happy"` 改成
    `gentle`，并要求按当前心情挑。
  - **条数/间隔限制已取消（2026-10-25，用户原话「取消单位时间内发语音条数的限制」）**：
    `voiceGate()` 里原先那条 `距上次语音才 N 秒，没满 1 分钟` 已删（连同 `sinceVoice` 变量），
    `session.lastVoiceAt` 仍照常记录但不再参与判断。同时支持**一轮多条**：
    `voice-intent.mjs` 的 `extractVoiceDirective()` 改成收集 `texts` 数组（`MAX_VOICES_PER_REPLY = 5`，
    超出的丢掉），`index.mjs` 发送处逐条发、每条之间 `sleep(800)`，单条失败就停、不连坐。
    `voiceHint()` 也加了两句：主人点名时可以写多行 `__SEND_VOICE__`（最多 5 条，不用隔时间）；
    常规分支同样允许，但提示「别没事硬刷」。回归：`extractVoiceDirective('__SEND_VOICE__ a\n__SEND_VOICE__ b').texts` 长度为 2。
  - **主动开口也能发语音（2026-10-23 晚）**：`selfwake` 原来只会发文字。现在 prompt 末尾
    会给一条「这次也可以只发语音」的选项，条件走同一个 `voiceGate()`（非 0~6 点、
    非生气 Lv≥2、距上次语音满 1 分钟）。模型写了 `__SEND_VOICE__` 就合成一条，
    没写就照常打字——是「可以」不是「必须」。`extractVoiceDirective()` 挪到了
    `src/voice-intent.mjs`，桥和 selfwake 共用。测试：`node tools/test-selfwake-voice.mjs`。
  - 失败回退：`renderBailianVoice` 抛错 → `renderPlainVoice`（edge-tts 原版），不会把整轮带崩。
  - 其它可选 `style`：`plain`（edge 原版）、`mood`（edge + 语速音高）、`natural`（分句+气口，已否决）。
  - `config/config.json` 的 `voice` 里还有 `maxChars`（一条最多多少字）、`bailian.voice`（音色 ID）、
    `bailian.padTailSeconds`（尾部补静音，默认 0.5 秒，防止 QQ 转码吃掉最后一个字）。
  - 对比样片：`voice-samples/v2/试听.html`（edge 时代）；白清岚样本见 QQ 聊天记录。
  - 试渲染/发样本：`scripts/voice-bailian-live.mjs`（端到端）、`scripts/send-baiqinglan.mjs`、
    `scripts/mood-samples.mjs`、`scripts/voice-test-one.mjs`。
- **听语音（2026-10-23 已上线）**：QQ 语音是 SILK（`#!SILK_V3`），系统 ffmpeg 解不了。
  现在的链路：`get_record out_format=wav`（NapCat 自己带解码器）→ ffmpeg 转 16k 单声道 →
  POST 给本机 SenseVoice 服务 `127.0.0.1:3912/asr` → 桥里变成 `[语音转写：……]`。
  - 服务：systemd `qq-asr`，脚本 `qq-agent/scripts/asr-service.py`，venv `/opt/asr`，
    模型 `/opt/asr/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（int8，229MB，
    从 hf-mirror 拉；GitHub release 是 999MB 整包且限速到 30KB/s，别用）。
    健康检查 `curl 127.0.0.1:3912/health`；模型加载 ~1.1s，5.35s 语音转写 264ms（实测原句全对）。
  - 客户端 `src/asr.mjs`：任何一步失败都退回 `[对方发了段语音，你没听清]`，不影响回复。
  - 注意：sherpa-onnx 1.13 **没有** `sherpa_onnx.read_wave`，服务里用 `wave` + numpy 自己读。
- 边缘 TTS 在 `/opt/tts` venv（`/opt/tts/bin/edge-tts`），`ffmpeg` 系统自带；百炼 TTS 在 `/opt/bailian`。

