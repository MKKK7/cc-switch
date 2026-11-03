import { toCCRequest, OpenAIStreamEncoder } from './vendor/translate/openai.js';

export const API_BASE = 'https://api.commandcode.ai';
export const CLI_VERSION = '1.88.0'; // Installed DSH provider 0.15.4.

export function prepareRequest(input) {
  const body = toCCRequest(input, { workingDir: '.', environment: `${process.platform}-${process.arch}, Node.js ${process.version}` });
  body.params.model = input.model;
  body.params.stream = true;
  body.memory = body.taste = body.skills = null;
  const requestedMax = input.max_completion_tokens ?? input.max_tokens ?? 8192;
  if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 200000) throw new Error('max_tokens must be between 1 and 200000');
  body.params.max_tokens = requestedMax;
  body.params.tools = (body.params.tools ?? []).map(tool => ({ type: 'function', ...tool }));
  // Use the cacheable system-section form used by DSH 0.15.4.
  if (body.params.system) body.params.system = [{ type: 'text', text: body.params.system, cache_control: { type: 'ephemeral' } }];
  return body;
}

export class CommandCodeClient {
  constructor({ credential = async () => { throw new Error('CommandCode API key required'); }, fetchImpl = fetch } = {}) {
    this.credential = credential;
    this.fetch = fetchImpl;
  }
  async fetchModels(signal) {
    // Fail early if this machine has no configured credential, even though the
    // public model directory does not require authentication.
    const response = await this.fetch(`${API_BASE}/provider/v1/models`, { signal });
    if (!response.ok) throw new Error(`Model directory returned HTTP ${response.status}`);
    const json = await response.json();
    const rows = Array.isArray(json) ? json : json.data ?? json.models;
    if (!Array.isArray(rows)) throw new Error('Invalid model directory');
    return rows.filter(row => typeof row.id === 'string').map(row => ({ id: row.id }));
  }
  async chatStream(bodyJson, signal) {
    let body;
    try { body = prepareRequest(JSON.parse(bodyJson)); }
    catch { return { ok: false, status: 400, message: 'Invalid CommandCode request or token budget' }; }
    const key = await this.credential();
    const response = await this.fetch(`${API_BASE}/alpha/generate`, {
      method: 'POST', signal, headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
        'x-command-code-version': CLI_VERSION, 'x-cli-environment': 'production',
        'x-project-slug': 'cc-switch', 'x-session-id': body.threadId,
        'x-taste-learning': 'false', 'x-co-flag': 'false',
      }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, message: `CommandCode returned HTTP ${response.status}; check account, model entitlement and quota` };
    }
    return { ok: true, response };
  }
}

export function bridgeCommandCode(response, model) {
  if (!response.body) throw new Error('Empty CommandCode response');
  const encoder = new OpenAIStreamEncoder(model);
  const decoder = new TextDecoder();
  const bytes = new TextEncoder();
  const reader = response.body.getReader();
  let buffer = '';
  let finished = false;
  const queue = [];
  function consume(line) {
    line = line.trim();
    if (!line || line.startsWith(':') || /^(event|id|retry):/.test(line)) return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line === '[DONE]') return;
    const raw = JSON.parse(line);
    const { type, ...rest } = raw;
    const data = raw.data && typeof raw.data === 'object' ? raw.data : rest;
    if (type === 'error' || (type === 'finish' && data.finishReason === 'error')) throw new Error('CommandCode upstream stream error');
    if (finished) return;
    if (type === 'finish') finished = true;
    for (const chunk of encoder.emit({ type, data })) queue.push(bytes.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        while (!queue.length) {
          const next = await reader.read();
          if (next.done) {
            buffer += decoder.decode();
            if (buffer.trim()) consume(buffer);
            if (!finished) throw new Error('CommandCode stream truncated before finish');
            for (const chunk of queue.splice(0)) controller.enqueue(chunk);
            controller.enqueue(bytes.encode('data: [DONE]\n\n'));
            controller.close(); reader.releaseLock(); return;
          }
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw new Error('CommandCode event too large');
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) consume(line);
        }
        controller.enqueue(queue.shift());
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
