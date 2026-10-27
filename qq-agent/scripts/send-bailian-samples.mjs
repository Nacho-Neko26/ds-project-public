/**
 * 把百炼试出来的几条发到号主私聊。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const voiceDir = cfg.raw.voice.dir || '/root/napcat/data/voice';

const CLIPS = [
  { id: '1', src: '/tmp/qwen-tts/q1-plain.mp3', label: 'Qwen 普通' },
  { id: '2', src: '/tmp/qwen-tts/q2-sajiao.mp3', label: 'Qwen 撒娇指令' },
  { id: '3', src: '/tmp/qwen-tts/q4-kun.mp3', label: 'Qwen 困指令' },
  { id: '4', src: '/tmp/qwen-tts/q3-tags.mp3', label: 'Qwen 标签版（笑）' },
  { id: '5', src: '/tmp/cosy-probe/v2-miao.mp3', label: 'CosyVoice longmiao' },
];

const sent = [];
for (const c of CLIPS) {
  if (!fs.existsSync(c.src)) { console.log('missing', c.src); continue; }
  const dst = `${voiceDir}/sample-bailian-${c.id}.mp3`;
  fs.copyFileSync(c.src, dst);
  sent.push({ ...c, path: `/app/voice/sample-bailian-${c.id}.mp3` });
}

const legend = [
  '百炼接通了，先听 5 条：',
  '1 Qwen 普通读法',
  '2 Qwen + 指令「用撒娇的语气，慢一点，声音软一点」',
  '3 Qwen + 指令「用很困、有气无力的语气」',
  '4 Qwen + 标签 [excited]…[laughing]（带笑声）',
  '5 CosyVoice longmiao，换个音色对比',
  '前三句是同一句：「诶……你咋才回啊，我都等半天了诶。」',
  '听听哪个语气活、哪个音色合适；定下来我就接进桥里。',
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
  const echo = `b${++seq}`;
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
