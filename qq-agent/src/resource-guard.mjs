/**
 * 服务器资源守卫（2026-10-28，用户要求）。
 *
 * 用户原话：「在服务器优先保整文本回复不掉线，其他功能可以在读写快满时限制」
 *
 * 为什么需要：这台机器 2 核 3.5G、**没有 swap**，一次 dsh 子进程就要 450MB 上下。
 * 群里连甩几张图、或者后台整理任务撞在一起，内存直接见底：内核开始压缩内存，
 * sshd 连 banner 都吐不出来（2026-10-28 就这样卡了好几分钟，只能干等）。
 * 记忆里 2026-10-28 15:58 那次整体卡死更狠——三个 dsh 子进程各挂 48 分钟没回收。
 *
 * 所以分三档，越靠下的功能越先让步：
 *   ok        什么都不拦
 *   warn      后台任务（摘要 / 知识整理 / 习惯学习 / 记忆学习 / 定时说说）这一轮跳过
 *   critical  连媒体类（语音合成、看图描述、动图拆帧、翻唱、点歌）也不做
 *
 * 文本回复永远放行 —— 它是这台服务器上唯一必须活着的功能。
 * 读不到 /proc（比如在 Windows 上跑测试）一律 fail-open 当作 ok：
 * 守卫自己不能变成新的故障点。
 */
import fs from 'node:fs';
import os from 'node:os';

export const DEFAULT_GUARD = {
  enabled: true,
  checkMs: 10000,          // 读数缓存，别每个功能都去读 /proc
  // 任一条件越线就抬档；{ } 里留空表示那一条不检查
  warn: {
    memAvailableMb: 480,   // 可用内存低于这个就开始让后台让路
    diskFreeMb: 3000,      // 磁盘可用低于 3G
    loadPerCpu: 2,         // 1 分钟 load / 核数
  },
  critical: {
    memAvailableMb: 220,   // 低到这里只剩文本能活
    diskFreeMb: 800,
    loadPerCpu: 4,
  },
};

/** 把 config.json 的 guard 节和默认值合起来（只合一层，够用） */
export function guardConfig(cfg) {
  const raw = (cfg && cfg.raw && cfg.raw.guard) || {};
  const g = { ...DEFAULT_GUARD, ...raw };
  g.warn = { ...DEFAULT_GUARD.warn, ...(raw.warn || {}) };
  g.critical = { ...DEFAULT_GUARD.critical, ...(raw.critical || {}) };
  return g;
}

/**
 * 拿一份读数。读不到的项留 null，绝不抛异常。
 * @returns {{at:number, memAvailableMb:number|null, memTotalMb:number|null,
 *            swapUsedPct:number|null, diskFreeMb:number|null, loadPerCpu:number|null}}
 */
export function readSample({ root } = {}) {
  const s = {
    at: Date.now(),
    memAvailableMb: null, memTotalMb: null, swapUsedPct: null,
    diskFreeMb: null, loadPerCpu: null,
  };
  try {
    // Linux 才有 /proc/meminfo；没有就当作不知道（Windows 开发机）
    if (fs.existsSync('/proc/meminfo')) {
      const txt = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (key) => {
        const m = txt.match(new RegExp('^' + key + ':\\s+(\\d+) kB', 'm'));
        return m ? Number(m[1]) : null;
      };
      const avail = kb('MemAvailable');
      const total = kb('MemTotal');
      const swapTotal = kb('SwapTotal');
      const swapFree = kb('SwapFree');
      if (avail != null) s.memAvailableMb = avail / 1024;
      if (total != null) s.memTotalMb = total / 1024;
      if (swapTotal) s.swapUsedPct = ((swapTotal - (swapFree || 0)) / swapTotal) * 100;
    }
  } catch { /* fail-open */ }
  try {
    if (root && typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(root);
      s.diskFreeMb = (Number(st.bavail) * Number(st.bsize)) / 1024 / 1024;
    }
  } catch { /* fail-open */ }
  try {
    const la = typeof os.loadavg === 'function' ? os.loadavg()[0] : NaN;
    const cpus = (os.cpus() || []).length || 1;
    if (Number.isFinite(la) && la > 0) s.loadPerCpu = la / cpus;
  } catch { /* fail-open */ }
  return s;
}

/**
 * 纯函数：读数 → { level, reasons }。没有 readSample 那么娇气，方便测。
 * 任一项达到 critical 就是 critical；否则任一项达到 warn 就是 warn。
 */
export function classify(sample, limits = DEFAULT_GUARD) {
  const warn = limits.warn || {};
  const crit = limits.critical || {};
  const reasons = [];
  let level = 'ok';
  const raise = (next) => {
    if (next === 'critical') level = 'critical';
    else if (level === 'ok') level = 'warn';
  };
  const check = (value, warnAt, critAt, label, unit = '') => {
    // 读不到的项是 null，不能当 0 处理（0 会被判成「内存见底」）
    if (value === null || value === undefined || value === '') return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (Number.isFinite(critAt) && Number(critAt) > 0 && v < critAt) {
      raise('critical');
      reasons.push(`${label} ${Math.round(v)}${unit}`);
    } else if (Number.isFinite(warnAt) && Number(warnAt) > 0 && v < warnAt) {
      raise('warn');
      reasons.push(`${label} ${Math.round(v)}${unit}`);
    }
  };
  // 内存和磁盘是「越低越糟」，直接比下限
  check(sample?.memAvailableMb, warn.memAvailableMb, crit.memAvailableMb, '可用内存', 'MB');
  check(sample?.diskFreeMb, warn.diskFreeMb, crit.diskFreeMb, '磁盘可用', 'MB');
  // load 是「越高越糟」，翻个号塞进同一个比较器里
  const load = Number(sample?.loadPerCpu);
  if (Number.isFinite(load)) {
    const loadToFree = (perCpu) => (Number.isFinite(perCpu) && perCpu > 0 ? 100 - perCpu * 100 : NaN);
    // loadPerCpu 0.5 → 免费 50；>1 就变负数，跟内存的比较语义对不上，所以单独判
    if (Number.isFinite(crit.loadPerCpu) && crit.loadPerCpu > 0 && load > crit.loadPerCpu) {
      raise('critical');
      reasons.push(`负载 ${load.toFixed(1)}x核`);
    } else if (Number.isFinite(warn.loadPerCpu) && warn.loadPerCpu > 0 && load > warn.loadPerCpu) {
      raise('warn');
      reasons.push(`负载 ${load.toFixed(1)}x核`);
    }
    void loadToFree;
  }
  return { level, reasons };
}

/** 三个档位的中文说明，给人看的 */
const LEVEL_CN = { ok: '宽裕', warn: '紧张', critical: '快满' };

export class ResourceGuard {
  #c; #opt; #cache = null; #lastLog = { level: '', at: 0 };

  /**
   * @param {object} cfg 桥的配置（要用 cfg.raw.guard 和 cfg.agentCwd）
   * @param {{readSample?:Function, root?:string, now?:Function}} opts 测试注入用
   */
  constructor(cfg, opts = {}) {
    this.#c = guardConfig(cfg);
    this.#opt = opts;
  }

  /** 带缓存的读数：{ level, reasons, at, …采样 } */
  sample() {
    const now = (this.#opt.now || Date.now)();
    if (this.#cache && now - this.#cache.at < Math.max(1000, Number(this.#c.checkMs) || 10000)) {
      return this.#cache;
    }
    const read = this.#opt.readSample || readSample;
    let raw;
    try {
      raw = read({ root: this.#opt.root || process.cwd() }) || {};
    } catch {
      raw = {};
    }
    const { level, reasons } = classify(raw, this.#c);
    this.#cache = { ...raw, at: now, level, reasons };
    return this.#cache;
  }

  /**
   * 这次能不能做。kind：
   *   'text'  文本回复 —— 永远 ok
   *   'bg'    后台 agent 任务 —— 只要不是 ok 就跳过
   *   'media' 语音/看图/动图/翻唱/点歌 —— 只有 critical 才跳
   * @returns {{ok:boolean, level:string, reason:string}}
   */
  allow(kind) {
    if (!this.#c.enabled) return { ok: true, level: 'ok', reason: '' };
    const s = this.sample();
    const level = s.level || 'ok';
    if (kind === 'text') return { ok: true, level, reason: '文本回复永远放行' };
    if (kind === 'bg') {
      if (level === 'ok') return { ok: true, level, reason: '' };
      return { ok: false, level, reason: `后台任务这轮让路（${s.reasons.join('、')}）` };
    }
    if (level === 'critical') {
      return { ok: false, level, reason: `服务器${LEVEL_CN.critical}（${s.reasons.join('、')}），这个先不做` };
    }
    return { ok: true, level, reason: level === 'warn' ? `服务器${LEVEL_CN.warn}（${s.reasons.join('、')}），还能做` : '' };
  }

  /** 一行状态，给 #资源 命令和日志用 */
  line() {
    const s = this.sample();
    const parts = [];
    if (Number.isFinite(Number(s.memAvailableMb))) {
      parts.push(`内存可用 ${Math.round(s.memAvailableMb)}MB${Number.isFinite(Number(s.memTotalMb)) ? ' / ' + Math.round(s.memTotalMb) + 'MB' : ''}`);
    }
    if (Number.isFinite(Number(s.diskFreeMb))) parts.push(`磁盘可用 ${(s.diskFreeMb / 1024).toFixed(1)}G`);
    if (Number.isFinite(Number(s.loadPerCpu))) parts.push(`负载 ${s.loadPerCpu.toFixed(1)}x核`);
    const why = s.reasons && s.reasons.length ? `（${s.reasons.join('、')}）` : '';
    return `资源${LEVEL_CN[s.level] || s.level}${why} · ${parts.join(' · ') || '没读到数据'}`;
  }

  /** 档位变了才记一行日志，免得每轮刷屏 */
  noteLevel(note) {
    const s = this.sample();
    const now = (this.#opt.now || Date.now)();
    if (this.#lastLog.level === s.level && now - this.#lastLog.at < 10 * 60 * 1000) return;
    this.#lastLog = { level: s.level, at: now };
    if (s.level !== 'ok' && typeof note === 'function') note('info', `资源${LEVEL_CN[s.level] || s.level}：${s.reasons.join('、')}`);
  }
}

/** 桥里到处要用，给一个按 cfg 缓存实例的入口 */
const instanceCache = new WeakMap();
export function guardFor(cfg, opts) {
  if (!cfg || typeof cfg !== 'object') return new ResourceGuard({}, opts);
  let g = instanceCache.get(cfg);
  if (!g) { g = new ResourceGuard(cfg, opts); instanceCache.set(cfg, g); }
  return g;
}

/** 给「不能做」的场景准备一句人话，群聊和私聊口径一致 */
export function busyLine(kind) {
  return kind === 'media'
    ? '这会儿服务器有点挤，语音和图片先不折腾了，说话照样找我'
    : '后台整理先歇一轮，说话不受影响';
}
