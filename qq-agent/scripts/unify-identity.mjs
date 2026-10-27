/**
 * 一次性把老档案里的名字收进身份表（认人系统的初始化）。
 *
 * 认人系统上线前的数据：每个群一份 profiles/<chatKey>.json，people[uid].displayName
 * 是那个人在**那个群**的名片；记事本在 notebook/<chatKey>.json，people[uid].about
 * 是「关于他」的描述。这个脚本把它们汇总成：
 *   profiles/_identities.json   uid -> 所有叫法 + 在哪些会话出现过
 *   profiles/_about-shared.json uid -> 关于他的描述（跨群一份）
 *
 * 用法（在 qq-agent 目录下）：
 *   node scripts/unify-identity.mjs --dry   只看不写
 *   node scripts/unify-identity.mjs         真写
 * 桥不用停——共享表是每轮按 mtime 读的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { recordIdentity, writeSharedAbout, readIdentities, readSharedAbout } from '../src/identity.mjs';
import { loadConfig } from '../src/config.mjs';

const DRY = process.argv.includes('--dry');
// 注意：桥的 agentCwd 是 <qq-agent>/workspace，不是 qq-agent 本身（配置文件 agent.cwd）。
// 2026-10-25 第一版写死成 cwd，结果把 _identities.json 写到了 /root/qq-agent/profiles/，白跑一次。
const cfg = loadConfig();
const CWD = cfg.agentCwd;
const PROFILES = path.join(CWD, 'profiles');
const NOTEBOOK = path.join(CWD, 'notebook');
console.log(`[agentCwd] ${CWD}`);

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch { return []; }
}

function chatKeyOf(file) {
  const base = file.replace(/\.json$/, '');
  const m = /^(group|private)_(\d+)$/.exec(base);
  if (m) return `${m[1]}:${m[2]}`;
  return base;
}

let people = 0;
let aliases = 0;
const namesByUid = new Map();

for (const file of listJson(PROFILES)) {
  const chat = chatKeyOf(file);
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(PROFILES, file), 'utf8')); } catch { continue; }
  for (const [uid, p] of Object.entries(data.people || {})) {
    const name = String(p?.displayName || '').trim();
    if (!name) continue;
    people++;
    const list = namesByUid.get(uid) || [];
    if (!list.includes(name)) list.push(name);
    namesByUid.set(uid, list);
    if (!DRY) {
      const cur = recordIdentity(CWD, Number(uid), name, { chat });
      if (cur) aliases = cur.aliases.length;
    }
  }
}

console.log(`[profiles] 扫到 ${people} 条人物档案，涉及 ${namesByUid.size} 个 QQ 号`);
for (const [uid, list] of [...namesByUid.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (list.length > 1) console.log(`  ${uid}：${list.join('、')}`);
}

// 记事本里的「关于他」：同一个 uid 取最长的一份（信息最多），写进共享表
let aboutCount = 0;
const aboutByUid = new Map();
for (const file of listJson(NOTEBOOK)) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(NOTEBOOK, file), 'utf8')); } catch { continue; }
  for (const [uid, p] of Object.entries(data.people || {})) {
    const about = String(p?.about || '').trim();
    if (!about) continue;
    const old = aboutByUid.get(uid);
    if (!old || about.length > old.length) aboutByUid.set(uid, about);
  }
}

const shared = DRY ? {} : readSharedAbout(CWD);
for (const [uid, about] of aboutByUid) {
  aboutCount++;
  if (DRY) continue;
  if (shared[uid]?.about) continue; // 已经有了就不覆盖
  writeSharedAbout(CWD, Number(uid), about);
}
console.log(`[notebook] 找到 ${aboutCount} 份「关于他」描述`);

if (DRY) {
  console.log('--- dry-run，没有写文件 ---');
} else {
  const ids = readIdentities(CWD);
  console.log(`[done] _identities.json ${Object.keys(ids).length} 人；_about-shared.json ${Object.keys(readSharedAbout(CWD)).length} 人`);
  for (const [uid, cur] of Object.entries(ids)) {
    if ((cur.aliases || []).length > 1) console.log(`  ${uid}：${cur.aliases.join('、')}`);
  }
}
