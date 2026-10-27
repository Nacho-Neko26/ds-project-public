/**
 * 强制语音实战：让机器人在群里「必须发一条语音」。
 *
 * 模型自己决定发不发语音（这次它选了打字/沉默），所以这里绕过 agent：
 * 用桥里同一套渲染函数合成语音，再作为机器人自己发到群里。
 *
 *   node scripts/group-voice-force.mjs "要说的话" [群号]
 *
 * 可选环境变量：
 *   EMOTION=happy|sad|surprised|gentle|calm|confused|encouraging|sleepy|soft
 *   INTENSITY=0.6   SCENE="凌晨一点，窝在被窝里"
 */
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice, measureFile } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const text = process.argv[2] || '诶……说好的饭呢，我可是一直在等你哦';
const group = Number(process.argv[3] || 200000002);
const emotion = process.env.EMOTION || 'gentle';
const intensity = Number(process.env.INTENSITY || 0.6);
const scene = process.env.SCENE || '饭桌前等饭，饿得有点委屈';

console.log('渲染中…');
const out = await renderBailianVoice(v, { text, mood: '正常', scene, emotion, intensity });
const loud = out.loud || (await measureFile(v, out.file));
console.log(`合成完成 ${path.basename(out.file)}  ${out.ms}ms  ${loud?.i?.toFixed(1)} LUFS  ${loud?.tp?.toFixed(1)} dBTP`);

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
  const echo = `v${++seq}`;
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

const file = `${v.containerDir || '/app/voice'}/${path.basename(out.file)}`;
console.log('发送 record:', file);
const r = await call('send_group_msg', { group_id: group, message: [{ type: 'record', data: { file } }] });
console.log('结果:', JSON.stringify(r.data || r));
ws.close();
