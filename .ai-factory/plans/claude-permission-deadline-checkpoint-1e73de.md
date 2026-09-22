# One owner for the permission deadline

**Branch**: `claude/permission-deadline-checkpoint-1e73de`
**Base**: `master` @ `7201d060` (branch HEAD == master HEAD, 0 ahead / 0 behind)
**Created**: 2026-09-22 · **Refined**: 2026-09-22 (`/aif-improve` pass 1)
**Item**: P0-3 of the execution-seam diagnosis (2026-09-18), severity critical
**ADR**: ADR-180 (reserved — highest existing is ADR-179; 179 hub stubs, 179 record files)

## Goal

A pending permission has exactly one deadline owner — the web keep-alive window.
When the host must give up a session on its own it does what the web sweeper
does: a graceful checkpoint that keeps the ACP handle resumable, never a SIGKILL
that turns the operator's answer into a terminal failure.

## Settings

- **Testing**: yes. TDD, **RED → GREEN → REFACTOR**. Every behaviour change lands
  RED first; each code phase ends with an explicit refactor gate (§Refactor
  gates). Integration controls run against the real supervisor fixture
  (`web/test-support/real-supervisor.ts`, `mock-acp-adapter-resumable.mjs`) and
  real Postgres via `test-support/pg-container.ts` — the only web Testcontainers
  constructor. Mocked route/service suites are never the pinning evidence for
  this change (patches 2026-09-15-17.05, 2026-09-17-01.34).
- **Logging**: structured pino, matching the existing field conventions on each
  seam (`sessionId`, `requestId`, `runId`, `commandId`, `cause`, `boundary`,
  `latencyMs`). No new log framework, no `console.*`.
- **Docs**: yes — mandatory checkpoint. SDD: Phase-0 artifacts are frozen before
  any code lands.
- **Migration**: **none** — and the reason is recorded, not assumed (D15). No
  column, constraint, index or `runs.status` value is required.

## Roadmap Linkage

**Milestone**: `none`
**Rationale**: the open roadmap milestone is M51 ("See everything", a read-only
visibility layer) and is unrelated. This item belongs to the Stage A/B
stabilization plan: `.ai-factory/plans/stage-ab-stabilization.md` §S5.3 (line 811)
and the "Single-host lifecycle regression" acceptance row (line 882).

---

## Ground truth — verified, and five corrections

Everything below was read on `master` @ `7201d060`. The request's ground truth is
accurate on the mechanism. Five premises — three from the request, **two from the
first draft of this plan** — are wrong; the plan is built on the corrected ones.

### Verified as stated

| # | Fact | Evidence |
|---|---|---|
| G1 | Host timer set once, never extended | `supervisor/src/pending-permissions.ts:53` `timeoutMs = opts.timeoutMs ?? keepaliveMinutesEnv() * 60_000`; `:94-113` one `setTimeout` per deferred; `:107-112` expiry → `deferred.reject(SupervisorError("HITL_TIMEOUT"))`. Registry interface `:14-28` — no extend/renew. |
| G2 | A rejected permission kills the agent | `bounded-acp-stream.ts:530-537` `.then(send, () => fail("producer_permission_failed"))` → `:504-513` `fail` → `input.onFailure` → `acp-client.ts:907-908` `record.abortOutput?.(error)` → `spawn.ts:356-375` `producer-output-incomplete`, `pressure?.beginTeardown()`, `child.kill("SIGKILL")` (`:373`), `stdout.destroy()`. |
| G3 | Checkpoint differs from expiry by one call | `http-api.ts:2565` `pendingPermissions.cancel(sessionId, requestId, "checkpoint")` → `pending-permissions.ts:161` `deferred.resolve({outcome:"cancelled"})`; `:2568` `markIntentionalShutdown(sessionId, "checkpoint")`; SIGTERM + `waitForChildExit(entry, killGraceMs)`. |
| G4 | Graceful shutdown races its own SIGKILL | `shutdown.ts:21` `purgeSession` (a REJECT, `pending-permissions.ts:213-236`) runs BEFORE `markIntentionalShutdown` (`:22`) and `child.kill("SIGTERM")` (`:24`). |
| G5 | 410 / 503 windows after a terminal | `http-api.ts:2636` unknown session → 503 `EXECUTOR_UNAVAILABLE`; `:2686` missing deferred → `HITL_TIMEOUT` → `types.ts:1408` `httpStatusForCode` → **410**. Registry entry removed 30 s after terminal (`heartbeat.ts:27` `DEFAULT_REMOVE_GRACE_MS`). |
| G6 | The web terminalises on the 410 | `web/lib/services/hitl.ts:1526` fresh claim → `runs.status = Failed` (flow) / `Crashed` (scratch) + outbox + domain events; `:1638-1643` → 410 `{terminal:true}`. |
| G7 | Sweeper Pass 1 absorbs an early host checkpoint | `keepalive-sweeper.ts:184` `lt(runs.keepaliveUntil, now)`; `:274` `client.checkpoint`; `:310` `markCheckpointed`. A 404 is NOT retried: `definitiveUnavailable` (`supervisor-client.ts:1335`) converts only **5xx** to `EXECUTOR_UNAVAILABLE`, so a 404 falls to the catch's terminal-failure branch and parks. |
| G8 | `startKeepaliveSweeper` is dead | Zero production callers. The only live driver is `web/lib/scheduler/system-sweeps.ts:289` → `runSweepTick()` on the 60 s scheduler tick. `docs/configuration.md:1176` still describes the dead singleton timer. |

### C1 — the keep-alive ADR is **ADR-006**, not ADR-023

`docs/decisions/adr-023.md` is *"Run web + supervisor on the host; containerize
only Postgres"* — 54 lines, zero keep-alive text. The keep-alive contract lives in
**`docs/decisions/adr-006.md`** (hub stub `docs/decisions.md:272-277`, index row
50): `:17-20` "the ACP session stays live for `MAISTER_KEEPALIVE_MINUTES`
(default 30)"; `:32-37` "`MAISTER_KEEPALIVE_MINUTES` is the cost lever for ops."
**ADR-180 amends ADR-006.** ADR-023 is untouched.

### C2 — there are already TWO writers of `NeedsInput → NeedsInputIdle`

`markCheckpointedFromExit` (`web/lib/runs/state-transitions.ts:236`) is live,
called from `web/lib/flows/runner-agent.ts:1717` when the flow driver observes
`session.exited{reason:"checkpoint"}` on its own session's stream. Both writers
share `idleFromNeedsInput`'s CAS, so they are already safely idempotent.

**The corrected invariant is not "one writer" but "every writer shares the CAS".**
This plan adds a third (D4) and a fourth (D13) under the same CAS.

### C3 — the HITL request state machine has no `Checkpointed` state

`docs/system-analytics/hitl.md:161-171` defines exactly `Open`, `Responded`,
`Expired`. "Checkpointed" is a property of the run/session. A host cap parks the
*session*; the *request stays Open* and answerable. T0.2 documents an `Open → Open`
self-transition, **not** a new state.

### C4 — `details.reason` is a CLOSED ENUM. The first draft's "no wire change" was false

`SupervisorErrorBody.details` → `SupervisorErrorDetails`
(`docs/api/supervisor.openapi.yaml:3168`, `additionalProperties: false`) →
`reason: $ref ReasonToken` — a **43-value `enum`** at `:3005-3049`.
`session_checkpointed` is not among them.

`supervisor/src/__tests__/openapi-examples.test.ts:133-143` asserts
`REASON_TOKENS ⊆ openapi.components.schemas.ReasonToken.enum` — **one-way**: code
without doc **fails**, doc without code passes. Adding the token is therefore a
4-file change (D12), not additive prose. The first draft also cited the wrong
lines: `:1287-1293` is only the 410 `description:` prose.

### C5 — removing the host rejection removes the only bound on a live-looking dead run

`bumpKeepalive` (`web/lib/runs/state-transitions.ts:849-871`) extends
`keepalive_until` for `Running | NeedsInput` with **no session-liveness check**;
the activity route's own comment says "indefinitely". Pass 1 selects on
`keepalive_until < now`. So after a host-initiated checkpoint, an operator who
keeps a tab open but never answers holds the run out of Pass 1 **forever** — it
never reaches `NeedsInputIdle`, so Pass 2's 24 h `Abandoned` never fires either.

The first draft's RED 5 asserted "the web's 24 h Abandoned rule still terminalizes
later". **That is false in this case.** This is the pattern named by patch
`2026-09-21-21.55.md` — *a fix that removes a false crash can silently remove a
safety net too*. D13 closes it.

---

## Decisions

### D1 — Option table (ADR-180 decision text)

| Option | Substance | Pro | Con | Verdict |
|---|---|---|---|---|
| **A. Expiry = checkpoint** | The timer fires the checkpoint teardown, not a reject | Removes the only destructive effect; reuses existing code; a prerequisite under every other option | Does not by itself align the two deadlines | **CHOSEN** |
| B. Host timer as a margin | Host timeout = window × k | One constant; race practically gone | Two owners remain; the margin is a heuristic | Rejected |
| C. Extend route | `POST /sessions/:id/permissions/:requestId/extend` per keep-alive bump | Host and web see one deadline | A new enveloped command + receipt per ping; the race survives a late bump; unnecessary once A makes expiry harmless | Rejected — no scenario found that A+D fails and C fixes |
| **D. Host has no per-permission timer** | Only an absolute cap; the web owns the deadline | One owner; matches the documented model; least code | Host relies on the web for liveness; a dead web leaves an idle agent until the cap (no tokens spent) | **CHOSEN** |
| **E. Resume evidence accepts terminal-event proof** | The checkpoint boundary is the `session.exited{reason:"checkpoint"}` event, not the checkpoint command's admission event | The ONLY option that works — see D5's mechanism; no `cause` control-flow plumbing; any parker works | Touches 4 evidence sites and re-qualifies the Stage A/B lane | **CHOSEN** (owner decision, 2026-09-22) |

### D2 — The checkpoint teardown is one function, reused verbatim

Extract from `http-api.ts:2528-2600` into `supervisor/src/checkpoint-teardown.ts`:

```
checkpointSession(input: {
  entry: RegistryEntry;
  logger: Logger;
  killGraceMs: number;
  cause?: "permission_cap";          // diagnostic only — D6
}): Promise<{ alreadyCheckpointed: boolean; monotonicId: number }>
```

Body, in order, unchanged from today:

1. idempotency — `record.status === "exited" | "crashed"` → `{alreadyCheckpointed:true, monotonicId}`;
2. `pendingPermissions.requestIds(sessionId)` → `cancel(sessionId, id, "checkpoint")` for each;
3. `registry.markIntentionalShutdown(sessionId, "checkpoint")`;
4. `record.stopOutputForTeardown?.()`;
5. `child.kill("SIGTERM")`;
6. `await waitForChildExit(entry, killGraceMs)` (`execution-fence.ts:158`) — on
   timeout: SIGKILL + throw `SupervisorError("EXECUTOR_UNAVAILABLE", …)`.

| Caller | Envelope | Failure handling |
|---|---|---|
| `POST /sessions/:id/checkpoint` | inside `runCommand` (ADR-166 fence + ledger) | throw → 503, unchanged |
| the absolute-cap timer | **none** — host-internal, no `command.id`, no fence | throw is caught and logged `checkpoint-cap-escalated` at `error`; nothing is returned to anyone |

**Not unified**: `http-api.ts:2226` (delete) and `:2389` (cancel) are different
teardowns and keep their own shape — see D14.

**Escalation honesty.** If the grace expires and the child is SIGKILLed, the
session was already `markIntentionalShutdown("checkpoint")`, so the heartbeat
still classifies it as `session.exited{reason:"checkpoint"}` (`heartbeat.ts:50`).
The ACP handle's validity is then **unproven**. **This is an accepted residual
window** (owner decision, 2026-09-22), recorded in ADR-180's Consequences, with
**no dedicated control** — the existing resume failure classification
(`resume.ts` → `CHECKPOINT` terminal → `failResumedRun`) is its owner. No control
may assert a clean park in that case.

### D3 — The cap timer is background automation: progress, poison, waker

- **Progress**: one `setTimeout` per deferred, armed once at registration, cleared
  by `evict`. No scan, so no cursor and no starvation class. `timer.unref()` kept.
- **Bounded retries**: none — the cap fires once per deferred. A throwing teardown
  is not retried; the web sweeper's own `client.checkpoint` is the retry.
- **Poison item**: each timer is independent, escalation bounded by `killGraceMs`.
- **What wakes the parked run**: the operator's answer (D4), Pass 1's keepalive arm,
  or Pass 1's **new checkpointed arm** (D13). All three terminate in
  `markCheckpointed` + `resumeRun` and share one CAS.

### D4 — An answer in the race window is a resume, not a failure

**Supervisor side.** `POST /sessions/:id/input`, in the `!ok` branch
(`http-api.ts:2681-2688`), throw the typed refusal when the session terminated
**intentionally with its deferreds cancelled** — written as a predicate over an
allow-list, never as a single-value equality:

```
INTENTIONALLY_PARKED: ReadonlySet<IntentionalReason> = new Set(["checkpoint", "intentional"])
entry.record.status === "exited" && entry.intentionalShutdown && INTENTIONALLY_PARKED.has(entry.intentionalReason)
  → SupervisorError("HITL_TIMEOUT", …, { details: { reason: "session_checkpointed" } })
```

- `"fenced"` is **excluded**: a fenced session means a newer driver generation owns
  it, and `isFencedError` / `assignment_fenced` is its existing arm. Admitting it
  here would route a superseded answer into a resume.
- `"intentional"` is included because after D7 a graceful shutdown also cancels
  (not rejects) its deferreds, leaving exactly the same answerable-but-sessionless
  state. Its reachability through `/input` is **low** — the supervisor is going
  down, so a connection error (503) is the likelier outcome — but it is included
  because the predicate, not the reachability, is the contract. The plan states
  this rather than leaving a reader to infer it.

Status stays **410**. `httpStatusForCode` is unchanged (`CHECKPOINT → 500`;
re-pointing it is a fanout for no gain). `deliverInputEnveloped`
(`web/lib/supervisor-client.ts:2035`) **preserves `details`** verbatim when
re-throwing 410 as `MaisterError("HITL_TIMEOUT", …, { details: err.details })`.

**Web side.** In `hitl.ts`, inside the `err.code === "HITL_TIMEOUT"` handler, add a
branch **before** the `claim.kind === "noop-idempotent"` check at `:1520-1545`
(that branch is the known C2 dead end — do not widen it):

| Step | Store | Write | On failure |
|---|---|---|---|
| 1 | — | the response is already stored in Phase 1; `respondedAt` stays NULL | n/a |
| 2 | `runs` | `markCheckpointed(runId)` — the shared CAS | a mismatch means someone already parked it: **not** an error, fall through to 3 |
| 3 | — | `resumeRun(runId)` + `scheduleResumedSessionDrive` — the existing idle branch at `hitl.ts:1211-1240` | reuse the idle branch's classification verbatim: `CLAIM_RACE`/`QUEUED` → 202, retryable → 503, terminal → the existing Failed path |

Response: **202 `{ok:true, state:"resume-in-progress"}`**. Verified: that token is
already in the closed 202 `state` enum at `docs/api/web.openapi.yaml:7540`
(`[resume-in-progress, rework-scheduled, resume-queued, delivery-in-progress]`),
so **no web-spec enum edit is required**. The run is never `Failed`/`Crashed` here.

**After the 30 s terminal grace** the registry entry is gone and `/input` answers
503 `EXECUTOR_UNAVAILABLE` — unchanged, retryable, run stays `NeedsInput`, and
D13's arm parks it on the next tick. (The 503 wording is P0-4, out of scope.)

**Identifiers** on the changed route: `sessionId` = `url-param`;
`requestId`/`optionId`/`action` = `body-controlled` but name nothing
cross-resource (existing M7 design); the terminal classification reads
`server-state` only (`registry.get(sessionId)`). **No new body field.**

### D5 — The checkpoint boundary becomes the terminal event, proven positively

`permissionCheckpointOrder` (`web/lib/execution-host/permission-handoff-evidence.ts:63-116`)
proves ordering by comparing `hostSequence` of the prompt command's terminal
`session.command` event against the **checkpoint command's admission event**
(`session.command`, `commandId = checkpoint.id`, `kind='session.checkpoint'`,
`phase='accepted'`), both required on the same `eventStreamId` and asserted
**unique** (`.limit(2)` + `admissions.length === 1`).

**Why the command boundary cannot serve a host-initiated checkpoint — the
mechanism, not an assumption.** The admission event is emitted only while the
registry still holds the session: `runCommand`'s `persistReceipt` callback is
gated on `entry && sessionKind` (`http-api.ts:691`), and the entry is removed 30 s
after the terminal (`heartbeat.ts:27`). The sweep tick is **60 s**. So the
sweeper's `client.checkpoint` normally arrives at a **404** — the `session.checkpoint`
command row exists (the BoundClient queued it) but **no admission event does**,
and the order is unprovable. This is the NORMAL case, not an edge case, and it is
why option E is the only one that works: minting the command row is not enough,
because the proof needs the *event*.

**Change**: the function accepts a boundary that is either the command admission
event (unchanged, preferred when present) **or** the session's terminal event:

```
eventType = 'session.exited', payload->>'reason' = 'checkpoint',
source='host', ingestDisposition='accepted',
same runId / executionHostId / executionAssignmentId / assignmentEpoch / hostSessionId,
eventStreamId === terminal.eventStreamId, hostSequence non-null
```

**Positive, unique witness — non-negotiable.** Patch `2026-09-21-16.20` is exactly
this failure class: *"a terminal decision was allowed to rest on the ABSENCE of a
signal rather than the presence of proof."* Therefore:

- The terminal boundary is selected with `.limit(2)` and requires **exactly one**
  match, mirroring the existing `admissions.length === 1` assertion.
- "No command row found" is **never** itself read as "it was a host checkpoint".
  Absence of both witnesses returns `"unproven"`, and every caller keeps its
  existing conservative arm.
- Signature becomes `permissionCheckpointOrder(db, command, checkpoint: ExecutionCommand | null)`.
- The resolved order carries **which witness proved it** (`boundary: "command" | "terminal"`),
  logged and asserted — a test that cannot tell the two apart cannot tell a
  working extension from a coincidence.

**Preflight (blocking, T1.3):** assert on a real fixture that terminal
`session.exited` rows in `execution_events` carry non-null `eventStreamId` and
`hostSequence`. If they do not, E is not implementable as specified — stop and
re-raise before T3.1.

Consumers to update (all four, each keeps its own `after_checkpoint` semantics):

| Site | Lines | Change |
|---|---|---|
| `web/lib/flows/graph/permission-resume.ts` | 219-241 | the `!checkpoint` early return tries the terminal boundary; `source_checkpoint_pending` only when neither witness exists |
| `web/lib/flows/graph/permission-result-evidence.ts` | 181, 200, 225-226 | pass the nullable checkpoint through |
| `web/lib/execution-host/permission-handoff-source.ts` | 183-186 | same |
| `web/lib/execution-host/agent-permission-handoff.ts` | 250, 331 | same |

`isPermissionResultHandoff` and `isPermissionCheckpointInterruption` keep their
current logic; only the boundary they compare against widens.

### D6 — `cause` is diagnostic, never load-bearing

The host adds an optional `cause: "permission_cap"` to the emitted
`session.exited` payload. Not consumed for control flow anywhere.

**One value, not an enum** (owner decision) — `permission_cap` is the only
producer, because D7 leaves graceful shutdown on `reason: "intentional"` with no
cause. Modelled as a single literal so a future value is a visible spec change.

- Survives to `execution_events.payload` for free: the envelope builder
  (`supervisor/src/runtime-event-publisher.ts:38-56`) spreads every event field
  except `type`/`sessionId`/`monotonicId`.
- Ingest does **not** validate payload shape — `payloadSchema` is an identity
  *string* (`runtime-events.ts:120`) compared for equality (`ingest.ts:667`). No
  poison risk.
- The projector persists it (`lifecycle-projector.ts` → `terminalReason: event.payload`);
  tests read it there.
- `session-stream.ts:132-150` rebuilds the replayed event field-by-field and will
  **drop** `cause`. Intended. **It is also why `cause` must not be a new `reason`
  value**: that decoder validates `reason ∈ {checkpoint, intentional, fenced}` and
  returns `null` — dropping the whole terminal event — for anything else, hanging
  the driver on an exit it never sees.

### D7 — Graceful shutdown: order only, `reason` stays `intentional`

(Owner decision.) `supervisor/src/shutdown.ts:16-39` becomes:

1. `registry.markIntentionalShutdown(record.sessionId)` — default `"intentional"`;
2. for each `pendingPermissions.requestIds(sessionId)` → `cancel(sessionId, id, "shutdown")` — a **resolve**;
3. `record.stopOutputForTeardown?.()`;
4. `child.kill("SIGTERM")` + the existing grace timer.

`purgeSession` is **removed from this path** and reserved for already-exited
sessions — its two remaining callers (`registry.ts:126`, `:194`) are exactly that.

**Deliberately NOT changed**: the terminal reason. Switching to `"checkpoint"`
would fan out to (a) `runner-agent.ts:1715` re-classifying every
shutdown-interrupted step as `STEP_CHECKPOINTED`, (b) `lifecycle-projector.ts:228`
throwing `permanent(...)` — **poisoning the run's projection cursor**
(`projector.ts:592-598`) — for a checkpoint terminal with an uninitialized
incarnation, and (c) the ADR-177 `turn_lost` arm.

**Pinned post-restart path**: a `Running` flow run follows the **existing ADR-177
`turn_lost` boundary** unchanged (`web/lib/reconcile.ts:558` → `crash / turn-lost`,
applied by `web/lib/runs/turn-lost-boundary.ts`). A `NeedsInput` run keeps its
`acp_session_id` and is picked up by D13's arm or the operator's answer.

**Known second pass**: `main.ts:299` calls `stopRegisteredSessions(registry, logger, 1)`
— a 1 ms-grace mop-up for sessions created by handlers that finished after the
first snapshot. Already-exited sessions are skipped. RED 3 targets the primary
pass (`shutdownGraceMs`; the fixture pins it to 1000 ms).

### D8 — Deferred-release audit

| Path | Releases with | Result for the agent |
|---|---|---|
| operator answers | `resolve({outcome:"selected"})` | turn continues |
| operator cancels | `cancel(…, "client-cancelled")` → resolve | turn continues |
| manager checkpoint (route) | `cancel(…, "checkpoint")` | journaled for replay; SIGTERM |
| **host cap (new)** | `cancel(…, "checkpoint")` via D2 | journaled for replay; SIGTERM |
| **graceful shutdown (changed)** | `cancel(…, "shutdown")` | journaled for replay; SIGTERM |
| fence eviction | `cancel(…, "fenced")` (existing) | unchanged |
| guardrail halt | existing cancel (unchanged) | unchanged |
| session already exited | `purgeSession` → reject CRASH | the child is gone |
| **genuine producer fault** | `reject` → `producer_permission_failed` → SIGKILL | **unchanged** — `producer_permission_limit`, `producer_permission_invalid`, purge of a dead session |

`abortOutput` is not touched. RED 6 guards the boundary.

### D9 — The cap env

`MAISTER_PERMISSION_MAX_HOURS`, default **24** (owner decision), aligning with
`MAISTER_NEEDSINPUTIDLE_TTL_HOURS=24`. Supervisor-only. `keepaliveMinutesEnv()` is
deleted — one consumer, its own module (`pending-permissions.ts:53`).

`MAISTER_KEEPALIVE_MINUTES` still set in the supervisor env is accepted with a
one-time boot **WARN**, never a refusal (`main.ts`, beside the `envInt` reads at
`:142-145`).

**Parsed as a positive float, not an int** — the one deviation from the
`positiveIntFromEnv` convention used by its neighbours, and it is load-bearing for
the test strategy (D11). `Number.parseFloat`, guard `Number.isFinite(v) && v > 0`,
invalid → default 24 with a one-time WARN. The doc row states that fractional
values are accepted and that the integration lane uses sub-second caps. Without
it the smallest expressible cap is 1 h and **no integration test can drive the cap
at all**, leaving the timer path unpinned.

### D10 — The singleton trap and the cap-handler wiring seam

`pendingPermissions` is a module-level singleton created at import
(`pending-permissions.ts:241`) with the timeout read once. The registry has no
access to the child process, so the teardown must be installed:

```
createPendingPermissions({ timeoutMs?, onCapExceeded?(sessionId, requestId): void })
```

plus a `setCapHandler` installer on the singleton, called **once** where both the
registry and `pendingPermissions` are in scope.

**Two wiring sites, both mandatory** — a registration checklist nothing executes
is an unverified claim:

1. `supervisor/src/main.ts` (production boot);
2. `supervisor/src/__tests__/_fixtures/boot-host.ts` (the in-process harness) —
   without it every `bootHost()` integration test silently has no cap.

RED 5 drives the real boot path, not the handler directly.

### D11 — Compressing the windows in tests: environment only, no injectable clock

(Owner decision.) Neither side gets a test-only clock seam.

| Window | How a test compresses it | Wall-clock cost |
|---|---|---|
| **Host cap** | `MAISTER_PERMISSION_MAX_HOURS` sub-second in the fixture env (D9 float parsing), e.g. `0.0005` ≈ 1.8 s | ~2 s |
| **Web keep-alive** | `runs.keepalive_until` is a DB column: seed it, bump it through the **real** activity path. `runSweepTick()` is called directly, never waited for | ~0 s |

Every GREEN control runs in seconds with **no wall-clock dependency** — after this
change the supervisor no longer reads `MAISTER_KEEPALIVE_MINUTES`.

**Exception: the falsification run.** Falsifying RED 2 against unreverted `master`
puts the deadline back on the host's integer-minute timer (60 s floor) against the
integration project's 60 s `testTimeout` (`web/vitest.workspace.ts`). Run ad hoc
with a raised per-test timeout, elapsed time recorded; not committed as a suite
member.

**Do not use `expect.poll` for these waits** — its 1 s default budget is ample
idle and too tight under contention (`web/CLAUDE.md:250-256`). Await the real
condition; where a fake offers a hook on the awaited call, signal a deferred.

### D12 — `session_checkpointed` is a closed-enum change across four files

D4's typed refusal is **not** additive prose (C4). The complete edit set:

| # | File | Line | Required? | Why |
|---|---|---|---|---|
| 1 | `docs/api/supervisor.openapi.yaml` | `:3049` (append to `ReasonToken`) | **Required** | `openapi-examples.test.ts:133-143` asserts code ⊆ doc; code-without-doc fails CI |
| 2 | `supervisor/src/types.ts` | `:725` (append to `REASON_TOKENS`) | **Required** | the host must type-legally emit it |
| 3 | `docs/api/async/execution-host-events.asyncapi.yaml` | `:513` (its own `ReasonToken` copy) | **Required by this plan** | no test forces it; that copy is already **21 tokens behind**. Skipping deepens a known drift |
| 4 | `web/lib/execution-host/types.ts` | `:158` (`REASON_TOKENS`, 10 values, stale) | **Required** | D4's web branch narrows on the token |

Runtime is forgiving (`supervisor-client.ts:588-589` passes `details` through
untouched, no Zod gate strips unknown tokens), so the breakage is **type-level and
test-level**, not runtime — which is exactly why it would otherwise ship silently.

**Out of scope**: re-syncing the other 21 drifted tokens in file 3. Add only the
new token; file the drift as an R9 TODO (T0.7).

### D13 — The park has a bound that does not depend on the operator's tab

Closes C5. Pass 1 gains a **second, targeted candidate query** — not a widened
first one:

```
runs.status = 'NeedsInput'
AND the run's active session has an incarnation with state = 'checkpointed'
-- independent of keepalive_until
```

- **Positive witness.** `run_session_incarnations.state='checkpointed'` is written
  only for `session.exited{reason:"checkpoint"}` (`lifecycle-projector.ts:301-315`),
  and the partial unique index `run_session_incarnations_active_run_session_uq`
  (`schema.ts:4134-4139`, `WHERE state IN ('created','active','checkpointed')`)
  guarantees **at most one** qualifies per session. Not an inference from absence.
- **Its own query and its own `LIMIT`.** Pass 1 orders `asc(runs.keepaliveUntil)`
  and limits 50 (`keepalive-sweeper.ts:190`); rows with a future keepalive would
  sort last and starve behind up to 50 expired ones — the exact progress question
  the background-automation rule asks. A separate targeted loader also matches the
  "load only rows that can trip it" rule rather than widening a hot sweep.
- **Same CAS, same writer contract** (C2): it calls `markCheckpointed`, so it
  cannot double-park.
- **No new index.** It reuses Pass 1's existing `runs.status='NeedsInput'`
  candidate predicate and joins on an already-unique-indexed column.
- **It does not shorten the answer path** — D4 still handles an answer that lands
  first. The two are independent bounds on the same state.

**`checkpointed` only.** `exited`/`crashed` incarnations are terminal and belong to
the crash-reconcile paths, not the keep-alive sweeper. Admitting them here would
be the "exception list instead of a predicate" mistake from patch
`2026-09-21-17.09` in reverse — widening past the witness that justifies the arm.

### D14 — SOLID / KISS / DRY boundaries, stated so they are checkable

The user-facing principle is not "share code" but "share a *question*". Patch
`2026-09-21-15.45` names the failure: *"DRY applied to two questions that only
looked like one."*

| Decision | Ruling | Why |
|---|---|---|
| One `checkpointSession` reused by the route and the cap timer | **DRY — merge** | Genuinely one question: "park this session, keep the handle". |
| `http-api.ts:2226` (delete) and `:2389` (cancel) folded into it | **NOT merged** | Different questions with different post-conditions. Merging would repeat the 15.45 mistake. |
| Command boundary and terminal boundary behind one "find any checkpoint" helper | **NOT merged** | They are different *witnesses* with different trust. The resolved order carries which one proved it (D5) — collapsing them would erase the discriminator a test needs. |
| D4's web branch reusing the idle branch verbatim | **DRY — reuse** | Same question: "park and resume". A second resume path would drift. |
| `markCheckpointed` shared by four writers | **DRY — one CAS** | One question, one guard (C2). |
| SRP | `checkpoint-teardown.ts` owns teardown; `pending-permissions.ts` owns deferred lifetime; neither learns about the other's internals — the cap handler is injected (D10), not imported | Keeps the singleton trap contained and the seam testable. |
| KISS | No new `runs.status`, no new route, no injectable clock, no new index, one env var | Each was considered and rejected with a reason recorded here. |

### D15 — The evidence read is not index-covered, and that is accepted

The new predicate has **no covering index**. The closest,
`execution_events_run_sequence_idx` (`schema.ts:4203-4206`), leads with `run_id`,
so the plan is an index scan on `run_id` plus a heap filter over that run's events;
the other eight predicates — including the `payload->>'reason'` deref — are
unindexed residuals. `execution_events_source_run_key_uq` looks closer but is
partial `WHERE source_key IS NOT NULL`, and `source='host'` rows never have one.

**Accepted, not ignored**, for three reasons:

1. It is a **clone of a live pattern**, not a new one: `permission-handoff-evidence.ts:69-94`
   already issues the same 8-way boundary plus three `payload->>` filters with
   `.limit(2)`.
2. It is bounded by **one run's** event count, not the table's, and runs once per
   resume — not on a hot path.
3. Adding a partial expression index (precedent:
   `execution_commands_create_operation_uq`, `schema.ts:2388-2395`) would make the
   "no migration" claim false and pull in `docs/db/erd.dbml` regeneration
   (`:1090-1119`) plus a `0173_snapshot.json`, for a query that is not yet known to
   be slow.

The table is append-only and **never pruned** (`EVT-12`), so this is written down
rather than assumed. If a latency problem appears, the index is the follow-up, and
its cost is already scoped here.

---

## Contract surfaces → spec files

| Surface | Change | Spec file(s) |
|---|---|---|
| **`details.reason` token** | **`session_checkpointed` added to a CLOSED enum** | `docs/api/supervisor.openapi.yaml:3005-3049` **(the gating enum)**; `supervisor/src/types.ts:680-726`; `docs/api/async/execution-host-events.asyncapi.yaml:489-513`; `web/lib/execution-host/types.ts:147-158` |
| `POST /sessions/:id/input` 410 prose | names the new reason | `docs/api/supervisor.openapi.yaml:1287-1301` (**description only**); `docs/supervisor.md:729-738` |
| `POST /sessions/:id/checkpoint` prose | teardown shared with a host-initiated cap | `docs/api/supervisor.openapi.yaml:1062-1125`; `docs/supervisor.md:627-712` |
| `session.exited` payload | optional `cause` (single literal); `reason` enum untouched | `docs/api/async/supervisor-sse.asyncapi.yaml:467-494` (no `additionalProperties:false` → additive) |
| `POST /respond` 202 `state` | **verified: no change** — `resume-in-progress` is already in the closed enum | `docs/api/web.openapi.yaml:7540` |
| `MaisterErrorBody` | **verified: no change** — `details` is `additionalProperties: true`; the top-level `reason` at `:20573` is a 2-value enum and must **not** be used | `docs/api/web.openapi.yaml:20548-20588` |
| New env `MAISTER_PERMISSION_MAX_HOURS` | added | `docs/configuration.md`; `.env.example`; `supervisor/.env.sample`; `deploy/maister.env.example` |
| `MAISTER_KEEPALIVE_MINUTES` | re-scoped web-only | `docs/configuration.md:1163`; `docs/supervisor.md:979`; `supervisor/.env.sample:77-79`; `deploy/maister.env.example:71-73`; `.env.example:301-309`; `web/.env.sample:88`; `docs/getting-started.md:258`; `docs/decisions/adr-006.md:17-20,32-37` |
| `HITL_TIMEOUT` semantics | no longer "the host window elapsed" | `docs/error-taxonomy.md:48` |
| HITL keep-alive + state machine | one owner; host cap; race-window answer = resume | `docs/system-analytics/hitl.md:161-171,736-754,942-945,1032-1037,1075-1179` |
| Run-side keep-alive + the new sweep arm | D13 | `docs/system-analytics/runs.md:968,1126-1131,1258-1320,1438` |
| Host command-kind table | a host-initiated checkpoint is **not** a command | `docs/system-analytics/execution-hosts.md:487-503` (+ the `:347` sequence line) |
| Checkpoint permission handoff | boundary widened to the terminal witness | `docs/system-analytics/execution-prompt-lifecycle.md:739-777` (topical prose, **ungated**) |
| Sweep cadence row (stale) | corrected to the `system_sweep` 60 s tick | `docs/configuration.md:1176` |
| ADR | new ADR-180; amends ADR-006 | `docs/decisions/adr-180.md` + hub stub + index row |
| Stabilization plan | S5.3 named scenario; acceptance row citation | `.ai-factory/plans/stage-ab-stabilization.md:811,882` |
| Root agent contract | §1 "the 30-min keep-alive … is cost-saving" | `CLAUDE.md:696` |

**No** `session.exited` `reason` enum change · **No** `httpStatusForCode` change ·
**No** migration (D15) · **No** new `runs.status` · **No** new
`system-analytics/*.md` (D16 below).

### D16 — No new system-analytics doc: R7 forbids it

`docs/CLAUDE.md` R7 (`:247-252`) names the **supervisor wire contract** as one of
five things with exactly one canonical file, registered at `docs/CLAUDE.md:82` as
`docs/supervisor.md`. A `supervisor-teardown.md` would describe the same thing and
R7 closes with "collapse them". Existing docs absorb the change:

- supervisor internals → `docs/supervisor.md` (ungated: no R5 sections, no bullet
  cap, no traceability);
- host-side FSM/command table → `docs/system-analytics/execution-hosts.md`;
- manager-side handoff → `docs/system-analytics/execution-prompt-lifecycle.md`
  (topical section only).

**Gate constraints that shape the doc tasks:**

- `execution-prompt-lifecycle.md` Expectations is at **exactly 12 and gated** — a
  13th bullet fails `pnpm validate:docs`. Verified that this change needs none:
  `PRM-08` ("resume uses a new command and required incarnation") stays true —
  D5 changes how the checkpoint *ordering* is proven, not that resume uses a new
  command. `EDGE-PRM-04` (prompt-wait race) is likewise unaffected; T0.3 cites it
  and says so.
- `execution-hosts.md` Expectations is at 12 (ungated but R5a-capped) — the
  command-table note is prose, not a 13th bullet.
- `hitl.md` is at **42** bullets and `runs.md` at **24** — both already far over
  R5a, both ungated. **Edit existing bullets in place; do not add.** The split is
  an R9 TODO (T0.7), not this branch's work.
- A bullet written `- **PRM-13 (Implemented):** …` is **invisible** to the
  requirement-ID regex and silently needs no traceability row. This plan adds no
  requirement IDs, so the question does not arise — recorded so no one adds one
  by accident.
- **R6**: tag edited passages `(Implemented)`; **do not** add milestone numbers
  (`M8`, `M11a`) to current-plane prose — several existing passages this plan
  touches quote them, and they must not be propagated into new text.

---

## Phases

### Phase 0 — SDD freeze (no code)

**Exit criteria**: every artifact below complete and internally consistent;
`pnpm validate:docs` green (mermaid parse + ADR anchor/index/body bijection +
links + indexes + ERD check); `pnpm validate:contracts` green.

- [x] **T0.1 — ADR-180.** Create `docs/decisions/adr-180.md` ("Permission deadline
      has one owner"), the hub stub after ADR-179 (`docs/decisions.md:1818`), and
      the index row (`:45-223`). Decision text carries D1 with A+D+E chosen and
      B/C rejected with reasons, and D5's mechanism as E's justification.
      Consequences record the D2 escalation residual (unproven handle; owned by
      the resume failure classification; **no dedicated control**) and D7's
      deliberate non-change. Amendment note on `docs/decisions/adr-006.md`
      (`:17-20`, `:32-37`) — **not ADR-023** (C1).
      **AC**: `scripts/validate-docs-adr-anchors.mjs` passes the three-way
      bijection (index row ↔ stub ↔ body file, title/date/anchor compared);
      ADR-180 names ADR-006 as amended and ADR-023 nowhere; the residual window
      appears under Consequences.

- [x] **T0.2 — `docs/system-analytics/hitl.md`.** Rewrite the keep-alive section
      (`:736-754`, prose + `flowchart TD`; the hardcoded "30min" at `:749`/`:752`
      becomes the env-named web window). State machine `:161-171` — add the
      host-cap `Open → Open` self-transition and "no host action closes a HITL
      request" (C3); **no `Checkpointed` state**. Update the 410 rows at `:942-945`,
      `:1032-1037`, `:1156-1157`, `:1164-1169` with the `session_checkpointed`
      resume arm. Extend the two-phase table `:1139-1143` with D4's row. Expectations
      (`:777`, 42 bullets): **edit in place, add none** (D16).
      **AC**: mermaid parses; bullet count unchanged at 42; no `Checkpointed` state
      added; `:1320` Linked artifacts cites ADR-180; no `M<NN>` token in any new
      sentence.

- [x] **T0.3 — run-side, host-side, taxonomy.** `runs.md`: `:968`, `:1126-1131`,
      `:1292-1320` (keep-alive + idle sweeper), `:1438` (env list), **plus D13's
      new sweep arm**. `execution-hosts.md:487-503` — the `session.checkpoint`
      command row gains a note that a host-initiated checkpoint performs the same
      teardown **without** a command (and `:347`'s sequence line likewise).
      `execution-prompt-lifecycle.md:739-777` — the handoff gains the terminal
      witness; cite `EDGE-PRM-04` and state it is unchanged; **no Expectations
      edit** (`PRM-08` stands — D16). `docs/error-taxonomy.md:48` — `HITL_TIMEOUT`
      no longer means "the host window elapsed"; document
      `details.reason: "session_checkpointed"` as **non-terminal**.
      **AC**: `pnpm validate:docs` green; `execution-prompt-lifecycle.md`
      Expectations still exactly 12 bullets; `execution-hosts.md` still 12; every
      edited passage carries an R6 tag.

- [x] **T0.4 — supervisor contract + API specs.** `docs/supervisor.md`: `:627-650`,
      `:651-712`, `:714-743` (the 410 prose at `:733-736` currently says "timed out
      via `MAISTER_KEEPALIVE_MINUTES`"), `:979`, `:1144-1156`. OpenAPI: `:1062-1125`,
      `:1200-1315`, the 410 description `:1287-1301`, `HITL_TIMEOUT` prose
      `:2975-3004`. AsyncAPI `supervisor-sse.yaml`: `SessionExitedEvent` `:467-494`
      gains optional `cause` as a **single literal** `permission_cap` (the `reason`
      enum at `:484` untouched); intro prose `:23`, `:164` corrected.
      **AC**: `pnpm validate:contracts` green; `openapi-examples.test.ts` green;
      `supervisor-sse.asyncapi.yaml:484` byte-identical to master.

- [x] **T0.5 — the `ReasonToken` enum (D12).** Append `session_checkpointed` to
      `docs/api/supervisor.openapi.yaml:3049` **and**
      `docs/api/async/execution-host-events.asyncapi.yaml:513`. Doc-side only in
      this phase; the two code mirrors land in T2.4/T3.2 so the one-way
      `code ⊆ doc` assertion is never transiently violated.
      **AC**: both enums contain the token; `pnpm validate:contracts` green;
      `openapi-examples.test.ts` green (doc-ahead-of-code passes by design); no
      other token in either file is touched.

- [x] **T0.6 — `docs/configuration.md`.** Re-word `MAISTER_KEEPALIVE_MINUTES`
      (`:1163`) as web-only. Add the `MAISTER_PERMISSION_MAX_HOURS` row stating
      fractional values are accepted (D9). Correct the stale sweep-interval row
      (`:1176`) to the `system_sweep` 60 s tick.
      ⚠ **Placement**: the main table is `:1109-1164`, 4 columns
      `Var | Required | Default | Used by`, padded 48/70/67. Lines **1166-1222 sit
      inside an unclosed blockquote** and render as a second, quoted table. The new
      row goes in the **main** table (≤1164) with the padded widths.
      **AC**: the new row renders inside the main table (no leading `>`); column
      padding matches its neighbours; `:1176` no longer claims a singleton timer.

- [x] **T0.7 — R9 TODOs for defects found but not owned.** Append to
      `docs/decisions.md:1861` `## TODO (tracked doc defects)`, matching the
      existing entry's form (what, where, when found, why left alone):
      (a) the `configuration.md` blockquote that swallowed `:1175-1222` into a
      quoted table; (b) `execution_events_disposition_check` exists in
      `web/lib/db/migrations/0131_foamy_venom.sql:224` with **no counterpart in
      `schema.ts`** — a drizzle drift that will surface on the next `db:generate`
      for that table; (c) `execution-host-events.asyncapi.yaml`'s `ReasonToken` is
      21 tokens behind `supervisor.openapi.yaml`, unguarded by any test.
      **AC**: three entries added, each naming the file, the discovery date, and
      "left alone because R9 forbids touching an unrelated section in passing";
      **no** code or schema changed by this task.

- [x] **T0.8 — stabilization plan.** `.ai-factory/plans/stage-ab-stabilization.md`
      §S5.3 (`:811`) gains the named scenario: *"a permission older than the old
      host window while the operator is active → answered and delivered; an idle
      permission → checkpoint, resume, delivered"*. The "Single-host lifecycle
      regression" row (`:882`) cites it once green.
      **AC**: the scenario names its owning suite; the contract-surface table
      above is reproduced in the plan body.

**Commit 1** — `docs(adr-180): freeze the one-owner permission deadline contract`

### Phase 1 — RED

**Exit criteria**: every control fails for its stated reason on `master`, evidence
recorded per control. No production code changed.

- [ ] **T1.1 — supervisor unit REDs.** `pending-permissions.test.ts` (project
      `unit`): construct with an explicit `timeoutMs` (the singleton reads env once
      at import — D10) and assert expiry **resolves `{outcome:"cancelled"}` through
      the installed cap handler**, not `reject(HITL_TIMEOUT)`. New
      `supervisor/src/__tests__/shutdown.test.ts` (**none exists today** — a real
      gap): `cancel` called for every open requestId, `purgeSession` **not** called,
      `markIntentionalShutdown` precedes both.
      **AC**: both files run under `--project unit`; no env mutation after import;
      each assertion names the observable (the deferred's settled value, the call
      order), not an internal field.

- [ ] **T1.2 — supervisor integration REDs.** Project `integration`, real process,
      `mock-acp-adapter-resumable.mjs` + `MOCK_ACP_REQUEST_PERMISSION=1`. The cap is
      compressed **through the fixture env only** (D11):
      `MAISTER_PERMISSION_MAX_HOURS≈0.0005`.
      - **RED 1 — the teardown is graceful.** After the cap fires: the adapter
        received `{outcome:"cancelled"}` and exited on **SIGTERM**;
        `session.exited{reason:"checkpoint", cause:"permission_cap"}` emitted;
        `acp_session_id` retained **and provably usable** (a `session/resume`
        round-trip, not just a non-null column — outcome, not shape); **no**
        `producer_permission_failed`, `producer-output-incomplete`, or
        `session.crashed` in the host log.
      - **RED 3 — graceful shutdown.** SIGTERM the supervisor with a pending
        permission → adapter receives `cancelled`, exits on SIGTERM, no
        `shutdown-sigkill`, the prompt **not** stamped `required_output_incomplete`.
        Targets the primary pass (D7).
      - **RED 5 — the wiring seam ONLY.** That the cap handler is installed by the
        **real boot path** (`startRealSupervisor`): with the cap set, a pending
        permission is torn down at all. It asserts nothing about teardown
        semantics — RED 1 owns those. (Pre-refinement this duplicated RED 1.)
      - **RED 6 — the producer boundary holds.** A malformed permission request
        still fails `producer_permission_invalid` and SIGKILLs (D8).
      **AC**: four controls, each failing on `master` for a distinct reason; no two
      share an assertion; none uses `expect.poll` (D11).

- [ ] **T1.3 — web integration REDs + the blocking preflight.** Real Postgres
      (`test-support/pg-container.ts`) + real supervisor + a real `ProjectionWorker`.
      - **PREFLIGHT (blocking)**: terminal `session.exited` rows in
        `execution_events` carry non-null `eventStreamId` and `hostSequence`. If
        not, **stop** — D5 is not implementable as specified; re-raise before T3.1.
      - **RED 2 — the web owns the deadline.** With `MAISTER_KEEPALIVE_MINUTES`
        small in the fixture env, bump `keepalive_until` through the **real**
        activity path more than once, driving `runSweepTick()` between bumps and
        asserting no park; then answer — delivered, agent alive. No wall-clock wait.
        Falsification is ad hoc with a raised timeout (D11).
      - **RED 4 — answer in the race window, both sides.** (a) after a host
        checkpoint but before any park → 202 resume-in-progress, run **never**
        `Failed`; (b) the same answer after the 30 s terminal grace → 503, and the
        next `runSweepTick()` parks the run.
      - **RED 7 — the terminal witness is what proves it.** A host-initiated
        checkpoint resumes **and the resolved order reports `boundary: "terminal"`**.
        Without that assertion the control passes on `master` whenever the sweep
        happens inside the 30 s registry grace, and proves nothing after it
        (D5) — pre-refinement it did not test the extension at all.
      - **RED 8 — the driver front-run.** The flow driver parks the run via
        `markCheckpointedFromExit` before any sweep tick, so **no checkpoint command
        row is ever minted**; the answer still resumes.
      - **RED 9 (new) — the park is bounded without the operator.** A run in
        `NeedsInput` whose session incarnation is `checkpointed`, with
        `keepalive_until` kept in the **future** by real activity bumps, is parked
        by `runSweepTick()` anyway (D13), and Pass 2's 24 h rule can then reach it.
        *On master and on the unrefined plan*: never parked, never abandoned.
      - **Run-kind assertions**: for `agent` and `scratch` permissions, assert only
        that the answer is **not terminal**. Their idle paths are not widened here.
      **AC**: the preflight runs first and gates T3.1; six controls with disjoint
      failure modes; RED 7 asserts the witness discriminator; RED 9 asserts a park
      with a future `keepalive_until`.

**Commit 2** — `test(permission-deadline): RED — host expiry kills the agent`

### Phase 2 — Supervisor GREEN

**Exit criteria**: RED 1/3/5/6 green; **full supervisor suite green**
(`pnpm --filter @maister/supervisor test`), no loosened expectations; refactor gate
below passed.

- [ ] **T2.1 — extract the teardown.** New `supervisor/src/checkpoint-teardown.ts`
      per D2. `http-api.ts:2528-2600` calls it; the route's `runCommand` envelope,
      status codes and log fields unchanged. Do **not** unify `:2226`/`:2389` (D14).
      **AC**: the route's observable behaviour is byte-identical (existing
      `checkpoint.test.ts` + `lifecycle.integration.test.ts` green unchanged); the
      new module imports neither the registry singleton nor `pendingPermissions`
      directly (D14/SRP).

- [ ] **T2.2 — the cap replaces the keep-alive timer.** `pending-permissions.ts`:
      delete `keepaliveMinutesEnv`; read `MAISTER_PERMISSION_MAX_HOURS` via
      `Number.parseFloat` + `Number.isFinite(v) && v > 0`, invalid → 24 with a
      one-time WARN (D9). The timer calls the installed cap handler instead of
      `deferred.reject`. Add `onCapExceeded` + `setCapHandler` and wire **both**
      sites (D10): `main.ts` and `_fixtures/boot-host.ts`.
      **AC**: RED 1 and RED 5 green; `grep MAISTER_KEEPALIVE_MINUTES supervisor/src`
      returns nothing; a fractional cap is honoured; an invalid value logs once.

- [ ] **T2.3 — shutdown order.** `shutdown.ts:16-39` per D7. `purgeSession` removed
      from this path; `registry.ts:126,194` untouched.
      **AC**: RED 3 green; `purgeSession` has exactly two callers, both on
      already-exited sessions.

- [ ] **T2.4 — the typed refusal + its token.** `http-api.ts:2681-2688` per D4:
      the `INTENTIONALLY_PARKED` allow-list predicate (`fenced` excluded),
      `details:{reason:"session_checkpointed"}`, status still 410. Append the token
      to `supervisor/src/types.ts:725` (D12 item 2).
      **AC**: `openapi-examples.test.ts` green (code ⊆ doc holds because T0.5
      landed first); a `fenced` terminal still produces today's response; the
      predicate is a named `ReadonlySet`, not an inline `===`.

- [ ] **T2.5 — the `cause` field.** Emit `cause: "permission_cap"` on the
      cap-initiated `session.exited` (D6). No publisher change needed.
      **AC**: the value reaches `run_session_incarnations.terminalReason`;
      `session-stream.ts` still decodes the event (regression assertion, not a code
      change).

- [ ] **T2.6 — deprecation WARN.** `main.ts`: one WARN if
      `MAISTER_KEEPALIVE_MINUTES` is set in the supervisor env, naming the
      replacement. **Never a refusal.**
      **AC**: boot succeeds with the old var set; exactly one WARN per process.

- [ ] **T2.R — REFACTOR gate (supervisor).** With the suite green: re-read the diff
      against D14. Collapse only duplication that answers one question; split
      anything that grew two responsibilities; remove orphans **this change**
      created (imports, the deleted env helper's references). No behaviour change —
      the suite must stay green across the refactor without editing a test.
      **AC**: `pnpm --filter @maister/supervisor test` green before and after with
      zero test edits; `pnpm lint` at the 0-errors baseline (it is `eslint --fix` —
      check `git status` before staging).

**Commit 3** — `fix(supervisor): host give-up is a checkpoint, never a SIGKILL`

### Phase 3 — Web GREEN

**Exit criteria**: RED 2/4/7/8/9 green; **full web suite green**
(`pnpm --filter maister-web test`); refactor gate passed.

- [ ] **T3.1 — the evidence boundary.** `permission-handoff-evidence.ts:63-116` per
      D5: nullable `checkpoint`, alternate terminal-event boundary selected with
      `.limit(2)` requiring **exactly one** match, `unproven` preserved, and the
      resolved order carrying `boundary: "command" | "terminal"`. Update the four
      consumers (`permission-resume.ts:219-241`,
      `permission-result-evidence.ts:181,200,225-226`,
      `permission-handoff-source.ts:183-186`,
      `agent-permission-handoff.ts:250,331`).
      **Assertion migration is in-scope here** — name each suite before editing:
      `permission-resume`, `gate-permission-resume` (6 combos),
      `gate-permission-result`, `permission-result-failure`,
      `agents/__tests__/prompt-owners`, `execution-host/__tests__/lifecycle-regression`.
      Every changed expectation is classified **obsolete** (the contract moved) or
      **broken** (we did) — never loosened.
      **AC**: RED 7 and RED 8 green; two witnesses never collapse into one helper
      (D14); a run with neither witness still returns `unproven` and its caller
      still parks/pends as before; every migrated assertion carries its
      obsolete/broken classification in the commit body.

- [ ] **T3.2 — the race-window branch + its token.** `hitl.ts`: the
      `session_checkpointed` branch per D4, placed **before** the noop-idempotent
      check at `:1520-1545`. Reuse the idle branch verbatim (`:1211-1345`) — no
      second resume path (D14). Append the token to
      `web/lib/execution-host/types.ts:158` (D12 item 4).
      **AC**: RED 4(a) and 4(b) green; the run is never `Failed`/`Crashed` on this
      path; the 202 body's `state` is `resume-in-progress` (already in the closed
      enum — no spec edit); the respond route suite loads its module in
      `beforeAll`, not lazily in a test (`web/CLAUDE.md:233-256`).

- [ ] **T3.3 — the keepalive-independent park (D13).** A second targeted candidate
      query in Pass 1 with **its own `LIMIT`**: `NeedsInput` runs whose active
      session holds a `checkpointed` incarnation, independent of `keepalive_until`.
      Calls the same `markCheckpointed`.
      **AC**: RED 9 green; the new query is separate from the keepalive query (not
      an `OR` widening the existing one); `checkpointed` only — an `exited` or
      `crashed` incarnation is not selected; no new index and no migration.

- [ ] **T3.4 — writer reconciliation.** Record in a code comment and in `hitl.md`
      that four paths now perform `NeedsInput → NeedsInputIdle` (sweeper keepalive
      arm, sweeper checkpointed arm, `markCheckpointedFromExit`, the D4 branch) and
      that they are safe because all four share `idleFromNeedsInput`'s CAS (C2).
      No gate added; no event-driven consumer added.
      **AC**: the comment names all four and the CAS; `hitl.md` says the same in
      one sentence; no new status guard introduced.

- [ ] **T3.R — REFACTOR gate (web).** Same contract as T2.R, plus: verify the four
      evidence consumers did not each grow their own copy of the boundary
      selection — one function, four callers (D14).
      **AC**: `pnpm --filter maister-web test` green before and after with zero
      test edits; `pnpm lint` at the 0-errors / 14-warnings baseline.

**Commit 4** — `fix(hitl): a checkpointed permission answer resumes instead of failing`

### Phase 4 — Wiring, as-built docs, lane re-qualification

- [ ] **T4.1 — deployment touchpoints.** `supervisor/.env.sample` — remove the
      `[shared]` keep-alive block (`:77-79`), add `MAISTER_PERMISSION_MAX_HOURS=24`
      with a comment naming the web-side owner. `.env.example:301-309` — re-scope
      the comment block to web-only; add the cap in the supervisor section.
      `deploy/maister.env.example:71-73` — same. `web/.env.sample:88` — correct the
      comment (the var stays; it is the web's). `docs/getting-started.md:258`.
      **No compose change**: per ADR-023 web and supervisor run on the host and
      compose containerizes Postgres alone (`grep KEEPALIVE compose*.yml` is empty
      today; neighbouring rows read "Host/service-env only — never a compose var").
      Recorded so the absence is a decision, not an omission.
      **AC**: every file that mentioned the old var is updated or deliberately
      left; the new var appears in all three supervisor-facing samples; zero
      compose diffs.

- [ ] **T4.2 — Stage A/B lane re-qualification, the two lanes run SEPARATELY.**
      (Owner decision.) `pnpm --filter @maister/supervisor test:integration:ab` and
      `pnpm --filter maister-web test:integration:ab` are **two distinct runs on a
      quiet machine, never concurrent**, each compared against its own `master`
      baseline failure set **by name, not by count**. Running them together
      manufactures failures at load and makes the sets indistinguishable.
      `scripts/run-stage-ab-tests.mjs` hard-codes its suite list and asserts
      `report.testResults.length === files.length`, so a renamed suite fails the
      lane — update the list in the same task if any is renamed.
      **AC**: two recorded runs; failure sets identical to their baselines by name;
      `pmset -g log` checked before attributing any timeout; each lane grepped for
      `| N skipped`.

- [ ] **T4.3 — as-built sweep + gates.** Re-derive the contract-surface list from
      the actual diff and reconcile against the Phase-0 table. `pnpm validate:docs`,
      `pnpm validate:contracts`, `pnpm lint`. Update `CLAUDE.md:696`.
      **AC**: the derived list equals the planned list, or every difference is
      explained in the commit body; all three gates green; `git status` clean of
      `eslint --fix` collateral.

**Commit 5** — `docs(permission-deadline): as-built sweep + Stage A/B re-qualification`

---

## Refactor gates (the R in RED → GREEN → REFACTOR)

`T2.R` and `T3.R` are first-class tasks, not a habit. Each runs **after** its
phase is green, changes **no** behaviour, and is bounded by three questions:

1. **DRY by question, not by shape** (D14) — is this duplication two spellings of
   one question, or one spelling of two questions?
2. **Orphans this change created** — imports, helpers and env readers made unused
   by this diff are removed; pre-existing dead code is left alone (root CLAUDE.md).
3. **The suite is the invariant** — if a refactor needs a test edited, it is not a
   refactor. Revert and reconsider.

---

## Test plan

### Controls (9, disjoint)

| # | Control | Lane | Fails on master because |
|---|---|---|---|
| RED 1 | the teardown is graceful and the handle is usable | supervisor integration | SIGKILL, `session.crashed` |
| RED 2 | the web owns the deadline | web integration | 410 at T+30 min regardless of activity |
| RED 3 | graceful shutdown does not SIGKILL itself | supervisor integration | `purgeSession` rejects → `abortOutput` SIGKILL |
| RED 4 | answer in the race window (410 and 503 sides) | web integration | 410 → run `Failed` |
| RED 5 | the cap handler is installed by the real boot path | supervisor integration | no cap exists |
| RED 6 | producer faults still SIGKILL | supervisor integration | guard — must stay green |
| RED 7 | the **terminal witness** proves the order | web integration | no such boundary; passes vacuously without the witness assertion |
| RED 8 | driver front-run: no command row ever minted | web integration | unresumable |
| RED 9 | the park is bounded without the operator | web integration | never parked, never abandoned |

**Overlap audit** (the refinement's own ruling): RED 5 no longer re-asserts RED 1's
teardown semantics; RED 7 no longer passes via the command boundary; every control
above fails for a reason no other control fails for. **No trivial controls**: each
asserts a behaviour that a plausible wrong implementation would get wrong — none
asserts a constant, a type, or a field's mere presence.

**Assertion style**: target the outcome, never the shape. Patch `2026-09-21-19.10`
is the precedent — a suite asserting a link's *shape* could not tell a correct link
from one that opened the wrong population. Concretely: RED 1 resumes the handle
rather than checking it is non-null; RED 7 names the witness; RED 9 asserts the row
parked, not that a query ran.

### Falsification

- Revert the timer's action to `reject` → **RED 1 fails** with the SIGKILL evidence.
- Revert the shutdown order → **RED 3 fails** with `shutdown-sigkill`.
- Drop the D4 branch → **RED 4 fails** with the run `Failed`.
- Revert the boundary to command-only → **RED 7 and RED 8 fail** with
  `source_checkpoint_pending`.
- Remove D13's arm → **RED 9 fails**: the run stays `NeedsInput` forever.

Each is run and its failure recorded. RED 2's falsification is the one that cannot
run inside the lane (D11) — ad hoc, raised timeout, elapsed time recorded.

The D2 escalation window is an accepted residual and deliberately has **no**
control — do not add one, and do not let a control assert a clean park there.

### Existing suites that must stay green without loosened expectations

Supervisor: `pending-permissions`, `checkpoint`, `permission-roundtrip`,
`lifecycle`, `execution-fence`, `guardrail-interceptor`, `m8-resume-spike`,
`registry`, `heartbeat-observability`, `openapi-examples`, `bounded-acp-stream`,
`cancel-route`.

Web: `keepalive-sweeper`, `state-transitions`, `hitl` (unit + integration),
`hitl-permission-ledger`, the respond route suites, `permission-resume`,
`gate-permission-resume`, `gate-permission-result`, `permission-result-failure`,
`prompt-owners`, `lifecycle-regression`, `deliverer`, `resume-recovery`,
`system-sweeps`, `instrumentation`, `migration-journal-integrity`.

### Lane hygiene

- Quiet machine; failure sets compared by **name** against a `master` run.
- `pmset -g log` before attributing any timeout to the code.
- `grep` each lane for `| N skipped` — a module-scope call into a partially mocked
  module fails whole files as SKIPS and only the full lane sees it.
- Do not run beside the S5.2 isolation slice, and never run the two Stage A/B lanes
  concurrently (T4.2).
- `pnpm <script> -- <args>` leaks the `--`; pass vitest file lists without it.

---

## Traps

1. **`pendingPermissions` is a module-level singleton** created at import with the
   timeout read once (`:53`, `:241`). Construct with explicit `timeoutMs` or
   isolate the module; never set env after import.
2. **Two windows after a terminal**: 410 while the registry entry lives (30 s), 503
   after `registry.remove`. RED 4 covers both.
3. **`cause` must not be a new `reason` value** — `session-stream.ts:132-150`
   validates `reason ∈ {checkpoint,intentional,fenced}` and drops the whole event
   otherwise, hanging the driver.
4. **`details.reason` is a closed enum in two spec files and two TS mirrors** (D12).
   The mirror test is one-way: doc first, then code, or CI fails.
5. **Do not touch `abortOutput` for real producer faults** (D8). RED 6 guards it.
6. **`hitl.ts:1520-1545` is a known dead end** (C2) — the new branch goes before it.
7. **The command admission event needs a live registry entry** (`http-api.ts:691`,
   30 s grace vs a 60 s tick) — this is why the terminal witness exists (D5).
8. **Sweep cadence is 60 s.** Drive `runSweepTick()` directly; do not wait on the
   clock, and do not use `expect.poll` (1 s default).
9. **`configuration.md` rows 1166-1222 are inside an unclosed blockquote** — the
   new row belongs in the main padded table at ≤1164 (T0.6).
10. **`execution-prompt-lifecycle.md` Expectations is at the gated cap of 12** — a
    13th bullet fails `pnpm validate:docs`. This change needs none (D16).
11. **`pnpm lint` is `eslint --fix`** and mutates the tree; check `git status`
    before staging. Baseline: 0 errors / 14 warnings.
12. **`git stash` is shared across worktrees** — use a WIP commit, or
    `git stash push -u -m "<tag>"` + `apply <sha>`, never bare `pop`.

---

## Out of scope

- **P0-4** — operator-facing reason strings and card state, and the misleading 503
  wording. It *inherits* D4's `details.reason` discriminator for its copy.
- **P0-2 / ADR-177 arms** — untouched; D7 pins the existing `turn_lost` boundary.
- **S5.2 fixtures and CI** — disjoint file set; the two items run in parallel.
- **Widening the agent/scratch idle paths** — only the flow path is pinned end to
  end; agent and scratch get "the answer is not terminal" assertions.
- **The resume-prompt watchdog gap** (`MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` is
  wired but never armed — `docs/configuration.md:1182`).
- **Re-syncing the 21 drifted `ReasonToken` values** in
  `execution-host-events.asyncapi.yaml` — add only the new token; the drift is a
  T0.7 TODO.
- **Splitting `hitl.md`'s 42-bullet Expectations** to the R5a cap — a separate
  piece of work; T0.7 records it.
- **An index on the new evidence predicate** — accepted as an unindexed residual
  (D15); revisit only if measured.

## Follow-ups (separate)

1. **S5.3** — prove the *real* adapters honour a mid-turn `{outcome:"cancelled"}`
   and re-issue the request after `session/resume` (`claude-agent-acp`,
   `codex-acp`). This plan asserts the **mock-adapter** contract only.
2. The `configuration.md` blockquote (T0.7a).
3. `execution_events_disposition_check` schema drift (T0.7b).
4. `execution-host-events.asyncapi.yaml` `ReasonToken` drift (T0.7c).
5. `heartbeat-observability.test.ts` covers logging only — the `session.exited` vs
   `session.crashed` classification has no unit coverage.
6. `web/lib/__tests__/_fixtures/mock-acp-adapter.mjs` is orphaned.

---

## Resolved questions

All settled with the owner on 2026-09-22 — no open questions remain.

| # | Question | Answer | Where it landed |
|---|---|---|---|
| 1 | Evidence: phased or full? | **Full** — terminal-event boundary in this increment | D1 option E, D5 |
| 2 | Shutdown terminal reason? | **Order only**, `reason` stays `intentional` | D7 |
| 3 | Cap env name/default? | `MAISTER_PERMISSION_MAX_HOURS=24` | D9 |
| 4 | Compress windows how? | **Test env only**, no injectable clock | D11 (forced D9's float parsing) |
| 5 | `cause` — value or enum? | **One value**, `permission_cap` | D6, T0.4 |
| 6 | D2 escalation window? | **Accepted residual**, no control | D2, T0.1, Falsification |
| 7 | Stage A/B lane? | **Two separate runs**, sets compared by name | T4.2 |
| 8 | Apply the `/aif-improve` findings? | **All of them** | this revision |
