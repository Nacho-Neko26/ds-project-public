import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;

const A = await renderBailianVoice(v, { text: '诶……你咋才回啊，我都等半天了诶。', mood: '正常' });
const B = await renderBailianVoice(v, { text: '嗯……都这个点了……你咋还不睡啊，明天起得来吗', mood: '困' });
console.log(JSON.stringify({ A, B }));

const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let seq = 0;
function call(action, params) {
  const echo = `p${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 15000);
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

await call('send_private_msg', {
  user_id: <OWNER_QQ>,
  message: [{ type: 'text', data: { text: '按你说的设好了：日常=融合第 2 条，困=融合第 3 条。两条确认：' } }],
});

for (const [name, out] of [['日常', A], ['困', B]]) {
  await new Promise((r) => setTimeout(r, 1200));
  const file = `/app/voice/${out.file.split('/').pop()}`;
  const res = await call('send_private_msg', {
    user_id: <OWNER_QQ>,
    message: [{ type: 'record', data: { file } }],
  });
  console.log(name, JSON.stringify(res.data || res));
}

ws.close();
