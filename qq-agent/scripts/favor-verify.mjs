#!/usr/bin/env node
/** 服务器端验收：读真实数据看档位，再跑一遍双轴行为（不写回磁盘） */
import * as F from '../src/favor.mjs';
import fs from 'node:fs';

const FILE = '/root/qq-agent/workspace/profiles/_favor-shared.json';
const m = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const DAY = '2026-10-27';
const WEEK = '2026-W44';

console.log('=== 迁移后档位（按好感降序）===');
const rows = [];
for (const [uid, p] of Object.entries(m)) {
  F.ensureFavor(p);
  const st = F.stageOfPerson(p);
  rows.push({ uid, favor: p.favor, trust: Math.round(p.trust * 10) / 10, stage: st.name, idx: st.idx });
}
rows.sort((a, b) => b.favor - a.favor);
for (const r of rows) console.log(`${r.uid}\t好感 ${r.favor}\t信任 ${r.trust}\t${r.stage}（第${r.idx}档）`);

console.log('\n=== 卡片渲染（号主）===');
const owner = m['<OWNER_QQ>'];
console.log(F.renderFavorCard(owner.favor, F.qualifiedFavor(owner)));

console.log('\n=== 双轴行为 ===');
const p = { favor: 500, trust: 60, _schema: 2, dayKey: DAY, weekKey: WEEK, dayGain: 0, weekGain: 0, dayTrust: 0, weekTrust: 0 };
let r = F.applyFavor(p, 30, { dayKey: DAY });
console.log(`+30 好感 → ${r.before}→${r.after}，信任 ${p.trust}`);
r = F.applyFavor(p, -20, { dayKey: DAY });
console.log(`-20 → 好感 ${r.before}→${r.after}（应不变），信任 ${p.trust}（应 40）`);

console.log('\n=== 配置里的能力线 ===');
const cfg = JSON.parse(fs.readFileSync('/root/qq-agent/config/config.json', 'utf8'));
function findTh(x, path = '') {
  if (!x || typeof x !== 'object') return null;
  if (x.favorThresholds) return { path: path || '(root)', v: x.favorThresholds };
  for (const [k, v] of Object.entries(x)) {
    const r = findTh(v, path ? `${path}.${k}` : k);
    if (r) return r;
  }
  return null;
}
const th = findTh(cfg);
console.log(th ? `${th.path}.favorThresholds = ${JSON.stringify(th.v)}` : '没找到 favorThresholds');
