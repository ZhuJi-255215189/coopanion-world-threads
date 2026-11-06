import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { THREADS_DEFAULTS, type ThreadsConfigSection } from './config.ts';
import { ThreadsWorld, THREADS_EVENTS, THREADS_TOOL_SPECS } from './world.ts';

/**
 * 多线程 World 的定义。
 *
 * 只做一件事：把「同时处理几件事」这件事放进 World 层。
 * Core 仍然只有一个接收事件的主 session，Persona 与 Memory 一行都不用改。
 */
export const THREADS: WorldDefinition<ThreadsConfigSection> = {
  id: 'threads',
  label: '多线程',
  defaults: () => ({ ...THREADS_DEFAULTS }),
  create: (ctx) => new ThreadsWorld({
    cfg: ctx.cfg,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
    botName: ctx.botName,
  }),
  describe: {
    tools: describeTools(THREADS_TOOL_SPECS, {
      thread_ask: {
        zh: '把一件要花一会儿的事交给后台线程，立刻回来陪对方。',
        en: 'Hands a longer task to a background thread and comes right back to the person.',
      },
      thread_tell: {
        zh: '给一条在跑的线程补一句话：改要求、补条件或顺便接一句。',
        en: 'Adds a line to a running thread: a changed requirement, a detail, or a passing remark.',
      },
      thread_list: {
        zh: '看一眼线程池：谁在忙、谁空闲、排了几件。',
        en: 'Shows the pool: who is busy, who is idle, and what is queued.',
      },
      thread_stop: {
        zh: '停掉一条线程并作废它手头的活。',
        en: 'Stops a thread and drops the work it was holding.',
      },
    }),
    events: THREADS_EVENTS,
  },
};

export default THREADS;
