import { loadConfig } from '../src/config.mjs';
import { recentDiaries, backtrackDiaries, renderBacktrack, allDiaryKeys } from '../src/diary.mjs';

const cfg = loadConfig();
console.log('=== 全部日记 ===');
console.log(allDiaryKeys(cfg.agentCwd).join(', ') || '（无）');

console.log('\n=== 最近三天（注入用）===');
const list = recentDiaries(cfg.agentCwd, 3);
for (const d of list) {
  console.log(`--- ${d.key}（${d.text.length} 字）---`);
  console.log(d.text.slice(0, 180).replace(/\n/g, ' / '));
}

console.log('\n=== 回溯测试 ===');
const probes = [
  '你还记得前天说的那个事吗',
  '上次你说明天要干嘛来着',
  '2026-10-21 那天我们聊了啥',
  '今天吃什么',
];
for (const p of probes) {
  const r = backtrackDiaries(cfg.agentCwd, p, { days: 3 });
  console.log(`\n> ${p}`);
  console.log(`  hints: ${r.hints.join('、') || '（无）'}  hits: ${r.hits.map((h) => h.key).join(',') || '（无）'}`);
  if (r.hits.length) console.log('  ' + renderBacktrack(r.hits).slice(0, 200).replace(/\n/g, ' / '));
}
