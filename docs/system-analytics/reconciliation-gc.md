# Reconciliation and GC domain

## Purpose

This domain (**Designed**) covers two recovery-and-cleanup concerns
that sit below the live run machine. **Crash reconciliation** detects a
stranded `Running` run — a runner loop gone after a Next.js or supervisor
restart, or a session-less node left dangling — and classifies it into
re-attach, re-dispatch, skip, or `Crashed`. **Graceful workspace and
revision GC** reclaims disk for terminal runs and unreferenced flow
revisions on a graceful, preserve-then-prune schedule. The boundary: the
live mid-stream crash path (`Running → Crashed` inside an active session
via `session.crashed`/`session.exited`) is owned by the runner and is NOT
re-implemented here; reconciliation is the out-of-band recovery sweep, and
GC is the deferred removal that never destroys un-committed work.

**Stage B transition (Designed):** event replay, prompt terminal recovery,
runtime-object state, and legacy import resume from durable records defined by
[execution-event-plane.md](execution-event-plane.md),
[execution-prompt-lifecycle.md](execution-prompt-lifecycle.md), and
[execution-data-cutover.md](execution-data-cutover.md). Filesystem scans below
remain restricted to manager-owned worktree/repository GC or frozen legacy-mode
imports; they are not canonical execution-runtime state transitions.

## ADR-148 workspace cleanup contract (Implemented)

The behavior below is the shipped baseline. ADR-148 changes only the
workspace cleanup boundary: automatic row-backed GC selects the disposable
set `{Done, Abandoned}` and never selects `Review`, `Crashed`, or `Failed`.
All row-backed removal paths use a renewable lifecycle claim that fences every
irreversible Git/filesystem step and the final transaction. A persisted result
records `removal_kind` independently from `preservation_outcome`; a path absent
after process death therefore converges from durable intent instead of guessing.

Disk-only candidates first become durable `workspace_reconciliation_findings`.
Autonomous action requires a root realpath/no-symlink check, verified parent
Git registration, current provenance v2, no matching workspace/live session,
the configured grace, a lease-fenced final recheck, and a CAS-created rescue
ref. V1, malformed, ambiguous, or foreign candidates are held/quarantined and
reported, never removed. Findings retain bounded retry/backoff, sanitized error
codes, rescue evidence, and resolved history.

Each sweep observes the filesystem and missing owned paths first, then claims at
most 100 due findings from the durable ledger ordered by retry time. A held or
quarantined early path therefore cannot starve later work. Before orphan removal,
the rescue ref/commit pair is persisted under the finding claim; a process death
after deletion resolves that retained finding on the next due sweep without
relying on a vanished path. A row whose owned path is already absent is marked
removed only when it has a durable preservation result; otherwise it is
quarantined for operator review.

One claimed `system_sweep` composes reconcile, row-backed GC, orphan
reconciliation, and reconstructible-agent cleanup. Timer, tick, and
`/api/cron/gc` request that same job; a losing contender reports
`alreadyRunning`. The claimed scheduler attempt renews and fences its lease for
the complete bundle. A service-level bundle failure marks that attempt failed;
candidate-level failures remain in its summary and use their individual durable
retry or quarantine state. Runtime JSONL, transcripts, evidence, and run rows
are not GC targets.

## One-time cut-over versus recurring repair (ADR-131 — Implemented)

Migration 0094 is the only owner of unfinished-linear-run terminalization. It
runs while web and supervisor are stopped and is not a recurring reconcile
rule. Ordered follow-on migration 0095 clears only C2 task claims that predate
the durable D2 event; it does not change a run or emit an event. Reconcile never
recovers or redispatches these explained Failed rows. Workspaces are retained
and enter normal terminal preserve/prune GC after restart.

> **Unified runner & session model (Implemented).** Reconcile / resume /
> recover read the per-session `run_sessions` snapshot (incl. `acp_session_id`)
> instead of `runs.acp_session_id`; classification is session- and
> `run_kind`-aware and must cover partial `run_sessions` insert,
> spawned-but-unpersisted `acp_session_id`, and mid-run session switch. Canonical:
> [`sessions.md`](sessions.md) /
> [ADR-114](../decisions.md#adr-114-unified-flow-runner-config-first-class-sessions-per-project-connect-time-bindings-and-run_sessions-as-the-sole-run-runner-source-of-truth).
> Flipped to as-built in Phase 7 of that work.

Live Flow sessions reattach through `runFlow`: its durable lease yields to an
active driver, or recovers the existing immutable prompt after owner loss.
Session liveness does not authorize a permission-continuation prompt. The
resume driver also yields on durable prompt ownership or admission conflicts,
without changing the original attempt, HITL intent, or deleting its session.

## Domain entities

- **Run** — `runs` row. Reconciliation only acts on `runs.status='Running'`
  (allow-list). It can transition a run to `Crashed`; GC reads terminal
  runs (`Abandoned`/`Done`). See [`runs.md`](runs.md).
- **Resume-in-flight marker** — `runs.resume_started_at` (timestamptz, null
  by default; **Designed**, migration 0015). Stamped by Recover before
  the supervisor side-effect; anchors the reconcile grace window. Cleared on
  first progress, on terminal write, or by the runner's single-winner CAS-clear
  (`UPDATE runs SET resume_started_at = NULL WHERE id = ? AND resume_started_at
  IS NOT NULL`).
- **Recover target node** — `runs.resume_target_step_id` (text, null by
  default; **Implemented**, migration 0016). The node id retained at crash
  time: `crashRunningRun` copies `current_step_id → resume_target_step_id` and
  nulls `current_step_id` (clean-terminal read preserved). Recover resolves the
  node kind + `retry_safe` from this column (falling back to `current_step_id`
  for live/hand-seeded rows). See [`runs.md`](runs.md).
- **`retry_safe` opt-in** — a per-node boolean on graph nodes (`flow.yaml`
  `nodes[]`), default `false`. A crashed
  session-less node is redispatch-recoverable only when its config declares
  `retry_safe: true` (agent nodes `ai_coding`/`judge`/`orchestrator` ignore it —
  recovered via `session/resume`). A `consensus` node follows the session-less
  rule, except that a quarantined attempt is always discard-only and an applied
  incomplete-synthesis witness redispatches even with `retry_safe: false`. See
  [`../flow-dsl.md`](../flow-dsl.md) and [`runs.md`](runs.md).
- **Workspace** — `workspaces` row / git worktree. GC entities added by
  migration 0015 (**Designed**):
  - `scheduled_removal_at` (timestamptz, null) — GC deadline (cleared on
    reopen, ADR-141), stamped at the `Abandoned`/`Done` transition.
  - `archived_branch` (text, null) — name of the preserved archive ref
    (`maister/archive/<runId>`).
  - `archived_at` (timestamptz, null) — when preservation completed.
  - `removed_at` (timestamptz, null; pre-existing) — when the worktree was
    pruned. Rows are NEVER hard-deleted.
- **Flow revision** — `flow_revisions` row. GC deletes rows whose
  `package_status='Removed'` once unreferenced and past age. See
  [`flow-packages.md`](flow-packages.md).
- **Live session set** — supervisor `listSessions()` records keyed by
  `acp_session_id` with `status: 'live' | 'exited' | 'crashed'`. The
  reconcile classifier (`reconcile.ts`) matches this against each run's ACTIVE
  `run_sessions` `acp_session_id`, resolved via `loadActiveRunSessionsByRunId`
  (no longer a `runs.acp_session_id` column join).
- **Worktree set** — `listWorktrees(projectRepoPath)` paths, joined against
  `workspaces.worktree_path` (the "runs vs `git worktree list`" check).
- **Context mount** (**Implemented, ADR-157**) — an ephemeral detached read-only
  checkout of a *sibling* project's repo at
  `.maister/<consuming-slug>/runs/<runId>/context/<siblingSlug>/`. It carries
  **no** `workspaces` row and lives **outside** `worktreesRoot()`, so neither the
  row-backed workspace GC nor the disk-scanning workspace reconciler can see it —
  the GC backstop sweep below is its only automatic cleanup. Its launch snapshot
  is `runs.context_mounts`; its lifecycle is owned by
  [`workspaces.md`](workspaces.md).
- **Evaluation evidence snapshot** (**Implemented, ADR-148/144** —
  `evaluation_evidence_snapshots` rows; see
  [`../db/evaluations-domain.md`](../db/evaluations-domain.md)) — the
  Evaluation Lab arm of the shared GC bundle. `sweepEvaluationEvidence`
  (`web/lib/evaluations/evidence/gc.ts`) runs on every `system_sweep` tick AND
  through the `/api/cron/gc` compatibility wrapper: (1) a `preparing` snapshot
  older than 1h never completed its seal transaction (crash between blob write
  and DB seal) and is flipped to `pending_delete` (orphan recovery); (2) a
  `pending_delete` snapshot past a 24h grace window that is cited by **no**
  `evaluation_executions.evidence_snapshot_id` is finalized to `deleted`
  (two-stage, reference-guarded — the not-referenced predicate is a safety net
  over the RESTRICT FK, so a snapshot an execution still points at is never
  finalized). Idempotent and bounded; blob pruning under
  `MAISTER_EVALUATION_EVIDENCE_ROOT` is a separate generation-rotation
  concern — this sweep owns only the DB lifecycle rows.

## State machine

The run reconcile axis (allow-list `Running`-only) and the workspace GC
lifecycle (terminal → countdown → archived → pruned). Both are
**Designed**.

```mermaid
stateDiagram-v2
    state "Run reconcile (Running-only)" as ReconcileAxis {
        [*] --> Running: candidate row
        Running --> Reattached: live session present
        Running --> Redispatched: graph flow, no live session,<br/>current node check/judge<br/>(retry-safe gate)
        Running --> Skipped: agent node within<br/>MAISTER_RECONCILE_GRACE_SECONDS
        Running --> Crashed: worktree gone
        Running --> Crashed: agent session gone past grace
        Running --> Crashed: cli node, no live session<br/>(cli-not-retry-safe)
        Reattached --> [*]
        Redispatched --> [*]
        Skipped --> [*]: re-evaluated next tick
        Crashed --> [*]: UI offers Recover or Discard
    }

    state "Workspace GC lifecycle" as GcAxis {
        [*] --> Countdown: run terminal (Abandoned/Done)<br/>scheduled_removal_at stamped
        Countdown --> Countdown: now < effective deadline
        Countdown --> Archived: GC sweep preserve<br/>(archive_branch + archived_at set)
        Archived --> Pruned: removeOwnedWorktree<br/>(removed_at set)
        Countdown --> Pruned: nothing to preserve<br/>(clean + merged)
        Pruned --> [*]
        Pruned --> [*]: reopen (Done only, ADR-141)<br/>re-attach worktree, clear scheduled_removal_at/archived_at/removed_at
    }
```

`Crashed` is a real `runs.status` value; the GC lifecycle states are
**derived** from `scheduled_removal_at`, `archived_at`, and `removed_at` —
there is no `gc_state` enum column.

## Process flows

### Startup reconcile (Implemented)

Runs once on Node boot from `web/instrumentation-node.ts`, AFTER the two
existing recovery sweeps (`runResumeRecoverySweep`,
`runTakeoverReturnRecoverySweep`) and before the scheduler timer starts.

Before the `Running`-only crash classifier, this same startup call repairs
ADR-137 Plan-review graph handoffs. It examines only current-step,
current-artifact parent responses in `NeedsInput|NeedsInputIdle`; it either
rewrites a missing parent input and marks delivery, or reclaims a delivered
graph wake with the existing scheduler-cap policy. This is a distinct durable
handoff recovery path and does not broaden the crash classifier's `Running`
candidate set.

```mermaid
flowchart TD
    Start([Node boot]) --> Load[Per project: SELECT runs<br/>WHERE status=Running<br/>join workspace + pinned manifest]
    Load --> Excl[Exclude takeover-return candidates<br/>returned_diff + ended_at + stale gate]
    Excl --> Fetch[listWorktrees + listSessions once per project]
    Fetch --> Sup{listSessions ok?}
    Sup -- no --> SkipTick[skip whole tick<br/>transient supervisor unavailability]
    Sup -- yes --> Each[for each candidate: classifyRunReconcile]
    Each --> Act{action}
    Act -- crash --> Crash[crashRunningRun + promoteNextPending]
    Act -- redispatch --> Redis[runFlow re-dispatch CAS-guarded]
    Act -- reattach --> Reatt[runFlow durable lease and prompt recovery]
    Act -- reobserve --> Reobs[agent run: put an observer back on the live session]
    Act -- skip --> Noop[no action]
```

### Periodic reconcile sweep (Implemented)

The seeded `system_sweep.default` scheduler job runs the same classification on
the unified scheduler clock every 60 seconds. This is the sanctioned recovery
poll (heartbeat + reconcile), NOT a banned live-path transition poll — the live
path stays ACP-notification-driven. The retired
`MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS` and
`MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` values are ignored with a boot WARN;
there is no independent in-process reconcile or keepalive timer.

The cadence also retries the bounded Plan-review handoff repair described above.
It has no supervisor side effect: a ready graph wake calls `runFlow()` and an
at-cap idle run records `resume_requested_at` for normal scheduler admission.

```mermaid
flowchart TD
    Tick([interval tick]) --> Candidates[load Running candidates per project]
    Candidates --> Grace{agent node,<br/>no live session?}
    Grace -- within grace --> SkipG[SKIP<br/>resume_started_at OR latest<br/>node_attempts.started_at < grace]
    Grace -- past grace --> CrashG[CRASH agent-session-gone]
    Candidates --> Worktree{worktree present?}
    Worktree -- no --> CrashW[CRASH worktree-gone]
    Candidates --> Node{current node kind?}
    Node -- check/judge --> Redis[RE-DISPATCH]
    Node -- cli, no live session --> CrashC[CRASH cli-not-retry-safe]
    Candidates --> Sess{live session?}
    Sess -- yes, flow --> Reatt[RE-ATTACH]
    Sess -- yes, agent, no observer here --> Reobs[RE-OBSERVE]
    Sess -- yes, agent, observer here --> SkipO[SKIP agent-observer-live]
    Sess -- yes, scratch --> SkipS[SKIP live-scratch-session]
```

### Operator Recover — hybrid resume / re-dispatch (Implemented)

Operator-driven Recover (`POST /api/runs/{runId}/recover`, and its
token-authority twin `POST /api/v1/ext/runs/{runId}/recover` under scope
`runs:recover` — ADR-034 amendment) classifies the
`Crashed` run with `classifyRecover(run, nodeKind, retrySafe, consensusEvidence)` over the
**recover target node** — `runs.resume_target_step_id` (the node id retained at
crash time; `current_step_id` is nulled on crash), falling back to
`current_step_id` for live/hand-seeded rows:

| recover target node | `acpSessionId` | node `retry_safe` | plan | recoverable? |
| ------------------- | -------------- | ----------------- | ---- | ------------ |
| agent (`ai_coding`/`judge`/`orchestrator`) | present | ignored | `resume-agent` — graph re-entry at the target node, resuming THAT NODE's ACP session | yes (200 resumed / 202 queued) |
| agent (`ai_coding`/`judge`/`orchestrator`) | null | ignored | `discard-only` | no (409) |
| session-less (`cli`/`check`/`guard`/`human`/`form`) | irrelevant | `true` | `redispatch` — re-run the node | yes (200 redispatched / 202 queued) |
| session-less | irrelevant | `false` (default) | `discard-only` | no (409) |
| `consensus`, latest attempt has a quarantined consensus command (`application_error.reason = prompt_terminal_conflict`) | irrelevant | any | `discard-only` — never re-prompt from disagreeing evidence | no (409) |
| `consensus`, latest attempt carries the applied incomplete-synthesis witness | irrelevant | any | `redispatch` — fresh node attempt and synthesis ID | yes (200 redispatched / 202 queued) |
| `consensus`, neither | irrelevant | `true` / `false` | as session-less: `redispatch` / `discard-only` | yes / no |
| unresolvable target node | — | — | `discard-only` | no (409) |

**`judge` is an agent node here (Implemented — ADR-175).** It runs an ACP
session and `admitNodePrompt` already accepts it, so a crashed judge holding a
retained handle resumes rather than being discarded. Before ADR-175 it fell to
the session-less row, where `retry_safe: false` (the default) made it
`discard-only`; the reconcile sweep still classifies a session-less `judge` as
`gate-redispatch`, which is deliberate — the sweep acts without an operator
decision and may never resume a mid-turn agent implicitly.

**Both arms take the same door: the graph (Implemented — ADR-175).** An agent
node is NOT recovered by re-creating a session and handing it to the permission
driver — that driver has no durable continuation to resume for a crashed run,
and the prompt it issues is refused by `admitNodePrompt`
(`node_admission_generation`) because the crashed attempt is still bound to the
retired assignment epoch. Recover instead calls
`runFlow(runId, { crashResume: { targetStepId }, db, executionHosts })`, exactly
as the `redispatch` arm does. The graph appends a **fresh** `node_attempts` row
stamped with the new epoch, so admission passes by construction and the prompt's
logical operation key cannot collide; `applyCreateAck` re-binds the row. The
retained handle rides the existing ADR-081 session policy, which reads the
**node's own** attempt row — so a finished `gate-*` or `*-verify-*` substep
session can never be resumed in the node's place. A supervisor that refuses the
handle degrades observably to a fresh session (`session_fallback`), it does not
fail the recover.

Recovery priority, in order:

1. **Reconcile existing command evidence** for the crashed attempt's last
   `session.prompt` — outside every transaction, because it is host I/O.
2. **Apply an owned terminal result** if one agrees and the owner never applied
   it, re-binding that attempt to the new epoch in the same transaction, and
   continue the graph with **no second paid turn**. A quarantined disagreement is
   never converted into a re-prompt.
3. **Close the attempt boundary and re-dispatch once** — the crashed attempt is
   closed `Reworked` with `decision='crash_recover'` (excluded from
   `rework.maxLoops`, from both Observatory correction counters, and from the
   operator-restart budget), then the graph re-enters.
4. **Never replay a prompt that already has agreeing terminal evidence.**

A crashed **orchestrator** is branched before any of that: children unsettled →
it is handed back to its existing child-wait gate (`WaitingOnChildren`,
`resume_requested_at` cleared, slot released through the ordinary idle release)
and the wake path drives it, so the answer is
`200 {state:"resumed", runStatus:"WaitingOnChildren"}`; all children settled →
it re-enters through `orchestratorResume`, which REUSES the parked `NeedsInput`
attempt and threads the coordinator's own handle; no children ever created →
the ordinary crash-resume path. `crashResume` and `orchestratorResume` are
mutually exclusive by construction, and passing both would silently take the
crash path and re-delegate.

A session-less node carries no resumable session and is re-dispatched via
`runFlow` **only** when its manifest config declares `retry_safe: true`
(re-running a session-less node repeats its side effects — accepted-risk);
otherwise it is discard-only. The durable `Crashed → Running` (or
`Crashed → Pending` when the cap is full) flip commits before any supervisor
side-effect, so a lost supervisor ack leaves the run `Running` for the
reconciler, never double-spawns.

The runner recognizes Recover as a **crash-resume mode** (a third resume mode
alongside NeedsInput-resume and takeover-resume). The claim is single-winner via
a CAS-clear of the in-flight marker (`UPDATE runs SET resume_started_at = NULL
WHERE id = ? AND resume_started_at IS NOT NULL`): the winner drives, the loser
bails. That same marker is what makes the intent durable — a web death after the
Phase-1 commit leaves `status='Running'` with the marker set and
`current_step_id` pinned, and the reconcile sweep re-enters it through the same
claim with **no second operator click**. The bounded flow continuation worker
cannot serve that state (its `node_attempts` arm requires an open `Running`
attempt on the ACTIVE assignment), which is why the sweep owns it. A run that
cannot be re-entered returns to `Crashed` and stops; the bound is the grace
window plus `crashRunningRun`, not a retry counter.

**No silent no-op (Implemented — ADR-175).** Two arms, because the committed
intent can be left in two different shapes:

- **No live session** — the shape a web death after the recover claim actually
  leaves. `classifyRunReconcile` gains a `recover` action for it, ordered AFTER
  the grace guard so a dispatch in flight is never raced, and the sweep hands the
  run to `driveResume` — one owner for the whole evidence → close → dispatch
  sequence rather than a second copy of that ordering in the sweep. Without this
  arm the classifier reached the agent no-live-session branch and, past grace,
  **crashed the run again**, discarding the operator's decision.
- **Live session, no driver** — the orphaned idle session the pre-ADR-175
  recover arm left behind. The reattach arm now carries `{db, executionHosts}`
  and, when the marker is set, the `crashResume` signal, instead of a bare
  `runFlow(runId)` the already-owned graph guard no-ops.

Both are classified, logged and **counted** in the sweep summary
(`crashRecoverReentered`, `runningIdleSession`), so an operator sees the
classification rather than having to grep a log.

What the reconciler may never do is resume a mid-turn agent **implicitly** —
that is the rule the classification table above enforces, and it is unchanged by
the external route. A caller POSTing either recover endpoint has made the
decision explicitly; only the credential carrying it differs. Both entry points
run the same classifier, the same Phase-1 CAS + cap re-admission, and the same
`RecoverResult → HTTP` projection (`web/lib/runs/recover-http.ts`) — whose
success `runStatus` reports the run's COMMITTED status rather than a constant —
so a second concurrent call is `409` and a cap-full recover queues rather than
over-spawning, and the queued promotion reaches the same graph re-entry through
`driveResume`. The three `409` outcomes are machine-distinguishable on
`details.reason` (`discard_only`, `recover_cas_lost`, `workspace_removed`), which
is what makes the operation safe for an unattended caller. See
[external-operations.md](external-operations.md).

### Automated crash-recover re-entry (Implemented — ADR-176)

The committed-intent arm above is no longer the sweep's alone. The **flow
continuation worker** adopts the same state on its ~1 s idle cadence, and the
sweep becomes its backstop rather than the only re-entry. The reason this could
not be a predicate copy is the anchor-A26 fact recorded above: the crashed
attempt is bound to the **retired** assignment epoch, so it satisfies none of the
worker's three existing evidence arms and needed its own.

Two things make the adoption safe, and both are ADR-176's decision:

- **One shared routing decision.** `routeCrashRecover` in
  `web/lib/runs/crash-recover-route.ts` is the single implementation of the
  recover-vs-reattach choice, and `classifyRunReconcile` was refactored to call
  it. A second copy would not merely drift — on a **live** session it would route
  to `driveResume`, whose `closeCrashedNodeAttempts` closes an attempt the
  session is still producing, and the re-prompt then double-spends that turn.
  The sweep's arms, counters and observable behaviour are unchanged.
- **A durable per-run budget.** `crash_recover_attempts` and
  `crash_recover_next_retry_at` bound the worker's re-entries at 5 with
  `min(2^n, 60)s` backoff, because `driveResume` deliberately returns `transient`
  without rolling back and a 1 s cadence would otherwise hot-loop against an
  already-failing supervisor. Reset happens at every claim-marker write site, so
  each new intent starts from zero.

Liveness is a probe, not a column: the worker calls the same
`hosts.local().listSessions()` the sweep uses, but only for a candidate that has
already passed the SQL filter and the grace guard — a state that exists only
after a web death. A throwing probe yields the candidate to the sweep and
dispatches nothing.

The budget counts **attempts, not rounds**. The worker's two slots both select
the same head row and both dispatch — single-winner is `claimFlowDriver` inside
`runFlow`, and the pre-dispatch stretch is idempotent by construction — so a
failing round spends two attempts against the cap of five. The shared
`crash_recover_next_retry_at` still removes the run from both slots' candidate
sets until it expires, so the loop stays bounded and backed off.

**Recovery-window table (normative).** Every reachable cell names its owner. The
worker's cells all additionally require `execution_assignments.state = 'active'`
and `crash_recover_attempts < 5`.

| `runs.status` | Live session? | Marker / mode | Owner | Action |
| --- | --- | --- | --- | --- |
| `Running` | no | `resume_started_at` set, past grace | flow continuation worker | `recover` → `driveResume`; the sweep would do the same ≤ 60 s later |
| `Running` | **yes** | `resume_started_at` set | flow continuation worker | `reattach` → `runFlow(crashResume)`; `closeCrashedNodeAttempts` MUST NOT run |
| `Running` | either | `resume_started_at` set, **inside** grace | neither | `wait` — a dispatch may be in flight; yield |
| `Running` | probe threw | `resume_started_at` set | periodic sweep | worker yields and logs WARN; the sweep re-decides on its own tick |
| `Running` | no | `crash_recover_attempts` = 5 | periodic sweep | worker stops serving, logs `flow-continuation-crash-recover-budget-exhausted` once; the unchanged `recover` arm still recovers it |
| `Running` | any | `execution_assignment_id` IS NULL (pre-Stage-A row) | periodic sweep | the worker's inner join drops it; `driveResume` would refuse it anyway |
| `Running` | any | assignment not `active` | periodic sweep | outside the worker's predicate |
| `Running` | no | **no** `resume_started_at` | periodic sweep | the ordinary `crash` arm — unchanged; no committed intent exists to honour |

### Cron GC route (Implemented; compatibility wrapper Implemented)

`GET`/`POST /api/cron/gc` runs the unified `system_sweep` service on demand,
guarded by a constant-time `X-Maister-Cron-Token` comparison.

The route is kept as a compatibility wrapper over the unified scheduler
`system_sweep` service. The response shape and `200`/`207`/`401`/`503` behavior
remain the original GC contract; new external cron integrations should prefer
`/api/cron/tick`. The shared GC bundle both entry points run includes the
ADR-148 evaluation-evidence sweep (orphan `preparing` recovery + two-stage
reference-guarded `pending_delete → deleted` finalize — see Domain entities
above) alongside workspace/revision GC, capabilities cleanup, ephemeral-agent
cleanup, and the agent-materialization retry.

```mermaid
flowchart TD
    Req([GET or POST /api/cron/gc]) --> Cfg{MAISTER_CRON_TOKEN configured?}
    Cfg -- empty --> R503[503 disabled]
    Cfg -- set --> Tok{header == token<br/>constant-time?}
    Tok -- no --> R401[401]
    Tok -- yes --> Run[run system_sweep compatibility service]
    Run --> Sum{any sub-sweep partial failure?}
    Sum -- no --> R200[200 JSON summary]
    Sum -- yes --> R207[207 JSON summary]
```

### Preserve-then-prune (Implemented)

The destructive-safety core: every removal is gated on preserve success;
GC archives a branch, it never merges to main/target (that is the shared
promotion service).

```mermaid
flowchart TD
    Start([GC candidate: terminal run,<br/>effective deadline reached,<br/>removed_at IS NULL]) --> Porcelain[statusPorcelain --untracked-files=all]
    Porcelain --> Dirty{dirty?}
    Dirty -- yes --> Snap[git add -A &&<br/>git commit --no-verify<br/>maister: GC snapshot of runId]
    Dirty -- no --> DivCheck{logRange base..branch<br/>non-empty?}
    Snap --> Arch[git branch -f maister/archive/runId HEAD]
    DivCheck -- yes --> Arch
    DivCheck -- no --> NothingToPreserve[nothing to preserve]
    Arch --> Push{remote present AND<br/>MAISTER_GC_ARCHIVE_PUSH=true?}
    Push -- yes --> DoPush[git push archive ref]
    Push -- no --> Mark[set archived_branch + archived_at]
    DoPush --> Mark
    Mark --> Ok{preserve ok?}
    NothingToPreserve --> Ok
    Ok -- yes --> Remove[removeOwnedWorktree force<br/>then set removed_at]
    Ok -- no --> SkipRow[skip row, log WARN,<br/>leave for next tick]
    Remove --> Done([next row])
```

### Context-mount GC backstop (Implemented — ADR-157)

A new sweep in the `system_sweep` family, modeled on
`web/lib/gc/ephemeral-agent-gc.ts` (`runEphemeralAgentGcSweep`): scan the disk,
join each candidate to its owning run, reap what no live run owns. It reaps
mounts under `.maister/*/runs/*/context/*` whose owning run is **terminal or
absent**, then runs `git worktree prune` on every touched sibling repo. The
owning run id is read from the `runs/<runId>` path segment and the donor repo
from resolving `<siblingSlug>` to that project's `projects.repo_path` — so the
sweep needs **no** `runs.context_mounts` snapshot and reaps by **path shape
alone**. That is deliberate: it is the only cleanup that can reach the residual
crash window where a mount was created but its snapshot never committed.

The live allow-list is `Pending | Running | NeedsInput | NeedsInputIdle |
HumanWorking | WaitingOnChildren | Review` (`CONTEXT_MOUNT_LIVE_RUN_STATUSES`);
anything outside it — or a missing `runs` row — means the terminal choke already
ran or never will. `Review` is IN the set (unlike the agent-only `-ro` sweep it
is modeled on) because a `Review` flow run can rework and re-open a session that
still expects its mounts. `WaitingOnChildren` is in for the same reason in its
strongest form: a parked orchestrator WILL be woken by a child-terminal event and
resumed via `session/resume` into the same node, so reaping its mounts mid-park
would hand the resumed coordinator paths that no longer exist.

Where it goes **beyond** the `-ro` sweep it copies: that sweep has no durable
per-item state — it counts a `failed` and retries forever, so one permanently
undeletable path is re-attempted on every tick. This backstop carries a
**durable per-item attempt marker** using the ADR-148 *semantics* (`state` /
`attemptCount` / `nextRetryAt` / sanitized error evidence) but deliberately
**not** the `workspace_reconciliation_findings` table. Two independent reasons:
that table's `candidate_kind` CHECK admits only four values
(`row_missing_path | row_removed_path | rowless_managed | untrusted`), and — the
load-bearing one — `loadDueReconciliationFindings` filters only on `state`,
`nextRetryAt`, and `leaseExpiresAt` with **no kind predicate**, so a
context-mount row would be claimed and processed by the workspace reconciler
itself. The marker is instead an atomically-written file at
`<runDir>/context/.gc/<siblingSlug>.json`, deleted on a successful reap and
**retained on permanent failure as the operator-review evidence**. A
permanently-failing mount therefore cannot starve the rest of the scan:

- **Bounded retries with explicit backoff** — a transient failure sets
  `nextRetryAt` from an explicit backoff schedule (a literal table, not a
  formula, so an operator reading the marker can predict the next attempt) and
  the item is skipped until then; the attempt cap is a constant, not "retry
  forever".
- **Poison-item policy** — a *deterministic* failure (a path that is not a
  registered worktree of the named sibling, a sibling project row that no longer
  exists, a malformed path shape) becomes a permanent `failed` with sanitized
  error evidence recorded, surfaced for operator review and never re-attempted;
  a *transient* failure (a locked worktree, a busy repo) gets the bounded retry.
  The distinction is recorded on the marker, not inferred from a retry count.

```mermaid
flowchart TD
    Tick([system_sweep tick]) --> Scan[scan .maister/*/runs/*/context/*<br/>one candidate per sibling mount]
    Scan --> Own{owning run still live?}
    Own -- yes --> Keep[leave in place]
    Own -- "no: terminal or run row absent" --> Due{durable marker due?}
    Due -- "no: backoff pending or permanently failed" --> Skip[skip this tick]
    Due -- yes --> Claim[claim the marker and bump attempt_count]
    Claim --> Rm[removeWorktree force against the sibling repo<br/>then git worktree prune]
    Rm -- ok --> Res[resolve the marker]
    Rm -- transient --> Back[set next_retry_at from the backoff schedule]
    Rm -- "deterministic or attempt cap reached" --> Poison[mark failed permanently<br/>record sanitized error evidence]
    Keep --> Next([next candidate])
    Skip --> Next
    Res --> Next
    Back --> Next
    Poison --> Next
```

#### Context mounts are out of the workspace reconciler's scan scope BY PATH

This is a structural property of where mounts live, not a filter someone added,
and it is the reason the mount path was chosen:

- The workspace reconciler scans **only** `worktreesRoot()/<slug>/<entry>` —
  exactly **two** path segments below the worktrees root
  (`isSafeWorkspaceRelativePath`, `web/lib/gc/workspace-reconciler.ts`). A mount
  at `.maister/<slug>/runs/<runId>/context/<siblingSlug>/` is not under
  `worktreesRoot()` at all, so it never enters `listCandidates()`.
- `loadTrustedProject` requires `project.repoPath === provenance.parentRepoPath`.
  A sibling mount's parent repo is **by definition a different project's repo**,
  so a mount that *did* land under `worktreesRoot()` could never satisfy that
  identity check.

**Consequence: moving context mounts under `worktreesRoot()` is a
KNOWN-BREAKING change and must be treated as one.** Every mount would become a
candidate whose provenance names a foreign parent repo, and each would resolve
to a `quarantined:untrusted_candidate` finding — the reconciler would fill with
quarantine rows for paths that are working exactly as designed. A future change
that relocates mounts must therefore land with a matching reconciler scope
change in the same commit, never on its own.

## Result-only completion feeds the ordinary GC shape (Implemented — ADR-165)

A flow run that finishes `Running → Done` by result-only completion stamps
`workspaces.scheduled_removal_at = now + MAISTER_GC_AGE_DAYS` in the same
terminal transaction, exactly like a promoted run. GC needs no new branch: the
row is already `Done` with a deadline, which is what
`DISPOSABLE_WORKSPACE_RUN_STATUSES` collects. See
[`run-results.md`](run-results.md) and [`workspaces.md`](workspaces.md).

## Expectations

- Reconcile is **allow-list `Running`-only**: a row whose `runs.status` is
  not `Running` is NEVER reclassified by the reconcile sweep.
- A `Running` run whose `workspaces.worktree_path` is absent from
  `listWorktrees` MUST be crashed (reason `worktree-gone`) via
  `crashRunningRun`.
- A `Running` agent run with no live session MUST be SKIPPED while
  `resume_started_at` OR the latest `node_attempts.started_at` is within
  `MAISTER_RECONCILE_GRACE_SECONDS` (default 90); only past grace MUST it be
  crashed (reason `agent-session-gone`). A `Running` run with no live session
  whose current node is a read-only gate eval (`check`/`judge`) MUST be
  re-dispatched; a `cli` node MUST be crashed (reason `cli-not-retry-safe`) and
  NEVER auto-re-dispatched.
- A `Running` agent run with NO `acpSessionId` match but a LIVE supervisor
  session for its `(runId, currentStepId)` MUST be SKIPPED (reason
  `live-session-by-step`), never crashed: the node's prompt is in-flight and
  `acp_session_id` is persisted only after it returns.
- A `Running` `run_kind='agent'` run with a LIVE session and NO in-process
  observer MUST be given one back (`reobserve`, reason `agent-observer-gone`);
  with an observer already registered in this process it MUST be skipped
  (`agent-observer-live`). The re-observe MUST NOT write run state, MUST NOT
  drive a prompt and MUST yield on a fenced assignment; a reader that cannot
  attach is never a reason to tear a live session down. A live `run_kind='scratch'`
  dialog stays `live-scratch-session` — its next user message is its continuation
  owner. When THIS process recorded why an observer gave up, the terminal status
  the sweep later writes MUST name that failure alongside its own classification.
- A supervisor `listSessions` failure MUST skip the whole reconcile tick;
  the sweep NEVER crashes a run on transient supervisor unavailability.
- (ADR-121, T15) The sweep MUST clear a STALE C2 admission claim — a
  `tasks.queue_claimed_at` older than the grace window (a claimer that crashed
  between the CAS and `launchRun`'s run-INSERT) — counted as `staleClaimsCleared`;
  it runs every tick independent of the run-candidate set (even on a
  zero-candidate tick) so a crashed claimer never strands the task.
- **(Implemented — ADR-163 amendment)** The sweep MUST stop a live supervisor
  session whose run row is already `Abandoned` — counted as
  `orphanSessionsReaped`, allow-listed to exactly that status — without
  writing the row: it is the orphan of a run-tree cascade whose best-effort
  session teardown did not complete.
- Reconcile candidate sets MUST stay disjoint from `runResumeRecoverySweep`
  (`NeedsInput`) and `runTakeoverReturnRecoverySweep` (returned takeover);
  reconcile excludes the takeover-return predicate.
- Every `Running → Crashed` MUST call `promoteNextPending` after commit, MUST
  clear `runs.resume_started_at`, and MUST copy `current_step_id →
  resume_target_step_id` (nulling `current_step_id`) so the row is cleanly
  re-recoverable and operator Recover has a target node.
- Operator Recover MUST classify via `classifyRecover(run, nodeKind,
  retrySafe, consensusEvidence)` over the recover target (`resume_target_step_id`, else
  `current_step_id`): an agent node with an `acpSessionId` resumes via
  the ACP `session/resume` call; a session-less node re-dispatches ONLY when its config is
  `retry_safe: true`; a `consensus` node refuses a quarantined attempt, redispatches
  an applied incomplete-synthesis witness, and otherwise takes the session-less
  rule (the evidence argument is required — `null` for other kinds); every other case is discard-only — and the crash-resume
  runner MUST claim single-winner via a CAS-clear of `resume_started_at`.
  **(ADR-176)** The committed intent it leaves behind MUST be routed by the one
  shared `routeCrashRecover` helper that the sweep and the flow continuation
  worker both call — a live session MUST take `reattach` and MUST NEVER reach
  `driveResume`, whose `closeCrashedNodeAttempts` would double-spend the live
  turn — and the worker's re-entries MUST be bounded by
  `crash_recover_attempts < 5` with `min(2^n, 60)s` backoff, both columns reset
  in the same transaction as every `resume_started_at` write, after which the
  unchanged sweep arm remains the backstop.
- GC MUST select terminal candidates by the effective deadline
  `COALESCE(workspaces.scheduled_removal_at, runs.ended_at + MAISTER_GC_AGE_DAYS) <= now()`
  so pre-0015 terminal runs with null `scheduled_removal_at` are still
  collected (no backfill migration).
- GC MUST preserve before pruning: a dirty worktree's tracked **and**
  untracked changes are snapshot-committed and pointed at archive branch
  `maister/archive/<runId>`; removal MUST be gated on preserve success and a
  preserve failure MUST skip the row (never force-remove unpreserved state).
- Operator archive/drop actions reuse the same preserve-before-remove
  invariant immediately from the workbench lifecycle UI. Background GC remains
  schedule-driven; user-initiated drop is claim-serialized through
  `workspaces.lifecycle_operation_*` and still refuses removal when preservation
  fails.
- GC MUST NOT merge into main/target; preservation is archive-branch
  (+ optional push when `MAISTER_GC_ARCHIVE_PUSH=true`, default `false`)
  only.
- The cron route MUST return 503 when `MAISTER_CRON_TOKEN` is empty/unset,
  401 on token mismatch (constant-time compare), and MUST NEVER log or
  stream the token; `MAISTER_CRON_TOKEN` is a server-only secret.
- Revision GC MUST delete a `flow_revisions` row only when its
  `package_status='Removed'`, past `MAISTER_GC_AGE_DAYS`, with zero
  `runs.flow_revision_id` references and zero `flows.enabled_revision_id`
  references; it only removes (`rm installedPath`), never runs `setup.sh`.
- Context mounts MUST stay OUT of the workspace reconciler's scan scope by
  path: the reconciler scans only `worktreesRoot()/<slug>/<entry>` (exactly two
  segments), so a live mount under `.maister/*/runs/*/context/*` MUST produce
  zero findings and zero quarantines. (Implemented — ADR-157)
- The context-mount GC backstop MUST reap a mount whose owning run is terminal
  or absent and MUST leave a live run's mount in place; every candidate MUST
  carry a durable attempt marker with bounded retries, so a permanently-failing
  mount is marked `failed` with recorded evidence and NEVER starves the rest of
  the scan. (Implemented — ADR-157)

## Edge cases

- **`CHECKPOINT`** — Recover hit a supervisor 4xx for an unresumable ACP
  session; the run is crashed (`crashRunningRun`, `resume_started_at`
  cleared) and only Discard is offered. No new error code is introduced.
- **`CONFLICT`** — surfaced by an underlying read-only range git op during
  preserve (e.g. `logRange`/snapshot failure on a damaged worktree); the
  preserve returns not-ok, the row is skipped and the worktree is NOT
  removed.
- **`PRECONDITION`** — Recover/Discard refused because the row is not in an
  admitted allow-list state (e.g. a concurrent transition already moved it);
  returned as 409.
- **`EXECUTOR_UNAVAILABLE`** — supervisor transient 5xx/network/timeout
  during a Recover side-effect: the row is LEFT `Running` (no rollback,
  ack may have been lost) and the reconciler re-attaches if the session came
  up or re-crashes past grace; returned as 503, retryable.
- **Cron token missing** — `MAISTER_CRON_TOKEN` empty ⇒ route is disabled
  (503), the sweep never runs from the HTTP surface; the background sweeper
  is unaffected.
- **Preserve crash window** — a death between snapshot and prune converges
  on the next tick: dirty-not-snapshotted re-runs `statusPorcelain` +
  snapshot; archived-not-pruned re-runs preserve (idempotent `git branch
  -f`) then removes; pruned-not-marked sets `removed_at` (no-op removal on a
  missing path).
- **(Implemented, ADR-157) Orphan context mount from a crash before the snapshot
  commit** — no `runs.context_mounts` entry references it, so it is reaped by
  path shape alone. This is the case that forbids replacing the backstop with a
  snapshot-driven cleanup.
- **(Implemented, ADR-157) Poison context mount** — a candidate whose removal fails
  deterministically (path is not a registered worktree of the named sibling,
  sibling project row gone, malformed path shape) is marked permanently `failed`
  with sanitized evidence after its bounded retries, and the sweep continues with
  the next candidate; it is never retried on every tick and never aborts the
  sweep.

## Reconcile classification (ADR-033)

For each run at reconcile time, gather: `run.status`, `run.runKind`,
`run.acpSessionId`, `run.currentStepId`, the workspace `worktreePath`, the
**node type of `currentStepId`** (from the run's pinned graph
`flow_revisions.manifest`), `worktreeExists` (path ∈ `listWorktrees`),
`liveSession` (`acpSessionId` ∈ live `listSessions` map), and — for a
`run_kind='flow'` candidate with no live session on an agent node — the
**prompt evidence** of the current attempt's newest owned `session.prompt`
command (ADR-177, see [Evidence classes](#evidence-classes-adr-177-implemented)).
Then:

The `Evidence` column is the ADR-177 discriminant. It is resolved for the flow
agent-node arm only; every other row reads `—` and is classified exactly as it
was before ADR-177.

| Run state | Condition | Evidence | Action | Reason |
|-----------|-----------|----------|--------|--------|
| status ∉ `{Running}` | any | — | **SKIP** | reconcile is **allow-list `Running`-only**; `NeedsInput`/`NeedsInputIdle`/`HumanWorking`/terminal owned by other sweeps |
| `Running` | worktree MISSING | — | **CRASH** (`crashRunningRun`, reason `worktree-gone`) | the "runs vs `git worktree list`" check; cannot continue |
| `Running`, `runKind='flow'` | current node **`consensus`**, live session or not, and a `consensus_verifier` / `consensus_synthesis` command of the current open attempt is poisoned or quarantined | `quarantined` ∨ `poisoned` (`resolveConsensusPoisonEvidence`) | **CRASH** (evidence boundary, reason `owner-poisoned`) | P0-5 v2: a poisoned or quarantined consensus generation is a terminal owner refusal even while its supervisor session lives, so this arm precedes the live-session arms (after the sync arm). The row is classified by `classifyPromptEvidence`, so a conflict found AFTER application (`application_state='applied'` with `application_error.reason='prompt_terminal_conflict'`) counts. Only the current open attempt's commands are read; an older or closed attempt's generation cannot crash a new attempt. Recover then follows the consensus table in [`runs.md`](runs.md) |
| `Running`, `runKind='flow'` | worktree present, `liveSession` present | — | **RE-ATTACH** (`scheduleResumedSessionDrive`) or re-dispatch `runFlow` | live agent session with no attached runner (post web restart) — not crashed |
| `Running`, `runKind='agent'` | worktree present, `liveSession` present, an in-process observer holds the host session | — | **SKIP** (reason `agent-observer-live`) | the run's single reader of its canonical stream is alive here — healthy |
| `Running`, `runKind='scratch'` | worktree present, `liveSession` present | — | **SKIP** (reason `live-scratch-session`) | a scratch dialog between turns is healthy; its continuation owner is the next user message, and a continuation prompt it cannot satisfy would be crashed by the watchdog |
| `Running`, `runKind='agent'` | worktree present, `liveSession` present, NO in-process observer | — | **RE-OBSERVE** (`reobserveAgentSession`, counted as `reobserved`) | an agent run has no continuation driver — its live path is ONE in-process observer (`consumeAgentSession`). A web restart, or an observer whose supervisor exhausted its retries, leaves a live session nobody reads; this arm used to classify RE-ATTACH and was then refused ("refusing reattach for non-flow run"), so the run held an unread session until it died and the sweep crashed it as `agent-session-gone`. The re-observe binds the run's ACTIVE assignment, writes NO run state, and yields on a fenced assignment |
| `Running` | worktree present, no `acpSessionId` match but a LIVE session exists for this `(runId, currentStepId)` | — | **SKIP** (reason `live-session-by-step`) | an agent node's prompt is in-flight — `acp_session_id` persists only AFTER it returns, so the active `run_sessions` row's is still null; the node is genuinely running and must NOT be crashed (the bug this guards) or re-attached (double-drive) |
| `Running` | worktree present, no live session, current node is a **retry-safe gate eval** (`check`/`judge`/`guard`/`human`/`form`/null — read-only) | — (arm 9 reads no evidence) | **RE-DISPATCH** `runFlow` (CAS-guarded) | safe re-run of a read-only evaluation; avoids the forbidden false-positive crash on a gate executing between sessions |
| `Running` | worktree present, no live session, current node is **`cli`** (arbitrary side effects, NOT retry-safe) | — (arm 9 reads no evidence) | **CRASH** (`crashRunningRun`, reason `cli-not-retry-safe`) | CAS prevents concurrent runners, NOT re-run idempotency (Codex F4); a half-run `cli` may have partial file/network side effects — never silently re-run. Recoverable via an explicit Recover call **only** when the node config declares `retry_safe: true` (accepted-risk re-dispatch); otherwise discard-only. |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, the owner worker already applied the turn | `applied` | **SKIP** (reason `evidence-applied`) | ADR-177: the result is in the ledger; the flow continuation worker (~1 s) drives the next node. Fires **regardless of grace** |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, a worker holds the application claim | `applying` | **SKIP** (reason `evidence-pending`) | ADR-177: the claim holder owns the follow-up. Fires **regardless of grace** |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, the command is settled but unapplied | `pending_application` | **SKIP** (reason `evidence-pending`) | ADR-177: the prompt-owner worker (~1 s) owns the follow-up. Fires **regardless of grace** |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, the receipt says `completed` but no terminal event is ingested | `pending_ingest` | **SKIP** (reason `evidence-pending`) | ADR-177: the event consumer owns the follow-up, once the dead stream claim expires. Also the answer for a probe that failed or 404'd, and for a `rejected` receipt with no `turn_lost` reason — an ordinary errored turn belongs to its owner, not to a crash. Reconcile never invents a terminal outcome from a missing or inconclusive receipt. Fires **regardless of grace** |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, the receipt says `accepted` + `inflight:true` | `inflight` | **SKIP** (reason `evidence-inflight`) | ADR-177: the host owns the follow-up — the turn is genuinely still running. Fires **regardless of grace** |
| `Running`, `runKind='flow'` | `pending_ingest` or `inflight` evidence **and** the holding host's `execution_event_streams` row is `lost` | `pending_ingest` ∨ `inflight`, stream `lost` | **CRASH** (`applyTurnLostBoundary`, reason `stream-lost`) | ADR-177: nobody owns the follow-up — that evidence is still ON THE HOST and can never be ingested. The ONLY bound on those two skip arms, read from `commandStreamLost()`, never from a timer. Deliberately NOT applied to `pending_application`/`applying`/`applied`, whose evidence is already in Postgres and whose writer reads it from there |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, the command settled `failed` with reason `turn_lost` | `turn_lost` | **CRASH** (`applyTurnLostBoundary`, reason `turn-lost`) | ADR-177: the host restarted mid-turn. One transaction closes the attempt `Reworked`/`decision='turn_lost'`/`error_code='CRASH'`, crashes the run, and marks the command `applied`. Recover is offered |
| `Running`, `runKind='flow'` | worktree present, no live session, current node is **agent**, the application is quarantined or poisoned | `quarantined` ∨ `poisoned` | **CRASH** (`applyTurnLostBoundary`, reason `owner-poisoned`) | ADR-177: an operator owns the follow-up; Recover follows ADR-175's quarantine rule and never re-prompts from disagreeing evidence. The sub-reason rides `node_attempts.error_code` and the structured log field `applicationErrorReason` |
| `Running` | worktree present, no live session, current node is **agent**, **recently started** (`resume_started_at` OR latest `node_attempts.started_at` within `MAISTER_RECONCILE_GRACE_SECONDS`) | `none` | **SKIP** (grace window) | a launch/recover is still spinning its ACP session up — do NOT crash an in-flight session |
| `Running` | worktree present, no live session, current node is **agent**, **past grace** | `none` | **CRASH** (`crashRunningRun`, reason `agent-session-gone`) | recoverability computed at UI render from `acpSessionId` presence; auto-resume of a mid-turn agent is unsafe → an explicit Recover call (operator or token, never the reconciler itself) |
| `Running`, `runKind='scratch'` | session gone, past grace | — | **CRASH** via `markScratchCrashed` (sets both `runs.status` and `scratchRuns.dialogStatus`) | scratch parity |

### Evidence classes (ADR-177, Implemented)

`PromptEvidenceClass` is derived by one pure function,
`classifyPromptEvidence` (`web/lib/reconcile-evidence.ts`), over the current
attempt's newest owned `session.prompt` row plus — for an `accepted` row with no
terminal evidence — one `GET /commands/{id}` receipt probe. It is resolved in the
sweep's per-candidate enrichment block, so the classifier itself stays pure.
Every class names the writer that owes the next move and the shape the run ends
in if that writer never comes.

| Class | Derived from | Writer that owns the follow-up | Terminal shape |
| --- | --- | --- | --- |
| `none` | no owned prompt for this attempt, the row is still `queued`/`delivering`, or the probe was **indeterminate** — a **v2** `accepted` receipt, which carries no liveness in either direction | the deliverer (W1/W2); nobody at all for the v2 case | falls through to the grace arms — `grace-window` inside, `agent-session-gone` past it |
| `inflight` | receipt `accepted` + `inflight:true` | the host — the turn is running | none while it holds; `stream-lost` if the stream dies |
| `pending_ingest` | receipt `completed`/`404`/unreachable, or `rejected` WITHOUT a `turn_lost` reason (an ordinary errored turn), and no ingested terminal event | the event consumer; since the ADR-167 D5 amendment (Designed, 2026-09-23) also the waiting driver or continuation worker settling from host evidence | none while it holds; if the stream dies, a `completed` probe is first offered to host-evidence settlement (settles → re-classified), else `stream-lost` |
| `pending_application` | command settled (`succeeded`/`failed`/`fenced`), `application_state='pending'` | the prompt-owner worker (~1 s) | none — a dead stream does NOT bound it: the evidence is already ingested and the worker reads it from Postgres |
| `applying` | `application_state='applying'` | the worker holding the application claim | none — as `pending_application` |
| `applied` | `application_state ∈ {applied, superseded}` | the flow continuation worker (~1 s) | none — the graph advances |
| `turn_lost` | settled with error reason `turn_lost` (nested `details.reason`, or flat `reason` from the `foldReceipt` fallback) | the ADR-177 boundary | `runs.status='Crashed'` (`turn-lost`), attempt `Reworked`/`decision='turn_lost'`/`error_code='CRASH'`, command `applied` — recoverable |
| `quarantined` | `application_error.reason='prompt_terminal_conflict'` | an operator | `runs.status='Crashed'` (`owner-poisoned`), attempt closed, command `applied` with its `application_error` PRESERVED (already `applied` when the conflict was found after application — the boundary then rewrites nothing) |
| `poisoned` | `application_state='poisoned'` | an operator | as `quarantined` |

Order matters twice, and both are load-bearing rather than stylistic. The
`quarantined` test precedes the `applied` test, because `quarantine()` writes
`application_state = completion_applied_at ? "applied" : "poisoned"` — a conflict
found *after* application would otherwise read as healthy. The `turn_lost` test
precedes `pending_application`, because a settled lost turn is the boundary, not
something to wait for.

`turn_lost` is matched on the **reason**, never on an HTTP status and never on
the error code: the code is `PRECONDITION` when the host committed a rejected
receipt and `ACP_PROTOCOL` when the accepted-with-no-terminal fallback wrote it.
## Linked artifacts

- **Sweep pass order (`runSystemSweep`, `web/lib/scheduler/system-sweeps.ts`).**
  `runSweepTick` (keep-alive) → `runReconcileSweep` → `runSyncRecoverySweep` →
  `reconcileTerminalCostRollups` → `ensureLocalExecutionDataPlane` →
  `runEventStreamHealthSweep` → `executionCommandReconcilePass`
  (`recoverExecutionCommands`). `recoverExecutionCommands()` runs **before**
  reconcile only at boot (`web/instrumentation-node.ts`, `{graceMs: 0}`); on the
  periodic tick it runs **after** it, and a stream is marked `lost` later still.
  Two consequences the ADR-177 design turns on: reconcile sees command evidence
  up to one 60 s tick stale, so its receipt probe is load-bearing and cannot be
  replaced by "recovery ran first"; and the
  `runEventStreamHealthSweep → executionCommandReconcilePass` adjacency is itself
  load-bearing, because `recoverExecutionCommands` reads the `lostStreamHostIds`
  that the health pass wrote earlier in the same pass — which is why reordering
  the sweep was considered and rejected (ADR-177, Alternatives).
- Execution-host contract (ADR-166, Implemented): [`execution-hosts.md`](execution-hosts.md) — the `system_sweep` pass adds the command-recovery + 7-day retention passes and the backstop that releases `active` assignments of runs with no owned driver (parked, review, crashed, terminal — never `Pending | Running | NeedsInput`), and the reconciler checks adopted handles read-only (`workspace-handle-lost` WARN on 404).
- ADRs: [ADR-033 Crash reconciliation model](../decisions.md#adr-033),
  [ADR-034 Crashed-run recovery semantics](../decisions.md#adr-034),
  [ADR-035 Graceful workspace GC (preserve-then-prune)](../decisions.md#adr-035),
  [ADR-036 Flow-revision GC](../decisions.md#adr-036),
  [ADR-157 Read-only sibling-repo context mounts](../decisions.md#adr-157-read-only-sibling-repo-context-mounts)
  (Designed — the context-mount GC backstop and the reconciler scan-scope
  boundary).
- API: [`../api/web.openapi.yaml`](../api/web.openapi.yaml)
  (`/api/runs/{runId}/recover`, `/api/runs/{runId}/discard`,
  `/api/runs/{runId}/archive`, `/api/runs/{runId}/drop`, `/api/cron/gc`);
  [`../api/external/operations.openapi.yaml`](../api/external/operations.openapi.yaml)
  (`/api/v1/ext/runs/{runId}/recover`, `/api/v1/ext/runs/{runId}/discard`).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md),
  [`../db/erd.md`](../db/erd.md) (`workspaces.scheduled_removal_at`,
  `archived_branch`, `archived_at`, `runs.resume_started_at` — migration
  0015; `runs.resume_target_step_id` — migration 0016).
- Config reference: [`../configuration.md`](../configuration.md) —
  `MAISTER_RECONCILE_GRACE_SECONDS`,
  `MAISTER_GC_AGE_DAYS`, `MAISTER_GC_WARNING_DAYS`,
  `MAISTER_GC_ARCHIVE_PUSH`, `MAISTER_CRON_TOKEN`.
- Error taxonomy: [`../error-taxonomy.md`](../error-taxonomy.md)
  (`CHECKPOINT`, `CONFLICT`, `PRECONDITION`, `EXECUTOR_UNAVAILABLE` —
  reused, no new code).
- Operator Recover of a crashed **agent** node MUST re-enter the flow graph at
  the recover target (`runFlow(runId, { crashResume: { targetStepId } })`) with
  the crashed `node_attempts` row closed `Reworked`/`decision='crash_recover'`
  and exactly ONE new `session.prompt` command issued under the newly minted
  `execution_assignment_id` — and none at all when the crashed attempt already
  carries agreeing terminal evidence, which is applied first. **ADR-177
  exception:** a `turn_lost` result is not agreeing terminal evidence — a lost
  turn is not the node's outcome. Recover declines it, settles the stranded
  command `superseded` with `completion_applied_at` in the same transaction that
  closes the attempt (so it can still be retired), and re-dispatches exactly one
  fresh prompt.
- A `Running` run left holding `runs.resume_started_at` with a non-null
  `current_step_id` MUST be re-entered by the reconcile sweep without a second
  operator action — through the `recover` classifier arm when no session is live,
  and through the crash-resume reattach when one is — and both outcomes MUST be
  counted in `ReconcileSweepSummary` rather than silently skipped or re-crashed.
- Related domains: [`runs.md`](runs.md), [`workspaces.md`](workspaces.md),
  [`workbench-lifecycle.md`](workbench-lifecycle.md),
  [`flow-packages.md`](flow-packages.md), [`flow-graph.md`](flow-graph.md).
- Source (Implemented): `web/lib/reconcile.ts`, `web/lib/runs/recover.ts`,
  `web/lib/gc/preserve.ts`, `web/lib/gc/workspace-gc.ts`,
  `web/lib/gc/revision-gc.ts`, `web/lib/scheduler/system-sweeps.ts`.
- Context-mount backstop (ADR-157): `web/lib/gc/context-mount-gc.ts` (the sweep +
  the on-disk `.gc/<siblingSlug>.json` marker), `web/lib/context-mounts/terminal.ts`
  (`CONTEXT_MOUNT_LIVE_RUN_STATUSES`, the live allow-list SSOT the sweep imports);
  modeled on `web/lib/gc/ephemeral-agent-gc.ts`; scan-scope boundary asserted
  against `web/lib/gc/workspace-reconciler.ts`.
