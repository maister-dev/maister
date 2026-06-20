# Implementation Plan: Flow Package Viewer + Local Editing

Branch: feature/flow-studio-package-viewer
Created: 2026-06-20  (refined 2026-06-20 via /aif-improve)

Design spec (SSOT): `docs/plans/2026-06-20-flow-package-viewer-and-local-editing-design.md`
— every per-feature acceptance bullet below is the spec's; this plan adds repo-rule
gates (deployment wiring, contract→spec tracing, two-phase/atomic, run_kind fan-out,
ADR/migration reservation).

## Settings
- Testing: yes  (unit + integration on real-PG testcontainer + e2e; per-phase green gate)
- Logging: verbose  (DEBUG via the logger boundary — NO `console.*`; eslint `no-console`)
- Docs: yes  (mandatory docs-first step per milestone; route through /aif-docs at completion)

## Roadmap Linkage
Milestone: "M36 — Flow Studio package viewer + local editing"  (NEW — add to ROADMAP.md in T0.1)
Rationale: Matures the package browse experience and completes the editable-local-package layer (salvaged Phase C), adding fork-and-edit-all-elements, skill bundles + batch import, git-backed diff, and a docked AI authoring assistant.

## Reserved numbers (allocate up front — repo rule)
- **ADR-095** — Editable local packages (renumber of salvaged Phase C ADR-093; extended: both-grain fork, `is_default` virtual package, cut-version+attach, git-backed working dir).
- **ADR-096** — Docked AI authoring assistant (scratch ACP session rooted at a non-project local-package working dir; run_kind fan-out + launch-time snapshot + supervisor working-dir confinement).
- **Migration 0055** — renumber of salvaged Phase C `0053_*` (local_packages substrate). UNCHANGED content, new tag + rebuilt snapshot.
- **Migration 0056** — `local_packages.is_default` (per-project virtual package) + fork-lineage columns (`source_package_install_id`, `source_ref`).
- **Migration 0057** — local-package run linkage: `scratch_runs.project_id` → **nullable** + `scratch_runs.local_package_id` (FK), and `runs.local_package_id` (launch-time snapshot). Adjust `scratch_runs_project_status_idx` + the `run-kind-invariants` contract. (NEW — surfaced by /aif-improve: `scratch_runs.project_id` is `NOT NULL` today and a local-package session has no project.)
- Main HEAD at branch point: ADR-094, migration 0054. Re-verify ALL against `git show main:` at the renumber pass (T0.2) — do NOT trust this snapshot.

## Non-goals (do NOT implement)
Agent bundles/subdirs (agents stay single-file); editable on-canvas node popup (read-only inspector only); PR/git write-back from local packages; an AI-routing engine; new engine version; new `runs.status`; new `MaisterError` code (reuse `PRECONDITION | CONFIG | CONFLICT`).

## Commit Plan
- **Commit 1** (T0.1–T0.3): "chore(studio): salvage Phase C local-packages substrate onto main (renumber 0053→0055, ADR-093→095)"
- **Commit 2** (T1.1–T1.6): "feat(studio): tabbed package viewer + flow/skill/agent detail (read-only)"
- **Commit 3** (T2.1–T2.8): "feat(studio): editable local packages — /studio/local, /studio/edit, fork-to-local, cut-version"
- **Commit 4** (T3.1–T3.3): "feat(studio): batch import (folder + archive) into local packages"
- **Commit 5** (T4.1–T4.3): "feat(studio): git-backed working-tree diff + commit/discard in the local editor"
- **Commit 6** (T5.1–T5.9): "feat(studio): docked AI authoring assistant (ADR-096)"

---

## Tasks

### Phase 0 — Salvage Phase C onto this branch (numbers + green)

- [x] **T0.1 — Reserve numbers + add M36 to ROADMAP.**
  Verify next-free ADR (`git show main:docs/decisions.md`) and migration (`git show main:web/lib/db/migrations/meta/_journal.json`) at the CURRENT main HEAD (not this snapshot). Add the `## M36 — Flow Studio package viewer + local editing` milestone to `.ai-factory/ROADMAP.md` (unchecked, scope bullets per design §10). Add ADR-095 + ADR-096 stub headers to `docs/decisions.md` so citations resolve.
  Files: `.ai-factory/ROADMAP.md`, `docs/decisions.md`.
  Acceptance: `node scripts/validate-docs-adr-anchors.mjs` resolves ADR-095/096; ROADMAP has the M36 item.
  Logging: n/a (docs).

- [x] **T0.2 — Cherry-pick Phase C 2 commits + renumber.** (depends on T0.1)
  Cherry-pick `43aa6b78` (docs) + `e65e2364` (substrate) from `feature/flow-studio-phase-c-local-packages` onto this branch. RENUMBER: migration `0053_romantic_gorgon` → `0055_*` (rename `.sql` + `meta/0055_snapshot.json`; fix `meta/_journal.json` so `idx`/`tag` are sequential and `when` is monotonic ABOVE the current DB max — see `[[drizzle-journal-when-drift]]`); ADR-093 → ADR-095 in `docs/decisions.md` + every citing doc (`docs/system-analytics/local-packages.md`, `screens/studio/*`, `database-schema.md`, `db/projects-domain.md`, `error-taxonomy.md`, `configuration.md`, OpenAPI). Rebuild the drizzle snapshot (`pnpm --filter maister-web db:generate` then confirm no stray diff; see `[[drizzle-snapshot-custom-gotcha]]`).
  Files: `web/lib/db/migrations/0055_*.sql`, `web/lib/db/migrations/meta/{_journal.json,0055_snapshot.json}`, `web/lib/local-packages/*`, `web/app/api/studio/local-packages/**`, `web/lib/{authz,instance-config,db/schema}.ts`, `.env.example`, all Phase C docs.
  Acceptance: migration applies clean on a fresh PG (`pnpm --filter maister-web db:migrate` against testcontainer); the Phase C confinement unit test + CRUD/lock integration test (already authored) pass; `node scripts/validate-docs-adr-anchors.mjs` + `pnpm validate:docs` green; **no ADR-093 / `0053_romantic_gorgon` strings remain** (`grep -rn`).
  Logging: preserve Phase C's existing service logs.

- [x] **T0.3 — Phase 0 green gate.** (depends on T0.2)
  `pnpm --filter maister-web typecheck` (0), `pnpm --filter maister-web test:unit` + changed-scope `test:integration` green, `eslint` (scoped) 0, docs validators green. Commit 1.

### Phase 1 — Read-only mature viewer (spec §5)

> Reuses existing data/readers (no migration, no new route except RSC page params). Docs-first per repo rule. UI tasks: maintain **en/ru i18n parity**.

- [ ] **T1.1 — Docs-first: viewer surfaces.**
  Update `docs/screens/studio/README.md` + add/extend `docs/screens/studio/package-viewer.md` (tabbed groups, cards+paging, flow/skill/agent detail), tag `(Designed→Implemented on merge)`. Cite ADR-092 (Studio IA) + ADR-075 (viewer/fork). No new ADR.
  Acceptance: `pnpm validate:docs` green; screen doc lists each surface + states + links behavior to system-analytics (R7).

- [ ] **T1.2 — Rich BOM queries (+ rules inventory).** (depends on T1.1)
  Extend `web/lib/queries/packages.ts`: per-flow node/gate counts (compile `flow.yaml` from `installedPath` — reuse `getStudioPackageFlowGraphs` compile), per-skill file/subfolder counts (reuse `listInstalledPackageFiles` in `web/lib/flows/package-content.ts`), per-agent metadata (`parseAgentDefinition` in `web/lib/agents/definition.ts` → description, triggers, riskTier, workspace — NO runner). **NEW: inventory `rules/` from disk** — `getStudioPackageBom` currently returns `rules: []`, so the Rules tab would be permanently empty; enumerate rule files (or, if there are none, the Rules tab MUST hide rather than render empty). Return enriched `PackageBomItem` shapes.
  Files: `web/lib/queries/packages.ts`, types co-located.
  Acceptance: each kind's items carry their meta; **the Rules tab shows real rule files OR is hidden when empty (no empty tab)**; missing-on-disk degrades to id-only, never throws; **`installedPath` never appears in any returned DTO** (server-only).
  Logging: DEBUG `[packages.bom] {installId, kind, count}`; WARN on per-element disk-read failure (degrade).

- [ ] **T1.3 — Tabbed package screen.** (depends on T1.2)
  Rewrite `web/components/studio/package-detail.tsx` (+ `web/app/(app)/studio/packages/[ref]/page.tsx`) from chip lists → tab bar (Flows/Skills/Agents/MCPs/Rules with counts; **hide a kind's tab when count = 0**) + per-tab cards grid + paging; `?tab=` + page state in the URL (deep-linkable per web/CLAUDE.md). Keep header + Fork-to-local (wired in Phase 2; render disabled-with-hint until then). Add `studio.*` keys to **both** `messages/en.json` AND `messages/ru.json`.
  Files: `web/components/studio/package-detail.tsx`, new `package-tabs.tsx` / `element-card.tsx`, `web/app/(app)/studio/packages/[ref]/page.tsx`, `messages/{en,ru}.json` (studio.*).
  Acceptance (spec §5.1–5.2): no bare id chips; tab+page state in URL; Import affordance absent on installed packages; counts equal totals across pages; **en/ru key parity holds (i18n parity check green)**.
  Logging: DEBUG `[studio.packageDetail] {ref, tab, page}`.

- [ ] **T1.4 — Flow detail (canvas + read-only node inspector).** (depends on T1.3)
  New read-only flow detail route/page (sub-route of the package screen). Static `FlowGraphView` (no `runContext`) + reuse `NodeSideForm` in a NEW read-only mode (no mutation controls, no save) showing full prompt/gates/routes/enforcement/artifacts. Compile-fail → YAML fallback + notice (no 500).
  Files: `web/app/(app)/studio/packages/[ref]/flows/[flowId]/page.tsx`, `web/components/flows/node-form/node-side-form.tsx` (add `readOnly`), reuse `flow-graph-view.tsx`.
  Acceptance (spec §5.3): full per-node config rendered (not truncated); no SSE/`/graph-status`/status-ring; read-only emits no mutation controls.
  Logging: DEBUG `[studio.flowDetail] {flowId, nodeSelected}`.

- [ ] **T1.5 — Skill bundle detail + Agent detail.** (depends on T1.3)
  Skill: master–detail bundle browser reusing `listInstalledPackageFiles` + the confined `readInstalledPackageFile` (`web/lib/flows/package-content.ts`) + `PackageFileView` (markdown render / code / **image+binary preview** / typed placeholder) + SKILL.md frontmatter header. Agent: metadata panel (description, triggers/when-to-call, riskTier, workspace+ref, mode, capability profile, recommended cron/events — **NO runner**) + rendered prompt body (`parseAgentDefinition`). Add keys to en + ru.
  Files: `web/app/(app)/studio/packages/[ref]/skills/[...path]/page.tsx`, `.../agents/[stem]/page.tsx`, `web/components/studio/{skill-bundle-view,agent-view}.tsx`, reuse `package-viewer.tsx`/`package-content.ts`, `messages/{en,ru}.json`.
  Acceptance (spec §5.4–5.5): nested files all listed + rendered by type; every `?file=` path-confined before fs; agent view never shows a runner; missing bundle degrades; en/ru parity holds.
  Logging: DEBUG `[studio.skillDetail]`/`[studio.agentDetail]`.

- [ ] **T1.6 — Migrate existing tests + new tests + Phase 1 green.** (depends on T1.4, T1.5)
  **Assertion migration (repo rule — name the breakers):** T1.3 removes the chip BoM + `data-testid="package-preview"` layout — migrate every test asserting the old `package-detail` chips / BoM section / preview testid to the tabbed layout (search `package-detail`, `package-preview`, `bomTitle`, `kindFlows` in `web/**/__tests__` + `web/e2e`). New unit: BOM enrichment, agent-metadata projection (no runner), rules inventory/hide, path-confinement reuse. e2e: `studio-package-viewer.spec.ts` (tab nav incl. hidden-empty-tab, card→detail, read-only flow inspector, skill bundle tree, agent metadata) — JOIN the playwright `AUTHED_SPEC` regex; free :3000 before run. Contract surfaces: none new (RSC page params). Per-phase green (incl. i18n parity) + Commit 2.
  Acceptance: named migrated tests updated (not deleted); new tests EXECUTE (confirm runner glob matches) and pass; suite + i18n parity green.

### Phase 2 — Editable local packages (spec §6.1–6.4)

> Builds the Phase C UI + actions on the salvaged substrate. Docs-first; one migration (0056). UI tasks keep en/ru parity.

- [ ] **T2.1 — Docs-first: local-package editing + fork + cut-version.**
  Extend `docs/system-analytics/local-packages.md` (fork both-grain incl. **element-fork project selection**, `is_default` virtual package, cut-version+attach, lock, read-only enforcement) per R5; ERD updates in `docs/db/projects-domain.md` + `docs/database-schema.md` for the 0056 columns; OpenAPI for new routes (fork, fork-element, cut-version, file CRUD) in `docs/api/web.openapi.yaml`; ADR-095 body (extend). Decide + document whether MCP-template provenance (`platform_mcp_server_id`, T2.5) is persisted (schema delta) or display-only. Tag statuses.
  Acceptance: docs validators + ADR anchors green; every new route/column/error has a spec entry (contract→spec table in this task); MCP-provenance persistence decision recorded.

- [ ] **T2.2 — Migration 0056 (is_default + fork lineage).** (depends on T2.1)
  `local_packages.is_default boolean` (per-project virtual package; partial-unique index on `(project_id) WHERE is_default`), `source_package_install_id`, `source_ref` (fork lineage, nullable). Drizzle schema + migration + snapshot.
  Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0056_*`.
  Acceptance: applies clean; partial-unique enforces one default per project; `db:generate` shows no stray diff.

- [ ] **T2.3 — Working-dir file routes (under lock) + read-only banner.** (depends on T2.2)
  `GET/PUT/DELETE /api/studio/local-packages/[id]/files/[...path]` on the Phase C working dir. **Identifiers**: `id`=url-param (server-state lookup → working_dir), `path`=url-controlled → confine via `resolveWithinWorkingDir` (reject abs/`..`/symlink/`.git`); lock `sessionId`=body token → `assertHoldsLock` before any write (else `CONFLICT`). Second tab → read-only banner.
  Files: `web/app/api/studio/local-packages/[id]/files/[...path]/route.ts`, reuse `web/lib/local-packages/{paths,lock,service}.ts`.
  Acceptance (spec §6.3): writes only under a live lock (else `CONFLICT`); path confined pre-fs; `working_dir` never client-exposed.
  Logging: DEBUG `[localPkg.files] {id, op, path}`; WARN on confinement reject.

- [ ] **T2.4 — `/studio/local` + `/studio/edit/[id]/[[...path]]`.** (depends on T2.3)
  `/studio/local` RSC list (owner's local packages, per-project default badge). `/studio/edit` mounts Phase B `FlowEditorTabs` via the injectable seam (`saveAction`/`publishAction`/`filesDrawer`) with a NEW working-dir save action (writes via T2.3, lock-guarded, no draft-version CAS). Lock acquire on open + `lock-refresh` keep-alive + read-only fallback. Wire the dead `rework` span (`package-detail.tsx`) → fork-to-local. NOTE the coexistence with the legacy `/flows/{slug}/{capId}` authored-flow editor (not removed by this plan). en + ru keys.
  Files: `web/app/(app)/studio/local/page.tsx`, `web/app/(app)/studio/edit/[id]/[[...path]]/page.tsx`, `web/components/studio/local-packages-list.tsx`, `web/components/flows/flow-editor-tabs.tsx` (seam already injectable), `messages/{en,ru}.json`.
  Acceptance: editor reads/writes the working dir; 2nd tab read-only; lock refresh extends; YAML drawer hidden by default (inherited); en/ru parity.
  Logging: DEBUG `[studio.edit] {id, path, lockHeld}`.

- [ ] **T2.5 — Per-kind editors + MCP-template editor.** (depends on T2.4)
  Wire existing `FrontmatterArtifactEditor` (skill/agent/rule), `ScriptArtifactEditor`, `FormSchemaBuilder` to working-dir files (the `PackageFilesEditor` tree already supports nested folders). NEW MCP-template editor sourcing a `platform_mcp_servers` row (transport/command/args/url/`envKeys`, `env:NAME` only) at the `ContentEditor` dispatch insertion point. RECON: packages today carry **self-contained** MCP templates with NO catalog reference — the catalog-pick + optional `platform_mcp_server_id` provenance is ADDITIVE and tentative; validate against a real `platform_mcp_servers` entry per the T2.1 decision.
  Files: `web/components/flows/package-files-editor.tsx` (ContentEditor MCP branch), new `web/components/flows/artifact-editors/mcp-template-editor.tsx`, query for `platform_mcp_servers`, `messages/{en,ru}.json`.
  Acceptance: each kind edits via its editor; MCP editor materializes a template with `env:NAME` refs only (no secret values); unknown frontmatter keys preserved byte-stable; en/ru parity.
  Logging: DEBUG `[artifactEditor] {kind, path}`.

- [ ] **T2.6 — Fork to local (both grains).** (depends on T2.4)
  Package-level: `POST /api/studio/packages/[ref]/fork` → new local package (auto-named `<source>-local`), clean-copy all elements into a git-init'd working dir, record `source_package_install_id`/`source_ref`, return `{localPackageId}`. Element-level: `POST /api/studio/.../fork-element {projectId}` → copy one element into **that project's** `is_default` local package (create on first use). **The Studio package screen is platform-wide (not project-scoped), so element-fork MUST collect a target project** (project picker when the user has >1; auto when exactly 1) — `projectId` is `body-controlled` and MUST be validated against the caller's accessible projects (server-state), not trusted raw. **Reads precede ONE tx; execute nothing.** Source ids = url-param→server-state; never trust a body path.
  Files: `web/app/api/studio/packages/[ref]/fork/route.ts`, `.../fork-element/route.ts`, `web/lib/local-packages/fork.ts`, reuse `web/lib/local-packages/git.ts`, fork dialog component (project picker).
  Acceptance (spec §6.2): package fork copies all elements; element fork copies exactly one into the chosen project's default; `projectId` validated against accessible projects (else 403/404, no write); nothing executes; missing bundle → `CONFIG` (nothing persisted); explicit slug collision → `CONFLICT`; requires `requireSession`.
  Logging: DEBUG `[localPkg.fork] {grain, source, projectId?, localPackageId}`.

- [ ] **T2.7 — Cut version + attach (two-phase / multi-store).** (depends on T2.6)
  `POST /api/studio/local-packages/[id]/cut-version` → clean-export working dir (exclude `.git`) → `installPackageRevision({source, version:"local"})` (immutable `local-<digest>` install) → stamp `last_cut_install_id`; optional attach (`attachPackage`, member-gated). **Order**: git/export side-effects BEFORE the tx; the install/attach durable writes are the AFTER mark; enumerate crash windows (export done / install done / attach pending) each with a recovery note; the two-phase install intent rows already exist.
  Files: `web/app/api/studio/local-packages/[id]/cut-version/route.ts`, reuse `web/lib/packages/attach.ts` (`installPackageRevision`, `attachPackage`).
  Acceptance (spec §6.4): immutable `local-<digest>` reflects the working dir at cut; later edits don't mutate it; attach gated by `manageLocalPackages: member`; git-package gates stay admin; crash between export+install leaves no half-registered revision.
  Logging: INFO `[localPkg.cutVersion] {id, digest, attached}`; DEBUG step-by-step.

- [ ] **T2.8 — Deployment wiring + tests + Phase 2 green.** (depends on T2.7)
  Deployment touchpoints (repo rule — name the compose decision explicitly): `MAISTER_LOCAL_PACKAGES_ROOT` + `MAISTER_LOCAL_PACKAGE_LOCK_MINUTES` in `.env.example` (Phase C added); state in `docs/deployment.md` + `docs/configuration.md` that the local-root is **host-only / NOT a compose mount per ADR-023** (doc the gap — do not silently skew). Tests: integration (real PG) for file routes + lock + fork (both grains incl. project-validation) + cut-version crash windows; e2e `studio-local-edit.spec.ts` (fork→edit→cut→attach) JOIN AUTHED_SPEC. Contract surfaces table (routes→OpenAPI, columns→ERD). Per-phase green (incl. i18n parity) + Commit 3.
  Acceptance: deployment task names which file each env lands in AND the explicit "not mounted" gap line; cut-version crash-window tests pass; suite green.

### Phase 3 — Batch import (spec §6.6)

- [ ] **T3.1 — Docs + import route.**
  Docs: add the import route to OpenAPI + `local-packages.md`; the cap env to `configuration.md` + `.env.example` + the web service `environment:` block in `compose.yml` (+ prod overlay) OR an explicit host-only doc-gap line (name the compose decision per the deployment rule). Route `POST /api/studio/local-packages/[id]/import` accepts a folder (multipart, relative paths preserved) **and** an archive (zip/tar.gz). **Confine every entry** via `resolveWithinWorkingDir`; reject zip-slip/abs/`..`; enforce caps (**default: archive > 50 MB or > 2000 entries, or any file > 10 MB → `PRECONDITION`**; env-tunable `MAISTER_IMPORT_MAX_*`). Lock-guarded. Pre-write preview tree (dry-run mode) before commit.
  Files: `web/app/api/studio/local-packages/[id]/import/route.ts`, `web/lib/local-packages/import.ts`, `.env.example`, `compose.yml` (or doc-gap), `docs/configuration.md`, `docs/api/web.openapi.yaml`.
  Acceptance (spec §6.6): folder preserves subfolders + binary bytes; archive extracts same tree; zip-slip/over-cap rejected pre-write (nothing persisted); confined to working dir; live lock required; the `MAISTER_IMPORT_MAX_*` compose decision is named.
  Logging: INFO `[localPkg.import] {id, mode, entries, bytes}`; WARN on each rejected entry.

- [ ] **T3.2 — Import UI (drop/pick + preview).** (depends on T3.1)
  The `⤓ Import` affordance on the local-package editor + collection view: folder drag-drop / directory picker (`webkitdirectory`) + archive file input; show the preview tree; confirm → commit. en + ru keys.
  Files: `web/components/studio/import-dialog.tsx`, wire into `package-files-editor.tsx` / local list, `messages/{en,ru}.json`.
  Acceptance: import only appears on local (editable) packages; preview precedes write; en/ru parity.
  Logging: DEBUG `[studio.import] {mode, count}`.

- [ ] **T3.3 — Tests + Phase 3 green.** (depends on T3.2)
  Integration: folder import (subfolders + binary), archive import, zip-slip reject, cap reject — each asserts nothing-persisted on reject. e2e join AUTHED_SPEC. Per-phase green (incl. i18n parity) + Commit 4.

### Phase 4 — Git-backed diff + Commit/Discard (spec §6.5)

- [ ] **T4.1 — Docs + working-tree diff route.**
  Docs: OpenAPI for diff/commit/discard; note in `local-packages.md`. `GET /api/studio/local-packages/[id]/diff` reusing `web/lib/worktree.ts` `diffWorkingTree` + `diffNameStatus` on the working dir → `prepareDiff` (`web/lib/diff/prepare.ts`) → `@git-diff-view` DTO. `POST .../commit` (`git commit`, optional message) + `POST .../discard` (`git checkout -- <paths>`), lock-guarded. **Identifiers**: `id`=url→server-state working_dir; `paths`=body → confine before the git call.
  Files: `web/app/api/studio/local-packages/[id]/{diff,commit,discard}/route.ts`, reuse `web/lib/worktree.ts`, `web/lib/diff/prepare.ts`.
  Acceptance (spec §6.5): diff reflects real `git status`/`git diff`; commit resets changed-count to 0; discard restores to HEAD; works with NO AI session present.
  Logging: DEBUG `[localPkg.diff] {id, changed}`; INFO `[localPkg.commit] {id, files}`.

- [ ] **T4.2 — Editor diff drawer + changed-count + Commit/Discard.** (depends on T4.1)
  Extend the existing `[Diff]` drawer (`flow-editor-tabs.tsx`) with a local-package git mode rendering the `@git-diff-view` `DiffView` (reuse `web/components/workbench/diff-view.tsx`); top-bar `⎇ N changed · Commit · Discard`. en + ru keys.
  Files: `web/components/flows/flow-editor-tabs.tsx`, reuse `diff-view.tsx`, `messages/{en,ru}.json`.
  Acceptance: changed-count live after any save/import; Commit/Discard wired to T4.1; en/ru parity.
  Logging: DEBUG `[studio.edit.diff] {id, changed}`.

- [ ] **T4.3 — Tests + Phase 4 green.** (depends on T4.2)
  Integration: edit→diff shows change; commit→clean; discard→restored. e2e join AUTHED_SPEC. Per-phase green + Commit 5.

### Phase 5 — Docked AI authoring assistant (spec §7, ADR-096)

> The hardest milestone: a scratch-style ACP session rooted at a NON-project local-package working dir. Docs-first; the run_kind fan-out + the project-less scratch model are the core risk. Needs migration 0057 AND a supervisor change.

- [ ] **T5.1 — Docs-first + ADR-096.**
  New `docs/system-analytics/studio-ai-assistant.md` (R5: entities, state machine, process flow, expectations, edge cases) + the `run_kind = scratch-at-local-package` row in `docs/system-analytics/runs.md`; ERD for the 0057 columns in `docs/db/runs-domain.md` + `docs/database-schema.md`; OpenAPI for the assistant routes. ADR-096 body: a scratch run whose target is a `local_package` working dir (NOT a project worktree, NO managed `git worktree`, project-less); the run_kind handling decision; the launch-time snapshot; the supervisor working-dir confinement. Enumerate the **run_kind consumer set** as the T5.4 checklist.
  Acceptance: docs validators + ADR anchors green; the consumer checklist is exhaustive (cross-checked vs the grep in T5.4).

- [ ] **T5.2 — Migration 0057 (local-package run linkage).** (depends on T5.1)
  `scratch_runs.project_id` → **nullable**; add `scratch_runs.local_package_id` (FK `local_packages`, `ON DELETE CASCADE`) + a CHECK that exactly one of `project_id`/`local_package_id` is set; add `runs.local_package_id` (launch-time snapshot, nullable). Adjust `scratch_runs_project_status_idx` (partial / split) and the `run-kind-invariants` scratch contract to admit the project-less variant.
  Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0057_*`, `web/lib/runs/run-kind-invariants.ts`.
  Acceptance: applies clean; the XOR(project_id, local_package_id) CHECK holds; `run-kind-invariants` admits a `local_package_id`-only scratch row and still forbids `taskId`/`flowId`; `db:generate` no stray diff.

- [ ] **T5.3 — Authoring skill.** (depends on T5.1)
  Author a `flow-authoring` skill (flow.yaml DSL, node/route/gate semantics, package layout) shipped where the assistant materializes skills for its session.
  Files: skill bundle under the assistant's seed location.
  Acceptance: skill loads in the assistant session (smoke).

- [ ] **T5.4 — Scratch-at-local-package rooting + run_kind fan-out.** (depends on T5.2)
  Teach the scratch path a local-package target: `launchScratchRunStaged` (`web/lib/scratch-runs/service.ts`) accepts a local-package target with `worktreePath = <local_package working_dir>`, **NO project, NO `git worktree add`, NO new workspace row** (the session runs IN the existing git-backed working dir; base branch/commit read from it). Write the project-less `scratch_runs` row (0057) + snapshot `runs.local_package_id`. **Branch EVERY run_kind consumer** (verified by grepping `runKind`) so a project-less run is handled, not crashed: `reconcile.ts` (must NOT mark Crashed for a missing project worktree — it isn't in `git worktree list`), `resume-driver.ts` (must NOT drive it; recover via scratch turn), `scheduler.ts` (flow/scratch pool cap), `keepalive-sweeper.ts` (idle handling without a project worktree), `portfolio.ts`/`board.ts` (read models — surface under Studio, not a project board; `derivePortfolioWorkspaceMetadata` assumes a workspace row), `lifecycle-actions.tsx` `endpointFor`, `run-kind-invariants.ts`, `diff/route.ts`. Add a guard at the irreversible spawn site (not just the classifier).
  Files: `web/lib/scratch-runs/service.ts`, `web/lib/{reconcile,scheduler}.ts`, `web/lib/runs/{resume-driver,keepalive-sweeper,run-kind-invariants}.ts`, `web/lib/queries/portfolio.ts`, `web/lib/board.ts`, `web/components/workbench/lifecycle-actions.tsx`.
  Acceptance (repo rule): a project-less local-package scratch run is never driven into the flow resume driver AND never marked Crashed by reconcile for lack of a project worktree (tests); each consumer arm has a test; launch-time `local_package_id` is snapshotted and read by the terminal path; pool accounting correct; no NULL-deref where a workspace/project row was assumed.
  Logging: INFO `[studio.assistant.launch] {localPackageId, runId}`; DEBUG per consumer branch.

- [ ] **T5.5 — Supervisor: working-dir confinement for a project-less session.** (depends on T5.4)
  The supervisor confines content-block `file:` URIs to `repoPath` (`supervisor/src/prompt-confinement.ts`, `http-api.ts:539`, `spawn.ts:305`). For a local-package session pass the **working_dir** as the confinement root (set `repoPath = working_dir` on the `CreateSessionInput`/`StartSessionRequest`, or add an explicit `confineRoot`). Defense-in-depth: the web tier confines too.
  Files: `supervisor/src/{types,http-api,spawn,prompt-confinement}.ts`, the web `createSession` call in `web/lib/scratch-runs/service.ts`.
  Acceptance: a file URI outside the working_dir is rejected by the supervisor for a local-package session; `pnpm --filter @maister/supervisor test` green (supervisor suite).
  Logging: existing supervisor confinement WARN path.

- [ ] **T5.6 — Lock coordination + deferred-release.** (depends on T5.4)
  The assistant run writes under the editor's working-dir lock (editor = holder; assistant writes as that holder; turn-based). On any failure path that created an ACP/HITL deferred, ensure explicit release (reuse the existing `cancelPermission` contract). While the assistant holds a turn → editor "AI working" read-only; control returns on turn end.
  Files: assistant launch/turn service, `web/lib/local-packages/lock.ts` (associate run↔lock), reuse HITL deferred-release.
  Acceptance (spec §7 + repo rule): no assistant write outside the working dir or under a stale lock; every failure path releases its deferred (regression test spies the cancel); turn hand-back works.
  Logging: DEBUG `[studio.assistant.turn] {runId, lockHeld}`; ERROR on deferred-release path.

- [ ] **T5.7 — Right-panel Properties ⇆ AI tab + live refresh + inline HITL.** (depends on T5.5, T5.6)
  Add the AI tab to the editor right panel (reuse `scratch-transcript.tsx` + the SSE `GET /api/runs/[id]/stream` hook + the HITL respond route inline). On assistant file writes, refresh the canvas/files (re-read working dir → the T4 changed-count + diff reflect it). Counts against the scratch (flow) pool cap. en + ru keys.
  Files: `web/components/flows/flow-editor-tabs.tsx` (right-panel tabs), reuse `web/components/scratch/scratch-transcript.tsx`, SSE hook, `messages/{en,ru}.json`.
  Acceptance (spec §7): agent writes appear without manual reload; permission prompts render inline + resolve; secrets never reach the client; en/ru parity.
  Logging: DEBUG `[studio.edit.ai] {runId, event}`.

- [ ] **T5.8 — Concurrency / GC notes.** (depends on T5.4)
  Confirm the assistant run is in the flow/scratch pool (cap `MAISTER_MAX_CONCURRENT_RUNS`); no auto-GC of the working dir (manual, per Phase C). One ACP run per editor tab; lives while the tab is open; clear/refresh-session deferred.
  Acceptance: opening a 2nd editor tab does not spawn a 2nd assistant for the same lock holder; cap accounting correct.

- [ ] **T5.9 — Tests + Phase 5 green.** (depends on T5.6, T5.7)
  Integration: assistant launch at a local-package working dir, a turn writes a file, diff reflects it; reconcile-no-crash + resume-driver-skip; per-consumer run_kind arm; deferred-release regression; supervisor confinement. e2e `studio-ai-assistant.spec.ts` (mock ACP adapter) JOIN AUTHED_SPEC. Per-phase green (web + supervisor + i18n parity) + Commit 6.

---

## Contract surfaces → spec files (repo rule — re-derived by /aif-verify)
| Surface | Spec file |
| --- | --- |
| `local_packages.is_default` + fork-lineage cols (0056) | `docs/database-schema.md` + `docs/db/projects-domain.md` |
| `scratch_runs.project_id` nullable + `scratch_runs.local_package_id` + `runs.local_package_id` (0057) | `docs/database-schema.md` + `docs/db/runs-domain.md` |
| File CRUD / fork / fork-element / cut-version / import / diff / commit / discard / assistant routes | `docs/api/web.openapi.yaml` + `docs/system-analytics/local-packages.md` + `studio-ai-assistant.md` |
| `MAISTER_IMPORT_MAX_*` env (+ compose decision) | env-vars table in `docs/configuration.md` + `.env.example` + `compose.yml` (or doc-gap) |
| `manageLocalPackages` action (Phase C) | `web/lib/authz.ts` + identity-access doc |
| supervisor working-dir confinement (project-less session) | `docs/supervisor.md` + `docs/api/supervisor.openapi.yaml` |
| ADR-095 (local editing), ADR-096 (AI assistant) | `docs/decisions.md` |
| run_kind = scratch-at-local-package variant | `docs/system-analytics/runs.md` (run_kind table) |

## Per-phase green gate (every phase)
`pnpm --filter maister-web typecheck` (0) · `test:unit` + changed-scope `test:integration` green (real-PG testcontainer; `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`, `dangerouslyDisableSandbox`) · **i18n en/ru parity check green** for any phase that adds message keys · **supervisor suite green** (`pnpm --filter @maister/supervisor test`) for M5 · scoped `eslint .` 0 (never no-path `lint` — it reformats the repo) · `pnpm validate:docs` + `node scripts/validate-docs-adr-anchors.mjs` green · new e2e specs JOIN the playwright `AUTHED_SPEC` regex and free :3000 first (Next 16 single-dev lock).

## Open items to confirm during implementation
- Exact ADR/migration numbers (re-verify vs live main at T0.1/T0.2).
- Whether 0056/0057 columns can fold into the rebuilt 0055 (kept separate to avoid touching Phase C's tested substrate).
- T5.4 project-scoping relaxation surface area (read models + portfolio assume a project/workspace row) — the migration (T5.2) + fan-out (T5.4) bound it, but the exact NULL-handling in `portfolio.ts`/`board.ts` needs care.
- Element-fork project selection UX when the caller has 0 accessible projects (block with a clear message) vs exactly 1 (auto).
- Legacy `/flows/{slug}/{capId}` authored-flow editor coexistence with `/studio/edit` (both live post-M36; no migration of authored drafts in scope).
