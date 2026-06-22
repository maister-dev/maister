# Implementation Plan: Flow Studio Package Authoring — Stream A (editor IA + first-class kinds)

Branch: feature/studio-package-authoring-editor
Created: 2026-06-22
Milestone target: **M39** (M38 = implemented-but-unmerged flow-routing; see `[[flow-routing-p7-g4-plan-state]]`)
Sibling: **Stream B** = `feature/studio-package-authoring-runtime` (version-adopt launch + PR-to-source). Split per owner ("в 2 потока").

## Settings
- Testing: **yes** (per-phase suite-green is hard acceptance).
- Logging: **standard / structured** — project enforces `no-console` + ZERO `console.*` in committed server code. Name-scoped route logger; non-swallowing error propagation.
- Docs: **yes** — docs-first Phase A0; mandatory docs checkpoint at completion.

## Roadmap Linkage
Milestone: **M39 — "Flow Studio package authoring"** (Stream A delivers the editor/kinds half).
Rationale: Finishes the in-app authoring surface M36 started — editor correctness + all four kinds first-class incl. claude-subagents.

---

## Scope (Stream A) — web-only, NO migration, ADR-105

Stream A is **web-only** (components + lib + classifier + docs). NO DB migration, NO new HTTP route that changes runs. **ADR-105** (first-class authored kinds incl. claude-subagent + package-manifest form). Above reserved 103/104 (flow-routing 103, G4 104); renumber pass budgeted.

### Context
~70% of the original request already shipped by **M36** (`[[m36-flow-package-viewer-state]]`, FF-merged `bf7c3183`): local_packages table, create/fork, edit-all-kinds, file CRUD, uploads, git diff/commit/discard, cut-version→attach, AI assistant, `/studio/{local,edit}` routes, session lock. Stream A = the editor readiness bugs + the kinds delta.

---

## The locked model (read this first — it frames both streams)

After several rounds, the package model is **centralized + per-project version pins** (NOT project-owned editing):
- **Packages are instance-level (Studio-edited), centralized.** Editing happens in ONE place (Studio), serialized by the existing session lock. M36's platform-scoping (ADR-096/097) **stands** — we evaluated project-scoping and reverted it (project-owned editing fights reuse; the manageable AND reuse-friendly model is central editing + per-project version pins).
- **Projects consume *versions*, they don't fork edits.** A project attaches a package at a cut version (a pin). Editing the central package produces new cut versions; at launch a project adopts a newer version or keeps its pin (**Stream B**). → no cross-project conflict in the default flow, because projects pin versions rather than editing per-project.
- **Divergence is explicit and rare:** a project that genuinely needs a different package gets a **labeled copy** via "Customize for this project" (a fork). Separate item, edited independently, PR'd independently. The only place "which one" ever appears — a deliberate click, never an auto-merge.

Stream A owns the **central editing surface** (this is where versions are authored). Stream B owns attach + version-adopt + PR.

---

## Decisions (owner-approved)

### Subagents = distinct kind + editor
Frontmatter **lenient + open**: type ALL known Claude-Code fields (`name`, `description`, `tools`, `model`, `color`) AND **preserve unknown/custom keys as passthrough** (vs platform-agent strict `agentDefinitionFrontmatterSchema`, unknown→CONFIG). Files at `capability/<id>/agents/<stem>.md` → materialize into `.claude/agents/` at run. **New-Subagent template: `model: inherit`** (runner non-deterministic — never sonnet), **`tools` omitted** (inherits all).

### Commit-state button + commit-time validation gate
Lift a prominent top-bar "Commit state" + dirty indicator. **The commit path VALIDATES artifacts** (`validatePackageArtifacts`: flow.yaml parse+compile, manifest, platform-agent strict frontmatter, subagent lenient frontmatter) and **hard-blocks the commit on any invalid artifact** (`PRECONDITION`/`CONFIG`) with an error list → invalid artifacts can't become a version → un-launchable. ALL commit entry points (diff-drawer Commit, Commit-state) route through it. WIP lives in the uncommitted (lock-preserved) working dir.

### Shared `ChangeReviewDialog`
ONE popup (diff + editable commit message, prefilled) introduced here for Commit-state, **reused by Stream B** for the PR flow.

### "Customize for this project" = labeled copy (no schema)
Reuses the existing whole-package fork (`forkPackageToLocal`). The copy is just another instance-level local package with a name that reflects its origin (e.g. `P (for <project>)`) — **name convention, NO schema field** (keeps Stream A web-only). The project attaches the copy instead of P (Stream B). Fork dedup (A3) prevents accidental duplicate copies.

### Numbers / reuse
ADR-105 only; NO migration; reuse closed MaisterError union (`PRECONDITION | CONFLICT | CONFIG`, ADR-008). Subagent authoring stays file-based Variant B (NO `authored_capabilities` enum change). RBAC stays the M36 model (Studio-member `requireGlobalRole("member")` for authoring; project-member for attach).

### Route identifier trust labels (skill-context)
| Route | Identifier | Label | Handling |
| --- | --- | --- | --- |
| POST `/packages/[ref]/fork` | `ref` | url-param → install row | source from server-state (ref→install), not body |
| PUT `/local-packages/[id]/files/[...path]` | `id`,`path` | url-param → server row + confined path | `resolveWithinWorkingDir`, lock-asserted |

---

## Deployment touchpoints
None new. No env var, no compose change, no migration (editor/kinds are file-based in the existing local-packages working dir).

## Contract surface → spec file
| Surface | Spec file |
| --- | --- |
| Fork dedup response (`alreadyExists`) + "Customize for project" copy | `docs/api/web.openapi.yaml` + `docs/system-analytics/local-packages.md` |
| New file kinds (`manifest`, `subagent`) + create-wizard | `docs/screens/studio/*` + `web/lib/flows/editor/package-file-tree.ts` |
| Subagent vs platform-agent split + materialization + `maister-agents/`↔`agents/` resolution | `docs/system-analytics/agents.md` |
| List management actions (delete/rename/archive/cut/customize) | `docs/system-analytics/local-packages.md` (routes already in OpenAPI; verify) |

---

## Commit Plan
- **Commit 1** — A0: `docs: M39 Stream-A SSOT — first-class kinds + manifest form + centralized model (ADR-105)`
- **Commit 2** — A1: `feat(studio): package-home landing + manifest form + lock/end-edit fixes`
- **Commit 3** — A2: `feat(studio): flow canvas selection sync + node property tooltip`
- **Commit 4** — A3: `feat(studio): local-package management + fork dedup + commit-state + customize-for-project + create`
- **Commit 5** — A4: `feat(studio): first-class kinds — claude-subagent kind + viewer/editor first-class + create wizards`
- **Commit 6** — A5: `docs: flip Stream-A Designed→Implemented + M39 (part A)`

---

## Tasks

### Phase A0 — Design SSOT (docs-first, ADR-105) — Task #1
- [x] Stub ADR-105 (first-class authored kinds + manifest form + the centralized-model note: M36 ADR-096/097 platform-scoping STANDS; project-scoping evaluated + rejected) in `docs/decisions.md`. Above reserved 103/104. → Index row + body added; 104 reserved for G4, 105 taken.
- [x] Extend `local-packages.md` (centralized model + version-pin framing [forward-ref Stream B], manifest form, fork-dedup, "Customize for project" copy, list actions, commit-state + validation gate), `agents.md` (subagent vs platform-agent kind, `.claude/agents` materialization, lenient+custom schema, `maister-agents/`↔`agents/` resolution — **canonical = `maister-agents/`, catalog-wired, Designed**), `screens/studio/*` (editor IA in `editor.md`; `package-viewer.md` agent-detail dir fix). OpenAPI fork-dedup response (200 vs 201 + `alreadyExists`). error-taxonomy reuse note. Implementation-status `Designed`.
- [x] **Verify**: `validate:docs:all` green (ADR anchors 560 / mermaid 272-272); OpenAPI parses (fork responses 200,201,…; `ForkResult.alreadyExists:boolean`). redocly: no repo tooling/gate — spec parses as valid OpenAPI 3.0.3, exercised by 2 contract tests in later phases.

### Phase A1 — Editor IA: package-home + manifest form + lock/end-edit — Task #2 (blockedBy #1)
Root causes confirmed: no-path → `canvasAvailable=false` → YAML drawer opens empty → `syncYamlToCanvas("")` fires "YAML is invalid" banner (`flow-editor-tabs.tsx:110-164`, `studio/edit/[id]/page.tsx:81-115`) — also the "rework → empty yaml" symptom. `heldByMe` hardcoded `false` (`page.tsx:158`) → read-only flash. No real End-edit. `maister-package.yaml` classified `asset`, no form.
- [ ] Package-HOME landing when no flow file selected (overview + manifest form + file tree + orientation), NOT the empty flow canvas → eliminates invalid-yaml banner + rework-empty.
- [ ] `PackageManifestForm` + new `manifest` kind. **Kind-union fan-out — adding `manifest` to `AuthoredFlowPackageFileKind` touches 8 sites** (TS only catches the `Record` one): `catalog/authored-types.ts:10` (union), `flows/editor/editor-labels.ts:62` (`Record` label — TS-enforced), `messages/{en,ru}.json` `flows.packageFileKind`, `package-files-editor.tsx:361` (ContentEditor → ManifestForm branch), `code-editor.tsx:17` + `code-editor-inner.tsx:105` (`CodeEditorKind` + `languageExtension` → `yaml()`), `flows/package-authoring.ts:41` (`SUPPORTED_FILE_KINDS`), `flows/editor/package-file-tree.ts:10` (`maister-package.yaml → manifest`), `flows/artifact-validate.ts:80`. Raw-YAML toggle; strict parse → CONFIG.
- [ ] Fix `heldByMe` initial state (no read-only flash; compute real ownership server-side or acquire-on-load deterministically).
- [ ] Real "Done / End edit" (release lock + navigate to `/studio/local`).
- [ ] Header/breadcrumb (Studio › Local › <name>) + back link.
- [ ] LOGGING: structured logger on manifest save (parse pass/fail+reason), lock acquire/release, end-edit. NO console.*.
- [ ] **Verify**: unit (manifest round-trip, classifier `manifest`), component (package-home no-flow render), e2e (create → no banner; manifest form edit; End-edit releases lock + returns). Full suite green, tsc 0, scoped eslint 0.
- Files: `web/app/(app)/studio/edit/[id]/[[...path]]/page.tsx`, `web/components/studio/local-package-editor.tsx`, `web/components/flows/flow-editor-tabs.tsx`, `web/components/flows/editor/editor-top-bar.tsx`, `web/components/flows/package-files-editor.tsx`, `web/lib/flows/editor/package-file-tree.ts`, NEW `web/components/studio/{package-home,package-manifest-form}.tsx` + `web/lib/local-packages/manifest.ts`, i18n en/ru.

### Phase A2 — Flow canvas UX: selection sync + node tooltip — Task #3 (blockedBy #2)
Root causes: viewer static ReactFlow has NO `onNodeClick` (`flow-node-inspector.tsx:21-88`, flat picker only); editor wiring exists (`flow-graph-editor.tsx:585`) but starts empty; no tooltip (`flow-graph-view.tsx:305,325` native title only).
- [ ] Viewer `onNodeClick` → inspector (canvas primary; picker = a11y fallback; two-way highlight).
- [ ] Editor initial node selection / clearer empty state.
- [ ] Node property tooltip/popover (type, prompt/model summary, transitions, gates) in viewer + editor, sourced from `FlowNodeData`.
- [ ] LOGGING: client-only; no console.*.
- [ ] **Verify**: component (selection sync, tooltip props), e2e (click node → inspector; hover → popover). Full suite green, tsc 0, eslint 0.
- Files: `web/components/studio/{studio-flow-viewer,flow-node-inspector}.tsx`, `web/components/board/flow-graph-view.tsx`, `web/components/flows/flow-graph-editor.tsx`, `web/components/flows/node-side-form.tsx`, i18n.

### Phase A3 — Management + fork dedup + commit-state + customize-for-project + create discoverability — Task #4 (blockedBy #2)
Root causes: `forkPackageToLocal` (`fork.ts:90`) always INSERTs (no existing-fork check); idempotent `forkElementToDefault` wired to nothing (ElementCard stub `element-card.tsx:61-68`); list has only Import (no delete/rename/archive/cut despite routes existing); no create button on `/studio/packages`; commit buried in the diff drawer.
- [ ] Fork dedup: `forkPackageToLocal` existing-fork check by `source_install_id` → `{localPackageId, alreadyExists:true}`; route surfaces it (200 vs 201); `ForkToEditButton` navigates to existing + toast + explicit "Fork a new copy".
- [ ] Wire element-level fork (idempotent default) + messaging; remove disabled stub.
- [ ] **"Customize for this project"** = whole-package fork with an origin-reflecting name (name convention, NO schema); reuses the dedup path so a project's copy isn't duplicated. (The project-side attach of the copy is Stream B.)
- [ ] List actions: Delete (confirm — also rm working dir), Rename, Archive, Open, Cut-version; extend `LocalPackageListItem` DTO. Archived behind a toggle.
- [ ] **Commit-state button + validating commit** (`validatePackageArtifacts`, hard-block invalid): prominent top-bar action + dirty indicator. NEW `web/lib/local-packages/validate.ts`; all commit entry points route through it.
- [ ] Shared `web/components/studio/change-review-dialog.tsx` (diff + commit message) — introduced here, REUSED by Stream B (PR).
- [ ] "Create package" affordance on `/studio/packages`.
- [ ] LOGGING: structured logger on fork (alreadyExists, source_install_id), customize (origin name), delete (id+dir), rename/archive, commit (changedCount + validation pass/fail + invalid-artifact list). NO console.*.
- [ ] **Verify**: unit (dedup; validatePackageArtifacts rejects bad flow/manifest/agent, passes lenient subagent), integration real-PG (dedup, delete row+dir, archive-hide), component (Delete/Rename/Archive/Commit/Customize/ChangeReviewDialog), e2e (fork twice → same editor; customize-for-project; delete confirm; commit blocked on invalid; commit valid). Delete atomicity documented. Full suite green, tsc 0, eslint 0.
- Files: `web/lib/local-packages/{fork,service,validate(NEW)}.ts`, `web/app/api/studio/packages/[ref]/fork/route.ts`, `web/app/api/studio/local-packages/[id]/{route,commit/route}.ts`, `web/components/studio/{fork-to-edit-button,local-packages-list,element-card,packages-list,local-package-editor,change-review-dialog(NEW)}.tsx`, `web/app/(app)/studio/packages/page.tsx`, i18n.

### Phase A4 — First-class kinds: claude-subagent kind + viewer/editor first-class + create wizards — Task #5 (blockedBy #2)
Root causes (CORRECTED by /aif-improve trace — "add a 4th tab" was a misdiagnosis): the viewer (`package-detail.tsx:32` TAB_KINDS) ALREADY defines 6 tab kinds incl. `agents` (platform agents); the "only 3 tabs" is **zero-count suppression** (`package-tabs.tsx:56`). Two REAL issues: (1) a **`maister-agents/` vs `agents/` naming split** (viewer BOM reads `maister-agents/`→`inventory.platformAgents` `queries/packages.ts:365`; M34 catalog reads `agents/<stem>.md`); (2) the **viewer (read-only tabs)** and **editor (file-tree)** are different surfaces. Plus `classifyPackageFilePath` conflates `maister-agents/`+root `agents/` → `agent_definition` (`package-file-tree.ts:18-23`); subagents (`capability/<id>/agents/`) never strict-parsed; create = generic Add-File only.
- [ ] Distinct `subagent` kind (classifier split: `capability/<id>/agents/` → subagent; root `agents/`/`maister-agents/` → platform agent_definition). Lenient+open subagent schema `web/lib/agents/subagent-definition.ts` (name/description/tools/model/color + custom passthrough; New-template `model:inherit`, `tools` omitted). Dedicated `SubagentEditor` (form + raw). **Same 8-site kind-union fan-out as `manifest`** (see A1) + `FrontmatterArtifactKind` (`frontmatter-artifact-editor.tsx:16`) if SubagentEditor reuses the frontmatter editor.
- [ ] **Viewer** (`/studio/packages`): keep kind tabs; **resolve the `maister-agents/`↔`agents/` naming split** so platform agents surface (canonical dir + BOM + M34 catalog agree — coordinate with `agents.md`); zero-count suppression OK to keep in the read-only viewer.
- [ ] **Editor** (`/studio/edit`, file-tree): each of the four kinds (flows / platform agents / subagents / skills) first-class = per-kind FORM editor + raw-file view + a create affordance even when the kind dir is empty.
- [ ] Create wizards (New Flow / Platform Agent / Subagent / Skill) + kind picker + templates; skill asset uploads via existing import.
- [ ] Materialization split test: subagent → `.claude/agents` AND excluded from platform agents catalog projection.
- [ ] LOGGING: structured logger on create-artifact (kind, path), subagent parse (pass/fail, custom-keys count). NO console.*.
- [ ] **Verify**: unit (classifier split; subagent lenient+custom; templates), integration (materialize split), component (viewer naming-fix + editor 4-kind create), e2e (create each kind, edit form, raw toggle). Full suite green, tsc 0, eslint 0.
- Files: `web/lib/flows/editor/package-file-tree.ts`, `web/lib/agents/{definition,subagent-definition}.ts`, `web/lib/capabilities/materialize-bundle.ts` (verify), `web/components/flows/package-files-editor.tsx`, NEW `web/components/flows/artifact-editors/subagent-editor.tsx`, `web/components/studio/{package-detail,package-tabs}.tsx`, NEW create-artifact wizard, `web/lib/queries/packages.ts` (BOM split + naming), i18n.

### Phase A5 — Verify Stream A + docs flip + ROADMAP M39 (part A) — Task #9 (blockedBy #3,#4,#5)
- [ ] Flip Stream-A docs Designed→Implemented + ADR-105 status.
- [ ] ROADMAP M39 entry (Stream-A scope); note M38 = flow-routing.
- [ ] Final `/aif-verify` for Stream A: tsc 0, full unit+integration, e2e on host (free :3000), validate:docs:all, redocly 0, i18n en/ru parity, zero console.*.

---

## Resolved (owner)
- **Centralized model** (instance-level packages, central editing, per-project version pins; project-scoping rejected; M36 ADR-096/097 stands). ✅
- Subagent lenient+custom, `model:inherit`/`tools` omitted. ✅ · Commit-time validation gate + shared `ChangeReviewDialog`. ✅ · Stream B off A. ✅
- "Customize for this project" = labeled fork copy (name convention, explicit, rare). ✅
- "4th tab" = zero-count suppression + `maister-agents/`↔`agents/` naming split (not a missing tab); viewer≠editor. ✅

## Resolved this session (owner, 2026-06-22)
1. **Validation-gate:** ХАРД-БЛОК (no "commit anyway"). Валидируем **только изменённые** артефакты в коммите (закоммиченные считаем валидными) — flow parse+compile, manifest, platform-agent strict, subagent lenient, skill = наличие SKILL.md.
2. **Canonical platform-agent dir = `maister-agents/`** — меняем merged M34 runtime (registry/effective/launch/lifecycle/package-content) читать `maister-agents/`. Root `agents/` перестаёт быть platform-agent-локацией. (A4 blast-radius шире плана — grep-to-zero.)
3. **"Customize for project" = авто-имя `P (for <project>)`**, редактируемое позже.

## Base / worktree note (impl session)
FF'd branch `4ff8fadd → main 0e869906` (M38 flow-routing merged, ADR-103 в main; ADR-104 свободен под G4). Реализация в отдельном worktree `.claude/worktrees/studio-editor-impl` (W1 `infallible-kalam-9a2e23` detached/parked — background-процесс флапал там decisions.md). Plan line-refs писались от `4ff8fadd` — сверять при каждой правке (editor-labels/local-package-editor/node-side-form/lock сдвинулись после FF).
