# Implementation Plan: Stage B — Durable Execution-Host Event and Runtime-Data Plane

**Branch:** `feature/stage-b-durable-execution-host-data-plane`
**Baseline:** `06aa7f7e137773cb31d55610148fe138f14c7be8` (Stage A complete)
**Created:** 2026-09-04
**Mode:** Full · SDD-first · TDD RED → GREEN → REFACTOR · dependency-ordered

## Settings

- **Testing:** YES. Use real Postgres and the real supervisor process with the
  fake ACP adapter for durability, restart, fencing, and transport invariants.
  Use unit tests only for pure envelope validation, redaction, sequence, and
  range parsing. Every normative requirement and edge case has one owning test
  lane; redundant and assertion-free tests are forbidden. Every implementation
  task follows RED → GREEN → REFACTOR and records the failing RED evidence.
- **Logging:** VERBOSE. Every new boundary emits structured fields; payloads,
  prompts, environment values, credentials, raw filesystem paths, and artifact
  content are never logged. Exact logging requirements are repeated per task.
- **Documentation:** YES. Phase B0 writes the designed contracts and ADR before
  implementation. B4 changes their status to as-built only after the final
  cutover and verification.

## Roadmap linkage

**Milestone:** none. The current roadmap has no named Stage B or durable
execution-host data-plane milestone, and the request does not ask to change the
roadmap. This plan is linked instead to ADR-023, ADR-166, and the completed
Stage A plan.

**Research context:** none supplied. The evidence base is the repository at the
baseline commit, especially `docs/decisions/adr-023.md`,
`docs/decisions/adr-166.md`, and
`.ai-factory/plans/claude-stage-a-execution-host-plan-6d70f9.md`.

### Preflight identifiers at plan time

| Namespace | Current at baseline | Implementation rule |
| --- | --- | --- |
| ADR | ADR-166 is highest; ADR-167 is the current candidate | Recheck `main`, create the next-number stub first, then cite it; renumber after rebase if needed. |
| Drizzle migration | journal/snapshot `0130_execution_hosts` is newest; `0131` is current candidate | Generate additive event, additive object, and destructive cleanup migrations in dependency order; allocate actual next numbers at implementation time. |
| Supervisor OpenAPI / SSE AsyncAPI | `0.8.0` | Bump to `0.9.0` when Stage B routes/events land. |
| Web OpenAPI / run SSE AsyncAPI | `0.10.0` / `0.8.0` | Bump to `0.11.0` / `0.9.0` when manager routes/cursors change. |
| New host-global AsyncAPI | none | Publish `execution-host-events.asyncapi.yaml` once at `1.0.0`; compatibility is a per-run mode, not contract-version churn. |

## Goal

Make Postgres-backed control-plane state the canonical durable source for
execution events, command completion, session history, transcripts, costs, and
runtime-object metadata. Execution hosts continue to own ACP processes and
their private runtime files. The web tier must not read the execution host's
runtime filesystem after the bounded B4 cutover.

The default installation remains one web process, one local supervisor, and
Postgres. It gains no enrollment service, relay, object store, distributed
lease, or operator setup.

## Scope boundary

### As-built Stage A

- `web/lib/execution-host/` is the sole manager-to-host command boundary.
- `execution_hosts`, `execution_assignments`, and `execution_commands` provide
  durable identity, assignment epochs, command IDs, receipts, retries, and
  fencing.
- `WorkspaceHandle` is opaque to domain callers, but the supervisor still owns
  path-bearing runtime state.
- Same-host checkpoint/resume is supported.
- `POST /sessions/{id}/prompt` is still a long-lived request; its in-process
  `PromptHandle` is not recoverable.
- The manager still reads `run.events.jsonl`, `cost.jsonl`, logs, and file
  artifacts by path.

### Stage B owns

- Durable host event outbox, manager ingestion, replay, acknowledgement,
  ordering, gap handling, fencing, retention, redaction, and observability.
- Canonical manager projections and browser replay from Postgres.
- Async prompt acceptance and durable terminal reconciliation using the Stage A
  command ledger.
- Typed path-free runtime-object metadata and content access.
- Immutable host-session incarnation history.
- Bounded legacy import/cutover and removal of
  `scratch_runs.supervisor_session_id`.

### Deferred Stage C/D

- Repository clone/materialization, worktree creation, Git diff/log/checkpoint
  refs, checks, promotion, and repository-side evidence remain manager-local
  until Stage C.
- Multiple-host placement, distributed assignment leases, cross-host ACP
  resume, host administration UI, trusted enrollment/authentication, and a
  remote relay remain Stage C/D.
- Object-store deployment, cloud execution, multi-repository orchestration,
  fleet/swarm coordination, and long-term platform-agent memory remain out of
  scope.

## Critical findings that constrain the design

1. **Current supervisor SSE is not durable.**
   `supervisor/src/registry.ts:SessionRegistry` retains only 1,000 events per
   live session in memory and removes terminal sessions shortly afterward.
   `GET /sessions/{id}/stream` cannot replay through a supervisor restart.
2. **`run.events.jsonl` has no safe run-global sequence.**
   `supervisor/src/spawn.ts:tailMaxMonotonicId()` scans the last 64 KiB and each
   session then allocates its own counter. Concurrent sessions can reuse or
   reorder IDs. The file append in `supervisor/src/events-log.ts` is not fsynced
   and logs, rather than fails, on backpressure/error.
3. **The browser and projections still poll/read the host filesystem.**
   `web/app/api/runs/[runId]/stream/route.ts` polls every 100 ms;
   `artifact-projector.ts`, `run-transcript-projector.ts`, `cost-rollups.ts`,
   `inbox-context.ts`, and `scratch-runs/available-commands.ts` read host files
   directly. Malformed lines are frequently skipped rather than surfaced.
4. **Stage A completion is only partly durable.**
   `execution_commands` and supervisor receipts are durable, but
   `web/lib/execution-host/signals.ts` is process-local and
   `deliverer.ts:PromptHandle.completion` depends on the long HTTP response or
   current-process signals. A web restart can fold a receipt without applying
   the correct owning Flow/scratch/gate/agent continuation.
5. **`run_sessions` is logical, not historical.** Its unique
   `(run_id, session_name)` row is overwritten on respawn. Stage B needs an
   immutable host-session incarnation record before it can preserve historical
   scratch associations.
6. **Health and prompt contracts cannot be changed in place during rolling
   upgrade.** Both sides parse strict `protocolVersion: 1` health schemas, and
   old web expects a terminal response from `/prompt`. Capability discovery
   and async prompt admission must therefore be additive through B0-B3.
7. **ADR-023 remains authoritative.** A supervisor URL does not prove a split
   data plane. The current single-host deployment still shares runtime paths.
8. **Not all `.maister/` files are host runtime data.** Web-owned Flow inputs,
   HITL state, Evaluation Lab evidence, and repository/worktree/Git data are
   separate ownership domains. Moving them would silently expand Stage B into
   Stage C.

## Specification-driven development contract

### Specification hierarchy and change rule

Stage B implementation is driven in this order:

1. the new ADR fixes ownership, semantics, compatibility, and deferred scope;
2. OpenAPI 3.0.3 and AsyncAPI 2.6.0 define every HTTP/SSE wire shape;
3. the system-analytics expectations below define domain behavior and edge
   cases without duplicating wire schemas;
4. the Drizzle schema plus generated SQL, migration journal, and snapshot define
   persistence;
5. tests prove the requirements before production behavior is added.

Changing a requirement requires updating its expectation, contract/schema when
affected, traceability row, owning test, and ADR when the decision changes in
the same commit. No implementation-only behavior or undocumented fallback is
allowed. `Designed` becomes `Implemented` only after its acceptance criterion
and owning test are green.

### Normative event-plane requirements

- **EVT-01 — Canonical ownership:** Postgres is the canonical manager event log;
  browsers and projectors never derive state from supervisor memory or runtime
  files.
- **EVT-02 — Durable publication:** the host commits a redacted, validated event
  to its SQLite outbox before publication or terminal acknowledgement.
- **EVT-03 — Idempotence:** at-least-once delivery produces exactly one canonical
  event, and conflicting reuse of either event ID or stream position is a typed
  protocol failure.
- **EVT-04 — Ordering:** host order is `(streamId, sequence)` and manager/run
  order is `runSequence`; timestamps never determine state-transition order.
- **EVT-05 — Fencing:** stale assignment epochs are retained as audit facts and
  ACKable but receive no current-run sequence and cannot mutate current state.
- **EVT-06 — Gaps:** the manager persists later events as pending, ACKs only the
  contiguous prefix, requests the missing sequence, and fails explicitly when
  the replay floor has passed it.
- **EVT-07 — Restart:** host and manager restart from durable outbox and
  contiguous watermarks; acknowledgement loss causes replay, not loss or a
  duplicate projection.
- **EVT-08 — Payload safety:** only negotiated event type/schema pairs are
  canonically accepted, known payloads are redacted before persistence, and raw
  secret-bearing or oversized payloads are never stored or logged.
- **EVT-09 — Backpressure:** bounded outbox pressure rejects new mutating
  admissions before existing session events can be lost and exposes a typed
  readiness reason.
- **EVT-10 — Projection isolation:** each projector has its own durable per-run
  cursor and poison state; projection failure never rolls back accepted ingest.
- **EVT-11 — Replay:** browser replay is exclusive-after-cursor, bounded,
  authorization checked, and sourced only from canonical user-safe rows.
- **EVT-12 — Retention:** canonical events live with the run in Stage B; host
  outbox rows prune only after manager ACK plus grace, and destructive event
  compaction is disabled until a later ADR.

### Normative prompt-lifecycle requirements

- **PRM-01 — Admission:** `session.prompt` returns accepted only after the Stage
  A command receipt and `prompt.accepted` event are durable on the host.
- **PRM-02 — Single side effect:** retries reuse the command ID, logical
  operation key, and canonical request digest; no duplicate delivery can invoke
  ACP twice.
- **PRM-03 — Async authority:** progress, terminal events, and the queryable
  receipt are authoritative; an HTTP connection lifetime is never lifecycle
  state.
- **PRM-04 — Durable continuation:** every prompt command records exactly one
  typed owner and terminal application is idempotent across web restart.
- **PRM-05 — Restart loss:** an accepted prompt without a live turn after host
  restart becomes `turn_lost`; prompt text is never replayed automatically.
- **PRM-06 — Terminal agreement:** receipt and terminal event must agree on
  command, assignment, epoch, and outcome or be quarantined and reconciled.
- **PRM-07 — Session exit:** exit/crash/cancellation terminalizes any accepted
  prompt before or atomically with the session terminal event.
- **PRM-08 — HITL:** permission pause, decision, checkpoint, and resume remain
  durable and fenced; resume creates a new command and, when required, a new
  session incarnation.
- **PRM-09 — Cancellation:** cancellation uses the existing command ledger and
  produces one terminal prompt outcome regardless of retries or lost ACKs.
- **PRM-10 — Stale epoch:** fencing occurs before ACP and yields a durable
  `fenced` receipt/audit event without owner mutation.
- **PRM-11 — Queryability:** a serializable `PromptHandle` resolves through
  Postgres command/event state and remains usable after process restart.
- **PRM-12 — Retention:** prompt receipts prune only after canonical terminal
  ACK, owner application, terminal run state, and replay grace.

### Normative runtime-object requirements

- **OBJ-01 — Path-free boundary:** manager contracts and catalogs contain opaque
  object IDs and typed metadata, never a host filesystem path.
- **OBJ-02 — Authorization:** web derives host, run, assignment, epoch, and
  object association from authorized Postgres state; a client cannot select a
  cross-resource host or object binding.
- **OBJ-03 — Upload durability:** reserve/upload/delete reuse Stage A command
  IDs, receipts, retry state, and fences instead of a parallel side-effect
  ledger.
- **OBJ-04 — Integrity:** a sealed object has immutable size, SHA-256, MIME,
  generation, and binding; retries with different invariants are conflicts.
- **OBJ-05 — Atomic bytes:** uploads use private temporary files, verify declared
  size/hash, and atomically rename before the available event/receipt.
- **OBJ-06 — Bounded reads:** content supports bounded streaming and one byte
  range with strong ETag; invalid/unsatisfiable ranges fail with typed errors.
- **OBJ-07 — Missing states:** unknown/cross-boundary, tombstoned/expired,
  corrupt, and oversized objects are distinct typed outcomes and never empty
  success bodies.
- **OBJ-08 — Redaction:** object content, host paths, prompts, and secrets never
  enter logs or event payloads; content metadata is allowlisted.
- **OBJ-09 — Ownership:** canonical events/messages/cost/catalog state are
  manager-owned; raw logs, large generated content, and host diagnostics remain
  host-owned unless explicitly uploaded.
- **OBJ-10 — Result/evidence separation:** structured result transport remains
  distinct from verifier evidence payload storage and required missing evidence
  fails explicitly.
- **OBJ-11 — Deletion:** the host commits a durable tombstone before unlinking;
  repeated delete is idempotent and catalog state follows the event.
- **OBJ-12 — Retention:** manager metadata survives missing/deleted bytes and
  content deletion is gated by existing run/artifact delivery retention.

### Normative cutover and recovery requirements

- **CUT-01 — Immutable mode:** each run is admitted once as
  `legacy_file_v1` or `canonical_events_v1`; no per-call fallback exists.
- **CUT-02 — Rolling compatibility:** supervisor-first and web-first upgrades
  preserve legacy active runs while new canonical runs require the complete
  advertised capability set.
- **CUT-03 — Historical visibility:** completed legacy runs are imported
  idempotently or retain an explicit missing/failed status and remain viewable.
- **CUT-04 — Active-run safety:** B4 starts only after new legacy admission is
  disabled and all active legacy runs are drained.
- **CUT-05 — Association preservation:** scratch session mirrors and file
  locators are removed only when their canonical association is uniquely
  proven; conflict or ambiguity aborts migration.
- **CUT-06 — No dual authority:** compatibility writes and reads are removed in
  a bounded release; canonical runs never consult legacy files.
- **CUT-07 — Partial failure:** import, projection, and object migration record
  durable per-run/object status and resume from it after failure.
- **CUT-08 — Manager recovery:** reconciliation is idempotent after DB commit,
  transport loss, host restart, or manager restart and never infers terminal
  success from absence.
- **CUT-09 — Mount-free web:** the final web service starts and serves history,
  SSE, prompt completion, costs, and artifacts without the host runtime-data
  mount.
- **CUT-10 — Single-host default:** compose requires no enrollment, relay,
  object store, or additional operator action.
- **CUT-11 — Stage A compatibility:** deferred release, receipt recovery,
  fencing, checkpoint, HITL resume, cancellation, and completion do not regress.
- **CUT-12 — Deferred boundaries:** repository/Git/worktree authority,
  multi-host placement, remote trust, and cross-host ACP resume remain Stage
  C/D and gain no accidental Stage B dependency.

### Edge-case and error specification

| ID | Condition | Required result / stable reason | Primary proof |
| --- | --- | --- | --- |
| `EDGE-EVT-01` | duplicate event with identical invariants | No-op insert, repeat current contiguous ACK, `duplicate_identical`. | `IT-EVT-03` / T1.3 |
| `EDGE-EVT-02` | same event ID or stream position with different bytes/spine | Do not ACK past it; degrade stream, `event_identity_conflict`. | `IT-EVT-03-CONFLICT` / T1.3 |
| `EDGE-EVT-03` | missing sequence is below host replay floor | Mark affected stream recovery-required and run failed/recoverable, `event_gap_unrecoverable`. | `IT-EVT-06-FLOOR` / T1.2–T1.3 |
| `EDGE-EVT-04` | ACK arrives after host stream replacement/restart | Reject because supplied `streamId` is not current, `event_stream_mismatch`. | `IT-EVT-07-ACK-RACE` / T1.2 |
| `EDGE-EVT-05` | invalid decimal sequence, overflow, future clock, or skew | Reject invalid sequence with `invalid_event_sequence`; accept valid timestamp as metadata without ordering authority and record skew metric. | `CT-EVT-05` / T0.3 and `IT-EVT-04-CLOCK` / T1.3 |
| `EDGE-EVT-06` | unknown type/schema or redaction failure | Store only bounded spine/error metadata, never raw payload or its digest; `unsupported_event_schema` or `event_redaction_failed`. | `CT-EVT-08` / T0.3 and `IT-EVT-08-QUARANTINE` / T1.3 |
| `EDGE-PRM-01` | 202 response or terminal ACK is lost | Reconcile by original command ID; no second ACP call. | `IT-PRM-02-ACK-LOSS` / T3.1–T3.2 |
| `EDGE-PRM-02` | host restarts with accepted command and no live turn | Durable `turn_lost`; manager applies recovery policy. | `IT-PRM-05` / T3.1 |
| `EDGE-PRM-03` | receipt and event terminal outcomes disagree | Quarantine and stop owner application, `prompt_terminal_conflict`. | `IT-PRM-06` / T1.4–T3.2 |
| `EDGE-OBJ-01` | traversal, symlink escape, or client-selected foreign binding | Reject without existence disclosure, `runtime_object_not_found` or `runtime_object_invalid`. | `IT-OBJ-02-PATH` / T3.4–T3.5 |
| `EDGE-OBJ-02` | range is multi-range, malformed, or outside content | `416 runtime_object_range_unsatisfiable`; no full-body fallback. | `IT-OBJ-06` / T3.4 |
| `EDGE-OBJ-03` | retry has different size/hash/MIME/generation | Preserve original object, `runtime_object_identity_conflict`. | `IT-OBJ-04-CONFLICT` / T3.4 |
| `EDGE-CUT-01` | legacy import has malformed line or conflicting association | Mark import failed with source position/hash; block B4, no silent skip. | `IT-CUT-07-MALFORMED` / T4.1 |
| `EDGE-CUT-02` | legacy scratch mirror has no canonical row but is uniquely provable | Create the canonical legacy incarnation with provenance; ambiguity/conflict aborts. | `IT-CUT-05-SCRATCH` / T4.3 |

### Protocol constants

These are versioned contract constants, not environment knobs in Stage B:

| Constant | Stage B value | Enforcement |
| --- | --- | --- |
| Sequence wire format | canonical unsigned decimal string `^(0|[1-9][0-9]{0,18})$`, maximum `9223372036854775807` | OpenAPI/AsyncAPI pattern + Zod transform to `bigint` + SQLite/Postgres signed `BIGINT`. |
| Maximum encoded event envelope | 1 MiB UTF-8 | Host before outbox; manager before payload parsing/persistence. |
| Open JSON structural bounds | depth 16, 256 keys per object, 1,024 elements per array, 64 KiB UTF-8 per string | Mirrored host/manager redactor/validator before persistence. |
| Host outbox soft limit | 80,000 unacknowledged rows or 400 MiB, whichever comes first | Host readiness becomes backpressured and rejects new mutating admissions. |
| Host outbox hard partition | 100,000 rows or 512 MiB plus a separate 1,024-row/16 MiB terminal reserve | Non-terminal production pauses at the hard partition; terminal/control events consume only the reserve; reserve exhaustion makes the host unavailable without dropping a committed event. |
| Manager-to-host object upload | 25 MiB per object and 100 MiB per command batch | Capability document and streaming byte counter; host-produced larger objects remain range-readable. |
| Content range page | one range, maximum 8 MiB response | Supervisor content route and web proxy. |
| Projection poison attempts | 5 with durable exponential backoff capped at 5 minutes | Consumer row; deterministic validation failures poison immediately. |
| Host outbox replay grace | 24 hours after confirmed ACK | SQLite prune job; unacknowledged rows are never pruned. |

### Traceability and TDD proof rule

The implementation must maintain a machine-readable-or-tabular matrix in this
plan and the four new system-analytics documents with columns `requirement`,
`contract/schema`, `enforcement`, `primary test`, and `status`. The primary test
must name the mutation it kills. Existing regression tests are supporting
guards, not substitutes for RED evidence. A RED test that already passes is not
accepted unless the implementation is first locally mutated/reverted so the
test demonstrably fails for the intended invariant.

Test ownership is non-overlapping:

- unit: decimal sequence/range parsing, deterministic IDs, redaction and pure
  state reducers only;
- supervisor integration: SQLite durability, outbox pressure, ACP side-effect
  deduplication, object path/integrity, and host restart;
- web integration with real Postgres: ingest/ordering/fencing, projector
  cursors, continuation CAS, authorization, migrations, and imports;
- cross-process integration: real supervisor HTTP/SSE plus web transport and
  restart/ACK-loss behavior;
- Playwright E2E: only user-visible launch, streaming, HITL, checkpoint/resume,
  cancellation, completion, history, and artifact download outcomes.

## Complete filesystem-cut inventory

The implementation begins by turning this table into a checked repository
inventory. A B4 grep gate must show no unclassified production read of an
execution-host runtime path.

| Current object / interaction | Concrete readers or writers | Current authority | Stage B disposition |
| --- | --- | --- | --- |
| `run.events.jsonl` host append | `supervisor/src/events-log.ts`, `registry.ts`, `spawn.ts`, `http-api.ts`, `heartbeat.ts` | Best-effort host file | Replace authority with durable host SQLite outbox; legacy file dual-write only for immutable legacy-mode runs through B3, then remove from lifecycle authority. |
| `run.events.jsonl` manager append | `web/lib/runs/run-stream-event.ts`, called from `web/lib/services/runs.ts` and `web/lib/flows/graph/runner-graph.ts` | Manager file append with scanned monotonic ID | Append manager-originated warnings/retry events directly to canonical `execution_events` using server-derived run/assignment data. |
| Browser run SSE and replay | `web/app/api/runs/[runId]/stream/route.ts`, `web/lib/use-run-stream.ts` | File polling plus DB status heartbeat | Replay by canonical `run_sequence`; use DB notification only as a wake hint. No file polling. |
| Artifact projection cursor | `web/lib/projector/artifact-projector.ts`; `artifact_projection_cursors.events_log_path` | Whole file and path-bearing cursor | Project canonical events with durable consumer cursor; remove path column/table in B4. |
| Transcript projection/feed | `web/lib/runs/run-transcript-projector.ts`, transcript route/read models | Whole event file and mtime | Project from canonical events into `run_messages`; query manager DB only. |
| Last activity / inbox context | `web/lib/queries/inbox-context.ts` | Event-file stat/read | Use canonical event/session projection timestamps. |
| Scratch command availability | `web/lib/scratch-runs/available-commands.ts` | Event-file scan | Query canonical lifecycle/session projection. |
| `cost.jsonl` | `supervisor/src/cost.ts`; `web/lib/runs/cost-rollups.ts`, cost reconciliation/summaries | Host append; manager reconstructs by path | Persist redacted usage events and canonical cost facts/rollups in Postgres. Keep host file only as local diagnostic during compatibility; never manager-read after B4. |
| Raw step/session logs such as `<stepId>.log` | `supervisor/src/spawn.ts`; default/file artifact construction in `web/lib/flows/graph/runner-graph.ts` | Host file, but manager infers and reads path | Register an opaque runtime object with metadata; proxy typed content/range requests through host API. |
| ACP transcript/update payloads | supervisor registry/event file; transcript projector | Mixed live SSE and file | Canonical redacted events plus `run_messages`; raw diagnostic transcript, if retained, stays a host runtime object. |
| Permission/HITL snapshots | `web/lib/scratch-runs/events.ts`, `web/lib/services/hitl.ts`; current snapshots may include `supervisorSessionId` | Manager DB/event data with duplicated target | Keep human decision data manager-owned; replace targeting authority with server-derived canonical run-session/incarnation or command reference. Historical IDs may remain immutable audit data only. |
| Checkpoint/recovery metadata | `runs.checkpoint_at`, `run_sessions.acp_session_id`, command receipts, `session.exited` reason | Mixed manager DB and host live session | Canonicalize checkpoint command/result/events and session incarnation state. There is no generic checkpoint file to invent. |
| Git checkpoint ref | `node_attempts.checkpoint_ref` and Flow/recovery Git paths | Manager/repository | Explicitly defer; this is a Git ref, not execution-host runtime content. |
| Generated/evidence file artifacts under a host run directory | artifact locators `{kind:"file",path}`, payload route, artifact content resolver | Host path exposed indirectly to web | Add `{kind:"execution-object", objectId}`; migrate only host-owned files after checksum/association proof. |
| Plan-review staging/output | `web/lib/flows/graph/plan-review-artifact.ts`, `runner-graph.ts` output env/materialization | Agent writes a host runtime path; web validates/copies by path | Allocate host output objects, let the host inject private paths into the ACP process, seal/checksum on turn completion, and read through object API. |
| Runner output/evidence (`MAISTER_OUTPUT_FILE`, `output-<node>-<attempt>.json`) | `web/lib/flows/graph/node-output.ts`, `runner-graph.ts`, verifier collection | Path is supplied to the executor and later manager-read | Keep result transport semantically separate from evidence payloads; allocate typed output/evidence objects and configure the tool explicitly. Git/check orchestration remains Stage C. |
| Scratch uploads / ACP file blocks | `web/lib/scratch-runs/service.ts`, `attachments.ts`; supervisor prompt validation | Web writes host runtime bytes and sends `file://` path | Stream upload to an allocated host object, then send an opaque attachment reference; host alone resolves it to an ACP-local file path. |
| Scratch capability profile | `scratch_capability_profiles.materialized_path`, scratch launch/recover | Persisted path is resent to supervisor | Store canonical profile bytes/hash manager-side; upload or reference a host object per session and stop treating `materialized_path` as cross-boundary authority. |
| Agent memory/provenance snapshot | `web/lib/agents/launch.ts` writes `memory-snapshot.md` in run directory | Web writes host runtime file | Create through typed runtime-object upload with catalog metadata; no shared path. |
| Git range/log artifact locators | `web/lib/flows/graph/artifact-content.ts` | Manager worktree/repository | Retain in B; Stage C moves repository data. |
| Inline, gate verdict, HITL response artifacts | `artifact_instances`, gate/HITL tables | Manager DB | Retain manager ownership; no host object created. |
| Evaluation evidence store | `MAISTER_EVALUATION_EVIDENCE_ROOT`, evaluation services/routes | Manager-owned content store | Retain; do not conflate with execution-host runtime objects. |
| Flow input/state files (`input-*.json`, `needs-input.json`, node state files) | `web/lib/flows/graph/runner-graph.ts`, `web/lib/services/runs.ts`, HITL/consensus/recovery code | Primarily Web/Flow manager runtime | Keep files that are manager-only. Any file path passed to or produced by an ACP host must become an input/output object; repository/worktree-affine parts defer to C. |
| Mutation marker / Git checkpoint / worktree metadata | `mutation-check.ts`, `workspace-checkpoint.ts`, `.maister/run.json` | Manager/repository/worktree | Retain until Stage C; do not claim Stage B removes all manager filesystem use. |
| Flow-assistant action audit | local-package `flow-assistant-actions.jsonl` | Manager audit file | Retain manager ownership; it is not an execution-host event stream. |
| Supervisor in-memory session state | `supervisor/src/registry.ts`, `GET /sessions` | Volatile host state | Preserve for process control only; publish immutable incarnation/lifecycle events and expose typed diagnostic status. Manager projections cannot depend on list scans. |
| Stage A host SQLite state | `supervisor/src/host-state.ts`: identity, fences, workspaces, receipts | Durable host-private | Extend with event stream/outbox, session incarnation, and runtime-object registry. Never expose database/path. |
| Workspace/path-derived identifiers | `projectSlug`, `runId`, `stepId`, `worktreePath`, `repoPath`, context/capability paths in start-session contracts | Several paths cross the Stage A command wire | Do not expand this seam. Runtime event/object contracts carry opaque IDs only. Moving workspace/repo materialization is Stage C. Validate all legacy path segments until then. |
| Scratch supervisor session mirror | `scratch_runs.supervisor_session_id`; scratch service/recover/stop/discard/interrupt and recovery code | Transitional duplicate authority | Backfill/prove into immutable session incarnations and canonical `run_sessions`; stop reads, then writes, then drop in guarded B4 migration. |

### Required inventory grep gate

T0.1 records every production `node:fs` import and every construction of
`.maister/<project>/runs/<run>` in web code. Each match must be tagged in the
plan implementation notes as one of: `manager-flow`, `manager-repository`,
`manager-evidence`, `host-runtime-legacy`, or `unrelated`. B4 fails if any
`host-runtime-legacy` web read remains.

## Target design decisions

### D1. Transport-neutral event envelope

OpenAPI/AsyncAPI are the wire source of truth. Keep strict mirrored Zod schemas
in `supervisor` and `web` plus shared JSON conformance fixtures; do not add a
workspace package solely for one envelope in Stage B.

```ts
type RuntimeEventEnvelope = {
  envelopeVersion: 1;
  eventId: string;
  hostKey: string;
  hostBootId: string;
  streamId: string;
  sequence: string; // canonical signed-BIGINT-safe decimal on the JSON wire
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  hostSessionId: string | null;
  eventType: string;
  occurredAt: string;
  payloadSchema: string;
  payload: Record<string, JsonValue>;
};
```

- The spine is deterministic and closed; a known payload schema remains
  explicitly open JSON and may add fields without changing the spine.
- The host derives `eventId` with RFC UUIDv5 using the standard URL namespace
  and name
  `urn:maister:execution-event:host:<hostKey>:stream:<streamId>:sequence:<sequence>`,
  with every interpolated component RFC 3986 percent-encoded, stores it once in
  the outbox, and verifies the same value on replay. The manager enforces uniqueness by
  `eventId` and `(execution_host_id, stream_id, sequence)`.
- `sequence` is the protocol decimal string defined above. Each boundary parses
  it to `bigint`; it is never serialized as a JSON number or coerced through a
  JavaScript `number`.
- `streamId` and its monotonically increasing `sequence` survive supervisor
  boot-ID changes. `hostBootId` identifies the process incarnation but does not
  reset ordering.
- The wire carries durable `hostKey`, not the manager's database host UUID.
  The manager resolves `execution_hosts.id` server-side from the selected
  transport and verified health identity.
- Required event types receive versioned payload validators and redactors.
  Capability negotiation advertises supported `(eventType, payloadSchema)`
  pairs. An unsupported pair or redaction failure stores only bounded quarantine
  spine/error metadata, never the raw untrusted payload or its digest. Payload
  SHA-256 is computed only after successful redaction. This preserves
  open known payloads without making arbitrary future types a secret-ingestion
  channel.
- `occurredAt` is validated RFC 3339 metadata. Manager `receivedAt` and sequence
  order are authoritative; clock skew cannot reorder a transition.
- The encoded envelope is capped at 1 MiB. Artifact bytes and long logs use the
  object API, not event payloads.

The Stage B v1 event catalog is closed at the type/schema pair while each
payload object is open to additional redacted fields. The host capability
advertises the host-owned pairs; the two manager-owned pairs are contract-fixed
and never accepted from a host:

| `eventType` | `payloadSchema` | Minimum typed payload / owner |
| --- | --- | --- |
| `session.created` | `maister.session.created.v1` | logical session name, created command ID, workspace handle metadata; lifecycle projector |
| `session.line` | `maister.session.line.v1` | stream kind plus bounded redacted line or runtime-object reference; transcript projector |
| `session.update` | `maister.session.update.v1` | allowlisted ACP update kind/body; transcript/lifecycle projector |
| `session.permission_request` | `maister.session.permission-request.v1` | request ID, redacted tool descriptor, option descriptors; HITL projector |
| `session.hook_trip` | `maister.session.hook-trip.v1` | rule/lifecycle/disposition and redacted tool descriptor; lifecycle projector |
| `session.command` | `maister.session.command.v1` | command ID/kind, accepted or terminal phase, status/result/error; command/prompt projector |
| `session.chat_turn` | `maister.session.chat-turn.v1` | HITL request, role, bounded redacted body, sequence; chat projector |
| `session.exited` | `maister.session.exited.v1` | exit code and typed reason; lifecycle projector |
| `session.crashed` | `maister.session.crashed.v1` | nullable exit code/signal and typed reason; lifecycle projector |
| `usage.recorded` | `maister.usage.recorded.v1` | command/session/runner attribution and non-negative token/cost facts; cost projector |
| `runtime_object.available` | `maister.runtime-object.available.v1` | object ID/generation/kind/MIME/size/SHA-256/retention; object projector |
| `runtime_object.state` | `maister.runtime-object.state.v1` | object ID/generation and `missing | deleted | expired | corrupt` with safe reason; object projector |
| `run.runner_resolution_warning` | `maister.run.runner-resolution-warning.v1` | manager-only session name and typed resolution warning; browser-safe mapper |
| `run.needs_input` | `maister.run.needs-input.v1` | manager-only node ID and typed reason after DB transition; browser-safe mapper |

Checkpoint, cancellation, fencing, prompt acceptance/completion, and delete
outcomes use `session.command`; checkpoint/cancel/exit ordering is represented
by consecutive stream positions rather than redundant event kinds. Contract
tests assert parity between this catalog, capability advertisement, AsyncAPI,
Zod schemas, redactors, and projector registrations.

Redaction is deterministic and test-fixtured on both boundaries: remove values
for case-insensitive secret-bearing keys (`authorization`, `cookie`, `token`,
`secret`, `password`, `apiKey`, `headers`, `environment`, `env`); redact URL
userinfo and credential-looking tokens using the existing repository policy;
replace absolute host paths and `file://` URIs with an already-authorized object
reference or the literal `[REDACTED_HOST_PATH]`; cap nesting, array length, key
count, strings, and total encoded bytes; and reject cycles/non-JSON values.
`session.update` and permission/tool descriptors additionally use an allowlist
for state-changing fields before the recursive pass. Prompts, full environment
maps, command request bodies, and attachment bytes have no event-payload field.
Additional fields in a known schema pass the same recursive redactor but are not
sent to browsers until explicitly added to the browser allowlist.

### D2. Host event outbox and delivery

Extend `supervisor/src/host-state.ts` with:

- `event_stream(stream_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL,
  acked_through INTEGER NULL, replay_floor INTEGER NOT NULL, created_at TEXT,
  updated_at TEXT)` with non-negative/order checks;
- `event_outbox(stream_id TEXT, sequence INTEGER, event_id TEXT UNIQUE,
  envelope_json TEXT, encoded_bytes INTEGER, occurred_at TEXT, acked_at TEXT,
  created_at TEXT, PRIMARY KEY(stream_id, sequence))` with FK/cap checks;
- indexes on `(stream_id, acked_at, sequence)` for replay/prune and ACK grace.

Extend existing `command_receipts` additively with `assignment_id`, nullable
`target_session_id`, `request_schema`, and `request_sha256`. Every duplicate is
compared on command ID, run, assignment, epoch, kind, target session, schema,
and digest before it can join/replay; mismatch is
`COMMAND_INVARIANT_CONFLICT`, not a replay of unrelated data.

The first stream sequence is `0`; before any ACK, `acked_through` is SQL NULL,
not `-1`. Allocation increments `next_sequence` and inserts the outbox row in
one `BEGIN IMMEDIATE` transaction. ACK may advance only through an existing
contiguous emitted row of the exact stream and sets `acked_at` for the prefix
idempotently.

Every externally visible supervisor event is validated, redacted, assigned a
sequence, and committed to SQLite before it is published to memory/SSE or used
as terminal acknowledgement. The event stream uses absolute sequence
watermarks. ACK is monotonic and idempotent; it never skips a sequence.

Unacknowledged rows are never pruned. At the soft limit the host becomes
`unavailable:event_backpressure` for new mutating command admission while
existing sessions continue. The regular hard partition stops reading further
non-terminal ACP notifications so process backpressure is explicit; terminal,
fence, cancellation, and session-exit events use only the separate terminal
reserve. Exhausting that reserve keeps committed data intact, marks the host
unavailable, and requires reconciliation/operator recovery; it never drops or
silently truncates an event and never invents an automatic checkpoint/cancel.
The fixed protocol limits above keep the default deployment knob-free.

### D3. Initial Stage B transport

Use **manager-consumed host-global SSE over the existing local-direct HTTP
connection**, plus an explicit acknowledgement request.

- Add a separate additive capability endpoint; do not alter strict `/health`
  v1 during B0-B3.
- Add a host-global event replay stream and absolute-watermark ACK method to
  `ExecutionHostTransport` and `local-direct.ts`.
- `GET /runtime-events` uses `Last-Event-ID` only. It is an exclusive decimal
  cursor for the selected current stream; omission starts at the host replay
  floor. No query-parameter cursor alias is supported.
- The stream reconnects from the Postgres `last_contiguous_sequence`, not a
  process-local cursor. SSE event IDs carry the decimal host stream sequence.
- `POST /runtime-events/ack` supplies both `streamId` and the absolute decimal
  `throughSequence`. The host verifies the exact current stream and rejects an
  ACK that raced a stream replacement; transport selection alone does not make
  stream identity safe.
- This is local transport, not domain architecture. A future authenticated
  WebSocket/relay implements the same `RuntimeEventSource`/ACK/object contracts.
- Stage B adds no public-network listener, enrollment, trust bootstrap, relay,
  or remote-host authentication.

### D4. Canonical manager storage and ordering

Add dedicated execution-event tables; do not overload `domain_events`, whose
project-scoped business-trigger semantics and cascade retention are different.

1. `execution_event_streams`
   - `id text` primary key; `execution_host_id text` FK `execution_hosts`
     `ON DELETE RESTRICT`; `stream_id text`; `state text` CHECK
     (`observed | active | closed | lost`); `created_at timestamptz`; nullable
     `closed_at timestamptz`;
   - nullable signed-`BIGINT` `last_received_sequence`,
     `last_contiguous_sequence`, `last_ack_confirmed_sequence`, and
     `replay_floor_sequence`; `last_boot_id text` and `last_seen_at`;
   - nullable `first_gap_sequence bigint`, `gap_detected_at`, `gap_status`
     (`open | unrecoverable`), sanitized `last_error jsonb`, `next_retry_at`,
     `claim_owner`, and `claim_expires_at`;
   - unique `(execution_host_id, stream_id)`, partial unique active stream per
     host where `state = 'active'`, state/timestamp shape and cursor
     non-negative/order checks, and indexes on retry/claim expiry and open gaps.
     A conflicting new stream is inserted as `observed` but cannot ingest or
     receive ACK until reconciliation closes/loses the old stream and activates
     the new one.
2. `execution_events`
   - `id text` primary key is the event ID; `source text` CHECK
     (`host | manager | legacy_import`); `source_key text`;
   - `run_id text NOT NULL` FK `runs ON DELETE CASCADE`; nullable
     `execution_host_id`, `event_stream_id`, `host_sequence bigint`,
     `execution_assignment_id`, `assignment_epoch`,
     `run_session_incarnation_id`, `host_boot_id`, and `host_session_id`;
   - `envelope_version integer`, `event_type text`, `payload_schema text`,
     nullable redacted `payload jsonb`, `payload_sha256 text` computed from the
     encoded redacted payload only,
     `payload_bytes integer`, `occurred_at timestamptz`, manager
     `received_at timestamptz DEFAULT now()`;
   - nullable `run_sequence bigint`; `ingest_disposition text` CHECK
     (`pending_gap | accepted | stale_epoch | quarantined`); nullable bounded
     sanitized `ingest_error jsonb`;
   - unique `(event_stream_id, host_sequence)` for host rows, unique
     `(source, run_id, source_key)` for manager/import rows, partial unique
     `(run_id, run_sequence)` where non-null, and source-shape checks preventing
     a manager/import row from forging host stream identity. CHECK non-negative
     sequence/bytes and positive epochs; require host stream fields only for
     `host`, require `source_key` for manager/import, and permit `run_sequence`
     only for `accepted` rows.
3. `execution_event_consumers`
   - composite primary key `(consumer_name, run_id)`; nullable
     `last_run_sequence bigint`; `state text` CHECK
     (`ready | retrying | poisoned`); `attempts integer`, `next_retry_at`,
     nullable `poison_event_id`, bounded `last_error jsonb`, `claim_owner`,
     `claim_expires_at`, and timestamps;
   - cursor is per run because all projectors consume manager `run_sequence`,
     including manager-originated events which have no host sequence; indexes
     cover retry/claim and poison inspection.
4. `run_session_incarnations`
   - `id text` primary key; `run_session_id text NOT NULL` FK `run_sessions`
     `ON DELETE CASCADE`; `run_id text NOT NULL` FK `runs ON DELETE CASCADE`;
     `execution_assignment_id text` FK `execution_assignments ON DELETE SET
     NULL`; `assignment_epoch integer`; `execution_host_id text` FK
     `execution_hosts ON DELETE RESTRICT`; `host_session_id text NOT NULL`;
     `host_boot_id text`; nullable `acp_session_id`;
   - `state text` CHECK (`created | active | checkpointed | exited | crashed |
     lost | deleted`), `origin text` CHECK (`native | legacy_backfill`), and
     created/activated/ended timestamps plus sanitized terminal reason;
   - `id` is UUIDv5 over manager host ID plus host session ID; unique
     `(execution_host_id, host_session_id)` and partial unique active
     incarnation per `run_session_id`; current `run_sessions` fields are a
     mutable pointer only. Ingest of `session.created` creates the deterministic
     `created` incarnation before inserting its event FK; later events must
     resolve that binding or stop as an integrity failure.
5. `runs`
   - `execution_data_plane_mode text NOT NULL DEFAULT 'legacy_file_v1'` CHECK
     (`legacy_file_v1 | canonical_events_v1`), immutable after insertion;
   - `next_execution_event_sequence bigint NOT NULL DEFAULT 0` with a
     non-negative check. Canonical append locks the run row, uses the current
     value, and increments it in the same transaction; multi-run transactions
     lock run IDs in lexical order.
   - enforce immutability with a migration-defined `BEFORE UPDATE OF
     execution_data_plane_mode` trigger which permits unchanged values and
     raises a named integrity error on any change. B4 changes only the column
     default for future inserts under a migration-owned maintenance guard; it
     does not rewrite historical run modes.
6. `execution_data_plane_imports`
   - composite primary key `(run_id, source_kind)` where `source_kind` is
     `events | transcript | cost | runtime_objects | scratch_session`;
     `state` is `pending | complete | missing | failed`; store deterministic
     source fingerprint, last source position, imported count, sanitized error,
     started/completed timestamps, and attempt count;
   - this table lands additively in B0 so B4 does not introduce untracked
     cutover state.
7. additive `execution_commands` prompt-continuation fields
   - nullable `owner_kind` CHECK (`flow_node_attempt | scratch_message |
     gate_chat | agent_turn | sync_resolution`), `owner_ref jsonb`,
     `logical_operation_key text`, `request_schema text`,
     `request_sha256 text`, and `completion_applied_at timestamptz`;
   - partial unique `(run_id, logical_operation_key)` for `session.prompt`, plus
     a shape check requiring all three owner fields for new canonical prompt
     commands while allowing legacy rows during B0-B3. The digest is over the
     canonical encoded unredacted request, but only the digest and existing
     redacted command payload are stored in the ledger.
8. `execution_event_ingest_failures`
   - `id text` primary key; `execution_host_id text NOT NULL` FK
     `execution_hosts ON DELETE RESTRICT`; nullable `stream_id`,
     `event_id_text`, and `sequence_text`; `reason text NOT NULL`, bounded
     sanitized `details jsonb`, non-negative `encoded_bytes integer`,
     `occurrences integer NOT NULL DEFAULT 1` with a positive check,
     and first/last seen timestamps;
   - unique deterministic failure key over host/stream/event/sequence/reason;
     CHECK identifiers/reason at 256 characters and details at 8 KiB encoded;
     store no envelope or payload bytes/digest. This table owns malformed,
     oversized, unsupported-schema, and redaction-failure observations which
     cannot safely satisfy the canonical event row shape.

Ingest transaction order:

1. Authenticate the selected host by current transport/health identity.
2. Validate envelope, size, redaction invariants, run association, assignment,
   epoch, session incarnation, and expected stream sequence.
3. Insert or classify the event idempotently.
4. Promote only the newly contiguous prefix, allocate manager `run_sequence`
   atomically under the locked run row, and commit the stream watermark. Host
   ACK must not depend on downstream transcript/cost/artifact/lifecycle
   projection.
5. After commit, send the absolute host ACK.

Host ordering is total by `(streamId, sequence)`. Browser and per-run projector
ordering is total by `run_sequence`, allocated only when the host prefix is
contiguous. Across multiple sources, `run_sequence` is manager commit/
observation order while each host stream order is preserved; it does not claim
global occurrence-time order. Cross-host global order is deliberately
undefined. An unknown type/schema stores only bounded quarantine spine/error
metadata; it is not promoted or projected until a negotiated validator/redactor
exists. A stale-epoch event is retained for audit and advances the host watermark, but
cannot receive a current-run `run_sequence` or mutate current state.

### D5. Gaps, duplicates, restart, poison, and retention

- **Duplicate:** unique constraints make insert a no-op; verify invariant fields
  match the stored row, then re-ACK the contiguous watermark. Conflicting reuse
  of an event ID or stream sequence is a protocol violation and degrades the
  host.
- **Gap:** retain later rows as `pending_gap`, stop projection and ACK at the
  last contiguous row, and reconnect requesting the missing sequence. Do not
  skip.
- **Unrecoverable gap:** if the host returns a typed replay-floor response, mark
  the stream/host degraded and active affected assignments explicitly failed or
  recovery-required. Historical data stays viewable; no inferred completion.
- **Host restart:** same host state retains stream ID/sequence/outbox; a new
  boot ID is metadata. A new stream ID for the same host with unresolved old
  events is treated as possible state loss and requires reconciliation.
- **Manager restart:** claim the stream from its durable watermark and replay.
  Lost ACKs cause harmless duplicates.
- **Malformed/oversized/unsupported:** the host rejects before outbox append
  where possible. Manager-side violations retain only bounded spine/error
  metadata, never the raw payload; no ACK passes them until a compatible
  validator/redactor or explicit recovery resolves the stream.
- **Projection poison:** retry transient failures with durable backoff. After a
  fixed attempt limit, mark the row/projector poisoned, emit an actionable
  typed failure, and stop that projector cursor. Ingest ACK may continue only
  after the event itself is durably accepted; user-visible lifecycle projectors
  must fail the affected run explicitly instead of silently omitting it.
- **Retention:** all canonical events live as long as the run in Stage B;
  destructive canonical-event compaction is deliberately disabled and deferred
  to a later ADR. Host outbox rows are pruned only after confirmed ACK plus the
  fixed 24-hour replay grace; unacknowledged rows are never pruned and runtime
  object tombstones outlive content retention.

### D6. Manager-originated events and browser SSE

`web/lib/runs/run-stream-event.ts` becomes a canonical DB appender with a
server-derived assignment/epoch. It uses the same manager run sequence but a
separate manager source identity; it never forges a host stream sequence.
Each caller supplies a stable domain `sourceKey` derived from its already
durable logical operation (command/node attempt/HITL transition), and the
manager derives RFC UUIDv5 in the standard URL namespace from
`urn:maister:execution-event:manager:run:<runId>:source:<sourceKey>`, again with
components RFC 3986 percent-encoded. Random,
timestamp-only, or current-process IDs are not accepted by this API.

`/api/runs/{runId}/stream`:

- authorizes URL `runId`, then queries canonical events by `run_sequence`;
- accepts only `Last-Event-ID` as a canonical decimal `run_sequence`, replays
  strictly greater rows in bounded pages, and rejects invalid/overflow cursors
  with a typed 400; omission begins at sequence zero;
- listens to Postgres notification or a process-local wake hint only to avoid
  busy queries; the DB is always the replay source, so a lost notification is
  harmless;
- sends only an allowlisted, user-safe projection, not raw host payloads;
- retains the existing DB status heartbeat without filesystem polling.

All projectors use independent durable consumer cursors. Ingest completion is
not conditional on browser clients.

### D7. Durable async prompt lifecycle

Reuse the Stage A `session.prompt` command ID, receipt, assignment, and fence.
Do not add a second prompt ledger.

- Add `POST /sessions/{sessionId}/prompts`, returning `202` only after the host
  persists the accepted receipt and accepted event. Keep the legacy
  blocking behavior for legacy-mode runs through B3.
- The host continues the ACP turn asynchronously, writes the terminal receipt
  and terminal event before publication, and exposes the existing queryable
  receipt.
- Before host acceptance, the typed owner remains responsible for
  deterministically reconstructing the exact prompt request from its existing
  immutable domain inputs. Issue stores `request_schema` and SHA-256 beside the
  redacted ledger payload; retry recomputes and compares it, then reuses the
  original command ID. If source inputs are missing or drifted, fail with a
  typed payload-unavailable/digest-conflict error and never submit different
  bytes under the same command. After host acceptance the receipt records the
  same digest and host receipt/event state is authoritative; prompt text itself
  is never added to manager event or command payload storage.
- Persist exactly one typed prompt owner/continuation reference on
  `execution_commands`: `{kind:"flow_node_attempt", nodeAttemptId}`,
  `{kind:"scratch_message", scratchRunId, messageId}`,
  `{kind:"gate_chat", nodeAttemptId, messageId}`,
  `{kind:"agent_turn", agentRunId, turnId}`, or
  `{kind:"sync_resolution", syncOperationId}`. Cross-resource IDs are resolved
  and checked server-side before insert. A unique logical operation key makes a
  manager restart recover the original command ID. Keys are exactly
  `flow:<nodeAttemptId>`, `scratch:<messageId>`,
  `gate:<messageId>`, `agent:<turnId>`, and `sync:<syncOperationId>`; all
  components are pre-existing durable IDs, never prompt hashes or
  timestamps.
- `request_schema` is `maister.session-prompt.request.v1`; `request_sha256` is
  lowercase hex SHA-256 over RFC 8785 JSON Canonicalization Scheme bytes of the
  complete command/fence/prompt request. Web and supervisor share valid/order-
  variation conformance fixtures so semantically identical key order hashes the
  same and any changed prompt/fence/target does not.
- Replace process-only `PromptHandle` with serializable data
  `{commandId}`. Separate `queryPrompt(handle)` and `waitPrompt(handle)`
  functions read Postgres; local waiting is only an optimization over canonical
  event/command state.
- Applying terminal results is idempotent and durable. The owning domain
  transition and `completion_applied_at` occur in one transaction when
  possible; otherwise an idempotent domain mutation commits before the marker
  and a durable retry sweep repeats safely. Dispatch by `runs.run_kind` before
  kind-specific continuation.
- Replace the Stage A age-only seven-day prune for prompt commands/receipts with
  an eligibility rule: terminal event is canonically ACKed, owner completion is
  applied, the run is terminal, and the replay grace has elapsed. Canonical
  event/result history remains under run retention even after the host receipt
  is pruned.

Exact outcomes:

| Condition | Required result |
| --- | --- |
| Admission response lost | Query receipt/event with the same command ID; if no accepted receipt exists, reconstruct and digest-check the same request before retrying that ID; never create a new ACP turn identity. |
| Duplicate delivery | Host verifies the duplicate command invariant fields, then returns/joins the same receipt; no second ACP side effect. |
| Supervisor restart with accepted prompt and no live turn | On startup, atomically terminalize as `turn_lost`, append its event, and let manager recovery decide checkpoint/resume; never replay prompt text automatically. |
| Web restart | Event ingest and prompt-continuation sweep read Postgres and apply the original result to the correct owner. |
| Network interruption | Host continues; manager reconnects from watermark and reconciles receipt/event. |
| Session exit/crash | Host terminalizes any accepted command before or atomically with exit/crash event; manager never infers a result from missing HTTP. |
| HITL pause/resume | Permission events and decisions are durable. A live turn may remain accepted while paused; checkpoint ends it explicitly and resume creates a new fenced command/session incarnation. |
| Cancellation | The same cancel command ID is idempotent; prompt terminal outcome is `cancelled` before/with session exit. |
| Stale assignment | Fence before ACP; record/replay `fenced` receipt and audit event without current-run mutation. |
| Receipt/event disagreement | Compare invariants; quarantine mismatch and stop owner apply until explicit reconciliation. |

The versioned `session.prompt` terminal result is one of
`completed`, `checkpointed`, `cancelled`, `turn_lost`, `session_exited`,
`acp_error`, or `fenced`, with only the outcome-specific safe fields defined in
OpenAPI/AsyncAPI. Map `completed|checkpointed` to command state `succeeded`,
`cancelled|turn_lost|session_exited|acp_error` to `failed`, and `fenced` to
`fenced`; permission pause is progress and leaves the command `accepted`.
Cancellation/checkpoint commands keep their own receipts and reference the
affected prompt command ID, so their success cannot be confused with the
prompt's terminal outcome.

Terminal reconciliation accepts a result only when receipt and event agree.
There is no winner on disagreement. For multiple agreeing terminal observations,
the precedence is `fenced` before `cancelled` before `turn_lost` before `failed`
before `succeeded`, preventing a late success from overwriting a safety outcome.

### D8. Runtime-object ownership and path-free access

Add a host-private runtime-object registry and manager catalog. Opaque object IDs
are random, non-path-bearing, and bound to host/run/assignment/session.

Host registry metadata:

- object ID, kind, private canonical path, logical name;
- run/assignment/epoch/session binding;
- MIME type, byte size, SHA-256, generation/sealed state;
- created/sealed/expires/deleted timestamps and retention class.

Manager `execution_runtime_objects` stores the same non-secret metadata except
the path, plus catalog state (`available`, `missing`, `deleted`, `expired`,
`corrupt`, plus command-owned `pending`/`deleting`) and source event.
`artifact_instances` gains the locator
`{kind:"execution-object", objectId}`.

The additive B3 migration defines `execution_runtime_objects` exactly:
`id text` primary key; `run_id text NOT NULL` FK `runs ON DELETE CASCADE`;
`execution_host_id text NOT NULL` FK `execution_hosts ON DELETE RESTRICT`;
nullable `execution_assignment_id` FK `execution_assignments ON DELETE SET
NULL`, `assignment_epoch`, and `run_session_incarnation_id` FK
`run_session_incarnations ON DELETE SET NULL`; `kind` CHECK (`session_log |
raw_transcript | cost_diagnostic | checkpoint | attachment |
capability_profile | agent_memory_snapshot | node_result | evidence |
generated_artifact | plan_review | diagnostic`), allowlisted `logical_name`
(1–255 characters, no slash/backslash/NUL or `.`/`..` segment), normalized
`mime_type`, `size_bytes bigint`, `sha256 text`,
`generation integer`, `retention_class` (`run | delivery | ephemeral`), and
`state` (`pending | available | deleting | missing | deleted | expired |
corrupt`);
`source_event_id` FK `execution_events ON DELETE SET NULL`, created/sealed/
expires/deleted timestamps, and bounded sanitized `last_error jsonb`. Add
non-negative size, positive immutable generation, state-shape checks, a unique
non-null `source_event_id`, and run/state plus expiry indexes. Object ID names
one immutable generation; replacement content receives a new object ID rather
than updating bytes in place. The
artifact locator JSON schema accepts only `{kind:"execution-object",objectId}`;
it never embeds host, run, or path.

Retention meanings are exact: `run` bytes may delete only with the run;
`delivery` follows the existing confirmed local-delivery or confirmed PR-merge
artifact anchor and protects active/open/reopened review; `ephemeral` requires
`expires_at` and may delete only after expiry and no open command/session/
artifact reference. Deletion always retains manager metadata and the host
tombstone until the parent run is deleted.

Ownership split:

| Manager-owned durable content | Host-owned content with manager metadata |
| --- | --- |
| Canonical event envelope/payload after redaction | Raw/growing step and ACP diagnostic logs |
| Command receipts/results and prompt owner state | Local diagnostic event/cost files during bounded compatibility |
| Session-incarnation metadata | Large generated artifacts/evidence produced in the host runtime directory |
| `run_messages`, cost facts/rollups | Raw transcript bundle if retained beyond canonical messages |
| Runtime-object/artifact catalog and hashes | Any future checkpoint bytes explicitly produced by an adapter |
| Inline, gate-verdict, HITL-response artifacts | Host-private SQLite/outbox/ACP process state |

Content API supports metadata lookup, bounded streaming, single byte ranges,
ETag/SHA-256, and explicit maximums. `Range` accepts exactly
`bytes=<start>-<end>` with no suffix/open/multi-range form. A request without a
range returns the full body only when it is at most 8 MiB; larger content
requires consecutive client ranges of at most 8 MiB. It returns typed `404` for an unknown or
cross-boundary object, `410` for a known tombstone/expired object, `416` for an
invalid range, and `413` for limit violations. It never returns a filesystem
path. The browser artifact payload route authorizes `(runId, artifactId)` in
Postgres, derives host/object server-side, and proxies content without accepting
a client-selected host.

The same contract supports manager-to-host content without exposing a path:

1. Manager commits a pending catalog row and fenced `runtime_object.reserve`
   command with object ID, declared kind, MIME, size, SHA-256, generation, and
   retention; the host durably allocates private registry state before success.
2. Manager then persists a `runtime_object.upload` command. Its local-direct
   adapter sends the command ID/fence in headers and streams the binary body to
   `PUT /runtime-objects/{objectId}/content`; the body carries no JSON IDs. Host
   writes a private temporary file, verifies length/hash, atomically renames,
   and terminalizes the upload receipt plus available event.
3. Retry with the same command/object/generation/hash joins or returns the same
   receipt; different metadata or bytes is a protocol conflict. Both commands
   use `execution_commands`; there is no transfer-attempt ledger.
4. Prompt/start contracts refer to opaque input objects. For outputs, the host
   allocates a private path, injects it into the ACP child environment, then
   seals and publishes the object after the turn. The web never sees that path.

For upload specifically, the host atomically persists the accepted receipt and
private upload intent before reading the body. A concurrent duplicate receives
`409 COMMAND_IN_PROGRESS` without consuming bytes. Disconnect leaves an
accepted, retryable intent; the same command ID may restart from byte zero after
the host removes the incomplete temp file. After verified rename, registry
state, terminal receipt, and available event commit atomically; a duplicate then
returns replayed `204`. Startup applies the same rule: discard incomplete temp
state, or synthesize the missing terminal receipt/event from a uniquely sealed
registry row before serving requests. This upload-specific recovery never
replays an ACP prompt.

Use this seam for scratch attachments, capability profiles, agent memory
snapshots, `MAISTER_OUTPUT_FILE`, plan-review staging, generated evidence, and
other ACP-consumed/produced runtime files. Keep `$RUN_DIR`/
`MAISTER_OUTPUT_FILE` result transport distinct from verifier evidence object
storage. Collection globs discover outputs but do not control where tools write;
required evidence must be explicitly configured and absence must fail.

`runtime_object.reserve`, `runtime_object.upload`, and
`runtime_object.delete` are the only new Stage A command kinds. The manager
commits `deleting` with its command intent; the host commits a read-blocking
delete tombstone before unlink, retries unlink safely after failure/restart,
then terminalizes the receipt/event so the manager can commit `deleted`.
Missing bytes never masquerade as an empty artifact.

### D9. Compatibility and cutover

Use one bounded immutable per-run mode:

- Existing rows and runs admitted when capability discovery returns 404 are
  `legacy_file_v1`.
- A Stage B supervisor advertises `canonical_events_v1`, async prompt, runtime
  object, envelope version, and limit capabilities on a separate additive
  endpoint while keeping `/health` protocol v1.
- New web selects `canonical_events_v1` only when all required capabilities
  exist. The mode never changes for an active run.
- Every production run writer (`services/runs.ts`, `agents/launch.ts`, both
  scratch-run creators, and consensus draft creation) passes an explicit mode;
  the database legacy default exists only for old-web rolling compatibility and
  is changed/guarded in B4 so a missed writer cannot create legacy runs forever.
- The supervisor dual-writes legacy files only for explicitly legacy active
  runs. Canonical runs use the outbox as authority from admission.
- B4 first disables new legacy admission, drains active legacy runs, imports and
  accounts for historical data, then removes fallback. There is no automatic
  per-call fallback after a canonical run begins.

Historical import is deterministic and bounded:

1. Project existing completed legacy events, transcripts, costs, and artifacts
   while the old path is still available.
2. Read JSONL in byte-offset/line-number order, use that position as the only
   claimed import order, retain any legacy monotonic ID as metadata, and derive
   canonical source/event IDs from run ID, source kind, byte offset, and line
   hash. A malformed required line fails that source import at its exact
   position; it is never skipped.
3. Let the host register existing file objects and publish checksummed metadata;
   rewrite `{kind:"file"}` only when run/relative-path/checksum association is
   unique and proven.
4. Record per-run/object `complete | missing | failed` import status. Missing
   historical content remains an explicit tombstone; it is never silently
   treated as imported.
5. Refuse B4 if any active legacy run or unresolved required association
   remains.

### D10. Scratch mirror removal

Before dropping `scratch_runs.supervisor_session_id`:

1. Populate immutable `run_session_incarnations` and current
   `run_sessions.host_session_id` for every provable legacy association.
2. If a non-null mirror has no canonical default session but its scratch run,
   host, and host session association are unique, create a default
   `run_sessions` row plus `legacy_backfill` incarnation with preserved source
   provenance. Do not invent assignment/host facts that cannot be proven.
3. Abort on ambiguous host/session ownership or a non-null canonical value that
   differs; update only canonical NULLs and assert zero unresolved rows.
4. Migrate all scratch message, interrupt, stop, discard, recover, HITL, and
   state readers to server-derived canonical session/incarnation references.
5. Stop mirror writes for one compatible release; then apply the guarded
   destructive migration. Do not retain dual authority.

### D11. Deployment/configuration

Prefer fixed protocol limits and current retry/log settings, so Stage B adds no
required environment variables. If implementation proves a knob necessary, it
must use strict typed validation and be wired in the same task through:

- `.env.example`, `supervisor/.env.sample`, `web/.env.sample`,
  `deploy/maister.env.example`;
- `Dockerfile`, `compose.yml`, `compose.production.yml`;
- `docs/configuration.md` and `docs/deployment.md`.

Compose intentionally remains Postgres-only under ADR-023. The two compose
files must say that host-process settings are absent by design. B4 documents
that web no longer needs the supervisor runtime-data root, while repository and
worktree co-location remain required until Stage C.

## New route and identifier trust classification

Use these exact additive Stage B route names; if an implementation-time routing
constraint requires a change, update OpenAPI, AsyncAPI, ADR, tests, and this
table in the same contract commit.

| Route / contract | URL-selected | Principal/transport-derived | Server-derived | Request-supplied and validation |
| --- | --- | --- | --- | --- |
| `GET /data-plane/capabilities` | none | connected supervisor endpoint | host key/boot/stream and supported versions | none; 404 means legacy only during B0-B3 |
| `GET /runtime-events` | none | selected ExecutionHost transport | host key/current stream/replay floor | `Last-Event-ID` only; canonical decimal, exclusive, bounded; no query cursor |
| `POST /runtime-events/ack` | none | selected ExecutionHost transport | host identity and emitted watermark | body `streamId` + decimal `throughSequence`; exact-current-stream, monotonic, contiguous, and no greater than emitted |
| `POST /sessions/{sessionId}/prompts` | host session ID | selected host | stored session run/assignment/fence | command envelope and prompt body; compare all cross-resource IDs to host session/fence; never log prompt |
| reused `GET /commands/{commandId}` | command ID | selected host | durable receipt and its stored run/assignment/session binding | no body/cross-resource IDs; unknown receipt is typed 404 and manager verifies against its command row |
| `GET /runtime-objects/{objectId}` | opaque host object ID | selected host | private path and run/assignment binding | no run/path/body IDs; unknown/cross-boundary returns typed 404 |
| `GET /runtime-objects/{objectId}/content` | opaque host object ID | selected host | private path, metadata, limits | `Range` header is untrusted and bounded; no arbitrary filename/path |
| `POST /runtime-objects` | none | selected host | object run/assignment binding from `runtime_object.reserve` | Stage A command envelope plus declared metadata and manager-minted object ID; validate generation/size/hash/MIME/retention, no path |
| `PUT /runtime-objects/{objectId}/content` | opaque host object ID | selected host | pending object/private temp path | binary body; `runtime_object.upload` command/fence headers; hash/size/generation must equal reservation |
| `DELETE /runtime-objects/{objectId}` | opaque host object ID | selected host | object association | Stage A fenced command envelope; verify body run/assignment against object registry |
| `GET /api/runs/{runId}/stream` | run ID | authenticated web user | project membership and canonical events | reconnect cursor only; no host/session/path selection |
| `GET /api/runs/{runId}/artifacts/{artifactId}/payload` | run ID, artifact ID | authenticated web user | project, host, and object locator from DB | Range header only; artifact must belong to run before host call |

All failures use stable typed reason tokens in `MaisterError.details` or
`SupervisorError.details`, structured logs, and actionable remediation. No raw
path or secret-bearing payload crosses a new route.

Success behavior is fixed before implementation:

| Route | Success contract |
| --- | --- |
| `GET /data-plane/capabilities` | `200 application/json`, strict v1 capability document; `ETag` may cache but is never authority. |
| `GET /runtime-events` | `200 text/event-stream`; each `id` is the decimal sequence and each `data` is one envelope; heartbeat comments carry no state. |
| `POST /runtime-events/ack` | `204` only after the exact stream's durable ACK transaction. |
| `POST /sessions/{sessionId}/prompts` | `202` with `{commandId,state:"accepted"}` after durable receipt/event; duplicates return the same body and existing replay header. |
| reused `GET /commands/{commandId}` | `200` with the existing receipt schema, extended by versioned prompt terminal result; no special prompt-result route. |
| `POST /runtime-objects` | `201` with object metadata and terminal `runtime_object.reserve` receipt after durable private reservation. |
| `PUT /runtime-objects/{objectId}/content` | `204` after verified atomic seal plus terminal `runtime_object.upload` receipt/event; response loss reconciles through receipt/metadata. Required headers are `X-Maister-Command-Id`, `X-Maister-Assignment-Id`, `X-Maister-Assignment-Epoch`, `X-Maister-Object-Generation`, `Content-Length`, `Content-Type`, and RFC 9530 `Content-Digest`. |
| `GET /runtime-objects/{objectId}` | `200` metadata with strong SHA-256 ETag and no path. |
| `GET /runtime-objects/{objectId}/content` | `200` for an allowed full body or `206` for one range, with `Accept-Ranges`, `Content-Range` when partial, length/type, and strong ETag. |
| `DELETE /runtime-objects/{objectId}` | `204` after terminal `runtime_object.delete` receipt, durable tombstone, and idempotent unlink; replayed deletion is also `204` with replay header. |
| web run SSE / artifact payload | Preserve authenticated web route status semantics; SSE is canonical replay, and payload proxy mirrors safe `200/206/404/410/413/416` without host identifiers. |

All `X-Maister-*`, length/type/digest, range, URL, and JSON identifiers are
request-supplied and untrusted. The supervisor compares them to its durable
command, fence, reservation, and object registry before reading/writing bytes.

### Stable Stage B error taxonomy

| Code / reason | HTTP when applicable | Retryability / action |
| --- | --- | --- |
| `EVENT_SEQUENCE_INVALID` | 400 | Permanent contract error; fix sender/version. |
| `EVENT_STREAM_MISMATCH` | 409 | Refresh capabilities/current stream; never apply the stale ACK. |
| `EVENT_ACK_OUT_OF_RANGE` | 409 | Reconcile emitted/contiguous watermarks and retry the corrected ACK. |
| `EVENT_REPLAY_FLOOR_PASSED` | 410 | Permanent gap for that stream; mark recovery-required. |
| `EVENT_IDENTITY_CONFLICT` | 409 | Poison/degrade host; operator investigation required. |
| `EVENT_SCHEMA_UNSUPPORTED` | 422 | Stop ACK; deploy compatible validator/redactor or resolve explicitly. |
| `EVENT_REDACTION_FAILED` | 422 | Stop ACK; raw payload is not retained. |
| `EVENT_TOO_LARGE` | 413 | Permanent for this event; publish bytes as an object instead. |
| `EVENT_BACKPRESSURE` | 503 | Retry after ACK/drain; new mutating command was not accepted. |
| `EVENT_GAP_UNRECOVERABLE` | 409 | Run/assignment recovery required; no inferred terminal state. |
| `COMMAND_INVARIANT_CONFLICT` | 409 | Do not replay side effect; reconcile duplicate command data. |
| `COMMAND_IN_PROGRESS` | 409 | Retry the same command ID after the active upload/side effect disconnects or completes. |
| `PROMPT_TERMINAL_CONFLICT` | 409 | Stop owner apply and reconcile receipt/event. |
| `EXECUTION_FENCE_MISMATCH` | 409 | Permanent stale command; return durable fenced outcome. |
| `RUNTIME_OBJECT_NOT_FOUND` | 404 | Unknown, unauthorized, or cross-boundary; do not reveal which. |
| `RUNTIME_OBJECT_GONE` | 410 | Known tombstone/expiry; metadata remains queryable where authorized. |
| `RUNTIME_OBJECT_TOO_LARGE` | 413 | Use allowed upload size or bounded range retrieval. |
| `RUNTIME_OBJECT_RANGE_UNSATISFIABLE` | 416 | Correct to one satisfiable range within the advertised bound. |
| `RUNTIME_OBJECT_IDENTITY_CONFLICT` | 409 | Preserve original generation; do not overwrite. |
| `RUNTIME_OBJECT_INTEGRITY_FAILED` | 422 | Retry identical bytes only after transient transport failure; otherwise fail. |
| `RUNTIME_OBJECT_STORAGE_UNAVAILABLE` | 503 | Retry same command/object ID with backoff. |
| `DATA_PLANE_MODE_UNSUPPORTED` | 409 | Do not admit canonical run on this host/version. |
| `LEGACY_IMPORT_FAILED` | 409 | Correct named source position/association and rerun idempotently. |
| `DATA_PLANE_CUTOVER_BLOCKED` | 409 | Drain/upgrade/resolve the reported rows before B4. |
| `LEGACY_ASSOCIATION_CONFLICT` | 409 | Preserve source data and resolve ambiguity; never choose arbitrarily. |

## Remote side effect + database transition failure table

| Operation | Required phase order | Retry owner / idempotency key | Acknowledgement loss | Compensation or reconciliation | Poison handling |
| --- | --- | --- | --- | --- | --- |
| Host event → manager ingest → host ACK | Host SQLite append before publish; manager DB event + contiguous fold + watermark transaction; ACK only after commit | Manager stream consumer; `eventId` and `(host,stream,sequence)` | Host replays; manager verifies duplicate and repeats absolute ACK | No inverse DB operation; reconnect from durable watermark | Protocol conflict degrades host; projector poison stops its cursor and fails affected lifecycle explicitly |
| Manager prompt command → host ACP turn | Commit `execution_commands` intent; host fence + accepted receipt/event; then ACP side effect; terminal receipt/event last | Existing command deliverer/recovery; command UUID plus unique logical prompt operation | Query receipt/event and retry same ID; no second prompt | Startup/event sweep folds terminal state and idempotently applies typed owner continuation | Accepted-without-live-turn becomes `turn_lost`; invariant conflict quarantines command/host |
| Manager-originated event → browser wake | DB canonical event/run sequence transaction; notification after commit | Request/domain transaction; deterministic manager event ID | Lost notification is harmless; browser/server replay DB | Periodic bounded DB heartbeat/requery | Invalid manager event fails originating transaction; never append a partial file line |
| Host file → runtime-object catalog | Atomic file close/seal and checksum; host registry/tombstone; catalog event; manager DB upsert | Host object publisher; object ID + generation + event ID | Replay catalog event | Manager verifies size/hash when content is consumed; marks missing/corrupt explicitly | Invalid metadata rejected and quarantined without exposing path |
| Manager bytes → host runtime object | Commit pending catalog + `runtime_object.reserve`; after reserve receipt commit `runtime_object.upload`; host commits accepted receipt/private intent, streams temp bytes, verifies/hash/renames, then atomically commits registry + terminal receipt/event; manager marks available | Stage A command recovery; each command UUID + object ID/generation + declared SHA-256 | Query receipt/object metadata; active duplicate gets `COMMAND_IN_PROGRESS`, disconnected accepted intent restarts byte zero with same ID, completed returns replay | Startup deletes incomplete temp; a uniquely sealed row synthesizes missing terminal receipt/event; verified object is never overwritten | Size/hash/MIME/generation mismatch terminalizes upload with typed reason and quarantines temp metadata |
| Runtime-object delete | Commit fenced delete command + manager `deleting`; host read-blocking tombstone, idempotent unlink, terminal receipt/event; manager commits `deleted` | Stage A command recovery; command UUID | Query receipt/replay event with same ID | Retrying delete/unlink is safe; tombstone is durable; no attempt to recreate bytes | Terminal rejection keeps `deleting` with actionable reason until retry/reconciliation; repeated deterministic failure poisons command |
| Checkpoint + manager run transition | Fenced checkpoint command; host receipt/checkpoint/session event; manager transition transaction | Existing checkpoint command ID | Receipt/event reconciliation | If result unknown, run remains recoverable/NeedsInput; never infer checkpoint | Failure/turn_lost leaves explicit recovery state; Git checkpoint ref remains separate Stage C concern |
| Legacy import | Read/parse while old authority available; deterministic canonical insert/catalog rewrite transaction; mark import complete last | B4 importer; run + source position/hash | Re-run import idempotently | Do not delete old files until all required rows complete; restore/roll forward on failure | Malformed/conflicting records mark run failed-to-import and block B4 |

## Observability contract

Add structured logs and metrics for:

- ingest lag by host/stream and oldest unacknowledged event;
- received, contiguous, and host-confirmed acknowledgement watermarks;
- duplicate/conflict rate, gap age/count, replay volume, reconnects;
- event bytes, outbox rows/bytes, backpressure admissions rejected;
- projector cursor lag, retries, and poison rows;
- command acceptance and completion latency, async prompt outcomes,
  `turn_lost`, stale-epoch rejection;
- runtime-object transfers, range requests, bytes, duration, checksum failure,
  missing/tombstoned objects;
- canonical event/object storage growth, outbox pruning, and object-retention results;
- legacy import/drain progress and reconciliation outcomes.

Use gauges `maister_execution_event_ingest_lag_seconds`,
`maister_execution_event_ack_sequence`, `maister_execution_event_gap_age_seconds`,
`maister_execution_event_outbox_rows`,
`maister_execution_event_outbox_bytes`, and
`maister_execution_storage_bytes`; counters
`maister_execution_event_received_total`,
`maister_execution_event_duplicate_total`,
`maister_execution_event_conflict_total`,
`maister_execution_event_replay_total`,
`maister_execution_event_reconnect_total`,
`maister_execution_event_stale_epoch_total`,
`maister_execution_reconciliation_total`, and
`maister_runtime_object_bytes_total`; histograms
`maister_execution_command_completion_seconds` and
`maister_runtime_object_transfer_seconds`. Labels are limited to bounded
`host_key`, `host_kind`, `event_type`, `outcome`, `reason`, `projector`, `command_kind`, and
`object_kind`; run, command, event, stream, session, and object IDs belong in
structured logs, never metric labels.

Required safe fields include `hostKeyPrefix`, `hostBootId`, `streamId`,
`sequence`, `ackThrough`, `runId`, `assignmentId`, `assignmentEpoch`,
`hostSessionId`, `commandId`, `commandKind`, `eventId`, `eventType`, `objectId`,
`attempt`, `latencyMs`, `bytes`, `outcome`, and typed `reason`. Never log raw
payload, prompt, content, secret, environment value, or filesystem path.

## Delivery plan

Each task is sized for one focused implementation session. Dependencies are
hard ordering, not suggestions. The listed owner is the subsystem owner; one
developer may own several tasks, but concurrent work must not cross those file
boundaries without coordination.

For every task, the implementer must execute the stated focused test before
production changes and record the expected RED failure, implement only enough
behavior for GREEN, then REFACTOR under the same focused test plus the adjacent
increment gate. Critical safety tests additionally remove/reverse the named
guard and demonstrate failure before restoring it. Final commits are green;
RED evidence belongs in the implementation notes/PR, not as a deliberately
failing commit. Tests that assert constants/types without behavior, duplicate a
stronger integration proof, use impossible database rows, or pass before and
after the named mutation do not satisfy the task.

### Implementation checklist

- [x] T0.1 Freeze the as-built boundary and allocate identifiers.
- [x] T0.2 Freeze the ADR, system specifications, and traceability.
- [x] T0.3 Publish exact OpenAPI, AsyncAPI, errors, and conformance fixtures.
- [x] T0.4 Add canonical event, stream, session-incarnation, and cutover schema.
- [x] T0.5 Add compatible capability negotiation and symmetric deployment wiring.
- [x] T1.1 Implement the supervisor durable event stream/outbox.
- [x] T1.2 Expose host-global replay/ACK and implement local-direct transport.
- [x] T1.3 Implement manager ingestion, contiguous promotion, and ACK recovery.
- [x] T1.4 Add durable projector cursors, poison policy, and event reconciliation.
- [ ] T2.1 Make canonical session incarnations the lifecycle authority.
- [ ] T2.2 Switch browser run SSE and manager-originated events to Postgres.
- [ ] T2.3 Move transcript, inbox, scratch-command, and artifact projections to canonical events.
- [ ] T2.4 Make canonical usage events/cost facts authoritative.
- [ ] T2.5 Prove canonical lifecycle and read-model cutover as one increment.
- [ ] T3.1 Make supervisor prompt admission asynchronous and restart-safe.
- [ ] T3.2 Make PromptHandle serializable and terminal application durable.
- [ ] T3.3 Migrate every prompt driver to durable continuation semantics.
- [ ] T3.4 Add runtime-object schema, host registry, and typed transfer APIs.
- [ ] T3.5 Migrate runtime-file producers and consumers to object handles.
- [ ] T3.6 Prove restart-safe prompt and no-shared-runtime behavior end to end.
- [ ] T4.1 Drain legacy active runs and import historical runtime data.
- [ ] T4.2 Delete legacy event/prompt readers and writers.
- [ ] T4.3 Preserve and remove the scratch session mirror and path cursor.
- [ ] T4.4 Finalize deployment, docs, retention, and full regression.

### B0 — Filesystem-cut inventory, contracts, schema, ADR, additive deployment

#### T0.1 — Freeze the as-built boundary and allocate identifiers

**Owner:** architecture/migration owner
**Depends on:** Stage A baseline only
**Files:** this plan; ADR filesystem-cut appendix; new checked inventory fixture
under `web/lib/execution-host/__tests__/fixtures/`; source-guard test only

**Work**

1. Rebase/verify the implementation branch against the intended Stage A
   baseline and rerun the filesystem inventory described above.
2. Recheck `main` for the next ADR and Drizzle migration IDs immediately before
   creating files. At plan time the candidates are ADR-167 and migrations
   `0131+`; they are not permanently reserved.
3. Create the ADR stub first, then cite it. Reserve three migration purposes,
   renumbering after rebase if needed:
   - additive event/session/cutover schema;
   - additive runtime-object schema;
   - destructive legacy-path/scratch-mirror removal.
4. Record every direct web `node:fs` access and runtime-path constructor with
   its owner/category and B/C disposition. Include scratch attachments,
   capability profiles, agent memory snapshots, plan review, verifier outputs,
   inbox, command availability, cost, transcript, artifacts, recovery, and
   projectors.
5. Correct stale schema/code comments, including the assertion that
   `acp_session_id` is first written only after prompt completion, in the task
   that changes the owning code.

**RED → GREEN → REFACTOR:** RED — add an inventory test that fails on one
unclassified production `node:fs` import/runtime-path constructor and prove the
failure by omitting a known current reader. GREEN — populate the typed inventory
until every current match has an owner, disposition, removal task, and Stage C
deferral where applicable. REFACTOR — centralize match/category validation and
remove duplicate path patterns without weakening the mutation. This is a
classification test in B0; B4 changes its rule to reject every remaining
`host-runtime-legacy` web read.
**Logging:** none at runtime. The inventory must name existing silent fallbacks
and catch-all errors so their removal is verifiable.
**Acceptance:** `CUT-06`, `CUT-09`, and `CUT-12` are traceable; identifier
choices are collision-free at current `main`; every
filesystem interaction has one owner and one disposition; no Stage C item is
accidentally assigned to Stage B.

#### T0.2 — Freeze the ADR, system specifications, and traceability

**Owner:** architecture/system-analytics owner
**Depends on:** T0.1
**Files:** `docs/decisions.md`, next `docs/decisions/adr-*.md`, new
`docs/system-analytics/execution-event-plane.md`,
`execution-prompt-lifecycle.md`, `execution-runtime-objects.md`,
`execution-data-cutover.md`; existing `execution-hosts.md`, `sessions.md`,
`runs.md`, `scratch-runs.md`, `hitl.md`, `artifacts.md`,
`reconciliation-gc.md`, `test-infrastructure.md` only where its harness contract
changes; `docs/system-analytics/README.md`, `scripts/validate-docs-indexes.mjs`,
new `scripts/validate-docs-indexes.test.mjs`, `package.json`

**Work**

1. Record in the ADR: manager canonical event ownership; host outbox/file
   ownership; at-least-once transport/exactly-once canonical insert; host and
   run ordering; gap/replay/ACK rules; stale fencing; async prompt lifecycle;
   runtime-object ownership; immutable per-run compatibility mode; B4 gate;
   remaining Stage C/D boundaries.
2. Create four bounded analytics documents, each in exact R5 order: Purpose,
   Domain entities, State machine, Process flows, Expectations, Edge cases,
   Linked artifacts. Use EVT, PRM, OBJ, and CUT IDs above; each Expectations
   section has at most 12 single-sentence normative bullets.
3. Replace obsolete file-authority expectations in `execution-hosts.md`,
   `sessions.md`, `runs.md`, `scratch-runs.md`, `artifacts.md`, and
   `reconciliation-gc.md` one-for-one and link to the new domain owner. Do not
   append duplicate requirements or exceed an existing expectation cap.
4. Add a traceability table for every Stage B requirement and edge case with
   its contract/schema, enforcement symbol/table, primary test ID, task, and
   status. No requirement may be orphaned and no test may claim two unrelated
   normative behaviors as its primary responsibility.
5. Update the analytics index and ADR hub atomically. Mark new behavior
   `Designed`; keep as-built and Stage C/D statements explicitly labeled. Add
   the validator fixture suite to `validate:docs:all` so these checks run in CI.

**RED → GREEN → REFACTOR:** RED — extend the documentation validator tests so
duplicate requirement IDs, over-12 expectation sections, missing R5 sections,
unindexed documents, broken linked artifacts, or a requirement without one
primary test fail. Seed one invalid fixture for each validator branch. GREEN —
write the ADR, four specifications, replacements, index rows, and complete
traceability until validation passes. REFACTOR — remove repeated prose in favor
of links while preserving every ID and validator failure mutation.
**Logging:** The specification defines the safe structured field set and the
forbidden prompt/payload/content/path/secret fields; no runtime logging changes.
**Acceptance:** all EVT/PRM/OBJ/CUT requirements and `EDGE-*` cases have one
domain owner, one implementation task, and one primary test; R5/R5a/R6/R7 and
ADR parity validators pass; the ADR preserves Stage C/D boundaries.

#### T0.3 — Publish exact OpenAPI, AsyncAPI, errors, and conformance fixtures

**Owner:** API/contracts owner
**Depends on:** T0.2
**Files:** `docs/api/supervisor.openapi.yaml`, `docs/api/web.openapi.yaml`, new
`docs/api/async/execution-host-events.asyncapi.yaml`, existing
`docs/api/async/supervisor-sse.asyncapi.yaml`,
`docs/api/async/web-runs.asyncapi.yaml`, `docs/error-taxonomy.md`,
`docs/supervisor.md`, `docs/configuration.md`, `package.json`, `pnpm-lock.yaml`,
`scripts/validate-contracts.mjs`, new `scripts/validate-contracts.test.mjs`,
supervisor/web Zod schemas, and shared JSON conformance fixtures

**Work**

1. Specify the exact envelope, decimal sequence format, deterministic event ID,
   known open payload schemas, capability response, `Last-Event-ID` replay,
   stream-bound ACK, async prompt/JCS request digest, receipt query, runtime-object reserve/upload/
   metadata/read/range/delete, errors, limits, and every success/error example.
2. Publish the new host-global AsyncAPI as `1.0.0`. Keep per-session SSE
   explicitly legacy/diagnostic; bump existing supervisor/web contract versions
   only once when their additive/change surfaces land.
3. Register every OpenAPI/AsyncAPI file in `validate-contracts.mjs`. Add official
   OpenAPI and AsyncAPI parser/linter dev dependencies, scripts, and lockfile so
   `pnpm validate:contracts` performs meta-schema validation before the existing
   repository semantic checks and runs `validate-contracts.test.mjs`; do not
   describe the current YAML-only check as schema validation.
4. Add semantic checks for deterministic spine fields, canonical decimal
   strings, open known payload objects, forbidden path properties, route/error/
   event-name parity, exact SSE cursor semantics, ACK `streamId`, identifier
   trust classification, and examples that validate against schemas.
5. Keep mirrored strict Zod boundary schemas in web and supervisor. Drive both
   with identical valid/invalid JSON fixtures; unknown payload fields for a
   known schema remain valid while unknown type/schema and unsafe fields fail.

**RED → GREEN → REFACTOR:** RED — add contract tests that fail on JSON-number
sequence, leading zero/negative/overflow sequence, missing ACK stream ID,
inclusive replay, raw path, unknown schema, multi-range, oversized body, and an
example/schema mismatch. GREEN — publish contracts, parsers, Zod schemas, error
taxonomy, and fixtures until both sides and both meta-schema validators agree.
REFACTOR — deduplicate fixtures/schema helpers without creating a new shared
runtime package or weakening negative cases.
**Logging:** OpenAPI descriptions and error taxonomy enumerate safe structured
fields and explicitly prohibit raw payload, prompt, content, credentials,
environment values, and paths.
**Acceptance:** `pnpm validate:contracts` invokes real OpenAPI/AsyncAPI
validation; every route/message and typed error has valid positive and negative
examples, identifier provenance, size/cursor semantics, and matching Zod
behavior; EVT/PRM/OBJ contract traceability is complete.

#### T0.4 — Add canonical event, stream, session-incarnation, and cutover schema

**Owner:** database/execution-host owner
**Depends on:** T0.2, T0.3
**Files:** `web/lib/db/schema.ts`, generated next migration SQL,
`web/lib/db/migrations/meta/_journal.json`, generated snapshot,
`web/lib/db/__tests__/migration-journal-integrity.test.ts`, new
`migration-*-execution-events.integration.test.ts`,
`web/lib/db/README.md`, `docs/database-schema.md`,
`docs/db/execution-hosts-domain.md`, `docs/db/runs-domain.md`,
`docs/db/README.md`, generated `docs/db/erd.dbml`

**Work**

1. Implement every column, FK/delete action, CHECK, partial unique constraint,
   and index in D4 exactly. Do not use “as needed” columns or an optional
   transfer table.
2. Validate the discriminated `owner_ref` JSON at command insertion/read and
   enforce the owner-kind/logical-key shape in SQL. During B0-B3 the run-mode DB
   default remains `legacy_file_v1` solely for old-web compatibility; upgraded
   writers always supply their selected value.
3. Implement host/source idempotency and per-run consumer cursors exactly as
   specified. Test the run-row allocation lock with concurrent host and manager
   appenders and lexical multi-run lock ordering.
4. Add `execution_data_plane_imports` now and backfill every existing run to
   legacy mode. Sweep all production run writers in `web/lib/services/runs.ts`,
   `web/lib/agents/launch.ts`, both create paths in
   `web/lib/scratch-runs/service.ts`, and
   `web/lib/flows/graph/consensus/drafts.ts`; upgraded admission must pass mode
   explicitly.
5. Maintain all four migration artifacts together: `schema.ts`, generated SQL,
   journal, and snapshot. Drizzle-generate first; deliberate SQL additions such
   as preservation preflight/`DO` guards are allowed only when documented,
   exercised against real Postgres, followed by regeneration/dry-check proving
   Drizzle will not remove them. Never hand-edit the generated snapshot.

**RED → GREEN → REFACTOR:** RED — with `startMainPostgresTestDbUpTo()` and
`applyMainMigration()`, prove failures for duplicate event/position/run sequence,
invalid state/source shapes, stale owner shape, negative/overflow cursors,
immutable run-mode update, and concurrent run-sequence allocation. Include one
production-shaped test for each run-writer family so omitting an explicit mode
fails. GREEN — implement schema and migration until all real Postgres cases and
old-code additive compatibility pass. REFACTOR — consolidate typed fixtures and
queries; re-run migration generation/dry-check and mutation-revert each unique/
CHECK/lock assertion.
**Logging:** Migration preflight failures name counts and stable row IDs only;
no payload/path dump. Application logging lands in later tasks.
**Acceptance:** EVT-03/04/05/10, PRM-04, and CUT-01/03/05 are enforced by
named constraints/transactions and primary tests; migration integrity,
migration integration, `db:check`, schema
typecheck, and ERD check pass; old Stage A code can run against the additive
schema during rolling upgrade.

#### T0.5 — Add compatible capability negotiation and symmetric deployment wiring

**Owner:** supervisor/platform owner
**Depends on:** T0.3, T0.4
**Files:** `supervisor/src/types.ts`, `http-api.ts`, `main.ts`, targeted new
`data-plane-capabilities.ts`; `web/lib/supervisor-client.ts`,
`web/lib/execution-host/contracts.ts`, `types.ts`, `registrar.ts`,
`transports/local-direct.ts`; `.env.example`, `supervisor/.env.sample`,
`web/.env.sample`, `deploy/maister.env.example`, `Dockerfile`, `compose.yml`,
`compose.production.yml`, `docs/configuration.md`, `docs/deployment.md`,
`docs/supervisor.md`; focused supervisor/web contract tests

**Work**

1. Keep `/health` and `protocolVersion: 1` byte/schema compatible. Add the
   separate read-only capability endpoint described by T0.3. A 404 is the only
   bounded legacy signal during B0-B3; malformed/partial capabilities fail
   closed and cannot admit canonical runs.
2. Persist the discovered data-plane capability document in
   `execution_hosts.capabilities`; select `canonical_events_v1` only when every
   required host feature/version/limit matches **and** the web build's local
   `CONTROL_PLANE_DATA_PLANE_VERSION` supports v1. That constant remains unset
   through T3.4 and is enabled only in T3.5 after all control-plane callers are
   migrated. T0.5 initially advertises unfinished host features as unsupported;
   T1.2, T3.1, and T3.4 enable their own capability after focused tests. This
   two-sided intersection makes supervisor-first and web-first increments safe
   without an operator flag.
3. Extend transport-neutral contracts for event stream/ACK, async prompt, and
   runtime objects without implementing them yet. Keep unsupported methods
   typed and explicit; no silent fallback.
4. Prefer fixed protocol limits. If a runtime knob is unavoidable, introduce a
   small strict parser for only Stage B settings and wire every listed
   configuration/deployment surface in this task.
5. Preserve Postgres-only compose. Document in both compose files that web and
   supervisor are host processes and no event/object-store service or shared
   host-runtime volume is required by Stage B.

**RED → GREEN → REFACTOR:** RED — supervisor-first tests fail if `/health` v1
changes; web-first tests fail if capability 404 does not select legacy; partial,
malformed, version/limit/type-schema-mismatched capability fixtures must reject
canonical admission. GREEN — implement additive discovery, persistence, and
explicit run-mode selection until both upgrade orders pass. REFACTOR — keep one
pure compatibility decision function and reuse it in every run writer without
introducing a permissive fallback.
**Logging:** discovery logs `hostKeyPrefix`, `bootId`, feature/version set,
selected mode, and typed failure reason; never URL credentials or raw capability
payload.
**Acceptance:** CUT-01/02/10 and contract fixtures are green; both rolling
orders remain operational; default one-host setup
needs no added environment value, enrollment, relay, object store, or service.

#### B0 acceptance gate

- All contracts/ADR/domain expectations are `Designed` and internally
  consistent.
- Additive schema is deployable before either process changes behavior.
- Old/new process combinations select only supported per-run modes.
- The default compose topology is unchanged and operational.
- Focused commands:

```bash
pnpm validate:contracts
pnpm validate:docs:all
pnpm --filter maister-web exec vitest run --project integration lib/db/__tests__/migration-journal-integrity.test.ts lib/db/__tests__/migration-*-execution-events.integration.test.ts
pnpm --filter maister-web db:check
pnpm --filter maister-web db:erd --check
pnpm --filter @maister/supervisor typecheck
pnpm --filter maister-web typecheck
```

### B1 — Durable host event ingest, replay, acknowledgement, and reconciliation

#### T1.1 — Implement the supervisor durable event stream/outbox

**Owner:** supervisor runtime owner
**Depends on:** T0.5
**Files:** `supervisor/src/host-state.ts`, new `runtime-events.ts`,
`supervisor/src/types.ts`, `registry.ts`, `events-log.ts`, `spawn.ts`,
`heartbeat.ts`, `http-api.ts`, `main.ts`; `events-log.test.ts`, `registry.test.ts`,
`spawn.test.ts`, new `runtime-events.integration.test.ts`

**Work**

1. Add SQLite migrations for persistent stream identity, next sequence,
   absolute ACK, outbox rows, and receipt invariant/digest columns. Keep WAL and
   set `synchronous=FULL`; write a
   command receipt and its accepted/terminal event in the same transaction. If
   current table boundaries prevent that, refactor the host-state transaction
   API in this task rather than accepting a crash window.
2. Centralize event creation in one pure envelope/redaction/validation builder;
   route every session update, line, permission, command, usage, checkpoint,
   exit, and crash event through one durable append function.
3. Allocate one host-global sequence, including concurrent sessions and across
   boot-ID changes. Remove `tailMaxMonotonicId()` as canonical allocation for
   canonical runs; retain it only inside the bounded legacy writer through B3.
4. Enforce the protocol constants and separate terminal reserve. At soft limit
   reject new mutating commands; at the regular hard partition stop consuming
   non-terminal ACP notifications; never warn-and-continue, drop, or
   automatically checkpoint/cancel a canonical run.
5. Implement monotonic ACK/prune semantics and a host startup audit that refuses
   an invalid stream/outbox/watermark relation.

**RED → GREEN → REFACTOR:** RED — real supervisor/SQLite tests must fail without
atomic receipt+event persistence, serialized concurrent sequence allocation,
restart-stable stream state, ACK guards, exact soft/hard/reserve pressure, size
enforcement, negotiated schema redaction, and prune grace. Kill mutations that
move publish before commit or permit pruning one unacknowledged row. GREEN —
implement the SQLite migration, pure builder/redactor, atomic append, pressure,
ACK, prune, and startup audit. REFACTOR — converge every event producer on the
single append API and remove canonical `tailMaxMonotonicId` use while keeping
legacy-mode behavior isolated.
**Logging:** append/ACK/backpressure/recovery logs use safe IDs, sequence,
bytes, queue depth, latency, outcome/reason; never serialized envelope payload
or local path.
**Acceptance:** EVT-02/04/07/08/09/12 and their edge cases are green; every
canonical host event is durable before publish; sequence
is unique/monotonic under concurrency and restart; no unacknowledged row can be
pruned or silently dropped.

#### T1.2 — Expose host-global replay/ACK and implement local-direct transport

**Owner:** execution-host transport owner
**Depends on:** T1.1
**Files:** `supervisor/src/http-api.ts`, `types.ts`; `web/lib/supervisor-client.ts`,
`web/lib/execution-host/contracts.ts`, `types.ts`,
`transports/local-direct.ts`, `default-transport.ts`; API/AsyncAPI examples and
transport/wire tests

**Work**

1. Implement host-global SSE with the exact exclusive `Last-Event-ID` decimal
   cursor and the idempotent `(streamId, throughSequence)` ACK route. A reconnect first
   replays SQLite rows, then tails new durable appends.
2. Return typed replay-floor/gap and stream-identity conflict errors. Do not
   silently start at the newest event.
3. Bind the connection to the selected supervisor identity; verify event
   `hostKey` equals health/capability identity. Never accept a manager DB host ID
   from the wire.
4. Ensure disconnect/slow client has bounded memory and does not block event
   durability. SSE is a transport; no state transition depends on a live socket.
5. Keep `/sessions/{id}/stream` for legacy-mode compatibility only.
6. Enable the event-stream capability only after replay/ACK conformance is
   green; the overall canonical-mode requirement remains unsatisfied until B3.

**RED → GREEN → REFACTOR:** RED — conformance/integration tests fail for
inclusive replay, query cursor aliases, JSON-number/invalid/overflow cursors,
missing or stale ACK stream ID, ACK regression/beyond-emitted, replay-floor
loss, host-key mismatch, slow client growth, and reconnect framing. Include the
restart-between-read-and-ACK race from `EDGE-EVT-04`. GREEN — implement the
routes and local-direct adapter to the frozen OpenAPI/AsyncAPI. REFACTOR — share
only pure decimal/SSE parsing helpers and prove each negative fixture still
fails when its guard is removed.
**Logging:** connection/reconnect logs include safe host/stream/cursor/lag fields
and status; no event body.
**Acceptance:** EVT-06/07 and `EDGE-EVT-03/04/05` are green; an independent
client can restart and replay every unacked event
from SQLite; future transport adapters need only implement the same typed
methods.

#### T1.3 — Implement manager ingestion, contiguous promotion, and ACK recovery

**Owner:** web execution-host owner
**Depends on:** T0.4, T1.2
**Files:** new `web/lib/execution-host/events/{ingest,consumer,db,validate,redact}.ts`
or equivalent single-purpose modules; `web/lib/execution-host/index.ts`,
`resolver.ts`, `hosts.ts`, `web/instrumentation.ts`; real-Postgres integration
tests; `web/test-support/real-supervisor.ts`, `fake-execution-host.ts`

**Work**

1. Add one durable claim/lease per host stream using the established domain
   event/scheduler locking patterns. Start/recover the consumer after host
   registration and before lifecycle reconciliation.
2. In one DB transaction validate and insert each batch, classify duplicate or
   stale epoch, hold later events behind gaps, promote the contiguous prefix,
   allocate per-run sequence, and move the manager watermark. Command/session/
   transcript/cost/artifact folds use their own durable cursors in T1.4.
3. ACK the host only after commit. Persist the last host-confirmed ACK
   separately so ACK loss is observable; retry absolute ACK idempotently.
4. Validate current assignment server-side. A stale event advances the stream
   only as audited `stale_epoch`; it cannot mutate `runs`, `run_sessions`,
   `node_attempts`, prompt continuation, HITL, cost, or artifacts.
5. Detect boot changes and stream changes. Same stream/new boot is normal;
   unresolved old stream/new stream degrades the host and invokes explicit
   reconciliation.
6. Remove current-process `commandSignals` as an authority; retain a local wake
   primitive only over committed DB state.

**RED → GREEN → REFACTOR:** RED — real Postgres + real supervisor tests fail
without exactly-one insert under at-least-once delivery, ACK-loss replay,
pending-gap hold/release, replay-floor failure, stale-epoch non-mutation,
stream/boot reconciliation, and durable restart cursors. Contend a host event
and a manager event for the same run to prove unique contiguous `run_sequence`;
use a current-epoch positive control next to every stale-epoch denial. GREEN —
implement claim, ingest transaction, run-row allocation, ACK recovery, and
restart registration. REFACTOR — isolate validation/classification from the
transaction without moving authority out of Postgres; mutation-remove the
unique constraint, fence, or row lock and observe the owning test fail.
**Logging:** transaction/reconnect/ACK logs use the observability contract. Log
counts and hashes, never payloads.
**Acceptance:** EVT-01/03/04/05/06/07 and `EDGE-EVT-01/02/03` are green;
Postgres contains exactly one canonical event per host event and
is sufficient to restart ingestion without reading runtime files.

#### T1.4 — Add durable projector cursors, poison policy, and event reconciliation

**Owner:** web projection/recovery owner
**Depends on:** T1.3
**Files:** new `web/lib/execution-host/events/projector.ts` and
`reconciliation.ts`; `web/lib/execution-host/recovery.ts`,
`web/lib/reconcile.ts`, `web/instrumentation.ts`; projector/consumer integration
tests; `docs/error-taxonomy.md`, system analytics updates

**Work**

1. Implement independent per-`(consumer_name, run_id)` contiguous
   `run_sequence` cursors for lifecycle, transcript, cost, artifacts, and
   browser-safe projection. Keep ingestion and projection
   failure domains separate.
2. Retry transient projection failures with durable attempts/backoff. On a
   deterministic poison row, stop only the affected cursor, persist a sanitized
   failure, expose operator remediation, and explicitly fail/degrade any
   lifecycle whose truthful terminal state cannot be projected.
3. Reconcile command terminal event versus receipt with invariant equality;
   disagreement has no winner and quarantines owner application. Repair a
   missing event from a durable
   receipt only with a marked, deterministic synthesized event ID; never invent
   success from absence.
4. Order startup: migrations → local host registration/capability → event
   catch-up → prompt/command fold → run-kind-neutral recovery → domain-specific
   drivers/projector catch-up. Do not silently catch an integrity failure and
   report ready.
5. Add bounded periodic sweeps for reconnect, lag, poison, and terminal
   reconciliation; no filesystem polling.

**RED → GREEN → REFACTOR:** RED — real Postgres tests fail for transient retry,
fifth-attempt/deterministic poison, per-run cursor isolation, receipt-only
repair, terminal conflict, partial transaction failure, boot during catch-up,
and two managers contending for the same claim. A second run/consumer is the
positive control proving poison isolation; removing cursor CAS or owner fence
must fail. GREEN — implement consumers, poison state, reconciliation, startup
order, and bounded sweeps. REFACTOR — share claim/backoff primitives already
used by the repository while preserving domain-specific projector functions.
**Logging:** structured projector name, cursor, event, attempt, outcome, and
sanitized reason; poison logs are actionable and never include payload.
**Acceptance:** EVT-10, PRM-06, CUT-08, and `EDGE-PRM-03` are green; a bad
projection cannot corrupt or silently advance its cursor;
manager restart deterministically resumes; host events remain durable even if a
downstream view is unhealthy.

#### B1 acceptance gate

- Exactly-once canonical insert over at-least-once delivery is proven with real
  Postgres and supervisor.
- Sequence gaps, conflicts, stale epochs, host boot changes, manager restart,
  ACK loss, and backpressure have explicit tested outcomes.
- Canonical admission remains off until the host advertises the complete Stage
  B event + async-prompt + runtime-object capability set; B1 can ingest/test
  durable events while production runs remain legacy.
- Focused/full commands:

```bash
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/runtime-events.integration.test.ts src/__tests__/command-receipts.integration.test.ts src/__tests__/execution-fence.integration.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/execution-host/__tests__
pnpm --filter @maister/supervisor test
pnpm --filter maister-web test:integration
pnpm --filter @maister/supervisor typecheck
pnpm --filter maister-web typecheck
```

### B2 — Switch manager projections, browser SSE, and run lifecycle to canonical events

#### T2.1 — Make canonical session incarnations the lifecycle authority

**Owner:** web run-lifecycle owner
**Depends on:** T1.4
**Files:** `web/lib/reconcile.ts`, `web/lib/execution-host/recovery.ts`,
`db.ts`, new session-incarnation query/service modules;
`web/lib/runs/resume-recovery.ts`, `resume-driver.ts`, `sync-recovery.ts`,
`sync-resolver.ts`, `web/lib/runs/session-teardown.ts`,
`web/lib/gc/workspace-reconciler.ts`, `web/lib/services/agent-question.ts`,
evaluation dispatcher/recovery callers, scratch recovery route; affected
integration tests

**Work**

1. Fold session-created, ACP-session-bound, permission, checkpoint, exit,
   crash, and terminal prompt events into immutable incarnation rows and the
   current logical `run_sessions` pointer.
2. Replace `listSessions()` scans used to infer association/liveness with
   canonical manager state. Retain a targeted host status/receipt query only as
   diagnostic reconciliation when canonical state says a session may be live.
   The required consumer matrix covers scratch recovery, agent-question,
   runner-graph, workspace GC, global reconcile, evaluation dispatch/recovery,
   sync recovery, session teardown, and resume recovery; each row names its new
   canonical query and removal test.
3. Select host from the run's current assignment, not `hosts.local()`, while
   preserving the only supported local host. This is routing hygiene, not
   multi-host placement.
4. Drive recovery by `runs.run_kind` before Flow/scratch/agent/evaluation
   actions. Enforce assignment/epoch at every apply site so a late incarnation
   cannot transition the current run.
5. Preserve same-host ACP checkpoint/resume; a boot with no live accepted turn
   consumes `turn_lost`/checkpoint state instead of guessing from an empty
   `GET /sessions` list.

**RED → GREEN → REFACTOR:** RED — extend the named real-Postgres lifecycle,
resume, scratch, crash, keepalive, and recovery suites so empty/restarted host
registry, multiple incarnations, `turn_lost`, checkpoint resume, and late stale
incarnation fail before migration. For each stale denial include a current
assignment success and mutation-remove the apply fence. GREEN — implement event
folds, canonical queries, run-kind dispatch, and every consumer-matrix row.
REFACTOR — delete association `listSessions()` branches and consolidate current
incarnation lookup without removing diagnostic status reconciliation.
**Logging:** session lifecycle logs include logical/incarnation IDs, run kind,
assignment/epoch, source event, previous/new state, and reconciliation outcome;
no path or prompt.
**Acceptance:** EVT-05, PRM-05/07/08/10, CUT-08/11 are green; manager state and
recovery remain correct when supervisor
registry is empty/restarted; `GET /sessions` is no longer an association source.

#### T2.2 — Switch browser run SSE and manager-originated events to Postgres

**Owner:** web streaming owner
**Depends on:** T1.4
**Files:** `web/app/api/runs/[runId]/stream/route.ts`,
`web/lib/use-run-stream.ts`, `web/lib/runs/run-stream-event.ts`, callers in
`web/lib/services/runs.ts` and `web/lib/flows/graph/runner-graph.ts`, new
canonical event query/notification module; route/unit/integration tests;
web OpenAPI and web-runs AsyncAPI

**Work**

1. For canonical runs, replace file open/tail/100-ms polling with paginated DB
   replay by `run_sequence`; keep one explicit mode-gated legacy branch for
   already-admitted legacy runs until B4. Preserve authorization and status
   heartbeat.
2. Use Postgres `LISTEN/NOTIFY` or a process-local signal only as a wake hint;
   reconnect and missed hints always query DB. Bound page size, send buffer,
   idle lifetime, and cursor validation.
3. Replace manager file append with transactional canonical event append and
   deterministic manager event IDs. Make concurrent manager and host events
   receive unique run sequence values without a file lock.
4. Update browser cursor semantics and examples without exposing host stream
   IDs or raw open payload.

**RED → GREEN → REFACTOR:** RED — route/DB integration tests fail for exclusive
replay after zero/middle/end, invalid/overflow cursor, lost notification,
concurrent host/manager append, unauthorized run, slow client bound, raw payload
leak, and any event-file `fs` call. GREEN — implement canonical append/query/
wake and update browser contracts. REFACTOR — isolate the user-safe mapper and
paginated query; remove file polling only after mutation-replacing the DB query
with a file read fails the owning test.
**Logging:** stream open/close/replay page/lag/outcome using run/user-safe IDs;
no event payload.
**Acceptance:** EVT-01/04/11 and CUT-09 are green for canonical-mode fixtures;
browser history/live updates work when `run.events.jsonl` is absent and the web
process cannot access the host runtime root. The remaining legacy branch is
isolated by the immutable run mode and named for deletion in T4.2.

#### T2.3 — Move transcript, inbox, scratch-command, and artifact projections to canonical events

**Owner:** web projection/read-model owner
**Depends on:** T1.4, T2.1
**Files:** `web/lib/runs/run-transcript-projector.ts`,
`web/lib/projector/artifact-projector.ts`, `catch-up-sweep.ts`,
`web/lib/queries/inbox-context.ts`,
`web/lib/scratch-runs/available-commands.ts`, transcript/commands/artifact
routes and tests; `web/instrumentation.ts`

**Work**

1. Make canonical-run transcript projection consume ordered events and whole-
   run transcript reads query `run_messages`; stop using file mtime as event
   time on that branch. Keep only the explicitly mode-gated legacy reader until
   T4.2.
2. Project tool/artifact metadata by envelope `hostSessionId`/
   session-incarnation/node-attempt binding. Correct the current fragile
   comparison between `node_attempts.acp_session_id` and host session event ID.
3. Replace inbox last-message and scratch available-command scans with
   canonical projections, including projectless/local-package scratch runs.
4. Convert missing/malformed input fallbacks into typed projection or query
   errors. A true no-event case remains an explicit empty result.
5. Remove `events_log_path` from canonical consumer writes; only legacy-mode
   projection may update it until T4.2, and the column remains until T4.3.

**RED → GREEN → REFACTOR:** RED — convert each named suite to production-shaped
canonical rows and prove it fails if the projector reads JSONL, compares ACP ID
to host session ID, advances over unknown/quarantined/stale events, skips a
malformed required payload, or treats no-event as error. GREEN — implement each
projector/query and its per-run cursor. REFACTOR — share only canonical event
query/cursor primitives; remove overlapping JSONL fixture tests instead of
keeping two tests for the same behavior.
**Logging:** projector/cursor/source-event fields only; eliminate warnings that
mask malformed files.
**Acceptance:** EVT-01/05/08/10 and OBJ-01 are green; canonical-run views have no
execution-host path dependency and replay deterministically from Postgres; each
legacy branch is enumerated for T4.2 removal.

#### T2.4 — Make canonical usage events/cost facts authoritative

**Owner:** cost/read-model owner
**Depends on:** T1.4, T2.1
**Files:** `supervisor/src/cost.ts`, event emission/types;
`web/lib/runs/cost-rollups.ts`, `cost-reconcile-sweep.ts`,
`cost-summary-facts.ts`, `web/lib/domain-events/cost-rollup-reconcile.ts`,
cost routes/queries and tests; DB docs/system analytics

**Work**

1. Emit bounded redacted usage events with stable runner/session/command
   attribution; retain `cost.jsonl` only as legacy/local diagnostic.
2. In one Postgres transaction, upsert canonical cost facts/rollups and advance
   the cost consumer cursor. Do not delete then replace outside a transaction.
3. Make canonical-run queries and terminal reconciliation consume DB facts
   only. Keep the legacy-mode cost reader bounded until T4.2. Remove the domain-
   event consumer's error suppression; retry or poison using the durable cursor
   policy.
4. Preserve runner-snapshot attribution and historical totals during import.

**RED → GREEN → REFACTOR:** RED — canonical cost integration tests fail for
duplicate fact, stale epoch, wrong session/runner attribution, partial fold/
cursor transaction, terminal reconcile, and absent legacy file; include current
epoch and rollback controls. GREEN — emit validated usage events and fold facts
atomically. REFACTOR — reuse the durable consumer transaction and remove cost
file authority/error suppression while retaining legacy-mode diagnostic writes.
**Logging:** token/cost totals, runner snapshot ID, event ID, cursor, latency,
and outcome; no prompt or model response.
**Acceptance:** EVT-03/05/10 and CUT-03/09 are green; `cost.jsonl` deletion or
unavailability does not change manager cost summaries for canonical runs, and
the same holds for historical runs after T4.1 import.

#### T2.5 — Prove canonical lifecycle and read-model cutover as one increment

**Owner:** integration/E2E owner
**Depends on:** T2.1–T2.4
**Files:** `web/test-support/real-supervisor.ts`,
`web/test-support/fake-execution-host.ts`,
`web/e2e/_seed/test-supervisor.ts`,
`web/e2e/execution-host-contract.spec.ts`, new focused Stage B spec,
`web/playwright.config.ts`, relevant route/integration tests

**Work**

1. Extend the real-supervisor harness for isolated web and supervisor runtime
   roots, host restart on retained SQLite state, lost ACK/response, injected
   gap/duplicate/reorder, and canonical event inspection.
2. Extend the in-process E2E supervisor to implement the documented host-global
   contracts, but keep real durability assertions in integration tests.
3. Add an authenticated flow covering launch, permission, checkpoint, epoch-2
   resume, stale epoch rejection, cancel/complete, browser replay, transcript,
   available commands, and costs without a web-readable host runtime path.

**RED → GREEN → REFACTOR:** RED — first run the acceptance scenario with the web
runtime mount removed and observe the old SSE/projection path fail; inject one
duplicate, gap, late stale event, host restart, manager restart, and lost ACK,
each with a distinct expected visible outcome. GREEN — extend real and E2E
harnesses and make the scenario pass using prior task behavior only. REFACTOR —
deduplicate harness controls, not assertions; durability remains owned by real
integration tests and E2E asserts only user-visible outcomes.
**Logging:** test diagnostics print safe IDs/watermarks on failure, not payloads
or temp paths except behind test-debug opt-in.
**Acceptance:** CUT-09/11 and all B2 traceability rows are green; all requested
B2 user-visible views and the Stage A deferred
release/recovery lifecycle pass with separated runtime roots.

#### B2 acceptance gate

- Browser SSE and every listed projection/query use canonical manager state for
  canonical runs; only the enumerated immutable legacy-run branches remain.
- Stale events cannot mutate current run/session/cost/artifact state.
- The single-host launch/checkpoint/HITL/cancel/completion lifecycle still
  works; legacy active runs remain supported by their immutable mode.
- Focused/full commands:

```bash
pnpm --filter maister-web exec vitest run --project integration lib/projector/__tests__ lib/runs/__tests__/run-transcript-projector.integration.test.ts lib/runs/__tests__/cost-rollups.integration.test.ts lib/runs/__tests__/cost-reconcile-sweep.integration.test.ts lib/execution-host/__tests__/lifecycle-regression.integration.test.ts
pnpm --filter maister-web test:e2e -- e2e/execution-host-contract.spec.ts e2e/stage-b-data-plane.spec.ts
pnpm --filter maister-web test:integration
pnpm --filter @maister/supervisor test
pnpm validate:contracts
pnpm validate:docs:all
```

### B3 — Asynchronous prompt lifecycle and path-free runtime-object access

#### T3.1 — Make supervisor prompt admission asynchronous and restart-safe

**Owner:** supervisor ACP/session owner
**Depends on:** T1.1, T1.2
**Files:** `supervisor/src/http-api.ts`, `command-receipts.ts`, `registry.ts`,
`acp-client.ts`, `heartbeat.ts`, `execution-fence.ts`, `types.ts`, new focused
prompt lifecycle module; command-receipt, ACP prompt, lifecycle, permission,
checkpoint, cancel, and strict-envelope tests

**Work**

1. Add `POST /sessions/{sessionId}/prompts` as specified in B0. Fence and
   validate first; verify duplicate command ID invariant fields including the
   JCS request digest; persist
   accepted receipt and event before starting the ACP side effect; return 202.
2. Run the ACP turn independently of request lifetime. Persist terminal result
   receipt and canonical event before notifying manager clients.
3. On supervisor startup, inspect accepted prompt receipts with no live process
   and terminalize them exactly once as `turn_lost`; append the corresponding
   canonical event. Do not generalize this outcome blindly to side effects that
   have their own reconciliation.
4. Define ordered terminal outcomes for success, ACP error, permission pause,
   checkpoint, cancellation, fence eviction, session exit, and process crash.
5. Keep old synchronous response only for `legacy_file_v1` through B3. Both
   modes use the same command ID/receipt implementation.
6. Enable the async-prompt capability only after all supervisor prompt tests are
   green; partial capability still cannot admit an ordinary canonical run.

**RED → GREEN → REFACTOR:** RED — instrument the fake ACP process with a durable
call count and make real supervisor tests fail for response disconnect,
duplicate command delivery, restart with accepted/no-live-turn, terminal
receipt/event atomicity, permission pause, checkpoint, cancel, fence eviction,
and session exit/crash. Removing the pre-ACP fence or accepted transaction must
fail its owning test. GREEN — implement async admission/background turn and
startup terminalization. REFACTOR — isolate pure terminal reduction and one
receipt/event transaction path; keep the legacy synchronous adapter as a
mode-gated wrapper only.
**Logging:** command/session/assignment IDs, phase, stop reason, latency, and
outcome; never prompt or ACP content.
**Acceptance:** PRM-01/02/03/05/07/08/09/10 and `EDGE-PRM-01/02` are green;
prompt authority is accepted command + receipt/event, not an
open HTTP response, for canonical runs.

#### T3.2 — Make `PromptHandle` serializable and terminal application durable

**Owner:** web execution-command owner
**Depends on:** T0.3, T0.4, T1.4, T3.1
**Files:** `web/lib/execution-host/deliverer.ts`, `commands.ts`, `ledger.ts`,
`client.ts`, `recovery.ts`, `signals.ts`, `types.ts`, `db.ts`, new
prompt-continuation sweep/service; execution-host integration tests

**Work**

1. Persist a strict prompt origin and unique logical operation key before
   delivery. Define separate pure constructors for Flow node, scratch message,
   gate chat, agent turn, and sync-resolution origins; resume uses the owning
   domain's new logical operation rather than a sixth origin kind; no flag-driven
   multi-mode helper.
2. Return serializable data `PromptHandle {commandId}` and expose separate pure-
   input query/wait functions over `execution_commands`. Waiting subscribes only
   to commit wake hints and always rechecks DB.
3. Fold receipt/event terminal state by CAS. Conflicting terminal data becomes
   a typed invariant error, not last-write-wins.
4. Add a durable sweep for succeeded/failed/fenced prompt commands whose owner
   completion is unapplied. Apply the domain transition idempotently and mark
   completion in the same transaction where feasible.
5. Remove `commandSignals` as a result source. It may be deleted or replaced by
   a generic post-commit wake emitter with no payload authority.

**RED → GREEN → REFACTOR:** RED — real Postgres + supervisor tests fail for 202
loss, terminal ACK loss, web restart before terminal, restart after terminal but
before apply, concurrent live/sweep CAS, receipt-only repair, duplicate logical
operation, and receipt/event disagreement. Removing owner uniqueness or apply
CAS must produce duplicate ACP/domain effects in the test. GREEN — implement
typed owners, serializable handle, DB recheck wait, terminal fold, and recovery
sweep. REFACTOR — separate pure owner constructors/query/reducer functions and
delete payload-bearing `commandSignals` authority.
**Logging:** origin kind and stable owner ID, command ID, state transition,
attempt, duration, outcome/reason; no stored redacted payload dump.
**Acceptance:** PRM-04/06/11/12 and `EDGE-PRM-01/03` are green; a fresh web
process can query and correctly apply any prompt
terminal result without the original Promise or HTTP connection.

#### T3.3 — Migrate every prompt driver to durable continuation semantics

**Owner:** Flow/scratch/agent domain owners, coordinated by run-lifecycle owner
**Depends on:** T3.2
**Files:** `web/lib/flows/runner-agent.ts`, `web/lib/runs/resume-driver.ts`,
`sync-resolver.ts`, `web/lib/services/gate-chat.ts`,
`web/lib/scratch-runs/events.ts`, `service.ts`, `web/lib/agents/launch.ts`;
their integration tests and startup recovery wiring

**Work**

1. Replace each `.completion`-owned ephemeral driver with command origin,
   durable waiting, and an idempotent apply function.
2. Preserve each domain's existing CAS/claim. Never let a resumed old driver
   write after assignment fencing or a newer node attempt/session incarnation.
3. For HITL, persist permission/pause facts and derive target session from
   canonical state. A persisted `supervisorSessionId` is immutable audit data,
   not authority.
4. For scratch/agent/gate/sync flows, prove that startup recovery dispatches by
   `run_kind` and resumes the exact owner rather than applying a generic Flow
   outcome.
5. Remove direct `hosts.local().streamSession` use from production prompt
   drivers; use assignment-selected canonical subscriptions.
6. Maintain an explicit six-row migration matrix for `runner-agent`,
   `resume-driver`, `sync-resolver`, `gate-chat`, scratch events/service, and
   agent launch. Each row names old response/SSE authority, owner constructor,
   apply CAS, startup dispatcher, and source-removal test.

**RED → GREEN → REFACTOR:** RED — one production-shaped integration test per
matrix row kills/restarts web between acceptance and apply and fails if the old
Promise/SSE path is removed before durable continuation exists. Cover stale
attempt/epoch alongside current success, HITL pause/checkpoint/resume, cancel,
and run-kind misdispatch. GREEN — migrate all six rows and startup dispatch.
REFACTOR — remove direct local stream calls and duplicate wait/apply glue; do
not merge the five distinct owner constructors into a flag-driven helper.
**Logging:** domain owner kind/ID, run kind, command/session/epoch, apply state,
and outcome only.
**Acceptance:** PRM-03/04/08/09/10/11 and CUT-11 are green; no production
prompt caller requires an in-process completion
Promise or live supervisor SSE to finish correctly.

#### T3.4 — Add runtime-object schema, host registry, and typed transfer APIs

**Owner:** database + supervisor runtime-object owners
**Depends on:** T0.3, T0.4, T1.4, T3.1
**Files:** `web/lib/db/schema.ts`, generated next additive migration/journal/
snapshot and migration integration test; new `supervisor/src/runtime-objects.ts`,
`http-api.ts`, `host-state.ts`, `types.ts`, `workspace-registry.ts`;
OpenAPI/tests; DB docs/ERD

**Work**

1. Add `execution_runtime_objects` exactly as specified in D8 and the three
   command kinds to `execution_commands`. Maintain schema, generated SQL,
   journal, and snapshot together; add no transfer-attempt table because the
   existing command ledger owns retries and acknowledgement.
2. Extend host SQLite with private locator, temp/sealed/tombstone state, declared
   and observed metadata, and idempotency binding.
3. Implement reserve/upload/seal, metadata, bounded stream/range read, and
   fenced delete. Use temp + atomic rename, streaming hash/size validation, and
   confinement under a host-owned runtime-object root.
4. Implement `runtime_object.reserve`, `runtime_object.upload`, and
   `runtime_object.delete` through the existing Stage A command ledger/receipt/
   fence. The binary upload adapter carries command/fence headers and verifies
   the prior reservation; do not add a second side-effect ledger.
5. Make retention and deletion explicit. Never return a path; distinguish 404,
   410, 413, 416, checksum conflict, and storage/backpressure errors.
6. Enable the runtime-object capability after migration, route, command, and
   restart tests pass; this completes the supervisor feature set but the web
   build remains locally not-ready for canonical admission through T3.4.

**RED → GREEN → REFACTOR:** RED — real Postgres migration and supervisor/SQLite
tests fail for each D8 constraint, traversal/symlink escape, cross-run/epoch
access, interrupted upload, identical/conflicting retry, atomic seal, single/
multi/invalid/out-of-bounds ranges, MIME/size/hash/generation mismatch,
unknown/tombstone/corrupt state, delete ACK loss, restart, expiry, and
reader/delete race. Mutation-remove confinement, hash, fence, tombstone-before-
unlink, or command idempotency and observe the owning test fail. GREEN — add the
exact schema/commands/registry/routes and make contracts green. REFACTOR —
separate reserve/upload/read/delete functions and reuse existing atomic-write,
receipt, and fence primitives without a generic multi-mode handler.
**Logging:** object ID, kind, bytes, range, hash prefix, command/assignment,
duration, outcome/reason; never object content or private path.
**Acceptance:** OBJ-01 through OBJ-08, OBJ-11/12, and `EDGE-OBJ-01/02/03` are
green; host files are addressable only through typed opaque locators;
transfer and deletion are idempotent, bounded, fenced, and restart-safe.

#### T3.5 — Migrate runtime-file producers and consumers to object handles

**Owner:** web artifact/runtime-data owner
**Depends on:** T3.3, T3.4, T2.3, T2.4
**Files:** `web/lib/flows/graph/artifact-content.ts`, `artifact-store.ts`,
`default-artifacts.ts`, `runner-graph.ts`, `node-output.ts`,
`plan-review-artifact.ts`; `web/app/api/runs/[runId]/artifacts/[artifactId]/payload/route.ts`;
`web/lib/scratch-runs/service.ts`, `attachments.ts`, scratch capability profile
services/recover route; `web/lib/agents/launch.ts`; evaluation/verifier artifact
capture paths; execution-host client/transport; related tests and specs

**Work**

1. Add `ArtifactLocator {kind:"execution-object", objectId}` and make the
   browser route authorize run/artifact first, then server-derive the assigned
   host/object and stream content/range with preserved MIME, ETag, size, and
   error semantics.
2. Stop manager `stat/readFile` discovery of host outputs. Have the host
   register/seal declared output, default log, plan-review, verifier evidence,
   and generated artifact objects and emit their catalog events.
3. Upload scratch attachments, capability profiles, and agent memory snapshots
   as input objects. Prompt/start requests carry object references; the host
   resolves ACP-local `file://` content privately.
4. Replace raw output env paths with allocated output-object handles that the
   host maps to private paths before spawning ACP. On completion it seals and
   publishes metadata. Preserve tool-agnostic explicit output configuration and
   fail required missing evidence; do not generate `MISSING-REPORT.txt`.
5. Keep Git range/log locators, repository worktrees, Git checkpoint refs,
   checks, and promotion unchanged and documented as Stage C.
6. Add bounded streaming through the web route rather than buffering full
   object content. Verify checksum/size against the manager catalog.
7. After every prompt/file consumer matrix row is migrated and its focused test
   is green, set `CONTROL_PLANE_DATA_PLANE_VERSION = 1`. Admission still
   intersects it with the selected host's complete capability, so web-first
   deployment against an old/partial host remains legacy.

**RED → GREEN → REFACTOR:** RED — convert each listed producer/consumer suite
to object fixtures and fail on any host-runtime `stat/readFile/writeFile`,
wrong MIME/ETag/range, buffered full content, unauthorized/cross-run object,
checksum mismatch, deleted/missing payload, implicit tool output path, or
required evidence absence. Include positive manager-owned/Git locator controls
so Stage C data is not accidentally migrated. GREEN — implement locator,
catalog projection, typed uploads, host-private output mapping/seal, and proxy
streaming. REFACTOR — share authorization/metadata/stream primitives, delete
superseded host-path helpers/tests, and keep result transport distinct from
evidence payloads.
**Logging:** catalog/transfer safe fields only; never filename-derived private
path, content, prompt attachment bytes, or credentials.
**Acceptance:** OBJ-01/02/04/06/07/09/10/12 and CUT-09/12 are green; every
ACP-consumed/produced host runtime file in the inventory
uses an object handle; web has no direct host runtime read/write. Repository and
manager-only files remain correctly classified.

#### T3.6 — Prove restart-safe prompt and no-shared-runtime behavior end to end

**Owner:** integration/E2E owner
**Depends on:** T3.3, T3.5
**Files:** `web/test-support/real-supervisor.ts`, Stage B execution-host
integration tests, `web/e2e/stage-b-data-plane.spec.ts`,
`execution-host-contract.spec.ts`, E2E seed supervisor/config

**Work**

1. Run web and supervisor with distinct runtime-data roots and remove web read
   permissions/access to the host root after launch.
2. Prove launch, prompt progress, transcript, cost, attachment/input object,
   generated artifact/range read, permission, checkpoint, HITL resume,
   cancellation, completion, terminal release, and historical replay.
3. Restart web mid-turn and supervisor mid-turn in separate real-supervisor
   scenarios; verify original command ID, one ACP side effect, terminal
   reconciliation, and correct run-kind continuation.
4. Re-run Stage A deferred release and recovery regressions.

**RED → GREEN → REFACTOR:** RED — run the cross-process scenario with separated
roots and revoke web access after launch; independently restart web mid-turn,
restart supervisor mid-turn, lose 202/terminal ACK, retry upload/delete, and
attempt cross-run payload access. Each fault has one non-overlapping visible
assertion while integration suites own durability internals. GREEN — extend the
real-supervisor harness until the complete scenario passes. REFACTOR — reduce
harness duplication and retain the same injected faults/assertions.
**Logging:** on failure include safe command/event/object/watermark timeline.
**Acceptance:** PRM-02/03/05/11, OBJ-02/03/06/11, and CUT-09/11 are green; all
required normal and failure flows work with no host runtime
directory visible to web.

#### B3 acceptance gate

- Canonical-run prompt lifecycle survives web/supervisor restart and
  acknowledgement loss.
- Duplicate commands cannot repeat ACP or object side effects.
- Canonical-run runtime artifacts are typed, path-free, bounded, checksummed,
  authorized, and streamable; active legacy runs retain only their named
  compatibility branches until B4 drain.
- Default one-host behavior remains operational without added services/setup.
- Focused/full commands:

```bash
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/command-receipts.integration.test.ts src/__tests__/lifecycle.integration.test.ts src/__tests__/permission-roundtrip.integration.test.ts src/__tests__/runtime-objects.integration.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/execution-host/__tests__ lib/flows/graph/__tests__/runner-graph-artifacts.integration.test.ts lib/scratch-runs/__tests__/scratch-placement.integration.test.ts
pnpm --filter maister-web test:e2e -- e2e/execution-host-contract.spec.ts e2e/stage-b-data-plane.spec.ts
pnpm --filter @maister/supervisor test
pnpm --filter maister-web test:integration
```

### B4 — Remove legacy runtime-file authority, scratch mirror, and compatibility

#### T4.1 — Drain legacy active runs and import historical runtime data

**Owner:** migration/cutover owner
**Depends on:** all B2 and B3 tasks
**Files:** new bounded import/preflight service and CLI/admin startup job under
`web/lib/execution-host/legacy-import/`; required supervisor legacy-object
registration API behind cutover authorization; `web/instrumentation.ts`; import
schema/queries; integration tests;
deployment runbook

**Work**

1. Disable creation of new `legacy_file_v1` runs once every supported host has
   canonical capability. Leave already-active runs in their immutable mode and
   drain them; do not flip in place.
2. Project historical event, transcript, cost, command/session, and artifact
   metadata while legacy data is available. Parse JSONL strictly in byte-offset/
   line-number order, preserve legacy monotonic IDs only as metadata, create
   deterministic IDs from run/source/position/hash, and stop at the exact
   malformed position with durable complete/missing/failed accounting.
3. Register existing host files into the object catalog and rewrite file
   locators only after unique association plus size/hash proof. Keep explicit
   tombstones for already-missing optional content. Required unresolved content
   blocks cutover.
4. Reconcile every completed run's terminal state against durable DB state.
   Late/duplicate/reordered records follow normal ingest rules; unfillable gaps
   block the affected import instead of being skipped.
5. Provide a dry-run report with counts and stable IDs. Require zero active
   legacy runs, zero unresolved required import rows, all-new web replicas, and
   minimum supervisor capability before B4 destructive migration.

**RED → GREEN → REFACTOR:** RED — real Postgres plus fixture host runtime tests
fail for a completed historical run, byte-order preservation, duplicate/reorder,
malformed required line with position, missing optional/required object,
checksum/association conflict, interrupted transaction/process, terminal-state
disagreement, and idempotent rerun. Removing source fingerprint/position or
marking complete before writes must fail. GREEN — implement dry run, resumable
import, object registration, accounting, and B4 preflight. REFACTOR — share
canonical importer primitives without merging distinct source parsers or
weakening strict failures.
**Logging:** progress counts, run/object IDs, source position/hash prefix, and
typed failure reason; no imported payload/content/path.
**Acceptance:** CUT-03/04/05/07/08 and `EDGE-CUT-01/02` are green; historical
runs remain viewable from canonical DB/object APIs
with the legacy directory removed; any unproven preservation fails loudly.

#### T4.2 — Delete legacy event/prompt readers and writers

**Owner:** supervisor + web execution-host owners
**Depends on:** T4.1
**Files:** `supervisor/src/events-log.ts`, `registry.ts`, `spawn.ts`,
`http-api.ts`; `web/app/api/runs/[runId]/stream/route.ts`,
`web/lib/runs/run-stream-event.ts`, projection/transcript/cost/inbox/scratch
modules, `web/lib/execution-host/legacy.ts`, prompt transport paths;
contracts/docs/tests

**Work**

1. Remove every production web read/write of host `run.events.jsonl`,
   `cost.jsonl`, raw logs, attachments, profiles, memory snapshots, outputs, and
   artifacts. Enforce the T0.1 source guard.
2. Remove legacy blocking prompt behavior and all authoritative per-session SSE
   consumers. Delete the per-session route if it has no diagnostic owner;
   otherwise mark it non-authoritative, bounded, and outside manager logic.
3. Stop legacy dual file writes. A bounded host-local diagnostic export may
   remain only if disabled/non-authoritative, retention-controlled, and absent
   from every manager contract.
4. Delete capability-404 fallback and reject hosts without the Stage B minimum
   for new work. Retain per-run mode only as historical provenance, not runtime
   dispatch.
5. Remove `adoptLegacyActiveRuns()` only after its Stage A responsibilities are
   demonstrably superseded; do not remove Stage C `ensureAssignment()` or local
   placement seams here.

**RED → GREEN → REFACTOR:** RED — switch the T0.1 classification guard to fail
on every remaining `host-runtime-legacy` production read/write and prove it
catches one reintroduced file reader, blocking prompt call, per-session stream
consumer, capability-404 fallback, and dual writer. Include a legacy historical
read positive control through canonical import and an old-host admission
rejection. GREEN — delete all matrix entries and obsolete contracts/routes or
mark the diagnostic route explicitly non-authoritative. REFACTOR — remove dead
helpers/tests/exports while preserving Stage C repository and assignment seams.
**Logging:** remove legacy path/error logs; keep typed minimum-version and
cutover refusal logs.
**Acceptance:** EVT-01/11, PRM-03, CUT-06/09/12 are green; deleting the host
runtime directory cannot affect a completed
manager view; an active canonical run has no hidden file fallback.

#### T4.3 — Preserve and remove the scratch session mirror and path cursor

**Owner:** database + scratch lifecycle owners
**Depends on:** T4.1, T2.1, T3.3
**Files:** `web/lib/scratch-runs/service.ts`, `recovery.ts`, `state.ts`,
`events.ts`, types; scratch recover/discard/interrupt/stop routes and tests;
`web/lib/db/schema.ts`, generated destructive migration/journal/snapshot and
migration integration test; `artifact_projection_cursors`; DB docs/ERD

**Work**

1. First release: remove every read of
   `scratch_runs.supervisor_session_id`, derive the current target from
   `run_sessions`/incarnations/assignment, and stop all mirror writes. Ensure
   HITL snapshots cannot be used as targeting authority.
2. Destructive migration transaction/preflight:
   - create a default session and `legacy_backfill` incarnation when a non-null
     mirror lacks one but run/host/session association is uniquely provable;
   - abort if canonical non-null host session differs;
   - abort ambiguous/unprovable host or session ownership;
   - copy mirror only into canonical NULLs and create/prove incarnation history
     without inventing unknown assignment/host facts;
   - assert zero unresolved associations;
   - drop `scratch_runs.supervisor_session_id`;
   - drop `artifact_projection_cursors.events_log_path` or the obsolete cursor
     table once all canonical consumer rows exist.
3. Generate schema/SQL/journal/snapshot with Drizzle, add deliberate guarded SQL
   only where generation cannot express preserve-or-fail preflight, then run
   generation/dry-check and real-Postgres tests from the previous migration for
   success and every refusal branch.
4. Update queries, types, fixtures, seeds, API contracts, DB docs, and ERD. No
   compatibility view/trigger or indefinite dual write.

**RED → GREEN → REFACTOR:** RED — scratch placement/message/HITL/recover/
interrupt/stop/discard and real migration tests fail for canonical targeting,
unique missing-row backfill, canonical NULL fill, canonical conflict,
ambiguous/unprovable ownership, rollback on one bad row, obsolete cursor
presence, and old-column access. GREEN — stop reads/writes, preserve rows, apply
the guarded destructive migration, and update all four migration artifacts/docs.
REFACTOR — remove mirror/cursor types and fixtures; mutation-removing each abort
guard or transaction boundary must fail its primary migration test.
**Logging:** migration refusal logs counts/stable IDs only; runtime scratch logs
use canonical incarnation/assignment IDs.
**Acceptance:** CUT-05/06/07 and `EDGE-CUT-02` are green; all provable
associations survive in canonical tables;
unprovable data prevents migration; neither dropped field/path exists in schema
or production code.

#### T4.4 — Finalize deployment, docs, retention, and full regression

**Owner:** release/documentation owner
**Depends on:** T4.2, T4.3
**Files:** ADR/system analytics from T0.2 and API/error contracts from T0.3;
`docs/architecture.md`, `supervisor.md`, `configuration.md`, `deployment.md`,
`database-schema.md`, `error-taxonomy.md`, DB domain docs/ERD, README;
`.env.example`, package env samples, deploy sample, `Dockerfile`, both compose
files; CI/workflow only if an existing lane must include new focused tests

**Work**

1. Change designed expectations to `Implemented` only after code/tests pass.
   Update ADR with final route/table/version names and the bounded compatibility
   outcome, without turning it into a changelog.
2. Document normal operation, replay/gap/poison runbook, watermarks,
   backpressure, Stage B no-compaction retention, runtime-object deletion,
   storage growth, and troubleshooting using typed reason tokens.
3. Document that web does not mount/read host runtime data, but repository/
   worktree/Git/check/promotion co-location remains until Stage C.
4. Verify every new setting is symmetric across all required surfaces; if no
   settings were added, explicitly state fixed defaults and preserve empty
   compose host-service wiring.
5. Recheck/renumber ADR and migrations after final rebase, regenerate all
   snapshots/ERD, and run the complete gate below.

**RED → GREEN → REFACTOR:** RED — run the complete gate with one deliberate
Designed/Implemented mismatch, forbidden log field fixture, asymmetric setting,
broken contract example, stale ERD, and web host-root mount; each validator must
fail for its own reason. GREEN — update as-built docs/status, deployment,
contracts, ERD, analytics, logs, and full regression until all gates pass.
REFACTOR — remove duplicated docs and test overlap, then rerun mutation fixtures
and the complete suite; verify named invariants rather than coverage counts.
**Logging:** review sampled verbose logs for required fields and forbidden
payload/path leakage; add a test or structured logger assertion for redaction.
**Acceptance:** all EVT/PRM/OBJ/CUT traceability rows are `Implemented` and
green; docs match as-built behavior, default launch remains simple,
all Stage B invariants pass, and no Stage C/D feature appears.

#### B4 acceptance gate

- Zero active legacy-mode runs and zero unresolved required imports.
- No production web access to the execution-host runtime root.
- No blocking prompt authority, legacy event-file projection, host-runtime file
  locator, or scratch session mirror remains; manager-owned and Git locators
  explicitly deferred to Stage C remain valid.
- Historical and active run behavior is manager-canonical.
- Full commands:

```bash
pnpm --filter @maister/supervisor exec eslint .
pnpm --filter maister-web exec eslint .
pnpm --filter @maister/supervisor typecheck
pnpm --filter maister-web typecheck
pnpm --filter @maister/supervisor test
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web test:e2e -- e2e/execution-host-contract.spec.ts e2e/stage-b-data-plane.spec.ts
pnpm validate:contracts
pnpm validate:docs:all
pnpm --filter maister-web db:check
pnpm --filter maister-web db:erd --check
```

## Upgrade, recovery, and rollback strategy

Compatibility is bounded to the B0-B3 deployment train and must be removed by
B4 before Stage C begins. Per-run mode is immutable, so no request can
silently alternate between file and canonical authority.

| Scenario | Required behavior |
| --- | --- |
| Supervisor-first B0/B1 | New supervisor preserves `/health` v1, synchronous legacy prompt, per-session SSE, and legacy files. Old web remains operational. New event/object APIs are additive and idle. |
| Web-first B0 | Capability endpoint 404 selects `legacy_file_v1`; no canonical run is admitted. Additive DB columns/tables do not break old supervisor. |
| Both upgraded during B1-B2 | Capability is partial, so production admission remains `legacy_file_v1`; canonical ingest/projection is exercised by integration fixtures only. No ordinary run is silently flipped. |
| Both upgraded after B3 gate | The complete capability set admits new runs as `canonical_events_v1`; already-active legacy runs stay legacy. Each manager branch reads only the authority named by the immutable run mode. |
| Active run during deployment | Never flip mode. Let it finish/drain on compatible binaries. If it fails, recover under the same mode before B4. |
| Historical completed run | Import event/transcript/cost/object metadata deterministically; record complete/missing/failed. Historical UI reads canonical projections only after its import is complete. |
| Duplicate/late/reordered event | Unique constraints deduplicate. Later event waits behind a gap. A late event for a superseded epoch is audited but cannot project. |
| Missing replay event | Manager keeps ACK at last contiguous. If host can replay, fill and proceed. If below replay floor/state lost, degrade host and fail/recovery-mark affected active run explicitly. |
| Network partition | Host retains bounded unacknowledged outbox; manager retry/reconnect owns recovery. At bound, host backpressures command admission; no dropped events. |
| Host restart | Same state directory retains identity, stream, sequence, receipts, objects, and outbox; boot ID changes. Accepted prompt without a live ACP turn terminalizes `turn_lost`. |
| Host state loss/new stream | Manager retains historical canonical events. Unresolved old-stream active assignments cannot be silently attached to new stream; host is degraded and same-host recovery creates a fresh fenced incarnation where policy permits. |
| Manager restart | New process claims stream from Postgres contiguous watermark, reconciles receipt/event, and runs pending prompt/projector sweeps. |
| Assignment expiry/epoch change | Stage A fence remains authoritative. Stale events/commands cannot mutate current state. Stage B does not activate distributed leases or placement. |
| DB commit succeeds, ACK fails | Host replays; manager verifies duplicate and repeats absolute ACK. |
| DB unavailable during ingest | No ACK. Host buffers to bound. Manager reconnects and resumes from durable watermark. |
| Browser disconnect | Browser reconnects by run sequence and receives DB replay; it never asks host directly. |
| B4 preflight failure | Keep B0-B3 compatible binaries and legacy files; correct the named data issue, rerun dry-run/import. Do not apply destructive migration. |

### Schema migration and rollback

- **Additive event migration (provisional `0131`):** creates the event-stream,
  event, ingest-failure, consumer, session-incarnation, and import tables; run
  mode/sequence columns and
  immutability trigger, and prompt-continuation columns/indexes/checks exactly
  as D4 specifies. It backfills current runs to `legacy_file_v1`. Rollback is
  redeploying old code while leaving additive tables/columns unused; do not drop
  rows after canonical admission has started.
- **Additive object migration (provisional `0132`):** safe for old web; object
  catalog and the three expanded command-kind values remain unused until
  capability gates enable them. Rollback is old code over additive schema plus
  retention of host objects; never remove catalog rows while host tombstones/
  bytes may still reference them.
- **Destructive cleanup migration (provisional `0133`):** only after T4.1
  preflight, backup, all-new web replica gate, zero active legacy runs, and zero
  unresolved required imports. It performs scratch preserve-or-fail backfill,
  drops the scratch mirror and obsolete path cursor, changes the run-mode
  default to `canonical_events_v1` through the guarded maintenance path, and
  leaves historical mode values intact. There are no down migrations; rollback
  after this point is roll-forward or restore the Postgres backup and matching
  host state/runtime backup, then redeploy B0-B3 binaries.
- `schema.ts`, SQL, journal, and snapshot are one atomic review unit per
  migration. Generate first; document and test deliberate SQL-only triggers/
  preflights, then rerun generation/dry-check, journal integrity, and real-
  Postgres migration tests after any rebase or renumber.
- Host SQLite schema upgrades are forward-only and transactional. Before the
  B4 cleanup/rewrite, snapshot the host state DB using SQLite's supported backup
  mechanism while the supervisor is quiesced; never copy a live WAL trio
  inconsistently.

## Verification traceability

| Required invariant | Primary proof | Regression proof |
| --- | --- | --- |
| At-least-once delivery creates one canonical record | T1.3 real Postgres + real supervisor duplicate/ACK-loss test | unique-constraint migration test and B4 E2E |
| Stale epoch cannot mutate current run | T1.3 stale applied-state diff test | Stage A fencing/lifecycle E1 and B2 projectors |
| Duplicate commands do not repeat ACP side effects | T3.1 fake-ACP invocation count with real supervisor | command receipts and deliverer suites |
| Gap recovered or fails explicitly | T1.3 missing/fill/replay-floor tests | browser/projector withheld-until-contiguous tests |
| Restart resumes from durable ACK watermark | T1.1 host restart + T1.3 manager restart | T3.6 combined flow |
| Prompt completion survives web restart | T3.2/T3.3 per-origin restart tests | T3.6 E2E |
| Supervisor restart gives truthful prompt result | T3.1 `turn_lost`/checkpoint tests | T3.6 recovery flow |
| Terminal state reconciles after ACK/response loss | T1.4 receipt/event repair and T3.2 apply sweep | command-recovery suite |
| Historical runs remain viewable | T4.1 real import fixtures | B4 E2E after legacy directory removal |
| Web operates without host runtime mount | T2.5 for events/views; T3.6 for objects/full lifecycle | source guard in T4.2 |
| Single-host normal lifecycle remains working | T2.5/T3.6 launch → HITL → checkpoint/resume → cancel/complete | `execution-host-contract.spec.ts` |
| Deferred release/recovery does not regress | Existing execution-host lifecycle/ledger/recovery suites | B4 full integration/E2E gate |
| Object access is typed/authorized/bounded | T3.4 host API and T3.5 web route tests | T3.6 full flow |
| Historical scratch sessions preserved | T4.3 migration success/refusal tests | scratch placement/recovery/HITL suites |

### Requirement-to-implementation matrix

The test IDs below are stable test titles/fixture IDs to create in the named
task. A primary proof owns the invariant; broader suites reference it instead of
retesting its internals.

| Requirement | Contract/schema | Enforcement / task | Primary RED proof and killed mutation |
| --- | --- | --- | --- |
| EVT-01 | event-plane analytics; web-runs AsyncAPI | canonical queries, T2.2/T2.3 | `IT-EVT-01 no host-runtime event authority`; reintroduce file read |
| EVT-02 | host AsyncAPI; SQLite outbox | atomic append, T1.1 | `IT-EVT-02 commit before publish`; publish before transaction |
| EVT-03 | event unique constraints | ingest conflict classifier, T0.4/T1.3 | `IT-EVT-03 at-least-once exactly one`; remove either unique |
| EVT-04 | decimal sequence schemas; run counter | host allocator/run-row lock, T1.1/T1.3 | `IT-EVT-04 ordered above MAX_SAFE_INTEGER`; use JSON number/remove lock |
| EVT-05 | stale disposition; assignment FK | ingest/projector fences, T1.3/T2.1 | `IT-EVT-05 stale audit no mutation`; remove epoch predicate |
| EVT-06 | replay/ACK errors; gap columns | stream consumer, T1.2/T1.3 | `IT-EVT-06 gap hold fill floor`; advance ACK over gap |
| EVT-07 | SSE/ACK contracts; stream cursors | host/manager recovery, T1.1–T1.3 | `IT-EVT-07 restart from watermark`; use process cursor |
| EVT-08 | negotiated payload schemas/errors | host/manager redactors, T0.3/T1.1/T1.3 | `CT-EVT-08 schema/redaction quarantine`; persist raw unknown payload |
| EVT-09 | capability limits | outbox pressure state, T1.1 | `IT-EVT-09 soft hard terminal reserve`; admit at soft/drop at hard |
| EVT-10 | consumer table | projector CAS/poison, T1.4 | `IT-EVT-10 cursor and poison isolation`; advance poisoned cursor |
| EVT-11 | web-runs AsyncAPI | browser-safe mapper/query, T2.2 | `IT-EVT-11 exclusive authorized replay`; make inclusive/bypass membership |
| EVT-12 | ADR/retention analytics | ACK prune, no compactor, T1.1/T4.4 | `IT-EVT-12 retention and ACK grace`; prune unacked/early row |
| PRM-01 | async prompt OpenAPI/AsyncAPI | supervisor admission, T3.1 | `IT-PRM-01 durable before 202`; return before receipt/event commit |
| PRM-02 | command idempotency contract/index | receipt duplicate join, T3.1 | `IT-PRM-02 one ACP call`; bypass invariant comparison |
| PRM-03 | prompt lifecycle analytics | async host + drivers, T3.1/T3.3 | `IT-PRM-03 disconnect independent`; cancel on HTTP close |
| PRM-04 | owner schema/index | continuation service, T0.4/T3.2 | `IT-PRM-04 one typed owner/apply`; remove owner uniqueness/CAS |
| PRM-05 | `turn_lost` event schema | host startup repair, T3.1 | `IT-PRM-05 restart yields turn_lost`; replay prompt text |
| PRM-06 | terminal error taxonomy | reconciler, T1.4/T3.2 | `IT-PRM-06 disagreement blocks apply`; choose last writer |
| PRM-07 | session terminal schemas | heartbeat/prompt reducer, T3.1 | `IT-PRM-07 prompt before session terminal`; emit exit first |
| PRM-08 | permission/checkpoint schemas | host + owner drivers, T2.1/T3.3 | `IT-PRM-08 durable HITL resume`; reuse stale command/incarnation |
| PRM-09 | cancel command/event contract | Stage A ledger, T3.1/T3.3 | `IT-PRM-09 retry cancel one terminal`; duplicate terminalization |
| PRM-10 | fenced receipt/event schemas | pre-ACP fence, T3.1 | `IT-PRM-10 stale prompt fenced`; move fence after ACP |
| PRM-11 | `PromptHandle` type/query contract | DB-backed handle, T3.2 | `IT-PRM-11 fresh process resolves`; require original Promise |
| PRM-12 | ADR retention rule | command prune query, T3.2/T4.4 | `IT-PRM-12 prune eligibility`; omit ACK/apply/run/grace predicate |
| OBJ-01 | runtime-object OpenAPI; locator schema | catalog/transport, T3.4/T3.5 | `CT-OBJ-01 no path property`; add path to wire/catalog |
| OBJ-02 | web payload OpenAPI | server-derived authorization, T3.5 | `IT-OBJ-02 cross-run substitution hidden`; trust client host/object binding |
| OBJ-03 | command kinds/checks | Stage A deliverer/receipts, T3.4 | `IT-OBJ-03 reserve upload delete reuse ledger`; bypass command ID |
| OBJ-04 | metadata schema/checks | seal/conflict validator, T3.4 | `IT-OBJ-04 immutable generation metadata`; overwrite different hash |
| OBJ-05 | upload contract | temp/hash/atomic rename, T3.4 | `IT-OBJ-05 interrupted upload invisible`; expose temp before rename |
| OBJ-06 | range OpenAPI | host stream/web proxy, T3.4/T3.5 | `IT-OBJ-06 single bounded range`; accept multi-range/full fallback |
| OBJ-07 | typed object errors/state CHECK | host/catalog resolver, T3.4/T3.5 | `IT-OBJ-07 distinct missing states`; return empty 200/generic 404 |
| OBJ-08 | redaction/error taxonomy | logger/event allowlists, T3.4/T4.4 | `IT-OBJ-08 no content or path logs`; log body/private path |
| OBJ-09 | ownership analytics | catalog/projection boundary, T3.5 | `IT-OBJ-09 manager vs host ownership`; copy raw diagnostics to DB |
| OBJ-10 | artifact analytics | node output/evidence adapters, T3.5 | `IT-OBJ-10 result and evidence separate`; use collection glob as writer config |
| OBJ-11 | delete command/event contract | tombstone-before-unlink, T3.4 | `IT-OBJ-11 delete ACK loss idempotent`; unlink before tombstone |
| OBJ-12 | retention analytics/catalog states | GC/import/payload route, T3.5/T4.4 | `IT-OBJ-12 metadata survives bytes`; delete catalog with content |
| CUT-01 | capability/run-mode contract; trigger | admission/writers, T0.4/T0.5 | `IT-CUT-01 immutable explicit mode`; omit writer value/change active row |
| CUT-02 | compatibility table/ADR | capability decision, T0.5 | `IT-CUT-02 both rolling orders`; parse 404 as canonical/alter health v1 |
| CUT-03 | import table/analytics | importer/read models, T4.1 | `IT-CUT-03 historical view after import`; require legacy directory |
| CUT-04 | cutover analytics | B4 preflight, T4.1 | `IT-CUT-04 active legacy blocks`; ignore one active legacy run |
| CUT-05 | destructive migration | scratch/object preserve guards, T4.1/T4.3 | `IT-CUT-05 preserve or fail`; discard ambiguous association |
| CUT-06 | source guard/ADR | deletion and capability gate, T4.2/T4.3 | `ST-CUT-06 no dual authority`; reintroduce fallback/dual write |
| CUT-07 | import state table | resumable importer, T4.1 | `IT-CUT-07 partial import resumes`; mark complete before final commit |
| CUT-08 | reconciliation analytics | event/prompt/import sweeps, T1.4/T4.1 | `IT-CUT-08 partial failure converges`; infer terminal success from absence |
| CUT-09 | deployment contract | mount-free harness, T2.5/T3.6/T4.2 | `E2E-CUT-09 web without host root`; restore shared mount/read |
| CUT-10 | compose/config docs | default deployment, T0.5/T4.4 | `SM-CUT-10 one-host no extra service`; require relay/object store/env |
| CUT-11 | Stage A acceptance suite | lifecycle regressions, T2.5/T3.6 | `E2E-CUT-11 launch HITL checkpoint cancel complete`; break deferred release |
| CUT-12 | scope inventory/ADR | source guard/review, T0.1/T4.4 | `ST-CUT-12 no Stage C expansion`; move Git/worktree operation to host |

### Test-level ownership

- **Pure unit:** envelope/parser/redaction, range parsing, sequence-prefix
  calculation, logical prompt-origin constructors. No mocks of durability.
- **Supervisor integration:** SQLite/outbox, ACP call count, receipts, fencing,
  prompt lifecycle, object streaming, restart.
- **Web integration:** real Postgres ingest/projectors, command continuation,
  route authorization, import, migration.
- **Cross-process integration:** `real-supervisor.ts` plus fake ACP and real
  Postgres for ACK/response loss and restart.
- **E2E:** authenticated user-visible lifecycle/read models. Do not duplicate
  low-level WAL assertions here.

## Risk register

| Risk | Impact | Mitigation / owner | Exit signal |
| --- | --- | --- | --- |
| SQLite receipt and event writes are not atomic | Terminal command can exist without event | T1.1 refactors them onto one `synchronous=FULL` transaction before ACP/publication | crash-point test proves neither one-sided state is observable |
| One global host stream creates head-of-line blocking | Bad event can stall all runs on host | Keep strict gap truth; separate projector poison from ingest; bound payloads and validate at source. Do not shard before evidence | load/backpressure test meets documented bound |
| Open payload leaks secrets/paths | Canonical DB/log/browser disclosure | Negotiate known type/schema, type-specific redaction at host plus manager defense, spine-only quarantine, browser allowlist, no payload logs/digests before redaction, size cap | redaction/security tests and log review pass |
| JSON sequence loses precision | Gap/dedup corruption above `MAX_SAFE_INTEGER` | Decimal-string wire, signed-BIGINT cap, Zod `bigint` transform, contract fixtures on both sides | boundary/overflow and exact round-trip tests pass |
| ACK races a host stream replacement | New stream rows are pruned from an old observation | ACK includes request-supplied `streamId`; host validates exact current stream and emitted bound | restart-between-read-and-ACK test rejects old stream |
| `run_sequence` allocation contends on hot run | Latency under verbose sessions | Batch contiguous events and allocate range under one short run-row transaction; measure before adding counters/services | ingestion latency metric within accepted local threshold |
| Capability negotiation becomes permanent fallback | Dual authority never ends | Immutable run mode, B4 minimum version, zero-legacy gate, delete 404 fallback before Stage C | B4 source/DB preflight passes |
| A production run writer omits explicit mode | Legacy runs continue invisibly after upgrade | Sweep all four writer families, production-shaped tests, B4 canonical DB default and old-host refusal | writer matrix and zero-new-legacy metric pass |
| Historical JSONL has collisions/malformed lines | Silent history loss or ambiguous order | Deterministic import with explicit failed status; do not fabricate original total order; preserve source position and fail required ambiguity | all required imports complete or cutover stops |
| Existing file artifacts lack checksum/MIME | Cannot prove object association | Host hashes/stat detects MIME conservatively; rewrite only unique proven locator; explicit tombstone/missing otherwise | import report has zero required unresolved |
| Large content exhausts web/host memory | Availability failure | Streaming/range, byte limits, backpressure, temp quotas, never full-buffer payload route | transfer stress/bound tests pass |
| Accepted prompt completes while manager is down | Domain continuation lost | Durable receipt/event + owner key + apply sweep; idempotent domain CAS | web restart tests pass for every origin |
| Supervisor restart cannot resume live ACP turn | Wrong automatic replay/double side effect | Explicit `turn_lost`; same command never replays prompt; existing checkpoint policy decides next action | one ACP call + truthful recovery test |
| `run_sessions` overwrite loses historical association | Scratch/history corruption | Immutable incarnation table before mirror migration; guarded preserve-or-fail SQL | T4.3 conflict/refusal tests pass |
| Removing shared runtime root accidentally moves Git/worktree scope | Stage B balloons and destabilizes delivery | Ownership inventory/source guard; keep repo/Git/check/promotion paths documented Stage C | no Stage C files/routes in diff except compatibility comments/tests |
| Cost projector repeats/loses facts | Incorrect billing/analytics | Event uniqueness + transactional facts/rollup/cursor; no swallowed consumer errors | duplicate/rollback cost tests pass |
| Host outbox fills during partition | New work stalls | Explicit high-water admission failure, metrics/runbook, never drop; single-host local transport should normally recover quickly | bounded partition test and operator alert |
| Destructive migration races old web replica | Runtime failures/data loss | all-new version gate, drain, backup, coordinated B4 deploy; after drop no mixed-version promise | deployment preflight refuses old replica |
| Tests pass without proving the intended guard | False confidence in fencing/durability | Named primary test per requirement, recorded RED failure, critical mutation removal, non-overlapping test ownership | traceability validator and mutation evidence pass |
| Analytics/contracts/schema disagree | Implementers satisfy one artifact while violating another | SDD hierarchy, unique IDs, linked-artifact validator, same-commit update rule | no orphan/duplicate/status-mismatch validation failures |

## Coherent commit plan

Keep commits independently reviewable and green for the mode they enable. The
suggested commits map directly to tasks; generated migration triples stay with
their schema commit.

1. `docs(stage-b): specify durable execution-host data plane` — T0.1–T0.2.
2. `docs(api): publish execution-host data-plane contracts` — T0.3.
3. `feat(db): add canonical execution event schema` — T0.4.
4. `feat(execution-host): negotiate data-plane capabilities` — T0.5.
5. `feat(supervisor): persist runtime event outbox` — T1.1.
6. `feat(execution-host): add host event replay and acknowledgements` — T1.2.
7. `feat(execution-host): ingest canonical runtime events` — T1.3–T1.4.
8. `feat(runs): project canonical session lifecycle` — T2.1.
9. `feat(runs): stream canonical events to browsers` — T2.2.
10. `feat(projectors): read transcript activity and artifacts from events` — T2.3.
11. `feat(costs): project canonical usage facts` — T2.4, followed by T2.5
    acceptance-only fixes if needed.
12. `feat(supervisor): accept prompt commands asynchronously` — T3.1.
13. `feat(execution-host): persist prompt continuations` — T3.2–T3.3.
14. `feat(db): add execution runtime object catalog` — schema portion of T3.4.
15. `feat(supervisor): add fenced runtime object transport` — host portion of
    T3.4.
16. `feat(artifacts): replace host paths with runtime objects` — T3.5–T3.6.
17. `feat(migration): import legacy runtime data` — T4.1.
18. `refactor(execution-host): remove legacy file and prompt authority` — T4.2.
19. `refactor(scratch): remove supervisor session mirror` — T4.3, including
    destructive generated migration.
20. `docs(stage-b): record as-built durable data plane` — T4.4.

Do not squash schema migration commits into an earlier commit after another
branch has based work on their IDs. If rebase changes numbers, regenerate before
review rather than editing journal/snapshot by hand.

## Definition of done

Stage B is complete only when:

1. Postgres is the manager's canonical event and runtime-metadata authority.
2. Host delivery is durable, replayable, at-least-once, deduplicated, ordered by
   explicit streams/run sequences, gap-aware, ACKed, bounded, and fenced.
3. Prompt completion is recoverable from command/receipt/event state and every
   owner continuation survives web restart.
4. Web has no read/write access to the execution host's runtime-data root;
   artifacts cross only typed opaque contracts.
5. Historical completed runs and scratch session associations are preserved or
   the cutover refuses with actionable evidence.
6. Legacy file/prompt/session-mirror authority and bounded compatibility code
   are removed; there is no silent fallback.
7. The default one-host install works without enrollment, relay, object store,
   extra service, or extra required setting.
8. All focused/full gates pass, docs/contracts/ADR/ERD match as-built behavior,
   and all explicit Stage C/D non-goals remain unimplemented.
9. RED evidence, GREEN behavior, and REFACTOR results are recorded per task;
   strict types, pure transformations, single-purpose functions, existing
   boundary abstractions, fail-fast typed errors, and project conventions are
   preserved without flag-driven multi-mode helpers, duplicate ledgers, or
   speculative frameworks.
