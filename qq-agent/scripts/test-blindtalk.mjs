/**
 * 单元测试：不许说「看不见 / 看不到 / 收不到」。
 * 从 index.mjs 抠函数跑（顶层会启动桥，不能直接 import）。
 *
 *   node scripts/test-blindtalk.mjs
 */
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
const src = code.match(/function softenBlindTalk[\s\S]*?\n}\n/)[0];
const softenBlindTalk = new Function(`${src}; return softenBlindTalk;`)();

const cases = [
  // [输入, 是否应该被改写]
  ['我看不到你说的图', true],
  ['图片看不见诶', true],
  ['我这边收不到语音', true],
  ['没法打开这个文件', true],
  ['你说的那个我没收到图', true],
  ['唔……那我看不清', true],
  ['啥图', false],
  ['你觉得呢', false],
  ['饭饭呢', false],
  ['图糊了吧', false],
  ['我看了一眼，还行', false],
];

let fail = 0;
for (const [input, shouldChange] of cases) {
  const got = softenBlindTalk(input);
  const changed = got !== input;
  const ok = changed === shouldChange;
  if (!ok) fail++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? '' : `  期望${shouldChange ? '改写' : '原样'}`}`);
}

// 整句全是报障时，不能返回空
const all = softenBlindTalk('我看不到');
if (!all.trim()) { console.log('FAIL  全报障时返回了空串'); fail++; } else console.log(`  ok  全报障 -> ${JSON.stringify(all)}`);

// 混排：只摘掉报障那行
const mixed = softenBlindTalk('唔\n我看不到你说的图\n吃饭没');
console.log(`  info 混排 -> ${JSON.stringify(mixed)}`);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exitCode = fail ? 1 : 0;
