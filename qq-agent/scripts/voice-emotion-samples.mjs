/**
 * 情绪 + SSML 样片：按用户给的规范写「模型该产出的样子」，走真实渲染链路发 QQ。
 *
 *   node scripts/voice-emotion-samples.mjs          # 只渲染
 *   node scripts/voice-emotion-samples.mjs --send   # 发 QQ
 *
 * 每条都按规范来：12~20 字一句、<emphasis> 标一个重音词、
 * 关键信息前 <break time="0.4s"/>、带 emotion/intensity。
 */
import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice, measureFile } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;

const CASES = [
  {
    name: 'A 开心（对方逗她）',
    emotion: 'happy', intensity: 0.7,
    scene: '晚上在电脑前，被人夸得笑起来',
    text: '诶你居然记着<emphasis>我爱吃鱼</emphasis>啊<break time="0.4s"/>行吧，那我不闹你了',
  },
  {
    name: 'B 温柔（对方说累）',
    emotion: 'gentle', intensity: 0.6,
    scene: '夜里十一点，台灯下，声音放软',
    text: '嗯<emphasis>我听着呢</emphasis><break time="0.4s"/>你不用急着回我，先把手上的事弄完',
  },
  {
    name: 'C 困（深夜）',
    emotion: 'sleepy', intensity: 0.8,
    scene: '凌晨一点，缩在被窝里，眼睛快闭上了',
    text: '都这个点了<break time="0.4s"/>你咋还不睡啊<emphasis>明天起得来吗</emphasis>',
  },
  {
    name: 'D 沉稳（问复杂问题）',
    emotion: 'calm', intensity: 0.6,
    scene: '白天坐在桌前，认真回答问题',
    text: '这个得分两步<break time="0.4s"/>先说<emphasis>最要紧的那件事</emphasis>，剩下的我慢慢跟你讲',
  },
  {
    name: 'E 疑惑（没听懂）',
    emotion: 'confused', intensity: 0.6,
    scene: '歪着头看手机，没反应过来',
    text: '诶<emphasis>你刚说啥</emphasis><break time="0.4s"/>我没太听明白，再说一遍呗',
  },
];

const rows = [];
for (const c of CASES) {
  const out = await renderBailianVoice(v, {
    text: c.text, mood: '正常', scene: c.scene, emotion: c.emotion, intensity: c.intensity,
  });
  const loud = out.loud || (await measureFile(v, out.file));
  rows.push({ ...c, out, loud });
  console.log(`[${c.name}] ${out.file.split('/').pop()}  ${loud?.i?.toFixed(1)} LUFS / ${out.ms}ms`);
}

if (!process.argv.includes('--send')) {
  console.log('\n加 --send 才发 QQ。');
  process.exit(0);
}

const target = Number(process.env.QQ_TARGET || 100000001);
const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let seq = 0;
function call(action, params) {
  const echo = `s${++seq}`;
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

await call('send_private_msg', {
  user_id: target,
  message: [{ type: 'text', data: { text: '新版：情绪标签 + <emphasis> 重音 + <break> 真停顿，语速 0.88' } }],
});
for (const r of rows) {
  await wait(800);
  await call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: r.name } }] });
  await wait(800);
  await call('send_private_msg', {
    user_id: target,
    message: [{ type: 'record', data: { file: `/app/voice/${r.out.file.split('/').pop()}` } }],
  });
}
ws.close();
console.log('发完了。');
