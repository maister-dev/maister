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
        text maister_yaml_path "nullable (ADR-093 Designed, 0054): manifest path; NULL = config-in-DB-only"
        text default_runner_id "platform runner override"
        text promotion_mode "M18: project-default promotion mode (local_merge|pull_request); override-chain source (§3.4)"
        jsonb delivery_policy_default "ADR-085 Designed: strategy/push/trigger/targetBranch"
        jsonb execution_policy_default "migration 0055: default execution policy {preset,overrides}, nullable"
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

Package management **(Implemented, ADR-088)** groups several flows + a capability
bundle under one platform-installed package attached per project; member
`flows` / `capability_imports` rows join the group via nullable
`package_install_id` FKs:

```mermaid
erDiagram
    PACKAGE_SOURCES ||--o{ PACKAGE_INSTALLS : "discovered + installed from"
    PACKAGE_INSTALLS ||--o{ PROJECT_PACKAGE_ATTACHMENTS : "attached per project"
    PROJECTS ||--o{ PROJECT_PACKAGE_ATTACHMENTS : "enablement"
    PACKAGE_INSTALLS ||--o{ FLOWS : "package_install_id (nullable FK)"
    PACKAGE_INSTALLS ||--o{ CAPABILITY_IMPORTS : "package_install_id (nullable FK)"
    PACKAGE_INSTALLS ||--o{ LOCAL_PACKAGES : "source_install_id + last_cut_install_id (nullable)"
    LOCAL_PACKAGES ||--o{ PACKAGE_INSTALLS : "source_local_package_id (nullable; cut provenance)"
    USERS ||--o{ LOCAL_PACKAGES : "created_by / locked_by_user_id"

    PACKAGE_SOURCES {
        text id PK
        text url UK "git monorepo URL"
        boolean enabled "DEFAULT true"
        text note "nullable"
        jsonb discovered "cached: [{name, tags[]}] DEFAULT []"
        timestamp last_checked_at "nullable"
        timestamp created_at
        timestamp updated_at
    }

    PACKAGE_INSTALLS {
        text id PK
        text source_url "git URL or file:// local dir"
        text name "package name from maister-package.yaml"
        text version_label "raw tag aif/v2.0.0 or local-digest12"
        text resolved_revision "tag SHA or content digest"
        jsonb manifest "parsed maister-package.yaml + inventory"
        text manifest_digest
        text installed_path
        text package_status "Installing|Installed|Failed|Removed"
        text trust_status "untrusted|trusted|trusted_by_policy"
        text source_local_package_id FK "nullable; cut provenance (SET NULL, ADR-107)"
        text source_commit_sha "nullable; working-dir HEAD at cut (ADR-107)"
        timestamp created_at
        timestamp updated_at
    }

    PROJECT_PACKAGE_ATTACHMENTS {
        text id PK
        text project_id FK "cascade"
        text package_install_id FK "restrict"
        text package_name "denormalized for uniqueness"
        timestamp attached_at
    }

    LOCAL_PACKAGES {
        text id PK
        text name
        text slug UK "kebab; working-dir name"
        text working_dir "abs path under localPackagesRoot(); server-only"
        text status "active|archived (DEFAULT active)"
        text source_install_id FK "nullable; fork lineage (SET NULL)"
        text source_repo_url "nullable; fork git source (Phase-2 PR)"
        text source_ref "nullable; base commit/tag forked from"
        text branch_name "nullable; fork branch in working_dir"
        text last_cut_install_id FK "nullable; latest cut revision (SET NULL)"
        text last_pushed_branch "nullable; PR-to-source publish branch (ADR-113)"
        text last_pr_url "nullable; opened PR URL (ADR-113)"
        text locked_by_user_id FK "nullable; current editor (SET NULL)"
        text locked_by_session "nullable; session holding the lock"
        timestamp lock_expires_at "nullable; lock TTL (mirrors runs.keepalive_until)"
        text created_by FK "nullable; author (SET NULL)"
        timestamp created_at
        timestamp updated_at
    }
```

Editable **local packages** **(Designed, ADR-096 — Phase C)** add a platform-scoped,
git-backed working directory you author/fork artifacts in and **cut versions** from
(the cut exports the dir cleanly and calls the same installer →
a `local-<digest>` `package_installs` revision, which a project `member` then
attaches). `working_dir` is server-only; the `locked_*`/`lock_expires_at` columns
mirror `runs.keepalive_until` for a session-scoped edit lock; `source_*` +
`branch_name` capture fork lineage for the Phase-2 PR-back.

## Constraints

- `projects.slug` UNIQUE — kebab-case slug derivation collisions
  rejected at register time.
- `projects.repo_path` UNIQUE — one repo, one project. Archived
  projects' `repo_path` stays reserved.
- `flows_project_ref_uq` on `(project_id, flow_ref_id)` — same shape
  as project Flow ids.
- `project_flow_runner_defaults_project_flow_uq` on `(project_id, flow_id)` —
  one project Flow runner binding per attachment.
- **(Implemented, ADR-088)** `package_installs` UNIQUE on
  `(source_url, name, resolved_revision)` — installed package revisions are
  immutable and content-addressed.
- **(Implemented, ADR-088)** `project_package_attachments` UNIQUE on
  `(project_id, package_name)` — at most one attached version of a package per
  project.
- **(Designed, ADR-096)** `local_packages.slug` UNIQUE — platform-scoped
  working-package identity; the working-dir name derives from it. `working_dir`
  is never exposed to the client; `source_install_id` / `last_cut_install_id`
  FKs are `SET NULL` on install delete (lineage is advisory, not load-bearing).
- **(M36, migration `0058`)** `local_packages_default_per_project` — a
  **partial-unique** index on `(project_id) WHERE is_default` enforcing at most
  one default "virtual" local package per project. `project_id` (FK `projects`,
  CASCADE) is **nullable**: NULL for named, platform-scoped local packages; set
  only on the per-project default that element-level forks land in.

## Notes

- `projects.repo_url` and `projects.provider` are nullable metadata
  captured at register time ([ADR-025](../decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)):
  the clone source / existing `origin`, and the auto-detected host tag.
  `repo_path` is the resolved on-disk dir, not read from `maister.yaml`.
- `projects.maister_yaml_path` **(Designed, ADR-093, migration `0054`)** is
  **nullable** (drop `NOT NULL`); `NULL` is the "config lives only in the DB"
  signal — the project registered without a `maister.yaml`, repo untouched. No
  backfill, so existing rows keep their path. See
  [`../system-analytics/projects.md`](../system-analytics/projects.md).
- `projects.default_runner_id` references a platform runner override; null means
  inherit the platform default.
- `projects.delivery_policy_default` **(Designed, ADR-085, migration `0047`)**
  stores the project default `DeliveryPolicy`. Null rows map from the legacy
  `promotion_mode` value, and project settings writes use one aggregate PATCH so
  partial settings updates cannot apply after another sub-section fails.
- `projects.execution_policy_default` **(Implemented, migration `0055`)** stores
  the project default execution-control policy (`{preset, overrides?}`). Null
  resolves through launch override → task → project → `supervised`; the resolved
  policy is snapshotted on `runs.execution_policy` at launch.
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

- **(Implemented, ADR-088)** `flows.package_install_id` and
  `capability_imports.package_install_id` are nullable FKs (`ON DELETE SET
  NULL` is NOT used — group removal happens through the detach transaction;
  the FK exists for grouping/joins). Standalone flows keep the column null.

## Linked artifacts

- Process flows: [`../system-analytics/projects.md`](../system-analytics/projects.md),
  [`../system-analytics/packages.md`](../system-analytics/packages.md) (Implemented, ADR-088).
- Config: [`../configuration.md`](../configuration.md) §`maister.yaml v2`.
- Source: `web/lib/db/schema.ts`.
