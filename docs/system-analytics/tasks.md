# Tasks domain

## Purpose

A **task** is the operator's unit of intent — one card on a project's
board with a title, prompt, and Flow assignment. Tasks have a simple
board state (`Backlog | InFlight | Done | Abandoned`) and a **1:N**
relationship to runs ([ADR-018](../decisions.md#adr-018-task--run-cardinality-is-1n)).

## Domain entities

- **Task** — board card. Persisted as `tasks` row.
- **Run** — execution attempt. See [`runs.md`](runs.md).
- **Attempt number** — monotonic counter per task, starting at 1.
  UNIQUE `(task_id, attempt_number)` on runs.

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
NeedsInput | NeedsInputIdle | Review | Crashed`.
- "Latest run" is `MAX(attempt_number)` for the task; that's what the
  card shows.
- Auto-return to `Backlog` on `Failed | Crashed | Abandoned` enables
  ralph-loop retry without recreating the task.

## Process flows

### Create a task (Designed M4)

```mermaid
sequenceDiagram
    actor U as Operator
    participant UI as Web UI
    participant W as Web tier
    participant DB as Postgres

    U->>UI: Open New Task modal
    UI->>W: GET project's flows[] + executors[]
    W->>DB: SELECT flows, executors WHERE project_id=?
    DB-->>UI: dropdown options
    U->>UI: Fill title, prompt, flow, optional executor override
    UI->>W: POST /api/projects/[slug]/tasks
    W->>W: Validate (non-empty title/prompt, flow/executor exist)
    alt validation fails
        W-->>UI: 400 PRECONDITION
    end
    W->>DB: INSERT tasks (status=Backlog, attempt_number=1)
    DB-->>W: row
    W-->>UI: 201 { id, status, ... }
    UI-->>U: card appears in Backlog column
```

### Launch a task — retry loop (Designed M6)

```mermaid
sequenceDiagram
    actor U as Operator
    participant UI as Web UI
    participant W as Web tier
    participant SCH as lib/scheduler (planned)
    participant DB as Postgres
    participant SV as Supervisor

    U->>UI: Click Launch on Backlog card
    UI->>W: POST /api/runs { taskId, executor_id_override? }
    W->>DB: SELECT task, project, flow, executor
    W->>W: Resolve executor (override chain)
    alt EXECUTOR_UNAVAILABLE
        W-->>UI: 503 + registered list
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
    W->>DB: INSERT runs (status=Pending, attempt_number=N+1)
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
    UI --> NextLaunch[Next Launch click ->,attempt_number = max + 1]
```

## Edge cases

- **Empty title or prompt** → `PRECONDITION` (400).
- **`flow_id` not registered for this project** → `PRECONDITION`.
- **`executor_override_id` not registered** → `EXECUTOR_UNAVAILABLE`
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

## Linked artifacts

- ADRs: [ADR-018 Task ↔ Run 1:N](../decisions.md#adr-018-task--run-cardinality-is-1n).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md) (tasks + runs tables).
- Related domains: [`runs.md`](runs.md), [`workspaces.md`](workspaces.md),
  [`executors.md`](executors.md).
- Source: `web/lib/db/schema.ts` (tasks + runs tables).
