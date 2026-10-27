/**
 * 上线自检：NapCat 登录后，确认 OneBot 通道真的能用。
 *
 *   node scripts/online-selftest.mjs          # 查登录态 / 账号 / 状态
 *   node scripts/online-selftest.mjs --send   # 再给指定 QQ 发一条测试消息
 *
 * 注意：这只能证明「机器人能往外发」。
 * 「机器人能收到并回复」得由真人在 QQ 里发一句，再看桥日志有没有跑到 agent。
 */
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);

const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
  setTimeout(() => reject(new Error('连 NapCat 超时')), 10000);
});

let seq = 0;
function call(action, params) {
  const echo = `t${++seq}`;
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

const login = await call('get_login_info', {});
console.log('登录:', JSON.stringify(login.data || login));

const status = await call('get_status', {});
console.log('状态:', JSON.stringify(status.data || status));

const target = Number(process.env.QQ_TARGET || 100000001);
if (process.argv.includes('--send')) {
  const r = await call('send_private_msg', {
    user_id: target,
    message: [{ type: 'text', data: { text: '上线自检：通道正常 ✓' } }],
  });
  console.log('测试消息已发出:', JSON.stringify(r.data || r));
}

ws.close();
