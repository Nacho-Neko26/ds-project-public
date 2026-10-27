import { loadConfig } from '../src/config.mjs';
import { AgentRunner, buildPrompt } from '../src/agent.mjs';
import { HistoryStore } from '../src/context.mjs';

const cfg = loadConfig();
const runner = new AgentRunner(cfg);
const history = new HistoryStore(cfg.dataDir, cfg.raw.context);

const who = Number(process.argv[2] ?? <OWNER_QQ>);
const text = process.argv[3] ?? '在吗，今天怎么这么安静';
const trusted = cfg.trusted.has(who);

const chat = { kind: 'private', title: `私聊 测试用户` };
const now = Date.now();
const prompt = buildPrompt({
  cfg,
  chat,
  sender: { name: '测试用户', uid: who },
  newLines: [`${new Date(now).toTimeString().slice(0, 5)} 测试用户: ${text}`],
  history: history.transcript(`private:${who}`).transcript,
  trusted,
});

console.log('--- prompt ---');
console.log(prompt);
console.log('--- 运行 ---');

const t0 = Date.now();
const useTools = process.argv.includes('--tools');
const r = await runner.run({ prompt, withTools: useTools });
const ms = Date.now() - t0;

if (!r.ok) {
  console.log(`失败 (${ms}ms)`);
  console.log(r.stderr.slice(-2000));
  process.exit(1);
}
console.log(`(${ms}ms)`);
console.log(r.text);
