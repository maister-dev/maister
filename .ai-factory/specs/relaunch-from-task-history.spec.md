# Spec: Manual force-relaunch from the task runs-history view

**Status:** Implemented (per-requirement tags below)
**ADR:** [ADR-119](../../docs/decisions.md) — Manual force-relaunch (additive
concurrent runs per task) + atomic attempt-number allocation
**Plan:** `.ai-factory/plans/claude-suspicious-poitras-8ca625.md`

---

## 1. Problem

On the task detail page the runs-history section ("История запусков") shows a
header chip with the run count. A new run can only be launched from the
page-header `LaunchPopover`, and that launch is **blocked while any prior run
for the task is active** (the `busy` launchability verdict from
`classifyManualTaskLaunchability`).

We want a launch button immediately to the right of the runs-count chip that
starts **another run regardless of the previous runs' state — including while a
run is still `Running`** — by opening the existing full launch dialog. It must
be **disabled (with a reason)** when the task itself is genuinely not launchable
(open blocking relation or triage-flagged), because launching is then
impossible.

## 2. Locked decisions

1. **Additive concurrency.** A new run starts *alongside* the in-flight run.
   More than one non-terminal run per task is allowed. Extras beyond the global
   cap (`MAISTER_MAX_CONCURRENT_RUNS=6`) queue as `Pending` via the existing
   scheduler. The running attempt is **not** cancelled or superseded.
2. **Full launch dialog.** The new button reuses `LaunchPopover` (flow / runner
   / branches / delivery / execution policy), not a one-click repeat.
3. **Run-status gating relaxed, task-level gating preserved.** The new entry
   point treats every *run* status as launchable, but still honours the *task*
   gates `flagged` (triage) and `blocked` (open blocking relation). When
   task-gated, the button is disabled with the gate's reason. `unconfigured` is
   unreachable from this entry point — the button only renders once a task has
   ≥1 run, so it is already configured.

## 3. Functional requirements & acceptance criteria

Each requirement (FR) has one acceptance criterion (AC), each test-mappable.

| FR | Requirement | AC | Status |
|----|-------------|----|--------|
| FR-1 | A force-relaunch launchability classifier treats every run status as launchable while keeping the task-gate allow-list. | `classifyForceRelaunchLaunchability` returns `launchable` for every `RunStatus`; returns `flagged`/`blocked` only on the task gates; precedence `flagged > blocked > launchable`. (unit) | Implemented |
| FR-2 | Attempt-number allocation is atomic so concurrent launches never collide on a branch name. | Two concurrent `launchRunStaged({allowConcurrent:true})` for one task get **distinct** `attempt_number`s + branches, both succeed, no `git` CONFLICT (integration, real PG). | Implemented |
| FR-3 | `POST /api/runs` accepts `allowConcurrent` (default false); when true it widens only the run-status gate, never the task gates. | With a busy latest run, `allowConcurrent:true` ⇒ launch succeeds; `false`/absent ⇒ `PRECONDITION`. With a blocked task, `allowConcurrent:true` ⇒ still `PRECONDITION`. (integration) | Implemented |
| FR-4 | `GET /api/runs/launch-options` returns an additive `relaunch:{launchable,reason}` field computed with the force classifier, alongside the unchanged `launchability`. | `relaunch.launchable` is true while the latest run is busy; the gate verdict when flagged/blocked; existing `launchability` unchanged. (integration) | Implemented |
| FR-5 | The runs-history header renders a force-relaunch launch button to the right of the runs-count chip, enabled while a run is `Running`, disabled with a reason when task-gated. | Popover in `forceRelaunch` mode enables Create when latest run busy; disables with reason when force verdict is `flagged`/`blocked`; POST body carries `allowConcurrent:true`. (unit) | Implemented |
| FR-6 | The runs-history list renders at most the 10 newest runs while the count chip and token totals reflect the true total over **all** runs. | With >10 flow runs, exactly the 10 newest rows return; `totals.runCount` = true total; token totals = sum over all runs. (integration, real PG) | Implemented |
| FR-7 | A relaunch records the same `run_launched` `task_activity` (ADR-078) — no new activity/event kind, no `domain_events` outbox row. | The launch path records `run_launched` per launch; no new kind in the schema constraint. (audit, Phase 5) | Implemented |

## 4. Trust-label table (skill-context trust rule)

| Field | Type | Default | Trust label | Notes |
|-------|------|---------|-------------|-------|
| `allowConcurrent` | boolean | `false` | **body-controlled behaviour flag** | Gated behind `requireProjectAction(projectId,"launchRun")` (same as every launch). Only *widens the run-status gate* (`busy`→ launchable). **Never** bypasses the task gates `flagged`/`blocked`. Not a cross-resource locator. |

`taskId` stays body-controlled but `projectId` is derived from the task row
(server-state) and authorised via `requireProjectAction` — trusted by
derivation. No new body-controlled cross-resource locator is introduced.

## 5. Force-launchability precedence (force mode)

Highest-priority refusal first:

```
flagged      (task.triageStatus === "flagged")
> blocked    (any open blocking relation)
> launchable (otherwise — run status is deliberately NOT consulted)
```

`unconfigured` is intentionally omitted (mirrors
`classifyManualTaskLaunchability`, which takes no `flowId`): the runs-history
button only renders once a task has ≥1 run, so the task is already configured.
Run status is deliberately not consulted — documented so a future run status
cannot silently change force behaviour.

## 6. Atomic attempt-number allocation invariant

`attempt_number` is bumped atomically **before** branch derivation:

```sql
UPDATE tasks SET attempt_number = attempt_number + 1
WHERE id = $taskId
RETURNING attempt_number;     -- $newAttempt
```

The early allocation is the **sole** writer of `attempt_number`; the
`attemptNumber` write is removed from the main launch transaction (the tx still
writes `tasks.status = "InFlight"`). Each concurrent launch reserves a distinct
`attempt_number` ⇒ distinct branch ⇒ no `git worktree add` collision.

### Crash-window table

| Window | State after | Retryable? |
|--------|-------------|-----------|
| Allocation succeeds, later precondition/`addWorktree`/tx fails or process dies | `attempt_number` **burned** (a monotonic-counter gap, no meaning); no run row, no worktree, `tasks.status` untouched | Yes — task still force-launchable; next launch takes the next value |
| `addWorktree` succeeds, inner tx fails | existing `removeWorktree` compensation removes the orphan worktree | Yes |
| `blocked`/`flagged` refusal | happens **before** allocation (classifier gate at the top) | No number burned |

Idempotent status write: the main tx sets `tasks.status="InFlight"`
unconditionally; for a concurrent relaunch the task is already `InFlight`, so
the set is a no-op, yet `recordTaskActivity(run_launched)` + the `inbox_items`
fan-out fire **per launch** (intended — each launch is a real event). No
downstream consumer may treat `run_launched` as a `Backlog→InFlight` transition.

## 7. Read-model fan-out matrix (additive concurrency)

| Consumer class | File(s) | Expectation |
|----------------|---------|-------------|
| Board read model / column | `web/lib/board.ts` | Latest-run derivation — safe. |
| Launchability (board / manual) | `web/lib/runs/launchability.ts` | Latest run — safe; force mode opt-in. |
| Concurrency cap / queue | `web/lib/scheduler.ts` | Counts live runs globally; two live runs of one task count as 2 — correct. |
| Reconcile / crash sweeps | reconcile + idle/keepalive sweeps | Per-run, not per-task. |
| Promotion | `promoteRun` | Per-run/per-workspace (keyed on runId). |
| Scheduler latch / auto-launch | `lib/run-schedules/*`, `lib/scheduler/handlers/*` | Use `classifyTaskLaunchability` (`busy` blocks); force flag not threaded there. |
| "Active run for task" lookups | `getLatest*`, `taskId` + non-terminal filters | Must tolerate multiple rows. |
| `run_launched` activity + inbox | schema kind constraints, social-board writers | No consumer treats `run_launched` as a `Backlog→InFlight` flip; per-relaunch inbox fan-out acceptable. |
| Runs-history totals | `web/lib/queries/task-detail.ts` | `totals`/`latest` reduce over ALL runs even after display rows capped to 10. |

## 8. Runs-history list cap

No per-task run limit (hundreds allowed). The runs-history render is bounded to
the **10 newest rows** until real pagination ships. Totals (`runCount` + token
sums) are computed over **all** runs via a SQL aggregate; the display rows come
from a separate ordered `.limit(10)` query. The chip keeps the true total.

## 9. Explicit non-changes

- **No DB migration** — `tasks.attempt_number` exists; worktree paths are
  `runId`-keyed; no unique constraint assumes one active run per task.
- **No new `MaisterError` code** — `PRECONDITION`/`CONFLICT` reused.
- **No deployment change** — no env var, config file, sidecar, port, or mount.
- **No new activity/event kind** — same `run_launched` `task_activity`; not a
  `domain_events` outbox row.

## 10. Edge cases

- Concurrent same-task launches (branch/attempt race) — §6.
- Force-launch on a `blocked`/`flagged` task — refused (`PRECONDITION`) before
  any side-effect.
- Cap reached at force-launch — new run goes `Pending` with `queuePosition`.
- Launch failure after attempt allocation — number burned (gap), task still
  launchable.
- Latest-run display with multiple live runs — board shows most-recent by
  `startedAt`.
- Supervisor unavailable — existing pre-side-effect refusal still applies.
