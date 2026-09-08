# Copy-paste prompt: prerequisite Stage A/B stabilization

Paste the block below into a new planning request. It requests a plan, not implementation. Execute and verify this prerequisite before starting Stage C production changes.

```text
$aif-plan full

Create an implementation-ready, SDD-driven plan for:
Stage A/B stabilization before host-owned Workspace/Git and multi-host execution.

Testing = yes
Logging = verbose
Documentation = yes

Baseline and evidence

Inspect the actual current checkout and main before planning. Audit baseline:
HEAD 33f9d34f4, main 5b458457a94b689713491d158e751553d676be6a.
Revalidate any finding affected by later commits; do not copy proposed fixes without checking control flow.

Read:
- .ai-factory/reviews/stage-ab-execution-host-audit-2026-09-05.md
- .ai-factory/plans/claude-stage-a-execution-host-plan-6d70f9.md
- .ai-factory/plans/feature-stage-b-durable-execution-host-data-plane.md
- ADR-023, ADR-166, ADR-167.
- Root/web/docs CLAUDE.md, AGENTS.md, architecture and applicable rules.
- Current implementation, tests, OpenAPI, AsyncAPI, Drizzle schema, SQL migrations,
  journal/snapshots, deployment configuration and execution-* system analytics.

This is a correctness/completion prerequisite within accepted A/B scope.
Do not implement Workspace/Git ownership, multiple-host placement, remote enrollment,
public authentication, a relay, cross-host ACP resume or object storage in this plan.
Do not restore filesystem event authority, the scratch session mirror, or an indefinite
legacy fallback. Preserve the default supported single-host installation.

Required finding disposition

Account for R01–R17 in the audit. For each, show current reproduction/evidence,
accepted requirement, root cause, proposed minimal correction, owner, dependencies,
primary discriminating test and acceptance criterion. If the checkout disproves a finding,
record concrete counterevidence and remove only that item.

Cover:
R01 oversized ACP output escaping the synchronous event publisher;
R02 retained-versus-unACKed outbox accounting and safe active-producer backpressure;
R03 autonomous fair projector catch-up/retry, multi-batch restart and multi-run gap wakeups;
R04 first-batch rollback losing the consumer failure record;
R05 persisted typed prompt owners, logical request identity and terminal owner continuation;
R06 generic receipt recovery bypassing canonical terminal authority and flattening errors;
R07 unknown admission after transport retry exhaustion being falsely terminalized;
R08 delayed old-epoch session.create ACK/recovery overwriting current session binding;
R09 impossible pending runtime-object predicate on event-before-ACK;
R10 state-aware command/receipt retention, including accepted and unapplied operations;
R11 resumable preservation of ordinary Stage A historical runtime bytes and locators;
R12 same-origin active-content delivery via runtime-object content routes;
R13 post-seal integrity/file identity and missing/corrupt catalog transitions;
R14 fair runtime-object GC beyond protected first batches;
R15 correct full-representation versus partial-message digest semantics;
R16 operation-scoped filesystem inventory and real isolation/restart coverage.
R17 native fetch/Undici binary upload compatibility on supported Node versions.

Design requirements

1. Keep the existing ExecutionHosts boundary and Stage A command/receipt ledger.
   Define one terminal reconciliation reducer. Separate transport failure,
   unknown outcome, terminal command evidence and domain owner application.
   Persist the exact immutable request and agreeing result/error identity.
   Model each actual prompt owner and status/recovery window; preserve node_attempts
   as the sole Flow execution ledger. Do not create a second workflow engine.

2. Define the durable bounded projection worker: selection, cursor initialization,
   retries/backoff, fairness, poison, concurrent claims, shutdown and restart.
   Ingest ACK must depend on canonical commit, not successful projection.
   A completed transport stream must not be needed to wake a due projection.

3. Define output-size policy and outbox accounting with one normative budget table.
   Preserve required bytes as host-owned objects; define producer pause/resume,
   terminal reserve, cancellations and overflow errors without silent loss.
   Implement the chosen settings symmetrically through runtime config/validation,
   Dockerfile, compose.yml, compose.production.yml, .env.example and operator docs.
   Do not change numbers just to match tests without a stated resource rationale.

4. Define runtime-object intent, upload/seal, available evidence and deletion as
   one reconciled lifecycle across HTTP ACK and canonical events. Choose safe
   download/preview headers, content integrity validation and fair deletion.
   Keep required verifier evidence distinct from structured result transport.
   Preserve retention until the product's confirmed delivery/merge policy allows
   deletion; Done alone is not sufficient where delivery remains unconfirmed.

5. Supply an executable bounded historical migration:
   inventory -> deterministic source mapping -> copy bytes through an authorized
   host import path -> verify hashes/metadata -> replace locators/associations ->
   durable per-lane proof -> guarded destructive cutover.
   Include complete baseline histories, partial failure/resume, duplicates,
   changed/missing sources, active-run drain and backup/restore.
   Do not silently discard associations, skip ordinary log files, delete sources
   to manufacture success, or weaken 0135 preflight.
   Generate new forward migrations where committed schema needs correction;
   reconcile actual journal/snapshot/ADR numbering with current main.

6. For every remote-effect plus DB transition define a failure table:
   intent commit, dispatch, host receipt/effect, ACK loss, canonical event,
   DB application, stale epoch, retry owner, idempotency key, reconciliation,
   compensation and poison handling. Include delayed success after supersession.

7. Classify identifiers per route/message as URL-selected, principal-derived,
   server-derived or body-supplied. Derive cross-resource identity from authoritative
   rows. Do not log raw paths, tokens, full prompts or object payloads.
   Extend typed actionable errors and bounded structured logs/metrics.

SDD/TDD and delivery

Write normative requirements, contracts, state machines, refusal tables, recovery
windows and acceptance criteria before implementation tasks. Trace each requirement
to its enforcing constraint/reducer and one primary test. Use real Postgres and
real supervisor integration tests where practical. Add pure unit tests only for
stable transformations/protocol invariants; avoid overlapping mock-only coverage.

The implementation phase must use RED -> GREEN -> REFACTOR:
- introduce a failing test that distinguishes the defect from the valid behavior;
- implement the minimal correction;
- refactor within scope while all affected tests stay green;
- run increment-level integration and specification gates;
- commit by independently deployable phases.

At minimum evaluate these increments:
S0 requirements/contracts/acceptance reconciliation and test topology;
S1 host output and durable projector reliability;
S2 one prompt reducer, durable owners, unknown outcome, fencing and retention;
S3 runtime-object reconciliation/security/integrity/retention;
S4 full historical import and guarded upgrade;
S5 isolated lifecycle qualification and final spec/analytics consistency.

Allow bounded independent work but state ownership and dependencies for every task.
Each increment leaves one-host operation working. Define acceptance and rollback/
roll-forward strategy for each phase. Include a coherent commit sequence and risk register.

The final acceptance matrix must cover real web/supervisor restarts, no-new-event
catch-up, ACK loss/partitions beyond retry budgets, stale assignment callbacks,
prompt owner application for each origin, >1-page GC, unsafe artifact MIME,
content corruption, complete Stage A history and denied web runtime-root access.
Include the diagnosed V7b Node 24.15/Undici 8 invalid-content-length failure
in the runtime/transport acceptance matrix; the Node 24.19 passing result does
not establish compatibility with the currently advertised full Node 24 range.

Update OpenAPI, AsyncAPI, error taxonomy, database schema/ERD, architecture,
supervisor/deployment/configuration documentation and affected system analytics
in the same increments. Correct false Implemented/test-traceability claims from
verified behavior. Add an ADR only if a decision changes; choose its next available
number at implementation time, not from this prompt.

Output the plan only. Do not modify production code or execute the implementation.
Do not claim completion based on existing checked plan boxes or parser success.
```
