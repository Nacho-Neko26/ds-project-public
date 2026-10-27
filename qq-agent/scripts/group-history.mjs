import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const group = Number(process.argv[2] || <GROUP_ID_2>);
const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
function call(action, params) {
  const echo = `h${++seq}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 15000);
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
const h = await call('get_group_msg_history', { group_id: group, count: 6 });
const msgs = h.data?.messages || [];
for (const m of msgs) {
  const segs = (m.message || []).map((s) => {
    if (s.type === 'record') return `[语音 ${s.data?.file || ''}]`;
    if (s.type === 'text') return s.data?.text || '';
    return `[${s.type}]`;
  }).join('');
  const sec = Number(m.msg_seq ?? 0);
  console.log(`${m.sender?.card || m.sender?.nickname || m.user_id} (id=${m.message_id} seq=${sec}): ${segs.slice(0, 80)}`);
}
ws.close();
