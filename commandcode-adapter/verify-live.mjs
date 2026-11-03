// Opt-in account-quota test; never prints credentials or raw upstream payloads.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startCommandCode } from './server.mjs';
const key = randomBytes(32).toString('hex');
const upstreamKey = process.env.COMMANDCODE_API_KEY;
if (!upstreamKey) throw new Error('Set COMMANDCODE_API_KEY explicitly for this opt-in test; no local credentials are read.');
const adapter = await startCommandCode({ key, port: 0 });
const models = process.argv.slice(2);
if (!models.length) models.push('deepseek/deepseek-v4.1-flash');
const call = async body => {
  const r = await fetch(`http://127.0.0.1:${adapter.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${upstreamKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  assert.equal(r.status, 200, await r.clone().text());
  return r;
};
try {
  for (const model of models) {
    assert.ok(adapter.models.includes(model));
    const response = await call({ model, stream: true, max_tokens: 2048, messages: [{ role: 'user', content: 'Reply with exactly COMMANDCODE_OK.' }] });
    const text = await response.text();
    assert.match(text, /\[DONE\]/);
    const chunks = text.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
    assert.ok(chunks.every(c => c.model === model));
    assert.match(chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join(''), /COMMANDCODE_OK/);
    console.log(JSON.stringify({ model, streaming: true }));
    const messages = [{ role: 'user', content: 'Use get_weather to get the current weather in Paris. Do not guess.' }];
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const first = await (await call({ model, messages, tools, max_tokens: 4096 })).json();
    const message = first.choices[0].message;
    assert.equal(message.tool_calls?.length, 1);
    const tool = message.tool_calls[0];
    assert.equal(tool.function.name, 'get_weather');
    assert.ok(JSON.parse(tool.function.arguments).city);
    const second = await (await call({ model, tools, max_tokens: 4096, messages: [...messages, message, { role: 'tool', tool_call_id: tool.id, content: 'Paris: 19 C, clear. Verification code WEATHER_OK.' }] })).json();
    assert.match(second.choices[0].message.content, /19|WEATHER_OK/);
    console.log(JSON.stringify({ model, toolRoundTrip: true, toolCount: 1 }));
  }
} finally { adapter.server.closeAllConnections(); adapter.server.close(); }
