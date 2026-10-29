/**
 * 并发闸门。
 *
 * n      = 后台任务的槽数（agent.maxConcurrent）
 * extra  = 文本回复最多能超额几个（agent.criticalExtra，默认 1）
 * waitMs = 超额到顶后回复最多等多久槽（agent.criticalWaitMs，默认 45 秒）
 *
 * 2026-10-28 定了「文本回复永远不排队」，但那样群友一起说话时能同时起五六个 dsh，
 * 每个 450MB，3.5G 的机器直接见底。2026-10-29 用户拍板：紧急通道也给个上限。
 * 折中——到顶先等一会儿（别人答完就让他上），等到 waitMs 还没空位才硬放行，
 * 这样既不丢回复，也不会无限制地 spawn。
 */
export class Semaphore {
  constructor(n, opts = {}) {
    this.n = Math.max(1, n);
    this.extra = Number.isFinite(opts.extra) ? Math.max(0, opts.extra) : 1;
    this.waitMs = Number.isFinite(opts.waitMs) ? Math.max(0, opts.waitMs) : 45000;
    this.onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : () => {};
    this.queue = [];
    this.critQueue = [];
    this.timeouts = 0;
  }
  get cap() { return this.n + this.extra; }
  get used() { return this.active ?? 0; }
  async acquire(opts = {}) {
    const active = () => (this.active ?? 0);
    if (opts.critical) {
      if (active() < this.cap) { this.active = active() + 1; return; }
      const admitted = await new Promise((resolve) => {
        const w = { done: false };
        w.fn = () => {
          if (w.done) return;
          w.done = true;
          clearTimeout(w.timer);
          resolve(true);
        };
        w.timer = setTimeout(() => {
          if (w.done) return;
          w.done = true;
          const i = this.critQueue.indexOf(w);
          if (i >= 0) this.critQueue.splice(i, 1);
          resolve(false);
        }, this.waitMs);
        this.critQueue.push(w);
      });
      this.active = active() + 1;
      if (!admitted) {
        this.timeouts += 1;
        this.onWarn(`并发到顶（${active()} / 上限 ${this.cap}），等了 ${Math.round(this.waitMs / 1000)} 秒还排不上，这条回复先超额放行`);
      }
      return;
    }
    if (active() < this.n) { this.active = active() + 1; return; }
    await new Promise((r) => this.queue.push(r));
    this.active = active() + 1;
  }
  release() {
    this.active = Math.max(0, (this.active ?? 0) - 1);
    // 空出来的槽先给等着的文本回复，回复永远排在后台任务前面
    if (this.critQueue.length && (this.active ?? 0) < this.cap) {
      const w = this.critQueue.shift();
      if (w) { w.fn(); return; }
    }
    // 还有超额在跑就别再放队列里的，等降回上限再说
    if ((this.active ?? 0) >= this.n) return;
    const next = this.queue.shift();
    if (next) next();
  }
}
