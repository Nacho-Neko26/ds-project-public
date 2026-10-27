import { loadConfig } from '../src/config.mjs';
import { dayKey, readDiary, buildDiaryFor } from '../src/diary.mjs';
import { AgentRunner } from '../src/agent.mjs';

const cfg = loadConfig();
const key = process.argv[2] || dayKey();

const runner = new AgentRunner(cfg);

console.log(`生成 ${key} 的日记…`);
const res = await buildDiaryFor({ runner, cfg, key });
if (!res) {
  console.log('没有素材或生成失败');
  process.exit(1);
}
console.log('--- 落盘内容 ---');
console.log(readDiary(cfg.agentCwd, key));
