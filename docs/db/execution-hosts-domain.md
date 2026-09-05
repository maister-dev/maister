# Execution-host domain ERD

Tables for the local execution-host contract introduced by
[ADR-166](../decisions.md#adr-166-local-execution-host-contract--durable-host-identity-epoch-fenced-assignments-command-ledger-opaque-adopted-workspaces).
Behavior lives in
[`../system-analytics/execution-hosts.md`](../system-analytics/execution-hosts.md);
the narrative column reference is
[`../database-schema.md#execution-host-tables`](../database-schema.md#execution-host-tables-implemented--adr-166-migration-0130).

> **Status: Implemented schema foundations; Designed A/B stabilization corrections.** Migration `0130_execution_hosts` (single, additive,
> never data-dependent) adds the three tables, the four attribution columns,
> and the indexes below. Historical rows keep `execution_assignment_id = NULL`
> forever — the documented meaning is "pre-Stage-A, never placed".

Migration `0131_foamy_venom` adds canonical manager-owned protocol facts;
`0132_soft_loa` adds owner/event CHECK constraints. Historical mode is removed
by guarded `0135`/`0136`, not by these additive migrations: `execution_event_streams`, `execution_events`,
`execution_event_consumers`, `run_session_incarnations`,
`execution_data_plane_imports`, and `execution_event_ingest_failures`. The
canonical event payload is redacted metadata, never local content or a path;
the host keeps runtime bytes and SQLite outbox files private. See
[`execution-event-plane.md`](../system-analytics/execution-event-plane.md) and
[`execution-data-cutover.md`](../system-analytics/execution-data-cutover.md).

Migration `0137_execution_projection_workers` adds indexed service ordering
on `execution_event_consumers.last_served_at` and the independent
`execution_projection_backfills` keyset cursor. The bootstrap cursor has no
run FK: deleting its last examined run must not restart the scan. Consumer
leases, domain application and retry/rearm behavior are defined in the
[event-plane worker contract](../system-analytics/execution-event-plane.md#durable-bounded-projection-and-reconciliation-workers).

```mermaid
erDiagram
    EXECUTION_HOSTS ||--o{ EXECUTION_ASSIGNMENTS : "placed on (RESTRICT)"
    EXECUTION_HOSTS ||--o{ EXECUTION_COMMANDS : "addressed to (RESTRICT)"
    RUNS ||--o{ EXECUTION_ASSIGNMENTS : "one row per (run, epoch) (CASCADE)"
    RUNS ||--o{ EXECUTION_COMMANDS : "host-bound commands (CASCADE)"
    EXECUTION_ASSIGNMENTS ||--o{ EXECUTION_COMMANDS : "issued under (CASCADE)"
    EXECUTION_ASSIGNMENTS o|--o| EXECUTION_ASSIGNMENTS : "superseded_by_id (SET NULL)"
    EXECUTION_ASSIGNMENTS o|--o| RUNS : "runs.execution_assignment_id — the latest minted assignment (SET NULL)"
    EXECUTION_ASSIGNMENTS o|--o{ RUN_SESSIONS : "run_sessions.execution_assignment_id (SET NULL)"
    EXECUTION_ASSIGNMENTS o|--o{ NODE_ATTEMPTS : "node_attempts.execution_assignment_id (SET NULL)"

    EXECUTION_HOSTS {
        text id PK
        text host_key "UNIQUE; supervisor-minted eh_<uuid> or the MAISTER_EXECUTION_HOST_KEY pin"
        text kind "CHECK: local_direct"
        text display_name
        jsonb transport "{kind:'local_direct'} — the URL is env, never stored"
        jsonb capabilities "DEFAULT {}; {protocolVersion, supervisorVersion, adapters[]}"
        text readiness "DEFAULT unknown; CHECK: unknown|ready|unavailable"
        text readiness_reason "nullable; no_identity | identity_changed | network | timeout | http | malformed"
        text last_boot_id "nullable; supervisor per-process bootId"
        timestamptz last_seen_at "nullable"
        timestamptz registered_at "DEFAULT now()"
        timestamptz updated_at "DEFAULT now()"
        timestamptz retired_at "nullable; partial UNIQUE (kind) WHERE kind='local_direct' AND retired_at IS NULL"
    }

    EXECUTION_ASSIGNMENTS {
        text id PK
        text run_id FK "runs(id) CASCADE; UNIQUE(run_id, epoch); partial UNIQUE(run_id) WHERE state='active'"
        text execution_host_id FK "execution_hosts(id) RESTRICT"
        integer epoch "CHECK >= 1; strictly increasing per run"
        text state "CHECK: active|superseded|released"
        text placement_reason "CHECK: launch|resume|recover|wait_resume|rework_return|gate_chat|sync_resolver|scratch_recover|node_interrupt|legacy_backfill"
        text execution_workspace_id "nullable; host-scoped opaque ws_<uuid> handle"
        timestamptz workspace_adopted_at "nullable"
        timestamptz lease_expires_at "nullable; reserved for Stage C, always NULL in Stage A"
        text superseded_by_id FK "execution_assignments(id) SET NULL"
        text released_reason "nullable"
        timestamptz created_at "DEFAULT now()"
        timestamptz updated_at "DEFAULT now()"
        timestamptz ended_at "nullable; CHECK (state='active') = (ended_at IS NULL)"
    }

    EXECUTION_COMMANDS {
        text id PK "the command id carried on the wire (uuid)"
        text run_id FK "runs(id) CASCADE"
        text execution_assignment_id FK "execution_assignments(id) CASCADE"
        text execution_host_id FK "execution_hosts(id) RESTRICT"
        integer assignment_epoch "fence epoch snapshotted at issue"
        text kind "CHECK: workspace.adopt|workspace.release|session.create|session.prompt|session.input|session.cancel|session.checkpoint|session.delete"
        text target_session_id "nullable; host session id for session.* kinds"
        jsonb payload "DEFAULT {}; per-kind ALLOW-list projection — ids, names, adapter/model, counts, has* flags; nothing else stored"
        text state "DEFAULT queued; CHECK: queued|delivering|accepted|succeeded|failed|fenced"
        integer attempts "DEFAULT 0; CAS predicate on every transition"
        integer max_attempts "per-kind unknown-outcome retry budget"
        timestamptz next_attempt_at "nullable; backoff stamp while queued"
        timestamptz delivering_since "nullable; W2 age anchor (60 s)"
        timestamptz accepted_at "nullable; idempotency marker (prompt accepted)"
        timestamptz completed_at "nullable; CHECK (state IN terminal) = (completed_at IS NOT NULL)"
        jsonb result "nullable; e.g. {stopReason} / {sessionId, acpSessionId}"
        jsonb last_error "nullable; {code, reason?, message}"
        boolean driverless "DEFAULT false; recovery re-delivers only these"
        timestamptz created_at "DEFAULT now()"
        timestamptz updated_at "DEFAULT now()"
    }

    RUNS {
        text id PK
        text execution_assignment_id FK "0130: execution_assignments(id) SET NULL — the LATEST minted assignment (may be released; state says which is active); NULL = never placed"
    }

    RUN_SESSIONS {
        text id PK
        text execution_assignment_id FK "0130: execution_assignments(id) SET NULL — updated per spawn"
        text host_session_id "0130: nullable; supervisor session id written by the session.create ack"
        text acp_session_id "ADR-114: unchanged"
    }

    NODE_ATTEMPTS {
        text id PK
        text execution_assignment_id FK "0130: execution_assignments(id) SET NULL — stamped at attempt start, immutable"
    }
```

## Keys and constraints

- `execution_hosts_host_key_unique` — `UNIQUE (host_key)`.
- `execution_hosts_local_active_uq` — partial `UNIQUE (kind) WHERE kind =
'local_direct' AND retired_at IS NULL`: **at most one non-retired local
  host** (E-EH-01). The registrar's identity-change policy runs under a
  `SELECT … FOR UPDATE` of that one row.
- `execution_hosts_kind_check` (`local_direct`) and
  `execution_hosts_readiness_check` (`unknown|ready|unavailable`).
- `execution_assignments_run_epoch_uq` — `UNIQUE (run_id, epoch)`: a mint
  never reuses an epoch (E-EH-02, race backstop; `23505` → `CONFLICT`).
- `execution_assignments_run_active_uq` — partial `UNIQUE (run_id) WHERE
state = 'active'`: at most one active assignment per run (E-EH-02).
- `execution_assignments_epoch_check` (`epoch >= 1`),
  `execution_assignments_state_check`,
  `execution_assignments_placement_reason_check` (ten tokens), and
  `execution_assignments_active_shape_check` — `(state = 'active') =
(ended_at IS NULL)`, so an `active` row can never carry `ended_at` and a
  terminal row always does.
- `execution_commands_kind_check` (eight kinds),
  `execution_commands_state_check` (six states), and
  `execution_commands_terminal_shape_check` — `(state IN ('succeeded',
'failed', 'fenced')) = (completed_at IS NOT NULL)`.
- Indexes: `execution_assignments_host_state_idx (execution_host_id, state)`
  (the registrar's "does the old row still own active work" scan),
  `execution_commands_open_idx (state, next_attempt_at) WHERE state IN
('queued', 'delivering', 'accepted')` (the recovery pass and the deliverer's
  due scan — the predicate is mirrored by `loadOpenCommands`),
  `execution_commands_run_created_idx (run_id, created_at)` (per-run command
  history), `execution_commands_assignment_idx (execution_assignment_id)`,
  `runs_execution_assignment_idx (execution_assignment_id)`,
  `run_sessions_host_session_idx (host_session_id)` (the reconcile lookup by
  host session id), `run_sessions_assignment_idx (execution_assignment_id)`,
  `node_attempts_assignment_idx (execution_assignment_id)`.
- FK constraint names follow drizzle's `<table>_<col>_<reftable>_<refcol>_fk`
  convention; the exact set is listed in
  [`../database-schema.md`](../database-schema.md#execution-host-tables-implemented--adr-166-migration-0130).

## Cascade chain

```
runs
  ├── execution_assignments   (FK run_id,                  CASCADE)
  │     ├── execution_commands (FK execution_assignment_id, CASCADE)
  │     └── execution_assignments.superseded_by_id (self-ref,  SET NULL)
  ├── execution_commands      (FK run_id,                  CASCADE — also direct)
  ├── runs.execution_assignment_id          (FK → execution_assignments, SET NULL)
  ├── run_sessions.execution_assignment_id  (FK → execution_assignments, SET NULL)
  └── node_attempts.execution_assignment_id (FK → execution_assignments, SET NULL)

execution_hosts
  ├── execution_assignments.execution_host_id (RESTRICT — a host with history is retired, never deleted)
  └── execution_commands.execution_host_id    (RESTRICT)
```

Deleting a run drops its assignments and commands in one statement (the
project cascade reaches them through `runs`). An execution host is never
hard-deleted while any assignment or command references it — retirement is
`retired_at`, which is also what frees the partial unique index for the next
local host.

## Stabilization additions (Designed)

The [canonical field/constraint table](../database-schema.md#ab-stabilization-persistence-contract-designed)
owns exact future names and activation rules. The existing command ledger gains
private immutable request bytes, independent receipt/event evidence, owner
application claims and retirement confirmation. The consumer row gains fair
service order. The object catalog gains declared-versus-sealed identity,
import origin and deletion/examination intent. No generated ERD is changed
until the matching forward Drizzle migration exists.

## Retention

The existing age-only command/receipt pruning is incomplete (AB-10).
The [Designed retirement protocol](../system-analytics/execution-prompt-lifecycle.md#command-retirement-and-bounded-retry-policy-designed)
requires terminal ACK, owner disposition, terminal run/delivery holds and grace,
followed by host confirmation before compaction. Existing cascade FKs must not
remove protected commands or import proofs. No in-place migration amendment is
permitted; guarded forward corrections and a real run-delete race enforce this.

## Linked artifacts

- Decision: [ADR-166](../decisions.md#adr-166-local-execution-host-contract--durable-host-identity-epoch-fenced-assignments-command-ledger-opaque-adopted-workspaces).
- Behavior: [`../system-analytics/execution-hosts.md`](../system-analytics/execution-hosts.md).
- Column reference: [`../database-schema.md`](../database-schema.md).
- Related ERDs: [`runs-domain.md`](runs-domain.md) (`runs`, `run_sessions`,
  `node_attempts`).
- Wire: [`../api/supervisor.openapi.yaml`](../api/supervisor.openapi.yaml)
  (`CommandEnvelope`, `AdoptWorkspaceRequest`, `CommandReceipt`).
- Source (Implemented): `web/lib/db/schema.ts`,
  `web/lib/db/migrations/0130_execution_hosts.sql`,
  `web/lib/execution-host/{hosts,assignments,commands}.ts`.
