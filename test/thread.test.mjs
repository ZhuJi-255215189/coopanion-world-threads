import test from 'node:test';
import assert from 'node:assert/strict';
import { Thread } from '../src/thread.ts';

function makeThread(handler, opts = {}) {
  const replies = [];
  const errors = [];
  let idleResolve;
  let idle = new Promise((resolve) => { idleResolve = resolve; });
  const thread = new Thread('t1', {
    complete: handler,
    onReply: (self, reply) => { replies.push(reply); },
    onError: (self, error) => { errors.push(error.message); },
    onIdle: () => idleResolve(),
    historyTurns: () => opts.historyTurns ?? 4,
  });
  return {
    thread,
    replies,
    errors,
    waitIdle: () => idle,
    resetIdle: () => { idle = new Promise((resolve) => { idleResolve = resolve; }); },
  };
}

test('干完活回到空闲，历史带上这一问一答', async () => {
  const h = makeThread(async () => '你好呀');
  h.thread.start('在吗');
  await h.waitIdle();
  assert.deepEqual(h.replies, ['你好呀']);
  assert.equal(h.thread.state, 'idle');
  assert.equal(h.thread.history.length, 2);
  assert.equal(h.thread.history[0].text, '在吗');
});

test('忙的时候插话不丢：这一轮答完接着答', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const h = makeThread(async () => {
    calls++;
    if (calls === 1) { await gate; return '第一句'; }
    return '第二句';
  });
  h.thread.start('帮我查一下');
  h.thread.tell('顺便说下天气');
  assert.equal(h.thread.pending, 1);
  release();
  await h.waitIdle();
  assert.deepEqual(h.replies, ['第一句', '第二句']);
  assert.equal(calls, 2);
});

test('失败会回调 onError，线程仍然回到空闲', async () => {
  const h = makeThread(async () => { throw new Error('网络断了'); });
  h.thread.start('试试');
  await h.waitIdle();
  assert.deepEqual(h.errors, ['网络断了']);
  assert.equal(h.thread.state, 'idle');
  assert.match(h.thread.lastError, /网络断了/);
});

test('dispose 之后不再回调', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makeThread(async () => { await gate; return '晚了'; });
  h.thread.start('跑一半');
  h.thread.dispose();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.replies, []);
  assert.equal(h.thread.isDisposed, true);
});

test('历史按轮数裁剪，且从一条 user 消息开始', async () => {
  const h = makeThread(async (messages) => `第${messages.length}条`, { historyTurns: 2 });
  h.thread.start('一');
  await h.waitIdle();
  h.resetIdle();
  h.thread.start('二');
  await h.waitIdle();
  h.resetIdle();
  h.thread.start('三');
  await h.waitIdle();
  assert.ok(h.thread.history.length <= 4);
  assert.equal(h.thread.history[0].role, 'user');
});
