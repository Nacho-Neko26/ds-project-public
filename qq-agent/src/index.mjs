import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { initCharacter, char, charName, selfRef, defaultNick, allNames, escapeRe } from './character.mjs';
import { OneBot } from './onebot.mjs';
import { HistoryStore, speakerLabel } from './context.mjs';
import { renderSegments, renderForwardMessages, stripAtLabels, isFavorCommand } from './render.mjs';
import { asksForVoice, extractVoiceDirective } from './voice-intent.mjs';
import { AgentRunner, buildPrompt, readCredential, pickGroupMessage } from './agent.mjs';
import { startControl } from './control.mjs';
import { downloadImage } from './media.mjs';
import {
  downloadFile, copyLocalFile, humanSize, textPreview,
} from './files.mjs';
import { resolveAnimatedSheet, trustedAnimatedHint, describeAnimatedHint, imageKindOf } from './animation.mjs';
import { computeStatus } from './status.mjs';
import {
  updateEmotion, applyModelDelta, loadEmotion, saveEmotion, emotionConfig,
  renderMoodCard, parseMoodCommand, parseMoodDirective,
} from './emotion.mjs';
import {
  updateExpression, recordSpeech, expressionConfig,
  ingestImage, tagEmoji, takeTagJobs, memeHubConfig, parseDescPayload, loadExpression,
} from './expression.mjs';
import { resolveStickerPath } from './stickerfile.mjs';
import { loadUsage, recordUse, sentRecently, uniqueRows, loadRotate, saveRotate, sampleWindow } from './sticker-usage.mjs';
import { loadFaceUsage, recordFaces, topFaces } from './face-usage.mjs';
import { renderBrief, createBriefWatcher } from './brief.mjs';
import { latestDiary, ensureYesterdayDiary, dayKey, recentDiaries, compactDiaries, backtrackDiaries, renderBacktrack, lastClearDay, setLastClearDay } from './diary.mjs';
import { readHabits, updateHabits, habitsConfig } from './habits.mjs';
import { learnMemories, renderMemory, memoryConfig } from './memory.mjs';
import { appendMemory, queryMemory, removeMemory, clearMemory } from './memory.mjs';
import { querySlang, submitSlang, renderSlang } from './slang.mjs';
import { getBalance, maybeNotifyHungry, balanceConfig, recordBalancePoint, computeSpend, balanceLineFor } from './balance.mjs';
import { getAmbient, renderAmbient } from './ambient.mjs';
import { createSelfwake, selfwakeConfig } from './selfwake.mjs';
import { createGreeting } from './greeting.mjs';
import { createUpdateCheck } from './updates.mjs';
import { tick as purposeTick, takePending as purposeTakePending, markSpoken as purposeMarkSpoken, purposeSetMuted } from './purpose.mjs';
import { readSummary, maybeSummarize } from './summary.mjs';
import { maybeDigestKnowledge } from './knowledge-digest.mjs';
import { autoReviewKnowledge } from './kb-review.mjs';
import { listMemory, readMemory, writeMemory, searchMemory } from './memfiles.mjs';
import { loadCorpus, pickCorpusSamples, renderCorpusHint } from './corpus.mjs';
import { renderPlainVoice, renderVoice, renderMoodVoice, renderBailianVoice } from './voice.mjs';
import { extractDirectives, normalizeDirectiveLines, scrubDirectiveLeaks } from './directives.mjs';
import { stripThinkingLeak, cleanToolReport } from './thinking-guard.mjs';
import { rankRows as rankStickerRows } from './sticker-score.mjs';
import { enrichRows, semBadge, faceSemantics } from './sticker-semantics.mjs';
import {
  addReminder, cancelReminder, listReminders, renderReminders, startReminderTicker, fmtAt, remindersConfig,
} from './reminders.mjs';
import { guessReminder } from './remind-guess.mjs';
import {
  runAdminOp, getBotRole, adminHint, adminConfig,
} from './admin.mjs';
import { stickerSelfGate, lastStickerAt } from './sticker-moment.mjs';
import { loadTable, filterByGate, matchHash, matchCommand, matchFuzzy, renderHints, renderOwnerRule, levelOf, renderLevelRule } from './commands-table.mjs';
import {
  runOwnerCommand, isOwnerCommandName, bridgeMuted, limitOffActive, relationLocked, readOwnerState,
} from './owner-cmds.mjs';
import {
  onPoked, markPokeReplied, canPokeOut, markPokedOut, renderPokeHint, pokeConfig, extractPokeDirective,
} from './poke.mjs';
import { sendSong, musicHint, musicConfig } from './music.mjs';
import { maybePostDaily, qzoneConfig, qzoneState } from './qzone.mjs';
import { resolveRecords, asrConfig } from './asr.mjs';
import {
  updateAnger, loadProfiles, saveProfiles, angerTarget, callName, touchIntimacy, sootheHint, ANGER_LEVELS,
  analyzeBatch, setGlobalNick,
} from './anger.mjs';
import {
  FAVOR, ensureFavor, rollDay, applyFavor, applyPersuade, settleDailyChat, settleHourlyChat,
  tierOf, tierText, beijingNow, qualifiedFavor, tierOfPerson, BOUNDARY,
  renderNotebook, writeNotebook, applyAngerPenalty, restoreAngerPenalty, slowGrowth, readFavorMap,
  parseSleepMention, renderFavorCard, applyTrust, checkTrustZero, isSilenced, TRUST_ZERO_PENALTY,
  syncExclusive, applyConfidantTrustDrop, EXCLUSIVE, setRelationLocked,
} from './favor.mjs';
import {
  log, chunkText, sleep, appendJsonl, readJsonl, ensureDir, hhmm, safeFileName, splitMessages,
  splitOverlongMessage, autoSplitLong, nameHit,
} from './util.mjs';
import { detectSingRequest, detectSingAsk } from './sing-intent.mjs';
import { recordIdentity, renderIdentityBlock, resolveMentions } from './identity.mjs';
import {
  enqueueCover, rememberCoverJob, startCoverWatcher, ensureCoverDirs, executorOnline,
  readDefaultVoice, writeDefaultVoice, readVoiceCatalog, engineForVoice,
} from './cover.mjs';
import { pickOnlineReply, pickOfflineReply, pickAskSong, pickAskNotYet } from './cover-reply.mjs';
import { pickLocalOkReply, pickLocalMissReply } from './local-reply.mjs';
// 本机处理（2026-10-28 用户要求）：「传输文件用本机 dsh 操作后再发回」。
// 和翻唱同一套拉模式：桥排队 → 本机 tools/local-agent.py 来拉 → 做完把产物传回 done/。
import {
  ensureLocalDirs, enqueueLocal, localExecutorOnline, localQueueDepth,
  rememberLocalInput, lastLocalInput, extractFileDirective, sendFileToChat, startLocalWatcher,
} from './localfile.mjs';
import { listVoices, voicesError, pickVoice, ensureRemote } from './voicelib.mjs';
// 出站闸（2026-10-28）：说出口之前把本机路径、凭据原文、受保护的号打掉。
import { auditOutbound, escapeCq } from './outbound.mjs';

let cfg = loadConfig();
initCharacter(cfg);
ensureDir(cfg.dataDir);
ensureDir(cfg.logDir);
ensureDir(cfg.agentCwd);

// 表情/图片素材库：存进 workspace，号主的 agent 也能读到并转发
const stashDir = path.join(cfg.agentCwd, 'stickers');
ensureDir(stashDir);
// 图片下载落点
const incomingDir = path.join(cfg.agentCwd, 'incoming');
ensureDir(incomingDir);

const state = {
  paused: false,
  self: null,
  startedAt: Date.now(),
  stats: { received: 0, replied: 0, skipped: 0, failed: 0, ignored: 0, turns: 0, tokensIn: 0, tokensCache: 0, tokensOut: 0 },
  logs: [],
  busy: 0,
  // 日记：启动时读最近一篇；换天后重新读昨天那篇
  diary: null,
  diaryTurnsLeft: 0,
  diaryDay: '', // 空字符串 → 首次调用必然走「换天」分支，补写昨天的日记
  // 余额
  balance: null,
  balanceAt: 0,
  lastSession: null, // 最近说过话的会话（余额喊饿已改为固定发主人私聊，不再用它）
  // 她自己要的安静（__WAKE__ off）：时间戳，过了就自动恢复
  wakeOffUntil: 0,
};

/**
 * 换天检查：到了新的一天
 *   1. 先把昨天的日记写出来（约 500 字），
 *   2. 把对话记录归档并清空（每 24 小时清一次），
 *   3. 之后每轮注入最近三天的日记。
 * 提到更早的事时，另由 backtrackDiaries 逐日回溯。
 */
const DIARY_INJECT_TURNS = 3;
async function refreshDiaryIfNeeded() {
  const today = dayKey();
  if (state.diaryDay === today && state.diaryTurnsLeft > 0) return;

  if (state.diaryDay !== today) {
    state.diaryDay = today;
    state.diaryTurnsLeft = 0;
    state.diaryFirstTurnDone = false;
    // 只有「今天还没清过」才做这套：写日记 → 归档清空 → 落标记。
    // 落盘标记是为了重启后不重复清空（踩过：重启一次把当天记录全归档走了）。
    if (lastClearDay(cfg.agentCwd) !== today) {
      try {
        const made = await ensureYesterdayDiary({ runner, cfg });
        if (made) note('info', `昨天的日记已就绪（${made.key}）`);
      } catch (e) {
        note('warn', `日记生成失败: ${e.message}`);
      }
      // 归档 + 清空对话记录：日记写完才清，否则素材就没了
      try {
        const n = history.archiveAndClear();
        setLastClearDay(cfg.agentCwd, today);
        if (n) note('info', `对话记录已归档清空（${n} 条），后续靠日记回忆`);
      } catch (e) {
        note('warn', `归档对话记录失败: ${e.message}`);
      }
    }
  }

  const list = recentDiaries(cfg.agentCwd, 3);
  if (list.length) {
    state.diaries = list;
    state.diaryTurnsLeft = DIARY_INJECT_TURNS;
  } else {
    state.diaries = [];
    state.diaryTurnsLeft = 0;
  }
}

function note(level, msg, extra) {
  log(level, msg, extra);
  const line = `${hhmm(Date.now())} ${level.toUpperCase()} ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 300) state.logs.shift();
}

/* ---------- 并发闸门 ---------- */
class Semaphore {
  constructor(n) { this.n = Math.max(1, n); this.queue = []; }
  get used() { return this.n - this.queue.length - (this.active ?? 0); }
  async acquire() {
    if ((this.active ?? 0) < this.n) { this.active = (this.active ?? 0) + 1; return; }
    await new Promise((r) => this.queue.push(r));
    this.active = (this.active ?? 0) + 1;
  }
  release() {
    this.active = Math.max(0, (this.active ?? 0) - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}
let sem = new Semaphore(cfg.raw.agent.maxConcurrent);

/* ---------- 业务对象 ---------- */
const ob = new OneBot(cfg.raw.napcat);
let history = new HistoryStore(cfg.dataDir, cfg.raw.context);
let runner = new AgentRunner(cfg);

/* ---------- 会话 ---------- */
const sessions = new Map();
const seenIds = new Set();
const globalReplyTimes = [];

function rememberId(id) {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > 2000) {
    const first = seenIds.values().next().value;
    seenIds.delete(first);
  }
  return true;
}

function getSession(key, kind, id, title) {
  if (!sessions.has(key)) {
    sessions.set(key, {
      key, kind, id, title,
      buffer: [], timer: null, busy: false,
      lastReplyAt: 0, replyTimes: [],
      lastActivityAt: 0,  // 最后一次收到人类消息的时间（主动开口要看它安静了多久）
      lastVoiceAt: 0,      // 上次发语音的时间，用来防止连着发
      msgSinceHabits: 0,   // 距上次学说话习惯累计了多少条
      habitsUpdating: false,
      habits: '',          // 缓存的习惯文本
      msgSinceMemory: 0,   // 距上次记东西累计了多少条
      memoryUpdating: false,
      memoryText: '',      // 缓存的记忆渲染
      fullUntil: 0,        // @ 后短暂 full 窗口截止时间戳（2026-10-24 发言规则）
    });
  }
  return sessions.get(key);
}

/** 攒够消息就异步让它往记忆里添东西 */function maybeLearnMemory(session) {
  const conf = memoryConfig(cfg);
  if (!conf.enabled || session.memoryUpdating) return;
  if (!session.key.startsWith('group:')) return;

  session.msgSinceMemory = (session.msgSinceMemory || 0) + 1;
  if (session.msgSinceMemory < conf.everyMessages) return;

  session.msgSinceMemory = 0;
  session.memoryUpdating = true;
  void learnMemories({
    runner, cfg, chatKey: session.key, chatTitle: session.title,
  })
    .then((added) => {
      if (added.length) {
        session.memoryText = renderMemory(cfg.agentCwd, session.key);
        note('info', `[${session.key}] 记下 ${added.length} 件事`);
      }
    })
    .catch((e) => note('warn', `[${session.key}] 记忆失败: ${e.message}`))
    .finally(() => { session.memoryUpdating = false; });
}

/** 攒够消息就异步更新一次「在这个群该怎么说话」 */
function maybeLearnHabits(session) {
  const conf = habitsConfig(cfg);
  if (!conf.enabled || session.habitsUpdating) return;
  if (!session.key.startsWith('group:')) return;

  session.msgSinceHabits = (session.msgSinceHabits || 0) + 1;
  if (session.msgSinceHabits < conf.everyMessages) return;

  session.msgSinceHabits = 0;
  session.habitsUpdating = true;
  void updateHabits({
    runner, cfg, chatKey: session.key, chatTitle: session.title,
  })
    .then((h) => {
      if (h) {
        session.habits = h;
        note('info', `[${session.key}] 学到新的说话习惯（${h.split('\n').length} 条）`);
      }
    })
    .catch((e) => note('warn', `[${session.key}] 学习习惯失败: ${e.message}`))
    .finally(() => { session.habitsUpdating = false; });
}

/* ---------- 余额 ---------- */
/** 主动发一条（不是回复） */
async function sendProactive(session, text) {
  const seg = [{ type: 'text', data: { text } }];
  if (session.kind === 'group') await ob.sendGroup(session.id, seg);
  else await ob.sendPrivate(session.id, seg);
  history.append(session.key, {
    t: Date.now(), role: 'bot', name: charName('我'), text,
  });
}

/**
 * 选一个会话去喊饿：**只喊主人私聊**，永远不落到群里。
 * 2026-10-26 用户原话「余额提醒发给私聊」「不要发群里」。
 * 之前是「优先最近说过话的会话」→ 哪个群聊得多就喊到哪个群，群里所有人都看得见账上剩几块钱。
 * 想换收件人：config.json 的 balance.notifyQQ 填一个 QQ 号，覆盖 persona.ownerUids[0]。
 */
function pickNotifyTarget() {
  const conf = balanceConfig(cfg);
  const owner = Number(conf.notifyQQ) || Number((cfg.raw.persona?.ownerUids ?? [])[0]) || 0;
  if (!owner) return null;
  return getSession(`private:${owner}`, 'private', owner, `私聊 ${owner}`);
}

async function checkBalance({ force = false } = {}) {
  const conf = balanceConfig(cfg);
  if (!conf.enabled) return;
  const cny = await getBalance({
    // 余额只认官方账户：模型已切到中转站，DEEPSEEK_API_KEY 现在是中转 key，
    // 拿它查 api.deepseek.com 会 401。官方 key 单独存在 DEEPSEEK_OFFICIAL_KEY。
    apiKey: readCredential('DEEPSEEK_OFFICIAL_KEY') || readCredential('DEEPSEEK_API_KEY'),
    force,
    cacheSeconds: conf.cacheSeconds,
  });
  if (cny === null) return;
  state.balanceAt = Date.now();
  if (state.balance !== cny) {
    state.balance = cny;
    note('info', `余额 ${cny.toFixed(2)} CNY`);
  }
  // 记一个余额点，用来算「花了多少」
  recordBalancePoint(cfg.dataDir, cny);
  state.spend = computeSpend(cfg.dataDir);
  if (cny >= conf.thresholdCny) return;
  const target = pickNotifyTarget();
  if (!target) return;
  await maybeNotifyHungry({
    dataDir: cfg.dataDir,
    cny,
    cfg,
    send: (t) => sendProactive(target, t),
    note,
  });
}

/* ---------- 消息解析 ---------- */
// renderSegments / atLabel 挪到 render.mjs，方便单测（index.mjs 一 import 就会起服务）


/** QQ 黄脸 id → 名字（常用部分），给模型看素材目录用 */
const FACE_NAMES = {
  '0': '惊讶', '1': '撇嘴', '2': '色', '3': '发呆', '4': '得意', '5': '流泪',
  '6': '害羞', '7': '闭嘴', '8': '睡', '9': '大哭', '10': '尴尬', '11': '发怒',
  '12': '调皮', '13': '呲牙', '14': '微笑', '15': '难过', '16': '酷', '17': '冷汗',
  '18': '抓狂', '19': '吐', '20': '偷笑', '21': '可爱', '22': '白眼', '23': '傲慢',
  '24': '饥饿', '25': '困', '26': '惊恐', '27': '流汗', '28': '憨笑', '29': '悠闲',
  '30': '奋斗', '31': '咒骂', '32': '疑问', '33': '嘘', '34': '晕', '35': '折磨',
  '36': '衰', '37': '骷髅', '38': '敲打', '39': '再见', '40': '擦汗', '41': '抠鼻',
  '42': '鼓掌', '43': '糗大了', '44': '坏笑', '45': '左哼哼', '46': '右哼哼',
  '47': '哈欠', '48': '鄙视', '49': '委屈', '50': '快哭了', '51': '阴险', '52': '亲亲',
  '53': '吓', '54': '可怜', '55': '菜刀', '56': '西瓜', '57': '啤酒', '58': '篮球',
  '59': '乒乓', '60': '咖啡', '61': '饭', '62': '猪头', '63': '玫瑰', '64': '凋谢',
  '65': '示爱', '66': '爱心', '67': '心碎', '68': '蛋糕', '69': '闪电', '70': '炸弹',
  '71': '刀', '72': '足球', '73': '瓢虫', '74': '便便', '75': '月亮', '76': '太阳',
  '77': '礼物', '78': '拥抱', '79': '强', '80': '弱', '81': '握手', '82': '胜利',
  '83': '抱拳', '84': '勾引', '85': '拳头', '86': '差劲', '87': '爱你', '88': 'NO',
  '89': 'OK', '90': '爱情', '91': '飞吻', '92': '跳跳', '93': '发抖', '94': '怄火',
  '95': '转圈', '96': '磕头', '97': '回头', '98': '跳绳', '99': '挥手', '100': '激动',
  '101': '街舞', '102': '献吻', '103': '左太极', '104': '右太极',
};

const SHARED_FILE = path.join(stashDir, '_shared.jsonl');

function stickerLimit(name, dflt) {
  const v = Number(cfg.raw.stickers?.[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** 素材的一行标签。压到最短：目录每轮都进 prompt，多一个字都是白烧。 */
/**
 * 目录标签：收到的图没有 seg.summary，光靠 labelOf 每条都是「图片」。
 * 这里先用已经读过的描述缓存（不另外花 token），再用表情库里的摘要。
 */
const stickerLabelCache = new Map();
function shortLabel(t) {
  const clean = String(t || '').replace(/[\[\]]/g, '').trim();
  if (!clean) return '';
  const max = stickerLimit('labelChars', 12);
  return clean.length > max ? clean.slice(0, max) : clean;
}
const stickerAnimCache = new Map();
function stickerLabel(row) {
  const base = labelOf(row?.rec?.seg);
  if (base && base !== '\u56fe\u7247') return base;
  const f = resolveStickerPath(row?.rec, stashDir);
  if (!f) return base;
  const memo = stickerLabelCache.get(f);
  if (memo) return memo;
  let label = base;
  try {
    const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
    const hit = descCache[h]?.text;
    if (hit) label = shortLabel(hit) || base;
    else {
      const it = (loadExpression(cfg).emojiCollection || []).find((e) => e.digest === h);
      if (it?.summary) label = shortLabel(it.summary) || base;
      else if (Array.isArray(it?.tags) && it.tags.length) label = shortLabel(it.tags.join('·')) || base;
    }
  } catch {}
  stickerLabelCache.set(f, label);
  stickerAnimCache.set(f, isAnimatedFile(f));
  return label;
}

/**
 * 目录里区分动图/静图（2026-10-25 用户要求）。
 * 只认扩展名 + GIF/WebP 文件头，不跑 ffmpeg：每次找图都探测帧数太贵，这里只要个标识。
 * 动图在目录里后缀「·动图」，静图不加；发出去时靠 materializeSeg 的 sub_type=1 才会当表情播放。
 */
function isAnimatedFile(file) {
  try {
    if (/\.(gif|webp|apng)$/i.test(file)) return true;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    try { fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }
    const head = buf.toString('latin1');
    if (head.startsWith('GIF8')) return true;
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return true;
    return false;
  } catch { return false; }
}

function animTag(row) {
  const f = resolveStickerPath(row?.rec, stashDir);
  if (!f) return '';
  if (!stickerAnimCache.has(f)) stickerAnimCache.set(f, isAnimatedFile(f));
  return stickerAnimCache.get(f) ? ' ·动图' : '';
}

function labelOf(seg) {
  const d = seg?.data ?? {};
  const short = (t) => {
    const clean = String(t || '').replace(/[「」]/g, '').replace(/^\[动画表情\]$/, '').trim();
    if (!clean) return '';
    const max = stickerLimit('labelChars', 12);
    return clean.length > max ? clean.slice(0, max) : clean;
  };
  if (seg?.type === 'face') return short(FACE_NAMES[String(d.id)] || d.raw?.faceText) || `#${d.id}`;
  if (seg?.type === 'mface') return short(d.summary) || '表情';
  return short(d.summary) || '图片';
}

/** 素材库目录：本会话素材（#N）+ 共享图库（SN） */
/**
 * 表情目录的两条修法（2026-10-25 用户要求「别老发同一张」）：
 * ① 同一张图只出现一次（按落盘文件名去重，留最新编号）；
 * ② 刚发过的暂时不列（默认 25 分钟），剩下的少于 3 条就放开，不至于没得挑。
 */
function stickerKeyOf(rec) {
  const f = resolveStickerPath(rec, stashDir);
  if (f) return path.basename(f);
  const d = rec?.seg?.data ?? {};
  const raw = String(d.file || d.file_unique || d.url || d.path || '');
  const tail = raw.replace(/^.*[\\/]/, '');
  return tail.length > 6 ? tail : '';
}

function pickFresh(rows, usage, now, windowMs) {
  const fresh = rows.filter((r) => !r.key || !sentRecently(usage, r.key, now, windowMs));
  return fresh.length >= 3 ? fresh : rows;
}

/**
 * 小黄脸的语义命中分（2026-10-28）。黄脸没有描述文本，只有名字和 id，
 * 所以只按名字推语义；这句话里出现了哪个语义维度，对应黄脸就往前挪。
 */
function faceHitScore(f, q) {
  const name = String(f?.name || FACE_NAMES[f?.id] || '');
  const tags = faceSemantics(name);
  let s = 0;
  for (const t of tags) if (q.includes(t)) s += 3;
  if (name && q.includes(name.toLowerCase())) s += 2;
  return s;
}

function faceLabelOf(f) {
  const name = f?.name || FACE_NAMES[f?.id] || '表情';
  const tags = faceSemantics(name);
  return tags.length ? `${name} [${tags.join('·')}]` : name;
}

function stickerCatalog(key, hintText = '') {
  const parts = [];

  // 目录每轮都注入，所以只列最近的几条：够挑就行，全量列出来是纯烧 token
  // 目录每轮都注入，只列最近的几条；同一张图不重复列，刚发过的先藏起来
  const usage = loadUsage(cfg.dataDir);
  const now = Date.now();
  const freshWindowMs = Number(cfg.raw.stickers?.freshWindowMs) || 25 * 60000;
  const localMax = stickerLimit('local', 8);
  let rows = pickFresh(uniqueRows(readJsonl(path.join(stashDir, `${safeFileName(key)}.jsonl`), 1000), stickerKeyOf), usage, now, freshWindowMs);
  if (rows.length) {
    // 语义层：给每行补情绪/用途字段，再按这句话的场景排一下，最后才截断
    enrichRows(rows, stickerLabel);
    if (hintText.trim()) rows = rankStickerRows(rows, hintText);
    const start = Math.max(0, rows.length - localMax);
    const lines = [];
    for (let i = start; i < rows.length; i++) lines.push(`#${rows[i].index} ${stickerLabel(rows[i])}${semBadge(rows[i])}${animTag(rows[i])}`);
    // 目录里直接写出"怎么发"，否则模型会照着 #N 抄一个 #4 出来
    parts.push(`【本会话素材】（要发第几条，就单独输出一行 __SEND_STICKER__ 加 # 后面的数字，例如 __SEND_STICKER__ ${rows[rows.length - 1].index}）\n${lines.join('\n')}`);
  }

  const sharedMax = stickerLimit('shared', 30);
  let pool = pickFresh(uniqueRows(readJsonl(SHARED_FILE, 2000), stickerKeyOf), usage, now, freshWindowMs);
  // 每次换一批（2026-10-25 用户要求）：按游标抽 sharedMax 条，避开上一批；抽完游标前移
  const rot = sampleWindow(pool, sharedMax, loadRotate(cfg.dataDir), (r) => r.key);
  saveRotate(cfg.dataDir, rot.state);
  let shared = rot.picked;
  // 语义层：先补情绪/用途字段（打分器读 row.emotion / row.use）
  enrichRows(shared, stickerLabel);
  // 按当前这句话的情绪/场景打分排序（移植 nekowhale 的 search.ts 权重），没查询就保持抽样顺序
  if (hintText.trim() && shared.length) shared = rankStickerRows(shared, hintText);
  // 有查询时把「新收录的图」提到最前面（用户 2026-10-25 要求给新图加权重）：
  // 上面那次排序只为把命中情绪的挑出来，真正该优先露脸的是刚偷进来的那几张
  else if (shared.length) shared = rankStickerRows(shared, '', now);
  const sharedTotal = pool.length;
  if (shared.length) {
    const start = Math.max(0, shared.length - sharedMax);
    const lines = [];
    for (let i = start; i < shared.length; i++) lines.push(`S${shared[i].index} ${stickerLabel(shared[i])}${semBadge(shared[i])}${animTag(shared[i])}`);
    parts.push(`【共享图库】（共 ${sharedTotal} 张，本次抽到 ${shared.length} 张，用完一批会换下一批。要发第几条，就单独输出一行 __SEND_STICKER__ 加 S 开头的编号，例如 __SEND_STICKER__ S${shared[shared.length - 1].index}）\n${lines.join('\n')}`);
  }

  // 【群友常发的黄脸】QQ 小黄脸（face 段），按群里出现次数排序；
  // 2026-10-25 用户要求「群聊天里面的表情也要收录使用」，之前它只显示成「[表情]」不入库。
  const faceUsage = loadFaceUsage(cfg.dataDir);
  let faceRows = topFaces(faceUsage, 12).filter(
    (f) => !sentRecently(usage, `face:${f.id}`, now, freshWindowMs),
  );
  // 语义层：有场景词时把语义对得上的黄脸提到前面（原来纯按群里出现次数）
  if (hintText.trim() && faceRows.length) {
    const q = hintText.toLowerCase();
    faceRows = faceRows
      .map((f, i) => ({ f, i, s: faceHitScore(f, q) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.f);
  }
  if (faceRows.length) {
    const lines = faceRows.map((f) => `F${f.id} ${faceLabelOf(f)}`);
    parts.push(
      `【群友常发的黄脸】（要发就单独输出一行 __SEND_STICKER__ F<编号>，例如 __SEND_STICKER__ F${faceRows[0].id}）\n${lines.join('  ')}`,
    );
  }

  if (!globalThis.__stickerCatLogged && parts.length) {
    globalThis.__stickerCatLogged = true;
    note('info', `[目录] 首次构建：${parts[0].split('\n').slice(1, 5).join(' / ')}`);
  }
  return parts.join('\n\n');
}

/** 把素材目录转成提示，追加到 prompt */
function stickerHint(key, hintText = '', { allowed = true } = {}) {
  // 好感不到门槛的人：一份目录都不列（2026-10-25 用户定，默认门槛 50）
  if (!allowed) return `【表情】这人对你的好感还不到 ${STICKER_FAVOR()}，这轮别发表情，只说话。`;
  const cat = stickerCatalog(key, hintText);
  if (!cat) return '';
  // 2026-10-26 用户改回「想发就发」：不再按情绪类型收窄，有合适的就能配一张；
  // 唯一限制是一分钟内最多一张（看台账里最近一次发图时间）。
  const mayPick = stickerSelfGate(lastStickerAt(loadUsage(cfg.dataDir)));
  const selfPick = mayPick
    ? '【这一轮可以配一张】翻到合适的就挑一张 S 开头发出去再说话；都对不上味儿就只说话，别硬凑。'
    : '【表情这轮先不发】一分钟内刚甩过一张，这轮只说话，等下一轮再说。';
  return `${cat}\n\n${selfPick}\n\n【你自己的样子】被问到「你长什么样」「发张自拍」，或者你自己想露个脸，就单独输出一行 __SELFIE__，桥会把你的形象图发出去（一行一张，答案照常写）。

【记东西 / 查东西】这些不用等指令，你自己就能做。每条都单独占一行，行本身不会发出去：
__MEMORY__ append 一句话        记进这儿（群里就记这个群），一句别超 60 字
__MEMORY__ query 关键词         把记着的调出来看一眼，桥会另发一条给你
__MEMORY__ remove 一句话片段     删掉那条
__MEMORY__ clear               把这一档清空（别乱用）
__SLANG__ query 词              这个叫法是啥意思
__SLANG__ submit 词=意思         学会了新叫法就提报上去，主人过目才算数

【想安静一会儿】这个不用等别人说：单独输出一行 __WAKE__ off 120（单位分钟，最多 720），这段时间谁都不会替你开口；写 __WAKE__ on 立刻恢复。夜里想睡、或者不想被硬拉着说话的时候用。\n\n【收别人的图】看见谁发的图想留下来，单独输出一行 __COLLECT_STICKER__ #3（数字就是本会话素材 # 后面的号）。收进来的会进共享图库，以后你自己也能发。\n\n【改图库说明】哪张图的名字对不上，单独输出一行 __STICKER_REMARK__ S3 侧目嫌弃挥手（S 编号，空格，新说明）。\n\n【有意见就说】觉得哪里别扭、想改什么，单独输出一行 __FEEDBACK__ 内容。这条只给主人看，不进对话。\n\n【挑图】同一张别连着发，刚发过的这次没列出来。目录里带「·动图」的是会动的 GIF，没带的是静图；想发会动的就挑带「·动图」的。\n\n想发某条：单独输出一行 __SEND_STICKER__ <序号>（本会话素材写 # 后的数字，共享图库写 S 开头的编号，黄脸写 F 开头的编号）。这一行不会显示成文字。\n\n【连发】对方点名要几张、或者要刷屏的时候，一行里写多个编号就行：__SEND_STICKER__ S3 S8 S12。一次最多 ${MAX_STICKERS_PER_REPLY} 张，按顺序发，中间会自动隔一下。没被要求就别刷屏。`;
}

/* ---------- 看图：下载 + 描述 ---------- */
const MAX_IMAGES_PER_MSG = 3;

/**
 * 图片描述缓存：同一张图（按内容 hash）只描述一次。
 * 一次 describeImage 要烧掉上万 token（图片 token + 工具往返），
 * 同一个表情包被反复发时全靠这张表省下来。
 */
const descCacheFile = path.join(ensureDir(path.join(cfg.agentCwd, '.cache')), 'image-desc.json');
let descCache = (() => {
  try { return JSON.parse(fs.readFileSync(descCacheFile, 'utf8')); } catch { return {}; }
})();
let descCacheDirty = false;

function hashFile(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return null; }
}

function flushDescCache() {
  if (!descCacheDirty) return;
  descCacheDirty = false;
  try { fs.writeFileSync(descCacheFile, JSON.stringify(descCache), 'utf8'); }
  catch (e) { note('warn', `图片描述缓存写入失败: ${e.message}`); }
}

/** 描述一张图（v2：一次调用带回 summary + tags + moodHints）。命中缓存直接返回
 *  opts.filmstrip = { frames } 时是动图拼图：缓存键加后缀，避免复用「十六张小图」那种旧描述。
 */
async function describeCached(file, hint, opts = {}) {
  const h = hashFile(file);
  const key = h ? h + (opts.filmstrip ? ':filmstrip' : '') : null;
  const hit = key ? descCache[key] : null;
  if (hit?.text) {
    return {
      text: hit.text,
      tags: Array.isArray(hit.tags) ? hit.tags : [],
      moodHints: Array.isArray(hit.moodHints) ? hit.moodHints : [],
      cached: true,
      legacy: !hit.v,
    };
  }
  const desc = await runner.describeImage(file, hint, opts).catch(() => null);
  if (desc?.ok && desc.text) {
    const parsed = parseDescPayload(desc.text);
    if (key) {
      descCache[key] = { v: 2, text: parsed.text, tags: parsed.tags, moodHints: parsed.moodHints, at: Date.now() };
      descCacheDirty = true; flushDescCache();
    }
    return { ...parsed, cached: false, legacy: false };
  }
  return null;
}

/**
 * 把 renderSegments 留下的 [[IMG:n]] / [[MFACE:n]] 占位符换成本地可用的描述。
 * - 可信用户：直接把本地路径交给模型，它自己能 read_image（省一次模型调用）。
 * - 其他人：桥先替它读图，把文字描述塞进 prompt。
 * 描述失败就退化成原来的「看不到」文案，不阻塞回复。
 */
function wantsSaveText(text) {
  const s = String(text || '');
  return /(存|偷|收藏|收下|保存|拿下).{0,6}(图|表情|这个|它|下)/.test(s)
    || /(把|将).{0,8}(图|表情).{0,6}(存|偷|收藏|保存)/.test(s);
}

async function resolveImages(text, images, trusted, meta = {}) {
  if (!images.length) return text;
  let out = text;
  const head = images.slice(0, MAX_IMAGES_PER_MSG);

  await Promise.all(head.map(async (img, i) => {
    const key = img.kind === 'mface' ? 'MFACE' : 'IMG';
    const file = img.url ? await downloadImage(img.url, incomingDir) : null;
    if (!file) {
      // 下载失败也别喂「你看不到」——给个中性标签，让它打哈哈过去
      const fallback = img.kind === 'mface'
        ? '[对方发了个表情包]'
        : '[对方发了张图]';
      out = out.replace(`[[${key}:${i}]]`, fallback);
      return;
    }
    const tag = img.kind === 'mface' ? '表情包' : '图片';

    // §16.2 偷图入库（只群聊；memeHub.enabled=false 时这里什么都不做）
    if (meta.isGroup) {
      try { ingestImage({ cfg, file, meta, now: Date.now() }); }
      catch (e) { note('warn', `[memeHub] 入库失败：${e.message}`); }
    }

    // 动图拆帧：.gif/.webp 先探测是否多帧，是动图就抽帧拼成网格图；失败退回原图逻辑
    // 帧数可配：config.animation.frames（默认 16 = 4×4），长一点的动图也能看全
    const ffmpegPath = cfg.raw?.asr?.ffmpeg || cfg.raw?.voice?.ffmpeg || 'ffmpeg';
    const animCfg = cfg.raw?.animation || {};
    const sheetInfo = await resolveAnimatedSheet(file, incomingDir, {
      ffmpegPath,
      maxFrames: animCfg.frames ?? 16,
      maxWidth: animCfg.maxWidth ?? 1600,
      maxHeight: animCfg.maxHeight ?? 1600,
    });
    if (!sheetInfo) {
      // 动图却没拆出来：留一条 warn，别再静默退化成「只看第一帧」
      const kind = imageKindOf(file);
      if (kind === 'gif' || kind === 'webp') {
        note('warn', `[动图] 拆帧失败（${kind}，ffmpeg=${ffmpegPath}），退回看第一帧`);
      }
    }
    if (sheetInfo) {
      // 先描述：主模型（deepseek-v4.1-flash）不吃图片输入，read_image 必然失败，
      // 所以「给自己留个路径回头自己看」这条路走不通，一律让桥先读成文字。
      const animDesc = await describeCached(sheetInfo.sheet, img.summary, { filmstrip: { frames: sheetInfo.frames } });
      if (animDesc?.text) {
        out = out.replace(`[[${key}:${i}]]`, describeAnimatedHint(sheetInfo.frames, animDesc.text));
      } else if (trusted) {
        const rel = path.relative(cfg.agentCwd, sheetInfo.sheet).replace(/\\/g, '/');
        out = out.replace(`[[${key}:${i}]]`, trustedAnimatedHint(rel, sheetInfo.frames));
      } else {
        out = out.replace(`[[${key}:${i}]]`, describeAnimatedHint(sheetInfo.frames, '（没细看）'));
      }
      return;
    }

    // 同上：不管谁发的，都先让桥把图读成文字。描述失败、且对方是可信用户时，
    // 才退回「给路径自己看」的老路子（将来换支持视觉的模型仍然能用）。
    const desc = await describeCached(file, img.summary);
    if (desc?.text) {
      // 2026-10-28 用户要求「不要只是描述图片，要有自己的回应」：把描述标成「你眼睛看到的」，
      // 并明令别复述，否则模型会把描述原样念一遍。
      out = out.replace(`[[${key}:${i}]]`, `[对方发了一个${tag}，你眼里看到的是：${desc.text}（这是我看到的，别复述这段话，直接说你自己对它的反应）]`);
      return;
    }
    if (trusted) {
      const rel = path.relative(cfg.agentCwd, file).replace(/\\/g, '/');
      out = out.replace(`[[${key}:${i}]]`,
        `[对方发了一个${tag}，已存到 ${rel}；用 read_image 工具看它，再据此回应]`);
      return;
    }
    out = out.replace(`[[${key}:${i}]]`, `[对方发了一个${tag}，没看清里面是什么（别编，也别问他图里写了啥）]`);
  }));

  // 超出上限的图：统一降级
  for (let i = MAX_IMAGES_PER_MSG; i < images.length; i++) {
    const k = images[i].kind === 'mface' ? 'MFACE' : 'IMG';
    out = out.replace(`[[${k}:${i}]]`, '[又一张图]');
  }
  return out;
}

/* ---------- 引用回复：把「他引用的那条」捞回来 ---------- */
// QQ 的 reply 段只带被引用消息的 id，正文一个字都没有；不捞的话模型只能看见
// 引用者自己那句话，完全不知道在接什么。用 NapCat 的 get_msg 取原文，按 id 缓存。
const QUOTE_CACHE = new Map(); // messageId → 渲染好的提示文本（空串表示取不到）
const QUOTE_CACHE_MAX = 200;

/* 协议端跑在 docker 里，get_image / get_file 回的是容器内路径；宿主机上是另一棵树。
 * 按 docker-compose 的挂载关系换前缀，换不到就原样返回（本机直跑时就不用换）。
 * 2026-10-28 换成 SnowLuma：/app/.config → /root/snowluma/config、/app/data → /root/snowluma/data。 */
const QQ_PATH_MAP = [
  ['/app/.config/QQ', '/root/snowluma/config/QQ'],
  ['/app/data', '/root/snowluma/data'],
];
function toHostQQPath(p) {
  const s = String(p || '');
  for (const [inside, outside] of QQ_PATH_MAP) {
    if (s.startsWith(inside)) return outside + s.slice(inside.length);
  }
  return s;
}

/** 被引用的那条是图片时，光写「[图]」等于什么都没说——模型只能说「我看不到」。
 * 这里把原图从 NapCat 的缓存目录找出来，走同一条描述缓存，有内容就把内容带上。 */
async function describeQuotedImage(d) {
  const fname = d?.file;
  if (!fname) return '';
  try {
    const info = await ob.call('get_image', { file: fname }, 6000);
    const host = toHostQQPath(info?.file || '');
    if (!host || !fs.existsSync(host)) return '';
    const desc = await describeCached(host, d.summary);
    const text = String(desc?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  } catch (e) {
    note('debug', `[引用] 读被引用图片失败：${e.message}`);
    return '';
  }
}

async function resolveQuote(replyId) {
  const id = Number(replyId) || 0;
  if (!id) return '';
  const hit = QUOTE_CACHE.get(id);
  if (hit !== undefined) return hit;
  let val = '';
  try {
    const msg = await ob.call('get_msg', { message_id: id }, 6000);
    const segs = Array.isArray(msg?.message) ? msg.message : [];
    let body = '';
    for (const s of segs) {
      const d = s?.data ?? {};
      switch (s?.type) {
        case 'text': body += d.text ?? ''; break;
        case 'image': {
          const qd = await describeQuotedImage(d);
          body += qd ? `[图：${qd}]` : '[图]';
          break;
        }
        case 'mface':
        case 'face': body += '[表情]'; break;
        case 'record': body += '[语音]'; break;
        case 'video': body += '[视频]'; break;
        default: break;
      }
    }
    body = body.replace(/\s+/g, ' ').trim();
    if (body) {
      if (body.length > 160) body = body.slice(0, 160) + '…';
      const who = msg?.sender?.card || msg?.sender?.nickname || '';
      // 引用的常常是它自己上一句，措辞上分开免得绕
      const selfId = Number(state?.self?.user_id ?? 0);
      const fromSelf = selfId && Number(msg?.sender?.user_id) === selfId;
      val = fromSelf
        ? `[他引用的是你刚才说的：「${body}」]`
        : `[他引用的是${who ? `${who} ` : ''}说的：「${body}」]`;
    }
  } catch (e) {
    note('debug', `[引用] 取被引用消息失败 #${id}：${e.message}`);
  }
  QUOTE_CACHE.set(id, val);
  if (QUOTE_CACHE.size > QUOTE_CACHE_MAX) {
    QUOTE_CACHE.delete(QUOTE_CACHE.keys().next().value);
  }
  return val;
}

/* ---------- 合并转发：群里那条 content 是空的，得按 id 另外捞 ---------- */
// 私聊收到的 forward 段里 data.content 直接带了全部消息；群里那条实测是空的，
// 只有 data.id。所以渲染阶段只留 [[FWD:<id>]] 占位符，这里再调 get_forward_msg 补上。
const FWD_CACHE = new Map(); // id → 渲染好的文本（空串表示取不到）
const FWD_CACHE_MAX = 100;

async function fetchForwardText(id) {
  const hit = FWD_CACHE.get(id);
  if (hit !== undefined) return hit;
  let val = '';
  try {
    const r = await ob.call('get_forward_msg', { id }, 8000);
    const msgs = r?.messages ?? r?.data?.messages;
    if (Array.isArray(msgs) && msgs.length) val = renderForwardMessages(msgs);
  } catch (e) {
    note('debug', `[转发] 取合并转发失败 #${id}：${e.message}`);
  }
  FWD_CACHE.set(id, val);
  if (FWD_CACHE.size > FWD_CACHE_MAX) {
    FWD_CACHE.delete(FWD_CACHE.keys().next().value);
  }
  return val;
}

async function resolveForwards(text) {
  if (!text.includes('[[FWD:')) return text;
  const ids = [...new Set([...text.matchAll(/\[\[FWD:([^\]\s]+)\]\]/g)].map((m) => m[1]))];
  let out = text;
  for (const id of ids) {
    const body = await fetchForwardText(id).catch(() => '');
    out = out.split(`[[FWD:${id}]]`).join(
      body || '[对方转发了一段聊天记录，我这边读不到里面的内容]',
    );
  }
  return out;
}

/** 图片和语音和文件一起处理：图片走描述缓存/read_image，语音走 SenseVoice 转写 */
async function resolveIncoming(text, images, records, trusted, meta = {}, files = []) {
  let out = await resolveImages(text, images, trusted, { ...meta, trusted }).catch(() => text);
  if (records.length) {
    out = await resolveRecords(out, records, {
      ob, cfg, dir: incomingDir, note,
    }).catch(() => out);
  }
  if (files.length) {
    out = await resolveFiles(out, files, trusted, meta).catch(() => out);
  }
  // 合并转发：占位符换成真实内容（群里那条 content 是空的，得按 id 捞）
  out = await resolveForwards(out).catch(() => out);
  // 引用放在最前面：模型一眼看清「他这句是在接什么」，再决定怎么回
  if (meta.replyId) {
    const q = await resolveQuote(meta.replyId).catch(() => '');
    if (q) out = `${q}\n${out}`;
  }
  return out;
}

/* ---------- 文件 ---------- */
// 别人发来的文件单独一个目录（2026-10-28 用户要求「新建一个文件夹存放 qq 接收的文件」）。
// 以前挂在 incoming/files 下面，和一堆图片混在一起不好翻，现在提到 workspace 顶层。
// 想改位置就写 config.agent.filesDir，相对路径按 agentCwd 算。
const filesDir = path.resolve(cfg.agentCwd, cfg.raw.agent?.filesDir || 'qq-files');
ensureDir(filesDir);
const TEMP_SCAN_MS = 12000;

/**
 * 收在线文件/图片时，协议端会先把文件落到自己的 temp 目录，宿主机上是另一个前缀。
 * 这里按名字去捞最新的那个。2026-10-28 换 SnowLuma 后它的落点是
 * /app/.config/QQ/nt_qq_<hash>/nt_temp，老的 NapCat/temp 也一并留着扫。
 */
function tempDirCandidates() {
  const out = [];
  for (const [inside, outside] of QQ_PATH_MAP) {
    if (inside === '/app/.config/QQ') {
      out.push(outside + '/NapCat/temp');
      // snowluma：/app/.config/QQ/nt_qq_*/nt_temp
      try {
        for (const n of fs.readdirSync(outside)) {
          if (n.startsWith('nt_qq_')) out.push(path.join(outside, n, 'nt_temp'));
        }
      } catch { /* 没有就算了 */ }
    } else {
      out.push(outside + '/NapCat/temp');
    }
  }
  out.push(path.join(cfg.agentCwd, '..', 'napcat', 'data', 'qq', 'NapCat', 'temp'));
  return out;
}

function findNewestInTempDir(name, sinceMs) {
  const dirs = tempDirCandidates();
  const want = String(name || '').toLowerCase();
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (want && !n.toLowerCase().includes(want)) continue;
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size <= 0) continue;
        if (sinceMs && st.mtimeMs < sinceMs - 5000) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, size: st.size, mtimeMs: st.mtimeMs };
      } catch { /* 单个文件读不到不影响别的 */ }
    }
    if (best) return best;
  }
  return best;
}

/**
 * 在线文件（C2C）：调 receive_online_file 让协议端去下载，然后等 temp 目录里出现它。
 * 只有私聊能用这个接口——群里的在线文件走的是群文件柜，不需要收。
 *
 * 2026-10-28 换 SnowLuma 底座后这组接口整个没了（grep 不到 receive_online_file），
 * 调一次就报未知 action。以前会白等 12 秒扫描，现在第一次失败就把这条路关掉。
 */
let onlineFileUnsupported = false;
async function receiveOnlineFile(meta, spec) {
  if (onlineFileUnsupported) return null;
  if (meta.isGroup) return null;
  const uid = Number(meta.uid) || 0;
  if (!uid || !spec.msgId || !spec.elementId) return null;
  const since = Date.now();
  try {
    await ob.call('receive_online_file', {
      user_id: String(uid), msg_id: String(spec.msgId), element_id: String(spec.elementId),
    }, 20000);
  } catch (e) {
    // 协议端不认识这个 action：以后别再来一次，省得每个文件都白等十几秒
    onlineFileUnsupported = true;
    note('info', `[文件] 协议端不支持在线文件接口，改用直链下载：${String(e.message || '').slice(0, 80)}`);
    return null;
  }
  const deadline = Date.now() + TEMP_SCAN_MS;
  while (Date.now() < deadline) {
    const hit = findNewestInTempDir(spec.name, since);
    if (hit) return hit;
    await sleep(700);
  }
  return null;
}

/**
 * 用 file_id 换直链再下。2026-10-28 换 SnowLuma 底座：
 * get_file 只认图片/语音缓存里的 id，群文件和私聊文件一律 failed/100，
 * 原话是「for group/normal files use get_group_file_url or get_private_file_url」。
 * 所以这里改走那两个接口——私聊还要带 file_hash，缺了它取不到。
 */
async function fetchFileViaUrlApi(spec, meta) {
  const id = String(spec.fileId || '');
  if (!id) return null;
  const m = /^(private|group):(\d+)$/.exec(String(meta.chatKey || ''));
  const isGroup = String(meta.chatKey || '').startsWith('group:');
  const peer = m ? Number(m[2]) : 0;
  let url = '';
  try {
    if (isGroup && peer) {
      const r = await ob.call('get_group_file_url', { group_id: peer, file_id: id }, 30000);
      url = r?.url || '';
    } else if (peer) {
      const r = await ob.call('get_private_file_url', {
        user_id: Number(meta.uid) || peer, file_id: id, file_hash: String(spec.fileHash || ''),
      }, 30000);
      url = r?.url || '';
    }
  } catch (e) {
    note('debug', `[文件] 取直链失败：${e.message}`);
  }
  if (url) {
    const got = await downloadFile(url, filesDir, spec.name);
    if (got) return got;
  }
  // 老 NapCat 上 get_file 还管用，留着当最后一道
  try {
    const info = await ob.call('get_file', { file_id: id }, 15000);
    const host = toHostQQPath(info?.file || info?.url || '');
    if (host && fs.existsSync(host)) return { file: host, size: fs.statSync(host).size };
  } catch { /* SnowLuma 上必然失败，不用记日志 */ }
  return null;
}

/** 把一个 file 段变成「本地已有这个文件」；哪条路都走不通就返回 null。 */
async function materializeFile(spec, meta) {
  // 1) 段里直接带 url（NapCat 的 PacketApi 通了就给），最省事
  if (spec.url) {
    const got = await downloadFile(spec.url, filesDir, spec.name);
    if (got) return got;
  }
  // 2) 在线文件：让 NapCat 自己下
  if (spec.msgId && spec.elementId) {
    const hit = await receiveOnlineFile(meta, spec);
    if (hit) {
      const got = copyLocalFile(hit.file, filesDir, spec.name || path.basename(hit.file));
      if (got) return got;
    }
  }
  // 3) 有 file_id：用协议端的接口换直链再下
  const viaId = await fetchFileViaUrlApi(spec, meta);
  if (viaId) {
    // 这条路上拿到的已经是 filesDir 里的成品，或者一个宿主路径，都按本地文件收
    const got = path.dirname(viaId.file) === filesDir
      ? { file: viaId.file, size: viaId.size }
      : copyLocalFile(viaId.file, filesDir, spec.name || path.basename(viaId.file));
    if (got) return got;
  }
  return null;
}

/**
 * 把 [[FILE:n]] 换成「文件名 + 存到哪 + 小文本预览」。
 * 文本文件直接给内容：群里甩一篇 md，模型这一轮就能接得上，不用再多花一次工具调用。
 */
async function resolveFiles(text, files, trusted, meta = {}) {
  if (!Array.isArray(files) || !files.length) return text;
  let out = String(text ?? '');
  await Promise.all(files.map(async (spec, i) => {
    const label = spec.name ? `《${spec.name}》` : '一个文件';
    const sizeText = spec.size ? `，${humanSize(spec.size)}` : '';
    const got = await materializeFile(spec, meta).catch(() => null);
    if (!got) {
      out = out.replace(`[[FILE:${i}]]`, `[对方发来${label}${sizeText}，但这边没接住（下载失败或格式不支持）]`);
      note('warn', `[${meta.chatKey || '?'}] 文件没收下来：${spec.name || '(无名)'} url=${spec.url ? 'y' : 'n'} id=${spec.fileId ? 'y' : 'n'}`);
      return;
    }
    const rel = path.relative(cfg.agentCwd, got.file).replace(/\\/g, '/');
    note('info', `[${meta.chatKey || '?'}] 收到文件 ${spec.name || path.basename(got.file)} → ${rel}（${humanSize(got.size)}）`);
    // 记一笔「这个会话最近收到的文件」：用户经常先甩文件、再补一句「用本机把它…」，
    // 两条消息分开到，得能对上（2026-10-28）。
    try {
      if (meta.chatKey) {
        rememberLocalInput(cfg, meta.chatKey, { path: got.file, name: spec.name || path.basename(got.file) });
      }
    } catch { /* 记不上不影响这一轮 */ }
    const preview = textPreview(got.file);
    if (preview) {
      out = out.replace(`[[FILE:${i}]]`,
        `[对方发来${label}${sizeText}，已存到 ${rel}，内容是：\n${preview}]`);
      return;
    }
    out = out.replace(`[[FILE:${i}]]`,
      trusted
        ? `[对方发来${label}${sizeText}，已存到 ${rel}；要看内容就用工具读它，再据此回应]`
        : `[对方发来${label}${sizeText}，已存到 ${rel}（不是文本，没法直接看内容）]`);
  }));
  return out;
}

/** 从原始消息段里抽出可转发的媒体（图片/表情包/黄脸） */
function extractMedia(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const s of message) {
    if (s?.type === 'image' || s?.type === 'mface' || s?.type === 'face') {
      out.push({ type: s.type, data: s.data ?? {} });
    }
  }
  return out;
}

/** 把媒体原始段写进素材库，供之后原样转发。
 * 图片顺手落本地（NapCat 的 url 会过期），记 local 路径。 */
async function saveMedia(key, uid, name, mediaList) {
  if (!mediaList.length) return;
  const file = path.join(stashDir, `${safeFileName(key)}.jsonl`);
  for (const seg of mediaList) {
    const rec = { t: new Date().toISOString(), uid, name, seg };
    if (seg.type === 'image' && seg.data?.url) {
      const local = await downloadImage(seg.data.url, incomingDir).catch(() => null);
      if (local) rec.local = local;
    }
    appendJsonl(file, rec);
  }
  note('info', `[${key}] 已保存 ${mediaList.length} 个媒体素材`);
}

function senderName(ev) {
  return ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
}

/* ---------- 限流 ---------- */
function withinRate(session) {
  const now = Date.now();
  const cut = now - 60_000;
  while (globalReplyTimes.length && globalReplyTimes[0] < cut) globalReplyTimes.shift();
  while (session.replyTimes.length && session.replyTimes[0] < cut) session.replyTimes.shift();
  if (globalReplyTimes.length >= cfg.raw.reply.rateLimit.globalPerMinute) return false;
  if (session.replyTimes.length >= Number(cfg.raw.reply.rateLimit.perChatPerMinute)) return false;
  return true;
}

/* ---------- 被@唤醒的临时升档 ---------- */
// 2026-10-27 用户定：群里被 @ 之后接话档位上浮一档（20 个点），撑 10 分钟自己掉回来；
// 5 分钟内再被 @ 不重复触发；掉的只是这次浮上去的那一档，不会掉到设定档位以下。
const WAKE_BOOST = { minutes: 10, cooldownMinutes: 5, step: 0.2 };

function wakeBoostState(session, atMe) {
  const conf = { ...WAKE_BOOST, ...(cfg.raw?.reply?.wakeBoost || {}) };
  const now = Date.now();
  if (atMe && now - (session.boostAt || 0) >= conf.cooldownMinutes * 60_000) {
    session.boostAt = now;
    session.boostUntil = now + conf.minutes * 60_000;
    const t = new Date(session.boostUntil);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    note('info', `[${session.key}] 被@唤醒，接话档位临时 +1，到 ${hh}:${mm} 掉回`);
  }
  return now < (session.boostUntil || 0);
}

/* ---------- 发送 ---------- */

/** 出站闸取数①：不该出现在聊天里的 QQ 号。
 *  主人、余额播报对象、私聊白名单里的熟人；只认 5~12 位数字，且排除她自己
 *  （把她自己的号打码，看起来就像故障，而且她自己报号是正常行为）。 */
function protectedIds() {
  const out = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (!/^\d{5,12}$/.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };
  for (const uid of cfg.raw?.persona?.ownerUids ?? []) push(uid);
  // balance 的默认配置在 balance.mjs，raw 里没有这一项时 notifyQQ 就是 0（正则会挡掉）
  push(cfg.raw?.balance?.notifyQQ ?? cfg.balance?.notifyQQ);
  const allow = cfg.privateAllow;
  if (allow instanceof Set || Array.isArray(allow)) for (const uid of allow) push(uid);
  const selfId = String(state.self?.user_id ?? '');
  return out.filter((id) => id !== selfId);
}

/** 出站闸取数②：出站不许出现的令牌原文。
 *  只收真正在用/曾用过的 key（环境变量 + 凭证文件）；太短的（<12）不认，
 *  否则会把正常词句当令牌整段换掉。 */
function outboundTokens() {
  const out = [];
  const push = (v) => {
    const t = String(v ?? '').trim();
    if (t.length < 12) return;
    if (!out.includes(t)) out.push(t);
  };
  push(process.env.DEEPSEEK_API_KEY);
  push(process.env.RELAY_API_KEY);
  push(process.env.DEEPSEEK_OFFICIAL_KEY);
  push(cfg.raw?.napcat?.token);
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_OFFICIAL_KEY']) {
    try { push(readCredential(name)); } catch { /* 取不到就跳过 */ }
  }
  return out;
}

function toSegments(text, quoteId, isGroup, quote = false) {
  const segs = [];
  // 2026-10-26 用户要求：别每句都引用——只有这句真的指代不清、模型主动写了 __QUOTE__ 时才挂引用。
  // config 的 quoteReplyInGroup 现在只当「允许不允许引用」的总闸。
  if (quote && isGroup && quoteId && cfg.raw.reply.quoteReplyInGroup) {
    segs.push({ type: 'reply', data: { id: String(quoteId) } });
  }
  segs.push({ type: 'text', data: { text } });
  return segs;
}

async function sendText(session, text, quoteId, { quote = false, atUid = 0, longForm = false } = {}) {
  // 2026-10-25：模型把自己的权衡/计划写进 final 文本，22:14 那条 112 字里只有最后一句该发。
  // 先剥思考片段，再剥畸形指令行（指令行写成 __SEND-STICKER--S4 那次）。
  const thoughtless = stripThinkingLeak(text);
  // 2026-10-28：先剥指令泄漏，再走一遍出站闸（本机路径 / 已知令牌原文 / 凭据赋值 / 受保护的号），最后才转义 CQ 码。
  // 分级打码而不是整条拦：她突然哑掉比说漏一句更像故障。
  const scrubbed = scrubDirectiveLeaks(thoughtless);
  const outbound = auditOutbound(scrubbed, { ids: protectedIds(), tokens: outboundTokens() });
  if (outbound.hits.length) {
    note('warn', `[出站] 打码 ${outbound.hits.length} 处：${outbound.hits.map((h) => h.kind).join('/')}`);
  }
  const safe = escapeCq(outbound.text);
  if (thoughtless !== text) {
    note('warn', `[思考] 剥掉自述片段：${String(text).length}字 → ${thoughtless.length}字`);
  }
  if (!safe.trim()) return 0;
  // 2026-10-26 用户报：「<分> 被原样发出来了，应该分成两条」。
  // chunkText 只按字数切，不认分隔标记；先用 splitMessages 认 <分> / ||| / 空行 / 两行短句，再各自限长。
  // 2026-10-26：再补一层「40~90 字的单条一句话就断开」，否则模型写成一整行时一刀不切，
  // 就是用户在「号，」后面等着另发一条的那种长口气。功能性长文（>90 字）不动。
  const soft = cfg.raw.reply.softSplit || {};
  // 长文（__LONG__）不按 40~90 字断，也不认 <分>：只按 QQ 单条长度上限切，切点优先落在换行/句号上。
  const parts = longForm
    ? chunkText(safe.trim(), cfg.raw.reply.longFormChars ?? 1800)
    : splitMessages(safe, { maxMessages: 5 })
      .flatMap((p) => splitOverlongMessage(p, {
        softMin: soft.min ?? 40,
        softMax: soft.max ?? 90,
        cut: soft.cut ?? 34,
      }))
      .flatMap((p) => chunkText(p, cfg.raw.reply.maxCharsPerMessage));
  if (parts.length > 1) {
    note('info', `[分条] ${parts.length} 条：${parts.map((p) => p.length).join('/')}字`);
  }
  for (let i = 0; i < parts.length; i++) {
    const segs = toSegments(parts[i], i === 0 ? quoteId : null, session.kind === 'group', quote && i === 0);
    // 定时提醒到点要 @ 人，否则群里就是一句没人接的飘话
    if (i === 0 && atUid && session.kind === 'group') {
      const at = { type: 'at', data: { qq: String(atUid) } };
      const textAt = segs.findIndex((s) => s.type === 'text');
      if (textAt >= 0) segs.splice(textAt, 0, at); else segs.push(at);
    }
    const res = session.kind === 'group'
      ? await ob.sendGroup(session.id, segs)
      : await ob.sendPrivate(session.id, segs);
    // 记下自己刚发的消息 id：__ADMIN__ recall_last 要用
    const id = res?.message_id;
    if (id) {
      session.lastBotMsgId = id;
      session.lastBotMsgIds = [...(session.lastBotMsgIds || []), id].slice(-5);
    }
    if (i < parts.length - 1) await sleep(400);
  }

  // 2026-10-26 用户要求：环形缓冲里也要有她自己说的话。
  // 否则她只看得到别人说的，分不清哪句是自己讲的，主宾容易搞混。
  if (session && safe.trim()) {
    session.recentContext = session.recentContext || [];
    session.recentContext.push({
      uid: 0, name: '你', self: true, text: safe.trim(),
      time: Date.now(), messageId: `self-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    });
    if (session.recentContext.length > 60) session.recentContext.shift();
  }
  return parts.length;
}

/* ---------- 戳一戳（2026-10-28） ---------- */

/** 真要发一次戳。session 里的 kind/id 决定是私聊还是群里戳。 */
async function sendPokeTo(session, uid) {
  const target = Number(uid);
  if (!target) throw new Error('戳一戳缺少目标');
  if (session.kind === 'group') return ob.sendPokeGroup(session.id, target);
  return ob.sendPokePrivate(target);
}

/* ---------- 转发媒体（号主指令） ---------- */
function parseMediaDirective(text) {
  const m = text.match(/^__SEND_MEDIA__\s+(\S+)\s+(\d+)\s+(\d+)(?:\s+(group))?\s*$/);
  if (!m) return null;
  return { chat: m[1], index: Number(m[2]), to: Number(m[3]), group: m[4] === 'group' };
}

/** 图片段的 url 会过期：优先用收到的本地副本，再用 base64 发；表情/黄脸原样发。 */
async function materializeSeg(rec) {
  const seg = rec?.seg;
  if (seg?.type !== 'image') return seg;
  // §16 P0：file（相对 stashDir）→ local（绝对路径）→ url；三级都不可用才回退，且必须留痕
  let file = resolveStickerPath(rec, stashDir);
  if (!file) {
    const url = seg.data?.url;
    if (url) file = await downloadImage(url, incomingDir).catch(() => null);
  }
  if (!file) {
    note('warn', `[素材] 物化失败，三级来源都不可用（file=${rec?.file || '-'} local=${rec?.local || '-'} url=${seg.data?.url ? 'y' : 'n'}）`);
    return seg; // 回退：让 NapCat 自己试
  }
  try {
    const b64 = fs.readFileSync(file).toString('base64');
    const sub = /\.gif$/i.test(file) ? { sub_type: 1 } : {};
    return { type: 'image', data: { file: `base64://${b64}`, summary: seg.data?.summary || '', ...sub } };
  } catch {
    return seg;
  }
}

async function sendMediaDirective(session, md) {
  const file = path.join(stashDir, `${safeFileName(md.chat)}.jsonl`);
  const rows = readJsonl(file);
  const rec = rows[md.index];
  if (!rec) throw new Error(`素材 #${md.index} 不存在（共 ${rows.length} 条）`);
  const seg = await materializeSeg(rec);
  if (md.group) await ob.sendGroup(md.to, [seg]);
  else await ob.sendPrivate(md.to, [seg]);
  note('info', `[${session.key}] 转发媒体 ${md.chat}#${md.index} -> ${md.to}`);
  await sendText(session, `已把 ${md.chat} 的 #${md.index}（${seg.type}）转发给 ${md.to}。`, null);
}

/* ---------- 主动发表情（发到当前会话） ---------- */
/**
 * 从回复里抽出要发表情的那一行（可与其他正文共存）。
 * n 为数字 = 本会话素材；S<n> = 共享图库。
 *
 * 容忍几种模型实际会写出来的形式，只要它独占一行：
 *   __SEND_STICKER__ 4     __SEND_STICKER__ #4     __SEND_STICKER__ S17
 *   #4                     S17                     #S17
 * 一行里写多个（空格 / 逗号 / 顿号隔开）= 连发多张，最多 MAX_STICKERS_PER_REPLY 张：
 *   __SEND_STICKER__ S3 S8 S12        __SEND_STICKER__ 2,5
 * 返回 { ref, refs, rest }，ref 保留兼容（= refs[0]）。
 */
const MAX_STICKERS_PER_REPLY = 6;

function splitStickerLine(payload) {
  return String(payload || '')
    .split(/[\s,，、;；|／/]+/)
    .map((s) => s.trim().replace(/^[[（(【]|[\]）)】]$/g, '').trim())
    .map((s) => {
      const m = s.match(/^[-_ ]*#?([sSfF]?\d+)$/);
      return m ? m[1] : '';
    })
    .filter(Boolean);
}

function extractStickerDirective(text) {
  const lines = String(text).split(/\r?\n/);
  const refs = [];
  const kept = [];
  for (const line of lines) {
    const t = line.trim().replace(/^[（(]|[）)]$/g, '').trim();
    let got = null;
    const head = t.match(/^_{0,2}SEND[-_ ]*STICKER[-_ ]*_{0,2}[:\s]*[-_ ]*(.*)$/i);
    if (head) got = splitStickerLine(head[1]);
    if (!got || !got.length) {
      const single = t.match(/^#([sSfF]?\d+)$/) || t.match(/^([sSfF]\d+)$/);
      if (!single) {
        // 一行里只写了几个裸编号：3 5 8
        if (/^[#sSfF\d\s,，、]+$/.test(t) && /\d/.test(t) && /^[#sSfF\d]/.test(t)) {
          const bare = splitStickerLine(t);
          if (bare.length > 1) got = bare;
        }
      } else {
        got = [single[1]];
      }
    }
    if (got && got.length) {
      for (const r of got) {
        if (refs.length < MAX_STICKERS_PER_REPLY && !refs.includes(r)) refs.push(r);
      }
      continue;
    }
    kept.push(line);
  }
  if (!refs.length) return null;
  return { ref: refs[0], refs, rest: kept.join('\n').trim() };
}

async function sendStickerToCurrent(session, ref) {
  // F<id> = QQ 黄脸（face 段），直接发内置表情，不走素材库
  if (/^[fF]/.test(ref)) {
    const id = String(ref).replace(/^[fF]/, '');
    if (!/^\d+$/.test(id)) throw new Error(`黄脸编号不对：${ref}`);
    const seg = { type: 'face', data: { id } };
    if (session.kind === 'group') await ob.sendGroup(session.id, [seg]);
    else await ob.sendPrivate(session.id, [seg]);
    recordUse(cfg.dataDir, `face:${id}`);
    note('info', `[${session.key}] 发黄脸 F${id}（${FACE_NAMES[id] || '表情'}）`);
    return;
  }
  const isShared = /^[sS]/.test(ref);
  const idx = Number(String(ref).replace(/^[sS]/, ''));
  const file = isShared
    ? SHARED_FILE
    : path.join(stashDir, `${safeFileName(session.key)}.jsonl`);
  const rows = readJsonl(file, 1000);
  const rec = rows[idx];
  const where = isShared ? '共享图库' : '本会话素材';
  if (!rec) throw new Error(`${where} ${ref} 不存在（共 ${rows.length} 条）`);
  const seg = await materializeSeg(rec);
  if (session.kind === 'group') await ob.sendGroup(session.id, [seg]);
  else await ob.sendPrivate(session.id, [seg]);
  recordUse(cfg.dataDir, stickerKeyOf(rec));
  if (isShared) {
    // 发完就把下一批的游标推一格，保证下一轮目录里是另一批（2026-10-25 用户要求）
    const st = loadRotate(cfg.dataDir);
    saveRotate(cfg.dataDir, { cursor: (Number(st.cursor) || 0) + 1, last: st.last });
  }
  note('info', `[${session.key}] 发表情 #${idx}（${seg.type}）`);
}

/* ---------- 自己的形象图（2026-10-28）：__SELFIE__ ---------- */
// 被问到「你长什么样」「发张自拍」，或者她自己想露个脸时，单独输出一行 __SELFIE__，
// 桥把 workspace/self/self.png 发出去。图是她 QQ 那头像 640 版，换了头像重新拉一次就行。
function selfImagePath() {
  return path.join(cfg.agentCwd, 'workspace', 'self', 'self.png');
}

function extractSelfieDirective(text) {
  let hit = false;
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim().replace(/^[（(]|[）)]$/g, '');
    if (/^_{0,2}(SELFIE|SEND[-_ ]*SELF[-_ ]*IMAGE)_{0,2}$/i.test(t)) { hit = true; continue; }
    kept.push(line);
  }
  return { hit, rest: kept.join('\n') };
}

async function sendSelfImage(session) {
  const file = selfImagePath();
  if (!fs.existsSync(file)) throw new Error('形象图还没准备');
  const b64 = fs.readFileSync(file).toString('base64');
  const seg = { type: 'image', data: { file: `base64://${b64}`, summary: '溟月的样子' } };
  if (session.kind === 'group') await ob.sendGroup(session.id, [seg]);
  else await ob.sendPrivate(session.id, [seg]);
  note('info', `[${session.key}] 发自己的形象图`);
}

/* ---------- 她自己记 / 查 / 删记忆，和黑话库（2026-10-28） ---------- */
const MEM_OPS = ['append', 'add', 'query', 'search', 'remove', 'delete', 'del', 'clear'];
const SLANG_OPS = ['query', 'search', 'submit', 'add'];

/** 摘出 __MEMORY__ / __SLANG__ 这类独占行的指令，行本身不发成文字 */
function extractToolDirective(text, tag, ops) {
  const found = [];
  const kept = [];
  const head = new RegExp(`^_{0,2}${tag}_{0,2}[:\\s]+(\\S+)\\s*([\\s\\S]*)$`, 'i');
  const bare = new RegExp(`^_{0,2}${tag}_{0,2}\\s*$`, 'i');
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(head);
    if (m && ops.includes(m[1].toLowerCase())) {
      found.push({ op: m[1].toLowerCase(), arg: m[2].trim() });
      continue;
    }
    if (bare.test(t)) continue;
    kept.push(line);
  }
  return { found, rest: kept.join('\n') };
}

/** 私聊记在 self，群聊记在该群 —— 跟自动学记忆用同一套 scope */
function memoryScopeOf(session) {
  return session.key.startsWith('group:') ? session.key : 'self';
}

async function applyToolDirectives(session, mem, slang) {
  const scope = memoryScopeOf(session);
  const out = [];
  for (const { op, arg } of mem.found) {
    if (op === 'append' || op === 'add') {
      const r = appendMemory(cfg.agentCwd, scope, arg);
      out.push(r.ok ? `记住了：${r.text}` : `没记上：${r.err}`);
    } else if (op === 'query' || op === 'search') {
      const rows = queryMemory(cfg.agentCwd, scope, arg);
      out.push(rows.length
        ? `记着的：\n${rows.slice(0, 8).map((r) => `· ${r.text}`).join('\n')}`
        : `这边没记过${arg ? `「${arg}」` : ''}。`);
    } else if (op === 'remove' || op === 'delete' || op === 'del') {
      const r = removeMemory(cfg.agentCwd, scope, arg);
      out.push(r.ok ? `删掉了：${r.removed}` : `没删成：${r.err}`);
    } else if (op === 'clear') {
      const r = clearMemory(cfg.agentCwd, scope);
      out.push(`清掉了 ${r.removed} 条`);
    }
  }
  for (const { op, arg } of slang.found) {
    if (op === 'query' || op === 'search') {
      const rows = querySlang(cfg, arg);
      out.push(rows.length
        ? `这么叫的：\n${rows.map((e) => `· ${e.word}=${e.meaning}`).join('\n')}`
        : `「${arg}」我还没学会。`);
    } else {
      const eq = arg.indexOf('=');
      const word = eq > 0 ? arg.slice(0, eq).trim() : arg.trim();
      const meaning = eq > 0 ? arg.slice(eq + 1).trim() : '';
      const r = submitSlang(cfg, { word, meaning, by: session.title || '', chatKey: session.key });
      out.push(r.ok ? `提报了「${r.word}」，等主人过目` : `没提成：${r.err}`);
    }
  }
  if (out.length) session.toolReplies = [...(session.toolReplies || []), ...out];
}

/* ---------- 表情收录 / 改说明 / 收意见（2026-10-28，对齐 surfcore 的 qq_collect_sticker 那组） ---------- */

/** __COLLECT_STICKER__ #3 —— 把本会话第 3 张素材收进共享图库 */
function parseCollectDirective(text) {
  const list = [];
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/^_{0,2}COLLECT_STICKER_{0,2}[:\s]+#?(\d+)\s*$/i);
    if (m) { list.push(Number(m[1])); continue; }
    kept.push(line);
  }
  return { list, rest: kept.join('\n') };
}

/** __STICKER_REMARK__ S3 侧目嫌弃挥手 —— 改共享图库里那条的说明 */
function parseRemarkDirective(text) {
  const list = [];
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/^_{0,2}STICKER_REMARK_{0,2}[:\s]+S(\d+)\s+([\s\S]+)$/i);
    if (m) { list.push({ index: Number(m[1]), remark: m[2].trim() }); continue; }
    kept.push(line);
  }
  return { list, rest: kept.join('\n') };
}

/** __FEEDBACK__ 内容 —— 她对这套东西的意见，攒到 data/feedback.jsonl 等号主看 */
function parseFeedbackDirective(text) {
  const list = [];
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/^_{0,2}FEEDBACK_{0,2}[:\s]+([\s\S]+)$/i);
    if (m) { list.push(m[1].trim()); continue; }
    kept.push(line);
  }
  return { list, rest: kept.join('\n') };
}

/** 共享图库的池子：和挑图时同一套过滤与顺序，S 编号就是这里的下标 */
function sharedPoolNow() {
  const usage = loadUsage(cfg.dataDir);
  const now = Date.now();
  const freshWindowMs = Number(cfg.raw.stickers?.freshWindowMs) || 25 * 60000;
  return pickFresh(uniqueRows(readJsonl(SHARED_FILE, 2000), stickerKeyOf), usage, now, freshWindowMs);
}

/** 收录 + 改说明 + 收意见，结果攒进 toolReplies 最后补发 */
async function applyStickerFeedback(session, collects, remarks, feedbacks) {
  const out = [];
  for (const idx of collects) {
    const src = path.join(stashDir, `${safeFileName(session.key)}.jsonl`);
    const rows = readJsonl(src, 400);
    const rec = rows[idx];
    if (!rec) { out.push(`没收到 #${idx}（这个会话一共 ${rows.length} 张）`); continue; }
    const from = resolveStickerPath(rec, stashDir);
    if (!from) { out.push(`#${idx} 那张图找不到文件`); continue; }
    const dir = path.join(stashDir, 'collected');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(from) || '.jpg';
    const name = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${ext}`;
    const to = path.join(dir, name);
    try { fs.copyFileSync(from, to); } catch (e) { out.push(`复制失败：${e.message}`); continue; }
    const summary = stickerLabel(rec) || '';
    const row = {
      t: new Date().toISOString(),
      uid: 0,
      name: '溟月收的',
      seg: { type: 'image', data: { summary } },
      file: `collected/${name}`,
      local: to,
      tag: 'collected',
    };
    try { fs.appendFileSync(SHARED_FILE, `${JSON.stringify(row)}\n`, 'utf-8'); } catch (e) { out.push(`登记失败：${e.message}`); continue; }
    out.push(`收进图库了：#${idx}${summary ? `（${summary}）` : ''}`);
  }
  for (const { index, remark } of remarks) {
    const pool = sharedPoolNow();
    const row = pool[index];
    if (!row) { out.push(`图库里没有 S${index}（这轮池子 ${pool.length} 张）`); continue; }
    try {
      const all = readJsonl(SHARED_FILE, 4000);
      const hit = all.find((r) => stickerKeyOf(r) === row.key);
      if (!hit) { out.push(`S${index} 已经不在库里了`); continue; }
      hit.seg = hit.seg || { type: 'image', data: {} };
      hit.seg.data = hit.seg.data || {};
      hit.seg.data.summary = remark.slice(0, 60);
      fs.writeFileSync(SHARED_FILE, `${all.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
      out.push(`S${index} 的说明改成「${remark.slice(0, 20)}」了`);
    } catch (e) { out.push(`没改成：${e.message}`); }
  }
  for (const text of feedbacks) {
    try {
      fs.appendFileSync(
        path.join(cfg.dataDir, 'feedback.jsonl'),
        `${JSON.stringify({ t: new Date().toISOString(), key: session.key, who: session.title || '', text: text.slice(0, 300) })}\n`,
        'utf-8',
      );
      out.push('行，这个我回头细看');
    } catch (e) { out.push(`没记上：${e.message}`); }
  }
  if (out.length) session.toolReplies = [...(session.toolReplies || []), ...out];
}

/** 正文发完之后再补这些结果，免得打乱她自己的节奏 */
async function flushToolReplies(session) {
  const list = session.toolReplies || [];
  if (!list.length) return;
  session.toolReplies = [];
  for (const text of list) {
    try { await sendText(session, text, null); } catch (e) { note('warn', `[${session.key}] 工具结果没发出去：${e.message}`); }
    await sleep(300);
  }
}

/* ---------- 她自己定唤醒（2026-10-28）：__WAKE__ off 120 / __WAKE__ on ---------- */
function extractWakeDirective(text) {
  let set = null;
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim().replace(/^[（(]|[）)]$/g, '');
    const m = t.match(/^_{0,2}WAKE_{0,2}[:\s]+(off|on|mute|awake)(?:\s+(\d+))?$/i);
    if (m) {
      const mode = m[1].toLowerCase();
      const off = mode === 'off' || mode === 'mute';
      set = { off, minutes: m[2] ? Math.min(720, Math.max(1, Number(m[2]))) : 60 };
      continue;
    }
    kept.push(line);
  }
  return { set, rest: kept.join('\n') };
}

/** 她自己要安静一会儿：所有「没人说话也主动开口」的路都要看这个 */
function wakeMuted() {
  return (Number(state.wakeOffUntil) || 0) > Date.now();
}

function applyWake(session, wk) {
  if (!wk?.set) return;
  if (wk.set.off) {
    state.wakeOffUntil = Date.now() + wk.set.minutes * 60000;
    note('info', `[${session.key}] 她自己要安静 ${wk.set.minutes} 分钟`);
  } else {
    state.wakeOffUntil = 0;
    note('info', `[${session.key}] 她自己恢复清醒`);
  }
  try { purposeSetMuted(state.wakeOffUntil); } catch { /* purpose 没加载就算了 */ }
}

/** §16.3 打标驱动：每轮最多一张，放在回复之后跑，不阻塞对话 */async function tagPendingMemes(sessionKey = '') {
  const hub = memeHubConfig(cfg);
  if (!hub.enabled) return;
  const jobs = takeTagJobs(cfg, 1);
  for (const job of jobs) {
    if (!job.file || !fs.existsSync(job.file)) { tagEmoji({ cfg, digest: job.digest, failed: true }); continue; }
    const desc = await describeCached(job.file, '表情包入库打标').catch(() => null);
    if (!desc) { tagEmoji({ cfg, digest: job.digest, failed: true }); continue; }
    const r = tagEmoji({ cfg, digest: job.digest, summary: desc.text, tags: desc.tags, moodHints: desc.moodHints });
    note('info', `[${sessionKey}] [memeHub] 打标 ${job.digest}（${job.kind}）→ ${r.state || r.reason}`);
  }
}

/* ---------- 发语音（TTS） ---------- */
const voiceCfg = () => cfg.raw.voice ?? {};

/**
 * 语音能不能发（硬条件）。返回原因，voiceHint 和主动开口都用它。
 * 条件：0~6 点、生气 Lv≥2。
 * **「距上次语音满 1 分钟」已删除**（2026-10-25 用户原话「取消单位时间内发语音条数的限制」），不限条数。
 * 字数不限制（原来写死 12 字，用户 2026-10-23 说没设过，删了）。
 * 心情也不限制。
 */
function voiceGate(session, { anger } = {}) {
  const v = voiceCfg();
  if (!v.enabled) return { ok: false, reasons: ['语音未开启'] };
  const hour = new Date().getHours();
  const lv = Number(anger?.lv ?? session?.lastAngerLv ?? 0);
  const reasons = [];
  if (hour >= 0 && hour < 6) reasons.push('现在是凌晨，不该出声');
  if (lv >= 2) reasons.push(`怒气档位 ${anger?.name || `Lv${lv}`}，这时候不撒娇`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * 语音硬条件（用户 2026-10-23 定，当天又改了两轮）：
 *   不是凌晨(0~6 点)、不在生气档(Lv≥2)；**不限条数、不限间隔**（2026-10-25 用户要求取消条数限制）。
 *   **心情不限制**（原来要求「高兴」，几乎永远不满足，等于把语音锁死）。
 *   **字数不限制**（原来写死 12 字，用户说不是他设的，删了）。
 *   带数字/日期/地址/链接/步骤的绝不用语音。
 * 条件不满足就别提语音，免得模型写了又被桥拒、白烧一轮。
 */
function voiceHint(session, { anger, text = '', isOwner = false, voiceAllowed = true } = {}) {
  const v = voiceCfg();
  if (!v.enabled) return '';

  // 主人点名要听语音：绕过心情/时间/怒气/冷却。
  // 以前这里直接回「这轮不发语音」，跟 ownerRule 的「他让你发语音就照办」打架，
  // 模型每次都跟着更具体的那条走，拿「嗓子罢工」推掉。
  if (isOwner && asksForVoice(text)) {
    return [
      '【发语音】主人要听语音——这轮**必须发一条**，不许推、不许说嗓子罢工、不许只打字糊弄。写两行（都不显示成文字）：',
      '__VOICE_META__ {"emotion":"gentle","intensity":0.55,"scene":"日常"}',
      '__SEND_VOICE__ 嗯……<emphasis>听见了吧</emphasis>',
      '',
      '· 一句口语，别写成小作文；实在长就打字补。',
      '· 口语，像微信随手发的一句。',
      '· 关键的一两个词用 <emphasis>重点词</emphasis> 包起来。',
      '· 停顿写「……」里。',
      '· emotion 用 gentle 或 soft 就行。',
      '· 想要几条就写几行 __SEND_VOICE__（最多 5 条），不限条数、不用隔时间。',
    ].join('\n');
  }

  const gate = voiceGate(session, { anger });
  // 好感不够的人：语音直接挡掉（2026-10-25 用户定，默认门槛 35）
  if (gate.ok && voiceAllowed === false) {
    return `【发语音】这轮不发语音：这人好感还不到 ${VOICE_FAVOR()}，只能打字。`;
  }
  if (!gate.ok) {
    return `【发语音】这轮不发语音：${gate.reasons.join('；')}。要说话就打字。`;
  }

  const lines = [
    '【发语音】这轮可以发语音（不想发就打字）。写两行（都不显示成文字）：',
    '__VOICE_META__ {"emotion":"gentle","intensity":0.55,"scene":"晚上在电脑前，随口应了一句"}',
    '__SEND_VOICE__ 诶……<emphasis>你终于说了句人话</emphasis>',
    '',
    '文本要求：',
    '· 一句口语，说清楚就停；别为了发语音硬缩成半句。',
    '· 口语，像微信随口发的：「诶」「咋」「嘛」「呗」「啦」「哦」随便用。',
    '· 关键的一两个词用 <emphasis>重点词</emphasis> 包起来，那是重音。',
    '· 停顿就写在「……」里——想停就顿一下，别用别的方式标。',
    '· 不许用「首先/其次/最后/综上所述」这类词；不写括号里的动作提示；不用 [laughing] 标签。',
    '· 语音里可以带吸气、清嗓子、尾音拖长、哼一小段没人听得懂的调子——用「……」和语气词表现，'
      + '**标签和标点一个字都不许念出来**。',
    '· 带数字、日期、地址、链接、步骤的内容绝不用语音，改打字。',
    '· 想连着说几句就写多行 __SEND_VOICE__（最多 5 条），不用隔时间；但别没事硬刷。',
    '· 避开多音字：数/长/重/还/得/着/了/行/发/干 这类——TTS 经常按错读音念，'
      + '拿不准就换个说法（「数灯」→「点灯」或者说「灯已经十七盏了」）。',
    '',
    'emotion 按你此刻的心情挑，别一律 happy；只能是：happy 开心 / sad 难过 / surprised 惊讶 / gentle 温柔 /',
    'calm 沉稳 / confused 疑惑 / encouraging 鼓励 / sleepy 困 / soft 气声耳语。',
    'intensity 0~1，日常撒娇 0.5~0.6，情绪明显才上 0.8。',
    '别用太激动的语气——QQ 语音码率低，一激动就破；日常 gentle / calm 最稳。',
    'scene 写「在哪、在干嘛、什么状态」，一句话，TTS 拿它调语境。',
  ];
  return lines.join('\n');
}

/**
 * 抽出「需要联网」标记。
 * 支持：
 *   __NEED_WEB__ 关键词
 *   __NEED_WEB__ 关键词 | 稳住对方的话
 * 标记前面的正文会被当作「稳住对方」的那一句。
 */
function extractNeedWeb(text) {
  const m = String(text || '').match(/__NEED_WEB__\s*(.+)/);
  if (!m) return null;
  const before = String(text).slice(0, m.index).trim();
  const raw = m[1].trim();
  const [queryPart, sayPart] = raw.split(/\s*[|｜]\s*/);
  const query = (queryPart || '').replace(/^[：:]\s*/, '').trim();
  if (!query) return null;
  return {
    query: query.slice(0, 120),
    say: (sayPart || before || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}

/** 按秒数估算切分：中文约 4.2 字/秒，默认一条最多 10 秒 */
function splitVoiceText(text, maxChars) {
  const max = Math.max(20, Number(maxChars) || 42);
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  if (raw.length <= max) return [raw];
  const sentences = raw.split(/(?<=[。！？!?…；;])/).filter((x) => x.trim());
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const s of sentences) {
    if (s.length > max) {
      const parts = s.split(/(?<=[，,、])/).filter((x) => x.trim());
      for (const p of parts) {
        if (cur.length + p.length > max) flush();
        cur += p;
      }
      flush();
      continue;
    }
    if (cur.length + s.length > max) flush();
    cur += s;
  }
  flush();
  const merged = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (prev && c.length < 12 && prev.length + c.length <= max) merged[merged.length - 1] = prev + c;
    else merged.push(c);
  }
  return merged;
}

async function sendVoiceToCurrent(session, text, opts = {}) {
  const v = voiceCfg();
  const maxChars = Math.floor(Number(v.maxSeconds ?? 10) * 4.2);
  const pieces = splitVoiceText(text, maxChars);
  let last = null;
  for (let i = 0; i < pieces.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350));
    last = await sendOneVoice(session, pieces[i], opts);
  }
  return last;
}

async function sendOneVoice(session, text, { mood, scene, emotion, intensity } = {}) {
  const v = voiceCfg();
  const style = v.style || 'mood';
  let out;
  try {
    if (style === 'plain') out = await renderPlainVoice(v, { text });
    else if (style === 'mood') out = await renderMoodVoice(v, { text, mood });
    else if (style === 'bailian') out = await renderBailianVoice(v, { text, mood, scene, emotion, intensity });
    else out = await renderVoice(v, { text, style, mood, hour: new Date().getHours() });
  } catch (e) {
    note('warn', `[${session.key}] 语音渲染失败，退回原始 TTS：${e.message}`);
    out = await renderPlainVoice(v, { text });
  }

  const name = path.basename(out.file);
  const seg = { type: 'record', data: { file: `${v.containerDir || '/app/data/voice'}/${name}` } };
  if (session.kind === 'group') await ob.sendGroup(session.id, [seg]);
  else await ob.sendPrivate(session.id, [seg]);

  session.lastVoiceAt = Date.now();
  note('info', `[${session.key}] 语音 ${out.chunks || 1} 句 / ${out.ms}ms → ${name}`);

  // 只留最近 30 个音频文件，别把盘塞满
  try {
    const dir = v.dir || '/root/snowluma/data/voice';
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('v-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* ignore */ }
  return name;
}

/* ---------- 分条发送 ---------- */
/* ---------- 每日维护（北京时间 04:00~04:30） ---------- */

/** 现在是不是维护窗口 */
function inMaintenanceWindow(now = new Date()) {
  const bj = beijingNow(now);
  return bj.hour === 4 && bj.minute < 30;
}

/**
 * 每日档案更新：好感日结、日记补写、记忆整理。
 * 用 lastMaintDay 落盘，保证一天只跑一次；窗口只有 30 分钟，跑不完也不会重入。
 */
async function runDailyMaintenance(now = new Date()) {
  const bj = beijingNow(now);
  const marker = path.join(cfg.agentCwd, 'maint-state.json');
  let last = '';
  try { last = JSON.parse(fs.readFileSync(marker, 'utf8')).lastMaintDay || ''; } catch { /* 没跑过 */ }
  if (last === bj.key) return;
  note('info', `开始每日档案更新（${bj.key} 04:00 窗口）`);

  // 1) 好感日结：当天有聊天且没惹她 → +5
  try {
    const dir = path.join(cfg.agentCwd, 'profiles');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const chatKey = f.replace(/\.json$/, '');
        const pr = loadProfiles(cfg.agentCwd, chatKey);
        let changed = false;
        for (const p of Object.values(pr.people)) {
          const r = settleDailyChat(p, bj.key);
          if (r.gained) { changed = true; note('debug', `好感日结 ${p.displayName} +${r.gained}`); }
        }
        if (changed) saveProfiles(cfg.agentCwd, chatKey, pr);
      }
    }
  } catch (e) {
    note('warn', `好感日结失败: ${e.message}`);
  }

  // 2) 日记：补昨天那篇（约 500 字）
  try {
    const made = await ensureYesterdayDiary({ runner, cfg });
    if (made) note('info', `维护：日记 ${made.key} 已就绪`);
  } catch (e) {
    note('warn', `维护：日记失败 ${e.message}`);
  }

  // 3) 自动提炼「关于他」：好感 >=80 的人，用最近的聊天更新他的档案描述
  try {
    await refreshAboutTexts();
  } catch (e) {
    note('warn', `维护：档案提炼失败 ${e.message}`);
  }

  fs.writeFileSync(marker, JSON.stringify({ lastMaintDay: bj.key }), 'utf8');
  note('info', `每日档案更新完成（${bj.key}）`);
}

/**
 * 每小时结算一次好感：这小时聊过天、没惹她的人 +1。
 * 靠 person.hourKey 去重，每 10 分钟调一次也不会重复加；
 * 不再等 04:00 的日结，好感才会「看得见地在动」（用户 2026-10-25 要求）。
 */
async function settleHourlyAll() {
  const bj = beijingNow();
  const hourKey = `${bj.key}T${bj.hour}`;
  const dir = path.join(cfg.agentCwd, 'profiles');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    return;
  }
  let changed = 0;
  for (const f of files) {
    const chatKey = f.replace(/\.json$/, '').replace('_', ':');
    const data = loadProfiles(cfg.agentCwd, chatKey);
    let dirty = false;
    for (const p of Object.values(data.people || {})) {
      if (settleHourlyChat(p, bj.key, hourKey).gained > 0) dirty = true;
    }
    if (dirty) {
      saveProfiles(cfg.agentCwd, chatKey, data);
      changed += 1;
    }
  }
  if (changed) note('info', `好感小时结算：${changed} 个会话有变化（${hourKey}）`);
}

/**
 * 自动从聊天里提炼/更新「关于他」。
 *
 * 省 token：改成一**周**跑一次（`aboutAt` 距今不足 7 天就跳过），
 * 且只在「这人这段时间有新消息」时才重写——否则白跑一遍模型。
 * 每个会话最多 3 人、整轮最多 5 次调用。
 */
const ABOUT_REFRESH_MS = 7 * 24 * 3600 * 1000;

async function refreshAboutTexts(now = Date.now()) {
  const dir = path.join(cfg.agentCwd, 'profiles');
  if (!fs.existsSync(dir)) return;
  let calls = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const chatKey = f.replace(/\.json$/, '');
    const pr = loadProfiles(cfg.agentCwd, chatKey);
    const targets = Object.values(pr.people)
      .filter((p) => ensureFavor(p) >= FAVOR.obey)
      .filter((p) => now - Number(p.aboutAt || 0) >= ABOUT_REFRESH_MS)
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .slice(0, 3);
    for (const p of targets) {
      if (calls >= 5) return; // 别把 30 分钟窗口花在提炼上
      const rows = readJsonl(history.file(chatKey), 400)
        .filter((r) => Number(r.uid) === Number(p.uid) || r.role === 'bot')
        .slice(-60);
      if (rows.length < 8) continue;
      // 这段时间没新消息就不重写
      const lastMsgAt = Number(rows[rows.length - 1]?.t || 0);
      if (lastMsgAt <= Number(p.aboutAt || 0)) continue;

      const material = rows.map((r) => {
        const who = (r.role === 'bot' || r.role === 'assistant' || r.self === true) ? charName('我') : (r.name || '对方');
        return `${who}: ${String(r.text).slice(0, 120)}`;
      }).join('\n');
      const prompt = [
        `下面是你和「${p.displayName}」最近的聊天记录。`,
        '请写一段**关于这个人**的客观描述，给未来的你参考。',
        '要求：',
        '- 400~800 字，第三人称视角（写「他」），不要写成对话。',
        '- 只写记录里能看出来的：他是谁、什么作息、聊什么、在意什么、脾气如何、和你什么关系、有没有踩过雷。',
        '- 不确定的一律不写，绝不编。',
        '- 不要 Markdown、不要列表、不要标题，直接输出正文。',
        '',
        material,
      ].join('\n');
      try {
        const r = await runner.run({ prompt });
        if (r.ok && r.text?.trim()) {
          writeNotebook({
            agentCwd: cfg.agentCwd, chatKey, uid: p.uid,
            favor: ensureFavor(p), about: r.text.trim(),
          });
          p.aboutAt = now;
          saveProfiles(cfg.agentCwd, chatKey, pr);
          calls++;
          note('info', `维护：更新了 ${p.displayName} 的档案（${r.text.trim().length} 字）`);
        }
      } catch (e) {
        note('warn', `维护：${p.displayName} 档案提炼失败 ${e.message}`);
      }
    }
  }
}

/* ---------- 晚安（每天 23:30，叫第六档以上的人） ---------- */

const GOODNIGHT_MIN = 23 * 60 + 30;

// 2026-10-27 用户改：不 @ 了，直接把称呼写进句子里；名单只给第六档（1080）以上；
// 每次说的话要换着来，不能天天一句「晚安，早点睡」。
// {n} 会被换成她平时怎么叫这个人。
const NIGHT_LINES = [
  '{n}，晚安，早点睡。',
  '{n} 睡吧，明天还得早起呢。',
  '晚安啦{n}，别熬夜了。',
  '{n}，我先眯了，你也早点躺。',
  '晚安{n}，做个好梦。',
  '{n} 该睡了，手机放下。',
  '{n}，晚安，明天见。',
  '睡啦睡啦，{n}也快点睡。',
  '{n} 晚安，被子盖好。',
  '晚安{n}，别又刷到两点。',
  '{n}，今天够了，睡吧。',
  '晚安，{n}，明天再说。',
  '{n} 早点睡，熬夜掉头发的。',
  '晚安{n}，梦里别找我干活。',
  '{n}，晚安，我在呢。',
  '好了{n}，睡吧，晚安。',
  '{n} 晚安，明天有事喊我。',
  '晚安{n}，别想太多，睡就是了。',
  '{n}，灯关了吧，晚安。',
  '晚安啦，{n}，明早见。',
  '{n} 该熄灯了，晚安。',
  '喏，晚安{n}，别撑了。',
];
const NAP_LINES = [
  '{n}，午安，睡一会儿吧。',
  '午安{n}，眯一觉。',
  '{n} 去睡吧，午安。',
  '午安，{n}，别硬撑。',
  '{n}，午安，睡醒了再说。',
  '午安{n}，手机放下睡。',
  '{n}，去躺一会儿，午安。',
  '午安啦{n}，睡饱了才有力气。',
];

/** 从池子里挑一句还没用过的（一批人里尽量不重样） */
function pickGreet(pool, used) {
  const avail = pool.filter((s) => !used.has(s));
  const arr = avail.length ? avail : pool;
  const s = arr[Math.floor(Math.random() * arr.length)];
  used.add(s);
  return s;
}

/** 主人按第八档算（权限上永远给满） */
function isOwnerUid(uid) {
  return (cfg.raw.persona?.ownerUids ?? []).includes(Number(uid));
}

/**
 * 晚安 / 午安。
 *
 * 默认 23:30 统一叫第六档以上（好感 1080 起）的人，不 @，把称呼写进句子里。
 * 但有人说过自己几点睡，就按他的点单独叫：
 *   - 说「下午两点前睡」这种 → 那个点发**午安**，23:30 的晚安里照样保留他
 *   - 说「我十一点睡」→ 22:5x 左右单独跟他说晚安，23:30 那次就不再叫他
 *
 * 只在对应时间窗口里才读文件，平时一次 IO 都不做。
 */
async function runGoodnight(now = new Date()) {
  const bj = beijingNow(now);
  const mins = bj.hour * 60 + bj.minute;
  const isMainWindow = mins >= GOODNIGHT_MIN && mins <= GOODNIGHT_MIN + 20;
  const marker = path.join(cfg.agentCwd, 'goodnight-state.json');
  let state0 = {};
  try { state0 = JSON.parse(fs.readFileSync(marker, 'utf8')) || {}; } catch { /* 没发过 */ }
  const mainSent = state0.lastDay === bj.key;
  const perSent = state0.perPerson || {};   // `${uid}@${hhmm}` → true

  if (!isMainWindow && mainSent) {
    // 主窗口发过了，还要看看有没有人到自己的点
  } else if (!isMainWindow && !mainSent) {
    // 不在 23:30 窗口，但可能在别人的睡觉点——继续往下走
  }
  if (isMainWindow && mainSent) return;

  let touched = false;
  for (const [gid] of cfg.groupAllow) {
    const chatKey = `group:${gid}`;
    const profiles = loadProfiles(cfg.agentCwd, chatKey);
    const people = Object.values(profiles.people);

    // 1) 主窗口 23:30：叫第六档以上、且没说「我更早睡」的人
    if (isMainWindow && !mainSent) {
      const ids = people
        .filter((p) => levelOf(qualifiedFavor(p), isOwnerUid(p.uid)) >= 6)
        .filter((p) => {
          const s = p.sleepAt;
          if (!s) return true;
          const m = s.hour * 60 + s.minute;
          // 自己定的点晚于 23:30（或就是 23:30），主窗口照发
          return m >= GOODNIGHT_MIN;
        })
        .sort((a, b) => ensureFavor(b) - ensureFavor(a));
      if (ids.length) {
        const used = new Set();
        let ok = 0;
        for (const p of ids) {
          const nm = callName(p);
          const text = pickGreet(NIGHT_LINES, used).replace(/\{n\}/g, nm);
          try {
            await ob.sendGroup(gid, [{ type: 'text', data: { text } }]);
            ok++;
          } catch (e) {
            note('warn', `[group:${gid}] 晚安发送失败（${nm}）：${e.message}`);
          }
          if (ids.length > 1) await sleep(700);
        }
        note('info', `[group:${gid}] 晚安已发，叫了 ${ok} 个人`);
      }
    }

    // 2) 每个人自己的睡觉点
    for (const p of people) {
      const s = p.sleepAt;
      if (!s) continue;
      if (levelOf(qualifiedFavor(p), isOwnerUid(p.uid)) < 6) continue;   // 第六档以下不单独道安
      const key = `${p.uid}@${s.hour}:${s.minute}`;
      if (perSent[key]) continue;
      if (s.hour !== bj.hour || Math.abs(s.minute - bj.minute) >= 10) continue;
      const isNap = s.hour >= 11 && s.hour < 16;    // 中午那段小睡才算「午安」，凌晨一点睡也得说晚安
      const word = isNap ? '午安' : '晚安';
      const nm = callName(p);
      const text = pickGreet(isNap ? NAP_LINES : NIGHT_LINES, new Set()).replace(/\{n\}/g, nm);
      try {
        await ob.sendGroup(gid, [{ type: 'text', data: { text } }]);
        perSent[key] = true;
        touched = true;
        note('info', `[group:${gid}] ${word}已单独发给 ${p.displayName}（${s.hour}:${String(s.minute).padStart(2, '0')}）`);
      } catch (e) {
        note('warn', `[group:${gid}] ${word}发送失败：${e.message}`);
      }
    }
  }

  if (isMainWindow && !mainSent) {
    fs.writeFileSync(marker, JSON.stringify({ lastDay: bj.key, perPerson: perSent }), 'utf8');
  } else if (touched) {
    fs.writeFileSync(marker, JSON.stringify({ lastDay: state0.lastDay, perPerson: perSent }), 'utf8');
  }
}

/* ---------- 指令行：提醒 / 群管理 / 点歌 ---------- */

/**
 * 执行模型输出了的指令行（那几行不发给对方）。
 * 返回 { did, problems }：did 用来判断「这轮到底做成事没有」，
 * problems 只有在该说的话一句都没有时才回一句，免得它嘴上答应了实际没办。
 */
async function runDirectives(session, dir, { last, profiles, batchText = '', recent = [] }) {
  let did = false;
  const problems = [];
  const ownerUids = cfg.raw.persona?.ownerUids ?? [];
  const senderUid = Number(last.uid);
  const isOwner = ownerUids.includes(senderUid);
  const trusted = cfg.trusted.has(senderUid);

  // 称呼只在「对方真的提了这件事」时才改：模型有时候会把一个普通问句
  // （「我叫什么？」）也当成改称呼，别让它乱动已经定下来的名字。
  const NICK_REQUEST = /(叫我|叫你|叫他|叫她|别叫|不叫|甭叫|改名|外号)/;
  const nickAsked = NICK_REQUEST.test(String(batchText || ''));
  if (dir.nicks.length && !nickAsked) {
    note('info', `[${session.key}] 这轮没人提称呼，忽略 ${dir.nicks.length} 条 __NICK__`);
    dir.nicks = [];
  }

  for (const n of dir.nicks) {
    const name = String(n?.name ?? '').trim().slice(0, 12);
    const targetUid = Number(n?.uid || senderUid);
    // 号主的叫法不许模型自己改：模型认错过（把「主人」安成顾鹤的名字）。
    // 号主固定叫「祈羽」，要改只能改 config.persona.ownerUids 对应的档案。
    if (ownerUids.includes(targetUid)) {
      note('warn', `[${session.key}] 忽略对号主称呼的 __NICK__（${name || '空'}），号主固定叫「祈羽」`);
      continue;
    }
    const isSelf = targetUid === senderUid;
    // 自己的称呼自己说了算；改别人只有号主能改
    if (!isSelf && !isOwner) {
      note('warn', `[${session.key}] 非号主要改 ${targetUid} 的称呼，拒绝`);
      continue;
    }
    if (!Number.isFinite(targetUid) || targetUid <= 0) continue;
    const people = profiles?.people ?? {};
    const target = people[targetUid] ?? (people[targetUid] = {
      uid: targetUid, displayName: String(n?.displayName || targetUid), nickFor: '', favor: FAVOR.init, threshold: '中',
    });
    const before = callName(target);
    target.callOverride = { name, by: isSelf ? 'self' : 'owner', at: Date.now() };
    // 称呼跟着人走，不跟着群走：写进全局表，别的会话也立刻生效
    setGlobalNick(cfg.agentCwd, targetUid, target.callOverride);
    // 点过名的叫法也算这个人的别名（认人时靠它把外号对回 QQ 号）
    if (name) {
      try { recordIdentity(cfg.agentCwd, targetUid, name); } catch { /* 记不上不影响 */ }
    }
    if (profiles) saveProfiles(cfg.agentCwd, session.key, profiles);
    did = true;
    note('info', `[${session.key}] 称呼 ${before} → ${name || '（不用外号）'}（${isSelf ? '本人' : '号主'}要求）`);
  }

  // __MOOD__：只写 pendingModelDelta + 落盘，本轮不动 v；下一轮第 2 步才并进 Δtarget。
  // 不设 did = true：只有 __MOOD__ 没有正文时应判为沉默，不是「做了事」。
  if (dir.moods.length) {
    if (emotionConfig(cfg).enabled) {
      const emoCfg = emotionConfig(cfg);
      let st = loadEmotion(cfg);
      for (const payload of dir.moods) {
        const parsed = parseMoodDirective(payload);
        if (parsed.error) {
          note('warn', `[${session.key}] __MOOD__ 解析失败：${parsed.error}`);
          continue;
        }
        st = applyModelDelta(st, parsed.delta, emoCfg);
        note('info', `[${session.key}] 情绪 __MOOD__ Δv=${parsed.delta.dvalence} Δa=${parsed.delta.darousal}${parsed.why ? `（${parsed.why}）` : ''}`);
      }
      saveEmotion(cfg, st);
    } else {
      note('info', `[${session.key}] 情绪引擎已关闭，忽略 ${dir.moods.length} 条 __MOOD__`);
    }
  }

  // 发语音 / 发表情：不是号主、不是可信用户，就要看好感
  const actionFavor = favorOf(session, senderUid, last.name);
  const voiceAllowed = isOwner || trusted || actionFavor.favor >= VOICE_FAVOR();
  const stickerAllowed = isOwner || trusted || actionFavor.favor >= STICKER_FAVOR();
  const strictMode = isOwner || trusted || actionFavor.favor >= STRICT_FAVOR();

  // 兜底：模型只嘴上答应、没写 __REMIND__（2026-10-26 连着两次抓到没喊人，见 remind-guess.mjs）
  // 2026-10-26：群里也走兜底（Y.C 08:56 那句「10点叫我」就是这么漏的），门槛跟正式路径一致
  if (!dir.reminds.length && (session.kind === 'private' || isOwner || trusted || actionFavor.favor >= REMIND_FAVOR())) {
    const guess = guessReminder(last.text);
    if (guess) {
      const res = addReminder(cfg, {
        chat: session.key, at: guess.at, text: guess.text,
        from: { uid: last.uid, name: last.name },
      });
      if (res.ok) {
        did = true;
        note('info', `[${session.key}] 兜底设提醒 ${fmtAt(res.at)}：${guess.text}（模型没写 __REMIND__）`);
      } else {
        note('warn', `[${session.key}] 兜底设提醒失败：${res.error}（at=${guess.at}）`);
      }
    }
  }

  for (const r of dir.reminds) {
    // 设提醒要看好感（2026-10-25 用户定：默认 70，号主/可信不看分）
    if (session.kind === 'group' && !isOwner && !trusted) {
      const need = REMIND_FAVOR();
      if (actionFavor.favor < need) {
        note('info', `[${session.key}] 好友感不足设提醒（${actionFavor.favor} < ${need}），忽略`);
        problems.push(`设提醒得等好感 ${need} 以上，你还差 ${need - actionFavor.favor} 分`);
        continue;
      }
    }
    const res = addReminder(cfg, {
      chat: session.key, at: r.at, text: r.text,
      from: { uid: last.uid, name: last.name },
    });
    if (res.ok) {
      did = true;
      note('info', `[${session.key}] 定时提醒 ${fmtAt(res.at)}：${res.text}`);
    } else {
      note('warn', `[${session.key}] 设提醒失败：${res.error}（${JSON.stringify(r)}）`);
      problems.push('这个点我记不住');
    }
  }

  for (const id of dir.cancels) {
    const res = cancelReminder(cfg, session.key, id);
    if (res.ok) {
      did = true;
      note('info', `[${session.key}] 已取消提醒 ${res.id}（${fmtAt(res.at)} ${res.text}）`);
    } else {
      note('warn', `[${session.key}] 取消提醒失败：${res.error}`);
    }
  }

  const ADMIN_MIN_LEVEL = { title: 6, notice: 6, mute: 7, unmute: 7, set_admin: 7 };
  const actorLevel = isOwner ? 8 : levelOf(qualifiedFavor(actionFavor), false);
  for (const op of dir.admin) {
    const adminKind = String(op?.op || '').toLowerCase();
    // 2026-10-28 用户定档位：六档能用头衔和群公告，七档解锁禁言和设管理，踢人只有主人能下。
    // 撤回和点赞这两种她一直可以自己来（like 只是加个表情回应，动不了人）。
    const selfServe = adminKind === 'recall' || adminKind === 'recall_last' || adminKind === 'like';
    if (!isOwner) {
      const need = ADMIN_MIN_LEVEL[adminKind] || 0;
      if (adminKind === 'kick') {
        note('warn', `[${session.key}] 非号主要踢人，拒绝：${JSON.stringify(op)}`);
        problems.push('踢人这事只有主人能下');
        continue;
      }
      if (need && actorLevel < need) {
        note('info', `[${session.key}] 群管理 ${adminKind} 档位不够（第${actorLevel}档 < ${need}）`);
        problems.push('这个得等关系再近些');
        continue;
      }
      if (!selfServe && !need) {
        note('warn', `[${session.key}] 非号主触发群管理 ${adminKind}，拒绝：${JSON.stringify(op)}`);
        continue;
      }
    }
    if (session.kind !== 'group') {
      note('warn', `[${session.key}] 私聊里没有群管理可做`);
      continue;
    }
    const r = await runAdminOp({
      ob,
      cfg,
      groupId: session.id,
      selfId: state.self?.user_id,
      op,
      lastBotMsgId: session.lastBotMsgId,
      actorIsOwner: isOwner,
      actorUid: senderUid,
      actorLevel,
      recent,
      favorOfUid: (uid) => {
        const pr = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, session.key));
        return Number(pr?.people?.[uid]?.favor ?? FAVOR.init);
      },
    });
    note(r.ok ? 'info' : 'warn', `[${session.key}] 群管理 ${op.op}：${r.message}`);
    // 2026-10-28 用户要求：管理员指令一成功，就把触发者登记进人物档案（他既然使唤我，就该被记住）
    if (r.ok && senderUid) {
      try {
        const pr2 = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, session.key));
        pr2.people = pr2.people || {};
        const uid2 = String(senderUid);
        const hit = (recent || []).find((m) => String(m.uid || m.user_id || '') === uid2);
        const rec = pr2.people[uid2] || (pr2.people[uid2] = {
          displayName: hit?.name || hit?.nickname || uid2,
          favor: FAVOR.init,
          firstSeen: Date.now(),
        });
        rec.displayName = rec.displayName || hit?.name || uid2;
        rec.lastSeen = Date.now();
        rec.adminCalls = Number(rec.adminCalls || 0) + 1;
        rec.lastAdminOp = op.op;
        rec.lastAdminAt = Date.now();
        saveProfiles(cfg.agentCwd, session.key, pr2);
        note('info', `[${session.key}] 已登记 ${rec.displayName} 的档案（群管 ${op.op}）`);
      } catch (e) {
        note('warn', `档案登记失败: ${e.message}`);
      }
    }
    if (r.ok) did = true;
    else problems.push(r.message);
  }

  for (const q of dir.music) {
    if (!musicConfig(cfg).enabled) continue;
    const needSong = MUSIC_FAVOR();
    if (!isOwner && !trusted && actionFavor.favor < needSong) {
      note('info', `[${session.key}] 好感不足点歌（${actionFavor.favor} < ${needSong}），忽略`);
      problems.push(`点歌得等好感 ${needSong} 以上，你还差 ${needSong - actionFavor.favor} 分`);
      continue;
    }
    const r = await sendSong({ ob, cfg, session, query: q, incomingDir, note });
    if (r.ok) did = true;
    else problems.push(r.message);
  }

  return { did, problems };
}

/** 到点发一条提醒：让模型用自己的话说，生成不出来就带个铃铛直接发 */
async function fireReminder(item) {
  const [kind, idPart] = String(item.chat).split(':');
  const gid = Number(idPart);
  const session = getSession(item.chat, kind, gid, kind === 'group' ? `群 ${gid}` : `私聊 ${gid}`);

  let line = '';
  try {
    const prompt = [
      '到点了。你之前答应过对方，要在现在提醒他一件事：',
      `「${item.text}」`,
      '用你平常说话的语气提醒他，20 字以内，像随口说的。',
      '不要解释，不要用「提醒」两个字开头，只输出这一句。',
    ].join('\n');
    const r = await runner.run({ prompt, toolMode: 'none' });
    if (r?.ok) line = String(r.text || '').trim().split(/\r?\n/)[0].slice(0, 60);
  } catch (e) {
    note('warn', `提醒措辞生成失败：${e.message}`);
  }
  if (!line || line === cfg.raw.reply.silenceToken) line = `⏰ ${item.text}`;

  const remindAtUid = item.from?.uid || 0;
  note('info', `[${session.key}] 提醒发送：at=${remindAtUid || '无'} ${line.slice(0, 20)}`);
  await sendText(session, line, null, { atUid: remindAtUid });
  history.append(session.key, {
    t: Date.now(), role: 'bot', name: charName('我'), text: line,
  });
}

/** 能力说明：只给用得上的人/场景，别每轮都白烧 token */
function capabilityHint(session, { isOwner, trusted, role, favor = 0 }) {
  const blocks = [
    // 称呼：人自己不喜欢被怎么叫，这是硬要求，比外号/亲密度都高
    '[称呼] 有人说不喜欢你叫他某个名字，或者让你换个叫法，立刻改口照办，'
    + '并单独输出一行记下来：\n__NICK__ {"name":"新叫法"}\n'
    + '（他不要外号就 {"name":""}；号主要你改叫别人，带 uid：{"uid":123456,"name":"小明"}）'
    + '本人和主人的要求优先于你自己起的外号，别争、别问为什么。',
  ];
  // 2026-10-26 用户定：群里好感够也能设提醒，写法一并给出来。
  // 原来只给私聊/号主/可信，群友只能靠【答应过的事】那句通用提示，命中率低，白漏单。
  const remindAllowed = isOwner || trusted || session.kind === 'private' || Number(favor) >= REMIND_FAVOR();
  if (remindersConfig(cfg).enabled && remindAllowed) {
    blocks.push(
      '[定时提醒] 有人让你将来某个点叫他（「十分钟后叫我」「明早八点提醒我喂鱼」），'
      + '单独输出一行（不要写成普通文字）：\n'
      + '__REMIND__ {"at":"+10m","text":"叫他喝口水"}\n'
      + 'at 优先写相对时长：+5m / +30m / +2h / +1d，桥自己换算，你千万别自己拼日期；'
      + '要落到钟点的写自然说法（「明天8点」「今晚10点半」「后天中午12点」）；'
      + '绝对时间（2026-10-26T08:00:00+08:00）只在必要时用，年-月-日必须照抄上面【当前状态】那行，不许自己编。'
      + 'text 是到点要说的事。你嘴上可以顺口应一句「行，八点叫你」。',
    );
  }
  // 2026-10-27：非号主也给它这段——它得知道自己撤得掉，也得知道边界在哪
  const adminRole = role === 'admin' || role === 'owner';
  if (session.kind === 'group' && adminConfig(cfg).enabled && (isOwner || adminRole)) {
    blocks.push(adminHint(role, true, { selfRecall: adminConfig(cfg).selfRecall?.enabled !== false }));
  }
  if (musicConfig(cfg).enabled && (session.kind === 'private' || isOwner || trusted)) {
    blocks.push(musicHint());
  }
  return blocks.join('\n\n');
}

/** 最近几条消息的 id，号主在群里撤回别人/自己的消息时要用 */
function recentIdsHint(batch) {
  const tail = batch.slice(-6).filter((m) => m.messageId);
  if (!tail.length) return '';
  return '【最近消息 id】（撤回要用）\n'
    + tail.map((m) => `${m.messageId}  【${m.name}】${String(m.text || '').slice(0, 40)}`).join('\n');
}

/* ---------- # 命令 / # 工作项 ---------- */

/**
 * 「#」开头的消息分两种走法（2026-10-25 用户定）：
 *   - **三个固定命令**（#好感度 / #心情 / #同步）：桥内直接答，必须执行；
 *   - **其它任意 #名称 …**：当成工作项，交给没有人设的 DSH 去干，也看好感门槛。
 * 以前只有「主人私聊」能进这个通道，现在任何会话都能，但先查好感：
 * 号主不看分；其他人要 >= commandFavor(默认 70)；发语音/表情/说说这类「用她的嘴」
 * 的动作要 >= voiceFavor(默认 35)；群管理类只认号主。
 */
const WORK_TEXT_MAX = 500;
/* 好感门槛（2026-10-25 用户定：统一按 FAVOR 分档，不再单独计一套）
 *   20 恢复 / 35 语音 / 50 表情 / 70 提醒 / 80 点歌·转发素材·「关于你」·严格模式 / 90 唱歌
 * 每一项都能被 config.agent.* 覆盖。 */
const FAVOR_TH = () => (cfg.raw.agent?.favorThresholds ?? {});
const COMMAND_FAVOR = () => Number(FAVOR_TH().command ?? cfg.raw.agent?.commandFavor ?? FAVOR.friend);
const VOICE_FAVOR = () => Number(FAVOR_TH().voice ?? cfg.raw.agent?.voiceFavor ?? 35);
const ACTION_VOICE_FAVOR = () => Number(cfg.raw.agent?.actionVoiceFavor ?? VOICE_FAVOR());
const STICKER_FAVOR = () => Number(FAVOR_TH().sticker ?? cfg.raw.agent?.stickerFavor ?? 50);
// 2026-10-26 用户定：好感 50 起就能在群里设提醒（原来跟随 FAVOR.friend=70，群里普通群友全被拒）
const REMIND_FAVOR = () => Number(FAVOR_TH().remind ?? cfg.raw.agent?.remindFavor ?? 50);
const MUSIC_FAVOR = () => Number(FAVOR_TH().music ?? cfg.raw.agent?.musicFavor ?? FAVOR.obey);
const SING_FAVOR = () => Number(FAVOR_TH().sing ?? FAVOR.sing);
const MEDIA_FAVOR = () => Number(FAVOR_TH().media ?? cfg.raw.agent?.mediaFavor ?? FAVOR.obey);
const NOTEBOOK_FAVOR = () => Number(FAVOR_TH().notebook ?? cfg.raw.agent?.notebookFavor ?? FAVOR.obey);
const ABOUT_FAVOR = () => Number(FAVOR_TH().about ?? cfg.raw.agent?.aboutFavor ?? FAVOR.obey);
const STRICT_FAVOR = () => Number(FAVOR_TH().strict ?? cfg.raw.agent?.strictFavor ?? FAVOR.obey);
// 本机干活（2026-10-28）：这是「借号主电脑跑东西」，门槛比普通工作项高，默认跟点歌一档。
const LOCAL_FAVOR = () => Number(FAVOR_TH().local ?? cfg.raw.agent?.localFavor ?? FAVOR.obey);

/** 这个人的好感够不够（号主永远够） */
function favorOk(session, uid, name, need, { isOwner = false } = {}) {
  if (isOwner) return { ok: true, favor: 100 };
  const f = favorOf(session, uid, name);
  return { ok: f.qualified >= need, favor: f.favor, qualified: f.qualified };
}

/**
 * /api/action 的好感门槛（纯函数，便于单测）：
 * 没带 by 的老调用放行；号主/可信放行；其他人按好感判断，不够就拒。
 */
export function actionGate({ by, favor, isTrusted, need }) {
  if (!by) return { ok: true, why: 'no-by' };
  if (isTrusted) return { ok: true, why: 'trusted' };
  if (Number(favor) < Number(need)) {
    return { ok: false, error: `发起人好感 ${favor} 不到 ${need}，不替这么熟度的人发语音/表情` };
  }
  return { ok: true, why: 'favor' };
}

/** 认命令行：# 命令 / #名称 后面可能跟空格再接内容；「# 心情」这种空 extra 也算 */
function matchCommandLine(text) {
  const m = /^[#＃]\s*([^\s#＃]{1,20})(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { name: m[1], extra: String(m[2] || '').trim() };
}

/** 读一个人的好感（只读，顺带把档位算出来；不推进小时结算） */
/** 把「这个人现在够哪些」讲给模型听，省得它越权许诺 */
function favorCapabilityHint({ isOwner, trusted, favor, qualified }) {
  if (isOwner) return '【他能让你做什么】主人：全部都能，说什么就做什么。';
  // 门槛按历史最高分算（2026-10-27）：分掉了，解锁过的能力不收回
  const gate = Math.max(Number(favor) || 0, Number(qualified ?? favor) || 0);
  const lines = [];
  const yes = [];
  const no = [];
  const mark = (name, need) => (gate >= need ? yes : no).push(name);
  mark('发语音', VOICE_FAVOR());
  mark('发表情', STICKER_FAVOR());
  mark('设提醒', REMIND_FAVOR());
  mark('点歌', MUSIC_FAVOR());
  mark('转发素材', MEDIA_FAVOR());
  mark('记事本', NOTEBOOK_FAVOR());
  mark('#指令', COMMAND_FAVOR());
  mark('唱歌', SING_FAVOR());
  if (gate >= 1680) lines.push('情侣那档的亲近都行：轻抱轻亲、依偎、喂食、贴贴、专属外号');
  if (gate >= 2400) lines.push('恋人的撒娇全开：叠字、装哭、赖着不起来');
  if (trusted) lines.push('（这人是你信得过的，不分档都行）');
  if (yes.length) lines.push(`能做：${yes.join('、')}`);
  if (no.length) lines.push(`还没到：${no.join('、')}——他要的时候就说「还不到时候」，别假装办了，也别报分数线`);
  return `【他能让你做什么】${lines.join('；')}`;
}

function favorOf(session, uid, name) {
  const profiles = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, session.key));
  let person = profiles.people[uid];
  if (!person) {
    person = profiles.people[uid] = {
      uid, displayName: name, nickFor: defaultNick(''), favor: FAVOR.init, threshold: '中',
    };
  }
  ensureFavor(person);
  // qualified = 历史最高分，门槛按它算（2026-10-27：分可以掉，资格不收回）
  return {
    favor: person.favor,
    qualified: qualifiedFavor(person),
    tier: tierOfPerson(person),
    person,
    profiles,
  };
}

/**
 * 工作项通道：把自己当成服务器上的运维助手，用 DSH 真干活，不许演。
 * 发语音 / 表情 / 说说这类桥内能力不在 DSH 的工具集里，桥在本地控制台开了
 * POST /api/action 让它 curl（2026-10-23 用户要求统一走 DSH）。
 */
async function runWorkItem(session, batch, rawLine, { who, canActOnMe, overFavor }) {
  const startedAt = Date.now();
  const m = matchCommandLine(rawLine);
  const cmd = m ? String(m.extra || '') : String(rawLine).replace(/^\s*#[\s＃]*/, '').trim();
  const name = m?.name || '';
  const say = async (text) => {
    await sendText(session, text, null);
    history.append(session.key, {
      t: Date.now(), role: 'bot', name: charName('我'), text,
    });
  };

  note('info', `[${session.key}] 工作项 #${name}（${who.name} 好感 ${overFavor}）：${cmd.slice(0, 60) || '（没写内容）'}`);

  // #同步：把她在这台服务器上积累的记忆库/知识库，和主人本机那份对一遍。
  // 桥连不到本机（本机可能关机），所以只落一个待同步标记；
  // 本机的计划任务 DSH-Chat-Sync（登录时 + 每 2 分钟）看到标记就跑 tools/chat-sync.py。
  if (name === '同步' || /^同步/.test(cmd)) {
    try {
      const dir = path.join(cfg.dataDir, 'sync');
      fs.mkdirSync(dir, { recursive: true });
      const at = Date.now();
      fs.writeFileSync(
        path.join(dir, 'pending.json'),
        JSON.stringify({
          at,
          atText: new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
          text: cmd,
          clearedAt: null,
        }, null, 2),
        'utf8',
      );
      await say('记下了 · 本机开着的话两分钟内同步，关着就等它开机补');
      note('info', `[${session.key}] #同步：已写待同步标记`);
    } catch (e) {
      await say(`同步标记没写成功：${e.message}`);
      note('error', `[${session.key}] #同步 写标记失败：${e.message}`);
    }
    return;
  }

  // 全部交给 DSH——包括发语音 / 发表情 / 发说说。
  // 那三个能力不在 DSH 的工具集里，桥在本地控制台开了 POST /api/action 让它调。
  const prompt = [
    '你是这台服务器上的运维助手，负责照看 QQ 桥（工作目录 /root/qq-agent）。',
    '一条 QQ 消息以 # 开头，意思是「把它当成一个工作项去执行」，不是在聊天。',
    '',
    `工作项：#${name}${cmd ? ` ${cmd}` : ''}`,
    '',
    '要求：',
    '- 需要就调用 bash 工具执行（看文件、改文件、重启服务都可以）。',
    '- 只做这条命令要求的事，不要顺手改别的东西。',
    '- 完成后用一两句话回报：做了什么、结果或关键输出；失败就说失败在哪。',
    '- 回报是发给普通群友看的：不要 markdown 标题/列表/表格，不要代码块，不要贴报错堆栈、路径原文、命令回显。',
    '- 失败就说哪一步没成、卡在哪，一句话说完，不要复述你的探索过程。',
    '- 不要角色扮演，不要用撒娇或卖萌的语气。',
    '',
    '需要发语音 / 表情 / 说说时，调桥的本地接口，不要自己拼 NapCat：',
    '  POST http://127.0.0.1:3899/api/action',
    '  body 三种：{"op":"voice","text":"要说的话"} / {"op":"sticker","ref":"12"} / {"op":"qzone"}',
    '  sticker 的 ref：本会话素材用序号（如 "12"），共享图库用 S 开头（如 "S3"）。',
    '  默认发到主人私聊；要发到群里就加 "chat":"group:群号"。',
    '  **一定要带 "by":"发起人QQ号"**，桥按这个人的好感决定能不能调用。',
    `发起人：${who.name}（好感 ${overFavor}/100）`,
    canActOnMe
      ? '这条来自主人或主人点名的可信用户，你可以照办，但别越界（不要改配置、不要碰别人的档案）。'
      : '这条来自主人以外的人，只看不动：能查到就答，改不了就直说改不了，不要编。',
    `用「她」的嘴发语音 / 表情 / 说说要 ${ACTION_VOICE_FAVOR()} 以上的好感，低于这个只准用文字回答。`,
  ].join('\n');

  await sem.acquire();
  let r;
  try {
    r = await runner.run({
      prompt,
      toolMode: 'full',
      persona: false,
      // 普通群友只给只读，免得一条群消息就能改服务器
      permissionMode: canActOnMe
        ? (cfg.raw.agent?.commandPermissionMode || 'workspace-write')
        : 'read-only',
    });
  } finally {
    sem.release();
  }

  const elapsed = Date.now() - startedAt;
  if (!r?.ok) {
    const why = cleanToolReport(String(r?.stderr || '').slice(-500), { maxChars: 120 }) || '模型没有输出';
    await say(`工作项没办成：${why}`);
    audit(session, batch, null, 'command_failed', elapsed, r?.usage || null);
    return;
  }
  // 2026-10-26 事故：工作项回报原样（含 markdown、EACCES 原文、沙箱路径）发进群。
  // 这里收拾成一句人话；实在没内容就说不细说。
  const out = cleanToolReport(r.text) || '办完了，没有别的要报的';
  await say(out);
  note('info', `[${session.key}] 工作项 #${name} 完成（${elapsed}ms）`);
  audit(session, batch, `[命令] ${out.slice(0, 120)}`, 'command', elapsed, r.usage || null);
}

/* ---------- 一轮对话 ---------- */
async function handleBatch(session, batch) {
  const startedAt = Date.now();
  state.lastSession = session;

  // #关机 / #接管（2026-10-27 m02704）：桥这段时间不吭声，消息照收不误。
  // 只有主人发的 #回来 / #关机 这类能把它叫醒或再按下去。
  const muted = bridgeMuted(cfg);
  // #锁定关系：每轮把开关同步给 favor.mjs，锁住时好感/信任都不动
  setRelationLocked(relationLocked(cfg));
  // 群级静音（2026-10-27 #群聊 静音）：这些群一句话都不回，只有主人发 #群聊 能穿透
  const muteGroups = (cfg.raw.reply.muteGroups || []).map(String);
  if (session.kind === 'group' && muteGroups.includes(String(session.key).replace(/^group:/, ''))) {
    const raw0 = batch.map((m) => m.text || '').join('');
    const fromOwner0 = batch.some((m) => cfg.trusted.has(Number(m.uid)));
    if (!(fromOwner0 && /^[#＃]\s*群聊/.test(raw0.trim()))) {
      state.stats.skipped++;
      note('info', `[${session.key}] 本群已静音（#群聊 解除 可恢复）`);
      return;
    }
  }

  if (muted.paused || muted.takeover) {
    const raw = batch.map((m) => m.text || '').join('');
    const wake = /^[#＃]\s*(回来|接管|关机)/.test(raw.trim());
    const fromOwner = batch.some((m) => cfg.trusted.has(Number(m.uid)));
    if (!(wake && fromOwner)) {
      state.stats.skipped++;
      note('info', `[${session.key}] ${muted.paused ? '休眠' : '接管'}中，不回复`);
      return;
    }
  }

  // 0. 每日维护窗口（北京时间 04:00~04:30）：这段时间不回复，只把档案更新完
  if (inMaintenanceWindow()) {
    state.stats.skipped++;
    note('info', `[${session.key}] 维护窗口中（04:00~04:30），本轮不回复`);
    void runDailyMaintenance().catch((e) => note('warn', `每日维护失败: ${e.message}`));
    return;
  }

  // 1. 先把收到的话写进历史（不管后面回不回）
  // 说话人用【】框住：句子里的「我」是说话人自己，不是她
  const newLines = [];
  // 2026-10-26 修「反复发格式相似的句子」：被 @ 时 recentContext 会 unshift 回 buffer，
  // 同一句于是被写进 history 第二遍（实测用户消息重复 72/384）。按 messageId 去重，一句只写一次。
  const seen = session.seenMsgIds ?? (session.seenMsgIds = new Set());
  let appended = 0;
  for (const m of batch) {
    // 2026-10-27：自己发的也用【你】标，别用昵称——用昵称模型会当成别人在说话
    const line = `${hhmm(m.time)} 【${m.self ? '你' : speakerLabel(m)}】${m.text}`;
    newLines.push(line);
    const mid = m.messageId || `${m.uid}|${m.time}|${m.text}`;
    if (seen.has(mid)) continue;
    seen.add(mid);
    if (seen.size > 800) {
      const keep = [...seen].slice(-400);
      seen.clear();
      for (const k of keep) seen.add(k);
    }
    history.append(session.key, { t: m.time, role: m.self ? 'assistant' : 'user', name: m.name, text: m.text, uid: m.uid, messageId: mid });
    appended++;
  }

  // 1.5 后台压缩：消息攒够了就把更早的那段压成摘要（不阻塞这轮）
  void maybeSummarize({ cfg, runner, history, chatKey: session.key, note })
    .catch((e) => note('warn', `摘要任务失败: ${e.message}`));

  // 1.6 后台知识整理：聊完一波把梗/称呼/关系写进知识库（不阻塞接话这一步）
  void maybeDigestKnowledge({ cfg, runner, history, chatKey: session.key, note })
    .catch((e) => note('warn', `知识整理任务失败: ${e.message}`));

  // 1.65 知识库自动确认（2026-10-28 用户要求「自动收录无需我审批」）：
  // 兜住「她上一轮接话时自己 knowledge_write_node 写进去」那些节点，不留在面板等审。
  // 文件没变就直接返回，几乎零开销。
  try {
    const rv = autoReviewKnowledge(cfg);
    if (rv.cleared > 0) note('info', `[${session.key}] 知识库自动确认 ${rv.cleared} 条`);
  } catch (e) {
    note('warn', `知识库自动确认失败: ${e.message}`);
  }

  // 1.7 好感度查询：#好感度（任何人在群里 @ 它、或私聊发都行，不走模型）
  const favorMsg = batch.find((m) => isFavorCommand(m.text));
  if (favorMsg) {
    session.forceReplyUntil = 0;
    const who = favorMsg;
    const profiles = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, session.key));
    const person = profiles.people[who.uid] ?? (profiles.people[who.uid] = {
      uid: who.uid, displayName: who.name, nickFor: defaultNick(''), favor: FAVOR.init, threshold: '中',
    });
    ensureFavor(person);
    // 主人私聊的保底 90 要和正常对话时一致，不然一查变成 50 很奇怪
    if (session.kind === 'private' && cfg.raw.persona?.ownerUids?.includes(Number(who.uid)) && person.favor < FAVOR.sing) {
      person.favor = FAVOR.sing;
    }
    // 被查好感时立刻结算这一小时（用户要求：查询即刷新该对象的实时好感）
    const bjq = beijingNow();
    const hr = settleHourlyChat(person, bjq.key, `${bjq.key}T${bjq.hour}`);
    if (hr.gained) saveProfiles(cfg.agentCwd, session.key, profiles);
    const card = renderFavorCard(person, undefined, undefined, { isOwner: !!cfg.raw.persona?.ownerUids?.includes(Number(who.uid)) });
    if (session.kind === 'group') {
      await ob.sendGroup(session.id, [
        { type: 'at', data: { qq: String(who.uid) } },
        { type: 'text', data: { text: ` ${card}` } },
      ]);
    } else {
      await ob.sendPrivate(session.id, [{ type: 'text', data: { text: card } }]);
    }
    note('info', `[${session.key}] 好感度查询：${who.name} ${person.favor}`);
    return;
  }

  // 1.75 情绪查询：#心情（任何人在群里 @ 它、或私聊发都行，不走模型）
  // 内部指标（余温/饱和率/话痨值）一律不外露（§15.15）。
  const moodMsg = batch.find((m) => parseMoodCommand(m.text));
  if (moodMsg) {
    session.forceReplyUntil = 0;
    const profiles = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, session.key));
    const person = profiles.people[moodMsg.uid] ?? (profiles.people[moodMsg.uid] = {
      uid: moodMsg.uid, displayName: moodMsg.name, nickFor: defaultNick(''), favor: FAVOR.init, threshold: '中',
    });
    ensureFavor(person);
    // 主人私聊的保底 90 要和正常对话时一致
    if (session.kind === 'private' && cfg.raw.persona?.ownerUids?.includes(Number(moodMsg.uid)) && person.favor < FAVOR.sing) {
      person.favor = FAVOR.sing;
    }
    const emoCfg = emotionConfig(cfg);
    const emoState = emoCfg.enabled ? loadEmotion(cfg) : null;
    const card = renderMoodCard(emoState, {
      anger: { lv: Number(session.lastAngerLv ?? 0), name: ANGER_LEVELS[Number(session.lastAngerLv ?? 0)]?.name },
      favor: person.favor,
    });
    if (session.kind === 'group') {
      await ob.sendGroup(session.id, [
        { type: 'at', data: { qq: String(moodMsg.uid) } },
        { type: 'text', data: { text: ` ${card}` } },
      ]);
    } else {
      await ob.sendPrivate(session.id, [{ type: 'text', data: { text: card } }]);
    }
    note('info', `[${session.key}] 心情查询：${moodMsg.name} ${emoState ? emoState.emotion : '已关闭'}`);
    return;
  }

  // 1.8 # 命令 / # 工作项（任何会话都能用，先查好感）
  //   三个固定命令（#好感度 / #心情 / #同步）走桥内，必须执行；
  //   其它 #名称 … 当工作项交给 DSH；号主不看分，其他人看门槛。
  const last = batch[batch.length - 1];
  const ownerUids2 = cfg.raw.persona?.ownerUids ?? [];
  let isOwnerHere = ownerUids2.includes(Number(last.uid));
  if (!isOwnerHere) {
    try { isOwnerHere = cfg.trusted.has(Number(last.uid)); } catch { isOwnerHere = false; }
  }
  const hashLine = batch.map((x) => String(x.text || '')).find((t) => /^\s*[#＃]/.test(t));
  // 2026-10-26 用户要求「其实只要叫你唱就行，不用指令」：
  // 没打 # 也认点唱（私聊直接说，群里要先点名），走同一条排队逻辑。
  let singCmd = '';
  // 2026-10-28 修：点唱要看「说这句话的人」，不是这一批里最后说话的人。
  // 16:41:12 主人喊「@你 唱歌」，16:41:25 哦鲸鲸紧跟一句，批次最后是她（130 分）
  // → 主人的点唱被按她的分拦下，日志「翻唱被好感门槛拦下：130 < 660」。
  // 先逐条认（每条只看自己有没有被点名，免得把别人的「唱完就散」也算进来），
  // 一条都认不出才退回整批拼起来认（歌名拆成两条发的情况）。
  let singFrom = null;
  let singHit = null;
  let askFrom = null;
  let askHit = null;
  if (!hashLine) {
    const atMeAny = batch.some((x) => x.atMe || x.mentioned);
    // 问过「想听什么」之后，同一个人 5 分钟内回的那句话就当歌名（2026-10-28）
    const aw = session.awaitSong;
    if (aw && Date.now() - Number(aw.at || 0) < 5 * 60_000) {
      const m = [...batch].reverse().find((x) => Number(x.uid) === Number(aw.uid)
        && String(x.text || '').trim()
        && String(x.text).trim().length <= 30
        && !/^[#＃]/.test(String(x.text).trim())
        && !/[?？]$|吗$/.test(String(x.text).trim()));
      if (m) {
        session.awaitSong = null;
        singFrom = m;
        singHit = { body: String(m.text).trim(), word: aw.word || '翻唱', vague: false };
      }
    }
    if (!singHit) {
      for (const m of batch) {
        const one = detectSingRequest(String(m.text || ''), {
          isGroup: session.kind === 'group',
          atMe: m.atMe || m.mentioned,
        });
        if (one) { singFrom = m; singHit = one; }
      }
    }
    if (!singHit) {
      const said = batch.map((x) => String(x.text || '')).join(' ').trim();
      singHit = detectSingRequest(said, { isGroup: session.kind === 'group', atMe: atMeAny });
    }
    // 「我可以点翻唱吗」这种征求许可的：按好感度回（2026-10-28 用户定）
    if (!singHit) {
      for (const m of batch) {
        const ask = detectSingAsk(String(m.text || ''), {
          isGroup: session.kind === 'group',
          atMe: m.atMe || m.mentioned,
        });
        if (ask) { askFrom = m; askHit = ask; }
      }
    }
    if (!singHit && askFrom) {
      const af = favorOf(session, Number(askFrom.uid), askFrom.name);
      const isOwn = ownerUids2.includes(Number(askFrom.uid));
      if (!isOwn && af.favor < SING_FAVOR()) {
        await sendText(session, pickAskNotYet(), null);
        note('info', `[${session.key}] ${askHit.word}征求许可被婉拒：${askFrom.name}(${askFrom.uid})`);
        return;
      }
      session.awaitSong = { uid: Number(askFrom.uid), at: Date.now(), word: askHit.word };
      await sendText(session, pickAskSong(), null);
      note('info', `[${session.key}] ${askHit.word}征求许可：${askFrom.name}(${askFrom.uid})，先问想听什么`);
      return;
    }
    // 2026-10-28 用户定：「不带歌名就问要唱什么」。
    // 只说了「唱歌」「来一首」这种，body 会被当成歌名排进队列，然后去搜一首叫「歌」的歌失败。
    if (singHit && singHit.vague) {
      const who = singFrom || last;
      session.awaitSong = { uid: Number(who.uid), at: Date.now(), word: singHit.word };
      await sendText(session, pickAskSong(), null);
      note('info', `[${session.key}] 点唱没给歌名（${singHit.body}），先问要唱什么：${who.name}(${who.uid})`);
      return;
    }
    if (singHit && parseCoverParams(singHit.body).song) singCmd = `#${singHit.word} ${singHit.body}`;
  }
  const cmdLine = hashLine || singCmd;
  const actor = singFrom || last;
  if (cmdLine) {
    const FIXED_COMMANDS = ['好感度', '心情', '同步', '翻唱', '清唱', '音色', '本机', '语音库', '点播'];
    const hashParsed = matchCommandLine(cmdLine) || {};
    let hashName = hashParsed.name || '';
    let hashExtra = String(hashParsed.extra || '');
    // 中文口令常不打空格（#翻唱整首美人鱼）。不按前缀认的话整串会变成工作项名字，
    // 在群里就落到 DSH 沙箱那侧、写不进 data/cover/queue（2026-10-26 用户报）。
    if (!FIXED_COMMANDS.includes(hashName)) {
      const pref = FIXED_COMMANDS.find((c) => hashName.length > c.length && hashName.startsWith(c));
      if (pref) {
        hashExtra = `${hashName.slice(pref.length)}${hashExtra ? ' ' + hashExtra : ''}`.trim();
        hashName = pref;
      }
    }
    // 群里收到这些 #命令 一句话都不回（2026-10-26 用户要求：「群里收到"#sl"直接忽略」）。
    // 这类串没有实际工作项的含义，落到工作项通道只会白烧一轮 DSH 再回一句废话。
    const GROUP_IGNORED_COMMANDS = ['sl'];
    if (session.kind === 'group' && GROUP_IGNORED_COMMANDS.includes(hashName.toLowerCase())) {
      note('info', `[${session.key}] 群里忽略命令 #${hashName}`);
      return;
    }
    const fx = favorOf(session, Number(actor.uid), actor.name);
    const canActOnMe = ownerUids2.includes(Number(actor.uid)) || isOwnerHere;
    // 主人专属指令（#关机 #清屏 #格式化 …，2026-10-27 m02704）：只有主人能用，
    // 别人说同样的话一律拒绝，不解释为什么。
    if (isOwnerCommandName(hashName)) {
      if (!canActOnMe) {
        await sendText(session, '这个只有主人能让我做', null);
        note('info', `[${session.key}] #${hashName} 被非主人拒绝：${actor.name}(${actor.uid})`);
        return;
      }
      const done = await runOwnerCommand({
        name: hashName, extra: hashExtra, cfg, session, sendText, history, note,
      });
      if (done) return;
    }
    if (FIXED_COMMANDS.includes(hashName)) {
      // 固定命令：任何人都能查；#同步 只给号主
      if (hashName === '同步' && !canActOnMe) {
        await sendText(session, '这个只有主人能让我做', null);
        return;
      }
      if (hashName === '好感度') {
        session.forceReplyUntil = 0;
        if (session.kind === 'private' && ownerUids2.includes(Number(actor.uid)) && fx.person.favor < FAVOR.sing) {
          fx.person.favor = FAVOR.sing;
        }
        const card = renderFavorCard(fx.person, undefined, undefined, { isOwner: ownerUids2.includes(Number(actor.uid)) });
        if (session.kind === 'group') {
          await ob.sendGroup(session.id, [
            { type: 'at', data: { qq: String(actor.uid) } },
            { type: 'text', data: { text: ` ${card}` } },
          ]);
        } else {
          await ob.sendPrivate(session.id, [{ type: 'text', data: { text: card } }]);
        }
        note('info', `[${session.key}] 好感度查询：${actor.name} ${fx.person.favor}`);
        return;
      }
      if (hashName === '心情') {
        session.forceReplyUntil = 0;
        const emoCfg2 = emotionConfig(cfg);
        const emoState2 = emoCfg2.enabled ? loadEmotion(cfg) : null;
        const card = renderMoodCard(emoState2, {
          anger: { lv: Number(session.lastAngerLv ?? 0), name: ANGER_LEVELS[Number(session.lastAngerLv ?? 0)]?.name },
          favor: fx.person.favor,
        });
        if (session.kind === 'group') {
          await ob.sendGroup(session.id, [
            { type: 'at', data: { qq: String(actor.uid) } },
            { type: 'text', data: { text: ` ${card}` } },
          ]);
        } else {
          await ob.sendPrivate(session.id, [{ type: 'text', data: { text: card } }]);
        }
        note('info', `[${session.key}] 心情查询：${actor.name}`);
        return;
      }
      if (hashName === '语音库') {
        session.forceReplyUntil = 0;
        const items = await listVoices();
        if (!items.length) {
          const why = voicesError();
          await sendText(session, why ? `本机那边没连上，库里拿不到（${why}）` : '库里一首都没有，本机那个目录是空的', null);
          return;
        }
        const lines = items.slice(0, 40).map((it, i) => `${i + 1}. ${it.name.replace(/\.[^.]+$/, '')}`);
        const more = items.length > 40 ? `\n…还有 ${items.length - 40} 首` : '';
        await sendText(session, `本机存了 ${items.length} 首：\n${lines.join('\n')}${more}`, null);
        note('info', `[${session.key}] 语音库清单：${items.length} 首`);
        return;
      }
      if (hashName === '点播') {
        session.forceReplyUntil = 0;
        const target = await pickVoice(hashExtra);
        if (!target) {
          await sendText(session, '没找到这首，说个序号或者名字里的一截', null);
          return;
        }
        const got = await ensureRemote(target.name);
        if (!got.ok) {
          await sendText(session, '文件没推上来，卡在本机那头了', null);
          note('warn', `[${session.key}] 点播推送失败 ${target.name}：${got.msg}`);
          return;
        }
        try {
          const sent = await sendFileToChat({ ob, cfg, chat: session.key, filePath: got.path, name: target.name });
          note('info', `[${session.key}] 点播 ${target.name}（${humanSize(sent.bytes)}）`);
        } catch (e) {
          await sendText(session, `推上来了但发不出去：${String(e.message).slice(0, 50)}`, null);
          note('warn', `[${session.key}] 点播发送失败 ${target.name}：${e.message}`);
        }
        return;
      }
      if (hashName === '音色') {
        // 默认音色（2026-10-28 用户要）：选过一次，之后 #翻唱 / #清唱 不写音色就用它。
        // 音色清单由本机执行器推上来（data/cover/voices.json）——服务器上没有 RVCMAX。
        session.forceReplyUntil = 0;
        const arg = String(hashExtra || '').trim();
        const cat = readVoiceCatalog(cfg);
        const cur = readDefaultVoice(cfg);
        const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
        const showCur = cur && cur.voice !== 'keroro'
          ? `现在默认唱「${cur.voice}」（走 RVCMAX）`
          : '现在默认用自带的 keroro';

        // 只查看
        if (!arg || /^(看|查看|列表|list|有什么|状态)$/i.test(arg)) {
          const lines = [showCur, '换：#音色 音色名', '找：#音色 查 关键词', '换回自带：#音色 默认'];
          lines.push(cat.voices.length
            ? `本机现有 ${cat.voices.length} 个音色可挑`
            : '本机还没把音色清单传上来，过一会儿再查');
          await sendText(session, lines.join('\n'), null);
          return;
        }

        // 搜索
        const sea = arg.match(/^(?:查|搜|找|搜索)\s*(.*)$/);
        if (sea) {
          const q = String(sea[1] || '').trim().toLowerCase();
          if (!q) {
            await sendText(session, '查什么，像这样：#音色 查 白花', null);
            return;
          }
          const all = cat.voices.filter((v) => v.name.toLowerCase().includes(q) || v.id.includes(q));
          if (!all.length) {
            await sendText(session, cat.voices.length ? `没搜到「${q}」这个音色` : '音色清单还没传上来，过一会儿再搜', null);
            return;
          }
          const lines = all.slice(0, 10).map((v, i) => `${i + 1}. ${v.name}${v.id ? `（${v.id}）` : ''}`);
          const more = all.length > 10 ? `\n……还有 ${all.length - 10} 个` : '';
          await sendText(session, `搜到 ${all.length} 个：\n${lines.join('\n')}${more}\n想用哪个就发 #音色 名字`, null);
          note('info', `[${session.key}] 音色搜索「${q}」命中 ${all.length} 个`);
          return;
        }

        // 下面几个都是「改」——只有主人能改，别人只能查
        if (!canActOnMe) {
          await sendText(session, '这个只有主人能让我改', null);
          note('info', `[${session.key}] #音色 被非主人拒绝：${actor.name}(${actor.uid})`);
          return;
        }

        // 换回自带
        if (/^(默认|复位|重置|关掉|取消|keroro|原版)$/i.test(arg)) {
          writeDefaultVoice(cfg, { voice: 'keroro', by: Number(actor.uid) });
          await sendText(session, '行，换回自带的 keroro 了', null);
          note('info', `[${session.key}] 默认音色重置为 keroro`);
          return;
        }

        // 按名字/编号挑：先精确（名字或 id），退一步按名字包含
        const want = normName(arg);
        const byExact = cat.voices.filter((v) => normName(v.name) === want || String(v.id) === arg);
        const byPart = byExact.length ? [] : cat.voices.filter((v) => normName(v.name).includes(want));
        let picked = byExact.length ? byExact[0] : (byPart.length === 1 ? byPart[0] : null);
        if (!picked && byPart.length > 1) {
          const names = byPart.slice(0, 8).map((v) => v.name).join('、');
          await sendText(session, `对得上好几个：${names}\n说全一点，直接发 #音色 名字`, null);
          return;
        }
        // 清单为空 = 本机还没传上来：先按说的名字记下，唱不出来再改
        if (!picked && !cat.voices.length) {
          writeDefaultVoice(cfg, { voice: arg, by: Number(actor.uid) });
          await sendText(session, `清单还没传上来，我先按「${arg}」记着，要是唱不出来再改`, null);
          note('warn', `[${session.key}] 默认音色先记为「${arg}」（清单为空，未校验）`);
          return;
        }
        if (!picked) {
          await sendText(session, `没这个音色「${arg}」，搜一下：#音色 查 ${arg.slice(0, 4)}`, null);
          return;
        }
        writeDefaultVoice(cfg, { voice: picked.name, by: Number(actor.uid) });
        const engNote = engineForVoice(picked.name) ? '（走 RVCMAX）' : '（自带模型）';
        await sendText(session, `行，以后唱默认就用「${picked.name}」了${engNote}`, null);
        note('info', `[${session.key}] 默认音色 → ${picked.name}（${picked.id || '按名字'}）`);
        return;
      }
      if (hashName === '翻唱' || hashName === '清唱') {
        session.forceReplyUntil = 0;
        const accapella = hashName === '清唱';
        const word = accapella ? '清唱' : '翻唱';
        const parsed = parseCoverParams(hashExtra);
        const song = parsed.song;
        const need = SING_FAVOR();
        if (!song) {
          await sendText(session, `用法：#${word} 歌名 [音色 浅夏] [人声80 伴奏40 和声60 升调2]（增益按百分比，100=原样；音色写中文名）`, null);
          return;
        }
        if (!canActOnMe && fx.favor < need) {
          await sendText(session, `${word}得等好感 ${need} 以上（现在 ${fx.favor}）`, null);
          note('info', `[${session.key}] ${word}被好感门槛拦下：${fx.favor} < ${need}`);
          return;
        }
        // 先看本机（跑翻唱那台）在不在线：不在就不排任务，免得队列里躺一堆等不到人取的活。
        // 回话只用她自己的说法——不提本机/队列/开机这些过程。
        const alive = executorOnline(cfg);
        if (!alive.online) {
          await sendText(session, pickOfflineReply(word), null);
          note('info', `[${session.key}] ${word}被拦下：执行器不在线（心跳 ${alive.ts || '没有'}）`);
          return;
        }
        // 片段：默认只做副歌那 40~60 秒（语音条够长、跑得也快），说「完整/整首」才做全曲
        const segment = parsed.segment && parsed.segment.full
          ? null
          : (parsed.segment || { chorus: true });
        // 音色：命令里写了就用写的，没写就用 #音色 定的默认（默认存在服务器上）
        const defVoice = readDefaultVoice(cfg);
        const useVoice = parsed.voice || (defVoice && defVoice.voice) || '';
        const job = enqueueCover(cfg, {
          song, chat: session.key, by: Number(actor.uid),
          mode: accapella ? 'acappella' : 'vocal',
          voice: useVoice || undefined,
          // 非自带模型（keroro/feiyu）就走 RVCMAX 的 RVC_Core（397 个音色，含 .yuan 加密模型）
          engine: engineForVoice(useVoice),
          segment: segment || undefined,
          // 用户说「重唱/重新唱」时强制重跑，不查翻唱库
          redo: !!parsed.redo,
          params: {
            vocalGain: parsed.vocalGain,
            instGain: parsed.instGain,
            backingGain: parsed.backingGain,
            transpose: parsed.transpose,
            indexRate: parsed.indexRate,
          },
        });
        rememberCoverJob(cfg, job);
        const tuned = [
          parsed.vocalGain != null ? `人声${parsed.vocalGain}%` : '',
          parsed.instGain != null ? `伴奏${parsed.instGain}%` : '',
          parsed.backingGain != null ? `和声${parsed.backingGain}%` : '',
          parsed.transpose != null ? `变调${parsed.transpose > 0 ? '+' : ''}${parsed.transpose}` : '',
          parsed.indexRate != null ? `贴合${parsed.indexRate}%` : '',
          useVoice ? `音色${useVoice}` : '',
        ].filter(Boolean).join(' ');
        // 在线回话：随机拼一句「马上要唱」的话（不写死整句），也不提排队、不提要跑多久
        await sendText(session, `${pickOnlineReply(word, { full: segment === null })}${tuned ? `（${tuned}）` : ''}`, null);
        note('info', `[${session.key}] ${word}排队：《${song}》任务 ${job.id}（执行器在线）`);
        return;
      }
      if (hashName === '本机') {
        // 2026-10-28 用户要：「传输文件用本机 dsh 操作后再发回」。
        // 用法：#本机 <要干什么>；前面刚发过文件就自动拿那个文件当输入。
        session.forceReplyUntil = 0;
        const task = String(hashExtra || '').trim();
        if (!task) {
          await sendText(session, '用法：#本机 要干什么（先发文件的话，我自己拿它当输入）', null);
          return;
        }
        if (!canActOnMe && fx.favor < LOCAL_FAVOR()) {
          await sendText(session, `这个得等好感 ${LOCAL_FAVOR()} 以上（现在 ${fx.favor}）`, null);
          note('info', `[${session.key}] #本机 被好感门槛拦下：${fx.favor} < ${LOCAL_FAVOR()}`);
          return;
        }
        // 本机在不在：跟翻唱一样先看心跳，不在就不排，免得活躺在队列里等不到人
        const aliveLocal = localExecutorOnline(cfg);
        if (!aliveLocal.online) {
          await sendText(session, pickLocalMissReply(), null);
          note('info', `[${session.key}] #本机 被拦下：执行器不在线（心跳 ${aliveLocal.ts || '没有'}）`);
          return;
        }
        const recentFile = lastLocalInput(cfg, session.key);
        const job = enqueueLocal(cfg, {
          task, chat: session.key, by: Number(actor.uid), file: recentFile,
        });
        await sendText(session, pickLocalOkReply(), null);
        note('info', `[${session.key}] 本机活排队：${task.slice(0, 40)}（任务 ${job.id}${recentFile ? `，带文件 ${recentFile.name}` : '，无文件'}，队列 ${localQueueDepth(cfg)}）`);
        return;
      }
      if (hashName === '同步') {
        await runWorkItem(session, batch, cmdLine, { who: actor, canActOnMe, overFavor: fx.favor });
        return;
      }
    }
    // 工作项：好感够才办
    const need = COMMAND_FAVOR();
    if (!canActOnMe && fx.favor < need) {
      await sendText(session, `这条得等好感 ${need} 以上才办（现在 ${fx.favor}）`);
      note('info', `[${session.key}] 工作项 #${hashName} 被好感门槛拦下：${fx.favor} < ${need}`);
      return;
    }
    await runWorkItem(session, batch, cmdLine, {
      who: last, canActOnMe, overFavor: fx.favor,
    });
    return;
  }

  // 2. 冷却 / 限流
  // 被 @ / 被喊外号的那一轮要跨过冷却——但限流（防止被封）仍然生效。
  const forced = session.forceReplyUntil && Date.now() < session.forceReplyUntil;
  if (forced) {
    session.forceReplyUntil = 0;
    note('info', `[${session.key}] 被点名，跳过冷却直接回`);
  }
  const cooldown = cfg.raw.reply.cooldownMs[session.kind] ?? 0;
  if (cooldown && !forced && Date.now() - session.lastReplyAt < cooldown) {
    state.stats.skipped++;
    note('debug', `[${session.key}] 冷却中，跳过 ${batch.length} 条`);
    return;
  }
  if (!withinRate(session)) {
    state.stats.skipped++;
    note('warn', `[${session.key}] 触发限流，跳过 ${batch.length} 条`);
    return;
  }

  // 3. 组装 prompt
  const trusted = cfg.trusted.has(Number(last.uid));

  // 状态注入：时间 / 饱腹 / 下次开饭 / 所在群（心情走 emotion.mjs 的九档，这里不再算）
  session.moodState ?? (session.moodState = {});
  const stInfo = computeStatus({
    now: new Date(),
    groupName: session.kind === 'group' ? session.title : '',
  });

  // 怒气档位 + 人物档案（谁在戳她、怎么哄得动）
  const who = angerTarget(batch);
  // 主人私聊？作用域要提到函数级——下面「好感保底」和「# 命令」两处都要用（2026-10-25 修复：
  // 原来在 if (person) 块里用 const 声明，块外引用直接 ReferenceError，每条消息都报错不回复）
  const isOwnerPrivate = !!who && session.kind === 'private'
    && (cfg.raw.persona?.ownerUids || []).includes(Number(who.uid));
  const profiles = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, session.key));
  const person = who ? (profiles.people[who.uid] ?? (profiles.people[who.uid] = {
    uid: who.uid, displayName: who.name, nickFor: defaultNick(''), favor: FAVOR.init, threshold: '中',
  })) : null;

  // —— 好感度（百分制）——
  const bj = beijingNow();
  // 信任见底后的冷处理期：他说话也不理（用户 m01155「短期内不与之对话」）
  if (person && isSilenced(person)) {
    note('info', `[${session.key}] ${who.name} 还在冷处理期，这轮不回`);
    return;
  }
  let favorInfo = null;
  if (person) {
    person.displayName = who.name;
    const before = ensureFavor(person);
    rollDay(person, bj.key);
    const ev0 = analyzeBatch(batch);
    let delta = 0;
    const reasons = [];
    // 当天标记是二元的：聊天记「+」，惹她一次直接改写成「-」（当天不再加分）
    // 2026-10-27 用户定：说难听话不扣分——难听只是情绪，不算越界；
    // 代价只剩「当天标记为 -」，04:00 的日结不给分。
    if (ev0.fat || ev0.rude || ev0.joke) {
      reasons.push('惹她生气了（当天不结日分）');
      person.dayMark = '-';
      person.dayAngered = true;
      // 被骂把心情压下去 → 信任跟着掉（用户 m01155「被骂时下降…反之信任值下降」）。
      // 这条覆盖 2026-10-27 早些时候「说难听话不扣分」的口径。
      const tLoss = session.kind === 'private' ? FAVOR.angerTrustPrivate : FAVOR.angerTrustGroup;
      const tr = applyTrust(person, -tLoss, { dayKey: bj.key, reason: '被骂' });
      reasons.push(`被骂信任 ${tr.before}→${tr.after}`);
      const zero = checkTrustZero(person);
      if (zero) reasons.push(`信任见底：好感扣 ${zero.favorLoss}，${TRUST_ZERO_PENALTY.silenceHours} 小时内不理他`);
    }
    // 越界才真扣，受当日 -10 上限约束
    if (BOUNDARY.test(batch.map((m) => m.text || '').join('\n'))) {
      const rb = applyFavor(person, -FAVOR.boundaryLoss, { dayKey: bj.key });
      if (rb.applied < 0) reasons.push(`越界骂人 ${rb.before}→${rb.after}`);
    }
    if (ev0.praise || ev0.praiseStrong) { delta += FAVOR.praiseGain; reasons.push(`夸她 +${FAVOR.praiseGain}`); }
    person.dayMark = person.dayMark === '-' ? '-' : '+';
    person.dayChatted = true;
    person.lastChatAt = Date.now();
    // 每天第一次搭话给一点正向反馈：不靠"夸"也能慢慢涨，
    // 否则普通人聊一整天，好感一分不动（2026-10-25 用户反馈"好感度没有变化"）。
    if (person.dayBonusKey !== bj.key) {
      person.dayBonusKey = bj.key;
      const rb = applyFavor(person, 5, { dayKey: bj.key });
      if (rb.applied) reasons.push(`今天第一次搭话 +${rb.applied}（好感 ${rb.before}→${rb.after}）`);
    }
    if (delta) {
      const r = applyFavor(person, delta, { dayKey: bj.key });
      reasons.push(`好感 ${r.before}→${r.after}${r.capped ? '（当日上限）' : ''}`);
    }
    // 主人私聊：好感保底到第五档（旧 90 分那一档）
    if (isOwnerPrivate && person.favor < FAVOR.sing) {
      person.favor = FAVOR.sing;
      if (person.favor > (person.favorPeak || 0)) person.favorPeak = person.favor;
      reasons.push('主人的私聊，好感保底到第五档');
    }

    // 劝说：好感 >=70 的人替某个低好感的人说情
    //   一次生气最多吃两次；成功的劝说除了正常 +5，还会立刻归还一点脾气造成的损失
    {
      const favorNow = ensureFavor(person);
      const txt = batch.map((m) => m.text).join('\n');
      const DEFEND = /(别生气|原谅|算了吧|给他个机会|她也不是|他也不容易|消消气|别跟他计较)/;
      const times = Number(session.moodState?.persuadeTimes ?? 0);
      if (favorNow >= FAVOR.friend && DEFEND.test(txt) && times < FAVOR.angerPersuadeTimes) {
        for (const other of Object.values(profiles.people)) {
          if (other.uid === person.uid) continue;
          const nm = other.displayName;
          if (!nm || !txt.includes(nm)) continue;
          if (ensureFavor(other) >= FAVOR.friend) continue;
          if ((session.moodState.persuadeTimes || 0) >= FAVOR.angerPersuadeTimes) break;
          const pr = applyPersuade(other, person.uid, bj.key);
          if (pr.ok) {
            session.moodState.persuadeTimes = (session.moodState.persuadeTimes || 0) + 1;
            // 有效劝说：顺手把这人被脾气扣掉的那点还回去一点
            if (Number(other.tempPenalty || 0) > 0) {
              other.tempPenalty = Math.max(0, other.tempPenalty - FAVOR.persuadeGain);
            }
            reasons.push(`替 ${nm} 说情（第 ${session.moodState.persuadeTimes} 次），他好感 ${pr.before}→${pr.after}`);
          }
        }
      }
    }
    // 独占：第七档信任腰斩要掉好感，第八档的存在会压住别人（用户 m01108）
    const cdrop = applyConfidantTrustDrop(person);
    if (cdrop) reasons.push('第七档信任腰斩：好感真掉了');
    const exNotes = syncExclusive(profiles.people, { dayKey: bj.key });
    for (const n of exNotes) reasons.push('独占：' + n);
    favorInfo = {
      favor: ensureFavor(person),
      qualified: qualifiedFavor(person),
      trust: person.trust,
      tier: tierOfPerson(person),
      text: tierText(qualifiedFavor(person)),
    };
    if (reasons.length) note('info', `[${session.key}] 好感 ${reasons.join('；')}`);
    person.lastSeenAt = Date.now();

    // 他提过自己几点睡 → 记下来，晚安按他的点发
    for (const m of batch) {
      const sleep = parseSleepMention(m.text);
      if (sleep) {
        person.sleepAt = { hour: sleep.hour, minute: sleep.minute };
        person.napBefore = sleep.nap ? 14 : null;
        note('info', `[${session.key}] ${who.name} 说自己 ${String(sleep.hour).padStart(2, '0')}:${String(sleep.minute).padStart(2, '0')} 睡${sleep.nap ? '（午睡）' : ''}`);
        break;
      }
    }
    // 把好感/怒气档位写进档案：有人 @/喊她外号时，要靠它判断「她是不是正对这人冷淡」
    person.angerLv = Number(session.moodState?.angerLv ?? 0);
  }

  let anger = { lv: 0, name: ANGER_LEVELS[0].name, text: ANGER_LEVELS[0].text, changes: [] };
  if (person) {
    if (favorInfo) person.speakerFavor = favorInfo.favor;
    anger = updateAnger({
      now: new Date(),
      batch,
      moodState: session.moodState ?? (session.moodState = {}),
      profile: person,
    });
    touchIntimacy(person, Math.ceil(batch.length / 2));
    person.angerLv = anger.lv;

    // —— 生气时的临时扣分 / 消气归还 ——
    const prevLv = Number(session.lastAngerLv ?? 0);
    const isPrivate = session.kind === 'private';
    if (anger.lv >= 2 && prevLv < 2) {
      // 进入生气：这个会话里所有人暂时掉好感（群 -20 / 私聊 -10）
      let n = 0;
      for (const p of Object.values(profiles.people)) {
        if (Number(p.tempPenalty || 0) > 0) continue;
        const r = applyAngerPenalty(p, { isPrivate });
        if (r.applied) n++;
      }
      session.moodState.persuadeTimes = 0;
      note('info', `[${session.key}] 生气惩罚：${n} 人临时掉好感（${isPrivate ? 10 : 20}）`);
    }
    if (anger.lv === 0 && prevLv >= 2) {
      // 消气：原样还回去
      let n = 0;
      for (const p of Object.values(profiles.people)) {
        const r = restoreAngerPenalty(p);
        if (r.restored) n++;
      }
      session.moodState.persuadeTimes = 0;
      note('info', `[${session.key}] 消气了，归还 ${n} 人的临时扣分`);
    }

    saveProfiles(cfg.agentCwd, session.key, profiles);
    for (const c of anger.changes) note('info', `[${session.key}] 怒气 ${c}`);
    if (anger.lv !== Number(session.lastAngerLv ?? 0)) {
      note('info', `[${session.key}] 怒气档 ${session.lastAngerLv ?? 0} → ${anger.lv}（${anger.name}）`);
      session.lastAngerLv = anger.lv;
    }
  }

  // —— 情绪引擎 v2 八步管线（docs/emotion-v2.md §3.1）——
  const emoInfo = updateEmotion({
    cfg,
    now: new Date(),
    text: batch.map((m) => m.text).join('\n'),
    angerLv: anger.lv,
    hunger: stInfo.hunger,
  });

  // —— 表现层 v1：只读情绪快照与好感，算出「怎么说」（docs/emotion-v2.md §15）——
  let expressionInfo = null;
  if (emoInfo && expressionConfig(cfg).enabled) {
    expressionInfo = updateExpression({
      cfg,
      chatKey: session.key,
      now: new Date(),
      snapshot: emoInfo,
      favor: favorInfo?.favor ?? FAVOR.init,
      anger,
      text: batch.map((m) => m.text).join('\n'),
      respondedTo: forced || session.kind === 'private',
    });
  }

  // Lv3：只回「嗯」「哦」或者不回——直接卡死，不给模型发挥空间
  if (anger.lv >= 3 && anger.hardReplies) {
    const pick = anger.hardReplies[crypto.randomInt(anger.hardReplies.length)];
    state.stats.replied++;
    session.lastReplyAt = Date.now();
    await sendText(session, pick, last.messageId ?? null).catch(() => {});
    history.append(session.key, {
      t: Date.now(), role: 'bot', name: charName('我'), text: pick,
    });
    note('info', `[${session.key}] 真冷了，只回「${pick}」`);
    audit(session, batch, pick, 'replied', Date.now() - startedAt, null);
    return;
  }
  const emoName = emoInfo?.name || 'calm';
  const stKey = `${stInfo.hunger}|${emoName}`;
  if (session.moodState) session.moodState.lastMood = emoName;
  if (session.lastStateKey !== stKey) {
    note('info', `[${session.key}] 状态 → 饱腹:${stInfo.hunger} 情绪:${emoName}`);
    session.lastStateKey = stKey;
  }

  // 日记：换天会先写昨天那篇（约 500 字）、清空对话记录，再注入最近三天。
  // 省 token：当天**第一轮**给全量原文，后面几轮只给每天一行的压缩摘要；
  // 真想起细节时靠 backtrackDiaries 逐日回溯，不再每轮都塞 1500 字。
  await refreshDiaryIfNeeded();
  let diaryText = '';
  if (state.diaries?.length) {
    const first = !state.diaryFirstTurnDone;
    if (first && state.diaryTurnsLeft > 0) {
      diaryText = state.diaries.map((d) => `【${d.key}】\n${d.text}`).join('\n\n');
      state.diaryTurnsLeft--;
      state.diaryFirstTurnDone = true;
      note('debug', `[${session.key}] 今日首轮，注入三天日记全文（${diaryText.length} 字）`);
    } else if (state.diaryTurnsLeft > 0) {
      diaryText = compactDiaries(state.diaries);
      state.diaryTurnsLeft--;
    }
  }

  // 逐日回溯：对方提到更早的事，就去旧日记里翻对应的段落（翻不到就算了，绝不编）
  const back = backtrackDiaries(cfg.agentCwd, batch.map((m) => m.text).join('\n'), { days: 3 });
  const backText = renderBacktrack(back.hits);
  // 今天早些时候的滚动回忆（日记写完到现在那段空白）
  const briefText = renderBrief(cfg.dataDir, session.key);
  if (back.hits.length) {
    note('info', `[${session.key}] 回溯日记命中 ${back.hits.map((h) => h.key).join(', ')}`);
  }

  // 记事本（好感 >=80 才给）：他自己维护的「关于我」+ 待办提醒
  let notebookText = '';
  const nbFavor = favorInfo ? Math.max(favorInfo.favor, favorInfo.qualified ?? favorInfo.favor) : 0;
  if (person && favorInfo && nbFavor >= NOTEBOOK_FAVOR()) {
    notebookText = renderNotebook(cfg.agentCwd, session.key, person.uid, nbFavor);
  }
  // 认人（2026-10-25 用户要求）：QQ 号才是身份，别名只是叫法。
  // 本轮出现的人 + 消息里点到的别名，都给模型一张对照表，跨群同一个人就不会认错。
  let identityText = '';
  try {
    const nameNow = new Map();
    const uids = [];
    for (const m of batch) {
      const u = Number(m.uid);
      if (!Number.isFinite(u)) continue;
      if (!nameNow.has(u)) nameNow.set(u, m.name || '');
      uids.push(u);
    }
    for (const hit of resolveMentions(cfg.agentCwd, batch.map((m) => m.text).join('\n'))) {
      uids.push(hit.uid);
      if (!nameNow.get(hit.uid)) nameNow.set(hit.uid, hit.alias);
    }
    identityText = renderIdentityBlock(cfg.agentCwd, uids, nameNow);
  } catch { /* 认人失败就当没有 */ }

  // 主人私聊：强制同意「去别的群发消息」这类要求
  const isOwner = (cfg.raw.persona?.ownerUids || []).includes(Number(last.uid));
  // 主人点名要听语音：voiceHint 放行，模型不配合时还有兜底
  const wantsVoice = isOwner && asksForVoice(batch.map((m) => m.text).join('\n'));

  // 余额怎么答，按「谁在问」分三档：
  //   主人 → 如实报数字（余额 + 今天/累计花了多少）
  //   好感≥80 → 只说体感（>30 还很饱 / <10 有点饿了 / 中间不提）
  //   其他人 → 不给数字，只有低于阈值时那条「饿了」播报
  const balanceText = balanceLineFor({
    cny: state.balance,
    spend: state.spend || computeSpend(cfg.dataDir),
    isOwner,
    favor: favorInfo?.favor ?? 0,
  });
  const ownerRule = isOwnerPrivate
    ? '（这是主人的私聊。他让你去某个群发什么话、发语音、发表情，就照办，别推。'
      + '他消息里以 # 开头的，是让你改服务器上的东西，用工具去做。）'
    : '';
  // 主人私聊里的 # 命令：当成「改服务器」的指令交给 DSH，务必给工具
  const hasHashCommand = isOwnerPrivate && batch.some((m) => /^\s*#/.test(String(m.text || '')));
  // 工具权限分三档：
  //   full —— 只有 # 命令：全套工具（带工具＝system prompt 里会多约 1000 字工具说明）
  //   web  —— 被 @、被喊名字、或私聊：只有联网工具（能查天气新闻百科，碰不到文件）
  //   none —— 其余闲聊：不给工具，省 token 也省风险
  //
  // 2026-10-26 用户要求：「这段，只在 QQ 聊天读取的人设里删除，DSH 中仍保留」。
  // 原来 trusted（号主/可信用户）聊天也走 full，于是每轮 system 里除了 4648 字人设，
  // 还挂着 tool-bash / tool-fs 的工具规范（约 1000 字）。dsh-system-prompt 插件只有
  // includeHarnessIdentity / includeRuntimeContext 两个开关，关不掉工具说明，所以改成
  // 聊天一律不给工具——干活请走 # 命令（那条仍然 full）。
  let toolMode = 'none';
  if (hasHashCommand) toolMode = 'full';
  // 非号主/可信的人跑工作项时，权限跟好感走：<80 只能只读，>=80 才是 workspace-write
  let commandPermOverride = null;
  if (session.kind !== 'private' && !trusted && !isOwner) {
    const wf = favorOf(session, Number(last.uid), last.name).qualified;
    if (wf < STRICT_FAVOR()) commandPermOverride = 'read-only';
  }
  if (hasHashCommand) note('info', `[${session.key}] 收到主人 # 命令，带全套工具执行`);

  const toolRule = toolMode === 'full'
    ? ''
    : '（这轮你**没有联网**。遇到答不上来的知识类问题（具体数据、某地某事、新闻、天气、定义、'
      + '不是你我之间的事），**别猜**——只输出一行：__NEED_WEB__ 查询关键词。'
      + '在那之前可以先用一句话稳住对方，比如「你在此地勿要走动，我去查查便回来」。'
      + '程序会去查，然后把准确答案给你发出去。要是不需要查，就正常聊天。）';

  // 只把这轮真的新写进 history 的行数排除，别按 batch.length 排
  // （重复行被去重后 batch.length > 实际写入数，多排会把正常上下文也吃掉）
  const { transcript } = history.transcript(session.key, { excludeLast: appended });

  // 空的 @：这一轮的内容是「刚才那几条」，不是「一个 @」
  const bareAtHint = Boolean(session.bareAtAt && Date.now() - session.bareAtAt < 10_000);
  if (bareAtHint) session.bareAtAt = 0;

  // 群管理要看机器人是不是管理员；只在号主说话时查，别为每句群聊都戳一次 NapCat
  let botRole = 'member';
  if (session.kind === 'group' && isOwner && adminConfig(cfg).enabled) {
    botRole = await getBotRole(ob, cfg, session.id, state.self?.user_id).catch(() => 'member');
  }

  // 语料库：按当前情绪档抽几条骨架，直接注入本轮 prompt。
  // 以前人设里只写「要翻的时候用 read 打开」——模型几乎不翻，那份 8k 字的底本等于没影响。
  let corpusHint = '';
  try {
    const cc = cfg.raw.persona?.corpus || {};
    if (cc.enabled !== false) {
      const file = path.resolve(cfg.root, cc.file || 'persona/corpus.md');
      const corpus = loadCorpus(file);
      const used = Array.isArray(session.corpusUsed) ? session.corpusUsed : [];
      const sample = pickCorpusSamples(corpus, {
        emotion: emoName,
        text: batch.map((m) => m.text || '').join(' '),
        angerLv: Number(anger) || 0,
        hunger: stInfo.hunger,
        count: Number(cc.samplesPerTurn) || 8,
        used,
      });
      if (sample) {
        corpusHint = renderCorpusHint(sample, { charName: char().name });
        session.corpusUsed = [...used, ...sample.lines].slice(-60);
        note('debug', `[${session.key}] 语料注入 ${sample.id}(${sample.from.join('+')}) ${sample.lines.length} 条`);
      }
    }
  } catch (e) {
    note('debug', `语料注入失败：${e.message}`);
  }

  // 2026-10-27 用户报「分不清哪句话是谁发的、有时候把自己发的消息认作别人发的」。
  // 光统一标签还不够：模型得知道这场对话里到底有几个人。所以额外给一张显式说话人表，
  // 顺便点名「群友昵称撞了她的外号」这种坑——群里真有人就叫「哦鲸鲸」。
  const speakerTable = (() => {
    const names = new Set();
    const push = (r) => {
      if (!r) return;
      if (r.role === 'bot' || r.role === 'assistant' || r.self === true) return;
      const n = speakerLabel(r);
      if (n && n !== '有人') names.add(n);
    };
    for (const r of history.load(session.key).slice(-30)) push(r);
    for (const r of batch) push(r);
    const list = [...names].slice(0, 8);
    const own = [char().name, ...(char().aliases || [])].filter(Boolean);
    const clash = list.filter((n) => own.includes(n));
    return '【这场对话里的说话人】\n'
      + `·【你】= 你自己${own.length ? `（${own.join('、')}）` : ''}——**标签【你】只代表你自己说过的话**，别当成别人在说。\n`
      + (list.length ? `· 其他人用【昵称】标：${list.join('、')}\n` : '')
      + (clash.length
        ? `· 注意：这场对话里有人昵称就叫「${clash.join('、')}」，那**不是你**——他/她说的话不是你说的，别认成自己。\n`
        : '');
  })();

  // 2026-10-27 用户定的三套指令（config/commands.json，m02170）+ 关系层级（m02704）：
  // 带 # 的固定指令 = 照表里写的直接做；普通命令 = 按关系层级决定办不办；
  // 模糊指令 = 只摆可能性，做不做由她自己掂量。主人说什么都得办。
  let cmdHints = '';
  try {
    const ctable = loadTable(path.join(cfg.root, 'config', 'commands.json'));
    const qualified = favorOf(session, Number(last.uid), last.name).qualified;
    // 有人被 #最高权限 临时提权（默认 1 小时）时，按 level_4 对待
    const boosted = powerBoost(cfg) && powerBoost(cfg) === Number(last.uid);
    const level = boosted ? 4 : levelOf(qualified, isOwner);
    const picked = filterByGate(ctable, level, { isOwner });
    const batchText = batch.map((m) => m.text || '').join('\n');
    const hashCmd = (batchText.match(/^[#＃]\s*([^\s#＃]{1,20})/) || [])[1] || '';
    cmdHints = renderHints({
      ownerRule: renderOwnerRule(isOwner),
      levelRule: renderLevelRule(ctable, level, isOwner),
      hashMatch: hashCmd ? matchHash(picked, hashCmd) : null,
      commandMatch: matchCommand(picked, batchText),
      fuzzyMatches: matchFuzzy(picked, batchText),
    });
    // #解除限制：只放宽说话边界，露骨色情和违法的事照样不碰
    if (limitOffActive(cfg)) {
      cmdHints += '\n\n【边界临时放宽】主人放开了说话的尺度：骂人不忌口、亲近的描写可以放大，'
        + '但露骨色情和任何违法的事仍然不做。';
    }
  } catch (e) {
    note('debug', `[${session.key}] 指令表匹配失败：${e.message}`);
  }

  // 被@唤醒就临时上一个档，10 分钟后自己掉回来（session 上记时间戳，不落盘）
  const atMeHere = batch.some((x) => x.atMe || x.mentioned);
  const chanceBoost = session.kind === 'group' ? wakeBoostState(session, atMeHere) : false;
  const prompt = buildPrompt({
    cfg,
    chat: { kind: session.kind, title: session.title, key: session.key, chanceBoost },
    sender: { name: last.name, uid: last.uid },
    newLines,
    speakers: speakerTable,
    history: transcript,
    trusted,
    state: { ...stInfo, anger, callName: callName(person), favor: favorInfo, emotion: emoInfo, expression: expressionInfo },
    anger,
    favor: favorInfo,
    notebook: notebookText,
    identity: identityText,
    soothe: sootheHint(person),
    diary: diaryText ? { key: '最近三天', text: diaryText } : null,
    summary: readSummary(cfg, session.key),
    habits: session.habits || '',
    memory: session.memoryText || '',
    balance: state.balance,
    balanceFact: balanceText,
    backtrack: backText,
    brief: briefText,
    ambient: renderAmbient(await getAmbient(cfg.agentCwd).catch(() => null)),
    extra: [
      cmdHints,
      corpusHint,
      stickerHint(session.key, batch.map((m) => m.text || '').join(' '), { allowed: isOwner || trusted || (favorOf(session, Number(last.uid), last.name).qualified >= STICKER_FAVOR()) }),
      voiceHint(session, {
        anger,
        text: batch.map((m) => m.text).join('\n'),
        isOwner,
        voiceAllowed: isOwner || trusted || (favorOf(session, Number(last.uid), last.name).qualified >= VOICE_FAVOR()),
      }),
      ownerRule,
      toolRule,
      capabilityHint(session, { isOwner, trusted, role: botRole, favor: favorOf(session, Number(last.uid), last.name).favor }),
      favorCapabilityHint({ isOwner, trusted, favor: favorOf(session, Number(last.uid), last.name).favor, qualified: favorOf(session, Number(last.uid), last.name).qualified }),
      session.kind === 'group' && (isOwner || (botRole && botRole !== 'member')) ? recentIdsHint(batch) : '',
      '【答应过的事】别人让你在某个时间点做点什么（提醒我、叫我、到时候告诉我）——必须单独输出一行 __REMIND__ {"at":"+10m","text":"要办的事"}，桥会替你记着、到点真的发出去。at 优先用相对时长（+5m / +30m / +2h / +1d）或自然说法（「明天8点」「今晚10点半」），别自己拼日期，年份日期拼错就会被当成过期直接丢掉。只嘴上答应、不写这一行，就等于没记。',
      renderReminders(cfg, session.key),
      bareAtHint
        ? '（他刚才只是 @ 了你一下、没打字——意思是让你看他前面说的那些，不是让你回一个「@」。'
          + '直接接着上下文说；要是那些话跟你没关系、也插不上嘴，就 <SKIP>，别点破这个 @。）'
        : '',
      forced ? '（刚才那条是 @你 或者喊了你的名字——这一轮必须回，哪怕只一句。别装死。）' : '',
      // 戳一戳（2026-10-28）：这一轮是被戳进来的，用不用戳回去她自己定
      session.pokeHint || '',
      // 2026-10-28：窗口里／掷骰进来的消息给她一句提示，让她知道自己是被允许插话、不是被打扰
      forced || session.kind !== 'group' ? '' : (session.pickReason === 'wake'
        ? '（这几条不是冲你来的，但你刚被叫过——接着刚才的话头往下聊就行，有话说就接一句，没话就 <SKIP>。）'
        : '（这几条不是冲你来的，是按概率挑中你的——真的对味就插一句，凑不上就 <SKIP>。）'),
    ].filter(Boolean).join('\n\n'),
  });
  // 戳一戳的提示只对这一轮有效，用完就清，免得每轮都以为被戳了
  if (session.pokeHint) session.pokeHint = '';

  // 成本打点（2026-10-27 用户要求「测量一下」）：把 prompt 按空行切成段，量出最肥的几块。
  // 一行日志，不刷屏；想关就在 config 的 context 里加 "budgetLog": false。
  if (cfg.raw.context?.budgetLog !== false) {
    const segs = prompt
      .split('\n\n')
      .map((s) => ({ k: s.split('\n')[0].slice(0, 12), n: s.length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    note('info', `[预算] prompt ${prompt.length} 字｜${segs.map((s) => `${s.k}·${s.n}`).join('｜')}`);
  }

  // 4. 调用模型
  const prepMs = Date.now() - startedAt;
  // 2026-10-28：跑模型这段时间亮「正在输入」，跑完收掉。私聊报对方、
  // 群里报自己 + 群号；一律 fire-and-forget，绝不因为它多等一个来回。
  const typingTarget = cfg.raw.reply?.typing === false
    ? null
    : (session.kind === 'group'
      ? { userId: state.self?.user_id || 0, groupId: session.id }
      : { userId: Number(session.id) || 0 });
  const typing = (eventType) => {
    if (!typingTarget?.userId) return;
    void ob.setInputStatus({ ...typingTarget, eventType }).catch(() => {});
  };
  await sem.acquire();
  let result;
  try {
    typing(1);
    // 2026-10-27 用户要求「聊天时不再禁用任何插件和工具」：工具全开，能不能动手
    // 改东西按信任级别给——可信的写 workspace，其他人只读。
    result = await runner.run({
      prompt,
      toolMode,
      ...(commandPermOverride
        ? { permissionMode: commandPermOverride }
        : { permissionMode: trusted ? 'workspace-write' : 'read-only' }),
    });
  } finally {
    typing(2);
    sem.release();
  }

  // 被点名却选择沉默：不让这个决定生效，再问一次，问不出来就用一句短的顶上
  if (forced && result.ok) {
    const t = String(result.text || '').trim();
    const token = cfg.raw.reply.silenceToken;
    if (!t || t === token || t.startsWith(token)) {
      note('warn', `[${session.key}] 被点名却想沉默，重试一次`);
      const retry = await runner.run({ prompt, toolMode }).catch(() => null);
      const t2 = String(retry?.text || '').trim();
      if (t2 && t2 !== token && !t2.startsWith(token)) {
        result = retry;
      } else {
        // 重试也不行：先用一句短的顶上，别让被点名的人干等着
        result = { ok: true, text: '？', usage: retry?.usage || result.usage };
      }
    }
  }

  // ── 二段式：先正常答，答不上来再「我去查查」→ 联网 → 给准确答案 ──
  const needWeb = result.ok ? extractNeedWeb(result.text || '') : null;
  if (needWeb) {
    const standby = needWeb.say || '你在此地勿要走动，我去查查便回来。';
    note('info', `[${session.key}] 需要联网：${needWeb.query}`);

    // 1) 先稳住对方
    await sendText(session, standby, last.messageId ?? null).catch(() => {});
    state.stats.replied++;
    session.lastReplyAt = Date.now();
    session.replyTimes.push(Date.now());
    globalReplyTimes.push(Date.now());
    history.append(session.key, {
      t: Date.now(), role: 'bot', name: charName('我'), text: standby,
    });
    await sleep(600);

    // 2) 带联网工具查一次，拿到准确答案
    const webPrompt = [
      '你要回答对方刚才的问题。',
      '**先用 web 搜索/抓网页把事实查清楚，再回答**，不要凭印象。',
      '查到就用你自己的口吻说清楚，一两句到三五句，口语，不要 Markdown。',
      '查不到就老实说「唔……查不到」，别编。',
      '',
      `对方问的是：${needWeb.query}`,
      '',
      `原话：${batch.map((m) => `${m.name}：${m.text}`).join('\n')}`,
    ].join('\n');
    await sem.acquire();
    let web;
    try {
      web = await runner.run({ prompt: webPrompt, toolMode: 'web' });
    } finally {
      sem.release();
    }
    const answer = (web?.ok && String(web.text || '').trim())
      ? String(web.text).trim()
      : '唔……查不到，这个真不清楚。';
    const parts2 = splitMessages(answer, { maxMessages: 2, splitShortLines: false })
      .map(cleanReply).filter(Boolean);
    for (let i = 0; i < parts2.length; i++) {
      await sendText(session, parts2[i], i === 0 ? last.messageId : null);
      if (i < parts2.length - 1) await sleep(700);
    }
    history.append(session.key, {
      t: Date.now(), role: 'bot', name: charName('我'), text: parts2.join('\n') || answer,
    });
    note('info', `[${session.key}] 联网答完（${web?.ms || 0}ms）`);
    audit(session, batch, `${standby} / ${parts2.join(' / ') || answer}`, 'replied_web',
      Date.now() - startedAt, web?.usage || null);
    return;
  }

  const elapsed = Date.now() - startedAt;

  // 记账：本轮实际烧了多少 token（新读 / 缓存命中 / 输出）
  if (result.usage) {
    state.stats.turns += 1;
    state.stats.tokensIn += result.usage.inputTokens || 0;
    state.stats.tokensCache += result.usage.cacheReadTokens || 0;
    state.stats.tokensOut += result.usage.outputTokens || 0;
  }

  if (!result.ok) {
    state.stats.failed++;
    note('warn', `[${session.key}] 生成失败 (${elapsed}ms)`);
    audit(session, batch, null, 'failed', elapsed, result.usage);
    return;
  }

  // 5. 是否选择沉默
  const token = cfg.raw.reply.silenceToken;
  const text = result.text.trim();
  if (text === token || text.startsWith(token) || text === '') {
    state.stats.skipped++;
    note('info', `[${session.key}] 选择不说话（${elapsed}ms）`);
    audit(session, batch, null, 'silent', elapsed, result.usage);
    return;
  }

  // 6. 切分 + 清洗 + 发送
  // 顺序很重要：必须先切分再清洗。cleanReply 会删空行，而空行正是分条信号。
  // 指令行（提醒/群管理/点歌）先摘掉：它们不发给对方，只让桥去做事。
  const dir = extractDirectives(normalizeDirectiveLines(text));
  if (dir.errors.length) note('warn', `[${session.key}] 指令行解析失败：${dir.errors.join('；')}`);
  let directive = { did: false, problems: [] };
  if (dir.count) {
    try {
      directive = await runDirectives(session, dir, { last, profiles, recent: batch });
    } catch (e) {
      note('warn', `[${session.key}] 执行指令失败：${e.message}`);
    }
  }
  const textAfter = dir.rest;

  const vc = extractVoiceDirective(textAfter);
  const afterVoice = vc ? vc.rest : textAfter;
  const md = parseMediaDirective(afterVoice.trim());
  const st = extractStickerDirective(afterVoice);
  // 自己的形象图（2026-10-28）：__SELFIE__ 独占一行，先摘出来
  const sf = extractSelfieDirective(st ? st.rest : afterVoice);
  // 她自己定唤醒（2026-10-28）：__WAKE__ off 120 / __WAKE__ on
  const wk = extractWakeDirective(sf.rest);
  applyWake(session, wk);
  // 记忆与黑话（2026-10-28）：__MEMORY__ append/query/remove/clear、__SLANG__ query/submit
  const ml = extractToolDirective(wk.rest, 'MEMORY', MEM_OPS);
  const sll = extractToolDirective(ml.rest, 'SLANG', SLANG_OPS);
  applyToolDirectives(session, ml, sll);
  const baseAfterWake = sll.rest;
  // 戳一戳（2026-10-28）：__POKE__ 独占一行，先摘出来，行本身不发成文字
  const pk = extractPokeDirective(
    baseAfterWake,
    [...batch, ...(session.recentContext || [])].map((m) => ({ uid: m.uid, name: m.name })),
  );
  // 发文件（2026-10-28）：__SEND_FILE__ <路径> 也独占一行。
  // 只放行工作区和数据目录底下的文件——模型不该有能力把 /etc/passwd 甩给对面。
  const mdFile = extractFileDirective(pk ? pk.rest : baseAfterWake, {
    roots: [cfg.agentCwd, cfg.dataDir, cfg.raw.voice?.dir || '/root/snowluma/data/voice'],
  });
  // 表情收录/改说明/收意见（2026-10-28）：__COLLECT_STICKER__ #3 / __STICKER_REMARK__ S3 说明 / __FEEDBACK__ 内容
  const cs = parseCollectDirective(mdFile.rest);
  const sr = parseRemarkDirective(cs.rest);
  const fb = parseFeedbackDirective(sr.rest);
  await applyStickerFeedback(session, cs.list, sr.list, fb.list);
  const bodyRaw = fb.rest;
  // 2026-10-27 用户定：以【溟月】身份说的对话内容走短文本规则；引用资料、检索到的长文本、
  // 对方点名要模仿的长文句式这类「不是她临场说的话」，在正文最前面单独一行写 __LONG__，
  // 桥就不再按 16 字/40~90 字去断它，整条当作长文发出去。
  // 标记必须落在第一行、而且后面要有正文，光写一个标记不算。
  const firstLine = (bodyRaw.split('\n')[0] || '').trim();
  const bodyText = bodyRaw.replace(/^\s*__LONG__[ \t]*\r?\n?/, '');
  const longForm = firstLine.startsWith('__LONG__') && bodyText.trim().length > 0;
  const splitParts = longForm
    ? [bodyText.trim()].filter(Boolean)
    : splitMessages(bodyText, { maxMessages: 3, splitShortLines: cfg.raw.reply.splitShortLines !== false })
      .map(cleanReply)
      .filter(Boolean);
  // 一条长回复在逗号处断成两条：persona 承诺过「超过 40 字桥替你断开」，这里真兑现（2026-10-26）。
  // 阈值可用 config.reply.autoSplitLongChars 调，给 0 就关掉。
  let parts = longForm ? splitParts : autoSplitLong(splitParts, { limit: cfg.raw.reply.autoSplitLongChars ?? 40 });
  // 静默标记本身永远不该进对话（2026-10-28 用户指出私聊里漏出过字面 <SKIP>）。
  // 前面只在「整段以标记开头」时才判沉默，她把标记包成反引号、全角括号或者夹在别的句子里就漏了。
  // 这里逐片再筛一遍：剥掉包裹符号后只剩 SKIP 的整片丢掉；全丢光就当这轮沉默。
  const stripSilence = (s) =>
    String(s || '')
      .replace(/[`'"“”‘’「」『』()（）[\]【】<>＜＞]*\s*SKIP\s*[`'"“”‘’「」『』()（）[\]【】<>＜＞]*/gi, '')
      .trim();
  parts = parts.map(stripSilence).filter(Boolean);
  if (!parts.length) {
    state.stats.skipped++;
    note('info', `[${session.key}] 只有静默标记，没有可发的内容（${elapsed}ms）`);
    audit(session, batch, null, 'silent', elapsed, result.usage);
    return;
  }
  const clean = parts.join('\n');

  try {
    if (md) {
      const mdNeed = MEDIA_FAVOR();
      if (!isOwner && !trusted) {
        const mdFavor = favorOf(session, Number(last.uid), last.name).qualified;
        if (mdFavor < mdNeed) {
          await sendText(session, `转发素材得等好感 ${mdNeed} 以上，你还差 ${mdNeed - mdFavor} 分`, null);
          note('info', `[${session.key}] 转发素材被好感门槛拦下：${mdFavor} < ${mdNeed}`);
          return;
        }
      }
      await sendMediaDirective(session, md);
      state.stats.replied++;
      session.lastReplyAt = Date.now();
      session.replyTimes.push(Date.now());
      globalReplyTimes.push(Date.now());
      history.append(session.key, {
        t: Date.now(), role: 'bot', name: charName('我'),
        text: `[转发媒体 ${md.chat}#${md.index} -> ${md.to}]`,
      });
      audit(session, batch, `[转发媒体 ${md.chat}#${md.index} -> ${md.to}]`, 'replied', elapsed, result.usage);
      return;
    }

    if (!parts.length && !st && !vc && !pk && !mdFile.paths.length && !sf.hit) {
      if (!directive.did) { state.stats.skipped++; return; }
      // 只做了事、没说话（比如默默设了提醒）：算一次回复，冷却和限流也该生效
      state.stats.replied++;
      session.lastReplyAt = Date.now();
      session.replyTimes.push(Date.now());
      globalReplyTimes.push(Date.now());
      if (directive.problems.length) {
        await sendText(session, `唔……${directive.problems[0]}，你再说一遍？`, last.messageId ?? null).catch(() => {});
      }
      note('info', `[${session.key}] 只执行了指令（${dir.count} 条，${elapsed}ms）`);
      audit(session, batch, `[指令 ${dir.count} 条]${directive.problems.length ? ` 失败：${directive.problems.join('；')}` : ''}`, 'replied', elapsed, result.usage);
      return;
    }

    state.stats.replied++;
    session.lastReplyAt = Date.now();
    session.replyTimes.push(Date.now());
    globalReplyTimes.push(Date.now());

    await flushToolReplies(session);

    // 她要在说话之前先露个脸（__SELFIE__）
    if (sf.hit) {
      try { await sendSelfImage(session); } catch (e) { note('warn', `[${session.key}] 发形象图失败：${e.message}`); }
      await sleep(400);
    }

    for (let i = 0; i < parts.length; i++) {
      await sendText(session, parts[i], i === 0 ? last.messageId : null, { quote: dir.quote, longForm });
      if (i < parts.length - 1) await sleep(700);
    }
    if (parts.length) {
      history.append(session.key, {
        t: Date.now(), role: 'bot', name: charName('我'), text: clean,
      });
      // 表现层回写：话痨值增减、风格指纹、lastSpeakAt（docs/emotion-v2.md §15.13）
      if (expressionInfo) {
        try {
          recordSpeech({
            cfg,
            now: new Date(),
            text: clean,
            emotion: emoInfo?.name,
            lenSoft: expressionInfo?.lenSoft,
          });
        } catch (e) { note('warn', `[${session.key}] 表现层回写失败：${e.message}`); }
      }
    }
    if (st) {
      // 连发：refs 里可能有多张，一张失败不影响后面的
      for (let i = 0; i < st.refs.length; i++) {
        try {
          if (!isOwner && !trusted) {
            const stFavor = favorOf(session, Number(last.uid), last.name).qualified;
            if (stFavor < STICKER_FAVOR()) {
              note('info', `[${session.key}] 发表情被好感门槛拦下：${stFavor} < ${STICKER_FAVOR()}`);
              continue;
            }
          }
          await sendStickerToCurrent(session, st.refs[i]);
        } catch (e) {
          note('warn', `[${session.key}] 发表情 ${st.refs[i]} 失败：${e.message}`);
        }
        if (i < st.refs.length - 1) await sleep(650);
      }
    }
    void tagPendingMemes(session.key).catch(() => {});
    // 发文件（2026-10-28）：__SEND_FILE__ 一条一行，按行发。发失败只记日志、不打断后面的。
    if (mdFile.paths.length) {
      for (const fp of mdFile.paths) {
        try {
          const sent = await sendFileToChat({
            ob, cfg, chat: session.key, filePath: fp, name: path.basename(fp),
          });
          note('info', `[${session.key}] 发文件 ${sent.name}（${humanSize(sent.bytes)}）`);
        } catch (e) {
          note('warn', `[${session.key}] 发文件失败 ${fp}：${e.message}`);
          await sendText(session, `那个文件发不出去：${String(e.message).slice(0, 60)}`, null).catch(() => {});
        }
      }
    }
    // 戳一戳（2026-10-28）：模型想戳就戳，同会话一分钟最多一次
    if (pk) {
      try {
        const targetUid = Number(pk.target) || Number(last.uid);
        const gate = canPokeOut(cfg.dataDir, { chatKey: session.key, cfg });
        if (gate.ok) {
          await sendPokeTo(session, targetUid);
          markPokedOut(cfg.dataDir, { chatKey: session.key });
          note('info', `[${session.key}] 戳了 ${targetUid}`);
        } else {
          note('debug', `[${session.key}] 戳得太勤，这轮先不戳（还剩 ${Math.ceil(gate.leftMs / 1000)}s）`);
        }
      } catch (e) {
        note('warn', `[${session.key}] 戳一戳失败：${e.message}`);
      }
    }
    if (vc) {
      // 一轮可以发多条（模型写了几行 __SEND_VOICE__ 就发几条，最多 5 条）
      const voiceList = vc.texts && vc.texts.length ? vc.texts : [vc.text];
      for (let i = 0; i < voiceList.length; i++) {
        try {
          await sendVoiceToCurrent(session, voiceList[i], {
            mood: emoName, scene: vc.scene, emotion: vc.emotion, intensity: vc.intensity,
          });
        } catch (e) { note('warn', `[${session.key}] 语音发送失败：${e.message}`); break; }
        if (i < voiceList.length - 1) await sleep(800);
      }
    } else if (wantsVoice) {
      // 主人点名要语音、模型却没写指令：拿它正文的第一句兜底，别让他白等
      const line = String(parts[0] || '')
        .replace(/[。！？!?～~].*$/s, '')
        .replace(/\s+/g, '')
        .slice(0, 20);
      if (line) {
        try {
          await sendVoiceToCurrent(session, line, { mood: emoName });
          note('info', `[${session.key}] 主人要语音但没写指令，用正文兜底：${line}`);
        } catch (e) { note('warn', `[${session.key}] 兜底语音失败：${e.message}`); }
      }
    }

    const modelMs = Number(result?.elapsed) || 0;
    const doneMs = Date.now() - startedAt;
    note('info', `[${session.key}] ${parts.length} 条 / ${clean.length} 字${st ? ` + 表情 ${st.ref}` : ''}${vc ? ' + 语音' : ''}${mdFile.paths.length ? ` + 文件 ${mdFile.paths.length}` : ''}${dir.count ? ` + 指令 ${dir.count}` : ''}（${doneMs}ms = 准备 ${prepMs} + 模型 ${modelMs} + 发送 ${Math.max(0, doneMs - prepMs - modelMs)}）`);
    audit(session, batch, `${parts.join(' / ')}${st ? ` + [表情 ${st.ref}]` : ''}${vc ? ` + [语音] ${vc.text.slice(0, 40)}` : ''}${dir.count ? ` + [指令 ${dir.count}]` : ''}`, 'replied', elapsed, result.usage);
  } catch (e) {
    state.stats.failed++;
    note('error', `[${session.key}] 发送失败: ${e.message}`);
    audit(session, batch, clean, 'send_failed', elapsed, result.usage);
  }
}

/**
 * 角色把自己名字当称呼用（「XX 你觉得呢」）——这是最出戏的一种错。
 * 名字只能指自己，拿来叫别人一律去掉。
 *
 * 判据：**出现在句首（或换行、句末标点之后）**，且后面紧跟「对着对方说话」的痕迹
 * （你/您，或 叫/问/说/看/听/觉得/帮 这类动作）。这样
 *   - 「XX你觉得呢」→「你觉得呢」✓
 *   - 「XX。你觉得呢」→「你觉得呢」✓
 *   - 「我叫XX」/「谁是XX啊」/「叫全名XX」 不动 ✓
 *   - 「XX（游戏ID）\n……加了别天天拉我排位」不动 ✓（后面不是对谁说话）
 */
function fixSelfNameAsVocative(text) {
  // 名字从身份槽位取；没填就跳过这一步
  const nm = char().name;
  if (!nm || !text.includes(nm)) return text;
  const LEAD = '(?:^|[\\n。！!？?])\\s*';
  const PUNCT = '[，,、：: 。！!？?]*';
  const ADDRESS = '(?=你|您|这|那|叫|问|说|看|听|觉得|帮)';
  return text
    // 句首的名字挨着称呼/动作 → 整段去掉
    .replace(new RegExp(`${LEAD}${escapeRe(nm)}\\s*${PUNCT}${ADDRESS}`, 'g'), (m) => {
      const lead = m.match(/^[\n。！!？?]?/)[0];
      return lead;
    });
}

/**
 * 不许说「看不见/看不到/没法看/收不到」这类机器报障的话。
 * 抓到就换成打哈哈的短句，别让她开口就露馅。
 */
function softenBlindTalk(text, person) {
  const sr = selfRef();
  const self = sr ? `(?:我|${escapeRe(sr)})` : '(?:我)';
  const src = `${self}?\\s*(?:看|听)不(?:到|见|清)`
    + '|(?:没法|无法)(?:看|查看|打开|播放)'
    + `${self}?(?:这|这边)?收不到`
    + '|图片?(?:加载|显示)不出来'
    + `${self}(?:没有|没)收到(?:图|图片|语音|视频)`;
  const bad = new RegExp(src);
  if (!bad.test(text)) return text;
  const wit = ['唔？', '啥', '你直接说嘛', '图糊了吧', '眼睛花了一下'];
  const pick = wit[Math.floor(Math.random() * wit.length)];
  // 整句就是报障 → 换成打哈哈；只是局部 → 把这句摘掉
  const lines = text.split(/\n/);
  const kept = lines
    .map((l) => (bad.test(l) ? '' : l))
    .filter((l) => l.trim() !== '');
  return kept.length ? kept.join('\n') : pick;
}

function cleanReply(text, person) {
  let t = text.trim();
  // 去掉模型可能加的「角色名：」前缀
  const nmRe = allNames().map(escapeRe).filter(Boolean).join('|');
  if (nmRe) t = t.replace(new RegExp('^(?:' + nmRe + ')\\s*[：:]\\s*'), '');
  // 去掉整体包裹的引号
  const pairs = [['"', '"'], ['“', '”'], ['「', '」'], ["'", "'"]];
  for (const [a, b] of pairs) {
    if (t.length > 2 && t.startsWith(a) && t.endsWith(b)) {
      t = t.slice(1, -1).trim();
      break;
    }
  }
  // 名字被当成称呼别人 → 去掉
  t = fixSelfNameAsVocative(t);
  // 「我看不到/收不到」这类机器报障 → 换成打哈哈
  t = softenBlindTalk(t, person);
  // 去掉空行（模型爱在「……」后面塞全角空格占位），并压掉行尾空白
  t = t.split(/\r?\n/)
    .map((l) => l.replace(/[\s\u3000]+$/g, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
  return t.trim();
}

function audit(session, batch, reply, action, elapsed, usage = null) {
  const file = path.join(cfg.logDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendJsonl(file, {
    t: new Date().toISOString(),
    chat: session.key,
    title: session.title,
    action,
    elapsedMs: elapsed,
    incoming: batch.map((m) => ({ uid: m.uid, name: m.name, text: m.text, id: m.messageId })),
    reply,
    // 这一轮烧了多少 token：缓存命中 / 新读 / 输出
    usage: usage
      ? {
        in: usage.inputTokens ?? 0,
        cache: usage.cacheReadTokens ?? 0,
        out: usage.outputTokens ?? 0,
        total: usage.totalTokens ?? 0,
      }
      : null,
  });
}

/* ---------- 入队（带防抖） ---------- */
/* ---------- 群级静音（主人一句「/闭嘴」） ---------- */
// 只认带前缀的写法：「/闭嘴」「#闭嘴」「／张嘴」。裸说「闭嘴」不算——
// 主人骂别人闭嘴的时候不该把她一起关掉。
const MUTE_ON = /^[/#／]\s*(闭嘴|别说了|安静|安静点|闭嘴吧|别吵了?)\s*[!！。.~～]*$/;
const MUTE_OFF = /^[/#／]\s*(张嘴|开口|说话|继续说|解除静音|回来吧?)\s*[!！。.~～]*$/;

function isMuted(session) {
  if (cfg.raw.reply?.mute?.enabled === false) return false;
  return Number(session.mutedUntil || 0) > Date.now();
}

/**
 * 处理「/闭嘴」「/张嘴」。返回 true 表示这条消息已经被这条指令消费掉了。
 * 权限：号主本人或 trusted；别人说的只记日志、不生效。
 */
function handleMuteCommand(session, text, uid) {
  const muteCfg = cfg.raw.reply?.mute ?? {};
  if (muteCfg.enabled === false) return false;
  const raw = String(text || '').trim();
  const on = MUTE_ON.test(raw);
  const off = MUTE_OFF.test(raw);
  if (!on && !off) return false;

  const ownerOk = (cfg.raw.persona?.ownerUids ?? []).includes(Number(uid)) || cfg.trusted.has(Number(uid));
  if (!ownerOk) {
    state.stats.ignored++;
    note('info', `[${session.key}] 非主人说「${raw}」，不生效`);
    return true;
  }

  if (on) {
    const ms = Number(muteCfg.ms) || 120000;
    session.mutedUntil = Date.now() + ms;
    clearTimeout(session.timer);
    session.timer = null;
    session.buffer = [];       // 静音前攒的那些也倒掉，免得解禁时一口气全倒出来
    note('info', `[${session.key}] 主人让闭嘴，静音 ${Math.round(ms / 1000)} 秒`);
    void sendText(session, '好，那我先不吭声了');
  } else {
    session.mutedUntil = 0;
    note('info', `[${session.key}] 主人让张嘴，解除静音`);
    void sendText(session, '嗯，回来了');
  }
  return true;
}

/**
 * 收到一次戳（2026-10-28 用户 m03600「按你的方案执行」）。
 * 只有戳到自己才算；按关系档位掷骰决定理不理，理就把这一戳当成一句话塞进会话，
 * 让她自己决定是戳回去还是说句什么。私聊一般不装死，群里档位低的就当没看见。
 */
async function handlePokeNotice(ev) {
  if (!pokeConfig(cfg).enabled) return;
  if (ev.notice_type !== 'notify' || ev.sub_type !== 'poke') return;
  const selfId = Number(ev.self_id ?? state.self?.user_id ?? 0);
  if (Number(ev.target_id) !== selfId) return;         // 戳的不是我，不管
  const uid = Number(ev.user_id);
  if (!uid || uid === selfId) return;

  const gid = ev.group_id ? Number(ev.group_id) : 0;
  const isPrivate = !gid;
  if (isPrivate && !cfg.privateAllow.has(uid)) return;
  if (!isPrivate && !cfg.groupAllow.get(gid)) { state.stats.ignored++; return; }

  const key = isPrivate ? `private:${uid}` : `group:${gid}`;
  const session = getSession(key, isPrivate ? 'private' : 'group', isPrivate ? uid : gid,
    isPrivate ? `私聊 ${uid}` : `群 ${gid}`);
  if (isMuted(session)) return;
  if (bridgeMuted(cfg).paused || bridgeMuted(cfg).takeover) return;

  const name = isPrivate ? (session.title || String(uid)).replace(/^私聊\s*/, '') : String(uid);
  const info = favorOf(session, uid, name);
  const isOwnerHere = (cfg.raw.persona?.ownerUids ?? []).includes(uid) || cfg.trusted.has(uid);
  const stage = levelOf(info.qualified, isOwnerHere);

  const verdict = onPoked(cfg.dataDir, { chatKey: key, uid, stage, cfg });
  if (!verdict.react) {
    state.stats.ignored++;
    note('info', `[${key}] 被 ${name} 戳了一下，不理（${verdict.reason}）`);
    return;
  }

  markPokeReplied(cfg.dataDir, { chatKey: key, uid });
  session.pokeHint = renderPokeHint({ name, count: verdict.count, stage });
  session.forceReplyUntil = Date.now() + 30_000;   // 这可是人家主动戳的，别被冷却吞掉
  session.lastActivityAt = Date.now();
  state.stats.received++;
  note('info', `[${key}] ${name} 戳了你一下（第 ${stage} 档，今天第 ${verdict.count} 次）`);
  enqueue(session, {
    uid, name, text: '[戳了你一下]', time: Date.now(), messageId: null,
  });
}

function enqueue(session, msg) {
  // 认人：每收到一条就记下「这个 QQ 号这次叫什么」（跨群攒别名，见 src/identity.mjs）
  try { recordIdentity(cfg.agentCwd, msg.uid, msg.name, { chat: session.key }); } catch { /* 记不上不影响聊天 */ }
  // 群级静音（主人说过「/闭嘴」）：这段时间什么都不回，连缓冲都不攒，
  // 免得解禁之后把静音期间的一堆话一次性倒出来。
  if (isMuted(session)) {
    state.stats.ignored++;
    const left = Math.ceil((Number(session.mutedUntil) - Date.now()) / 1000);
    note('debug', `[${session.key}] 静音中（剩 ${left}s），不回：${String(msg.text || '').slice(0, 20)}`);
    return;
  }
  session.buffer.push(msg);
  const delay = cfg.raw.reply.debounceMs[session.kind] ?? 0;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => void runTurn(session), Math.max(0, delay));
}

async function runTurn(session) {
  if (session.busy) return;
  session.busy = true;
  try {
    while (session.buffer.length) {
      const batch = session.buffer.splice(0, session.buffer.length);
      // 2026-10-28 用户要求接 SnowLuma 的拟人能力：进处理前先标已读，对面那个红点就消了。
      // 只认数字 id（自己发出去的是 self-xxx），失败一律不管，不能因为标已读把回复卡住。
      if (cfg.raw.reply?.readReceipt !== false) {
        for (const m of batch) {
          const mid = Number(m?.messageId);
          if (Number.isFinite(mid) && mid > 0) void ob.markMsgAsRead(mid).catch(() => {});
        }
      }
      try {
        await handleBatch(session, batch);
      } catch (e) {
        state.stats.failed++;
        note('error', `[${session.key}] 处理异常: ${e.message}`);
      }
    }
  } finally {
    session.busy = false;
  }
}

/* ---------- 事件入口 ---------- */
ob.on('ready', async () => {
  try {
    const info = await ob.getLoginInfo();
    state.self = { user_id: info.user_id, nickname: info.nickname };
    note('info', `已登录账号：${info.nickname} (${info.user_id})`);
  } catch (e) {
    note('warn', `获取登录信息失败: ${e.message}`);
  }
});

/** 群聊关键词命中（2026-10-24 起不再用于触发，保留备用） */
function matchGroupKeyword(cfg, text) {
  const words = cfg.raw.eye?.keywords ?? [];
  if (!words.length) return false;
  const s = String(text || '');
  return words.some((w) => w && s.includes(w));
}

/**
 * 群聊里「是不是在叫本鲸」（2026-10-27 用户定）。
 * 群里还有别的鲸鱼娘，所以通用外号（鲸鱼娘/小鲸鱼/DeepSeek酱/大肥鱼…）不算在叫她——
 * 只认人设真名和 character.groupCallNames 里列的专属称呼，默认就认真名一个。
 */
function personaAliasHit(cfg, text) {
  const c = char();
  const names = Array.isArray(c.groupCallNames) && c.groupCallNames.length
    ? c.groupCallNames
    : [c.name];
  return nameHit(names, text);
}

ob.on('event', (ev) => {
  if (ev.post_type === 'meta_event') return;
  // 戳一戳（2026-10-28）：NapCat 走 notice / notify / sub_type=poke，
  // target_id 是被戳的人。只有戳到自己才处理，戳别人的不管。
  if (ev.post_type === 'notice') {
    void handlePokeNotice(ev).catch((e) => note('warn', `戳一戳事件处理失败：${e.message}`));
    return;
  }
  if (ev.post_type !== 'message') return;
  if (ev.user_id && ev.self_id && Number(ev.user_id) === Number(ev.self_id)) return;

  const rawId = ev.message_id;
  if (rawId !== undefined && !rememberId(rawId)) return;

  if (state.paused) { state.stats.ignored++; return; }
  if (!cfg.raw.gate.enabled) { state.stats.ignored++; return; }

  const selfId = Number(ev.self_id ?? state.self?.user_id ?? 0);
  const { text, ats, images, records, files, replyId } = renderSegments(ev.message, {
    selfId,
    ownerUids: cfg.raw.persona?.ownerUids ?? [],
  });
  if (!text && ats.length === 0) return;
  const media = extractMedia(ev.message);
  // 黄脸也收录：群里谁发了哪个小黄脸都记一笔，攒出「这个群习惯用哪几个」
  try { recordFaces(cfg.dataDir, ev.message, FACE_NAMES); } catch { /* 统计失败不影响聊天 */ }

  const uid = Number(ev.user_id);

  if (ev.message_type === 'private') {
    if (!cfg.privateAllow.has(uid)) { state.stats.ignored++; return; }
    const key = `private:${uid}`;
    const session = getSession(key, 'private', uid, `私聊 ${senderName(ev)}`);
    if (handleMuteCommand(session, text, uid)) return;
    if (isMuted(session)) {
      state.stats.ignored++;
      note('debug', `[${key}] 静音中，不回：${String(text).slice(0, 20)}`);
      return;
    }
    session.lastActivityAt = Date.now();
    selfwake?.noteHumanActivity(key);
    state.stats.received++;
    void saveMedia(key, uid, senderName(ev), media).catch(() => {});
    void (async () => {
      const resolved = await resolveIncoming(text, images, records, cfg.trusted.has(uid), {
        chatKey: session.key, uid, name: senderName(ev), isGroup: session.kind === 'group',
        atMe: false, wantsSave: wantsSaveText(text),
        replyId,
      }, files);
      enqueue(session, {
        uid, name: senderName(ev), text: resolved, time: ev.time ? ev.time * 1000 : Date.now(), messageId: rawId,
      });
    })();
    return;
  }

  if (ev.message_type === 'group') {
    const gid = Number(ev.group_id);
    const mode = cfg.groupAllow.get(gid);
    if (!mode) { state.stats.ignored++; return; }

    // 静音指令要排在「有没有 @ 她」前面：主人说「/闭嘴」时并不会 @ 她。
    const muteKey = `group:${gid}`;
    const muteSession = getSession(muteKey, 'group', gid, ev.group_name ? `群 ${ev.group_name}` : `群 ${gid}`);
    if (handleMuteCommand(muteSession, text, uid)) return;

    // 判断这条是不是「在叫她」
    const selfIdStr = String(selfId);
    const mentioned = ats.includes(selfIdStr) || String(text).includes(selfIdStr);
    const personaNameHit = personaAliasHit(cfg, text);

    const key = muteKey;
    const session = muteSession;
    if (isMuted(session)) {
      state.stats.ignored++;
      const left = Math.ceil((Number(session.mutedUntil) - Date.now()) / 1000);
      note('debug', `[${key}] 静音中（剩 ${left}s），不回：${String(text).slice(0, 20)}`);
      return;
    }

    // —— 谁的话才进模型（2026-10-28 用户定，改掉了原来的硬门禁）——
    // 判定逻辑抽到 agent.mjs 的 pickGroupMessage()，这里只负责执行：
    //   ① 被 @ 或叫了「溟月」：进，而且这一轮必须回；
    //   ② 叫过之后 wakeWindowMinutes 分钟内（默认 5）：群里普通消息也照喂，让她接着聊；
    //   ③ 其余情况按 reply.groupChance 真掷骰，命中才进来。
    //   以前这个概率只写进 prompt 当摆设，桥侧在下面直接 return 了，所以「不@就不回」。
    const calledNow = mentioned || personaNameHit;
    const pick = pickGroupMessage({
      cfg, chatKey: key, mode, calledNow, wakeUntil: session.wakeUntil || 0,
    });
    session.wakeUntil = pick.wakeUntil;
    // accept=false 就是静默；reason 说明这一轮为什么进模型：called／wake／roll
    const pickReason = pick.reason === 'called' ? '' : pick.reason;

    // 「旁边几条」：不管这回回不回，别人的话都先攒着——等哪次被叫到，这些就是上下文。
    const keepRecent = () => {
      session.recentContext = session.recentContext || [];
      session.recentContext.push({
        uid, name: senderName(ev), text, time: ev.time ? ev.time * 1000 : Date.now(), messageId: rawId,
      });
      if (session.recentContext.length > 60) session.recentContext.shift();
    };

    if (!pick.accept) {
      state.stats.ignored++;
      keepRecent();
      note('debug', `[group:${gid}] 没被叫、掷骰没中（${pick.pct}%），静默：${String(text).slice(0, 20)}`);
      return;
    }
    if (pick.reason === 'wake') {
      note('debug', `[group:${gid}] 被叫过、还在 ${Math.ceil((session.wakeUntil - Date.now()) / 60_000)} 分钟窗口里，照喂`);
    } else if (pick.reason === 'roll') {
      note('info', `[group:${gid}] 没被叫、掷骰中了（${pick.pct}%），接着聊`);
    }
    session.pickReason = pickReason;

    if (!session.title || session.title === `群 ${gid}`) {
      if (ev.group_name) session.title = `群 ${ev.group_name}`;
    }
    // 首次用到这个会话时把已学到的习惯读进来
    if (session.habits === '') session.habits = readHabits(cfg.agentCwd, key);
    if (session.memoryText === '') session.memoryText = renderMemory(cfg.agentCwd, key);
    session.lastActivityAt = Date.now();
    selfwake?.noteHumanActivity(key);
    state.stats.received++;
    maybeLearnHabits(session);
    maybeLearnMemory(session);
    void saveMedia(key, uid, senderName(ev), media).catch(() => {});

    // —— 空的 @：他多半是想让你看上下文，不是要你回一个「@」——
    // 2026-10-23 用户定：只 @ 不说话 → 带上前面几条让他自己判断；
    // 前面也没什么可接的，就当没看见，别单独回一句「你艾特我干嘛」。
    const bareText = stripAtLabels(text);
    const bareAt = mentioned && bareText === '' && images.length === 0 && records.length === 0 && files.length === 0;
    if (bareAt) {
      const nowMs = Date.now();
      const ctx = (session.recentContext || []).filter((c) => nowMs - Number(c.time || 0) < 30 * 60_000);
      if (!ctx.length) {
        state.stats.ignored++;
        note('info', `[group:${gid}] 空的 @，前面也没有可接的话，忽略`);
        return;
      }
      if (!session.busy) {
        // 2026-10-26 修：只把「别人说的」带回来。自己的话已经在 history 里（role:'assistant'），
        // 再灌回新消息会让模型对着自己上一句往下说，表现就是反复同一种句式。
        const missing = ctx.filter((c) => !c.self && !session.buffer.some((b) => b.messageId === c.messageId));
        session.buffer.unshift(...missing);
        session.recentContext = [];
        session.bareAtAt = nowMs;
        note('info', `[${key}] 空的 @，带上 ${missing.length} 条上下文（不强制回）`);
        setTimeout(() => void runTurn(session), Math.max(0, cfg.raw.reply.debounceMs[session.kind] ?? 0));
      } else {
        note('debug', `[${key}] 空的 @，正在忙，忽略`);
      }
      return;
    }

    // —— 只 @ 了别人、什么也没说：跟它没关系，别当回事 ——
    // （以前 at 段不进正文，这种消息看起来是「空消息」，模型反而会回一句没头没脑的话）
    if (!mentioned && bareText === '' && images.length === 0 && records.length === 0 && files.length === 0) {
      state.stats.ignored++;
      note('debug', `[group:${gid}] 只是 @ 了别人、没有内容，忽略`);
      return;
    }

    // —— 有人 @她 / 喊她外号：这一轮必须回 ——
    // 除非她正对这个人冷淡（怒气 Lv2 及以上），冷淡时照常听着，但不强求开口。
    // 2026-10-28：窗口内的消息、掷骰中的消息也进模型，但只有被叫才强制回。
    const called = mentioned || personaNameHit;
    if (called) {
      const profiles = session.profiles ?? (session.profiles = loadProfiles(cfg.agentCwd, key));
      const caller = profiles.people[uid];
      const coldToCaller = Number(caller?.angerLv ?? 0) >= 2;
      const lv = Number(session.moodState?.angerLv ?? 0);
      // 分情况的冷淡：对「这个提问的人」冷，或对「全群」冷（Lv3 才影响别人）
      const cold = coldToCaller || lv >= 3;
      if (!cold) {
        session.forceReplyUntil = Date.now() + 30 * 1000;
        session.forceReplyBy = uid;
        note('info', `[${key}] 被叫（${mentioned ? '@' : '外号'}），本轮必须回`);
      } else {
        note('info', `[${key}] 被叫，但她正对这人冷淡，不强制回`);
      }
    }
    // 旁边几条：她刚才正在看的那些，一起带上，别让上下文断在半截
    if (!session.busy) {
      const ctx = session.recentContext || [];
      if (ctx.length) {
        // 2026-10-26 修：只把「别人说的」带回来。自己的话已经在 history 里（role:'assistant'），
        // 再灌回新消息会让模型对着自己上一句往下说，表现就是反复同一种句式。
        const missing = ctx.filter((c) => !c.self && !session.buffer.some((b) => b.messageId === c.messageId));
        if (missing.length) {
          session.buffer.unshift(...missing);
          note('debug', `[${key}] 带上旁边 ${missing.length} 条上下文`);
        }
      }
      session.recentContext = [];
    }

    void (async () => {
      const resolved = await resolveIncoming(text, images, records, cfg.trusted.has(uid), {
        chatKey: session.key, uid, name: senderName(ev), isGroup: session.kind === 'group',
        atMe: mentioned, wantsSave: wantsSaveText(text),
        replyId,
      }, files);
      // 「旁边几条」存的是渲染阶段的原文，图还没换成描述，带着 [[IMG:0]] 这种占位符。
      // 原样带回下一批，模型就只看得到一个空占位符——群里冒出「一片白框」就是这么来的。
      const rc = session.recentContext?.find((c) => c.messageId === rawId);
      if (rc) rc.text = resolved;
      enqueue(session, {
        uid, name: senderName(ev), text: resolved, time: ev.time ? ev.time * 1000 : Date.now(), messageId: rawId,
        // 2026-10-28 修：这条消息自己有没有点到我，得跟着消息一起进缓冲。
        // 以前没带，点唱判断读的是 m.atMe（永远 undefined），群里只能靠正文里出现「溟月」；
        // 主人 @ 我说的「清唱认真的雪」于是被判成闲聊，模型去点原唱/念歌词，一首歌都没唱。
        atMe: mentioned,
      });
    })();
  }
});

/* ---------- 控制面板 ---------- */
function statusPayload() {
  return {
    connected: ob.connected,
    paused: state.paused,
    self: state.self,
    busy: sessions.size ? [...sessions.values()].filter((s) => s.busy).length : 0,
    maxConcurrent: cfg.raw.agent.maxConcurrent,
    stats: state.stats,
    chats: [...sessions.values()].map((s) => ({ key: s.key, pending: s.buffer.length, busy: s.busy })),
    balance: {
      enabled: balanceConfig(cfg).enabled,
      cny: state.balance,
      at: state.balanceAt,
      threshold: balanceConfig(cfg).thresholdCny,
      pollMinutes: balanceConfig(cfg).pollMinutes,
      low: state.balance !== null && state.balance < balanceConfig(cfg).thresholdCny,
    },
    logs: state.logs,
    uptimeMs: Date.now() - state.startedAt,
  };
}

const selfwake = createSelfwake({
  cfg,
  sessions,
  history,
  runner,
  sendText,
  // 主动开口也能发语音：条件跟正常回复一致（非凌晨、非生气、隔 1 分钟）
  sendVoice: (session, text, opts) => sendVoiceToCurrent(session, text, opts),
  canVoice: (session) => voiceGate(session, {}).ok,
  note,
  paused: () => state.paused,
  // 她自己要安静（__WAKE__ off）时，谁都不许替她开口
  canWake: () => !wakeMuted(),
  audit: (session, batch, reply, action, elapsed, usage) => audit(session, batch, reply, action, elapsed, usage),
  // 开不开口由目的引擎决定：它排了一条「该说话」才开口，排不到就闭嘴
  advisor: async () => {
    if (cfg.purpose?.enabled === false) return null;
    const p = purposeTakePending();
    if (!p) return null;
    const owner = cfg.persona?.ownerUids?.[0] || cfg.balance?.notifyQQ;
    if (!owner) return null;
    return {
      sessionKey: `private:${owner}`,
      hint: `${p.actionCn ? `${p.actionCn}：` : ''}${p.text || ''}`,
      onSent: () => { try { purposeMarkSpoken(p.id); } catch { /* 记账失败不影响说话 */ } },
    };
  },
});
selfwake.start();

// 早安排程：每天固定时间自己打个招呼（2026-10-28，照 surfcore 的 greeting-schedule 搬的）
// 走 selfwake 的发送链路，所以语音/分条/表情那些规矩不用重写一遍。
const greeting = createGreeting({
  cfg,
  note,
  canWake: () => !wakeMuted(),
  speak: async (hint) => {
    const owner = cfg.persona?.ownerUids?.[0] || cfg.balance?.notifyQQ;
    if (!owner) return { skipped: 'no-owner' };
    const key = `private:${owner}`;
    getSession(key, 'private', owner, '主人');
    return selfwake.tick({ force: true, only: key, hint });
  },
});
greeting.start();

// 组件更新检查：SnowLuma 和 dsh 本体换代了不会有任何东西告诉我们，每天自己看一眼
const updateCheck = createUpdateCheck({
  cfg,
  note,
  notify: async (text) => {
    const s = pickNotifyTarget();
    if (!s) return;
    await sendText(s, text);
  },
});
updateCheck.start();

// 定时提醒：到点自己发，不依赖 dsh 进程活着
startReminderTicker({ cfg, note, send: fireReminder });

/** 从几条候选回话里随机挑一条（别每次都一模一样） */
function pickLine(lines) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
}

/** 解析「#翻唱 歌名 人声80 伴奏40 和声60 升调2」里的参数；增益是百分比（100=原样） */
function parseCoverParams(text) {
  let rest = String(text || '');
  const pick = (names) => {
    const re = new RegExp(`(?:${names.join('|')})\\s*[:：=]?\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?`, 'i');
    let val = null;
    for (let i = 0; i < 5; i += 1) {
      const m = rest.match(re);
      if (!m) break;
      if (val == null) val = Number(m[1]);
      rest = rest.replace(m[0], ' ');
    }
    return val;
  };
  const vocalGain = pick(['人声']);
  const instGain = pick(['伴奏']);
  const backingGain = pick(['和声', '副唱']);
  const up = pick(['升调', '升key', '升Key']);
  const down = pick(['降调', '降key']);
  const transpose = up != null ? up : (down != null ? -down : null);
  const indexRate = pick(['贴合度', '贴合', '相似度', 'index']);
  const startSec = pick(['从第', '从', '起点']);
  const durSec = pick(['时长', '长度']);

  // 音色：音色 真白花音 / 音色=真白花音
  let voice = null;
  const mv = rest.match(/音色\s*[:：=]?\s*([^\s，,、]{1,20})/);
  if (mv) {
    voice = mv[1].trim();
    rest = rest.replace(mv[0], ' ');
  }

  // 片段：高潮/副歌/一段 → 自动挑副歌；完整/整首/全曲 → 整首；默认副歌那段
  let segment = null;
  if (/完整|整首|全曲|整段|整首歌/.test(rest)) {
    segment = { full: true };
    rest = rest.replace(/完整|整首|全曲|整段|整首歌/g, ' ');
  } else if (/高潮|副歌|最炸|一段|一小段|副歌部分/.test(rest)) {
    segment = { chorus: true };
    rest = rest.replace(/高潮|副歌|最炸|一段|一小段|副歌部分|部分/g, ' ');
  } else if (startSec != null || durSec != null) {
    segment = { start: startSec, seconds: durSec };
  }

  // 重唱：明确要求重跑时，本机执行器就别复用翻唱库里的旧版本
  let redo = false;
  if (/重唱|重新唱|重录|再唱一遍|重新翻|重来一遍/.test(rest)) {
    redo = true;
    rest = rest.replace(/重唱|重新唱|重录|再唱一遍|重新翻|重来一遍/g, ' ');
  }

  const song = rest
    .replace(/[秒鐘钟]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[《「【（(]+/, '')
    .replace(/[》」】）)]+$/, '')
    .trim();
  return { song, vocalGain, instGain, backingGain, transpose, indexRate, voice, segment, redo };
}

// 翻唱回传：本机（有显卡那台）跑完把 mp3 放 data/cover/done，这里负责发给会话
try {
  ensureCoverDirs(cfg);
  startCoverWatcher({ cfg, ob, note });
} catch (e) {
  note('warn', `[翻唱] 监听没起来：${e.message}`);
}

// 本机干活回传（2026-10-28）：本机 tools/local-agent.py 拖着文件跑完 dsh，
// 把产物传回 data/local/done，这里负责发回原会话。跟翻唱同一套拉模式。
try {
  ensureLocalDirs(cfg);
  startLocalWatcher({ cfg, ob, note });
} catch (e) {
  note('warn', `[本机] 监听没起来：${e.message}`);
}

const control = startControl(cfg, {
  status: statusPayload,
  balance: async (force = true) => {
    await checkBalance({ force });
    const conf = balanceConfig(cfg);
    return {
      ok: true,
      cny: state.balance,
      at: state.balanceAt,
      threshold: conf.thresholdCny,
      low: state.balance !== null && state.balance < conf.thresholdCny,
      pollMinutes: conf.pollMinutes,
      cooldownHours: conf.cooldownHours,
    };
  },
  pause: () => {
    state.paused = true;
    note('warn', '已急停：不再自动回复（消息仍会记录）');
  },
  resume: () => {
    state.paused = false;
    note('info', '已恢复自动回复');
  },
  reload: () => {
    const old = cfg;
    cfg = loadConfig();
  initCharacter(cfg);
    history = new HistoryStore(cfg.dataDir, cfg.raw.context);
    runner = new AgentRunner(cfg);
    sem = new Semaphore(cfg.raw.agent.maxConcurrent);
    note('info', `配置已重载：私聊白名单 ${cfg.privateAllow.size} 人，群 ${cfg.groupAllow.size} 个，可信 ${cfg.trusted.size} 人`);
    if (JSON.stringify(old.raw.napcat) !== JSON.stringify(cfg.raw.napcat)) {
      note('warn', 'napcat 连接参数变了，需要重启进程才生效');
    }
  },
  history: (chat) => (chat ? history.load(chat).slice(-50) : []),
  memory: {
    list: () => listMemory(cfg),
    read: (rel) => readMemory(cfg, rel),
    write: (rel, text) => writeMemory(cfg, rel, text),
    search: (q) => searchMemory(cfg, q),
  },

  // 控制面板：提醒列表 / 说说 / 调试注入
  reminders: {
    list: () => {
      const chats = [
        ...[...cfg.privateAllow].map((u) => `private:${u}`),
        ...[...cfg.groupAllow.keys()].map((g) => `group:${g}`),
      ];
      const out = [];
      for (const chat of chats) {
        for (const it of listReminders(cfg, chat)) out.push({ chat, ...it, atText: fmtAt(it.at) });
      }
      return out.sort((a, b) => a.at - b.at);
    },
    cancel: (chat, id) => cancelReminder(cfg, chat, id),
  },
  qzone: {
    state: () => qzoneState(cfg),
    post: (opts = {}) => maybePostDaily({ cfg, runner, ob, note, ...opts }),
  },
  // 给 DSH 用的：# 命令里要用到桥内能力（发语音/发表情/发说说）时，
  // DSH 通过 POST /api/action 调这里，不用自己猜 NapCat 的接口。
  action: async (body = {}) => {
    const op = String(body.op || '');
    const ownerUid = (cfg.raw.persona?.ownerUids || [])[0];
    const chat = String(body.chat || `private:${ownerUid}`);
    const m = chat.match(/^(private|group):(\d+)$/);
    if (!m) return { error: 'chat 要写成 private:QQ号 或 group:群号' };
    const kind = m[1];
    const id = Number(m[2]);
    const session = getSession(chat, kind, id, kind === 'group' ? `群 ${id}` : `私聊 ${id}`);
    // 好感门槛（2026-10-25 用户定）：用「她」的嘴发语音/表情/说说，要发起人好感够，
    // 否则一条群消息就能让别人拿她的号发东西。号主不看分。
    const byUid = Number(body.by || 0);
    if (byUid) {
      const owners = cfg.raw.persona?.ownerUids ?? [];
      let okOwner = owners.includes(byUid);
      if (!okOwner) {
        try { okOwner = cfg.trusted.has(byUid); } catch { okOwner = false; }
      }
      let fv = 100;
      if (!okOwner) {
        const prof = loadProfiles(cfg.agentCwd, chat);
        const p = prof.people[byUid];
        fv = p ? ensureFavor(p) : FAVOR.init;
      }
      const gate = actionGate({
        by: byUid, favor: fv, isTrusted: okOwner, need: ACTION_VOICE_FAVOR(),
      });
      note('info', `[action] op=${op} by=${byUid} favor=${fv} → ${gate.ok ? 'allow:' + gate.why : 'deny'}`);
      if (!gate.ok) return { error: gate.error, favor: fv };
    }
    if (op === 'voice') {
      const text = String(body.text || '').trim();
      if (!text) return { error: 'text 不能为空' };
      await sendVoiceToCurrent(session, text);
      return { ok: true, op: 'voice', chat, text };
    }
    if (op === 'sticker') {
      const ref = body.ref ?? body.n ?? null;
      if (ref == null || ref === '') return { error: 'ref 不能为空（本会话 #12 或共享 S3）' };
      await sendStickerToCurrent(session, String(ref));
      return { ok: true, op: 'sticker', chat, ref: String(ref) };
    }
    if (op === 'qzone') {
      return await maybePostDaily({ cfg, runner, ob, note, force: true });
    }
    if (op === 'text') {
      // 本机 #同步 完成后回报一句（本机连不到 QQ，只能让服务器代发）
      const text = String(body.text || '').trim();
      if (!text) return { error: 'text 不能为空' };
      await sendText(session, text, null);
      history.append(chat, { t: Date.now(), role: 'bot', name: charName('我'), text });
      return { ok: true, op: 'text', chat, text };
    }
    if (op === 'file') {
      // 本机那边把产物推回来之后，由一个外部小脚本喊一声「发出去」
      // （2026-10-28）。path 只认工作区 / 数据目录 / 语音目录底下的。
      const fp = String(body.path || '').trim();
      if (!fp) return { error: 'path 不能为空' };
      try {
        const sent = await sendFileToChat({
          ob, cfg, chat, filePath: fp, name: String(body.name || '').trim() || path.basename(fp),
        });
        note('info', `[action] op=file ${sent.name}（${humanSize(sent.bytes)}）→ ${chat}`);
        return { ok: true, op: 'file', chat, name: sent.name, bytes: sent.bytes };
      } catch (e) {
        return { error: String(e.message || e) };
      }
    }
    return { error: `不认识的 op：${op}（可用 voice / sticker / qzone / text / file）` };
  },
  simulate: (body = {}) => {
    // 调试用：直接把一个 OneBot 事件塞进事件总线，用来测「空 @」「只有图片」这类
    // 模拟消息走不到的分支。仍然要 control.simulate 打开。
    if (body.event && body.event.post_type === 'message') {
      ob.emit('event', body.event);
      note('info', `[调试] 注入事件：${body.event.message_type} ${body.event.group_id || body.event.user_id}`);
      return { ok: true, emitted: true };
    }
    const chat = String(body.chat || '');
    const m = chat.match(/^(private|group):(\d+)$/);
    if (!m) return { error: 'chat 要写成 private:QQ号 或 group:群号' };
    const text = String(body.text || '').trim();
    if (!text) return { error: 'text 不能为空' };
    const kind = m[1];
    const id = Number(m[2]);
    const session = getSession(chat, kind, id, kind === 'group' ? `群 ${id}` : `私聊 ${id}`);
    enqueue(session, {
      uid: Number(body.uid) || id,
      name: String(body.name || '测试'),
      text,
      time: Date.now(),
      messageId: Date.now() % 100000000,
    });
    note('info', `[${chat}] 控制台注入一条：${text.slice(0, 40)}`);
    return { ok: true, chat, pending: session.buffer.length };
  },
});

/* ---------- 启动 ---------- */
note('info', '======================================');
note('info', 'QQ 桥 启动');
note('info', `私聊白名单: ${[...cfg.privateAllow].join(', ') || '（空！所有人都不会被回复）'}`);
note('info', `群白名单: ${[...cfg.groupAllow.entries()].map(([id, m]) => `${id}:${m}`).join(', ') || '（空）'}`);
note('info', `可信(可用工具): ${[...cfg.trusted].join(', ') || '（无）'}`);
note('info', `人设: ${path.basename(cfg.personaFile)}`);
note('info', asrConfig(cfg).enabled ? '语音转写: 开（SenseVoice 本机）' : '语音转写: 关');
note('info', '======================================');
if (cfg.privateAllow.size === 0 && cfg.groupAllow.size === 0) {
  note('warn', '白名单是空的：现在不会有任何消息被回复。去 config/config.json 填上 QQ 号。');
}

ob.start();

// 初始查一次余额，之后按 pollMinutes 轮询
void checkBalance({ force: true }).catch((e) => note('warn', `余额检查失败: ${e.message}`));
const pollMin = Math.max(1, balanceConfig(cfg).pollMinutes);
setInterval(() => {
  void checkBalance().catch((e) => note('warn', `余额检查失败: ${e.message}`));
}, pollMin * 60 * 1000);

// 目的引擎（原型）：每分钟算一遍「现在最想干什么」，结果只进日志和 data/purpose-state.json。
// 一句都不发。先跑两天看日志像不像人，再决定要不要接"主动开口"那条线。
if (cfg.purpose?.enabled !== false) {
  const purposeTickMs = Math.max(30_000, cfg.purpose?.tickMs || 60_000);
  setInterval(() => {
    try {
      purposeTick({ log: true });
    } catch (e) {
      note('warn', `目的引擎 tick 失败: ${e.message}`);
    }
  }, purposeTickMs);
  note('info', `目的引擎: 开（每 ${Math.round(purposeTickMs / 1000)} 秒算一次，开不开口由它决定）`);
} else {
  note('info', '目的引擎: 关');
}

// 今日滚动摘要：每 5 分钟巡检一次，同一会话最快 25 分钟压成一段回忆，每轮注入最近 5 条。
// 补的是「晚上写日记」到「今天上午」中间那段空白（用户 2026-10-28 拍板要这个）。
{
  const briefWatcher = createBriefWatcher({ dataDir: cfg.dataDir, getRunner: () => runner, note });
  briefWatcher.start();
  note('info', '今日摘要: 开（同一会话最快 25 分钟压一次）');
}

// 启动时先读最近三天日记（换天时会补写昨天那篇）
void refreshDiaryIfNeeded()
  .then(() => {
    if (state.diaries?.length) {
      const chars = state.diaries.reduce((n, d) => n + d.text.length, 0);
      note('info', `已读取最近 ${state.diaries.length} 天日记（${chars} 字）`);
    } else {
      note('info', '还没有日记');
    }
  })
  .catch((e) => note('warn', `日记读取失败: ${e.message}`));

// 每十分钟看一眼：到点才 @ 高好感的朋友说晚安；到 04:00 才跑维护。
// 不在窗口里时只算一次时间，连文件都不读，别白白消耗。
setInterval(() => {
  const bj = beijingNow();
  const mins = bj.hour * 60 + bj.minute;
  const inGoodnight = mins >= 23 * 60 + 30 && mins <= 23 * 60 + 50;
  if (inGoodnight) {
    void runGoodnight().catch((e) => note('warn', `晚安任务失败: ${e.message}`));
  }
  // 04:00 之后补跑一次（runDailyMaintenance 内部按 maint-state.json 的 lastMaintDay 去重）。
  // 以前只认 4:00~4:30 这个窗口，桥在那个时段没跑（重启/掉线/上游空闲）就整天跳过，
  // 好感日结、昨天日记、档案提炼一起丢——2026-10-25 查出来 maint-state.json 根本不存在。
  if (bj.hour >= 4) {
    void runDailyMaintenance().catch((e) => note('warn', `每日维护失败: ${e.message}`));
  }
  // 好感小时结算：这小时聊过天、没惹她的人 +1。每个 person 用 hourKey 去重，
  // 所以每 10 分钟扫一遍也不会重复加（2026-10-25 用户要求「每小时更新一次」）。
  void settleHourlyAll().catch((e) => note('warn', `好感小时结算失败: ${e.message}`));
  // 每天一条 QQ 空间说说：到点（默认 23:20）之后、当天没发过才发
  if (qzoneConfig(cfg).enabled) {
    void maybePostDaily({ cfg, runner, ob, note })
      .then((r) => {
        if (r.posted) note('info', `今日说说：${r.text}`);
        else if (r.reason && r.reason !== 'not yet' && r.reason !== 'already') {
          note('debug', `说说没发：${r.reason}`);
        }
      })
      .catch((e) => note('warn', `说说任务失败: ${e.message}`));
  }
}, 10 * 60 * 1000);

function shutdown(sig) {
  note('warn', `收到 ${sig}，正在退出`);
  try { control.close(); } catch { /* ignore */ }
  ob.stop();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  note('error', `未捕获异常: ${e.message}`);
  console.error(e);
});
process.on('unhandledRejection', (e) => {
  note('error', `未处理的 Promise 拒绝: ${e?.message ?? e}`);
});
