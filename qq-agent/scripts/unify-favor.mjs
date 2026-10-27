#!/usr/bin/env node
/**
 * 一次性迁移：把某个群的档案里每个人的好感取出来，写成「按人统一」的共享表
 * workspace/profiles/_favor-shared.json（2026-10-25 用户要求）。
 *
 * 用法（在 qq-agent 目录下）：
 *   node scripts/unify-favor.mjs                 # 默认以 group:200000002（涛涛阿姨的爱心小窝）为准
 *   node scripts/unify-favor.mjs group:200000001 # 换基准群
 *   node scripts/unify-favor.mjs --dry           # 只看结果，不写文件
 *
 * 只搬好感相关字段（见 SHARED_FAVOR_FIELDS），不碰昵称/记事本/怒气这些。
 */
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = [
  'favor', 'tempPenalty', 'hourKey', 'hourlyGainToday', 'hourlyDay',
  'dayMark', 'prevDayMark', 'dayChatted', 'dayAngered', 'lastChatAt', 'updatedAt',
];

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const seedKey = args.find((a) => a.startsWith('group:')) || 'group:200000002';

const root = process.cwd();
const profilesDir = path.join(root, 'workspace', 'profiles');
const fileFor = (key) => path.join(profilesDir, `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
const sharedFile = path.join(profilesDir, '_favor-shared.json');

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}

const seed = readJson(fileFor(seedKey), null);
if (!seed) {
  console.error(`找不到基准档案：${fileFor(seedKey)}`);
  process.exit(1);
}

const shared = readJson(sharedFile, {});
const rows = [];
for (const [uid, p] of Object.entries(seed.people || {})) {
  if (!p) continue;
  const slice = {};
  for (const k of FIELDS) if (p[k] !== undefined) slice[k] = p[k];
  if (!Object.keys(slice).length) continue;
  shared[uid] = { ...(shared[uid] || {}), ...slice };
  rows.push({ uid, name: p.name || p.nick || '', favor: slice.favor ?? null });
}

rows.sort((a, b) => (b.favor ?? -1) - (a.favor ?? -1));
console.log(`基准：${seedKey}（${rows.length} 人）`);
for (const r of rows) console.log(`  ${String(r.favor ?? '-').padStart(4)}  ${r.uid}  ${r.name}`);

if (dry) {
  console.log('\n--dry：没有写文件');
} else {
  fs.mkdirSync(profilesDir, { recursive: true });
  const tmp = `${sharedFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shared, null, 2), 'utf8');
  fs.renameSync(tmp, sharedFile);
  console.log(`\n已写入 ${sharedFile}（${Object.keys(shared).length} 人）`);
}
