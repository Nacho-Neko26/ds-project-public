/**
 * 「板正」拆成两个变量试：文本口语度 × 语速。
 * 4 条发到号主私聊。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { renderTunedVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const voiceDir = v.dir || '/root/napcat/data/voice';

const T0 = '你怎么才回我啊……我都等半天了～';
const T1 = '诶……你咋才回啊，我都等半天了诶。';

const A = { rateOffset: -5, pitchOffset: 5, volumeOffset: -3 };
const F = { rateOffset: 9, pitchOffset: 1, volumeOffset: 2 };

const CLIPS = [
  { id: '1', label: '原文 + A（慢软）', text: T0, tune: A },
  { id: '2', label: '口语文本 + A（慢软）', text: T1, tune: A },
  { id: '3', label: '原文 + F（快轻）', text: T0, tune: F },
  { id: '4', label: '口语文本 + F（快轻）', text: T1, tune: F },
];

const clips = [];
for (const c of CLIPS) {
  const out = await renderTunedVoice(v, { text: c.text, ...c.tune });
  const dst = `${voiceDir}/sample-live-${c.id}.mp3`;
  fs.copyFileSync(out.file, dst);
  clips.push({ ...c, path: `/app/voice/sample-live-${c.id}.mp3`, ms: out.ms });
  console.log(c.id, out.rate, out.pitch, out.volume, `${out.ms}ms`);
}

const legend = [
  '把「板正」拆成两个变量再试一次，4 条：',
  '1 原文 + A 参数（慢一点、高一点）',
  '2 更口语的文本 + A 参数',
  '3 原文 + F 参数（快 9%、几乎不抬音高）',
  '4 更口语的文本 + F 参数',
  '原文：你怎么才回我啊……我都等半天了～',
  '口语文本：诶……你咋才回啊，我都等半天了诶。',
  '听完告诉我哪条最不板正；如果四条都还板，那就是 edge 的天花板，得换模型了。',
].join('\n');

const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let seq = 0;
function call(action, params) {
  const echo = `l${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 20000);
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

console.log('legend', JSON.stringify((await call('send_private_msg', {
  user_id: <OWNER_QQ>,
  message: [{ type: 'text', data: { text: legend } }],
})).data || {}));

for (const c of clips) {
  await new Promise((r) => setTimeout(r, 1200));
  const res = await call('send_private_msg', {
    user_id: <OWNER_QQ>,
    message: [{ type: 'record', data: { file: c.path } }],
  });
  console.log(c.id, JSON.stringify(res.data || res));
}

ws.close();
