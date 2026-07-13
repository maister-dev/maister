# Implementation Plan: Human-ask — task-bound HITL clarifications for standalone agents

Branch: `feature/human-ask-hitl-clarification` (planned; this planning-only worktree is detached and no branch was created)
Created: 2026-07-13

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes — the analytics/contract checkpoint is mandatory before code starts and stays part of each affected phase.

## SDD delivery rule

This is a specification-driven delivery. Task 1 produces the authoritative
delta before any production implementation: ADR-136 owns the irreversible
choices; the two OpenAPI files own the HTTP wire; the system-analytics and DB
documents own lifecycle, invariants, and persistence. No code task may start
until its RED tests cite the corresponding contract section and the Task-1
docs validation is green. During implementation every contract remains
`Designed`; Task 11 changes it to `Implemented` only after the matching GREEN
tests and as-built review pass.

## Roadmap Linkage

Milestone: "none"

Rationale: This is a focused completion of the implemented M34 platform-agent/HITL substrate, not an independently named roadmap milestone. The plan will update the relevant M34 and HITL contracts without retroactively relabeling the roadmap.

## Goal and scope

Provide every standalone platform agent (`runs.run_kind = 'agent'`) with an
`ask_human` MCP primitive. The agent submits a schema-backed question for a
task; the operator answers it in the existing actionable HITL Inbox; MAIster
persists the immutable structured Q&A without rewriting `tasks.prompt`; then
launches a fresh, stateless agent run with the sharpened task context.

The first consumer is `core:triager`. Its `intake_mode: clarify` remains
the default and continues to use `comment_list` for context recovery, but
its question/reply loop moves from comments plus `task.comment_added` to
Human-ask plus `task.triage_requeued`. Comments and the general
`task.comment_added` trigger remain available to other agents unchanged.

### Explicitly excluded from this plan

- Run-bound ACP `session/resume` for Human-ask, multi-round conversations
  inside one request, a Flow DSL/engine version bump, new supervisor/ACP
  protocol messages, and a parallel notification system.
- The secondary *flag resolution* UX is split into a follow-up plan. It is
  independent of Human-ask's data/response lifecycle and needs a separately
  reviewed manual-takeover contract. Its scoped outline appears at the end.
- No environment variable, port, binary, container wiring, or deployment
  change is introduced. `Dockerfile`, `compose*.yml`, and
  `.env.example` stay untouched.

## Resolved design decisions

1. **Kind:** add `hitl_requests.kind = 'agent_question'`; do not overload
   `form`. Existing `form` is node-bound and its handler writes
   `input-<stepId>.json` then schedules `runFlow`; an agent question must
   never resume that source ACP session. Reuse the existing `schema` JSONB
   column (there is no `response_schema` column), JSON-schema validation,
   assignment, Inbox, and form-control machinery.
2. **Clarification history:** add a `task_clarifications` child table rather
   than a JSONB column on `tasks`. It records task/project, a per-task sequence,
   immutable source run/agent/HITL identifiers, question/schema, structured
   response, human responder, timestamps, and re-trigger mode. The source-id
   columns are snapshots, not cascading foreign keys: deleting an origin run
   or its transport HITL row must not delete task history. It supports multiple
   rounds and preserves the original task statement. `hitl_requests.response`
   remains the transport/audit mirror for the answer; the clarification table
   is the task-domain history.
3. **Origin lifecycle:** an `ask_human` call durably records the request,
   terminates the origin's live standalone ACP session, and terminalizes that
   source run as `Done`. It never enters `NeedsInput` or
   `NeedsInputIdle`, so it consumes no agent slot and reconciliation treats
   it as terminal. The request becomes Inbox-actionable only after that
   terminalization completes; a termination failure leaves a durable,
   retryable activation record invisible to operators rather than exposing a
   question while its source agent is still live.
4. **Pending/superseded representation:** retain `responded_at` exclusively
   for a real human answer. `agent_question` rows have explicit
   `activation_state = pending_termination | active | failed`, plus nullable
   `superseded_at`. Supersession provenance is mutually exclusive:
   `superseded_by_hitl_request_id` names the winning human answer, while
   `superseded_by_run_id` names a durably-created successor launch. The answer
   transaction cannot name a successor run because generic re-trigger launch
   is asynchronous. An actionable ask is exactly `active` with all three of
   `responded_at`, `superseded_at`, and the answer value unset. This makes
   answered, stale, pending activation, and permanently failed requests
   distinguishable without forging an answer payload.
5. **Answer/re-trigger routing:** `ask_human` accepts a server-validated
   re-trigger mode. Generic agents use `agent`: answer emits a new,
   targeted `task.clarification_answered` outbox fact carrying only the
   server-derived requester agent and clarification ids, and the agent-trigger
   consumer launches that one attached agent. `core:triager` alone uses
   `triage`: answer calls the extracted in-transaction triage-requeue helper
   and emits the existing `task.triage_requeued` fact. This preserves triager
   semantics without clearing a generic agent's existing verdict. The new
   targeted event is warranted because generic availability cannot rely on an
   arbitrary agent already subscribing to triage events.
6. **Cancel-all invariant:** a shared
   `cancelOpenAgentQuestionsForTask(...)` lock-aware helper closes every
   open `agent_question` for a task and closes linked assignments. Its required
   provenance union is either `{ answeredByHitlRequestId }` in the answer
   transaction or `{ supersededByRunId }` after a successor launch has been
   durably created but before it is visible. Lock ordering is task first, then
   its open HITL rows, so an answer and a manual/domain re-trigger cannot leave
   dangling questions.
7. **Derived task condition:** `awaitingClarification` is an `EXISTS`
   projection over open, active `agent_question` rows. Do not add a task
   status/column or change launchability status enums. Board and task detail
   show a localized clarification chip/history; the task remains otherwise
   governed by its existing triage/launch state.
8. **Prompt truth:** preserve `tasks.prompt` and the existing
   `FlowContext.task.prompt` byte-for-byte. Compose a deterministic
   `task.effectivePrompt` from that original followed by ordered, labeled
   answered clarifications, and expose `task.clarifications` as structured
   data. A fresh standalone-agent launch receives `effectivePrompt`; graph
   run-context gets the same explicit effective value and history without
   silently changing legacy `{{ task.prompt }}` templates. Never update
   `tasks.prompt`.
9. **Activation recovery:** an ask that crosses the external supervisor
   boundary is not complete merely because its caller can retry. Reuse the
   existing reconciliation/system-sweep path to scan bounded
   `pending_termination` rows, probe the bound session, retry a still-live
   matching termination, and activate a verified-gone source. A natural
   session-exit race and a DB failure after termination converge to the same
   idempotent activation; only `active` requests become operator-visible.

## Trust boundary and failure model

### Route identifier table

| Route/tool | Identifier | Source | Rule |
| --- | --- | --- | --- |
| `ask_human` → `POST /api/v1/ext/projects/{slug}/tasks/{taskId}/human-asks` | `slug` | URL parameter, checked by `handleExt` | Project-scoped/existence-hidden. |
| same | `taskId` | URL parameter, then DB row scoped by resolved project | Must match the caller's bound run `task_id`; body supplies no task/project/run id. |
| same | origin run + agent | auth context / server state | Derive from the ephemeral token's bound run, then assert `run_kind='agent'`, `status='Running'`, matching project/task, and agent ownership. |
| same | `reTriggerMode` | strict request enum | `agent` is the default; `triage` is accepted only for the bound `core:triager` identity. It never supplies an agent/run id. |
| answer route | `runId`, `hitlRequestId` | URL parameters, then locked DB row | Verify row-to-run equality and derive task/project/agent from server state; response body only carries the schema answer. |
| domain event | requester agent, superseding run | server state | Never accept an agent id or run id in either request body. |

### Two-phase ask activation

1. **DB intent:** under task/run locks, validate the question against the
   existing versioned `formSchemaSchema`, allocate its task sequence, and create
   `task_clarifications` plus a `pending_termination` `agent_question`. It is
   not selected by Inbox queries and has no actionable assignment.
2. **External effect:** terminate the bound supervisor session. A supervisor
   4xx proving the session is already absent is reconciled by checking the
   server-owned run state; 5xx/network leaves the activation retryable and
   returns `EXECUTOR_UNAVAILABLE`/503. The system sweep owns a later recovery
   attempt even if the source process cannot retry. No response is accepted
   while pending.
3. **DB activation:** atomically terminalize the source run through the
   agent-finalization seam, revoke its token, open the request/assignment, and
   expose it in the Inbox. A same-payload retry re-drives only unfinished
   phases; a conflicting duplicate request returns 409. An intentional-exit
   race is terminalized as this Human-ask outcome, never misclassified as an
   unrelated crash.

### Answer transaction

The service locks the request and task; verifies human authority, active
request state, and idempotent payload; validates the schema before mutation;
writes the answer to `hitl_requests.response` and `task_clarifications`;
sets `responded_at`; supersedes all sibling open asks and closes their
assignments with `superseded_by_hitl_request_id = winner`; completes the winning
assignment; writes the appropriate domain event and `token_audit_log` in the
same transaction. Its only post-commit side effect is outbox dispatch. Same
payload is idempotent; different payload, superseded rows, non-human actors,
or a task/run mismatch return typed 409/403.

## Migration and ADR reservation

At implementation start, reserve **ADR-136** and migration
`0099_agent_human_ask` from `main` (current verified heads are ADR-135 and
migration index 98). The migration must include its SQL, journal entry, and
matching snapshot. Before merge, rebase onto current `main`, re-check both
global sequences, renumber the ADR/migration and all prose references if
another branch consumed either number, then run the ADR-anchor validator.

## Commit Plan

- **Commit 1** (after Task 1): `docs: specify agent human-ask lifecycle`
- **Commit 2** (after tasks 2–3): `feat: persist agent questions and compose context`
- **Commit 3** (after tasks 4–6): `feat: add task-bound agent question HITL`
- **Commit 4** (after tasks 7–9): `feat: surface and retrigger human asks`
- **Commit 5** (after Task 11): `docs: finalize human-ask contracts`

Task 10 has its separate package-scoped `maister-plugins` core release commit
and annotated `core/vX.Y.Z` tag; do not fold that external release into a
MAIster application commit.

## Requirement traceability and TDD gates

For every implementation task, write the listed observable test first and
demonstrate it fails for the missing behavior (**RED**); add the smallest
production change to turn that exact contract green (**GREEN**); then refactor
only with the full focused suite still green (**REFACTOR**). Tests below are
the primary owner of a requirement: do not repeat the same happy path across
unit, integration, and E2E suites merely for coverage.

| Contract | Authoritative specification | RED primary proof | GREEN owner |
| --- | --- | --- | --- |
| S1 persistence and retention | ADR-136; DB HITL/agents docs and ERD | migrated Postgres accepts only legal shapes and preserves clarification history after origin cleanup | Task 2 |
| S2 context compatibility | HITL/tasks analytics and Flow context contract | pure composer proves original prompt compatibility, ordering, and exclusion of open/stale rows | Task 3 |
| S3 agent request boundary | external OpenAPI + MCP operation mirror | route integration drives auth/binding/schema/status matrix; MCP contract test catches wire drift | Task 4 |
| S4 terminal activation | HITL/runs analytics state diagram | integration fixture covers supervisor and transaction stage/race matrix, including sweep recovery without caller retry | Task 5 |
| S5 single winning answer | HITL analytics transaction contract | Postgres concurrency integration covers same/different payload and answer-versus-launch locks | Tasks 6–7 |
| S6 re-trigger isolation | domain-events/agents/triage analytics | consumer integration proves one target-only launch or triager requeue, including redelivery/refusal | Task 8 |
| S7 human-visible state | Inbox/board screen contracts | component/query tests cover active versus pending/stale and i18n; one E2E runs the non-duplicated operator journey | Task 9 |
| S8 package adoption | triager package contract | package-definition/wire integration proves Human-ask and no comment self-loop | Task 10 |

Use unit tests only for pure context/schema decisions. Use integration tests
against the real Postgres test database for constraints, locking, routes,
outbox, and migration behavior; mock only the supervisor boundary. The E2E
slice proves composition, not every negative branch. A textual SQL assertion,
snapshot-only assertion, or test that restates a type without an observable
failure is insufficient evidence.

## Tasks

### Phase 0: docs-first contract and migration preflight

- [x] **Task 1: Freeze the Human-ask state machine, API, event, and data contracts before code.**

  Update `docs/decisions.md` with ADR-136; `docs/system-analytics/hitl.md`,
  `agents.md`, `triage.md`, `tasks.md`, `domain-events.md`, `runs.md`, and
  `external-operations.md`; `docs/db/hitl-domain.md`, `agents-domain.md`, and
  `runs-domain.md`; `docs/database-schema.md` and `docs/db/erd.md`;
  `docs/screens/inbox.md` and `docs/screens/projects/project-board.md`; and
  `docs/api/external/operations.openapi.yaml` plus `docs/api/web.openapi.yaml`.

  Specify the `agent_question` lifecycle, activation/termination/recovery
  matrix, full answer/supersession transaction (including answer-winner versus
  successor-run provenance), terminal-origin Inbox query exception, human-only
  responder policy, task context composition, the target-only
  `task.clarification_answered` event, triager's existing
  `task.triage_requeued` branch, and the explicit v1 non-goal of ACP resume.
  Each altered system-analytics document must retain its required Purpose,
  entities, state/sequence flow, and Expectations sections. The two OpenAPI
  specifications must define the strict `ask_human` request form schema,
  `201|200|202|409|422|503` creation outcomes, response DTOs, identifier
  provenance, and the existing human-response route's new kind. Record that
  the Postgres domain-event outbox stays an internal analytics/DB contract:
  it does not invent an AsyncAPI channel or an ACP message. Add
  `Implemented`/`Designed` labels accurately during phased delivery rather
  than claiming code before it exists. Keep `docs/api/external/acp.asyncapi.yaml`
  and `docs/supervisor.md` unchanged except for the explicit non-expansion
  note: v1 does not add ACP interactivity.

  **Acceptance:** every refusal/precondition uses the code's exact allow-list;
  both narrative and Mermaid ERDs include the new table/columns and the
  non-cascading clarification-history rule; every changed HTTP/event surface
  has schemas, error statuses, examples, and identifier provenance; the docs
  make `FlowContext.task.prompt` compatibility and `task.effectivePrompt`
  explicit; `pnpm validate:docs` passes before Task 2 starts.

  **Logging:** document structured events at request creation, activation
  retry/failure, answer, supersession count, and targeted re-trigger decision;
  prohibit response bodies and schema answers from logs.

- [x] **Task 2: Reserve migration/ADR numbers and build typed persistence for task-bound questions.**

  Update `web/lib/db/schema.ts` and generate migration
  `web/lib/db/migrations/0099_agent_human_ask.sql` with its
  `meta/_journal.json` and `meta/0099_snapshot.json`. Add
  `agent_question` to the HITL kind type; nullable `task_id`,
  `activation_state`, `superseded_at`, `superseded_by_hitl_request_id`, and
  `superseded_by_run_id` with agent-question-only shape CHECKs; and
  `task_clarifications` with a unique source request snapshot, `(task_id, seq)`
  uniqueness, immutable source ids, answerer/provenance, and hot partial indexes
  for active Inbox rows and answered context reads. The migration must make
  answer-winner and successor-run supersession provenance mutually exclusive,
  while legacy HITL rows retain null additions. Expand both
  `domain_events.kind` and the shared `task_activity`/`inbox_items` kind CHECKs
  only if the implementation needs a new visible activity; do not add a dummy
  activity kind merely for logging. Use non-destructive additions; no backfill
  is needed for pre-feature rows. Update schema shape and real migration
  integrity tests under `web/lib/db/__tests__/`.

  **Acceptance:** the newest journal item has its snapshot; Drizzle schema and
  database constraints agree; migrated Postgres proves the legal and illegal
  agent-question shapes, unique origin/sequence, partial-index query plan, and
  clarification survival after source-row cleanup; pre-existing HITL rows
  preserve their behavior. Do not use string-presence migration tests as proof
  of runtime constraints. `pnpm --dir web exec vitest list --project integration`
  includes the new migration tests and `pnpm --dir web test:integration` is green.

  **Logging:** migration code logs no user content; query/service logs use ids,
  kind, activation state, and row counts only.

- [x] **Task 3: Add pure clarification projections and prompt composition before any mutation route.**

  Create focused server-only query/context helpers near
  `web/lib/queries/task-detail.ts`, `web/lib/flows/context.ts`, and
  `web/lib/flows/graph/run-context.ts`; update
  `web/lib/agents/launch.ts`'s task prompt builder. Return ordered Q&A history,
  the derived `awaitingClarification` flag, and one deterministic
  `effectivePrompt` text block. Preserve `tasks.prompt` and
  `FlowContext.task.prompt` verbatim; add `task.effectivePrompt` and
  `task.clarifications` to Flow/run context, and pass only `effectivePrompt`
  to fresh standalone-agent prompt construction. Use bounded presentation-safe
  formatting and never make legacy templates observe a silent prompt rewrite.

  **Acceptance:** unchanged `{{ task.prompt }}` renders byte-for-byte as before;
  multiple answers are deterministic by `(seq, id)`; unanswered/superseded
  records are not injected; standalone agents receive `effectivePrompt`; and
  graph/legacy Flow contexts expose the same ordered structured history without
  template compatibility drift. Extend the existing context/templating and
  task-detail runner-matched tests, then run the appropriate unit project green.

  **Logging:** DEBUG the clarification count/source ids at context assembly;
  never log prompt, question, or response content.

### Phase 1: secure ask creation and source-run lifecycle

- [x] **Task 4: Add the least-privilege agent scope, ext route, and MCP facade tool.**

  Add `hitl:request` to `web/types/token-scopes.ts` and the ephemeral
  `AGENT_TOKEN_SCOPES` in `web/lib/agents/tokens.ts`; map its project action
  in `web/lib/tokens/ext-handler.ts`. Implement
  `POST /api/v1/ext/projects/[slug]/tasks/[taskId]/human-asks` with
  `handleExt` and a strict request schema of
  `{ question, schema: FormSchemaV1, reTriggerMode?: 'agent' | 'triage' }`,
  where `schema` reuses `formSchemaSchema`/`validateFormSchemaVersion` rather
  than accepting arbitrary JSON Schema. It accepts no caller-supplied
  run/project/agent identifiers. Define `201` only for fully active creation,
  `200` for an active same-payload replay, `202` for a durable but still
  non-actionable activation, `409` for conflicting duplicate/superseded work,
  `422` for malformed input, and `503 EXECUTOR_UNAVAILABLE` for a retryable
  supervisor result. Add `ask_human` to `mcp/src/tools.ts`, update the
  `TOOL_OP` OpenAPI mirror in `mcp/src/__tests__/tool-contract.test.ts`, and
  cover only defined forwarded fields. Restrict `reTriggerMode='triage'` to
  the bound `core:triager` agent; generic agents use `agent`.

  **Acceptance:** only a scoped ephemeral agent token bound to a currently
  Running, task-bound `run_kind='agent'` may create a request; wrong project,
  task/run mismatch, unbound/user token, missing scope, malformed schema, and
  duplicate/conflicting payloads return typed existence-hidden errors; a
  completed activation produces exactly one success `token_audit_log` row
  labelled `agent:<id>`, while a retryable activation failure produces one
  normal 503 failure audit rather than a false success audit. Extend
  `mcp/src/__tests__/tools.test.ts`, `tool-contract.test.ts`, and a route
  integration test that the integration runner lists and executes. The route
  contract test must prove its OpenAPI operation, zod boundary, MCP facade, and
  server-derived token binding agree—one assertion chain, not four duplicate
  happy paths.

  **Logging:** INFO creation intent with request/task/run/agent ids and schema
  version/field count; WARN for authorization/refusal category; never token,
  question, schema, or answer values.

- [x] **Task 5: Implement two-phase ask activation and terminalize the source agent safely.**

  Add an `agent-question` service beneath `web/lib/services/`; extract the
  minimum composable finalization seam from `web/lib/agents/launch.ts` so
  request activation can terminate the live supervisor session, finalize the
  source `Done`, revoke its run token, activate the Inbox request, and write
  the success audit in that same Phase-3 activation transaction—without a
  false intermediate state. Reuse assignment creation/closure services.
  Persist `pending_termination` before `deleteSession`; keep it non-actionable;
  retry same-payload incomplete activation; and classify unavailable/network
  as retryable 503 and verified-gone/session misuse as terminal typed failure.
  Add a bounded `pending_termination` recovery pass to `web/lib/reconcile.ts`
  and the existing `web/lib/scheduler/system-sweeps.ts` composition—no new
  scheduler job, environment variable, or poller. It must recover the
  termination-before-transaction-failure and natural-exit races from durable
  run/session state. Do not use `NeedsInput`, checkpoint/resume,
  `atomicWriteJson`, or `runFlow`.

  **Acceptance:** a successful ask frees the agent slot, leaves the source
  `Done`, retains immutable audit provenance, creates one active assignment,
  and exposes one actionable request; a crash/restart cannot expose a live
  source as stopped; a source terminated before activation is recovered without
  another MCP call; no origin request is processed by idle-resume code. Tests
  cover every stage boundary, supervisor 4xx/5xx/network result, repeat
  request, token revocation, natural-exit race, DB-activation rollback followed
  by system-sweep recovery, and a SIGTERM-resistant/session teardown fixture
  where applicable.

  **Logging:** INFO each state transition and terminalization outcome; DEBUG
  retry stage; ERROR with ids/status/classification for failed supervisor calls
  only—never request payloads.

- [x] **Task 6: Make all task-bound standalone launches cancel stale questions.**

  Implement `cancelOpenAgentQuestionsForTask` in the service layer and call
  it from the successful task-bound `launchAgentRun` persistence path only
  after the successor run is durably created/claimed, but before that run is
  exposed to a consumer. A refused precondition or failed launch must leave
  questions intact. The helper must lock task then pending question rows,
  stamp `superseded_at`/`superseded_by_run_id`, close all linked
  assignments, and be idempotent. Existing non-agent HITL, taskless/scratch
  runs, and a terminal run's historical answer must remain untouched.

  **Acceptance:** manual, domain-event, and targeted re-trigger launches
  cancel every sibling open request—not only the currently answered one;
  concurrent launch-versus-answer has one deterministic winner with no dangling
  Inbox item; run status fan-out, agent capacity release, and reconcile queries
  continue to use exact allow-list predicates. Extend
  `web/lib/agents/__tests__/launch.test.ts`,
  `triggers.integration.test.ts`, and relevant run/reconcile integration
  tests; verify each new file is matched by its declared Vitest project.

  **Logging:** INFO cancellation count plus task/superseding-run ids; DEBUG
  zero-row idempotent retries; WARN only for unexpected lifecycle conflicts.

### Phase 2: human response, re-trigger, and actionable read models

- [ ] **Task 7: Add a dedicated human-only response handler with atomic answer and supersession.**

  Extend `web/lib/services/hitl.ts::respondToHitl` with an
  `agent_question` branch rather than routing it through
  `handleFormHumanResponse`. Reuse `assertHitlResponse`, row locking,
  same-payload idempotency, localized `MaisterError` mapping, and the
  session/ext response routes, but require a human actor (session user or exact
  `hitl:respond:human` personal token). Extend the ext route's exact-scope
  resolver so `agent_question` is treated like `human`, never like a normal
  agent-answerable form. Verify the URL run id against the locked request; do
  not require source `NeedsInput`. In one transaction write the clarification
  answer/provenance, mark the winner responded, supersede every sibling open
  question with `superseded_by_hitl_request_id = winner`, close/complete
  assignments, write the audit record, and emit the re-trigger event. Refactor
  `sendTaskToTriage` into an in-transaction helper for the triager branch.

  **Acceptance:** current answer creates exactly one clarification and exactly
  one trigger fact; concurrent different answers conflict; same payload retries
  are 200/idempotent; stale/superseded/pending requests cannot be answered; a
  non-human agent token receives 403; no artifact write, `runFlow`, supervisor
  input, or session resume occurs. Cover service, session route,
  global-personal-token route, exact-scope classification, and audit rollback
  cases in the existing HITL unit/integration suites.

  **Logging:** INFO answer/supersession counts and selected re-trigger mode;
  DEBUG idempotent replay; WARN typed validation/auth failures; redact every
  structured value.

- [ ] **Task 8: Register and dispatch the targeted generic clarification event.**

  Add `task.clarification_answered` to
  `web/lib/domain-events/taxonomy.ts`, use the Task-2
  `web/lib/db/schema.ts`/migration CHECK expansion, update its docs specs,
  and extend the `agent_triggers` consumer in
  `web/lib/agents/triggers.ts`. Its payload has server-derived
  `requestingAgentId` and `clarificationId`; it is a directed launch lane,
  not a broad subscription event. It validates that the requester remains
  attached/enabled/not quarantined, launches only that agent with the event id
  (preserving at-least-once partial-unique dedupe), and emits a structured
  refusal log with event/requester/reason while advancing the outbox cursor.
  The event row remains the durable source fact; do not widen social Inbox or
  task-activity taxonomy merely to duplicate that outcome. The triager branch instead emits only
  `task.triage_requeued`, so its normal schedule and human actor pass the
  self-exclusion guard.

  **Acceptance:** an enabled generic agent re-runs once even without a
  matching event schedule; disabled/detached/quarantined requester produces a
  structured refusal with no cross-agent launch; outbox redelivery converges
  to one run; the triager runs once through `task.triage_requeued` and never
  self-loops. Extend taxonomy, emit, dispatch, and triager-wire integration
  tests and keep the full integration suite green.

  **Logging:** INFO target/event/run ids on dispatch; WARN refusal code; DEBUG
  dedup/self-exclusion decisions; no prompt or clarification body.

- [ ] **Task 9: Make Human-ask visible and answerable in the existing Inbox and task views.**

  Extend `web/lib/queries/hitl.ts` and
  `web/lib/queries/portfolio.ts` with a narrow union for active
  `agent_question` rows whose origin run is terminal, without weakening
  existing `NeedsInput | NeedsInputIdle` guards for any other kind. Update
  external HITL list DTOs (including the existing run-scoped `hitl:read` view),
  `HitlItem` kind unions, and
  `web/components/inbox/hitl-card.tsx`,
  `hitl-inbox-list.tsx`, `web/components/board/run-hitl-response.tsx`, and
  `hitl-decision-controls.tsx` to reuse schema-driven fields and make the
  request visibly task-bound. Add the derived flag/history to
  `web/lib/queries/board.ts`, `task-detail.ts`, board task-card/detail page,
  and EN/RU message parity in `web/messages/en.json` and
  `web/messages/ru.json`.

  **Acceptance:** agent questions count as actionable HITL in project and
  cross-project Inbox, never as passive `inbox_items` notifications; form
  submission is localized and validates server-side; an answered/superseded/
  pending-activation question disappears; board/detail show an honest
  “awaiting clarification” indicator and ordered history; `agent_question`
  remains human-only through the shared response controls; all existing HITL
  kinds render unchanged. Extend query/component tests and
  `web/e2e/inbox.spec.ts`; run the E2E slice only after the unit/integration
  gate is green.

  **Logging:** query WARN only for a structurally impossible missing task/run;
  UI emits no raw error or answer content, relying on localized typed errors.

### Phase 3: triager adoption, contracts-as-built, and release

- [ ] **Task 10: Rewire the core triager and behavioral fixture to Human-ask.**

  In the separate `maister-plugins` checkout, update
  `packages/core/maister-agents/triager.md` without losing its current
  `max_clarification_rounds`, `auto_enqueue_confidence`, runner/policy, or
  repetition-hook contract. Replace comment-based clarify steps with
  `ask_human(..., reTriggerMode: 'triage')`; preserve the stateless
  reconstruction model, `comment_list`, hard give-up `flag: true`, and
  default `intake_mode: clarify`. Remove `task.comment_added` from the
  triager's recommended trigger list while retaining `task.created` and
  `task.triage_requeued`. Mirror its behavior in
  `web/lib/agents/__tests__/fixtures/core-package/maister-agents/triager.md`
  and migrate the triager package/definition/wire tests.

  **Acceptance:** the rendered effective definition is package-sourced and
  uses Human-ask; a response causes exactly one fresh triager run; comments
  still work for unrelated comment-processing agents; a max-round give-up
  remains a flag. Build/test the package validation path, create a
  package-scoped core release commit, annotate a new `core/vX.Y.Z` tag, and
  validate project package upgrade/install against that tag.

  **Logging:** retain concise agent instructions; runtime logs identify
  Human-ask request ids and re-trigger mode, never human content.

- [ ] **Task 11: Perform as-built contract closure and the merge-time sequence check.**

  Reconcile every Phase-0 contract with the implementation in the same change:
  generated/OpenAPI examples and MCP tool mirror, database narrative plus both
  ERDs, HITL/agents/triage/tasks/domain-events/external-operations analytics,
  screen docs, error taxonomy if a new user-visible error code was required,
  and all implementation-status labels. Audit every S1–S8 traceability row
  against its final test and implementation owner; resolve a mismatch in the
  specification or code explicitly, never by weakening the test silently.
  Rebase onto `main`, renumber ADR-136/migration 0099 if needed, update
  journal/snapshot/anchors and prose references, then run the complete
  verification set.

  **Acceptance:** `pnpm --dir web typecheck`,
  `pnpm --dir web test:unit`, `pnpm --dir web test:integration`,
  `pnpm --dir mcp typecheck`, focused MCP tests, `pnpm validate:docs`,
  EN/RU key-parity, and `git diff --check` are green. Confirm new tests are
  listed by their runner before relying on them. Treat a harness limitation as
  an explicit, named blocker—never as a green suite.

  **Logging:** validation output may report file/test names and error codes;
  never seed production clarification content into diagnostics.

## Cross-phase edge-case matrix

- Persistence: legal/illegal kind-shape combinations, unique origin/sequence,
  source-run/HITL cleanup retention, journal-snapshot integrity, legacy HITL,
  and no destructive rewrite.
- Authorization: agent-only `hitl:request`, bound-run/project/task checks,
  triager-only re-trigger mode, human-only response scope, 404 existence
  hiding, strict schema version, and success-versus-failure audit placement.
- Lifecycle: intent → supervisor termination → terminal source → active Inbox;
  supervisor 4xx/5xx/network, duplicate retry, natural exit, DB rollback,
  restart/system-sweep recovery; no `NeedsInput`, slot leak, `runFlow`, input
  artifact, or ACP resume.
- Concurrency: same/different answer retries, answer versus launch, full
  sibling cancellation, mutually exclusive supersession provenance,
  assignment cleanup, and outbox at-least-once dedupe.
- Read model/UI: terminal-origin active question only, pending/failed/stale
  exclusion, separate from social notifications, typed form and EN/RU parity,
  board/task-detail condition/history, and existing kinds unchanged.
- Prompt/retrigger: stored and legacy template prompt unchanged; effective
  prompt/history deterministic; generic target-only dispatch; triager exactly
  once; unrelated comment triggers unchanged.

Every implementation phase exits only after
`pnpm --dir web test:unit` and `pnpm --dir web test:integration` are
executable and green (plus the focused MCP/project gates named by that phase).
Migrate existing assertions/fixtures in the same task where their observable
contract changes; do not quarantine or delete stale tests silently.

## Separate follow-up: Flag resolution UX (not part of this delivery)

Plan separately for:

1. Persist a nullable `tasks.triage_reason` through `applyTriageFlag`,
   DTOs, board/detail views, activity, and localized UI. Require a clear flag
   reason from agents and preserve existing task-comment context without
   treating comments as the sole source of truth.
2. Add an authorized “clear flag / take over manually” route/action that clears
   only flag state/reason and records activity. It must **not** call
   `sendTaskToTriage`, emit `task.triage_requeued`, or force an agent run.
3. Route the cleared task through the existing launch/triage UI, with
   launchability/RBAC/i18n/integration coverage and a separate migration/ADR
   preflight if this plan's reserved numbers are no longer available.
