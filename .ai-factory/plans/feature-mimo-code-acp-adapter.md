# Implementation Plan: MiMo Code ACP Adapter Runner

Branch: codex/mimo-code-acp-adapter
Created: 2026-06-11

## Settings
- Testing: yes (focused integration/smoke tests over unit-only coverage; no broad mock suite unless it proves an adapter boundary)
- Logging: verbose (structured DEBUG/INFO/WARN around adapter resolution, diagnostics, smoke, spawn, readiness, and model/resume decisions; never log secret values)
- Docs: yes (mandatory docs/spec checkpoint before implementation)
- Mode: full implementation on branch `codex/mimo-code-acp-adapter`

## Roadmap Linkage
Milestone: "M14. Scoped capability materialization" plus the implemented platform ACP runner catalog.
Rationale: MiMo Code adds a new ACP adapter family and capability agent, touching the same runner catalog, adapter provisioning, readiness, smoke, MCP/capability, and documentation surfaces as Gemini/OpenCode.

## Current State

- MAIster already supports four explicit adapter ids: `claude`, `codex`, `gemini`, and `opencode`.
- The current multiprovider model is not project-local `executors[]`; it is the platform ACP runner catalog:
  - Web registry: `web/lib/acp-runners/adapter-support.ts`
  - Supervisor registry: `supervisor/src/adapter-registry.ts`
  - Launch provisioning: `supervisor/src/runner-provisioner.ts`
  - Runner CRUD/readiness: `web/app/api/admin/acp-runners/**`, `web/lib/acp-runners/**`
  - Spawn bridge: `web/lib/acp-runners/spawn-intent.ts`, `web/lib/supervisor-client.ts`, `supervisor/src/types.ts`
  - Model discovery/application: `supervisor/src/model-catalog/**`, `web/app/api/admin/acp-runners/model-suggestions/route.ts`
  - Capability/MCP fanout: `web/lib/config.schema.ts`, `web/lib/capabilities/**`, `web/lib/mcp/**`, `platform_mcp_servers.supported_agents`
- Provider kinds already cover MiMo V1 without a new provider union: use `agent_native` for MiMo-managed/native provider config, same broad class as OpenCode.
- `platform_mcp_servers.supported_agents` has a real SQL JSONB default from migration `0044_mcp_supported_agents_all_adapters.sql`; adding `mimo` needs an intentional migration, not just TypeScript edits.

## MiMo Prerequisites

- Official MiMo Code docs list an ACP CLI entry: `mimo acp` with `--cwd`, `--port`, and `--hostname`.
- Public MiMo Code source shows:
  - npm package name `@mimo-ai/cli`, binary `mimo`;
  - `packages/opencode/src/cli/cmd/acp.ts` defines `command: "acp"` and uses `AgentSideConnection` + `ndJsonStream`;
  - dependency `@agentclientprotocol/sdk@0.16.1`, which is older than MAIster supervisor's `@agentclientprotocol/sdk@0.22.1`;
  - ACP implementation advertises `loadSession`, `sessionCapabilities.resume`, MCP HTTP/SSE capabilities, and prompt image/embedded-context capabilities;
  - internal auth messaging still says `opencode auth login`, so the live smoke must verify MiMo-branded login/auth UX before any Ready claim.
- Local host prerequisite is not met yet: `mimo` is not currently on PATH in this worktree environment.
- Therefore V1 must add MiMo as `NotReady` by default, gated by binary availability and SDK smoke cache evidence.

## Decisions

1. Add a distinct adapter/capability agent id: `mimo`. Do not alias it to `opencode`.
2. Use provider kind `agent_native` for V1. No new provider kind, no raw secrets, and no MiMo-hosted token field until a spike proves a stable non-interactive auth contract.
3. Supervisor launch contract: default binary `mimo`, default args `["acp"]`, override env `MAISTER_ADAPTER_BINARY_MIMO`.
4. Initial metadata: model channel `advisory`, resume strategy `session_resume_pending_smoke`, MCP transports `stdio | sse | http`, FS policy `none`, permission policy `default`.
5. Readiness requires `adapter.smoke.status === "ok"` for `mimo`. Missing binary, first-run writable-state failure, protocol mismatch, auth-required, and missing smoke must be separate operator-visible reasons.
6. Model discovery may use ACP probe only after smoke proves MiMo is non-interactive in the supervisor environment. Until then, return a typed skipped source instead of borrowing OpenCode/Claude/Codex suggestions.
7. Existing MCP rows with `supported_agents` exactly equal to the old all-adapters list should migrate to include `mimo`; custom subsets must remain unchanged.

## Contract Surface Map

| Surface | Contract files |
| --- | --- |
| Adapter id / provider compatibility | `web/lib/acp-runners/adapter-support.ts`, `supervisor/src/adapter-registry.ts`, `docs/system-analytics/acp-runners.md`, `docs/decisions.md` |
| Supervisor launch/diagnostics/smoke | `supervisor/src/types.ts`, `supervisor/src/http-api.ts`, `supervisor/scripts/smoke-acp-adapter.ts`, `docs/api/supervisor.openapi.yaml`, `docs/supervisor.md` |
| Web runner CRUD/readiness | `web/app/api/admin/acp-runners/**`, `web/lib/acp-runners/**`, `docs/api/web.openapi.yaml` |
| Model catalog | `supervisor/src/model-catalog/**`, `web/app/api/admin/acp-runners/model-suggestions/route.ts`, `docs/system-analytics/model-catalog.md` |
| Capability and MCP support | `web/lib/config.schema.ts`, `web/lib/capabilities/**`, `web/lib/mcp/**`, `docs/system-analytics/capability-catalog.md`, `docs/system-analytics/flow-settings.md` |
| DB default / schema docs | `web/lib/db/schema.ts`, new Drizzle migration, `docs/database-schema.md`, `docs/db/projects-domain.md` |
| Deployment / host runtime | `.env.example`, `docs/configuration.md`, `docs/getting-started.md`, `compose.yml`, `compose.production.yml` no-op audit |

## Trust Boundary Notes

- `POST /api/admin/acp-runners`
  - `auth-context`: current session/global role.
  - `body-controlled`: `id`, `adapter`, `model`, `provider`, `permissionPolicy`, `sidecarId`, `enabled`.
  - Required handling: adapter/provider/policy validated against static support; secrets accepted only as `env:NAME`; readiness computed server-side; caller-provided readiness ignored.
- `PATCH /api/admin/acp-runners/{runnerId}`
  - `url-param`: `runnerId`.
  - `auth-context`: current session/global role.
  - `server-state`: existing runner row and usage refs.
  - `body-controlled`: mutable fields only; `adapter` and `capabilityAgent` remain immutable.
- `POST /api/admin/acp-runners/model-suggestions`
  - `auth-context`: current session/global role.
  - `body-controlled`: runner draft.
  - Required handling: draft converts env refs to env names only; supervisor resolves values; source failures stay typed source statuses, not raw 500s.
- No new external HTTP routes are planned.

## Commit Plan

- **Commit 1** (Phase 0): `docs(acp): specify mimo adapter contract`
- **Commit 2** (Phase 1): `feat(acp): add mimo adapter id and catalog fanout`
- **Commit 3** (Phase 2): `feat(supervisor): diagnose and smoke mimo acp adapter`
- **Commit 4** (Phase 3): `feat(settings): configure mimo acp runners`
- **Commit 5** (Phase 4): `feat(capabilities): include mimo in capability mappings`
- **Commit 6** (Phase 5): `test(acp): add mimo compatibility gates`
- **Commit 7** (Phase 6): `docs(acp): document mimo runner rollout`

## Tasks

### Phase 0: Spec and Prerequisite Freeze

- [x] **T0.1 - Write MiMo compatibility spike.** Create `docs/spikes/2026-06-11-acp-mimo-code-adapter.md` capturing official docs/source evidence, local prerequisite state (`mimo` absent from PATH), SDK version skew (`0.16.1` vs supervisor `0.22.1`), launch command, auth caveats, model/resume/MCP claims, and required smoke matrix. Files: `docs/spikes/2026-06-11-acp-mimo-code-adapter.md`. Logging requirements: spike must define future log fields for `adapter=mimo`, binary source/path, smoke status, protocol version, auth status, and redacted stderr tail.

- [x] **T0.2 - Add MiMo adapter decision record.** Add an ADR extending ADR-050/ADR-084: `mimo` is a distinct ACP adapter family, launched via `mimo acp`, provider kind `agent_native`, NotReady until smoke, no OpenCode aliasing, no strict enforcement flips. Files: `docs/decisions.md`. Logging requirements: ADR must require structured logs for adapter registry resolution, binary diagnostics, readiness evaluation, and smoke failures.

- [x] **T0.3 - Update domain specs before code.** Update `docs/system-analytics/acp-runners.md`, `docs/system-analytics/model-catalog.md`, `docs/system-analytics/flow-settings.md`, and `docs/system-analytics/capability-catalog.md` with MiMo expectations, readiness/refusal reasons, model-catalog skip/probe policy, and capability enforceability stance. Files: listed docs. Logging requirements: docs must name INFO/WARN events and state that secret values and auth tokens are never logged.

- [x] **T0.4 - Freeze API/DB/deployment contract deltas.** Update `docs/api/supervisor.openapi.yaml`, `docs/api/web.openapi.yaml`, `docs/database-schema.md`, `docs/db/projects-domain.md`, `.env.example`, `docs/configuration.md`, and `docs/getting-started.md`. Include an explicit compose audit: `compose.yml` and `compose.production.yml` remain Postgres-only because `web`/`supervisor` are host-run; no service env block exists to wire. Files: listed docs/configs. Logging requirements: API docs must state typed errors for unsupported adapter, missing binary, missing smoke, and malformed env refs.

### Phase 1: Adapter Id, Types, and DB Fanout

- [x] **T1.1 - Add `mimo` to shared web adapter support.** Extend `ADAPTER_IDS`, `AdapterSupport`, provider/policy support, launch hint, model channel, resume strategy, MCP transports, and FS policy. Add/extend tests in `web/lib/acp-runners/__tests__/schema.test.ts`, `runner-form.test.ts`, and `presets.test.ts`. Files: `web/lib/acp-runners/adapter-support.ts`, `web/lib/acp-runners/schema.ts`, `web/lib/acp-runners/runner-form.ts`, tests. Logging requirements: route call sites log adapter/provider/policy validation results at DEBUG/INFO; pure helpers stay log-free.

- [x] **T1.2 - Add `mimo` to supervisor schemas and runtime registry.** Extend `ExecutorAgentSchema`, `AdapterSmokeCacheSchema`, smoke-required adapter set, default runtime entry, binary override env, and no-FS client capabilities. TDD: adapter-registry tests assert `mimo -> mimo acp`, `MAISTER_ADAPTER_BINARY_MIMO`, no-FS capabilities, and pending-smoke resume semantics. Files: `supervisor/src/types.ts`, `supervisor/src/adapter-registry.ts`, `supervisor/src/adapter-smoke-cache.ts`, `supervisor/src/__tests__/adapter-registry.test.ts`. Logging requirements: spawn/diagnostics logs include `adapter`, `binary`, `binarySource`, `runnerId`, and no raw env.

- [x] **T1.3 - Add DB schema and migration fanout.** Update Drizzle type-level enums and JSON types that depend on `ADAPTER_IDS`. Add a migration that changes `platform_mcp_servers.supported_agents` default to include `mimo` and backfills only rows whose value exactly equals the old all-adapters list; preserve custom subsets. Files: `web/lib/db/schema.ts`, new `web/lib/db/migrations/*_mimo_adapter.sql`, migration meta, `docs/database-schema.md`, `docs/db/projects-domain.md`. Logging requirements: migration has no runtime logs; tests/docs must not print row payloads.

- [x] **T1.4 - Add config/capability schema fanout.** Ensure `capabilityAgentSchema`, capability `agents`, node tool maps, authored catalog agent arrays, MCP forms, project MCP projection, and tests accept `mimo`. Files: `web/lib/config.schema.ts`, `web/lib/config.ts`, `web/lib/mcp/**`, `web/lib/capabilities/**`, related tests. Logging requirements: validation errors include node/capability ids and adapter key only, not full materialized configs.

### Phase 2: Supervisor Launch, Diagnostics, and Smoke

- [x] **T2.1 - Extend diagnostics for MiMo binary state.** `/diagnostics` must report `mimo` with binary source (`path | override`), resolved path, availability, version/probe result, smoke status, and readable failure reasons. Missing `mimo` on this host must be `available:false`, not an exception. Files: `supervisor/src/http-api.ts`, `web/lib/supervisor-client.ts`, supervisor diagnostics tests. Logging requirements: DEBUG probe start/end; WARN probe failure with adapter, command, exit code, stderr tail, no env values.

- [x] **T2.2 - Extend smoke script and cache for MiMo.** `pnpm -C supervisor smoke:acp` should include `mimo` by default with `gemini opencode`, and support explicit `mimo`. It must use the real ACP SDK client, isolated tmp cwd, bounded timeout, and teardown on every exit path. Files: `supervisor/scripts/smoke-acp-adapter.ts`, `supervisor/src/adapter-smoke-cache.ts`, tests. Logging requirements: INFO command/version/protocol/session id; WARN skip/error reason; redact env and auth data.

- [x] **T2.3 - Add MiMo launch provisioning.** `provisionRunnerLaunch` should accept `adapter=mimo`, `provider.kind=agent_native`, `permissionPolicy=default`, reject sidecars and unsupported policies, and preserve existing OpenCode/Gemini/Codex guards. Files: `supervisor/src/runner-provisioner.ts`, `supervisor/src/__tests__/runner-provisioner.test.ts`. Logging requirements: INFO selected provider/adapter path with runnerId; errors include adapter/provider/policy and `EXECUTOR_UNAVAILABLE`/`CONFIG` context.

- [x] **T2.4 - Add MiMo compatibility fixture coverage.** Extend ACP compatibility fixtures to emulate MiMo initialize/newSession, prompt, permission request, model advisory, and resume capability. Keep live MiMo smoke opt-in/skipped until binary is installed. Files: `supervisor/test/fixtures/*`, `supervisor/src/__tests__/adapter-compatibility.integration.test.ts`, `supervisor/src/__tests__/apply-model.test.ts`. Logging requirements: tests assert logs/events include `adapter=mimo` and do not include secret values.

### Phase 3: Runner Catalog, Readiness, and Model UX

- [x] **T3.1 - Add MiMo runner preset.** Add `mimo-code-native` preset with adapter/capabilityAgent `mimo`, provider `agent_native`, model placeholder `mimo-native` or documented native model id, `NotReady` until binary and smoke pass, enabled true, not default. Files: `web/lib/acp-runners/presets.ts`, preset tests. Logging requirements: n/a for static preset; create/update routes log runnerId, adapter, provider kind, readiness status.

- [x] **T3.2 - Extend readiness evaluation.** `evaluateRunnerReadiness` must include MiMo binary diagnostics, smoke gate, provider/policy mismatch, enabled/default refusal, and missing diagnostics paths. Files: `web/lib/acp-runners/readiness.ts`, readiness tests. Logging requirements: DEBUG readiness inputs and reason codes, no provider secrets.

- [x] **T3.3 - Extend admin runner routes/UI.** Admin create/edit/model-suggestion routes and runner form must accept `mimo`, show `agent_native` as MiMo-native in context, reject unsupported combinations, and keep adapter/capability immutable after create. Files: `web/app/api/admin/acp-runners/**`, settings components, `web/messages/en.json`, `web/messages/ru.json`, tests. Logging requirements: route INFO on create/update/delete with server-derived actor, runnerId, adapter, provider kind, readiness status; no env values.

- [x] **T3.4 - Extend spawn intent and recovery snapshots.** Ensure run launch, scratch launch, recover/resume, runner snapshots, and fallback provider derivation preserve `mimo` through web->supervisor input. Files: `web/lib/acp-runners/spawn-intent.ts`, `web/lib/runs/recover.ts`, `web/lib/runs/resume.ts`, `web/lib/scratch-runs/**`, tests. Logging requirements: DEBUG spawn intent summary with runId, runnerId, adapter, provider kind, sidecar id, no full env.

- [x] **T3.5 - Extend model suggestions.** For MiMo V1, model suggestions should return `skipped` until smoke proves probe-safe, or use ACP probe after cached smoke is `ok`; never reuse OpenCode suggestions silently. Files: `supervisor/src/model-catalog/**`, `web/app/api/admin/acp-runners/model-suggestions/route.ts`, tests. Logging requirements: INFO source statuses and counts; WARN skipped/failed source reason with adapter/provider kind.

### Phase 4: Capability, MCP, and Enforcement

- [x] **T4.1 - Add MiMo to enforcement matrix.** Add `mimo` to `ENFORCEABILITY_BY_AGENT` with all capability classes `instructed` or `unsupported`; no `enforced` flips without live proof. Files: `web/lib/flows/enforcement.ts`, enforcement tests. Logging requirements: refusal logs nodeId, adapter, class, declared mode, capability id, and error code.

- [x] **T4.2 - Extend MCP supported-agent behavior.** MiMo must appear in supported-agent forms/defaults, `.mcp.json` projections, platform MCP CRUD schemas, and required-MCP resolution. Exact-old-default rows migrate to include MiMo; custom rows stay custom. Files: `web/lib/mcp/**`, `web/app/api/admin/mcp-servers/**`, `web/app/api/projects/[slug]/mcp/**`, tests. Logging requirements: DEBUG MCP resolution with selected adapter and supported agents; never log env/header values.

- [x] **T4.3 - Extend capability materialization outputs.** MiMo materialization must avoid Claude settings files, avoid OpenCode assumptions unless source-smoke-proven, pass MCPs over ACP `mcpServers`, and write only instruction/advisory profile data. Files: `web/lib/capabilities/materialize.ts`, `web/lib/capabilities/resolver.ts`, `web/lib/flows/graph/runner-graph.ts`, tests. Logging requirements: INFO materialization summary with adapter, profile digest, mcp count, instructed/unsupported counts.

### Phase 5: Verification and Live Smoke

- [x] **T5.1 - Add focused test matrix.** Run and keep green the relevant tests: supervisor adapter registry, smoke cache, diagnostics, runner provisioner, compatibility fixture, model catalog; web adapter schema, presets, readiness, runner form/routes, MCP supported agents, config schema, enforcement, spawn/recover. Files: tests listed in prior phases. Logging requirements: test assertions cover structured logging where behavior depends on diagnostics/readiness.

- [x] **T5.2 - Run live MiMo smoke when installed.** After installing MiMo on the supervisor host, run `pnpm -C supervisor smoke:acp --cache <path> mimo` outside the sandbox if host permissions/auth are needed. Record result in the spike doc. If not installed, preserve skipped/NotReady state and do not mark implementation incomplete. Files: `docs/spikes/2026-06-11-acp-mimo-code-adapter.md`, smoke cache docs. Logging requirements: record command, binary, version/protocol/session id or skip reason; redact auth.

- [x] **T5.3 - Run validation commands.** Minimum gate: `pnpm --filter @maister/supervisor test:unit`, `pnpm --filter @maister/supervisor test:integration`, `pnpm --filter @maister/supervisor typecheck`, `pnpm --filter maister-web test:unit`, `pnpm --filter maister-web test:integration`, `pnpm --filter maister-web typecheck`, docs/API validation if configured. Files: none. Logging requirements: final validation notes must include failing command, adapter surface, and whether failure is pre-existing or caused by MiMo changes.

  Validation note (2026-06-11): supervisor typecheck/unit/integration pass; web unit passes. Web typecheck remains blocked by unrelated baseline errors in `FlowGraphViewSection` props and a catalog test seed missing `projects.taskKey`. Web integration remains blocked by the same baseline `projects.task_key` seed/migration issue family; MiMo-focused unit and supervisor integration coverage passed.

### Phase 6: Final Docs and Rollout

- [x] **T6.1 - Complete as-built docs.** Update `docs/supervisor.md`, `docs/configuration.md`, `docs/getting-started.md`, `docs/system-analytics/acp-runners.md`, `docs/system-analytics/model-catalog.md`, `docs/system-analytics/flow-settings.md`, `docs/system-analytics/capability-catalog.md`, `docs/error-taxonomy.md`, `README.md` if helpful, and API specs. Files: listed docs. Logging requirements: docs must include operator-visible diagnostic examples without secrets.

- [x] **T6.2 - Rollout defaults and operator notes.** Document that MiMo is NotReady until installed and smoked; show `MAISTER_ADAPTER_BINARY_MIMO` and smoke-cache workflow; state host-run supervisor/container implications. Files: `.env.example`, `docs/configuration.md`, `docs/getting-started.md`, deployment docs if needed. Logging requirements: n/a for docs, but examples must not encourage logging raw tokens.

## Risks and Blockers

- MiMo is not installed locally; live smoke cannot pass until the operator installs/configures it on the supervisor host.
- MiMo's ACP SDK dependency is older than MAIster's runtime SDK; initialize/newSession may still pass, but permission/model/resume shapes must be fixture- and smoke-proven.
- MiMo source currently carries OpenCode-branded internals/auth instructions; readiness/docs must not confuse the operator by saying OpenCode is configured when MiMo is the runner.
- MiMo may create `.mimocode` project/global state; deployment docs must call out writable state dirs for the host-run supervisor.
- Do not make MiMo the platform default automatically, and do not weaken existing Codex/OpenCode/Gemini readiness guards while adding it.

## Next Step

Run `$aif-implement` from a real feature branch named `feature/mimo-code-acp-adapter`, or keep this plan as the implementation checklist for a later branch.
