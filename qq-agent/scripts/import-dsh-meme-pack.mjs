/**
 * 从 dsh-meme 图库包导入共享图库（§16 P0 版）。
 * 图片复制到 workspace/stickers/files/，jsonl 记相对路径 file + digest，
 * 不再写 Windows 绝对路径（那是 Linux 上发不出表情的根因）。
 *   node scripts/import-dsh-meme-pack.mjs [packDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACK = process.argv[2] || 'C:/Users/14381/DSH-Plugin/dsh-meme/memes/dafeiyu-001';
const STASH = path.join(ROOT, 'workspace', 'stickers');
const FILES = path.join(STASH, 'files');
const OUT = path.join(STASH, '_shared.jsonl');

const digestOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

const db = new DatabaseSync(path.join(PACK, 'index.db'));
const rows = db.prepare('SELECT path, tag, caption FROM memes ORDER BY path').all();
db.close();

fs.mkdirSync(FILES, { recursive: true });
const lines = [];
for (const r of rows) {
  const src = path.join(PACK, r.path.split('/').join(path.sep));
  if (!fs.existsSync(src)) { console.error('missing:', src); continue; }
  const base = path.basename(src);
  const dest = path.join(FILES, base);
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  lines.push(JSON.stringify({
    t: new Date().toISOString(),
    uid: 0,
    name: '机器人图库',
    seg: { type: 'image', data: { summary: r.caption || '' } },
    file: 'files/' + base,
    digest: digestOf(src),
    tag: r.tag,
  }));
}
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log('wrote', lines.length, 'entries ->', OUT);
