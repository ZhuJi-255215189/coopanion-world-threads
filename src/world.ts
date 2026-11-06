/**
 * 「多线程」World：给桌宠一套并行的后台线程。
 *
 * 它不碰 Core 的主 session，也不改 Persona：每条线程自己带上下文、自己调模型，
 * 干完活再把结果作为一条事件交回主 session，由桌宠用自己的口吻说出来。
 *
 * 为什么这样设计：Cortico 的 Core 只有一个接收事件的常驻 session，
 * 想在不改框架的前提下并行处理多件事，唯一干净的位置就是 World——
 * World 本来就可以推事件、给工具、带面板，也可以自己调模型。
 *
 * 池子的规则见 pool.ts：空闲保底 1 条，所以「两条在忙」时池子里是三条（2 忙 + 1 闲），
 * 第三件事进来会开第四条；到上限才排队（或按配置临时借用保底那条）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { THREADS_CONFIG_GROUP, readThreadsConfig, type ThreadsConfigSection } from './config.ts';
import { ThreadPool } from './pool.ts';
import { Thread, titleOf } from './thread.ts';
import { complete, endpointLabel, resolveEndpoint, type ModelMessage } from './model.ts';

export const THREADS_REPORT = 'threads.report';
export const THREADS_ERROR = 'threads.error';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 单条任务文本的上限，防止把整份文件塞进来。 */
const TASK_MAX = 12_000;
/** 交给主 session 的回报正文上限。 */
const REPORT_MAX = 6_000;
/** 写进线程指令的人格文件上限：只借一点语气，不复制整个工作区。 */
const PERSONA_MAX = 2_600;

interface QueuedTask {
  text: string;
  title: string;
}

interface StoredThread {
  id: string;
  title: string;
  history: ModelMessage[];
  lastReply: string;
}

interface StoredState {
  version: 1;
  seq: number;
  threads: StoredThread[];
}

const nowIso = (date = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n（后略）` : text);

const readText = (file: string): string => {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

/** 交给模型的工具声明；describe.json 和运行时共用这一份。 */
export const THREADS_TOOL_SPECS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'thread_ask',
    description:
      '把一件可以独立完成的事交给一条后台线程，立刻返回，你自己继续陪着对方。'
      + '对方交代的活要花一会儿（写东西、整理、比较、算、想），或者你手上已经有一件事在跑时用它。'
      + '不要用它来做：一句就能答完的闲聊；需要你亲自看屏幕、动手操作电脑的事（那些用你自己的工具）。'
      + '线程也没有文件工具；要基于某份资料干活，先把关键内容摘进 text。'
      + 'text 写清楚要做什么、交付什么；title 是给人看的一行小标题，可省。'
      + '线程完成后会有一条回报，你用自己的口吻把结果告诉对方，别提前替它编答案。',
    tags: ['flow', 'write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '交给线程的任务，写清目标与交付物。' },
        title: { type: 'string', description: '一行小标题，给人看；省略时取任务开头。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'thread_tell',
    description:
      '给一条已经在跑的线程补一句话：对方改了要求、补了条件，或者只是顺便接一句。'
      + '线程会在手头这一轮答完后处理它，不会打断正在进行的模型调用。'
      + '如果对方只是在跟你闲聊，不用转给线程——你自己答就好。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thread_id: { type: 'string', description: '线程 id，如 t2。' },
        text: { type: 'string', description: '要补给它的话。' },
      },
      required: ['thread_id', 'text'],
    },
  },
  {
    name: 'thread_list',
    description: '看一眼线程池：哪几条在忙、哪几条空闲、排队的还有几件、各自上次在做什么。派活前不确定时先看这个。',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'thread_stop',
    description: '停掉一条线程并作废它：它手头的活不会再有回报。只在对方明确不要了、或线程卡死时用。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thread_id: { type: 'string', description: '要停的线程 id，如 t2。' },
      },
      required: ['thread_id'],
    },
  },
];

export const THREADS_EVENTS = [
  {
    type: THREADS_REPORT,
    description: {
      zh: '某条后台线程干完了一件活：带标题与结果，让桌宠用自己的口吻转告对方。',
      en: 'A background thread finished a task: the title and the result, so the pet can tell the person in its own voice.',
    },
    trigger: 'flush' as const,
  },
  {
    type: THREADS_ERROR,
    description: {
      zh: '某条后台线程这次调用失败了：带标题与原因，让桌宠决定怎么说明。',
      en: 'A background thread failed this call: the title and the reason, for the pet to explain.',
    },
    trigger: 'flush' as const,
  },
];

export interface ThreadsWorldOptions {
  /** worlds.threads 的活引用。 */
  cfg: ThreadsConfigSection;
  botDir: string;
  dataDir: string;
  botName: string;
}

export class ThreadsWorld implements World {
  readonly id = 'threads';
  private readonly rawCfg: ThreadsConfigSection;
  private readonly botDir: string;
  private readonly dataDir: string;
  private readonly botName: string;
  private readonly pool = new ThreadPool<QueuedTask>({ maxThreads: 4, reserveIdle: 1, onFull: 'queue' });
  private readonly threads = new Map<string, Thread>();
  private readonly stateFile: string;
  private seq = 0;
  private host: WorldHost | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(opts: ThreadsWorldOptions) {
    this.rawCfg = opts.cfg;
    this.botDir = opts.botDir;
    this.dataDir = opts.dataDir;
    this.botName = opts.botName || '桌宠';
    this.stateFile = join(opts.dataDir, 'threads', 'state.json');
  }

  private get config(): ThreadsConfigSection {
    return readThreadsConfig(this.rawCfg);
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    return { 'threads.status': this.statusLine() };
  }

  tools(): ToolDef[] {
    const [ask, tell, list, stop] = THREADS_TOOL_SPECS;
    return [
      { ...ask, handler: async (args) => this.toolAsk(args) },
      { ...tell, handler: async (args) => this.toolTell(args) },
      { ...list, handler: async () => this.toolList() },
      { ...stop, handler: async (args) => this.toolStop(args) },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const zh = language === 'zh' || language === 'zh-Hant';
    return {
      label: zh ? '多线程' : 'Threads',
      lamps: [{ label: zh ? '线程池' : 'Thread pool', state: 'online', hint: this.statusLine() }],
      badges: [
        { label: zh ? '忙' : 'busy', value: this.pool.counts.running },
        { label: zh ? '闲' : 'idle', value: this.pool.counts.idle },
      ],
      config: [THREADS_CONFIG_GROUP],
      panels: [
        {
          id: 'live',
          title: zh ? '多线程 · 线程池' : 'Threads · live',
          description: zh
            ? '每一条线程在忙什么、空了多久、最近一句说了什么；池子里还留没留着空闲的那一条。'
            : 'What each thread is doing, how long it has been idle, its latest line; and whether the spare thread is still there.',
          getMethods: ['snapshot'],
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== 'live') throw new Error(zh ? `未知面板：${panel}` : `Unknown panel: ${panel}`);
        if (method === 'snapshot') return this.snapshot();
        if (method === 'stop') return this.panelStop(String(args?.[0] ?? ''));
        throw new Error(zh ? `未知方法：${method}` : `Unknown method: ${method}`);
      },
      promptDocs: [
        {
          key: 'worlds.threads.envPrompt',
          title: zh ? '多线程 · 环境提示词' : 'Threads · environment prompt',
          description: zh
            ? '告诉她线程池怎么用：什么时候派活、什么时候自己答、回报来了怎么转告。'
            : 'How to use the pool: when to delegate, when to answer directly, how to relay a report.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'threads.status',
              description: zh
                ? '此刻的线程池状态：几条在忙、几条空闲、排了几件、上限多少。'
                : 'The pool right now: busy, idle, queued, and the cap.',
            },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.pool.clear();
    this.threads.clear();
    this.seq = 0;
    this.load();
    this.syncPool();
    this.ensureReserve();
  }

  async stop(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 先留档再作废：停掉 World 不该把线程历史一起清掉，下次挂载还要接得上。
    this.saveNow();
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.pool.clear();
    this.host = null;
  }

  // ── 工具实现 ────────────────────────────────────────────────────────────

  private toolAsk(args: Record<string, unknown>): string {
    if (!this.host) return '线程池还没启动（World 未挂载）。';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return 'thread_ask 需要 text：要做什么。';
    if (text.length > TASK_MAX) return `任务太长了（${text.length} 字符），请压缩到 ${TASK_MAX} 以内，或先写进文件再让线程读。`;
    const title = typeof args.title === 'string' && args.title.trim() ? titleOf(args.title, 40) : titleOf(text);
    const cfg = this.config;
    this.syncPool(cfg);
    const plan = this.pool.plan();
    if (plan.kind === 'queue') {
      const position = this.pool.enqueue({ text, title });
      this.saveSoon();
      return `池子满了（${this.pool.counts.running} 忙 / ${this.pool.counts.idle} 闲 / 上限 ${cfg.maxThreads}），已排队：第 ${position} 位，标题「${title}」。空出来就会自动开工，不用再问。`;
    }
    const thread = plan.kind === 'reuse' ? this.threads.get(plan.threadId) : this.spawnThread();
    if (!thread) return '找不到空闲线程，请稍后再试。';
    this.pool.assign(thread.id);
    thread.start(text, title);
    this.ensureReserve();
    this.saveSoon();
    return `已交给 ${thread.id}（${plan.kind === 'reuse' ? '复用了空闲线程' : '新开了一条线程'}），标题「${title}」。池子：${this.pool.counts.running} 忙 / ${this.pool.counts.idle} 闲 / 上限 ${cfg.maxThreads}，排队 ${this.pool.counts.queued}。完成后会有回报。`;
  }

  private toolTell(args: Record<string, unknown>): string {
    const id = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!id) return 'thread_tell 需要 thread_id。';
    if (!text) return 'thread_tell 需要 text。';
    const thread = this.threads.get(id);
    if (!thread) {
      const known = [...this.threads.keys()].join('、') || '（还没有线程）';
      return `没有 ${id} 这条线程。现在有：${known}。`;
    }
    if (thread.isDisposed) return `${id} 已经停掉了，不能再转话。`;
    const wasIdle = thread.state === 'idle';
    if (wasIdle) this.pool.assign(id);
    thread.tell(text);
    if (wasIdle) this.ensureReserve();
    this.saveSoon();
    return thread.pending > 0
      ? `已转给 ${id}；它手头这一轮答完就接着看这句。`
      : `已转给 ${id}。`;
  }

  private toolList(): string {
    const counts = this.pool.counts;
    const head = `线程池 ${counts.size}/${counts.max}（保底 ${counts.reserve} 空闲）：${counts.running} 忙 / ${counts.idle} 闲 / ${counts.queued} 排队。`;
    const lines = [...this.threads.values()].map((thread) => {
      const state = thread.state === 'running'
        ? `忙 ${Math.max(1, Math.round((Date.now() - (thread.startedAt ?? Date.now())) / 1000))}s`
        : '闲';
      const last = thread.lastReply ? ` · 最近：${clip(thread.lastReply.replace(/\s+/g, ' '), 60)}` : '';
      return `${thread.id} [${state}] ${thread.title || '（还没接过活）'} · 已回 ${thread.replies} 条${last}`;
    });
    const queued = this.pool.peekQueue(5).map((task, index) => `排队 ${index + 1}. ${task.title}`);
    return [head, ...lines, ...queued].join('\n') || head;
  }

  private toolStop(args: Record<string, unknown>): string {
    const id = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
    const thread = this.threads.get(id);
    if (!thread) return `没有 ${id} 这条线程。`;
    thread.dispose();
    this.threads.delete(id);
    this.pool.remove(id);
    this.dispatchQueue();
    this.ensureReserve();
    this.saveSoon();
    return `已停掉 ${id}。池子：${this.pool.counts.running} 忙 / ${this.pool.counts.idle} 闲 / 上限 ${this.pool.counts.max}。`;
  }

  // ── 线程生命周期 ────────────────────────────────────────────────────────

  private spawnThread(): Thread {
    return this.threadFor(`t${++this.seq}`);
  }

  private threadFor(id: string): Thread {
    const thread = new Thread(id, {
      complete: (messages, signal, threadId) => this.callModel(messages, signal, threadId),
      onReply: (self, reply, input) => this.onReply(self, reply, input),
      onError: (self, error, input) => this.onError(self, error, input),
      onIdle: (self) => this.onIdle(self),
      historyTurns: () => this.config.historyTurns,
    });
    this.threads.set(id, thread);
    this.pool.add(id, 'idle');
    return thread;
  }

  private syncPool(cfg = this.config): void {
    this.pool.setOptions({ maxThreads: cfg.maxThreads, reserveIdle: cfg.reserveIdle, onFull: cfg.onFull });
  }

  /** 把空闲保底补齐；受上限限制，补不出来就算了。 */
  private ensureReserve(): void {
    this.syncPool();
    for (let i = 0; i < 9 && this.pool.deficit() > 0; i++) this.spawnThread();
  }

  private onIdle(thread: Thread): void {
    this.pool.release(thread.id);
    this.dispatchQueue();
    this.ensureReserve();
    this.saveSoon();
  }

  private dispatchQueue(): void {
    let guard = 0;
    while (this.pool.queued > 0 && guard++ < 9) {
      this.syncPool();
      const plan = this.pool.plan();
      if (plan.kind === 'queue') return;
      const task = this.pool.dequeue();
      if (!task) return;
      const thread = plan.kind === 'reuse' ? this.threads.get(plan.threadId) : this.spawnThread();
      if (!thread) {
        this.pool.enqueue(task);
        return;
      }
      this.pool.assign(thread.id);
      thread.start(task.text, task.title);
      this.ensureReserve();
    }
  }

  private async callModel(messages: readonly ModelMessage[], signal: AbortSignal, threadId: string): Promise<string> {
    const cfg = this.config;
    const resolved = resolveEndpoint(this.botDir, { endpoint: cfg.endpoint, model: cfg.model, apiKeyEnv: cfg.apiKeyEnv });
    if (!resolved.endpoint) throw new Error(resolved.error ?? '模型端点不可用');
    const result = await complete(resolved.endpoint, {
      instructions: this.instructions(),
      messages,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      timeoutMs: cfg.timeoutSec * 1000,
      signal,
    });
    if (result.usage && this.host?.reportUsage) {
      try {
        this.host.reportUsage(result.usage, { model: resolved.endpoint.model, label: `线程 ${threadId}` });
      } catch {
        /* 记账失败不影响这次回复 */
      }
    }
    return result.text;
  }

  private async onReply(thread: Thread, reply: string, input: string): Promise<void> {
    this.saveSoon();
    const text = `[后台线程 ${thread.id} 完成] ${thread.title}\n${clip(reply, REPORT_MAX)}`;
    await this.push(THREADS_REPORT, text, {
      thread: thread.id,
      title: thread.title,
      input: clip(input, 500),
      reply: clip(reply, REPORT_MAX),
    });
  }

  private async onError(thread: Thread, error: Error, input: string): Promise<void> {
    this.saveSoon();
    const text = `[后台线程 ${thread.id} 失败] ${thread.title}\n原因：${clip(error.message, 500)}`;
    await this.push(THREADS_ERROR, text, {
      thread: thread.id,
      title: thread.title,
      input: clip(input, 500),
      error: clip(error.message, 500),
    });
  }

  private async push(type: string, text: string, meta: Record<string, unknown>): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type,
        source: this.id,
        senderKey: 'threads',
        ts: nowIso(),
        text,
        meta,
      }, { trigger: 'flush' });
    } catch (error) {
      host.log.warn('多线程：回报事件没推出去', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ── 给模型的指令 ────────────────────────────────────────────────────────

  /**
   * 线程的 system 文本。只借人格文件的三千字以内的开头，目的是语气一致，
   * 不把整份记忆搬进每条线程——那会很贵，也会让线程以为自己知道得比实际多。
   */
  private instructions(): string {
    const readPersona = (name: string): string => {
      for (const dir of ['workspace', 'memory']) {
        const text = readText(join(this.botDir, dir, name)).trim();
        if (text) return text;
      }
      return '';
    };
    const constitution = readPersona('CONSTITUTION.md');
    const partner = readPersona('PARTNER.md');
    const lines = [
      `你是「${this.botName}」的一条后台线程。对方正在和「${this.botName}」聊天；你负责其中一件可以独立完成的事，和其他线程并行工作。`,
      '用第一人称说话，就像 TA 本人；不要提「线程」「编号」「后台」「池子」「模型」这些词。',
      '回答短、直接、能原样说出口；除非对方明确要细节，控制在几句话内。不要用 Markdown 标题或列表，不要写「作为 AI」。',
      '对方用哪种语言，你就用哪种语言；对方没要求时不要主动加戏、不要反问要不要继续。',
      '你只看见这一个任务和少量人格摘录，看不到聊天全文；不确定的事就说不知道，不要编。',
    ];
    if (constitution) lines.push(`\n# 关于你自己（摘录）\n${clip(constitution, PERSONA_MAX)}`);
    if (partner) lines.push(`\n# 关于对方（摘录）\n${clip(partner, PERSONA_MAX)}`);
    return lines.join('\n');
  }

  // ── 面板 ────────────────────────────────────────────────────────────────

  private statusLine(): string {
    const counts = this.pool.counts;
    return `线程池 ${counts.size}/${counts.max}：${counts.running} 条在忙，${counts.idle} 条空闲（保底 ${counts.reserve}），${counts.queued} 件排队。`;
  }

  snapshot(): Record<string, unknown> {
    const counts = this.pool.counts;
    const cfg = this.config;
    return {
      at: nowIso(),
      botName: this.botName,
      pool: { ...counts, onFull: cfg.onFull },
      threads: [...this.threads.values()].map((thread) => thread.snapshot()),
      queue: this.pool.peekQueue(20).map((task, index) => ({ position: index + 1, title: task.title, text: clip(task.text, 90) })),
      model: endpointLabel(this.botDir, { endpoint: cfg.endpoint, model: cfg.model, apiKeyEnv: cfg.apiKeyEnv }),
      config: {
        maxThreads: cfg.maxThreads,
        reserveIdle: cfg.reserveIdle,
        onFull: cfg.onFull,
        historyTurns: cfg.historyTurns,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        timeoutSec: cfg.timeoutSec,
      },
    };
  }

  private async panelStop(id: string): Promise<{ ok: boolean; snapshot?: Record<string, unknown>; error?: string }> {
    const thread = this.threads.get(id);
    if (!thread) return { ok: false, error: `没有 ${id} 这条线程` };
    thread.dispose();
    this.threads.delete(id);
    this.pool.remove(id);
    this.dispatchQueue();
    this.ensureReserve();
    this.saveSoon();
    return { ok: true, snapshot: this.snapshot() };
  }

  // ── 落盘 ────────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.stateFile)) return;
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<StoredState>;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.threads)) return;
      this.seq = Math.max(0, Math.floor(Number(raw.seq) || 0));
      for (const item of raw.threads) {
        if (!item || typeof item.id !== 'string' || !/^t\d+$/.test(item.id) || this.threads.has(item.id)) continue;
        const history = Array.isArray(item.history)
          ? item.history.filter((m): m is ModelMessage => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').slice(-80)
          : [];
        const thread = this.threadFor(item.id);
        thread.title = typeof item.title === 'string' ? item.title : '';
        thread.history = history;
        thread.lastReply = typeof item.lastReply === 'string' ? item.lastReply : '';
        const numeric = Number(/^t(\d+)$/.exec(item.id)?.[1] ?? 0);
        if (Number.isFinite(numeric)) this.seq = Math.max(this.seq, numeric);
      }
    } catch (error) {
      this.host?.log.warn('多线程：读取线程存档失败，从空池开始', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 400);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    const state: StoredState = {
      version: 1,
      seq: this.seq,
      threads: [...this.threads.values()].map((thread) => ({
        id: thread.id,
        title: thread.title,
        history: thread.history,
        lastReply: thread.lastReply,
      })),
    };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, this.stateFile);
    } catch (error) {
      this.host?.log.warn('多线程：线程存档没写出去', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
