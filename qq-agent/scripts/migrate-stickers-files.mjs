/**
 * 一次性迁移 workspace/stickers/*.jsonl（§16 P0）。
 * 把记录里的本地绝对图片复制到 stickers/files/，并在记录里追加 "file": "files/<name>"。
 * 幂等：已有可用 file 的记录直接跳过。
 *   node scripts/migrate-stickers-files.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const STASH = path.join(ROOT, 'workspace', 'stickers');
const FILES = path.join(STASH, 'files');
const DRY = process.argv.includes('--dry');

const digestOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

if (!fs.existsSync(STASH)) {
  console.error('没有 stickers 目录：', STASH);
  process.exit(1);
}
if (!DRY) fs.mkdirSync(FILES, { recursive: true });

const jsonls = fs.readdirSync(STASH).filter((f) => f.endsWith('.jsonl'));
let total = 0; let migrated = 0; let missing = 0; let skipped = 0;

for (const name of jsonls) {
  const file = path.join(STASH, name);
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { out.push(line); continue; }
    total += 1;
    if (rec?.seg?.type !== 'image') { out.push(line); continue; }
    if (rec.file && fs.existsSync(path.join(STASH, rec.file))) { skipped += 1; out.push(JSON.stringify(rec)); continue; }
    const src = rec.local && fs.existsSync(rec.local) ? rec.local : null;
    if (!src) { missing += 1; out.push(JSON.stringify(rec)); continue; }
    const base = path.basename(src);
    const dest = path.join(FILES, base);
    if (!DRY && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
    rec.file = 'files/' + base;
    rec.digest = digestOf(src);
    migrated += 1;
    out.push(JSON.stringify(rec));
  }
  if (!DRY) fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  console.log(`${name}: ${lines.length} 行`);
}

console.log(`合计 ${total} 条；迁移 ${migrated}；已有 file ${skipped}；源文件缺失 ${missing}${DRY ? '（dry-run，未写盘）' : ''}`);
console.log('图片目录：', FILES);
