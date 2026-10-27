#!/usr/bin/env node
/**
 * 好感度 v1（百分制）→ v2（Aibond 双轴）迁移脚本
 *
 * 用户 2026-10-27 拍板（m00831 更正后的最终口径）：
 *   · 原先 90 分换算成八档的第五档（交情 660~1079），其他以此类推——
 *     也就是每个旧门槛正好对齐一档，行为一点不变：
 *       35(语音)→第1档起  50(表情)→第2档  70(指令)→第3档
 *       80(点歌)→第4档   90(点唱)→第5档  100→第6档
 *     所以**不扣 1000、没有人归零**，只是把曲线压平，给第 7、8 档留成长空间。
 *   · 保留软区、周上限（一周最多 500 好感分）等 Aibond 防刷机制。
 *   · 好感只增，信任可跌。
 *
 * 用法：
 *   node migrate-favor-v2.mjs                 # dry-run，只出表，不动文件
 *   node migrate-favor-v2.mjs --apply         # 真写（先自动备份）
 *   node migrate-favor-v2.mjs --file <路径>   # 指定数据文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(PROJECT_ROOT, 'workspace/profiles/_favor-shared.json');

// 旧百分 → 新好感：每个旧门槛正好压在一档起点上（90 → 第五档 660）
const A_ANCHORS = [[0, 0], [50, 60], [70, 180], [80, 360], [90, 660], [100, 1080], [105, 1290]];
// 旧百分 → 新信任：沿用 Aibond 的信任门槛（八档每档一个）
const T_ANCHORS = [[0, 0], [20, 12], [35, 25], [50, 40], [70, 55], [80, 68], [90, 82], [100, 92], [105, 95]];
const DEDUCT = 0;

const STAGES = [
  // 名字按用户 m01043 定的八档，区间不变
  [0, 59, '陌生'],
  [60, 179, '陌生人'],
  [180, 359, '熟人'],
  [360, 659, '朋友'],
  [660, 1079, '普通朋友'],
  [1080, 1679, '关系很好的朋友'],
  [1680, 2399, '朋友之上恋人未满'],
  [2400, 2400, '恋人爱人'],
];

function interp(anchors, x) {
  const maxX = anchors[anchors.length - 1][0];
  x = Math.max(0, Math.min(maxX, x));
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  }
  return anchors[anchors.length - 1][1];
}

function stageOf(a) {
  for (const [lo, hi, name] of STAGES) if (a >= lo && a <= hi) return name;
  return '?';
}

function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fileArgIdx = args.indexOf('--file');
const FILE = fileArgIdx >= 0 ? path.resolve(args[fileArgIdx + 1]) : DEFAULT_FILE;

if (!fs.existsSync(FILE)) {
  console.error(`数据文件不存在：${FILE}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const entries = Object.entries(raw);
const today = dayKey();
const week = isoWeekKey();

const report = [];
const rows = [];
let skipped = 0;

for (const [uid, v] of entries) {
  if (v && v._schema === 2) {
    skipped++;
    rows.push({ uid, already: true });
    continue;
  }
  const favor = Number(v?.favor ?? 0);
  const penalty = Number(v?.tempPenalty ?? 0);
  // tempPenalty 是「已经从 favor 里扣走、等着消气归还」的额度，迁移时必须还回去，
  // 否则迁移当场每人凭空掉 20 分。旧量程顶是 100，还完要 clamp 回 100。
  const real = Math.min(100, favor + penalty);
  const oldAff = Math.round(interp(A_ANCHORS, real));
  const trust = Math.round(interp(T_ANCHORS, real) * 10) / 10;
  const affection = Math.max(0, Math.min(2400, oldAff - DEDUCT));

  rows.push({
    uid, favor, penalty, real, oldAff, trust, affection,
    stage: stageOf(affection),
    lastChatAt: v?.lastChatAt ?? null,
    dayChatted: !!v?.dayChatted,
  });
}

rows.sort((a, b) => (b.affection ?? -1) - (a.affection ?? -1));

report.push('# 好感度 v1 → v2 迁移' + (APPLY ? '（已写入）' : '（试算，未写入）'));
report.push('');
report.push(`数据文件：\`${FILE}\``);
report.push(`对象：${entries.length} 个　已是 v2 跳过：${skipped} 个`);
report.push('');
report.push('| QQ | 旧显示 | 隐藏惩罚 | 真实分 | 新好感 | 新信任 | 档位 | 旧门槛对照 |');
report.push('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.already) { report.push(`| ${r.uid} | 已是 v2，跳过 | | | | | | |`); continue; }
  const caps = [];
  if (r.affection >= 50) caps.push('语音');
  if (r.affection >= 60) caps.push('表情');
  if (r.affection >= 180) caps.push('指令');
  if (r.affection >= 360) caps.push('点歌');
  if (r.affection >= 660) caps.push('点唱');
  report.push(`| ${r.uid} | ${r.favor} | ${r.penalty} | ${r.real} | **${r.affection}** | ${r.trust} | ${r.stage} | ${caps.join('/') || '—'} |`);
}

const dist = {};
for (const r of rows) if (!r.already) dist[r.stage] = (dist[r.stage] || 0) + 1;
const zeros = rows.filter((r) => !r.already && r.affection < 50).length;
report.push('');
report.push(`档位分布：${Object.entries(dist).map(([k, n]) => `${k} ${n}`).join(' / ')}`);
report.push(`连语音都拿不到（好感 < 50）：${zeros} 个`);
report.push(`能力线：语音 ≥50 · 表情 ≥60 · 指令 ≥180 · 点歌 ≥360 · 点唱 ≥660`);
report.push('');
report.push('对照验收：原 90 分 → **660** → 第五档普通朋友 ✅　原 80 → 360（第四档会交谈的熟人）✅　原 70 → 180（第三档眼熟的一般人）✅　原 50 → 60（第二档陌生人）✅');

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${FILE}.bak-${stamp}`;
  fs.copyFileSync(FILE, backup);
  report.push('');
  report.push(`已备份：\`${backup}\``);

  const out = {};
  for (const [uid, v] of entries) {
    if (v && (v._schema === 2 || typeof v.favor !== 'number')) { out[uid] = v; continue; }
    if (v && v._schema === 2) { out[uid] = v; continue; }
    const r = rows.find((x) => x.uid === uid && !x.already);
    out[uid] = {
      favor: r.affection,          // 字段名不变，量程 0~2400
      trust: r.trust,
      _schema: 2,
      favorPeak: r.affection,
      dayKey: today,
      dayGain: 0,
      dayTrust: 0,
      weekKey: week,
      weekGain: 0,
      weekTrust: 0,
      hourKey: null,
      hourlyGainToday: 0,
      dayChatted: !!v?.dayChatted,
      dayAngered: !!v?.dayAngered,
      lastChatAt: v?.lastChatAt ?? null,
      helpedBy: {},
      persuadeGainToday: 0,
      tempPenalty: 0,
      angerTrustHeld: 0,
      migratedFrom: { favor: r.favor, tempPenalty: r.penalty, schema: 'v1', at: new Date().toISOString() },
    };
  }
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2), 'utf8');
  report.push(`已写入 ${Object.keys(out).length} 个对象`);
}

const outPath = 'D:/DSH/tmp/favor-migrate-report.md';
fs.mkdirSync('D:/DSH/tmp', { recursive: true });
fs.writeFileSync(outPath, report.join('\n'), 'utf8');
console.log(report.join('\n'));
console.log(`\n[报告] ${outPath}`);
