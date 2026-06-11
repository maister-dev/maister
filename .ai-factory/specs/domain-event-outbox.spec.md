# Domain-Event Outbox Core (Shared Trigger Bus) — M32

Status: SDD freeze for Phase 0. No production code is implemented by this spec.
Date: 2026-06-11
Branch: `feature/domain-event-outbox`

## Purpose

MAIster needs one durable, shared trigger bus for curated domain facts so that
multiple independent consumers — the future agent-trigger dispatcher (platform
agents), the outbound-webhooks drainer (after its later re-point), notifiers —
can each consume the same log at their own pace with at-least-once delivery and
cursor catch-up after outages. This stage ships the bus core only: the
`domain_events` table, the same-transaction emission discipline, the
per-consumer cursor dispatcher on the M24 clock, and a permanently-registered
`noop` consumer. **No real consumers are built here.**

## Scope source

The staged platform-agents/social-board design doc was never committed (owner
decision 2026-06-11: not restored). The durable record of Stage 2 is: this
spec + [ADR-085](../../docs/decisions.md#adr-085-domain-event-outbox-as-the-shared-trigger-bus)
+ [`docs/system-analytics/domain-events.md`](../../docs/system-analytics/domain-events.md)
+ the roadmap row `M32`. Stage 1 (social board, ADR-083/M31) is merged; Stage 3+
(triager, agent actors) consume this bus later.

## Table contract

### `domain_events` (migration `0045`, append-only)

| Column | Type | Contract |
| --- | --- | --- |
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` PK | dispatch ordering key |
| `kind` | `text` CHECK | one of the 8 taxonomy kinds |
| `project_id` | `text NOT NULL` FK → projects (CASCADE) | all v1 kinds are project-scoped |
| `task_id` | `text NULL` FK → tasks (CASCADE) | task.* kinds |
| `run_id` | `text NULL` FK → runs (CASCADE) | run.* / gate.* kinds |
| `actor_type` / `actor_id` | `text NULL`, CHECK `actor_type ∈ user\|system\|agent` | ADR-083 polymorphic pair |
| `payload` | `jsonb NOT NULL` | ids/keys/titles/statuses only — never secrets |
| `occurred_at` | `timestamptz NOT NULL` | domain time |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `tx_id` | `xid8 NOT NULL DEFAULT pg_current_xact_id()` | commit-visibility horizon |

No UPDATE/DELETE application paths. No secondary indexes (PK-range dispatch
reads; `webhook_events` precedent). No retention in this stage; future pruning
MUST honor `min(cursor_event_id)` across registered consumers.

### `domain_event_consumers` (migration `0045`)

| Column | Type |
| --- | --- |
| `consumer_id` | `text` PK (registry id) |
| `cursor_event_id` | `bigint NOT NULL DEFAULT 0` |
| `lease_expires_at` | `timestamptz NULL` |
| `last_dispatched_at` | `timestamptz NULL` |
| `last_error` | `text NULL` |
| `consecutive_failures` | `integer NOT NULL DEFAULT 0` |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

## Kind taxonomy v1 and payloads

| Kind | Emitter (same tx as the domain write) | Payload |
| --- | --- | --- |
| `task.created` | `createTask` (`web/lib/services/tasks.ts`) | `{ taskKey, title }`; actor via `actorForUserId` |
| `task.comment_added` | `addTaskComment` (`web/lib/social/comments.ts`) | `{ taskKey, commentId, mentionedTaskIds? }`; actor = commenter |
| `task.triage_requeued` | **none — registered, emitter lands with the Stage-3 triager** | `{ taskKey, reason? }` (frozen shape, unused) |
| `run.done` | promote finalize ×3, graph-runner Done | `{ runId, taskId?, flowId?, runKind }` |
| `run.failed` | state-transitions, runners, watchdog, hitl failure | `{ runId, taskId?, flowId?, runKind, reason? }` |
| `run.crashed` | state-transitions, runners, scratch, hitl | same as `run.failed` |
| `run.abandoned` | `markAbandoned`, workbench drop, **`runPass2` TTL (newly wrapped tx)** | same + `reason` carries the source |
| `gate.failed` | `gate-store` terminal-failed paths ×3 | `{ runId, gateId, gateKind, gateResultId, nodeAttemptId, blocking }` |

Extension rule: one taxonomy entry + emit site(s) in the owning domain
transaction + one doc row + a CHECK update via migration.

`taskKey` is rendered `${projects.task_key}-${tasks.number}`. Actor mapping:
`actorForUserId(ctx.actorUserId)` / the caller's `SocialActor`
(`web/lib/social/activity.ts`); run/gate system paths emit `actor_type:
"system"` or the acting user when one exists.

## Dispatcher contract (DD3 of the plan)

Per registered consumer, each `domain_event_dispatch` tick:

1. `ensureConsumerRows` — `INSERT … ON CONFLICT DO NOTHING`; `startFrom:
   "beginning"` seeds cursor 0, `"now"` seeds `COALESCE(MAX(id), 0)` in the
   same statement.
2. **Claim (CAS):** `UPDATE … SET lease_expires_at = now() + 5min WHERE
   consumer_id = $1 AND (lease_expires_at IS NULL OR lease_expires_at < now())
   RETURNING cursor_event_id`; zero rows ⇒ skip (another claimer live).
3. **Read window:** `id > $cursor AND tx_id <
   pg_snapshot_xmin(pg_current_snapshot()) ORDER BY id LIMIT 100`. The xid8
   horizon makes late-committing lower ids hold back later ids — a cursor can
   never skip an event.
4. **Invoke** `consumer.handle(events)`.
5. **Advance (fenced CAS):** `SET cursor_event_id = $lastId, lease_expires_at =
   NULL, consecutive_failures = 0 WHERE consumer_id = $1 AND cursor_event_id =
   $cursorReadAtClaim`. On `handle` throw: release lease,
   `consecutive_failures + 1`, `last_error`, cursor unchanged.
6. Loop 3–5 up to 10 batches per tick; the remainder waits for the next tick.

Failure classification:

| Failure | Row state after | Next tick |
| --- | --- | --- |
| `handle()` throws | cursor unchanged, lease released, failures+1 | redeliver same window |
| crash mid-handle | lease held until TTL | reclaim after expiry → redeliver |
| zombie advance after reap+reclaim | cursor CAS no-ops | duplicate possible, never loss |

At-least-once overall; **consumers MUST be idempotent**. No poison-pill
auto-disable in this stage (`consecutive_failures` + WARN logs are the
observability surface).

## Scheduler integration

New `job_kind: domain_event_dispatch`; singleton `domain_event_dispatch.default`
(cadence 60s, budget `domainEventDispatch: 1`) seeded by
`ensureDefaultSchedulerJobs`; **excluded** from `createSchedulerJobSchema`
(`run_schedule` precedent); added to the admin `scheduler.kind` i18n label map
(EN+RU) but NOT to `targetHint`. ADR-§1 preserved: live path = emission in the
domain tx + tick dispatch; recovery = the same cursor on the next tick.

## Webhooks coexistence

`webhook_events` (ADR-077) stays untouched as the webhook-private capture.
Run-terminal/gate-failed sites emit BOTH rows adjacently in one transaction
(grep-gated). Later stage: the webhooks fanout pass re-points at
`domain_events` (webhooks become a registered consumer); `webhook_events`
retires. M32 additionally closes the `runPass2` webhook gap: the TTL
`NeedsInputIdle → Abandoned` flip becomes transactional (folding the adjacent
`hitl_requests` close-out) and emits `run.abandoned` with `data.source: "ttl"`
(AsyncAPI enum extension).

## Acceptance criteria traceability

| AC | Criterion | Test (all integration, testcontainers PG16) |
| --- | --- | --- |
| AC1 | Event visible **iff** the domain write committed | `emit.integration.test.ts` T-E1/E2; `emit-sites` T-E3 (createTask + injected failure), T-E4 (addTaskComment) |
| AC2 | Cursor isolation between consumers | `dispatch.integration.test.ts` T-D1 |
| AC3 | No double-claim under concurrent ticks | T-D2 (concurrent dispatch, exactly-once per consumer) + T-D6 (zombie fence) |
| AC4 | Catch-up after clock outage | T-D3 (backlog drained in one run via batch loop) |
| — | Horizon correctness | T-D5 (open earlier tx holds back later committed events; release in id order) |
| — | At-least-once + failure accounting | T-D4 |
| — | `startFrom: "now"` | T-D7 |
| — | Singleton seeding + tick claim | T-D8 (mirrors `webhook-delivery.integration.test.ts`) |
| — | Paired terminal emission, CAS-loser zero | T-E5/E6/E7 |

## Non-goals (this stage)

- No real consumers (agent triggers, notifiers, webhooks re-point) — seam only.
- No retention/pruning of `domain_events`.
- No HTTP/SSE surface, no OpenAPI/AsyncAPI changes beyond the `run.abandoned`
  `source` enum extension, no new `MaisterError` code, no new env vars.
- No webhooks migration onto the bus (a later stage owns the re-point).
- No poison-pill/auto-disable policy for failing consumers.

## Linked artifacts

- Plan: [`../plans/feature-domain-event-outbox.md`](../plans/feature-domain-event-outbox.md)
- ADR: [ADR-085](../../docs/decisions.md#adr-085-domain-event-outbox-as-the-shared-trigger-bus)
- Analytics: [`docs/system-analytics/domain-events.md`](../../docs/system-analytics/domain-events.md)
- ERD: [`docs/db/domain-events.md`](../../docs/db/domain-events.md) +
  [`docs/database-schema.md`](../../docs/database-schema.md)
- Scheduler: [`docs/system-analytics/scheduler.md`](../../docs/system-analytics/scheduler.md)
- Coexistence: [`../plans/feature-outbound-webhooks.md`](../plans/feature-outbound-webhooks.md) (takeover note)
