# Run Continuation Controls — handoff round-trip + soft node interrupt (ADR-159 / ADR-160)

Status: SDD freeze for Phase 0. No production code is implemented by this spec.
Date: 2026-08-31
Branch: `claude/flow-runs-continuation-controls-527f4c`

## Purpose

Two gaps in the human↔agent loop on flow runs. **(A)** A run that reached
`runs.status='Review'` has finished its graph; a human who then finds problems — while
testing, after a handoff/export, or after pushing fixes from another machine — has no way to
return the SAME run into the graph to re-validate those commits. **(B)** A live agent node
that goes off-track mid-turn can only be stopped whole-run, which parks the run in `Review`
and is terminal for the graph; there is no per-node pause, corrective restart, or jump back
outside flow-declared rework points.

This spec freezes the contract for both. Feature A is independently shippable; Feature B
builds on the same ledger and HITL substrate but shares no code path that must be factored
early.

## Scope source

Owner brief (2026-08-31) + owner decisions 1–7 recorded in the plan's
"Owner decisions" section. Durable record: this spec +
[ADR-159](../../docs/decisions.md) + [ADR-160](../../docs/decisions.md) +
[`docs/system-analytics/run-continuation.md`](../../docs/system-analytics/run-continuation.md)
+ the plan [`../plans/claude-flow-runs-continuation-controls-527f4c.md`](../plans/claude-flow-runs-continuation-controls-527f4c.md).

## Verified baseline (read before implementing)

The plan's "Verified anchors" table (A1–A19) is normative context for this spec and is not
duplicated here. The five that shape the contract most:

- `Review` frees the concurrency slot (`countLiveRuns` counts `Running|NeedsInput|HumanWorking`),
  so `Review → HumanWorking` **acquires** one.
- `SETTLED_RUN_STATUSES` includes `Review`, so un-settling a delegated child would break a
  parked orchestrator — hence `parent_run_id IS NULL`.
- `runs.current_step_id` is `NULL` in `Review` — every anchor is ledger-derived.
- The `lifecycle_operation_*` claim is lease-based (300 s + heartbeat) and cannot hold a
  human-paced claim.
- `domain_events.kind` has a real DB CHECK; `hitl_requests.kind` and
  `assignments.action_kind` do not.

---

## Requirements — Feature A (handoff round-trip)

| ID | Requirement (normative) |
| --- | --- |
| **REQ-A1** | A rework claim MUST be admitted only when ALL hold: `runs.status='Review'`, `run_kind='flow'`, `parent_run_id IS NULL`, `workspace_mode <> 'shared'`, run is not a launched evaluation participant, and the workspace exists with `removed_at IS NULL`. The gate MUST be an allow-list; a status not named here is rejected by default. |
| **REQ-A2** | The claim MUST be a status-guarded CAS `Review → HumanWorking`. It MUST re-check the global concurrency cap under the run-row lock **inside the claim transaction**; cap-full MUST return `CONFLICT` and MUST NEVER queue the run as `Pending`. |
| **REQ-A3** | The claim MUST append exactly one takeover-shaped `node_attempts` row at the **last executed node** (ledger-derived), carrying `owner_user_id` and `decision='review_rework_claim'`. The CAS MUST commit before the insert so a concurrent loser never reaches the `UNIQUE(run_id, node_id, attempt)` violation. |
| **REQ-A4** | The re-entry node MUST resolve by this ordered chain, from server state only: (1) flow-level manifest `reentry`, (2) the last executed `human` node whose compiled `transitions.takeover` names a node present in the graph, (3) unresolved ⇒ the action is refused with a reason naming the relaunch escape hatch. An operator MUST NOT be able to choose the re-entry node. |
| **REQ-A5** | While `HumanWorking`, `exportBranch` / `snapshotCommit` / `handoffBranch` / handoff-metadata MUST be available to the **claim owner only**. Every other lifecycle action, and every actor other than the owner, MUST remain refused with `human-owned`. |
| **REQ-A6** | Ingest on return MUST be fetch + **fast-forward only**. Divergence or non-FF MUST refuse with `PRECONDITION` carrying `{command, localSha, remoteSha, aheadBy, behindBy, instructions[]}` and MUST leave all state unchanged. Merge, rebase, and AI resolution are out of scope. A missing remote or absent upstream MUST be a no-op success, not a failure. |
| **REQ-A7** | Return MUST be a two-phase commit: all git reads and refusals precede any ledger write; the AFTER-side marker (`status='Running'` + the claim row's `ended_at`) MUST be set only after the record + artifacts + staleness + cursor writes commit **in one transaction**. A dirty worktree and a zero-commit return MUST each refuse `CONFLICT` before any ledger write. |
| **REQ-A8** | `markDownstreamStale` MUST select, per node, the latest attempt **with `owner_user_id IS NULL`**. A claim row MUST NEVER shield a node's real last execution from gate staling. This applies to every caller, unconditionally. |
| **REQ-A9** | Release without changes MUST return the run to `Review` (not `NeedsInput`), close the claim row, and free the slot via `promoteNextPending`. |
| **REQ-A10** | Claim and return MUST each emit exactly one `domain_events` row (`run.rework_claimed` / `run.rework_returned`) **in the same transaction** as the domain write, with `actor_type='user'`. Neither kind may be added to `RUN_TERMINAL_EVENT_KINDS` or `RUN_SETTLED_EVENT_KINDS`. |
| **REQ-A11** | A process death between the return commit and the runner dispatch MUST be recovered by the existing `runTakeoverReturnRecoverySweep` with no new sweep. |

## Requirements — Feature B (soft node interrupt)

| ID | Requirement (normative) |
| --- | --- |
| **REQ-B1** | An interrupt MUST be admitted only when `runs.status='Running'`, `run_kind='flow'`, the current node has a `node_attempts` row with `status='Running'`, and the node is agent-executed (`ai_coding \| judge \| orchestrator`). `cli` and `check` nodes MUST refuse `PRECONDITION` with a message naming the deferral. |
| **REQ-B2** | The interrupt MUST checkpoint the live session **before** the transaction. An `EXECUTOR_UNAVAILABLE` checkpoint MUST re-throw with **no** mutation; any other checkpoint failure MUST proceed to the pause. `needs-input.json` MUST be written before the transaction and unlinked if it throws. |
| **REQ-B3** | The park MUST be one transaction: CAS `Running → NeedsInput`, `markNodeNeedsInput`, insert a `node_interrupt` HITL, create the assignment, emit `run.needs_input` (webhook) and `run.escalated` with `reason='node_interrupt'` (domain event). `node_attempts` MUST stay append-only and its status enum MUST NOT gain a value. |
| **REQ-B4** | `node_interrupt` MUST be human-actor-only, enforced at the `respondToHitl` chokepoint before any mutation. It MUST have no ext-API or MCP surface. |
| **REQ-B5** | The option set MUST be server-owned and delivered on the existing `availableOptions` channel: `resume`, `restart_node` (default), `restart_from`, `stop`. The client MUST NOT re-derive availability. |
| **REQ-B6** | `restart_from`'s eligible targets MUST be **ledger-derived** — nodes with ≥1 prior attempt in THIS run — because the static graph has cycles. A target with no prior attempt MUST be refused (no forward skips). Declared rework targets MUST be flagged `recommended`. |
| **REQ-B7** | A restart MUST close the parked attempt as `Reworked` with `decision='operator_interrupt'`, apply the operator's workspace policy against the target's `checkpoint_ref` **before** the ledger transaction, stale downstream when the target differs from the interrupted node, and let `runGraph` append a fresh attempt. A missing `checkpoint_ref` MUST degrade to `keep` with a WARN, never a guess. |
| **REQ-B8** | The operator correction MUST reach the agent as a server-side fenced prompt **append**, never through `commentsVar` and never through Mustache. It MUST be captured in `node_attempts.resolved_prompt`. |
| **REQ-B9** | Attempts closed with `decision='operator_interrupt'` MUST be excluded from the `rework.maxLoops` effective count. A run with zero operator restarts MUST behave byte-identically to today. A global `MAISTER_MAX_OPERATOR_RESTARTS` cap MUST refuse further restarts with `CONFLICT`. |
| **REQ-B10** | Operator restarts MUST be excluded from **both** Observatory counters — `reworkCount` (status `Reworked`) **and** `retryCount` (`max(attempt) - 1` per `(run, node)`). Excluding one alone leaves the metric inflated. |
| **REQ-B11** | A `node_interrupt` park MUST behave like `hook_trip` for keep-alive idling, the 24 h `NeedsInputIdle → Abandoned` sweep, and reconcile (never classified `Crashed`). |

---

## API contract

Three new paths in `docs/api/web.openapi.yaml` plus one extended body. Each path object MUST
carry `tags`, `operationId`, a `description` containing the **per-route identifier trust
table** (the established convention at `web.openapi.yaml:7596-7627`), and `$ref`s to the
shared `Unauthenticated` / `Forbidden` / `MaisterErrorBody` components. A new
`tags:` entry `run-continuation` is registered at the document root.

| Path | Method | Success | Refusals |
| --- | --- | --- | --- |
| `/api/runs/{runId}/rework-claim/claim` | POST (empty body) | `200` `{worktreePath, branch, ownerUserId, reentryNodeId, reentrySource}` | `401` · `403` · `404` run not found/not visible · `409` `PRECONDITION` (each REQ-A1 term, REQ-A4 unresolved) / `CONFLICT` (CAS lost, cap full) |
| `/api/runs/{runId}/rework-claim/return` | POST `{remote?}` | `200` `{ok, runStatus:"Running", returnedCommitCount, fastForwarded}` | `401` · `403` non-owner · `404` · `409` `PRECONDITION` (not `HumanWorking`, non-FF, unknown remote) / `CONFLICT` (dirty, empty, CAS lost) · `503` `EXECUTOR_UNAVAILABLE` (ledger tx failed, retryable) |
| `/api/runs/{runId}/rework-claim/release` | POST (empty body) | `200` `{ok, runStatus:"Review"}` | `401` · `403` · `404` · `409` |
| `/api/runs/{runId}/node-interrupt` | POST (empty body) | `202` `{ok, runStatus:"NeedsInput", hitlRequestId}` | `401` · `403` · `404` · `409` `PRECONDITION` (REQ-B1 terms) / `CONFLICT` (CAS lost) · `503` (checkpoint undeliverable) |
| `/api/runs/{runId}/hitl/{id}/respond` | POST (extended) | existing | adds `optionId ∈ {resume, restart_node, restart_from, stop}`, `workspacePolicy`, `targetNodeId`, `correction` |

`GET /api/runs/{runId}` gains a `continuation` block: `{claim, reworkClaimAvailable,
disabledReason, reentryNodeId, reentrySource}`.

**No new `MaisterError` code.** Reuse `PRECONDITION` (409), `CONFLICT` (409), `UNAUTHORIZED`
(403), `CONFIG` (400), `EXECUTOR_UNAVAILABLE` (503); `docs/error-taxonomy.md` gains cell
entries only.

Events land in `docs/api/async/web-runs.asyncapi.yaml` (domain events) and
`docs/api/async/outbound-webhooks.asyncapi.yaml` (webhook types). All five files are covered
by `pnpm validate:contracts`.

## DB contract — migration `0125`

CHECK-only. No column, no data, nothing to back-fill, nothing to refuse loudly.

```sql
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in (
  'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_answered',
  'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.escalated',
  'run.rework_claimed', 'run.rework_returned',
  'gate.failed'));--> statement-breakpoint
```

Shape copied verbatim from `0099_agent_human_ask.sql`. The migration is a **triple** — SQL
file + `_journal.json` entry + `meta/0125_snapshot.json`. The snapshot is hand-authored from
the `0124` snapshot with only the constraint changed: `drizzle generate --custom` copies the
previous snapshot verbatim and would stale the diff baseline for the next migration.

Rollback is the inverse `DROP`/`ADD` with the 11-kind list, valid only while no row carries a
new kind.

### Domain-event taxonomy additions

| Kind | Emitter (same tx as the domain write) | Payload | Actor |
| --- | --- | --- | --- |
| `run.rework_claimed` | rework-claim claim tx | `{runId, taskId?, ownerUserId, reentryNodeId, reentrySource}` | `user` (the claimer) |
| `run.rework_returned` | rework-claim return Phase-2b tx | `{runId, taskId?, ownerUserId, reentryNodeId, returnedCommitCount, fastForwarded, remote?}` | `user` (the owner) |

Neither is run-terminal nor run-settled. Feature B reuses the existing `run.escalated` with
`reason='node_interrupt'` — no taxonomy entry, no CHECK change.

## System-analytics contract

`docs/system-analytics/run-continuation.md` MUST satisfy `docs/CLAUDE.md`:

- **R5** — exactly these sections, in order: Purpose · Domain entities · State machine
  (`stateDiagram-v2`) · Process flows · Expectations · Edge cases · Linked artifacts.
- **R5a** — Expectations: **≤ 12 bullets**, one MUST-hold invariant each, RFC-2119 phrasing,
  every bullet testable, identifiers verbatim (`runs.status`, `owner_user_id`,
  `MaisterError("CONFLICT")`), no duplication of Edge cases or diagrams.
- **R6** — every described piece tagged `(Implemented)` / `(Designed)` / `(Phase 2)`.
- **R2** — Mermaid only. **R7** — cite ADRs, never restate their rationale.

`runs.md`, `manual-takeover.md`, `workbench-lifecycle.md`, `hitl.md`, `flow-graph.md`,
`flow-dsl.md`, `domain-events.md`, `database-schema.md`, `docs/db/domain-events.md`, and
`docs/db/runs-domain.md` move in the same change.

---

## Acceptance criteria traceability

Test ids are stable and are cited by the plan's tasks. `unit` = vitest project `unit`;
`integ` = project `integration` (testcontainers PG16); `e2e` = Playwright.

| AC | Criterion | Requirements | Test |
| --- | --- | --- | --- |
| **AC-A1** | Every non-admitted eligibility term refuses `PRECONDITION` with a distinct message; an unknown status is rejected by default | REQ-A1 | T-A1 (unit, one case per term + allow-list default) |
| **AC-A2** | `agent` run_kind refuses early with a message naming branch-sync/relaunch | REQ-A1 | T-A2 (unit) |
| **AC-A3** | Concurrent claims yield exactly one winner; the loser gets `CONFLICT` and no second attempt row exists | REQ-A2, REQ-A3 | T-A3 (integ) |
| **AC-A4** | Cap-full claim returns `CONFLICT` and creates no `Pending` row | REQ-A2 | T-A4 (integ) |
| **AC-A5** | An orchestrator child (`parent_run_id` set) refuses, so `SETTLED_RUN_STATUSES` is never violated | REQ-A1 | T-A5 (integ) |
| **AC-A6** | Re-entry resolves by manifest, then by takeover transition, then refuses; manifest wins over a present transition; an unknown transition target falls through rather than throwing | REQ-A4 | T-A6 (unit, 4 cases) |
| **AC-A7** | `reentry` with `engine_min < 3.5.0` throws `CONFIG`; at `3.5.0` compiles; unknown node id throws `CONFIG` naming the id; a manifest without `reentry` compiles at any `engine_min` | REQ-A4 | T-A7 (unit, 4 cases) |
| **AC-A8** | During `HumanWorking` the owner reaches export/snapshot/handoff/metadata; a non-owner gets `human-owned` on all four; every other action stays disabled for both | REQ-A5 | T-A8 (unit, status × owner × workspace matrix) |
| **AC-A9** | Non-FF divergence refuses with the failing command and both SHAs, and leaves branch, ledger, and status byte-identical | REQ-A6 | T-A9 (integ) |
| **AC-A10** | A missing remote / absent upstream returns success as a no-op | REQ-A6 | T-A10 (integ) |
| **AC-A11** | Dirty worktree and zero-commit return each refuse `CONFLICT` with no ledger write | REQ-A7 | T-A11 (integ, 2 cases) |
| **AC-A12** | A ledger-tx failure rolls back fully, returns `503`, leaves the run `HumanWorking`, and a retry replays cleanly | REQ-A7 | T-A12 (integ) |
| **AC-A13** | After return, the claim anchor's prior `passed` gates are `stale` — the claim row does not shield them | REQ-A8 | T-A13 (integ, Feature-A shape) |
| **AC-A14** | The same holds for the M11b takeover shape; the observed result is recorded in ADR-159 either way | REQ-A8 | T-A14 (integ, M11b shape) |
| **AC-A15** | Release returns the run to `Review`, closes the claim row, and frees the slot | REQ-A9 | T-A15 (integ) |
| **AC-A16** | Claim and return each write exactly one `domain_events` row with the right kind/actor/payload; rolling the tx back leaves none; a refused claim writes none; the CHECK rejects an unknown kind | REQ-A10 | T-A16 (integ, 4 cases) |
| **AC-A17** | A return committed with no runner dispatch is picked up by `runTakeoverReturnRecoverySweep` | REQ-A11 | T-A17 (integ) |
| **AC-A18** | Promote and sync each refuse while `HumanWorking`, and a claim refuses while either holds — both directions | REQ-A1, REQ-A5 | T-A18 (integ, matrix) |
| **AC-A19** | End-to-end: `Review` → claim → return → staled gates rerun → fresh review | all A | T-A19 (e2e) |
| **AC-B1** | Each REQ-B1 term refuses `PRECONDITION`; `cli`/`check` names the deferral | REQ-B1 | T-B1 (unit) |
| **AC-B2** | `EXECUTOR_UNAVAILABLE` checkpoint returns `503` with the run still `Running`, no HITL row, and no orphan `needs-input.json` | REQ-B2 | T-B2 (integ) |
| **AC-B3** | A park-tx failure converges on the same parked state via the runner's own `STEP_CHECKPOINTED` path | REQ-B2, REQ-B3 | T-B3 (integ) |
| **AC-B4** | A machine/agent token is refused at the chokepoint before any mutation | REQ-B4 | T-B4 (unit) |
| **AC-B5** | The option set is server-derived; `restart_from` targets come from the ledger; a target with no prior attempt refuses | REQ-B5, REQ-B6 | T-B5 (unit) |
| **AC-B6** | `restart_node` closes the attempt `Reworked`/`operator_interrupt`, appends a fresh attempt, and the correction appears in the new `resolved_prompt` but not in the following attempt | REQ-B7, REQ-B8 | T-B6 (integ) |
| **AC-B7** | A missing `checkpoint_ref` degrades to `keep` with a WARN; re-deciding re-applies idempotently | REQ-B7 | T-B7 (integ) |
| **AC-B8** | `restart_from` an earlier node stales downstream and appends a fresh attempt at the target | REQ-B7 | T-B8 (integ) |
| **AC-B9** | `resume` preserves context via `session/resume`; the already-delivered retry re-drives the resume | REQ-B5 | T-B9 (integ) |
| **AC-B10** | N operator restarts do not advance the rework epoch; a genuine rework still exhausts at `maxLoops + 1`; the safety cap refuses at N+1 | REQ-B9 | T-B10 (unit) |
| **AC-B11** | A run with only operator restarts has `correctionRate == 0`; a mixed run counts only genuine reworks | REQ-B10 | T-B11 (unit) |
| **AC-B12** | A `node_interrupt` park idles to `NeedsInputIdle`, is 24 h-abandoned, and is never classified `Crashed` | REQ-B11 | T-B12 (integ) |
| **AC-B13** | End-to-end: running node → interrupt → four options → restart with a correction → node re-runs | all B | T-B13 (e2e) |

## Non-goals (this change)

- Operator-selected re-entry node; merge or AI conflict resolution on ingest (a later
  enhancement may route conflicts through the ADR-141 resolver).
- Forward node skips; multi-node batch restarts; interrupting gate **command** executions
  mid-command.
- `run_kind ∈ {agent, scratch}` for Feature A — agent runs carry no `node_attempts`, so there
  is no anchor, no re-entry, and no traversal to resume.
- `Done` runs (the ADR-141 reopen path is unchanged); per-run flow-manifest editing.
- A Flow Studio editor for `reentry` (round-trip preservation only).
- Any ext-API / MCP surface for `node_interrupt`; any new `runs.status` value, `node_attempts`
  status enum value, or adapter fork.

## Linked artifacts

- Plan: [`../plans/claude-flow-runs-continuation-controls-527f4c.md`](../plans/claude-flow-runs-continuation-controls-527f4c.md)
- ADRs: ADR-159 (Feature A), ADR-160 (Feature B) in [`docs/decisions.md`](../../docs/decisions.md)
- Analytics: [`docs/system-analytics/run-continuation.md`](../../docs/system-analytics/run-continuation.md),
  [`runs.md`](../../docs/system-analytics/runs.md),
  [`manual-takeover.md`](../../docs/system-analytics/manual-takeover.md),
  [`hitl.md`](../../docs/system-analytics/hitl.md),
  [`workbench-lifecycle.md`](../../docs/system-analytics/workbench-lifecycle.md),
  [`flow-graph.md`](../../docs/system-analytics/flow-graph.md),
  [`domain-events.md`](../../docs/system-analytics/domain-events.md)
- API: [`docs/api/web.openapi.yaml`](../../docs/api/web.openapi.yaml),
  [`web-runs.asyncapi.yaml`](../../docs/api/async/web-runs.asyncapi.yaml),
  [`outbound-webhooks.asyncapi.yaml`](../../docs/api/async/outbound-webhooks.asyncapi.yaml)
- ERD: [`docs/db/domain-events.md`](../../docs/db/domain-events.md),
  [`docs/db/runs-domain.md`](../../docs/db/runs-domain.md),
  [`docs/database-schema.md`](../../docs/database-schema.md)
- DSL: [`docs/flow-dsl.md`](../../docs/flow-dsl.md), `web/lib/config.schema.ts`,
  `web/lib/flows/flow-dsl-grammar.ts`
- Precedents: [ADR-030](../../docs/decisions.md) manual takeover,
  [ADR-141](../../docs/decisions.md) branch sync, ADR-108 `hook_trip`, ADR-086 domain events
