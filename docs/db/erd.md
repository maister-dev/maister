# Full database ERD

All 8 tables in one diagram. For partial views by domain, see
[`projects-domain.md`](projects-domain.md), [`runs-domain.md`](runs-domain.md),
[`hitl-domain.md`](hitl-domain.md).

```mermaid
erDiagram
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
    RUNS ||--o{ STEP_RUNS : "per-step record (M5)"
    RUNS ||--o{ HITL_REQUESTS : raises

    PROJECTS {
        text id PK
        text slug UK
        text name
        text repo_path UK
        text main_branch
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
        text installed_path
        jsonb manifest "parsed flow.yaml"
        integer schema_version
        text recommended_executor_id
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
        text current_step_id "M5 runner cursor"
        text flow_version "snapshot at launch"
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

## Indexes

| Table | Index | Columns | Purpose |
| ----- | ----- | ------- | ------- |
| `tasks` | `tasks_project_status_idx` | `(project_id, status)` | Board queries. |
| `tasks` | `tasks_id_attempt_uq` | `(id, attempt_number)` UNIQUE | Guard against duplicate attempts. |
| `runs` | `runs_project_status_idx` | `(project_id, status)` | Portfolio + per-project queries. |
| `runs` | `runs_task_idx` | `(task_id)` | Latest-attempt lookups. |
| `hitl_requests` | `hitl_requests_run_idx` | `(run_id)` | Pending HITL panel. |
| `projects` | implicit | `slug`, `repo_path` UNIQUE | Registration collisions. |
| `executors` | `executors_project_ref_uq` | `(project_id, executor_ref_id)` UNIQUE | Per-project namespace. |
| `flows` | `flows_project_ref_uq` | `(project_id, flow_ref_id)` UNIQUE | Per-project namespace. |
| `workspaces` | implicit | `worktree_path` UNIQUE | Globally unique worktree path. |

Source: `web/lib/db/schema.ts`.
