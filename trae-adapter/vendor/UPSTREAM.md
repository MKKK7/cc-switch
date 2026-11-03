Source: https://github.com/anghunk/trae-proxy
Commit: d64f68a70a0c6e0b1f1dee8c18e1c7bb839a30c8

Runtime-only subset of the MIT-licensed TypeScript adapter.
Local change: solo-bridge.ts rejects EOF without a terminal event instead of
synthesizing a successful completion.
Tool deltas omit empty IDs and suppress Trae's repeated terminal id/name header
so OpenAI clients do not concatenate a tool name twice.
Node 24 strips types directly; type-only imports into the omitted application are
not loaded at runtime. The original copyright and license are in LICENSE.
