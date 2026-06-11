# Implementation Plan: ACP Adapter Families for OpenCode and Gemini CLI

Branch: feature/acp-opencode-gemini-adapters
Created: 2026-06-11
Improved: 2026-06-11 (`$aif-improve`, branch created from local `main`)

## Settings
- Testing: yes (TDD; every behavior-changing implementation task starts with a failing unit/integration/smoke test)
- Logging: verbose (structured DEBUG/INFO at adapter registry, readiness, spawn, ACP handshake, resume/auth/model paths; no secrets)
- Docs: yes (mandatory SDD spec freeze before production code)
- Approach: SDD-first Phase 0, then TDD-driven implementation in dependency order

## Roadmap Linkage
Milestone: "M14. Scoped capability materialization" plus the existing platform ACP runner catalog work.
Rationale: OpenCode and Gemini are new ACP adapter families. They touch the same runtime surfaces as adapter provisioners, capability materialization, runner readiness, model application, and settings enforcement. This extends the existing runner catalog instead of creating a parallel executor system.

## Improvement Pass Findings (2026-06-11)

The second-pass review checked the plan against the current supervisor/web contracts instead of treating "add two agents" as a pure enum expansion. The concrete gaps to cover during implementation are:

- `supervisor/src/types.ts`, `web/lib/supervisor-client.ts`, and OpenAPI currently define mostly parallel but not identical prompt stop-reason contracts. The feature must explicitly preserve or revise the `cancelled` handling policy and test it with the new adapters.
- `supervisor/src/http-api.ts` and `supervisor/src/spawn.ts` have separate Claude/Codex binary literals. A single adapter registry must own binary names, default args, optional supervisor-side binary path overrides, diagnostics, spawn logging, and test overrides.
- `supervisor/src/acp-client.ts` currently advertises `clientCapabilities: { fs: {} }` to every adapter. Gemini's installed ACP code branches on client FS capability, so client capabilities must be adapter-specific and intentionally limited.
- `supervisor/src/runner-provisioner.ts` intentionally refuses `openai_compatible` until materialization is proven. New Gemini/OpenCode provider support must not weaken that existing Codex guard by accident.
- `web/app/api/admin/acp-runners/model-suggestions/route.ts`, `components/settings/use-model-suggestions.ts`, and `supervisor/src/model-catalog/*` are part of the runner UX contract. Gemini/OpenCode must get explicit model-suggestion behavior: live probe, provider API, curated fallback, or typed skip.
- The current local OpenCode state changed during implementation: the Homebrew binary is now installed and linked, but sandboxed execution failed on first-run state directory creation. Readiness and diagnostics need an operator-visible way to distinguish PATH absence, non-executable binaries, first-run writable-state failures, and intentional adapter disablement.

## Scope

Add first-class ACP support for:

- `opencode` via `opencode acp`.
- `gemini` via `gemini --acp`.

The feature must preserve MAIster's current truthfulness guarantees:

- no silent fallback to Claude/Codex when a new adapter is missing or unsupported;
- no "Ready" state unless supervisor diagnostics prove the runtime can launch the adapter;
- no strict capability enforcement claims until each adapter-specific mechanism is proven;
- checkpoint/resume must remain explicit, especially for Gemini's `loadSession` versus MAIster's current `session/resume` contract.

Out of scope:

- replacing the ACP supervisor with direct CLI automation;
- adding non-ACP OpenCode/Gemini execution modes;
- adding a generic "any command" runner;
- flipping Gemini/OpenCode capability classes to `enforced` without live spike evidence;
- making OpenCode/Gemini the platform default automatically.

## Local CLI Findings (2026-06-11)

- Gemini CLI is installed at `/opt/homebrew/bin/gemini`, version `0.46.0`.
- `gemini --help` exposes `--acp`, `--debug`, `--approval-mode`, `--allowed-mcp-server-names`, `--resume`, `--session-id`, and `gemini mcp`.
- Installed Gemini docs at `/opt/homebrew/Cellar/gemini-cli/0.46.0/libexec/lib/node_modules/@google/gemini-cli/bundle/docs/cli/acp-mode.md` describe ACP mode as JSON-RPC over stdio with `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, and `unstable_setSessionModel`.
- Installed Gemini bundle advertises `agentCapabilities.loadSession=true`, prompt capabilities `image/audio/embeddedContext`, and MCP `http/sse`. It does not advertise `sessionCapabilities.resume` in the observed initialize response code.
- Gemini creates an ACP filesystem proxy only when client `fs` capability is present, but falls back when `readTextFile/writeTextFile` are absent. MAIster should still make client capabilities adapter-specific and explicit.
- A raw manual NDJSON `initialize` smoke using `protocolVersion: 1` returned no stdout within 5 seconds. This must be re-run through the real ACP SDK client before implementation claims Gemini launch support.
- OpenCode is installed and linked through Homebrew core at `/opt/homebrew/bin/opencode`, version `1.16.2`; `brew list --versions opencode` reports `opencode 1.16.2`. In the sandbox, `opencode --version` fails while creating `/Users/developer/.local/share/opencode`; outside the sandbox it succeeds. `opencode acp --help` exposes `--print-logs`, `--log-level`, `--pure`, `--port`, `--hostname`, `--mdns`, `--cors`, and `--cwd`. Upstream docs still describe `opencode acp` as JSON-RPC over stdio, so an SDK-based smoke must prove the default transport before launch support is claimed.

## Current State Map

- `supervisor/src/types.ts`: `ExecutorAgentSchema` is `claude | codex`; `RunnerLaunchSchema.adapter/capabilityAgent` reuse it; provider kinds are `anthropic | anthropic_compatible | openai | openai_compatible`.
- `supervisor/src/spawn.ts`: `BINARY_BY_AGENT` maps only `claude -> claude-agent-acp`, `codex -> codex-acp`; `adapterLaunch.preArgs/postArgs/env` already exists and is the right launch hook.
- `supervisor/src/http-api.ts`: diagnostics adapter binaries are hard-coded to Claude/Codex.
- `supervisor/src/acp-client.ts`: `initialize` always sends `clientCapabilities: { fs: {} }`; checkpoint resume requires `sessionCapabilities.resume`; model application is `codex -> unstable_setSessionModel`, otherwise `settings_local`; prompt `cancelled` is converted to `ACP_PROTOCOL` while the web client type still includes `cancelled`.
- `supervisor/src/runner-provisioner.ts`: provider/policy validation is hard-coded for Claude/Codex; `openai_compatible` is still refused before spawn.
- `web/lib/acp-runners/schema.ts`: `AdapterId`, `ADAPTERS`, provider kinds, permission policies, and runtime config parsing know only Claude/Codex.
- `web/lib/acp-runners/readiness.ts`, `presets.ts`, `spawn-intent.ts`, `resolve.ts`, settings UI routes/components, and i18n all assume Claude/Codex.
- `web/lib/supervisor-client.ts`: `SupervisorExecutorInput`, `SupervisorRunnerInput`, diagnostics schemas, and model catalog draft types know only Claude/Codex even though this is the web/supervisor boundary every launch crosses.
- `web/lib/db/schema.ts`: Drizzle type-level enums use `claude | codex`, while existing SQL migrations use plain `text` for `platform_acp_runners.adapter`, `capability_agent`, and `runs.capability_agent`. The implementation still needs a DB contract audit, but likely not a Postgres enum migration.
- `web/lib/flows/enforcement.ts`: `AgentName` and `ENFORCEABILITY_BY_AGENT` include only Claude/Codex and all cells are `instructed`.
- `web/lib/config.schema.ts`: node settings tool maps and capability agent schemas are Claude/Codex-shaped.
- `web/app/api/admin/acp-runners/model-suggestions/route.ts`, `web/components/settings/use-model-suggestions.ts`, and `supervisor/src/model-catalog/*`: model suggestion/probe sources are adapter/provider-aware today, but only for current provider kinds.
- `docs/system-analytics/acp-runners.md`, `docs/configuration.md`, `docs/supervisor.md`, and OpenAPI/AsyncAPI describe Claude/Codex as the implemented adapters.

## Acceptance Criteria

- The SDD contract is frozen before production code: expectations, adapter contracts, DB/API deltas, resume semantics, capability matrix, diagnostics, error taxonomy, and rollout notes are documented.
- Admin users can create, edit, view, and diagnose `gemini` and `opencode` ACP runners in `/settings`, with provider-specific fields and truthful readiness reasons.
- Supervisor diagnostics reports `gemini` and `opencode` binary availability, versions where cheap, env-ref presence, and protocol capability findings without leaking secrets.
- `opencode` launches through `opencode acp` when the binary is available and readiness is satisfied.
- `gemini` launches through `gemini --acp` only after an SDK-based initialize/newSession smoke passes. If Gemini `loadSession` cannot satisfy MAIster checkpoint semantics, Gemini runners stay NotReady for checkpointed workflows with an explicit reason.
- Adapter binary resolution is operator-controllable without code changes: diagnostics distinguishes default PATH lookup, supervisor-side binary override, missing binary, and non-executable binary.
- Model application is adapter-capability based: Claude remains `settings_local`; Codex, Gemini, and OpenCode use `unstable_setSessionModel` only when the adapter supports it.
- Model suggestion behavior is explicit for Gemini/OpenCode: it either returns observed/curated models with source metadata or a typed skipped reason; it never silently shows Codex/Claude defaults for a different adapter.
- ACP client capabilities are adapter-specific. MAIster does not advertise file read/write support until it implements and confines those ACP client methods.
- Capability settings support `gemini` and `opencode` keys, but all new adapter classes start as `instructed` or `unsupported`; `strict` unsupported classes refuse launch with `CONFIG` or `EXECUTOR_UNAVAILABLE`.
- Prompt stop-reason semantics stay consistent across supervisor, web client types, OpenAPI, and runner handling. `cancelled` is either a typed success response everywhere or a typed `ACP_PROTOCOL`/checkpoint path everywhere, with regression coverage.
- Missing binaries, missing explicitly configured env refs, protocol mismatches, and unsupported resume strategies surface as typed MAIster/Supervisor errors, never raw 500s or string-matched UI branches.
- Existing Claude/Codex behavior and tests remain green.

## Contract Surface Map

| Surface | Spec / code contract to update |
| --- | --- |
| Adapter family contract (`claude`, `codex`, `gemini`, `opencode`) | `docs/decisions.md` new ADR; `docs/system-analytics/acp-runners.md`; `docs/supervisor.md` |
| Runner config/provider/auth schema | `docs/configuration.md`; `web/lib/acp-runners/schema.ts`; `supervisor/src/types.ts` |
| Supervisor diagnostics and launch API | `docs/api/supervisor.openapi.yaml`; `web/lib/supervisor-client.ts`; `supervisor/src/http-api.ts` |
| Web runner CRUD and readiness | `docs/api/web.openapi.yaml`; `docs/system-analytics/acp-runners.md`; settings UI/i18n |
| Checkpoint/resume semantics | `docs/system-analytics/runs.md`; `docs/system-analytics/hitl.md`; `docs/error-taxonomy.md`; `supervisor/src/acp-client.ts` |
| Model application and suggestions | `docs/system-analytics/model-catalog.md`; `web/app/api/admin/acp-runners/model-suggestions/route.ts`; `supervisor/src/model-catalog/*`; `docs/api/async/supervisor-sse.asyncapi.yaml` if advisory shape changes |
| Prompt stop-reason policy | `docs/supervisor.md`; `docs/api/supervisor.openapi.yaml`; `supervisor/src/types.ts`; `web/lib/supervisor-client.ts`; runner/resume tests |
| Capability settings and enforcement table | `docs/system-analytics/flow-settings.md`; `docs/system-analytics/capability-catalog.md`; `web/lib/flows/enforcement.ts`; `web/lib/config.schema.ts` |
| DB shape / no-op migration proof | `docs/database-schema.md`; `docs/db/projects-domain.md`; `web/lib/db/schema.ts`; migrations audit |
| Local spike evidence | `docs/spikes/2026-06-11-acp-opencode-gemini-adapters.md` |

## Commit Plan

- **Commit 1** (Phase 0): `docs(acp): specify opencode and gemini adapter contracts`
- **Commit 2** (Phase 1): `feat(acp): centralize adapter families and schema support`
- **Commit 3** (Phase 2): `feat(supervisor): launch and diagnose gemini/opencode adapters`
- **Commit 4** (Phase 3): `feat(settings): configure gemini/opencode runners`
- **Commit 5** (Phase 4): `feat(capabilities): extend agent-aware settings to gemini/opencode`
- **Commit 6** (Phase 5): `test(acp): adapter smoke coverage and compatibility gates`
- **Commit 7** (Phase 6): `docs(acp): finalize adapter support docs and rollout notes`

## Tasks

### Phase 0: SDD Spec Freeze (NO production code)

- [x] **T0.1 - Write the compatibility spike note.** Create `docs/spikes/2026-06-11-acp-opencode-gemini-adapters.md` with local CLI findings, installed Gemini ACP capability evidence, raw smoke limitation, opencode binary availability plus writable-state caveat, and external protocol expectations from ACP/OpenCode/Gemini docs. Include a compatibility matrix: launch command, protocol version, auth, MCP, FS, model switching, permission requests, resume/load support. Files: `docs/spikes/2026-06-11-acp-opencode-gemini-adapters.md`. Logging requirements: n/a for docs, but specify which future runtime events must log adapter id, binary path, protocol capability, and error code.

- [x] **T0.2 - Add the adapter-family ADR.** Add an ADR to `docs/decisions.md` extending ADR-050: per-adapter registry owns validation, readiness, provisioning, spawn args, ACP client capabilities, auth, model channel, resume strategy, and cleanup. Lock decisions: `opencode` uses `opencode acp`; `gemini` uses `gemini --acp`; Gemini `loadSession` is not equivalent to MAIster `session/resume` until proven; no adapter gets strict enforcement flips in this feature. Files: `docs/decisions.md`. Logging requirements: ADR must require structured logs for adapter registry resolution, binary checks, ACP initialize caps, auth path, and resume strategy.

- [x] **T0.3 - Freeze domain expectations.** Update `docs/system-analytics/acp-runners.md`, `docs/system-analytics/executors.md`, `docs/system-analytics/model-catalog.md`, `docs/system-analytics/flow-settings.md`, and `docs/system-analytics/capability-catalog.md`. Add expectations, state machines, refusal tables, and "Ready vs NotReady" reasons for Gemini/OpenCode. Files: listed docs. Logging requirements: docs must name DEBUG/INFO/WARN events for readiness computation, supervisor diagnostics, model apply advisory, and capability refusal.

- [x] **T0.4 - Freeze API and DB contracts.** Update `docs/api/supervisor.openapi.yaml`, `docs/api/web.openapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml` only if event payloads change, `docs/database-schema.md`, and `docs/db/projects-domain.md`. State explicitly whether SQL DDL is required after migration audit. Files: listed specs. Logging requirements: route specs must describe no-secret logging and response error codes for unsupported adapter, missing env, missing binary, and unsupported checkpoint resume.

- [x] **T0.5 - Write acceptance spec.** Create `.ai-factory/specs/acp-opencode-gemini-adapters.spec.md` with expectations, contracts, acceptance criteria, test matrix, and rollout policy. Include a dedicated section for the user's local update: Gemini installed; OpenCode was initially absent from PATH, then installed via Homebrew at `/opt/homebrew/bin/opencode` with sandbox writable-state caveats. Files: `.ai-factory/specs/acp-opencode-gemini-adapters.spec.md`. Logging requirements: spec must require all new logs to include `adapter`, `runnerId`, `sessionId` where available, and never include raw env values.

- [x] **T0.6 - Freeze binary override and stop-reason policy.** In the spec/API docs, define how operators override adapter binaries on the supervisor host, recommended env names or config keys, diagnostics fields (`source`, `path`, `available`, `version`, `error`), and the exact `cancelled` prompt policy. This must explicitly cover OpenCode installed but not linked in PATH, and OpenCode installed but unable to initialize its first-run writable state directory. Files: `.ai-factory/specs/acp-opencode-gemini-adapters.spec.md`, `docs/supervisor.md`, `docs/api/supervisor.openapi.yaml`. Logging requirements: diagnostics logs include adapter, binary source, executable path if non-secret, exit code, and stderr tail only.

### Phase 1: Adapter Registry, Types, and Schema Support

- [x] **T1.1 - Add shared adapter support definitions in web.** Extend or introduce `web/lib/acp-runners/adapter-support.ts` so `AdapterId = "claude" | "codex" | "gemini" | "opencode"` and adapter metadata includes provider kinds, permission policies, binary id, launch command hint, model channel, resume strategy, MCP transports, and FS policy. Refactor `web/lib/acp-runners/schema.ts` to consume this registry instead of local literals. TDD: unit tests for supported provider/policy combinations and unsupported mismatch errors. Files: `web/lib/acp-runners/schema.ts`, new helper, tests. Logging requirements: DEBUG log adapter support lookups only at validation/readiness call sites, not from pure helpers.

- [x] **T1.2 - Extend provider/auth schemas conservatively.** Add provider configs for Gemini and OpenCode without forcing them into Anthropic/OpenAI shapes. Proposed kinds: `google_gemini`, `google_vertex`, `google_gateway`, and `agent_native` for OpenCode-managed providers. Secret fields remain `env:NAME` refs only. TDD: config parser rejects raw secrets, invalid URLs, and provider/adapter mismatch; accepts minimal Gemini API-key and OpenCode native configs. Files: `web/lib/acp-runners/schema.ts`, `web/lib/acp-runners/runner-form.ts`, `supervisor/src/types.ts`, tests. Logging requirements: INFO/WARN at route boundaries must log provider kind and env ref names only.

- [x] **T1.3 - Extend DB-facing TypeScript contracts and migration audit.** Update Drizzle type-level enums and JSON types for `platform_acp_runners.adapter`, `capability_agent`, `runs.capability_agent`, runner snapshots, `platform_mcp_servers.supported_agents`, capability agent arrays, and test fixtures. Audit SQL migrations for real constraints; add a no-op docs note if no DDL is needed, or create a migration if any CHECK/enum constraint exists. TDD: schema/type tests and fixture builders compile with all four adapters. Files: `web/lib/db/schema.ts`, `web/lib/__tests__/runner-fixtures.ts`, migration if needed, docs. Logging requirements: migration/audit task has no runtime logging; if migration runs, migration script must not log row payloads.

- [x] **T1.4 - Extend config schema and capability settings agent maps.** Update `web/lib/config.schema.ts` so `capabilityAgentSchema`, node `tools` maps, capability `agents[]`, and config validation accept `gemini` and `opencode`. TDD: manifests with `tools.gemini`, `tools.opencode`, and capability records supporting the new agents validate; unknown agent still rejects. Files: `web/lib/config.schema.ts`, `web/lib/config.ts`, config tests. Logging requirements: DEBUG validation failures should include node id, agent key, and capability ref id, not full settings payloads.

- [x] **T1.5 - Align web/supervisor boundary types.** Update `web/lib/supervisor-client.ts`, `supervisor/src/types.ts`, OpenAPI schemas, and shared test fixtures so `ExecutorAgent`, `RunnerLaunch`, diagnostics, model catalog drafts, and `SendPromptResponse` use one adapter/stop-reason policy. TDD: schema tests fail before the union expands; cancelled-prompt tests prove the chosen policy is consistent from supervisor route to web runner handling. Files: listed boundary types, `docs/api/supervisor.openapi.yaml`, `docs/api/web.openapi.yaml`, tests. Logging requirements: no new runtime logs beyond typed error/log fields already frozen in T0.6.

### Phase 2: Supervisor Launch, Diagnostics, ACP Compatibility

- [x] **T2.1 - Add supervisor adapter registry.** Replace `BINARY_BY_AGENT` and `ADAPTER_BINARIES` literals with a supervisor-local adapter registry: `claude-agent-acp`, `codex-acp`, `gemini`, `opencode`, default args, binary override env/config hook, client capabilities, model channel, auth hook, and resume strategy. TDD: spawn arg tests assert `gemini --acp` and `opencode acp`; override tests prove an explicit path is used only for the selected adapter; Claude/Codex stay unchanged. Files: `supervisor/src/adapter-registry.ts`, `supervisor/src/spawn.ts`, `supervisor/src/http-api.ts`, tests. Logging requirements: INFO on spawn must include adapter id, binary, binary source, args redacted, cwd, runnerId; errors include `ENOENT/EACCES` context.

- [x] **T2.2 - Make diagnostics adapter-aware.** Extend `/diagnostics` to report all four adapters, binary availability, binary source (`path` or override), optional version probe, env-ref presence, and protocol capability smoke status when cached. Opencode absence in the current environment should produce `available:false`, not an exception. TDD: diagnostics unit/integration tests for present Gemini, absent Opencode, override path, non-executable path, and version probe failure. Files: `supervisor/src/http-api.ts`, diagnostics types, `web/lib/supervisor-client.ts`, tests. Logging requirements: DEBUG version probe start/end; WARN on probe failure with command, exit code, stderr tail, no env.

- [x] **T2.3 - Implement adapter-specific ACP initialize capabilities.** Change `createAcpConnection` to derive `clientCapabilities` from adapter support. For Gemini, send explicit `fs: { readTextFile:false, writeTextFile:false }` until MAIster implements confined ACP FS methods. Keep MCP server passing via ACP `newSession/loadSession/resumeSession`. TDD: mock ACP adapters assert initialize payload per adapter. Files: `supervisor/src/acp-client.ts`, tests, fake adapters. Logging requirements: INFO after initialize logs protocol version and advertised capabilities; DEBUG logs client capability policy.

- [x] **T2.4 - Implement auth provisioning hooks.** Extend `provisionRunnerLaunch` for Gemini provider kinds and OpenCode native provider. Gemini must support env-ref API-key/gateway configuration and, if needed, an ACP `authenticate` call before `newSession`; OpenCode native config should rely on the user's OpenCode provider config unless explicit env refs are supplied. TDD: missing env refs throw `EXECUTOR_UNAVAILABLE`; raw secret input is impossible at schema boundary; ACP authenticate is called only for adapter/provider combinations that require it. Files: `supervisor/src/runner-provisioner.ts`, `supervisor/src/acp-client.ts`, tests. Logging requirements: INFO auth path selected with env ref names only; WARN auth failure with adapter, provider kind, status/error code.

- [x] **T2.5 - Implement resume strategy gate.** Replace the current hard `sessionCapabilities.resume` requirement with adapter strategy: `resumeSession` for Claude/Codex/OpenCode when advertised; `loadSession` for Gemini only after SDK-based spike proves it preserves MAIster's checkpoint semantics; otherwise throw `CHECKPOINT` with an actionable reason. TDD: mock adapters cover resume success, load fallback, missing support, and no accidental `newSession` fallback. Files: `supervisor/src/acp-client.ts`, tests. Logging requirements: INFO resume strategy chosen; WARN unsupported strategy with `resumeSessionId`, adapter, advertised caps, and error code.

- [x] **T2.6 - Generalize model application.** Replace `runner.adapter === "codex"` special-case with adapter metadata: `settings_local` for Claude, `set_session_model` for Codex/Gemini/OpenCode when supported, `none/advisory` otherwise. TDD: `apply-model` tests for Gemini/OpenCode setSessionModel, unsupported method advisory, and unchanged Claude/Codex behavior. Files: `supervisor/src/acp-client.ts`, `supervisor/src/__tests__/apply-model.test.ts`. Logging requirements: INFO on successful model apply, WARN on adapter method failure, advisory event without failing the run.

- [x] **T2.7 - Classify initialize/auth/protocol failures.** Add adapter-aware error mapping around ACP `initialize`, optional `authenticate`, `newSession/loadSession/resumeSession`, and `prompt` so protocol mismatch, auth-required, unsupported method, and cancelled prompt paths become typed `ACP_PROTOCOL`, `EXECUTOR_UNAVAILABLE`, or `CHECKPOINT` errors. TDD: fake adapters throw each failure shape; route responses never degrade to raw 500. Files: `supervisor/src/acp-client.ts`, `supervisor/src/http-api.ts`, `supervisor/src/types.ts`, tests. Logging requirements: WARN with adapter, method, protocol version, code/status, and redacted message.

### Phase 3: Web Runner Catalog, Readiness, and Settings UI

- [x] **T3.1 - Extend readiness evaluation.** Update `evaluateRunnerReadiness` to support Gemini/OpenCode provider requirements, binary diagnostics, version/protocol smoke, optional explicit env refs, sidecar incompatibilities, and resume-support readiness. TDD: Ready/NotReady matrix for Gemini smoke missing, Gemini no resume support, OpenCode binary missing, OpenCode native ready, provider mismatch. Files: `web/lib/acp-runners/readiness.ts`, tests. Logging requirements: DEBUG readiness input summary and reasons; no raw provider secrets.

- [x] **T3.2 - Extend runner presets.** Add disabled or NotReady-by-default presets for `gemini-cli` and `opencode-native` with clear readiness reasons. Do not make either the default runner. TDD: preset tests assert all ids safe, adapter/provider compatible, default remains unchanged. Files: `web/lib/acp-runners/presets.ts`, tests. Logging requirements: n/a for static presets.

- [x] **T3.3 - Update admin runner form and API routes.** Extend `/settings` runner modal fields for Gemini/OpenCode providers, model input, env refs, and permission policies. Server routes must reject unsupported combinations with `MaisterError("CONFIG")`. TDD: route tests for create/edit; render tests for provider fields; i18n parity test for EN/RU keys. Files: `web/components/settings/acp-runner-modal.tsx`, `web/lib/acp-runners/runner-form.ts`, `web/app/api/admin/acp-runners/*`, `web/messages/en.json`, `web/messages/ru.json`, tests. Logging requirements: route INFO on create/update with runnerId, adapter, provider kind, readiness status; no env values.

- [x] **T3.4 - Update web-to-supervisor spawn intent.** Extend `runnerExecutorInput`, `runnerSupervisorInput`, `mergeRunnerAdapterLaunch`, recovery launch reconstruction, scratch-run launch, and run snapshots for new adapters/provider kinds. TDD: recover-launch tests for Gemini/OpenCode snapshots after catalog mutation; scratch-run tests if scratch path has separate types. Files: `web/lib/acp-runners/spawn-intent.ts`, `web/lib/runs/recover.ts`, scratch-run launch code, tests. Logging requirements: DEBUG spawn-intent construction with runnerId, adapter, provider kind, and sidecar id.

- [x] **T3.5 - Extend model suggestions and catalog drafts.** Update settings model suggestions, `SupervisorModelCatalogDraft`, model-catalog sources, and UI hooks so Gemini/OpenCode runners can request model suggestions without pretending to be Claude/Codex. Gemini may use ACP probe or provider API if proven; OpenCode native may start with a typed skipped/curated source. TDD: model-suggestion route tests for Gemini success/skip, OpenCode missing binary skip, provider mismatch rejection, and unchanged Claude/Codex suggestions. Files: `web/app/api/admin/acp-runners/model-suggestions/route.ts`, `web/components/settings/use-model-suggestions.ts`, `web/lib/supervisor-client.ts`, `supervisor/src/model-catalog/*`, tests. Logging requirements: INFO source status with adapter/provider kind/count; WARN skipped live probe reason without env values.

### Phase 4: Capability Materialization and Enforcement Matrix

- [x] **T4.1 - Extend enforcement table to all adapters.** Add `gemini` and `opencode` to `ENFORCEABILITY_BY_AGENT`, with all capability classes starting `instructed` or `unsupported` based on Phase 0 spec. Do not flip to `enforced`. TDD: `strict` classes refuse for Gemini/OpenCode with the correct `CONFIG` or `EXECUTOR_UNAVAILABLE`; `instruct` launches. Files: `web/lib/flows/enforcement.ts`, tests. Logging requirements: runtime refusal logs node id, adapter, class, declared mode, capability, and error code.

- [x] **T4.2 - Extend agent-aware materialization outputs.** Update capability resolver/materializer and `runner-graph` paths so Gemini/OpenCode receive MCP servers through ACP `mcpServers` when supported, model selection through supervisor setSessionModel, and instruction-only capability profile files where enforcement is not proven. TDD: materialization tests for Gemini/OpenCode produce no Claude settings files, no secret leakage, and correct MCP input shape. Files: `web/lib/capabilities/*`, `web/lib/flows/graph/runner-graph.ts`, tests. Logging requirements: INFO materialization summary with profile digest, adapter, mcp count, instructed class count.

- [x] **T4.3 - Extend MCP supported-agent handling.** Update `platform_mcp_servers.supportedAgents`, `.mcp.json` capability loading, forms, docs, and tests to accept Gemini/OpenCode while preserving explicit agent compatibility. Existing rows must not be silently rewritten unless the spec freezes that migration. TDD: MCP CRUD/schema tests for all four agents; unsupported agent resolution refuses required MCPs. Files: `web/lib/db/schema.ts`, `web/lib/capabilities/catalog.ts`, `web/lib/acp-runners/*`, MCP UI/tests. Logging requirements: DEBUG MCP resolution with supported agents and selected adapter; no header/env values.

### Phase 5: TDD Compatibility and Live Smoke Gates

- [x] **T5.1 - Add mock ACP adapters for new capabilities.** Create or extend test fixtures that emulate OpenCode resume support and Gemini loadSession-only support. Use them in supervisor integration tests for initialize/newSession/prompt/permission/model/resume/load. Files: `supervisor/test/fixtures/*`, `supervisor/src/__tests__/*`. Logging requirements: tests assert logs contain adapter id and strategy, not secrets.

- [x] **T5.2 - Add SDK-based local smoke script.** Add an opt-in script or test helper that uses the real `@agentclientprotocol/sdk` client against local `gemini --acp` and `opencode acp`, not hand-written JSON. It must skip with a clear reason when binary/auth is missing. Files: `supervisor/scripts/smoke-acp-adapter.ts` or test helper, package script only if project convention allows. Logging requirements: INFO command, version, initialize caps, session id; WARN skip reason; never prompt for auth in CI.

- [x] **T5.3 - Run and record Gemini smoke gate state.** With installed `gemini 0.46.0`, run the SDK smoke non-interactively through the Gemini CLI's own configured auth. The script writes the diagnostics cache used by readiness and does not require MAIster-owned `GEMINI_API_KEY`/`GOOGLE_API_KEY` for the CLI-native path. Files: spike doc, readiness tests/code. Logging requirements: smoke captures stdout/stderr tails and protocol caps; redact env.

- [x] **T5.4 - Run and record OpenCode smoke when binary path is available.** If `opencode` remains unavailable in the supervisor environment, keep tests skipped and preserve NotReady diagnostics. If available, record the SDK-proven `initialize` + `newSession` baseline and keep broader permission, resume, active model, and MCP workflow readiness gated unless the smoke cache explicitly records those checks as passed. Files: spike doc, diagnostics/readiness code. Logging requirements: same as Gemini.

- [x] **T5.5 - Add end-to-end launch coverage.** Add focused integration/E2E coverage that creates Gemini/OpenCode runner rows, shows readiness reasons in `/settings`, refuses NotReady runners as defaults, and launches only against mock supervisor/adapters in default CI. Files: web route tests, Playwright spec if existing runner settings e2e harness supports it. Logging requirements: assert user-facing errors map from typed error codes.

### Phase 6: Final Docs, Validation, and Rollout

- [x] **T6.1 - Complete docs as-built.** Update `docs/supervisor.md`, `docs/configuration.md`, `docs/getting-started.md`, `docs/system-analytics/acp-runners.md`, `docs/system-analytics/model-catalog.md`, `docs/system-analytics/flow-settings.md`, `docs/error-taxonomy.md`, and API specs to match implemented behavior. Files: listed docs. Logging requirements: docs must include operator-visible diagnostics and exact readiness reasons.

- [x] **T6.2 - Update README and examples only where useful.** Add minimal examples for adding Gemini/OpenCode ACP runners, with `env:NAME` refs and warnings about local binary availability. Avoid marketing language and do not imply full strict enforcement. Files: `README.md`, `docs/configuration.md`, sample snippets. Logging requirements: n/a.

- [x] **T6.3 - Full verification gate.** Run relevant commands: `pnpm --filter @maister/supervisor test:unit`, `pnpm --filter @maister/supervisor test:integration`, `pnpm --filter @maister/supervisor typecheck`, `pnpm --filter maister-web test:unit`, `pnpm --filter maister-web test:integration`, `pnpm --filter maister-web typecheck`, scoped eslint on changed files, `pnpm validate:docs:all`, Redocly/OpenAPI validation if configured. Files: none. Logging requirements: collect failures with command, adapter, and changed surface; do not mark complete with skipped live smoke unless the skip is documented in the spike.

## Risks and Blockers

- Gemini `loadSession` may replay history or differ from MAIster's checkpoint-resume invariant. If SDK smoke cannot prove compatibility, Gemini must remain NotReady for checkpointed workflows.
- OpenCode is visible at `/opt/homebrew/bin/opencode` in this development environment, but a sandboxed version probe failed on first-run state directory creation. The first implementation pass must preserve NotReady diagnostics until the supervisor environment can execute the binary, initialize required state directories, and pass SDK-based ACP smoke.
- ACP SDK version skew is real: MAIster uses `@agentclientprotocol/sdk@0.22.1`; installed Gemini bundle embeds an SDK with protocol version `1`; OpenCode may use a different SDK version. Compatibility tests own this risk.
- Provider/auth UX can become messy quickly. Keep V1 conservative: env refs and existing native agent config first; full interactive ACP authenticate UI only if required by the spike.
- Do not expand this into generic tool sandboxing or ACP FS proxy. File read/write proxy support requires a separate confinement design.

## Implementation Notes

- Implementation branch is `feature/acp-opencode-gemini-adapters`; this plan filename already matches the AIF branch slug and should remain unchanged for `/aif-implement` discovery.
- The branch was created from local `main` after the initial plan was written from an older detached HEAD.
- User preference applied: reasonable defaults, tests yes, verbose logging, docs mandatory, roadmap linkage to the existing M14/ACP runner surfaces.
- SDK smoke results are recorded in the spike doc. Gemini passed `initialize` and `newSession` over `/opt/homebrew/bin/gemini --acp` using CLI-native auth. OpenCode passed `initialize` and `newSession` over `/opt/homebrew/bin/opencode`. Broader prompt/permissions/resume-or-load/MCP/model guarantees remain intentionally unclaimed in V1 readiness and docs.
