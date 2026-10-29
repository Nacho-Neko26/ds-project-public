#!/usr/bin/env node
/**
 * loop-guard 单测（纯逻辑，不碰服务器、不碰真进程）
 * 跑：node scripts/test-loop-guard.mjs
 */
import {
  LIMITS,
  parseJournal,
  parsePs,
  parseMemAvailableMb,
  parseLoad1,
  normalizeMsg,
  detectLiveness,
  detectStuckTurn,
  detectSlowTurns,
  detectErrorLoop,
  detectRepeatReply,
  detectTokenBurn,
  detectResources,
  detectSelfGap,
  detectLocal,
  describeLocal,
} from './loop-guard.mjs';

let pass = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}
const ids = (list) => list.map((f) => f.id);

/* ---------- 解析 ---------- */
const now = Date.parse('2026-10-29T18:00:00+08:00');
const journalRaw = [
  '[2026-10-29 17:48:38] INFO  已登录账号：溟月 (100000002)',
  '[2026-10-29 17:52:01] INFO  [private:100000001] 2 条 / 19 字（3200ms = 准备 800 + 模型 1800 + 发送 600）',
  '[2026-10-29 17:53:02] INFO  [group:200000001] 1 条 / 7 字 + 表情 S283（5100ms = 准备 900 + 模型 3000 + 发送 1200）',
  '[2026-10-29 17:54:03] WARN  [group:200000001] 语音发送失败：timeout 30000',
  '[2026-10-29 17:54:04] WARN  [group:200000001] 语音发送失败：timeout 30000',
  'not a structured line',
].join('\n');
const j = parseJournal(journalRaw);
eq(j.lines.length, 5, '结构化日志行数');
eq(j.replies.length, 2, '回复行数');
eq(j.replies[0].key, 'private:100000001', '回复会话 key');
eq([j.replies[0].parts, j.replies[0].chars, j.replies[0].ms], [2, 19, 3200], '回复条数/字数/耗时');
eq(j.replies[1].chars, 7, '带表情的回复字数');
eq(j.errors.length, 2, '警告/报错行数');
eq(j.replies[0].ts, Date.parse('2026-10-29T17:52:01+08:00'), '北京时间解析');
eq(normalizeMsg('余额 4.34 CNY，第 12 次'), '余额 #.# CNY，第 # 次', '抹数字判同');

eq(parsePs('  PID  PPID ETIMES %CPU   RSS COMMAND\n 1234     1   1200  3.1 460000 /usr/bin/node .../dsh.js run\n 99     1      5  0.0  12000 ps -eo') .length, 2, 'ps 行解析');
eq(parsePs('bogus') .length, 0, 'ps 乱码不崩');
eq(parseMemAvailableMb('MemTotal: 3584 kB\nMemAvailable:  512345 kB\n'), 500, '可用内存 MB');
eq(parseMemAvailableMb('no such field'), null, '读不到内存返回 null');
eq(parseLoad1('1.25 0.80 0.50 2/200 12345'), 1.25, '负载 first');
eq(parseLoad1('garbage'), null, '负载乱码返回 null');

/* ---------- 活着吗 ---------- */
eq(ids(detectLiveness({ bridgeActive: false, status: null })), ['bridge-down'], '服务挂了');
eq(detectLiveness({ bridgeActive: false, status: null })[0].action.kind, 'restart-bridge', '服务挂了要重启');
eq(ids(detectLiveness({ bridgeActive: true, status: { connected: false } })), ['qq-offline'], 'QQ 掉线报警');
eq(ids(detectLiveness({ bridgeActive: true, status: { connected: false }, connectFails: 1 })), ['qq-offline', 'qq-offline-sustained'], '掉线持续');
eq(ids(detectLiveness({ bridgeActive: true, status: { connected: true } })), [], '一切正常不报');

/* ---------- 卡死的轮次 ---------- */
const oldReply = [{ ts: now - 11 * 60_000, key: 'k', parts: 1, chars: 5, ms: 1000 }];
eq(ids(detectStuckTurn({ busyStreak: 3, replies: oldReply, now })), ['stuck-turn'], '忙三次且久无回复=卡死');
eq(detectStuckTurn({ busyStreak: 3, replies: oldReply, now })[0].action.kind, 'restart-bridge', '卡死要重启');
eq(ids(detectStuckTurn({ busyStreak: 2, replies: oldReply, now })), [], '只忙两次先不动');
eq(ids(detectStuckTurn({ busyStreak: 5, replies: [{ ts: now - 60_000, key: 'k', parts: 1, chars: 5, ms: 1000 }], now })), [], '刚有回复就不算卡死');
eq(ids(detectStuckTurn({ busyStreak: 5, replies: [], now })), ['stuck-turn'], '日志里一条回复都没有也算卡死');

/* ---------- 单轮太慢 ---------- */
eq(detectSlowTurns({ replies: [{ ts: now - 60_000, key: 'k', parts: 1, chars: 5, ms: LIMITS.slowTurnMs + 1 }], now })[0].level, 'info', '刚过线只是 info');
eq(detectSlowTurns({ replies: [{ ts: now - 60_000, key: 'k', parts: 1, chars: 5, ms: 2 * LIMITS.slowTurnMs + 1 }], now })[0].level, 'warn', '两倍线是 warn');
eq(detectSlowTurns({ replies: [{ ts: now - 60 * 60_000, key: 'k', parts: 1, chars: 5, ms: 600_000 }], now }).length, 0, '窗口外的不算');

/* ---------- 错误环 ---------- */
const errs = (n) => Array.from({ length: n }, (_, i) => ({ ts: now - i * 1000, level: 'WARN', norm: '语音发送失败', msg: '语音发送失败：timeout 30000' }));
eq(ids(detectErrorLoop({ errors: errs(LIMITS.errorRepeat), now })), ['error-loop'], '刷满次数报错环');
eq(ids(detectErrorLoop({ errors: errs(LIMITS.errorRepeat - 1), now })), [], '差一条不报');
eq(ids(detectErrorLoop({ errors: errs(20).map((e) => ({ ...e, ts: now - 6 * 60_000 })), now })), [], '窗口外不报');

/* ---------- 复读环 ---------- */
const rep = (n, gap = 30_000) => Array.from({ length: n }, (_, i) => ({ ts: now - (n - i) * gap, key: 'group:1', parts: 2, chars: 11, ms: 2000 }));
eq(ids(detectRepeatReply({ replies: rep(LIMITS.repeatReplyRun), now })), ['repeat-reply'], '连四条一模一样=复读');
eq(ids(detectRepeatReply({ replies: rep(3), now })), [], '连三条先不报');
eq(ids(detectRepeatReply({ replies: rep(5, 120_000), now })), [], '间隔太散不算复读');
const mixed = [{ ts: now - 300_000, key: 'group:1', parts: 1, chars: 3, ms: 1 }, ...rep(4)];
eq(ids(detectRepeatReply({ replies: mixed, now })), ['repeat-reply'], '前面说别的也不算打断');

/* ---------- 空转 ---------- */
const st = (turns, replied, received, tokensIn) => ({ stats: { turns, replied, received, tokensIn } });
// prev 是落盘时的扁平快照（state.prevStats），不是 status 的 stats 结构
const prevOf = (turns, replied, received, tokensIn) => ({ turns, replied, received, tokensIn });
const b = detectTokenBurn({ status: st(20, 5, 10, 90000), prev: prevOf(12, 5, 8, 40000), burnStreak: 3 });
eq(ids(b.findings), ['token-burn'], '连烧四段没回复=空转');
eq(b.burnStreak, 4, '空转计数累加');
const b2 = detectTokenBurn({ status: st(20, 6, 10, 90000), prev: prevOf(12, 5, 8, 40000), burnStreak: 3 });
eq(ids(b2.findings), [], '有回复就不算空转');
eq(b2.burnStreak, 0, '有回复就清零');
eq(ids(detectTokenBurn({ status: st(0, 0, 5, 0), prev: prevOf(0, 0, 1, 0), burnStreak: 0 }).findings), ['mute-flow'], '进消息但模型没跑=哑了');
const ignoredSt = { stats: { turns: 0, replied: 0, received: 9, ignored: 9, tokensIn: 0 } };
eq(ids(detectTokenBurn({ status: ignoredSt, prev: { turns: 0, replied: 0, received: 5, ignored: 5, tokensIn: 0 }, burnStreak: 0 }).findings), [], '群里没叫她的消息不算哑了');
eq(ids(detectTokenBurn({ status: null, prev: prevOf(1, 1, 1, 1) }).findings), [], '拿不到状态不误报');

/* ---------- 资源与僵尸 ---------- */
eq(ids(detectResources({ memAvailMb: 200, load1: 0.5, cpus: 2, procs: [] })), ['mem-low'], '内存见底');
eq(ids(detectResources({ memAvailMb: 2000, load1: 5, cpus: 2, procs: [] })), ['load-high'], '负载过高');
eq(ids(detectResources({ memAvailMb: 2000, load1: 0.5, cpus: 2, procs: [] })), [], '资源正常');
const zombie = [{ pid: 4242, ppid: 1, etimes: LIMITS.zombieSec + 60, pcpu: 0.2, rssKb: 460000, args: 'node /root/.dsh-runtime/.../dsh.js run --json' }];
const zf = detectResources({ memAvailMb: 2000, load1: 0.5, cpus: 2, procs: zombie });
eq(ids(zf), ['zombie-dsh'], 'dsh 活过十五分钟');
eq(zf[0].action, { kind: 'kill', pid: 4242 }, '僵尸要杀掉');
eq(ids(detectResources({ memAvailMb: 2000, load1: 0.5, cpus: 2, procs: [{ ...zombie[0], etimes: 30 }] })), [], '正常的 dsh 不动');
eq(ids(detectResources({ memAvailMb: 2000, load1: 0.5, cpus: 2, procs: [{ ...zombie[0], args: 'node scripts/loop-guard.mjs' }] })), [], '看守自己不算僵尸');

/* ---------- 看守自己 ---------- */
eq(ids(detectSelfGap({ lastRunAt: now - 10 * 60_000, now })), ['guard-gap'], '心跳断了要报');
eq(ids(detectSelfGap({ lastRunAt: now - 60_000, now })), [], '刚跑过不报');
eq(ids(detectSelfGap({ lastRunAt: 0, now })), [], '第一次跑不报');

/* ---------- 本机执行器 ---------- */
const localOk = { ts: now - 30_000, jobs: 5, fails: 0, fail_streak: 0, current: null, repeats: [] };
eq(ids(detectLocal({ health: localOk, now })), [], '本机正常不报');
eq(ids(detectLocal({ health: null, now })), ['local-silent'], '没上报过只记 info');
eq(detectLocal({ health: null, now })[0].level, 'info', '没上报过不算告警');
eq(ids(detectLocal({ health: { ...localOk, ts: now - 9 * 60_000 }, now })), ['local-stale'], '本机 9 分钟没上报');
eq(ids(detectLocal({ health: { ...localOk, current: { id: 'j9', elapsed: 700 } }, now })), ['local-task-long'], '本机任务跑 11 分钟');
eq(ids(detectLocal({ health: { ...localOk, current: { id: 'j9', elapsed: 1900 } }, now })), ['local-task-stuck'], '本机任务跑 31 分钟');
eq(detectLocal({ health: { ...localOk, current: { id: 'j9', elapsed: 1900 } }, now })[0].level, 'critical', '跑过半小时算 critical');
eq(ids(detectLocal({ health: { ...localOk, current: { id: 'j9', elapsed: 120 } }, now })), [], '本机任务两分钟不报');
eq(ids(detectLocal({ health: { ...localOk, repeats: [{ task: '把文件改成 #', count: 3 }] }, now })), ['local-repeat'], '同一个任务被塞三次');
eq(ids(detectLocal({ health: { ...localOk, repeats: [{ task: 'x', count: 2 }] }, now })), [], '塞两次还没到阈值');
eq(ids(detectLocal({ health: { ...localOk, fail_streak: 3 }, now })), ['local-fails'], '本机连挂三次');
eq(ids(detectLocal({ health: { ...localOk, fail_streak: 2 }, now })), [], '挂两次不算');
const combo = detectLocal({
  health: { ...localOk, ts: now - 10 * 60_000, current: { id: 'j1', elapsed: 1900 }, repeats: [{ task: 'x', count: 4 }], fail_streak: 3 },
  now,
});
eq(ids(combo).sort(), ['local-fails', 'local-repeat', 'local-stale', 'local-task-stuck'], '几件事一起出');
eq(describeLocal(null), '本机 无上报', '没上报的日志措辞');
eq(describeLocal(localOk), '本机 闲(5 单)', '闲着的日志措辞');
eq(describeLocal({ ...localOk, current: { id: 'j3', elapsed: 42 } }), '本机 忙(j3 42s)', '忙着的日志措辞');

/* ---------- 结果 ---------- */
if (fails.length) {
  console.error(`✗ 循环看守 ${fails.length} 条没过：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 循环看守 ${pass} 条断言全过`);
