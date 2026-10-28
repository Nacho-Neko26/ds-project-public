/**
 * src/resource-guard.mjs 的单测（2026-10-28）。
 *
 * 不依赖服务器环境：内存读数和 load 都是注入的假数据，
 * 这样在 Windows 开发机上也能跑，不用等真把服务器压满。
 *
 * 跑法：node scripts/test-resource-guard.mjs
 */
import { DEFAULT_GUARD, guardConfig, classify, ResourceGuard, guardFor, busyLine } from '../src/resource-guard.mjs';

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fail += 1;
  fails.push(`${name}${extra ? ' → ' + extra : ''}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 一份宽裕的读数，各用例在它上面改坏的项 */
const healthy = {
  at: 0, memAvailableMb: 1800, memTotalMb: 3600, swapUsedPct: 0,
  diskFreeMb: 23000, loadPerCpu: 0.3,
};

/* ---------- classify：三档判定 ---------- */
eq('宽裕 → ok', classify(healthy).level, 'ok');
eq('可用内存 400MB → warn', classify({ ...healthy, memAvailableMb: 400 }).level, 'warn');
eq('可用内存 200MB → critical', classify({ ...healthy, memAvailableMb: 200 }).level, 'critical');
eq('磁盘 2G → warn', classify({ ...healthy, diskFreeMb: 2048 }).level, 'warn');
eq('磁盘 500MB → critical', classify({ ...healthy, diskFreeMb: 500 }).level, 'critical');
eq('负载 2.5x核 → warn', classify({ ...healthy, loadPerCpu: 2.5 }).level, 'warn');
eq('负载 5x核 → critical', classify({ ...healthy, loadPerCpu: 5 }).level, 'critical');
ok('reasons 会带出越线的项目', classify({ ...healthy, memAvailableMb: 200 }).reasons.some((r) => r.includes('可用内存')));
ok('内存 critical + 磁盘 warn 仍是 critical',
  classify({ ...healthy, memAvailableMb: 200, diskFreeMb: 2048 }).level === 'critical');
eq('同一项既 warn 又 critical 时取 critical',
  classify({ ...healthy, memAvailableMb: 200, diskFreeMb: 2048 }).level, 'critical');

/* ---------- classify：读不到也要 fail-open ---------- */
eq('全 null（Windows/权限不足）→ ok',
  classify({ at: 1, memAvailableMb: null, diskFreeMb: null, loadPerCpu: null }).level, 'ok');
eq('空对象 → ok', classify({}).level, 'ok');
eq('loadPerCpu 为 0（容器里常见）不误判', classify({ ...healthy, loadPerCpu: 0 }).level, 'ok');

/* ---------- guardConfig：默认值 + 覆盖 ---------- */
{
  const g = guardConfig({ raw: {} });
  eq('没配 guard 时用默认阈值', g.critical.memAvailableMb, DEFAULT_GUARD.critical.memAvailableMb);
  const g2 = guardConfig({ raw: { guard: { enabled: false, warn: { memAvailableMb: 900 } } } });
  eq('enabled 可以被覆盖', g2.enabled, false);
  eq('warn 单条可以被覆盖', g2.warn.memAvailableMb, 900);
  eq('没写的 warn 项保留默认', g2.warn.diskFreeMb, DEFAULT_GUARD.warn.diskFreeMb);
  eq('critical 整节保留默认', g2.critical.loadPerCpu, DEFAULT_GUARD.critical.loadPerCpu);
}

/* ---------- ResourceGuard.allow：分级矩阵 ---------- */
function makeGuard(sample, guardRaw = {}) {
  let t = 1000;
  return new ResourceGuard({ raw: { guard: guardRaw } }, {
    readSample: () => ({ ...sample }),
    now: () => (t += 20000),  // 每一步都跨过缓存窗口
    root: '.',
  });
}

{
  const g = makeGuard(healthy);
  let r = g.allow('text');
  ok('宽裕：文本放行', r.ok && r.level === 'ok');
  r = g.allow('bg');
  ok('宽裕：后台放行', r.ok);
  r = g.allow('media');
  ok('宽裕：媒体放行', r.ok);
}

{
  const g = makeGuard({ ...healthy, memAvailableMb: 400 });
  ok('紧张：文本仍然放行', g.allow('text').ok);
  const bg = g.allow('bg');
  ok('紧张：后台让路', !bg.ok, bg.reason);
  ok('紧张：后台让路的理由里带读数', /可用内存/.test(bg.reason));
  const media = g.allow('media');
  ok('紧张：媒体还能做', media.ok);
}

{
  const g = makeGuard({ ...healthy, memAvailableMb: 150 });
  ok('快满：文本仍然放行（唯一必须活的）', g.allow('text').ok);
  const bg = g.allow('bg');
  ok('快满：后台跳', !bg.ok);
  const media = g.allow('media');
  ok('快满：媒体也跳', !media.ok, media.reason);
  ok('快满：媒体的理由是人话', /服务器/.test(media.reason));
}

{
  const g = makeGuard({ ...healthy, memAvailableMb: 150 }, { enabled: false });
  ok('守卫关掉：后台照跑', g.allow('bg').ok);
  ok('守卫关掉：媒体照跑', g.allow('media').ok);
}

/* ---------- 缓存：窗口内不重复采样 ---------- */
{
  let reads = 0;
  let t = 1000;
  const g = new ResourceGuard({ raw: {} }, {
    readSample: () => { reads += 1; return { ...healthy, at: t }; },
    now: () => t,
    root: '.',
  });
  g.sample(); g.sample(); g.sample();
  eq('缓存窗口内只读一次 /proc', reads, 1);
  t += 60_000;
  g.sample();
  eq('过了窗口会重新采样', reads, 2);
}

/* ---------- 读数异常不能把桥带崩 ---------- */
{
  const g = new ResourceGuard({ raw: {} }, {
    readSample: () => { throw new Error('boom'); },
    now: () => Date.now(),
    root: '.',
  });
  ok('采样器抛异常也返回 ok（fail-open）', g.allow('bg').ok);
  ok('line() 不抛异常', typeof g.line() === 'string');
  ok('line() 在没数据时也有话说', g.line().length > 0);
}

/* ---------- guardFor：同一个 cfg 复用实例 ---------- */
{
  const cfg = { raw: {} };
  ok('guardFor 复用实例', guardFor(cfg) === guardFor(cfg));
  ok('不同 cfg 不共用', guardFor({ raw: {} }) !== guardFor({ raw: {} }));
}

/* ---------- 提示语 ---------- */
ok('媒体提示语带「语音」', busyLine('media').includes('语音'));
ok('后台提示语说说话不受影响', busyLine('bg').includes('说话'));

/* ---------- 汇总 ---------- */
console.log(`[resource-guard] pass=${pass} fail=${fail}`);
if (fail) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('[resource-guard] 全部通过');
}
