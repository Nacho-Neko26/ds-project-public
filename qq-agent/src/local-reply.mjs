// 「用本机办」的回话（只管说什么，不管发不发得出去）。
//
// 和 cover-reply.mjs 一个路子：不写死整句，按槽位随机拼，免得每回都一个腔调。
// 红线也一样——不许把过程抖出来：不提本机 / 电脑 / 程序 / 任务 / 队列 / 服务器 /
// 文件路径 / 进度百分比。她只是「去弄了」，不是在汇报流水线。

const OPEN_OK = ['哼', '行吧', '诶嘿', '好嘞', '哟', '来啦'];
const OPEN_MISS = ['唔……', '诶', '哎呀', '嘶'];

const MID_OK = [
  '这就去弄',
  '我拿去弄一下',
  '这活我接了',
  '交给我',
  '我看看能不能弄',
];

const TAIL_OK = [
  '弄好了就给你',
  '一会儿给你看结果',
  '别催啊',
  '等我一下',
  '好了喊你',
];

const MID_MISS = [
  '这会儿弄不了',
  '我这会儿腾不出手',
  '手边没东西可用',
  '这会儿干不了这活',
];

const TAIL_MISS = [
  '回头给你弄',
  '等我能动了再说',
  '晚点补上',
  '下次再弄好不好',
];

const SHORT_OK = ['这就去弄', '等我一下', '我拿去弄', '接了'];
const SHORT_MISS = ['这会儿弄不了', '回头给你弄', '晚点补上'];

let last = '';
function pick(arr) {
  if (arr.length === 1) return arr[0];
  let v = arr[Math.floor(Math.random() * arr.length)];
  for (let i = 0; i < 4 && v === last; i += 1) v = arr[Math.floor(Math.random() * arr.length)];
  last = v;
  return v;
}

const join = (parts) => parts.filter(Boolean).join(' ');

/** 办得了：接了这活 */
export function pickLocalOkReply() {
  if (Math.random() < 0.15) return pick(SHORT_OK);
  return join([pick(OPEN_OK), pick(MID_OK), pick(TAIL_OK)]);
}

/** 办不了（那台机器这会儿不在） */
export function pickLocalMissReply() {
  if (Math.random() < 0.2) return pick(SHORT_MISS);
  return join([pick(OPEN_MISS), pick(MID_MISS), pick(TAIL_MISS)]);
}
