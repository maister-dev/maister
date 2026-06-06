# Feature M24 — Scheduler Service (P5)

## Status

Implemented, Wave 1.

## Value

MAIster needs one authorized clock for background work. Today the GC cron route
is a narrow, one-off sweep trigger. M24 turns that clock into a stateless
polymorphic scheduler that can run recovery sweeps, lightweight commands, future
agent ticks, and Flow run dispatch without adding a DB-owning supervisor loop or
changing the global Flow concurrency cap.

## Non-goals

- No `fs.watch`, `chokidar`, or state-transition polling.
- No supervisor-owned scheduler or supervisor DB access.
- No cron expressions or RRULE support in M24.
- No full agents-as-actors catalog/runtime beyond the `agent_tick` dispatch
  seam and `agent_schedules` bridge.
- No change to `MAISTER_MAX_CONCURRENT_RUNS=3` or the existing Flow queue
  semantics.

## Expectations

- `/api/cron/tick` MUST be stateless, token-guarded by
  `X-Maister-Cron-Token`, and safe to call concurrently.
- `scheduler_jobs.cadence_interval_seconds` is the only M24 cadence
  representation; cron expressions and RRULEs are rejected/deferred.
- Due-job claim MUST use one DB transaction that advances `next_run_at`, stamps
  `last_fired_at`, creates one attempt, and refuses overlap when a live attempt
  lease is unexpired.
- Outage catch-up MUST fire at most once per due job and advance
  `next_run_at` to the first future fixed-interval occurrence; missed intervals
  are never backfilled.
- Expired `Claimed`/`Running` attempts MUST be reaped before new claims, marked
  `Failed`, and counted toward `consecutive_failures`.
- `agent_tick` with no registered launcher MUST end as terminal `Skipped` with
  `error_code='PRECONDITION'`; repeated failures MUST disable the job at
  `MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES`.
- The tick service MUST idempotently create `system_sweep.default` so the
  scheduler is live after migration without manual seed SQL.
- Terminal attempt updates MUST be status-fenced; a handler returning after
  lease expiry/reap MUST NOT overwrite the reaped terminal state.
- `system_sweep` MUST compose the existing callable sweeps:
  `runSweepTick`, `runReconcileSweep`, `runGcSweeps`, and
  `runCapabilitiesCleanupSweep`.
- `/api/cron/gc` MUST remain compatible with the existing response/status
  contract while delegating to the shared `system_sweep` service.
- The single-box fallback timer MUST be disabled by default and start only when
  `MAISTER_SCHEDULER_TIMER_ENABLED=true`.

## Job kinds and budgets

| job_kind | Budget | M24 handler |
| --- | --- | --- |
| `system_sweep` | Outside run/agent/command caps; each sweep keeps its own bounds | Existing recovery/GC sweeps only |
| `command` | `MAISTER_MAX_CONCURRENT_COMMANDS` | HTTP ping and, if Phase 0 keeps it, a server-owned allow-listed console ping command |
| `agent_tick` | `MAISTER_MAX_CONCURRENT_AGENTS` | Dispatch seam; no-launcher production targets become `Skipped/PRECONDITION` |
| `flow_run` | Existing `MAISTER_MAX_CONCURRENT_RUNS` | Existing run creation and `tryStartRun` path only |

## Acceptance criteria

- Two overlapping ticks for one due job produce exactly one attempt.
- A job overdue by many intervals fires once and advances to a future
  `next_run_at`.
- A live unexpired attempt lease blocks overlap; an expired lease is reaped and
  then the job may be claimed again.
- Repeated `agent_tick` precondition skips stop retry spam by disabling the job
  at `MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES`.
- The first authorized tick creates exactly one `system_sweep.default` job, and
  repeated ticks do not duplicate it.
- A stale handler completion after lease reaping is ignored and leaves the
  reaped `Failed` attempt intact.
- `/api/cron/gc` keeps its current 200/207/401/503 semantics and calls
  capability cleanup through the shared system-sweep implementation.
- No scheduler path consumes or reduces the existing Flow run cap except
  `flow_run`.

## Contract trace

- API: `docs/api/web.openapi.yaml` (`/api/cron/tick`,
  `/api/cron/gc` compatibility).
- Domain: `docs/system-analytics/scheduler.md` and
  `docs/system-analytics/reconciliation-gc.md`.
- DB: `docs/database-schema.md`, `docs/db/scheduler-domain.md`,
  `docs/db/erd.md`.
- Config: `docs/configuration.md`, `.env.example`.
- ADR: `docs/decisions.md` ADR-060.
