# Implementation Plan: M24 — Scheduler Service (P5)

Branch: `HEAD` (detached managed worktree). Intended feature branch:
`feature/m24-scheduler-service` — not auto-created in this planning pass.
Created: 2026-06-05

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint; Phase 0 is docs/spec-first

## Roadmap Linkage
Milestone: "M24. Scheduler service (P5)"
Rationale: User-selected Wave-1 feature code; delivers the long-lead clock
foundation from `docs/pv/improvement-roadmap.md` without changing the flow run
cap or moving scheduler logic into the supervisor.

Scope: **Full for P5**. It ships the unified clock, job model, atomic claim,
external-cron route, single-box fallback timer, and budget boundaries. It does
NOT ship the broader agents-as-actors catalog/runtime beyond the `agent_tick`
dispatch seam and schedule rows needed by P5.

---

## 0. Scope, decisions, and existing ground

### 0.1 Goal

Build one stateless, authorized scheduler tick in the web tier:

- Generalize the existing token-guarded `GET`/`POST /api/cron/gc` route into a
  unified clock route.
- Model polymorphic jobs with `job_kind in {system_sweep, command, agent_tick,
  flow_run}`.
- Claim due jobs atomically with `UPDATE ... WHERE next_run_at <= now()
  RETURNING`, so overlapping ticks do not double-fire.
- On outage, perform one catch-up fire per schedule and advance to the next
  future run; never backfill missed periods.
- Keep scheduling logic in `web/`; the supervisor stays DB-free and only owns
  process execution.

### 0.2 What already exists and must be reused

- `web/app/api/cron/gc/route.ts` is the current token-guarded cron surface. It
  already uses constant-time `X-Maister-Cron-Token` comparison and returns
  503 when `MAISTER_CRON_TOKEN` is unset.
- `web/lib/scheduler.ts` is the **run capacity scheduler**, not cron. It owns
  the flow run cap, queue promotion, and the `pg_advisory_xact_lock` precedent.
- `web/lib/reconcile.ts`, `web/lib/gc/*`, and
  `web/lib/runs/keepalive-sweeper.ts` are existing sweeps. P5 must compose them
  under `system_sweep`; it must not reinterpret them as live-path polling.
- ADR-033 explicitly allows heartbeat/reconcile recovery sweeps while the live
  path remains ACP notifications. P5 tick remains "clock + recovery sweep",
  never a state-transition poller.
- ADR-009 keeps `MAISTER_MAX_CONCURRENT_RUNS=3` as the global flow cap. `command`
  and `agent_tick` receive separate budgets and never steal flow-run slots.

### 0.3 Locked decisions to cite and preserve

| Decision | How M24 uses it |
| --- | --- |
| ADR-002 / ADR-003 | Supervisor owns ACP sessions; scheduler stays in web and calls existing launch/client seams. |
| ADR-007 | SSE pipe-to-disk stays unchanged; scheduled jobs do not add a new live event pipe. |
| ADR-008 | No new error code unless Phase 0 proves current codes are insufficient; default to `CONFIG`, `PRECONDITION`, `CONFLICT`, `EXECUTOR_UNAVAILABLE`. |
| ADR-009 | Flow cap is untouched; `flow_run` uses existing `tryStartRun` / `promoteNextPending`. |
| ADR-023 | Web + supervisor run on host; compose remains minimal unless new env vars require wiring. |
| ADR-033 / ADR-035 / ADR-036 | Recovery and GC sweeps are sanctioned system jobs behind the clock. |

### 0.4 Proposed new ADR

Phase 0 adds **ADR-060: Unified scheduler clock and polymorphic job budgets**.
It must lock:

- `web/` owns scheduling logic; `supervisor/` remains DB-free.
- Tick route is stateless, token-guarded, and idempotent by atomic claim.
- Catch-up policy is "one fire, no backfill".
- Cadence representation in M24 is fixed interval seconds only
  (`cadence_interval_seconds`). Cron expressions and RRULEs are deferred until
  a later scheduler authoring milestone.
- `system_sweep`, `command`, `agent_tick`, and `flow_run` have separate budget
  accounting; `agent_tick` uses `MAISTER_MAX_CONCURRENT_AGENTS`, not
  `MAISTER_MAX_CONCURRENT_RUNS`.
- Existing `/api/cron/gc` becomes a compatibility wrapper over the same
  `system_sweep` service while preserving its current response contract.
- The single-box timer fallback is disabled by default and starts only when
  `MAISTER_SCHEDULER_TIMER_ENABLED=true`.

---

## 1. Deployment wiring

| New dependency | Lands in |
| --- | --- |
| `MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS` (supervisor-timer fallback cadence; default 60) | `.env.example`, `docs/configuration.md`, `docs/getting-started.md`. No compose environment block unless the repo changes away from ADR-023 host-run defaults. |
| `MAISTER_SCHEDULER_TIMER_ENABLED` (default `false`) | `.env.example`, `docs/configuration.md`; gates the single-box fallback timer only. |
| `MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS` (default 300) | `.env.example`, `docs/configuration.md`; controls stuck-attempt reaping. |
| `MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES` (default 3) | `.env.example`, `docs/configuration.md`; disables noisy `agent_tick` jobs after repeated missing-launcher/precondition failures. |
| `MAISTER_MAX_CONCURRENT_AGENTS` (default 1) | `.env.example`, `docs/configuration.md`; used only for `agent_tick`. |
| `MAISTER_MAX_CONCURRENT_COMMANDS` (default 2) | `.env.example`, `docs/configuration.md`; used only for `command`. |
| `MAISTER_CRON_TOKEN` (existing) | Keep existing docs and route behavior; add `/api/cron/tick` row. Token never logged. |
| `POST`/`GET /api/cron/tick` | `docs/api/web.openapi.yaml`, `docs/system-analytics/scheduler.md`, `docs/getting-started.md`. Existing web port only; no new bound port. |
| New DB tables/indexes | Drizzle migration `0027_m24_scheduler_service.sql`, `web/lib/db/schema.ts`, `docs/database-schema.md`, `docs/db/scheduler-domain.md`, `docs/db/erd.md`. |

No new sidecar binary. No supervisor env var. No Dockerfile change unless Phase
0 finds a current compose overlay already carrying web env blocks that must stay
symmetrical.

---

## 2. Contract-surface to spec-file map

| Surface | Spec file |
| --- | --- |
| `GET`/`POST /api/cron/tick` auth, response, optional `jobKind` filter | `docs/api/web.openapi.yaml` + `docs/system-analytics/scheduler.md` |
| Compatibility behavior for `/api/cron/gc` | `docs/api/web.openapi.yaml` + `docs/system-analytics/reconciliation-gc.md` |
| `scheduler_jobs` / `scheduler_job_runs` / `agent_schedules` tables | `docs/database-schema.md` + `docs/db/scheduler-domain.md` + `docs/db/erd.md` |
| Job lifecycle and claim state | `docs/system-analytics/scheduler.md` |
| New env vars | `docs/configuration.md` + `.env.example` |
| Budget refusal and partial tick results | `docs/error-taxonomy.md` caller rows; no new error code by default |
| Future actor relationship | Cross-reference `docs/pv/agents-as-environment-actors.md`; do not duplicate the full actor model |
| Roadmap tracking | `.ai-factory/ROADMAP.md` M24 row + `docs/pv/improvement-roadmap.md` P5 trace note after implementation |

---

## 3. Decisions and invariants

### 3.1 Job model

Candidate DB shape for Phase 0 spec freeze:

| Table | Purpose |
| --- | --- |
| `scheduler_jobs` | Durable schedule definition. Columns: `id`, `project_id?`, `job_kind`, `target`, `cadence_interval_seconds`, `next_run_at`, `last_fired_at`, `disabled_at`, `budget_key`, `consecutive_failures`, `max_failures`, `created_at`, `updated_at`. |
| `scheduler_job_runs` | Attempt ledger. Columns: `id`, `job_id`, `job_kind`, `claim_token`, `status in ('Claimed','Running','Succeeded','Failed','Skipped')`, `started_at`, `lease_expires_at`, `ended_at`, `summary`, `error_code`, `error_message`. |
| `agent_schedules` | Narrow Wave-1 actor schedule projection: `id`, `project_id`, `agent_ref`, `scheduler_job_id`, `trigger_type`, `desired_state`, `enabled`. `agent_ref` stays typed text in M24, with no FK to M25 authored caps; the full agent catalog is deferred. |

`target` is jsonb but validated per `job_kind` through discriminated Zod types
in `web/lib/scheduler/jobs.ts`. No generic arbitrary payload reaches a handler.

### 3.2 Cadence and atomic claim

M24 supports fixed intervals only. `computeNextRunAt(now, intervalSeconds)`
returns the first timestamp strictly after `now`, using the prior `next_run_at`
as the anchor when available. If a job is overdue by many intervals, the claim
fires once and drops missed intervals instead of backfilling. If a previous
attempt still has an unexpired lease, the new tick skips the job and preserves
the future `next_run_at` already written by the owner attempt.

The claim service must be a pure, testable DB helper:

```sql
UPDATE scheduler_jobs
SET
  next_run_at = :computed_next_run_at,
  last_fired_at = :now,
  updated_at = :now
WHERE id = :id
  AND disabled_at IS NULL
  AND next_run_at <= :now
  AND NOT EXISTS (
    SELECT 1
    FROM scheduler_job_runs active_attempts
    WHERE active_attempts.job_id = scheduler_jobs.id
      AND active_attempts.status IN ('Claimed', 'Running')
      AND active_attempts.lease_expires_at > :now
  )
RETURNING *
```

The returned row creates a `scheduler_job_runs` attempt in the same transaction.
If no row returns, another tick won or the job is no longer due. The next time is
computed as the first future occurrence after `now`; missed occurrences collapse
to one fire.

`reapStuckSchedulerAttempts(now)` marks expired `Claimed`/`Running` attempts as
`Failed`, increments `consecutive_failures`, and disables the job once
`max_failures` is reached. This reaper runs inside the tick before claiming new
work and never backfills missed intervals.

### 3.3 Per-kind budget table

| `job_kind` | Budget | Handler |
| --- | --- | --- |
| `system_sweep` | Outside run and agent caps; internally bounded by each sweeper | Compose existing aggregate seams: `runSweepTick`, `runReconcileSweep`, `runGcSweeps`, `runCapabilitiesCleanupSweep` |
| `command` | `MAISTER_MAX_CONCURRENT_COMMANDS`; outside flow cap | Narrow "ping" handler only: HTTP ping or configured shell command with explicit project allow-list from server state |
| `agent_tick` | `MAISTER_MAX_CONCURRENT_AGENTS`; outside flow cap | Dispatch seam for future internal agents. Production targets without a registered launcher end as terminal `Skipped` with `error_code='PRECONDITION'`, increment failure count, and auto-disable after `max_failures`; tests inject a fixture dispatcher. |
| `flow_run` | Existing `MAISTER_MAX_CONCURRENT_RUNS` via `web/lib/scheduler.ts` | Create a task/run through the existing launch path; never bypass `tryStartRun` |

The Phase 0 spec must decide whether `command` supports shell commands in M24 or
ships HTTP ping only. If shell commands ship, each command target must be stored
server-side, project-scoped, and path-confined; request bodies must not carry the
command string at tick time.

### 3.4 Route identifiers

- `/api/cron/tick`: `X-Maister-Cron-Token` = auth-context; optional `jobKind`
  query = url/query param validated against enum and used only to filter due
  jobs; no body cross-resource identifiers.
- `/api/cron/gc`: existing auth-context; delegates to the same `system_sweep`
  service while preserving the current auth, status, and response shape.
- Future manual "run due now" route, if added in M24, must derive `projectId`
  through server state and cannot accept command text or worktree paths in body.

### 3.5 Multi-store atomicity and crash windows

| Transition | Atomicity requirement | Crash recovery |
| --- | --- | --- |
| Due job claim | `scheduler_jobs` update + `scheduler_job_runs` attempt insert with `lease_expires_at` in one DB transaction; active unexpired attempts block overlap | If process dies after commit and before handler, attempt is `Claimed`/`Running` with no `ended_at`; next tick reaps it after timeout and allows the next scheduled occurrence, not a backfill |
| `flow_run` dispatch | Job attempt write before launch side-effect; run launch uses existing worktree/run transaction and scheduler cap | If launch fails before durable run, job attempt fails; if run becomes `Pending`, existing scheduler owns promotion |
| `system_sweep` | Each sweeper keeps its existing per-row safety; job attempt records aggregate result after handler | Partial failures produce `207` on route and failed rows stay for retry via existing sweeps |
| `command` | Attempt row before command side-effect; terminal result after side-effect | Timeout/non-zero updates attempt to failed with captured bounded output; no hidden retry inside one tick |
| `agent_tick` | Attempt row before agent dispatch; budget claim in one tx | Until actor runtime lands, production handler records terminal `Skipped`/`PRECONDITION`, increments failures, and auto-disables at the configured threshold; test dispatcher proves claim semantics |

### 3.6 Acceptance criteria

- Overlapping ticks against the same due job create one attempt only.
- A job overdue by many intervals fires once, then advances `next_run_at` to the
  first future occurrence.
- An unexpired active attempt prevents overlap; expired attempts are reaped
  before new claims.
- Stuck attempts become `Failed` after
  `MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS`, and repeated failures disable the
  job at `max_failures`.
- Production `agent_tick` jobs without a launcher end as `Skipped` with
  `PRECONDITION` and stop retry spam after
  `MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES`.
- `/api/cron/gc` remains compatible with the existing GC cron contract while
  sharing the `system_sweep` implementation.
- The fallback timer never starts unless
  `MAISTER_SCHEDULER_TIMER_ENABLED=true`.

---

## 4. SDD and TDD workflow

Every phase uses the same agent-team loop:

1. **Coordinator** freezes the phase slice and confirms spec trace.
2. **QA agent** writes RED tests first, including runner-glob confirmation.
3. **Implementor agent** makes the smallest GREEN implementation.
4. **Reviewer agent** performs adversarial review focused on atomicity,
   budget isolation, trust boundary, and contract drift.
5. Phase exits only after the named suite is GREEN and a checkpoint commit is
   created.

Testing conventions:

- Unit tests: vitest `*.test.ts`, component checks via `renderToStaticMarkup`,
  no jsdom.
- Integration tests: `*.integration.test.ts`, testcontainers Postgres.
- E2E: Playwright with seeded stub supervisor and mock ACP adapter only where a
  real launch path is involved.

---

## Tasks

### Phase 0 — Spec freeze (docs-first, single source of truth)

- [x] **T0.1** — Create `.ai-factory/specs/feature-m24-scheduler-service.md` as
  the SSOT with value statement, non-goals, job_kind table, acceptance criteria,
  fixed-interval cadence semantics, budget rules, one-catch-up policy,
  stuck-attempt reaping, and route semantics. Link every later task to this
  spec. LOGGING: n/a. Files:
  `.ai-factory/specs/feature-m24-scheduler-service.md`.
- [x] **T0.2** — Add `docs/system-analytics/scheduler.md` following docs R5:
  Purpose, entities, state machine, process flows, Expectations, Edge cases,
  Linked artifacts. Tag all new pieces `(Designed, M24)` until code lands.
  LOGGING: n/a. Files: `docs/system-analytics/scheduler.md`,
  `docs/CLAUDE.md` glossary if needed.
- [x] **T0.3** — Add ADR-060 to `docs/decisions.md` for unified clock,
  polymorphic job budgets, web-tier ownership, catch-up-not-backfill, and
  `/api/cron/gc` compatibility. It must also lock fixed-interval cadence only,
  opt-in fallback timer, stuck-attempt leases, and `agent_tick` auto-disable
  behavior. LOGGING: n/a. Files: `docs/decisions.md`.
- [x] **T0.4** — Contract trace: update `docs/api/web.openapi.yaml`,
  `docs/database-schema.md`, `docs/db/scheduler-domain.md`, and `docs/db/erd.md`
  as Designed. Include DB/API/env references without duplicating the spec body.
  LOGGING: n/a. Files listed above.
- [x] **T0.5** — RED test inventory: QA agent creates failing tests for atomic
  claim, catch-up, cadence overrun, stuck-attempt reaping, `agent_tick`
  `Skipped`/auto-disable, budgets, route auth, `/api/cron/gc` compatibility,
  and system-sweep delegation. Confirm `vitest list` or equivalent includes
  every test path. LOGGING: tests assert structured logs where relevant. Files:
  `web/lib/scheduler/__tests__/jobs*.test.ts`,
  `web/app/api/cron/tick/__tests__/*.test.ts`,
  `web/lib/scheduler/__tests__/*.integration.test.ts`.
<!-- Commit checkpoint: T0.1-T0.5 -->

### Phase 1 — DB model and typed job core

- [x] **T1.1** — Add migration `0027_m24_scheduler_service.sql` plus Drizzle schema
  for `scheduler_jobs`, `scheduler_job_runs`, and `agent_schedules`. Add indexes
  on `(disabled_at, next_run_at)`, `(job_kind, next_run_at)`, and project/job
  joins, plus attempt recovery index `(status, lease_expires_at)`. Include
  `cadence_interval_seconds`, `lease_expires_at`, `consecutive_failures`, and
  `max_failures`. LOGGING: n/a. Files: `web/lib/db/schema.ts`,
  `web/lib/db/migrations/0027_m24_scheduler_service.sql`, migration metadata.
- [x] **T1.2** — Implement `web/lib/scheduler/jobs.ts` with strict TypeScript
  discriminated unions for job targets, `computeNextRunAt`, `claimDueJobs`, and
  `recordJobAttemptResult`. `computeNextRunAt` supports fixed intervals only and
  drops missed intervals into one catch-up fire. No `any`; do not mutate input
  objects. LOGGING: DEBUG claim attempt/result with
  `{jobId, jobKind, now, nextRunAt}`; INFO claimed count; WARN invalid disabled
  job skipped. Files:
  `web/lib/scheduler/jobs.ts`.
- [x] **T1.3** — Implement `reapStuckSchedulerAttempts` with the configured
  lease timeout and max-failure disable behavior. LOGGING: WARN reaped attempts
  with `{jobId, attemptId, leaseExpiresAt}`; INFO auto-disabled jobs with
  `{jobId, consecutiveFailures, maxFailures}`. Files:
  `web/lib/scheduler/jobs.ts`.
- [x] **T1.4** — Add budget helpers in `web/lib/scheduler/budgets.ts` for
  flow/agent/command budgets. Reuse `takeSchedulerLock` precedent; do not change
  the existing flow cap predicate. LOGGING: DEBUG cap checks with
  `{budgetKey, liveCount, cap}`; INFO budget refusal. Files:
  `web/lib/scheduler/budgets.ts`, `web/lib/scheduler.ts` only if exporting shared
  lock/cap helpers is necessary.
- [ ] **T1.5** — Tests P1: unit and integration for duplicate concurrent ticks
  claiming one row once; missed intervals advancing to one future run; active
  leases blocking overlap; expired leases reaping and auto-disable; disabled
  rows ignored; budget helpers isolated by kind. Phase gate:
  `pnpm --filter maister-web typecheck`, `test:unit`, `test:integration`.
  LOGGING: assert cap/claim summaries. Files:
  `web/lib/scheduler/__tests__/jobs*.test.ts`,
  `web/lib/scheduler/__tests__/jobs*.integration.test.ts`.
<!-- Commit checkpoint: T1.1-T1.5 -->

### Phase 2 — Tick route and system_sweep compatibility

- [x] **T2.1** — Implement `web/app/api/cron/tick/route.ts` with the existing
  cron-token constant-time comparison extracted from `/api/cron/gc`. Return
  `200` when all due jobs succeed, `207` for partial failures, `401` mismatch,
  `503` when cron is disabled. LOGGING: INFO route start/summary; WARN auth
  failures without token value; ERROR per failed handler. Files:
  `web/app/api/cron/tick/route.ts`, shared cron auth helper.
- [x] **T2.2** — Refactor `/api/cron/gc` into a compatibility wrapper over the
  same `system_sweep` service, preserving the current response shape and status
  semantics. It must keep calling capabilities cleanup. LOGGING: preserve current GC
  summary logs; include `{source:"cron-gc-compat"}`. Files:
  `web/app/api/cron/gc/route.ts`, `web/lib/scheduler/system-sweeps.ts`.
- [x] **T2.3** — Compose existing callable aggregate seams under `system_sweep`:
  `runSweepTick`, `runReconcileSweep`, `runGcSweeps`, and
  `runCapabilitiesCleanupSweep`. Do not create a live-path poller; reconcile
  stays recovery only. LOGGING: INFO per sub-sweep summary; WARN sub-sweep
  skipped. Files:
  `web/lib/scheduler/system-sweeps.ts`, existing sweep modules only for exports.
- [x] **T2.4** — Tests P2: cron auth parity with GC route; `system_sweep` calls
  all existing sweep functions exactly once; partial failures return 207; token
  never appears in response/log assertions. Phase gate: unit + integration green.
  LOGGING: assert structured summaries. Files:
  `web/app/api/cron/tick/__tests__/route.test.ts`,
  `web/app/api/cron/gc/__tests__/compat.test.ts`.
<!-- Commit checkpoint: T2.1-T2.4 -->

### Phase 3 — command, flow_run, and agent_tick handlers

- [x] **T3.1** — Implement `command` handler with the Phase-0-selected narrow
  contract. Preferred M24 contract: HTTP ping and an explicitly allow-listed
  console ping command only; no arbitrary shell from request body. LOGGING:
  INFO command start/end `{jobId, commandKind, durationMs}`; ERROR failure with
  bounded output and exit status. Files: `web/lib/scheduler/handlers/command.ts`.
- [x] **T3.2** — Implement `flow_run` handler through the existing task/run launch
  service, never by writing runs directly. It must respect supervisor readiness,
  worktree preconditions, and `tryStartRun`. LOGGING: INFO queued/started result
  `{jobId, taskId, runId, state}`; WARN precondition refusal with code. Files:
  `web/lib/scheduler/handlers/flow-run.ts`, route/service extraction if needed
  from `web/app/api/runs/route.ts`.
- [x] **T3.3** — Implement `agent_tick` dispatch seam and budget accounting.
  Until the full actor runtime lands, production targets without a registered
  launcher end as terminal `Skipped` with `PRECONDITION`, increment
  `consecutive_failures`, and auto-disable at the configured threshold; tests
  inject a fake launcher to prove budget/claim semantics. LOGGING: INFO agent
  tick dispatch/skipped `{jobId, agentRef, reason}`; ERROR launcher failure.
  Files:
  `web/lib/scheduler/handlers/agent-tick.ts`.
- [ ] **T3.4** — Tests P3: command budget full, command timeout/non-zero;
  `flow_run` creates or queues a run through existing cap path; `agent_tick`
  fake dispatcher cannot exceed `MAISTER_MAX_CONCURRENT_AGENTS`; production
  missing launcher records terminal `Skipped`/`PRECONDITION` and disables after
  max failures. Phase gate: typecheck, unit, integration green. LOGGING: assert
  per-kind budget logs. Files:
  `web/lib/scheduler/handlers/__tests__/*`.
<!-- Commit checkpoint: T3.1-T3.4 -->

### Phase 4 — fallback timer, deployment, UI/read models

- [x] **T4.1** — Add supervisor-timer fallback in the web tier as an HMR-safe
  singleton that calls the same tick service on `MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS`
  only when `MAISTER_SCHEDULER_TIMER_ENABLED=true`. This is a single-box
  fallback, not the preferred production clock, and it is disabled by default.
  LOGGING: INFO timer start/tick/stop; WARN if cron token missing while fallback
  disabled. Files:
  `web/lib/scheduler/timer.ts`, `web/instrumentation.ts`.
- [ ] **T4.2** — Add scheduler read models and a minimal admin/system status view
  showing job kind, next run, last result, and disabled state. Use HeroUI and
  EN/RU messages if any UI lands. LOGGING: n/a client-side. Files:
  `web/lib/queries/scheduler.ts`, `web/app/(app)/settings/scheduler/page.tsx`
  or existing settings surface, `web/messages/en.json`, `web/messages/ru.json`.
- [x] **T4.3** — Deployment/docs wiring for env vars and cron setup examples.
  Update `.env.example`, `docs/configuration.md`, `docs/getting-started.md`,
  and any compose overlay that already carries web env entries. LOGGING: n/a.
  Files listed above.
- [ ] **T4.4** — Playwright e2e with seeded jobs: system sweep via tick route,
  visible last result in the status view, wrong token rejected, fallback timer
  disabled by default. Phase gate: `test:e2e` targeted spec plus docs Mermaid
  validation. LOGGING: n/a. Files: `web/e2e/m24-scheduler-service.spec.ts`.
<!-- Commit checkpoint: T4.1-T4.4 -->

### Final gate

- [x] `pnpm --filter maister-web typecheck`
- [ ] `pnpm --filter maister-web test:unit`
- [ ] `pnpm --filter maister-web test:integration`
- [ ] `pnpm --filter maister-web test:e2e -- m24-scheduler-service`
- [x] `pnpm validate:docs:all`
- [x] `git --no-pager diff --check`
- [x] Update `.ai-factory/ROADMAP.md` M24 row and
  `docs/pv/improvement-roadmap.md` P5 trace note from Designed to Implemented
  only after implementation verification passes.

Validation note (2026-06-05): focused M24 unit suites pass, typecheck passes,
Mermaid docs validation passes, and `git diff --check` passes. Full unit is
blocked by the pre-existing M18 `runs-launch-branch.test.ts` fake-DB
`sidecarRows.map` failure. Integration is blocked by Testcontainers reporting
no working container runtime in this environment. No Playwright M24 UI spec
landed because the frozen M24 implementation delivers the route/service/read
model slice, not a navigable scheduler admin page.

---

## Commit Plan

- **Commit 1** (Phase 0): `docs: freeze scheduler service contract`
- **Commit 2** (Phase 1): `feat: add scheduler job model and claim core`
- **Commit 3** (Phase 2): `feat: add unified cron tick route`
- **Commit 4** (Phase 3): `feat: add scheduler job handlers`
- **Commit 5** (Phase 4): `feat: surface scheduler status and fallback timer`

---

## Risks and watch-items

- **Wedge dilution:** `agent_tick` is only a dispatch seam in M24. Do not pull in
  the full actor catalog or continuous daemon runtime.
- **Poll confusion:** The tick can invoke recovery sweeps, but it must not become
  a live state-transition poller. ADR-060 and `scheduler.md` must say this
  plainly.
- **Shell command scope:** If Phase 0 allows shell commands, it needs a strict
  server-state allow-list and path confinement. HTTP ping only is the safer
  Wave-1 default.
- **Run launch extraction:** `flow_run` should reuse an existing launch service.
  If launch logic currently lives too much inside `route.ts`, extract the service
  surgically before adding scheduler calls.
- **ADR sequencing:** ADR-060 must reserve only scheduler-clock contracts. If
  M25 lands first, ADR-061 must not reuse the same number or redefine scheduler
  ownership.

## Open questions

1. Should `command` in M24 be HTTP ping only, or include a tightly allow-listed
   console command path from day one?
