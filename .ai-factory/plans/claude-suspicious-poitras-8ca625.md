# Implementation Plan: Launch additional runs from the task runs-history view

Branch: claude/suspicious-poitras-8ca625 (existing isolated worktree branch — no new branch created)
Created: 2026-06-30

## Settings
- Testing: yes (TDD, RED → GREEN → refactor)
- Logging: verbose
- Docs: yes (mandatory docs checkpoint; system-analytics is front-loaded in Phase 0)

## Roadmap Linkage (optional)
Milestone: "none"
Rationale: Skipped by user — ad-hoc UX + contract enhancement, not a roadmap milestone.

---

## 1. Problem statement & scope

On the task detail page the **runs-history section** ("История запусков") shows a
header chip with the run count ("N запусков"). Today a new run can only be
launched from the page-header `LaunchPopover` (lines 438–447 of
`web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`), and that launch is
**blocked while any prior run for the task is active** (the `busy` launchability
verdict).

**Requested change:** add a launch button immediately to the right of the
runs-count chip in the runs-history header that lets the user start **another
run regardless of the previous runs' state — including while a run is still
running** — by opening the existing full launch dialog. The button must be
**disabled (with a reason)** when the task itself is genuinely not launchable
(open blocking relation, triage-flagged, or unconfigured), because launching is
then impossible.

### Locked product decisions (from the planning Q&A)
1. **Additive concurrency** — a new run starts *alongside* the in-flight run.
   More than one non-terminal run per task is allowed. Extras beyond the global
   cap (`MAISTER_MAX_CONCURRENT_RUNS=6`) queue as `Pending` via the existing
   scheduler. We do **not** cancel/supersede the running attempt.
2. **Full launch dialog** — the new button reuses `LaunchPopover` (flow /
   runner / branches / delivery / execution policy), not a one-click repeat.
3. **Run-status gating relaxed, task-level gating preserved** — the new entry
   point treats every *run* status (`busy`/`crashed`/`target_terminal`) as
   launchable, but still honours the *task* gates `flagged` (triage) and
   `blocked` (open blocking relation). When task-gated, the button is disabled
   with the gate's reason. (`unconfigured` is unreachable from this entry point
   — the button only renders once a task has ≥1 run, so it is already
   configured; see §3.1.)

### Out of scope
- Scheduled / auto-launch / agent-trigger / run-schedule paths — they keep
  using `classifyTaskLaunchability` (the `busy`-blocking classifier) so the
  one-way latch and the auto-launch tick never fan out concurrent runs on
  their own. Force-relaunch is **manual-only**, gated behind the `launchRun`
  project permission.
- Supersede / cancel-previous semantics.
- Board flight-card relaunch behaviour — unchanged (it does **not** set the new
  concurrency flag, so its `busy` gate stands).

---

## 2. Key findings the plan is built on (verified)

| # | Finding | Source |
|---|---------|--------|
| F1 | `POST /api/runs` body is `{ taskId, flowId?, runnerId?, baseBranch?, targetBranch?, deliveryPolicy?, executionPolicy?, packageVersions? }`; `Accept: text/event-stream` ⇒ `launchRunStaged` (SSE), else `launchRun` (202). | `web/app/api/runs/route.ts:28-41,93-221` |
| F2 | Actual launch gate: `launchRunStaged` calls `classifyManualTaskLaunchability` and throws `PRECONDITION` if verdict ≠ `"launchable"`. | `web/lib/services/runs.ts:359-363` |
| F3 | `classifyManualTaskLaunchability` (`MANUAL_RUN_STATUS_LAUNCHABILITY`) maps `Review/Crashed/Done/Abandoned/Failed → launchable` but `Pending/Running/NeedsInput/NeedsInputIdle/HumanWorking/WaitingOnChildren → "busy"` (not launchable). It still applies `flagged` then `blocked` (NOT `unconfigured` — manual takes no `flowId`; the `unconfigured` check lives only in the non-manual `classifyTaskLaunchability`, line 100). | `web/lib/runs/launchability.ts:51-63,108-...` |
| F4 | **Branch** = `${project.branchPrefix}task-${task.id}/attempt-${newAttempt}` where `newAttempt = task.attemptNumber + 1` (a **stale read**); the `tasks.attemptNumber` increment commits later, in the main launch transaction. | `web/lib/services/runs.ts:822-823,1099` |
| F5 | **Worktree path** = `path.join(worktreesRoot(), project.slug, runId)` — keyed on the unique `runId`, so it never collides between runs. | `web/lib/services/runs.ts:824-825` |
| F6 | New runs are inserted `status:"Pending"`, then `tryStartRun` flips to `Running` if a slot is free, else stays `Pending` with a `queuePosition`; `promoteNextPending` runs FIFO on slot release. Live-count predicate: `status IN (Running, NeedsInput, HumanWorking)`. | `web/lib/scheduler.ts:127,299,432`; `services/runs.ts:1007,1150` |
| F7 | `tasks.status` is a **one-way latch** (`Backlog→InFlight`, never back). Board column is a pure display derivation from the *latest* run; `getLatestFlowRun` returns most-recent `runKind='flow'` by `startedAt`. | `web/lib/runs/launchability.ts:32,137`; `web/lib/board.ts:83-96` |
| F8 | `runs_task_idx (taskId)` and `runs_kind_task_idx (runKind, taskId)` are **non-unique** — nothing in the schema enforces "≤1 active run per task". | `web/lib/db/schema.ts:1424-1425` |
| F9 | `runner_snapshot` lives on `run_sessions` (M42/ADR-114, migration 0082), not on `runs`. Runs-history `runnerModel` is derived from it. | `web/lib/db/schema.ts:1296-1301,1489`; `web/lib/queries/task-detail.ts:84` |
| F10 | Runs-history UI: section header + count chip at `page.tsx:548-554`; existing header `LaunchPopover` at `page.tsx:438-447`; the dialog itself fetches `GET /api/runs/launch-options?taskId=` and `POST /api/runs` (SSE). | `page.tsx`; `web/components/board/launch-popover.tsx:408,529-619` |
| F11 | Max ADR at `main` HEAD = **ADR-118** ⇒ next free **ADR-119**. Max migration = **0086** ⇒ next would be 0087 (not needed — see §4). | `git show main:docs/decisions.md`; `migrations/meta/_journal.json` |

### The race this feature exposes (F4 + F5)
Worktree paths are `runId`-keyed (collision-free), but **branch names depend on a
stale `task.attemptNumber` read**. Today the `busy` gate makes two concurrent
launches of one task impossible, so the race is unreachable. This feature makes
it reachable: two simultaneous force-launches both compute `attempt-2`, the
first `git worktree add` creates branch `attempt-2`, the second collides and
fails with `CONFLICT`. **Fixing attempt-number allocation to be atomic is a
core, non-optional spec item (Phase 2).**

---

## 3. Design

### 3.1 Launchability — force-relaunch classifier
Add a **force** classification that, unlike `classifyManualTaskLaunchability`,
treats *every* run status as launchable while keeping the **task-level gate
allow-list** intact.

The force classifier **mirrors `classifyManualTaskLaunchability`'s shape**
(verified signature `(task:{status,triageStatus}, latestRun, relations)` —
note: it takes **no `flowId`** and does **not** check `unconfigured`). The only
difference is that force mode never produces the `busy` run-status verdict.

Precedence (force mode), highest-priority refusal first:
```
flagged      (task.triageStatus === "flagged")
> blocked    (any open blocking relation)
> launchable (otherwise — run status is deliberately NOT consulted)
```
- `unconfigured` is intentionally **omitted** (to match
  `classifyManualTaskLaunchability`): the runs-history button only renders once
  a task has ≥1 run, so the task is already configured — the verdict is
  unreachable from this entry point. Do not re-introduce a `flowId` arg here.
- Per the skill-context "allow-list, never deny-list" rule: force mode keeps the
  **task-gate allow-list** (`flagged`/`blocked` are the only refusals).
  Run-status is *deliberately* not consulted; document this so a future run
  status cannot silently change force behaviour.
- Implement as `classifyForceRelaunchLaunchability(args)` in
  `web/lib/runs/launchability.ts`, reusing the existing `flagged`/`blocked`
  predicate helpers (DRY — do not copy the predicates).

### 3.2 API contract changes (trust-labelled)
**`POST /api/runs`** — add body field:

| Field | Type | Default | Trust label | Notes |
|-------|------|---------|-------------|-------|
| `allowConcurrent` | boolean | `false` | **body-controlled behaviour flag** | Gated behind `requireProjectAction(projectId,"launchRun")` (same as every launch). Only *widens the run-status gate* (`busy`→ launchable). **Never** bypasses the task gates `flagged`/`blocked`. Not a cross-resource locator. |

Identifier audit for the route (skill-context trust rule), unchanged from today:
- `taskId` — body-controlled, but `projectId` is derived from the task row
  (`server-state`) and authorised via `requireProjectAction`. Trusted by
  derivation. **No new body-controlled cross-resource locator is introduced.**
- `flowId`/`runnerId`/`baseBranch`/`targetBranch` — existing body overrides.

`launchRunStaged`: when `allowConcurrent === true`, select
`classifyForceRelaunchLaunchability`; otherwise keep
`classifyManualTaskLaunchability`. The throw-on-not-launchable behaviour is
unchanged — only the classifier swaps. (So a `blocked` task with
`allowConcurrent:true` still gets `PRECONDITION`.)

**`GET /api/runs/launch-options`** — keep the signature unchanged; **add an
additive response field** `relaunch: { launchable: boolean, reason: VerdictCode }`
computed with `classifyForceRelaunchLaunchability`, alongside the existing
`launchability` (manual). One fetch then serves both the header (manual) and the
runs-history (force) buttons with the correct verdict each; fully
backward-compatible (no param change, no existing caller breaks). The new
button's popover reads `relaunch`; existing callers ignore the added field.
(Decision: additive response field over a `mode` query param — the page renders
both launch buttons, so one response carrying both verdicts avoids a second
fetch and any chance of the wrong classifier; the 2nd classifier runs over the
same in-memory data — negligible cost.)

Launch activity (verified — there is **no** `domain_events` outbox on launch):
the launch tx records a `recordTaskActivity(tx, { eventKind:"run_launched",
payload:{runId, attemptNumber} })` **task_activity** (ADR-078,
`services/runs.ts:1107`) plus the social-board `inbox_items` fan-out. A
force-relaunch reuses `launchRun`, so it records the **same `run_launched`
task_activity per launch** automatically — it is a *creation*, not a restart.
**No new activity/event kind** is introduced (decision). NB: the activity +
inbox row fire **per launch** even when the task is already `InFlight` (see
§3.4).

No new error code (`PRECONDITION`/`CONFLICT` reused — ADR-008 closed union).

### 3.3 Atomic attempt-number allocation (race fix)
Replace the stale-read allocation (F4) with an atomic counter bump performed
**before** branch derivation:
```
UPDATE tasks SET attempt_number = attempt_number + 1
WHERE id = $taskId
RETURNING attempt_number;     -- $newAttempt
```
- Run it as its own atomic statement (or `SELECT … FOR UPDATE` + update) before
  deriving `branch`. Each concurrent launch then reserves a **distinct**
  `attempt_number` ⇒ distinct branch ⇒ no `git` collision.
- **Remove** the `attemptNumber: newAttempt` write from the main launch
  transaction (services/runs.ts:1099): the early allocation is now the *sole*
  writer of `attempt_number`. (Leaving it in would let a slower concurrent
  launch clobber a higher value — exactly the clobber the skill-context
  multi-store-atomicity rule warns about.) The main tx still writes
  `tasks.status = "InFlight"`.
- **Crash-window enumeration** (skill-context atomicity rule):
  - Allocation succeeds, then any later precondition / `addWorktree` / tx fails or
    the process dies → the `attempt_number` is **burned** (a gap). Acceptable:
    `attempt_number` is a monotonic counter; gaps carry no meaning; the next
    launch takes the next value. No run row, no worktree, `tasks.status`
    untouched → the task is still force-launchable. **State after every window
    is a clean, retryable non-state.**
  - The existing worktree compensation (`removeWorktree` on post-`addWorktree`
    failure) is unchanged and still removes the orphan worktree.
- A `blocked`/`flagged` refusal happens **before** allocation (the classifier
  gate at the top of `launchRunStaged`), so a refused launch never burns a
  number.
- **Idempotent status write + per-launch activity (verified):** the main tx sets
  `tasks.status = "InFlight"` unconditionally. For a concurrent relaunch the task
  is *already* `InFlight`, so that set is an idempotent no-op (no real status
  flip), yet `recordTaskActivity(run_launched)` + the `inbox_items` fan-out still
  fire **per launch** (`services/runs.ts:1095-1113`). This is intended (each
  launch is a real event) but must be audited (§3.4, Phase 5) so no downstream
  consumer treats `run_launched` as a `Backlog→InFlight` transition.

### 3.4 Read-model fan-out (additive concurrency)
With >1 non-terminal run per task allowed, audit every consumer that could
assume "one active run per task" (skill-context "fan a new state out to ALL
consumers" rule). Expected outcome — most are already latest-run based (F7) and
safe; this task **proves** it and fixes any gap with a regression test:

| Consumer class | File(s) | Expectation |
|----------------|---------|-------------|
| Board read model / column | `web/lib/board.ts`, board queries | Latest-run derivation — safe; confirm no "single active run" assumption. |
| Launchability (board / launch-options manual) | `web/lib/runs/launchability.ts` | Uses latest run — safe; force mode is opt-in. |
| Concurrency cap / queue | `web/lib/scheduler.ts` | Counts live runs **globally**; two live runs of one task count as 2 — correct, no change. |
| Reconcile / crash sweeps | run reconcile + idle/keepalive sweeps | Operate per-run, not per-task — confirm; add note if a per-task assumption exists. |
| Promotion | `promoteRun` service | Per-run/per-workspace (workspace keyed on runId) — confirm no cross-run-of-same-task clobber. |
| Scheduler latch / auto-launch | `lib/run-schedules/dispatch.ts`, `lib/scheduler/handlers/auto-launch-triaged.ts` | Use `classifyTaskLaunchability` (`busy` blocks) — they never auto-fan concurrent; confirm force flag is not threaded there. |
| "Active run for task" lookups | grep `getActive*`, `taskId` + non-terminal filters | Each must tolerate multiple rows (e.g. `.orderBy(startedAt desc).limit(1)` or aggregate) — fix any `assert single`. |
| `run_launched` activity consumers + inbox | `lib/db/schema.ts` (kind constraints), social-board activity/inbox writers | Confirm no consumer treats `run_launched` as a `Backlog→InFlight` flip; confirm per-relaunch `inbox_items` fan-out is acceptable (ralph-loop volume). |
| Runs-history totals | `web/lib/queries/task-detail.ts` | `totals`/`latest` are reduced from the full row array — **must keep reducing over ALL runs** even after the display rows are capped (see §3.8). |

### 3.5 UI
- In `page.tsx` runs-history header (around lines 548–554), render a launch
  button to the right of the runs-count chip. The chip itself only renders when
  `runCount > 0`, so the **button appears only once a task has ≥1 run** — the
  first launch stays on the existing header `LaunchPopover` (page.tsx:438–447).
  No button (and no chip) at 0 runs.
- Reuse `LaunchPopover` with a new prop `forceRelaunch` (a.k.a.
  `allowConcurrent`) that:
  - posts `allowConcurrent: true` in the `POST /api/runs` body;
  - reads the `relaunch` verdict from the existing
    `GET /api/runs/launch-options?taskId=…` response (no extra param/fetch);
  - **precise gate change** (verified `createDisabled` at launch-popover.tsx:714
    = `!(options?.launchability.launchable || setUpReady)`): in `forceRelaunch`
    mode gate on **`options.relaunch.launchable`** instead of
    `options.launchability.launchable`. The `busy`/`pending` terms in
    `createDisabled` are the popover's own *submit-in-flight* flags — leave them.
    The button thus stays disabled only when the `relaunch` verdict is not
    `launchable` (task-gated: `flagged`/`blocked`), showing that reason.
- Affordance per project UI conventions: **icon + label button** (not text-only).
  Label: EN "Run again" / RU **«Запустить ещё»**, with a play/repeat icon to the
  left. Placed immediately to the right of the runs-count chip. Success shown as
  a green check glyph (the SSE launch-progress already drives this in
  `LaunchPopover`).
- i18n (EN + RU) in the `taskDetail` namespace: the "Run again" / «Запустить
  ещё» label + the disabled-reason strings for `flagged`/`blocked` (reuse
  existing launchability reason keys if present; add only what's missing).

### 3.8 Runs-history list cap (no per-task run limit)
There is **no cap** on how many runs a task may accumulate (hundreds are
allowed). The runs-history render is bounded to the **latest 10 rows** until real
pagination ships.

**Verified pitfall:** in `web/lib/queries/task-detail.ts` `totals` (runCount +
all token sums, line 352) and `latest` (line 351) are **reduced in JS from the
same `runRows` array** — there is no separate aggregate. Naively adding
`.limit(10)` to that query would make the count chip and token totals reflect
only the latest 10 runs (a lying chip). So the change is **two-part**:
1. **Totals over ALL runs** — compute `runCount` + token sums via a SQL
   `count()`/`sum()` aggregate (or keep reducing over the full set). The chip
   keeps the **true total**.
2. **Display rows capped to 10** — a separate ordered `.limit(10)` query (or
   `runRows.slice(0,10)`) feeds the table; `latest` = newest row.
The SQL-aggregate + limited-rows split is preferred (it also avoids fetching 500
rows to show 10). Full pagination is deferred (Phase 2 candidate).

### 3.6 No deployment touchpoints
No new env var, config file, sidecar binary, bound port, or host-mounted file.
Per the skill-context deployment rule, this is recorded explicitly: **no
`Dockerfile`/`compose*.yml`/`.env.example` changes are required.**

### 3.7 No DB migration required (and why)
`tasks.attempt_number` already exists; worktree paths are `runId`-keyed (F5); no
unique constraint assumes a single active run per task (F8). The change is
*allocation timing* and *gate selection*, not schema. **No Drizzle migration is
added** (next free idx 0087 is left unused). This is called out so `/aif-verify`
does not expect a migration. (If §3.4's audit unexpectedly finds a missing index
needed for a multi-run query, that becomes a scoped migration task — not
anticipated.)

---

## 4. Contract-surface → spec-file traceability (skill-context rule)

| Surface changing | Spec file(s) to update |
|------------------|------------------------|
| `POST /api/runs` body gains `allowConcurrent` | `docs/api/web.openapi.yaml` (`/api/runs`) + prose in `docs/system-analytics/tasks.md` |
| `GET /api/runs/launch-options` gains additive `relaunch` response field | `docs/api/web.openapi.yaml` (`/api/runs/launch-options`) |
| Runs-history row query capped to latest 10 (chip keeps true total) | `docs/system-analytics/tasks.md` (runs-history display note) |
| Launch activity: same `run_launched` task_activity (ADR-078), **no** new kind | `docs/system-analytics/social-board.md` / `tasks.md` (ADR-078) — confirm no kind change (it is **not** a `domain_events` outbox row) |
| New launchability verdict path (force-relaunch) | `docs/system-analytics/tasks.md` (launchability precedence) |
| Additive concurrency + atomic attempt allocation invariant | `docs/system-analytics/runs.md` + `docs/system-analytics/tasks.md` |
| Architectural decision | `docs/decisions.md` → **ADR-119** (+ index table row) |
| No new error code | `docs/error-taxonomy.md` — confirm `PRECONDITION` row already covers "launch refused by launchability"; add a clause if absent (no new code) |
| New i18n keys | `web/messages/en.json` + `web/messages/ru.json` (`taskDetail`) |
| (No new DB column/table/index, no new env var, no new script) | — explicitly none |

---

## Commit Plan
- **Commit 1** (Phase 0, T0.1–T0.4): `docs(runs): spec + ADR-119 + analytics for manual force-relaunch from task history`
- **Commit 2** (Phase 1, T1.1–T1.2): `feat(launchability): force-relaunch classifier (task-gates only)`
- **Commit 3** (Phase 2, T2.1–T2.2): `fix(runs): atomic attempt-number allocation (concurrent-launch branch race)`
- **Commit 4** (Phase 3, T3.1–T3.2): `feat(api): allowConcurrent on POST /api/runs + relaunch field on launch-options`
- **Commit 5** (Phase 4, T4.1–T4.2): `feat(web): relaunch button in task runs-history header`
- **Commit 6** (Phase 5, T5.1–T5.3): `chore(runs): concurrency fan-out audit + docs as-built sync`

---

## Tasks

> Test-integrity contract (skill-context M10 rule) applies to every code phase:
> each promised test **names its vitest project** (`unit` = `lib/**/*.test.ts` /
> `components/**/*.test.ts` / `app/**/__tests__/**/*.test.ts`; `integration` =
> `lib/**/*.integration.test.ts` / `app/**/*.integration.test.ts`), is confirmed
> matched by the runner glob (`vitest list`), and each phase exits only on a
> **green full suite** (`pnpm --filter maister-web test:unit && … test:integration`).
> Memory note: atomicity (Phase 2) **must** be proven against real Postgres —
> mocked-unit tests are blind to the row-level race.

### Phase 0 — SDD spec + analytics (front-loaded; complete & internally consistent before any code)

- [x] **T0.1 — Author the feature spec.** Create
  `.ai-factory/specs/relaunch-from-task-history.spec.md`: problem, the three
  locked decisions (§1), functional requirements, **acceptance criteria** (one
  per requirement, each test-mappable), the trust-label table (§3.2), the
  force-launchability precedence (§3.1), the atomic-allocation invariant +
  crash-window table (§3.3), the read-model fan-out matrix (§3.4), and the
  edge-case list (§6). Implementation-status tags (Designed/Implemented).
  *Logging:* N/A (doc). *Files:* `.ai-factory/specs/relaunch-from-task-history.spec.md`.

- [x] **T0.2 — Reserve & write ADR-119.** In `docs/decisions.md` add
  `### ADR-119: Manual force-relaunch (additive concurrent runs per task) +
  atomic attempt-number allocation` with context/decision/consequences, and add
  its row to the ADR index table. **Re-verify** the number against
  `git show main:docs/decisions.md` at write time (skill-context numbering
  rule); if `main` advanced past 118, take the next free number and update all
  references. *Files:* `docs/decisions.md`.

- [x] **T0.3 — Update system-analytics.** `docs/system-analytics/tasks.md`:
  add the force-relaunch launchability precedence and the "additive concurrency,
  >1 live run per task, manual-only" semantics; note the launch-options
  `relaunch` field and the runs-history latest-10 display cap (chip keeps true
  total). `docs/system-analytics/runs.md`: document concurrent runs per task and
  the atomic attempt-number allocation invariant + crash windows. Keep both
  ERD-free (no schema change). *Files:* `docs/system-analytics/tasks.md`,
  `docs/system-analytics/runs.md`.

- [x] **T0.4 — Update API specs + error taxonomy.** `docs/api/web.openapi.yaml`:
  `POST /api/runs` request body `allowConcurrent` (boolean, default false, with
  description of the gate-widening + the body-controlled trust note); add the
  additive `relaunch` response field to `GET /api/runs/launch-options` with an
  example. Confirm
  `docs/error-taxonomy.md` `PRECONDITION` row covers "launch refused by
  launchability classifier"; add a clause if missing (**no new code**). *Files:*
  `docs/api/web.openapi.yaml`, `docs/error-taxonomy.md`.
  **Phase 0 exit:** spec complete & self-consistent; ADR-119 header present;
  analytics + openapi updated; explicitly **no migration / no new error code /
  no deployment change**.

### Phase 1 — Force-relaunch classifier (TDD)

- [ ] **T1.1 (RED) — Tests for the force classifier.** Extend
  `web/lib/runs/__tests__/launchability.test.ts` (vitest **unit**): force mode
  returns `launchable` for every run status (`Running`, `NeedsInput`,
  `HumanWorking`, `WaitingOnChildren`, `Pending`, `Crashed`, `Done` as
  target_terminal, `Review`, `Abandoned`, `Failed`); but returns `flagged` when
  triage-flagged and `blocked` when an open blocking relation exists. Assert the
  task-gate **precedence** (flagged > blocked). The classifier takes the same
  args as `classifyManualTaskLaunchability` (no `flowId` ⇒ no `unconfigured`
  case to test). Confirm the existing `classifyManualTaskLaunchability` busy
  cases are **unchanged** (regression). *Files:*
  `web/lib/runs/__tests__/launchability.test.ts`.

- [ ] **T1.2 (GREEN) — Implement `classifyForceRelaunchLaunchability`.** In
  `web/lib/runs/launchability.ts`, reusing the existing `flagged`/`blocked`
  predicate helpers (DRY), with the same signature as
  `classifyManualTaskLaunchability`; do **not** consult run status. *Logging:*
  `DEBUG [launchability.force] task=<id> verdict=<v> gate=<reason?>` at decision
  points. *Files:* `web/lib/runs/launchability.ts`.
  **Exit:** unit suite green.

### Phase 2 — Atomic attempt-number allocation (TDD, real Postgres)

- [ ] **T2.1 (RED) — Concurrency race test.** New integration test
  `web/app/api/runs/__tests__/relaunch-concurrency.integration.test.ts` (vitest
  **integration**, real PG): fire two `launchRunStaged` calls for the **same
  task** concurrently (both with `allowConcurrent:true`); assert both succeed,
  receive **distinct** `attempt_number`s and **distinct** branch names
  (`…/attempt-N` ≠ `…/attempt-M`), distinct worktree paths, and **no** `git`
  CONFLICT. Confirm the file path matches the `integration` include glob via
  `vitest list`. *Files:* the new test file.

- [ ] **T2.2 (GREEN) — Make allocation atomic.** In
  `web/lib/services/runs.ts`: replace the stale `newAttempt = task.attemptNumber
  + 1` (≈ line 822) with an atomic `UPDATE tasks SET attempt_number =
  attempt_number + 1 … RETURNING attempt_number` executed **before** branch
  derivation; use the returned value for `branch`. **Remove** the
  `attemptNumber: newAttempt` write from the main launch transaction (≈ line
  1099) so the early bump is the sole writer; keep the `tasks.status="InFlight"`
  write. Migrate any existing test/assertion that depends on the old write
  ordering (enumerate them when the diff is in hand — e.g.
  `post-branch.test.ts`, `launch-branch.integration.test.ts`). *Logging:*
  `DEBUG [runs.launch] allocated attempt=<n> branch=<branch> run=<runId>`.
  *Files:* `web/lib/services/runs.ts` (+ assertion migrations).
  **Exit:** integration + unit suites green.

### Phase 3 — API: `allowConcurrent` + `relaunch` field (TDD)

- [ ] **T3.1 (RED) — Route/launch tests.** Extend
  `web/app/api/runs/__tests__/post-branch.test.ts` (**unit**) for the body
  schema: `allowConcurrent` parses, defaults false. Add integration coverage
  (extend `route.enforcement.integration.test.ts` or a focused new file): with a
  **busy** latest run, `allowConcurrent:true` ⇒ launch succeeds; `false`/absent
  ⇒ `PRECONDITION` (busy). With a **blocked** task, `allowConcurrent:true` ⇒
  still `PRECONDITION` (force does **not** bypass task gates). For
  `GET /api/runs/launch-options`: the new `relaunch` field returns `launchable`
  while the latest run is busy, and the correct gate verdict when
  flagged/blocked (the existing `launchability` field is unchanged). *Files:*
  the named test files.

- [ ] **T3.2 (GREEN) — Implement.** Add `allowConcurrent` to the
  `POST /api/runs` zod body (`web/app/api/runs/route.ts`); thread it into
  `launchRunStaged`/`launchRun` (`web/lib/services/runs.ts`) to select the force
  classifier when true. Add the `relaunch` field to
  `web/app/api/runs/launch-options/route.ts` computed via the force classifier
  (alongside the unchanged `launchability`). Enforce the same `launchRun` permission for
  the flag (no new auth path). *Logging:* `INFO [runs.launch] mode=<manual|force>
  allowConcurrent=<bool> task=<id>`. *Files:* `web/app/api/runs/route.ts`,
  `web/lib/services/runs.ts`, `web/app/api/runs/launch-options/route.ts`.
  **Exit:** unit + integration suites green.

### Phase 4 — UI: runs-history relaunch button (TDD where testable)

- [ ] **T4.1 (RED) — Popover force-mode tests.** Extend
  `web/components/board/__tests__/launch-popover.test.ts` (**unit**): in
  `forceRelaunch` mode the create button is **enabled** when the latest run is
  busy, and **disabled with the gate reason** when the force launchability
  verdict is `flagged`/`blocked`; the POST body carries
  `allowConcurrent:true` and the popover gates on the `relaunch` verdict from
  launch-options. *Files:* `web/components/board/__tests__/launch-popover.test.ts`.

- [ ] **T4.2 (GREEN) — Build the button + popover prop.** Add the
  `forceRelaunch` prop to `web/components/board/launch-popover.tsx`: gate
  `createDisabled` on `options.relaunch.launchable` (instead of
  `options.launchability.launchable`) — the `busy`/`pending` submit-flags stay;
  post `allowConcurrent:true`. Render the icon+label launch button ("Run again" /
  «Запустить ещё», play/repeat icon) to the right of the runs-count chip in
  `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx` (≈ lines 548–554),
  wiring the same `LaunchPopover`. Add EN+RU `taskDetail` i18n keys for the
  label and the force-mode disabled reasons; reuse existing launchability reason
  keys where present. *Logging:* client `console.debug`
  guarded by the existing debug flag at launch dispatch. *Files:*
  `web/components/board/launch-popover.tsx`, `…/tasks/[number]/page.tsx`,
  `web/messages/en.json`, `web/messages/ru.json`.
  **Exit:** unit suite green; manual UI smoke (button right of chip; enabled
  while a run is `Running`; disabled with reason when the task is `blocked`).

- [ ] **T4.3 — Cap runs-history rows to latest 10 WITHOUT corrupting totals.**
  In `web/lib/queries/task-detail.ts`, `totals` (runCount + token sums, line 352)
  and `latest` (line 351) are currently **reduced from the full `runRows`
  array** — so a naive `.limit(10)` on that query would make the chip count and
  token totals reflect only 10 runs. Split it (§3.8): (a) compute `runCount` +
  token sums over **all** runs via a SQL `count()`/`sum()` aggregate (the chip
  keeps the true total); (b) feed the table from a separate ordered
  `.limit(10)` rows query (or `runRows.slice(0,10)`), with `latest` = newest
  row. Prefer the SQL-aggregate split so 500-run tasks don't fetch 500 rows.
  Add/extend an **integration** test (real PG —
  `web/lib/queries/__tests__/task-detail.integration.test.ts`, or co-locate with
  the existing query tests) asserting: with >10 flow runs, exactly the 10 newest
  rows return, `totals.runCount` = true total, and the token totals = sum over
  **all** runs (not just the 10 shown). *Files:* `web/lib/queries/task-detail.ts`
  + its test.
  **Exit:** suite green.

### Phase 5 — Fan-out audit + docs as-built + verify

- [ ] **T5.1 — Concurrency fan-out audit.** Execute the §3.4 matrix: grep for
  per-task "single active run" assumptions (`getActive*`, non-terminal +
  `taskId` filters, `.limit(1)` that should aggregate, any `assert`/invariant on
  one active run). Confirm each consumer tolerates >1 live run, or fix it with a
  **regression test** in the appropriate vitest project. Confirm the force flag
  is **not** threaded into scheduler/auto-launch/run-schedule paths. **Also
  audit the `run_launched` activity path:** confirm no consumer treats
  `run_launched` as a `Backlog→InFlight` transition (a concurrent relaunch fires
  it while the task is already `InFlight`), and confirm the per-relaunch
  `inbox_items` fan-out is acceptable (a long ralph-loop ⇒ many inbox rows;
  pre-existing in kind, new in frequency — flag if it needs throttling). *Files:*
  as discovered (audit-driven).

- [ ] **T5.2 — Docs as-built sync (`/aif-docs`).** Reconcile
  `tasks.md`/`runs.md`/`web.openapi.yaml`/ADR-119 with the shipped code; update
  the `web/CLAUDE.md` slice only if a documented surface changed. Re-run the ADR
  anchor check (`scripts/validate-docs-adr-anchors.mjs`) since a green
  `pnpm validate:docs` does **not** resolve ADR anchors. *Files:* docs as needed.

- [ ] **T5.3 — Full verification.** `pnpm --filter maister-web lint` (scoped /
  check-only — do **not** run the repo-wide `--fix` that reformats ~60 files),
  full `test:unit` + `test:integration` green, and confirm acceptance criteria
  from T0.1 each map to a passing test. *Files:* none (gate).

---

## 5. Acceptance criteria (rollup)
1. From the task detail runs-history header, a launch button sits to the right
   of the "N запусков" chip and opens the full launch dialog.
2. Clicking it and creating a run **succeeds while a prior run is `Running`**
   (or any other run status), producing an additional non-terminal run for the
   task; extras beyond the cap queue `Pending` with a position.
3. The button is **disabled with a reason** when the task is `blocked` or
   `flagged` (task-level gates). (`unconfigured` is unreachable — the button
   only renders once a task has ≥1 run.)
4. Two concurrent force-launches of one task get **distinct attempt numbers and
   branches** and both succeed (no `git` CONFLICT) — proven against real PG.
5. Scheduled / auto-launch / run-schedule paths are **unchanged** (no concurrent
   auto-fan); board flight-card relaunch behaviour unchanged.
6. `POST /api/runs` + `GET /api/runs/launch-options` contract changes are in
   `web.openapi.yaml`; ADR-119, `tasks.md`, `runs.md` reflect the design; **no
   migration, no new error code, no deployment change**.
7. The runs-history list renders **at most the 10 newest runs** while the chip
   shows the **true total** count; no per-task run-count limit is enforced.
8. The new button is labelled **«Запустить ещё»** with a play/repeat icon.
9. A relaunch records the **same `run_launched` task_activity** (ADR-078) as any
   launch — no new activity/event kind, and **no** `domain_events` outbox row is
   involved.
10. Full unit + integration suites green; lint clean.

## 6. Edge cases covered
- Concurrent same-task launches (branch/attempt race) — Phase 2.
- Force-launch on a `blocked`/`flagged` task — refused (`PRECONDITION`) before
  any side-effect — Phase 1 + 3.
- Cap reached at force-launch — new run goes `Pending` with `queuePosition`
  (existing scheduler path) — covered by reusing F6.
- Launch failure after attempt-number allocation — number burned (gap), no run
  row, task still launchable — Phase 2 crash-window doc + the worktree
  compensation path.
- Latest-run display with multiple live runs — board shows most-recent by
  `startedAt` (F7); audited in Phase 5.
- Supervisor unavailable — existing pre-side-effect refusal still applies
  (unchanged).

---

## Resolved during planning (все вопросы закрыты)
1. **Лейбл кнопки** — «Запустить ещё» + иконка (play/repeat).
2. **Лимит ранов на задачу** — нет лимита (хоть 500). Пагинации пока нет:
   runs-history показывает только **10 последних** строк, чип — истинный total.
3. **launch-options** — добавляем **аддитивное поле `relaunch`** в ответ (без
   параметра `mode`): одна выборка кормит обе кнопки на странице, обратная
   совместимость по построению.
4. **Событие запуска** — переиспользуется `launchRun`, поэтому пишется та же
   активность `run_launched` (task_activity, ADR-078), что и при любом запуске;
   отдельного вида события нет (это `domain_events`-аутбокса не касается) — это
   создание, а не перезапуск.
