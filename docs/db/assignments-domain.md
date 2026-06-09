# Assignments Domain

M13 introduces a work-ownership layer over existing HITL and manual takeover
flows. The database tables are implemented in migration `0018`; runtime
assignment creation, claim/release/take-over APIs, board/run-detail surfaces,
and run-detail assignment ledger history are wired for the implemented wait
classes.

Flow roles are routing labels. They do not authorize users. Authorization stays
with `project_members.role` and `requireProjectAction()`.

```mermaid
erDiagram
    PROJECTS ||--o{ PROJECT_FLOW_ROLES : "flow routing labels"
    PROJECTS ||--o{ ACTOR_IDENTITIES : "actor attribution"
    PROJECTS ||--o{ ASSIGNMENTS : "work queue"
    PROJECTS ||--o{ ASSIGNMENT_EVENTS : "assignment audit"

    USERS ||--o{ ACTOR_IDENTITIES : "optional user actor"
    TASKS ||--o{ ASSIGNMENTS : "optional task"
    RUNS ||--o{ ASSIGNMENTS : "run waits"
    HITL_REQUESTS ||--o| ASSIGNMENTS : "one linked wait"
    NODE_ATTEMPTS ||--o{ ASSIGNMENTS : "optional graph attempt"
    ARTIFACT_INSTANCES ||--o{ ASSIGNMENTS : "evidence pointer"

    ACTOR_IDENTITIES ||--o{ ASSIGNMENTS : "assignee"
    ACTOR_IDENTITIES ||--o{ ASSIGNMENT_EVENTS : "event actor"
    ASSIGNMENTS ||--o{ ASSIGNMENT_EVENTS : "lifecycle"

    PROJECT_FLOW_ROLES {
        text id PK
        text project_id FK
        text role_ref UK
        text label
        text description
        text source "config|flow|system"
        timestamp archived_at
        timestamp created_at
        timestamp updated_at
    }

    ACTOR_IDENTITIES {
        text id PK
        text project_id FK
        text kind "user|api_token|internal_agent|system"
        text label
        text user_id FK
        text token_id
        text internal_agent_ref
        text system_key
        timestamp disabled_at
        timestamp created_at
        timestamp updated_at
    }

    ASSIGNMENTS {
        text id PK
        text project_id FK
        text run_id FK
        text task_id FK
        text node_id
        text step_id
        text hitl_request_id FK
        text node_attempt_id FK
        text action_kind
        text status
        jsonb role_refs
        text title
        text assignee_actor_id FK
        text created_by_actor_id FK
        text completed_by_actor_id FK
        text evidence_artifact_id FK
        text branch
        text ref
        int sla_hours
        jsonb stale_evidence_summary
        timestamp claimed_at
        timestamp completed_at
        timestamp created_at
        timestamp updated_at
    }

    ASSIGNMENT_EVENTS {
        text id PK
        text assignment_id FK
        text project_id FK
        text run_id FK
        text event_kind
        text actor_id FK
        text from_status
        text to_status
        jsonb payload
        timestamp created_at
    }
```

## Invariants

- `actor_identities` is attribution, not authentication. M13 writes only
  `kind = "user"` from Auth.js-backed API/UI actions. API-token and internal
  actors are schema-supported for future ingress and read-only historical data.
- **(M17 — Implemented, migration `0026`; expanded by migration `0031`.)**
  A partial UNIQUE on `(project_id, token_id) WHERE kind = 'api_token'` gives
  exactly one api-token actor per `(project, token)`, backing the
  `ensureApiTokenActor` upsert that M17's HITL-over-MCP path uses for
  attribution. The `(project_id, user_id)` uniqueness is partial to
  `kind = 'user'`, so user-owned API-token actors can keep owner `user_id`
  attribution without colliding with the owner human actor.
- One `(project_id, role_ref)` row represents a Flow role. Removing the role
  from `maister.yaml` sets `archived_at`; re-adding the same ref reactivates the
  row.
- `assignments.status` never drives scheduler caps. `runs.status` remains the
  lifecycle and concurrency source of truth.
- Assignment lifecycle changes append exactly one `assignment_events` row in
  the same transaction as the implemented state change.
- `hitl_request_id` is UNIQUE when present, so one HITL wait maps to one
  assignment row.

## Indexes

| Table                | Index                                   | Columns                         | Purpose                       |
| -------------------- | --------------------------------------- | ------------------------------- | ----------------------------- |
| `project_flow_roles` | `project_flow_roles_project_key_uq`     | `(project_id, role_ref)` UNIQUE | One role ref per project.     |
| `project_flow_roles` | `project_flow_roles_project_idx`        | `(project_id)`                  | Project registry lookup.      |
| `actor_identities`   | `actor_identities_project_user_uq`      | `(project_id, user_id)` UNIQUE, PARTIAL `WHERE kind='user'` | One human actor per project/user. |
| `actor_identities`   | `actor_identities_project_token_uq`     | `(project_id, token_id)` UNIQUE, PARTIAL `WHERE kind='api_token'` | **(M17 — Implemented, `0026`)** One api-token actor per (project, token). |
| `actor_identities`   | `actor_identities_project_idx`          | `(project_id)`                  | Project actor lookup.         |
| `assignments`        | `assignments_hitl_request_uq`           | `(hitl_request_id)` UNIQUE      | One assignment per HITL wait. |
| `assignments`        | `assignments_project_status_idx`        | `(project_id, status)`          | Project work queue.           |
| `assignments`        | `assignments_run_status_idx`            | `(run_id, status)`              | Run-detail work queue.        |
| `assignments`        | `assignments_current_actor_idx`         | `(assignee_actor_id)`           | Actor-owned work lookup.      |
| `assignments`        | `assignments_hitl_request_idx`          | `(hitl_request_id)`             | HITL lookup.                  |
| `assignment_events`  | `assignment_events_assignment_idx`      | `(assignment_id)`               | Event history.                |
| `assignment_events`  | `assignment_events_project_created_idx` | `(project_id, created_at)`      | Project audit stream.         |

Source: `web/lib/db/schema.ts`.
