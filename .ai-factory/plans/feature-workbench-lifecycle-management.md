# Implementation Plan: Workbench Lifecycle Management

Branch: HEAD detached in managed Codex worktree. Intended feature branch:
`feature/workbench-lifecycle-management` (plan file uses that stem for
branch-based discovery).
Created: 2026-06-09

## Settings

- Testing: yes (strict TDD: RED before production code for every behavior phase)
- Logging: verbose
- Docs: yes (Phase 0 docs/spec pack is the source of truth)

## Roadmap Linkage

Milestone: "M27. Workbench lifecycle management" (proposed)
Rationale: This is a cross-cutting maturity milestone after M19/M22/M18: it
makes stopped, stale, crashed, reviewed, done, and abandoned worktrees
operator-manageable from every workbench/read-model panel.

## Current Implementation Snapshot

Status as of the first M27 slice: partially implemented and verified with
focused unit/route/component tests plus `maister-web` typecheck.

Delivered in the current slice:

- A pure lifecycle action allow-list in
  `web/lib/workbench-lifecycle/policy.ts`.
- Consolidated lifecycle orchestration in
  `web/lib/workbench-lifecycle/service.ts` for stop, archive, drop, and
  export of the server-owned run branch.
- Flow run routes for `stop`, `archive`, `drop`, and `export-branch`.
- Shared compact action rendering in left rail, portfolio cards, project active
  workspace panel, board cards, and run detail.
- EN/RU message entries and focused tests for policy, service orchestration,
  route wrappers, read-model projection, and basic component rendering.

Known gaps that this improved plan must close:

- Export uses browser-native `confirm`/`prompt`, hardcodes `origin`, and drops
  successful response details instead of showing checkout guidance.
- User-facing branch creation is not yet modeled separately from pushing the
  existing run branch.
- Snapshot committing is only an export option, not an explicit commit action
  from the MAIster UI.
- Scratch detail still exposes bespoke stop/discard buttons instead of the
  shared lifecycle surface.
- Route tests mock most git side effects; no focused real-git integration lane
  yet covers preserve, dirty snapshot commit, handoff branch creation, push, and
  owned worktree removal.
- Lifecycle side effects do not yet have a durable operation claim comparable
  to the promotion claim pattern.
- The plan still needs an explicit browser-level UX verification pass for the
  compact panels and detail views.

## 0. Spec Pack

### 0.1 JTBD

When I see a stale, stopped, crashed, finished, or no-longer-useful workbench, I
want to decide its fate directly from the surface where I noticed it, so I can
stop cost leakage, preserve useful work, keep disk under control, hand the branch
to local development, or intentionally discard it without spelunking through git.

When I stop an active agent run, I want MAIster to terminate the supervisor
session and keep the worktree reviewable, so partial work remains inspectable
instead of being treated as a crash or silently deleted.

When I archive a workbench, I want MAIster to preserve all committed,
uncommitted, and untracked work into a durable archive ref before any prune, so
the word "archive" never means "lost work".

When I need to keep working outside MAIster, I want a one-click export that
snapshot-commits dirty work if requested, pushes the run branch, and gives me a
checkout command, so I can continue from my local developer machine.

When I drop a workbench, I want an explicit destructive cleanup that first
preserves recoverable work or refuses, then removes only MAIster-owned
worktrees, so disk cleanup is deliberate and safe.

### 0.2 Product Vocabulary

- **Workbench**: the visible run/workspace unit shown in the left rail, portfolio
  project cards, project page active workspace panel, board cards, run detail,
  and scratch dialog.
- **Stop**: terminate a live supervisor session and park the run in `Review`
  with its worktree still present. For scratch this reuses the existing stop
  path; for flow runs it is new.
- **Archive**: preserve a worktree into `maister/archive/<runId>` using the M19
  preserve service, set `workspaces.archived_branch` and `archived_at`, and keep
  the worktree on disk unless the caller also drops it.
- **Drop**: immediate preserve-then-prune. If preservation fails, no removal is
  allowed. Dropping an unpromoted `Review`/`Crashed` workbench marks it
  `Abandoned`; dropping `Done` only removes the worktree.
- **Snapshot commit**: explicit operator action that commits dirty tracked,
  unstaged, staged, and untracked files on the server-owned run branch with a
  user-supplied commit message. It does not push, archive, drop, or promote.
- **Handoff branch**: an operator-named branch created from the workbench HEAD
  for local continuation. The first implementation refuses branch collisions;
  refreshing/replacing an existing handoff branch is a later deliberate action,
  not a hidden `force` flag.
- **Export branch**: optional dirty snapshot commit, then `git push` of the
  server-owned run branch to the selected remote. It does not mark the run
  `Done`; promotion remains the product action for merge/PR completion.
- **Export result**: the UI-visible success state after push or handoff. It
  includes remote, pushed branch/ref, whether a snapshot commit was created, and
  copyable non-chained commands for continuing locally.

### 0.3 Current Code Observations

- Scratch has implemented `stop`, `recover`, and `discard` routes under
  `web/app/api/scratch-runs/[runId]/*`.
- Flow runs already have `recover`, `discard`, `abandon`, `promote`, `diff`,
  file tree, and workbench graph routes, but no operator "stop to Review",
  explicit archive, immediate drop, or export-branch action.
- M19 preserve/prune primitives exist: `web/lib/gc/preserve.ts`,
  `web/lib/gc/workspace-gc.ts`, `workspaces.scheduled_removal_at`,
  `archived_branch`, `archived_at`, and `removed_at`.
- Left rail already includes active workspaces plus terminal `Done`/`Abandoned`
  workspaces that have a GC deadline. Portfolio and project active workspace
  panels only show active statuses.
- Promotion already handles branch push/PR for `Review -> Done`, but it is
  readiness-gated and finalizing. Export branch must be separate and available
  before final promotion.
- `web/lib/worktree.ts` already has `pushBranch`, `statusPorcelain`,
  `logRange`, `diffRange`, `removeOwnedWorktree`, and branch/ref validation.
- The first lifecycle UI slice is intentionally compact but still uses
  browser-native prompts and a hardcoded `origin`; the product-grade UI must use
  in-app controls and server-discovered remotes.
- Scratch dialog lifecycle is still bespoke (`stop`/`discard`), so scratch
  parity requires a dedicated refactor rather than assuming read-model wiring is
  enough.
- Promotion already implements a durable claim pattern. Lifecycle git and
  filesystem side effects need either their own claim token or a narrowly scoped
  reuse decision documented before the next implementation pass.

### 0.4 State And Action Matrix

| Run status / dialog | Stop | Archive | Drop | Snapshot commit | Handoff/export |
| --- | --- | --- | --- | --- | --- |
| `Pending` | cancel to `Abandoned` via abandon path | no | yes, no worktree side-effect if none | no | no |
| `Running` flow | yes -> `Review` | no, stop first | no, stop/abandon first | no, stop first | no, stop first |
| `Running` scratch | existing scratch stop -> `Review` | no, stop first | no, stop first | no, stop first | no, stop first |
| `WaitingForUser` scratch | existing scratch stop -> `Review` | no, stop first | no, stop first | no, stop first | no, stop first |
| `NeedsInput` / `NeedsInputIdle` | yes -> `Review`, close visible assignments | no, stop first | no, stop/abandon first | no, stop first | no, stop first |
| `HumanWorking` | no, use release/return/abandon | no | no | no | no |
| `Review` | idempotent no-op | yes | yes | yes when dirty | yes when clean or after snapshot |
| `Crashed` | no live session, no-op | yes when worktree exists | yes | yes when dirty and worktree exists | yes when clean and worktree exists |
| `Done` | no | yes until pruned | yes, status remains `Done` | yes when dirty until pruned | yes when clean until pruned |
| `Abandoned` | no | yes until pruned | yes | yes when dirty until pruned | yes when clean until pruned |
| `Failed` | no | yes when worktree exists | yes | yes when dirty and worktree exists | yes when clean and worktree exists |

Every guard is an allow-list. Future statuses are refused until deliberately
admitted.

### 0.5 Operator Expectations

- All lifecycle actions are available from a shared `WorkbenchLifecycleActions`
  component used by left rail rows, portfolio/project active workspace rows,
  board cards where appropriate, run detail, and scratch detail.
- Destructive and git-writing actions use in-app accessible workbench dialogs, not
  `window.confirm` or `window.prompt`. Dialogs must keep focus, show typed
  backend errors, and leave the user on the same surface after completion.
- UI never exposes raw supervisor session ids. Server routes derive project,
  workspace path, branch, base ref, and supervisor handles from DB state.
- Archive/drop/export refuse live agent writes instead of racing the worktree.
- Archive and drop use `preserveWorktree`; if preserve returns `ok:false`, the
  worktree is not removed and the UI shows a typed retryable failure.
- Export branch can snapshot dirty work only after an explicit snapshot request
  and commit message. Without that request, dirty work causes `PRECONDITION`.
- After the separate `snapshot-commit` route lands, the primary UI should guide
  users to commit first and then export/handoff a clean worktree. The existing
  `export-branch` snapshot option can remain for compatibility, but the product
  flow must not hide committing inside a push-only-looking action.
- Snapshot commit is available as a separate user intent when a workbench has
  dirty files. It returns the new HEAD commit and refreshes the same panel.
- Handoff branch creation validates the requested branch name, refuses existing
  local or remote branch collisions in the first implementation, pushes only the
  user-selected handoff branch, and returns checkout commands.
- Remote choices come from server-discovered git remotes for the workbench repo.
  The UI may default to `origin` only when that remote exists.
- Export push uses host git credentials only, via the existing `pushBranch`
  helper. Non-fast-forward rejection maps to `CONFLICT`/409 with a force-with-
  lease retry affordance; transient push failure maps to
  `EXECUTOR_UNAVAILABLE`/503.
- Export and handoff success states show copyable commands and the pushed ref;
  no successful JSON response is silently discarded by the client component.
- Workbench actions refresh the current panel and keep the user on the same
  page. No action redirects to a marketing or summary page.
- Concurrent lifecycle actions for the same run are serialized by a durable
  claim/CAS pattern or refused with `409 CONFLICT`; double-clicks and two open
  panels must not race git or worktree removal.
- EN and RU strings ship together.

### 0.6 Acceptance Criteria

- From the left rail, portfolio project card, project active workspace panel,
  board card, run detail, and scratch detail, an operator can see the same
  lifecycle actions allowed for that workbench state.
- Stopping a live flow run calls supervisor `DELETE /sessions/{id}` when a
  session exists, clears ACP handles, moves the run to `Review`, closes pending
  actionable assignments as stopped/cancelled, frees a scheduler slot, and
  leaves the worktree on disk.
- Stopping a scratch run keeps the existing scratch stop behavior but is
  presented through the same action component and labels as flow stop.
- Archiving a stopped/terminal workbench snapshots dirty tracked and untracked
  files when needed, creates or refreshes `maister/archive/<runId>`, records
  `archived_branch`/`archived_at`, and does not remove the worktree.
- Dropping a workbench preserves first, refuses removal when preserve fails,
  removes only a worktree under `MAISTER_WORKTREES_ROOT`, records `removed_at`,
  and keeps unrelated repo/worktree files untouched.
- Exporting a branch refuses dirty work unless the request explicitly asks for a
  snapshot commit and supplies a non-empty message; with snapshot enabled, the
  commit is created with `--no-verify`, the run branch is pushed to the selected
  remote, and the response includes branch, remote, pushed ref, and checkout
  guidance.
- Committing from the MAIster UI is available as a distinct action for dirty
  stopped/terminal workbenches; it creates one snapshot commit, returns the
  commit SHA, and does not push or promote.
- Creating a handoff branch from the MAIster UI validates the branch name,
  refuses collisions, pushes the created branch to a selected existing remote,
  and displays copyable local checkout commands after success.
- The export/commit/handoff UI uses in-app controls with explicit opt-in text,
  not browser-native confirm/prompt dialogs.
- Scratch detail uses the same visible lifecycle action component and labels as
  flow workbenches, while keeping scratch-specific recover/message behavior
  adjacent.
- Lifecycle operation races are covered: two simultaneous archive/drop/export or
  commit/handoff requests for the same run produce one winner and one
  retryable/refused outcome without corrupting worktree state.
- Every route has an OpenAPI path and identifier-trust table. No body-controlled
  project id, worktree path, session id, or branch value is trusted over server
  state.
- Tests are runnable under the existing Vitest workspace globs, include a
  focused real-git integration lane for branch/commit/push/remove behavior, and
  each phase exits with the named focused tests green before the next phase
  starts.

## 1. Deployment Wiring

No new sidecar, package dependency, bound port, or runtime volume is expected.
No new env var is required for the core feature because existing GC and git
settings cover preservation, archive push, worktree root, and promotion claim
timeouts.

If implementation adds an export-specific default remote or message template,
it must touch `.env.example`, `compose.yml`, `compose.production.yml`,
`docs/configuration.md`, and `docs/getting-started.md` in the same phase.

## 2. Contract Surface Map

| Surface | Spec file |
| --- | --- |
| `POST /api/runs/{runId}/stop` | `docs/api/web.openapi.yaml`, `docs/system-analytics/runs.md`, `docs/system-analytics/workspaces.md` |
| `POST /api/runs/{runId}/archive` | `docs/api/web.openapi.yaml`, `docs/system-analytics/workspaces.md`, `docs/system-analytics/reconciliation-gc.md` |
| `POST /api/runs/{runId}/drop` | `docs/api/web.openapi.yaml`, `docs/system-analytics/workspaces.md`, `docs/system-analytics/reconciliation-gc.md` |
| `POST /api/runs/{runId}/export-branch` | `docs/api/web.openapi.yaml`, `docs/system-analytics/git-integration.md`, `docs/system-analytics/workspaces.md` |
| `GET /api/runs/{runId}/handoff-metadata` | `docs/api/web.openapi.yaml`, `docs/system-analytics/git-integration.md`, `docs/system-analytics/workbench-lifecycle.md` |
| `POST /api/runs/{runId}/snapshot-commit` | `docs/api/web.openapi.yaml`, `docs/system-analytics/git-integration.md`, `docs/system-analytics/workbench-lifecycle.md` |
| `POST /api/runs/{runId}/handoff-branch` | `docs/api/web.openapi.yaml`, `docs/system-analytics/git-integration.md`, `docs/system-analytics/workbench-lifecycle.md` |
| Lifecycle action DTO fields in read models | `docs/system-analytics/workbench-lifecycle.md` (new), `docs/system-analytics/workbench.md` |
| Reused error codes | `docs/error-taxonomy.md` (`PRECONDITION`, `CONFLICT`, `EXECUTOR_UNAVAILABLE`, `ACP_PROTOCOL`) |
| DB state reuse | `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/db/erd.md` |

## 3. Identifier And Side-Effect Decisions

### 3.1 Route Identifiers

- `runId`: url-param, validated by route shape and resolved to a DB row.
- `projectId`: server-state from `runs.project_id`.
- `worktreePath`, `parentRepoPath`, `branch`, `baseCommit`, `baseBranch`,
  `targetBranch`, `acpSessionId`, `supervisorSessionId`: server-state only.
- `remote` on export: body-controlled but validated as a remote name and
  resolved against `git remote` before push. Default is `origin`.
- `snapshotDirty` and `commitMessage`: body-controlled local export policy only;
  neither may affect path, session, or cross-resource lookup.
- `handoffBranch`: body-controlled branch name for handoff creation only;
  validated with the same branch schema as worktree helpers, checked for local
  and selected-remote collisions, and never used as a filesystem path.
- `commitMessage`: body-controlled message for snapshot commit only; validated
  as non-empty and NUL-free before `git commit`.
- `lifecycleOperationId` or equivalent operation token: server-minted claim
  state only. The client may receive it in a success/error response, but it
  cannot choose or overwrite it.

### 3.2 Stop Side Effects

Order:

1. Auth and project action check from server-derived project id.
2. Lock/load run and workspace.
3. Allow-list status.
4. If a supervisor session id exists, call supervisor delete. Missing session is
   idempotent; transient supervisor failure returns 503 and leaves DB unchanged.
5. One DB transaction: `status -> Review`, clear ACP/current-step handles,
   clear live HITL/assignment actionability for this stopped run, record `endedAt`.
6. Release scheduler slot and promote next pending after commit.

### 3.3 Archive Side Effects

Order:

1. Auth and project action check.
2. Lock/load run and workspace.
3. Refuse live write states.
4. Resolve base ref from `baseCommit ?? baseBranch ?? project.mainBranch`.
5. Call `preserveWorktree`.
6. If `ok:false`, return 409 `CONFLICT`; do not mutate archive fields.
7. If archived, set `archived_branch` and `archived_at`. If clean with nothing
   to preserve, return 200 with `archived=false`.

### 3.4 Drop Side Effects

Order:

1. Auth and project action check.
2. Lock/load run and workspace.
3. Refuse live write states.
4. Preserve exactly as archive.
5. If preserve fails, return 409 and do not remove.
6. Remove with `removeOwnedWorktree({ allowedRoot: worktreesRoot(), force:true })`.
7. One transaction records `removed_at`, archive fields if created, and marks
   unpromoted non-terminal review/crash rows `Abandoned`. `Done` stays `Done`.

### 3.5 Export Branch Side Effects

Order:

1. Auth and project action check.
2. Lock/load run and workspace.
3. Refuse live write states and removed worktrees.
4. Run `statusPorcelain`.
5. If dirty and `snapshotDirty` is false, return 409 `PRECONDITION`.
6. If dirty and `snapshotDirty` is true, run `git add -A` and
   `git commit --no-verify -m <commitMessage>` inside the worktree.
7. Validate remote and push the server-state run branch with `pushBranch`.
8. If git reports non-fast-forward, return 409 `CONFLICT` with
   `pushRejected=non_fast_forward`, `canForce=true`, and a retry hint.
9. If the user retries with `force=true`, push with `--force-with-lease`.
10. Return branch, remote, pushed ref, snapshot commit when created, and checkout
    guidance.
11. Do not mark `Done`; export is not promotion.

### 3.6 Handoff Metadata Side Effects

Order:

1. Auth and project action check.
2. Load run/workspace from server state.
3. Refuse removed/missing workspaces.
4. Run `statusPorcelain` to tell the UI whether snapshot commit is needed.
5. List git remotes from the parent repo with validation/redaction.
6. Return current branch, dirty flag, suggested handoff branch, existing remotes,
   and a command preview. No git mutation.

### 3.7 Snapshot Commit Side Effects

Order:

1. Auth and project action check.
2. Claim the lifecycle operation for this run or fail with `409 CONFLICT`.
3. Load run/workspace under the claim.
4. Refuse live write states and removed worktrees.
5. Run `statusPorcelain`; if clean, return `409 PRECONDITION` with no commit.
6. Run `git add -A` and `git commit --no-verify -m <commitMessage>` in the
   worktree.
7. Read and return the new HEAD commit.
8. Release/finalize the operation claim. Do not archive, push, drop, promote, or
   mark `Done`.

### 3.8 Handoff Branch Side Effects

Order:

1. Auth and project action check.
2. Claim the lifecycle operation for this run or fail with `409 CONFLICT`.
3. Load run/workspace under the claim.
4. Refuse live write states, removed worktrees, and dirty worktrees. The user
   must commit first through `snapshot-commit`.
5. Validate `handoffBranch` and `remote`.
6. Verify `remote` exists in `git remote` output.
7. Verify the requested local and remote handoff branch do not already exist.
8. Create the local handoff branch at the worktree HEAD without switching the
   worktree away from the server-owned run branch.
9. Push the handoff branch to the selected remote.
10. Return handoff branch, remote, pushed ref, HEAD commit, and copyable checkout
    commands.
11. Release/finalize the operation claim. Do not mark `Done`; handoff is not
    promotion.

### 3.9 Lifecycle Claim Decision

Use the same safety shape as `web/lib/runs/promote.ts`: claim before git or
filesystem side effects, finalize writes only if the minted token still owns the
workspace, and leave transient push failures retryable. Do not overload
promotion state unless the implementation proves it is semantically correct.
If new lifecycle claim columns are needed, add a migration plus DB docs in the
same phase.

## 4. Commit Plan

- **Commit 1** (Phase 0): `docs: specify workbench lifecycle management`
- **Commit 2** (Phases 1-2): `feat: add workbench lifecycle services and routes`
- **Commit 3** (Phase 3): `feat: surface workbench lifecycle actions`
- **Commit 4** (Phase 4): `test: cover workbench lifecycle flows`
- **Commit 5** (Phase 5): `feat: add workbench commit and branch handoff flows`
- **Commit 6** (Phase 6): `test: harden workbench lifecycle integration`
- **Commit 7** (Phase 7): `docs: align workbench lifecycle contracts`

Each checkpoint requires the phase exit gate green before committing.

## 5. Tasks

Phases 0-4 are the original first-slice implementation ledger. The current
implementation snapshot above records what exists now; future execution should
verify exact task completion before changing checkboxes. Do not recreate old
per-action modules if the current consolidated `service.ts` remains the chosen
local pattern. New refinement work starts at Phase 5 unless a Phase 0-4 gap is
confirmed during verification.

### Phase 0 - Documentation And Spec Freeze

- [x] **T0.1 - Create lifecycle domain spec.**
  Create `docs/system-analytics/workbench-lifecycle.md` with Purpose, Domain
  entities, state/action matrix, process flows, expectations, edge cases, JTBD,
  and acceptance criteria. Mark implemented vs designed precisely. Logging:
  n/a for docs.

- [x] **T0.2 - Update existing analytics docs.**
  Update `docs/system-analytics/workbench.md`, `workspaces.md`,
  `scratch-runs.md`, `runs.md`, `git-integration.md`, and
  `reconciliation-gc.md` so the current workbench lifecycle contract is not
  split between stale "Designed" wording and implemented surfaces. Logging:
  n/a for docs.

- [x] **T0.3 - Update contract docs.**
  Add OpenAPI paths for stop/archive/drop/export, update DB docs/ERDs for reused
  workspace archive fields, and update error taxonomy caller rows. Logging:
  n/a for docs.

- [x] **T0.4 - Phase 0 verification.**
  Run `git --no-pager diff --check` and the repo docs validator if available.
  Confirm every changed route/spec surface is represented in the contract map.
  Logging: n/a.

### Phase 1 - RED Tests For Core Lifecycle Services

- [x] **T1.1 - Write failing tests for action derivation.**
  Add tests for a pure lifecycle action policy that derives allowed actions from
  run status, run kind, dialog status, removed/archive state, and session
  presence. Files: `web/lib/workbench-lifecycle/__tests__/policy.test.ts`.
  Expected RED: module does not exist. Logging: tests only.

- [x] **T1.2 - Write failing tests for stop service.**
  Cover flow `Running -> Review`, missing supervisor session idempotency,
  transient supervisor failure leaves DB unchanged, slot release, and pending
  HITL/assignment closure. Files:
  `web/lib/workbench-lifecycle/__tests__/stop.test.ts`. Expected RED: service
  and route do not exist. Logging assertions: INFO stop requested/result, WARN
  missing session, ERROR scheduler failure non-fatal.

- [x] **T1.3 - Write failing tests for archive/drop/export services.**
  Cover preserve success/failure, removed worktree refusal, drop preserve-first,
  dirty export refusal, dirty export with snapshot commit, push transient 503,
  and server-state branch usage. Files:
  `web/lib/workbench-lifecycle/__tests__/archive-drop-export.test.ts`. Expected
  RED: service does not exist. Logging assertions: INFO action requested/result,
  WARN preserve failed, ERROR push failed with redacted text.

### Phase 2 - Core Services And Routes

- [x] **T2.1 - Implement lifecycle policy and DTOs.**
  Create `web/lib/workbench-lifecycle/policy.ts` with pure typed action
  derivation. Thread DTO fields into `web/lib/queries/portfolio.ts`,
  `web/lib/queries/project.ts`, `web/lib/queries/board.ts`, and
  `web/lib/queries/run.ts`. Logging: none in pure policy/read models.
  Depends on T1.1.

- [x] **T2.2 - Implement stop service and flow route.**
  Create `web/lib/workbench-lifecycle/stop.ts` and
  `web/app/api/runs/[runId]/stop/route.ts`. Reuse supervisor-client
  `deleteSession`, `markAbandoned` only where appropriate, assignment closure,
  and scheduler slot release. Do not spawn agents from web. Logging:
  structured INFO/WARN/ERROR with `runId`, `projectId`, `fromStatus`,
  `supervisorStopped`, and `nextStatus`. Depends on T1.2.

- [x] **T2.3 - Implement archive/drop/export services and routes.**
  Create `web/lib/workbench-lifecycle/archive.ts`,
  `web/lib/workbench-lifecycle/drop.ts`,
  `web/lib/workbench-lifecycle/export-branch.ts`, and routes
  `archive`, `drop`, `export-branch`. Add minimal git helpers only if
  existing helpers cannot express the operation. Logging: structured action
  boundaries, no tokens, no file contents. Depends on T1.3.

- [x] **T2.4 - Phase 2 verification.**
  Run focused unit tests from Phase 1 plus `pnpm --filter maister-web
  typecheck`. Fix source, not tests, until green.

### Phase 3 - UI Surfaces

- [x] **T3.1 - Build shared action component.**
  Add `web/components/workbench/workbench-lifecycle-actions.tsx`, a client
  component with icon/action buttons, confirm dialogs, typed fetch state, and
  accessible focus handling. Use no visible feature tutorial text. Logging:
  client has no console logs.

- [x] **T3.2 - Wire left rail and portfolio/project panels.**
  Add compact action menu/buttons to `web/components/chrome/left-rail.tsx`,
  `web/components/portfolio/project-card.tsx`, and the project active workspace
  section in `web/app/(app)/projects/[slug]/page.tsx`. Ensure text never
  overlaps in compact rows. Logging: none.

- [x] **T3.3 - Wire board and detail pages.**
  Add lifecycle actions to `FlightCard` for eligible flow runs, `RunDetailPage`,
  and `ScratchDialog` via the shared component. Keep promote/recover/HITL
  domain-specific controls intact; lifecycle actions are adjacent, not a
  replacement. Logging: none.

- [x] **T3.4 - i18n.**
  Add EN/RU messages under `workbenchLifecycle`, plus any action labels needed
  in `portfolio`, `board`, `run`, and `scratch`. Logging: n/a.

### Phase 4 - Integration, E2E, And Final Gates

- [x] **T4.1 - Route integration tests.**
  Add route tests under `web/app/api/runs/[runId]/*/__tests__` for stop,
  archive, drop, and export. Use real DB/worktree integration only where needed;
  otherwise use the existing route fake patterns. Confirm runner globs match.
  Logging: assert key structured logs where practical.

- [x] **T4.2 - Read-model and component tests.**
  Extend portfolio/project/board/left-rail component tests so action DTOs render
  only for allowed states and do not render for future/unknown states. Logging:
  n/a.

- [x] **T4.3 - Playwright smoke.**
  Add an authenticated smoke spec that seeds a stopped/review workbench, opens
  it from the left rail/project/run detail, archives it, exports it with a fake
  remote, and drops it through the confirmation path. Logging: n/a.

- [x] **T4.4 - Final verification.**
  Run `pnpm --filter maister-web typecheck`, focused unit/integration tests,
  `pnpm --filter maister-web test:e2e` for the new spec if the local harness is
  available, and docs validation. Record any unrelated red lanes explicitly.

### Phase 5 - Product-Grade Commit And Handoff UX

- [x] **T5.1 - Write RED tests for handoff metadata, snapshot commit, and handoff branch services.**
  Add focused tests under
  `web/lib/workbench-lifecycle/__tests__/handoff.test.ts`. Cover server-derived
  project/workspace state, remote discovery, dirty metadata, clean worktree
  snapshot refusal, dirty snapshot commit with returned HEAD SHA, branch-name
  validation, local branch collision, remote branch collision, push transient
  `EXECUTOR_UNAVAILABLE`, and no mutation when the lifecycle claim is lost.
  Logging assertions: structured `INFO` for requested/result, `WARN` for
  collision/precondition, `ERROR` for unexpected git failure with redacted text.

- [x] **T5.2 - Add minimal git helpers for handoff without broadening `pushBranch`.**
  Extend `web/lib/worktree.ts` with single-purpose helpers:
  `listRemotes`, `headCommit`, `localBranchExists`, `remoteBranchExists`, and
  `createBranchAtHead`. Reuse `branchNameSchema`, add an exported
  `remoteNameSchema` only if routes/services need shared validation, and keep
  path/branch/remote validation inside helper boundaries. Do not implement a
  force-update flag in this phase. Depends on T5.1.

- [x] **T5.3 - Add durable lifecycle operation claiming.**
  Implement a claim/CAS guard for archive/drop/export/snapshot/handoff side
  effects, following the promotion claim pattern in `web/lib/runs/promote.ts`.
  If existing workspace columns cannot express this without overloading
  promotion semantics, add a small migration with lifecycle claim fields and
  update DB docs in Phase 7. Transient push failure must leave the operation
  retryable; stale claims must be reclaimable by timeout. Depends on T5.1.

- [x] **T5.4 - Implement metadata, snapshot commit, and handoff branch routes.**
  Add `GET /api/runs/[runId]/handoff-metadata`,
  `POST /api/runs/[runId]/snapshot-commit`, and
  `POST /api/runs/[runId]/handoff-branch`. Keep them separate from
  `export-branch` instead of adding mode flags. Metadata is read-only.
  Snapshot commit requires dirty work and a message. Handoff requires a clean
  worktree, existing remote, collision-free branch, and returns pushed ref plus
  checkout guidance. Depends on T5.2 and T5.3.

- [x] **T5.5 - Replace browser prompts with in-app lifecycle dialogs.**
  Refactor `web/components/workbench/lifecycle-actions.tsx` into a compact action
  menu plus custom accessible workbench dialogs. Stop/drop confirmations are in-app.
  Archive shows preserve implications. Export/handoff shows dirty state, remote
  selector, branch field, commit controls, typed backend errors, busy states,
  and a success result with copyable commands. No `window.confirm`,
  `window.prompt`, or console logging. Depends on T5.4.

- [x] **T5.6 - Add explicit commit action to the MAIster UI.**
  Surface `snapshotCommit` in the lifecycle policy/DTO only when a stopped or
  terminal workbench is dirty according to handoff metadata. The commit dialog
  collects a message, calls `snapshot-commit`, refreshes the current panel, and
  displays the new commit SHA. It must not push, archive, drop, promote, or
  create a branch. Depends on T5.4 and T5.5.

- [x] **T5.7 - Implement branch creation and local checkout handoff UX.**
  Add a handoff branch flow that suggests a branch name, validates it as the
  user types, refuses collisions with actionable errors, pushes the created
  branch to the selected remote, and shows copyable non-chained commands. The
  command text must make clear whether the user should run it from the parent
  repo or any local clone. Depends on T5.4 and T5.5.

- [x] **T5.8 - Bring scratch detail onto the shared lifecycle surface.**
  Replace the bespoke stop/discard controls in
  `web/components/scratch/scratch-dialog.tsx` with the shared lifecycle action
  component where applicable. Keep scratch recover, messages, HITL, diff, and
  promote controls adjacent. Align scratch discard with preserve-first drop
  semantics or keep the old route as a compatibility wrapper around the new
  drop service. Depends on T5.5.

- [x] **T5.9 - Phase 5 verification.**
  Run `pnpm --filter maister-web exec vitest run --project unit` for the new
  lifecycle handoff tests and affected component tests, then
  `pnpm --filter maister-web typecheck`. Fix source behavior, not tests, until
  green.

### Phase 6 - Real Git, Race, And Browser Verification

- [x] **T6.1 - Add real-git integration tests for lifecycle filesystem behavior.**
  Add a temp-repo integration suite that creates a parent repo, MAIster-owned
  worktree, local bare remote, dirty tracked/untracked files, and run/workspace
  rows. Cover archive preserve, drop preserve-then-remove, snapshot commit,
  collision-free handoff branch creation, remote push, and unsafe worktree
  refusal. Keep network disabled by using file remotes.

- [x] **T6.2 - Add route integration tests for auth and trust boundaries.**
  Verify route handlers derive project id, branch, worktree path, base ref, and
  session ids from DB state, ignore body-provided spoofed identifiers, return
  401/403/409/503 correctly, and do not expose raw supervisor handles.

- [x] **T6.3 - Add race/idempotency tests.**
  Race two archive/drop/export/snapshot/handoff calls for the same run. Assert
  one owner wins, the loser gets `409 CONFLICT` or an idempotent no-op where
  explicitly allowed, and no double remove, double commit, or branch overwrite
  occurs.

- [x] **T6.4 - Add product-surface component tests.**
  Use React Testing Library/user-event for the lifecycle dialogs: open/close,
  focus restoration, remote select, branch validation, commit message
  validation, backend error rendering, success command copy buttons, and no
  action buttons for future/unknown statuses.

- [x] **T6.5 - Add Playwright smoke and Browser visual verification.**
  Seed stopped/review and terminal workbenches, then verify left rail, portfolio
  project card, project active workspace panel, board card, run detail, and
  scratch dialog. Exercise archive, snapshot commit, handoff branch, export
  result, and drop confirmation. Capture desktop and mobile screenshots or
  browser assertions to confirm controls do not overlap.

- [x] **T6.6 - Phase 6 verification.**
  Run the new integration/component tests, `pnpm --filter maister-web
  typecheck`, and the focused Playwright smoke when the local harness is
  available. Record unrelated red lanes separately.

### Phase 7 - Contract And Documentation Alignment

- [x] **T7.1 - Tighten OpenAPI schemas.**
  Update `docs/api/web.openapi.yaml` for exact response enums and the new
  metadata/snapshot/handoff routes. Fix the drop response schema so it reflects
  actual service outcomes (`Done` or `Abandoned`) instead of listing source
  statuses.

- [x] **T7.2 - Update lifecycle analytics and git-integration docs.**
  Update `docs/system-analytics/workbench-lifecycle.md`,
  `git-integration.md`, `workspaces.md`, `scratch-runs.md`, `runs.md`, and
  `reconciliation-gc.md` with current-state wording. Do not duplicate the same
  explanation across files; link to the lifecycle doc where it is the source of
  truth.

- [x] **T7.3 - Update DB docs if lifecycle claim fields are added.**
  If T5.3 requires a migration, update `docs/database-schema.md`,
  `docs/db/runs-domain.md`, and `docs/db/erd.md`. If no migration is needed,
  document the no-migration rationale in `workbench-lifecycle.md`.

- [x] **T7.4 - Final contract verification.**
  Run JSON/YAML parsing for EN/RU messages and OpenAPI, docs mermaid validation
  if present, `git --no-pager diff --check`, focused tests from Phases 5-6, and
  `pnpm --filter maister-web typecheck`.

## Risks And Watch Items

- Exporting a branch from a dirty worktree creates a real commit. The UI must
  require explicit opt-in and a commit message.
- Branch handoff creates a new git ref. The first implementation refuses local
  and remote collisions; any future "refresh existing branch" action must be a
  separate deliberate operation with its own wording and tests.
- Do not use browser-native dialogs for final UX. They are acceptable only as an
  early spike, not as the MAIster user surface.
- Remote names are user-controlled input, even when selected from the UI. Always
  validate before passing to git and never echo unredacted remote URLs in errors.
- Lifecycle claim state must not be confused with promotion completion. Handoff
  and export help a human continue work; they do not mean `Done`.
- If lifecycle claim columns are added, keep stale-claim reclaim behavior
  explicit. A crashed web request after commit/push should be retryable or
  inspectable, not silently wedged.
- Stop-to-Review broadens the meaning of `Review`: it can mean agent completed
  or operator stopped. Promotion readiness already re-gates, so this is safe,
  but docs must say it plainly.
- Scheduler release after stop should preserve the stopped run result even when
  promoting the next queued run fails; log that failure and make the queued run
  recoverable instead of turning a successful stop into a confusing 500.
- `scratch-runs/[runId]/discard` currently removes the worktree immediately.
  This feature should either align it with preserve/drop semantics or keep the
  old route as a compatibility wrapper around the new drop service.
- Push uses host credentials. CI should mock push; manual verification against a
  real remote remains required.
- Use file-based bare remotes for automated integration tests so branch push
  behavior is covered without network or credential dependencies.
- Do not add a new `runs.status` value unless implementation proves `Review`
  cannot carry stopped workbenches. A new status would require full fan-out.
