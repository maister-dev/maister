# Runs domain

## Purpose

A **run** is one execution attempt of a task through a Flow. It owns
the ACP session, the worktree, and the per-run artifacts on disk. The
runs domain is the heart of MAIster's state machine; every other
domain projects state onto it.

## Domain entities

- **Run** — `runs` row. FK to `tasks`, `projects`, `flows`,
  `executors`.
- **ACP session id** — opaque resume handle (`runs.acp_session_id`).
  Lifecycle described in [`../decisions.md#adr-006-hybrid-hitl-keep-alive--checkpointresume`](../decisions.md#adr-006-hybrid-hitl-keep-alive--checkpointresume).
- **Workspace** — git worktree under
  `.maister/<slug>/runs/<runId>/`. See [`workspaces.md`](workspaces.md).
- **Per-run artifacts on disk**:
  - `<stepId>.log` — append-only stdout of each step.
  - `cost.jsonl` — token usage records.
  - `needs-input.json` — present while the run waits for structured
    form input.
  - `input-<stepId>.json` — atomic-written response payload.

## State machine — execution axis

```mermaid
stateDiagram-v2
    [*] --> Pending: created, awaiting slot
    Pending --> Running: scheduler promotes<br/>(cap has free slot)

    Running --> NeedsInput: agent requests permission<br/>or writes needs-input.json
    NeedsInput --> NeedsInput: web activity bumps<br/>keepalive_until +30min
    NeedsInput --> NeedsInputIdle: now > keepalive_until<br/>(graceful checkpoint)
    NeedsInput --> Running: user submits input<br/>(supervisor delivers via ACP)
    NeedsInputIdle --> Running: user submits input<br/>(supervisor respawns --resume)
    NeedsInputIdle --> Abandoned: 24h elapsed<br/>without response

    Running --> Review: agent exits 0
    Running --> Crashed: heartbeat dead<br/>no checkpoint
    Running --> Failed: agent exits non-zero<br/>(no recovery path)

    Crashed --> Running: Recover click<br/>(--resume with acp_session_id)
    Crashed --> Abandoned: Discard click<br/>(force-discard worktree)

    Review --> Done: merge --no-ff succeeds
    Review --> Review: merge --no-ff conflict<br/>(stays in Review)
    Review --> Abandoned: Abandon click

    Failed --> [*]: task returns to Backlog
    Done --> [*]
    Abandoned --> [*]: task returns to Backlog (or stays Abandoned)
```

Status names exactly match the `runs.status` enum in
`web/lib/db/schema.ts`.

## Process flows

### Happy path — Launch to Review (Designed M6/M7)

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Web tier
    participant DB as Postgres
    participant FS as Filesystem
    participant SV as Supervisor
    participant A as Adapter

    U->>W: POST /api/runs (taskId, executor override?)
    W->>DB: status=Pending then Running
    W->>FS: git worktree add
    W->>SV: POST /sessions
    SV->>A: spawn adapter
    A-->>SV: spawn ok
    SV-->>W: 201 sessionId
    loop step execution
        A-->>SV: stdout JSONL lines
        SV->>FS: append {stepId}.log + cost.jsonl
        SV-->>W: SSE session.line
        W-->>U: UI updates live
    end
    A->>A: exit 0
    SV-->>W: SSE session.exited
    W->>DB: runs.status=Review
    U->>W: GET /api/runs/[id]/diff (Designed M9)
    W-->>U: raw git diff
    U->>W: POST /api/runs/[id]/merge
    W->>FS: git merge --no-ff
    alt clean merge
        W->>DB: runs.status=Done
        W-->>U: 200 Done
    else conflict
        W->>FS: git merge --abort
        W-->>U: 409 CONFLICT (Review)
    end
```

### NeedsInput keep-alive cycle (Designed M7/M8)

```mermaid
sequenceDiagram
    participant A as Adapter
    participant SV as Supervisor
    participant W as Web tier
    participant DB as Postgres
    actor U as Operator

    A-->>SV: session.update or write needs-input.json
    SV-->>W: session.line (parsed in M7)
    W->>DB: runs.status=NeedsInput, keepalive_until=now+30min
    loop user active on run page
        U->>W: POST /api/runs/[id]/activity
        W->>DB: keepalive_until=now+30min
    end
    Note over W,DB: User leaves the page. Timer ticks.
    W->>W: scheduled check: now > keepalive_until
    W->>SV: POST /sessions/[id]/checkpoint (M8)
    SV->>A: graceful exit signal
    A-->>SV: agent persists JSONL session store, exits 0
    SV-->>W: SSE session.exited
    W->>DB: runs.status=NeedsInputIdle, checkpoint_at=now

    Note over U,DB: Hours later — user comes back.
    U->>W: POST /api/runs/[id]/hitl-response { ... }
    W->>FS: atomicWriteJson input-{stepId}.json
    W->>SV: POST /sessions (with resumeSessionId=acp_session_id)
    SV->>A: spawn --resume {id}
    A->>FS: read input-{stepId}.json
    A-->>SV: session.update (resumed)
    SV-->>W: SSE session.line
    W->>DB: runs.status=Running, keepalive_until=null
```

### Crash recovery (Designed M6/M8)

```mermaid
flowchart TD
    Start([startup or heartbeat tick]) --> Find[Find runs status=Running]
    Find --> Live{supervisor has live session?}
    Live -- yes --> OK[no action]
    Live -- no --> Cp{acp_session_id present?}
    Cp -- no --> Crash1[status=Crashed,no recovery path]
    Cp -- yes --> Crash2[status=Crashed, UI surfaces Recover or Discard]
    Crash2 --> User{user choice}
    User -- Recover --> Resume[POST /sessions resumeSessionId=acp_session_id]
    Resume --> Running[status=Running]
    User -- Discard --> Drop[remove worktree, status=Abandoned]
```

## Edge cases

- **`PRECONDITION`** — dirty repo, branch taken, worktree path
  occupied, cap hit (mapped to `Pending` instead in this last case),
  executor unregistered.
- **`SPAWN`** — adapter binary missing on PATH (`ENOENT`),
  permission denied, OOM at fork.
- **`NEEDS_INPUT`** — soft signal raised in the bridge layer; UI
  renders the HITL form. Not a hard error.
- **`HITL_TIMEOUT`** — 24h elapsed in `NeedsInputIdle`.
- **`CRASH`** — heartbeat detected dead PID (`ESRCH` on
  `process.kill(pid, 0)`), or child emitted non-zero exit + signal
  without intentional shutdown.
- **`CONFLICT`** — `git merge --no-ff` could not auto-merge. Run stays
  `Review`.
- **`CHECKPOINT`** — graceful checkpoint failed (M8 will define).
  Worker stays live; UI surfaces "couldn't checkpoint — keep tab open"
  warning.
- **`ACP_PROTOCOL`** — supervisor received a JSONL line it cannot
  decode, or saw an unexpected ACP transition. Surfaces the raw
  payload to the UI.
- **Recover when `acp_session_id` is null** — UI hides Recover button;
  Discard is the only option.
- **Abandon a `Running` run** — supervisor `DELETE /sessions/<id>` (sends
  SIGTERM → grace → SIGKILL), then transitions run to `Abandoned`,
  removes worktree on GC.

## Linked artifacts

- ADRs: [ADR-006 Hybrid HITL](../decisions.md#adr-006-hybrid-hitl-keep-alive--checkpointresume),
  [ADR-011 Workspace lifecycle](../decisions.md#adr-011-workspace-lifecycle-via-git-worktree),
  [ADR-018 Task ↔ Run 1:N](../decisions.md#adr-018-task--run-cardinality-is-1n).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md).
- API: [`../api/supervisor.openapi.yaml`](../api/supervisor.openapi.yaml),
  [`../api/async/supervisor-sse.asyncapi.yaml`](../api/async/supervisor-sse.asyncapi.yaml).
- Related: [`hitl.md`](hitl.md), [`workspaces.md`](workspaces.md),
  [`tasks.md`](tasks.md).
- Source: `web/lib/db/schema.ts` (runs table),
  `supervisor/src/heartbeat.ts`, `supervisor/src/spawn.ts`.
