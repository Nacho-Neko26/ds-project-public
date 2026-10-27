import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { loadProfiles, saveProfiles } from '../src/anger.mjs';

const cfg = loadConfig();
const dir = path.join(cfg.agentCwd, 'profiles');
let n = 0;
const rows = [];

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const chatKey = f.replace(/\.json$/, '');
  const pr = loadProfiles(cfg.agentCwd, chatKey);
  let dirty = false;
  for (const p of Object.values(pr.people)) {
    const old = Number(p.intimacy);
    // 迁移：原来最熟的那批给 80，其余交流过的给 70
    const target = old >= 5 ? 80 : 70;
    p.favor = target;
    p.dayGain = 0;
    p.dayLoss = 0;
    p.persuadeGainToday = 0;
    p.helpedBy = {};
    p.tempPenalty = 0;
    p.slowAcc = 0;
    p.everBelow20 = false;
    dirty = true;
    n++;
    rows.push(`${(p.displayName || '?').padEnd(16)} ${target}`);
  }
  if (dirty) saveProfiles(cfg.agentCwd, chatKey, pr);
}

console.log(`重置 ${n} 人`);
console.log(rows.join('\n'));
