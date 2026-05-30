# Full database ERD

All 13 tables in one diagram (M9 added `USERS`, `ACCOUNTS`, `SESSIONS`,
`VERIFICATION_TOKENS`, `PROJECT_MEMBERS`).
For partial views by domain, see
[`projects-domain.md`](projects-domain.md), [`runs-domain.md`](runs-domain.md),
[`hitl-domain.md`](hitl-domain.md).

```mermaid
erDiagram
    USERS ||--o{ ACCOUNTS : "oauth links"
    USERS ||--o{ SESSIONS : "active sessions"
    USERS ||--o{ PROJECT_MEMBERS : "project roles"

    PROJECTS ||--o{ PROJECT_MEMBERS : "members"
    PROJECTS ||--o{ EXECUTORS : has
    PROJECTS ||--o{ FLOWS : has
    PROJECTS ||--o{ TASKS : has
    PROJECTS ||--o{ RUNS : has
    PROJECTS ||--o{ WORKSPACES : has

    TASKS ||--o{ RUNS : "attempt N+1"
    FLOWS ||--o{ RUNS : "selected at launch"
    EXECUTORS ||--o{ RUNS : "spawned by"
    EXECUTORS ||--o{ TASKS : "optional override"
    FLOWS ||--o{ TASKS : "selected at create"

    RUNS ||--|| WORKSPACES : "one worktree per run"
    RUNS ||--o{ STEP_RUNS : "per-step record"
    RUNS ||--o{ HITL_REQUESTS : raises

    USERS {
        text id PK
        text name
        text email UK
        timestamp email_verified
        text image
        text password_hash
        text role "admin|member|viewer"
        text account_status "pending|active|disabled"
        timestamp account_status_updated_at
        text account_status_updated_by
        boolean must_change_password
        timestamp created_at
    }

    ACCOUNTS {
        text user_id FK
        text provider "PK part"
        text provider_account_id "PK part"
        text type
        text refresh_token
        text access_token
        integer expires_at
    }

    SESSIONS {
        text session_token PK
        text user_id FK
        timestamp expires
    }

    VERIFICATION_TOKENS {
        text identifier "PK part"
        text token "PK part"
        timestamp expires
    }

    PROJECT_MEMBERS {
        text id PK
        text project_id FK
        text user_id FK
        text role "owner|admin|member|viewer"
        timestamp created_at
    }

    PROJECTS {
        text id PK
        text slug UK
        text name
        text repo_path UK
        text main_branch "current column; product default_branch"
        text branch_prefix
        text maister_yaml_path
        text default_executor_id
        timestamp created_at
        timestamp archived_at
    }

    EXECUTORS {
        text id PK
        text project_id FK
        text executor_ref_id "UNIQUE per project"
        text agent "claude or codex"
        text model
        jsonb env "env-router vars"
        text router "ccr or null"
        timestamp created_at
    }

    FLOWS {
        text id PK
        text project_id FK
        text flow_ref_id "UNIQUE per project"
        text source "git URL"
        text version "tag"
        text revision "git SHA; mutable current pointer"
        text installed_path "current pointer; runs use flow_revision"
        jsonb manifest "parsed flow.yaml"
        integer schema_version
        text recommended_executor_id
        text executor_override_id FK
        timestamp created_at
    }

    TASKS {
        text id PK
        text project_id FK
        text title
        text prompt
        text flow_id FK
        text executor_override_id FK
        text status "Backlog|InFlight|Done|Abandoned"
        text stage "Backlog|Prepare"
        integer attempt_number "monotonic per task"
        timestamp created_at
        timestamp updated_at
    }

    RUNS {
        text id PK
        text task_id FK
        text project_id FK
        text flow_id FK
        text executor_id FK
        text status "Pending..Done"
        text acp_session_id "resume handle"
        text current_step_id "runner cursor"
        text flow_version "snapshot at launch"
        text flow_revision "snapshot at launch"
        timestamp checkpoint_at
        timestamp keepalive_until "30min sliding"
        timestamp started_at
        timestamp ended_at
    }

    WORKSPACES {
        text id PK
        text run_id FK
        text project_id FK
        text branch
        text worktree_path UK
        text parent_repo_path
        timestamp created_at
        timestamp removed_at
    }

    STEP_RUNS {
        text id PK
        text run_id FK
        text step_id "matches flow.yaml steps[].id"
        text step_type "cli|agent|guard|human"
        text mode "new-session|slash-in-existing (agent)"
        integer attempt "DEFAULT 1"
        text status "Pending..NeedsInput"
        text acp_session_id
        text stdout "truncated to 1 MiB"
        jsonb vars "DEFAULT {}"
        integer exit_code
        text error_code "MaisterErrorCode literal"
        timestamp started_at
        timestamp ended_at
    }

    HITL_REQUESTS {
        text id PK
        text run_id FK
        text step_id
        text kind "permission|form|human"
        jsonb schema "form_schema for form|human"
        text prompt
        jsonb response
        timestamp responded_at
        timestamp created_at
    }
```

## Planned roadmap extensions

The current ERD intentionally shows only implemented tables. Roadmap M10-M18
adds additive persistence for Flow package revisions and project enablement,
graph node attempts, artifacts and artifact edges, gate results, assignments,
capability records, API tokens, external operation events, and branch promotion
metadata. See [`../database-schema.md#planned-roadmap-persistence`](../database-schema.md#planned-roadmap-persistence).

## Indexes

| Table | Index | Columns | Purpose |
| ----- | ----- | ------- | ------- |
| `users` | implicit | `email` UNIQUE | Auth lookup by email. |
| `users` | `users_account_status_idx` | `(account_status)` | Admin approval queue and status filtering. |
| `accounts` | implicit PK | `(provider, provider_account_id)` | Auth.js adapter dedup. |
| `sessions` | implicit PK | `session_token` | Session lookup. |
| `verification_tokens` | implicit PK | `(identifier, token)` | Token lookup. |
| `project_members` | `project_members_project_user_uq` | `(project_id, user_id)` UNIQUE | One membership per user/project. |
| `project_members` | `project_members_user_idx` | `(user_id)` | Per-user project listing / authz. |
| `tasks` | `tasks_project_status_idx` | `(project_id, status)` | Board queries. |
| `tasks` | `tasks_id_attempt_uq` | `(id, attempt_number)` UNIQUE | Vacuous today (PK already covers `id`); the designed per-attempt guard is `UNIQUE (task_id, attempt_number)` on `runs`. |
| `runs` | `runs_project_status_idx` | `(project_id, status)` | Portfolio + per-project queries. |
| `runs` | `runs_task_idx` | `(task_id)` | Latest-attempt lookups. |
| `step_runs` | `step_runs_run_idx` | `(run_id)` | Per-run step lookups. |
| `hitl_requests` | `hitl_requests_run_idx` | `(run_id)` | Pending HITL panel. |
| `projects` | implicit | `slug`, `repo_path` UNIQUE | Registration collisions. |
| `executors` | `executors_project_ref_uq` | `(project_id, executor_ref_id)` UNIQUE | Per-project namespace. |
| `flows` | `flows_project_ref_uq` | `(project_id, flow_ref_id)` UNIQUE | Per-project namespace. |
| `workspaces` | implicit | `worktree_path` UNIQUE | Globally unique worktree path. |

Source: `web/lib/db/schema.ts`.
