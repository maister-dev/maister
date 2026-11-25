# Implementation Plan: Eliminate Supervisor Per-Chunk fsync Amplification & Web Projection/Pool Bottlenecks (Findings #3, #4, #5)

Branch: `fix_supervisor_fsync_amplification`
Created: 2026-11-25
Refined: 2026-11-25 (SDD + TDD `RED → GREEN → REFACTOR` Pass)

## Settings
- Testing: yes (strict TDD: `RED → GREEN → REFACTOR`, non-overlapping high-signal matrix, zero trivial tests)
- Logging: verbose (`DEBUG` performance/coalescing/offload traces, `INFO` pool init, structured & secret/path-free)
- Docs: yes (SDD Phase 0 spec freeze before any code changes)

## Roadmap Linkage
Milestone: "none"
Rationale: "Skipped by user"

---

## Findings Validation & Architectural Summary

All three performance findings were verified directly against the codebase, existing specs, and integration tests:

1. **Finding #3 — Supervisor Synchronous 11–12× `fsync` Amplification per Streaming ACP Chunk (`CRITICAL / P0`)**:
   - `ABSOLUTE_PATH = /(?:^|\s)\/(?:[^\s]*)/` in both `supervisor/src/runtime-events.ts:98` and `web/lib/execution-host/runtime-events.ts:125` false-positives on code comments (` //`, ` /*`), JSX (`<Button />`), division (`a / b`), and single-segment tokens (`/api`). Each match throws in `assertRuntimeEventPayloadSafe` twice per streamed text frame (`session.line` + `session.update`), triggering `RuntimeObjectRegistry.captureSessionContent` → `captureProducerBytes` (`supervisor/src/runtime-objects.ts:304`) with 5 synchronous `fsync` boundaries × 2 + outbox commit = 11–12 `fsync`s and ~30 `statSync`/`statfsSync` syscalls on the Fastify event loop per line.
   - Even on clean text, `captureAcpFrames` (`supervisor/src/bounded-acp-stream.ts:327-393`) spools every complete in-memory line (`< 64 KiB`) to `.acp-frame-*.tmp`, reads it back from disk, UTF-8 decodes up to 3× across `publishCapturedFrame`, `boundedAcpStream`, and `parseFrame`, and `ftruncate`s the spool. Furthermore, `appendRuntimeFrameEvents` (`supervisor/src/host-state.ts:1325`) only batches 1 frame pair (`1..2` rows), so 10 complete text frames arriving in one 64 KiB stdout chunk perform 10 separate SQLite `BEGIN IMMEDIATE ... COMMIT` (`PRAGMA synchronous = FULL`) `fsync`s.
   - `openHostState` (`supervisor/src/host-state.ts:1119-1124`) uses default 2 MiB SQLite cache and file-backed temp store, and `createSqliteStorage` (`supervisor/src/sqlite-storage.ts:155-178`) calls 4 synchronous `statSync`/`statfsSync` syscalls on every `canAdmit`/`write`.

2. **Finding #4 — Web Event-Plane Projection Bottlenecks (`CRITICAL / P0`)**:
   - `boundedPostgresTransaction` (`web/lib/execution-host/events/projection-transaction.ts:249-280`) executes `SELECT pg_backend_pid() AS pid` before `BEGIN` (ignoring `(client as { processID?: number }).processID`) and intercepts `client.query` to execute `SELECT set_config(...)` before every statement including `COMMIT`, turning `N` queries into `2N + 1` SQL round-trips.
   - `claimNextExecutionProjection` (`web/lib/execution-host/events/projector.ts:183-204`) scans `execution_event_consumers` ordered by `last_served_at ASC NULLS FIRST` with a correlated `EXISTS (SELECT 1 FROM execution_events ...)`. Because completed runs' consumer rows stay `state = 'ready'` with the oldest `last_served_at`, Postgres probes `execution_events` `O(7 × R_historical)` times per claim poll.
   - `projectTranscriptEvent` (`web/lib/execution-host/events/transcript-projector.ts:187-547`) runs 6 SQL statements per streamed token (600 statements / ~1,201 round-trips per 100-token batch), rewriting TOASTed `run_messages.content` and firing `run_messages_peek_hint` on every token. `canonicalCostProjector` (`web/lib/runs/cost-rollups.ts:420-545`) similarly re-queries `runs`/`node_attempts` and recomputes `refreshRunnerBuckets` on every `usage.recorded` event.

3. **Finding #5 — `pg.Pool (max = 10)` Self-Deadlock in `emitDecisionsDelta`, Librarian Transaction Burst, and Missing Pool Timeouts (`CRITICAL / P0`)**:
   - `emitDecisionsDelta` (`web/lib/notifications/attention-consumer.ts:190-248` and caller `runDecisionsDeltaBackstop` in `web/lib/notifications/digest-trigger.ts:168-177`) opens `client.transaction(async (tx) => ...)` (holding 1 pool connection + `pg_advisory_xact_lock` + `FOR UPDATE OF e`), then calls `await decisionsFor(userId, role)` closed over outer pool `client`. Inside `computeDecisionsQueue`, `Promise.all` requests up to 7 concurrent outer-pool checkouts while pinning `tx`, risking infinite self-deadlock under `max = 10` and `connectionTimeoutMillis = 0`.
   - `getLibrarianConversationView` (`web/lib/librarian/view.ts:565-571`) runs `readEligibleConfirmationIds` and `getLinkedWork` concurrently; `getLinkedWork` (`web/lib/librarian/read-models.ts:303-408`) opens up to 50 parallel `db.transaction`s via `Promise.all(cardRows.map(...))` (duplicating `prepareKnowledgeCard` for pending cards and opening nested `db.transaction`s in `governedEffectLink` for vault cards), while `readEligibleConfirmationIds` (`web/lib/librarian/confirmation-availability.ts:268`) opens a separate transaction per candidate card.
   - `buildClient` (`web/lib/db/client.ts:25-31`) defaults `MAISTER_DB_POOL_MAX` to `10` with unset `connectionTimeoutMillis` and `idleTimeoutMillis`.

---

## SDD Specification: Requirements & Acceptance Criteria Matrix

Every requirement below is normative, maps to a concrete enforcement mechanism, and is verified by a non-overlapping test in the TDD matrix.

### Finding #3 — Supervisor Streaming & SQLite Durability

| Req ID | Requirement (Normative Expectation) | Enforcement Mechanism | Concrete Acceptance Criterion |
| --- | --- | --- | --- |
| **REQ-S3-01** | `containsHostFilesystemPath` MUST live in a single shared zero-dependency SSOT module `runtime/host-path-safety.ts` imported by both `supervisor/src/runtime-events.ts` and `web/lib/execution-host/runtime-events.ts`. Code comments (` //`, ` /*`), JSX (`<Button />`), arithmetic (`a / b`), URLs (`https://a/b`), and single-segment route tokens (`/api`, `/login`) MUST pass `assertRuntimeEventPayloadSafe` inline; real host/POSIX roots (`/Users/...`, `/home/...`, `/var/...`, `/tmp/...`, `/private/...`, `/opt/...`, `/etc/...`, `/usr/...`, `/app/...`, `/repos/...`, `/maister/...`, `/.maister/...`, `/dev/...`, `/proc/...`, `/sys/...`, `/run/...`, `/srv/...`, `/mnt/...`, `/media/...`, `/Library/...`, `/System/...`, `/Volumes/...`, `/cores/...`, `/sbin/...`, `/bin/...`), multi-segment rooted paths (`/(?:^|[\s"'(])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/`), and `file://` URIs MUST still fail `assertRuntimeEventPayloadSafe` and redact to `[REDACTED_HOST_PATH]`. | `runtime/host-path-safety.ts` + cross-process parity tests (`supervisor` & `web`) | 100% identical accept/reject decisions across supervisor and web on shared parity table; streaming code lines with ` //` and `<div />` through `RuntimeEventPublisher.publishTextFrame` creates **0** `runtime-objects/` files. |
| **REQ-S3-02** | Legitimate `RuntimeObjectRegistry.captureProducerBytes` captures MUST commit `insertRuntimeObject` and `sealRuntimeFile` inside a single `withRuntimeFileWrite` SQLite transaction (`BEGIN IMMEDIATE ... COMMIT`) after directory `fsyncSync`. | `HostState.sealCapturedRuntimeObject` in `supervisor/src/host-state.ts` called by `supervisor/src/runtime-objects.ts` | Post-rename SQLite commits drop from 2 to 1 (`PRAGMA data_version` increments by 1); failure rolls back both `runtime_objects` insert and `runtime_files` seal atomically. |
| **REQ-S3-03** | `captureAcpFrames` MUST retain eager `open(temporary, "wx+", 0o600)` (preserving exit-time stdout buffering) while fast-pathing complete newline-terminated lines (`length === 0 && newline !== -1 && !draining`) completely in memory without invoking `spool.write`, `spool.read`, or `spool.truncate`. UTF-8 validity MUST still be enforced on every fast-path frame (`node:buffer` `isUtf8` when `onLine` is undefined; single `TextDecoder("utf-8", { fatal: true })` when `onLine` is defined). If `beforeWrite` or `beforeFrame` returns `{ kind: "drain" }`, the frame(s) MUST spill into `spool` with exact `length`, `completeFrames`, `trailingFrameBytes`, and `onSpoolBytes` accounting so `publishSegment()` preserves all captured bytes. | `captureAcpFrames` in `supervisor/src/bounded-acp-stream.ts` | Spy on `FileHandle.write`/`read`/`truncate` shows **0 calls** for complete in-memory frames; invalid UTF-8 still fails with `ACP_PROTOCOL`; partial multi-chunk frames and drain transitions still spool and emit exact `CapturedStdoutSegment`. |
| **REQ-S3-04** | `boundedAcpStream` MUST decode each frame's UTF-8 text at most once and pass the decoded `line` string into `parseFrame(frame, line)`. | `boundedAcpStream` + `parseFrame` in `supervisor/src/bounded-acp-stream.ts` | Single UTF-8 decode per frame (`TextDecoder.prototype.decode` spy = 1 per frame when `captureAcpFrames` has no `onLine`); structural byte-complexity bounds (`depth <= 32`, `structures <= 8192`, `byteLength <= MAX_ACP_FRAME_BYTES`) remain unchanged. |
| **REQ-S3-05** | Multiple consecutive complete ordinary text-update frames (`agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` with `content.type === "text"` and no cost record) arriving within one `<= 64 KiB` stdout read chunk MUST batch into **one** SQLite `BEGIN IMMEDIATE ... COMMIT` (`PRAGMA synchronous = FULL`) up to `MAX_CHUNK_BATCH_FRAMES = 16` frames (≤ 32 events), funded by a single batch TEMP frame reservation (`frameCount * 2 + 2` rows) and single `acquireDecoder()` permit, while `captureAcpFrames` preserves its 1-`Buffer`-per-yield object-mode contract and flushes pending text frames immediately before any non-text frame, tool call, permission, usage, error, or slice release. | `captureAcpFrames` slice batching + `boundedAcpStream` pending text buffer + `RuntimeEventPublisher.publishTextFrames` + `HostState.appendRuntimeFrameEvents` + `tryReserveRuntimeFrame(walletId, frameBytes, rowCount)` | A single 64 KiB chunk containing 10 text-chunk JSON-RPC lines writes `stdout.log` in 1 call and commits all 20 events (`session.line` + `session.update` × 10) in **1** SQLite transaction (`PRAGMA data_version` delta = 1); a failed event in the batch rolls back all events and frame-credit spends atomically. |
| **REQ-S3-06** | `openHostState` MUST configure `PRAGMA cache_size = -65536` and `PRAGMA temp_store = MEMORY` alongside `WAL` + `synchronous = FULL`. `createSqliteStorage` MUST amortize `physicalSnapshot()` (`statSync`/`statfsSync`) for up to `16` operations or `512 KiB` of estimated write bytes ONLY when `file !== null`, `!pressured`, and the last measured snapshot has > `8 MiB` margin below `SQLITE_CHECKPOINT_TARGET_BYTES` and `limits.stateMaxBytes` and > `8 MiB` above `limits.runtimeMinFreeBytes`. It MUST ALWAYS measure fresh when `pressured === true`, within `8 MiB` of any threshold, when a checkpoint runs, when a reservation exceeds remaining amortized margin, or on explicit `snapshot()`. | `openHostState` (`supervisor/src/host-state.ts`) + `createSqliteStorage` (`supervisor/src/sqlite-storage.ts`) | SQLite pragmas verify `cache_size = -65536` and `temp_store = 2` (MEMORY); 16 back-to-back healthy writes execute `<= 2` `statfsSync` calls instead of 32+; pinned-WAL pressure recovery (`runtime-storage.integration.test.ts:270`) still trips and recovers immediately upon external checkpoint. |

### Finding #4 — Web Event-Plane Projection Pipeline

| Req ID | Requirement (Normative Expectation) | Enforcement Mechanism | Concrete Acceptance Criterion |
| --- | --- | --- | --- |
| **REQ-P4-01** | `boundedPostgresTransaction` MUST read `(client as { processID?: number }).processID` directly, falling back to `SELECT pg_backend_pid() AS pid` only when absent or non-positive. It MUST execute `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)` **once** per transaction right before the first non-control query after `BEGIN`, skipping `BEGIN`/`COMMIT`/`ROLLBACK`/`ABORT`, while preserving `remaining()` checks before every non-rollback query and the cumulative `setTimeout` + `cancelBackend(pool, backendPid)` 5 s wall-clock deadline. | `boundedPostgresTransaction` in `web/lib/execution-host/events/projection-transaction.ts` | A transaction with 10 queries issues **0** `SELECT pg_backend_pid()` queries (when `client.processID` is present) and **1** `SELECT set_config(...)` query (not 11); two sequential 3 s slow queries (> 5 s total) cancel and roll back cleanly with `projection_transaction_deadline`; blocked-lock `AT-03` still cancels and rolls back. |
| **REQ-P4-02** | `execution_event_consumers` MUST carry `max_available_sequence bigint NOT NULL DEFAULT -1` with `CHECK (max_available_sequence >= -1)` (`execution_event_consumers_max_available_sequence_check`) and partial index `execution_event_consumers_due_service_idx ON (last_served_at ASC NULLS FIRST, run_id, consumer_name) WHERE state <> 'poisoned' AND max_available_sequence > COALESCE(last_run_sequence, -1)`. Migration `0376_execution_event_consumer_horizon` MUST backfill existing rows from `MAX(execution_events.run_sequence)` (`ingest_disposition = 'accepted' AND run_sequence IS NOT NULL`). | Drizzle schema + Migration `0376` four-leg contract (`schema.ts`, SQL, `_journal.json` + `0376_snapshot.json`, `erd.dbml`) | `drizzle-kit generate` reports `"No schema changes"`; `migration-journal-integrity.test.ts` and `db:erd --check` pass; negative `max_available_sequence < -1` is rejected by PG CHECK constraint; pre-existing events are backfilled accurately. |
| **REQ-P4-03** | Every writer of `execution_event_consumers` (`seedCanonicalProjectionConsumers`, `ingest.ts`, `run-stream-event.ts`, `backfillProjectionConsumers`, `ensureConsumer`, `import-legacy-execution-data-plane.ts`) MUST atomically advance `max_available_sequence = GREATEST(execution_event_consumers.max_available_sequence, EXCLUDED.max_available_sequence)`. `claimNextExecutionProjection` MUST replace its correlated `EXISTS (SELECT 1 FROM execution_events ...)` with `max_available_sequence > COALESCE(last_run_sequence, -1)`. | All 6 writer paths + `claimNextExecutionProjection` in `web/lib/execution-host/events/projector.ts` | With 500+ caught-up historical runs (`last_run_sequence = max_available_sequence`) and 1 due active run, `EXPLAIN` confirms index scan on `execution_event_consumers_due_service_idx`, `claimNextExecutionProjection` selects the active run, and returns `null` when caught up without probing `execution_events`. |
| **REQ-P4-04** | `ExecutionEventProjector` MUST support an optional `projectBatch(tx, events, onProgress, softDeadline)` hook in `applyClaimedExecutionProjection`, validating `event.runSequence !== null` for every event, enforcing `softDeadline` (`1_000 ms`), and preserving single-event `project(tx, event)` for projectors that do not implement `projectBatch`. | `applyClaimedExecutionProjection` in `web/lib/execution-host/events/projector.ts` | Batch-capable projectors receive the full quantum slice; non-batch projectors behave identically; `afterCommit` receives the exact projected events list. |
| **REQ-P4-05** | `canonicalTranscriptProjector.projectBatch` MUST query `runs` once per batch, pre-validate distinct non-null `nodeAttemptId`s in one batched query (attributing a foreign `nodeAttemptId` to the exact offending event via `onProgress`), acquire `lockTranscriptState(tx, runId, nodeAttemptId)` once per scope (preserving TRC-10 lock order), and coalesce contiguous `text`, `thought`, `usage`, and same-`toolCallId` `tool_update` events before issuing a single SQL write per coalesced message and a single `UPDATE run_transcript_states` per scope. Coalesced new messages MUST preserve `firstSupervisorEventId = firstChunkSeq` and `supervisorEventId = lastChunkSeq`; coalesced `tool_update`s MUST preserve first non-empty `arg`, `\n`-joined non-empty `result`s, and last-wins metadata. Any SQL failure (including `22P05`/`22P02`/`22021`) inside a coalesced flush MUST roll back to a `SAVEPOINT` and replay per-event so the **exact** offending event is attributed and poisoned. | `canonicalTranscriptProjector.projectBatch` in `web/lib/execution-host/events/transcript-projector.ts` | Projecting 100 contiguous text/thought/usage/tool_update events reduces SQL statements from ~600 to `<= 12`, produces byte-identical `run_messages` (`content`, `firstSupervisorEventId`, `supervisorEventId`, `sequence`) and `run_transcript_states` as per-event replay, and poisons the exact offending event ID when event #37 contains an unstorable payload. |
| **REQ-P4-06** | `canonicalCostProjector.projectBatch` MUST query `runs` once per batch, group `usage.recorded` deltas by `(model, sessionName)` (accumulating `sourceEventCount` by group count, not `+1`), batch-validate distinct `nodeAttemptId`s in one `SELECT ... WHERE run_id = $1 AND id IN (...)`, upsert `node_attempt_cost_rollups` once per distinct `(nodeAttemptId, model)`, and call `refreshRunnerBuckets(tx, runId)` **once** at batch end. | `canonicalCostProjector.projectBatch` in `web/lib/runs/cost-rollups.ts` | Projecting a batch with multiple `usage.recorded` events across 2 models/sessions produces identical `run_cost_rollups` (`byModel`, `bySession`, `byRunner`, `sourceEventCount`) and `node_attempt_cost_rollups` as per-event replay with 1 `refreshRunnerBuckets` call and 1 `runs` query. |

### Finding #5 — Database Pool, `emitDecisionsDelta` & Librarian Read Models

| Req ID | Requirement (Normative Expectation) | Enforcement Mechanism | Concrete Acceptance Criterion |
| --- | --- | --- | --- |
| **REQ-D5-01** | `buildClient()` in `web/lib/db/client.ts` MUST default `MAISTER_DB_POOL_MAX` to `25` (still overridable via valid positive `MAISTER_DB_POOL_MAX`) and configure `connectionTimeoutMillis: 10_000` and `idleTimeoutMillis: 30_000`, logging all three values on `"db client init"`. | `buildClient` in `web/lib/db/client.ts` | Unit test verifies default pool options `{ max: 25, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }` and env override `MAISTER_DB_POOL_MAX=12`. |
| **REQ-D5-02** | `emitDecisionsDelta` MUST thread its active transaction `tx` as the 3rd argument to `decisionsFor(userId, role, tx)`, and default production implementations in both `attention-consumer.ts` and `digest-trigger.ts` MUST call `readAttentionDecisionSnapshot(tx ?? client, userId, role)` so zero outer-pool connections are checked out while holding `tx`. Existing 2-arg test stubs MUST remain type- and runtime-compatible. | `emitDecisionsDelta` in `web/lib/notifications/attention-consumer.ts` + `runDecisionsDeltaBackstop` in `web/lib/notifications/digest-trigger.ts` | Integration test executing `emitDecisionsDelta` and `runDecisionsDeltaBackstop` against a **`max: 1` pool** with `connectionTimeoutMillis: 2_000` completes cleanly without deadlocking or timing out. |
| **REQ-D5-03** | `getLibrarianConversationView` (`web/lib/librarian/view.ts`) MUST await `readEligibleConfirmationIds` first and pass `{ eligiblePendingCardIds: eligible }` into `getLinkedWork`. For pending cards, `getLinkedWork` MUST check `eligiblePendingCardIds.has(card.id) && (projectId ? visibleById.has(projectId) : true)` in O(1) without re-running `prepareKnowledgeCard`. | `getLibrarianConversationView` (`web/lib/librarian/view.ts`) + `getLinkedWork` (`web/lib/librarian/read-models.ts`) | `prepareKnowledgeCard` is called once per pending governed card across the full `getLibrarianConversationView` call (not twice); output (`pendingCards`, `cards`, `effectPreview`, `effectLink`) is identical to pre-change behavior. |
| **REQ-D5-04** | `getLinkedWork` MUST evaluate all governed cards (non-pending `authorizeSourceRestrictions`, direct-caller pending `prepareKnowledgeCard`, and `governedEffectLink` vault lookups) sequentially inside **one** shared `db.transaction` with per-card `tx.transaction` savepoints on `MaisterError`, replacing the `Promise.all(cardRows.map(... db.transaction ...))` burst. | `getLinkedWork` + `governedEffectLink(tx, ...)` in `web/lib/librarian/read-models.ts` | Loading a Librarian conversation with ≥ 12 governed cards (mix of pending, accepted vault, accepted knowledge, and denied/revoked cards) against a **`max: 2` pool** (or `pool.connect` spy) uses at most 1 transaction connection for card evaluation and returns exact card availability and `effectLink`s. |
| **REQ-D5-05** | `readEligibleConfirmationIds` (`web/lib/librarian/confirmation-availability.ts`) MUST reuse a single outer transaction (with per-card `tx.transaction` savepoints) for its governed knowledge-card loop, preserving safe savepoint nesting when called inside `getLibrarianWorkView`'s `repeatable read` transaction. | `readEligibleConfirmationIds` in `web/lib/librarian/confirmation-availability.ts` | Works identically both standalone (pool `db`) and nested inside `getLibrarianWorkView` (`repeatable read` `tx`), rolling back only the denied card's savepoint when one card fails with `MaisterError`. |

---

## Contract Surface Traceability & Deployment Touchpoints

| Surface Changed | Spec / Artifact Files to Update |
| --- | --- |
| Wire/envelope `ABSOLUTE_PATH` host-path safety rule (`runtime/host-path-safety.ts` ↔ `supervisor/src/runtime-events.ts` ↔ `web/lib/execution-host/runtime-events.ts`) | `docs/api/async/execution-host-events.asyncapi.yaml` (prose redaction/path safety note), `docs/system-analytics/execution-event-plane.md`, `docs/supervisor.md`, `supervisor/src/__tests__/runtime-events.test.ts`, `web/lib/execution-host/__tests__/runtime-events.test.ts` |
| Supervisor in-memory frame fast-path, chunk-slice SQLite batching, and bounded `physicalSnapshot()` amortization | `docs/system-analytics/execution-event-plane.md` (reconciling lines 45–65 & 537), `docs/supervisor.md` |
| Web projection transaction single `set_config` + batch coalescing (`transcript` & `cost`) | `docs/system-analytics/execution-event-plane.md` (reconciling line 618 + transcript/cost sections) |
| New DB column `execution_event_consumers.max_available_sequence` (`bigint NOT NULL DEFAULT -1`, `CHECK >= -1`) and partial index `execution_event_consumers_due_service_idx` | `web/lib/db/schema.ts`, `web/lib/db/migrations/0376_execution_event_consumer_horizon.sql`, `web/lib/db/migrations/meta/_journal.json` (`idx: 376`), `web/lib/db/migrations/meta/0376_snapshot.json`, `docs/database-schema.md`, `docs/db/execution-hosts-domain.md`, generated `docs/db/erd.dbml` (`pnpm --filter maister-web db:erd`) |
| `emitDecisionsDelta` single-transaction snapshot & Librarian single-transaction card evaluation | `docs/system-analytics/attention.md`, `docs/system-analytics/librarian-conversation.md` |
| `MAISTER_DB_POOL_MAX` default raised `10` → `25` + `connectionTimeoutMillis: 10_000` + `idleTimeoutMillis: 30_000` | `docs/configuration.md` (canonical env-vars table), `docs/database-schema.md`, `web/lib/db/README.md`, `.env.example`, `web/.env.sample`, `deploy/maister.env.example` (Note: `compose.yml` & `compose.production.yml` containerize Postgres 16 only per ADR-023, where default `max_connections = 100` comfortably accommodates `25` web pool connections) |

### Migration, Concurrency & Crash-Window Allocation
- **Reserved Drizzle Migration Number**: `idx: 376`, tag `0376_execution_event_consumer_horizon` (next sequential entry after `0375_package_skill_readiness` in `web/lib/db/migrations/meta/_journal.json`).
- **Four-Leg Migration Contract**:
  1. `web/lib/db/schema.ts` (`executionEventConsumers.maxAvailableSequence`, `chkMaxAvailableSequence`, `idxDueService`)
  2. `web/lib/db/migrations/0376_execution_event_consumer_horizon.sql` (additive `ALTER TABLE`, `CHECK`, backfill `UPDATE` from `execution_events`, partial `CREATE INDEX`)
  3. `web/lib/db/migrations/meta/_journal.json` + `web/lib/db/migrations/meta/0376_snapshot.json` (verified with `drizzle-kit generate` reporting `"No schema changes"` and `migration-journal-integrity.test.ts`)
  4. Generated `docs/db/erd.dbml` (`pnpm --filter maister-web db:erd`) + `docs/db/execution-hosts-domain.md` + `docs/database-schema.md`
- **Lock & Crash-Window Invariants**:
  - **Supervisor chunk-slice batching**: Slice reservation (`tryReserveRuntimeFrame`) is acquired BEFORE yielding slice frames and released ONLY after all text events in the slice commit (`BEGIN IMMEDIATE ... COMMIT` under `PRAGMA synchronous = FULL`) or roll back. A process crash mid-chunk leaves zero partial SQLite rows (rolled back by WAL) and exact bytes in `stdout.log`; any TEMP reservation disappears at boot.
  - **Supervisor runtime-object capture**: File write → `fsyncSync(fd)` → `renameSync` → `fsyncSync(dir)` → single SQLite tx (`insertRuntimeObject` + `sealRuntimeFile`). Crash before SQLite tx leaves an unsealed file reservation inventoried at boot.
  - **Web `emitDecisionsDelta`**: Per-owner `pg_advisory_xact_lock(DECISION_DELTA_LOCK_NAMESPACE, hashtext(userId))` → `FOR UPDATE OF e` on `agent_incident_episodes` → `decisionsFor(userId, role, tx)` on the **same** `PoolClient` `tx` (zero nested pool checkouts).
  - **Web `canonicalTranscriptProjector.projectBatch`**: `lockTranscriptState(tx, runId, nodeAttemptId)` acquired once per `(runId, nodeAttemptId)` scope in deterministic order before any `run_messages` write (preserving TRC-10 lock order with `appendRunMessage`). Savepoint around coalesced writes guarantees exact rollback + per-event fallback on `22P05`/`22P02`/`22021`.
  - **Web Librarian `getLinkedWork` / `readEligibleConfirmationIds`**: One outer `db.transaction` with per-card `tx.transaction` savepoint catches `MaisterError` denials without aborting the outer transaction or borrowing extra pool connections.

### Existing Test Assertion Migration Inventory (In-Scope)

| Existing Test File | Specific Assertion / Fixture Affected | Required Migration |
| --- | --- | --- |
| `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts` (L767–835) | Asserts `expect(admissionMeasurements).toBe(2)` and `expect(releaseMeasurements).toBe(1)` via `vi.spyOn(fs, "statfsSync")` after 16 prior healthy frame reserve/release cycles | Update assertion to validate bounded amortization (healthy back-to-back ops amortize `statfsSync` within 16 ops / 512 KiB, while fresh re-measurement triggers immediately at pressure / 8 MiB margin / checkpoint / `snapshot()`) |
| `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts` (L368) | Raw SQL `INSERT INTO execution_event_consumers (consumer_name, run_id) VALUES ($1, $2)` before calling `claimNextExecutionProjection` on `seedRun(6)` | Update to `INSERT INTO execution_event_consumers (consumer_name, run_id, max_available_sequence) VALUES ($1, $2, 5)` so the manually seeded consumer row reflects the 6 raw events |

---

## Non-Overlapping TDD Test Coverage Matrix

Every requirement and edge case maps to **one** targeted, high-signal test (no trivial getter tests, no duplicated coverage across unit and integration layers). Each task writes its RED test(s) **before** writing production code.

| Req / Edge Case | Layer & Runner | Test File | Single High-Signal Scenario & Concrete Assertion |
| --- | --- | --- | --- |
| REQ-S3-01 (inline code vs real paths + web/supervisor parity) | Unit (`@maister/supervisor`, `maister-web`) | `supervisor/src/__tests__/runtime-events.test.ts` + `web/lib/execution-host/__tests__/runtime-events.test.ts` | Parameterized parity table: ` // comment`, ` /* block */`, `<Button />`, `a / b`, `GET /api`, `https://x.io/a/b` pass `assertRuntimeEventPayloadSafe` unredacted on both sides; `/Users/u/f`, `/private/tmp/x`, `/repos/a`, `"/var/log/x"`, `(/etc/hosts)`, `/foo/bar`, `file:///a` throw and redact to `[REDACTED_HOST_PATH]`. |
| REQ-S3-01 + REQ-S3-02 (zero offloads on code + single post-rename tx on real offload) | Integration (`@maister/supervisor`) | `supervisor/src/__tests__/runtime-storage.integration.test.ts` | (a) `publishTextFrame` with ` // comment` + `<div />` creates **0** files in `runtime-objects/`; (b) `publishTextFrame` with `/Users/dev/secret.ts` offloads once and increments `PRAGMA data_version` by 1 for `sealCapturedRuntimeObject` (insert + seal atomic). |
| REQ-S3-03 + REQ-S3-04 (zero-spool fast-path, `isUtf8`, drain spill, single decode) | Unit (`@maister/supervisor`) | `supervisor/src/__tests__/bounded-acp-stream.test.ts` | (a) Complete newline-terminated frames invoke `spool.write`/`read`/`truncate` **0** times and `TextDecoder.decode` **1** time per frame; (b) invalid UTF-8 bytes on fast-path without `onLine` reject with `ACP_PROTOCOL`; (c) `beforeWrite` / `beforeFrame` returning `{ kind: "drain" }` mid-chunk spills exact bytes into `spool` and emits exact `CapturedStdoutSegment`. |
| REQ-S3-05 (chunk-slice SQLite batching + non-text flush + rollback atomicity) | Integration (`@maister/supervisor`) | `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts` | (a) Single chunk with 6 ordinary text-chunk frames followed by 1 tool_call frame commits the 6 text pairs (12 rows) in **1** SQLite transaction (`data_version` delta = 1) and flushes before tool_call; (b) failing event in multi-pair `appendRuntimeFrameEvents` rolls back all rows and frame credits atomically. |
| REQ-S3-06 (SQLite pragmas + amortized `physicalSnapshot` + pressure fresh measure) | Integration (`@maister/supervisor`) | `supervisor/src/__tests__/runtime-storage.integration.test.ts` + migrated `runtime-event-outbox.integration.test.ts` | (a) `openHostState` verifies `PRAGMA cache_size === -65536` and `PRAGMA temp_store === 2`; (b) 16 healthy operations call `statfsSync <= 2` times; (c) within 8 MiB margin / pressured / `snapshot()` measures fresh immediately (existing pinned-WAL test stays green). |
| REQ-P4-01 (1 `set_config`, `client.processID`, cumulative multi-query deadline) | Integration (`maister-web`) | `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts` | (a) Spy on `PoolClient.prototype.query` inside `projectionTransaction` running 5 statements: **0** `pg_backend_pid` queries, **1** `set_config` query (none before `COMMIT`); (b) two sequential `pg_sleep(3)` statements inside one 5 s `projectionTransaction` cancel with `projection_transaction_deadline` and roll back cleanly. |
| REQ-P4-02 + REQ-P4-03 (migration 0376, CHECK, backfill, O(1) due index scan) | Unit + Integration (`maister-web`) | `web/lib/db/__tests__/migration-journal-integrity.test.ts` + `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts` | (a) Journal + snapshot + `db:erd --check` + `drizzle-kit generate` clean; (b) negative `max_available_sequence = -2` rejected by CHECK; (c) with 300 caught-up runs + 1 due run, `EXPLAIN` uses `execution_event_consumers_due_service_idx`, `claimNextExecutionProjection` picks the due run, and returns `null` when caught up; (d) `ingestRuntimeEvent` / `backfillProjectionConsumers` advance `max_available_sequence` monotonically. |
| REQ-P4-04 + REQ-P4-05 (transcript batch coalescing + `firstSupervisorEventId` + `tool_update` + poison fallback) | Integration (`maister-web`) | `web/lib/runs/__tests__/run-transcript-projector.integration.test.ts` | (a) 100-event mixed stream (contiguous `text`, `thought`, `usage`, contiguous `tool_update` on same `toolCallId`, `tool_call` boundary, `steer` boundary) matches per-event projection row-for-row (`content`, `firstSupervisorEventId`, `supervisorEventId`, `sequence`) while executing `<= 15` SQL queries total; (b) unstorable payload on event #37 inside a 50-chunk coalesced batch rolls back savepoint and poisons exact event #37. |
| REQ-P4-06 (cost batch coalescing across multi-model/session + invalid attempt) | Integration (`maister-web`) | `web/lib/runs/__tests__/cost-rollups.integration.test.ts` | Batch of 10 `usage.recorded` events across 2 models/sessions (including 1 foreign `nodeAttemptId`) produces exact `run_cost_rollups` (`byModel`, `bySession`, `byRunner`, `sourceEventCount: 10`) and `node_attempt_cost_rollups` with **1** `refreshRunnerBuckets` execution. |
| REQ-D5-01 (`buildClient` pool defaults & timeouts) | Unit (`maister-web`) | `web/lib/db/__tests__/client.test.ts` | Verifies `buildClient()` passes `max: 25`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000` to `createPostgresPool`, and respects `MAISTER_DB_POOL_MAX` override. |
| REQ-D5-02 (`emitDecisionsDelta` & `runDecisionsDeltaBackstop` under 1-connection pool) | Unit + Integration (`maister-web`) | `web/lib/notifications/__tests__/attention-consumer.test.ts` + `web/lib/notifications/__tests__/attention-consumer.integration.test.ts` | (a) Unit: `emitDecisionsDelta` passes `tx` as 3rd arg to `decisionsFor`; (b) Integration: running `emitDecisionsDelta` and `runDecisionsDeltaBackstop` on a dedicated `max: 1` `pg.Pool` (`connectionTimeoutMillis: 2_000`) with real decisions completes without deadlock. |
| REQ-D5-03 + REQ-D5-04 + REQ-D5-05 (Librarian single-tx card eval, deduplication, savepoint isolation) | Integration (`maister-web`) | `web/lib/librarian/__tests__/governed-confirmations.integration.test.ts` | With 12 governed cards (pending eligible, pending stale/denied, accepted vault, accepted knowledge) executed against a `max: 2` pool (and `prepareKnowledgeCard` call counter), `getLibrarianConversationView` and `getLibrarianWorkView` complete with **0** pool exhaustion, call `prepareKnowledgeCard` once per pending card, isolate denied cards via savepoints, and return exact `pendingCards`, `cards`, `effectPreview`, and `effectLink`. |

---

## Engineering Principles (Enforced in Every REFACTOR Step)

- **SOLID**: Single-responsibility pure helpers (`runtime/host-path-safety.ts`, `transcript-projector.ts` pure batch planner separated from SQL applier, `cost-rollups.ts` pure delta aggregator separated from SQL upsert). Open/closed optional `projectBatch` extension on `ExecutionEventProjector` without breaking existing projectors.
- **KISS**: No speculative abstractions, no background threads, no new queues or caches beyond the exact bounded mechanisms specified.
- **DRY**: Single `runtime/host-path-safety.ts` SSOT shared by supervisor and web; shared savepoint-guarded card-evaluation helper in Librarian rather than duplicated per-card loops.
- **Project Conventions**: `strict: true` (no new `any`), `MaisterError` / `SupervisorError` typed domain errors, structured `pino` logs (no `console.log`, no paths/secrets in logs), `@/*` imports in `web/`, surgical edits only, decomposed shell commands.

---

## Commit Plan

- **Commit 1** (after Phase 0, Task 1): `"docs(event-plane): specify supervisor stream fast-path, projection horizon index, and db pool contracts"`
- **Commit 2** (after Phase 1, Tasks 2–4): `"perf(supervisor): eliminate per-chunk fsync amplification, disk spooling, and statfs overhead"`
- **Commit 3** (after Phase 2, Tasks 5–7): `"perf(web): optimize projection transactions, consumer horizon claim index, and batch coalescing"`
- **Commit 4** (after Phase 3 & Phase 4, Tasks 8–10): `"fix(db): prevent emitDecisionsDelta pool self-deadlock and librarian transaction bursts"`

---

## Tasks

### Phase 0: SDD Specification Freeze (Analytics, API Contracts, DB Schema & Config)

- [x] **Task 1: Freeze SDD specs across system-analytics, AsyncAPI, DB schema/ERD docs, and environment templates**
  - **Deliverable**: Update all canonical documentation and contract artifacts BEFORE writing production code so implementation and tests have one internally consistent source of truth:
    1. `docs/system-analytics/execution-event-plane.md`:
       - Reconcile lines 45–65 & 537: specify tightened POSIX/multi-segment host-path safety (`runtime/host-path-safety.ts`), `captureAcpFrames` in-memory fast-path with `isUtf8` validation and drain spill, chunk-slice SQLite batching (up to 16 ordinary text frames per `<= 64 KiB` chunk in one `BEGIN IMMEDIATE ... COMMIT` under `WAL` + `synchronous = FULL`), `PRAGMA cache_size = -65536` / `temp_store = MEMORY`, and bounded `physicalSnapshot()` amortization (up to 16 ops / 512 KiB only when `!pressured` and > 8 MiB from thresholds; fresh on pressure/threshold/checkpoint/`snapshot()`).
       - Reconcile line 618 + transcript/cost sections: specify `boundedPostgresTransaction` single `set_config` after `BEGIN` + `client.processID` fast-path + cumulative wall-clock `pg_cancel_backend` deadline, `execution_event_consumers.max_available_sequence` + `execution_event_consumers_due_service_idx`, and `projectBatch` coalescing with savepoint-guarded per-event poison fallback.
       - Tag new behaviors `(Designed)` until their owning implementation commits land, then flip to `(Implemented)` in Task 10 (per `docs/CLAUDE.md` R6).
    2. `docs/api/async/execution-host-events.asyncapi.yaml` & `docs/supervisor.md`:
       - Align payload redaction/host-path safety prose with the POSIX-root + multi-segment rule (allowing inline code tokens ` //`, ` /*`, `<div />`, `/api` while keeping host paths and `file://` URIs offloaded/redacted); document in-memory frame fast-path and chunk-slice batching in `docs/supervisor.md`.
    3. `docs/system-analytics/attention.md` & `docs/system-analytics/librarian-conversation.md`:
       - Document `emitDecisionsDelta` single-transaction snapshot invariant (`tx` threaded into `readAttentionDecisionSnapshot`, zero nested outer-pool checkouts) in `attention.md`.
       - Document bounded single-transaction card availability + deduplicated eligible-confirmation set in `librarian-conversation.md`.
    4. `docs/database-schema.md` & `docs/db/execution-hosts-domain.md`:
       - Document `execution_event_consumers.max_available_sequence` (`bigint NOT NULL DEFAULT -1`, `CHECK >= -1`, migration `0376`), partial index `execution_event_consumers_due_service_idx`, and updated `MAISTER_DB_POOL_MAX` default (`25`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`). Add `EXECUTION_EVENT_CONSUMERS` horizon columns/index to `docs/db/execution-hosts-domain.md`.
    5. `docs/configuration.md`, `web/lib/db/README.md`, `.env.example`, `web/.env.sample`, `deploy/maister.env.example`:
       - Update `MAISTER_DB_POOL_MAX` default `10` → `25` and document `connectionTimeoutMillis: 10_000` and `idleTimeoutMillis: 30_000`.
  - **Files**:
    - `docs/system-analytics/execution-event-plane.md`
    - `docs/system-analytics/attention.md`
    - `docs/system-analytics/librarian-conversation.md`
    - `docs/api/async/execution-host-events.asyncapi.yaml`
    - `docs/supervisor.md`
    - `docs/database-schema.md`
    - `docs/db/execution-hosts-domain.md`
    - `docs/configuration.md`
    - `web/lib/db/README.md`
    - `.env.example`
    - `web/.env.sample`
    - `deploy/maister.env.example`
  - **Acceptance Gate**: `pnpm validate:docs` and `pnpm validate:contracts` pass with zero errors.
<!-- Commit checkpoint: Task 1 -->

---

### Phase 1: Supervisor Streaming & SQLite `fsync` Amplification Fix (Finding #3 — TDD)

- [x] **Task 2: [TDD] Extract shared `runtime/host-path-safety.ts` SSOT and coalesce post-rename runtime-object SQLite commit (`REQ-S3-01`, `REQ-S3-02`)** (depends on Task 1)
  - **RED**:
    - Add parameterized host-path parity tests to `supervisor/src/__tests__/runtime-events.test.ts` and `web/lib/execution-host/__tests__/runtime-events.test.ts` asserting code tokens (` //`, ` /*`, `<Button />`, `a / b`, `GET /api`, `https://x.io/a/b`) stay inline while real POSIX roots, multi-segment rooted paths, and `file://` URIs throw/redact.
    - Add integration test in `supervisor/src/__tests__/runtime-storage.integration.test.ts` asserting (a) `publishTextFrame` with ` //` and `<div />` creates **0** `runtime-objects/` files and (b) offloading `/Users/dev/secret.ts` increments `PRAGMA data_version` by 1 across insert + seal.
    - Run unit & integration tests and verify they fail for the expected reasons.
  - **GREEN**:
    - Create `runtime/host-path-safety.ts` exporting `HOST_ABSOLUTE_PATH_PATTERN`, `FILE_URI_PATTERN`, and `containsHostFilesystemPath(value: string): boolean`.
    - Replace duplicated `ABSOLUTE_PATH` / `FILE_URI` in `supervisor/src/runtime-events.ts` and `web/lib/execution-host/runtime-events.ts` with imports from `runtime/host-path-safety.ts`.
    - Add `HostState.sealCapturedRuntimeObject(row, fileId, writtenBytes)` in `supervisor/src/host-state.ts` wrapping `insertRuntimeObject` + `sealRuntimeFile` in one `withRuntimeFileWrite` SQLite transaction, and call it from `RuntimeObjectRegistry.captureProducerBytes` (`supervisor/src/runtime-objects.ts`).
    - In `supervisor/src/runtime-event-publisher.ts` (`sessionPayloadInput`), emit `DEBUG` log `"runtime-event-payload-offloaded"` (`{ runId, hostSessionId, eventType, objectId, sizeBytes }`) when `assertRuntimeEventPayloadSafe` triggers `captureSessionContent`.
  - **REFACTOR**:
    - Verify zero regex duplication across packages, clean types, and zero lint warnings.
  - **Files**:
    - `runtime/host-path-safety.ts`
    - `supervisor/src/runtime-events.ts`
    - `web/lib/execution-host/runtime-events.ts`
    - `supervisor/src/host-state.ts`
    - `supervisor/src/runtime-objects.ts`
    - `supervisor/src/runtime-event-publisher.ts`
    - `supervisor/src/__tests__/runtime-events.test.ts`
    - `web/lib/execution-host/__tests__/runtime-events.test.ts`
    - `supervisor/src/__tests__/runtime-storage.integration.test.ts`
  - **Green Gate**: `pnpm --filter @maister/supervisor test:unit src/__tests__/runtime-events.test.ts`, `pnpm --filter maister-web test:unit lib/execution-host/__tests__/runtime-events.test.ts`, and `pnpm --filter @maister/supervisor test:integration src/__tests__/runtime-storage.integration.test.ts`.

- [x] **Task 3: [TDD] Zero-spool in-memory fast-path, single UTF-8 decode, and bounded chunk-slice SQLite batching (`REQ-S3-03`, `REQ-S3-04`, `REQ-S3-05`)** (depends on Task 2)
  - **RED**:
    - Add unit tests in `supervisor/src/__tests__/bounded-acp-stream.test.ts` asserting:
      1. Complete newline-terminated frames perform **0** `spool.write`/`read`/`truncate` calls and **1** `TextDecoder.decode` call per frame.
      2. Invalid UTF-8 bytes on the fast-path (with `onLine` undefined) reject with `ACP_PROTOCOL`.
      3. `beforeWrite` or `beforeFrame` returning `{ kind: "drain" }` mid-chunk spills exact bytes to `spool` and publishes exact `CapturedStdoutSegment`.
    - Add integration test in `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts` asserting:
      1. A single `<= 64 KiB` stdout chunk with 6 ordinary text-chunk frames followed by a `tool_call` frame commits all 12 text events in **1** SQLite transaction (`PRAGMA data_version` delta = 1) and flushes before the `tool_call`.
      2. A failed event inside a multi-frame `appendRuntimeFrameEvents` batch rolls back all events and TEMP frame-credit spends atomically.
    - Run tests and verify expected RED failures.
  - **GREEN**:
    - In `supervisor/src/bounded-acp-stream.ts`:
      - Keep eager `open(temporary, "wx+", 0o600)`.
      - Inside `captureAcpFrames`, fast-path contiguous complete newline-terminated lines when `length === 0 && newline !== -1 && !draining` (up to `MAX_CHUNK_BATCH_FRAMES = 16` lines within the current `<= 64 KiB` chunk): validate UTF-8 via `isUtf8` (`node:buffer`) when `onLine` is undefined (or single `TextDecoder` when `onLine` is set), write the slice to `input.log` in one `writeChunk`, reserve one batch frame admission (`beforeFrame(sliceBytes, sliceFrameCount)`), spill cleanly to `spool` if `beforeWrite` or `beforeFrame` transitions to `drain`, hold one `acquireDecoder()` permit across yielding each individual `Buffer` frame, and notify slice completion (`onFrameSliceEnd`) in `finally` before releasing decoder/admission.
      - Pass the decoded `line` string from `boundedAcpStream` into `parseFrame(frame, line)` to eliminate the redundant UTF-8 decode.
      - Buffer consecutive ordinary text-update frames in `boundedAcpStream` when inside a multi-frame slice, flushing via `onTextFrameBatch` immediately on slice end or before any non-text frame, tool call, permission, usage, or error.
    - In `supervisor/src/producer-pressure.ts`, `supervisor/src/acp-client.ts`, `supervisor/src/runtime-event-publisher.ts`, `supervisor/src/http-api.ts`, and `supervisor/src/host-state.ts`:
      - Support `rowCount` parameter (default `4`, capped at `34`) on `tryReserveRuntimeFrame` / `reserveFrameCapacity`.
      - Add `RuntimeEventPublisher.publishTextFrames(record, frameEventsList)` calling widened `appendRuntimeFrameEvents` (bounded `1..32` inputs, funded by the slice's TEMP reservation, one `BEGIN IMMEDIATE ... COMMIT`).
      - Add `DEBUG` log in `bounded-acp-stream.ts` on spool spill vs fast-path slice batch (`{ frames, byteLength, draining }`).
  - **REFACTOR**:
    - Extract cohesive pure helpers for scanning a fast-path line slice and spilling bytes to `spool` (DRY between partial and drain-spill paths); ensure zero memory retention of yielded buffers after slice release.
  - **Files**:
    - `supervisor/src/bounded-acp-stream.ts`
    - `supervisor/src/producer-pressure.ts`
    - `supervisor/src/acp-client.ts`
    - `supervisor/src/runtime-event-publisher.ts`
    - `supervisor/src/http-api.ts`
    - `supervisor/src/host-state.ts`
    - `supervisor/src/outbox-budget.ts`
    - `supervisor/src/__tests__/bounded-acp-stream.test.ts`
    - `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts`
  - **Green Gate**: `pnpm --filter @maister/supervisor test:unit src/__tests__/bounded-acp-stream.test.ts` and `pnpm --filter @maister/supervisor test:integration src/__tests__/runtime-event-outbox.integration.test.ts`.

- [x] **Task 4: [TDD] Tune SQLite WAL cache/temp pragmas, add bounded `physicalSnapshot()` amortization, and run Phase 1 full green gate (`REQ-S3-06`)** (depends on Task 3)
  - **RED**:
    - Add integration tests in `supervisor/src/__tests__/runtime-storage.integration.test.ts` asserting `PRAGMA cache_size === -65536`, `PRAGMA temp_store === 2`, and that 16 consecutive healthy writes execute `<= 2` `statfsSync` calls while `snapshot()` and within-8-MiB-margin operations measure fresh immediately.
    - Migrate `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts` (L767–835) to assert the reconciled bounded-amortization contract (replacing exact `admissionMeasurements === 2` / `releaseMeasurements === 1` after 16 healthy loops with assertions covering both amortized reuse and fresh measurement on pressure/checkpoint/`snapshot()`).
    - Run tests and verify RED failures before code change.
  - **GREEN**:
    - In `supervisor/src/host-state.ts` (`openHostState`), set `PRAGMA cache_size = -65536` and `PRAGMA temp_store = MEMORY`.
    - In `supervisor/src/sqlite-storage.ts` (`createSqliteStorage`), implement bounded `physicalSnapshot()` amortization: cache the last `PhysicalStorageSnapshot`, operation count (`<= 16`), and estimated byte delta (`<= 512 KiB`) when `file !== null`, `!pressured`, and all margins exceed `8 MiB`; invalidate and measure fresh immediately on `pressured`, margin `<= 8 MiB`, reservation exceeding remaining margin, checkpoint, failure, or direct `snapshot()`.
  - **REFACTOR**:
    - Keep `canReuseSnapshot` as a small, pure predicate with named constants (`AMORTIZE_MAX_OPS = 16`, `AMORTIZE_MAX_BYTES = 512 * 1024`, `AMORTIZE_MIN_MARGIN_BYTES = 8 * 1024 * 1024`).
  - **Files**:
    - `supervisor/src/host-state.ts`
    - `supervisor/src/sqlite-storage.ts`
    - `supervisor/src/__tests__/runtime-storage.integration.test.ts`
    - `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts`
  - **Phase 1 Exit Criteria (Runnability & Full Supervisor Green Gate)**:
    - `pnpm --filter @maister/supervisor typecheck`
    - `pnpm --filter @maister/supervisor lint`
    - `pnpm --filter @maister/supervisor test:unit`
    - `pnpm --filter @maister/supervisor test:integration src/__tests__/runtime-storage.integration.test.ts src/__tests__/runtime-event-outbox.integration.test.ts`
<!-- Commit checkpoint: Tasks 2-4 -->

---

### Phase 2: Web Event-Plane Projection Pipeline Optimization (Finding #4 — TDD)

- [x] **Task 5: [TDD] Eliminate `2N + 1` SQL round-trips in `projection-transaction.ts` (`REQ-P4-01`)** (depends on Task 1)
  - **RED**:
    - Add integration tests in `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts` asserting:
      1. Running 5 queries inside `projectionTransaction` executes **0** `SELECT pg_backend_pid()` queries (when `client.processID` is populated) and exactly **1** `SELECT set_config(...)` query (after `BEGIN`, never before `COMMIT` or subsequent statements).
      2. Two sequential `SELECT pg_sleep(3)` statements inside one 5 s `projectionTransaction` cancel via `pg_cancel_backend(backendPid)` with `projection_transaction_deadline` and roll back cleanly.
    - Run test and verify test (1) fails RED with 6+ `set_config` and 1 `pg_backend_pid` calls.
  - **GREEN**:
    - In `web/lib/execution-host/events/projection-transaction.ts` (`boundedPostgresTransaction`):
      - Read `const clientProcessId = (client as unknown as { processID?: number }).processID;` directly; fall back to `SELECT pg_backend_pid() AS pid` only when `!Number.isSafeInteger(clientProcessId) || clientProcessId <= 0`.
      - In the `guarded.query` proxy, track `let timeoutsConfigured = false;`, identify control statements with `/^(begin|commit|rollback|abort)\b/i.test(text)`, and execute `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)` once before the first non-control query, keeping `remaining()` checks before every non-rollback query and the cumulative `setTimeout` + `cancelBackend(pool, backendPid)` intact.
  - **REFACTOR**:
    - Keep control-statement classification and PID resolution as small, self-documenting helpers.
  - **Files**:
    - `web/lib/execution-host/events/projection-transaction.ts`
    - `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts`
  - **Green Gate**: `pnpm --filter maister-web test:integration lib/execution-host/events/__tests__/projection-worker.integration.test.ts lib/execution-host/events/__tests__/ingest.integration.test.ts` (including existing `AT-03` blocked-statement test).

- [x] **Task 6: [TDD] Add `execution_event_consumers.max_available_sequence` migration (`0376`), update all 6 writers, and switch `claimNextExecutionProjection` to O(1) due-index scan (`REQ-P4-02`, `REQ-P4-03`)** (depends on Task 5)
  - **RED**:
    - Migrate raw fixture in `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts:368` (`INSERT INTO execution_event_consumers (consumer_name, run_id, max_available_sequence) VALUES ($1, $2, 5)`).
    - Add integration tests in `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts` asserting:
      1. `CHECK` rejects `max_available_sequence = -2`.
      2. `ingestRuntimeEvent` and `backfillProjectionConsumers` advance `max_available_sequence` monotonically via `GREATEST`.
      3. With 300 caught-up historical runs (`last_run_sequence = max_available_sequence`) and 1 due active run, `EXPLAIN (FORMAT JSON)` on the due-claim query uses `execution_event_consumers_due_service_idx`, `claimNextExecutionProjection` selects the active run, and returns `null` once caught up.
    - Run tests and verify RED failures.
  - **GREEN**:
    - Update `web/lib/db/schema.ts` (`executionEventConsumers`): add `maxAvailableSequence: bigint("max_available_sequence", { mode: "bigint" }).notNull().default(-1n)`, `chkMaxAvailableSequence: check("execution_event_consumers_max_available_sequence_check", sql`${t.maxAvailableSequence} >= -1`)`, and partial index `idxDueService: index("execution_event_consumers_due_service_idx").on(t.lastServedAt.asc().nullsFirst(), t.runId, t.consumerName).where(sql`${t.state} <> 'poisoned' AND ${t.maxAvailableSequence} > COALESCE(${t.lastRunSequence}, -1)`)`.
    - Create migration `0376_execution_event_consumer_horizon.sql` (`ALTER TABLE` + `CHECK` + backfill `UPDATE` from `execution_events` + `CREATE INDEX`), update `_journal.json` (`idx: 376`) + `meta/0376_snapshot.json`, and regenerate `docs/db/erd.dbml` via `pnpm --filter maister-web db:erd`.
    - Update all 6 writers:
      1. `web/lib/execution-host/events/projection-consumers.ts` (`seedCanonicalProjectionConsumers(tx, runId, maxAvailableSequence)` with `GREATEST` conflict update)
      2. `web/lib/execution-host/events/ingest.ts` (track max promoted `runSequence` per `runId` and pass to `seedCanonicalProjectionConsumers`)
      3. `web/lib/runs/run-stream-event.ts` (pass `runSequence` to `seedCanonicalProjectionConsumers`)
      4. `web/lib/execution-host/events/projection-worker.ts` (`backfillProjectionConsumers` computes `MAX(run_sequence)` per run and upserts with `GREATEST`, logging `seeded` at `DEBUG`)
      5. `web/lib/execution-host/events/projector.ts` (`ensureConsumer` initializes/advances `maxAvailableSequence` from `execution_events`; `claimNextExecutionProjection` replaces correlated `EXISTS` with `max_available_sequence > COALESCE(last_run_sequence, -1)`)
      6. `web/scripts/import-legacy-execution-data-plane.ts` (upsert `max_available_sequence` with `GREATEST`)
  - **REFACTOR**:
    - Verify `drizzle-kit generate` reports `"No schema changes"`, `migration-journal-integrity.test.ts` passes, and `db:erd --check` passes.
  - **Files**:
    - `web/lib/db/schema.ts`
    - `web/lib/db/migrations/0376_execution_event_consumer_horizon.sql`
    - `web/lib/db/migrations/meta/_journal.json`
    - `web/lib/db/migrations/meta/0376_snapshot.json`
    - `docs/db/erd.dbml`
    - `web/lib/execution-host/events/projection-consumers.ts`
    - `web/lib/execution-host/events/ingest.ts`
    - `web/lib/runs/run-stream-event.ts`
    - `web/lib/execution-host/events/projection-worker.ts`
    - `web/lib/execution-host/events/projector.ts`
    - `web/scripts/import-legacy-execution-data-plane.ts`
    - `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts`
  - **Green Gate**: `pnpm --filter maister-web test:unit lib/db/__tests__/migration-journal-integrity.test.ts`, `pnpm --filter maister-web db:erd --check`, and `pnpm --filter maister-web test:integration lib/execution-host/events/__tests__/projection-worker.integration.test.ts`.

- [x] **Task 7: [TDD] Implement `projectBatch` coalescing in `projector.ts`, `transcript-projector.ts`, and `cost-rollups.ts` + Phase 2 green gate (`REQ-P4-04`, `REQ-P4-05`, `REQ-P4-06`)** (depends on Task 6)
  - **RED**:
    - Add integration tests in `web/lib/runs/__tests__/run-transcript-projector.integration.test.ts` asserting:
      1. Projecting a 100-event mixed stream (contiguous `text`, `thought`, `usage`, contiguous `tool_update` on the same `toolCallId`, `tool_call` boundary, `steer` boundary) executes `<= 15` SQL statements and produces byte-identical `run_messages` (`content`, `firstSupervisorEventId`, `supervisorEventId`, `sequence`) and `run_transcript_states` compared to per-event replay.
      2. Injecting an unstorable payload (`22P05` / surrogate) at event #37 inside a 50-chunk coalesced batch rolls back the savepoint and poisons exact event #37 (not #50).
    - Add integration test in `web/lib/runs/__tests__/cost-rollups.integration.test.ts` asserting that a 10-event `usage.recorded` batch across 2 models/sessions (plus 1 foreign `nodeAttemptId`) produces exact `run_cost_rollups` (`sourceEventCount: 10`, `byModel`, `bySession`, `byRunner`) and `node_attempt_cost_rollups` while calling `refreshRunnerBuckets` once.
    - Run tests and verify RED failures.
  - **GREEN**:
    - In `web/lib/execution-host/events/projector.ts`:
      - Add optional `projectBatch?: (tx: Db, events: readonly ExecutionEvent[], onProgress: (event: ExecutionEvent) => void, softDeadline: number) => Promise<number>` (returning count of events projected before `softDeadline`) to `ExecutionEventProjector` and dispatch to it in `applyClaimedExecutionProjection` after validating `event.runSequence !== null`.
    - In `web/lib/execution-host/events/transcript-projector.ts`:
      - Implement `projectBatch` cleanly split into a pure per-scope coalescing planner (coalescing contiguous `text`, `thought`, `usage`, and same-`toolCallId` `tool_update` ops while preserving `firstEventId`/`lastEventId`, first non-empty `arg`, `\n`-joined `result`s, and exact boundary flushes for `RESET_EVENTS`/`scratchBoundary`/`steerBoundary`/`compaction`/`summary_chunk`/`tool_call`) and a SQL applier (1 `SELECT runs`, 1 batched `SELECT node_attempts`, 1 `lockTranscriptState` per scope, 1 `UPDATE run_transcript_states` per scope).
      - Wrap the coalesced SQL batch in a `tx.transaction` savepoint; on any error (including `UNSTORABLE_SQLSTATES`), roll back the savepoint and replay events sequentially via `projectTranscriptEvent` calling `onProgress(event)` so exact poison event attribution is guaranteed.
      - Emit `DEBUG` log `"transcript-projection-batch-coalesced"` (`{ runId, eventsCount, sqlWrites, coalescedChunks }`).
    - In `web/lib/runs/cost-rollups.ts`:
      - Implement `projectBatch`: query `runs` once, group `usage.recorded` records by `(model, sessionName)` summing token counts and `groupCount`, batch-validate distinct `nodeAttemptId`s in one query (logging `"cost-event-has-no-owned-node-attempt"` for unowned IDs), upsert `run_cost_rollups` per `(model, sessionName)` group with `+ ${groupCount}`, call `refreshRunnerBuckets(tx, runId)` once, and upsert `node_attempt_cost_rollups` once per distinct `(nodeAttemptId, model)`.
  - **REFACTOR**:
    - Verify pure coalescing helpers have zero DB dependencies, single-event `projectTranscriptEvent` remains clean for direct callers, and no duplicate merge logic exists.
  - **Files**:
    - `web/lib/execution-host/events/projector.ts`
    - `web/lib/execution-host/events/transcript-projector.ts`
    - `web/lib/runs/cost-rollups.ts`
    - `web/lib/runs/__tests__/run-transcript-projector.integration.test.ts`
    - `web/lib/runs/__tests__/cost-rollups.integration.test.ts`
  - **Phase 2 Exit Criteria (Runnability & Green Gate)**:
    - `pnpm --filter maister-web test:unit lib/db/__tests__/migration-journal-integrity.test.ts`
    - `pnpm --filter maister-web db:erd --check`
    - `pnpm --filter maister-web test:integration lib/execution-host/events/__tests__/projection-worker.integration.test.ts lib/runs/__tests__/run-transcript-projector.integration.test.ts lib/runs/__tests__/cost-rollups.integration.test.ts`
<!-- Commit checkpoint: Tasks 5-7 -->

---

### Phase 3: Database Pool Sizing, `emitDecisionsDelta` Deadlock Fix & Librarian Read-Model Consolidation (Finding #5 — TDD)

- [ ] **Task 8: [TDD] Configure `pg.Pool` defaults/timeouts and thread transaction `tx` through `emitDecisionsDelta` (`REQ-D5-01`, `REQ-D5-02`)** (depends on Task 1)
  - **RED**:
    - Add unit test in `web/lib/db/__tests__/client.test.ts` asserting `buildClient()` configures `{ max: 25, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }` by default and honors `MAISTER_DB_POOL_MAX`.
    - Add unit test in `web/lib/notifications/__tests__/attention-consumer.test.ts` asserting `emitDecisionsDelta` passes the active `tx` as the 3rd argument to `decisionsFor`.
    - Add integration test in `web/lib/notifications/__tests__/attention-consumer.integration.test.ts` running `emitDecisionsDelta` and `runDecisionsDeltaBackstop` against a **`max: 1` `pg.Pool`** (`connectionTimeoutMillis: 2_000`) — verify it fails RED by timing out (proving the self-deadlock!).
  - **GREEN**:
    - In `web/lib/db/client.ts` (`buildClient`): set `max: Number(process.env.MAISTER_DB_POOL_MAX ?? 25)`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`, and include them in the `"db client init"` `INFO` log.
    - In `web/lib/notifications/attention-consumer.ts` and `web/lib/notifications/digest-trigger.ts`: widen `decisionsFor` to `(userId: string, role: "admin" | "member" | "viewer", tx?: Db) => Promise<AttentionDecisionSnapshot>`, invoke `await decisionsFor(userId, role, tx)` inside `emitDecisionsDelta`, and update both default production callbacks to `readAttentionDecisionSnapshot(tx ?? client, userId, role)`.
  - **REFACTOR**:
    - Verify existing 2-arg stubs in `attention-consumer.test.ts` pass unmodified and zero outer-pool leaks exist in `computeDecisionsQueue` sub-queries.
  - **Files**:
    - `web/lib/db/client.ts`
    - `web/lib/notifications/attention-consumer.ts`
    - `web/lib/notifications/digest-trigger.ts`
    - `web/lib/db/__tests__/client.test.ts`
    - `web/lib/notifications/__tests__/attention-consumer.test.ts`
    - `web/lib/notifications/__tests__/attention-consumer.integration.test.ts`
  - **Green Gate**: `pnpm --filter maister-web test:unit lib/db/__tests__/client.test.ts lib/notifications/__tests__/attention-consumer.test.ts` and `pnpm --filter maister-web test:integration lib/notifications/__tests__/attention-consumer.integration.test.ts lib/notifications/__tests__/digest-trigger.integration.test.ts`.

- [ ] **Task 9: [TDD] Eliminate Librarian 50-way transaction burst, duplicate `prepareKnowledgeCard` work, and nested vault transactions (`REQ-D5-03`, `REQ-D5-04`, `REQ-D5-05`)** (depends on Task 8)
  - **RED**:
    - Add integration test in `web/lib/librarian/__tests__/governed-confirmations.integration.test.ts` with ≥ 12 governed cards (mix of pending eligible, pending stale/denied, accepted vault, accepted knowledge) running `getLibrarianConversationView` and `getLibrarianWorkView` against a **`max: 2` `pg.Pool`** (with `connectionTimeoutMillis: 2_000`) and spying on `prepareKnowledgeCard` call counts: verify RED fails on pool contention / duplicate `prepareKnowledgeCard` invocations.
  - **GREEN**:
    - In `web/lib/librarian/read-models.ts`:
      - Add optional `options?: { eligiblePendingCardIds?: ReadonlySet<string> }` to `getLinkedWork`.
      - Replace `Promise.all(cardRows.map(... db.transaction ...))` with **one** shared `await db.transaction(async (tx) => ...)` evaluating governed cards sequentially with per-card `tx.transaction` savepoints (catching `MaisterError` cleanly):
        - Pending cards with `options?.eligiblePendingCardIds`: O(1) `options.eligiblePendingCardIds.has(card.id) && (projectId ? visibleById.has(projectId) : true)`.
        - Pending cards without `eligiblePendingCardIds` (direct callers): `prepareKnowledgeCard` + `matchesGovernedCardEffect` inside a savepoint on `tx`.
        - Non-pending governed cards: `authorizeSourceRestrictions` inside a savepoint on `tx`.
      - Update `governedEffectLink(tx, ...)` to run `resolveLibrarianVault` directly on `tx` (inside a savepoint) instead of opening a new top-level `db.transaction` per vault card.
      - Include `reusedEligibleSet: Boolean(options?.eligiblePendingCardIds)` in `"linked work loaded"` `DEBUG` log.
    - In `web/lib/librarian/view.ts` (`getLibrarianConversationView`):
      - Await `readEligibleConfirmationIds(db, conversation)` first, construct `eligible = new Set(eligibleIds)`, and pass `{ eligiblePendingCardIds: eligible }` into `getLinkedWork`.
    - In `web/lib/librarian/confirmation-availability.ts` (`readEligibleConfirmationIds`):
      - Evaluate the governed `isKnowledgeCardProposal` candidates inside a single outer `db.transaction` with per-card `tx.transaction` savepoints (safe both standalone and nested inside `getLibrarianWorkView`'s `repeatable read` `tx`).
  - **REFACTOR**:
    - Extract a cohesive savepoint helper (`withCardSavepoint`) to eliminate duplicated `tx.transaction` + `isMaisterError` catch boilerplate across `read-models.ts` and `confirmation-availability.ts` (DRY).
  - **Files**:
    - `web/lib/librarian/read-models.ts`
    - `web/lib/librarian/view.ts`
    - `web/lib/librarian/confirmation-availability.ts`
    - `web/lib/librarian/__tests__/governed-confirmations.integration.test.ts`
  - **Phase 3 Exit Criteria (Runnability & Green Gate)**:
    - `pnpm --filter maister-web test:integration lib/librarian/__tests__/governed-confirmations.integration.test.ts lib/notifications/__tests__/attention-consumer.integration.test.ts`
<!-- Commit checkpoint: Tasks 8-9 -->

---

### Phase 4: Final Contract Alignment, Full Verification & Quality Gate

- [ ] **Task 10: Flip Phase 0 status tags to `(Implemented)` and pass all repo typecheck, lint, test, migration, ERD, docs, and contract gates** (depends on Tasks 4, 7, 9)
  - **Deliverable**:
    1. Flip the new `(Designed)` tags added in Task 1 inside `docs/system-analytics/execution-event-plane.md`, `docs/system-analytics/attention.md`, `docs/system-analytics/librarian-conversation.md`, and `docs/db/execution-hosts-domain.md` to `(Implemented)` so HEAD docs match shipped code 100% (per `docs/CLAUDE.md` R6).
    2. Verify every requirement (`REQ-S3-01..06`, `REQ-P4-01..06`, `REQ-D5-01..05`) against the final diff and ensure zero unused code, zero `any` regressions, zero `console.log`, and clean SOLID/KISS/DRY structure.
    3. Run every required validation gate (each as a decomposed command):
       - `pnpm --filter @maister/supervisor typecheck`
       - `pnpm --filter @maister/supervisor lint`
       - `pnpm --filter @maister/supervisor test:unit`
       - `pnpm --filter @maister/supervisor test:integration`
       - `pnpm --filter maister-web typecheck`
       - `pnpm --filter maister-web lint`
       - `pnpm --filter maister-web test:unit`
       - `pnpm --filter maister-web db:erd --check`
       - `pnpm --filter maister-web exec drizzle-kit generate` (verify `"No schema changes"`)
       - Focused web integration suites:
         - `projection-worker.integration.test.ts`
         - `ingest.integration.test.ts`
         - `run-transcript-projector.integration.test.ts`
         - `cost-rollups.integration.test.ts`
         - `attention-consumer.integration.test.ts`
         - `digest-trigger.integration.test.ts`
         - `governed-confirmations.integration.test.ts`
       - `pnpm validate:docs`
       - `pnpm validate:contracts`
  - **Files**:
    - `docs/system-analytics/execution-event-plane.md`
    - `docs/system-analytics/attention.md`
    - `docs/system-analytics/librarian-conversation.md`
    - `docs/db/execution-hosts-domain.md`
<!-- Commit checkpoint: Task 10 -->
