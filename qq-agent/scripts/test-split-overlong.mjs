// 2026-10-26：验证「一长条该断成两条」的修复。
// 用法：node scripts/test-split-overlong.mjs
import { splitMessages, splitOverlongMessage } from '../src/util.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const real = '唔…翻唱也一样卡在队列外面呀祈羽，写不进那个目录就是排不上号，要不你等等，能写了本鲸第一个唱给你听';

// 1. 用户点名的那句：48 字，必须在「号，」后面断，前面一条、后面一条
const out = splitOverlongMessage(real);
console.log('用例1 拆分结果：', JSON.stringify(out));
ok('拆成两条', out.length === 2);
ok('第一条以「号，」收尾', /排不上号，$/.test(out[0]), out[0]);
ok('第二条接着说完', out[1].startsWith('要不你等等'), out[1]);
ok('两条都非空且不超 40 字', out.every((s) => s && s.length <= 40));

// 2. 短句不该被动：同一句拆完再进一次是幂等的（不会切成三段）
ok('已经短了就不再切', splitOverlongMessage(out[1]).length === 1);

// 3. 功能性长文（>90 字）不动
const long = '排上了，本鲸这就去排队，前面还有两首，跑完直接发到这个会话，你先去忙别的，好了本鲸叫你，别一直盯着屏幕等，眼睛还要不要了，真当本鲸管不着你吗哼，再说了这歌本鲸唱起来肯定比原唱好听，到时候你可别听哭了';
ok('长文不切', splitOverlongMessage(long).length === 1, String(long.length));

// 4. 没有标点的长句不硬切
const noPunct = '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊';
ok('无标点不硬切', splitOverlongMessage(noPunct).length === 1);

// 5. 边界：刚好 40 字不切，41 字开始考虑
const b40 = '一'.repeat(20) + '，' + '二'.repeat(19);
ok('40 字不动', splitOverlongMessage(b40).length === 1, String(b40.length));

// 6. 单行 25+25 的两行短句现在能拆开了（阈值从 20/40 提到 28/56）
const twoLine = '今天这个队列是真的排不动了呀\n等能写进去了本鲸第一个唱给你听';
const sm = splitMessages(twoLine, { maxMessages: 5 });
console.log('用例6 两行短句：', JSON.stringify(sm));
ok('两行短句拆两条', sm.length === 2);

// 7. 整链路：splitMessages → splitOverlongMessage → chunkText
function chain(text) {
  return splitMessages(text, { maxMessages: 5 })
    .flatMap((p) => splitOverlongMessage(p))
    .flatMap((p) => (p.length > 700 ? [p.slice(0, 700), p.slice(700)] : [p]));
}
const chained = chain(real);
console.log('用例7 整链路：', JSON.stringify(chained));
ok('整链路出两条', chained.length === 2);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
