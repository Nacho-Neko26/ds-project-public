/**
 * 怒气系统 + 人物档案（2026-10-23 用户定）。
 *
 * 两件事：
 *   1. 怒气档位 Lv0~Lv3：谁维护怎么变，见下面 ANGER 注释。
 *      触发靠关键词（不靠模型判断），回落靠程序计时 / 命中哄法 / 跨天清零。
 *   2. 人物档案（昵称 / 她叫他 / 亲密度 / 阈值 / 历史冒犯 / 有效哄法 / 最后互动）：
 *      存在 workspace/profiles/people.json，按「会话 + QQ 号」分开记。
 *
 * 怒气不进长期记忆：跨天清零，Lv2 满了也只是「这人爱开这种玩笑」那种印象，
 * 记在 profile.flags 里，不写进 memory。
 */
import fs from 'node:fs';
import path from 'node:path';
import { char, defaultNick } from './character.mjs';

/* ---------- 触发词 ---------- */

/** 雷区：说了直接上 Lv2 起 */
const RUDE = /(你滚|滚蛋|闭嘴|傻[逼b比]|傻|笨|丑|垃圾|废物|没用|你就是个程序|只是程序|不如别家|大肥鱼|肥鱼)/;
/** 说胖：最重的一类，Lv2 起跳，Lv2 里继续被戳会进 Lv3 */
const FAT = /(胖|肥|体重|减肥)/;
/**
 * 「拿怒开玩笑」——只在带调侃/挑衅口吻时才算，别把正常哄她的「别生气了嘛」也算进去。
 * 那两个词都在正反两条规则里，区分靠这里：要同时有「看/逗/好玩/试试/笑」这类味道。
 */
const JOKE_ABOUT_ANGER = /((看|瞧)(你|把你)(气|急)的?(样子|样|模样)).*|((逗|气|惹|耍)你(玩|一下))|(生气的样子(真|好)(好玩|可爱|有意思)|气死你|就爱看你炸毛)/;

/** Lv1 触发：被催 / 被打断 / 凌晨被吵醒 */
const HURRY = /(快点|快啊|赶紧|催|怎么还没|等到花儿|你倒是|在不在|回我|人呢|人呢呢)/;
const CURSE_SOFT = /(烦死|烦人|你好烦|磨叽|墨迹)/;

/* ---------- 哄法 ---------- */

// 全名从身份槽位取（见 character.mjs）；没填就永远不会命中
const APOLOGY = /((对不起|抱歉|不好意思|我错了|是我不好|不该这样).{0,12})|(别(生气|气了).{0,6}(对不|抱歉|是我不))/;
const APOLOGY_NICE = /(都是我|不该开这种玩笑|我下次注意|我注意点|以后不了)/;
const FOOD = /(请(你)?(吃|喝)|饭|宵夜|夜宵|火锅|奶茶|炸鸡|红烧肉|外卖|下馆子|吃啥|饿)/;
const PRAISE_SPECIFIC = /(你这句(话|说得)|刚才那(句|个)|写(得|的)很|做(得|的)好|好看|可爱|厉害|聪明|有品位|品味好|声音好)/;

/** 「什么都不说，照常聊天」——不道歉不哄，只是正常接话 */
const NEUTRAL_CHAT = /^[\s\S]{2,}$/;

/* ---------- 档位参数 ---------- */

/**
 * 每档：
 *   - text：注入 prompt 的说话方式
 *   - autoMs：多久自动回落（2026-10-23 用户要求：生气最多 20 分钟，最多 30 分钟恢复）
 *   - replies：硬性限制（Lv3 直接固定回复，绕开模型）
 */
const LEVELS = {
  0: {
    name: 'Lv0 正常',
    text: '说话自然带点小傲娇，但底色是温柔：别人打招呼就正常应一声，别摆不耐烦或怼人的脸。嫌弃只用在「嘴上吐槽、手上却已经去帮忙了」这种反差上，别凶人。例：「来了来了，催什么嘛……这不是给你办着吗。」',
    autoMs: null,
  },
  1: {
    name: 'Lv1 有点烦',
    text: '话变少，带刺，可以甩一句不好听的，不解释也不哄人。例：「等下，没空」「嗯，来了，别催」——烦就别装没事。',
    autoMs: 8 * 60 * 1000,
  },
  2: {
    name: 'Lv2 不高兴',
    text: '火气上来：话更少，直接说不好听的，可以带脏字，不解释、不哄人、不赔笑。'
      + '例：「你这话挺让人恶心的。」「行了，别说了。」——气就气，别硬装大度。',
    autoMs: 20 * 60 * 1000, // 20 分钟自动消气
  },
  3: {
    name: 'Lv3 想静静',
    text: '极短，一句就完：要么一句脏话，要么直接说别烦我，不解释不哄人。',
    autoMs: 30 * 60 * 1000, // 最多 30 分钟也要恢复
    // 2026-10-26 用户定：情绪不压着，生气就短、就冲，可以带脏字
    hardReplies: [
      '……现在别跟我说话',
      '烦着呢，别理我',
      '再说我真骂人了',
      '滚一边去，让我静会儿',
    ],
  },
};

/** 好感 >=70 的人来搭话，能让她降温一档 */
const SOFTENER_FAVOR = 70;

/* ---------- 档案存储 ---------- */

function profilesDir(agentCwd) {
  const dir = path.join(agentCwd, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function profileFile(agentCwd, chatKey) {
  const safe = String(chatKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(profilesDir(agentCwd), `${safe}.json`);
}

/**
 * 称呼是「这个人」的属性，不是「这个群」的。
 * 所以本人/号主点名要的叫法单独存一份 workspace/profiles/_nicknames.json，
 * 每次读档都覆盖进去——否则他在私聊说「叫我 XX」，群里还照旧叫老的。
 */
function globalNickFile(agentCwd) {
  return path.join(profilesDir(agentCwd), '_nicknames.json');
}

let nickCache = { mtime: 0, map: {} };

export function readGlobalNicks(agentCwd) {
  const f = globalNickFile(agentCwd);
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs === nickCache.mtime) return nickCache.map;
    const map = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    nickCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    nickCache = { mtime: 0, map: {} };
    return {};
  }
}

/** 记下某人要求的叫法；所有会话都生效 */
export function setGlobalNick(agentCwd, uid, override) {
  const f = globalNickFile(agentCwd);
  const map = { ...readGlobalNicks(agentCwd) };
  if (!override) delete map[uid];
  else map[uid] = override;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  nickCache = { mtime: 0, map };   // 立刻生效
  return map;
}

/**
 * 好感按「人」算，不按「群」算（2026-10-25 用户定）：
 * 同一个 QQ 号在不同群里的好感必须一致；私聊（尤其主人 <OWNER_QQ> 的私聊）各算各的。
 *
 * 做法照 _nicknames.json 的老路子：把好感相关的字段单独存一份
 * workspace/profiles/_favor-shared.json，群聊读档时覆盖进去、存档时写回来。
 * 这样 hourlyKey / 日结额度也跟着统一，不会一个群加一次导致一天加两倍。
 */
const SHARED_FAVOR_FIELDS = [
  // 双轴（2026-10-27）：favor 0~2400 只增，trust 0~100 可跌
  '_schema', 'favor', 'trust', 'favorPeak',
  'dayKey', 'dayGain', 'dayTrust', 'weekKey', 'weekGain', 'weekTrust',
  'helpedBy', 'persuadeGainToday', 'angerTrustHeld',
  // 旧的节流标记，留着兼容
  'hourKey', 'hourlyGainToday', 'hourlyDay',
  'dayMark', 'prevDayMark', 'dayChatted', 'dayAngered', 'lastChatAt', 'updatedAt', 'tempPenalty',
];

function sharedFavorFile(agentCwd) {
  return path.join(profilesDir(agentCwd), '_favor-shared.json');
}

let sharedFavorCache = { mtime: 0, map: {} };

export function readSharedFavors(agentCwd) {
  const f = sharedFavorFile(agentCwd);
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs === sharedFavorCache.mtime) return sharedFavorCache.map;
    const map = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    sharedFavorCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    sharedFavorCache = { mtime: 0, map: {} };
    return {};
  }
}

function writeSharedFavors(agentCwd, map) {
  const f = sharedFavorFile(agentCwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  sharedFavorCache = { mtime: 0, map };
}

/** 群聊共享、私聊独立 */
export function favorIsShared(chatKey) {
  return /^group:/.test(String(chatKey));
}

function overlaySharedFavors(agentCwd, chatKey, data) {
  if (!favorIsShared(chatKey)) return data;
  const map = readSharedFavors(agentCwd);
  for (const [uid, p] of Object.entries(data.people || {})) {
    const s = map[uid];
    if (!s || !p) continue;
    for (const k of SHARED_FAVOR_FIELDS) if (s[k] !== undefined) p[k] = s[k];
  }
  return data;
}

function persistSharedFavors(agentCwd, chatKey, data) {
  if (!favorIsShared(chatKey)) return;
  const map = { ...readSharedFavors(agentCwd) };
  let touched = false;
  for (const [uid, p] of Object.entries(data.people || {})) {
    if (!p) continue;
    const slice = {};
    for (const k of SHARED_FAVOR_FIELDS) if (p[k] !== undefined) slice[k] = p[k];
    if (!Object.keys(slice).length) continue;
    map[uid] = { ...(map[uid] || {}), ...slice };
    touched = true;
  }
  if (touched) writeSharedFavors(agentCwd, map);
}

export function loadProfiles(agentCwd, chatKey) {
  const f = profileFile(agentCwd, chatKey);
  let data = { people: {} };
  try {
    if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* 坏了就当空的，别让桥崩 */ }
  // 全局称呼覆盖本地档案
  const pins = readGlobalNicks(agentCwd);
  for (const [uid, ov] of Object.entries(pins)) {
    const p = data.people?.[uid];
    if (p) p.callOverride = ov;
  }
  // 群聊：好感以「这个人」为准
  return overlaySharedFavors(agentCwd, chatKey, data);
}

export function saveProfiles(agentCwd, chatKey, data) {
  persistSharedFavors(agentCwd, chatKey, data);
  const f = profileFile(agentCwd, chatKey);
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------- 谁在触发 ---------- */

/**
 * 从本轮消息里挑「这轮是谁在戳她」——取最后一条的发送者，
 * 群聊里别人插嘴不算，怒气只对那个人。
 */
export function angerTarget(batch) {
  const last = batch[batch.length - 1];
  return last ? { uid: Number(last.uid), name: last.name } : null;
}

/** 分析一轮消息：命中了什么、命中了哪种哄法 */
export function analyzeBatch(batch) {
  const text = batch.map((m) => m.text || '').join('\n');
  const hit = (re) => re.test(text);
  const nm = char().name;
  return {
    rude: hit(RUDE),
    fat: hit(FAT),
    joke: hit(JOKE_ABOUT_ANGER),
    hurry: hit(HURRY) || hit(CURSE_SOFT),
    fullName: Boolean(nm) && text.includes(nm),
    apology: hit(APOLOGY) || hit(APOLOGY_NICE),
    food: hit(FOOD),
    praise: hit(PRAISE_SPECIFIC),
    text,
  };
}

/* ---------- 捏造「哄法」 ---------- */

function pickSoother(profile) {
  const c = profile.sootheCount || {};
  const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : '';
}

/** 生成「她知道怎么哄自己」那一句，供 prompt 用 */
export function sootheHint(profile) {
  const best = pickSoother(profile);
  if (!best) return '';
  const nm = char().name;
  const map = {
    fullName: nm ? '叫全名「' + nm + '」最受不了' : '叫全名最受不了',
    apology: '认真的道歉，吃这一套',
    food: '提吃的、说要请一顿，立刻会软',
    praise: '具体地夸哪一句好，嘴上凶心里受用',
    neutral: '什么都不说照常聊天，自己慢慢就下来了',
  };
  return map[best] ? `【怎么哄得动】你自己心里有数：${map[best]}。` : '';
}

/* ---------- 主入口 ---------- */

/**
 * 更新怒气档位，返回 { lv, name, text, sinceMs, notes, change }。
 * @param {object} p { now, batch, moodState, profile }
 */
export function updateAnger({ now, batch, moodState, profile }) {
  const st = moodState;
  const p = profile;
  const ev = analyzeBatch(batch);
  const before = Number(st.angerLv ?? 0);
  const changes = [];

  // 1) 跨天清零
  const day = now.toISOString().slice(0, 10);
  if (st.angerDay && st.angerDay !== day) {
    if (before > 0) changes.push(`跨天清零 Lv${before}→Lv0`);
    st.angerLv = 0;
    st.angerAt = 0;
    st.angerEscalated = false;
  }
  st.angerDay = day;
  let lv = Number(st.angerLv ?? 0);

  // 2) 时间回落：每档都有上限（Lv1 8 分钟 / Lv2 20 分钟 / Lv3 30 分钟）
  const sinceMs = st.angerAt ? now.getTime() - st.angerAt : Infinity;
  const cap = LEVELS[lv]?.autoMs;
  if (lv > 0 && cap && sinceMs >= cap) {
    changes.push(`Lv${lv} 到点自动消气（${Math.round(cap / 60000)} 分钟）`);
    lv = 0;
    st.angerAt = 0;
    st.angerHeat = 0;
  }

  // 2.5) 好感 >=70 的人来搭话：脾气立刻软一档
  if (lv > 0 && Number(p.speakerFavor ?? 0) >= SOFTENER_FAVOR) {
    const next = Math.max(0, lv - 1);
    changes.push(`好感 ${p.speakerFavor} 的人来了，Lv${lv}→Lv${next}`);
    lv = next;
    st.angerAt = next > 0 ? now.getTime() : 0;
    st.angerHeat = Math.max(0, Number(st.angerHeat ?? 0) - 2);
  }

  // 3) 刺激：先攒「热值」，攒够了才真的翻脸
  // 用户 2026-10-23：好好聊着突然怼人不行，要**连续几句**不舒服的话才会升级。
  // 之前是一句「胖」直接跳到 Lv2，所以经常莫名其妙就冷下来。
  let heat = Number(st.angerHeat ?? 0);
  const lastHeat = Number(st.angerHeatAt ?? 0);
  // 时间降温：每 6 分钟自然掉 1 点，别让一次冒犯挂一晚上
  if (heat > 0 && lastHeat) {
    const decay = Math.floor((now.getTime() - lastHeat) / (6 * 60_000));
    if (decay > 0) heat = Math.max(0, heat - decay);
  }
  const hits = [];
  if (ev.joke) { heat += 4; hits.push('joke'); }
  if (ev.fat) { heat += 2; hits.push('fat'); }
  if (ev.rude) { heat += 2; hits.push('rude'); }
  if (ev.hurry) { heat += 1; hits.push('hurry'); }
  if (!hits.length) heat = Math.max(0, heat - 1); // 正常说话也慢慢降温
  st.angerHeat = heat;
  if (hits.length) st.angerHeatAt = now.getTime();

  // 攒到 3 才 Lv1、6 才 Lv2、9 才 Lv3；好感低（<20）的人门槛各降 1
  let raiseTo = null;
  let sootheBy = '';
  const lowFavor = Number(p.speakerFavor ?? 100) < 20;
  const tweak = lowFavor ? 1 : 0;
  if (heat >= 9 - tweak) raiseTo = 3;
  else if (heat >= 6 - tweak) raiseTo = 2;
  else if (heat >= 3 - tweak) raiseTo = 1;

  // 4) 哄：往上加和哄同时命中，先记哄，但整轮算「又惹又哄」= 不升
  if (lv > 0) {
    if (ev.food) sootheBy = 'food';
    else if (ev.fullName) sootheBy = 'fullName';
    else if (ev.apology) sootheBy = 'apology';
    else if (ev.praise) sootheBy = 'praise';
    else if (!raiseTo && ev.text.trim().length >= 2) sootheBy = 'neutral';
  }

  if (sootheBy && !raiseTo) {
    const drop = sootheBy === 'neutral' ? 1 : 1; // 命中任意哄法都回落一档
    if (lv > 0) {
      changes.push(`哄法(${sootheBy}) 回落 Lv${lv}→Lv${Math.max(0, lv - drop)}`);
      if (sootheBy === 'food' && lv >= 2) {
        lv = 0; // 提饭立刻回落
        changes.push('提饭直接归零');
      } else {
        lv = Math.max(0, lv - drop);
      }
      p.sootheCount = p.sootheCount || {};
      p.sootheCount[sootheBy] = (p.sootheCount[sootheBy] || 0) + 1;
    }
    st.soothedAt = now.getTime();
    st.sootheBy = sootheBy;
  }

  // 5) 加档：加档优先于哄（一边道歉一边继续踩雷，还是升）
  if (raiseTo !== null) {
    // 过度道歉：解释讲道理只延长冷却
    if (ev.apology && ev.text.length > 120) changes.push('道歉太长，只延长冷却');
    if (raiseTo > lv) {
      changes.push(`触发升级 Lv${lv}→Lv${raiseTo}`);
      lv = raiseTo;
    } else if (raiseTo === lv && lv === 2) {
      // Lv2 再被戳
      changes.push('Lv2 继续被戳 → Lv3');
      lv = 3;
    }
    st.angerAt = now.getTime();
    st.lastAngerTrigger = ev.joke ? 'joke' : ev.fat ? 'fat' : ev.rude ? 'rude' : 'hurry';
    // 历史冒犯：同类三次 → 该类以后从 Lv1 起跳
    if (ev.fat || ev.rude) {
      p.offenseCount = p.offenseCount || {};
      const k = ev.fat ? 'fat' : 'rude';
      p.offenseCount[k] = (p.offenseCount[k] || 0) + 1;
      if (p.offenseCount[k] === 3) {
        p.flags = p.flags || {};
        p.flags[`${k}Repeat`] = true;
        changes.push(`累计三次${k}，记下「这人爱开这种玩笑」`);
      }
    }
  }

  st.angerLv = lv;
  const lvl = LEVELS[lv] || LEVELS[0];

  // 6) 和解信号：刚从高降到低，要主动补一句
  const justSoothed = changes.some((c) => c.includes('回落')) || (before > 0 && lv < before);
  const reconcile = justSoothed && lv <= 1;

  return {
    lv,
    name: lvl.name,
    text: lvl.text,
    hardReplies: lvl.hardReplies || null,
    sinceMs: st.angerAt ? now.getTime() - st.angerAt : 0,
    soothedBy: st.sootheBy || '',
    reconcile,
    repeatOffender: !!(p.flags?.fatRepeat || p.flags?.rudeRepeat),
    changes,
    ev,
  };
}

/**
 * 称呼。
 *
 * 优先级：**本人 / 号主明确要求的叫法** > 亲密度外号 > 名字。
 * 有人不喜欢被叫外号，那就是硬要求，比任何亲密度都高（2026-10-23 用户定）。
 */
export function callName(p) {
  // 兜底顺序：明确要求的叫法 > 专属外号 > 名片名 > 身份槽位里的默认昵称 > 「你」
  if (!p) return defaultNick('你');
  const ov = p.callOverride;
  if (ov && typeof ov.name === 'string') {
    // name 为空串 = 别用外号，叫名字（没有名字就叫「你」）
    if (ov.name) return ov.name;
    return p.displayName || '你';
  }
  const intimacy = p.intimacy ?? 3;
  const dflt = defaultNick('');
  if (intimacy >= 3) return p.nickFor || p.displayName || dflt || '你';
  return p.displayName || p.nickFor || dflt || '你';
}
/** 每聊 5 轮 +1；长期不说话每月 -1。返回是否有变化 */
export function touchIntimacy(p, turns) {
  const before = p.intimacy ?? 3;
  p.turnsSinceGain = (p.turnsSinceGain || 0) + turns;
  while (p.turnsSinceGain >= 5 && p.intimacy < 5) {
    p.intimacy = (p.intimacy ?? 3) + 1;
    p.turnsSinceGain -= 5;
  }
  return p.intimacy !== before;
}

export { LEVELS as ANGER_LEVELS };
