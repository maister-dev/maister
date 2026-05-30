# Full database ERD

All implemented tables in one diagram (M9 added `USERS`, `ACCOUNTS`, `SESSIONS`,
`VERIFICATION_TOKENS`, `PROJECT_MEMBERS`), plus the two **M11a — Designed**
execution-ledger tables `NODE_ATTEMPTS` and `GATE_RESULTS` (migration `0008`;
Phase 7 flips them to Implemented).
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
    RUNS ||--o{ STEP_RUNS : "per-step record (legacy)"
    RUNS ||--o{ NODE_ATTEMPTS : "per-node attempt (M11a)"
    RUNS ||--o{ GATE_RESULTS : "per-run gates (M11a)"
    NODE_ATTEMPTS ||--o{ GATE_RESULTS : "gate verdicts (M11a)"
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
        text repo_url "nullable; ADR-025"
        text provider "nullable; ADR-025"
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

    NODE_ATTEMPTS {
        text id PK
        text run_id FK
        text node_id "node id in compiled FlowGraph"
        text node_type "ai_coding|cli|check|judge|human"
        integer attempt "auto-increment per (run,node)"
        text status "Pending|Running|Succeeded|Failed|NeedsInput|Reworked|Stale"
        text decision
        text workspace_policy "keep|rewind-to-node-checkpoint|fresh-attempt"
        text rework_from_node
        text acp_session_id
        text stdout "truncated to 1 MiB"
        jsonb vars "DEFAULT {}"
        integer exit_code
        text error_code
        timestamp started_at
        timestamp ended_at
    }

    GATE_RESULTS {
        text id PK
        text run_id FK
        text node_attempt_id FK
        text gate_id
        text kind "command_check|skill_check|ai_judgment|artifact_required|external_check|human_review"
        text mode "blocking|advisory"
        text status "pending|running|passed|failed|stale|skipped|overridden"
        jsonb verdict "verdict|confidence|reasons|recommendedAction"
        jsonb input_artifact_refs
        text output_artifact_ref
        jsonb stale_from
        text overridden_by
        timestamp created_at
        timestamp ended_at
    }

    HITL_REQUESTS {
        text id PK
        text run_id FK
        text step_id
        text kind "permission|form|human"
        jsonb schema "form_schema (+ review allow-list for human_review)"
        text prompt
        jsonb response
        text decision "M11a review decision"
        text workspace_policy "M11a rework policy"
        text rework_target "M11a resolved rework target"
        timestamp responded_at
        timestamp created_at
    }
```

## Planned roadmap extensions

The ERD shows implemented tables plus the M11a-Designed `node_attempts` /
`gate_results` (migration `0008`). The remaining roadmap M12-M18 additive
persistence — artifacts and artifact edges, assignments, capability records, API
tokens, external operation events, and branch promotion metadata — is not drawn
until its migrations exist. See [`../database-schema.md#planned-roadmap-persistence`](../database-schema.md#planned-roadmap-persistence).

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
| `node_attempts` | `node_attempts_run_step_attempt_uq` | `(run_id, node_id, attempt)` UNIQUE | **(M11a)** Append-only ledger uniqueness. |
| `node_attempts` | `node_attempts_run_idx` | `(run_id)` | **(M11a)** Templating highest-attempt union. |
| `gate_results` | `gate_results_run_idx` | `(run_id)` | **(M11a)** Per-run gate lookups. |
| `gate_results` | `gate_results_node_attempt_idx` | `(node_attempt_id)` | **(M11a)** Gates for a node attempt. |
| `hitl_requests` | `hitl_requests_run_idx` | `(run_id)` | Pending HITL panel. |
| `projects` | implicit | `slug`, `repo_path` UNIQUE | Registration collisions. |
| `executors` | `executors_project_ref_uq` | `(project_id, executor_ref_id)` UNIQUE | Per-project namespace. |
| `flows` | `flows_project_ref_uq` | `(project_id, flow_ref_id)` UNIQUE | Per-project namespace. |
| `workspaces` | implicit | `worktree_path` UNIQUE | Globally unique worktree path. |

Source: `web/lib/db/schema.ts`.
