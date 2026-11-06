/**
 * 线程池的纯调度器：不碰模型、不碰文件，只决定「这一件事交给谁」。
 *
 * 规则只有一条：**空闲保底**（reserveIdle，默认 1）。
 *   · 空闲线程多于保底 → 复用最久没动的那条；
 *   · 否则池子没满 → 开一条新线程（这样交出任务后，保底仍然在）；
 *   · 池子满了 → 排队；onFull='borrow' 时才临时借用保底那条，用完立刻还回来。
 *
 * 这条规则直接对应「始终有一个线程处于空闲状态」：
 * 同时有 2 件事在跑时，池子里其实是 3 条线程（2 忙 + 1 闲），
 * 第 3 件事进来就会开第 4 条（3 忙 + 1 闲），直到 maxThreads。
 */
export type ThreadState = 'idle' | 'running';

/** 池子满时怎么办：排队等，或临时借用保底的空闲线程。 */
export type FullPolicy = 'queue' | 'borrow';

export interface PoolOptions {
  /** 线程总数上限，至少 1。 */
  maxThreads: number;
  /** 空闲保底，0 表示不保底。会被压到 maxThreads - 1（maxThreads=1 时为 0）。 */
  reserveIdle: number;
  onFull: FullPolicy;
}

export interface PoolCounts {
  size: number;
  idle: number;
  running: number;
  queued: number;
  max: number;
  reserve: number;
  /** 此刻是否满足空闲保底。 */
  reserveMet: boolean;
}

/** plan() 的结论：复用一条空闲线程、开一条新的、或排队。 */
export type PoolPlan =
  | { kind: 'reuse'; threadId: string }
  | { kind: 'spawn' }
  | { kind: 'queue' };

function normalize(opts: PoolOptions): PoolOptions {
  const maxThreads = Math.max(1, Math.floor(opts.maxThreads || 1));
  const reserveIdle = Math.min(Math.max(0, Math.floor(opts.reserveIdle || 0)), maxThreads - 1);
  const onFull: FullPolicy = opts.onFull === 'borrow' ? 'borrow' : 'queue';
  return { maxThreads, reserveIdle, onFull };
}

/** 队列元素由调用方定义，池子不解释。 */
export class ThreadPool<T = unknown> {
  private readonly states = new Map<string, ThreadState>();
  /** 空闲线程的 LRU 顺序：队首最久没动。 */
  private readonly idleOrder: string[] = [];
  private readonly waiting: T[] = [];
  private opts: PoolOptions;

  constructor(opts: PoolOptions) {
    this.opts = normalize(opts);
  }

  get options(): PoolOptions {
    return { ...this.opts };
  }

  /** 配置是活引用，改完下一次 plan() 立即生效。 */
  setOptions(opts: PoolOptions): void {
    this.opts = normalize(opts);
  }

  get counts(): PoolCounts {
    let idle = 0;
    for (const state of this.states.values()) if (state === 'idle') idle++;
    return {
      size: this.states.size,
      idle,
      running: this.states.size - idle,
      queued: this.waiting.length,
      max: this.opts.maxThreads,
      reserve: this.opts.reserveIdle,
      reserveMet: idle >= this.opts.reserveIdle,
    };
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** 登记一条线程（默认空闲）。id 重复时按 add 的时刻重新排队。 */
  add(id: string, state: ThreadState = 'idle'): void {
    this.states.set(id, state);
    if (state === 'idle' && !this.idleOrder.includes(id)) this.idleOrder.push(id);
  }

  /** 移除一条线程；它若在队列里不受影响，队列是任务而不是线程。 */
  remove(id: string): void {
    this.states.delete(id);
    const at = this.idleOrder.indexOf(id);
    if (at >= 0) this.idleOrder.splice(at, 1);
  }

  has(id: string): boolean {
    return this.states.has(id);
  }

  stateOf(id: string): ThreadState | undefined {
    return this.states.get(id);
  }

  /** 清空池子（停 World 后重新挂载时用）。 */
  clear(): void {
    this.states.clear();
    this.idleOrder.length = 0;
    this.waiting.length = 0;
  }

  /** 拿走最久没动的空闲线程 id，不改变状态。 */
  private oldestIdle(): string | null {
    for (const id of [...this.idleOrder]) {
      if (this.states.get(id) === 'idle') return id;
      const at = this.idleOrder.indexOf(id);
      if (at >= 0) this.idleOrder.splice(at, 1);
    }
    return null;
  }

  /** 只做决定，不改状态；调用方执行后再 assign() / enqueue()。 */
  plan(): PoolPlan {
    const idle = this.oldestIdle();
    let idleCount = 0;
    for (const state of this.states.values()) if (state === 'idle') idleCount++;
    if (idle !== null && idleCount > this.opts.reserveIdle) return { kind: 'reuse', threadId: idle };
    if (this.states.size < this.opts.maxThreads) return { kind: 'spawn' };
    if (this.opts.onFull === 'borrow' && idle !== null) return { kind: 'reuse', threadId: idle };
    return { kind: 'queue' };
  }

  /** 线程开始跑一件事。 */
  assign(id: string): void {
    this.states.set(id, 'running');
    const at = this.idleOrder.indexOf(id);
    if (at >= 0) this.idleOrder.splice(at, 1);
  }

  /** 线程空下来了；它排到空闲 LRU 的末尾。 */
  release(id: string): void {
    if (!this.states.has(id)) return;
    this.states.set(id, 'idle');
    const at = this.idleOrder.indexOf(id);
    if (at >= 0) this.idleOrder.splice(at, 1);
    this.idleOrder.push(id);
  }

  enqueue(task: T): number {
    this.waiting.push(task);
    return this.waiting.length;
  }

  dequeue(): T | undefined {
    return this.waiting.shift();
  }

  /** 队列在最前面看一眼，不取走。 */
  peekQueue(limit = 20): readonly T[] {
    return this.waiting.slice(0, Math.max(0, limit));
  }

  /** 需要补几条空闲线程才能满足保底（也受 maxThreads 限制）。 */
  deficit(): number {
    let idle = 0;
    for (const state of this.states.values()) if (state === 'idle') idle++;
    const room = this.opts.maxThreads - this.states.size;
    return Math.max(0, Math.min(this.opts.reserveIdle - idle, room));
  }
}
