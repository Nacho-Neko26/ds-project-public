/**
 * 语境化 TTS 样片对比：同一条稿子，不带场景 vs 带场景，各渲染一遍。
 * 跑完把每条的 instruction 打出来，方便核对拼接结果。
 *
 *   node scripts/voice-scene-samples.mjs            # 只渲染，打印指令
 *   node scripts/voice-scene-samples.mjs --send     # 再发到指定 QQ（默认 <OWNER_QQ>）
 */
import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice, composeInstruction } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const conf = v.bailian ?? {};

const CASES = [
  {
    name: 'A 深夜困',
    mood: '困',
    text: '嗯……都这个点了……你咋还不睡啊，明天起得来吗',
    scene: '凌晨一点窝在被窝里，手机举在脸前，困到眼皮打架；困到有点黏；半睡半醒压着嗓子的气声；「嗯」和「这个点」后面各停一下',
  },
  {
    name: 'B 刚醒撒娇',
    mood: '被夸',
    text: '诶……你一大早就夸我……那我还怎么好意思凶你啊',
    scene: '早上刚醒，头发乱着靠在枕头上；被夸得开心又有点害羞；带一点刚睡醒的鼻音；「诶」拖长一点再往下',
  },
  {
    name: 'C 饭点饿',
    mood: '正常',
    text: '你听……我肚子在叫哦……今天吃啥呀，我想吃鱼',
    scene: '中午坐在饭桌前还没上菜，手撑着下巴；饿得有点委屈；没有气声；「听」后面停一下卖关子',
  },
  {
    name: 'D 加班路上',
    mood: '正常',
    text: '啊……刚下班……地铁上人挤得我脚都悬空了诶',
    scene: '晚上九点在地铁里，一手扶手一手打字，周围吵；累但还想聊；喘口气再说话；「啊」后面长吸气',
  },
];

const rows = [];
for (const c of CASES) {
  // 基线：不加场景（等于现在的效果）
  const base = await renderBailianVoice(v, { text: c.text, mood: c.mood });
  // 语境版
  const withScene = await renderBailianVoice(v, { text: c.text, mood: c.mood, scene: c.scene });
  const ins = composeInstruction({ ...conf, _text: c.text }, c.mood, c.scene);
  console.log(`[${c.name}]`);
  console.log(`  基线   ${base.file.split('/').pop()}`);
  console.log(`  语境   ${withScene.file.split('/').pop()}`);
  console.log(`  指令   ${ins}`);
  rows.push({ name: c.name, base, withScene });
}

if (!process.argv.includes('--send')) {
  console.log('\n加 --send 才会真发 QQ。');
  process.exit(0);
}

// —— 发到一个私聊里对比听 ——
const target = Number(process.env.QQ_TARGET || <OWNER_QQ>);
const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let seq = 0;
function call(action, params) {
  const echo = `q${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 15000);
    const onMsg = (ev) => {
      let d;
      try {
        d = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch { return; }
      if (d.echo !== echo) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      resolve(d);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (o) => `/app/voice/${o.file.split('/').pop()}`;

await call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: '语境 TTS 对比：每组先发「不加场景」，再发「加场景」' } }] });
for (const r of rows) {
  await wait(900);
  await call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: `${r.name} · 不加场景` } }] });
  await wait(900);
  await call('send_private_msg', { user_id: target, message: [{ type: 'record', data: { file: fileOf(r.base) } }] });
  await wait(900);
  await call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: `${r.name} · 加场景` } }] });
  await wait(900);
  await call('send_private_msg', { user_id: target, message: [{ type: 'record', data: { file: fileOf(r.withScene) } }] });
}
ws.close();
console.log('发完了。');
