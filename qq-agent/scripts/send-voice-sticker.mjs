/**
 * 群发一条语音 + 一张表情（以机器人身份发）。
 *
 *   node scripts/send-voice-sticker.mjs --text "要说的话" --groups 200000002,200000001
 *        [--emotion sad] [--intensity 0.7] [--scene "…"] [--sticker 15,19]
 *
 * 语音走桥里同一套 renderBailianVoice（百炼 + 情绪标签 + 响度均衡）。
 * 表情用共享图库的下标（S 前缀那条），本地文件转 base64 发，不依赖容器挂载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice, measureFile } from '../src/voice.mjs';
import { readJsonl } from '../src/util.mjs';

/** 极简参数解析：--k v / --k=v / 布尔开关 */
function argv() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (!t.startsWith('--')) { out._.push(t); continue; }
    const key = t.slice(2);
    if (key.includes('=')) { const [k, v] = key.split('='); out[k] = v; continue; }
    if (a[i + 1] && !a[i + 1].startsWith('--')) { out[key] = a[++i]; } else out[key] = true;
  }
  return out;
}

const args = argv();
const cfg = loadConfig();
const v = cfg.raw.voice;
const text = String(args.text || '').trim();
if (!text) { console.error('缺 --text'); process.exit(1); }
const groups = String(args.groups || '').split(',').map((x) => Number(x)).filter(Boolean);
if (!groups.length) { console.error('缺 --groups'); process.exit(1); }

const emotion = args.emotion || 'sad';
const intensity = args.intensity != null ? Number(args.intensity) : 0.7;
const scene = args.scene || '';

console.log(`渲染语音… ${text}`);
const out = await renderBailianVoice(v, { text, mood: '正常', scene, emotion, intensity });
const loud = out.loud || (await measureFile(v, out.file));
const voiceFile = `${v.containerDir || '/app/voice'}/${path.basename(out.file)}`;
console.log(`  合成完成 ${path.basename(out.file)}  ${out.ms}ms  ${loud?.i?.toFixed(1)} LUFS`);

/** 共享图库 */
const SHARED = path.join(cfg.agentCwd, 'stickers', '_shared.jsonl');
const sharedRows = readJsonl(SHARED, 1000);
const stickerIdx = String(args.sticker || '15').split(',').map((x) => Number(x));

/** 本地图 → base64，NapCat 不依赖挂载 */
function stickerSeg(i) {
  const rec = sharedRows[i];
  if (!rec) throw new Error(`共享图库 #${i} 不存在`);
  const local = rec.local;
  if (local && fs.existsSync(local)) {
    const b64 = fs.readFileSync(local).toString('base64');
    return { type: 'image', data: { file: `base64://${b64}`, summary: rec.seg?.data?.summary || '' } };
  }
  const url = rec.seg?.data?.url;
  if (url) return { type: 'image', data: { file: url, summary: rec.seg?.data?.summary || '' } };
  throw new Error(`#${i} 没有可用的本地文件或 URL`);
}

const wsUrl = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) wsUrl.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
  setTimeout(() => reject(new Error('连 NapCat 超时')), 10000);
});

let seq = 0;
function call(action, params) {
  const echo = `s${++seq}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 30000);
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < groups.length; i++) {
  const gid = groups[i];
  const idx = stickerIdx[i] ?? stickerIdx[0];
  const r1 = await call('send_group_msg', { group_id: gid, message: [{ type: 'record', data: { file: voiceFile } }] });
  console.log(`群 ${gid}: 语音 ->`, JSON.stringify(r1.data || r1).slice(0, 100));
  await wait(1500);
  const seg = stickerSeg(idx);
  const r2 = await call('send_group_msg', { group_id: gid, message: [seg] });
  console.log(`群 ${gid}: 表情 #${idx} ->`, JSON.stringify(r2.data || r2).slice(0, 100));
  await wait(1200);
}
ws.close();
console.log('发完。');
