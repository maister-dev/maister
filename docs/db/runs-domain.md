# Runs domain ERD

## Cut-over runs-domain transition (ADR-131 — Implemented)

The post-0093/0094 runs domain has no STEP_RUNS entity or fallback join.
NODE_ATTEMPTS exclusively supplies graph progress, activity, templating and
resume context. Legacy run rows remain and obtain their durable cut-over reason
from the run.failed domain-event ledger. Migration 0094 uses that ledger only
to clear task C2 claims predating D2; it introduces no ERD shape change.

Tables for the execution lifecycle: tasks (board), runs (Flow attempts and
scratch sessions), workspaces (worktrees), scratch dialog metadata, messages,
attachments, and capability snapshots, plus the **ADR-078 (Implemented,
migration `0041`)** social-board tables around tasks (`task_relations`,
`task_comments`, `task_activity`, `task_subscribers`, `inbox_items` — each
also FK-cascading from `projects`, edges omitted here for readability; the
full edge set is in [`erd.md`](erd.md)). See
[`../system-analytics/tasks.md`](../system-analytics/tasks.md),
[`../system-analytics/social-board.md`](../system-analytics/social-board.md),
[`../system-analytics/runs.md`](../system-analytics/runs.md),
[`../system-analytics/workspaces.md`](../system-analytics/workspaces.md), and
[`../system-analytics/scratch-runs.md`](../system-analytics/scratch-runs.md).
ADR-109 adds the designed `consensus_round_verdicts` ledger for consensus-node
cross-verification; behavior lives in
[`../system-analytics/consensus.md`](../system-analytics/consensus.md).

**ADR-139 (Implemented, migration `0104`)** adds nullable Run provenance for
recoverable one-time task launches (`scheduled_launch_id`, unique when set) and
agent schedule bindings (`agent_schedule_id`, `ON DELETE SET NULL`). The
scheduled dispatcher remains outside the Run table: it first reserves identity
in its own ledger, then the ordinary launch transaction writes this sole link.

**ADR-166 (Implemented, migration `0130`)** adds the execution-host attribution
columns: `runs.execution_assignment_id` (the latest minted assignment —
`execution_assignments.state` says which one is active),
`run_sessions.execution_assignment_id` + `run_sessions.host_session_id`, and
`node_attempts.execution_assignment_id`. The `execution_hosts` /
`execution_assignments` / `execution_commands` tables themselves are drawn in
[`execution-hosts-domain.md`](execution-hosts-domain.md); only the FK edges
appear here.

**ADR-148 (Implemented, migration `0107`)** keeps a run's historical
status independent from workspace presence. `WORKSPACES` gains a renewable
lifecycle lease/result record; `WORKSPACE_RECONCILIATION_FINDINGS` is a
separate durable report/retry/quarantine ledger correlated optionally to a
project, run, or workspace. It never owns run JSONL or other runtime artifacts.

```mermaid
erDiagram
    PROJECTS ||--o{ TASKS : "owns"
    PROJECTS ||--o{ RUNS : "owns"
    PROJECTS ||--o{ WORKSPACES : "owns"
    PROJECTS ||--o{ WORKSPACE_RECONCILIATION_FINDINGS : "ADR-148 observed candidate"
    FLOWS ||--o{ TASKS : "selected at create"
    FLOWS ||--o{ RUNS : "selected at launch"
    PLATFORM_ACP_RUNNERS ||--o{ RUNS : "launch runner"
    SCHEDULED_TASK_LAUNCHES ||--o| RUNS : "one scheduled Run (ADR-139)"
    AGENT_SCHEDULES ||--o{ RUNS : "agent binding provenance (ADR-139)"
    TASKS ||--o{ RUNS : "1:N retry loop"
    RUNS }o--o| WORKSPACES : "own or shared worktree"
    RUNS o|--o{ WORKSPACE_RECONCILIATION_FINDINGS : "ADR-148 optional correlation"
    WORKSPACES o|--o{ WORKSPACE_RECONCILIATION_FINDINGS : "ADR-148 optional correlation"
    RUNS ||--o{ RUNS : "run-tree delegation (parent_run_id, ADR-098)"
    RUNS ||--|{ RUN_SESSIONS : "per-session runner state (Implemented ADR-114)"
    EXECUTION_ASSIGNMENTS o|--o| RUNS : "latest minted assignment — runs.execution_assignment_id (ADR-166 Implemented, 0130, SET NULL)"
    EXECUTION_ASSIGNMENTS o|--o{ RUN_SESSIONS : "spawned under (ADR-166 Implemented, 0130, SET NULL)"
    EXECUTION_ASSIGNMENTS o|--o{ NODE_ATTEMPTS : "attributed to (ADR-166 Implemented, 0130, SET NULL)"
    PLATFORM_ACP_RUNNERS ||--o{ RUN_SESSIONS : "session runner (Implemented ADR-114, SET NULL)"
    RUNS ||--o{ NODE_ATTEMPTS : "per-node attempt (ADR-027)"
    RUNS ||--o{ RUN_RESULTS : "public result revisions (Implemented ADR-165, 0129)"
    NODE_ATTEMPTS ||--o{ RUN_RESULTS : "producing attempt (Implemented ADR-165, SET NULL)"
    RUN_RESULTS ||--o| RUN_RESULTS : "superseded_by_id (Implemented ADR-165, SET NULL)"
    RUNS ||--o{ RUN_SYNC_ATTEMPTS : "sync attempts (ADR-141, 0106)"
    RUNS ||--o| RUN_COST_ROLLUPS : "derived token rollup (ADR-085)"
    RUNS ||--o{ GATE_RESULTS : "per-run gates (ADR-028)"
    NODE_ATTEMPTS ||--o{ GATE_RESULTS : "gate verdicts (ADR-028)"
    NODE_ATTEMPTS ||--o{ CONSENSUS_ROUND_VERDICTS : "consensus verification rows (ADR-109)"
    NODE_ATTEMPTS ||--o{ NODE_ATTEMPT_COST_ROLLUPS : "derived token rollups (ADR-085)"
    USERS ||--o{ NODE_ATTEMPTS : "takeover owner (ADR-030, SET NULL)"
    USERS ||--o{ WORKSPACES : "promotion owner (0021, nullable)"
    RUNS ||--o| SCRATCH_RUNS : "scratch metadata"
    TASKS ||--o{ SCRATCH_RUNS : "optional link"
    SCRATCH_RUNS ||--o{ SCRATCH_MESSAGES : "dialog ledger"
    SCRATCH_RUNS ||--o{ SCRATCH_ATTACHMENTS : "run attachments"
    SCRATCH_MESSAGES ||--o{ SCRATCH_ATTACHMENTS : "message attachments"
    SCRATCH_RUNS ||--|| SCRATCH_CAPABILITY_PROFILES : "launch snapshot"
    TASKS ||--o{ TASK_RELATIONS : "from-end (ADR-078)"
    TASKS ||--o{ TASK_RELATIONS : "to-end (ADR-078)"
    TASKS ||--o{ TASK_COMMENTS : "discussion (ADR-078)"
    TASKS ||--o{ TASK_ACTIVITY : "event log (ADR-078)"
    TASKS ||--o{ TASK_SUBSCRIBERS : "subscriber set (ADR-078)"
    TASKS ||--o{ INBOX_ITEMS : "inbox fanout (ADR-078)"

    PROJECTS {
        text sync_strategy_default "rebase|merge, default rebase (ADR-141, 0106)"
        text sync_runner_id FK "platform_acp_runners(id) ON DELETE SET NULL, nullable (ADR-141)"
    }

    TASKS {
        text id PK
        text project_id FK
        integer number "ADR-078 Implemented: per-project, UNIQUE (project_id, number)"
        text title
        text prompt
        text flow_id FK "ADR-089: NULLABLE — unconfigured until triaged"
        text status "Backlog|InFlight|Done|Abandoned"
        integer attempt_number "starts at 1"
        text triage_status "ADR-089: 'triaged' | NULL; += 'flagged' = held/needs-review (Implemented ADR-112; app-level text-enum widening, no DB CHECK / no migration)"
        text runner_id FK "ADR-089: verdict runner, SET NULL"
        text target_branch "ADR-089: verdict branch, nullable"
        text promotion_mode "ADR-089: local_merge|pull_request, nullable"
        text launch_mode "auto|manual nullable — as-plan child task (ADR-098, 0060)"
        timestamp launch_armed_at "ADR-112 (0073): enqueue-intent boundary, nullable — auto_launch_triaged retry cap counts only flow runs started at/after this"
        jsonb delegation_spec "as-plan delegation spec, kind-discriminated agent|flow (ADR-098/163, 0060)"
        jsonb execution_policy "migration 0055: per-task default execution policy, nullable"
        text priority "ADR-121 (0087): low|normal|high|urgent, NOT NULL default normal, CHECK"
        numeric triage_confidence "ADR-121 (0087): advisory 0..1, nullable, CHECK"
        boolean queue_paused "ADR-121 (0087): operator pause valve, NOT NULL default false"
        timestamp queue_claimed_at "ADR-121 (0087): C2 admission claim, nullable"
        timestamp created_at
        timestamp updated_at
    }

    RUNS {
        text id PK
        text run_kind "flow|scratch|agent (DEFAULT flow; agent — ADR-089)"
        text agent_id FK "ADR-089: agents(id) SET NULL — kind=agent only"
        text trigger_source "ADR-089/ADR-139: manual|cron|domain_event|webhook|flow|scheduled"
        bigint trigger_event_id "ADR-089: domain_events.id claim key"
        jsonb trigger_payload "ADR-089: webhook/event context, <= 32 KB"
        text scheduled_launch_id FK "ADR-139: scheduled_task_launches(id) SET NULL, UNIQUE when set"
        text agent_schedule_id FK "ADR-139: agent_schedules(id) SET NULL"
        text agent_workspace "ADR-090: none|repo_read|worktree (migration 0052) effective-axis snapshot"
        text task_id FK "nullable for scratch"
        text project_id FK "NULLABLE (0059): NULL for the project-less local-package assistant run"
        text local_package_id FK "0059: local_packages SET via CASCADE; set iff project-less (launch snapshot)"
        text flow_id FK "nullable for scratch"
        text runner_id FK "Implemented ADR-114 (0082): moved to run_sessions.runner_id (FK+index relocated)"
        text runner_resolution_tier "Implemented ADR-114 (0082): moved to run_sessions"
        text capability_agent "Implemented ADR-114 (0082): moved to run_sessions"
        jsonb runner_snapshot "Implemented ADR-114 (0082): moved to run_sessions"
        text parent_run_id FK "runs(id) SET NULL — orchestrator delegator (ADR-098, 0060)"
        text root_run_id FK "runs(id) — run-tree root (ADR-098, 0060)"
        jsonb delegation_snapshot "kind-discriminated agent|runner|flow launch snapshot (ADR-098/109/163, 0060)"
        text launch_mode "auto|manual nullable (ADR-098, 0060)"
        boolean persistent "addressable long-lived child, DEFAULT false (ADR-099, 0060)"
        text addressable_key "star-routing key, unique per tree when persistent (ADR-099, 0060)"
        text workspace_mode "own|shared run-tree worktree, nullable (ADR-099, 0060)"
        text status "Pending|Running|NeedsInput|NeedsInputIdle|HumanWorking|WaitingOnChildren|Review|Crashed|Done|Abandoned|Failed"
        text acp_session_id "resume handle (ACP session/resume); Implemented ADR-114 (0082): moved to run_sessions (per session)"
        text current_step_id "runner cursor"
        text flow_version "tag snapshot; scratch sentinel"
        text flow_revision "git SHA snapshot; manual sentinel"
        text flow_revision_id FK "nullable for scratch"
        text created_by_user_id FK "nullable launch/audit owner"
        timestamp checkpoint_at "when graceful checkpoint happened"
        timestamp keepalive_until "30min sliding window in NeedsInput"
        timestamp resume_started_at "Recover in-flight marker + reconcile grace anchor"
        timestamp resume_requested_at "ADR-121 (0087): idle HITL answered, awaiting a slot (C3 FIFO key)"
        timestamp queue_admitted_at "ADR-121 (0087): auto-drain origin marker, NULL = manual/scratch/resume"
        text resume_target_step_id "node id retained at crash time for Recover; current_step_id is nulled on crash (0016)"
        jsonb resolved_capability_set "ADR-069 Designed: frozen capability snapshot at launch; runner reads this, never live catalog"
        jsonb delivery_policy_snapshot "ADR-085 Designed: resolved policy at launch"
        jsonb execution_policy "migration 0055: resolved execution policy {preset,overrides} at launch"
        jsonb budget_state "ADR-101 0061: per-run mutable {ceilingOverride?,notified?} raise-and-resume override + per-scope warn rung, nullable"
        jsonb agent_config "Implemented ADR-111 0071: immutable resolved agent-config snapshot at spawn, nullable"
        timestamp cost_reconciled_at "Implemented ADR-117 0084: durable system_sweep cost-reconcile attempt marker, nullable"
        boolean brain_context "Implemented ADR-122 0088: ambient Project-Brain launch axis, nullable — null = off"
        jsonb promotion_hold "ADR-126 0089: {source,reason?,createdAt} auto-promotion hold, nullable (NULL = no hold)"
        timestamptz review_entered_at "ADR-126 0089: auto-promotion grace anchor stamped at Review-flip, nullable"
        jsonb withheld_mcps "ADR-129 Designed: run-level withheld-MCP sink {refId,transport,reason,scope}[] for flow AND agent, nullable"
        text promoted_head_sha "ADR-134 Implemented: final target delivery head, nullable"
        text merge_commit_sha "ADR-134 Implemented: non-FF/provider merge SHA, nullable"
        jsonb diff_stat "ADR-134 Implemented: cleaned {files,additions,deletions}, nullable"
        text agent_memory_hash "ADR-152 0122: sha256 of the agent memory injected at spawn, nullable — NULL = this run injected none; survives the 7-day run-dir GC"
        integer agent_chain_depth "ADR-156 0123 Designed: NOT NULL DEFAULT 0 — agent-to-agent trigger hops snapshotted at launch; an agent-authored domain event inherits parentDepth+1, every other trigger source seeds 0; capped at MAISTER_MAX_AGENT_CHAIN_DEPTH (default 2) across AND within projects"
        jsonb context_mounts "ADR-157 0124 Designed: launch snapshot of read-only sibling mounts [{projectId,slug,repoPath,mountPath,committish}], nullable — terminal cleanup and crash recovery read THIS, never a manifest/link that can drift after launch; NULL = no mounts"
        text execution_assignment_id FK "ADR-166 0130 Implemented: execution_assignments(id) SET NULL — the LATEST minted assignment, possibly released (state says which is active; epoch = driver-ownership generation); NULL = pre-Stage-A, never placed"
        timestamp started_at
        timestamp ended_at
    }

    RUN_SESSIONS {
        text id PK
        text run_id FK "Implemented ADR-114: runs(id) CASCADE; UNIQUE(run_id, session_name)"
        text session_name "ADR-114: 'default' (implicit/scratch/agent) | solo | named"
        text runner_id FK "ADR-114: platform_acp_runners(id) SET NULL — FK+index relocated off runs"
        text runner_resolution_tier "ADR-114: winning precedence tier"
        text capability_agent "ADR-114: ADAPTER_IDS"
        jsonb runner_snapshot "ADR-114: frozen launch profile"
        text acp_session_id "ADR-114: per-session ACP session/resume handle"
        text resolution_source "ADR-114: concrete source audit (slot_key | chain scope | launch-dialog)"
        jsonb resolution_warning "nullable RunnerResolutionWarning for soft model/provider fallback"
        text execution_assignment_id FK "ADR-166 0130 Implemented: execution_assignments(id) SET NULL — updated per spawn"
        text host_session_id "ADR-166 0130 Implemented: the SUPERVISOR session id written by the session.create ack (present from spawn); indexed; distinct from acp_session_id"
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
        text worktree_path UK "globally unique"
        text parent_repo_path
        timestamp created_at
        timestamp removed_at
        timestamp scheduled_removal_at "GC prune deadline"
        text archived_branch "preserved archive ref name"
        timestamp archived_at "when archive branch created"
        text base_branch "0021 run base branch (null pre-0021)"
        text base_commit "0021 base commit forked from (null pre-0021)"
        text target_branch "0021 promotion target branch"
        text promotion_mode "0021 local_merge|pull_request"
        text pr_url "0021 populated on PR-mode promotion"
        integer pr_number "0021"
        text pr_state "open|merged|closed, NULL=never checked (ADR-140, 0105)"
        boolean pr_has_conflicts "NULL=unknown"
        timestamp pr_merged_at
        text pr_merge_commit_sha "provider merge commit — NOT runs.merge_commit_sha"
        timestamp promoted_at "0021"
        text promotion_state "0021 none|claiming|done|failed|reopened (reopened: ADR-141 reopen path, app-level, no CHECK) (NOT NULL DEFAULT none)"
        text promotion_lane "ADR-126 0089: auto lane class docs|tests|deps|config, nullable (NULL = manual)"
        timestamp promotion_claimed_at "0021 durable-claim timestamp"
        text promotion_owner_user_id FK "0021 users.id, nullable"
        text promotion_attempt_id "0021 per-attempt CAS-identity token"
        text lifecycle_operation_state "0032 none|claiming|failed (NOT NULL DEFAULT none)"
        timestamp lifecycle_operation_claimed_at "0032 durable lifecycle claim timestamp"
        text lifecycle_operation_attempt_id "0032 per-attempt CAS token"
        text lifecycle_operation_name "0032 archive|drop|exportBranch|snapshotCommit|handoffBranch|sync (sync: ADR-141 sync claim, app-level, no CHECK)"
    }

    RUN_SYNC_ATTEMPTS {
        text id PK
        text run_id FK "runs(id) ON DELETE CASCADE"
        text workspace_id FK "workspaces(id)"
        integer attempt "UNIQUE (run_id, attempt)"
        text strategy "rebase|merge"
        text mode "mechanical|agent"
        text phase "starting|rebasing|agent_running|verifying|pushing|succeeded|failed|aborted — the single lifecycle column (plain text, no CHECK — node_attempts convention)"
        text target_ref
        text target_sha
        text head_sha_before
        text head_sha_after
        text remote_sha_before "for force-with-lease"
        jsonb conflicted_files
        text runner_id "platform_acp_runners(id) snapshot"
        text session_name "sync-<attempt>"
        timestamp agent_running_since "active-time duration cap"
        boolean auto_finalize "ai_rebase_merge toggle, default false"
        boolean pushed
        text error_code
        text error_message
        text actor_type
        text actor_id
        timestamp created_at
        timestamp updated_at
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

    RUN_RESULTS {
        text id PK
        text run_id FK "runs.id CASCADE"
        integer revision "1-based; UNIQUE(run_id, revision)"
        text validity "valid|stale|superseded|invalid (CHECK)"
        text schema_ref "flowRefId@rev12:schemaStem"
        text schema_sha256 "sha256 over the schema document bytes"
        integer schema_version "form_schema schemaVersion"
        text producer_kind "flow_node|agent_session (CHECK)"
        text producer_ref "node id | session:default"
        text node_attempt_id FK "node_attempts.id SET NULL"
        jsonb value "NULL iff validity=invalid (CHECK)"
        integer value_bytes "serialized size of the validated value"
        text invalid_reason "NOT NULL iff validity=invalid (CHECK)"
        jsonb artifact_manifest "DEFAULT []: engine manifest AT publish (audit)"
        text engine_version "MAISTER_ENGINE_VERSION at publish"
        text superseded_by_id FK "run_results.id SET NULL"
        timestamptz superseded_at
        timestamptz first_collected_at "write-once collect marker"
        timestamptz created_at "DEFAULT now()"
    }
    NODE_ATTEMPTS {
        text id PK
        text run_id FK
        text node_id "node id in compiled FlowGraph"
        text node_type "ai_coding|cli|check|judge|human|guard|form|orchestrator|consensus"
        integer attempt "auto-increment per (run,node)"
        text status "Pending|Running|Succeeded|Failed|NeedsInput|Reworked|Stale"
        text decision "human decision on finish"
        text workspace_policy "keep|rewind-to-node-checkpoint|fresh-attempt"
        text checkpoint_ref "0040: node checkpoint ref, rewind base is the checkpoint parent"
        boolean auto_retry "0040: DEFAULT false; true when this attempt is an auto-retry (retry_policy)"
        text session_policy "0040: effective rework session policy snapshot resume|new_session"
        boolean session_fallback "0040: DEFAULT false; true when resume fell back to new_session"
        text rework_from_node "origin node on rework re-entry"
        text owner_user_id FK "0011 takeover owner (users.id SET NULL)"
        text claim_head_sha "0126: branch HEAD when the claim row was appended; the return measures operator commits from it"
        text base_ref "0011 merge-base SHA for returned range"
        text returned_commits "0011 raw git log base..branch"
        text returned_diff "0011 raw git diff base..branch"
        jsonb enforcement_snapshot "0013 append-only verdict audit"
        jsonb materialization_plan "0019 Implemented: resolved profile snapshot + cleanup substate"
        jsonb output_contract "0127 Implemented ADR-162: structured-output contract identity schemaRef/schemaVersion/sha256/transport/engineVersion; NULL when no output.result"
        text execution_assignment_id FK "ADR-166 0130 Implemented: execution_assignments(id) SET NULL — stamped at attempt start, immutable"
        text acp_session_id
        text stdout "truncated to 1 MiB"
        text resolved_prompt "0053 captured resolved agent prompt; nullable, pre-0053 rows null"
        integer rework_baseline "ADR-118 0086 Implemented: attempt at which current rework epoch began; NULL means 0; effective = attempt - (rework_baseline ?? 0)"
        jsonb vars "DEFAULT {}"
        integer exit_code
        text error_code "MaisterErrorCode literal"
        timestamp started_at
        timestamp ended_at
    }

    GATE_RESULTS {
        text id PK
        text run_id FK
        text node_attempt_id FK
        text gate_id "gate id within the node"
        text kind "command_check|skill_check|ai_judgment|artifact_required|external_check|human_review"
        text mode "blocking|advisory"
        text status "pending|running|passed|failed|stale|skipped|overridden"
        jsonb verdict "verdict|confidence|reasons|recommendedAction"
        jsonb input_artifact_refs "typed-artifact ids (ADR-037)"
        text output_artifact_ref "typed-artifact id (ADR-037)"
        jsonb stale_from "node ids whose rework stales this"
        text overridden_by "hitl_requests.id of override"
        timestamp created_at
        timestamp ended_at
    }

    CONSENSUS_ROUND_VERDICTS {
        text id PK
        text run_id FK
        text node_attempt_id FK
        integer round "starts at 1"
        text verifier_key "participant id"
        text target_key "participant id audited by verifier"
        text parse_status "parsed|invalid_json|invalid_schema|missing_axes|unknown_axes"
        text verdict "agree|disagree"
        jsonb axes "declared material axis -> boolean"
        jsonb disagreements "bounded disagreement facts"
        real confidence "optional, advisory"
        text raw_output_artifact_id "optional bounded raw evidence ref"
        text error_code "MaisterErrorCode literal"
        timestamp created_at
    }

    SCRATCH_RUNS {
        text run_id PK
        text project_id FK "NULLABLE (0059): exactly one of project_id / local_package_id (CHECK)"
        text local_package_id FK "0059: local_packages CASCADE; the project-less owner"
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

    TASK_RELATIONS {
        text id PK
        text project_id FK "the FROM-task's project — the row owner (ADR-155 Designed: to_task_id may live in a DIFFERENT project, so this is no longer the project of both ends)"
        text from_task_id FK
        text kind "blocks|depends_on|parent_of|requires|duplicate_of (duplicate_of: Implemented ADR-112, 0072, non-blocking)"
        text to_task_id FK "ADR-155 Designed: may point at a task in another project; no new column"
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
        text event_kind "task_created|comment_added|task_mentioned|relation_added|relation_removed|run_launched|triage_set|triage_requeued|agent_quarantined|experiment_concluded|run_pr_merged|evaluation_decided|agent_summon_suppressed (run_pr_merged: ADR-140, 0105, expands both task_activity_event_kind_check and inbox_items_event_kind_check; agent_summon_suppressed: ADR-151, 0121, task_activity only)"
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
```

> **(Implemented, migration `0010`.)** `NODE_ATTEMPTS` and `GATE_RESULTS`
> shipped on the `feature/m11a-flow-graph-lifecycle` branch.
> `node_attempts` is the append-only execution ledger. See
> [`../system-analytics/flow-graph.md`](../system-analytics/flow-graph.md) and
> [ADR-027](../decisions.md#adr-027-append-only-node_attempts-run-ledger) /
> [ADR-028](../decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped).

> **(Implemented, migration `0070`.)** `CONSENSUS_ROUND_VERDICTS` records
> per-round verifier rows for `consensus` node attempts. Its unique key
> `(node_attempt_id, round, verifier_key, target_key)` lets recovery reuse
> completed cross-verification sessions instead of spawning them again. Rows
> cascade from both `RUNS` and `NODE_ATTEMPTS`.

> **(Implemented, migration `0011`, additive.)** The
> `RUNS.status` enum gains `HumanWorking` (manual takeover claim), and
> `NODE_ATTEMPTS` gains four nullable takeover columns — `owner_user_id`
> (FK → `users.id`, `ON DELETE SET NULL`), `base_ref`, `returned_commits`,
> `returned_diff` — populated ONLY on the takeover attempt of a `human_review`
> node. Raw `git log`/`git diff` text is stored minimally; typed `commit_set`/
> `diff` artifact instances belong to the **typed artifact model (ADR-037)**. See
> [`../system-analytics/manual-takeover.md`](../system-analytics/manual-takeover.md)
> and [ADR-030](../decisions.md#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status).

> **(Implemented — ADR-165, migration `0129`, additive.)** New table `RUN_RESULTS`
> — one row per public result REVISION of a run, any run kind. Four CHECK
> constraints encode the invariants the application must not be trusted to keep:
> `validity IN ('valid','stale','superseded','invalid')`,
> `producer_kind IN ('flow_node','agent_session')`,
> `(validity = 'invalid') = (value IS NULL)`, and
> `(validity = 'invalid') = (invalid_reason IS NOT NULL)`. `UNIQUE(run_id,
> revision)` makes the revision sequence a database fact, and the partial unique
> index `run_results_one_valid_per_run_uq ON (run_id) WHERE validity='valid'`
> makes "at most one current result per run" one too — a second `valid` INSERT
> that bypasses the publish helper violates it rather than silently winning.
> Rows CASCADE from `RUNS`; `node_attempt_id` and `superseded_by_id` are
> `ON DELETE SET NULL`. `RUNS` also gains the nullable `result_contract` and
> `delegation_bounds` jsonb columns, and `FLOW_REVISIONS` gains nullable
> `result_profiles`; all three are additive with no backfill. See
> [`../system-analytics/run-results.md`](../system-analytics/run-results.md) and
> [ADR-165](../decisions.md#adr-165-governed-recursive-agent-harness--public-run-results-result-profiles-effective-recursion-bounds-result-only-completion).

> **(ADR-078 — Implemented, migration `0041`.)** `TASKS` gains `number`
> (per-project, backfilled by `(created_at, id)` order); the five social
> tables carry the polymorphic actor pair (`actor_type CHECK IN
> ('user','agent','system')`, `(actor_type = 'system') = (actor_id IS NULL)`,
> no FK to `users`). All five also FK `projects` with cascade (edges in
> [`erd.md`](erd.md)). `task_activity` is written only by the domain layer.
> See [`../system-analytics/social-board.md`](../system-analytics/social-board.md)
> and [ADR-083](../decisions.md#adr-083-social-board-substrate--per-project-task-numbering-typed-relations-polymorphic-actor).

## Constraints

- `tasks_id_attempt_uq` on `(id, attempt_number)` — **vacuous**:
  `tasks.id` is already the PK, so this composite UNIQUE guards
  nothing. Shipped for historical reasons; the designed per-attempt
  uniqueness is `UNIQUE (task_id,
  attempt_number)` on `runs`.
- `tasks_project_status_idx` on `(project_id, status)` — board queries.
- `runs_project_status_idx` on `(project_id, status)` — portfolio
  queries and per-project In-Flight filters.
- `runs_project_status_kind_idx` on
  `(project_id, status, run_kind)` — active workspace queries that include both
  Flow and scratch runs while preserving kind filters.
- `runs_task_idx` on `(task_id)` — latest-attempt lookups (`ORDER
BY started_at DESC LIMIT 1`; designed run-attempt schema switches to
`ORDER BY attempt_number DESC LIMIT 1` once `runs.attempt_number` lands).
- `runs_kind_task_idx` on `(run_kind, task_id)` — board/latest
  attempt queries that explicitly filter `run_kind = 'flow'` and exclude
  scratch rows with nullable `task_id`.
- `runs_parent_run_id_idx` on `(parent_run_id)` — **(Implemented)**
  orchestrator run-tree child lookups (`parent_run_id` FK → `runs`,
  ON DELETE SET NULL).
- `runs_root_run_id_idx` on `(root_run_id)` — **(Implemented)**
  whole-tree queries from the run-tree root.
- `runs_root_addressable_key_uq` partial UNIQUE on
  `(root_run_id, addressable_key) WHERE persistent = true` —
  **(Implemented, migration 0060, ADR-099)** one persistent child per
  `addressable_key` within a run-tree; backs star-routed messaging address
  resolution.
- `runs_agent_trigger_event_unique` partial UNIQUE on
  `(agent_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL` —
  **(Implemented)** the outbox→spawn no-dup claim: at-least-once event
  redelivery converges to exactly one agent run (ADR-089). See
  [agents-domain.md](agents-domain.md).
- `scratch_runs_project_status_idx` on `(project_id, dialog_status)` — active
  scratch workspace lists. **(migration 0057)** made **partial**
  (`WHERE project_id IS NOT NULL`) so the project-less local-package assistant
  rows never widen it; the primary key on `run_id` covers detail joins.
- `scratch_runs_local_package_idx` on `(local_package_id, dialog_status)`
  partial (`WHERE local_package_id IS NOT NULL`) — **(migration 0059)** active
  local-package assistant lists.
- `scratch_runs_owner_xor_check` CHECK
  `(project_id IS NOT NULL) <> (local_package_id IS NOT NULL)` — **(migration
  0059, ADR-097)** a scratch run is owned by exactly one of a project / a local
  package (never both, never neither). `runs.local_package_id` is the matching
  launch snapshot (FK `local_packages`, `ON DELETE CASCADE`).
- `run_messages_run_node_attempt_sequence_uq` on `(run_id, node_attempt_id,
  sequence)` UNIQUE `NULLS NOT DISTINCT` (migration `0083`, generalized from
  `scratch_messages`) — deterministic dialog replay; scratch rows keep their
  `(run_id, sequence)` invariant (NULL `node_attempt_id`), flow rows are unique
  per node attempt.
- Attachment indexes on `(run_id)` and `(message_id)` — run and
  message attachment lookups.
- `run_transcript_states_run_attempt_uq` on `(run_id, node_attempt_id)`
  UNIQUE `NULLS NOT DISTINCT` and `run_messages_projection_tool_idx`
  (migration `0138`) support bounded canonical transcript coalescing. The
  state holds only message-sequence pointers; tool lookup and content
  concatenation do not load the full transcript into the worker.
- `scratch_capability_profiles.run_id` UNIQUE — run-scoped capability snapshot
  lookup.
- `workspaces.worktree_path` UNIQUE — globally unique across the host.
- **(ADR-140, migration 0105, Implemented)** `workspaces_pr_state_scan_idx` partial index
  on `(project_id) WHERE pr_url IS NOT NULL AND (pr_state IS NULL OR pr_state =
  'open')` — the `pr_state_scan` candidate query (open / never-checked PRs per
  project).
- **(ADR-141, migration 0106, Implemented)** `run_sync_attempts_run_attempt_uq` on
  `(run_id, attempt)` UNIQUE — append-only, one row per sync attempt; the sync
  claim tx allocates `max(attempt)+1` so concurrent launches converge to one row.
- **(ADR-027)** `node_attempts_run_step_attempt_uq` on `(run_id, node_id,
  attempt)` — append-only one row per (run, node, attempt); rework never
  mutates a prior row.
- **(ADR-027)** `node_attempts_run_idx` on `(run_id)` — templating
  highest-attempt-wins reads.
- **(ADR-028)** `gate_results_run_idx` on `(run_id)` and
  `gate_results_node_attempt_idx` on `(node_attempt_id)` — per-run and
  per-node-attempt gate lookups.
- **(ADR-109)** `consensus_round_verdicts_attempt_round_pair_uq` on
  `(node_attempt_id, round, verifier_key, target_key)` UNIQUE — idempotent
  consensus verifier replay.
- **(ADR-109)** `consensus_round_verdicts_run_idx` on `(run_id)` and
  `consensus_round_verdicts_node_attempt_idx` on `(node_attempt_id)` — per-run
  consensus audit and node-attempt verdict lookups.
- **(ADR-078, Implemented)** `tasks_project_number_uq` on `(project_id,
  number)` UNIQUE — numbering backstop; allocation itself is serialized by
  the `projects.next_task_number` row lock.
- **(ADR-078, Implemented)** `task_relations_from_kind_to_uq` on
  `(from_task_id, kind, to_task_id)` UNIQUE + CHECK `from_task_id <>
  to_task_id`; `task_relations_to_task_idx` on `(to_task_id)` for inverse
  lookups.
- **(ADR-078, Implemented)** `task_comments_task_created_idx` on
  `(task_id, created_at)`; `task_activity_task_created_idx` on
  `(task_id, created_at)` + `task_activity_project_created_idx` on
  `(project_id, created_at)`.
- **(ADR-151, Implemented — migration `0121`)** `task_activity_agent_summon_uq`
  partial UNIQUE on `(task_id, (payload->>'agentId'),
  (payload->>'triggerEventId')) WHERE event_kind = 'agent_summon_suppressed'`
  — the structural backstop that keeps one mention-summon suppression note
  per `(task, agent, event)` under at-least-once event redelivery.
- **(ADR-078, Implemented)** `task_subscribers_task_pair_uq` on
  `(task_id, subscriber_type, subscriber_id)` UNIQUE — first subscription
  reason wins.
- **(ADR-078, Implemented)** `inbox_items_recipient_idx` on
  `(recipient_type, recipient_id, read_at, created_at DESC)` — unread badge
  and inbox panel.

## Status enum reference

**Tasks** (board axis):

```
Backlog -> InFlight -> Done
       \-> Abandoned
```

Auto-return: a terminal `Failed | Crashed | Abandoned` *run* sends the
task back to `Backlog`. Only explicit user `Discard` sends a task to
`Abandoned`.

**Runs** (execution axis):

```
Pending -> Running -> Review -> Done (promotion succeeds)
                  \-> NeedsInput <-> NeedsInputIdle -> Abandoned
                  \-> NeedsInput -> HumanWorking -> Running (return — takeover)
                                                \-> NeedsInput (release)
                                                \-> Abandoned (abandon)
                  \-> WaitingOnChildren -> Running (child runs settled)
                  \-> Crashed -> Running (Recover)
                              \-> Abandoned (Discard)
                  \-> Failed
```

Runs also reach `Done` directly from `Running` by **result-only completion**
(Implemented — ADR-165): a flow run declaring `result.export` that published a
`valid` result and left its workspace clean finishes without entering `Review`.

See [`../system-analytics/runs.md`](../system-analytics/runs.md) for the
full state diagram.

**Run result validity** (Implemented — ADR-165):

```
[*] -> valid     publish (seam success / agent finalize)
[*] -> invalid   publish attempt failed (reason recorded, no value) -- terminal
valid -> stale       markDownstreamStale touched the producer node
valid -> superseded  a newer publish for the run -- terminal
stale -> superseded  a newer publish for the run -- terminal
```

**Scratch dialog status** (manual dialog axis):

```
Starting -> WaitingForUser <-> Running -> Review -> Done
                         \-> NeedsInput <-> Running
                         \-> Crashed -> Running (Recover)
                         \-> Abandoned
```

`WaitingForUser` exists only on `scratch_runs.dialog_status`. It maps to
`runs.status = 'Running'` so idle live scratch sessions keep counting against
the shared live-session cap. `NeedsInput` maps to `runs.status = 'NeedsInput'`
only for explicit HITL or permission waits.

## Notes on cardinality

- `RUNS }o--o| WORKSPACES` is own-or-shared. The workspace row can be missing
  while a run is `Pending` or after GC; own runs reference one tree, while a
  shared-mode run tree can reference one common workspace from several runs.
  ADR-134 records final delivery evidence on the one root run rather than
  duplicating it on the shared workspace or siblings.
- `TASKS ||--o{ RUNS` — 1:N attempts. The "latest" run on a card is
  the row with `MAX(started_at)` for the task today; the designed
  run-attempt schema switches to `MAX(runs.attempt_number)` once that
  column lands. Board queries must filter `RUNS.run_kind = 'flow'`; scratch
  runs are not task attempts.
- `RUNS ||--o| SCRATCH_RUNS` — only `run_kind = 'scratch'` rows have scratch
  metadata.
- `RUNS.created_by_user_id` is nullable for legacy rows and records launched-by
  display/audit ownership for new Flow and scratch launches. Scratch v1
  authorization remains project-role based.
- `RUNS.resolved_capability_set` **(Designed — ADR-069)**: frozen at launch by `launchRun`; the runner reads this snapshot, never the live catalog. Shape: `{ flowRevisionId, flowOrigin, capabilities: {refId,kind,sha}[], mcps: {refId,sha,scope}[] }`. An edit or publish during a run must NOT mutate this field. **(ADR-129 Designed)** each `mcps[]` entry additionally records `provenance: 'binding'|'precedence'` (+ optional `boundTarget:{kind,id}`); the field is optional so pre-migration runs read it absent.
- `RUNS.withheld_mcps` **(Designed, ADR-129)**: nullable run-level sink of MCPs excluded from the executable set — `{refId, transport, reason, scope}[]` where `reason ∈ {platform-untrusted, exec-untrusted-stdio}`. Populated for BOTH flow launches (mirroring per-node `node_attempts.materialization_plan.withheldMcps`) and agent launches (which persist no materialization_plan). Read by the run-detail panel; never contains a secret value. Kills the prior silent warn-log-only downgrade.
- `SCRATCH_RUNS ||--o{ SCRATCH_MESSAGES` — append-only dialog ledger with
  monotonic sequence per run.
- `SCRATCH_RUNS ||--|| SCRATCH_CAPABILITY_PROFILES` — exactly one launch-time
  profile snapshot per scratch run.
- Scratch-run v1 stores branch-target metadata on `scratch_runs`: base branch,
  base commit, and target branch.
- `SCRATCH_RUNS.plan_mode` is retained for compatibility and derived from
  `work_mode`: `plan_first` maps to `plan-first`; `auto` and
  `manual_approval` map to `off`.
- `SCRATCH_ATTACHMENTS.storage_path` is server-internal. Public APIs expose
  uploaded-file display metadata and the rootless artifact reference stored in
  `value`, never absolute filesystem roots.
- `RUNS.delegation_snapshot` **(Implemented — ADR-163, NO DDL)** is a
  `kind`-discriminated jsonb union widened in TypeScript only: `kind?: 'agent'`
  (legacy rows carry no `kind`) = `{agentDefinitionId, revisionId}`;
  `kind: 'runner'` (ADR-109) = a consensus participant; `kind: 'flow'` = a
  delegated FLOW child, carrying `{flowId, flowRefId, flowRevisionId,
  resolvedRevision, engineMin, engineMax, carrierTaskId, mode, runnerOverride,
  baseBranch, targetBranch}`. Both branch fields resolve to
  `PROJECTS.main_branch` — a delegated child never branches off its parent — and
  `flowRevisionId` / `resolvedRevision` / the engine range are written by the
  launcher from the revision it selected, mirroring `RUNS.flow_revision_id`
  (what `loadRun` resolves the manifest from) — never a pin the route resolved
  earlier **(Implemented — ADR-163 amendment)** — so advancing the project's
  enabled revision cannot re-point a live child and the snapshot cannot
  disagree with the run row.
- `TASKS.delegation_spec` **(Implemented — ADR-163, NO DDL)** likewise becomes a
  `kind`-discriminated union: `{kind?: 'agent'; agentId; workspace?;
  runnerOverride?}` (legacy rows: no `kind` ⇒ read as agent) or
  `{kind: 'flow'; flowId; runnerOverride?}`. Readers use the
  `delegationSpecKind` helper, never an inline `!spec.agentId` shape test. Both
  widenings are `$type<>`-only: no column, CHECK, or index changes, so
  `docs/db/erd.dbml` is untouched and is NOT regenerated.
- **(Designed)** `node_attempts` and `gate_results` are now drawn above
  (migration `0010`). The remaining graph-maturity tables — artifacts, artifact
  edges, assignments, external operation events — are still future work and not
  drawn until their migrations exist.

### Agent-question terminal origin (Implemented — ADR-136)

An `agent_question` keeps an immutable source `origin_run_id` snapshot in
`task_clarifications`, while `hitl_requests.run_id` remains the terminal
standalone origin for audit and authorization. The source run is marked `Done`
only after confirmed termination. A later task-bound standalone launch may set
`superseded_by_run_id`; this snapshot does not cascade away with the source.

> **(Implemented, migration `0019`, additive.)** `NODE_ATTEMPTS` gains
> `materialization_plan` (jsonb, nullable) — the resolved capability profile
> snapshot written once at the time the node transitions to `Running`. The
> column holds `{ profileDigest, resolvedRevisions, materializedFiles,
> enforcedClasses, instructedClasses, refusedClasses, cleanup }`. Write-once
> (mirrors `enforcement_snapshot`); the `cleanup` sub-object carries a
> recoverable `status: pending|done|failed` + optional `error` + `at` timestamp.
> See [`capabilities-domain.md`](capabilities-domain.md) for the full
> jsonb shape and [`../database-schema.md`](../database-schema.md#node_attempts)
> for the narrative. ADR-041 in [`../decisions.md`](../decisions.md).

> **(Implemented, migration `0127`, additive.)** `NODE_ATTEMPTS` gains
> `output_contract` (jsonb, nullable, no default, no backfill) — WHICH
> structured-output contract judged this attempt:
> `{ schemaRef, schemaVersion, sha256, transport, engineVersion }` with
> `transport ∈ {sentinel, file, engine_vars}` and `sha256` over the resolved
> schema document's exact bytes. Written on the SAME closing UPDATE as the
> attempt's terminal status — the success path and the structured-output
> seam-failure path alike — and never cleared by `markNodeReworked`. `NULL`
> means the node declared no `output.result`, the row predates the column, or
> the seam failed before the schema was read (no identity exists then). It is
> engine metadata, deliberately kept out of `vars` (the flow-visible plane) and
> out of every client DTO. See
> [`../database-schema.md`](../database-schema.md#node_attempts) for the
> narrative and
> [ADR-162](../decisions.md#adr-162-universal-structured-node-result--transport-matrix-open-json-grammar-schema-identity).

## Linked artifacts

- Process flows: [`../system-analytics/tasks.md`](../system-analytics/tasks.md),
  [`../system-analytics/runs.md`](../system-analytics/runs.md).
- Capabilities: [`capabilities-domain.md`](capabilities-domain.md).
- Source: `web/lib/db/schema.ts`.

## Plan-review recovery (Implemented — ADR-137)

No status is added for decision requests. The startup/reconcile handoff owner
uses the durable parent response as intent: it rewrites `input-<stepId>.json`
before a missing delivery marker, or reclaims a marker-complete graph wake. A
final idle decision returns a graph-owned run from `NeedsInputIdle` to
`NeedsInput` only after the scheduler claim, then uses `runFlow()` to consume
the durable parent input. At capacity it remains idle with
`resume_requested_at`. The parent/child HITL records make restart recovery
deterministic without an ACP permission session.
