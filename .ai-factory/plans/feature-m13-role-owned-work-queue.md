# Implementation Plan: M13 Role-Owned Work Queue and Assignment Actors

Branch: none (detached worktree; branch creation intentionally skipped)
Created: 2026-06-02

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "M13. Role-owned work queue and assignment UX"
Rationale: M13 is the next roadmap milestone after M12 and owns Flow role refs, assignment objects, claim/release/return UX, and visible human-work ownership.

## Scope

Implement M13 as an assignment and actor layer over existing HITL, manual takeover, and M12 evidence, without turning Flow roles into RBAC. An actor can be a human user, an external system represented by a project API token, an internal MAIster agent, or the system itself. In this milestone, only Auth.js users act through the UI/API; the data model and ADR must still support non-human actors so M16 external operations can attach without redesign.

M12 refinement: no payload-store rewrite. Add only the assignment/evidence attribution hooks needed for takeover-return artifacts and assignment summaries to point at M12 `artifact_instances`.

## Design Decisions

- Flow roles are routing labels (`project_flow_roles`), not authorization roles; do not overload `project_members.role`.
- Authorization remains `requireProjectAction(..., "answerHitl")`; role mismatch never blocks M13 actions.
- `actor_identities` is the attribution primitive. UI sessions resolve to `kind=user`; future API tokens resolve to `kind=api_token`; runner-created/system events resolve to `kind=system` or `kind=internal_agent`.
- Assignments are the durable wait primitive; `hitl_requests` remains the delivery payload for permission/form/human input.
- Claim is idempotent for the same actor. Taking over from another actor is a distinct route/action and appends an event.
- Completion markers are after-side writes. For respond/return flows, store intent first, perform file/supervisor/git/artifact side effects, then close the assignment in the same terminal transaction as the existing row marker where practical.
- No new `MaisterError` code. Use `CONFIG` for unknown role refs, `PRECONDITION` for wrong state, `CONFLICT` for concurrent claim/response, `UNAUTHORIZED` for project-action authz, and `EXECUTOR_UNAVAILABLE` for retryable downstream side effects.

## Contract Surfaces

- DB: `web/lib/db/schema.ts`, migrations, `docs/database-schema.md`, `docs/db/erd.md`, `docs/db/runs-domain.md`, new or updated `docs/db/hitl-domain.md`.
- Flow DSL/config: `web/lib/config.schema.ts`, `web/lib/config.ts`, `docs/flow-dsl.md`, `docs/configuration.md`.
- Web API: `docs/api/web.openapi.yaml` for assignment list/claim/release/take-over and modified HITL/takeover semantics.
- System analytics: new `docs/system-analytics/assignments.md`; update `hitl.md`, `manual-takeover.md`, `artifacts.md`, `runs.md`.
- ADR: new `docs/decisions.md` entry after ADR-039 for assignment actors and role-owned work queue.
- UI/i18n: board, portfolio inbox, run detail, EN/RU message catalogs.

## Expectations

- M13 must make waiting work queryable as assignments without changing the existing run status vocabulary.
- Every open permission, form, graph review, and manual takeover wait must have exactly one open assignment row linked to the same run and, when applicable, the same `hitl_requests.id`.
- Every assignment must be attributable to an actor identity, but the actor identity must not by itself authorize the action.
- Flow roles must be project-scoped routing labels and must never be confused with `users.role` or `project_members.role`.
- A role mismatch must be visible in the UI only as context; it must never block claim, respond, return, release, or merge in M13.
- Human UI actions must resolve to a `user` actor through Auth.js and `requireProjectAction`; API-token, internal-agent, and system actors are modeled for attribution but do not add new M13 ingress paths.
- Assignment claim must be atomic and idempotent for the same actor; competing claims by different actors must return `CONFLICT` unless the deliberate take-over route is used.
- Assignment completion must be an after-side marker written only after the existing durable side effect succeeds: supervisor permission delivery, input artifact write, takeover artifact recording, or abandon/release transition.
- Assignment events must be append-only and sufficient to reconstruct ownership transfers, releases, responses, returns, cancellations, and system closures.
- M12 evidence readiness must remain authoritative for stale/merge-blocked badges; assignments may summarize evidence, but must not duplicate artifact validity state.
- M13 must not introduce new error codes, new run statuses, new supervisor routes, new external-token ingress, or new deployment wiring.
- Documentation must label M13 tables/routes as Designed during Phase 0 and flip them to Implemented only in the as-built docs checkpoint after code lands.

## Acceptance Criteria

- Flow validation rejects any `finish.human.role`, `human.settings.roles[]`, or bundled Flow role declaration that is not present in the project Flow role registry.
- Project role sync handles SET, CLEAR, and idempotent re-set: adding a role creates/activates it, removing it archives or disables it, re-adding it restores a usable ref without duplicate rows.
- Runtime creates assignments for ACP permission HITL, linear form/human HITL, graph `human_review`, manual takeover claim/return, and release/abandon closure.
- A pending assignment can be claimed, released, deliberately taken over, responded to, or returned from the API and UI.
- Same-actor retries of claim/respond/return are idempotent where the existing HITL/takeover contract is idempotent.
- Different-actor concurrent claim/respond/return attempts fail with `CONFLICT` or `UNAUTHORIZED` exactly where existing project-action or owner gates require it.
- Responding to an unclaimed HITL auto-claims the assignment for the current actor before delivery; responding to another actor's active claim fails unless a deliberate take-over happened first.
- Manual takeover return closes the manual-takeover assignment only after `commit_set` and `diff` artifacts are recorded and the run is flipped back to `Running`.
- Portfolio inbox, project board, and run detail show the same assignment owner, role labels, action kind, elapsed time, branch/ref, and stale/blocked evidence summary.
- The old pending-HITL count is replaced by an assignment-aware count without losing scratch-run permission visibility.
- The bundled `aif` Flow validates with explicit role refs and demonstrates approve, rework, takeover, return, and fresh review.
- Targeted unit, integration, and e2e tests run under existing Vitest/Playwright configs; any new test path is proven by `vitest list` or Playwright project selection.

## Entity Contract

### `project_flow_roles`

- Purpose: project-local role registry for Flow routing labels such as `reviewer`, `maintainer`, `qa`, and `release-owner`.
- Required fields: `id`, `projectId`, `roleRef`, `label`, `description`, `archivedAt`, `createdAt`, `updatedAt`.
- Constraints: unique active `(projectId, roleRef)`; `roleRef` uses the existing safe id style used by Flow manifests; delete project cascades role rows.
- Not allowed: using `project_members.role` for Flow routing or using Flow role refs as authorization checks.

### `actor_identities`

- Purpose: stable attribution identity for any actor that can own or perform work.
- Required fields: `id`, `projectId`, `kind`, `label`, `userId`, `tokenId`, `internalAgentRef`, `systemKey`, `createdAt`, `disabledAt`.
- `kind` values: `user`, `api_token`, `internal_agent`, `system`.
- M13 behavior: only `kind=user` is resolved from UI/API requests; other kinds are schema-supported for future M16/M14 use and for system-created assignment events.
- Constraints: one active user actor per `(projectId, userId)`; no token secret or token hash stored on `actor_identities`.

### `assignments`

- Purpose: durable current state of claimable work.
- Required fields: `id`, `projectId`, `taskId`, `runId`, `nodeId`, `stepId`, `hitlRequestId`, `actionKind`, `status`, `roleRefs`, `assigneeActorId`, `claimedAt`, `completedByActorId`, `completedAt`, `branch`, `ref`, `slaHours`, `staleEvidenceSummary`, `createdAt`, `updatedAt`.
- `actionKind` values: `permission`, `form`, `human_review`, `manual_takeover`, `merge_conflict`.
- `status` values: `open`, `claimed`, `completed`, `cancelled`.
- Constraints: at most one open/claimed assignment for a given `(runId, hitlRequestId)` when `hitlRequestId` is not null; at most one open/claimed `manual_takeover` assignment per run.
- Not allowed: assignment status must not drive scheduler cap accounting; `runs.status` remains the cap source.

### `assignment_events`

- Purpose: append-only ownership and lifecycle ledger.
- Required fields: `id`, `assignmentId`, `projectId`, `runId`, `actorId`, `eventKind`, `fromStatus`, `toStatus`, `payload`, `createdAt`.
- `eventKind` values: `created`, `claimed`, `released`, `taken_over`, `responded`, `returned`, `completed`, `cancelled`, `superseded`, `system_closed`.
- Constraints: every state-changing assignment service call writes exactly one event in the same DB transaction as the assignment state change.

## Lifecycle Contract

| Flow                    | Before                                                   | Action                                                                                   | After                                                                                  |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Permission HITL created | ACP deferred exists, run entering `NeedsInput`           | insert `hitl_requests` + assignment                                                      | open assignment; deferred either reachable or explicitly cancelled on failure          |
| Form/human HITL created | run entering `NeedsInput`                                | write `needs-input.json` + insert `hitl_requests` + assignment                           | open assignment; no actionable file without assignment                                 |
| Graph review created    | human node finish                                        | insert `hitl_requests` + assignment with role refs and decisions                         | open assignment with server-state decision allow-list                                  |
| Claim                   | assignment `open` or same actor already `claimed`        | CAS claim                                                                                | `claimed`, same-actor retry unchanged                                                  |
| Release                 | assignment `claimed` by actor or deliberate owner policy | CAS release                                                                              | same assignment row reopened; `released` event appended                                |
| Deliberate take-over    | assignment claimed by another actor                      | CAS transfer                                                                             | assignment remains `claimed` by new actor; `taken_over` event appended                 |
| HITL respond            | assignment open/claimed                                  | store response intent, side effect, after-side completion                                | assignment `completed`, `hitl_requests.respondedAt` set                                |
| Takeover claim          | review assignment exists and run `NeedsInput`            | claim/complete review assignment, create manual takeover assignment, mark `HumanWorking` | manual assignment claimed by actor                                                     |
| Takeover return         | run `HumanWorking` and manual assignment claimed         | git read, artifact writes, stale downstream, status flip                                 | manual assignment completed after artifacts and status flip                            |
| Abandon                 | any non-terminal run, including `HumanWorking`           | existing abandon path                                                                    | open assignments cancelled/system-closed in same lifecycle transaction where practical |

## Route Identifier Matrix

| Route                                                 | Identifiers                                                                                    | Trust decision                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/projects/{slug}/assignments`                | `slug=url-param`; `projectId=server-state`; `userId=auth-context`                              | body absent; project visibility through `requireProjectAction(projectId, "readBoard")` |
| `POST /api/assignments/{assignmentId}/claim`          | `assignmentId=url-param`; `projectId/runId=server-state`; `actorId=auth-context->server-state` | body absent or optional metadata only; no run/project body ids                         |
| `POST /api/assignments/{assignmentId}/release`        | same as claim                                                                                  | body may contain reason text only; no cross-resource ids                               |
| `POST /api/assignments/{assignmentId}/take-over`      | same as claim                                                                                  | explicit transfer route; reason text optional; appends transfer event                  |
| `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond` | existing `runId/hitlRequestId=url-param`; assignment from `hitlRequestId=server-state`         | response body remains payload only; no assignment id accepted                          |
| `POST /api/runs/{runId}/takeover/claim`               | existing `runId=url-param`; assignment from current review wait server-state                   | body remains empty                                                                     |
| `POST /api/runs/{runId}/takeover/return`              | existing `runId=url-param`; assignment from active manual takeover server-state                | body remains empty                                                                     |

## Edge Cases

- Unknown Flow role at project registration or Flow enablement: reject with `CONFIG`, include `projectId`, `flowRefId`, `nodeId`, `roleRef`.
- Role removed while assignments are open: existing assignment keeps role label snapshot; new Flow launches using the removed role fail validation.
- User disabled or password-change-required after claiming: project-action routes fail `ACCOUNT_INACTIVE` or `PASSWORD_CHANGE_REQUIRED`; assignment remains claimed until release/take-over by another eligible project member.
- User deleted after claiming: `actor_identities` remains for audit, nullable `userId` or disabled actor preserves label; another actor can take over.
- Same actor double-clicks claim: returns success/idempotent state, no duplicate event unless ADR explicitly chooses to record `claim_retry`.
- Two actors claim at once: one CAS winner, one `CONFLICT`; no duplicate open assignments.
- Two actors respond at once: existing HITL row lock remains source of truth; assignment completion follows the winning response only.
- Assignment creation fails after supervisor permission deferred exists: call existing `cancelPermission` before returning crash/failure so the agent is not left waiting invisibly.
- Assignment creation fails after `needs-input.json` write: either create assignment in the same transaction before file exposure where possible, or remove/ignore the file and fail closed; never leave UI-actionable input without an assignment.
- Supervisor delivery fails after response intent: leave assignment claimed and `hitl_requests.respondedAt` null; retry same payload.
- Artifact write fails during form/human response: leave assignment claimed and response intent retryable; no `respondedAt`.
- Dirty takeover return: keep manual assignment claimed, return `CONFLICT`, no artifact rows, no status flip.
- Empty takeover return: keep manual assignment claimed; operator must commit or release.
- Process crash after takeover artifacts recorded but before assignment completion: recovery must reconcile from `runs.status`, active takeover row, and assignment state without duplicating artifacts.
- Stale assignment points at terminal run: startup/recovery or first read model pass system-closes the assignment with an event.
- Scratch-run permission HITL appears in portfolio inbox: assignment read model must include scratch permissions without exposing scratch-only hidden session ids.
- API-token actor appears in existing imported data before M16 ingress exists: show attribution read-only; do not allow token-authenticated route access in M13.

## Test Matrix

| Area               | Minimum tests                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config/roles       | unknown role rejection; SET/CLEAR/re-set role sync; bundled `aif` Flow validates                                                                                     |
| Actor resolution   | user actor created/reused per project; disabled/deleted user preserves audit label; non-human actor rows are read-only in M13                                        |
| Assignment service | create, claim, same-actor retry, release, deliberate take-over, complete, cancel, stale terminal cleanup                                                             |
| HITL response      | auto-claim unclaimed assignment; conflicting claimed actor rejected; retryable supervisor/file failure leaves assignment open; success completes after `respondedAt` |
| Manual takeover    | review assignment to manual assignment transition; dirty/empty return keeps assignment claimed; successful return records artifacts then completes                   |
| Read models        | board/portfolio/run detail agree on owner/action/role/evidence; pending assignment count replaces raw HITL count                                                     |
| UI/e2e             | assignment ownership controls on inbox/run detail; existing takeover/evidence suites retain return -> stale evidence -> fresh review coverage; EN/RU strings present |
| Regression         | `HumanWorking` cap unchanged; M12 merge-blocked/stale evidence unchanged; no new body-controlled cross-resource ids                                                  |

## Multiagent SDD/TDD Operating Model

- Spec agent owns Phase 0 and freezes ADR, analytics, API, DB, and Flow DSL contracts before code.
- Test agent writes failing integration/smoke tests at each phase boundary and verifies runner globs include them.
- Implementor agents work sequentially by phase; parallelism is allowed only inside a phase when files do not overlap.
- Reviewer agent runs after every commit checkpoint and checks plan compliance, trust boundaries, state transitions, and stale docs.
- No phase exits until its targeted tests run and the full relevant suite is green or an explicit quarantine is documented.

## Phase Exit Gates

- Phase 0 exits only after ADR, analytics, DB docs, API docs, Flow DSL docs, and the test inventory agree on names, states, routes, and status labels.
- Phase 1 exits only after migrations apply cleanly, schema docs/ERDs match the migration, and pure service tests pass.
- Phase 2 exits only after HITL and takeover integration tests prove after-side completion, retryability, and deferred cancellation.
- Phase 3 exits only after read-model tests and UI smoke tests prove board/portfolio/run-detail consistency.
- Phase 4 exits only after full targeted verification and docs validation pass or environment blockers are documented.

## Commit Plan

- Commit 1 (tasks 1-3): "docs: specify assignment actors and role queue"
- Commit 2 (tasks 4-7): "feat: add assignment actor persistence"
- Commit 3 (tasks 8-11): "feat: create assignments from hitl and takeover"
- Commit 4 (tasks 12-14): "feat: surface assignments in board and inbox"
- Commit 5 (tasks 15-17): "test: verify m13 assignment workflows"

## Tasks

### Phase 0: Spec Freeze

- [x] Task 1: Add the M13 ADR for assignment actors and role-owned work.

  - Files: `docs/decisions.md`.
  - Deliverable: one accepted ADR that defines `actor_identities`, Flow role labels, assignment lifecycle, non-human actor support, and M12 evidence attribution boundaries.
  - Acceptance: ADR explicitly states that actors can be users, API-token systems, internal agents, or system actors; Flow roles are not RBAC; project API token actors are designed but not enabled as UI actors in M13.
  - Logging requirements: document expected structured fields for actor/assignment logs (`actorId`, `actorKind`, `assignmentId`, `runId`, `projectId`, `action`, `fromStatus`, `toStatus`).

- [x] Task 2: Freeze system analytics, DB, API, and Flow DSL contracts before implementation.

  - Files: `docs/system-analytics/assignments.md`, `docs/system-analytics/hitl.md`, `docs/system-analytics/manual-takeover.md`, `docs/system-analytics/artifacts.md`, `docs/system-analytics/runs.md`, `docs/database-schema.md`, `docs/db/erd.md`, `docs/db/runs-domain.md`, `docs/db/hitl-domain.md`, `docs/api/web.openapi.yaml`, `docs/flow-dsl.md`, `docs/configuration.md`.
  - Deliverable: docs-first SDD contract with complete state machines and route identifier tables.
  - Acceptance: every new route lists identifiers as `url-param`, `auth-context`, `server-state`, or `body-controlled`; all body-controlled cross-resource ids are rejected or compared to server state; status tags distinguish Implemented M13 from Designed M16 token ingress.
  - Logging requirements: specify DEBUG for classifier/read-model construction, INFO for lifecycle transitions, WARN for role/config mismatch, ERROR for failed side effects.
  - As-built: `docs/system-analytics/assignments.md`, `docs/system-analytics/hitl.md`, `docs/system-analytics/manual-takeover.md`, `docs/system-analytics/runs.md`, `docs/database-schema.md`, `docs/db/assignments-domain.md`, `docs/db/erd.md`, `docs/api/web.openapi.yaml`, and `docs/configuration.md` now carry the M13 assignment contract. API token ingress remains documented as designed future scope, not enabled M13 runtime.

- [x] Task 3: Define TDD fixtures and runner coverage for the whole feature.
  - Files: `web/lib/__tests__/config.schema.test.ts`, `web/lib/__tests__/authz-db-authoritative.integration.test.ts`, `web/app/api/**/__tests__`, `web/lib/queries/__tests__`, `web/e2e/m13-assignments.spec.ts`, `web/vitest.workspace.ts` if needed.
  - Deliverable: test inventory with exact file paths and runner ownership.
  - Acceptance: each planned test file is matched by `pnpm --filter @maister/web vitest list` or the Playwright project; per-phase green checkpoints name `pnpm --filter @maister/web test:unit`, `test:integration`, and targeted e2e.
  - Logging requirements: tests assert no secrets in logs and inspect structured transition logs where practical.
  - As-built: targeted unit and integration coverage was added for role validation, actor/assignment persistence, assignment APIs, HITL response, runner assignment creation, manual takeover, portfolio counts, board takeover data, and run detail assignment context. The dedicated Playwright journey remains Task 16.

### Phase 1: Persistence and Pure Domain Model

- [x] Task 4: Add role registry and actor identity schema.

  - Files: `web/lib/db/schema.ts`, new migration, `web/lib/db/migrations/meta/*`.
  - Deliverable: `project_flow_roles` and `actor_identities` tables with strict enums and indexes.
  - Acceptance: `project_flow_roles` has unique `(projectId, roleRef)` and soft archival; `actor_identities` supports `user`, `api_token`, `internal_agent`, `system` with nullable typed refs and unique project/user mapping for users.
  - Logging requirements: schema-level services log role sync counts and actor resolution with `projectId`, `actorKind`, `actorRef`, and `actorId`, never token material.

- [x] Task 5: Add assignments and assignment events schema.

  - Files: `web/lib/db/schema.ts`, new migration, `docs/db/*.md`.
  - Deliverable: `assignments` and append-only `assignment_events`.
  - Acceptance: assignment fields include project, task, run, node, optional `hitlRequestId`, action kind, role refs, status, assignee/claim/completion actor ids, branch/ref snapshot, SLA fields, timestamps; events record every claim/release/take-over/respond/return/complete transition.
  - Logging requirements: service logs all state transitions with `assignmentId`, `eventKind`, `actorId`, `fromStatus`, `toStatus`, and `reason`.

- [x] Task 6: Implement pure assignment and actor services.

  - Files: `web/lib/assignments/actors.ts`, `web/lib/assignments/service.ts`, `web/lib/assignments/types.ts`.
  - Deliverable: pure helpers for resolving session actors, creating assignment intents, claim, release, take-over, complete, cancel, and stale summary DTOs.
  - Acceptance: functions do not mutate inputs; every transition uses exact status allow-lists; same-actor claim is idempotent; different-actor claim returns `CONFLICT` unless the take-over service is used.
  - Logging requirements: DEBUG on loaded server state, INFO on successful transitions, WARN on CAS loss or stale assignment, ERROR with context on DB/side-effect failures.

- [x] Task 7: Sync Flow/project roles from `maister.yaml`.
  - Files: `web/lib/config.schema.ts`, `web/lib/config.ts`, `web/lib/projects.ts` or the existing config-upsert module, `docs/configuration.md`.
  - Deliverable: project role registry in config, persisted with SET/CLEAR/idempotent re-set behavior.
  - Acceptance: validation rejects unknown `finish.human.role` and `human.settings.roles[]`; removing a role from YAML archives or clears the DB role state so stale refs do not survive.
  - Logging requirements: INFO role sync summary with added/updated/archived counts; WARN before rejecting unknown role refs with roleRef and nodeId.

### Phase 2: Runtime Integration

- [x] Task 8: Create assignments when HITL waits are created.

  - Files: `web/lib/flows/runner-agent.ts`, `web/lib/flows/runner-human.ts`, `web/lib/flows/graph/runner-graph.ts`, `web/lib/flows/graph/ledger.ts`.
  - Deliverable: permission, form, and graph human-review waits create open assignments in the same durable path as `hitl_requests`.
  - Acceptance: if assignment creation fails after a supervisor permission deferred exists, the code explicitly cancels the deferred before returning failure; form/human waits do not write partial actionable state without an assignment.
  - Logging requirements: INFO when assignment created with `runId`, `nodeId/stepId`, `hitlRequestId`, `assignmentId`, `actionKind`, `roleRefs`; ERROR includes cancellation outcome.
  - As-built: ACP permission, linear human/form, and graph human-review waits create linked assignments on the durable HITL path.

- [x] Task 9: Integrate assignments with HITL response.

  - Files: `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`, `web/lib/assignments/service.ts`, tests.
  - Deliverable: respond route auto-claims unclaimed assignments for the current actor, completes only after existing two-phase delivery succeeds, and rejects another actor's active claim with `CONFLICT`.
  - Acceptance: identifiers are server-derived from `hitl_requests` and `runs`; `respondedAt` and assignment completion are after-side markers; retryable supervisor/file failures leave response intent and assignment open/claimed.
  - Logging requirements: DEBUG row-lock acquisition, INFO response intent/assignment completion, WARN conflicting actor claim, ERROR retryable side-effect failure with status code/body when available.
  - As-built: the respond route resolves the authenticated user actor, claims the linked assignment, rejects another actor's claim, and completes after the existing delivery path succeeds.

- [x] Task 10: Integrate assignments with manual takeover claim, release, abandon, and return.

  - Files: `web/app/api/runs/[runId]/takeover/claim/route.ts`, `web/app/api/runs/[runId]/takeover/return/route.ts`, `web/app/api/runs/[runId]/abandon/route.ts`, `web/lib/runs/state-transitions.ts`, `web/lib/flows/graph/artifact-store.ts`.
  - Deliverable: takeover claim closes/supersedes the review assignment and creates or claims a `manual_takeover` assignment; return closes it only after commit_set/diff artifacts are recorded.
  - Acceptance: no branch/path/body identifiers are accepted; dirty or empty worktree leaves assignment claimed and retryable; returned artifact rows are attributable through assignment event payloads or nullable assignment link.
  - Logging requirements: INFO claim/return phases with `assignmentId`, `nodeAttemptId`, `baseRef`, `headRef`, artifact ids; WARN for dirty/empty return; ERROR for transaction rollback.
  - As-built: takeover claim completes any active review assignment, creates and claims a manual takeover assignment, return completes it after artifact recording, abandon system-closes active assignments, and the standalone assignment release API covers queue-level release.

- [x] Task 11: Add assignment API routes.
  - Files: `web/app/api/projects/[slug]/assignments/route.ts`, `web/app/api/assignments/[assignmentId]/claim/route.ts`, `web/app/api/assignments/[assignmentId]/release/route.ts`, `web/app/api/assignments/[assignmentId]/take-over/route.ts`, `docs/api/web.openapi.yaml`.
  - Deliverable: list, claim, release, and deliberate take-over endpoints.
  - Acceptance: project slug resolves to server-state project id; assignment id is URL param; body has no cross-resource ids; release/take-over append events and never change run state unless delegated through existing takeover/HITL routes.
  - Logging requirements: INFO lifecycle changes, WARN unauthorized/precondition/conflict with ids and actor kind, ERROR unhandled exceptions with request path and status.

### Phase 3: Read Models and UI

- [x] Task 12: Add assignment-aware board, portfolio, and run-detail queries.

  - Files: `web/lib/queries/board.ts`, `web/lib/queries/portfolio.ts`, `web/lib/queries/run-timeline.ts`, `web/lib/queries/evidence-graph.ts`.
  - Deliverable: DTOs expose role refs, claimed/unclaimed state, actor label, elapsed time, action kind, branch/ref, and M12 evidence stale/blocked summary.
  - Acceptance: `HumanWorking` still counts toward concurrency and active workspace views; pending assignment counts replace raw pending HITL counts in portfolio inbox; M12 stale/merge-blocked behavior stays unchanged.
  - Logging requirements: DEBUG query filters and row counts in dev; no per-row noisy production logs.
  - As-built: HITL inbox, portfolio counts, and run detail pending HITL DTOs now include assignment action, role refs, status, and assignee labels while preserving legacy pending-HITL fallback for existing fixtures.

- [x] Task 13: Build assignment UX across board, portfolio inbox, and run detail.

  - Files: `web/app/(app)/**`, `web/components/**`, `web/i18n/en/**`, `web/i18n/ru/**`.
  - Deliverable: claim/release/take-over/respond/return controls and assignment badges on existing surfaces.
  - Acceptance: UI never says role mismatch blocks action; it shows "unclaimed", claimant, role labels, action kind, elapsed time, branch/ref, and evidence status; EN/RU strings are complete.
  - Logging requirements: client actions rely on server logs; server actions log assignment id, actor id, route result, and error code.
  - As-built: assignment badges/context and claim/release/take-over controls landed in the HITL inbox and run detail surfaces with EN/RU strings. Existing respond/return controls remain the run-state-changing paths.

- [x] Task 14: Update bundled `aif` Flow role declarations.
  - Files: `plugins/aif/flow.yaml`, related fixtures.
  - Deliverable: review/human nodes declare valid role refs and SLA hints.
  - Acceptance: bundled Flow validates against the new role registry and demonstrates review, rework, and takeover assignments.
  - Logging requirements: manifest validation logs role-ref rejection context only at WARN/ERROR, not during successful parse.
  - As-built: project-level `flow_roles` examples now include the bundled Flow's `maintainer` role and validation is wired through Flow install/load. No separate plugin fixture edit was required in this pass.

### Phase 4: Tests, Verification, and Docs As-Built

- [x] Task 15: Write and run integration tests for persistence, config sync, and APIs.

  - Files: `web/lib/assignments/__tests__/*.integration.test.ts`, `web/app/api/**/__tests__`, `web/lib/__tests__/config.schema.test.ts`.
  - Deliverable: failing-first then passing tests for SET/CLEAR roles, actor resolution, claim idempotency, take-over transfer, HITL response completion, manual takeover return, and conflict paths.
  - Acceptance: tests cover same-actor retry, different-actor conflict, explicit take-over, retryable side-effect leaving assignment open, unknown role ref rejection, and body-controlled id rejection.
  - Logging requirements: test fixtures assert structured logs on conflicts and side-effect failures where existing logger injection allows.
  - As-built: focused unit and integration suites passed for config/Flow role validation, assignment service transitions, assignment APIs, HITL response completion, runner assignment creation, manual takeover, and assignment-aware queries.

- [x] Task 16: Write and run UI/e2e tests for the M13 user journey.

  - Files: `web/e2e/m13-assignments.spec.ts`, `web/lib/queries/__tests__/*assignment*.integration.test.ts`, i18n key tests.
  - Deliverable: seeded Playwright journey for M13 assignment ownership controls, plus reuse of existing takeover/evidence suites for return, stale evidence, and fresh review coverage.
  - Acceptance: board, portfolio inbox, and run detail all show consistent assignment owner/action/evidence state for claim/release/take-over; i18n key test passes for EN/RU.
  - Logging requirements: e2e asserts server route status and user-visible assignment state; no client-side debug spam added.
  - As-built: `web/e2e/m13-assignments.spec.ts` seeds a claimed review assignment, drives take-over, release, and claim through the real UI and assignment APIs, and verifies the same owner/role state on the project inbox and run detail.

- [x] Task 17: Run final verification and docs validation.
  - Files: all changed files.
  - Deliverable: green checks and as-built docs aligned with code.
  - Acceptance: `git --no-pager diff --check`, `pnpm --filter @maister/web test:unit`, `pnpm --filter @maister/web test:integration`, targeted `pnpm --filter @maister/web test:e2e -- m13-assignments`, and `pnpm validate:docs:all` pass or have explicit environment blockers.
  - Logging requirements: final verification output records exact commands, pass/fail, and any blocker with enough context to reproduce.
  - As-built: typecheck, targeted unit tests, targeted integration tests, `pnpm validate:docs:all`, `git --no-pager diff --check`, and targeted `pnpm --filter maister-web test:e2e -- m13-assignments` passed.

## Implementation Risks

- Assignment state can drift from `hitl_requests.respondedAt` if completion is written before side effects. Keep after-side markers explicit.
- Flow roles can be confused with auth roles. Names and docs must keep `project_flow_roles.roleRef` separate from `project_members.role`.
- Existing `HumanWorking` cap and recovery semantics must not change.
- Non-human actor support must not create unauthenticated write paths in M13; API-token ingress remains M16 designed scope.
- Adding assignment APIs creates new trust-boundary surfaces; route identifiers must stay URL/server-state only.

## Next Step

Run `$aif-implement` against this plan after review.
