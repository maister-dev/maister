# Full database ERD

All implemented tables in one diagram (M9 added `USERS`, `ACCOUNTS`, `SESSIONS`,
`VERIFICATION_TOKENS`, `PROJECT_MEMBERS`), the two **M11a (Implemented)**
execution-ledger tables `NODE_ATTEMPTS` and `GATE_RESULTS` (migration `0010`),
**M11b (migration `0011`, additive)** takeover columns and `HumanWorking`
status, scratch-run persistence, the selectable capability catalog, and the
**M12 (Implemented, migration `0015`)** typed-evidence tables `ARTIFACT_INSTANCES`
and `ARTIFACT_PROJECTION_CURSORS`, and **M13 (Implemented, migration `0018`)**
assignment tables. For partial views by domain, see
[`projects-domain.md`](projects-domain.md), [`runs-domain.md`](runs-domain.md),
[`hitl-domain.md`](hitl-domain.md), [`artifacts-domain.md`](artifacts-domain.md),
and [`assignments-domain.md`](assignments-domain.md).

```mermaid
erDiagram
    USERS ||--o{ ACCOUNTS : "oauth links"
    USERS ||--o{ SESSIONS : "active sessions"
    USERS ||--o{ PROJECT_MEMBERS : "project roles"

    PROJECTS ||--o{ PROJECT_MEMBERS : "members"
    PROJECTS ||--o{ EXECUTORS : has
    PROJECTS ||--o{ FLOWS : has
    PROJECTS ||--o{ CAPABILITY_RECORDS : has
    PROJECTS ||--o{ PROJECT_FLOW_ROLES : "flow routing labels"
    PROJECTS ||--o{ ACTOR_IDENTITIES : "actor attribution"
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
    USERS ||--o{ NODE_ATTEMPTS : "takeover owner (M11b, SET NULL)"
    RUNS ||--o{ GATE_RESULTS : "per-run gates (M11a)"
    NODE_ATTEMPTS ||--o{ GATE_RESULTS : "gate verdicts (M11a)"
    RUNS ||--o{ ARTIFACT_INSTANCES : "evidence index (M12)"
    NODE_ATTEMPTS ||--o{ ARTIFACT_INSTANCES : "attempt evidence (M12, nullable)"
    RUNS ||--o| ARTIFACT_PROJECTION_CURSORS : "projector cursor (M12)"
    ARTIFACT_INSTANCES ||--o| ARTIFACT_INSTANCES : "superseded_by (M12, SET NULL)"
    RUNS ||--o{ HITL_REQUESTS : raises
    RUNS ||--o{ ASSIGNMENTS : "work queue (M13)"
    HITL_REQUESTS ||--o| ASSIGNMENTS : "linked wait (M13)"
    NODE_ATTEMPTS ||--o{ ASSIGNMENTS : "optional attempt (M13)"
    TASKS ||--o{ ASSIGNMENTS : "optional task (M13)"
    ARTIFACT_INSTANCES ||--o{ ASSIGNMENTS : "evidence pointer (M13)"
    ACTOR_IDENTITIES ||--o{ ASSIGNMENTS : "assignee/creator/completer"
    ASSIGNMENTS ||--o{ ASSIGNMENT_EVENTS : "lifecycle events"
    ACTOR_IDENTITIES ||--o{ ASSIGNMENT_EVENTS : "event actor"
    RUNS ||--o| SCRATCH_RUNS : "scratch metadata"
    TASKS ||--o{ SCRATCH_RUNS : "optional link"
    USERS ||--o{ SCRATCH_RUNS : "created by"
    SCRATCH_RUNS ||--o{ SCRATCH_MESSAGES : "dialog ledger"
    SCRATCH_RUNS ||--o{ SCRATCH_ATTACHMENTS : "run attachments"
    SCRATCH_MESSAGES ||--o{ SCRATCH_ATTACHMENTS : "message attachments"
    SCRATCH_RUNS ||--|| SCRATCH_CAPABILITY_PROFILES : "launch snapshot"

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

    CAPABILITY_RECORDS {
        text id PK
        text project_id FK
        text capability_ref_id "UNIQUE per project/source/kind"
        text kind "mcp|skill|rule|setting|restriction|tool|agent_definition|env_profile"
        text label
        text source "platform|project|flow-package"
        text version
        text revision
        jsonb agents
        text enforceability "enforced|instructed|unsupported"
        boolean selected_by_default
        boolean selectable
        jsonb material
        timestamp disabled_at
        timestamp created_at
        timestamp updated_at
    }

    PROJECT_FLOW_ROLES {
        text id PK
        text project_id FK
        text role_ref "UNIQUE per project"
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
        text run_kind "flow|scratch (DEFAULT flow)"
        text task_id FK "nullable for scratch"
        text project_id FK
        text flow_id FK "nullable for scratch"
        text executor_id FK
        text status "Pending..Done"
        text acp_session_id "resume handle"
        text current_step_id "runner cursor"
        text flow_version "snapshot or scratch sentinel"
        text flow_revision "snapshot or manual sentinel"
        text flow_revision_id FK "nullable for scratch"
        text created_by_user_id FK "nullable launch/audit owner"
        timestamp checkpoint_at
        timestamp keepalive_until "30min sliding"
        timestamp resume_started_at "Recover in-flight marker + reconcile grace anchor (M19)"
        text resume_target_step_id "node id retained at crash time for Recover (M19, 0016)"
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
        timestamp scheduled_removal_at "GC prune deadline (M19)"
        text archived_branch "preserved archive ref name (M19)"
        timestamp archived_at "when archive branch created (M19)"
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
        text owner_user_id FK "M11b 0011 takeover owner (users.id SET NULL)"
        text base_ref "M11b 0011 merge-base SHA for returned range"
        text returned_commits "M11b 0011 raw git log base..branch"
        text returned_diff "M11b 0011 raw git diff base..branch"
        jsonb enforcement_snapshot "M11c 0013 append-only verdict audit"
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

    ARTIFACT_INSTANCES {
        text id PK "deterministic — see artifacts-domain.md"
        text run_id FK "NOT NULL → runs(id) ON DELETE CASCADE"
        text node_attempt_id FK "NULL → node_attempts(id) ON DELETE CASCADE"
        text node_id "denormalized logical node id (nullable)"
        integer attempt "denormalized attempt number (nullable)"
        text artifact_def_id "manifest output id; NULL for defaults/projector"
        text kind "diff|log|test_report|lint_report|ai_judgment|human_note|commit_set|checkpoint|preview|generic_file"
        text producer "runner|projector|takeover|gate|human"
        jsonb locator "discriminated union — server-written only"
        text uri "optional human/direct display ref"
        text hash "content hash when cheap"
        integer size_bytes "nullable"
        text validity "current|stale|superseded|failed|skipped DEFAULT current"
        jsonb required_for "(review|merge)[] — declared, not enforced until M14"
        text visibility "internal|shared DEFAULT internal"
        text retention "run|ephemeral DEFAULT run"
        integer monotonic_id "projector event id; NULL for runner-inline"
        text superseded_by_id FK "NULL → artifact_instances(id) ON DELETE SET NULL"
        timestamptz created_at "DEFAULT now()"
    }

    ARTIFACT_PROJECTION_CURSORS {
        text id PK "= run_id (one cursor per run)"
        text run_id FK "NOT NULL → runs(id) ON DELETE CASCADE"
        text scope "run — one row per run"
        text events_log_path "run.events.jsonl path"
        integer last_monotonic_id "DEFAULT 0; run-global"
        text status "idle|running|caught_up|failed DEFAULT idle"
        timestamptz updated_at "DEFAULT now()"
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

    ASSIGNMENTS {
        text id PK
        text project_id FK
        text run_id FK
        text task_id FK
        text node_id
        text step_id
        text hitl_request_id FK
        text node_attempt_id FK
        text action_kind "permission|form|human_review|manual_takeover|merge_conflict"
        text status "open|claimed|completed|cancelled"
        jsonb role_refs
        text title
        text assignee_actor_id FK
        text created_by_actor_id FK
        text completed_by_actor_id FK
        text evidence_artifact_id FK
        text branch
        text ref
        integer sla_hours
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
        text event_kind "created|claimed|released|taken_over|responded|returned|completed|cancelled|superseded|system_closed"
        text actor_id FK
        text from_status
        text to_status
        jsonb payload
        timestamp created_at
    }

    SCRATCH_RUNS {
        text run_id PK
        text project_id FK
        text name
        text initial_prompt
        text work_mode "auto|plan_first|manual_approval"
        text reasoning_effort "low|high|extra|ultra"
        text plan_mode "off|plan-first"
        text linked_task_id FK
        text linked_issue_url
        text base_branch
        text base_commit
        text target_branch
        text dialog_status "Starting|WaitingForUser|Running|NeedsInput|Review|Crashed|Done|Abandoned"
        text supervisor_session_id
        text error_code
        text error_message
        jsonb error_metadata
        text created_by_user_id FK
        timestamp last_user_message_at
        timestamp last_agent_message_at
        timestamp created_at
        timestamp updated_at
    }

    SCRATCH_MESSAGES {
        text id PK
        text run_id FK
        integer sequence "UNIQUE per run"
        text role "user|assistant|tool|system"
        text content
        text supervisor_event_id
        timestamp created_at
    }

    SCRATCH_ATTACHMENTS {
        text id PK
        text run_id FK
        text message_id FK
        text kind "issue_url|file_path|text_note|uploaded_file"
        text label
        text value "metadata value or rootless artifact ref"
        text file_name
        text mime_type
        integer byte_size
        text sha256
        text storage_path "server-local path, never public DTO"
        timestamp created_at
    }

    SCRATCH_CAPABILITY_PROFILES {
        text id PK
        text run_id FK
        text profile_digest
        text materialized_path
        jsonb selected_mcp_ids
        jsonb selected_skill_ids
        jsonb selected_rule_ids
        jsonb restrictions
        jsonb adapter_launch
        jsonb downgrade_notes
        timestamp created_at
    }
```

## Planned roadmap extensions

The ERD shows implemented tables, M11a `node_attempts` / `gate_results`
(migration `0010`), scratch-run persistence, `capability_records`, and the
M12 (Implemented, migration `0015`) `artifact_instances` /
`artifact_projection_cursors` typed-evidence tables (see
[`artifacts-domain.md`](artifacts-domain.md)) and M13 assignment persistence
(see [`assignments-domain.md`](assignments-domain.md)). The remaining roadmap
additive persistence — artifact edges, API tokens, and external operation
events — is not drawn until its migrations exist. See
[`../database-schema.md#planned-roadmap-persistence`](../database-schema.md#planned-roadmap-persistence).

## Indexes

| Table                 | Index                                   | Columns                                | Purpose                                                                                                                 |
| --------------------- | --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `users`               | implicit                                | `email` UNIQUE                         | Auth lookup by email.                                                                                                   |
| `users`               | `users_account_status_idx`              | `(account_status)`                     | Admin approval queue and status filtering.                                                                              |
| `accounts`            | implicit PK                             | `(provider, provider_account_id)`      | Auth.js adapter dedup.                                                                                                  |
| `sessions`            | implicit PK                             | `session_token`                        | Session lookup.                                                                                                         |
| `verification_tokens` | implicit PK                             | `(identifier, token)`                  | Token lookup.                                                                                                           |
| `project_members`     | `project_members_project_user_uq`       | `(project_id, user_id)` UNIQUE         | One membership per user/project.                                                                                        |
| `project_members`     | `project_members_user_idx`              | `(user_id)`                            | Per-user project listing / authz.                                                                                       |
| `capability_records`  | `capability_records_project_kind_idx`   | `(project_id, kind, selectable)`       | Scratch launch-options catalog lookup.                                                                                  |
| `project_flow_roles`  | `project_flow_roles_project_key_uq`     | `(project_id, role_ref)` UNIQUE        | One Flow role ref per project.                                                                                          |
| `project_flow_roles`  | `project_flow_roles_project_idx`        | `(project_id)`                         | Project Flow role lookup.                                                                                               |
| `actor_identities`    | `actor_identities_project_user_uq`      | `(project_id, user_id)` UNIQUE         | One user actor per project.                                                                                             |
| `actor_identities`    | `actor_identities_project_idx`          | `(project_id)`                         | Project actor lookup.                                                                                                   |
| `tasks`               | `tasks_project_status_idx`              | `(project_id, status)`                 | Board queries.                                                                                                          |
| `tasks`               | `tasks_id_attempt_uq`                   | `(id, attempt_number)` UNIQUE          | Vacuous today (PK already covers `id`); the designed per-attempt guard is `UNIQUE (task_id, attempt_number)` on `runs`. |
| `runs`                | `runs_project_status_idx`               | `(project_id, status)`                 | Portfolio + per-project queries.                                                                                        |
| `runs`                | `runs_task_idx`                         | `(task_id)`                            | Latest-attempt lookups.                                                                                                 |
| `runs`                | `runs_project_status_kind_idx`          | `(project_id, status, run_kind)`       | Active workspace queries across Flow and scratch runs.                                                                  |
| `runs`                | `runs_kind_task_idx`                    | `(run_kind, task_id)`                  | Board/latest-attempt lookups that explicitly exclude scratch runs.                                                      |
| `scratch_runs`        | `scratch_runs_project_status_idx`       | `(project_id, dialog_status)`          | Project scratch workspace lists.                                                                                        |
| `scratch_attachments` | `scratch_attachments_run_idx`           | `(run_id)`                             | Run-level attachment lookup.                                                                                            |
| `scratch_attachments` | `scratch_attachments_message_idx`       | `(message_id)`                         | Message attachment lookup.                                                                                              |
| `step_runs`           | `step_runs_run_idx`                     | `(run_id)`                             | Per-run step lookups.                                                                                                   |
| `node_attempts`       | `node_attempts_run_step_attempt_uq`     | `(run_id, node_id, attempt)` UNIQUE    | **(M11a)** Append-only ledger uniqueness.                                                                               |
| `node_attempts`       | `node_attempts_run_idx`                 | `(run_id)`                             | **(M11a)** Templating highest-attempt union.                                                                            |
| `gate_results`        | `gate_results_run_idx`                  | `(run_id)`                             | **(M11a)** Per-run gate lookups.                                                                                        |
| `gate_results`        | `gate_results_node_attempt_idx`         | `(node_attempt_id)`                    | **(M11a)** Gates for a node attempt.                                                                                    |
| `hitl_requests`       | `hitl_requests_run_idx`                 | `(run_id)`                             | Pending HITL panel.                                                                                                     |
| `assignments`         | `assignments_hitl_request_uq`           | `(hitl_request_id)` UNIQUE             | One assignment per linked HITL wait.                                                                                    |
| `assignments`         | `assignments_project_status_idx`        | `(project_id, status)`                 | Project work queue.                                                                                                     |
| `assignments`         | `assignments_run_status_idx`            | `(run_id, status)`                     | Run-detail work queue.                                                                                                  |
| `assignments`         | `assignments_current_actor_idx`         | `(assignee_actor_id)`                  | Actor-owned work lookup.                                                                                                |
| `assignments`         | `assignments_hitl_request_idx`          | `(hitl_request_id)`                    | HITL lookup.                                                                                                            |
| `assignment_events`   | `assignment_events_assignment_idx`      | `(assignment_id)`                      | Assignment event history.                                                                                               |
| `assignment_events`   | `assignment_events_project_created_idx` | `(project_id, created_at)`             | Project audit stream.                                                                                                   |
| `projects`            | implicit                                | `slug`, `repo_path` UNIQUE             | Registration collisions.                                                                                                |
| `executors`           | `executors_project_ref_uq`              | `(project_id, executor_ref_id)` UNIQUE | Per-project namespace.                                                                                                  |
| `flows`               | `flows_project_ref_uq`                  | `(project_id, flow_ref_id)` UNIQUE     | Per-project namespace.                                                                                                  |
| `workspaces`          | implicit                                | `worktree_path` UNIQUE                 | Globally unique worktree path.                                                                                          |

Source: `web/lib/db/schema.ts`.
