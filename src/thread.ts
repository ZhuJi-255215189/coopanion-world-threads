/**
 * 一条线程：一段自己的对话历史，一次只处理一件事。
 *
 * 它不等模型返回就给调用方回话（start/tell 都是同步的），
 * 完成后通过 hooks 把结果交回 World——World 再把结果转成一条事件，
 * 由主 session 用桌宠自己的口吻说出来。
 *
 * 忙的时候收到插话不丢：进 inbox，手头这一轮答完就接着答，
 * 所以「顺便接话」在同一条线程里也是排得上的。
 */
import type { ModelMessage } from './model.ts';

export type ThreadState = 'idle' | 'running';

export interface ThreadHooks {
  /** 一次模型调用；messages 已含 instructions 之外的全部上下文。 */
  complete(messages: readonly ModelMessage[], signal: AbortSignal, threadId: string): Promise<string>;
  /** 线程答完一句。World 在这里推事件、落盘。 */
  onReply(thread: Thread, reply: string, input: string): void | Promise<void>;
  /** 一次调用失败。 */
  onError(thread: Thread, error: Error, input: string): void | Promise<void>;
  /** 线程空了（inbox 清空、回到 idle）。 */
  onIdle(thread: Thread): void;
  /** 历史保留几轮（一问一答算一轮）。 */
  historyTurns(): number;
}

/** 面板要的一条线程快照。 */
export interface ThreadSnapshot {
  id: string;
  title: string;
  state: ThreadState;
  task: string;
  startedAt: number | null;
  elapsedMs: number;
  replies: number;
  pending: number;
  lastReply: string;
  lastError: string;
  history: number;
}

const trim = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** 没给标题时，拿第一句话当标题。 */
export function titleOf(text: string, max = 28): string {
  return trim(text, max) || '(空任务)';
}

export class Thread {
  readonly id: string;
  private readonly hooks: ThreadHooks;
  title = '';
  state: ThreadState = 'idle';
  task = '';
  startedAt: number | null = null;
  lastReply = '';
  lastError = '';
  replies = 0;
  history: ModelMessage[] = [];
  private inbox: string[] = [];
  private abort: AbortController | null = null;
  private disposed = false;
  private pumping = false;

  constructor(id: string, hooks: ThreadHooks) {
    this.id = id;
    this.hooks = hooks;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get pending(): number {
    return this.inbox.length;
  }

  /** 新任务：清掉旧上下文，从这一句重新开始。忙时按插话处理，不打断当前这轮。 */
  start(text: string, title?: string): void {
    if (this.disposed) return;
    const clean = text.trim();
    if (!clean) return;
    if (this.state === 'running' || this.pumping) {
      this.inbox.push(clean);
      return;
    }
    this.history = [];
    this.title = title?.trim() || titleOf(clean);
    this.task = clean;
    this.lastReply = '';
    this.lastError = '';
    this.inbox = [clean];
    void this.pump();
  }

  /** 插话/追问：保留上下文，排进同一条线程。 */
  tell(text: string): void {
    if (this.disposed) return;
    const clean = text.trim();
    if (!clean) return;
    this.inbox.push(clean);
    void this.pump();
  }

  /** 中止并作废这条线程；之后不会再回调 onIdle。 */
  dispose(): void {
    this.disposed = true;
    this.inbox = [];
    this.abort?.abort(new Error('thread disposed'));
    this.abort = null;
    this.state = 'idle';
    this.startedAt = null;
  }

  snapshot(): ThreadSnapshot {
    return {
      id: this.id,
      title: this.title,
      state: this.state,
      task: this.task,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt === null ? 0 : Date.now() - this.startedAt,
      replies: this.replies,
      pending: this.inbox.length,
      lastReply: trim(this.lastReply, 240),
      lastError: trim(this.lastError, 240),
      history: this.history.length,
    };
  }

  private trimHistory(): void {
    const keep = Math.max(2, this.hooks.historyTurns() * 2);
    if (this.history.length <= keep) return;
    for (let i = this.history.length - keep; i < this.history.length; i++) {
      if (this.history[i].role === 'user') {
        this.history = this.history.slice(i);
        return;
      }
    }
    this.history = this.history.slice(-keep);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    if (this.state === 'running') return;
    if (this.inbox.length === 0) return;
    this.pumping = true;
    this.state = 'running';
    this.startedAt = Date.now();
    this.abort = new AbortController();
    try {
      while (this.inbox.length > 0 && !this.disposed) {
        const input = this.inbox.shift()!;
        this.task = input;
        this.history.push({ role: 'user', text: input });
        this.trimHistory();
        try {
          const reply = await this.hooks.complete([...this.history], this.abort.signal, this.id);
          if (this.disposed) return;
          this.history.push({ role: 'assistant', text: reply });
          this.trimHistory();
          this.lastReply = reply;
          this.lastError = '';
          this.replies++;
          await this.hooks.onReply(this, reply, input);
        } catch (error) {
          if (this.disposed) return;
          const message = error instanceof Error ? error.message : String(error);
          this.lastError = message;
          try {
            await this.hooks.onError(this, new Error(message), input);
          } catch {
            /* 回调自己的异常不再往外抛 */
          }
        }
      }
    } finally {
      this.pumping = false;
      if (!this.disposed) {
        this.state = 'idle';
        this.startedAt = null;
        this.abort = null;
        try {
          this.hooks.onIdle(this);
        } catch {
          /* onIdle 的异常不影响线程本身 */
        }
      }
    }
  }
}
