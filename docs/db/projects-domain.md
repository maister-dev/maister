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
        timestamp created_at
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
        boolean enabled
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
- `flows.manifest` stores the **parsed** `flow.yaml` — full step DSL,
  portable runner profiles, etc. Source of truth for the runtime step
  loader; the on-disk `flow.yaml` is only read on install / refresh.
- Project Flow runner defaults live in `project_flow_runner_defaults`.
- Planned M10 splits immutable Flow package revisions from project Flow
  enablement. Until that lands, `flows` is still the mutable current pointer;
  run safety comes from `runs.flow_revision`.

## Linked artifacts

- Process flows: [`../system-analytics/projects.md`](../system-analytics/projects.md).
- Config: [`../configuration.md`](../configuration.md) §`maister.yaml v2`.
- Source: `web/lib/db/schema.ts`.
