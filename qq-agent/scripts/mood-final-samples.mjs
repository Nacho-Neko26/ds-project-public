/**
 * 上线后确认四个情绪点：高兴 / 困 / 生气 / 低落。
 * 走生产配置里的 renderMoodVoice，听到的就是线上会发的。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { renderMoodVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const voiceDir = v.dir || '/root/napcat/data/voice';

const CLIPS = [
  { id: '1', mood: '高兴', text: '诶嘿，你终于来啦！我等你好久哦' },
  { id: '2', mood: '困', text: '嗯……都几点了……你咋还不睡啊' },
  { id: '3', mood: '生气', text: '哼，你再说一遍试试' },
  { id: '4', mood: '被说胖', text: '哦……知道了' },
];

const clips = [];
for (const c of CLIPS) {
  const out = await renderMoodVoice(v, { text: c.text, mood: c.mood });
  const dst = `${voiceDir}/sample-mood2-${c.id}.mp3`;
  fs.copyFileSync(out.file, dst);
  clips.push({ ...c, path: `/app/voice/sample-mood2-${c.id}.mp3`, ...out });
  console.log(c.id, c.mood, out.rate, out.pitch, out.volume, out.text);
}

const legend = [
  '2 号已经是线上默认了（慢 5%、高 5Hz、轻 3%）。',
  '另外四个情绪各配了一档，走的就是线上渲染：',
  '1 高兴  2 困  3 生气  4 低落（被说胖）',
  '听听有没有跑偏，哪个过头了我调回去。',
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
  const echo = `f${++seq}`;
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

for (const c of clips) {
  await new Promise((r) => setTimeout(r, 1200));
  const res = await call('send_private_msg', {
    user_id: 100000001,
    message: [{ type: 'record', data: { file: c.path } }],
  });
  console.log(c.id, JSON.stringify(res.data || res));
}

ws.close();
