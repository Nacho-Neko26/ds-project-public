import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  gate: { enabled: true },
  napcat: { wsUrl: 'ws://127.0.0.1:3001', token: '' },
  lists: { privateAllow: [], groupAllow: [] },
  trusted: [],
  reply: {
    silenceToken: '<SKIP>',
    // 两行短句（没空行）自动拆成两条发
    splitShortLines: true,
    maxCharsPerMessage: 700,
    quoteReplyInGroup: true,
    debounceMs: { private: 0, group: 2500 },
    cooldownMs: { private: 0, group: 8000 },
    rateLimit: { perChatPerMinute: 20, globalPerMinute: 60 },
    // 群级静音：主人（或被禁言指令允许的人）说「/闭嘴」→ 本会话静音 muteMs 毫秒，说「/张嘴」解除。
    // 静音期间收到任何消息都不回、不进模型（只记日志），也不消耗额度。
    mute: { enabled: true, ms: 120000 },
    // 慢回复时先垫一句（中性文案，想换成角色口吻就改这里）
    ackOnSlow: { enabled: false, afterMs: 20000, text: '等一下…' },
    // 群聊里「没人点名、话题也没戳到自己」时的主动接话概率。
    // default 兜底；想给某个群单独设就写群号：{ default: [0.2, 0.4], '<GROUP_ID_2>': [0.5, 0.7] }
    groupChance: { default: [0.2, 0.4] },
    // 2026-10-28 用户定：「被 @ 之后 N 分钟内的消息也跟着喂」，默认 5 分钟。
    // 窗口内群里谁说的话都会进模型（但她不一定要回）；0 = 关掉这个窗口。
    wakeWindowMinutes: 5,
    // #群聊 静音 加进来的群号：这些群一句话都不回（主人发 #群聊 解除 穿透）
    muteGroups: [],
  },
  // 戳一戳（2026-10-28 用户 m03600「按你的方案执行」）
  // 收到的戳走 notice 事件；发出的戳由模型输出一行 __POKE__ 触发。
  poke: {
    enabled: true,
    // 同一个人多久之内只理一次（毫秒），免得他戳一下就陪着玩半天
    replyCooldownMs: 600000,
    // 一分钟内连着戳几次就当成「戳坏了」，这一波不再理
    annoyWithinMs: 60000,
    annoyCount: 3,
    // 主动戳：同一个会话每分钟最多一次
    outCooldownMs: 60000,
    // 第 1~8 档「被戳了理不理」的概率；第 6 档往上基本都会理
    replyChanceByStage: [0, 0, 0.1, 0.25, 0.5, 0.7, 0.95, 1, 1],
  },
  context: {
    // 历史只放「刚才在说什么」：时间窗 + 条数 + 字数三道闸
    maxMessages: 14, maxChars: 2800, maxAgeMinutes: 40, maxPromptChars: 9000,
  },
  // 素材目录每轮都进 prompt，按条数限量
  stickers: { local: 8, shared: 16, labelChars: 12 },
  // 发语音：模型输出 __SEND_VOICE__ <要说的话>，桥用 TTS 合成后发一条语音消息
  // style: bailian=百炼白清岚（默认）/ mood=edge+心情参数 / plain=原样念 / natural=分句+韵律+气口
  voice: {
    enabled: true,
    voice: 'zh-CN-XiaoyiNeural',
    style: 'bailian',
    rate: '+0%',
    pitch: '+0Hz',
    breath: true,
    roomTone: true,
    bin: '/opt/tts/bin/edge-tts',
    ffmpeg: 'ffmpeg',
    // 百炼语音：本机 Python 服务（scripts/tts-service.py）
    bailian: {
      url: 'http://127.0.0.1:3911/tts',
      voice: 'baiqinglan_v3.1',
      timeoutMs: 30000,
      // 尾部补静音秒数：QQ 转码会吃掉尾巴，垫一点防止最后一个字被截
      padTailSeconds: 0.5,
      // 语速系数：实测 1.0 约 250 字/分，0.88 约 220，0.85 约 210
      rate: 0.88,
      // 日常：融合 1（自然）+ 2（撒娇），别太夸张
      defaultInstruction: '用撒娇的语气，但别太夸张，自然一点',
      // 场景：模型每轮补一行 __VOICE_META__，拼在指令末尾（见 composeInstruction）
      //   breath=false 关掉气声；pauses=false 关掉「……」停顿；tail 固定追加一句
      breath: true,
      pauses: true,
      emphasis: true,
      vary: true,
      // 响度均衡（loudnorm + alimiter），关掉就是百炼原样
      balance: true,
      tail: '',
      maxSceneChars: 90,
      instructions: {
        困: '用日常聊天、放松、带一点点撒娇的语气',
      },
    },
    // 宿主机目录（桥写文件）与容器内目录（NapCat 读文件）必须挂载到同一处
    dir: '/root/napcat/data/voice',
    containerDir: '/app/voice',
    // 一条语音最多多少字：40 字约 8 秒，再长就不像随手录的了
    maxChars: 60,
  },
  agent: {
    profile: 'headless', taskTimeoutMs: 180000, maxConcurrent: 2,
    cwd: 'workspace', telemetry: 'off', jsonEvents: true,
  },
  // 滚动摘要：把被时间窗切掉的历史压成几行，接着聊也不忘
  summary: { enabled: true, everyMessages: 80, takeMessages: 60, maxBlocks: 4, maxChars: 700 },
  // 主动开口：桥自己定时发起，不依赖 dsh 进程活着
  selfwake: {
    enabled: false, dryRun: false, tickSeconds: 60,
    intervalMinutes: 25, jitterMinutes: 10, minIdleMinutes: 20,
    maxUnanswered: 3, backoffPerUnanswered: 0.6, replyWindowMinutes: 10,
    dailyMax: 8, quietStartHour: 0, quietEndHour: 7, maxChars: 120,
  },
  // 人设与身份槽位。
  //   身份类内容（名字/自称/昵称/称呼/外号/设定域）不写在代码里，统一从 character 读；
  //   值写成 "{{...}}" 或留空 → 运行期退回中性文案，不会把占位符发出去。
  persona: {
    file: 'persona/persona.md',
    discloseWhenAsked: true,
    ownerUids: [<OWNER_QQ>],
    // 语料库：按当前情绪档抽几条骨架注入每轮 prompt（不抽 I3「饭」栏，那栏会把讨饭禁句顶回来）
    corpus: {
      enabled: true,
      file: 'persona/corpus.md',
      samplesPerTurn: 8,
    },
    // 被叫到时算「在叫它」的外号；填了才生效（为空时只认 @ 和 eye.keywords）
    aliases: [],
    character: {
      name: '',
      selfRef: '',
      defaultNick: '',
      ownerTitle: '',
      aliases: [],
      improvWorld: '',
    },
  },
  // 「眼」：什么时候算跟自己有关。
  //   2026-10-24 发言规则：不句句关注，只有 @ / 句子里叫了称呼才回；
  //   被 @ 之后短暂 full 窗口（fullWindowMs 毫秒）内可回复上下文的普通消息。
  eye: {
    fullWindowMs: 600000,
    // 通用触发词（当前不靠 keywords 触发，保留备用）；角色专属的词放 persona.aliases
    keywords: [
      '在吗', '在干嘛', '干嘛呢', '晚安', '早安', '早上好', '睡觉', '摸鱼', '上班', '下班',
      '加油', '好累', '累死', '难过', '开心', '哈哈哈', '可爱', '笨蛋', '傻', '想你', '喜欢你',
      '唱歌', '干啥', '咋了', '怎么了',
    ],
  },
  control: { port: 3899, host: '127.0.0.1' },
  // 情绪引擎 v2：全局双轴（valence/arousal）+ 余温（residual/inertia）。
  // 好感不在这里：一律复用 workspace/profiles/*.json 里的 person.favor（favor.mjs ensureFavor）。
  // enabled=false 时整块退回旧行为（心情行恢复、__MOOD__ 忽略、#心情 报「已关闭」）。
  // 与 src/emotion.mjs 的 EMOTION_DEFAULTS 同源，改动需同步。
  emotion: {
    enabled: true,
    baseline: { valence: 0.55, arousal: 0.35 },
    decayPerMinute: 0.002,
    inertia: 0.62,
    residualHalfLifeMinutes: 20,
    maxModelDelta: 0.2,
    angerClamp: { lv2: 0.40, lv3: 0.25 },
    stateFile: 'data/emotion.json',
  },
  // 表现层 v1（docs/emotion-v2.md §15）：只读情绪快照与好感，管「怎么说」。
  // enabled=false 时退回 §6.2 的状态块直接注入（情绪照常算）。
  // 与 src/expression.mjs 的 EXPRESSION_DEFAULTS 同源，改动需同步。
  expression: {
    enabled: true,
    expressionFile: 'data/expression.json',
    speechHabitChars: 120,
    memeMax: 12,
    memeCooldownMs: 45000,
    garrulousThreshold: 3,
    garrulousCooldownMs: 90000,
    historyStyleN: 8,
    diversityThreshold: 0.6,
    collectionMax: 200,
    emojiCooldownMs: 120000,
    emojiMimicWindowMin: 5,
    topicMemoryMax: 8,
    topicMemoryTtlMinutes: 180,
    topicResurfaceEnergy: 0.60,
    maxCharsSoft: 60,
    bubbleChancePerRound: 0.08,
    // §16 表情中枢（docs/16-memehub-implementation.md）。enabled=false 时全链路退回今天的行为。
    memeHub: {
      enabled: false,
      joinFormation: false,
      multiSend: false,
      memeWar: false,
      formationN: 3,
      formationChance: 0.6,
      formationCooldownMs: 300000,
      formationMaxPerHour: 2,
      multiSendChance: 0.25,
      multiSendMax: 2,
      multiSendCooldownMs: 180000,
      warWindowMs: 120000,
      warTriggerN: 3,
      warChance: 0.5,
      warMaxPerHour: 2,
      warCooldownMs: 600000,
      reviewPoolEnabled: true,
      reviewPoolMinHits: 2,
      sourceRateLimitPerHour: 10,
      collectionDigestTtlDays: 30,
      tagMin: 3,
      tagMax: 8,
      collectedSubdir: 'collected',
    },
  },
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch ?? base;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

export function configPath() {
  return path.join(ROOT, 'config', 'config.json');
}

export function loadConfig() {
  const file = configPath();
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败：${e.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);

  const privateAllow = new Set((cfg.lists.privateAllow ?? []).map(Number).filter(Boolean));
  const groupAllow = new Map(
    (cfg.lists.groupAllow ?? [])
      .map((g) => [Number(g.groupId), g.mode === 'mention' ? 'mention' : 'full'])
      .filter(([id]) => Number.isFinite(id) && id > 0),
  );
  const trusted = new Set((cfg.trusted ?? []).map(Number).filter(Boolean));

  return {
    raw: cfg,
    privateAllow,
    groupAllow,
    trusted,
    root: ROOT,
    personaFile: path.resolve(ROOT, cfg.persona.file),
    agentCwd: path.resolve(ROOT, cfg.agent.cwd),
    dataDir: path.resolve(ROOT, 'data'),
    logDir: path.resolve(ROOT, 'logs'),
    patchesDir: path.resolve(ROOT, 'patches'),
  };
}
