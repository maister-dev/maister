# Execution hosts domain

> **Status: Implemented** (Stage A). Decision:
> [ADR-166](../decisions.md#adr-166-local-execution-host-contract--durable-host-identity-epoch-fenced-assignments-command-ledger-opaque-adopted-workspaces).
> Working plan:
> [`../../.ai-factory/plans/claude-stage-a-execution-host-plan-6d70f9.md`](../../.ai-factory/plans/claude-stage-a-execution-host-plan-6d70f9.md).
> As-built: every surface in this file is `Implemented` (Stage A shipped in
> full; the `Designed` tags flipped at the branch's as-built checkpoint).

## Purpose

This domain owns how Web Core **addresses execution**: the durable identity of
the local **execution host** (the supervisor daemon), the durable per-run
**execution assignment** whose monotonically increasing **epoch** names the
driver-ownership generation, the **command envelope** and **command ledger**
that carry every host-bound command with a unique id and a fence, the host-side
**receipts** that make duplicate delivery safe, and the opaque
**execution workspace** handle that replaces raw paths on every session route.
It answers: who is allowed to drive a run right now, how a stale driver is
rejected at the execution boundary, what survives a web crash or a supervisor
restart, and how a pre-Stage-A run is folded in. It does **not** own the run
state machine ([runs.md](runs.md)), HITL semantics ([hitl.md](hitl.md)),
crash classification ([reconciliation-gc.md](reconciliation-gc.md)),
worktree creation and promotion ([workspaces.md](workspaces.md)), or the
runner/session model ([sessions.md](sessions.md)). Stage A keeps one host,
loopback HTTP, and the shared filesystem: no remote transport, no multiple
simultaneous hosts, no placement, no host UI (ADR-166 §D12).

## Domain entities

- **Execution host** — one row in `execution_hosts` per registered host.
  Stage A has exactly one non-retired `kind='local_direct'` row (partial
  unique index `execution_hosts_local_active_uq`). Identity is `host_key`
  (`eh_<uuid>`, supervisor-minted, or the `MAISTER_EXECUTION_HOST_KEY` pin);
  `last_boot_id` marks the supervisor process incarnation; `readiness ∈
{unknown, ready, unavailable}` + `readiness_reason`; `capabilities =
{protocolVersion, supervisorVersion, adapters[]}`. The supervisor URL is
  transport configuration (`MAISTER_SUPERVISOR_URL`) read at call time by the
  local-direct transport — never stored on the row.
- **Host state store** — the supervisor-private `node:sqlite` file
  `<MAISTER_EXECUTION_HOST_STATE_DIR>/state.sqlite` (default
  `<MAISTER_RUNTIME_ROOT>/.maister/execution-host/`) holding
  `host_identity`, `run_fences`, `workspaces`, and `command_receipts`. The
  web tier never reads it.
- **Execution assignment** — one row in `execution_assignments` per
  `(run, epoch)`: `state ∈ {active, superseded, released}`,
  `placement_reason` (ten tokens), the optional `execution_workspace_id` +
  `workspace_adopted_at` handle, `superseded_by_id`, `released_reason`,
  `ended_at`. `runs.execution_assignment_id` points at the active one;
  `run_sessions.execution_assignment_id` (updated per spawn) and
  `node_attempts.execution_assignment_id` (stamped at attempt start,
  immutable) attribute sessions and attempts. ERD:
  [`../db/execution-hosts-domain.md`](../db/execution-hosts-domain.md).
- **Epoch** — `execution_assignments.epoch ≥ 1`, strictly increasing per
  run, minted in the same transaction as the placement CAS. It is the
  driver-ownership generation: session switches inside one `runFlow`,
  gate chat on a live session, and prompt turns reuse the current epoch.
- **Fence** — `{hostKey, assignmentId, assignmentEpoch, runId}` on every
  enveloped command. The host keeps the per-run high-water in
  `run_fences(run_id, assignment_id, epoch)` and rejects `epoch <
high-water` with 409 `FENCED`.
- **Command** — one row in `execution_commands` (the wire `command.id`):
  `kind` (eight tokens), `assignment_epoch`, `target_session_id?`, a
  REDACTED `payload`, `state ∈ {queued, delivering, accepted, succeeded,
failed, fenced}`, `attempts` / `max_attempts` / `next_attempt_at`,
  `delivering_since`, `accepted_at`, `completed_at`, `result`, `last_error`,
  `driverless`.
- **Command envelope** — `{ command: {id, kind, issuedAt}, fence: {…},
payload: {…} }`, the JSON body of every host-bound mutating route; the
  session id stays in the URL. Wire schema: `CommandEnvelope` in
  [`../api/supervisor.openapi.yaml`](../api/supervisor.openapi.yaml).
- **Receipt** — a host-side `command_receipts` row `(command_id, run_id,
kind, epoch, phase ∈ {accepted, completed, rejected}, http_status,
body_json, received_at, completed_at)`; readable through
  `GET /commands/{commandId}` (which adds the process-memory `inflight`
  flag — `accepted` + `inflight:false` is the restart-mid-turn signature the
  web folds as `turn_lost` without re-sending) and replayed verbatim on a
  duplicate id with `X-Maister-Command-Replayed: true`.
- **Execution workspace handle** — `executionWorkspaceId = "ws_<uuid>"`,
  host-scoped, keyed `(runId, realpath)` in the host's `workspaces` table
  with `kind ∈ {git_worktree, repo_checkout, directory}`, `path`,
  `repo_path?`, `run_dir`, `context_mounts?`, `adopted_at`, `released_at?`.
  Minted by `POST /workspaces/adopt` — the ONLY path-bearing route.
- **Bound client** — the web-side `BoundClient` returned by
  `executionHosts.forAssignment(assignment)`: every method is a thin wrapper
  over one `issue()` that writes the ledger row, delivers through the
  `ExecutionHostTransport`, and acknowledges. `HostAdminClient`
  (`executionHosts.local()`) serves health/diagnostics/admin surfaces.

## State machine — host registration

The registrar (`ensureLocalExecutionHost()` at web startup, then lazily with
a 30 s memo) reads `GET /health` and applies this policy under a
`SELECT … FOR UPDATE` of the single non-retired local row. Transitions carry
the log marker they emit.

```mermaid
stateDiagram-v2
    [*] --> none
    none --> registered : health OK, no active local row — insert (execution-host-registered)
    registered --> registered : same key — touch last_seen_at, last_boot_id, capabilities, readiness=ready — bootId changed emits execution-host-restarted + one reconcile sweep
    registered --> retired : different key AND old row owns zero active assignments of non-terminal runs (execution-host-retired-idle)
    retired --> registered : new row inserted for the new key
    registered --> refused : different key AND old row still owns non-terminal runs — rows unchanged, readiness=unavailable, readiness_reason=identity_changed
    refused --> registered : the old key is pinned on the new supervisor, or the listed runs are stopped or abandoned
    registered --> unavailable : health unreachable or malformed — readiness=unavailable at most once per 30 s
    unavailable --> registered : health OK again with the same key
```

While `refused` or `unavailable`, every command issue fails
`EXECUTOR_UNAVAILABLE` (`details.reason="host_identity_mismatch"` for the
refused case); launches keep today's 503 behavior.

## State machine — execution assignment

```mermaid
stateDiagram-v2
    [*] --> active : mintAssignment in the placement CAS tx (epoch = max+1, runs.execution_assignment_id set)
    active --> superseded : a later mint for the same run (superseded_by_id, ended_at)
    active --> released : releaseAssignmentForRun (released_reason, ended_at) — advisory
    superseded --> [*]
    released --> [*]
```

`released` is advisory for fencing (the next mint supersedes anything); the
`system_sweep` backstop releases an `active` assignment whose run is parked
or terminal (`released_reason='sweep'`, WARN once).

## State machine — command

The `execution_commands.state` FSM. Every transition is a CAS
(`UPDATE … WHERE id=$1 AND state IN (<expected>) AND attempts=$attempt`); a
late signal for a terminal row logs `command-late-signal` and is ignored.

```mermaid
stateDiagram-v2
    [*] --> queued : issue() — row committed BEFORE any wire call
    queued --> delivering : claim (attempts+1, delivering_since)
    delivering --> succeeded : 2xx on an immediate kind
    delivering --> accepted : prompt — SSE session.command accepted OR receipt phase accepted
    delivering --> queued : unknown-outcome failure while attempts below max (next_attempt_at backoff)
    delivering --> failed : definitive error OR attempts exhausted
    delivering --> fenced : 409 FENCED
    accepted --> succeeded : HTTP 200 OR SSE session.command completed OR receipt completed
    accepted --> failed : completion error, receipt turn_lost, or receipt 404
    queued --> fenced : assignment not admissible at delivery time (no wire call)
    queued --> failed : startup recovery of a non-driverless kind (ORPHANED)
    succeeded --> [*]
    failed --> [*]
    fenced --> [*]
```

## Process flows

### Bootstrap and registration

The supervisor opens its state store before registering routes; the web tier
registers the host it finds at `MAISTER_SUPERVISOR_URL` before any recovery
sweep runs.

```mermaid
sequenceDiagram
    autonumber
    participant SUP as Supervisor (main.ts)
    participant ST as Host state store (sqlite)
    participant WEB as Web instrumentation.ts
    participant PG as Postgres
    SUP->>ST: openHostState(stateDir, pin?)
    alt no stored key
        ST-->>SUP: mint eh_<uuid> (or store the pin)
    else stored key == pin or no pin
        ST-->>SUP: stored key
    else stored key != pin
        ST-->>SUP: HostKeyConflictError
        SUP->>SUP: fatal execution-host-key-conflict, exit 1
    end
    SUP->>SUP: bootId = randomUUID() — registerRoutes() — listen
    WEB->>WEB: migrations check
    WEB->>SUP: GET /health
    SUP-->>WEB: 200 {…, host:{hostKey, bootId, protocolVersion}}
    WEB->>PG: SELECT … FOR UPDATE active local_direct row
    WEB->>PG: apply registration policy (insert / touch / retire+insert / refuse)
    WEB->>WEB: recoverExecutionCommands()
    WEB->>WEB: adoptLegacyActiveRuns()
    WEB->>WEB: runResumeRecoverySweep → runTakeoverReturnRecoverySweep → runReconcileSweep
```

### Launch → lazy adoption → create → prompt → completion signals

The first supervisor call for a flow run happens inside `runAgentStep`. The
assignment is minted in the run-INSERT transaction of `launchRun`; the
workspace is adopted lazily before the first `session.create` of that
assignment.

```mermaid
sequenceDiagram
    autonumber
    participant DRV as Driver (runner-agent)
    participant LED as Ledger (execution_commands)
    participant TR as Local-direct transport
    participant SUP as Supervisor
    participant AD as Adapter
    DRV->>LED: launch tx: runs + run_sessions + mintAssignment(epoch 1, launch)
    DRV->>LED: issue workspace.adopt (queued)
    LED->>TR: deliver (delivering)
    TR->>SUP: POST /workspaces/adopt {envelope, payload:{runId, projectSlug, kind, path, repoPath?}}
    SUP->>SUP: fence check → validate path per kind → upsert (runId, realpath)
    SUP-->>TR: 200 {executionWorkspaceId, kind, replayed:false}
    TR-->>LED: ack tx: succeeded + assignment.execution_workspace_id
    DRV->>LED: issue session.create (queued)
    LED->>TR: deliver
    TR->>SUP: POST /sessions {envelope, payload:{executionWorkspaceId, stepId, executor, …}}
    SUP->>SUP: fence → receipt lookup → resolveForSession(handle) → spawn
    SUP->>AD: child_process.spawn + ACP initialize / session-new
    AD-->>SUP: acpSessionId
    SUP-->>TR: 201 {sessionId, pid, acpSessionId}
    TR-->>LED: ack tx: succeeded + run_sessions.host_session_id/acp_session_id/execution_assignment_id + node_attempts.execution_assignment_id
    DRV->>LED: issue session.prompt (queued)
    LED->>TR: deliver
    TR->>SUP: POST /sessions/{id}/prompt {envelope, payload}
    SUP-->>TR: SSE session.command {phase:accepted}
    TR-->>LED: accepted_at
    SUP->>AD: session/prompt
    AD-->>SUP: stopReason
    SUP->>SUP: write receipt (completed)
    SUP-->>TR: SSE session.command {phase:completed, status:succeeded, result:{stopReason}}
    SUP-->>TR: HTTP 200 {stopReason}
    TR-->>LED: first durable signal wins → succeeded — the late fold is a no-op (command-late-signal)
    LED-->>DRV: PromptHandle.completion resolves {stopReason}
```

### HITL respond through the ledger (Phase 1 / Phase 2)

The permission-response route keeps its two-phase shape; the supervisor side
effect is a `session.input` command whose row is written in the Phase-1
transaction.

```mermaid
sequenceDiagram
    autonumber
    participant UI as Operator
    participant RT as POST /api/runs/{runId}/hitl/{id}/respond
    participant PG as Postgres
    participant TR as Bound client
    participant SUP as Supervisor
    UI->>RT: {optionId}
    RT->>PG: Phase 1 tx: SELECT hitl_requests FOR UPDATE, guard status, store response, INSERT execution_commands(session.input, queued)
    RT->>TR: deliver session.input {action:select, requestId, optionId}
    TR->>SUP: POST /sessions/{id}/input {envelope, payload}
    alt 200
        SUP-->>TR: {ok:true}
        TR->>PG: Phase 2 tx: hitl_requests.responded_at + command succeeded (+ _audit.deliveredOptionId when a replay result differs)
        RT-->>UI: 200
    else 503 / network (unknown outcome)
        TR->>TR: retry the same command id up to budget
        TR->>PG: failed — responded_at stays NULL
        RT-->>UI: 503 — the user's retry issues a NEW command
    else 404 / 410
        TR->>PG: failed (terminal) — the existing terminal mapping applies
        RT-->>UI: 410
    end
    Note over RT,SUP: every persist-failure path still cancels — now as a session.input{action:cancel} command (no hidden deferred)
```

### Keepalive checkpoint → idle → resume mint → stale checkpoint FENCED → old driver yields

The end-to-end fencing scenario: a driver whose assignment was superseded is
rejected at the host and writes nothing.

```mermaid
sequenceDiagram
    autonumber
    participant SW as Keepalive sweeper (epoch 1 driver)
    participant RS as Resume path (epoch 2 driver)
    participant LED as Ledger
    participant SUP as Supervisor
    SW->>LED: issue session.checkpoint under assignment A1 (epoch 1)
    LED->>SUP: POST /sessions/{s1}/checkpoint {fence:{A1, epoch 1}}
    SUP-->>LED: 200 {alreadyCheckpointed:false} — SSE session.exited {reason:checkpoint}
    SW->>LED: markCheckpointed → NeedsInputIdle — releaseAssignmentForRun(A1, 'checkpoint')
    RS->>LED: respond → resumeRun claim tx: mintAssignment(A2, epoch 2, resume) — handle copied forward
    RS->>LED: issue session.create {resumeSessionId} under A2 (adopt skipped — handle present)
    LED->>SUP: POST /sessions {fence:{A2, epoch 2}}
    SUP->>SUP: run_fences[run] = (A2, 2)
    SUP-->>LED: 201
    SW->>LED: a STALE retry: session.checkpoint under A1 (epoch 1)
    LED->>LED: admission: A1 is superseded → local fenced, no wire call
    Note over SW,SUP: if the stale command had reached the wire, epoch 1 below high-water 2 → 409 FENCED {reason:assignment_fenced, commandEpoch:1, hostEpoch:2}
    LED-->>SW: CONFLICT {details.reason:assignment_fenced}
    SW->>SW: driver-yielded — no run, attempt, HITL, or scratch write
```

### Web crash windows W1 / W2 / W4 and their recovery

`recoverExecutionCommands()` runs at startup and on every `system_sweep`
pass.

```mermaid
sequenceDiagram
    autonumber
    participant REC as recoverExecutionCommands()
    participant LED as Ledger
    participant SUP as Supervisor
    REC->>LED: loadOpenCommands() (queued | delivering | accepted)
    loop each queued row (W1: crashed after queued, before send)
        alt driverless (session.delete, workspace.release)
            REC->>SUP: deliver through the deliverer (idempotent kill / release)
        else any other kind
            REC->>LED: failed {code:ORPHANED} — the existing reconcile handles the run
        end
    end
    loop each delivering row older than 60 s (W2: crashed after send, before ack)
        REC->>SUP: GET /commands/{id}
        alt receipt completed
            REC->>LED: one tx: succeeded + the result-derived domain writes (host_session_id, acp_session_id, handle)
        else 404
            REC->>LED: treat as W1
        end
    end
    loop each accepted row (W4: crashed mid-prompt)
        REC->>SUP: GET /commands/{id}
        alt receipt completed
            REC->>LED: succeeded {stopReason}
        else accepted with no in-flight turn
            REC->>LED: failed {turn_lost} — the run then follows the existing reconcile
        end
    end
```

A `delivering` row younger than 60 s is left alone (in-flight protection).
W3 (after ack, before the domain write) is impossible: the ack and the
domain writes share one transaction.

### Supervisor restart

```mermaid
sequenceDiagram
    autonumber
    participant SUP as Supervisor (new process)
    participant ST as Host state store
    participant WEB as Web registrar
    SUP->>ST: reload host_identity, run_fences, workspaces, command_receipts
    SUP->>SUP: new bootId — live sessions are gone (unchanged behavior)
    WEB->>SUP: GET /health (next resolver call, ≤ 30 s memo)
    SUP-->>WEB: same hostKey, new bootId
    WEB->>WEB: execution-host-restarted → runReconcileSweep() once
    Note over SUP,WEB: commands for dead sessions → 404 / 503 as today — a duplicate prompt id whose receipt is accepted with no in-flight promise → 409 PRECONDITION turn_lost
```

If the state directory itself is lost, the host mints a new key (unless
pinned) → the registration policy retires the idle old row or refuses;
fences restart at the first command; handles are re-adopted lazily
(`unknown_workspace` → one re-adopt).

### Legacy backfill

```mermaid
sequenceDiagram
    autonumber
    participant WEB as adoptLegacyActiveRuns()
    participant PG as Postgres
    participant SUP as Supervisor
    WEB->>PG: runs WHERE execution_assignment_id IS NULL AND status IN (Running, NeedsInput)
    alt no registered local host (registrar refused or unreachable)
        WEB->>WEB: skip — log once per boot — retry on the next sweep
    else
        WEB->>SUP: GET /sessions
        loop each candidate run
            alt a live session for the run exists
                WEB->>PG: mintAssignment(epoch 1, legacy_backfill)
            else
                WEB->>WEB: leave NULL — reconcile classifies (Crashed)
            end
        end
    end
    Note over WEB,PG: parked or queued statuses are untouched — their next placement mints. A command issuer meeting a NULL assignment calls ensureAssignment(runId, legacy_backfill) with WARN legacy-run-assigned-lazily — deleted in Stage C.
```

The backfilled row reuses the `assignmentId` the host stamped on the live
session (the `GET /sessions` projection carries the fence of the create that
spawned it) and copies its `executionWorkspaceId` forward, so later commands
for the run pass the host's own fence without a re-adopt; the run's
`run_sessions` row is linked to the new assignment. The backfill also runs on
every `executionCommandReconcilePass`, which is how a host that was
unreachable at boot is picked up later.

## Command kinds, routes, and completion signals

| Kind                 | Route                            | Effect                                                     | Duration     | Completion signal(s)                                                                                          |
| -------------------- | -------------------------------- | ---------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `workspace.adopt`    | `POST /workspaces/adopt`         | register path → handle (idempotent on `(runId, realpath)`) | immediate    | HTTP 200                                                                                                      |
| `workspace.release`  | `DELETE /workspaces/{id}`        | unregister handle                                          | immediate    | HTTP 200                                                                                                      |
| `session.create`     | `POST /sessions`                 | spawn + ACP handshake                                      | ≤ 60 s       | HTTP 201 `{sessionId, pid, acpSessionId}`                                                                     |
| `session.prompt`     | `POST /sessions/{id}/prompt`     | start a turn                                               | long         | SSE `session.command{accepted}` → HTTP 200 `{stopReason}` and/or SSE `session.command{completed}` and receipt |
| `session.input`      | `POST /sessions/{id}/input`      | resolve a deferred                                         | immediate    | HTTP 200                                                                                                      |
| `session.cancel`     | `POST /sessions/{id}/cancel`     | ACP cancel                                                 | immediate    | HTTP 200                                                                                                      |
| `session.checkpoint` | `POST /sessions/{id}/checkpoint` | cancel deferreds + SIGTERM + wait                          | ≤ kill grace | HTTP 200 + SSE `session.exited{reason:"checkpoint"}`                                                          |
| `session.delete`     | `DELETE /sessions/{id}`          | SIGTERM/SIGKILL                                            | ≤ kill grace | HTTP 204 + SSE `session.exited`                                                                               |

Unknown-outcome retry budgets (same command id): adopt 3 (0.5 s·2ⁿ), create 3
(1 s·2ⁿ), prompt 3 before acceptance / 0 after, input 3, cancel 3, checkpoint
3, delete 3 (`driverless`), release 3 (`driverless`). Transport timeouts: adopt
10 s, create 60 s, input/cancel 10 s, checkpoint/delete 30 s, prompt none.

## Command admission by assignment state

| Assignment state | Admitted kinds                                                                                                                 | Otherwise                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `active`         | all eight                                                                                                                      | —                            |
| `released`       | teardown only: `session.checkpoint`, `session.delete`, `session.cancel`, `session.input{action:"cancel"}`, `workspace.release` | local `fenced`, no wire call |
| `superseded`     | none                                                                                                                           | local `fenced`, no wire call |

`session.create`, `session.prompt`, `session.input{select}`, and
`workspace.adopt` require `active`. The orchestrator park checkpoint is the
reason teardown kinds stay admissible under `released`.

## Host refusal table (reason tokens)

`SupervisorErrorBody.details.reason` is the discriminator; tests assert the
token, never the message.

| Rule (in order)                                                          | HTTP / code        | `details.reason`                                                                                                                                                                                | Web sees                                                        |
| ------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `fence.hostKey ≠` own key                                                | 409 `PRECONDITION` | `host_mismatch`                                                                                                                                                                                 | `PRECONDITION` (details passed through)                         |
| `fence.assignmentEpoch <` stored high-water                              | 409 `FENCED`       | `assignment_fenced` (+ `runId`, `commandEpoch`, `hostEpoch`)                                                                                                                                    | `CONFLICT {details.reason:"assignment_fenced"}` → driver yields |
| epoch equal, `assignmentId` differs                                      | 409 `PRECONDITION` | `assignment_mismatch`                                                                                                                                                                           | `PRECONDITION`                                                  |
| `fence.runId ≠` the session's / handle's run                             | 409 `PRECONDITION` | `run_mismatch`                                                                                                                                                                                  | `PRECONDITION`                                                  |
| duplicate id, receipt `accepted`, no in-flight (host restarted mid-turn) | 409 `PRECONDITION` | `turn_lost`                                                                                                                                                                                     | `failed{turn_lost}`                                             |
| `executionWorkspaceId` unknown                                           | 409 `PRECONDITION` | `unknown_workspace`                                                                                                                                                                             | client re-adopts ONCE, issues a NEW create                      |
| handle released                                                          | 409 `PRECONDITION` | `workspace_released`                                                                                                                                                                            | `PRECONDITION`                                                  |
| adopt path violates the kind matrix                                      | 409 `PRECONDITION` | `workspace_rejected` + `rule ∈ {relative_path, parent_segment, not_found, outside_roots, symlink_escape, gitdir_mismatch, not_a_repo, repo_path_mismatch, inside_state_dir, outside_workspace}` | `PRECONDITION`                                                  |
| legacy path field after the strict flip                                  | 409 `PRECONDITION` | `legacy_field`                                                                                                                                                                                  | `PRECONDITION`                                                  |
| envelope absent after the strict flip                                    | 409 `PRECONDITION` | `missing_envelope`                                                                                                                                                                              | `PRECONDITION`                                                  |
| receipt write failed after executing                                     | 500 `ACP_PROTOCOL` | —                                                                                                                                                                                               | definitive failure; reconcile catches an orphan session         |

Web-minted: `EXECUTOR_UNAVAILABLE {details.reason:"host_identity_mismatch"}`
while registration is refused. `FENCED → CONFLICT`; every other supervisor
code keeps its existing mapping ([`../error-taxonomy.md`](../error-taxonomy.md)).

## Web-side classification per attempt

| Host response                                          | Class                                                                                                                                      | Ledger row         | Caller sees                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------- |
| network error, timeout, non-JSON 5xx (outcome UNKNOWN) | retry the SAME command id up to budget, then `failed`                                                                                      | `queued` + backoff | `EXECUTOR_UNAVAILABLE` after budget                     |
| parsed 503 `EXECUTOR_UNAVAILABLE` (definitive)         | `failed`; the caller's own retry issues a NEW command (sweeper tick, user retry)                                                           | `failed`           | `EXECUTOR_UNAVAILABLE`                                  |
| 409 `FENCED`                                           | terminal                                                                                                                                   | `fenced`           | `CONFLICT {details.reason:"assignment_fenced"}`         |
| 404 / 410 / 409 `PRECONDITION` (any reason)            | terminal                                                                                                                                   | `failed`           | existing per-endpoint mapping, `details` passed through |
| 409 `PRECONDITION unknown_workspace` on create         | terminal for this command                                                                                                                  | `failed`           | one re-adopt + a NEW create                             |
| prompt after `accepted`: transport failure             | ONE receipt lookup: `completed` → `succeeded{stopReason}`; `accepted` w/o in-flight → `failed{turn_lost}`; 404 → `failed{receipt_missing}` | as looked up       | `stopReason` when completed, else `ACP_PROTOCOL`        |

## Workspace adoption kinds

| Kind            | Extra rule                                                                                                                                       | Used by                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `git_worktree`  | realpath under `MAISTER_WORKSPACE_ROOTS`; `.git` FILE whose `gitdir:` resolves under `<repoPath>/.git/worktrees/`; `repoPath` is a git repo root | flow, scratch, agent `worktree`, shared-tree children                |
| `repo_checkout` | path is a git repo root AND equals `repoPath` (arbitrary location, ADR-023)                                                                      | agent `repo_read` on the parent checkout                             |
| `directory`     | realpath under `MAISTER_WORKSPACE_ROOTS`; `repoPath` absent                                                                                      | local-package assistant, ephemeral read-only checkouts, agent `none` |

All kinds: absolute, no `..`, realpath exists, no symlink escape, not inside
the state dir. The web derives every adopt value from server state
(`workspaces.worktree_path`, `projects.repo_path`,
`local_packages.working_dir`, the agent launch snapshot, `runs.context_mounts`)
— never from an HTTP request body it received. The host derives `run_dir`
from `runtimeRoot + projectSlug + runId` at adoption and stores it; later
routes derive every path from the handle.

## Requirements (owner brief, 2026-09-02)

| Id   | Requirement                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | The local execution host has a stable identity that survives supervisor restarts.                                                                                       |
| R-02 | Web Core resolves the host through a durable registration; the transport URL is configuration, not a domain concept.                                                    |
| R-03 | Every newly launched run has a durable assignment with a monotonically increasing epoch.                                                                                |
| R-04 | Assignment history is immutable and auditable; sessions and attempts are attributable to the assignment that created them.                                              |
| R-05 | Every host-bound command carries `hostKey`, `assignmentId`, `assignmentEpoch`, and a unique `commandId`.                                                                |
| R-06 | The host rejects stale epochs; fencing survives host restart.                                                                                                           |
| R-07 | Duplicate delivery of any command is safe (host receipts).                                                                                                              |
| R-08 | Command intent is persisted before the side effect; delivery state only after acknowledgement.                                                                          |
| R-09 | Every Web crash window has a defined, tested recovery.                                                                                                                  |
| R-10 | A long-lived HTTP request is never the only durable completion signal.                                                                                                  |
| R-11 | Normal session APIs carry no raw paths; adoption is the only path-bearing operation and validates against configured roots.                                             |
| R-12 | Flow runs, scratch/assistant runs, ACP lifecycle, HITL, checkpoint/resume, cancel/abandon, reconcile, concurrency accounting, local delivery/promotion behave as today. |
| R-13 | Shared filesystem and local event coupling are documented as limitations; no remote/multi-host claims.                                                                  |
| R-14 | Domain code addresses hosts only through a typed boundary; the loopback transport is replaceable.                                                                       |

## Expectations

- **E-EH-01** — At most one non-retired `local_direct` execution host MUST
  exist. Enforced by: `execution_hosts_local_active_uq` partial unique index;
  the registrar policy under a `SELECT … FOR UPDATE` of the active row.
- **E-EH-02** — A run MUST have at most one `active` assignment and its
  epochs MUST be strictly increasing; a mint NEVER reuses an epoch. Enforced
  by: `execution_assignments_run_active_uq`,
  `execution_assignments_run_epoch_uq`, and `mintAssignment` inside the
  placement-claim transaction.
- **E-EH-03** — Every enveloped command MUST carry a fence; the host MUST
  persist the per-run high-water BEFORE executing and MUST reject
  `epoch < high-water` with 409 `FENCED`. Enforced by: the `withCommand`
  route wrapper; the `run_fences` sqlite write; tests F1–F2, F7.
- **E-EH-04** — When a higher epoch arrives, every live session of that run
  under a lower epoch MUST be evicted (`session.exited{reason:"fenced"}`)
  before the command executes. Enforced by: `execution-fence.ts` eviction;
  test F6.
- **E-EH-05** — A command id MUST execute at most once per host: a duplicate
  returns the stored receipt or joins the in-flight execution. Enforced by:
  `command_receipts` primary key + the in-flight map; tests R1–R3.
- **E-EH-06** — An `execution_commands` row MUST exist in state `queued`
  before any wire call, and `accepted_at` / `completed_at` MUST be written
  only after the host's response. Enforced by: the ledger API is the only
  transport caller; test L1.
- **E-EH-07** — Result-derived domain writes (`run_sessions.host_session_id`,
  `acp_session_id`, `execution_assignment_id`; the assignment handle) MUST
  commit in the same transaction as the acknowledgement. Enforced by: the
  ledger ack takes a transaction; test L2.
- **E-EH-08** — `POST /sessions` and every `/sessions/{id}/*` route MUST
  accept only `executionWorkspaceId`; `POST /workspaces/adopt` is the only
  route accepting a path and MUST validate it per the kind matrix. Enforced
  by: Zod strict schemas; tests W5, Z1–Z3, T1. (Strict since the T5.1 flip;
  the transitional bare-body acceptance is gone.)
- **E-EH-09** — Adoption MUST be idempotent on `(runId, realpath)` and
  handles MUST survive a host restart. Enforced by: the sqlite `workspaces`
  table; tests W1, W9.
- **E-EH-10** — After a Web restart, `delivering` / `accepted` rows MUST be
  reconciled from receipts and non-driverless `queued` rows MUST NEVER be
  re-sent. Enforced by: `recovery.ts`; tests V1–V3.
- **E-EH-11** — A driver whose command returns `assignment_fenced` MUST write
  no run, attempt, HITL, or scratch state. Enforced by: the `fenced:true`
  result + early returns in every driver; test P3.
- **E-EH-12** — No secret value or prompt body MUST be persisted in
  `execution_commands.payload`, receipt bodies, or logs. Enforced by:
  `redact()` at ledger insert; sentinel tests C1, H7.

## Edge cases

| Id      | Case                                                                                                                                         | Outcome / code                                                                                                                      | Owning test |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| X-EH-01 | Pinned key conflicts with the stored key                                                                                                     | supervisor refuses boot, exit 1, `execution-host-key-conflict`                                                                      | H5          |
| X-EH-02 | New identity at the configured URL while the old host owns non-terminal runs                                                                 | registration refused, `readiness='unavailable'`, `MaisterError("EXECUTOR_UNAVAILABLE")` `{details.reason:"host_identity_mismatch"}` | G4          |
| X-EH-03 | Host state dir lost                                                                                                                          | new key (unless pinned) → idle-retire or X-EH-02; fences restart at the first command; handles re-adopted lazily                    | G3, K5      |
| X-EH-04 | Command epoch below the host high-water                                                                                                      | 409 `FENCED` → `MaisterError("CONFLICT")` `{details.reason:"assignment_fenced"}`                                                    | F2, E1      |
| X-EH-05 | Same epoch, different assignment id                                                                                                          | 409 `PRECONDITION assignment_mismatch`                                                                                              | F3          |
| X-EH-06 | `fence.runId` differs from the session's run                                                                                                 | 409 `PRECONDITION run_mismatch`                                                                                                     | F5          |
| X-EH-07 | Duplicate command with a completed/rejected receipt                                                                                          | verbatim replay + `X-Maister-Command-Replayed`                                                                                      | R1          |
| X-EH-08 | Duplicate command while the original is executing                                                                                            | join, same result                                                                                                                   | R2          |
| X-EH-09 | Receipt `accepted`, no in-flight (host restarted mid-turn)                                                                                   | 409 `PRECONDITION turn_lost`                                                                                                        | R3          |
| X-EH-10 | Adopt path outside roots / relative / `..` / missing / symlink escape / gitdir mismatch / not a repo / repo path mismatch / inside state dir | 409 `PRECONDITION {workspace_rejected, rule}` → `MaisterError("PRECONDITION")`                                                      | W5          |
| X-EH-11 | Create with an unknown handle                                                                                                                | 409 `unknown_workspace` → client re-adopts once                                                                                     | W6, K5      |
| X-EH-12 | Create with a released handle                                                                                                                | 409 `workspace_released`                                                                                                            | W6          |
| X-EH-13 | Legacy path field or missing envelope after the strict flip                                                                                  | 409 `legacy_field` / `missing_envelope`                                                                                             | Z1–Z2       |
| X-EH-14 | Transport failure with unknown outcome before any receipt                                                                                    | retry the same command id up to budget, then `failed` → `MaisterError("EXECUTOR_UNAVAILABLE")`                                      | L3          |
| X-EH-15 | Transport failure after prompt acceptance                                                                                                    | one receipt lookup → `succeeded{stopReason}` / `failed{turn_lost}` / `failed{receipt_missing}` (`MaisterError("ACP_PROTOCOL")`)     | L8          |
| X-EH-16 | Web crash W1 / W2 / W4                                                                                                                       | per the recovery flow above                                                                                                         | V1–V3       |
| X-EH-17 | Supervisor restart during delivery                                                                                                           | same key, new bootId, fences + receipts survive, sessions gone, reconcile classifies                                                | V3, G2      |
| X-EH-18 | Legacy run (NULL assignment) reaches a command issuer                                                                                        | lazy mint `legacy_backfill` with WARN `legacy-run-assigned-lazily`                                                                  | Y5          |
| X-EH-19 | Evicted session's pending prompt                                                                                                             | 409 `FENCED` to the old driver → driver yields                                                                                      | F6, P3      |
| X-EH-20 | Teardown command on a `released` assignment / any command on `superseded`                                                                    | sent / locally `fenced`                                                                                                             | A5, L6      |
| X-EH-21 | Host receipt write fails after executing                                                                                                     | 500 `ACP_PROTOCOL`; the effect may exist; reconcile catches an orphan session (accepted residual)                                   | R5          |
| X-EH-22 | Host unreachable at Web boot                                                                                                                 | readiness unavailable, backfill skipped once-logged, sweeps retry (accepted residual)                                               | G5, Y4      |

## Linked artifacts

- Decision: [ADR-166](../decisions.md#adr-166-local-execution-host-contract--durable-host-identity-epoch-fenced-assignments-command-ledger-opaque-adopted-workspaces);
  amended topology: [ADR-023](../decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres).
- ERD: [`../db/execution-hosts-domain.md`](../db/execution-hosts-domain.md);
  column reference: [`../database-schema.md`](../database-schema.md#execution-host-tables-implemented--adr-166-migration-0130).
- Wire: [`../api/supervisor.openapi.yaml`](../api/supervisor.openapi.yaml)
  (`CommandEnvelope`, `AdoptWorkspaceRequest`, `WorkspaceRecord`,
  `CommandReceipt`, `SupervisorErrorBody.details`, `FENCED`),
  [`../api/async/supervisor-sse.asyncapi.yaml`](../api/async/supervisor-sse.asyncapi.yaml)
  (`session.command`, `session.exited.reason=fenced`),
  [`../api/async/web-runs.asyncapi.yaml`](../api/async/web-runs.asyncapi.yaml)
  (opaque pass-through); prose: [`../supervisor.md`](../supervisor.md).
- Errors: [`../error-taxonomy.md`](../error-taxonomy.md) (no new
  `MaisterError` code; `FENCED` + reason tokens).
- Configuration: [`../configuration.md`](../configuration.md)
  (`MAISTER_EXECUTION_HOST_STATE_DIR`, `MAISTER_EXECUTION_HOST_KEY`,
  `MAISTER_WORKSPACE_ROOTS`); deployment: [`../deployment.md`](../deployment.md).
- Related domains: [`runs.md`](runs.md), [`sessions.md`](sessions.md),
  [`hitl.md`](hitl.md), [`reconciliation-gc.md`](reconciliation-gc.md),
  [`scratch-runs.md`](scratch-runs.md), [`agents.md`](agents.md),
  [`workspaces.md`](workspaces.md).
- Source (Implemented): `web/lib/execution-host/*`,
  `web/lib/supervisor-client.ts`, `supervisor/src/{host-state,
execution-fence, command-receipts, workspace-registry, workspace-roots}.ts`,
  `supervisor/src/http-api.ts`, `supervisor/src/types.ts`.
