#!/usr/bin/env node
// 表情库体检：索引里记的图，文件在不在。
//
//   node scripts/sticker-doctor.mjs                # 体检 workspace/stickers
//   node scripts/sticker-doctor.mjs --dir <路径>
//   node scripts/sticker-doctor.mjs --list         # 列出全部问题项
//
// 判定和桥一致（见 src/stickerfile.mjs）：能用的是「顶层 file 相对路径」或「顶层 local 绝对/相对路径」，
// 两者都取不到就算发不出去。群里收图时那行只有 seg.data.file（QQ 侧文件名），属于没物化的索引，
// 记成「未物化」而不是错误——桥本来就不会发它。
//
// 退出码：0 = 没有坏引用；1 = 有 file/local 指向但不存在的图（这些发出去会失败）
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const listMode = args.includes('--list');

const ROOT = dirArg
  ? path.resolve(dirArg)
  : path.resolve(import.meta.dirname, '..', 'workspace', 'stickers');

if (!fs.existsSync(ROOT)) {
  console.error(`找不到目录：${ROOT}`);
  process.exit(2);
}

function resolve(rec) {
  const cands = [];
  if (rec?.file) cands.push(path.isAbsolute(rec.file) ? rec.file : path.join(ROOT, rec.file));
  if (rec?.local) cands.push(path.isAbsolute(rec.local) ? rec.local : path.join(ROOT, rec.local));
  return cands;
}

let total = 0, usable = 0, rawOnly = 0, broken = 0, badJson = 0;
const brokenList = [];
const badList = [];
const referenced = new Set();

for (const name of fs.readdirSync(ROOT)) {
  if (!name.endsWith('.jsonl')) continue;
  const lines = fs.readFileSync(path.join(ROOT, name), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    total += 1;
    let row;
    try { row = JSON.parse(s); } catch {
      badJson += 1;
      badList.push(`${name}:${i + 1} 不是合法 JSON`);
      return;
    }
    const cands = resolve(row);
    if (!cands.length) { rawOnly += 1; return; }
    const hit = cands.find((c) => fs.existsSync(c));
    if (hit) {
      usable += 1;
      referenced.add(path.relative(ROOT, hit).replace(/\\/g, '/'));
    } else {
      broken += 1;
      brokenList.push(`${name}:${i + 1} → ${cands[0]}`);
    }
  });
}

const filesDir = path.join(ROOT, 'files');
const orphan = [];
if (fs.existsSync(filesDir)) {
  for (const n of fs.readdirSync(filesDir)) {
    if (!referenced.has(`files/${n}`)) orphan.push(`files/${n}`);
  }
}

console.log(`目录：${ROOT}`);
console.log(`索引 ${total} 条：可发 ${usable} · 未物化 ${rawOnly}（只有 QQ 侧文件名，正常）· 坏引用 ${broken} · 坏行 ${badJson}`);
if (orphan.length) console.log(`孤儿文件 ${orphan.length} 个（files/ 里有、没人引用，不影响使用）`);

if (badList.length) {
  console.log(`\n格式问题（前 10）：`);
  (listMode ? badList : badList.slice(0, 10)).forEach((x) => console.log(`  ! ${x}`));
}
if (brokenList.length) {
  console.log(`\n有路径但文件不在的 ${brokenList.length} 条（发到这些会失败）：`);
  (listMode ? brokenList : brokenList.slice(0, 20)).forEach((x) => console.log(`  ✗ ${x}`));
  if (!listMode && brokenList.length > 20) console.log(`  … 还有 ${brokenList.length - 20} 条，加 --list 看全`);
}
if (!broken && !badJson) console.log(`\n没有坏引用，可以放心发图。`);
process.exit(broken || badJson ? 1 : 0);
