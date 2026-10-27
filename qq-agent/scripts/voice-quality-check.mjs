/**
 * 语音质量体检：渲染 -> 量指标 -> 出报告。
 *
 *   node scripts/voice-quality-check.mjs            # 只量，打印报告
 *   node scripts/voice-quality-check.mjs --send     # 再把样片发到 QQ
 *
 * 回答五个问题：情绪变化 / 重音停顿 / 是否匀速同音调 / 文本口语化 / 降噪与响度。
 * 硬指标：响度(i/lra/tp)、音高曲线(中位数/起伏/区间占比)、语速(每秒字档数)、
 *        静音占比与停顿次数。文本类指标靠规则粗判，只作参考。
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { renderBailianVoice, pitchCurve, measureFile, composeInstruction } from '../src/voice.mjs';

const cfg = loadConfig();
const v = cfg.raw.voice;
const conf = v.bailian ?? {};

// 一篇稿子读两遍：一遍说得很平，一遍带情绪起伏——比「有没有变化」更直观
const CASES = [
  {
    name: '1 深夜困',
    mood: '困',
    scene: '凌晨一点窝在被窝里，手机举在脸前，困到眼皮打架；困得黏糊糊；压着嗓子的气声；「嗯」「这个点」后面各停一下',
    text: '嗯……都这个点了……你咋还不睡啊，明天起得来吗',
  },
  {
    name: '2 刚醒被夸',
    mood: '被夸',
    scene: '早上刚醒，头发乱着靠在枕头上；被夸得开心又有点害羞；带刚睡醒的鼻音；「诶」拖长一点再往下',
    text: '诶……你一大早就夸我……那我还怎么好意思凶你啊',
  },
  {
    name: '3 饭点饿',
    mood: '正常',
    scene: '中午坐在饭桌前还没上菜，手撑着下巴；饿得有点委屈；没有气声；「听」后面停一下卖关子',
    text: '你听……我肚子在叫哦……今天吃啥呀，我想吃鱼',
  },
  {
    name: '4 加班地铁',
    mood: '正常',
    scene: '晚上九点在地铁里，一手扶手一手打字，周围吵；累但还想聊；喘口气再说话；「啊」后面长吸气',
    text: '啊……刚下班……地铁上人挤得我脚都悬空了诶',
  },
  {
    name: '5 平读对照（不带场景、不带起伏指令）',
    mood: '正常',
    flat: true,
    scene: '',
    text: '嗯……都这个点了……你咋还不睡啊，明天起得来吗',
  },
];

/** 口语化粗判：书面词表 + 句长 */
const BOOKISH = /(因此|然而|并且|已经|非常|十分|进行|由于|以便|是否|倘若|并且|以及|目前|此外|另外|似乎|应该|需要|请)/g;
const FILLER = /(诶|咋|啥|嘛|呗|啦|哦|啊|呀|呢|吧|唉|嗯)/g;

function analyze(curve, text) {
  const { f0, rms, hop_s } = curve;
  const voiced = f0.filter((f) => f > 0);
  const sorted = [...voiced].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const low = median * 0.8;
  const high = median * 1.2;
  const inBand = voiced.length ? voiced.filter((f) => f >= low && f <= high).length / voiced.length : 1;
  const p10 = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  // 相邻浊音帧的跳变（半音），衡量「是不是一根直线」
  const semi = (a, b) => 12 * Math.log2(b / a);
  const jumps = [];
  for (let i = 1; i < f0.length; i++) {
    if (f0[i] > 0 && f0[i - 1] > 0) jumps.push(Math.abs(semi(f0[i - 1], f0[i])));
  }
  jumps.sort((a, b) => a - b);
  const jitter = jumps.length ? jumps[Math.floor(jumps.length / 2)] : 0;
  // 语速：浊音帧占比 ≈ 说话时间；字档数/秒
  const voicedFrames = f0.filter((f) => f > 0).length;
  const voicedSec = voicedFrames * hop_s;
  const chars = text.replace(/[^\u4e00-\u9fa5]/g, '').length;
  // 停顿：连续静音 >= 180ms 算一次
  let pauses = 0;
  let silentRun = 0;
  const minRun = Math.round(0.18 / hop_s);
  for (const r of rms) {
    if (r < 0.004) { silentRun++; } else { if (silentRun >= minRun) pauses++; silentRun = 0; }
  }
  if (silentRun >= minRun) pauses++;
  return {
    medianHz: Math.round(median),
    p10: Math.round(p10), p90: Math.round(p90),
    rangeSemitones: p10 && p90 ? +(semi(p10, p90)).toFixed(1) : 0,
    inBand: +(inBand * 100).toFixed(0),
    jitterSemitones: +jitter.toFixed(2),
    charsPerSec: voicedSec ? +(chars / voicedSec).toFixed(1) : 0,
    pauses,
  };
}

function textCheck(text) {
  const chars = text.replace(/[^\u4e00-\u9fa5]/g, '').length;
  const sents = text.split(/[，。！？…]+/).filter((x) => x.trim());
  const avgLen = sents.length ? +(chars / sents.length).toFixed(1) : chars;
  const bookish = (text.match(BOOKISH) || []).length;
  const filler = (text.match(FILLER) || []).length;
  return { chars, sentAvg: avgLen, bookish, filler, ellipsis: /……|…/.test(text) };
}

const rows = [];
for (const c of CASES) {
  const flatConf = c.flat ? { ...conf, instructions: { ...conf.instructions }, defaultInstruction: '', emphasis: false, vary: false } : conf;
  const local = { ...v, bailian: flatConf };
  const out = await renderBailianVoice(local, { text: c.text, mood: c.mood, scene: c.scene });
  const curve = await pitchCurve(v, out.file);
  const m = analyze(curve, c.text);
  const loud = out.loud || (await measureFile(v, out.file)) || {};
  const t = textCheck(c.text);
  rows.push({ c, out, m, loud, t });
  console.log(`\n[${c.name}] ${out.file.split('/').pop()}`);
  console.log(`  响度 ${loud.i?.toFixed(1)} LUFS  动态 ${loud.lra?.toFixed(1)} LU  峰值 ${loud.tp?.toFixed(1)} dBTP`);
  console.log(`  音高 中位 ${m.medianHz}Hz  P10-P90 ${m.p10}-${m.p90}Hz(${m.rangeSemitones}半音)  中心带占比 ${m.inBand}%  逐帧抖动 ${m.jitterSemitones}半音`);
  console.log(`  语速 ${m.charsPerSec} 字/秒  停顿 ${m.pauses} 次  文本 ${t.chars}字 / 均 ${t.sentAvg} 字一句 / 书面词 ${t.bookish} / 语气词 ${t.filler} / 省略号 ${t.ellipsis}`);
  console.log(`  指令 ${composeInstruction({ ...flatConf, _text: c.text }, c.mood, c.scene)}`);
}

// 汇总：语境版 vs 平读对照
const scene = rows.filter((r) => !r.c.flat);
const flat = rows.find((r) => r.c.flat);
const avg = (k, f = (r) => r) => (scene.reduce((s, r) => s + f(r)[k], 0) / scene.length);
console.log('\n=== 汇总（4 条语境版 vs 平读对照）===');
console.log(`音高区间      语境 ${avg('rangeSemitones', (r) => r.m).toFixed(1)} 半音   平读 ${flat.m.rangeSemitones} 半音`);
console.log(`中心带占比    语境 ${avg('inBand', (r) => r.m).toFixed(0)}%        平读 ${flat.m.inBand}%`);
console.log(`逐帧抖动      语境 ${avg('jitterSemitones', (r) => r.m).toFixed(2)}        平读 ${flat.m.jitterSemitones}`);
console.log(`停顿次数      语境 ${avg('pauses', (r) => r.m).toFixed(1)} 次        平读 ${flat.m.pauses} 次`);
console.log(`动态(LRA)     语境 ${avg('lra', (r) => r.loud).toFixed(1)} LU        平读 ${flat.loud.lra?.toFixed(1)} LU`);
console.log(`响度          语境 ${avg('i', (r) => r.loud).toFixed(1)} LUFS      平读 ${flat.loud.i?.toFixed(1)} LUFS`);
console.log(`峰值          语境 ${Math.max(...scene.map((r) => r.loud.tp ?? 0)).toFixed(1)} dBTP   平读 ${flat.loud.tp?.toFixed(1)} dBTP`);

fs.writeFileSync('/tmp/voice-quality.json', JSON.stringify(rows.map((r) => ({
  name: r.c.name, file: r.out.file, instruction: r.out.instruction, loud: r.loud, m: r.m, t: r.t, text: r.c.text,
})), null, 2));

if (!process.argv.includes('--send')) {
  console.log('\n报告已写到 /tmp/voice-quality.json；加 --send 才发 QQ。');
  process.exit(0);
}

const target = Number(process.env.QQ_TARGET || <OWNER_QQ>);
const url = new URL(cfg.raw.napcat.wsUrl);
if (cfg.raw.napcat.token) url.searchParams.set('access_token', cfg.raw.napcat.token);
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let seq = 0;
function call(action, params) {
  const echo = `r${++seq}`;
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: '语音体检版（已加响度均衡 + 重音/起伏指令），最后一条是平读对照' } }] });
for (const r of rows) {
  await wait(900);
  await call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: r.c.name } }] });
  await wait(900);
  await call('send_private_msg', { user_id: target, message: [{ type: 'record', data: { file: `/app/voice/${r.out.file.split('/').pop()}` } }] });
}
ws.close();
console.log('发完了。');
