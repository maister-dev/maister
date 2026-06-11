# SDD Spec (FROZEN) — Flow Studio Phase 2 (part 1): package viewing/reachability + artifact-aware editing

> **Status:** Phase-0 spec freeze. This is the **single source of truth** for the
> implementation. Every later deviation requires a spec amendment, never an
> ad-hoc code change. Plan:
> [`.ai-factory/plans/feature-flow-studio-phase2-viewing-editing.md`](../plans/feature-flow-studio-phase2-viewing-editing.md).
> All described pieces are **(Implemented)** — the code shipped across Phases 1-5
> (typecheck/unit/integration/e2e green); the contracts here matched the
> implementation. (At Phase-0 HEAD they were (Designed); flipped on completion.)
>
> Conventions inherited (non-negotiable): `MaisterError` taxonomy (no plain
> `Error` for domain failures, UI branches on `code`), atomic writes to
> `.maister/`, EN+RU key parity (auto-tested), HeroUI v3 + React Flow + CodeMirror
> (NO new deps), strict TS (no `any` without `// FIXME(any):`), verbose +
> configurable pino logging, client editor code imports `@/lib/errors-core` (NOT
> server-only `@/lib/errors`). **No migration, no engine bump, no new
> `runs.status`, no new `MaisterError` code.**
>
> Branch: `feature/flow-studio-phase2-viewing-editing` (worktree
> `hungry-hellman-338765`). Baseline: `main @ 0fc95697`.
>
> **Grounding:** all current-state anchors in §2/§3 were verified against code on
> 2026-06-10 (drift folded in: Drizzle columns are camelCase `execTrust` /
> `installedPath` / `enabledRevisionId`; the authored validation issue-code union
> is `yaml_parse | schema | graph | unsafe_path | duplicate_path | path_conflict |
> unsupported_kind | binary_content`; `classifyPackageFile` emits
> `readme | setup | schema | skill | rule | agent_definition | script | template |
> asset`; `createAuthoredCapabilitySchema` carries `sourceFlowRefId` in the service
> TS type but NOT yet in the zod schema — §5.2 closes that).
>
> **Amendment log:**
> - (none yet)

---

## 1. Purpose & scope

Two coupled tracks that finish what M27 Flow Studio Stage 1 started (Stage 1
shipped the authored-flow editor write path; this part makes installed packages
browsable/forkable and gives package artifacts real editors).

**Track 0 — view + reach + fork an installed package.** Make an INSTALLED
(git-pinned, immutable) flow package's content visible from the project UI:
read-only graph (compiled from the DB `manifest`) + raw `flow.yaml` text + every
bundled artifact file (read from disk). Kill the "decoy" cards (non-navigating
`<div className="cursor-pointer">`). Add **"Fork to edit"** — installed revisions
are immutable, so editing always forks to an M25 authored `flow` draft carrying
`source_flow_ref_id` lineage, landing in the existing editor.

**Track 1 — artifact-aware editing.** Replace the flat generic-CodeMirror
package-file list with a derived **file tree** + per-kind artifact editors
(skill/rule/agent frontmatter forms; shell editor + heuristic lint; `form_schema`
builder with a live rendered preview). Wire per-kind **content validation** into
the existing authored draft-save hard-gate. Swap the `flow.yaml` `<textarea>` for
CodeMirror with **live YAML→graph re-seed**, and add a **typed-edge
modal-on-connect**. Complete the presentation round-trip (persist canvas spawn
position on add; carry width/height/color through to views).

### Out of scope (separate plans/epics — do NOT implement)
Rendered markdown/mermaid artifact PREVIEW (viewer-plugins track); the AI
flow-authoring assistant; the governance/publication pipeline (draft→pending→
approved, PR-to-catalog, approver RBAC, E3 sync); editing installed package files
**in place** (installed revisions stay immutable — edit = fork); per-agent
frontmatter variants; shellcheck host binary; canvas resize-handles / colour
palette; M27 Stage-1 leftover tasks (D1 docs-flip + D2 `/aif-verify`).

---

## 2. Reuse map (build on, do NOT rebuild)

| Capability | Reused symbol (verified 2026-06-10) | This-feature change |
|---|---|---|
| Read a package dir → validated body | `web/lib/flows/package-authoring.ts` `readAuthoredFlowPackageDirectory(sourceDir): Promise<AuthoredFlowPackageBody>` (`:222`); `classifyPackageFile(relPath)` (`:383-396`) | fork reads via this; viewer uses a NEW thin disk reader (§5.3, adds size cap + traversal/symlink guard that this function lacks) |
| Authored draft create (seed fork) | `web/lib/catalog/authored-service.ts` `createAuthoredCapability(args)` (`:152-282`); input type already has `sourceFlowRefId` (`authored-types.ts:116`) | called by the fork service in ONE tx; `sourceFlowRefId` set from `flow.flowRefId` |
| Authored draft save + hard-gate | `updateAuthoredDraft` (`:314-459`): `assertAuthoredFlowManifestValid` (yaml→`validateGraphManifest`→`compileManifest`) BEFORE the `draft_version` CAS (`:364-366`) | content-validation BLOCK set added alongside the manifest gate, BEFORE the CAS, on BOTH save paths |
| Authored input zod | `web/lib/catalog/authored-schema.ts` `createAuthoredCapabilitySchema` (`:7-19`, slug `^[a-z0-9][a-z0-9._-]*$`) | UNCHANGED — fork calls `createAuthoredCapability` (service) directly, bypassing this zod; its only consumer is `POST /caps`, which stays un-widened (§5.2) |
| Validation issue codes | `web/lib/catalog/authored-types.ts` `AuthoredFlowPackageValidationIssueCode` (`:34-42`) | EXTEND the union with the new content codes (§6.1) |
| Safe client-rel-path read | `web/lib/worktree.ts` `repoRelPathSchema` (`:85-92`, no NUL/abs/`..`/leading-`-`); confinement in `app/api/runs/[runId]/artifacts/[artifactId]/payload/route.ts` (`:93-138`, lexical `path.resolve` prefix + `realpath` symlink check) | `?file=` reader mirrors this EXACTLY (§5.3) |
| Read-only graph view | `web/components/board/flow-graph-view.tsx` `FlowGraphViewProps` (`:51-59`): `{runId, topology, layout, initialStatuses, currentStepId, runStatus, labels}`; `useRunStream` + `/api/runs/{id}/graph-status` | gains optional `runContext?` → static mode (no SSE/status), run callers unchanged (§4.4) |
| Compile + topology (server) | `web/lib/flows/graph/compile.ts` `compileManifest` (`server-only` `:1`, `@/lib/errors` `:7`); `web/lib/queries/flow-graph-view.ts` `buildGraphTopology` (`server-only` `:1`, `:148`); `presentationLayout` (`presentation-layout.ts:14-24`, projects x/y ONLY); `toFlowGraphView` (`flow-graph-view-layout.ts:92-144`, dagre + overrides) | make client-safe (errors-core swap, drop `server-only`, extract topology) for live preview (§4.5); `presentationLayout`/`toFlowGraphView` carry+apply w/h/color (§4.6) |
| Package list query | `web/lib/queries/flow-packages.ts` `getFlowPackages(projectId)` (`:96+`, artifacts from `contract.artifacts[]`; NO detail query) | add `getFlowPackageDetail(slug, flowRefId)` (§5.4) |
| Editor tabs + save form | `web/components/flows/flow-editor-tabs.tsx` tabs `graph\|yaml\|diff` (`:30`), `<textarea data-testid="flow-yaml-textarea">` (`:114`), `<form action={updateAuthoredFlowAction}>` hidden `flowYaml`/`expectedDraftVersion`/`packageFilesJson` | textarea → CodeMirror; tabs become single manifest-state owner (§4.5); save contract identical |
| Graph editor canvas | `web/components/flows/flow-graph-editor.tsx` `handleConnect` hardcodes `outcome="success"` (`:376-391`); drag-end → `moveNode` (`:393-408`); state seeded ONCE from `initialManifest` (`:304`); `addNode` (`:333-344`) | typed-edge modal on connect (§4.7); `addNode` persists spawn x/y (§4.6); reseed on yaml change (§4.5) |
| Package files editor | `web/components/flows/package-files-editor.tsx` flat `{kind,path,content}` list (`:44-50`), manual kind `<select>` (`:60-76`), rename via path input (`:83-94`) | derived tree + path-edit popup + inferred-kind badge (select removed) + per-kind editors (§7) |
| CodeMirror substrate | `web/components/flows/code-editor.tsx` (`:31`) + `code-editor-inner.tsx` (`:101-136`): langs yaml/json/markdown/shell, `@codemirror/lint` + `authoredFlowLinter`, `readOnly` prop, autocomplete only `kind="flow"`; `CodeEditorKind = flow\|schema\|skill\|rule\|readme\|agent_definition\|script\|setup\|asset\|template` | reused as-is for viewer + artifact bodies; flow lint now active on the editable manifest |
| Live form preview | `web/components/board/hitl-decision-controls.tsx` `HitlDecisionControls` pure-presentational (`:47-93`) + `formFieldsFromSchema`; `run-hitl-response.tsx` is the run-coupled wrapper | the `form_schema` builder preview renders `HitlDecisionControls` with no-op callbacks (§7.4) |
| Form-schema grammar | `web/lib/config.schema.ts` `formSchemaSchema` (`:827-830`): `{schemaVersion, fields[{name,label?,type:string\|number\|boolean\|enum\|array\|object,required?,default?,options?,fields?}]}`; `web/lib/flows/output-schema.ts` `validateStructuredOutput` (same grammar, ADR-063) | the builder edits this grammar for `schemas/*` and `output.result` schemas |
| Catalog error mapping | `web/lib/catalog/route-errors.ts` `catalogErrorResponse` / `httpStatusForCatalogError` (`:17-53`): `CONFIG→422`, `PRECONDITION`/`CONFLICT→409`, `UNAUTHENTICATED→401`, `UNAUTHORIZED→403` | fork route maps through it; no new codes |
| Authz | `web/lib/authz.ts` `requireProjectAction` (`PROJECT_ACTION_MIN`, `:46-60`): `readBoard`(viewer), `readRepoFiles`(member), `manageCatalog`(admin), `managePackages`(admin) | viewer = `readRepoFiles`; fork = `manageCatalog` |
| Panels | `web/components/board/panels/flows-panel.tsx` (`FlowsPanel({flows})` — NO slug; decoy `<div>` cards); `flow-packages-panel.tsx` (`{packages, slug, isAdmin}`) | decoys → `<Link>`; thread `projectSlug` into `FlowsPanel` (§7.5) |

**Reused symbols are (Implemented).** This feature only wires/extends them.

---

## 3. Domain entities (deltas)

### 3.1 DB schema — **NO DDL. NO MIGRATION. NO `db:generate`.**

This feature adds **zero** tables, columns, indexes, or constraints. Latest
migration stays `0037_m27_runs_resolved_capability_set`. Every column it relies
on already exists (verified 2026-06-10). The honest "DB artifact" is therefore a
**read/write surface map over existing columns**, not DDL:

| Table | Column (Drizzle name) | This feature's use |
|---|---|---|
| `flows` | `flowRefId` text | viewer URL segment + fork lineage target; unique per project via `(projectId, flowRefId)` |
| `flows` | `enabledRevisionId` text NULL | default revision selected by the viewer |
| `flows` | `versionBinding` text (`pinned\|latest`) | DISPLAYED in viewer header (read-only) |
| `flows` | `trustStatus` text | DISPLAYED in viewer header (read-only) |
| `flow_revisions` | `installedPath` text | **disk root** for raw `flow.yaml` + artifact files (server-side read only; NEVER projected to client) |
| `flow_revisions` | `manifest` jsonb | compiled → static graph topology (digest-pinned; survives disk loss) |
| `flow_revisions` | `manifestDigest` text | revision identity in header |
| `flow_revisions` | `resolvedRevision` text (40-hex SHA) | resolved-SHA label in header |
| `flow_revisions` | `execTrust` text (`untrusted\|trusted`) | DISPLAYED as the script-editor trust banner (read-only; never flipped here) |
| `flow_revisions` | `setupStatus`, `engineMin`/`engineMax`, `versionLabel` | header metadata |
| `authored_capabilities` | `sourceFlowRefId` text NULL (migration `0033`) | **written** by the fork (= source `flow.flowRefId`); read by `authored-bridge.ts:114` on later publish |

**Invariant:** the absolute `installedPath` (`~/.maister/flows/<flowRefId>@<sha12>/`,
built by `flow-paths.ts:systemCachePath`) is a server-only handle. It MUST NOT
appear in any client-visible DTO, RSC-serialized prop, log line streamed to the
browser, or error message (skill-context: "never serialize a server-only handle").

### 3.2 Config-schema deltas (`web/lib/`)

No change to `flow.yaml` DSL, `maister.yaml`, or the engine. Two NEW client-safe
schema modules (zod), neither persisted to DB — both operate on file `content`
strings inside the authored `files[]` array:

1. **Artifact frontmatter** — `web/lib/flows/artifact-frontmatter.ts` (NEW;
   client-importable; uses the already-present `yaml` pkg — NO `gray-matter`
   dep). Pure split/serialize + three zod schemas:
   - `splitFrontmatter(content) → { frontmatter?: unknown, body: string, raw: string }` and `serializeFrontmatter({frontmatter, body}) → string`. Unknown keys preserved verbatim on round-trip (byte-stable for untouched fields).
   - `skillFrontmatterSchema` — `name` (req), `description` (req); optional passthrough `argument-hint`, `allowed-tools`, `disable-model-invocation`, `model`, … (unknown keys preserved).
   - `agentFrontmatterSchema` — `name` (req), `description` (req); optional `tools`, `model`, `permissionMode`, `maxTurns` (unknown keys preserved).
   - `ruleGuardrailSchema` — ALL optional: `allowed_paths[]`, `forbidden_paths[]`, `allowed_commands[]`, `require_structured_response`.
2. **Per-kind content validation** — `web/lib/flows/artifact-validate.ts` (NEW;
   client-safe). Produces `ArtifactContentIssue[]` (`{severity:"block"|"warn", code, path, message}`); the BLOCK subset feeds the server hard-gate, the full set feeds inline editor UX. Issue codes in §6.1.

### 3.3 The file model — tree over `files[]`, kind-by-path

The persisted shape stays `files: { path: string; content: string }[]` (kind is
derivable, never stored). The tree is a **derived client view** grouped by path
segments. **Kind is strictly inferred from path** via `classifyPackageFile` — the
manual kind `<select>` is removed (it diverges from install/bridge, which classify
by path only). Add = a new path (current-folder prefilled). Rename and move are
ONE operation = editing the full path (validated against `unsafe_path` /
`duplicate_path` / `path_conflict`; kind re-inferred). No drag-and-drop.

---

## 4. State machines & process flows

### 4.1 Installed-package view (read path)
```
member opens /projects/[slug]/packages/[flowRefId]
  → requireProjectAction(projectId, "readRepoFiles")     (member; precedes every read)
  → load flows row by (projectId, flowRefId) → 404 if none
  → pick revision: ?rev=<id> (validated via project-scoped join) else flows.enabledRevisionId
  → graph:  compileManifest(revision.manifest) → buildGraphTopology + presentationLayout
              → <FlowGraphView/> WITHOUT runContext         (static mode)
              (compile throws → yaml-only fallback + notice; never 500s the page)
  → flow.yaml text + artifact files: read from revision.installedPath on disk
              (degraded "bundle not available on disk" state if the dir is gone)
  → ?file=<relPath>: confined read → text | binary | too-large | not-found | bundle-missing
```

### 4.2 Fork-to-edit (write path — the only mutation)
```
manager clicks "Fork to edit"  (manageCatalog)
  → POST /api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork
  → resolve flows row (projectId, flowRefId) + revision row (revisionId ∈ that flow) → 404 on mismatch
  → readAuthoredFlowPackageDirectory(revision.installedPath)   (reads only; missing/unreadable → 422 CONFIG)
  → slug = body.slug ?? flowRefId;  probe (project_id,kind='flow',slug) collisions → slug, slug-fork, slug-fork-2…
       (an EXPLICIT body.slug that collides → 409 CONFLICT, no probe)
  → createAuthoredCapability({ kind:"flow", slug, title, body, manifest, sourceFlowRefId: flow.flowRefId })   [ONE tx]
  → 201 { capId, projectSlug, slug }   → client navigates to /flows/{projectSlug}/{capId}
```
All reads precede the single DB write. No side-effect-after-response, no
idempotency marker (a retry creates a second probed-slug fork — acceptable). The
fork reads `setup.sh` / scripts as draft TEXT and NEVER executes anything.

### 4.3 Trust axes (DISPLAY-ONLY here)
This feature introduces NO execution of package content and flips NO trust. It
DISPLAYS `flow_revisions.execTrust` as a script-editor banner with honest copy
("scripts never run until explicit executable trust"). The `runRevisionSetup`
gate (M27) is untouched.

### 4.4 Read-only graph: run-coupled → optional
`FlowGraphView` gains optional `runContext?: { runId; initialStatuses;
currentStepId; runStatus }`. **Present** → existing run behavior (SSE
`useRunStream`, `/graph-status` fetch, status chips, current-node ring).
**Absent** → static mode: pure topology + presentation layout, no subscription,
no fetch, no chips. Existing run call sites pass `runContext` and are otherwise
unchanged.

### 4.5 YAML ↔ canvas single-owner sync (fixes audit hole "a")
```
FlowEditorTabs = single owner of manifest state.
  yaml text edited → debounce ~400ms → yaml.parse + flowYamlV1Schema + client-safe compile/topology
       OK    → reseed FlowGraphEditor (controlled reseed / keyed remount, preserve selection where possible)
       ERROR → keep last-good graph + inline error banner (reuse flowYamlDiagnostics output)
  canvas onChange → serialize manifest → yaml text   (existing path)
Both directions flow through ONE state. Pure sync reducer is unit-tested
(yaml→manifest→yaml stability; error-keeps-last-good). Interactive behavior is e2e.
```
Prerequisite: `compileManifest` + topology builder become client-safe — swap
`@/lib/errors`→`@/lib/errors-core` in `compile.ts`, drop its `server-only`
guard (its `@/lib/db/schema` import is type-only, erased at build), extract the
topology builder into `web/lib/flows/graph/topology.ts`. Server callers re-export
unchanged. **Unit tests cannot catch a `server-only` leak** — the Phase-3 exit
runs the `m27-flow-editor` e2e to smoke the client bundle.

### 4.6 Presentation round-trip completion (fixes audit holes "b","c")
- **(b)** `addNode` writes the canvas spawn `{x,y}` into `presentation` at add time (compose `moveNode` at add) — position survives reload.
- **(c)** `presentationLayout` / `FlowLayout` carry `width/height/color`; `toFlowGraphView` applies size + colour; the node side-form gains three optional inputs (width/height/colour) writing via `moveNode`'s existing merge. NO canvas resize-handles / colour palette.
- (d) drag→serialize and (e) editor↔view projection parity already WORK — left intact; a serialize→parse→project round-trip unit proves drag + size/colour survive save→reload→read-only view.

### 4.7 Typed-edge modal-on-connect (D7 — one source of truth)
`handleConnect` opens a modal collecting the outcome (default `success`;
suggestions `success|failure|rework|takeover` + free text). Confirm →
`setTransition(manifest, source, outcome, target)` → `applyManifest` — the SAME
action the side-form uses (no second edge store). If the outcome already exists
for the source, the modal warns it will retarget. Cancel → no edge. House a11y
(focus-trap, initial focus, focus-restore, Escape, scroll-lock, `aria-labelledby`).

---

## 5. HTTP / route surface (identifiers labeled; bodies; status codes)

Labels: **U** = url-param → server-state; **A** = auth-context; **B** =
body-controlled; **S** = server-state; **Q** = query-param.

### 5.1 The ONLY new API route — fork
| Route | Method | Ids | Body | Success | Errors |
|---|---|---|---|---|---|
| `/api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork` | POST | slug(U), flowRefId(U), revisionId(U, asserted ∈ flow ∈ project) | `{ slug?, title? }` (B — names the NEW authored cap ONLY; NO filesystem/cross-resource locator) | 201 `{ capId, projectSlug, slug }` | 401/403 (authz), 404 (unknown/foreign flow or revision), 409 CONFLICT (explicit colliding slug), 422 CONFIG (missing/unreadable bundle dir) |

- Authz: `manageCatalog` (admin). `installedPath` is read from the resolved DB row — never from the body.
- Mapped exclusively through `catalogErrorResponse`. No new `MaisterError` code.
- Response is an explicit DTO — no DB row, no `installedPath`, no `manifest` blob.

### 5.2 `createAuthoredCapabilitySchema` — UNCHANGED (fork bypasses the zod)
The fork service calls `createAuthoredCapability({ input, … })` with the TS
`CreateAuthoredCapabilityInput` directly; the service does NOT re-parse via
`createAuthoredCapabilitySchema` (whose sole consumer is the public `POST /caps`
route, `route.ts:41`). So the server-seeded `sourceFlowRefId` flows through
unconditionally and the public create body stays un-widened (§3.1 — fork is the
only setter; a create body must not carry a cross-resource lineage locator). **No
zod change.** Net-new authored flows (no fork) omit `sourceFlowRefId` → fresh
`flow_ref_id` minted at publish, unchanged. (Verified 2026-06-11: the plan's
original "add it to the zod" premise was falsified — the service is TS-typed, not
zod-parsed, so adding the field would only widen `POST /caps`.)

### 5.3 Disk readers (server-only; NO new API routes — ADR-066 precedent)
The viewer is an RSC that reads disk directly; no `GET …/content` route is added
(the run/project `files/content` routes were deliberately retired for RSC reads).
NEW `web/lib/flows/package-content.ts`:
- `listInstalledPackageFiles(revision) → { files: {path,kind,size}[], flowYaml: string | null }` — walk `installedPath`, skip non-regular files (no symlinks), classify via `classifyPackageFile`, exclude `flow.yaml` from `files` (returned separately). `{ bundleMissing: true }` shape when the dir is gone.
- `readInstalledPackageFile(revision, relPath) → { state: "text"|"binary"|"too-large"|"not-found"|"bundle-missing", content?, kind? }` — **`repoRelPathSchema`-shaped zod rel-path** (no NUL/abs/`..`/leading `-`) BEFORE any fs call → lexical `path.resolve` prefix check under `installedPath` → `realpath` symlink-escape check → size cap **1 MiB** → NUL/UTF-8 binary detection.
- Logging: pino WARN on confinement reject (`{path, code}`) + on bundle-missing; DEBUG on list counts. NO browser-streamed log carries `installedPath`.

### 5.4 Query
NEW `getFlowPackageDetail(slug, flowRefId)` in `web/lib/queries/flow-packages.ts`
— resolves the project, the `flows` row, and its revisions (enabled + selectable
list) into a client-safe DTO (header metadata + revision list; NO `installedPath`).

### 5.5 Viewer page + query params (page params — NOT OpenAPI)
NEW RSC `web/app/(app)/projects/[slug]/packages/[flowRefId]/page.tsx`:
- `slug`(U), `flowRefId`(U) — access-controlled via `requireProjectAction`.
- `?rev=<revisionId>`(Q) — validated as id then resolved via project-scoped join (`flow_revisions.flow_ref_id = flows.flow_ref_id AND project`); a revision from another flow/project → not-found. Default = `enabledRevisionId`.
- `?file=<relPath>`(Q) — **untrusted** → confined read per §5.3.
- Documented in `docs/system-analytics/flow-packages.md` + `flow-studio.md`, NOT OpenAPI (page query params, ADR-066 precedent).

---

## 6. Allow-lists & gates (write code EXACTLY as stated)

### 6.1 Per-kind content validation — severity table (the gating contract)
One shared module (`artifact-validate.ts`) emits `{severity, code, path, message}`.
The **BLOCK** subset is wired server-side into the draft-save hard-gate (alongside
`assertAuthoredFlowManifestValid`, BEFORE the `draft_version` CAS → `MaisterError("CONFIG")` → 422 with the issue list in `details`), and mirrored client-side for inline UX. The **WARN** subset is advisory UI only and NEVER blocks.

Issue-code union EXTENDS `AuthoredFlowPackageValidationIssueCode`
(`yaml_parse | schema | graph | unsafe_path | duplicate_path | path_conflict |
unsupported_kind | binary_content`) with:

| Severity | NEW code | Fires when | Why blocking / advisory |
|---|---|---|---|
| **BLOCK** | `schema_json_invalid` | a `schemas/*.json` file fails `JSON.parse` | malformed schema = runtime-dead |
| **BLOCK** | `form_schema_invalid` | a schema file **referenced by the manifest** (any node `form_schema:` or `output.result.schema:` path) fails `formSchemaSchema` | the runtime consumes it; silent failure otherwise |
| **BLOCK** | `frontmatter_missing` | `skills/**/SKILL.md` or `agents/*.md` with missing/unparseable frontmatter | runtime consumes frontmatter verbatim → silent dead capability |
| **BLOCK** | `frontmatter_field_missing` | such a file missing `name` or `description` | same |
| **WARN** | `rule_guardrail_shape` | rule guardrail frontmatter shape (`allowed_paths`/`forbidden_paths`/`allowed_commands`/`require_structured_response`) malformed | NO web runtime parser exists → cannot block |
| **WARN** | `shell_lint` | a `shell-heuristic-lint` finding (§6.3) | heuristic, not authoritative |
| **WARN** | `form_schema_unreferenced` | `formSchemaSchema` grammar issue on a schema file NOT referenced by the manifest | not on a runtime path |
| **WARN** | `frontmatter_unknown_key` | unknown frontmatter key on skill/agent/rule | preserved verbatim, informational |

Gating rules (exact):
- The **existing** BLOCK set (paths/dup/conflict/kind/NUL/UTF-8 + the manifest hard-gate) is unchanged and still blocks.
- Manifest-reference resolution (`form_schema:` / `output.result.schema:` path collection) runs **only when the manifest parses** (an unparseable yaml persists RAW with `manifest=null` by design — M27 gotcha; file-level BLOCK checks still run).
- Server wiring MUST cover BOTH save paths: the `updateAuthoredFlowAction` server action (`app/(app)/flows/actions.ts`) AND `PATCH /caps/[capId]/draft` — each with its own test.
- **Fork compatibility:** an installed package whose pre-existing artifacts violate BLOCK rules still FORKS (validation collected, not thrown in `createAuthoredCapability`); the first SAVE surfaces the blocks. By design.

### 6.2 Kind-by-path (no manual override)
Kind is `classifyPackageFile(path)` everywhere: `README.md→readme`, `setup.sh→setup`,
`schemas/→schema`, `skills/→skill`, `rules/→rule`, `agents/→agent_definition`,
`scripts/→script`, `templates/→template`, else `asset`; `flow.yaml` is excluded
from `files`. The editor shows a **read-only inferred-kind badge**; no `<select>`.

### 6.3 Shell heuristic lint (pure JS — NO shellcheck binary)
Bounded WARN-only checks, rendered through the existing `@codemirror/lint`
pipeline: missing shebang; `rm -rf` on an unquoted variable; unquoted `$VAR` in
common traps; backticks (legacy command-substitution); missing `set -e` hint.
No host binary, no container wiring, no deployment touchpoint.

### 6.4 Path confinement (the security gate)
Every `?file=` / artifact disk read: `repoRelPathSchema`-shaped zod (sink-invariant
validation, not just `z.string()`) BEFORE any fs call → lexical `path.resolve`
prefix check under `installedPath` → `realpath` symlink-escape check → 1 MiB cap.
Auth (`readRepoFiles`) precedes every read.

### 6.5 Authz minimums
- Viewer page + all its disk reads: `readRepoFiles` (member).
- Fork route: `manageCatalog` (admin). Fork button hidden without it (convenience; the route is the boundary).
- Run-scoped graph view stays `readBoard` (viewer) — unchanged.

---

## 7. Component / UI contracts

| # | Surface | Contract |
|---|---|---|
| 7.1 | Viewer page (`projects/[slug]/packages/[flowRefId]`) | RSC; `readRepoFiles` first; header (ref, version label, resolved SHA, enablement, trustStatus, execTrust) from DTO; static graph (compile-fail → yaml-only + notice); raw `flow.yaml` in read-only `CodeEditor kind="flow"`; file list + `?file=` selected file in read-only kind-driven CodeMirror with binary/too-large/bundle-missing states; revision picker; Fork slot (hidden w/o `manageCatalog`). Breadcrumb back to `…?tab=packages` (observatory subpage precedent; no `projects/[slug]/layout.tsx`). |
| 7.2 | IA reachability | `flows-panel` + `flow-packages-panel` cards become `<Link href="/projects/{slug}/packages/{ref}">` (admin action buttons keep working — stop-propagation on the actions block); thread NEW `projectSlug` into `FlowsPanel`; `/flows` installed-card → viewer; project flows tab gets a `manageCatalog`-gated "New flow" → `/flows/new?project={slug}` (preselect project). |
| 7.3 | Fork UI | Fork button (`manageCatalog`): POST → pending → navigate `/flows/{projectSlug}/{capId}`; error toast branches on `code` (no string matching). EN+RU keys. |
| 7.4 | `form_schema` builder | Structured field editor over `formSchemaSchema` (add/remove/reorder; name/label/type/required/options; recursive `object` fields) ⇄ raw-JSON CodeMirror toggle (invalid JSON → builder disabled + banner); LIVE preview rendering `HitlDecisionControls` via `formFieldsFromSchema` with no-op callbacks. Serves `schemas/*` AND `output.result` schemas (same grammar). No full visual drag-builder. |
| 7.5 | File tree + path ops | Derived tree (folders from segments); add (folder-prefilled path); rename/move = ONE path-edit POPUP (admin-UI convention — edits in popups) validating `unsafe_path`/`duplicate_path`/`path_conflict`; inferred-kind badge (no `<select>`); delete kept; `packageFilesJson` hidden-input save contract unchanged. |
| 7.6 | Skill/Rule/Agent editors | SKILL.md / agent `.md` → frontmatter FORM (§3.2 schemas; unknown keys preserved) + markdown body CodeMirror; RULE.md → guardrail form (WARN-level display) + body. Form edits re-serialize into `files[].content` byte-stably for untouched fields. EN+RU (`flowEditor.artifacts.*`). |
| 7.7 | Script/setup editor | Shell CodeMirror + §6.3 heuristic lint as WARN diagnostics; exec/trust banner surfacing `execTrust` ("scripts never run until explicit executable trust"). |
| 7.8 | `flow.yaml` editor | `<textarea>` → `CodeEditor kind="flow"` (flow lint + autocomplete active; `readOnly` when disabled); hidden `flowYaml` input + form-action save contract identical; live YAML→graph re-seed (§4.5); typed-edge modal (§4.7). |

---

## 8. Expectations (normative, testable)

### 8.1 Viewing & reachability
1. A member opening an installed package from the flows/packages tab MUST see a read-only graph + raw `flow.yaml` + every artifact file read-only; NO decoy cards remain.
2. The read-only graph MUST render OUTSIDE any run, honouring `presentation` (dagre fallback), with NO SSE subscription and NO `/graph-status` fetch.
3. A missing-on-disk bundle MUST degrade gracefully: metadata + graph (from DB `manifest`) still render; the files section shows a typed "bundle not available on disk" state; the page MUST NOT throw/500.
4. A compile failure of the stored `manifest` MUST fall back to yaml-only with a notice, not a 500.
5. Every `?file=` read MUST be path-confined (zod sink-invariant + lexical prefix + `realpath`); `../`, absolute, NUL, leading-`-`, and symlink-escape inputs MUST be rejected before any fs read; files > 1 MiB → `too-large`.
6. No client-visible DTO, prop, log, or error MUST contain `installedPath` or any absolute server path.

### 8.2 Fork
7. "Fork to edit" MUST create an authored `flow` draft seeded with `flow.yaml` + all files + `source_flow_ref_id = flow.flowRefId`, in ONE transaction, then land in the editor at `/flows/{projectSlug}/{capId}`.
8. Slug MUST default to `flowRefId` and probe `-fork`/`-fork-N` on `(project_id, kind, slug)` collision; an EXPLICIT colliding `body.slug` MUST return 409 CONFLICT (no probe).
9. A missing/unreadable bundle dir MUST return 422 CONFIG (nothing persisted); a foreign/unknown `revisionId` or `flowRefId` MUST return 404.
10. Fork MUST execute NOTHING (setup.sh/scripts copied as draft text); `execTrust` MUST NOT be flipped.
11. An installed package with pre-existing BLOCK-violating artifacts MUST still fork; the first SAVE surfaces the blocks.

### 8.3 Editing & validation
12. A draft save MUST run the per-kind BLOCK content validation alongside `assertAuthoredFlowManifestValid`, BEFORE the `draft_version` CAS; a BLOCK issue MUST throw `CONFIG` (422, issue list in details) and MUST NOT mutate the draft row. BOTH save paths (server action + `PATCH …/draft`) MUST gate.
13. `schemas/*.json` failing `JSON.parse`, a manifest-referenced schema failing `formSchemaSchema`, and a skill/agent md missing/unparseable frontmatter or missing `name`/`description` MUST BLOCK.
14. Rule-guardrail shape issues, shell-lint findings, unreferenced-schema grammar issues, and unknown frontmatter keys MUST be WARN-only (never block).
15. Manifest-reference resolution MUST run only when the manifest parses; file-level BLOCK checks MUST run regardless of manifest parseability.
16. Artifact kind MUST be inferred from path (`classifyPackageFile`); no manual kind selection exists. Frontmatter round-trip MUST be byte-stable for untouched fields and preserve unknown keys.

### 8.4 Graph editing & presentation
17. Editing `flow.yaml` text MUST re-seed the canvas (debounced) without reload; a parse/validate error MUST keep the last-good graph + show an inline banner (no canvas wipe). Canvas edits MUST serialize back to yaml through the single owner.
18. `handleConnect` MUST open the typed-edge modal and write through `setTransition` (the side-form's action); a duplicate outcome for the source MUST warn-retarget; Cancel MUST add no edge.
19. `addNode` MUST persist the canvas spawn `{x,y}` into `presentation`; `width/height/color` MUST round-trip save→reload and be applied in BOTH the editor canvas and the read-only view.
20. The editor MUST be read-write only for `manageCatalog`; the run-scoped view stays `readBoard`. No engine bump, no new `runs.status`, presentation stays additive/runner-ignored.

---

## 9. Edge cases → MaisterError (no new codes)

| Case | Code | HTTP |
|---|---|---|
| Fork: missing/unreadable bundle dir | `CONFIG` | 422 |
| Fork: explicit colliding slug | `CONFLICT` | 409 |
| Fork: foreign/unknown flowRefId or revisionId | (not-found) | 404 |
| Fork/viewer: insufficient role | `UNAUTHORIZED` | 403 |
| Draft save: BLOCK content issue (frontmatter/JSON/form_schema) | `CONFIG` | 422 (not persisted) |
| Draft save: invalid manifest (existing hard-gate) | `CONFIG` | 422 (not persisted) |
| Draft save: stale `expectedDraftVersion` (existing CAS) | `CONFLICT` | 409 |
| `?file=` traversal/symlink/NUL/abs/leading-`-` | rejected pre-fs | not-found state (no throw to client) |

---

## 10. Analytics / observability (concise expectations)

This feature adds NO new metric table, NO Observatory signal, NO SSE event. The
analytics surface is the **structured pino logging boundary** + the two
system-analytics narrative docs. Expectations:

| Event | Level | Fields | Expectation |
|---|---|---|---|
| fork created | INFO | `{capId, flowRefId, revisionId, slug, projectId}` | exactly one per successful fork; NO `installedPath` |
| bundle missing on disk (viewer or fork) | WARN | `{flowRefId, revisionId, reason:"bundle-missing"}` | emitted on degraded viewer render and on fork 422 |
| path-confinement reject | WARN | `{code, relPathLength}` (NEVER the raw path or `installedPath`) | one per rejected `?file=` |
| content validation issue counts | DEBUG | `{path, block, warn}` | per save; aggregate counts only |
| package files listed | DEBUG | `{flowRefId, fileCount}` | per viewer render |

- Client components surface state via UI only; NO `console.*` (repo `no-console` lint).
- Honest visibility: the script editor's trust banner MUST state scripts do NOT run until an explicit executable-trust flip (this feature does not perform it).
- Acceptance trace (§12) records test/file evidence per acceptance criterion — the project's "analytics with concise expectations" bar for a non-metric feature.

---

## 11. Spec-to-test matrix (acceptance → named test, project · file)

Runnability: unit files match `lib/**/__tests__/**/*.test.ts` /
`components/**/*.test.ts` / `app/**/__tests__/**/*.test.ts` (no jsdom,
`renderToStaticMarkup`); integration match `**/*.integration.test.ts`
(testcontainers, 60s); e2e under `web/e2e/`. Prove each new file with
`vitest list --project <unit|integration>` per phase (skill-context: no dead
tests).

| # (Expectation) | Acceptance | Test (project · file) |
|---|---|---|
| 8.1.5 / 6.4 | `?file=` traversal/symlink/NUL/abs/size-cap rejected; no abs path leak | unit · `lib/flows/__tests__/package-content.test.ts` |
| 8.1.1-4 | viewer renders graph+yaml+files; degraded bundle; compile-fail fallback | unit · `app/(app)/projects/[slug]/packages/__tests__/viewer.test.ts` (renderToStaticMarkup) |
| 8.1.2 / 4.4 | static graph: no runContext → no SSE/status | unit · `components/board/__tests__/flow-graph-view.test.ts` (static-mode case) |
| 8.2.7-11 | fork: lineage + slug-probe + 422 missing dir + 404 foreign rev | int · `app/api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork/__tests__/fork.integration.test.ts` |
| 8.2.8 | slug-probe helper | unit · `lib/catalog/__tests__/seed-from-revision.test.ts` |
| 8.3.12-15 | content-validation severity matrix; both save paths gate | unit · `lib/flows/__tests__/artifact-validate.test.ts`; int · `lib/catalog/__tests__/authored-content-gate.integration.test.ts` |
| 8.3.16 | frontmatter split/serialize round-trip byte-stability | unit · `lib/flows/__tests__/artifact-frontmatter.test.ts` |
| 8.4.19 / 4.6 | presentation w/h/color projected + applied; addNode persists x/y; round-trip | unit · `lib/flows/graph/__tests__/presentation-layout.test.ts`, `lib/board/__tests__/flow-graph-view-layout.test.ts`, `lib/flows/editor/__tests__/editor-state.test.ts` |
| 8.4.17 / 4.5 | yaml→manifest→yaml stability; error-keeps-last-good | unit · `components/flows/__tests__/flow-editor-sync.test.ts` |
| 8.4.18 / 4.7 | typed-edge modal markup + duplicate-detection helper | unit · `components/flows/__tests__/edge-connect-modal.test.ts` |
| 7.5 | tree markup, inferred-kind badge, no `<select>` | unit · `components/flows/__tests__/package-files-editor.test.ts` (migrated) |
| 7.4 | builder⇄JSON sync reducer; preview field extraction | unit · `components/flows/__tests__/form-schema-builder.test.ts` |
| nav-path | board → package → view → open file → fork → editor → save | e2e · `web/e2e/flow-package-viewer.spec.ts` (+ `seedInstalledPackageFixture`) |
| artifact-edit | frontmatter clear→Save 422→fix→Save; live yaml node add; typed edge | e2e · `web/e2e/flow-package-viewer.spec.ts` (or `flow-studio-artifacts.spec.ts`) |
| editor client-bundle | server-only leak smoke | e2e · `web/e2e/m27-flow-editor.spec.ts` (migrated `flow-yaml-textarea`→CodeMirror host) |
| i18n | EN/RU key parity for new namespaces | unit · `lib/__tests__/i18n-parity.test.ts` (kept green) |

Enumerated assertion migrations (in-phase, NOT follow-up): `presentation-layout.test.ts`
(w/h/color projected); `flow-graph-view-layout.test.ts` (size/colour applied);
`flow-graph-view.test.ts` (optional `runContext`); `editor-state.test.ts` (addNode
writes presentation + path-rename action); `package-files-editor.test.ts` (tree,
no `<select>`); `m27-flow-editor.spec.ts` (CodeMirror host testid). Grep
`components/board/__tests__` for panel tests before the IA task and migrate.

---

## 12. Acceptance criteria (mirror the plan; each traces to a task)

- Member opens an installed package from the project flows/packages tab and views `flow.yaml` (read-only graph + raw yaml) + every artifact file read-only; no decoy cards remain → T1.3, T2.1, T2.5.
- Read-only graph renders for an installed package OUTSIDE any run, honouring `presentation` (dagre fallback) → T1.2, T1.3, T2.5.
- Manager "Fork to edit" → authored draft seeded with `flow.yaml` + files + `source_flow_ref_id`, lands in editor → T2.2, T2.3, T2.5.
- Canvas drag persists x/y (+ size/colour where set) into `presentation`; round-trips save→reload and matches the read-only view → T2.4 (+T3.3 for the yaml-tab fork).
- Per-kind artifact editors (skill/rule/agent forms, shell lint, `form_schema` builder + live preview); invalid content blocks draft save with a typed error → T4.1–T4.6, T5.1.
- File tree with add/rename/move; `flow.yaml` via CodeMirror with live YAML→graph re-seed and modal-typed edges → T4.3, T3.2–T3.4.
- nav-path e2e clicking from project board → package → view → fork → edit → save → T2.5, T5.1.
- EN+RU labels; typed errors; migrations: none needed (verified) → T1.4, T5.2, all routes via `catalogErrorResponse`/typed codes.

---

## 13. Implementation status

All sections above: **(Implemented)** — shipped across Phases 1-5 on
`feature/flow-studio-phase2-viewing-editing` (viewer, fork, presentation,
flow.yaml CodeMirror + live YAML→graph re-seed + typed-edge modal, file tree +
per-kind artifact editors + content-validation gate). Reused symbols (§2) are
**(Implemented)** — this feature only wires/extends them. NO migration, NO engine
bump, NO new `runs.status` / `MaisterError` code (verified).

**Cross-cutting compliance ledger (project aif-plan skill-context):**
HTTP identifiers labeled (§5); two-phase/atomicity = single-tx fork, no
after-side call (§4.2); trust/execution separation = display-only, no exec (§4.3);
fan-out = no new status/enum (§3.1); config-state symmetry = N/A (no YAML→DB sync);
deployment touchpoints = none (§6.3); contract surfaces → spec files (this doc +
§5 OpenAPI fork row + system-analytics page params); test integrity = §11
(no dead tests, in-phase assertion migration).
