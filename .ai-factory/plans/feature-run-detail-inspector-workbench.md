# Implementation Plan: Run detail primary surfaces + shared inspector/workbench

Branch: `main` plan-only; suggested implementation branch
`feature/run-detail-inspector-workbench`. Branch creation is intentionally
deferred because the current checkout already has unstaged screen-doc changes.
Created: 2026-06-15

## Settings

- Testing: yes
- Logging: verbose for server read models/routes, UI state via visible states
  only. No `console.*` in client components.
- Docs: yes. Screen docs already exist as the product anchor; analytics and API
  docs must move with code in the phase that changes behavior.

## Roadmap Linkage

Milestone: "none"; proposed implementation milestone name:
**M35. Run detail UX rework: flow result, scratch conversation, shared
inspector, richer workbench**.

Rationale: this is a cross-cutting UX implementation over shipped M22
Workbench, M27 lifecycle actions, M18/M30 review diff, scratch runs, and M34
agent runs. It does not introduce a new execution model, database state machine,
or supervisor contract.

## Source Requirements

Primary screen contracts:

- `docs/screens/runs/flow-run.md`
- `docs/screens/runs/scratch-run.md`
- `docs/screens/runs/run-inspector.md`
- `docs/screens/runs/workbench.md`

Product decisions locked by the user discussion:

- Scratch run detail lands on the conversation. The transcript and composer are
  the main surface, not a secondary tab.
- Non-scratch Flow runs land on Flow results and node outputs. Files, diff,
  evidence, and timeline are secondary workbench modes.
- Every run gets a toggleable right inspector showing change size, branch and
  worktree facts, run info, flow/session mini-map, and action shortcuts.
- The inspector is shared chrome, not a replacement for the main Flow result,
  scratch conversation, or full diff.
- Workbench tabs become Timeline, Diff, Files, and Evidence. Graph is either the
  main Flow result or a fullscreen detail, not a workbench tab competing with
  the landing view.
- File browsing keeps ADR-053: git-tracked-only reads, `readRepoFiles` for
  source, and no untracked/ignored-file source view in this slice.
- Diff uses the existing ADR-066 stack (`@git-diff-view/react` + server Shiki
  bundles) and supports explicit review scopes, including dirty worktree
  inspection for Human-gate commit decisions.
- Live refresh remains SSE-triggered. No timer polling, `fs.watch`, or client
  git scanning.
- URL state must not blur auth domains: `?file=` is reserved for the
  source/preview Files pane and `readRepoFiles`; diff selection uses
  `?diffFile=` under the Diff pane.

## Current Code Observations

- `/runs/[runId]` already uses a persistent nested layout:
  `web/app/(app)/runs/[runId]/layout.tsx` holds the heavy run reads, and
  `page.tsx` is the `?file=` server pane. Keep this shape.
- The Flow run page is currently a narrow stacked audit report
  (`max-w-[760px]`): cost, policy, HITL, timeline, evidence, workbench, settings,
  capabilities, review. It has the right data, but not the right hierarchy.
- `WorkbenchPanel` currently has `files | diff | graph`; default tab is graph.
  Evidence and timeline live outside the workbench, and Graph is not the main
  landing surface.
- `FileTree` and `CodeView` already implement the ADR-066 RSC file read path
  with Shiki source rendering. They do not yet support Preview/Source or
  Markdown + Mermaid preview.
- `RunDiff`/`DiffView` already support prepared diffs, split/unified mode,
  scope switching, changed files, and review comments.
- `/scratch-runs/[runId]` is currently a client-only `ScratchDialog`. It has a
  conversation-first center, but it owns its own right sidebar, lifecycle
  actions, raw `<pre>` diff loader, and promote shortcut.
- `WorkbenchLifecycleActions` and `deriveWorkbenchLifecycleActions` currently
  cover `stop`, `archive`, `drop`, and `exportBranch`; inspector actions need a
  broader server-derived action DTO over existing routes.
- Existing routes already cover stop, recover, archive, drop, snapshot commit,
  export branch, handoff branch, promote, PR delivery, scratch stop/discard, and
  HITL responses. V1 should prefer surfacing these routes over creating new
  mutation endpoints.

## Scope Guardrails

- No new `runs.status`, `scratch_runs.dialog_status`, run kind, or DB table.
- No supervisor API change. The web tier continues to read supervisor state
  through existing DB projections and `/api/runs/{runId}/stream`.
- No new state-changing route unless a missing action cannot be represented by
  existing routes. The likely new HTTP surface is read-only
  `GET /api/runs/{runId}/change-summary`.
- No direct arbitrary push-to-target route in this slice. Inspector "push"
  shortcuts map to existing snapshot/export/handoff/promote/PR semantics.
- Inspector delivery shortcuts must preserve the existing review contract:
  readiness, target drift, `reviewedTargetCommit`, and truncated-diff
  acknowledgement cannot be bypassed by shortcut actions.
- Do not loosen file read gates. Source views remain `readRepoFiles`; run diff
  remains `readBoard` for Flow/agent runs and `readScratchRun` for scratch runs.
- Do not move raw worktree paths, ACP session ids, or supervisor handles into
  client DTOs beyond already-safe display strings.
- Keep screen docs as current-state docs, not changelogs.

## Contract Surfaces To Update

| Surface | Files |
| --- | --- |
| Screen hierarchy | `docs/screens/runs/*.md` |
| Workbench tab model and scratch diff upgrade | `docs/system-analytics/workbench.md` |
| Flow run detail expectations | `docs/system-analytics/runs.md`, `docs/system-analytics/flow-graph.md` |
| Scratch detail expectations | `docs/system-analytics/scratch-runs.md` |
| Inspector lifecycle action grouping | `docs/system-analytics/workbench-lifecycle.md`, `docs/system-analytics/git-integration.md` if action text changes |
| New read-only change-summary route, if added | `docs/api/web.openapi.yaml` |
| EN/RU UI labels | `web/messages/en.json`, `web/messages/ru.json` |

No `.env.example`, compose, Dockerfile, supervisor OpenAPI, AsyncAPI, or DB docs
change is expected unless implementation discovers an actual new runtime
dependency or route.

## HTTP Identifier Trust Boundaries

New read-only route if implemented:

- `GET /api/runs/{runId}/change-summary?scope=run|since-last-review|last-node|uncommitted`
  - `runId`: URL param, untrusted.
  - `scope`: query param, untrusted allow-list.
  - Server state: run row, project id, run kind, worktree path, branch, base
    commit/ref, target branch policy.
  - Auth: `readBoard` for Flow/agent runs, `readScratchRun` for scratch runs.
  - Response: repo-relative paths, status, additions, deletions, file count,
    total additions/deletions, dirty/truncated/unavailable flags. No absolute
    paths, no supervisor/session handles.
  - Logging: `info` on success with `runId`, `projectId`, `scope`,
    `fileCount`, `additions`, `deletions`; `warn` on git/read-model failures
    with `runId`, `projectId`, `code`, and no file contents.
  - Read contract: authorize before git/worktree reads, do not call mutating
    read helpers, and keep scope availability consistent with
    `/api/runs/{runId}/diff`.

Existing routes reused by inspector/workbench:

- `GET /api/runs/{runId}/diff` keeps the existing trust boundary and scope
  allow-list. Scratch responses are upgraded to the prepared diff DTO shape
  before the shared Diff tab consumes them, while preserving raw `diff` during
  the migration.
- `GET /api/runs/{runId}/files` keeps `readRepoFiles`, server-derived ref, and
  `repoRelPathSchema` validation.
- Review comment routes keep existing server-side run/project/comment ownership
  checks.
- Action routes keep their existing body schemas and server-derived project,
  worktree, branch, and session metadata.

## Deployment Touchpoints

Expected dependency-only changes:

- Add `lucide-react` to `web/package.json` for inspector/action/file icon
  buttons; avoid adding more ad hoc inline SVG controls.
- Add `mermaid` to `web/package.json` as a runtime dependency for Markdown
  preview. The root package already has Mermaid for docs validation, but web
  runtime must declare its own dependency.

No new env var, sidecar, port, host-mounted file, DB migration, queue, or
supervisor binary is expected.

## Commit Plan

- Commit 1: docs/contracts + change-summary read model
- Commit 2: shared run shell + inspector
- Commit 3: Flow run primary result and node output surface
- Commit 4: scratch detail rework onto shared shell/workbench
- Commit 5: workbench Files/Diff/Evidence/Timeline enhancements
- Commit 6: action polish, i18n, e2e, docs finalization

## Tasks

### Phase 0 - Docs and contract alignment

- [x] **T0.1 - Confirm screen contracts.** Re-read
  `docs/screens/runs/flow-run.md`, `scratch-run.md`, `run-inspector.md`, and
  `workbench.md`; align wording with any final decisions from this plan. Do not
  duplicate behavior already owned by system analytics docs. Logging:
  docs-only. Verify: `pnpm validate:docs`.
- [x] **T0.2 - Update system analytics for the target hierarchy.** In
  `docs/system-analytics/workbench.md`, replace the old "scratch diff stays raw
  pre/out of scope" language with the shared workbench target. In
  `docs/system-analytics/runs.md` and `scratch-runs.md`, add the implemented UI
  expectations without changing the state machine. Logging: docs-only. Verify:
  `pnpm validate:docs`.
- [x] **T0.3 - Specify change-summary if added.** If the implementation adds
  `GET /api/runs/{runId}/change-summary`, add the route to
  `docs/api/web.openapi.yaml` with the trust labels above and examples for
  empty, ready, dirty/uncommitted, and unavailable worktrees. Logging:
  docs-only. Verify: `npx @redocly/cli lint docs/api/web.openapi.yaml`.
- [x] **T0.4 - Lock the run detail URL contract.** Update the screen docs with
  the query-state contract used by both run routes:
  `?wb=files|diff|evidence|timeline`, `?file=` for Files source/preview only,
  `?fileView=preview|source`, `?diffFile=` for Diff selection,
  `?diffview=split|unified`, `?scope=...`, `?node=...`, `?inspector=...`, and
  `?flow=fullscreen`. Logging: docs-only. Verify: `pnpm validate:docs`.

### Phase 1 - Shared run shell, change summary, and inspector

- [x] **T1.1 - Add a lightweight change-summary read model.** Create a server
  helper under `web/lib/queries/` or `web/lib/runs/` that resolves the same
  base/ref semantics as `/diff`, then computes file statuses and total
  additions/deletions without preparing the full highlighted diff. Prefer a git
  `--numstat` helper in `web/lib/worktree.ts`; keep path parsing strict and
  repo-relative. Do not use cost reconciliation or any other write-through read
  helper. Logging: `info` on success; `warn` on unavailable worktree or git
  failure with `runId`, `projectId`, and error code. Tests: real-temp-git
  unit/integration coverage for modified, added, deleted, renamed, binary, and
  empty diffs.
- [x] **T1.2 - Add `GET /api/runs/{runId}/change-summary` if live inspector
  refresh needs it.** Reuse T1.1, auth gates, and scope allow-list. The route is
  read-only, authorizes before git/worktree reads, and must return no absolute
  paths. Logging: route success/failure as in the trust-boundary section.
  Tests: route auth, scope validation, flow auth gate, scratch auth gate,
  scope-availability parity with `/diff`, no-server-leak shape assertion.
- [x] **T1.3 - Add shared query-state helpers.** Create a typed helper for the
  run-detail query contract so tabs, Files, Diff, node selection, inspector
  state, and fullscreen Flow do not hand-roll params. `?file=` must only drive
  the Files pane and never diff selection; `?diffFile=` drives Diff selection.
  Logging: none. Tests: parse/default/invalid fallback cases and tab-link
  preservation of unrelated params.
- [x] **T1.4 - Create shared run shell components.** Add
  `web/components/runs/run-shell.tsx`, `run-header.tsx`, and small pure helpers
  for status/chip/action labels. The shell owns desktop two-column layout,
  mobile stacked layout, inspector toggle, and header compact change size.
  Logging: none in client components; invalid persisted inspector state should
  silently reset to default. Tests: static component tests for header states,
  compact change summary, and mobile-safe markup classes.
- [x] **T1.5 - Create `RunInspector`.** Add
  `web/components/runs/run-inspector.tsx` with Overview, Changes, Flow/Session,
  and Actions tabs. It receives a server-derived DTO: run facts, change summary,
  flow mini-map/session summary, and enabled/disabled actions with reasons.
  Clicking a changed file opens `?wb=diff&diffFile=<path>`; "view source"
  opens `?wb=files&file=<path>&fileView=source`. Logging: none in the
  component; action errors remain visible via existing action components.
  Tests: tab switching, disabled reasons, changed-file link generation, scratch
  Session tab labels.
- [x] **T1.6 - Build an inspector action DTO over existing policy/routes.**
  Extend or wrap `deriveWorkbenchLifecycleActions` so the inspector can group:
  session controls (`stop`, `recover`), branch preservation (`snapshotCommit`,
  `exportBranch`, `handoffBranch`), delivery (`promote`, `promotePullRequest`),
  and cleanup (`archive`, `discard/drop`). Delivery actions must reuse the
  existing promote/review contract, including readiness, `reviewedTargetCommit`,
  target-drift handling, and truncated-diff acknowledgement. Do not create new
  mutation routes unless an action is impossible through existing endpoints.
  Logging: policy helper is pure; routes keep their existing logging. Tests:
  state matrix over
  `Running`, `NeedsInput`, `HumanWorking`, `Review`, `Crashed`, `Done`,
  `Abandoned`, and scratch `WaitingForUser`.
- [x] **Phase 1 exit.** `pnpm --filter maister-web lint`,
  `pnpm --filter maister-web typecheck`, and
  `pnpm --filter maister-web test` are green. If T1.2 adds a route,
  `docs/api/web.openapi.yaml` is updated in the same commit.

### Phase 2 - Flow run primary result

- [x] **T2.1 - Extract Flow result read DTOs from the existing run layout.**
  Keep the persistent nested layout, but shape its graph, node status, timeline,
  evidence, readiness, cost, settings, HITL, dirty-state, and review data into
  explicit serializable DTOs. Logging: server read model logs `debug` for graph
  data presence and node count; `warn` only when optional legacy/worktree
  derivations fail and the UI intentionally degrades. Tests: pure DTO mapping
  for current node, terminal run, missing manifest, and legacy review diff
  fallback.
- [x] **T2.2 - Add an agent-run center fallback.** For standalone
  `run_kind="agent"` rows without a pinned Flow manifest, render an
  `AgentRunCenter` or equivalent session result surface instead of forcing the
  Flow graph model. It should show session status, latest activity, evidence,
  review/diff CTA, and inspector Session details, not the scratch conversation.
  Logging: no client logging; server DTO logs `debug` for missing manifest and
  run kind. Tests: agent run with no manifest, agent run with workbench diff,
  agent terminal run, and invalid `?node=` ignored for agent center.
- [x] **T2.3 - Create `FlowRunCenter`.** Add a client component that renders
  the Flow result as the main page center: graph/list, current node selection,
  selected-node result panel, fullscreen graph button, and Review changes CTA
  that opens the Diff tab. Use `?node=` for deep-linkable node selection and
  do not trigger heavy layout reloads. Logging: none client-side. Tests: default
  current-node selection, `?node=` selection, invalid node fallback, review CTA
  URL.
- [x] **T2.4 - Implement selected-node result panels.** Add pure helpers that
  group timeline attempts, gates, duration, token/cost contribution, artifacts,
  HITL state, review comments, and readiness for one node. Render compact cards
  or rows only for actual data; do not duplicate the full timeline/evidence
  views. Logging: helper is pure; artifact payload load failures stay in
  existing payload routes/components. Tests: node with gates, reworked node,
  HITL node, review node, failed node, no-artifact node.
- [x] **T2.5 - Re-home existing run sections into the new hierarchy.** Cost,
  branch, worktree, policy, capability, and resolved-set summaries move to the
  inspector or compact disclosure sections. Timeline and Evidence move into
  workbench tabs. Crash/recover, HITL, dirty-state, takeover, and review gate
  diff remain prominent, but attach to the selected node or its immediate
  context. Logging: no new logging beyond T2.1. Tests: update existing run page
  component assertions that expected stacked section order.
- [x] **T2.6 - Flow run e2e.** Add or extend an authenticated Playwright spec:
  opening a Flow run lands on Flow result, current node is selected, inspector
  toggles, Review changes opens Diff, Evidence/Timeline are workbench tabs, and
  Files source read still uses `?file=`. If the spec filename is new, update
  `AUTHED_SPEC` in `web/playwright.config.ts` in the same task. Logging: e2e
  seed should not require real supervisor network. Verify with
  `pnpm --filter maister-web test:e2e -- e2e/m22-workbench.spec.ts
  e2e/review-comments.spec.ts`.
- [x] **Phase 2 exit.** Lint, typecheck, unit/integration tests, and targeted
  e2e are green. No layout query change may re-run graph/diff heavy loaders
  beyond the existing persistent-layout boundary.

### Phase 3 - Scratch run on the shared shell

- [x] **T3.1 - Add a persistent scratch run layout.** Convert
  `/scratch-runs/[runId]` to the same shape as `/runs/[runId]`: a persistent
  layout renders the conversation center, inspector, and workbench; the page
  child handles the `?file=` server pane. Extract the existing run file pane so
  both routes reuse the same `readRepoFiles` and `repoRelPathSchema` path.
  Logging: server file pane keeps invalid-path `warn` with `runId`/`projectId`
  only. Tests: server component/read helper tests for scratch file read auth.
- [x] **T3.2 - Split `ScratchDialog` into conversation parts.** Extract
  `ScratchConversation`, `ScratchComposer`, `ScratchPermissionPanel`, and pure
  status helpers from `web/components/scratch/scratch-dialog.tsx`. Preserve the
  current SSE-triggered detail refresh, message upload behavior, quick replies,
  recover prompt behavior, and HITL response routes. Logging: no client
  console; route errors remain visible in the conversation. Tests: migrate
  existing scratch dialog/transcript assertions to the smaller components.
- [x] **T3.3 - Upgrade scratch diff to the prepared DTO shape.** Update the
  scratch branch of `GET /api/runs/{runId}/diff` so it returns the prepared
  `files`, `perFile`, `scope`, and `scopes` shape consumed by `RunDiff`, while
  preserving the raw `diff` string during the UI migration. Keep
  `readScratchRun`, do not expose absolute paths, and update route tests that
  currently pin the raw-only scratch shape. Logging: reuse existing diff route
  logging with `runId`, `projectId`, `scope`, and no file contents. Tests:
  scratch auth gate, prepared files/perFile shape, empty diff, binary/truncated
  diff, and backward-compatible raw `diff`.
- [x] **T3.4 - Remove the scratch-owned sidebar and raw diff path.** Replace
  `loadDiff()` and the local raw `<pre>` diff section with the shared workbench
  Diff tab and inspector change list. Promotion/action buttons move to the
  inspector action group and continue to call existing routes. Logging: none
  client-side. Tests: scratch detail no longer renders raw diff; Diff tab
  renders `RunDiff` for scratch; action URLs preserve scratch-vs-run route
  selection.
- [x] **T3.5 - Scratch detail e2e.** Extend `scratch-launch.spec.ts` or add a
  new authed spec: launched scratch opens conversation, composer is primary,
  inspector toggles, WaitingForUser enables composer, Review shows change size
  and actions, Diff tab uses shared diff renderer, Files tab can read tracked
  files for a member. Add a successful scratch-detail fixture to
  `web/e2e/_seed/seed-e2e.ts`; if the spec filename is new, update
  `AUTHED_SPEC` in `web/playwright.config.ts`. Logging: seeded fixture should
  use the existing stub supervisor. Verify with
  `pnpm --filter maister-web test:e2e -- e2e/scratch-launch.spec.ts`.
- [x] **Phase 3 exit.** Lint, typecheck, `pnpm --filter maister-web test`, and
  targeted scratch e2e are green. Scratch launch, messages, recover, HITL, stop,
  discard, and promote route tests remain green.

### Phase 4 - Workbench Files/Diff/Evidence/Timeline

- [x] **T4.1 - Change workbench tabs to Timeline, Diff, Files, Evidence.**
  Update `WorkbenchTab`, `WorkbenchTabs`, `WorkbenchPanel`, query parsing, and
  labels. Keep all mounted where necessary so file-tree expansion and diff
  selection survive tab changes. Graph moves to `FlowRunCenter` and fullscreen
  graph. Logging: none client-side. Tests: tab parsing/defaults, hidden-not-
  unmounted behavior, old `wb=graph` gracefully redirects or falls back to the
  Flow result.
- [x] **T4.2 - Add file preview/source mode.** Add a file header with copy/open
  controls, file-type icon/status, and a `Preview | Source` segmented control
  (`?fileView=preview|source`). Source reuses `CodeView`. Preview supports
  Markdown/GFM, Mermaid code fences, anchors, copy buttons for code blocks, and
  syntax-highlighted code fences by reusing the existing Shiki/source
  highlighting path or an equivalent typed helper. Keep the markdown pipeline
  safe: no raw HTML and no `rehype-raw`. Add `mermaid` to `web/package.json`.
  Logging: server preview logs `debug` for preview kind and byte size; Mermaid
  render failures show a local diagram error state without crashing the pane.
  Tests: preview-kind helper, Markdown render, Mermaid block success/error,
  highlighted code fence, source fallback for non-previewable files, copy button
  markup.
- [x] **T4.3 - Add file-type icons and grouped changed files.** Use
  `lucide-react` icons for buttons/controls and keep file-type mapping pure and
  deterministic by extension/status. Diff changed files should group by
  directory, display status icons, additions/deletions, comments, and selected
  state driven by
  `?diffFile=`, not `?file=`. Logging: none client-side. Tests: icon/status
  mapping, directory grouping, and diff-selected-file query parsing.
- [x] **T4.4 - Move Evidence and Timeline into workbench panes.** Reuse
  `EvidenceGraphSection` and `RunTimeline` without duplicating their data
  loaders. Evidence explains readiness; Timeline keeps chronological ledger and
  token/cost chunks. Logging: existing artifact/payload routes keep logging.
  Tests: workbench renders empty and non-empty evidence/timeline panes.
- [x] **T4.5 - Workbench e2e.** Extend `m22-workbench.spec.ts`: Files opens
  source and preview, Markdown Mermaid renders, Diff split/unified and scope
  still work, Evidence and Timeline are tabs, Graph is no longer a workbench tab
  but Flow fullscreen is reachable. Logging: e2e fixture includes a Markdown
  file with one Mermaid diagram and code fence. If a new spec is created, update
  `AUTHED_SPEC`. Verify targeted e2e.
- [x] **Phase 4 exit.** Lint, typecheck, unit/integration tests, targeted e2e,
  and `pnpm validate:docs` are green.

### Phase 5 - Inspector actions and branch flow polish

- [x] **T5.1 - Implement action groups in the inspector.** Use the DTO from
  T1.6 to render action shortcuts with icons, disabled reasons, confirmation
  dialogs, and result summaries. High-risk cleanup actions stay visually
  separated. Delivery actions either navigate to the Review changes flow or
  submit the existing promote/PR DTO with `reviewedTargetCommit` and drift
  safeguards intact. Logging: route calls keep existing structured logs; UI
  surfaces the returned `MaisterError` code/message without string matching.
  Tests: each action group renders enabled/disabled states and calls the correct
  endpoint or Review CTA.
- [x] **T5.2 - Branch and worktree run info.** Show branch, base branch/commit,
  target branch, worktree removed/archived state, handoff/export metadata, PR
  URL/number, and local snapshot commit results when available. Logging:
  metadata fetch failures are `warn` with `runId`, not blocking the rest of the
  inspector. Tests: summary rows for active, review, exported, PR-created,
  removed, and archived workspaces.
- [x] **T5.3 - Flow/session mini-map.** For Flow runs, show a compact node map
  with current/completed/failed/stale nodes and fullscreen action. For scratch
  runs, show Session: dialog status, context usage, attachments, selected
  capabilities, and latest tool activity. Logging: no client logging. Tests:
  flow mini-map status rollup and scratch session summary.
- [x] **T5.4 - Inspector live refresh.** Subscribe to existing run SSE while a
  run is live and refresh only lightweight inspector data: change summary,
  node/session status, and action availability. Debounce refreshes; skip
  subscription for terminal runs. Logging: route/read-model logs only; client
  errors render local stale-state badges. Reuse the existing `useRunStream`
  pattern and graph-status refresh behavior; do not add timer polling. Tests:
  debounce helper, terminal no-subscribe branch, and stale-state badge.
- [x] **Phase 5 exit.** All existing lifecycle route tests remain green:
  `web/lib/workbench-lifecycle/__tests__/*`,
  `web/app/api/runs/[runId]/workbench-lifecycle/__tests__/routes.test.ts`,
  promote/recover/stop/drop/archive/export/handoff route tests.

### Phase 6 - i18n, responsive QA, docs finalization

- [x] **T6.1 - EN/RU labels.** Add `runInspector` keys and update `run`,
  `scratch`, `workbench`, `evidence`, and lifecycle labels. Keep EN/RU parity.
  Logging: n/a. Tests: `pnpm --filter maister-web test:unit --
  lib/__tests__/i18n-parity.test.ts`.
- [x] **T6.2 - E2E fixture and auth wiring audit.** Ensure every new or
  renamed Playwright spec is included by `AUTHED_SPEC` in
  `web/playwright.config.ts`, and seed fixtures in
  `web/e2e/_seed/seed-e2e.ts` cover Flow, scratch detail, Markdown/Mermaid
  preview, and shared Diff. Logging: n/a. Tests: run the targeted e2e commands
  below and confirm the authed storage state is used.
- [x] **T6.3 - Responsive and accessibility pass.** Verify desktop two-column,
  narrow desktop, tablet, and mobile. Inspector becomes a sheet on mobile,
  composer remains reachable, graph/fullscreen does not overlap text, tabs fit,
  and long paths truncate. Logging: n/a. Tests: Playwright screenshot/locator
  checks for desktop and mobile viewports.
- [x] **T6.4 - Final docs flip.** Mark screen docs and system analytics text as
  implemented where the code has landed. Update README docs index only if new
  docs paths were added. Logging: docs-only. Verify: `pnpm validate:docs`.
- [x] **T6.5 - Full verification.** Run:
  `pnpm --filter maister-web lint`,
  `pnpm --filter maister-web typecheck`,
  `pnpm --filter maister-web test`,
  `pnpm --filter maister-web test:e2e -- e2e/m22-workbench.spec.ts e2e/review-comments.spec.ts e2e/scratch-launch.spec.ts`,
  and `pnpm validate:docs`. Record any skipped e2e reason in the implementation
  summary.

## Open Questions

1. Direct "push branch" should probably remain `exportBranch`/`handoffBranch`
   in V1. A raw "push current branch to arbitrary remote/ref" action needs its
   own safety contract and is not required for the agreed screen.
2. Fullscreen Flow can be a query-backed modal (`?flow=fullscreen`) or a
   dedicated route segment. Prefer query-backed modal unless implementation
   proves it causes layout reloads.

## For /aif-implement

Plan file: `.ai-factory/plans/feature-run-detail-inspector-workbench.md`.
Suggested branch: `feature/run-detail-inspector-workbench`.
Implementation order: Phase 0, Phase 1, Phase 2, Phase 3, Phase 4, Phase 5,
Phase 6.
