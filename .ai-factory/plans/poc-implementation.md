# MAIster POC — Master Implementation Plan

- **Branch**: `main` (no feature branch — this is a coordination artifact; per-milestone branches are created during `/aif-implement` calls against sub-plans)
- **Created**: 2026-05-25
- **Target window**: T+4 to T+5 weeks for technical POC (M1-M12); T+5 to T+6 weeks for dogfood (M13a); T+8 weeks for external validation (M13b)
- **Scope**: the full POC, mapping every roadmap milestone (M1-M13) to concrete tasks with sequential / parallel ordering and critical-path annotations
- **Authority**: `CLAUDE.md` §1-8 (architectural commitments), `docs/kaa-maister-design-20260522-174429.md` (locked design), `docs/kaa-maister-design-20260525-acp-revision.md` (post-ACP revision), `.ai-factory/ARCHITECTURE.md` (folder structure + dependency rules), `.ai-factory/ROADMAP.md` (milestone definitions). When this plan disagrees with those, those win — update this file.

## Settings

- **Testing**: yes — unit/integration via `vitest`, E2E via `playwright`. Test infrastructure lands in Phase 0 Workstream T so every later workstream gets it for free.
- **Logging**: verbose — DEBUG-level structured logs (`pino` recommended) on all server-side modules. Every state transition, every supervisor↔web HTTP call, every spawn/exit/respawn, every atomic write must produce a log line. AI-generated code benefits from heavy logs; user can prune later.
- **Docs**: yes (mandatory) — `/aif-docs` checkpoint runs after every commit milestone (see §"Commit Plan" below). Routes / lib modules / supervisor modules are documented inline; high-level docs at the phase boundary.
- **Roadmap Linkage**: this plan IS the POC roadmap execution; all M1-M13 milestones from `.ai-factory/ROADMAP.md` are covered.

## Roadmap Linkage

**Milestone**: full POC (M1-M13) per `.ai-factory/ROADMAP.md`.
**Rationale**: user explicitly requested a master plan covering the entire POC scope with parallel/sequential feature implementation ordering. This file is the coordination spine; per-milestone branches and sub-plans get created by separate `/aif-plan` calls against individual milestones as Phase 0 lands.

## Critical Path (TL;DR)

```
M1 + M2  (Phase 0, sequential — foundation, ~3-5d)
  └── M3 ──┐
  └── M4 ──┤  Phase 1 in parallel (3 streams, ~5-7d)
  └── M6 ──┘
       │
       ├── M5  (needs M4 + M6)         ──┐
       ├── M7  (needs M3 + M6)         ──┤  Phase 2 in parallel (2-3 streams, ~5-7d)
       ├── M9-partial  (needs M1 + M6) ──┘
            │
            ├── M8  (needs M3 + M7)            ──┐
            ├── M9-rest  (needs M9-partial)    ──┤  Phase 3 in parallel (3 streams, ~5-7d)
            ├── M11  (needs M9-partial + git)  ──┘
                 │
                 ├── M10  (needs M7 + M8 + M9)  ──┐  Phase 4 in parallel (2 streams, ~3-5d)
                 ├── M12  (needs M1 + M3 + M8)  ──┘
                      │
                      └── M13a → M13b  (Phase 5 sequential, validation, ~7-14d)
```

**Total estimate**: 4-6 weeks for M1-M12 (technical POC complete), +1 week dogfood, +3 weeks external validation. Matches the success criteria in `CLAUDE.md` (T+4 to T+8w).

**Critical path = M1 → M2 → M3 → M7 → M8 → M10 → M13**. Anything off this chain (M4, M5, M6 between M2 and M7; M9, M11 between M2 and M10; M12 between M8 and M13) can slip without dragging the overall delivery date — they are parallel "branches" off the spine.

---

## Phase 0 — Foundation (sequential, 1 worker, ~3-5 days)

**Goal**: lock the database, error taxonomy, config schema, and test infrastructure before anything else touches them. Every later phase imports from `lib/db/`, `lib/errors.ts`, `lib/atomic.ts`, `lib/config.ts` — they MUST be stable.

**Parallelism**: none. Phase 0 ships as one branch, one PR, in this order. Workstream T (test infra) can interleave with M2 (same worker, same branch, same PR) because both touch only `web/`.

### Task 0.1 — M1: Drizzle schema + Postgres compose (foundation)

- **Deliverable**: `web/lib/db/schema.ts` defining the seven core tables, working migrations under `web/lib/db/migrations/`, `docker-compose.yml` updated to host `postgres:16` with a named volume + seed user, `web/lib/db/client.ts` exporting a Drizzle client that picks PG vs SQLite via `DB_URL` env (`postgres://...` vs `file:./dev.db`).
- **Tables** (per `web/CLAUDE.md` + `CLAUDE.md` §6):
  - `projects` — `id, slug (unique), name, repo_path (unique), main_branch, branch_prefix, maister_yaml_path, default_executor_id, created_at, archived_at?`
  - `executors` — `id, project_id, agent ('claude'|'codex'), model, env (jsonb), router ('ccr'|null), created_at`. UNIQUE `(project_id, id-within-project)`.
  - `flows` — `id, project_id, source (git URL), version (tag), installed_path, manifest (jsonb cache), recommended_executor_id?, schema_version`. UNIQUE `(project_id, flow_id-within-project)`.
  - `tasks` — `id, project_id, title, prompt, flow_id, executor_override_id?, status ('Backlog'|'InFlight'|'Done'|'Abandoned'), attempt_number (default 1), created_at, updated_at`. UNIQUE `(task_id, attempt_number)` — see §6 in `CLAUDE.md` for retry semantics.
  - `workspaces` — `id, run_id, project_id, branch, worktree_path, parent_repo_path, created_at, removed_at?`.
  - `runs` — `id, task_id, project_id, flow_id, executor_id, status ('Pending'|'Running'|'NeedsInput'|'NeedsInputIdle'|'Review'|'Crashed'|'Done'|'Abandoned'|'Failed'), acp_session_id?, flow_version, checkpoint_at?, keepalive_until?, started_at, ended_at?`.
  - `hitl_requests` — `id, run_id, step_id, kind ('permission'|'form'|'human'), schema (jsonb?), prompt, response (jsonb?), responded_at?, created_at`.
- **Files**: `web/lib/db/schema.ts`, `web/lib/db/client.ts`, `web/lib/db/migrations/*`, `web/drizzle.config.ts`, `docker-compose.yml`, `.env.example` (`DB_URL=postgres://maister:maister@localhost:5432/maister`), `web/package.json` (add `drizzle-orm`, `drizzle-kit`, `pg`, `@types/pg`, `zod`).
- **Logging**: `lib/db/client.ts` logs the resolved dialect + DB URL host (NOT password) at startup; migration runs log per-statement DEBUG.
- **Tests**: integration test booting Postgres in a `testcontainers-node` container, running migrations end-to-end, asserting all 7 tables + the UNIQUE constraints. SQLite path tested separately (`DB_URL=file::memory:`).
- **Why this is first**: every later module imports from `lib/db/schema.ts`. Changing the schema mid-implementation forces N rewrites.
- **Acceptance**: `pnpm drizzle-kit generate && pnpm drizzle-kit migrate` succeeds against fresh Postgres; integration test green; `MaisterError` not yet imported (Task 0.2 introduces it).

### Task 0.2 — M2: Core libs (errors, atomic, config v2, flow.yaml validator)

- **Deliverable**:
  - `web/lib/errors.ts` — `MaisterError` discriminated union with the full code taxonomy: `PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT | CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL | CHECKPOINT`. Constructor signature: `new MaisterError(code, message, options?)`. UI branches on `err.code`, never string-matches `err.message`.
  - `web/lib/atomic.ts` — `atomicWriteJson(path, data)`: `mkdir -p`, write to `${path}.${randomUUID()}.tmp`, `fs.rename` atomically. No partial writes ever land at the consumer-visible path. Every read by the agent / Flow must be against the renamed path.
  - `web/lib/config.ts` — `maister.yaml` v2 loader. Validates with `zod`. Checks `schemaVersion === 2`, no duplicate executor IDs, no duplicate flow IDs, every `default_executor` and `flow.executor_override` reference an executor that exists. Throws `MaisterError({code: 'CONFIG'})` on every failure mode. Also loads + validates `flow.yaml` manifests (`schemaVersion: 1`, no duplicate step IDs, every `goto_step` reference exists, `recommended_executor` if set is a known string — actual executor existence validated at project-load time).
  - `web/lib/db/seed.ts` — minimal seed for dev (one project, one executor, one flow). Optional but useful for Phase 1+ work.
- **Files**: `web/lib/errors.ts`, `web/lib/atomic.ts`, `web/lib/config.ts`, `web/lib/config.schema.ts` (zod schemas for `maister.yaml` v2 + `flow.yaml`), `web/lib/db/seed.ts`.
- **Logging**: `lib/config.ts` logs the resolved `maister.yaml` path + parsed structure at DEBUG on load; every validation error logs at WARN with the offending field path before throwing.
- **Tests**: unit tests cover every `MaisterError` code (instanceof + code-discriminator), `atomicWriteJson` (concurrent writes don't corrupt, tmp file cleaned on rename, no partial writes visible to a parallel reader using a `setInterval` checker), `loadProjectConfig` (every reject path: bad schemaVersion, dup IDs, unknown executor ref, missing required field).
- **Acceptance**: 100% of error codes have a test; `atomicWriteJson` survives 100 parallel writes to the same path with no torn output; `loadProjectConfig` rejects 8+ malformed fixtures and accepts a golden one.
- **Dependency**: builds on Task 0.1 (`schema.ts` imports + seed needs `db/client.ts`).

### Task 0.T — Workstream T: Test infrastructure (interleaves with 0.1 + 0.2)

- **Deliverable**:
  - `web/vitest.config.ts` configured for unit + integration suites (separate `--project` per suite or separate config; integration enables `testcontainers`).
  - `web/playwright.config.ts` scaffolded (no E2E specs yet — they land in Phase 3 alongside the UI).
  - `web/package.json` scripts: `pnpm test`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm typecheck` (`tsc --noEmit`).
  - GitHub Actions workflow stub at `.github/workflows/ci.yml` running `pnpm install && pnpm lint && pnpm typecheck && pnpm test:unit`. Integration + E2E gated by labels (out of POC scope for green-CI mandates per `CLAUDE.md`).
  - `pre-commit` (or `lefthook`) wiring: lint + typecheck on staged files only. Optional, recommended.
- **Files**: `web/vitest.config.ts`, `web/playwright.config.ts`, `.github/workflows/ci.yml`, `web/package.json`, optionally `lefthook.yml`.
- **Logging**: not applicable — config only.
- **Why now**: every later task adds tests; missing infra means tests get skipped "for later" and never land.
- **Acceptance**: `pnpm test:unit` runs the unit suite from Tasks 0.1 + 0.2 and passes; `pnpm typecheck` is green; CI workflow file lints clean (`actionlint` if available).

### Phase 0 Commit Checkpoint

After Tasks 0.1 + 0.2 + 0.T green: **commit `feat: M1+M2 foundation — Drizzle schema, MaisterError taxonomy, atomic writes, config v2, test infra`** and tag `poc-phase-0-done`. Run `/aif-docs` to document the schema + error taxonomy. Branch: `feature/poc-foundation` (created by per-milestone `/aif-plan full` against M1+M2 grouped).

---

## Phase 1 — Backbone (3 parallel workstreams, ~5-7 days)

**Goal**: stand up the three independent backbone modules — supervisor daemon, Flow plugin loader, executor registry. They share Phase 0 foundations but do not import from each other.

**Parallelism**: 3 parallel branches off `main` (post-Phase-0). Each workstream is one worker, one branch, one PR.

### Workstream A — M3: Supervisor daemon (`supervisor/`)

Owned by one worker on `feature/m3-supervisor`. The biggest single workstream in Phase 1 — internally sequential (5 sub-tasks).

#### Task 1.A.1 — Bootstrap `supervisor/` package

- **Deliverable**: `supervisor/` directory scaffolded as a separate npm package — own `package.json`, own `tsconfig.json`, own `eslint.config.mjs`. NOT a workspace child of `web/` (per `web/pnpm-workspace.yaml` comment — workspace only declares `allowBuilds`). Add `hono` (or `express`) as HTTP server, `@agentclientprotocol/sdk@0.22.1` as direct dep, `@agentclientprotocol/claude-agent-acp@0.37.0` + `@agentclientprotocol/codex-acp@0.0.44` as deps so the adapter binaries land on `node_modules/.bin/`. Add `pino` for structured logs.
- **Files**: `supervisor/package.json`, `supervisor/tsconfig.json`, `supervisor/eslint.config.mjs`, `supervisor/src/main.ts` (skeleton: listen on `MAISTER_SUPERVISOR_PORT` env, default 7777), `supervisor/README.md`.
- **Logging**: `pino` JSON logs to stdout; the `main.ts` entry logs port + node version + node uptime.
- **Acceptance**: `cd supervisor && pnpm install && pnpm dev` starts a server replying to `GET /healthz` with `{ ok: true }`.

#### Task 1.A.2 — `supervisor/src/spawn.ts` — process-per-session

- **Deliverable**: `spawnAgent({ agent, model, env, resumeSessionId?, projectSlug, runId, stepId, cwd, onAcpEvent })`. Dispatches `claude-agent-acp` for `agent === 'claude'` and `codex-acp` for `agent === 'codex'`. Forwards `--resume <session-id>` when `resumeSessionId` is set. Streams stdout line-by-line: writes every line to `.maister/<projectSlug>/runs/<runId>/<stepId>.log` via `fs.createWriteStream(..., { flags: 'a' })` AND invokes `onAcpEvent(line, monotonicId)` synchronously per line. Returns `{ kill: () => child.kill('SIGTERM') }`. Captures stderr separately (logged at WARN). Throws `MaisterError({code: 'SPAWN'})` on immediate exit with non-zero code or on adapter binary not found on PATH.
- **Files**: `supervisor/src/spawn.ts`, `supervisor/src/log-paths.ts` (helper to construct `.maister/<slug>/runs/<id>/<step>.log` deterministically).
- **Logging**: every spawn logs `agent`, `model`, `cwd`, `pid`, `resumeSessionId?` at INFO. Every line received logs at DEBUG with the monotonic ID. Process exit logs at INFO with `code + signal + duration`. Spawn failure logs at ERROR before throwing.
- **Tests**: integration test that spawns a stub binary (a node script that emits 3 JSON lines to stdout then exits) and asserts (a) 3 `onAcpEvent` calls with monotonic IDs 1/2/3, (b) the log file contains the same 3 lines verbatim, (c) `kill()` terminates the child.
- **Acceptance**: stub-binary integration test green; spawning `claude-agent-acp --help` returns clean.

#### Task 1.A.3 — `supervisor/src/heartbeat.ts` — crash detection

- **Deliverable**: per-session heartbeat. Each active session has a `Date.now()` timestamp updated by every ACP event received. A 30-second interval scans all sessions; any session whose process exited unexpectedly (child.exitCode is set and run state was `Running` / `NeedsInput`) emits a `session-crashed` event that the HTTP layer (Task 1.A.5) surfaces back to the web tier. Sessions in `NeedsInputIdle` are not "crashed" — they exited gracefully.
- **Files**: `supervisor/src/heartbeat.ts`, `supervisor/src/session-store.ts` (in-memory `Map<acpSessionId, SessionState>` — supervisor is intentionally stateless across restarts; reconciliation lives in `web/lib/reconcile.ts`).
- **Logging**: heartbeat tick logs at TRACE (off by default). Crash detection logs at ERROR with `runId, stepId, exitCode, signal, lastEventAt`.
- **Tests**: unit test of `heartbeat.tick()` over a fake session-store fixture asserts the `crashed` callback fires for unexpected-exit sessions and does NOT fire for `NeedsInputIdle` sessions.
- **Acceptance**: unit test green.

#### Task 1.A.4 — `supervisor/src/checkpoint.ts` — graceful pause on idle timeout

- **Deliverable**: per-session idle timer. While a session is in `NeedsInput`, every web-side `POST /sessions/:id/activity` extends `keepaliveUntil` by `MAISTER_KEEPALIVE_MINUTES * 60_000` (default 30). When `Date.now() > keepaliveUntil`, supervisor sends `SIGTERM` to the child (Claude Code persists its session JSONL on graceful exit per M0 spike findings), waits up to 10s for clean exit, then emits `session-checkpointed` event. Session state becomes `NeedsInputIdle` from web tier's perspective; `acp_session_id` remains the resume handle.
- **Files**: `supervisor/src/checkpoint.ts`, plus a new HTTP route `POST /sessions/:id/activity` (in Task 1.A.5).
- **Logging**: every activity bump logs at DEBUG with the new `keepaliveUntil`. Checkpoint init logs at INFO with `runId, sessionId, idleDuration`. Forced kill after 10s timeout logs at WARN.
- **Tests**: integration test with stub binary: spawn → simulate `NeedsInput` → wait `keepalive` window → assert clean exit → assert `session-checkpointed` event fired.
- **Acceptance**: integration test green.

#### Task 1.A.5 — `supervisor/src/http-api.ts` + SSE — full HTTP surface

- **Deliverable**: HTTP routes exposed by `supervisor/src/main.ts`:
  - `POST /sessions` — body `{ runId, projectSlug, worktreePath, executor: {agent, model, env?, router?}, flowManifest, prompt }`. Resolves CCR env if `router === 'ccr'`; spawns agent via Task 1.A.2; returns `{ acpSessionId }`.
  - `DELETE /sessions/:id` — sends `SIGTERM`, awaits exit (10s timeout), removes from session store, returns `{ ok: true }`.
  - `GET /sessions/:id/stream` — SSE endpoint. Subscribes to per-session event bus, emits one SSE `data:` per ACP `session/update` line. Each event has `id: <monotonicId>`. On reconnect with `Last-Event-ID`, server replays from the on-disk log file from that ID forward (tail-from-offset).
  - `POST /sessions/:id/input` — body `{ stepId, value }`. If session is alive, supervisor writes the input artifact to disk via `atomicWriteJson` AND injects an ACP message to the live worker (TBD: confirm the exact ACP message shape during M3 — may need to fall back to artifact-only if the live-path doesn't exist in the Zed-standard ACP surface). If session is checkpointed, respawns it with `--resume <session-id>` after writing the artifact.
  - `POST /sessions/:id/activity` — bumps keep-alive (Task 1.A.4).
  - `GET /healthz` — liveness probe.
- **Files**: `supervisor/src/http-api.ts`, `supervisor/src/sse.ts` (helper for SSE framing + reconnect-from-id), `supervisor/src/main.ts` (wires routes).
- **Logging**: every HTTP request logs at INFO with method + path + status + duration. SSE subscription logs at DEBUG. Errors at ERROR with full `MaisterError` payload.
- **Tests**: contract tests using `supertest`-style. For SSE, assert that `Last-Event-ID` skips to the right offset against a pre-populated log fixture.
- **Acceptance**: all five routes have contract tests passing.

#### Workstream A Commit Checkpoint

After Tasks 1.A.1-1.A.5: commit on `feature/m3-supervisor` with message `feat(supervisor): M3 — supervisor daemon (ACP spawn, heartbeat, checkpoint, HTTP+SSE)`. Run `/aif-docs` for `supervisor/README.md`. **Merge to main** before Phase 2 starts (Phase 2 Workstream A and Workstream C both consume the supervisor HTTP API).

### Workstream B — M4: Flow plugin loader

Owned by one worker on `feature/m4-flow-plugin-loader`.

#### Task 1.B.1 — `web/lib/flows.ts` — git-clone + manifest validation + symlink

- **Deliverable**: `installFlowPlugin({ source, version, projectSlug, flowId })`. Behavior:
  1. Compute target path `~/.maister/flows/<flowId>@<version>/`. If exists, skip clone.
  2. Else: `git clone --branch <version> --depth 1 <source> <target>`. Verify `<target>/flow.yaml` exists, parse + validate via `lib/config.ts` (already lands in Phase 0). Throw `MaisterError({code: 'FLOW_INSTALL'})` on every failure (clone fails, tag missing, manifest missing, manifest invalid).
  3. If `<target>/setup.sh` exists, exec it with `cwd=target`. POC = trust all sources (Flow plugins from internal sources only); sandboxing is Phase 2 per `CLAUDE.md`.
  4. Create symlink `.maister/<projectSlug>/flows/<flowId>` → `~/.maister/flows/<flowId>@<version>/`. Idempotent (recreate if exists pointing elsewhere).
  5. Insert / update row in `flows` table with `installed_path`, cached `manifest` JSON, `schema_version`.
- **Files**: `web/lib/flows.ts`, `web/lib/flow-paths.ts` (deterministic path computation), tests under `web/lib/__tests__/flows.test.ts`.
- **Logging**: every install logs at INFO with `flowId, version, source, target`. Clone shells out to `git`; stdout/stderr logged at DEBUG. `setup.sh` execution logs at WARN if non-zero exit. Symlink create/recreate logs at DEBUG.
- **Tests**: integration test using a fixture git repo (set up in `web/test-fixtures/flow-plugin/` as a bare repo) — install once, install twice (skip clone), install with invalid manifest (rejects), install missing tag (rejects). Symlink integrity asserted via `fs.readlink`.
- **Acceptance**: 4 integration tests green; row appears in `flows` table.

#### Task 1.B.2 — Flow plugin loader CLI surface (optional, useful for ops)

- **Deliverable**: `supervisor/src/main.ts` is NOT the right home — this is a `web/`-side concern. A small dev CLI at `web/scripts/install-flow.ts` callable as `pnpm install-flow --project <slug> --source <url> --version <tag> --flow-id <id>` — for ops smoke-testing without going through the UI.
- **Acceptance**: command installs a real `superpowers` (or fixture) plugin against a registered project.

### Workstream C — M6: Executor registry + CCR

Owned by one worker on `feature/m6-executor-registry`.

#### Task 1.C.1 — `web/lib/executors.ts` — registry + override resolution

- **Deliverable**:
  - `resolveExecutor({ launchOverride?, projectOverride?, projectDefault, flowRecommended? })` — applies the priority chain documented in `CLAUDE.md` §5: run launcher → project override → project default → flow recommended. Throws `MaisterError({code: 'EXECUTOR_UNAVAILABLE'})` if the resolved ID does not exist in the `executors` table.
  - `buildExecutorEnv(executor, ccrConfig?)` — returns the env-var bag to pass to `spawnAgent`. If `executor.router === 'ccr'`, returns CCR bootstrap env (CCR proxy URL, etc.). If `executor.env` carries `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (z.ai / OpenRouter / anyscale env-router path), passes them through. Never logs `AUTH_TOKEN` values (mask to `***`).
  - DB CRUD: `listExecutors(projectId)`, `getExecutor(projectId, executorId)`, `upsertExecutorsFromConfig(projectId, executorsYaml)` (called from `lib/projects.ts` when loading `maister.yaml`).
- **Files**: `web/lib/executors.ts`, `web/lib/__tests__/executors.test.ts`.
- **Logging**: `resolveExecutor` logs the priority-chain decision at DEBUG with the source of each step (`launchOverride`, `projectOverride`, `projectDefault`, `flowRecommended`). `buildExecutorEnv` logs the resolved env keys (not values) at DEBUG.
- **Tests**: unit tests cover every priority-chain combination + the unavailable-executor reject path. CCR env construction tested against a golden snapshot. Token-masking asserted (logger output never contains the auth token string).
- **Acceptance**: 8+ unit tests green.

#### Task 1.C.2 — CCR (Claude Code Router) bundling

- **Deliverable**: add `@musistudio/claude-code-router@2.0.0` as supervisor dep. On supervisor startup, if any executor in any registered project has `router: ccr`, spawn CCR as a background process (managed by supervisor lifecycle). Expose `MAISTER_CCR_URL` for the env-router path to use. If no `router: ccr` executors exist, don't spawn (lazy).
- **Files**: `supervisor/src/ccr.ts`, `supervisor/src/main.ts` (wires CCR lifecycle).
- **Logging**: CCR spawn / shutdown logs at INFO. CCR stdout/stderr at DEBUG.
- **Acceptance**: smoke test — register an executor with `router: ccr`, restart supervisor, hit `GET /healthz`, verify CCR is reachable at `MAISTER_CCR_URL`.

#### Workstream C Commit Checkpoint

After Tasks 1.C.1 + 1.C.2: commit on `feature/m6-executor-registry` with message `feat(executors): M6 — executor registry + override resolution + CCR bundle`. Merge to main.

### Phase 1 Merge Gate

All three workstreams merge to `main` before Phase 2 starts. Order of merge does NOT matter (no inter-workstream dependencies). After all three are merged: tag `poc-phase-1-done` and run `/aif-docs`.

---

## Phase 2 — Orchestration (3 parallel workstreams, ~5-7 days)

**Goal**: wire ACP into the supervisor (M7), parse + execute the Flow DSL (M5), and stand up the Web UI skeleton (M9-partial: registry CRUD + nav + theming + i18n).

**Parallelism**: 3 parallel branches.

### Workstream A — M7: ACP integration + SSE bridge

Branch: `feature/m7-acp-sse-bridge`.

#### Task 2.A.1 — `supervisor/src/acp-client.ts` — Zed-standard ACP client

- **Deliverable**: thin wrapper over `@agentclientprotocol/sdk` that parses each `session/update` JSON line from the spawned adapter binary into typed events. Handles `session/update`, `session/request_permission`, `session/checkpoint` (if exposed). Emits typed events on a per-session `EventEmitter`. Per `CLAUDE.md` §1: no custom ACP extensions on POC — only the Zed-standard surface.
- **Files**: `supervisor/src/acp-client.ts`, `supervisor/src/acp-types.ts` (re-exports SDK types + project-local extensions).
- **Logging**: every parsed event logs at TRACE. Unparseable lines log at WARN with the raw line (truncated to 200 chars).
- **Tests**: golden-line fixtures (one per event type) parsed correctly; malformed lines emit WARN and do not crash.
- **Acceptance**: 4+ unit tests green.

#### Task 2.A.2 — `web/lib/supervisor-client.ts` — HTTP+SSE client

- **Deliverable**: typed client for all supervisor routes (Task 1.A.5). SSE consumer that reconnects on disconnect with `Last-Event-ID`. Throws typed `MaisterError` for every failure mode (HTTP 4xx → `ACP_PROTOCOL` / `SPAWN` / `EXECUTOR_UNAVAILABLE` per response code; network error → `CRASH`; etc.).
- **Files**: `web/lib/supervisor-client.ts`, `web/lib/__tests__/supervisor-client.test.ts`.
- **Logging**: every outbound request logs at DEBUG with method + path. SSE connect / disconnect / reconnect logs at INFO.
- **Tests**: mock supervisor via `msw` or a stub Hono server. Assert SSE reconnect uses `Last-Event-ID`. Assert every error code surfaces with the right `MaisterError.code`.
- **Acceptance**: 10+ unit tests green.

#### Task 2.A.3 — `app/api/runs/[id]/stream/route.ts` — SSE bridge

- **Deliverable**: Next.js Route Handler that opens an SSE connection to `supervisor-client` (via `lib/supervisor-client`) and proxies events to the browser. Each event has `id: <monotonicId>` for `lastEventId` reconnect from the browser side. Falls back to reading from the on-disk per-step log file when supervisor is unreachable or the run is in `NeedsInputIdle` (no live worker).
- **Files**: `web/app/api/runs/[id]/stream/route.ts`.
- **Logging**: connection open / close logs at INFO. Each event proxied logs at TRACE.
- **Tests**: integration test booting a fake supervisor that emits 5 events; assert the browser sees the same 5 events with correct IDs; disconnect mid-stream, reconnect with `lastEventId=3`, assert the browser sees events 4 + 5 (not 1-3).
- **Acceptance**: 1 integration test green.

#### Workstream A Commit Checkpoint

After Tasks 2.A.1-2.A.3: commit `feat(acp): M7 — ACP client + SSE bridge web↔supervisor`. Merge to main.

### Workstream B — M5: Flow DSL parser + executor

Branch: `feature/m5-flow-dsl`.

#### Task 2.B.1 — Step type parser + validator

- **Deliverable**: extend `lib/config.ts` (Phase 0 already validates `flow.yaml` schema) with a step-type-aware executor that knows how to run each `cli | agent | guard | human` step. The DSL parser produces a `FlowExecutionPlan` (ordered list of step descriptors with resolved templates).
- **Files**: `web/lib/flow-runner.ts` (the executor), `web/lib/flow-templates.ts` (Mustache-style interpolation with session context + cross-step vars + executor metadata, per `CLAUDE.md` §6 requirement).
- **Logging**: every step entry logs at INFO with `stepId, type, mode`. Every template resolution logs at DEBUG with the var bag (masked secrets).
- **Tests**: golden fixture flow with 4 steps (one of each type) parsed + plan-built correctly. Templating tests cover every documented var (`{{ task.prompt }}`, `{{ session.id }}`, `{{ executor.model }}`, cross-step output vars).
- **Acceptance**: 6+ unit tests green.

#### Task 2.B.2 — `agent` step execution: both modes

- **Deliverable**: `agent` step supports both `mode: new-session` (spawn fresh adapter; one ACP session per step) and `mode: slash-in-existing-session` (deliver `prompt` via ACP message to the already-live session). Mode is per-step in `flow.yaml`. Both paths use `lib/supervisor-client.ts` Task 2.A.2 (so this task depends on 2.A.2 landing first — see Phase 2 inner ordering note below).
- **Files**: `web/lib/flow-runner.ts` (extended).
- **Logging**: mode decision + session ID logged at INFO per step.
- **Tests**: integration test with stub supervisor; assert `new-session` creates a new `acpSessionId` and `slash-in-existing-session` reuses the existing one.
- **Acceptance**: 2 integration tests green.

#### Task 2.B.3 — `cli` + `human` + `guard` step execution

- **Deliverable**:
  - `cli` step: runs a shell command from the Flow plugin's installed dir via `child_process.spawn`. Stdout/stderr captured into the per-step log. Non-zero exit → step fails. NOT spawned through supervisor (it's not an ACP session); driven directly from `web/lib/flow-runner.ts`.
  - `human` step: writes a `needs-input.json` artifact (form schema from the step's `form_schema`); run state → `NeedsInput`. On user response: if `on_reject` is set + the user chose reject, evaluates `goto_step` and loops back to that step with `comments_var` set. On accept, proceeds to the next step.
  - `guard` step: evaluates cost/time/regex guard against accumulated metrics from `cost.jsonl`. **Parse-and-persist only on POC** per `CLAUDE.md` §6 — guards record their decision (`pass | warn`) in the step log; they do NOT kill the run. Enforcement is Phase 2.
- **Files**: `web/lib/flow-runner.ts` (extended further), `web/lib/guards.ts` (metric-only evaluator).
- **Logging**: every step entry / exit / outcome logs at INFO. Guard decisions log at WARN if `warn`.
- **Tests**: 1 fixture flow per step type; integration tests assert correct state machine transitions for `human` step (`Running` → `NeedsInput` → resume).
- **Acceptance**: 6+ tests green.

#### Workstream B Commit Checkpoint

After Tasks 2.B.1-2.B.3: commit `feat(flows): M5 — Flow DSL parser + executor (all step types, both agent modes)`. Merge to main. **Inner dependency**: 2.B.2 needs 2.A.2 merged. Schedule worker B to start with 2.B.1 + 2.B.3 (independent of supervisor-client) and pull 2.B.2 in last.

### Workstream C — M9-partial: Web UI skeleton + i18n + registry

Branch: `feature/m9p-web-ui-skeleton`.

#### Task 2.C.1 — i18n scaffolding (EN + RU from day one)

- **Deliverable**: `next-intl` (or `react-intl` via `intl-messageformat` which is already a dep) wired into `app/layout.tsx`. Locale switcher in `components/navbar.tsx`. `web/i18n/en.json` + `web/i18n/ru.json` files; every visible string in the template stubs replaced with a `t('key')` call. Locale persisted to cookie + URL prefix (`/en/...` vs `/ru/...`) — choose URL-prefix routing for SEO friendliness.
- **Files**: `web/i18n/`, `web/middleware.ts` (locale routing), `web/app/[locale]/layout.tsx` (locale-aware layout), `web/components/locale-switch.tsx`, `web/components/navbar.tsx` (updated).
- **Logging**: locale resolution logs at DEBUG per request (server side).
- **Tests**: unit test for `t()` helper; integration test asserts `/ru/projects` renders Russian strings.
- **Acceptance**: switching the locale in the UI changes every visible string; reload preserves locale.

#### Task 2.C.2 — Replace template stubs + add nav

- **Deliverable**: remove `app/about/`, `app/blog/`, `app/docs/`, `app/pricing/` (template demo material). Replace `app/page.tsx` with a placeholder Portfolio home that says "No active workspaces" (real content lands in Phase 3 Workstream B). Update `config/site.ts` `navItems` to `Portfolio (/)`, `Projects (/projects)`, `Settings (/settings)`. Delete `components/counter.tsx`.
- **Files**: `web/app/page.tsx`, `web/config/site.ts`, removed dirs.
- **Acceptance**: `pnpm dev` shows the new nav; old template pages 404.

#### Task 2.C.3 — Projects registry CRUD (UI + API)

- **Deliverable**:
  - `web/app/projects/page.tsx` — list of registered projects (server component reading from `lib/db`).
  - `web/app/projects/new/page.tsx` — Add Project form: paste path to a dir containing `maister.yaml`. Server action validates the path exists, loads `maister.yaml` via `lib/config.ts`, installs every referenced Flow plugin via `lib/flows.ts`, persists row + executors via `lib/projects.ts`. Surfaces typed `MaisterError` codes via UI branches (`CONFIG`, `FLOW_INSTALL`, `EXECUTOR_UNAVAILABLE`).
  - `web/lib/projects.ts` — registry CRUD + slug derivation (kebab-case from `project.name`) + slug + `repo_path` uniqueness enforcement (DB unique constraint + pre-check for clean error UX) + recursive `MAISTER_PROJECTS_DIR` auto-discovery on startup.
  - `web/app/api/projects/route.ts` — `POST` (register) and `DELETE /api/projects/[slug]/route.ts` (soft-archive).
- **Files**: `web/app/projects/`, `web/lib/projects.ts`, `web/app/api/projects/`, `web/lib/__tests__/projects.test.ts`.
- **Logging**: every registration logs at INFO with `slug, repo_path, flow_count, executor_count`. Auto-discovery on startup logs the scan path + each discovered file at DEBUG.
- **Tests**: unit tests for slug derivation + uniqueness; integration test for the Add Project flow against a fixture `maister.yaml`.
- **Acceptance**: register 2 projects via the UI; both appear in the list; refresh persists them.

#### Workstream C Commit Checkpoint

After Tasks 2.C.1-2.C.3: commit `feat(web): M9-partial — UI skeleton, EN+RU i18n, projects registry`. Merge to main.

### Phase 2 Merge Gate

All three workstreams merge to `main`. Tag `poc-phase-2-done`. Run `/aif-docs`.

---

## Phase 3 — State machine + Board UX (3 parallel workstreams, ~5-7 days)

**Goal**: bring the worker lifecycle alive (M8 — keep-alive + checkpoint + resume), build the actual Portfolio + Board UI (M9-rest), and wire diff view + merge (M11).

### Workstream A — M8: Worker lifecycle keep-alive + checkpoint + resume

Branch: `feature/m8-worker-lifecycle`.

#### Task 3.A.1 — Run state machine + DB transitions

- **Deliverable**: `web/lib/run-state.ts` — pure function `nextState(currentState, event)` covering every transition documented in `CLAUDE.md` §1: `Pending → Running` (worktree ready + supervisor spawned), `Running → NeedsInput` (ACP `session/request_permission` OR `needs-input.json` written), `NeedsInput → Running` (input delivered, worker live), `NeedsInput → NeedsInputIdle` (keep-alive expired, supervisor checkpointed), `NeedsInputIdle → Running` (user response → `--resume`), `* → Crashed` (supervisor heartbeat detected unexpected exit), `Running → Review` (final step completes), `NeedsInputIdle → Abandoned` (24h TTL), `Review → Done` (merge succeeds), `Review → Failed` (merge conflict surfaces error), etc.
- **Files**: `web/lib/run-state.ts`, `web/lib/__tests__/run-state.test.ts`.
- **Tests**: table-driven test of every valid + every invalid transition.
- **Acceptance**: 20+ tests green.

#### Task 3.A.2 — Keep-alive endpoint + activity ping client-side

- **Deliverable**:
  - `web/app/api/runs/[id]/activity/route.ts` — `POST` route bumping `runs.keepalive_until = now() + 30min` and forwarding to supervisor `POST /sessions/:id/activity`.
  - Client-side activity ping from `app/runs/[id]/page.tsx`: `setInterval(() => fetch('/api/runs/[id]/activity'), 60_000)` while page is mounted AND visible (`document.visibilityState === 'visible'`). Pause on tab blur, resume on focus.
- **Files**: `web/app/api/runs/[id]/activity/route.ts`, `web/app/runs/[id]/page.tsx` (extended), `web/components/use-activity-ping.ts` (custom hook).
- **Logging**: every ping logs at TRACE; visibility transitions log at DEBUG.
- **Tests**: unit test for the hook (mock document visibility); integration test asserts `keepalive_until` updates on `POST`.

#### Task 3.A.3 — Checkpoint + resume end-to-end

- **Deliverable**: `web/lib/run-orchestrator.ts` glue:
  - On supervisor `session-checkpointed` event → set run state to `NeedsInputIdle`, persist `checkpoint_at`.
  - On user HITL response: read `runs.acp_session_id`. If supervisor reports session is dead, call `POST /sessions` again with `resumeSessionId` set; wait for `acpSessionId` (will match the prior one — `--resume` reuses it). State `NeedsInputIdle → Running`.
  - 24h `NeedsInputIdle` TTL: `cron/gc` route (lands in Phase 4 Workstream B for completeness, but the timestamp comparison logic lives here).
- **Files**: `web/lib/run-orchestrator.ts`, `web/lib/__tests__/run-orchestrator.test.ts`.
- **Logging**: every checkpoint + resume cycle logs at INFO with full timing breakdown.
- **Tests**: integration test (with stub supervisor): spawn run → trigger HITL → checkpoint → submit input → assert respawn with `--resume`.
- **Acceptance**: 1 end-to-end integration test green.

#### Workstream A Commit Checkpoint

`feat(runs): M8 — worker lifecycle (keep-alive + checkpoint + resume)`. Merge to main.

### Workstream B — M9-rest: Portfolio home + per-project Board + Launch

Branch: `feature/m9r-portfolio-board`.

#### Task 3.B.1 — Portfolio home (`app/page.tsx`)

- **Deliverable**: superset.sh-style grid. Each card = `project · branch · status · last activity · executor · quick actions (View | Resume | Abandon)`. Server component reading from `runs` joined with `projects` + `executors`. Filters: project (multi-select), status (multi-select). "Needs you (N)" badge at the top counting `NeedsInput | NeedsInputIdle` rows across all projects.
- **Files**: `web/app/page.tsx`, `web/components/portfolio-card.tsx`, `web/components/portfolio-filters.tsx`.
- **Logging**: server-side query logs at DEBUG with filter shape.
- **Tests**: snapshot test with seeded DB.

#### Task 3.B.2 — Per-project Board (`app/projects/[slug]/page.tsx`)

- **Deliverable**: 2-column layout `Backlog | In Flight`. In Flight bucket holds `Running | NeedsInput | NeedsInputIdle | Review | Crashed`. Each Backlog card has a **Launch** button (no drag-and-drop). Click → `POST /api/runs` → server runs preconditions → creates Run → task moves to In Flight (no full page reload; revalidate the route). HITL form renders inline on In Flight cards in `NeedsInput*` state (form widget itself lands in Phase 4). `Done | Abandoned` in a filter tab beside the board.
- **Files**: `web/app/projects/[slug]/page.tsx`, `web/components/board-column.tsx`, `web/components/task-card.tsx`, `web/app/projects/[slug]/actions.ts` (server actions for create-task, launch, discard-task).
- **Logging**: every Launch click logs at INFO with `taskId, executorId, projectSlug`.
- **Tests**: Playwright spec: create task → click Launch → assert card moves to In Flight column with `Running` badge.

#### Task 3.B.3 — Task creation (`app/projects/[slug]/tasks/new/page.tsx`)

- **Deliverable**: form with `title + prompt + Flow dropdown (from project's flows[]) + optional executor override dropdown (from executors[])`. On submit → `POST /api/projects/[slug]/tasks` → task lands in Backlog with `status: 'Backlog'`, `attempt_number: 1`.
- **Files**: `web/app/projects/[slug]/tasks/new/page.tsx`, `web/app/api/projects/[slug]/tasks/route.ts`.
- **Tests**: Playwright spec: open form, fill, submit, assert task appears in Backlog.

#### Task 3.B.4 — Run launch with precondition checks

- **Deliverable**: `web/app/api/runs/route.ts` — `POST` route. Preconditions per `CLAUDE.md` §7: project exists & active, parent repo clean, branch `branch_prefix<task-slug>-<attempt-number>` free, worktree path free, global concurrency cap (`MAISTER_MAX_CONCURRENT_RUNS`, default 3) not hit (else → `Pending` with queue position), selected executor registered & available. On success: `git worktree add` via `lib/worktree.ts` → supervisor `POST /sessions` → return `{ runId, status }`.
- **Files**: `web/app/api/runs/route.ts`, `web/lib/worktree.ts` (thin wrapper around `git worktree add|remove|list`), `web/lib/scheduler.ts` (global concurrency cap + Pending queue + auto-promote on slot free).
- **Logging**: every precondition decision logs at DEBUG. Failures throw `MaisterError({code: 'PRECONDITION'})` with the failing predicate in `message`.
- **Tests**: integration tests for every precondition failure path; one happy-path test.

#### Workstream B Commit Checkpoint

`feat(web): M9-rest — Portfolio + Board + Launch + scheduler + worktree`. Merge to main.

### Workstream C — M11: Diff view + merge-to-main

Branch: `feature/m11-diff-merge`.

#### Task 3.C.1 — Run detail page + diff

- **Deliverable**: `web/app/runs/[id]/page.tsx` — full run detail: status, executor, branch, worktree path, live log stream (consumes the SSE bridge from M7), action buttons (Mark Ready, Merge, Abandon, Recover). `web/app/api/runs/[id]/diff/route.ts` — `GET` returns `git diff <parent-main>...<worktree-branch>` rendered raw as `<pre>` in the page (no syntax highlighting on POC per `CLAUDE.md` out-of-scope list).
- **Files**: `web/app/runs/[id]/page.tsx`, `web/app/runs/[id]/components/`, `web/app/api/runs/[id]/diff/route.ts`.
- **Tests**: integration test: seed a worktree with a known diff; assert the page renders it.

#### Task 3.C.2 — Merge-to-main + conflict handling

- **Deliverable**: `web/app/api/runs/[id]/merge/route.ts` — `POST`. Switches to parent's `main_branch` in the parent repo dir, runs `git merge --no-ff <worktree-branch>`. On clean merge: run state → `Done`. On conflict: `git merge --abort`, run stays in `Review`, throws `MaisterError({code: 'CONFLICT'})` with parent repo path in `message`. UI surfaces "Conflict — resolve manually at `<path>`".
- **Files**: `web/app/api/runs/[id]/merge/route.ts`, `web/lib/worktree.ts` (extended with `mergeWorktree`).
- **Tests**: integration test for both clean + conflict paths.

#### Task 3.C.3 — Abandon + retry-loop (task ↔ run 1:N)

- **Deliverable**:
  - `web/app/api/runs/[id]/abandon/route.ts` — `POST`. Calls supervisor `DELETE /sessions/:id` if alive; marks worktree stale (removed on next GC); task status updates: if this was the latest run and it ended `Abandoned | Failed | Crashed`, task → `Backlog`, `attempt_number` increments. Launch button re-appears. Implements the `CLAUDE.md` "ralph-loop" semantics.
- **Files**: `web/app/api/runs/[id]/abandon/route.ts`, `web/lib/task-retry.ts` (helper for retry-cycle logic + `attempt_number` increment with UNIQUE constraint).
- **Tests**: integration test: launch → abandon → assert task back in Backlog with `attempt_number = 2`; launch again → assert new run with `attempt_number = 2`.

#### Workstream C Commit Checkpoint

`feat(runs): M11 — diff view + merge-to-main + abandon + retry loop`. Merge to main.

### Phase 3 Merge Gate

All three workstreams merge. Tag `poc-phase-3-done`. Run `/aif-docs`.

---

## Phase 4 — HITL hybrid + Stability (2 parallel workstreams, ~3-5 days)

**Goal**: complete HITL UX (M10) and add reconciliation + GC (M12).

### Workstream A — M10: HITL hybrid surface

Branch: `feature/m10-hitl-hybrid`.

#### Task 4.A.1 — In-card HITL form widget

- **Deliverable**: `web/components/hitl-form.tsx` — renders a form from a JSON Schema (use `@rjsf/core` + HeroUI bindings, or hand-roll a simple renderer covering string/number/boolean/enum/array — POC scope only needs these). Validates via `zod` derived from the schema. On submit → server action `submitHitlResponse({ runId, stepId, value })` → atomic write `input-<step-id>.json` → supervisor `POST /sessions/:id/input` (delivers ACP message if live, respawns with `--resume` if checkpointed per Phase 3 Workstream A).
- **Files**: `web/components/hitl-form.tsx`, `web/app/api/runs/[id]/hitl-response/route.ts`, `web/app/projects/[slug]/actions.ts` (extended with `submitHitlResponse`).
- **Logging**: every submission logs at INFO with `runId, stepId, response-shape` (NOT response values — they may contain secrets).
- **Tests**: Playwright spec: create a Flow with a `human` step → launch → fill HITL form → assert state machine transitions correctly.

#### Task 4.A.2 — Inbox block on the project board

- **Deliverable**: dedicated panel beside the Board listing all pending `hitl_requests` for the project (across all runs). Each row links to the run detail page (anchor-jumps to the form). Inbox refreshes on SSE event.
- **Files**: `web/components/inbox-block.tsx`, `web/app/projects/[slug]/page.tsx` (integrated).
- **Tests**: Playwright spec asserts a `NeedsInput` run shows up in the Inbox.

#### Task 4.A.3 — "Needs you (N)" badge on portfolio home + navbar

- **Deliverable**: count of `NeedsInput | NeedsInputIdle` rows across all projects. Server-rendered count, refreshed every 60s via a tiny client-side fetch (no need for SSE here — the count is low-frequency).
- **Files**: `web/components/needs-you-badge.tsx`, `web/components/navbar.tsx` (extended), `web/app/page.tsx` (extended).

#### Task 4.A.4 — `human` step type with send-back-with-comments + `goto_step`

- **Deliverable**: extends `lib/flow-runner.ts` from Task 2.B.3. A `human` step's HITL form has a "Reject with comments" button. On reject: writes `comments_var` to the flow's run-scoped vars + jumps execution to `goto_step`. The agent step that `goto_step` points to (typically a planner step) sees `{{ review_comments }}` in its template and re-runs.
- **Files**: `web/lib/flow-runner.ts` (extended), tests.

#### Workstream A Commit Checkpoint

`feat(hitl): M10 — HITL hybrid surface (form, Inbox, badge, human step)`. Merge to main.

### Workstream B — M12: Reconciliation + GC

Branch: `feature/m12-reconcile-gc`.

#### Task 4.B.1 — Startup reconciliation

- **Deliverable**: `web/lib/reconcile.ts` — runs once on Next.js startup (called from `app/layout.tsx` or `instrumentation.ts`). For each project: list `runs` rows with status `Running | NeedsInput | NeedsInputIdle`, cross-reference with `git worktree list` AND supervisor's live session set (`GET /sessions` — new lightweight route on supervisor). Decision tree:
  - Row says `Running`, supervisor reports session alive → no change.
  - Row says `Running`, supervisor reports session dead, no `acp_session_id` checkpoint → `Crashed`. UI surfaces "Recover or discard".
  - Row says `Running`, supervisor reports session dead, `acp_session_id` valid → `NeedsInputIdle`. Stays valid; user can resume.
  - Row says `NeedsInputIdle`, `acp_session_id` valid → stays valid.
  - Row says `NeedsInputIdle` with TTL expired (24h since `checkpoint_at`) → `Abandoned`.
- **Files**: `web/lib/reconcile.ts`, `web/instrumentation.ts` (calls reconcile on boot), `supervisor/src/http-api.ts` (extends with `GET /sessions` — return live session IDs).
- **Logging**: every decision logs at INFO with the input row + decision. Full reconciliation timing logged at INFO at the end.
- **Tests**: unit tests for the decision tree (table-driven); integration test boots a fake supervisor + DB + worktree fixture and asserts every row lands in the right state.

#### Task 4.B.2 — Cron GC route

- **Deliverable**: `web/app/api/cron/gc/route.ts` — `GET`. Removes worktrees + checkpointed sessions older than 7d across all projects. Removes `Abandoned | Done` worktrees first; then prunes `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl` files older than 7d that no `acp_session_id` references. Idempotent. Intended to be called by an external cron (no internal scheduler — out of POC scope).
- **Files**: `web/app/api/cron/gc/route.ts`, `web/lib/gc.ts`.
- **Logging**: every deletion logs at INFO with `kind (worktree|session), path, age`. Total summary logged at INFO.
- **Tests**: integration test seeds aged + fresh artifacts; assert only aged ones are removed.

#### Task 4.B.3 — "Recover or discard" UI for Crashed runs

- **Deliverable**: action buttons on `app/runs/[id]/page.tsx` shown only when status is `Crashed`. Recover → `POST /api/runs/[id]/recover` → if `acp_session_id` present, supervisor `POST /sessions` with `resumeSessionId`; else fail-soft with "checkpoint missing, only discard available". Discard → marks worktree stale + task back to Backlog.
- **Files**: `web/app/api/runs/[id]/recover/route.ts`, `web/app/runs/[id]/components/recover-actions.tsx`.
- **Tests**: Playwright spec.

#### Workstream B Commit Checkpoint

`feat(runs): M12 — startup reconciliation + GC cron + Crashed recovery`. Merge to main.

### Phase 4 Merge Gate

Both workstreams merge. Tag `poc-phase-4-done` (= **technical POC complete**). Run `/aif-docs`. Run `/aif-security-checklist`. Run `/aif-qa` for an end-to-end test plan.

---

## Phase 5 — Validation (sequential, ~7-21 days)

**Goal**: validate the POC against the success criteria in `CLAUDE.md`.

### Task 5.1 — M13a: Dogfood

- **Deliverable**: register the MAIster repo in itself (it now has its own `maister.yaml` v2 with the `aif` Flow plugin pinned to a tag). Create a real backlog task on the project board. Launch via the `aif` Flow. Ship ≥1 non-trivial PR through MAIster end-to-end. Document the experience in `docs/dogfood-log.md`.
- **Files**: `maister.yaml` (root of repo), `docs/dogfood-log.md`.
- **Logging**: capture cost (token spend) per PR shipped via dogfood — useful baseline for the M0 cost finding (~$0.28/respawn).
- **Acceptance**: 1 PR shipped end-to-end; retry-loop exercised at least once (intentionally trigger a `Failed` run and re-launch).

### Task 5.2 — M13b: External validation

- **Deliverable**: 3 installations on external repos. Each ships ≥1 PR end-to-end through MAIster. Capture cost + UX feedback per install. Maintain `docs/external-validation-log.md`.
- **Acceptance**: 3/3 = thesis validated; 2/3 = re-assess; ≤1/3 = thesis not validated, reassess wedge (per `CLAUDE.md`).

### Phase 5 Commit Checkpoint

After Tasks 5.1 + 5.2: tag `poc-validation-done`. Run `/aif-review` over the whole branch history. Run `/aif-docs` for the final README polish.

---

## Cross-Cutting Concerns (apply at every phase)

These are NOT separate tasks — they are constraints every task above must respect.

1. **Server-only modules stay in `lib/`** (per ARCHITECTURE §"Dependency Rules"). Every `lib/*` file gets `"server-only"` import at the top. No Client Component imports `lib/`.
2. **Atomic writes everywhere** for `.maister/` artifacts — `atomicWriteJson` from `lib/atomic.ts`. Never `fs.writeFile` direct.
3. **Typed errors only** — `MaisterError` with `code` for known domain failures. UI branches on `code`, never string-matches.
4. **No `fs.watch` / `chokidar` / polling** for state transitions. ACP notifications on the live path, artifact presence on the recovery path.
5. **Secrets server-side only** — `ANTHROPIC_AUTH_TOKEN`, etc., never logged, never streamed, never embedded in ACP `session/update` payloads visible to the browser.
6. **i18n every visible string** — `t('key')` from day one. RU translations required (no English-only milestone per `CLAUDE.md`).
7. **No POC scope creep** — out-of-POC list in `CLAUDE.md` is binding. Push back with "out of POC scope" if a task drifts.
8. **Surgical changes** — every changed line traces to a task in this plan. No "while-you're-there" refactors.

## Commit Plan (high-level)

| Commit | Phase | Branches merged | Tag |
|---|---|---|---|
| `feat: M1+M2 foundation — schema, errors, atomic, config, test infra` | Phase 0 | `feature/poc-foundation` | `poc-phase-0-done` |
| `feat(supervisor): M3 — daemon` | Phase 1 / A | `feature/m3-supervisor` | — |
| `feat(flows): M4 — plugin loader` | Phase 1 / B | `feature/m4-flow-plugin-loader` | — |
| `feat(executors): M6 — registry + CCR` | Phase 1 / C | `feature/m6-executor-registry` | `poc-phase-1-done` (after all 3) |
| `feat(acp): M7 — ACP client + SSE bridge` | Phase 2 / A | `feature/m7-acp-sse-bridge` | — |
| `feat(flows): M5 — Flow DSL` | Phase 2 / B | `feature/m5-flow-dsl` | — |
| `feat(web): M9-partial — UI skeleton + i18n + registry` | Phase 2 / C | `feature/m9p-web-ui-skeleton` | `poc-phase-2-done` |
| `feat(runs): M8 — worker lifecycle` | Phase 3 / A | `feature/m8-worker-lifecycle` | — |
| `feat(web): M9-rest — Portfolio + Board` | Phase 3 / B | `feature/m9r-portfolio-board` | — |
| `feat(runs): M11 — diff + merge + retry` | Phase 3 / C | `feature/m11-diff-merge` | `poc-phase-3-done` |
| `feat(hitl): M10 — HITL hybrid` | Phase 4 / A | `feature/m10-hitl-hybrid` | — |
| `feat(runs): M12 — reconcile + GC` | Phase 4 / B | `feature/m12-reconcile-gc` | `poc-phase-4-done` (= technical POC done) |
| `docs: M13 — dogfood + external validation logs` | Phase 5 | — | `poc-validation-done` |

Each commit checkpoint also runs `/aif-docs` (mandatory docs policy) before merging.

## Recommended Next Actions

1. **Generate a deep sub-plan for Phase 0** (the foundation). Run:
   ```
   /aif-plan full M1+M2 foundation — DB schema, MaisterError taxonomy, atomic writes, config v2, test infra
   ```
   This creates `feature/poc-foundation` branch + a per-milestone plan with file-level tasks ready for `/aif-implement`.

2. **Start dispatching parallel work** once Phase 0 lands. Each Phase 1 workstream is a separate `/aif-plan full` call against its own branch.

3. **Re-read this plan at every phase boundary** — it stays the coordination spine. If reality diverges from the order here (e.g. M5 turns out harder than M7), update this file before proceeding.

## Resolved Decisions (2026-05-25 user pass)

- **ACP live-input message shape**: use the live ACP path if `@agentclientprotocol/sdk@0.22.1` exposes a user-input message shape — fall back to the artifact path only when the worker doesn't ack within the keep-alive window AND the session is still live. Determined per-call, not per-deployment. Validate the SDK surface during M3 (Task 2.A.2 / 2.B.2).
- **CCR lifecycle**: one CCR process per executor that declares `router: ccr` (Claude is launched through CCR — co-locating gives clean process isolation per route). One shared `~/.config/claude-code-router/config.json` per host is fine and recommended (single source of truth for provider routes). Supervisor manages spawn/lifecycle in `supervisor/src/ccr.ts` (Task 1.C.2).
- **`needs-input.json` schema versioning**: include `schemaVersion` field in every Flow plugin's `form_schema`. On version mismatch at runtime → throw `MaisterError({code: 'CONFIG'})`. UI surfaces "Form schema upgraded — this stale request cannot be answered. Abandon this run and re-launch the task." Since task ↔ run is 1:N with auto-return to Backlog on `Abandoned`, the user simply re-launches against the upgraded Flow tag. No migration logic on POC.
- **Branch naming**: `<branch_prefix><task-slug>` only — no attempt-number suffix. The `runs.attempt_number` column tracks retries in the DB; the branch is reused across attempts because the prior attempt's worktree is removed (`Abandoned/Failed/Crashed` → worktree GC'd) before the next Launch click. Worktree path includes the run ID to avoid mid-cycle collision (`.maister/<slug>/runs/<run-id>/`).
- **Pre-commit hook framework**: `pre-commit` (https://pre-commit.com). Broader plugin ecosystem, well-known to external contributors during validation phase. `.pre-commit-config.yaml` lands in Phase 0 Workstream T.
- **Russian translations**: machine translation is sufficient for POC + dogfood. Manual review optional; defer until external validation if a real RU-speaking user trips over a string.
