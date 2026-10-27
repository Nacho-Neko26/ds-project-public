#!/usr/bin/env node
/**
 * QQ 收文件单测：node scripts/test-files.mjs
 * 覆盖纯函数（文件名清洗/大小/去重/文本预览）和 renderSegments 的 file/onlinefile 段。
 * 真正下载 + 落盘要靠服务器的 NapCat，那部分在云端实测（见 docs/qq-commands.md）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeDownloadName, humanSize, uniquePath, textPreview, copyLocalFile,
  MAX_FILE_BYTES, downloadFile,
} from '../src/files.mjs';
import { renderSegments, stripAtLabels } from '../src/render.mjs';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filetest-'));
function write(name, content) {
  const f = path.join(tmp, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

console.log('\n[1] safeDownloadName');
eq('普通名字不动', safeDownloadName('说明.md'), '说明.md');
eq('去掉路径穿越', safeDownloadName('../../etc/passwd'), 'passwd');
eq('反斜杠也当分隔符', safeDownloadName('C:\\tmp\\a.txt'), 'a.txt');
eq('非法字符换下划线', safeDownloadName('a<b>c:d"e|f?g*.txt'), 'a_b_c_d_e_f_g_.txt');
eq('去掉开头的点', safeDownloadName('...hidden.txt'), 'hidden.txt');
eq('空名字用兜底', safeDownloadName(''), '文件');
eq('全非法也兜底', safeDownloadName('***'), '___');
ok('超长截到 80', safeDownloadName('a'.repeat(200) + '.txt').length <= 80);

console.log('\n[2] humanSize');
eq('小于 1K 用 B', humanSize(512), '512 B');
eq('1K 以上用 KB', humanSize(7544), '7.4 KB');
eq('1M 以上用 MB', humanSize(3 * 1024 * 1024), '3.0 MB');
eq('1G 以上用 GB', humanSize(2.5 * 1024 ** 3), '2.50 GB');
eq('非法值当 0', humanSize('abc'), '0 B');

console.log('\n[3] uniquePath 同名不覆盖');
const d = path.join(tmp, 'uniq');
fs.mkdirSync(d, { recursive: true });
const p1 = uniquePath(d, 'a.md'); fs.writeFileSync(p1, 'x');
eq('第一份原名', path.basename(p1), 'a.md');
const p2 = uniquePath(d, 'a.md'); fs.writeFileSync(p2, 'y');
eq('第二份加 -1', path.basename(p2), 'a-1.md');
const p3 = uniquePath(d, 'a.md');
eq('第三份加 -2', path.basename(p3), 'a-2.md');

console.log('\n[4] textPreview 文本才给内容');
const md = write('p.md', '# 标题\n正文两行\n');
ok('md 给预览', (textPreview(md) || '').includes('正文两行'));
const bin = write('p.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
eq('png 不给预览', textPreview(bin), null);
const noext = write('noext', 'hello');
eq('没扩展名不给预览', textPreview(noext), null);
const big = write('big.txt', 'a'.repeat(70 * 1024));
eq('超 64KB 不给预览', textPreview(big), null);
const long = write('long.md', 'b'.repeat(2000));
const pv = textPreview(long);
ok('超长截断并说明', pv.includes('…（后面还有') && pv.length < 2000);
eq('不存在的文件不抛', textPreview(path.join(tmp, 'nope.txt')), null);

console.log('\n[5] copyLocalFile');
const src = write('from-temp.bin', Buffer.from('payload'));
const got = copyLocalFile(src, path.join(tmp, 'dst'), 'from-temp.bin');
ok('拷成功并给大小', got && got.size === 7 && fs.existsSync(got.file));
eq('不存在的源返回 null', copyLocalFile(path.join(tmp, 'nope'), tmp, 'x'), null);
const emptySrc = write('empty.bin', '');
eq('空文件不接收', copyLocalFile(emptySrc, path.join(tmp, 'dst2'), 'empty.bin'), null);

console.log('\n[6] downloadFile 参数校验');
eq('非 http 直接 null', await downloadFile('file:///etc/passwd', tmp, 'x'), null);
eq('空 url 直接 null', await downloadFile('', tmp, 'x'), null);
ok('上限是 200MB', MAX_FILE_BYTES === 200 * 1024 * 1024);

console.log('\n[7] renderSegments：file 段字段名');
const r1 = renderSegments([
  { type: 'text', data: { text: '发你一份 ' } },
  { type: 'file', data: { file: '说明.md', file_id: 'uuid-1', file_size: 7544, url: 'https://x/y' } },
]);
eq('占位符是 [[FILE:0]]', r1.text, '发你一份 [[FILE:0]]');
eq('files 一条', r1.files.length, 1);
eq('名字取 file 字段', r1.files[0].name, '说明.md');
eq('file_id 落到 fileId', r1.files[0].fileId, 'uuid-1');
eq('size 转成数字', r1.files[0].size, 7544);
eq('url 保留', r1.files[0].url, 'https://x/y');
ok('不再出现空的中括号文件占位', !r1.text.includes('[文件:]'));

console.log('\n[8] renderSegments：老式 d.name 也能认');
const r2 = renderSegments([{ type: 'file', data: { name: 'old.txt', size: 10 } }]);
eq('回落 d.name', r2.files[0].name, 'old.txt');
eq('回落 d.size', r2.files[0].size, 10);

console.log('\n[9] renderSegments：onlinefile 段');
const r3 = renderSegments([
  { type: 'onlinefile', data: { msgId: 'm1', elementId: 'e1', fileName: '报告.pdf', fileSize: 2048 } },
]);
eq('占位符 0', r3.text, '[[FILE:0]]');
eq('名字取 fileName', r3.files[0].name, '报告.pdf');
eq('msgId 留下', r3.files[0].msgId, 'm1');
eq('elementId 留下', r3.files[0].elementId, 'e1');
eq('大小取 fileSize', r3.files[0].size, 2048);
ok('isDir 默认 false', r3.files[0].isDir === false);

console.log('\n[10] 多个文件编号递增');
const r4 = renderSegments([
  { type: 'file', data: { file: 'a.txt' } },
  { type: 'text', data: { text: '加 ' } },
  { type: 'file', data: { file: 'b.txt' } },
]);
eq('两个占位符', r4.text, '[[FILE:0]]加 [[FILE:1]]');
eq('两条 files', r4.files.map((f) => f.name), ['a.txt', 'b.txt']);

console.log('\n[11] stripAtLabels 会去掉文件占位符');
eq('去掉 @ 和文件占位', stripAtLabels('@你 [[FILE:0]]'), '');
eq('普通文字保留', stripAtLabels('@你 [[FILE:0]] 看下'), '看下');

console.log('\n[12] 没文件时 files 是空数组（不破坏老路径）');
const r5 = renderSegments([{ type: 'text', data: { text: '普通消息' } }]);
eq('files 空', r5.files, []);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
