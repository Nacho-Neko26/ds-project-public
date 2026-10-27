import { loadConfig } from '../src/config.mjs';
import { AgentRunner } from '../src/agent.mjs';

const cfg = loadConfig();
const runner = new AgentRunner(cfg);
const q = process.argv[2] || '2026年诺贝尔文学奖得主是谁，别说不知道';

// 复刻桥里那段 toolRule，看模型会不会按规矩输出 __NEED_WEB__
const rule = '（这轮你**没有联网**。遇到答不上来的知识类问题（具体数据、某地某事、新闻、天气、定义、'
  + '不是你我之间的事），**别猜**——只输出一行：__NEED_WEB__ 查询关键词。'
  + '在那之前可以先用一句话稳住对方，比如「你在此地勿要走动，我去查查便回来」。'
  + '程序会去查，然后把准确答案给你发出去。要是不需要查，就正常聊天。）';

const prompt = [
  '【场景】群聊「测试群」（群里还有别人）',
  '【新消息】\n18:30 【阮沐の机器人】' + q,
  '（按你的人设回这条消息：只输出要发出去的正文。）',
  rule,
].join('\n\n');

const r = await runner.run({ prompt, toolMode: 'none' });
console.log('--- 第一轮（无工具）---');
console.log(r.text);

const m = String(r.text || '').match(/__NEED_WEB__\s*(.+)/);
if (!m) { console.log('\n没触发联网（模型选择直接答或不答）'); process.exit(0); }

const query = m[1].split('|')[0].trim();
console.log('\n--- 识别到查询: ' + query + ' ---');
const web = await runner.run({
  prompt: `先用 web 搜索查清楚再简短回答，口语，一两句。\n问题：${query}`,
  toolMode: 'web',
});
console.log('--- 第二轮（联网）---');
console.log(web.text);
