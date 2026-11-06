import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { complete } from '../src/model.ts';

function server(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('Responses 返回 404 时退回 Chat Completions，并记住选择', async () => {
  const hits = [];
  const s = await server((req, res) => {
    hits.push(req.url);
    if (req.url === '/responses') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'chat 回落成功' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 2 } },
    }));
  });
  const endpoint = { baseUrl: `http://127.0.0.1:${s.address().port}`, model: 'fake', apiKey: 'k', source: 'test' };
  const opts = { instructions: 'hi', messages: [{ role: 'user', text: '你好' }], maxTokens: 16, temperature: 0.5, timeoutMs: 5000 };

  const first = await complete(endpoint, opts);
  assert.equal(first.text, 'chat 回落成功');
  assert.deepEqual(first.usage, { promptTokens: 10, completionTokens: 4, cacheHitTokens: 6, cacheMissTokens: 4, reasoningTokens: 2 });
  assert.deepEqual(hits, ['/responses', '/chat/completions']);

  const second = await complete(endpoint, opts);
  assert.equal(second.text, 'chat 回落成功');
  assert.deepEqual(hits, ['/responses', '/chat/completions', '/chat/completions'], '第二次直接走 chat');
  s.close();
});

test('Responses 正常时解析 output_text 与用量', async () => {
  const s = await server((req, res) => {
    assert.equal(req.url, '/responses');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'r1', object: 'response', model: 'fake', status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一行' }, { type: 'output_text', text: '第二行' }] },
      ],
      usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } },
    }));
  });
  const endpoint = { baseUrl: `http://127.0.0.1:${s.address().port}`, model: 'fake', apiKey: 'k', source: 'test' };
  const result = await complete(endpoint, { instructions: 'hi', messages: [{ role: 'user', text: '你好' }], maxTokens: 16, temperature: 0.5, timeoutMs: 5000 });
  assert.equal(result.text, '第一行\n第二行');
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 8, cacheHitTokens: 5, cacheMissTokens: 15, reasoningTokens: 3 });
  s.close();
});

test('HTTP 401 不重试，错误里带状态与原因', async () => {
  let calls = 0;
  const s = await server((req, res) => {
    calls++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  const endpoint = { baseUrl: `http://127.0.0.1:${s.address().port}`, model: 'fake', apiKey: 'k', source: 'test' };
  await assert.rejects(
    () => complete(endpoint, { instructions: 'hi', messages: [{ role: 'user', text: '你好' }], maxTokens: 16, temperature: 0.5, timeoutMs: 5000 }),
    /HTTP 401.*bad key/s,
  );
  assert.equal(calls, 1);
  s.close();
});
