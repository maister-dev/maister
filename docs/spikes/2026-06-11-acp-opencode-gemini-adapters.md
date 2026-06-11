# ACP OpenCode and Gemini CLI Adapter Spike

Date: 2026-06-11

## Purpose

This spike freezes the first compatibility baseline for widening MAIster's ACP
runner catalog from `claude | codex` to include `gemini | opencode`.

The goal is not to declare runtime support yet. The goal is to capture the
local binaries, upstream protocol claims, compatibility risks, and readiness
gates that the implementation must respect before MAIster can truthfully launch
these adapters.

## Sources

- Local Gemini CLI: `/opt/homebrew/bin/gemini`, `gemini --version` =>
  `0.46.0`.
- Local Gemini ACP docs:
  `/opt/homebrew/Cellar/gemini-cli/0.46.0/libexec/lib/node_modules/@google/gemini-cli/bundle/docs/cli/acp-mode.md`.
- Upstream Gemini ACP docs:
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md>.
- Local OpenCode: `/opt/homebrew/bin/opencode`, `brew list --versions
  opencode` => `opencode 1.16.2`.
- Upstream OpenCode ACP docs: <https://opencode.ai/docs/acp/>.
- Upstream OpenCode CLI docs: <https://opencode.ai/docs/cli/>.
- ACP v1 overview: <https://agentclientprotocol.com/protocol/v1/overview>.
- MAIster SDK smoke: `pnpm -C supervisor smoke:acp gemini opencode`
  (run outside the Codex sandbox because `tsx` IPC and OpenCode first-run state
  creation require host permissions).
- To feed supervisor `/diagnostics`, run the same smoke with
  `--cache /path/to/adapter-smoke-cache.json` and point the supervisor at that
  file with `MAISTER_ADAPTER_SMOKE_CACHE_PATH`.

## Local CLI Findings

### Gemini CLI

`gemini --help` exposes:

- `--acp` and deprecated `--experimental-acp`;
- `--debug`;
- `--approval-mode` with `default | auto_edit | yolo | plan`;
- `--allowed-mcp-server-names`;
- `--resume`, `--session-file`, `--session-id`;
- `gemini mcp`.

The installed and upstream ACP docs state that `gemini --acp` communicates
over stdio using JSON-RPC 2.0. The docs list these relevant methods:

- `initialize`;
- `authenticate`;
- `newSession`;
- `loadSession`;
- `prompt`;
- `cancel`;
- `setSessionMode`;
- `unstable_setSessionModel`.

The installed bundle contains initialize-response code that advertises
`agentCapabilities.loadSession=true`, prompt capabilities for image/audio and
embedded context, and MCP capabilities for HTTP/SSE. The observed code does
not advertise `sessionCapabilities.resume`.

Gemini creates an ACP filesystem proxy only when the client advertises an `fs`
capability. MAIster currently sends `clientCapabilities: { fs: {} }` to every
adapter, which is too broad for this feature. The Gemini path must receive an
explicit adapter-specific client capability policy and MAIster must not
advertise file read/write support until it implements confined ACP FS methods.

A raw hand-written NDJSON initialize attempt with protocol version `1` produced
no stdout within 5 seconds during planning. That is not a compatibility failure
by itself; it is evidence that the next smoke must use the real
`@agentclientprotocol/sdk` client rather than a handcrafted JSON stream.

### OpenCode

OpenCode is now installed and linked:

- `which opencode` => `/opt/homebrew/bin/opencode`;
- `opencode --version` => `1.16.2`;
- `brew list --versions opencode` => `opencode 1.16.2`;
- `brew info opencode` reports the Homebrew core formula as installed and
  linked, but the sandboxed command cannot create Homebrew API cache
  directories.

The sandboxed `opencode --version` failed before escalation because OpenCode
tried to create `/Users/developer/.local/share/opencode`. The supervisor diagnostics
must therefore distinguish:

- binary not found in PATH;
- binary found but non-executable;
- binary executable but first-run state directory is not writable;
- explicit binary override path;
- version probe failure.

`opencode acp --help` reports:

- command: `opencode acp`;
- description: start ACP server;
- `--print-logs`;
- `--log-level DEBUG|INFO|WARN|ERROR`;
- `--pure`;
- `--port` default `0`;
- `--hostname` default `127.0.0.1`;
- `--mdns`, `--mdns-domain`;
- `--cors`;
- `--cwd`.

The upstream OpenCode ACP docs instruct ACP clients to run `opencode acp` and
state that it communicates with the editor over JSON-RPC via stdio. The local
help also exposes network-style server flags (`--port`, `--hostname`, mDNS, and
CORS). MAIster must not assume the effective transport solely from help text:
the SDK smoke must prove whether default `opencode acp` is a stdio ACP
subprocess compatible with the current supervisor, and whether any HTTP mode is
out of scope for this feature.

OpenCode docs state that ACP mode supports built-in tools, custom tools,
configured MCP servers, project rules from `AGENTS.md`, custom formatters and
linters, agents, and its permissions system. Built-in slash commands such as
`/undo` and `/redo` are documented as unsupported in ACP.

## SDK Smoke Results

The implemented opt-in smoke script uses MAIster's runtime
`@agentclientprotocol/sdk`, the supervisor adapter registry, and the same
adapter-specific client capability policy as production.

Observed on 2026-06-11:

- `gemini`: passed `initialize` and `newSession` through
  `/opt/homebrew/bin/gemini --acp`; observed `protocolVersion=1` and ACP
  session ids such as `b1fbc36a-6bc1-4257-8dd7-573c40bcea77`. The smoke used
  the Gemini CLI's own configured auth; no MAIster `GEMINI_API_KEY` or
  `GOOGLE_API_KEY` was required.
- `opencode`: passed `initialize` and `newSession` through
  `/opt/homebrew/bin/opencode`; observed `protocolVersion=1` and an ACP session
  id (`ses_14939bcacffePT34Txai0UBpVb` in the local run).

This proves Gemini and OpenCode basic stdio ACP handshakes in the host
environment. It does not yet prove permission requests, resume/load checkpoint
semantics, MCP forwarding, or active model switching for either adapter.

## Compatibility Matrix

| Adapter | Launch command | Expected transport | Auth/provisioning | MCP | FS | Model switching | Permissions | Resume/load |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude-agent-acp` | ACP stdio | Existing Anthropic/env-router/CCR path | MAIster passes ACP `mcpServers` | MAIster currently advertises `fs:{}` but should become registry-driven | `settings.local.json` channel | ACP permission HITL implemented | `session/resume` implemented and tested with mock/live spike |
| `codex` | `codex-acp` | ACP stdio | Existing OpenAI path; `openai_compatible` still blocked until materialization is proven | MAIster passes ACP `mcpServers` | MAIster currently advertises `fs:{}` but should become registry-driven | `unstable_setSessionModel` | ACP permission HITL implemented | `session/resume` implemented with mock coverage |
| `gemini` | `gemini --acp` | SDK smoke passed `initialize` + `newSession` over stdio | Prefer native Gemini CLI config first; optional env refs only for explicit operator overrides/gateway strategies | Docs and bundle indicate MCP support, including HTTP/SSE | Requires adapter-specific client caps; no MAIster FS proxy until confinement design exists | Docs and bundle expose `unstable_setSessionModel` | Requires SDK smoke for request shape and approval-mode mapping | Bundle advertises `loadSession`, not observed `sessionCapabilities.resume`; checkpoint compatibility unproven |
| `opencode` | `opencode acp` | SDK smoke passed `initialize` + `newSession` over stdio; local help also exposes server flags | Prefer native OpenCode provider config first; optional env refs only if spec freezes them | Docs say configured MCP servers are available in ACP mode | No MAIster FS proxy advertised; smoke used explicit `readTextFile:false/writeTextFile:false` | Active switching still unproven; V1 emits advisory | Docs say permissions system is available; shape must be SDK-smoked | Unknown from docs/help; session commands exist outside ACP, but ACP resume semantics must be proven |

## Required Runtime Events

Future implementation logs must be structured and configurable through the
existing logger level. They must not contain secret values.

- `adapter.registry.resolve`: `adapter`, `runnerId`, `binary`, `binarySource`,
  `modelChannel`, `resumeStrategy`.
- `adapter.binary.probe`: `adapter`, `binary`, `binarySource`, `available`,
  `version`, `exitCode`, `stderrTail`.
- `acp.initialize.start`: `adapter`, `sessionId`, `runnerId`,
  `clientCapabilitiesPolicy`.
- `acp.initialize.done`: `adapter`, `sessionId`, `protocolVersion`,
  `agentCapabilitiesSummary`.
- `acp.auth.selected`: `adapter`, `runnerId`, `providerKind`, `envRefNames`.
- `acp.auth.failed`: `adapter`, `runnerId`, `providerKind`, `code`,
  `message`.
- `acp.resume.strategy`: `adapter`, `sessionId`, `resumeStrategy`,
  `resumeSessionId`, `advertisedCapabilitiesSummary`.
- `acp.model.apply`: `adapter`, `sessionId`, `model`, `modelChannel`,
  `outcome`.
- `runner.readiness.evaluate`: `runnerId`, `adapter`, `providerKind`,
  `status`, `reasonCodes`.
- `capability.enforcement.refuse`: `nodeId`, `adapter`, `capabilityClass`,
  `declared`, `capability`, `code`.

## Readiness Gates

Gemini can be marked ready for non-checkpointed launch only when all are true:

- `gemini` binary is executable in the supervisor environment;
- auth/env provisioning is configured without raw secret values;
- SDK-based `initialize` and `newSession` smoke succeeds;
- client capabilities are explicit and do not imply unconstrained file access;
- model switching either succeeds through `unstable_setSessionModel` or is
  documented as advisory/skipped;
- prompt and permission request shapes are mapped to existing HITL semantics.

Gemini can be marked ready for checkpointed workflows only when an SDK smoke
proves that `loadSession` preserves MAIster's checkpoint invariant. If this is
not proven, checkpointed Gemini workflows must fail readiness with a
`CHECKPOINT`-class reason.

OpenCode can be marked ready for basic non-checkpointed launch when all are true:

- `opencode` binary is executable in the supervisor environment;
- first-run data/config directories are writable or explicitly configured;
- SDK-based `initialize` and `newSession` smoke proves default `opencode acp`
  works as a stdio ACP subprocess;

OpenCode can be marked ready for broader production workflows only when these
additional gates pass:

- the smoke records permission request, MCP, model, and resume capabilities;
- unsupported slash commands are documented as outside MAIster's ACP workflow;
- configured MCP and provider/auth behavior does not leak secrets into logs,
  SSE, or the web API.

## Implementation Consequences

- Use an adapter registry instead of expanding scattered Claude/Codex literals.
- Keep `openai_compatible` guarded for Codex until materialization is proven;
  Gemini/OpenCode provider support must not weaken this existing refusal.
- Add supervisor-side binary override support before relying on PATH-only
  diagnostics.
- Align prompt stop-reason policy across supervisor types, web client types, and
  API specs before adding adapter mocks.
- Treat OpenCode `--port/--hostname` flags as a compatibility question for the
  smoke script, not as permission to add HTTP ACP transport in this feature.
- Keep all Gemini/OpenCode capability classes `instructed` or `unsupported`
  until live evidence proves enforceability.
