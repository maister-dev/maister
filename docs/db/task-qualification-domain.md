# Task qualification persistence

**Implemented — additive main-lineage migrations 0204–0209; no Brain migration.**

The owning domain defines lifecycle and authority. SQL, Drizzle schema, journal and snapshot must agree; generated consolidated ERD changes only after the corresponding DDL phase.

## Entities and cardinalities

Nullable navigation retains safe immutable identity after history expiry.

```mermaid
erDiagram
  projects ||--o{ tasks : scopes
  tasks ||--o{ task_qualifications : assesses
  task_qualifications ||--o| tasks : current_pointer
  runs o|--o{ task_qualifications : author_navigation
```

## Columns and invariants

| Object              | Contract                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| projects            | Versioned taskQualificationPolicy: immutable creation baseline legacy/required and nullable override; old projects legacy, new required. Changes use existing reviewed project config semantics, never agent writes.                |
| tasks               | Server-owned required/admission mode, qualification_input_revision, qualification_revision_counter, current_qualification_id/revision (accepted only); inherited execution-child proof only from admitted bound-parent transaction. |
| task_qualifications | Immutable assessment ID/task/project/input revision/digest/author identity/run/evidence SHA/checks/decision/next actions, publication receipt candidate/accepted/rejected with typed reason; bounded JSON and content.              |
| uniqueness          | Unique task/input revision/request key; payload conflict rejected; one candidate per task/run/input revision. Task current pointer targets same project/task; input and pointer CAS both required.                                  |
| runs                | Immutable task_admission_snapshot records exact policy/input/assessment/evidence/parent proof. Existing running work keeps its original admission.                                                                                  |
| evidence            | Active pointers cannot be pruned; run/actor navigation may become unavailable without losing immutable provenance or granting acceptance.                                                                                           |
| invalidation        | Every semantic writer increments input revision and clears current acceptance/old enqueue in its transaction. Priority/pause and ordinary discussion do not silently change requirements.                                           |

## Qualifier source input binding

The immutable version-1 `runs.task_qualification_snapshot` retains `role`,
`taskId`, `target` and `sha`. New qualifier launches additionally freeze
`inputRevision` (positive integer) and `inputDigest` (64 lowercase hex characters)
from the authoritative semantic qualification input. Both fields are optional
for reading old snapshots; a new qualifier producer writes both together.
The existing JSONB column and snapshot CHECK permit these additive keys, and
the existing immutability trigger protects them. No column, CHECK, generated
schema snapshot or ERD changes, migration or historical backfill are needed.
Readers must not infer a current input binding when either field is absent.
The [failed-source projection contract](../system-analytics/task-qualification.md#failed-qualifier-source-without-an-assessment)
defines current-input comparison and safe legacy presentation.

## Transactions and indexes

Index all hot project/agent/task/due/status and keyset paths; bounded scans use dueAt/id or timestamp/id. All current pointers, receipt uniqueness, payload comparison, state CHECKs and same-project relationships are database/service invariants with direct-write negative tests. Source run precedes task and agent-advisory/episode locks; task-only human writes do not lock a run later. No Git/host/network effect inside PostgreSQL transactions.

## Migration and recovery

Supported fresh/master0198/current0203 upgrades append new SQL. Old pre-rebase operational0194–0198 ledgers are unsupported and must refuse before mutation. Stop old writers, set maintenance, apply additive schema, resume bounded backfill, verify counts/schema, start compatible readers/writers, then reopen admission. Never forge historical success or launch time. Rollback retains additive evidence and fences incompatible admissions; no destructive down migration. Unknown/deleted ownership preserves diagnosis. A pre-run retry allocation is owned by its intent until atomic transfer to the created run.

## Linked artifacts

- [Owning contract](../system-analytics/task-qualification.md)
- [Traceability](../system-analytics/agent-activity-traceability.md)
- [Current generated ERD](erd.dbml)
- [Database reference](../database-schema.md)

`evidence_sha` is nullable only for held assessments; ready requires a verified
SHA. New projects receive their required baseline from the sole registration
owner; the additive SQL legacy default preserves upgraded rows and trusted legacy
fixtures. Task creation derives required mode from the locked project's effective
policy. The database invalidates semantic inputs across all task-row writers,
blocking clarification mutations and default-target updates, with transactional
content-free outbox facts. Source-run → task remains the write lock order.

0209 declares the task-qualification writer capability on production and owned test
connections. Undeclared old writers cannot mutate governed task or admission rows.
It also persists the agent declaration and write-once first-dispatch check receipt.
Default legacy DB values preserve upgraded data; registration assigns new-project
required policy. Independent request admission and execution-child proof are checked
by their existing service owners and database constraints, never inferred from text.

### Human authoring payload identity (Implemented — LA11)

The optional human adapter reuses the immutable `payload_digest` with a separate
canonical hash domain (`kind=human_authoring`, version, project/task/author and
original human request). Machine endpoint hashing and historical values remain
unchanged. Exact authoring replay checks this digest before resolving live
references, under the existing task/key serialization and current access checks;
a different adapter payload, author or human payload cannot reuse that receipt.
No additive column or migration is necessary for this adapter.

### Flag provenance (Implemented — additive 0223)

`tasks.triage_flag_origin` is nullable text in the closed set `qualification`,
`explicit`, `dispatch_failure`, `unknown`. `tasks_triage_flag_origin_check`
requires a non-null origin exactly while `triage_status='flagged'`; otherwise
origin is null. No default fabricates provenance for new flags. Populated
upgrade backfills only existing flagged rows to `unknown`; task and assessment
history are retained. Existing explicit/dispatch hold writers increment the
existing task revision on each assertion. Human resolution compares that
revision and origin in the same transaction that clears both columns and the
auto arm. No new table, history rewrite, automatic authority or down migration.

`task_launch_intents_01_manual_hold` locks only the existing task row after
shared reservation fencing. It refuses uncommitted manual admission/reactivation
in either reservation lane while an independent hold remains, including first
dispatch commitment. Held/cancelled/failed/settled history and already committed
same-run continuation retain their receipts. No new advisory or intent locks.
