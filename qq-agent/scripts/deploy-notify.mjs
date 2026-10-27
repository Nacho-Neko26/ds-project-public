// 一次性脚本：部署前给号主发「下线升级」通知。用完可删。
// 基础设施（OneBot 端口/token）稳定不变，这里自包含，不依赖 src/config。
import cfg from "../src/config.mjs";
const wsUrl = process.env.ONEBOT_URL || cfg.napcat.wsUrl;
const token = process.env.ONEBOT_TOKEN || cfg.napcat.token;
const target = Number(process.env.QQ_TARGET || <OWNER_QQ>);
const text = process.env.NOTIFY_TEXT || '主人，我要下线升级一下，等会儿回来，可能会有点不一样哦';

const url = new URL(wsUrl);
if (token) url.searchParams.set('access_token', token);

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

const r = await call('send_private_msg', {
  user_id: target,
  message: [{ type: 'text', data: { text } }],
});
console.log('已发出:', JSON.stringify(r.data || r));
ws.close();
