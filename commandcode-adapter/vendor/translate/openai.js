import crypto from "node:crypto";
import { toolArgumentSuffix } from "./tool-arguments.js";
import { resolveModel, resolveEffortForModel } from "../translate/models.js";
import { applyNoToolsSafeguard, extractUsage, pruneDanglingTools, buildCCConfig, } from "../translate/util.js";
import { logger } from "../logger.js";
// ──────────────────────────────────────────
// OpenAI request → CC request
// ──────────────────────────────────────────
function toCCMessages(messages) {
    const systemParts = [];
    const ccMessages = [];
    // Map tool_call_id -> toolName so tool-result parts can carry the tool name
    // required by the CC upstream schema (tool-result parts need a `toolName`).
    const toolNameById = new Map();
    for (const msg of messages) {
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                if (tc.id)
                    toolNameById.set(tc.id, tc.function.name);
            }
        }
    }
    for (const msg of messages) {
        if (msg.role === "system" || msg.role === "developer") {
            const text = typeof msg.content === "string"
                ? msg.content
                : msg.content
                    .map((p) => (p.type === "text" ? p.text : ""))
                    .filter(Boolean)
                    .join("\n");
            systemParts.push(text);
            continue;
        }
        if (msg.role === "tool") {
            const resultText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            ccMessages.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: msg.tool_call_id ?? "",
                        toolName: (msg.tool_call_id ? toolNameById.get(msg.tool_call_id) : undefined) ?? "",
                        output: { type: "text", value: resultText },
                    },
                ],
            });
            continue;
        }
        if (msg.role === "assistant" && msg.tool_calls) {
            const parts = [];
            if (typeof msg.content === "string" && msg.content) {
                parts.push({ type: "text", text: msg.content });
            }
            for (const tc of msg.tool_calls) {
                let parsedInput;
                try {
                    parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                }
                catch {
                    parsedInput = tc.function.arguments;
                }
                parts.push({
                    type: "tool-call",
                    toolCallId: tc.id,
                    toolName: tc.function.name,
                    input: parsedInput,
                });
            }
            ccMessages.push({ role: "assistant", content: parts });
            continue;
        }
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                ccMessages.push({ role: "user", content: msg.content });
            }
            else {
                const parts = msg.content.map((p) => {
                    if (p.type === "image_url" && p.image_url) {
                        return { type: "image", image: p.image_url.url };
                    }
                    return { type: "text", text: p.text ?? "" };
                });
                ccMessages.push({ role: "user", content: parts });
            }
            continue;
        }
        // assistant (plain text)
        if (typeof msg.content === "string") {
            ccMessages.push({ role: "assistant", content: msg.content });
        }
    }
    return {
        ccMessages: pruneDanglingTools(ccMessages),
        systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    };
}
function toCCTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    return tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}
/**
 * Map an OpenAI `tool_choice` to the object form CC's bridge requires.
 * CC validates `params.tool_choice` as an object and rejects bare strings.
 * Accepted types: "auto" | "any" | "tool". There is no "required" (use "any")
 * and no "none" — "none" has no CC equivalent, so we fall back to the default
 * (omit) and let the model decide.
 */
function resolveToolChoice(tc) {
    if (!tc || tc === "auto" || tc === "none")
        return undefined;
    if (tc === "required")
        return { type: "any" };
    if (typeof tc === "object" && tc.type === "function") {
        return { type: "tool", name: tc.function.name };
    }
    return undefined;
}
export function toCCRequest(req, configOverrides) {
    const { ccMessages, systemPrompt } = toCCMessages(req.messages);
    const resolvedModel = resolveModel(req.model);
    const body = {
        config: buildCCConfig(configOverrides),
        memory: "",
        taste: "",
        skills: "",
        permissionMode: "standard",
        params: {
            model: resolvedModel,
            messages: ccMessages,
            stream: req.stream ?? false,
            max_tokens: req.max_tokens,
            temperature: req.temperature,
            top_p: req.top_p,
            stop: req.stop,
            reasoning_effort: resolveEffortForModel(resolvedModel, req.reasoning_effort),
            tools: toCCTools(req.tools),
            tool_choice: resolveToolChoice(req.tool_choice),
        },
        threadId: crypto.randomUUID(),
    };
    if (systemPrompt)
        body.params.system = systemPrompt;
    applyNoToolsSafeguard(body, ccMessages, req.tools != null && req.tools.length > 0);
    return body;
}
// ──────────────────────────────────────────
// CC events → OpenAI streaming chunks
// ──────────────────────────────────────────
const OPENAI_FINISH_MAP = {
    stop: "stop",
    length: "length",
    content_filtered: "content_filter",
    "tool-call": "tool_calls",
    "tool-calls": "tool_calls",
    tool_call: "tool_calls",
    error: "stop",
};
function toOpenAIUsage(u) {
    const promptTokens = u.promptTokens ?? 0;
    const completionTokens = u.completionTokens ?? 0;
    const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: u.totalTokens ?? promptTokens + completionTokens,
    };
    if (u.promptTokensDetails?.cachedTokens != null) {
        usage.prompt_tokens_details = { cached_tokens: u.promptTokensDetails.cachedTokens };
    }
    if (u.completionTokensDetails?.reasoningTokens != null) {
        usage.completion_tokens_details = {
            reasoning_tokens: u.completionTokensDetails.reasoningTokens,
        };
    }
    return usage;
}
export class OpenAIStreamEncoder {
    model;
    id;
    created;
    toolCallIndex = 0;
    sawFinish = false;
    // Map a CC toolCallId to the OpenAI streaming `index` we assigned it.
    // Without this, parallel tool-call-delta streams without an explicit
    // `index` field would all be assigned index 0 and the client would merge
    // them into a single tool call.
    toolCallIdToIndex = new Map();
    toolArguments = new Map();
    toolMetadata = new Map();
    toolMetadataDelta(index, id, name) {
        const seen = this.toolMetadata.get(index) ?? {};
        const delta = {};
        for (const [field, value] of [["id", id], ["name", name]]) {
            if (!value)
                continue;
            if (seen[field] && seen[field] !== value) {
                throw new Error("Inconsistent upstream tool metadata");
            }
            if (!seen[field]) {
                seen[field] = value;
                delta[field] = value;
                if (field === "id")
                    delta.type = "function";
            }
        }
        this.toolMetadata.set(index, seen);
        return delta;
    }
    constructor(model) {
        this.model = model;
        this.id = crypto.randomUUID();
        this.created = Math.floor(Date.now() / 1000);
    }
    get finished() {
        return this.sawFinish;
    }
    /**
     * Resolve the OpenAI streaming `index` for a given tool-call id, allocating
     * a new one on first sighting. Falls back to the upstream-provided index
     * (if any) so we don't fight a bridge that already numbers them.
     */
    resolveToolCallIndex(toolCallId, upstreamIndex) {
        if (toolCallId) {
            const known = this.toolCallIdToIndex.get(toolCallId);
            if (known !== undefined)
                return known;
            const idx = upstreamIndex ?? this.toolCallIndex++;
            this.toolCallIdToIndex.set(toolCallId, idx);
            return idx;
        }
        return upstreamIndex ?? this.toolCallIndex++;
    }
    emit(event) {
        const chunks = [];
        const id = this.id;
        const created = this.created;
        switch (event.type) {
            case "start": {
                this.toolCallIndex = 0;
                chunks.push({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: this.model,
                    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                });
                break;
            }
            case "text-delta": {
                const text = event.data.text;
                if (text) {
                    chunks.push({
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: this.model,
                        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                    });
                }
                break;
            }
            case "reasoning-delta": {
                const text = event.data.text;
                if (text) {
                    chunks.push({
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: this.model,
                        choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
                    });
                }
                break;
            }
            case "tool-call-delta": {
                const toolCallId = event.data.toolCallId ?? undefined;
                const upstreamIndex = event.data.index ?? undefined;
                const tc = {
                    index: this.resolveToolCallIndex(toolCallId, upstreamIndex),
                    function: { arguments: event.data.arguments ?? "" },
                };
                const metadata = this.toolMetadataDelta(tc.index, toolCallId, event.data.name);
                if (metadata.id) {
                    tc.id = metadata.id;
                    tc.type = metadata.type;
                }
                if (metadata.name) {
                    tc.function.name = metadata.name;
                }
                this.toolArguments.set(tc.index, (this.toolArguments.get(tc.index) ?? "") + tc.function.arguments);
                chunks.push({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: this.model,
                    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
                });
                break;
            }
            case "tool-call": {
                const toolCallId = event.data.toolCallId ?? "";
                const toolName = event.data.toolName ?? event.data.name ?? "";
                const input = event.data.input ?? event.data.arguments;
                const args = typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
                // Reuse the index allocated by any prior tool-call-delta for this id
                // so the client merges the final tool-call with the streamed deltas
                // instead of seeing it as a brand-new tool call.
                const index = this.resolveToolCallIndex(toolCallId || undefined, event.data.index ?? undefined);
                const emitted = this.toolArguments.get(index) ?? "";
                const suffix = toolArgumentSuffix(emitted, args);
                this.toolArguments.set(index, emitted + suffix);
                const { name, ...identity } = this.toolMetadataDelta(index, toolCallId, toolName);
                chunks.push({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: this.model,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index,
                                        ...identity,
                                        function: { ...(name ? { name } : {}), arguments: suffix },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                });
                break;
            }
            case "finish": {
                this.sawFinish = true;
                const usage = extractUsage(event.data);
                const finishReason = event.data.finishReason ?? "stop";
                chunks.push({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: this.model,
                    choices: [
                        { index: 0, delta: {}, finish_reason: OPENAI_FINISH_MAP[finishReason] ?? "stop" },
                    ],
                });
                if (usage) {
                    chunks.push({
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: this.model,
                        choices: [],
                        usage: toOpenAIUsage(usage),
                    });
                }
                break;
            }
            case "error": {
                this.sawFinish = true;
                return this.errorChunks(event.data.message ??
                    event.data.error?.message ??
                    JSON.stringify(event.data));
            }
        }
        return chunks;
    }
    /**
     * Build a uniform error→content+finish chunk pair. Used both by `emit()`
     * for upstream error events and by the server's pumpStream catch for
     * stream-level errors (TCP failure, idle timeout, encoder throw). Both
     * paths surface errors as valid chat.completion.chunk records so the
     * client always sees a uniform stream shape instead of a mix of valid
     * chunks and an ad-hoc `{error:...}` envelope.
     */
    errorChunks(message) {
        const id = this.id;
        const created = this.created;
        logger.error(`[CC upstream error] ${message}`);
        return [
            {
                id,
                object: "chat.completion.chunk",
                created,
                model: this.model,
                choices: [
                    { index: 0, delta: { content: `[upstream error] ${message}` }, finish_reason: null },
                ],
            },
            {
                id,
                object: "chat.completion.chunk",
                created,
                model: this.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
        ];
    }
    errorChunk(err) {
        // Retained for backwards-compat with tests; new code should call
        // errorChunks() instead so the error appears inside a valid chunk.
        return {
            error: {
                message: err.message,
                type: "upstream_error",
            },
        };
    }
    /**
     * Build the closing chunks for a stream that ended without a `finish`
     * event from the upstream (e.g. upstream connection dropped mid-response).
     * Emits a synthetic finish_reason so the client SDK doesn't see a
     * truncated response.
     */
    finishChunks(reason = "stop") {
        return [
            {
                id: this.id,
                object: "chat.completion.chunk",
                created: this.created,
                model: this.model,
                choices: [{ index: 0, delta: {}, finish_reason: reason }],
            },
        ];
    }
    /**
     * Public wrapper around errorChunks() for stream-level errors caught by
     * pumpStream (TCP failure, idle timeout, encoder throw). Emits a uniform
     * content+finish chunk pair instead of an out-of-band error envelope.
     */
    streamErrorChunks(err) {
        return this.errorChunks(err.message);
    }
}
export function buildNonStreamingResponse(events, model, id) {
    let content = "";
    let reasoningContent = "";
    const toolCalls = [];
    let finish = null;
    for (const event of events) {
        switch (event.type) {
            case "error":
                // Do not turn failed generations (or private diagnostics) into content.
                throw new Error("CC upstream generation failed");
            case "text-delta":
                content += event.data.text ?? "";
                break;
            case "reasoning-delta":
                reasoningContent += event.data.text ?? "";
                break;
            case "tool-call-delta": {
                const existing = toolCalls.find((tc) => tc.id === event.data.toolCallId);
                if (existing) {
                    existing.function.arguments += event.data.arguments ?? "";
                }
                else {
                    toolCalls.push({
                        id: event.data.toolCallId ?? "",
                        type: "function",
                        function: {
                            name: event.data.name ?? "",
                            arguments: event.data.arguments ?? "",
                        },
                    });
                }
                break;
            }
            case "tool-call": {
                // CC bridges commonly emit tool-call-delta * N then a final tool-call
                // with the same id. If we already accumulated args from deltas,
                // replace that entry with the canonical final payload (matches what
                // the streaming encoder does). Otherwise this is a one-shot tool
                // call with no preceding deltas — push it.
                const id = event.data.toolCallId ?? "";
                const input = event.data.input ?? event.data.arguments;
                const argsStr = typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
                const name = event.data.toolName ?? event.data.name ?? "";
                const existingIdx = toolCalls.findIndex((tc) => tc.id === id);
                const entry = {
                    id,
                    type: "function",
                    function: { name, arguments: argsStr },
                };
                if (existingIdx >= 0) {
                    toolCalls[existingIdx] = entry;
                }
                else {
                    toolCalls.push(entry);
                }
                break;
            }
            case "finish":
                finish = {
                    finishReason: event.data.finishReason,
                    usage: extractUsage(event.data),
                };
                break;
        }
    }
    const message = { role: "assistant" };
    if (reasoningContent)
        message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0)
        message.tool_calls = toolCalls.slice();
    if (content) {
        message.content = content;
    }
    else if (toolCalls.length === 0) {
        message.content = "";
    }
    const finishReason = finish?.finishReason ?? "stop";
    const response = {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message,
                finish_reason: OPENAI_FINISH_MAP[finishReason] ?? "stop",
            },
        ],
    };
    if (finish?.usage)
        response.usage = toOpenAIUsage(finish.usage);
    return response;
}
//# sourceMappingURL=openai.js.map