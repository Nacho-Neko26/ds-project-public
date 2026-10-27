/**
 * 本地情绪版样片：同一句话，6 种心情，只改整体语速/音高 + 句尾标点。
 * 渲染完直接发到号主私聊，不碰线上配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { ensureDir } from '../src/util.mjs';
import { renderMoodVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const voiceDir = v.dir || '/root/napcat/data/voice';
const OUT = '/tmp/mood-samples';
ensureDir(OUT);

const LINE = '你怎么才回我啊，我都等半天了。';
const MOODS = ['正常', '高兴', '撒娇', '困', '生气', '被说胖'];

const clips = [];
for (const mood of MOODS) {
  const out = await renderMoodVoice(v, { text: LINE, mood });
  const dst = path.join(voiceDir, `sample-mood-${MOODS.indexOf(mood) + 1}.mp3`);
  fs.copyFileSync(out.file, dst);
  clips.push({ mood, path: `/app/voice/sample-mood-${MOODS.indexOf(mood) + 1}.mp3`, ...out });
  console.log(mood, out.name, `${out.ms}ms`, out.rate, out.pitch, JSON.stringify(out.text));
}

const legend = [
  '本地情绪版，同一句话：',
  `「${LINE}」`,
  '按顺序听：1 正常  2 高兴  3 撒娇  4 困  5 生气  6 低落',
  '只改了整体语速/音高和句尾标点，没有分句拼接、没有加气口。',
  '听完告诉我：哪几个能听出情绪、哪个过头了。',
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
  const echo = `m${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ echo, timeout: true }), 20000);
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

const head = await call('send_private_msg', {
  user_id: 100000001,
  message: [{ type: 'text', data: { text: legend } }],
});
console.log('legend', JSON.stringify(head.data || head));

for (const c of clips) {
  await new Promise((r) => setTimeout(r, 1200));
  const res = await call('send_private_msg', {
    user_id: 100000001,
    message: [{ type: 'record', data: { file: c.path } }],
  });
  console.log(c.mood, JSON.stringify(res.data || res));
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(clips, null, 2), 'utf8');
ws.close();
