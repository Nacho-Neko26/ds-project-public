/**
 * 端到端：走桥里的 renderBailianVoice，再真发到号主私聊。
 * 用来验证 桥 → 本机 TTS 服务 → 百炼 → SnowLuma 整条链。
 */
import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;

const out = await renderBailianVoice(v, {
  text: '嗯……都这个点了……你咋还不睡啊，明天起得来吗',
  mood: '困',
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
    if (d.echo !== 'bailian-live') return;
    clearTimeout(timer);
    resolve(d);
  });
  ws.send(JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: 100000001, message: [{ type: 'record', data: { file: `/app/voice/${name}` } }] },
    echo: 'bailian-live',
  }));
});
console.log(JSON.stringify(reply, null, 2));
ws.close();
