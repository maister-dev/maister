# ACP Adapter Families: Gemini CLI and OpenCode

Status: SDD freeze for Phase 0. No production code is implemented by this spec.
Date: 2026-06-11
Branch: `feature/acp-opencode-gemini-adapters`

## Purpose

MAIster must support two additional ACP adapter families:

- `gemini` via `gemini --acp`.
- `opencode` via `opencode acp`.

They extend the existing platform ACP runner catalog. They do not introduce a
generic "run any command" executor, a non-ACP CLI automation mode, or a fallback
path to Claude/Codex. A runner is launchable only when adapter-specific
readiness proves the binary, auth, protocol, model, permission, MCP, and resume
contracts needed for that workflow.

## Source Baseline

Source-backed findings live in
[`docs/spikes/2026-06-11-acp-opencode-gemini-adapters.md`](../../docs/spikes/2026-06-11-acp-opencode-gemini-adapters.md).
The architectural decision is
[ADR-084](../../docs/decisions.md#adr-084-acp-adapter-families-for-gemini-cli-and-opencode).

Official references used for the contract:

- ACP v1: JSON-RPC 2.0 flow with initialize/authenticate/session/new or
  session/load/session/prompt/session/cancel.
- Gemini CLI ACP docs: `gemini --acp`, stdio JSON-RPC, `loadSession`,
  `unstable_setSessionModel`, MCP, optional filesystem proxy.
- OpenCode ACP docs: `opencode acp`, JSON-RPC over stdio/nd-JSON, native tools,
  MCP, AGENTS.md rules, permissions, agents, formatters, and linters.

## Local Update Snapshot

The local CLI state changed during planning:

- Gemini CLI is installed at `/opt/homebrew/bin/gemini`, version `0.46.0`.
- OpenCode was initially treated as absent from the current Codex PATH, but the
  user then installed the latest available Homebrew package. Current verified
  path is `/opt/homebrew/bin/opencode`, version `1.16.2`.
- OpenCode succeeds outside the sandbox, but sandboxed first-run execution failed
  while creating `/Users/developer/.local/share/opencode`. Readiness must distinguish
  "binary missing" from "binary present but first-run state unavailable".
- The SDK-based MAIster smoke now proves OpenCode `initialize` + `newSession`
  over `opencode acp`; permission, MCP, model-switch, and resume semantics
  remain unproven gates.
- The SDK-based MAIster smoke now proves Gemini `initialize` + `newSession`
  over `gemini --acp` using the Gemini CLI's own configured auth. MAIster does
  not require `GEMINI_API_KEY` or `GOOGLE_API_KEY` for the CLI-native path.

## Adapter Contract

| Adapter | Command | Provider kinds | Permission policies | Model channel | Resume strategy | Initial readiness |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude-agent-acp` | `anthropic`, `anthropic_compatible` | `default`, `dangerously_skip_permissions` | `settings_local` | `session/resume` | Implemented |
| `codex` | `codex-acp` | `openai`, `openai_compatible` | `default` | `unstable_setSessionModel` | `session/resume` | Implemented for OpenAI; compatible routes gated |
| `gemini` | `gemini --acp` | `google_gemini`, `google_vertex`, `google_gateway` | `default` | advisory until live method support is proven | `loadSession` only after checkpoint invariant smoke | Implemented catalog/launch contract; `NotReady` until CLI-native auth + smoke are proven |
| `opencode` | `opencode acp` | `agent_native` | `default` | advisory until live method support is proven | `session/resume` only after ACP smoke advertises/proves it | Implemented catalog/launch contract; basic SDK handshake passed, broader gates remain |

Adapter support is code-owned. Operators cannot create arbitrary adapter ids,
raw commands, or argv strings. Adapter metadata owns:

- supported provider kinds and permission policies;
- binary id, default argv, optional binary override env name;
- ACP client capabilities;
- auth strategy;
- model application strategy;
- resume/checkpoint strategy;
- diagnostics and readiness reason codes;
- capability-agent identity.

## Provider And Secret Contract

Provider shapes are discriminated by `provider.kind`.

Implemented:

- `anthropic`
- `anthropic_compatible`
- `openai`
- `openai_compatible`

Designed by this feature:

- `google_gemini`
- `google_vertex`
- `google_gateway`
- `agent_native`

Secret material is never accepted as a raw value. Web-side request bodies use
`env:NAME` refs. Supervisor-side request bodies use bare `NAME` refs after the
web tier applies `envRefName()`.

Missing env refs are launch/readiness failures, not raw 500s. Logs may include
env ref names, never values.

## Binary Override And Diagnostics Contract

The supervisor must support explicit adapter binary overrides through env vars:

| Adapter | Default command | Override env |
| --- | --- | --- |
| `claude` | `claude-agent-acp` | `MAISTER_ADAPTER_BINARY_CLAUDE` |
| `codex` | `codex-acp` | `MAISTER_ADAPTER_BINARY_CODEX` |
| `gemini` | `gemini` | `MAISTER_ADAPTER_BINARY_GEMINI` |
| `opencode` | `opencode` | `MAISTER_ADAPTER_BINARY_OPENCODE` |

Diagnostics response entries have this stable shape:

```ts
{
  id: "claude" | "codex" | "gemini" | "opencode";
  binary: string;
  source: "path" | "override";
  path: string | null;
  available: boolean;
  version: string | null;
  error: string | null;
  smoke: {
    status: "not_required" | "pending" | "ok" | "skipped" | "error";
    reason: string | null;
    checkedAt: string | null;
    protocolVersion: number | null;
  };
}
```

`available=false` covers:

- binary absent from PATH;
- override path missing;
- override path not executable;
- cheap version probe failure;
- binary starts but cannot initialize required first-run writable state;
- adapter-specific protocol smoke failure when diagnostics include cached smoke.

Gemini and OpenCode readiness requires cached smoke evidence with
`smoke.status="ok"`. The cache is read from
`MAISTER_ADAPTER_SMOKE_CACHE_PATH` or from `adapter-smoke-cache.json` under the
supervisor runtime root. The opt-in SDK smoke script is the writer:

```bash
pnpm -C supervisor smoke:acp --cache /path/to/adapter-smoke-cache.json gemini opencode
```

`pending`, `skipped`, and `error` are all launch/default-selection blockers.
`envRefs` reports a built-in safe catalog plus
`MAISTER_DIAGNOSTIC_ENV_REFS` comma-separated names; it never returns values.

Diagnostics logs include `adapter`, `binary`, `source`, resolved path if known,
exit code, and a bounded stderr tail. They never include env values or generated
config bodies.

## ACP Client Capabilities

The ACP initialize payload is adapter-specific.

- MAIster must not send generic file read/write support until confined ACP FS
  methods are implemented.
- Gemini receives an explicit no-FS-read/write policy unless future confinement
  work changes this.
- MCP server delivery remains through ACP session parameters when supported.
- Initialize logs include protocol version and summarized advertised
  capabilities only.

## Resume And Checkpoint Policy

No adapter may silently fall back from resume/load failure to `session/new`.

- Claude/Codex keep the current `session/resume` strategy.
- Gemini `loadSession` is not equivalent to MAIster checkpoint resume until an
  SDK smoke proves the checkpoint invariant.
- OpenCode resume support is unknown until ACP smoke proves the method and
  behavior.
- Unsupported resume returns `CHECKPOINT` with an actionable reason before any
  new session is created.

## Prompt Stop-Reason Policy

Supervisor `POST /sessions/{id}/prompt` success responses use:

```ts
"end_turn" | "max_tokens" | "max_turn_requests" | "refusal"
```

`cancelled` is not a supervisor prompt success state. Exact policy:

- If an adapter returns ACP prompt `stopReason: "cancelled"` for a direct prompt,
  the supervisor maps it to `SupervisorError("ACP_PROTOCOL")`.
- User-initiated graceful termination uses `DELETE /sessions/{id}`.
- Graceful checkpoint uses `POST /sessions/{id}/checkpoint`.
- Permission-deferred cancel uses `POST /sessions/{id}/input` with
  `{ action: "cancel" }` and resolves the ACP permission deferred; it does not
  make the prompt response a successful `cancelled` stop reason.
- The web tier may keep a UI/client-side `cancelled` state for local transport
  cancellation, but that is not the supervisor wire response.

## Model Catalog Contract

Gemini/OpenCode model suggestions must be explicit.

- They may return live, provider, curated, observed, skipped, or error source
  statuses.
- They must not show Claude/Codex fallback models.
- A skipped model source is a valid 200 response and does not block saving a
  runner row.
- Model application is adapter-metadata driven. If `unstable_setSessionModel` is
  unsupported or fails, the supervisor emits `model_advisory` or readiness
  refuses before spawn. It never mutates `runner.model` silently.

## Capability And MCP Contract

The code-owned agent union widens to:

```ts
"claude" | "codex" | "gemini" | "opencode"
```

Affected surfaces:

- `capabilityAgentSchema`;
- Flow node tool maps;
- `capability_records.agents[]`;
- `platform_mcp_servers.supportedAgents`;
- project MCP `supportedAgents`;
- runner snapshots and run `capabilityAgent`;
- `ENFORCEABILITY_BY_AGENT`.

Gemini/OpenCode enforcement cells start as `instructed` or `unsupported`.
No cell may ship as `enforced` in this feature. `strict` on a non-enforced cell
refuses with `CONFIG` or `EXECUTOR_UNAVAILABLE` using the existing truth table.

Existing MCP/capability rows are not silently widened. The current default
`["claude","codex"]` stays the default unless a user or migration explicitly
adds new agents.

## API Contract

Supervisor OpenAPI:

- `ExecutorAgent` enum includes all four adapters.
- `RunnerProvider` includes existing provider kinds plus ADR-084 provider kinds.
- `/diagnostics` adapter entries include `source`, `path`, `available`,
  `version`, and `error`.
- `SendPromptStopReason` remains the four-value success enum; `cancelled` is an
  `ACP_PROTOCOL` failure for direct prompts.
- Model catalog drafts accept all four adapters and return typed skipped/error
  source statuses for new adapters until smoke passes.

Web OpenAPI:

- Admin ACP runner create accepts all four adapters.
- Scratch launch options and run snapshots can return all four capability
  agents.
- MCP supported-agent arrays accept all four adapters, while defaults remain
  Claude/Codex only.
- Model suggestion drafts accept all four adapters and preserve `env:NAME`
  secret refs at the web boundary.

AsyncAPI:

- No new SSE event kind is required for Phase 0.
- Existing `session.update` with `model_advisory` remains the model mismatch
  event.

## DB Contract

No SQL DDL is required for the adapter union.

Migration audit:

- `platform_acp_runners.adapter` is SQL `text`.
- `platform_acp_runners.capability_agent` is SQL `text`.
- `runs.capability_agent` is SQL `text`.
- No migration defines CHECK constraints for those values.
- Drizzle `{ enum: [...] }` annotations are TypeScript-level only.

Implementation still must update TypeScript schema annotations, Zod validation,
fixtures, and contract tests.

## Logging Contract

All new runtime logs are structured. Include `adapter`, `runnerId`, and
`sessionId` whenever available. Never include raw env values, API keys, headers,
provider tokens, generated config bodies, or full ACP payloads.

Required events:

- `adapter.registry.resolve`
- `adapter.binary.probe`
- `acp.initialize.start`
- `acp.initialize.done`
- `acp.auth.selected`
- `acp.auth.failed`
- `acp.resume.strategy`
- `acp.model.apply`
- `runner.readiness.evaluate`
- `capability.enforcement.refuse`

## Acceptance Criteria

- Admin can create Gemini/OpenCode runner rows, but launch/default selection is
  refused until readiness is `Ready`.
- Supervisor diagnostics reports all four adapters with binary source/path,
  availability, version, and redacted error.
- OpenCode installed-but-first-run-unavailable is distinct from missing binary.
- Gemini launch is disabled until SDK initialize/newSession/auth smoke passes.
- Gemini checkpoint readiness stays disabled until `loadSession` proves the
  MAIster checkpoint invariant.
- Model suggestions never show another adapter's defaults.
- Capability settings accept `gemini` and `opencode` keys, but strict
  unenforced classes refuse.
- Prompt stop-reason policy is consistent across supervisor types, web client
  types, OpenAPI, and tests.
- Existing Claude/Codex behavior remains unchanged.

## TDD Plan

1. Adapter registry/types
   - Failing tests for all four adapter ids in web and supervisor schemas.
   - Tests for provider/policy compatibility and mismatches.
   - Tests for no arbitrary command adapter.

2. Diagnostics and binary override
   - Failing supervisor tests for default PATH, override path, missing binary,
     non-executable binary, version probe failure, and OpenCode first-run state
     failure.

3. ACP initialize and spawn
   - Fake adapter tests assert `gemini --acp`, `opencode acp`, and unchanged
     Claude/Codex argv.
   - Initialize payload tests assert adapter-specific client capabilities.

4. Auth and provider provisioning
   - Missing env refs fail with `EXECUTOR_UNAVAILABLE`.
   - Raw secrets are impossible at schema boundary.
   - Gemini authenticate path is called only when required by provider strategy.

5. Resume/checkpoint
   - Tests for `session/resume`, Gemini `loadSession`, unsupported strategy, and
     no accidental `session/new` fallback.

6. Model application and suggestions
   - Tests for typed skipped source statuses.
   - Tests for `unstable_setSessionModel` when advertised and `model_advisory`
     when missing/failing.

7. Web runner catalog/readiness
   - Route tests for create/update of Gemini/OpenCode rows.
   - Readiness matrix for missing binary, missing env, first-run state failure,
     unsupported resume, and protocol smoke pending.
   - UI/i18n tests for EN/RU visible readiness reasons.

8. Capability and MCP
   - Enforcement table tests for all four agents.
   - `strict` refusal tests for Gemini/OpenCode.
   - MCP supported-agent schema tests with no default backfill.

9. Live smoke, opt-in only
   - SDK-based smoke script against local `gemini --acp`.
   - SDK-based smoke script against local `opencode acp`.
   - Skips are explicit and recorded in the spike doc.

## Rollout Policy

- Ship schema/UI support before marking new runners `Ready`.
- New presets, if added, must be disabled or `NotReady` by default.
- Do not make Gemini/OpenCode the platform default automatically.
- Do not flip capability enforcement cells without a separate live-spike ADR or
  ADR update.
- Do not add ACP FS proxy methods in this feature.
- Do not change SQL schema unless a future migration audit finds a real
  constraint not observed in Phase 0.
