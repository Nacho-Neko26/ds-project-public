/**
 * 发言习惯。
 *
 * 按群/会话定期读一段聊天记录，提炼出「在这里该怎么说话」的要点，
 * 存到 workspace/habits/<会话key>.md，之后每轮注入 prompt。
 *
 * 只学说话方式（常用词、节奏、气氛、哪些话被接），不记八卦和隐私。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, ensureDir, safeFileName, hhmm, log } from './util.mjs';
import { guardFor } from './resource-guard.mjs';

export const DEFAULT_HABITS_CONFIG = {
  enabled: true,
  everyMessages: 40,   // 每累计多少条新消息更新一次
  maxLines: 8,         // 保留几条要点
  maxChars: 400,       // 注入上限
};

export function habitsConfig(cfg) {
  return { ...DEFAULT_HABITS_CONFIG, ...(cfg?.raw?.habits || {}) };
}

function habitsDir(agentCwd) {
  return ensureDir(path.join(agentCwd, 'habits'));
}

export function habitsFile(agentCwd, chatKey) {
  return path.join(habitsDir(agentCwd), `${safeFileName(chatKey)}.md`);
}

export function readHabits(agentCwd, chatKey) {
  const f = habitsFile(agentCwd, chatKey);
  if (!fs.existsSync(f)) return '';
  return fs.readFileSync(f, 'utf8').trim();
}

function writeHabits(agentCwd, chatKey, text) {
  fs.writeFileSync(habitsFile(agentCwd, chatKey), text.trim() + '\n', 'utf8');
}

/** 最近 N 条消息渲染成素材 */
function recentTranscript(dataDir, chatKey, limit = 120) {
  const file = path.join(dataDir, 'history', `${safeFileName(chatKey)}.jsonl`);
  const rows = readJsonl(file, limit);
  const lines = rows.map((r) => {
    const d = new Date(Number(r.t));
    const who = r.role === 'bot' ? '你' : r.name;
    return `${hhmm(Number(r.t))} 【${who}】${r.text}`;
  });
  const span = rows.length
    ? `${new Date(Number(rows[0].t)).toLocaleDateString('zh-CN')} ~ ${new Date(Number(rows[rows.length - 1].t)).toLocaleDateString('zh-CN')}`
    : '';
  return { text: lines.join('\n'), count: rows.length, span };
}

/**
 * 更新某个会话的发言习惯。
 * @returns {Promise<string|null>} 新习惯文本（失败返回 null）
 */
export async function updateHabits({ runner, cfg, chatKey, chatTitle }) {
  const conf = habitsConfig(cfg);
  if (!conf.enabled) return null;
  if (!chatKey.startsWith('group:')) return null; // 目前只学群

  // 服务器紧张时后台整理先让路（2026-10-28 用户要求：先保文本回复）。
  const gate = guardFor(cfg).allow('bg');
  if (!gate.ok) { log('info', `[习惯学习] ${gate.reason}`); return null; }

  const { text, count, span } = recentTranscript(cfg.dataDir, chatKey, 120);
  if (count < 10) return null; // 太少，学不出东西

  const previous = readHabits(cfg.agentCwd, chatKey);

  const prompt = [
    `你在观察群聊「${chatTitle || chatKey}」，想学会**这个群**的说话习惯。`,
    '',
    `下面是最近的聊天记录（${span}，共 ${count} 条）。「你」是你自己说过的话，其余是群里的人。`,
    '',
    text,
    '',
    previous ? `你之前总结过这些：\n${previous}\n` : '',
    '请更新你的理解，输出新的要点。',
    '',
    '**只写这个群特有的东西，不要写你自己的性格设定。**',
    '"短句""不装客气""一次只答一件事"这类是你本来就有的，不要写。',
    '要写的是：这些人平时怎么说话。比如：',
    '- 他们常用的词、口头禅、黑话、梗',
    '- 句子长短、爱不爱发表情包、爱不爱斗图',
    '- 聊天的节奏（谁常起头、怎么接梗、是不是互相拆台）',
    '- 什么话题他们最活跃、什么话题会冷',
    '- 你在这个群里该怎么接，才不像外人',
    '',
    '要求：',
    `- 最多 ${conf.maxLines} 条，每条一行，一条一件事，不超过 20 字。`,
    '- 不要写具体谁说了什么八卦，不要记隐私，不要列人名。',
    '- 不要编号、不要标题、不要 Markdown 符号，一行一条纯文本。',
    '- 直接输出要点本身。',
  ].filter(Boolean).join('\n');

  const r = await runner.run({ prompt });
  if (!r.ok || !r.text) {
    log('warn', `发言习惯更新失败（${chatKey}）`);
    return null;
  }

  const lines = r.text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*·\d.、\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, conf.maxLines);

  if (!lines.length) return null;
  const merged = lines.join('\n');
  writeHabits(cfg.agentCwd, chatKey, merged);
  log('info', `发言习惯已更新 ${chatKey}（${lines.length} 条）`);
  return merged;
}
