# Crashed-agent recovery routing — Operator Recover re-enters the graph (ADR-175)

Status: **Designed.** Every `REQ-*` below is normative; every `AC-*` names one
primary test and its lane. Tags flip to **Implemented** only in Phase 4 (T4.3),
and only where the shipped code matches the sentence.
Date: 2026-09-18
Branch: `claude/crashed-agent-recovery-routing-dc28b6`
Baseline: `83bce7bb` (identical ADR/migration heads to `master`).

## Purpose

Operator Recover on a **crashed agent node** does not recover the run. It
re-creates an ACP session and hands it to the NeedsInput permission driver
(`scheduleResumedSessionDrive`), which has no durable continuation to resume:
both of its `runFlow` shortcuts evaluate false for a crashed run, so it issues a
node prompt that `admitNodePrompt` refuses with
`PromptOwnerInvariantError("node_admission_generation")` — the crashed attempt
is still bound to the **retired** assignment epoch. The driver treats that
refusal as a yield and returns before every terminal decision, leaving the run
`Running` with a fresh **idle** session nobody drives. The reconcile sweep then
either re-attaches it with a bare `runFlow(runId)` that no-ops, or crashes it
again as `agent-session-gone` — a loop the operator can only exit by discarding
the run.

This spec freezes the contract for routing that arm through the **same door the
`redispatch` arm already uses**: the graph, entered by
`runFlow(runId, {crashResume:{targetStepId}})`. No new driver, no new run
status, no new owner variant, no migration.

## Scope source

Owner brief P0-1 of the execution-seam diagnosis (2026-09-18), supplied as chat
text, plus owner decisions 1–5 recorded in the plan. Durable record: this spec +
[ADR-175](../../docs/decisions.md) +
[`docs/system-analytics/reconciliation-gc.md`](../../docs/system-analytics/reconciliation-gc.md)
+ [`docs/system-analytics/execution-prompt-lifecycle.md`](../../docs/system-analytics/execution-prompt-lifecycle.md)
+ the plan
[`../plans/claude-crashed-agent-recovery-routing-dc28b6.md`](../plans/claude-crashed-agent-recovery-routing-dc28b6.md).

## Verified baseline (read before implementing)

The plan's "Verified anchors" table **A1–A30** is the normative baseline for
this spec and is not duplicated row-for-row here. Three of its rows **correct
the request brief** and therefore change what the fix must do; they are
restated in full because a reader who trusts the brief will build the wrong
thing.

| ⚠ | Brief said | Verified fact | Evidence |
| --- | --- | --- | --- |
| **C1** | the recover classifier's agent set is `ai_coding \| judge \| orchestrator` | It is `ai_coding \| orchestrator` only. `judge` falls through to `retrySafe ? "redispatch" : "discard-only"`. The brief describes `admitNodePrompt`'s agent set, not the classifier's. | `web/lib/runs/recover-classify.ts:41-44` vs `web/lib/flows/graph/node-prompt-owner.ts:89-107` |
| **C2** | a finished substep session always outranks the node's own | `loadActiveRunSession` now ranks on **three** keys — live incarnation DESC, `acp_session_id IS NOT NULL` DESC, `updated_at` DESC. The substep hazard is fixed **for a live run**. After a crash every incarnation is terminal, so key 1 ties false for every row and keys 2–3 still decide: the hazard survives **for the crashed case only**, which is exactly the case Recover reads. | `web/lib/runs/active-run-session.ts:53-76` |
| **C3** | the crashed run's assignment is `superseded` | It is **`released`** — `crashRunningRun` calls `releaseAssignmentForRun(tx, runId, "crashed")`, and `mintAssignment` supersedes only an `active` row, so Phase 1 mints epoch N+1 beside a `released` N. The consequence the brief drew (the crashed attempt is bound to a non-current assignment) is unchanged. | `web/lib/runs/state-transitions.ts:1402`, `web/lib/execution-host/assignments.ts:167-175, :240-271` |

Five further anchors shape the contract most and are restated for the same
reason:

- `crashRunningRun` touches **no `node_attempts` row** — it writes `runs`,
  closes `hitl_requests`, releases the assignment. The crashed attempt stays
  open, `Running`, on the retired epoch (`state-transitions.ts:1343-1447`).
- `resumingThisNode` is **false** for a crashed attempt, so the graph appends a
  **fresh** attempt stamped with the new epoch — which is what makes the fence
  pass by construction rather than by relaxation
  (`runner-graph.ts:2866-2876, :3013-3042`).
- The prompt logical-operation key is
  `flow_node_attempt:<variant>:<nodeAttemptId>:<promptOrdinal>` and is unique
  per run, so a fresh attempt id avoids `command_invariant_conflict` by
  construction (`node-prompt-owner.ts:58-60`, `ledger.ts:341-381`).
- The crash-resume claim is a bare CAS-clear of `runs.resume_started_at`, and
  Phase 1 is its only writer on this path — so it is single-winner across
  recover and scheduler-promote (`runner-graph.ts:2398-2422`, `recover.ts:221-255`).
- `node_attempts.decision` is plain `text(...)` with **no CHECK**
  (`schema.ts:5327`); `node_attempts_action_resume_check` **does** whitelist
  exactly four `action_resume` kinds (`schema.ts:5442`). The design rides the
  former and deliberately avoids the latter.

---

## Requirements

RFC-2119 phrasing. Every REQ names the function or route that enforces it.

### Scope 1 — the crashed agent arm re-enters the graph

| ID | Requirement (normative) |
| --- | --- |
| **REQ-01** | `driveResume`'s `resume-agent` plan MUST re-enter the graph via `runFlow(runId, {crashResume:{targetStepId}, db, executionHosts})` and MUST NOT call `client.createSession({resumeSessionId})` or `scheduleResumedSessionDrive`. The `redispatch` arm MUST pass `db` and `executionHosts` for the same reason: without them `runFlow` binds a fresh local host over `getDb()` instead of the caller's handle and the minted assignment. |
| **REQ-02** | Before that dispatch, `driveResume` MUST close every **open, `Running`** `node_attempts` row of the recover-target node with `status='Reworked'`, `ended_at=now()`, `decision='crash_recover'`, in its own transaction, **after** the REQ-04 evidence decision and **before** `runFlow`. The close MUST be a CAS guarded on `status='Running' AND ended_at IS NULL` and MUST report whether it applied. The `Running` guard is load-bearing: it is what keeps a parked orchestrator's `NeedsInput` attempt invisible to this close (REQ-17). |
| **REQ-03** | The re-dispatch MUST satisfy `admitNodePrompt` **by construction**, never by relaxing it: the graph appends a fresh `node_attempts` row stamped with the new assignment epoch and `applyCreateAck` re-binds it, so `node_admission_generation` cannot fire. No fence, guard or invariant in `node-prompt-owner.ts` may be widened by this change. |
| **REQ-04** | `driveResume` MUST NOT touch `hitl_requests`. `crashRunningRun` already closed them, and the resumed prompt may raise a NEW permission needing its own row. |

### Scope 2 — evidence before dispatch

| ID | Requirement (normative) |
| --- | --- |
| **REQ-05** | The FIRST step of the agent arm MUST reconcile the crashed attempt's last `session.prompt` through the existing `executionCommandReconcilePass` / `startPromptOwnerWorker` path, **outside every DB transaction** (it performs host I/O). It MUST NOT introduce a second terminal writer. |
| **REQ-06** | When that command carries agreeing terminal evidence the owner has not applied, the evidence MUST be applied through the existing owner path and the graph continued with `runFlow(runId, {db, executionHosts})` and **no** new `session.prompt`. When evidence is absent or disagrees — including a quarantined disagreement — the arm MUST fall through to REQ-02 + REQ-01 unchanged. A quarantined disagreement MUST NOT be converted into a re-prompt. |
| **REQ-07** | Applying that evidence MUST re-bind the applied attempt's `execution_assignment_id` to the new epoch inside the application transaction, mirroring what `applyCreateAck` does for a fresh dispatch. The `staleSessionBinding` guard at `runner-graph.ts:2880-2889` MUST keep its current meaning and MUST NOT gain a crash-recover exemption. |

### Scope 3 — session identity

| ID | Requirement (normative) |
| --- | --- |
| **REQ-08** | Every recover-path read of the resume handle MUST be **node-scoped**: the recover-target node's own `node_attempts.acp_session_id`, falling back to its logical `run_sessions` row selected by `node.session ?? "default"`. `loadActiveRunSession` MUST NOT be the source on this path, because for a crashed run every incarnation is terminal and a finished `gate-*` / `*-verify-*` row can win on `updated_at` (baseline C2). |
| **REQ-09** | The node-scoped resolution MUST be a single shared function used by **all three** call sites: `resumeCrashedRun` Phase 1, `driveResume`, and `isRunRecoverable` (`web/lib/queries/run.ts`). A second copy is a defect: the UI affordance and the route would drift. |
| **REQ-10** | `web/lib/scheduler.ts`'s queued-recover promotion MUST take the same node-scoped resolution when deriving `isResume`, or the cap-full path resumes a gate's context while the direct path resumes the node's. |
| **REQ-11** | `acp_session_id` MUST stay server-side. No recover DTO may carry it. |

### Scope 4 — durable authorization

| ID | Requirement (normative) |
| --- | --- |
| **REQ-12** | The durable authorization MUST remain the existing Phase-1 transaction — `takeSchedulerLock` → `SELECT … FOR UPDATE` → CAS `Crashed → Running\|Pending` writing `resume_started_at` and `current_step_id` → `mintPlacement(reason:"recover")` — committed **before** any supervisor call. No part of it moves into `driveResume`. |
| **REQ-13** | A web death after that commit and before the dispatch MUST be recoverable with **no second operator click**. The recovery predicate is exactly: `runs.status='Running'` AND `resume_started_at IS NOT NULL` AND `current_step_id` non-null AND no live session. `startFlowContinuationWorker` cannot serve it (its `node_attempts` arm requires an open `Running` attempt on the **active** assignment), so the reconcile sweep MUST own it. |
| **REQ-14** | The single-winner guard MUST remain the `resume_started_at` CAS-clear in `runGraph`. A concurrent second `POST /recover` MUST answer `409 CONFLICT`. No attempt counter or retry budget is added: the re-entry is idempotent (the loser no-ops), and the bound is the existing grace window plus `crashRunningRun` — a run that cannot be re-entered returns to `Crashed` and stops. |

### Scope 5 — the cap-full path

| ID | Requirement (normative) |
| --- | --- |
| **REQ-15** | A queued recover promoted by the scheduler MUST reach REQ-01's graph re-entry identically, through `driveResume(id)` with no `assignmentId` and the `run.executionAssignmentId` fallback. |
| **REQ-16** | `driveResume` is shared across run kinds; it MUST branch on `runs.run_kind` before routing, and a `scratch` or `agent` run MUST NEVER enter the flow-only crash-resume arm. The discriminant MUST be exhaustive and MUST have one test per arm. |

### Scope 6 — no silent no-op

| ID | Requirement (normative) |
| --- | --- |
| **REQ-17** | The reconcile sweep's `reattach` dispatch MUST pass `{db, executionHosts}` and, when the run carries `resume_started_at IS NOT NULL` with a non-null `current_step_id`, MUST pass `{crashResume:{targetStepId: currentStepId}}` so the re-entry goes through the single-winner CAS-clear instead of the already-owned no-op. |
| **REQ-18** | A `Running` run holding a live **idle** session with no driver MUST be classified, logged and **counted** in `ReconcileSweepSummary` — never silently skipped. The counter MUST be asserted by a test, so the classification is observable to an operator rather than only to a log grep. |

### Scope 7 — provenance and accounting

| ID | Requirement (normative) |
| --- | --- |
| **REQ-19** | `crash_recover` MUST be declared once, as `CRASH_RECOVER_DECISION` in `web/lib/flows/graph/attempt-decisions.ts`, and re-exported from `web/lib/flows/graph/ledger.ts` beside the other two. The literal MUST NOT be inlined anywhere. |
| **REQ-20** | A `crash_recover` attempt MUST be excluded from the `rework.maxLoops` effective count **and** from **both** Observatory correction counters (`retryCount`'s `max(attempt) - 1` subtraction and `reworkCount`'s `Reworked` filter). Moving only one leaves the metric inflated. |
| **REQ-21** | A `crash_recover` attempt MUST NOT consume the operator-restart budget (`MAISTER_MAX_OPERATOR_RESTARTS`, counted in `web/lib/runs/node-interrupt.ts` and `web/lib/services/hitl.ts`). A crash is not an operator action. |
| **REQ-22** | The run timeline MUST render a distinct label for `crash_recover` in **both** locales; `decisionLabel` MUST map it rather than falling through to the raw token. |

### Cross-cutting

| ID | Requirement (normative) |
| --- | --- |
| **REQ-23** | `classifyRecover` MUST route `judge` to `resume-agent` alongside `ai_coding` and `orchestrator`. Both published decision tables (`web.openapi.yaml`'s `recoverRun` description and `reconciliation-gc.md`) MUST move `judge` out of the session-less row in the same commit. |
| **REQ-24** | A crashed `orchestrator` MUST branch on its children, resolved from server state through the **existing** settled-children predicate: any child unsettled ⇒ do NOT dispatch, restore `WaitingOnChildren`, clear `resume_requested_at`, and release the slot through the existing non-transactional `releaseSlotOnIdle`; all children settled ⇒ re-enter via `{orchestratorResume:{targetStepId}}`, never `crashResume`; no children ever created ⇒ the ordinary crash-resume path. `markWaitingOnChildren` MUST NOT be called — it is dead code writing a different column set than the live park. |
| **REQ-25** | The success body's `runStatus` MUST reflect the **committed run row**, not a constant derived from the result state. A recover that hands a run back as `WaitingOnChildren` MUST NOT report `Running`. |
| **REQ-26** | Neither recover route may gain a path, a method, or a request body field. Both keep an EMPTY body and the shared `recoverHttpResponse` projection. |
| **REQ-27** | This change MUST ship **zero** migrations. `web/lib/db/migrations/meta/_journal.json` MUST be untouched and `pnpm --filter maister-web db:erd --check` MUST be a no-op. |

### Scope → requirement map (no unmapped scope)

| Scope item | Requirements |
| --- | --- |
| 1 — the agent arm re-enters the graph | REQ-01, REQ-02, REQ-03, REQ-04 |
| 2 — evidence before a second paid turn | REQ-05, REQ-06, REQ-07 |
| 3 — session identity | REQ-08, REQ-09, REQ-10, REQ-11 |
| 4 — durable authorization | REQ-12, REQ-13, REQ-14 |
| 5 — the cap-full path | REQ-15, REQ-16 |
| 6 — no silent no-op | REQ-17, REQ-18 |
| 7 — provenance and accounting | REQ-19, REQ-20, REQ-21, REQ-22 |
| owner decisions 1, 2, 5 | REQ-23, REQ-24, REQ-22 |
| contract hygiene | REQ-25, REQ-26, REQ-27 |

---

## API contract

**No new path. No new method. Both bodies stay EMPTY.** The contract is
published in **four** places that can disagree, and all four move together:

| Surface | File | What changes |
| --- | --- | --- |
| internal OpenAPI | `docs/api/web.openapi.yaml` (`recoverRun`) | `judge` moves to the agent row of the description's decision table; a `404` response is declared; `RecoverQueuedResponse` is aligned to its correct runtime body; the `409` description names `PRECONDITION` as well as `CONFLICT`; `runStatus` is documented as the committed status |
| ext OpenAPI | `docs/api/external/operations.openapi.yaml` (`extRecoverRun`) | same decision-table move; `details.reason` discriminator documented |
| MCP facade | `mcp/src/tools.ts` (`run_recover`) | the prose decision table moves `judge`; the `{ok, state, runStatus}` shape statement stays true |
| EN/RU catalogs | `web/messages/{en,ru}.json` | the new `crash_recover` timeline label (REQ-22) |

`mcp/src/__tests__/tool-contract.test.ts` binds the MCP tools to the ext paths,
so an ext-route parameter change trips it.

⚠ **`pnpm validate:contracts` is NOT evidence of contract correctness here.** It
runs the OpenAPI/AsyncAPI meta-schemas and resolves `$ref`s; it does not check
examples, `operationId`s, response-code completeness, or anything
recover-specific. Real enforcement is the MCP tool-contract test and the route
integration suites. Treat green as a syntax gate only.

### Derived-`runStatus` hole (REQ-25)

`runStatusForState` derives the success body's `runStatus` from the result
state, never from the DB. REQ-24's orchestrator wait arm hands the run back
while leaving it `WaitingOnChildren`, so the current projection would publish
`200 {state:"resumed", runStatus:"Running"}` — a status the run does not have.

**Resolution: make `runStatus` reflect the committed row.** `RecoverResult`'s
`resumed` arm carries an optional `runStatus`; `recoverHttpResponse` takes the
result rather than the bare state and honours it, defaulting to `"Running"`.
The union stays at **eight** arms — no new state is added, so the two
exhaustive switches in `recover-http.ts` keep their compile-time safety net.
`recover-ui.ts` is untouched: it keys on HTTP status alone.

### Three verified spec-vs-code drifts fixed in the path objects being edited

| Drift | Verified fact | Fix |
| --- | --- | --- |
| no `404` declared on the internal recover path | the route returns `404 {code:"PRECONDITION"}` for an unknown run (`app/api/runs/[runId]/recover/route.ts:86-89`) | declare it |
| `RecoverQueuedResponse` is stale | it declares `{state, queuePosition?}` with no `ok` and no `runStatus`; the runtime body is `{ok:true, state:"queued", runStatus:"Pending"}` and `queuePosition` is never emitted | align it to the correct ext twin `ExtRecoverAccepted` |
| the `409` description names only `CONFLICT` | `workspace-removed` returns `PRECONDITION`; the ext spec already documents both | name both |

### Machine-distinguishable 409s

`discard-only`, `conflict` and `workspace-removed` all answer 409, and the first
two share `CONFLICT`, so an automated caller cannot tell "retry later" from
"this run is unrecoverable". `runs:recover` is explicitly an operator/CI scope
backing an MCP tool, so the three MUST become distinguishable through the
sanctioned `details.reason` discriminator (`MaisterErrorBody.details` is
`additionalProperties: true`; the web-minted registry is at
`docs/error-taxonomy.md`). Reasons: `discard_only`, `recover_cas_lost`,
`workspace_removed`. The UI is unaffected — it branches on `code`.

### Error-taxonomy status tags

Three of the four recover rows in `docs/error-taxonomy.md` (`CONFLICT`,
`EXECUTOR_UNAVAILABLE`, `CHECKPOINT`) still read **(Designed)** while the code
and OpenAPI are Implemented, and the `PRECONDITION` row omits recover's
`workspace-removed` 409 entirely. Both are corrected here.

### Identifier trust (unchanged, re-asserted)

| Identifier | Source | Body-controlled? |
| --- | --- | --- |
| `runId` | `url-param` | no |
| `userId` / token principal | `auth-context` | no |
| `projectId` | `server-state` (`runs.project_id`) | no |
| recover-target node | `server-state` (`runs.resume_target_step_id` ?? `current_step_id`) | no |
| `acp_session_id` | `server-state` (node-scoped, REQ-08) | no — never leaves the server |
| runner snapshot | `server-state` | no |

**Body stays EMPTY on both surfaces.** No field this change adds is reachable
from a request body.

### Explicit non-goal, recorded so it is not re-litigated

The recover path emits **no** webhook, domain event or SSE frame on the
`Crashed → Running` flip, so the webhook plane cannot distinguish "recovered
into Review" from "ran straight to Review". Adding an observable recovery signal
would mean a new enum member in `outbound-webhooks.asyncapi.yaml`,
`web/lib/webhooks/taxonomy.ts`, `web/lib/domain-events/taxonomy.ts`, the
`ExtPulseEventKind` mirror, the exhaustive `mapDomainEvent` switch **and** a
`domain_events_kind_check` migration. Out of scope; listed under Follow-ups.

---

## DB contract — **ZERO migrations** (REQ-27)

"Accurately work on DB migrations" here means proving none is needed rather than
assuming it. The determination, as a table of what *would* have forced one:

| Candidate change | Would need a migration? | Evidence / why avoided |
| --- | --- | --- |
| New `node_attempts.decision` value `crash_recover` | **No** | `schema.ts:5327` is `text("decision")` with **no CHECK**; the precedent values `review_rework_claim` / `operator_interrupt` also ship constraint-free. |
| A fifth `action_resume` kind | **Yes — so the design avoids it** | `node_attempts_action_resume_check` (`schema.ts:5442`) whitelists exactly four kinds and binds `assignmentId` to the attempt's column. Provenance rides `decision` instead. |
| New `runs.status` value | **Yes — none added** | Locked micro-decision: provenance rides `node_attempts`, per ADR-160/161. |
| New `execution_assignments.placement_reason` | **No** | `recover` is already in `PLACEMENT_REASONS` and already used by `recover.ts`. |
| New prompt-owner variant | **No** | The design reuses `variant:"node"`; `execution_commands_request_v2_check` is generated from `PROMPT_OWNER_SHAPES` and would otherwise have to change. |
| An index for REQ-13's recovery predicate | **No** | The sweep already selects candidates by `runs_project_status_idx` / `runs_project_status_kind_idx`; the `resume_started_at IS NOT NULL` test is applied to rows already loaded. |

If implementation nonetheless needs one, it is a **triple** — SQL file +
`_journal.json` entry + `meta/<NNNN>_snapshot.json` — the next free number is
`0171` (after `0170_prompt_dispatch_key`), the fourth leg is `schema.ts`
(`drizzle-kit generate` must end reporting "No schema changes"), and the change
folds back into this spec and the plan in the same pass.

### Attempt shape — the chosen option and why

The ledger row shape on re-dispatch is **Option A: a fresh attempt row
(`attempt = N+1`), with the crashed row closed `Reworked` / `crash_recover`.**
The full option space and its four hard constraints are enumerated in the plan's
"Attempt shape" section. The deciding argument is the cost ledger:
`node_attempt_cost_rollups` is `UNIQUE(node_attempt_id, model)`, so reusing the
row (Option B) would upsert the pre-crash turn and the post-recover turn into
**the same row** and make two paid ACP turns permanently indistinguishable —
a silent, unrecoverable loss.

Option A is *not* used by REQ-24's all-settled orchestrator arm: that run was
parked, not killed mid-turn, so it re-enters through `orchestratorResume` and
REUSES its parked `NeedsInput` attempt. Two re-entries, two shapes, both
deliberate.

---

## System-analytics contract

| Document | Change | Gate consequence |
| --- | --- | --- |
| `execution-prompt-lifecycle.md` | one **crash recover** owner/recovery row + prose; the `Crashed` eligibility row's `H until explicit recovery claim` is unchanged — this change defines the claim it names | ⚠ The document is in the Stage B group enforced by `scripts/validate-docs-indexes.mjs` and is at **exactly** the 12-bullet `## Expectations` cap with `PRM-01…PRM-12` all allocated and traced. A 13th bullet or a new `PRM` id **fails `pnpm validate:docs`**. Therefore: **table row and prose only**, mirroring the established escape-hatch parenthetical already used at `:133`. |
| `reconciliation-gc.md` | rewrite "Operator Recover — hybrid resume / re-dispatch" so the agent arm enters the graph; state the D2 recovery priority in order; move `judge`; add the Scope-6 classification | owns the acceptance contract; in **no** enforced group. At most **two** new Expectations bullets. |
| `runs.md` | invariant 4 restated for both arms | — |
| `architecture.md` | re-verify the manager↔host sequence and component responsibilities (T4.3) | — |

**Recorded honestly:** `reconciliation-gc.md` already carries **19**
Expectations bullets against the documented R5a cap of 12
(`docs/CLAUDE.md:222-223`). That overage is **pre-existing debt** this change
neither creates nor fixes; splitting the domain is a separate refactor, listed
under Follow-ups. Two bullets deepen it by two, deliberately and with this note.

Two stale reconcile comments are corrected in the same change, because both
describe code that no longer exists:

- `web/lib/reconcile.ts:212-214` — a scratch run with a live session now
  returns at `:380-382` and never reaches the kind-forcing at `:404-407`.
- `web/lib/reconcile.ts:1359-1361` — `liveByRunStep` has had no `.get` since
  `ce42c2db`; the in-flight guard reads `liveByRun`. `runStepKey`'s header at
  `:83-84` is corrected with it, since that dead index is its only remaining
  justification.

---

## Acceptance criteria traceability

Test ids are stable and are cited by the plan's tasks. `unit` = vitest project
`unit`; `integ` = project `integration` (testcontainers PG16); `integ+sup` =
integration with the **real supervisor** (`web/test-support/real-supervisor.ts`
+ `supervisor/test/fixtures/mock-acp-adapter-resumable.mjs`). The RED 1–4
families live in
`web/lib/flows/graph/__tests__/prompt-owners.integration.test.ts` under the
family name **`owner-flow-crash-recover`**.

| AC | Criterion | Requirements | Test |
| --- | --- | --- | --- |
| **AC-01** | SIGKILL an `ai_coding` adapter mid-turn → reconcile `Crashed` → Recover → the run reaches a terminal state; **exactly one** new `session.prompt` command exists under the NEW `execution_assignment_id`; the crashed attempt is closed `Reworked`/`crash_recover`. On unfixed code the run stays `Running` with a live idle session, zero prompt commands under the new assignment, and `node_admission_generation` in the log. | REQ-01, REQ-02, REQ-03, REQ-12 | **T-CR1** (integ+sup) |
| **AC-02** | A completed turn whose owner never applied is applied on recover with **no** second `session.prompt` for that attempt; `execution_commands.application_state='applied'` with `completion_applied_at` set. The test must not hand-write `action_completion`. | REQ-05, REQ-06, REQ-07 | **T-CR2** (integ+sup) |
| **AC-03** | With a finished `gate-<id>` substep session newer than the node's own and every incarnation terminal, the recovered dispatch resumes the **node attempt's** handle, never the substep's; the classifier's session input is likewise node-scoped. | REQ-08, REQ-09 | **T-CR3** (integ) |
| **AC-04** | SIGKILL the web process between the Phase-1 CAS and the dispatch → after restart the run continues through the ordinary re-entry with **no** second operator click; separately, a concurrent second `POST /recover` answers `409`. | REQ-13, REQ-14, REQ-17 | **T-CR4** (integ, real web) |
| **AC-05** | `classifyRecover` routes `judge` to `resume-agent` with a handle and `discard-only` without one; `retry_safe` no longer decides for `judge`. | REQ-23 | **T-CR5** (unit, decision table) |
| **AC-06** | `isRunRecoverable` offers Recover for a crashed `judge` with a handle, so the UI button and the route agree; `acp_session_id` never leaves the server. | REQ-09, REQ-11, REQ-23 | **T-CR6** (unit) |
| **AC-07** | A coordinator crashed mid-wait with one live child recovers with **zero** new child runs and **zero** new coordinator `session.prompt` commands; the run is handed back as `WaitingOnChildren` with `resume_requested_at` cleared, and a cap-full queue advances by exactly one. | REQ-24, REQ-25 | **T-CR7** (integ) |
| **AC-08** | A `crash_recover` attempt moves neither Observatory counter and does not advance the rework epoch; a genuine rework still exhausts at `maxLoops + 1`; the operator-restart budget is moved by **zero**. | REQ-20, REQ-21 | **T-CR8** (unit, pure counters) |
| **AC-09** | A `Running` run with a live idle session and no driver is re-entered through `crashResume` when the marker is set, and otherwise classified into the new sweep counter — never silently skipped. | REQ-17, REQ-18 | **T-CR9** (integ, sweep) |
| **AC-10** | A cap-full recover queues, promotes through the scheduler, and reaches the same graph re-entry; `driveResume` refuses a `scratch` and an `agent` run before the flow-only arm — one case per discriminant. | REQ-15, REQ-16 | **T-CR10** (integ) |
| **AC-11** | The success body's `runStatus` is the committed row's status: `Running` for an ordinary resume, `WaitingOnChildren` for a parked coordinator, `Pending` for a queued recover. | REQ-25, REQ-26 | **T-CR11** (unit, `recover-http`) |
| **AC-12** | The timeline renders a distinct `crash_recover` label in EN and RU; catalog parity holds. | REQ-22 | **T-CR12** (unit, i18n parity + label map) |
| **AC-13** | With all incarnations terminal, `loadActiveRunSession`'s ranking still prefers the substep row — pinning the hazard C2 describes, so the node-scoped resolution is demonstrably necessary rather than assumed. | REQ-08 | **T-CR13** (integ, ranking suite) |
| **AC-14** | `_journal.json` is untouched and `db:erd --check` is a no-op across the whole change. | REQ-27 | **T-CR14** (T4.3 gate, `pnpm validate:docs`) |

Every REQ maps to at least one AC; every AC names exactly one primary test and
its lane.

### Edge cases — enumerated, not implied

| Edge | Handling | Covered by |
| --- | --- | --- |
| supervisor refuses `resumeSessionId` (`CHECKPOINT`) | **not** a recover failure — the graph degrades observably to a fresh session with `session_fallback` stamped (ADR-081) | T-CR1 variant |
| the node has no retained handle at all | `setSessionFallback` on the fresh attempt; no second fallback is added | existing ADR-081 coverage |
| web dies **before** the attempt close (run `Running`, marker set, attempt open) | idempotent re-entry through the `crashResume` claim | T-CR4 |
| web dies **after** the close, before `runFlow` (attempt closed, no dispatch) | same claim; the graph appends the fresh attempt | T-CR4 |
| dispatch fails fenced / `EXECUTOR_UNAVAILABLE` | `503` `transient`; run stays `Running` with the marker set; re-entered by the sweep | T-CR9 |
| dispatch throws anything else | `410 CHECKPOINT` via `crashRunningRun`; run is `Crashed` again, marker cleared | existing `recover.integration.test.ts` |
| a pre-existing orphaned idle session created by the OLD arm | reclaimed by the sweep's `crashResume` re-entry, not by the new code path implying it | T-CR9 |
| a crashed `consensus` node | unchanged — not in the classifier's agent set and out of scope | — |
| scratch / standalone agent recover | explicitly out of scope (diagnosis A4) | — |

---

## Non-goals (this change)

- Scratch recover (`web/lib/scratch-runs/recovery.ts`) and standalone agent-run
  recover. This change must neither depend on them nor block them.
- P0-2 durable-worker activation. REQ-13's predicate is written so the
  continuation worker can adopt it later; the reason it cannot today is
  recorded (its `node_attempts` arm needs an open `Running` attempt on the
  **active** assignment).
- Making `classifyRunReconcile` consult command evidence before writing
  `agent-session-gone`. REQ-05 consults evidence at **recover** time only.
- An observable recovery domain event / webhook.
- HITL UI, outbox pressure, consensus internals.
- A per-run bound on crash-recover re-entries (see Follow-ups).

## Linked artifacts

- Plan: [`../plans/claude-crashed-agent-recovery-routing-dc28b6.md`](../plans/claude-crashed-agent-recovery-routing-dc28b6.md)
- ADR: [ADR-175](../../docs/decisions.md)
- [`docs/system-analytics/reconciliation-gc.md`](../../docs/system-analytics/reconciliation-gc.md)
- [`docs/system-analytics/execution-prompt-lifecycle.md`](../../docs/system-analytics/execution-prompt-lifecycle.md)
- [`docs/system-analytics/runs.md`](../../docs/system-analytics/runs.md)
- [`.ai-factory/plans/stage-ab-stabilization.md`](../plans/stage-ab-stabilization.md) — D2 owner table, AT-05 family `owner-flow-crash-recover`, S5.2 scenario
