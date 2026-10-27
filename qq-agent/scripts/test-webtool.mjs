import { loadConfig } from '../src/config.mjs';
import { AgentRunner } from '../src/agent.mjs';

const cfg = loadConfig();
const runner = new AgentRunner(cfg);

const q = process.argv[2] || '杭州现在几度，天气怎么样';
console.log('问：', q, '\n');

const t0 = Date.now();
const r = await runner.run({
  prompt: `用工具查一下再回答，简短说一两句，口语。\n问题：${q}`,
  toolMode: 'web',
});
console.log(`耗时 ${Date.now() - t0}ms  ok=${r.ok}`);
console.log('答：', (r.text || '').slice(0, 400));
if (!r.ok) console.log('stderr:', String(r.stderr || '').slice(-500));
