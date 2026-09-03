# Implementation Plan: M6 — Executor Registry: claude + codex + CCR

> **Obsolete historical plan:** The managed CCR/router-sidecar component
> described here was removed by
> [ADR-164](../../docs/decisions/adr-164.md). Do not implement or restore this
> plan.

Branch: feature/m6-executor-registry
Created: 2026-05-27

## Settings

- Testing: yes — unit (override-chain resolver, upsert helper, CCR manager state machine, spawn env-injection precedence, CCR config presence guard) + integration (postgres testcontainer for upsert + per-flow override persistence; supervisor lifecycle integration with a stubbed CCR binary that mocks `ccr start` over a transient HTTP port)
- Logging: verbose — pino `name: "executors"` (web upsert helper), `name: "api-runs"` (chain expansion, already exists), `name: "ccr-manager"` (supervisor lifecycle), `name: "spawn"` (existing — extend with `routerInjected: boolean` field). INFO per CCR lifecycle transition (start, ready, shutdown), DEBUG per env-merge decision, WARN on health-check retry, ERROR via `MaisterError`/`SupervisorError` only. Token values, API keys, env values NEVER logged — only `hasEnv: boolean` and `routerInjected: boolean`
- Docs: yes — mandatory docs checkpoint at completion (update `docs/system-analytics/executors.md` for 5-level override chain + CCR lifecycle, update `docs/configuration.md` for `router: ccr` example with the new auto-env contract, update `docs/getting-started.md` for CCR setup, mark M6 `[x]` in `.ai-factory/ROADMAP.md`)

## Roadmap Linkage

Milestone: "M6. Executor registry: claude + codex + CCR"
Rationale: Directly implements the next unimplemented milestone in `.ai-factory/ROADMAP.md`. Most of the executor surface already shipped under M1 (DB schema), M2 (config v2 + zod validation), and M5 (4-level override chain + spawn dispatch + codex parity). M6 closes the three real gaps: (a) bundle and supervisor-own the CCR daemon so `router: ccr` works out-of-the-box rather than as a documented external dep; (b) persist `maister.yaml flows[].executor_override` to a new `flows.executorOverrideId` column so the docs/code drift in the override chain is closed; (c) ship a `upsertExecutorsFromConfig()` helper to replace the scattered ad-hoc inserts in seed.ts and the integration tests, laying the groundwork for M9's project-registration UI without committing to the UI yet.

## Research Context

Source: code exploration of `/repos/mAIster` on 2026-05-27 (no `.ai-factory/RESEARCH.md` Active Summary present) plus an upstream-doc fetch of `@musistudio/claude-code-router@2.0.0`.

Goal: take the M6 milestone from "schema + types exist, runtime is partial" to "all four `{agent, model, env, router}` axes work end-to-end, including `router: ccr` with a supervisor-managed daemon and the spec-aligned 5-level override chain validated by tests."

Constraints carried over from existing M0–M5 work:

- All `web/lib/*.ts` open with `import "server-only";` — new `web/lib/executors.ts` MUST follow.
- Pino logger naming: `const log = pino({ name: "<concern>" })`. New `name: "executors"` (web), `name: "ccr-manager"` (supervisor); existing `name: "spawn"` extends, does not get renamed.
- Error pattern: wrap every domain failure as `new MaisterError(<code>, message, { cause: asError(err) })` on web side, `new SupervisorError(<code>, …)` on supervisor side. No new error codes — `EXECUTOR_UNAVAILABLE` (existing) covers CCR-not-reachable, CCR-config-missing, and unknown-executor-id. `CONFIG` covers maister.yaml-side problems (already used by `loadProjectConfig`).
- DB schema additive only: M6 adds one column (`flows.executor_override_id`, nullable FK → executors). No table renames, no destructive migrations. Migration goes under `web/lib/db/migrations/0002_*.sql` via `pnpm --filter @maister/web drizzle:generate`.
- Existing `tasks.executorOverrideId` (M1) stays. The 5-level chain is a superset of the 4-level docs spec — task override slots between launcher and per-flow override since per-task is strictly more specific than per-flow.
- M5 spawn surface is canonical: `supervisor/src/spawn.ts:68-71` builds `childEnv = { ...process.env, ...executor.env }`. M6 inserts a CCR-derived env layer BETWEEN `process.env` and `executor.env` so `executor.env` keeps its "wins on conflict" semantics from `docs/system-analytics/executors.md:88`.
- Override resolver lives in one place: `web/app/api/runs/route.ts:70-90` `resolveExecutor()`. Tests live in a new `web/app/api/runs/__tests__/route.test.ts` (does not currently exist) and the existing `web/lib/flows/__tests__/runner.integration.test.ts` for end-to-end.
- M5 `installFlowPlugin()` (`web/lib/flows.ts:433-458`) writes `flows.recommendedExecutorId` from the manifest. M6 must NOT touch that path — the per-flow override comes from the *project* side (`maister.yaml flows[].executor_override`), not the *flow* side (`flow.yaml recommended_executor`), and the two values live in two different columns on the same row. Both can be set simultaneously and they obey different precedence rules.
- `loadProjectConfig()` already validates that `flows[].executor_override` references a registered executor id (`web/lib/config.ts:109-114`). The validation stays; M6 just persists the value.
- Supervisor entry point is `supervisor/src/index.ts` (the `pnpm --filter @maister/supervisor start` target). The CCR manager registers its shutdown hook on `process.on("SIGTERM"/"SIGINT")` from there. The manager is a singleton instantiated at module load; HTTP routes import the singleton. No per-request wiring.
- CCR (`@musistudio/claude-code-router@2.0.0`, MIT) is a Node-only npm package — no native binaries, no platform-specific install. Its CLI binary is `ccr`; `pnpm exec ccr start` works as long as the dep is installed in the supervisor workspace package. The daemon listens on `127.0.0.1:3456` by default; the port is configurable via `~/.claude-code-router/config.json`. MAIster does NOT generate or own that config file — it stays user-managed; if the file is missing or malformed CCR fails to start, and the supervisor surfaces it as `EXECUTOR_UNAVAILABLE` with a docs pointer.
- CCR is **pinned to exactly `2.0.0`** in `supervisor/package.json` (no caret, no tilde). The pnpm lockfile already records the resolved tarball integrity hash, so SemVer-by-shasum is achieved via the lockfile rather than a manual shasum field. Future upgrades go through an explicit dep bump + lockfile review.
- CCR **port is read from `~/.claude-code-router/config.json`** (the same file that holds provider keys). The manager parses the JSON, reads the configured host+port (CCR's own schema, e.g. `HOST` / `PORT` keys or whatever upstream documents), and falls back to `127.0.0.1:3456` only if those keys are missing entirely. MAIster does NOT introduce an extra env-var port override — the only env hatch is `MAISTER_CCR_CONFIG_PATH` for pointing the parser at a fixture during tests. Treat the config file as the single source of truth.
- The two ACP adapter binaries (`claude-agent-acp`, `codex-acp`) are already declared as supervisor deps. CCR slots in alongside them: adding `@musistudio/claude-code-router@2.0.0` to `supervisor/package.json` makes the `ccr` binary discoverable via the workspace bin path. The supervisor spawns `ccr start` exactly the same way it spawns the adapters — `child_process.spawn`, stdio piped, pid tracked.
- pnpm workspace already promoted to repo root (M3). New supervisor dep flows through the root lockfile.

Decisions:

- **5-level override chain (spec-superset)**:
  ```
  1. Run launcher override        (body.executorOverrideId on POST /api/runs)
  2. Task override                (tasks.executorOverrideId — kept from M5)
  3. Project per-flow override    (flows.executorOverrideId — NEW, from maister.yaml flows[].executor_override)
  4. Project default              (projects.defaultExecutorId)
  5. Flow recommended             (flows.recommendedExecutorId — from flow.yaml recommended_executor)
  ```
  Highest tier wins. Confirmed ordering choice: task > flow override (per-task choice wins; per-flow override acts as a smart default for tasks of that flow). The chain in `resolveExecutor()` extends by exactly one nullish-coalesce step inserted between `task.executorOverrideId` and `project.defaultExecutorId`. Tests cover all 5 levels firing in isolation and the conflict cases where multiple levels resolve to different executors.

- **Resolver lives in `web/lib/executors.ts`, callable with or without the launcher tier (UI-prep)**:
  Move `resolveExecutor()` out of `web/app/api/runs/route.ts` and into the new `web/lib/executors.ts` module alongside `upsertExecutorsFromConfig()`. Same signature, but the `override` arg is the dedicated *launcher* tier — passing `undefined` is the "what executor would this task get if I clicked Launch right now" path. This is the foundation for the M9 task-card "computed executor" display: the UI calls `resolveExecutor({ override: undefined, task, project, flow })` to render the badge and lets the user fill in `override` at Launch time. M6 does not ship the UI — it ships the contract. `POST /api/runs` becomes a one-liner that imports and calls the helper.

- **CCR lifecycle ownership — supervisor singleton, lazy start, graceful shutdown**:
  - `supervisor/src/ccr-manager.ts` exports a singleton `ccrManager` with three public methods:
    - `ensureRunning(): Promise<void>` — idempotent. State machine: `idle → starting → ready` or `idle → starting → failed`. Concurrent callers await the same `starting` promise. On `failed`, the next caller retries (no permanent latch — transient failures should be recoverable).
    - `getProxyUrl(): string` — returns `http://<host>:<port>` using the host+port parsed from `~/.claude-code-router/config.json`; throws `SupervisorError("EXECUTOR_UNAVAILABLE")` if state is not `ready`.
    - `shutdown(opts?: { signal?: NodeJS.Signals; timeoutMs?: number }): Promise<void>` — SIGTERM → 5s grace → SIGKILL. Idempotent.
  - The manager spawns `ccr start` via `child_process.spawn` with the supervisor's own env (CCR reads its API keys from its own config file, not env). stdout/stderr go to pino at DEBUG; the process is detached=false (dies with supervisor).
  - Config parsing: before `spawn`, `fs.readFile(configPath, "utf8")` + `JSON.parse`. Extract host+port via the documented CCR config schema (look up the actual keys in upstream docs during T10 — likely `HOST`/`PORT` or nested under a `server` block). Defaults: `host="127.0.0.1"`, `port=3456` when the keys are absent but the file itself is present and valid JSON. Malformed JSON → `SupervisorError("EXECUTOR_UNAVAILABLE", "CCR config malformed at <path>: <reason>")`.
  - Health check: after spawn, poll `GET http://<host>:<port>/` (or whatever endpoint CCR exposes — if none, fall back to a TCP connect to the port) with exponential backoff up to 10 seconds. If the daemon never responds, state → `failed`, surface as `SupervisorError("EXECUTOR_UNAVAILABLE")`.
  - Shutdown hook: `supervisor/src/index.ts` registers `process.on("SIGTERM"/"SIGINT", () => ccrManager.shutdown())` exactly once on module load. The HTTP server's existing shutdown path awaits the manager's shutdown before exiting.

- **CCR config-missing precondition guard**:
  - Before calling `ensureRunning()`, check `fs.access(homedir() + "/.claude-code-router/config.json", fs.constants.R_OK)`. If missing, throw `SupervisorError("EXECUTOR_UNAVAILABLE", "CCR config not found at ~/.claude-code-router/config.json — see docs/system-analytics/executors.md#ccr-setup")` immediately. Avoids the slower "spawn CCR → wait for crash → surface error" path and gives the user a clear actionable message.
  - The env-var escape hatch `MAISTER_CCR_CONFIG_PATH` lets tests point at a fixture config instead of `~/.claude-code-router/`.

- **Auto-env injection precedence at spawn time**:
  - `spawn.ts` is the only place that reads `executor.router`. When `router === "ccr"`:
    1. `await ccrManager.ensureRunning()` first (will throw `EXECUTOR_UNAVAILABLE` if CCR fails to come up). Confirmed ordering: ensureRunning resolves BEFORE the token presence check. Rationale: a missing token on a healthy CCR daemon is a per-executor configuration error, not a CCR infrastructure error; running ensureRunning first means the daemon is started exactly once per supervisor process even when many sessions have token problems, and the daemon's startup cost is amortized across all subsequent valid spawns.
    2. Resolve `authToken = request.executor.env?.ANTHROPIC_AUTH_TOKEN ?? process.env.MAISTER_CCR_AUTH_TOKEN`. Empty/undefined → throw `SupervisorError("EXECUTOR_UNAVAILABLE", "ANTHROPIC_AUTH_TOKEN missing for router=ccr executor; set MAISTER_CCR_AUTH_TOKEN or put it in executor.env")`. (CCR currently accepts any non-empty token because routing decisions are config-driven, not auth-driven, but the adapter needs a non-empty value to start.)
    3. Compute `ccrEnv = { ANTHROPIC_BASE_URL: ccrManager.getProxyUrl(), ANTHROPIC_AUTH_TOKEN: authToken }`.
    4. `childEnv = { ...process.env, ...ccrEnv, ...(request.executor.env ?? {}) }` — explicit user-supplied `executor.env` still wins, matching the documented precedence rule.
    5. Log `routerInjected: "ccr"` alongside the existing `hasEnv: boolean` for spawn telemetry. Token value MUST NOT appear in logs (verified by an assertion in `spawn.test.ts`).
  - When `router` is unset, the spawn path is byte-identical to today's M5 behavior. No behavior change for env-router or direct-API executors.

- **`upsertExecutorsFromConfig()` helper (web)**:
  - New `web/lib/executors.ts` module. Single exported function:
    ```
    upsertExecutorsFromConfig(args: {
      projectId: string;
      config: MaisterYamlV2;
      db?: DbClient;
    }): Promise<{ executorIdByRef: Record<string, string>; defaultExecutorId: string }>
    ```
  - Walks `config.executors[]`, inserts/updates one row per executor (UNIQUE on `(projectId, executorRefId)` already enforces idempotence — use `onConflictDoUpdate`). Returns a map from `maister.yaml` `executor.id` (the user-facing ref) to the DB row PK, plus the resolved `defaultExecutorId` for setting on the `projects` row. Caller is responsible for updating `projects.defaultExecutorId`.
  - Walks `config.flows[]`, for each entry that has `executor_override` set, updates the corresponding `flows.executorOverrideId` (resolved through the ref→row map). When `executor_override` is undefined, the column stays null. The function is idempotent and safe to re-run on config changes.
  - Atomicity: the whole operation runs in a single DB transaction. Partial failure leaves the executors table unchanged.
  - Callers in M6: replace ad-hoc inserts in `web/scripts/seed.ts` and `web/lib/__tests__/foundation.integration.test.ts`. M9 will be the third caller (project registration UI), but that wiring is out of M6 scope.

- **`installFlowPlugin()` does NOT take an `executorOverrideId` arg**. The plugin install path is "given a flow source URL and tag, materialize and register the flow." Per-flow project-side overrides come from a different config source (`maister.yaml`, parsed by `loadProjectConfig`) and are written by a different code path (`upsertExecutorsFromConfig`). Mixing the two would conflate the flow's manifest data with the project's preference and would force every `installFlowPlugin` test to thread an unrelated argument. Keep them separate; both write to the same `flows` row but on different columns, in different transactions, in defined order: install first (writes `recommendedExecutorId`), then `upsertExecutorsFromConfig` (writes `executorOverrideId`).

- **Test strategy for CCR lifecycle**: cannot depend on the real `ccr` binary in CI (would require network + provider keys + extra install). Build a tiny **stub CCR binary** at `supervisor/src/__tests__/_fixtures/mock-ccr.mjs` that listens on a transient port (`net.createServer().listen(0)`), responds 200 to `GET /`, and exits cleanly on SIGTERM. The CCR manager accepts a `binaryOverride` parameter (the same shape `spawn.ts` already uses for the adapter binary) so the integration test injects `mock-ccr.mjs`. The unit test mocks `child_process.spawn` directly.

- **No supervisor wire change**. `POST /sessions` body shape stays exactly as M5 left it. The CCR auto-env happens inside `spawn.ts`, transparent to web. The supervisor-client (`web/lib/supervisor-client.ts:14-19`) already includes `router?: "ccr"` in `SupervisorExecutorInput` — the web tier was passing that field through to no effect since M5; M6 makes it load-bearing.

- **POC = no rate-limit / quota tracking around CCR**. We rely on CCR's own provider-side limits + the global `MAISTER_MAX_CONCURRENT_RUNS=3` cap (M5). If a user routes 3 concurrent sessions through CCR to a free-tier provider, the burden is on them. Phase 2 may add per-executor concurrency caps.

Open questions: none blocking M6 start. Three settled clarifications from the user (2026-05-27): (a) CCR port is read from `~/.claude-code-router/config.json` (not an env hatch); (b) `@musistudio/claude-code-router` is pinned to exact `2.0.0` with lockfile-integrity providing shasum; (c) override chain ordering is `task > flow override` — per-task choice wins over per-flow rule. One open housekeeping note carried from M5: real public CCR provider examples (z.ai GLM, OpenRouter) should land in `docs/configuration.md` with copy-pasteable `~/.claude-code-router/config.json` snippets — included as a docs task, but vendor-key values are placeholders.

## Commit Plan

24 tasks across 6 phases — 6 commit checkpoints:

- **Commit 1** (after tasks 1–5): `chore(executors,flows): add flows.executor_override_id column + upsertExecutorsFromConfig helper`
- **Commit 2** (after tasks 6–8): `feat(api-runs): 5-level executor override chain (launcher > task > flow override > project default > flow recommended)`
- **Commit 3** (after tasks 9–13): `feat(supervisor): bundle @musistudio/claude-code-router + supervisor-managed CCR daemon lifecycle`
- **Commit 4** (after tasks 14–16): `feat(supervisor): auto-inject ANTHROPIC_BASE_URL + token for router=ccr executors at spawn time`
- **Commit 5** (after tasks 17–19): `feat(supervisor): EXECUTOR_UNAVAILABLE on CCR config-missing / health-check failure`
- **Commit 6** (after tasks 20–24): `docs(executors,ccr,architecture,getting-started): document 5-level chain + CCR lifecycle + container/component diagrams; mark M6 done`

## Tasks

### Phase 1: DB schema + config wiring

- [x] **Task 1: Drizzle migration — add `flows.executor_override_id` FK column**
  - Files: `web/lib/db/schema.ts` (extend `flows` table), `web/lib/db/migrations/0002_*.sql` (generated)
  - Add nullable column `executorOverrideId: text("executor_override_id").references(() => executors.id, { onDelete: "set null" })` to the `flows` table.
  - `onDelete: "set null"` (not cascade) — deleting an executor row should not delete the flow row; the override just becomes null and falls back to the next level of the chain.
  - Generate the migration via `pnpm --filter @maister/web drizzle:generate`. Hand-verify it is additive only (no `DROP`, no `ALTER COLUMN … NOT NULL`).
  - Logging: n/a.
  - Acceptance: existing integration tests still pass; new column visible in a fresh `migrate(db)` against the testcontainer; column is nullable in the resulting schema.

- [x] **Task 2: New `web/lib/executors.ts` module skeleton + `upsertExecutorsFromConfig()`**
  - Files: `web/lib/executors.ts` (NEW)
  - Open with `import "server-only";`. Pino logger `const log = pino({ name: "executors", level: process.env.LOG_LEVEL ?? "info" })`.
  - Export `upsertExecutorsFromConfig(args: { projectId: string; config: MaisterYamlV2; db?: any }): Promise<{ executorIdByRef: Record<string, string>; defaultExecutorId: string }>`.
  - Implementation walks `args.config.executors`, computes a deterministic `id` per executor (`randomUUID()` if no existing row, reuse existing PK on update via `onConflictDoUpdate`), inserts/updates rows. Maps `executor.id` (the user-facing ref) → row PK.
  - Walks `args.config.flows`, when `flow.executor_override` is set, updates the matching `flows` row's `executorOverrideId` to the resolved PK.
  - Wraps everything in a single `db.transaction` for atomicity.
  - Returns the ref→PK map and the resolved `defaultExecutorId` (the PK that matches `config.default_executor`).
  - Logging: INFO `{projectId, executorCount, flowOverrideCount}` per call; DEBUG per row upserted with `{executorRefId, agent, model, hasEnv, router}` — NEVER log env values.
  - Acceptance: covered by Task 5 tests.

- [x] **Task 3: `upsertExecutorsFromConfig()` cross-table flow override persistence**
  - Files: `web/lib/executors.ts` (same file, inside the same function)
  - For each `flow` in `args.config.flows`, look up the matching `flows` row by `(projectId, flowRefId)` UNIQUE. Update its `executorOverrideId` column.
  - Edge case: the `flows` row may not yet exist when `upsertExecutorsFromConfig()` runs — that's fine, the update affects zero rows and the eventual `installFlowPlugin()` call writes the row with `executorOverrideId` set if it can read the ref→PK map. Decision for M6: the helper signature already returns the ref→PK map; M6 leaves the post-install override write to a follow-up because `installFlowPlugin` runs before project config is fully persisted in the M9 wiring. For M6 the helper writes overrides only for flows that already exist. Document this in the helper's JSDoc.
  - Logging: WARN per `flow.executor_override` that targets a not-yet-installed flow id (no-op update); DEBUG per successful update.
  - Acceptance: covered by Task 5 tests.

- [x] **Task 4: Replace ad-hoc executor inserts in seed + tests**
  - Files: `web/scripts/seed.ts`, `web/lib/__tests__/foundation.integration.test.ts`
  - In both files, replace the hand-written `db.insert(executors)…` loops with a single `await upsertExecutorsFromConfig({ projectId, config, db })` call after the project row is created.
  - The foundation test currently asserts on the executor row shape — keep the assertions, just change the producer.
  - Verify both still pass: `pnpm --filter @maister/web test integration` and seeding via `pnpm --filter @maister/web seed`.
  - Logging: n/a (helper logs).
  - Acceptance: zero regressions in `foundation.integration.test.ts`; seed script still produces the same DB state.

- [x] **Task 5: Unit + integration tests for `upsertExecutorsFromConfig()`**
  - Files: `web/lib/__tests__/executors.test.ts` (NEW), `web/lib/__tests__/executors.integration.test.ts` (NEW)
  - Unit cases (mock db):
    - Empty `executors[]` → throws `CONFIG` (defensive — config schema already rejects this, but the helper should not silently succeed on an invalid input).
    - Single claude executor → one upsert call, returned map has one entry, `defaultExecutorId` resolves.
    - Two executors with `flow.executor_override` referencing one of them → executor upserts + one flow row update.
    - `router: "ccr"` on an executor → row contains the router value; env is preserved as-is (no validation of CCR config at this layer — that's spawn-time).
  - Integration cases (testcontainer postgres):
    - Re-running the helper with the same config is idempotent (PKs stable).
    - Re-running with a changed `model` for an existing `executor_ref_id` updates the row (does not create a duplicate).
    - Per-flow override survives a re-run; clearing `executor_override` in the config resets the column to null on the next run.
    - Concurrent calls for the same `projectId` serialize via the transaction (no UNIQUE constraint violations).
  - Logging: assert no token/env values appear in captured log lines (mock the logger and inspect calls).
  - Acceptance: 8+ test cases, all green.

### Phase 2: Override resolution chain expansion

- [x] **Task 6: Move `resolveExecutor()` to `web/lib/executors.ts` and extend to the 5-level chain**
  - Files: `web/lib/executors.ts` (NEW — extend the file added in T2), `web/app/api/runs/route.ts` (delete the private function, import from `@/lib/executors`)
  - Export `resolveExecutor(args: { override?: string; task: { executorOverrideId: string | null }; flow: { executorOverrideId: string | null; recommendedExecutorId: string | null }; project: { defaultExecutorId: string | null } }): { executorId: string; tier: "launcher" | "task" | "flowOverride" | "projectDefault" | "flowRecommended" }`.
  - Implementation: nullish-coalesce in order `override → task → flow override → project default → flow recommended`. Return the resolved id PLUS the tier name that fired (so callers can log telemetry and the future M9 UI can render a "computed from <tier>" badge). Throw `MaisterError("EXECUTOR_UNAVAILABLE", "no executor resolved (no launcher override, task override, flow override, project default, or flow recommendation)")` when all five are nullish.
  - The function is **pure** — no DB access, no logging side effects. Callers fetch the rows and log the tier.
  - Calling with `override: undefined` is the supported "computed executor for display" path used by future M9 UI (task card badge). Document this in the function's JSDoc.
  - `route.ts` becomes a one-liner: `const { executorId, tier } = resolveExecutor({ override: body.executorOverrideId, task, project, flow });` plus the existing INFO log line extended with `resolvedFromTier: tier`.
  - Acceptance: covered by T8 tests.

- [x] **Task 7: Surface `flows.executorOverrideId` to `resolveExecutor()` caller**
  - Files: `web/app/api/runs/route.ts` (POST handler body)
  - The `flowRows` query already returns the full flow row from M5; just confirm the new `executorOverrideId` column is in the select result. Drizzle's `db.select().from(flows)` returns all columns by default, so likely no code change needed — verify by reading the call site and adjust only if there is an explicit column projection.
  - Logging: n/a.
  - Acceptance: integration test in Task 8 passes (flow override tier fires when set and no higher tier is present).

- [x] **Task 8: Unit + integration tests for `resolveExecutor()` 5-level chain**
  - Files: `web/lib/__tests__/executors-resolver.test.ts` (NEW — pure unit, no db), `web/app/api/runs/__tests__/route.test.ts` (NEW — handler-level with mocked db), `web/lib/flows/__tests__/runner.integration.test.ts` (extend existing)
  - Pure unit cases on the helper (5 happy + 1 failure):
    - Only launcher set → returns `{executorId, tier: "launcher"}`.
    - Only task override set, no launcher → returns `{tier: "task"}`.
    - Only flow override set, no launcher/task → returns `{tier: "flowOverride"}`.
    - Only project default → `{tier: "projectDefault"}`.
    - Only flow recommended → `{tier: "flowRecommended"}`.
    - All null → throws `EXECUTOR_UNAVAILABLE` with the enumerated message.
  - Conflict cases (4) on the helper:
    - launcher + task → `tier: "launcher"`.
    - task + flow override → `tier: "task"` (confirmed ordering choice).
    - flow override + project default → `tier: "flowOverride"`.
    - project default + flow recommended → `tier: "projectDefault"`.
  - UI-prep contract case: calling with `override: undefined` and all other tiers populated → returns the deterministic "computed executor for display" result without throwing. Matches the JSDoc promise that M9's task card can call this safely.
  - Handler-level case: `POST /api/runs` body without `executorOverrideId` flows through the handler and yields `resolvedFromTier: "task"` in the INFO log when the task has an override set.
  - Integration: extend `runner.integration.test.ts` with at least one scenario where the flow-override tier fires end-to-end against postgres + the M5 mock ACP adapter. Assert spawn called with the executor id selected by `flow.executorOverrideId`.
  - Acceptance: 12+ test cases, all green.

### Phase 3: CCR bundle + supervisor-managed lifecycle

- [x] **Task 9: Add `@musistudio/claude-code-router@2.0.0` to supervisor deps (exact pin)**
  - Files: `supervisor/package.json`, repo-root `pnpm-lock.yaml` (regenerated)
  - Add to `dependencies` (NOT `devDependencies` — the bin must be on the runtime path) with the **exact** version string `"2.0.0"` (no `^`, no `~`).
  - Run `pnpm install` from the repo root with `--save-exact` (or set `save-exact=true` once if not already in repo `.npmrc`); verify the generated entry in `package.json` is the literal `"2.0.0"`, NOT `"^2.0.0"`.
  - Verify `pnpm-lock.yaml` updates AND records the tarball integrity hash (`integrity: sha512-…`) — the lockfile is the shasum pin. Commit both files together.
  - Verify license is MIT (npm metadata + the package's bundled LICENSE file). If not MIT or has a sub-dep with an incompatible license — abort and re-evaluate.
  - Verify `pnpm --filter @maister/supervisor exec ccr --help` prints help text.
  - Logging: n/a.
  - Acceptance: `pnpm install` succeeds clean; lockfile integrity hash present; bin reachable.

- [x] **Task 10: New `supervisor/src/ccr-manager.ts` singleton**
  - Files: `supervisor/src/ccr-manager.ts` (NEW)
  - Singleton with internal state machine: `"idle" | "starting" | "ready" | "failed" | "stopping"`.
  - Exports (no class export — only the singleton + types):
    ```
    export type CcrState = "idle" | "starting" | "ready" | "failed" | "stopping";
    export interface CcrManager {
      ensureRunning(opts?: { signal?: AbortSignal }): Promise<void>;
      getProxyUrl(): string;
      getState(): CcrState;
      shutdown(opts?: { signal?: NodeJS.Signals; timeoutMs?: number }): Promise<void>;
    }
    export const ccrManager: CcrManager;
    export function createCcrManager(opts?: { binaryOverride?: string; configPath?: string; logger?: Logger }): CcrManager;
    ```
  - The exported `ccrManager` is `createCcrManager()` with defaults — tests use `createCcrManager({ binaryOverride: "node", configPath: "..." })` to swap in the stub.
  - `ensureRunning()` is idempotent and concurrent-safe: state `ready` returns immediately; state `starting` returns the in-flight promise; state `idle` or `failed` initiates a new start.
  - Start sequence:
    1. Pre-flight: `fs.access(configPath, R_OK)`. Missing → `SupervisorError("EXECUTOR_UNAVAILABLE", "CCR config not found at <path> — see docs/system-analytics/executors.md#ccr-setup")`, state → `failed`.
    2. Parse CCR config: `fs.readFile(configPath, "utf8")` → `JSON.parse` → extract `host`+`port` via upstream CCR schema (resolve actual key names from CCR docs/types during implementation — likely top-level `HOST`/`PORT` or nested under `server`; document the keys read in the JSDoc). Defaults when those keys are absent but JSON is otherwise valid: `host = "127.0.0.1"`, `port = 3456`. Invalid JSON → `SupervisorError("EXECUTOR_UNAVAILABLE", "CCR config malformed at <path>: <reason>")`, state → `failed`.
    3. `spawn("ccr", ["start"], { stdio: ["ignore", "pipe", "pipe"] })`. Pipe stdout/stderr to pino at DEBUG.
    4. Health check loop: poll `http://<host>:<port>/` with backoff (100ms, 200ms, 400ms, … capped at 10s total). Success → state `ready`. Failure → `SIGTERM` the child, state `failed`, surface `SupervisorError("EXECUTOR_UNAVAILABLE", "CCR daemon failed to become ready within 10s")`.
  - `getProxyUrl()` returns `http://<host>:<port>` (using the parsed values); throws `SupervisorError("EXECUTOR_UNAVAILABLE")` if state is not `ready`.
  - `shutdown()`: state `stopping` → SIGTERM child → 5s grace → SIGKILL → state `idle`. Idempotent.
  - Config path: defaults to `path.join(os.homedir(), ".claude-code-router", "config.json")`. The only env hatch is `MAISTER_CCR_CONFIG_PATH` (for tests/fixtures). No `MAISTER_CCR_PORT` env — port is config-file-only.
  - Logging: INFO at each state transition (`ccr.starting`, `ccr.ready`, `ccr.failed`, `ccr.stopping`, `ccr.stopped`) including `{host, port}` once resolved; DEBUG per health-check attempt with `{attempt, delayMs}`; WARN on each transient health-check failure. NEVER log the parsed config content (it contains provider API keys).
  - Acceptance: covered by Task 13 tests.

- [x] **Task 11: Wire CCR shutdown hook into supervisor entry point**
  - Files: `supervisor/src/index.ts` (or whichever file boots the HTTP server — read first to confirm name)
  - Add `process.on("SIGTERM", handleShutdown)` and `process.on("SIGINT", handleShutdown)` exactly once on module load. `handleShutdown` awaits the existing HTTP server close, then `await ccrManager.shutdown({ timeoutMs: 5000 })`, then `process.exit(0)`.
  - If signal handlers are already registered for HTTP shutdown (per M3), extend them — do NOT register a second handler that would race.
  - Logging: INFO `{signal}` on shutdown start; pino flush before exit.
  - Acceptance: manual smoke — start the supervisor with `pnpm --filter @maister/supervisor dev`, send SIGTERM, confirm CCR child also exits (via `ps`); covered by Task 13 integration test (start supervisor → trigger a router=ccr spawn → SIGTERM the supervisor → assert the CCR pid no longer exists).

- [x] **Task 12: Stub CCR binary fixture for tests**
  - Files: `supervisor/src/__tests__/_fixtures/mock-ccr.mjs` (NEW), helper `supervisor/src/__tests__/_fixtures/write-ccr-config.ts` (NEW), `supervisor/package.json` (no dep change — uses Node stdlib only)
  - **mock-ccr.mjs**: minimal Node ESM script that reads `MAISTER_MOCK_CCR_PORT` env (set by the test harness — NOT MAISTER_CCR_PORT, since we don't add that env in production). Spawns `http.createServer()` on that port. `GET /` returns `200 {"ok":true}`. `process.on("SIGTERM", () => server.close(() => process.exit(0)))`. Prints `listening on <port>` to stdout.
  - **write-ccr-config.ts**: test helper that writes a temp `config.json` with `{host, port}` keys (matching CCR's actual schema as resolved in T10) to a tmpdir, returns the path. Tests pass the path via `MAISTER_CCR_CONFIG_PATH` so the manager parses the same host/port the mock listens on.
  - The mock binary path is what `createCcrManager({ binaryOverride: "node", argsOverride: [path-to-mock-ccr.mjs, "start"] })` passes to spawn. The mock reads its port from `MAISTER_MOCK_CCR_PORT`; the test harness allocates a free port, writes both the config file AND sets the env, then constructs the manager. This keeps the manager unaware of the test-only env var.
  - Logging: the mock itself uses console.log; the supervisor pipes it to pino DEBUG.
  - Acceptance: `MAISTER_MOCK_CCR_PORT=12345 node mock-ccr.mjs` prints `listening on 12345`, responds to `GET /`, exits clean on SIGTERM; write-ccr-config.ts round-trips through JSON.parse without modification.

- [x] **Task 13: Unit + integration tests for CCR manager**
  - Files: `supervisor/src/__tests__/ccr-manager.test.ts` (NEW), `supervisor/src/__tests__/ccr-manager.integration.test.ts` (NEW)
  - Unit (mock `child_process.spawn`, `fs.access`, `fs.readFile`):
    - `idle → starting → ready` happy path with a valid config file (host+port present).
    - Config file present but with missing `host`/`port` keys → defaults `127.0.0.1:3456` applied; happy path.
    - Concurrent `ensureRunning()` calls return the same promise.
    - Config missing (`fs.access` ENOENT) → state `failed` immediately, no spawn attempted, error message contains the path.
    - Config file present but malformed JSON → state `failed` immediately, no spawn attempted, error message mentions parse reason.
    - Health check times out → child SIGTERMed, state `failed`.
    - `shutdown()` on `ready` → SIGTERM observed, state `idle`.
    - `shutdown()` on `idle` → no-op, no spawn touched.
  - Integration (real Node + mock-ccr.mjs + write-ccr-config.ts from T12):
    - Manager parses the fixture config, starts the mock on the configured port, health-check succeeds, `getProxyUrl()` returns the matching `http://host:port` URL.
    - `shutdown()` actually kills the mock process (verify pid via `process.kill(pid, 0)` throws ESRCH after shutdown completes).
    - Calling `ensureRunning()` after a clean `shutdown()` restarts the daemon (state transitions `idle → starting → ready`).
    - Fixture config with a port the mock-ccr.mjs is NOT listening on → health-check times out, state `failed`.
  - Logging: assert no parsed config content (esp. provider keys / tokens) appears in captured logs. Host+port are OK to log.
  - Acceptance: 12+ test cases, all green.

### Phase 4: CCR env injection at spawn time

- [x] **Task 14: `spawn.ts` integration — auto-env on `router=ccr`**
  - Files: `supervisor/src/spawn.ts` (modify `spawnSession`)
  - Accept an optional `ccrManager` parameter on `SpawnSessionOptions` (default to importing the singleton from `./ccr-manager`). Test injection point mirrors the existing `binaryOverride` pattern.
  - Before computing `childEnv`, when `request.executor.router === "ccr"`:
    1. `await opts.ccrManager.ensureRunning()`.
    2. Resolve `authToken` from priority chain: `request.executor.env?.ANTHROPIC_AUTH_TOKEN ?? process.env.MAISTER_CCR_AUTH_TOKEN`. Empty/undefined → throw `SupervisorError("EXECUTOR_UNAVAILABLE", "ANTHROPIC_AUTH_TOKEN missing for router=ccr executor; set MAISTER_CCR_AUTH_TOKEN or put it in executor.env")`.
    3. Build `ccrEnv = { ANTHROPIC_BASE_URL: opts.ccrManager.getProxyUrl(), ANTHROPIC_AUTH_TOKEN: authToken }`.
    4. `childEnv = { ...process.env, ...ccrEnv, ...(request.executor.env ?? {}) }` — `executor.env` still wins (matches documented precedence).
  - When `router` is unset, behavior is byte-identical to the current M5 code path.
  - Logging: extend the existing `"spawn"` log line to include `routerInjected: request.executor.router ?? null` (already there as `router`; ensure it stays). Add DEBUG with `{authTokenSource: "executor.env" | "MAISTER_CCR_AUTH_TOKEN"}` — but NEVER the token value itself.
  - Acceptance: covered by Task 16 tests.

- [x] **Task 15: Token-leak assertions in `spawn.test.ts`**
  - Files: `supervisor/src/__tests__/spawn.test.ts` (extend existing)
  - Add a test that uses `router: "ccr"` with a recognizable sentinel token (e.g. `"sk-test-LEAK_DETECTOR_123"`). Capture all pino log records emitted during the spawn. Assert no log record's serialized JSON contains the sentinel string.
  - Add the same assertion to the existing `executor.env` test cases (defense in depth).
  - Acceptance: tests green; intentionally introducing `logger.info({ token })` in spawn.ts (then reverting) makes the test fail loudly.

- [x] **Task 16: Unit tests for spawn env injection precedence**
  - Files: `supervisor/src/__tests__/spawn.test.ts` (extend existing)
  - Mock `child_process.spawn` to capture the `env` arg. Mock `ccrManager` with a stub that returns a known proxy URL.
  - Cases:
    - `router: "ccr"` + no `executor.env` + `MAISTER_CCR_AUTH_TOKEN` set → child env contains `ANTHROPIC_BASE_URL=<proxy>` and `ANTHROPIC_AUTH_TOKEN=<from env>`.
    - `router: "ccr"` + `executor.env.ANTHROPIC_BASE_URL=<custom>` → child env's `ANTHROPIC_BASE_URL` is the custom value (executor.env wins).
    - `router: "ccr"` + `executor.env.ANTHROPIC_AUTH_TOKEN=<custom>` → token is the custom value, NOT from `MAISTER_CCR_AUTH_TOKEN`.
    - `router: "ccr"` + no token anywhere → throws `EXECUTOR_UNAVAILABLE` with the documented message; `ccrManager.ensureRunning` IS called first (the daemon is started; the token check happens after, per the locked ordering). Asserts the call order via a mock spy.
    - `router: undefined` → `ccrManager.ensureRunning` NOT called; no `ANTHROPIC_BASE_URL` injected unless user set it in `executor.env`.
  - Acceptance: 5 cases all green; coverage of `spawn.ts` env-merge branches at 100%.

### Phase 5: Failure modes + end-to-end CCR test

- [x] **Task 17: CCR config-missing translates to web-side EXECUTOR_UNAVAILABLE (503)**
  - Files: `web/lib/supervisor-client.ts` (verify error translation), `web/app/api/runs/route.ts` (verify status mapping)
  - The `MaisterError` taxonomy already maps `EXECUTOR_UNAVAILABLE` → 503 (`route.ts:57-58`). The `supervisor-client.ts` translation path (M3) converts `SupervisorError` body codes to `MaisterError` codes by string match.
  - Verify the translation handles `EXECUTOR_UNAVAILABLE` end-to-end: when supervisor returns `{code: "EXECUTOR_UNAVAILABLE", message: "CCR config not found…"}` 503, the web client surfaces it as `MaisterError("EXECUTOR_UNAVAILABLE")` and the Route Handler returns 503 with the same message to the browser.
  - Add the test below.
  - Logging: n/a.
  - Acceptance: Task 19 integration test asserts the full chain.

- [x] **Task 18: Health-check failure surfaces as EXECUTOR_UNAVAILABLE**
  - Files: `supervisor/src/__tests__/ccr-manager.test.ts` (extend with one more case if not already covered in Task 13)
  - Case: stub a CCR binary that spawns but never responds on port → manager times out, state `failed`, throws `SupervisorError("EXECUTOR_UNAVAILABLE", "CCR daemon failed to become ready within 10s")`. The child is SIGTERMed.
  - Acceptance: test green.

- [x] **Task 19: End-to-end integration — POST /api/runs with router=ccr, missing config**
  - Files: `web/lib/__tests__/supervisor-client.integration.test.ts` OR `web/lib/flows/__tests__/runner.integration.test.ts` (extend whichever already has the supervisor mock harness)
  - Test scenario: project has one executor with `router: "ccr"`, CCR config file is intentionally missing (point `MAISTER_CCR_CONFIG_PATH` at a tmpdir).
  - POST /api/runs → 503 with `{code: "EXECUTOR_UNAVAILABLE", message: <CCR docs pointer>}`.
  - Run row created? Decision: **no** — fail fast before worktree creation. Move the supervisor `POST /sessions` call to attempt the spawn only after the worktree commits; the failure path leaves the task in `Backlog`, worktree removed. This may already be M5's behavior (run starts as `Pending`, scheduler promotes, `runFlow` calls supervisor, supervisor errors out → run transitions to `Failed`). Verify and document the actual lifecycle.
  - Acceptance: test green; the docs pointer in the error message is correct (`docs/system-analytics/executors.md#ccr-setup`).

### Phase 6: Docs + ROADMAP

- [x] **Task 20: Update `docs/system-analytics/executors.md`**
  - Files: `docs/system-analytics/executors.md`
  - Replace the override-chain mermaid diagram (lines 67-75) with the 5-level shape (launcher → task → flow override → project default → flow recommended). Five labeled nodes, not four. Annotate the ordering choice: "per-task choice wins over per-flow rule (task tier 2 > flow override tier 3)."
  - Add a sub-section "Computed vs launched executor" right under the chain diagram: explain that the resolver is callable with `override: undefined` (tier 1 skipped) to yield the **computed** executor for a task without launching it — this is the contract the future M9 UI relies on for the task-card badge. The launched executor is whatever the chain returns at the moment `POST /api/runs` fires, including the launcher tier if the user picked one.
  - Replace the "Model routing modes" section's CCR branch with the supervisor-managed lifecycle: add a sequence diagram showing `spawn(router=ccr) → ccrManager.ensureRunning → parse-config-json → first-time-spawn-CCR → poll-health → ready → set ANTHROPIC_BASE_URL → spawn adapter`.
  - Add new `### CCR setup` subsection with: pointer to user-managed `~/.claude-code-router/config.json` (the **single source of truth** for host+port; MAIster reads it, never writes it), env-var hatches (only `MAISTER_CCR_CONFIG_PATH` for tests and `MAISTER_CCR_AUTH_TOKEN` for the adapter token), failure modes (config missing, malformed JSON, daemon won't start, health-check timeout) and how each surfaces as `EXECUTOR_UNAVAILABLE` to the UI.
  - Update the Expectations section: add bullets for the new 5-level chain (per-task > per-flow), CCR lifecycle ownership (singleton, lazy start, supervisor-owned shutdown), CCR port resolution (config.json only, no env override), CCR env injection precedence (`executor.env` still wins on key collision). Keep total ≤12 bullets per the R5a cap; consolidate or drop the lowest-value existing bullets if needed.
  - Update Edge cases: add "CCR config missing → EXECUTOR_UNAVAILABLE with docs pointer (config-time error, surfaces before spawn)", "CCR config malformed JSON → EXECUTOR_UNAVAILABLE with parse reason", "CCR daemon crashes mid-session → next spawn re-runs ensureRunning, prior session's adapter logs the connection-refused error".
  - Validate mermaid blocks via `pnpm validate:docs` (Stop hook will run automatically).
  - Acceptance: file passes the docs validator; reviewer sees the 5-level chain, computed-vs-launched note, and the new CCR setup section.

- [x] **Task 21: Update `docs/configuration.md`**
  - Files: `docs/configuration.md`
  - Find the `maister.yaml v2 → executors[]` section. Add a `router: ccr` example executor entry alongside the existing claude/codex examples. Include the `ANTHROPIC_AUTH_TOKEN` placement note (either in `executor.env` or via `MAISTER_CCR_AUTH_TOKEN`).
  - Add a `Per-flow executor_override` example under the `flows[]` section, with a comment "persisted to `flows.executor_override_id`, slots into the override chain at tier 3 (between task override and project default)".
  - Add a new `## CCR (Claude Code Router) bundling` section near the bottom: state that the dep is bundled by MAIster (no user install needed), the config file IS user-managed, and link to `docs/system-analytics/executors.md#ccr-setup` for the full failure-mode table.
  - Vendor-key examples (z.ai GLM, OpenRouter) — placeholders only; do NOT bake real keys.
  - Acceptance: file passes the docs validator.

- [x] **Task 22: Update `docs/getting-started.md`**
  - Files: `docs/getting-started.md`
  - Add a small "(Optional) CCR multi-provider routing" subsection under the existing executor setup block. Steps:
    1. Decide which providers to route through (z.ai GLM, OpenRouter, etc.).
    2. Create `~/.claude-code-router/config.json` per CCR docs (link out).
    3. Mark an executor `router: ccr` in `maister.yaml`.
    4. MAIster's supervisor starts CCR automatically on the first router=ccr spawn.
  - Note: NO need to globally install `ccr` — MAIster ships it.
  - Acceptance: file passes the docs validator; reviewer can walk through the steps end-to-end.

- [x] **Task 23: Mark M6 done in `.ai-factory/ROADMAP.md`**
  - Files: `.ai-factory/ROADMAP.md`
  - Change `- [ ] **M6. Executor registry: claude + codex + CCR**` (line 19) to `- [x] **M6. Executor registry: claude + codex + CCR**`.
  - Append a short shipped-summary in the same M5 style: branch name, date, what landed (5-level chain, CCR bundle + supervisor lifecycle, `upsertExecutorsFromConfig`, end-to-end CCR-config-missing failure surface), test count delta.
  - Add a row to the `## Completed` table at the bottom: `| M6. Executor registry: claude + codex + CCR | 2026-05-27 |` (update date to actual ship date).
  - Acceptance: roadmap reflects shipped status; `/aif-verify` roadmap gate passes.

- [x] **Task 24: Update `docs/architecture.md`** (surgical, per R9)
  - Files: `docs/architecture.md`
  - **C4 Container diagram** (around line 65-130): under the `supervisor` container, note CCR as a managed child process. Two options — either add a new internal `Container(ccr_daemon, "CCR daemon", "Node.js — @musistudio/claude-code-router@2.0.0", "Multi-provider Anthropic-API-compatible proxy. Lazy-started by the supervisor on first router=ccr session; one daemon per supervisor process.")` with `Rel(supervisor, ccr_daemon, "Spawn + health-check + SIGTERM on shutdown")`, or annotate the existing supervisor container description to mention CCR as a "managed sidecar." Pick whichever produces a cleaner diagram with ≤25 nodes per R2.
  - Update the `Rel(claude_acp, thirdparty, "Inference (env-router)", "HTTPS")` edge label at line 104 to `"Inference (env-router or CCR)"` to reflect the second routing mode now being load-bearing.
  - **C4 Component — Supervisor** (line 131-184): add a row to the component table for `ccr-manager` (`supervisor/src/ccr-manager.ts`, "CCR daemon lifecycle controller", "Lazy-start the bundled CCR proxy on demand, health-check, parse port from `~/.claude-code-router/config.json`, graceful shutdown on SIGTERM/SIGINT", "registry, spawn"). Mark **Implemented M6**.
  - Update the `spawn` row (line 179) description: append "; when `executor.router === "ccr"`, await `ccr-manager.ensureRunning()` and inject `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` into childEnv beneath the explicit `executor.env` overlay."
  - **Designed-but-not-implemented table** (line 230-251): change `lib/executors` row status from "Designed M5" to **"Implemented M6"** and update description to reflect both `upsertExecutorsFromConfig()` and the extracted pure `resolveExecutor()` helper. Update `app/api/runs/route.ts` row status if M5 actually shipped it: it did (M5), so the status should already be Implemented M5 — fix it to **"Implemented M5 (M6 extends override chain)"** if currently mislabeled "Designed M6".
  - **Data flow — happy path Launch** (line 273-314): inspect the sequence diagram; if it does not already show executor resolution + (optional) CCR start, add two arrows: `W->>W: resolveExecutor(...)` and `S->>CCR: ensureRunning() — first router=ccr session only`. Keep additions minimal.
  - Do NOT reformat unrelated tables/diagrams (R9 surgical edits).
  - Validate mermaid blocks via `pnpm validate:docs`.
  - Acceptance: file passes the docs validator; the CCR daemon is visible as a supervisor-managed child in either the Container or Component diagram; status tags for `lib/executors` and `app/api/runs/route.ts` reflect M6 reality.

## Unresolved questions

(Per /Users/developer/.claude/CLAUDE.md — end-of-plan question list in concise RU.)

- CCR порт — фиксировать 3456 или читать из `~/.claude-code-router/config.json`?
- Если `MAISTER_CCR_AUTH_TOKEN` пустой, бросать на спавне или на первой попытке ensureRunning?
- При апгрейде CCR (новая мажорная) — нужен ли pin-by-shasum в supervisor/package.json или достаточно `^2.0.0`?
- В chain `task > flow override` — действительно так логичнее, или наоборот `flow override > task`?
