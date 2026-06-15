# Active Workspaces Rail — Compact Redesign

- **Branch:** `claude/lucid-hypatia-688a9f` (existing worktree — NO new branch)
- **Created:** 2026-06-15
- **Design source (approved):** [`docs/screens/chrome/active-workspaces.md`](../../docs/screens/chrome/active-workspaces.md)

## Settings

- **Testing:** yes — vitest unit + integration, playwright e2e. Per skill-context:
  every promised test names its runner project, and each phase exits only on a
  green suite (runnability + per-phase green are acceptance, not aspiration).
- **Logging:** standard (INFO). INFO on the rename route (success/failure, reusing
  the route's existing `pino`); no DEBUG noise in the UI layer.
- **Docs:** yes — mandatory docs checkpoint (OpenAPI for the new route + flip the
  screens-doc status Designed→Implemented).
- **Roadmap Linkage:** Milestone "none" — Rationale: UI enhancement of the rail,
  not a roadmap milestone (skipped by user).

## Scope & non-goals

**In:** compact two-line rail rows; single colour-coded state dot (tone + pulse +
attention-word); ticket-derived names + scratch rename; flow/runner info chips +
`KEY-N` issue link; hover/focus icon actions; new `--attention` theme token;
rail-query joins; scratch rename `PATCH`.

**Out (explicit non-goals — `/aif-verify` must NOT expect these):**

- No new DB column and **no migration** — rename reuses `scratch_runs.name`; names
  come from existing `tasks` / `flows` / `runs.runner_snapshot`.
- No new env var / sidecar / bound port (the deployment-touchpoints rule is N/A).
- No installed-flow detail page — the flow chip is **non-linking** (see the design
  doc Navigation: `/flows/[projectSlug]/[capId]` is the authored-capability editor,
  keyed by an authored `cap_id`, not the installed `flow_ref_id` a run uses).
- No change to lifecycle-action **policy** (`deriveWorkbenchLifecycleActions`) — only
  its rendered surface (text buttons → hover icon buttons).
- No runner detail page (runner stays an info chip + tooltip).

## Decisions (skill-context compliance)

- **Rename route identifiers** — `runId` = `url-param`; `name` = `body-controlled`
  (validated: trimmed, 1..200 chars, non-empty; never used as a path component);
  `projectId` = `server-state`, derived from `loadScratchRun(runId).run.projectId`,
  **never** from the body. Gate: `requireProjectAction(projectId, "renameScratchRun")`.
- **Rename is a single-row write, no external side-effect** → no two-phase-commit /
  deferred-release concern. Idempotent (same name → same result). Guard:
  `loadScratchRun` already rejects non-scratch runs (`PRECONDITION` 409); rename is
  allowed in any run status.
- **No new `runs.status` / enum value** → the "fan a new status out to all
  consumers" rule is N/A. BUT the `RailWorkspaceRow` DTO change has **two**
  consumers — `left-rail.tsx` (renderer) AND `getRailWorkspaces()` (flattener that
  builds `RailWorkspaceData.meta`); both MUST be updated together (T1.2).
- **Contract surfaces** — new `PATCH /api/scratch-runs/{runId}` → `docs/api/web.openapi.yaml`.
  No new error code (reuse `CONFIG`/`PRECONDITION`/auth codes). No new env var.
- **/aif-improve refinements** — status words are NOT i18n'd today (must add; RU required);
  rename i18n lives in `portfolio`, not `workbenchLifecycle.action`; the row splits
  presentational/interactive for `renderToStaticMarkup` testability; `runnerDetail` is
  null-safe (never throws); `getRailWorkspaces()` is test-only; the running pulse keyframe and
  the `components/**/__tests__` unit glob already exist (no extra work).

## Tasks

### Phase 1 — Foundation: theme token + rail data

**T1.1 — Theme: add `--attention` token**
- Files: `web/styles/globals.css` (`:root` + `.dark` add a warm `--attention`
  light/dark value; `@theme inline` add `--color-attention: var(--attention)`).
- Accept: `bg-attention` / `text-attention` resolve in both themes; visibly distinct
  from `--accent-2` (running) and `--danger` (crashed). Only warm accent besides danger.
- Logging: none (CSS).
- blockedBy: none.

**T1.2 — Rail query: `tasks` + `flows` joins, runner detail, ticket names**
- Files: `web/lib/queries/portfolio.ts` (`getRailWorkspaceGroups` base select +
  `RailWorkspaceRow` DTO + the `getRailWorkspaces()` flattener).
- Add `leftJoin(tasks)` resolving the run's task via `runs.taskId` (flow/agent) OR
  `scratchRuns.linkedTaskId` (scratch) — coalesce; pull `tasks.number`, `tasks.title`,
  `projects.taskKey`. Add `leftJoin(flows)` on `runs.flowId` → `flows.flowRefId` +
  `runs.flowVersion`. Surface runner detail (agent/model/adapter/provider/sidecar)
  from the existing `runs.runner_snapshot`.
- Extend `RailWorkspaceRow`: `name` = `scratch.name ?? ticketName(KEY-N + title) ?? branch`;
  add `flowRefLabel?`, `flowVersion?`, `taskKey?`, `taskNumber?`, `issueHref?`,
  `runnerDetail {agent, model, adapter, provider, sidecar}` parsed **null-safe**
  (missing snapshot → `null` → chip hides; do NOT replicate `executorDisplay`'s
  `PRECONDITION` throw). KEEP `executorLabel` / `statusLabel` / `statusTone` / `name` /
  `launchedBy` — do NOT remove (`getRailWorkspaces()` + `portfolio.integration.test.ts`
  assert them via `toMatchObject`).
- Update `getRailWorkspaces()` so its `meta` string still builds — it is **test-only**
  (no production consumer) but must stay valid.
- Tests — **extend** `lib/queries/__tests__/portfolio.integration.test.ts` (it already
  asserts the grouped scratch row): flow run → `flowRefLabel` + `KEY-N`; scratch with
  `linkedTaskId` → `KEY-N`; scratch without → no `issueHref`; agent run; null-safety
  (no task / no flow); `runnerDetail` parsed from snapshot. Runnability: existing
  `lib/**/*.integration.test.ts` glob.
- Logging: standard.
- blockedBy: none (parallel with T1.1).

### Phase 2 — Rename endpoint  ·  commit checkpoint after this phase

**T2.1 — authz: add `renameScratchRun` action**
- Files: `web/lib/authz.ts` (`PROJECT_ACTION_MIN`: `renameScratchRun: "member"`).
- Accept: `ProjectAction` union includes it; member+ allowed, viewer denied.
- blockedBy: none.

**T2.2 — `PATCH /api/scratch-runs/[runId]` rename**
- Files: `web/app/api/scratch-runs/[runId]/route.ts` (add `PATCH` beside `GET`).
- Body `{ name: string }`. Derive `projectId` via `loadScratchRun` (server-state),
  `requireProjectAction(projectId, "renameScratchRun")`, validate `name`
  (trim → 1..200, else `CONFIG` 400), update `scratchRuns.name` where `runId`,
  return `{ ok: true, name }`. Non-scratch → `PRECONDITION` 409 (existing guard).
  INFO log `{ runId, projectId }` on success; errors via existing `errorResponse`.
- Identifiers sub-bullet: `runId`=url-param, `name`=body-controlled(validated),
  `projectId`=server-state.
- Tests (`app/api/scratch-runs/[runId]/__tests__/*.test.ts`): 200 rename; 400
  empty / >200; 409 non-scratch; 403 viewer; 401 no session; missing run. Runnability:
  existing app route test glob.
- Logging: standard (INFO).
- blockedBy: T2.1.

**T2.3 — OpenAPI: document the PATCH route**  `[docs]`
- Files: `docs/api/web.openapi.yaml` (path `/api/scratch-runs/{runId}` → add `patch`:
  body `{name}`, responses 200/400/401/403/409 referencing the existing error schema).
- Accept: `npx @redocly/cli lint docs/api/web.openapi.yaml` clean.
- blockedBy: T2.2.

### Phase 3 — UI: compact row + icon actions + i18n

**T3.1 — i18n keys (EN + RU)**
- Files: `web/messages/en.json`, `web/messages/ru.json`.
- Keys: `portfolio` per-state status **words** (running/needsInput/needsInputIdle/review/
  crashed/humanWorking/done) — **none exist today** (`railStatus` emits raw enum strings);
  `portfolio` runner-tooltip field labels (agent/model/adapter/provider/sidecars); chip
  aria-labels (flow/issue/runner); **rename** action + dialog (title/body/placeholder/
  confirm/busy) under `portfolio`/rail — NOT `workbenchLifecycle.action` (that namespace is
  the 5 lifecycle actions). `workbenchLifecycle`: a **new long tooltip** key group for the
  icon variant (export = "push branch to remote", etc.), distinct from the short `action.*`
  button labels. EN+RU parity (both files, same key set).
- blockedBy: none.

**T3.2 — `active-workspace-row` (new — SPLIT for testability + RSC boundary)**
- Files: `web/components/chrome/active-workspace-row.tsx` (new) — two parts:
  - **(a) pure presentational** sub-component (NO hooks): single **state dot** (move
    `dotByTone` here; `needs`/`waiting` → `bg-attention`; the running pulse keyframe
    **already exists**), a compact status word for `{NeedsInput, NeedsInputIdle, Review,
    Crashed}` else `title`/`aria-label`, **name**, **meta chips** (flow info chip + tooltip,
    runner info chip + tooltip from `runnerDetail`, `KEY-N` `<Link>` when `issueHref`),
    TTL/archived badges. Receives **preformatted** strings (server-translated status word,
    `time`, ttl label, names, hrefs) as props from the server rail.
  - **(b) thin client wrapper** (`"use client"`): rename input → `PATCH` → `router.refresh()`
    (scratch only; `role="alert"` errors) + `time` ↔ icon actions on `group-hover` AND
    `group-focus-within`, actions as focusable **siblings** of the row `<Link>` (never nested).
- Accept: a11y — dot `aria-label`; actions keyboard-reachable; icon buttons `aria-label`;
  no nested interactive element inside the anchor.
- Logging: standard (no `console`; warn boundary on fetch error).
- blockedBy: T1.1, T1.2, T2.2, T3.1, T3.3.

**T3.3 — compact icon variant of lifecycle actions**
- Files: `web/components/workbench/lifecycle-actions.tsx` (add an `"icon"` variant:
  icon buttons + tooltips from the **new long tooltip keys** (export = "push branch to
  remote"); reuse the existing dialog flow). Surgical — `compact`/`detail` variants unchanged.
- Accept: icon variant renders icons with `aria-label`/`title`; dialog still opens;
  prior variants byte-unchanged in behavior.
- blockedBy: T3.1.

**T3.4 — wire `left-rail.tsx` to the new row**
- Files: `web/components/chrome/left-rail.tsx` (the `workspaceGroups` branch: replace
  the inline row markup with `<ActiveWorkspaceRow>`; remove the redundant dot +
  status-word "double"; keep the group header + scratch `+`). The legacy
  `workspaces[]` fallback branch is left as-is (surgical; out of redesign scope).
- Accept: rail renders rows via the new component (server component renders the client
  child); no status-word duplication; SSR-safe.
- blockedBy: T3.2, T3.3.

### Phase 4 — Tests, docs checkpoint, verify

**T4.1 — Unit tests (`renderToStaticMarkup`)**
- Files: `web/components/chrome/__tests__/active-workspace-row.test.ts` — the unit glob
  **already** covers `components/**/__tests__/**/*.test.ts` (no vitest change). Target the
  **pure presentational** sub-component via `renderToStaticMarkup` (node env, no jsdom);
  wrap in `NextIntlClientProvider` if it reads translations.
- Cases: dot tone + word per state (attention vs calm), running pulse class, rename
  pencil only for scratch, flow/runner/issue chip presence, issue hidden when no task.
- blockedBy: T3.4.

**T4.2 — e2e (playwright)**
- Files: `web/e2e/active-workspaces.spec.ts` (+ register in the `AUTHED_SPEC` regex or the
  spec is silently skipped). **Seed fixtures** (`e2e/_seed`): a renamable scratch run owned
  by the test user + a flow run with a task (KEY-N nav) in a rail-visible project — mind the
  seed-clobber caution from prior e2e work.
- Cases: hover row → icon actions visible / time hidden; rename a scratch run round-trips
  and persists; `KEY-N` link navigates to the task; per-state dot present. Free ports
  `:3100` / `:7788` before running (shared e2e infra).
- blockedBy: T3.4.

**T4.3 — Docs checkpoint**  `[docs]`
- Flip `docs/screens/chrome/active-workspaces.md` status Designed→Implemented for the
  shipped parts; confirm OpenAPI (T2.3) + screens doc are consistent; `pnpm validate:docs`
  green.
- blockedBy: T4.1, T4.2.

**T4.4 — Verify gates**
- `pnpm --filter maister-web typecheck`; scoped eslint (check-only `eslint .` or scoped
  `--fix` on touched files — NEVER bare `pnpm --filter maister-web lint`, it reformats the
  repo); scoped vitest unit + changed integration; e2e `active-workspaces`;
  `pnpm validate:docs`. All green.
- blockedBy: T4.3.

## Commit Plan

- **Commit 1** (after Phase 1) — `feat(web): --attention token + rail-query task/flow joins for active-workspaces redesign`
- **Commit 2** (after Phase 2) — `feat(web): scratch-run rename PATCH + renameScratchRun authz + OpenAPI`
- **Commit 3** (after Phase 3) — `feat(web): compact active-workspace rail rows (state dot, chips, hover icon actions, rename)`
- **Commit 4** (after Phase 4) — `test(web)+docs: rail redesign tests + screens/OpenAPI docs checkpoint`

(No `Co-Authored-By` trailer — project convention.)
