[← Error Taxonomy](error-taxonomy.md) · [Back to README](../README.md)

# Configuration

Platform runtime settings plus two manifests define how MAIster runs:

- **Platform runtime config** — operator-managed ACP runners, adapter
  diagnostics, and the required platform default runner. Stored by
  MAIster, not inside project repos.
- **`maister.yaml` v2** — per-project: project metadata, project default runner
  binding, Flow plugin bindings, Flow default runner bindings, capabilities,
  and role registries. Lives in the registered repo root.
- **`flow.yaml` v1** — per-Flow-plugin: the typed `nodes[]` graph, transitions,
  gates, runner targets, and optional `setup.sh`. Lives in each plugin's git
  repo.

Plus environment variables for the server tier itself.

Project and Flow validators live in `web/lib/config.ts` (zod schemas in
`web/lib/config.schema.ts`). Platform runtime validators live in the
ACP-runner platform module. Every malformed config failure path throws
[`MaisterError({ code: "CONFIG" })`](error-taxonomy.md).

## Platform runtime config

Platform ACP runners are canonical launch profiles. Projects and Flows only
reference their ids.

```yaml
platform:
  default_runner: claude-code

acp_runners:
  - id: claude-code
    adapter: claude
    model: claude-sonnet-4-6
    env:
      ANTHROPIC_MODEL: env:CLAUDE_CODE_MODEL
    provider:
      kind: anthropic
    permission_policy: default

  - id: claude-code-env-router
    adapter: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
      base_url: https://api.z.ai/api/anthropic
      auth_token: env:ZAI_API_KEY
    permission_policy: default

  - id: codex-openai
    adapter: codex
    model: gpt-5-codex
    provider:
      kind: openai
    permission_policy: default

  - id: gemini-cli
    adapter: gemini
    model: gemini-2.5-pro
    provider:
      kind: google_gemini
    permission_policy: default

  - id: opencode-native
    adapter: opencode
    model: opencode-native
    provider:
      kind: agent_native
    permission_policy: default

  - id: mimo-code-native
    adapter: mimo
    model: mimo-native
    provider:
      kind: agent_native
    permission_policy: default
```

Rules:

- `platform.default_runner` is required and must reference one enabled runner.
- `acp_runners[].adapter` resolves against the code-owned adapter registry.
- `capability_agent` is derived from the adapter registry and captured in
  launch snapshots. Operators do not enter it manually.
- Secret values are references such as `env:NAME`, never literal tokens.
- `acp_runners[].env` is an editable child-process env override map. Keys are
  env vars passed to the spawned ACP adapter (`ANTHROPIC_MODEL`, custom
  gateway knobs, etc.). Raw values are passed to the child as-is; values with
  the `env:NAME` form are resolved from the supervisor process environment at
  launch.
- Unsupported provider/policy combinations are saved only as
  `NotReady` with reason codes, or are rejected when they would create an
  invalid default.
- Gemini/OpenCode/MiMo runner rows are first-class catalog entries, but production
  readiness is still gated by supervisor diagnostics and adapter smoke evidence;
  they are never silently substituted with Claude/Codex.
- Admin APIs and UI may show secret ref names and readiness reason codes, but
  never raw token values or generated config bodies.

### MCP capability template — `platform_mcp_servers` (Designed)

**(Designed — ADR-065)** Platform MCP servers are stored in the `platform_mcp_servers`
table (admin-only CRUD, mirrors `platform_acp_runners`). The transport field is
discriminated:

| `transport` | Required fields | Optional fields    |
| ----------- | --------------- | ------------------ |
| `stdio`     | `command`       | `args`, `env_keys` |
| `sse`       | `url`           | `header_keys`      |
| `http`      | `url`           | `header_keys`      |

`env_keys` and `header_keys` store **names only** (`env:NAME`; regex
`^env:[A-Za-z_][A-Za-z0-9_]*$`). Secret **values** are resolved supervisor-side
from `process.env` at session spawn and MUST NEVER be stored in `platform_mcp_servers`,
returned in any HTTP response, written to any DB column, or included in an ACP
`session/update` payload visible to the browser. This is the same `env:NAME`
secret-ref policy used by `platform_acp_runners` (ADR-044 + ADR-065).

`exec_trust` on the `flow_revisions` row gates MCP stdio `command` spawn: a revision
with `exec_trust=untrusted` MUST NOT spawn a stdio MCP command even if `trustStatus`
is `trusted_by_policy` (logic-trust alone is insufficient — see
[`system-analytics/flow-packages.md`](system-analytics/flow-packages.md) §"Version binding and authored→executable bridge").

**No new web environment variable is required by the platform MCP catalog.** MCP
server secrets travel only as env-var names; the supervisor resolves them from its
existing `process.env` at spawn. The env table above is unchanged by it.

### Project Brain provider config — `platform_runtime_settings` (Implemented, ADR-122)

The Project Brain's embedding + distillation providers are platform-level config
on the singleton `platform_runtime_settings` row, set via admin `/settings →
Brain` (`GET/PATCH /api/admin/brain-settings`):

| Column                  | Meaning                                                                                                                                                          | Default                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `embedding_base_url`    | OpenAI-compatible base URL for `/embeddings`. Also used for distillation when `distill_base_url` is empty. Must be a valid URL.                                  | —                                                                                   |
| `embedding_model`       | Embedding model id.                                                                                                                                              | placeholder (no default — `text-embedding-3-small` is the suggested UI placeholder) |
| `embedding_dimensions`  | Embedding dimensions, capped at 2000 (pgvector HNSW index limit). Changing enqueues a non-destructive reindex generation (never a schema migration).             | placeholder (no default — `1536` is the suggested UI placeholder)                   |
| `embedding_api_key_ref` | `env:NAME` reference to the API-key env var (regex `^env:[A-Za-z_][A-Za-z0-9_]*$`). **Names only** — never the secret.                                           | placeholder (no default — `env:EMBEDDING_API_KEY` is the suggested UI placeholder)  |
| `distill_base_url`      | OpenAI-compatible base URL for `/chat/completions`. Empty falls back to `embedding_base_url`; set this for GLM/Z.ai or another cheaper distillation provider.    | —                                                                                   |
| `distill_model`         | Completion model for harvest distillation. Required to enable ANY project's Brain (enable-gate → 422 `CONFIG` otherwise).                                        | —                                                                                   |
| `distill_api_key_ref`   | `env:NAME` reference to the distillation API-key env var. Empty falls back to `embedding_api_key_ref` only when no dedicated distillation provider field is set. | placeholder (no default — `env:GLM_API_KEY` is the suggested UI placeholder)        |

Unlike MCP/runner secrets (resolved supervisor-side), the Brain embedding client
runs in the **web tier** (`web/lib/brain/openai-compatible.ts`), so every
`env:NAME` resolves from the **web** process environment. Provide secret VALUES
as web-tier env vars (for example `EMBEDDING_API_KEY` and `GLM_API_KEY`, see
`.env.example`). Values MUST NEVER be stored in any column, returned in any
response, logged, or streamed — the same `env:NAME` policy as
`platform_mcp_servers` / `platform_acp_runners`. A runtime embedding model **or
dimension** switch is a reindex generation, not a migration. Behavior policy
constants live in `web/lib/brain/policy.ts` (not env, not DB) — including
`ambientMinConfidence` 0.4 (ambient-inject floor) and `snapshotTtlDays` 30 (the
`brain_snapshots` GC horizon). See
[`system-analytics/project-brain.md`](system-analytics/project-brain.md).

## `maister.yaml` v2

> **`maister.yaml` is bootstrapped at manual registration (Implemented).** When
> the resolved repo has **no** manifest, `POST /api/projects` atomically writes a
> minimal schema-valid v2 file (`project.name`, resolved default branch, and
> `flows: []`) before following the normal validation and registration path.
> `body.name` wins over the directory basename for that initial file. A
> **present-but-invalid** manifest still fails `CONFIG` (422) and is never
> overwritten. `projects.maister_yaml_path` is set for all new registrations;
> `NULL` remains a legacy recovery state, and only those legacy rows can use the
> opt-in **persist** action to commit their DB-held configuration. The
> `MAISTER_PROJECTS_DIR` auto-discovery path remains manifest-gated. Behavior:
> [`system-analytics/projects.md`](system-analytics/projects.md).

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  default_branch: main # default base/target branch
  branch_prefix: maister/ # default: maister/
  default_runner: inherit # or a platform ACP runner id
promotion:
  mode: pull_request # local_merge | pull_request
  remote: origin # for pull_request mode
capabilities:
  mcps:
    - id: github
      source: project
      command: github-mcp-server
      agents: [claude, codex]
  skills:
    - id: aif-implement
      source: git
      url: github.com/org/aif-skills
      version: v1.0.0
      agents: [claude, codex]
  tools:
    - id: shell
      agents:
        claude: Bash
        codex: shell
        gemini: shell
        opencode: shell
      enforceability: enforced
  restrictions:
    - id: no-global-installs
      enforceability: instructed
  settings:
    - id: codex-default-step
      agent: codex
      source: project
      path: .maister/capabilities/codex-default/settings.json
  # Implemented — agent_definitions[] and env_profiles[] below
  agent_definitions:
    - id: claude-strict
      source: project
      agents: [claude]
  env_profiles:
    - id: prod-secrets
      source: project
      agents: [claude, codex]
flow_roles:
  - ref: maintainer
    label: Maintainer
    description: Human user, service, or internal agent that owns reviews
  - ref: qa
    label: QA
# Implemented — capability_imports[] block below
capability_imports:
  - id: aif-skills
    source: github.com/org/maister-aif-skills
    version: v1.0.0
  - id: custom-mcps
    source: github.com/org/maister-custom-mcps
    version: v2.1.0
    trust: explicit # optional: "explicit" forces trust-confirm even for policy-trusted sources
flows:
  - id: bugfix
    source: github.com/org/maister-flow-bugfix
    version: v1.2.3
    runner: inherit
  - id: spec-kit
    source: github.com/org/maister-flow-spec-kit
    version: v0.4.1
    runner: claude-code-env-router # optional platform runner ref
```

### Required fields

| Field             | Rule                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`   | Must be the integer `2`. Loader refuses on any other value.                                                                                                                                                                                                                                                                                                         |
| `project.name`    | Non-empty string. The `slug` is derived from this (kebab-case).                                                                                                                                                                                                                                                                                                     |
| `flows[].id`      | Unique within the file.                                                                                                                                                                                                                                                                                                                                             |
| `flows[].source`  | Non-empty. Resolved by the Flow loader (`git clone --branch <version>`).                                                                                                                                                                                                                                                                                            |
| `flows[].version` | Tag-pinned (lock semantics). Non-empty. The tag is the user-facing pin; at install the loader records the resolved git commit SHA in `flows.revision` and at run launch snapshots it into `runs.flow_revision`. The runner derives the bundle path from `(flowRefId, flow_revision)`, so a tag re-pointed upstream after the run launched does not affect that run. |

### Optional fields

| Field                    | Default       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.repo_path`      | derived       | Optional and ignored since [ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots). `projects.repo_path` is the **resolved on-disk dir** (the clone target under `MAISTER_REPOS_ROOT`, or the existing local dir), not this manifest field.                                                                                                           |
| `project.default_branch` | `main`        | Default base branch for new runs and default target branch for promotion. `project.main_branch` remains accepted as a backwards-compatible alias until the branch-targeting migration lands.                                                                                                                                                                                                                           |
| `project.branch_prefix`  | `maister/`    | Run-branch prefix; combined with the slug.                                                                                                                                                                                                                                                                                                                                                                             |
| `project.default_runner` | `inherit`     | Platform runner id or `inherit`. `inherit` uses the platform default. Missing/unknown runner ids create an explicit reconfiguration requirement; they never create project-scoped runner rows.                                                                                                                                                                                                                         |
| `promotion.mode`         | `local_merge` | **(Implemented — ADR-058/049.)** `local_merge` merges the run branch into the target branch locally; `pull_request` creates/updates a PR from the run branch into the target branch. Resolved at launch via the override chain (launch override > project `promotion.mode` > default `local_merge`) and snapshotted to `workspaces.promotion_mode`. `pull_request` mode has the per-provider host prerequisites below. |
| `promotion.remote`       | unset         | **(Implemented — ADR-049.)** Remote name used by `pull_request` mode (the `git push` target and the PR base remote).                                                                                                                                                                                                                                                                                                   |
| `flows[].runner`         | `inherit`     | Platform runner id or `inherit`. This is the project Flow attachment default and inherits the project default.                                                                                                                                                                                                                                                                                                         |
| `flow_roles[]`           | `[]`          | Flow routing registry (ADR-040). Each `ref` is project-scoped and may be used by `finish.human.role` or human-node `settings.roles[]`. Flow roles are not RBAC and never replace `project_members.role`.                                                                                                                                                                                                               |

#### `pull_request` promotion mode — per-provider host prerequisites (Implemented — ADR-049)

`pull_request` promotion runs in the **web tier** (the promote route shells a
provider CLI _or_ calls a Gitea-compatible REST API, plus `git push`). The
prerequisites depend on the run's detected provider (`projects.provider`), and are
required **only** when a run promotes via `pull_request` — `local_merge` needs **none**
of them. (Credential **model B**: host git credentials + provider CLI/token, no secrets
stored in MAIster.)

| Provider             | PR-mode prerequisite on the web host                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `github`             | `gh` CLI on `PATH` + host auth (`gh auth login`, or `GH_TOKEN` in the web-tier env).             |
| `gitlab`             | `glab` CLI on `PATH` + host auth (`glab auth login`, or `GITLAB_TOKEN` in the web-tier env).     |
| `gitea`              | `GITEA_TOKEN` in the web-tier env (the shared Gitea-compatible REST adapter; no CLI).            |
| `gitverse`           | `GITVERSE_TOKEN` in the web-tier env (same Gitea-compatible REST adapter).                       |
| `generic`            | **Unsupported** — `pull_request` mode refuses with `PRECONDITION`; use `local_merge`.            |
| **all of the above** | A host **git push credential helper** (SSH key or HTTPS credential helper) for the run's remote. |

The `GH_TOKEN`/`GITLAB_TOKEN`/`GITEA_TOKEN`/`GITVERSE_TOKEN` values are
**server-only secrets** — read from the web-tier process env, never logged, never
streamed via SSE, never embedded in `session/update` payloads. They are documented in
`.env.example`. A missing CLI / unset token / unconfigured remote surfaces as
`PRECONDITION` (HTTP 409) at promote time; the run stays `Review`.

> **Manual verification (not in CI).** The provider boundary is MOCKED in CI: the
> `gh`/`glab` CLI exec AND the Gitea-API `fetch` are stubbed, so no real remote is
> touched. A live `gh`/`glab` push + PR and a live Gitea/GitVerse PR MUST be exercised
> in manual verification against a real remote (credential **model B**). GitVerse's
> Gitea-API compatibility is confirmed — `gitverse` rides the shared Gitea REST
> adapter; only the token var (`GITVERSE_TOKEN`) and `apiBase` differ. See
> [`system-analytics/git-integration.md`](system-analytics/git-integration.md).

> **Compose skew (documented per ADR-023).** The default compose stays
> **Postgres-only** — `web` and `supervisor` run on the host. The default compose does
> **NOT** provision provider CLIs (`gh`/`glab`), API tokens, or git push credentials in
> the web container: PR-mode promotion is a **host-operator concern**. Per the run's
> provider the operator must supply `gh`/`glab` on `PATH` (github/gitlab) or
> `GITEA_TOKEN`/`GITVERSE_TOKEN` env (gitea-family), plus a git push credential helper.
> `local_merge` needs none. No silent dev/prod skew. See
> [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)

#### Studio PR-to-source publish — same host prerequisites (Implemented — ADR-113)

Studio **PR-to-source** (`POST /api/studio/local-packages/{id}/publish`, ADR-113)
reuses the **same** provider machinery as `pull_request` run promotion: it `git push`es
the local package's branch to a **registered `package_sources` target** and, when a
provider CLI + host token is detected, opens/updates a PR via the shared adapter
(`gh`/`glab`/Gitea/Gitverse). The prerequisite table above applies unchanged. When the
provider CLI or token is **absent**, publish degrades to **push-only** + a best-effort
compare URL (the member opens the PR manually) — it never fails the push for lack of PR
automation. No new env var; the same
`GH_TOKEN`/`GITLAB_TOKEN`/`GITEA_TOKEN`/`GITVERSE_TOKEN` + host git push credentials
cover it. `.maister` stays host-only (ADR-023) — no compose change.

> and [`deployment.md`](deployment.md).

#### `capability_imports[]` (Implemented)

The optional `capability_imports[]` block declares git-pinned capability
packages for the project. Each entry is fetched, trust-evaluated, and
(conditionally) set up during project registration.

```yaml
capability_imports:
  - id: aif-skills # SAFE_PATH_SEGMENT: /^[A-Za-z0-9._-]+$/
    source: github.com/org/aif-skills
    version: v1.0.0 # tag-pinned (lock semantics); SAFE_PATH_SEGMENT
    trust:
      explicit # optional; forces trust-confirm UI even for
      # policy-trusted sources (default: follow policy)
```

| Field     | Rule                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | Non-empty string matching `SAFE_PATH_SEGMENT` (`/^[A-Za-z0-9._-]+$/`). No `.`, `..`, or embedded `/`. Validated at Zod schema layer AND inside `systemCapabilityCachePath` (defence-in-depth). Unique within the file.                   |
| `source`  | Non-empty git URL. Resolved by `installCapabilityRevision` (`git clone --branch <version>`).                                                                                                                                             |
| `version` | Tag-pinned (lock semantics). Non-empty string matching `SAFE_PATH_SEGMENT`. Passed verbatim to `git clone --branch`. The resolved 40-hex SHA is captured and stored in `capability_imports.resolved_revision`.                           |
| `trust`   | Optional. `"explicit"` overrides policy-trust and requires an operator confirmation via `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust` before `setup.sh` runs, even if the source prefix would be `trusted_by_policy`. |

**Path safety (R-PATH):** Both `id` and `version` are validated against
`SAFE_PATH_SEGMENT` at the schema layer (Zod `refine`) and again inside the
path builder `systemCapabilityCachePath` (the `assertFieldSafe` guard from
`web/lib/flow-paths.ts`). An import `id` of `../evil`, `..`, or `a/b` is
rejected at both layers and never reaches `~/.maister/capabilities/`. This
mirrors the existing `flowIdSchema` / `versionSchema` pattern (see ADR-043).

**Install lifecycle:** On project registration, each `capability_imports[]`
entry drives `installCapabilityRevision` (fetch → record SHA → resolve trust),
followed by `runCapabilityRevisionSetup` (trust-gated, physically separate).
The resolved import is then ingested into `capability_records` via
`upsertCapabilitiesFromConfig` (source `flow-package`). See
[`db/capabilities-domain.md`](db/capabilities-domain.md) and ADR-043.

**Config-state symmetry (R-SYM):** Removing an entry from `capability_imports[]`
disables the corresponding config/import-owned `capability_records` rows
(`selectable=false`, `disabled_at` set). Historic profile snapshots are not
retroactively invalidated. **Authored catalog carve-out:** rows whose
`material.origin='authored'` are local DB-authored projections and are never
disabled by `upsertCapabilitiesFromConfig` SET/CLEAR, even though they also use
`source='project'`.

#### `packages[]` (Implemented, ADR-088)

The optional `packages[]` block attaches **multi-flow packages** — one entry
registers every flow plus the capability bundle a package ships, pinned to a
single per-package tag. Process contract:
[`system-analytics/packages.md`](system-analytics/packages.md).

```yaml
packages:
  - id: aif # capabilityRefId shape (SAFE_PATH_SEGMENT)
    source: github.com/org/maister-plugins # git monorepo URL or file:///abs/dir
    version: aif/v2.0.0 # per-package tag; "/" ALLOWED here
    path: packages/aif # optional subdir of the source (monorepo)
```

| Field     | Rule                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `capabilityRefIdSchema` (SAFE_PATH_SEGMENT). Unique within the file AND across `flows[]` ∪ `capability_imports[]` ∪ `packages[]` (cross-list collision → `CONFIG`).                                                                         |
| `source`  | Git URL (cloned `--branch <version> --depth 1`) or a `file://`/absolute local directory (local versions / dogfood).                                                                                                                         |
| `version` | Per-package tag, slash allowed: `/^[A-Za-z0-9._+/-]+$/`, no `..`, ≤ 128 chars. NOT `versionTagSchema` — member sub-installs receive the path-safe label (`/` → `-`); the raw tag is used only for `git clone --branch` and the package row. |
| `path`    | Optional package subdir inside the source (escape-guarded relative path; no `..`/absolute). Defaults to the source root.                                                                                                                    |

Bootstrap semantics: registration runs the SAME pipeline as the UI surface —
`installPackageRevision` (one platform `package_installs` row per resolved
revision; every member sub-install records that revision) followed by
`attachPackage` (attachment group + `package_install_id` FK links +
mcp/restriction ingestion) — so a bootstrapped package appears on the
packages tab and is manageable (detach/upgrade/trust) immediately after
registration. The runtime source of truth is the DB (UI
attach/detach/upgrade), and each mutation **writes the pin back** to this
file (comment-preserving, atomic) so the project can be re-raised on another
MAIster instance from git alone.

#### `maister-package.yaml` v1 (Implemented, ADR-088)

The package manifest at the package root (inside the package repo — not a
project file). Loader: `loadMaisterPackageManifest` (`CONFIG` on any reject).

```yaml
schemaVersion: 1
name: aif # MUST equal the packages[] consumer's expectations; capabilityRefId shape
metadata: { title, summary, links, sources } # optional package frontmatter
flows:
  - { id: aif-dev, path: flows/dev } # id MUST equal the flow.yaml `name` (CONFIG mismatch)
capabilities:
  - { id: aif-bundle, path: capability }
mcps:
  [] # MCP server templates: {id, transport: stdio|http,
  #  command?/args?/url?, env: env:NAME refs ONLY, description?}
restrictions:
  [] # path-sets: {id, paths: [globs]} → ingested as
  #  flow-package-scoped restriction capability records on attach
```

Rules: all `path` values are escape-guarded relative subpaths; ids unique per
section; `mcps[].env` values MUST match `/^env:[A-Z0-9_]+$/` (secret values
are never stored — same convention as `platform_mcp_servers`). There is NO
`version` field — the git tag is the only pin (ADR-021 semantics).

**`result_profiles` (Designed — [ADR-165](decisions.md#adr-165-governed-recursive-agent-harness--public-run-results-result-profiles-effective-recursion-bounds-result-only-completion)).**
An optional package-level block declaring NAMED public result contracts for
delegated **agent** children:

```yaml
result_profiles:
  research:
    schema: ./schemas/research-result.v1.json   # package-root JSON form_schema doc
```

Profile names match `/^[A-Za-z0-9._-]{1,64}$/`; each entry is `.strict()` (one
key, `schema`) like the rest of this manifest. The schema must be a package-root
`./schemas/*.json` document — install already copies package-root `schemas/`
into every member flow's install dir, so nothing new is materialized. At install
the map is resolved (read, hashed, floor-checked) and written to
`flow_revisions.result_profiles` for every member flow in the SAME statement that
writes the revision; an unreadable, malformed, escaping, or below-floor schema
fails the install with `FLOW_INSTALL` and no partial map. At delegation
`resultProfile` is a NAME resolved against the PARENT run's pinned revision —
never a path. See [`flow-dsl.md`](flow-dsl.md) §`result_profiles` and
[`system-analytics/run-results.md`](system-analytics/run-results.md).

#### Authored capability catalog (Implemented)

Authored rules, skills, and flows are created through MAIster's DB/API surface,
not through `maister.yaml`. Local `Published` means visible inside this MAIster
instance only; external catalog PR publication and two-way sync are later work.
Published authored rules/skills project into `capability_records` as
`source='project'` with `material.origin='authored'`. Authored flow publication
stores immutable local catalog content only and does not mutate `flows`,
`flow_revisions`, project enablement, install caches, or `setup.sh` trust state.

See [`system-analytics/capability-catalog.md`](system-analytics/capability-catalog.md)
and [ADR-061](decisions.md#adr-061-local-authored-capability-catalog-lifecycle).

Authored Flow packages store their editable body in
`authored_capability_revisions.body`, not in `maister.yaml`. The body contains
raw `flow.yaml`, parsed manifest when available, package metadata, typed package
files, and validation status. Draft save may persist invalid content, but local
publish/export/install requires a valid package:

- `flow.yaml` parses and validates as schemaVersion 1.
- graph/transition/gate/artifact validation passes.
- package file paths are safe relative text paths: no absolute paths, no
  `..` segments, no duplicate normalized paths, and no file-vs-directory
  collisions.
- package file content is valid UTF-8 text; binary payloads are refused.
- setup/script artifacts remain inert until the trust-gated setup lifecycle
  (ADR-021).

The platform `/flows` UI and actions use project-scoped `manageCatalog` for
create, edit, publish, import, and export. Project admin/owner is sufficient
even when the user's global role is only `member`; global `admin` continues to
work through the existing project-role bypass. User-facing status and enum text
is localized through EN/RU message keys.

Portable authored package files may include:

| Kind               | Typical path                            | Executed by authoring? |
| ------------------ | --------------------------------------- | ---------------------- |
| `readme`           | `README.md`                             | no                     |
| `setup`            | `setup.sh`                              | no                     |
| `schema`           | `schemas/*.json`                        | no                     |
| `skill`            | `skills/<id>/SKILL.md`                  | no                     |
| `rule`             | `rules/*.md`                            | no                     |
| `agent_definition` | `agents/*.md` or adapter-specific files | no                     |
| `script`           | `scripts/*`                             | no                     |
| `template`         | `templates/*`                           | no                     |
| `asset`            | unclassified portable text files        | no                     |

Export writes portable bytes only. Install, trust, setup, enablement, and launch
remain Flow package lifecycle operations.

Operational CLIs use the same package body and validation boundary:

- `pnpm --filter maister-web validate-authored-flow --source-dir <dir>` reads a
  portable directory and fails with `CONFIG` when `flow.yaml` or package files
  are invalid.
- `pnpm --filter maister-web import-flow-package-draft --project <slug>
--source-dir <dir>` creates a Draft authored Flow from portable bytes. It
  does not install a package, execute setup, or trust executable content.
- `pnpm --filter maister-web export-authored-flow --project <slug> (--cap-id
<id> | --slug <package-slug>) --output-dir <dir>` writes `flow.yaml` plus
  typed package files through temp + rename and refuses invalid bodies.
- `pnpm --filter maister-web install-authored-flow-package --project <slug>
--source-dir <dir> --version <label> --flow-id <id>` bridges exported bytes
  into the installed package lifecycle as `trust_status='untrusted'` and
  `enablement_state='Installed'`; setup and enablement remain explicit follow-up
  lifecycle actions.

#### `capabilities.agent_definitions[]` and `capabilities.env_profiles[]` (Implemented)

Two new arrays extend the existing `capabilities` block. Both follow the same
shape as `capabilities.mcps[]` / `capabilities.skills[]` but cover the
`agent_definition` and `env_profile` capability kinds.

| Array                              | Kind               | Purpose                                                                                                                                    |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `capabilities.agent_definitions[]` | `agent_definition` | Named agent configuration profiles (e.g. a `claude-strict` settings profile).                                                              |
| `capabilities.env_profiles[]`      | `env_profile`      | Named environment variable profiles; the agent receives env-var **names** only — never stored in `material` nor written into the worktree. |

These kinds flow through the existing `resolver` / `materializer` generically.
`env_profile` MCP servers are delivered over ACP `newSession params.mcpServers`
carrying env-var **names** only; the supervisor resolves each name→value from its
own `process.env` at session start (ADR-044). No secret value is ever written to
disk or carried on the wire (R-SECRET).

### Planned Flow package lifecycle

The package revision lifecycle (ADR-021) keeps `maister.yaml` as the
project-desired Flow list but moves package
state into MAIster's database and UI. The file declares desired ids, sources,
version labels, and optional executor overrides. Runtime package records store
resolved revisions, manifest digests, compatibility results, trust decisions,
setup status, enablement, upgrade history, and rollback targets.

The important boundary: editing `maister.yaml` can propose a package install or
upgrade, but it does not silently trust, enable, run setup, or mutate active
runs. The operator reviews package metadata in the UI first. New runs use the
project's enabled package revision; active runs keep their snapshotted
`runs.flow_revision`.

### Capability registry for scratch runs and Flow profiles

Scratch runs use the first implemented subset of the capability model:
platform MCP servers from `.mcp.json` plus project-visible MCP servers, skills,
rules, and restrictions from `maister.yaml`. These records are persisted to
`capability_records` during project registration, selected in the scratch
launcher, and snapshotted into a run-scoped profile before the supervisor
session starts. Flow graph node settings capability refs are validated against
this registry at launch and resolved to concrete agent artifacts at runtime
(**Implemented** — see ADR-041; capability config is delivered to the claude
agent via `<worktree>/.claude/settings.local.json` + ACP `newSession`
`params.mcpServers`, the corrected channel per ADR-044, after the CLI-flag
mechanism was disproven). The `instructed → enforced` flip remains **deferred**,
gated on the ADR-042 live-adapter spike. Public marketplace, organization policy,
and cross-project promotion stay deferred (Phase 2).

Each capability record has:

| Field                  | Purpose                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | Stable name referenced by Flow node settings.                                                                                                                                    |
| `kind`                 | One of `mcp`, `skill`, `rule`, `tool`, `setting`, `agent_definition`, `env_profile`, `restriction`.                                                                              |
| `source`               | Launch source after normalization: `platform`, `project`, or `flow-package`. `maister.yaml` accepts `project`, `flow`, `git`, `local`, `system`, `platform`, and `flow-package`. |
| `version` / `revision` | User pin and resolved immutable revision when external.                                                                                                                          |
| `agents`               | Supported executor agent ids, with optional concrete per-agent mapping.                                                                                                          |
| `selectable`           | Whether the record can be selected for future launches; CLEAR disables old rows without deleting historic profile snapshots.                                                     |
| `enforceability`       | `enforced`, `instructed`, or `unsupported` for the selected executor.                                                                                                            |

Runtime must snapshot the resolved capability profile into the run ledger before
an AI node starts. If a node requires strict enforcement but the selected
executor can only receive that capability as an instruction, launch fails rather
than silently weakening the boundary.

### Flow role registry

`flow_roles[]` is the project-local registry for human-work routing labels
(ADR-040).
It accepts:

| Field         | Rule                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| `ref`         | Required safe id (`A-Z`, `a-z`, digits, `.`, `_`, `-`). Unique within the project config. |
| `label`       | Optional display label. Defaults to `ref` when persisted.                                 |
| `description` | Optional operator-facing explanation.                                                     |

When a project declares at least one `flow_roles[]` entry, Flow install
validates every graph `finish.human.role` and human-node `settings.roles[]`
against that registry and rejects unknown refs with `CONFIG`. Removing a role
from `maister.yaml` archives the DB row; re-adding the same ref reactivates it.

For compatibility, omitted or empty `flow_roles[]` does not enforce existing
role annotations in older Flow packages. New projects that use role-owned
queues should declare the registry explicitly.

For scratch runs, the web tier owns scoped materialization. V1 writes
`profile.json` and `instructions.md` into the run workspace/runtime area,
persists the profile snapshot, then calls the supervisor with
`capabilityProfilePath` and constrained `adapterLaunch.env` pointing at those
files. The supervisor does not read `maister.yaml` capability policy and does
not decide trust. Adapter-specific MCP config, settings files, and skill loader
wiring are designed follow-up work.

For a fresh per-node AI session, the Flow runner uses the same materializer. For
a long-living ACP session, those files are session-wide: every AI node inside
the session must use the same resolved capability profile. A Flow that needs a
different profile must declare a new session boundary, unless the adapter
supports an explicit safe profile-swap operation.

#### Capability adapter support matrix (Implemented snapshot + designed native activation)

| Capability kind                       | Claude                                                       | Codex                                                        | V1 contract                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP                                   | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Snapshot + instruction handoff is implemented. Adapter-specific MCP config generation is designed, not implemented. Enforced unsupported entries are refused. |
| Skill                                 | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Snapshot + instruction handoff is implemented. Adapter-native skill loading is designed, not implemented; enforced unsupported entries are refused.           |
| Rule                                  | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Instructed-only in V1.                                                                                                                                        |
| Agent settings                        | Not materialized in V1.                                      | Not materialized in V1.                                      | Designed follow-up. Unknown enforced settings are refused.                                                                                                    |
| Restriction                           | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Enforced unsupported restrictions are refused; optional unsupported restrictions are downgraded only when recorded in the profile.                            |
| Tool / agent definition / env profile | Not activated directly.                                      | Not activated directly.                                      | Refused as enforced capabilities in v1. Optional entries become instructed-only only when the profile records the downgrade.                                  |

### Planned external operations configuration

External operations (ADR-045/046/047) are configured from the MAIster UI and
database, not
from `maister.yaml`. API tokens are service credentials; putting token secrets
or token hashes in a project repo would make rotation and audit worse.

Each API token record has:

| Field                       | Purpose                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | Internal stable identifier used for audit and gate reports.                                                                                                                                                                                                                        |
| `name`                      | Human-readable label shown in Project Settings.                                                                                                                                                                                                                                    |
| `prefix`                    | Non-secret token prefix shown after creation for identification.                                                                                                                                                                                                                   |
| `token_hash`                | SHA-256 hash of the token secret. The raw secret is shown once.                                                                                                                                                                                                                    |
| `project_id`                | The only project the token can operate on.                                                                                                                                                                                                                                         |
| `scopes`                    | Enforced allow-list for `/api/v1/ext` and MCP calls (default `["*"]`). `*` grants the full project API for broad automation; otherwise the route/tool's required scope must be present. The same value is recorded in audit as `scope_used` (see [ADR-046](decisions.md#adr-046)). |
| `expires_at`                | Optional expiry. Expired tokens fail closed.                                                                                                                                                                                                                                       |
| `revoked_at`                | Revocation timestamp. Revoked tokens fail closed.                                                                                                                                                                                                                                  |
| `created_by` / `created_at` | Operator and time that created the token.                                                                                                                                                                                                                                          |
| `last_used_at`              | Last accepted request/tool call timestamp.                                                                                                                                                                                                                                         |

The thin MCP facade uses the same token/scopes or a local session credential
that resolves to the same internal token actor. MCP configuration may expose the
MAIster API base URL and token to an agent process, but MCP never owns a
separate authorization model.

### Cross-reference checks

`loadProjectConfig()` runs these after schema validation:

1. `project.default_runner`, when not `inherit`, must reference a platform
   runner or create an explicit reconfiguration requirement before project
   enablement/launch.
2. Every `flows[].runner`, when not `inherit`, must reference a platform runner
   or create an explicit reconfiguration requirement before project Flow
   attachment is enabled.
3. No duplicate flow IDs; no duplicate `capability_imports[].id`.
4. **(Implemented)** Every Flow node settings capability reference
   (`mcps[]`, `skills[]`, `restrictions[]`, `settingsProfile`, `tools.{claude|codex}`)
   must resolve to a project, Flow-shipped, or system capability record. An
   unknown ref, or a ref present in the registry but not supported by the
   resolved runner's `capability_agent`, throws
   `MaisterError({ code: "CONFIG" })`. This is the "carve-b" validation
   described in ADR-041.

Any failure throws `MaisterError({ code: "CONFIG" })` with the offending
field path in the message.

### ACP runner resolution

Highest priority wins. The chain is six tiers:

1. **Launch override** (`POST /api/runs body.runnerId` or scratch
   `runnerId`).
2. **AI-coding step target** (`nodes[].runner`, for `runner_type: acp`).
3. **Project Flow default** (`flows[].runner` attachment override).
4. **Platform Flow default** (platform Flow catalog default).
5. **Project default** (`project.default_runner`).
6. **Platform default** (`platform.default_runner`).

Task creation does not select a runner. A task captures title, prompt, and Flow;
one-run runner override belongs only to the workspace/run launch dialog.

The pure resolver returns `{ runnerId, tier }`. Runtime hydration then adds the
adapter-registry-derived `capability_agent` and an immutable `runner_snapshot`.
If a referenced runner id is missing, disabled, not ready, or unsupported for
the selected provider/policy/sidecar combination, launch refuses before
worktree creation, run/workspace DB writes, or supervisor spawn. Missing
Flow-node runner ids create a required reconfiguration requirement; they never
silently fall through to lower tiers.

## `flow.yaml` v1

The manifest each Flow plugin ships in its git repo.

```yaml
schemaVersion: 1
name: Bugfix
metadata: # optional: routing hints + provenance, additive + runner-ignored
  title: "AIF — Bugfix" #   (stored verbatim in flow_revisions.manifest)
  summary: "Fast bug loop: fix → checks → review → commit."
  labels: [bug, hotfix] # machine routing hints
  route_when: "a reported bug/error to fix" # NL hint for an LLM router
  links: # each (strict): { kind?, title, url }
    - {
        kind: docs,
        title: "Dev Workflow",
        url: "https://github.com/lee-to/ai-factory",
      }
  sources: # each (strict): { component, origin }
    - {
        component: "skills/aif-*, agents/*",
        origin: "github.com/lee-to/ai-factory@2.x",
      }
runner_type: acp # optional, defaults to acp today
runner: claude-code # optional platform ACP target
setup: ./setup.sh # optional one-time install hook
# Optional package contract (ADR-021): recorded + displayed as opaque
# metadata. Only `compat` + `schemaVersion` are ENFORCED at enablement;
# capabilities/gates/artifacts/external_ops gained runtime meaning in later engine work.
compat: # optional engine compatibility range
  engine_min: 3.0.0
capabilities: [shell, edit] # optional opaque string list
gates: [] # optional opaque string list
artifacts: [diff, human_note] # optional opaque string list
external_ops: [] # optional opaque string list
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: "/aif-plan {{ task.prompt }}"
    transitions:
      success: review
  - id: review
    type: human
    finish:
      human:
        decisions: [approve, rework]
    transitions:
      rework: plan
    rework:
      allowedTargets: [plan]
      workspacePolicies: [keep]
      maxLoops: 3
      commentsVar: review_comments
```

### Node types

`nodes[]` is a closed discriminated union covering runner-bearing actions,
CLI/check/judge work, forms, human review, gates, merge, orchestration, and
consensus. Type-specific fields and lifecycle rules are defined in
[`flow-dsl.md`](flow-dsl.md). A top-level `steps` key is rejected by engine 3.

`retry_safe` (boolean, default `false`) is accepted on graph nodes. It
gates operator crash-recovery re-dispatch of a session-less node — a `Crashed`
run whose recover target is session-less (`cli`/`check`/`judge`/`guard`/`human`)
is redispatch-recoverable only when its config declares `retry_safe: true`;
`ai_coding` ignores it (recovered via `session/resume`). See
[ADR-034](decisions.md#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)
and [`flow-dsl.md`](flow-dsl.md).

### Node `settings` (typed)

Every Flow graph node carries an **optional** typed `settings` block. The block
is discriminated on node type and replaces the earlier opaque passthrough — the
shape is now validated, not passed through verbatim. `settings` is OPTIONAL on
**every** node type: a node with no `settings` validates and runs unchanged, and
absence of `settings` NEVER triggers a launch refusal (back-compat). Settings
ride in the pinned `flow_revisions.manifest` — no separate file, env var, or
sidecar. Validation lives in `web/lib/config.schema.ts`; failures throw
`MaisterError({ code: "CONFIG" })`.

Status (Implemented): the typed shape, node-level validation, the launch-time
refusal boundary, the `enforcement` evaluator + `enforcement_snapshot` audit
record, the time-limit watchdog, capability-reference resolution, agent-aware
name mapping, and per-session native materialization (delivery channel:
`<worktree>/.claude/settings.local.json` + ACP `newSession` `params.mcpServers`,
ADR-044). `tools`/`mcps`/`hooks` are **enforced** at the supervisor ACP seam
(`capability_guard`, [ADR-130](decisions.md#adr-130)); `skills`/`restrictions`/
`permissionMode` stay `instructed` permanently. Field-by-field semantics and
the enforcement table: [`system-analytics/flow-settings.md`](system-analytics/flow-settings.md)
(see [ADR-031](decisions.md#adr-031)/[ADR-032](decisions.md#adr-032)).

**Per-adapter capability materialization (Implemented).** Claude/Gemini use
cwd-discovered workspace dirs; Codex is home-redirected through a per-session
`CODEX_HOME` (`web/lib/capabilities/adapter-home.ts`). The full per-adapter
matrix lives in [`system-analytics/acp-runners.md`](system-analytics/acp-runners.md)
and [`supervisor.md`](supervisor.md) — not restated here (R7).

**`ai_coding` / `judge` settings** (agent-capability shape):

`judge` carries the same capability shape MINUS `runner_type`, `runner`,
`settingsProfile`, `workspaceAccess`, and `artifactAccess` — those five are
`ai_coding`-only. The shared subset is `model`, `thinkingEffort`, `mcps`,
`tools`, `skills`, `permissionMode`, `limits`, `restrictions`, and
`enforcement`. `.strict()` parsing rejects any of the five `ai_coding`-only
fields on a `judge` node.

| Field             | Type                                                                                                                                      | Notes                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_type`     | `acp`                                                                                                                                     | **`ai_coding` only.** Defaults to `acp` in this slice. Future runner families can extend this without redefining ACP semantics.                                                                                                                                         |
| `runner`          | `string`                                                                                                                                  | **`ai_coding` only.** For `runner_type: acp`, a platform ACP runner target or package-local target that must be remapped during Flow load/attach.                                                                                                                       |
| `model`           | `string`                                                                                                                                  | Free-form model override.                                                                                                                                                                                                                                               |
| `thinkingEffort`  | `low \| medium \| high`                                                                                                                   | Unknown value rejected.                                                                                                                                                                                                                                                 |
| `mcps`            | `string[]`                                                                                                                                | Capability class. Registry resolution against `capability_records` at validate/launch is **Implemented (ADR-041)**.                                                                                                                                                     |
| `tools`           | `{ claude?: string[]; codex?: string[] }`                                                                                                 | Per-agent tool map; malformed map rejected. Capability class. Registry resolution is **Implemented (ADR-041)**.                                                                                                                                                         |
| `skills`          | `string[]`                                                                                                                                | Capability class. Registry resolution is **Implemented (ADR-041)**.                                                                                                                                                                                                     |
| `settingsProfile` | `string`                                                                                                                                  | **`ai_coding` only.** Named `agent_definition` capability reference. Registry resolution is **Implemented (ADR-041)**.                                                                                                                                                  |
| `workspaceAccess` | `read \| write \| none`                                                                                                                   | **`ai_coding` only.** Capability class.                                                                                                                                                                                                                                 |
| `artifactAccess`  | `string[]`                                                                                                                                | **`ai_coding` only.** Artifact ids the node may read/write.                                                                                                                                                                                                             |
| `permissionMode`  | `ask \| allow \| deny`                                                                                                                    | Capability class. Unknown value rejected.                                                                                                                                                                                                                               |
| `limits`          | `{ maxDurationMinutes?: number > 0; maxCostUsd?: number > 0 }`                                                                            | Out-of-range rejected. `maxDurationMinutes` is the watchdog cap (below); `maxCostUsd` is record-only.                                                                                                                                                                   |
| `restrictions`    | `string[]`                                                                                                                                | Capability class. Registry resolution is **Implemented (ADR-041)**.                                                                                                                                                                                                     |
| `hooks`           | `{ disabled?: boolean; repetition?: { max: number > 0 }; noProgress?: { maxTurns: number > 0 }; pathGuard?: { allowedPaths: string[] } }` | **(Designed — ADR-108.)** Capability class. Per-tool-call guardrail rules enforced at the supervisor↔ACP seam; requires `compat.engine_min >= 1.8.0`. See [`flow-dsl.md`](flow-dsl.md) + [`system-analytics/guardrail-hooks.md`](system-analytics/guardrail-hooks.md). |
| `enforcement`     | `{ mcps?; tools?; skills?; restrictions?; permissionMode?; workspaceAccess?; hooks? }`                                                    | Per-class intent — see below.                                                                                                                                                                                                                                           |

**`human` settings** (decision/role/takeover shape):

| Field                | Type                                | Notes                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`              | `string[]`                          | Eligible reviewer roles. Role refs are NOT validated against a registry at settings validation.                                                                                                                                                                                                                                                                                             |
| `assignees`          | `string[]`                          | Specific assignees.                                                                                                                                                                                                                                                                                                                                                                         |
| `decisions`          | `string[]`                          | Each value MUST appear in the node's `transitions`.                                                                                                                                                                                                                                                                                                                                         |
| `allowFurtherTracks` | `boolean`                           | Permit spawning further tracks.                                                                                                                                                                                                                                                                                                                                                             |
| `allowTakeover`      | `boolean`                           | Permit manual takeover.                                                                                                                                                                                                                                                                                                                                                                     |
| `slaHours`           | `number > 0`                        | Out-of-range rejected.                                                                                                                                                                                                                                                                                                                                                                      |
| `stalenessHint`      | `string`                            | Hint surfaced when downstream goes stale.                                                                                                                                                                                                                                                                                                                                                   |
| `returnRequires`     | `string[]`                          | Conditions required before returning.                                                                                                                                                                                                                                                                                                                                                       |
| `criticality`        | `low \| medium \| high \| critical` | **(Implemented.)** Flow-author-declared severity. Optional; additive — no `MAISTER_ENGINE_VERSION` bump (stays 1.2.0). Stored write-once on `hitl_requests.criticality` at HITL row creation; absent means no severity declared. Responder `confidence` is a response-time value supplied in the answer body — it cannot be pre-declared here. See [`flow-dsl.md`](flow-dsl.md#human-step). |

**`cli` / `check` settings** (command shape):

| Field               | Type                                | Notes                   |
| ------------------- | ----------------------------------- | ----------------------- |
| `command`           | `string`                            | Command to run.         |
| `timeoutMs`         | `number > 0`                        | Out-of-range rejected.  |
| `environmentPolicy` | `inherit \| clean \| whitelist`     | Unknown value rejected. |
| `inputArtifacts`    | `string[]`                          | Artifact ids consumed.  |
| `outputArtifacts`   | `string[]`                          | Artifact ids produced.  |
| `failureClass`      | `blocking \| advisory \| retryable` | Unknown value rejected. |

#### `enforcement` intent + the static enforceability table

`settings.enforcement` declares, per capability class (`mcps`, `tools`,
`skills`, `restrictions`, `permissionMode`, `workspaceAccess`, `hooks`), how
strictly the class must hold:

| Value      | Meaning                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `strict`   | The class MUST be enforced; launch refuses if the build cannot enforce it. |
| `instruct` | **Default.** The class is passed to the agent as an instruction.           |
| `off`      | The class is omitted from the verdict set.                                 |

At launch, each `strict` class is checked against `ENFORCEABILITY_BY_AGENT` — a
**code constant** in `web/lib/flows/enforcement.ts` (NOT an env var, port, or
config-file path), keyed by `agent × capabilityClass`. Originally every cell was
`instructed`, so any `strict` declaration is `refused` and launch throws
(`CONFIG`, or `EXECUTOR_UNAVAILABLE` once capability materialization — ADR-041 —
flips cells). A flip only ever goes
`instructed → enforced`; the contract tightens, never loosens. The table and the
`evaluateNodeEnforcement` truth table are FROZEN in
[`system-analytics/flow-settings.md`](system-analytics/flow-settings.md) — that
file is canonical; do not duplicate them here.

The `limits.maxDurationMinutes` watchdog is agent-agnostic and inherently
enforced — it is NOT subject to the `strict`/`instruct` table. A run whose
elapsed exceeds the cap is terminated `Failed` via the supervisor's existing
`DELETE /sessions/:id`.

**Per-path write scope is instructed-only (Phase 2).** A `restrictions`
path-set ("tester edits only tests") is passed to the agent as an instruction;
maister enforces only read-only-vs-full at the workspace axis
(`workspace: repo_read | worktree`), never per-path writes. Real path-scoped
enforcement needs the deferred policy layer. Consistent with the frozen table, a
`restrictions: strict` declaration is refused at launch (`CONFIG`); a plain
`restrictions` list or `restrictions: instruct` ships instructed-only. See
[ADR-099](decisions.md#adr-099-persistent-swarm-layer-2--addressable-sessions-star-routed-messaging-worktree-modes-per-agent-read-only).

### Cross-reference checks

`loadFlowManifest()` runs:

1. No duplicate node IDs.
2. Every transition and bounded rework target references an existing node or
   the terminal `done` target.

For `runner_type: acp`, a top-level or node-level `runner` is a non-empty
string. Its existence in platform runners is validated during platform Flow
load and project Flow attachment. A missing id creates a required
reconfiguration requirement; the manifest can still be loaded standalone for
testing.

### Package contract + compatibility (ADR-021)

`compat`, `capabilities`, `gates`, `artifacts`, and `external_ops` are optional.
They are parsed, digested into `flow_revisions.manifest_digest`, recorded in
`flow_revisions.contract`, and surfaced in the Flow Packages UI. Enablement and
launch ENFORCE only two compatibility checks (`web/lib/flows/engine-version.ts`):
the manifest `schemaVersion` must be in `SUPPORTED_FLOW_SCHEMA_VERSIONS`, and
`MAISTER_ENGINE_VERSION` must fall within `compat.engine_min..engine_max`.
Incompatibility surfaces as `CONFIG` (422). Semantic validation of the opaque
contract lists is deferred to the milestone that introduces each concept (see
[ADR-021](decisions.md#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)).

**Engine floors.** `MAISTER_ENGINE_VERSION` is a **code constant, not an env
var** (`web/lib/flows/engine-version.ts`); its header comment is the canonical
bump log — one entry per capability floor (graph `nodes[]` 1.1.0 → … →
graph-only cut-over 3.0.0 → context mounts 3.4.0). A flow declaring a floored
capability MUST set `compat.engine_min` accordingly; each floor's rationale
lives in the ADR the comment names. `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays
`[1]`.

**Default vs declared artifacts.** DEFAULT artifact recording — the run log,
guard metrics, the human/form answer, and the diff — is captured for **all
runs with no manifest changes**. The DECLARED-artifact contract — typed
`output.produces` / `input.requires` validation plus the `artifact_required`
gate — is opt-in and requires `compat.engine_min ≥ 1.2.0`.

**Runtime-root deployment precondition (Implemented).** `MAISTER_RUNTIME_ROOT`
must resolve **outside** every registered `repo_path` so checkpoint
rewind/discard (`git clean -fd`) can never reach the run-artifact tree
(`runtimeRoot/.maister/<slug>/runs/<runId>/`); the containment assert
(`containmentAssert` in `workspace-checkpoint.ts` + the `discardWorktree`
guard) hard-blocks any policy run with `MaisterError("PRECONDITION")` when
violated. The checkpoint ref namespaces `refs/maister/checkpoints/*` and
`refs/maister/chat-checkpoints/*` are git refs, not env.

### Verdict calibration

`ai_judgment` and `skill_check` gates may declare a confidence threshold so a passing
verdict only clears when the agent is sufficiently confident. Two config surfaces:

- **Per-gate** `calibration` (only valid on `ai_judgment` / `skill_check` gates):

  ```yaml
  pre_finish:
    gates:
      - id: quality
        kind: ai_judgment
        mode: blocking
        prompt: 'Assess the diff; reply {"verdict":...,"confidence":0-1,...}.'
        calibration:
          confidence_min: 0.8 # 0..1; a pass below this → gate failed
          allow_missing_confidence: false # default false (fail-closed); see below
  ```

- **Flow-level** `verdict_calibration.confidence_min` — a default folded into every
  `ai_judgment` / `skill_check` gate that lacks its own `calibration.confidence_min`, at
  compile time (`web/lib/flows/graph/compile.ts`):

  ```yaml
  schemaVersion: 1
  name: aif
  verdict_calibration:
    confidence_min: 0.7 # per-gate calibration.confidence_min overrides this
  ```

Calibration is applied **at gate execution** and decides the persisted
`gate_results.status` (the readiness layer only ever reads `status`). The full outcome
matrix — every `(passing verdict, threshold, confidence, allow_missing_confidence)`
combination and the `verdict.calibration.outcome` string it records — is the canonical
**calibration truth table** in
[`system-analytics/readiness.md` → Verdict calibration at gate execution](system-analytics/readiness.md#verdict-calibration-at-gate-execution-ai_judgment--skill_check);
it is not restated here so the two surfaces cannot drift.

Fail-closed is the rule: a promotion-relevant gate must not pass an unverifiable verdict.
Set `allow_missing_confidence: true` only for gates that legitimately emit no `confidence` —
it rescues an _absent_ confidence, never one _present_ but out of the `0..1` domain. A
`blocking` `human_review` gate is rejected at validation (`CONFIG`) — it would deadlock
promotion.

### Guard semantics

`cost` / `time` / `regex` guard fields are parsed and evaluated; results are
written to `.maister/<slug>/runs/<run-id>/guards.jsonl`, with cost compared
against `cost.jsonl` token totals. Enforcement status: token budgets terminate
via the execution-policy ladder (`BUDGET_EXCEEDED`, ADR-101/125) and
`limits.maxDurationMinutes` terminates via the time-limit watchdog; `regex`
guards (and the declared `limits.maxCostUsd`) remain observational —
record-only, no kill (tracked in the roadmap Backlog).

## `form_schema` versioning

Every HITL form payload includes a required `schemaVersion` integer. The
runtime compares this against the version the graph node
expected; mismatch → `MaisterError({ code: "CONFIG" })`.

```ts
import { validateFormSchemaVersion } from "@/lib/config";

validateFormSchemaVersion(readBackJson, 1); // ok if readBackJson.schemaVersion === 1
validateFormSchemaVersion(readBackJson, 2); // throws CONFIG with both versions named
```

Schema shape:

```yaml
schemaVersion: 1
fields:
  - name: comment
    label: Reviewer comment
    type: string # string | number | boolean | enum | array
    required: true
  - name: severity
    type: enum
    options: [low, medium, high]
  - name: confirm
    type: boolean
    default: false
```

Field types are limited to `string | number | boolean | enum | array`.
Add new types by extending `formFieldSchema` in
`web/lib/config.schema.ts`.

## Environment variables (server tier)

Read by Next.js (`web/`) and `supervisor/` at startup:

| Var                                            | Required                                                             | Default                                                           | Used by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                                  | yes                                                                  | —                                                                 | Auth.js v5 session JWT signing. Generate with `openssl rand -base64 33`. Must be identical across all web replicas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AUTH_URL`                                     | no                                                                   | derived from request host                                         | Auth.js canonical origin (e.g. `https://maister.example.com`). Only needed when a reverse proxy rewrites the `Host` header in a way that breaks callback URLs. Leave blank in dev.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SEED_ADMIN_EMAIL`                             | no                                                                   | `admin@maister.local`                                             | `pnpm db:seed` — email for the initial admin user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SEED_ADMIN_PASSWORD`                          | no                                                                   | `maister-admin`                                                   | `pnpm db:seed` — password for the initial admin user. Change before any shared use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MAISTER_TEMP_PASSWORD_LENGTH`                 | no                                                                   | `12`                                                              | Web tier. Length of admin-provisioned auto-generated one-time temp passwords (clamped to a minimum of 12). Governs GENERATED passwords only — admin-typed passwords keep the 12-character minimum. Read server-side by the web tier; never logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DB_URL`                                       | yes                                                                  | —                                                                 | `lib/db/client.ts`; accepts only `postgres://...` or `postgresql://...`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MAISTER_DB_POOL_MAX`                          | no                                                                   | `10`                                                              | Postgres pool size in `lib/db/client.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAISTER_CLI_INHERIT_ENV`                      | no                                                                   | off                                                               | **(Implemented, [ADR-153](decisions.md#adr-153-flow-child-process-env-isolation--allow-listed-env-for-clicheckprobe-children).)** Web tier compatibility escape hatch: `1/true/on/yes` makes flow-spawned bash children (`cli`/`check` node commands, `command_check` gates, `requirements[]` probes) inherit the FULL web process env — including secrets — as before ADR-153, with a once-per-process warn. Default (off) gives children only the allow-listed env (`web/lib/flows/child-env.ts`). Host/service-env only; use only while migrating a package that relied on ambient env, then unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAISTER_MAX_CONCURRENT_RUNS`                  | no                                                                   | `6`                                                               | Global Flow/scratch run concurrency cap (across all projects; counts `run_kind IN ('flow','scratch')`). Scheduler `flow_run` jobs delegate to this existing launch queue instead of consuming `command` budgets. (ADR-089 — owner-requested default bump `3 → 6`; env semantics unchanged.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MAISTER_MAX_CONCURRENT_AGENTS`                | no                                                                   | `3`                                                               | **(Implemented, ADR-089.)** Separate concurrency budget for platform-agent runs (`run_kind='agent'`) enforced at `tryStartRun` with its own `Pending` FIFO — agent runs never consume Flow slots and vice versa. **Consensus (ADR-109)** also uses this ceiling for ephemeral verification/synthesis ACP sessions through an internal limiter; tokens are released in `finally` and these sessions are not `runs` rows. Repurposed from its obsolete scheduler-era meaning (SQL claim budget for `agent_tick` attempts — `agent_tick.dispatcher` is now a hardcoded-budget-1 singleton).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAISTER_MAX_AGENT_CHAIN_DEPTH`                | no                                                                   | `2`                                                               | **(Implemented — ADR-156.)** Web tier. Caps agent→agent trigger chains ACROSS and WITHIN projects. `runs.agent_chain_depth` is snapshotted at launch: an agent run launched from a domain event whose `actor_type = 'agent'` inherits `parentDepth + 1`; every other trigger source (manual, cron, webhook, flow-node binding) seeds `0`. Enforced at two points — the cross-project reach check (`canAgentReachProject`) denies with an existence-hiding 404 + audited WARN `reason: "chain_depth_exhausted"`, and the agent-launch-from-agent-authored-event path refuses the launch, WARNs, and skips the candidate rather than throwing (the consumer's idempotent contract). Closes BOTH ping-pong hazards: cross-project A→B→A, and the same-project A↔B pair that existing self-exclusion (own events only) does not cover. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)).                                                                                                                                                                                                                                                                                                                                        |
| `MAISTER_CONTEXT_MOUNT_ENABLED`                | no                                                                   | `true`                                                            | **(Implemented — ADR-157.)** Web tier. Platform kill switch for read-only sibling-repo context mounts. Default on (unset ⇒ on); off stops NEW mount materialization — a flow node's `settings.context_repos` and an attachment's `context_repos` resolve to no mounts and the session launches without them. In-flight runs keep the mounts they already snapshotted on `runs.context_mounts`, and the terminal/GC release paths keep working off that snapshot. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MAISTER_CONTEXT_REPOS`                        | no (derived — never set by hand)                                     | derived per session                                               | **(Implemented — ADR-157.)** Supervisor → ACP adapter child. JSON array of the resolved sibling mounts, e.g. `[{"slug":"api","path":"/abs/mount","ref":"main","commit":"<sha40>"}]`. Derived by the supervisor from the first-class `contextMounts[]` field on `POST /sessions` — NOT an `executor.env` entry (that is the provider-secret channel), and never operator-authored. Injected into the ACP child ONLY: it is deliberately absent from the [ADR-153](decisions.md#adr-153-flow-child-process-env-isolation--allow-listed-env-for-clicheckprobe-children) allow-list, so `cli`/`check`/gate/probe children never see it — matching the DSL rule that `settings.context_repos` is accepted only on `ai_coding`/`judge`/`orchestrator` nodes. See [`supervisor.md`](supervisor.md) and [`flow-dsl.md`](flow-dsl.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MAISTER_MAX_CONCURRENT_COMMANDS`              | no                                                                   | `2`                                                               | **Implemented.** SQL claim budget for concurrent `command` scheduler attempts; invalid or non-positive values fall back to `2` and do not reduce or override `MAISTER_MAX_CONCURRENT_RUNS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MAISTER_MAX_CLI_TIMEOUT_MS`                   | no                                                                   | `3600000` (1 h)                                                   | **(Implemented.)** Host-wide ceiling for a cli/check node's declared `settings.timeoutMs` (see [`flow-dsl.md`](flow-dsl.md#node-actions-review-and-gates)). The effective per-command timeout is `min(settings.timeoutMs ?? 300000, ceiling)`; requests above the ceiling clamp with a warning, they never fail validation. Invalid or non-positive values fall back to `3600000`. Read by `web/lib/flows/runner-cli.ts`; host/service-env only — wired into `.env.example` + this doc, never `compose.yml` (mirrors the `MAISTER_NODE_OUTPUT_MAX_BYTES` precedent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MAISTER_TASK_QUEUE_EDGE_DRAIN`                | no                                                                   | `on`                                                              | **(Implemented, [ADR-121](decisions.md#adr-121-priority-ordered-dependency-draining-task-queue-unified-admission-gate).)** Toggles the **C2 fresh-Backlog-task** source of the unified admission gate (and the 60s `auto-launch-triaged` poll backstop). `off` ⇒ no slot-free auto-pull of NEW tasks; cap-safe resume (C3) + Pending promote (C1) + priority ordering stay ON regardless (INV-7). Accepts `on/off/true/false/1/0/yes/no` (else falls back to `on`). A project overrides per-project via `task_queue_settings.edgeDrain`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAISTER_TASK_QUEUE_AUTO_RESERVE`              | no                                                                   | `2`                                                               | **(Implemented, [ADR-121](decisions.md#adr-121-priority-ordered-dependency-draining-task-queue-unified-admission-gate).)** Flow-pool slots reserved from auto-drain — auto-drained Backlog-task runs never exceed `flowCap − reserve`, leaving guaranteed headroom for scratch/manual/resume (INV-8). `0` disables the reserve; invalid/negative values fall back to `2`. Global only (no per-project reserve).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAISTER_MAX_ORCHESTRATOR_FANOUT` | no | `16` | **(Implemented, [ADR-098](decisions.md#adr-098-orchestrator-engine--supervisory-node-governed-run-tree-delegation-toolset-success-gated-task-dag-idle-checkpoint-waitresume).)** Web tier. Per-orchestrator cap on LIVE delegated children. **(Amended — [ADR-163](decisions.md#adr-163-flow-target-delegation--carrier-task-shared-admission-canonical-flow-launcher).)** It counts live children of BOTH kinds — agent and flow — across the orchestrator's whole fan-out, not the size of one `run_plan` batch, and one shared helper enforces it on every child-creation edge (`run_delegate`, `run_plan`'s source launch, and the as-plan auto-launcher) under a per-orchestrator advisory lock held through the child run's INSERT. **(Amended — [ADR-165](decisions.md#adr-165-governed-recursive-agent-harness--public-run-results-result-profiles-effective-recursion-bounds-result-only-completion), Designed.)** For a manifest at `compat.engine_min >= 3.7.0` the node's `settings.delegation.max_fanout` is LIVE and the effective cap is `min(this env value, declared ?? 6)` — the env value is a ceiling the author can only lower. Below that floor the declaration stays ADVISORY (recorded, not read), exactly as ADR-163 left it. No new environment variable is introduced. **Consensus (ADR-109)** reuses the same helper as the hard `participants[]` cap and does not introduce a per-node raise above the host limit. An over-limit request is refused with `MaisterError({ code: "CONFIG" })` and no partial run-tree is written; `run_plan` additionally keeps a cheap batch-length pre-check so an obviously oversized batch is rejected before any resolution work. |
| `MAISTER_ORCHESTRATOR_MAX_DEPTH` | no | `3` | **(Implemented, [ADR-098](decisions.md#adr-098-orchestrator-engine--supervisory-node-governed-run-tree-delegation-toolset-success-gated-task-dag-idle-checkpoint-waitresume).)** Web tier. Run-tree recursion bound (`runs.parent_run_id` depth) for orchestrator delegation; **(Amended — [ADR-165](decisions.md#adr-165-governed-recursive-agent-harness--public-run-results-result-profiles-effective-recursion-bounds-result-only-completion), Designed.)** For a manifest at `compat.engine_min >= 3.7.0` the node's `settings.delegation.max_depth` is LIVE and the effective bound is `min(this env value, declared ?? 2)`, min-merged again with the root's and the parent's snapshots; below that floor it stays ADVISORY. The effective bounds are snapshotted on `runs.delegation_bounds` at node start, so changing this variable never alters a running tree. **Consensus (ADR-109)** draft child runs are regular run-tree children and reuse the same depth guard. Decided inside the child launcher's run-insert transaction by the one `admitDelegatedChild` helper (ADR-163) — an over-depth request is refused with `MaisterError({ code: "CONFIG" })` and nothing is written. |
| `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS`     | no                                                                   | `60`                                                              | Web: periodic reconcile sweeper interval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAISTER_RECONCILE_GRACE_SECONDS`              | no                                                                   | `90`                                                              | Web: grace window before a no-live-session agent run is crashed (protects in-flight launches/recovers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAISTER_GC_AGE_DAYS`                          | no                                                                   | `14`                                                              | Web: age before Abandoned/Done worktrees + Removed flow revisions are GC'd                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MAISTER_COST_RECONCILE_LOOKBACK_HOURS`        | no                                                                   | `168`                                                             | **(Implemented, [ADR-117](decisions.md#adr-117-reliable-cost-rollup-reconciliation-and-per-runner-cost-attribution).)** Web: lookback window (hours) for the `system_sweep` cost-rollup backstop reconcile — only runs whose `ended_at` is within this window are candidates. Floor 1. Default 168 (7d, matching the GC horizon). Read by `web/lib/instance-config.ts:costReconcileLookbackHours()`; enforced by `web/lib/runs/cost-reconcile-sweep.ts`. Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), never a compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MAISTER_RALPH_MAX_ATTEMPTS`                   | no                                                                   | `5`                                                               | **(Implemented, [ADR-095](decisions.md#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship).)** Execution-policy ralph-loop (axis A2, `crashRetry=ralph_loop` — the unattended preset): hard cap on TOTAL attempts per task (original launch + auto-relaunches) before the task holds in Backlog for a human. Floor 1. Read by `web/lib/instance-config.ts:ralphMaxAttempts()`; enforced by the `run.failed` consumer `web/lib/runs/ralph-loop.ts`. Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), never a compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAISTER_AUTO_RETRY_MAX_ATTEMPTS`              | no                                                                   | `3`                                                               | **(Implemented, [ADR-095](decisions.md#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship).)** Execution-policy in-run auto-retry (axis A2, `crashRetry=auto_retry`): hard cap on TOTAL ledger attempts for a `retry_safe` node re-dispatched in-run on a transient code (`SPAWN`/`EXECUTOR_UNAVAILABLE`/`CHECKPOINT`/`ACP_PROTOCOL`) when no per-node `retry_policy` is declared (the author's `retry_policy` wins). Floor 1. Read by `web/lib/instance-config.ts:autoRetryMaxAttempts()`; synthesizes an ADR-080 retry in `web/lib/flows/graph/runner-graph.ts`. Host/service-env only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MAISTER_BUDGET_HARD_MULTIPLIER`               | no                                                                   | `1.25`                                                            | **(Implemented, [ADR-101](decisions.md#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open).)** Execution-policy `budget` axis: the multiplier deriving a scope's TERMINATE ceiling `hardMaxTokens` from its ESCALATE ceiling `maxTokens` when `hardMaxTokens` is unset (`hardMaxTokens = maxTokens × this`). Read by the **web tier** (the keepalive-sweeper budget watchdog). Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`     | no                                                                   | unset (no default ceiling)                                        | **(Implemented, [ADR-101](decisions.md#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open).)** Execution-policy `budget` axis: when set, seeds a `tree`-scope token ceiling for an `unattended`-preset launch that declares no explicit budget (the launch dialog also shows a non-blocking hint). Unset ⇒ an unattended run stays unbounded (fail-open). Read by the **web tier**. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAISTER_HOOK_REPETITION_MAX`                  | no                                                                   | `5`                                                               | **(Designed — [ADR-108](decisions.md#adr-108-declarative-guardrailhook-engine--universal-supervisor-acp-seam-interceptor-native-materializer-seam-and-hook-trip-hitl-escalation).)** Guardrail hook engine: consecutive-identical tool-call cap before the `repetition` breaker halts. Auto-armed for `unattended`-preset runs (per-node opt-out); a node may override. Read by the **web tier** (folded into the resolved `hooksConfig`). Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MAISTER_HOOK_NO_PROGRESS_TURNS`               | no                                                                   | `15`                                                              | **(Designed — ADR-108.)** Guardrail hook engine: `sessionUpdate` turns since the last edit/diff-producing tool call before the `no_progress` breaker halts. Auto-armed for `unattended`-preset runs (per-node opt-out). Read by the **web tier**. Host/service-env only (ADR-023) — never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MAISTER_HOOK_DEFAULT_WRITABLE_PATHS`          | no                                                                   | unset (⇒ worktree root)                                           | **(Designed — ADR-108.)** Guardrail hook engine: comma-separated default writable glob set for a node that opts into `path_guard` without listing `allowedPaths`. Unset ⇒ the worktree root (the guard then denies only out-of-tree writes). `path_guard` is always opt-in. Read by the **web tier**. Host/service-env only (ADR-023) — never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD` | no                                                                   | `3`                                                               | **(Implemented — [ADR-130](decisions.md#adr-130-adapter-agnostic-capability-enforcement-at-the-acp-seam).)** `capability_guard` enforcement: number of consecutive out-of-profile tool-call denials before the seam halts the session and escalates a `hook_trip` HITL (`N`). Resolved by the **web tier** and delivered on the `enforcementProfile` (the supervisor stays config-free for the threshold, matching the `MAISTER_HOOK_REPETITION_MAX` pattern). Host/service-env only (ADR-023) — never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAISTER_GC_WARNING_DAYS`                      | no                                                                   | `2`                                                               | Web: TTL warning window before removal (color ramp)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MAISTER_GC_ARCHIVE_PUSH`                      | no                                                                   | `false`                                                           | Web: push the `maister/archive/<runId>` branch to the remote during GC preserve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAISTER_CRON_TOKEN`                           | no (empty ⇒ `/api/cron/gc` and `/api/cron/tick` return 503 disabled) | (none)                                                            | **Server-only secret** for token-guarded cron routes — never logged or streamed. The polymorphic scheduler reuses it for `GET`/`POST /api/cron/tick`; `/api/cron/gc` remains a compatibility wrapper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MAISTER_SCHEDULER_TIMER_ENABLED`              | no                                                                   | `false`                                                           | **Implemented.** Enables the single-box web-tier fallback timer when exactly `true`. External cron remains preferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS`      | no                                                                   | `60`                                                              | **Implemented.** Fallback timer cadence only; fixed-interval job cadence lives per `scheduler_jobs.cadence_interval_seconds`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS`    | no                                                                   | `300`                                                             | **Implemented.** Lease timeout for stuck `Claimed`/`Running` scheduler attempts before reaping as `Failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES`    | no                                                                   | `3`                                                               | **Implemented.** Auto-disable threshold for repeated `agent_tick` precondition/launcher failures during result recording and lease reaping; invalid or non-positive values fall back to `3`. Other job kinds use `scheduler_jobs.max_failures`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS`      | no                                                                   | `300`                                                             | **(Implemented — ADR-058, Codex F1.)** Stale-`claiming` claim reclaim window (seconds), for BOTH claim axes: a `workspaces.promotion_state='claiming'` claim older than this is reclaimable by the next promote attempt (crash recovery), which re-mints `promotion_attempt_id`, and `canReclaimLifecycle` applies the same window to a stale `lifecycle_operation_state='claiming'` slot. **(ADR-141)** It also derives the branch-sync claim heartbeat: a live sync driver refreshes `lifecycle_operation_claimed_at` every `window / 4` (floored at 1s), so lowering this makes a live sync beat proportionally more often. That heartbeat is what lets `claimed_at` mean "last known alive" rather than "claim start" — without it a sync outliving this window has its slot stolen, dropping the `name='sync'` predicate that promote's reverse fence reads. Read by the web tier's shared `promoteRun` service, `workbench-lifecycle/service.ts`, and `runs/sync-target.ts`. Host/service-env only — the default compose stays Postgres-only per [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres), so this is never a container/compose var.                                                                                                   |
| `MAISTER_AUTO_PROMOTION`                       | no                                                                   | `on`                                                              | **(Designed — [ADR-126](decisions.md#adr-126-auto-promotion-lanes).)** Platform kill switch for lane-bounded auto-promotion. `on` (default; unset ⇒ on) lets the `auto_promote` sweep evaluate `Review` flow runs; `off` stops NEW auto-promotions within one tick (in-flight `promoteRun` calls complete). Independent of and ANDed with each project's master toggle in `projects.auto_promotion`. Read by the web tier (`autoPromotionEnabledFromEnv()`); host/service-env only per [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MAISTER_API_BASE_URL`                         | no                                                                   | `http://localhost:3000`                                           | **(Implemented)** MCP facade: base URL of the MAIster REST API the `mcp/` package wraps (e.g. `http://localhost:3000` in dev; external HTTPS in prod).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAISTER_PROJECT_TOKEN`                        | no                                                                   | (none)                                                            | **(Implemented)** MCP facade **stdio/local-only** project/run-bound token. Takes precedence over `MAISTER_ACCESS_TOKEN`. **IGNORED** under the Streamable-HTTP transport, which requires a per-request inbound bearer forwarded verbatim to `/api/v1/ext`. Not a web-tier secret — never read by `web/` or `supervisor/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MAISTER_ACCESS_TOKEN`                         | no                                                                   | (none)                                                            | **(Implemented)** MCP facade **stdio/local-only** personal access token fallback for account-wide workflows such as `hitl_inbox`. Used only when `MAISTER_PROJECT_TOKEN` is unset or empty. **IGNORED** under Streamable-HTTP. Not read by `web/` or `supervisor/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MCP_TRANSPORT`                                | no                                                                   | (unset → `http`)                                                  | **(Implemented)** MCP facade transport select. Unset = Streamable-HTTP (remote; per-request inbound bearer, no ambient token). `stdio` (or `--stdio`) = local stdio transport reading `MAISTER_PROJECT_TOKEN`, then `MAISTER_ACCESS_TOKEN` as fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MCP_PORT`                                     | no                                                                   | `3001`                                                            | **(Implemented)** MCP facade HTTP bind port for the Streamable-HTTP transport. Unused under stdio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES`         | no                                                                   | unset (empty)                                                     | Flow package trust policy (ADR-021). Comma-separated source-URL prefixes that are `trusted_by_policy` (auto-enabled on install). `local`/`file://` sources are always trusted by policy; every other git source is `untrusted` until an explicit per-(project, revision) trust confirmation. Read by the web tier (`web/lib/flows/trust.ts`) at install time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES`   | no                                                                   | unset (empty)                                                     | **Implemented.** Comma-separated source-URL prefixes for `capability_imports[]` entries that are granted `trusted_by_policy` (auto-trusted on install, no explicit confirm required). Mirrors `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` exactly — same prefix-match semantics, same `local`/`file://` always-trusted rule. Every other git source is `untrusted` until an operator calls `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust`. Setting `trust: explicit` on a `capability_imports[]` entry forces the confirm step even for policy-trusted sources. Read by `web/lib/capabilities/import.ts:resolveCapabilityTrust()`. See ADR-043.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MAISTER_PACKAGE_DISCOVERY_STALE_HOURS`        | no                                                                   | `24`                                                              | **(Implemented — ADR-088.)** Web: package-source discovery staleness window (integer hours; invalid/absent → default). At web startup, enabled `package_sources` rows with `last_checked_at` null or older than this are refreshed sequentially (fire-and-forget, per-source try/catch); the manual `/refresh` endpoint ignores the window. Wired through `.env.example`; host/service-env only — the default compose stays Postgres-only per [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres), so this is never a container/compose var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MAISTER_DEFAULT_PACKAGE_SOURCES`              | no                                                                   | unset → built-in (`https://github.com/kanischev/maister-plugins`) | **(Implemented — ADR-088.)** Web: comma-separated list of default package-source URLs ensured at web boot. Each URL is inserted as a `package_sources` row when absent (insert-only, idempotent on the `url` unique index; an admin who disabled or deleted a default row is never re-created or re-enabled), then the same-boot discovery sweep picks up the freshly-seeded rows. A monorepo is ONE source — discovery scans `packages/*` within it. This is the ops-level "add more sources" path alongside the admin `/settings` UI. Unset → the built-in default list; an empty value (`""`) → opt out (ensure nothing) — empty is NOT the same as unset. Read by `web/lib/packages/catalog.ts` (`defaultPackageSourceUrls` / `ensureDefaultPackageSources`). Host/service-env only — never a container/compose var per [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres).                                                                                                                                                                                                                                                                                                                                                                        |
| `MAISTER_KEEPALIVE_MINUTES`                    | no                                                                   | `30`                                                              | NeedsInput keep-alive window (minutes). Read by BOTH supervisor (pending-permission deferred timeout) AND web (sweeper expiry, activity-bump amount, useActivityPing heartbeat at half-window). Bumped by every `POST /api/runs/:runId/activity`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MAISTER_MAX_OPERATOR_RESTARTS`                | no                                                                   | `10`                                                              | **(ADR-161 — Implemented.)** Web tier. Per-run hard cap on OPERATOR-initiated node restarts (`node_attempts.decision='operator_interrupt'`). These are deliberately EXCLUDED from a flow's `rework.maxLoops` budget — that budget expresses the flow author's tolerance for _automated_ rework loops, and charging human intervention to it would let a reviewer exhaust a flow's allowance by helping it — so the bound is not removed, only moved here. Reaching the cap disables `restart_node` / `restart_from` in the server-owned option matrix and refuses a submitted restart with `CONFLICT`; `resume` and `stop` are never capped. Host env only (compose containerizes Postgres alone).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

> **ADR-160 (Review rework claim) adds NO environment variable — deliberately.**
> The claim is bounded by the EXISTING `MAISTER_MAX_CONCURRENT_RUNS` cap (a
> claim moves a run from slot-free `Review` into slot-holding `HumanWorking`,
> so it is admitted or refused by the same global budget as any other live
> run), and it is human-paced rather than lease-timed — `MAISTER_KEEPALIVE_*`
> and `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` do not apply to it. No compose
> file, Dockerfile, or deploy overlay changes for Feature A. The absence is a
> decision, not an omission. ADR-161's operator restarts DO add one —
> `MAISTER_MAX_OPERATOR_RESTARTS`, below.
> | `MAISTER_LOCAL_PACKAGE_LOCK_MINUTES` | no | `30` | **(ADR-096 — Implemented.)** Session-scoped working-dir edit-lock TTL (minutes) for `/studio/edit`. Acquired on editor open, refreshed by `POST /api/studio/local-packages/:id/lock-refresh` (mirrors the run keep-alive), lazy stale-takeover, no sweeper. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — never a compose var. **(ADR-149 — Implemented.)** The SAME knob is the TTL for the authored-capability editor lock at `/flows/{projectSlug}/{capId}` (`POST /api/projects/{slug}/catalog/caps/{capId}/lock-refresh`): one "editor lock TTL" concept, deliberately no second variable and no new deployment wiring. |
> | `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` | no | `30` | Keep-alive sweeper tick frequency (seconds). The singleton timer in `web/lib/runs/keepalive-sweeper.ts` calls `runSweepTick()` every interval. Lower → snappier idle transitions; higher → less DB load. |
> | `MAISTER_ASSISTANT_ACTIVITY_WAITING_TOOL_AFTER_SECONDS` | no | `90` | Assistant-activity liveness threshold (seconds). Once the latest semantic action is still pending/in-progress for at least this age, `/api/v1/ext/activity` and `/api/v1/ext/runs/{runId}/activity` synthesize `waiting_on_tool` instead of `working`. Read by the web tier at request time (`web/lib/instance-config.ts` → `web/lib/ext-activity/liveness.ts`). Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)); never a compose var. |
> | `MAISTER_ASSISTANT_ACTIVITY_SILENT_AFTER_SECONDS` | no | `180` | Assistant-activity liveness threshold (seconds). If no later meaningful action arrives and no human/tool wait outranks it, the assistant activity surface reports `silent` after this age. Read by the web tier at request time; invalid/non-positive values fall back to the default with a one-time WARN. |
> | `MAISTER_AGENT_MEMORY_MAX_CHARS` | no | `32768` | (ADR-152) Cap, in **characters**, on one agent's memory file (`.maister/<project-slug>/agents/<enc(packageName)>/<enc(stem)>/memory.md`). Read by the web tier through `agentMemoryMaxChars()` (`web/lib/instance-config.ts`, `positiveIntFromEnv`); invalid or non-positive values fall back to the default with a one-time WARN. Enforced at both ends: an over-cap **write** refuses `MaisterError("CONFIG")` → 422, while an over-cap **read** degrades (no MEMORY section, `log.warn`, launch proceeds). Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)); never a compose var. |
> | `MAISTER_ASSISTANT_ACTIVITY_STALLED_AFTER_SECONDS` | no | `900` | Assistant-activity liveness threshold (seconds). Active `Running` work that stays quiet past this age is escalated from `silent` to `stalled`; non-active runs instead return `liveness.state = inactive` with a status-specific summary. Host/service-env only; never a compose var. |
> | `MAISTER_NEEDSINPUTIDLE_TTL_HOURS` | no | `24` | NeedsInputIdle abandonment TTL (hours). Sweeper pass 2 flips `NeedsInputIdle` rows whose `checkpoint_at + ttl < now()` to `Abandoned` and closes any open `hitl_requests.respondedAt`. |
> | `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` | no | `60` | Resume-prompt watchdog (seconds). After a `NeedsInputIdle` row is resumed (ACP `session/resume`), the runner-agent must receive `session.permission_request` within this window or `crashResumedRun` transitions the run to `Crashed`. (Helper exists; runner-agent enforcement is a follow-up patch.) |
> | `MAISTER_WORKBENCH_MAX_FILE_BYTES` | no | `524288` (512 KiB) | **(Implemented, ADR-053.)** Max size of a single git-tracked blob the workbench file viewer serves. A larger file renders the `file-too-large` page state on the `?file=` RSC path (ADR-066; not an HTTP `413`); bytes are never sent. Read by `web/lib/instance-config.ts:workbenchMaxFileBytes()`. Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is never a container/compose var. |
> | `MAISTER_NODE_OUTPUT_MAX_BYTES` | no | `262144` (256 KiB) | **(Implemented, [ADR-063](decisions.md#adr-063-structured-node-output-channel-p1--run-context-file-p7).)** Caps a graph node's structured-output payload before parse/validate at the post-action seam — the agent ` ```json maister:output ` block (`ai_coding`/`judge`/`orchestrator`), the cli `MAISTER_OUTPUT_FILE` contents (`cli`/`check`), or the serialized engine vars (`consensus`, [ADR-162](decisions.md#adr-162-universal-structured-node-result--transport-matrix-open-json-grammar-schema-identity)); exceeding it fails the attempt with `MaisterError({ code: "CONFIG" })`. Read by `web/lib/instance-config.ts:nodeOutputMaxBytes()`. Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is wired into `.env.example` + this doc **only**, never `compose.yml` (mirrors the `MAISTER_WORKBENCH_MAX_FILE_BYTES` precedent). See [`system-analytics/flow-graph.md`](system-analytics/flow-graph.md) §"Structured output validate seam" and [`flow-dsl.md`](flow-dsl.md) §"Structured node output channel". |
> | `MAISTER_ARTIFACT_INLINE_MAX_BYTES` | no | `262144` (256 KiB) | **(P2 — Implemented, [ADR-120](decisions.md#adr-120-artifact-body-injection-into-prompts).)** Per-injection cap for an artifact **body** injected into a graph node's prompt (via `{{ artifacts.<id>.content }}` or `input.requires[].inline: true`). Applied ONLY at the injection seam (`capForInline`, UTF-8-boundary-safe truncate + in-band marker, `{ truncated: true }`) — never inside `resolveArtifactContent` and never on the artifact payload API route, which returns the full untruncated body. For a `file` or `git-log` locator the injection path also bounds the **read** to this cap (reads at most `cap + 1` bytes; the log truncates instead of throwing) so a huge artifact never loads its full payload into the web process. Never fails the run on a large body (truncates). Read by `web/lib/instance-config.ts`; host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — wired into `.env.example` + this doc **only**, never `compose.yml` (mirrors the `MAISTER_NODE_OUTPUT_MAX_BYTES` precedent). See [`system-analytics/artifacts.md`](system-analytics/artifacts.md) and [`flow-dsl.md`](flow-dsl.md). |
> | `MAISTER_HARNESS_NEVER_FIRED_MIN` | no | `10` | **(Implemented, [ADR-073](decisions.md#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension).)** Minimum terminal gate executions in the observatory lookback window before the never-fired heuristic may flag a declared gate ("never fired — verify gate quality or a blind spot"). Read by `web/lib/instance-config.ts:harnessNeverFiredMin()` at the query layer and passed into the pure rollup as a parameter; invalid/non-positive values fall back to the default with a one-time WARN. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — never a compose var. See [`system-analytics/observatory.md`](system-analytics/observatory.md). |
> | `MAISTER_PROJECTS_DIR` | no | unset | Auto-discovery root; every `maister.yaml` under this dir is registered on startup |
> | `MAISTER_REPOS_ROOT` | no | `~/.maister/repos` | Root that `POST /api/projects` clones a `repoUrl` into (ADR-025). Resolved by `web/lib/instance-config.ts:reposRoot()`; surfaced read-only on `/settings`. |
> | `MAISTER_MCP_FACADE_COMMAND` | no | `<repo>/mcp/node_modules/.bin/tsx` | **(Implemented, ADR-089 D9.)** Command an agent session uses to launch the maister MCP facade (its sanctioned write channel, carrying the per-launch ephemeral token via the literal `env` channel). Override for split-host topologies. |
> | `MAISTER_MCP_FACADE_ARGS` | no | `<repo>/mcp/src/main.ts --stdio` | **(Implemented, ADR-089 D9.)** Space-split args for the facade command; only read when the command default is overridden or the default args do not fit. |
> | `MAISTER_MCP_PROBE_TIMEOUT_MS` | no | `8000` | **(ADR-129 — Designed, W-F.)** Supervisor. Bounds the MCP `initialize` handshake in `POST /mcp-probe`; on timeout the probe releases the spawned child (SIGTERM→SIGKILL teardown grace is fixed by the MCP SDK transport, ~2s). Host env — the supervisor is not containerized (compose runs Postgres only). |
> | `MAISTER_WORKTREES_ROOT` | no | `~/.maister/worktrees` | Root for run worktrees (ADR-025). Resolved by `worktreesRoot()`. The deprecated `MAISTER_WORKTREE_ROOT` is accepted as a fallback. Surfaced read-only on `/settings`. |
> | `MAISTER_LOCAL_PACKAGES_ROOT` | no | `~/.maister/local` | **(ADR-096 — Designed, Flow Studio Phase C.)** Root for editable local-package working directories (one git-backed dir per `local_packages` row). Resolved by `web/lib/instance-config.ts:localPackagesRoot()`. Host-only — like the flows/worktrees roots, `.maister` is NOT container-mounted ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)); host/service-env only. |
> | `MAISTER_EVALUATION_EVIDENCE_ROOT` | no | `~/.maister/evaluations` | **(ADR-144 — Implemented.)** Root for the content-addressed immutable Evaluation Lab evidence store. Blobs are written tmp+fsync+rename BEFORE the DB seal, so a crash leaves an orphan blob (GC-eligible) but the DB never points at an absent blob. Resolved by `web/lib/instance-config.ts:evaluationEvidenceRoot()`. Host-only — `.maister` is NOT container-mounted ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)); host/service-env only. |
> | `MAISTER_CONTROLLED_RECIPES_ENABLED` | no | enabled (any value but `false`) | **(ADR-146 — Implemented.)** Platform-wide rollout kill switch for controlled (launched) Evaluation Recipes, independent of observed Studies. Read by `web/lib/evaluations/launch-batch.ts:controlledRecipesEnabled()`; set to the literal `false` to freeze NEW controlled evaluation launches — batch-intent creation and queued-batch drains alike — with a typed `CONFIG` refusal. Observed participants, existing launched runs, and in-flight executions are unaffected. Host/service-env only. |
> | `MAISTER_IMPORT_MAX_BYTES` | no | `52428800` (50 MiB) | **(ADR-096.)** Total-size cap for a `/studio/local-packages/:id/import` batch (folder or zip/tar.gz); the archive blob is also checked against this BEFORE parsing (zip-bomb defense). Over → `PRECONDITION`, nothing persisted. `web/lib/instance-config.ts:importMaxBytes()`. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — never a compose var. |
> | `MAISTER_IMPORT_MAX_ENTRIES` | no | `2000` | **(ADR-096.)** Max file count per import batch; over → `PRECONDITION` pre-write. `importMaxEntries()`. Host/service-env only. |
> | `MAISTER_IMPORT_MAX_FILE_BYTES` | no | `10485760` (10 MiB) | **(ADR-096.)** Per-file size cap within an import batch; over → `PRECONDITION` pre-write. `importMaxFileBytes()`. Host/service-env only. |
> | `MAISTER_SUPERVISOR_URL` | no | `http://localhost:7777` | Web → supervisor HTTP+SSE base URL — see [Supervisor](supervisor.md) |
> | `MAISTER_SUPERVISOR_PORT` | no | `7777` | Supervisor bind port (read by `supervisor/src/main.ts`) |
> | `MAISTER_RUNTIME_ROOT` | no | supervisor `cwd` | Root under which `.maister/<slug>/runs/...` is written |
> | `MAISTER_HEARTBEAT_INTERVAL_MS` | no | `5000` | Supervisor orphan-child detection |
> | `MAISTER_KILL_GRACE_MS` | no | `5000` | SIGTERM → SIGKILL grace per session |
> | `MAISTER_SHUTDOWN_GRACE_MS` | no | `15000` | Total budget for graceful supervisor shutdown |
> | `LOG_LEVEL` | no | `debug` (dev) / `info` (prod) | pino level for both web and supervisor |
> | `ANTHROPIC_API_KEY` | no | — | Optional provider env inherited by spawned children if present; ACP tools are configured in their own CLIs by default. Also read by the model-discovery `provider_api` source for plain `anthropic` runner drafts (ADR-076). |
> | `ANTHROPIC_BASE_URL` | no | api.anthropic.com | Per-executor `env` overrides the global default |
> | `ANTHROPIC_AUTH_TOKEN` | no | uses tool/provider default | Optional explicit provider env when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …). Platform runners should prefer typed env refs only when overriding CLI-native config. |
> | `OPENAI_API_KEY` | no | — | Model discovery only (ADR-076): the supervisor's `provider_api` source lists models for plain `openai` codex runner drafts; unset → that source reports `skipped`. NOT used to run codex sessions. |
> | `MAISTER_ADAPTER_SMOKE_CACHE_PATH` | no | `<runtimeRoot>/adapter-smoke-cache.json` | Optional supervisor-side diagnostics cache written by `pnpm -C supervisor smoke:acp --cache <path> gemini opencode mimo`. Gemini/OpenCode/MiMo readiness requires cached `smoke.status="ok"`. Host/service-env only; never a compose var in the default Postgres-only topology. |
> | `MAISTER_DIAGNOSTIC_ENV_REFS` | no | unset | Optional comma-separated extra env-ref names exposed by supervisor `/diagnostics` as `{name,present}`. Values are never returned. Use for custom runner provider env refs beyond the built-in safe catalog. |
> | `MAISTER_WEBHOOK_DELIVERY_BATCH` | no | `20` | **(Implemented, ADR-077.)** Max deliveries (and outbox events) claimed per `webhook_delivery` scheduler drain tick. Bounds per-tick memory and HTTP concurrency. Web tier only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is wired into `.env.example` + this doc **only**, never `compose.yml`. |
> | `MAISTER_WEBHOOK_TIMEOUT_MS` | no | `10000` | **(Implemented, ADR-077.)** Per-attempt HTTP timeout in milliseconds for outbound webhook delivery. Applies to both the drain path and the synchronous test-ping route. Web tier only — host/service-env, never a `compose.yml` var (see [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). |
> | `MAISTER_WEBHOOK_MAX_ATTEMPTS` | no | `8` | **(Implemented, ADR-077.)** Terminal-dead threshold: a delivery whose `attempt_count` reaches this value is permanently set to `dead` status. The default covers the full retry curve (`1m, 5m, 15m, 1h, 4h, 12h, 24h` → initial + 7 retries = 8 total, ~41.5 h). Web tier only — host/service-env, never a `compose.yml` var (see [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). |
> | `MAISTER_WEBHOOK_ALLOW_HOSTS` | no | unset | **(Implemented, ADR-077 revised.)** Comma-separated EXACT hosts (case-insensitive) exempt from the outbound-webhook destination egress policy, which blocks loopback / private / link-local (incl. `169.254.169.254` metadata) / multicast / unspecified destinations at write AND send time. Set e.g. `127.0.0.1` to deliver to a local consumer in dev/e2e. Web tier only — host/service-env, never a `compose.yml` var (see [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). |

**HITL-surface env-variable parity:** the HITL hybrid surface (ADR-054/055/057)
adds no new environment variable. The table above is identical to
`.env.example`; `compose*.yml`, bound ports, and the supervisor sidecar
configuration are unchanged by it.

**Project-onboarding + git-access env parity (Implemented, [ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)):**
this work adds **no new host-read environment variable**, by design. Git auth is
**host-ambient** (Q2=A): the host's ssh-agent/keys, optionally the `gh` CLI, and
the existing git credential helper. The one-off HTTPS clone token is **not** read
from host config — `MAISTER_GIT_TOKEN` is set **transiently in the git
child-process env** (via a `0700` `GIT_ASKPASS` script removed in `finally`) and
read by nothing at startup, so it has **no** `.env.example` or `compose*.yml`
entry. The absence is intentional, not an oversight. The persist push and remote
push/fetch reuse the same host-ambient auth — no managed credential store.

Secrets MUST live in `.env` server-side. Never logged, never streamed via
SSE, never embedded in `session/update` payloads visible to the browser.

`.env.example` in the repo root documents the full set with safe placeholder
values.

## Authentication & RBAC

MAIster uses **Auth.js v5** (formerly NextAuth.js) with a **credentials
provider only**. OAuth providers are not configured.

The implementation is split into two files to satisfy Auth.js's edge/node
boundary requirements:

- `web/auth.config.ts` — edge-safe: credentials provider slot + `jwt` /
  `session` callbacks (no DB). `web/middleware.ts` builds `NextAuth(authConfig)`
  to protect all `(app)` routes (redirect to `/login` when unauthenticated).
- `web/auth.ts` — Node.js runtime only: Drizzle adapter
  (`@auth/drizzle-adapter`) + credentials `authorize`, and a DB-backed `jwt`
  callback that re-reads `users.role` / `users.mustChangePassword` on every
  refresh and **invalidates the session (returns `null`) if the user no longer
  exists**. This keeps the JWT from outliving a role revocation.

**Admin bootstrap (seeded, not first-user).** A single default admin is created
by **migration `0005`** (`admin@maister.local` / `maister-admin`, bcrypt) so
every deployment has exactly one bootstrap admin after `pnpm db:migrate`. The
row carries `must_change_password = true`, so the well-known default password
**must be changed on first login** before any app access. `pnpm db:seed` is
idempotent with this (it reuses the existing admin by email). **Public
registration never grants admin** — registration creates `member` with
`account_status = pending`; this closes the concurrent-first-user admin-minting
race and requires an existing admin to activate the account.

**Admin user management.** Global admins use `/admin/users` and the
`/api/admin/users` REST routes to activate pending registrations, disable or
re-enable accounts, change global roles, and reset passwords. Password reset can
set `must_change_password = true`, forcing the user through `/change-password`
on next sign-in.

**DB-authoritative authorization.** `lib/authz.ts` re-reads the live `users.role`
and `users.account_status` from the database on every check (`getSessionUser` →
`requireGlobalRole` / `requireProjectRole`); the cached JWT role is **never**
trusted for an authorization decision. A demoted, disabled, or deleted user
loses authority on their next request, not at JWT expiry.

**Forced password change fails closed on APIs too.** The `(app)` layout redirects
`must_change_password` users to `/change-password`, AND every role-gated API
funnels through `requireActiveSession()` (inside `requireGlobalRole` /
`requireProjectRole`), which rejects a forced-change account with
`PASSWORD_CHANGE_REQUIRED` (403). So the seeded admin cannot call `POST /api/projects`,
`POST /api/runs`, task creation, or HITL response with the default password — the
page redirect is not the only gate. `requireSession` / `getSessionUser` stay
permissive so the change-password flow itself can run.

**Global roles** (`users.role`): `admin | member | viewer`. Enforced by
`lib/authz.ts:requireGlobalRole()`.

| Role     | Capabilities                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `admin`  | Register projects, approve/disable users, change global roles, reset user passwords, is implicit `owner` of every project. |
| `member` | Default. Can be added to projects; cannot register new projects.                                                           |
| `viewer` | Read-only access to projects they are explicitly added to.                                                                 |

**Project roles** (`project_members.role`): `owner | admin | member | viewer`.
Enforced by `lib/authz.ts:requireProjectRole()` / `requireProjectAction()`.

| Role     | Min action                                                                 | Capabilities                                                                                            |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `owner`  | —                                                                          | All actions including project archival.                                                                 |
| `admin`  | `editSettings`                                                             | Edit project settings.                                                                                  |
| `member` | `launchRun`, `operateScratchRun`, `promoteRun`, `createTask`, `answerHitl` | Launch Flow/scratch runs, operate scratch dialogs, promote run branches, create tasks, respond to HITL. |
| `viewer` | `readBoard`, `readScratchRun`                                              | Read the board, active workspace metadata, scratch dialogs, and stream run events.                      |

Global `admin` users bypass the `project_members` table and are treated
as `owner` on every project. Source: `web/lib/authz.ts`.

**Middleware protection.** `web/middleware.ts` (Auth.js middleware) protects
all routes under `(app)/`. Unauthenticated requests are redirected to
`/login`. API routes additionally call `requireSession()` /
`requireProjectAction()` directly to enforce role checks and return
machine-readable `401 UNAUTHENTICATED` / `403 UNAUTHORIZED` JSON.

## Internationalization (EN/RU)

MAIster uses **next-intl** for bilingual EN/RU support.

- **Locale detection** (request.ts at `web/i18n/request.ts`): reads the
  `NEXT_LOCALE` cookie first; falls back to the `Accept-Language` request
  header; defaults to `en`.
- **Locale persistence**: the in-app language toggle calls the `setLocale`
  server action, which sets the `NEXT_LOCALE` cookie on the response.
  No URL-based locale prefix — locale is cookie-only.
- **Message catalogs**: `web/messages/en.json` and `web/messages/ru.json`.
  All user-visible strings must have entries in both files.
- **Server usage**: `import { getTranslations } from "next-intl/server"` in
  Server Components and Route Handlers.
- **Client usage**: `import { useTranslations } from "next-intl"` in Client
  Components.

There is no `NEXT_LOCALE` environment variable. The cookie name `NEXT_LOCALE`
is the next-intl default; ops documentation above records it for awareness.

## Public API

### `lib/config.ts`

| Export                                     | Signature                            | Throws on                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadProjectConfig(path)`                  | `(string) => Promise<MaisterYamlV2>` | Missing file, invalid YAML, schema error, cross-ref failure. All → `MaisterError({ code: "CONFIG" })`.                                                           |
| `loadFlowManifest(path)`                   | `(string) => Promise<FlowYamlV1>`    | Missing file, invalid YAML, legacy `steps[]`, schema error, duplicate node IDs, or dangling transition/rework targets. All → `MaisterError({ code: "CONFIG" })`. |
| `validateFormSchemaVersion(obj, expected)` | `(unknown, number) => void`          | Malformed form schema OR version mismatch. → `MaisterError({ code: "CONFIG" })` with both versions in the message.                                               |

### `lib/config.schema.ts`

Zod schemas + inferred types:

```ts
import {
  maisterYamlV2Schema,
  type MaisterYamlV2,
  flowYamlV1Schema,
  type FlowYamlV1,
  executorSchema,
  type ExecutorConfig,
  flowEntrySchema,
  type FlowEntry,
  stepSchema,
  type Step,
  formSchemaSchema,
  type FormSchema,
} from "@/lib/config.schema";
```

Import the inferred types in Route Handlers / components instead of
hand-rolling DTOs — the zod schema is the single source of truth.

## Anthropic-compatible provider routing

Configure the provider directly on the runner and keep the credential in the
supervisor environment:

```yaml
platform:
  default_runner: claude-glm
acp_runners:
  - id: claude-glm
    adapter: claude
    model: glm-5.1
    env:
      ANTHROPIC_MODEL: env:CLAUDE_CODE_MODEL
    provider:
      kind: anthropic_compatible
      base_url: https://api.z.ai/api/anthropic
      auth_token: env:ZAI_API_KEY
    permission_policy: default
```

## Cost tracking on resume

Every line appended to `.maister/<projectSlug>/runs/<runId>/cost.jsonl`
by a supervisor session that was resumed (spawned with a `resumeSessionId`,
restored via the ACP `session/resume` call) carries
`"resumed": true`. The marker is added in `supervisor/src/cost.ts`'s
`attachCost(opts)` from `opts.resumed = Boolean(parsed.resumeSessionId)`
at session creation time. The original ACP spike measured ~$0.28 of
`cache_creation_input_tokens` per cross-process resume — keep-alive
saves this cost when the operator is paying attention. Ops can monitor
the tax via:

```sql
-- across runs, the cache-creation tokens paid as the cost of resuming
select sum((j->>'cache_creation_input_tokens')::int) as cache_tokens_paid_on_resume
from cost_lines  -- ingestion view derived from cost.jsonl
where (j->>'resumed')::boolean = true;
```

There is no control-plane decision branch on `resumed=true` — it is
observability only.

## See Also

- [Supervisor](supervisor.md) — the ACP daemon that consumes normalized runner
  spawn intents and the supervisor-specific env vars listed above
- [Error Taxonomy](error-taxonomy.md) — `CONFIG` semantics; what the UI
  shows on each rejection
- [Database Schema](database-schema.md) — how `maister.yaml` registration binds
  projects and Flow attachments to platform runner ids
- [Architecture](../.ai-factory/ARCHITECTURE.md) — dependency rules
  enforced around `lib/config.ts`
