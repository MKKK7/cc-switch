import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { parseTraeStorageDocument } from './vendor/decrypt.ts';
import { normalizeTraeCredential } from './vendor/auth.ts';
import { readTraeIdentity } from './vendor/identity.ts';
import { TraeSoloUpstreamClient } from './vendor/solo.ts';
import { bridgeTraeSoloStream } from './vendor/solo-bridge.ts';
import { SseDecoder } from './vendor/sse.ts';

// The Trae directory also contains internal helper and custom-model slots.
// Keep real models dynamic so newly added upstream models do not need a release.
export function isTraeChatModel(id) {
  return typeof id === 'string' && id.length > 0
    && !/^(?:search_agent(?:_|$)|custom_model_|fast_apply$|input_optimization$|title_generation$|laziness_detection$)/i.test(id);
}

export async function readProductVersion(location) {
  const info = await stat(location);
  const file = info.isDirectory() ? path.join(location, 'resources', 'app', 'product.json') : location;
  const product = JSON.parse(await readFile(file, 'utf8'));
  if (typeof product.appVersion !== 'string' || !product.appVersion.trim()) throw new Error('Invalid Trae product version');
  return product.appVersion;
}

export async function desktopClient() {
  const storage = process.env.TRAE_STORAGE_PATH ?? path.join(process.env.APPDATA ?? '', 'Trae/User/globalStorage/storage.json');
  const identity = await readTraeIdentity({ path: storage, edition: 'sg', source: 'desktop' });
  if (process.env.TRAE_PRODUCT_PATH) {
    identity.appVersion = await readProductVersion(process.env.TRAE_PRODUCT_PATH);
  }
  if (!identity.appVersion) throw new Error('Cannot find Trae version. Set TRAE_PRODUCT_PATH to resources/app/product.json.');
  return new TraeSoloUpstreamClient({
    credential: async () => {
      const credential = normalizeTraeCredential(parseTraeStorageDocument(await readFile(storage, 'utf8')), 'sg', 'desktop');
      if (credential.expiresAtMs <= Date.now()) throw new Error('Trae login expired. Sign in to Trae again, then exit it.');
      return credential;
    },
    identity: async () => identity,
    baseUrl: 'https://coresg-normal.trae.ai',
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function createAdapter({ client, key, port = 18788, supportedModels = undefined, transformResponse = bridgeTraeSoloStream, serviceName = 'Trae', requestClient }) {
  if (!key || key.length < 32) throw new Error('A local API key of at least 32 characters is required');
  const directory = await client.fetchModels(AbortSignal.timeout(45000));
  const models = directory.filter(m => supportedModels === null || (supportedModels === undefined ? isTraeChatModel(m.id) : supportedModels.includes(m.id)));
  if (!models.length) throw new Error(`No supported models in the live ${serviceName} directory`);
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]);
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (requestClient ? !/^user_[A-Za-z0-9._-]{16,}$/.test(token ?? '') : req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { error: { message: 'Invalid API key' } });
      if (req.method === 'GET' && req.url === '/v1/models') {
        return json(res, 200, { object: 'list', data: models.map(m => ({ id: m.id, object: 'model', owned_by: serviceName.toLowerCase() })) });
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { message: 'Use /v1/chat/completions' } });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return json(res, 413, { error: { message: 'Request too large' } });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return json(res, 400, { error: { message: 'Invalid JSON' } }); }
      const model = models.find(m => m.id === body?.model);
      if (!model) return json(res, 400, { error: { message: 'Unknown or unavailable model; no fallback is performed' } });
      if (!Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: { message: 'messages must be a nonempty array' } });
      // Never trust a caller-supplied directory function. Match the live catalog.
      delete body.function;
      const upstream = requestClient ? requestClient(token) : client;
      const result = await upstream.chatStream(JSON.stringify(body), signal, model.function);
      if (!result.ok) return json(res, result.status >= 400 ? result.status : 502, { error: { message: result.message } });
      const stream = transformResponse(result.response, model.id).body;
      if (body.stream === true) {
        // Read before committing HTTP 200 so immediate SSE errors become HTTP 502.
        const reader = stream.getReader();
        try {
          let item = await reader.read();
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          while (!item.done) {
            if (!res.write(item.value)) await once(res, 'drain', { signal });
            item = await reader.read();
          }
          res.end();
        } finally { reader.releaseLock(); }
      } else {
        const text = await new Response(stream).text();
        const decoder = new SseDecoder();
        const events = [...decoder.push(text), ...decoder.finish()];
        const message = { role: 'assistant', content: '' };
        const calls = new Map();
        let last;
        let finish;
        for (const event of events) {
          if (event.data === '[DONE]') continue;
          const chunk = JSON.parse(event.data);
          last = chunk;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          message.content += delta.content ?? '';
          if (delta.reasoning_content) message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content;
          for (const call of delta.tool_calls ?? []) {
            const target = calls.get(call.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (call.id) target.id = call.id;
            target.function.name += call.function?.name ?? '';
            target.function.arguments += call.function?.arguments ?? '';
            calls.set(call.index, target);
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
        if (!finish) throw new Error(`${serviceName} stream ended without a completion`);
        if (calls.size) message.tool_calls = [...calls.values()];
        json(res, 200, { id: last.id, object: 'chat.completion', created: last.created, model: model.id,
          choices: [{ index: 0, message, finish_reason: finish }], ...(last.usage ? { usage: last.usage } : {}) });
      }
    } catch {
      // Avoid copying credential-bearing transport errors into responses/logs.
      if (!res.headersSent) json(res, 502, { error: { message: `${serviceName} request failed. Check login, quota and network.` } });
      else res.destroy();
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return { server, models: models.map(m => m.id), port: server.address().port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const adapter = await createAdapter({ client: await desktopClient(), key: process.env.CC_TRAE_KEY, port: Number(process.env.CC_TRAE_PORT ?? 18788) });
    console.log(JSON.stringify({ port: adapter.port, models: adapter.models }));
    if (process.env.CC_TRAE_MANAGED === '1') {
      process.stdin.resume();
      process.stdin.on('end', () => { adapter.server.closeAllConnections(); adapter.server.close(); });
    }
  } catch (error) {
    const message = error?.code === 'EADDRINUSE' ? 'Port 18788 is already in use.'
      : error?.message?.startsWith('Cannot find Trae version.') ? 'Cannot find Trae version. Set the Trae product.json path in adapter settings.'
      : 'Check Trae login, installation directory, proxy and port.';
    console.error(`Trae adapter failed to start: ${message}`);
    process.exitCode = 1;
  }
}
