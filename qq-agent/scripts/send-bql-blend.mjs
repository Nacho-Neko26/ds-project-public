import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const voiceDir = cfg.raw.voice.dir || '/root/napcat/data/voice';

const LEGEND = [
  '白清岚，日常档融合试了四种指令，同一句：',
  '1 亲近、自然、稍微软一点，语速正常',
  '2 撒娇，但别太夸张、自然一点',
  '3 日常聊天、放松、带一点点撒娇',
  '4 原第 2 条（撒娇、慢、软）作对照',
  '挑一个最像「日常说话」的，我设成默认；困的时候仍用困那档。',
].join('\n');

const clips = [];
for (const id of ['1', '2', '3', '4']) {
  const src = `/tmp/bql-blend/${id}.mp3`;
  if (!fs.existsSync(src)) continue;
  const dst = `${voiceDir}/sample-blend-${id}.mp3`;
  fs.copyFileSync(src, dst);
  clips.push({ id, path: `/app/voice/sample-blend-${id}.mp3` });
}

const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let seq = 0;
function call(action, params) {
  const echo = `z${++seq}`;
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
  message: [{ type: 'text', data: { text: LEGEND } }],
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
