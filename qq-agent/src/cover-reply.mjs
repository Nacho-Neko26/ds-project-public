// 翻唱/清唱的回话（只负责「说什么」，不管发不发得出去）
//
// 为什么单独一个文件：这几句话会经常调，而用户明确要求「不要定死内容」——
// 所以这里不写整句，改成按槽位随机拼：开口 + 状态 + 收尾，各给几个变体，
// 拼出来的句子每次都不一样，但语气和长度稳得住。
//
// 红线（用户 2026-10-26 定的）：不许出现「排队 / 本机 / 电脑 / 程序 / 任务 /
// 服务器 / 开机 / 文件 / 语音条 / 秒数」这类把过程抖出来的词。
// 说人话：她真的准备去唱，不是在报流水线进度。

const OPEN_IDLE = ['哼', '来啦', '好嘞', '诶嘿', '哟', '来咯'];
const OPEN_MISS = ['唔……', '诶', '哎呀', '哟', '嘶'];

const MID_READY = [
  '这首本鲸会',
  '本鲸先去开个嗓',
  '这就去清个嗓子',
  '得先热热嗓子才行',
  '本鲸这就准备',
  '嗓子先醒一醒',
];

const TAIL_READY = [
  '一会儿唱给你听',
  '别走开啊',
  '等本鲸一下',
  '马上就好',
  '一会儿就好',
];

const MID_FULL = [
  '整首啊',
  '整首有点长',
  '呵 要求还挺高',
  '整首就整首',
];

const TAIL_FULL = [
  '那要多等一会儿 本鲸慢慢录',
  '本鲸慢慢唱 好了端给你',
  '别急 本鲸一句一句来',
  '慢慢来才唱得好',
];

const MID_MISS = [
  '本鲸这会儿不在家呀',
  '本鲸的声音落在别处了',
  '嗓子跟着本鲸出门了',
  '这会儿开不了嗓',
  '本鲸人还在外头',
];

const TAIL_MISS = [
  '等我回来再给你{word}好不好',
  '回头补给你',
  '等本鲸回来 第一个唱给你听',
  '回来就补上',
  '晚点补给你听',
];

// 很短的一句，偶尔用，显得没那么机械
const SHORT_READY = ['等本鲸一下', '马上开嗓', '这就来', '稍等嘛'];
const SHORT_MISS = ['等本鲸回来', '这会儿真唱不了', '回头补上', '人不在家呢'];

let lastPicked = '';
// 同一段话别连着说两遍（上一轮挑过的这一轮尽量换一个）
function pick(arr) {
  if (arr.length === 1) return arr[0];
  let v = arr[Math.floor(Math.random() * arr.length)];
  for (let i = 0; i < 4 && v === lastPicked; i += 1) {
    v = arr[Math.floor(Math.random() * arr.length)];
  }
  lastPicked = v;
  return v;
}

function join(parts) {
  return parts.filter(Boolean).join(' ');
}

/** 在线：她准备去唱了（含整首那种要多等一会儿的口吻） */
export function pickOnlineReply(word = '翻唱', { full = false } = {}) {
  if (Math.random() < 0.12) return pick(SHORT_READY);
  return join([
    pick(OPEN_IDLE),
    full ? pick(MID_FULL) : pick(MID_READY),
    pick(full ? TAIL_FULL : TAIL_READY),
  ]);
}

/** 离线：唱不了，得等人回来（不提为什么，只说她人不在） */
export function pickOfflineReply(word = '翻唱') {
  if (Math.random() < 0.15) return pick(SHORT_MISS);
  return join([pick(OPEN_MISS), pick(MID_MISS), pick(TAIL_MISS).replace('{word}', word)]);
}
