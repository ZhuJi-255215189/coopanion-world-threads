// 从运行时声明生成 describe.json，避免两处漂。
// 运行：node --experimental-strip-types scripts/build-describe.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { THREADS_EVENTS, THREADS_TOOL_SPECS } from '../src/world.ts';

const SUMMARIES = {
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
};

const tools = THREADS_TOOL_SPECS.map(({ name, description, parameters, tags }) => ({
  name,
  description,
  parameters,
  tags,
  summary: SUMMARIES[name],
}));

const events = THREADS_EVENTS.map(({ type, description, trigger }) => ({ type, description, ...(trigger ? { trigger } : {}) }));

const content = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
const describe = {
  tools,
  events,
  prompts: [
    {
      key: 'worlds.threads.envPrompt',
      title: '多线程 · 环境提示词',
      role: 'envPrompt',
      content,
    },
  ],
};

const out = new URL('../describe.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(describe, null, 2)}\n`, 'utf8');
console.log(`wrote ${out.pathname} (${tools.length} tools, ${events.length} events)`);
