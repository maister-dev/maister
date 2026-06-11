# Projects domain ERD

Tables for project registration and the immediate fanout. See
[`../system-analytics/projects.md`](../system-analytics/projects.md) for
process flows and [`../system-analytics/executors.md`](../system-analytics/executors.md)
and [`../system-analytics/flows.md`](../system-analytics/flows.md) for
each entity's behavior.

```mermaid
erDiagram
    PROJECTS ||--o{ FLOWS : "flows[] in maister.yaml"
    PLATFORM_ACP_RUNNERS ||--o{ PROJECTS : "default_runner_id override"
    PLATFORM_ACP_RUNNERS ||--o{ PROJECT_FLOW_RUNNER_DEFAULTS : "attachment default"
    FLOWS ||--o{ PROJECT_FLOW_RUNNER_DEFAULTS : "runner binding"

    PROJECTS {
        text id PK
        text slug UK "kebab-case derived from name"
        text name
        text repo_path UK "resolved on-disk dir"
        text repo_url "nullable origin URL (ADR-025)"
        text provider "nullable: github|gitlab|gitea|gitverse|generic"
        text main_branch "current column; product default_branch"
        text branch_prefix "default 'maister/'"
        text maister_yaml_path "where the manifest was loaded from"
        text default_runner_id "platform runner override"
        text promotion_mode "M18: project-default promotion mode (local_merge|pull_request); override-chain source (§3.4)"
        jsonb delivery_policy_default "ADR-085 Designed: strategy/push/trigger/targetBranch"
        timestamp created_at
        timestamp archived_at "soft archive"
    }

    FLOWS {
        text id PK
        text project_id FK
        text flow_ref_id "id from maister.yaml flows[]"
        text source "git URL"
        text version "tag (lock semantics)"
        text revision "git SHA; mutable current pointer"
        text installed_path "current pointer; runs use flow_revision"
        jsonb manifest "parsed flow.yaml"
        integer schema_version
        text version_binding "M27 Designed: pinned|latest (DEFAULT latest)"
        timestamp created_at
    }

    PLATFORM_ACP_RUNNERS {
        text id PK
        text adapter "claude|codex|gemini|opencode|mimo"
        text capability_agent "claude|codex|gemini|opencode|mimo"
        text model
        jsonb provider
        text permission_policy
        text sidecar_id FK
        text readiness_status
        boolean enabled
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

    PROJECT_FLOW_RUNNER_DEFAULTS {
        text id PK
        text project_id FK
        text flow_id FK
        text runner_id FK "nullable = inherit"
        timestamp created_at
        timestamp updated_at
    }
```

> **Note (ADR-064):** `FLOW_GRAPH_LAYOUTS` (M22) was dropped in migration `0030`.
> Authored flow-graph node positions now live in the `flow.yaml` `presentation`
> section, not a DB table.

## Constraints

- `projects.slug` UNIQUE — kebab-case slug derivation collisions
  rejected at register time.
- `projects.repo_path` UNIQUE — one repo, one project. Archived
  projects' `repo_path` stays reserved.
- `flows_project_ref_uq` on `(project_id, flow_ref_id)` — same shape
  as project Flow ids.
- `project_flow_runner_defaults_project_flow_uq` on `(project_id, flow_id)` —
  one project Flow runner binding per attachment.

## Notes

- `projects.repo_url` and `projects.provider` are nullable metadata
  captured at register time ([ADR-025](../decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)):
  the clone source / existing `origin`, and the auto-detected host tag.
  `repo_path` is the resolved on-disk dir, not read from `maister.yaml`.
- `projects.default_runner_id` references a platform runner override; null means
  inherit the platform default.
- `projects.delivery_policy_default` **(Designed, ADR-085, migration `0045`)**
  stores the project default `DeliveryPolicy`. Null rows map from the legacy
  `promotion_mode` value, and project settings writes use one aggregate PATCH so
  partial settings updates cannot apply after another sub-section fails.
- `flows.manifest` stores the **parsed** `flow.yaml` — full step DSL,
  portable runner profiles, etc. Source of truth for the runtime step
  loader; the on-disk `flow.yaml` is only read on install / refresh.
- `flows.version_binding` **(Designed, M27)**: `pinned` resolves `flows.enabled_revision_id`; `latest` picks the newest published `flow_revisions` row for the `flow_ref_id`, never a draft.
- Project Flow runner defaults live in `project_flow_runner_defaults`.
- Planned M10 splits immutable Flow package revisions from project Flow
  enablement. Until that lands, `flows` is still the mutable current pointer;
  run safety comes from `runs.flow_revision`.
- `flow_revisions.exec_trust` **(Designed, M27)**: second independent trust axis. `untrusted | trusted`. Gates `runRevisionSetup` (setup.sh) and MCP stdio command spawn. Default `untrusted`; requires an explicit operator flip. Drawn in the narrative; `FLOW_REVISIONS` is not included in this partial ERD.
- `platform_mcp_servers` **(Designed, M27)**: platform-admin-managed MCP server catalog. No FK to other tables in this diagram — secret values are stored only as `env:NAME` references. Mirrors `platform_acp_runners` in admin CRUD surface.
- ADR-084 DB audit: runner adapter/capability-agent columns are SQL `text`
  without CHECK/enum constraints, so adding `gemini`, `opencode`, and `mimo` is a
  TypeScript/schema contract change, not a SQL DDL migration for runner rows.
  Migrations `0044_mcp_supported_agents_all_adapters.sql` and
  `0045_mcp_supported_agents_mimo.sql` change the MCP `supported_agents`
  default for new rows to all five adapter families; `0045` only backfills
  rows that exactly matched the previous all-adapter default.

## Linked artifacts

- Process flows: [`../system-analytics/projects.md`](../system-analytics/projects.md).
- Config: [`../configuration.md`](../configuration.md) §`maister.yaml v2`.
- Source: `web/lib/db/schema.ts`.
