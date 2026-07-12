# SDD: Observatory Agentization Metrics and Commit Provenance

Status: Implemented on `feature/observatory-agentization-provenance` (2026-07-12)
Plan: `.ai-factory/plans/feature-observatory-agentization-provenance.md`
ADR/migration: ADR-134 / `0098_observatory_agentization_provenance` (allocated
after rebase onto owner `main` on 2026-07-12).

## 1. Purpose and boundary

At project scope, Observatory SHALL report the share of target-branch delivery
attributable to MAIster-hosted runs. It SHALL remain a read-only surface: a
page or read query SHALL NOT fetch Git remotes, reconcile providers, write a
row, seed a job, or make a promotion decision.

Portfolio agentization aggregation, targets, benchmarking, recommendations,
write-back, A/B experiments, promotion policy changes, Flow DSL changes,
engine bumps, new host configuration, and retroactive MAIster-run attribution
are out of scope.

## 2. Terms

| Term | Meaning |
| --- | --- |
| delivery delta | Cleaned additions/deletions for a target-branch delivery, defined in §4. |
| final evidence | `promoted_head_sha`, optional `merge_commit_sha`, and cleaned `diff_stat` persisted only after the delivery is proven shipped. |
| provisional PR evidence | Pushed source-head linkage held before target-branch merge; it is not a shipped numerator contribution. |
| delivery root | The own run, or the sole root run representing one shared worktree delivery. |
| eligible run | Project-scoped flow, scratch, or worktree-agent run with final delivery evidence. |
| run-kind filter | `all`, `flow`, `scratch`, or `agent`; invalid/absent/repeated input resolves to `all`. |

## 3. Locked decisions

### D1 — Measure lines and clean paths once

The headline is:

```text
AI shipped additions + AI shipped deletions
------------------------------------------
repository additions + repository deletions
```

The secondary rate is attributed merge/PR delivery units divided by all target
merge/PR delivery units. One `delivery-pathspec` pure module owns the exact,
frozen lock/generated/vendor exclusion set. Git invocation and post-filtering
apply it to both `path` and rename `oldPath`. Binary numstat rows count as a
file and zero lines. Changing the set requires a future ADR plus migration and
rescan strategy; v1 has no pathspec-version field.

The frozen v1 exclusion set is: lock-file basenames `bun.lockb`, `cargo.lock`,
`composer.lock`, `gemfile.lock`, `package-lock.json`, `pnpm-lock.yaml`,
`poetry.lock`, and `yarn.lock`; and any path segment `.next`, `build`,
`coverage`, `dist`, `generated`, `node_modules`, or `vendor`. The matching Git
pathspec list and the defensive post-filter are exported from the same module.

### D2 — Store run evidence, not workspace evidence

`runs.promoted_head_sha`, `runs.merge_commit_sha`, and
`runs.diff_stat` belong to `runs`; a shared workspace can represent N runs.
`diff_stat` is exactly:

```ts
{ files: number; additions: number; deletions: number }
```

An own delivery belongs to one run. A shared worktree belongs to exactly one
root run; siblings remain null and the root's `run_kind` owns the single
kind bucket. Per-child shared line attribution is excluded. A shared PR uses
that same allocator root for its PR body and provisional source-head evidence;
all settled tree children transition together while only the root is later
eligible for scanner-finalized delivery evidence.

### D3 — Truthful, identity-independent provenance trailers

Every managed worktree commit carries:

```text
Maister-Run-Id: <runId>
Maister-Task: <TASKKEY-N>       # only when real
Maister-Flow: <flowRefId>@<rev> # only when real
Maister-Node: <nodeId>          # only during one active graph attempt
```

The marker is provenance, not an author-identity claim. It preserves an
existing Git author, uses portable `/bin/sh`, and is installed via per-worktree
`core.hooksPath` plus `commit.template` after enabling
`extensions.worktreeConfig=true`. The hook fills missing expected trailers,
never duplicates them, rejects a conflicting Run ID, and fails closed when
required managed metadata is missing. It applies to ordinary commits,
`git commit -m`, `--no-verify`, and amend.

Taskless scratch/agent work MUST NOT invent Task or Flow values. The universal
Run marker is sufficient for scanner attribution. Shared-worktree reuse retains
the root metadata and may only change the current Node pointer.

### D4 — Denominator comes from a scheduled remote scan

One system-managed `repo_delivery_scan.<projectId>` job per non-archived
project fetches `origin`, then measures only
`refs/remotes/origin/<projects.main_branch>`. The page never fetches. A scan
uses injected `now`, the existing maximum 365-day window, bounded Git output
and timeout, UTC half-open daily buckets, and an explicit zero-valued current
day bucket.

Fetch/parse/provider work happens before the transaction. The successful
transaction delete-and-replaces the complete project/branch horizon, removes
obsolete branch rows, and writes one `fetched_at` and `head_sha`. Failed scans
preserve the previous successful cache. Archive disables/skips; unarchive
idempotently seeds/enables only an archive-style disabled job. A job disabled
at its native `maxFailures=3` threshold remains disabled, preserving bad
repository isolation. Project delete cascades.

### D5 — Per-project first

Agentization and the new all-run autonomy funnel render only on the project
Observatory. Existing portfolio cost/budget views may honor run-kind scope but
do not render agentization or the new funnel.

### D6 — No enforcement

Metrics are observational only. They do not affect promotion, targets,
benchmarks, experiments, or ADR-041.

### D7 — All eligible kinds with a breakdown

The numerator includes eligible project-scoped `flow`, `scratch`, and
worktree-backed `agent` deliveries. Scratch is currently local-merge-only.
Flow and worktree agents use workspace promotion. Agent `none`/`repo_read`
sessions and project-less local-package scratch sessions have no per-project
delivery evidence and are excluded by eligibility, not by a hidden kind rule.

The all-kinds numerator equals the sum of root-owned flow/scratch/agent
buckets. A selected kind changes only the AI numerator; its denominator stays
all target-branch delivery because human repository work has no MAIster kind.

### D8 — Attribute cost and budget; keep process metrics honest

Correction, Autonomy Score, signals, harness, artifacts, coverage, and node
drill-down are flow-ledger metrics. They SHALL be visibly labeled `flow runs`.
For a scratch/agent selection they render `not applicable — flow ledger only`,
never a flow value labeled as another kind. Extending Autonomy Score to scratch
is deferred.

Cost, budget, and the project all-run funnel are kind-attributed. Cost uses
stored/lifetime rollups, not `windowDays`; budget remains time-windowed.

### D9 — Join at read time

`run_cost_rollups` and `node_attempt_cost_rollups` join their mandatory
`run_id` to `runs.run_kind`; no new rollup column, migration, or backfill is
permitted. Run-bound budget events join `domain_events.run_id` to `runs`.
Budget events with null `run_id` remain a visible `unattributed_legacy` bucket
in `all`; a concrete kind selection excludes them. This prevents silent
misclassification and ensures displayed all-budget totals reconcile.

## 4. Canonical delivery delta

| Promotion outcome | Delivery delta | Evidence timing |
| --- | --- | --- |
| local merge | merge commit against its first parent | after target merge |
| rebase / fast-forward | ordered target commits introduced from pre-promotion target to final target, each against first parent | after final target update |
| pull request | no contribution at PR-open; scanner resolves the exact target delivery | after repository/provider proof |

Target history uses frozen first-parent traversal and cleaned `--numstat` so a
merged feature branch is not double-counted. Direct/rebased delivery lines
enter the headline; the secondary denominator contains only actual merge
commits and provider-proven PR delivery commits.

Every cached `delivery_ref` carries that individual commit's cleaned delta.
The headline de-duplicates one delivery root by final SHA/PR evidence, while
the daily trend uses each trailered rebase/FF commit's own delta. Thus a
multi-commit rebase contributes once to the headline and to its actual daily
buckets, never as a fabricated merge/PR unit.

## 5. Persisted contracts

### 5.1 `runs`

| Field | Meaning |
| --- | --- |
| `promoted_head_sha` | final target delivery head; PR-open may hold provisional pushed head until scanner confirmation |
| `merge_commit_sha` | actual non-FF merge or provider-resolved PR merge; null for rebase/FF |
| `diff_stat` | final cleaned target-delivery stat; null until shipped evidence exists |

Final evidence persistence is shared by the scratch finalizer and the
workspace flow/agent finalizer. Failure, supersession, or no workspace leaves
final evidence null.

### 5.2 `repo_delivery_rollups`

One row per `(project_id, branch, bucket_start, bucket_end)` stores cleaned
denominator counts, `merge_pr_units`, `delivery_refs`, provider-completeness,
head, and freshness. `delivery_refs` is repository evidence only and may hold
SHA, parent count, Run trailer IDs, resolved PR number, and an individual
cleaned commit delta; it never caches the database-derived numerator.

## 6. Read contracts

### 6.1 Run-kind segment

`runKind` is validated as `all|flow|scratch|agent`. It appears in both existing
Observatory page forms and is preserved by flow/node drill-down URLs.

| Surface | all / flow | scratch / agent |
| --- | --- | --- |
| correction, Autonomy Score, signals, harness, artifacts, coverage, node detail | flow data with `flow runs` label | explicit not-applicable state |
| cost | all/selected kind rows and kind breakdown | selected kind only |
| budget | kind rows plus `unattributed_legacy` in all | selected kind only |
| project agentization | all headline plus three buckets | selected-kind numerator over all-repo denominator |
| project all-run funnel | all runs | selected kind |

Projectless scratch is excluded by project scoping. All read paths stay
constant-count: equal SELECT count for one versus many rows and no more than
20 SELECTs after this feature.

### 6.2 Insufficiency and volatility

Rates require nonzero denominator and metric-specific `MIN_GROUP_EXECUTIONS`:
target delivery commits for lines, merge/PR units for the secondary rate.
Missing cache, low N, unresolved/ambiguous PR evidence, and zero denominator
render insufficient, never a guessed rate. Active/nonterminal runs are never
shipped numerator evidence and independently set `volatile=true`.

## 7. Failure classification

| Failure | Result |
| --- | --- |
| missing/conflicting metadata in a recognizable managed worktree | commit/promotion aborts with actionable failure |
| pre-cutover worktree without a managed directory | promotion remains available without trailer recovery; no historical delivery evidence is backfilled |
| hook/config install failure | compensate created worktree/branch and throw `MaisterError` |
| fetch/provider/network failure | `EXECUTOR_UNAVAILABLE`; retry project job and preserve cache |
| missing origin/target | `PRECONDITION`; bounded project-job failure |
| malformed Git output | `CONFIG`; no partial cache replacement |
| ambiguous Run attribution | `CONFLICT`; no guessed binding |
| unresolved PR/squash attribution | line denominator usable; affected rate insufficient |

No new error code is introduced.

## 8. Acceptance criteria and primary proof

| ID | Criterion | Primary proof |
| --- | --- | --- |
| AC-P1 | Flow, scratch, and worktree-agent commits preserve truthful trailers across commit forms and identities | real-Git integration |
| AC-E1 | Flow, scratch, and worktree-agent promotions persist final evidence correctly; non-promotable kinds do not | promotion integration |
| AC-S1 | Scan counts post-fetch origin target history with matching cleaning and atomic cache replacement | bare-origin + Testcontainers integration |
| AC-O1 | All-kinds and selected-kind agentization rates/buckets are correct | pure rollup tests |
| AC-O2 | Cost/budget and funnel expose honest kind scope; legacy budget remains reconciled | Testcontainers query tests |
| AC-U1 | Every panel states scope and renders EN/RU states without actions | static markup + Playwright |
| AC-R1 | Project read is cache-only, non-mutating, and fixed-count; portfolio omits agentization | query/page-contract tests |

## 9. Test execution contract

Each implementation task begins with the smallest owning RED test, turns it
GREEN with the minimal change, then refactors with focused tests green. Pure
tests own parsers, trailers, formulas, classifications, and bucket arithmetic;
real-Git owns worktree config/commit/merge/rebase behavior; Testcontainers owns
migration, transaction, scheduler, and query joins; static markup owns visible
states; Playwright owns two non-overlapping end-to-end paths. New tests must be
listed by exactly one Vitest/Playwright runner before their phase is complete.
