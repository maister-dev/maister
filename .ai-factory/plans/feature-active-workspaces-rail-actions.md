# Implementation Plan: Active-workspaces rail — row actions redesign

Branch: claude/loving-kapitsa-92c490 (no new branch — plan in place per owner)
Created: 2026-06-16

Design source (approved): `docs/plans/2026-06-16-active-workspaces-rail-actions-design.md`

## Settings
- Testing: yes
- Logging: standard (INFO key events, ERROR failures) — new backend code only; client components log nothing server-side
- Docs: yes (mandatory docs checkpoint; Phase 0 is docs-first per skill-context)

## Roadmap Linkage
Milestone: "none"
Rationale: UI enhancement, no milestone (mirrors the prior `feature-active-workspaces-rail-redesign`).

## Problem (verified in code)
1. Hover jump: 26px icon buttons replace ~16px time text on line 1 (`active-workspace-row.tsx:158-169`) → row grows vertically.
2. Name buried: terminal scratch shows up to 5 `shrink-0` buttons (rename + archive + drop + snapshot + export, `lifecycle-actions.tsx:151-155`) over a ~232px rail (260px − padding) → name link unreachable.
3. Live flow shows one button: policy enables only `stop` while live (`policy.ts:106-110`).
4. Inline rename cramped (`active-workspace-row.tsx:308-348`).
5. Agent `Stop` broken: `/api/runs/[runId]/stop` → `stopFlowWorkbench` throws `PRECONDITION` for non-flow (`service.ts:1045-1050`).

## Decisions (locked)
- Per-row actions collapse to a single `⋯` overflow that opens a **modal action-sheet** reusing `DialogShell` (rail `<section>` is `overflow-y-auto`, `left-rail.tsx:608` → an anchored dropdown would clip). At most one inline primary action (`Stop`, live only) beside `⋯`.
- Rail action set = Open · Rename(scratch) · Stop · Archive · Drop. `snapshot-commit`/`export-branch`/`handoff-branch` are removed **from the rail variant only** — the rail is **1 of 6** `WorkbenchLifecycleActions` call sites; the other 5 (`flight-card.tsx`, `scratch-dialog.tsx`, `project-card.tsx`, `projects/[slug]/page.tsx`, `runs/[runId]/layout.tsx`) keep current behavior.
- Combined `Stop & archive` / `Stop & drop` for **flow + scratch** (one click). Race-free: `stopFlowWorkbench` is synchronous → `Review` (`service.ts:1067-1091`); scratch `/stop` with a workspace → `Review` (`scratch-runs/state.ts:50-53,64-82`); `Review` is archive/drop-eligible (`policy.ts:63-69`).
- Rename via `DialogShell` modal; KEY-N task chip in the header when the scratch run has a linked task; edits the scratch `name`; `PATCH /api/scratch-runs/[runId]` contract unchanged.
- Agent stop is fixed (in scope); combined `Stop & *` for agents stays out of scope.

### Contract-surface trace (skill-context: trace every surface to its spec)
| Surface | Spec file |
| --- | --- |
| `POST /api/runs/{runId}/stop-archive` (new) | `docs/api/web.openapi.yaml` + `docs/system-analytics/workbench-lifecycle.md` |
| `POST /api/runs/{runId}/stop-drop` (new) | `docs/api/web.openapi.yaml` + `docs/system-analytics/workbench-lifecycle.md` |
| `POST /api/runs/{runId}/stop` semantics now terminate `runKind=agent` | `docs/api/web.openapi.yaml` + `docs/system-analytics/workbench-lifecycle.md` |
| Rail row surface (menu, fixed height, rename modal) | `docs/screens/chrome/active-workspaces.md` |
| Scratch `Stop & drop` reuses `POST /api/scratch-runs/{runId}/discard` | already specced — prose note only |

No new env var / config path / sidecar / bound port / DB column / enum value → **no deployment-wiring task and no migration** (skill-context deployment-touchpoints rule: nothing to wire).

### Identifiers per new route (skill-context: body-controlled audit)
For `stop-archive`, `stop-drop`, and the generalized `stop`: `runId` = **url-param** (trusted via route shape + RBAC); `projectId` = **server-state** (from the `runs` row); request body is empty — **no body-controlled identifiers**.

### Two-phase / crash-window (skill-context: routes with downstream side-effects)
Combined ops compose two already-guarded ops, no new idempotency marker:
1. Stop commits first → run rests in `Review` (durable, retryable).
2. Archive/Drop then runs via existing `claimLifecycleOperation`/`finalizeLifecycleOperation` (already two-phase).

| Failure | HTTP | Run state | Recovery |
| --- | --- | --- | --- |
| Stop step fails | 5xx/409 | unchanged | retry the combined action |
| Stop ok, archive/drop fails | that op's error | `Review` (worktree intact) | plain `Archive`/`Drop` from the menu |
| Process crash between stop-commit and archive/drop-commit | — | `Review`, no orphan (worktree op not started) | user runs plain `Archive`/`Drop` |

Allow-list runKind in the stop dispatch (`flow`/`scratch`/`agent` handled explicitly; anything else → `PRECONDITION`), never deny-list. Terminal transitions honor the slot-release contract: flow already calls `promoteNextPending`; the agent terminate path must honor the agent-cap promotion contract (`MAISTER_MAX_CONCURRENT_AGENTS`) if one exists.

## Commit Plan
- **Commit 1** (Phase 0, tasks 1–3): `docs: spec active-workspaces rail actions redesign (combined ops, agent stop, menu)`
- **Commit 2** (Phase 1, tasks 4–5): `feat(api): generalize run stop (agent fix) + combined stop-archive/stop-drop`
- **Commit 3** (Phase 2, tasks 6–7): `feat(web): rail ⋯ action-sheet, rename modal, combined-action wiring`
- **Commit 4** (Phase 3 + Phase 4 i18n, tasks 8–9): `feat(web): fixed-height rail row + i18n`
- **Commit 5** (Phase 4, tasks 10–11): `test(web): e2e + unit; docs: flip status to Implemented`

## Tasks

### Phase 0 — Contract docs first (SSOT before code)
- [x] Task 1: Update `docs/system-analytics/workbench-lifecycle.md` — combined transitions, agent-stop dispatch, crash-window note, scratch mapping, R6 status tags. Exit: `pnpm validate:docs:all` green.
- [x] Task 2: Update `docs/screens/chrome/active-workspaces.md` — row anatomy (fixed height, reserved slot, name always clickable), ⋯ modal action-sheet, per-state action set, rename modal + KEY-N chip.
- [x] Task 3: Add `stop-archive` / `stop-drop` to `docs/api/web.openapi.yaml` (+ note generalized `stop` and scratch `/discard` reuse). Exit: `npx @redocly/cli lint` 0 errors.
<!-- Commit checkpoint: tasks 1-3 -->

### Phase 1 — Backend (stop dispatch + combined ops)
- [x] Task 4: Generalize stop into a runKind dispatcher; fix agent stop — anchor on the abandon-route precedent (`finalizeAgentRun` + cleanup + cancel-assignments) **plus the explicit `deleteSession` abandon omits**; verify agent-cap (`scheduler.ts`) promotion parity; allow-list runKind. (depends on 1, 3)
- [x] Task 5: **Extract `stopScratchWorkbench` primitive** (scratch-stop logic currently inline in the route → service; the `/stop` route delegates). `stopThenArchive`/`stopThenDrop` service fns + routes `stop-archive` (flow+scratch) / `stop-drop` (flow); scratch drop reuses `/discard`; authorize combined routes once (`recoverRun`). (depends on 4)
<!-- Commit checkpoint: tasks 4-5 -->

### Phase 2 — Lifecycle-actions component
- [x] Task 6: Add variant-scoped `menu` action-sheet (DialogShell root `menu` state); extend `UiActionId` (`open`/`stopArchive`/`stopDrop`/`menu`) + a rail-subset builder (not `renderActions`); add `runHref` + `taskKey`/`taskNumber` props; rail subset excludes snapshot/export/handoff; other variants untouched. (depends on 2)
- [x] Task 7: Rename modal (+ KEY-N chip) moved out of the row; wire stopArchive/stopDrop/open to endpoints. (depends on 5, 6)
<!-- Commit checkpoint: tasks 6-7 -->

### Phase 3 — Rail row
- [x] Task 8: Rebuild `active-workspace-row.tsx` — fixed line-1 min-height, reserved right-slot width, inline Stop(live)+⋯, pass `runHref`/`taskKey`/`taskNumber`, remove inline rename editor; **remove the now-dead `icon` variant** (rail was its only user). (depends on 6)

### Phase 4 — i18n, tests, close-out
- [x] Task 9: EN+RU keys (workbenchLifecycle menu/stopArchive/stopDrop/rename-modal; reuse portfolio.rename); verify placement (portfolio-ends-~L405 gotcha). (depends on 7)
- [x] Task 10: e2e `active-workspaces.spec.ts` **scoped to seedable surface** (scratch rename via modal, ⋯ open, no-height-jump, name clickable) — stop&drop / agent-stop **correctness lives in integration tests (T5/T4)**, not e2e (live sessions not seedable) + test-integrity gate (runnability + per-phase green + assertion migration of existing row/lifecycle tests). Register spec in playwright AUTHED_SPEC; serial mode; kill :3100/:7788 first. (depends on 7, 8, 9)
- [x] Task 11: Flip R6 status tags Designed→Implemented; re-run validate:docs:all + redocly + tsc + scoped eslint + unit + integration + e2e; mark design doc Implemented. (depends on 10)
<!-- Commit checkpoint: tasks 10-11 -->

## Test integrity (skill-context)
- Each unit/integration test names its runner project and its `include` glob is confirmed to match (`vitest list`).
- Existing tests to migrate IN-SCOPE (not deferred): `components/chrome/__tests__/active-workspace-row.test.ts`, `components/workbench/__tests__/lifecycle-actions.test.ts`, `components/workbench/__tests__/lifecycle-actions.dom.test.ts`.
- Per-phase exit = `pnpm test:unit && pnpm test:integration` green for touched suites; no silent red, no deletion to go green.

## Known gotchas (carried from prior rail work)
- `pnpm --filter maister-web lint` = `eslint --fix` with no path → reformats ~60 files. Lint FILES or a tight dir only; check-only via `eslint .`.
- Bracketed route paths (`app/api/runs/[runId]/...`) confuse globby — lint the parent dir; `git add` with `:(literal)` pathspec.
- e2e: `reuseExistingServer` reuses stale-code servers — `lsof -ti :3100 :7788 | xargs kill -9` first; postgres `maister_e2e` on :5432; run with `dangerouslyDisableSandbox`.
- `jsx-a11y/no-autofocus` is an ERROR — focus the rename input via `useRef`+`useEffect`, never `autoFocus`.
