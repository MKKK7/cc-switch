import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeCommandCode, prepareRequest, CommandCodeClient } from './client.mjs';
import { startCommandCode } from './server.mjs';
const line = value => JSON.stringify(value) + '\n';
const finish = line({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 2 } });
const parse = text => text.split('\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));

test('preserves model and correlates tool results using the CLI schema', () => {
  const body = prepareRequest({ model: 'claude-premium-test', messages: [
    { role: 'system', content: 'instruction' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: '19 C' },
  ], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] });
  assert.equal(body.params.model, 'claude-premium-test');
  assert.equal(body.params.messages[1].content[0].toolCallId, 'call_a');
  assert.equal(body.params.messages[1].content[0].toolName, 'weather');
  assert.equal(body.params.tools[0].type, 'function');
  assert.equal(body.params.system[0].text, 'instruction');
});
test('separate provider credentials are used per request; catalog does not read local credentials', async () => {
  const sent = [];
  const fakeFetch = async (url, init) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek/test' }] });
    sent.push({ authorization: init.headers.Authorization, model: JSON.parse(init.body).params.model });
    return new Response(finish);
  };
  const catalog = new CommandCodeClient({ fetchImpl: fakeFetch });
  assert.equal((await catalog.fetchModels())[0].id, 'deepseek/test');
  for (const key of ['user_account_a_fixture', 'user_account_b_fixture']) {
    const client = new CommandCodeClient({ credential: async () => key, fetchImpl: fakeFetch });
    const result = await client.chatStream(JSON.stringify({ model: 'deepseek/test', messages: [{ role: 'user', content: 'test' }] }));
    assert.equal(result.ok, true);
  }
  assert.deepEqual(sent.map(row => row.authorization), ['Bearer user_account_a_fixture', 'Bearer user_account_b_fixture']);
  assert.ok(sent.every(row => row.model === 'deepseek/test'));
});
test('tool argument deltas plus final snapshot emit one tool with no duplicate arguments', async () => {
  const events = line({ type: 'tool-call-delta', toolCallId: 'a', name: 'weather', arguments: '{"city":' })
    + line({ type: 'tool-call', toolCallId: 'a', toolName: 'weather', input: { city: 'Paris' } })
    + line({ type: 'tool-call', toolCallId: 'a', toolName: 'weather', input: { city: 'Paris' } })
    + line({ type: 'finish', finishReason: 'tool-calls' });
  const chunks = parse(await bridgeCommandCode(new Response(events), 'test-model').text());
  const calls = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(new Set(calls.map(c => c.index)).size, 1);
  assert.equal(calls.map(c => c.function?.name ?? '').join(''), 'weather');
  assert.equal(calls.map(c => c.function?.arguments ?? '').join(''), '{"city":"Paris"}');
});
test('stream errors and incomplete streams cannot report successful completion', async () => {
  for (const events of [line({ type: 'text-delta', text: 'partial' }), line({ type: 'error', message: 'no quota' }), line({ type: 'finish', finishReason: 'error' })]) {
    await assert.rejects(bridgeCommandCode(new Response(events), 'test').text());
  }
});
test('shared server gates authentication and catalog before reaching upstream', async t => {
  let count = 0;
  const key = 'offline-test-key-'.repeat(3);
  const adapter = await startCommandCode({ key, port: 0, providerAuth: false, client: {
    fetchModels: async () => [{ id: 'deepseek/test' }],
    chatStream: async () => { count++; return { ok: true, response: new Response(line({ type: 'text-delta', text: 'OK' }) + finish) }; },
  } });
  t.after(() => { adapter.server.closeAllConnections(); adapter.server.close(); });
  const request = (model, token = key) => fetch(`http://127.0.0.1:${adapter.port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal((await request('deepseek/test', 'bad')).status, 401);
  assert.equal((await request('made-up')).status, 400);
  assert.equal(count, 0);
  const response = await request('deepseek/test');
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'OK');
  assert.equal(body.usage.prompt_tokens, 10);
});
