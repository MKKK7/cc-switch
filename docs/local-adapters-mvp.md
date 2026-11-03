# Current provider workflow

Trae and CommandCode now appear in the standard Add Provider presets for Claude/Codex,
not in Authorization Center. Both use the existing openai_chat routing badge and mode switch.
Names, model selection, advanced parameters, API key entry, save/edit/switch remain the normal form.
Trae imports existing desktop credentials and fills a local key; independent OAuth is not implemented.
CommandCode uses the standard user_ API key from each provider record, with no DSH credential reads.
Configured adapters automatically start with CC Switch. Legacy CommandCode records need their
old random local key replaced with the real CommandCode key.

Current auth changes are tested offline (separate per-request credentials); the old live script's
DSH credential reuse was rejected by automatic approval review and was not retried.
Historical validation below predates this authentication change.

---

# Trae + CommandCode: CC Switch fork MVP

Usage: [Trae](../trae-adapter/README.md) · [CommandCode](../commandcode-adapter/README.md).

Both adapters are packaged with the application, started/stopped from Authorization Center,
and managed by the shared Rust `local_adapters` commands. Each has its own child process,
loopback port and persistent random local API key. Upstream credentials stay out of the
provider database and renderer. Provider import uses the existing `openai_chat` conversion
path and does not activate or overwrite the user's current provider.

## Validation records

2026-10-30 — Trae:

- With Trae exited, GPT-6.1-Sol and Kimi K3 streamed exact smoke-test replies. Actual upstream
  `timing_cost.provider_model_name` was `GPT-6.1-Sol` and `aws-kimi-k3` respectively.
- Both completed a get_weather tool call and tool-result round trip.
- Managed child startup, authenticated model listing and exit on parent-pipe closure passed.
- The compiled app, using an isolated CC_SWITCH_TEST_HOME, started the packaged adapter,
  imported Claude/Codex providers and streamed GPT through `/v1/messages` and `/v1/responses`.
- The authorization-center panel was visually checked in the compiled application.

2026-11-03 — CommandCode:

- Inspected installed DSH provider 0.15.4 and the earlier open-source proxy investigation.
- Reused the MIT translator from commandcode-api-proxy 0.4.1; retained DSH's CLI envelope
  and version header; removed model aliases/default substitution from the imported translator.
- Real directory returned 95 models. Exact DeepSeek V4.1 Flash and Kimi K3 IDs passed live
  streaming and tool-result round trips. Not all catalog models have been tested or entitled.
- Nine offline regressions cover auth/catalog gating, exact model forwarding, credential
  selection, tool correlation/deduplication, SSE errors, truncated streams and usage.

## Build and delivery

`pwsh -File scripts/build-trae-portable.ps1 -MinGWBin '<MinGW bin directory>'`

Uses Rust 1.95 GNU by default, includes WebView2Loader.dll and both Node adapters. The
dedicated Tauri config keeps a separate application identifier, no official updater endpoints,
and no registration of the installed CC Switch's URL scheme. The portable binary is unoptimized.
Node 24 and WebView2 Runtime are required on the destination machine.

Exit the installed CC Switch before running `Start-CCSwitch-Trae.ps1` in the output folder.
The launcher backs up the default ~/.cc-switch directory first. `-Preview` uses an isolated
test home and is not intended to configure the user's everyday CLI installations.

## Known limits

Manual adapter startup after application restart; no token renewal or account rotation.
Trae login expiration requires signing in again through Trae. CommandCode uses an existing
DSH credential; server-side plan restrictions and quotas remain in force.
Long coding sessions, image inputs and every available model have not been validated.

Final provider workflow validation: frontend typecheck/build, Rust executable build, nine adapter regressions and two routing-preset tests passed. Compiled Add Provider flow visually verified for Trae and CommandCode.
