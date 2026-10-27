// 用法:
//   node scripts/obcall.mjs get_friend_list
//   node scripts/obcall.mjs send_private_msg @params.json
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const [action, paramsArg] = process.argv.slice(2);
if (!action) {
  console.log('用法: node scripts/obcall.mjs <action> [@params.json | JSON]');
  process.exit(1);
}

let params = {};
if (paramsArg) {
  const raw = paramsArg.startsWith('@')
    ? fs.readFileSync(paramsArg.slice(1), 'utf8')
    : paramsArg;
  params = JSON.parse(raw.replace(/^\uFEFF/, ''));
}

const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);

const timer = setTimeout(() => { console.log('超时'); process.exit(1); }, 20000);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ action, params, echo: 'x' }));
});

ws.addEventListener('message', (ev) => {
  let data;
  try {
    data = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
  } catch {
    return; // 事件或其他非 JSON 分片，忽略
  }
  if (data.echo !== 'x') return;
  clearTimeout(timer);
  const out = JSON.stringify(data, null, 2);
  console.log(process.env.QB_FULL === '1' ? out : out.slice(0, 12000));
  ws.close();
  process.exit(0);
});

ws.addEventListener('error', (e) => { clearTimeout(timer); console.log('连接失败:', e?.message); process.exit(1); });
