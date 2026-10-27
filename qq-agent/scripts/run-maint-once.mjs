// 一次性补跑：好感日结 + 写 maint-state.json
// 用法：node /root/qq-agent/scripts/run-maint-once.mjs [--backfill]
//   默认：按 prevDayChatted / dayChatted 结算（正常路径）
//   --backfill：早先一次旧代码的 rollDay 把 dayChatted 清空了，用 lastSeenAt 在 36 小时内
//               的人补一次 +5
import fs from 'node:fs';
import path from 'node:path';
import { loadProfiles, saveProfiles } from '../src/anger.mjs';
import { settleDailyChat, applyFavor, beijingNow } from '../src/favor.mjs';

const root = '/root/qq-agent/workspace';  // 与 cfg.agentCwd 一致：profiles/ 和 maint-state.json 都在它下面
const backfill = process.argv.includes('--backfill');
const bj = beijingNow();
const dir = path.join(root, 'profiles');
const out = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const chatKey = f.replace(/\.json$/, '');
  const pr = loadProfiles(root, chatKey);
  let changed = false;
  for (const p of Object.values(pr.people)) {
    if (backfill) {
      if (p.settledDayKey === bj.key) continue;
      const raw = p.lastSeenAt;
      const seen = typeof raw === 'number' ? raw : (Date.parse(raw || '') || 0);
      if (!seen || Date.now() - seen > 36 * 3600 * 1000) continue;
      p.settledDayKey = bj.key;
      const r = applyFavor(p, 5, { dayKey: bj.key });
      if (r.applied) { changed = true; out.push(`${chatKey} ${p.displayName} 补 ${r.applied}（${r.before}→${r.after}）`); }
    } else {
      const r = settleDailyChat(p, bj.key);
      if (r.gained) { changed = true; out.push(`${chatKey} ${p.displayName} 日结 +${r.gained}`); }
    }
  }
  if (changed) saveProfiles(root, chatKey, pr);
}
fs.writeFileSync(path.join(root, 'maint-state.json'), JSON.stringify({ lastMaintDay: bj.key }), 'utf8');
console.log(out.length ? out.join('\n') : '没有任何人满足 +5 条件');
console.log('maint-state.json lastMaintDay =', bj.key);
