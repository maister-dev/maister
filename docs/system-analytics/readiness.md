# Readiness domain (M15)

> **Status: Implemented (M15), as of 2026-06-03.** All-kind readiness enforcement at
> the Review chokepoint, verdict calibration at gate execution, the shared
> `readiness-core.ts` classifier, the `overridden` summary state, and the unified
> readiness summary on run-detail / board / portfolio are shipped, on top of the M11a
> gate-execution lifecycle, the M12 artifact-validity rules, and the M16 `external_check`
> loop. The merge-refuse-for-flow-runs acceptance clause is **deferred to M18** (the
> scratch-promote merge guard is the wired, vacuously-ready call site only). Locked decisions:
> [ADR-048](../decisions.md#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15),
> bounded by [ADR-028](../decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)
> and [ADR-045](../decisions.md#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve).

## Purpose

Readiness is the contract that decides **when a run may promote** and how an
`ai_judgment`/`skill_check` confidence becomes a deterministic gate outcome. M11a
*executes* gates and records `gate_results`; M15 *consumes* those results to refuse or
allow Review (and, for flow runs, merge — owned by M18). A run is ready for a phase when
every Flow-declared **blocking** gate on its live node attempt is current and either
`passed` or explicitly `overridden`, and every artifact `requiredFor` that phase is
present and not stale. Verdict calibration sets a gate's `status` **at execution time** so
the readiness layer reads only `status` and stays confidence-agnostic.

Domain boundary: the readiness classifier (`readiness-core.ts`), the Review chokepoint
enforcer (`assertEvidenceReady`), the read-model (`getRunReadiness`), the board/portfolio
readiness surfaces, and the per-gate / flow-level calibration policy. Out of scope: gate
*execution* and the status lifecycle (M11a — see [`flow-graph.md`](flow-graph.md)); artifact
validity transitions (M12 — see [`artifacts.md`](artifacts.md)); the `external_check`
report ingestion loop (M16 — see [`external-operations.md`](external-operations.md));
flow-run promotion and real merge enforcement (M18); a complex `readiness_policy` DSL,
org-wide gate templates, and a judge-calibration lab (all deferred — ROADMAP M15).

## Domain entities

- **Blocking gate** — a `gate_results` row with `mode: "blocking"` on the live
  `node_attempts` attempt. The `mode: "blocking"` signal doubles as "promotion-required"
  (no separate `readiness_policy` grammar — [ADR-048](../decisions.md#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15)).
  (Implemented — M11a)
- **Gate calibration config** — per-gate `calibration.confidence_min` (0..1) and
  `allow_missing_confidence` (default `false`) in `gateSchema`, plus a flow-level
  `verdict_calibration.confidence_min` default in `flowYamlV1Schema`, folded into each
  gate's effective `calibration` at compile time. (Implemented — M15)
- **`GateVerdict.calibration`** — the observability sub-object persisted in the existing
  `gate_results.verdict` JSONB: `{ confidenceMin, rawVerdict, outcome }`. No migration.
  (Implemented — M15)
- **`readiness-core.ts`** — the single pure classifier: live-attempt collection +
  external-gate collapse + the per-kind allow-list + the priority classifier. The one
  source of truth shared by the enforcer, read-model, board, and portfolio. (Implemented — M15)
- **`assertEvidenceReady(runId, phase)`** — the enforcer. Returns
  `{ ready: boolean; reasons: string[] }` (it does **not** throw); the runner converts a
  not-ready verdict into a `PRECONDITION` failure at the Review transition. (Implemented —
  M16; broadened to all kinds in M15)
- **`getRunReadiness` → `ReadinessDTO`** — the read-model returning the unified summary
  and its evidence. (Implemented — M16; gains `overridden` + the shared core in M15)
- **Readiness summary** — exactly one of `ready | blocked | stale | failed | waiting |
  overridden`. (Implemented — M15; `overridden` is new)

## State machine

Readiness is a **pure classification** of the current gate/artifact state, not a separate
persisted state machine — there are no readiness-to-readiness transitions to record. The
underlying `gate_results.status` lifecycle (`pending → running → passed|failed|stale|
skipped|overridden`) is owned by M11a; see [`flow-graph.md`](flow-graph.md). The
run-level classification is given under **Process flows → Readiness classifier**.

Per-status contribution of a single **blocking** gate on the live attempt:

| `gate_results.status` | Clears the phase? | Summary contribution |
| --------------------- | ----------------- | -------------------- |
| `passed`              | yes               | (none — ready)       |
| `overridden`          | yes               | `overridden`         |
| `failed`              | no                | `failed`             |
| `stale`               | no                | `stale`              |
| `skipped`             | no                | `blocked`            |
| `pending`             | no                | `waiting`            |
| `running`             | no                | `waiting`            |

`artifact_required` `failed` is re-evaluated against current inputs (it blocks only when an
`inputArtifactRefs` def is still non-current or `refs.length === 0`) — preserved from M12.
**(M29 — Designed)** That re-evaluation gains an assertion-awareness exception: a `failed`
`artifact_required` gate whose `gate_results.verdict` carries `payload.assertionFailed: true`
(a `must_touch`/`must_not_touch` mutation failure,
[ADR-073](../decisions.md#adr-073-artifact-post-conditions--deterministic-mutation-sensor-on-artifact_required-gates))
contributes `failed` even when every input artifact is current — inputs-present is no longer
sufficient to clear it; only a rework attempt that re-runs the gate and passes clears it.
A required artifact (`requiredFor` non-empty) contributes `blocked` when it has no
`validity="current"` instance (missing or stale-only). The `stale` readiness state comes from a
blocking **gate** with `gate_results.status === "stale"` (gate staleness), not from
artifact-instance validity (`getCurrentArtifact` returns only current-validity rows).

## Process flows

### Verdict calibration at gate execution (`ai_judgment` + `skill_check`)

Calibration runs inside the shared executor case and decides the persisted `status`. The
flow-level default has already been folded into `gate.calibration` at compile time.

```mermaid
flowchart TD
    A[gate output] --> B[parseVerdict]
    B -->|null| F1[markGateFailed: unparseable]
    B -->|verdict parsed| C{isPassVerdict?}
    C -->|no| F2[markGateFailed: verdict]
    C -->|yes| D{calibration.confidence_min set?}
    D -->|no| P1[markGatePassed: legacy pass]
    D -->|yes| E{confidence present?}
    E -->|no| G{allow_missing_confidence?}
    G -->|no| F3[markGateFailed: no_confidence]
    G -->|yes| P2[markGatePassed: missing_confidence_allowed]
    E -->|yes| V{confidence in range 0 to 1?}
    V -->|no| F5[markGateFailed: invalid_confidence]
    V -->|yes| H{confidence greater-or-equal confidence_min?}
    H -->|yes| P3[markGatePassed: above_threshold]
    H -->|no| F4[markGateFailed: below_threshold]
```

Calibration truth table (the frozen `verdict.calibration.outcome` strings the executor MUST
emit):

| `isPassVerdict` | threshold set | confidence | `confidence ≥ min` | `allow_missing_confidence` | resulting `status` | `outcome` |
| --------------- | ------------- | ---------- | ------------------ | -------------------------- | ------------------ | --------- |
| no              | —             | —          | —                  | —                          | `failed`           | (M11a verdict-fail path; no `calibration`) |
| yes             | no            | —          | —                  | —                          | `passed`           | (legacy pass; no `calibration`) |
| yes             | yes           | present    | yes                | —                          | `passed`           | `above_threshold` |
| yes             | yes           | present    | no                 | —                          | `failed`           | `below_threshold` |
| yes             | yes           | out of `0..1` (non-finite, `<0`, or `>1`) | — | —              | `failed`           | `invalid_confidence` |
| yes             | yes           | absent     | —                  | `false` (default)          | `failed`           | `no_confidence` |
| yes             | yes           | absent     | —                  | `true`                     | `passed`           | `missing_confidence_allowed` |

When a `calibration` object is recorded it carries `{ confidenceMin, rawVerdict, outcome }`;
`rawVerdict` is the parsed `verdict` string before calibration.

### Readiness classifier (run-level, shared core)

The single classifier consumed by the enforcer, read-model, board, and portfolio. It runs
over the live node attempt's blocking gates (external gates collapsed to latest-per-gate)
and the required artifacts.

**Artifact phase-scope differs by caller — and the difference is intentional (the filter is
caller-side, not in the shared core).** The enforcer `assertEvidenceReady(runId, phase)`
counts only artifacts `requiredFor` **that phase** (`requiredFor` contains `phase`); the
read-models (`getRunReadiness`, board, portfolio, project) count every artifact
`requiredFor` **any phase** (`requiredFor` non-empty) — a deliberate fail-closed superset so
a badge surfaces a later-phase blocker (e.g. a `requiredFor: ["merge"]` artifact still
missing at Review) early. Consequence: a badge MAY read `blocked` while the current-phase
enforcer would pass; it NEVER reads `ready`/`overridden` while that enforcer blocks (the
read-model set is a superset of every phase's required set). The blocking-**gate**
contribution, by contrast, is fully shared through `readiness-core.ts` and is identical on
every surface.

```mermaid
flowchart TD
    S[Collect blocking gates and required artifacts on live attempt] --> A{any blocking gate failed?}
    A -->|yes| RF[failed]
    A -->|no| B{any blocking gate stale?}
    B -->|yes| RS[stale]
    B -->|no| C{any required artifact missing OR any blocking gate skipped?}
    C -->|yes| RB[blocked]
    C -->|no| D{any blocking gate pending or running?}
    D -->|yes| RW[waiting]
    D -->|no| E{any blocking gate overridden?}
    E -->|yes| RO[overridden]
    E -->|no| RR[ready]
```

Priority is strict: `failed > stale > blocked > waiting > overridden > ready`. `overridden`
sits just above `ready` because an overridden blocking gate **clears** enforcement (the run
may promote) but the summary still flags that promotion rests on a manual override.

### Review chokepoint enforcement

```mermaid
sequenceDiagram
    participant R as runGraph
    participant Ev as assertEvidenceReady
    participant C as readiness-core
    participant DB as Postgres
    R->>Ev: assertEvidenceReady runId review
    Ev->>C: classify live blocking gates and required artifacts
    C->>DB: read gate_results and artifact_instances on live attempt
    C-->>Ev: ready boolean plus reasons
    alt not ready
        Ev-->>R: not ready with reasons
        R->>DB: markNodeFailed PRECONDITION and set run Failed
    else ready
        Ev-->>R: ready
        R->>DB: set run Review
    end
```

The pre-M15 `artifactEnforcementActive` (engine `1.2.0`) guard around this call is removed:
enforcement now applies to **all** graph flows. The merge phase reuses the same
`assertEvidenceReady(runId, "merge")`; in M15 it is wired only into the scratch promote
route as a reusable call site (vacuously ready — scratch runs carry no flow gates), with
genuine flow-run merge enforcement deferred to M18.

## Expectations

- A blocking gate (`mode: "blocking"`) on the live `node_attempts` row MUST clear a phase
  only when its `gate_results.status` is `passed` or `overridden`; every other status blocks.
- `assertEvidenceReady(runId, phase)` MUST evaluate all executed blocking gate kinds
  (`command_check`, `ai_judgment`, `skill_check`, `artifact_required`, `external_check`),
  not only `artifact_required` + `external_check`. (Implemented — M15)
- Review MUST refuse (node/run → `Failed` via `MaisterError("PRECONDITION")`) when any
  required blocking gate is missing, `pending`, `running`, `failed`, `stale`, or `skipped`.
- The enforcer, `getRunReadiness`, the board query, and the portfolio query MUST classify
  through the single `readiness-core.ts`; no surface re-derives the verdict inline.
  (Implemented — M15)
- The readiness summary MUST be exactly one of `ready | blocked | stale | failed | waiting |
  overridden`, resolved by priority `failed > stale > blocked > waiting > overridden > ready`.
- Verdict calibration MUST be applied at gate execution and set `gate_results.status`; the
  readiness layer MUST read only `status` and never re-read `confidence`. (Implemented — M15)
- A passing `ai_judgment`/`skill_check` verdict whose `confidence` is below the effective
  `calibration.confidence_min` MUST become `failed` (`outcome: "below_threshold"`); a
  `confidence` outside the `0..1` domain (non-finite, `<0`, or `>1`) MUST become `failed`
  (`outcome: "invalid_confidence"`) and MUST NOT be rescued by `allow_missing_confidence`.
  (Implemented — M15)
- A passing verdict with no `confidence` while a threshold is configured MUST become
  `failed` (`outcome: "no_confidence"`) unless the gate sets `allow_missing_confidence: true`
  (then `passed`, `outcome: "missing_confidence_allowed"`). (Implemented — M15)
- A flow-level `verdict_calibration.confidence_min` MUST be folded into each gate's effective
  `calibration` at compile time; `gates-exec.ts` MUST read only `gate.calibration`.
  (Implemented — M15)
- A `blocking` `human_review` gate MUST be rejected at manifest validation with
  `MaisterError("CONFIG")`; advisory `human_review` is permitted. (Implemented — M15)
- Board and portfolio readiness MUST be computed over bulk-fetched rows; neither MUST call
  `getRunReadiness` per run (no N+1). (Implemented — M15)
- M15 MUST NOT add a DB migration, a new `MaisterError` code, a new `runs.status` value, or
  bump `MAISTER_ENGINE_VERSION` (stays `1.2.0`).
- **(M29 — Designed)** A `failed` blocking `artifact_required` gate whose verdict carries
  `payload.assertionFailed: true` MUST contribute `failed` on every readiness surface
  regardless of input-artifact presence; legacy `failed` `artifact_required` gates without
  assertion verdicts keep the inputs-present → clear re-evaluation unchanged.

## Edge cases

- **`failed` `artifact_required` gate re-evaluates to ready uniformly** — a `failed`
  blocking `artifact_required` gate whose `inputArtifactRefs` are all current again (a
  `validity="current"` row exists for each) contributes `clear` through the shared
  `blockingGateContribution`, so it reads ready/clear on the enforcer (`assertEvidenceReady`),
  the readiness DTO (`getRunReadiness`), and the board, portfolio, and project read-models
  alike — even though `gate_results.status` is still `failed`. The recorded `failed` is never
  erased; the live artifact state overrides it on every surface, so no read-model diverges
  from the merge guard. It blocks (`failed`) only while some ref is still non-current or
  `inputArtifactRefs` is empty. **(M29 — Designed)** Exception: when the failed gate's
  verdict carries `payload.assertionFailed: true` (mutation assertion failure, ADR-073),
  the re-evaluation does NOT apply — the gate stays `failed` until a rework attempt
  re-runs it and passes.
- **Blocking `human_review` in a manifest** — rejected pre-run at `validateGraphManifest`
  with `MaisterError("CONFIG")`; it would otherwise deadlock promotion (executor always
  records `human_review` as `skipped`).
- **Review refusal** — `assertEvidenceReady` returns `ready:false`; the runner records
  `MaisterError("PRECONDITION")` and the run goes `Failed`, with `reasons[]` surfaced.
- **Threshold set, agent emits no confidence** — fail-closed `no_confidence` gate failure
  (not an error code); set `allow_missing_confidence: true` for gates that legitimately omit
  confidence.
- **Unparseable verdict** — existing M11a `markGateFailed` "unparseable" path; calibration
  is not reached.
- **`external_check` still `pending` at Review** — contributes `waiting`; enforcement
  refuses Review until the M16 report loop flips it `passed`/`failed`.
- **Overridden blocking gate** — clears enforcement (run may promote) but the summary shows
  `overridden`; the original `verdict` is never erased (override-without-erasure, M11a).
- **Scratch run merge guard** — `assertEvidenceReady(runId, "merge")` is vacuously ready
  (no flow gates); this is future-proofing, not the AC's merge-refuse coverage (M18).

## Linked artifacts

- **ADR:** [ADR-048](../decisions.md#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15)
  (readiness + calibration), [ADR-028](../decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)
  (gate execution scope), [ADR-045](../decisions.md#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve)
  (external_check / merge carve),
  [ADR-073 (assertion-aware re-eval, M29 — Designed)](../decisions.md#adr-073-artifact-post-conditions--deterministic-mutation-sensor-on-artifact_required-gates).
- **Config:** calibration fields documented in [`../configuration.md`](../configuration.md)
  (`gateSchema.calibration`, `flowYamlV1Schema.verdict_calibration`).
- **Source (enforcer + core):** `web/lib/flows/graph/evidence-readiness.ts`,
  `web/lib/flows/graph/readiness-core.ts`, `web/lib/flows/graph/external-gate-readiness.ts`,
  `web/lib/flows/graph/runner-graph.ts`.
- **Source (calibration):** `web/lib/flows/graph/gates-exec.ts`,
  `web/lib/flows/graph/compile.ts`, `web/lib/config.schema.ts`, `web/lib/config.ts`,
  `web/lib/db/schema.ts` (`GateVerdict`, `gate_results`).
- **Source (read-model + surfaces):** `web/lib/queries/readiness.ts`,
  `web/lib/queries/readiness-batch.ts`, `web/lib/queries/board.ts`,
  `web/components/board/flight-card.tsx`, `web/lib/queries/portfolio.ts`,
  `web/lib/queries/project.ts`, `web/components/portfolio/project-card.tsx`,
  `web/app/api/runs/[runId]/promote/route.ts`.
- **Related domains:** [`flow-graph.md`](flow-graph.md) (gate lifecycle),
  [`artifacts.md`](artifacts.md) (artifact validity),
  [`external-operations.md`](external-operations.md) (`external_check` report loop).
- **Roadmap:** ROADMAP M15.
