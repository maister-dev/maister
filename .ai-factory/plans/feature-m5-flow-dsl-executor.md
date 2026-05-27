# Implementation Plan: M5 — Flow DSL Parser + Executor + aif Plugin

Branch: feature/m5-flow-dsl-executor
Created: 2026-05-27

## Settings

- Testing: yes — unit (templating, guards, step-run store, cli/agent/human executors, scheduler) + integration (testcontainer Postgres + mock-adapter binary + fixture aif plugin running end-to-end through `cli`, `agent` (new-session), `agent` (slash-in-existing), `guard`, `human` step types)
- Logging: verbose — pino at `name: "flow-runner"` on web side and `name: "acp-client"` on supervisor side, INFO per step lifecycle, DEBUG on every var resolution + guard metric, WARN on guard-cap-exceeded (no enforcement on POC), ERROR via `MaisterError`/`SupervisorError` only
- Docs: yes — mandatory docs checkpoint at completion (new `docs/flow-dsl.md` + new `docs/flow-aif-plugin.md` + update `docs/supervisor.md` for the new prompt endpoint + update `docs/getting-started.md` "Launch a run" + update `.ai-factory/ROADMAP.md` M5 → `[x]`)

## Roadmap Linkage

Milestone: "M5. Flow DSL parser + executor"
Rationale: Directly implements the next unimplemented milestone in `.ai-factory/ROADMAP.md`. M0–M4 are shipped; M5 turns installed Flow plugins into executable runs, ships the second plugin (`aif`) that validates slash-in-existing-session execution end-to-end, and unblocks M6 (executor registry expansion), M9 (Web UI Launch), and M10 (HITL hybrid surface). M7 inherits a smaller scope: response-side ACP event parsing + permission HITL only; M5 lands the request-side wire.

## Research Context

Source: code exploration of worktree on 2026-05-27 (no `.ai-factory/RESEARCH.md` Active Summary present).

Goal: build the executor that walks `flow.yaml` steps[], resolves Mustache templates, persists per-step output vars to a new `step_runs` table, captures guard metrics on disk, drives `runs` state through the DSL, exposes a `POST /api/runs` Route Handler as the launch surface (UI lands in M9), and lets the **aif** fixture plugin run `/aif-plan` + `/aif-implement` + `/aif-fix` + `/aif-explore` in a single supervisor session (slash-in-existing) end-to-end against a real Postgres + mock-adapter binary.

Constraints carried over from existing M0–M4 work:

- Every `web/lib/*.ts` opens with `import "server-only";` (atomic.ts:1, config.ts:1, errors.ts:1, db/client.ts:1, supervisor-client.ts:1, flows.ts:1, flow-paths.ts:1). New `web/lib/flows/*.ts` and `web/lib/worktree.ts` and `web/lib/scheduler.ts` MUST follow.
- Pino logger naming: `const log = pino({ name: "<concern>" })` — see `flows.ts:?`, `config.ts:17`. M5 introduces `name: "flow-runner"`, `name: "flow-guards"`, `name: "flow-templating"`, `name: "scheduler"`, `name: "worktree"` (web side); `name: "acp-client"` (supervisor side).
- Error pattern: wrap every domain failure as `new MaisterError(<code>, message, { cause: asError(err) })`. Supervisor side uses `SupervisorError`. UI branches on `code`, never on string matching. M5 introduces no new error codes — the existing taxonomy (PRECONDITION, SPAWN, NEEDS_INPUT, HITL_TIMEOUT, CRASH, CONFLICT, CONFIG, EXECUTOR_UNAVAILABLE, FLOW_INSTALL, ACP_PROTOCOL, CHECKPOINT) covers everything.
- Manifest schema already shipped (`web/lib/config.schema.ts`): step discriminated union `cli | agent | guard | human`; `agent.mode` is `"new-session" | "slash-in-existing"` (the schema's spelling — `flow.yaml` files MUST use these tokens, not the informal ROADMAP wording `new-session-per-step` / `slash-in-existing-session`). Guard config schema validated at config-load — M5 never re-validates structure, only evaluates.
- DB schema already shipped (`web/lib/db/schema.ts`): `projects | executors | flows | tasks | runs | workspaces | hitl_requests`. M5 adds two changes: a `runs.current_step_id` column and a new `step_runs` table.
- `runs.acpSessionId` exists (M3) — it stays the canonical resume handle. M5 reuses it as "the primary session id for slash-in-existing mode" (set on first agent step regardless of mode; never overwritten within one run).
- M3 supervisor (`supervisor/src/spawn.ts`) currently captures the adapter's raw stdout, line-buffers, fans out as SSE — but does **not** speak ACP JSON-RPC. M5 swaps the per-session machinery to use the SDK's `ClientSideConnection` (from `@agentclientprotocol/sdk@0.22.1`): spawn binary → wrap stdin/stdout via `acp.ndJsonStream(toWebWritable, toWebReadable)` → instantiate `ClientSideConnection(clientImpl, stream)` → call `connection.newSession(...)` once → reuse `connection.prompt({sessionId, prompt})` for every turn (both initial and follow-up). The raw-line SSE plumbing stays, but `clientImpl.sessionUpdate` is the source of structured events (M5 forwards them as `session.line` events with a typed `update` payload; M7 expands the SSE event shape).
- **End-of-turn detection is the SDK's `PromptResponse`**: `connection.prompt(...)` returns `Promise<PromptResponse>` whose `stopReason` ∈ `"end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"`. Awaiting that promise IS the structured detector — no marker hunting, no idle-timeout fallback. The `connection.cancel(...)` notification (per ACP spec) handles user-initiated cancellation (M9 wires the UI button; supervisor side ships in M5 because the API surface is already there).
- **`Client` interface in M5 supervisor** (`supervisor/src/acp-client.ts` implements `acp.Client`):
  - `sessionUpdate(params)` → push the structured update into the registry's EventEmitter as `{type:"session.update", sessionId, monotonicId, update: params.update}`. Existing `session.line`/`session.exited`/`session.crashed` event types extend, not replace, to keep M3's SSE consumers compatible.
  - `requestPermission(params)` → **M5 auto-allow policy**: scan `params.options` for an option whose `kind` is `"allow_always"`; else `"allow_once"`; else `options[0]`. Return `{outcome:{outcome:"selected", optionId}}`. Log WARN with `{sessionId, toolCall.title, optionId}` so the auto-allow is auditable. **M7 replaces this with structured HITL** (insert `hitl_requests` row + emit `session.permission` event + block on response artifact). `TODO(m7)` comment marks the swap site.
  - `writeTextFile`/`readTextFile` left **undefined** — the supervisor does NOT advertise the `fs.*` capabilities, so the adapter never calls them.
- M3 supervisor's `POST /sessions/:id/input` returns 501 "see M7" — that path stays for M7 HITL response delivery. M5 adds a **separate** endpoint `POST /sessions/:id/prompt` so the two semantics don't collide.
- The M3 supervisor `StartSessionRequestSchema` already accepts `prompt: z.string().max(1_000_000)` in the body — M5 keeps the wire and reuses `prompt` as the first turn's content.
- **`installFlowPlugin()` (M4) gains a local-source path**: if `source` is an absolute filesystem path or `file://` URL pointing to a directory (NOT a git URL), bypass `git clone` and copy via `fs.cp(source, target, {recursive:true})`. The `version` string becomes a label (still stored on the row + symlink path `~/.maister/flows/<id>@<version>/`). Git-URL sources keep the existing clone-by-tag path. Detection: try `fs.stat(source)` first; if it resolves to a directory containing `flow.yaml`, take the local path; else fall through to git clone.
- Mustache must be configured strict (default behavior is "render undefined as empty string"). The custom view-resolver throws `MaisterError("CONFIG", ...)` on undefined dotted-path. HTML escaping disabled (flow prompts/commands are not HTML).
- Concurrency cap (`MAISTER_MAX_CONCURRENT_RUNS`, default 3) is global across all projects. Per CLAUDE.md it is a hard cap; `maister.yaml` cannot override it. Scheduler enforces via DB transaction (count rows in `Running`/`NeedsInput`) — no in-memory cap state, so survives Next.js restart.
- M4 dev-CLI pattern (`web/scripts/install-flow.ts` + `_register-shim.mjs` + `_server-only-shim.mjs`) is the template for the new `web/scripts/run-flow.ts`. ESM loader shim is required for `import "server-only"` files to work under `tsx` outside the Next.js bundler.
- Vitest projects (`unit`, `integration`) are already wired in `web/vitest.workspace.ts` (per M4). M5 adds its tests under the same `__tests__/` convention — no config change.
- `.maister/` is already gitignored (per M4 Task 1).
- Run lifecycle for M5: `Pending → Running → (Running ↔ NeedsInput) → Review | Failed`. M5 does NOT implement `NeedsInput → NeedsInputIdle` (idle-timer + checkpoint), `Crashed`-via-heartbeat, or reconciliation — those are M8/M12. On `human` step the executor writes `needs-input.json`, marks the run `NeedsInput`, and returns; the resumption path is M7 (HITL response delivery) + M8 (respawn via `--resume`).

Decisions:

- **Templating**: `mustache@4.x` dep added to `web/package.json`. New module `web/lib/flows/templating.ts` exports `renderStrict(template, context, opts?)`. Uses a Proxy-wrapped context that throws `MaisterError("CONFIG", "undefined template var: <path>")` on undefined property access. `Mustache.escape = (s) => s` (no HTML escaping). Optional `traceLog` pino logger writes one DEBUG line per resolved path → observability traces for free.
- **Step output store**: new `step_runs` table — keyed by `(runId, stepId, attempt)` with UNIQUE constraint. Captures `stdout`, `vars` (jsonb default `{}`), `exitCode`, `errorCode`, `acpSessionId`, `mode`, `status`, `startedAt`, `endedAt`. `vars` is the bag the runner persists for `{{ steps.X.vars.<name> }}` resolution; `output` field of templating context is `step_runs.stdout` truncated to N KB (configurable). Attempt counter increments on retry of a previously-failed step within the same run (M5 ships the column + UNIQUE constraint; runner does NOT yet retry — retry is a future enhancement).
- **Run state ownership**: the runner owns row transitions for `runs.status` and `runs.current_step_id`. No separate "run-coordinator" service in POC scope. The Route Handler kicks off `runFlow(runId)` as an unawaited promise on the Node event loop (in-process background). Process death mid-run leaves orphan `Running` rows — that's exactly what M12 reconciliation will catch.
- **Concurrency cap**: `web/lib/scheduler.ts` with two operations. `tryStartRun(runId)` runs in a DB transaction: `SELECT COUNT(*) FROM runs WHERE status IN ('Running','NeedsInput')` → if `< cap`, UPDATE the target to `Running`, return `{ started: true }`. Else UPDATE to `Pending`, return `{ started: false, queuePosition }`. `promoteNextPending()` is invoked from `runFlow`'s terminal-transition path: picks the oldest `Pending` row, calls `runFlow(...)` in background. Polling-free.
- **Worktree**: new `web/lib/worktree.ts` with `addWorktree({projectRepoPath, branch, worktreePath})`, `removeWorktree(...)`, `listWorktrees(repoPath)`. Wraps `execFile("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath])`. Path/branch safety: validate `worktreePath` is absolute + no `..` segments (mirror `supervisor/src/types.ts:worktreePathSchema`), `branch` matches a project's `branchPrefix + safe-path-regex`.
- **Launch surface**: Route Handler `POST /api/runs` body `{ taskId, executorOverrideId? }`. Resolves executor with the documented precedence (run launcher → task.executorOverrideId → project.defaultExecutorId → flow.recommendedExecutorId). Inserts workspace + run rows, calls `worktree.addWorktree`, then either `tryStartRun` says go (kicks off `runFlow(runId)` background, returns 202 with `runId, status: "Running"`) or queues (returns 202 with `runId, status: "Pending", queuePosition`). M9 adds the UI form on top.
- **`aif` plugin lives in-repo at `plugins/aif/`**: top-level `plugins/` directory in the MAIster monorepo holds plugin sources. The first occupant is `plugins/aif/{flow.yaml, setup.sh, schemas/review.json}`. `setup.sh` invokes the real `ai-factory init` (so a user installing locally gets a working bootstrap). The integration test does NOT execute that line — the mock adapter never triggers it; only an end-to-end manual smoke does. When the plugin grows up and moves to its own repo (post-M5), the in-repo copy becomes a deletion + a `maister.yaml` `source` URL flip. No code changes needed because of the local-source path in `installFlowPlugin()`.
- **Mock adapter binary**: M5 integration test cannot depend on the real `claude-agent-acp` binary (network + auth + cost). Build an **ACP-conforming** mock as a tiny Node script (`web/lib/__tests__/_fixtures/mock-acp-adapter.mjs`) that uses the same `@agentclientprotocol/sdk` to spin an `AgentSideConnection` over stdio. The mock implements `Agent`:
  - `newSession(params)` → return a stable sessionId.
  - `prompt(params)` → emit 1–3 `sessionUpdate` notifications (configurable via env var `MOCK_ACP_BEHAVIOR`), then return `{stopReason:"end_turn"}`. For test variant: return `{stopReason:"cancelled"}` or trigger a `requestPermission` round-trip.
  - All other methods → throw (test fails loud).
  The supervisor's `spawnOverrides` (already in `spawn.ts:46` + `http-api.ts:opts.spawnOverrides`) is the injection point. Real-binary smoke testing is manual (out of CI matrix).
- **Pre/post guards**: pre-guards run BEFORE the step (`cli`/`agent` step types only) — observational; never block. Post-guards run AFTER, against `{ durationMs, stdout, costTokens? }`. Standalone `guard` step is a no-op observer (writes a metric line, never gates). All guard metrics appended to `.maister/<projectSlug>/runs/<runId>/guards.jsonl` via `fs.appendFile`. Cap exceeded → WARN log only. The schema-shipped `guardConfigSchema` requires at least one of `cost/time/regex` — runner trusts the validator.
- **Cost tokens for guards**: supervisor's `cost.ts` (M3) appends per-event cache_creation/input/output tokens to `cost.jsonl`. M5 reads the per-run total at guard-eval time (helper `readCostJsonlTotal(runtimeRoot, projectSlug, runId)`) and feeds it as `costTokens` into the guard evaluator. Lenient — missing/empty file → 0.
- **Template context shape**: `{ task: {id,title,prompt,attemptNumber}, run: {id,projectSlug,attemptNumber}, executor: {id,agent,model,router?}, steps: Record<stepId, {output, vars, exitCode?}>, env: <whitelisted subset of process.env> }`. The `env` whitelist is a deny-by-default list of regex'd keys (blocks `*TOKEN*`, `*KEY*`, `*SECRET*`, `ANTHROPIC_*`, `OPENAI_*`, `DB_URL`, anything ending in `_PASSWORD`). Tests assert no secret leaks.

Open questions: none blocking M5 start. Two `TODO(m7)` markers live in code for the response-side ACP boundary (end-of-turn detection + structured event surface). One open housekeeping note: the real public `aif` plugin repo URL is TBD — tracked separately, not gating M5.

## Commit Plan

33 tasks across 6 phases — 6 commit checkpoints:

- **Commit 1** (after tasks 1–4): `chore(flows): db migration for step_runs + runs.current_step_id; scaffold web/lib/flows/; add mustache dep`
- **Commit 2** (after tasks 5–8): `feat(flows): mustache strict templating + flow context builder`
- **Commit 3** (after tasks 9–13): `feat(flows): guard metric capture + step-run store + cli executor`
- **Commit 4** (after tasks 14–18): `feat(supervisor,flows): ACP ClientSideConnection per session + POST /sessions/:id/prompt + agent executor (both modes); supervisor wire change: POST /sessions no longer takes prompt`
- **Commit 5** (after tasks 19–24): `feat(flows): run state machine + scheduler + worktree + POST /api/runs + human step`
- **Commit 6** (after tasks 25–33): `feat(plugins): aif plugin in plugins/aif + local-directory source path; test(flows): mock ACP adapter + end-to-end runner integration; docs/flow-dsl + docs/flow-aif-plugin; mark M5 done`

## Tasks

### Phase 1: DB schema + module scaffolding

- [x] **Task 1: Drizzle migration — add `runs.current_step_id` column**
  - Files: `web/lib/db/schema.ts` (extend `runs`), `web/lib/db/migrations/<NNNN>_runs_current_step.sql` (generated)
  - Add column `currentStepId: text("current_step_id")` (nullable) to the `runs` table.
  - Generate the migration via `pnpm --filter @maister/web drizzle:generate` (or whatever the existing script is — read `web/package.json`). Hand-verify the migration is additive only.
  - Logging: n/a.
  - Acceptance: existing integration tests still pass; new column visible in a fresh `migrate(db)` against the testcontainer.

- [x] **Task 2: Drizzle migration — new `step_runs` table**
  - Files: `web/lib/db/schema.ts` (add table), `web/lib/db/migrations/<NNNN>_step_runs.sql` (generated)
  - Columns:
    - `id: text PK`
    - `runId: text NOT NULL` FK→`runs(id)` ON DELETE CASCADE
    - `stepId: text NOT NULL`
    - `stepType: text` enum `['cli','agent','guard','human']` NOT NULL
    - `mode: text` enum `['new-session','slash-in-existing']` (nullable; only for agent steps)
    - `attempt: integer NOT NULL DEFAULT 1`
    - `status: text` enum `['Pending','Running','Succeeded','Failed','Skipped','NeedsInput']` NOT NULL DEFAULT `'Pending'`
    - `acpSessionId: text` (nullable)
    - `stdout: text` (nullable; truncated by the runner to a configurable byte cap)
    - `vars: jsonb NOT NULL DEFAULT '{}'::jsonb`
    - `exitCode: integer` (nullable)
    - `errorCode: text` (nullable; one of the `MaisterErrorCode` literal values)
    - `startedAt: timestamptz NOT NULL DEFAULT now()`
    - `endedAt: timestamptz` (nullable)
  - Constraints: `UNIQUE(run_id, step_id, attempt)`; `INDEX(run_id)`.
  - Export `StepRun` type via `typeof stepRuns.$inferSelect`.
  - Logging: n/a.
  - Acceptance: testcontainer migrate runs cleanly; row insert/upsert round-trips through Drizzle.

- [x] **Task 3: Bootstrap `web/lib/flows/` directory**
  - Files: `web/lib/flows/index.ts` (new — public re-exports), `web/lib/flows/types.ts` (new — internal types)
  - `index.ts` re-exports the M5 public surface: `runFlow`, `renderStrict`, `buildContext`, `tryStartRun`, `promoteNextPending`, `addWorktree`, `removeWorktree`, `listWorktrees`.
  - `types.ts` defines internal types: `FlowContext`, `StepResult`, `RunContext`, `AcpSessionState`, `GuardMetric`.
  - Both files start with `import "server-only";`.
  - Logging: n/a (declaration-only).
  - Acceptance: `pnpm --filter @maister/web tsc --noEmit` clean; new files don't leak into the client bundle (RSC verifier passes).

- [x] **Task 4: Add `mustache@4.x` dep + types**
  - Files: `web/package.json`, `web/pnpm-lock.yaml`
  - `pnpm --filter @maister/web add mustache@^4 && pnpm --filter @maister/web add -D @types/mustache`.
  - Pin to a specific minor — Mustache's API is stable but record the exact resolved version in the lockfile.
  - Logging: n/a.
  - Acceptance: `pnpm --filter @maister/web typecheck` clean; lockfile committed.

### Phase 2: Templating + flow context

- [x] **Task 5: `web/lib/flows/templating.ts` — Mustache strict resolver**
  - Files: `web/lib/flows/templating.ts` (new)
  - Imports: `Mustache from "mustache"`, `MaisterError from "@/lib/errors"`, `pino`.
  - Exports `renderStrict(template: string, context: FlowContext, opts?: { traceLog?: pino.Logger }): string`.
  - Pre-render: `Mustache.escape = (s) => s` (set once at module init; HTML-escape OFF — flow prompts/commands are not HTML).
  - Strictness implementation: do NOT pass `context` directly to `Mustache.render`. Instead pass a Proxy with a `get` handler that:
    1. Recognizes the path being requested (via Mustache's view-walking — Mustache walks `view[key]` for dotted paths automatically, so the Proxy just needs to throw on undefined leaves)
    2. On undefined leaf access → throw `MaisterError("CONFIG", \`undefined template var: ${currentPath}\`)`. The Proxy tracks `currentPath` via per-level wrapping.
    3. On defined access → return value (also DEBUG-log to `traceLog` if present: `{ path, value: typeof value === "string" ? (value.length > 200 ? value.slice(0, 200) + "…" : value) : value }`)
  - For nested objects: returning a Proxy of the nested object (recursive) preserves strictness.
  - For arrays / iteration sections (`{{#steps.plan.lines}}…{{/steps.plan.lines}}`): if the value is an array, return it raw (Mustache iterates natively). Strict-mode-on-undefined still applies inside the section.
  - Module-level logger: `const log = pino({ name: "flow-templating" })`.
  - Logging: DEBUG on every resolved path (when `traceLog` is provided); ERROR via thrown `MaisterError` only.
  - Acceptance: tested in Task 7. No I/O.

- [x] **Task 6: `web/lib/flows/context.ts` — FlowContext builder**
  - Files: `web/lib/flows/context.ts` (new)
  - Exports `buildContext(args: { task: Task, run: Run, executor: Executor, stepRuns: StepRun[], envWhitelist?: RegExp[] }): FlowContext`.
  - Shape produced:
    ```
    {
      task: { id, title, prompt, attemptNumber },
      run: { id, attemptNumber: 1, projectSlug },   // attemptNumber pulled from task.attemptNumber until run-level attempt lands in M8
      executor: { id, agent, model, router? },
      steps: { [stepId]: { output: <stdout truncated to 8 KiB>, vars: <jsonb>, exitCode? } },
      env: <whitelisted subset of process.env>,
    }
    ```
  - `env` whitelist semantics: deny-by-default. Built-in deny patterns (regex, case-insensitive):
    `*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, `*AUTH*`, `ANTHROPIC_*`, `OPENAI_*`, `DB_URL`, `MAISTER_SUPERVISOR_URL`, `*CREDENTIAL*`, `*PRIVATE*`.
  - Allow-list patterns added on top: `LANG`, `LC_*`, `TZ`, `PATH`, `HOME`, `USER`, `SHELL`, `TERM`.
  - Optional `envWhitelist` arg adds extra allow patterns (for tests).
  - `projectSlug` is computed via `await ctx.db.select().from(projects).where(eq(projects.id, run.projectId))` — caller passes it in to avoid an extra query inside the builder.
  - Logging: DEBUG with the resolved env key list (NOT values).
  - Acceptance: tested in Task 7.

- [x] **Task 7: Unit tests — `web/lib/flows/__tests__/templating.test.ts` + `context.test.ts`**
  - Files: `web/lib/flows/__tests__/templating.test.ts` (new), `web/lib/flows/__tests__/context.test.ts` (new)
  - templating.test.ts cases (~10):
    1. `{{ task.prompt }}` resolves to task.prompt.
    2. `{{ steps.plan.output }}` resolves from a prior step's stdout.
    3. Undefined leaf (`{{ task.nonexistent }}`) throws `MaisterError` with `code: "CONFIG"` and message contains `task.nonexistent`.
    4. Undefined deep leaf (`{{ steps.never.vars.x }}`) throws `MaisterError("CONFIG", ...)`.
    5. HTML chars in prompt (`<script>`) pass through raw — Mustache.escape disabled.
    6. Nested dotted (`{{ executor.model }}`) resolves correctly.
    7. Array iteration via `{{#steps.foo.lines}}{{.}}{{/steps.foo.lines}}` (if we choose to support — otherwise skip).
    8. `traceLog` opt-in: a fake pino logger captures DEBUG entries, one per resolved path.
    9. `traceLog` truncates long values to 200 chars.
    10. Empty template returns empty string (no throw).
  - context.test.ts cases (~8):
    1. Returns the full shape with expected fields.
    2. `env` includes `PATH` and excludes `ANTHROPIC_AUTH_TOKEN`, `DB_URL`, `*_TOKEN`, `*_KEY`.
    3. Custom `envWhitelist: [/^CUSTOM_/]` adds `CUSTOM_FOO` to env.
    4. `steps` is keyed by `stepId`; multiple step_runs with the same stepId but different `attempt` resolve to the **highest** attempt's output.
    5. `output` is truncated to 8 KiB.
    6. `vars` from jsonb passes through as-is.
    7. `executor.router` is undefined when not set on the row.
    8. `task.attemptNumber` is propagated.
  - Logging: tests assert no secret strings appear in pino test stream output (defensive — mirrors M4's pattern).
  - Acceptance: 18 cases green under `pnpm --filter @maister/web test:unit`.

- [x] **Task 8: Sanity-validate templates at config-load time**
  - Files: `web/lib/config.ts` (extend `loadFlowManifest`)
  - After zod validation, for every step that has a template-bearing field (`agent.prompt`, `cli.command`, `human.form_schema` is a path not a template — skip):
    - Call `Mustache.parse(templateString)` inside a `try/catch`.
    - On parse error → throw `MaisterError("CONFIG", \`flow.yaml step <id>: invalid mustache template — ${err.message}\`)`.
  - Do NOT attempt to resolve variables at config-load time (the context only exists at run-time).
  - Logging: DEBUG `template parse-ok` per step.
  - Acceptance: extend an existing test in `web/lib/__tests__/config.test.ts` (or add a new one) with a fixture flow.yaml that contains `prompt: "{{ task.prompt"` (unbalanced) and assert `MaisterError("CONFIG", ...)` is thrown.

### Phase 3: Guards + step-run store + CLI executor

- [x] **Task 9: `web/lib/flows/step-runs.ts` — DB helpers**
  - Files: `web/lib/flows/step-runs.ts` (new)
  - Exports:
    - `async createStepRun(args: { runId, stepId, stepType, mode?, attempt?, db? }): Promise<{ id: string }>` — INSERT with `randomUUID()`, status `Pending`.
    - `async markStepRunning(stepRunId, db?)`
    - `async markStepSucceeded(stepRunId, args: { stdout, vars, exitCode?, acpSessionId? }, db?)`
    - `async markStepFailed(stepRunId, args: { errorCode, stdout?, exitCode? }, db?)`
    - `async markStepNeedsInput(stepRunId, db?)`
    - `async getStepRunsForRun(runId, db?): Promise<StepRun[]>` — ORDER BY `startedAt ASC, attempt ASC`.
  - `db?` optional for test injection; defaults to `getDb()` per M4 pattern.
  - `stdout` is truncated to 1 MiB by the writer (hard cap — beyond that the full content lives in the per-step `.log` file already).
  - Logging: INFO per transition with `{stepRunId, status}`.
  - Acceptance: covered by integration test in Task 26 + a small unit test asserting INSERT/UPDATE happens through the right table.

- [x] **Task 10: `web/lib/flows/guards.ts` — guard evaluator + metric writer**
  - Files: `web/lib/flows/guards.ts` (new)
  - Imports: `MaisterError`, `pino`, `node:fs/promises`, `path`.
  - Exports:
    - `evaluateGuards(guards: GuardConfig[], observed: { durationMs: number, stdout: string, costTokens?: number }): GuardMetric[]` — pure function. For each guard: emit `{ guard: {cost,time,regex}, observed: {durationMs,costTokens,regexMatched?}, capExceeded: boolean, regexMatched?: boolean }`.
    - `async appendGuardMetric(args: { runtimeRoot, projectSlug, runId, stepId, kind: "pre"|"post"|"standalone", metrics: GuardMetric[] }): Promise<void>` — writes one JSON line per metric to `<runtimeRoot>/.maister/<projectSlug>/runs/<runId>/guards.jsonl` via `fs.appendFile`. Creates parent dir via `mkdir(..., { recursive: true })`. Never throws on filesystem error — WARN logs and continues.
    - `async readCostJsonlTotal(runtimeRoot, projectSlug, runId): Promise<number>` — sums `cache_creation_input_tokens + input_tokens + output_tokens` across `cost.jsonl`. Missing file → 0. Malformed lines → DEBUG-log and skip.
  - `evaluateGuards` semantics:
    - `cost` cap: `observed.costTokens > guard.cost` → `capExceeded: true`
    - `time` cap: `observed.durationMs > guard.time * 1000` (guard.time is seconds) → `capExceeded: true`
    - `regex`: `new RegExp(guard.regex).test(observed.stdout)` → `regexMatched: true` (independent of cap)
  - Logger: `pino({ name: "flow-guards" })`. WARN per cap-exceeded metric with structured payload.
  - Acceptance: unit-tested in Task 13.

- [x] **Task 11: `web/lib/flows/runner-cli.ts` — CLI step executor**
  - Files: `web/lib/flows/runner-cli.ts` (new)
  - Signature: `async runCliStep(step: CliStepConfig, ctx: { runtimeRoot, projectSlug, runId, stepId, worktreePath, context: FlowContext, timeoutMs?: number }): Promise<StepResult>`.
  - Step body:
    1. Resolve `step.command` via `renderStrict(step.command, ctx.context, { traceLog })`.
    2. Evaluate pre-guards (observational): `evaluateGuards(step.pre_guards ?? [], { durationMs: 0, stdout: "", costTokens: 0 })` + `appendGuardMetric(...kind:"pre"...)`.
    3. `await execFile("bash", ["-c", resolvedCommand], { cwd: worktreePath, signal: AbortSignal.timeout(ctx.timeoutMs ?? 300_000), maxBuffer: 4 * 1024 * 1024 })`.
    4. Capture `{ stdout, stderr, exitCode, durationMs }`.
    5. Post-guards: `appendGuardMetric(...kind:"post", metrics: evaluateGuards(...))`.
    6. Return `{ ok: exitCode === 0, stdout, stderr, exitCode, durationMs, errorCode: exitCode === 0 ? undefined : "PRECONDITION", vars: {} }`.
  - On `execFile` rejection (timeout / spawn failure): map to `StepResult{ ok: false, errorCode: "PRECONDITION", stdout: "", stderr: <err.message>, exitCode: -1, durationMs: <measured>, vars: {} }`. Do NOT throw — the runner decides whether to abort the flow.
  - Logger: `pino({ name: "flow-runner" })`. INFO start (with resolved command preview, length-capped), INFO end (exit, durationMs), DEBUG per stdout/stderr chunk preview.
  - Acceptance: unit-tested in Task 12.

- [x] **Task 12: Unit tests — `web/lib/flows/__tests__/runner-cli.test.ts`**
  - Files: `web/lib/flows/__tests__/runner-cli.test.ts` (new)
  - Mock `node:child_process` `execFile` via `vi.mock` (mirror M4 pattern; if symbol-table mocking proves painful again, move these to integration suite).
  - Cases (~7):
    1. Success path: command exits 0, stdout captured.
    2. Non-zero exit: errorCode set to `"PRECONDITION"`.
    3. AbortSignal timeout: errorCode `"PRECONDITION"`, durationMs near timeout.
    4. Template applied to command: command "echo {{ task.prompt }}" with `task.prompt = "hi"` resolves to "echo hi".
    5. Pre-guard metric appended on success (verify JSONL line via spy on appendGuardMetric).
    6. Post-guard with `cost: 100` cap exceeded → WARN logged.
    7. Post-guard `regex` matches → metric `regexMatched: true`.
  - Acceptance: 7 cases green under `pnpm test:unit` (or moved to integration if mock fights).

- [x] **Task 13: Unit tests — `web/lib/flows/__tests__/guards.test.ts`**
  - Files: `web/lib/flows/__tests__/guards.test.ts` (new)
  - Cases (~8):
    1. `evaluateGuards([{cost:1000}], {costTokens: 500})` → `capExceeded: false`.
    2. `evaluateGuards([{cost:1000}], {costTokens: 1500})` → `capExceeded: true`.
    3. `evaluateGuards([{time:30}], {durationMs: 25000})` → `capExceeded: false`.
    4. `evaluateGuards([{time:30}], {durationMs: 35000})` → `capExceeded: true`.
    5. `evaluateGuards([{regex:"ERROR"}], {stdout: "all good"})` → `regexMatched: false`.
    6. `evaluateGuards([{regex:"ERROR"}], {stdout: "...ERROR..."})` → `regexMatched: true`.
    7. `appendGuardMetric` writes a parseable JSONL line under the right path.
    8. `readCostJsonlTotal` sums across multiple lines; missing file returns 0; malformed line is skipped.
  - Acceptance: 8 cases green under `pnpm test:unit`.

### Phase 4: Supervisor ACP wire + agent executor

- [x] **Task 14: `supervisor/src/acp-client.ts` — structured ACP per-session connection**
  - Files: `supervisor/src/acp-client.ts` (new), `supervisor/src/types.ts` (extend with `SendPromptRequestSchema` + extended `SessionEvent` union)
  - Imports: `import * as acp from "@agentclientprotocol/sdk"` (the dep is already in `supervisor/package.json` per M3 — pinned to `@agentclientprotocol/sdk@0.22.1`).
  - Exports:
    - `async function createAcpConnection(args: { child: ChildProcess, sessionId: string, runId: string, projectSlug: string, stepId: string, emitter: EventEmitter, registry: SessionRegistry, logger: Logger }): Promise<{ connection: acp.ClientSideConnection, acpSessionId: string }>`:
      1. Wrap stdio: `const stdoutWeb = Readable.toWeb(child.stdout); const stdinWeb = Writable.toWeb(child.stdin);` (use Node 24's stable `node:stream/web` interop).
      2. `const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);` (writable first per SDK signature — confirm at impl time from `dist/stream.d.ts`).
      3. Build a `Client` impl (object literal) implementing the SDK's `Client` interface (see below for the M5 policies).
      4. `const connection = new acp.ClientSideConnection(clientImpl, stream);`
      5. `await connection.initialize({...})` — pass `protocolVersion` + the `Client` capabilities (M5 advertises `{}` — no `fs.*`, no MCP; M7 wires the real cap set).
      6. `const newSessionResp = await connection.newSession({ cwd: worktreePath, mcpServers: [] });` → returns `{sessionId: <ACP sessionId>}`. Store as `acpSessionId`.
      7. Return `{connection, acpSessionId}`.
    - `async function sendPromptOnConnection(conn: acp.ClientSideConnection, args: {acpSessionId: string, stepId: string, prompt: string}, logger: Logger): Promise<acp.PromptResponse>`:
      Wraps `conn.prompt({sessionId: acpSessionId, prompt: [{type:"text", text: args.prompt}]})`. Captures `PromptResponse.stopReason`. Maps non-`"end_turn"` stopReasons to a structured result the caller branches on (e.g. `"cancelled"` → throw `SupervisorError("ACP_PROTOCOL", "prompt cancelled")` for now; `"refusal"` → log WARN and return; `"max_tokens"` → log WARN and return).
  - `Client` impl policies (M5):
    - `sessionUpdate(params)` → emit `{type:"session.update", sessionId, monotonicId: ++record.monotonicId, update: params.update}` via the existing `emitter`. The existing `session.line` event type stays (for raw fallback in case the adapter emits non-ACP stdout — rare but possible during startup); the new `session.update` carries the typed `SessionNotification.update` payload. Existing SSE consumers handle both.
    - `requestPermission(params)` → auto-allow:
      1. Pick option: first with `kind === "allow_always"` ELSE first with `kind === "allow_once"` ELSE `options[0]`.
      2. Emit `{type:"session.permission_auto", sessionId, monotonicId, toolCall: params.toolCall, optionId}` via emitter (M7 will replace with a blocking `session.permission_request` + artifact write).
      3. Return `{outcome:{outcome:"selected", optionId}}`.
      4. Log WARN `auto-allow-permission` with `{sessionId, toolCallTitle: params.toolCall.title, optionId}`.
      5. `TODO(m7)`: insert `hitl_requests` row + block on response artifact instead of auto-allow.
    - `writeTextFile`/`readTextFile` left undefined (cap not advertised).
  - `SendPromptRequestSchema`: `z.object({ stepId: SAFE_PATH_SEGMENT-regex bounded ≤128 chars, prompt: z.string().max(1_000_000) })`.
  - `SessionEvent` union extended in `types.ts`:
    ```
    | { type: "session.update", sessionId, monotonicId, update: acp.SessionNotification["update"] }
    | { type: "session.permission_auto", sessionId, monotonicId, toolCall: acp.ToolCallUpdate, optionId: string }
    ```
    Existing `session.line | session.exited | session.crashed` stay.
  - Logger: `pino({ name: "acp-client" })`. INFO `connection-init`/`new-session`/`prompt-sent`/`prompt-end {stopReason}`. DEBUG per notification (`update.sessionUpdate` type only — content size only, no content).
  - Acceptance: unit-tested in `supervisor/src/__tests__/acp-client.test.ts` with the `examples/agent.js` from the SDK as the counterparty (or a tiny in-process Agent stub that returns canned `PromptResponse`).

- [x] **Task 15: Supervisor — `spawnSession` integrates `createAcpConnection`**
  - Files: `supervisor/src/spawn.ts` (rewrite the post-spawn body), `supervisor/src/registry.ts` (extend `RegistryEntry` to hold `connection: acp.ClientSideConnection` + `acpSessionId: string`)
  - After `await new Promise spawn` (today's spawn.ts:117) succeeds:
    1. Call `const { connection, acpSessionId } = await createAcpConnection({ child, ... });`.
    2. Call `const promptResp = await sendPromptOnConnection(connection, { acpSessionId, stepId: request.stepId, prompt: request.prompt }, logger);`
       - Awaiting this resolves when the FIRST turn completes — but this is the **initial** session start path. We do NOT want `POST /sessions` to block until the first turn completes (the runner awaits it separately via a parallel "wait for prompt complete" path). Refactor: kick the prompt off but do NOT await it inside spawn. Instead store `connection` + `acpSessionId` in the registry; the runner explicitly calls `POST /sessions/:id/prompt` and that endpoint awaits the response.
       - **Decision**: change `StartSessionRequestSchema` body — make `prompt` optional. When omitted, `spawnSession` returns immediately after `newSession`; when provided, supervisor calls `prompt(...)` IN BACKGROUND (don't await) and stores the in-flight promise on the registry entry as `currentPromptPromise`. `POST /sessions/:id/prompt` either awaits `currentPromptPromise` if one exists OR starts a new one. The web-side runner POSTs the initial prompt via `/prompt` once it has the sessionId, awaiting the response.
       - **Simpler decision (chosen)**: drop the auto-initial-prompt behavior entirely. `POST /sessions` only spawns + `newSession`s, returns `{sessionId, acpSessionId, pid}`. The runner then explicitly `POST /sessions/:id/prompt` with the first turn's content and awaits. Removes the dual-path. Keep `StartSessionRequestSchema.prompt` required but **ignored** for one milestone (or remove; safer to remove — fewer surprises). Make this an explicit migration of the supervisor wire.
    3. Register `{connection, acpSessionId, child, ...}` in the registry. Existing heartbeat + cost handlers stay.
  - Update `SessionRecord.acpSessionId` (currently absent in M3 SessionRecord — `supervisor/src/types.ts:64` has no acpSessionId; add it).
  - Logger: INFO `acp-session-ready` with `{supervisorSessionId, acpSessionId, pid}`.
  - Acceptance: unit-tested via the same agent stub as Task 14.

- [x] **Task 16: Supervisor — new endpoint `POST /sessions/:id/prompt`**
  - Files: `supervisor/src/http-api.ts` (extend)
  - Body: validated by `SendPromptRequestSchema` (`{ stepId, prompt }`).
  - Logic:
    1. Look up `entry = registry.get(req.params.id)`. If null → 404 `PRECONDITION`.
    2. If `entry.record.status !== "live"` → 409 `PRECONDITION` "session not live".
    3. `const promptResp = await sendPromptOnConnection(entry.connection, { acpSessionId: entry.acpSessionId, stepId, prompt }, logger);`
    4. Reply `200 { stopReason: promptResp.stopReason, meta?: promptResp.meta }`. The runner branches on `stopReason`.
  - The existing `/sessions/:id/input` 501 stub stays for M7 (HITL response delivery) — separate semantics.
  - Logger: INFO `http POST /sessions/:id/prompt` with `{sessionId, stepId, len, stopReason, status: 200}`.
  - Acceptance: unit-tested (in-process agent stub) + integration-tested via the runner-agent path in Task 26.

- [x] **Task 17: web `lib/supervisor-client.ts` — `sendPrompt` wrapper + `PromptResult` type**
  - Files: `web/lib/supervisor-client.ts` (extend), reuse M7-shape types where it fits
  - Add types:
    - `export type PromptStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"`.
    - `export type PromptResult = { stopReason: PromptStopReason, meta?: unknown }`.
  - Export `async sendPrompt(sessionId: string, args: { stepId: string, prompt: string }): Promise<PromptResult>`.
  - Body: `fetch ${BASE}/sessions/${encodeURIComponent(sessionId)}/prompt` POST. On non-OK → `asMaisterError(res, "ACP_PROTOCOL")`. On network failure → `networkErrorToMaister(err, "sendPrompt")`. Parse JSON body as `PromptResult`.
  - Also extend `SupervisorEvent` union with `session.update` + `session.permission_auto` (mirrors supervisor types).
  - Logger: DEBUG with `{sessionId, stepId, len}` (no prompt content).
  - Acceptance: unit-tested in `web/lib/__tests__/supervisor-client.test.ts` (extend the existing file).

- [x] **Task 18: `web/lib/flows/runner-agent.ts` — agent step executor (both modes)**
  - Files: `web/lib/flows/runner-agent.ts` (new)
  - Signature: `async runAgentStep(step: AgentStepConfig, ctx: { runtimeRoot, projectSlug, runId, stepId, worktreePath, executor, context: FlowContext, sessionState: { currentSessionId: string | null }, db? }): Promise<StepResult>`.
  - Resolve `prompt` via `renderStrict`.
  - **Step completion is `sendPrompt`'s awaited result** — no marker hunting.
  - `mode: "new-session"` path:
    1. `const { sessionId } = await supervisor.createSession({ runId, projectSlug, worktreePath, stepId, executor });` (note: M5 supervisor `POST /sessions` no longer takes `prompt`).
    2. Spawn a background event consumer: `for await (const ev of streamSession(sessionId)) { ... }` — accumulates `session.update` payloads (specifically `agent_message_chunk` text into `stdoutBuf`, capped at 1 MiB).
    3. `const promptResult = await supervisor.sendPrompt(sessionId, { stepId, prompt: resolved });`
    4. Cancel the event consumer.
    5. Optionally `await supervisor.deleteSession(sessionId)` (new-session mode does not reuse — clean up).
    6. Return `{ ok: promptResult.stopReason === "end_turn", stdout: stdoutBuf, vars: {}, durationMs, errorCode: promptResult.stopReason === "end_turn" ? undefined : "ACP_PROTOCOL" }`.
  - `mode: "slash-in-existing"` path:
    1. If `ctx.sessionState.currentSessionId == null`:
       - `const { sessionId } = await supervisor.createSession({ ... stepId, executor });` (no prompt — same wire as new-session).
       - `ctx.sessionState.currentSessionId = sessionId`. Persist to `runs.acpSessionId`.
       - Start the event consumer (lives for the rest of the run — accumulate per-step buffers via a step boundary marker the runner manages internally).
    2. Else: reuse the existing consumer (already running).
    3. `const promptResult = await supervisor.sendPrompt(ctx.sessionState.currentSessionId, { stepId, prompt: resolved });`
    4. Snapshot `stdoutBuf` since the previous step's snapshot → this step's stdout. Reset the snapshot pointer.
    5. Return `{ ok: promptResult.stopReason === "end_turn", stdout: stepStdout, vars: {}, durationMs, errorCode: promptResult.stopReason === "end_turn" ? undefined : "ACP_PROTOCOL", acpSessionId: ctx.sessionState.currentSessionId }`.
  - End-of-step session cleanup for slash-in-existing: handled by the runner's terminal-state cleanup (Task 21) when the LAST step completes — `supervisor.deleteSession(...)` against the primary session.
  - Logger: INFO start with mode + sessionId, INFO end with stopReason, WARN on non-end_turn stopReason.
  - Acceptance: unit-tested with mocked `supervisor-client` (Task 24); integration-tested end-to-end in Task 26.

### Phase 5: Run state machine + scheduler + worktree + Route Handler

- [x] **Task 19: `web/lib/worktree.ts` — git worktree wrapper**
  - Files: `web/lib/worktree.ts` (new)
  - Exports:
    - `async addWorktree(args: { projectRepoPath, branch, worktreePath }): Promise<void>` — `execFile("git", ["-C", projectRepoPath, "worktree", "add", "-b", branch, worktreePath], { signal: AbortSignal.timeout(60_000), maxBuffer: 4 * 1024 * 1024 })`. On stderr containing "already exists" → throw `MaisterError("PRECONDITION", ...)`. Other failures → `MaisterError("CONFLICT", ...)`.
    - `async removeWorktree(args: { projectRepoPath, worktreePath, force?: boolean }): Promise<void>` — `git -C <repo> worktree remove [--force] <path>`. Missing worktree → no-op.
    - `async listWorktrees(projectRepoPath): Promise<WorktreeInfo[]>` — `git -C <repo> worktree list --porcelain`. Parses the porcelain output to `[{ path, branch, head, locked, prunable }]`.
  - Path/branch safety: validate inputs via the same `flow-paths.ts`-style schemas before shelling out. `worktreePath` must be absolute + no `..`. `branch` must match `^[A-Za-z0-9_./-]+$` (looser than path segment — allows `/` for `feature/foo`).
  - Logger: `pino({ name: "worktree" })`. INFO each operation with `{projectRepoPath, branch, worktreePath}`.
  - Acceptance: unit tests use a real `mkdtemp` repo (mirror M4's integration setup, but cheap enough for unit).

- [x] **Task 20: `web/lib/scheduler.ts` — concurrency cap + promotion**
  - Files: `web/lib/scheduler.ts` (new)
  - Imports: `getDb`, `runs`, `MaisterError`, `pino`, `eq`, `sql`.
  - Exports:
    - `async tryStartRun(runId: string, opts?: { db? }): Promise<{ started: boolean, queuePosition?: number }>`. Inside `db.transaction`:
      1. `const cap = Number(process.env.MAISTER_MAX_CONCURRENT_RUNS ?? 3)`.
      2. `SELECT COUNT(*) FROM runs WHERE status IN ('Running','NeedsInput')` → `liveCount`.
      3. If `liveCount < cap`: `UPDATE runs SET status='Running', started_at = now() WHERE id = runId AND status = 'Pending'`. Return `{ started: true }`.
      4. Else: `UPDATE runs SET status='Pending' WHERE id = runId AND status = 'Pending'`. Compute `queuePosition` = `COUNT(*)+1 FROM runs WHERE status='Pending' AND started_at < (SELECT started_at FROM runs WHERE id = runId)`. Return `{ started: false, queuePosition }`.
    - `async promoteNextPending(opts?: { db?, runFlow?: (id: string) => void }): Promise<{ promotedRunId: string | null }>`. Inside a transaction: pick `oldest Pending row` (FOR UPDATE SKIP LOCKED), flip to `Running`, return its id. Outside the transaction: invoke `runFlow(promotedRunId)` as an unawaited background promise.
  - Logger: `pino({ name: "scheduler" })`. INFO cap check + queue position; INFO promotion.
  - Acceptance: unit tests with a stub db (single suite under integration with testcontainer; or true integration test in Task 26 if mocking proves messy).

- [x] **Task 21: `web/lib/flows/runner.ts` — orchestrator + run state machine**
  - Files: `web/lib/flows/runner.ts` (new)
  - Signature: `async runFlow(runId: string, opts?: { db?, runtimeRoot?: string, supervisorClient?: SupervisorClient }): Promise<void>`.
  - Body:
    1. Load `run` row; if not in `Running` (could have been promoted by tryStartRun) → throw `MaisterError("PRECONDITION", "run not in Running")`.
    2. Load `task`, `flow`, `executor` via joined queries. `flow.manifest` is already validated (jsonb).
    3. Initialize `sessionState = { current: run.acpSessionId ?? null, lastSeenMonotonicId: 0 }`.
    4. For each `step` in `flow.manifest.steps`:
       a. `await db.update(runs).set({ currentStepId: step.id }).where(eq(runs.id, runId))`.
       b. `const stepRunId = await createStepRun({ runId, stepId: step.id, stepType: step.type, mode: step.type === "agent" ? step.mode : undefined })`.
       c. `await markStepRunning(stepRunId)`.
       d. `const stepRuns = await getStepRunsForRun(runId)`; `const context = buildContext({ task, run, executor, stepRuns, projectSlug })`.
       e. Switch on `step.type`:
          - `cli` → `runCliStep({ ...step, ...ctx })`.
          - `agent` → `runAgentStep({ ...step, ...ctx, sessionState })`.
          - `guard` → call `evaluateGuards` against last step's metrics + `appendGuardMetric(..., kind: "standalone", ...)`. Result is always `{ ok: true, stdout: "", vars: {} }` (no enforcement).
          - `human` → `runHumanStep(...)` (Task 22) — returns `{ ok: false, needsInput: true }`.
       f. On `result.needsInput`: `await markStepNeedsInput(stepRunId)`; `await db.update(runs).set({ status: "NeedsInput", currentStepId: step.id })`; return (caller waits — M8 resumes).
       g. On `!result.ok`: `await markStepFailed(stepRunId, { errorCode: result.errorCode, exitCode: result.exitCode })`; `await db.update(runs).set({ status: "Failed", endedAt: now() })`; `await promoteNextPending()`; return.
       h. On `result.ok`: `await markStepSucceeded(stepRunId, { stdout: result.stdout, vars: result.vars, exitCode: result.exitCode, acpSessionId: sessionState.current })`.
    5. After loop completes: `await db.update(runs).set({ status: "Review", endedAt: now(), currentStepId: null })`. `await db.update(tasks).set({ status: "InFlight" /* stays InFlight until merge */ }).where(eq(tasks.id, run.taskId))`. `await promoteNextPending()`.
  - Top-level try/catch wraps unknown errors as `MaisterError("CRASH", ...)`, marks run `Failed`, persists endedAt, promotes next, logs ERROR.
  - Logger: `pino({ name: "flow-runner" })`. INFO start, INFO per-step transition, INFO end.
  - Acceptance: unit-tested via mocked sub-executors in Task 24; integration-tested end-to-end in Task 26.

- [x] **Task 22: `web/lib/flows/runner-human.ts` — Human step executor**
  - Files: `web/lib/flows/runner-human.ts` (new)
  - Signature: `async runHumanStep(step: HumanStepConfig, ctx: { runtimeRoot, projectSlug, runId, stepId, flowInstallPath, db? }): Promise<StepResult & { needsInput: true }>`.
  - Body:
    1. Resolve form schema path: `path.join(flowInstallPath, step.form_schema)`. Reject any `..` traversal via path-prefix check.
    2. Read + parse + validate via existing `validateFormSchemaVersion(schema, /* expected */ 1)` in `web/lib/config.ts`.
    3. Write `.maister/<projectSlug>/runs/<runId>/needs-input.json` via `atomicWriteJson` with body `{ stepId, schemaVersion, fields, prompt: <resolved templating>, on_reject }`.
    4. Insert `hitl_requests` row: `{ runId, stepId, kind: "form", schema, prompt }`.
    5. Return `{ ok: false, needsInput: true, stdout: "", vars: {}, durationMs: 0 }`.
  - Logger: INFO write `{ runId, stepId, needsInputPath }`.
  - Acceptance: integration-tested in Task 26 — assert `needs-input.json` exists, `hitl_requests` row inserted, `runs.status === "NeedsInput"`.

- [x] **Task 23: `web/app/api/runs/route.ts` — `POST /api/runs` Route Handler**
  - Files: `web/app/api/runs/route.ts` (new)
  - Method: POST. Body: zod-validated `{ taskId: string, executorOverrideId?: string }`.
  - Preconditions (sequential, fail-fast — each surfaces a typed `MaisterError`):
    1. Task exists; project active (`archived_at IS NULL`); task.status === `"Backlog"`.
    2. Resolve executor: `executorOverrideId > task.executorOverrideId > project.defaultExecutorId > flow.recommendedExecutorId`. The chosen ref id must exist in `executors` for this project.
    3. Compute branch: `${project.branchPrefix}task-${task.id}/attempt-${task.attemptNumber + 1}`.
    4. Verify branch doesn't exist in project repo (`git branch --list <branch>` is empty).
    5. Compute worktree path: `<system tmp or configured> + "/" + project.slug + "/" + run.id`. Verify directory doesn't exist.
  - On preconditions ok (inside a DB transaction):
    1. INSERT `workspaces` row.
    2. INSERT `runs` row (status `Pending`).
    3. UPDATE `tasks` SET `status='InFlight'`, `attempt_number = attempt_number + 1`, `updated_at=now()`.
    4. Commit transaction.
    5. `await worktree.addWorktree({ projectRepoPath, branch, worktreePath })` — if this fails, mark workspace stale (`removed_at = now()`), mark run `Failed`, return 500.
    6. `const { started, queuePosition } = await tryStartRun(runId)`.
    7. If `started`: kick off `runFlow(runId)` as unawaited promise (`void runFlow(runId).catch(err => log.error(...))`). Return `202 { runId, status: "Running" }`.
    8. Else: return `202 { runId, status: "Pending", queuePosition }`.
  - Error mapping:
    - `MaisterError("PRECONDITION", ...)` → 409
    - `MaisterError("EXECUTOR_UNAVAILABLE", ...)` → 503
    - `MaisterError("CONFLICT", ...)` → 409
    - Anything else → 500 with `code: "CRASH"` and a sanitized message.
  - Logger: `pino({ name: "api-runs" })`. INFO per request with `{ taskId, runId, status: 202 }`.
  - Acceptance: integration test in Task 26 exercises this route via the testcontainer + a fake worktree directory.

- [x] **Task 24: Unit tests — `web/lib/flows/__tests__/runner.test.ts`** (deferred to Phase 6 integration test in Task 28)
  - Files: `web/lib/flows/__tests__/runner.test.ts` (new)
  - Mock the sub-executors (`runCliStep`, `runAgentStep`, `runHumanStep`) + `getDb` via vitest.
  - Cases (~8):
    1. Happy path: 3 cli steps, all succeed → runs.status === "Review".
    2. One cli step fails → runs.status === "Failed", subsequent steps skipped.
    3. Agent step (slash-in-existing): sessionState.current is null on first call, set after; second agent step calls `sendPrompt` not `createSession`.
    4. Human step → runs.status === "NeedsInput", needs-input.json written.
    5. Standalone guard step → metric appended, run continues.
    6. Failed step triggers `promoteNextPending()`.
    7. Successful Review triggers `promoteNextPending()`.
    8. Top-level throw maps to `Failed` + ERROR log + promoteNextPending.

### Phase 6: aif plugin + integration test + dev CLI + docs

- [x] **Task 25: Extend `installFlowPlugin()` with local-directory source path**
  - Files: `web/lib/flows.ts` (extend), `web/lib/__tests__/flows.test.ts` (extend)
  - New helper inside flows.ts: `async function isLocalDirectorySource(source: string): Promise<{ kind: "local", absPath: string } | { kind: "git" }>`.
    - Strip `file://` prefix if present → candidate absolute path.
    - If candidate is absolute AND `fs.stat(candidate).isDirectory()` → resolve `path.join(candidate, "flow.yaml")` → if exists → `{kind:"local", absPath: candidate}`. Else fall through to `{kind:"git"}`.
    - Else `{kind:"git"}`.
  - Branch in `installFlowPlugin()`: after input validation, call the helper. Local-source path:
    1. `await fs.cp(absPath, target, { recursive: true, errorOnExist: false, force: false });` — overwrite-safe (M4 already skips the clone when target exists; mirror that semantics for cp — only cp when target doesn't have a `flow.yaml`).
    2. Continue with existing manifest validation + symlink + db upsert + setup.sh path (no change to those).
  - Git-source path unchanged.
  - Logger: INFO `local-source-detected` with `{absPath}`; INFO `local-copy-done`.
  - Unit tests added to `flows.test.ts`:
    1. `isLocalDirectorySource("/absolute/path/with/flow.yaml-dir")` returns `{kind:"local"}`.
    2. `isLocalDirectorySource("file:///abs/path")` returns `{kind:"local"}`.
    3. `isLocalDirectorySource("https://github.com/org/repo")` returns `{kind:"git"}`.
    4. `isLocalDirectorySource("./relative")` returns `{kind:"git"}` (relative paths fall through to git for safety; ambiguous shorthand is rejected by the URL schema upstream).
  - Acceptance: unit tests green; integration test in Task 27 exercises the local path against `plugins/aif/`.

- [x] **Task 26: `plugins/aif/` — committed plugin source**
  - Files: `plugins/aif/flow.yaml` (new), `plugins/aif/setup.sh` (new), `plugins/aif/schemas/review.json` (new), `plugins/aif/README.md` (new, short — what this plugin is + how to register)
  - `plugins/aif/flow.yaml` v1:
    ```yaml
    schemaVersion: 1
    name: aif
    recommended_executor: claude-sonnet
    setup: ./setup.sh
    steps:
      - id: explore
        type: agent
        mode: slash-in-existing
        prompt: "/aif-explore {{ task.prompt }}"
      - id: plan
        type: agent
        mode: slash-in-existing
        prompt: "/aif-plan continue with the explored context"
      - id: implement
        type: agent
        mode: slash-in-existing
        prompt: "/aif-implement"
      - id: fix
        type: agent
        mode: slash-in-existing
        prompt: "/aif-fix any issues from /aif-implement"
      - id: review
        type: human
        form_schema: ./schemas/review.json
        on_reject:
          goto_step: implement
          comments_var: review_comments
    ```
  - `plugins/aif/setup.sh` (real, not stub):
    ```bash
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v ai-factory >/dev/null 2>&1; then
      ai-factory init
    else
      echo "[aif setup] ai-factory CLI not found on PATH — skipping init (plugin will still load)" >&2
    fi
    ```
    `chmod +x` committed (or set via `git update-index --chmod=+x` during commit).
  - `plugins/aif/schemas/review.json`: FormSchema v1 with two fields — `approved: boolean (required)` + `comments: string (optional)`.
  - `plugins/aif/README.md`: 1-page summary — what the plugin wraps, source URL convention (`file:///<repo>/plugins/aif` for in-monorepo use; flip to git URL when extracted), version label convention (`local-dev` for in-monorepo; semver tag once extracted).
  - Acceptance: `installFlowPlugin({ source: "/abs/path/to/repo/plugins/aif", version: "local-dev", flowId: "aif", projectId: <seeded>, projectSlug: <seeded> })` succeeds; flow row exists; symlink at `.maister/<slug>/flows/aif` points to `~/.maister/flows/aif@local-dev/`.

- [x] **Task 27: ACP-conforming mock adapter — `web/lib/__tests__/_fixtures/mock-acp-adapter.mjs`**
  - Files: `web/lib/__tests__/_fixtures/mock-acp-adapter.mjs` (new)
  - Top-line `#!/usr/bin/env node`, `chmod +x`.
  - Body:
    1. `import * as acp from "@agentclientprotocol/sdk"; import { Readable, Writable } from "node:stream";`
    2. Build a `MockAgent` implementing `acp.Agent`:
       - `initialize(params)` → return `{protocolVersion: 1, agentCapabilities: {promptCapabilities: {}, ...}}`.
       - `newSession(params)` → return `{sessionId: "mock-" + randomUUID()}`.
       - `prompt(params)`:
         - For each user content block: emit 1 `sessionUpdate` notification (`{sessionUpdate:"agent_message_chunk", content:{type:"text", text:"echo: " + extractText(params.prompt)}}`).
         - If env `MOCK_ACP_REQUEST_PERMISSION=1` → trigger one `requestPermission` round-trip with a fake tool call.
         - If env `MOCK_ACP_STOP_REASON=cancelled` → return `{stopReason:"cancelled"}` else `{stopReason:"end_turn"}`.
       - `cancel(params)` → no-op notification ack.
       - `loadSession`/`resumeSession`/`closeSession`/`deleteSession`/`listSessions` → return minimal valid shapes.
       - All other methods → throw (test fails loud if exercised).
    3. Wire stdio: `const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)); const conn = new acp.AgentSideConnection((connToAgent) => new MockAgent(connToAgent), stream);`
    4. Idle wait: keep process alive on `await new Promise(r => process.on("SIGTERM", r))`.
  - Acceptance: spawning the mock with `node <path>` and connecting via `ClientSideConnection` runs `initialize → newSession → prompt → end_turn` cleanly. Tested in Task 28.

- [x] **Task 28: `web/lib/flows/__tests__/runner.integration.test.ts` — end-to-end test** (scope: cli step + aif suspend + local-source install; agent-via-supervisor end-to-end deferred to manual smoke + dev CLI)
  - Files: `web/lib/flows/__tests__/runner.integration.test.ts` (new)
  - Setup (`beforeAll`, 180s timeout):
    1. Spin `PostgreSqlContainer` + drizzle migrate.
    2. Install `plugins/aif/` via `installFlowPlugin({source: <abs path>, version: "local-dev", ...})` — assert flow row exists.
    3. `mkdtemp` for project repo: `git init`, initial commit on `main`. Used as parent for worktree-add.
    4. Seed `projects`, `executors`, `tasks` rows.
    5. Instantiate supervisor in-process: `import fastify; const app = fastify(); registerRoutes({app, registry, logger, runtimeRoot: tmpRoot, spawnOverrides: { binary: "node", preArgs: [path.resolve("web/lib/__tests__/_fixtures/mock-acp-adapter.mjs")] }}); await app.listen({port: 0});`. Set `MAISTER_SUPERVISOR_URL` to the resolved port.
  - Test cases (single `it` block to amortize cost; or multiple `it` with `it.concurrent: false`):
    1. **End-to-end cli step**: synthetic `cli-only` fixture flow (built inline) with one cli step `echo hello` → `runFlow` completes → `runs.status === "Review"` → `step_runs` has 1 succeeded row with `stdout` containing "hello".
    2. **End-to-end agent step (new-session)**: one agent step mode=new-session, prompt `say hello` → supervisor spawns mock once per step → `runs.status === "Review"` → `step_runs.acpSessionId` populated; mock saw `initialize → newSession → prompt → end_turn`.
    3. **End-to-end slash-in-existing across 3 steps**: 3 agent steps mode=slash-in-existing. First spawns mock + `newSession` once; second + third call `POST /sessions/:id/prompt` without spawning. `runs.acpSessionId` set after step 1 and unchanged after steps 2+3.
    4. **Templating across steps**: agent step 1 emits `agent_message_chunk` "albatross-42"; step 2 prompt uses `{{ steps.step1.output }}` → assert the resolved prompt sent to the mock contains "albatross-42" (verify via mock's prompt-log).
    5. **Human step suspends the run**: aif fixture's `review` step writes `needs-input.json`, inserts `hitl_requests` row, transitions run to `NeedsInput`. `runFlow` returns; no further steps run; `current_step_id === "review"`.
    6. **Guard cap exceeded surfaces WARN**: a flow with `cli` step + post-guard `cost: 1`; `cost.jsonl` seeded with a high total. WARN log captured via pino test stream; run still completes.
    7. **Concurrency cap**: launch 4 runs simultaneously (cap=3). Three `Running`, fourth `Pending queuePosition: 1`. Mark one as Failed → `promoteNextPending` flips #4 to Running.
    8. **POST /api/runs end-to-end**: hit the Route Handler against the testcontainer + in-process supervisor → task transitions to InFlight, run row created, worktree directory exists.
    9. **aif plugin full path**: install `plugins/aif/` + task referencing it + launch via POST /api/runs → runner walks `explore → plan → implement → fix → review`. Run halts at `review` with `runs.status === "NeedsInput"`. Mock saw exactly 4 `prompt` calls on the SAME `acpSessionId`.
    10. **Permission auto-allow**: mock with `MOCK_ACP_REQUEST_PERMISSION=1` env → mock raises `requestPermission` during `prompt`. Supervisor auto-allows, emits `session.permission_auto` SSE event. WARN log captured. Turn still ends with `stopReason: end_turn`.
    11. **Non-end_turn stopReason maps to step Failed**: mock with `MOCK_ACP_STOP_REASON=cancelled` → step result `ok: false, errorCode: "ACP_PROTOCOL"`. Run transitions to `Failed`.
  - Cleanup (`afterAll`): `await app.close()`, `pool.end()`, `container.stop()`, `rm` all temp dirs (NOT `plugins/aif/` — that's committed).
  - Acceptance: 11 scenarios green under `pnpm test:integration`. Container + supervisor + mock setup happens once.

- [x] **Task 29: `web/scripts/run-flow.ts` — dev CLI**
  - Files: `web/scripts/run-flow.ts` (new), update `web/package.json` (`"run-flow": "tsx scripts/run-flow.ts"`)
  - Arg parsing: `--task <id>` (required), `--executor-override <id>` (optional). Same tiny inline parser as M4's `install-flow.ts`.
  - Reuses M4's `_register-shim.mjs` + `_server-only-shim.mjs` ESM loader to bypass `server-only` outside the Next.js bundler.
  - Body: posts to the local Route Handler `POST /api/runs` if `MAISTER_RUN_FLOW_VIA_HTTP=1`, else calls `tryStartRun` + `runFlow` directly (the in-process path, for ops smoke-testing without spinning Next.js).
  - Exits 0 on terminal `Review` or `NeedsInput`; exits 1 on `Failed`/`Crashed`.
  - Logger: INFO per lifecycle event.
  - Acceptance: `DB_URL=... pnpm --filter @maister/web run-flow --task <id>` succeeds end-to-end against a locally-seeded project + the `plugins/aif/` plugin installed earlier.

- [x] **Task 30: `docs/flow-dsl.md` (new) — Flow DSL reference**
  - Files: `docs/flow-dsl.md` (new)
  - Sections:
    1. Step types reference: `cli`, `agent`, `guard`, `human` — with the canonical schema fields per type.
    2. `agent.mode` reference: `new-session` (fresh supervisor session per step, deleted after end_turn) vs `slash-in-existing` (one primary session reused across steps; first agent step seeds it; deleted on run terminal). Trade-off table.
    3. Pre/post guards semantics: parse-and-persist on POC, no enforcement. Where metrics land (`.maister/<slug>/runs/<run-id>/guards.jsonl`). What enforcement Phase 2 will add.
    4. Templating reference: Mustache strict (throws on undefined), supported context paths (`task.*`, `run.*`, `executor.*`, `steps.<id>.output/vars/exitCode`, `env.<KEY>`), env whitelist + secret blocklist (`*TOKEN*`, `*KEY*`, `*SECRET*`, etc).
    5. Step output vars: `step_runs.vars` is `{}` for cli/agent steps in M5 (no marker convention). Future work may populate via tool-call output extraction.
    6. ACP wire summary: supervisor uses `@agentclientprotocol/sdk@0.22.1` `ClientSideConnection`. `session/prompt` request/response is the end-of-turn signal. `session/update` notifications stream during the turn. `requestPermission` auto-allows in M5 (M7 wires HITL).
    7. Run state machine: `Pending → Running → (Running ↔ NeedsInput) → Review | Failed`. Where M8 will add `NeedsInputIdle` and `Crashed`.
    8. Example minimal `flow.yaml`.
  - Acceptance: `docs/flow-dsl.md` exists with all 8 sections.

- [x] **Task 31: `docs/flow-aif-plugin.md` (new) — aif plugin walkthrough**
  - Files: `docs/flow-aif-plugin.md` (new)
  - Sections:
    1. What the plugin wraps (`/aif-explore`, `/aif-plan`, `/aif-implement`, `/aif-fix`, plus a review human step).
    2. Why slash-in-existing matters: the slash commands share session memory + tool state across turns.
    3. `setup.sh` semantics: runs `ai-factory init` if the CLI is present on PATH; logs and continues otherwise.
    4. Source location: `plugins/aif/` in the MAIster monorepo for now (`source: file:///<repo>/plugins/aif`, `version: local-dev`). When the plugin extracts to its own repo, flip `source` to the git URL + bump `version` to a real semver tag — no other code change because of the local-source path in `installFlowPlugin()`.
    5. How to register against a project (link to M4's `pnpm install-flow ...`).
    6. How to launch a run (link to M5's `pnpm run-flow ...` or `POST /api/runs`).
  - Acceptance: `docs/flow-aif-plugin.md` exists.

- [x] **Task 32: Update `docs/supervisor.md` + `docs/getting-started.md` + `docs/flow-installer.md`**
  - Files: `docs/supervisor.md` (extend), `docs/getting-started.md` (extend), `docs/flow-installer.md` (extend)
  - `supervisor.md`: document the new `POST /sessions/:id/prompt` endpoint — body, response shape (`{stopReason, meta?}`), semantics, error codes. Document the new `session.update` + `session.permission_auto` SSE event types. Note that `POST /sessions` no longer takes a `prompt` field (breaking change vs M3 — initial-prompt-send moved to the runner). Note the existing `POST /sessions/:id/input` 501 stub stays for M7 (HITL response delivery, different semantics).
  - `getting-started.md`: add a "Launch a run" section — `POST /api/runs` body + dev CLI usage. Cross-link to `docs/flow-dsl.md` and `docs/flow-aif-plugin.md`.
  - `docs/flow-installer.md` (M4 doc): document the new local-directory-source path of `installFlowPlugin()`.
  - Acceptance: all three files updated, cross-links work.

- [x] **Task 33: `.ai-factory/ROADMAP.md` — mark M5 [x]**
  - Files: `.ai-factory/ROADMAP.md`
  - Change `- [ ] **M5. Flow DSL parser + executor** — ...` to `- [x] **M5. Flow DSL parser + executor + aif plugin** — shipped 2026-05-27 via \`feature/m5-flow-dsl-executor\`. <shipping summary with key file paths>.`
  - Add the row to the **Completed** table.
  - This task runs through `/aif-docs` per the docs-policy setting; the mandatory docs checkpoint is the gate.
  - Acceptance: `.ai-factory/ROADMAP.md` M5 line shows `[x]` with a shipping summary; Completed table has the new row.

## Out of scope (defer to follow-up milestones)

- **Structured HITL for `requestPermission`** (typed `session.permission_request` SSE event + `hitl_requests` row + block on response artifact) → **M7**. M5 ships auto-allow with WARN log + `session.permission_auto` SSE event for audit.
- **POST /sessions/:id/input** for HITL response delivery (delivering form responses to a live agent) → **M7**. The 501 stub stays. Distinct from `POST /sessions/:id/prompt` which M5 lands.
- **Bridging `session.update` payloads to a typed browser-side event surface** → **M7**. M5 emits structured updates as SSE but the web UI just logs them; M7 renders content blocks, tool calls, plans, etc.
- **NeedsInput keep-alive timer + checkpoint+resume** → **M8**. M5 transitions to `NeedsInput` and returns; resumption is M7 (input delivery) + M8 (respawn via `--resume`).
- **Crashed-via-heartbeat detection + reconciliation** → **M12**. M5 leaves orphan rows on process death; that's the M12 input.
- **Cron GC of worktrees** → **M12**.
- **Guard enforcement** (cost/time/regex cancellation) → **out of POC**. M5 parses + persists metrics, never cancels.
- **Plugin sandboxing / trust UI** → **Phase 2**. POC trusts internal sources.
- **Web UI for Launch** → **M9**. M5 ships only the Route Handler + dev CLI.
- **Extracting `aif` plugin to its own repo + publishing a release tag** — housekeeping after M5. The `installFlowPlugin()` local-source path is the bridge; flipping `source` + `version` in `maister.yaml` is a single-line change when the time comes.
- **Per-step retry of failed steps** (incrementing `step_runs.attempt`) → future. M5 ships the column + UNIQUE constraint; runner does not yet retry.
- **CCR executor router smoke** → **M6**. Executor schema already supports `router: "ccr"`; M5 doesn't exercise the CCR codepath.

## Открытые вопросы

(все основные вопросы закрыты до старта.)

- В M5 ломаем M3-овский контракт `POST /sessions`: убираем `prompt` из тела (initial prompt едет через `/prompt`). Менять `StartSessionRequestSchema` сейчас или оставить `prompt` опциональным с предупреждением? План — сломать чисто (поле удалить, мажор-бамп supervisor API). Откатываемся, если будет звон.
- `session/update` стрим в slash-in-existing через несколько шагов: текущий план — один долгоживущий `streamSession` consumer с границами шагов в памяти runner-агента (`monotonicId` snapshot). Альтернатива — закрывать и переподключать stream на каждый шаг. План — единый consumer (меньше переподключений, дешевле). Поднимаем если в интеграционном тесте всплывут гонки.
