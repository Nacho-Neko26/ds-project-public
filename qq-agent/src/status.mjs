/**
 * 状态注入（饱腹 / 时间 / 所在群）。
 *
 * 心情不再由这里算——2026-10-27 删掉旧的六档心情（正常/困/被夸/高兴/被说胖），
 * 统一走 emotion.mjs 的九档情绪引擎。这个文件只保留「跟情绪无关」的那部分状态：
 *   hunger: 饿 / 正常 / 饱   —— 按钟点推
 *   date/time/nextMeal/groupName
 */

/** 三餐：开始吃饭的钟点 */
const MEALS = [
  { name: '早饭', at: 7 },
  { name: '午饭', at: 11 },
  { name: '晚饭', at: 17 },
];

/** 饭点后「饿」持续多久（小时） */
const HUNGRY_HOURS = 2;
/** 饭后「饱」持续多久（小时） */
const FULL_HOURS = 1;

const pad = (n) => String(n).padStart(2, '0');

/** 距某个钟点的分钟数 */
function minutesUntil(fromHour, fromMinute, targetHour) {
  let diff = targetHour - fromHour;
  if (diff < 0) diff += 24;
  return diff * 60 - fromMinute;
}

function untilText(totalMin) {
  if (totalMin <= 0) return '现在';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

/** 算饱腹与下一餐 */
function computeHunger(now) {
  const hour = now.getHours();
  const minute = now.getMinutes();

  // 严格算「下一餐」：当前时刻之后最近的那个饭点
  const next = MEALS.find((m) => m.at > hour) || MEALS[0];
  const isTomorrow = next.at <= hour;
  const mins = minutesUntil(hour, minute, next.at);
  const nextMeal = `${untilText(mins)}（${isTomorrow ? '明天' : ''}${next.name}）`;

  // 落在某个饭点的 [at, at+HUNGRY_HOURS) → 饿
  for (const m of MEALS) {
    if (hour >= m.at && hour < m.at + HUNGRY_HOURS) return { hunger: '饿', nextMeal, mins };
  }
  // 落在 [at+HUNGRY_HOURS, at+HUNGRY_HOURS+FULL_HOURS) → 饱
  for (const m of MEALS) {
    if (hour >= m.at + HUNGRY_HOURS && hour < m.at + HUNGRY_HOURS + FULL_HOURS) {
      return { hunger: '饱', nextMeal, mins };
    }
  }
  return { hunger: '正常', nextMeal, mins };
}

const HUNGRY_NOTES = {
  饿: '话可以少点、提不起劲，但别不耐烦、别凶人；用语气带出一点懒，别挂「饿了」这种尾巴，也别拿饭挡正事',
  饱: '难得话多，愿意聊天，可主动起话头',
  正常: '',
};

/**
 * @param {object} p
 * @param {Date}   p.now
 * @param {string} [p.groupName] 群名；私聊传空
 * @returns {{date:string, time:string, hunger:string, nextMeal:string, showMeal:boolean, groupName:string, note:string}}
 */
export function computeStatus({ now, groupName }) {
  const hour = now.getHours();
  const { hunger, nextMeal, mins } = computeHunger(now);

  // 只有「不太饿但马上要开饭」才把饭点摆出来。
  // 正饿着不用报（饱腹那栏已经说了），离得远更不该报——
  // 每轮都提示「还有几小时吃饭」，模型会硬往饭上拐。
  const showMeal = hunger !== '饿' && mins <= 20;

  // 日期也给出来：定时提醒要算出「明天八点」到底是哪一天
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 周${WEEK[now.getDay()]}`;

  return {
    date,
    time: `${pad(hour)}:${pad(now.getMinutes())}`,
    hunger,
    nextMeal: showMeal ? nextMeal : '',
    showMeal,
    groupName: groupName || '私聊',
    note: HUNGRY_NOTES[hunger] || '',
  };
}
