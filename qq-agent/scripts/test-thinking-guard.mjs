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

// 8) 2026-10-30 09:43 群聊真实泄漏：角色分析 + 自写台词 + 回复标签，只留「回复：」那句
const leak1030 = '沐·枫逸萧喊我「安全委员溟月姐」，还甩了两个呲牙——这是逗我，带着你只管吓人。我是安全委员，得顺着应一声，语气轻松，带点小傲娇。\n'
  + '「安全委员溟月姐……行吧，这头衔我认了」——再补一句：有事我真管。发个黄脸呲牙也行。\n'
  + '要短，一两条。别抄语料。别复读「吓什么呀」这上一句。注意这人叫沐·枫逸萧（阿枫）。不要自称本鲸（刚用过可考虑）。可以用「本喵」？这一场里还没用，用一次也行，不过也可以不用。\n'
  + '「溟月姐」——群里被喊姐，我的记忆里有一条「被人喊姐我就认下，还顺着论辈分往下压」——那就顺着压一下。\n'
  + '回复：安全委员上';
ok('10-30 泄漏-只留回复正文', stripThinkingLeak(leak1030) === '安全委员上');

// 9) 同类思考但没有「回复：」标签：分析行全丢，正常的一行留着
const noTag = '这是逗我，得顺着应一声，语气轻松，带点小傲娇。\n'
  + '要短，一两条。别抄语料。\n'
  + '行吧，这头衔我认了';
ok('无标签-分析行丢弃', stripThinkingLeak(noTag) === '行吧，这头衔我认了');

// 10) 正文里只带一个规划词，不误删
const onePlanWord = '这也太离谱了吧\n要短一点说也行';
ok('单个规划词不误删', stripThinkingLeak(onePlanWord) === onePlanWord);

console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
