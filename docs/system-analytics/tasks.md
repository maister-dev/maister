# Tasks domain

## Purpose

A **task** is the operator's unit of intent — one card on a project's
board with a title, prompt, and Flow assignment. Tasks have a simple
board state (`Backlog | InFlight | Done | Abandoned`) and a **1:N**
relationship to runs ([ADR-018](../decisions.md#adr-018-task--run-cardinality-is-1n)).
With ADR-078 (Designed) every task additionally carries a stable
human-readable identity `KEY-N` (`projects.task_key` + `tasks.number`) and
may participate in typed inter-task relations that gate launching; the
comment/activity/subscription/inbox substrate around tasks is owned by
[`social-board.md`](social-board.md).

## Domain entities

- **Task** — board card. Persisted as `tasks` row.
- **Run** — execution attempt. See [`runs.md`](runs.md).
- **Assignment** — claimable human work item attached to the latest run,
  planned for role-owned waits such as permission, form, review, manual
  takeover, and conflict resolution.
- **External operation** — implemented token-authenticated API or MCP action that
  can create/read/update tasks, launch runs, or report evidence without using
  the web UI.
- **Attempt number** — monotonic counter per task, starting at 1. Current code
  stores it as a **mutable high-water mark** on `tasks.attempt_number`
  bumped inside the Launch transaction; there is no DB-level guarantee
  that a given attempt was actually persisted on a run. The
  `tasks_id_attempt_uq` UNIQUE on `(tasks.id, attempt_number)` is
  vacuous (PK already enforces unique `id`) and provides no
  per-attempt guard. The designed run-attempt schema moves the stamp onto
  `runs.attempt_number` with a real UNIQUE `(task_id, attempt_number)`
  so every run row is immutably tagged and duplicates are rejected at
  the DB.
- **Task key** (Implemented, ADR-078) — `projects.task_key`: platform-wide
  unique, matches `^[A-Z][A-Z0-9]{1,9}$`, set at registration (optional
  explicit `taskKey` or derived from the project name; collision →
  `CONFLICT`), immutable in Stage 1 (comment bodies store expanded `KEY-N`
  links). Migration backfill auto-uniquifies deterministically.
- **Task number** (Implemented, ADR-078) — `tasks.number`: per-project
  monotonic integer allocated from `projects.next_task_number` inside the
  `createTask` transaction (`UPDATE … RETURNING`; the projects-row lock
  serializes concurrent creates), backstopped by
  `UNIQUE(project_id, number)`. Numbers are never reused — deletion leaves
  a hole. `KEY-N` = `task_key` + `-` + `number`.
- **Relation** (Implemented, ADR-078) — `task_relations` row: canonical
  one-direction `(from_task_id, kind, to_task_id)` with
  `kind ∈ {blocks, depends_on, parent_of}`,
  `UNIQUE(from_task_id, kind, to_task_id)`, no self-relations,
  same-project only in Stage 1 (`CONFIG` on violation). Inverse labels
  ("blocked by", "required by", "child of") are render-time only.

## State machine — board axis

```mermaid
stateDiagram-v2
    [*] --> Backlog: create task<br/>(title + prompt + flow)
    Backlog --> InFlight: Launch click<br/>(preconditions pass,<br/>run created)
    InFlight --> Backlog: latest run terminates<br/>Failed | Crashed | Abandoned
    InFlight --> Done: latest run merged<br/>(terminal)
    Backlog --> Abandoned: explicit Discard click
    InFlight --> Abandoned: explicit Discard click
    Done --> [*]
    Abandoned --> [*]
```

Notes:

- The InFlight bucket contains runs in any of `Pending | Running |
NeedsInput | NeedsInputIdle | HumanWorking | Review | Crashed`.
- Planned assignment-aware board cards show the latest active assignment:
  role, assignee or unclaimed state, elapsed time, action kind, branch/ref when
  relevant, and stale-evidence summary.
- "Latest run" on the card today is `runs ORDER BY started_at DESC
LIMIT 1 WHERE task_id = ?`. Once `runs.attempt_number`
  lands this becomes `MAX(attempt_number) WHERE task_id = ?`.
- Auto-return to `Backlog` on `Failed | Crashed | Abandoned` enables
  ralph-loop retry without recreating the task.

## Process flows

### Create a task (Designed)

```mermaid
sequenceDiagram
    actor U as Operator
    participant UI as Web UI
    participant W as Web tier
    participant DB as Postgres

    U->>UI: Open New Task modal
    UI->>W: GET project's flows[]
    W->>DB: SELECT launchable flows WHERE project_id=?
    DB-->>UI: Flow options
    U->>UI: Fill title, prompt, flow
    UI->>W: POST /api/projects/[slug]/tasks
    W->>W: Validate (non-empty title/prompt, flow exists)
    alt validation fails
        W-->>UI: 400 PRECONDITION
    end
    W->>DB: INSERT tasks (status=Backlog, attempt_number=1)
    DB-->>W: row
    W-->>UI: 201 { id, status, ... }
    UI-->>U: card appears in Backlog column
```

### Create a task from external operations (M16 — Implemented)

```mermaid
sequenceDiagram
    participant EXT as CI/script/agent MCP
    participant W as Web tier
    participant DB as Postgres

    EXT->>W: POST /api/v1/ext/projects/[slug]/tasks<br/>Authorization: Bearer token
    W->>DB: SELECT project_tokens WHERE prefix/hash/project/scope valid
    alt invalid, expired, revoked, wrong project, or missing scope
        W-->>EXT: 401/403/404
    end
    W->>W: Validate title, prompt, flow, optional executor
    W->>DB: INSERT tasks (status=Backlog, created_by_user_id=owner when user token)
    W->>DB: INSERT token_audit_log row
    W-->>EXT: 201 { id, status, ... }
```

### Launch a task — retry loop (Implemented launch, UI designed)

```mermaid
sequenceDiagram
    actor U as Operator
    participant UI as Web UI
    participant W as Web tier
    participant SCH as lib/scheduler (planned)
    participant DB as Postgres
    participant SV as Supervisor

    U->>UI: Click Launch on Backlog card
    UI->>W: POST /api/runs { taskId, runnerId? }
    W->>DB: SELECT task, project, flow, executor
    W->>W: Resolve executor (override chain)
    alt EXECUTOR_UNAVAILABLE
        W-->>UI: 503 EXECUTOR_UNAVAILABLE
    end
    W->>SV: GET /health
    alt supervisor unavailable
        W-->>UI: 503 EXECUTOR_UNAVAILABLE (no worktree/run/workspace/task change)
    end
    W->>W: Run precondition checks (clean repo, branch free, worktree path free)
    alt PRECONDITION
        W-->>UI: 409 + specific blocker
    end
    W->>SCH: requestSlot()
    alt cap hit
        SCH-->>W: queue (status=Pending)
        W-->>UI: 202 + queue position
    end
    W->>DB: INSERT runs (status=Pending)<br/>UPDATE tasks SET attempt_number=N+1
    W->>SCH: promote (cap not hit)
    SCH->>W: ok, proceed
    W->>SV: POST /sessions { runId, projectSlug, worktreePath, ... }
    SV-->>W: 201 { sessionId, pid }
    W->>DB: UPDATE runs SET status=Running, acp_session_id=sessionId
    W->>DB: UPDATE tasks SET status=InFlight
    UI-->>U: card moves to In Flight column
```

### Failure auto-return to Backlog

```mermaid
flowchart LR
    Latest{Latest run terminal?} -->|status in <br/>Failed/Crashed/Abandoned| Return[UPDATE tasks SET status=Backlog]
    Latest -->|status=Done| Done[UPDATE tasks SET status=Done<br/>terminal]
    Return --> UI[Card re-appears in Backlog<br/>Launch button re-enabled]
    UI --> NextLaunch[Next Launch click<br/>attempt_number = max + 1]
```

### Relations gate launching (Implemented, ADR-078)

`classifyTaskLaunchability` gains optional relation context and a
`"blocked"` classification with precedence
`target_terminal > crashed > busy > blocked > launchable` — relations gate
*launching* only, they never mask an active run's state. Every consumer
threads the context: `launchRun` (single choke point for internal AND ext
launches), the run-schedules dispatcher (skip with reason —
[`run-schedules.md`](run-schedules.md)), and the board/portfolio read
models (launch disabled + blocker chips on the card).

```mermaid
flowchart TD
    T[Task T launch decision] --> Q{open relation blockers?}
    Q -- none --> Rest[existing classification:
target_terminal / crashed / busy / launchable]
    Q -- yes --> Pred{counterpart status in
Backlog or InFlight?}
    Pred -- no --> Rest
    Pred -- yes --> Blocked[blocked — launch refused with
blocker KEY-N list in the message]
    Blocked --> UI[card shows reason chip,
Launch disabled]
    Blocked --> Sched[dispatcher records skip outcome]
```

Blocking predicate: task T is blocked iff there exists a relation
`(X blocks T)` or `(T depends_on Y)` whose counterpart task status is in
{`Backlog`, `InFlight`} — `Done` AND `Abandoned` both release, so a
discarded blocker cannot deadlock its dependents. `parent_of` never gates.
No cycle detection: a mutual block makes both tasks unlaunchable until one
relation is removed; the UI always renders blockers as removable chips.

### Assignment-aware board card (Planned)

```mermaid
flowchart TD
    Run[Latest run] --> Active{active assignment?}
    Active -- no --> Normal[show run status<br/>Pending/Running/Review/Crashed]
    Active -- yes --> Card[show role + assignee<br/>elapsed time + action kind]
    Card --> Branch{branch/ref?}
    Branch -- yes --> BranchUi[show checkout/return affordance]
    Branch -- no --> HitlUi[show response/review affordance]
    Card --> Evidence[show current/stale<br/>evidence summary]
```

## Expectations

- Task ↔ Run cardinality is 1:N; a task can spawn many runs over its
  lifetime via the retry loop.
- Current code: per-task attempt counter lives on `tasks.attempt_number` as a
  mutable high-water mark, monotonic starting at 1, bumped by the
  Launch transaction. The DB has **no** per-attempt uniqueness guard
  (`tasks_id_attempt_uq` is vacuous because `tasks.id` is the PK);
  `runs` rows carry no attempt stamp at all, so duplicate or missing
  attempts are not detectable from a single table.
- **(Designed)** `runs.attempt_number` becomes the immutable
  per-attempt stamp, monotonic per `task_id` starting at 1, with the
  real DB-enforced UNIQUE `(task_id, attempt_number)` on `runs`.
- "Latest run" displayed on a card is the row with `MAX(started_at)`
  for the `task_id`. Designed run-attempt schema switches to
  `MAX(attempt_number) WHERE task_id = ?` on `runs`.
- Board state is exactly `Backlog | InFlight | Done | Abandoned`.
- `InFlight` is a derived bucket; it contains tasks whose latest run is
  in `Pending | Running | NeedsInput | NeedsInputIdle | HumanWorking |
  Review | Crashed`.
- **(Planned)** Human-owned waits create assignments. The latest active
  assignment is rendered directly on the task card and in the portfolio inbox;
  the card must make clear that the task is waiting on a role/person, not just
  "running".
- **(Planned)** Roles are routing labels and audit context, not permission
  boundaries. Any project teammate can claim, respond, return, or merge in the
  current target; MAIster records who acted without blocking on role mismatch.
- **(Planned)** Assignment statuses are
  `Open | Claimed | Working | Returned | Responded | Cancelled | Superseded`.
  Only `Open | Claimed | Working` appear as actionable inbox items.
- **(Planned)** Manual takeover assignments include branch/ref, checkout
  affordance, return action, elapsed time, and stale-evidence summary.
- Latest run terminates in `Failed | Crashed | Abandoned` → task auto-
  returns to `Backlog` and Launch button re-appears.
- `Done` is terminal for the task; Done tasks NEVER return to `Backlog`.
- Title and prompt are non-empty at creation.
- **(M16 + token actor-scope support — Implemented)** External task creation
  uses the same validation as the UI and records the API token in
  `token_audit_log`. User-owned tokens also set `tasks.created_by_user_id` to
  the token owner; project tokens leave it null.
- **(M16 — Implemented)** The thin MCP facade can create/list/get/update tasks only
  through the same domain path as the API; it cannot bypass token scopes,
  assignment rules, or run launch preconditions.
- **(Implemented, ADR-078)** `tasks.number` MUST be unique per project
  (`UNIQUE(project_id, number)`), allocated only inside the `createTask`
  transaction, and never reused; `projects.task_key` MUST be platform-wide
  unique and immutable in Stage 1.
- **(Implemented, ADR-078)** A task with an open relation blocker
  (`X blocks T` or `T depends_on Y`, counterpart ∈ {`Backlog`, `InFlight`})
  MUST be refused launch as `"blocked"` at EVERY entry point — internal
  `POST /api/runs`, ext `POST /api/v1/ext/runs`, and the schedules
  dispatcher — via the shared classifier, never via UI-only logic.
- **(Implemented, ADR-078)** Relations MUST be same-project in Stage 1
  (`MaisterError("CONFIG")` otherwise) and duplicate relation writes MUST
  be idempotent no-ops.
- Launch runs precondition checks (clean repo, branch free, worktree
  path free, executor registered) BEFORE inserting the `runs` row.
- Global concurrency cap exceeded on Launch → run inserted as
  `Pending`, UI shows queue position; this is NOT an error.
- Discarding a task with a live run MUST terminate the supervisor
  session (`DELETE /sessions/<id>`) before the task transition; failure
  to terminate does NOT block the transition (reconciliation cleans up).

## Edge cases

- **Empty title or prompt** → `PRECONDITION` (400).
- **`flow_id` not registered for this project** → `PRECONDITION`.
- **selected `runnerId` missing, disabled, or not ready** →
  `EXECUTOR_UNAVAILABLE`
  (503).
- **Dirty parent repo on Launch** → `PRECONDITION` ("commit or stash
  changes in `{repo_path}`").
- **Branch name `<branch_prefix><task_slug>` already exists** →
  `PRECONDITION` ("branch exists; abandon prior run or pick a different
  name").
- **Worktree path collision** → `PRECONDITION`.
- **Global concurrency cap hit** → run created as `Pending`, UI shows
  queue position. Not an error.
- **Discard a task that has a live run** — supervisor `DELETE
/sessions/<id>`, then mark worktree stale, then `tasks.status =
Abandoned`. Failure to terminate the session does NOT block the task
transition (the run reconciles to `Crashed` on next heartbeat tick).
- **(Implemented, ADR-078) Mutual block (`A blocks B` + `B blocks A`)** —
  both tasks classify `blocked` until one relation is removed; the UI
  renders blockers as removable chips, so the state is always recoverable.
  No cycle detection in Stage 1.
- **(Implemented, ADR-078) Cross-project or self relation** →
  `MaisterError("CONFIG")` (400).
- **(Implemented, ADR-078) Hole-y numbering** — deleting a task leaves a
  permanent gap in `KEY-N`; `next_task_number` never decrements. Not an
  error.

## Linked artifacts

- ADRs: [ADR-018 Task ↔ Run 1:N](../decisions.md#adr-018-task--run-cardinality-is-1n),
  [ADR-078 Social board substrate](../decisions.md#adr-078-social-board-substrate--per-project-task-numbering-typed-relations-polymorphic-actor).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md) (tasks + runs tables).
- Related domains: [`runs.md`](runs.md), [`workspaces.md`](workspaces.md),
  [`executors.md`](executors.md), [`social-board.md`](social-board.md)
  (comments, activity, subscriptions, inbox),
  [`run-schedules.md`](run-schedules.md) (dispatcher skip-on-blocked).
- Source: `web/lib/db/schema.ts` (tasks + runs tables),
  `web/lib/runs/launchability.ts`, `web/lib/social/relations.ts` (Designed).
