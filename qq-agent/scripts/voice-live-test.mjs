/**
 * 端到端试一条：用生产配置渲染，再经 OneBot 真发到号主私聊。
 * 只用来验证 NapCat 能不能吃新管线产出的 mp3。
 */
import { loadConfig } from '../src/config.mjs';
import { renderVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const out = await renderVoice(v, {
  text: '喂喂，听得到吗？这是我新学的说话方式，你听听像不像真的。',
  style: v.style || 'natural',
  mood: '正常',
});
console.log(JSON.stringify(out));

const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

const name = out.file.split('/').pop();
const reply = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timeout: true }), 15000);
  ws.addEventListener('message', (ev) => {
    let d;
    try {
      d = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch { return; }
    if (d.echo !== 'voice-live') return;
    clearTimeout(timer);
    resolve(d);
  });
  ws.send(JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: 100000001, message: [{ type: 'record', data: { file: `/app/voice/${name}` } }] },
    echo: 'voice-live',
  }));
});
console.log(JSON.stringify(reply, null, 2));
ws.close();
