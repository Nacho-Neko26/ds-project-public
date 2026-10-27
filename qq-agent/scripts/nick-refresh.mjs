// 一次性把已有档案里的外号按新规则重算一遍（2026-10-23）。
// 用法：systemctl stop qq-bridge && node scripts/nick-refresh.mjs && systemctl start qq-bridge
// 只改没有 callOverride（本人/号主点名过）的人；号主固定主人。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { pickNoun } from '../src/diary.mjs';
import { setGlobalNick, readGlobalNicks } from '../src/anger.mjs';

const cfg = loadConfig();
const dir = path.join(cfg.agentCwd, 'profiles');
const owners = new Set((cfg.raw.persona?.ownerUids || []).map(Number));

if (!fs.existsSync(dir)) {
  console.log('没有 profiles 目录，不用改');
  process.exit(0);
}

// 先把各档案里已有的 callOverride 汇总进全局表（称呼跟人走，不跟群走）
let migrated = 0;
const pins = { ...readGlobalNicks(cfg.agentCwd) };
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  let db;
  try { db = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  for (const p of Object.values(db.people || {})) {
    const uid = Number(p.uid);
    const ov = p.callOverride;
    if (!ov || typeof ov.name !== 'string') continue;
    const cur = pins[uid];
    if (!cur || Number(ov.at || 0) > Number(cur.at || 0)) {
      pins[uid] = ov;
      migrated += 1;
      console.log(`迁移称呼 #${uid}: 「${ov.name || '（不用外号）'}」(${ov.by})`);
    }
  }
}
for (const [uid, ov] of Object.entries(pins)) setGlobalNick(cfg.agentCwd, Number(uid), ov);
if (migrated) console.log(`全局称呼表更新 ${migrated} 条`);

let changed = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  const file = path.join(dir, f);
  let db;
  try {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log(`跳过 ${f}（读不了）`);
    continue;
  }
  let touched = false;
  for (const p of Object.values(db.people || {})) {
    if (p.callOverride && typeof p.callOverride.name === 'string') continue;
    const uid = Number(p.uid);
    const want = owners.has(uid) ? '主人' : (pickNoun(p.displayName, { aliases: cfg.raw.persona?.aliases || [] }) || '');
    if (want !== (p.nickFor || '')) {
      console.log(`${f}  ${p.displayName} (#${uid}): 「${p.nickFor || ''}」→「${want}」`);
      p.nickFor = want;
      touched = true;
      changed += 1;
    }
  }
  if (touched) fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
}
console.log(`改完 ${changed} 个称呼`);
