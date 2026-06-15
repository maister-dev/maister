# Flow Studio domain

> **Status: Implemented (M27 Stage 1).** The editor write path, the
> authored→executable bridge with the two-axis trust gate, `version_binding`
> resolve-at-launch, the resolved-capability-set snapshot (in-flight
> immutability), and the MCP management surfaces described here have shipped.
> Source of truth: [`.ai-factory/specs/feature-m27-flow-studio-stage-1.md`](../../.ai-factory/specs/feature-m27-flow-studio-stage-1.md).

## Purpose

The **Flow Studio** domain covers in-app authoring and executable resolution for
flows: turning the read-only M22 workbench graph view into a graph editor that
persists validated authored drafts, publishing those drafts through an
executable bridge that creates runnable `flows` / `flow_revisions` rows, managing
the two independent trust axes (`flows.trustStatus` and
`flow_revisions.exec_trust`) that gate setup and MCP-stdio spawning, resolving
the effective revision at launch via `version_binding`, and snapshotting the
resolved capability set so in-flight runs stay immutable. Its boundary starts
at the edit canvas and ends at the frozen `runs.resolved_capability_set` written
at launch. MCP capability management at platform scope is covered here in so far
as it interacts with the capability-resolution precedence and the executable
bridge; per-run workbench visualization remains in
[`workbench.md`](workbench.md) and flow-graph execution semantics remain in
[`flow-graph.md`](flow-graph.md).

## Domain entities

- **Authored flow draft / revision** — `authored_capabilities` row (kind=`flow`)
  with a mutable draft body, plus immutable `authored_capability_revisions` rows
  (`manifest`, `content_hash`). Source: `web/lib/catalog/authored-service.ts`.
  Persisted in the capabilities schema — see
  [`../db/capabilities-domain.md`](../db/capabilities-domain.md).
- **`source_flow_ref_id` link** — NEW column `authored_capabilities.source_flow_ref_id
  text NULL` (DDL migration `0033+`). When an operator edits an already-installed
  flow the link records its `flow_ref_id` so publish→bridge targets the same
  `flows` lineage. A net-new authored flow mints a fresh `flow_ref_id`.
- **Bridged `flows` / `flow_revisions` rows** — the existing executable-package
  rows produced by `installAuthoredFlowPackageBridge` in `web/lib/flows.ts`.
  Bridge sets `flows.trustStatus=trusted_by_policy` and
  `flow_revisions.exec_trust=untrusted` on publish.
- **`version_binding`** — NEW column `flows.version_binding text NOT NULL DEFAULT
  'latest'` with CHECK `pinned|latest`. **(Stage-1)** `resolveEffectiveFlowRevision`
  resolves `flows.enabled_revision_id` for BOTH bindings; authored "latest"
  auto-follows because publish→bridge (T-B2) repoints `enabled_revision_id` to
  the newest published revision. **(Phase 2 — deferred)** `latest` resolves the
  newest PUBLISHED `flow_revisions` for the `flow_ref_id` (authored-wins
  tie-break; never a draft) — the global `flow_revisions` pool needs a
  project-scoped published index first. The column + toggle (T-B1) persist
  intent now.
- **`flow_revisions.exec_trust`** — NEW second trust axis per-revision (`untrusted
  | trusted`, DDL `0033+`). Gates `runRevisionSetup` (setup.sh) and MCP-stdio
  `command` spawn. Independent of `flows.trustStatus`; a logic-trusted flow is
  never exec-trusted automatically.
- **`runs.resolved_capability_set`** — NEW column `jsonb NULL` (DDL `0033+`).
  Shape: `{ flowRevisionId, flowOrigin, capabilities[], mcps[] }`. Frozen at
  launch, read by the runner. See [`../db/runs-domain.md`](../db/runs-domain.md).
- **Platform MCP server** — NEW table `platform_mcp_servers` (DDL `0033+`), mirroring
  `platform_acp_runners`. Carries transport (`stdio|sse|http`), secrets as
  `env:NAME` references, and its own `trust_status` / `readiness_status`.
- **MCP capability record** — existing `capability_records` (kind=`mcp`,
  source∈`{platform,project,flow-package}`), extended with discriminated
  transport shape (`stdio|sse|http`). Resolution precedence: project > platform >
  flow-package (exactly one winner per `(kind, refId)`, no duplicate
  materialization).

Full ERD: [`../db/capabilities-domain.md`](../db/capabilities-domain.md),
[`../db/projects-domain.md`](../db/projects-domain.md),
[`../db/runs-domain.md`](../db/runs-domain.md).

## State machines

### Authored-flow lifecycle

The lifecycle of an authored flow from first edit through launch, covering both
in-app and bridge states.

```mermaid
stateDiagram-v2
    [*] --> Draft: create / open authored cap (kind=flow)
    Draft --> Draft: PATCH /draft (validateGraphManifest gate, CAS)
    Draft --> Published: POST publish-local (M25 revision commit)
    Published --> Bridged: installAuthoredFlowPackageBridge\ntrustsStatus=trusted_by_policy\nexec_trust=untrusted
    Bridged --> ExecTrusted: POST trust-executable\nexec_trust=trusted
    ExecTrusted --> SetupDone: runRevisionSetup runs setup.sh (sentinel once)
    SetupDone --> Enabled: flows.enabled_revision_id set
    Enabled --> LaunchResolved: resolveEffectiveFlowRevision(version_binding)
    LaunchResolved --> Snapshotted: runs.resolved_capability_set frozen at INSERT
    Snapshotted --> [*]: run is immutable
```

### exec_trust axis

The executable-trust state machine is per-revision and independent of
`flows.trustStatus`; explicit operator action is the only transition.

```mermaid
stateDiagram-v2
    [*] --> Untrusted: bridge sets exec_trust=untrusted (default)
    Untrusted --> Trusted: POST /trust-executable (operator action)
    Trusted --> Untrusted: (no rollback path — new revision required)
```

## Process flows

### Edit → validate → save-draft → publish → bridge → trust → setup → launch-resolve → snapshot

The full happy-path from the canvas editor to a frozen immutable run, showing
the hard-gate, two-phase bridge, and snapshot insertion.

```mermaid
sequenceDiagram
    actor Op as Operator (manageCatalog)
    participant Ed as Flow Editor (client)
    participant W as Web tier
    participant DB as Postgres
    participant FS as flows.ts bridge

    Op->>Ed: edit nodes / edges / settings
    Ed->>W: PATCH /catalog/caps/{capId}/draft\n(manifest, expectedDraftVersion)
    W->>W: validateGraphManifest + compileManifest
    alt invalid manifest
        W-->>Ed: 422 MaisterError CONFIG (NOT persisted)
    else valid
        W->>DB: UPDATE authored draft CAS (draft_version)
        alt stale CAS
            W-->>Ed: 409 MaisterError CONFLICT
        else ok
            W-->>Ed: 200 saved draft
        end
    end
    Op->>W: POST publish-local
    W->>DB: INSERT authored_capability_revisions (immutable)
    W->>FS: installAuthoredFlowPackageBridge(trusted_by_policy)
    FS->>DB: intent row Installing (two-phase)
    FS->>DB: finalize Installed\ntrustStatus=trusted_by_policy\nexec_trust=untrusted
    W-->>Op: 200 {revision, flowRowId, revisionId}
    Op->>W: POST /flows/{flowId}/trust-executable
    W->>DB: exec_trust=trusted
    W->>FS: runRevisionSetup (gated on exec_trust, sentinel once)
    Op->>W: Launch task
    W->>W: resolveEffectiveFlowRevision(version_binding)
    W->>DB: INSERT runs + resolved_capability_set snapshot (in same tx)
    W-->>Op: run started (immutable)
```

## Expectations

The following bullets are copied verbatim from SDD §7.1 (RFC-2119 spirit, each
testable):

1. A draft save MUST run `validateGraphManifest`+`compileManifest` BEFORE the `draft_version` CAS write; an invalid manifest MUST throw `CONFIG` and MUST NOT mutate the draft row.
2. A stale `expectedDraftVersion` MUST fail with `CONFLICT` (409) and MUST NOT write.
3. Editing an installed flow MUST record its `source_flow_ref_id` so publish→bridge targets the SAME `flows` lineage; a net-new authored flow MUST mint a fresh `flow_ref_id`.
4. Publishing an authored `flow` MUST bridge it into a `flows` row + `flow_revisions` row via `installAuthoredFlowPackageBridge`, `trustStatus=trusted_by_policy`, `exec_trust=untrusted`.
5. `setup.sh` MUST NOT run on publish/bridge; it runs ONLY after an explicit `exec_trust` flip, via `runRevisionSetup` (physically separate, sentinel once-only).
6. An MCP stdio `command` MUST NOT be spawned for a revision whose `exec_trust≠trusted`.
7. Launch resolves the effective revision via `resolveEffectiveFlowRevision`. **(Stage-1)** BOTH `pinned` and `latest` resolve `flows.enabled_revision_id` (never a draft); authored "latest" auto-follow is realized by publish→bridge repointing the pointer (T-B2). **(Phase 2 — deferred)** `latest` → newest PUBLISHED revision, authored-wins on tie.
8. Launch MUST snapshot the resolved set into `runs.resolved_capability_set`; the runner MUST read the snapshot, never the live catalog; an edit/publish during a run MUST NOT mutate that run.
9. The editor MUST be read-write only for users with `manageCatalog`; the run-scoped view stays read-only (`readBoard`).
10. No engine bump; no new `runs.status`; presentation stays additive/runner-ignored.

## Edge cases

These map to the authoring and bridge rows from SDD §8:

| Case | `MaisterError` code | HTTP |
|---|---|---|
| Invalid manifest on draft save or publish (not persisted) | `CONFIG` | 422 |
| Stale `expectedDraftVersion` on PATCH /draft | `CONFLICT` | 409 |
| Unknown MCP/skill ref in manifest at validation | `CONFIG` | 422 |
| Required MCP unresolved at launch (`launchRun` insertion point #2) | `CONFIG` | 409 |
| Required MCP agent-unsupported at launch | `EXECUTOR_UNAVAILABLE` | 503 |
| `setup.sh` or MCP stdio spawn attempted before `exec_trust` flip | guarded (no exec, no error raised) | n/a |
| Bridge of an invalid package | `CONFIG` | 422 |
| `version_binding` set to an unknown enum value | `CONFIG` | 422 |

For platform MCP CRUD edge cases (delete while referenced, duplicate id), see
[`acp-runners.md`](acp-runners.md) for the mirror pattern; the MCP server CRUD
follows the same usage-guard and dup-id rules as ADR-065.

## Phase 2 (part 1): package viewing, reachability, fork, and artifact-aware editing (Implemented)

> **Status: Implemented (Flow Studio Phase 2, part 1).** Source of truth:
> [`.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md`](../../.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md);
> decision [ADR-075](../decisions.md#adr-075). This part makes an INSTALLED
> (git-pinned, immutable) flow package browsable + forkable and gives its
> bundled artifacts real editors. **No migration, no engine bump, no new
> `runs.status` / `MaisterError` code.** The sections below ADD to the M27
> Stage-1 contract above; they do not change it.

### Scope (Implemented)

**Track 0** — view an installed package's read-only graph (compiled from the DB
`manifest`) + raw `flow.yaml` + every bundled artifact file (read from disk at
`flow_revisions.installed_path`), kill the decoy `cursor-pointer` cards, and add
"Fork to edit" (immutable revisions always fork to an M25 authored draft with
`source_flow_ref_id` lineage). **Track 1** — a derived file tree + per-kind
artifact editors (skill/rule/agent frontmatter forms, shell editor + heuristic
lint, `form_schema` builder with live preview), per-kind content validation wired
into the draft-save hard-gate, a CodeMirror `flow.yaml` editor with live
YAML→graph re-seed, and a typed-edge modal-on-connect.

### Domain deltas (Implemented)

- **No DDL.** Every column relied on already exists: `flow_revisions.installed_path`
  (disk root for file bodies), `flow_revisions.manifest` (compiled to the static
  graph), `flow_revisions.exec_trust` (DISPLAYED, never flipped here),
  `flows.flow_ref_id` (viewer URL segment + fork lineage target),
  `flows.enabled_revision_id` (default revision), `authored_capabilities.source_flow_ref_id`
  (written by the fork). This feature adds no migration.
- **`installed_path` is a server-only handle** — it MUST NOT appear in any
  client-visible DTO, RSC-serialized prop, browser-streamed log line, or error
  message.
- **NEW client-safe modules (no DB, no new dep):** `lib/flows/package-content.ts`
  (confined disk reader, §below), `lib/flows/artifact-frontmatter.ts`
  (split/serialize + `skillFrontmatterSchema` / `agentFrontmatterSchema` /
  `ruleGuardrailSchema`, unknown keys preserved), `lib/flows/artifact-validate.ts`
  (per-kind content issues). `source_flow_ref_id` is server-seeded by the fork via
  a direct `createAuthoredCapability` call (the public `POST /caps` body is NOT
  widened; `createAuthoredCapabilitySchema` is unchanged).
- **File model** stays `files[{path, content}]`; the tree is a derived client
  view; **kind is inferred from path** via `classifyPackageFile` (the manual kind
  `<select>` is removed — install/bridge classify by path only).

### Process flows (Implemented)

Installed-package read path — authz precedes every read; disk loss degrades, never
throws; `?file=` is confined before any fs call.

```mermaid
flowchart TD
    Open([Member opens package viewer]) --> Auth[requireProjectAction readRepoFiles]
    Auth --> Flow[load flows row by project and flowRefId]
    Flow -->|none| NF[404 not found]
    Flow --> Rev{rev query given}
    Rev -->|yes| Join[resolve via project-scoped join]
    Rev -->|no| Enabled[use enabled revision pointer]
    Join --> Compile[compileManifest from DB manifest]
    Enabled --> Compile
    Compile -->|ok| Graph[static FlowGraphView without runContext]
    Compile -->|throws| YamlOnly[yaml-only fallback plus notice]
    Graph --> Files[list installed_path files on disk]
    Files -->|dir gone| Degraded[bundle-not-available state]
    Files --> Pick{file query given}
    Pick -->|yes| Confined[confined read text binary too-large not-found]
    Pick -->|no| Done([render])
```

Fork-to-edit — all reads precede ONE transaction; nothing executes; the fork
lands the caller in the existing editor.

```mermaid
sequenceDiagram
    actor Mgr as Manager (manageCatalog)
    participant W as Web tier
    participant DB as Postgres
    participant FS as Bundle on disk

    Mgr->>W: POST .../revisions/{revisionId}/fork {slug?, title?}
    W->>DB: resolve flows + revision (project-scoped)
    alt foreign or unknown
        W-->>Mgr: 404 NotFound
    else resolved
        W->>FS: readAuthoredFlowPackageDirectory(installedPath)
        alt missing or unreadable bundle
            W-->>Mgr: 422 CONFIG (nothing persisted)
        else read ok
            W->>DB: createAuthoredCapability kind=flow, sourceFlowRefId=flowRefId (one tx)
            alt explicit slug collision
                W-->>Mgr: 409 CONFLICT
            else
                W-->>Mgr: 201 {capId, projectSlug, slug}
            end
        end
    end
```

### Per-kind content-validation severity (Implemented)

One shared module emits `{severity, code, path, message}`. The BLOCK subset is
wired into the server draft-save hard-gate (alongside
`assertAuthoredFlowManifestValid`, BEFORE the `draft_version` CAS → `CONFIG` 422),
mirrored client-side; the WARN subset is advisory only. New codes EXTEND the
existing `AuthoredFlowPackageValidationIssueCode` union (`yaml_parse | schema |
graph | unsafe_path | duplicate_path | path_conflict | unsupported_kind |
binary_content`).

| Severity | Code | Fires when |
|---|---|---|
| BLOCK | `schema_json_invalid` | a `schemas/**/*.json` file fails `JSON.parse` |
| BLOCK | `form_schema_invalid` | a schema file REFERENCED by the manifest (`form_schema:` / `output.result.schema:`) fails `formSchemaSchema` |
| BLOCK | `frontmatter_missing` | `skills/**/SKILL.md` or `agents/*.md` with missing/unparseable frontmatter |
| BLOCK | `frontmatter_field_missing` | such a file missing `name` or `description` |
| WARN | `rule_guardrail_shape` | rule guardrail frontmatter malformed (no web runtime parser → cannot block) |
| WARN | `shell_lint` | a shell heuristic-lint finding (pure JS, no shellcheck) |
| WARN | `form_schema_unreferenced` | `formSchemaSchema` issue on a schema file NOT referenced by the manifest |
| WARN | `frontmatter_unknown_key` | unknown frontmatter key (preserved verbatim) |

Manifest-reference resolution runs ONLY when the manifest parses (an unparseable
yaml persists RAW with `manifest=null` by design); file-level BLOCK checks run
regardless. Both save paths gate: the `updateAuthoredFlowAction` server action and
`PATCH /caps/[capId]/draft`. An installed package with pre-existing BLOCK-violating
artifacts still FORKS; the first SAVE surfaces the blocks.

### Editor behavior contracts (Implemented)

- **Static graph:** `FlowGraphView` gains optional `runContext?`; absent → no SSE
  subscription, no `/graph-status` fetch, no status chips / current-node ring.
- **Live YAML→graph:** `FlowEditorTabs` becomes the single manifest-state owner;
  a debounced (~400ms) parse re-seeds the canvas; a parse/validate error keeps the
  last-good graph + an inline banner. Requires `compileManifest` + the topology
  builder to be client-safe (errors-core swap; `server-only` leaks caught only by
  the e2e client-bundle smoke).
- **Typed edges:** `handleConnect` opens a modal collecting the outcome (default
  `success`; duplicate outcome → retarget warning) and writes through
  `setTransition` — the SAME action the side-form uses; no second edge store.
- **Presentation:** `addNode` persists the canvas spawn x/y into `presentation`;
  `width/height/color` round-trip and are applied in both the editor canvas and
  the read-only view. No canvas resize-handles / colour palette.

### Expectations (Implemented)

1. The viewer MUST gate on `readRepoFiles` before any read; a missing-on-disk bundle MUST degrade (metadata + graph from the DB `manifest`) and MUST NOT throw.
2. The read-only graph MUST render OUTSIDE any run with NO SSE subscription and NO `/graph-status` fetch, honouring `presentation` (dagre fallback).
3. Every `?file=` read MUST be path-confined (`repoRelPathSchema` sink-invariant → lexical prefix → `realpath`) before any fs call; files > 1 MiB → `too-large`; NO client surface MUST contain `installed_path`.
4. "Fork to edit" MUST seed an authored `flow` draft with `flow.yaml` + files + `source_flow_ref_id = flowRefId` in ONE transaction, executing NOTHING, then land in the editor.
5. Fork slug MUST default to `flowRefId` and probe `-fork`/`-fork-N` on `(project_id, kind, slug)` collision; an EXPLICIT colliding slug MUST return 409; a missing/unreadable bundle MUST return 422 with nothing persisted; a foreign revision/flow MUST return 404.
6. A draft save MUST run the per-kind BLOCK content validation alongside `assertAuthoredFlowManifestValid`, BEFORE the `draft_version` CAS; a BLOCK issue MUST throw `CONFIG` (422) and MUST NOT mutate the draft row; BOTH save paths MUST gate.
7. Artifact kind MUST be inferred from path; frontmatter round-trip MUST be byte-stable for untouched fields and preserve unknown keys.
8. Editing `flow.yaml` text MUST re-seed the canvas without reload; a parse error MUST keep the last-good graph; `handleConnect` MUST write through `setTransition`.
9. `addNode` MUST persist spawn x/y; `width/height/color` MUST round-trip and be applied in editor + read-only view.
10. The editor MUST be read-write only for `manageCatalog`; the run-scoped view stays `readBoard`. No engine bump, no new `runs.status`.

### Edge cases (Implemented)

| Case | `MaisterError` code | HTTP |
|---|---|---|
| Fork: missing/unreadable bundle dir | `CONFIG` | 422 |
| Fork: explicit colliding slug | `CONFLICT` | 409 |
| Fork: foreign/unknown `flowRefId` or `revisionId` | (not-found) | 404 |
| Draft save: BLOCK content issue (frontmatter/JSON/`form_schema`) | `CONFIG` | 422 (not persisted) |
| `?file=` traversal/symlink/NUL/abs/leading-`-` | rejected pre-fs | not-found state (no throw) |
| Compile failure of stored `manifest` | yaml-only fallback | n/a (no 500) |

## Studio redesign (Phase A IA + editable-local-package direction)

> **Status: Phase A — IA & surfacing (Designed at this commit; Implemented on the
> Phase A merge).** Surface SSOT: [`../screens/studio/README.md`](../screens/studio/README.md).
> SDD spec: [`../../.ai-factory/specs/feature-flow-studio-redesign.md`](../../.ai-factory/specs/feature-flow-studio-redesign.md).
> Decision: [ADR-092](../decisions.md#adr-092). The editor redesign (Phase B) and
> the editable-local-package backend (Phase C) are **(Designed)** here and ship as
> their own plans.

The redesign unifies the scattered catalog surfaces (the `/flows` landing, admin
`/settings` sources, board `?tab=packages`, and the
`/projects/{slug}/packages/{flowRefId}` viewer) into one **Studio** section walking
sources → packages → artifacts → authoring. Phase A surfaces the IA over the
existing backend — **no migration, no new HTTP/SSE route, no new `MaisterError`
code**: every read reuses `getAvailablePackageInstalls` /
`getProjectPackageAttachments` / `getFlowPackageDetail` and the existing
`PackageSourcesPanel` + static `FlowGraphView`, and a pure `groupPackages` shaper
turns the flow-flat install list into a package-grouped view.

### IA & status split

| Route | Surface | Phase | Status |
| --- | --- | --- | --- |
| `/studio` | Overview (at-a-glance + area cards + needs-attention) | A | Designed → Implemented on merge |
| `/studio/sources` | Sources (relocated `PackageSourcesPanel`, admin) | A | Designed → Implemented on merge |
| `/studio/packages` | Packages list grouped by package | A | Designed → Implemented on merge |
| `/studio/packages/{ref}` | Package detail (BoM · read-only preview · versions · attach · fork) | A | Designed → Implemented on merge |
| `/studio/edit/{...}` | Big-canvas artifact editor redesign | B | Designed |
| `/studio/local` | Local / virtual package | C | Designed |

The rail's **Flows** item becomes **Studio** (`/studio`); the `/flows` route stays
as a legacy unlinked page until parity. Studio is member-level for anyone with
`manageCatalog` on ≥1 project; **Sources** stays global-admin-gated.

### Config vs content split

*Project context* keeps package **configuration** (attach/detach/upgrade/trust/
enable/version-or-strategy) — it stays on the board `?tab=packages`. *Studio* owns
**content** (the designer + every artifact editor). They are joined by a project
filter in Studio and an "Open in Studio" deep-link from each attached package
(board → `/studio/packages/{ref}`). See [`packages.md`](packages.md) for the
install/attach/trust lifecycle and [`agents.md`](agents.md) for the agent kinds
Studio will eventually author (R7 — not restated here).

### Editable local package — the spine (Designed; Phase C)

A local-source install already produces an immutable `local-<digest>` revision
(ADR-088). The redesign adds the *editable* layer above it — **Variant B**: a
`local_packages` table whose row points at a mutable working directory; the
file/graph editors edit files in it, and **cut version** runs the existing
installer over the dir → a `local-<digest>` `package_installs` revision that
projects attach. The "virtual package" is the default local package for loose
artifacts; **move-to-package** relocates artifacts between local packages.
Standalone artifact kinds (`agent`/`mcp`, beyond today's `rule|skill|flow`) become
files in the working dir. This whole layer is **(Designed)** — built in Phase C;
git write-back to an upstream source is **(Phase 2)**.

### Node visual language (Designed; Phase B)

Phase A's package-detail preview reuses the **current** `FlowGraphView` rendering.
The Heym-style node-visual scheme (colored icon chips per node/gate type,
named-outcome handles, dashed amber rework edges) is **(Designed)** and lands in
Phase B on the shared node renderer — canonical scheme in
[`../screens/studio/README.md`](../screens/studio/README.md) §"Node visual
language".

## Linked artifacts

- **Studio redesign (Phase A — Designed→Implemented on merge):**
  [`../screens/studio/README.md`](../screens/studio/README.md) (surface SSOT),
  [`../../.ai-factory/specs/feature-flow-studio-redesign.md`](../../.ai-factory/specs/feature-flow-studio-redesign.md) (SDD spec),
  [ADR-092](../decisions.md#adr-092) (unified-Studio IA + editable-local-package direction).
- **SDD (FROZEN SSOT):** [`.ai-factory/specs/feature-m27-flow-studio-stage-1.md`](../../.ai-factory/specs/feature-m27-flow-studio-stage-1.md)
- **SDD Phase 2 (FROZEN SSOT, Implemented):** [`.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md`](../../.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md) — viewer/fork/artifact-editor contracts.
- **ADRs (Accepted):**
  ADR-067 (flow editor write path — authored drafts + hard-gate),
  ADR-068 (authored→executable bridge + two-axis trust gate),
  ADR-069 (version_binding + resolve-at-launch + resolved-set snapshot),
  ADR-070 (MCP + capability management model),
  [ADR-075](../decisions.md#adr-075) (Phase 2 viewer, fork, kind-by-path, content-validation severity) —
  all accepted in [`../decisions.md`](../decisions.md).
- **OpenAPI route (Implemented, Phase 2):**
  `POST /api/projects/{slug}/flow-packages/{flowRefId}/revisions/{revisionId}/fork` —
  see [`../api/web.openapi.yaml`](../api/web.openapi.yaml). The viewer page
  (`/projects/{slug}/packages/{flowRefId}` + `?rev=`/`?file=`) is page params, NOT
  OpenAPI (ADR-066 RSC-reads precedent) — see [`flow-packages.md`](flow-packages.md).
- **ADR-065 (Implemented):** [`../decisions.md#adr-065`](../decisions.md#adr-065-platform-acp-runner-crud-in-settings--hard-delete-blocked-by-any-usage-reference) — admin CRUD pattern mirrored for `platform_mcp_servers`.
- **ADR-064 (Implemented):** authored layout in `flow.yaml` `presentation` section — consumed by the editor, described in [`workbench.md`](workbench.md).
- **ADR-061 (Implemented):** [`../decisions.md#adr-061`](../decisions.md#adr-061-local-authored-capability-catalog-lifecycle) — local authored capability catalog lifecycle (reused M25 draft/CAS).
- **ERDs:**
  [`../db/capabilities-domain.md`](../db/capabilities-domain.md),
  [`../db/projects-domain.md`](../db/projects-domain.md),
  [`../db/runs-domain.md`](../db/runs-domain.md).
- **Web tier source (Implemented):**
  `web/lib/flows.ts` (`installAuthoredFlowPackageBridge`, `runRevisionSetup`), `web/lib/flows/lifecycle.ts` (`resolveEffectiveFlowRevision`),
  `web/lib/catalog/authored-service.ts` (`updateAuthoredDraft`, CAS logic),
  `web/lib/capabilities/resolver.ts` (winner-picking precedence),
  `web/lib/capabilities/materialize.ts` (MCP materialization, reused M14),
  `web/lib/services/runs.ts` (`launchRun` insertion points).
- **OpenAPI routes (Implemented):**
  `PATCH /api/projects/{slug}/catalog/caps/{capId}/draft`,
  `POST /api/projects/{slug}/catalog/caps/{capId}/publish-local`,
  `PATCH /api/projects/{slug}/flows/{flowId}/version-binding`,
  `POST /api/projects/{slug}/flows/{flowId}/trust-executable`,
  `GET|POST /api/admin/mcp-servers`,
  `PATCH|DELETE /api/admin/mcp-servers/{id}` —
  see [`../api/web.openapi.yaml`](../api/web.openapi.yaml).
- **Error taxonomy:** [`../error-taxonomy.md`](../error-taxonomy.md) (`CONFIG`, `CONFLICT`, `EXECUTOR_UNAVAILABLE`).
- **Related domains:**
  [`flow-graph.md`](flow-graph.md) (execution model, node-attempts ledger),
  [`workbench.md`](workbench.md) (read-only graph view the editor extends),
  [`flow-packages.md`](flow-packages.md) (git-sourced install lifecycle, trust/setup precedent),
  [`acp-runners.md`](acp-runners.md) (admin CRUD pattern mirrored for MCP servers),
  [`runs.md`](runs.md) (run state machine, launch preconditions).
