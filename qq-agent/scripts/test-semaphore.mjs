// 并发闸门单测：node scripts/test-semaphore.mjs
// 不碰服务器、不 spawn 任何东西，纯逻辑。
import { Semaphore } from '../src/semaphore.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ' — ' + extra : ''}`);
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// 1. 后台任务：n 个直接进，第 n+1 个排队
{
  const s = new Semaphore(2, { extra: 1, waitMs: 50 });
  await s.acquire(); await s.acquire();
  ok('后台两个槽都占上', s.used === 2, `used=${s.used}`);
  let admitted = false;
  const p = s.acquire().then(() => { admitted = true; });
  await tick();
  ok('第三个后台任务在排队', admitted === false && s.used === 2 && s.queue.length === 1);
  s.release();
  await p;
  ok('放开一个后第三个被放进来', admitted === true && s.used === 2, `used=${s.used}`);
}

// 2. 文本回复能超额，但只超额 extra 个
{
  const s = new Semaphore(1, { extra: 1, waitMs: 40 });
  await s.acquire();                    // 后台占 1
  await s.acquire({ critical: true });  // 超额 1
  ok('超额一个放行', s.used === 2, `used=${s.used}`);
  ok('超额后 used 达到 cap', s.used === s.cap);
  let admitted = false;
  const p = s.acquire({ critical: true }).then(() => { admitted = true; });
  await tick();
  ok('第二个超额回复要等', admitted === false && s.critQueue.length === 1);
  s.release();                          // 腾出一个槽
  await p;
  ok('腾出槽后等的回复立刻上', admitted === true, `used=${s.used}`);
}

// 3. 等到超时还没空位：硬放行，并报一次警
{
  const warns = [];
  const s = new Semaphore(1, { extra: 0, waitMs: 30, onWarn: (m) => warns.push(m) });
  await s.acquire();                    // 占满 cap=1
  const t0 = Date.now();
  await s.acquire({ critical: true });
  const waited = Date.now() - t0;
  ok('超额到顶会等一段再看', waited >= 25, `waited=${waited}ms`);
  ok('等不到也照样放行（回复不能丢）', s.used === 2, `used=${s.used}`);
  ok('超时放行写了告警', warns.length === 1 && /并发到顶/.test(warns[0]), warns[0]);
  ok('超时计数 +1', s.timeouts === 1);
}

// 4. 槽先给回复，不给后台：release 后后台任务还被压着
{
  const s = new Semaphore(1, { extra: 1, waitMs: 500 });
  await s.acquire();                          // 后台占 1
  await s.acquire({ critical: true });        // 超额占 1 → used=2
  let critDone = false;
  let bgDone = false;
  const pc = s.acquire({ critical: true }).then(() => { critDone = true; });
  await tick();
  // 再排一个后台任务（此刻 used=2 >= n=1，它排在 queue 里）
  const pb = s.acquire().then(() => { bgDone = true; });
  await tick();
  ok('后台任务没有插队', bgDone === false);
  s.release();                                // used 2→1，应把回复放进去
  await pc;
  ok('空出的槽给了排队的回复', critDone === true && bgDone === false, `used=${s.used}`);
  s.release();                                // used 2→1，回复还占着，后台仍不该上
  await tick();
  ok('回复还占着时后台继续等', bgDone === false, `used=${s.used}`);
  s.release();                                // used 1→0，腾干净
  await pb;
  ok('后台任务最后才轮到', bgDone === true);
}

// 5. 后台释放时如果还在超额状态，不放队列里的后台任务
{
  const s = new Semaphore(1, { extra: 2, waitMs: 500 });
  await s.acquire();
  await s.acquire({ critical: true });
  await s.acquire({ critical: true });   // used=3 = cap
  s.release();                            // used=2 >= n → 队列不排
  ok('还在超额时后台任务继续等着', s.used === 2 && s.queue.length === 0);
  ok('没有回复排队时 critQueue 为空', s.critQueue.length === 0);
}

// 6. 默认值
{
  const s = new Semaphore(3);
  ok('默认 extra=1', s.extra === 1);
  ok('默认 waitMs=45000', s.waitMs === 45000);
  ok('cap=n+extra', s.cap === 4);
  const s0 = new Semaphore(0);
  ok('n 至少 1', s0.n === 1);
}

// 7. 释放到 0 不会变负
{
  const s = new Semaphore(1);
  s.release(); s.release();
  ok('used 不会变负', s.used === 0, `used=${s.used}`);
}

if (fails.length) {
  console.log(`✗ ${fails.length} 条没过（通过 ${pass}）`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`✓ 并发闸门 ${pass} 条断言全过`);
