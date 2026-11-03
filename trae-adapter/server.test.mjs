import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from './server.mjs';

const key = 'test-only-key-'.repeat(4);
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const done = event('done', { finish_reason: 'stop' });
async function fixture(t, sse) {
  const calls = [];
  const adapter = await createAdapter({ key, port: 0, client: {
    fetchModels: async () => [{ id: 'gpt-6.1-sol', function: 'solo_work_remote' }, { id: 'kimi-k3', function: 'solo_agent' }],
    chatStream: async (body, signal, fn) => { calls.push({ body: JSON.parse(body), fn }); return { ok: true, response: new Response(sse) }; },
  } });
  t.after(() => { adapter.server.closeAllConnections(); adapter.server.close(); });
  const request = (body, authorization = `Bearer ${key}`) => fetch(`http://127.0.0.1:${adapter.port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { request, calls };
}
const body = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hello' }] };

test('auth and unknown models cannot reach upstream; route comes from directory', async t => {
  const { request, calls } = await fixture(t, event('output', { response: 'OK' }) + done);
  assert.equal((await request(body, 'Bearer bad')).status, 401);
  assert.equal((await request({ ...body, model: 'made-up' })).status, 400);
  assert.equal(calls.length, 0);
  const response = await request({ ...body, function: 'inline_chat' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'OK');
  assert.equal(calls[0].fn, 'solo_work_remote');
  assert.equal(calls[0].body.function, undefined);
  await request({ ...body, model: 'kimi-k3' });
  assert.equal(calls[1].fn, 'solo_agent');
});
test('native SSE converts to streamed OpenAI output and terminal marker', async t => {
  const { request } = await fixture(t, event('output', { response: 'OK' }) + done);
  const response = await request({ ...body, stream: true });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  assert.match(text, /"content":"OK"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.equal(text.split('data: [DONE]').length, 2);
});
test('HTTP 200 carrying SSE error and truncated output are failures', async t => {
  for (const sse of [event('error', { code: 4015, message: 'denied' }) + done, event('output', { response: 'partial' })]) {
    const { request } = await fixture(t, sse);
    const response = await request(body);
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
  }
});
test('tool call fragments aggregate for nonstreaming callers', async t => {
  const sse = event('output', { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function_call: { name: 'get_weather', arguments: '{"city":' } }] })
    + event('output', { tool_calls: [{ index: 0, id: '', function_call: { arguments: '"Paris"}' } }] })
    + event('output', { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function_call: { name: 'get_weather', arguments: '' } }] }) + done;
  const { request } = await fixture(t, sse);
  const response = await request(body);
  const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
});
