import { stickerMoment, stickerSelfGate, lastStickerAt, SELF_STICKER_GAP_MS } from '../src/sticker-moment.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; } else { fail += 1; console.log(`FAIL ${name}`); }
}

// 情绪点：只认「无语」「激动」两类
ok('无语-服了', stickerMoment('服了，又来这套') === '无语');
ok('无语-省略号', stickerMoment('你倒是说句话啊……') === '无语');
ok('无语-离谱', stickerMoment('这也太离谱了') === '无语');
ok('激动-笑死', stickerMoment('笑死我了哈哈哈哈') === '激动');
ok('激动-太棒', stickerMoment('太棒了！') === '激动');
ok('普通-不平', stickerMoment('今天天气还行') === '');
ok('普通-干饭', stickerMoment('我去吃饭') === ''); // 干饭不再算情绪点

// 自动门：只看 1 分钟冷却，不看情绪也不掷骰子
const now = 1_000_000_000_000;
ok('冷却内', stickerSelfGate(now - 30_000, now) === false);
ok('冷却刚好满', stickerSelfGate(now - SELF_STICKER_GAP_MS, now) === true);
ok('没有台账记录', stickerSelfGate(0, now) === true);
ok('过了冷却一分钟', stickerSelfGate(now - 61_000, now) === true);

// lastStickerAt
ok('最近时间', lastStickerAt({ a: { at: 5 }, b: { at: 9 } }) === 9);
ok('空台账', lastStickerAt({}) === 0);

console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
