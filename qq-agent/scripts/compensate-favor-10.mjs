/**
 * 一次性补偿：所有档案里的人好感 +10。
 *   node scripts/compensate-favor-10.mjs [--dry]
 * 这 10 分走 ignoreCap：不打折（低好感也照给）、不占当天 20 分额度、不动 dayGain。
 * 不传 dayKey，所以不会 rollDay、不会打断今天已有的 dayMark / hourlyGainToday。
 * 跑过一次就把 data/favor-compensated.json 记下来，重复跑会直接退出（真跑过就不再给）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadProfiles, saveProfiles } from '../src/anger.mjs';
import { applyFavor } from '../src/favor.mjs';

const json = process.argv.includes('--json');
const cwd = process.env.QQ_AGENT_WORKSPACE || '/root/qq-agent/workspace';
const markerFile = path.join(cwd, 'data', 'favor-compensated.json');
const TAG = '2026-10-25-compensate-10';
const dry = process.argv.includes('--dry');

if (!dry) {
  try {
    const done = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (done[TAG]) {
      console.log(`已经补偿过了（${done[TAG]}），跳过。要重跑先删 ${markerFile}`);
      process.exit(0);
    }
  } catch { /* 没有标记文件就是没跑过 */ }
}

const dir = path.join(cwd, 'profiles');
let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
} catch (e) {
  console.error('读不到 profiles:', e.message);
  process.exit(1);
}

const lines = [];
let total = 0;
for (const f of files) {
  const chatKey = f.replace(/\.json$/, '').replace('_', ':');
  const data = loadProfiles(cwd, chatKey);
  let dirty = false;
  for (const [uid, p] of Object.entries(data.people || {})) {
    const r = applyFavor(p, 10, { ignoreCap: true, ignoreSlow: true });
    lines.push(`${chatKey}/${uid}: ${r.before} → ${r.after}`);
    total += 1;
    dirty = true;
  }
  if (dirty && !dry) saveProfiles(cwd, chatKey, data);
}

if (!dry) {
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  let done = {};
  try { done = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { /* ignore */ }
  done[TAG] = new Date().toISOString();
  fs.writeFileSync(markerFile, JSON.stringify(done, null, 2));
}

if (json) {
  console.log(JSON.stringify({ total, lines }, null, 2));
} else {
  console.log(`${dry ? '[dry] ' : ''}补偿 ${total} 人：`);
  console.log(lines.join('\n'));
}
