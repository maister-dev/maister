# Implementation Plan: Custom Workspace Scratch Runs

Branch: HEAD detached (plan-only); suggested implementation branch `feature/scratch-runs`
Created: 2026-05-31
Improved: 2026-05-31 via `$aif-improve`

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: The user explicitly marked custom workspace runs as outside the
existing ROADMAP scope. This plan treats the feature as a new product surface
that must update system analytics, API contracts, DB docs, and product docs
without pretending it already belongs to an existing milestone.

## Source Requirements

Primary source: `docs/system-analytics/scratch-runs.md`.

The feature implements manual, conversation-like coding-agent workspaces:

- startable outside the task board when no task is linked;
- visible in Portfolio and project active workspace lists;
- backed by a MAIster-created git worktree and named scratch branch;
- opened as a simple coding-agent dialog, not a Flow run page first;
- executed through the supervisor ACP session API, never by web-spawning an
  agent process;
- launchable with project, base branch, scratch branch/name, executor, plan
  mode, prompt, optional issue link, and text/file-path attachments;
- able to attach run-scoped MCPs, skills, rules, settings, and restrictions
  resolved from platform/project/Flow-package capability catalogs;
- auditable through persisted dialog messages, capability snapshots, HITL rows,
  run events, workspace state, diff, promotion, discard, and recovery.

## Current Code Observations

- `web/lib/db/schema.ts` still requires `runs.taskId`, `runs.flowId`,
  `runs.flowVersion`, and `runs.flowRevision`; scratch rows need a compatible
  migration and application invariant.
- `web/lib/worktree.ts` supports `git worktree add -b <branch> <path>` only; it
  cannot create from an explicit base branch/ref, resolve a base commit, diff a
  branch, or promote a branch.
- `web/lib/config.schema.ts` parses `maister.yaml` project/executors/flows only;
  the capability registry described in docs is not implemented.
- `supervisor/src/types.ts` `StartSessionRequestSchema` accepts only
  run/project/worktree/step/executor/resume fields. Capability materialization
  requires an explicit supervisor contract if adapter launch args or env must
  change.
- `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts` already has
  the two-phase permission response pattern scratch runs should reuse.
- `web/lib/flows/runner-agent.ts` already consumes supervisor SSE while a prompt
  is active and cancels hidden permission deferrals on persistence failure; the
  scratch dialog needs an extracted/reused equivalent instead of duplicating an
  unsafe partial event consumer.
- `web/lib/scheduler.ts` promotes queued `Pending` runs by calling `runFlow`.
  Scratch runs are interactive sessions, so v1 must not silently enter that
  Flow queue without a scratch-specific dispatcher.
- No implemented run diff/promote API exists yet; docs describe it as designed.

## Locked Product Decisions

- Scratch runs are first-class `runs`, not hidden tasks. Add
  `runs.runKind = "flow" | "scratch"` with default `"flow"`.
- Scratch rows may have no `task_id`, no `flow_id`, and no
  `flow_revision_id`. Keep `flow_version` / `flow_revision` non-null for
  legacy display by writing scratch sentinel values `"scratch"` / `"manual"`.
- Dialog state lives on `scratch_runs.dialog_status`:
  `Starting | WaitingForUser | Running | NeedsInput | Review | Crashed | Done |
  Abandoned`. Do not add `WaitingForUser` to `runs.status` in v1.
- `runs.status` remains the existing shared lifecycle:
  `Pending | Running | NeedsInput | NeedsInputIdle | Review | Crashed | Done |
  Abandoned | Failed`.
- While a scratch supervisor session is live, `runs.status = "Running"` counts
  against the existing global live-session cap. `WaitingForUser` is only the
  scratch dialog axis and still consumes a live session slot.
- Scratch v1 does not queue. If the global cap is full, launch returns a typed
  `PRECONDITION` / `CONFLICT` before worktree, DB, or supervisor side effects.
  A scratch queue requires a later scratch-specific dispatcher.
- Initial implementation creates named branches only. Detached scratch
  worktrees are deferred because promotion, recovery, and workspace cards need a
  stable branch.
- Capability attachment is a launch-time snapshot. The UI may default all
  project-enabled MCPs selected, but the session receives only the resolved
  profile persisted for that run.
- Capability resolution fails closed for enforced capabilities. Unsupported
  optional capabilities may be downgraded to instructed-only only when the
  persisted profile records the downgrade.
- Skills/rules/MCPs come only from platform configuration, project
  configuration, and trusted enabled Flow package revisions visible to the
  project. Unknown, removed, untrusted, disabled, or cross-project ids are
  rejected.
- Plan mode is persisted and visible. In v1 it is prompt-policy plus capability
  profile metadata, not a hard tool sandbox.
- Web creates and owns DB/worktree/capability artifacts; supervisor owns agent
  processes. No web module may spawn `claude`, `codex`, or adapter binaries.

## Contract Surfaces To Update

- System analytics:
  - `docs/system-analytics/scratch-runs.md`
  - `docs/system-analytics/runs.md`
  - `docs/system-analytics/workspaces.md`
  - `docs/system-analytics/hitl.md` when scratch reuses the HITL response path
  - `docs/system-analytics/git-integration.md` for base-branch/diff/promote
  - `docs/system-analytics/external-operations.md` only if an external API can
    launch scratch runs in the same implementation
- Web OpenAPI: `docs/api/web.openapi.yaml`.
  - `GET /api/scratch-runs/launch-options`
  - `POST /api/scratch-runs`
  - `GET /api/scratch-runs/{runId}`
  - `POST /api/scratch-runs/{runId}/messages`
  - `POST /api/scratch-runs/{runId}/stop`
  - `POST /api/scratch-runs/{runId}/discard`
  - `GET /api/runs/{runId}/diff`
  - `POST /api/runs/{runId}/promote`
  - documented scratch reuse of
    `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond`
- Browser events: `docs/api/async/web-runs.asyncapi.yaml`.
  - Document scratch dialog projections over the existing
    `/api/runs/{runId}/stream` bridge. V1 does not add a second browser SSE
    route.
- Supervisor contracts:
  - `docs/api/supervisor.openapi.yaml`
  - `docs/api/async/supervisor-sse.asyncapi.yaml` only if event shape changes
  - `docs/supervisor.md`
  - `supervisor/src/types.ts`
  - `web/lib/supervisor-client.ts`
- DB docs and ERDs:
  - `docs/database-schema.md`
  - `docs/db/runs-domain.md`
  - `docs/db/erd.md`
  - `docs/db/README.md` if a new scratch-domain DB doc is added
- Configuration:
  - `docs/configuration.md`
  - `.env.example`, compose files, and package manifests only if the
    implementation adds new runtime configuration, sidecars, or dependencies.
- Product docs:
  - `docs/PRODUCT_VIEW.md`
  - `docs/VISION.md`
  - `.ai-factory/DESCRIPTION.md` only after implementation materially changes
    the current product-state summary.
- Error taxonomy:
  - `docs/error-taxonomy.md`. Reusing existing `MaisterError` codes still
    requires updating "Where thrown" / examples.

## Identifier Trust Boundaries

Every route must derive cross-resource identifiers from server state.

- `GET /api/scratch-runs/launch-options`
  - `auth-context`: user id, global role.
  - `query`: optional project id/slug filter.
  - `server-state`: project membership, project repo path, executor rows,
    platform/project/package capability catalogs.
  - Validate project visibility before returning project branches or
    capabilities.
- `POST /api/scratch-runs`
  - `auth-context`: user id.
  - `body-controlled`: `projectId`, `baseBranch`, `branchName`, `name`,
    `prompt`, `executorId`, `planMode`, `linkedTaskId`, `linkedIssueUrl`,
    `attachments`, selected capability ids.
  - `server-state`: project row, project membership, executor row, optional
    linked task row, resolved base commit, generated run id, worktree root,
    capability catalog rows.
  - Body must never carry `projectSlug`, `worktreePath`, `runId`, `stepId`,
    `supervisorSessionId`, `acpSessionId`, or capability file paths.
- `GET /api/scratch-runs/{runId}`
  - `url-param`: `runId`.
  - `server-state`: run row, project membership, scratch metadata, workspace,
    capability snapshot.
- `POST /api/scratch-runs/{runId}/messages`
  - `url-param`: `runId`.
  - `body-controlled`: message content and attachment refs only.
  - `server-state`: scratch run row, dialog state, active
    `supervisor_session_id`, project membership, next sequence number.
  - Body must not accept session id, project slug, worktree path, step id, or
    message sequence.
- `POST /api/scratch-runs/{runId}/stop|discard|promote`
  - `url-param`: `runId`.
  - `server-state`: scratch run, workspace path, branch, base commit,
    target branch policy, supervisor session id.
  - `body-controlled`: promote mode/target branch only when validated against
    project git policy.
- HITL response
  - Prefer reuse of `/api/runs/{runId}/hitl/{hitlRequestId}/respond`.
  - `url-param`: `runId`, `hitlRequestId`.
  - `server-state`: HITL row, run row, pending request id, supervisor session id,
    allowed options.
  - `body-controlled`: selected option or form/human response only.

## Side-Effect Ordering Decisions

Scratch launch has filesystem, DB, and supervisor side effects. Implement in
this order:

1. Authenticate with `requireActiveSession`.
2. Resolve project row and `requireProjectAction(project.id, "launchRun")`.
3. Validate project is not archived, executor belongs to project, optional task
   belongs to project, prompt/attachments are valid, branch/base ref are safe,
   and selected capabilities are visible.
4. Check supervisor readiness.
5. Check the shared live-session cap under the scheduler lock. If full, reject
   before worktree or DB side effects. Scratch v1 does not queue.
6. Resolve base ref to base commit server-side.
7. Create `git worktree add -b <scratchBranch> <worktreePath> <baseRef>`.
8. Materialize run-scoped capability profile.
9. Insert `runs`, then `workspaces`, then `scratch_runs`, messages,
   attachments, and capability snapshot rows in one DB transaction.
10. `POST /sessions` with server-derived ids and any capability launch fields.
11. Update scratch metadata with `supervisor_session_id` and `runs.acp_session_id`.
12. Append initial user message and dispatch initial prompt.
13. If DB transaction fails after worktree/materialization, compensate only
    artifacts proven to be created by this request.
14. If supervisor session or prompt fails after DB commit, preserve worktree and
    persisted messages; transition to retryable `Crashed` or `WaitingForUser`
    with explicit error metadata. Do not silently delete operator work.

Scratch message send is a two-phase operation:

1. Under row lock, verify run kind is scratch, user can access the project,
   dialog state accepts input, session is live, and no prompt is active.
2. Append user message with next monotonic sequence and set dialog state
   `Running`.
3. Call supervisor prompt.
4. Project supervisor events to persisted assistant/tool/system messages.
5. Set dialog state `WaitingForUser` on `end_turn`, `NeedsInput` on permission,
   `Crashed` on crash, or retryable error metadata on supervisor 5xx/network.

Scratch permission response must reuse the existing two-phase HITL pattern:

1. Store intent before supervisor delivery.
2. Mark responded only after successful supervisor delivery.
3. Keep retryable state on supervisor 5xx/network failure.
4. Terminal-fail only on true timeout/expired deferred.
5. If permission request persistence fails, call `cancelPermission` before
   surfacing failure, matching the no-hidden-deferred contract.

## Deployment Wiring

- Expected v1: no new ports, no new daemon, no new sidecar.
- Capability launch adds supervisor adapter args/env fields. Update supervisor
  Zod schema, OpenAPI, web client types, and spawn tests in the same task.
- If implementation adds a tunable capability catalog path or materialization
  root, update `.env.example`, `docs/configuration.md`, `compose.yml`,
  `compose.override.yml`, and `compose.production.yml`.
- If a new package dependency is needed, add it to the owning package
  `package.json`, update the lockfile, and add a smoke test proving it loads.

## Test Integrity Gates

- New web unit tests must be under paths included by `web/vitest.workspace.ts`:
  `lib/**/*.test.ts`, `lib/**/__tests__/**/*.test.ts`,
  `app/**/__tests__/**/*.test.ts`, `components/**/*.test.ts`, or
  `components/**/__tests__/**/*.test.ts`.
- New web integration tests must be under `lib/**/*.integration.test.ts` or
  `app/**/*.integration.test.ts`.
- If a test lands outside those globs, the same task must update
  `web/vitest.workspace.ts` and run the relevant `-- --list` command to prove
  discovery.
- Do not pipe verification commands through `tail`, `head`, or `grep` unless
  `pipefail` is explicitly set and the true failing command exit code is
  captured.
- Phase exit gates:
  - docs phases: `git --no-pager diff --check`, `pnpm validate:docs` after
    root dependencies are installed;
  - web code phases: `pnpm --filter maister-web test:unit`,
    `pnpm --filter maister-web test:integration`,
    `pnpm --filter maister-web typecheck`,
    `pnpm --filter maister-web lint`;
  - supervisor code phases if touched:
    `pnpm --filter @maister/supervisor test:unit`,
    `pnpm --filter @maister/supervisor test:integration`,
    `pnpm --filter @maister/supervisor typecheck`,
    `pnpm --filter @maister/supervisor lint`.

## Commit Plan

- **Commit 1** (tasks 1-5): `docs: specify scratch run contracts`
- **Commit 2** (tasks 6-10): `feat: add scratch run persistence`
- **Commit 3** (tasks 11-15): `feat: launch scratch supervisor sessions`
- **Commit 4** (tasks 16-19): `feat: add scratch lifecycle actions`
- **Commit 5** (tasks 20-23): `feat: add scratch workspace UI`
- **Commit 6** (tasks 24-26): `test: verify scratch run workflows`

## Tasks

### Phase 0: SDD Source Of Truth

- [x] Task 1: Finalize scratch-run analytics decisions.
  - Update `docs/system-analytics/scratch-runs.md`.
  - Mark every element as Implemented, Designed, or Phase 2.
  - Lock the state mapping: `scratch_runs.dialog_status` carries
    `WaitingForUser`; `runs.status` remains compatible with existing code.
  - Document that scratch v1 checks the shared live-session cap but does not
    queue.
  - Document planned structured log events for launch, prompt send, prompt
    completion, permission wait, stop, discard, promote, and recovery.
  - Acceptance: no ambiguous MAY where implementation requires MUST; state,
    scheduler, DB, and API descriptions agree.

- [x] Task 2: Update DB narrative and ERDs.
  - Update `docs/database-schema.md`, `docs/db/runs-domain.md`, and
    `docs/db/erd.md`.
  - Document `runs.run_kind`, nullable scratch behavior for `task_id`,
    `flow_id`, and `flow_revision_id`, plus scratch sentinels
    `flow_version="scratch"` and `flow_revision="manual"`.
  - Document `scratch_runs`, `scratch_messages`, `scratch_attachments`,
    capability profile snapshot tables, base branch, base commit, target branch,
    supervisor session id, and dialog status.
  - Document indexes:
    `runs(project_id,status,run_kind)`, `runs(run_kind,task_id)`,
    `scratch_runs(run_id)`, `scratch_messages(run_id,sequence)`, attachment
    lookups, and capability snapshot lookups by run.
  - Acceptance: Mermaid ERDs render, narrative and ERD agree, and task board
    queries explicitly exclude scratch runs.

- [x] Task 3: Update Web API and event contracts.
  - Update `docs/api/web.openapi.yaml` for launch options, launch, read,
    messages, stop, discard, diff, promote, and HITL reuse.
  - Update `docs/api/async/web-runs.asyncapi.yaml` for scratch dialog
    projections over run events.
  - Update `docs/error-taxonomy.md` with scratch examples under existing error
    codes.
  - Route schemas must include capability selections, issue link, attachments,
    plan mode, base branch, and branch name.
  - Route schemas must exclude body-controlled `runId`, `projectSlug`,
    `worktreePath`, `stepId`, `supervisorSessionId`, and `acpSessionId`.
  - Acceptance: OpenAPI and analytics name the same routes, status codes, and
    no-side-effect launch gates.

- [x] Task 4: Update supervisor and capability contracts.
  - Extend `StartSessionRequest` with a server-derived
    `capabilityProfilePath` and a constrained `adapterLaunch` object for
    materializer-produced env/args.
  - Update `docs/api/supervisor.openapi.yaml`, `docs/supervisor.md`, and
    `docs/api/async/supervisor-sse.asyncapi.yaml` only for real contract
    changes.
  - Update `docs/configuration.md` for the implemented capability subset.
  - Add an adapter support matrix for Claude and Codex:
    MCP activation, skill/rule materialization, settings, restrictions, and
    unsupported/downgraded behavior.
  - Acceptance: docs state exactly which capability kinds are enforced,
    instructed-only, or refused in v1.

- [x] Task 5: Update product docs.
  - Update `docs/PRODUCT_VIEW.md` and `docs/VISION.md` to include custom
    workspace runs as a manual intake surface.
  - Keep the Flow-over-prompt principle for task-board work intact.
  - State that scratch runs are active workspaces outside the task board unless
    explicitly linked to a task.
  - Acceptance: product docs describe current product state, not a changelog or
    roadmap claim.

### Phase 1: Persistence, Git Primitives, And Capability Schema

- [x] Task 6: Add Drizzle schema and migration.
  - Modify `web/lib/db/schema.ts`.
  - Add `runs.runKind` enum with values `flow | scratch`, default `flow`.
  - Make `runs.taskId`, `runs.flowId`, and `runs.flowRevisionId` nullable as
    required for scratch. Keep `flowVersion` and `flowRevision` non-null and
    write `"scratch"` / `"manual"` for scratch rows.
  - Add `scratch_runs`, `scratch_messages`, `scratch_attachments`, and
    run capability snapshot tables.
  - Add `base_branch`, `base_commit`, optional `target_branch`,
    `supervisor_session_id`, `dialog_status`, error metadata, and created-by
    user references where documented.
  - Generate migration SQL and Drizzle meta under `web/lib/db/migrations/`.
  - Add application-level validators for cross-column rules because Postgres and
    SQLite test modes must behave the same.
  - Tests: update `web/lib/db/__tests__/schema.integration.test.ts` or add
    `scratch-schema.integration.test.ts`; seed required FK rows instead of
    inserting invalid nulls for flow runs.

- [x] Task 7: Extend authz and domain invariants.
  - Update `web/lib/authz.ts` only if existing actions are too coarse.
  - Minimum roles:
    viewer can read scratch workspace/dialog metadata;
    member can launch, send messages, stop, discard;
    admin/owner or existing promotion policy can promote if promotion is
    privileged.
  - Add pure validators for run-kind invariants:
    flow run requires task/flow;
    scratch run requires scratch metadata and no hidden task.
  - Tests: authz integration for viewer/member/admin behavior and cross-project
    denial.

- [x] Task 8: Extend git/worktree helpers.
  - Modify `web/lib/worktree.ts`.
  - Add safe base-ref validation and `git rev-parse --verify <baseRef>` helper.
  - Extend `addWorktree` to accept a server-validated `startPoint`.
  - Add helpers for branch existence/listing, diff from `base_commit` to scratch
    branch, local merge promotion, merge abort on conflict, and safe worktree
    removal.
  - Do not construct paths from body fields; all repo/worktree paths come from
    project/workspace rows.
  - Tests: unit or integration tests for argv construction, invalid ref
    rejection, branch collision, diff base commit, merge conflict handling, and
    ownership-gated cleanup.

- [x] Task 9: Implement capability catalog schemas and config parsing.
  - Modify `web/lib/config.schema.ts`, `web/lib/config.ts`, and config tests.
  - Parse the v1 subset of `maister.yaml capabilities` needed by scratch runs:
    MCPs, skills, rules/restrictions, tools/settings if accepted by the support
    matrix.
  - Add a platform capability source from `.mcp.json` or the chosen platform
    registry, with explicit precedence against project config.
  - Add Flow-package asset discovery only from trusted enabled revisions.
  - YAML to DB symmetry tests:
    SET creates/updates selectable records;
    CLEAR disables/removes them for future launches;
    RE-SET makes them selectable again with the new value.
  - Logging: DEBUG parsed counts by kind, INFO upsert summary, WARN ignored
    unsupported mappings, ERROR schema failures with YAML path.

- [x] Task 10: Add capability profile resolver and materializer.
  - Create `web/lib/capabilities/catalog.ts`, `resolver.ts`,
    `materialize.ts`, `types.ts`, and tests.
  - Resolver input: project id, executor agent, selected MCP ids, selected skill
    ids, selected rule/restriction ids, plan mode, optional linked task.
  - Resolver output: immutable snapshot with supported, instructed, enforced,
    refused, unsupported, and downgraded entries.
  - Materializer writes only this run's selected capabilities into a run-scoped
    directory. Avoid leaking secrets into persisted snapshots or client-visible
    payloads.
  - Fail closed for selected enforced capabilities unsupported by the executor.
  - Tests: default-all-MCP selection, unchecked MCP omission, unknown id
    rejection, executor compatibility, Flow-package trust filtering, no secret
    logging, and deterministic snapshot serialization.

### Phase 2: Services, Supervisor Contract, And Launch

- [x] Task 11: Add scratch run service modules.
  - Create `web/lib/scratch-runs/types.ts`, `state.ts`, `messages.ts`,
    `attachments.ts`, `launch.ts`, and `events.ts`.
  - Keep route handlers thin; put validation, state transitions, row locking,
    prompt locking, and compensation logic in server-only modules.
  - Implement pure helpers for scratch name fallback, branch derivation,
    attachment validation, prompt decoration for plan mode, and DTO projection.
  - Attachment v1: issue URL, text note, and file path. File paths must resolve
    inside the project repo or scratch worktree; no arbitrary host paths.
  - Logging: DEBUG function entry with ids, INFO transitions, WARN retryable
    compensation, ERROR unexpected DB/supervisor failures with run/project ids.
  - Tests: pure helper unit tests and service invariant integration tests.

- [x] Task 12: Extend supervisor session contract for capability launch.
  - Modify `supervisor/src/types.ts`, `supervisor/src/spawn.ts`,
    `supervisor/src/http-api.ts`, `web/lib/supervisor-client.ts`, and
    supervisor tests for the new launch-time capability fields from Task 4.
  - Validate any new paths as absolute, server-derived, and under the expected
    run-scoped materialization root.
  - Map supported capability fields to adapter env/args in one place in
    `spawn.ts`.
  - Do not log secrets or raw prompts.
  - Tests: Zod rejects body-controlled unsafe paths/unknown keys, spawn receives
    expected args/env for Claude and Codex, unsupported combinations fail before
    child spawn.

- [x] Task 13: Implement scratch capacity gate.
  - Extend `web/lib/scheduler.ts` with a helper that checks the same global live
    count under the scheduler lock without enqueueing scratch runs.
  - The helper must count `Running` and `NeedsInput` flow runs plus live scratch
    runs represented by `runs.status = "Running"`.
  - Launch must reject when full before worktree/DB/supervisor side effects.
  - Tests: cap full rejects scratch launch with no side effects; cap available
    allows launch; terminal/review scratch run frees capacity.

- [x] Task 14: Implement `POST /api/scratch-runs`.
  - Create `web/app/api/scratch-runs/route.ts`.
  - Auth first, then derive project, membership, executor, optional task, base
    commit, branch policy, and capability allow-list from server state.
  - Check supervisor readiness before filesystem or DB side effects.
  - Check scratch capacity before filesystem or DB side effects.
  - Create worktree from selected base branch and named scratch branch.
  - Materialize capability profile.
  - Insert `runs` before `workspaces`, then scratch metadata/messages/
    attachments/profile rows in one transaction.
  - Start supervisor session, store session ids, append initial user message,
    and send initial prompt.
  - Compensate DB failures by removing only request-created artifacts.
  - Preserve worktree and durable rows on post-commit supervisor failures.
  - Tests: supervisor-unavailable no side effects; cap-full no side effects;
    DB failure compensates worktree/materialization; prompt failure preserves
    retryable scratch row; body-controlled ids rejected.

- [x] Task 15: Implement launch-options route.
  - Create `web/app/api/scratch-runs/launch-options/route.ts`.
  - Return visible projects, selected project's branches, executors, default
    branch, default scratch branch suggestion, default-selected MCPs, skills,
    rules/restrictions, and trusted Flow package assets.
  - Branch listing uses project repo path from DB only.
  - Tests: admin/member visibility, archived exclusion, branch listing errors,
    project capability scoping, no cross-project leakage.

### Phase 3: Dialog Runtime And Events

- [x] Task 16: Implement scratch read and message send routes.
  - Add `GET /api/scratch-runs/[runId]/route.ts`.
  - Add `POST /api/scratch-runs/[runId]/messages/route.ts`.
  - Under row lock, verify run kind scratch, project access, non-terminal state,
    live supervisor session, and no active prompt.
  - Append user message with next monotonic sequence and set dialog status
    `Running`.
  - Send prompt through `web/lib/supervisor-client.ts`.
  - Persist retryable failure state if supervisor call fails.
  - Tests: prompt locking, append-only sequence, unknown run, non-scratch
    rejection, cross-project auth rejection, supervisor 5xx retryable state.

- [x] Task 17: Project supervisor events into scratch messages.
  - Extract/reuse the safe event-consumer behavior from
    `web/lib/flows/runner-agent.ts` into `web/lib/scratch-runs/events.ts` or a
    shared server-only module.
  - Convert assistant text chunks, tool calls, permission requests, exits, and
    crashes into dialog-readable persisted messages while preserving
    `run.events.jsonl` as durable replay.
  - Avoid `fs.watch`, `chokidar`, or background polling. Use supervisor SSE
    during active prompt dispatch and the existing run-log SSE bridge for
    browser replay.
  - On permission persistence failure, call `cancelPermission`.
  - Tests: assistant projection, tool/system projection, `end_turn` to
    `WaitingForUser`, permission to `NeedsInput`, crash to `Crashed`, and
    cancel-on-permission-persist-failure.

- [x] Task 18: Reuse or generalize HITL response for scratch.
  - Adapt `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts` to
    accept scratch runs by delegating to shared service functions.
  - Preserve the existing two-phase permission commit and idempotent retry
    semantics.
  - Ensure terminal scratch statuses block retry.
  - Tests: scratch permission response, same-payload retry, different-payload
    conflict, supervisor 5xx retryable, terminal timeout, non-scratch behavior
    unchanged.

- [x] Task 19: Implement scratch stop and discard.
  - Add `POST /api/scratch-runs/[runId]/stop/route.ts`.
  - Add `POST /api/scratch-runs/[runId]/discard/route.ts`.
  - Stop deletes the live supervisor session when present and transitions
    scratch dialog + `runs.status` to `Review` if the workspace exists.
  - Discard terminates session if live, removes the worktree only from the
    server-derived workspace path, marks `workspaces.removedAt`, and transitions
    to `Abandoned`.
  - Both routes must be idempotent for already-stopped/already-discarded runs.
  - Tests: idempotent stop, discard with no live session, removed workspace no
    longer active, non-scratch rejection, cross-project denial.

### Phase 4: Diff, Promotion, Recovery, And Reconciliation

- [x] Task 20: Implement diff and promotion primitives/routes.
  - Add shared git helpers from Task 8 to route-level services.
  - Add shared `GET /api/runs/[runId]/diff` and
    `POST /api/runs/[runId]/promote`.
  - Diff compares stored `base_commit` to scratch branch/worktree state.
  - Promotion validates target branch server-side and uses project promotion
    policy. Local merge uses `git merge --no-ff`; conflict aborts and leaves run
    in `Review`.
  - Tests: diff command construction, target validation, conflict response,
    successful status transition, non-scratch compatibility if shared route.

- [x] Task 21: Implement scratch recovery and reconciliation.
  - Update `web/lib/reconcile.ts`, `web/lib/runs/resume.ts`,
    `web/lib/runs/resume-recovery.ts`, or scratch-specific recovery modules.
  - Scratch runs with `acp_session_id` and missing live supervisor session can
    recover via `--resume` and a new prompt turn.
  - Scratch runs without resume handle offer Discard only.
  - Reconciliation must classify missing worktree/live-session mismatches and
    surface Open/Recover/Discard in active workspace cards.
  - Tests: scratch orphan classification, resume availability, discard-only
    state, failed resume with supervisor response context.

### Phase 5: UI And UX

- [x] Task 22: Add scratch launcher UI.
  - Add entry points from Portfolio and project pages.
  - Create components under `web/components/scratch/` or route-local components
    under `web/app/(app)/scratch-runs/`.
  - Controls: workspace name, project, base branch, branch name, executor, plan
    mode, prompt, MCP dropdown with default-selected checkboxes, skills/rules
    dropdowns, issue URL, attachment list.
  - Use HeroUI and existing MAIster design language; no marketing hero or
    explanatory in-app prose.
  - Tests: component tests for state/validation and API payload projection.

- [x] Task 23: Add scratch dialog page.
  - Create `web/app/(app)/scratch-runs/[runId]/page.tsx`.
  - Main surface: chat-style coding-agent dialog with message list, composer,
    attachment affordances, permission cards, and workspace context bar.
  - Secondary surfaces: capability profile, files/diff link, raw events/logs,
    metadata, linked issue/task.
  - Composer disabled while prompt active, permission pending, stopped,
    discarded, done, or crashed without recovery.
  - Tests: message rendering, composer disabled states, permission card actions,
    capability profile display.

- [x] Task 24: Integrate scratch into active workspace views.
  - Update `web/lib/queries/portfolio.ts`, portfolio components, project page
    queries/components, and active workspace counts.
  - Active workspace counts include scratch; backlog and task-board counts do
    not.
  - Scratch cards show scratch name, project, branch, executor, dialog status,
    last activity, and Open dialog action.
  - Update `web/lib/queries/board.ts` to explicitly filter `runKind="flow"` if
    any new nullable run relation could otherwise affect future board queries.
  - Tests: portfolio scratch visibility, project active workspace visibility,
    task-board absence, removed workspace exclusion.

- [x] Task 25: Add i18n and responsive polish.
  - Update `web/messages/en.json` and `web/messages/ru.json`.
  - Cover launcher, dialog, statuses, capability selectors, attachment errors,
    capacity errors, HITL, stop/discard/promote/recover actions.
  - Ensure mobile and desktop controls do not overflow or overlap.
  - Add Playwright smoke coverage if existing auth/project seed makes it cheap;
    otherwise document the blocker in implementation notes.

### Phase 6: Final Verification And Docs Sync

- [x] Task 26: Run full verification and reconcile docs to as-built behavior.
  - Commands:
    - `git --no-pager diff --check`
    - `pnpm validate:docs`
    - `pnpm --filter maister-web test:unit`
    - `pnpm --filter maister-web test:integration`
    - `pnpm --filter maister-web typecheck`
    - `pnpm --filter maister-web lint`
    - if supervisor touched:
      `pnpm --filter @maister/supervisor test:unit`,
      `pnpm --filter @maister/supervisor test:integration`,
      `pnpm --filter @maister/supervisor typecheck`,
      `pnpm --filter @maister/supervisor lint`
  - Confirm any new test path family is discovered by Vitest list output.
  - Reconcile implementation against `docs/system-analytics/scratch-runs.md`,
    OpenAPI, AsyncAPI, DB docs, and error taxonomy.
  - Implementation note: web unit/typecheck/lint, supervisor unit slice,
    diff whitespace, and Mermaid docs validation passed. Web integration remains
    a required exit gate and must be rerun green before merge.
  - Update `README.md` docs table only if scratch runs get a user-facing guide.
  - Update `.ai-factory/DESCRIPTION.md` and `AGENTS.md` only if current-scope
    or structure changed materially.
  - Do not link scratch runs to an existing ROADMAP milestone unless the
    roadmap owner adds one.
  - Acceptance: docs describe current state, no stale Designed tags remain for
    implemented pieces, and any pre-existing test failure is reported with exact
    command output without masking scratch regressions.
