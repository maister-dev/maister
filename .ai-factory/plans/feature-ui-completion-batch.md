# Implementation Plan: UI completion batch — feedback, error hygiene, first-run, and navigation

Branch: `feature/ui-completion-batch` (fresh branch in the existing isolated worktree, based on local `main` at `cff87d6`)
Created: 2026-07-12
Refined: 2026-07-13 — SDD traceability, domain analytics, per-task TDD, and focused visual-component delivery added.

## Settings

- Testing: yes — SDD + TDD; component tests use `renderToStaticMarkup` only, with browser interaction covered by targeted Playwright scenarios.
- Logging: verbose for server-side action diagnostics; no client `console.*`. UI feedback uses the toast/error-boundary contract rather than diagnostic text or raw codes.
- Docs: yes — Phase 0 is a mandatory docs-first gate, followed by an as-built status pass before merge.
- Delivery: one UI-only branch; no migration, ADR, engine bump, HTTP/SSE contract change, or deployment wiring.

## Roadmap Linkage

Milestone: "none"

Rationale: This is an owner-approved UI-debt completion batch over existing behavior, not a new roadmap milestone or a platform-contract change.

## Locked scope and decisions

- Include exactly the UX-audit workstreams: feedback infrastructure, localized error hygiene, first-run guidance, navigation/surface cleanup, and the specified tests/docs.
- Exclude USD cost surfaces, run-summary/attention routing, board-IA regrouping, Kanban/DnD, member self-service project creation, responsive redesign outside the navigation drawer, and unrelated baseline E2E repairs.
- Do not touch the recently landed project MCP board surface: `McpPanel`, `mcp-bind-dialogs`, `McpSelect`, or their behavior/tests except to ensure no accidental diff reaches them.
- Use HeroUI v3 only. Confirm dialogs must be portaled to `document.body`; success feedback uses the existing green-check affordance. Every new copy has EN/RU parity.
- Preserve all existing API payloads, routes, server-action semantics, RBAC enforcement, and database state. The permitted data work is server-side UI read-model shaping only (for example, enabled-flow and attached-project counts), not a public contract change.
- `window.confirm` must have zero matches under `web/` after this branch. A raw `MaisterError` code must never be user-visible in an action message or control label; the sole exception is the explicitly labeled, localized diagnostic field of an error boundary when the code is recognized. The known `?? "CRASH"` rendering idiom must have zero user-facing uses.
- The current tree already contains the icon/success convention in `web/CLAUDE.md` and `.ai-factory/rules/frontend.md`, and the Studio ICU implementation already uses `t.raw(...)` plus parameter substitution. Extend the former rather than duplicating it; prove the latter with regression coverage rather than re-implementing an already-fixed source change.

## Contract-surface decision record

| Surface | Decision | Artifact / guard |
| --- | --- | --- |
| HTTP routes, request/response bodies, status codes | Unchanged | No OpenAPI edits; retain existing launch, promotion, package, and settings endpoints verbatim. |
| Browser SSE wire format and replay | Unchanged | `useRunStream` changes reconnect presentation/timing only; it continues to send `lastEventId` to the existing stream route. No AsyncAPI edit. |
| DB schema and persistent state | Unchanged | No migration. Read-model queries may add server-computed enablement/fan-out counts without persisting data. |
| Runtime/deployment configuration | Unchanged | No environment variables, ports, sidecars, package dependencies, Docker, Compose, or `.env.example` changes. |
| Error taxonomy | Existing codes only | Update `docs/error-taxonomy.md` **UI action** column to describe localized rendering; do not add a code. |
| UI/screen contract | Changed | Phase 0 updates `docs/screens/*`, `web/CLAUDE.md`, and `.ai-factory/rules/frontend.md`; final docs pass marks the behavior implemented. |
| System analytics | Changed, no new backend contract | Update the existing `runs`, `scratch-runs`, `tasks`, and `packages` domain artifacts. A standalone UI-analytics document would duplicate their contracts. |

## Baseline facts to preserve

- `web/app/error.tsx` is still the unstyled template boundary; no route loading files exist.
- `useRunStream` already exposes `connecting | open | closed`, `error`, `reconnect()`, and `lastEventId`, but has no explicit backoff/liveness UI. Runtime consumers are run refresh, live inspector, node transcript, board graph, scratch conversation, and Studio AI; the dev fixture remains a diagnostic consumer.
- The only localized `run.error.<CODE>` resolver is private to `RunHitlResponse`. `api-error.ts` serves a different `apiErrors` namespace and must not be silently repurposed to expose server detail.
- The three native confirmation sites are budget workspace drop, local-package discard, and upstream-sync abort. `run-recover-actions.tsx` plus `use-modal-focus-trap.ts` are the reuse source for accessible dialog behavior.
- The no-flow state needs a UI projection of **enabled** flows: `getProjectPageData()` currently drops `enabledRevisionId`. Package trust confirmation needs a server-computed count of affected project attachments.
- `launch-popover.tsx` and `app/(app)/projects/[slug]/page.tsx` are hot files; isolate their edits early and rebase them before the final verification pass.
- The claimed package-detail/package-composition ICU defect is already absent in this base. Baseline the real affected specs before changing them; only count a green delta if the baseline actually reproduces the failure. Do not broaden the batch to unrelated E2E reds.

## SDD traceability contract

Before production UI source changes, create
`.ai-factory/specs/feature-ui-completion-batch.md`. It is the implementation
SSOT for this branch and uses requirement IDs (`UIF-01` onward) rather than
duplicated prose. It must contain:

- the locked scope, non-goals, source-of-truth precedence, and the diagnostic
  error-code exception defined above;
- a requirements-to-evidence matrix mapping every feedback, boundary, stream,
  onboarding, launch, navigation, promotion, trust, i18n, and MCP-exclusion
  requirement to source anchors, a RED test, the final test, screens/analytics
  docs, and one observable acceptance scenario;
- separate state diagrams for the **presentation-only** stream lifecycle
  (`connecting → live → reconnecting → disconnected → live`), confirmation
  lifecycle (`idle → open → confirming → success|failure`), and first-run
  progression. These diagrams MUST state that none changes `runs.status` or
  API/SSE semantics;
- an interaction/accessibility table for toast urgency, error-boundary
  diagnostics, dialog busy state, skeleton `aria-busy`, liveness `aria-live`,
  and mobile-drawer focus/restore/Escape/route-change behavior;
- the exact no-contract-change inventory and an explicit source-sentinel list
  for `window.confirm`, raw-code rendering, MCP exclusions, and route loading
  files.

The docs-first phase updates existing system analytics, not a redundant new
UI domain document:

- `docs/system-analytics/runs.md` — liveness presentation versus persisted run
  status and the shared, guarded header promotion entry point;
- `docs/system-analytics/scratch-runs.md` — stream liveness/recovery display
  for the scratch consumer;
- `docs/system-analytics/tasks.md` — simple-intent creation remains valid when
  no enabled flow exists and the board’s remediation is non-blocking;
- `docs/system-analytics/packages.md` — trust confirmation displays an
  advisory, server-derived count for attachments with the exact
  `packageInstallId`, while the unchanged global-admin route is authoritative.

## Commit Plan

- **Commit 1** (after tasks 0-2): `docs: specify UI completion behavior`
- **Commit 2** (after tasks 3-7): `feat(web): add resilient feedback and localized errors`
- **Commit 3** (after tasks 8-10): `feat(web): complete onboarding and navigation`
- **Commit 4** (after tasks 11-13): `feat(web): streamline package trust, review, and board surfaces`
- **Commit 5** (after tasks 14-15): `test(web): verify UI completion behavior`

## Tasks

### Phase 0: Docs-first contract and reproducible baseline

- [x] **Task 0: Write the SDD specification and reconcile the affected domain analytics before code.**
  - **Files:** new `.ai-factory/specs/feature-ui-completion-batch.md`; `docs/system-analytics/{runs,scratch-runs,tasks,packages}.md`; `docs/CLAUDE.md` glossary only if a genuinely new analytics artifact becomes necessary.
  - **Deliverable:** create the traceability contract above. Give every locked acceptance behavior a stable requirement ID, source anchor, RED test, GREEN test, screen/system-analytics location, and explicit edge case. Update the four existing domain analytics files with Designed status and the exact invariants they own; do not create a generic feedback analytics document that duplicates screens/components documentation.
  - **Acceptance:** the spec separates presentation state from persisted run state, preserves simple-intent task creation, identifies the trust-count snapshot as advisory, and makes the boundary error-code exception explicit. Every intended test has one requirement owner and every requirement has one executable acceptance route.
  - **Logging:** document existing structured server logs as the diagnostic owner; no client logging or persistent telemetry is added.
  - **Depends on:** none.

- [x] **Task 1: Freeze the UI completion contract in documentation before source changes.**
  - **Files:** `web/CLAUDE.md`, `.ai-factory/rules/frontend.md`, `docs/error-taxonomy.md`, `docs/screens/README.md`, `docs/screens/components.md`, `docs/screens/chrome/{left-rail,top-nav,launch-dialog}.md`, `docs/screens/projects/project-board.md`, `docs/screens/runs/{flow-run,scratch-run}.md`.
  - **Deliverable:** add a concise Designed-state contract for one app-wide toast layer, shared portaled confirmation, localized route errors/loading skeletons, stream-liveness status, onboarding/role affordances, compact launch disclosures, Observatory/mobile navigation, and header-level review/promotion. Extend the existing UI-affordance rules with the toast/confirmation/no-raw-code convention; do not duplicate their existing icon and green-check rules. Correct stale prose that still calls PRs a placeholder or says launch budgets are visible by default. Update the taxonomy’s UI-action wording only; no new error code or API documentation.
  - **Acceptance:** the screens docs identify their real source components and link existing behavior docs without duplicating API/state-machine contracts; no ADR/OpenAPI/AsyncAPI/ERD/migration work is introduced; initially mark the batch behavior Designed and list its final Implemented-status flip.
  - **Logging:** record no client diagnostics. Document that client action failures become localized UI feedback while existing server-side structured logs remain the diagnostic source.
  - **Depends on:** Task 0.

- [x] **Task 2: Establish an executable baseline and scope sentinels without creating a permanent report artifact.**
  - **Files:** existing test/config files only when a missing runner include or explicit spec registration is proven; no production source change in this task.
  - **Deliverable:** run the exact source inventories for `window.confirm`, raw-code rendering, `useRunStream` consumers, hardcoded accessible labels, `loading.tsx`, and MCP exclusion paths; then run the currently affected Studio and UI E2E specs by explicit file path before implementation. Capture the existing full-E2E failure set in command output/CI evidence, not a new checked-in report.
  - **Acceptance:** distinguish target failures from the known pre-existing E2E baseline; confirm the ICU path is either reproducibly red or already fixed. If it is already green, retain that finding and add a regression test later rather than fabricating a source fix. Record exact intended accessibility-label keys after inventory rather than trusting the stale “three” count blindly; only user-facing labels in scope are localized.
  - **Logging:** keep existing test logging; never add `console` instrumentation to obtain baseline evidence.
  - **Depends on:** Tasks 0-1.

- [x] **Task 3: Define the shared client-safe feedback primitives and message contract.**
  - **Files:** `web/app/providers.tsx`, new `web/components/feedback/{feedback-provider,confirm-dialog,confirm-dialog-frame,use-modal-focus-trap}.tsx`, a compatibility re-export at `web/components/board/panels/use-modal-focus-trap.ts`, new or extracted client-safe `web/lib/{ui-error-message,feedback-state}.ts`, `web/lib/errors-core.ts` (types/guards only if required), `web/messages/{en,ru}.json`, and `web/components/runs/run-recover-actions.tsx`.
  - **RED → GREEN → refactor:** first add table-driven code-union/fallback tests, pure feedback-event state tests, and static rendering tests for the non-portaled dialog frame. Then add the smallest typed feedback store/provider and portal wrapper; refactor the existing recovery dialog to consume it. A browser test, not static render, proves the portal/focus path.
  - **Deliverable:** wire the HeroUI 3.0.4 top-level toast provider in `Providers` after verifying the installed package API; expose one typed success/error invocation seam with a green check success glyph, de-duplicated per completed mutation. Extract `RunHitlResponse`’s private code-to-message logic into a client-safe resolver over the closed `MaisterErrorCode` union and `run.error.<CODE>` keys with `run.error.generic` for unknown/malformed values. Move the generic focus-trap ownership out of the MCP-specific folder while leaving its old module as a re-export, so `mcp-bind-dialogs` remains behaviorally untouched. Build a pure `ConfirmDialogFrame` plus an accessible `ConfirmDialog` portal to `document.body`; migrate `RunRecoverActions` as well as the three native-confirm call sites in the next task.
  - **Acceptance:** no new dependency; no server-only import reaches a Client Component; dialog focus returns to its trigger; Escape/backdrop/cancel cannot dismiss while confirmation is busy; confirm invokes exactly once; toast and dialog text have EN/RU parity; inline field validation remains allowed, but mutation outcome patterns route through the shared feedback seam.
  - **Logging:** no client `console.*`; preserve structured server action failures and expose only localized, non-sensitive messages in UI.
  - **Depends on:** Tasks 0-2.

**Phase 0 exit gate:** `CI=true pnpm validate:docs` passes for the docs-first artifacts. Confirm with the test runner that planned component test locations match the `unit` project include globs before adding tests.

## TDD execution contract

Tasks 3-13 are behavioural deliveries. Each one MUST execute in this order:

1. add a focused, initially failing **RED** test for the user-visible invariant
   or boundary it changes;
2. make the smallest **GREEN** implementation that satisfies that test and its
   requirement ID;
3. refactor only after green, preserving the named test as the regression
   guard; then run the task’s focused suite and the phase-wide unit/integration
   gate.

`renderToStaticMarkup` tests cover pure rendering and props only. Stateful
browser behavior is made testable through injected/pure controllers (for
example the stream lifecycle controller) and is proven end-to-end in the
smallest relevant Playwright scenario. No jsdom, shallow snapshot, duplicate
happy-path, or test written after the implementation is accepted as primary
coverage. Task 14 may add cross-surface E2E and migrate stale assertions, but
may not be the first home for any feature’s RED test.

### Phase 1: Feedback, error, and live-stream resilience

- [x] **Task 4: Replace native confirmation and ad-hoc mutation outcomes with the shared feedback layer.**
  - **Files:** `web/components/board/run-hitl-response.tsx`, `web/components/studio/{local-package-diff-drawer,upstream-sync-controls,change-review-dialog,local-package-editor}.tsx`, `web/components/board/{launch-popover,panels/project-packages-section}.tsx`, `web/components/runs/review-panel.tsx`, and the actual project settings-save owners enumerated in the SDD traceability matrix.
  - **RED → GREEN → refactor:** first prove each destructive path has no request before confirmation, one unchanged request after confirmation, and no request after cancellation; then replace the native confirms. Add one behaviour test per mutation family rather than duplicating every button’s success path.
  - **Deliverable:** replace all three native confirms with `ConfirmDialog`; only invoke their unchanged destructive request after explicit confirmation. Route successful mutations through the one toast layer (green check) and failures through localized toast plus the contextual inline message where recovery/action context matters. Cover launch, promotion, package attach/adopt/publish/sync, and settings saves through their named owners in the SDD matrix. Remove only redundant target-surface success banners; retain field validation, progress stages, and durable conflict/remediation context.
  - **Acceptance:** `rg 'window\\.confirm' web` is empty; the package-sync abort, local discard, and budget-drop paths preserve their existing server calls/cancellation behavior; each mutation family creates one feedback event per completed request; launch/promote/package/settings mutations never fail silently and do not create a second toast provider.
  - **Logging:** retain existing server/request diagnostics; do not log confirmation choices or toast content from the browser.
  - **Depends on:** Task 3.

- [x] **Task 5: Ship themed localized error boundaries and loading skeletons for every primary route.**
  - **Files:** `web/app/error.tsx`; new boundaries at `web/app/(app)/runs/[runId]/error.tsx`, `web/app/(app)/projects/[slug]/error.tsx`, and `web/app/(app)/studio/error.tsx`; new loading files at `web/app/(app)/loading.tsx`, `runs/loading.tsx`, `runs/[runId]/loading.tsx`, `projects/[slug]/loading.tsx`, `studio/loading.tsx`, and `inbox/loading.tsx`; shared feedback/skeleton components and `web/messages/{en,ru}.json` as needed.
  - **RED → GREEN → refactor:** first add pure structural-error extraction and fallback tests plus static `ErrorFallback`/skeleton rendering tests; then implement the shared boundary/skeleton primitives. Use a route-level browser scenario to prove each boundary catches its intended page segment because static rendering cannot exercise Next’s error hierarchy.
  - **Deliverable:** replace the root stub with a themed boundary that recognizes serialized `MaisterErrorCode` values through a structural allow-list rather than relying only on `instanceof`. It renders a localized explanation and only the explicitly labeled diagnostic code field permitted by this plan, plus reset and a working Portfolio link; reuse it for the three segment boundaries. Remove the template’s client `console.error` effect unless an existing production error-reporting boundary is discovered and can receive the error safely. Add route-appropriate token-based skeletons with `aria-busy` so the specified routes never transition through a blank pane.
  - **Acceptance:** root and all three segment boundaries render localized EN/RU copy, handle unknown/malformed error objects safely, and preserve no raw server detail in the DOM; every required route has a `loading.tsx`; skeleton layouts match major chrome without fetching or changing route semantics.
  - **Logging:** server/error-reporting infrastructure remains the diagnostic owner; no new browser console output is introduced.
  - **Depends on:** Task 3.

- [x] **Task 6: Make SSE liveness explicit, reconnecting, and replay-safe at every runtime consumer.**
  - **Files:** `web/lib/use-run-stream.ts`, new pure `web/lib/run-stream-controller.ts`, a shared liveness-pill/presentation component, a run-shell stream provider/context if source inspection confirms it can own the existing run-page consumers, `web/components/runs/{run-live-refresh,live-run-inspector,node-transcript-panel}.tsx`, `web/components/board/flow-graph-view.tsx`, `web/components/scratch/scratch-conversation.tsx`, `web/components/studio/studio-ai-tab.tsx`, and `web/app/dev/run-stream/[runId]/run-stream-fixture.tsx`.
  - **RED → GREEN → refactor:** first test the pure controller’s state transitions, bounded delay, replay URL carrying `lastEventId`, manual-reset delay, and cleanup/no-retry terminal states. Then make the hook a thin EventSource adapter and add the smallest browser interruption/reconnect scenario. Refactor only after the run shell has one deliberate subscription owner.
  - **Deliverable:** add deterministic bounded exponential reconnect scheduling for an unexpectedly closed EventSource, cancellation on unmount/run change, manual reconnect that resets the retry delay, and a shared localized `live | reconnecting | disconnected` pill with non-color text, `aria-live`, and a one-click Reconnect action. Continue replaying from `lastEventId`; do not add polling or a second stream wire contract. The flow-run shell is the only owner of a stream shared by run refresh, inspector, node transcript, and graph; Scratch owns its one scratch stream; Studio AI owns its one Studio stream; board/development consumers own a stream only where they are not rendered inside that shared run shell. The dev fixture remains diagnostic-only.
  - **Acceptance:** a disconnected stream becomes visible within one retry interval; auto/manual reconnect uses the same run id and retained last event id; terminal/non-live runs and unmounted/replaced consumers leave no retry timer or open EventSource; a screen has no duplicate connection for the same shared run; no `fs.watch`, polling, WebSocket, or new API endpoint appears. The lifecycle remains presentation-only and never changes `runs.status`.
  - **Logging:** retry/error metadata stays in the hook’s typed state for UI; no browser console noise. Existing supervisor/SSE structured logs remain untouched.
  - **Depends on:** Task 3.

- [x] **Task 7: Sweep user-visible raw errors and stale hardcoded copy through the shared resolver.**
  - **Files:** `web/lib/{api-error,ui-error-message,errors-core}.ts`, `web/components/board/{assignment-actions,hitl-actions,new-task-modal,run-takeover-actions,launch-popover,token-actions}.tsx`, `web/components/runs/{review-panel,run-recover-actions}.tsx`, `web/components/social/task-agent-actions.tsx`, `web/components/workbench/lifecycle-actions.tsx`, `web/components/scratch/scratch-launcher.tsx`, `web/lib/scratch-runs/dialog.ts`, `web/components/board/panels/project-packages-section.tsx`, `web/components/chrome/status-bar.tsx`, the exact in-scope accessibility-label owners from Task 2, `web/messages/{en,ru}.json`, and `docs/error-taxonomy.md`.
  - **RED → GREEN → refactor:** first make the resolver and API-error tests fail for a known code, serialized code, malformed/unknown code, a raw API `message`, and a code used as a control label. Then migrate one representative from each owner family, prove the common seam, and complete the mechanical migration without duplicating the same happy-path assertion.
  - **Deliverable:** route every user-visible `MaisterError` result through the shared localized resolver, including unknown-code fallback; never inject a code into a launch/button label. Harden `api-error.ts` so an unrecognized API `code` or raw `message` cannot become user-visible text: it maps only approved/localized contextual errors and otherwise emits the localized generic failure. Localize the scratch/package generic fallbacks and selected accessibility labels. Derive the status-bar host from the request host header rather than a literal `localhost:3000`. Keep the API-error namespace distinct from `run.error.*`, while sharing the no-raw-fallback policy.
  - **Acceptance:** a source sentinel for raw user-facing `?? "CRASH"`/code rendering is zero (excluding typed internal state and the localized error-boundary diagnostic field); known and unknown codes resolve to localized copy; raw server messages/status codes never become a control label or action message; taxonomy UI-action rows match the delivered local feedback. Add a regression assertion for package-detail/package-composition EN+RU ICU interpolation, but do not make an unnecessary source edit when the existing `t.raw` composition is healthy.
  - **Logging:** preserve raw codes in structured server/client state for diagnostics where already present, but never log them as new client output or render them to the operator.
  - **Depends on:** Tasks 3-5.

**Phase 1 exit gate:** full web unit and integration suites are green (`pnpm --dir web test:unit` and `pnpm --dir web test:integration`); changed error/SSE behavior has explicit runner coverage, not only source sentinels.

### Phase 2: First-run completion and launch ergonomics

- [x] **Task 8: Build a live, role-aware first-run checklist and zero-flow remediation.**
  - **Files:** `web/lib/queries/portfolio.ts`, `web/app/(app)/page.tsx`, `web/components/portfolio/{empty-state,new-project-tile}.tsx`, `web/app/(app)/projects/new/page.tsx`, `web/app/(app)/projects/[slug]/page.tsx`, `web/components/board/new-task-modal.tsx`, `web/messages/{en,ru}.json`, and board/portfolio tests.
  - **RED → GREEN → refactor:** first add query/integration tests for a visible project, no visible project, an attached-but-disabled package, an enabled launchable flow, a task-linked flow run, and a scratch/non-task run. Include a member projection assertion that proves no inaccessible project state leaks. Then add static display coverage and one browser progression/remediation scenario.
  - **Deliverable:** derive a server-side onboarding projection only from projects visible to the current actor. Its milestones are: (1) at least one visible connected project, (2) at least one enabled, launchable Flow according to the same enablement/trust/compatibility predicate used by existing launch UI—not merely a package attachment, and (3) a Flow run with non-null `taskId`—not a scratch or agent run. Render its checklist until all three are complete. Remove the two dead empty-state buttons. Carry authorization eligibility into the empty state and `NewProjectTile` so a member gets an honest ask-an-admin state while `/projects/new` remains an honest gated page. Retain enabled-flow state in the project-page DTO; when no enabled flows exist, New Task presents a packages-tab remediation link without blocking the existing simple-intent task creation API or flow.
  - **Acceptance:** every rendered control has a handler or is a link; checklist state changes only from scoped real query data; an attached-but-disabled package remains incomplete/remediated; no member sees a CTA that leads to a known 403 or receives hidden-project facts; a zero-enabled-flow project has explicit installation remediation while simple intent remains usable; no API route, schema, or membership policy changes.
  - **Logging:** reuse existing server-side query/action diagnostics; do not add browser logs for checklist state or role gating.
  - **Depends on:** Tasks 1-2 and the localized feedback contract from Task 7.

- [x] **Task 9: Collapse the task-launch dialog to flow, runner, and execution preset by default.**
  - **Files:** `web/components/board/launch-popover.tsx`, `web/components/board/__tests__/launch-popover.test.ts`, `web/messages/{en,ru}.json`, `docs/screens/chrome/launch-dialog.md`.
  - **RED → GREEN → refactor:** first cover a pure `deriveInitialDisclosureState` for the two version flags and a browser scenario that opens/collapses disclosures without losing form values or changing the final request body. Then introduce the smallest disclosure state and refactor only repeated presentation markup.
  - **Deliverable:** preserve `buildLaunchBody` and all launch-option/API semantics, but put branches, delivery controls, budgets, and remaining advanced execution controls behind explicit existing-style disclosures. Keep only Flow, runner, and execution preset open initially. Make the package version-adopt area initially expanded exactly when `hasNewerCut || hasUncutEdits`; otherwise keep it collapsed/absent according to existing availability. Collapsing a section is visual-only and retains its already-selected semantic values.
  - **Acceptance:** initial DOM/UI contains exactly the three primary control groups; expanding disclosures exposes unchanged controls and preserves values; version behavior follows the stated boolean and does not mutate a pin until the existing launch path runs; no changes leak into MCP picker/dialog code.
  - **Logging:** retain existing launch route/server logs and stream error diagnostics; no new browser logging for disclosure state.
  - **Depends on:** Tasks 2 and 7.

**Phase 2 exit gate:** web unit/integration suites remain green. Rebase and re-run the focused checks for the two hot files before moving to E2E, resolving only true overlap with `main`.

### Phase 3: Navigation, package trust, and review-surface convergence

- [x] **Task 10: Add Observatory and one accessible mobile rail drawer without duplicate rail ownership.**
  - **Files:** `web/app/(app)/layout.tsx`, `web/components/chrome/{left-rail,left-rail-nav,left-rail-route,rail-collapse,top-nav}.tsx`, new `web/components/chrome/mobile-rail-drawer.tsx` and a narrowly scoped client trigger/provider if needed, relevant message files, and rail/browser tests.
  - **RED → GREEN → refactor:** first add a role-projected nav-data test and a 375px browser test for opening the drawer, keyboard focus, Escape, route navigation, and restoring focus to the trigger. Then reuse the existing rail-data/section source in the drawer; refactor only after proving a single definition and mounted instance per visible surface.
  - **Deliverable:** add the already-accessible Observatory route to the persistent rail using the exact role/access model of its page and retain a clear Portfolio link. Replace the below-`md` absence of navigation with a hamburger-controlled HeroUI drawer. The server-owned rail data/sections are reused by desktop and mobile, but the mobile rail content mounts only while its drawer is open; there is no second persistent copy of scratch popovers, hotkeys, or nav state. The drawer traps focus, locks background scrolling, closes on Escape and route change, restores trigger focus, and leaves current MCP components untouched. Remove the existing `RailCollapse` client `console.debug` while touching this navigation path.
  - **Acceptance:** Observatory is reachable for every role already allowed by its route; every permitted rail section is reachable at 375px; focus/scroll/Escape/route-change behavior is accessible and deterministic; desktop/mobile share section definitions without mounting duplicate interactive rail controls; no `McpPanel`, `mcp-bind-dialogs`, or `McpSelect` file changes occur.
  - **Logging:** drawer and rail UI emit no client logs; existing route access diagnostics remain unchanged.
  - **Depends on:** Tasks 3 and 8.

- [x] **Task 11: Confirm package-trust fan-out with the exact affected-project count.**
  - **Files:** `web/lib/queries/packages.ts` or the established package read-model owner, `web/app/(app)/projects/[slug]/page.tsx`, `web/components/board/panels/project-packages-section.tsx`, shared feedback components/messages, and focused query/component/browser tests.
  - **RED → GREEN → refactor:** first make a query test fail for multiple attachments of the same `packageInstallId`, attachments for another install, and repeated revisions of the same package. Add a browser confirmation test that proves no trust request before confirmation and the existing request payload after confirmation. Then add the smallest server read-model field and reuse Task 3’s dialog.
  - **Deliverable:** before the existing global-admin trust operation, show the shared confirmation including `COUNT(DISTINCT projectPackageAttachments.projectId WHERE packageInstallId = selected install)`. Treat that server-read count as advisory snapshot text only: preserve the existing authorization and POST behavior even if attachments change before submission. Do not add an endpoint, client count, or second trust semantics.
  - **Acceptance:** the count includes exactly projects attached to the selected install and no other install; cancellation sends no request; confirmation sends the unchanged route/payload; the route’s global-admin enforcement remains authoritative and unmodified.
  - **Logging:** preserve existing trust action diagnostics; no browser logging of counts or confirmation choices.
  - **Depends on:** Tasks 3-4 and 8.

- [x] **Task 12: Remove the PR board tab and its deferred-panel implementation completely.**
  - **Files:** `web/components/board/{project-tabs,board}.tsx`, `web/components/board/panels/deferred-panel.tsx` (delete), `web/app/(app)/projects/[slug]/page.tsx`, related tab types/tests, and `web/e2e/portfolio-board.spec.ts`.
  - **RED → GREEN → refactor:** first fail the existing tab/route tests for `prs`, invalid-tab fallback, and rendered PR placeholder. Then remove the type, validation, rendering branch, import, and component in one coherent change; refactor stale test naming/copy after green.
  - **Deliverable:** delete `prs` from `ProjectTab`, `TABS`, validation, URL/page handling, imports, and the deferred panel itself. Preserve the established fallback for an invalid/deep-linked tab without widening routing behavior.
  - **Acceptance:** PRs no longer exists in DOM, URL validation, source imports, or the tree; an invalid prior `?tab=prs` input follows the documented existing fallback; no board API/query behavior changes.
  - **Logging:** no client logs; existing board diagnostics remain unchanged.
  - **Depends on:** Tasks 2 and 10.

- [x] **Task 13: Reuse one guarded review/promotion operation from the run header and inspector.**
  - **Files:** `web/components/runs/{run-header,run-shell,review-panel}.tsx`, `web/lib/runs/inspector-actions.ts`, a new shared promotion operation/hook only if that is the smallest way to share request logic, messages, and focused tests.
  - **RED → GREEN → refactor:** first make request-body parity and refusal-path tests fail for the header and inspector: unavailable mode, missing `reviewedTargetCommit`, truncated diff, target drift, and immediately promotable review. Then extract the shared operation, make header primary action open/focus the existing Review panel when not immediately promotable, and use the same operation when it is promotable. Add one browser scenario for each reachable header result.
  - **Deliverable:** expose Review/Promote in a Review run header without bypassing existing inspector logic. If the run is not immediately promotable, the header’s primary action opens/focuses the existing Review panel. If it is immediately promotable, the header invokes the shared operation with the same mode, `reviewedTargetCommit`, diff-truncation, target-drift, readiness, and request-payload checks as the inspector. No duplicate promotion helper may drift from that guard set.
  - **Acceptance:** header promotion is behaviorally and payload-identical to inspector promotion; every refusal remains impossible/explicit in both surfaces; no promotion can proceed with stale target, truncated diff, missing reviewed commit, or disallowed mode; existing server-side promotion semantics remain unchanged.
  - **Logging:** retain existing promotion action diagnostics and classifications; header UI emits no client logs.
  - **Depends on:** Tasks 4, 6-7, and 10.

**Phase 3 exit gate:** the focused navigation, trust, board, and promotion unit/integration suites are green, and every provider/operation has exactly one source of action truth before cross-surface E2E begins.

### Phase 4: Cross-surface tests, as-built docs, and validation

- [x] **Task 14: Add only cross-surface runnable coverage and migrate stale assertions.**
  - **Files:** focused E2E specs such as `web/e2e/portfolio-board.spec.ts`, `web/e2e/studio.spec.ts`, and one new explicitly named UI-completion spec if needed; existing component specs only where an assertion must be updated; `web/playwright.config.ts` only to register its stem in `AUTHED_SPEC`.
  - **Deliverable:** wire the per-task RED/GREEN coverage into minimal end-to-end journeys: one shared-confirmation sync flow, stream interruption/replay, checklist/zero-flow remediation, 375px drawer/HITL access, Observatory navigation, PR absence/deep-link fallback, trust fan-out copy, and header Review/Promote parity. Migrate expectations that previously required raw codes, default-open budget, or the PR placeholder. Scope Playwright commands to explicit files and the shared `3100`/`7788` infrastructure; do not add jsdom or duplicate unit-like happy paths.
  - **Acceptance:** every new `*.test.ts` already added by its implementation task matches `web/vitest.workspace.ts` unit includes (prove with the runner’s list/filter); every E2E filename matches `AUTHED_SPEC`; E2E proves replay-preserving reconnect, portal/focus confirmation, and real mutation action wiring rather than only CSS state. This task adds no feature’s first RED test.
  - **Logging:** test fixtures may capture existing structured test output only; no production logging is introduced.
  - **Depends on:** Tasks 3-13.

- [x] **Task 15: Finish as-built docs and execute the complete scoped validation matrix.**
  - **Files:** Phase-0 documentation files plus any test config changed in Task 14; no unrelated production files.
  - **Deliverable:** flip the Phase-0 docs from Designed to Implemented where the delivered source proves it, reconcile exact component paths/namespaces, update the SDD evidence matrix with final test commands/results, and validate the no-contract-change decision. Run typecheck, changed-file ESLint check only (never the formatting lint script), web and supervisor unit/integration suites, i18n parity, docs validation, targeted E2E, and a full E2E baseline comparison.
  - **Acceptance:** run `pnpm --dir web typecheck`, `pnpm --dir supervisor typecheck`, `pnpm --dir web test:unit`, `pnpm --dir web test:integration`, `pnpm --dir supervisor test:unit`, `pnpm --dir supervisor test:integration`, the repository i18n-parity check, and `CI=true pnpm validate:docs:all`. Run Playwright first by explicit target paths and then compare a full-suite run against the Task-2 baseline: all new/affected tests must be green and no newly failing non-target spec may appear; only a demonstrably baseline-red ICU class may flip green. Do not claim the full suite is green while owner-excluded baseline failures remain red. Verify `git diff --check`, MCP-surface exclusion, zero `window.confirm`, raw-code sentinel, no client `console.*` added, and no migration/API/engine/deployment diff.
  - **Logging:** retain command output as validation evidence; do not add a checked-in report or browser diagnostics.
  - **Depends on:** Tasks 0-14.

## Implementation order and risk controls

1. Land the docs-first commit and baseline before touching UI source. This establishes the UI contract without inventing any backend work.
2. Land feedback primitives before changing consumers so mutations, errors, and confirmation flows converge instead of creating new one-off patterns.
3. Keep stream reconnect timed and replay-based, not polling-based; test timer cleanup to prevent hidden retries after navigation.
4. Shape onboarding and trust data only in existing server queries. Do not add client-side guesses or routes simply to render a count/state.
5. Isolate `launch-popover.tsx` and `projects/[slug]/page.tsx` work, then rebase before final validation because both are active integration hotspots.
6. Treat the existing Studio ICU correction as a verification target. A redundant source patch would create churn and conceal the true baseline.

## Verification scenarios

- Kill a live stream: each affected surface shows disconnected/reconnecting state within the retry interval; reconnect resumes from `lastEventId` with no page reload.
- Throw at root, run, project, and Studio segments: the themed EN/RU boundary explains the problem, exposes the code only in its diagnostic field, resets, and returns to Portfolio.
- Navigate portfolio → board → run: each route displays a skeleton before content, never an empty pane.
- Fail launch, task creation, takeover, assignment, HITL, promotion, package, and settings mutations: controls never display raw error codes; localized feedback and relevant inline recovery render through one toast/error contract.
- Start from a fresh admin install: the three-step checklist advances from connected project to enabled package/flow to launched task. A member instead sees an ask-an-admin state and no 403-bound CTA.
- Open New Task with zero enabled flows: the install-package link targets the packages tab and the flow selector is not silently empty.
- Open launch: only Flow, runner, and preset are immediately visible; disclosures preserve the remaining controls; version adoption opens only for newer cut/uncut edits.
- Navigate using rail and mobile drawer: Observatory is reachable, PRs is absent, every rail section is reachable at 375px, and a Review run exposes the same Review/Promote operation as the inspector.
- Confirm package trust: the dialog shows the real fan-out project count before the unchanged trust request; Studio abort/discard and budget-drop no longer invoke native confirmation.
- Render Studio package detail/composition in EN/RU: no formatting error and i18n parity is green.

## Next step

Review this plan, then run `$aif-implement` from `feature/ui-completion-batch`.
