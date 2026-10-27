/**
 * 真实环境数据（2026-10-23 用户要求）。
 *
 * 她不能编造客观事实。但要她不编，就得**先给她真数据**——所以桥替她去拿：
 * 时间、气温、天气、湿度、风、有没有在下雨，地点固定在杭州
 * （默认按杭州取实况，可用 config.json → ambient 覆盖）。
 *
 * 数据源 open-meteo（免 key），缓存半小时；断网就退回上一次的缓存，
 * 缓存也没有就不注入——宁可她说「不清楚」，也别让她编。
 */
import fs from 'node:fs';
import path from 'node:path';

const LAT = 30.2741;
const LON = 120.1551;
const TZ = 'Asia/Shanghai';
const CACHE_MS = 30 * 60 * 1000;

/** WMO 天气代码 → 中文 */
const WMO = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

function cacheFile(agentCwd) {
  return path.join(agentCwd, 'ambient.json');
}

function readCache(agentCwd) {
  try {
    const f = cacheFile(agentCwd);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* 坏了当没有 */ }
  return null;
}

function writeCache(agentCwd, data) {
  try {
    fs.writeFileSync(cacheFile(agentCwd), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 写不了就算了 */ }
}

/**
 * 取当前实况。缓存不超时就别再打网络。
 * @returns {Promise<null|{at:number, temp:number, humidity:number, wind:number, code:number, desc:string, raining:boolean, precip:number}>}
 */
export async function getAmbient(agentCwd, { force = false } = {}) {
  const cached = readCache(agentCwd);
  if (!force && cached && Date.now() - Number(cached.at || 0) < CACHE_MS) return cached;

  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${LAT}&longitude=${LON}`
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation'
    + `&timezone=${encodeURIComponent(TZ)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const c = j.current || {};
    const code = Number(c.weather_code);
    const precip = Number(c.precipitation);
    const data = {
      at: Date.now(),
      temp: Number(c.temperature_2m),
      humidity: Number(c.relative_humidity_2m),
      wind: Number(c.wind_speed_10m),
      code,
      desc: WMO[code] ?? `天气代码 ${code}`,
      precip: Number.isFinite(precip) ? precip : 0,
      raining: (Number.isFinite(precip) && precip > 0) || (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95,
    };
    writeCache(agentCwd, data);
    return data;
  } catch {
    // 网络挂了：用旧缓存（超过半小时也好过没有），再不行就 null
    return cached || null;
  }
}

/**
 * 渲染成 prompt 里那段「真实情况」。
 * 写清楚「只有这些是真的，别的别编」，把她最容易编的天气堵死。
 */
export function renderAmbient(a, now = new Date()) {
  if (!a) {
    return '【真实情况】拿不到外面的实况数据。所以天气、温度这些**你不知道**，'
      + '被问到就「不清楚」「猜猜」或者岔开，别顺口说一个。';
  }
  const t = new Date(a.at);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const lines = [
    '【真实情况】（杭州第七机房这边，程序刚查的，可以当成真的说）',
    `气温 ${a.temp}°C，${a.desc}，湿度 ${a.humidity}%，风 ${a.wind} km/h，`
      + `${a.raining ? '现在在下雨' : '现在没下雨'}。（数据时间 ${hhmm}）`,
    '**这几项以程序给的为准。** 就算你上网搜到不一样的说法（网页经常是几小时前的、或者写的是别的区），'
      + '当前气温/天气也以上面这行为准，别跟它对着说。',
    '**除此之外的客观事实**（别人的事、新闻、你根本没看到的画面），你不知道就说「不清楚」「猜猜」，'
      + '或者岔开话题——别编。',
    '要是被人拿事实纠正了，别嘴硬：认「唔……是我说错了，对不起」就够了，别长篇解释，也别硬圆。',
  ];
  return lines.join('\n');
}
