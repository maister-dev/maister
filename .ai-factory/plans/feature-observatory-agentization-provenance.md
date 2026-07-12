# Implementation Plan (SDD): Observatory Agentization Metrics + Commit Provenance

Branch: `feature/observatory-agentization-provenance`
Created: 2026-07-12

## Settings

- Testing: yes — docs/spec first, then TDD `RED -> GREEN -> REFACTOR`; pure unit tests, real-git fixtures, Testcontainers integration, `renderToStaticMarkup`, page-contract tests, and seeded Playwright.
- Logging: verbose during implementation — DEBUG for per-commit/per-bucket classification, INFO for provenance installation/promotion evidence/scan summaries, WARN for stale or incomplete provider attribution, ERROR for terminal scanner or git failures. Use structured pino fields; never log credentials, token-bearing URLs, commit bodies, or task prompts.
- Docs: yes — mandatory Phase 0 contract checkpoint and as-built reconciliation before merge.
- Delivery: plan only. Do not auto-run `$aif-implement`.

## Roadmap Linkage

Milestone: "none"
Rationale: this owner-directed feature extends shipped M23 Observatory and M24 Scheduler without reopening either milestone or claiming a new numbered roadmap milestone.

---

## 1. Outcome

At per-project scope, Observatory answers:

1. What share of shipped delivery lines was produced by MAIster-hosted AI runs?
2. What share of merge/PR delivery units is attributable to MAIster runs?
3. How much of the run population is autonomous, corrected by a human, or taken over by a human?
4. Can the same attribution be recovered directly from a fetched git repository after remote synchronization?
5. Which run kinds produced the AI-attributed delivery, cost, and budget pressure being shown?

The UI remains read-only. It has no targets, benchmark thresholds, recommendations, write-back, fetch, reconcile, or mutating route. Portfolio agentization aggregation is deferred; the existing portfolio cost/budget/funnel views may still expose their honest run-kind scope.

## 2. Verified implementation baseline

- Observatory is a server-component read model over `web/lib/queries/observatory*.ts`, pure rollups in `observatory-core.ts`, shared components under `web/components/observatory/`, and project/portfolio pages. `MIN_GROUP_EXECUTIONS = 3`; active/open populations are marked volatile; project + node aggregation currently has a constant-query-count test capped at 16 SELECTs.
- The current eligible Observatory population is flow-only and requires `node_attempts`. The requested run-kind/launch/trigger/human-touch funnel therefore needs a separate all-run bulk population; otherwise scratch and standalone-agent runs disappear.
- `runs.launch_mode` and `runs.trigger_source` are nullable and are not populated for every historical launch path. Null is an honest `unrecorded` bucket, never silently `manual`.
- Historical manual takeover cannot be inferred from the terminal `runs.status`; use `assignment_events.event_kind='taken_over'`, with `node_attempts.owner_user_id` as corroborating evidence. Human-review evidence is `assignments.action_kind='human_review'`; any `hitl_requests` row is also human touch.
- `web/lib/worktree.ts` already returns merge/rebase target HEADs, `headCommit()`, and per-file `diffChangeStats()`, but promotion discards those values. `commitIdentityArgs()` only fills missing host identity.
- `addWorktree()` is the shared creation seam used by flow, project scratch, and worktree agent launches. It currently installs no worktree-scoped commit provenance.
- `snapshotDirtyWorktree()` and `squashRunBranch()` use `-m` and `--no-verify`; `promoteLocalMerge()` uses `--no-ff --no-edit`. The source-worktree hook cannot stamp the parent-checkout merge commit.
- `prepare-commit-msg` is not bypassed by `--no-verify`; `commit.template` is bypassed by `git commit -m`. The hook, not the template, is the guarantee.
- PR promotion currently means “PR opened”: `PrResult` contains only `{url, number}`, the run becomes `Done`, and no remote merge SHA exists yet. A PR must not enter the shipped numerator until the scanner resolves an actual target-branch delivery commit.
- Scheduler kinds are a closed set across schema types, catalog, budgets, default seeding, four `claimDueJobs` CTE CASE/VALUES seams, tick dispatch, admin filters, OpenAPI, and EN/RU labels. Missing one CTE arm makes a registered job unclaimable.
- The requested `docs/scheduler.md` path does not exist. The canonical scheduler contract is `docs/system-analytics/scheduler.md`.
- Process panels are intentionally flow-ledger reads: `loadObservatoryRows()` hardcodes `runs.run_kind='flow'` because correction, Autonomy Score, signals, harness, and node drill-down require node-attempt/gate evidence. Their scope is currently not labeled.
- `getCostSummary()` reads every `run_cost_rollups` row in project scope without joining `runs`; scratch/agent tokens therefore enter totals but a scratch row with `flow_id=NULL` disappears from the by-flow count. `run_cost_rollups` has an exact `run_id` FK but no `run_kind`, so a join is sufficient and avoids a denormalized migration.
- `getBudgetSummary()` reads all project `domain_events` without joining `runs`; `domain_events.run_id` is nullable, so kind-attribution must retain an explicit legacy-unattributed bucket rather than silently drop or misclassify events.
- `run_cost_rollups` has no event-time dimension; its stored total is not truthfully bounded by Observatory `windowDays`. Its scope copy must say stored/lifetime cost until a separate historical-cost design exists.
- Promotion is not one finalizer: `promoteScratchRun()` owns scratch local-merge finalization, while `promoteWorkspaceRun()` owns flow and worktree-backed agent finalization. Agent `none`/`repo_read` sessions have no branch workspace and cannot produce promotable delivery evidence.

## 3. Locked decisions carried into implementation

### 3.1 Metric and path cleaning

- Headline agentization is `AI additions + AI deletions` divided by repository additions + deletions over the same project/branch/window.
- Secondary ratio is AI-attributed merge/PR delivery units divided by total merge/PR delivery units.
- Numerator and denominator use the same canonical **target-delivery delta**, not a net feature-branch diff on one side and commit churn on the other:
  - `local_merge`: the merge commit compared with its first parent;
  - `rebase`/fast-forward: the ordered target commits introduced between the pre-promotion target SHA and the final target SHA, each compared with its first parent;
  - `pull_request`: no shipped delta at PR-open time; after merge, the scanner resolves the exact target delivery and only then admits it to the numerator.
- The secondary denominator contains only actual merge commits plus provider-proven PR delivery commits. Rebase/FF line output contributes to the headline but, without a merge/PR unit, does not fabricate a secondary unit.
- A single pure `delivery-pathspec` module owns the frozen lock/generated/vendor exclusion set. Both run evidence and repository history invoke git with the same positive/exclude pathspecs and defensively post-filter both `path` and rename `oldPath` with the same predicate.
- Binary files count toward `files` and contribute zero line additions/deletions, matching the existing numstat parser.
- The exact exclusion set is frozen in the SDD and ADR for this schema generation. A future change requires an explicit decision and migration; v1 does not add a version field that contradicts the locked `diff_stat` shape.

### 3.2 Run evidence and shared workspaces

- All three run fields are nullable. Local merge/rebase finalize writes final delivery evidence; PR-open may write only provisional `promoted_head_sha`, while final `diff_stat`/merge evidence waits for scanner proof of target delivery.
- `runs.diff_stat` is typed JSONB exactly as `{files, additions, deletions}`. `workspaces.base_commit` remains provenance context, but metric capture follows the target-delivery delta in §3.1.
- Own mode attributes one delivery to one run.
- Shared mode writes the tree delivery evidence to exactly one root run; settled siblings do not receive duplicated stats. Observatory groups by `root_run_id`/shared workspace and counts the tree once.
- A distinct merge commit exists only for `local_merge`. Rebase/fast-forward has no merge commit, so `merge_commit_sha` remains null and `promoted_head_sha` is its delivery key.
- PR-open records provisional source-head linkage only; it does not populate shipped `diff_stat` or `merge_commit_sha`. After the scanner proves the target merge and exact target delta, it confirms/replaces the final delivery SHA/stat evidence. If that exact attribution is unavailable, the PR remains outside the numerator and the affected metric is `insufficient`.
- Eligible numerator runs are project-scoped, workspace-backed promoted `flow`, `scratch`, or `agent` runs with final exact delivery evidence. Scratch contributes through its supported `local_merge` path; worktree-backed agents contribute through workspace promotion; `none`/`repo_read` agents and project-less local-package scratch runs have no per-project delivery evidence and are excluded by the eligibility predicate, not by a hidden kind policy.

### 3.3 Commit trailers

- Task-bound Flow worktrees stamp:

  ```text
  Maister-Run-Id: <runId>
  Maister-Task: <TASKKEY-N>
  Maister-Flow: <flowRefId>@<revision>
  Maister-Node: <nodeId>   # omitted when no node is active
  ```

- The subject line stays convention-clean. Provenance does not claim a different human/AI author identity.
- The hook fills missing expected trailers without duplication. A conflicting `Maister-Run-Id` fails the commit; an absent optional Node is allowed. Missing immutable managed metadata fails closed.
- The managed hook is portable `/bin/sh`: no `jq`, shell `source`, host-specific interpreter, or untrusted metadata evaluation.
- PR mode preserves the existing run ID in the PR body as an additional human-readable bridge; no provider-specific PR body contract is removed.
- Task-bound Flow/tree work always stamps Run/Task/Flow. Scratch and taskless standalone-agent work always stamps Run and includes Task/Flow only when real immutable values exist; identifiers are never fabricated. All project-scoped, workspace-backed promoted kinds may enter the v1 numerator once their final evidence exists; scanner matching requires the universally truthful Run trailer, not invented Task/Flow values.
- A reused shared worktree retains the root run/task/flow provenance for its lifetime. Sibling entry never overwrites those immutable values; Node is the only mutable trailer context.

### 3.4 Worktree-scoped configuration

- `extensions.worktreeConfig=true` is enabled once in the shared repository config.
- The managed hook and template live under the run worktree’s absolute `.maister-managed/` path.
- `git config --worktree core.hooksPath <absolute-path>` and `git config --worktree commit.template <absolute-path>` are mandatory. Writing either key without `--worktree` is a blocking defect because it leaks attribution across linked worktrees.
- Immutable run/task/flow values are materialized as data, never sourced as shell. `.maister-managed/current-node` is atomically set immediately before each graph-node dispatch and cleared in `finally` after every attempt, including pause, failure, rework, and exception. A separate pointer avoids changing the established `.maister/run.json` blackboard shape and prevents stale Node values on later snapshot/promotion commits.
- Hook install is part of worktree creation. Failure compensates by removing the just-created worktree/branch and throws a typed `MaisterError`; a worktree without the stamp is never returned as successfully launched.
- Reused and orphan-claimed worktrees do not pass through `git worktree add`; launch must run an idempotent ensure/repair step before dispatch. Repair validates root metadata and managed paths without replacing shared-root provenance.

### 3.5 Cached repository denominator

- Add system-managed scheduler kind `repo_delivery_scan` and one job per non-archived project: `repo_delivery_scan.<projectId>`, `project_id=<projectId>`, fixed hourly cadence, budget 1, max failures 3.
- The claim returns `project_id`; the handler derives repo path and target branch from server-side project state. No body/target JSON controls a filesystem path or branch.
- Each job fetches `origin` with existing hardened, non-interactive git behavior, resolves exactly `refs/remotes/origin/<projects.main_branch>`, and never falls back to a local ref.
- Each successful scan recomputes all target-branch deliveries in the existing Observatory maximum horizon (`MAX_WINDOW_DAYS = 365`) using an injected `now`, bounded Git timeout/output, and deterministic UTC daily buckets. It does not scan unbounded repository history.
- Repository history is scanned as the canonical target-delivery deltas in §3.1 with committer time, parent SHAs, trailers, and cleaned `--numstat`. The SDD/ADR freeze the exact first-parent traversal/diff commands so merged feature commits are not double-counted.
- `repo_delivery_rollups` stores UTC daily half-open buckets, so the existing arbitrary `windowDays=1..365` filter and a daily trend need no page write and no cumulative-window explosion.
- Each bucket stores denominator totals plus a bounded `deliveryRefs` attribution index (`sha`, parent count, trailer run IDs, resolved PR number when available, and that commit's cleaned diff stat). This is fetched repository evidence, not a cached run-derived numerator. Observatory still computes the numerator lazily by joining matching platform runs and summing their captured `diff_stat` once per own run/tree root; per-commit stats make the daily AI trend exact for rebase/fast-forward deliveries rather than assigning a final run total to one day.
- Provider-backed PR resolution uses the persisted `pr_url`/`pr_number` to resolve an actual merged commit SHA for GitHub/GitLab/Gitea. If provider metadata is unavailable, line denominators remain usable but the PR/merge ratio is explicitly insufficient; commit-subject guessing is forbidden.
- Fetch/parse/provider work happens before a DB transaction. A successful transaction delete-and-replaces that project/branch’s entire 365-day horizon with one `fetched_at` and target head, including a zero-valued current-day bucket. This distinguishes scanned-empty from never-scanned and removes force-pushed-away commits. A project target-branch change removes obsolete branch rows. Failure preserves the last successful cache/freshness.
- Poison isolation comes from one scheduler job per project: a bad repo consumes only its own bounded retry budget and can disable only its own job. Other projects continue through normal due ordering and `FOR UPDATE SKIP LOCKED`.
- Lifecycle is explicit: archive disables/skips the project job; unarchive idempotently re-enables or seeds it; project deletion cascades job and rollups; repeated failures use native `maxFailures=3`; admin re-enable remains the recovery path.
- Failure classification uses existing errors only: transient fetch/provider/network failures are `EXECUTOR_UNAVAILABLE` and retry; missing remote/target is `PRECONDITION` and consumes the bounded project-job failure budget; malformed Git output or ambiguous attribution is `CONFIG`/`CONFLICT` and preserves cache; archived projects cleanly skip/disable without poisoning other jobs.

### 3.6 Read-only metrics contract

- Agentization and the new all-run autonomy funnel are project-only in v1. The existing portfolio Observatory gains kind filtering for meaningful cost/budget surfaces and honest flow-ledger scope labels but never renders agentization or the new funnel.
- Lines numerator: distinct matched eligible own-run/tree-root `diff_stat.additions + deletions`; denominator: selected rollup bucket additions + deletions. `all` is the sum of the flow/scratch/agent root-owned buckets.
- Merge/PR numerator: distinct target delivery refs attributed by trailers, exact promoted/delivery SHA, or provider-resolved PR number; denominator: repository merge/PR refs. If squash-PR completeness cannot be proven, return `insufficient`, not a guessed percentage.
- A selected run kind filters only the AI numerator and all-run/funnel/cost/budget population it can truthfully scope. Agentization denominator remains kind-agnostic repository delivery; kind shares therefore sum to the all-kinds headline rather than pretending human delivery has a MAIster kind.
- Both rates require a non-zero denominator and their own honest N: headline uses target-delivery commits; secondary uses actual merge/PR units. Each must meet `MIN_GROUP_EXECUTIONS`; UI renders `—` plus raw `n`/line totals below threshold.
- Trend uses the same daily bucket boundaries for numerator and denominator; matched AI evidence inherits the repository delivery-ref bucket rather than the run timestamp. `as of <fetched_at>` is always visible when cache exists.
- Active/nonterminal runs never enter the shipped numerator; their presence sets `volatile=true`. Cache freshness and volatility are separate states.
- Human-touch precedence is `human_takeover > ai_with_correction > pure_autonomous`:
  - `human_takeover`: a historical `taken_over` assignment event or owned takeover attempt;
  - `ai_with_correction`: any HITL or human-review assignment without takeover;
  - `pure_autonomous`: neither.
- Funnel slices are counts + honest nullable rates for run kind, launch mode (`unrecorded` preserved), trigger source (`unrecorded` preserved), human touch, terminal throughput (`platform_promoted | failed | crashed | abandoned`), and promotion lane (`auto | manual`). `platform_promoted` is deliberately not labeled repository-shipped because PR-created `Done` can precede merge. Active/Review runs are excluded from terminal throughput and make it volatile.
- Every rollup accepts explicit `now`. Reads are bulk/fixed-count and never loop queries per project/run/bucket. The integration contract requires identical SELECT counts for 1 vs many runs and an absolute ceiling of 20 after the new reads.

### 3.7 Run-kind scope and filter contract

- **D7 — All-kinds numerator with breakdown:** eligible promoted project runs of kind `flow`, `scratch`, and worktree-backed `agent` count, with flow/scratch/agent buckets; this directly answers what kind of MAIster-hosted work shipped.
- **D8 — Attribute, do not merge:** cost and budget remain read-only but expose kind attribution; ledger-dependent process metrics remain explicitly flow-scoped rather than inventing scratch/agent ledger evidence.
- **D9 — Join, do not denormalize:** read-time joins from cost/budget records to `runs` are the v1 mechanism. No `run_kind` rollup column, migration, or backfill is authorized unless a future measured read-cost decision supersedes this one.
- Parse one validated segment `runKind=all|flow|scratch|agent`; absent, repeated, or invalid input resolves to `all`. Preserve it on both existing Observatory pages, drill-down links, and the project-only agentization page.
- Flow-ledger process panels — correction, Autonomy Score, signals, harness, artifact/node drill-down, and coverage — carry an explicit `flow runs` scope label. With `all` or `flow`, they render their flow-ledger data. With `scratch` or `agent`, they render an explicit not-applicable state (`flow ledger only`) and never show flow values as selected-kind values. Extending the existing Autonomy Score to scratch is deferred.
- Cost is kind-attributed by joining `run_cost_rollups` (and its node-count companion) to `runs`; budget is kind-attributed by joining run-bound `domain_events` to `runs`. Both render all/selected-kind scope and flow/scratch/agent breakdowns. Budget events without `run_id` remain a visible `unattributed_legacy` bucket in the `all` view so totals reconcile; a selected concrete kind excludes them. Cost has no equivalent because its `run_id` is mandatory.
- Cost scope copy states stored/lifetime rollup cost, not `windowDays`; budget remains window-bounded. This amendment changes no cost-rollup schema or backfills no historical data.
- The project all-run human-touch/promotion funnel honors the selected kind. Shared delivery retains one root-owned kind bucket; v1 does not redistribute a shared tree across heterogeneous siblings.

## 4. SDD requirements and invariant map

The authoritative implementation specification is `.ai-factory/specs/feature-observatory-agentization-provenance.md`. Phase 0 must assign stable numbered IDs and keep this plan, ADR, API contract, analytics docs, schema docs, tests, and implementation traceable to them.

### Functional requirements

- **FR-P1:** every commit made in a managed flow, scratch, or worktree-agent worktree receives a truthful, idempotent Run trailer and every available real Task/Flow trailer; Node is attempt-scoped and optional.
- **FR-P2:** creation, reuse, orphan claim, snapshot, squash, amend, merge, and rebase paths preserve or reapply provenance without changing author identity or leaking config to another worktree.
- **FR-E1:** only shipped, exact target-delivery evidence from an eligible project-scoped flow, scratch, or worktree-agent run populates final SHA/stat fields; shared delivery is represented once at the root.
- **FR-S1:** a per-project scheduled scan fetches and measures `origin/<target>` over the bounded horizon, atomically caches cleaned daily denominators, and isolates failures by project.
- **FR-O1:** project Observatory exposes lines share, delivery-unit share, trend, freshness, insufficiency, and volatility from bulk cached reads only.
- **FR-O2:** project Observatory exposes the all-run autonomy/human-touch/promotion slices from existing captured data without new write paths.
- **FR-O3:** every Observatory panel exposes an honest run-kind scope; meaningful cost, budget, funnel, and agentization views honor `all|flow|scratch|agent`, while ledger-dependent process views state and enforce their flow-only boundary.

### Invariants

- **INV-1 Read-only:** Observatory page/query performs no fetch, Git, provider reconcile, scheduler mutation, or row mutation.
- **INV-2 Comparable math:** numerator and denominator use the same target-delivery delta and frozen cleaning set.
- **INV-3 Truthful attribution:** no fabricated Task/Flow, subject inference, local-ref fallback, or open-PR shipped attribution.
- **INV-4 Single ownership:** an own delivery counts once; a shared tree counts once at its root.
- **INV-5 Atomic cache:** failed scans retain the prior complete cache; successful scans replace the complete bounded horizon and include current-day zero.
- **INV-6 Remote truth:** denominators use post-fetch `refs/remotes/origin/<target>` only.
- **INV-7 Honest N:** zero, missing, low-N, unresolved PR, or ambiguous attribution yields `insufficient`, never a guessed percentage.
- **INV-8 Fixed reads:** project aggregation stays at the same query count for 1 vs many rows and at or below 20 SELECTs.
- **INV-9 Kind truth:** selected-kind agentization filters the AI numerator only; repository denominator stays kind-agnostic, process panels never relabel flow data as scratch/agent data, and taskless runs never receive fabricated trailers.
- **INV-10 Reconciled attribution:** cost/budget totals equal the displayed kind buckets plus explicit budget `unattributed_legacy`; project-less scratch rows are outside per-project scope.

### Failure and edge-state contract

| Condition | Required result | Test owner |
| --- | --- | --- |
| Managed metadata missing or conflicting Run trailer | Commit aborts with actionable stderr; no partial stamp | real-Git provenance integration |
| Worktree hook/config installation fails | Launch compensates created branch/worktree and throws typed `MaisterError` | real-Git worktree integration |
| Reused/orphan worktree has missing or stale managed files | Idempotent repair before dispatch; shared-root metadata is not overwritten | launch/worktree integration |
| Node attempt pauses, fails, reworks, or throws | Node pointer clears in `finally`; later platform commit has no stale Node | graph integration |
| Open PR or unresolved squash merge | Provisional linkage only; shipped numerator excluded/insufficient | promotion + scanner integration |
| Scratch local merge or worktree-agent promotion | Kind-correct final evidence is persisted through the appropriate finalizer | promotion real-Git integration |
| Agent `none`/`repo_read` or project-less scratch | No per-project promotion evidence/numerator row; exclusion is explicit | promotion/query integration |
| Selected scratch/agent segment on a flow-ledger panel | Render flow-ledger-only not-applicable state, never flow values as selected-kind metrics | static markup + page contract |
| Budget event without a run ID | Retain it in `unattributed_legacy`; displayed buckets still reconcile | Testcontainers query integration |
| Fetch/provider/network transient failure | Project job fails/retries as `EXECUTOR_UNAVAILABLE`; prior cache preserved | scheduler Testcontainers integration |
| Missing origin/target | `PRECONDITION`; bounded failure/disable for that project only | scheduler seeded-repo integration |
| Malformed Git output or ambiguous attribution | `CONFIG`/`CONFLICT`; scan fails atomically and cache is preserved | parser + scanner integration |
| Archived/unarchived/deleted project | Disable/skip; idempotent re-enable/seed; cascade cleanup | scheduler lifecycle integration |
| No delivery in current UTC day | Persist explicit zero current-day bucket | scanner integration |

## 5. Data model (one migration)

Allocated after rebase onto local `main` (2026-07-12): ADR-134 and migration
`0098_observatory_agentization_provenance`. Preserve these identifiers unless a
new conflict is introduced before integration.

### `runs` additions

| Column | Type | Contract |
| --- | --- | --- |
| `promoted_head_sha` | `text NULL` | final delivery head; PR-open may hold provisional pushed head until scanner confirms/replaces target delivery |
| `merge_commit_sha` | `text NULL` | actual non-FF or provider-resolved PR merge commit only |
| `diff_stat` | `jsonb NULL` | exact `{files, additions, deletions}` target-delivery delta after D1 cleaning |

Add partial indexes on non-null `promoted_head_sha` and `merge_commit_sha` for lazy attribution joins.

### `repo_delivery_rollups`

| Column | Type | Contract |
| --- | --- | --- |
| `project_id` | FK -> `projects.id` CASCADE | project scope |
| `branch` | `text` | scanned target branch |
| `bucket_start` / `bucket_end` | `timestamptz` | UTC half-open day |
| `head_sha` | `text` | fetched `origin/<target>` head |
| `commits` / `merge_pr_units` | `integer >= 0` | denominator counts |
| `additions` / `deletions` | `bigint >= 0` | cleaned denominator lines |
| `delivery_refs` | `jsonb` | bounded repository attribution index with each commit's cleaned delta; never a run-derived numerator |
| `pr_attribution_complete` | `boolean` | whether provider PR denominator/linkage is complete |
| `fetched_at` | `timestamptz` | successful scan freshness |
| `created_at` / `updated_at` | `timestamptz` | row audit |

Unique key: `(project_id, branch, bucket_start, bucket_end)`. Indexes: `(project_id, branch, bucket_start)` and `(project_id, fetched_at)`.

The migration is additive and needs no data backfill. Pre-cutover runs stay null and therefore do not enter the numerator; repository denominators remain complete and early results are low-and-honest.

`run_cost_rollups` and `node_attempt_cost_rollups` deliberately receive no `run_kind` column: their immutable `run_id` relation is joined to `runs.run_kind` at read time. This keeps the one planned migration focused on delivery evidence/denominator storage and avoids a derived-column backfill.

## 6. Tasks

### Plan-wide TDD execution protocol

Every implementation task follows the same evidence loop:

1. Add the smallest owning test and run it to **RED** for the intended missing behavior, not for an import, fixture, environment, or typecheck accident.
2. Make the smallest production change that turns that test **GREEN**.
3. **REFACTOR** only after green: apply SOLID, KISS, and DRY; remove duplication and keep pure policy, Git I/O, DB transactions, provider reads, and UI rendering single-purpose; rerun the focused test.
4. Prove the test is discoverable with the owning Vitest project/`vitest list` (or Playwright list) rather than assuming a filename is included.
5. Finish each phase with its full affected unit/integration suite green. Never defer broken fixtures or contract drift to T15.

Test ownership is deliberately non-overlapping: pure unit tests own formulas/parsers/classification/trailer composition; real-Git integration owns hooks/config/amend/squash/merge/rebase/path cleaning; Testcontainers owns migration/transaction/scanner/job poison/wiring; static markup owns UI states and accessibility; Playwright owns one complete project-page path plus one read-only missing-data boundary. Do not add enum mirrors, constant-presence assertions, snapshot-only markup tests, or duplicate formula edge cases across layers.

### Phase 0 — Complete SDD and contracts before code

- [x] **T0.1 — Author the authoritative SDD specification.** Create `.ai-factory/specs/feature-observatory-agentization-provenance.md` before production code. Number every functional requirement, invariant, acceptance criterion, edge state, and failure outcome; define exact field/DTO shapes, nullability, canonical delivery-delta commands for each promotion mode, the complete excluded path/pattern set, UTC window boundaries, PR provisional/final transitions, shared-root ownership, scheduler lifecycle/error mapping, run-kind eligibility, the all/flow/scratch/agent scope matrix, cost/budget join and legacy-attribution semantics, and the test-owner matrix. Cross-link every AC to one primary test layer and this plan task.
  - Tests/gates: spec completeness grep/checklist; no unresolved `TBD`, owner-confirmation, alternative, or mode ambiguity; all locked D1-D9 decisions represented.
  - Logging: n/a (spec task).
  - Depends on: none.

- [x] **T0.2 — Reserve and write the ADR decision record.** Add ADR-134 plus its index row to `docs/decisions.md`. Record rationale and consequences for target-delivery math, trailer truthfulness, worktree isolation/repair, frozen exclusions, PR-created-vs-merged evidence, bounded delete/replace rollups, shared-root attribution, crash recovery, scheduler lifecycle, all-kinds numerator eligibility, join-not-denormalize cost attribution, and the read-only boundary. Keep detailed normative requirements in the SDD and mark code-dependent state `(Designed)`.
  - Tests/gates: `node scripts/validate-docs-adr-anchors.mjs`; every ADR link resolves; ADR and SDD decisions agree.
  - Logging: n/a (contract task).
  - Depends on: T0.1.

- [x] **T0.3 — Front-load analytics, schema, screen, and API contracts.** Update `docs/system-analytics/observatory.md`, `git-integration.md`, `workspaces.md`, `runs.md`, `scratch-runs.md`, `agents.md`, and canonical `scheduler.md`; update `docs/database-schema.md`, `docs/db/erd.md`, `runs-domain.md`, and `scheduler-domain.md`; add `docs/screens/observatory.md` and index it. Each analytics artifact follows R5 with entities, process/state flow, expectations, edge/failure states, and linked SDD/ADR/API/schema artifacts. Repair stale one-workspace-per-run prose and document the D7/D8 scope matrix, project-less scratch exclusion, no-cost-rollup-migration decision, and cost's stored/lifetime time scope.
  - API contract: update both GET and POST `/api/cron/tick` `jobKind` enums in `docs/api/web.openapi.yaml`; repair both `SchedulerTickSummary` enum arrays to the complete closed set including existing `auto_launch_triaged`, existing `auto_promote`, and new `repo_delivery_scan`; update admin-create prose to distinguish all system-managed/non-creatable kinds. Do not expose internal `project_id` in the public tick DTO.
  - Configuration audit: verify `docs/configuration.md` and `.env.example` need no new host setting; retain no-diff when the contract is already accurate.
  - Tests/gates: OpenAPI parses/resolves and semantically lints with the complete closed set; `pnpm validate:contracts`; Redocly lint; `CI=true pnpm validate:docs`; Mermaid, ADR anchors, and EN/RU contract labels green. Runtime GET/POST/admin RED -> GREEN ownership remains in T10 after scheduler code begins.
  - Logging: n/a (contract task).
  - Depends on: T0.2.

**Phase 0 exit:** authoritative SDD, ADR, OpenAPI, system analytics, schema, and screen contracts are mutually consistent, use `(Designed)` honestly, contain no unresolved decisions, and all contract/doc gates pass before production code starts.

### Phase 1 — Commit provenance foundation

- [x] **T1 — RED first: isolate pure provenance and delivery policy.** Create `web/lib/worktree-provenance-core.ts` for strict metadata validation and pure trailer parsing/composition; create `web/lib/worktree-provenance.ts` for managed-file/config I/O; create `web/lib/delivery-pathspec.ts` for the single frozen pathspec/predicate/reducer. Keep Git execution in `web/lib/worktree.ts`; no flag-driven multi-mode functions.
  - Tests: focused pure tests for newline/NUL refusal, convention-clean subject, missing-trailer fill, duplicate avoidance, conflicting Run rejection, optional Node, truthful taskless scratch/agent metadata omission, exact exclusion fixtures, rename `oldPath`, and binary zero-lines. No filesystem mocks and no version-field test.
  - Logging: pure modules log nothing; I/O module logs only structured lifecycle context.
  - Depends on: Phase 0.

- [x] **T2 — RED first: install isolated auto-stamp at worktree creation.** Extend `addWorktree` and all creation callers in `web/lib/worktree.ts`, `web/lib/services/runs.ts`, `web/lib/agents/launch.ts`, and `web/lib/scratch-runs/service.ts`. Enable `extensions.worktreeConfig`, atomically materialize portable `.maister-managed/hooks/prepare-commit-msg`, template, immutable metadata, and empty node pointer; chmod hook; set absolute `git config --worktree` keys; exclude managed files; compensate branch/worktree on any post-add failure. Cover flow, project scratch, and `agentWorkspace='worktree'` creation without assuming Task/Flow exists.
  - Tests: real linked-worktree fixtures prove distinct sibling config and untouched parent; foreign identity remains author; ordinary commit, `git commit -m`, `--no-verify`, and amend get/fill trailers; a scratch-worktree commit carries `Maister-Run-Id` and truthfully omits unavailable Task/Flow; a worktree-agent does the same; conflicting Run and missing metadata abort; install failure compensates.
  - Logging: INFO install success `{runId,worktreePath}`; DEBUG managed paths without message/body; ERROR compensation failure with repo/worktree/run context.
  - Depends on: T1.

- [x] **T2.1 — RED first: ensure/repair provenance on reuse and orphan claim.** Add an idempotent launch-time ensure seam for worktrees that skip `addWorktree()`. Validate managed hook/template/config/metadata before dispatch; restore missing managed artifacts atomically; reject conflicting root metadata; retain shared-root Run/Task/Flow when a sibling reuses the tree.
  - Tests: launch integration covers normal reuse, orphan claim, deleted hook repair, stale config repair, conflicting metadata failure, and two shared siblings without root overwrite.
  - Logging: INFO repair `{rootRunId,worktreePath,repairedFields}`; WARN drift detected; ERROR typed conflict without secrets or commit bodies.
  - Depends on: T2.

- [x] **T3 — RED first: scope current Node to one dispatch attempt.** Add validated atomic set/clear helpers and wrap every graph-node dispatch in `try/finally`: set immediately before dispatch, clear after success, pause, failure, rework, or exception. Keep `.maister/run.json` byte-compatible.
  - Tests: graph integration proves node A/B commits carry the correct Node once, pointer clears for every exit class, later snapshot/promotion commit has no stale Node, invalid/path-unsafe IDs fail fast, and the pointer remains git-excluded.
  - Logging: DEBUG set/clear `{runId,nodeId,path}`; ERROR actionable context without task prompt.
  - Depends on: T2.1.

- [x] **T4 — RED first: re-stamp every platform-mediated commit.** Thread provenance through `snapshotDirtyWorktree`, `squashRunBranch`, dirty resolution, and promotion. Compose snapshot/squash messages; replace local merge `--no-edit` with composed `-m`; retain PR-body Run ID; keep configured author identity. Correct rebase execution in the linked source worktree if the real-Git RED test reproduces branch locking.
  - Tests: real-Git integration owns flow/scratch/agent snapshot and merge stamping, squash tree preservation, amend, non-FF merge, rebase while source is linked, foreign identity, idempotent trailer fill, truthful taskless omission, and no stale Node. PR adapter test owns PR-body Run ID only.
  - Logging: INFO platform commit `{kind,runId,sha}`; DEBUG tree-preservation outcome; ERROR typed Git failure with branch/repo context.
  - Depends on: T1-T3.

**Phase 1 exit:** targeted tests are discoverable in the intended Vitest projects; focused RED evidence is recorded; web unit and integration suites are green after refactor.

### Phase 2 — Durable promotion evidence

- [x] **T5 — RED first: add the single additive migration and schema contracts.** Add nullable run SHA/stat columns, `repo_delivery_rollups`, checks/indexes/FK, and scheduler-kind type arrays in `web/lib/db/schema.ts`; generate one SQL/journal/snapshot migration triple. `diff_stat` is exactly `{files,additions,deletions}`; there is no backfill or destructive operation. Do not add `run_kind` to either cost-rollup table: D9 is a read-time join to `runs`.
  - Tests/gates: Testcontainers migration test owns fresh/existing DB upgrade, legacy nulls, exact JSON validation at the application boundary, non-negative rollup checks, unique bucket key, indexes, and project cascade. Confirm journal/snapshot integrity and audit the generated schema/migration diff for no cost-rollup `run_kind` column or backfill.
  - Logging: n/a (schema task).
  - Depends on: Phase 0.

- [x] **T6 — RED first: capture exact final target-delivery evidence for every eligible kind.** Refactor promotion Git effects to return typed `PromotionGitEvidence` and persist it through one shared evidence helper called by both finalizers: `promoteScratchRun()` and workspace promotion for flow/worktree-agent runs. Capture only after squash/rebase/target update: local merge compares merge SHA to first parent; rebase/FF compares commits introduced from pre-promotion target to final target; PR-open stores only provisional source linkage and leaves shipped `diff_stat`/merge SHA null. Scratch is local-merge-only; a worktree agent uses the workspace finalizer; `none`/`repo_read` agent sessions are explicit no-evidence exclusions. Failed, superseded, or unshipped paths leave final evidence null.
  - Tests: promote service/route plus real-repo integration own flow local merge/rebase/FF/provisional PR, scratch local merge, worktree-agent promotion, `none`/`repo_read` agent exclusion, failure, superseded claim, final SHA timing, and identical cleaned stats for lock/generated/vendor/rename/binary fixtures.
  - Logging: INFO finalize `{runId,runKind,mode,promotedHeadSha,mergeCommitSha,files,additions,deletions,evidenceState}`; never diff content.
  - Depends on: T4-T5.

- [x] **T7 — RED first: shared-root ownership and merge-crash recovery.** Store final evidence on one shared root run only, including its root `run_kind` for the agentization kind bucket; never redistribute a heterogeneous shared tree to sibling kinds. Close git-merge-before-DB-finalize recovery by locating the unique target delivery with the Run trailer before creating or binding another commit; retain the promotion-attempt token guard and fail ambiguity.
  - Tests: shared-tree integration owns one root stat/unit and kind bucket with null siblings; real-Git crash/retry owns one merge, stable recovered SHA, and `CONFLICT` for ambiguous marker history.
  - Logging: INFO shared-root attribution/recovered merge; WARN recovery attempt; ERROR ambiguity with repo/branch/run context.
  - Depends on: T6.

**Phase 2 exit:** migration, promotion, shared-tree, and crash-recovery tests are discoverable and green; final evidence semantics match SDD/API/schema docs.

### Phase 3 — Repository denominator scanner

- [x] **T8 — RED first: implement pure delivery-history parsing and a separate PR read adapter.** Create `web/lib/delivery-history-core.ts` for first-parent delivery parsing, time bucketing, trailers, cleaned numstat, and failure classification. Keep Git fetch/log execution in `web/lib/worktree.ts`. Add a read-only `PrHistoryAdapter` module instead of expanding the create/update `PrAdapter`; it resolves persisted PR numbers to actual merge evidence without subject guessing. The attribution index accepts Run markers from flow, scratch, and worktree-agent commits; missing Task/Flow never blocks truthful Run-based matching.
  - Tests: pure fixtures own direct/FF/non-FF/squash-like delivery deltas, UTC horizon edges, flow/scratch/agent Run trailers with optional Task/Flow, rename/binary/exclusion handling, malformed/truncated output, and typed classifications. Provider tests distinguish open/unavailable/merged and prove secret redaction.
  - Logging: DEBUG parsed commit/bucket counts; WARN provider attribution unavailable with redacted provider/repo; ERROR bounded fetch/log parse context.
  - Depends on: T1, T5.

- [x] **T9 — RED first: scan one project and atomically replace the cache.** Create `web/lib/scheduler/handlers/repo-delivery-scan.ts`. With injected `now`, derive server-side repo/branch, fetch and resolve only `refs/remotes/origin/<target>`, scan the 365-day horizon under bounded Git limits, and resolve PR evidence before one transaction. Delete-and-replace the complete project/branch horizon, write a zero current-day bucket, remove obsolete branch rows, and update proven PR final SHA/stat evidence for every eligible kind. Failure preserves prior rows/freshness; numerator is never cached and denominator remains kind-agnostic.
  - Tests: Testcontainers + bare-origin owns remote-newer-than-local truth, horizon cutoff, exact target, UTC buckets/trend refs, zero-day bucket, flow/scratch/agent Run-trailer attribution, PR finalization, idempotent rerun, force-push removal, branch change cleanup, failure preservation, and no local fallback.
  - Logging: INFO `{projectId,branch,headSha,buckets,commits,lines,fetchedAt}`; DEBUG bucket counts; WARN incomplete PR attribution; ERROR typed scan failure.
  - Depends on: T6, T8.

- [x] **T10 — RED first: register and lifecycle-manage one poison-safe job per project.** Add `repo_delivery_scan` to every closed-set fanout: schema/catalog/system-managed protections, budgets, default seed, every claim CTE CASE/VALUES arm, internal claimed `project_id`, dispatch, targets, admin filter/table/editor, and EN/RU labels. Archive disables/clean-skips; unarchive idempotently re-enables/seeds; branch change is handled by T9; delete cascades; native failure/backoff/maxFailures=3 and admin re-enable remain authoritative. Do not change the public scheduler summary DTO or add env/config.
  - Tests: catalog/jobs/targets/admin/component closure plus GET/POST tick filter and admin-create rejection; real tick integration owns seed -> claim -> dispatch -> rollup. A valid and bad repo prove later valid work continues, only bad job reaches disable, archive/unarchive/delete lifecycle works, and lease/idempotency holds.
  - Logging: existing public summary stays unchanged; handler logs project ID internally; no target JSON paths.
  - Depends on: T9 and Phase 0 OpenAPI contract.

**Phase 3 exit:** the real seed -> claim CTE -> dispatch -> fetch -> atomic rollup path is green, poison/lifecycle cases pass, and integration tests are listed by the integration project.

### Phase 4 — Project Observatory metrics and UI

- [x] **T11 — RED first: pure kind-aware agentization and autonomy-funnel rollups.** Create `web/lib/queries/observatory-agentization-core.ts` with strict DTOs, explicit `now`, daily exact-delta matching, distinct root attribution, honest insufficiency, volatility, funnel precedence, and `flow|scratch|agent` numerator buckets. `all` is the bucket sum; a selected kind filters only the eligible AI numerator while retaining the same kind-agnostic repository denominator. Attribute a shared tree to its root run kind only.
  - Tests: one pure dataset table owns all-kind and selected-kind line/delivery ratios, bucket-sum reconciliation, duplicate refs, zero/missing/low-N, open/unresolved/merged PR, daily trend boundary, shared root once, scratch local-merge inclusion, worktree-agent inclusion, active volatility, unrecorded launch/trigger, takeover precedence, platform-promotion throughput, and lane. Avoid repeating these formulas at component/E2E layers.
  - Logging: none (pure).
  - Depends on: T5-T10.

- [x] **T11.1 — RED first: make existing Observatory scope and cost/budget attribution kind-aware.** Add the validated `runKind=all|flow|scratch|agent` parser/current DTO in `web/lib/observatory/filters.ts`, then extend `ObservatoryFilters`, `getCostSummary`, `getBudgetSummary`, and their DTOs. Join `run_cost_rollups` and `node_attempt_cost_rollups` to `runs` for kind filters/buckets; join run-bound budget `domain_events` to `runs` and retain no-run events as `unattributed_legacy`. Do not add rollup columns or a migration. Implement the §3.7 scope matrix across project and portfolio reads: flow-ledger panels are flow-only/not-applicable under scratch/agent selection, while cost and budget honor the segment; the new all-run funnel stays project-only.
  - Tests: parser tests own absent/repeated/invalid -> `all`; Testcontainers query tests own flow/scratch/agent cost and budget splits, node-count filtering, selected-kind scope, legacy-unattributed reconciliation, project-less scratch exclusion, portfolio visibility, and unchanged fixed query count. Existing flow-ledger integration owns its unchanged flow-only results; do not duplicate ratio formulas from T11.
  - Logging: DEBUG one scope summary `{runKind,flowLedgerApplicable,costKindRows,budgetKindRows,unattributedBudgetEvents}`; no per-event logs.
  - Depends on: T5, T6, T10.

- [x] **T12 — RED first: fixed-count bulk project agentization query.** Create server-only `web/lib/queries/observatory-agentization.ts` and integrate the project-only panels with `getProjectObservatory`. Bulk read all project runs/workspace evidence, HITL IDs, human-review/takeover evidence, and cached rollups/delivery refs; apply the T11 kind policy and T11.1 validated segment. Never invoke scanner/Git/fetch/reconcile or mutate. Portfolio continues to omit agentization and the new funnel while its existing cost/budget reads honor T11.1.
  - Tests: Testcontainers owns equal SELECT count for 1 vs many runs and absolute `<=20`, project/window/current-branch visibility, all run kinds without node attempts, scratch numerator inclusion after a promoted evidence fixture, non-promotable/project-less exclusion, null as `unrecorded`, nonexistent repo rendering from cache, shared root once, and byte-for-byte unchanged rollup/freshness rows after read.
  - Logging: DEBUG one aggregate summary `{projectId,runKind,runCount,bucketCount,fetchedAt,availability}`; no per-run logs.
  - Depends on: T11, T11.1.

- [x] **T13 — RED first: render bilingual run-kind scope, existing panels, and project-only agentization.** Add `agentization-panel.tsx`, `autonomy-funnel-card.tsx`, and a small reusable kind-breakdown/scope-presenter; extend strict Observatory DTO/labels and `web/messages/{en,ru}.json`; wire the run-kind segment into both existing Observatory pages, while rendering agentization and the new all-run funnel only on the project page. Render raw values beside percentages, kind buckets, trend, `as of`, volatile, insufficient, unrecorded, stored-cost lifetime, and budget-unattributed states; label process panels `flow runs`, show their not-applicable state for scratch/agent, and label promotion as platform-promoted. Add no action/control/target copy.
  - Tests: focused `renderToStaticMarkup` owns complete/insufficient/missing-cache/volatile trend, selected-kind cost/budget/funnel/agentization states, flow-ledger-not-applicable state, accessibility, and RU rendering. Page-contract tests own query-param and flow/node drill-down `runKind` preservation on both pages, project-only agentization/funnel and portfolio absence, EN/RU parity, explicit scope labels, and static prohibition on scanner/Git imports. There is no undefined stale classification.
  - Logging: no client logs; server summaries are T11.1/T12.
  - Depends on: T12.

**Phase 4 exit:** pure rollup, kind-scope query, static component, and page-contract suites are green with explicit read-only, fixed-query, all-kinds attribution, and flow-ledger-boundary proofs.

### Phase 5 — Acceptance, as-built docs, and integration gate

- [x] **T14 — Seed two non-overlapping Playwright acceptance paths.** Extend the M23 Observatory seed and `web/e2e/m23-observatory.spec.ts` only. Path 1 proves a project scratch worktree local-merge fixture enters the scratch agentization bucket, then shows selected-kind cost/budget/funnel scope, headline/raw totals, freshness, trend, flow-ledger not-applicable behavior, and RU labels. Path 2 uses a missing/insufficient cached-data project with a nonexistent repo and proves read-only rendering without Git/fetch failure. Do not duplicate formula edge cases already owned by T11.
  - Tests/gates: list and run the affected Playwright project against the stub supervisor; kill shared ports 3100/7788 first and do not reuse another worktree’s infrastructure.
  - Logging: seed logs IDs/counts only; no secrets/diffs.
  - Depends on: T13.

- [ ] **T15 — Integration numbering audit, migrate dev DB, reconcile contracts, and run the final gate.** Reconfirm ADR-134 and migration `0098` are still free after the pre-development rebase; regenerate the migration snapshot/journal; update every citation if an intervening collision occurs; flip `(Designed)` to `(Implemented)` only where verified. After owner FF merge, migrate main and brain lineages (brain expected no-op). No `Co-Authored-By` trailer in the conventional integration commit.
  - Tests/gates: `git diff --check`; changed-file ESLint; typecheck; `pnpm validate:contracts`; Redocly; full web unit/integration; targeted real-Git/Testcontainers; listed seeded Playwright; `CI=true pnpm validate:docs`; ADR anchors; EN/RU parity. Audit one migration/ADR and no mutating route, env, engine, Flow DSL, policy, or portfolio agentization aggregation.
  - Logging: n/a; report the exact command/evidence for any environment-limited gate.
  - Depends on: all prior tasks.

  Branch-local implementation, migration-triple reconciliation, and all executable
  gates are complete. The post-FF migration on the primary `main` and Brain
  lineage is an owner integration operation and remains pending until the merge.

## 7. Commit plan

- **Commit 1 (T0.1-T0.3):** `docs(observatory): specify agentization and commit provenance`
- **Commit 2 (T1-T4, including T2.1):** `feat(git): stamp MAIster worktree commit provenance`
- **Commit 3 (T5-T7):** `feat(runs): persist promotion commit and diff evidence`
- **Commit 4 (T8-T10):** `feat(scheduler): cache repository delivery denominators`
- **Commit 5 (T11-T13, including T11.1):** `feat(observatory): add kind-scoped agentization and autonomy funnel`
- **Commit 6 (T14-T15):** `test(observatory): verify attribution metrics and integration gates`

Each checkpoint must leave its affected test projects green. Do not postpone stale assertion/fixture updates to the final commit.

## 8. Acceptance traceability

| Acceptance criterion | Owning tasks/tests |
| --- | --- |
| AC-P1: foreign-identity flow/scratch/worktree-agent commits, `-m`, `--no-verify`, and amend get truthful Run plus available Task/Flow trailers; conflicts fail and taskless values are not fabricated | T1 pure composition + T2 real-Git integration |
| AC-P2: config never leaks and creation/reuse/orphan repair preserves shared-root provenance | T2 creation integration + T2.1 launch integration |
| AC-P3: Node is correct per attempt and cleared for every exit; snapshot/squash/merge/rebase re-stamp once | T3 graph integration + T4 real-Git integration |
| AC-E1: flow local merge/rebase/FF/PR, scratch local merge, and worktree-agent promotion persist exact final SHA/stat; open/failed/superseded/non-worktree-agent remain non-shipped | T6 promotion real-Git + T9 PR finalization integration |
| AC-E2: shared delivery and merge-crash retry bind exactly one root/delivery and root kind | T7 shared/crash integration |
| AC-S1: only post-fetch `origin/<target>` and the frozen exact-delta cleaning feed the 365-day cache | T8 parser unit + T9 bare-origin integration |
| AC-S2: rerun/force-push/branch change atomically replace rows, zero-day is explicit, failure preserves cache | T9 Testcontainers/bare-origin integration |
| AC-S3: scheduler closed set, lifecycle, retry/disable/admin recovery, and cross-project poison isolation work end to end | T0.3 OpenAPI gates + T10 route/real-tick integration |
| AC-O1: project all-kinds and selected-kind lines %, delivery ratio, buckets, trend, freshness, honest-N, and volatile states are mathematically correct | T11 pure dataset table |
| AC-O2: all-run funnel uses unrecorded buckets and historical human evidence with takeover precedence | T11 pure dataset table + T12 population integration |
| AC-O3: cost/budget are kind-attributed with legacy budget reconciliation; project-less scratch is absent from per-project reads | T11.1 Testcontainers integration |
| AC-O4: project read path is fixed `<=20` SELECTs, cache-only, non-mutating, and agentization-absent from portfolio | T11.1/T12 Testcontainers + T13 page contract |
| AC-U1: every panel states its scope; complete, insufficient, selected-kind, and flow-ledger-not-applicable states render accessibly in EN/RU with no actions | T13 static markup + T14 two Playwright paths |
| AC-C1: SDD/ADR/OpenAPI/analytics/schema/docs agree; exactly one delivery-evidence migration and ADR, no cost-rollup migration/backfill, no env/engine/write-back | T0.1-T0.3 + T5 + T15 gates |

## 9. Risks and merge obligations

- **Taskless provenance:** scratch/standalone work has no truthful Task/Flow value. The locked contract stamps Run universally, stamps Task/Flow only when real, and admits project-scoped workspace-backed promoted kinds through Run-based attribution; tests prevent later fabrication.
- **Run-kind scope:** correction, Autonomy Score, signals, harness, artifacts, and node drill-down require the flow ledger. Scratch/agent selection must show their explicit not-applicable state, not a misleading zero or a hidden flow result.
- **Cost/budget history:** cost rollups cannot be window-bounded without a separate historical-cost design; copy must say stored/lifetime. Nullable `domain_events.run_id` requires the visible `unattributed_legacy` budget bucket until a separately approved backfill exists.
- **PR completion:** opening a PR is not target-branch delivery. PR work stays outside the shipped numerator until provider/repo evidence proves merge. Provider-unavailable PR ratios are insufficient, never guessed from commit subjects.
- **Squash PR denominator:** generic Git cannot prove that every one-parent commit came from a PR. `pr_attribution_complete` makes this visible and prevents a falsely precise secondary ratio.
- **Rebase in linked worktrees:** current parent-checkout rebase can fail because the source branch is already checked out in the run worktree. T4 includes the real-git RED proof and the minimal linked-worktree correction.
- **Merge/DB crash window:** the git merge precedes final DB evidence. T7 recovers by the run trailer and refuses ambiguity rather than binding to a later unrelated target HEAD.
- **Frozen exclusions:** v1 has one exact exclusion contract and no version column. Any later rule change requires a new decision plus an explicit migration/rescan strategy; silent drift is prohibited.
- **Bounded scan size:** 365-day traversal is still subject to existing hardened Git timeout/output limits. Overflow/truncation is a typed failed scan that preserves the prior cache, never a partial success.
- **Number collisions:** ADR-134/migration-0098 were allocated by the pre-development rebase. T15 rechecks them before integration, regenerates the snapshot, and validates anchors.
- **Shared E2E infrastructure:** ports 3100/7788 and `maister_e2e` are cross-worktree resources. Baseline and clean them before attributing failures to this branch.

## 10. Explicit non-goals

- Portfolio agentization aggregation.
- Retroactive attribution of pre-cutover MAIster runs.
- Task-type/label classification.
- Targets, benchmarking, recommendations, A/B experiments, policy enforcement, or ADR-041 changes.
- Promotion-state behavior changes, automatic PR merge, or a PR lifecycle UI.
- Shared-mode per-child line attribution.
- Per-node correction/harness/signals for scratch or agent, or an optional scratch Autonomy Score extension.
- Cost-rollup `run_kind` denormalization, historical-cost migration, or a backfill of legacy budget events.
- New public API/mutating route, host env, background process, port, sidecar, error code, Flow DSL field, or engine bump.
