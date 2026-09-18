# Implementation Plan: Operator Recover of a crashed agent node re-enters the graph

Branch: `claude/crashed-agent-recovery-routing-dc28b6`
Created: 2026-09-18
Request: P0-1 of the execution-seam diagnosis (2026-09-18), supplied as chat text.
Baseline verified at: `83bce7bb` (this worktree) — identical ADR/migration heads to `master`.

## Settings

- Testing: **yes** (the request freezes RED 1–4 plus a falsification pass)
- Logging: **verbose** (DEBUG-level flow tracing; project default)
- Docs: **yes** — mandatory documentation checkpoint at completion
- Scope guard: `run_kind = 'flow'` agent nodes only. Scratch recover
  (`web/lib/scratch-runs/recovery.ts`) and standalone agent-run recover are
  out of scope (diagnosis item A4).

## Roadmap Linkage

Milestone: **"none"**.
Rationale: no named A/B stabilization milestone exists in `.ai-factory/ROADMAP.md`;
this item is a defect fix under the existing `stage-ab-stabilization` plan, which
records the same linkage (`.ai-factory/plans/stage-ab-stabilization.md:246`).

## Research Context

`.ai-factory/RESEARCH.md` is absent. Evidence sources are the current code at
`83bce7bb`, the accepted contracts in `docs/`, and the supplied diagnosis.

---

## Verified anchors (read before implementing; do not re-derive)

Every row below was re-read in this worktree. **Three anchors correct the
request brief** and are marked ⚠ — they change what the fix must do.

| # | Anchor | Fact |
| --- | --- | --- |
| A1 | `web/lib/runs/recover.ts:103-283` | `resumeCrashedRun` Phase 1: `localHost` probe → one tx (`takeSchedulerLock` → `SELECT … FOR UPDATE` → CAS) → cap probe. Slot free: CAS `Crashed→Running` **also writing `currentStepId: resumeTarget` and `resumeStartedAt: at`** (`:247-255`), then `mintPlacement(reason:"recover")` (`:259-263`). Cap full: CAS `Crashed→Pending` with the same two fields (`:221-229`) and **no supervisor call**. |
| A2 | `web/lib/runs/recover.ts:349-372` | The `redispatch` arm is the ONLY caller of `runFlow(id, {crashResume:{targetStepId}})`. It passes neither `db` nor `executionHosts`. |
| A3 | `web/lib/runs/recover.ts:374-427` | The `resume-agent` arm calls `client.createSession({resumeSessionId})` then `scheduleResumedSessionDrive(...)` — the NeedsInput permission driver. It never calls `runFlow`. |
| A4 | `web/lib/runs/resume-driver.ts:342-356` | The driver takes the `runFlow` shortcut only when `hasFlowPermissionResume(db, runId)` OR `hasDurableFlowSession(db, runId, supervisorSessionId)`. It passes **no resume flag** — the graph re-enters by its own durable-continuation path. |
| A5 | `web/lib/flows/graph/permission-resume.ts:644-659` | `pendingNodePermissionResumeExists` requires `resume_attempt.execution_assignment_id = runs.execution_assignment_id` (`:649`) AND `action_resume->>'assignmentId' = runs.execution_assignment_id` (`:655`). A crashed attempt is bound to the retired epoch, so both fail. |
| A6 | `web/lib/runs/state-transitions.ts:1343-1447` | `crashRunningRun` writes `runs` only: `status`, `endedAt`, `resume_target_step_id := current_step_id`, `current_step_id := null`, **`resume_started_at := null`** (`:1369-1386`); closes open `hitl_requests` (`:1394-1399`); `releaseAssignmentForRun(tx, runId, "crashed")` (`:1402`). It touches **no `node_attempts` row** — grep for `nodeAttempts` in that file returns nothing. |
| A7 | ⚠ `web/lib/execution-host/assignments.ts:240-271` | The crashed run's assignment becomes **`released`**, not `superseded` — `crashRunningRun` calls `releaseAssignmentForRun`. `mintAssignment` supersedes only an `active` row (`:167-175`), so Phase 1 mints epoch N+1 beside a `released` N. The brief's "superseded" is wrong in detail; the consequence (crashed attempt bound to a non-current assignment) is unchanged. |
| A8 | `web/lib/flows/graph/node-prompt-owner.ts:89-107` | `admitNodePrompt` throws `PromptOwnerInvariantError("node_admission_generation")` unless, among others, `attempt.executionAssignmentId === assignment.id`, `attempt.status === "Running"`, `run.currentStepId === attempt.nodeId`, `attempt.actionPromptOrdinal === owner.promptOrdinal`, `attempt.actionCompletion === null`, and — for `variant:"node"` — `permissionResume === null`. |
| A9 | `web/lib/runs/resume-driver.ts:623-663` | `admissionConflict` (`details.reason === "prompt_owner_invariant"`, stamped by `PromptOwnerInvariantError`, `execution-host/prompt-owners.ts:62-73`) sets `yielded = true`; `if (yielded) return;` at `:663` precedes every terminal decision AND the `finally { deleteSession }` at `:785-797`. Net: run `Running`, fresh idle session, no driver. |
| A10 | `web/lib/runs/resume-driver.ts:729-747` | `!permissionDelivered` → `crashResumedRun`, whose CAS is `eq(runs.status, "NeedsInput")` (`state-transitions.ts:1264-1275`) — a no-op for a `Running` run. Ordered **before** the `end_turn` handoff at `:749-771`. |
| A11 | `web/lib/reconcile.ts:379-390` | The `reattach` arm returns `{action:"reattach", reason:"live-session"}`; the sweep dispatches `queueMicrotask(() => runFlow(cand.runId))` at `:1801-1810` — **no `db`, no `executionHosts`, no resume flag**. |
| A12 | `web/lib/reconcile.ts:414-432` | No live session + `ai_coding | orchestrator` + past `MAISTER_RECONCILE_GRACE_SECONDS` (default 90, `instance-config.ts:327-338`) → crash `agent-session-gone`. |
| A13 | ⚠ `web/lib/runs/recover-classify.ts:32-44` | `classifyRecover` routes **`ai_coding` and `orchestrator`** to `resume-agent`. **`judge` is NOT in that set** — it falls to `retrySafe ? "redispatch" : "discard-only"`. The brief's "`ai_coding | judge | orchestrator`" describes `admitNodePrompt`'s agent set (A8), not the recover classifier. Owner decision 2026-09-18: widen it (T2.6). |
| A14 | ⚠ `web/lib/runs/active-run-session.ts:53-76` | The ranking is now **three** keys: `liveIncarnationFor(...)` DESC, then `acp_session_id IS NOT NULL` DESC, then `updated_at` DESC. The substep-outranking bug is fixed **for a live run**. After a crash every incarnation is terminal, so key 1 ties false for every row and keys 2–3 still decide — the brief's ground truth 9 **survives for the crashed case only**. |
| A15 | `web/lib/runs/substep-session.ts:30-74` | Substep session names: `gate-<id>` (`gates-exec.ts:346`), `<node>-verify-<round>-<ordinal>` (`consensus/runtime.ts:716`), `<node>-synthesize` (`consensus/runtime.ts:802`), `gate-chat-<hitlRequestId>` (`gate-chat.ts:98`), `sync-<attempt>`. The node's own name is `node.session ?? "default"` (`runner-graph.ts:2961-2964`). |
| A16 | **`web/lib/flows/graph/runner-graph.ts:2284-2288`** | `isCrashResume = Boolean(opts.crashResume) && !isNeedsInputResume && status === "Running" && currentStepId !== null`. It feeds `isResume` (`:2348-2354`) and `resumeNodeId = currentStepId` (`:2355`). It sets **neither** `pendingSessionPolicy` **nor** `pendingDurableResumeNodeId`. |
| A17 | **`web/lib/flows/graph/runner-graph.ts:2866-2876`** | `resumingThisNode` needs `lastForNode.status === "NeedsInput"`, or `reusesCompletedAttempt`, or `pendingDurableResumeNodeId === node.id` with status `Running|Pending|Failed+actionCompletion`. A crashed attempt is `Running` **without** `pendingDurableResumeNodeId` ⇒ `resumingThisNode` is **false** ⇒ the `else` branch at `:3013` appends a **fresh** attempt stamped `executionAssignmentId: execution?.client.assignment.id` (`:3039-3042`) — the NEW epoch. |
| A18 | **`web/lib/flows/graph/runner-graph.ts:3019-3028`** | On the fresh-attempt branch, `attemptResumeSessionId` is populated **only** when `pendingSessionPolicy` names this node with policy `"resume"`, from `latestAttemptForNode(runId, node.id, db).acpSessionId` — the **node's own attempt row**, resolved before the new row is appended. Absent handle ⇒ `setSessionFallback(nodeAttemptId)` (`:3060-3063`). |
| A19 | `web/lib/flows/runner-agent.ts:1441-1470` | `ctx.resumeSessionId` makes the dispatch `createSession({...createInput, resumeSessionId})` and degrade **observably** to a fresh session on `MaisterError("CHECKPOINT")` (`sessionFallback = true`, ADR-081). `:1252-1254` prefixes `RESUME_READONLY_LIFT` to the prompt when resuming. |
| A20 | `web/lib/flows/graph/runner-graph.ts:2398-2422` | The crash-resume claim is a bare CAS-clear: `UPDATE runs SET resume_started_at = NULL WHERE id = ? AND resume_started_at IS NOT NULL`; zero rows ⇒ `"runGraph crash-resume claim lost"` and return. Single-winner across recover and scheduler-promote, because A1 is the only writer of that marker on this path. |
| A21 | `web/lib/flows/graph/runner-graph.ts:2880-2889` | `isDurableContinuation && resumingThisNode && opts.driver && lastForNode.executionAssignmentId !== driver.claim.assignmentId` **throws** `staleSessionBinding`. A crashed attempt re-entered as a durable continuation under the new epoch hits this. |
| A22 | `web/lib/execution-host/create-ack.ts:121-151` | `applyCreateAck` writes `run_sessions.{hostSessionId, acpSessionId, executionAssignmentId}` and stamps `nodeAttempts.executionAssignmentId`. A fresh dispatch under epoch N+1 therefore re-binds the attempt by itself. |
| A23 | `web/lib/execution-host/ledger.ts:341-381` | Prompt idempotency is `(runId, kind='session.prompt', logicalOperationKey)`; the key is `flow_node_attempt:<variant>:<nodeAttemptId>:<promptOrdinal>` (`node-prompt-owner.ts:58-60`). A same-attempt, same-ordinal re-dispatch under a new epoch collides ⇒ `logical_operation_request_changed` / `command_invariant_conflict`. **A fresh attempt id avoids the collision by construction.** |
| A24 | **`web/lib/db/schema.ts:5327`** | `decision: text("decision")` — plain text, **no CHECK**. Precedent values `review_rework_claim` / `operator_interrupt` (ADR-160/161). **Adding `crash_recover` needs no migration.** |
| A25 | **`web/lib/db/schema.ts:5442`** | `node_attempts_action_resume_check` whitelists exactly four `kind` values and requires `action_resume->>'assignmentId' = execution_assignment_id`. **A fifth `action_resume` kind WOULD need a migration** — this plan does not add one. |
| A26 | `web/lib/flows/graph/continuation-worker.ts:138-186` | The worker's `node_attempts` arm requires `status='Running' AND ended_at IS NULL AND node_type ∈ (ai_coding, judge, orchestrator)` AND `execution_assignment_id = <active assignment>`. A crashed attempt fails the last conjunct; a closed attempt fails the first. |
| A27 | `web/lib/queries/run.ts:408-424` | `isRunRecoverable` calls the same `classifyRecover`, so the UI Recover button and the route agree by construction. Any classifier change fans out here. |
| A28 | `web/lib/scheduler.ts:595, :853, :1074` | The cap-full path promotes via `driveResume(id)` with **no `assignmentId`**, relying on the `run.executionAssignmentId` fallback at `recover.ts:387`. `isResume = !isAgent && targetAcpSessionId != null`. |
| A29 | `docs/system-analytics/execution-prompt-lifecycle.md:911` | The eligibility table already says `Crashed | Flow node/... | H until explicit recovery claim`. The `H` is correct; **the explicit recovery claim it points at does not exist** for a crashed agent node. That is this defect, stated in the spec as already-designed. |
| A30 | `web/lib/flows/graph/ledger.ts:484` | `markNodeReworked(id)` sets `status:"Reworked"`, `endedAt` — `eq(id)` only, **no CAS**. The plan adds the CAS it needs (T2.1). |

### Where the loop comes from (one sentence)

A3 sends a crashed agent node into the permission driver; A5 + A6 make both of
the driver's `runFlow` shortcuts false; A8 then refuses the prompt because A7
left the attempt on the retired epoch; A9 swallows the refusal as a yield; and
A11/A12 re-crash the idle session every tick.

---

## Design decision (frozen before coding)

**The agent arm takes the same door the `redispatch` arm already takes.** The
graph already contains every piece; nothing new is invented.

1. A **fresh** `node_attempts` row (A17) is stamped with the new epoch by
   `applyCreateAck` (A22) and carries a new attempt id, so `admitNodePrompt`
   (A8) passes **by construction** and the logical operation key cannot collide
   (A23). Trap 1 is satisfied without relaxing the fence.
2. The retained ACP handle rides the **existing** ADR-081 session-policy
   mechanism (A18), which reads the **node's own attempt row**, not
   `loadActiveRunSession`. That answers Scope 3 / Trap 3 structurally: a
   `gate-*` or `*-verify-*` row (A15) is not an attempt row for this node and
   can never be selected. `session_fallback` already makes an unresumable
   handle observable (A19).
3. Provenance rides `node_attempts.decision = 'crash_recover'` — **no migration**
   (A24), and explicitly **not** a fifth `action_resume` kind (A25).
4. The single-winner claim is the existing `resume_started_at` CAS-clear (A20),
   already stamped by Phase 1 (A1) for both the slot-free and cap-full paths.

### Attempt shape — the full option space (owner decision, 2026-09-18)

The question is what happens to the ledger row when Recover re-dispatches. The
option space is bounded by four hard constraints: the logical operation key is
`flow_node_attempt:<variant>:<attemptId>:<ordinal>` and is unique per run (A23);
`admitNodePrompt` pins assignment, ordinal, status and `action_completion` (A8);
`node_attempts` is `UNIQUE(run_id, node_id, attempt)` (`schema.ts:5426-5428`);
and `node_attempt_cost_rollups` is **`UNIQUE(node_attempt_id, model)`**
(`schema.ts:5488-5491`). Within those, the list is exhaustive:

| # | Shape | Viable? | Cost |
| --- | --- | --- | --- |
| **A** | **Fresh attempt row (`attempt = N+1`), crashed row closed `Reworked`/`crash_recover`** | **yes — chosen** | attempt counter advances, so the rework budget and both correction counters need a carve-out. That carve-out already exists and is proven (ADR-161). |
| B | Same row, `action_prompt_ordinal` bumped to `N+1` | yes, technically | **Two paid ACP turns collapse into ONE cost-rollup row.** Also needs the `staleSessionBinding` guard (A21) opened, and a second turn overwrites the first's `action_completion` and reuses a pre-crash `checkpoint_ref`. |
| C | Same row, same ordinal, rely on command idempotency | **not a dispatch option** | This IS the evidence-first path (T2.4): `issueOwnedPrompt` reattaches to the existing command. Reattaching when the session is dead waits for evidence that never comes. Named here only so it is not mistaken for a third alternative. |
| D | Second row at the same `attempt` number | no | Blocked by `UNIQUE(run_id, node_id, attempt)`. |
| E | A, but charged to `rework.maxLoops` instead of carved out | yes | Wrong semantics: a crash is not flow-declared rework, so a crash-loop would silently exhaust a flow's rework allowance. Rejected for the reason ADR-161 rejected it for operator restarts. |

**Chosen: A**, for the ordinary crash-resume dispatch. It does **not** govern
T2.7's all-settled orchestrator arm: that run was parked, not killed mid-turn,
so it re-enters through `orchestratorResume` and REUSES its parked `NeedsInput`
attempt. Two different re-entries, two different shapes, both deliberate.

The deciding argument is not convenience, it is the cost ledger.
`node_attempt_cost_rollups` is unique on `(node_attempt_id, model)`, so under B
the pre-crash turn and the post-recover turn **upsert into the same row** and
become permanently indistinguishable. Two ACP turns were paid for; the ledger
must show two. That loss is silent and unrecoverable after the fact, which is
the worst property a defect can have.

Three secondary arguments point the same way. A closes the stale open attempt
`crashRunningRun` leaves behind (A6), which is itself latent — `findOpenNodeAttempt`
returns it and the permission-resume predicate can match it. A avoids opening the
`staleSessionBinding` guard on the dispatch path (A21). And A is what the docs
already promise ("re-running it once as a fresh attempt").

B's one genuine advantage, stated honestly: a crash-and-recover would read as a
single visit everywhere with no accounting carve-out. That is not worth the cost
data.

**Identifiers on both recover routes** (skill-context: body-controlled ids).
Unchanged by this plan and re-asserted in T0.2: `runId` = `url-param`;
`userId` / token principal = `auth-context`; `projectId`, recover-target node,
`acp_session_id`, runner snapshot = `server-state`. **Body stays EMPTY** on both
surfaces; no field this plan adds is reachable from a request body.

**Deployment touchpoints** (skill-context checklist, applied): this plan adds no
env var, no config file, no bound port, no sidecar binary and no new
`package.json` script. **No deployment-wiring task is required**, and none is
included. `MAISTER_RECONCILE_GRACE_SECONDS` is read, never introduced. If T3.1
grows a bound on crash-recover re-entries during implementation, it MUST come
back through this checklist and add `.env.example` + `docs/configuration.md` +
both compose files in the same phase.

---

## Commit Plan

- **C1** (T0.1, T0.1a, T0.1b, T0.2–T0.4): `docs(runs): specify crash-recover graph re-entry` — docs/spec/ADR only, Designed.
- **C2** (T1.1–T1.4): `test(runs): reproduce the stalled crashed-agent recover` — RED only, expected red.
- **C3** (T2.1–T2.4): `fix(runs): re-enter the graph on crashed-agent recover` — the core routing fix; RED 1 and RED 2 green.
- **C4** (T2.5–T2.7): `fix(runs): resolve the recover session and widen the agent set` — session identity, `judge`, the waiting orchestrator; RED 3 green.
- **C5** (T3.1–T3.3): `fix(runs): recover the crash-recover intent and fan out provenance` — RED 4 green.
- **C6** (T4.1–T4.4 incl. T4.2a): `test(runs): falsify the crash-recover guards and sync docs` — falsification + as-built docs.

---

## Tasks

### Phase 0 — SDD freeze (docs-first; no production code)

**No production code begins until this phase's exit criteria all hold.** The
spec is the source of truth the implementation follows; it is not a trailing
sync task.

Exit criteria, all mandatory:

1. `.ai-factory/specs/crashed-agent-recovery-routing.spec.md` exists and carries
   every section the established spec shape requires, modelled verbatim on
   `.ai-factory/specs/run-continuation-controls.spec.md`: Purpose · Scope source
   · Verified baseline · **Requirements** (`| **REQ-NN** | normative MUST |`) ·
   **API contract** · **DB contract** · **System-analytics contract** ·
   **Acceptance criteria traceability** (`| **AC-NN** | Criterion | Requirements
   | Test id + lane |`) · Non-goals · Linked artifacts.
2. **Every REQ is normative and testable** — RFC-2119 phrasing, identifiers
   verbatim, no description-shaped prose. **Every REQ maps to at least one AC,
   and every AC names exactly one primary test id and its lane.** An AC with no
   test, or a test with no AC, fails this gate.
3. **Every Scope item 1–7 of the request maps to at least one REQ**, and the
   mapping is written down. Unmapped scope is a hole, not an omission.
4. Each new piece is tagged `(Designed)` per docs R6; nothing is tagged
   `(Implemented)` before Phase 4.
5. `pnpm validate:docs` and `pnpm validate:contracts` green.

**Binding lesson from `patches/2026-09-17-09.57.md`** ("Spec and shipped OpenAPI
claimed agent-run prompt coverage the code never had"): write every contract
sentence from the **delivered seam**, never from this plan's analysis. That
defect shipped because the prose was authored from a plan that had enumerated a
seventh owner variant while the code covered six, and no test drove the seventh.
Each REQ here must name the function or route that enforces it, and each AC must
be falsifiable by a test that drives a **real producer** — a hand-seeded row no
production writer creates is a hole, not a fixture.

- [x] **T0.1 — Freeze the anchor table and publish the three corrections.**
  Files: `.ai-factory/specs/crashed-agent-recovery-routing.spec.md` (new).
  Copy the A1–A30 table above as the spec's normative baseline. State the three
  ⚠ corrections explicitly, each with its file:line: `judge` is not in the
  recover classifier's agent set (A13); `loadActiveRunSession` already ranks on
  live incarnation and the substep hazard survives **only** for the crashed case
  (A14); the crashed assignment is `released`, not `superseded` (A7).
  Verify: the spec's REQ/AC matrix has one REQ per Scope item 1–7 and one AC per
  RED 1–4 plus the falsification pass. Model the file on
  `.ai-factory/specs/run-continuation-controls.spec.md`.
  Logging: none (docs task).

- [x] **T0.1a — Freeze the API contract across all four surfaces.**
  Files: `docs/api/web.openapi.yaml` (`recoverRun` `:8735`);
  `docs/api/external/operations.openapi.yaml` (`extRecoverRun` `:2392`);
  `mcp/src/tools.ts` (`run_recover` `:535`); the spec's `## API contract`.
  **No new path, no new method.** Both routes keep an EMPTY body and the shared
  `recoverHttpResponse` projection. State the blast radius explicitly so a
  reviewer can confirm it rather than infer it.

  **Four surfaces, not one.** The recover contract is published in four places
  that can disagree: the internal OpenAPI, the ext OpenAPI, the MCP tool
  description (`mcp/src/tools.ts:535` hard-codes `{ ok, state, runStatus }` and
  names every refusal state in prose), and the EN/RU catalogs. `mcp/src/__tests__/tool-contract.test.ts`
  binds the MCP tools to the ext paths, so an ext-route parameter change trips it.

  ⚠ **`pnpm validate:contracts` is NOT evidence of contract correctness here.**
  It runs the OpenAPI/AsyncAPI meta-schemas and resolves `$ref`s; it does **not**
  check examples, `operationId`s, response-code completeness, or anything
  recover-specific. Real enforcement is the MCP tool-contract test and the route
  integration suites. Treat a green `validate:contracts` as a syntax gate only.

  Work items:
  (a) **The `judge` move (T2.6).** The classifier decision table appears twice as
  client-facing contract — the route `description` (`web.openapi.yaml:8748-8754`)
  and `reconciliation-gc.md:259`. Both move `judge` from the session-less row to
  the agent row. Mirror the change in the `run_recover` MCP description if it
  enumerates node kinds.
  (b) **Close the derived-`runStatus` hole.** `runStatusForState`
  (`recover-http.ts:47-56`) derives the success body's `runStatus` from the
  result state, never from the DB — the module is pure by design. T2.7's
  orchestrator wait arm hands the run back while leaving it
  `WaitingOnChildren`, so `200 {state:"resumed", runStatus:"Running"}` would
  publish a status the run does not have. Costed accurately: a new state touches
  `RecoverResult`, both switches in `recover-http.ts` (**exhaustive — a new arm
  is a compile error, which is the safety net**), the OpenAPI `state` enums, the
  MCP description and `recover-http.test.ts`, but **not** `recover-ui.ts`, which
  keys on HTTP status alone (`:13-23`). **Prefer making `runStatus` reflect the
  committed row**: it removes a class of lie rather than enumerating one more
  case, and keeps the union at eight arms.
  (c) **Fix three verified spec-vs-code drifts in the path objects already being
  edited.** Each is cheap here and misleading if left:
  - **No `404` is declared** on the internal recover path, yet the route returns
    `404 {code:"PRECONDITION"}` for an unknown run
    (`app/api/runs/[runId]/recover/route.ts:86-89`).
  - **`RecoverQueuedResponse` (`web.openapi.yaml:16772`) is stale**: it declares
    `{state, queuePosition?}` with no `ok` and no `runStatus`, while the runtime
    body is `{ok:true, state:"queued", runStatus:"Pending"}` and `queuePosition`
    is never emitted. The ext twin `ExtRecoverAccepted` (`:3474`) is correct —
    align the internal one to it.
  - **The `409` description names only `CONFLICT`**, but `workspace-removed`
    returns `PRECONDITION`. The ext spec already documents both (`:2461-2467`).
  (d) **Decide whether the three 409s need to be machine-distinguishable.**
  `discard-only`, `conflict` and `workspace-removed` all answer 409 and the first
  two share `CONFLICT`, so an automated caller cannot tell them apart today.
  `MaisterErrorBody.details` is open (`additionalProperties: true`) and
  `details.reason` is the sanctioned discriminator, with a web-minted registry at
  `docs/error-taxonomy.md:549`. Recommend **yes**, since `runs:recover` is
  explicitly an operator/CI scope backing an MCP tool, and an unattended caller
  needs to distinguish "retry later" from "this run is unrecoverable". Adding one
  requires a registry row; the UI is unaffected because it branches on `code`.
  (e) **Sync the error taxonomy status tags.** Three of the four recover rows
  (`CONFLICT` `:50`, `EXECUTOR_UNAVAILABLE` `:52`, `CHECKPOINT` `:55`) still read
  **(Designed)** while the code and OpenAPI are Implemented; `PRECONDITION`
  `:45` omits recover's `workspace-removed` 409 entirely.

  **Explicit non-goal, recorded so it is not re-litigated:** the recover path
  emits **no** webhook, domain event or SSE frame on the `Crashed → Running`
  flip — `web/lib/runs/recover.ts` contains no emitter — so the webhook plane
  cannot distinguish "recovered into Review" from "ran straight to Review".
  Adding an observable recovery signal would mean a new enum member in
  `outbound-webhooks.asyncapi.yaml`, `web/lib/webhooks/taxonomy.ts`,
  `web/lib/domain-events/taxonomy.ts`, the `ExtPulseEventKind` mirror, the
  exhaustive `mapDomainEvent` switch **and** a `domain_events_kind_check`
  migration. Out of scope; listed under Follow-ups.
  Verify: `pnpm validate:contracts` (syntax gate), the MCP tool-contract test,
  and both recover route integration suites. Assert in the spec that the
  identifier-trust table is unchanged (body EMPTY; `runId` `url-param`;
  everything else `server-state` or `auth-context`).
  Logging: none (docs task).

- [x] **T0.1b — Record the DB-migration determination: ZERO migrations.**
  Files: the spec's `## DB contract` section.
  "Accurately work on DB migrations" here means proving none is needed rather
  than assuming it. Record the determination as a table of what *would* have
  forced one, each with its evidence:

  | Candidate change | Would need a migration? | Evidence / why avoided |
  | --- | --- | --- |
  | New `node_attempts.decision` value `crash_recover` | **No** | `schema.ts:5327` is `text("decision")` with **no CHECK**; precedent values `review_rework_claim` / `operator_interrupt` also ship constraint-free. |
  | A fifth `action_resume` kind | **Yes — so the design avoids it** | `node_attempts_action_resume_check` (`schema.ts:5442`) whitelists exactly four kinds and binds `assignmentId` to the attempt's column. See "Attempt shape". |
  | New `runs.status` value | **Yes — none added** | Locked micro-decision: provenance rides `node_attempts`, per ADR-160/161. |
  | New `execution_assignments.placement_reason` | **No** | `recover` is already in `PLACEMENT_REASONS` (`types.ts:26-38`) and already used by `recover.ts`. |
  | New prompt-owner variant | **No** | The design reuses `variant:"node"`; `execution_commands_request_v2_check` is generated from `PROMPT_OWNER_SHAPES` and would have to change otherwise. |
  | An index for T3.1's recovery predicate | **No** | The sweep already selects its candidates by `runs_project_status_idx` / `runs_project_status_kind_idx`; the new `resume_started_at IS NOT NULL` test is applied to rows already loaded. |

  If implementation nonetheless needs one, it is a **triple** — SQL file +
  `_journal.json` entry + `meta/<NNNN>_snapshot.json` — the next free number is
  `0171` (after `0170_prompt_dispatch_key`), the fourth leg is `schema.ts`
  (`drizzle-kit generate` must end reporting "No schema changes"), and the change
  folds back into this plan and the spec in the same pass.
  Verify: `pnpm --filter maister-web db:erd --check` is a no-op, and
  `web/lib/db/migrations/meta/_journal.json` is untouched in the final diff.
  Logging: none.

- [x] **T0.2 — Write the crash-recover owner/recovery row and its windows.**
  Files: `docs/system-analytics/execution-prompt-lifecycle.md`
  (the D2-derived owner table near `:247-330`, and the eligibility table at
  `:889-947`).
  Add one **crash recover** variant row naming: key inputs (run, recover-target
  node, new assignment epoch, retained node-attempt `acp_session_id`); the
  durable authority reused (`runs.resume_started_at` + the new-epoch assignment
  + the closed crashed attempt); and its three windows — crash **before**
  terminal evidence, crash **after** terminal evidence but before owner
  application, and web death **after** the Phase-1 CAS but before dispatch.
  Keep the existing `CHECKPOINT → 410` mapping for a supervisor that refuses
  `resumeSessionId`, and state that a refused resume now degrades to
  `session_fallback` inside the graph (A19) rather than failing the recover.
  Restate A29: the `Crashed` row's `H until explicit recovery claim` is
  unchanged; this task defines the claim it names.

  ⚠ **Hard gate — the original plan would have broken the build here.**
  `execution-prompt-lifecycle.md` is one of four documents in the Stage B group
  enforced by `scripts/validate-docs-indexes.mjs:18-31`, which caps
  `## Expectations` at **12 bullets** (`:146-152`) and requires every
  `**PRM-NN:**` id to carry a traceability row **with a primary test** in
  `execution-data-cutover.md` (`:167-178`). Measured now: that document has
  **exactly 12** Expectations bullets, and `PRM-01` … `PRM-12` are all allocated
  with 12 matching traceability rows. A 13th bullet or a new `PRM` id **fails
  `pnpm validate:docs`**.
  Therefore, in this document add **the owner/recovery table row and prose
  ONLY** — no Expectations bullet, no `EDGE-PRM-NN` id. This is the established
  escape hatch, used verbatim at `execution-prompt-lifecycle.md:133`: "(Prose
  only — this document is at the 12-bullet Expectations cap and gains no new
  `PRM` id.)" Mirror that parenthetical so the next reader sees why.
  The **acceptance contract** therefore lives in `reconciliation-gc.md`, which
  owns the Operator Recover flow and is in no enforced group. Add **at most two**
  Expectations bullets there. Record honestly in the spec that
  `reconciliation-gc.md` already carries 19 bullets against the documented R5a
  cap of 12 (`docs/CLAUDE.md:222-223`) — that overage is **pre-existing debt**
  this change does not create and does not fix; splitting the domain is a
  separate refactor and is listed under Follow-ups. Do not silently deepen it
  without the note.
  Also assert the identifier-trust row (body EMPTY; every id `server-state` or
  `url-param`) so the route contract is traceable from this doc.
  Verify: `pnpm validate:docs` (which runs the index and Stage B gates); every
  new Expectation bullet is one testable MUST naming its enforcing mechanism,
  identifiers verbatim, per R5a.
  Logging: none.

- [x] **T0.3 — Rewrite "Operator Recover — hybrid resume / re-dispatch".**
  Files: `docs/system-analytics/reconciliation-gc.md:249-297`;
  `docs/system-analytics/runs.md:312-346` (invariant 4);
  `docs/api/web.openapi.yaml:8735-8800` (the `recoverRun` description table).
  The current prose claims `driveResume` calls
  `runFlow(runId, {crashResume:{targetStepId}})` for agent nodes; A3 shows it
  does not. Rewrite so the agent arm enters the graph, and state the D2 recovery
  priority in order: reconcile command evidence → apply an owned terminal result
  → close the attempt boundary and re-dispatch once → never replay a prompt that
  already has agreeing terminal evidence.
  Correct the two stale reconcile comments in the same change:
  `web/lib/reconcile.ts:212-214` (a scratch run with a live session now returns
  at `:380-382` and never reaches the kind-forcing at `:404-407`) and
  `web/lib/reconcile.ts:1359-1361` (`liveByRunStep` has had no `.get` since
  `ce42c2db`; the in-flight guard reads `liveByRun` at `:1436`). Also correct
  `runStepKey`'s header at `web/lib/reconcile.ts:83-84`, whose only remaining
  justification is that dead index.
  Add the explicit classification demanded by Scope 6: "`Running`, live idle
  session, no driver" is named, counted, and logged — never a silent no-op.
  Verify: `pnpm validate:docs`; `pnpm validate:contracts`; grep the repo for the
  phrase "re-running it once as a fresh attempt" and confirm every occurrence is
  now true of both arms.
  Logging: none.

- [x] **T0.4 — Amend the stabilization plan and reserve ADR-175.**
  Files: `.ai-factory/plans/stage-ab-stabilization.md` (the D2 owner table at
  `~:348`, the AT-05 family, the S5.2 scenario list at `:783`);
  `docs/decisions.md`.
  Add the D2 row `Flow crash recover`, the AT-05 case
  **`owner-flow-crash-recover`**, and the S5.2 scenario "SIGKILL mid-turn →
  reconcile `Crashed` → Recover → `Done`". Record that K04 ("missing variant
  blocks S2") is discharged by this row.
  Reserve **ADR-175** — verified as the next free number at `master` HEAD
  (`git show master:docs/decisions.md` → max `ADR-174`). Write the `### ADR-175`
  header before citing it anywhere. **No migration number is reserved**: A24
  shows `decision` is unconstrained text and the design deliberately avoids the
  `action_resume` CHECK (A25). If implementation nonetheless needs a constraint,
  reserve `0171` (next after `0170_prompt_dispatch_key`) and fold the migration
  back into this plan in the same pass.
  Budget an **ADR renumber pass** after rebasing onto `master` before merge —
  ADR numbers are a globally sequential shared namespace and a parallel branch
  may have taken 175.
  Verify: `pnpm validate:docs:adr`. **Correction to the standing project rule:**
  the rule "a green `pnpm validate:docs` only parses Mermaid, so run the anchor
  check separately" is now stale — `package.json:10` composes
  `validate-docs-mermaid` + `validate-docs-adr-anchors` + `validate-docs-links`
  + `validate-docs-indexes` + `db:erd --check`. A green `validate:docs` **does**
  cover ADR anchors at HEAD. Run `validate:docs:adr:all` when you need the
  whole-history sweep rather than the changed-file sweep.
  Logging: none.

<!-- Commit checkpoint C1: tasks T0.1, T0.1a, T0.1b, T0.2-T0.4 -->

### Phase 1 — RED (each test must fail for its named reason)

Every behavior task in this plan runs **RED → GREEN → REFACTOR**, in that order,
and the cycle is not optional:

- **RED** — write the test first and execute it against the unfixed code. Record
  the discriminating failure verbatim. If a RED test **passes** on `83bce7bb`,
  it is not evidence of the defect: either the finding is wrong (amend the spec)
  or the test does not reach the seam (rewrite it). Never weaken an assertion to
  make a RED test fail, and never keep a green "RED".
- **GREEN** — the minimal change that satisfies the AC. No opportunistic
  refactoring in the same step.
- **REFACTOR** — only inside the ownership boundary the GREEN step touched, with
  every affected test still green. No behavior change.

Exit criteria for the phase: each test executes in a lane that actually runs it,
each fails for its stated reason, each failure text is recorded, and **every AC
in the spec has exactly one primary test**.

**Test design rules (the user's "minimum overlap, no trivial tests"):**

1. **One primary test per AC.** Overlap is permitted only where a cheaper lane
   pins a different property of the same behavior (a pure decision table in
   `unit` versus its end-to-end effect in `integration`). Two integration tests
   asserting the same transition is duplication — delete one.
2. **No trivial tests.** Do not assert a constant, a type, a getter, or that a
   mock was called with what the same test just passed it. Every assertion must
   be able to fail for a real defect.
3. **Drive a real producer.** A hand-seeded row that no production writer
   creates is a hole, not a fixture — the exact trap recorded in
   `patches/2026-09-17-09.57.md`. Where a seed is unavoidable (RED 3's substep
   row), say so in the test header and pin the constraint directly rather than
   pretending it proves a path.
4. **Assert the discriminating observable**, not an incidental one. RED 1 names
   `node_admission_generation`; a different failure must stay distinguishable.
5. **Edge cases are enumerated, not implied.** The spec's Edge-cases section is
   the checklist; each entry either names its test or is explicitly marked
   out-of-scope with a reason.

**Lane placement and runnability.** Every new file is `*.integration.test.ts`
under `web/lib/**`, which the `integration` project globs
(`web/vitest.workspace.ts:85-91`). Confirm with
`pnpm --filter maister-web exec vitest list --project integration` that the new
paths appear **before** writing assertions. No runner config change is expected;
if one becomes necessary it lands in this phase, not later.

**Binding test conventions from `web/CLAUDE.md`, not re-derived:**

- `test-support/pg-container.ts` is the **only** web Testcontainers constructor.
- A suite whose graph carries owned prompts reaches the real supervisor
  transport, and `baseUrl()` throws `CONFIG` when `MAISTER_SUPERVISOR_URL` is
  unset under a test runner. Such a suite either mocks the health seam with
  `test-support/supervisor-health-fixture.ts` **or** uses
  `test-support/real-supervisor.ts` — and the latter only when it genuinely
  exercises supervisor behavior. RED 1–4 do (SIGKILL an adapter, drive
  `session/resume`), so real-supervisor is the correct choice here and must be
  justified in each test header. Never set `MAISTER_SUPERVISOR_URL` globally.
- Route suites load the route module in `beforeAll`, never lazily inside a case.
- Prefer awaiting the real condition over `expect.poll`, whose 1 s default is too
  tight under contention.

**Coverage matrix.** Fill this in during T0.1 and keep it in the spec as the
single source; the table below is the skeleton the tasks implement.

| AC | Property pinned | Primary test | Lane |
| --- | --- | --- | --- |
| Graph re-entry after crash | run reaches a terminal state; exactly one new prompt under the new epoch; old attempt closed | RED 1 (T1.1) | integration + real supervisor |
| Evidence first | agreeing terminal evidence applies with **no** second prompt | RED 2 (T1.2) | integration + real supervisor |
| Session identity | the node's own handle resumes, never a substep's | RED 3 (T1.3) | integration |
| Durable authorization | web death after the CAS recovers with no second click; concurrent recover is `409` | RED 4 (T1.4) | integration + real web |
| `judge` admitted | classifier routes `judge` to `resume-agent`; UI and route agree | T2.6 cases | unit (table) + integration (one end-to-end) |
| Waiting orchestrator | zero new children, zero new coordinator prompts | T2.7 case | integration |
| Provenance accounting | `crash_recover` moves neither correction counter nor the rework budget, and does **not** consume the operator-restart budget | T3.3 cases | unit (pure counters) |
| Reattach no-op closed | a `Running` run with an idle session is driven or explicitly classified | T3.1 case | integration |

Host (owner decision 2026-09-18): **extend
`web/lib/flows/graph/__tests__/prompt-owners.integration.test.ts`.** Its `:2253`
family `owner-flow-node: SIGKILL %s recovers the complete graph without another
accepted prompt` is the nearest precedent and already owns the real-supervisor
plus forked-driver scaffolding, so the new cases reuse it instead of cloning it.
Two consequences to plan for rather than discover: the file already runs about
23 minutes, so add the cases to the existing `it.each` matrices where the setup
is genuinely shared instead of writing standalone `it` blocks; and the new AT-05
family name is `owner-flow-crash-recover`, matching T0.4's plan amendment so the
acceptance matrix and the test agree by name.

All four use **real Postgres** (`startMainPostgresTestDb` from
`web/test-support/pg-container.ts:301`) and the **real supervisor**
(`startRealSupervisor` from `web/test-support/real-supervisor.ts:211`) with the
resumable fixture `supervisor/test/fixtures/mock-acp-adapter-resumable.mjs`.
Trap 5 is binding: the mocked route suites drive a fake `select` that ignores
`WHERE` (`web/app/api/runs/[runId]/recover/__tests__/route.integration.test.ts`
stubs `resumeCrashedRun` outright), so **no pinning assertion may live in a
mocked suite**.

- [x] **T1.1 — RED 1: the stand reproduction.**
  Launch a flow run onto an `ai_coding` node through the production graph
  driver. SIGKILL the adapter process (by the pid `createSession` returns, or
  `pgrep -f supervisor.fixturePath`; see
  `web/test-support/__tests__/real-supervisor.integration.test.ts:106-112`).
  Age the attempt past the grace window — reuse the
  `seedNodePromptOwner` convention of back-dating `started_at` one hour
  (`web/test-support/prompt-owner-fixture.ts:31-33`) — then run the reconcile
  sweep and assert `Crashed` with a non-null `resume_target_step_id`.
  `POST` the recover route (the real `resumeCrashedRun`, **not** the stub) and
  assert `200 {state:"resumed"}`.
  **Then assert the run finishes `Done` or `Review`**, that exactly ONE new
  `execution_commands` row of `kind='session.prompt'` exists under the NEW
  `execution_assignment_id`, and that the crashed attempt is closed with
  `decision='crash_recover'`.
  Expected RED on `83bce7bb`: the run stays `Running` with a live idle session,
  zero prompt commands under the new assignment, and the log carries
  `node_admission_generation`. **Assert that exact string** so a different
  failure stays distinguishable (request TDD, falsification clause).
  Files: the chosen test file; helpers from `web/test-support/`.
  Logging: the test asserts on structured fields, never on prose.

- [x] **T1.2 — RED 2: evidence first, no second prompt.**
  Let the adapter COMPLETE the turn so a terminal receipt lands and its event is
  ingested, then kill the web-side driver process before owner application
  (fork pattern: `permission-resume.integration.test.ts:98-131`), then kill the
  session and run reconcile to `Crashed`.
  Recover MUST apply the existing evidence and continue **without** a second
  `session.prompt`. Assert the command count **per attempt** (not per run) and
  that `execution_commands.application_state` reaches `applied` with
  `completion_applied_at` set.
  This is the D2 priority-(a) case and the one most likely to regress into a
  paid duplicate turn.
  Verify: `web/lib/execution-host/prompt-owner-recovery.ts:37`
  (`startPromptOwnerWorker`) is the applying path; the test must not hand-write
  `action_completion`.

- [x] **T1.3 — RED 3: session identity.**
  Seed a run whose finished `gate-<id>` substep `run_sessions` row is **newer**
  (`updated_at`) than the node's `default` row and also carries a non-null
  `acp_session_id`, with every incarnation terminal (so A14's first ranking key
  ties false for both rows).
  Assert the recovered dispatch resumes the **node's own** handle. Under the
  frozen design the assertion is structural: the `resumeSessionId` sent to the
  supervisor equals the crashed **node attempt's** `acp_session_id`, and never
  the substep row's.
  Also assert `classifyRecover`'s input: the plan/target decision must not be
  taken from a substep row (see T2.5).

- [x] **T1.4 — RED 4: durable authorization and the concurrent second click.**
  SIGKILL the web process between the Phase-1 CAS and the dispatch
  (`web/test-support/real-web.ts` + the pattern at
  `web/test-support/__tests__/execution-ab-isolation.integration.test.ts:335`).
  After restart the run MUST continue through the ordinary re-entry — reconcile
  sweep or `startFlowContinuationWorker` — with **no second operator click**.
  Separately assert a concurrent second `POST /recover` returns `409`
  (`CONFLICT`), which the existing `resume_started_at` CAS already guarantees
  (A20) and which must not regress.
  Expected RED on `83bce7bb`: after restart the run is re-crashed
  `agent-session-gone` (A12) or silently no-ops (A11).

#### RED evidence recorded against `83bce7bb` (2026-09-18)

All four executed in `integration` against real Postgres + the real supervisor
(`mock-acp-adapter-resumable.mjs`). Family: `owner-flow-crash-recover` in
`web/lib/flows/graph/__tests__/prompt-owners.integration.test.ts`.

| RED | Verbatim failure | Chain observed in the driver log |
| --- | --- | --- |
| 1 (T1.1) | `AssertionError: expected 'Running' to be 'Review'`, preceded by the discriminating count: zero `session.prompt` rows under the run's current `execution_assignment_id` | `run-resume-driver … {"code":"CONFLICT","reason":"prompt_owner_invariant"} "runResumedSession: driver yielded to durable prompt owner"` → `reconcile … {"reason":"live-session"} "reconcile: reattached"` → `flow-runner-graph … {"code":"CONFLICT","details":{"reason":"assignment_fenced","assignmentId":"<retired>","local":true}} "driver-yielded awaiting durable prompt continuation"` |
| 2 (T1.2) | `AssertionError: expected 'Running' to be 'Review'` — the owner applies the evidence, but nothing drives the graph afterwards | same `prompt_owner_invariant` yield; the continuation worker cannot serve the crashed attempt (A26) |
| 3 (T1.3) | `expected … to match object { resumeSessionId: "mock-ea717fcc-…" }` / `received "acp-substep-8381dca3-…"` | the unfixed arm reads `loadActiveRunSession`, which ranks the finished `gate-review` row first once every incarnation is terminal |
| 4 (T1.4) | `AssertionError: expected 'Running' to be 'Review'` | the committed intent has no owner: the sweep's `reattach` arm calls a bare `runFlow(runId)` and the already-owned guard no-ops it |

`prompt_owner_invariant` is the `details.reason` that
`PromptOwnerInvariantError` stamps; its `causeCode` at this seam is
`node_admission_generation` (`node-prompt-owner.ts:107`). The test asserts the
durable twin of that refusal — zero prompts under the new epoch — because the
admission throws BEFORE the ledger row is written, so nothing about the refusal
itself is persisted.

**RED 3 was rewritten once.** Its first form PASSED against unfixed code: the
node's own `run_session_incarnations` row was still non-terminal after the
adapter kill, so liveness — ranking key 1 — decided in the node's favour and the
substep never competed. The rewrite forces every incarnation terminal (the state
a crashed run actually reaches once the host events settle) and asserts that
precondition explicitly via `loadActiveRunSession`, so the case now fails for the
hazard it is meant to pin rather than passing for the wrong reason.

<!-- Commit checkpoint C2: tasks T1.1-T1.4 -->

### Phase 2 — GREEN: route the agent arm into the graph

Exit criteria: RED 1, RED 2 and RED 3 green; full `unit` + `integration` suites
green (`pnpm --filter maister-web test:unit && pnpm --filter maister-web
test:integration`); no expectation loosened without a written obsolete-vs-broken
classification.

**Execution order within this phase is NOT the task numbering.** Task ids are
stable references cited by the spec and the commit plan; the runtime sequence is:

> T2.4 (evidence first) → T2.1 (close the attempt) → T2.2 (route to `runFlow`) →
> T2.3 (carry the handle) → T2.5 (session resolution) → T2.6 (`judge`) →
> T2.7 (orchestrator arms).

T2.4 precedes T2.1 because the evidence decision determines whether an attempt
should be closed at all. Implement in that order; do not renumber.

**Ordering contract for this phase (two-phase commit, skill-context rule).**
The AFTER-side marker is the closed attempt plus the dispatch, never the
Phase-1 CAS. Order of operations:

| Step | Store | Timing |
| --- | --- | --- |
| cheap preconditions (`localHost` probe, classify, cap) | none | before any mutation (A1 already does this) |
| CAS `Crashed→Running` + `resume_started_at` + `current_step_id` + `mintPlacement` | Postgres, ONE tx | the durable intent, committed before any supervisor call |
| reconcile host evidence (T2.4) | supervisor + Postgres, NO enclosing tx | host I/O may never run inside an apply transaction |
| close the crashed attempt `crash_recover` (T2.1) | Postgres, own tx | only when evidence did not already finish the turn |
| `runFlow(..., {crashResume})` → graph claims via `resume_started_at` CAS-clear | Postgres + supervisor | after commit; a death here is recoverable by T3.1 |
| prompt admission + `applyCreateAck` re-bind | Postgres + supervisor | owned by the existing graph path |

Failure classification for the dispatch step:

| Failure of the dispatch | Route answer | Durable state left | Recovered by |
| --- | --- | --- | --- |
| `isFencedError` (409 `assignment_fenced`) | `503 EXECUTOR_UNAVAILABLE` (`transient`) | `Running`, marker set, attempt closed | T3.1 re-entry |
| `MaisterError("EXECUTOR_UNAVAILABLE")` | `503` (`transient`) | same | T3.1 re-entry |
| supervisor refuses `resumeSessionId` (`CHECKPOINT`) | **not a recover failure** | `Running`, `session_fallback` stamped | the graph continues fresh (A19) |
| any other throw | `410 CHECKPOINT` (`unresumable`) via `crashRunningRun` | `Crashed` again, marker cleared by A6 | operator |

- [x] **T2.1 — Close the crashed attempt, after the evidence decision and before dispatch.**
  Files: `web/lib/runs/recover.ts` (`driveResume`'s agent arm);
  `web/lib/flows/graph/ledger.ts` (`markNodeReworked`, `:484`).

  ⚠ **Ordering, resolved — do NOT put this in the Phase-1 transaction.** The
  first draft of this plan did, which created two holes:
  - T2.4 must reconcile host evidence **before** deciding to re-dispatch, and
    host I/O may never run inside a DB transaction (the durable-worker rule: no
    HTTP, file hashing or prompt wait inside an apply transaction). Evidence
    therefore cannot be consulted from the Phase-1 tx, so an attempt closed there
    would be closed before anyone knew whether a re-dispatch was needed at all.
  - T2.7's all-settled orchestrator arm **reuses** the parked attempt, and
    `resumingThisNode` requires it to still be `NeedsInput`.

  So: Phase 1 stays exactly as it is (CAS + `resume_started_at` +
  `current_step_id` + `mintPlacement`) — that is already a durable authorization
  committed before any supervisor call, satisfying Scope 4. The attempt close
  moves into `driveResume`, in its own transaction, **after** T2.4's evidence
  decision and **before** `runFlow`.

  Close every open `node_attempts` row for the recover-target node with
  `status='Reworked'`, `ended_at=now()`, `decision='crash_recover'`.
  Add the CAS `markNodeReworked` lacks (A30): guard on
  `status='Running' AND ended_at IS NULL` and return whether it applied, so a
  concurrent writer cannot be clobbered.
  **That `status='Running'` guard is load-bearing, not defensive** — it is what
  makes a parked orchestrator's `NeedsInput` attempt invisible to this close, so
  T2.7's reuse path keeps the row it needs. Say so in the code comment; a later
  reader who widens the predicate to "any open attempt" would silently break the
  orchestrator arm with no failing test unless T2.7's case exists.
  Do this **only** on the `resume-agent` plan; the `redispatch` arm keeps today's
  behavior.
  Both crash windows this ordering creates are recoverable and must be covered by
  T3.1: web death **before** the close (run `Running`, marker set, attempt still
  open) and **after** the close but before `runFlow` (attempt closed, no
  dispatch). Both re-enter idempotently through the `crashResume` claim.
  **Do not touch `hitl_requests`** — A6 already closed them and the resumed
  prompt may raise a NEW permission needing its own row (Trap 2).
  Rationale (multi-store atomicity rule): the status flip, the epoch mint and
  the ledger close are one transition; splitting them leaves a `Running` run
  with an open attempt on a dead epoch — exactly today's stall.
  Logging: `INFO [recover] crash-recover intent committed {runId, targetStepId,
  assignmentId, assignmentEpoch, closedAttemptIds}`; `WARN` when the CAS finds
  no open attempt (a legitimate state after T2.4 applied terminal evidence).

- [x] **T2.2 — Send the `resume-agent` arm through `runFlow`.**
  Files: `web/lib/runs/recover.ts:374-457`.
  Replace `createSession({resumeSessionId}) + scheduleResumedSessionDrive` with
  `runFlow(runId, {crashResume:{targetStepId: resumeTarget}, db, executionHosts})`.
  Pass `db` and `executionHosts` — note A2: the `redispatch` arm passes neither
  today and therefore binds a fresh local host over `getDb()`; fix both arms in
  the same change so the recovered run runs on the caller's handle and the
  minted assignment.
  Keep the existing catch ladder's typed outcomes (`transient` for fenced /
  `EXECUTOR_UNAVAILABLE`, `unresumable` otherwise) so `recover-http.ts` and both
  routes are untouched.
  Delete the now-unused `scheduleResumedSessionDrive` import **only if** no
  other caller in this file remains — `web/lib/services/hitl.ts:496,:1232` and
  `web/lib/runs/resume-recovery.ts:205` still use it and must not be touched.
  **Deferred-release audit** (skill-context rule): after this change the arm
  creates no session and therefore holds no supervisor-side deferred, so the
  unreached `finally { deleteSession }` at `resume-driver.ts:785-797` (A9) stops
  being reachable from Recover at all. Confirm by inspection that no failure
  path in the new arm leaves a created session unowned, and that the graph's own
  dispatch retains its existing cleanup. Separately: runs already stalled on the
  stand carry an orphaned idle session created by the OLD arm; T3.1(a) re-enters
  them via `crashResume`, which is what reclaims those sessions — assert one
  such pre-existing-orphan case rather than assuming the new code path implies
  the old wreckage is cleaned up.
  Logging: `INFO [recover] agent arm → graph re-entry {runId, targetStepId,
  nodeKind, resumeSessionIdPresent}`; DEBUG the chosen plan and the classifier
  inputs.

- [x] **T2.3 — Carry the node's retained ACP handle into the crash-resume dispatch.**
  Files: `web/lib/flows/graph/runner-graph.ts` (the `isCrashResume` block at
  `:2284-2288` and the fresh-attempt branch at `:3013-3063`).
  When `isCrashResume` is true, seed
  `pendingSessionPolicy = { nodeId: resumeNodeId, policy: "resume" }` so the
  fresh attempt resolves `attemptResumeSessionId` from
  `latestAttemptForNode(runId, node.id, db).acpSessionId` (A18) — the node's own
  row, which answers Scope 3 structurally. An absent handle already degrades via
  `setSessionFallback` (`:3060-3063`); do not add a second fallback.
  Confirm the invariant this relies on: `applyCreateAck` (A22) re-binds the
  fresh attempt to the new epoch, so `admitNodePrompt` (A8) passes **by
  construction** and the fence is satisfied, not relaxed (Trap 1).
  Logging: `INFO [graph] crash-resume dispatch {runId, nodeId, attemptId,
  resumeSessionId: !!handle, sessionFallback}`.

- [x] **T2.4 — Apply existing terminal evidence before dispatching anything.**
  Files: `web/lib/runs/recover.ts` (in `driveResume`, the FIRST step of the
  agent arm — before T2.1's close and before any dispatch; outside every DB
  transaction, because it performs host I/O);
  `web/lib/execution-host/prompt-owner-recovery.ts`,
  `web/lib/execution-host/recovery.ts` (reuse `executionCommandReconcilePass` /
  `recoverExecutionCommands`; add no second terminal writer — D1 allows exactly
  one reducer).
  Reconcile the crashed attempt's last `session.prompt`. If it carries agreeing
  terminal evidence (host receipt + ingested event) the owner has not applied,
  apply it through the existing owner path so `node_attempts.action_completion`
  and the application marker commit together, then continue the graph via
  `runFlow(runId, {db, executionHosts})` — **no new prompt** (RED 2).
  Handle A21 explicitly: a durable continuation whose attempt is bound to the
  retired epoch throws `staleSessionBinding`. State in the spec which of the two
  is chosen and why — (a) re-bind the applied attempt's `execution_assignment_id`
  to the new epoch inside the application transaction, or (b) admit a
  crash-recover re-entry at `:2880-2889`. Prefer (a): it keeps the guard's
  meaning intact and mirrors what `applyCreateAck` does for a fresh dispatch.
  If evidence is absent or disagrees, fall through to T2.1 + T2.2 unchanged; a
  quarantined disagreement must NOT be converted into a re-prompt.
  Logging: `INFO [recover] evidence-first {runId, commandId, applied|absent|
  quarantined}` — never the prompt text, never a canonical request body.

<!-- Commit checkpoint C3: tasks T2.1-T2.4 -->

- [x] **T2.5 — Take the classifier's session input from the node, not the newest row.**
  Files: `web/lib/runs/recover.ts:177-189` and `:328-347`;
  `web/lib/queries/run.ts:408-424`.
  Phase 1 feeds `classifyRecover` from `loadActiveRunSession(...)?.acpSessionId`.
  Per A14 that is safe for a live run and unsafe for a crashed one, where every
  incarnation is terminal and a finished `gate-*` / `*-verify-*` row can win on
  `updated_at`. Resolve the handle for the **recover-target node** instead — its
  own `node_attempts.acp_session_id`, falling back to the node's logical
  `run_sessions` row by `nodeSessionName` (`node.session ?? "default"`,
  A15/`runner-graph.ts:2961-2964`).
  **Fan-out — three call sites, not two.** `isRunRecoverable` (A27) must consume
  the same resolution or the UI offers Recover on a run the route refuses. And
  `web/lib/scheduler.ts:852` independently derives
  `isResume` from `(await loadActiveRunSession(tx, runId))?.acpSessionId` when
  promoting a queued recover, so the cap-full path carries the **same** substep
  hazard as Phase 1 and must take the same node-scoped resolution. Missing it
  would leave the queued path resuming a gate's context while the direct path
  resumes the node's.
  Keep `acp_session_id` server-side — `web/lib/queries/__tests__/run-recoverable.test.ts`
  already pins that it never leaves the server.
  Related evidence, do not re-derive: `patches/2026-09-15-22.47.md` establishes
  that `updated_at` on `run_sessions` is bumped **only** by the create ack
  (`create-ack.ts:131` is the sole production `.update(runSessions)`), so it
  records when a session was last *bound* — and a substep is always bound later
  than the node it runs beside. For a crashed run the substep therefore
  outranks **reliably**, not occasionally. Extend
  `web/lib/runs/__tests__/active-run-session-ranking.integration.test.ts` (added
  by that patch) with the all-terminal-incarnations case rather than starting a
  new ranking suite.
  Logging: DEBUG the resolved session name and whether it came from the attempt
  row or the logical session row; never log the handle itself.

- [x] **T2.6 — Admit `judge` to the recover classifier's agent set.**
  *(Owner decision 2026-09-18: extend.)*
  Files: `web/lib/runs/recover-classify.ts:32-44`;
  `web/lib/runs/__tests__/recover-classify.test.ts`;
  `web/lib/queries/run.ts:408-424`;
  `docs/system-analytics/reconciliation-gc.md:258-264`;
  `docs/api/web.openapi.yaml:8748-8754`.
  Today `judge` falls to the session-less branch (`retrySafe ? "redispatch" :
  "discard-only"`), although a judge node **does** run an ACP session and
  `admitNodePrompt` already accepts `nodeType ∈ {ai_coding, judge, orchestrator}`
  (A8). Widen the agent branch to `ai_coding | judge | orchestrator` so a crashed
  judge with a retained handle resumes instead of being discarded.
  **This is an observable behavior change, not a refactor.** A crashed `judge`
  with `retry_safe: true` currently re-dispatches and will now resume; one with
  `retry_safe: false` (the default) currently answers `409 discard-only` and
  will now answer `200 resumed`. Both classifier decision tables in the docs
  list `judge` under "session-less" and must move in the same commit, as must
  the pure decision-table test — that file is the contract, so update it
  deliberately and classify the change as **obsolete**, not broken.
  Fan-out: `isRunRecoverable` (A27) consumes the same classifier, so the UI
  Recover button follows automatically; add the positive case to
  `web/lib/queries/__tests__/run-recoverable.test.ts` rather than assuming it.
  Verify: a crashed `judge` node recovers to a terminal state in the RED 1 lane,
  parameterised over node kind.
  Logging: `INFO [recover] classified {runId, nodeKind, plan, retrySafe,
  acpSessionIdPresent}` — the existing classifier log, extended with nodeKind.

- [x] **T2.7 — A crashed orchestrator waiting on children re-enters its wait gate.**
  *(Owner decision 2026-09-18: fix here.)*
  Files: `web/lib/runs/recover.ts` (the agent arm, after T2.4's evidence step);
  `web/lib/domain-events/orchestrator-resume.ts:270-294`;
  `web/lib/flows/graph/runner-graph.ts:2298-2311` (`isOrchestratorResume`);
  `web/lib/runs/state-transitions.ts:1458-1535` (`crashWaitingOnChildren`).
  A run can crash **from** `WaitingOnChildren`, and `classifyRecover` routes
  `orchestrator` to `resume-agent` regardless (A13). Recovering it by prompting
  re-delegates children that may still be running — the D2 rule is that an
  orchestrator waiting for children uses its existing wait gate, not a new turn.
  Branch inside the agent arm on the orchestrator's child state, resolved from
  server state only:
  - **Any child unsettled** → do NOT dispatch. Return the run to the waiting
    state and let the existing child-terminal wake path (`orchestrator-resume`)
    drive it, exactly as a never-crashed coordinator is driven. The recover call
    still answers `200 resumed`, because the run really has been handed back.
  - **All children settled** → re-enter through the existing orchestrator-resume
    mode (`{orchestratorResume:{targetStepId}}`), which reuses the parked attempt
    and threads the coordinator's own handle (`runner-graph.ts:3002-3006`) —
    **not** the fresh-attempt crash-resume path, which would re-delegate.
  - **No children were ever created** → the ordinary crash-resume path (T2.2).
  Derive "settled" from the single existing source (`run-status-sets.ts`), never
  a hand-written status list — a settled-for-writing set is not a
  safe-to-aggregate set.
  Open sub-decision for the implementer to record in the spec: whether the
  unsettled case restores `WaitingOnChildren` or holds `Running` until the wake.
  Prefer restoring `WaitingOnChildren`, because that is the status the wake path
  CASes from (`markResumedFromWait`) and the slot accounting already understands.
  **Four verified traps in this arm. Each is a real defect if missed.**

  1. **Promotion, not a slot leak — state it accurately.** Phase 1 CAS'd the run
     to `Running`, which holds a slot (`SLOT_HOLDING_RUN_STATUSES` =
     `Running | NeedsInput | HumanWorking`, `run-status-sets.ts:35`).
     `WaitingOnChildren` is deliberately excluded from `countLiveRuns`
     (`scheduler.ts:166` says adding it "would starve the pool"), so parking back
     **releases the slot automatically** — nothing leaks. What is lost without an
     explicit call is the **promotion opportunity**: a queued `Pending` run waits
     for an unrelated trigger. The real coordinator park handles this with a
     separate, non-transactional `releaseSlotOnIdle({runId, db: rootDb})`
     (`runner-graph.ts:3703-3716`), whose failure is logged and swallowed. Do the
     same, and assert a cap-full queue advances by exactly one.
  2. **Do NOT call `markWaitingOnChildren`.** It is dead code in production
     (`state-transitions.ts:410-451`; only a test calls it) and writes different
     columns than the real park — it sets `checkpoint_at` and clears
     `keepalive_until`, which the live park at `runner-graph.ts:3661-3683` does
     not. Match the live park's column set, or state in the spec why it differs.
  3. **Clear `resume_requested_at` when parking back.** `crashWaitingOnChildren`
     leaves that column as-is (`state-transitions.ts:1458-1535`), so a run that
     was capacity-deferred before it crashed carries a stale stamp into
     `Crashed`. Restoring `WaitingOnChildren` without clearing it makes the flow
     continuation worker immediately try to re-wake the run.
  4. **The all-settled arm must pass `orchestratorResume`, never `crashResume`.**
     `isOrchestratorResume` (`runner-graph.ts:2298-2303`) requires
     `!isCrashResume`, so the two modes are mutually exclusive by construction;
     passing both silently selects the crash path and loses the coordinator's own
     session handle (`:3002-3006`). The parked attempt survives the crash as
     `NeedsInput` (neither crash transition closes attempts, A6), which is
     exactly what `resumingThisNode` needs to reuse it.

  **Reuse, do not re-derive (DRY).** "Are this orchestrator's children settled"
  already has one canonical predicate — `notInArray(runs.status,
  [...SETTLED_RUN_STATUSES])` — implemented identically in
  `countPendingChildren` (`runner-graph.ts:370-382`), `pendingChildCount`
  (`orchestrator-resume.ts:66-78`) and reconcile's `hasPendingChildren`
  (`reconcile.ts:791-807`). Call one of them; a fourth copy is how the three
  drift.
  **Known gap to record, not to fix here:** `promoteNextPending` has no
  `WaitingOnChildren` arm (its C3 candidate source is `NeedsInputIdle`-only,
  `scheduler.ts:708-715`), so a parked coordinator whose wake lost on capacity is
  re-driven only by the flow continuation worker. That predates this change.
  Second consequence, already covered by T0.1a(b): the route must not report
  `runStatus:"Running"` for a run it just parked as `WaitingOnChildren`.
  Verify: a dedicated case in the RED 1 lane — crash a coordinator mid-wait with
  one live child, Recover, and assert **zero** new child runs and zero new
  `session.prompt` commands for the coordinator node.
  Logging: `INFO [recover] orchestrator arm {runId, childrenTotal,
  childrenUnsettled, arm: "wait" | "resume" | "crash-resume"}`.

#### Two plan premises the code falsified during Phase 2 (recorded, not worked around)

1. **T2.3's mechanism does not carry the handle by itself.** The plan had the
   retained ACP handle riding the ADR-081 session policy because that resolution
   reads `latestAttemptForNode` — the node's own attempt row. It does, but
   `node_attempts.acp_session_id` is written ONCE at append and no create ack
   back-fills it, so a crashed attempt carries **null** and every crash-recover
   dispatch degraded to `session_fallback`. The policy seeding is kept (it is
   what makes an absent handle observable), and the `resume` resolution gains a
   fallback to the node's own LOGICAL `run_sessions` row — still node-scoped, so
   a substep can never be selected — narrowed to the crash-resume target so an
   ordinary rework re-entry keeps its existing behaviour.

2. **T2.4's "apply through the existing owner path" is not reachable after the
   claim.** `lockFlowPromptOwner` requires `runs.execution_assignment_id` to
   still BE the command's assignment, and Phase 1 has already minted the next
   epoch — so the live owner's only possible disposition is `superseded`, which
   is terminal and would destroy the evidence. What the eligibility table
   actually describes for a `Crashed` row is an **explicit generation handoff**,
   and `permission-resume.ts` is the existing precedent for its code shape:
   `readPromptOutput` + the SAME `decodeNodePromptCompletion` reducer, applied
   under the new generation. That is what shipped; no second reducer exists.
   Its consequence surfaced one more gap — `closeAppliedFlowPromptSession`
   had no arm for an applied completion whose command sits on a retired
   assignment without an `action_resume` permission witness, and refused with
   `permission_result_cleanup_authority`. The new arm's witness is the command's
   assignment no longer being `active` (NOT the incarnation's state, which stays
   non-terminal through exactly the window a recover runs in), and it decides
   only whether a `deleteSession` goes out.

<!-- Commit checkpoint C4: tasks T2.5-T2.7 -->

### Phase 3 — GREEN: make the intent recoverable, and fan the provenance out

Exit criteria: RED 4 green; suites green; every consumer class below has been
grepped and either updated or explicitly recorded as unaffected.

- [x] **T3.1 — Give the crash-recover intent an owner (Scope 6).**
  Files: `web/lib/reconcile.ts` (`classifyInner` `:379-390` and `:414-432`; the
  sweep dispatch `:1788-1815`).
  Two changes:
  (a) The `reattach` dispatch must stop being a bare `runFlow(cand.runId)`
  (A11). Pass `{db, executionHosts: hosts}` and, when `resume_started_at IS NOT
  NULL` with a non-null `current_step_id`, `{crashResume:{targetStepId:
  currentStepId}}` — which re-enters through the same single-winner CAS-clear
  (A20) rather than the "already owned" no-op (`runner-graph.ts:2277-2288`).
  (b) A `Running` run with a live idle session and no driver must be
  **classified**, logged and counted — never silently no-op'd. The sweep result
  type at `web/lib/reconcile.ts:460-463` already carries
  `{crashed, redispatched, reattached, skipped}`; extend it rather than logging
  into the void, and assert the new counter in the sweep integration suite so the
  classification is observable to an operator, not just to a log grep.
  **Progress / bounded-retry / poison policy** (skill-context rule): the
  re-entry is idempotent (the CAS-clear makes it single-winner and a loser
  no-ops), so no attempt counter is added; state in the spec that the bound is
  the existing grace window plus `crashRunningRun`, i.e. a run that cannot be
  re-entered returns to `Crashed` and stops, and say so rather than leaving it
  implicit.
  **Recovery predicate, named exactly** (skill-context): the state a web death
  after the Phase-1 CAS leaves is `status='Running'`, `resume_started_at IS NOT
  NULL`, `current_step_id` set, no open attempt for that node, no live session.
  Assert its reachability in RED 4 rather than asserting the sweep in isolation.
  Note A26: `startFlowContinuationWorker` cannot serve this state (its
  `node_attempts` arm needs an open `Running` attempt on the **active**
  assignment), so reconcile is the owner. Record that, so P0-2's continuation
  worker can adopt it later without re-deriving the reason.
  Logging: `INFO [reconcile] crash-recover re-entry {runId, targetStepId,
  assignmentId}`; `WARN [reconcile] running-with-idle-session {runId, sessionId}`
  plus the counter.

- [x] **T3.2 — Keep the cap-full path on the same door (Scope 5).**
  Files: `web/lib/scheduler.ts:583-600, :853, :1074`;
  `web/lib/runs/recover.ts:290-299`.
  The scheduler promotes a queued recover through `driveResume(id)` with **no
  `assignmentId`** (A28), relying on the `run.executionAssignmentId` fallback.
  Confirm the agent arm reaches T2.2's graph re-entry identically from that
  entry point, and that `isResume` still routes correctly now that the agent arm
  no longer creates its own session.
  **Branch shared dispatch on `run_kind` before routing** (skill-context rule):
  `driveResume` is shared; assert it is exhaustive and that a scratch or agent
  run can never enter the flow-only crash-resume arm. Add one test per
  discriminant arm — half-A-tested plus half-B-tested is not A∘B-tested.
  Logging: `INFO [scheduler] promoted crashed recover {runId, assignmentId,
  arm}`.

- [x] **T3.3 — Fan `decision='crash_recover'` out to every consumer.**
  Declare it as `CRASH_RECOVER_DECISION` in
  `web/lib/flows/graph/attempt-decisions.ts` — the pure module that exists
  precisely so the server-only writers and the pure counters share one
  definition. Never inline the literal.
  A `Reworked` attempt with a new `decision` value is a new-value fanout exactly
  like a new enum member, and A24 means the DB will **not** catch a missed
  consumer. The complete reader set, verified by grep:

  | Site | Change |
  | --- | --- |
  | `web/lib/flows/graph/rework-baseline.ts:33-40` | `operatorInterruptCount` becomes a count over a SET of excluded decisions (rename accordingly); `effectiveAttempts` already subtracts it. |
  | `web/lib/queries/observatory-core.ts:243-245` | the `retryCount` subtraction adds `crash_recover`. |
  | `web/lib/queries/observatory-core.ts:255-258` | the `reworkCount` filter excludes it too. **Both** counters move or the metric stays inflated — the file's own comment says so. |
  | `web/lib/flows/graph/ledger.ts:644-652` | re-export the new constant beside the other two. |
  | run-detail / timeline read model | render the new label (below). |

  **Do NOT add it to these** — they are operator-budget sites, and a crash is not
  an operator action: `web/lib/runs/node-interrupt.ts:584` and
  `web/lib/services/hitl.ts:5242` count attempts against
  `MAISTER_MAX_OPERATOR_RESTARTS`. A blanket "add it everywhere
  `OPERATOR_INTERRUPT_DECISION` appears" sweep would let crashes consume the
  operator's restart budget. State this in the spec so the next sweep does not
  undo it.
  Also confirm, do not assume, that the three `REVIEW_REWORK_CLAIM_DECISION`
  "active claim" readers (`web/lib/queries/run.ts:273`,
  `web/lib/workbench-lifecycle/service.ts:2119`,
  `web/app/api/runs/[runId]/rework-claim/release/route.ts:133`) select only OPEN
  attempt rows, so a closed `crash_recover` row can never be mistaken for a human
  claim.
  **Timeline label (owner decision 2026-09-18): render a distinct one.** This is
  more than two catalog strings — the rendering path is currently a three-way
  fallthrough that returns the RAW token for anything else:
  ```ts
  decisionLabel: (d) =>
    d === "approve" ? t("decisionApprove")
      : d === "rework" ? t("decisionRework")
        : d === "takeover" ? t("takeOver")
          : d,            // web/app/(app)/runs/[runId]/layout.tsx:865-871
  ```
  So the work is: extend `decisionLabel` to map the new decision, and add the key
  to **both** `web/messages/en.json` and `web/messages/ru.json` (the only two
  locales; parity is enforced by `web/lib/__tests__/i18n-parity.test.ts`).
  **Verified pre-existing gap, do not inherit it silently:** neither
  `operator_interrupt` nor `review_rework_claim` appears in either catalog, so
  those two provenance decisions render as untranslated snake_case in both
  locales today. Fixing them is a two-line follow-up, not this change's job —
  record it under Follow-ups rather than letting the new label sit beside two
  broken siblings unremarked.
  **Pick the RU wording deliberately.** "Reworked" already has three
  inconsistent RU renderings in the catalogs — `run.nodeStatus.Reworked`
  = "Доработано", `workbench.graph.node.Reworked` = "Переделано",
  `run.flowCenterReworked` = "На доработке". Do not add a fourth variant of the
  same idea; the crash-recover label should read as *recovery after a crash*,
  not as another synonym for rework.
  Verify: one test per counter asserting a `crash_recover` row does not move it,
  and one asserting it DOES still move the operator-restart budget by zero.
  Logging: none beyond the existing timeline events.

#### A third plan premise the code falsified (T3.1)

The plan put the whole of T3.1 in the sweep's **`reattach`** arm. That arm only
fires when a LIVE session exists, and the state a web death after the Phase-1
commit actually leaves has **no** live session — so `classifyRunReconcile` took
the `ai_coding` no-live-session branch and, past grace, **crashed the run again**,
discarding the operator's decision. RED 4 reproduced exactly that.

The committed intent therefore gets its own classifier arm — `recover`, ordered
AFTER the grace guard so a live dispatch is never raced — and the sweep hands it
to `driveResume` rather than re-implementing the evidence → close → dispatch
ordering a second time. The `reattach` change is kept for the live-session case
(A11) and now carries `{db, executionHosts}` plus the crash-resume signal.
`crashRecoverPending` is computed in the sweep, so the classifier stays pure.

Also confirmed rather than assumed (T3.3): all three `REVIEW_REWORK_CLAIM_DECISION`
"active claim" readers go through `getActiveTakeover`, which filters
`owner_user_id IS NOT NULL` and `ended_at IS NULL` — a closed `crash_recover` row
carries neither, so it can never be read as a human claim.

<!-- Commit checkpoint C5: tasks T3.1-T3.3 -->

### Phase 4 — Falsification, suites, as-built docs

Exit criteria: every new guard falsified, every suite green or explicitly
classified, docs re-verified against the code.

- [x] **T4.1 — Falsify every new guard.**
  For each of RED 1–4, revert the specific fix and confirm the test goes red
  **for the stated reason** — RED 1 must name `node_admission_generation`
  (revert T2.2 to `scheduleResumedSessionDrive`); RED 2 must show a second
  `session.prompt` (revert T2.4); RED 3 must resume the substep handle (revert
  T2.5); RED 4 must re-crash or no-op (revert T3.1).
  A test that passes against unfixed code is worse than none. Record each
  falsification's exact failure text in the plan.
  For RED 4's race half, name what would have collided: two concurrent recovers
  contend on the `resume_started_at` CAS; if the second click never allocates,
  the guard was not exercised — measure and repeat until misses are negligible.

- [x] **T4.2 — Run the named suites and classify every change.**
  Commands, as separate invocations:
  ```bash
  pnpm --filter maister-web typecheck && pnpm --filter maister-web exec eslint .
  ```
  ```bash
  pnpm --filter maister-web test:unit
  ```
  ```bash
  pnpm --filter maister-web test:integration
  ```
  Named suites that must stay green without loosened expectations:
  `web/lib/runs/__tests__/recover-classify.test.ts`,
  `recover-http.test.ts`, `recover-ui.test.ts`,
  `recover.integration.test.ts`,
  `web/lib/queries/__tests__/run-recoverable.test.ts`,
  `web/lib/__tests__/reconcile-sweep.integration.test.ts`,
  `reconcile-classify.test.ts`,
  `web/lib/flows/__tests__/crash-resume.integration.test.ts`,
  `web/lib/flows/graph/__tests__/{permission-resume,gate-permission-resume,prompt-owners}.integration.test.ts`,
  `web/lib/agents/__tests__/prompt-owners.integration.test.ts`,
  `web/lib/__tests__/scheduler-crash-promote.integration.test.ts`,
  `web/e2e/m19-reconcile-gc.spec.ts`.
  For every expectation that must change, state **obsolete** (the old behavior
  was the defect) or **broken** (the change regressed it) and resolve it in this
  increment — a red suite blocks the increment.
  Host conditions: run the long real-process lanes on a quiet machine, compare
  failure **sets** against `master` rather than counts, check `pmset -g log`
  before attributing any timeout to the code, and remember `pnpm lint` is
  `eslint --fix` and mutates the tree — check `git status` before staging.

- [x] **T4.2a — Conformance gate: implementation against spec.**
  This is a review pass with a written verdict, not a feeling. Produce an
  **AC conformance walk** in the plan: one row per AC, naming the test that
  proves it and the commit that made it green. An AC with no green test is an
  incomplete increment, not a "mostly done" one.
  Check each of the four conformance dimensions explicitly:
  - **Spec fidelity.** Every REQ is satisfied *as written*. Where the
    implementation chose a different mechanism than the REQ named, the REQ is
    **amended in the same commit** — a requirement that names a mechanism is
    either met literally or rewritten, never silently reinterpreted. Conversely,
    narrow the contract to what the code does rather than widening the code to
    match optimistic prose (`patches/2026-09-17-09.57.md`).
  - **SOLID.** The new crash-recover behavior enters through the existing
    `runFlow` / graph-driver seam rather than a parallel driver — that is the
    whole point of the fix. Watch for a new branch inside `driveResume` growing
    into a second dispatcher; if the agent arm and the redispatch arm end up
    sharing everything but a flag, collapse them.
  - **DRY.** Three named reuse obligations: the settled-children predicate
    (T2.7), the provenance constants in `attempt-decisions.ts` (T3.3), and the
    node-scoped session resolution used by all three call sites (T2.5). A second
    copy of any of them fails this gate.
  - **KISS.** The design deliberately adds no migration, no run status, no owner
    variant and no `action_resume` kind. If the implementation reached for one,
    stop and re-read "Attempt shape" — that is a signal the chosen shape was
    abandoned mid-flight, and the decision must be re-recorded, not drifted into.
  Also confirm project conventions: `MaisterError` with a typed `code` and never
  a plain `Error` for a domain failure; no `any` without `// FIXME(any):`; imports
  via the `@/` alias; comments explain WHY, never WHAT.
  Verify: the conformance walk is written, every row cites a test id, and
  `pnpm --filter maister-web typecheck` plus `eslint .` are clean.

- [x] **T4.3 — Documentation truth pass (as-built).**
  Re-read T0.2/T0.3/T0.4's artifacts against the shipped code and flip every
  **Designed** tag to **Implemented** only where the code matches. Re-verify the
  component responsibilities and the manager↔host sequence diagrams in
  `docs/architecture.md`, and the `docs/system-analytics/README.md` index.
  Confirm the OpenAPI `recoverRun` table now describes both arms truthfully.
  Verify: `pnpm validate:docs` (which already runs the ADR-anchor, link, index
  and `db:erd --check` gates — the last expected to be a no-op, since this plan
  changes no schema) and `pnpm validate:contracts`.

- [x] **T4.4 — Retire the obsolete memory note and the ADR renumber pass.**
  The note "Recovery has three doors, only node interrupt opens a dead node"
  (`diagnosing-maister-stand-failures`) becomes false once this lands — update
  it to say Recover now re-enters the graph, and keep the node-interrupt entry
  for the in-grace window (`web/lib/runs/node-interrupt.ts:194-199` still
  requires `runs.status === "Running"`).
  Re-check `master` HEAD for ADR-175 collisions after rebasing and renumber if a
  parallel branch took it; grep prose forms (`pre-175`, `since 175`).

#### T4.1 falsification record (2026-09-18)

Each fix reverted in isolation against the otherwise-complete branch, the test
re-run, the tree restored. Every one went red **for its stated reason**.

| Guard reverted | Test | Verbatim failure | Stated reason met? |
| --- | --- | --- | --- |
| T2.2 — the agent arm answers `resumed` without entering the graph (what the pre-ADR-175 path amounted to once admission refused its prompt) | RED 1 | `Matcher did not succeed in 60000ms` / `expected +0 to be 1` — **zero** `session.prompt` rows under the run's current assignment | yes: the discriminating observable is the absent prompt under the new epoch |
| T2.4 — `applyCrashedTurnEvidence` forced to `"absent"` | RED 2 | `expected [ … ] to have a length of 1 but got 2` | yes: a **second** `session.prompt` — the paid duplicate turn |
| T2.5 — `resolveNodeResumeSessionId` reads `loadActiveRunSession` again | RED 3 | `resumeSessionId` expected `mock-e672d77c-…`, received `acp-substep-8518b6f0-…` | yes: the finished substep's handle |
| T3.1 — the sweep's `recover` classifier arm disabled | RED 4 | `expected +0 to be 1` on `crashRecoverReentered`, with `run-state … from "Running" to "Crashed" reason "agent-session-gone"` twice in the log | yes: re-crashed, exactly A12 |

**RED 1's fuller falsification is the `83bce7bb` run itself** — that commit IS
"T2.2 not applied", and its log carries the whole chain the defect is made of:
`run-resume-driver {"code":"CONFLICT","reason":"prompt_owner_invariant"}
"driver yielded to durable prompt owner"` → `reconcile: reattached (live-session)`
→ `driver-yielded … {"reason":"assignment_fenced"}`. The `causeCode` at that seam
is `node_admission_generation` (`node-prompt-owner.ts:107`); the runner's
top-level error log now carries `details`, so that code is visible in the log
rather than only derivable from the source.

**RED 4's race half, measured rather than assumed.** What contends is the
Phase-1 status CAS (`WHERE status='Crashed'`), not the graph's `resume_started_at`
CAS-clear — two different guards, and only the first is reachable from two
concurrent `POST /recover` calls. It cannot silently fail to allocate: Phase 1
opens with `takeSchedulerLock`, so the loser BLOCKS on the advisory lock rather
than finishing before the winner starts, and its `conflict` result is produced
only INSIDE that transaction, after the lock, by the status guard or a
zero-row CAS. A `conflict` outcome is therefore itself proof the second click
allocated. Measured 5/5 on the concurrent case
(`recover.integration.test.ts` → `two concurrent recovers`): every run split
`["conflict","resumed"]` with exactly ONE dispatch. Misses: 0/5.

#### T4.2 suite record — the full integration lane, classified (2026-09-18)

`pnpm --filter maister-web test:integration`: **6 failed / 4282 passed**, 486 of
491 files. Compared as a failure SET against `master` (`83bce7bb`, measured in
the main checkout on this same host), never as a count.

| Failure | Classification | How it was established |
| --- | --- | --- |
| `project pull with real Git > rejects an unavailable origin…` | **pre-existing on master** | ran on the master checkout: identical assertion text |
| `…/projects/[slug]/remotes > POST pull…` | **pre-existing on master** | same run: `expected 409 to be 503` |
| `runReconcileSweep > reattaches a live Running Flow…` | **mine — obsolete expectation, fixed** | the reattach arm now passes a second argument; the case asserts `(attached, undefined)`, pinning that a run with NO committed intent still takes the ordinary continuation |
| `runReconcileSweep > skips the whole tick (zeroed summary)…` | **mine — obsolete expectation, fixed** | the summary gained two counters; both added to the `toEqual` |
| `owner-agent-budget 'terminate_restorable' … 'before_application'` | **lane load** | passes idle in **49 s** against its own 75 s budget; the diff touches nothing under `web/lib/agents`, and nothing agent-side calls `driveResume`, so the new `run_kind` guard cannot reach it |
| `owner-flow-crash-recover: a crashed agent node recovers…` | **my test's budget, fixed** | passed idle in **63 s** against a **60 s** poll budget — the BUDGET was failing, not the behaviour. Raised to 150 s (and the case timeout to 420 s) with the assertion untouched |

**The two pre-existing failures have a proven mechanism, not just a matching
name.** `classifyGitError` (`web/lib/repo-source.ts:138`) string-matches ENGLISH
git stderr; git on this host emits Russian, so every branch falls through to
`UNKNOWN` and `pullRemote` answers `CONFLICT` (409) where the test expects
`EXECUTOR_UNAVAILABLE` (503). Reproduced outside the suite entirely:
`git pull /tmp/definitely-missing.git main` prints
`fatal: Не удалось прочитать из внешнего репозитория.` — exactly the string the
classifier seeks as `could not read from remote repository`. `NETWORK_GIT_ENV`
sets `GIT_TERMINAL_PROMPT` and `GIT_SSH_COMMAND` but no `LC_ALL=C`. Introduced by
`4db75d76`, merged as `2c778fb5`. A real defect on any non-English host, out of
this change's scope — recorded under Follow-ups.

**A seventh defect the lane hid, found by re-running the family.** With the host
idle, `owner-flow-crash-recover: …resumes the node's own handle` failed roughly
one family run in three at the 30 s live-session poll, while passing every time
it ran alone. Cause: `crashAgentRunMidTurn` killed adapters **once**, so a
`pgrep` that raced the adapter's appearance in the process table never retried.
The kill is now re-issued on every poll iteration. Measured 3/3 green after the
fix; falsified against the one-shot form below.

Host conditions, recorded: the lane ran at load 6–23 on 16 cores against a
competing worktree. `pmset -g log` was not implicated — no sleep window overlaps
the run. `pnpm lint` is `eslint --fix` and mutates the tree; `git status` was
checked before every stage, and `eslint .` sits at the documented 14-warning
baseline.

#### T4.2a AC conformance walk (2026-09-18)

One row per AC, the test that proves it, and the commit that made it green.
`C1` = `0862bf2a` (docs freeze) · `C2` = `e5641d98` (RED) · `P2` = `22f3b731`
(Phase 2) · `P3` = `7678d2c0` (Phase 3).

| AC | Primary test | Green at | Note |
| --- | --- | --- | --- |
| **AC-01** | `owner-flow-crash-recover: a crashed agent node recovers to a terminal state…` | P2 | asserts the prompt under the NEW assignment first, then `Review`, then the closed attempt |
| **AC-02** | `…agreeing terminal evidence is applied with no second prompt` | P2 | one prompt for the run, `applied` + `completion_applied_at`, and the `after` node's side effect on disk |
| **AC-03** | `…resumes the node's own handle, never a substep's` | P2 | pins the hazard first (`loadActiveRunSession` returns the substep), then the dispatched `resumeSessionId` |
| **AC-04** | `…the committed intent recovers without a second click…` | **P3** | needed T3.1; also asserts `crashRecoverReentered === 1` and `crashed === 0` |
| **AC-05** | `recover-classify.test.ts` agent-kind table | P2 | `judge` moved into the agent describe block, out of the session-less list |
| **AC-06** | `run-recoverable.test.ts` → `a crashed judge with a retained handle is recoverable` | P2 | the UI affordance follows the classifier by construction |
| **AC-07** | `owner-flow-crash-recover: a coordinator crashed mid-wait…` | P2 | zero new children, zero new coordinator prompts, `WaitingOnChildren` with `resume_requested_at` cleared, and the HTTP body checked through `recoverHttpResponse` |
| **AC-08** | `operator-restart-budget.test.ts` + `observatory-operator-restarts.test.ts`, both `T-CR8` | P3 | both counters and the rework epoch; the operator budget is asserted unchanged by the sibling `operator_interrupt` cases the same files already hold |
| **AC-09** | `…committed intent…` (`crashRecoverReentered`) | P3 | the counter is asserted, not just logged |
| **AC-10** | `recover.integration.test.ts` → queued-resume + `it.each(["scratch","agent"])` | P2 | one case per discriminant arm |
| **AC-11** | `recover-http.test.ts` → `reports the committed run status` | P2 | plus the parametrised success table |
| **AC-12** | `i18n-parity.test.ts` + the `decisionLabel` arm | P3 | EN/RU parity enforced; the label maps rather than falling through |
| **AC-13** | folded into AC-03's precondition assertion | P2 | the ranking hazard is demonstrated in the same case that depends on it, rather than in a separate suite — one primary test per AC, no duplicate |
| **AC-14** | `pnpm validate:docs` (`db:erd --check`) + `_journal.json` untouched in the final diff | C1→P3 | zero migrations, as the DB contract predicted |

**Four dimensions, checked explicitly.**

- **Spec fidelity.** Every REQ is satisfied as written except the four marked
  ⟲ in the spec, each **amended in the same increment** with the evidence that
  falsified it — never silently reinterpreted. The contract was narrowed to what
  the code does (REQ-05/06 name the handoff the code performs, not the owner path
  it cannot use), never widened to match optimistic prose — the trap
  `patches/2026-09-17-09.57.md` records. One REQ was ADDED (REQ-07a) because the
  implementation surfaced a rule the freeze had not anticipated.
- **SOLID.** The crash-recover behaviour enters through the existing `runFlow` /
  graph-driver seam; no parallel driver exists. The one place a second dispatcher
  could have grown — the sweep — hands the run to `driveResume` instead of
  re-implementing its ordering. `driveResume`'s agent and redispatch arms are
  NOT "the same but for a flag": the agent arm owns evidence, the attempt close
  and the orchestrator branch, none of which the redispatch arm has.
- **DRY.** All three reuse obligations hold: the settled-children predicate is
  the existing `SETTLED_RUN_STATUSES` `notInArray` (no fourth copy); the
  provenance constants live once in `attempt-decisions.ts` and are consumed as a
  SET; the node-scoped session resolution is one function
  (`resolveNodeResumeSessionId`) used by all four readers — Phase-1 classify,
  `driveResume`, `isRunRecoverable`, and the scheduler's queued promotion — plus
  the graph's crash-resume dispatch.
- **KISS.** Zero migrations, zero new run statuses, zero new owner variants, zero
  new `action_resume` kinds, and the `RecoverResult` union still has eight arms.
  Nothing reached for one mid-flight.

Conventions confirmed: every domain failure is a typed `MaisterError`
(`PromptOwnerHandoffLost` carries `CONFLICT` + a `details.reason`); no new `any`
without a `FIXME(any):` (the two new modules reuse the file-local
dual-peer-dep cast the surrounding code already uses, with that comment);
imports go through `@/`; comments explain WHY.

<!-- Commit checkpoint C6: tasks T4.1-T4.4 (incl. T4.2a) -->

---

## Out of scope (explicitly not touched)

- Scratch recover (`web/lib/scratch-runs/recovery.ts`) and standalone agent-run
  recover — diagnosis item A4. This plan must not depend on them and must not
  block them.
- P0-2 durable worker activation. T3.1's recovery predicate is written so the
  continuation worker can adopt it later (A26 records why it cannot today).
- P1-5, making `classifyRunReconcile` consult command evidence before writing
  `agent-session-gone`. T2.4 consults evidence at **recover** time only.
- HITL UI, outbox pressure, consensus internals.

## Owner decisions (2026-09-18) — settled, do not relitigate

1. **`judge` joins the recover classifier's agent set.** → T2.6. Observable
   behavior change; both docs decision tables and the pure classifier test move
   with it.
2. **The crashed waiting orchestrator is fixed here, not deferred.** → T2.7.
3. **Attempt shape: Option A, a fresh attempt row.** Rationale and the full
   option table are in "Attempt shape" above; the deciding argument is the
   `UNIQUE(node_attempt_id, model)` cost rollup.
4. **RED 1–4 extend `prompt-owners.integration.test.ts`**, family
   `owner-flow-crash-recover`.
5. **The timeline gets a distinct `crash_recover` label**, EN + RU.

## Follow-ups this plan creates

- **`session_fallback` is now reachable on a path that should rarely take it.**
  The crash-resume dispatch resolves its handle from the node's attempt row and
  then the node's logical session; when a node runs in a NAMED session whose
  `run_sessions` row was never created, both miss and the dispatch degrades to a
  fresh session. Correct, observable, and not a defect — but worth a metric
  before crash-recover is ever automated.
- **`node_attempts.acp_session_id` is write-once at append and nothing
  back-fills it.** `applyCreateAck` stamps the attempt's `execution_assignment_id`
  but not its handle, so the column is null for every attempt whose session was
  created after the row. Several readers treat it as the node's handle (it is
  where ADR-081's `resume` policy looks first). Either back-fill it in the create
  ack or delete the column's implied meaning; leaving it half-true is what cost
  this change a falsified premise.

- **Untranslated provenance decisions.** `operator_interrupt` and
  `review_rework_claim` render as raw snake_case in both locales, because
  `decisionLabel` only maps approve/rework/takeover. Two keys per locale plus two
  map arms. Found while planning T3.3; not this change's scope.
- **`Reworked` has three different RU renderings** across the catalogs. Worth one
  consolidation pass.
- **No observable recovery signal.** The recover path emits nothing on the
  `Crashed → Running` flip, so no consumer can distinguish a recovered run from
  one that never crashed. Adding `run.recovered` is a six-file change plus a
  `domain_events_kind_check` migration — a deliberate non-goal here (T0.1a).
- **`ExtPulseEventKind` is already stale** — 13 listed against 15 in
  `DOMAIN_EVENT_KINDS` (missing `run.review_opened` and `run.needs_input`), and
  `docs/system-analytics/domain-events.md:41-46` still says "exactly 13 kinds".
  Pre-existing; unrelated to recover but found by the same sweep.
- **`reconciliation-gc.md` carries 19 Expectations bullets against the
  documented R5a cap of 12.** R5a's own remedy is to split the domain. Unenforced
  by the gate, so it is debt rather than a blocker.

- Whether a crash-recover re-entry should carry its own per-run bound, the way
  operator restarts are bounded by `MAISTER_MAX_OPERATOR_RESTARTS`. T3.3
  deliberately keeps crashes **out** of that budget, which leaves a crash-loop
  bounded only by the grace window and `crashRunningRun`. Not a defect today,
  because each re-entry needs an explicit operator or token decision; it becomes
  one if crash-recover is ever automated. Record it in the ADR rather than
  inventing an env var now.
- T2.6 widens `judge` on the recover path only. **Confirmed during T3.1 and
  written down** (`reconciliation-gc.md`, the note under the classifier table):
  the reconcile sweep still classifies a session-less `judge` as
  `gate-redispatch`, and the divergence is intentional — the sweep acts with no
  operator decision, and the rule it enforces is that the reconciler may never
  resume a mid-turn agent implicitly. A caller POSTing recover has made that
  decision explicitly. The two paths stay different on purpose.

## Открытые вопросы

Нет — все пять вопросов закрыты решениями выше.
