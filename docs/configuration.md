[← Error Taxonomy](error-taxonomy.md) · [Back to README](../README.md)

# Configuration

Platform runtime settings plus two manifests define how MAIster runs:

- **Platform runtime config** — operator-managed ACP runners, router sidecars,
  adapter diagnostics, and the required platform default runner. Stored by
  MAIster, not inside project repos.
- **`maister.yaml` v2** — per-project: project metadata, project default runner
  binding, Flow plugin bindings, Flow default runner bindings, capabilities,
  and role registries. Lives in the registered repo root.
- **`flow.yaml` v1** — per-Flow-plugin: the step DSL (cli / agent / guard /
  human), AI-coding runner targets, optional `setup.sh`. Lives in each plugin's
  git repo.

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

router_instances:
  - id: ccr-default
    kind: ccr
    lifecycle: managed
    command_preset: ccr_start
    config_path: ~/.claude-code-router/config.json
    base_url: http://127.0.0.1:3456
    healthcheck_url: http://127.0.0.1:3456/health
    auth_token: env:MAISTER_CCR_AUTH_TOKEN

acp_runners:
  - id: claude-code
    adapter: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
    permission_policy: default

  - id: claude-code-ccr
    adapter: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
    router_instance: ccr-default
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
- Router sidecar ids resolve against `router_instances[]`.
- Secret values are references such as `env:NAME`, never literal tokens.
- Unsupported provider/policy/sidecar combinations are saved only as
  `NotReady` with reason codes, or are rejected when they would create an
  invalid default.
- Gemini/OpenCode/MiMo runner rows are first-class catalog entries, but production
  readiness is still gated by supervisor diagnostics and adapter smoke evidence;
  they are never silently substituted with Claude/Codex.
- Admin APIs and UI may show secret ref names and readiness reason codes, but
  never raw token values or generated config bodies.

### MCP capability template — `platform_mcp_servers` (Designed, M27)

**(Designed, M27)** Platform MCP servers are stored in the `platform_mcp_servers`
table (admin-only CRUD, mirrors `platform_acp_runners`). The transport field is
discriminated:

| `transport` | Required fields | Optional fields |
| ----------- | --------------- | --------------- |
| `stdio` | `command` | `args`, `env_keys` |
| `sse` | `url` | `header_keys` |
| `http` | `url` | `header_keys` |

`env_keys` and `header_keys` store **names only** (`env:NAME`; regex
`^env:[A-Za-z_][A-Za-z0-9_]*$`). Secret **values** are resolved supervisor-side
from `process.env` at session spawn and MUST NEVER be stored in `platform_mcp_servers`,
returned in any HTTP response, written to any DB column, or included in an ACP
`session/update` payload visible to the browser. This is the same `env:NAME`
secret-ref policy used by `platform_acp_runners` (ADR-044 + ADR-065).

`exec_trust` on the `flow_revisions` row gates MCP stdio `command` spawn: a revision
with `exec_trust=untrusted` MUST NOT spawn a stdio MCP command even if `trustStatus`
is `trusted_by_policy` (logic-trust alone is insufficient — see
[`system-analytics/flow-packages.md`](system-analytics/flow-packages.md) §M27).

**No new web environment variable is required by M27.** MCP server secrets travel
only as env-var names; the supervisor resolves them from its existing `process.env`
at spawn. The env table above is unchanged by M27.

## `maister.yaml` v2

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  default_branch: main        # default base/target branch
  branch_prefix: maister/     # default: maister/
  default_runner: inherit     # or a platform ACP runner id
promotion:
  mode: pull_request          # local_merge | pull_request
  remote: origin              # for pull_request mode
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
  # Implemented (M14) — agent_definitions[] and env_profiles[] below
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
# Implemented (M14) — capability_imports[] block below
capability_imports:
  - id: aif-skills
    source: github.com/org/maister-aif-skills
    version: v1.0.0
  - id: custom-mcps
    source: github.com/org/maister-custom-mcps
    version: v2.1.0
    trust: explicit           # optional: "explicit" forces trust-confirm even for policy-trusted sources
flows:
  - id: bugfix
    source: github.com/org/maister-flow-bugfix
    version: v1.2.3
    runner: inherit
  - id: spec-kit
    source: github.com/org/maister-flow-spec-kit
    version: v0.4.1
    runner: claude-code-ccr               # optional platform runner ref
```

### Required fields

| Field | Rule |
| ----- | ---- |
| `schemaVersion` | Must be the integer `2`. Loader refuses on any other value. |
| `project.name` | Non-empty string. The `slug` is derived from this (kebab-case). |
| `flows[].id` | Unique within the file. |
| `flows[].source` | Non-empty. Resolved by the Flow loader (`git clone --branch <version>`). |
| `flows[].version` | Tag-pinned (lock semantics). Non-empty. The tag is the user-facing pin; at install the loader records the resolved git commit SHA in `flows.revision` and at run launch snapshots it into `runs.flow_revision`. The runner derives the bundle path from `(flowRefId, flow_revision)`, so a tag re-pointed upstream after the run launched does not affect that run. |

### Optional fields

| Field | Default | Notes |
| ----- | ------- | ----- |
| `project.repo_path` | derived | Optional and ignored since [ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots). `projects.repo_path` is the **resolved on-disk dir** (the clone target under `MAISTER_REPOS_ROOT`, or the existing local dir), not this manifest field. |
| `project.default_branch` | `main` | Default base branch for new runs and default target branch for promotion. `project.main_branch` remains accepted as a backwards-compatible alias until the branch-targeting migration lands. |
| `project.branch_prefix` | `maister/` | Run-branch prefix; combined with the slug. |
| `project.default_runner` | `inherit` | Platform runner id or `inherit`. `inherit` uses the platform default. Missing/unknown runner ids create an explicit reconfiguration requirement; they never create project-scoped runner rows. |
| `promotion.mode` | `local_merge` | **(Implemented, M18 — ADR-058/049.)** `local_merge` merges the run branch into the target branch locally; `pull_request` creates/updates a PR from the run branch into the target branch. Resolved at launch via the override chain (launch override > project `promotion.mode` > default `local_merge`) and snapshotted to `workspaces.promotion_mode`. `pull_request` mode has the per-provider host prerequisites below. |
| `promotion.remote` | unset | **(Implemented, M18 — ADR-049.)** Remote name used by `pull_request` mode (the `git push` target and the PR base remote). |
| `flows[].runner` | `inherit` | Platform runner id or `inherit`. This is the project Flow attachment default and inherits the project default. |
| `flow_roles[]` | `[]` | M13 Flow routing registry. Each `ref` is project-scoped and may be used by `finish.human.role` or human-node `settings.roles[]`. Flow roles are not RBAC and never replace `project_members.role`. |

#### `pull_request` promotion mode — per-provider host prerequisites (Implemented, M18 — ADR-049)

`pull_request` promotion runs in the **web tier** (the promote route shells a
provider CLI *or* calls a Gitea-compatible REST API, plus `git push`). The
prerequisites depend on the run's detected provider (`projects.provider`), and are
required **only** when a run promotes via `pull_request` — `local_merge` needs **none**
of them. (Credential **model B**: host git credentials + provider CLI/token, no secrets
stored in MAIster.)

| Provider | PR-mode prerequisite on the web host |
| -------- | ------------------------------------ |
| `github` | `gh` CLI on `PATH` + host auth (`gh auth login`, or `GH_TOKEN` in the web-tier env). |
| `gitlab` | `glab` CLI on `PATH` + host auth (`glab auth login`, or `GITLAB_TOKEN` in the web-tier env). |
| `gitea` | `GITEA_TOKEN` in the web-tier env (the shared Gitea-compatible REST adapter; no CLI). |
| `gitverse` | `GITVERSE_TOKEN` in the web-tier env (same Gitea-compatible REST adapter). |
| `generic` | **Unsupported** — `pull_request` mode refuses with `PRECONDITION`; use `local_merge`. |
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
> and [`deployment.md`](deployment.md).

#### `capability_imports[]` (Implemented, M14)

The optional `capability_imports[]` block declares git-pinned capability
packages for the project. Each entry is fetched, trust-evaluated, and
(conditionally) set up during project registration.

```yaml
capability_imports:
  - id: aif-skills                  # SAFE_PATH_SEGMENT: /^[A-Za-z0-9._-]+$/
    source: github.com/org/aif-skills
    version: v1.0.0                 # tag-pinned (lock semantics); SAFE_PATH_SEGMENT
    trust: explicit                 # optional; forces trust-confirm UI even for
                                    # policy-trusted sources (default: follow policy)
```

| Field | Rule |
| ----- | ---- |
| `id` | Non-empty string matching `SAFE_PATH_SEGMENT` (`/^[A-Za-z0-9._-]+$/`). No `.`, `..`, or embedded `/`. Validated at Zod schema layer AND inside `systemCapabilityCachePath` (defence-in-depth). Unique within the file. |
| `source` | Non-empty git URL. Resolved by `installCapabilityRevision` (`git clone --branch <version>`). |
| `version` | Tag-pinned (lock semantics). Non-empty string matching `SAFE_PATH_SEGMENT`. Passed verbatim to `git clone --branch`. The resolved 40-hex SHA is captured and stored in `capability_imports.resolved_revision`. |
| `trust` | Optional. `"explicit"` overrides policy-trust and requires an operator confirmation via `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust` before `setup.sh` runs, even if the source prefix would be `trusted_by_policy`. |

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
retroactively invalidated. **M25 authored catalog carve-out:** rows whose
`material.origin='authored'` are local DB-authored projections and are never
disabled by `upsertCapabilitiesFromConfig` SET/CLEAR, even though they also use
`source='project'`.

#### Authored capability catalog (Implemented, M25)

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
- setup/script artifacts remain inert until the M10 trust-gated setup lifecycle.

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

#### `capabilities.agent_definitions[]` and `capabilities.env_profiles[]` (Implemented, M14)

Two new arrays extend the existing `capabilities` block. Both follow the same
shape as `capabilities.mcps[]` / `capabilities.skills[]` but cover the
`agent_definition` and `env_profile` capability kinds.

| Array | Kind | Purpose |
| ----- | ---- | ------- |
| `capabilities.agent_definitions[]` | `agent_definition` | Named agent configuration profiles (e.g. a `claude-strict` settings profile). |
| `capabilities.env_profiles[]` | `env_profile` | Named environment variable profiles; the agent receives env-var **names** only — never stored in `material` nor written into the worktree. |

These kinds flow through the existing `resolver` / `materializer` generically.
`env_profile` MCP servers are delivered over ACP `newSession params.mcpServers`
carrying env-var **names** only; the supervisor resolves each name→value from its
own `process.env` at session start (ADR-044). No secret value is ever written to
disk or carried on the wire (R-SECRET).

### Planned Flow package lifecycle

M10 keeps `maister.yaml` as the project-desired Flow list but moves package
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
(**Implemented, M14** — see ADR-041; capability config is delivered to the claude
agent via `<worktree>/.claude/settings.local.json` + ACP `newSession`
`params.mcpServers`, the corrected channel per ADR-044, after the CLI-flag
mechanism was disproven). The `instructed → enforced` flip remains **deferred**,
gated on the ADR-042 live-adapter spike. Public marketplace, organization policy,
and cross-project promotion stay deferred (Phase 2).

Each capability record has:

| Field | Purpose |
| ----- | ------- |
| `id` | Stable name referenced by Flow node settings. |
| `kind` | One of `mcp`, `skill`, `rule`, `tool`, `setting`, `agent_definition`, `env_profile`, `restriction`. |
| `source` | Launch source after normalization: `platform`, `project`, or `flow-package`. `maister.yaml` accepts `project`, `flow`, `git`, `local`, `system`, `platform`, and `flow-package`. |
| `version` / `revision` | User pin and resolved immutable revision when external. |
| `agents` | Supported executor agent ids, with optional concrete per-agent mapping. |
| `selectable` | Whether the record can be selected for future launches; CLEAR disables old rows without deleting historic profile snapshots. |
| `enforceability` | `enforced`, `instructed`, or `unsupported` for the selected executor. |

Runtime must snapshot the resolved capability profile into the run ledger before
an AI node starts. If a node requires strict enforcement but the selected
executor can only receive that capability as an instruction, launch fails rather
than silently weakening the boundary.

### Flow role registry

`flow_roles[]` is the M13 project-local registry for human-work routing labels.
It accepts:

| Field | Rule |
| ----- | ---- |
| `ref` | Required safe id (`A-Z`, `a-z`, digits, `.`, `_`, `-`). Unique within the project config. |
| `label` | Optional display label. Defaults to `ref` when persisted. |
| `description` | Optional operator-facing explanation. |

When a project declares at least one `flow_roles[]` entry, Flow install
validates every graph `finish.human.role` and human-node `settings.roles[]`
against that registry and rejects unknown refs with `CONFIG`. Removing a role
from `maister.yaml` archives the DB row; re-adding the same ref reactivates it.

For compatibility, omitted or empty `flow_roles[]` does not enforce existing
role annotations in older Flow packages. New M13 projects that use role-owned
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

| Capability kind | Claude | Codex | V1 contract |
| --------------- | ------ | ----- | ----------- |
| MCP | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Snapshot + instruction handoff is implemented. Adapter-specific MCP config generation is designed, not implemented. Enforced unsupported entries are refused. |
| Skill | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Snapshot + instruction handoff is implemented. Adapter-native skill loading is designed, not implemented; enforced unsupported entries are refused. |
| Rule | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Instructed-only in V1. |
| Agent settings | Not materialized in V1. | Not materialized in V1. | Designed follow-up. Unknown enforced settings are refused. |
| Restriction | Persisted in `profile.json` and listed in `instructions.md`. | Persisted in `profile.json` and listed in `instructions.md`. | Enforced unsupported restrictions are refused; optional unsupported restrictions are downgraded only when recorded in the profile. |
| Tool / agent definition / env profile | Not activated directly. | Not activated directly. | Refused as enforced capabilities in v1. Optional entries become instructed-only only when the profile records the downgrade. |

### Planned external operations configuration

M16 external operations are configured from the MAIster UI and database, not
from `maister.yaml`. API tokens are service credentials; putting token secrets
or token hashes in a project repo would make rotation and audit worse.

Each API token record has:

| Field | Purpose |
| ----- | ------- |
| `id` | Internal stable identifier used for audit and gate reports. |
| `name` | Human-readable label shown in Project Settings. |
| `prefix` | Non-secret token prefix shown after creation for identification. |
| `token_hash` | SHA-256 hash of the token secret. The raw secret is shown once. |
| `project_id` | The only project the token can operate on. |
| `scopes` | Enforced allow-list for `/api/v1/ext` and MCP calls (default `["*"]`). `*` grants the full project API for broad automation; otherwise the route/tool's required scope must be present. The same value is recorded in audit as `scope_used` (see [ADR-046](decisions.md#adr-046)). |
| `expires_at` | Optional expiry. Expired tokens fail closed. |
| `revoked_at` | Revocation timestamp. Revoked tokens fail closed. |
| `created_by` / `created_at` | Operator and time that created the token. |
| `last_used_at` | Last accepted request/tool call timestamp. |

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
4. **(Implemented, M14)** Every Flow node settings capability reference
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
Flow-step runner ids create a required reconfiguration requirement; they never
silently fall through to lower tiers.

## `flow.yaml` v1

The manifest each Flow plugin ships in its git repo.

```yaml
schemaVersion: 1
name: Bugfix
metadata:                               # optional: routing hints + provenance, additive + runner-ignored
  title: "AIF — Bugfix"                 #   (stored verbatim in flow_revisions.manifest)
  summary: "Fast bug loop: fix → checks → review → commit."
  labels: [bug, hotfix]                 # machine routing hints
  route_when: "a reported bug/error to fix"   # NL hint for an LLM router
  links:                                # each (strict): { kind?, title, url }
    - { kind: docs, title: "Dev Workflow", url: "https://github.com/lee-to/ai-factory" }
  sources:                              # each (strict): { component, origin }
    - { component: "skills/aif-*, agents/*", origin: "github.com/lee-to/ai-factory@2.x" }
runner_type: acp                        # optional, defaults to acp today
runner: claude-code                     # optional platform ACP target
setup: ./setup.sh                       # optional one-time install hook
# Optional M10 package contract (ADR-021): recorded + displayed as opaque
# metadata. Only `compat` + `schemaVersion` are ENFORCED at enablement;
# capabilities/gates/artifacts/external_ops gain runtime meaning in M11+.
compat:                                 # optional engine compatibility range
  engine_min: 1.0.0
  engine_max: 2.0.0
capabilities: [shell, edit]             # optional opaque string list
gates: []                               # optional opaque string list
artifacts: [diff, human_note]           # optional opaque string list
external_ops: []                        # optional opaque string list
steps:
  - id: plan
    type: agent
    mode: new-session                   # or slash-in-existing
    prompt: "/aif-plan {{ task.prompt }}"
  - id: lint
    type: cli
    command: pnpm lint
  - id: budget
    type: guard
    cost: 5                             # parsed and persisted, not enforced today
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: review_comments
```

### Step types

Discriminated on `type`:

| Type | Required fields | Optional fields |
| ---- | --------------- | --------------- |
| `cli` | `id`, `type=cli`, `command` | `pre_guards`, `post_guards`, `retry_safe` |
| `agent` | `id`, `type=agent`, `mode=new-session\|slash-in-existing`, `prompt` | `pre_guards`, `post_guards`, `retry_safe` |
| `guard` | `id`, `type=guard` + at least one of `cost`, `time`, `regex` | `retry_safe` |
| `human` | `id`, `type=human`, `form_schema` (path to JSON schema with `schemaVersion`) | `on_reject.goto_step`, `on_reject.comments_var`, `retry_safe` |

`retry_safe` (boolean, default `false`) is also accepted on graph `nodes[]`. It
gates operator crash-recovery re-dispatch of a session-less node — a `Crashed`
run whose recover target is session-less (`cli`/`check`/`judge`/`guard`/`human`)
is redispatch-recoverable only when its config declares `retry_safe: true`;
`ai_coding` ignores it (recovered via `session/resume`). See
[ADR-034](decisions.md#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)
and [`flow-dsl.md`](flow-dsl.md).

### Node `settings` (typed, M11c)

Every Flow graph node carries an **optional** typed `settings` block. The block
is discriminated on node type and replaces the M11a opaque passthrough — the
shape is now validated, not passed through verbatim. `settings` is OPTIONAL on
**every** node type: a node with no `settings` validates and runs unchanged, and
absence of `settings` NEVER triggers a launch refusal (back-compat). Settings
ride in the pinned `flow_revisions.manifest` — no separate file, env var, or
sidecar. Validation lives in `web/lib/config.schema.ts`; failures throw
`MaisterError({ code: "CONFIG" })`.

Status: the typed shape, node-level validation, the launch-time refusal
boundary, the `enforcement` evaluator, the `enforcement_snapshot` audit record,
and the time-limit watchdog are **Implemented (M11c subset)**. Capability-reference
resolution against the project registry (carve-b), agent-aware name mapping, and
per-session native materialization are **Implemented (M14)** — see
ADR-041 in [`decisions.md`](decisions.md). The materialized config reaches the
claude agent via `<worktree>/.claude/settings.local.json` + ACP `newSession`
`params.mcpServers` (the corrected channel per ADR-044; the CLI-flag
mechanism was disproven against `claude-agent-acp@0.37.0`). The
`instructed → enforced` flip remains **deferred**, gated on the ADR-042
live-adapter spike — no cell is flipped. See
[ADR-031](decisions.md) (typed settings) / [ADR-032](decisions.md) (refusal
boundary) and the frozen enforcement spec in
[`system-analytics/flow-settings.md`](system-analytics/flow-settings.md).

**`ai_coding` / `judge` settings** (agent-capability shape):

`judge` carries the same capability shape MINUS `runner_type`, `runner`,
`settingsProfile`, `workspaceAccess`, and `artifactAccess` — those five are
`ai_coding`-only. The shared subset is `model`, `thinkingEffort`, `mcps`,
`tools`, `skills`, `permissionMode`, `limits`, `restrictions`, and
`enforcement`. `.strict()` parsing rejects any of the five `ai_coding`-only
fields on a `judge` node.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `runner_type` | `acp` | **`ai_coding` only.** Defaults to `acp` in this slice. Future runner families can extend this without redefining ACP semantics. |
| `runner` | `string` | **`ai_coding` only.** For `runner_type: acp`, a platform ACP runner target or package-local target that must be remapped during Flow load/attach. |
| `model` | `string` | Free-form model override. |
| `thinkingEffort` | `low \| medium \| high` | Unknown value rejected. |
| `mcps` | `string[]` | Capability class. Registry resolution against `capability_records` at validate/launch is **Implemented (M14)**. |
| `tools` | `{ claude?: string[]; codex?: string[] }` | Per-agent tool map; malformed map rejected. Capability class. Registry resolution is **Implemented (M14)**. |
| `skills` | `string[]` | Capability class. Registry resolution is **Implemented (M14)**. |
| `settingsProfile` | `string` | **`ai_coding` only.** Named `agent_definition` capability reference. Registry resolution is **Implemented (M14)**. |
| `workspaceAccess` | `read \| write \| none` | **`ai_coding` only.** Capability class. |
| `artifactAccess` | `string[]` | **`ai_coding` only.** Artifact ids the node may read/write. |
| `permissionMode` | `ask \| allow \| deny` | Capability class. Unknown value rejected. |
| `limits` | `{ maxDurationMinutes?: number > 0; maxCostUsd?: number > 0 }` | Out-of-range rejected. `maxDurationMinutes` is the watchdog cap (below); `maxCostUsd` is record-only. |
| `restrictions` | `string[]` | Capability class. Registry resolution is **Implemented (M14)**. |
| `enforcement` | `{ mcps?; tools?; skills?; restrictions?; permissionMode?; workspaceAccess? }` | Per-class intent — see below. |

**`human` settings** (decision/role/takeover shape):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `roles` | `string[]` | Eligible reviewer roles. Role refs are NOT validated against a registry in M11c (M13). |
| `assignees` | `string[]` | Specific assignees. |
| `decisions` | `string[]` | Each value MUST appear in the node's `transitions` (M11c). |
| `allowFurtherTracks` | `boolean` | Permit spawning further tracks. |
| `allowTakeover` | `boolean` | Permit manual takeover. |
| `slaHours` | `number > 0` | Out-of-range rejected. |
| `stalenessHint` | `string` | Hint surfaced when downstream goes stale. |
| `returnRequires` | `string[]` | Conditions required before returning. |
| `criticality` | `low \| medium \| high \| critical` | **(Implemented — M17.)** Flow-author-declared severity. Optional; additive — no `MAISTER_ENGINE_VERSION` bump (stays 1.2.0). Stored write-once on `hitl_requests.criticality` at HITL row creation; absent means no severity declared. Responder `confidence` is a response-time value supplied in the answer body — it cannot be pre-declared here. See [`flow-dsl.md`](flow-dsl.md#human-step). |

**`cli` / `check` settings** (command shape):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `command` | `string` | Command to run. |
| `timeoutMs` | `number > 0` | Out-of-range rejected. |
| `environmentPolicy` | `inherit \| clean \| whitelist` | Unknown value rejected. |
| `inputArtifacts` | `string[]` | Artifact ids consumed. |
| `outputArtifacts` | `string[]` | Artifact ids produced. |
| `failureClass` | `blocking \| advisory \| retryable` | Unknown value rejected. |

#### `enforcement` intent + the static enforceability table

`settings.enforcement` declares, per capability class (`mcps`, `tools`,
`skills`, `restrictions`, `permissionMode`, `workspaceAccess`), how strictly the
class must hold:

| Value | Meaning |
| ----- | ------- |
| `strict` | The class MUST be enforced; launch refuses if the build cannot enforce it. |
| `instruct` | **Default.** The class is passed to the agent as an instruction. |
| `off` | The class is omitted from the verdict set. |

At launch, each `strict` class is checked against `ENFORCEABILITY_BY_AGENT` — a
**code constant** in `web/lib/flows/enforcement.ts` (NOT an env var, port, or
config-file path), keyed by `agent × capabilityClass`. In M11c every cell is
`instructed`, so any `strict` declaration is `refused` and launch throws
(`CONFIG`, or `EXECUTOR_UNAVAILABLE` once M14 flips cells). M14 only ever flips
`instructed → enforced`; the contract tightens, never loosens. The table and the
`evaluateNodeEnforcement` truth table are FROZEN in
[`system-analytics/flow-settings.md`](system-analytics/flow-settings.md) — that
file is canonical; do not duplicate them here.

The `limits.maxDurationMinutes` watchdog is agent-agnostic and inherently
enforced — it is NOT subject to the `strict`/`instruct` table. A run whose
elapsed exceeds the cap is terminated `Failed` via the supervisor's existing
`DELETE /sessions/:id`.

### Cross-reference checks

`loadFlowManifest()` runs:

1. No duplicate step IDs.
2. Every `on_reject.goto_step` must reference an existing step id.

For `runner_type: acp`, a top-level or node-level `runner` is a non-empty
string. Its existence in platform runners is validated during platform Flow
load and project Flow attachment. A missing id creates a required
reconfiguration requirement; the manifest can still be loaded standalone for
testing.

### Package contract + compatibility (M10)

`compat`, `capabilities`, `gates`, `artifacts`, and `external_ops` are optional.
They are parsed, digested into `flow_revisions.manifest_digest`, recorded in
`flow_revisions.contract`, and surfaced in the Flow Packages UI. Enablement and
launch ENFORCE only two compatibility checks (`web/lib/flows/engine-version.ts`):
the manifest `schemaVersion` must be in `SUPPORTED_FLOW_SCHEMA_VERSIONS`, and
`MAISTER_ENGINE_VERSION` must fall within `compat.engine_min..engine_max`.
Incompatibility surfaces as `CONFIG` (422). Semantic validation of the opaque
contract lists is deferred to the milestone that introduces each concept (see
[ADR-021](decisions.md#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)).

**M11a engine bump (Implemented).** M11a bumps the `MAISTER_ENGINE_VERSION`
constant `1.0.0 → 1.1.0` in `web/lib/flows/engine-version.ts`
([ADR-026](decisions.md#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump)).
This is a **code constant, not an env var** — there is no compose / `.env`
wiring for it. A Flow that uses the graph manifest (`nodes[]`) MUST declare
`compat.engine_min: 1.1.0`, so an older engine refuses it through the same
`engine_min..engine_max` check above. `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays
`[1]` (the graph is additive — no `schemaVersion` bump).

**M12 engine bump (Designed).** M12 bumps `MAISTER_ENGINE_VERSION`
`1.1.0 → 1.2.0`. `GRAPH_MIN_ENGINE_VERSION` stays `1.1.0` — a graph-manifest
Flow still only needs `compat.engine_min: 1.1.0` to enable. The **declared-
artifact gate** is the new threshold: validating `input.requires` /
`output.produces` refs against the manifest's declared artifact ids AND
enforcing the `artifact_required` gate require `compat.engine_min ≥ 1.2.0`. A
Flow that declares typed produces/requires or an `artifact_required` gate but
sets `engine_min < 1.2.0` is refused through the same `engine_min..engine_max`
check above. `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays `[1]` (additive).

**Default vs declared artifacts.** DEFAULT artifact recording — the run log,
guard metrics, the human/form answer, and the diff — is captured for **all
runs at engine 1.1.0 with no manifest changes**: every run records these
regardless of what the Flow declares. The DECLARED-artifact contract — typed
`output.produces` / `input.requires` validation plus the `artifact_required`
gate — is opt-in and requires `compat.engine_min ≥ 1.2.0`.

| Capability | Engine floor | Manifest changes | Scope |
| ---------- | ------------ | ---------------- | ----- |
| DEFAULT artifact recording (log, guard metrics, human/form answer, diff) | `1.1.0` | none | every run, always |
| DECLARED-artifact contract (typed `produces`/`requires` validation + `artifact_required` gate) | `1.2.0` | declare `output.produces` / `input.requires` / `artifact_required` | Flows that opt in |

**M15 readiness enforcement (Implemented).** `MAISTER_ENGINE_VERSION` stays `1.2.0`
(no bump). The Review chokepoint readiness check (`assertEvidenceReady`) now applies to
**all** graph flows — the prior engine-gate around it was removed — and evaluates **all**
blocking gate kinds (`command_check`/`ai_judgment`/`skill_check`/`artifact_required`/
`external_check`), not only the two artifact kinds. The new calibration fields below are
optional/additive, so no engine floor change is required
([ADR-048](decisions.md#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15)).

**M26 engine bump (Designed).** M26 bumps `MAISTER_ENGINE_VERSION`
`1.2.0 → 1.3.0` in `web/lib/flows/engine-version.ts`
([ADR-063](decisions.md#adr-063-structured-node-output-channel-p1--run-context-file-p7)).
`MAISTER_ENGINE_VERSION` is a **code constant, not an env var** — there is no
`.env` wiring for it (unlike `MAISTER_NODE_OUTPUT_MAX_BYTES`, the separate
size-cap env var above, which is wired into `.env.example` + this doc only, never
`compose.yml`). A Flow that declares the new node
`output.result` field on any node MUST declare `compat.engine_min: 1.3.0`, so an
older engine refuses it through the same `engine_min..engine_max` check above; a
manifest using `output.result` without `compat.engine_min >= 1.3.0` is rejected
with `CONFIG` (mirrors the M12 declared-artifact gate). A Flow that does **not**
declare `output.result` stays valid at any `engine_min` (back-compat).
`SUPPORTED_FLOW_SCHEMA_VERSIONS` stays `[1]` (the field is additive). The
transport contract and validate seam are in [`flow-dsl.md`](flow-dsl.md) §M26 and
[`system-analytics/flow-graph.md`](system-analytics/flow-graph.md) §M26.

**M30 engine bump (Implemented).** M30 bumps `MAISTER_ENGINE_VERSION` `1.3.0 → 1.4.0`
in `web/lib/flows/engine-version.ts`
([ADR-079](decisions.md#adr-079-node-workspacepolicy-execution-and-checkpoint-capture)).
It is a **code constant, not an env var** — no `.env`/compose wiring. The new node
DSL keys `retry_policy`
([ADR-080](decisions.md#adr-080-node-level-retry-policy)) and `session_policy` plus
the flow `defaults` block
([ADR-081](decisions.md#adr-081-rework-session-policy-with-resume-by-default))
require `compat.engine_min: 1.4.0`; a manifest using any of them with
`engine_min < 1.4.0` is refused with `CONFIG` through the same
`engine_min..engine_max` check. A Flow using none of these keys stays valid at any
`engine_min` (back-compat). `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays `[1]`. The
workspacePolicy-execution, review-diff scopes, and gate-chat features add **no**
flow DSL and need no engine floor. The DSL keys are parsed fresh from
`flow_revisions.manifest` on every launch — a removed key naturally CLEARs (no
persisted upsert state, no SET/CLEAR asymmetry).

**M30 deployment surface (Implemented).** DD10 requires `MAISTER_RUNTIME_ROOT` to
resolve **outside** every registered `repo_path` so checkpoint rewind/discard
(`git clean -fd`) can never reach the run-artifact tree
(`runtimeRoot/.maister/<slug>/runs/<runId>/`); the containment assert
(`containmentAssert` in `workspace-checkpoint.ts` + the `discardWorktree` guard)
hard-blocks any policy run with `MaisterError("PRECONDITION")` when violated —
a deploy precondition. The checkpoint ref namespaces `refs/maister/checkpoints/*` and
`refs/maister/chat-checkpoints/*` are git refs, not env. B20 audit verdict: **no
new env var was introduced** — the candidate `MAISTER_GATE_CHAT_ENABLED` toggle
was not needed (availability is session-presence-driven, ADR-078 DD2), so M30
adds no deployment surface beyond the existing `MAISTER_RUNTIME_ROOT` layout
precondition.

### Verdict calibration (M15)

`ai_judgment` and `skill_check` gates may declare a confidence threshold so a passing
verdict only clears when the agent is sufficiently confident. Two config surfaces:

- **Per-gate** `calibration` (only valid on `ai_judgment` / `skill_check` gates):

  ```yaml
  pre_finish:
    gates:
      - id: quality
        kind: ai_judgment
        mode: blocking
        prompt: "Assess the diff; reply {\"verdict\":...,\"confidence\":0-1,...}."
        calibration:
          confidence_min: 0.8            # 0..1; a pass below this → gate failed
          allow_missing_confidence: false # default false (fail-closed); see below
  ```

- **Flow-level** `verdict_calibration.confidence_min` — a default folded into every
  `ai_judgment` / `skill_check` gate that lacks its own `calibration.confidence_min`, at
  compile time (`web/lib/flows/graph/compile.ts`):

  ```yaml
  schemaVersion: 1
  name: aif
  verdict_calibration:
    confidence_min: 0.7                  # per-gate calibration.confidence_min overrides this
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
it rescues an *absent* confidence, never one *present* but out of the `0..1` domain. A
`blocking` `human_review` gate is rejected at validation (`CONFIG`) — it would deadlock
promotion.

### Guard semantics

`cost` / `time` / `regex` guard fields are parsed and evaluated as
observational signals. Guard results are written to
`.maister/<slug>/runs/<run-id>/guards.jsonl`. Cost guards compare
against token totals from `cost.jsonl` when the supervisor has emitted
usage records. Guards do not kill a run today; enforcement is Phase 2.

## `form_schema` versioning

Every HITL `human` step's form payload includes a required `schemaVersion`
integer. The runtime compares this against the version the agent step
expected; mismatch → `MaisterError({ code: "CONFIG" })`.

```ts
import { validateFormSchemaVersion } from "@/lib/config";

validateFormSchemaVersion(readBackJson, 1);   // ok if readBackJson.schemaVersion === 1
validateFormSchemaVersion(readBackJson, 2);   // throws CONFIG with both versions named
```

Schema shape:

```yaml
schemaVersion: 1
fields:
  - name: comment
    label: Reviewer comment
    type: string             # string | number | boolean | enum | array
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

| Var | Required | Default | Used by |
| --- | -------- | ------- | ------- |
| `AUTH_SECRET` | yes | — | Auth.js v5 session JWT signing. Generate with `openssl rand -base64 33`. Must be identical across all web replicas. |
| `AUTH_URL` | no | derived from request host | Auth.js canonical origin (e.g. `https://maister.example.com`). Only needed when a reverse proxy rewrites the `Host` header in a way that breaks callback URLs. Leave blank in dev. |
| `SEED_ADMIN_EMAIL` | no | `admin@maister.local` | `pnpm db:seed` — email for the initial admin user. |
| `SEED_ADMIN_PASSWORD` | no | `maister-admin` | `pnpm db:seed` — password for the initial admin user. Change before any shared use. |
| `MAISTER_TEMP_PASSWORD_LENGTH` | no | `12` | Web tier. Length of admin-provisioned auto-generated one-time temp passwords (clamped to a minimum of 12). Governs GENERATED passwords only — admin-typed passwords keep the 12-character minimum. Read server-side by the web tier; never logged. |
| `DB_URL` | yes | — | `lib/db/client.ts`; accepts `postgres://...` or `file:...` |
| `MAISTER_DB_POOL_MAX` | no | `10` | Postgres pool size in `lib/db/client.ts` |
| `MAISTER_MAX_CONCURRENT_RUNS` | no | `6` | Global Flow/scratch run concurrency cap (across all projects; counts `run_kind IN ('flow','scratch')`). M24 scheduler `flow_run` jobs delegate to this existing launch queue instead of consuming `command` budgets. (M33 — owner-requested default bump `3 → 6`; env semantics unchanged.) |
| `MAISTER_MAX_CONCURRENT_AGENTS` | no | `3` | **(M33 — Designed, ADR-087.)** Separate concurrency budget for platform-agent runs (`run_kind='agent'`) enforced at `tryStartRun` with its own `Pending` FIFO — agent runs never consume Flow slots and vice versa. Repurposed from the obsolete M24 meaning (SQL claim budget for `agent_tick` attempts — `agent_tick.dispatcher` is now a hardcoded-budget-1 singleton). |
| `MAISTER_MAX_CONCURRENT_COMMANDS` | no | `2` | **Implemented, M24.** SQL claim budget for concurrent `command` scheduler attempts; invalid or non-positive values fall back to `2` and do not reduce or override `MAISTER_MAX_CONCURRENT_RUNS`. |
| `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS` | no | `60` | Web: periodic reconcile sweeper interval (M19) |
| `MAISTER_RECONCILE_GRACE_SECONDS` | no | `90` | Web: grace window before a no-live-session agent run is crashed (protects in-flight launches/recovers) (M19) |
| `MAISTER_GC_SWEEP_INTERVAL_SECONDS` | no | `3600` | Web: background GC sweeper interval (M19) |
| `MAISTER_GC_AGE_DAYS` | no | `14` | Web: age before Abandoned/Done worktrees + Removed flow revisions are GC'd (M19) |
| `MAISTER_GC_WARNING_DAYS` | no | `2` | Web: TTL warning window before removal (color ramp) (M19) |
| `MAISTER_GC_ARCHIVE_PUSH` | no | `false` | Web: push the `maister/archive/<runId>` branch to the remote during GC preserve (M19) |
| `MAISTER_CRON_TOKEN` | no (empty ⇒ `/api/cron/gc` and `/api/cron/tick` return 503 disabled) | (none) | **Server-only secret** for token-guarded cron routes — never logged or streamed. M24 reuses it for `GET`/`POST /api/cron/tick`; `/api/cron/gc` remains a compatibility wrapper. |
| `MAISTER_SCHEDULER_TIMER_ENABLED` | no | `false` | **Implemented, M24.** Enables the single-box web-tier fallback timer when exactly `true`. External cron remains preferred. |
| `MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS` | no | `60` | **Implemented, M24.** Fallback timer cadence only; fixed-interval job cadence lives per `scheduler_jobs.cadence_interval_seconds`. |
| `MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS` | no | `300` | **Implemented, M24.** Lease timeout for stuck `Claimed`/`Running` scheduler attempts before reaping as `Failed`. |
| `MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES` | no | `3` | **Implemented, M24.** Auto-disable threshold for repeated `agent_tick` precondition/launcher failures during result recording and lease reaping; invalid or non-positive values fall back to `3`. Other job kinds use `scheduler_jobs.max_failures`. |
| `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` | no | `300` | **(Implemented, M18 — ADR-058, Codex F1.)** Stale-`claiming` promotion-claim reclaim window (seconds). A `workspaces.promotion_state='claiming'` claim older than this is reclaimable by the next promote attempt (crash recovery), which re-mints `promotion_attempt_id`. Read by the web tier's shared `promoteRun` service. Host/service-env only — the default compose stays Postgres-only per [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres), so this is never a container/compose var. |
| `MAISTER_API_BASE_URL` | no | `http://localhost:3000` | **(M16 — Implemented)** MCP facade: base URL of the MAIster REST API the `mcp/` package wraps (e.g. `http://localhost:3000` in dev; external HTTPS in prod). |
| `MAISTER_PROJECT_TOKEN` | no | (none) | **(M16 — Implemented)** MCP facade **stdio/local-only** project token. **IGNORED** under the Streamable-HTTP transport, which requires a per-request inbound bearer forwarded verbatim to `/api/v1/ext`. Not a web-tier secret — never read by `web/` or `supervisor/`. |
| `MCP_TRANSPORT` | no | (unset → `http`) | **(M16 — Implemented)** MCP facade transport select. Unset = Streamable-HTTP (remote; per-request inbound bearer, no ambient token). `stdio` (or `--stdio`) = local stdio transport reading `MAISTER_PROJECT_TOKEN`. |
| `MCP_PORT` | no | `3001` | **(M16 — Implemented)** MCP facade HTTP bind port for the Streamable-HTTP transport. Unused under stdio. |
| `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` | no | unset (empty) | M10 Flow package trust policy (ADR-021). Comma-separated source-URL prefixes that are `trusted_by_policy` (auto-enabled on install). `local`/`file://` sources are always trusted by policy; every other git source is `untrusted` until an explicit per-(project, revision) trust confirmation. Read by the web tier (`web/lib/flows/trust.ts`) at install time. |
| `MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES` | no | unset (empty) | **Implemented (M14).** Comma-separated source-URL prefixes for `capability_imports[]` entries that are granted `trusted_by_policy` (auto-trusted on install, no explicit confirm required). Mirrors `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` exactly — same prefix-match semantics, same `local`/`file://` always-trusted rule. Every other git source is `untrusted` until an operator calls `POST /api/projects/{slug}/capabilities/{capabilityRefId}/trust`. Setting `trust: explicit` on a `capability_imports[]` entry forces the confirm step even for policy-trusted sources. Read by `web/lib/capabilities/import.ts:resolveCapabilityTrust()`. See ADR-043. |
| `MAISTER_KEEPALIVE_MINUTES` | no | `30` | NeedsInput keep-alive window (minutes). Read by BOTH supervisor (pending-permission deferred timeout) AND web (sweeper expiry, activity-bump amount, useActivityPing heartbeat at half-window). Bumped by every `POST /api/runs/:runId/activity`. |
| `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` | no | `30` | M8 keep-alive sweeper tick frequency (seconds). The singleton timer in `web/lib/runs/keepalive-sweeper.ts` calls `runSweepTick()` every interval. Lower → snappier idle transitions; higher → less DB load. |
| `MAISTER_NEEDSINPUTIDLE_TTL_HOURS` | no | `24` | M8 NeedsInputIdle abandonment TTL (hours). Sweeper pass 2 flips `NeedsInputIdle` rows whose `checkpoint_at + ttl < now()` to `Abandoned` and closes any open `hitl_requests.respondedAt`. |
| `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` | no | `60` | M8 resume-prompt watchdog (seconds). After a `NeedsInputIdle` row is resumed (ACP `session/resume`), the runner-agent must receive `session.permission_request` within this window or `crashResumedRun` transitions the run to `Crashed`. (Helper exists; runner-agent enforcement is a follow-up patch.) |
| `MAISTER_WORKBENCH_MAX_FILE_BYTES` | no | `524288` (512 KiB) | **(M22 — Implemented, ADR-053.)** Max size of a single git-tracked blob the workbench file viewer serves. A larger file renders the `file-too-large` page state on the `?file=` RSC path (ADR-066; not an HTTP `413`); bytes are never sent. Read by `web/lib/instance-config.ts:workbenchMaxFileBytes()`. Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is never a container/compose var. |
| `MAISTER_NODE_OUTPUT_MAX_BYTES` | no | `262144` (256 KiB) | **(M26 — Implemented, [ADR-063](decisions.md#adr-063-structured-node-output-channel-p1--run-context-file-p7).)** Caps a graph node's structured-output payload (the agent ` ```json maister:output ` block or the cli `MAISTER_OUTPUT_FILE` contents) before parse/validate at the post-action seam; exceeding it fails the attempt with `MaisterError({ code: "CONFIG" })`. Read by `web/lib/instance-config.ts:nodeOutputMaxBytes()`. Host/service-env only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is wired into `.env.example` + this doc **only**, never `compose.yml` (mirrors the `MAISTER_WORKBENCH_MAX_FILE_BYTES` precedent). See [`system-analytics/flow-graph.md`](system-analytics/flow-graph.md) §M26 and [`flow-dsl.md`](flow-dsl.md) §M26. |
| `MAISTER_HARNESS_NEVER_FIRED_MIN` | no | `10` | **(M29 — Implemented, [ADR-073](decisions.md#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension).)** Minimum terminal gate executions in the observatory lookback window before the never-fired heuristic may flag a declared gate ("never fired — verify gate quality or a blind spot"). Read by `web/lib/instance-config.ts:harnessNeverFiredMin()` at the query layer and passed into the pure rollup as a parameter; invalid/non-positive values fall back to the default with a one-time WARN. Host/service-env only ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)) — never a compose var. See [`system-analytics/observatory.md`](system-analytics/observatory.md). |
| `MAISTER_PROJECTS_DIR` | no | unset | Auto-discovery root; every `maister.yaml` under this dir is registered on startup |
| `MAISTER_REPOS_ROOT` | no | `~/.maister/repos` | Root that `POST /api/projects` clones a `repoUrl` into (ADR-025). Resolved by `web/lib/instance-config.ts:reposRoot()`; surfaced read-only on `/settings`. |
| `MAISTER_WORKTREES_ROOT` | no | `~/.maister/worktrees` | Root for run worktrees (ADR-025). Resolved by `worktreesRoot()`. The deprecated `MAISTER_WORKTREE_ROOT` is accepted as a fallback. Surfaced read-only on `/settings`. |
| `MAISTER_SUPERVISOR_URL` | no | `http://localhost:7777` | Web → supervisor HTTP+SSE base URL — see [Supervisor](supervisor.md) |
| `MAISTER_SUPERVISOR_PORT` | no | `7777` | Supervisor bind port (read by `supervisor/src/main.ts`) |
| `MAISTER_RUNTIME_ROOT` | no | supervisor `cwd` | Root under which `.maister/<slug>/runs/...` is written |
| `MAISTER_HEARTBEAT_INTERVAL_MS` | no | `5000` | Supervisor orphan-child detection |
| `MAISTER_KILL_GRACE_MS` | no | `5000` | SIGTERM → SIGKILL grace per session |
| `MAISTER_SHUTDOWN_GRACE_MS` | no | `15000` | Total budget for graceful supervisor shutdown |
| `LOG_LEVEL` | no | `debug` (dev) / `info` (prod) | pino level for both web and supervisor |
| `ANTHROPIC_API_KEY` | no | — | Optional provider env inherited by spawned children if present; ACP tools are configured in their own CLIs by default. Also read by the model-discovery `provider_api` source for plain `anthropic` runner drafts (ADR-076). |
| `ANTHROPIC_BASE_URL` | no | api.anthropic.com | Per-executor `env` overrides the global default |
| `ANTHROPIC_AUTH_TOKEN` | no | uses tool/provider default | Optional explicit provider env when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …). Platform runners should prefer typed env refs only when overriding CLI-native config. |
| `OPENAI_API_KEY` | no | — | Model discovery only (ADR-076): the supervisor's `provider_api` source lists models for plain `openai` codex runner drafts; unset → that source reports `skipped`. NOT used to run codex sessions. |
| `MAISTER_CCR_AUTH_TOKEN` | no | unset | Fallback for `ANTHROPIC_AUTH_TOKEN` when an executor has `router: ccr` and does not pin the token in `executor.env`. Missing token → `EXECUTOR_UNAVAILABLE` (503). |
| `MAISTER_ADAPTER_SMOKE_CACHE_PATH` | no | `<runtimeRoot>/adapter-smoke-cache.json` | Optional supervisor-side diagnostics cache written by `pnpm -C supervisor smoke:acp --cache <path> gemini opencode mimo`. Gemini/OpenCode/MiMo readiness requires cached `smoke.status="ok"`. Host/service-env only; never a compose var in the default Postgres-only topology. |
| `MAISTER_DIAGNOSTIC_ENV_REFS` | no | unset | Optional comma-separated extra env-ref names exposed by supervisor `/diagnostics` as `{name,present}`. Values are never returned. Use for custom runner provider env refs beyond the built-in safe catalog. |
| `MAISTER_CCR_CONFIG_PATH` | no | `/app/.ccr/config.json` in Docker, `~/.claude-code-router/config.json` otherwise | Container-side path the supervisor reads for CCR host+port. In compose this aligns with the bind-mount target — leave unset unless changing the layout. |
| `MAISTER_CCR_CONFIG_HOST_PATH` | no (Docker only) | `${HOME}/.claude-code-router` | Host directory bind-mounted at `/app/.ccr` (read-only) in the supervisor service. Point at a secret-mount directory for hardened deployments. |
| `MAISTER_WEBHOOK_DELIVERY_BATCH` | no | `20` | **(Implemented, ADR-077.)** Max deliveries (and outbox events) claimed per `webhook_delivery` scheduler drain tick. Bounds per-tick memory and HTTP concurrency. Web tier only — `web` runs on the host ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)), so this is wired into `.env.example` + this doc **only**, never `compose.yml`. |
| `MAISTER_WEBHOOK_TIMEOUT_MS` | no | `10000` | **(Implemented, ADR-077.)** Per-attempt HTTP timeout in milliseconds for outbound webhook delivery. Applies to both the drain path and the synchronous test-ping route. Web tier only — host/service-env, never a `compose.yml` var (see [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). |
| `MAISTER_WEBHOOK_MAX_ATTEMPTS` | no | `8` | **(Implemented, ADR-077.)** Terminal-dead threshold: a delivery whose `attempt_count` reaches this value is permanently set to `dead` status. The default covers the full retry curve (`1m, 5m, 15m, 1h, 4h, 12h, 24h` → initial + 7 retries = 8 total, ~41.5 h). Web tier only — host/service-env, never a `compose.yml` var (see [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). |
| `MAISTER_WEBHOOK_ALLOW_HOSTS` | no | unset | **(Implemented, ADR-077 revised.)** Comma-separated EXACT hosts (case-insensitive) exempt from the outbound-webhook destination egress policy, which blocks loopback / private / link-local (incl. `169.254.169.254` metadata) / multicast / unspecified destinations at write AND send time. Set e.g. `127.0.0.1` to deliver to a local consumer in dev/e2e. Web tier only — host/service-env, never a `compose.yml` var (see [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). |

**M17 env-variable parity:** M17 adds no new environment variable. The table
above is identical to `.env.example`; `compose*.yml`, bound ports, and the
supervisor sidecar configuration are unchanged by M17.

Secrets MUST live in `.env` server-side. Never logged, never streamed via
SSE, never embedded in `session/update` payloads visible to the browser.

`.env.example` in the repo root documents the full set with safe placeholder
values.

## Authentication & RBAC

MAIster uses **Auth.js v5** (formerly NextAuth.js) with a **credentials
provider only**. OAuth providers are not configured in M9.

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

| Role | Capabilities |
| ---- | ------------ |
| `admin` | Register projects, approve/disable users, change global roles, reset user passwords, is implicit `owner` of every project. |
| `member` | Default. Can be added to projects; cannot register new projects. |
| `viewer` | Read-only access to projects they are explicitly added to. |

**Project roles** (`project_members.role`): `owner | admin | member | viewer`.
Enforced by `lib/authz.ts:requireProjectRole()` / `requireProjectAction()`.

| Role | Min action | Capabilities |
| ---- | ---------- | ------------ |
| `owner` | — | All actions including project archival. |
| `admin` | `editSettings` | Edit project settings. |
| `member` | `launchRun`, `operateScratchRun`, `promoteRun`, `createTask`, `answerHitl` | Launch Flow/scratch runs, operate scratch dialogs, promote run branches, create tasks, respond to HITL. |
| `viewer` | `readBoard`, `readScratchRun` | Read the board, active workspace metadata, scratch dialogs, and stream run events. |

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

| Export | Signature | Throws on |
| ------ | --------- | --------- |
| `loadProjectConfig(path)` | `(string) => Promise<MaisterYamlV2>` | Missing file, invalid YAML, schema error, cross-ref failure. All → `MaisterError({ code: "CONFIG" })`. |
| `loadFlowManifest(path)` | `(string) => Promise<FlowYamlV1>` | Missing file, invalid YAML, schema error, dup step ids, dangling `goto_step`. All → `MaisterError({ code: "CONFIG" })`. |
| `validateFormSchemaVersion(obj, expected)` | `(unknown, number) => void` | Malformed form schema OR version mismatch. → `MaisterError({ code: "CONFIG" })` with both versions in the message. |

### `lib/config.schema.ts`

Zod schemas + inferred types:

```ts
import {
  maisterYamlV2Schema, type MaisterYamlV2,
  flowYamlV1Schema, type FlowYamlV1,
  executorSchema, type ExecutorConfig,
  flowEntrySchema, type FlowEntry,
  stepSchema, type Step,
  formSchemaSchema, type FormSchema,
} from "@/lib/config.schema";
```

Import the inferred types in Route Handlers / components instead of
hand-rolling DTOs — the zod schema is the single source of truth.

## CCR (Claude Code Router) bundling

When an executor sets `router: ccr`, MAIster spawns the bundled
[`@musistudio/claude-code-router@2.0.0`](https://www.npmjs.com/package/@musistudio/claude-code-router)
daemon and routes the adapter through it for in-session multi-provider
routing (z.ai GLM, MiniMax, OpenRouter, …).

- The npm package is an exact-pinned **supervisor** dep — operators do
  NOT need to install `ccr` globally. The bin is on the workspace path.
- The supervisor owns the daemon lifecycle. The first `router=ccr`
  spawn lazily starts CCR; subsequent spawns within the same supervisor
  process reuse the same daemon; supervisor SIGTERM/SIGINT stops it.
- The daemon's own configuration file
  (`~/.claude-code-router/config.json`) is **user-managed**. MAIster
  reads `HOST` / `PORT` from it (defaults `127.0.0.1:3456`) but never
  writes the file. Provider keys, default models, routing rules — all
  in that file. In Docker, the host directory (default
  `~/.claude-code-router`, overridable via `MAISTER_CCR_CONFIG_HOST_PATH`)
  is bind-mounted **read-only** at `/app/.ccr` inside the supervisor
  container; the supervisor reads `/app/.ccr/config.json`.
- The adapter token sent in `ANTHROPIC_AUTH_TOKEN` resolves from the runner's
  sidecar/provider secret reference or `MAISTER_CCR_AUTH_TOKEN` (server env).
  Missing token surfaces as `EXECUTOR_UNAVAILABLE` (503).
- See [executors §CCR setup](system-analytics/executors.md#ccr-setup)
  for the full failure-mode table (config missing, malformed JSON,
  health-check timeout, token missing).

Example platform runner routing GLM through CCR:

```yaml
platform:
  default_runner: claude-glm-ccr
router_instances:
  - id: ccr-default
    kind: ccr
    lifecycle: managed
    command_preset: ccr_start
    config_path: ~/.claude-code-router/config.json
    auth_token: env:CCR_ADAPTER_TOKEN
acp_runners:
  - id: claude-glm-ccr
    adapter: claude
    model: glm-5.1
    provider:
      kind: anthropic_compatible
    router_instance: ccr-default
```

Example `~/.claude-code-router/config.json` (placeholders — replace
with real values):

```json
{
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "Providers": [
    {
      "name": "z.ai",
      "api_base_url": "https://api.z.ai/api/anthropic",
      "api_key": "<Z_AI_KEY_PLACEHOLDER>",
      "models": ["glm-4.6"]
    }
  ],
  "Router": {
    "default": "z.ai,glm-4.6"
  }
}
```

## Cost tracking on resume (M8)

Every line appended to `.maister/<projectSlug>/runs/<runId>/cost.jsonl`
by a supervisor session that was resumed (spawned with a `resumeSessionId`,
restored via the ACP `session/resume` call) carries
`"resumed": true`. The marker is added in `supervisor/src/cost.ts`'s
`attachCost(opts)` from `opts.resumed = Boolean(parsed.resumeSessionId)`
at session creation time. The M0 spike measured ~$0.28 of
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
