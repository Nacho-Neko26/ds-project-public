/**
 * 群聊语音实战测试：真的让机器人在群里跑一轮 agent，产出语音并让它发出去。
 *
 *   node scripts/group-voice-live.mjs "要说的话" [群号]
 *
 * 注意：发的是「作为你本人」的群消息（OneBot send_group_msg），
 * 机器人会把它当成真实用户消息处理——这就是在生产里验证「收到 → agent → 语音」。
 */
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const text = process.argv[2] || '测试';
const group = Number(process.argv[3] || <GROUP_ID_2>);

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
  const echo = `g${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 20000);
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

// 先确认群存在且机器人是群成员
const info = await call('get_group_info', { group_id: group });
console.log('群:', JSON.stringify(info.data || info).slice(0, 200));

const res = await call('send_group_msg', {
  group_id: group,
  message: `${text}`,
});
console.log('已发到群:', JSON.stringify(res.data || res));

ws.close();
