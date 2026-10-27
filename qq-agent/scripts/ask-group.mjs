import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const group = Number(process.argv[2] || <GROUP_ID_2>);
const text = process.argv[3] || '机器人，2026年诺贝尔文学奖得主是谁';
const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
function call(action, params) {
  const echo = `n${++seq}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 20000);
    const onMsg = (ev) => {
      let d;
      try { d = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (d.echo !== echo) return;
      clearTimeout(t);
      ws.removeEventListener('message', onMsg);
      resolve(d);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// 用 @ 的方式发（NapCat 支持 at 段）
const self = await call('get_login_info', {});
const selfId = self.data?.user_id;
const r = await call('send_group_msg', {
  group_id: group,
  message: [
    { type: 'at', data: { qq: String(selfId) } },
    { type: 'text', data: { text: ' ' + text } },
  ],
});
console.log('已发送 @ 提问:', JSON.stringify(r.data || r));
ws.close();
