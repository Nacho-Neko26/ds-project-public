/**
 * 黑话库。
 *
 * 群里那套叫法、梗、外号，她说错了会被笑，学会了才像这个群的人。
 * 她自己能查（__SLANG__ query 康神），也能提报（__SLANG__ submit 康神=主播）。
 * 提报先进收件箱，本机控制台看过才转正——她不许自己给自己定规矩。
 *
 * 存储：
 *   data/slang.json        已转正：{ 词: { meaning, t, by, hits } }
 *   data/slang-inbox.jsonl 待审：{ t, word, meaning, by, chatKey }
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, appendJsonl, readJsonl } from './util.mjs';

const MAX_WORD = 24;
const MAX_MEANING = 120;

function slangFile(cfg) {
  return path.join(ensureDir(cfg.dataDir), 'slang.json');
}

function inboxFile(cfg) {
  return path.join(cfg.dataDir, 'slang-inbox.jsonl');
}

export function loadSlang(cfg) {
  try {
    const obj = JSON.parse(fs.readFileSync(slangFile(cfg), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveSlang(cfg, obj) {
  fs.writeFileSync(slangFile(cfg), JSON.stringify(obj, null, 2), 'utf8');
}

/** 查：先精确，再包含。返回 [{ word, meaning, hits }] */
export function querySlang(cfg, q) {
  const dict = loadSlang(cfg);
  const kw = String(q || '').trim();
  const all = Object.entries(dict).map(([word, v]) => ({
    word, meaning: v.meaning || '', hits: v.hits || 0,
  }));
  if (!kw) return all.slice(0, 30);
  const exact = all.filter((e) => e.word === kw);
  const part = all.filter((e) => e.word !== kw && (e.word.includes(kw) || kw.includes(e.word)));
  return [...exact, ...part].slice(0, 10);
}

/** 命中 +1，用来排序「哪句话最常被问」 */
export function bumpSlangHit(cfg, word) {
  const dict = loadSlang(cfg);
  const e = dict[word];
  if (!e) return false;
  e.hits = (e.hits || 0) + 1;
  saveSlang(cfg, dict);
  return true;
}

/**
 * 提报。已经在库里的直接更新意思（只补不改？——不改，避免她反复覆盖），
 * 没见过的进收件箱等人工过目。
 */
export function submitSlang(cfg, { word, meaning, by = '', chatKey = '' }) {
  const w = String(word || '').trim();
  const m = String(meaning || '').trim();
  if (!w || !m) return { ok: false, err: '要写成「词=意思」' };
  if (w.length > MAX_WORD) return { ok: false, err: '词太长了' };
  if (m.length > MAX_MEANING) return { ok: false, err: '意思太长，一句话讲清' };

  const dict = loadSlang(cfg);
  if (dict[w]) return { ok: false, err: `「${w}」库里已经有了：${dict[w].meaning}` };

  const rows = readJsonl(inboxFile(cfg), 500);
  const dup = rows.find((r) => r.word === w && r.status !== 'rejected');
  if (dup) return { ok: false, err: `「${w}」已经提过一次了，等主人在控制台看` };

  appendJsonl(inboxFile(cfg), { t: Date.now(), word: w, meaning: m, by, chatKey, status: 'pending' });
  return { ok: true, word: w };
}

/** 控制台用：待审计数 */
export function slangInbox(cfg, limit = 200) {
  return readJsonl(inboxFile(cfg), limit).filter((r) => r.status === 'pending');
}

/** 控制台用：审过 → 转正 */
export function acceptSlang(cfg, word) {
  const rows = readJsonl(inboxFile(cfg), 500);
  const idx = [...rows].reverse().findIndex((r) => r.word === word && r.status === 'pending');
  if (idx < 0) return { ok: false, err: '收件箱里没有这个词的待审条目' };
  const real = rows.length - 1 - idx;
  const rec = rows[real];
  const dict = loadSlang(cfg);
  dict[rec.word] = { meaning: rec.meaning, t: Date.now(), by: rec.by || '', hits: 0 };
  saveSlang(cfg, dict);
  rows[real].status = 'accepted';
  fs.writeFileSync(inboxFile(cfg), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { ok: true, word: rec.word, meaning: rec.meaning };
}

/** 控制台用：驳回 */
export function rejectSlang(cfg, word) {
  const rows = readJsonl(inboxFile(cfg), 500);
  const idx = [...rows].reverse().findIndex((r) => r.word === word && r.status === 'pending');
  if (idx < 0) return { ok: false, err: '没有待审的这个词' };
  const real = rows.length - 1 - idx;
  rows[real].status = 'rejected';
  fs.writeFileSync(inboxFile(cfg), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { ok: true, word };
}

/** 渲染成 prompt 里那段「你知道的黑话」 */
export function renderSlang(cfg, limit = 20) {
  const dict = loadSlang(cfg);
  const entries = Object.entries(dict);
  if (!entries.length) return '';
  const top = entries
    .sort((a, b) => (b[1].hits || 0) - (a[1].hits || 0))
    .slice(0, limit)
    .map(([word, v]) => `${word}=${v.meaning}`);
  return `群里这套叫法你懂（别硬套，合适才用）：\n${top.join('｜')}`;
}
