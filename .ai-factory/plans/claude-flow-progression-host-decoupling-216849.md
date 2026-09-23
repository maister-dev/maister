# Implementation Plan: Flow progression decoupled from the host event stream (D4: P1-6 + P2-1)

Branch: `claude/flow-progression-host-decoupling-216849` (worktree HEAD = `ae99f9d0` = master)
Created: 2026-09-23

## Settings

- Testing: **yes**. Tests are written RED first. Correctness REDs run against the real Postgres + real supervisor (`startRealSupervisor`). Fakes are used only where the request allows them (fixture tampering, the pruned-span shape).
- Logging: **standard, plus one DEBUG line on the feed-selection branch** (owner Q5). The contract is the named log lines in each task, at INFO/WARN/ERROR, and every new yield or settlement logs exactly once per occurrence. The only DEBUG line is `prompt-evidence-feed-selected`, emitted once per D-B5 claim (≤ 1 per 5 s per command) and never from the 4 Hz wait loop.
- Docs: **yes**. The docs checkpoint is mandatory. Phase 0 is SDD: the amendments, the analytics and the OpenAPI are written and gate-clean before any code (skill-context rule "front-load a complete, internally consistent analytics/design spec").

## Roadmap Linkage

Milestone: "none"
Rationale: this is item D4 (P1-6 + P2-1) of the execution-seam stabilization ledger, not a `ROADMAP.md` milestone. It is the same linkage as P0-2…P0-7.

## Numbering

- **No new ADR.** This follows owner decision 3 (2026-09-23). The plan writes dated `**Amendments:**` bullets in `docs/decisions/adr-167.md` and `docs/decisions/adr-177.md`. It updates the hub stub `**Status:**` in `docs/decisions.md` (1709-1716, 1794-1806) and the matching index rows (211, 221). The ADR-index gate (`scripts/validate-docs-adr-anchors.mjs`, `checkAdrIndexRows`) exempts row status. An amendment adds no row.
- **One migration: `0176_prompt_settled_from`.** Owner decision Q1, 2026-09-23, amends the lock "No migration". `0175` is taken by the retirement-tombstone fix (branch `claude/retirement-tombstone-guards`, migration `0175_retirement_tombstone_guards`), so this plan uses the next number; re-derive it from `max(_journal.json)` on master at implementation time. The migration is a triad: SQL + `_journal.json` entry + `meta/0176_snapshot.json`. `schema.ts` is the fourth leg, and `drizzle-kit generate` must then report "No schema changes". **Renumber risk:** P0-4 and P0-5 run in parallel and may also claim `0176`. Before merge, rebase onto master and re-derive the number; if it moved, run a renumber pass over the SQL name, the journal tag, the snapshot and every prose mention.
  - Column `execution_commands.settled_from text NULL`.
  - `CHECK execution_commands_settled_from_check (settled_from IS NULL OR (settled_from IN ('canonical','host_span') AND terminal_evidence_sha256 IS NOT NULL))`.
  - Partial index `execution_commands_host_span_settled_idx ON (execution_host_id, completed_at) WHERE settled_from = 'host_span'`, for the per-host counts.
  - **Re-creates the two 0141 guards** (C19):
    - DROP + re-ADD `execution_commands_terminal_evidence_check` as `terminal_evidence_sha256 IS NULL OR (terminal_evidence_sha256 ~ '^[a-f0-9]{64}$' AND receipt_evidence IS NOT NULL AND (terminal_event_id IS NOT NULL OR settled_from = 'host_span'))`.
    - `CREATE OR REPLACE FUNCTION guard_prompt_terminal_evidence()`: adds `OR (OLD.settled_from IS NOT NULL AND NEW.settled_from IS DISTINCT FROM OLD.settled_from)`. Every other clause is kept verbatim.
    - `DROP TRIGGER` / `CREATE TRIGGER execution_commands_immutable_terminal_evidence`: `settled_from` is added to the `BEFORE UPDATE OF` column list.
    - The trigger and the function are hand-written SQL that the drizzle snapshot does not carry. They are appended to the generated SQL, and the CHECK text in `schema.ts` must match the SQL byte for byte.
    - These DROP/ADD statements target a shared table. At rebase the text is re-derived from `schema.ts` and from the newest migration that touched these objects (skill-context rule).
    - **Re-derive from `0175`, not from `0141`:** `0175_retirement_tombstone_guards` already re-created `execution_commands_terminal_evidence_check` (adding `OR retired_at IS NOT NULL` for the receipt), `execution_commands_request_v2_check`, `guard_prompt_terminal_evidence()` (the retirement-transition exemption and the settled-tombstone-final clause) and `guard_immutable_command_request()`. This plan's CHECK becomes `terminal_evidence_sha256 IS NULL OR (sha ~ regex AND (terminal_event_id IS NOT NULL OR settled_from = 'host_span') AND (receipt_evidence IS NOT NULL OR retired_at IS NOT NULL))`. Its trigger change adds the `settled_from` clause to the `0175` function body verbatim. A host_span row that is later retired keeps `settled_from`.
  - **No backfill:** NULL means "settled before this change / unknown". The constraint accepts that.
  - Live data is not touched: nothing is dropped and nothing is re-keyed.
- The `created` state needs no schema change. It already exists in the `run_session_incarnations.state` enum and is covered by the partial unique index `run_session_incarnations_active_run_session_uq` (0131).
- **No new env var**, config path, port or sidecar. The deployment-touchpoint rule therefore produces no compose task. The span page bound reuses the existing 500-row / 1 MiB replay constants.

---

## Ground truth: corrections and additions to the request

The request was re-verified on `ae99f9d0`. Its core claims hold. **The findings below change the work.** C1–C18 come from `/aif-plan`. C19–C27 were added by `/aif-improve` on 2026-09-23; several of them block the first draft. Implementers must not re-derive them.

### Admission (Scope A)

**C1. `state = 'active'` is required at 11 sites, not only in the wait.** If only `waitForPromptIncarnation` is widened, a prompt admitted on `created` is refused one call later, inside `issueOwnedPrompt`. The sites:

| # | Site | Refusal on `created` today |
|---|---|---|
| 1 | `web/lib/execution-host/prompt-incarnation.ts:50` | admits only `active` |
| 2 | `web/lib/execution-host/ledger.ts:334` (every owned prompt) | `ownedPromptConflict("inactive_incarnation")` |
| 3 | `web/lib/flows/graph/node-prompt-owner.ts:125` | `node_admission_incarnation` → CONFLICT → `markNodeFailed` (CONFLICT is not retryable) |
| 4 | `web/lib/flows/graph/prompt-owner.ts:297` (gate) | `gate_admission_incarnation` |
| 5 | `web/lib/flows/graph/consensus/prompt-owner.ts:227` | `consensus_admission_incarnation` |
| 6 | `web/lib/services/gate-chat-prompt-owner.ts:126` | `gate_chat_admission_incarnation` → `failGateChatTurn` |
| 7 | `web/lib/runs/sync-prompt-owner.ts:123` | `sync_admission_incarnation` → `failResolver` |
| 8 | `web/lib/scratch-runs/prompt-owner.ts:162` | `scratch_admission_incarnation` → `markScratchCrashed` |
| 9 | `web/lib/agents/prompt-owner.ts:135` (`lockAgentPromptSession`) | `agent_initial_admission_session` |
| 10 | `web/lib/agents/launch.ts:2997` (live-session lookup) | falls through to a **second** owned `session.create` |
| 11 | `web/lib/agents/turn-claim.ts:201` | `defer("session_projection")` |

`web/lib/agents/prompt-owner.ts:410,429` already accept `created | active`. That is precedent for the widening. The resume-driver (`web/lib/runs/resume-driver.ts:605`), gate-chat and sync paths admit **without** waiting. For them the ACK-authored row is the fix, not the wait.

**C2. `applyCreateAck` is the single choke point for all four binding writers.** The callers are the live ACK (`client.ts:458`), the owned-create replay (`owned-session-create.ts:267`), the W2 receipt fold (`recovery.ts:219`) and the lifecycle projector itself (`lifecycle-projector.ts:100`). One insert inside `applyCreateAck` covers all four. It reuses the incarnation lookup, the `.for("update")` lock and the stale check the function already performs (`create-ack.ts:75-95`), and it runs under `lockCurrentSessionAssignment` (the AT-08 fence).

**C3. The "stale `session.created` → `lost`" edge is narrower than the request states.**
- `projectLifecycle` skips every event whose assignment is not current (`lifecycle-projector.ts`, `currentCanonicalAssignment`).
- The `lost` branch is therefore reachable only for a **current**-assignment event whose inner `applyCreateAck` returns `stale`, for example a creator command that is no longer current.
- A `created` row of a superseded assignment is retired by `retireSupersededSessionIncarnations` when the successor binds (`session-binding.ts:116-135`).
- A released assignment with no successor leaves its row in `created`. Today it leaves the row in `active` in the same way. This residual is not new: the partial unique index is per `run_session_id`, and the next bind retires the row first.
- The ACK carries no `hostBootId`, so activation fills it from the event.

**C4. After Scope A the admission timeout is practically unreachable on the three awaiting paths.** `createSession` / `createOwnedSession` return only after the ACK transaction commits (`immediate(… onAck)`, `owned-session-create.ts:281-293`), and that transaction now holds the `created` row. The wait stays as a fence check and its timeout becomes a typed yield (locked). The REDs for the yield (A2) must therefore **force** the window, with a fixture that deletes the `created` row after the ACK. The wait's refusal of any *other* state stays `staleSessionBinding`.

**C5. The flow timeout today also deletes the live host session.**
- `runner-agent.ts:1769-1821` converts only `SessionCreatePending`. Everything else re-throws. The `finally` block at `:1811` calls `client.deleteSession` whenever `continuationPending` is false.
- `EXECUTOR_UNAVAILABLE` is auto-retryable (`RETRYABLE_ERROR_CODES`, `config.schema.ts:318-323`), so the outcome today is: session deleted, then `markNodeFailed` (`runner-graph.ts:3573`), then a new attempt or escalation or a Failed run.
- The yield must set `continuationPending` **before** the `finally` runs.
- Re-drive is already guaranteed. The continuation worker's `session.create` arm has **no state filter** (`continuation-worker.ts:150-152`), and the Running-attempt arm (`:179-185`) also matches. `runGraph` reuses the Running attempt (`runner-graph.ts:2883-2893`), and `createOwnedSession` re-applies the succeeded ACK.
- There is no per-run backoff. Each re-drive holds the driver claim for the full wait (≈60 s), so the loop is wait-bounded, not a spin.
- **Defect to fix:** `recordDispatchedPrompt` (`runner-agent.ts:1273`) runs before the wait. Each re-drive would append another transcript row.

**C6. On the agent path only one caller fails the run.**
- `startConsensusRunnerDraftSession` (`launch.ts:2144-2228`) calls `finalizeAgentRun(Failed)` for everything except fenced errors.
- `startAgentSession` already leaves the run `Running` with the turn `claimed` (`launch.ts:2944-2988`, `3434-3474`).
- The agent continuation worker re-selects `claimed` turns (`agents/continuation-worker.ts:108-128`). Each pass is bounded by a 5 s abort (`:66-69`), and an aborted pass continues without waiting (`:214-215`). The cadence is therefore 5 s, not 4 Hz. It needs a test pin, not new code.
- **Pre-existing:** a turn deferred on `session_projection` for a still-`Running` run has no re-driver until the run parks (`agents/park.ts:30-38`). Widening site 11 to `created` shrinks that window to "message claimed before the launch ACK committed", but the window stays open. It is the same coupling (the reason is literally named after projection), so owner decision Q3 puts it **in scope**: D-A6 and T1.5, RED first. Whether the turn is merely delayed or can be orphaned by a non-persistent finalize is not verified yet. The RED establishes which.

**C7. Scratch has no re-drive for a turn that never issued a prompt.**
- On `EXECUTOR_UNAVAILABLE`, the local-package launch (`scratch-runs/service.ts:1841-1876`) and the recover route (`app/api/scratch-runs/[runId]/recover/route.ts:539-561`) call `markScratchCrashed`.
- `ScratchPromptContinuationPending` falls into the crash branch in every caller.
- Within this item, "stop the failure" means: the typed admission yield maps to `markScratchPromptRetryable` in **all five** callers. The persisted user message stays, the dialog becomes `WaitingForUser`, and the run stays `Running`.
- Automatic re-drive belongs to A4.

### Completion (Scope B)

**C8. The receipt names the canonical row directly.**
- v2 `terminal.eventId` is the host envelope `eventId`, and ingest uses that value as `execution_events.id` (`events/ingest.ts:860`). The reducer already requires `receiptEvidence.eventId === event.id`.
- B.4 therefore looks the event up **by id**, not by `(streamRowId, hostSequence)`. The looked-up row must be `source='host'` with `ingestDisposition='accepted'`.

**C9. A host-span settlement leaves `terminalEventId` NULL, and confirmation works without new code.**
- `execution_commands.terminal_event_id` is a foreign key to `execution_events`. A not-yet-ingested event cannot be bound.
- The v2 digest is computed from receipt fields only (`prompt-evidence.ts`, `reducePromptEvidence` digest input). It does not include the manager row id, so the later canonical `recordPromptEvent` binds the id, recomputes the **same** digest and settles idempotently.
- `quarantine()` already keeps `applicationState='applied'` when `completionAppliedAt` is set. That is exactly the locked post-hoc semantics. Before application it poisons, which is the existing rule and unchanged.
- The projector's `recordPromptEvent` path quarantines without throwing, so the projection cursor advances. A conflict never holds the stream (CLAUDE.md §2).

**C10. The span must include `acceptedSequence`.** `readPromptOutput` verifies the accepted row itself (`prompt-output.ts:325-346`). The read range is therefore `[acceptedSequence, terminalSequence]`, that is `after = acceptedSequence − 1`, not `(accepted, terminal]`.

**C11. A `sourceCommandId` filter on the host route would weaken verification.**
- The host stream is shared, so runs Y and Z interleave inside run X's span. The canonical check walks **every** row for contiguity (`event_span_gap`) and refuses a same-session `session.*` row that lacks this command's binding (`source_command_binding`, `prompt-output.ts:178-190`).
- A host-side filter would hide both failure classes. The route therefore returns every retained envelope in the range, exactly as the SSE replay does, and takes **no** `sourceCommandId`. This is a deliberate deviation from the request's route signature (owner Q2, 2026-09-23).

**C12. "Pruned" means "already ACKed by ingest".**
- The host protects the span of an accepted v2 command until its terminal event is ACKed. After that it keeps the rows for a further grace period, 24 h by default (`MAISTER_EVENT_ACK_GRACE_MS`) (`supervisor/src/host-state.ts:1946-2035`).
- A host restart keeps the stream and its rows (`host-state.ts:2110-2141`). Only a wiped state directory yields a new stream.
- The typed `unavailable` answer is therefore the pruned-after-ACK or identity-change case. The fallback is the canonical feed.

**C13. Supervisor GET routes are unauthenticated.** The OpenAPI declares `security: []` (`docs/api/supervisor.openapi.yaml:72`), and `GET /runtime-events` returns every envelope. The new route exposes nothing the SSE does not. Browser code cannot reach it, because only `lib/execution-host/**` may import `supervisor-client` (ESLint fence).

**C14. `settled_from` has no safe home "in the existing evidence JSON".**
- `receiptEvidence` is compared whole with `sameJson` at deposit (`receipt_replacement`) and in `receiptMatches`. `result` is compared with the event outcome. `applicationError` is the quarantine carrier. Any of them would break an existing agreement check.
- A marker derived from timestamps was rejected. Ingest captures `now` before its transaction, so a host-span settlement that commits inside an in-flight ingest transaction gets `received_at < completed_at` and would be misclassified as canonical. That is exactly the near-zero-lag case the counter exists to see.
- **Resolution (owner Q1):** a dedicated column `settled_from` (migration `0176`, see Numbering), written **only** by the reducer (D-B7a).

**C15. The watchdog has no command lookup, and the ADR-177 probe already exists as a function.**
- The probe is `loadPromptEvidence` / `needsReceiptProbe` / `probeReceipt` in `web/lib/reconcile-evidence-db.ts:95-198`. A `completed` probe classifies as `pending_ingest` (`reconcile-evidence.ts:89-143`).
- `reconcile.ts:243-248` is only the doc comment.
- The watchdog candidates are the up to 50 oldest `Running` flow runs (`keepalive-sweeper.ts:541-565`). The kill happens at `:643-797`.

### Observability and docs

**C16. The admin command counts are global.** `lag-read-model.ts:374-390` has no host grouping. The per-host host-span and post-hoc-conflict counts are new queries.

**C17. Several doc anchors in the request do not exist.**

| Request says | Actual state | What this plan does |
|---|---|---|
| `error-taxonomy.md` lists `prompt_incarnation_pending` as a run outcome | The `EXECUTOR_UNAVAILABLE` row (`:52`) does not mention it | Adds a sentence that `prompt_incarnation_pending` is a driver yield, never a terminal run cause |
| `execution-event-plane.md` has "projection is the only writer" | No such sentence exists | Amends the prompt-settlement statement near EVT-01 (`:479`) and the writers paragraph (`:382-390`) |
| `stage-ab-stabilization.md` has "Timeout remains a typed refusal" | That wording lives only in `execution-prompt-lifecycle.md:79-85` | Amends the stabilization plan's D1 evidence table row and its "one reconciliation reducer" paragraph (§D1, from `:319`) |
| An incarnation state machine exists | `execution-prompt-lifecycle.md:98-112` is the **command** machine | Adds a new incarnation state machine |

**C18. The lifecycle-doc anchors on `ae99f9d0`:**

| Anchor | Lines |
|---|---|
| Admission / wait paragraph | 79-85 |
| Command state machine | 98-112 |
| "Receipt-first and event-first … until both agree" | 145 (paragraph 141-150) |
| Evidence table, receipt-first row | 224 (table 220-227) |
| "one reconciliation reducer" | 228 |
| ADR-177 outcome table | 295-318 |
| ADR-167 D5 | `docs/decisions/adr-167.md:79-88` |
| ADR-177 D1 classification table | `adr-177.md:70-80` |
| ADR-177 D2 decision table | `adr-177.md:115-130` |
| ADR-177 Amendments | `adr-177.md:352-355` |
| Reconciliation-gc evidence classes | `reconciliation-gc.md:746-777` |

### Added by `/aif-improve` (2026-09-23)

**C19. Migration 0141 makes the host-span row shape impossible.** Three guards stand in the way (`web/lib/db/migrations/0141_prompt_terminal_evidence.sql`):
- The CHECK `execution_commands_terminal_evidence_check` requires `terminal_event_id IS NOT NULL` whenever `terminal_evidence_sha256` is set.
- `terminal_event_id` is a non-deferrable FK to `execution_events.id`.
- The trigger `guard_prompt_terminal_evidence` makes `receipt_evidence` and `terminal_event_id` immutable once set, and makes `(digest, state, result, last_error, completed_at)` immutable once the digest is set. Setting `terminal_event_id` from NULL is allowed.

The confirming re-reduce keeps all five frozen columns equal (`completedAt: command.completedAt ?? now`), so confirmation passes the trigger. Migration `0176` therefore amends the CHECK and the trigger (see Numbering).

**C20. Scope A as drafted breaks every multi-node flow under lag.**
- **Same session on the same epoch.** One `runGraph` pass binds the execution once (`runner-graph.ts:2231-2244`, no placement mint). Every node's session is named `node.session ?? "default"` (`:2979`). Auto-retry (`:3580-3592`), in-pass rework (`:3960-4019`), gate re-visits (`gate-${id}`, `gates-exec.ts:346`) and `sessionFallback` replacements (`owned-session-create.ts:148-178`) all create **the same session name on the same assignment epoch**.
- **Nothing ends the old incarnation early.** `session.delete` has no `onAck` (`client.ts:750-765`), and `retireSupersededSessionIncarnations` retires only `lt(assignmentEpoch)` rows. The previous node's incarnation stays `active` until the lifecycle projector processes its `session.exited`.
- **Consequence.** An ACK-authored `created` insert for node N+1 while node N's row is still `active` violates `run_session_incarnations_active_run_session_uq`, and the create-ACK transaction fails.
- **Latent today.** The projector can hit the same conflict when a best-effort delete fails (`runner-agent.ts:1811-1820`) and the old session never exits.
- **Fix:** D-A1a.

**C21. The flow runner decides the node outcome from its live consumer, and host-span advance would blind it.**
- After application the runner aborts its canonical session consumer (`runner-agent.ts:1614-1616`). It then reads the signals that consumer observed from `execution_events`: `consumer.hookTripEscalated()`, `hookTripEscalateFailed()`, `permissionPersistFailure()` and `checkpointReasonObserved()` (`:1661-1700`).
- The consumer reacts to `session.hook_trip` (halting escalation, ADR-108), `session.permission_request`, and `session.exited` / `session.crashed` with a checkpoint reason (`:738-880`).
- If a turn advances from host evidence before those events are ingested, a halting guardrail trip or a permission-persistence failure is never observed and the node advances. **That is a safety regression.**
- **Fix:** D-B8. A fast feed settles only a signal-free span.

**C22. Adapters that treat a missing terminal event as proof.**

| Adapter / helper | Behaviour when `terminal_event_id` is NULL today | Class |
|---|---|---|
| `findAgentPromptHalt` (`agents/agent-pause-source.ts:117-170`, returns null at `:121`) | a guardrail halt is not detected; the turn finalizes normally | **fail-open** |
| `permissionCheckpointOrder` (`execution-host/permission-handoff-evidence.ts:210`) | `unproven` → `PromptOwnerInvariantError` → immediate poison (`prompt-owner-application.ts:276-278`) | false poison |
| scratch owner (`scratch-runs/prompt-owner.ts:256-282`) | defers until `terminalEventId` is set and the transcript cursor passes it | intentional deferral |
| agent / consensus-draft owner `lockAgentOwner` (`agents/prompt-owner.ts:400-414`) | defers (`agent_session_teardown_pending`) until the lifecycle projector writes `exited`/`crashed` | intentional deferral |
| flow node, gate, consensus verifier/synthesis, sync, gate-chat | no projector or ingest dependency (the node reads only `session.update` agent text) | — |

- **Fix:** D-B9. It hardens the first two rows and documents the last three as the "earliest application point" table.
- D4 therefore speeds up the flow, sync and gate-chat owners. Scratch and agent turns still apply after projection, **by design**: they defer, they do not fail.
- None of the adapters writes an `execution_events.id` or a `run_messages` row. The only FK written from settlement is `execution_commands.terminal_event_id` (C19).

**C23. Transcript order.**
- `recordDispatchedPrompt` anchors the prompt row at the run's highest **ingested** `run_sequence` (`flows/graph/prompt-record.ts:112-126`, `:201-210`, EDGE-TRC-08).
- Under host-span advance, node N+1's prompt is anchored below node N's reply events, because those are ingested later with higher sequences. The transcript would show prompt N+1 before reply N.
- `run_messages` has no immutability trigger, and the transcript projector already updates `supervisor_event_id` (`transcript-projector.ts:195,206`).
- Readers order by `coalesce(supervisor_event_id,'0')::bigint` (`ext-activity/service.ts:231`, `run-transcript/coalesce.ts`). `ext-activity` also exposes the value as `lastMutationId` (`:243,259`).
- **Fix:** D-B10.

**C24. Watchdog variants.**
- `loadPromptEvidence` filters `owner_ref->>'variant' = 'node'` (`reconcile-evidence-db.ts:114`).
- A node attempt stays `Running` after its node prompt is applied: `actionCompletion` is set, not the status (`node-prompt-owner.ts:246-249`). `runNodeGates` then issues `gate_skill` / `gate_ai` prompts on the same attempt (`runner-graph.ts:4043`, `gates-exec.ts:519-526`).
- `permission_resume` commands are also invisible to that lookup.
- The draft D-C1 would read "applied" during a long gate prompt and never kill it.
- The v2 receipt of a running turn is `accepted`, and `probeReceipt` answers `indeterminate`, not `inflight` (`reconcile-evidence-db.ts:157-198`). The "genuinely running" control in C1 must therefore use `indeterminate`.
- **Fix:** D-C1 is rewritten.

**C25. The dispatched-prompt record is already idempotent.**
- `run_messages_prompt_dispatch_key_uq` (`0170`, `NULLS NOT DISTINCT`) is keyed `(run_id, node_attempt_id, prompt_dispatch_key)`, with `onConflictDoNothing` (`run-message-store.ts:109-170`). A re-drive of the same owner and ordinal writes nothing.
- The draft's "move the wait before the record" option is impossible: the record (`runner-agent.ts:1273`) precedes the session create (`:1405`), and the wait needs the created session (`:1491`).

**C26. `next_attempt_at` collisions for the D-B5 claim.**
- The existing receipt claim requires `receipt_evidence IS NULL` (`prompt-reconciliation.ts:72-86`). Its release writes `now + 5 s` onto the row **after** depositing the receipt (`:116-130`).
- `recordUnknownPromptAdmission` (`commands.ts:176-199`) can overwrite the column with no receipt guard.
- `queryPrompt` returns the column as `nextReconcileAt` (`deliverer.ts:852`).
- No other claimant exists for rows that have `receipt_evidence`.

**C27. Test infrastructure.**
- The fake host ingests synchronously: its event sink calls `ingestRuntimeEvent` and then the transcript, prompt, lifecycle and runtime-object projectors (`test-support/fake-execution-host.ts:2458-2476`). Its `streamRuntimeEvents` yields nothing (`:1060-1063`). It **cannot** hold ingest today.
- Existing hold mechanisms:
  - `startSupervisorFaultProxy(...).arm(selector, "hold-events")` holds the real supervisor's SSE (`test-support/supervisor-fault-proxy.ts:33-40,445-475`; used in `execution-ab-partitions.integration.test.ts:333`).
  - `claimNextExecutionProjection` holds one projector, with a manual release `UPDATE` (`projection-worker.integration.test.ts:371-387`).
  - `claimRuntimeEventStream` holds the stream lease (`event-claim-lock.integration.test.ts:138`).
  - `holdDatabaseWrite` (`test-support/fault-barriers.ts:23`).
- `host-parity.integration.test.ts` covers create, adopt, fence, checkpoint, cancel and input only (`:165-390`). It has no prompt or runtime-event rows.

---

## Decisions (frozen by Phase 0)

**D-A1. ACK-authored incarnation.** `applyCreateAck`, after its existing checks and inside its transaction:
- If no incarnation exists for `(executionHostId, hostSessionId)`, it inserts one with:
  - `state: 'created'`, `origin: 'native'`
  - `runSessionId`: the locked or just-inserted logical row
  - `runId`
  - `executionAssignmentId` / `assignmentEpoch`: from the **locked** assignment
  - `executionHostId`
  - `hostSessionId` / `acpSessionId`: from the result
  - `hostBootId: null`, `activatedAt: null`
- It inserts nothing on any `stale` return. AT-08 is unchanged.
- If an incarnation exists in `created | active` with matching identity, the call is idempotent and inserts nothing.
- Lock order is unchanged: run → assignment → logical session → incarnation.

**D-A1a. Same-epoch supersession (C20).**
- `retireSupersededSessionIncarnations(tx, {runSessionId, assignmentEpoch, hostSessionId})` retires every row of the run session in `created | active | checkpointed` where `assignmentEpoch < epoch` **or** `hostSessionId <> the newly bound hostSessionId`.
  - Rows are set to `state='lost'` and `endedAt=now`.
  - `terminalReason` is `{reason:'assignment_superseded'}` for a lower epoch, or `{reason:'session_superseded'}` for the same epoch with a different host session.
- It runs in the same `applyCreateAck` transaction, **before** the D-A1 insert. This restores the partial-unique invariant by construction.
- Meaning: the binding moved, so the old row lost binding authority. That is the same meaning the function's docblock already states. The old ACP handle and the terminal evidence are retained.
- The projector path (`projectCreated` → `applyCreateAck`) inherits the change. This also closes the latent failed-delete conflict of C20.

**D-A2. Projector activation.** `projectCreated`'s existing-incarnation branch works as follows:
- For `created` with disposition `applied`: set `state='active'`, `activatedAt=event.occurredAt`, `hostBootId=event.hostBootId`, and `acpSessionId` if it is null.
- For `created` with disposition `stale`: set `state='lost'`, `endedAt`, and `terminalReason {reason:'create_owner_superseded'}`.
- For `active`: no-op, as today.
- In every case it binds the event to the row, as today.
- The insert branch is unchanged, and it can no longer run for an applied disposition, because `applyCreateAck` inserted the row.
- **`projectTerminal` transition allow-list**, a `satisfies Record<state, readonly state[]>` map:

  | From | Allowed | Otherwise |
  |---|---|---|
  | `created`, `active` | `exited`, `crashed`, `checkpointed` | — |
  | `lost` | `exited`, `crashed` | `checkpointed` is refused: the row stays `lost`, `terminalReason` is still recorded, and it logs WARN `session-incarnation-terminal-on-superseded {incarnationId, eventType}` |
  | `checkpointed` | `exited`, `crashed` | — |

  Moving a superseded row into `checkpointed` would put it back into the partial-unique set, and the unique violation would become a permanent projection poison (CLAUDE.md §2). The event is still bound to the row. Every other terminal state is terminal.

**D-A3. One admissible-state constant.** `ADMISSIBLE_PROMPT_INCARNATION_STATES = ["created","active"] as const` lives in `session-binding.ts`. The 11 sites of C1 use `inArray(state, ADMISSIBLE…)`. It is an allow-list: `checkpointed`, `lost`, `exited`, `crashed` and `deleted` stay refused.

**D-A4. Typed admission yield.**
- `waitForPromptIncarnation` throws `PromptIncarnationPending`, a `MaisterError` subclass in `prompt-incarnation.ts`. It keeps code `EXECUTOR_UNAVAILABLE` and `details.reason: "prompt_incarnation_pending"` for wire compatibility.
- Each caller maps it to a yield:
  - **flow:** `runner-agent.ts` outer catch converts it to `FlowPromptContinuationPending`, the same pattern as `SessionCreatePending` at `:1770`. It sets `continuationPending = true` before the `finally`, so there is no `deleteSession` and no `markNodeFailed`.
  - **agent:** `startConsensusRunnerDraftSession` returns without `finalizeAgentRun` and logs WARN `agent-prompt-admission-yielded`. The paths in `startAgentSession` treat it like `SessionCreatePending`, with an explicit `instanceof`.
  - **scratch:** all five catch sites of C7 call `markScratchPromptRetryable` for `PromptIncarnationPending`.
- **Re-drive owners:** the flow continuation worker (C5) and the agent continuation worker (C6). For scratch, the user resends (A4).

**D-A5. Dispatched-prompt idempotency across a yield.** There is no code change; the property already exists (C25). A re-drive of the same attempt, owner and ordinal hits `run_messages_prompt_dispatch_key_uq` and writes nothing. RED A2 pins it: exactly one `run_messages` row per `prompt_dispatch_key` after a yield plus a re-drive. The reorder option from the first draft is withdrawn because it is impossible.

**D-B1. Two feeds, one reducer.**
- `reducePromptEvidence(tx, command, evidence)` takes `evidence: {feed:"canonical"; event: ExecutionEvent} | {feed:"host_span"; event: ExecutionEvent} | null`. It stays the only terminal writer.
- The **only** feed-dependent check is the identity bind:
  - canonical requires `command.terminalEventId === event.id`;
  - host_span requires `command.terminalEventId === null` and writes nothing to it.
- Both feeds require `receiptEvidence.eventId === event.id`. Every other check runs for both feeds, byte for byte: `eventMatches`, `receiptMatches`, stream/sequence/`sourceCommandId`, v2 terminal agreement, outcome agreement, digest and terminal state.

**D-B2. Direct terminal binding (B.4).**
- In `reconcileStoredPromptEvidence`: when `terminalEventId IS NULL` and `receiptEvidence` is terminal, it loads `execution_events` by `receiptEvidence.eventId`.
- If the row exists with `ingestDisposition='accepted'`, it prepares the content outside the transaction (`preparePromptContent`, unchanged). Inside the transaction it calls the shared `bindTerminalEvent(tx, command, event)` with the guards `event_binding`, `event_shape` and `event_replacement`. That helper is extracted from `recordPromptEvent` so both callers use one body. It then reduces with `feed:"canonical"`.
- The projector's later `recordPromptEvent` finds the id bound, reduces again and is idempotent.

**D-B3. The host range read (supervisor, additive, read-only).** `GET /runtime-events/span?streamId=<uuid>&after=<seq>&through=<seq>`.

| Identifier | Label | Rule |
|---|---|---|
| `streamId` | query parameter (untrusted) | Compared with `hostState.getRuntimeEventStreamId()`. A mismatch returns 200 `{state:"unavailable", reason:"stream_identity_changed"}` and never a lookup of a foreign stream |
| `after`, `through` | query parameters (untrusted) | Decimal sequences validated with `RuntimeEventSequenceSchema`. `after < through` is required, else 409 `PRECONDITION`/`invalid_event_span` (the supervisor maps `PRECONDITION` to 409 by code, `httpStatusForCode`). A `through` past the highest emitted sequence answers 200 `unavailable/beyond_emitted`, never a silent clamp |

Response 200 JSON:

```
{ streamId, after, through,
  state: "complete" | "partial" | "unavailable",
  reason?: "replay_floor_lost" | "stream_identity_changed" | "beyond_emitted",
  nextAfter: string | null,
  events: RuntimeEventEnvelope[] }
```

- `events` uses the same envelope schema as the SSE `data:` field.
- A page is at most 500 rows and 1 MiB, the same limits as `runtimeEventPage`. `partial` with `nextAfter` means "page again".
- `unavailable` with `replay_floor_lost` covers `after < replay_floor`, that is, pruned.
- The route never acknowledges, prunes, writes or opens SSE. It is served by a new `runtimeEventsInRange(streamId, after, through, limit)` built on the existing `runtimeEventPage` with an upper bound.
- Storage failures (`stream_corrupt`, SQLite errors) map through the existing `runtimeEventSupervisorError` (`http-api.ts:261-298`) to 503 `EXECUTOR_UNAVAILABLE`.
- The web client treats **any** non-200 response or transport error as "feed unavailable": it logs WARN `prompt-host-span-unavailable {commandId, reason}` and falls back to the canonical feed. It never fails the command.
- Two-phase-commit rule: not applicable. The route has no side effect.

**D-B4. Host-span feed (web).** Scope: the feed runs **only for a `completed` (succeeded) v2 receipt with an output manifest**. Failed and fenced receipts carry no manifest. Without the accepted sequence there is no bounded span in which to prove D-B8, so they settle canonically, as today (C21). New file `web/lib/execution-host/prompt-host-span.ts`:
- `readHostPromptSpan(db, transport, command, manifest, signal)` pages `[accepted, terminal]`.
- Every envelope goes through the **same** normalization as ingest:
  - `RuntimeEventEnvelopeSchema.parse` + `encodeJsonbSafe`, exported from `ingest.ts` as `normalizeRuntimeEnvelope`;
  - a `hostKey` match;
  - disposition classification through the **same** read-only assignment resolver, extracted from `resolveAssignment` / `isBoundHistoricalEvent` as `classifyEnvelopeDisposition(tx, hostId, envelope)` → `accepted | stale_epoch`.
- Each envelope becomes a transient `ExecutionEvent` value: `id=eventId`, `eventStreamId` = the manager stream row id (if no row exists, the feed is `unavailable`), and `payloadSha256`/`payloadBytes` computed by the ingest helpers.
- The span is then verified by the **same** iterator `prompt-output.ts` uses. `commandEvents` is refactored to take an `EventPageSource` (canonical DB pager | host-span pager), and all checks live in the one loop: `event_size`, `event_span_gap`, `terminal_identity` (against `receipt.eventId` for host_span), `source_command_binding`, `content_binding` and the object digests.
- The accepted-row check (C10) moves into the shared verifier.
- Nothing is written to `execution_events`, the streams, the watermarks or the ACK.

**D-B5. Feed selection and throttle.**
- `reconcilePromptCommand` gains one branch at `prompt-reconciliation.ts:67`: the receipt is present and terminal, there is no terminal event, and B.4 found no ingested row.
- **Claim**, reusing the column and constants: `UPDATE … SET next_attempt_at = now + RECEIPT_CLAIM_MS WHERE id = ? AND kind = 'session.prompt' AND state IN OPEN_COMMAND_STATES AND receipt_evidence IS NOT NULL AND terminal_evidence_sha256 IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now)`. The release CAS is `next_attempt_at = claimUntil`, setting `now + RECEIPT_RETRY_MS`.
- **First attempt without the 5 s delay:** when the existing receipt claim deposits a `completed` receipt, the same call runs the B.4 lookup and then the host-span attempt **before** its release write (C26). Later calls use the claim above.
- `recordUnknownPromptAdmission` can move the timestamp (C26). That only delays an attempt; it never skips one, because the next due wake re-claims.
- On a verified span, it runs the reducer with `feed:"host_span"` in one transaction under `lockPrompt`.
- On `unavailable` or a verification failure, it releases the claim and the command stays `waiting` for the canonical feed.
- A host-span verification failure is **never** a quarantine: it is not canonical evidence. It logs WARN `prompt-host-span-unverified {commandId, causeCode}`.
- `readPromptOutput` picks the canonical source when `lastContiguousSequence >= terminalSequence` and `terminalEventId` is bound. Otherwise it reads the host span. Output is hydrated only from a fully verified span. A partial iterator still never applies.

**D-B6. Race and ordering.** `lockPrompt` (`FOR UPDATE`) serializes host_span settlement, B.4 and the projector:
- **host_span wins:** the canonical path later binds `terminalEventId`, recomputes the same digest and returns `settled`. Nothing is applied twice, because application is gated by `completionAppliedAt` / `applicationState`, which the reducer never writes.
- **canonical wins:** host_span sees `terminalEvidenceSha256` set in `reconcileStoredPromptEvidence` and returns `settled` before any host I/O.
- **disagreement after application:** the existing `quarantine()` records `prompt_terminal_conflict` and keeps `applied`.
- **disagreement before application:** the command is poisoned. This is the existing rule, stated in the ADR.

**D-B7a. The `settled_from` write.** `reducePromptEvidence` sets `settled_from = evidence.feed` in the same `UPDATE` that first sets `terminal_evidence_sha256`, that is, when `command.terminalEvidenceSha256` was NULL. A confirming re-reduce, where the digest is already set, never writes the column. The first feed is recorded permanently, and the canonical confirmation of a host-span settlement leaves `host_span` in place. No other writer may touch the column. This is pinned by the CHECK above and by B4's row-set comparison, which includes `settled_from`.

**D-B8. Signal-free span rule (C21).**
- The fast feeds, B.4 (direct bind) **and** B.5 (host span), may settle a command only when its span `[acceptedSequence, terminalSequence]` contains **no** `session.hook_trip`, `session.permission_request`, `session.exited` or `session.crashed` event for the command's `hostSessionId`.
  - For B.5 the check runs over the verified host envelopes.
  - For B.4 it is one indexed count over `execution_events (event_stream_id, host_sequence)` in the span, filtered by `event_type` and `host_session_id`.
- A span that carries any of these types is left to the prompt projector, which keeps today's timing and behaviour exactly.
- The type list is one exported constant, `CONSUMER_SIGNAL_EVENT_TYPES`, next to the flow consumer (`runner-agent.ts` `startEventConsumer`). A unit test asserts that every `ev.type` branch that sets a runner signal is in the constant. That is the drift guard.
- Log line: DEBUG `prompt-evidence-feed-selected {feed:"none", reason:"span_has_signal_events"}`.

**D-B9. Absence is never proof (C22).**
- A shared helper `loadConfirmedTerminalEvent(tx, command)` lives in `prompt-evidence.ts`. It resolves `terminalEventId`. If the command is host-span-settled with no bound id, it throws `PromptOwnerDeferred("terminal_event_unconfirmed")`.
- `findAgentPromptHalt` and `permissionCheckpointOrder` switch to it. Neither may return null or `unproven` on a missing row.
- The deferral is re-driven by the prompt-owner worker's existing deferred-claim retry. Owner application becomes eligible once the canonical feed confirms.
- The three intentional deferrals in C22 are unchanged. They are documented as the per-adapter "earliest application point" table (T0.2).

**D-B10. Transcript re-anchor on confirmation (C23).**
- When the canonical feed confirms a `settled_from='host_span'` command C, its terminal event E has `runSequence = R`. In the **same** transaction as `bindTerminalEvent`, `reanchorDispatchedPrompts(tx, {runId, settledAt: C.completedAt, anchor: R})` runs. It is a new function in `run-message-store.ts`:
  - `UPDATE run_messages SET supervisor_event_id = R::text WHERE run_id = ? AND prompt_dispatch_key IS NOT NULL AND coalesce(supervisor_event_id,'0')::bigint < R AND created_at >= C.completed_at`.
- **Why it is correct:** a prompt dispatched after C settled was necessarily sent to the host after C's terminal, so its true position is at or after R. Rows dispatched before C settled are untouched. Ties still break on the dispatch key.
- **Readers re-derived:**
  - `run-transcript/coalesce.ts`: order becomes correct.
  - `ext-activity/service.ts:231,243,259`: the moved row re-surfaces once with a larger `lastMutationId`. It is a real mutation, and this is documented in the activity-API analytics.
- No re-anchor runs for B.4 or canonical settlement: their horizon already includes the reply.

**D-B11. Released-assignment settlement (EDGE-PRM-04, ADR-167 D4).**
- Host-span settlement of a command whose assignment was released (checkpoint or release won the race) behaves exactly like the canonical late event: it settles the historical ledger entry only.
- Owner application follows the existing supersession rule. It never mutates current run or session state.
- `classifyEnvelopeDisposition` answers `accepted` for that exact command through the same `isBoundHistoricalEvent`.

**D-B7. Recovery feed (B.7).**
- It applies only in the **stream-lost branch** of `resolvePromptEvidence` (`reconcile-evidence.ts:222-260`; decision at `reconcile.ts:583-588`). There, class `pending_ingest` plus probe `completed` plus a lost stream would crash `stream-lost`.
- Before crashing, the resolver (DB layer: `reconcile-evidence-db.ts`) calls `reconcilePromptCommand` once, which runs the B.4 then B.5 feeds. It then re-classifies.
  - A settled command becomes `pending_application`, `applying` or `applied` per the existing table.
  - An unreadable or unverifiable span crashes `stream-lost` as today.
- In the non-lost branch `pending_ingest` keeps its ADR-177 meaning: skip, because the named writer owes the next move. The waiting driver or the continuation worker settles through D-B5.
- Cost: one probe (existing) plus at most `ceil(span / 500)` range pages, only for stream-lost candidates with a `completed` probe. The first draft's claim of "no new host call" was wrong and is withdrawn.

**D-C1. Watchdog predicate (C.8), rewritten after C24.**
- In `runTimeLimitPass`, only for a candidate **already over its cap**, and before `liveSessionFor` / `deleteSession`: load the attempt's newest prompt across **all** `flow_node_attempt` variants.
  - Variants: `node`, `permission_resume`, `gate_skill`, `gate_ai`, `consensus_verifier`, `consensus_synthesis`.
  - Mechanism: `loadPromptEvidence(db, {runId, nodeAttemptId, variants})` gains an optional `variants` parameter. It defaults to `['node']`, so the ADR-177 behaviour is untouched and pinned by its suite. The watchdog passes the full list from `prompt-owner-contract.ts`.
- **Defer the kill only on a positive witness that the attempt's in-flight turn finished on the host:**
  - the newest command is settled (`terminal_evidence_sha256` set) with `application_state` not in `applied | superseded`; or
  - `needsReceiptProbe` holds and `probeReceipt` returns `completed`.
- Every other shape kills as today:
  - an applied newest command, where the driver sits between prompts or runs non-prompt gates;
  - probe `indeterminate` (a running v2 turn), `inflight`, `unknown`, `turn_lost` or `pending_ingest` (an ordinary rejected failure; failed turns settle canonically per D-B4);
  - no prompt at all.
- **The watchdog performs no settlement and no host call beyond the probe** (request trap). Settlement belongs to the waiting driver's D-B5 loop or, for a dead driver, to the continuation worker's Running-attempt arm (C5).
- Log INFO `time-limit-deferred-completed-turn {runId, nodeId, nodeAttemptId, commandId, witness: "settled" | "receipt_completed"}` and increment `SweepResult.deferredCompletedCount`.
- **Bound:** the deferral lasts until the canonical event arrives or ADR-177 marks the stream `lost`. With a readable span, the driver settles first; otherwise the run crashes `stream-lost`. This is the same accepted residual as ADR-177's wedged-consumer case, stated in the amendment.
- **Rationale for not measuring the completion time against the cap:** a turn that finishes seconds past the cap, before the next 60 s tick, is already settled today when there is no lag. A completed turn is therefore never killed, and killing a finished turn saves nothing.

**D-C2. Observability.**
- WARN `prompt-settled-from-host-span {commandId, runId, hostId, lagEvents, lagMs}`, logged once per settlement, inside the transaction-commit continuation:
  - `lagEvents = terminalSequence − (lastContiguousSequence ?? −1)`
  - `lagMs = now − receipt.receivedAt`
- Per-host counts from `settled_from`, using the partial index, go into `ExecutionObservabilitySummary.commands` and onto `/admin/execution-host`:
  - `hostSpanUnconfirmed`: `settled_from='host_span' AND terminal_event_id IS NULL`
  - `hostSpanSettled1h`: `settled_from='host_span' AND completed_at > now() − 1h`
  - `postHocConflicts`: `applicationError.reason='prompt_terminal_conflict' AND completion_applied_at IS NOT NULL`
- The `lagging` predicate is unchanged.
- One DEBUG line, `prompt-evidence-feed-selected {commandId, feed: canonical|host_span|none, reason}`, is emitted only when the D-B5 claim is acquired. That is at most once per 5 s per command, never per 4 Hz wake. This follows owner decision Q5.

**D-A6. Deferred agent message re-drive (owner Q3).**
- `claimAgentMessage` defers a turn with `session_projection` when the launch session is not yet admissible (`turn-claim.ts:193-206`). For a `Running` run nothing re-drives it until the run parks (C6).
- The agent continuation worker (`agents/continuation-worker.ts:76-166`) gains one arm, arm 5. All of these must hold:
  - `runs.status='Running'`;
  - a `queued` agent turn exists on the run;
  - an incarnation in `ADMISSIBLE_PROMPT_INCARNATION_STATES` exists for the run's `default` run session on the run's active assignment;
  - **and the arm mirrors every other deferral of `claimAgentMessage`** (`turn-claim.ts:109-163`), so a match is claimable:
    - `NOT EXISTS` a turn of the run in `claimed | dispatched`;
    - `NOT EXISTS` a lower-ordinal `queued` turn;
    - `NOT EXISTS` an `agent_turn` `session.prompt` of the run with `application_state IN ('pending','applying','poisoned')`.
- Without the mirror, a turn deferred on `prior_turn` would be re-selected every pass and spin. The candidate SQL fragments are extracted into one function shared with `claimAgentMessage`'s pre-checks (DRY). The claim still re-verifies everything under its locks.
- **Progress and retry bound** (skill-context "background automation"): a successful claim moves the turn to `claimed`, which removes it from arm 5 and hands it to the existing claimed-turn arm 2. Arm 5 therefore fires at most once per turn per state transition. A claim that throws follows the worker's existing degraded 1 s wait. The keyset cursor guarantees that an ineligible run never starves the one after it.
- The worker drives the turn through the **same** `claimAgentMessage` → `startAgentSession` path. It does not bypass capacity, `prior_turn` or the assignment check.
- The arm is keyset-scanned like the existing arms, and uses the existing 5 s per-pass abort and 1 s idle wait. It is a targeted loader: it matches only runs with a queued turn and an admissible session.
- Rename the defer reason to `session_not_admissible`. It no longer waits for projection. The literal is module-internal: the only hits are `turn-claim.ts:26,206`. No API route, OpenAPI, MCP tool, i18n key or DB column exposes it, because `sendAgentMessage` returns only `messageState`. The rename therefore changes no contract.

---

## Commit Plan

- **Commit 1** (T0.1–T0.4): `docs(execution): SDD for ACK-authored incarnations and host-evidence settlement (ADR-167 D5 / ADR-177 amendments)`
- **Commit 2** (T1.1–T1.6): `fix(execution-host): admit prompts on the ACK-authored incarnation; admission timeout is a yield; re-drive deferred agent messages`
- **Commit 3** (T2.0–T2.2): `fix(execution-host): record which evidence feed settled a prompt (migration 0176); bind the receipt-named terminal event directly`
- **Commit 4** (T3.1–T3.5): `feat(execution-host): settle completed turns from the host's verified event span (signal-free spans only); re-anchor dispatched prompts on confirmation`
- **Commit 5** (T4.1–T4.2): `fix(runs): recovery and the duration watchdog settle completed turns instead of killing them`
- **Commit 6** (T5.1–T5.4): `feat(admin): host-span settlement counts; docs as-built; load control`

Each commit is gated on the phase exit criteria. Merge goes to master with `--no-ff` after `/aif-verify` → `/aif-review` → codex adversarial review → fixes.

---

## Tasks

### Phase 0: SDD (no code; must be gate-clean before Phase 1)

- [x] **T0.1: ADR amendments.**
  - **`docs/decisions/adr-167.md`**, under `**Amendments:**` (create the list if it is absent), bullet `2026-09-23 — D5: host evidence is an admissible settlement authority`. It names:
    - the ACK-authored `created` incarnation (D-A1/A2) and admission on `created | active` (D-A3);
    - the admission timeout as a yield on every path (D-A4);
    - the two evidence feeds and the single reducer (D-B1);
    - direct binding (D-B2) and the host range read, including why it has no `sourceCommandId` filter (D-B3, C11);
    - the `settled_from` column (D-B7a): why a timestamp-derived marker was rejected (C14), and the Q1 amendment of the "no migration" lock;
    - the deferred-agent-message re-drive (D-A6);
    - same-epoch session supersession and the `projectTerminal` allow-list (D-A1a, D-A2);
    - the signal-free span rule and the succeeded-only scope of host-evidence settlement (D-B8, D-B4);
    - "absence is never proof" for adapter checks (D-B9);
    - the transcript re-anchor on confirmation (D-B10);
    - released-assignment settlement (D-B11);
    - the amended `0141` CHECK and trigger (C19);
    - post-hoc quarantine semantics, both before and after application (D-B6);
    - that the canonical log remains the observation authority;
    - D4 compatibility: settlement uses the host's terminal *event bytes*, never "the receipt by itself";
    - the watchdog predicate (D-C1).
  - **`docs/decisions/adr-177.md`** `**Amendments:**` gets `2026-09-23`: in the **stream-lost branch only**, a `pending_ingest` command with a `completed` probe is first offered to the host-evidence feed (D-B7). The non-lost branch still skips. The duration watchdog reuses the probe with an explicit variant list (D-C1). The D1 table row and the D2 decision row are annotated.
  - **Hub stubs** (`docs/decisions.md:1709-1716`, `1794-1806`): `**Status:** Implemented; amended 2026-09-23 (host-evidence settlement)`. Mirror it in each body file's `**Status:**`. Index rows 211 and 221 get the same abbreviated status.
  - **Acceptance:** `node scripts/validate-docs-adr-anchors.mjs` is green, and the amendment text names every item above.
  - **Logging:** none (docs).

- [x] **T0.2: `docs/system-analytics/execution-prompt-lifecycle.md` (R5 structure, Designed tags until Phase 5).**
  - Rewrite 79-85 (admission on `created | active`; the timeout is a yield, with an owner per path).
  - Add a **new** incarnation state machine:
    - `created → active` (canonical `session.created`, applied)
    - `created → lost` (current-assignment `session.created` whose ACK is stale, or retirement on successor bind)
    - `active → checkpointed | exited | crashed`
    - `created | active | checkpointed → lost` (superseded)
    - the unreachable edges it refuses.
  - Rewrite 141-150 and 145 ("either feed settles; the canonical feed confirms").
  - Table 220-227: new rows "receipt + ingested terminal (direct bind)" and "receipt + verified host span".
  - Paragraph 228: one reducer, two feeds.
  - ADR-177 table 295-318: the host-span row.
  - Add a **normative recovery-window table**: each `status × feed` cell, and who owns the next move (skill-context rule "statuses as signals").
  - Add Edge cases:
    - pruned span;
    - stream identity changed;
    - a post-hoc conflict before and after application;
    - the deferred agent message (D-A6);
    - the yield under a dead driver;
    - same-epoch supersession under lag (D-A1a);
    - a signal-bearing span (D-B8);
    - a released assignment (D-B11);
    - transcript re-anchor (D-B10).
  - **Normative rows to amend:**
    - PRM-03: "…not HTTP lifetime or a receipt alone…" becomes: the receipt **plus the host's verified terminal-event bytes** are admissible settlement evidence; the canonical event confirms.
    - EDGE-PRM-03: "owner application stops" now holds only before application; after application the quarantine is post-hoc (D-B6).
    - EDGE-PRM-04: host-span settlement of a released assignment settles the historical ledger only (D-B11).
  - **New Expectations**, each naming its enforcement point:
    - PRM-13: admission on `created | active`; the D-A3 constant; A1 and site cases.
    - PRM-14: host-evidence settlement through one reducer; the CHECK from C19; B2 and B4.
    - PRM-15: the signal-free rule; `CONSUMER_SIGNAL_EVENT_TYPES` plus its drift-guard test; B7.
    - PRM-16: the watchdog never kills a turn with a positive completed witness; C1 and C1-gate.
  - **Per-adapter "earliest application point" table**, from C22.
  - **Every Expectation names its enforcement point** (constraint, CAS, row lock, or the test id from Phases 1–4).

- [x] **T0.3: Other analytics and taxonomy.**
  - `execution-event-plane.md`: the writers paragraph 382-390 and EVT-01 at 479. Settlement has a second evidence feed that writes no event rows. Ingest contiguity, watermarks and ACK are unchanged.
  - `execution-hosts.md`: the new host route in the route inventory, with identifier labels (D-B3).
  - `docs/supervisor.md` (the runtime-event route prose at `:820` and `:1194`): the new read-only span route, its bounds, and that it never ACKs or prunes.
  - `docs/api/async/execution-host-events.asyncapi.yaml`: **no change**. The span route reuses the `RuntimeEventEnvelope` schema over HTTP. State this in the T0.4 PR note so `/aif-verify` does not flag it.
  - The transcript / activity-API analytics (the doc that owns EDGE-TRC-08, found by grep): the D-B10 re-anchor and its `lastMutationId` effect.
  - `reconciliation-gc.md:746-777`: the evidence classes gain the host-span settlement under `pending_ingest`.
  - `docs/error-taxonomy.md:52`: `prompt_incarnation_pending` is a driver yield reason, never a terminal run cause (C17).
  - `.ai-factory/plans/stage-ab-stabilization.md` §D1 (from `:319`): the evidence-table row and the "one reconciliation reducer" paragraph now cover the host-span feed (C17).
  - `docs/system-analytics/agents.md` (or the agent-turn section it links): the `session_not_admissible` defer and its re-drive arm (D-A6).
  - **ERD, both artifacts:**
    - `docs/database-schema.md` `execution_commands` row (`:123`) and its Mermaid block (`:1842`, with the CHECK list at `:1882`): add `settled_from`, the CHECK and the partial index, tagged "migration `0176`, Designed".
    - `docs/db/execution-hosts-domain.md`.
    - `docs/db/erd.dbml` is regenerated with `pnpm --filter maister-web db:erd` in T2.0, since it is generated from `schema.ts`. The `db:erd --check` gate is part of `validate:docs`.
  - **As done (2026-09-23):** the `database-schema.md` row `:123`, the `0141` column table (`settled_from` row, `terminal_event_id` note) and the Indexes table carry the `0176` column, CHECK and partial index, tagged Designed. The `execution_commands` code block at `:1842` is the `0130` column snapshot (it lists none of the `0140`/`0141` columns), so `settled_from` goes into the `0141` column table instead of that block. `agents.md` names no claim-deferral reason; the agent-turn claim section of `execution-prompt-lifecycle.md` owns it and carries the D-A6 text.

- [x] **T0.4: Contracts.**
  - `docs/api/supervisor.openapi.yaml`: add path `/runtime-events/span` next to `/runtime-events` (123-150) and reuse `RuntimeEventEnvelope` (2983). Examples: `complete`, `partial` (with `nextAfter`), `unavailable/replay_floor_lost`, `unavailable/stream_identity_changed`, and 400 `invalid_event_span`. Also document the query parameters and `security: []`.
  - Update the prose contract doc, if `docs/supervisor.md` has a route list.
  - `supervisor/src/__tests__/openapi-examples.test.ts`: parse the new examples.
  - Add a 503 `EXECUTOR_UNAVAILABLE` example (storage failure).
  - **Phase 0 exit:** `pnpm validate:contracts`, `pnpm validate:docs:all` and the ADR-anchor gate are all green on the docs-only tree. Every spec section carries an Implemented / Designed tag (R6).
  - **Deviation (2026-09-23):** `openapi-examples.test.ts` checks each example against a named supervisor Zod schema; `RuntimeEventSpanSchema` is created by T3.1, so the example assertions land with T3.1, not in the docs-only commit.

<!-- Commit checkpoint 1 -->

### Phase 1: Scope A — admission never waits for the lifecycle projector

- [x] **T1.1: RED tests A1 / A3, plus the site-widening pins.**
  - **New file** `web/lib/execution-host/__tests__/prompt-admission-incarnation.integration.test.ts` (integration project). Confirm with `pnpm --filter maister-web exec vitest list --project integration <file>`; per memory, do not use `pnpm test:integration -- <file>`. It runs against the real supervisor.
    - **Hold mechanism:** `claimNextExecutionProjection` for the lifecycle consumer, released by the manual `UPDATE` used in `projection-worker.integration.test.ts:371-387` (C27). Extract it into `test-support/projection-hold.ts` so every RED in this plan shares one helper.
    - **A1:** hold the lifecycle projector. After a real create ACK, a node prompt is admitted within one 250 ms wake, and the incarnation is `created`. Release the projector: it becomes `active` with the same id, and `hostBootId` and `activatedAt` are set.
    - **A5 (C20):** hold the lifecycle projector. Run a flow with two consecutive `ai_coding` nodes that both use session `default` on one assignment.
      - Node 2's create ACK succeeds.
      - Node 1's incarnation becomes `lost` with `session_superseded`, and node 2's is `created`.
      - Release the projector: node 1's `session.exited` moves `lost → exited`, node 2 becomes `active`, and the projection consumer is **not** poisoned (`execution_event_consumers.state`).
      - Repeat with a same-epoch `session.exited{reason:"checkpoint"}` fixture on the superseded row: it stays `lost` and the WARN is logged.
      - **Expected with D-A1 alone (falsification of D-A1a):** a unique violation on node 2's ACK.
    - **A3:** AT-08 (`deliverer.integration.test.ts:114`) stays green unchanged. Add: a delayed ACK for a superseded assignment inserts **no** incarnation. Add: a current-assignment `session.created` whose ACK is stale moves `created → lost` (one row, no unique violation), and a later prompt against it is refused `assignment_fenced`.
  - Add one parameterized case per admission path of C1 sites 3–9: with the projector held, admission succeeds. The fixture is shared through `test-support/prompt-owner-fixture.ts`. Remove that fixture's own `waitForPromptIncarnation` precondition only if it becomes redundant, and name the change.
  - **Expected on master:** A1 times out and ends as `EXECUTOR_UNAVAILABLE prompt_incarnation_pending`. The site cases fail with their `*_admission_incarnation` cause.
  - **As done (2026-09-23), deviation from the per-site cases:** seven bespoke domain seeds (sites 3–9) would re-test one predicate seven times. Coverage is instead: the node path end to end (A1, real supervisor, projector held); the agent path (`turn-admission.integration.test.ts`, the claim on a `created` row; `consensus-prompt-owners`, a yielded draft child re-driven with one `session.create` and one prompt); the scratch path (`local-package-assistant.integration.test.ts`); and the unit drift guard `admission-incarnation-sites.test.ts`, which fails if any of the 11 sites reads a literal `active` instead of `ADMISSIBLE_PROMPT_INCARNATION_STATES`. The allow-list refusal of `checkpointed` is the A3 checkpointed case. `prompt-owner-fixture.ts` keeps its `waitForPromptIncarnation` precondition: it now returns on the ACK row immediately, and it still proves the fence.

- [x] **T1.2: ACK-authored incarnation, same-epoch supersession and projector transitions (D-A1, D-A1a, D-A2).**
  - Files: `web/lib/execution-host/create-ack.ts`, `web/lib/execution-host/session-binding.ts` (`retireSupersededSessionIncarnations` signature and predicate), `web/lib/execution-host/events/lifecycle-projector.ts` (activation, and the `projectTerminal` allow-list map).
  - **Logging:**
    - INFO `create-ack-incarnation-created {runId, assignmentId, hostSessionId}` in `applyCreateAck`, once per insert. It needs a logger parameter or a module pino, matching `prompt-evidence.ts`.
    - INFO `session-incarnation-activated {runId, incarnationId}` in the projector.
    - WARN `session-incarnation-lost-on-stale-create {runId, incarnationId}`.
  - **Acceptance:** A1, A3 and A5 are green. The `recovery.ts` W2-fold test (command-recovery V1) now asserts the `created` row too.

- [x] **T1.3: Widen the 11 admission sites (D-A3).**
  - Files are the sites of C1. The constant lives in `session-binding.ts`.
  - `launch.ts:2997`: a `created` live incarnation now dispatches instead of issuing a second owned create. Assert "no second `session.create`" in the agent suite.
  - `turn-claim.ts:201`: a `created` incarnation claims.
  - **Logging:** no new lines. The existing refusal causes stay.
  - **Acceptance:** the T1.1 site cases are green, and an allow-list test proves `checkpointed` is still refused at site 2.

- [x] **T1.4: RED A2, then the typed yield on every path (D-A4, D-A5).**
  - **RED A2**, added to T1.1's file. Force the window: delete the `created` row after a real ACK, and hold the projector.
    - **Flow:** the attempt stays `Running`. There is no `markNodeFailed`, no `deleteSession`, and exactly one `recordDispatchedPrompt` row. Release the projector, which inserts the `active` row through the insert branch. The **production** continuation worker (`startFlowContinuationWorker`, as in the ADR-176 boot suites) re-drives, admits once and settles.
    - **Agent:** `startConsensusRunnerDraftSession` does not finalize `Failed`. Pin the agent worker's re-observe cadence: fewer than 3 dispatch attempts per 10 s.
    - **Scratch:** each of the five callers leaves the run `Running`, the dialog `WaitingForUser` and the message persisted. **Operator's next step** (patch 2026-09-22 15.06): with the window closed, a resend through `sendScratchUserMessage` dispatches exactly one prompt, and the dialog reaches `Running`.
    - **Flow re-drive idempotency (D-A5):** after the yield and the re-drive, `run_messages` has exactly one row for the attempt's `prompt_dispatch_key`.
    - **Expected on master:** the flow node is Failed or retried with a deleted session, the agent run is Failed, and scratch is Crashed.
  - **Files:**
    - `prompt-incarnation.ts` (the class);
    - `web/lib/flows/runner-agent.ts` (outer catch near `:1769-1821`);
    - `web/lib/agents/launch.ts` (`:2144-2228`, `:2944-2988`, `:3434-3474`);
    - `web/lib/scratch-runs/service.ts` (`:1238-1273`, `:1841-1876`, `:2221-2276`, `:2367-2415`);
    - `web/app/api/scratch-runs/[runId]/recover/route.ts:539-561`.
  - **Logging:** WARN, once per yield, for each of `flow-prompt-admission-yielded`, `agent-prompt-admission-yielded` and `scratch-prompt-admission-yielded`, with `{runId, assignmentId, hostSessionId}`.
  - **Widened (found by the agent A2 case, 2026-09-23):** `startConsensusRunnerDraftSession` also finalized a draft child `Failed` on `SessionCreatePending`. That error means another caller (the agent continuation worker, whose launch arm selects a just-launched draft child) owns the in-flight create; the child was failed while its turn was still being driven. It is reachable in production because both run in one process. The launcher now yields on it (WARN `consensus-draft-create-pending-yielded`), like `startAgentSession` already did.
  - **Widened (same case, 2026-09-23):** the worker's re-drive of a draft turn that already holds its `commandId` waited through `waitForAgentPrompt`, whose `agentPromptOwners` registry refuses the `consensus_draft` variant, so the completed draft was poisoned (`agent_variant_not_implemented`) and the consensus never resumed. `startAgentSession` now picks the waiter by variant, the same choice `dispatchStoredAgentTurn` makes. Reachable in production: the worker's claimed/dispatched-turn arm selects every running draft child.
  - **As done (2026-09-23):** the flow window is forced with a `BEFORE INSERT` trigger that drops the run's incarnation insert (equivalent to deleting the row after the ACK, and it also covers the projector's insert branch), plus `holdProjection`. The agent window uses the same trigger per draft child. The scratch window mocks only `waitForPromptIncarnation` to throw the typed yield; the persisted-message, dialog and resend assertions run against real PG.

- [x] **T1.5: RED A4, then the deferred agent message re-drive (D-A6).**
  - **RED A4**, in `web/lib/agents/__tests__/agent-session-reobserve.integration.test.ts` or a new sibling file (integration project), against the real supervisor with the production agent continuation worker:
    - Send an agent message while the launch `session.create` is still delivering. Hold the create ACK with the fault proxy (`test-support/supervisor-fault-proxy.ts`). The claim defers.
    - Release the ACK. The queued turn is claimed and dispatched without the run parking, within 2 worker passes.
    - **First, characterize master.** Record whether the turn stays queued until park, and whether a non-persistent run finalizes with the turn still queued (orphaned). Record the observed master behavior in the test's header comment. The RED asserts the fixed behavior.
  - **Loop guard:** a `Running` run with a `queued` turn behind a `dispatched` prior turn produces **zero** `claimAgentMessage` calls over 5 worker passes (spy). The arm's mirror predicate excludes it.
  - **Race:** the worker arm and a concurrent `sendAgentMessage` claim of the same turn produce exactly one `claimed` transition and one prompt command. Assert with `pg_stat_activity` that the loser is parked on the turn row lock, not merely serialized by chance (memory: "race guards need the window open").
  - **Files:** `web/lib/agents/continuation-worker.ts` (new arm), `web/lib/agents/turn-claim.ts` (reason rename; the admissible-state constant comes from T1.3), and every consumer of the reason literal (grep `session_projection`).
  - **Logging:** INFO `agent-deferred-turn-redriven {runId, turnId}`, once per re-drive.
  - **As found (characterization, 2026-09-23) — the arm is withdrawn.** `session_not_admissible` is returned only on a `launch`/`legacy_backfill` assignment whose `default` session has no admissible incarnation, i.e. while the launch turn's own create is in flight. Only a persistent agent accepts messages (`acceptAgentMessage`), and every deferral already writes `runs.resume_requested_at`; the launch turn's park (`applyPersistentAgentPark`) re-arms it from the oldest queued turn, and the continuation worker's existing `NeedsInputIdle` + `resume_requested_at` arm re-drives the message through the same `claimAgentMessage`. The turn is therefore never orphaned; it runs after the launch turn, which is the order a `prior_turn` deferral gives. A fifth arm would re-select a turn that cannot be claimed without racing the launch turn, so it is not added, and the loop-guard and racer cases (which test that arm) are not written. What ships: the rename to `session_not_admissible` and the claim test in `turn-admission.integration.test.ts` (defer with `resume_requested_at` set before the ACK; claim on the ACK-authored `created` row after it). The docs (lifecycle agent-turn section, ADR-167 bullet) state this mechanism.

- [x] **T1.6: Re-derive every reader of `run_session_incarnations.state` (patch 2026-09-22 20.35).**
  - Two meanings move in this phase: `created` rows now exist, and same-epoch rows become `lost` at the next ACK instead of at exit projection.
  - Grep every reader: `rg "runSessionIncarnations\.state|rsi\.state|run_session_incarnations.*state" web/lib web/app`. Known readers include `runs/active-run-session.ts:63`, `execution-host/runtime-object-holds.ts:169-171`, `runs/keepalive-sweeper.ts:230`, `agents/permission.ts:682`, `agents/prompt-owner.ts:410,429`, `flows/graph/prompt-session-cleanup.ts`, and the C1 sites.
  - Record a verdict table in the PR note: reader → what it means by the state → unchanged / widened / needs change, with the reason.
  - **Mandatory check:** `runtime-object-holds.ts` releases holds when a row leaves `created | active | checkpointed`. Prove that no reader still needs the objects of a same-epoch-superseded session. The node was applied before the next create, so `readPromptOutput` of its command is complete. `crash-recover.ts:301` and `permission-resume.ts:462` read only commands of the current or checkpointed session. If that proof fails, D-A1a must keep the objects' hold (fix in the holds predicate, test in the same task).
  - **Logging:** none. This is analysis plus a possible predicate fix.
  - **Verdict table (2026-09-23).** Two meanings moved: a `created` row exists from the ACK, and a same-epoch predecessor becomes `lost` (`session_superseded`) at the successor's ACK instead of at its exit projection.

    | Reader | What it means by the state | Verdict |
    |---|---|---|
    | 11 admission sites (C1) | may this session take a prompt | **widened** to `ADMISSIBLE_PROMPT_INCARNATION_STATES` (T1.3) |
    | `create-ack.ts` (idempotent re-ACK) | is the bound row still open | own code (D-A1) |
    | `lifecycle-projector.ts` | transition source | own code (D-A2) |
    | `runs/active-run-session.ts:63` `liveIncarnationFor` | which logical session is live, ranking key 1 | **unchanged, now correct under lag**: before, the successor had no row until projection and the predecessor still read `active`, so the ranking picked the old session |
    | `runtime-object-holds.ts:168` `live_session` hold | does the RUN still have any open incarnation | **unchanged**: run-scoped, and the superseding row is itself `created`, so a same-epoch supersession never drops the hold while the successor lives; rows now enter the set earlier (safer) |
    | `runs/keepalive-sweeper.ts:230` | positive `checkpointed` witness on the current assignment | **unchanged**: `checkpointed` is written only by projected `session.exited{checkpoint}`, and D-A2 refuses it for a `lost` row, so a superseded row can never become a witness |
    | `agents/permission.ts:682` | ADR-180 host park witness for the command's target session | **unchanged**, same reason |
    | `agents/prompt-owner.ts` `lockAgentOwner` | application waits for `exited`/`crashed`; `lost` answers superseded | **unchanged**: a second agent session on the same assignment cannot be created before the turn applies (the claim defers `prior_turn` on any unapplied `agent_turn` prompt, and a persistent turn parks — new epoch — before the next) |
    | `flows/graph/prompt-session-cleanup.ts:73` | skip the delete for an ended session | **unchanged**: it runs for node N before node N+1's create in the same pass (`runner-agent.ts` after application, `runner-graph.ts:3460` on re-entry of the completed attempt), so a same-epoch `lost` never reaches it; gate sessions use their own name (`gate-<id>`), a different run session |
    | `crash-recover.ts:301`, permission-resume / handoff sources, `prompt-owner-authority.ts` | read by id or identity columns only | **unchanged** (no state predicate) |

    No reader needs the objects of a same-epoch-superseded session after the next ACK: node N is applied (its output read) before N+1 is created. No predicate fix is required.

  - **Phase 1 exit:**
    - A1, A2, A3, A4 and A5 are green, and the T1.6 verdict table is recorded.
    - These suites are green: `deliverer.integration`, `command-recovery.integration`, `ledger.integration`, `bounded-output.integration`, `prompt-owner-activation`, the ADR-176 boot suites (`consensus-prompt-owners`, `agent-session-reobserve`, `scratch prompt-owners`), and the gate-chat and sync-resolver suites.
    - `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` is green, or each red is classified as obsolete (deleted, with the reason) or broken (fixed).
    - `pnpm lint` shows 0 errors. It mutates the tree, so check `git status` afterwards.
    - `tsc` is clean.

<!-- Commit checkpoint 2 -->

### Phase 2: B.4 — direct terminal binding

- [x] **T2.0: Migration `0176_prompt_settled_from` (see Numbering).**
  - **Files:**
    - `web/lib/db/schema.ts`: `executionCommands.settledFrom`, the check and the partial index;
    - `web/lib/db/migrations/0176_prompt_settled_from.sql`;
    - `meta/_journal.json` and `meta/0176_snapshot.json`, both from `drizzle-kit generate`, with the SQL reviewed by hand;
    - `docs/db/erd.dbml`, regenerated.
  - **Acceptance:**
    - `pnpm --filter maister-web db:migrate` applies cleanly on the dev DB and on the test template.
    - A second `drizzle-kit generate` reports "No schema changes".
    - The newest journal entry has a matching snapshot.
    - `db:erd --check` is green.
  - Also, in the same SQL file (C19): DROP + re-ADD `execution_commands_terminal_evidence_check`; `CREATE OR REPLACE FUNCTION guard_prompt_terminal_evidence()`; DROP + CREATE the trigger with `settled_from` in its column list. `schema.ts`'s `check()` text matches the SQL.
  - **Real-PG constraint test** in the integration project. Each case below names the constraint that must refuse or accept:
    - `settled_from='host_span'` with a NULL digest → refused (`settled_from_check`);
    - an unknown value → refused;
    - NULL → accepted, both with and without a digest (pre-change rows);
    - digest set + `settled_from='host_span'` + `terminal_event_id` NULL → **accepted** (`terminal_evidence_check`);
    - digest set + `settled_from='canonical'` + `terminal_event_id` NULL → refused;
    - digest set + `settled_from` NULL + `terminal_event_id` NULL → refused. The old invariant is intact for pre-change rows.
    - Changing `settled_from` once set → refused (the trigger, `execution_commands_immutable_terminal_evidence`);
    - setting `terminal_event_id` from NULL to an id on a host_span row, with all frozen columns equal → accepted (the confirmation shape);
    - changing `result` after the digest is set → still refused (regression pin on the re-created trigger).
  - **Logging:** none. This is schema only.
  - **As done (2026-09-23):** the constraint test caught a three-valued-logic hole in the first draft of the CHECK: `settled_from = 'host_span'` is NULL for a NULL `settled_from`, so the whole CHECK evaluated NULL and a pre-`0176` row could drop its `terminal_event_id`. The shipped text uses `settled_from IS NOT DISTINCT FROM 'host_span'`. **Deviation:** the migration is applied by every integration file's test template, not to the shared dev DB, which other worktrees use (a branch-only migration there desyncs their journals, memory "dev DB desyncs when a branch is rebased").

- [x] **T2.1: RED B1.**
  - New file `web/lib/execution-host/__tests__/prompt-host-settlement.integration.test.ts`, run against the real supervisor.
  - Hold the **prompt** projector with `test-support/projection-hold.ts` (T1.1) while ingest runs. A completed turn settles and the node advances. `terminalEventId` equals the receipt's `eventId`, and `settled_from = 'canonical'`. The WARN from D-C2 is **not** logged, because this is canonical.
  - Release the projector: it is idempotent (same digest, no quarantine, `completionAppliedAt` unchanged).
  - **B1-signal:** the same setup with a turn whose span carries a `session.permission_request`. B.4 does **not** settle it (D-B8). It settles only after the prompt projector is released, with `settled_from='canonical'`, which is today's path.
  - **Expected on master:** the node waits until the projector runs.

- [x] **T2.2: Implement D-B1 (the reducer signature) and D-B2.**
  - Files:
    - `web/lib/execution-host/prompt-evidence.ts`: extract `bindTerminalEvent`; the feed-aware reducer, writing `settled_from`; lookup by `receiptEvidence.eventId` in `reconcileStoredPromptEvidence`; the B.4 signal-free count (D-B8).
    - `web/lib/flows/runner-agent.ts`: export `CONSUMER_SIGNAL_EVENT_TYPES` with its drift-guard unit test.
    - `events/prompt-projector.ts`: it calls `recordPromptEvent`; nothing else changes.
  - **Logging:** INFO `prompt-terminal-bound-directly {commandId, eventId}`.
  - **As done (2026-09-23):** `CONSUMER_SIGNAL_EVENT_TYPES` lives in `web/lib/execution-host/prompt-signal-events.ts`, not in `runner-agent.ts`: the reducer in `execution-host` must not import from `flows`. The drift guard `web/lib/flows/__tests__/consumer-signal-types.test.ts` reads `startEventConsumer`'s `ev.type` branches and requires every non-text branch to be in the list (text-only: `session.update`, `session.line`). The constraint test is `prompt-settled-from.integration.test.ts`; shapes no code path can produce yet (a pre-`0176` row, a host-span row) are seeded with `session_replication_role = replica`, which suspends only triggers, so the CHECKs under test still run.
  - **Widened (found by `bounded-output.integration`, 2026-09-23):** once the waiter's direct bind settles a command, the prompt projector processes that command's events later, and its transaction locks the row while the waiter's own targeted owner claim runs. The claim used `FOR UPDATE SKIP LOCKED` for every caller, so the waiter reported a settled turn as `pending` (five S2.5 cases red). A claim that names its command now waits for the row (READ COMMITTED, bounded by the transaction's `lock_timeout`); the worker's scan keeps `SKIP LOCKED`. Falsified by the same five cases.
  - **Test-fixture note:** the host-settlement suite starts its supervisor with `--hang`. The default mock adapter exits 10 ms after each turn, and that `session.exited` can land inside the turn's own span, where the signal-free rule correctly leaves the turn to the projector.
  - **Phase 2 exit:** B1 is green. `command-recovery.integration` RED 1–3 ("both orders") and the projector/consumer suites are green. Full lanes are green as in Phase 1.

<!-- Commit checkpoint 3 -->

### Phase 3: B.5 — host range read and ingest-independent settlement

- [ ] **T3.1: Supervisor route (D-B3), host side first.**
  - Files:
    - `supervisor/src/host-state.ts`: `runtimeEventsInRange`, built on `runtimeEventPage` with an upper bound;
    - `supervisor/src/http-api.ts`: the new GET next to `:1749`, with zod query validation;
    - `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts`, or a new `runtime-event-span.integration.test.ts`.
  - **Tests:**
    - full span;
    - a paged span across 500 rows and across 1 MiB;
    - `after < floor` → `unavailable/replay_floor_lost` after a real prune;
    - a foreign `streamId` → `stream_identity_changed`;
    - `after >= through` → 409 `invalid_event_span`; `through` past the emitted head → `unavailable/beyond_emitted`;
    - the route performs no ACK and no prune: `acknowledged_through` and the row count are unchanged;
    - identical envelopes to the SSE replay for the same range (parity).
  - **Logging:** DEBUG-free. WARN `runtime-event-span-unavailable {reason, after, through}`.

- [ ] **T3.2: Web transport seam and fake-host extension.**
  - Files:
    - `web/lib/execution-host/contracts.ts`: `readRuntimeEventSpan` on `ExecutionHostTransport`.
    - `lib/supervisor-client.ts`: GET with `ADMIN_READ_TIMEOUT_MS`; non-200 maps to a typed "unavailable".
    - `transports/local-direct.ts`: health identity + `hostKey` match, as `streamRuntimeEvents` does.
    - `web/test-support/fake-execution-host.ts`.
  - **Fake extension (C27).** The fake ingests synchronously today, so it gains:
    - `holdIngest()`: the event sink buffers envelopes instead of calling `ingestRuntimeEvent` and the projectors;
    - `releaseIngest({ tamper?: (envelope) => envelope })`: drains the buffer through the unchanged sink;
    - `readRuntimeEventSpan`: served from the retained envelopes (buffered **and** already ingested), honouring `setPrunedFloor(sequence)` and returning `unavailable/replay_floor_lost` below it.
    - The default (no hold) is unchanged, so the ~96 fake-based suites keep their behaviour. The Phase 3 exit re-runs them.
  - **Parity: new scenario rows** in `host-parity.integration.test.ts`, which has no prompt or event rows today (C27). The rows are complete / partial (paging) / pruned / foreign stream / invalid span. One table runs against the fake **and** the real supervisor (skill-context rule "parity suite for contracts split across two processes").

- [ ] **T3.3: Shared normalization and verification (D-B4).**
  - Files:
    - `events/ingest.ts`: export `normalizeRuntimeEnvelope` and `classifyEnvelopeDisposition`. They are extracted with no behavior change, and ingest calls them.
    - `prompt-output.ts`: `EventPageSource`, the verifier loop and the accepted-row check shared by both sources.
    - new file `prompt-host-span.ts`.
  - **Unit tests** (unit project) of the verifier over synthetic pages, covering each refusal cause: `event_size`, `event_span_gap` (hole, out of order, foreign stream), `terminal_identity`, `source_command_binding`, `content_binding`, and the object digest. `stale_epoch` rows are accepted inside the span exactly as `prompt-output.ts:169` accepts them.
  - **Guard:** the existing `bounded-output.integration` suite stays green on the canonical source.

- [ ] **T3.4: RED B2 / B3 / B4 / B5, then the feed wiring (D-B1, D-B5, D-B6).**
  - **B2** (real supervisor): hold ingest with `startSupervisorFaultProxy(...).arm(selector, "hold-events")` (C27), so nothing is ingested.
    - A completed turn settles from the host span.
    - The node advances.
    - `settled_from = 'host_span'` and `terminal_event_id IS NULL`.
    - The WARN is logged once.
    - Release the stream: the projector confirms, with no quarantine, `completionAppliedAt` unchanged, `settled_from` still `'host_span'` and `terminal_event_id` now bound, and no second owner application (count the adapter apply calls).
  - **B3** (fake tamper hook):
    - After a host-span settlement **and** application, the canonical event disagrees. A `prompt_terminal_conflict` is recorded, `applicationState` stays `applied`, and the node and run are unchanged.
    - The next reconcile sweep does not change the run.
    - A variant where the disagreement arrives **before** application pins the poisoned rule (D-B6).
  - **B4:** canonical-first then receipt, **and** host-span-first then canonical, produce an identical terminal row set: `state`, `result`, `lastError`, `terminalEvidenceSha256`, `terminalEventId` after confirmation, `completionAppliedAt`. The single intended difference is `settled_from` (`canonical` vs `host_span`), and the test asserts it explicitly. This extends the command-recovery RED 3 pattern.
    - Add a two-racer case: the host-span settlement and `recordPromptEvent` run concurrently on one command.
    - The winner holds the row lock with its transaction uncommitted. The loser is asserted parked through `pg_stat_activity`, then verifies and does not re-apply.
    - Include a guard-disabled mutation check (skill-context "design the racer from the invariant").
  - **B5:** fake with `holdIngest()` and `setPrunedFloor()`. The range read returns `unavailable`. The deliverer stays `waiting`, logs WARN `prompt-host-span-unavailable`, and settles canonically after `releaseIngest()`. No failure is fabricated.
  - **B5-503:** the real supervisor with its state directory made unreadable, or the fault proxy returning 503 on `/runtime-events/span`. Same outcome as B5.
  - **B-failed:** a `rejected` (failed) receipt while ingest is held → **no** host-span settlement (D-B4 scope). The command stays `waiting` and settles canonically after release.
  - **Files:** `prompt-reconciliation.ts` (the branch at `:67`), `prompt-evidence.ts` (the `host_span` settle entry), `prompt-output.ts` (source selection), `deliverer.ts` (no loop change; the 4 Hz loop re-enters `reconcilePromptCommand`, whose CAS claim rate-limits host reads).
  - **Commit rule:** T3.4 and T3.5 land in **one** commit (commit 4). Until T3.5 adds the B.5 signal-free check, the working tree may settle a signal-bearing span, so no intermediate commit is allowed.
  - **Logging:**
    - WARN `prompt-settled-from-host-span`, with the D-C2 fields, once.
    - WARN `prompt-host-span-unverified {commandId, causeCode}`.
    - INFO `prompt-host-span-confirmed {commandId}` in `recordPromptEvent` when it binds a host_span-settled command.
    - DEBUG `prompt-evidence-feed-selected` (D-C2), only on the claim.

- [ ] **T3.5: RED B6–B9, then the signal-free rule for B.5, the adapter hardening, the transcript re-anchor and released-assignment settlement (D-B8, D-B9, D-B10, D-B11).**
  - **B6 (D-B11)**, real supervisor + fault proxy:
    - The assignment is released (checkpoint wins) while the terminal is held.
    - The host-span settles the historical ledger (`settled_from='host_span'`), and the owner is superseded.
    - No current run or session row changes; assert with a before/after snapshot of `runs`, `run_sessions` and `node_attempts`.
  - **B7 (D-B8)**, real supervisor, ingest held. This is the dangerous shape: under lag the runner cannot escalate, the supervisor guard denies the tool call, and the agent still **completes** the turn with a `session.hook_trip {disposition: halt}` inside its span.
    - The completed turn is **not** host-span settled: `settled_from` stays NULL while ingest is held.
    - After release, it settles `canonical`, and the runner's hook-trip handling produces the same run and attempt outcome as the identical scenario run without the hold. The control runs in the same file, and the outcomes are compared field by field.
    - A second case uses a live-answered `session.permission_request` inside a completed turn.
    - **Falsification:** disable D-B8 → the node advances with `hookTripEscalated()` never set.
  - **B8 (D-B9):** the pre-change behaviour is characterized first, then fixed.
    - A host_span-settled source command for a permission resume: `permissionCheckpointOrder` → `PromptOwnerDeferred`, **not** poison. It applies after confirmation.
    - An agent turn with a halt and an unbound terminal id: `findAgentPromptHalt` defers and does not finalize normally.
    - The fixtures seed the DB shape directly (host_span, no terminal id), since D-B8 makes the live path rare. They are integration tests against real PG.
  - **B9 (D-B10)**, real supervisor, ingest held:
    - Node 1 settles from the host span and node 2 dispatches.
    - Release ingest: the transcript read model (`run-transcript` coalesce) orders reply 1 before prompt 2.
    - Prompt 2's `supervisor_event_id` equals node 1's terminal `runSequence`.
    - A prompt dispatched **before** node 1 settled is not moved.
  - **Files:**
    - `prompt-host-span.ts`: the signal-free check over verified envelopes;
    - `prompt-evidence.ts`: `loadConfirmedTerminalEvent`;
    - `agents/agent-pause-source.ts`;
    - `execution-host/permission-handoff-evidence.ts`;
    - `execution-host/events/run-message-store.ts`: `reanchorDispatchedPrompts`;
    - `prompt-evidence.ts` `recordPromptEvent`: calls the re-anchor in the confirmation transaction.
  - **Logging:**
    - DEBUG `prompt-evidence-feed-selected {reason:"span_has_signal_events"}`;
    - INFO `transcript-prompts-reanchored {runId, commandId, anchor, rows}` (only when `rows > 0`);
    - INFO `prompt-owner-deferred {commandId, reason:"terminal_event_unconfirmed"}`, from the existing deferred path.
  - **Phase 3 exit:**
    - B1-signal, B2–B9, B5-503 and B-failed are green.
    - The Phase 1 suite set, every fake-host suite (the ~96 `fakeGraphHosts` / `fakeExecutionHosts` users, via the full integration lane) and the supervisor lanes (`pnpm --filter @maister/supervisor test`) are green.
    - `pnpm validate:contracts` is green.

<!-- Commit checkpoint 4 -->

### Phase 4: B.7 recovery feed and the C.8 watchdog predicate

- [ ] **T4.1: Recovery settles on host evidence (D-B7).**
  - Files: `web/lib/reconcile-evidence.ts` (`resolvePromptEvidence`) and `web/lib/reconcile-evidence-db.ts`.
  - **RED** (real supervisor + fault proxy hold): a sessionless `Running` run whose newest prompt has a completed receipt and a readable, signal-free span.
    - **Stream `lost`, span readable** → the resolver settles through the feed. The run is **not** crashed `stream-lost`, and the node advances through the continuation worker.
    - **Stream `lost`, span `unavailable`** (fake pruned floor) → crashes `stream-lost` as today.
    - **Stream active** → the class stays `pending_ingest` and the sweep skips, as today. **No** span read happens: assert with a transport spy.
    - **Expected on master:** the first case crashes `stream-lost`.
  - **Existing suites:** the ADR-177 classification suites stay green. Any changed expectation is named obsolete (the old `pending_ingest` for a readable span) with the reason.
  - **Logging:** INFO `reconcile-evidence-settled-from-host {runId, commandId}`.

- [ ] **T4.2: Watchdog predicate (D-C1), rewritten after C24.**
  - Files:
    - `web/lib/reconcile-evidence-db.ts`: the `variants` option on `loadPromptEvidence`, defaulting to `['node']`;
    - `web/lib/runs/keepalive-sweeper.ts`: `runTimeLimitPass` and `SweepResult.deferredCompletedCount`;
    - `web/lib/scheduler/system-sweeps.ts`: summary passthrough.
  - **RED C1**, in `web/lib/runs/__tests__/time-limit-watchdog.integration.test.ts`, real PG plus a transport stub for the probe. Each row is a distinct witness, with no overlap:

    | Case | Newest attempt prompt | Probe | Expected |
    |---|---|---|---|
    | C1-completed | node, `accepted`, unsettled | `completed` | not killed; session not deleted; `deferredCompletedCount === 1`; **no** span read or reconcile call (spy) |
    | C1-settled | node, settled, application `pending` | not called | not killed |
    | C1-running | node, `accepted` | `indeterminate` (running v2 turn) | killed `PRECONDITION` (as master) |
    | C1-gate | node applied, then `gate_ai` `accepted` | `indeterminate` | killed; the gate prompt is the newest across variants |
    | C1-gate-done | node applied, then `gate_skill` `accepted` | `completed` | not killed |
    | C1-applied | node applied, no newer prompt | not called | killed (driver between prompts) |
    | C1-failed | node `accepted` | `pending_ingest` (ordinary rejected) | killed (failed turns settle canonically) |

    **Expected on master:** C1-completed, C1-settled and C1-gate-done are killed `Failed PRECONDITION`.
  - **Acceptance:**
    - All 10 existing cases (`:340-559`) are green.
    - No host call is made for candidates under their cap (transport spy).
    - The ADR-177 suites are green with the default `variants`, which pins that the change does not leak into crash classification.
    - Coordination: the separate ADR-177 variant task (Out of scope) will change that default. If it lands first, rebase and keep the watchdog's explicit list.
  - **Logging:** INFO `time-limit-deferred-completed-turn` (D-C1).
  - **Phase 4 exit:** full lanes are green as in Phase 1.

<!-- Commit checkpoint 5 -->

### Phase 5: Observability, docs as-built, load control, falsification

- [ ] **T5.1: Counts (D-C2).**
  - Files:
    - `web/lib/execution-host/events/lag-read-model.ts` (per-host query over `settled_from`; confirm with `EXPLAIN` that it uses the partial index);
    - `events/lag-observation.ts` (summary fields);
    - `web/types/execution-host-observability.ts`;
    - `web/components/admin/execution-host-status.tsx` (commands panel, `:608-641`);
    - `web/messages/en.json` + `ru.json` (`adminExecutionHost.fields.hostSpanUnconfirmed | hostSpanSettled1h | postHocConflicts`);
    - the i18n parity test `lib/__tests__/i18n-execution-host-keys.test.ts`.
  - The UI follows `web/CLAUDE.md` affordances: numbers, not adjectives. A jsdom interaction test is added only if the panel gains an interaction; per memory, it must not be Playwright.
  - **Acceptance:** an integration test seeds its own hosts and commands, and asserts per seeded host id (patch 2026-09-21 21.55: assert on the entity, never a table-wide counter):
    - `hostSpanUnconfirmed` counts only `host_span` rows with no terminal id;
    - `hostSpanSettled1h` excludes a `host_span` row older than 1 h and every `canonical` row;
    - `postHocConflicts` counts only applied rows carrying `prompt_terminal_conflict`;
    - **Closing:** confirming a row decrements `hostSpanUnconfirmed` (patch 2026-09-22 19.03: a derived state must be tested closing).

- [ ] **T5.2: Docs as-built.** Flip every Phase 0 `Designed` tag to `Implemented`. Attach the T1.6 verdict table to the analytics. Re-verify every `file:line` cited in the amendments and analytics against the final tree (memory: "docs truth pass after milestones").

- [ ] **T5.3: Load control** (real supervisor, quiet machine, not beside an isolation slice; check `pmset` for sleep per memory).
  - (Counts in this task are read from `settled_from`.) Hold ingest lag at 120 s: claim the consumer and release it after 120 s. Run 6 flow runs with one `ai_coding` turn each (mock ACP adapter).
  - **Report numbers:**
    - per-node completion latency, which must not depend on the lag: p95 under 10 s from host completion;
    - host-span settlements: exactly the 6 command ids of these runs have `settled_from='host_span'` (asserted per id, not through the global counter; the admin read model is cross-checked);
    - post-hoc conflicts, which must be 0.
  - This is a script plus an assertion file; it is not in the default lane. Record the command in `docs/system-analytics/execution-prompt-lifecycle.md` "Verification".

- [ ] **T5.4: Falsification, then the final gate.**
  - Revert each guard in a throwaway commit and confirm its test goes red. Record the counts in the PR/merge note:
    - A1's insert → A1 red;
    - the D-A3 widening at site 3 → site-case red;
    - the D-A4 flow mapping → A2 red;
    - the B.4 direct binding → B1 red;
    - the host-span branch → B2 red;
    - the D-B6 row lock (via the mutation hook) → B4 racer red;
    - the watchdog predicate → C1 red;
    - the `settled_from` write (always `canonical`) → B2 red;
    - the D-A6 worker arm → A4 red;
    - the D-A6 mirror predicate → the loop guard red;
    - D-A1a same-epoch supersession → A5 red (unique violation);
    - the `projectTerminal` allow-list → A5 checkpoint fixture red;
    - the D-B8 signal-free rule (B.5) → B7 red;
    - the D-B8 count (B.4) → B1-signal red;
    - D-B9 `loadConfirmedTerminalEvent` → B8 red;
    - the D-B10 re-anchor → B9 red;
    - the C19 CHECK amendment (restore the 0141 text) → B2 red with the constraint error;
    - the D-C1 variants → C1-gate red.
  - **Final gate on the exact tree:**
    - `pnpm --filter maister-web test:unit && test:integration`;
    - `pnpm --filter @maister/supervisor test`;
    - `pnpm --filter maister-web test:integration:ab`;
    - `pnpm validate:contracts`;
    - `pnpm validate:docs:all`;
    - the ADR anchors gate;
    - `tsc` in both packages;
    - `pnpm lint` at 0 errors.
  - Expect **zero** integration failures on this Mac (memory baseline 2026-09-20). Any red is classified in the same increment.
  - A lane is green only when the process **exit code is 0 and the `Errors` line is absent**. A pass count alone is not evidence (patch 2026-09-21 21.55: an unhandled rejection exits non-zero with every test passing).

<!-- Commit checkpoint 6 -->

---

## Test-integrity map

| RED | File (runner project) | Real seam |
|---|---|---|
| A4, racer | `web/lib/agents/__tests__/agent-session-reobserve.integration.test.ts` (integration, extended) | real PG + real supervisor + fault proxy + production agent worker |
| settled_from constraint | T2.0 constraint test (integration) | real PG |
| A5 (same-epoch supersession) | `prompt-admission-incarnation.integration.test.ts` (integration) | real PG + real supervisor; `test-support/projection-hold.ts` |
| B1-signal, B6–B9, B5-503, B-failed | `prompt-host-settlement.integration.test.ts` (integration) | real supervisor + fault proxy `hold-events`; B8 seeds the DB shape; B5 uses fake `holdIngest`/`setPrunedFloor` |
| signal-type drift guard | `web/lib/flows/__tests__/consumer-signal-types.test.ts` (unit) | pure |
| 0141 guard re-creation | T2.0 constraint test (integration) | real PG |
| A1, A2, A3, site cases | `web/lib/execution-host/__tests__/prompt-admission-incarnation.integration.test.ts` (integration) | real PG + real supervisor + production continuation workers |
| B1–B5, racer | `web/lib/execution-host/__tests__/prompt-host-settlement.integration.test.ts` (integration) | real supervisor (B1, B2, B4); fake tamper/prune hooks (B3, B5) |
| span route | `supervisor/src/__tests__/runtime-event-span.integration.test.ts` (supervisor integration) | real SQLite outbox |
| parity | `web/lib/execution-host/__tests__/host-parity.integration.test.ts` (new span rows) | fake **and** real |
| verifier | `web/lib/execution-host/__tests__/prompt-span-verifier.test.ts` (unit) | pure |
| recovery | ADR-177 suite (extended) | real PG + real supervisor |
| C1 table (7 rows) | `web/lib/runs/__tests__/time-limit-watchdog.integration.test.ts` (extended) | real PG, probe stub + transport spy |
| counts | `lag-read-model` integration (extended) + i18n parity (unit) | real PG |

**Existing assertions expected to migrate** (each must be named obsolete or broken in the phase that changes it):
- **Classified obsolete (Phase 1, 2026-09-23):** `ingest.integration.test.ts` asserted that a same-epoch session reusing the run's `default` name WEDGES the lifecycle cursor. That wedge is the hazard D-A1a closes (C20); the case now asserts the older incarnation is superseded, the stream keeps moving and the superseded session's own exit still projects (`lost → exited`).
- `test-support/prompt-owner-fixture.ts:36-43`: an incarnation row now exists before the projector runs.
- command-recovery V1: it asserts the created row.
- ADR-177 cases that expect `pending_ingest` for a completed, readable span.
- Any test asserting the defer reason literal `session_projection`: renamed to `session_not_admissible`. Grep found none; the only tests assert `capacity` / `prior_turn`.
- Any test asserting that a same-epoch previous incarnation stays `active` after the next create: it is now `lost` / `session_superseded` (D-A1a).
- Any `retireSupersededSessionIncarnations` caller or test that passes the old two-field input: the signature gains `hostSessionId`.
- `time-limit-watchdog` cases whose running turn is modelled with `inflight`: production v2 answers `indeterminate`. Keep them only if they deliberately test the v1 shape, and say so in the test name.
- Fake-host suites that implicitly relied on `readRuntimeEventSpan` being absent: none are expected, since the default is unchanged. Confirmed by the Phase 3 full lane.
- Any lifecycle-projector test asserting that the projector *inserts* the `active` row on first sight. It now *transitions* the row; its insert branch runs only for event-first-without-ACK.

## Out of scope

- P1-1 batching, P1-2 SSE backpressure, P1-3 hydration cache, and P1-4/D6 outbox pressure.
- A4: scratch grace, scratch automatic re-drive, Recover status.
- The consumer's total order; Stage C remote hosts.
- Host-evidence settlement for **failed/fenced** receipts (D-B4 scope: no manifest, so there is no bounded span in which to prove D-B8).
- Scratch and agent turns applying before projection: their adapters wait for the transcript / lifecycle projectors **by design** (C22). D4 removes failures there, not latency.
- **Separate tasks raised by `/aif-improve` (chips created):**
  - Retirement compaction vs the 0140/0141 guards: fixed on `claude/retirement-tombstone-guards` by migration `0175`. It is a prerequisite: T2.0 re-derives its CHECK and trigger text from `0175`.
  - The ADR-177 classifier sees only `variant='node'`, so a `permission_resume` current turn is classified from a stale command. It touches `loadPromptEvidence`, like T4.2.

## Follow-up (separate)

- Measure P1-1…P1-3 against `hostSpanSettled1h`. It should approach 0 when the event plane keeps up.
- If host-span settlements dominate under normal load, revisit demoting the prompt projector to observation-only (a second D5 amendment).

---

## Решения владельца (2026-09-23)

1. **`settled_from`:** a dedicated column (migration `0176`). This amends the lock "No migration", and the amendment is recorded in the ADR-167 D5 bullet (D-B7a, T2.0).
2. **Host route:** no `sourceCommandId` filter. It returns the full range, like the SSE replay (D-B3, C11).
3. **Deferred agent message re-drive:** in scope, RED first (D-A6, T1.5).
4. **Canonical conflict before application:** the existing poison rule stays (D-B6; B3 variant).
5. **Logging:** standard, plus one DEBUG line on feed selection (D-C2).

Open questions: none.

## `/aif-improve` log (2026-09-23)

The owner applied every item:

- **Blocking fixes:**
  - C19 → the `0176` CHECK and trigger amendment (T2.0);
  - C20 → same-epoch supersession (D-A1a, A5, T1.6);
  - C21 → the signal-free span rule (D-B8, B1-signal, B7);
  - C22 → absence is never proof (D-B9, B8).
- **New tasks:** T1.6 (reader re-derivation) and T3.5 (B6–B9). New decisions: D-B10 (transcript re-anchor) and D-B11 (released assignment).
- **Rewritten:**
  - D-C1 / T4.2: all variants, positive witness only, no settlement and no host call beyond the probe, the 7-row case table;
  - D-B7 / T4.1: stream-lost branch only; the "no new host call" claim withdrawn;
  - D-A5: withdrawn, since the property already exists through `0170`;
  - D-A6: the mirror predicate plus the loop guard;
  - D-B5: the exact claim predicate, and the first attempt inside the receipt claim.
- **Test infrastructure:** fake `holdIngest` / `releaseIngest` / `setPrunedFloor`; the shared `test-support/projection-hold.ts`; fault-proxy `hold-events` for real-supervisor ingest lag; entity-scoped count assertions; exit code plus `Errors` line as the green criterion.
- **Docs:** PRM-03, EDGE-PRM-03 and EDGE-PRM-04 amended; PRM-13…16 added; the per-adapter earliest-application table; `docs/supervisor.md` is a definite update; AsyncAPI explicitly unchanged.
