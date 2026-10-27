/**
 * 白清岚 5 条语气样本发到号主私聊。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const voiceDir = cfg.raw.voice.dir || '/root/napcat/data/voice';

const CLIPS = [
  { id: '1', label: '普通读法' },
  { id: '2', label: '撒娇指令' },
  { id: '3', label: '困指令' },
  { id: '4', label: '标签版（笑）' },
  { id: '5', label: '委屈指令' },
];

const sent = [];
for (const c of CLIPS) {
  const src = `/tmp/baiqinglan/${c.id}-${['plain', 'sajiao', 'kun', 'tags', 'weiqu'][Number(c.id) - 1]}.mp3`;
  if (!fs.existsSync(src)) { console.log('missing', src); continue; }
  const dst = `${voiceDir}/sample-bql-${c.id}.mp3`;
  fs.copyFileSync(src, dst);
  sent.push({ ...c, src, path: `/app/voice/sample-bql-${c.id}.mp3` });
}

const legend = [
  '白清岚（baiqinglan_v3.1）跑出来了，5 条：',
  '1 普通读法',
  '2 指令「用撒娇的语气，慢一点，声音软一点」',
  '3 指令「用很困、有气无力的语气」',
  '4 标签 [excited] + [laughing]',
  '5 指令「用有点委屈、小声埋怨的语气」',
  '1/2/5 是同一句：「诶……你咋才回啊，我都等半天了诶。」',
  '听听哪个语气对，定下来我就接进桥里。',
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
  const echo = `q${++seq}`;
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
  user_id: 100000001,
  message: [{ type: 'text', data: { text: legend } }],
})).data || {}));

for (const c of sent) {
  await new Promise((r) => setTimeout(r, 1200));
  const res = await call('send_private_msg', {
    user_id: 100000001,
    message: [{ type: 'record', data: { file: c.path } }],
  });
  console.log(c.id, c.label, JSON.stringify(res.data || res));
}

ws.close();
