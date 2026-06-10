# Observatory domain

> **Status: Implemented (M23).** Observatory is the Wave-1 read-only metrics surface
> for correction pressure, autonomy, and repeatable harvestable signals. It
> builds on the M11a `node_attempts` ledger, M12 artifact evidence index, M15
> readiness verdict calibration, and HITL timing rows. Locked decision:
> [ADR-059](../decisions.md#adr-059-read-only-observatory-formulas-and-harvest-priority).
> The **harness adequacy & coherence** layer below is **(M29 — Implemented)** —
> sensor firing-rate, never-fired flags, per-control effectiveness, and the
> per-flow coverage map. Locked decision:
> [ADR-073](../decisions.md#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension).

## Purpose

Observatory turns the existing run, node, gate, HITL, and artifact ledgers into
read-only operational metrics. Its boundary is aggregate read models and UI
surfaces for portfolio, project, flow, artifact, and node drill-downs. It does
not mutate Flow definitions, create recommendations, schedule work, inspect raw
payloads, or add persistence. The goal is to prove which correction and
autonomy patterns are repeatable enough to justify a later write-side learning
loop.

Implemented surfaces are `web/lib/queries/observatory.ts`,
`web/lib/queries/observatory-core.ts`,
`web/lib/queries/observatory-signals.ts`, `/observatory`, and
`/projects/[slug]/observatory`. They reuse existing tables only.

## Domain entities

- **Observatory scope** — the visible project set plus optional filters:
  `projectId`, `flowId`, `nodeId`, `artifactKind`, `artifactDefId`, and a
  lookback window. Default lookback is 30 days by `runs.started_at`.
- **Correction metric** — a DTO containing `runCount`, `reworkCount`,
  `retryCount`, `correctionRate`, grouping keys, and display metadata that marks
  the value as an unbounded pressure ratio.
- **Autonomy metric** — a DTO containing `totalSeconds`, `waitSeconds`,
  `openWaitCount`, `autonomyScore`, `volatile`, and
  `reviewDwellExcluded=true`.
- **Signal cluster** — a read-only observation with `kind`, `title`, `scope`,
  `occurrenceCount`, `affectedRunCount`, `affectedProjectCount`,
  `priorityScore`, redacted examples when text is explicitly approved, and
  drill-down parameters.
- **Contributing evidence** — run ids, node attempts, gate results,
  HITL waits, and artifact-instance links that explain an aggregate row without
  exposing server-only handles or raw payloads.
- **Sensor firing stats (M29 — Implemented)** — per `(projectId, flowId, nodeId,
  gateId)` group and per gate `kind` rollup: terminal-status counts
  (`passed/failed/stale/skipped/overridden`), `executions`, and `fail_rate`
  per the ADR-073 formulas.
- **Never-fired flag (M29 — Implemented)** — a per-gate boolean raised when a
  declared, sufficiently-executed gate has zero `failed + stale` results in the
  window; threshold `MAISTER_HARNESS_NEVER_FIRED_MIN` (default 10) is read at
  the query layer and passed into the pure rollup as a parameter.
- **Control effectiveness (M29 — Implemented)** — per-gate rework-follow rates +
  lift, and per-capability (`runs.resolved_capability_set.capabilities[].refId`)
  with/without correction-rate comparison; runs with a null capability set are
  excluded.
- **Coverage map (M29 — Implemented)** — per flow (revisions used by scoped runs,
  joined via `runs.flow_revision_id`): per-node declared gate counts by `mode`,
  blocking count, guide-side presence (skills/rules/restrictions in node
  `settings`), and the "guides without sensors" imbalance flag.

## State machine

Observatory has no persisted state machine. It is a pure classification and
aggregation layer over current rows. Active runs are included in metrics but
MUST carry `volatile=true` because their attempts, waits, and ending timestamp
can still change.

## Process flows

### Aggregate read path

The read model batches by visible project and run ids, then reduces in memory
through pure helpers.

```mermaid
flowchart TD
    U[Authenticated user] --> V[Resolve visible projects]
    V --> F[Apply lookback and filter params]
    F --> R[Bulk read runs]
    R --> N[Bulk read node_attempts]
    R --> G[Bulk read gate_results]
    R --> H[Bulk read hitl_requests]
    R --> A[Bulk read artifact_instances]
    N --> C[rollupCorrectionMetrics]
    H --> AU[rollupAutonomyMetrics]
    G --> S[rankSignalClusters]
    A --> C
    C --> DTO[Observatory DTOs]
    AU --> DTO
    S --> DTO
    DTO --> UI[Portfolio, project, and node drill-down]
```

### Correction rate formula

`correction_rate = (rework_count + retry_count) / run_count`

- `run_count` is the distinct count of `runs.id` in scope where
  `run_kind = 'flow'` and at least one `node_attempts` row exists.
- `rework_count` counts `node_attempts.status = 'Reworked'`. This status is
  written only by the graph runner after a manifest-declared rework transition
  is selected.
- `retry_count` is the sum of `max(node_attempts.attempt) - 1` per
  `(run_id, node_id)`.
- Artifact grouping joins `artifact_instances` through `node_attempt_id` when
  available and otherwise groups by `kind`.
- The result is an unbounded pressure ratio. A value greater than `1` means
  more than one correction event per run.

Worked examples use `now = 2026-06-05T12:00:00.000Z`.

| Example | Rows in scope | Expected |
| ------- | ------------- | -------- |
| No runs | zero eligible flow runs | `runCount=0`, `correctionRate=0`, empty groups |
| Rework plus second human review | one run, node `implement` attempts `1,2`; node `review` attempts `1,2`; first review has `status='Reworked'` | `runCount=1`, `retryCount=2`, `reworkCount=1`, `correctionRate=3` |
| Legacy run without node attempts | one flow run, zero `node_attempts` | excluded from denominator and numerator |
| Artifact with null `artifact_def_id` | artifact linked to a contributing node attempt with `kind='log'` | included in artifact bucket `kind:log` |

### Autonomy Score formula

`autonomy_score = 1 - sum(gate_wait_time) / total_run_time`

```mermaid
flowchart TD
    R[Run interval started_at to ended_at or now] --> W[Collect HITL wait intervals]
    W --> C[Clamp waits to run interval]
    C --> M[Merge overlapping intervals]
    M --> S[Sum merged wait seconds]
    R --> T[Compute total run seconds]
    S --> A[1 - waitSeconds / totalSeconds]
    T --> A
    A --> O[Clamp final score to 0..1]
```

- `gate_wait_time` is built from `hitl_requests.created_at` to
  `coalesce(responded_at, now)`.
- Every wait interval is clamped to the run interval
  `[started_at, coalesce(ended_at, now)]`.
- Overlapping waits are merged before summing.
- `total_run_time` uses `coalesce(runs.ended_at, now) - runs.started_at` and is
  clamped to at least one second.
- Review and promotion dwell without a `hitl_requests` row are excluded in M23.
  The UI MUST label this metric as HITL wait share and carry
  `reviewDwellExcluded=true`.

Worked examples use `now = 2026-06-05T12:00:00.000Z`.

| Example | Rows in scope | Expected |
| ------- | ------------- | -------- |
| Active run with open HITL | run `11:00..now`, one open HITL `11:30..now` | `totalSeconds=3600`, `waitSeconds=1800`, `openWaitCount=1`, `autonomyScore=0.5`, `volatile=true` |
| Overlapping waits | run `10:00..11:00`, waits `10:10..10:30` and `10:20..10:40` | merged wait is `10:10..10:40`, `waitSeconds=1800`, `autonomyScore=0.5` |
| Review dwell without HITL | run `10:00..11:00`, no `hitl_requests`, run sat in `Review` after completion | `waitSeconds=0`, `autonomyScore=1`, `reviewDwellExcluded=true` |
| Zero-duration run | run starts and ends at same timestamp | denominator clamps to one second |

### Signal clustering

Signal clustering ranks repeatable structured observations. It never offers a
mutation action.

```mermaid
flowchart TD
    H[hitl_requests structured columns] --> R[Rework clusters]
    G[gate_results status and verdict JSON] --> GV[Gate verdict clusters]
    N[node_attempts attempts and errors] --> RT[Retry clusters]
    A[artifact_instances kind and definition ids] --> RT
    R --> P[Repeatability priority]
    GV --> P
    RT --> P
    P --> L[Top signals list]
```

- Rework clusters use `hitl_requests.decision`, `rework_target`,
  `workspace_policy`, `step_id`, and joined `runs.flow_id`. Optional
  node-attempt context joins on `(run_id, node_id = step_id)`.
- Gate clusters use `gate_results.kind`, `gate_id`, `status`,
  `verdict.verdict`, `verdict.calibration.outcome`,
  `verdict.recommendedAction`, and normalized `verdict.reasons[]`.
- Retry clusters use `(flow_id, node_id, node_type, error_code, exit_code)`,
  plus artifact kind/definition ids when linked.
- `priorityScore` is derived from occurrence count, affected run count, affected
  project count, and extra weight for failed or stale blocking gates.
- M17 `criticality` and `human_confidence` are optional future multipliers.

### Harness adequacy & coherence rollup (M29 — Implemented)

The harness layer answers "is the harness sensing anything, and do its controls
matter" over the same scoped window. It extends the existing bulk read path
with two run columns (`runs.resolved_capability_set`, `runs.flow_revision_id`)
and exactly ONE new bulk SELECT (`flow_revisions` by the distinct revision ids
of scoped runs, manifests parsed in TS). All formulas are normative in
[ADR-073](../decisions.md#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension)
and are not restated here.

```mermaid
flowchart TD
    R[Bulk read runs incl. resolved_capability_set + flow_revision_id] --> FR[Bulk read flow_revisions for distinct revision ids]
    R --> G[Bulk read gate_results]
    R --> N[Bulk read node_attempts]
    FR --> DM[Parse manifests: declared gates + node settings guides]
    G --> FS[rollupGateFiringStats]
    DM --> NF[detectNeverFired with minExecutions param]
    FS --> NF
    G --> CE[rollupControlEffectiveness: gate failed/passed vs rework-follow]
    N --> CE
    R --> CAP[rollupCapabilityEffectiveness: with vs without refId]
    N --> CAP
    DM --> CM[buildCoverageMap: gates by mode + guides per node]
    FS --> CM
    NF --> DTO[harness DTO: firing, neverFired, effectiveness, coverage]
    CE --> DTO
    CAP --> DTO
    CM --> DTO
    DTO --> UI[Harness section on portfolio + project observatory pages]
```

- The rollups are pure functions over bulk rows; the never-fired threshold
  (`MAISTER_HARNESS_NEVER_FIRED_MIN`, default 10) is read once at the query
  layer (instance-config pattern) and passed in as `minExecutions` (ADR-059
  explicit-parameter style).
- Declared gates come from `flow_revisions.manifest` →
  `nodes[].pre_finish.gates[]`; guide-side presence comes from node `settings`
  (selected skills/rules/restrictions). The declared set per flow is the union
  across the revisions used by scoped runs.
- Display follows the honest-N rule: every rate renders with its denominator,
  and groups with fewer than 3 executions render "—", never `0%`.

- Observatory MUST be read-only: no DB writes, filesystem writes, supervisor
  calls, background jobs, or state-changing routes are part of M23.
- Formula helpers MUST accept an explicit `now` and MUST NOT call `Date.now()`
  internally.
- `correction_rate` MUST use `node_attempts.status = 'Reworked'` for rework
  and `max(attempt) - 1` per `(run_id, node_id)` for retries.
- `correction_rate` MUST be rendered as an unbounded pressure ratio, never as a
  percentage.
- Autonomy wait time MUST clamp HITL intervals to their run interval and merge
  overlaps before summing.
- Active runs MUST be included by default and marked `volatile=true`.
- Review or promotion dwell without `hitl_requests` MUST be excluded and exposed
  as `reviewDwellExcluded=true`.
- Portfolio, project, and node drill-down surfaces MUST use shared rollup
  helpers for formula consistency.
- Read-model queries MUST bulk-fetch by visible project and run ids; per-run
  query loops are forbidden.
- Child bucket `runCount` values MUST reconcile to parent rows by set union, not
  by numeric sum.
- Signal clusters MUST use structured metadata first and MUST NOT read raw
  prompts, raw artifact payloads, cost payloads, env values, or secret-bearing
  fields.
- UI labels MUST say signals or patterns, not recommendations or automatic
  fixes.
- **(M29 — Implemented)** Harness rollups MUST be computed on-the-fly from the
  bulk rows with exactly ONE additional bulk SELECT (`flow_revisions` by
  distinct scoped revision ids) — no caching, no read-model table, no per-run
  query loops, no schema change, no new HTTP route.
- **(M29 — Implemented)** The never-fired flag MUST raise only when the gate is
  declared in ≥1 revision used by scoped runs AND
  `executions >= MAISTER_HARNESS_NEVER_FIRED_MIN` AND `failed + stale == 0`;
  the threshold MUST be passed into the pure rollup as a parameter, never read
  from env inside it.
- **(M29 — Implemented)** Capability effectiveness MUST exclude runs whose
  `runs.resolved_capability_set` is null (never counted as "without"); coverage
  MUST exclude runs whose `runs.flow_revision_id` is null from the declared
  side while keeping their firing stats.
- **(M29 — Implemented)** Every harness rate MUST render with its denominator, and
  any group with `executions < 3` MUST render as "—" (insufficient data), never
  as `0%`.

## Edge cases

- Empty scope returns zero-valued metrics and useful empty states, not an error.
- Legacy flow runs without `node_attempts` rows are excluded from
  `runCount` and surfaced only as legacy-no-ledger query diagnostics.
- Active runs with open HITL waits are volatile and may change between refreshes.
- Overlapping HITL rows on the same run are merged to prevent wait time from
  exceeding total run time.
- Missing artifact definitions fall back to artifact `kind` buckets.
- Text extraction is disabled by default; any later bounded text subset requires
  redaction tests before it can appear in examples.
- A performance need for new indexes is a migration task, not an implicit
  read-model change.
- **(M29 — Implemented)** A gate with zero executions in the window (declared but
  never run — e.g. its node never executed) is NOT never-fired-flagged: the
  flag requires the execution threshold; the coverage map still lists the gate
  as declared.
- **(M29 — Implemented)** Null `runs.resolved_capability_set` (pre-ADR-069
  launches) thins capability-effectiveness denominators; such runs are dropped
  from both sides of the comparison and the honest-N denominator shows it.
- **(M29 — Implemented)** Revision drift — scoped runs spanning multiple revisions
  of the same flow — makes the declared-gate set the UNION across used
  revisions; a gate present in only one revision still appears, with its firing
  stats from the runs that declared it. A manifest that fails to parse skips
  that revision with a WARN and the coverage map omits it.

## Linked artifacts

- ADR: [ADR-059](../decisions.md#adr-059-read-only-observatory-formulas-and-harvest-priority)
- ADR (harness layer, M29):
  [ADR-073](../decisions.md#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension)
- Env knob (M29 — Implemented): `MAISTER_HARNESS_NEVER_FIRED_MIN` —
  [`../configuration.md`](../configuration.md) env table (host env only,
  ADR-023 — never compose files)
- Run state: [`runs.md`](runs.md)
- HITL timing and response semantics: [`hitl.md`](hitl.md)
- Node attempts and rework: [`flow-graph.md`](flow-graph.md)
- Readiness verdict calibration: [`readiness.md`](readiness.md)
- Artifact evidence index: [`artifacts.md`](artifacts.md)
- DB schema reference: [`../database-schema.md`](../database-schema.md)
- Web API: no OpenAPI change in M23 because Observatory uses server-component
  read models, not external HTTP API routes.
