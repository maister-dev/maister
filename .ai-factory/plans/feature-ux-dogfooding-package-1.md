# Implementation Plan: UX dogfooding package 1

Branch: `feature/ux-dogfooding-package-1`
Created: 2026-11-11
Status: Refined, ready for specification preflight.
Inspection base: `f38053b3192a24738c8b0920852cfd229c56721f` (local master)

## Settings

- Testing: yes. Every behavior change follows RED → GREEN → REFACTOR after the owning specification is accepted. Prefer authenticated Playwright and existing Vitest integration with real temporary Git and Postgres. One primary owner per assertion. Add no unit tests that duplicate a journey or mirror implementation.
- Logging: standard structured domain failures. Reuse existing log boundaries.
- Docs: yes, limited to affected contracts. Specification precedes code.
- Preserve permissions, package provenance, historical Run bindings, admission and promotion semantics, and transcript continuity. Keep EN/RU, HeroUI, existing design tokens and light/dark themes.

## Roadmap Linkage

Milestone: none. Skipped by user.

## Research Context

The 11 November 2026 authenticated audit of `app.imaister.dev` supplies the deployed observations. This planning session reached sign-in. Authenticated re-verification and deployed revision parity are unverified.

| ID | Audit observation | Local source at the inspection base |
| --- | --- | --- |
| UX-01 | Both same-name package cards and a project link lead to a non-interactive source chooser. | The loader already groups by source and name and projects version install IDs. The links discard the ID. Member routes refuse ambiguous names. |
| UX-02 | New task leaves focus behind the overlay, has no name and ignores Escape. | The hand-built dialog lacks those primitive behaviors. Existing idle close paths preserve the draft. |
| UX-03 | At 1440×1000 editor Fit leaves four of 11 nodes fully visible. Artifact + Current strands seven matching nodes. | The editor uses default XYFlow fit bounds. Evidence relayout changes positions without requesting a fresh fit, and can mount hidden. Measure the actual editor geometry with locked XYFlow 12.12.0 before setting a floor. The older installed 12.11.0 defaults to 0.5. |
| UX-04 | Brain reports that the concrete bracketed path is a glob. | Git identifies the audit path as a blob. The reader reapplies wildcard detection after expansion and the indexer classifies exact peers from the raw selector. |
| UX-07 | Running Triager awaiting its result shows a large READY card. | The shared enforcement rollup returns ready for an empty set and for clear contributions. The Run layout projects that result across Run kinds. |
| UX-09 | Jump is visually displaced and the bare History link opens the agent Run list. | Shared transcript rendering uses different control patterns and a sticky offset. Its newer flag can also mean a later retained window. The body link opens project-scoped agent history. No cursor or anchor defect was established in planning. |

Provisional Playwright listing found 59 cases plus auth setup using installed Playwright 1.60.0. Task launch and agent activity collection hit Zod 3 versus the lockfile's Zod 4. Vitest config temp-file writes were blocked in the primary checkout with installed Vitest 2.1.9. The active worktree lacks dependencies. No behavioral tests ran.

Scope stops at these six fixes. Preserve the same-project package attachment constraint and the package cut/adoption workflow. Evidence IA, MAI-14, launch bindings, worker recovery, production reindex, broad Run/Librarian redesign and lifecycle changes are outside this package.

## Specification ownership and Phase 0 exit

| Owner | Required specification delta |
| --- | --- |
| `docs/system-analytics/flow-packages.md` and `docs/screens/studio/package-viewer.md` | Addressable installed revision, legacy route decision table, member/back/version link propagation, project attachment authorization, and exact-or-unavailable historical provenance. The screen links to the analytics for behavior. |
| `docs/system-analytics/local-packages.md` and `docs/api/web.openapi.yaml` | Both existing Studio fork operations accept the same optional `install` selector. Publish parameter shape, matching/refusal examples and exact existing success/error semantics. Link to the existing side-effect and cleanup flow. |
| `docs/system-analytics/project-brain.md` and `docs/api/web.openapi.yaml` | Selector grammar, examples for exact escaped and mixed glob, source authorization and status table, persisted selector versus concrete Git path, exact-peer exclusion, and failed-blob handling. |
| `docs/system-analytics/tasks.md` and `docs/screens/projects/project-board.md` | Keep the task creation process and payload contract. Specify named modal, draft and failure transitions, focus return and short-viewport behavior on the board. |
| `docs/system-analytics/flow-studio.md`, `docs/system-analytics/workbench.md`, `docs/screens/studio/editor.md`, `docs/screens/runs/workbench.md` | Specify viewport triggers, measurement prerequisites, override by deliberate interaction, empty and singleton behavior, and the evidence filter URL contract. Keep editor and evidence trigger policies explicit. |
| `docs/system-analytics/readiness.md`, `docs/system-analytics/agent-activity-history.md`, `docs/screens/runs/flow-run.md`, `docs/screens/runs/child-run-peek.md` | Record the Run display matrix, evidence provenance, the agent header link and list return behavior, and transcript control behavior across main and peek. Update only existing prose that asserts changed behavior. |

Use existing analytics sections. For each changed process, record inputs and authority, the normal and refusal/cancel paths, expectations with the enforcement point and acceptance IDs below, and linked artifacts. Use the existing R5 structure and mark proposed behavior **Designed**, then mark it **Implemented** after verification. Screen docs describe visible behavior and link to the owning process. Preserve existing execution state diagrams. Run the repo's docs and contract validators and review examples against the intended handler outcomes before behavior edits. No new system analytics file is needed.

### API decision tables

| Contract | Decision and outcome |
| --- | --- |
| Studio page `/studio/packages/{ref}` and Flow, skill, agent and subagent descendants | `ref` is the exported name. `install` is one optional, nonempty, bounded identifier using the existing stored ID domain. Decode URL values once using the framework boundary. If supplied, require the exact ID and name in the visible installed catalog. Malformed, empty, repeated, mismatched, removed or unknown IDs give not-found. If absent and unique, redirect to that group's first catalog version with an explicit ID. If ambiguous, render named source/version choices targeting the same route and valid `tab`/`page`. A chosen source without that member reaches the usual member not-found state. |
| Studio `POST /api/studio/packages/{ref}/fork` and `.../fork-element` | Resolve the same exact install before any fork side effect, using `ref`/query `install` from the URL and the existing active global member gate. With no selector, retain the unique-name default and ambiguous 404 `NOT_FOUND`. Explicit invalid/foreign/removed selectors also give 404. Unauthenticated 401, insufficient/inactive/password-change state 403. Whole fork returns existing dedup 200 or creation 201. Element returns 201. Preserve existing 400/409 domain errors and element validation 422. Document actual auth response shape and include the currently omitted 403. |
| Fork action inputs and persistence | The install, source bundle and exported name are server-derived. Whole-fork `forceNew`/`customize` are body-controlled choices, never resource identifiers. Element `elementPath` is body-controlled and remains confined by the existing source/destination service checks. `elementName` is display input. Reuse the existing slug claim, copy/Git initialization, compensation and success-after-completion service. Whole-fork dedup remains by exact `sourceInstallId`; element forks preserve their partial-copy contract. No additional writes or side effects in the resolver. |
| Brain `POST /api/projects/{slug}/brain/sources` and `PATCH .../{sourceId}` | URL identifiers select an authorized project/source, with `editSettings` from the active session. Resolve repo and branch from that project. `path` is a body-controlled selector limited to 512 characters; validate it and the resolved repo-relative path. POST 201, PATCH 200. Retain 401/403, 422 `CONFIG` for invalid input/path and 404 `PRECONDITION` for missing/out-of-project resources or a source with no readable match under the existing registration rules. A glob that enumerates a binary or oversized file fails at indexing if that file is discovered only during indexing. Keep the existing source response and job status contract. |
| Existing read/stream contracts | Studio returns platform installed package content via the existing session guard. Project repository content still requires `readRepoFiles`. Attachment management and trust keep their existing grants. Brain GET metadata retains `readBrain`. Task creation, evidence payloads, external `ReadinessDTO`, transcript cursors/downloads, Run event replay and child authorization keep their present wire formats. Verification and display name additions are internal page projections. |

### Persistence and migration decision

- **No migration.** `package_installs.id`, its source/name/SHA, `project_package_attachments.package_install_id`, `flows.package_install_id`, `runs.flow_revision_id` and `runs.flow_revision` already provide the identities this package uses. The Flow's current install is mutable and cannot stand in for a Run pin. `flow_revisions` lacks a package-install FK. For a historical Studio link require a unique source/member/SHA match verified server-side. Keep the pinned Run or revision readable when its historical Studio target cannot be established. Never backfill guesses or use the Run's digest-only badge as link authority.
- Brain keeps the selector spelling in `brain_sources.path` and concrete paths in `brain_chunks.path`. Leave existing persisted glob expressions, the source uniqueness key and job records intact. Coverage exercises existing rows as well as new escaped input. A newly successful indexing attempt writes through the existing indexing path. No automatic reindex or data rewrite is part of this package.
- Keep Drizzle schema, both migration lineages and journals, ERDs, deploy wiring and dependency manifests outside the diff. Verify with the scoped diff and `pnpm --filter maister-web db:erd --check` through the docs gate. If implementation uncovers a proven persistent contract gap, amend the spec first with the exact missing datum, lossless existing-row behavior or explicit refusal, and fresh/incremental migration tests. Do not substitute a schema change for ambiguous provenance.

## Tasks

### Phase 0 — Specification and baseline

- [ ] T0. Complete the specification ownership table and preflight. Read the installed Next, HeroUI and XYFlow source for the APIs used. Confirm the locked runner can collect and execute the affected lanes. Capture the original 11-node and seven-artifact bounds with dedicated fixtures. Record the baseline and any independently verified existing failures. Freeze API examples, migration decision, expectation IDs and test owners before touching behavior code. No additional logging required.

### Phase 1 — Package identity and Brain paths

- [ ] T1. Address and resolve exact Studio install identity. Depends on T0. Acceptance UX-01A–D.
  - Paths: `web/lib/studio/load.ts` and one client-safe URL builder under `web/lib/studio/`. Apply one resolver to `web/app/(app)/studio/packages/[ref]/page.tsx` and its `flows/[flowId]`, `skills/[...path]`, `agents/[stem]` and `subagents/[stem]` pages. Use the same selector parser in `web/app/api/studio/packages/[ref]/{fork,fork-element}/route.ts`. Reuse the existing auth and action helpers.
  - Propagate identity through `web/components/studio/{packages-list,package-detail,studio-flow-viewer,element-card,fork-to-edit-button,element-fork-button}.tsx`, including Customize, version list, BOM counts, tab/page, back links and action inputs. Merge query parameters after joining member segments. Catalog cards pin the version they show. An attached project slot can be occupied by a different source/version. Preserve the conflict guard and distinguish an occupied slot from this exact install being attached.
  - Project paths: `web/lib/queries/project-package-contents.ts`, `web/components/board/panels/{project-package-contents,project-packages-section}.tsx`, and `web/app/(app)/projects/[slug]/packages/[flowRefId]/page.tsx`. The attachment row uses its existing immutable install ID. Project Flow detail may use that ID when its selected revision matches the installed member source and SHA. For an older selection require a unique candidate consistent with its immutable source path, member and SHA. Where the mapping is absent or ambiguous, offer a localized unavailable state and retain the pinned view. No changes to Run persistence or loading. Keep existing structured action logs with the resolved install ID. No navigation logs.
- [ ] T2. Parse Brain selectors and consume exact Git paths. Depends on T0. Acceptance UX-04A–C.
  - Paths: `web/lib/brain/{sources,indexer}.ts`. Keep `web/lib/worktree.ts` as the validated literal Git reader. At the selector boundary, ordinary paths retain exact behavior, and escaped metacharacters allow an exact literal such as `web/app/\[slug\]/page.tsx`. Define the escapes for `*`, `?`, `[`, `]`, `{`, `}` and preserve literal backslashes according to the existing matcher semantics. A selector with unescaped glob operators stays a Picomatch pattern, including mixed escaped and unescaped segments. Preserve successful stored pattern behavior and use a conservative search root. Never try a glob after an exact lookup fails.
  - Share selector classification across registration, update, enumeration, indexing dispatch and peer ownership. Decode exact peers before comparing to concrete Git paths, scoped to the same enabled project and kind. A tracked match is always read literally, with the existing ref and limits. Keep bounded batches, deterministic ordering, hash/retirement semantics, missing/binary/oversize errors and the no-match versus all-excluded distinction. Use existing structured source/job warnings and `last_error`. No additional logging required.

### Phase 2 — Modal and graph viewports

- [ ] T3. Port New task to the installed HeroUI compound Modal. Depends on T0. Acceptance UX-02A–B.
  - Paths: `web/components/board/new-task-modal.tsx`, project board label wiring in `web/app/(app)/projects/[slug]/page.tsx`, and `web/messages/{en,ru}.json` for changed copy. Refer to edit-task for bounded layout, attach-package for error feedback, and launch/memory for interaction conventions. Limit implementation to New task.
  - Visible title names the modal. Focus Title first, wrap keyboard focus in both directions, restore to the opener, and isolate background pointer, accessibility and scrolling. Idle Escape, Cancel, close and backdrop preserve the draft across reopen. Keep actions visible with a bounded, independently scrolling body. A pending POST prevents duplicate submission and dismissal. On validation or request failure, keep inputs and provide a localized accessible, actionable error. On success, clear the draft, close and refresh. Keep flowless and explicitly selected launchable Flow submissions and the existing POST shape. No additional logging required.
- [ ] T4. Fit the measured Flow editor. Depends on T0. Acceptance UX-03A–B.
  - Paths: `web/components/flows/{flow-graph-editor,flow-editor-tabs}.tsx`, `web/components/studio/local-package-editor.tsx`, `web/lib/flows/editor/editor-labels.ts` and EN/RU messages. Use a shared fit helper only where T5 needs the same bounds calculation. Keep the read-only Flow renderer outside the changes.
  - Fit on first visible layout and explicit Fit with the same padding and bounds. Choose a floor from the fixture's measured required scale and cap singleton magnification. Refit on usable canvas resize in overview mode. User pan, wheel/pinch, zoom controls, minimap and locate enter manual mode. Preserve their camera across inspector, rail, ordinary updates and same-Flow editor reseeds. Reset on Flow identity change. Reuse the Studio picker/selection pattern for a keyboard-operable locate action that centers at a readable scale. The 11-node fixture must allow real clicks on first and last nodes without automatic scroll to an off-canvas element. No additional logging required.
- [ ] T5. Fit visible Evidence after URL filters change. Depends on T0 and T4's agreed fit bounds contract. Acceptance UX-03C–D.
  - Paths: `web/components/board/{evidence-graph,evidence-graph-section}.tsx`, Run layout label wiring and EN/RU messages. Fit after initial visible layout and after the normalized `node`/`kind`/`state` tuple changes, including browser history. Wait for filtered nodes and the visible pane to have dimensions. Keep `wb` and unrelated URL state. Same-filter data refresh and payload selection preserve deliberate pan/zoom. Resize refits only in overview. Keep existing payload open/close and keyboard behavior.
  - All seven matching nodes must fit without manual recovery. Preserve a way to change filters when results are empty. Cap singleton magnification and reuse the locator pattern when dense matches need a readable view. Use existing theme and accessible labels on camera controls. No additional logging required.

### Phase 3 — Run presentation and transcript controls

- [ ] T6. Present verification and executor history accurately. Depends on T0. Acceptance UX-07A–C.
  - Paths: `web/app/(app)/runs/[runId]/layout.tsx`, `web/lib/queries/readiness.ts`, `web/components/run/readiness-summary.tsx`, EN/RU messages, and `web/components/runs/review-panel.tsx` only for any redundant copy. Share the existing query inputs and contribution classifier without changing `getRunReadiness` output or adding a second full query in the same layout. Use a private typed display projection with typed gate/artifact reasons so labels and actions can be translated. Scope any next-action links to existing grants and routes.
  - Derive known declarations from a compatible immutable Run pin. A legacy mutable manifest cannot prove absence of configuration. Include relevant engine-generated requirements, such as consensus artifacts, or use an unknown state until applicability is established. Use existing gate policy and artifact semantics. Positive wording covers recorded evaluations only. Preserve board/portfolio rollups and Review/merge/admission/guard semantics. In the historical failure translation path, describe the attempt and direct users to check current availability before retry. The immediate request error retains its separate meaning. No additional logging required.
- [ ] T7. Align transcript controls and move agent history to Run context. Depends on T0. Land the shared layout wiring after T6. Acceptance UX-09A–C.
  - Paths: `web/components/runs/run-transcript-history.tsx`, `run-transcript-panel.tsx`, and where needed `run-peek-transcript.tsx`/`run-peek-panel.tsx` in the same directory. Use consistent HeroUI/button styling for earlier, later, jump and retry. Put earlier loading/error/retry at the top boundary. Reserve space or use an in-transcript control with correct containment so its appearance does not shift the reader's anchor. Respect the main document scroll owner and the nested peek owner. Jump stays clickable within the transcript with inspector, composer or Librarian present.
  - Reuse the current anchor, retry, bounded pages, oversized records, request ordering and follow-tail mechanisms. A retained later page alone means **Later messages available**. An observed live advance can announce **New messages** through the existing refresh flow. Keep auto-follow paused while reading, and resume through the existing Jump path. Avoid new cursor, stream, scroll owner or polling.
  - Paths for navigation: `web/lib/queries/run.ts`, Run layout, `web/components/runs/{run-shell,run-header}.tsx`, EN/RU messages. Show **All {agent} runs** only when a project/source-agent identity exists. Use the Run's stored display name, then authorized existing name resolution or the agent ID. Link to that project's agent page with `tab=history`. Keep task-attempt navigation separate. Next Link and browser Back restore the exact originating filter/cursor URL. No additional logging required.

### Verification display matrix for T6

| Proven Run/evidence condition | Visible result |
| --- | --- |
| Flow with a recorded failed, stale, blocked, waiting or overridden contribution | Existing precedence `failed > stale > blocked > waiting > overridden`. Label it **Flow verification**. Keyboard disclosure gives the affected gate/evidence, reason and permitted next action. |
| Flow with a known pinned definition and no applicable declared or engine-generated checks/evidence | Neutral **No blocking checks configured**. Known policy exclusions use **Checks excluded by policy** when applicable. |
| Flow with configured checks without evaluations | Neutral **Not yet evaluated**. Incomplete recorded coverage can describe the recorded subset. |
| Flow with unknown pin, applicability or verification evidence | Neutral **Verification unavailable** unless specific recorded evidence can be shown truthfully. Never infer absence of checks from empty ledger arrays. |
| Flow with recorded clear checks | **Recorded checks clear**, scoped to observed blocking gates and required evidence. A Running Run stays visibly Running. |
| Operational and other agent Runs | Existing execution status and results/waiting. No Flow verification indicator. |
| Scratch | Existing session and execution presentation. No Flow verification indicator. |
| Historical execution failure of any kind | Past-tense attempt diagnostic. Present host availability only from an existing current signal. |

## Acceptance and test ownership

`E2E` means `web/playwright.config.ts` project `authed` with auth setup. Spec names in that column live under `web/e2e/`. `IT` means `web/vitest.config.ts` → `web/vitest.workspace.ts` project `integration` with a discoverable `*.integration.test.ts` file. Label new or extended primary scenarios with the IDs below. Group related assertions in a scenario and use a parameter table when only inputs vary. The local regression cases use the seeded harness, real Git and DB where indicated, and no real supervisor or model provider.

| Acceptance ID → task | Primary owner | Observable assertion and fixture |
| --- | --- | --- |
| UX-01A, UX-01B → T1 | E2E `package-management.spec.ts` | Isolated temporary upstream Git repo and local cut with the **same exported name** and distinguishable members/content. Verify both catalog cards and both authorized project contexts open their own content, including an older attachment after a newer version is installed. Click version, member and return links and verify exact identity across reload and Back/Forward. Exercise legacy root and nested chooser without a silent winner and a unique legacy redirect. |
| UX-01C → T1 | E2E `package-management.spec.ts` | Use the same collision fixture as UX-01A/B. Verify exact whole-fork persisted origin/dedup and exact element content. Parameterize malformed, repeated, mismatched, unknown/removed and ambiguous legacy action selections across the two operations. Assert 404 and no fork. A viewer gets 403 and an authorized member succeeds. Run `forked-package-loop.spec.ts` as the existing rename/adoption workflow control. |
| UX-01D → T1 | E2E `flow-package-viewer.spec.ts` | Seed a Flow Run pinned to the old revision. Change the enabled/install context and follow the existing Run link. Assert the old manifest/revision is still displayed. Exercise exact project Flow-to-Studio provenance for a selected historical revision and unavailable when it cannot be uniquely proven. Keep the authorization assertion in `web/lib/queries/__tests__/flow-package-detail.integration.test.ts` as the existing source-scope control. |
| UX-02A, UX-02B → T3 | E2E `task-edit-fields-scroll.spec.ts` | One new scenario on the real seeded board at a short/narrow viewport. Use the named modal and Title focus, Tab/Shift+Tab wrap, background lock, Escape/opener restoration, draft on reopen and reachability of both footer actions. Assert empty required input blocks submission. Inject one deterministic request failure at the boundary, verify entered fields and announced retry guidance, then allow the actual local flowless POST to return 201 and show the new board row. Keep selected-Flow POST smoke in `task-launch-gating.spec.ts`. |
| UX-03A, UX-03B → T4 | E2E `studio-local-edit.spec.ts` | Representative 11-node valid local package and explicit 1440×1000 viewport. Assert every rectangle fits the actual padded canvas after Fit, and click first and last without forced dispatch or scrolling the test target into view. Resize and change rail/inspector, prove user camera persists after manual action and same-Flow reseed, and select a distant node by keyboard at a readable zoom. Exercise editor empty and singleton controls via the same fixture builder. |
| UX-03C, UX-03D → T5 | E2E `m12-evidence-graph.spec.ts` | Seed seven current artifacts using `web/e2e/_seed/seed-e2e.ts`. Activate the previously hidden pane, select Artifact + Current, and assert all seven rectangles before any manual Fit. Open a payload through normal UI. Exercise URL/Back, zero and one match, and unchanged filter with a refresh after manual zoom. Retain the actual payload and board-badge checks. |
| UX-04A, UX-04B → T2 | IT `web/lib/brain/__tests__/sources.integration.test.ts` | Real Git includes `[slug]` and a sibling matched by its unescaped class. Create/update escaped exact and mixed glob inputs and verify literal or expanded paths. Retain normal glob semantics, branch confinement, invalid selectors, untracked paths and precise binary/size errors. Use the existing [source route tests](../../web/app/api/projects/%5Bslug%5D/brain/sources/__tests__/routes.test.ts) for auth/status characterization when an assertion needs migration. |
| UX-04C → T2 | IT `web/lib/brain/__tests__/indexer.integration.test.ts` | Run the owning source-index sweep over temporary Git and migrated pgvector with the deterministic embedding boundary. Assert real chunk paths/content, decoded exact-peer exclusion, successful stored glob behavior, and explicit `last_error` for a batch containing an unreadable blob. Retain `reindex.integration.test.ts` as the existing queue regression. One local Brain source-list smoke checks the indexed path and source status using the seeded result. |
| UX-07A → T6 | IT `web/lib/queries/__tests__/readiness-ssot-consistency.integration.test.ts` | Use real DB and valid pinned manifests for known-empty, policy-excluded, configured/unevaluated, unknown pin, recorded clear and engine-generated applicability. Parameterize typed display reasons for existing failed, stale, blocked, waiting and overridden fixtures where needed. Preserve the existing empty-enforcement-ready expectation and public DTO shape. Retain current guard assertions in `readiness-overridden-skipped.integration.test.ts` and `readiness-external.integration.test.ts`. |
| UX-07B, UX-07C → T6 | E2E `m15-readiness.spec.ts` | Exercise compact disclosure on the existing failed/overridden fixtures, with real keyboard access to reason/next action. Assert no success claim for known-empty, Running plus recorded checks does not imply completion, and a Running operational Run awaiting result has no Flow verification. Seed a historical executor failure and verify the copy does not assert current health. Check Scratch presentation on the existing Scratch fixture during package smoke. |
| UX-09A, UX-09B → T7 | E2E `run-transcript-history.spec.ts`, `child-run-peek.spec.ts` | Extend the existing 250-message main fixture for control bounds/hit testing, failed earlier load and retry, anchor preservation, live notification and jump-to-follow. A child case owns nested containment and retains its distinct bounded/oversized/download and stale-response assertions. Check older retained windows alone do not announce a live advance. |
| UX-09C → T7 | E2E `platform-agents-activity.spec.ts` | Existing real DB history with signed cursor. Open a filtered, paged result, verify the header link's label and destination, and use browser Back directly from the Run to assert the exact originating URL and rows. Then follow the header link and confirm the explicit agent History tab. Keep `run-task-context.spec.ts` for the distinct task destination. |

### Existing assertion migrations

- T1: revise name-only generated href expectations in `web/components/studio/{packages-list,package-detail}.test.ts` and `web/components/board/panels/__tests__/{project-packages-section,project-package-contents}.test.ts`. Extend `web/lib/queries/__tests__/project-package-contents.test.ts` fixture for the projected install ID. Keep the legacy deep link in `studio-package-viewer.spec.ts` and assert its canonical resolution.
- T3: scope the existing selected-Flow input and submit selectors in `task-launch-gating.spec.ts` to the named modal. Keep the edit-task scroll regression as written.
- T4/T5: retain `flow-editor.spec.ts`, `m27-flow-editor.spec.ts`, and `flows-authoring.spec.ts` for authored editor, persistence and validation. Use the canvas geometry assertion in M12 in place of assuming DOM visibility implies viewport inclusion. Keep `web/lib/queries/__tests__/evidence-graph.integration.test.ts` for graph data, and retain the documented existing M12 skip with its integration owner.
- T6: replace the M15 generic Readiness heading and CSS list selectors with scoped disclosure selectors. Keep board/portfolio badge expectations and existing rollup assertions. Migrate `web/components/run/__tests__/readiness-summary.test.ts` for the new presentation contract and update review/terminal-cause tests only where copy actually changes.
- T7: migrate the exact **History** link next to Retry in the agent body to the header location. Keep accessible controls and existing transcript test IDs where possible. Change an assertion only when its observed contract changes.

## TDD and validation gates

1. **RED.** After T0, write or extend the primary scenario(s) for a task against the original behavior. Run and record the exact test and expected failing behavioral assertion. Setup, discovery and timing failures do not qualify. Already-correct invariants serve as green controls. Keep fixtures isolated so a failure in a longer workflow cannot prevent discovery of the new regression.
2. **GREEN.** Apply the smallest behavior change that satisfies the accepted spec and makes the focused suite green. Exercise the normal entry point. Keep scoped permissions and existing caller semantics. Fix mismatches in the owning logic. Update the specification before implementation if a verified constraint requires a decision change.
3. **REFACTOR.** Remove duplication only where consumers share the same contract. Prefer single-purpose typed functions and the existing owner primitives. Follow SOLID, KISS, DRY and project rules. Run the focused tests again after refactoring and the phase gates below. Do not mark a task complete until every mapped acceptance criterion and its required tests pass.

Use a writable checkout with Node `>=24.15.0 <25` (CI `24.19.0`), pnpm `11.3.0`, frozen dependencies, Chromium, Git, and reachable Docker/Testcontainers. Use loopback for Playwright. The wrapper starts and cleans up its disposable migrated pgvector database, Git fixtures, Next server and test-supervisor harness. Use the existing Testcontainers harness for Vitest integration. Avoid inherited deployment URLs or provider credentials.

```bash
pnpm install --frozen-lockfile
pnpm --dir web exec playwright install chromium

DB_URL=postgres://unused:unused@127.0.0.1:1/unused \
E2E_BASE_URL=http://127.0.0.1:3100 \
pnpm --dir web exec playwright test --config playwright.config.ts --project authed --list <spec-files>
pnpm --dir web exec vitest list --project integration --filesOnly <integration-files>
pnpm --dir web exec vitest list --project unit --filesOnly <migrated-unit-files>

env -u E2E_BASE_URL pnpm --dir web test:e2e --project authed --workers=1 <spec-files>
pnpm --dir web test:integration <integration-files>
pnpm --dir web test:unit
pnpm --dir web test:integration
pnpm --dir web typecheck
pnpm --dir web exec eslint <changed-ts-tsx-files>
pnpm validate:docs:all
pnpm validate:contracts
git --no-pager diff --check
```

- **T0 exit:** Owner documents contain complete decisions, refusal behavior, enforcement points, and acceptance IDs. Schema/migration disposition is explicit. Test listing identifies each promised case/file in the expected runner, and the locked baseline is recorded.
- **Each behavior phase:** All affected tests actually execute and are green, including migrated assertions. Run the full Web unit and integration projects, scoped E2E, typecheck, lint and relevant contract validators. Do not skip a changed scenario. Independently reproduced unrelated baseline failures require explicit recorded disposition and a tracked follow-up if quarantined.
- **Package exit:** Run all affected E2E specs together and the repository docs/contracts validators. Review authorization, immutable revision and enforcement parity. Perform short/narrow and 1440×1000, EN/RU, light/dark and keyboard checks with the scenarios above. No tests against the deployed service.

## Open issues and boundaries

- Authenticated deployment re-verification and deployed revision parity require an existing signed-in browser session and deployment revision evidence. Neither blocks local fixture work.
- The pinned editor geometry and exact zoom floor are a T0 measurement. Do not tune against the stale dependency install.
- Historical project viewer source scoping can make older revisions unavailable after a source switch. Same-name sources can also share byte-identical cache paths. Keep explicit refusal or unavailable behavior for unprovable provenance. Track broader historical viewer reachability and same-project fork co-attachment separately.
- No new product decision is required for these six fixes. Revisit a frozen decision only when a failing test or owning source demonstrates a gap.

## Commit Plan

- After T0–T2: review the specs, package identity and Brain Git boundary. Suggested commits `docs: specify dogfooding UX contracts`, `fix(studio): preserve installed package identity in navigation`, `fix(brain): index literal Git paths with brackets`.
- After T3–T5: review keyboard and geometry evidence. Suggested commits `fix(board): use accessible new-task modal`, `fix(graphs): fit measured editor and evidence viewports`.
- After T6–T7: review guard parity and transcript continuity. Suggested commits `fix(runs): scope verification to recorded Flow checks`, `fix(runs): align transcript controls and agent history links`.
