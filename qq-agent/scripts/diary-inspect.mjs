import { loadConfig } from '../src/config.mjs';
import { collectDayPeople, renderPeopleSection, dayKey, readDiary, latestDiary } from '../src/diary.mjs';
import { loadProfiles } from '../src/anger.mjs';

const cfg = loadConfig();
const key = process.argv[2] || dayKey();
const people = collectDayPeople({ dataDir: cfg.dataDir, agentCwd: cfg.agentCwd, key, cfg });

console.log(`=== ${key} 说过话的人：${people.length} ===`);
console.log(renderPeopleSection(people));

for (const chatKey of new Set(people.map((p) => p.chatKey))) {
  const pr = loadProfiles(cfg.agentCwd, chatKey);
  console.log(`\n--- 档案 ${chatKey} ---`);
  for (const p of Object.values(pr.people)) {
    console.log(`${p.displayName}  叫他:${p.nickFor}  亲密度:${p.intimacy}/5  怒气:Lv${p.angerLv ?? 0}  ${p.offenseCount ? JSON.stringify(p.offenseCount) : ''}`);
  }
}

const d = readDiary(cfg.agentCwd, key);
console.log(`\n=== 今天日记 ${d ? '已存在' : '还没有'} ===`);
if (d) console.log(d.slice(0, 600));
const last = latestDiary(cfg.agentCwd);
console.log(`\n最近一篇: ${last?.key || '无'}`);
