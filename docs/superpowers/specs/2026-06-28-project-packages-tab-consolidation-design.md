# Project Packages Tab Consolidation — Design

- **Date:** 2026-06-28
- **Status:** Approved (brainstorm) — pending written-spec review
- **Scope:** `web/` UI + queries only. No `supervisor/`, no DB migration, no
  API/contract change, no new ADR.

## Problem

A project's detail page (`/projects/[slug]`) has two tabs — **Flows** and
**Packages** — that surface the same installed flow-packages through different,
redundant components:

- The **Flows** tab (`flows-panel.tsx`) shows weak cards whose links are broken
  (they navigate via `flow.ref`, which mismatches the per-flow viewer's
  `flowRefId`), and an out-of-place "New Flow" button.
- The **Packages** tab carries a redundant **Flow Packages** section
  (`flow-packages-panel.tsx`) with an Install button and per-card Upgrade/Disable
  affordances the owner considers useless.
- An attached package's name links to a bespoke project-scoped viewer
  (`/projects/[slug]/package-installs/[id]`) that duplicates — more poorly — the
  richer Studio package view (`/studio/packages/[name]`).

## Goal

One **Packages** tab. Drop the Flows tab. Keep the good attached-packages list,
add project-owned local packages as rows, replace the ugly Flow-Packages cards
with rich per-package contents (flow cards + an element-count line), and route
package-level detail to the existing Studio view.

## As-is (key references)

- `components/board/project-tabs.tsx` — `TABS` includes both `flows` and
  `packages`.
- `app/(app)/projects/[slug]/page.tsx` — `tab==="flows"` → `FlowsPanel`;
  `tab==="packages"` → `ProjectPackagesSection` + `FlowPackagesPanel`.
- `components/board/panels/flows-panel.tsx` — weak flow cards (broken `flow.ref`
  links).
- `components/board/panels/flow-packages-panel.tsx` — redundant card list +
  Install + per-card Upgrade/Disable.
- `components/board/panels/project-packages-section.tsx` — the **kept** table;
  package name → `/projects/[slug]/package-installs/[att.id]` (L202),
  "Open in Studio" → `/studio/packages/[name]` (L228).
- `app/(app)/projects/[slug]/package-installs/[attachmentId]/page.tsx` — bespoke
  project viewer (flat lists; a project-scoped "restrictions" block).
- `app/(app)/projects/[slug]/packages/[flowRefId]/page.tsx` — **good** project
  per-flow viewer (graph + flow.yaml + file tree + revisions + runner bindings +
  fork). **Kept.**
- `components/studio/package-detail.tsx` — holds `FlowPreviewCard` (rich,
  currently NOT exported) + uses `ElementCard`.
- Data: `getProjectPackageAttachments(projectId)`, `getStudioPackageBom(installId)`
  (`PackageBom` = flows/skills/agents/subagents/mcps/rules; reads `installed_path`
  off disk, compiles flow graphs). Local packages: `localPackages` table
  (`projectId` nullable, `isDefault`), `/studio/local`, `/studio/edit/[id]`.
- **Gap confirmed:** there is **no BOM compiler for local packages** — their
  contents exist only as a working-dir file tree (the editor reads files, not
  compiled flow/skill/agent items).

## To-be

### Packages tab structure (single tab; `flows` tab removed)

1. **§ Attached packages** — `ProjectPackagesSection`, unchanged except the
   package-name link target moves from `/projects/[slug]/package-installs/[id]`
   → `/studio/packages/[encodeURIComponent(name)]`. The now-duplicate
   "Open in Studio" action is folded into the name link (final placement decided
   in the plan).

2. **§ Local packages** (NEW) — project-owned local packages
   (`localPackages WHERE projectId = project AND status = 'active'`), rendered as
   **rows only**: name + "Local" badge + origin (`forked from <pkg>@<v>` / `local`)
   + Edit → `/studio/edit/[id]`. Empty → omit the subsection. **No inline
   contents cards** (the working-dir BOM compiler is intentionally out of scope).

3. **§ Contents** (NEW — replaces `FlowPackagesPanel`) — grouped **per attached
   package**. Each block:
   - Header: `<package> @ <version>` + **View in Studio →** (`/studio/packages/[name]`).
   - **Flow cards:** `FlowPreviewCard[]` from the package BOM (graph thumbnail +
     frontmatter). Each card's *View* → the project per-flow viewer
     `/projects/[slug]/packages/[flowRefId]` (resolved flow id — fixes the old
     broken link).
   - **Element-count line** (counts only, no cards): non-zero kinds among
     `skills · agents · subagents · mcps · rules`, e.g. `27 skills · 5 agents · 2 MCPs`.
     Drill-down is the block-header *View in Studio* link.
   - No Install button; no Upgrade/Disable on cards.

### Deletions

- `components/board/panels/flows-panel.tsx` + its page render branch + the
  `flows` entry in `TABS` + its tab-label i18n key.
- `components/board/panels/flow-packages-panel.tsx` + its render branch. Verify
  `getFlowPackages` has no other consumer before removing it.
- `app/(app)/projects/[slug]/package-installs/[attachmentId]/` route. Its only
  inbound link (`project-packages-section.tsx` L202) is repointed to Studio. The
  project-scoped "restrictions" block it rendered is dropped (Studio view is
  global and does not show it) — accepted by owner.

### New / changed code

- Export `FlowPreviewCard` (extract to `components/studio/flow-preview-card.tsx`
  or export from `package-detail.tsx`); parametrize its *View* href so it can
  point at the project per-flow viewer here vs the Studio flow viewer in Studio.
- Queries:
  - `getProjectLocalPackages(projectId)` → active project-owned local packages,
    with origin resolved via `listSourceInstallsForLocalPackages`.
  - `getProjectPackageContents(projectId)` → per attachment:
    `{ packageName, versionLabel, flows: PackageBomFlow[], counts: { skills, agents, subagents, mcps, rules } }`,
    built from `getStudioPackageBom(packageInstallId)` per attachment
    (parallelized); counts = BOM array lengths.
- Components: `components/board/panels/project-local-packages.tsx` (rows) +
  `components/board/panels/project-package-contents.tsx` (per-package blocks).
- `app/(app)/projects/[slug]/page.tsx` — packages branch renders
  `[ProjectPackagesSection, ProjectLocalPackages, ProjectPackageContents]`;
  remove the flows branch and `FlowPackagesPanel`.
- i18n: EN + RU for every new string (repo enforces key parity).

### Out of scope

- No working-dir BOM compiler for local packages (local = rows only).
- No backend / contract / migration changes; attach/trust/upgrade/detach
  untouched.
- No new "attach a local package to a project" mechanism — surface existing
  project-owned locals only.
- MCPs / rules / subagents are not rendered as cards on the project tab
  (count line + Studio link).

## Risks / notes

- **Perf:** `getStudioPackageBom` reads disk + compiles flow graphs per package;
  N (attached packages) is small per project — parallelize per-attachment calls.
- **Flow id:** the flow card *View* must use the id that
  `getFlowPackageDetail(slug, flowRefId)` resolves (likely `PackageBomFlow.id`),
  not `flow.ref` (the old broken link). Confirm during the plan.
- **Studio access:** `/studio/packages/[name]` is `requireSession` (member-OK),
  so routing non-admin project members there is safe.
- **i18n parity:** EN/RU enforced by the repo i18n check.

## Verification

- **Unit:** `getProjectLocalPackages` (origin, active filter), `getProjectPackageContents`
  (counts, empty package, missing-bundle degrade).
- **E2E:** packages tab shows attached list + local subsection + per-package flow
  cards + count line; no Flows tab; package-name → Studio; flow card *View* →
  project per-flow viewer; old `/package-installs/[id]` route gone (404).
- **Gates:** `tsc` 0, `eslint` 0, unit green, i18n parity, e2e.
