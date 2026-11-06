import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadPool } from '../src/pool.ts';

const pool = (opts = {}) => new ThreadPool({ maxThreads: 4, reserveIdle: 1, onFull: 'queue', ...opts });

test('空闲保底：第一条活会先开新线程，保底那条仍然闲着', () => {
  const p = pool();
  p.add('t1', 'idle'); // 启动时预热的保底线程
  assert.deepEqual(p.counts, { size: 1, idle: 1, running: 0, queued: 0, max: 4, reserve: 1, reserveMet: true });

  const plan = p.plan();
  assert.equal(plan.kind, 'spawn');
});

test('两条在忙时开第三条，忙到上限才排队', () => {
  const p = pool();
  p.add('t1', 'idle');

  // 第 1 件：开新线程；保底 t1 留着
  p.add('t2', 'running'); // 模拟 spawn 出来的那条并已派活
  assert.deepEqual([p.counts.running, p.counts.idle, p.counts.size], [1, 1, 2]);

  // 第 2 件：再开一条
  const second = p.plan();
  assert.equal(second.kind, 'spawn');
  p.add('t3', 'running');

  // 第 3 件：还开
  const third = p.plan();
  assert.equal(third.kind, 'spawn');
  p.add('t4', 'running');
  assert.deepEqual([p.counts.running, p.counts.idle, p.counts.size], [3, 1, 4]);

  // 第 4 件：满了，排队
  assert.equal(p.plan().kind, 'queue');
});

test('有两条空闲时复用最久没动的那条，不再开新线程', () => {
  const p = pool();
  p.add('t1', 'idle');
  p.add('t2', 'idle');
  const plan = p.plan();
  assert.equal(plan.kind, 'reuse');
  assert.equal(plan.threadId, 't1');
});

test('线程空出来后，排队的活自动接上，且保底恢复', () => {
  const p = pool();
  p.add('t1', 'idle');
  p.add('t2', 'running');
  p.add('t3', 'running');
  p.add('t4', 'running');
  assert.equal(p.plan().kind, 'queue');
  p.enqueue({ text: 'x' });
  assert.equal(p.queued, 1);

  p.release('t2');
  assert.deepEqual([p.counts.running, p.counts.idle], [2, 2]);
  const next = p.plan();
  assert.equal(next.kind, 'reuse');
  // 复用最久没动的空闲线程（t1），刚空下来的 t2 留作保底。
  assert.equal(next.threadId, 't1');
  p.assign(next.threadId);
  p.dequeue();
  assert.deepEqual([p.counts.running, p.counts.idle, p.counts.queued], [3, 1, 0]);
});

test('borrow 模式：满了可以临时借用保底，空闲归零', () => {
  const p = pool({ maxThreads: 2, reserveIdle: 1, onFull: 'borrow' });
  p.add('t1', 'idle');
  // 第一件事：空闲正好等于保底 → 开新线程，保底仍在
  assert.equal(p.plan().kind, 'spawn');
  p.add('t2', 'running');
  assert.equal(p.counts.idle, 1);

  // 第二件事：池子满了、只剩保底那条 → 借用
  const plan = p.plan();
  assert.equal(plan.kind, 'reuse');
  assert.equal(plan.threadId, 't1');
  p.assign('t1');
  assert.equal(p.counts.reserveMet, false);
});

test('queue 模式绝不把保底用掉', () => {
  const p = pool({ maxThreads: 2, reserveIdle: 1, onFull: 'queue' });
  p.add('t1', 'idle');
  p.add('t2', 'running');
  assert.equal(p.plan().kind, 'queue');
  assert.equal(p.counts.idle, 1);
});

test('保底会被压到上限以下；上限 1 时没有保底', () => {
  const p = pool({ maxThreads: 1, reserveIdle: 1 });
  assert.equal(p.options.reserveIdle, 0);
  assert.equal(p.plan().kind, 'spawn');
  p.add('t1', 'idle');
  p.assign('t1');
  assert.equal(p.plan().kind, 'queue');
});

test('deficit 只补到保底，也受上限限制', () => {
  const p = pool({ maxThreads: 3, reserveIdle: 2 });
  assert.equal(p.deficit(), 2);
  p.add('t1', 'idle');
  assert.equal(p.deficit(), 1);
  p.add('t2', 'idle');
  assert.equal(p.deficit(), 0);
  p.add('t3', 'running');
  assert.equal(p.deficit(), 0);
});

test('remove 会清掉线程与它的空闲位', () => {
  const p = pool();
  p.add('t1', 'idle');
  p.remove('t1');
  assert.equal(p.counts.size, 0);
  assert.equal(p.plan().kind, 'spawn');
});
