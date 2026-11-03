// Opt-in paid/account-quota smoke test. No credentials or raw responses written.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAdapter, desktopClient } from './server.mjs';
const key = randomBytes(32).toString('hex');
const client = await desktopClient();
const actual = [];
const original = client.chatStream.bind(client);
client.chatStream = async (...args) => {
  const result = await original(...args);
  if (result.ok) {
    // Inspect a copy for server-reported identity, never rely on self-description.
    const text = await result.response.clone().text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const data = JSON.parse(line.slice(5)); if (data.provider_model_name) actual.push(data.provider_model_name); } catch {}
    }
  }
  return result;
};
// This smoke test has identity assertions for these two models only.
const adapter = await createAdapter({ client, key, port: 0, supportedModels: ['gpt-6.1-sol', 'kimi-k3'] });
const call = async body => {
  const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
};
try {
  for (const model of adapter.models) {
    const response = await call({ model, stream: true, messages: [{ role: 'user', content: 'Reply with exactly CC_TRAE_OK.' }] });
    const text = await response.text();
    assert.match(text, /\[DONE\]/);
    const chunks = text.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
    const content = chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
    assert.match(content, /CC_TRAE_OK/);
    assert.equal(actual.at(-1), model === 'kimi-k3' ? 'aws-kimi-k3' : 'GPT-6.1-Sol');
    console.log(JSON.stringify({ model, providerModel: actual.at(-1), streaming: true, reply: content }));
  }
  for (const model of adapter.models) {
  const messages = [{ role: 'user', content: 'Use get_weather to get the current weather in Paris. Do not guess.' }];
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get live weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const first = await (await call({ model, messages, tools })).json();
  const message = first.choices[0].message;
  assert.equal(message.tool_calls?.[0]?.function?.name, 'get_weather');
  const toolCall = message.tool_calls[0];
  const second = await (await call({ model, tools, messages: [...messages, message, { role: 'tool', tool_call_id: toolCall.id, content: 'Paris: 19 C, clear. Verification code WEATHER_OK.' }] })).json();
  assert.match(second.choices[0].message.content, /19|WEATHER_OK/);
  console.log(JSON.stringify({ model, toolCall: toolCall.function.name, toolRoundTrip: true }));
  }
} finally { adapter.server.closeAllConnections(); adapter.server.close(); }
