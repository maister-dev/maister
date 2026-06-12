# Domain-event outbox domain

## Purpose

The domain-event outbox (**Implemented**, ADR-086, M32) is MAIster's shared
**trigger bus**: an immutable, append-only log of curated domain facts
(`domain_events`), written from the domain layer in the SAME transaction as the
state change, and a per-consumer cursor dispatcher running on the M24 clock.
Multiple independent consumers — the future agent-trigger dispatcher, the
outbound-webhooks drainer (after its later re-point), notifiers — each consume
the same log at their own pace with at-least-once delivery and cursor catch-up
after outages. Boundary: this domain owns the fact log, the consumer-cursor
mechanics, and the dispatch job; it does NOT own any delivery channel (webhooks
keep their own outbox until re-pointed — [outbound-webhooks.md](outbound-webhooks.md)),
the run state machine ([runs.md](runs.md)), the social-board audit feed
(`task_activity` stays the user-facing activity log, ADR-083), or the clock it
borrows ([scheduler.md](scheduler.md)).

## Domain entities

- **`domain_events`** (Implemented) — the append-only fact log. One row per
  emitted domain fact: `{ id (bigint identity, dispatch ordering key), kind,
  project_id, task_id?, run_id?, actor_type?, actor_id?, payload, occurred_at,
  created_at, tx_id (xid8, commit-visibility horizon) }`. The polymorphic
  `(actor_type, actor_id)` pair mirrors `task_activity` (ADR-083). No
  UPDATE/DELETE app paths; FKs cascade on project/task/run delete (events are
  trigger material, not the audit log). See [db/domain-events.md](../db/domain-events.md).
- **`domain_event_consumers`** (Implemented) — one cursor row per registered
  consumer: `{ consumer_id (PK), cursor_event_id, lease_expires_at?,
  last_dispatched_at?, last_error?, consecutive_failures }`. Claim/advance
  mechanics below. See [db/domain-events.md](../db/domain-events.md).
- **Kind taxonomy v1** (Implemented) — exactly 8 kinds:
  `task.created`, `task.comment_added`, `task.triage_requeued`, `run.done`,
  `run.failed`, `run.crashed`, `run.abandoned`, `gate.failed`.
  `task.triage_requeued` was registered with no emitter; its emitter is the
  M33 "Send to triage" action (Implemented — `triage_status = NULL` + emit +
  `triage_requeued` activity in one transaction, ADR-088). Extension rule:
  one taxonomy entry + emit site(s) in the owning domain transaction + one
  doc row + a CHECK update via migration.
- **`domain_event_dispatch` job kind** (Implemented) — singleton dispatcher on
  the M24 clock (one seeded `domain_event_dispatch.default` job, cadence 60s,
  budget `domainEventDispatch: 1`, not user-creatable). See
  [scheduler.md](scheduler.md).
- **Consumer registry + `noop` consumer** (Implemented) — code-owned
  `DOMAIN_EVENT_CONSUMERS` array (`web/lib/domain-events/consumers.ts`); each
  entry declares `{ id, startFrom: "beginning" | "now", handle(events) }`. v1
  ships exactly one permanently-registered `noop` consumer (`startFrom: "now"`)
  as the live proof of the seam and an ops liveness signal.
- **`agent_triggers` consumer** (M33 — Implemented, ADR-088) — the first real
  consumer (`startFrom: "now"`): matches each event's kind + project against
  enabled `agent_schedules` event rows joined to enabled
  `agent_project_links`, skips events actored by the matched agent itself
  (the self-exclusion anti-loop guard), and claims each spawn by inserting
  the `Pending` agent run under the partial UNIQUE
  `(agent_id, trigger_event_id)` — at-least-once redelivery converges to
  exactly one run. See [agents.md](agents.md).

## State machine

The consumer-cursor lifecycle (`domain_event_consumers` row). All transitions
Implemented.

```mermaid
stateDiagram-v2
    [*] --> Registered: ensureConsumerRows ON CONFLICT DO NOTHING<br/>cursor = 0 (beginning) or MAX(id) (now)
    Registered --> Claimed: CAS lease_expires_at = now + 5min<br/>WHERE lease NULL or expired
    Claimed --> Advanced: handle ok — cursor CAS to last id<br/>lease NULL, consecutive_failures = 0
    Claimed --> FailedPass: handle throws — cursor unchanged<br/>lease NULL, consecutive_failures + 1, last_error set
    Claimed --> LeaseExpired: process died mid-handle<br/>lease lapses after TTL
    LeaseExpired --> Claimed: next tick reclaims — redelivery
    Advanced --> Claimed: next tick, more events
    FailedPass --> Claimed: next tick retries same window
    Advanced --> Registered: idle — no events past cursor
```

A zombie dispatcher returning after its lease was reaped and the consumer
reclaimed cannot clobber the cursor: the advance is a CAS fenced on the cursor
value read at claim — it no-ops, converging to a duplicate delivery
(at-least-once), never a lost one.

## Process flows

### (a) Capture — same-transaction outbox INSERT (Implemented)

Capture rides the existing domain write path, exactly like the webhook outbox
(ADR-077). `emitDomainEvent` performs ONE INSERT into `domain_events` inside
the SAME transaction as the domain write — no reads, no joins, no network. It
fires only on the CAS-winner path; a losing CAS emits nothing. During the
webhooks-coexistence period, run-terminal and gate-failed sites emit BOTH the
webhook row and the domain row adjacently in the same transaction.

```mermaid
flowchart TD
    T([domain write: task / comment / run terminal / gate failed]) --> CAS{CAS or insert wins?}
    CAS -- no --> NOEMIT[no emit — loser path]
    CAS -- yes --> INS[INSERT domain_events<br/>kind, project_id, task_id?, run_id?, actor, payload, occurred_at<br/>tx_id = pg_current_xact_id]
    INS --> COMMIT[(commit with the same tx)]
    COMMIT --> DONE[write path continues — no network]
```

### (b) Dispatch tick — claim, read window, handle, advance (Implemented)

The `domain_event_dispatch` handler iterates registered consumers. Per
consumer: claim the cursor row by CAS lease, read the next window gated by the
xid8 commit horizon, invoke `handle(events)`, advance the cursor by fenced CAS.
Up to 10 batches of 100 per consumer per tick; the remainder waits for the next
tick.

```mermaid
sequenceDiagram
    participant H as domain_event_dispatch handler
    participant C as domain_event_consumers
    participant E as domain_events
    participant X as consumer.handle
    H->>C: ensureConsumerRows (ON CONFLICT DO NOTHING)
    H->>C: CAS claim — lease_expires_at = now + 5min WHERE lease NULL or expired
    C-->>H: cursor_event_id (zero rows = another claimer — skip)
    loop up to 10 batches
        H->>E: SELECT WHERE id > cursor AND tx_id < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY id LIMIT 100
        E-->>H: events (empty = done)
        H->>X: handle(events)
        alt handle ok
            H->>C: CAS advance — cursor = last id, lease NULL, failures = 0 (fenced on claimed cursor)
        else handle throws
            H->>C: lease NULL, consecutive_failures + 1, last_error (cursor unchanged)
        end
    end
```

### (c) Catch-up and the commit horizon (Implemented)

Missed ticks need no special path: events accumulate, the cursor stays put, and
the next tick drains the backlog in batches — recovery IS the cursor. The xid8
horizon (`tx_id < pg_snapshot_xmin(pg_current_snapshot())`) closes the
out-of-order-commit hole: identity `id` order is assignment order, not commit
order, so a plain `id > cursor` read could advance past a still-open
transaction's lower id and lose it forever. The horizon holds back ALL events
past the oldest active transaction until it resolves.

```mermaid
flowchart TD
    A[tx A starts, inserts id=100, stays open] --> B[tx B inserts id=101, commits]
    B --> D{dispatch reads<br/>id > cursor AND tx_id < snapshot xmin}
    D -- horizon holds --> H[sees nothing — 101 held back behind open tx A]
    A2[tx A commits or aborts] --> D2[next tick reads 100 and 101 in id order]
    H --> A2
```

## Expectations

- The `emitDomainEvent` INSERT MUST share the transaction of its domain write
  and MUST fire only on the CAS-winner path; if the domain write does not
  commit, the event row MUST NOT exist.
- `domain_events` MUST be append-only: no UPDATE or DELETE application paths;
  any future pruning MUST honor `min(cursor_event_id)` across registered
  consumers (no pruning in this stage).
- `domain_events.kind` MUST be one of the 8 taxonomy kinds (CHECK-enforced);
  `task.triage_requeued` MUST be emitted only by the M33 "Send to triage"
  action (Designed) — no other emitter.
- The dispatch read window MUST be exactly `id > cursor_event_id AND tx_id <
  pg_snapshot_xmin(pg_current_snapshot()) ORDER BY id LIMIT batch` — a
  late-committing lower id MUST hold back all later ids until it resolves.
- A consumer claim MUST be a CAS on `lease_expires_at` (claim only when NULL or
  expired); concurrent dispatch passes MUST yield exactly one active claimer
  per consumer.
- The cursor advance MUST be a CAS fenced on the `cursor_event_id` value read
  at claim; a zombie advance after lease reap + reclaim MUST no-op.
- Delivery MUST be at-least-once: a handler failure or a crash before advance
  MUST redeliver the same window on a later tick; consumers MUST be idempotent.
- A handler failure MUST increment `consecutive_failures`, set `last_error`,
  release the lease, and leave the cursor unchanged; a subsequent success MUST
  reset `consecutive_failures` to 0. There is NO auto-disable in this stage.
- Consumer registration MUST seed the cursor row idempotently (`ON CONFLICT DO
  NOTHING`) honoring `startFrom`: `"beginning"` = 0, `"now"` = current
  `MAX(id)`.
- `domain_event_dispatch` MUST be a seeded singleton (60s cadence, budget 1)
  and MUST be rejected by `createSchedulerJobSchema` (not user-creatable).
- During webhooks coexistence, every run-terminal and gate-failed
  `emitWebhookEvent` MUST have a paired `emitDomainEvent` in the same
  transaction (grep-gated), and the three webhook-less sites (`createTask`,
  `addTaskComment`, `runPass2`) MUST emit the domain event in their existing or
  newly-wrapped transaction.
- `domain_events.payload` MUST carry ids, keys, titles, and statuses only —
  never secrets, env values, tokens, or raw agent output.

## Edge cases

- **Long-running open transaction anywhere in the DB** → the horizon holds back
  all later events until it resolves (head-of-line stall, never loss). Domain
  transactions are short and migrations run offline; dispatch resumes on the
  next tick. No error.
- **Lease expiry mid-handle** (process death) → the next tick reclaims and
  redelivers the window; the consumer absorbs the duplicate (idempotence). No
  error.
- **Consumer removed from the registry** → its cursor row stays dormant
  (no claim, no advance); cleanup is deferred until pruning lands. No error.
- **Empty registry** → the dispatch handler no-ops with an INFO summary. No
  error.
- **Persistently failing consumer** → retries forever on the tick cadence;
  `consecutive_failures` + `last_error` are the observability surface (WARN log
  per failing pass). Poison-pill policy is a first-real-consumer concern
  (Phase 2).
- **Project/task/run hard delete** → FK cascade removes the events; the
  durable audit trail is `task_activity` / run ledgers, not this log.

## Linked artifacts

- **Decision:** [ADR-086](../decisions.md#adr-086-domain-event-outbox-as-the-shared-trigger-bus).
- **Spec freeze:** [`../../.ai-factory/specs/domain-event-outbox.spec.md`](../../.ai-factory/specs/domain-event-outbox.spec.md).
- **DB:** [`db/domain-events.md`](../db/domain-events.md) and
  [`database-schema.md`](../database-schema.md) — the two tables (migration
  `0046`).
- **First real consumer (M33 — Implemented):** [`agents.md`](agents.md) — the
  `agent_triggers` consumer and the triage Q&A loop.
- **Background clock:** [`scheduler.md`](scheduler.md) — the
  `domain_event_dispatch` job kind, `domainEventDispatch: 1` budget, and the
  `domain_event_dispatch.default` 60s seed.
- **Coexisting sibling:** [`outbound-webhooks.md`](outbound-webhooks.md) — the
  webhook outbox keeps its own capture until its drainer is re-pointed at
  `domain_events` (it then becomes a registered consumer).
- **Actor model:** [`social-board.md`](social-board.md) — the polymorphic
  `(actor_type, actor_id)` pair (ADR-083).
- **Source (Implemented):** `web/lib/domain-events/*` (`taxonomy.ts`, `outbox.ts`,
  `consumers.ts`, `dispatch.ts`),
  `web/lib/scheduler/handlers/domain-event-dispatch.ts`.
