import { stripThinkingLeak } from '../src/thinking-guard.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; } else { fail += 1; console.log(`FAIL ${name}`); }
}

// 1) 2026-10-25 22:14 私聊真实泄漏：只留最后一句正文
const real = '他发了个表情，估计就是随便逗一下。我回一句就好。\n'
  + '就发个「[表情]」，多半是求回应呢……本鲸也甩一张？不过默认先不发，这轮就纯说话，显得有点小傲娇。\n'
  + '嗯，挺短的一句话，简短点回。唔，甩个表情过来就想把本鲸晾在那儿？说句话嘛。';
ok('真实泄漏-只剩正文', stripThinkingLeak(real) === '唔，甩个表情过来就想把本鲸晾在那儿？说句话嘛。');

// 2) 正常两行短句（QQ 拆两条的写法）不误删
const twoLines = '今天好累啊\n先睡了';
ok('两行短句不动', stripThinkingLeak(twoLines) === twoLines);

// 3) 只有一段：不切，原样返回
const one = '估计是他忘了我发的消息了。';
ok('单段不动', stripThinkingLeak(one) === one);

// 4) 指令行原样保留
const withDirective = '__SEND_STICKER__ S12\n这也太离谱了\n本鲸都看傻了';
const kept = stripThinkingLeak(withDirective);
ok('指令行保留', kept.includes('__SEND_STICKER__ S12'));
ok('指令行后正文保留', kept.includes('这也太离谱了') && kept.includes('本鲸都看傻了'));

// 5) 全是思考：清空（宁可这轮不发）
const allThought = '他发了个表情，估计是求回应。我回一句就好。\n这轮要不要配一张？默认先不发。';
ok('全是思考-清空', stripThinkingLeak(allThought).trim() === '');

// 6) 正文里只有一个弱信号词，不误删
const weakOnly = '他估计是睡了吧\n那本鲸也去躺了';
ok('单个弱信号不删', stripThinkingLeak(weakOnly).includes('他估计是睡了吧'));

// 7) 空输入
ok('空输入', stripThinkingLeak('') === '');

console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
