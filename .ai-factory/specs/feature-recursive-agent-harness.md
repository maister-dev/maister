# Spec — Governed Recursive Agent Harness (RAH)

**ADR:** [ADR-165](../../docs/decisions/adr-165.md) · **Migration:** `0129_run_results` ·
**Engine:** `3.6.0 → 3.7.0` (`RAH_ENGINE_MIN = "3.7.0"`)
**Domain doc:** [`docs/system-analytics/run-results.md`](../../docs/system-analytics/run-results.md)
**Status:** normative. Implementation may not diverge; a genuine divergence is a
spec bug fixed in BOTH places in the same commit.

Every clause is mirrored by exactly one acceptance criterion in the plan
(`.ai-factory/plans/claude-aif-plan-recursive-agent-harness-7ad028.md`).

---

## C-1 — Envelope

- **C-1.1** The public result wire shape is `{ schemaRef, value }` and nothing
  else. *(AC-10)*
- **C-1.2** The producer supplies ONLY `value`. Run identity, schema identity
  (`schema_ref`, `schema_sha256`, `schema_version`), producer identity
  (`producer_kind`, `producer_ref`), attempt/revision identity
  (`node_attempt_id`, `revision`), validity + supersession, `artifact_manifest`
  and `created_at` are engine-owned. *(AC-08, AC-13)*
- **C-1.3** `schemaRef = "<flowRefId>@<resolvedRevision[:12]>:<schemaStem>"`.
  *(AC-10)*
- **C-1.4** Completion time is `runs.ended_at`, joined — never duplicated onto a
  result row. *(AC-08)*

## C-2 — Persistence

- **C-2.1** `run_results` holds one row per result REVISION, including `invalid`
  rows. `UNIQUE(run_id, revision)`. *(AC-08)*
- **C-2.2** `CHECK ((validity='invalid') = (value IS NULL))` and
  `CHECK ((validity='invalid') = (invalid_reason IS NOT NULL))`. *(AC-08)*
- **C-2.3** Partial unique index `(run_id) WHERE validity='valid'` — at most one
  current result per run, enforced by the database. *(AC-08)*
- **C-2.4** `runs.result_contract`, `runs.delegation_bounds` and
  `flow_revisions.result_profiles` are nullable jsonb, additive, no backfill;
  NULL means "no contract / env-only / no profiles". *(AC-07, AC-09)*
- **C-2.5** `artifact_manifest` is the engine artifact manifest AT PUBLISH
  (audit). `run_collect.artifacts` is the LIVE manifest. *(AC-13, AC-31)*

## C-3 — Validity FSM and `resultStatus`

- **C-3.1** `validity ∈ {valid, stale, superseded, invalid}`; `invalid` and
  `superseded` are terminal. *(AC-08)*
- **C-3.2** A publish supersedes every prior `valid | stale` row for the run in
  the SAME transaction, setting `superseded_by_id` and `superseded_at`. *(AC-08)*
- **C-3.3** `markDownstreamStale` flips the run's `valid` row to `stale` when its
  producer node is among the staled nodes. *(AC-14)*
- **C-3.4** ONE predicate `deriveResultStatus({runStatus, contract, newestRow,
  validRow})` produces all 7 values on every surface (collect route, run DTO,
  Evaluation Lab). *(AC-09)*
- **C-3.5** `markRunResultCollected` is write-once
  (`WHERE first_collected_at IS NULL`). *(AC-08, AC-32)*

## C-4 — Flow result (`result.export`)

- **C-4.1** Grammar: top-level `result.export { schema, from[], required?=true }`,
  `.strict()`. *(AC-03)*
- **C-4.2** Load rules (`CONFIG`, naming the node and the reason): every `from[]`
  node exists, is not `human`/`form`, declares `output.result`, and declares the
  SAME normalized `schema` path. *(AC-03)*
- **C-4.3** A producer's `output.result.required` is FORCED `true` when the
  export is required, and the loaded manifest reflects it. *(AC-03)*
- **C-4.4** Engine floor 3.7.0 on the MANIFEST. *(AC-04)*
- **C-4.5** The launcher resolves the schema from the PINNED revision's
  `installed_path`, pre-worktree, and writes `runs.result_contract` in the
  run-insert transaction. An unresolvable schema refuses `CONFIG` with zero
  `runs` / `workspaces` rows. *(AC-11)*
- **C-4.6** Re-pointing `flows.enabled_revision_id` after launch changes neither
  the snapshot nor which schema the seam validates against. *(AC-12)*
- **C-4.7** Latest valid publish wins. *(AC-14)*

## C-5 — Agent result (`result_profiles` + `resultProfile`)

- **C-5.1** Grammar: package-level `result_profiles: Record<name, {schema}>`,
  `.strict()`, name `/^[A-Za-z0-9._-]{1,64}$/`, schema a package-root
  `./schemas/*.json`. *(AC-01)*
- **C-5.2** Install writes `flow_revisions.result_profiles` for EVERY member flow
  in the SAME statement as the revision. A bad profile fails the install
  (`FLOW_INSTALL`), the revision goes `Failed`, and no partial map is written.
  *(AC-02)*
- **C-5.3** `resultProfile` is a NAME resolved against the PARENT run's pinned
  `runs.flow_revision_id`. Never a path, never an inline schema. *(AC-19)*
- **C-5.4** Refusals R1–R4 (flow target; `persistent`; unknown name; parent
  `engine_min < 3.7.0`) → `CONFIG` 422 with zero rows in `tasks` / `runs` /
  `run_results`. *(AC-19)*
- **C-5.5** The contract is snapshotted on ALL THREE creation edges:
  `run_delegate`, `run_plan`'s source launch, and `auto_launch_run_plan`'s
  candidate launch. *(AC-19, AC-20)*
- **C-5.6** A profile removed from a NEWER package revision still resolves for a
  run pinned to the older one. *(AC-20)*
- **C-5.7** The child's final `maister:output` block is validated and persisted
  BEFORE the child becomes collectable — inside the `finalizeAgentRun`
  transaction. *(AC-23)*

## C-6 — Scratch and manual runs

- **C-6.1** Scratch and manual runs keep the public result OPTIONAL; a NULL
  contract yields `resultStatus: "absent"` and nothing is parsed. *(AC-09, AC-23)*

## C-7 — Limits (one validator)

- **C-7.1** The result value reuses the ADR-162 byte cap
  (`MAISTER_NODE_OUTPUT_MAX_BYTES`) and structural caps (depth ≤ 64, ≤ 10 000
  keys, ≤ 10 000 array elements, unsafe-key rejection) through ONE validator.
  There is no second validator and no second limit. *(AC-13, AC-23)*
- **C-7.2** Objects are OPEN: undeclared nested keys are preserved EXACTLY.
  *(AC-13)*

## C-8 — Missing / invalid semantics

- **C-8.1** `required` excuses ABSENCE only. *(AC-15, AC-23)*
- **C-8.2** Agent child, required, absent → `invalid` row (`result_missing`, no
  value) + run `Failed` + `run.failed{reason:"result_missing"}`. *(AC-23)*
- **C-8.3** Agent child, present-but-invalid → `invalid` row (class reason) + run
  `Failed{result_invalid}`. *(AC-23)*
- **C-8.4** Flow `graph_completed`, required export, no current `valid` row →
  `invalid` row (`result_missing`) + `Failed{result_missing}`. *(AC-15)*
- **C-8.5** A human-resolved `Review` flip (`operator_stop`, `rework_released`,
  `sync_returned`) NEVER fails the run; `run_collect` reports `missing` or
  `stale` honestly. *(AC-17)*
- **C-8.6** `Failed` / `Crashed` outcomes never publish. A failure-terminal child
  reports `unavailable` with `resultFailure` from the newest `invalid` row (null
  when there is none). *(AC-23, AC-24)*

## C-9 — Result-only completion

- **C-9.1** A flow run finalizes `Running → Done` iff ALL of:
  `result_contract.kind === "flow_export"`, a `valid` current result, and a clean
  workspace (`diffNameStatus(base_commit..branch)` empty AND
  `diffWorkingTree(HEAD)` empty). A NULL `base_commit` is NOT clean. *(AC-16)*
- **C-9.2** It writes `runs{status:"Done", endedAt, currentStepId:null,
  diffStat:{0,0,0}}` with `promotedHeadSha`/`mergeCommitSha` NULL,
  `workspaces{scheduledRemovalAt = now + gcAgeDays}` with `promotion_state`
  unchanged (`'none'`), closes assignments, and emits webhook `run.done` + domain
  `run.done{completion:"result_only", resultStatus:"valid", parentRunId}` — and
  NO `run.review`. All in ONE transaction. *(AC-16)*
- **C-9.3** `deliverRunIfAutoReady` is skipped; mounts released, token revoked,
  `promoteNextPending` via the existing exit. *(AC-16)*
- **C-9.4** `promotion_hold` is NOT consulted; no `tasks` row is written. *(AC-16)*
- **C-9.5** `assertEvidenceReady(runId, "review")` still gates it. *(AC-16)*
- **C-9.6** Every other success exit is `Review`, byte-identical to today.
  *(AC-16)*

## C-10 — Effective bounds

- **C-10.1** `engine_min < 3.7.0` → env-only (`source:"env"`,
  `maxActiveChildren: null`, `budget: null`), byte-identical to today. *(AC-25)*
- **C-10.2** `engine_min ≥ 3.7.0` → `depth = min(env, declared ?? 2)`,
  `fanout = min(env, declared ?? 6)`, `active = min(poolCap, declared ?? 3)`,
  `budget` copied verbatim. A declaration ABOVE the env ceiling yields the env
  value. *(AC-25)*
- **C-10.3** Bounds are snapshotted on `runs.delegation_bounds` at node start,
  keyed by `nodeAttemptId`; a wake on the same attempt does not rewrite; a new
  orchestrator node attempt does. *(AC-26)*
- **C-10.4** Changing an env ceiling after the snapshot changes no admission
  outcome for a running tree. *(AC-27)*
- **C-10.5** `settings.delegation.budget` is REQUIRED and COMPLETE (all four
  keys) for an orchestrator node in a ≥ 3.7.0 manifest; a pre-3.7.0 orchestrator
  manifest without `budget` still loads. *(AC-05)*

## C-11 — Budgets and admission

- **C-11.1** `max_child_runs` binds at EVERY ancestor: admission walks the
  ancestor chain once and refuses when `countRunSubtree(ancestor) + incoming >
  ancestor.budget.maxChildRuns`, naming the ancestor. *(AC-28)*
- **C-11.2** Token / wall-clock / consecutive-failure budgets bind at the tree
  ROOT, min-merged into the ADR-101 sweeper meters; a nested orchestrator's
  budget is recorded, not metered. *(AC-30)*
- **C-11.3** Admission decisions are taken under the existing per-orchestrator
  advisory lock, held through the child run's INSERT. Two racers at `cap-1`
  produce exactly one winner and one `CONFIG`, with zero extra rows. *(AC-28)*

## C-12 — Active-children queue

- **C-12.1** A child over `maxActiveChildren` stays `Pending` — never refused —
  and `run_delegate` returns `status: "Pending"`. *(AC-29)*
- **C-12.2** `tryStartRun` and `promoteNextPending` both skip it, using the ONE
  exported `SLOT_HOLDING_RUN_STATUSES` constant. *(AC-29)*
- **C-12.3** A sibling reaching `Review` or `Done` frees the slot on the next
  `promoteNextPending`. The global pool cap still applies and a lower pool cap
  wins. *(AC-29)*

## C-13 — `run_collect` v2

- **C-13.1** DIRECT children only. A grandchild is invisible under `all: true`
  and refused `PRECONDITION` 409 when named (existence-hidden). *(AC-32)*
- **C-13.2** Idempotent: two consecutive collects return byte-identical bodies
  and `first_collected_at` is set exactly once. *(AC-32)*
- **C-13.3** `artifacts` is engine-derived from `artifact_instances` with
  `nodeId` + `validity`; a payload naming a fabricated artifact id changes
  nothing. *(AC-32)*
- **C-13.4** A terminal-orchestrator token is refused `PRECONDITION` 409.
  *(AC-32)*
- **C-13.5** `outputText` is deprecated and deterministic
  (`ORDER BY created_at DESC LIMIT 1`); the `"unknown"` status fallback is
  removed. *(AC-32)*
- **C-13.6** Every `resultStatus` value is reachable through the real seams.
  *(AC-31)*
- **C-13.7** MCP `TOOL_SPECS` mirror the OpenAPI for `resultProfile` (both
  tools) and for `run_collect`'s `resultStatus` vocabulary; a drifted enum in
  either direction fails the guard. *(AC-33)*

## C-14 — Wake events

- **C-14.1** `orchestrator_resume` wakes a parent on exactly `run.review`,
  `run.done` (incl. `completion:"result_only"`), `run.failed`, `run.crashed`,
  `run.abandoned`, routed by `payload.parentRunId`. *(AC-15, AC-18)*
- **C-14.2** The child's `run_results` row is committed in the SAME transaction
  as the settle flip that emits the event. *(AC-13, AC-15, AC-16, AC-23)*
- **C-14.3** Payload widening is additive: `+resultStatus` on
  `run.review|run.done|run.failed`; `+completion` on `run.done`; `run.failed
  .reason` gains `result_missing|result_invalid`. No new kinds, no CHECK change.
  *(AC-18)*
- **C-14.4** `ralph_loop` never relaunches a run with `parent_run_id`; a
  parentless run is relaunched exactly as before. *(AC-18)*

## C-15 — Trust boundaries

- **C-15.1** `resultProfile` is the only new body-controlled identifier. It is a
  NAME (`/^[A-Za-z0-9._-]{1,64}$/`), resolved through an allow-list keyed on
  server state; it is never a path or a schema. *(AC-19)*
- **C-15.2** Parent `flow_revision_id`, the allowed profile set, root run, depth,
  active node, bounds and the child's `result_contract` are all server-state.
  *(AC-19, AC-26)*
- **C-15.3** `run_collect`'s `childRunId` stays body-controlled and is verified
  `parent_run_id = bound AND project_id = token`. *(AC-32)*
- **C-15.4** No filesystem path component appears in any new body field, and
  artifact metadata is never taken from a payload. *(AC-32)*

## C-16 — Observability

- **C-16.1** The run inspector renders the public result (schemaRef, validity,
  revision, collected marker, JSON viewer) for a run with a contract or rows, and
  nothing for a run without. Child rows carry a per-status glyph. EN and RU
  strings both resolve. *(AC-34)*
- **C-16.2** `getRunTreeCostSummary(root)` sums root + descendants by kind and
  model and reports tree wall-clock; a non-root run yields no tree facts;
  `GET /api/runs/{id}/cost-summary` includes `tree` only for a tree root with
  children. *(AC-35)*
- **C-16.3** No result value, prompt, artifact body, token secret, or
  `acp_session_id` is ever logged. *(AC-36)*
- **C-16.4** No second evidence subsystem is introduced. *(AC-36)*

## C-17 — Reference harness

- **C-17.1** The reference graph has ONE writer by construction (`writer`), an
  independent verifier behind a blocking gate, and bounded rework / human
  escalation for malformed results, child failures, budget exhaustion and
  no-consensus. *(AC-37)*
- **C-17.2** Hidden adapter subagents are structurally excluded:
  `enforcement.tools: strict` + a `tools` allow-list omitting the subagent tool,
  enforced by `capability_guard`. *(AC-37)*
- **C-17.3** A settled child is never promotable by itself without ITS own
  readiness. *(AC-37)*
- **C-17.4** Research flow children finish `Done` by result-only completion; the
  coordinator only collects. *(AC-38)*

## C-18 — Evaluation Lab

- **C-18.1** Nine measures over four arms via the existing objective-provider
  seams, all reading RECORDED facts (non-executable). *(AC-39)*
- **C-18.2** "The parent used the results" is the INTERSECTION of engine-marked
  collection (`first_collected_at`) and self-reported consumption
  (`consumedChildRunIds`); a fabricated id is excluded. *(AC-39)*

## C-19 — Packaging

- **C-19.1** This repo ships the engine, API, storage, UI and an IN-REPO fixture
  package. No external package source enters core. *(AC-37)*
- **C-19.2** The production package `maister-plugins/packages/rah` is authored
  externally and tagged after this repo merges. *(AC-40)*

---

## Owner decisions (2026-09-02, verbatim)

| Q | Decision |
| --- | --- |
| Q1 | **A** — node bounds live for `engine_min ≥ 3.7.0` only |
| Q2 | **A** — JSON schema documents only (no YAML) |
| Q3 | **6** — default fan-out |
| Q4 | **A** — required absent/invalid → `Failed`, with the `invalid` row as the one durable reason |
| Q5 | **C** — result-only completion to `Done` |
| Q6 | **C** — child-count budget at every level; spend/time/failure at the root |
| Q7 | **C** — engine marker + self-reported consumption, intersection metric |
| Q8 | **A** — ADR-165 / migration 0129 (Stage A's 164 / 0128 are committed on its unmerged branch) |
| Q9 | **B** — companion package authored after Phase 7, committed and tagged after merge |
| Q10 | **A** — domain-event payload widening, no new kinds |

One shipped-path change was folded in rather than asked: `ralph_loop` skipping
delegated children (C-14.4), because a lineage-less relaunch would silently break
the "child failures route through the parent" contract the harness relies on.

## Explicitly out of scope

Python RLM runtimes · Prime Agent integration · adapter-internal hidden subagents
(structurally excluded) · unbounded recursion · autonomous production skill
mutation · concurrent shared-workspace writers · subtree token/wall-clock/failure
budget enforcement below the root · a `Review`-age sweeper for non-result flows ·
auto-archive of Review children · a versioned `/collect/v2` route · YAML schema
documents · new env vars · a domain-event AsyncAPI file · parking invalid agent
results in `Review` for `run_rework`.
