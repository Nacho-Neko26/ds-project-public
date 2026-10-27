/**
 * 在 3 撒娇 和 4 困 之间取三个点，发到号主私聊听。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { renderTunedVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const voiceDir = v.dir || '/root/napcat/data/voice';

const TEXT = '你怎么才回我啊……我都等半天了～';
const POINTS = [
  { id: 'A', label: '偏撒娇', rateOffset: -5, pitchOffset: 5, volumeOffset: -3 },
  { id: 'B', label: '正中', rateOffset: -8, pitchOffset: 0, volumeOffset: -5 },
  { id: 'C', label: '偏困', rateOffset: -11, pitchOffset: -5, volumeOffset: -7 },
];

const clips = [];
for (const p of POINTS) {
  const out = await renderTunedVoice(v, {
    text: TEXT,
    rateOffset: p.rateOffset,
    pitchOffset: p.pitchOffset,
    volumeOffset: p.volumeOffset,
  });
  const dst = `${voiceDir}/sample-mid-${p.id}.mp3`;
  fs.copyFileSync(out.file, dst);
  clips.push({ ...p, path: `/app/voice/sample-mid-${p.id}.mp3`, ms: out.ms });
  console.log(p.id, p.label, out.rate, out.pitch, out.volume, `${out.ms}ms`);
}

const legend = [
  '3 和 4 中间取了三个点，同一句话：',
  `「${TEXT}」`,
  'A 偏撒娇（-5% / +5Hz）',
  'B 正中（-8% / 0Hz）',
  'C 偏困（-11% / -5Hz）',
  '句尾都是「……～」。听完说 A/B/C，或者「再往 3 靠一点」。',
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
  const echo = `t${++seq}`;
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
