# Full database ERD

All implemented tables in one diagram (M9 added `USERS`, `ACCOUNTS`, `SESSIONS`,
`VERIFICATION_TOKENS`, `PROJECT_MEMBERS`), the two **M11a (Implemented)**
execution-ledger tables `NODE_ATTEMPTS` and `GATE_RESULTS` (migration `0010`),
**M11b (migration `0011`, additive)** takeover columns and `HumanWorking`
status, scratch-run persistence, the selectable capability catalog, the
**M12 (Implemented, migration `0015`)** typed-evidence tables `ARTIFACT_INSTANCES`
and `ARTIFACT_PROJECTION_CURSORS`, **M13 (Implemented, migration `0018`)**
assignment tables, the **M14 (Implemented, migration `0019`)**
`CAPABILITY_IMPORTS` table and `NODE_ATTEMPTS.materialization_plan` jsonb
column, the **M16 (Implemented, migration `0020_m16_api_tokens.sql`)**
integrations tables `PROJECT_TOKENS` and `TOKEN_AUDIT_LOG`, the **M27 workbench
(Implemented, migration `0032`)** lifecycle claim fields on `WORKSPACES`, and
the **M27 Flow Studio (Implemented, migrations `0033+`)** schema deltas:
`FLOWS.version_binding`, `FLOW_REVISIONS.exec_trust`,
`AUTHORED_CAPABILITIES.source_flow_ref_id`, `RUNS.resolved_capability_set`, and
the new `PLATFORM_MCP_SERVERS` table, the **M28 (Implemented, migration
`0038`)** `RUN_SCHEDULES` table for user-facing cron schedules, the
**ADR-072 (Implemented, migration `0039`)** `REVIEW_COMMENTS`
review-thread table, the **(Implemented, migration `0040`)**
outbound-webhook tables `WEBHOOK_SUBSCRIPTIONS`, `WEBHOOK_EVENTS`,
`WEBHOOK_DELIVERIES`, `WEBHOOK_DELIVERY_ATTEMPTS` plus the
`PLATFORM_RUNTIME_SETTINGS.webhooks_enabled` column (ADR-077), and the
**ADR-083 (Implemented, migration `0043`)** social-board tables `TASK_RELATIONS`,
`TASK_COMMENTS`, `TASK_ACTIVITY`, `TASK_SUBSCRIBERS`, `INBOX_ITEMS` plus
`PROJECTS.task_key` / `PROJECTS.next_task_number` / `TASKS.number`, and the
**ADR-085 (Designed, migration `0047`)** delivery-policy and cost-rollup
projection fields/tables (`PROJECTS.delivery_policy_default`,
`RUNS.delivery_policy_snapshot`, `RUN_COST_ROLLUPS`,
`NODE_ATTEMPT_COST_ROLLUPS`). For partial views by domain, see
[`projects-domain.md`](projects-domain.md),
[`runs-domain.md`](runs-domain.md), [`hitl-domain.md`](hitl-domain.md),
[`artifacts-domain.md`](artifacts-domain.md),
[`assignments-domain.md`](assignments-domain.md),
[`capabilities-domain.md`](capabilities-domain.md),
[`integrations-domain.md`](integrations-domain.md), and
[`webhooks.md`](webhooks.md).

```mermaid
erDiagram
    USERS ||--o{ ACCOUNTS : "oauth links"
    USERS ||--o{ SESSIONS : "active sessions"
    USERS ||--o{ PROJECT_MEMBERS : "project roles"

    PROJECTS ||--o{ PROJECT_MEMBERS : "members"
    PLATFORM_ROUTER_SIDECARS ||--o{ PLATFORM_ACP_RUNNERS : "optional sidecar"
    PLATFORM_ACP_RUNNERS ||--|| PLATFORM_RUNTIME_SETTINGS : "default runner"
    PLATFORM_ACP_RUNNERS ||--o{ PROJECTS : "default override"
    PLATFORM_ACP_RUNNERS ||--o{ PROJECT_FLOW_RUNNER_DEFAULTS : "flow binding"
    PROJECTS ||--o{ FLOWS : has
    FLOWS ||--o{ FLOW_REVISIONS : "revisions (M10)"
    PROJECTS ||--o{ CAPABILITY_RECORDS : has
    PROJECTS ||--o{ CAPABILITY_IMPORTS : "git-pinned imports (M14)"
    PACKAGE_SOURCES ||--o{ PACKAGE_INSTALLS : "installed from (ADR-088 Implemented)"
    PACKAGE_INSTALLS ||--o{ PROJECT_PACKAGE_ATTACHMENTS : "attached (ADR-088 Implemented)"
    PROJECTS ||--o{ PROJECT_PACKAGE_ATTACHMENTS : "package enablement (ADR-088 Implemented)"
    PACKAGE_INSTALLS ||--o{ FLOWS : "group FK (ADR-088 Implemented)"
    PACKAGE_INSTALLS ||--o{ CAPABILITY_IMPORTS : "group FK (ADR-088 Implemented)"
    PROJECTS ||--o{ AUTHORED_CAPABILITIES : "authored catalog (M25)"
    PROJECTS ||--o{ SCHEDULER_JOBS : "optional scheduler scope (M24)"
    PROJECTS ||--o{ AGENT_SCHEDULES : "agent trigger bindings (M34)"
    AGENTS ||--o{ AGENT_SCHEDULES : "cron + event bindings (M34)"
    AGENTS ||--o{ AGENT_PROJECT_LINKS : "attachments (M34)"
    PROJECTS ||--o{ AGENT_PROJECT_LINKS : "attached agents (M34)"
    PLATFORM_ACP_RUNNERS ||--o{ AGENTS : "agent default runner (M34, SET NULL)"
    PLATFORM_ACP_RUNNERS ||--o{ AGENT_PROJECT_LINKS : "runner override (M34, SET NULL)"
    AGENTS ||--o{ RUNS : "agent runs (M34, SET NULL)"
    AGENTS ||--o{ PROJECT_TOKENS : "ephemeral agent tokens (M34)"
    PROJECTS ||--o{ RUN_SCHEDULES : "run schedules (M28)"
    PROJECTS ||--o{ PROJECT_FLOW_ROLES : "flow routing labels"
    PROJECTS ||--o{ ACTOR_IDENTITIES : "actor attribution"
    PROJECTS ||--o{ TASKS : has
    PROJECTS ||--o{ RUNS : has
    PROJECTS ||--o{ WORKSPACES : has

    TASKS ||--o{ RUNS : "attempt N+1"
    FLOWS ||--o{ RUNS : "selected at launch"
    FLOWS ||--o{ TASKS : "selected at create or triage (M34: flow_id nullable)"
    PLATFORM_ACP_RUNNERS ||--o{ TASKS : "triage runner verdict (M34, SET NULL)"
    FLOWS ||--o{ PROJECT_FLOW_RUNNER_DEFAULTS : "runner default"

    RUNS ||--|| WORKSPACES : "one worktree per run"
    RUNS ||--o{ RUNS : "run-tree delegation (parent_run_id, M37)"
    USERS ||--o{ WORKSPACES : "promotion owner (M18, nullable)"
    RUNS ||--o{ STEP_RUNS : "per-step record (legacy)"
    RUNS ||--|{ RUN_SESSIONS : "per-session runner state (M42 Implemented)"
    PLATFORM_ACP_RUNNERS ||--o{ RUN_SESSIONS : "session runner (M42 Implemented, SET NULL)"
    RUNS ||--o{ NODE_ATTEMPTS : "per-node attempt (M11a)"
    RUNS ||--o| RUN_COST_ROLLUPS : "derived token rollup (ADR-085)"
    USERS ||--o{ NODE_ATTEMPTS : "takeover owner (M11b, SET NULL)"
    RUNS ||--o{ GATE_RESULTS : "per-run gates (M11a)"
    NODE_ATTEMPTS ||--o{ GATE_RESULTS : "gate verdicts (M11a)"
    NODE_ATTEMPTS ||--o{ NODE_ATTEMPT_COST_ROLLUPS : "derived token rollup (ADR-085)"
    RUNS ||--o{ ARTIFACT_INSTANCES : "evidence index (M12)"
    NODE_ATTEMPTS ||--o{ ARTIFACT_INSTANCES : "attempt evidence (M12, nullable)"
    RUNS ||--o| ARTIFACT_PROJECTION_CURSORS : "projector cursor (M12)"
    ARTIFACT_INSTANCES ||--o| ARTIFACT_INSTANCES : "superseded_by (M12, SET NULL)"
    RUNS ||--o{ HITL_REQUESTS : raises
    RUNS ||--o{ REVIEW_COMMENTS : "review threads (ADR-072)"
    HITL_REQUESTS ||--o{ REVIEW_COMMENTS : "authoring gate visit (ADR-072)"
    USERS ||--o{ REVIEW_COMMENTS : "author / resolver (SET NULL)"
    REVIEW_COMMENTS ||--o{ REVIEW_COMMENTS : "replies (parent_id, cascade)"
    RUNS ||--o{ GATE_CHAT_MESSAGES : "gate-chat turns (ADR-078)"
    HITL_REQUESTS ||--o{ GATE_CHAT_MESSAGES : "pause of authoring (ADR-078)"
    USERS ||--o{ GATE_CHAT_MESSAGES : "author (SET NULL)"
    RUNS ||--o{ ASSIGNMENTS : "work queue (M13)"
    HITL_REQUESTS ||--o| ASSIGNMENTS : "linked wait (M13)"
    NODE_ATTEMPTS ||--o{ ASSIGNMENTS : "optional attempt (M13)"
    TASKS ||--o{ ASSIGNMENTS : "optional task (M13)"
    ARTIFACT_INSTANCES ||--o{ ASSIGNMENTS : "evidence pointer (M13)"
    ACTOR_IDENTITIES ||--o{ ASSIGNMENTS : "assignee/creator/completer"
    ASSIGNMENTS ||--o{ ASSIGNMENT_EVENTS : "lifecycle events"
    ACTOR_IDENTITIES ||--o{ ASSIGNMENT_EVENTS : "event actor"
    PROJECTS ||--o{ TASK_RELATIONS : "owns (ADR-075)"
    PROJECTS ||--o{ TASK_COMMENTS : "owns (ADR-075)"
    PROJECTS ||--o{ TASK_ACTIVITY : "owns (ADR-075)"
    PROJECTS ||--o{ INBOX_ITEMS : "owns (ADR-075)"
    TASKS ||--o{ TASK_RELATIONS : "from-end (ADR-075)"
    TASKS ||--o{ TASK_RELATIONS : "to-end (ADR-075)"
    TASKS ||--o{ TASK_COMMENTS : "discussion (ADR-075)"
    TASKS ||--o{ TASK_ACTIVITY : "event log (ADR-075)"
    TASKS ||--o{ TASK_SUBSCRIBERS : "subscriber set (ADR-075)"
    TASKS ||--o{ INBOX_ITEMS : "inbox fanout (ADR-075)"
    RUNS ||--o| SCRATCH_RUNS : "scratch metadata"
    TASKS ||--o{ SCRATCH_RUNS : "optional link"
    USERS ||--o{ SCRATCH_RUNS : "created by"
    SCRATCH_RUNS ||--o{ SCRATCH_MESSAGES : "dialog ledger"
    SCRATCH_RUNS ||--o{ SCRATCH_ATTACHMENTS : "run attachments"
    SCRATCH_MESSAGES ||--o{ SCRATCH_ATTACHMENTS : "message attachments"
    SCRATCH_RUNS ||--|| SCRATCH_CAPABILITY_PROFILES : "launch snapshot"

    PROJECTS o|--o{ PROJECT_TOKENS : "optional project binding (M16/0063)"
    PROJECTS o|--o{ TOKEN_AUDIT_LOG : "optional audit target (M16/0063)"
    USERS ||--o{ PROJECT_TOKENS : "created_by SET NULL (M16)"
    PROJECT_TOKENS ||--o{ TOKEN_AUDIT_LOG : "per-call audit (M16)"
    CAPABILITY_RECORDS ||--o{ AUTHORED_CAPABILITIES : "projected via material.origin"
    AUTHORED_CAPABILITIES ||--o{ AUTHORED_CAPABILITY_REVISIONS : "revision history"
    SCHEDULER_JOBS ||--o{ SCHEDULER_JOB_RUNS : "attempt ledger"
    TASKS ||--o{ RUN_SCHEDULES : "target task (M28)"
    RUNS ||--o{ RUN_SCHEDULES : "last run SET NULL (M28)"
    PLATFORM_ACP_RUNNERS ||--o{ RUN_SCHEDULES : "runner override SET NULL (M28)"
    USERS ||--o{ RUN_SCHEDULES : "created_by SET NULL (M28)"

    PROJECTS ||--o{ WEBHOOK_SUBSCRIPTIONS : "project-scoped (nullable)"
    PROJECTS ||--o{ WEBHOOK_EVENTS : "emitted per project"
    RUNS ||--o{ WEBHOOK_EVENTS : "emitted per run"
    WEBHOOK_EVENTS ||--o{ WEBHOOK_DELIVERIES : "fanned out to"
    WEBHOOK_SUBSCRIPTIONS ||--o{ WEBHOOK_DELIVERIES : "delivered via (cascade)"
    WEBHOOK_DELIVERIES ||--o{ WEBHOOK_DELIVERY_ATTEMPTS : "attempt audit (cascade)"

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
        text created_by
        timestamp updated_at
        text updated_by
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
        text added_by
        timestamp updated_at
        text updated_by
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
        text default_runner_id "platform runner override"
        text promotion_mode "M18 0021 project-default local_merge|pull_request; override-chain source (§3.4)"
        jsonb delivery_policy_default "ADR-085 Designed: strategy/push/trigger/targetBranch"
        jsonb execution_policy_default "migration 0055: default execution policy {preset,overrides}, nullable"
        jsonb task_queue_settings "ADR-121 (0087): {edgeDrain?,maxInFlightAuto?}, nullable (NULL = env defaults)"
        text task_key UK "ADR-075 Implemented: platform-wide unique, immutable Stage 1"
        integer next_task_number "ADR-075 Implemented: allocation counter, DEFAULT 1"
        timestamp created_at
        timestamp archived_at
    }

    PLATFORM_ROUTER_SIDECARS {
        text id PK
        text kind "ccr"
        text lifecycle "managed|external"
        text command_preset
        text config_path
        text base_url
        text healthcheck_url
        text auth_token_ref
        text readiness_status
        jsonb readiness_reasons
        boolean enabled
        timestamp created_at
        timestamp updated_at
    }

    PLATFORM_ACP_RUNNERS {
        text id PK
        text adapter "claude|codex"
        text capability_agent "claude|codex"
        text model
        jsonb provider
        text permission_policy
        text sidecar_id FK
        text readiness_status
        jsonb readiness_reasons
        boolean enabled
        timestamp created_at
        timestamp updated_at
    }

    PLATFORM_RUNTIME_SETTINGS {
        text id PK
        text default_runner_id FK
        boolean webhooks_enabled "NOT NULL DEFAULT true"
        timestamp updated_at
    }

    PLATFORM_MCP_SERVERS {
        text id PK
        text transport "stdio|sse|http"
        text command "nullable; stdio only"
        jsonb args "DEFAULT []"
        jsonb env_keys "env:NAME refs only; DEFAULT []"
        text url "nullable; sse|http only"
        jsonb header_keys "env:NAME refs only; DEFAULT []"
        jsonb supported_agents "DEFAULT [claude,codex,gemini,opencode,mimo]"
        text trust_status "untrusted|trusted|trusted_by_policy (DEFAULT untrusted)"
        text readiness_status "Unknown|Ready|NotReady (DEFAULT Unknown)"
        jsonb readiness_reasons "DEFAULT []"
        boolean enabled "DEFAULT true"
        timestamp created_at
        timestamp updated_at
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
        text version_binding "M27 Designed: pinned|latest (DEFAULT latest)"
        timestamp created_at
    }

    FLOW_REVISIONS {
        text id PK
        text flow_ref_id FK "links to flows.flow_ref_id"
        text source "git URL"
        text version_label "user-facing tag pin"
        text resolved_revision "40-hex git SHA; immutable cache key"
        text manifest_digest "sha256 of canonical manifest JSON"
        jsonb manifest "snapshot the runner reads"
        integer schema_version
        text installed_path
        text setup_status "not_required|pending|done|failed"
        text package_status "Discovered|Installing|Installed|Failed|Removed"
        text exec_trust "M27 Designed: untrusted|trusted (DEFAULT untrusted); gates setup.sh + MCP stdio spawn"
        timestamp installed_at
    }

    PROJECT_FLOW_RUNNER_DEFAULTS {
        text id PK
        text project_id FK
        text flow_id FK
        text runner_id FK
        timestamp created_at
        timestamp updated_at
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

    CAPABILITY_IMPORTS {
        text id PK "uuid v4"
        text project_id FK "NOT NULL → projects(id) ON DELETE CASCADE"
        text capability_ref_id "id from maister.yaml capability_imports[]; SAFE_PATH_SEGMENT"
        text source "git URL (SAFE_PATH_SEGMENT validated)"
        text version_tag "tag pin (SAFE_PATH_SEGMENT validated)"
        text resolved_revision "40-hex git SHA; immutable cache key"
        text manifest_digest "sha256 of canonical manifest JSON"
        jsonb manifest "parsed capability manifest (nullable)"
        text installed_path "~/.maister/capabilities/<id>@<sha12>/"
        text setup_status "not_required|pending|done|failed"
        text package_status "Discovered|Installing|Installed|Failed|Removed"
        text trust_status "untrusted|trusted|trusted_by_policy"
        timestamp created_at
        timestamp updated_at
    }

    PACKAGE_SOURCES {
        text id PK "ADR-088 Implemented"
        text url UK "git monorepo URL"
        boolean enabled "DEFAULT true"
        jsonb discovered "cached name+tags snapshot; DEFAULT []"
        timestamp last_checked_at "nullable"
    }

    PACKAGE_INSTALLS {
        text id PK "ADR-088 Implemented"
        text source_url
        text name "package name"
        text version_label "raw tag or local-digest12"
        text resolved_revision "tag SHA or content digest"
        jsonb manifest "parsed maister-package.yaml + inventory"
        text installed_path
        text package_status "Installing|Installed|Failed|Removed"
        text trust_status "untrusted|trusted|trusted_by_policy"
    }

    PROJECT_PACKAGE_ATTACHMENTS {
        text id PK "ADR-088 Implemented"
        text project_id FK "ON DELETE CASCADE"
        text package_install_id FK "ON DELETE RESTRICT"
        text package_name "denormalized; UNIQUE with project_id"
        timestamp attached_at
    }

    AUTHORED_CAPABILITIES {
        text id PK
        text project_id FK
        text kind "rule|skill|flow"
        text slug "UNIQUE per project/kind"
        text title
        text lifecycle "DRAFT|PUBLISHED|ARCHIVED"
        integer draft_version
        text current_draft_revision_id
        text current_published_revision_id
        text source_flow_ref_id "M27 Designed: nullable; links edited installed flow to its flows.flow_ref_id"
        timestamp archived_at
        timestamp created_at
        timestamp updated_at
    }

    AUTHORED_CAPABILITY_REVISIONS {
        text id PK
        text capability_id FK
        text project_id FK
        text kind "rule|skill|flow"
        integer revision_number
        text lifecycle "DRAFT|PUBLISHED|ARCHIVED"
        integer draft_version
        text title
        jsonb body
        jsonb manifest
        integer schema_version
        text content_hash
        timestamp created_at
        timestamp published_at
        timestamp archived_at
    }

    SCHEDULER_JOBS {
        text id PK
        text project_id FK
        text job_kind "system_sweep|command|agent_tick|flow_run|run_schedule|webhook_delivery|domain_event_dispatch|auto_launch_triaged"
        jsonb target
        integer cadence_interval_seconds
        timestamp next_run_at
        timestamp last_fired_at
        timestamp lease_expires_at
        timestamp disabled_at
        integer consecutive_failures
        integer max_failures
        timestamp created_at
        timestamp updated_at
    }

    SCHEDULER_JOB_RUNS {
        text id PK
        text job_id FK
        text job_kind
        text status "Claimed|Running|Succeeded|Failed|Skipped"
        timestamp claimed_at
        timestamp started_at
        timestamp lease_expires_at
        timestamp finished_at
        jsonb summary
        text error_code
        text error_message
        timestamp created_at
        timestamp updated_at
    }

    AGENTS {
        text id PK "M34 rework: package-qualified flowRefId:stem"
        text flow_ref_id "providing package (ADR-089 rework)"
        text version_label "newest registered revision"
        text origin "git|authored"
        text name
        text description
        text runner_id FK "platform_acp_runners(id) SET NULL"
        text workspace "none|repo_read|worktree (ADR-090)"
        text workspace_ref "nullable — trigger|branch (repo_read only)"
        text mode "session|subagent"
        jsonb triggers "subset of manual|cron|domain_event|webhook|flow"
        jsonb capability_profile "M14 shape, nullable"
        text risk_tier "read_only|standard|destructive"
        jsonb recommended "nullable — attach pre-fill"
        jsonb config_schema "NULL — declared typed config-param schema (Implemented ADR-111, 0071)"
        text source_path "agents/stem.md in the newest revision"
        boolean enabled
        timestamp quarantined_at "nullable — ADR-090 dirty-watchdog"
        text quarantine_reason "nullable"
        timestamp created_at
        timestamp updated_at
    }

    AGENT_PROJECT_LINKS {
        text id PK "M34"
        text agent_id FK "agents(id) CASCADE"
        text project_id FK "projects(id) CASCADE"
        boolean enabled
        text runner_override_id FK "platform_acp_runners(id) SET NULL"
        jsonb config "NULL — per-instance config values; NULL ⇒ declared defaults (Implemented ADR-111, 0071)"
        timestamp created_at
        timestamp updated_at
    }

    AGENT_SCHEDULES {
        text id PK "M34 rework — M24 shape was dead code"
        text agent_id FK "agents(id) CASCADE — was text agent_ref"
        text project_id FK
        text trigger_type "cron|event"
        text cron_expr "cron rows: 5-field, croner-validated"
        text timezone "cron rows: IANA"
        timestamp next_fire_at "cron rows: atomic-claim key"
        timestamp last_fired_at
        jsonb event_match "event rows: kinds subset of ADR-086 taxonomy"
        boolean enabled
        timestamp created_at
        timestamp updated_at
    }

    RUN_SCHEDULES {
        text id PK
        text project_id FK "projects(id) CASCADE (M28)"
        text task_id FK "tasks(id) CASCADE"
        text name
        text cron_expr "5-field, croner-validated"
        text timezone "IANA, validated"
        text overlap_policy "skip|queue_one|start_anyway"
        text runner_id FK "platform_acp_runners(id) SET NULL"
        boolean enabled
        timestamp next_fire_at "precomputed by the cron wrapper"
        boolean queue_one_pending "non-stacking catch-up flag"
        timestamp queued_fire_at
        timestamp last_fired_at
        text last_fire_outcome "launched|queued_pending|catchup_queued|skipped_task_busy|skipped_cap|skipped_target_terminal|skipped_crashed|launch_failed|dispatching"
        text last_fire_error "CODE: message, max 500 chars"
        text last_run_id FK "runs(id) SET NULL"
        text created_by_user_id FK "users(id) SET NULL"
        timestamp created_at
        timestamp updated_at
    }

    TASKS {
        text id PK
        text project_id FK
        integer number "ADR-075 Implemented: per-project, UNIQUE (project_id, number)"
        text title
        text prompt
        text flow_id FK "M34: NULLABLE — unconfigured until triaged"
        text status "Backlog|InFlight|Done|Abandoned"
        text stage "Backlog|Prepare"
        integer attempt_number "monotonic per task"
        text triage_status "M34: 'triaged' | NULL; += 'flagged' = held/needs-review (Implemented ADR-112; app-level text-enum widening, no DB CHECK / no migration)"
        text runner_id FK "M34: verdict runner, SET NULL"
        text target_branch "M34: verdict branch, nullable"
        text promotion_mode "M34: local_merge|pull_request, nullable"
        text launch_mode "M37: auto|manual nullable — as-plan child task (ADR-098, 0060)"
        jsonb delegation_spec "M37: as-plan delegation spec for run_plan children (ADR-098, 0060)"
        jsonb execution_policy "migration 0055: per-task default execution policy, nullable"
        text priority "ADR-121 (0087): low|normal|high|urgent, NOT NULL default normal, CHECK"
        numeric triage_confidence "ADR-121 (0087): advisory 0..1, nullable, CHECK"
        boolean queue_paused "ADR-121 (0087): operator pause valve, NOT NULL default false"
        timestamp queue_claimed_at "ADR-121 (0087): C2 admission claim, nullable"
        timestamp created_at
        timestamp updated_at
    }

    TASK_RELATIONS {
        text id PK
        text project_id FK
        text from_task_id FK
        text kind "blocks|depends_on|parent_of|requires|duplicate_of (duplicate_of: Implemented ADR-112, 0072, non-blocking)"
        text to_task_id FK
        text actor_type "user|agent|system"
        text actor_id "NULL iff actor_type=system"
        timestamp created_at
    }

    TASK_COMMENTS {
        text id PK
        text task_id FK
        text project_id FK
        text actor_type "user|agent|system"
        text actor_id "NULL iff actor_type=system"
        text body "markdown, mentions stored expanded"
        timestamp created_at
    }

    TASK_ACTIVITY {
        text id PK
        text task_id FK
        text project_id FK
        text actor_type "user|agent|system"
        text actor_id "NULL iff actor_type=system"
        text event_kind "task_created|comment_added|task_mentioned|relation_added|relation_removed|run_launched"
        jsonb payload "DEFAULT {}"
        timestamp created_at
    }

    TASK_SUBSCRIBERS {
        text id PK
        text task_id FK
        text subscriber_type "user|agent"
        text subscriber_id
        text reason "creator|commenter|mentioned|manual"
        timestamp created_at
    }

    INBOX_ITEMS {
        text id PK
        text recipient_type "user|agent"
        text recipient_id
        text project_id FK
        text task_id FK
        text event_kind "comment_added|task_mentioned in Stage 1"
        jsonb source_ref "kind, taskId, commentId, activityId"
        timestamp read_at "NULL = unread"
        timestamp created_at
    }

    RUNS {
        text id PK
        text run_kind "flow|scratch|agent (DEFAULT flow; agent M34)"
        text agent_id FK "M34: agents(id) SET NULL, kind=agent only"
        text trigger_source "M34: manual|cron|domain_event|webhook|flow"
        bigint trigger_event_id "M34: domain_events.id claim key"
        jsonb trigger_payload "M34: webhook/event context, <= 32 KB"
        text task_id FK "nullable for scratch"
        text project_id FK
        text flow_id FK "nullable for scratch"
        text runner_id FK "M42 Implemented (0082): moved to run_sessions.runner_id (FK+index relocated)"
        text runner_resolution_tier "M42 Implemented (0082): moved to run_sessions"
        text capability_agent "M42 Implemented (0082): moved to run_sessions"
        jsonb runner_snapshot "M42 Implemented (0082): moved to run_sessions"
        text parent_run_id FK "M37: runs(id) SET NULL — orchestrator delegator (ADR-098)"
        text root_run_id FK "M37: runs(id) — run-tree root (ADR-098)"
        jsonb delegation_snapshot "M37: {agentDefinitionId,revisionId} (ADR-098, 0060)"
        text launch_mode "M37: auto|manual (ADR-098, 0060)"
        boolean persistent "M37: addressable long-lived child, DEFAULT false (ADR-099, 0060)"
        text addressable_key "M37: star-routing key, unique per tree when persistent (ADR-099, 0060)"
        text workspace_mode "M37: own|shared run-tree worktree, nullable (ADR-099, 0060)"
        text status "Pending..Done"
        text acp_session_id "resume handle; M42 Implemented (0082): moved to run_sessions (per session)"
        text current_step_id "runner cursor"
        text flow_version "snapshot or scratch sentinel"
        text flow_revision "snapshot or manual sentinel"
        text flow_revision_id FK "nullable for scratch"
        text created_by_user_id FK "nullable launch/audit owner"
        timestamp checkpoint_at
        timestamp keepalive_until "30min sliding"
        timestamp resume_started_at "Recover in-flight marker + reconcile grace anchor (M19)"
        timestamp resume_requested_at "ADR-121 (0087): idle HITL answered, awaiting a slot (C3 FIFO key)"
        timestamp queue_admitted_at "ADR-121 (0087): auto-drain origin marker, NULL = manual/scratch/resume"
        text resume_target_step_id "node id retained at crash time for Recover (M19, 0016)"
        jsonb resolved_capability_set "M27 Designed: frozen capability snapshot at launch (flowRevisionId,capabilities,mcps)"
        jsonb delivery_policy_snapshot "ADR-085 Designed: resolved policy at launch"
        jsonb execution_policy "migration 0055: resolved execution policy {preset,overrides} at launch"
        jsonb agent_config "Implemented ADR-111 0071: immutable resolved agent-config snapshot at spawn, nullable"
        timestamp cost_reconciled_at "Implemented ADR-117 0084: durable system_sweep cost-reconcile attempt marker, nullable"
        timestamp started_at
        timestamp ended_at
    }

    RUN_SESSIONS {
        text id PK
        text run_id FK "M42 Implemented: runs(id) CASCADE; UNIQUE(run_id, session_name)"
        text session_name "M42: 'default' (implicit/scratch/agent) | solo | named"
        text runner_id FK "M42: platform_acp_runners(id) SET NULL — FK+index relocated off runs"
        text runner_resolution_tier "M42: winning precedence tier"
        text capability_agent "M42: ADAPTER_IDS"
        jsonb runner_snapshot "M42: frozen launch profile"
        text acp_session_id "M42: per-session ACP session/resume handle"
        text resolution_source "M42: concrete source audit (slot_key | chain scope | launch-dialog)"
        timestamp created_at
        timestamp updated_at
    }

    RUN_COST_ROLLUPS {
        text run_id PK
        text project_id FK
        text task_id FK
        text flow_id FK
        integer input_tokens
        integer output_tokens
        integer cache_read_tokens
        integer cache_creation_tokens
        integer resume_input_tokens
        integer resume_output_tokens
        integer resume_cache_read_tokens
        integer resume_cache_creation_tokens
        jsonb by_model
        jsonb by_runner
        integer source_event_count
        text source_cursor
        timestamp updated_at
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
        text base_branch "M18 0021 run base branch (null pre-M18)"
        text base_commit "M18 0021 base commit forked from (null pre-M18)"
        text target_branch "M18 0021 promotion target branch"
        text promotion_mode "M18 0021 local_merge|pull_request"
        text pr_url "M18 0021 populated on PR-mode promotion"
        integer pr_number "M18 0021"
        timestamp promoted_at "M18 0021"
        text promotion_state "M18 0021 none|claiming|done|failed (NOT NULL DEFAULT none)"
        timestamp promotion_claimed_at "M18 0021 durable-claim timestamp"
        text promotion_owner_user_id FK "M18 0021 users.id, nullable"
        text promotion_attempt_id "M18 0021 per-attempt CAS-identity token"
        text lifecycle_operation_state "M27 0032 none|claiming|failed (NOT NULL DEFAULT none)"
        timestamp lifecycle_operation_claimed_at "M27 0032 durable lifecycle claim timestamp"
        text lifecycle_operation_attempt_id "M27 0032 per-attempt CAS token"
        text lifecycle_operation_name "M27 0032 archive|drop|exportBranch|snapshotCommit|handoffBranch"
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

    NODE_ATTEMPT_COST_ROLLUPS {
        text id PK
        text run_id FK
        text project_id FK
        text node_attempt_id FK
        text node_id
        text model
        integer input_tokens
        integer output_tokens
        integer cache_read_tokens
        integer cache_creation_tokens
        integer resume_input_tokens
        integer resume_output_tokens
        integer resume_cache_read_tokens
        integer resume_cache_creation_tokens
        integer source_event_count
        text source_cursor
        timestamp updated_at
    }

    NODE_ATTEMPTS {
        text id PK
        text run_id FK
        text node_id "node id in compiled FlowGraph"
        text node_type "ai_coding|cli|check|judge|human|guard|form|orchestrator"
        integer attempt "auto-increment per (run,node)"
        text status "Pending|Running|Succeeded|Failed|NeedsInput|Reworked|Stale"
        text decision
        text workspace_policy "keep|rewind-to-node-checkpoint|fresh-attempt"
        text checkpoint_ref "M30 0041: node checkpoint ref, rewind base is the checkpoint parent"
        boolean auto_retry "M30 0041: DEFAULT false; true when this attempt is an auto-retry (retry_policy)"
        text session_policy "M30 0041: effective rework session policy snapshot resume|new_session"
        boolean session_fallback "M30 0041: DEFAULT false; true when resume fell back to new_session"
        text rework_from_node
        text owner_user_id FK "M11b 0011 takeover owner (users.id SET NULL)"
        text base_ref "M11b 0011 merge-base SHA for returned range"
        text returned_commits "M11b 0011 raw git log base..branch"
        text returned_diff "M11b 0011 raw git diff base..branch"
        jsonb enforcement_snapshot "M11c 0013 append-only verdict audit"
        jsonb materialization_plan "M14 0019 Implemented: resolved profile + cleanup substate"
        text acp_session_id
        text stdout "truncated to 1 MiB"
        text resolved_prompt "0053 captured resolved agent prompt; nullable, pre-0053 rows null"
        integer rework_baseline "ADR-118 0086 Implemented: attempt at which current rework epoch began; NULL means 0"
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
        text kind "permission|form|human|infra_recovery|budget_breach|hook_trip"
        jsonb schema "form_schema (+ review allow-list for human_review; ADR-072: + maxLoops/gateAttempt)"
        text prompt
        jsonb response
        text decision "M11a review decision"
        text workspace_policy "M11a rework policy"
        text rework_target "M11a resolved rework target"
        text criticality "M17 Implemented: low|medium|high|critical, write-once"
        real human_confidence "M17 Implemented: responder self-report 0..1"
        text review_tip_sha "M30 0041: branch tip per review visit (since-last-review base)"
        text dirty_resolution "M30 0041: commit|discard|proceed (nullable)"
        timestamp responded_at
        timestamp created_at
    }

    GATE_CHAT_MESSAGES {
        text id PK "randomUUID (ADR-078, migration 0041)"
        text run_id FK "NOT NULL -> runs(id) ON DELETE CASCADE"
        text hitl_request_id FK "NOT NULL -> hitl_requests(id) ON DELETE CASCADE - the pause"
        text node_id "NOT NULL - gate node id"
        integer gate_attempt "NOT NULL - gate visit number"
        text role "NOT NULL - user | agent"
        text author_user_id FK "NULL -> users(id) ON DELETE SET NULL"
        text author_label "snapshot - survives user deletion"
        text body "NOT NULL - turn text"
        text acp_session_id "session that produced/answered (server-only)"
        integer seq "NOT NULL - monotonic per hitl_request_id"
        boolean mutation_reverted "DEFAULT false - L3 reverted a mutation (DD11)"
        timestamp created_at
    }

    REVIEW_COMMENTS {
        text id PK "randomUUID (ADR-072, migration 0039)"
        text run_id FK "NOT NULL -> runs(id) ON DELETE CASCADE"
        text hitl_request_id FK "NOT NULL -> hitl_requests(id) ON DELETE CASCADE"
        text node_id "NOT NULL - review node id"
        integer gate_attempt "NOT NULL - gate visit number (iteration tag)"
        text parent_id FK "NULL = root; -> review_comments(id) ON DELETE CASCADE"
        text author_user_id FK "NULL -> users(id) ON DELETE SET NULL"
        text author_label "snapshot - survives user deletion"
        text file_path "anchor, root only (CHECK: anchor non-null iff parent_id IS NULL)"
        text side "old|new (root only)"
        integer line "1-based on that side (root only)"
        text line_content "server-extracted snapshot (root only)"
        text body "NOT NULL - non-empty, max 10000 chars"
        text status "NOT NULL - open|resolved DEFAULT open (roots only)"
        text resolved_by_user_id FK "NULL -> users(id) ON DELETE SET NULL"
        timestamp resolved_at
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
        text action_kind "permission|form|human_review|manual_takeover|merge_conflict|infra_recovery|budget_breach|hook_trip"
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

    PROJECT_TOKENS {
        text id PK "uuid"
        text project_id FK "NULL for personal user tokens -> projects(id) ON DELETE CASCADE"
        text name "NOT NULL"
        text token_kind "NOT NULL default project — project|user|agent (agent M34)"
        text owner_user_id FK "NULL -> users(id) ON DELETE SET NULL"
        text agent_id FK "M34: NULL -> agents(id) CASCADE; agent tokens only"
        text prefix "NOT NULL, INDEX — first 12 chars of the token string"
        text token_hash "NOT NULL — sha256_hex(fullToken); never plaintext"
        jsonb scopes "NOT NULL default [*] — enforced route scopes"
        text created_by FK "NULL -> users(id) ON DELETE SET NULL"
        timestamp created_at "NOT NULL default now()"
        timestamp last_used_at "nullable"
        timestamp expires_at "nullable"
        timestamp revoked_at "nullable"
    }

    TOKEN_AUDIT_LOG {
        text id PK "uuid"
        text token_id FK "NOT NULL -> project_tokens(id) ON DELETE CASCADE"
        text project_id FK "NULL -> projects(id) ON DELETE SET NULL"
        text actor_label "NOT NULL"
        text scope_used "NOT NULL"
        text endpoint "NOT NULL"
        text method "NOT NULL"
        text result "NOT NULL — ok | error"
        integer status_code "NOT NULL"
        timestamp created_at "NOT NULL default now(), INDEX"
    }

    WEBHOOK_SUBSCRIPTIONS {
        text id PK "server crypto.randomUUID()"
        text project_id FK "NULL -> projects(id); NULL = platform scope"
        text name
        text url "http/https only"
        text method "POST|PUT DEFAULT POST"
        jsonb headers "Record<string,string> DEFAULT {}"
        jsonb event_types "string[] — taxonomy types or *"
        text signing_secret_ref "NOT NULL; env:NAME"
        text secondary_signing_secret_ref "NULL; env:NAME for rotation"
        boolean enabled "NOT NULL DEFAULT true"
        timestamptz created_at
        timestamptz updated_at
    }

    WEBHOOK_EVENTS {
        text id PK
        text project_id FK "NOT NULL -> projects(id)"
        text run_id FK "NOT NULL -> runs(id)"
        text type "taxonomy event type"
        jsonb data "per-type minimal facts"
        jsonb payload "NULL until fanout; full frozen envelope"
        timestamptz occurred_at
        timestamptz fanout_at "NULL = awaiting fanout (fanout cursor)"
        timestamptz created_at
    }

    WEBHOOK_DELIVERIES {
        text id PK
        text event_id FK "NOT NULL -> webhook_events(id) ON DELETE CASCADE"
        text subscription_id FK "NOT NULL -> webhook_subscriptions(id) ON DELETE CASCADE"
        text status "pending|delivered|dead DEFAULT pending"
        integer attempt_count "DEFAULT 0"
        timestamptz next_attempt_at "NOT NULL"
        timestamptz lease_expires_at "NULL"
        text idempotency_key "NOT NULL; hex sha256(subscriptionId:eventId)"
        integer last_http_status "NULL"
        text last_error_kind "NULL; timeout|network|http|config"
        text last_error_message "NULL; <= 1KB"
        timestamptz delivered_at "NULL"
        timestamptz created_at
        timestamptz updated_at
    }

    WEBHOOK_DELIVERY_ATTEMPTS {
        text id PK
        text delivery_id FK "NOT NULL -> webhook_deliveries(id) ON DELETE CASCADE"
        integer attempt_no "UNIQUE with delivery_id"
        timestamptz requested_at
        integer duration_ms
        integer http_status "NULL"
        text error_kind "NULL; timeout|network|http|config"
        text error_detail "NULL; <= 1KB"
        text response_snippet "NULL; <= 1KB"
    }

    PROJECTS ||--o{ DOMAIN_EVENTS : "emitted per project (ADR-086)"
    TASKS o|--o{ DOMAIN_EVENTS : "task-scoped facts (nullable FK)"
    RUNS o|--o{ DOMAIN_EVENTS : "run-scoped facts (nullable FK)"

    DOMAIN_EVENTS {
        bigint id PK "GENERATED ALWAYS AS IDENTITY — dispatch ordering key"
        text kind "8-kind taxonomy CHECK (ADR-086)"
        text project_id FK "NOT NULL -> projects(id) ON DELETE CASCADE"
        text task_id FK "NULL -> tasks(id) ON DELETE CASCADE"
        text run_id FK "NULL -> runs(id) ON DELETE CASCADE"
        text actor_type "NULL; user|system|agent CHECK"
        text actor_id "NULL; polymorphic actor id"
        jsonb payload "NOT NULL; ids/keys/statuses only"
        timestamptz occurred_at
        timestamptz created_at
        xid8 tx_id "DEFAULT pg_current_xact_id(); commit-visibility horizon"
    }

    DOMAIN_EVENT_CONSUMERS {
        text consumer_id PK "code-owned registry id"
        bigint cursor_event_id "NOT NULL DEFAULT 0"
        timestamptz lease_expires_at "NULL; CAS claim lease"
        timestamptz last_dispatched_at "NULL"
        text last_error "NULL"
        integer consecutive_failures "NOT NULL DEFAULT 0"
        timestamptz created_at
        timestamptz updated_at
    }

    PROJECTS ||--o{ BRAIN_ITEMS : "Brain owns (CASCADE, ADR-122)"
    PROJECTS ||--o{ BRAIN_SNAPSHOTS : "recall snapshots (CASCADE)"
    PROJECTS ||--o{ BRAIN_INDEX_JOBS : "reindex jobs (CASCADE)"
    PROJECTS ||--o{ BRAIN_HARVESTED_EVENTS : "harvest ledger (CASCADE)"
    BRAIN_ITEMS ||--o{ BRAIN_EMBEDDINGS : "generations x splits (CASCADE)"
    RUNS o|--o{ BRAIN_SNAPSHOTS : "run-bound recall (CASCADE)"

    BRAIN_ITEMS {
        text id PK "uuid"
        text project_id FK "NOT NULL -> projects(id) CASCADE — auth boundary (Implemented, ADR-122)"
        text kind "lesson|observation|state_fact"
        text tier "owned"
        text content "NOT NULL"
        text status "active|expired|superseded"
        numeric confidence "NOT NULL; CHECK 0..1; confidence0 0.3"
        integer reinforcement_count "NOT NULL DEFAULT 0"
        timestamptz expires_at "NULL for state_fact"
        text content_hash "NOT NULL — dedup"
        text source_run_id FK "NULL -> runs(id) SET NULL"
        bigint source_domain_event_id FK "NULL -> domain_events(id) SET NULL — harvest idempotency"
        tsvector tsv "GENERATED — lexical leg"
        timestamptz created_at
        timestamptz updated_at
    }

    BRAIN_EMBEDDINGS {
        text id PK "uuid"
        text item_id FK "NOT NULL -> brain_items(id) CASCADE"
        integer split_ordinal "NOT NULL DEFAULT 0"
        vector vector "untyped pgvector — cast vector(N) at query"
        text embedding_model "NOT NULL"
        integer embedding_dimensions "NOT NULL"
        text embedding_version "NOT NULL — recorded metadata; generation = (model, dimensions)"
        timestamptz embedded_at "IMMUTABLE"
    }

    BRAIN_SNAPSHOTS {
        text id PK "uuid"
        text project_id FK "NOT NULL -> projects(id) CASCADE (E-1 refinement)"
        text run_id FK "NULL -> runs(id) CASCADE"
        text node_attempt_id FK "NULL -> node_attempts(id) SET NULL"
        text actor_type "user|agent|system"
        text actor_id "NOT NULL"
        text trigger "ambient|explicit"
        jsonb returned_items "NOT NULL — [{itemId, score}]"
        text ranker_version "NOT NULL"
        timestamptz created_at
    }

    BRAIN_INDEX_JOBS {
        text id PK "uuid"
        text project_id FK "NOT NULL -> projects(id) CASCADE"
        text reason "model_switch|manual"
        text status "queued|running|completed|failed"
        jsonb resumable_cursor "NULL"
        timestamptz created_at
    }

    BRAIN_HARVESTED_EVENTS {
        text project_id PK "composite PK; FK -> projects(id) CASCADE (brain migration 0002)"
        bigint domain_event_id PK "composite PK; NO FK — outlives domain_events GC"
        timestamptz harvested_at "NOT NULL DEFAULT now()"
    }
```

## Planned roadmap extensions

The ERD shows implemented tables, M11a `node_attempts` / `gate_results`
(migration `0010`), scratch-run persistence, `capability_records`, and the
M12 (Implemented, migration `0015`) `artifact_instances` /
`artifact_projection_cursors` typed-evidence tables (see
[`artifacts-domain.md`](artifacts-domain.md)), M13 assignment persistence
(see [`assignments-domain.md`](assignments-domain.md)), and the **M14 (Implemented,
migration `0019`)** `capability_imports` table and
`node_attempts.materialization_plan` column (see
[`capabilities-domain.md`](capabilities-domain.md)), and the **M16 (migration
`0020_m16_api_tokens.sql`)** `project_tokens` / `token_audit_log` tables (drawn
above), expanded by `0031_token_actor_scope_support.sql` for user-owned tokens
and enforced scopes, with global personal tokens and nullable audit targets
Implemented by `0076_user_access_tokens.sql`. Remaining roadmap-additive persistence (e.g. artifact edges and
external-operation events) is not drawn until its migrations exist. See
[`../database-schema.md#planned-roadmap-persistence`](../database-schema.md#planned-roadmap-persistence).

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
| `capability_records` | `capability_records_project_kind_idx` | `(project_id, kind, selectable)` | Scratch launch-options catalog lookup. |
| `capability_imports` | `capability_imports_project_ref_revision_uq` | `(project_id, capability_ref_id, resolved_revision)` UNIQUE | **(M14 Implemented)** One row per (project, import id, resolved git SHA). |
| `project_flow_roles` | `project_flow_roles_project_key_uq` | `(project_id, role_ref)` UNIQUE | One Flow role ref per project. |
| `project_flow_roles` | `project_flow_roles_project_idx` | `(project_id)` | Project Flow role lookup. |
| `actor_identities` | `actor_identities_project_user_uq` | `(project_id, user_id)` UNIQUE, PARTIAL `WHERE kind='user'` | One human actor per project/user. |
| `actor_identities` | `actor_identities_project_token_uq` | `(project_id, token_id)` UNIQUE, PARTIAL `WHERE kind='api_token'` | **(M17 Implemented, migration `0026`)** One api-token actor per project token. |
| `actor_identities` | `actor_identities_project_idx` | `(project_id)` | Project actor lookup. |
| `flow_graph_layouts` | — | — | **(Removed — migration `0030`, ADR-064.)** Authored positions moved to the `flow.yaml` `presentation` section. |
| `tasks` | `tasks_project_status_idx` | `(project_id, status)` | Board queries. |
| `tasks` | `tasks_id_attempt_uq` | `(id, attempt_number)` UNIQUE | Vacuous today; the designed per-attempt guard is `UNIQUE (task_id, attempt_number)` on `runs`. |
| `runs` | `runs_project_status_idx` | `(project_id, status)` | Portfolio + per-project queries. |
| `runs` | `runs_task_idx` | `(task_id)` | Latest-attempt lookups. |
| `runs` | `runs_project_status_kind_idx` | `(project_id, status, run_kind)` | Active workspace queries across Flow and scratch runs. |
| `runs` | `runs_kind_task_idx` | `(run_kind, task_id)` | Board/latest-attempt lookups that explicitly exclude scratch runs. |
| `scratch_runs` | `scratch_runs_project_status_idx` | `(project_id, dialog_status)` | Project scratch workspace lists. |
| `scratch_attachments` | `scratch_attachments_run_idx` | `(run_id)` | Run-level attachment lookup. |
| `scratch_attachments` | `scratch_attachments_message_idx` | `(message_id)` | Message attachment lookup. |
| `step_runs` | `step_runs_run_idx` | `(run_id)` | Per-run step lookups. |
| `node_attempts` | `node_attempts_run_step_attempt_uq` | `(run_id, node_id, attempt)` UNIQUE | **(M11a)** Append-only ledger uniqueness. |
| `node_attempts` | `node_attempts_run_idx` | `(run_id)` | **(M11a)** Templating highest-attempt union. |
| `gate_results` | `gate_results_run_idx` | `(run_id)` | **(M11a)** Per-run gate lookups. |
| `gate_results` | `gate_results_node_attempt_idx` | `(node_attempt_id)` | **(M11a)** Gates for a node attempt. |
| `hitl_requests` | `hitl_requests_run_idx` | `(run_id)` | Pending HITL panel. |
| `review_comments` | `review_comments_run_created_idx` | `(run_id, created_at)` | **(ADR-072)** Thread listing per run in stable order. |
| `review_comments` | `review_comments_run_status_idx` | `(run_id, status)` | **(ADR-072)** Open-thread compose / unresolved counts. |
| `review_comments` | `review_comments_hitl_request_idx` | `(hitl_request_id)` | **(ADR-072)** Comments per gate visit. |
| `review_comments` | `review_comments_parent_idx` | `(parent_id)` | **(ADR-072)** Reply lookup per root. |
| `assignments` | `assignments_hitl_request_uq` | `(hitl_request_id)` UNIQUE | One assignment per linked HITL wait. |
| `assignments` | `assignments_project_status_idx` | `(project_id, status)` | Project work queue. |
| `assignments` | `assignments_run_status_idx` | `(run_id, status)` | Run-detail work queue. |
| `assignments` | `assignments_current_actor_idx` | `(assignee_actor_id)` | Actor-owned work lookup. |
| `assignments` | `assignments_hitl_request_idx` | `(hitl_request_id)` | HITL lookup. |
| `assignment_events` | `assignment_events_assignment_idx` | `(assignment_id)` | Assignment event history. |
| `assignment_events` | `assignment_events_project_created_idx` | `(project_id, created_at)` | Project audit stream. |
| `scheduler_jobs` | `scheduler_jobs_due_idx` | `(disabled_at, next_run_at)` | **(M24 Implemented, migration `0027`)** Due-job scan. |
| `scheduler_jobs` | `scheduler_jobs_kind_due_idx` | `(job_kind, next_run_at)` | **(M24 Implemented, migration `0027`)** Kind-filtered due-job scan. |
| `scheduler_jobs` | `scheduler_jobs_project_kind_idx` | `(project_id, job_kind)` | **(M24 Implemented, migration `0027`)** Project-scoped scheduler read model. |
| `scheduler_job_runs` | `scheduler_job_runs_job_idx` | `(job_id)` | **(M24 Implemented, migration `0027`)** Job attempt history. |
| `scheduler_job_runs` | `scheduler_job_runs_lease_idx` | `(status, lease_expires_at)` | **(M24 Implemented, migration `0027`)** Stuck-attempt reaper. |
| `agent_schedules` | `agent_schedules_project_agent_idx` | `(project_id, agent_id)` | **(M34, migration `0049` rework)** Project agent trigger-binding lookup (was `(project_id, agent_ref)` from the dead M24 shape). |
| `agent_schedules` | `agent_schedules_due_cron_idx` | `(trigger_type, enabled, next_fire_at)` | **(M34)** Due-cron scan for the `agent_tick.dispatcher`. |
| `agents` | `agents_flow_ref_idx` | `(flow_ref_id)` | **(M34, migration `0051` rework)** Providing-package lookup (registration/resync, attach available-list). |
| `agent_project_links` | `agent_project_links_unique` | `UNIQUE (agent_id, project_id)` | **(M34)** One attachment per (agent, project). |
| `agent_project_links` | `agent_project_links_project_idx` | `(project_id)` | **(M34)** Attached-agents-per-project reads. |
| `runs` | `runs_agent_trigger_event_unique` | `UNIQUE (agent_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL` | **(M34)** Outbox→spawn no-dup claim under at-least-once redelivery (ADR-089). |
| `authored_capabilities` | `authored_capabilities_project_kind_slug_uq` | `(project_id, kind, slug)` UNIQUE | **(M25 Implemented, migration `0028`)** Project-local authored capability namespace. |
| `authored_capabilities` | `authored_capabilities_project_kind_idx` | `(project_id, kind)` | **(M25 Implemented, migration `0028`)** Authored catalog list/filter. |
| `authored_capability_revisions` | `authored_capability_revisions_capability_revision_uq` | `(capability_id, revision_number)` UNIQUE | **(M25 Implemented, migration `0028`)** Immutable revision numbering. |
| `authored_capability_revisions` | `authored_capability_revisions_capability_lifecycle_idx` | `(capability_id, lifecycle)` | **(M25 Implemented, migration `0028`)** Current draft/published revision lookup. |
| `authored_capability_revisions` | `authored_capability_revisions_active_draft_uq` | `(capability_id)` UNIQUE, PARTIAL `WHERE lifecycle=DRAFT` | **(M25 Implemented, migration `0028`)** One active draft per authored capability. |
| `projects` | implicit | `slug`, `repo_path` UNIQUE | Registration collisions. |
| `flows` | `flows_project_ref_uq` | `(project_id, flow_ref_id)` UNIQUE | Per-project namespace. |
| `workspaces` | implicit | `worktree_path` UNIQUE | Globally unique worktree path. |
| `project_tokens` | `project_tokens_prefix_idx` | `(prefix)` | **(M16)** Fast prefix lookup during token verification. |
| `project_tokens` | `project_tokens_project_idx` | `(project_id)` | **(M16)** List project-bound tokens for a project. |
| `project_tokens` | `project_tokens_owner_idx` | `(owner_user_id)` | User-owned token audit joins. |
| `project_tokens` | `project_tokens_owner_created_idx` | `(owner_user_id, created_at)` | **(0063 Implemented)** List account-level personal tokens. |
| `token_audit_log` | `token_audit_token_idx` | `(token_id)` | **(M16)** Per-token audit trail. |
| `token_audit_log` | `token_audit_project_created_idx` | `(project_id, created_at)` | **(M16, 0063 Implemented)** Chronological audit log per project; NULL rows are global/deleted-target rows. |
| `webhook_subscriptions` | `webhook_subscriptions_project_idx` | `(project_id)` | **(ADR-077 Implemented)** Project-scope subscription lookup (NULL = platform rows). |
| `webhook_events` | `webhook_events_pending_fanout_idx` | `(created_at)` PARTIAL `WHERE fanout_at IS NULL` | **(ADR-077 Implemented)** Ordered fanout-pass claim scan. |
| `webhook_deliveries` | `webhook_deliveries_due_idx` | `(next_attempt_at)` PARTIAL `WHERE status = 'pending'` | **(ADR-077 Implemented)** Ordered drain-pass claim scan. |
| `webhook_deliveries` | `webhook_deliveries_subscription_log_idx` | `(subscription_id, created_at DESC)` | **(ADR-077 Implemented)** Deliveries-drawer log UI. |
| `webhook_deliveries` | `webhook_deliveries_sub_event_uq` | `(subscription_id, event_id)` UNIQUE | **(ADR-077 Implemented)** Fanout dedupe invariant. |
| `webhook_delivery_attempts` | `webhook_delivery_attempts_delivery_idx` | `(delivery_id)` | **(ADR-077 Implemented)** Attempt history for a delivery. |
| `webhook_delivery_attempts` | `webhook_delivery_attempts_delivery_attempt_uq` | `(delivery_id, attempt_no)` UNIQUE | **(ADR-077 Implemented)** One row per attempt number per delivery. |
| `brain_items` | `brain_items_event_uq` | `(project_id, source_domain_event_id)` UNIQUE, PARTIAL `WHERE source_domain_event_id IS NOT NULL` | **(Implemented, ADR-122)** Harvest at-least-once idempotency at the DB. |
| `brain_items` | `brain_items_active_hash_uq` | `(project_id, content_hash)` UNIQUE, PARTIAL `WHERE status = 'active'` | **(Implemented, ADR-122)** Exact-dup race guard → `CONFLICT`. |
| `brain_items` | `brain_items_tsv_gin` | GIN `(tsv)` | **(Implemented, ADR-122)** Lexical recall leg. |
| `brain_items` | `brain_items_recall_idx` | `(project_id, status, expires_at)` | **(Implemented, ADR-122)** Recall-path project-scoped active-item scan. |
| `brain_embeddings` | `brain_embeddings_item_idx` | `(item_id, embedding_model, embedding_dimensions)` | **(Implemented, ADR-122)** Generation lookup + FK. |
| `brain_embeddings` | `brain_embeddings_generation_uq` | `(item_id, split_ordinal, embedding_model, embedding_dimensions)` UNIQUE | **(Implemented, ADR-122, brain migration `0002`)** Idempotent re-embed — a concurrent/double reindex insert is a no-op. |
| `brain_embeddings` | `brain_embeddings_hnsw_<modelslug>_<N>` | `USING hnsw ((vector::vector(N)) vector_cosine_ops) WHERE embedding_model = M AND embedding_dimensions = N` | **(Implemented, ADR-122)** Per-generation expression HNSW, created by `ensureEmbeddingIndex` at configure/reindex (NOT in the migration). |
| `brain_snapshots` | `brain_snapshots_run_idx` | `(run_id)` | **(Implemented, ADR-122)** Run-scoped snapshot reads. |
| `brain_index_jobs` | `brain_index_jobs_claim_idx` | `(status, created_at)` | **(Implemented, ADR-122)** Reindex-worker claim scan. |

Source: `web/lib/db/schema.ts`.
