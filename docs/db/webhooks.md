# Webhooks domain ERD

Tables for the outbound webhook delivery primitive introduced by ADR-077.
See [`../system-analytics/outbound-webhooks.md`](../system-analytics/outbound-webhooks.md)
for behavior, the delivery FSM, and the event taxonomy, and
[`../database-schema.md`](../database-schema.md) for the column-level narrative.

> **Status: Implemented.** Migration `0040_outbound_webhooks.sql` (additive,
> forward-only, no down-migration) adds all four tables and the
> `platform_runtime_settings.webhooks_enabled` column.
>
> **Widening (Designed — [ADR-172](../decisions.md#adr-172), migration `0164`).**
> `webhook_events.project_id` and `.run_id` become nullable and
> `webhook_subscriptions.owner_user_id` is added, so a per-user `attention.*`
> event — which has neither a project nor a run — rides this same outbox
> instead of a second one. The widening drops nothing.
>
> Scope becomes **two independent axes**. The shipped match expression
> `sub.project_id IS NULL OR sub.project_id = event.project_id` treats a NULL
> subscription project as "platform-wide, matches everything"; once the *event*
> project can also be NULL that first disjunct would make every platform-wide
> subscription match every user event. A platform-wide subscription MUST NOT
> match a user-scoped event, and a user subscription MUST NOT match a
> project-scoped one — both directions are contractual (`NTF-03`).

The diagram below also notes that `platform_runtime_settings` gains a
`webhooks_enabled boolean NOT NULL DEFAULT true` global kill-switch column
(not drawn as a full entity here — only the additive column is new).

```mermaid
erDiagram
    PROJECTS ||--o{ WEBHOOK_SUBSCRIPTIONS : "project-scoped (nullable)"
    PROJECTS ||--o{ WEBHOOK_EVENTS : "emitted per project"
    RUNS ||--o{ WEBHOOK_EVENTS : "emitted per run"
    WEBHOOK_EVENTS ||--o{ WEBHOOK_DELIVERIES : "fanned out to"
    WEBHOOK_SUBSCRIPTIONS ||--o{ WEBHOOK_DELIVERIES : "delivered via (cascade)"
    WEBHOOK_DELIVERIES ||--o{ WEBHOOK_DELIVERY_ATTEMPTS : "attempt audit (cascade)"

    WEBHOOK_SUBSCRIPTIONS {
        text id PK "server crypto.randomUUID()"
        text project_id FK "NULL -> projects(id); NULL = platform scope"
        text owner_user_id FK "NULL -> users(id) ON DELETE CASCADE; NON-NULL = user scope (0164, Designed)"
        text name "display name"
        text url "http/https only; boundary-validated"
        text method "POST|PUT DEFAULT POST"
        jsonb headers "Record<string,string> DEFAULT {}; values are env:NAME refs only"
        jsonb event_types "string[]; taxonomy types or literal *"
        text signing_secret_ref "NOT NULL; env:NAME ref"
        text secondary_signing_secret_ref "NULL; env:NAME ref for rotation overlap"
        boolean enabled "NOT NULL DEFAULT true"
        timestamptz created_at
        timestamptz updated_at
    }

    WEBHOOK_EVENTS {
        text id PK "server crypto.randomUUID()"
        text project_id FK "-> projects(id); NULL for user-scoped attention.* events (0164, Designed)"
        text run_id FK "-> runs(id); NULL for user-scoped attention.* events (0164, Designed)"
        text type "taxonomy type string"
        jsonb data "per-type minimal facts; written at emit"
        jsonb payload "NULL until fanout; full frozen envelope built at FANOUT"
        timestamptz occurred_at
        timestamptz fanout_at "NULL = awaiting fanout; IS NULL is the fanout cursor"
        timestamptz created_at
    }

    WEBHOOK_DELIVERIES {
        text id PK "server crypto.randomUUID()"
        text event_id FK "NOT NULL -> webhook_events(id)"
        text subscription_id FK "NOT NULL -> webhook_subscriptions(id) ON DELETE CASCADE"
        text status "pending|delivered|dead DEFAULT pending"
        integer attempt_count "DEFAULT 0"
        timestamptz next_attempt_at "NOT NULL"
        timestamptz lease_expires_at "NULL; set while a drain tick owns this row"
        text idempotency_key "NOT NULL; hex sha256(subscriptionId:eventId)"
        integer last_http_status "NULL"
        text last_error_kind "NULL; timeout|network|http|config"
        text last_error_message "NULL; truncated <= 1KB"
        timestamptz delivered_at "NULL"
        timestamptz created_at
        timestamptz updated_at
    }

    WEBHOOK_DELIVERY_ATTEMPTS {
        text id PK "server crypto.randomUUID()"
        text delivery_id FK "NOT NULL -> webhook_deliveries(id) ON DELETE CASCADE"
        integer attempt_no "UNIQUE with delivery_id; continues from prior total"
        timestamptz requested_at
        integer duration_ms
        integer http_status "NULL"
        text error_kind "NULL; timeout|network|http|config"
        text error_detail "NULL; truncated <= 1KB"
        text response_snippet "NULL; truncated <= 1KB"
    }
```

## Keys and unique constraints

| Table | Constraint | Columns | Purpose |
| ----- | ---------- | ------- | ------- |
| `webhook_deliveries` | `UNIQUE` | `(subscription_id, event_id)` | Fanout dedupe invariant — `ON CONFLICT DO NOTHING` on insert. |
| `webhook_delivery_attempts` | `UNIQUE` | `(delivery_id, attempt_no)` | One row per attempt number per delivery. |

## Partial indexes

| Table | Index | Predicate | Purpose |
| ----- | ----- | --------- | ------- |
| `webhook_events` | `webhook_events_pending_fanout_idx` | `WHERE fanout_at IS NULL` | Fanout-pass claim — only unprocessed outbox events. |
| `webhook_deliveries` | `webhook_deliveries_due_idx` | `WHERE status = 'pending'` | Drain-pass claim — due deliveries only. |

## Regular indexes

| Table | Index | Columns | Purpose |
| ----- | ----- | ------- | ------- |
| `webhook_subscriptions` | `webhook_subscriptions_project_idx` | `(project_id)` | Project-scope subscription lookup (NULL rows are the platform scope). |
| `webhook_events` | `webhook_events_pending_fanout_idx` | `(created_at)` + partial predicate above | Ordered fanout scan. |
| `webhook_deliveries` | `webhook_deliveries_due_idx` | `(next_attempt_at)` + partial predicate above | Ordered drain scan. |
| `webhook_deliveries` | `webhook_deliveries_subscription_log_idx` | `(subscription_id, created_at DESC)` | Deliveries-drawer log UI. |
| `webhook_delivery_attempts` | `webhook_delivery_attempts_delivery_idx` | `(delivery_id)` | Attempt history for a delivery. |

## Cascade chain

```
projects
  ├── webhook_subscriptions  (FK project_id,      nullable; ON DELETE CASCADE)
  │     └── webhook_deliveries  (FK subscription_id, ON DELETE CASCADE)
  │           └── webhook_delivery_attempts  (FK delivery_id, ON DELETE CASCADE)
  └── webhook_events  (FK project_id,      ON DELETE CASCADE)
        └── webhook_deliveries  (FK event_id,        ON DELETE CASCADE)

runs
  └── webhook_events  (FK run_id,          ON DELETE CASCADE)
```

Deleting a project drops all its `webhook_subscriptions`, `webhook_events`,
and all `webhook_deliveries` / `webhook_delivery_attempts` that hang off them.
Deleting a run drops its `webhook_events` rows and — because
`webhook_deliveries.event_id` cascades too — every delivery and attempt
recorded for those events. Delivery-history longevity is therefore guaranteed
by the retention pass, not the FK: the prune deletes only zero-delivery
events, so an event referenced by any delivery (and the audit under it) is
never removed by the system itself. Deleting a `webhook_subscriptions` row
cascades to its `webhook_deliveries` and their `webhook_delivery_attempts`.

## Fanout cursor model

`webhook_events.fanout_at IS NULL` is the **entire** fanout cursor — no
separate cursor table is needed. The drain worker claims rows with
`fanout_at IS NULL FOR UPDATE SKIP LOCKED`, freezes the envelope into
`payload`, inserts `webhook_deliveries` rows (`ON CONFLICT DO NOTHING` for
the unique `(subscription_id, event_id)`), and sets `fanout_at` in the same
transaction.

## Retention

Zero-delivery events (events where `fanout_at` has been set and no
`webhook_deliveries` rows reference the event row) are pruned after 7 days
by the `webhook_delivery` scheduler job's tail pass. Events referenced by
any `webhook_deliveries` row are kept indefinitely for replay and audit.

## Linked artifacts

- Process flows: [`../system-analytics/outbound-webhooks.md`](../system-analytics/outbound-webhooks.md).
- Global ERD: [`erd.md`](erd.md).
- Narrative: [`../database-schema.md`](../database-schema.md).
- Decision record: ADR-077 in [`../decisions.md`](../decisions.md).
- Source (Implemented): `web/lib/db/schema.ts` (migration `0040_outbound_webhooks.sql`).
