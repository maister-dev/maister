# Implementation Plan: Flow Studio Redesign — Phase 0 (SDD) + Phase A (IA & surfacing)

Branch: claude/angry-chaum-31d223
Created: 2026-06-15

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement; SDD analytics-first per skill-context

## Roadmap Linkage
Milestone: "none"
Rationale: Cross-milestone initiative (lineage M27 Flow Studio / M33 Packages / M34 Agents). A dedicated milestone (e.g. M35 "Flow Studio redesign") belongs in `/aif-roadmap`, which owns ROADMAP.md; this plan does not write it.

## Grounding & sources
- **Design SSOT (surface):** [`docs/screens/studio/README.md`](../../docs/screens/studio/README.md) — IA, the editable-local-package model, node icon/color scheme, six surfaces, AS-IS→TO-BE map.
- **Origin plan (detailed TDD steps):** [`docs/plans/2026-06-15-flow-studio-redesign.md`](../../docs/plans/2026-06-15-flow-studio-redesign.md). Phase 1 tasks below cite its task numbers for the exact failing-test/impl/commit code rather than duplicating it (DRY).
- **Why this plan exists separately:** it adds the project's mandatory SDD discipline — a docs-first **Phase 0** that completes the analytics/spec SSOT *before* any code, plus the contract-surface ledger, identifier trust-boundary table, and per-task logging required by `.ai-factory/skill-context/aif-plan/SKILL.md`.

## Scope boundary
This plan delivers **Phase 0 (SDD docs) + Phase A (Studio IA + surfacing over existing backend)** — it ships a unified Studio (home · sources · packages list · merged package-detail with read-only preview) and **adds NO migration, NO new backend, NO new HTTP route**. The **editor redesign (Phase B)** and the **editable-local-package backend + standalone artifact kinds + move-to-package (Phase C)** are deferred to their own plans, sequenced **A → B → C** (see "Phasing & sequencing"). Phase C's data model is **locked to Variant B** — a `local_packages` table backed by a working directory.

---

## Contract-surface ledger (skill-context: "trace every contract surface to its spec file")

Phase A is frontend-over-existing-reads. The ledger is deliberately mostly "none — reason", recorded so `/aif-verify` can re-derive the same set from the diff and confirm nothing leaked.

| Surface class | Changes in Phase A? | Spec file / reason |
| --- | --- | --- |
| HTTP route (path/method/status/body) | **No** | New `/studio/*` are RSC **page routes** (RSC reads + page params), documented as screens, NOT OpenAPI — ADR-066 RSC-reads precedent (mirrors the `/projects/{slug}/packages/{flowRefId}` viewer). No `docs/api/web.openapi.yaml` change. |
| SSE / WebSocket event | **No** | No new stream. |
| New domain error code | **No** | Reuses `UNAUTHORIZED` (admin gate) + existing `NotFound`. No `docs/error-taxonomy.md` change. |
| New env var / config path | **No** | No new env. No `docs/configuration.md` / `.env.example` change. |
| New DB column / table / index | **No** | No migration. No `docs/database-schema.md` / `docs/db/*.md` change. |
| New `package.json` script / CLI | **No** | None. |
| New Flow DSL step type / field | **No** | None. |
| Screen surface (route, layout, roles) | **Yes** | `docs/screens/studio/*` + index in `docs/screens/README.md` + glossary in `docs/CLAUDE.md`. |
| system-analytics behavior | **Yes** | `docs/system-analytics/flow-studio.md` (Studio-redesign section, status tags). |
| Architectural decision | **Yes** | New ADR in `docs/decisions.md` (unified-Studio IA + editable-local-package *direction*). |

## Deployment touchpoints (skill-context: "enumerate deployment touchpoints")
**None in Phase A.** No new env var, runtime config file, sidecar binary, or bound port → no `Dockerfile` / `compose*.yml` / `.env.example` change. Stated explicitly so the absence is intentional, not an omission.

## Identifier trust-boundary table (skill-context: "body-controlled → server-state")
Phase A introduces exactly one new request-derived locator:

| Surface | Identifier | Label | Handling |
| --- | --- | --- | --- |
| `/studio/packages/[ref]` page | `ref` | `url-param` | Resolved against **server-state** (`loadStudioPackages(viewer.id)` group set), never used as a filesystem path. Cross-source name collision → render a disambiguation list (no fs access from `ref`). |
| `/studio/sources` page | viewer role | `auth-context` | `requireGlobalRole("admin")` is the route's authz boundary. |

No `body-controlled` cross-resource identifiers are added (all Phase A routes are GET page reads; the existing fork POST is unchanged).

## Test-integrity acceptance (skill-context: "make test-runnability + per-phase green explicit")
- **Runnability.** Unit tests are `*.test.ts(x)` under `web/lib/studio/**` and `web/components/studio/**`, executed by the web Vitest project (`renderToStaticMarkup`, no jsdom). Confirm the glob matches with `pnpm --filter maister-web exec vitest list lib/studio components/studio` before relying on a test as a deliverable. The e2e `web/e2e/studio.spec.ts` MUST be added to the `AUTHED_SPEC` regex in `web/playwright.config.ts` or it will not run authenticated.
- **Per-phase green checkpoint.** Each phase exits with `pnpm --filter maister-web exec vitest run` green (unit + the studio integration gate, if added) and, for Phase 1/2, `playwright test studio.spec.ts` green. A test a phase touches that is left red fails the phase.
- **Assertion migration is in-scope (Phase 1, T1.1).** The nav rename (`/flows`→`/studio`) may break tests asserting the rail's Flows label/href. Enumerate before editing: `grep -rn "/flows\|nav.flows\|Флоу" web/**/*.test.* web/e2e` and migrate the assertions IN T1.1. The `/flows` page route is **kept** (legacy, unlinked) so its page tests stay valid.

---

## Commit Plan
- **Commit 1** (Phase 0, T0.1–T0.5): `docs(studio): SDD spec + analytics + ADR + screens index for Flow Studio redesign`
- **Commit 2** (T1.1–T1.3): `feat(web): /studio route group, nav rename, package-grouping shaper + loader`
- **Commit 3** (T1.4–T1.5): `feat(web): Studio overview + sources surfaces`
- **Commit 4** (T1.6–T1.7): `feat(web): Studio packages list + merged package detail`
- **Commit 5** (T1.8, T2.1–T2.2): `feat(web): board deep-link + i18n + e2e; flip docs to Implemented`

---

## Tasks

### Phase 0 — Analytics / SDD first (MUST be complete & internally consistent BEFORE any Phase 1 code)

> skill-context rule: "Analytics is an INPUT to implementation, not a trailing sync task." Phase 0 freezes the SSOT the code follows. Phase-0 exit gate: `pnpm validate:docs:all` green AND every described piece carries an Implemented/Designed/Phase-2 tag (R6) AND the contract-surface ledger above is reflected in the spec.

- [x] **T0.1 — Author the SDD spec (frozen SSOT).**
  - Files — Create: `.ai-factory/specs/feature-flow-studio-redesign.md`.
  - Content: problem (the four `/flows` defects), the locked model (unified Studio · editable-local-package spine · config-vs-content split · standalone artifacts · move-to-package · git write-back = Phase 2), the node icon/color scheme, the six surfaces, the Phase A vs B/C status split, and **embed the three ledgers above** (contract-surface, deployment, identifier). Tag every piece Implemented (post-merge) / Designed / Phase 2 (R6). Match the style of `.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md`.
  - Logging: n/a (doc).
  - Verify: spec is internally consistent with `docs/screens/studio/README.md`; no piece describes code that won't exist at Phase-A HEAD.

- [x] **T0.2 — Wire the screens design into the index.**
  - Files — already created: `docs/screens/studio/README.md` (area design); Modify: `docs/screens/README.md` (index row added — confirm), `docs/CLAUDE.md` (add a screen-reference glossary row for `screens/studio/README.md`).
  - Note: per the screens contract ("each screen work-item updates its screens doc in the same phase that ships the screen"), the **per-screen template files** (`studio/overview.md`, `sources.md`, `packages.md`, `package-detail.md`, `editor.md`, `local-workspace.md`) are authored/flipped to Implemented as each screen ships (T2.1) — the comprehensive area README is the Phase-0 surface SSOT.
  - Logging: n/a. Verify: `pnpm validate:docs` green.

- [x] **T0.3 — Update system-analytics behavior doc.**
  - Files — Modify: `docs/system-analytics/flow-studio.md` — add a "Studio redesign" section: the IA, the config-vs-content split, and the editable-local-package model as the **Designed** direction; mark Phase A surfaces Implemented-on-merge, B/C Designed/Phase 2. Cross-ref `packages.md` + `agents.md` (R7, link don't restate).
  - Logging: n/a. Verify: R5 structure intact; `pnpm validate:docs` green; ADR anchors resolve.

- [x] **T0.4 — Record the ADR.**
  - Files — Modify: `docs/decisions.md` — append the next sequential ADR: "Flow Studio redesign — unified Studio IA + editable-local-package model". Decision: unify the scattered surfaces into `/studio/*`; adopt the editable local package as the editing spine (Accepted for the IA/Phase-A surfacing; the local-package backend is **Designed**, built in Phase C). Cite ADR-088/067-070/075/064.
  - Logging: n/a. Verify: `node scripts/validate-docs-adr-anchors.mjs` (run via `pnpm validate:docs`) resolves the new anchor.

- [x] **T0.5 — Phase-0 consistency gate.**
  - Run: `pnpm validate:docs:all`. Expected: all mermaid + ADR anchors pass. Confirm the spec, screens README, analytics doc, and ADR agree on the model and the Phase A/B/C split. Commit 1.

### Phase 1 — Studio IA + surfacing (Phase A; no migration, no new backend)

> For each task: the exact failing-test → impl → commit code is in the origin plan `docs/plans/2026-06-15-flow-studio-redesign.md` (cited task IDs). This plan adds the logging + identifier + runner requirements. All tests run in the web Vitest project; commands run from repo root.

- [x] **T1.1 — Studio route group + nav rename.** (origin A1)
  - Files — Create: `web/app/(app)/studio/page.tsx` (stub); Modify: `web/components/chrome/left-rail.tsx`, `web/messages/en.json`, `web/messages/ru.json`.
  - Do: add `nav.studio` (EN "Studio" / RU "Студия"); repoint the Flows rail item to `/studio`; keep the `/flows` route file in place (legacy, unlinked). Add the `studio` i18n namespace shell.
  - **Assertion migration (in-scope):** run the grep from "Test-integrity" and migrate any rail test asserting the Flows label/href.
  - Logging: `console.debug("[studio.overview] load", { viewerId, packageCount })` on the server page load; keep DEBUG-level, no secrets.
  - Verify: `/studio` renders; `pnpm --filter maister-web exec eslint app/\(app\)/studio components/chrome/left-rail.tsx` clean; touched rail tests green.

- [x] **T1.2 — Package-grouping shaper (TDD).** (origin A2)
  - Files — Create: `web/lib/studio/group-packages.ts`, `web/lib/studio/group-packages.test.ts`.
  - Do: pure `groupPackages({installs, attachments})` → `PackageGroup[]` (group by `(sourceUrl,name)`, newest-first versions, member-kind counts, `isLocal`, `needsTrust`, `attachedProjectCount`). Use the exact code in origin A2.
  - Logging: none (pure function — logging a pure shaper is noise; the caller logs).
  - Verify: `pnpm --filter maister-web exec vitest run lib/studio/group-packages.test.ts` → 3 green. Confirm the file is globbed: `pnpm --filter maister-web exec vitest list lib/studio`.

- [x] **T1.3 — Studio server loader.** (origin A3)
  - Files — Create: `web/lib/studio/load.ts` (wraps `getAvailablePackageInstalls` + cross-project `getProjectPackageAttachments`; resolve real module paths via the Step-1 grep in origin A3).
  - Logging: `console.debug("[studio.load] grouped", { installCount, attachmentCount, groupCount })`; `console.error("[studio.load] read failed", { err })` on a read throw (then rethrow — do NOT swallow).
  - Verify: `pnpm --filter maister-web exec tsc --noEmit` clean for `lib/studio/load.ts`.

- [ ] **T1.4 — Studio overview page.** (origin A4)
  - Files — Create: `web/components/studio/overview-cards.tsx`, `web/components/studio/overview-cards.test.tsx`; Modify: `web/app/(app)/studio/page.tsx`.
  - Do: count strip + area cards (`/studio/packages`, `/studio/local`, and `/studio/sources` only when `isAdmin`) + needs-attention list (untrusted installs). Resolve `isAdmin` with the same auth helper `/flows` uses.
  - Logging: page load DEBUG (from T1.1) now carries real counts.
  - Verify: `pnpm --filter maister-web exec vitest run components/studio/overview-cards.test.tsx` → 2 green.

- [ ] **T1.5 — Sources at `/studio/sources` (admin).** (origin A5)
  - Files — Create: `web/app/(app)/studio/sources/page.tsx` (mount the existing `PackageSourcesPanel`; reuse the settings loader's package slice).
  - **Identifier:** `requireGlobalRole("admin")` is the route authz boundary (auth-context). Leave the `/settings` panel intact (dedup is a noted follow-up, not a deletion).
  - Logging: `console.info("[studio.sources] admin view", { viewerId })` (admin access is worth INFO).
  - Verify: renders for admin; member → UNAUTHORIZED. Mirror the `/mcps` admin-gating test if one exists.

- [ ] **T1.6 — Packages list `/studio/packages`.** (origin A6)
  - Files — Create: `web/components/studio/packages-list.tsx`, `web/components/studio/packages-list.test.tsx`, `web/app/(app)/studio/packages/page.tsx`.
  - Do: one row per `PackageGroup` (name · source · newest version · trust · member-kind chips · attached count · Local badge) linking `/studio/packages/${encodeURIComponent(g.name)}`; client filter wrapper, server-renderable rows for the jsdom-free test path.
  - Logging: page load DEBUG `{ groupCount }`.
  - Verify: `pnpm --filter maister-web exec vitest run components/studio/packages-list.test.tsx` green.

- [ ] **T1.7 — Package detail `/studio/packages/[ref]`.** (origin A7)
  - Files — Create: `web/components/studio/package-detail.tsx`, `web/components/studio/package-detail.test.tsx`, `web/app/(app)/studio/packages/[ref]/page.tsx`.
  - Do: header + BoM grouped by kind + **read-only preview** reusing the static `FlowGraphView` (`flow-graph-view-section`, no `runContext`) with a flow selector when >1 flow + actions (Attach→board deep-link, Trust when `canTrust`=global-admin, Versions+upgrade, Fork via existing `package-fork-button`). Gate management actions on `canManage`.
  - **Identifier:** decode `ref` (`url-param`), resolve via `loadStudioPackages` (server-state); cross-source name collision → disambiguation list; `ref` is NEVER an fs path.
  - Logging: `console.debug("[studio.packageDetail] resolve", { ref, matched: groups.length })`; `console.warn("[studio.packageDetail] ambiguous ref", { ref, count })` when >1 match.
  - Verify: `pnpm --filter maister-web exec vitest run components/studio/package-detail.test.tsx` → 2 green (BoM render + Trust hidden for non-admin).

- [ ] **T1.8 — Board deep-link + i18n + e2e.** (origin A8)
  - Files — Modify: `web/components/board/panels/flow-packages-panel.tsx` (per-package "Open in Studio" → `/studio/packages/{name}`), `web/messages/{en,ru}.json` (fill the `studio` namespace, both locales), `web/playwright.config.ts` (add `studio` to `AUTHED_SPEC`); Create: `web/e2e/studio.spec.ts`.
  - Logging: none (UI link); confirm RU JSON parses (`node -e "JSON.parse(require('fs').readFileSync('web/messages/ru.json'))"`).
  - Verify: `lsof -ti :3100,:7788 | xargs kill -9 2>/dev/null; pnpm --filter maister-web exec playwright test studio.spec.ts` green (shared e2e infra — kill ports first).

### Phase 2 — As-built docs sync + gates

- [ ] **T2.1 — Flip surface docs to Implemented.**
  - Files — Modify: `docs/screens/studio/README.md` status `Planned`→`Implemented (Phase A)` for the shipped surfaces (overview/sources/packages/package-detail); B/C stay Planned. Add the per-screen template files for the shipped screens if splitting now, else update the index row in `docs/screens/README.md` + the glossary in `docs/CLAUDE.md`. Update `docs/system-analytics/flow-studio.md` status tags to match HEAD.
  - Verify: `pnpm validate:docs:all` green.

- [ ] **T2.2 — Full gate + docs checkpoint.**
  - Run: `pnpm --filter maister-web exec vitest run lib/studio components/studio` (green); `pnpm --filter maister-web exec eslint app/\(app\)/studio components/studio components/chrome/left-rail.tsx components/board/panels/flow-packages-panel.tsx` (clean, **scoped — never the no-path `lint` script**); `playwright test studio.spec.ts` (green); `pnpm validate:docs:all` (green). Mandatory `/aif-docs` checkpoint (Docs: yes). Commit 5.

---

## Phasing & sequencing (A → B → C) — separate `/aif-plan` runs for B and C

Sequenced to fix the loudest pain (the editor) early while building each surface against its **final** substrate so nothing is rebuilt. The lever: the editor redesign splits into a **storage-agnostic** half (most of the usability win) and a **package-coupled** half (needs the local-package model).

- **Phase A — Studio shell & surfacing** (this plan). Unified home · sources · packages-grouped · package-detail with read-only preview. Over existing backend; no migration. Fixes "/flows is not perfect" + view/check.

- **Phase B — Editor usability** (own plan; over existing flow drafts, behind a small **load/save seam**). The storage-agnostic ~90%: big canvas, node cards (icons/colors / named-outcome handles / dashed rework edges), the node properties panel (node-intrinsic fields), the compact top bar + YAML/validation drawers, hideable rail, drag-move→`presentation` (ADR-064). → editor goes "unusable → usable" early, zero rework. **Excludes** the Files drawer, cross-artifact reference pickers, "new artifact", and "cut version" — those are package-coupled and land in C. Phase-0 docs: `editor.md` + `flow-studio.md` editor section + node-scheme. No migration, no API.

- **Phase C — Editable local packages (Variant B) + the editor's package-coupled half** (own plan; NEW backend). **Data model LOCKED to Variant B:** a `local_packages` table whose row points at a mutable **working directory**; Studio's file/graph editors edit files in it; **"cut version"** runs the *existing* installer over the dir → an immutable `local-<digest>` `package_installs` revision; projects attach it; the **virtual package** is the default row; **move-to-package** relocates files between working dirs. Standalone artifact kinds become files in the dir (`flows/ agents/ skills/ mcps/ rules/ schemas/`), each via its per-kind editor. Then the editor's coupled half plugs into B's seam: the **Files drawer** (package artifacts), **cross-artifact reference pickers** (a node's schema/skill/MCP picks a sibling artifact), **"new artifact in package"**, and the top-bar **"cut version"** action. Plus `/studio/local`.
  - **Why Variant B (not extending `authored_capabilities`):** "an editable local package" *is* "a local source dir you cut versions from" — symmetric with the existing git-package → install → attach pipeline, matches the file-based editors, and keeps platform scope clean instead of invasively re-scoping the project-keyed drafts table.
  - **C Phase-0 is the heavy SDD lift** (per skill-context): a new `docs/system-analytics/local-packages.md` (R5: lifecycle, cut-version + move-to-package flows, crash windows), the ERD in **both** `docs/database-schema.md` + `docs/db/*.md` for `local_packages`, the migration spec, **OpenAPI** for the new routes (local-package CRUD, file write, cut-version, move), any new `MaisterError` codes, and `local-workspace.md` + `package-detail.md` local-package updates. Reuse: `atomicWriteJson`, the two-phase installer, the GC sweeper.
  - **Within C, build in this order:** the `local_packages` substrate + working-dir CRUD → wire the **flow** editor (from B) to it → **skill/rule/agent** frontmatter editors (mostly exist) → the **MCP-template** form (the one genuinely-new editor) → **cut-version** + **move-to-package** last (they depend on all artifact types existing). Write-back to a git source stays **Phase 2**.

---

## Нерешённые вопросы

1. ✓ **РЕШЕНО — Phase C модель данных:** Variant B — новая таблица `local_packages` + рабочая директория; «cut version» через существующий установщик (см. «Phasing & sequencing»).
2. **Маршрут редактора (Phase B):** на месте `/flows/{projectSlug}/{capId}` или новый `/studio/edit/...`?
3. **`/flows` после паритета:** редирект на `/studio` или удалить? Когда?
4. **Sources:** убрать панель из `/settings` или держать в двух местах (`/settings` + `/studio/sources`)?
5. **`ref` пакета:** имя достаточно, или нужен стабильный `base64url(source::name)` против коллизий имён между источниками?
6. **Веха в ROADMAP:** добавить M35 "Flow Studio redesign" через `/aif-roadmap` или привязать к существующей линии M27?
