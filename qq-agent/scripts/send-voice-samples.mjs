/**
 * 把同一段台词的 7 个版本直接发到号主 QQ 私聊，方便在手机上调音量对比。
 * 用 /tmp/voice-demo-v2 里已经渲染好的 jiao-a..g.mp3，不重新合成。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const voiceDir = cfg.raw.voice.dir || '/root/napcat/data/voice';
const SRC = '/tmp/voice-demo-v2';

const legend = [
  '语音样本，按 a→g 发同一场景的 7 个版本：',
  'a 现状（念文字稿，线上原来的读法）',
  'b 只改韵律（还是念文字稿）',
  'c 口语稿 + 韵律',
  'd 口语稿 + 韵律 + 气口/底噪（线上现在是这档）',
  'e 台湾腔晓臻',
  'f 晓晓提亮',
  'g 活泼版晓伊',
  'c/d/g 是晓伊，e/f 换了音色。听完回我字母，比如「d + 晓伊」。',
].join('\n');

const files = [];
for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
  const src = `${SRC}/jiao-${id}.mp3`;
  if (!fs.existsSync(src)) throw new Error(`缺少 ${src}`);
  const dst = `${voiceDir}/sample-jiao-${id}.mp3`;
  fs.copyFileSync(src, dst);
  files.push({ id, path: `/app/voice/sample-jiao-${id}.mp3` });
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
  const echo = `s${++seq}`;
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

const first = await call('send_private_msg', {
  user_id: 100000001,
  message: [{ type: 'text', data: { text: legend } }],
});
console.log('legend', JSON.stringify(first.data || first));

for (const f of files) {
  await new Promise((r) => setTimeout(r, 1200));
  const res = await call('send_private_msg', {
    user_id: 100000001,
    message: [{ type: 'record', data: { file: f.path } }],
  });
  console.log(f.id, JSON.stringify(res.data || res));
}

ws.close();
