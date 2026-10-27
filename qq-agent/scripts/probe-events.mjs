// 原始事件探针：把 NapCat 推过来的所有事件写到 logs/probe.jsonl，用于排查「消息到了但桥没收到」
// 用法: node scripts/probe-events.mjs [秒数]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { log } from '../src/util.mjs';

const cfg = loadConfig();
const seconds = Number(process.argv[2] ?? 120);
const out = path.join(cfg.logDir, 'probe.jsonl');

const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);

const ws = new WebSocket(url);
let count = 0;

ws.addEventListener('open', () => log('info', `探针已连接，监听 ${seconds}s → ${out}`));
ws.addEventListener('message', (ev) => {
  const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
  count++;
  const line = JSON.stringify({ at: new Date().toISOString(), raw });
  fs.appendFileSync(out, line + '\n');
  try {
    const d = JSON.parse(raw);
    if (d.post_type === 'message') {
      log('info', `消息事件: ${d.message_type} from ${d.user_id} chat ${d.group_id ?? '-'} -> ${JSON.stringify(d.message).slice(0, 120)}`);
    } else if (d.post_type !== 'meta_event') {
      log('debug', `事件: ${d.post_type})`);
    }
  } catch { /* ignore */ }
});
ws.addEventListener('error', (e) => log('warn', `探针连接出错: ${e?.message}`));

setTimeout(() => {
  log('info', `探针结束，共收到 ${count} 个包`);
  try { ws.close(); } catch { /* ignore */ }
  process.exit(0);
}, seconds * 1000);
