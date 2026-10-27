/**
 * 控制台的数据层（2026-10-28）：会话流 / token 用量 / 目的引擎 / 结构化记忆。
 * 纯读取，不写任何东西。所有函数失败都返回空结构，不让面板整页报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, safeFileName } from './util.mjs';
import { status as purposeStatus, goalsSnapshot } from './purpose.mjs';

const toIso = (v) => {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e11) return new Date(n).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const titleOf = (key) => {
  const m = String(key).match(/^(private|group)[:_](.+)$/);
  if (!m) return String(key);
  return `${m[1] === 'private' ? '私聊' : '群'} ${m[2]}`;
};

const dayKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------- 会话 ---------- */

export function chatList(cfg) {
  const dir = path.join(cfg.dataDir, 'history');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.includes('.bak') && !n.startsWith('.'));
  } catch { return { chats: [] }; }
  const chats = [];
  for (const n of names) {
    const file = path.join(dir, n);
    const key = n.replace(/\.jsonl$/, '');
    let size = 0; let mtime = null;
    try { const s = fs.statSync(file); size = s.size; mtime = s.mtime.toISOString(); } catch { /* 没就空着 */ }
    const rows = readJsonl(file, 2000);
    const last = rows[rows.length - 1] || {};
    chats.push({
      key,
      title: titleOf(key),
      lines: rows.length,
      size,
      mtime,
      lastText: String(last.text || '').replace(/\s+/g, ' ').slice(0, 60),
      lastAt: toIso(last.t) || mtime,
    });
  }
  chats.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return { chats };
}

export function chatMessages(cfg, key, limit = 100) {
  const safe = String(key || '');
  if (!/^(private|group)[:_][\w-]{1,40}$/.test(safe)) throw new Error('会话 key 不合法');
  const file = path.join(cfg.dataDir, 'history', `${safeFileName(safe)}.jsonl`);
  const rows = readJsonl(file, 4000);
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return {
    key: safe,
    title: titleOf(safe),
    rows: rows.slice(-n).map((r) => ({
      t: toIso(r.t),
      uid: r.uid || 0,
      name: String(r.name || ''),
      text: String(r.text || ''),
      mine: r.role === 'bot',
    })),
  };
}

/* ---------- token 用量 ---------- */

export function usageSummary(cfg, days = 7) {
  const want = Math.min(90, Math.max(1, Number(days) || 7));
  const empty = { date: null, turns: 0, in: 0, cache: 0, out: 0, total: 0, elapsedMs: 0 };
  const byDate = new Map();
  const byChat = new Map();
  const now = new Date();
  for (let i = 0; i < want; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    byDate.set(dayKey(d), { date: dayKey(d), turns: 0, in: 0, cache: 0, out: 0, total: 0, elapsedMs: 0 });
  }
  for (const [dk, acc] of byDate) {
    const file = path.join(cfg.logDir, `audit-${dk}.jsonl`);
    const rows = readJsonl(file, 4000);
    for (const r of rows) {
      const u = r.usage || {};
      const total = Number(u.total) || (Number(u.in) || 0) + (Number(u.cache) || 0) + (Number(u.out) || 0);
      acc.turns += 1;
      acc.in += Number(u.in) || 0;
      acc.cache += Number(u.cache) || 0;
      acc.out += Number(u.out) || 0;
      acc.total += total;
      acc.elapsedMs += Number(r.elapsedMs) || 0;
      const k = String(r.chat || '-');
      const hit = byChat.get(k) || { chat: k, title: String(r.title || titleOf(k)), turns: 0, total: 0 };
      hit.turns += 1;
      hit.total += total;
      byChat.set(k, hit);
    }
  }
  const list = [...byDate.values()];
  const today = list[0] || { ...empty };
  return {
    today,
    days: list.slice().reverse(),
    byChat: [...byChat.values()].sort((a, b) => b.total - a.total).slice(0, 20),
  };
}

/* ---------- 目的引擎 ---------- */

export function purposeState(cfg) {
  let base = { drives: {}, goals: [], nextFireAt: null, todayCount: 0, lastTickAt: null, pendingOutput: [] };
  try { base = { ...base, ...purposeStatus() }; } catch { /* 引擎没跑过就空着 */ }
  let goals = [];
  try {
    goals = goalsSnapshot(80).map((g) => ({
      id: g.id,
      kind: g.kind || '',
      text: String(g.text || '').slice(0, 120),
      attempts: Number(g.attempts) || 0,
      sightings: Number(g.sightings) || 0,
      state: g.state || '',
      unresolved: !!g.unresolved,
      confidence: Math.round((Number(g.confidence) || 0) * 100) / 100,
      value: Math.round((Number(g.value) || 0) * 100) / 100,
      urgency: Math.round((Number(g.urgency) || 0) * 100) / 100,
      risk: Math.round((Number(g.risk) || 0) * 100) / 100,
      updatedAt: toIso(g.updatedAt),
    })).sort((a, b) => (b.value * 0.6 + b.urgency * 0.4) - (a.value * 0.6 + a.urgency * 0.4));
  } catch { /* 没有就算了 */ }
  let mutedUntil = null;
  try {
    const w = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'selfwake.json'), 'utf-8'));
    mutedUntil = toIso(w.wakeOffUntil);
  } catch { /* 同上 */ }
  return {
    drives: base.drives || {},
    goals,
    nextFireAt: base.nextFireAt || null,
    lastTickAt: base.lastTickAt || null,
    todayCount: Number(base.todayCount) || 0,
    pendingOutput: base.pendingOutput || [],
    mutedUntil,
    updatedAt: new Date().toISOString(),
  };
}

/* ---------- 结构化记忆 ---------- */

export function memoryStruct(cfg, grep = '') {
  const file = path.join(cfg.agentCwd, 'memory', 'memories.jsonl');
  const rows = readJsonl(file, 8000);
  const q = String(grep || '').trim().toLowerCase();
  const scopes = new Map();
  const items = [];
  let chars = 0;
  for (const r of rows) {
    const scope = String(r.scope || '未分组');
    const text = String(r.text || '');
    chars += text.length;
    const hit = scopes.get(scope) || { scope, count: 0, chars: 0 };
    hit.count += 1;
    hit.chars += text.length;
    scopes.set(scope, hit);
    if (!q || text.toLowerCase().includes(q)) {
      items.push({ scope, text, t: toIso(r.t), importance: Number(r.importance) || 0 });
    }
  }
  items.sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
  return {
    scopes: [...scopes.values()].sort((a, b) => b.count - a.count),
    items: items.slice(0, 400),
    total: rows.length,
    chars,
  };
}
