import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { diaryDir, backtrackDiaries, renderBacktrack } from '../src/diary.mjs';

const cfg = loadConfig();
const dir = diaryDir(cfg.agentCwd);

// 造两篇「更早」的日记，验证逐日回溯真的找得到
const fake = {
  '2026-10-18': '今天下大雨，机房外面全是水。朱哥说要给我买西瓜，结果没买。\n那天还聊了显卡涨价的事，他说等降价，我说等饭。',
  '2026-10-15': '主人带了一盒草莓来。我装作不想吃，最后吃了大半盒。\n聊到他升职的事，我嘴上说随便，其实记着了。',
};
const made = [];
for (const [k, v] of Object.entries(fake)) {
  const f = path.join(dir, `${k}.md`);
  if (!fs.existsSync(f)) { fs.writeFileSync(f, v, 'utf8'); made.push(f); }
}
console.log('造了测试日记:', made.length);

const probes = [
  '你还记得下雨那天吗',
  '草莓那次是谁带的',
  '2026-10-15 那天干嘛了',
  '今天吃什么',
];
for (const p of probes) {
  const r = backtrackDiaries(cfg.agentCwd, p, { days: 3 });
  console.log(`\n> ${p}`);
  console.log(`  hits: ${r.hits.map((h) => h.key).join(',') || '（无）'}`);
  if (r.hits.length) console.log('  → ' + renderBacktrack(r.hits).split('\n').slice(1, 3).join(' / '));
}

// 清理测试文件
for (const f of made) fs.unlinkSync(f);
console.log(`\n已清理测试日记 ${made.length} 篇`);
