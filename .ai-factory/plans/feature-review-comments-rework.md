# Implementation Plan: PR-grade Review Comments → Rework Loop (Human Gate)

Branch: feature/review-comments-rework
Created: 2026-06-10
Refined: 2026-06-10 (/aif-improve — anchor-verification pass: migration renumber 0030→0038, NEW Task 18 flow commentsVar consumption, gateAttempt plumbing precision, `PENDING_HITL_RUN_STATUS` export, patch-derived prevention rules)
Baseline: main @ 0fc95697 (post `feature/aif-flow-package` merge; "option 2" gate-card diff is SHIPPED — `web/lib/flows/review-gate.ts` + `RunDiff` at `layout.tsx:623`; **M27 Flow Studio is MERGED** — migrations through `0037_m27_*`, ADRs through 070)

## Settings
- Testing: yes — TDD (vitest unit + integration via testcontainers, Playwright e2e with stub supervisor)
- Logging: verbose (DEBUG flow + INFO key events; structured pino; never log comment body content — lengths/ids only)
- Docs: yes — mandatory documentation checkpoint at completion
- Methodology: **SDD + TDD, multi-agent execution** (see "Execution model")

## Roadmap Linkage
- Milestone: **M20. Dogfood + external validation**
- Rationale: M20 explicitly validates "review-driven rework" end-to-end. Today's review gate (one free-text box) is too coarse to dogfood real PR-grade reviews; line-anchored comments feeding the rework loop are the missing piece.

## Execution model (SDD + TDD multi-agent)

Shaped for `claude --agent implement-coordinator` dispatching `implement-worker`s in isolated worktrees, with review/security/rules sidecars after each slice.

- **SDD:** Phase 0 freezes the contract (ADR-071 + `docs/system-analytics/review-comments.md` + ERD + OpenAPI) before any code. Every later task implements to that frozen contract.
- **TDD inside each slice:** each implementation task is a self-contained slice: write failing tests → implement to green → self-verify. A red task and its green task are never split across workers.
- **Test integrity (hard acceptance for EVERY phase):**
  - every promised test names its runner: unit = vitest project `unit` (globs `lib/**/*.test.ts`, `lib/**/__tests__/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`, `components/**/__tests__/**/*.test.ts`), integration = project `integration` (`lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`), e2e = Playwright `web/e2e/*.spec.ts`. All new test paths in this plan already match existing globs — no runner-config change needed (verify with `pnpm vitest list` in Task 17).
  - each phase exits only with the full suite green: `pnpm typecheck && pnpm test:unit && pnpm test:integration` (e2e in P6).
  - assertion migration of existing tests is in-scope of the phase that breaks them (enumerated in "Existing tests affected").
- **Parallelizable batches** (coordinator may run concurrently; deps via `blockedBy`):
  - P2 batch: Tasks 5 ∥ 6 (pure libs, independent).
  - P4 starts after Task 4+5 (routes do not need engine Tasks 7–8).
  - P5 batch: Task 11 → 12; Task 13 needs 8+12; Task 14 joins after 11–13.
  - P6: Task 18 (flows wiring) may run ∥ Task 15 (e2e); Task 16 waits for both.
- **Worktree/lint gotchas:** workers MUST use the full worktree path (`cd <repo>/web` of *their* worktree); lint check-only via `cd web && npx eslint <changed files>` — NEVER `pnpm --filter maister-web lint` (it `--fix`-reformats the repo).

## Scope boundary (locked)

Already shipped — do NOT rebuild:
- Gate-card diff at human review gate (`isHumanReviewGate` + embedded `RunDiff`, `layout.tsx:623-633`); split/unified diff via `@git-diff-view/react@0.1.5` with server-side Shiki bundles (ADR-066); `GET /api/runs/[runId]/diff` (readBoard, committed-only `base..branch`, 4 MiB bound + `truncated`).
- The whole rework engine: `finish.human.decisions`, `transitions`, `rework.{allowedTargets,maxLoops,commentsVar}`, `node_attempts` ledger, downstream staleness, `pendingInjectedVars` → top-level `{{ review_comments }}` Mustache injection (`runner-graph.ts:1731-1739`, `context.ts:217`).
- HITL respond route family + two-phase commit + idempotency CAS + assignment auto-claim (`lib/services/hitl.ts`); `hitl-validate.ts` decision validation.

Out of scope (explicitly deferred):
- Multi-reviewer/assignment changes; suggested-edits (commit-from-comment); GitHub PR comment sync; uncommitted-worktree diff; fuzzy/`git-blame` re-anchoring (v2 candidate); SSE multi-tab live comment sync; agent replying to threads.

## Design decisions (frozen — ADR-071 in Task 1)

- **D1. Storage = new DB table `review_comments`** (not a `.maister/` artifact). Comments span multiple `hitl_requests` rows (gate visits) and rework iterations within one run; need open/resolved queryability at compose time, RBAC-gated writes, survival across worktree GC, and evidence-graph linkage (`artifact_instances` is DB-side). The `.maister/` artifact pattern remains the *delivery* channel: comments reach the agent only as the composed `commentsVar` payload. One table, 1-level threads: root (`parent_id NULL`, carries anchor + status) + replies (`parent_id = root.id`, no anchor). Columns: `id` (text PK, randomUUID), `run_id` FK→runs cascade, `hitl_request_id` FK→hitl_requests cascade (gate visit of authoring), `node_id`, `gate_attempt` int (iteration tag), `parent_id` self-FK cascade, `author_user_id` FK→users set-null + `author_label` text snapshot, `file_path`, `side` text enum `old|new`, `line` int, `line_content` text (server-extracted), `body` text, `status` text enum `open|resolved` default open, `resolved_by_user_id`, `resolved_at`, `created_at`, `updated_at`. CHECK: anchor fields non-null ⇔ root. Indexes: `(run_id, created_at)`, `(run_id, status)`, `(hitl_request_id)`, `(parent_id)`.
- **D2. Anchoring = (file_path, side, line) + exact `line_content` snapshot; no SHA.** POST validates the anchor against the server-recomputed current diff (same `diffRunWorkspace` + `lib/diff/prepare.ts` source the view renders) and stores the server-extracted `line_content` — the client never supplies it. Cross-iteration validity = exact content match at the same position in the *current* diff, computed server-side in GET as `placement: "inline" | "outdated"`. No fuzzy re-anchoring in v1 (GitHub-style "outdated" semantics; deterministic; the agent always receives content snapshots, so staleness never corrupts the rework payload). Edge: diff `truncated` and file absent from parsed output → POST rejects `PRECONDITION` (mirrors the truncated-diff promotion ack).
- **D3. Rework serialization = runner-side compose at consumption.** In the existing rework branch (`runner-graph.ts:1731` `if (commentsVar)`), load OPEN root threads (+replies) for the run, compose deterministic markdown — user summary first, then file/line-ordered anchored comments with quoted `line_content` and replies — and inject as `pendingInjectedVars[commentsVar]`. **Zero open threads → composed value ≡ raw summary (byte-identical to today)** — full backward compat with every existing flow and test. The respond route, its two-phase commit, and idempotency CAS are UNTOUCHED; `hitl_requests.response` + `input-<stepId>.json` stay pristine user-submitted payloads. Resolved threads never serialize; open-but-outdated threads do (content snapshot quoted). No flow.yaml/DSL change — `{{ review_comments }}` keeps working as-is.
- **D4. Evidence:** at compose time the runner records the composed payload as an `artifact_instances` row (`kind: human_note`, `producer: runner`, locator `inline` with `{hitlRequestId, threadIds, composed}`), linked to the gate's `node_attempt`. Task 7 first inspects `recordDefaultArtifacts`/existing hitl-response capture to avoid duplication.
- **D5. Loop visibility + exhaustion guard:** at gate creation (`runReviewHuman`, ~`runner-graph.ts:213-235`) the stored schema additionally carries `{ maxLoops, gateAttempt }` (server-state; both derivable from `node_attempts` count the runner already loads). Total allowed gate visits = `maxLoops + 1` (engine: `nodeAttemptCount > maxLoops` throws `CONFIG` → run `Failed`). `hitl-validate.validateReviewDecision` gains: rework decision rejected (`NEEDS_INPUT`, 422) when `gateAttempt ≥ maxLoops + 1` — preventing the today-possible foot-gun where a final-loop rework silently fails the whole run. Engine throw stays as backstop. UI shows "Rework loop N of M", disables rework at the boundary, and soft-warns (never blocks) approve while open threads exist. **Off-by-one verified against the engine source** (`runner-graph.ts:1008-1021` — prior-count check runs BEFORE the attempt row is appended; "initial run is attempt 1, so maxLoops reworks → maxLoops + 1 total"); the rule is `reject rework when gateAttempt > maxLoops`, and Task 8 unit tests pin both sides of the boundary.
- **D6. Routes** (new family, NOT the respond route — comments are drafted incrementally before the decision):
  - `GET /api/runs/[runId]/review-comments` — `readBoard` (viewer), not status-gated (history visible like the diff). Returns threads with computed `placement`.
  - `POST /api/runs/[runId]/review-comments` — `answerHitl` (member) + open-review-gate guard. Body: root `{filePath, side, line, body}` | reply `{parentId, body}`.
  - `PATCH /api/runs/[runId]/review-comments/[commentId]` — `answerHitl` + gate guard. `{body}` (author-only edit) | `{status: open|resolved}` (root-only; any `answerHitl` member).
  - `DELETE /api/runs/[runId]/review-comments/[commentId]` — `answerHitl` + gate guard, author-only; root delete cascades replies.
  - **Open-review-gate guard (allow-list per skill-context rule):** `runs.status ∈ PENDING_HITL_RUN_STATUS` (= `{NeedsInput, NeedsInputIdle}` — reuse the existing constant) AND a pending `hitl_requests` row (`respondedAt IS NULL`) with `kind='human'` + `schema.review === true` exists; comments FK that row. Otherwise 409 `PRECONDITION`. Writes NEVER touch `runs.status` (runner owns it).
  - Single DB transaction per op, no external side-effects → the two-phase-commit rule is satisfied trivially (no artifact write, no supervisor call). No deferred is created or released on any comment path.
  - No new `MaisterError` codes: reuse `PRECONDITION | CONFLICT | UNAUTHORIZED | NEEDS_INPUT` (+ zod 400). Closed taxonomy preserved.
- **D7. Service/authz split:** route handlers own `requireProjectAction` (projectId server-derived from the run row, never body); `lib/review-comments/service.ts` is authz-free logic taking `(db, actor)` — integration-testable against testcontainers without session stubs (follows `lib/users.ts updateAdminUser` aggregating-endpoint pattern, unlike hitl.ts's in-service authz which exists only because two routes share it).
- **D8. UI = native `@git-diff-view/react` comment API** (spike-confirmed in 0.1.5 typings): `diffViewAddWidget` + `onAddWidgetClick(lineNumber, side)` + `renderWidgetLine` (composer) + `extendData {oldFile/newFile: Record<String(line), {data}>}` + `renderExtendLine` (thread display). No overlay hacks. `extendData` is per-active-file — filter threads by selected path. Outdated threads render in a collapsible "Outdated" list (file:line + quoted stale content), resolvable there. Thread-card actions (edit / delete / resolve / unresolve / reply) are **icon-only buttons** with translated `aria-label`s, following the house inline-SVG pattern (local `function XxxIcon(): ReactElement` components in the consuming file — see `file-tree.tsx:16`, `scratch-launcher.tsx:152,620`; no icon library dependency). Refetch-on-mutation + `router.refresh()` for gate-panel counts; **no polling, no fs.watch, no new SSE events** (multi-tab sync deferred; HITL state is DB-only today anyway).
- **D9. i18n:** all new strings in `web/messages/en.json` + `ru.json` (parity test enforces); labels flow server→client as typed label bundles per house pattern.
- **D10. NOT changed:** no new `runs.status`, no new error code, no new env var/port/sidecar/dependency, no engine version bump, no flow.yaml DSL grammar change, diff stays committed-only `base..branch` and `readBoard`.

## Identifiers (trust-boundary labels for new/changed routes)

| Route | Identifier | Label | Handling |
| --- | --- | --- | --- |
| all four | `runId` | url-param | access-controlled via run row → project → `requireProjectAction` |
| PATCH/DELETE | `commentId` | url-param | row loaded, `row.run_id === runId` compared (server-state) → 404 on mismatch |
| POST (reply) | `parentId` | body-controlled | must resolve to a ROOT comment of the SAME run (server-state compare) → 409 `CONFLICT` otherwise |
| POST (root) | `filePath`, `side`, `line` | body-controlled | validated against server-computed diff (anchor must exist → else 409 `PRECONDITION`); `filePath` is opaque anchor DATA — **never used as a filesystem path component anywhere** |
| POST/PATCH | `body` | body-controlled | content data; zod: non-empty, ≤10 000 chars |
| all writes | author | auth-context | `author_user_id`/`author_label` from session, never from body |

`projectId` is always derived from the run row (server-state). No body field names a cross-resource locator with an available server-state counterpart.

## Contract surfaces → spec files (Phase 0 owns; Task 16 reconciles as-built)

| Surface | Spec file(s) |
| --- | --- |
| 4 new HTTP routes | `docs/api/web.openapi.yaml` (paths + `ReviewCommentThread`/`ReviewComment` schemas + `MaisterErrorBody` refs; status-tagged summaries) |
| New table `review_comments` | Drizzle migration `0038_review_comments.sql` (next-free — main is at `0037_m27_*`; re-check `_journal.json` + in-flight branches before generating) + `docs/database-schema.md` + `docs/db/hitl-domain.md` ERD + `docs/db/erd.md` consolidated |
| `hitl_requests.schema` gains `maxLoops`/`gateAttempt` (wire field becomes load-bearing for validate/UI) | `docs/api/web.openapi.yaml` schema description + `docs/system-analytics/hitl.md` |
| `commentsVar` composed semantics (summary + serialized threads) | `docs/flow-dsl.md` commentsVar description + `docs/system-analytics/flow-graph.md` rework section + NEW `docs/system-analytics/review-comments.md` (R5 sections, R6 status tags) |
| Rework-exhaustion validate rule | `docs/system-analytics/hitl.md` refusal table + `review-comments.md` |
| Error codes | none new — `docs/error-taxonomy.md` unchanged (verify no drift) |
| SSE events | none new — no AsyncAPI change |

## Deployment touchpoints

**None.** No new env var, config file, sidecar, port, or package dependency (`@git-diff-view/react@0.1.5` already shipped via ADR-066). No `Dockerfile`/`compose*`/`.env.example` changes. Config-state symmetry rule: N/A (no YAML→DB persistence).

## Acceptance criteria → coverage
- Reviewer at a dev-flow review gate leaves ≥2 line-anchored comments on the diff → P5 (Tasks 11–13), e2e Task 15.
- Click rework → agent's next attempt receives anchored comments (file+line+quoted content+body) in its prompt context → P3 Task 7 (runner integration test asserts composed `{{ review_comments }}`) **+ Task 18** (the dev flow's `plan` node and init/evolve/roadmap rework targets must actually consume the var — today only `bugfix` and dev `fix` reference it, so plan_review comments would compose into an unread variable).
- On re-review prior comments visible + resolvable; changed lines show as outdated → D2/D3; Tasks 5, 9, 11; runner integration covers carry-across-iteration.
- Loop respects `rework.maxLoops`; boundary surfaced instead of silently failing the run → D5, Task 8 + Task 13.
- Comments are part of the run's evidence trail → D4, Task 7.
- EN+RU parity → Task 14 (+ existing `i18n-parity.test.ts`).
- `pnpm typecheck` + unit/integration/e2e green → every phase exit + Task 17.

## Existing tests affected (assertion-migration in-scope of the breaking phase)
- `web/lib/flows/graph/__tests__/rework-comments.test.ts` (existing 108-line runtime regression rendering the REAL flows' rework prompts through `buildContext` + `renderStrict` — born from the 2026-06-09 template-crash patch) + sibling graph specs: zero-thread compose path is byte-identical → expected green; Tasks 7 and 18 EXTEND this file; Task 7 runs the whole graph suite and migrates anything asserting on injected-var internals (grep `pendingInjectedVars` / `review_comments` under `lib/flows/graph/__tests__/`; also schema-shape assertions now seeing `maxLoops`/`gateAttempt`).
- `web/lib/flows/__tests__/hitl-validate*` (if present) + service-level review-decision tests: gain the exhaustion-rejection branch (Task 8 extends).
- `components/board/__tests__/hitl-decision-controls.test.ts`: props extended (optional) — existing cases stay green; Task 13 adds branches.
- `web/lib/flows/__tests__/review-gate.test.ts`: unchanged (predicate untouched).
- `web/e2e/m11a-review-rework.spec.ts`: gate-panel markup gains counts/loop chip — Task 15 verifies/adjusts selectors.

## Commit Plan
- **Commit 1** (P0, Tasks 1–2): `docs(review-comments): freeze ADR-071 + review-comments contract (analytics, ERD, OpenAPI)`
- **Commit 2** (P1, Tasks 3–4): `feat(review-comments): review_comments table + service layer (migration 0038)`
- **Commit 3** (P2, Tasks 5–6): `feat(review-comments): anchor placement matching + rework payload serializer`
- **Commit 4** (P3, Tasks 7–8): `feat(review-comments): runner-side compose into commentsVar + loop-exhaustion validate guard + evidence snapshot`
- **Commit 5** (P4, Tasks 9–10): `feat(review-comments): review-comments API routes (GET/POST/PATCH/DELETE)`
- **Commit 6** (P5, Tasks 11–14): `feat(review-comments): inline diff threads UI + gate panel counts/loop chip + i18n`
- **Commit 7** (P6, Tasks 15 + 18, then 16–17): `test(review-comments): e2e + aif-flow commentsVar consumption + docs as-built + final verify`

## Tasks
(IDs match the tracked task list; each implementation task is a self-contained TDD slice with verbose logging per Settings.)

### Phase 0 — SDD spec-freeze (solo, before any code)
- [x] Task 1: Author **ADR-071** (storage, anchoring, runner-side serialization, guards, identifiers, loop-boundary rule) → `docs/decisions.md`
- [x] Task 2: Freeze the domain contract: NEW `docs/system-analytics/review-comments.md` (R5: Purpose/Entities/State machine/Process flows/Expectations/Edge cases/Linked artifacts; R6 tags) + ERD updates (`database-schema.md`, `db/hitl-domain.md`, `db/erd.md`) + OpenAPI paths/schemas + `hitl.md`/`flow-graph.md`/`flow-dsl.md` cross-updates (depends on 1)
<!-- Commit checkpoint: tasks 1-2 -->

### Phase 1 — DB + service layer (TDD slice)
- [x] Task 3: Migration `0038_review_comments` (next-free — main is at `0037_m27_*`; re-check journal + in-flight branches) + `reviewComments` in `web/lib/db/schema.ts` (+ `$inferSelect` types, CHECK, indexes) + schema integration assertions (depends on 2)
- [x] Task 4: `web/lib/review-comments/service.ts` — create/reply/edit/resolve/delete/list with open-gate allow-list guard, parent/run integrity, author rules; unit + `service.integration.test.ts` (testcontainers) (depends on 3)
<!-- Commit checkpoint: tasks 3-4 -->

### Phase 2 — Pure libs (parallel batch: 5 ∥ 6)
- [x] Task 5: `web/lib/review-comments/anchor.ts` — (path, side, line)→content extraction from the prepared-diff source + `placement` matching; unit tests incl. truncated-diff edge (depends on 2)
- [x] Task 6: `web/lib/review-comments/serialize.ts` — deterministic markdown compose (summary + file/line-ordered threads + replies + quoted content); **zero-threads ⇒ identity**; unit tests (depends on 2)
<!-- Commit checkpoint: tasks 5-6 -->

### Phase 3 — Engine integration (TDD slice)
- [x] Task 7: Runner: gate schema +`{maxLoops, gateAttempt}`; compose open threads into `pendingInjectedVars[commentsVar]` at rework consumption; record evidence `human_note` artifact; runner integration tests (compose with threads, zero-thread byte-identity regression, resolved-excluded, cross-iteration carry); migrate any broken graph-suite assertions (depends on 4, 6)
- [x] Task 8: `hitl-validate`: reject rework at `gateAttempt ≥ maxLoops + 1` (`NEEDS_INPUT` 422) after verifying the engine off-by-one with an integration test; unit tests both sides of boundary (depends on 7) — **scope expanded during implementation**: the engine boundary check itself was fixed (resume-reuse iterations no longer fail legitimate decisions at visit maxLoops+1; empirically-proven pre-existing bug found by Task 7's review)
<!-- Commit checkpoint: tasks 7-8 -->

### Phase 4 — API routes (TDD slice; may start after 4+5, ∥ P3)
- [x] Task 9: `GET` (threads + placement via anchor lib) + `POST` (zod, anchor validation, server-extracted `line_content`, reply integrity) under `app/api/runs/[runId]/review-comments/route.ts`; co-located `__tests__/route.test.ts` (fake-db unit) — authz, guards, identifier checks (depends on 4, 5)
- [x] Task 10: `PATCH`/`DELETE` under `[commentId]/route.ts` (author-only edit/delete, root-only resolve, cascade) + co-located tests (depends on 9)
<!-- Commit checkpoint: tasks 9-10 -->

### Phase 5 — UI + i18n (batch: 11 → 12; 13 after 8+12; 14 last)
- [ ] Task 11: `diff-view.tsx` review mode — `diffViewAddWidget`/`onAddWidgetClick`/`renderWidgetLine` composer + `extendData`/`renderExtendLine` threads (reply/resolve/edit/delete affordances, iteration badge) + Outdated collapsible list; presentational component tests (`renderToStaticMarkup`, `.test.ts`) (depends on 9)
- [ ] Task 12: `run-diff.tsx` review wiring — fetch threads, mutations, refetch-on-action, error surfaces (`role="alert"`); component tests (depends on 11)
- [ ] Task 13: Gate panel — unresolved/outdated counts, "Rework loop N of M" chip, approve soft-warn with open threads, rework disabled at boundary (`layout.tsx` amber section + `run-hitl-response.tsx` + `hitl-decision-controls.tsx`, reading `maxLoops`/`gateAttempt` from schema); component tests + migrate `hitl-decision-controls.test.ts` (depends on 8, 12)
- [ ] Task 14: i18n EN+RU for all new strings (`web/messages/en.json` + `ru.json`); parity test green (depends on 11, 12, 13)
<!-- Commit checkpoint: tasks 11-14 -->

### Phase 6 — E2E + flows wiring + docs + final verify (15 ∥ 18 → 16 → 17)
- [ ] Task 15: e2e — extend `e2e/_seed/seed-e2e.ts` fixture (run parked at review gate with a real committed worktree diff + seeded threads whose `line_content` byte-matches the fixture diff) + NEW `web/e2e/review-comments.spec.ts` (add 2 inline comments, resolve one, submit rework → 200, panel/outdated states); keep `m11a-review-rework.spec.ts` green (depends on 13, 14)
- [ ] Task 18: Consume `{{ <commentsVar> }}` in bundled aif flows' rework-target prompts — dev `plan` ← `plan_review_comments`; init/evolve/roadmap targets ← `review_comments` (bugfix + dev `fix` already wired; top-level var ONLY, never `steps.*.vars`) + extend `rework-comments.test.ts` runtime render regression for initial-visit AND rework paths (depends on 7; may run ∥ 15)
- [ ] Task 16: Docs as-built reconcile — flip R6 tags to `(Implemented)`, sync `web/CLAUDE.md` route list + root docs cross-refs; **mandatory `/aif-docs` checkpoint** (depends on 15, 18)
- [ ] Task 17: Final verification gate — `pnpm typecheck` + `test:unit` + `test:integration` + `test:e2e` + scoped `npx eslint <changed>` + i18n parity + AC walkthrough + `vitest list` runnability confirmation (depends on 16)
<!-- Commit checkpoint: tasks 15-17 -->

## Key files (verified against code @ 0fc95697)

| Concern | File:anchor |
| --- | --- |
| Diff fetch container | `web/components/workbench/run-diff.tsx` (props `{runId, labels}`; fetches `GET /api/runs/[runId]/diff`) |
| Diff renderer | `web/components/workbench/diff-view.tsx` (`GitDiffView` call ~L254; comment-surface TODO at L149; URL-synced `?diffview=`) |
| Comment-ready lib API | `@git-diff-view/react@0.1.5` `index.d.ts` — `diffViewAddWidget`, `onAddWidgetClick(lineNumber, side)`, `renderWidgetLine({onClose})`, `extendData{oldFile/newFile: Record<string,{data}>}`, `renderExtendLine({data, onUpdate})`, `SplitSide{old=1,new=2}` |
| Server diff prep (anchor source) | `web/lib/diff/prepare.ts` + `web/lib/worktree.ts:353` (`diffRunWorkspace`, 2-dot committed-only) + `web/app/api/runs/[runId]/diff/route.ts` |
| Gate predicate + card | `web/lib/flows/review-gate.ts`; `web/app/(app)/runs/[runId]/layout.tsx:623-642` (amber section; `flowGraphData.diffLabels`) |
| HITL response UI | `web/components/board/run-hitl-response.tsx` (POST `respond`, review payload L180-196); `web/components/board/hitl-decision-controls.tsx` (`ReviewSchema` L26-31) |
| Runner gate + rework | `web/lib/flows/graph/runner-graph.ts` — schema build ~L213-235; loop check L997-1020 (`count > maxLoops` → `CONFIG`); comments injection L1731-1739; `pendingInjectedVars` → `buildContext` L1121; staleness L1747 |
| Template context | `web/lib/flows/graph/context.ts:217` (`extraVars` top-level) |
| Decision validation | `web/lib/flows/hitl-validate.ts:80-161` (`validateReviewDecision`) |
| Respond service (UNTOUCHED ordering) | `web/lib/services/hitl.ts` — `handleFormHumanResponse` L803-1099 (Phase 1 CAS / Phase 2 artifact / Phase 3 respondedAt); `PENDING_HITL_RUN_STATUS` |
| pendingHitl read model | `web/lib/queries/run.ts:66-80` (`RunPendingHitl.schema` passes jsonb through — `maxLoops`/`gateAttempt` ride free) |
| DB schema + patterns | `web/lib/db/schema.ts` (`hitl_requests` L1763; `node_attempts` L1346 unique `(run_id,node_id,attempt)`; `artifact_instances` L1521 as table-style reference) |
| Migrations | `web/lib/db/migrations/` (next: `0038_*` — main is at `0037_m27_*`; verify `_journal.json` + in-flight branches before generate; never hand-edit journal `when`) |
| RBAC | `web/lib/authz.ts:46-60` (`answerHitl=member`, `readBoard=viewer`); projectId always server-derived |
| Atomic writes | `web/lib/atomic.ts:11-16` (`atomicWriteJson`) — used only by existing respond path |
| Reference flow | `plugins/aif/flows/dev/flow.yaml` (`plan_review` L57-71, `review` L125-159, `fix` prompt `{{ review_comments }}` L165-167) |
| i18n | `web/messages/en.json` / `ru.json` (`run.*`, `workbench.diff.*`); parity test `web/lib/__tests__/i18n-parity.test.ts` |
| Tests | unit/integration globs per `web/vitest.workspace.ts`; testcontainers pattern `web/lib/db/__tests__/schema.integration.test.ts`; component pattern `components/board/__tests__/hitl-decision-controls.test.ts`; e2e seed `web/e2e/_seed/seed-e2e.ts` + `web/e2e/m11a-review-rework.spec.ts` (port 3100) |
| Logging | pino module singletons (`name: "review-comments"` for new service; runner follows its module logger); structured fields first, message last; ids/lengths only — never body text |

## Risks / invariants
- **Respond-route invariants untouched:** never flips `runs.status`; two-phase commit + idempotency CAS unchanged (runner-side compose is what makes this possible — D3). Any drift here is a defect.
- **Status guards are allow-lists** (`PENDING_HITL_RUN_STATUS`), never `!terminal` complements; a future status is rejected by default.
- **Zero-thread byte-identity** is a hard regression test (Task 7) — existing flows must see exactly today's behavior.
- **`filePath` is data, never a path:** no fs access keyed by comment fields anywhere (grep-checked in Task 17).
- **Off-by-one on `maxLoops`** (visits = maxLoops+1) is verified by test BEFORE the validate rule lands (Task 8); engine `CONFIG` throw remains the backstop.
- **No N+1 on GET:** one query for threads + one diff parse per request; placement matching is pure/in-memory.
- **No new crash windows:** comment ops are single-transaction single-store; runner compose is a pure read before existing writes.
- **e2e honesty:** stub supervisor can't run agents — the full agent-receives-prompt assertion lives in the runner integration test (Task 7); e2e covers the UI surface + respond 200.
- Pre-existing teardown flakes in integration suite (2 known) are not introduced by this work — do not chase them here; do not add new reds.
- **Sequential-number collisions** (patch 2026-06-09-18.47): migration indices and ADR numbers are globally sequential across branches. 0038 / ADR-071 are free as of 2026-06-10 (M27 merged, its worktree gone) — re-verify against `git show main:...` + any active worktrees at implementation and again before merge.
- **commentsVar wiring is a templating-convention contract** the schema validator cannot catch (patch 2026-06-09-19.23): rework-target prompts read the TOP-LEVEL `{{ <commentsVar> }}` only; the runtime render regression (`rework-comments.test.ts`) is the only guard — Tasks 7/18 must extend it, never bypass it.

## Resolved questions (user-confirmed 2026-06-10)
1. Resolve threads: any `answerHitl` member (not author-only). ✓
2. Approve with open threads: soft-warn only, never blocks. ✓
3. Replies: in v1. ✓
4. DELETE: in v1, author-only, open gate only. ✓
5. Thread-card actions use icon-only buttons (house inline-SVG pattern) with translated `aria-label`s. ✓
