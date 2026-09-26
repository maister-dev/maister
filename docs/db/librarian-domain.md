# Librarian domain ERD

Tables of the personal librarian: one conversation per user on a project-less
`run_kind='librarian'` run ([ADR-183](../decisions.md#adr-183)), per-turn
owner-bound tokens and their audit ([ADR-184](../decisions.md#adr-184)), the
operation ledger, confirmation cards and follow-up updates
([ADR-185](../decisions.md#adr-185)), task statements and conversation
provenance ([ADR-186](../decisions.md#adr-186)), user-origin clarifications
([ADR-187](../decisions.md#adr-187)), and memory, summaries, reset and history
deletion ([ADR-188](../decisions.md#adr-188)). Behaviour lives in
[`../system-analytics/librarian-conversation.md`](../system-analytics/librarian-conversation.md),
[`librarian-authority.md`](../system-analytics/librarian-authority.md),
[`librarian-operations.md`](../system-analytics/librarian-operations.md),
[`task-statements.md`](../system-analytics/task-statements.md),
[`task-clarifications.md`](../system-analytics/task-clarifications.md) and
[`librarian-memory.md`](../system-analytics/librarian-memory.md); the exact DDL,
constraint names and index names are in
[`../database-schema.md`](../database-schema.md#personal-librarian-tables-designed--adr-183188-migrations-01810188).

> **Status: Designed.** Migrations `0181`–`0188` specify every table and column
> drawn here; none has shipped. The generated [`erd.dbml`](erd.dbml) follows the
> Drizzle schema and gains them only when the migrations land. Shared tables
> (`users`, `runs`, `tasks`, …) are drawn with the librarian columns only; their
> full shape is in [`runs-domain.md`](runs-domain.md),
> [`hitl-domain.md`](hitl-domain.md), [`integrations-domain.md`](integrations-domain.md)
> and [`projects-domain.md`](projects-domain.md).

## Conversation, turns and runtime

A conversation is the user's single durable thread; each turn runs as one ACP
session on the conversation's one `runs` row and is authorized by one
turn-scoped token. Read it for the ownership chain from user to token.

```mermaid
erDiagram
    USERS ||--o| LIBRARIAN_CONVERSATIONS : "exactly one per user (cascade)"
    LIBRARIAN_CONVERSATIONS |o--o| RUNS : "run_id, the run_kind librarian run (SET NULL)"
    RUNS ||--o{ RUN_SESSIONS : "per-session state, updated per spawn"
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_SEGMENTS : "a new segment per reset (cascade)"
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_MESSAGES : "seq-ordered (cascade)"
    LIBRARIAN_SEGMENTS ||--o{ LIBRARIAN_MESSAGES : "segment_id"
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_TURNS : "at most one admitted or running (cascade)"
    LIBRARIAN_SEGMENTS ||--o{ LIBRARIAN_TURNS : "segment_id"
    LIBRARIAN_MESSAGES |o--o{ LIBRARIAN_TURNS : "message_id (SET NULL)"
    LIBRARIAN_TURNS ||--o{ LIBRARIAN_CONTEXT_SNAPSHOTS : "written before the prompt (cascade)"
    LIBRARIAN_TURNS ||--o{ PROJECT_TOKENS : "librarian_turn_id (cascade)"
    PROJECT_TOKENS ||--o{ TOKEN_AUDIT_LOG : "token_id (cascade)"
    USERS |o--o{ TOKEN_AUDIT_LOG : "on_behalf_of_user_id (SET NULL)"
    PLATFORM_ACP_RUNNERS |o--o| PLATFORM_RUNTIME_SETTINGS : "librarian_runner_id (SET NULL)"

    LIBRARIAN_CONVERSATIONS {
        text id PK "server crypto.randomUUID()"
        text user_id FK "NOT NULL -> users ON DELETE CASCADE; UNIQUE"
        text run_id FK "NULL -> runs ON DELETE SET NULL; UNIQUE"
        integer context_epoch "bumps on reset, forget, clear, authz change"
        integer forget_generation "summary and memory write fence"
        integer history_generation "summary and memory write fence"
        text current_segment_id "no FK"
        text reset_state "none|resetting"
        jsonb subject "NULL; the panel's current subject"
        bigint read_through_seq "only moves forward"
        boolean memory_enabled_next_segment "DEFAULT true"
        date daily_turn_date "NULL"
        integer daily_turn_count "DEFAULT 0; per-user daily cap"
        timestamptz created_at
        timestamptz updated_at
    }

    LIBRARIAN_SEGMENTS {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        integer ordinal "UNIQUE per conversation"
        timestamptz started_at
        timestamptz ended_at "NULL while current"
    }

    LIBRARIAN_MESSAGES {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        text segment_id FK "NOT NULL -> librarian_segments"
        bigint seq "UNIQUE per conversation; never reused; the stream cursor"
        text author_kind "owner|librarian|update|system"
        text client_message_id "NULL; partial UNIQUE per conversation"
        text body "NOT NULL; never on the stream"
        tsvector body_tsv "GENERATED to_tsvector simple"
        jsonb subject "NULL; captured at send"
        text delivery_state "accepted|queued|withdrawn|withdrawn_by_reset|processed"
        text turn_id "no FK"
        text[] source_project_ids "masking on render"
        text card_id "no FK"
        text update_id "no FK"
        timestamptz created_at
    }

    LIBRARIAN_TURNS {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        text segment_id FK "NOT NULL -> librarian_segments"
        text message_id FK "NULL -> librarian_messages SET NULL"
        text variant "owner_message|explain|summary"
        text status "queued|admitted|running|completed|stopped|failed|withdrawn"
        text failure_reason "required when failed"
        text context_snapshot_id "no FK; required when running"
        jsonb runner_snapshot "NULL; runner of the ACP session"
        text token_id "no FK"
        timestamptz deadline_at "NULL"
        timestamptz admitted_at "NULL"
        timestamptz started_at "NULL"
        timestamptz ended_at "NULL"
        timestamptz created_at
    }

    LIBRARIAN_CONTEXT_SNAPSHOTS {
        text id PK
        text turn_id FK "NOT NULL -> librarian_turns CASCADE"
        text instructions_version "NOT NULL"
        text[] message_ids "NOT NULL"
        jsonb summary_revisions "NOT NULL"
        jsonb memory_item_revisions "NOT NULL"
        text authz_fingerprint "NOT NULL"
        integer context_epoch "NOT NULL"
        integer char_count "NOT NULL"
        boolean truncated "NOT NULL"
        timestamptz created_at
    }

    RUNS {
        text run_kind "+ librarian; runs_run_kind_check"
        text librarian_operation_id "NULL; UNIQUE; set on a launched run, no FK"
    }

    RUN_SESSIONS {
        integer librarian_context_epoch "NULL; epoch the ACP session was created under"
    }

    PROJECT_TOKENS {
        text token_kind "+ librarian; project_tokens_kind_check"
        text librarian_turn_id FK "NULL -> librarian_turns CASCADE; required for the librarian kind"
    }

    TOKEN_AUDIT_LOG {
        text on_behalf_of_user_id FK "NULL -> users SET NULL"
        text librarian_turn_id "NULL; no FK"
        text operation_id "NULL; no FK"
    }

    PLATFORM_RUNTIME_SETTINGS {
        boolean librarian_enabled "NOT NULL DEFAULT false"
        text librarian_runner_id FK "NULL -> platform_acp_runners SET NULL"
    }
```

## Operations, cards, provenance and follow-up

Every effect the librarian makes is an operation row joined to its result by a
unique column on the result table; a card is the owner-click path for
human-only effects. Read it for how a conversation reaches tasks and runs
without owning them.

```mermaid
erDiagram
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_OPERATIONS : "UNIQUE conversation and idempotency_key (cascade)"
    LIBRARIAN_SEGMENTS ||--o{ LIBRARIAN_OPERATIONS : "segment_id; duplicate guard by digest"
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_CARDS : "pending, then decided once (cascade)"
    LIBRARIAN_MESSAGES |o--o{ LIBRARIAN_CARDS : "message_id (SET NULL)"
    LIBRARIAN_CARDS |o..o{ LIBRARIAN_OPERATIONS : "card_id, key card:cardId (no FK)"
    LIBRARIAN_OPERATIONS |o..o| TASKS : "created_via_operation_id (UNIQUE, no FK)"
    LIBRARIAN_OPERATIONS |o..o| TASK_COMMENTS : "via_operation_id (UNIQUE, no FK)"
    LIBRARIAN_OPERATIONS |o..o| TASK_CLARIFICATIONS : "requested_via_operation_id (UNIQUE, no FK)"
    LIBRARIAN_OPERATIONS |o..o| RUNS : "librarian_operation_id (UNIQUE, no FK)"
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_TASK_LINKS : "provenance (cascade)"
    TASKS ||--o{ LIBRARIAN_TASK_LINKS : "task_id (cascade)"
    LIBRARIAN_MESSAGES |o--o{ LIBRARIAN_TASK_LINKS : "from and to message (SET NULL)"
    TASKS ||--o{ TASK_STATEMENT_REVISIONS : "immutable revisions (cascade)"
    TASKS ||--o{ TASK_CLARIFICATIONS : "task-owned history (cascade)"
    LIBRARIAN_MESSAGES |o--o{ TASK_CLARIFICATIONS : "source_message_id (SET NULL)"
    LIBRARIAN_CONVERSATIONS ||--o{ LIBRARIAN_UPDATES : "follow-up deliveries (cascade)"
    DOMAIN_EVENTS ||--o{ LIBRARIAN_UPDATES : "UNIQUE per conversation (cascade)"
    LIBRARIAN_MESSAGES |o--o{ LIBRARIAN_UPDATES : "delivered card message (SET NULL)"

    LIBRARIAN_OPERATIONS {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        text segment_id FK "NOT NULL -> librarian_segments"
        text turn_id "NULL; no FK"
        text card_id "NULL; no FK"
        text idempotency_key "NOT NULL; the tool call operationKey"
        text kind "NOT NULL"
        text request_digest "canonical JSON of the validated body minus the key"
        jsonb target "NOT NULL"
        text status "admitted|succeeded|refused|failed|unknown"
        jsonb result "NULL; the stored receipt"
        text error_code "required when refused or failed"
        timestamptz created_at
        timestamptz settled_at "NULL"
    }

    LIBRARIAN_CARDS {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        text segment_id FK "NOT NULL -> librarian_segments"
        text message_id FK "NULL -> librarian_messages SET NULL"
        text kind "statement_proposal|confirmation|memory_suggestion"
        text status "pending|accepted|rejected|expired|superseded|cleared_by_reset"
        jsonb target "NOT NULL; exact target ids"
        text target_revision "NULL; task revision, head SHA, HITL revision"
        jsonb payload "NOT NULL"
        text payload_digest "NOT NULL"
        boolean requires_owner "NOT NULL"
        timestamptz expires_at "NOT NULL; confirmation TTL"
        timestamptz decided_at "NULL"
        timestamptz created_at
    }

    LIBRARIAN_TASK_LINKS {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        text task_id FK "NOT NULL -> tasks CASCADE"
        text meaning "created_from|refined_in|mentioned"
        text from_message_id FK "NULL -> librarian_messages SET NULL"
        text to_message_id FK "NULL -> librarian_messages SET NULL"
        integer statement_revision "NULL"
        timestamptz created_at
    }

    LIBRARIAN_UPDATES {
        text id PK
        text conversation_id FK "NOT NULL -> librarian_conversations CASCADE"
        bigint domain_event_id FK "NOT NULL -> domain_events CASCADE"
        text task_id "NULL; no FK"
        text run_id "NULL; no FK"
        text kind "NOT NULL; the domain event kind"
        text status "pending|delivered|skipped_no_access|failed"
        integer attempts "NOT NULL DEFAULT 0; at most 5"
        text message_id FK "NULL -> librarian_messages SET NULL"
        text last_error_code "required when failed"
        timestamptz created_at
        timestamptz delivered_at "NULL"
    }

    TASK_STATEMENT_REVISIONS {
        text task_id PK "-> tasks CASCADE"
        integer revision PK
        jsonb statement "NOT NULL"
        text author_actor_type "NOT NULL"
        text author_actor_id "NULL"
        text via_operation_id "NULL; no FK"
        timestamptz created_at
    }

    TASKS {
        integer revision "NOT NULL DEFAULT 0; +1 per content write"
        integer statement_revision "NULL; accepted revision in tasks.prompt"
        text launch_intent "NULL|none|triage_only|triage_then_launch"
        text created_via_operation_id "NULL; UNIQUE"
    }

    TASK_COMMENTS {
        text via_operation_id "NULL; UNIQUE"
    }

    TASK_CLARIFICATIONS {
        text origin_kind "agent_run|user"
        text requester_user_id "NULL; required for user origin"
        text recipient_user_id "NULL; required for user origin"
        text reason "NULL"
        text answer_format "NULL|text|choice|yes_no"
        boolean blocking "DEFAULT false"
        text status "open|answered|cancelled|superseded"
        text cancel_reason "required when cancelled"
        text superseded_by_clarification_id "NULL; no FK"
        text source_message_id FK "NULL -> librarian_messages SET NULL"
        text requested_via_operation_id "NULL; UNIQUE"
    }

    DOMAIN_EVENTS {
        bigint id PK "identity"
        text kind "+ task.clarification_requested, task.clarification_cancelled"
    }

    RUNS {
        text librarian_operation_id "NULL; UNIQUE"
    }
```

## Memory and summaries

Personal memory belongs to the user, not to the conversation; summaries belong
to a segment and are fenced by the conversation's generations. Read it for what
survives a reset and what a forget removes.

```mermaid
erDiagram
    USERS ||--o{ LIBRARIAN_MEMORY_ITEMS : "owner (cascade)"
    PROJECTS |o--o{ LIBRARIAN_MEMORY_ITEMS : "project-scoped item (cascade)"
    LIBRARIAN_MEMORY_ITEMS ||--o{ LIBRARIAN_MEMORY_ITEM_REVISIONS : "edit history (cascade)"
    USERS ||--o{ LIBRARIAN_MEMORY_TOMBSTONES : "forgotten digests (cascade)"
    LIBRARIAN_SEGMENTS ||--o{ LIBRARIAN_SEGMENT_SUMMARIES : "fenced revisions (cascade)"

    LIBRARIAN_MEMORY_ITEMS {
        text id PK
        text user_id FK "NOT NULL -> users CASCADE"
        text kind "preference|goal|commitment|fact"
        text content "NOT NULL; changes only with a new revision"
        text scope "general|project"
        text project_id FK "NULL -> projects CASCADE"
        jsonb source_refs "DEFAULT []"
        text[] source_project_ids "re-checked on every use"
        text origin "explicit|accepted_suggestion"
        timestamptz valid_until "NULL"
        integer revision "DEFAULT 1"
        timestamptz forgotten_at "NULL; forget"
        timestamptz created_at
        timestamptz updated_at
    }

    LIBRARIAN_MEMORY_ITEM_REVISIONS {
        text item_id PK "-> librarian_memory_items CASCADE"
        integer revision PK
        text content "NOT NULL"
        timestamptz created_at
    }

    LIBRARIAN_MEMORY_TOMBSTONES {
        text user_id PK "-> users CASCADE"
        text content_digest PK
        timestamptz created_at
    }

    LIBRARIAN_SEGMENT_SUMMARIES {
        text id PK
        text segment_id FK "NOT NULL -> librarian_segments CASCADE"
        integer revision "UNIQUE per segment"
        bigint from_seq "NOT NULL"
        bigint to_seq "NOT NULL"
        jsonb content "NOT NULL"
        text[] source_project_ids "re-checked on every use"
        integer forget_generation "write fence"
        integer history_generation "write fence"
        timestamptz invalidated_at "NULL; queued for rebuild"
        timestamptz created_at
    }
```

## Keys and unique constraints

| Constraint | Table | Columns | Why |
| --- | --- | --- | --- |
| `librarian_conversations_user_uq` | `librarian_conversations` | `(user_id)` | exactly one conversation per user (`LCV-01`) |
| `librarian_conversations_run_uq` | `librarian_conversations` | `(run_id)` | one conversation per librarian run |
| `librarian_segments_ordinal_uq` | `librarian_segments` | `(conversation_id, ordinal)` | segment order |
| `librarian_messages_seq_uq` | `librarian_messages` | `(conversation_id, seq)` | the transcript order and the stream's replay cursor |
| `librarian_messages_client_id_uq` | `librarian_messages` | `(conversation_id, client_message_id)` WHERE NOT NULL | a resent client message returns the stored one (`LCV-02`) |
| `librarian_turns_one_active_uq` | `librarian_turns` | `(conversation_id)` WHERE `status IN ('admitted','running')` | at most one active turn (`LCV-03`) |
| `librarian_operations_key_uq` | `librarian_operations` | `(conversation_id, idempotency_key)` | idempotency (`LOP-02`) |
| `librarian_updates_event_uq` | `librarian_updates` | `(conversation_id, domain_event_id)` | one update per event under at-least-once dispatch (`LOP-11`) |
| `librarian_segment_summaries_revision_uq` | `librarian_segment_summaries` | `(segment_id, revision)` | summary revisions |
| PK | `task_statement_revisions` | `(task_id, revision)` | one row per accepted revision |
| PK | `librarian_memory_item_revisions` | `(item_id, revision)` | one row per edit |
| PK | `librarian_memory_tombstones` | `(user_id, content_digest)` | forget is idempotent |
| `tasks_created_via_operation_uq` · `task_comments_via_operation_uq` · `task_clarifications_requested_via_operation_uq` · `runs_librarian_operation_uq` | result tables | the operation id | a racing retry returns the existing result; reconcile is a lookup |

## Checks and triggers

| Name | Table | Rule |
| --- | --- | --- |
| `project_tokens_kind_check` | `project_tokens` | `token_kind IN ('project','user','agent','librarian')` |
| `project_tokens_librarian_check` | `project_tokens` | a librarian token has an owner, a turn and an expiry, and no project or agent |
| `runs_run_kind_check` | `runs` | `run_kind IN ('flow','scratch','agent','librarian')` |
| `runs_librarian_shape_check` | `runs` | a librarian run has no project or task, is `persistent`, has a creator and `agent_workspace='none'` |
| `librarian_turns_running_has_snapshot_check` | `librarian_turns` | a `running` turn has a context snapshot (`LCV-07`) |
| `librarian_turns_failed_has_reason_check` | `librarian_turns` | a `failed` turn has a reason |
| `librarian_operations_terminal_shape_check` | `librarian_operations` | `refused` / `failed` carry `error_code` |
| `librarian_updates_failed_has_error_check` | `librarian_updates` | `failed` carries `last_error_code` |
| `task_clarifications_origin_shape_check` | `task_clarifications` | agent-run rows keep their source ids; user rows have none, name requester and recipient, and `retrigger_mode='none'` |
| `task_clarifications_status_shape_check` | `task_clarifications` | `answered` iff answered and not superseded; `superseded` iff `superseded_at`; `cancelled` needs a reason |
| `task_clarifications_supersession_check` | `task_clarifications` | re-derived: exactly one of HITL, run or clarification successor |
| trigger `task_statement_revisions_immutable` | `task_statement_revisions` | refuses UPDATE and DELETE, except the cascade of a task delete |
| trigger `librarian_memory_items_content_immutable` | `librarian_memory_items` | content changes only together with the next revision |
| trigger `guard_agent_turn_source` (re-derived) | `agent_turns` | `requested_by_user_id` only on a message variant, immutable except the FK's `SET NULL` |

## Regular indexes

| Index | Table | Columns | Serves |
| --- | --- | --- | --- |
| `project_tokens_librarian_turn_idx` | `project_tokens` | `(librarian_turn_id)` | turn-end revocation and the turn FK cascade |
| `token_audit_librarian_turn_idx` | `token_audit_log` | `(librarian_turn_id)` | a turn's project set for source masking |
| `librarian_messages_body_tsv_idx` | `librarian_messages` | GIN `(body_tsv)` | history search |
| `librarian_operations_segment_digest_idx` | `librarian_operations` | `(segment_id, request_digest)` | the same-digest duplicate guard |
| `librarian_cards_pending_idx` | `librarian_cards` | `(conversation_id)` WHERE `status='pending'` | pending cards, expiry and reset clearing |
| `librarian_task_links_task_idx` | `librarian_task_links` | `(task_id)` | the conversations a task came from |
| `librarian_memory_items_user_active_idx` | `librarian_memory_items` | `(user_id)` WHERE `forgotten_at IS NULL` | active memory for the composer |

## Cascade chain

Deleting a user removes their conversation — segments, messages, turns (and
with them context snapshots and turn tokens with their audit rows),
operations, cards, task links and updates — plus their memory items, item
revisions and tombstones. The conversation's `runs` row is not under that
cascade: the reference points from the conversation to the run, and admin
hard-delete is refused for any user a run or a token still names.

Deleting a task removes its statement revisions and its librarian task links;
the conversation keeps its messages. Deleting a project removes its
project-scoped memory items and cascades its domain events, and with them the
librarian updates that referenced them; delivered update messages stay in the
conversation and render their target as unavailable. A clear history deletes messages, summaries, snapshots and cards,
and the `SET NULL` references clear on turns, links, updates and
`task_clarifications.source_message_id`; operations, links, statements and the
token audit are kept.

## Why result columns carry no FK

`tasks.created_via_operation_id`, `task_comments.via_operation_id`,
`task_clarifications.requested_via_operation_id` and
`runs.librarian_operation_id` are unique and nullable but reference nothing. The
operation ledger is the owner's private record and goes with the owner's
conversation, while the task, comment, clarification or run it produced is
project data that must outlive it unchanged — an FK would make a user deletion
rewrite project rows. The unique is what the protocol needs: a retry that races
the first attempt hits it and reads the existing result, and reconciling an
`admitted` or `unknown` operation is a lookup on the column.

## Linked artifacts

- [ADR-183](../decisions.md#adr-183) · [ADR-184](../decisions.md#adr-184) ·
  [ADR-185](../decisions.md#adr-185) · [ADR-186](../decisions.md#adr-186) ·
  [ADR-187](../decisions.md#adr-187) · [ADR-188](../decisions.md#adr-188)
- [`../database-schema.md`](../database-schema.md) — exact DDL
- [`../api/async/librarian-stream.asyncapi.yaml`](../api/async/librarian-stream.asyncapi.yaml) — the stream over `librarian_messages.seq`
- [`runs-domain.md`](runs-domain.md) · [`hitl-domain.md`](hitl-domain.md) ·
  [`projects-domain.md`](projects-domain.md) ·
  [`integrations-domain.md`](integrations-domain.md) ·
  [`domain-events.md`](domain-events.md) — the shared tables
