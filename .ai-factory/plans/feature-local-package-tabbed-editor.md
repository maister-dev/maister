# Local Package Editor — Tabbed-by-Kind Composition View

**Branch:** `claude/funny-curran-44a0cb` (existing worktree; no new branch created)
**Created:** 2026-06-28
**Type:** Enhancement (Flow Studio / local-package editor IA redesign)
**Mode:** Full · SDD-driven · TDD implementation

---

## Problem

The local-package editor (`/studio/edit/[id]`) currently renders, as its no-path
landing (`PackageHome`), flows as opaque clickable badges plus a raw,
non-interactive file tree (`PackageFilesEditor`). Skills, agents, subagents,
MCP descriptors and rules are visible **only** as files in that tree — folders
are non-collapsible headings, there is no count, no per-kind grouping, and a
skill's files end up scattered far apart. "What is in this package, how much of
each kind, what are they" is not answerable at a glance. File moves work only
through a free-text "Rename path" popup; there is no drag-and-drop, folder
creation, or batch import surfaced.

The **installed**-package viewer (`/studio/packages/[ref]`, `PackageDetail` →
`PackageTabs` + `ElementCard`) already solves the readability problem with a
tabbed-by-kind view driven by a computed `PackageBom`. The local editor does not
reuse it. This plan closes that asymmetry: give the editable local package the
same tabbed-by-kind composition view, layered over the existing
draft-files + lock + save substrate, and surface create / rename / file-manager /
batch-import affordances.

## Goal & Approved Design (brainstormed 2026-06-28)

Replace `PackageHome`'s flow-badges + raw tree with a **tabbed-by-kind
composition view** reusing the installed viewer's `PackageTabs` / `ElementCard`
pattern. Seven tabs with live counts:

`Flows(n) · Skills(n) · Subagents(n) · Agents(n) · MCP(n) · Rules(n) · Files`

**Open model per kind:**

| Kind | Where it opens | Why |
| --- | --- | --- |
| Flows | route → existing canvas (`FlowEditorTabs`) | graph does not fit inline |
| Skills | route → dedicated skill screen (own mini file-navigator + `FrontmatterArtifactEditor`) | skills have **nested folders**; a side panel cannot hold them |
| Subagents | master-detail **inline** (card list + side editor) | single `.md`, lenient frontmatter |
| Agents (platform) | master-detail **inline** | single `.md`, structured frontmatter |
| MCP | master-detail **inline** (`McpTemplateEditor`) | single `mcps/<name>.yaml` |
| Rules | master-detail **inline** (`FrontmatterArtifactEditor` rule, source+preview) | single `rules/*.md` |
| Files | file-manager tab (raw tree + breadcrumbs + dnd + create/rename folder + Import) | secondary; disk-level escape hatch |

**Create:** per-tab `+ Add <Kind>` scaffolds the correct file structure into the
draft set and opens the right editor (flow → canvas; skill → skill screen;
agent/subagent/mcp/rule → inline card).

**Rename:** a card-level `Rename <Kind>` action renames the artifact **identity**
(its file / folder; the id derives from filename/folder). Distinct from editing
**metadata** (frontmatter: description/triggers/…), which happens inside the
artifact editor. Two actions, never mixed.

**Files tab:** raw tree + breadcrumbs + drag-and-drop move + new file / new folder
+ rename + delete, plus one shared **Import** button (batch upload of files/
folders) wired to the existing import route. Per-kind contextual imports deferred.

## Settings

- **Testing:** Yes — TDD, strict RED → GREEN → refactor. Tests cover all
  required functionality and edge cases, minimal overlap, no trivial tests.
- **Logging:** Verbose (DEBUG around BOM parse, scaffolders, rename/move, import).
- **Docs:** Mandatory docs checkpoint at completion; doc changes route through
  `/aif-docs`. Analytics is front-loaded (Phase 0), not a trailing sync.
- **i18n:** EN + RU parity required for every new key (`web/messages/en.json`,
  `web/messages/ru.json`).
- **Errors:** typed `MaisterError` codes only — never plain `Error`, never
  string-matched.

## Roadmap Linkage

Milestone: "none". Rationale: Skipped by user — this is a Flow Studio UX
refinement, not a roadmap milestone. `/aif-verify --strict` should WARN (not
fail) on missing linkage alone.

---

## Decisions (SDD — contract surfaces, identifiers, reservations)

### D1. Reservations (allocate up front)

- **ADR:** **ADR-115** — "Local-package composition view: package BOM decoupled
  from install into a shared source abstraction; tabbed editor IA." Highest ADR
  at branch HEAD is ADR-114 (`docs/decisions.md:9008`); 115 is free. A stub
  `### ADR-115` header + index anchor is written in Phase 0 **before** any
  citation (a cited-but-headerless ADR is a build break, per project rule).
- **Migration:** **NONE.** `local_packages` already carries every column; files
  are filesystem-only with no DB index. Next free migration `0083` stays unused.
  This is stated explicitly so `/aif-verify` does not expect one. If, and only
  if, a later decision adds a column, it takes `0083` and updates BOTH
  `docs/database-schema.md` AND `docs/db/projects-domain.md` ERD.

### D2. Contract surfaces (trace each to its spec)

| Surface | Change | Spec file(s) |
| --- | --- | --- |
| HTTP routes | **None added/changed.** Create/rename/import/move all reduce to the existing lock-guarded `PUT`/`DELETE /api/studio/local-packages/{id}/files/{...path}` (save-diff) and the existing `POST /api/studio/local-packages/{id}/import` (multipart preview/commit). | `docs/api/web.openapi.yaml` — **no edit** (verified routes already present, ADR-096). Plan asserts no drift. |
| `move` route | The OpenAPI `POST .../files/{path}/move` is **Designed, not implemented**. This plan does **not** implement it and does **not** depend on it; rename uses save-diff. The OpenAPI "Designed" tag stays accurate. | `docs/api/web.openapi.yaml` (left as Designed) |
| Domain error codes | No new code. Reuses `PRECONDITION` (path escape / missing), `CONFLICT` (lock lost / duplicate path / slug). | `docs/error-taxonomy.md` — no edit |
| Internal query | New `buildPackageBom(source)` + `getLocalPackageBom(pkg)`; `getStudioPackageBom` refactored to consume the shared builder. Not an HTTP surface (RSC-only). | `docs/system-analytics/local-packages.md` (Domain entities + Process flows) |
| System-analytics | New composition-view IA + open-model + create/rename/files-tab/import flows + invariants + edge cases. | `docs/system-analytics/local-packages.md` (expanded), cross-ref from `docs/system-analytics/flow-studio.md` |

### D3. Identifiers / trust boundary (no new body-controlled ids)

No new HTTP route is introduced, so no new identifier crosses the wire. All file
mutations continue through the existing handlers where:

- `id` = **url-param** → server row → `working_dir` (never client-exposed).
- `sessionId` = **auth-context-bound** edit-lock token; every `PUT`/`DELETE`/
  import-commit asserts `assertHoldsLock`.
- the relative file path = confined server-side by `resolveWithinWorkingDir`
  (lexical + realpath + symlink-ancestor + leaf-symlink guards) → `PRECONDITION`
  on escape.

The plan adds **no** body-controlled cross-resource locator. This is recorded to
satisfy the trust-boundary review gate by confirming the null change.

### D4. BOM abstraction (the core refactor)

Define a `PackageSource` the BOM builder consumes, so installed and local
packages share one parser:

```ts
interface PackageSource {
  manifest: MaisterPackageManifest;          // spec.flows[], spec.mcps[], …
  inventory: { skills: string[]; agents: string[]; platformAgents: string[] };
  listFiles(): Promise<PackageFileEntry[]>;   // { path, kind, size }
  readFile(rel: string): Promise<ReadResult>; // confined, size-capped
}
```

- **Installed source:** `manifest` + `inventory` from `package_installs.manifest`;
  `listFiles`/`readFile` over `installedPath` (today's behavior, unchanged).
- **Local source:** `manifest` parsed from working-dir `maister-package.yaml`;
  `inventory` **computed** at BOM time by walking the working dir (the
  install-time `collectInventory` logic, factored to run over a file list);
  `listFiles`/`readFile` over `working_dir`.
- **Per-kind derivation (identical for both, to keep installed output stable):**
  - flows ← `manifest.spec.flows[]` (compile each `flow.yaml`)
  - mcps ← `manifest.spec.mcps[]` (id-only, as today)
  - skills ← `inventory.skills[]` (+ file walk for counts + `SKILL.md` desc)
  - platformAgents ← `inventory.platformAgents[]` (parse `maister-agents/<stem>.md`)
  - subagents ← `inventory.agents[]` (resolve `capability/**/agents/<stem>.md`)
  - rules ← files where `kind === "rule"`
  - **Graceful degradation preserved** — any per-element parse failure logs and
    yields an id-only card; the builder never throws.
- **Regression guard:** `getStudioPackageBom`'s output for a fixture installed
  package is **byte-identical** before/after the refactor (characterization test).

### D5. BOM snapshot vs draft (consistency model)

The composition `PackageBom` is **server-computed at RSC load** and re-derived on
`router.refresh()` after a save (matching the existing editor refresh pattern).
Therefore:

- Tab structure, counts and cards reflect the **last-saved disk state**.
- Inline content editing (agent/subagent/rule/mcp side panel) mutates the
  existing `draftFiles` set and persists through the existing save channel; on
  save+refresh the BOM re-computes.
- Identity changes (create / rename / delete) are save-then-refresh operations,
  so a new/renamed card appears after the save round-trip. This is the documented
  invariant (no client-side flow compilation; KISS).

### D6. MCP path handling

MCP descriptors are `mcps/<name>.yaml`. `classifyPackageFilePath` returns
`"asset"` for the `mcps/` prefix today, so the composition view and the local
BOM must special-case `mcps/*.yaml` explicitly (a small `isMcpDescriptorPath`
predicate) rather than relying on the tree classifier. `classifyPackageFilePath`
is **not** broadened (would ripple into the installed reader); the predicate is
local to the MCP discovery + editor-routing call sites.

### D7. Folder creation in a file-list model (no sentinel garbage)

The draft model is a flat `{path, content}[]`; git does not track empty dirs.
**"New folder" is a virtual node in the Files-tab tree (client-only):** it lets
you target the folder when adding/dragging files in, but is **not persisted**
and writes **no `.gitkeep` sentinel** — an empty folder that never receives a
file simply never reaches disk (no garbage). Folders otherwise materialize
implicitly when a file is placed in a new path. Drag-and-drop move and rename
operate on the flat list (rewriting path prefixes). If empty-folder persistence
is ever genuinely required it is handled at **cut-version** time (check/add a
keep-file there), not by littering the working tree — out of scope for this plan.
(Owner call 2026-06-28: local empty dirs are harmless; only push/cut cares, so
don't manufacture sentinels.)

### D9. Orphan cleanup is in-scope every phase

Removing code that a change orphans is part of the change, not a follow-up. When
`PackageHome` is replaced (Phase 2) it is **deleted**, along with any flow-badge
helpers, `package-home` tests, and now-unused exports it pulled in. Each phase
removes the imports/components/helpers **its** changes made unused; Phase 8 runs
a dead-code sweep (grep now-unused exports to zero). Pre-existing unrelated dead
code is reported, not deleted.

### D8. Rename semantics per kind (save-diff based)

- single-file (agent/subagent/rule/mcp): rename one path → `validatePathEdit` +
  `renamePackageFilePath`, persisted by the save-diff (PUT new + DELETE old).
- skill (folder): rename `skills/<old>/` → `skills/<new>/` rewrites the path
  prefix of **every** file under it.
- flow: rename `flows/<old>.yaml` → `flows/<new>.yaml` AND update the
  `manifest.spec.flows[]` entry (id + path) via `appendManifestFlow`/manifest
  edit. A flow rename that updates the file but not the manifest is a defect.
- collision against any existing path → `CONFLICT` (surfaced inline, never a
  silent overwrite).

---

## Phases

> Every phase exits only when the **full suite is green**
> (`pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration`),
> `pnpm --filter maister-web typecheck`, and `pnpm --filter maister-web lint`
> (check-only) all pass, and any assertion migrated by the phase is updated **in**
> that phase. Each promised test names the runner project and is confirmed to be
> matched by its `include` glob (`vitest list`).

### Phase 0 — Analytics & contract spec (docs-first, blocks all code)

**P0.1** Reserve **ADR-115** in `docs/decisions.md`: write the `### ADR-115`
header + index-table anchor + the decision body (BOM-decoupling + tabbed local
editor IA + open-model + no-migration/no-new-route rationale). Verify
`pnpm validate:docs:adr` green.

**P0.2** Expand `docs/system-analytics/local-packages.md` per docs/CLAUDE.md R5:
- **Domain entities:** add `PackageSource`, `PackageBom` (local), composition tabs.
- **State machine:** unchanged session-lock FSM; note BOM is derived, not stored.
- **Process flows** (`flowchart`/`sequenceDiagram`): (a) open-model routing per
  kind, (b) create-artifact scaffold→save→refresh, (c) rename-identity save-diff,
  (d) files-tab move/folder, (e) batch import preview→commit.
- **Expectations** (≤12 testable invariants): tab counts equal BOM lengths;
  empty kinds hide their tab; flow opens canvas, skill opens its own screen,
  agent/subagent/mcp/rule open inline; create scaffolds the exact path shape and
  appends manifest for flows; rename rewrites identity (folder rename moves all
  children; flow rename updates manifest) and never overwrites; readOnly (lock
  lost / no manage / assistant busy) disables every mutation; BOM degrades to
  id-only cards on parse failure, never throws; import is confined + lock-gated.
- **Edge cases** → `MaisterError` codes (`PRECONDITION`, `CONFLICT`).
- **Implementation-status tags** (R6): each new piece tagged `Designed` here,
  flipped to `Implemented` in Phase 8.
- Cross-reference from `docs/system-analytics/flow-studio.md`.

**P0.3** Record the **null contract delta** in the plan/doc: assert via
`npx @redocly/cli lint docs/api/web.openapi.yaml` that the file-ops + import
routes already exist; confirm no OpenAPI edit is required; confirm no migration.

**Exit:** `pnpm validate:docs:all` + `validate:docs:adr:all` + redocly lint green;
docs internally consistent; every later-phase surface traces to a doc section.

*Commit checkpoint:* `docs(studio): ADR-115 + local-package composition analytics`

### Phase 1 — Shared BOM abstraction (backend, TDD) — **main backend work**

**P1.1 (RED→GREEN)** Extract `buildPackageBom(source: PackageSource): Promise<PackageBom>`
into `web/lib/queries/package-bom.ts` (new), factoring discovery/parse out of
`getStudioPackageBom`. Factor `collectInventory` to also run over a file list
(`web/lib/packages/attach.ts`). Tests: per-kind parsing over in-memory fixture
sources (flow compile, skill counts+desc, platform-agent routing, subagent
resolution, rule discovery, mcp id-only, malformed→id-only degradation).

**P1.2 (refactor, characterization)** Re-point `getStudioPackageBom` at
`buildPackageBom` via an installed `PackageSource`. Characterization test:
output for a fixture install is byte-identical to pre-refactor (snapshot).

**P1.3 (RED→GREEN)** `getLocalPackageBom(pkg): Promise<PackageBom>` in
`web/lib/local-packages/bom.ts` (new): build a local `PackageSource` from
`working_dir` (manifest parse + computed inventory + `listFiles`/`readFileContent`)
and call `buildPackageBom`. Add `isMcpDescriptorPath`. Tests over fixture working
dirs incl. nested-skill, legacy `agents/`, malformed manifest (PRECONDITION/empty).

**Logging:** DEBUG per-kind counts + per-element parse failures (id, reason).

**Exit:** unit suite green incl. characterization snapshot; `getStudioPackageBom`
behavior provably unchanged.

*Commit checkpoint:* `feat(studio): shared package BOM builder + local BOM`

### Phase 2 — Composition tabbed shell (frontend, TDD)

**P2.1 (RED→GREEN)** New `PackageComposition` (`web/components/studio/package-composition.tsx`)
reusing `PackageTabs` + `ElementCard` + `FlowPreviewCard`. Renders the 7 tabs with
counts from the local BOM; empty kinds hide their tab (Files always shown). Card
click routes: flow → canvas, skill → skill route, others → select inline (Phase 3).
i18n: add a `Files` tab key + reuse existing `viewer.*` keys; EN+RU parity.

**P2.2** Wire into the route: `/studio/edit/[id]/[[...path]]/page.tsx` computes
`getLocalPackageBom` and `LocalPackageEditor` renders `PackageComposition` as the
no-path landing instead of `PackageHome`. Preserve the manifest form + lock/
readOnly header. `PackageHome` is retired (or reduced to the manifest header
sub-component reused by the composition shell).

**Tests:** counts render; empty-tab hidden; readOnly gating; card-click routing
targets; tab state in URL (`?tab=`) for back/forward.

**Exit:** unit + component suite green; i18n parity check green.

*Commit checkpoint:* `feat(studio): tabbed composition landing for local packages`

### Phase 3 — Inline master-detail editing (agents/subagents/rules/mcp) (TDD)

**P3.1 (RED→GREEN)** Master-detail layout inside the Agents/Subagents/Rules/MCP
tabs: card list + side editor panel. Reuse `FrontmatterArtifactEditor`
(`agent_definition`/`subagent`/`rule`, source+preview) and `McpTemplateEditor`
(mcp). Selecting a card loads its file content from the already-loaded
`draftFiles`; `onChange` updates `draftFiles`; dirty + existing save persists.

**Tests:** editing an agent mutates `draftFiles` and saves via the existing
`PUT` (mocked fetch); readOnly disables inputs; switching cards preserves the
per-file draft; mcp routes to `McpTemplateEditor` via `isMcpDescriptorPath`.

**Exit:** suite green; save round-trip asserted.

*Commit checkpoint:* `feat(studio): inline master-detail editors in composition tabs`

### Phase 4 — Skill dedicated screen (TDD)

**P4.1 (RED→GREEN)** Route `/studio/edit/[id]/skills/<...>` → a dedicated skill
screen: a `PackageFilesEditor` **scoped to the `skills/<id>/` subtree** (nested
folders) + breadcrumb back to the composition Skills tab. `SKILL.md` opens in
`FrontmatterArtifactEditor` (skill kind). Edits persist through the same save
channel.

**Tests:** screen lists the skill's nested files only; SKILL.md edit persists;
breadcrumb navigates back; non-existent skill → not-found.

**Exit:** suite green.

*Commit checkpoint:* `feat(studio): dedicated skill screen with nested navigator`

### Phase 5 — Create artifacts (per-tab `+ Add <Kind>`) (TDD)

**P5.1 (RED→GREEN)** Pure scaffolders (`web/lib/local-packages/scaffold.ts`,
new) producing the exact file shape per kind into the draft set:
- flow → `flows/<name>.yaml` skeleton **+ `appendManifestFlow`** → navigate canvas
- skill → `skills/<name>/SKILL.md` frontmatter stub → navigate skill screen
- subagent → `capability/<cap>/agents/<name>.md` stub → inline. **The `<cap>`
  capability is chosen by the user** (a picker over existing capabilities); if
  exactly one capability exists, preselect it; if none exists, prompt the user to
  name/create one (no silent `capability/default`).
- agent → `maister-agents/<name>.md` stub → inline
- mcp → `mcps/<name>.yaml` stub → inline
- rule → `rules/<name>.md` stub → inline
Name input + collision validation (`CONFLICT` on existing path).

**P5.2** Wire `+ Add <Kind>` buttons on each tab; post-create navigation; dirty+save.

**Tests:** each scaffolder's exact path + stub content; flow scaffold appends
manifest; collision rejected; post-create selection/navigation.

**Exit:** suite green.

*Commit checkpoint:* `feat(studio): per-tab create-artifact scaffolders`

### Phase 6 — Rename identity (card `Rename <Kind>`) (TDD)

**P6.1 (RED→GREEN)** Per-kind identity rename (`web/lib/local-packages/rename-artifact.ts`,
new) on the flat draft list per **D8**: single-file rename; skill folder
prefix-rewrite (all children); flow file rename + manifest entry update. Card
`Rename` action with name input + collision check; metadata stays in the editor.

**Tests:** each kind renames identity; skill folder rename moves every child;
flow rename updates manifest id+path; collision → `CONFLICT`; frontmatter
untouched by rename.

**Exit:** suite green.

*Commit checkpoint:* `feat(studio): card-level identity rename per kind`

### Phase 7 — Files tab file-manager + batch import (TDD)

**P7.1 (RED→GREEN)** Files tab: raw tree (reuse `buildFileTree`) + **breadcrumbs**
+ collapsible folders + new file / new **virtual** folder (client-only, no
sentinel, per D7) + rename + delete + **drag-and-drop move** (rewrite path on the
draft list). All gated by readOnly.

**P7.2 (RED→GREEN)** Wire the shared **Import** button to the existing
`POST /api/studio/local-packages/{id}/import` (multipart, `mode=preview` →
confirm → `mode=commit`), using `webkitdirectory` + drop, index-aligned `paths[]`.
Surface the preview (entry list + caps: `importMaxEntries/Bytes/FileBytes`),
then commit; refresh BOM.

**Tests:** breadcrumb navigation; dnd move rewrites path in draft; new virtual
folder targets file placement without persisting/sentinel; delete removes file;
import preview lists entries and commit
calls the route with index-aligned paths (mocked fetch); cap-exceeded surfaces
the typed error.

**Exit:** suite green.

*Commit checkpoint:* `feat(studio): files-tab file manager + batch import wiring`

### Phase 8 — As-built docs sync + verification (mandatory docs checkpoint)

**P8.1** Flip Phase-0 `Designed` tags → `Implemented` in
`docs/system-analytics/local-packages.md`; finalize ADR-115 status; update the
`flow-studio.md` cross-ref. Confirm `database-schema.md` unchanged (no migration).
Route doc changes through `/aif-docs`.

**P8.2** Full verification: `pnpm --filter maister-web typecheck` (0),
`test:unit`, `test:integration` (real PG), `lint` (0 errors, check-only),
i18n EN+RU parity, `pnpm validate:docs:all` + `validate:docs:adr:all`, redocly
lint. E2E specs added where feasible (note: Next 16 holds a single-dev lock —
free :3000 to run them; static-only otherwise, documented).

*Commit checkpoint:* `docs(studio): flip local-package composition to Implemented`

---

## Commit Plan

1. Phase 0 → `docs(studio): ADR-115 + local-package composition analytics`
2. Phase 1 → `feat(studio): shared package BOM builder + local BOM`
3. Phase 2 → `feat(studio): tabbed composition landing for local packages`
4. Phase 3 → `feat(studio): inline master-detail editors in composition tabs`
5. Phase 4 → `feat(studio): dedicated skill screen with nested navigator`
6. Phase 5 → `feat(studio): per-tab create-artifact scaffolders`
7. Phase 6 → `feat(studio): card-level identity rename per kind`
8. Phase 7 → `feat(studio): files-tab file manager + batch import wiring`
9. Phase 8 → `docs(studio): flip local-package composition to Implemented`

(Commit messages omit the AI trailer per project preference.)

## Acceptance Criteria (rollup)

- Local editor landing is the 7-tab composition view; counts equal BOM lengths;
  empty kinds hide their tab; Files always present.
- Open model honored exactly (flow→canvas, skill→own screen, agent/subagent/
  mcp/rule→inline master-detail).
- `+ Add <Kind>` scaffolds the exact path shape (and manifest entry for flows)
  and navigates correctly; collisions rejected with `CONFLICT`.
- Card `Rename` rewrites identity only (folder rename moves all children; flow
  rename updates manifest); frontmatter untouched; collisions rejected.
- Files tab: breadcrumbs + collapsible folders + dnd move + new file + new
  virtual folder (no sentinel) + rename + delete; Import preview→commit through
  the existing route, confined + lock-gated + cap-enforced.
- No orphaned code: `PackageHome` and any helpers/tests its replacement orphans
  are deleted; Phase-8 dead-code sweep is clean.
- `getStudioPackageBom` output provably unchanged (characterization snapshot).
- readOnly (lock lost / no manage / assistant busy) disables every mutation.
- All new tests green via the correct runner; no trivial tests; minimal overlap;
  RED→GREEN history preserved per phase.
- Docs (ADR-115 + `local-packages.md` + `flow-studio.md`) complete, consistent,
  status-tagged Implemented; `validate:docs:all`, `validate:docs:adr:all`,
  redocly lint green. No DB migration; no OpenAPI route change.

## Resolved questions (owner, 2026-06-28)

1. **Skill screen** reuses `PackageFilesEditor` scoped to `skills/<id>/`. ✅
2. **Subagent create** prompts the user to pick the capability (preselect when
   exactly one exists; if none, prompt to name/create one). No silent default. ✅
3. **New folder** is virtual/client-only — **no `.gitkeep` sentinel** (local empty
   dirs are harmless; only push/cut cares). Empty-folder persistence, if ever
   needed, is a cut-version concern, out of scope. (D7) ✅
4. **`PackageHome` deleted**, manifest form reused in the composition header.
   Orphan cleanup is in-scope every phase + Phase-8 sweep (D9). ✅
5. **MCP convention `mcps/<name>.yaml`** confirmed; handled via a local
   `isMcpDescriptorPath` predicate (classifier stays `asset`). (D6) ✅
