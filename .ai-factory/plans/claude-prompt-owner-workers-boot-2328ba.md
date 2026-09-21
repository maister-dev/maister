# Implementation Plan: Activate the durable prompt-owner and continuation workers in the production web boot (P0-2)

Branch: `claude/prompt-owner-workers-boot-2328ba` (worktree HEAD = `3b83c7bc` = master)
Created: 2026-09-20

## Settings

- Testing: **yes** — RED-first; the proof lane is production-boot integration (`startRealWeb`), not mocked unit suites.
- Logging: **standard** — Scope 4's minimum is the contract: one INFO per worker at start and stop. No verbose DEBUG additions; the workers already log `*-degraded` at ERROR.
- Docs: **yes** — mandatory docs checkpoint. Phase 0 is docs-first per the project's `aif-plan` skill-context rule ("front-load a complete, internally consistent analytics/design spec before any code phase").

## Roadmap Linkage

Milestone: "none" — **owner decision, 2026-09-21: linkage not required.**
Rationale: this is an undelivered obligation of `.ai-factory/plans/stage-ab-stabilization.md` (S2.12 addendum, S5.2 gate), not a `ROADMAP.md` milestone; ROADMAP's open item is M51, which is unrelated. `/aif-verify --strict` should report WARN for missing linkage alone, not fail.

---

## Ground truth — corrections and additions to the request

The request's ground truth was verified against `3b83c7bc`. It is accurate except where noted. **Seven findings change the work** (C6 and C7 were added by the `/aif-improve` pass on 2026-09-21 and one of them is a correctness defect the first draft would have shipped); do not re-derive them.

### C1 — The Playwright e2e lane WILL start the workers (trap 6 is real, not hypothetical)

`web/playwright.config.ts:102` → `command: 'pnpm exec next dev -p ${PORT}'`. `next dev` runs `instrumentation.ts` → `registerNodeRuntime()`. So the three workers boot in the e2e lane against `e2e/_seed/test-supervisor.ts`.

Mitigating context: the lane **already** tolerates background drivers — `startSchedulerTimer()` (`instrumentation-node.ts:187`) and `runReconcileSweep()` (`:159`) run at dev boot today. The delta is **cadence** (1 s idle wake vs 60 s tick), not kind. That is still enough to re-drive a deliberately-parked seed fixture. Owner decision: **in-scope, run and fix** (Phase 5).

### C2 — `driveResume` returns `transient` and deliberately leaves the run re-entrant, with NO backoff

`web/lib/runs/recover.ts:555-573`: `isFencedError` → `{state:"transient"}`; `EXECUTOR_UNAVAILABLE` → `{state:"transient"}`, comment: *"leave Running, NO rollback; an operator/sweeper can retry, and the reconcile sweep re-enters the committed intent through the same claim."*

That is designed for a **60 s** retry cadence. The Scope-6 arm would re-match the same run on the very next 1 s idle wake, on **2 slots**, each doing `applyCrashedTurnEvidence` (host I/O) before failing again. A supervisor outage becomes an unbounded hot retry loop against an already-failing supervisor.

**Consequence: adopting Scope 6 is NOT "a predicate addition plus a `driveResume` call".** It requires a durable, intent-scoped retry budget with backoff — which is a migration. See Phase 4. This directly invokes the skill-context rule *"Plan MUST design background automation for progress, bounded retries, and poison items"* (§2 bounded retries with an intent-scoped budget filtered by re-arm; §3 poison-item policy).

### C3 — `claimFlowDriver` already serializes the dispatch; the pre-dispatch stretch is already idempotent

`web/lib/flows/graph/driver-claim.ts:83-111` is called from exactly one place, `web/lib/flows/runner.ts:75`. So:

- Two concurrent `driveResume` calls both reach `runFlowFn` → one takes the driver lease, the other gets `null` and no-ops. **Single-winner at dispatch is already guaranteed.**
- The pre-dispatch work is idempotent by construction: `applyCrashedTurnEvidence` handles `PromptOwnerHandoffLost` → `evidenceAlreadyApplied` (`crash-recover.ts:266-281`); `closeCrashedNodeAttempts` is a guarded `UPDATE ... WHERE status='Running' AND ended_at IS NULL` (`:317-338`).

**So the worker must NOT take `claimFlowDriver` itself** — `runFlow:75` would then get `null` and the dispatch would silently no-op. The claim stays where it is. What is missing is not correctness, it is **rate limiting** (C2).

### C4 — The worker-starting suite set is larger than the request's list

`grep -rln 'startPromptOwnerWorker|startFlowContinuationWorker|startAgentContinuationWorker'` returns, beyond the request's list:

- `lib/agents/__tests__/agent-session-reobserve.integration.test.ts`
- `lib/flows/graph/__tests__/consensus-prompt-owners.integration.test.ts`
- `lib/scratch-runs/__tests__/prompt-owners.integration.test.ts`
- `test-support/agent-pause-response-process.ts` (a forked driver child, not a suite)

All of these are in the "green without loosened expectations" set.

### C5 — Observability is asymmetric today

- `startPromptOwnerWorker` already logs `prompt-owner-worker-started` (`prompt-owner-recovery.ts:88-95`, with `ownerKinds` + `concurrency`) and `prompt-owner-worker-stopped` (`:108`). **Nothing to add.**
- `startFlowContinuationWorker` logs **neither**, and has **no `workerId`**.
- `startAgentContinuationWorker` logs **neither**, has **no `workerId`**, and is a **single loop** (slot count 1, not 2).
- `stop()` rethrows `shutdownFailure` in the prompt-owner worker (`:106`) and the flow worker (`continuation-worker.ts:237`) but **not** in the agent worker (`agents/continuation-worker.ts:230-238`). Recorded as a finding; **not** in scope to change (RED E asserts the prompt-owner path, which does rethrow).

### C6 — the crash-recover predicate alone is NOT a dispatch decision; liveness routes it (found by `/aif-improve`, 2026-09-21)

`reconcile.ts:1543-1546` computes `crashRecoverPending` as **exactly** the Scope-6 predicate:

```
cand.runKind === "flow" && cand.resumeStartedAt !== null && cand.currentStepId !== null
```

but the classifier then routes that state **by session liveness**, and the two arms call **different** functions:

| Liveness (`input.liveSession`) | action | dispatcher |
|---|---|---|
| no live session, past grace (`reconcile.ts:455-457`) | `recover` | `driveResume` (`:1873`) |
| **live session** (`:398`) | `reattach` | `runFlow(crashResume)` directly (`:1906-1909`) — **never** `driveResume` |

A worker arm that applies `driveResume` to the raw SQL predicate has **no liveness discrimination**. On the `runningIdleSession` state — a LIVE session whose driver lease lapsed, the exact state ADR-175 added a counter for (`:1928-1931`) — `driveResume` would run `closeCrashedNodeAttempts` against a **live `Running` attempt** and then `runFlow(crashResume)` would append a fresh attempt and re-prompt. **That double-spends a turn the live session is still producing** — the class of patch `2026-09-18-16.45` finding #2.

Liveness is not SQL-derivable: `reconcile.ts:1353` resolves it from **one** `hosts.local().listSessions()` call per tick, and `:1420` skips the whole tick when that call throws. The worker must do the same — but only for a candidate that has already passed the cheap SQL filter and the grace guard, so the probe is per-rare-candidate, not per-tick. See D16.

### C7 — `driveResume` has THREE existing dispatchers, and `resume_started_at` has TWO write sites

Dispatchers: `reconcile.ts:1873` (ADR-175 recover arm) · **`scheduler.ts:642`** (queued-recover promotion, `resumeFn`) · `recover.ts:306` (`resumeCrashedRun` Phase 2, the operator's click). The worker becomes the **fourth**.

Write sites for the claim marker: `recover.ts:252` and `:278` (the recover claim) · **`scheduler.ts:911`** (`Pending → Running` promotion stamps `resumeStartedAt: now` whenever `isResume`). Release sites, all five: `runner-graph.ts:2410` (CAS-clear on `crashResume`) · `crash-recover.ts:358` (`clearCrashRecoverMarker`) · `recover.ts:645` · `state-transitions.ts:1376` · `state-transitions.ts:1473`.

Unrelated name collision to be aware of while grepping: `lib/domain-events/orchestrator-resume.ts:262` declares its **own local** `async function driveResume` — a different function, called at `:233`.

### Confirmed verbatim from the request

`PromptOwnerSchema` has exactly the five kinds `flow_node_attempt | agent_turn | scratch_message | gate_chat | sync_resolution` (`prompt-owner-contract.ts:127-148`). Six domain registries exist at the cited lines. `createPromptOwnerRegistry` throws `CONFIG` on a duplicate kind (`prompt-owners.ts:104-105`). `projectionLimitsFromEnv().concurrency` = 2, env-capped at max 2 (`projection-limits.ts:20`). The boot loop, quiesce set and drain `AggregateError` are exactly as described (`instrumentation-node.ts:91-128`, `205-229`).

---

## Decisions (frozen — do not relitigate during implementation)

| # | Decision | Reason |
|---|---|---|
| D1 | Composition root at **`web/lib/workers/runtime.ts`**, imported ONLY by `instrumentation-node.ts` via dynamic `await import()`. | Trap 1. Every domain registry imports `@/lib/execution-host`; a registry module inside `execution-host/` cycles at module load and fails mocked suites as SKIPS. Dynamic import also keeps the flow runner out of any eager module graph. |
| D2 | Health aggregate at **`web/lib/workers/health.ts`** — a small module with **no domain imports**, reading three `globalThis` slots written by `runtime.ts`. `runtime.ts` imports `health.ts`; never the reverse. | `lib/execution-host/platform-status.ts` lives inside `execution-host/`, so importing the composition root from it re-creates the forbidden cycle. It also reports only the REMOTE supervisor's health (`types/platform-status.ts`) — a different thing. The split gives P0-7 a cycle-free import target. |
| D3 | `durableWorkersHealth()` is consumed by **`lib/scheduler/system-sweeps.ts`** as one structured log line per `system_sweep` tick, following the existing per-sweep try/catch shape (`system-sweeps.ts:295-435`). No new metrics table, no new route. | Scope 4's "or the `system_sweep` summary" branch; avoids conflating remote and local health. |
| D4 | `agent_turn` is served by **`consensusDraftPromptOwners`**. Adding `agentPromptOwners` beside it is a `CONFIG` boot failure **by design**. | Locked. `agentPromptOwners` refuses `consensus_draft`; `consensusDraftPromptOwners = createAgentPromptOwners({prepareConsensusDraft})` routes drafts to draft prep and every other variant to `agentPromptOwner.prepare` (`agents/prompt-owner.ts:623-640`). |
| D5 | Boot-time kind-set check derives the expected set from **`PROMPT_OWNER_SHAPES`** (`prompt-owner-contract.ts:154-164`), mirroring the projection registry check at `projection-runtime.ts:38-52`. Disagreement → `CONFIG`. | One SSOT. The DB CHECK already derives from the same shapes, so registry / schema / constraint cannot drift apart silently. |
| D6 | **No feature flag.** No env var gates worker start. | Scope 3 + S5.2's "no production test flags" + the plan's deployment rule forbidding a half-activated owner. The projection worker ships without a switch. |
| D7 | Slot counts stay `projectionLimitsFromEnv().concurrency` for the prompt-owner and flow workers; the agent worker stays a single loop. **No new env vars.** | Locked. |
| D8 | The worker does **NOT** call `claimFlowDriver`. | C3 — it would make `runner.ts:75` return `null` and the dispatch a silent no-op. |
| D9 | **Scope 6 ADOPTED** (owner decision, 2026-09-20), with the backoff + intent-scoped budget C2 makes mandatory. The reconcile `recover` arm is **unchanged** and remains the backstop. | Locked micro-decision: "Reconcile keeps its ADR-175 `recover` arm regardless of Scope 6's outcome." |
| D10 | Scope 6's retry state is **two new nullable/defaulted columns on `runs`**, not a new table and not an in-memory map. | Skill-context §1: a durable per-item attempt marker. A process-local map dies with the process — precisely the failure mode this item exists to fix. Single-table keeps the hot predicate join-free. |
| D11 | The Scope-6 retry budget is a **module constant**, not an env var. | Keeps the deployment-touchpoint surface at zero (see "Deployment touchpoints" below). |
| D12 | No predicate widening beyond Scope 6. In particular the flow worker's `node_type ∈ (ai_coding, judge, orchestrator)` arm is **not** widened to `consensus` (that is B4, a separate item). | Locked. |
| D13 | Commit messages carry **no AI co-author trailer**. | Owner's standing rule (memory: `commit-trailer-skill-conflict`), which takes precedence over the harness attribution reminder. |
| D16 | **ONE shared recover-vs-reattach decision.** Extract the liveness-routed choice into a single pure helper (`lib/runs/crash-recover-route.ts`) consumed by BOTH `reconcile.ts` and the worker. The worker resolves liveness with `hosts.local().listSessions()` **only** for a candidate that already passed the SQL filter AND the grace guard; a throwing probe **yields** the candidate to the sweep and never dispatches blind. | C6. DRY (user requirement) and the direct fix for the double-spend. Patch `2026-09-18-16.45` root cause: a second copy of a predicate drifts — here the copy would not just drift, it would be wrong on day one. Mirrors `reconcile.ts:1420`'s skip-on-probe-failure. |
| D17 | The three `globalThis` slots use **`Symbol.for("maister.durable-workers.<name>.v1")`**, not plain `var` properties. | `runtime.ts` loads from the instrumentation bundle, `health.ts` from the `system-sweeps` bundle. That is exactly the case `server-lifecycle.ts:8` documents: *"Next bundles instrumentation separately from the production server entrypoint. The shared process key retains callbacks bound to the actual runtime modules."* `projection-runtime.ts`'s plain `var` is safe only because one module owns both sides. |
| D18 | The budget reset happens at **every** claim-marker WRITE site (`recover.ts:252`, `:278`, `scheduler.ts:911`), never by chasing release sites. | C7. Five release sites exist and two of them (`state-transitions.ts:1376`, `:1473`) are reparks that would strand a non-zero `crash_recover_attempts` into an unrelated future intent — the stale-marker defect shape of patch `2026-09-18-16.45` finding #1. Resetting at write makes every new intent start from zero regardless of how the previous one ended. |
| D15 | **Playwright seed/spec fixes land in the SAME commit as the measurement** (commit 6, tasks 20–22), regardless of how large the delta turns out. The one carve-out: if a delta exposes a genuine **production** defect, that fix gets its own commit inside the same phase — so a behavioural change is never buried inside an e2e-fixture diff. | Owner decision, 2026-09-21. A measurement commit that leaves the lane red is not a checkpoint; splitting fixture churn from its own evidence makes the failure-set diff unreproducible. |
| D14 | **ADR-176 records Scope 6 and nothing else.** The boot wiring, the composed-registry contract and the health surface get **no ADR** — they are the execution of the stabilization plan's normative D2 behind the S2.12 gate, and their *contract* lands in `execution-prompt-lifecycle.md` (Task 2). | `docs/CLAUDE.md` R4: **one decision per ADR** — *"If you feel a need for ADR-007a / ADR-007b, split into two ADRs."* Bundling both surfaces was the original draft's error. Activating an already-decided obligation is not a decision; **Scope 6 is**, because `docs/decisions/adr-175.md:138-143` names the automation boundary and explicitly declines to cross it: *"a crash-recover re-entry carries no per-run bound … It becomes a defect the moment crash-recover is automated; recorded here rather than pre-empted."* Scope 6 crosses exactly that line, and adds the migration ADR-175's own amendment says its direction did **not** have. |

### Reserved numbers (allocate now — skill-context rule)

- **ADR-176 — scoped to Scope 6 ONLY** (see D14). Next free at `git show master:docs/decisions.md` → max is ADR-175. Per `docs/CLAUDE.md` R4 the log is **hub + record**, so this is three artifacts, not one: the full record at `docs/decisions/adr-176.md`, a stub in `docs/decisions.md` (heading + Status + Date + link), and an index-table row. `pnpm validate:docs` enforces the stub ↔ record bijection **and** status equality. Write the header before citing it anywhere.
- **ADR-175 gains an `**Amendments:**` bullet + `Status: Accepted; amended by ADR-176`** — the repo's established pattern (`ADR-009 … amended by ADR-089/090`, `ADR-021 … amended by ADR-088`), and exactly what the convention's phrase *"a mechanism refined by a follow-on ADR"* describes. ADR-175's decision text is **immutable**; do not rewrite it.
- **Migration idx 171, tag `0171_crash_recover_continuation_retry`** — next free over `web/lib/db/migrations/meta/_journal.json` (last entry idx 170, `0170_prompt_dispatch_key`). The brain lineage (`brain-migrations`, last idx 5) is untouched.
- Migration is a **quadruple**: `.sql` + `_journal.json` entry + `meta/0171_snapshot.json` + `web/lib/db/schema.ts`. The phase ends with `pnpm --filter maister-web db:generate` reporting **"No schema changes"**.

### Deployment touchpoints (skill-context rule — explicit negative)

| Kind | This change adds |
|---|---|
| New env var | **none** (D7, D11) |
| New config file read at runtime | **none** |
| New sidecar process / binary | **none** — the three workers are in-process, same as the projection worker |
| New bound port | **none** |
| New DB migration | **yes — `0171`**; already covered by the documented `pnpm --filter maister-web db:migrate` step in `CLAUDE.md` → "How to run". No compose/`.env.example`/Dockerfile change. |

No `compose.yml`, `compose.override.yml`, `compose.production.yml`, `Dockerfile` or `.env.example` edits are required, and none should appear in the diff.

### Contract surfaces (skill-context rule)

| Surface | Spec file |
|---|---|
| New DB columns `runs.crash_recover_next_retry_at`, `runs.crash_recover_attempts` (+ index if EXPLAIN demands) | migration `0171` (quadruple above) + `docs/database-schema.md` + `docs/db/runs-domain.md` ERD + regenerated `docs/db/erd.dbml` (`pnpm --filter maister-web db:erd`, gated by `pnpm validate:docs`) |
| New ADR (Scope 6 only, D14) | `docs/decisions/adr-176.md` (record) + `docs/decisions.md` stub + index row — bijection and status equality enforced by `pnpm validate:docs` |
| Amended ADR | `docs/decisions/adr-175.md` → `**Amendments:**` bullet + `Status: Accepted; amended by ADR-176`, mirrored into the stub and index row |
| New HTTP route / SSE event / `MaisterError` code | **none** — reuses `CONFIG`. **Verified negative, not assumed:** `grep -rln worker docs/api/` → no hits; `find web/app/api -type d \( -name '*status*' -o -name '*health*' -o -name '*diagnostic*' \)` → only `runs/[runId]/graph-status`, unrelated. `durableWorkersHealth()` is a TypeScript export, not a wire surface; exposing it over HTTP is P0-7's call. Re-run both commands at verify exit. |
| New `package.json` script | **none** |
| New Flow DSL field / engine bump | **none** |
| New lane suites | `scripts/run-stage-ab-tests.mjs` → `laneSuites.isolation` (explicit registry; an unregistered suite silently never runs — the file's own comment: *"Explicit owning seams make a renamed or undiscovered suite fail the lane."*) |

---

## Scope 6 design (adopted — the part the request's framing did not cover)

### The routing decision comes FIRST (C6, D16)

The SQL predicate identifies a *candidate*; it does **not** authorise `driveResume`. Extract the routing into one pure helper shared with `reconcile.ts`:

```ts
// lib/runs/crash-recover-route.ts
export type CrashRecoverRoute = "recover" | "reattach" | "wait";

export function routeCrashRecover(input: {
  liveSession: boolean;
  resumeStartedAt: Date | null;
  latestAttemptStartedAt: Date | null;
  nowMs: number;
  graceSeconds: number;
}): CrashRecoverRoute;
```

- `liveSession: true` → **`reattach`** — re-enter with `runFlow(runId, {crashResume})`, exactly what `reconcile.ts:1906-1909` does. **NEVER `driveResume`**: its `closeCrashedNodeAttempts` would close a live `Running` attempt and the re-prompt would double-spend the turn still being produced.
- `liveSession: false` and past grace → **`recover`** → `driveResume`.
- `liveSession: false` and inside grace → **`wait`** — yield; a dispatch may be in flight.

`reconcile.ts` is refactored to call this helper for its `crashRecoverPending` branch so exactly one implementation of the decision exists (DRY). Its externally observable behaviour must be byte-identical — Task 26's `reconcile-sweep` suite is the guard.

**Liveness is a probe, not a column.** `reconcile.ts:1353` resolves it from one `hosts.local().listSessions()` per tick. The worker calls the same API **only** for a candidate that already passed the SQL filter and the grace guard — a state that exists only after a web death, so this is per-rare-candidate, never per-tick. A throwing probe **yields the candidate to the sweep** and dispatches nothing, mirroring `reconcile.ts:1420`.

### The predicate arm (cheap SQL filter)

Today (`continuation-worker.ts:78-189`) the WHERE is:

```
and( runKind=flow,
     or(A_status_active_assignment, B_waitingOnChildren_resumeRequested),
     cursor,
     or(noDriverToken, expiredLease),
     or(E1_gatePermissionResume, E2_ownedCommand, E3_openAttempt) )
```

The crash-recover state satisfies **none** of `E1|E2|E3` — the crashed attempt is bound to the **retired** assignment epoch, so `E3`'s `nodeAttempts.executionAssignmentId = executionAssignments.id` (active) never matches. That is the ADR-175 anchor-A26 reason. So the arm cannot be bolted onto the existing `or`; the tree must be restructured to:

```
and( runKind=flow,
     cursor,
     or(noDriverToken, expiredLease),
     or(
       and( or(A_status_active_assignment, B_waitingOnChildren_resumeRequested),
            or(E1, E2, E3) ),
       C_crashRecover,                                   // NEW
     ) )
```

with

```
C_crashRecover = and(
  eq(runs.status, "Running"),
  isNotNull(runs.resumeStartedAt),
  isNotNull(runs.currentStepId),
  eq(executionAssignments.state, "active"),
  lt(runs.crashRecoverAttempts, CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS),
  or(isNull(runs.crashRecoverNextRetryAt),
     lte(runs.crashRecoverNextRetryAt, sql`clock_timestamp()`)),
)
```

**Stated consequence of the existing `innerJoin(executionAssignments, ...)`:** a run whose `execution_assignment_id` is NULL (a pre-Stage-A legacy run) is dropped from every worker candidate set, including this one. `driveResume` would crash such a run anyway (`recover.ts:461-470`). The reconcile sweep backstop still reaches it. Written into `reconciliation-gc.md`, not left implicit.

### Dispatch

In the candidate branch, **before** the `WaitingOnChildren` `markResumedFromWait` branch:

```
if (candidate.status === "Running" && candidate.resumeStartedAt) {
  const route = routeCrashRecover({ liveSession: await probe(candidate), ... });
  if (route === "wait") continue;
  const outcome = route === "recover"
    ? await driveResume(candidate.id, { db, executionHosts })
    : await reattachCrashResume(candidate);          // runFlow(id, {crashResume})
  await recordCrashRecoverContinuationOutcome(db, candidate.id, route, outcome);
  continue;                                           // never fall through to runFlow
}
```

`driveResume` is called, never re-implemented — it owns the evidence → close → dispatch ordering (`recover.ts:323-590`), and `reconcile.ts:1855-1882` documents why a second implementation is the defect this removes. The candidate `select` gains `resumeStartedAt` and `currentStepId` so the branch discriminates without a second read.

### Single-winner — four racers, not three (C7)

| Racer pair | Serializer | Evidence |
|---|---|---|
| worker slot A vs slot B | `claimFlowDriver` inside `runner.ts:75` — the loser's `runFlow` no-ops | C3 |
| worker vs reconcile `recover` arm | same | C3 |
| **worker vs `scheduler.ts:642` queued-recover promotion** | same — the promotion's `resumeFn` also lands in `runFlow` | C7 |
| worker vs a live driver | existing top-level `or(isNull(flowDriverToken), lte(leaseExpiresAt, clock_timestamp()))` | `continuation-worker.ts:98-101` |
| pre-dispatch work under concurrency | `applyCrashedTurnEvidence` (`PromptOwnerHandoffLost` → `evidenceAlreadyApplied`) and `closeCrashedNodeAttempts` (guarded UPDATE) are idempotent | `crash-recover.ts:266-281`, `:317-338` — **verify by grep, not by the comment**: patch `2026-09-18-16.45` says an invariant asserted in a comment is a lead, not evidence |

### Backoff, budget, poison item (the mandatory addition — C2)

Migration `0171` adds to `runs`:

- `crash_recover_next_retry_at timestamptz` (nullable)
- `crash_recover_attempts integer NOT NULL DEFAULT 0` + CHECK `>= 0`

`recordCrashRecoverContinuationOutcome(db, runId, route, state)` (new, in `lib/runs/crash-recover.ts` beside `clearCrashRecoverMarker`):

| outcome | Write |
|---|---|
| `transient` | `attempts = attempts + 1`, `next_retry_at = clock_timestamp() + least(2^attempts, 60) seconds` — exponential, capped at 60 s, converging on the sweep's own honest cadence |
| `resumed` \| `redispatched` | clear both to `(NULL, 0)` |
| `unresumable` | clear both to `(NULL, 0)` — the run is terminal via `crashRunningRun`; clearing keeps the row clean for a future unrelated crash |
| `reattach` route | no budget write — that arm is the sweep's existing behaviour and carries no new bound |

- **Budget** `CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS = 5` (module constant, D11). At the cap the worker stops serving the run and logs `flow-continuation-crash-recover-budget-exhausted` **once**; the run falls back to the 60 s reconcile backstop, whose arm is unchanged. **Poison-item policy:** one bad run never stalls the worker — the ineligible row drops OUT of the candidate set rather than blocking the keyset head.
- **Intent-scoped budget at every WRITE site (D18):** zero `crash_recover_attempts` and `crash_recover_next_retry_at` in the same transaction that stamps `resume_started_at` — at `recover.ts:252`, `recover.ts:278` **and `scheduler.ts:911`**. Resetting at write rather than chasing the five release sites is what makes a fresh intent always start from zero.
- **Progress guarantee (skill-context §1):** the keyset cursor rotates (`cursor = candidate.id`; reset to `null` on an empty pass). `next_retry_at` removes ineligible rows from the candidate set rather than parking them at the head, so row N+1 is always reachable.
- **Lease arithmetic (skill-context §6):** the worker holds no lease of its own for this arm; `runFlow` takes and renews the 30 s driver lease (`driver-claim.ts:94`, `:113-128`). Nothing new to renew.


## ⚠ Traps (carry into every phase)

1. **Import cycles** (D1). A registry module under `execution-host/` fails mocked suites as SKIPS, not as errors — grep the lane output for `| N skipped` (memory: `module-scope-calls-break-mocked-suites`).
2. **Empty-registry `CONFIG`** (`prompt-owner-recovery.ts:41-45`). Compose first, start second. A boot step that starts the worker before the registry module loads fails **silently into the try/catch** and the worker never runs. The boot test MUST assert the `prompt-owner-worker-started` log line, not merely "boot did not throw".
3. **Stream-claim lease after a web death.** The dead process's runtime-event stream claim holds for `RUNTIME_EVENT_CLAIM_LEASE_MS` (30 s), so terminal evidence lands only after one to three lease cycles. Wait on the **applied state** with a budget **≥ 90 s**; never assert after a fixed short sleep; the worker's `*-degraded` retry logging in that window is expected, not failure.
4. **The flow candidate query is heavy** — an inner join plus three `EXISTS`, now four OR arms, at 1 s per slot. Capture `EXPLAIN (ANALYZE, BUFFERS)` on a populated DB **before and after** the Scope-6 restructure and attach both. If the new arm needs a partial index (candidate: `ON runs (id) WHERE run_kind='flow' AND status='Running' AND resume_started_at IS NOT NULL`), it goes into migration `0171`, not a follow-up.
5. **Shutdown budget — state the arithmetic.** `server.ts` drains within **25 s**; systemd `TimeoutStopSec=30`. All three `stop()` calls run concurrently inside one `Promise.allSettled`, so the budget is `max`, not `sum`. A prompt-owner slot mid-`applyClaimedPromptOwner` holds a **renewed 30 s** lease — strictly longer than the drain — so the overrun branch is reachable **by construction**, not by accident. D2's rule (an unconfirmed claim release must FAIL shutdown and leave the claim to expire) is **already wired**: `stop()` rethrows `shutdownFailure` (`prompt-owner-recovery.ts:106`), `allSettled` captures it, `drain` throws `AggregateError("web workers could not drain")` (`instrumentation-node.ts:221-225`). Assert that path (RED E); do not rebuild it and do not paper over it with a timeout.
6. **The e2e lane starts the workers** (C1). Phase 5.
7. **Mocked unit suites cannot prove any of this.** The proof is the production-boot integration lane.
8. **`pnpm lint` is `eslint --fix`** — it mutates the tree. Check `git status` before staging; baseline is 0 errors / 14 warnings (memory: `pnpm-lint-mutates-the-tree`).
9. **The boot reconcile sweep races every worker arm** (F5). `startDurableWorkers` lands in the isolated-step loop at `:91-128`; `runReconcileSweep()` runs unconditionally at `:159` — **after**. Both then scan the same crash-recover state on every boot. Not a correctness bug (D16's routing + `claimFlowDriver` decide one winner) but it makes any *timing-based* "the worker did it" assertion false. Tests discriminate **by log line**, never by "the sweep has not ticked yet".
10. **A comment is a lead, not evidence** (patch `2026-09-18-16.45`). Every invariant this plan cites from a code comment — C3's idempotency claims above all — is re-verified by grep and call-site count before it is relied on.

## Commit Plan

| Commit | After tasks | Message (no co-author trailer — D13) |
|---|---|---|
| 1 | 1–4 | `docs(execution): durable worker boot contract + automated crash-recover decision (ADR-176)` |
| 2 | 5–8 | `test(workers): RED controls for durable worker activation` |
| 3 | 9–12 | `feat(workers): compose the production owner registry and health surface` |
| 4 | 13–15 | `feat(boot): start and quiesce the three durable workers` |
| 5 | 16–21 | `feat(runs): flow continuation worker adopts the crash-recover arm (ADR-176)` |
| 6 | 22–24 | `test(e2e): reconcile the Playwright lane with live durable workers` |
| 7 | 25–29 | `docs(execution): truth pass and S2.12/S5.2 plan amendments` |

## Tasks

### Phase 0 — SDD: freeze the spec before any code

Exit criteria: every artifact below is complete and internally consistent; `pnpm validate:docs` green; the ADR-176 record + stub + index row exist at HEAD and ADR-175 carries its amendment; migration idx 171 is claimed in ADR-176's text (the files themselves land in Phase 4, Task 16). **R5a discipline applies to every doc task in this phase: `execution-event-plane.md` and `execution-prompt-lifecycle.md` already sit at exactly 12 Expectations bullets (the cap) and `reconciliation-gc.md` at 19 (already over). MERGE or REPLACE bullets — never append.**

- [x] **Task 1 — ADR-176 (Scope 6 only) + the ADR-175 amendment.** Three artifacts per `docs/CLAUDE.md` R4, created from the template: the full record `docs/decisions/adr-176.md`, a stub in `docs/decisions.md` (heading + Status + Date + link), and the index-table row. Header first, so nothing cites a missing anchor.

  **ADR-176 title:** *Automated crash-recover re-entry — the flow continuation worker owns the committed intent under a bounded per-run budget.*

  **Decision text covers ONLY** (D14): moving ownership of the crash-recover-pending state from the ≤ 60 s reconcile sweep to the ~1 s continuation worker; **the liveness routing (D16) and why `driveResume` is wrong for a live session** (C6); the per-run bound ADR-175 declined to pre-empt (`crash_recover_next_retry_at` + `crash_recover_attempts`, `min(2^n, 60)s` backoff, budget 5, reset at every claim-marker WRITE site per D18); the poison-item policy; and the explicit statement that the reconcile `recover` arm is **unchanged** and remains the backstop. Include the **marker contract table** from Task 3. Cite the serializers rather than restating their rationale (R4).

  **Explicitly NOT in ADR-176** (D14): boot wiring, the composed registry, the health surface — those are contract, and land in `execution-prompt-lifecycle.md` (Task 2) / `execution-event-plane.md` (Task 4).

  **ADR-175 edit — additive only, decision text is immutable:** append a dated `**Amendments:**` bullet naming ADR-176 as the follow-on that supplies the per-run bound its Consequences section deferred (`adr-175.md:138-143`), and set `Status: Accepted; amended by ADR-176` in **both** the record body and the `decisions.md` stub + index row.

  Mark ADR-176 `Accepted` now; flip to `Implemented` only in Task 29.
  - Logging: n/a (docs).
  - Verify: `pnpm validate:docs:adr` green (stub ↔ record bijection **and** status equality); `ls docs/decisions/adr-176.md`; ADR-175's status string identical in all three places.

- [x] **Task 2 — `execution-prompt-lifecycle.md`: replace every "activation pending" sentence.** Lines **33, 95, 120-121, 346, 634, 705-706** (verified present verbatim). Under "Registered owner application engine", write the registry composition contract: the exact five kinds, uniqueness enforced by `createPromptOwnerRegistry` at boot, the `PROMPT_OWNER_SHAPES`-derived kind-set assertion (D5), the composition-root placement rule, and that `agent_turn` is served by `consensusDraftPromptOwners` — adding `agentPromptOwners` beside it being a `CONFIG` boot failure by design.
  - **R5a:** the file is at the 12-bullet cap. The new invariants REPLACE the bullets that currently encode "activation is pending"; net bullet count MUST stay ≤ 12. Every bullet NAMES its enforcement point (the `CONFIG` throw, the `globalThis` singleton, the quiesce `allSettled`, the named test).
  - Verify: `grep -rn 'pending S2.12\|activation remains\|globally dormant' docs/system-analytics/` returns nothing for this file; the Expectations bullet count is still ≤ 12.

- [x] **Task 3 — Marker contract: enumerate write, release and read sites (C7, D18).** A table in `execution-prompt-lifecycle.md` (topical section, after Process flows, before Expectations per R5) and mirrored into ADR-176. Rows: for `resume_started_at` — **2 write** sites (`recover.ts:252`, `:278`) **+ `scheduler.ts:911`**, **5 release** sites (`runner-graph.ts:2410`, `crash-recover.ts:358`, `recover.ts:645`, `state-transitions.ts:1376`, `:1473`), and every **read/predicate** consumer (`reconcile.ts` classifier + loaders, `scheduler.ts:555`, `queries/inbox-context.ts:666` read model, and the NEW worker arm). Same three columns for the two new budget columns. State the D18 rule — reset at WRITE, never chase releases — and why (patch `2026-09-18-16.45` #1).
  - Verify: each listed site re-confirmed by `grep -n`; the count in the doc equals the count grep returns. This table is an input to Tasks 18–20, not decoration.

- [x] **Task 4 — `execution-event-plane.md` "Durable workers" + Scope-6 settlement in `reconciliation-gc.md` / `runs.md`.** Event plane: a subsection next to `## Durable bounded projection and reconciliation workers` (line 248) covering start order, the `Symbol.for` singleton (D17), the `isApplicationStopping()` guard, quiesce order before `drain`, the health surface (D2/D3), **the boot-sweep overlap (trap 9)**, and that the sweep is a ≤ 60 s backstop while the workers give ~1 s idle latency. Reconciliation: record Scope 6 **ADOPTED**, the anchor-A26 reason discharged, and the **normative recovery-window table** (each `status × liveness × mode` cell names its arm) covering worker-served recover, worker-yielded reattach, worker `wait`, probe-failure yield, budget exhausted, NULL `execution_assignment_id`, non-`active` assignment, and the unchanged `crash` arm. `runs.md`: the sweep is now a backstop for yielded flows, not the only re-entry.
  - **R5a:** event plane is at the cap — merge, do not append. `reconciliation-gc.md` is already at 19 bullets (a pre-existing R5a violation): **do not make it worse**; fold the new invariant into an existing bullet and note the over-cap condition as a follow-up rather than silently adding a 20th.
  - Verify: `pnpm validate:docs` green; bullet counts recorded before and after; every reachable partial state has a named owner in the table.

### Phase 1 — RED controls (TDD: these must fail on this HEAD, for the stated reason)

All controls run the **production** web (`startRealWeb` → `buildProductionWeb` + `server.ts` + production instrumentation) against `real-supervisor.ts` and real Postgres (`pg-container.ts`). New suites live under `web/test-support/__tests__/` beside `execution-ab-isolation.integration.test.ts` and MUST be registered in `scripts/run-stage-ab-tests.mjs` → `laneSuites.isolation` (SERIAL slice, runs alone, owns the host — correct for `next build` + two process trees).

**Discrimination rule (trap 9, replaces "before any sweep tick"):** the boot reconcile sweep runs on every start, so a timing argument proves nothing. Every control proves authorship by **evidence written only by the worker** — `execution_commands.application_claim_owner LIKE 'prompt-owner-worker:%'` for owner cases, and the `flow-continuation-crash-recover-reentry` log line carrying the worker's `workerId` (vs reconcile's `reconcile: crash-recover re-entry`) for Scope-6 cases. Where a control needs a quiet window, it creates the state **after** boot completes, so the next scheduled sweep is ~60 s out.

- [x] **Task 5 — Register the lane suites + RED A/B/C as ONE parameterized control.** `scripts/run-stage-ab-tests.mjs`; new `web/test-support/__tests__/durable-workers-boot.integration.test.ts`. A/B/C share one skeleton — accept the prompt, SIGKILL the web after the host emits terminal evidence but before application, restart, assert applied-by-worker — so express them as a **single `describe.each` over a domain table** (`{domain, seed, ownerKind, expectedTerminal}`) rather than three copy-pasted bodies (user requirement: minimum overlap, no trivial duplication). Rows:
  - `flow` — `ai_coding` prompt → `application_state='applied'`, worker claim owner, run at the next node / `Review`, **exactly one** `session.prompt` for that attempt.
  - `agent` — `run_kind='agent'` accepted turn → run finalizes through its own owner, **one** turn, **one** create, **one** prompt (the S2.8 two-worker convergence case at production boot).
  - `scratch` — dialog `Running`, terminal evidence after the kill → `WaitingForUser` applied by the `scratch_message` owner with **no** user action.
  Budget ≥ 90 s per row (trap 3).
  - Named failing assertions on this HEAD: `expect(command.applicationState).toBe('applied')` receives `'pending'` for all three rows; the run stays `Running` / the dialog never reaches `WaitingForUser`.
  - Logging: assert `prompt-owner-worker-started` in `RealWeb.logTail()` (trap 2).

- [x] **Task 6 — Registry and lifecycle edge cases (production boot).** Same suite, cases that the happy path cannot reach: (a) **kind-set mismatch** — a registry missing one schema kind fails boot with `CONFIG` and the `prompt-owner-worker-started` line is ABSENT (this subsumes the near-trivial "the key set is exactly five" assertion — do not write that one separately); (b) **duplicate kind** — composing with `agentPromptOwners` beside `consensusDraftPromptOwners` throws `CONFIG` (D4, the by-design failure); (c) **start while stopping** — `isApplicationStopping()` true → start refuses and nothing is registered; (d) **stop with nothing started** → `stopDurableWorkers()` resolves without throwing; (e) **double start** → the same three handles (`globalThis` singleton, D17).
  - Named failing assertions on this HEAD: (a)–(e) all reference `lib/workers/*`, which does not exist — the suite fails at import.

- [x] **Task 7 — RED D (concurrency), four racers.** New `web/test-support/__tests__/durable-workers-concurrency.integration.test.ts`. (i) live waiter + worker on one command → **one** application, `completion_applied_at` set once; (ii) **two** production web instances (two `startRealWeb`, distinct ports, one DB) → one application (the `bounded-output.integration.test.ts:834-835` pattern through production boot); (iii) reconcile reattach + flow worker on one yielded run → **one** driver, the loser logs `flow-driver-already-owned`; (iv) **`scheduler.ts:642` queued-recover promotion + worker on one run → one driver** (C7 — the racer the first draft missed).
  - Named failing assertion on this HEAD: no worker runs, so (i)/(ii) never reach an application — assert the applied count is exactly 1 and watch it fail at 0.
  - Race-guard falsification is mandatory here (Task 25): measure each guard's failure rate against unfixed code until misses are negligible (memory: `race-guards-need-the-window-open`).

- [x] **Task 8 — RED E (shutdown), with the arithmetic asserted.** Same concurrency suite. SIGTERM the web while a worker holds a claim → **either** the claim is released within the 25 s drain **or** shutdown reports `AggregateError: web workers could not drain` and the claim expires by its 30 s lease; after restart, **exactly one** application. Assert a claim was observably held first, so the disjunction is not vacuous. Record which branch fired — per trap 5 the overrun branch is reachable by construction (30 s lease > 25 s drain), so a run that never sees it is under-exercised, not passing.
  - Named failing assertion on this HEAD: no claim is ever held; the "a claim was held" precondition fails.

### Phase 2 — Composed registry + health surface

- [x] **Task 9 — `web/lib/workers/health.ts`.** No domain imports. Declare the three slot keys as `Symbol.for("maister.durable-workers.{promptOwner,flowContinuation,agentContinuation}.v1")` (D17), typed to the workers' structural `{stop, health}` shape declared **locally** (not imported — importing the type would drag the domain module in). Export `durableWorkersHealth()` returning each worker's `health()` or `{state:'stopped', reason:null}` for an empty slot.
  - Logging: none (pure read).
  - Verify: a unit test asserts the module's resolved import graph contains nothing under `lib/flows`, `lib/agents`, `lib/scratch-runs`, `lib/runs`, `lib/services`, `lib/execution-host`.

- [x] **Task 10 — `web/lib/workers/runtime.ts` composition root.** Import the five registries (`flowPromptOwners`, `consensusDraftPromptOwners`, `scratchPromptOwners`, `syncPromptOwners`, `gateChatPromptOwners`), compose via `createPromptOwnerRegistry([...])` (D4), and assert the kind set against `new Set(PROMPT_OWNER_SHAPES.map(s => s.kind))` mirroring `projection-runtime.ts:38-52`, throwing `CONFIG` on disagreement (D5). Export `startDurableWorkers()` / `stopDurableWorkers()` guarded by `isApplicationStopping()` and the D17 slots (`??=` on start; clear-if-still-ours on stop, as `stopCanonicalProjectionWorker` does).
  - Logging: the prompt-owner worker already logs start/stop with `ownerKinds` + `concurrency` (C5) — do **not** duplicate it here.
  - Verify: Task 6 turns green. No separate "key set is five" test (folded into 6a).

- [x] **Task 11 — Start/stop observability parity for the two silent workers (C5).** `lib/flows/graph/continuation-worker.ts`, `lib/agents/continuation-worker.ts`. Add `workerId = \`flow-continuation-worker:${randomUUID()}\`` / `agent-continuation-worker:…`, an INFO `*-started` line with `{workerId, concurrency}` (flow: `slots.length`; agent: `1` — single loop), an INFO `*-stopped` inside `stop()` after `stopped = true`, and `workerId` on the existing `*-degraded` ERROR lines so a degraded slot is attributable.
  - Logging: INFO start/stop; ERROR unchanged but attributable. `LOG_LEVEL`-driven via the existing pino instances.
  - Verify: the C4 suite set still passes; a unit test asserts both lines.

- [x] **Task 12 — Wire `durableWorkersHealth()` into the `system_sweep` summary (D3).** `lib/scheduler/system-sweeps.ts`, one structured INFO per tick in the existing per-sweep try/catch shape (`:295-435`), importing **only** `lib/workers/health.ts`.
  - Logging: `log.info({ workers: durableWorkersHealth() }, 'system_sweep durable worker health')`; a throw is caught and logged like its siblings, never fatal to the tick.
  - Verify: the scheduler tick suite passes; a unit test asserts the line appears and that a degraded worker surfaces its `reason`.

### Phase 3 — Boot and quiesce wiring

- [x] **Task 13 — Add the boot step.** `web/instrumentation-node.ts`. Extend the isolated-step loop (`:91-128`) with `"startDurableWorkers"` immediately after `"startCanonicalProjectionWorker"`, via `await import("@/lib/workers/runtime")` so a failure is logged and non-fatal to boot (D1, D6). Add a short comment recording the boot-sweep overlap (trap 9) and why it is safe (D16 routing + `claimFlowDriver`).
  - Logging: the existing `[instrumentation] execution-host boot step ${step} failed (continuing boot):` covers failures — no second handler.
  - Verify: `lib/__tests__/instrumentation.test.ts` (pins the Edge/Node split) still passes; Task 5's `prompt-owner-worker-started` assertion turns green.

- [x] **Task 14 — Add the quiesce step.** `web/instrumentation-node.ts:205-213`. Hoist `stopDurableWorkers` beside the four existing stop imports and add it to `Promise.allSettled([...])`, before `drain` closes the DB.
  - Verify: Task 8's disjunction has a live claim to observe; the `AggregateError` path is reachable (trap 5).

- [x] **Task 15 — Phase green checkpoint.** Tasks 5, 6, 7(i)(ii), 8 pass. Run `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration`, plus `node scripts/run-stage-ab-tests.mjs web` and `… isolation`.
  - Verify: failure **SET** (not count) compared against master on a quiet machine; `pmset -g log` checked before attributing any timeout; lane output grepped for `| N skipped`. Master's two known host-specific serial failures (`project-pull` / `projects-remotes`, 409 vs 503) are the accepted baseline.

### Phase 4 — Scope 6: crash-recover continuation arm

- [x] **Task 16 — Migration `0171_crash_recover_continuation_retry` + schema.** `web/lib/db/schema.ts` (`runs`, near `resumeStartedAt` at `:1885`), then `pnpm --filter maister-web db:generate`. Adds `crash_recover_next_retry_at timestamptz` and `crash_recover_attempts integer NOT NULL DEFAULT 0` with a `>= 0` CHECK. **Live-data rule:** both additive with safe defaults — no backfill, no abort-guard; state that premise in the migration header. Include the partial index only if Task 21's EXPLAIN demands it.
  - Verify: quadruple complete — `.sql` + `_journal.json` idx 171 + `meta/0171_snapshot.json` + `schema.ts`; a second `db:generate` reports **"No schema changes"**; `docs/db/runs-domain.md` ERD + `docs/database-schema.md` updated and `pnpm --filter maister-web db:erd --check` green.

- [x] **Task 17 — Extract the shared recover-vs-reattach routing (D16, C6).** New pure module `web/lib/runs/crash-recover-route.ts` exporting `routeCrashRecover(input): "recover" | "reattach" | "wait"` exactly as specified in "Scope 6 design". **Refactor `reconcile.ts` to call it** for its `crashRecoverPending` branch so one implementation exists (DRY). Externally observable reconcile behaviour must be byte-identical.
  - Logging: none (pure function); callers log their chosen route.
  - Verify: unit tests for all three outcomes across the liveness × grace matrix; `reconcile-sweep` integration green **unchanged**, including the ADR-175 `crashRecoverReentered` / `runningIdleSession` counters (Task 26 re-checks). Falsify by inverting the `liveSession` branch and confirming the reconcile suite goes red.

- [x] **Task 18 — Budget reset at every claim-marker WRITE site (D18, C7).** Using Task 3's table: zero `crash_recover_attempts` and `crash_recover_next_retry_at` in the **same transaction** that stamps `resume_started_at`, at `recover.ts:252`, `recover.ts:278` **and `scheduler.ts:911`**. Do not add clears at the five release sites.
  - Logging: DEBUG `{runId, site}` on reset.
  - Verify: a test per write site asserts a fresh intent starts at `attempts = 0` even when the previous intent exhausted the budget; a test asserts a `state-transitions.ts` repark does **not** need a clear (the next write resets it).

- [x] **Task 19 — `recordCrashRecoverContinuationOutcome`.** `web/lib/runs/crash-recover.ts`, beside `clearCrashRecoverMarker:352`. Implements the outcome table in "Scope 6 design" (including the `reattach`-route no-write row) and the `CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS = 5` module constant.
  - Logging: DEBUG on the write (`{runId, route, state, attempts, nextRetryAt}`); INFO `flow-continuation-crash-recover-budget-exhausted` **once** at the cap.
  - Verify: unit tests per outcome, plus the two boundary cases — `attempts = MAX-1` is still served and `attempts = MAX` is not; `next_retry_at` exactly equal to `clock_timestamp()` **is** served (`lte`, not `lt`).

- [x] **Task 20 — The predicate arm + routed dispatch.** `web/lib/flows/graph/continuation-worker.ts`. Restructure the WHERE per "Scope 6 design", add `resumeStartedAt` + `currentStepId` to the candidate `select`, and add the routed branch **before** the `WaitingOnChildren` branch, with `continue` so it never falls through to `runFlow`. Probe liveness via `hosts.local().listSessions()` only for a candidate past grace; a throwing probe yields (D16). Do **not** call `claimFlowDriver` (D8). Do **not** widen `node_type` to `consensus` (D12).
  - Logging: INFO `flow-continuation-crash-recover-reentry` with `{workerId, runId, targetStepId, route}` before the call and the resulting `state` after; WARN `{workerId, runId}` on a yielded probe failure.
  - Verify: Task 21.

- [x] **Task 21 — RED F + EXPLAIN evidence.** Cases in `durable-workers-boot.integration.test.ts`, each discriminating **by log line** (trap 9): (a) no live session past grace → the **worker** re-enters within ~1 s, log line carries the worker's `workerId`, run reaches the next node; (b) **live session, dead driver** → the worker takes the `reattach` route and **`closeCrashedNodeAttempts` never fires** — assert the live attempt is still `Running` and exactly one prompt exists (**this is the C6 regression guard; it is the single most important assertion in the plan**); (c) inside grace → `wait`, no dispatch; (d) probe failure (`listSessions` forced to throw) → yield, no dispatch, WARN logged, sweep still recovers it; (e) `transient` outcome → attempts incremented, `next_retry_at` set, and **measurably** not re-attempted before that timestamp; (f) at the cap the worker stops serving and the sweep backstop recovers it; (g) fresh operator Recover after exhaustion resets the budget (D18) and the worker serves it again; (h) NULL `execution_assignment_id` → worker skips, sweep serves; (i) non-`active` assignment → skipped. Capture `EXPLAIN (ANALYZE, BUFFERS)` for the candidate query on a populated DB **before and after** the restructure; attach both.
  - Named failing assertions before Tasks 17–20: (a) only the ≤ 60 s sweep recovers it, so the ~1 s + `workerId` assertion fails; (b) on a naive `driveResume` arm the live attempt is found `Reworked`/`crash_recover` with **two** prompts — the double-spend; (e)–(g) the columns do not exist.
  - Verify: if EXPLAIN shows a regression or a sequential scan on the new arm, add the partial index to migration `0171` (Task 16) — **not** a follow-up.

### Phase 5 — E2E lane reconciliation (C1)

- [x] **Task 22 — Measure.** Run the full Playwright suite with the workers live on a quiet machine. Record the failure **SET**; run the same suite on master and diff the sets. Attribute each delta to a named cause: a parked seed fixture re-driven at 1 Hz, the `test-supervisor.ts` synchronous-delegation interaction (a known ROADMAP backlog flake), or something new.
  - Verify: the diff is a set, not a count; every delta has a named cause before any fix.

- [x] **Task 23 — Fix, in this same commit (D15).** For each attributed delta fix the **seed or the spec** — these land in commit 6 alongside Task 22 however large the delta. Do **not** add an env gate to suppress the workers (D6). A genuine **production** defect gets its **own** commit inside this phase (D15 carve-out). A pre-existing `recursive-harness.spec.ts` flake: cite the ROADMAP backlog item and leave it.
  - Verify: full Playwright suite green, or every remaining failure matched to a pre-existing master failure **by name**.

- [x] **Task 24 — Phase green checkpoint.** Full `test:unit && test:integration`, both AB lane slices, Playwright, `pnpm --filter maister-web lint` (check `git status` first — trap 8), strict `tsc`.

### Phase 6 — Falsification, plan amendments, docs truth pass

- [x] **Task 25 — Falsification (name the failing assertion in each case).** (a) Remove the three boot steps, keep the registry → Task 5's three rows go red with `application_state='pending'`. (b) Remove only the registry composition → boot logs the `CONFIG` failure into the isolated-step try/catch and Task 5 goes red on the missing `prompt-owner-worker-started` line. (c) Revert Task 20's routed branch → Task 21(a) fails its `workerId` assertion while the sweep-backstop case still passes. (d) **Invert D16's liveness branch (route `reattach` to `driveResume`) → Task 21(b) must go red with the live attempt `Reworked` and two prompts.** Restore → green. Every guard must fail in **isolation** — exactly one assertion, with the test still reaching that line (the standard patch `2026-09-18-16.45` set). For race guards (Task 7) measure the failure rate against unfixed code until misses are negligible.
  - Verify: each falsification recorded with the exact assertion text and the observed failure.

- [x] **Task 26 — Existing suites green without loosened expectations.** All of C4's list, plus `reconcile-sweep` integration (ADR-175 counters — **Task 17 refactored its call path, so this is the byte-identical-behaviour guard**), `prompt-owners` lanes (flow + agent + scratch + consensus), `driver-claim.integration.test.ts`, `execution-ab-isolation.integration.test.ts`. For any changed expectation, state explicitly whether it was **obsolete** or **broken** — never silently relax one.
  - Verify: run the integration lane idle, not under load — a full-lane failure at load 300+ is manufactured; re-run one file idle and compare name sets before classifying (memory: `integration-lane-load-sensitivity`); wait for the late summary flush.

- [x] **Task 27 — Re-derive the doc-surface list FROM THE DIFF (patch `2026-09-18-16.45` root cause #3).** The contract-surfaces table in this plan is a checklist written before the code and is "only as complete as the pass that wrote it". At this point run, over the actual diff: `grep -rn 'startDurableWorkers\|durableWorkersHealth\|routeCrashRecover\|crash_recover_attempts\|crash_recover_next_retry_at\|CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS' docs/ site-docs/` plus the two API-negative commands from "Contract surfaces". Every hit outside the files this plan already names is an unlisted surface — fix it or record why it is correct as-is.
  - Verify: the re-derived surface set is a superset of the plan's table, and the difference is empty or explained.

- [x] **Task 28 — Amend `stage-ab-stabilization.md`.** S2.12 addendum: "boot wiring landed in `<commit>`", naming the actual commit. S5.2 gains Tasks 5–8 and 21 as named scenarios. The two final-matrix rows — *"Real web restart and simultaneous worker claims — no process-local continuation dependency"* and *"Real supervisor restart — accepted lost turn explicit, owner state recovers"* — cite this change as their evidence. Update `:123-125` ("remains globally dormant until S2.12").
  - Verify: `grep -n 'globally dormant' .ai-factory/plans/stage-ab-stabilization.md` returns nothing.

- [x] **Task 29 — Docs truth pass + architecture table.** `docs/architecture.md` web component table lists the three workers and the composed registry. Re-verify every Phase-0 artifact **against the shipped code**, not against what the commits claimed — component responsibilities, who owns which write, the prompt-owner protocol, the Task 3 marker table (re-grep each site), and every `Designed`→`Implemented` label. Flip ADR-176 to `Implemented` in the record body **and** the stub + index row (status equality is gated).
  - Verify: `pnpm validate:docs:all` green (Mermaid, ADR anchors, relative links, indexes, DBML). Record the counts. Re-confirm all three Expectations bullet counts against the R5a cap.


## Out of scope (do not drift into these)

- Widening any candidate predicate beyond Scope 6 — `consensus` in the flow worker is **B4**.
- Reconcile-by-evidence in the sweep (**P1-5**); scratch/agent Recover (**A4**).
- The lag/backlog metric surface itself (**P0-7**) — this item only exports the health aggregate.
- HITL UI; outbox pressure.
- Changing slot counts, lease lengths, or projection limits.
- Making the agent worker's `stop()` rethrow `shutdownFailure` like its two siblings (C5) — a real asymmetry, recorded, not fixed here.

**Explicitly IN scope despite looking otherwise:** Task 17 refactors `reconcile.ts` to call the shared `routeCrashRecover` helper. This does **not** violate the locked micro-decision *"Reconcile keeps its ADR-175 `recover` arm"* — the arm, its counters and its externally observable behaviour are unchanged; only the decision's implementation moves to one shared place (D16). Task 26's `reconcile-sweep` suite is the byte-identical-behaviour guard, and Task 25(d) falsifies it.

## Follow-up (separate items)

- **P0-7** reads `durableWorkersHealth()` together with stream lag and poisoned consumers — it imports `lib/workers/health.ts`, never `runtime.ts` (D2).
- Memory note *"Recovery has three doors…"* gains its second door (Recover, ADR-175) and third (durable workers) once this lands.
- Agent-worker `stop()` rethrow symmetry (C5).

---

## Resolved (owner, 2026-09-21)

- **Бюджет Scope 6 = 5 попыток, backoff `min(2^n, 60)s`** — принято.
- **Колонки на `runs`** (не отдельная таблица) — принято.
- **ADR-176 отдельным номером — да, но только под Scope 6** (D14). Boot-обвязка ADR не получает: это исполнение уже принятого D2 за воротами S2.12, её контракт идёт в `execution-prompt-lifecycle.md`. Основание для отдельного номера: `adr-175.md:138-143` сам называет границу автоматизации и сознательно от неё отказывается («becomes a defect the moment crash-recover is automated; recorded here rather than pre-empted»). ADR-175 получает `Amendments:` + `amended by ADR-176`.

- **Roadmap linkage не нужен** — `Milestone: "none"` окончательно.
- **Сиды Playwright чинить в том же коммите** (D15), независимо от размера дельты; исключение — настоящий продовый дефект, он идёт отдельным коммитом внутри той же фазы.

## Unresolved questions

Нет — все открытые вопросы закрыты владельцем (2026-09-20/21). План готов к `/aif-implement`.
