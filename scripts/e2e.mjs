// 端到端自测：起一个假的 /responses 端点，把 World 真跑一遍。
// 不碰真实部署、不花 token；验证的是调度、事件、插话、存档。
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin from '../src/index.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeServer(delayMs = 0) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (delayMs) await sleep(delayMs);
      let user = '';
      try {
        const parsed = JSON.parse(body);
        for (const item of parsed.input ?? []) {
          for (const part of item.content ?? []) if (part.type === 'input_text') user = part.text;
        }
      } catch { /* ignore */ }
      const payload = {
        id: 'resp_test',
        object: 'response',
        model: 'fake',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `收到：${user}` }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fakeHost() {
  const events = [];
  const usage = [];
  const host = {
    events,
    usage,
    pushEvent: async (event) => {
      events.push({ ...event, at: Date.now() });
      return { ...event, cursor: events.length, origin: 'external', contextDelivery: 'deliver' };
    },
    reportUsage: (record, opts) => { usage.push({ record, opts }); },
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return this; } },
  };
  return host;
}

function worldFor(endpoint, dataDir) {
  const def = plugin;
  const cfg = { ...def.defaults(), enabled: true, maxThreads: 4, reserveIdle: 1, endpoint, model: 'fake', apiKeyEnv: 'THREADS_TEST_KEY', timeoutSec: 20 };
  return { world: def.create({ id: def.id, cfg, timezone: 'Asia/Shanghai', botName: '大肥鱼', botDir: dataDir, packageDir: dataDir, dataDir, repoRoot: dataDir, secret: () => '', storeSecret: () => {}, persist: () => {}, restart: async () => {} }), cfg };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

process.env.THREADS_TEST_KEY = 'test-key';
const server = await fakeServer(30);
const port = server.address().port;
const dataDir = mkdtempSync(join(tmpdir(), 'threads-e2e-'));
const { world } = worldFor(`http://127.0.0.1:${port}`, dataDir);
const host = fakeHost();
await world.start(host);
// start() 立即返回，读档与补保底在微任务里；等它就绪再派活。
for (let i = 0; i < 100 && world.snapshot().ready !== true; i++) await sleep(10);

const tool = (name) => world.tools().find((t) => t.name === name);
const call = async (name, args = {}) => {
  const result = await tool(name).handler(args, { role: 'main', log: host.log });
  return typeof result === 'string' ? result : result.text;
};

// 启动后应已预热 1 条保底线程
const startSnap = world.snapshot();
check('启动即预热保底线程', startSnap.pool.size === 1 && startSnap.pool.idle === 1, JSON.stringify(startSnap.pool));

// 连续派三件事：应开三条新线程，并始终留 1 条空闲
const asks = [];
for (const [index, text] of ['整理下载目录', '写一段自我介绍', '查一下明天的天气'].entries()) {
  asks.push(await call('thread_ask', { text, title: `任务${index + 1}` }));
  const snap = world.snapshot();
  check(`第 ${index + 1} 件派活后：忙${index + 1} 闲1`, snap.pool.running === index + 1 && snap.pool.idle === 1, JSON.stringify(snap.pool));
}

// 第四件：池子满，排队
const queued = await call('thread_ask', { text: '第四件活' });
check('第四件排队', /排队|第 \d+ 位/.test(queued), queued);

// 等前三条回报，第四条应自动接上
for (let i = 0; i < 80; i++) {
  if (host.events.filter((e) => e.type === 'threads.report').length >= 4) break;
  await sleep(50);
}
const reports = host.events.filter((e) => e.type === 'threads.report');
check('四条都回报了', reports.length === 4, `reports=${reports.length}`);
check('回报带线程编号与标题', reports.every((e) => /后台线程 t\d+ 完成/.test(e.text)), reports[0]?.text);
check('回报正文带结果', reports.every((e) => e.text.includes('收到：')), reports[0]?.text);
check('排队已清空', world.snapshot().pool.queued === 0, JSON.stringify(world.snapshot().pool));
check('每次调用都上报了用量', host.usage.length >= 4 && host.usage.every((u) => u.opts?.label?.startsWith('线程 t')), JSON.stringify(host.usage[0]));

// 池子空下来：三忙一闲 → 全闲后仍保底 1 条（不会无限膨胀）
await sleep(100);
const settled = world.snapshot();
check('结束后回到 4 条线程、至少 1 条空闲', settled.pool.size === 4 && settled.pool.idle >= 1, JSON.stringify(settled.pool));

// 给空闲线程插话：沿用它的上下文
const anyIdle = settled.threads.find((t) => t.state === 'idle');
const told = await call('thread_tell', { thread_id: anyIdle.id, text: '顺便接一句' });
check('能给空闲线程插话', told.includes(anyIdle.id), told);
for (let i = 0; i < 40; i++) {
  if (host.events.filter((e) => e.type === 'threads.report').length >= 5) break;
  await sleep(50);
}
check('插话也有回报', host.events.filter((e) => e.type === 'threads.report').length >= 5, '');
check('插话沿用同一线程', host.events.filter((e) => e.type === 'threads.report').some((e) => e.meta?.thread === anyIdle.id), '');

// thread_list 可读
const list = await call('thread_list');
check('thread_list 有内容', list.includes('线程池') && list.includes('t'), list.split('\n')[0]);

// thread_stop 停掉空闲线程
const beforeStop = world.snapshot().pool.size;
const stopped = await call('thread_stop', { thread_id: anyIdle.id });
check('能停掉线程', stopped.includes('已停掉'), stopped);

// 存档：stop 后重新挂载，历史还在
await world.stop();
const { world: reborn } = worldFor(`http://127.0.0.1:${port}`, dataDir);
await reborn.start(fakeHost());
const rebornSnap = reborn.snapshot();
check('重新挂载接得上存档', rebornSnap.pool.size >= 1 && rebornSnap.threads.length >= 1, JSON.stringify(rebornSnap.pool));
await reborn.stop();

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
