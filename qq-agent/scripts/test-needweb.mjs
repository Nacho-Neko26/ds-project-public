import fs from 'node:fs';

const code = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
const src = code.match(/function extractNeedWeb[\s\S]*?\n}\n/)[0];
const extractNeedWeb = new Function(`${src}; return extractNeedWeb;`)();

const cases = [
  ['__NEED_WEB__ 杭州天气', '杭州天气', ''],
  ['你在此地勿要走动，我去查查便回来。\n__NEED_WEB__ 杭州天气', '杭州天气', '你在此地勿要走动，我去查查便回来。'],
  ['等一下\n__NEED_WEB__ 2026年诺贝尔文学奖 | 等我想想', '2026年诺贝尔文学奖', '等我想想'],
  ['就是普通回答', null, ''],
  ['__NEED_WEB__ ', null, ''],
];

let fail = 0;
for (const [input, wantQuery, wantSay] of cases) {
  const r = extractNeedWeb(input);
  const gotQ = r?.query ?? null;
  const gotS = r?.say ?? '';
  const ok = gotQ === wantQuery && (wantSay === '' || gotS === wantSay);
  if (!ok) fail++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${JSON.stringify(input)} -> ${JSON.stringify({ query: gotQ, say: gotS })}`);
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exitCode = fail ? 1 : 0;
