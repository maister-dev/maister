# SDD Spec (FROZEN) — Flow Studio redesign · Phase 0 (SDD) + Phase A (IA & surfacing)

> **Status:** Phase-0 spec freeze. This is the **single source of truth** for the
> Phase A implementation. Every later deviation requires a spec amendment, never
> an ad-hoc code change. Plan:
> [`.ai-factory/plans/feature-flow-studio-redesign.md`](../plans/feature-flow-studio-redesign.md).
> Origin (TDD steps): [`docs/plans/2026-06-15-flow-studio-redesign.md`](../../docs/plans/2026-06-15-flow-studio-redesign.md).
> Surface SSOT: [`docs/screens/studio/README.md`](../../docs/screens/studio/README.md).
>
> At Phase-0 HEAD every Phase A piece is **(Designed)**; the §"Implementation
> status" tags flip to **(Implemented)** on Phase A merge. Phase B/C pieces stay
> **(Designed)** / **(Phase 2)** here — they get their own plans.
>
> Conventions inherited (non-negotiable): `MaisterError` taxonomy (no plain
> `Error` for domain failures; UI branches on `code`), EN+RU key parity, HeroUI v3
> + Tailwind 4 (NO new component lib, NO new dep), default Server Components (`"use
> client"` only for state/effects/browser), strict TS (no `any` without
> `// FIXME(any):`), `no-console` lint (server logging through the existing pino
> boundary / allowed `console.debug|warn|error` server-side; client surfaces state
> via UI). **No migration, no `db:generate`, no engine bump, no new `runs.status`,
> no new `MaisterError` code, no new HTTP/SSE route.**
>
> Branch: `claude/angry-chaum-31d223`. Baseline: `main @ 3546d62e`.
>
> **Grounding:** reuse-map anchors (§2) verified against code on 2026-06-15
> (`getAvailablePackageInstalls`/`getProjectPackageAttachments` in
> `lib/queries/packages.ts`; `getFlowPackageDetail` in
> `lib/queries/flow-packages.ts:317`; `PackageSourcesPanel` in
> `components/settings/package-sources-panel.tsx`, mounted on `/settings`; static
> `FlowGraphView` in `components/board/flow-graph-view.tsx`; `package-fork-button`
> in `components/flows/`; `/flows` page uses `requireSession` +
> `getPlatformFlows({userId,userRole,filters})` with per-project `canManageCatalog`;
> rail item `{ id: "flows", label: tNav("flows"), href: "/flows" }` at
> `components/chrome/left-rail.tsx:175`). The exact `package_installs` projection
> field names and the `/settings` package-slice loader name are confirmed in the
> Phase-1 grep steps (T1.2 Step 1, T1.5 Step 1) before they are relied on.
>
> **Amendment log:**
> - **2026-06-15 (Phase A completion):** §4 / §6 / Expectation 9.6 — the embedded
>   read-only `FlowGraphView` preview and inline fork on the package-detail surface
>   are project-scoped (need a compiled flow revision + `projectSlug`/`revisionId`)
>   and are deferred to **Phase B** (the editor redesign). Phase A ships the detail
>   as header + bill-of-materials (grouped by kind) + versions + gated nav actions
>   (Attach → board, Trust → `/studio/sources`); the per-project
>   `/projects/{slug}/packages/{flowRefId}` viewer retains the full graph/fork. The
>   board "Open in Studio" deep-link lives on `project-packages-section` (ADR-088
>   by-name attachments), not `flow-packages-panel` (flow-ref-keyed). Studio reads
>   use a new `getStudioPackageInstalls` projection (`sourceUrl` + per-kind counts;
>   `rules` not inventoried → 0) since the existing DTO is too thin.
> - **2026-06-15 (owner follow-ups on the open questions):** §9.1 / §9.4 — the
>   `/flows` **landing** is deleted (the editor sub-routes `/flows/{slug}/{capId}`
>   + `/flows/new` stay until Phase B relocates them to `/studio/edit`), and the
>   Sources panel is **removed from `/settings`** (now only at `/studio/sources`).
>   Owner accepted the authored-draft browse-home gap until Phase C (`/studio/local`)
>   — no critical installs/users yet. Open questions resolved: editor route → in
>   Studio (`/studio/edit`, Phase B); `ref` = name (sufficient for now); milestone →
>   link to M27.

---

## 1. Purpose & scope

Replace the unbalanced, flows-only `/flows` page with a unified **Studio**
section. **Phase A** ships the information architecture and the view/check
surfaces over the *existing* backend; it is the foundation the editor redesign
(**Phase B**) and the editable-local-package backend (**Phase C**) build on.

The four concrete defects Phase A fixes (from the design SSOT §"Why"):

1. **Unbalanced, flows-only landing.** `/flows` is a two-column grid (drafts |
   installed flows); one draft drowns in whitespace, six flow cards overflow.
2. **Flow ≠ package conflation.** "Installed packages (6)" actually lists five
   flows from one `aif` package + one `bugfix` flow; nothing groups by package.
3. **No unified home.** Adding a git source, installing, attaching, browsing, and
   authoring live in four different places (admin Settings · board tab · package
   viewer · `/flows`).
4. **Authoring is flow-only and project-scoped.** Only `kind=flow` has a create
   form + editor; there is no instance-level "local artifacts" space.

Phase A directly resolves #1, #2, #3 (unified shell + package-grouped list +
merged detail). #4 is the Phase B/C direction recorded here as **(Designed)**.

### Out of scope (separate plans — do NOT implement in Phase A)

- **Phase B — editor redesign** (the big-canvas Heym-style editor: node visual
  scheme, named-outcome handles, properties panel, top-bar drawers, hideable
  rail). Phase A's read-only preview reuses the **current** `FlowGraphView`
  rendering — NOT the new node-visual scheme (§6 is (Designed)).
- **Phase C — editable local packages (Variant B)** + standalone artifact kinds +
  move-to-package + cut-version. NEW backend (`local_packages` table + working
  dir); not touched in Phase A.
- **Write-back to a git source** (push an upstream tag) — **(Phase 2)**.

---

## 2. Reuse map (build on, do NOT rebuild)

Phase A is frontend-over-existing-reads. Every backend read and panel below is
**(Implemented)**; Phase A only wraps/relocates/links them.

| Capability | Reused symbol (verified 2026-06-15) | Phase A use |
|---|---|---|
| Installs read | `web/lib/queries/packages.ts` `getAvailablePackageInstalls()` (`:92`) | source rows for `groupPackages` |
| Attachments read (per project) | `web/lib/queries/packages.ts` `getProjectPackageAttachments(projectId)` (`:39`) | gathered across visible projects → `attachedProjectCount` |
| Package detail read | `web/lib/queries/flow-packages.ts` `getFlowPackageDetail(...)` (`:317`) | (optional) richer BoM on package detail; manifest BoM is derived at the page |
| Sources admin panel | `web/components/settings/package-sources-panel.tsx` `PackageSourcesPanel` (mounted in `app/(app)/settings/page.tsx`) | mounted unchanged at `/studio/sources` (admin); `/settings` copy left intact |
| Static graph preview | `web/components/board/flow-graph-view.tsx` `FlowGraphView` (run-coupled via `runContext?`; static when absent) + `flow-graph-view-section.tsx` | read-only preview on package detail (NO `runContext`) |
| Fork action | `web/components/flows/package-fork-button.tsx` | "Fork to local / Rework" on installed package detail |
| Auth | `web/lib/authz.ts` `requireSession`, `requireGlobalRole("admin")`, project `manageCatalog` | overview/packages/detail = member with `manageCatalog` on ≥1 project; sources = global admin |
| Page chrome | `/flows` + `/mcps` page-bar pattern (eyebrow + `<h1>`) | reused for every `/studio/*` page header |
| Board config panel | `web/components/board/panels/flow-packages-panel.tsx` | gains an "Open in Studio" deep-link (config stays on the board) |
| Rail | `web/components/chrome/left-rail.tsx` nav item `{id:"flows", href:"/flows"}` (`:175`) | repointed to `/studio` + `nav.studio` label |

**Reused symbols are (Implemented).** Phase A only wires/relocates/links them.

---

## 3. Domain model (deltas)

### 3.1 DB schema — **NO DDL. NO MIGRATION. NO `db:generate`.**

Phase A adds **zero** tables, columns, indexes, or constraints. Every read reuses
the existing `package_sources` / `package_installs` /
`project_package_attachments` / `authored_capabilities` tables. The honest "DB
artifact" is a **read surface map**, not DDL:

| Table | Column (read) | Phase A use |
|---|---|---|
| `package_installs` | `id`, `sourceUrl`, `name`, `version`, `trustStatus`, `manifest` (jsonb) | grouped by `(sourceUrl,name)`; member-kind counts from `manifest`; trust badge (exact projected names confirmed in T1.2 Step 1) |
| `project_package_attachments` | `packageInstallId`, `projectId` | `attachedProjectCount` per group |
| `authored_capabilities` | (draft list) | overview "drafts" count only (read) |

### 3.2 The derived view model — `PackageGroup` (pure, client-safe)

The single Phase-A shape, produced by the pure shaper
`web/lib/studio/group-packages.ts` `groupPackages({installs, attachments})`:

```ts
type PackageGroup = {
  key: string;                 // `${sourceUrl}::${name}`
  name: string;
  sourceUrl: string;
  isLocal: boolean;            // file: source or local-* marker
  needsTrust: boolean;         // any version untrusted
  versions: { installId: string; version: string; trustStatus: string }[]; // newest-first
  counts: { flows: number; skills: number; agents: number; mcps: number; rules: number };
  attachedProjectCount: number;
};
```

- `groupPackages` is **pure** (no I/O, no logging) → fully unit-tested.
- The package-detail **`bom`** (artifacts grouped by kind) is derived from the
  newest install's `manifest` **at the page**, NOT added to `PackageGroup`
  (single-shape discipline).

---

## 4. Information architecture & surfaces

The rail's **"Flows"** item becomes **"Studio"** (`/studio`). Studio is a
member-level surface for anyone with `manageCatalog` on ≥1 project; **Sources**
stays global-admin-gated.

| Route | Screen | Scope | Phase | Phase A status |
|---|---|---|---|---|
| `/studio` | Overview (at-a-glance + area cards + needs-attention) | member | A | (Designed→Implemented) |
| `/studio/sources` | Sources + discovery + install (relocated `PackageSourcesPanel`) | admin | A | (Designed→Implemented) |
| `/studio/packages` | Packages list, grouped by package | member | A | (Designed→Implemented) |
| `/studio/packages/{ref}` | Package detail (BoM · read-only preview · versions · attach · fork) | member | A | (Designed→Implemented) |
| `/studio/edit/{...}` | Artifact editor (big-canvas redesign) | member | **B** | (Designed) |
| `/studio/local` | Local / virtual package | member | **C** | (Designed) |

- `/flows` route file is **kept** (legacy, unlinked) in Phase A — removed/redirected
  only after Studio reaches parity (open question, deferred).
- Config vs content split: attach/detach/upgrade/trust/enable stays on the board
  `?tab=packages`; Studio owns content. They are joined by an "Open in Studio"
  deep-link from each attached package (T1.8) and a project filter in Studio.

The locked model (from the design SSOT §"The model"): one unified Studio ·
**editable local package is the spine** (Variant B, Phase C) · config-vs-content
split · standalone artifact kinds (Phase C) · move-to-package (Phase C) · git
write-back (Phase 2). Phase A surfaces the IA; the editable-local-package backend
is **(Designed)**, built in Phase C.

---

## 5. Identifier trust-boundary table (skill-context: "body-controlled → server-state")

Phase A routes are all GET **page reads** (RSC). Labels: **U**=url-param,
**A**=auth-context, **S**=server-state, **B**=body-controlled.

| Surface | Identifier | Label | Handling |
|---|---|---|---|
| `/studio/packages/[ref]` | `ref` | **U** | `decodeURIComponent` → resolved against **server-state** (`loadStudioPackages(viewer.id)` group set) by `name`; **NEVER** used as a filesystem path. Cross-source name collision → render a disambiguation list (no fs access from `ref`). |
| `/studio/sources` | viewer role | **A** | `requireGlobalRole("admin")` is the route's authz boundary. |
| `/studio/*` (all) | viewer id | **A** | `requireSession()`; `manageCatalog` resolved from server-state project rows, never a body field. |

No `body-controlled` cross-resource identifiers are added — every Phase A route is
a GET page read; the existing fork POST (reused unchanged) keeps its own
contract. `ref = name` is sufficient for Phase A; a durable
`base64url(source::name)` encoding is an open question deferred to Phase B if
collisions bite.

---

## 6. Node visual language (icons + colors) — **(Designed; implemented in Phase B)**

Recorded here as frozen direction; Phase A's preview uses the **current**
`FlowGraphView` rendering, so this scheme is **(Designed)**, not Implemented in
Phase A. Canonical copy lives in the design SSOT
([`docs/screens/studio/README.md`](../../docs/screens/studio/README.md)
§"Node visual language") and (on Phase B) in `flow-studio.md`. Hues bind to the
existing dark/green token palette (roles, not hex).

| Node type | Icon | Color role |
|---|---|---|
| `ai_coding` | bot / sparkle | teal |
| `judge` | gavel | violet |
| `cli` | terminal `>_` | slate |
| `check` | shield-check | amber |
| `human` | person | magenta |

| Gate kind | Icon | Color |
|---|---|---|
| `command_check` | `>_` | slate |
| `skill_check` | puzzle | green |
| `ai_judgment` | gavel | violet |
| `artifact_required` | file | blue |
| `external_check` | link | cyan |
| `human_review` | person | magenta |

- Blocking gate → **solid** chip; advisory → **outline** chip.
- Default outcome edge → solid; **rework / back-edge → dashed + amber** with the
  outcome label drawn on the edge.
- Run/preview status keeps the existing `FlowGraphView` coloring; the static
  editor canvas has no status ring.

---

## 7. Contract-surface ledger (skill-context: "trace every contract surface to its spec file")

Phase A is frontend-over-existing-reads. Recorded as mostly "none — reason" so
`/aif-verify` can re-derive the same set from the diff and confirm nothing leaked.

| Surface class | Changes in Phase A? | Spec file / reason |
|---|---|---|
| HTTP route (path/method/status/body) | **No** | New `/studio/*` are RSC **page routes** (RSC reads + page params), documented as screens, NOT OpenAPI — ADR-066 RSC-reads precedent (mirrors the `/projects/{slug}/packages/{flowRefId}` viewer). No `docs/api/web.openapi.yaml` change. |
| SSE / WebSocket event | **No** | No new stream. |
| New domain error code | **No** | Reuses `UNAUTHORIZED` (admin gate) + existing not-found. No `docs/error-taxonomy.md` change. |
| New env var / config path | **No** | No new env. No `docs/configuration.md` / `.env.example` change. |
| New DB column / table / index | **No** | No migration. No `docs/database-schema.md` / `docs/db/*.md` change. |
| New `package.json` script / CLI | **No** | None. |
| New Flow DSL step type / field | **No** | None. |
| Screen surface (route, layout, roles) | **Yes** | `docs/screens/studio/*` + index in `docs/screens/README.md` + glossary in `docs/CLAUDE.md`. |
| system-analytics behavior | **Yes** | `docs/system-analytics/flow-studio.md` (Studio-redesign section, status tags). |
| Architectural decision | **Yes** | ADR-092 in `docs/decisions.md` (unified-Studio IA + editable-local-package *direction*). |

## 8. Deployment touchpoints (skill-context: "enumerate deployment touchpoints")

**None in Phase A.** No new env var, runtime config file, sidecar binary, or bound
port → no `Dockerfile` / `compose*.yml` / `.env.example` change. Stated explicitly
so the absence is intentional, not an omission.

---

## 9. Expectations (normative, testable)

1. The rail's primary catalog item MUST link `/studio` and read its label from
   `nav.studio` (EN "Studio" / RU "Студия"). The `/flows` **landing** is removed
   (amendment log); the editor sub-routes (`/flows/{slug}/{capId}`, `/flows/new`)
   remain until Phase B.
2. `groupPackages` MUST group installs by `(sourceUrl, name)`, order each group's
   `versions` newest-first, count member artifacts by kind from the newest
   install's `manifest`, set `isLocal` for `file:`/`local-*` sources, set
   `needsTrust` when any version is untrusted, and compute `attachedProjectCount`
   from the attachments — as a **pure** function (no I/O).
3. `/studio` MUST render a count strip + area cards (`/studio/packages`,
   `/studio/local`, and `/studio/sources` ONLY when the viewer is global admin) +
   a needs-attention list of `needsTrust` groups; it MUST NOT render the old
   two-column flow dump.
4. `/studio/sources` MUST enforce `requireGlobalRole("admin")` as the route authz
   boundary; a member MUST receive `UNAUTHORIZED`. The Sources panel is **removed
   from `/settings`** (relocated — now only at `/studio/sources`; amendment log).
5. `/studio/packages` MUST render exactly one row per `PackageGroup` (name ·
   source · newest version · trust · member-kind chips · attached count · `Local`
   badge) linking `/studio/packages/${encodeURIComponent(name)}`.
6. `/studio/packages/[ref]` MUST decode `ref`, resolve it against the
   server-state group set by `name`, render a BoM grouped by kind + versions +
   gated actions, and MUST NEVER use `ref` as a filesystem path; a cross-source
   name collision MUST render a disambiguation list. (The embedded read-only
   `FlowGraphView` preview + inline fork are deferred to Phase B — amendment log.)
7. Management actions (Trust, Fork/Rework) MUST be gated: Trust visible only to
   global admin (`canTrust`); manage actions only with `canManage`
   (any-project `manageCatalog`).
8. The board `flow-packages-panel` MUST gain a per-package "Open in Studio"
   deep-link to `/studio/packages/${encodeURIComponent(name)}`; package config
   (attach/detach/upgrade/trust) MUST stay on the board.
9. EN and RU message catalogs MUST both carry the full `studio` namespace + the
   `nav.studio` key (key parity); `web/messages/ru.json` MUST remain valid JSON.
10. Phase A MUST add NO migration, NO new HTTP/SSE route, NO new `MaisterError`
    code, NO new env var; every contract-surface ledger row marked "No" MUST
    hold against the diff.

---

## 10. Edge cases

| Case | Handling |
|---|---|
| `ref` name shared by two sources | disambiguation list at `/studio/packages/[ref]` (no fs access; logged `WARN [studio.packageDetail] ambiguous ref`) |
| install with no `manifest` | counts default to 0; row still renders |
| viewer with `manageCatalog` on 0 projects | overview shows packages/local cards but no needs-attention manage actions; sources card hidden unless global admin |
| local/virtual package in the install set | badged `Local`; appears in the packages list (Phase A read-only; editing is Phase C) |
| `/flows` opened directly | still renders (legacy route kept); not linked from the rail |

---

## 11. Spec-to-test matrix (acceptance → named test)

Runnability: unit files are `*.test.ts(x)` under `web/lib/studio/**` /
`web/components/studio/**` (web Vitest project, `renderToStaticMarkup`, no jsdom);
e2e under `web/e2e/`, registered in `AUTHED_SPEC`. Prove each new file with
`vitest list` per phase (skill-context: no dead tests).

| # (Expectation) | Acceptance | Test (project · file) |
|---|---|---|
| 9.2 | group by (sourceUrl,name); newest-first; counts; isLocal; needsTrust; attachedProjectCount | unit · `lib/studio/group-packages.test.ts` (3) |
| 9.3 | overview counts + needs-attention; Sources card admin-only | unit · `components/studio/overview-cards.test.tsx` (2) |
| 9.5 | one row per package + detail link + Local badge | unit · `components/studio/packages-list.test.tsx` |
| 9.6 / 9.7 | BoM by kind + fork action; Trust hidden for non-admin | unit · `components/studio/package-detail.test.tsx` (2) |
| 9.1 / 9.8 / nav-path | rail→/studio; overview count; packages→aif; detail BoM; sources admin | e2e · `web/e2e/studio.spec.ts` |
| 9.4 | `/studio/sources` admin gating | (mirror the `/mcps` admin-gating test if present) |
| 9.9 | EN/RU `studio` + `nav.studio` parity | i18n parity test (kept green) |

---

## 12. Implementation status

All Phase A pieces (§4 routes overview/sources/packages/package-detail, §3.2
shaper, §9 expectations) are **(Implemented)**. The package-detail **embedded
read-only preview + inline fork** are project-scoped and deferred to **Phase B**
(amendment log) — Phase A ships header + BoM + versions + gated nav actions. §6
node-visual scheme, `/studio/edit`, `/studio/local`, editable-local-package
backend, standalone artifact kinds, move-to-package: **(Designed)** (Phase B/C).
Git write-back: **(Phase 2)**.

**Cross-cutting compliance ledger (project aif-plan skill-context):**
HTTP identifiers labeled (§5 — all GET page reads, one `url-param` `ref` resolved
against server-state); two-phase/atomicity = N/A (no state-changing route added);
trust/execution separation = N/A (no exec; fork reused unchanged); fan-out = no
new `runs.status`/enum; config-state symmetry = N/A (no YAML→DB sync); deployment
touchpoints = none (§8); contract surfaces → spec files (§7); test integrity =
§11 (no dead tests, `renderToStaticMarkup`, `AUTHED_SPEC` registration).

---

## 13. Phasing & sequencing (A → B → C)

- **Phase A — Studio shell & surfacing** (this spec). Unified home · sources ·
  packages-grouped · package-detail with read-only preview. Over existing
  backend; no migration. Fixes defects #1–#3.
- **Phase B — Editor usability** (own plan): the storage-agnostic big-canvas
  editor redesign behind a small load/save seam — node visual scheme (§6),
  named-outcome handles, dashed rework edges, properties panel, top-bar drawers,
  hideable rail. The read-only twin is Phase A's package-detail preview.
- **Phase C — Editable local packages (Variant B)** (own plan; NEW backend): a
  `local_packages` table pointing at a mutable working dir; "cut version" runs the
  existing installer → `local-<digest>` `package_installs`; standalone artifact
  kinds; move-to-package; the editor's package-coupled half (Files drawer,
  cross-artifact pickers, "new artifact", cut-version). Plus `/studio/local`.
