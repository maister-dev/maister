# Implementation Plan: User-facing cron schedules for Flow runs (`run_schedules`)

Branch: `feature/user-facing-cron-schedule`
Created: 2026-06-10
Mode: full (schema + engine + API + UI)

## Settings
- Testing: yes (unit + integration mandatory per phase; one e2e happy path)
- Logging: verbose (pino child loggers, matching `scheduler-tick` style)
- Docs: yes  # mandatory docs checkpoint; Phase 0 is docs/spec-first

## Roadmap Linkage
Milestone: "M28. User-facing run schedules (cron)" — new entry to add to
`.ai-factory/ROADMAP.md` at ship time; extends shipped M24 (P5 clock).
Rationale: `docs/pv/improvement-roadmap.md` *Owner-directed next bets §1*
explicitly builds user-facing cron schedules on the P5/M24 scheduler
("the M24 slice shipped the clock, atomic claim, …"); primitive **P5** is the
substrate this plan reuses without modification of its core.

---

## 0. Scope and ground truth

### 0.1 Goal

A per-project, member-gated recurring schedule that launches a REAL Flow run
for a task on a cron expression (IANA timezone), with overlap policy
(`skip | queue_one | start_anyway`), pause/resume/trigger-now, and last-run
feedback — driven by the EXISTING M24 tick. No second scheduler, no cap change.

### 0.2 Verified code facts this plan is built on

| Fact | Where |
| --- | --- |
| Engine reschedules jobs **generically in the claim CTE SQL** as pure interval math (`floor(elapsed/interval)+1`) — cron-next CANNOT be computed there | `web/lib/scheduler/jobs.ts:279-299` |
| Atomic claim = `FOR UPDATE SKIP LOCKED` + `NOT EXISTS` live-attempt filter + per-kind budget rank in one statement; claim limit 25, lease 300s | `web/lib/scheduler/jobs.ts:206-334` |
| Attempt ledger fenced: `recordJobAttemptResult` guarded by `status IN ('Claimed','Running')`; `PRECONDITION` from a handler → `Skipped` | `web/lib/scheduler/jobs.ts:362-419`, `tick-service.ts:120-142` |
| Tick = `ensureDefaultSchedulerJobs` → `reapStuckSchedulerAttempts` → claim → exhaustive `switch (job.jobKind)` | `web/lib/scheduler/tick-service.ts:47-119` |
| `system_sweep.default` seeded idempotently every tick (`ON CONFLICT DO NOTHING`, 60s cadence) — the pattern to copy for our dispatcher | `web/lib/scheduler/jobs.ts:152-183` |
| Budgets: `system_sweep=1`, `command=2`, `agent=1`, `flow=unbounded`; key mapping is an exhaustive switch | `web/lib/scheduler/budgets.ts`, `jobs.ts:116-129` |
| Fallback timer = fixed `setInterval`, default 60s, gated on `MAISTER_SCHEDULER_TIMER_ENABLED="true"`; primary trigger is token-auth `/api/cron/tick` | `web/lib/scheduler/timer.ts:20,62-66`, `instrumentation.ts:66-68` |
| `flow_run` handler: `target.taskId` → `launchRun(…, {actorUserId: null, authorize: noop})`; returns `Pending` w/ queuePosition at cap | `web/lib/scheduler/handlers/flow-run.ts` |
| `launchRun` gate: `task.status !== "Backlog"` → `PRECONDITION`; worktree created BEFORE the DB tx; tx inserts run (`Pending`) + workspace, flips task `InFlight` + bumps `attemptNumber`; compensation removes worktree on tx failure | `web/lib/services/runs.ts:235-240,652-662,738-804` |
| Branch per attempt: `${branchPrefix}task-${taskId}/attempt-${N}` — git branch collision is the de-facto serializer for concurrent launches | `web/lib/services/runs.ts:599` |
| Execution is fully owned downstream of `launchRun`: it kicks `void runFlow(runId)` in the background when a slot starts (`runs.ts:806-814`), and `promoteNextPending` has a DEFAULT dynamic-import `runFlow` dispatch (`scheduler.ts:213-217`) — scheduler-launched runs AND `start_anyway` Pending runs execute with zero extra wiring | verified |
| `recordJobAttemptResult` accepts an optional `summary` jsonb (`jobs.ts:362-380`) — currently unused by handlers; the dispatcher should populate it | verified |
| Admin UI `JOB_KINDS` is a hand-maintained `SchedulerJobKind[]` array (`scheduler-jobs-table.tsx:39`, reused by the create modal at `scheduler-job-edit-modal.tsx:304`) — adding the enum value does NOT compile-force it; the table renders `t(\`kind.${jobKind}\`)` for EVERY row, so the dispatcher row breaks visually without the i18n key | verified |
| Tab-branch wiring pattern: `tab === "mcps" ? <McpPanel isAdmin={…} servers={isAdmin ? await listProjectMcps(…) : []} slug={slug}/> : null` — role-aware inline server fetch | `app/(app)/projects/[slug]/page.tsx:255-261` |
| Global cap: `tryStartRun`/`promoteNextPending` count `status IN ('Running','NeedsInput','HumanWorking')` vs `MAISTER_MAX_CONCURRENT_RUNS` (default 3) under `pg_advisory_xact_lock`; over-cap run stays `Pending` + queuePosition (no throw) | `web/lib/scheduler.ts:48,123,191-202` |
| **DISCOVERED GAP**: `tasks.status` is a one-way latch. Writes in the whole non-test codebase: create→`Backlog`, launch→`InFlight` (`runs.ts:777`). NOTHING ever writes `Backlog`/`Done`/`Abandoned` back. The documented retry rule ("Latest run Failed\|Abandoned → task auto-returns to Backlog", web/CLAUDE.md) exists only as a **board projection** (`web/lib/board.ts:80-128`), so `launchRun` refuses every relaunch with `PRECONDITION "task is not in Backlog (got InFlight)"` | verified by exhaustive grep |
| Board derivation precedence: Crashed → own column; latest ∈ {Failed, Abandoned} → Backlog (retry); active statuses → flight columns | `web/lib/board.ts:80-128` |
| Run terminal writes are scattered (~10 sites: runner.ts, runner-graph.ts, state-transitions.ts, promote.ts) — there is NO single `setRunStatus` choke point | agent survey, spot-verified `runner.ts:855-890`, `promote.ts:443-455` |
| Run rows are never deleted by GC (GC removes worktrees/branches; `runs` rows persist; `runs.task_id` FK cascade only on task delete) | `web/lib/gc/*`, schema |
| `agent_schedules` (`trigger_type` incl `"cron"`, `agent_ref NOT NULL`) has ZERO runtime consumers — schema-only scaffolding for E4 agents-as-actors | `web/lib/db/schema.ts:679-714` |
| No cron library anywhere in the repo; no luxon/date-fns either | all `package.json` |
| Latest migration `0037_m27_runs_resolved_capability_set.sql`; journal v7 `{idx, version, when, tag, breakpoints}` | `web/lib/db/migrations/` |
| Authz: `requireProjectAction(projectId, action)` + `PROJECT_ACTION_MIN` (`launchRun`/`createTask` → `member`); admin-only = `requireGlobalRole("admin")` | `web/lib/authz.ts:46-60,224-238` |
| Route exemplar (runs family): zod `.strict()`, local `httpStatusForCode` (**CONFIG→400**, PRECONDITION/CONFLICT→409, EXECUTOR_UNAVAILABLE→503), auth-first, `projectId` derived from task row — never from body | `web/app/api/runs/route.ts` |
| Project tabs: `ProjectTab` union + `TABS` + query-param hrefs (`?tab=…`); board page `VALID_TABS` | `web/components/board/project-tabs.tsx:7-84`, `app/(app)/projects/[slug]/page.tsx:35-46` |
| Data-page conventions: view-only table + popup edit modal (focus trap, `role="alert"`), URL-synced filters; canonical: `components/admin/scheduler-jobs-table.tsx` + `scheduler-job-edit-modal.tsx` | web/CLAUDE.md §Data-management |
| i18n: `messages/en.json` + `ru.json`, flat per-feature namespaces, `getTranslations`/`useTranslations`; parity enforced by `web/lib/__tests__/i18n-parity.test.ts:26-37` | verified |
| Tests: unit globs `lib/**`, `app/**/__tests__/**`, `components/**`; integration globs `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts` (testcontainers postgres:16-alpine, self-contained per suite); e2e stub supervisor `web/e2e/_seed/stub-supervisor.ts` | `vitest.workspace.ts:17-27` |
| Concurrent-claim no-double-fire test precedent to mirror | `web/lib/scheduler/__tests__/jobs.integration.test.ts:54-72` |
| Next free ADR number: **ADR-071** (latest in file: ADR-070; ADR-066 sits out of order near the template). ⚠ Snapshot of 2026-06-10 — ADR numbers AND migration indices are globally sequential and other worktrees are active (`feature/review-comments-rework`, codex worktrees); **re-verify both against current `main` at implementation time and renumber if taken** (patch 2026-06-09-18.47 lesson) | `docs/decisions.md` |
| `croner` latest = **10.0.1** (zero-dep, MIT); `cron-parser` = 5.5.0 (pulls luxon) | `npm view`, 2026-06-10 |

### 0.3 Locked constraints honored

- Fires go through `launchRun` — full preconditions, gates, HITL, promotion. No side-channel.
- One clock: the M24 tick claims one **dispatcher job**; schedules are data it processes. No new timer, no `fs.watch`, no polling of run state (ADR-#1/ADR-060 preserved — see DQ6).
- Global cap untouched: over-cap behavior per overlap policy; `start_anyway` rides the existing Pending queue.
- Concurrency-safe via the same `FOR UPDATE SKIP LOCKED` idiom at the schedule-row level.
- Conventions: Drizzle migration + journal, `MaisterError` only, EN+RU i18n, view-table + edit-popup, membership authz, strict TS.

Out of scope (unchanged): `agent_tick` scheduling/E4, webhooks/event triggers, second clock/cap, schedules over the external MCP facade (Phase 2), auto-pause after N failed fires (Phase 2), flow-target schedules that mint a new task per fire (Phase 2, additive).

---

## 1. Design decisions (DQ1–DQ8 + the discovered gap)

### DQ1 — Storage: dedicated `run_schedules` table + ONE singleton dispatcher job

**Options considered**

| Option | Trade-off |
| --- | --- |
| (a) Extend `scheduler_jobs` with cron/tz/overlap cols; one engine job per schedule | Genuinely reuses claim/ledger per schedule, BUT the engine reschedules in SQL interval math (`jobs.ts:279-299`) — cron-next can't be computed there. The claim would advance `next_run_at` by a bogus interval, then TS code would re-write it post-handler; a crash between those two writes re-fires a daily schedule 60s later (double-launch window). Requires invasive surgery on the battle-tested claim CTE; violates the M24 expectation "`cadence_interval_seconds` MUST be the only M24 cadence model" (scheduler.md). |
| (b) Activate `agent_schedules` | Wrong shape (`agent_ref NOT NULL`, no task/cron-expr/overlap columns) and it is the reserved bridge for the E4 agents-as-actors epic — explicitly out of scope. Hijacking it blocks E4. |
| **(c) CHOSEN: new `run_schedules` table + one seeded dispatcher job** (`job_kind='run_schedule'`, id `run_schedule.dispatcher`, cadence 60s) whose handler claims due schedule ROWS with the same `FOR UPDATE SKIP LOCKED` idiom and computes cron-next in TS | Engine core untouched (claim CTE, budgets SQL, lease/reap all stay byte-identical); cron math lives in one TS module; `scheduler_jobs` stays interval-only so ADR-060's cadence invariant remains TRUE; mirrors the hg-sdlc `RunScheduleDispatchJob` reference design. Cost: a second (row-level) claim layer inside the handler — covered by its own no-double-fire integration test. |

Fire precision under (c) = dispatcher cadence (60s) = the tick's own fixed
cadence (`timer.ts:62-66`) — identical to what per-schedule engine jobs would
give. This is NOT a second scheduler: no new clock, no new timer; the
dispatcher is a normal polymorphic job on the one M24 tick, the same way
`system_sweep` composes the recovery sweeps.

The dispatcher job is seeded by `ensureDefaultSchedulerJobs` (same
`ON CONFLICT (id) DO NOTHING` pattern as `system_sweep.default`). Admins see it
on `/admin/scheduler` and can disable it — a deliberate global kill switch.
`createSchedulerJobSchema` does NOT get the new kind (admins cannot create
extra dispatchers; harmless but confusing duplicates are refused at the
schema).

### DQ2 — Cron library: `croner@^10`, wrapped, callers forbidden from cron math

- **`croner` 10.0.1**: zero dependencies, MIT, bundled TS types, native IANA
  timezone support via `Intl` (Node 24 ✓), documented DST behavior (skipped
  local times jump forward, repeated hour fires once), and a pure
  `new Cron(expr, { timezone }).nextRun(from)` API that computes occurrences
  WITHOUT starting timers (we never call `.schedule()` — the M24 tick stays the
  only clock).
- Rejected `cron-parser@5`: equally capable but drags `luxon` in as a runtime
  dependency; the repo deliberately has no date library.
- Wrapper `web/lib/run-schedules/cron.ts` is the ONLY module importing
  `croner`:
  - `validateCronExpression(expr, tz): void` — throws
    `MaisterError("CONFIG", …)`. Enforces **5-field** expressions only
    (reject seconds-field and `@nicknames`: split-on-whitespace length === 5)
    so resolution can never undercut the 60s tick.
  - `validateTimezone(tz): void` — IANA check (constructor throw +
    `Intl.supportedValuesOf("timeZone")`), `MaisterError("CONFIG")`.
  - `nextFireAt(expr, tz, from: Date): Date` — throws `CONFIG` if the
    expression can never match.
- Enforcement: add `no-restricted-imports` for `croner` (allow-listed for the
  wrapper) to `web/eslint.config.mjs`; plus the wrapper exports are the only
  API the service/dispatcher use.

### DQ3 — Target model: TASK (relaunch → attempt N+1); flow-target deferred

Each fire relaunches the schedule's **existing task** through `launchRun` —
exactly what the `flow_run` handler already does, what the 1:N task↔run
("ralph-loop") model was built for, and what keeps the board clean (no task
minted per fire). The schedule freezes the launch config hg-sdlc-style:
`{project (via task), task (carries flow + prompt), optional runnerId
override}`. `baseBranch`/`targetBranch` follow the task/project defaults
exactly like a plain Launch click; per-schedule branch overrides are Phase 2.

A FLOW-target mode ("create a task per fire") is deferred: it needs task
templating, board-noise policy, and a creation actor — additive later
(`target_kind` column default `'task'`).

What one fire creates: one `runs` row (+ workspace + worktree + ACP session)
via `launchRun`, with `attemptNumber = N+1`, same preconditions/gates/HITL/
promotion as a manual Launch. Cron fires pass
`{actorUserId: null, authorize: noop}` (trusted-scheduler precedent from
`handlers/flow-run.ts`); trigger-now passes the clicking user's id.

### DG — Discovered gap (MUST resolve; blocks the feature): persisted task status never returns to Backlog

`launchRun` requires `task.status === "Backlog"`, but nothing ever resets
`InFlight` back — the documented retry rule lives only in the board projection
(`deriveStage`). A schedule on any task whose attempt 1 failed would fire
`launch_failed (PRECONDITION)` forever; manual relaunch from the derived
Backlog column has the same latent 409.

**Decision: fix the gate at the root, in `launchRun`**, by accepting the
*effective* Backlog state the board already defines, via a new shared
classifier (single source of truth, used by both `launchRun` and the
dispatcher):

```
classifyTaskLaunchability(task, latestRun):
  task.status ∈ {Done, Abandoned}                  → 'target_terminal'
  task.status = Backlog ∧ latestRun = null          → 'launchable'   (fresh task)
  task.status = InFlight ∧ latestRun = null         → 'busy'         (anomalous remnant; refuse, unchanged)
  latestRun.status ∈ {Failed, Abandoned}            → 'launchable'   (board retry rule, attempt N+1)
  latestRun.status = Crashed                        → 'crashed'      (owes recover/discard — board precedence)
  latestRun.status = Done                           → 'target_terminal'
  latestRun.status ∈ {Pending, Running, NeedsInput,
                      NeedsInputIdle, HumanWorking,
                      Review}                       → 'busy'
```

- Explicit allow-lists on BOTH branches with a TS exhaustiveness check
  (`satisfies`-union assertion: classified-set === `RunStatus` union), so a
  future run status fails compilation until classified (fan-out rule).
- `latestRun` = `runs WHERE task_id = ? AND run_kind = 'flow' ORDER BY
  started_at DESC LIMIT 1` — same "latest run" notion the board uses.
- `launchRun` change: replace the `!== "Backlog"` throw with
  `classifyTaskLaunchability(...) !== 'launchable'` → same
  `MaisterError("PRECONDITION", …)` with the classification in the message.
  Everything downstream (worktree-before-tx, compensation, attempt bump) is
  untouched. Concurrency profile unchanged: two racers compute the same
  `attempt N+1` → same branch name → second `addWorktree` fails → existing
  compensation path (this is today's serializer for plain Backlog launches
  too).
- Existing tests asserting the old message: grep shows none (`"is not in
  Backlog"` appears in no test); `runs-launch-*.test.ts` fixtures use fresh
  Backlog tasks — unaffected. New unit matrix covers all 8 classifier rows.

This also un-breaks manual relaunch from the board — flagged in the summary as
a behavior change beyond the schedule feature itself (see unresolved Q1).

### DQ4 — `queue_one` state: a non-stacking flag, consumed by the dispatcher

- Columns: `queue_one_pending boolean NOT NULL DEFAULT false`,
  `queued_fire_at timestamptz NULL` (when the missed fire was flagged — UI
  shows "1 missed fire queued since …").
- Set when a `queue_one` schedule's fire is blocked (task busy OR cap full).
  Boolean = at most ONE queued catch-up regardless of how many fires were
  missed (name-faithful; cron keeps coming anyway).
- **Consumed inside the dispatcher tick**: the claim selects
  `enabled AND (next_fire_at <= now OR queue_one_pending)` in ONE
  `FOR UPDATE SKIP LOCKED` query — a due row runs the full fire path (and a
  successful launch ALSO clears the flag: the fire satisfies the catch-up; no
  double launch); a flagged-only row runs the catch-up path (launch without
  advancing `next_fire_at`). Still blocked → flag stays set, retried next tick.
- Latency: a freed slot is consumed within ≤1 tick (60s) — within the minute
  resolution cron itself has. Rejected alternative: hooking
  `promoteNextPending`/the ~10 scattered terminal-write sites for event-driven
  consumption — more coupling and new crash windows for a ≤60s win.
  `Pending` runs (from `start_anyway`) keep strict priority: the existing
  engine promotes them on slot release, before any tick-driven catch-up.
- Pause (`enabled=false`) CLEARS the flag (explicit user stop; a stale
  catch-up firing on resume would surprise). Resume does not recreate it.

### DQ5 — `trigger-now`: immediate inline dispatch through the same claim+fire core

Not "set `next_run_at` to the past" (would wait up to one tick — bad UX for a
button). `POST …/trigger` calls `dispatchScheduleNow(scheduleId, actor)`:

- Claims THE row (`FOR UPDATE SKIP LOCKED` by id, ignoring `next_fire_at`);
  zero rows claimed → `MaisterError("CONFLICT", "dispatch in progress")` (409).
- **Dispatching guard**: the row is NOT lock-held between tx1 and tx2 (the
  launch runs outside the lock), so trigger-now ALSO refuses with `CONFLICT`
  while `last_fire_outcome = 'dispatching'` AND `last_fired_at` is within the
  scheduler attempt timeout (300s) — prevents a concurrent second fire
  mid-launch. An OLDER `dispatching` row (W1 crash remnant) is past the window
  and may be triggered — the staleness escape that keeps W1 from bricking the
  button.
- Runs the exact same policy+fire core as the tick; does NOT advance
  `next_fire_at` (manual fire is out-of-band; the cron rhythm is untouched);
  allowed on a paused schedule (explicit user intent).
- Respects the overlap policy and the cap (locked constraint: no cap bypass):
  task busy → `skipped_task_busy` (or `catchup_queued` for `queue_one`);
  cap full + `start_anyway` → real `Pending` run with queue position.
- Response carries the outcome so the UI can toast it:
  `{outcome, runId?, queuePosition?, errorCode?}`.
- Race with a concurrent tick on the same due second: row lock serializes the
  dispatch; the loser path sees `task busy` (the winner's run is now active)
  → policy outcome, no duplicate. For `start_anyway` + cap headroom the
  worst case is one manual + one cron run — both explicitly requested;
  documented edge case.

### DQ6 — last-run feedback: dispatch outcome is written at fire time; run status is a read-time JOIN. No hooks, no polling.

Two distinct fields with different lifecycles:

- `last_fire_outcome` (+ `last_fired_at`, `last_fire_error`) — what the
  DISPATCH decided: `launched | queued_pending | catchup_queued |
  skipped_task_busy | skipped_cap | skipped_target_terminal | skipped_crashed |
  launch_failed | dispatching`. Written synchronously by the dispatcher (it IS
  the transition actor) — no polling by definition.
- `last_run_id` FK → `runs.id` (`ON DELETE SET NULL`) — the LAUNCHED run. Its
  terminal outcome is read by **joining `runs` at query time** in the list
  endpoint (`lastRunStatus` in the DTO). Run rows are never GC-deleted
  (verified — GC removes worktrees, not rows), so the join never goes stale;
  if the task (and cascading runs) is deleted, the schedule cascades away with
  it too (`task_id` FK).

Rejected alternative: denormalized `last_run_status` updated at the run's
terminal transition. There is no single terminal choke point (~10 scattered
write sites); instrumenting all of them (and every future one) for a value the
join gives for free violates Simplicity-First. The AC "schedule row reflects
the launched run's terminal status" is satisfied by the DTO/UI rendering the
joined live status — updated on the run's own transition, with zero polling
and zero new write paths.

### DQ7 — Overlap × cap: two orthogonal blocked-dimensions, decided per fire

Inputs, evaluated inside the claim transaction (reads only):
`launchability = classifyTaskLaunchability(task, latestRun)` (per-TASK
active-run check — any non-terminal run on the target task blocks, regardless
of which schedule/user launched it; stricter and safer than per-schedule) and
`capFull = countLiveRuns() >= maxConcurrentRunsCap()` (the EXISTING predicate
`status IN ('Running','NeedsInput','HumanWorking')`, extracted from
`web/lib/scheduler.ts` as an exported helper — never re-implemented).

| Condition (in precedence order) | `skip` | `queue_one` | `start_anyway` |
| --- | --- | --- | --- |
| `target_terminal` (task/latest-run Done, task Abandoned) | `skipped_target_terminal` | `skipped_target_terminal` (no flag — needs human action) | `skipped_target_terminal` |
| `crashed` (latest run Crashed — owes recover/discard) | `skipped_crashed` | `skipped_crashed` (no flag) | `skipped_crashed` |
| `busy` (active run on task) | `skipped_task_busy` | flag + `catchup_queued` | `skipped_task_busy` — **a second concurrent run per task is structurally impossible** (`launchRun` gate + branch-per-attempt); `start_anyway` only overrides the CAP dimension |
| cap full (task launchable) | `skipped_cap` | flag + `catchup_queued` | `launchRun` → run lands `Pending` + queue position (`queued_pending`) |
| free | launch | launch (+clear flag) | launch |

- For `skip`/`queue_one` the cap is pre-checked (no run row created — "skip
  means skip"). Benign race: pre-check passes but a concurrent launch takes
  the slot → `launchRun` returns `Pending` → recorded honestly as
  `queued_pending`. Documented, not fought.
- `launchRun` stays the final authority: any `MaisterError` from it →
  `launch_failed` + `last_fire_error = code: message` (bounded), and the
  dispatcher job attempt itself still records `Succeeded` (a refused fire is a
  schedule outcome, not an engine failure — prevents `consecutive_failures`
  from disabling the shared dispatcher because one schedule's repo is dirty).

### DQ8 — UI home: a `schedules` tab on the project board page; `/admin/scheduler` untouched

- Per-project, operational data (next fire / last outcome) → lives with the
  board, not buried in settings: add `"schedules"` to `ProjectTab` +
  `TABS` + labels (`project-tabs.tsx:7-84`) and `VALID_TABS` + a render branch
  in `app/(app)/projects/[slug]/page.tsx` — the query-param tab pattern
  (like `mcps`), server-fetching via a `lib/run-schedules/queries.ts` module.
- RBAC: view = `readBoard` (viewer); mutate (create/edit/delete/pause/
  trigger) = new `PROJECT_ACTION_MIN` entry **`manageSchedules: "member"`**
  (task requirement: member/owner-gated, NOT admin-only). Trigger-now also
  re-uses `launchRun`-equivalent member level by virtue of `manageSchedules`.
- `/admin/scheduler` keeps showing engine jobs; it gains only the
  `run_schedule` kind label (i18n) and thereby the dispatcher row =
  admin kill switch. Project schedules themselves are NOT admin-managed.

---

## 2. Data model

### 2.1 New table `run_schedules` (migration `0038_run_schedules.sql` + journal idx 38)

```
id                  text PK (uuid)
project_id          text NOT NULL  FK projects.id  ON DELETE CASCADE
task_id             text NOT NULL  FK tasks.id     ON DELETE CASCADE
name                text NOT NULL
cron_expr           text NOT NULL                  -- 5-field, validated
timezone            text NOT NULL                  -- IANA, validated
overlap_policy      text NOT NULL DEFAULT 'skip'   -- enum: skip|queue_one|start_anyway (app-level TS union)
runner_id           text NULL      FK platform_acp_runners.id ON DELETE SET NULL
enabled             boolean NOT NULL DEFAULT true
next_fire_at        timestamptz NOT NULL           -- precomputed by the cron wrapper
queue_one_pending   boolean NOT NULL DEFAULT false
queued_fire_at      timestamptz NULL
last_fired_at       timestamptz NULL
last_fire_outcome   text NULL                      -- enum above (DQ6)
last_fire_error     text NULL                      -- "CODE: message", bounded ≤500 chars
last_run_id         text NULL      FK runs.id      ON DELETE SET NULL
created_by_user_id  text NULL      FK users.id     ON DELETE SET NULL
created_at / updated_at timestamptz NOT NULL DEFAULT now()
```

Indexes: `(project_id)`, `(task_id)`, `(enabled, next_fire_at)` (dispatcher
due-scan), `(last_run_id)` (FK SET NULL + join). Follow migration `0027` style
(`DO $$ … duplicate_object` FK guards, `CREATE INDEX IF NOT EXISTS`). No DB
enums — text + TS unions, matching every other table.

`scheduler_jobs` / `scheduler_job_runs` get NO new columns — only the new
`job_kind` value `'run_schedule'` in the TS enum (text columns need no DDL).

### 2.2 Catch-up = one fire, no backfill (inherent)

At claim time the dispatcher advances `next_fire_at = nextFireAt(expr, tz,
from = now)` — computing from NOW collapses any number of missed slots into
the single fire being dispatched, exactly mirroring the engine's documented
catch-up semantics (scheduler.md "Catch-up without backfill").

### 2.3 Fire pipeline: two-phase commit + crash windows (multi-store rule)

Stores touched per fire: `run_schedules` row; `runs`+`workspaces`+`tasks`
(inside `launchRun`'s own tx); git worktree (external side effect inside
`launchRun`); `scheduler_job_runs` (engine ledger, independent).

```
tx1 (short, row-locked claim — NO side effects inside):
   SELECT … FOR UPDATE SKIP LOCKED  (due OR queue_one_pending, enabled,
                                     JOIN projects: archived_at IS NULL —
                                     archived projects never fire)
   reads: task + latest run + countLiveRuns          → decision per DQ7 matrix
   non-launch outcomes (all skips, catchup_queued):
       write final outcome + flag + advance next_fire_at   → COMMIT, done (single store, atomic)
   launch outcomes:
       write last_fire_outcome='dispatching', last_fired_at=now,
       advance next_fire_at (cron fires only; trigger-now skips the advance),
       clear queue_one_pending                              → COMMIT
side effect:  launchRun(...)   (worktree + its own DB tx; NOT under our row lock)
tx2:          write final outcome (launched|queued_pending|launch_failed),
              last_run_id, last_fire_error
              — CAS-guarded: WHERE id = ? AND last_fire_outcome = 'dispatching'
                (a concurrent edit/delete/later-fire wins; 0 rows updated →
                WARN "stale dispatch result dropped", never clobber)
```

The tx2 CAS carries the expected prior state into the write (patch
2026-06-09-19.18 lesson: lifecycle persistence must CAS on expected state,
never update by id alone).

Intent (`dispatching`) is durably recorded BEFORE the side effect; the
completion marker (final outcome + `last_run_id`) AFTER — two-phase rule
satisfied. Enumerated crash windows (process death):

| Window | Resulting state | Recovery |
| --- | --- | --- |
| W1: after tx1, before `launchRun` | `dispatching`, no run, `next_fire_at` already advanced | The fire is LOST BY DESIGN (at-most-once launch — a retry here is what double-fires runs). Next cron fire proceeds normally and overwrites the stale outcome. UI renders `dispatching` as "dispatching…". Documented in run-schedules.md edge cases. |
| W2: after `launchRun`, before tx2 | run EXISTS (visible on the board), schedule stuck `dispatching`, no `last_run_id` | Self-heals at the next fire; the run itself is fully owned by the normal run lifecycle. No orphan resource: `launchRun`'s own compensation already covers ITS internal windows. |

No deferreds are created anywhere in this feature (deferred-release rule: N/A).

The dispatcher processes at most **10 schedules per tick** (claim `LIMIT 10
ORDER BY next_fire_at ASC NULLS LAST`) so a burst of due schedules cannot blow
the 300s job lease (each launch does git work). Unclaimed due rows stay due —
picked up next tick. Log a WARN when the limit truncates.

---

## 3. API contract (all under `app/api/projects/[slug]/schedules/`)

Error mapping: local `httpStatusForCode` identical to the runs-family exemplar
(`web/app/api/runs/route.ts`): CONFIG→400, PRECONDITION/CONFLICT→409,
UNAUTHENTICATED→401, UNAUTHORIZED→403, EXECUTOR_UNAVAILABLE→503, else 500.
Auth-first ordering exactly like that route. No new `MaisterError` codes.

Identifier provenance per route (trust-boundary rule):

| Route | Identifiers |
| --- | --- |
| `GET /api/projects/{slug}/schedules` → `{schedules: ScheduleDTO[]}` | `slug` = url-param → project row (server-state); authz `readBoard` |
| `POST …/schedules` → 201 `{schedule}` | `slug` = url-param; **`taskId` = body-controlled cross-resource id → MUST be compared against server state: `task.projectId === project.id` else `PRECONDITION` 409**; `runnerId` = body-controlled → existence-checked against `platform_acp_runners` (CONFIG 400); `cronExpr`/`timezone` → wrapper validation (CONFIG 400); reject `task.status === 'Abandoned'` (PRECONDITION) |
| `PATCH …/schedules/{scheduleId}` → 200 `{schedule}` | `slug`, `scheduleId` = url-params; `schedule.projectId === project.id` else 404; ONE aggregating transactional PATCH (any subset of `name, cronExpr, timezone, overlapPolicy, runnerId, enabled`) — never per-field fan-out. `runnerId: null` clears (SET/CLEAR/RE-SET symmetry tested). `cronExpr`/`timezone` change OR `enabled: true` (resume) → recompute `next_fire_at` from now. `enabled: false` (pause) → clear `queue_one_pending`+`queued_fire_at`. Empty body → CONFIG 400. |
| `DELETE …/schedules/{scheduleId}` → 200 `{ok: true}` | url-params as above; hard delete; launched runs are untouched |
| `POST …/schedules/{scheduleId}/trigger` → 200 `{outcome, runId?, queuePosition?, errorCode?}` | url-params as above; no body; side-effect route → two-phase semantics of §2.3 apply (the trigger shares `dispatchScheduleNow`); failure classes: row busy → CONFLICT 409; launch refusal → 200 with `outcome: 'launch_failed', errorCode` (the dispatch itself succeeded and recorded the outcome); supervisor down inside launchRun → same (`launch_failed`, `EXECUTOR_UNAVAILABLE` recorded) |

Mutating routes authz: `requireProjectAction(project.id, "manageSchedules")`
(new `PROJECT_ACTION_MIN` entry, `member`). zod `.strict()` schemas; name
1–120 chars; cronExpr 1–100 chars.

`ScheduleDTO`: `{id, name, taskId, taskTitle, cronExpr, timezone,
overlapPolicy, runnerId, enabled, nextFireAt, queueOnePending, queuedFireAt,
lastFiredAt, lastFireOutcome, lastFireError, lastRunId, lastRunStatus,
createdAt, updatedAt}` — `taskTitle` and `lastRunStatus` joined at read time.

---

## 4. Consumer fan-out checklists (mandatory greps before each phase gate)

**New `job_kind` value `'run_schedule'`** must land in ALL of:
`SCHEDULER_JOB_KINDS` + `SchedulerJobKind` (schema.ts — both `scheduler_jobs`
and `scheduler_job_runs` text-enum arrays), `schedulerBudgetForKind`
(exhaustive switch — compile-forced), `SchedulerBudgetKey`+`schedulerBudgetLimits`
(budgets.ts; budget = 1, hardcoded like `system_sweep` — serial dispatcher, no
env var), `runClaimedJob` switch (tick-service.ts — compile-forced),
`ensureDefaultSchedulerJobs` (seed `run_schedule.dispatcher`, 60s),
`createSchedulerJobSchema` (deliberately NOT added — rejection is the
contract; assert in a route test), **admin UI `JOB_KINDS` arrays — these are
hand-maintained `SchedulerJobKind[]` lists, NOT compile-forced**: add
`run_schedule` to the table FILTER array (`scheduler-jobs-table.tsx:39`) but
keep it OUT of the create-modal kind list (`scheduler-job-edit-modal.tsx:304`
— split the shared array if needed, otherwise the modal would offer a kind the
API rejects), i18n `adminScheduler.kind.run_schedule` EN+RU (**mandatory** —
the table renders `t(\`kind.${jobKind}\`)` for the dispatcher row; missing key
is user-visible), tick route jobKind filter (auto via `isSchedulerJobKind`),
tick-service `run_schedule` case passes the dispatch summary
(`{fired, skippedBusy, skippedCap, skippedTerminal, catchupQueued,
launchFailed, truncated}`) into `recordJobAttemptResult`'s existing `summary`
param — structured truncation flag, never log-only (patch 2026-06-09-13.01
lesson), `docs/system-analytics/scheduler.md`,
`docs/api/web.openapi.yaml` (grep for the jobKind enum in admin scheduler
paths and extend), `docs/db/scheduler-domain.md` + `docs/database-schema.md`.

**New RBAC action `manageSchedules`**: `PROJECT_ACTION_MIN` (authz.ts), authz
unit tests, `docs/system-analytics/identity-access.md` action table (if
enumerated there — grep), run-schedules.md.

**New table `run_schedules`**: schema.ts + migration + journal,
`database-schema.md`, `db/scheduler-domain.md` ERD + `db/erd.md`,
run-schedules.md, OpenAPI components.

**Run-status classification**: the classifier's exhaustiveness assertion is
the guard — any future `RunStatus` addition fails compilation until classified
(this plan's contribution to the allow-list rule).

## 5. Deployment & contract surfaces

- New runtime dep: `croner@^10.0.1` → `web/package.json` + `pnpm-lock.yaml`.
  Pure JS lib — container builds pick it up via `pnpm install --frozen-lockfile`;
  no binary, no PATH concern.
- **No new env vars** (dispatcher cadence + budget are constants like
  `system_sweep`'s; the cap/tick/lease env vars are reused as-is) → NO
  `.env.example` / `compose*.yml` changes required. Stated here explicitly to
  close the deployment-touchpoints rule.
- No new ports, no new sidecars, no new config files.
- Contract surfaces → spec files: 5 HTTP routes → `docs/api/web.openapi.yaml`;
  new table → `docs/database-schema.md` + `docs/db/scheduler-domain.md` +
  `docs/db/erd.md`; no new error codes (`error-taxonomy.md` untouched — reuse
  CONFIG/PRECONDITION/CONFLICT); no SSE/AsyncAPI changes; no new
  `package.json` scripts; new domain doc `docs/system-analytics/run-schedules.md`
  + glossary row in `docs/CLAUDE.md`; ADR-071 in `docs/decisions.md`;
  scheduler.md amendments; root `CLAUDE.md` M24 bullet ("user-facing
  cron-schedule UI is a next bet") updated at ship time.

---

## Commit Plan

- **Commit 1** (Phase 0): `docs(run-schedules): ADR-071 + analytics/ERD/OpenAPI specs (Designed)`
- **Commit 2** (Phase 1): `feat(run-schedules): croner wrapper + run_schedules schema/migration`
- **Commit 3** (Phase 2): `feat(run-schedules): launchability classifier, dispatcher, run_schedule job kind`
- **Commit 4** (Phase 3): `feat(run-schedules): project schedules API + manageSchedules action`
- **Commit 5** (Phase 4): `feat(run-schedules): board Schedules tab UI (EN+RU)`
- **Commit 6** (Phase 5): `test(run-schedules) + docs: scenario suite, e2e, as-built flip`

Every phase exits only with `pnpm --filter maister-web typecheck && pnpm
--filter maister-web test:unit && pnpm --filter maister-web test:integration`
green (lint via check-only `eslint .` — NEVER bare `pnpm lint`, it reformats
the repo). Pre-existing reds, if any surface, get an explicit quarantine note
— never silent tolerance.

---

## Tasks

### Phase 0 — Analytics & contracts first (docs-first; no code)

- [x] **T0.1 — ADR-071 + domain analytics doc**
  - Deliverable: `docs/decisions.md` ADR-071 "User-facing run schedules on the
    M24 clock" (dispatcher-job design, croner choice, overlap×cap matrix,
    at-most-once fire, the launchRun effective-Backlog gate fix and why it
    extends ADR-060 without touching the cadence invariant; cite ADR-#4 cap +
    ADR-060). New `docs/system-analytics/run-schedules.md` per docs R5
    structure: Purpose; Domain entities; State machine (`enabled/paused` ×
    fire decision); Process flows (tick dispatch incl. the single-claim
    due-OR-catchup query, trigger-now, queue_one cycle); Expectations (≤12
    normative bullets incl. at-most-once fire, one-clock, cap reuse,
    DQ7 matrix invariants); Edge cases (W1/W2 crash windows, `dispatching`
    stale outcome, trigger-vs-tick race, DST skip/repeat, target_terminal
    skips — each with its `MaisterError` code; PLUS: archived-project
    schedules never fire; trigger-now vs fresh `dispatching` → CONFLICT with
    the 300s staleness escape; dispatcher auto-disables after
    `max_failures=3` consecutive engine-level failures — admin re-enable on
    `/admin/scheduler` is the documented kill-switch recovery); Linked
    artifacts. Tag everything `(Designed)`. Amend
    `docs/system-analytics/scheduler.md`: new `run_schedule` kind + dispatcher
    seed bullet + budget row; note that `cadence_interval_seconds` REMAINS the
    only scheduler_jobs cadence model (cron lives in `run_schedules`). Add
    glossary row to `docs/CLAUDE.md`. ⚠ Re-verify ADR-071 is still the next
    free number against current `main` before writing (parallel worktrees
    allocate concurrently); renumber if taken.
  - Files: `docs/decisions.md`, `docs/system-analytics/run-schedules.md`,
    `docs/system-analytics/scheduler.md`, `docs/CLAUDE.md`.
  - Verify: `pnpm validate:docs` green; ADR numbering sequential (071).

- [x] **T0.2 — ERD + OpenAPI (Designed)**
  - Deliverable: `run_schedules` in `docs/database-schema.md` narrative AND
    `docs/db/scheduler-domain.md` Mermaid `erDiagram` AND consolidated
    `docs/db/erd.md` (all three — the ERD rule). `docs/api/web.openapi.yaml`:
    the 5 paths of §3 with request/response schemas, status codes (400/401/
    403/404/409/503), `ScheduleDTO`, outcome enum; grep the admin
    scheduler-jobs paths for a jobKind enum and extend with `run_schedule`.
  - Files: `docs/database-schema.md`, `docs/db/scheduler-domain.md`,
    `docs/db/erd.md`, `docs/api/web.openapi.yaml`.
  - Verify: `pnpm validate:docs` + `npx @redocly/cli lint docs/api/web.openapi.yaml` zero errors.
  <!-- Commit checkpoint 1 -->

### Phase 1 — Foundation: cron core + schema

- [x] **T1.1 — croner dep + cron wrapper** (depends: T0.1)
  - Deliverable: `croner@^10.0.1` added to `web/package.json` (+ lockfile via
    `pnpm install`). `web/lib/run-schedules/cron.ts` per DQ2
    (`validateCronExpression`, `validateTimezone`, `nextFireAt`; 5-field-only;
    `MaisterError("CONFIG")`; croner used in pure-computation mode — assert no
    timer is ever started). `no-restricted-imports` rule for `croner` in
    `web/eslint.config.mjs` allow-listing the wrapper.
  - Tests (unit, `web/lib/run-schedules/__tests__/cron.test.ts`, runner:
    `unit` project glob `lib/**`): valid 5-field next-fire across fixtures;
    rejects 6-field/seconds/`@daily`/garbage/never-matching; rejects bad tz;
    DST spring-forward (skipped local time fires at the next valid instant)
    and fall-back (fires once) for a DST zone; non-DST zone sanity
    (`Europe/Moscow`); minute-floor preserved.
  - Logging: none (pure module) — errors carry context in messages.
  - Verify: typecheck + unit green; `eslint .` clean.

- [x] **T1.2 — `run_schedules` schema + migration 0038** (depends: T0.2)
  - Deliverable: table per §2.1 in `web/lib/db/schema.ts` (text-enum unions
    for `overlap_policy` + outcome; `$inferSelect` types exported:
    `RunSchedule`, `RunScheduleOverlapPolicy`, `RunScheduleFireOutcome`).
    Hand-written `web/lib/db/migrations/0038_run_schedules.sql` following the
    `0027` guard style + `meta/_journal.json` entry (idx 38, fresh `when` —
    beware the journal-`when` drift trap). ⚠ Re-verify 0038 is still the next
    free migration index against current `main` before writing (parallel
    worktrees allocate concurrently); renumber if taken.
  - Tests: covered by every integration suite's migrator run (testcontainers
    applies all migrations); add a minimal insert/select round-trip to the
    Phase-2 dispatch integration suite rather than a standalone one.
  - Verify: typecheck; `pnpm test:integration` green (migrator applies 0038).
  <!-- Commit checkpoint 2 -->

### Phase 2 — Engine & dispatch service

- [x] **T2.1 — Launchability classifier + `launchRun` relaunch gate fix (DG)** (depends: T1.2)
  - Deliverable: `web/lib/runs/launchability.ts` exporting
    `classifyTaskLaunchability` + `getLatestFlowRun(taskId)` per DG, with the
    TS exhaustiveness assertion over `RunStatus`. `launchRun`
    (`web/lib/services/runs.ts:235`) switches to the classifier; refusal
    message includes the classification. Grep confirms no test asserts the old
    message; board `deriveStage` is NOT modified.
  - Tests (unit): full 8-row classifier matrix; `launchRun` accepts
    InFlight+latest-Failed and InFlight+latest-Abandoned (attempt N+1 path),
    refuses busy/crashed/done/abandoned/InFlight-no-run — extend
    `web/lib/services/__tests__/runs-launch-*.test.ts` fixtures.
  - Logging: `log.info({taskId, classification}, "launch gate")` at DEBUG on
    accept, existing WARN path on refuse.
  - Verify: typecheck + unit + integration green (existing launch suites must
    stay green — assertion-migration check).

- [x] **T2.2 — Schedule service: CRUD + queries** (depends: T1.1, T1.2)
  - Deliverable: `web/lib/run-schedules/service.ts` —
    `createSchedule`/`updateSchedule`/`deleteSchedule` implementing §3
    semantics (validation via cron wrapper; task-project comparison; reject
    Abandoned task; recompute `next_fire_at` on create/cron/tz/resume; pause
    clears the queue_one flag; single transaction per mutation).
    `web/lib/run-schedules/queries.ts` — `listProjectSchedules(projectId)`
    returning `ScheduleDTO[]` with `taskTitle` + `lastRunStatus` joins.
  - Tests (unit with mocked db where shape-only; integration
    `web/lib/run-schedules/__tests__/service.integration.test.ts` for the
    transactional semantics incl. SET/CLEAR/RE-SET of `runnerId`, pause→flag
    cleared, resume→recompute-from-now).
  - Logging: pino child `run-schedules`; INFO per mutation
    `{scheduleId, projectId, action, actorUserId}`.
  - Verify: typecheck + unit + integration green.

- [x] **T2.3 — Dispatcher core + trigger-now** (depends: T2.1, T2.2)
  - Deliverable: `web/lib/run-schedules/dispatch.ts` —
    `dispatchDueSchedules({now, launch = launchRun, limit = 10})` (the
    injectable `launch` is the testability seam) implementing §2.3 pipeline +
    DQ7 matrix + DQ4 single-claim due-OR-catchup query (claim JOINs `projects`
    and excludes `archived_at IS NOT NULL`);
    `dispatchScheduleNow(scheduleId, {actorUserId})` per DQ5 (shared core; no
    `next_fire_at` advance; CONFLICT when row-locked OR when
    `last_fire_outcome='dispatching'` is fresher than the 300s attempt
    timeout — stale `dispatching` is triggerable, the W1 escape). tx2 final
    write is CAS-guarded `WHERE last_fire_outcome='dispatching'` (0 rows →
    WARN + drop stale result, never clobber a concurrent edit/delete/fire).
    `web/lib/scheduler.ts`: extract+export `countLiveRuns(dbOrTx)` and
    `maxConcurrentRunsCap()` from the existing inline predicate — the helper
    takes the caller's db/tx handle so `tryStartRun`/`promoteNextPending` keep
    counting INSIDE their advisory-lock transactions (predicate extraction
    only; locking stays in the callers — zero behavior change).
  - Tests: unit — pure policy-decision function over the full DQ7 matrix
    (9 condition×policy cells + precedence). Integration
    (`dispatch.integration.test.ts`): due fire launches via stubbed `launch`
    and advances `next_fire_at` (from NOW — catch-up collapse asserted with an
    overdue-by-3-slots schedule firing ONCE); skip/cap outcomes with seeded
    live runs (3 × `Running` rows); queue_one flag set then consumed on a
    later tick after freeing; **no-double-fire: `Promise.all` of two
    concurrent `dispatchDueSchedules` claims exactly one launch** (mirror
    `jobs.integration.test.ts:54-72`); trigger-now concurrent with a tick →
    one launch + one policy outcome; trigger does not advance `next_fire_at`;
    `launch_failed` records the MaisterError code and the dispatcher does NOT
    throw; W1-style `dispatching` row is overwritten by the next fire;
    trigger-now on a fresh `dispatching` row → CONFLICT, on a stale one →
    fires; stale tx2 (CAS 0-rows) drops with WARN; schedule on an archived
    project is never claimed.
  - Logging: INFO per decision `{scheduleId, outcome, runId, nextFireAt}`;
    DEBUG inputs `{liveCount, cap, launchability, due, catchup}`; WARN on
    `launch_failed` + on batch-limit truncation. Never log tokens/prompts.
  - Verify: typecheck + unit + integration green.

- [x] **T2.4 — `run_schedule` job kind fan-out + seed** (depends: T2.3)
  - Deliverable: every item in the §4 job-kind checklist — schema enums (both
    tables' arrays), budget key (limit 1, constant), `runClaimedJob` case
    calling `dispatchDueSchedules` AND passing its returned summary
    (`{fired, skippedBusy, skippedCap, skippedTerminal, catchupQueued,
    launchFailed, truncated}`) into `recordJobAttemptResult({…, summary})` —
    the param exists and is unused today, `ensureDefaultSchedulerJobs` seeds
    `run_schedule.dispatcher` (60s, kind `run_schedule`, `max_failures 3`),
    admin create-schema deliberately unchanged (rejection asserted), admin UI:
    add the kind to the FILTER `JOB_KINDS` array
    (`scheduler-jobs-table.tsx:39`) while keeping it OUT of the create-modal
    kind options (`scheduler-job-edit-modal.tsx:304` — split the array if
    shared), `adminScheduler.kind.run_schedule` EN+RU keys (mandatory — the
    dispatcher row renders the label).
  - Tests: extend `jobs.test.ts` (budget mapping), `jobs.integration.test.ts`
    (both default jobs seeded), admin route test (creating `run_schedule` kind
    → 4xx), tick-route test accepts the new jobKind filter.
  - Verify: typecheck + unit + integration green; grep `'run_schedule'` hits
    every checklist location.
  <!-- Commit checkpoint 3 -->

### Phase 3 — API routes

- [x] **T3.1 — `manageSchedules` action** (depends: T2.2)
  - Deliverable: `PROJECT_ACTION_MIN.manageSchedules = "member"` in
    `web/lib/authz.ts`.
  - Tests: extend authz unit tests (member allowed, viewer refused, global
    admin bypass).
  - Verify: typecheck + unit green.

- [x] **T3.2 — Routes: collection, item, trigger** (depends: T2.3, T3.1)
  - Deliverable: `web/app/api/projects/[slug]/schedules/route.ts` (GET list —
    `readBoard`; POST create — `manageSchedules`),
    `…/[scheduleId]/route.ts` (PATCH aggregate, DELETE),
    `…/[scheduleId]/trigger/route.ts` (POST → `dispatchScheduleNow` with the
    caller's `actorUserId`). Exactly the §3 contract: auth-first, slug→project
    server-state resolution, identifier comparisons, zod `.strict()`, local
    `httpStatusForCode` (CONFIG→400, runs-family exemplar), `{code, message}`
    error bodies.
  - Tests (unit, `app/api/projects/[slug]/schedules/__tests__/*.test.ts`,
    runner: unit glob `app/**/__tests__/**`): per route — happy path, authz
    refusals (viewer mutate → 403, unauthenticated → 401), cross-project
    `taskId` → 409, unknown `runnerId` → 400, bad cron/tz → 400, empty PATCH →
    400, schedule from another project → 404, trigger outcome pass-through
    incl. `launch_failed` 200 and row-busy 409.
  - Logging: route-level INFO/WARN matching `api-runs` style.
  - Verify: typecheck + unit + integration green.
  <!-- Commit checkpoint 4 -->

### Phase 4 — UI + i18n

- [x] **T4.1 — Schedules tab + table panel** (depends: T3.2)
  - Deliverable: `"schedules"` wired through `ProjectTab`/`TABS`/labels/hrefs
    (`web/components/board/project-tabs.tsx`) + `VALID_TABS` and a render
    branch in `app/(app)/projects/[slug]/page.tsx` following the mcps-branch
    pattern (`page.tsx:255-261`): inline server-fetch of
    `listProjectSchedules(project.id)` + `listTaskDTOs(project.id)` (task
    picker data) + a `canManage` boolean (project role ≥ member, computed like
    the page's existing role checks) passed to the panel —
    `readBoard`-visible, mutate affordances rendered only when `canManage`.
    `web/components/schedules/schedules-panel.tsx` + `schedules-table.tsx`
    (client, view-only table per conventions): name, task (title, link),
    `cronExpr`, timezone, overlap policy, enabled badge, **next fire rendered
    in the SCHEDULE's timezone** (`Intl.DateTimeFormat` with `timeZone`,
    `suppressHydrationWarning`), queued-catch-up indicator
    (`queue_one_pending` + since), last outcome chip + `lastRunStatus` chip
    linking to the run, empty state, full-width layout, `aria-busy` refresh.
  - Tests: render smoke test (unit, `vi.mock("next-intl")` convention).
  - Logging: none beyond fetch error surface (`role="alert"`).
  - Verify: typecheck + unit green; manual `pnpm dev` spot-check.

- [x] **T4.2 — Create/edit modal + row actions** (depends: T4.1)
  - Deliverable: `web/components/schedules/schedule-edit-modal.tsx` modeled on
    `scheduler-job-edit-modal.tsx` (create|edit single modal owning delete +
    confirm; focus trap, Escape, scroll lock, `aria-modal`, `role="alert"`
    errors): name, task select (project tasks w/ status badge), cron input
    (server-side validation surfaces CONFIG message inline), timezone select
    from `Intl.supportedValuesOf("timeZone")` (default = browser tz), overlap
    policy select with per-option explanations, optional runner select
    (options from the existing `GET /api/runs/launch-options` endpoint — the
    launch popover's source), enabled switch; task select fed by the `tasks`
    prop from T4.1's page fetch. Row actions on the table: pause/resume
    (PATCH `enabled`),
    trigger-now (POST; outcome rendered per enum — launched/queued/skipped/
    failed), edit, delete-with-confirm.
  - Tests: modal render + payload-shape unit test per repo precedent.
  - Verify: typecheck + unit green.

- [x] **T4.3 — i18n EN+RU** (depends: T4.1, T4.2)
  - Deliverable: new `projectSchedules` namespace in `messages/en.json` +
    `messages/ru.json` (tab label, table headers, outcome/policy labels, modal
    fields, confirmations, toasts) + `adminScheduler` kind label addition
    (`kind.run_schedule` — mandatory, see §4) — full key-tree parity; natural
    Russian, not machine-gloss.
  - Tests: existing `i18n-parity.test.ts` green (it enforces the tree).
  - Verify: unit green; RU visual spot-check via `NEXT_LOCALE=ru`.
  <!-- Commit checkpoint 5 -->

### Phase 5 — Scenario hardening, e2e, as-built docs

- [x] **T5.1 — End-to-end engine integration scenarios** (depends: T2.4, T3.2)
  - Deliverable: `web/lib/run-schedules/__tests__/tick.integration.test.ts`
    driving `runSchedulerTick()` (not the dispatcher directly): seeded due
    schedule fires through the claimed `run_schedule.dispatcher` job with the
    stubbed launch seam; dispatcher job attempt recorded `Succeeded` even when
    a schedule's fire is `launch_failed`; disabled dispatcher job (kill
    switch) → nothing fires; tick + trigger-now interleavings; pause stops
    firing / resume recomputes; full overlap×cap matrix at the tick level.
  - Verify: `pnpm test:integration` green; suite listed by the integration
    runner (`vitest list` spot-check — runnability rule).

- [x] **T5.2 — Playwright happy path** (depends: T4.3)
  - Deliverable: `web/e2e/run-schedules.spec.ts` on the stub-supervisor
    harness + seeded project/task: member creates a schedule (cron+tz+policy)
    via the modal → row shows with next fire time in its tz; pause/resume
    toggles; trigger-now surfaces an outcome; viewer sees the tab read-only
    (no mutate affordances). Kill any stale :3100 server first (harness
    gotcha).
  - Verify: `pnpm test:e2e` green locally.

- [x] **T5.3 — As-built docs flip + roadmap** (depends: T5.1, T5.2)
  - Deliverable: flip `(Designed)` → `(Implemented, M28)` across
    run-schedules.md / scheduler.md / ERD / OpenAPI annotations; root
    `CLAUDE.md` M24 bullet updated ("user-facing cron-schedule UI" shipped →
    point at run-schedules.md); `docs/pv/improvement-roadmap.md` Owner-directed
    §1 marked shipped; `.ai-factory/ROADMAP.md` gains the `[x] M28` as-built
    entry; verify every §5 contract-surface row landed (re-grep).
  - Verify: `pnpm validate:docs:all`, redocly lint, full suite green
    (`typecheck + test:unit + test:integration`), scoped `eslint .` clean.
  <!-- Commit checkpoint 6 -->

---

## Acceptance criteria → coverage map

| AC | Where proven |
| --- | --- |
| Member creates schedule (cron+tz+target+overlap) from UI; persists; next fire shown in its TZ | T4.1/T4.2 UI + T3.2 routes + T5.2 e2e |
| Existing tick fires at the right wall-clock time; real run via `launchRun` with full preconditions | DQ1/DQ3 design + T2.3/T2.4 + T5.1 tick-level integration |
| Over-cap: `skip` advances next-fire; `queue_one` one catch-up on slot free; `start_anyway` queues Pending | DQ7 matrix + T2.3 integration (seeded live runs) + T5.1 |
| Pause stops firing; resume recomputes; trigger-now launches once immediately | DQ5 + T2.2/T2.3 + T5.1/T5.2 |
| Schedule row reflects launched run's terminal status | DQ6 join (`lastRunStatus`) + T2.2 queries + T4.1 chip |
| No double-fire under overlapping ticks | T2.3 `Promise.all` claim test + engine's own claim (`jobs.integration.test.ts` precedent) |
| EN+RU labels; typed errors; migration in journal | T4.3 parity test; §3 (`MaisterError` only); T1.2 |

## Unresolved questions

1. Гэп ретраев: `tasks.status` никогда не возвращается в Backlog — чиню в
   `launchRun` через классификатор (вариант DG). Это чинит и ручной Launch с
   доски. Ок, или фиксить только на пути диспетчера?
2. `start_anyway` при занятой задаче = skip (второй параллельный ран на одну
   задачу невозможен структурно) — подтверди.
3. Trigger-now уважает overlap policy и cap (никогда не форсит) + разрешён на
   паузнутом расписании — ок?
4. `croner@10` (zero-dep) vs `cron-parser`+luxon — беру croner. Возражения?
5. `runner_id` override в расписании (паритет с Launch-диалогом) — оставить в
   v1 или выкинуть?
6. Дом UI: таб «Schedules» на странице борда (query-param, как mcps) — ок, или
   в settings?
7. Pause очищает отложенный queue_one catch-up — ок?
8. Метка милстоуна «M28» в доках/ROADMAP — ок?
9. Потерянный fire в crash-окне W1 (at-most-once, без ретрая) — приемлемо?
