# Implementation Plan: Evidence-first crash classification (P1-5, ADR-177)

Branch: `claude/evidence-first-crash-classify-b15bb5` (worktree HEAD = `6cd95560` = `master`)
Created: 2026-09-21
Request: item **P1-5** of the execution-seam diagnosis (2026-09-18), supplied as chat text.
Baseline verified at: `6cd95560` (after ADR-175 and ADR-176).

## Settings

- Testing: **yes** — RED-first, against a **real supervisor fixture and real
  Postgres**. Mocked suites ignore `WHERE` clauses (patch 2026-09-15-17.05), and
  every property here is a `WHERE`. The PRODUCTION web (`startRealWeb`) is used
  **only** by the two cases that need live durable workers — see **RQ4**; the
  request's "all controls run the production web" is over-specified and is
  amended there with the cost analysis.
- Logging: **standard** — INFO per sweep decision counter and one INFO for the
  CAS loser no-op; ERROR only on `owner-poisoned`. No per-candidate DEBUG: the
  sweep touches every `Running` run on a 60 s tick and the new probe adds a
  per-candidate branch to that hot path.
- Docs: **yes** — mandatory docs checkpoint. **Phase 0 is docs-first** per the
  project's `aif-plan` skill-context rule ("front-load a complete, internally
  consistent analytics/design spec before any code phase").
- Scope guard: the evidence probe feeds the **`run_kind = 'flow'`, no-live-session,
  agent-node arm ONLY**. The `agent-observer-*` and `live-scratch-session` arms are
  untouched (trap 7).

## Roadmap Linkage

Milestone: **"none"**.
Rationale: this is the third undelivered obligation of
`.ai-factory/plans/stage-ab-stabilization.md` — normative **D2** ("Recovery
priority: reconcile existing command evidence → apply owned terminal result →
recover checkpoint/attempt boundary if evidence proves the old turn lost →
dispatch a new logical prompt only under the normal re-entry claim", plan `:364`)
and the final-matrix row **"Real supervisor restart"** (`:859`, an S5 gate) —
not a `ROADMAP.md` milestone; ROADMAP's open item is M51, which is unrelated.
Both predecessor plans (ADR-175, ADR-176) record the same linkage.
`/aif-verify --strict` should WARN for missing linkage alone, not fail.

## Research Context

`.ai-factory/RESEARCH.md` is absent. Evidence sources are the code at `6cd95560`,
the accepted contracts in `docs/`, and the supplied diagnosis.

## Reserved numbers (skill-context rule — allocate up front)

| Artifact | Number | Basis |
| --- | --- | --- |
| ADR | **ADR-177** — "Evidence-first crash classification" | `max(### ADR-NNN)` at `master`'s HEAD is **ADR-176** (`docs/decisions.md:1781`). Two files: a `### ADR-177:` stub+summary in `docs/decisions.md` AND the full text in `docs/decisions/adr-177.md` (the repo carries both; `adr-169`..`adr-176` are the precedent). |
| Migration | **none — and none is needed.** `0172` is the next free `idx` (`web/lib/db/migrations/meta/_journal.json` max = **171**, last tag `0171_crash_recover_continuation_retry`) and is **deliberately left unallocated**. | See **D7**. |

A cited ADR with no header at HEAD is a build break, not a doc nit — write the
`### ADR-177:` header in `docs/decisions.md` in the **first** commit that cites it.
`pnpm validate:docs` resolves ADR anchors via `scripts/validate-docs-adr-anchors.mjs`,
so the anchor is gate-enforced once the header exists.

---

## Ground truth — corrections and additions to the request

The request's ground truth was re-verified in this worktree. It is accurate
except where noted. **Thirteen findings change the work** (C10-C12 came from the question-resolution pass, C13 from the `/aif-improve` pass; see "New findings from the resolution pass"). Do not re-derive them.
**C8 and C9 are the two that change what the fix must do**, and C9 is a defect
site the request did not name.

### C1 — ⚠ The sweep runs reconcile BEFORE command recovery, so the probe is mandatory

`web/lib/scheduler/system-sweeps.ts` `runSystemSweep()` orders its steps:

| Line | Step |
| --- | --- |
| `:289` | `runSweepTick()` (keep-alive) |
| **`:299`** | **`runReconcileSweep()`** |
| `:309` | `runSyncRecoverySweep()` |
| `:319` | `reconcileTerminalCostRollups()` |
| `:356` | `runEventStreamHealthSweep()` — the pass that marks a stream `lost` |
| **`:367`** | **`executionCommandReconcilePass()`** → `recoverExecutionCommands()` (`recovery.ts:746`) |

`recoverExecutionCommands` is otherwise called only at **boot**
(`web/instrumentation-node.ts:108`, `{graceMs: 0}`).

Two consequences:

1. On the periodic tick the reconciler sees command evidence that is **one full
   tick (60 s) stale**, and a stream is marked `lost` only AFTER reconcile has
   already classified. **The Scope-1 receipt probe is therefore load-bearing and
   cannot be replaced by "recovery ran first".** Reordering the sweep instead was
   considered and rejected — see **D8**.
2. `docs/system-analytics/reconciliation-gc.md:729` claims
   "`recoverExecutionCommands()` runs before the resume/takeover/reconcile sweeps".
   That is true at boot and **false on every scheduler tick**. It is a doc defect
   fixed in Phase 0.

### C2 — ⚠ The scenario already has a test, and it proves the behavior only under an ordering production does not provide

`web/lib/execution-host/__tests__/command-recovery.integration.test.ts:311` —
**V3 (W4): "SIGKILL mid-prompt + restart on the same state dir → turn_lost, same
key, new boot id, run reconciled Crashed"** — already exists, is registered in the
stage-A/B web lane (`scripts/run-stage-ab-tests.mjs`, `command-recovery`), and
passes today.

It passes because at `:358` it calls `recoverExecutionCommands({db, graceMs: 0})`
**manually**, and only then `runReconcileSweep({db})` at `:372`. Per **C1** that
order is the boot order, not the tick order. V3 also asserts only
`run.status === "Crashed"` — never the attempt row, never `applicationState`.

So V3 is **not obsolete and not broken — it is under-specified**, and it hides
the defect by pre-settling the command. RED 1 is therefore an **extension of the
V3 family in the same file**, not a greenfield suite, plus a sibling case that
omits the manual recovery call. Classify it exactly that way in the TDD report.

### C3 — ⚠ The CAS is three-sided, not two-sided (trap 1 is incomplete)

Trap 1 names `runs.status = 'Running'` + `node_attempts.status = 'Running'`.
A third writer-visible object must be fenced: **`execution_commands.application_state`**.

`web/lib/execution-host/retirement.ts:171-176` refuses retirement with
`owner_unapplied` unless `applicationState ∈ {applied, superseded}`, and
`schema.ts` `execution_commands` carries a coupled CHECK
(`:2529`): `(application_state = 'applied') = (completion_applied_at IS NOT NULL)`.
A sweep-side boundary that closes the attempt and crashes the run but leaves the
command `pending` produces a row set that **can never be retired** — Scope 2's
own "command settled so retirement becomes eligible" would be unmet, and
`execution_commands_protected_evidence` would then block deleting the run.

**Design consequence (D3):** both writers go through ONE function whose
transaction also moves the command to `applied` + `completion_applied_at`, under
the guard `completion_applied_at IS NULL`. That guard — **not a new lock** — is
the single-winner mechanism, because the invariant is "this command is applied
exactly once" and the guard is keyed on exactly that object (skill-context:
*match each lock's scope to its invariant's scope*). It is the same guard
`applyCrashedTurnEvidence` already uses (`crash-recover.ts:244-261`, **A12b**).
The run-status and attempt-status CASes sit inside the same transaction, so a
loser on any one of the three rolls the whole thing back.

### C4 — The classifier is PURE and must stay pure; evidence arrives as input fields

`web/lib/reconcile.ts:160` `ReconcileInput` and its 51-case pure unit suite
(`web/lib/__tests__/reconcile-classify.test.ts`, header: *"The classifier is PURE —
nowMs/graceSeconds are inputs, no clock/db access"*). Every impure input already
follows one comment pattern — `crashRecoverPending` (`reconcile.ts:183-185`):
*"Resolved by the caller from the run row; the classifier stays pure."*

The evidence probe (SQL + one conditional HTTP receipt call + the stream-lost
read) therefore lives in the **sweep's input builder**, and the classifier gains
exactly two pure fields. This is the ADR-175 shape, reused verbatim.

### C5 — Adding `turn_lost` to `NON_CORRECTION_DECISIONS` cannot leak into the operator budget

Scope 5 worries that `MAISTER_MAX_OPERATOR_RESTARTS` might count it. It cannot:
both budget sites filter on an **allow-list of one**, not on the complement —
`web/lib/services/hitl.ts:5253-5255` (`r.decision === OPERATOR_INTERRUPT_DECISION`)
and the sibling guard at `web/lib/runs/node-interrupt.ts:583-585`. Both already
carry the ADR-175 comment explaining why. **No change is needed there**; Phase 4
adds a regression assertion rather than a fix.

### C6 — ⚠ `mapReasonToCrashReason` has a silent `default:` that would swallow a new reason

`web/lib/reconcile.ts:603-620`: the switch ends with
`default: return "agent-session-gone"` ("Defensive: only crash reasons reach a
crash dispatch"). A new `turn-lost` reason that reaches the crash dispatch
without a `case` arm is **silently recorded as `agent-session-gone`** — RED 1
would still see `Crashed` and go green while measuring nothing.

Phase 2 adds the `case` arms AND a unit assertion that every crash-classified
`ReconcileReason` maps to a distinct `CrashReason` (an exhaustiveness check, not
a spot test).

### C7 — `Crashed` is NOT a retained status, so RED 6 can assert the stronger property

`web/lib/execution-host/retirement.ts:35-42` — `RETAINED_RUN_STATUSES` =
`Pending | Running | NeedsInput | NeedsInputIdle | HumanWorking | Review`.
`Crashed` is absent. So once the boundary marks the command `applied`, the
command becomes retirement-eligible on the **`Crashed`** run (after replay grace
+ terminal ACK) — it does not have to wait for Recover → `Done`. RED 6 asserts
eligibility at `Crashed`, and again after Recover → `Done`.

### C8 — ⚠ TRACED (the request marked this SUSPECTED): a lost turn is `Failed`, never retried, and NOT recoverable

The graph's consequence of an `ok:false` / `errorCode: "PRECONDITION"` node action,
traced hop by hop:

| Hop | Site | Effect |
| --- | --- | --- |
| 1 | `node-prompt-owner.ts:255-256` | `errorCode = outcome.error.code` — **`details` is dropped here and never reconstructed**. `StepResult` (`flows/types.ts:74-89`) and `FlowActionCompletion.result` (`action-completion.ts:22-27`) have no `details` field at all. |
| 2 | `node-prompt-owner.ts:209-212` | `UPDATE node_attempts SET action_completion = …` only. Attempt `status` stays `Running`. |
| 3 | `runner-graph.ts:3786-3793` | `if (!result.ok)` → `markNodeFailed(…, { errorCode: code })`. |
| 4 | `ledger.ts:197-228` | attempt → `status='Failed'`, `error_code`, `exit_code`, `stdout`, `ended_at`. **`decision` is NOT in the `.set()` — it stays NULL.** |
| 5 | `runner-graph.ts:3794-3797` → `scheduleAutoRetry` (`:2658-2753`) | returns `"fail"` at `:2679`, because `PRECONDITION ∉ RETRYABLE_ERROR_CODES` = `["SPAWN","EXECUTOR_UNAVAILABLE","CHECKPOINT","ACP_PROTOCOL"]` (`config.schema.ts:307-312`). |
| 6 | `runner-graph.ts:3826-3829` | `failed = true; runErrorCode = code; break;` — the traversal loop exits. |
| 7 | `runner-graph.ts:5338-5343` | `UPDATE runs SET status='Failed', ended_at, current_step_id=NULL` CAS-guarded on `Running`, plus assignment release and a `run.failed` domain event carrying `{errorCode:"PRECONDITION"}`. |

Three conclusions the plan depends on:

1. **No auto-retry is even possible.** The budget (`MAISTER_AUTO_RETRY_MAX_ATTEMPTS`,
   default 3, `instance-config.ts:115-116,178`) is never consulted — the
   `on_errors` allow-list rejects first. And a flow author cannot opt in: zod
   restricts `retry_policy.on_errors` to the same four codes
   (`config.schema.ts:320-326`).
2. **There is no failure/error transition in the DSL for a node action.** The
   only `"failure"` edge concept (`topology.ts:25-34,126-150`) is a UI paint
   label for `decide`/verdict **gate** outcomes. A failed action terminates the
   run; it does not route.
3. **`Failed` is not recoverable.** `isRunRecoverable` (`queries/run.ts:409-424`)
   requires `status === "Crashed"`. So today a supervisor restart mid-turn can
   permanently burn the run with no operator remedy — a strictly worse outcome
   than the `agent-session-gone` crash the sweep would have produced. **This is
   the defect's real severity**, and it is what RED 1 asserts on this HEAD.

**Order divergence is now exactly characterised** (RED 3's subject): the owner's
`Failed` write CAS-guards on `Running` (`runner-graph.ts:5277-5286`). So
sweep-first yields `runs.status='Crashed'` + attempt `Failed`/`decision=NULL`;
worker-first yields `runs.status='Failed'` + the same attempt. **Two different
run states from one host restart, decided by a 60 s race.**

### C9 — ⚠ ADR-175's Recover ALSO mishandles a lost turn (a defect site the request did not name)

`applyCrashedTurnEvidence` (`web/lib/runs/crash-recover.ts:100-306`, called once
from `recover.ts:492`) adopts agreeing terminal evidence onto the crashed
attempt before the graph re-enters. It decodes that evidence with the **same**
`decodeNodePromptCompletion` (`crash-recover.ts:184-199`) and, at
`:201-266`, writes in one transaction: `node_attempts.action_completion` +
`execution_assignment_id` (CAS on `status='Running' AND action_completion IS NULL`),
then `execution_commands` → `application_state='applied'`,
`completion_applied_at=now()` (CAS on `completion_applied_at IS NULL`).

It does not distinguish `failed{turn_lost}` from a genuine failed turn: it would
decode the lost turn into a `FlowActionCompletion` and the graph would then fail
the node per **C8**, turning Recover into a no-op that re-fails.

**Reachability — bounded, and NOT on RED 1's path.** `applyCrashedTurnEvidence`
only ever looks at attempts `openRunningAttempts` returns, and that filters
`status='Running' AND ended_at IS NULL` (`crash-recover.ts:34-53`). The **D3**
boundary closes the attempt (`Reworked` + `ended_at`), so a run crashed as
`turn-lost` presents no open attempt, the loop body never runs, and the function
returns `"absent"` (`:300-305`) — Recover proceeds down its normal re-dispatch
path. RED 1's `→ Done` half therefore passes **without** T3.5.

The hole is the residue: a settled-unapplied `turn_lost` command sitting on a
still-open attempt of a run crashed for some **other** reason
(`worktree-gone`, `orphaned-child`, `cli-not-retry-safe`), and every row already
crashed as `agent-session-gone` before this change ships. Recover on those adopts
the lost turn and burns the node.

**Scope (T3.5) — defence in depth, ~5 lines, not a RED-1 blocker.**
`applyCrashedTurnEvidence` refuses a settled command whose
`lastError.details.reason === 'turn_lost'` — a lost turn is not a result — and
returns a new `"turn-lost"` outcome that the caller treats like `"absent"`.
Additive to ADR-175, not a change to it. **It is separable**: if the phase has to
be cut, cut this and file it, and say so explicitly rather than letting it
disappear.

**Two upsides:** that function is also the **template** for the boundary's
transaction — it already demonstrates the claim/CAS/`applied` shape **D3**
needs (**C3**) — and it already proves the "another writer won" handling
(`evidenceAlreadyApplied`, `crash-recover.ts:60-71,227-228,267-281`).

### C14 — ⚠ CORRECTION to A12c found in Phase-0 recon: `turn_lost` is carried in TWO shapes, and A12c names only one

A12c says *"Both set `details.reason='turn_lost'`"*. Verified against the code,
that is true of one writer and false of the other:

| Writer | Shape written to `execution_commands.last_error` | Evidence |
| --- | --- | --- |
| the supervisor's own startup terminal event, ingested by the event plane | **nested** — `{code:"PRECONDITION", details:{reason:"turn_lost"}}` | `supervisor/src/command-receipts.ts:174,293` writes `{details:{reason,runId}}`; V3 asserts the persisted row at `command-recovery.integration.test.ts:362` |
| `foldReceipt`'s accepted-with-no-terminal fallback | **flat** — `{code:"ACP_PROTOCOL", reason:"turn_lost"}` | `recovery.ts:279-320` builds `{code, message?, reason}` (the nesting is flattened); `:324-341` writes `{code:"ACP_PROTOCOL", reason:"turn_lost"}` |

`recovery.ts:549-558` reads only the nested shape, which is correct for the
dominant path but would miss the fallback.

**Consequence for the work:** every `turn_lost` match in this plan (D1 row 7,
D3 step 1, T3.3, T3.4, T3.5) goes through ONE exported predicate,
`isTurnLostError(lastError)`, that accepts **both** shapes. Matching only
`details.reason` would silently never fire on the fallback path. This does not
change any decision — it makes them implementable.

### C18 — ⚠ D2's `stream-lost` row is internally inconsistent; narrowed to the two classes it actually describes

D2 writes the bound as *"`pending_*` ∨ `inflight` ∧ `promptEvidenceStreamLost`
→ CRASH `stream-lost`"* and justifies it as *"nobody — the evidence can never
arrive"*. That justification is true of exactly two classes and false of the
third `pending_*` member:

| Class | Where the evidence is | Can a dead stream strand it? |
| --- | --- | --- |
| `pending_ingest` | on the host, terminal event never ingested | **yes** |
| `inflight` | on the host, turn still running | **yes** |
| `pending_application` | already INGESTED — that is what made the command settled | **no** — the prompt-owner worker claims it from Postgres |
| `applying` | as above, a worker holds the claim | **no** |
| `applied` | in the ledger | **no** |

Applying the override to the whole skip set crashes runs whose result already
landed — the precise failure the evidence arms exist to prevent, reintroduced by
their own bound. Caught by a test of mine whose TITLE said the right thing while
its assertion said the opposite, and passed: an override that wide made both
readings green.

**Narrowed to `pending_ingest` and `inflight`.** This is not a trade-off being
reopened — it is D2's own stated reason applied consistently. The unit suite
pins both directions (the two that crash, the three that must not).

### C17 — ⚠ DEVIATION from RQ4's slice allocation: the two "isolation" cases run in-process, and the reason is RQ4's own argument

RQ4 sends two cases to the `isolation` slice — RED 3's worker-first order and
RED 2's ingest release — because they *"need live durable workers"*. Verified in
Phase 1: they need a live **prompt-owner worker**, which is
`startPromptOwnerWorker({db, owners})` (`prompt-owner-recovery.ts:37`), an
ordinary in-process call. They do NOT need the production web.

RQ4's own finding 2 already draws the line: *"the production web proves boot
wiring, which is `durable-workers-boot`'s job. Spending a `next build` and two
process trees on pure sweep/boundary logic buys nothing."* That argument applies
to these two cases as soon as one observes the worker is independently
startable — which the first draft did not.

Both therefore run in `command-recovery.integration.test.ts` (already in
`laneSuites.web`) against the real supervisor:

| Case | Writer it needs | How it is supplied |
| --- | --- | --- |
| RED 3 worker-first | the flow prompt owner settling the turn BEFORE the sweep | `startPromptOwnerWorker({db, owners: flowPromptOwners})` in the test process; the seeded run already satisfies every `lockFlowPromptOwner` precondition |
| RED 2 release | ingest held, then released, then the owner applies | `projectionWorker.stop()` → sweep → restart the projector → the worker applies |

**No new `isolation` suite, and T1.7 collapses to a negative:** `isolation` stays
3 suites, `command-recovery` is already registered in `laneSuites.web`, and
`reconcile-sweep.integration.test.ts` runs in the ordinary
`test:integration` project (it is not a lane suite and never was). Nothing needs
registering — recorded as a checked negative, not an omission.

What is **given up**: proof that these arms behave the same under the production
boot's composed registry. That is `durable-workers-boot`'s contract (PRM-04
pins the registry composition, PRM-11 the worker lifecycle), and it is unchanged
by this work — no new owner kind, no new registry entry.

### C16 — ⚠ RQ5's premise is wrong: V3's run is a SCRATCH run, so extracting its body would measure nothing

RQ5 says *"`preSettle: true` is today's V3, unchanged in what it asserts"* and
treats the family as an extension of it. Verified: `seedFlowRun` in
`command-recovery.integration.test.ts:78` calls
`seedRun(testDatabase.db, {projectId, status})`, and `seedRun`
(`execution-host-seed.ts:81`) defaults **`run_kind` to `'scratch'`**, with no
`flow_revision_id` and no `current_step_id`. V3's run is therefore classified by
the scratch arm (`markScratchCrashed`), never by the flow agent-node arm this
plan edits. Its name says flow; its row does not.

That is why V3 passes today asserting only `status === "Crashed"` — the scratch
arm reaches `Crashed` by age, exactly as it did before Stage A.

**Consequence:** the ADR-177 family cannot be an in-place extraction of V3's
body. V3 stays byte-identical (it measures transport-level recovery on its own
run shape and is not obsolete), and the family gets its own
`seedFlowGraphRun` — `run_kind='flow'`, a `flow_revisions` row whose manifest
carries an `ai_coding` node, and `current_step_id` pointing at it. Same
supervisor, same restart, same file; a different run shape, because the arm
under test only exists for that shape. RED 5c pins the scratch scope guard from
the other side.

### C15 — ⚠ T3.5's write as specified VIOLATES a CHECK constraint (found in Phase-1 recon)

C13/T3.5 says the Recover decline settles
`application_state = 'superseded'` **+ `completion_applied_at = now()`**.
`execution_commands_application_shape_check` (`schema.ts:2526-2534`) opens with

```sql
(application_state = 'applied') = (completion_applied_at IS NOT NULL)
```

— an **equivalence**, not an implication. `superseded` + a non-null
`completion_applied_at` evaluates `false = true` and the row is refused.

The existing production writer already has the right shape
(`prompt-owner-application.ts:365-368`):

```ts
applicationState: outcome,                                // "applied" | "superseded"
completionAppliedAt: outcome === "applied" ? now : null,  // NULL for superseded
```

**Correction:** T3.5 writes `application_state = 'superseded'` and leaves
`completion_applied_at` **NULL**. Nothing is lost — `classifyCommandRetirement`
(`retirement.ts:171-176`) never reads `completion_applied_at`; it accepts
`applied` OR `superseded`, so the C13 discharge works exactly as intended. The
single-winner guard for that write is therefore
`application_state = 'pending' AND completion_applied_at IS NULL`, not
`completion_applied_at IS NULL` alone (which stays NULL either way).

**Related, and NOT a violation:** the **D3** boundary's `owner-poisoned` arm
writes `applied` + `completion_applied_at`, which satisfies the equivalence, and
it deliberately **preserves `application_error`** rather than nulling it as
`crash-recover.ts:253` does. `applied` with a non-null `application_error` is an
already-valid shape in this schema — `quarantine()` writes exactly it when
`completion_applied_at` is already set (`prompt-evidence.ts:196-208`) — so the
operator keeps the poison diagnostic while retirement becomes eligible.

### Confirmed as stated in the request (no change)

- The classifier knows nothing about commands; `ReconcileInput` carries no
  `execution_commands` field (`reconcile.ts:160-215`). ✔
- `crashRunningRun` writes no `node_attempts` row and stamps
  `resume_target_step_id` from the pre-update `current_step_id`
  (`state-transitions.ts:1343-1380`). ✔ It already CASes on `fromStatuses`
  (default `["Running"]`, `:1351`) — half of the inner CAS exists.
- `closeCrashedNodeAttempts` (`crash-recover.ts:317-338`) sets
  `status='Reworked'`, `decision=CRASH_RECOVER_DECISION`, guarded on
  `status='Running' AND ended_at IS NULL`, and **returns the closed ids** — an
  empty array is exactly the "loser is a no-op" signal trap 1 asks for. ✔
- `REASON_TOKENS` (`execution-host/types.ts:147-158`) is a closed union
  containing `turn_lost`. ✔ Match on the settled command's
  `lastError.details.reason`, never on HTTP status (trap 2). ✔
- `node_attempts.decision` is `text("decision")` with **no CHECK**
  (`schema.ts:5311` + relative `:37`). `action_completion` IS CHECK-guarded at
  version 1 (`schema.ts` relative `:143-145`). Trap 3 confirmed. ✔
- `commandStreamLost({db, commandId})`
  (`web/lib/execution-host/events/stream-health.ts:287-306`) is the existing
  bounded-ness primitive trap 4 demands. Do not invent a timer. ✔
- `real-supervisor.ts` already exposes `restart()` — *"Same runtime root, state
  dir, port and adapter fixture"* after a SIGKILL of the process group
  (`:71-73`, `:317-319`). RED 1 needs no new fixture. ✔
- `seedNodePromptOwner` backdates the attempt 1 h by default
  (`prompt-owner-fixture.ts:31-34`) so seeded runs sit OUTSIDE the 90 s grace.
  RED 5 overrides `startedAt` to control the grace axis. ✔

---

## Verified anchors (read before implementing; do not re-derive)

| # | Anchor | Fact |
| --- | --- | --- |
| A1 | `web/lib/reconcile.ts:160-222` | `ReconcileInput`, pure, 19 fields. Impure inputs are pre-resolved by the caller and documented as such. |
| A2 | `web/lib/reconcile.ts:297-500` | `classifyInner`, **11 arms in a fixed order**. The one this plan edits is arm 10 (`kind ∈ {ai_coding, orchestrator}`, `:465-496`): **10a** `crashRecoverPending` → `crashRecoverClassification` (`:478-479`), **10b** grace → `skip/grace-window` (`:483-493`), **10c** `crash/agent-session-gone` (`:495`). **The evidence arms insert between 10a and 10b.** Arm 9 (`cli`, `:460-463`) has NO grace check and is untouched; arm 11 (gates, `:499`) is untouched. |
| A2b | `web/lib/reconcile.ts:95-158` | `ReconcileAction` — 8 variants (`skip \| reattach \| reobserve \| redispatch \| recover \| crash \| sync-recover \| abandon`). `ReconcileReason` — **20** variants. |
| A2c | `web/lib/reconcile.ts:1561-1601` | The ONE `classifyRunReconcile` call site, inside `runWithConcurrency(candidates, PER_PASS_CONCURRENCY, …)` (loop opens `:1506`). `crashRecoverPending` is computed inline at `:1579-1582` — **the new evidence fields go here, in the same style, under the same bounded concurrency.** |
| A2d | `web/lib/reconcile.ts:527-571`, `:573-588`, `:2096-2111` | `ReconcileSweepSummary` (14 fields), `ZERO_SUMMARY`, and the returned literal. **A new counter must be added in all three places.** |
| A2e | `web/lib/reconcile.ts:502-510` + `web/lib/runs/crash-recover-route.ts:29-37` | `mostRecentMs` (the grace anchor = `max(resumeStartedAt, latestAttemptStartedAt)`) is duplicated verbatim in both files. Do not add a third copy. |
| A3 | `web/lib/reconcile.ts:603-620` | `mapReasonToCrashReason` — silent `default:` (**C6**). |
| A4 | `web/lib/reconcile.ts:622+` | `CandidateRow` — the builder's row type; the new evidence fields join here. |
| A5 | `web/lib/runs/state-transitions.ts:1334-1341` | `CrashReason` closed union: `worktree-gone \| agent-session-gone \| cli-not-retry-safe \| orphaned-child \| orchestrator-stuck`. |
| A6 | `web/lib/runs/crash-recover.ts:317-338` | `closeCrashedNodeAttempts` — status/decision/guard/return shape. |
| A7 | `web/lib/execution-host/types.ts:115-121` | `COMMAND_APPLICATION_STATES` = `pending \| applying \| applied \| superseded \| poisoned`. |
| A8 | `web/lib/execution-host/prompt-evidence.ts:41` | `PromptEvidenceDisposition` = `waiting \| settled \| quarantined`; quarantine reason `prompt_terminal_conflict` (`:142`). |
| A9 | `web/lib/execution-host/recovery.ts:549-558` | `summary.turnLost` is counted and **nothing else is written**. |
| A10 | `web/lib/execution-host/retirement.ts:155-190` | `classifyCommandRetirement` — `run_retained`, `replay_grace`, `pre_activation_unowned`, `owner_unapplied`, `terminal_evidence_missing`, `terminal_event_unacked`. |
| A11 | `web/lib/flows/graph/attempt-decisions.ts:26-29` | `NON_CORRECTION_DECISIONS = [operator_interrupt, crash_recover]`. |
| A12 | `web/lib/flows/graph/ledger.ts:197-228` | `markNodeFailed` writes attempt `status='Failed'` + `errorCode: MaisterErrorCode` + `ended_at`, and leaves `decision` NULL. **Not reusable** for the boundary (it would break Recover, which needs `Reworked`). |
| A12b | `web/lib/runs/crash-recover.ts:100-306` | `applyCrashedTurnEvidence` — the lookup (`owner_ref->>'variant'='node'`, `owner_ref->>'nodeAttemptId'`, `ORDER BY created_at DESC LIMIT 1`, `:113-128`), the one-tx attempt+command write (`:201-266`), the `PromptOwnerHandoffLost` / `evidenceAlreadyApplied` loser handling (`:60-71,227-228,267-281`), and the `"applied" \| "absent" \| "quarantined"` outcome (`:73`). **The template for D3 — and the C9 defect site.** |
| A12c | `web/lib/execution-host/recovery.ts:279-341` | `foldReceipt` writes **two different codes** for a lost turn: a host `rejected` receipt carries `PRECONDITION` (`:279-320`), while the accepted-with-no-terminal-receipt fallback writes `{code:"ACP_PROTOCOL", reason:"turn_lost"}` (`:324-341`). Both set `details.reason='turn_lost'`. **Match the reason; derive `error_code` from the settled `lastError.code`, never hardcode it.** |
| A12d | `web/lib/execution-host/recovery.ts:57-71`, `:559-574` | `ExecutionCommandRecoverySummary` already has an `impasse` counter that fires for exactly the stream-lost case (`lostStreamHostIds` loaded once per pass at `:392`). The reconcile `stream-lost` arm is its sibling, not a new concept. |
| A13 | `web/app/(app)/runs/[runId]/layout.tsx:868-880` | `decisionLabel` map. Its own comment: *"A decision this map does not know renders as its RAW snake_case token, so every provenance decision needs an arm here AND a key in both catalogs."* |
| A14 | `web/messages/{en,ru}.json:2317` | `decisionCrashRecover` — the EN/RU precedent for the new `decisionTurnLost` key. |
| A15 | `web/test-support/__tests__/durable-workers-boot.integration.test.ts:1-60` | The production-web harness: `buildProductionWeb`, `startRealWeb`, `startRealSupervisor`, `startMainAndBrainPostgresTestDb`, `durable-workers-seed`, `awaitOwnedPrompt`, `poll`. Its header states the discipline RED 3 needs: **"AUTHORSHIP, not timing"**. |
| A16 | `scripts/run-stage-ab-tests.mjs:11-56` | `laneSuites.web` / `laneSuites.isolation`; `SERIAL_SLICES = {isolation}`. New production-web suites register in `isolation`; ledger-level suites in `web`. |

---

## Decisions

### D1 — Evidence is resolved in the builder; the classifier gains two pure fields

`ReconcileInput` gains, documented in the `crashRecoverPending` house style:

```ts
// P1-5 (ADR-177): the classification of the current attempt's newest owned
// `session.prompt` command. Resolved by the caller (cheap SQL, plus ONE
// `GET /commands/{id}` receipt probe for an `accepted` row with no terminal
// evidence); the classifier stays pure. `none` for every non-flow run and for
// every arm other than the no-live-session agent branch.
promptEvidence?: PromptEvidenceClass;
// P1-5 (ADR-177): the host holding that command has an `execution_event_streams`
// row in state `lost`, so the pending evidence can never be ingested. The ONLY
// bound on `evidence-pending` — read from `commandStreamLost()`, never a timer.
promptEvidenceStreamLost?: boolean;
```

`PromptEvidenceClass` (new, in `web/lib/reconcile-evidence.ts`, pure, no
`server-only` — the classifier suite must import it):

```
"none" | "inflight" | "pending_ingest" | "pending_application"
| "applying" | "applied" | "turn_lost" | "quarantined" | "poisoned"
```

`inflight` is added to the request's set: the receipt probe distinguishes
`accepted + inflight:true` (the turn is genuinely still running on the host)
from `accepted + inflight:false` (the `turn_lost` signature —
`supervisor-client.ts:1147`, `execution-host/contracts.ts:92`). Folding it into
`pending_ingest` would lose the distinction the probe exists to make.

**Derivation order** (first match wins; `web/lib/reconcile-evidence.ts`, pure
function over a row + an optional probe result — unit-testable without Postgres):

| # | Row condition | Class | Why this order |
| --- | --- | --- | --- |
| 1 | no owned `session.prompt` for the current attempt | `none` | nothing was dispatched |
| 2 | `state ∈ {queued, delivering}` | `none` | nothing the host could have lost; W1/W2 own these |
| 3 | `applicationError.reason = 'prompt_terminal_conflict'` | `quarantined` | EDGE-PRM-03: disagreeing evidence, owner application stopped. **This row MUST precede row 5**: `quarantine()` (`prompt-evidence.ts:166-194`) writes `applicationState = completionAppliedAt ? "applied" : "poisoned"`, so a conflict found after application reads as `applied` + `applicationError` set. Keying row 3 on `applicationState='poisoned'` would silently classify that case as healthy. |
| 4 | `applicationState = 'poisoned'` | `poisoned` | any other deterministic application failure |
| 5 | `applicationState ∈ {applied, superseded}` | `applied` | the continuation worker owns the next step |
| 6 | `applicationState = 'applying'` | `applying` | a worker holds the claim right now |
| 7 | settled ∧ `lastError.details.reason = 'turn_lost'` | `turn_lost` | **before** `pending_application`: a settled lost turn is the boundary, not something to wait for. Safe because **D3** makes both writers produce one shape. |
| 8 | settled (`succeeded \| failed`) ∧ `applicationState = 'pending'` | `pending_application` | the owner worker will apply it within ~1 s |
| 9 | `state = 'accepted'`, no terminal evidence → probe `GET /commands/{id}` | `inflight` \| `pending_ingest` \| `turn_lost` \| `none`† \| `pending_ingest`* | the only HTTP call; one per rare candidate |

† **C19** — a **v2** `accepted` receipt carries no liveness in EITHER direction
(`receiptToResponse` drops the `inflight` argument for `requestVersion = 2`;
`normalizeCommandReceiptV2` then hardcodes `false`), so the probe answers
`indeterminate` and the class is `none`. Not `pending_ingest`: that class asserts
a NAMED writer owes the next move and skips regardless of grace, and v2 is the
production request schema — answering it would skip every production candidate
forever. `none` is the one class that falls through to the grace anchor, which
both refuses to crash a turn inside its window and keeps the long-standing
`agent-session-gone` net for one past it.

\* a `404` receipt is `receipt_missing` on the recovery path
(`execution-hosts.md:415`), which `recoverExecutionCommands` already terminalizes.
The reconciler maps it to `pending_ingest` and lets the command-recovery pass own
it — reconcile never invents a terminal outcome from a missing receipt.

**Probe budget.** The HTTP probe fires only for a candidate that is
(a) `run_kind='flow'`, (b) no live session, (c) an agent node, (d) past grace or
not, and (e) holds an `accepted` prompt with no terminal evidence. That is the
ADR-176 D2 "per-rare-candidate" discipline. A probe failure (network/timeout) is
**not** evidence: it yields `pending_ingest` (skip), never a crash.

### D2 — The decision table, applied BEFORE the grace anchor, on that arm only

Inserted in `classifyInner` immediately before the grace anchor
(`reconcile.ts:485`), reached only when `runKind='flow'` ∧ `!liveSession` ∧
`!liveRunStepSession` ∧ the node is `ai_coding | orchestrator`, and only after
the existing ADR-175 `crashRecoverPending` route has already been taken.

| `promptEvidence` | Decision | Reason token | Writer that owns the follow-up |
| --- | --- | --- | --- |
| `applied` | **SKIP** | `evidence-applied` | flow continuation worker (~1 s) drives the next node |
| `applying` | **SKIP** | `evidence-pending` | the worker holding the application claim |
| `pending_application` | **SKIP** | `evidence-pending` | prompt-owner worker (~1 s) |
| `pending_ingest` | **SKIP** | `evidence-pending` | the event consumer, once the dead stream claim expires |
| `inflight` | **SKIP** | `evidence-inflight` | the host — the turn is still running |
| `pending_*` ∨ `inflight` ∧ `promptEvidenceStreamLost` | **CRASH** | `stream-lost` | nobody — the evidence can never arrive |
| `turn_lost` | **CRASH** | `turn-lost` | the boundary (**D3**); Recover is offered |
| `quarantined` | **CRASH** | `owner-poisoned` | operator; Recover follows ADR-175's quarantine rule |
| `poisoned` | **CRASH** | `owner-poisoned` | operator |
| `none` | *fall through* | — | the existing grace / `agent-session-gone` arms, **unchanged** |

The skip arms fire **regardless of grace** — that is the point: "never
`agent-session-gone` while evidence can still arrive". Grace still governs the
`none` path, so **runs.md invariant 2 is restated, not deleted**: *the grace
guard applies only when no evidence exists*.

`owner-poisoned` is ONE `CrashReason` member, not `owner-poisoned:<reason>`
(**C6** — the union is closed). The sub-reason rides
`node_attempts.error_code` and the structured log field `applicationErrorReason`.

### D3 — One boundary function, fenced on the command's application, called by every writer

`applyTurnLostBoundary()` — new, in `web/lib/runs/turn-lost-boundary.ts`, built
on the transaction shape `applyCrashedTurnEvidence` already proves (A12b):

1. **Resolve the settled command** with the A12b lookup (`owner_ref->>'variant'='node'`,
   `owner_ref->>'nodeAttemptId'`, newest first) and confirm
   `lastError.details.reason === 'turn_lost'` — the reason, never the code and
   never the HTTP status (trap 2, **A12c**).
2. **One `db.transaction`** (skill-context: *one transaction for all the
   persistent writes*), each write CAS-guarded so the loser is a no-op:
   - close the attempt: `status='Reworked'`, `decision='turn_lost'`,
     **`error_code='CRASH'` (normalized — RQ3)**, `ended_at=now()`,
     guarded `status='Running' AND ended_at IS NULL AND action_completion IS NULL`.
     Not `settled.lastError.code`: that is `PRECONDITION` or `ACP_PROTOCOL`
     depending on the recovery path (**A12c**), and `error_code` is an
     Observatory cluster key (**C11**) that must not split one root cause in two.
     The path distinction survives on the command's `last_error`.
     A NEW function — **not** a reuse of `closeCrashedNodeAttempts` (locked
     micro-decision) and **not** `markNodeFailed` (which writes `Failed` and
     breaks Recover, A12);
   - `crashRunningRun(runId, 'turn-lost', { fromStatuses: ['Running'], db: tx })`;
   - command → `application_state='applied'`, `completion_applied_at=now()`,
     `application_claim_owner/expires_at/next_retry_at = NULL`, guarded
     `completion_applied_at IS NULL` — the exact write at `crash-recover.ts:244-261`,
     satisfying the coupled CHECK at `schema.ts:2526-2534` (**C3**).
   - **Zero rows from any guard → roll the whole transaction back** and return a
     non-applying result. Never a second close, never a half-apply.
3. **After commit**, outside the tx: the terminal slot-release follow-up
   (`promoteNextPending`) — `crashRunningRun`'s stated caller contract
   (`state-transitions.ts:1332-1333`: *"The caller (reconcile/GC) owns the
   promoteNextPending follow-up"*).

Returns `"applied" | "already-applied" | "lost-cas"`; the two non-applying
results write nothing and log one INFO. The **`completion_applied_at IS NULL`
guard is the single-winner mechanism** — the same one `applyCrashedTurnEvidence`
relies on, keyed on the object whose invariant is "applied exactly once"
(skill-context: *match each lock's scope to its invariant's scope*). No new lock
is introduced.

Callers — **exactly two, both on the flow path**: the reconcile sweep's
`turn-lost` arm, and the flow node prompt owner + gate owner. Those are the two
that genuinely race. Agent and scratch runs do **not** call this; they keep
their own single choke points (**D4** as revised by RQ2). Both orders converge
on one row set by construction — and **C8** shows exactly what diverges today.

### D4 — ⚠ REVISED (RQ2): flow through the boundary; agent and scratch through their own choke points

The request delegates this. **Decision: owner side yes for all three, but NOT
all through one function. Classifier side: flow only.**

The first draft justified a shared boundary with *"otherwise a host restart
burns an agent-run into `Failed` with no Recover"*. **That rationale is
withdrawn** — see RQ2. An agent run made `Crashed` is still not recoverable
(`isRunRecoverable` resolves the node kind from `resume_target_step_id`, an
agent run has none → `discard-only`), and agent-run Recover is out of scope
(A4). The surviving reason to touch them is **retirement**: an owner that never
marks the command `applied` strands it `owner_unapplied` forever and blocks
deleting the run (**C3**).

| Domain | Writer | Change |
| --- | --- | --- |
| **flow node / gate** | two racing writers (sweep + owner) | `applyTurnLostBoundary` (**D3**) — this is the only place a shared single-winner function is earning its keep |
| **agent run** | one writer, `finalizeAgentRun` (`agents/finalization.ts:791`) | pass `outcome: "Crashed"` instead of `"Failed"` — `AgentTerminalOutcome` already admits it. Plus: confirm the command reaches `applied`. |
| **scratch** | one writer | `markScratchCrashed` (it owns `scratchRuns.dialogStatus` as well as `runs.status` — reconciliation-gc.md's scratch-parity row). Plus the same `applied` confirmation. |

- **Classifier side (out of scope).** Trap 7 stands: the `agent-observer-*` and
  `live-scratch-session` arms keep their own owners and gain no evidence field.

**Phase 0 gates T3.4:** do the agent and scratch owners already mark the command
`applied` on a failed turn? If yes, T3.4 is the one-argument change and nothing
more. Answer it before writing code.

**✅ ANSWERED (Phase 0, 2026-09-21) — YES for both, and the scratch half
collapses further than the plan assumed.**

| Owner | Marks the command `applied` on a failed turn? | Evidence | What T3.4 owes |
| --- | --- | --- | --- |
| **agent** — `agentPromptOwner` (`web/lib/agents/prompt-owner.ts:489`) | **Yes.** On `!succeeded` it prepares `prepareAgentRunFinalization(runId, "Failed", …)` and its `apply` returns `"applied"` (or `"superseded"` when `lockAgentOwner` loses — retirement accepts both, `retirement.ts:174`) | `prompt-owner.ts:553-596` | the one-argument change only: `"Crashed"` instead of `"Failed"` when the settled error reason is `turn_lost`, plus its test |
| **scratch** — `prepareScratchPrompt` (`web/lib/scratch-runs/prompt-owner.ts:201`) | **Yes**, same shape | `prompt-owner.ts:219-267` | **no status change at all.** The scratch owner never decides a TERMINAL run status: on every outcome it calls `applyScratchPromptCompletion`, which transitions the dialog to idle (`turn-completion.ts:56-63`). There is no `"Failed"` to flip. A lost scratch turn is already reconciled by the sweep's existing `markScratchCrashed` arm (`reconcile.ts:1789`). T3.4's scratch half is therefore the retirement assertion and nothing else |

So neither owner strands a command `owner_unapplied`, and **C3's failure mode
does not exist on the agent or scratch paths today**. T3.4 shrinks to: one
argument on the agent owner + two retirement assertions (agent, scratch).

### D5 — Accounting

`turn_lost` joins `NON_CORRECTION_DECISIONS` (`attempt-decisions.ts`). That one
edit fans out to every reader by construction:
`observatory-core.ts:245,259` (both correction counters),
`rework-baseline.ts:51` (the rework budget), `ledger.ts:653-654`.
`MAISTER_MAX_OPERATOR_RESTARTS` is unaffected (**C5**) — assert it, don't change it.

### D6 — Surfacing

`node_attempts.decision` + `error_code` are the durable record (locked
micro-decision: no new `runs.status`, no `runs` error column — B6 stays separate).
The run timeline gets `decisionTurnLost` in **both** catalogs plus an arm in
`decisionLabel` (A13/A14). Sweep summary gains four counters:
`evidencePending`, `evidenceApplied`, `turnLost`, `ownerPoisoned`.

### D7 — No migration

- `node_attempts.decision` is unconstrained `text` — a new value needs no DDL.
- `error_code` is `text` and the writer types it `MaisterErrorCode`; `PRECONDITION`
  is already a member.
- `application_state` already admits `applied`; the coupled CHECK is satisfied by
  stamping `completion_applied_at`.
- Boundedness comes from `commandStreamLost()`, not a durable timer (trap 4), so
  no retry/backoff column is needed.

**And no INDEX is needed either — with evidence, because "no DDL" is not the
same as "no cost".** The probe runs per candidate on a 60 s tick and filters
`run_id = ? AND kind = 'session.prompt' AND owner_ref->>'variant' = 'node' AND
owner_ref->>'nodeAttemptId' = ? ORDER BY created_at DESC LIMIT 1`. There is no
index on `owner_ref` (the nine indexes on the table are listed at
`schema.ts:2355-2451`), but `execution_commands_run_created_idx` on
**`(run_id, created_at)`** (`schema.ts:2358-2361`) already serves it: the leading
column is the equality predicate and the second is the sort, so Postgres walks
that one run's commands newest-first and stops at the first match. A run holds
a handful of commands, so this is a short index scan, not a sequential scan.
**AC-D7.1:** an `EXPLAIN` of the probe on a seeded run shows an Index Scan (or
Index Scan Backward) on `execution_commands_run_created_idx` — recorded in the
Phase-2 task, not assumed.

`0172` is reserved and left unused. The migration task is therefore a **negative
acceptance**: `pnpm --filter maister-web db:generate` reports *"No schema
changes"* and `_journal.json` is untouched (skill-context: `schema.ts` is the
fourth leg of the migration contract).

### D8 — Two rejected alternatives

**(a) Reorder the sweep instead of probing** (**C1**). Moving
`executionCommandReconcilePass()` ahead of `runReconcileSweep()` would make most
evidence fresh without a probe. Rejected — and RQ6 found the hard blocker:
`recovery.ts:390-391` states that `lostStreamHostIds` reads state
`runEventStreamHealthSweep` wrote **earlier in the same pass**. So
`streamHealth (:356) → commandRecovery (:367)` is load-bearing and **two**
stages would have to move, over four intervening passes
(`runSyncRecoverySweep`, `reconcileTerminalCostRollups`,
`ensureLocalExecutionDataPlane`, `runEventStreamHealthSweep`). And the probe
would still be required for the `accepted`-with-no-terminal-evidence window.
Full cost, no saving.

**(b) Map `turn_lost → errorCode:"CRASH"` and let the graph terminalize**
(RQ3). `runner-graph.ts:5291` already turns a `CRASH`-coded node failure into
`runs.status='Crashed'` with the full `run.crashed` webhook + domain event, so
this would be a one-line change in `decodeNodePromptCompletion`. Rejected: that
branch writes `.set({ status:"Crashed", endedAt, currentStepId: null })` and
**never stamps `resume_target_step_id`** (unlike `crashRunningRun`,
`state-transitions.ts:1374`), so `isRunRecoverable` resolves
`currentNodeKind = null` → `discard-only` → the run is `Crashed` **and
unrecoverable**. It would also leave the attempt `Failed`/`decision=NULL`,
forfeiting Scope 4 and Scope 5 entirely.

Both are recorded in ADR-177 as considered-and-rejected.

---

## Contract surfaces → spec files (skill-context rule)

| Surface that changes | Spec file that must move with it |
| --- | --- |
| Reconcile classification table gains an evidence column + 6 rows | `docs/system-analytics/reconciliation-gc.md` (table at `:712-726`) |
| Stale ordering claim | `docs/system-analytics/reconciliation-gc.md:729` (**C1**) |
| `runs.md` invariant 2 restated | `docs/system-analytics/runs.md:328-345` (invariants 1-4) |
| PRM-05 / EDGE-PRM-02 marked as-built with the boundary named; `turn_lost` row added to the recovery-window table | `docs/system-analytics/execution-prompt-lifecycle.md:1100`, `:1112`, `:249` |
| W4 note corrected | `docs/system-analytics/execution-hosts.md:415` |
| ⚠ **Recover's documented evidence rule becomes false** — "agreeing terminal evidence the owner never applied is applied first" no longer holds for `turn_lost` (T3.5) | `docs/api/web.openapi.yaml:8738+` — the `POST /api/runs/{runId}/recover` description AND its plan table (**T0.8**) |
| ⚠ **`run.crashed.errorCode` gains three values, on a field that is undocumented and already carries two different types** | `docs/api/async/outbound-webhooks.asyncapi.yaml:704-712` (`DataRunCrashed`) — **T0.9**. No schema change (`type: string, nullable: true`, no enum), but the prose must move |
| `ExtPulseEventKind` (`docs/api/external/operations.openapi.yaml:4628-4642`) | **untouched** — no new event KIND is added, only new values of an existing field. Checked negative, not an omission |
| New `CrashReason` members otherwise stay internal | no other route or wire surface changes |
| New ADR | `docs/decisions.md` (`### ADR-177:` header + summary) **and** `docs/decisions/adr-177.md` |
| Recover no longer adopts a lost turn as a result (**C9**, T3.5) | `docs/decisions/adr-175.md` gains a one-line amendment pointer to ADR-177; `docs/system-analytics/runs.md` invariant 4 (the Hybrid Recover bullet, `:343+`) names the `turn_lost` exception to "agreeing terminal evidence" |
| S5.2 named scenario + matrix `:859` evidence pointer | `.ai-factory/plans/stage-ab-stabilization.md:788`, `:859` |
| New i18n keys | `web/messages/en.json`, `web/messages/ru.json` (both, same key) |

**No new error code** — `PRECONDITION` already exists, so `docs/error-taxonomy.md`
is untouched. Stated explicitly.

## Deployment touchpoints (skill-context rule)

**None.** This change adds no env var, no config file, no sidecar, no port. The
existing `MAISTER_RECONCILE_GRACE_SECONDS` (`.env.example:395`) keeps its meaning
and its default of 90. `Dockerfile`, `compose*.yml` and `.env.example` are
**deliberately untouched**; the acceptance for the docs phase records this as a
checked negative, not an omission.

## Consumer fanout checklist (skill-context rule)

A new `decision` value and new `CrashReason` members are enum additions. Every
consumer class:

- [x] **Decision readers** — grep over `web/{lib,app,components}` (excluding
      tests) returns EXACTLY nine files: `attempt-decisions.ts` (the definition),
      `ledger.ts` (re-export — `TURN_LOST_DECISION` added so the server-side
      import surface stays complete), `rework-baseline.ts` and
      `observatory-core.ts` (both read the SET, so the one-line addition is the
      whole fan-out — pinned by AC-T4.1.1/.2 through the consumers),
      `layout.tsx` (arm added + both catalogs), `hitl.ts` and `node-interrupt.ts`
      (allow-list of ONE, deliberately unchanged — pinned by AC-T4.1.3 as a
      NEGATIVE regression), `crash-recover.ts` and `turn-lost-boundary.ts` (the
      writers). No reader was missed.
- [x] **`CrashReason` readers** — grep returns `state-transitions.ts` (the
      union + the two writers), `reconcile.ts` (`mapReasonToCrashReason`, the
      only `switch`) and `turn-lost-boundary.ts` (a parameter). The `switch` is
      closed by the exhaustiveness assertion, which is what makes the silent
      `default` harmless.
- [x] **`ReconcileReason` readers** — grep returns only `reconcile.ts` itself:
      the union, `ReconcileDecision`, `mapReasonToCrashReason`, and the sweep's
      own dispatch/counters. Nothing outside the module renders the reason, so
      the six new members reach no UI.
- [x] **Read models** — `board.ts` branches on `runs.status` (`Crashed` already
      a column) and never on the reason; the portfolio does the same. Verified by
      grep, not assumed. Only the run timeline needed an arm.
- [x] **Scheduler / cap** — the boundary's arm runs inside the sweep's existing
      crash dispatch, which already calls `promoteNextPending` after
      `systemCloseActiveAssignmentsForRun`. Inherited, not re-implemented.
- [x] **Sweeps** — no new run status, so no candidate filter changed.
- [x] **Guards** — `EVIDENCE_DECISIONS` is
      `satisfies Record<PromptEvidenceClass, ReconcileDecision | null>`, so a
      future member is a compile error rather than a silent fall-through to
      `agent-session-gone`.

---

## Tasks

### Phase 0 — SDD freeze (docs-first, before any production code)

> Exit criterion for the whole phase: the analytics describe the target
> behaviour completely and consistently, so implementation follows them as the
> single source of truth. No production `web/lib/**` file is edited in Phase 0.

**T0.1 — ✅ DONE at plan time: the graph trace (C8).** The request marked this
SUSPECTED; it is now traced hop-by-hop with `file:line` in **C8** above, and the
answer changes the framing: a lost turn is `Failed`, never retried (structurally
impossible — the code is not in `RETRYABLE_ERROR_CODES` and a flow author cannot
add it), and **`Failed` is not recoverable**. Carry **C8** into ADR-177's
Context verbatim. **Verify:** the ADR's Context states the severity as "a
supervisor restart can permanently burn a run", not as "the wrong reason is
recorded".

**T0.2 — ✅ Write ADR-177.** `### ADR-177: Evidence-first crash classification` in
`docs/decisions.md` (header + summary, next to ADR-176 at `:1781`) and the full
text in `docs/decisions/adr-177.md`. ONE decision. Contains: the D2 priority it
discharges, the decision table (**D2**), the single-boundary rule (**D3**), the
three-sided claim (**C3**), the agent/scratch split (**D4**), the rejected
reorder (**D8**), and the accepted residual windows. Amends — does not replace —
ADR-033. **Verify:** `pnpm validate:docs:adr` resolves the anchor.

**T0.3 — ✅ reconciliation-gc.md: the evidence-first classification table.**
Add an `evidence` column to the table at `:712-726` and one row per
`PromptEvidenceClass` value, each naming **its writer** and **its terminal
shape**. Fix the stale ordering claim at `:729` (**C1**) — state the real
`runSystemSweep` order with line references. **Verify:** every row in the doc
table has a corresponding arm in the D2 table above; no row describes code that
will not exist at this branch's HEAD (R6).

**T0.4 — ✅ runs.md: restate invariant 2, amend invariant 4, add the recovery-window row.**
Invariant 2 (`:336-339`) becomes *"the grace guard applies only when no command
evidence exists"*, with the evidence arms named. Invariant 4 (`:343+`, Hybrid
Recover) gains the **C9** exception: *"agreeing terminal evidence" excludes a
`turn_lost` result — a lost turn is not a result, and Recover re-dispatches*. Add
the normative `status × evidence → arm` recovery-window table the skill-context
rule requires for anything that parks a run. **Verify:** every Expectation bullet
names what enforces it (a CAS, a claim, a constraint, a test) — R5a.

**T0.5 — ✅ execution-prompt-lifecycle.md: PRM-05 and EDGE-PRM-02 as-built.**
Mark both `(Implemented)` with the boundary named — `Crashed` + attempt
`turn_lost` + Recover — and add the `turn_lost` row to the recovery-window table
at `:249`. **Verify:** the as-built claim cites the suite that proves it (filled
in Phase 5; a placeholder here is a Phase-5 blocker, not a Phase-0 pass).

**T0.6 — ✅ execution-hosts.md: correct W4.** `:415` becomes
*"failed {turn_lost} — the attempt is closed `turn_lost` and the run is
`Crashed`, recoverable"*. **Verify:** the Mermaid block still parses
(`pnpm validate:docs`).

**T0.7 — ✅ Amend stage-ab-stabilization.md.** S5.2 (`:788`) gains the named
scenario *"supervisor restart mid-turn → `turn_lost` explicit → Recover →
`Done`"*; the matrix row at `:859` gains an evidence pointer (filled green in
Phase 5). K05/K04 untouched. **Verify:** no other S-row is edited.

**T0.8 — ✅ `web.openapi.yaml`: the Recover contract's `turn_lost` exception.**
The `POST /api/runs/{runId}/recover` description (`:8738+`) currently states
*"agreeing terminal evidence the owner never applied is applied first and the
graph continues with no second paid turn"*. T3.5 makes `turn_lost` an explicit
exception. Amend the prose AND add a row to the plan table: recover target =
agent node, evidence = `turn_lost` → the evidence is **declined and superseded**,
the attempt is closed, one fresh prompt is dispatched.
**AC-T0.8.1** No status code, request body or response schema changes — this is
a semantics correction only; say so in the task's commit body.

**T0.9 — ✅ `outbound-webhooks.asyncapi.yaml`: document `DataRunCrashed.errorCode`.**
The field (`:704-712`) has **no description**, while its sibling
`DataRunFailed.errorCode` is documented as "`MaisterError.code`". In reality
`run.crashed.errorCode` carries a **`CrashReason`** when `crashRunningRun`
emits it and a `MaisterErrorCode` when `runner-graph.ts:5316` does. Document
both sources and list the `CrashReason` values, including the three new ones.
**AC-T0.9.1** The schema itself is unchanged (`type: string, nullable: true`,
no `enum`) — adding an enum would break the `runner-graph` writer. Prose only.
**AC-T0.9.2** `ExtPulseEventKind` is verified untouched (no new event kind).

**Phase 0 exit:** `pnpm validate:docs:all` and `pnpm validate:contracts` green;
`git diff --stat` touches only `docs/**` and `.ai-factory/plans/**`; **every
Phase-0 doc states the target behaviour completely enough that Phases 2-4 need
no design decisions** — a task that has to invent a rule at code time means
Phase 0 was not finished.

---

### Phase 1 — RED controls (fail for a NAMED reason on this HEAD)

> Every control runs against a **real supervisor fixture and real Postgres**.
> Only the two cases that need live durable workers also run the PRODUCTION web
> (`startRealWeb`) — see **RQ4** for the allocation table and why the request's
> blanket "all controls run the production web" is over-specified.
>
> **Get past the 90 s grace by backdating the attempt's `started_at`**, never by
> waiting and never by shrinking `MAISTER_RECONCILE_GRACE_SECONDS`
> (`reconcile-sweep.integration.test.ts:608,642` is the in-repo precedent; RQ4
> explains why backdating is the stronger assertion).
>
> Registration is part of the task (skill-context: *runnability*) — a suite no
> runner globs is not a deliverable.

**T1.1 + T1.3 — ✅ RED 1 and RED 3 as ONE parameterized family (RQ5).**
Extract V3's body in
`web/lib/execution-host/__tests__/command-recovery.integration.test.ts`
(**C2**) into a helper over two axes — `preSettle` (does the case call
`recoverExecutionCommands` manually, as today's V3 does, or reproduce the
production tick order, **C1**) × ingest order (sweep-first / ingest-first).
`preSettle: true` **is** today's V3, unchanged in what it asserts. Each of the
three new cells pays one ~180 s supervisor restart instead of three separate
cases each paying their own.

Per cell: launch an `ai_coding` prompt to `accepted`; `sup.restart()` (SIGKILL +
same state dir); force one sweep tick.
Assert: command settled `failed {turn_lost}`; attempt closed
`decision='turn_lost'` with `error_code`; run `Crashed` with
`resume_target_step_id` set; `isRunRecoverable` true. Then `POST /recover` →
`Done` through ADR-175 with **exactly one** new `session.prompt`.
**On this HEAD the observed wrong outcome is known (C8), so assert it exactly:**
`runs.status='Failed'` (not `Crashed`), attempt `status='Failed'` with
`decision=NULL`, `isRunRecoverable` **false** — with the failure message naming
*"a supervisor restart burned the run: `Failed` is not recoverable"*.
**Verify:** the case fails with that message, not an import error.
(The `→ Done` half does **not** depend on T3.5 — see **C9** reachability.)

**T1.2 — ✅ RED 2: evidence pending, run already past grace.** *(`isolation` — one
of the two cases that need live durable workers.)*
Adapter finishes the turn; hold ingest (retain the stream claim / stop the
consumer) so the terminal event stays on the host. **Backdate the attempt's
`started_at`** so the run is definitively past grace (RQ4 — not a wait, not a
grace override; `reconcile-sweep.integration.test.ts:608,642` is the precedent).
Force a sweep tick → expect `skip evidence-pending` (the receipt probe says
`completed`), **not** `agent-session-gone`. Release ingest → the owner worker
applies → the run continues.

Budget: the release costs at most ONE `CLAIM_LEASE_MS` (30 000,
`events/consumer.ts:19`) if the consumer was killed, and ~0 if it was stopped
cleanly — so budget one lease plus headroom, not three (trap 5 was written for
the wait-it-out design this replaces). **On this HEAD:** crashed.
**Verify:** the assertion names `evidence-pending`, and the test proves the
sweep actually ran (a counter delta), not merely that it did not crash.

**T1.3 — ✅ RED 3: order independence** *(the same family as T1.1 — RQ5)*.
The two ingest-order cells assert an **identical** terminal row set (run,
attempt, command) including `completion_applied_at` being non-null exactly once.
Agent-run and scratch get their own cases against their own choke points
(**D4** as revised), not cells of this matrix. Attribute by **authorship, not
timing** (A15). **On this HEAD the divergence is exactly known (C8):**
sweep-first → `Crashed` + attempt `Failed`/`decision=NULL`; worker-first →
`Failed` + the same attempt, because the owner's terminal write CAS-guards on
`Running` (`runner-graph.ts:5277-5286`) and loses after a crash. Assert both
observed shapes by name so the RED is unambiguous.

**T1.4 — ✅ RED 4: poisoned owner.**
A poisoned application (and, as a second case, a `quarantined`
`prompt_terminal_conflict`) → `crash owner-poisoned` with `error_code` on the
attempt; Recover follows ADR-175's quarantine rule — never a re-prompt from
disagreeing evidence.

**T1.5 — ✅ RED 5: no-evidence regression guard, SPLIT to remove overlap.**
Two halves, because they prove different things and only one costs anything:

- **Pure (free).** A `classifyRunReconcile` case with `promptEvidence: "none"`
  past grace → `crash / agent-session-gone`. Joins the existing 51-case file; no
  Postgres, no supervisor. This is the classifier half.
- **Integration (one cheap case).** A run with a `queued` command (never
  `accepted`) → the **builder derives `none`**. This is the only half that needs
  a database, and it is the half the pure case cannot reach.

Do NOT write one integration case that asserts both — that is the overlap this
split removes. **Both must be GREEN on this HEAD**: they are the guard that the
change does not move the `none` path.

**T1.6 — ✅ RED 6: retirement, BOTH discharge paths (C13).**
`classifyCommandRetirement` returns `null` (not `owner_unapplied`) for:
(a) a command the **boundary** settled `applied` — already at run status
`Crashed` (**C7**), and again after Recover → `Done`; and
(b) a command **T3.5** settled `superseded` when Recover declined it.
Asserting only (a) would let the C13 hole ship. **On this HEAD:** both
`owner_unapplied`.

**T1.7 — ✅ Register the suites, per the RQ4 allocation.** `isolation` takes ONLY
the two cases that call `buildProductionWeb` (it is a `SERIAL_SLICE`); every
other case goes to `web`. `command-recovery` is already in `laneSuites.web`, so
the merged RED 1/RED 3 family needs no new registration there.
**No new slice key** — see RQ4 §3. **Verify:** `pnpm test:stage-ab-lane` passes
and `vitest list` matches every new file.

**✅ PHASE 1 EXIT RECORD (2026-09-21, this host, Node 24.15.0)**

**Failure SET on this HEAD** — every entry fails on an ASSERTION with its own
message; zero import errors, zero fixture defects (three fixture defects were
found and fixed first: a wrong column name, the `terminal_evidence` triple, and
the one-active-stream-per-host uniqueness).

| Suite | Case | Observed on HEAD |
| --- | --- | --- |
| `reconcile-sweep` | RED 1 turn_lost | run IS `Crashed` and `resume_target_step_id` IS stamped — by AGE; the attempt stays `Running`/`decision=NULL` |
| `reconcile-sweep` | RED 1b flat shape | `decision` null |
| `reconcile-sweep` | RED 2a pending_application | `Crashed` (should be `Running`) |
| `reconcile-sweep` | RED 2b pending_ingest | `Crashed` |
| `reconcile-sweep` | RED 2c inflight | `Crashed` |
| `reconcile-sweep` | RED 2d applied | `Crashed` |
| `reconcile-sweep` | RED 2e stream-lost | `decision` null |
| `reconcile-sweep` | RED 4a poisoned | `decision` null |
| `reconcile-sweep` | RED 4b quarantined | `decision` null |
| `reconcile-sweep` | RED 6 retirement | `owner_unapplied` |
| `command-recovery` | RED 1/3 × 3 ingest orders | attempt `Running`/`decision=NULL` in all three |
| `command-recovery` | RED 3 worker-first | same |
| `command-recovery` | RED 2 held ingest | `Crashed` (should be `Running`) |
| `crash-recover-turn-lost` | AC-T3.5.1 / 1b | outcome `applied` — **HEAD ADOPTS the lost turn**, the C9 defect, observed directly |
| `crash-recover-turn-lost` | AC-T3.5.2 | command `pending` (should be `superseded`) |

**GREEN on this HEAD** (the regression guards — they must stay green after):
`reconcile-sweep` RED 5b (`queued` → `none`) and RED 5c (scratch scope guard);
`crash-recover-turn-lost` AC-T3.5.3 (an ordinary agreeing failure is still
adopted), AC-T3.5.3b (quarantine still answers `quarantined`), both
agent/scratch parity rows, the agent `Crashed` finalize, and the
attempt-scoped-evidence case. `crash-recover-turn-lost` measured **3 failed /
6 passed**.

**Case × property matrix** — every property owned at least once; no property
owned by more than one INTEGRATION case (a pure case beside an integration one
is the deliberate RED 5 split, not overlap).

| Property (D1/D2/D3/D5 + AC-*) | Owning case | Layer |
| --- | --- | --- |
| `none` past grace → `agent-session-gone` | `reconcile-classify` "agent + past grace" (pre-existing) | pure |
| builder derives `none` from a `queued` row | RED 5b | integration |
| scratch keeps its own arm (trap 7) | RED 5c | integration |
| `applied` → skip `evidence-applied` | RED 2d | integration |
| `pending_application` → skip `evidence-pending` | RED 2a | integration |
| `pending_ingest` (probe `completed`) → skip | RED 2b | integration |
| `inflight` (probe `accepted+inflight`) → skip | RED 2c | integration |
| pending ∧ stream `lost` → crash `stream-lost` | RED 2e | integration |
| `turn_lost` → crash `turn-lost` + boundary row set | RED 1 | integration |
| the FLAT error shape classifies identically (C14) | RED 1b | integration |
| `poisoned` → crash `owner-poisoned`, diagnostic preserved | RED 4a | integration |
| quarantine ordering (row 3 before row 5) | RED 4b | integration |
| retirement eligible at `Crashed` AND at `Done` | RED 6 | integration |
| a REAL host restart reaches the same row set | `command-recovery` RED 1/3 boot-order cell | integration (real supervisor) |
| … under the production TICK order | RED 1/3 tick-order cell | integration (real supervisor) |
| … with the receipt probe as the ONLY path | RED 1/3 probe-only cell | integration (real supervisor) |
| … with the OWNER writing first (order independence) | RED 3 worker-first | integration (real supervisor + live worker) |
| a held-ingest skip hands off to a writer that finishes | RED 2 held ingest | integration (real supervisor + live worker) |
| Recover DECLINES a lost turn | AC-T3.5.1 (+1b for the flat shape) | integration |
| Recover DISCHARGES it `superseded` | AC-T3.5.2 | integration |
| the ADR-175 adopt arm is untouched | AC-T3.5.3 | integration |
| the ADR-175 quarantine arm is untouched | AC-T3.5.3b | integration |
| agent/scratch leave no `owner_unapplied` | parity `it.each` | integration |
| an agent lost turn finalizes `Crashed` | agent finalize case | integration |
| evidence is attempt-scoped (why T3.5 must discharge) | attempt-scoped case | integration |

Deleted as adding no uncovered column: none — every case above was written
against a column of this matrix. **No trivial cases**: nothing here restates a
constant or a type; every assertion goes through a consumer (the sweep, the
recover path, or `classifyCommandRetirement`).

Deferred to their own phases, deliberately: the boundary's own loser-path suite
(a Phase-3 deliverable — its module does not exist, and a missing-module failure
is not a RED for a named reason), and the pure classifier cases for the D2 table
(Phase 2 — the two `ReconcileInput` fields do not exist yet, and a commit that
fails `typecheck` is not a deliverable).

**Phase 1 exit:**

1. Every RED case fails for its **stated** reason (RED 5's two halves pass); no
   case fails by import error or fixture defect.
2. Failure SETS recorded for the Phase-5 comparison against `master`.
3. **Overlap audit.** Write the case × property matrix: one row per case, one
   column per property from the **D1**/**D2** tables and the **AC-*** list.
   Every property has **at least one** owning case; no property has **more than
   one** integration case claiming it (a pure case plus an integration case is
   fine when they prove different layers — that is the RED 5 split, not
   overlap). A case that adds no uncovered column is deleted, not kept "for
   safety".
4. **No trivial cases.** A case that restates a constant or a type
   (`NON_CORRECTION_DECISIONS.includes("turn_lost")`, "the enum has six
   members") is banned. Assert the **effect** instead: the budget that excludes
   it, the counter that drops it, the classifier arm that reads it.

---

### Phase 2 — The evidence probe and the classifier

**T2.1 — ✅ `web/lib/reconcile-evidence.ts` (pure).** `PromptEvidenceClass` and
`classifyPromptEvidence(row, probe?)` implementing the **D1** derivation order as
an exhaustive `satisfies` map. Pure — no `server-only`, no db — so the classifier
unit suite can import it. Unit tests: one case per row of the D1 table plus the
order-sensitivity case (settled `turn_lost` with `applicationState='pending'`
resolves `turn_lost`, not `pending_application`).

**T2.2 — ✅ The builder probe.** In the per-candidate enrichment block at
`reconcile.ts:1561-1601`, immediately beside the `crashRecoverPending` inline
computation at `:1579-1582` (**A2c**) — so it inherits `PER_PASS_CONCURRENCY`
and needs no new bounding. For a flow candidate with no live session on an agent
node: load the current attempt's newest owned `session.prompt` with the
**A12b lookup, reused not re-written** (`owner_ref->>'variant'='node'`,
`owner_ref->>'nodeAttemptId'`, `ORDER BY created_at DESC LIMIT 1`), then
`commandStreamLost()`, then the conditional `GET /commands/{id}`. A probe error
yields `pending_ingest`. Logging (standard): one INFO per candidate that actually
probed, with `{runId, commandId, evidence, streamLost}`.

**T2.3 — ✅ The classifier arms.** Insert the **D2** table into `classifyInner`
**between arm 10a and arm 10b** (`reconcile.ts:478-483`, **A2**) — after the
ADR-175 `crashRecoverPending` delegate, before the grace anchor. Arms 9 (`cli`)
and 11 (gates) are untouched. New `ReconcileReason` members bring the union from
20 to 26: `evidence-applied`, `evidence-pending`, `evidence-inflight`,
`turn-lost`, `stream-lost`, `owner-poisoned`. **Extend the existing 51-case pure
suite** rather than starting a new file.

**T2.4 — ✅ Close the `CrashReason` gap (C6).** Add `turn-lost`, `stream-lost`,
`owner-poisoned` to the union (`state-transitions.ts:1334`) and `case` arms to
`mapReasonToCrashReason` (`reconcile.ts:603`). Add a unit assertion that every
crash-classified `ReconcileReason` maps to a **distinct** `CrashReason` — an
exhaustiveness check, so the `default:` can never silently absorb a new member.

**T2.5 — ✅ Sweep counters.** `evidencePending`, `evidenceApplied`, `turnLost`,
`ownerPoisoned` — added in **all three places** (**A2d**): the
`ReconcileSweepSummary` interface (`:527-571`), `ZERO_SUMMARY` (`:573-588`), and
the returned literal (`:2096-2111`). Missing any one is a silent zero.
One INFO line per tick that had a non-zero delta. **Verify:**
`reconcile-sweep.integration.test.ts` asserts the new counters alongside the
existing ADR-175 ones, with no existing expectation loosened; and
`web/lib/scheduler/__tests__/system-sweeps.test.ts:92` (which pins a summary
literal) still compiles.

**✅ PHASE 2 EXIT RECORD (2026-09-21).** **GREEN** — RED 2a/2b/2c/2d (all four
skip arms) and RED 5b/5c now pass; RED 1, 1b, 2e, 4a, 4b and 6 stay red for
their stated reason (the boundary does not exist yet), which is exactly the
split this gate predicts. Full `test:unit`: **806 files / 8244 tests, 0
failures**. `typecheck` clean. **AC-D7.1 recorded as a test**, not a one-off
run: `EXPLAIN` under `enable_seqscan = off` names
`execution_commands_run_created_idx` and no `Seq Scan` — deterministic on a
fixture-sized table, where the planner would otherwise pick a sequential scan
for two rows whatever indexes exist. **D7's negative acceptance**:
`db:generate` reports *"No schema changes, nothing to migrate"* and
`_journal.json` is untouched.

**One existing expectation changed, classified OBSOLETE (not broken):**
`reconcile-sweep.integration.test.ts`'s "zeroed summary when listSessions
throws" pins the WHOLE `ReconcileSweepSummary` literal, so it grew by the four
new zeros. That is the assertion working as designed — a counter added without
a `ZERO_SUMMARY` entry is a silent zero on every skipped tick. No expectation
was loosened.

**REFACTOR done:** `classifyPromptEvidence` is ONE pure function serving the
builder, the unit suite and the analytics table; the grace anchor still has
exactly TWO copies (`reconcile.ts`, `crash-recover-route.ts`) — the probe reuses
`latestAttemptRow` rather than adding a third read; the evidence arms are an
exhaustive `satisfies Record<PromptEvidenceClass, …>` map, so a future member is
a compile error; and the Phase-1 typed counter view was deleted now that the
fields exist. Suites re-run after the refactor.

**Phase 2 exit (GREEN → REFACTOR):**
**GREEN** — RED 2 and RED 5's two halves green; RED 1/3/4/6 still red (the
boundary does not exist yet); `pnpm --filter maister-web test:unit` green;
`pnpm --filter maister-web typecheck` clean; **AC-D7.1** (the `EXPLAIN`) recorded.
**REFACTOR** — with the cases green: `classifyPromptEvidence` is ONE pure
function serving the builder, the unit suite and the docs table (DRY — no second
copy of the derivation order); the grace anchor still has exactly two copies
(**A2e**), not three; the evidence arms are an exhaustive `satisfies` map, not
an `if`-chain with a fallthrough (KISS + the allow-list rule). Re-run the suites
after refactoring — a refactor that is not re-measured is a hope.

---

### Phase 3 — The shared crash boundary

**T3.1 — ✅ `web/lib/runs/turn-lost-boundary.ts`.** `applyTurnLostBoundary()` per
**D3**: claim → one transaction (attempt close + `crashRunningRun` +
`applied`/`completion_applied_at`) → post-commit `promoteNextPending`. Returns a
discriminated result (`"applied" | "not-claimed" | "lost-cas"`); the two
non-applying results write nothing and log INFO. Unit + integration tests for
the loser path specifically — an empty attempt-guard result must roll the whole
transaction back, never half-apply.

**T3.2 — ✅ Wire the reconcile `turn-lost` / `owner-poisoned` arms** to T3.1 instead
of a bare `crashRunningRun`.

**T3.3 — ✅ Wire the flow node prompt owner and the gate owner.** A failed host
result whose `details.reason === 'turn_lost'` (matched on the settled command's
`lastError`, never on HTTP status — trap 2, v1 **and** v2 payloads via
`commandReceiptPayloadV2`) routes to T3.1 instead of an ordinary failed node
action. Everything else on those paths is unchanged.

**T3.4 — ✅ Agent and scratch owners (D4 as revised; gated on the Phase-0 answer).**
NOT the shared boundary. Agent: `finalizeAgentRun(runId, "Crashed", …)` instead
of `"Failed"` when the settled command's `details.reason === 'turn_lost'` —
`AgentTerminalOutcome` already admits `"Crashed"` (`finalization.ts:75`).
Scratch: `markScratchCrashed`, so `scratchRuns.dialogStatus` moves with
`runs.status`. **The load-bearing half of this task is the assertion, not the
status**: a failed-turn command must reach `application_state='applied'`, or it
strands `owner_unapplied` and blocks deleting the run (**C3**). If Phase 0 finds
both owners already apply it, this task is the one-argument change and its test.
**Verify:** `classifyCommandRetirement` returns `null` for an agent run and a
scratch run whose turn was lost — the same assertion RED 6 makes for flow.

**T3.5 — ✅ Make Recover refuse to adopt a lost turn as a result, AND discharge it (C9 + C13).**
`applyCrashedTurnEvidence` (`crash-recover.ts:169-178`, the post-`settled`
filter chain) gains one arm: a settled command whose
`lastError.details.reason === 'turn_lost'` returns a new `"turn-lost"` outcome
instead of decoding it into a `FlowActionCompletion`. `recover.ts:492`'s caller
treats `"turn-lost"` like `"absent"` for routing — close the crashed attempt and
re-dispatch a fresh one under the new epoch. Additive to ADR-175; its
`"quarantined"` and `"applied"` arms are untouched.

⚠ **Refusing is not enough — the arm MUST also settle the command (C13).**
Declining without settling leaves `application_state = 'pending'` forever:
`retirement.ts:171-176` then answers `owner_unapplied` and
`execution_commands_protected_evidence` blocks deleting the run — the exact
failure **C3** exists to prevent. The arm writes
`application_state = 'superseded'` + `completion_applied_at = now()` in the same
transaction that closes the attempt. `superseded` is the existing first-class
disposition for "the obligation is discharged, the result was consciously not
applied" (`PromptOwnerDisposition`, `prompt-owners.ts:12`) and retirement
already accepts it (`retirement.ts:174`). The split is deliberate:

| Path | Disposition | Why |
| --- | --- | --- |
| **D3** boundary | `applied` | it acted ON the evidence — the crash IS the application |
| **T3.5** Recover decline | `superseded` | a fresh attempt replaced the lost turn; nothing was applied |

**AC-T3.5.1** A run crashed `worktree-gone` (NOT `turn-lost`, so its attempt
stays open) carrying a settled-unapplied `turn_lost` command → Recover
re-dispatches with **exactly one** new `session.prompt` and does not adopt the
lost turn. RED 1 does **not** reach this arm (**C9** reachability), so this is
its own control or the task ships unverified.
**AC-T3.5.2** After that Recover, `classifyCommandRetirement` on the old command
returns `null` (not `owner_unapplied`) once the run is terminal and past grace.
**AC-T3.5.3** `applyCrashedTurnEvidence`'s `"applied"` and `"quarantined"` arms
are byte-identical to master — proven by `recover.integration` staying green
with no changed expectation.

**Phase 3 exit (GREEN → REFACTOR):**
**GREEN** — RED 1, RED 3, RED 4, RED 6 (both discharge paths) and AC-T3.5.1-3
green. `pnpm --filter maister-web test:integration` green.
`recover.integration` green with its ADR-175 expectations intact.
**REFACTOR** — the boundary is ONE function with ONE transaction, called by the
two flow writers (SRP: it decides nothing about *when* to fire — its callers do);
agent and scratch reuse their own choke points rather than a copied transaction
(DRY); the `superseded` vs `applied` split is expressed once, in the boundary's
signature, not re-derived at each call site. Re-run the suites after refactoring.

---

### Phase 4 — Accounting and surfacing

**T4.1 — ✅ `turn_lost` joins `NON_CORRECTION_DECISIONS`** (`attempt-decisions.ts`),
with the comment explaining why a host restart is not a correction. Assert the
fan-out: both Observatory counters, the rework budget, and — as a *negative*
regression — that `MAISTER_MAX_OPERATOR_RESTARTS` is unchanged (**C5**).

**Plus the third Observatory surface (C11), deliberately:** `clusterRetrySignals`
does NOT filter on `decision`, so `turn_lost` attempts DO reach the signal
clusters. That is the chosen behaviour — a host that keeps restarting is a real
operational signal, unlike a correction counter, which measures agent quality.

**AC-T4.1.1** The rework budget (`rework-baseline.ts:51`) does not charge a
`turn_lost` close.
**AC-T4.1.2** Both Observatory correction counters
(`observatory-core.ts:245,259`) drop it.
**AC-T4.1.3** The operator-restart budget is **unchanged** — a run with N
`turn_lost` closes still gets its full `MAISTER_MAX_OPERATOR_RESTARTS` (**C5**;
a negative regression, and the only one that would catch a careless widening of
`hitl.ts:5253` from the one-value allow-list to `NON_CORRECTION_DECISIONS`).
**AC-T4.1.4** The retry-signal cluster appears with `errorKey = "CRASH"`.

⚠ **No trivial restatement.** `NON_CORRECTION_DECISIONS.includes("turn_lost")`
is not a test — it asserts the line above it. Every AC here goes through the
consumer.

**T4.2 — ✅ Timeline label.** `decisionLabel` arm (A13) + `decisionTurnLost` in
**both** `web/messages/en.json` and `web/messages/ru.json` (A14). **Verify:** the
key exists in both catalogs; a missing RU key renders the raw token.

**T4.3 — ✅ Walk the consumer fanout checklist** above and record each line as
checked-with-evidence (a grep result or a test), including the negatives.

**Phase 4 exit (GREEN → REFACTOR):**
**GREEN** — full `pnpm --filter maister-web test` green; every `AC-*` in Phases
0-4 checked off by name, not in bulk.
**REFACTOR** — `turn_lost` is a named constant beside `CRASH_RECOVER_DECISION`
in `attempt-decisions.ts`, never a string literal at a call site (the file's own
stated reason for existing); the i18n key exists in both catalogs with no
English fallback left in the RU file.

---

### Phase 5 — Falsification and lane green

**✅ T5.1 FALSIFICATION RESULT (2026-09-21).** Both reverts were applied behind a
temporary env flag, measured, and reverted.

**(a) Revert the classifier arms** (`evidenceClassification` returns `null`):
**10 of the 13** ADR-177 sweep cases go red, each for its ORIGINAL stated reason
— RED 2a/2b/2c/2d `expected 'Crashed' to be 'Running'`, RED 1/1b/2e/4a/4b
`decision` null, RED 6 `owner_unapplied`. The three that stay green are exactly
the ones that must: RED 5b and RED 5c (the no-evidence and scratch-scope guards,
which do not depend on the arms) and AC-D7.1 (an `EXPLAIN`).

**(b) Revert the owner-side boundary** (T3.3's `turnLost` forced false): the
worker-first case goes red with `expected 'Running' to be 'Crashed'`.

That second failure mode is worth reading carefully, because it is **C10 made
visible**. Without T3.3 the owner DECODES the lost turn into an applied failed
completion, so the sweep then classifies the run `applied` and SKIPS it — the
run does not even reach a wrong terminal state, it reaches none, and in
production the continuation worker would drive it to `Failed`. The
`evidence-applied` skip arm is only correct because T3.3 exists, which is the
precise reason commits 3 and 4 must land in one merge.

**T5.1 — ✅ Falsification.** Revert the evidence probe (T2.2/T2.3) → RED 2 must go
red **for the stated reason**; revert the owner-side boundary (T3.3) → RED 3's
worker-first order must go red. Name the exact failing assertion for each; a
revert that leaves a test green means the test proves nothing (project rule:
*falsify every regression guard*).

**✅ T5.2 RESULT (2026-09-21) — two expectations changed, BOTH classified
OBSOLETE, none loosened.** The stage-AB `web` lane ran 32 suites / 438 cases and
returned exactly two failures, both in `lib/flows/graph/__tests__/prompt-owners.integration.test.ts`'s
ADR-175 `owner-flow-crash-recover` family:

| Case | Old expectation | Classification |
| --- | --- | --- |
| `before_terminal` recover | the closed attempt carries `decision='crash_recover'` | **Obsolete.** The fixture kills the adapter and freezes the COMMAND's terminal columns — not the host's receipt — so the probe asks the real supervisor, is told the turn is gone, and the run is crashed `turn-lost`. The boundary therefore closes the attempt at CRASH time and Recover's `closeCrashedNodeAttempts` finds nothing left to mark. Everything the contract depends on still holds and is still asserted: the attempt IS closed, the graph appends a fresh attempt under the new epoch, exactly one new prompt is issued, and both decisions are in `NON_CORRECTION_DECISIONS`. |
| `before_apply` recover | `summary.crashed >= 1` | **Obsolete, and it encoded the defect.** The turn FINISHED and only its owner application was outstanding — the exact state ADR-177's Context calls failure #1. The sweep now declines to crash it. The assertion is INVERTED rather than deleted (`crashed` must be `0`), so the improvement is pinned inside the ADR-175 suite; the fixture then produces the state ADR-175 needs the way ADR-177 says it is now reached — a run crashed for some OTHER reason while its evidence was unapplied. |

Re-run after the fix: **5/5 green**, and the other three callers of that fixture
were unaffected throughout. Other named suites, all green with no changed
expectation: `reconcile-classify` (unit), `reconcile-sweep` (49),
`command-recovery` (14, V3 byte-identical), `recover.integration` +
`crash-recover-continuation` (31), agent + scratch `prompt-owners` (53),
`state-transitions-crash` + `command-retirement` (15),
`turn-lost-boundary` (7), `crash-recover-turn-lost` (9),
`reconcile-evidence` + `turn-lost-accounting` (unit).

⚠ **This surfaced a CONTRACT interaction, not just a test fix**, and it is now
recorded in ADR-177 and `runs.md`: ADR-175's Scope-2 arm keeps its contract but
loses its most common ENTRY PATH, because the sweep used to manufacture
"`Crashed` while holding unapplied agreeing evidence" by crashing runs whose
result was still arriving. It stays reachable through the population D5 already
names, and through every row crashed before this ships.

**T5.2 — ✅ Existing suites, no loosened expectations.** `reconcile-classify`,
`reconcile-sweep`, both `prompt-owners` lanes (flow + agent),
`durable-workers-boot`, `recover.integration`, `command-recovery`,
`crash-recover-continuation`. For every changed expectation state **obsolete vs
broken**; **C2** pre-classifies V3 as *under-specified* (extended, not changed).

**T5.3 RESULTS (2026-09-21, this host, Node 24.15.0 via nvm — the homebrew
default is 26.3.0, which this repo does not support):**

| Gate | Result |
| --- | --- |
| `pnpm --filter maister-web test:unit` | **807 files / 8249 tests, 0 failures** |
| `node scripts/run-stage-ab-tests.mjs web` | **32 suites / 438 tests** — 2 failures, both obsolete (T5.2), fixed and re-verified 5/5 |
| `node scripts/run-stage-ab-tests.mjs isolation` | **3 suites / 15 tests, 0 failures** |
| `pnpm --filter maister-web typecheck` | clean |
| `pnpm --filter @maister/supervisor typecheck` | clean (and `supervisor/` has ZERO diff — this change is web-side only) |
| `pnpm --filter maister-web lint` | **0 errors / 14 warnings** — the recorded baseline, unchanged |
| `pnpm validate:docs:all` | green (458 mermaid blocks, 892 ADR anchors, 3475 links, 138 indexed files, `db:erd --check` current) |
| `pnpm validate:contracts` | green (9 contracts + 5 adapter mirrors) |
| `pnpm --filter maister-web db:generate` | **"No schema changes, nothing to migrate"** — D7's negative acceptance |
| `pnpm --filter maister-web test:integration` (full lane) | **496 files / 4350 tests, 5 failures** — all four files classified below, none a regression |

**The full-lane failures, classified by the project rule (re-run one file idle
and compare name sets — memory: *integration lane load sensitivity*).** Load
during the lane was 71-78 on 16 cores; re-runs were taken at load < 6 with zero
vitest processes.

| File | Full lane | Idle re-run | Verdict |
| --- | --- | --- | --- |
| `lib/execution-host/__tests__/deliverer.integration.test.ts` (D3) | ✕ | ✓ | **load-sensitive** — 2 files / 16 tests green |
| `lib/execution-host/events/__tests__/projection-worker.integration.test.ts` (AT-03) | ✕ | ✓ | **load-sensitive** — same run |
| `lib/agents/__tests__/prompt-owners.integration.test.ts` (`owner-agent-budget 'escalate' … 'before_terminal'`) | ✕ | ✓ | **load-sensitive** — 50 tests green, all 8 budget-source cells pass |
| `test-support/__tests__/durable-workers-concurrency.integration.test.ts` (D2, E) | ✕ | ✓ in the `isolation` slice | **structural** — it is a `SERIAL_SLICES` suite that spawns TWO production web instances and is designed to own the host; the parallel `test:integration` lane is the one condition it cannot tolerate. It passed 3/3 suites / 15 tests when run as `run-stage-ab-tests.mjs isolation` minutes earlier |

None of the five touches the reconcile classifier, the boundary, the prompt-owner
turn-lost branches or the Recover arm. Every suite that DOES was run directly and
is green.

**T5.3 — ✅ Full gates on a quiet machine.**
`pnpm --filter maister-web test:unit` · `test:integration` ·
`node scripts/run-stage-ab-tests.mjs web` · `… isolation` ·
`pnpm --filter maister-web typecheck` · `pnpm --filter @maister/supervisor typecheck` ·
`pnpm --filter maister-web lint` (baseline 0 errors / 14 warnings — and
`lint` is `eslint --fix`, so check `git status` before staging) ·
`pnpm validate:docs:all` · `pnpm validate:contracts` ·
`pnpm --filter maister-web db:generate` reporting **"No schema changes"** (**D7**).
Compare failure **SETS** against `master`, not counts. `pmset -g log` before
attributing any timeout to the change. Grep each lane for `| N skipped`.

**✅ T5.4 RESULT (2026-09-21, quiet host, `--workers=2` per the repo's own
measurement that 4 oversaturates this Mac).** `pnpm exec tsx e2e/run.ts
--workers=2`: **183 passed, 5 failed, 4 flaky, 1 did not run.**

(An earlier attempt reported `No tests found` in 27 lines — `pnpm test:e2e --
--workers=2` sends `--workers=2` THROUGH pnpm's `--`, where Playwright reads it
as a spec filter. Invoke the runner directly. Not a test result.)

| Failure | Attribution |
| --- | --- |
| `platform-agents-page.spec.ts:26` | **master** — named in `web/CLAUDE.md`'s measured master set |
| `review-diff-scopes.spec.ts:43` | **master** — named there, at this exact line |
| `studio-ai-assistant.spec.ts:69` | **master** — named there ("needs a real ACP turn from the test supervisor") |
| `push-notifications.spec.ts:103` | **pre-existing, PROVEN by a control** (below) |
| `work-table.spec.ts:97` | **pre-existing** — flaky-then-passing in isolation, same signature |

Both unexpected entries are **strict-mode violations**: two DOM nodes match one
`data-testid` (`notifications-panel`, `work-empty`). They were NOT written off as
load — both fail deterministically in a 2-spec isolated run — so the branch's
ENTIRE UI delta was reverted to `master`'s exact content
(`git checkout master -- 'web/app/(app)/runs/[runId]/layout.tsx'
web/messages/{en,ru}.json`) and the two specs re-run:

| Tree | Result |
| --- | --- |
| UI delta reverted to master | EXIT=0, 10 passed, **1 flaky** — same duplication, on `push-notifications:218` |
| UI delta restored (branch HEAD) | EXIT=0, 10 passed, **1 flaky** — same duplication, on `push-notifications:103` |

Identical shape either way, with the bitten case MOVING between runs — the
"traded places" pattern `web/CLAUDE.md` documents. The duplication is present
with and without this change, so it is pre-existing and race-y; whether it reads
as `failed` or `flaky` in the full lane is load. The mechanism agrees: this
branch's whole UI delta is one `decisionLabel` arm on the run-detail layout plus
two i18n keys, and neither spec renders the run timeline.

`desk.spec.ts:205`, which IS in the documented master set, did not fail here —
further evidence this set is load-shaped rather than change-shaped.

**Nothing in the e2e lane is attributable to ADR-177.** Nothing quarantined, no
spec weakened.

**T5.4 — ✅ Playwright exposure.** `next dev` boots `instrumentation.ts`, so the
e2e lane runs the sweep and the durable workers (the ADR-176 plan's C1). Run
`pnpm --filter maister-web test:e2e` and fix or explicitly quarantine-with-reason
anything the new arms disturb.

**Phase 5 exit:** zero integration failures on this host (memory:
*master suite baseline 2026-09-11* — this Mac expects ZERO), or each failure
attributed to `master` by name with evidence.

---

### Phase 6 — As-built docs and plan close-out

**✅ T6.2 TRUTH-PASS RECORD (2026-09-21).** Three Phase-0 statements became FALSE
during implementation and were corrected in `docs/decisions/adr-177.md`,
`reconciliation-gc.md`, `runs.md`, `execution-prompt-lifecycle.md` and
`web.openapi.yaml`:

| Phase-0 said | Shipped code does | Why |
| --- | --- | --- |
| Recover settles the declined command `superseded` **with `completion_applied_at`** | `superseded`, `completion_applied_at` left **NULL** | `execution_commands_application_shape_check` is an EQUIVALENCE (**C15**) — the documented write is refused by the database. Retirement never reads the column |
| the stream-lost bound covers **any `pending_*`** ∨ `inflight` | only `pending_ingest` ∨ `inflight` | **C18** — the other classes' evidence is already in Postgres, so a dead stream cannot stall them and crashing them would discard a landed result |
| (unstated) | an already-`applied`/`superseded` command means the obligation is MET and the boundary rewrites nothing; `application_error` is PRESERVED | both found by tests; without the first, a quarantined-after-application row left the run `Running` forever |
| the probe has **three** answers, and anything unproven is `pending_ingest` | a **fourth**, `indeterminate` → class `none`, for a v2 `accepted` receipt | **C19** — found by adversarial review, then by its own fix: proving a lost turn (rather than inferring one) moved the v2 shape to `pending_ingest`, which skips regardless of grace, so the production path silently lost the pre-ADR-177 safety net. `none` keeps it |

Checked and found still TRUE, so untouched (R9): `docs/architecture.md` (its one
reconcile sentence is about the recovery path in general), `error-taxonomy.md`
(no new code), `docs/db/*` + `erd.dbml` (no schema change — `db:erd --check`
green), `system-analytics/README.md` (no new analytics doc),
`ExtPulseEventKind` (no new event kind), `deployment.md`/`configuration.md` (no
new env var or deployment surface).

**T6.1** — ✅ Flip the Phase-0 placeholders to as-built: PRM-05 / EDGE-PRM-02 cite
the suites that passed them; the stage-ab matrix row `:859` cites RED 1/RED 3;
S5.2's named scenario is marked green. **T6.2** — ✅ Re-read every Phase-0 doc
against the shipped code (memory: *docs truth pass after milestones*) — ADRs,
system-analytics, architecture prose, component diagrams. **T6.3** — ✅ Record the
accepted residual windows in ADR-177.

---

## Commit Plan

| # | After | Message |
| --- | --- | --- |
| 1 | Phase 0 | `docs(execution): evidence-first crash classification contract (ADR-177)` — includes the two API-contract corrections (T0.8 `web.openapi.yaml`, T0.9 `outbound-webhooks.asyncapi.yaml`) |
| 2 | Phase 1 | `test(runs): RED controls for evidence-first crash classification` |
| 3 | Phase 2 | `feat(reconcile): classify a lost turn from durable command evidence` |
| 4 | Phase 3 | `feat(runs): one crash boundary for a host-reported lost turn` (includes T3.5 — Recover declines AND supersedes a lost turn, **C9** + **C13**) |
| 5 | Phase 4 | `feat(runs): turn_lost is not a correction, and it has a label` |
| 6 | Phase 5–6 | `docs(execution): truth pass and S5.2 evidence for ADR-177` |

Each commit is independently green (its phase's exit gate). Merge to `master`
with `--no-ff` only after the full lane is green (memory: *red suites block the
milestone*). No AI co-author trailer.

⚠ **Commits 3 and 4 must land in the same merge (C10).** The `evidence-applied`
SKIP arm is correct only because T3.3 guarantees a lost turn never becomes an
applied completion. Shipping Phase 2 alone would hand such runs to the
continuation worker, which drives the graph to `Failed` per **C8** — a
regression, not a partial improvement. They are one release unit.

## Risks and accepted residuals

| Risk | Handling |
| --- | --- |
| The receipt probe adds an HTTP call to a 60 s sweep | Gated to a rare candidate class (**D1**); a probe failure is `pending_ingest` (skip), never a crash. Measure the per-tick probe count in T2.5's INFO line. |
| `evidence-pending` could skip forever if `commandStreamLost` never fires | The stream-health pass owns that transition and runs in the same sweep (`:356`). Accepted residual, recorded in ADR-177: a host whose stream is `active` but whose consumer is wedged holds the run `Running`. That is the existing impasse signal's job, not a new timer (trap 4). |
| Two writers converge on one boundary on the flow path (**D3**) | `completion_applied_at IS NULL` is the single winner (**C3**); RED 3's matrix covers both orders. Agent and scratch have one writer each and stay on their own choke points (**D4**, RQ2), so they add no race. |
| Phase 2 is a regression without Phase 3 (**C10**) | The `evidence-applied` SKIP arm assumes T3.3 exists. Pinned in the commit plan: commits 3 and 4 land in one merge. |
| `turn_lost` attempts reach the Observatory signal clusters (**C11**) | Chosen, not inherited — asserted in T4.1 with `errorKey = "CRASH"` so they cluster separately from genuine failures. |
| `mapReasonToCrashReason`'s `default:` | Closed by an exhaustiveness assertion (T2.4), not by a spot test (**C6**). |
| T3.5 touches ADR-175's Recover path | It adds ONE filter arm to a chain that already has five `continue` arms (`crash-recover.ts:169-178`) and returns a NEW outcome value rather than repurposing `"absent"` — so a caller that does not handle it is a compile error. `recover.integration` is a Phase-3 exit gate. |
| `ReconcileReason` grows 20 → 26 | Every crash-classified member is covered by T2.4's exhaustiveness assertion; the skip-classified ones only feed counters. |

## Follow-ups (separate items, not this plan)

- **B6** — a run-level error surface so `Crashed` reasons reach the board without
  opening the attempt.
- The memory note *"Recovery has three doors…"* gets its final shape once this
  lands: Recover (ADR-175), durable workers (ADR-176), evidence-first sweep (ADR-177).
- `layout.tsx:868-870` records a pre-existing gap: `operator_interrupt` and
  `review_rework_claim` still render as raw tokens. Not this plan's to fix — noted.
- **Every graph-CRASH run is unrecoverable** (found while resolving RQ3):
  `runner-graph.ts:5291-5296` writes `status='Crashed'` without stamping
  `resume_target_step_id`, so `isRunRecoverable` resolves `currentNodeKind = null`
  → `discard-only`. That predates this work and affects every `CRASH`-coded node
  failure, not just lost turns. Not this plan's to fix — file it.

## Out of scope

Scratch launch grace / scratch Recover status (A4); host permission timer
(P0-3 → S5.3); HITL UI (P0-4); consensus predicates (B4); lag/backlog metrics
(P0-7); outbox pressure (D6).

---

## Resolved questions (owner session, 2026-09-21)

All six open questions are closed. **Q2 and Q3 changed the plan**; the reasoning
that produced each answer is recorded so it is not relitigated.

### RQ1 — C9 / T3.5: in this plan, marked separable. ✅

Reachability is wider than the first read suggested: `crashRunningRun` writes no
`node_attempts` row **at all**, so after *every* crash reason the attempt stays
`Running`/open. The exposed population is therefore every run crashed by
`worktree-gone`, `orphaned-child` or `cli-not-retry-safe` carrying a settled
`turn_lost` command — **plus the whole existing `agent-session-gone` tail**,
which grows with each host restart until this ships. ~5 lines against that is
not a close call. Rejected: a separate P1-6 (the population keeps growing) and
leaving it (Recover eats the lost turn as the node's result → `Failed` per C8).

### RQ2 — ⚠ D4 REVISED: flow through the boundary; agent/scratch through their own choke points

**The original rationale is withdrawn.** It read *"otherwise a host restart burns
an agent-run into `Failed` with no Recover"*. Verified, it does not hold:

- `finalizeAgentRun` (`agents/finalization.ts:791`) already takes
  `AgentTerminalOutcome = "Done" | "Failed" | "Crashed" | "Abandoned"` — for an
  agent run this is **one argument**, not a boundary function.
- But `Crashed` buys nothing actionable there: `isRunRecoverable` resolves
  `currentNodeKind` from `resume_target_step_id` (`queries/run.ts:401-403`), an
  agent run has no graph node, so `classifyRecover(…, null, retrySafe)` returns
  `discard-only` → **not recoverable**. Standalone agent-run Recover is out of
  scope anyway (A4).

The one argument that survives is **retirement**: an owner that never marks the
command `applied` leaves it `owner_unapplied` forever, and
`execution_commands_protected_evidence` then blocks deleting the run (**C3**).

**Decision:** flow owners go through `applyTurnLostBoundary` (**D3**) — that is
where two writers genuinely race. Agent and scratch keep their existing single
choke point (`finalizeAgentRun(outcome: "Crashed")`; scratch
`markScratchCrashed`), and the deliverable there is narrower: **confirm the
command reaches `applied` on a failed turn**. Rejected: one boundary for all
three (it would wrap a ready choke point in a slower layer and force
`crashRunningRun` onto scratch, which owns `scratchRuns.dialogStatus` too).

**Phase 0 must answer first:** do the agent and scratch owners already apply the
command on a failed turn? If yes, T3.4 collapses to the one-argument change.

### RQ3 — ⚠ REVISED: normalize `error_code` to `CRASH`

Two findings.

**A cheap route exists and is broken.** `runner-graph.ts:5291` —
`if (failed && runErrorCode === "CRASH")` writes `runs.status = "Crashed"` with
the full `run.crashed` webhook + domain event. So mapping `turn_lost → "CRASH"`
inside `decodeNodePromptCompletion` would buy a `Crashed` run for one line. It is
rejected because that branch writes
`.set({ status: "Crashed", endedAt, currentStepId: null })` and **never stamps
`resume_target_step_id`**, unlike `crashRunningRun` (`state-transitions.ts:1374`).
Without it `isRunRecoverable` resolves `currentNodeKind = null` → `discard-only`
→ the run is `Crashed` **and unrecoverable**. **D3 stands**, and this is recorded
in ADR-177 as the second considered-and-rejected option beside **D8**.
(Side observation, not this plan's to fix: *every* graph-CRASH run is
unrecoverable for the same reason. Logged under Follow-ups.)

**`error_code` is an Observatory clustering key.** It has exactly two readers
(`queries/run.ts:1255`, `queries/observatory.ts:1016`) and neither branches on
it — but `observatory.ts:1565-1580` feeds `clusterRetrySignals`, where
`errorKey = latest.errorCode ?? exitCode ?? "unknown"`
(`observatory-signals.ts:200-201`). Two values would split one root cause
across two clusters.

**Decision: `CRASH`.** One cluster key, semantically exact, and distinct from
ordinary `PRECONDITION` failures so it does not contaminate them. Nothing is
lost: which recovery path terminalized the turn stays in the command's
`last_error`, which is the durable evidence. Rejected: `settled.lastError.code`
verbatim (splits the cluster — **A12c** shows it is `PRECONDITION` from a
rejected receipt and `ACP_PROTOCOL` from the accepted-no-terminal fallback);
`PRECONDITION` (merges with everything else); a new `TURN_LOST` code (a whole
taxonomy fanout for one column).

### RQ4 — ⚠ REVISED: backdate the grace anchor, split the cases by slice, add no new package

Both original options were wrong about where the cost is. **Neither waiting out
the grace nor shrinking it is necessary.**

**Finding 1 — the 90 s is never waited.** `reconcile-sweep.integration.test.ts:608`
and `:642` already do `startedAt: new Date(Date.now() - 600_000), // past the
90s grace`. Backdating the grace anchor is the established in-repo pattern, and
it is **stronger** than shrinking the grace: the run is definitively OUTSIDE the
window, so a skip can only be the evidence arm. Shrinking the grace to 5 s would
reintroduce the S2.12 trap (a seeded attempt inside the grace, green, measuring
nothing). The override exists — `reconcileGraceSeconds()` reads `process.env`
uncached (`instance-config.ts:327-338`) and `startRealWeb` merges `options.env`
(`real-web.ts:265`, so it must go through `options.env`, never the vitest
process's own env) — and is **not used**.

Residual wall clock in RED 2 = the real launch + the ingest release. That is at
most ONE `CLAIM_LEASE_MS` (`events/consumer.ts:19` = 30 000) when the consumer
was killed, and zero when it is stopped cleanly. Not 3-5 minutes.

**Finding 2 — the request's "all controls run the PRODUCTION web" is
over-specified.** `command-recovery.integration.test.ts` uses `startRealWeb`
**zero** times; it runs a real supervisor + real Postgres, and that is exactly
the shape V3 already proves. The production web proves *boot wiring*, which is
`durable-workers-boot`'s job (ADR-176). Spending a `next build` and two process
trees on pure sweep/boundary logic buys nothing.

**Case allocation:**

| Case | Needs production web? | Slice | Cost |
| --- | --- | --- | --- |
| RED 1 + RED 3 sweep-first (`preSettle:false` × 2) | no | `web` | 2 supervisor restarts, V3's shape (180 s budget) |
| RED 3 worker-first | **yes** — needs live durable workers | `isolation` | 1 case |
| RED 2 | **yes** — "release ingest → the worker applies" | `isolation` | 1 case + ≤1 lease |
| RED 4 (poisoned / quarantined) | no — seed a conflicting evidence row | `web` | cheap |
| RED 5 | no — seeded + backdated | `web` | cheap |
| RED 6 | no — an assertion on RED 1 | — | zero |
| T3.5 control | no — seeded | `web` | cheap |
| T3.4 agent / scratch | no — seeded | `web` | cheap |

**Two new `isolation` cases**, and they pay no extra build: `buildProductionWeb`
stamps `laneBuildId()` and reuses within a run (commit `176db560` — *"the first
builds and the rest reuse it"*). The slice is 3 suites / 15 cases today.

**No new optional package.** Three reasons, all verified:

1. The mechanism it needs was **already tried and rejected** in `176db560`:
   *"excluding the two heavy suites from the integration project so only the
   serial AB slice runs them. Vitest applies `exclude` to explicitly named files
   too, so the slice then finds NO test files — dead tests, which is worse than
   slow ones."*
2. A new slice key would save nothing. The runner takes any known key
   (`run-stage-ab-tests.mjs:87-89`), but the suites stay in the `integration`
   project (`vitest.workspace.ts` → `include: ["test-support/**/*.integration.test.ts", …]`)
   and CI runs the full `test:integration` (`ci.yml:96`). Zero saving, one more
   manual entry point.
3. **`isolation` already IS that package** — separate, serial (`SERIAL_SLICES`),
   invoked on demand as `node scripts/run-stage-ab-tests.mjs isolation`.

**Not measured, deliberately not guessed:** the `isolation` slice's own
wall-clock and `next build`'s duration. The stabilization plan records full-lane
figures only (4000-5400 s; "isolation 4/4" with no duration). If a number is
needed before committing to the allocation above, one slice run produces it.

### RQ5 — Parameterize the V3 body; fold RED 1 and RED 3 into one family. ✅

V3 keeps its own assertion (it deliberately pre-settles the command). Extract
its body over a `preSettle` flag: `preSettle: true` is today's V3, `false` is the
production tick order. RED 3 needs both ingest orderings anyway, so the matrix
is `{preSettle} × {sweep-first, ingest-first}` as **one parameterized family**
rather than three separate cases each paying a ~180 s supervisor restart.
Rejected: a standalone V3b (duplicates the restart and the setup) and editing V3
in place (it would stop measuring what it measures).

### RQ6 — Keep the sweep order; the probe stays. ✅ (**D8** confirmed)

A hard dependency was found: `recovery.ts:390-391` states that
`lostStreamHostIds` reads state `runEventStreamHealthSweep` wrote **earlier in
the same pass**. So `streamHealth (:356) → executionCommandReconcilePass (:367)`
is load-bearing, and moving command recovery ahead of reconcile means moving
**two** stages over four intervening passes
(`runSyncRecoverySweep`, `reconcileTerminalCostRollups`,
`ensureLocalExecutionDataPlane`, `runEventStreamHealthSweep`) — and the probe
would still be needed for the `accepted`-with-no-terminal-evidence window.
Full cost, no saving.

---

## New findings from the resolution pass

### C10 — ⚠ The `evidence-applied` SKIP arm is only correct BECAUSE T3.3 exists

**D2** skips on `applied` and hands the run to the continuation worker. That is
safe only while an applied completion means a *genuine* result. Today
`decodeNodePromptCompletion` would happily turn a `turn_lost` into an applied
failed completion, and the continuation worker would then drive the graph to
`Failed` per **C8** — the skip arm would be handing the run to a writer that
produces the wrong outcome.

T3.3 is what guarantees a lost turn never becomes an applied completion.
**Therefore Phase 2 must not ship without Phase 3** — they are one release unit,
not two independent ones. Recorded against the commit plan: commits 3 and 4 may
be separate commits but must land in the same merge.

Residual: rows applied as ordinary failures **before** this change ships stay
`Failed`. Accepted and recorded in ADR-177; a repair migration is deliberately
not attempted (the completion is already consumed).

### C11 — Observatory has a THIRD surface Scope 5 did not name

Scope 5 says *"both Observatory correction counters exclude it"*. There is also
`clusterRetrySignals` (`observatory.ts:1565-1580` → `observatory-signals.ts:178-203`),
which groups by `runId:flowId:nodeId`, takes the latest attempt, and **does not
filter on `decision` at all**.

**Decision: leave `turn_lost` attempts in the signal clusters.** A host that
keeps restarting is a real operational signal and an operator should see it —
unlike a correction counter, which measures agent quality. RQ3's `CRASH`
normalization is what keeps that signal in its own cluster instead of polluting
genuine-failure clusters. T4.1 asserts this deliberately (a test that the
cluster appears with `errorKey = "CRASH"`), so the behaviour is chosen, not
inherited.

### C13 — ⚠ LOGICAL HOLE found by the `/aif-improve` pass: T3.5 declining is not discharging

T3.5 as first written made `applyCrashedTurnEvidence` **refuse** a `turn_lost`
result. Refusing alone leaves the command at `application_state = 'pending'`
forever: Recover closes the crashed attempt, appends a fresh one with a new
prompt, and nothing ever settles the old command. `retirement.ts:171-176` then
answers `owner_unapplied` and `execution_commands_protected_evidence` blocks
deleting the run — **the precise failure C3 exists to prevent, reintroduced by
the fix for C9.**

The probe does not paper over it: it is attempt-scoped
(`owner_ref->>'nodeAttemptId' = <current attempt>`), so the orphaned command
belongs to the closed attempt and is invisible to the sweep. It simply leaks.

The mechanism to close it already exists and means exactly this:
`PromptOwnerDisposition = "applied" | "superseded"` (`prompt-owners.ts:12`) —
`superseded` is the first-class "obligation discharged, result consciously not
applied", and `retirement.ts:174` accepts it. T3.5 now settles
`application_state = 'superseded'` + `completion_applied_at` in the same
transaction. RED 6 asserts both discharge paths so this cannot regress.

### C12 — `crashRunningRun` already carries the full terminal contract

Verified at `state-transitions.ts:1380-1430`, inside its transaction: closes open
`hitl_requests`, `releaseSyncClaimOnTerminal`, `releaseAssignmentForRun(…, "crashed")`,
`run.crashed` webhook **and** domain event. So **D3** step 2 inherits all of it,
and the boundary owns only the attempt close, the command `applied`, and the
post-commit `promoteNextPending`. No event or release needs re-implementing.

---

## Decision deltas applied to the plan

| Section | Change |
| --- | --- |
| **D3** | `error_code = 'CRASH'` (normalized), not `settled.lastError.code`. |
| **D4** | Rewritten: flow → boundary; agent → `finalizeAgentRun(outcome:"Crashed")`; scratch → `markScratchCrashed`; the shared deliverable is the command reaching `applied`. |
| **D8** | Confirmed, plus the `streamHealth → commandRecovery` dependency as the concrete blocker, plus the rejected `CRASH`-code route from RQ3. |
| **T1.1 / T1.3** | Merged into one parameterized family over `{preSettle} × {ingest order}`. |
| **T3.4** | Narrowed to the one-argument change + the `applied` assertion, gated on the Phase-0 answer. |
| **T4.1** | Adds the C11 signal-cluster assertion. |
| **Settings / Phase 1 header / T1.2 / T1.7** | The production web is used by TWO cases, not all; the 90 s grace is passed by **backdating**, never by waiting or by a grace override; trap 5's "≥ 90 s + 3 leases" budget is superseded by "≤ 1 lease" (RQ4). |
| **Commit plan** | Commits 3 and 4 must land in the same merge (**C10**). |

### `/aif-improve` pass (2026-09-21) — SDD + TDD hardening

Run with: *"SDD-driven; accurately work on API contracts, DB migrations and
system analytics; check completeness, consistency, logical holes, concrete
expectations / requirements / acceptance criteria; TDD RED → GREEN → REFACTOR;
full coverage with minimum overlap and no trivial tests; SOLID / KISS / DRY."*
`.ai-factory/skill-context/aif-improve/SKILL.md` does not exist, so the fallback
applied: the last 10 files in `.ai-factory/patches/`. The
`2026-09-18-16.45` patch (the ADR-175 review batch — *"a claim marker released
by only one of three arms"*) is what prompted the C13 audit.

| # | Kind | Change |
| --- | --- | --- |
| 1 | 🆕 **logical hole** | **C13** — T3.5 declining a lost turn without settling it strands the command `owner_unapplied` forever. Now settles `superseded`; RED 6 asserts both discharge paths. |
| 2 | 🆕 contract | **T0.8** — `web.openapi.yaml:8738+` Recover description states evidence "is applied first"; T3.5 makes `turn_lost` an exception, so the prose and its plan table move. |
| 3 | 🆕 contract | **T0.9** — `outbound-webhooks.asyncapi.yaml:704-712` `DataRunCrashed.errorCode` has NO description and carries a `CrashReason` from one writer and a `MaisterErrorCode` from another; three new values land on it. Prose only — adding an `enum` would break the `runner-graph` writer. |
| 4 | 🆕 TDD | **REFACTOR** added to the exit of Phases 2, 3 and 4, each naming the specific SOLID/KISS/DRY property to settle and requiring a re-run afterwards. |
| 5 | 🆕 rigor | Numbered **`AC-*`** acceptance criteria on the tasks that gained requirements (D7, T0.8, T0.9, T3.5, T4.1). |
| 6 | 📝 migrations | **D7** — the "no migration" verdict gains its cost proof: no `owner_ref` index exists, but `execution_commands_run_created_idx` on `(run_id, created_at)` (`schema.ts:2358-2361`) serves the probe as a short index scan. **AC-D7.1** records an `EXPLAIN` rather than assuming it. |
| 7 | 📝 overlap | **RED 5** split into a free pure classifier case and one integration case for the builder — they prove different layers; one combined integration case would be the overlap. |
| 8 | 📝 triviality | **T4.1** bans the constant-restating assertion and routes all four ACs through a consumer. |
| 9 | 📝 discipline | **Phase 1 exit** gains a case × property matrix (every property owned once) and the no-trivial-cases rule. |
| 10 | 🔗 dependency | **RED 6** now covers both discharge paths, which is what makes C13 non-regressable. |

Checked negatives, recorded so a later sweep does not re-open them:
`ExtPulseEventKind` (no new event kind); `docs/error-taxonomy.md` (no new error
code); `docs/database-schema.md` + `docs/db/*.md` ERD (no schema change, so
`db:erd --check` stays green); `docs/system-analytics/README.md` (no new
analytics doc — the five amended docs already have index entries).

### Owner sign-off (2026-09-21)

RQ1 **A**, RQ2 **C**, RQ3 **C**, RQ5 **C**, RQ6 **A** — all confirmed as written
above. RQ4 was re-opened on a cost question and the answer changed: no new
optional package (the `exclude` mechanism it needs is a rejected precedent, a
new slice key saves nothing, and `isolation` already is that package); instead
backdate the grace anchor and put only the two worker-dependent cases in
`isolation`. One measurement is deferred by agreement: the `isolation` slice's
own wall-clock, to be taken from a single slice run if the allocation needs
defending.
