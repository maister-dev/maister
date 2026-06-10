# Artifacts domain ERD

Tables for the typed evidence index and ADR-022 projector cursor introduced by
M12. See [`../system-analytics/artifacts.md`](../system-analytics/artifacts.md)
for behavior and the validity FSM, and
[`../database-schema.md`](../database-schema.md) for the column-level narrative.

> **Status: Implemented (M12).** Migration `0015_m12_artifacts_evidence.sql`
> (additive, forward-only, no down-migration) adds both tables.

```mermaid
erDiagram
    RUNS ||--o{ ARTIFACT_INSTANCES : "evidence index"
    RUNS ||--o| ARTIFACT_PROJECTION_CURSORS : "projector cursor"
    NODE_ATTEMPTS ||--o{ ARTIFACT_INSTANCES : "attempt evidence (nullable)"
    ARTIFACT_INSTANCES ||--o{ ARTIFACT_INSTANCES : "superseded_by (self-ref, SET NULL)"

    ARTIFACT_INSTANCES {
        text id PK "deterministic — see contract below"
        text run_id FK "NOT NULL → runs(id) ON DELETE CASCADE"
        text node_attempt_id FK "NULL → node_attempts(id) ON DELETE CASCADE"
        text node_id "denormalized logical node id (nullable)"
        integer attempt "denormalized attempt number (nullable)"
        text artifact_def_id "manifest output.produces[].id; NULL for defaults/projector"
        text kind "diff|log|test_report|lint_report|ai_judgment|human_note|commit_set|checkpoint|preview|generic_file|mutation_report"
        text producer "runner|projector|takeover|gate|human"
        jsonb locator "discriminated union — server-written only"
        text uri "optional human/direct display ref"
        text hash "content hash (head SHA / file digest) when cheap"
        integer size_bytes "nullable"
        text validity "current|stale|superseded|failed|skipped DEFAULT current"
        jsonb required_for "snapshot from manifest: (review|merge)[] — declared, not enforced until M14"
        text visibility "internal|shared DEFAULT internal — declared, not enforced until M14"
        text retention "run|ephemeral DEFAULT run — declared, not enforced until M14"
        integer monotonic_id "supervisor event id (projector rows); NULL for runner-inline"
        text superseded_by_id FK "NULL → artifact_instances(id) ON DELETE SET NULL"
        timestamptz created_at "DEFAULT now()"
    }

    ARTIFACT_PROJECTION_CURSORS {
        text id PK "= run_id (one cursor per run)"
        text run_id FK "NOT NULL → runs(id) ON DELETE CASCADE"
        text scope "run — one row per run (corrected from per-step)"
        text events_log_path ".maister/slug/runs/runId/run.events.jsonl"
        integer last_monotonic_id "DEFAULT 0; run-global"
        text status "idle|running|caught_up|failed DEFAULT idle"
        timestamptz updated_at "DEFAULT now()"
    }
```

## Deterministic-id contract

Every `artifact_instances` row has a deterministic `id` so that re-execution
and projector replay **upsert** idempotently (`onConflictDoUpdate`).

| Origin | PK format | Example |
| ------ | --------- | ------- |
| Runner-inline declared output | `run:<nodeAttemptId>:<artifactDefId>` | `run:na_abc123:impl-diff` |
| Runner-inline default (kind-scoped) | `run:<nodeAttemptId>:default:<kind>` | `run:na_abc123:default:log` |
| Projector-derived | `proj:<runId>:<monotonicId>` | `proj:run_xyz789:42` |
| Gate mutation report, undeclared output (M29) | `run:<nodeAttemptId>:mutation:<gateId>` | `run:na_abc123:mutation:impl-mutation` |

`monotonicId` is **run-global** in the durable `run.events.jsonl` log (see
ADR-038 Phase-0 re-confirmation correction). A single projector `id` is unique
across the entire run's event stream because `monotonicId` is strictly
increasing across the whole file.

## Locator immutability (git refs)

For runner-recorded and takeover-recorded git artifacts (`git-range` diffs,
`git-log` commit sets), `locator.headRef` holds an **immutable 40-char commit
SHA** — resolved with `git rev-parse` (`resolveRefSha`) at record time — never
a mutable branch name (PR2/F3). The payload route renders against the stored
`headRef`, so advancing the branch after recording never changes an old
artifact's payload. A branch-name fallback is used only when git is unavailable
(synthetic-flow test environments with no real repo).

## Cursor scope (corrected)

**Phase-0 re-confirmation correction (ADR-038):** The plan §11.1 assumed a
per-step cursor (`PK = <runId>::<stepId>`). The real supervisor code writes one
`run.events.jsonl` per run with a run-global `monotonicId`. The cursor is
therefore **one row per run**:

- `artifact_projection_cursors.id = runId` (not `runId::stepId`).
- `scope = "run"` (not a stepId string).
- `last_monotonic_id` is run-global — it advances past every event in the
  single file, regardless of which session or step emitted it.

The `UNIQUE (run_id, scope)` constraint allows future per-scope rows (e.g. a
secondary scope for a different projection) without a schema change.

## Cascade chain

```
runs
  ├── artifact_instances      (FK run_id,          ON DELETE CASCADE)
  │     └── artifact_instances.superseded_by_id    (self-ref, ON DELETE SET NULL)
  └── artifact_projection_cursors  (FK run_id,     ON DELETE CASCADE)

node_attempts
  └── artifact_instances      (FK node_attempt_id, ON DELETE CASCADE)
```

Deleting a run drops all its `artifact_instances` and the projection cursor in
one statement. Deleting a `node_attempts` row cascades to its node-attempt-scoped
`artifact_instances` rows (those that referenced it via `node_attempt_id`). The
self-referential `superseded_by_id` is `ON DELETE SET NULL`: deleting a
superseding row leaves the superseded row as-is, with a null `superseded_by_id`
— a history pointer that never blocks deletion.

## Indexes

| Table | Index | Columns | Purpose |
| ----- | ----- | ------- | ------- |
| `artifact_instances` | `artifact_instances_run_idx` | `(run_id)` | Evidence index for a run. |
| `artifact_instances` | `artifact_instances_node_attempt_idx` | `(node_attempt_id)` | All artifacts for a node attempt. |
| `artifact_instances` | `artifact_instances_run_kind_idx` | `(run_id, kind)` | Filter by kind. |
| `artifact_instances` | `artifact_instances_run_validity_idx` | `(run_id, validity)` | Filter by validity (e.g. all stale artifacts for a run). |
| `artifact_projection_cursors` | implicit UNIQUE | `(run_id, scope)` | One cursor row per (run, scope). |

## Linked artifacts

- Process flows: [`../system-analytics/artifacts.md`](../system-analytics/artifacts.md).
- Global ERD: [`erd.md`](erd.md).
- Narrative: [`../database-schema.md`](../database-schema.md).
- Source (Implemented): `web/lib/db/schema.ts` (new tables, migration `0015`).
