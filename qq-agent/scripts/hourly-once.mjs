/**
 * 手动跑一次好感小时结算（正常由桥每 10 分钟的 ticker 自动跑）。
 *   node scripts/hourly-once.mjs
 * 只结算「这一小时聊过天、没惹她」的人，每个 person 按 hourKey 去重，跑多次也只加一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadProfiles, saveProfiles } from '../src/anger.mjs';
import { settleHourlyChat, beijingNow } from '../src/favor.mjs';

const cwd = process.env.QQ_AGENT_WORKSPACE || '/root/qq-agent/workspace';
const bj = beijingNow();
const hourKey = `${bj.key}T${bj.hour}`;
const dir = path.join(cwd, 'profiles');
let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
} catch (e) {
  console.error('读不到 profiles:', e.message);
  process.exit(1);
}
const changed = [];
for (const f of files) {
  const chatKey = f.replace(/\.json$/, '').replace('_', ':');
  const data = loadProfiles(cwd, chatKey);
  let dirty = false;
  for (const [uid, p] of Object.entries(data.people || {})) {
    const r = settleHourlyChat(p, bj.key, hourKey);
    if (r.gained > 0) {
      changed.push(`${chatKey}/${uid}: ${r.gained > 0 ? p.favor : ''}`);
      dirty = true;
    }
  }
  if (dirty) saveProfiles(cwd, chatKey, data);
}
console.log(`hourKey=${hourKey} 变化 ${changed.length} 人`);
if (changed.length) console.log(changed.join('\n'));
