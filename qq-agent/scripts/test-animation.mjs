#!/usr/bin/env node
/**
 * 动图拆帧（看动图）单测：node scripts/test-animation.mjs
 * 只覆盖纯函数与探测/门禁逻辑，真跑 ffmpeg 的部分在云端脚本里验（本机没有 ffmpeg）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  hashContent, sheetPathFor, cachedSheet, sampleIndices, gridDims, buildFilmstripPlan,
  imageKindOf, isAnimated, resolveAnimatedSheet,
  trustedAnimatedHint, describeAnimatedHint,
} from '../src/animation.mjs';
import { sniffImageExt, sniffFileExt, downloadImage } from '../src/media.mjs';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animtest-'));
const GIF_HEAD = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0x00]);
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ')]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0]);
function write(name, buf) { const f = path.join(tmp, name); fs.writeFileSync(f, buf); return f; }

console.log('\n[1] 纯函数：hash / 路径 / 缓存');
eq('hashContent 取 16 位', hashContent(Buffer.from('abc')).length, 16);
eq('同内容同 hash', hashContent(Buffer.from('abc')), hashContent(Buffer.from('abc')));
ok('sheetPathFor 不带帧数 = 老命名 -sheet.png',
  sheetPathFor('deadbeefdeadbeef', tmp) === path.join(tmp, 'deadbeefdeadbeef-sheet.png'));
ok('sheetPathFor 带帧数 = -sheet16.png（换帧数不复用旧拼图）',
  sheetPathFor('deadbeefdeadbeef', tmp, 16) === path.join(tmp, 'deadbeefdeadbeef-sheet16.png'));
ok('cachedSheet 空文件算没有', cachedSheet(write('empty-sheet.png', Buffer.alloc(0))) === false);
ok('cachedSheet 有内容算有', cachedSheet(write('full-sheet.png', Buffer.from([1]))) === true);
ok('cachedSheet 不存在的路径不抛', cachedSheet(path.join(tmp, 'nope.png')) === false);

console.log('\n[2] 抽帧：均匀、首尾必含');
eq('帧数少于上限：全取', sampleIndices(3, 8), [0, 1, 2]);
eq('20 帧取 8：首尾必含', sampleIndices(20, 8), [0, 3, 5, 8, 11, 14, 16, 19]);
eq('上限 1 帧只取第一帧', sampleIndices(50, 1), [0]);
ok('下标单调递增且不重复', (() => { const a = sampleIndices(100, 8); return a.every((v, i) => i === 0 || v > a[i - 1]); })());

console.log('\n[3] 网格：最多 4 列');
eq('1 帧 = 1x1', gridDims(1), { cols: 1, rows: 1 });
eq('4 帧 = 4x1', gridDims(4), { cols: 4, rows: 1 });
eq('8 帧 = 4x2', gridDims(8), { cols: 4, rows: 2 });
eq('6 帧 = 4x2', gridDims(6), { cols: 4, rows: 2 });

console.log('\n[4] ffmpeg 滤镜参数');
const plan = buildFilmstripPlan({ totalFrames: 20, width: 200, height: 200, maxWidth: 1600 });
eq('默认取 16 帧', plan.frames, 16);
eq('4 列 4 行', [plan.cols, plan.rows], [4, 4]);
eq('每格 400 宽', plan.tileW, 400);
eq('每格高度按原图比例 400', plan.tileH, 400);
ok('有 select 抽帧表达式', plan.vf.startsWith("select='") && plan.vf.includes('eq(n' + String.fromCharCode(92) + ',0)') && plan.vf.includes('eq(n' + String.fromCharCode(92) + ',19)'), plan.vf);
ok('含 scale+pad 白底', plan.vf.includes('force_original_aspect_ratio=decrease') && plan.vf.includes('color=white'));
ok('含 tile=4x4', plan.vf.includes('tile=4x4:nb_frames=16'));
const plan8 = buildFilmstripPlan({ totalFrames: 20, width: 200, height: 200, maxFrames: 8, maxWidth: 1600 });
eq('显式 maxFrames:8 仍然 4x2', [plan8.frames, plan8.cols, plan8.rows], [8, 4, 2]);
const planAll = buildFilmstripPlan({ totalFrames: 4, width: 100, height: 50, maxFrames: 16 });
ok('帧数少于上限时不出 select（全取）', planAll.vf === null || !planAll.vf.includes('select='), String(planAll.vf));
const planWide = buildFilmstripPlan({ totalFrames: 12, width: 500, height: 250, maxFrames: 8, maxWidth: 1600 });
ok('宽高比 2:1 时每格高度 = 宽/2', planWide.tileH === Math.round(planWide.tileW * 0.5), planWide.tileW + 'x' + planWide.tileH);
const planTall = buildFilmstripPlan({ totalFrames: 40, width: 200, height: 356, maxWidth: 1600, maxHeight: 1600 });
ok('9:16 竖图被高度上限压住（拼图不超 1600 高）',
  planTall.rows * planTall.tileH <= 1600 && planTall.tileW === 400, `${planTall.tileW}x${planTall.tileH} × ${planTall.rows} 行`);
ok('压矮后靠白边补齐、不变形（vf 里有 pad+color=white）', planTall.vf.includes('pad') && planTall.vf.includes('color=white'));

console.log('\n[5] 文件头嗅探（media.mjs）');
eq('GIF', sniffImageExt(GIF_HEAD), 'gif');
eq('WEBP', sniffImageExt(WEBP_HEAD), 'webp');
eq('PNG', sniffImageExt(PNG_HEAD), 'png');
eq('JPG', sniffImageExt(JPG_HEAD), 'jpg');
eq('垃圾字节 → null', sniffImageExt(Buffer.from('not an image at all')), null);
eq('太短 → null', sniffImageExt(Buffer.from([0x47, 0x49])), null);
eq('sniffFileExt 读盘', sniffFileExt(write('a.webp', WEBP_HEAD)), 'webp');

console.log('\n[6] 缓存里的错扩展名会被改对（不重新下载）');
const url = 'http://example.com/qq-pic-no-ext';
const h = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
const wrong = path.join(tmp, h + '.jpg');
fs.writeFileSync(wrong, GIF_HEAD);
const got = await downloadImage(url, tmp);
ok('返回的路径扩展名改成 .gif', got === path.join(tmp, h + '.gif'), String(got));
ok('旧 .jpg 文件已改名', !fs.existsSync(wrong));

console.log('\n[7] 是否动图：按内容判断，不看扩展名');
eq('内容 GIF 但叫 .jpg → gif', imageKindOf(wrong.replace('.jpg', '.gif')), 'gif');
const disguised = write('disguised.jpg', GIF_HEAD);
eq('同一个 gif 伪装成 .jpg 也能认出', imageKindOf(disguised), 'gif');
eq('PNG → png', imageKindOf(write('b.png', PNG_HEAD)), 'png');
eq('JPG → jpg', imageKindOf(write('c.jpg', JPG_HEAD)), 'jpg');
eq('不存在的文件 → other', imageKindOf(path.join(tmp, 'nobody.gif')), 'other');
ok('isAnimated 在 ffprobe 缺失时安静返回 false', (await isAnimated(write('d.gif', GIF_HEAD), '/definitely/not/ffmpeg')) === false);

console.log('\n[8] resolveAnimatedSheet 门禁');
let probeCalls = 0;
const noSheet = await resolveAnimatedSheet(write('e.png', PNG_HEAD), tmp, {
  isAnimatedFn: async () => { probeCalls++; return true; },
  buildFilmstripFn: async () => ({ sheet: 'x', frames: 3 }),
});
ok('静态图不探测、直接 null', noSheet === null && probeCalls === 0);
const singleFrame = await resolveAnimatedSheet(disguised, tmp, {
  isAnimatedFn: async () => false,
  buildFilmstripFn: async () => { throw new Error('不该被调用'); },
});
ok('单帧 gif → null', singleFrame === null);
const animated = await resolveAnimatedSheet(disguised, tmp, {
  isAnimatedFn: async () => true,
  buildFilmstripFn: async (f, dir) => ({ sheet: path.join(dir, 'ok-sheet.png'), frames: 6 }),
});
ok('多帧 gif → 给 sheet + 帧数', animated && animated.frames === 6 && animated.sheet.endsWith('ok-sheet.png'));
ok('文件不存在 → null（不抛）', (await resolveAnimatedSheet(path.join(tmp, 'gone.gif'), tmp)) === null);

console.log('\n[9] 注入给模型的提示文案');
const th = trustedAnimatedHint('incoming/abc-sheet.png', 6);
ok('可信用户：带路径 + 帧数 + 第 1 帧在左上', th.includes('incoming/abc-sheet.png') && th.includes('6 帧') && th.includes('第 1 帧在左上') && th.includes('read_image'));
const dh = describeAnimatedHint(6, '一只猫在摇头');
ok('不可信用户：把描述塞进去', dh.includes('6 帧') && dh.includes('一只猫在摇头'));
// 2026-10-26：角色把 16 帧当成 16 张图说给用户听（「这十六张一块儿砸过来」），提示文案必须压住口径
ok('可信用户：明确说是【一张】动图，不是 6 张图', th.includes('【一张】') && th.includes('不是 6 张图'));
ok('不可信用户：明确说是【一张】动图，不是 6 张图', dh.includes('【一张】') && dh.includes('不是 6 张图'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '全过' : '有挂') + `：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
