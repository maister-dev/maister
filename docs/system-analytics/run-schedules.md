# Run schedules domain

## Purpose

This domain (**Implemented, M28**) covers user-facing recurring schedules: a
per-project, member-gated `run_schedules` row that launches a REAL Flow run
for its task on a cron expression (5-field, IANA timezone) with an overlap
policy (`skip | queue_one | start_anyway`), pause/resume, trigger-now, and
last-fire feedback. Fires are driven by the EXISTING M24 scheduler tick
through ONE seeded dispatcher job — no second clock, no new timer, no cap
change. The boundary excludes `agent_tick` scheduling (E4), event/webhook
triggers, and flow-target schedules that mint a task per fire (Phase 2).

## Domain entities

- **Run schedule** (`run_schedules`, Implemented, M28) — durable per-project
  schedule: target task, `cron_expr` + `timezone`, `overlap_policy`,
  `enabled`, precomputed `next_fire_at`, non-stacking `queue_one_pending`
  catch-up flag, and last-fire feedback (`last_fired_at`,
  `last_fire_outcome`, `last_fire_error`, `last_run_id`). ERD:
  [`../db/scheduler-domain.md`](../db/scheduler-domain.md).
- **Schedule dispatcher job** (`scheduler_jobs` row `run_schedule.dispatcher`,
  Implemented, M28) — the ONE seeded engine job (`job_kind = 'run_schedule'`,
  60s cadence, budget 1, `max_failures` 3) whose handler claims due schedule
  rows. Disabling it on `/admin/scheduler` is the global kill switch.
- **Fire** — one dispatch decision for one schedule row: either a launch
  through `launchRun` (one `runs` row + workspace + worktree, attempt N+1)
  or a recorded skip/queue outcome. Outcome enum: `launched | queued_pending
  | catchup_queued | skipped_task_busy | skipped_cap |
  skipped_target_terminal | skipped_crashed | launch_failed | dispatching`,
  plus `skipped_blocked` (Implemented, ADR-078 — task has open relation
  blockers) and `skipped_unconfigured` (M34 — Implemented, ADR-089 — the task
  has no flow yet; simple-intent tasks await a triage verdict or a human
  filling the launch fields).
- **Launchability classifier** (`classifyTaskLaunchability`, Implemented, M28) —
  shared single source of truth for "can this task launch", encoding the
  board retry rule (latest run `Failed | Abandoned` → launchable, attempt
  N+1). Used by `launchRun` itself and by the dispatcher's policy decision.
- **Schedules tab** (project board `?tab=schedules`, Implemented, M28) —
  view for `readBoard`, mutate affordances for `manageSchedules` (member).
- **Task schedules overview** (`/admin/scheduler`, Implemented, M28) — read-only
  global-admin overview of `run_schedules` joined to owning project, target
  task, and last run. It links to `/runs/{lastRunId}` when a last run exists,
  and to `/projects/{slug}?tab=schedules` for edits instead of creating global
  schedule CRUD.
- **Schedule presets** (project board `?tab=schedules`, Implemented, M28) — UI
  affordance for common 5-field cron expressions (hourly, daily, weekdays,
  weekly, custom). Presets write the same `cron_expr` string as manual input
  and do not change dispatch semantics.

## State machine

A schedule row has one persisted axis (`enabled`) plus the per-fire decision
applied every dispatcher tick while it is enabled and due.

```mermaid
stateDiagram-v2
    [*] --> Active: POST create<br/>next_fire_at precomputed
    Active --> Paused: PATCH enabled=false<br/>clears queue_one_pending
    Paused --> Active: PATCH enabled=true<br/>recompute next_fire_at from now
    Active --> Active: tick fire decision<br/>(launch or skip or queue)
    Paused --> Paused: trigger-now allowed<br/>(explicit user intent)
    Active --> [*]: DELETE (hard)
    Paused --> [*]: DELETE (hard)
```

The per-fire decision (overlap policy × blocked dimensions, in precedence
order) is the DQ7 matrix:

| Condition (precedence order) | `skip` | `queue_one` | `start_anyway` |
| --- | --- | --- | --- |
| `target_terminal` (task or latest run Done, task Abandoned) | `skipped_target_terminal` | `skipped_target_terminal` (no flag) | `skipped_target_terminal` |
| `crashed` (latest run Crashed — owes recover/discard) | `skipped_crashed` | `skipped_crashed` (no flag) | `skipped_crashed` |
| `busy` (active run on the task) | `skipped_task_busy` | flag + `catchup_queued` | `skipped_task_busy` — a second concurrent run per task is structurally impossible; `start_anyway` overrides only the CAP dimension |
| `blocked` (Implemented, ADR-078 — open relation blockers) | `skipped_blocked` | `skipped_blocked` (existing flag kept — fires once unblocked) | `skipped_blocked` — relations gate launching under every policy |
| `unconfigured` (M34 — Implemented, ADR-089 — task has no flow) | `skipped_unconfigured` | `skipped_unconfigured` (existing flag kept — fires once configured) | `skipped_unconfigured` — a flowless task cannot launch under any policy |
| cap full (task launchable) | `skipped_cap` | flag + `catchup_queued` | `launchRun` → run lands `Pending` + queue position (`queued_pending`) |
| free | launch | launch (+ clear flag) | launch |

### Classifier split for manual relaunch (Designed, ADR-085)

Schedules keep their conservative classifier intent even though manual
"Run again" allows `Done`, `Review`, and `Crashed` targets. A schedule fire is
automation, not an explicit human retry click:

- `target_terminal` (`Done` task/latest run or task `Abandoned`) still records
  `skipped_target_terminal` and clears any queued catch-up.
- `crashed` still records `skipped_crashed` and keeps an existing
  `queue_one_pending` flag, because the run owes a recover/discard or an
  explicit manual relaunch.
- `Review` remains `busy` for schedule dispatch unless a future ADR opts
  schedules into review replays. This prevents a schedule from spawning a new
  attempt while a human is reviewing or promoting the previous one.
- Relation blockers continue to gate every policy and never create a run.

Implementation may share helper code with manual launchability, but the
schedule-facing API must expose the schedule intent explicitly so future manual
states cannot silently change the overlap matrix.

## Process flows

### Dispatcher tick (single-claim due-OR-catchup)

The M24 tick claims the `run_schedule.dispatcher` job; the handler then
claims schedule rows in one query and runs the two-phase fire pipeline per
row.

```mermaid
flowchart TD
    Tick[M24 tick claims run_schedule.dispatcher] --> Claim[tx1: SELECT FOR UPDATE SKIP LOCKED<br/>enabled AND due OR queue_one_pending<br/>not freshly dispatching within 300s<br/>JOIN projects: archived_at IS NULL<br/>LIMIT 10 ORDER BY next_fire_at]
    Claim --> Decide[read task + latest run + countLiveRuns<br/>+ slots reserved earlier in the batch<br/>decision per overlap matrix]
    Decide -- skip or catchup_queued --> NonLaunch[write final outcome + flag<br/>advance next_fire_at from now]
    NonLaunch --> Commit1[COMMIT tx1 — done]
    Decide -- launch path --> Intent[write last_fire_outcome=dispatching<br/>last_fired_at=now, advance next_fire_at<br/>clear queue_one_pending]
    Intent --> Commit2[COMMIT tx1]
    Commit2 --> Launch[launchRun outside the row lock<br/>worktree + its own DB tx]
    Launch --> Tx2["tx2: CAS final outcome WHERE<br/>last_fire_outcome=dispatching<br/>AND last_fired_at=staged stamp (fence)<br/>launched or queued_pending or launch_failed<br/>+ last_run_id + last_fire_error"]
    Tx2 -- 0 rows updated --> Stale[WARN stale dispatch result dropped]
    Tx2 -- 1 row updated --> Done[summary into recordJobAttemptResult]
```

Catch-up collapses by construction: `next_fire_at` is recomputed from NOW at
claim time, so a schedule overdue by N slots fires exactly once (mirrors the
engine's "catch-up without backfill").

### Trigger-now

```mermaid
sequenceDiagram
    participant U as Member
    participant R as POST .../schedules/:id/trigger
    participant D as dispatchScheduleNow
    participant L as launchRun
    U->>R: click Trigger now
    R->>D: scheduleId + actorUserId
    D->>D: claim row by id (FOR UPDATE SKIP LOCKED)
    alt row locked OR dispatching fresher than 300s
        D-->>R: MaisterError CONFLICT
        R-->>U: 409 dispatch in progress
    else claimed
        D->>D: same policy+fire core as the tick<br/>next_fire_at NOT advanced
        D->>L: launch when policy allows
        D-->>R: outcome, runId?, queuePosition?, errorCode?
        R-->>U: 200 outcome toast
    end
```

Trigger-now is allowed on a paused schedule (explicit user intent), respects
the overlap policy and the cap (no bypass), and never advances
`next_fire_at` — manual fires are out-of-band of the cron rhythm.

### queue_one catch-up cycle

```mermaid
flowchart TD
    Due[due fire on queue_one schedule] --> Blocked{task busy or cap full?}
    Blocked -- no --> Fire[launch + clear flag]
    Blocked -- yes --> Flag[set queue_one_pending<br/>queued_fire_at=now<br/>outcome catchup_queued]
    Flag --> NextTick[next tick claims flagged row<br/>even when not due]
    NextTick --> Still{still blocked?}
    Still -- yes --> Keep[flag stays — retry next tick]
    Still -- no --> Catchup[launch WITHOUT advancing next_fire_at<br/>clear flag]
    Fire --> Note[a successful due fire also satisfies<br/>the catch-up — no double launch]
```

The flag is non-stacking: at most ONE queued catch-up regardless of how many
fires were missed. `Pending` runs from `start_anyway` keep strict priority —
the existing engine promotes them on slot release, before any tick-driven
catch-up.

### Admin overview to project schedule editor

```mermaid
flowchart TD
    Admin["Global admin opens /admin/scheduler"] --> Overview["Task schedules overview<br/>project + task + cron + next fire + last outcome"]
    Overview --> ProjectLink["Open project schedules tab"]
    ProjectLink --> ProjectSchedules["/projects/{slug}?tab=schedules"]
    ProjectSchedules --> Edit["Create/edit schedule modal"]
    Edit --> Preset{"Preset"}
    Preset -- hourly/daily/weekdays/weekly --> Cron["Write 5-field cronExpr"]
    Preset -- custom --> Manual["Keep manual cronExpr"]
```

## Expectations

- Every fire MUST create runs only through `launchRun` with its full
  preconditions, gates, HITL, and promotion — no side-channel run creation.
- Schedule launchability MUST be tested separately from manual launchability;
  `Done`, `Review`, and `Crashed` manual relaunch support MUST NOT make due
  schedules start those tasks unless this document is updated first.
- The M24 tick MUST remain the only clock: exactly one seeded
  `run_schedule.dispatcher` job (60s cadence, budget 1) fires schedules; no
  new timer, no `fs.watch`, no polling of run state.
- `scheduler_jobs.cadence_interval_seconds` MUST remain the only engine
  cadence model; cron expressions live exclusively in `run_schedules`.
- A due schedule MUST fire at most once per slot: concurrent
  `dispatchDueSchedules` claims and trigger-now on the same row yield exactly
  one launch (`FOR UPDATE SKIP LOCKED` + the `dispatching` guard).
- `next_fire_at` MUST be advanced from NOW at claim time so any number of
  missed slots collapses into exactly one fire (no backfill).
- Launch intent (`last_fire_outcome = 'dispatching'`) MUST be durably
  committed before `launchRun`, and the final outcome write MUST be
  CAS-guarded on `'dispatching'` AND the staged `last_fired_at` stamp (the
  fencing token) — a stale or out-fenced result is dropped with a WARN,
  never clobbers a concurrent edit/delete/later-fire or a newer reclaim's
  marker.
- Cap checks MUST reuse the exported `countLiveRuns` /
  `maxConcurrentRunsCap` helpers from `web/lib/scheduler.ts`;
  `start_anyway` rides the existing `Pending` queue and NEVER bypasses the
  cap.
- `queue_one_pending` MUST be non-stacking, set only when a `queue_one` fire
  is blocked by `busy`/cap, consumed without advancing `next_fire_at`, and
  cleared by any dispatched launch intent, by a `skipped_target_terminal`
  skip (a terminal target can never satisfy it), and by pause; a
  `skipped_crashed` skip keeps it.
- A refused fire (`launch_failed` or any skip) MUST record its outcome on the
  schedule row while the dispatcher job attempt records `Succeeded` — one
  schedule's failure never disables the shared dispatcher.
- Mutating routes MUST require `manageSchedules` (member); listing requires
  `readBoard`; cron fires pass `actorUserId: null`, trigger-now passes the
  clicking user's id.
- The admin Task schedules overview is read-only. It MUST NOT add a global
  schedule mutation route or bypass the project `manageSchedules` permission
  model; it links operators to the existing project schedules tab.
- Overview rows SHOULD include schedule name, project link, task number/title,
  enabled state, cron/timezone, next fire, queued catch-up state, last
  outcome/error, and last run status/link when available.
- Schedule presets MUST be UI-only helpers that produce valid 5-field
  `cron_expr` values. Unknown expressions open in custom mode and are
  preserved unless the operator changes them.
- `cron_expr` MUST be 5-field and `timezone` a valid IANA name, validated
  through the croner wrapper (`MaisterError("CONFIG")`); `croner` MUST be
  imported only by `web/lib/run-schedules/cron.ts` and MUST never start
  timers.
- Schedules of archived projects MUST never be claimed; deleting the task
  cascades the schedule away, while `last_run_id` (`ON DELETE SET NULL`)
  keeps launched runs untouched.

## Edge cases

- **W1 crash window** (process death after tx1, before `launchRun`): the fire
  is LOST BY DESIGN (at-most-once launch — retrying here is what double-fires
  runs). The row shows `dispatching` until the next fire overwrites it; the
  UI renders it as "dispatching…".
- **W2 crash window** (after `launchRun`, before tx2): the run EXISTS and is
  fully owned by the normal run lifecycle; the schedule is stuck
  `dispatching` without `last_run_id` and self-heals at the next fire.
- **Trigger-now vs fresh `dispatching`**: refused with
  `MaisterError("CONFLICT")` (409) while `last_fired_at` is within the 300s
  scheduler attempt timeout; an OLDER `dispatching` remnant (W1) is past the
  window and MAY be triggered — the staleness escape that keeps W1 from
  bricking the button. The tick's due-claim applies the SAME freshness
  exclusion, so a row mid-trigger is never double-launched and a fast
  `launch_failed` can never clobber the trigger's outcome.
- **Batch slot reservation**: within one dispatcher batch, launches staged
  earlier count as occupied slots for later rows — `skip`/`queue_one`
  schedules never overshoot the cap into `Pending` runs the policy opted out
  of; only an EXTERNAL concurrent launch can produce the documented benign
  `queued_pending` race.
- **Trigger-now racing the tick on the same due second**: the row lock
  serializes them; the loser observes the winner's run as `busy` → policy
  outcome, no duplicate. For `start_anyway` with cap headroom the worst case
  is one manual + one cron run — both explicitly requested.
- **DST**: skipped local times (spring-forward) fire at the next valid
  instant; the repeated hour (fall-back) fires once — croner's documented
  behavior, asserted in the wrapper's unit fixtures.
- **`target_terminal` / `crashed` skips**: recorded as
  `skipped_target_terminal` / `skipped_crashed` under EVERY policy and never
  set the `queue_one` flag — the task owes a human action (board retry rules
  in [`tasks.md`](tasks.md)).
- **`blocked` skip (Implemented, ADR-078)**: recorded as `skipped_blocked`
  under EVERY policy with the blocker `KEY-N` list in the dispatcher attempt
  summary; never sets the `queue_one` flag but KEEPS an existing one (like
  `crashed` — the block is recoverable: the blocker finishing or the
  relation being removed unblocks the catch-up). Relation semantics live in
  [`tasks.md`](tasks.md).
- **Archived project**: the claim query JOINs `projects` and excludes
  `archived_at IS NOT NULL` rows — archived projects never fire.
- **Invalid `cron_expr` / `timezone` / never-matching expression** on
  create/edit: `MaisterError("CONFIG")` → 400.
- **Cross-project `taskId`** on create: `MaisterError("PRECONDITION")` → 409;
  schedule lookups from another project's slug → 404.
- **Terminal task (`Done` / `Abandoned`)** on create:
  `MaisterError("PRECONDITION")` → 409 — such a schedule could only ever
  record `skipped_target_terminal`; the modal's task picker hides terminal
  tasks for the same reason.
- **Redundant `enabled: true`** on an already-active schedule (e.g. bundled
  with a rename): does NOT re-arm `next_fire_at` — only the Paused→Active
  transition recomputes it, so a due fire is never silently pushed forward.
- **`launchRun` refusal** (dirty repo, branch taken, supervisor down, …):
  recorded as `launch_failed` with `last_fire_error = "CODE: message"`
  (bounded ≤ 500 chars); the dispatcher does not throw.
- **Dispatcher auto-disable**: 3 consecutive ENGINE-level failures (handler
  crash, lease expiry — not schedule-level refusals) disable the dispatcher
  job; admin re-enable on `/admin/scheduler` is the documented kill-switch
  recovery.
- **Batch truncation**: more than 10 due schedules in one tick — the
  remainder stays due for the next tick; the attempt summary carries a
  structured `truncated` flag plus a WARN log.

## Linked artifacts

- API: [`../api/web.openapi.yaml`](../api/web.openapi.yaml)
  (`/api/projects/{slug}/schedules` family).
- DB: [`../database-schema.md`](../database-schema.md),
  [`../db/scheduler-domain.md`](../db/scheduler-domain.md), and
  [`../db/erd.md`](../db/erd.md).
- ADR: [ADR-071](../decisions.md#adr-071-user-facing-run-schedules-on-the-m24-clock),
  [ADR-060](../decisions.md#adr-060-unified-scheduler-clock-and-polymorphic-job-budgets),
  [ADR-009](../decisions.md#adr-009-global-concurrency-cap--3).
- Engine domain: [`scheduler.md`](scheduler.md); board retry rules:
  [`tasks.md`](tasks.md).
- Source seams: `web/lib/run-schedules/{cron,service,queries,dispatch}.ts`,
  `web/lib/runs/launchability.ts`, `web/lib/scheduler/{jobs,tick-service,budgets}.ts`,
  `web/lib/services/runs.ts`, `web/lib/scheduler.ts`,
  `web/components/schedules/schedule-edit-modal.tsx`,
  `web/components/schedules/schedules-table.tsx`, and
  `web/app/(app)/admin/scheduler/page.tsx`.
