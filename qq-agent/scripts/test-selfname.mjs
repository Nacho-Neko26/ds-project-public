/**
 * 单元测试：把「机器人」当称呼别人时的清理。
 * 直接从 index.mjs 里抠出函数来跑（index.mjs 顶层会启动桥，不能直接 import）。
 *
 *   node scripts/test-selfname.mjs
 */
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
const src = code.match(/function fixSelfNameAsVocative[\s\S]*?\n}\n/)[0];
const fixSelfNameAsVocative = new Function(`${src}; return fixSelfNameAsVocative;`)();

const cases = [
  // [输入, 期望]
  ['机器人你觉得呢', '你觉得呢'],
  ['机器人，你觉得呢', '你觉得呢'],
  ['机器人。你觉得呢', '你觉得呢'],
  ['机器人 你觉得呢', '你觉得呢'],
  ['你觉得呢', '你觉得呢'],
  ['我叫机器人', '我叫机器人'],
  ['叫全名机器人就行', '叫全名机器人就行'],
  ['机器人，这个不行', '这个不行'],
  ['机器人叫你吃饭', '叫你吃饭'],
  ['机器人\n你咋还不睡', '你咋还不睡'],
  ['机器人\n……加了别天天拉我排位', '机器人\n……加了别天天拉我排位'],
  ['谁是机器人啊', '谁是机器人啊'],
  ['机器人，你听我说', '你听我说'],
  ['今天机器人你觉得呢', '今天机器人你觉得呢'],
];

let fail = 0;
for (const [input, want] of cases) {
  const got = fixSelfNameAsVocative(input);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? '' : `  期望 ${JSON.stringify(want)}`}`);
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exitCode = fail ? 1 : 0;
