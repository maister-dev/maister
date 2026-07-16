# Implementation Plan: Evaluation Lab

Branch: feature/evaluation-lab
Created: 2026-07-15

## ⏯️ RESUME POINTER (updated 2026-07-16 — read this first)

Progress markers use `[x]` done · `[~]` partial (see the task's inline note) ·
`[ ]` not started. This session ran M46 phase-gated; pick up at **NEXT** below.

**Owner-locked scope decisions (do not re-litigate):**
- ⚠️ SCOPE OVERRIDE (2026-07-16, owner via `/aif-implement all the plan`):
  implement **all phases 2–7 (M46 + M47 + M48)**, commit by phase, **stop
  before owner-gated steps** (live-deploy T5.4, `core/v1.1.0` tag, `git push`).
  This supersedes the "M46 only" line below.
- Target = **M46 only**, phase-gated; M47/M48 deferred. *(superseded above.)*
- **Lean Phase 0** — core contracts frozen in the ADR ledger; wider
  analytics/API/screens docs **co-evolve** with the code that implements them.
- **maister-plugins package is in scope** (method authored + committed there).
- Branch is held **LOCAL — do NOT push** until M46 is complete.
- On ADR/migration-number collision with sibling branch
  `claude/pr-merge-workflows-4d0e7e` (it also claims ADR-139/140 + migr 0104):
  **renumber** (owner preference), including the journal `when` bump.
- `core/v1.1.0` tag is **owner-gated** — do NOT create it.

**Committed & green so far:**
- Phase 0 `59f889230` — ADR-139..144 + migr 0104..0107 reserved; engine→3.2.0;
  roadmap M46/M47/M48; terminology. (T0.2/T0.3 `[~]` = co-evolve.)
- Phase 1 `630395ae2` + plugins `865db4a` — Evaluation Method contract
  (`web/lib/evaluations/method-schema.ts`+`method.ts`), `evaluationMethods[]`
  manifest, `validate:package-compatibility` gate, published `core:sdd-quality`.
- Phase 2 T2.1 **partial** `6f88dd5f2` — migration **0104** (studies/recipes/
  participants) + 7 real-PG integration tests green.

**▶ NEXT (resume here): PHASE 3 + PHASE 4 COMPLETE; PHASE 5 IN PROGRESS.** Done this
session: (1) T4.1 agent-launch seam `60c3f1d79` — token scopes + evaluator MCP facade +
ext routes + OpenAPI + facade readers + seal + launch/provisioning + aggregation worker
making FSM `judging→aggregating→terminal` LIVE (7-test `judge-seam.integration.test.ts`).
(2) T2.2/T4.3 co-evolve session-auth route surface `5b4d386b9` —
`/api/projects/[slug]/evaluations/*` study CRUD (list/create/get/patch If-Match) +
participants (add-observed/list/remove) + verdicts (record/list, human-only, zero-citation
ack) + review resolve (If-Match) over built services (+ new readers `listStudies`/
`getStudyForProject`/`listParticipants`/`getReviewForProject` + `study-dtos.ts`); 6-test
`routes.integration.test.ts` (RBAC 403 / stale 409 / missing-If-Match 422 / cross-project
404). **NEXT ORDER (still Phase 5):** T3.3 `evaluation_dispatch` scheduler arm +
execution-start service (create execution + `resolveEffectiveProfile` snapshot + drive
queued→capturing→checking→judging→`launchJudgePanel`) + immediate kick + `GET
.../{studyId}/stream` SSE route + poison/backoff → T2.3 capture pipeline + evidence routes +
GC → T5.1 admin Evaluations settings UI → T5.2 full-page creation + N-way Study Lab (over
the routes just landed) + production judge token→MCP materialization → T5.3 E2E → T5.4
owner-gated deploy (SKIP) → **Phase 6** (M47) → **Phase 7** (M48). Remaining CO-EVOLVE
debts: T2.2 legacy `/experiments` adapters; T3.1 OpenAPI + route-authz E2E; T3.2 live
ObjectiveFactSource reader + distribution UI; T4.1 supervisor MCP materialization of the
judge token + bounded-repair child spawn.

**DONE this session (all green, committed on feature/evaluation-lab):**
Phase 2 COMPLETE — T2.1 `888835b7c`, T2.2 `1f6f5b7ac`+`c06895b59`, T2.3 `9ae4a0775`.
**Phase 3 COMPLETE** — T3.1 `073f5a371`+`fd6b330f3`; T3.2 core `a757b42d6`; T3.3 core
`82b2de8c5`. **Phase 4 (partial):** T4.2 aggregation/disagreement/persist `c3edff720`;
T4.3 verdict/review services `f29852882`; T4.1 pure cores (result-validation + blinding)
`e2025c0b9`. **Phase 3+4 slice green together: 123 eval tests (16 files).** CO-EVOLVE
debts (land with Phase 5 unless noted): T2.3 capture pipeline + evidence routes + GC;
T2.2 HTTP routes + legacy `/experiments` adapters; T3.1 OpenAPI + route-authz E2E;
T3.2 live ObjectiveFactSource reader wiring + distribution UI; T3.3 `evaluation_dispatch`
scheduler job-kind arm (enum+budget+CTE+tick handler) + immediate kick + `GET
.../{studyId}/stream` SSE route + poison/backoff; T4.2 real judge-attempt→AttemptResult
adapter + aggregation worker handler; T4.3 human-session verdict/review routes; **T4.1
agent-launch/token/MCP-facade seam (do FIRST next session — it unblocks the live judging
path).**

**T2.1 DONE (this session):** migrations `0105` (config: method_revisions /
judge_panels / profiles / project_profile_overrides), `0106` (execution +
evidence: 11 tables; `executions.method_revision_id` nullable for legacy;
`studies.legacy_snapshot` added), `0107` (retained idempotent parity-asserting
`evaluation_backfill_from_experiments()` — lossless 0090→010x). 15 schema tables
+ types in `web/lib/evaluations/types.ts`; 10-test backfill integration +
existing 7-test schema integration green; journal-integrity + drift-check green;
`validate:docs:all` green; DB docs + `docs/db/evaluations-domain.md` ERD added.
Migration numbering finalized: `0104` studies, `0105` config, `0106`
exec/evidence, `0107` legacy backfill, `0108` verdict-activity (T4.3),
**`0109` reserved** for the deferred legacy-contract drop.

**Env & commands (verified this session):**
- Engine constant is `3.2.0` (`web/lib/flows/engine-version.ts`).
- Generate a migration: `DB_URL=postgresql://maister:maister@localhost:5432/maister pnpm db:generate` (from `web/`).
- Docker PG `maister-postgres-1` (pgvector pg16) is up on `localhost:5432`.
- Run unit tests **sharded** — `npx vitest run --project unit --shard=n/4` (the
  full one-process run OOMs on a **pre-existing** runaway test file in shard 3,
  even at 12 GB; not ours — quarantine candidate). Integration:
  `npx vitest run --project integration <file>`.
- Lint changed files with `npx eslint --fix <files>` — never bare `pnpm lint`
  (it reformats the whole repo). `scripts/**` is eslint-ignored.
- Pre-existing baseline typecheck error: `lib/theme.tsx:85` `cookieStore` — not ours.

Full detail + gotchas: memory `evaluation-lab-m46-impl-state`.

## Settings

- Testing: yes — SDD first, then RED → GREEN → REFACTOR for every implementation slice.
- Logging: verbose — structured DEBUG at orchestration boundaries, INFO for durable lifecycle changes, WARN for degraded/partial behavior, ERROR for terminal failures; never log prompts, source, evidence bodies, secrets, private paths, adapter environment, or judge rationales.
- Docs: yes — Phase 0 is a mandatory specification freeze; every later phase has an as-built consistency checkpoint.

## Roadmap Linkage

Milestone: "M45. Core-package process qualification on private projects" (nearest current milestone), followed by a new Evaluation Lab milestone family created in Phase 0.

Rationale: M45 needs reproducible process qualification, but the requested Evaluation Lab is a broader platform capability. Phase 0 must add M46 Evaluation Foundation, M47 Controlled Evaluation Expansion, and M48 Advanced Evaluation without rewriting M45 as if the broader product already exists.

## Goal

Evolve the implemented task-bound Experiment Comparison Studio into a project-level Evaluation Lab that:

1. compares 2..N existing or newly launched Runs for one task without changing the semantics of observed Runs;
2. freezes private, bounded, reproducible evidence;
3. runs package-sourced, versioned evaluation methods through independently configured judge panels;
4. keeps objective facts separate from AI opinions;
5. supports partial, failed, crashed, abandoned, and active Runs honestly;
6. preserves the existing trust, package, runner, execution-policy, no-auto-promotion, and human-verdict boundaries.

This plan covers the complete target architecture, but deliberately slices delivery into independently deployable milestones. M46 is the first implementation slice; M47 and M48 consume the contracts frozen in Phase 0.

## Milestone Slicing

| Milestone | Scope | Exit value |
| --- | --- | --- |
| M46 — Evaluation Foundation | Unified Study model; legacy Experiment migration; observed Runs; existing controlled-launch compatibility; N-way overview; package-sourced Evaluation Methods; platform Methodologies/Panels/Profiles; immutable evidence; objective checks; multi-judge execution; aggregation, disagreement, and human verdict | MAIster can compare existing and legacy launched Runs reproducibly with one migrated default SDD method and multiple independent judges |
| M47 — Controlled Evaluation Expansion | Alternative compatible Flows/package revisions; slot-keyed agent/runner/model bindings; capability/MCP/materialization preflight; explicit supervised/assisted/unattended-within-policy recipes; durable batch launch intents; hybrid observed + launched Studies | A user can launch reproducible, graph-aware controlled variants without conflating participant provenance or weakening promotion/trust rules |
| M48 — Advanced Evaluation | Pairwise and tournament methods; scheduled suites; package-upgrade regression studies; calibration/longitudinal analytics; optional human-approved standardization of a winning execution recipe | Evaluation becomes a reusable qualification/regression system; no automatic winner promotion is introduced |

## Repo-Grounded Current-State Inventory

| Area | Implemented today | Gap the plan must close |
| --- | --- | --- |
| Experiment persistence | Migration 0090; experiments and experiment_runs in web/lib/db/schema.ts; immutable base/variants/rubric; JSON verdict | No neutral Study participant model, normalized evaluation records, immutable evidence snapshots, or multiple methods/panels |
| Membership semantics | web/lib/experiments/membership.ts; membership drives relaunch inheritance, auto-promotion and auto-delivery exclusions, and workspace retention | An observed Run cannot safely be inserted into experiment_runs because selection would retroactively change execution behavior |
| Launch | web/lib/experiments/launch.ts validates a requested batch, then sequentially calls the standard run launcher; membership is written with the Run | No durable launch-batch intent; later failures can leave a partial batch; runnerId affects only the primary session |
| Graph execution | Stable session/consensus slot keys; per-project bindings; run_sessions is the sole run-to-runner source; engine 3.1.0 | A controlled recipe cannot yet override every graph slot or express an alternative Flow/input contract |
| Evidence | Capped mutable diff snapshot, file summary, materialization delta; live gates, sessions, and token rollups | Later Run progress/config changes can change a comparison; no digest, coverage, redaction, capture failure, or bounded evaluator retrieval |
| Judge | Hardcoded core:experiment-judge launched as an ordinary agent; experiment_get and experiment_advise; advisory data in verdict.judgeAdvisories[] | No method/profile snapshot, attempt lifecycle, strict schema validation, quorum, sealing, blinding, retry, disagreement, or normalized results |
| Verdict | Human-only conclusion from comparable; writes verdict + activity transactionally | Verdict is coupled to settlement of all member Runs and cannot cite multiple immutable evaluation executions |
| Metrics | Status, gates, diff/file summary, token rollups; latest replicate is prominent; no fabricated dollar zero | No failure-stage taxonomy, process metrics, replicate distributions, cost-to-success, or pricing provenance |
| Package system | Strict maister-package.yaml parser; content-addressed immutable installs; trust and attachment; local fork/edit/cut; package-scoped tags | No portable Evaluation Method entity or method compatibility/release gate |
| UI | /projects/{slug}/experiments list and lab; large create modal; pairwise Diff is primary; EN/RU exists | No guided full-page creation, observed Run picker, N-way scoreboard/heatmaps, settings surface, progress stream, or contextual entry points |
| APIs/events | Internal experiment CRUD-like actions, external experiment_get/advise, no experiment-specific SSE | No pagination/idempotency/optimistic concurrency; no evidence/evaluation/config APIs; no durable evaluation event/recovery loop |
| RBAC | readExperiments(viewer), manageExperiments(member), concludeExperiments(member) | Permissions are too coarse for private evidence, unattended launch, judge execution, disagreement resolution, and platform configuration |

### Existing invariants that must survive

- run_sessions remains the sole source of runner/model/session truth; do not reintroduce runner columns on runs.
- Existing controlled Experiment Runs remain no-auto-promotion/no-auto-delivery unless a future explicit human-approved contract replaces the hold.
- Human verdicts are conclusive; judges never conclude, promote, abandon, relaunch, or overwrite a human decision.
- Package content is parsed inertly before trust, but no prompt, check, hook, setup script, or other package content executes before trust and compatibility approval.
- Missing cost, objective checks, evidence, or prices remain missing with a reason; never convert absence to zero or PASS.
- No client/body field may supply a private filesystem path, supervisor session id, adapter argv/env, credential, or server-derivable cross-resource locator.
- Existing status and recovery predicates remain allow-lists. The first two milestones add no runs.status value.


## Locked Architecture Decisions

### D1. Name and ownership

The product domain is Evaluation Lab. Its durable container is Evaluation Study; runtime work is an Evaluation Execution; portable package content is an Evaluation Method; mutable operator configuration is a Judge Panel and Evaluation Profile. The word Experiment remains only for the compatibility route and controlled-launch lineage.

### D2. Project/task boundary

M46–M48 constrain one Study to exactly one project and one task. evaluation_studies carries both keys and every participant is server-validated against them. The schema and APIs use explicit project_id/task_id rather than embedding them in evidence JSON, leaving a later cross-task benchmark suite as a parent entity rather than weakening the first Study boundary.

### D3. Participant provenance

evaluation_participants is a new relation with source_type observed | launched.

- observed: selected existing Run; may appear in multiple Studies; never gains Experiment launch semantics, retention holds, relaunch inheritance, delivery holds, or promotion exclusion.
- launched: created from a Study recipe; carries one owning launch lineage, replicate group/ordinal, launch reason, and an explicit evaluation promotion hold.
- run_id/source_type/launch_lineage are immutable. Replacement means adding another participant and tombstoning the old one.
- label and display order may change while no evaluation is using an unsealed draft; every Evaluation Execution snapshots them.
- once referenced by a sealed evidence snapshot, removal is a tombstone; history remains queryable.

### D4. Study and evaluation lifecycles are separate

A Study does not become comparable merely because all Runs settle. Persisted Study status is only draft | open | decided | archived. Readiness (at least two eligible participants) and active-evaluation count are derived facets, so concurrent Evaluation Executions cannot race a lossy Study-level Evaluating/Ready flip. An Evaluation Execution always runs over a sealed evidence snapshot frozen at a Run/event watermark — newly captured or attached by digest match (D5); active Runs are allowed with explicit incomplete coverage.

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Open: first participant
    Open --> Open: add/remove participant or run one or more evaluations
    Open --> Decided: human verdict cites terminal evaluation
    Draft --> Archived
    Open --> Archived
    Decided --> Archived
    Archived --> [*]
```

Evaluation Execution lifecycle:

```mermaid
stateDiagram-v2
    [*] --> Queued
    Queued --> Capturing
    Queued --> Cancelling
    Capturing --> Checking: immutable snapshot sealed
    Capturing --> Failed: required capture impossible
    Capturing --> Cancelling
    Checking --> Judging: objective policy permits panel
    Checking --> Partial: required check unavailable and policy permits partial
    Checking --> Failed: required check failed to execute and policy blocks
    Checking --> Cancelling
    Judging --> Aggregating: quorum or terminal panel
    Judging --> Cancelling
    Cancelling --> Cancelled
    Aggregating --> ReviewRequired: disagreement/escalation rule
    Aggregating --> Completed: aggregation valid
    Aggregating --> Partial: quorum/missing evidence policy permits partial
    ReviewRequired --> Completed: human review resolved
    ReviewRequired --> Partial: human accepts unresolved limitations
    Failed --> [*]
    Partial --> [*]
    Completed --> [*]
    Cancelled --> [*]
```

The evaluation worker uses exact allow-list transitions and CAS/version guards. Every waiting state has an emitter and recovery predicate. Failed, Partial, Completed, and Cancelled are terminal for the row; an explicit retry never re-enters a terminal row — it creates a new execution with retry_of lineage starting at Queued. Aggregating is a short computational state and is not cancellable; a cancel request against Aggregating or a terminal state is an idempotent no-op finalized at the next transition.

### D5. Snapshot semantics

Starting an Evaluation Execution either seals a new immutable evidence snapshot or attaches an existing sealed snapshot whose participant set and evidence-protocol digest match the execution’s method/profile requirements. A sealed snapshot may serve multiple Evaluation Executions — this is how different compatible methods compare over identical evidence. A separate “Freeze current evidence” action may prepare and seal a snapshot before judge launch. Later Run progress never mutates a sealed snapshot; users start a new Evaluation Execution with a new snapshot to include later evidence. Deleting a sealed snapshot is reference-guarded by every citing execution and by verdict/review retention. A human verdict may cite Completed or terminal Partial executions only and must acknowledge comparability warnings for Partial; citing zero executions is allowed only with the explicit no-evaluation-evidence acknowledgement (D14).

### D6. Package entity

Add optional evaluationMethods entries to maister-package.yaml:

```yaml
schemaVersion: 1
name: core
evaluationMethods:
  - id: sdd-quality
    path: evaluation-methods/sdd-quality
```

Each path contains evaluation-method.yaml plus referenced prompt/schema assets. The platform type is EvaluationMethodRevision, qualified as packageName:methodId. Its immutable version is the containing package install versionLabel + resolvedRevision/content digest; a second method-local version field is forbidden to prevent version skew.

Method schemaVersion starts at 1 and declares:

- id/name/description/applicability and absolute | n_way modes in M46;
- ground-truth and evidence protocols with capture budgets and required coverage classes;
- objective check references from a closed host registry;
- criteria/subcriteria, anchors, scale, weights, optional/NA policy, bonuses, penalties, item/total caps;
- logical judge roles and requirements, prompt templates, strict result JSON Schema;
- aggregation algorithm ID/version from a closed registry and permitted parameters;
- quorum, invalid-output, missing-judge, timeout, retry, disagreement, escalation, and report-view metadata;
- compat.engine_min/engine_max.

M46 bumps MAISTER_ENGINE_VERSION from 3.1.0 to 3.2.0. Old packages parse as evaluationMethods: []; an engine that does not know evaluationMethods rejects the newer package loudly rather than silently discarding the entity. New MAIster reports a typed incompatible/degraded reason when the method schema/engine range is unsupported.

### D7. Trust separation

Package fetch/install, trust, and execution remain physically separate:

1. install/cut copies and parses inert YAML/assets;
2. trust and compatibility are persisted;
3. method projection may be enabled;
4. only an enabled trusted compatible method may drive capture, prompts, objective checks, or aggregation.

Package methods never contain credentials, concrete runner IDs, host model IDs, secret values, or executable aggregation/check scripts. Method objective checks and aggregators resolve only through closed platform registries.

### D8. Platform configuration

- Methodologies: immutable package-derived method revisions plus mutable activation state enabled | disabled; derived health ready | degraded | incompatible. Local working copies show draft | invalid but are never selectable.
- Judge Panel: mutable admin configuration with optimistic revision. It maps logical roles to package-qualified platform agents only in M46 (project-linked agent bindings are deferred; if introduced later they carry an owning-project scope rule and refuse resolution outside it), runner/model intent, independent attempt count, max parallel attempts (hard-capped at MAISTER_MAX_CONCURRENT_AGENTS − 1 so one agent slot always stays free), quorum, timeout, bounded retry, token/cost budgets, blind labels, randomized order, allowed read-only MCPs, and poison-judge policy.
- Evaluation Profile: mutable admin configuration combining one method revision, one panel, defaults, hard limits, and an explicit allow-list of project/study overrides.
- Project override: optional saved values, project-admin managed, constrained by the Profile allow-list.

Resolution precedence is method hard constraints → platform Profile hard bounds → current Panel binding → saved project override → per-Study allowed override. The complete effective profile, resolved agents, package revisions, runner snapshots, model identifiers, MCP allow-list, prompt/schema digests, and randomization seed are snapshotted when the Evaluation Execution starts.

### D9. Evidence storage

Evidence metadata is normalized in Postgres; immutable payloads are content-addressed under a new host root MAISTER_EVALUATION_EVIDENCE_ROOT (default ~/.maister/evaluations). Writes use tmp + fsync/close + rename before the DB seal transaction. Crash before DB seal leaves an orphan blob eligible for GC; DB never points at an absent unsealed blob. Deletion is preserve-then-prune and audited.

The capture service builds a bounded manifest, not an unbounded repository prompt:

```mermaid
flowchart LR
    Request["Evaluation requested"] --> Watermark["Lock participants and record Run/event watermarks"]
    Watermark --> Capture["Capture task, provenance, artifacts, facts, source manifest, bounded diffs/chunks"]
    Capture --> Redact["Classify, redact, truncate, hash"]
    Redact --> Coverage["Compute per-participant coverage and comparability warnings"]
    Coverage --> Seal["Atomic DB seal: manifest digest + immutable item rows"]
    Seal --> Checks["Run closed-registry objective checks"]
    Checks --> Judges["Attempt-bound API/MCP retrieval of same snapshot"]
```

Capture is commit-anchored: each participant’s branch tip SHA is resolved at the watermark and all source/diff evidence reads git objects at that SHA — never a live worktree scan. Run logs and run.events.jsonl are append-only and are captured up to the watermark offset. Uncommitted working-tree changes of an active Run are not captured and are recorded as coverage class uncommitted_not_captured; the existing workbench snapshot-commit remains an explicit user action for non-active Runs.

Each item records kind, participant, logical locator, digest, bytes, capture time, source watermark, inclusion reason, coverage class, truncation, redaction decision, retention, and provenance. Public DTOs expose opaque item IDs and logical labels only.

### D10. Bounded retrieval

Judge agents run workspace:none and receive an attempt-bound token. They cannot browse a project/worktree. The evaluator facade provides:

- evaluation_context_get — server-derived attempt, method, blind labels, prompt and manifest summary;
- evaluation_evidence_list — cursor-paginated metadata for the bound snapshot;
- evaluation_evidence_read — bound item ID with server-capped offset/length;
- evaluation_objective_results — structured facts for the bound execution;
- evaluation_result_submit — strict result body; attempt/evaluation/judge attribution is server-derived.

No tool accepts a project path, worktree path, supervisor ID, study ID, run ID, judge run ID, method ID, or evidence snapshot ID when the token already binds it.

### D11. Objective facts

Objective checks use statuses queued | running | passed | failed | error | cancelled | not_run | unavailable. Nonterminal/absence statuses require a reason. A method must declare whether a check gates judging, supplies a metric, caps/overrides a criterion, leaves it unscored, or permits a partial evaluation. Judges may reference objective facts but may not infer PASS from source appearance.

M46 providers are closed and non-executable from package content: recorded gate/artifact result, schema/contract validation, source/diff manifest statistics, and operator-configured trusted check profiles. Build/test/lint commands are allowed only through a pre-registered host check profile whose command and sandbox are platform-owned.

### D12. Judge independence and attribution

Each independent attempt launches a separate agent Run and dedicated token. Attempts consume the shared MAISTER_MAX_CONCURRENT_AGENTS budget and queue as Pending like any agent Run; the attempt timeout clock starts when the session reaches Running, never at enqueue, and queue wait is metered as a separate interval. A dedicated judge concurrency budget is a known ops escape hatch, not part of M46. Results remain sealed from other judges and from subsequent prompt assembly until quorum or terminal panel state. Blind labels and deterministic randomized order are snapshot fields. Server records agent definition/package revision, agent Run, run_sessions runner/model provenance, token, prompt/result schema digest, evidence snapshot, timing, tokens/cost, retries, and result digest.

Invalid output creates a terminal invalid attempt and may create a bounded repair child attempt. Missing criteria never become zero. Criterion states are scored | insufficient_evidence | not_applicable with nullable score, rationale, confidence, typed evidence references, and objective-result references.

### D13. Aggregation and disagreement

M46 registry: weighted_mean@1, median@1, majority@1. M48 adds pairwise_tournament@1. Aggregation persists exact included attempt IDs, unrounded calculations, display rounding, excluded attempts and reasons, caps, optional/NA normalization, quorum decision, and method/result-schema/algorithm digests.

One Evaluation Execution has exactly one method. Results from incompatible methods are shown side by side and are never collapsed into a universal score. A future cross-method decision policy must itself be explicit, versioned, and auditable.

A Study may run multiple Evaluation Executions, including different compatible Methods over the same participant set; such executions may attach the same sealed evidence snapshot (digest-matched) so their outputs are compared over identical evidence. Each Execution remains independently versioned, attributed, and reproducible; the Study UI compares their outputs without merging their scales.

Disagreement considers score spread, confidence spread, rationale conflict flags, objective contradiction, insufficient-evidence asymmetry, and panel completeness. Low disagreement is not labeled high confidence.

### D14. Human decision

evaluation_human_verdicts is append-only. A project member records winner | tie | inconclusive against explicit participant and terminal Evaluation Execution IDs. A verdict may cite zero Evaluation Executions only with an explicit persisted no-evaluation-evidence acknowledgement — absence of evaluation stays explicit, never implied. A later human correction creates a superseding row with reason; judge code cannot write or supersede one. Verdict does not mutate Run status, promote a winner, or abandon participants. Only the legacy conclude adapter preserves abandonLosers, on the legacy route alone; in the canonical model, stopping losing launched participants uses the existing per-run workbench stop/archive/drop actions, and observed participants are never stoppable through a Study.

### D15. Interaction policy

Reuse ExecutionPolicy as the source of truth:

- supervised;
- assisted;
- unattended, labeled “Unattended within policy” in Evaluation Lab.

Do not add an askQuestions boolean. The recipe preview expands permissions, humanGate, onStuck, checks, promotion, budget, and no-blind-ship behavior. Flow-declared form/human nodes still create HITL unless an existing policy axis explicitly and safely handles them. Every launched Evaluation participant receives an immutable promotionHold with source evaluation_study; even unattended-within-policy cannot auto-promote.

### D16. Controlled Recipe contract and alternative Flow compatibility

An immutable Evaluation Recipe version contains:

- flow: flowRefId, flowRevisionId, packageInstallId/version/revision provenance, input-contract digest, output/artifact-contract digest;
- inputs: task snapshot reference plus form/input values validated against the selected Flow; M47 permits no arbitrary transform script;
- nodeAgentBindings: optional nodeId → package-qualified agent definition binding, kept distinct from host runner resolution;
- slotBindings: every stable session/consensus slot key → concrete runner override or typed runner intent, including capability agent, model/provider/effort requirements; resolution persists the actual run_sessions snapshot and any permitted soft mismatch;
- executionPolicy: the existing full supervised | assisted | unattended policy and bounded overrides;
- capabilityOverlay: typed add/remove refs for rules, skills, MCPs, and subagents, validated against the selected revision/project catalogs;
- budgets: token/cost/time/retry bounds using existing execution-policy/budget contracts;
- materializationIntent: package pins/version choices, capability/MCP requirements, and allowed project overlays; no path, credential, environment value, or executable hook;
- replicatePolicy: group key and requested count; each launched participant stores its ordinal and recipe digest;
- forced promotionHold: evaluation_study, which cannot be removed by a recipe.

M47 permits an alternative Flow only after preflight proves:

- same project/task ownership;
- input/form_schema compatibility or an explicit deterministic mapping;
- required task fields and acceptance criteria are representable;
- produced/required artifact contract covers the selected method evidence requirements;
- every runner/session/consensus slot resolves;
- package/trust/engine compatibility and materialization succeed;
- no strict capability silently degrades.

The first M47 scope allows exact compatible contracts only. Arbitrary mappings, cross-task datasets, and silent schema coercion are non-goals.

### D17. Durable dispatch

Evaluation start and controlled fan-out persist intent before side effects. After commit, an immediate in-process kick uses the same handler as the M24 scheduler/domain-event backstop. Client progress is delivered by replayable Study SSE, never client polling as the primary lifecycle mechanism.

Workers use durable per-item attempt markers, bounded retries/backoff, a rotating keyset cursor or equivalent progress guarantee, and poison-item terminalization. Every new dispatcher arm gets a real claim→dispatch wiring test.

### D18. Cost

Token classes and by-runner/model breakdown use existing run_sessions and cost rollups. Monetary cost is absent/unavailable until a versioned pricing catalog exists; the UI never renders a fabricated 0 currency value.

## Proposed Data Model

```mermaid
erDiagram
    EVALUATION_STUDIES ||--o{ EVALUATION_RECIPES : defines
    EVALUATION_STUDIES ||--o{ EVALUATION_PARTICIPANTS : contains
    EVALUATION_STUDIES ||--o{ EVALUATION_EXECUTIONS : runs
    EVALUATION_STUDIES ||--o{ EVALUATION_HUMAN_VERDICTS : decides
    RUNS o|--o{ EVALUATION_PARTICIPANTS : sources
    EVALUATION_RECIPES o|--o{ EVALUATION_PARTICIPANTS : launches
    PACKAGE_INSTALLS ||--o{ EVALUATION_METHOD_REVISIONS : projects
    EVALUATION_METHOD_REVISIONS ||--o{ EVALUATION_PROFILES : selected_by
    EVALUATION_JUDGE_PANELS ||--o{ EVALUATION_PROFILES : binds
    EVALUATION_PROFILES ||--o{ EVALUATION_PROJECT_PROFILE_OVERRIDES : constrains
    EVALUATION_STUDIES ||--o{ EVALUATION_EVIDENCE_SNAPSHOTS : prepares
    EVALUATION_EVIDENCE_SNAPSHOTS o|--o{ EVALUATION_EXECUTIONS : attached_to
    EVALUATION_EVIDENCE_SNAPSHOTS ||--o{ EVALUATION_EVIDENCE_ITEMS : indexes
    EVALUATION_EXECUTIONS ||--o{ EVALUATION_OBJECTIVE_CHECK_RUNS : checks
    EVALUATION_EXECUTIONS ||--o{ EVALUATION_METRIC_RESULTS : measures
    EVALUATION_EXECUTIONS ||--o{ EVALUATION_JUDGE_ATTEMPTS : dispatches
    EVALUATION_JUDGE_ATTEMPTS ||--o{ EVALUATION_CRITERION_RESULTS : scores
    EVALUATION_EXECUTIONS ||--o{ EVALUATION_AGGREGATE_RESULTS : aggregates
    EVALUATION_EXECUTIONS ||--o{ EVALUATION_REVIEWS : escalates
    EVALUATION_STUDIES ||--o{ EVALUATION_EVENTS : streams
```

### Tables and constraints

| Table | Required fields / constraints | Delete and retention behavior |
| --- | --- | --- |
| evaluation_studies | id, project_id, task_id, title, purpose, status draft/open/decided/archived, version, created_by, timestamps, optional legacy_experiment_id UNIQUE; project/task ownership constraint checked by service; readiness/active evaluation count derived | Project CASCADE; task RESTRICT while Study exists; archive before explicit Study deletion |
| evaluation_recipes | study_id, key, label, immutable definition JSON, definition_digest, flow/package refs, replicate_group, version; UNIQUE(study_id,key) | Tombstone after first launch; never rewrite a launched definition |
| evaluation_participants | study_id, nullable run_id FK SET NULL, source_type, recipe_id, label/order, replicate_group/ordinal, launch_reason, run_identity/provenance snapshot, joined/frozen/removed times; UNIQUE(study_id,run_id) for live refs; launched owner uniqueness | Observed has no workspace hold; launched retains explicit policy hold; snapshot history survives Run deletion through copied identity/provenance |
| evaluation_method_revisions | package_install_id, method_id, qualified_id, schema_version, normalized_definition, definition/prompt/schema digests, compat, activation, validation errors; UNIQUE(package_install_id,method_id) | Package install delete is usage-guarded while referenced |
| evaluation_judge_panels | id, name, revision, role bindings JSON, attempts/quorum/timeout/retry/budgets/blinding/order/MCP/failure policies, enabled, created/updated actor | Usage-guarded delete; historical executions use snapshots |
| evaluation_profiles | id, method_revision_id, panel_id, revision, defaults, hard_limits, allowed_overrides, enabled | Usage-guarded delete; historical executions use snapshots |
| evaluation_project_profile_overrides | project_id, profile_id, revision, overrides, updated_by; UNIQUE(project_id,profile_id) | Project CASCADE; SET/CLEAR/re-set symmetry tested |
| evaluation_evidence_snapshots | study_id, status, participant/run watermarks, evidence-protocol digest, manifest_digest, coverage summary, warnings, storage generation, sealed_at, prepared_by, retention/deletion markers; a sealed snapshot may be attached to multiple Evaluation Executions | A prepared snapshot may exist before an Execution and is attachable to one or more Executions only when participant/method/profile evidence-protocol digests match; immutable after sealed; deletion is two-stage, reference-guarded by every citing execution, and blocked while verdict/review retention applies |
| evaluation_evidence_items | snapshot_id, participant_id nullable for shared items, kind, opaque locator, digest, bytes, capture/source timestamps, inclusion, coverage, truncation, redaction, blob key | Snapshot CASCADE metadata; blob prune only after durable deletion marker |
| evaluation_executions | study_id, method_revision_id, nullable evidence_snapshot_id (sealed snapshots are shareable across executions when participant-set and evidence-protocol digests match), status/version, effective_profile_snapshot, randomization seed, objective/judge/aggregation policy snapshots, idempotency key, requested/cancelled/terminal actor/timestamps, retry_of; evidence_snapshot_id is required before Checking | Append-only identity; state transitions CAS guarded; a prepared snapshot is attached only after participant/method/profile evidence-protocol digests match |
| evaluation_objective_check_runs | execution_id, participant_id, check_id/version, attempt, status/reason, input/output digests, timing, trusted profile provenance, log evidence item | No PASS without executed/recorded fact; UNIQUE(execution,participant,check,attempt) |
| evaluation_metric_results | execution_id, participant_id, metric_id/version, status/reason, value JSON, unit, provenance refs | Immutable per execution; missing is explicit |
| evaluation_judge_attempts | execution_id, role, ordinal, retry_of, agent_id/revision, agent_run_id, token_id, runner/model snapshots, status/reason, sealed result/digest, prompt/schema/evidence digests, timing/tokens/cost | Token revoked at terminal; UNIQUE(execution,role,ordinal,retry_ordinal) |
| evaluation_criterion_results | attempt_id, participant_id, criterion_id, state, nullable score, rationale, confidence, evidence/objective refs | Immutable after attempt seal; schema/range/FK validated |
| evaluation_aggregate_results | execution_id, algorithm id/version, inputs, exact calculations, display values, caps, quorum, exclusions, dispersion, warnings, digest | Append-only revision if review adjudicates; never overwrite raw attempts |
| evaluation_reviews | execution_id, kind, status, flags, reviewer, resolution/rationale, optional adjudicated result, timestamps/version | Durable disagreement/escalation ledger |
| evaluation_human_verdicts | study_id, supersedes_id, outcome, participant ids, execution ids (empty only with an explicit no-evaluation-evidence acknowledgement), rationale, acknowledged warnings, actor/timestamp | Append-only and human-auth only |
| evaluation_events | study_id, execution_id nullable, sequence, event_type, redacted payload, created_at; UNIQUE(study_id,sequence) | Retained with Study; SSE supports Last-Event-ID |

## Migration and Compatibility Strategy

### Provisional global-number reservation

At plan creation, local main ends at ADR-138 and migration journal idx/tag 103/0103. Because the planning skill owns only plan files, Phase 0 implementation must immediately append reservation stubs after rechecking main:

- ADR-139 — Evaluation Study domain and legacy Experiment compatibility.
- ADR-140 — Package-sourced Evaluation Methods and trust/compatibility.
- ADR-141 — Immutable private evidence and bounded evaluator retrieval.
- ADR-142 — Multi-judge execution, aggregation, disagreement, and human verdict.
- ADR-143 — Controlled Evaluation recipes and slot-keyed execution profiles.
- ADR-144 — Advanced suites, calibration, and human-approved recipe standardization.
- 0104_evaluation_studies_expand (`0104_wet_red_skull`, Implemented).
- 0105_evaluation_platform_config (`0105_dizzy_speed`, Implemented).
- 0106_evaluation_execution_evidence (`0106_clear_major_mapleleaf`, Implemented; also adds `studies.legacy_snapshot`).
- 0107_evaluation_legacy_backfill (`0107_evaluation_legacy_backfill`, Implemented — the backfill was split out of 0104 into its own post-0106 data migration so it can synthesize legacy executions/attempts).
- 0108_evaluation_verdict_activity (`0108_evaluation_verdict_activity`, Implemented — T4.3; additive CHECK-widen adding the `evaluation_decided` task_activity event_kind for the social-board verdict mirror; never rejects existing rows).
- 0109_evaluation_legacy_contract (RESERVED — deferred contract/drop migration after the rollback window; NOT implemented in M46; re-reserved from 0108, which drizzle assigned to the verdict-activity migration).

Before implementation, rebase on current main, recompute maxima from main HEAD and _journal.json, renumber this reservation block/ADR stubs/migration triples if necessary, and run the ADR-anchor and journal-integrity checks. Every migration is SQL + journal entry + matching snapshot.

### Legacy backfill

Migration 0104 must preserve or loudly refuse:

1. Insert one evaluation_studies row per experiments row, preserving the Experiment ID as the Study ID/deep link and storing legacy_experiment_id.
2. Convert each variants[] element to an immutable evaluation_recipes row with a deterministic legacy key and original JSON/digest.
3. Convert every experiment_runs row to source_type=launched, retaining variant, replicate, launch reason, base commit, diff/truncation/files/materialization evidence, and behavioral launch lineage.
4. Preserve the original Experiment JSON verbatim in a legacy snapshot column until the contract migration.
5. Migration 0106 normalizes judge advisories, where they exist, into legacy Evaluation Executions/attempts/results; synthesized legacy executions are terminal Partial with reason legacy_advisory, never Completed. Human verdicts without advisories become zero-citation verdicts carrying the no-evaluation-evidence acknowledgement. Unknown historical agent/model/evidence provenance stays unknown with a reason; it is never fabricated.
6. Assert source/target counts, one-to-one member coverage, valid referenced variants, and lossless JSON digests. Any mismatch raises an exception and rolls back the migration.
7. Status mapping is fixed: draft→draft, running→open, comparable→open (readiness is a derived facet and is recomputed), concluded→decided, abandoned→archived with archived_reason=legacy_abandoned; the original status also survives verbatim in the legacy snapshot column. No state is inferred from current Run rows during migration.

### Compatibility window

- The UI deep links remain /projects/{slug}/experiments and /projects/{slug}/experiments/{studyId}, but the label becomes Evaluation Lab.
- Canonical new APIs use /evaluation-studies. Legacy /experiments APIs remain adapters for legacy-shaped controlled Studies and emit deprecation metadata.
- experiment_get/experiment_advise remain for the old core judge and historical automation; new panels use attempt-bound evaluation tools.
- The legacy conclude adapter keeps abandonLosers semantics on the legacy route only; the canonical verdict API has no run-stopping side effect (loser cleanup = existing per-run workbench stop/archive/drop, launched participants only).
- All no-auto-promotion, auto-delivery, relaunch, and GC consumers move in one phase to the explicit launched-lineage predicate. Observed participants are excluded by construction.
- Do not run old and new web binaries as concurrent writers. Deployment drains the old web process, takes a DB backup, runs expand migrations, starts the new web, then verifies backfill. Old code cannot understand new observed-only Studies.
- Rollback before any new Study write: stop new web and restore backup/old binary. After new model writes, rollback to old binary is unsupported; roll forward or restore backup and accept loss of post-backup Evaluation data.
- Keep legacy tables through at least one release/qualification window. 0107 drops or archives them only after parity queries, legacy-route tests, and operator sign-off.

## API and Event Contract Plan

### Common rules

- JSON DTOs are explicit projections; raw DB rows never cross the boundary.
- List endpoints use opaque cursor pagination, stable created_at/id ordering, limit 1..100, and documented filters.
- Mutable resources return ETag/revision; PATCH/DELETE/resolve operations require If-Match and return 409 on stale revisions.
- Create/start/launch/verdict requests require Idempotency-Key. Same key + same digest returns the original response; same key + different digest returns 409.
- Error mapping: malformed 400; unauthenticated 401; forbidden 403; missing/cross-project 404; stale/idempotency/state race 409; deleted evidence 410; semantic/schema/config 422; dependency/runner/store unavailable 503.
- No route accepts a filesystem path, package installed_path, supervisor/session ID, adapter env, secret, or actor attribution.

### Project Study routes

| Method/path | Request | Response / behavior |
| --- | --- | --- |
| GET /api/projects/{slug}/evaluation-studies | cursor, limit, taskId, status, participantSource, runStatus, profileId | Page of Study summaries and derived participant/evaluation status |
| POST /api/projects/{slug}/evaluation-studies | taskId, title, purpose, optional groundTruth selection | 201 Study; taskId is body-controlled selection joined through slug-derived project |
| GET /api/projects/{slug}/evaluation-studies/{studyId} | URL params only | Study detail, participants, recipes, evaluation summaries, latest human verdict |
| PATCH /api/projects/{slug}/evaluation-studies/{studyId} | title/purpose/groundTruth while allowed, display metadata; If-Match | Updated Study; immutable ownership/provenance fields rejected |
| POST .../{studyId}/participants/observed | runIds[1..N], labels/order | Idempotent selected participants; each run must be a flow Run for the same task/project |
| DELETE .../{studyId}/participants/{participantId} | reason; If-Match | Hard delete only if unreferenced; otherwise tombstone |
| POST .../{studyId}/recipes | typed recipe draft | Validated immutable recipe version; M46 supports legacy axes, M47 full recipe |
| POST .../{studyId}/recipes/{recipeId}/launch | replicateCount, optional allowed overrides | 202 durable batch intent with per-item statuses; no all-or-nothing claim |
| POST .../{studyId}/evidence-snapshots | participantIds, capture mode | 202 capture; returned snapshot may later be attached to one or more evaluations if method/profile digests match |
| POST .../{studyId}/evaluations | profileId, participantIds, allowed overrides, optional preparedSnapshotId | 202 Evaluation Execution and progress URL |
| GET .../{studyId}/evaluations/{evaluationId} | URL params only | Lifecycle, objective/panel progress, warnings, unsealed/sealed visibility by role |
| POST .../{evaluationId}/cancel | reason | 202 cancellation intent; already terminal is idempotent |
| POST .../{evaluationId}/retry | retry scope and reason | 202 new attempt/execution lineage, never overwrite |
| POST .../{evaluationId}/reviews | resolution/rationale/adjudication; If-Match | Durable disagreement review |
| POST .../{studyId}/verdicts | outcome, participantIds, evaluationIds (empty only with the no-evaluation-evidence acknowledgement), rationale, warning acknowledgements | 201 append-only human verdict; latest may supersede with reason |
| GET .../{studyId}/stream | Last-Event-ID | Replayable text/event-stream over evaluation_events |

### Platform and project configuration routes

- GET /api/admin/evaluations/methodologies and PATCH /{methodRevisionId}/activation.
- GET/POST /api/admin/evaluations/judge-panels; GET/PATCH/DELETE /{panelId}.
- GET/POST /api/admin/evaluations/profiles; GET/PATCH/DELETE /{profileId}.
- GET/PUT/DELETE /api/projects/{slug}/evaluation-profiles/{profileId}/override.
- GET /api/projects/{slug}/evaluation-catalog returns only selectable compatible Methods/Profiles/agents/runners/Flows/package revisions/MCPs and exact incompatibility reasons.
- POST /api/projects/{slug}/evaluation-preflight validates a creation step without side effects and returns typed refusals/warnings/effective materialization preview.

### Identifier trust table

| Identifier | Source | Rule |
| --- | --- | --- |
| slug, studyId, participantId, recipeId, evaluationId, profileId in route | url-param | Resolve row and join downward from slug-derived project; mismatches return 404 |
| current user/global/project role | auth-context | DB-authoritative; never trust cached/body role |
| projectId/task ownership/run project/run task/method package/attempt judge attribution | server-state | Derive by joins from trusted route/token identity |
| taskId/runIds/profileId/method option/participantIds in create bodies | body-controlled selection | Allow only because they select resources; join to server-state project/task/study and reject mismatch before side effects |
| runner/model/MCP/agent selections | body-controlled intent | Resolve against allowed catalog/Profile bounds; persist resolved server snapshots, never the raw value as authority |
| worktree path/session id/agentRunId/evidence snapshot id for bound judge | forbidden body field | Always server-derived |

### Side-effect ordering

- Controlled launch: transaction locks Study/recipe, writes batch + item intents/idempotency, commits; each item then performs standard preflight/worktree/Run transaction; success/failure is finalized under item claim. Crash before side effect is retryable; crash after Run commit adopts the Run using the durable item key. Partial batch is first-class.
- Evaluation start: transaction validates Study/Profile/participants, writes execution + event + idempotency, commits; immediate kick/backstop captures evidence. No judge launches before snapshot seal and objective policy decision.
- Judge launch: transaction claims attempt and issues a dedicated token intent; after agent Run creation, finalize agent_run_id and provenance. Crash after Run creation adopts by trigger/idempotency key rather than launching a duplicate.
- Result submit: lock attempt; validate token binding, terminal state, JSON Schema, semantic refs/ranges; write sealed result + criteria + terminal event in one transaction. Same digest is idempotent; different second result is 409.
- Cancel: persist cancellation intent first; cancel live agent Runs second; finalize when all attempts terminal. Timeout/network leaves retryable cancelling; not-found agent Run is reconciled from DB state.
- Evidence deletion: mark pending deletion in DB; prune blobs; finalize tombstone. Prune failure stays retryable and readable until actual deletion.

### SSE and internal events

Add docs/api/async/web-evaluations.asyncapi.yaml with:

- evaluation.queued, evidence.capture_started, evidence.snapshot_sealed, evidence.capture_failed;
- objective_check.started/completed;
- judge_attempt.started/retrying/terminal;
- panel.quorum_reached/panel.partial;
- aggregation.completed;
- review.required/resolved;
- evaluation.completed/partial/failed/cancelling/cancelled;
- verdict.recorded.

The DB event log is the replay source. Payloads contain bounded IDs/status/reasons/counts only, never evidence or rationale bodies.

### External API and MCP

Add attempt-bound external routes and tools matching D10. Token scopes:

- evaluations:context:read;
- evaluations:evidence:read;
- evaluations:objective:read;
- evaluations:result:submit.

Judge tokens receive only these exact scopes plus no general task/comment/relation mutation scopes. The submit scope maps to a dedicated server action, not manageExperiments. UI/API users have separate session RBAC.

## RBAC Plan

| Action | Minimum authority | Notes |
| --- | --- | --- |
| readEvaluationStudies | project viewer | Metadata and published aggregate/result summaries |
| readEvaluationEvidence | project member | Private source/evidence payload; viewer sees coverage/metrics but not private bodies |
| manageEvaluationStudies | project member | Create/edit Study, add/remove observed participants |
| launchEvaluationRuns | project member + launchRun | Controlled supervised/assisted launches |
| launchEvaluationUnattended | existing launchUnattended plus explicit recipe confirmation | Unattended-within-policy only; no blind ship; promotion hold forced |
| runEvaluations | project member | Start/cancel/retry within Profile limits |
| resolveEvaluationReview | project admin | Resolve disagreement/adjudication |
| concludeEvaluationStudy | project member human session | Append/supersede human verdict only |
| manageProjectEvaluationOverrides | project admin | Only Profile-allowed fields |
| manageEvaluationConfig | global admin | Method activation, Panels, Profiles |
| submitEvaluationResult | bound judge token only | Attempt-derived, one sealed result |

Every API and server action derives projectId from a server-loaded row. Add route/authz/token-scope contract tests for every row.

## Metrics Contract

Per participant/snapshot, record:

- Run outcome/status at watermark, terminal/completion state, furthest node/stage, failed node/gate/subsystem, structured error code/reason;
- objective checks/gates and artifact completeness;
- wall, active, queued, HITL wait, and human-attention intervals with formula/version;
- input/output/cache-creation/cache-read/resume tokens and per-runner/model breakdown from run_sessions/cost rollups;
- retries, crashes, recoveries, rework loops, questions, permissions, interventions;
- files/additions/deletions and evidence coverage;
- Flow/package/agent/runner/model/capability/MCP/materialization/execution-policy provenance;
- success and valid-result flags.

Replicate group aggregates: count, valid count, success rate, median, P90, variance, token/cost-to-success where supported. Latest replicate remains a drill-down option, never the primary ranking input.

## UI/UX Information Architecture

### Routes

- /projects/{slug}/experiments — retained path, product label Evaluation Lab, Study list.
- /projects/{slug}/experiments/new — full-page guided creation.
- /projects/{slug}/experiments/{studyId} — Study Lab.
- /settings/evaluations — admin Methodologies | Judge Panels | Evaluation Profiles.

### Entry points

- Evaluation Lab: Compare existing Runs and Run controlled experiment.
- Task detail/history: multi-select 2..N Runs and Compare.
- Run detail: Add to new Study or eligible existing Study.
- Study breadcrumbs: project → task → Study; participant links return to Run.

### Guided creation

1. Purpose, task, ground truth, baseline.
2. Existing Runs and/or controlled variants.
3. Execution recipes and materialization/trust/input-contract preflight.
4. Evaluation Profiles and panel summary.
5. Review: participant count, active/partial warnings, objective coverage, attempts, estimated token/cost scope (money only if priced), trust/materialization, launch.

All selectors are typed, searchable, virtualized where needed, and server-filtered. No raw JSON, comma-separated refs, opaque IDs, or free-text runner/model/MCP values.

### Study Lab

Default Overview is N-way:

- sortable scoreboard with status/failure/coverage;
- criterion and objective-gate heatmaps;
- replicate distributions;
- comparability warnings;
- quality/time/token/human-effort trade-offs;
- method/panel/quorum/provenance summaries.

Tabs/regions:

- Overview;
- Runs & execution;
- Results & objective evidence;
- Changes;
- Evaluation & verdict.

Pair selection appears only in pairwise Diff/Diff-of-diffs. URL query state owns selected tab, filters, sort, participant pair, profile, and replicate group.

### Platform settings

- Methodologies: package/version/SHA, method schema, state/health, validation errors, engine range, trust, used-by.
- Judge Panels: role bindings, attempts/quorum, runner/model resolution, budgets, blinding/order, MCP allow-list, retry/poison policy, effective preview.
- Profiles: method + panel, defaults/hard bounds/allowed overrides, project usage, degraded dependencies.

### UI quality gates

- Responsive: table-to-card fallback; sticky first column/legend on wide heatmaps; participant virtualization for dense N.
- Accessibility: semantic heading/tab/table/status/live-region; keyboard multi-select/reorder; focus restoration; dialog confirmations; color + text/icon status; reduced motion.
- States: loading, empty, sparse, dense, active/partial, degraded/incompatible, forbidden, stale revision, capture/check/judge progress, cancelled, missing evidence, error.
- Errors: localized, actionable, role-safe; never offer a CTA the current role cannot perform.
- EN/RU parity is tested by key-set parity and Playwright.

## TDD and Test Strategy

### Test lanes

- Pure unit: method schema normalization, weight/cap validation, compatibility, lifecycle reducers, coverage/comparability, aggregation algorithms, disagreement classification, metric distributions, redaction/path-independent DTO projection.
- Real Postgres integration: migration/backfill/constraints, RBAC, idempotency/CAS, Study participant semantics, launch intent recovery, evidence sealing, quorum/retry/cancel races, verdict append/supersede, legacy behavior.
- Package compatibility: old package no-method behavior; new method install/trust/enable; local fork/edit/commit/cut provenance; old engine/new method refusal; untrusted method cannot execute; closed check/aggregation rejection.
- Contract: OpenAPI/AsyncAPI/MCP tools/result JSON Schema, cursor/idempotency/If-Match, token scopes, redacted DTOs.
- E2E: compare existing Runs, legacy Experiment parity, partial active/failed Study, panel progress and verdict, admin configuration, full controlled recipe flow, EN/RU/a11y.
- Real wiring: evaluation dispatcher claim→capture→check→judge→submit→aggregate; controlled batch item→standard run launch; package discovery→method projection; SSE replay.

Every new test path must be proven by vitest --project <lane> --list. web/vitest.workspace.ts already includes lib/app/components unit and lib/app integration families; extend the runner config in the same phase if a new path is outside those globs. No phase exits with red tests. Harness-limited tests require an explicit tracked quarantine, never deletion or silent tolerance.

Every phase exit includes an explicit REFACTOR gate: duplication and scaffolding introduced during GREEN are removed (or the phase records “refactor: none needed”), and the full lane suites re-run green after the refactor.

## Requirement → Acceptance → Test Traceability

| ID | Acceptance contract | Primary tests |
| --- | --- | --- |
| AC-01 | Select 2..N same-task existing Runs without changing promotion, delivery, retention, relaunch, or membership semantics | participant real-DB integration; auto-promotion/auto-delivery/GC/relaunch regression; observed E2E |
| AC-02 | Study can contain observed and launched participants with immutable provenance | schema constraint/service integration; hybrid E2E |
| AC-03 | Failed/crashed/abandoned/partial/active Runs show stage, reason, output, and consumption at snapshot watermark | evidence/metric integration; partial Study E2E |
| AC-04 | N-way Overview is default; pair selector exists only in pairwise views | component + Playwright URL-state test |
| AC-05 | A trusted compatible package supplies versioned Evaluation Methods; old packages remain usable | parser/install/local-cut/release-gate tests |
| AC-06 | Admin configures Panels/Profiles without editing package content | admin API/RBAC/E2E |
| AC-07 | One Study runs multiple separate methods and independent judges | execution/panel integration + UI |
| AC-08 | Judges share one immutable snapshot and cannot see peer results | attempt-token integration, sealed DTO test |
| AC-09 | Strict schema, bounded repair/retry, quorum, timeout, poison, partial-panel behavior are enforced | unit + real-DB worker race/wiring tests |
| AC-10 | Objective checks are separate and not_run/unavailable requires reason | objective provider/schema/UI tests |
| AC-11 | Aggregation/disagreement are versioned, deterministic, unrounded internally, and auditable | golden unit properties + persisted input digest integration |
| AC-12 | Method/package/prompt/evidence/judge/agent Run/runner/model/aggregation provenance is complete | end-to-end provenance assertion |
| AC-13 | Only human session can create/supersede conclusive verdict | route/token/RBAC/append-only tests |
| AC-14 | Launched Evaluation Runs never auto-promote or auto-deliver | launch/promotion/dispatcher regressions |
| AC-15 | Package trust/engine compatibility gates every execution seam | untrusted/incompatible sentinel tests |
| AC-16 | Existing Experiment history, URLs, APIs, MCP tools, and package workflows remain usable | migration 0090→010x integration + legacy E2E/contracts |
| AC-17 | EN/RU, accessibility, roles, loading/empty/partial/degraded/error states are complete | i18n parity + axe/keyboard Playwright |
| AC-18 | API, DB, analytics, package schema, UI, tests, and docs state the same contract | contract validators + final traceability gate |
| AC-19 | Alternative Flows refuse incompatible input/artifact contracts before side effects | M47 preflight integration/E2E |
| AC-20 | Slot-keyed recipes produce exact run_sessions rows and server-resolved model provenance | M47 multi-session/consensus integration |
| AC-21 | Controlled batch retries adopt existing Runs and expose partial launch honestly | crash-window integration |
| AC-22 | Evidence never exposes secrets, worktree paths, adapter env, or unrestricted code access | redaction/path confinement/token-scope adversarial tests |
| AC-23 | Active Run progress after seal does not mutate historical evaluation; a new execution captures later state | snapshot immutability integration |
| AC-24 | Replicate summaries use distributions, not latest replicate primacy | metrics unit/integration/UI |
| AC-25 | Dollar cost is unavailable until a versioned pricing catalog is present | DTO/UI missing-price test |

## Edge-Case and Failure-Mode Matrix

| Case | Required behavior |
| --- | --- |
| Observed Run belongs to another task/project | Reject 404/422 before participant write |
| Same observed Run selected twice | Idempotent same request or 409 duplicate; never duplicate behavior |
| Run deleted after snapshot | Participant retains identity/provenance/evidence; live link becomes unavailable |
| Active Run progresses after snapshot | Existing snapshot unchanged; coverage stays timestamped; new execution required |
| Participant removal races evaluation start | Study/evaluation lock + version guard; either excluded before seal or retained/tombstoned in snapshot |
| Method/profile/panel changes during start | Effective snapshot is resolved under revision check; stale config yields 409/retry |
| Agent/runner/model/MCP disappears | New executions show degraded/preflight refusal; historical results remain readable |
| Unequal participant evidence | Seal with explicit coverage matrix/comparability warning; policy may block or permit Partial |
| Required evidence contains secret | Redact/omit with reason; method policy determines block/Partial; never leak |
| Objective check did not run | not_run/unavailable with reason; never inferred PASS |
| Judge invalid JSON/schema/ref | invalid attempt, bounded repair/retry; no partial row masquerades as valid |
| Judge times out/cancels/crashes | Terminal attempt; token revoked; quorum/partial policy applies |
| Missing/poison judge | Bounded retries and exclusion reason; poison cannot monopolize dispatcher |
| Judge attempt queued past timeout under the agent cap | Timeout clock starts at session Running, never at enqueue; queue wait is metered separately; panel max parallel attempts ≤ cap − 1 keeps one agent slot free |
| Prepared/sealed snapshot attached to an execution with different protocol digests | Typed refusal before start; capture a new snapshot instead |
| Submit races timeout/cancel | Attempt row lock/CAS; exactly one terminal outcome; late result rejected |
| Quorum reached while retry queued | Cancel/not-start queued excess attempts per snapshotted policy; persist exclusion |
| Exactly-threshold disagreement | Inclusive comparator defined in method; no hidden > versus >= ambiguity |
| Missing criterion/participant result | Invalid or insufficient_evidence; never numeric zero |
| Incompatible methods in one Study | Separate results; no universal aggregation |
| Launch batch item fails mid-fan-out | Other item states preserved; retry only failed/retryable item; no duplicate Run |
| Alternative Flow schema mismatch | Typed preflight refusal before worktree/session |
| Slot/model intent has no exact supported host | Fail before side effects or persist explicit allowed soft warning; never silently claim requested model ran |
| Unattended recipe relaxes checks + human/promotion floor | Existing no-blind-ship guard rejects |
| Evaluation launched participant reaches Review | Promotion/auto-delivery apply-site excludes it even if project auto policy is enabled |
| Blob written, DB seal crashes | Orphan GC; no visible snapshot |
| DB deletion mark written, blob prune fails | Retryable pending_delete; payload remains access-controlled |
| Event worker dies after DB commit | Scheduler/domain-event backstop reclaims using durable marker |
| Legacy JSON cannot normalize | Migration aborts; no lossy guess |
| Old/new web binaries overlap | Deployment gate forbids concurrent writers |

## Commit Plan

### MAIster repository

- Commit 1 (T0.1–T0.3): docs(eval): freeze Evaluation Lab product and contracts
- Commit 2 (T1.1–T1.2): feat(packages): add Evaluation Method package contracts
- Commit 3 (T2.1–T2.2): feat(evaluations): add Study schema and legacy migration
- Commit 4 (T2.3–T3.2): feat(evaluations): add immutable evidence and platform profiles
- Commit 5 (T3.3–T4.2): feat(evaluations): add durable evaluation and multi-judge execution
- Commit 6 (T4.3–T5.2): feat(evaluations): add aggregation, verdict, and Evaluation Lab UI
- Commit 7 (T5.3–T5.4): test(evaluations): complete foundation regression and rollout gates
- Commit 8 (T6.1–T6.3): feat(evaluations): add controlled execution recipes
- Commit 9 (T6.4–T6.5): feat(evaluations): complete controlled Lab UX and validation
- Commit 10 (T7.1–T7.3): feat(evaluations): add advanced methods and suites

### maister-plugins repository

- One package-scoped commit: feat(core): add sdd-quality Evaluation Method
- Optional root-doc commit kept separate from the package release unit.
- Annotated package tag after the MAIster compatibility gate passes: core/v1.1.0 (current latest observed during planning: core/v1.0.1).

Do not tag before the MAIster release gate is present and green. The existing maister-plugins release wrapper references a missing MAIster validate:package-compatibility script; T1.2 must restore an equivalent real gate and extend it for Evaluation Methods.

## Tasks

### Phase 0 — Complete specification and contract freeze

- [x] T0.1 Reserve global IDs and freeze product/domain decisions.
  - Deliverable: rebase on current main; reserve/renumber ADR-139..144 and migrations 0104..0107; update docs/VISION.md, docs/PRODUCT_VIEW.md, .ai-factory/DESCRIPTION.md, .ai-factory/ARCHITECTURE.md, .ai-factory/ROADMAP.md, docs/architecture.md, and docs/decisions.md with terminology, JTBD, milestone boundaries, non-goals, ownership, invariants, and compatibility. Known in-flight sibling: branch claude/pr-merge-workflows-4d0e7e already claims ADR-139/140 and adjacent migration numbers — whichever integration lands second renumbers, including the migration journal `when` bump (non-monotonic `when` silently skips migrations).
  - Acceptance: every capability is labeled Implemented, Designed, Phase 2, or Later; Study/Participant/Evaluation/Method/Panel/Profile/Verdict ownership is unambiguous; M45 stays truthful; M46–M48 are independently verifiable.
  - Logging: no runtime logging; validation emits INFO per reserved ADR/migration and ERROR on collision/missing anchor/snapshot.
  - Depends on: none.

- [~] T0.2 Freeze analytics, lifecycle, API, DB, package, evidence, judge, RBAC, and failure contracts.
  - SESSION DECISION (2026-07-16): LEAN FREEZE — core contracts frozen now (ADR-139..144, migration reservations 0104..0107, engine 3.2.0, milestone boundaries); the wider analytics/API/AsyncAPI/screens docs CO-EVOLVE with the code that implements them (per owner's "lean freeze, co-evolve" directive). Each later phase carries its own as-built doc checkpoint.
  - Deliverable: replace/evolve docs/system-analytics/experiments.md into Evaluation Lab analytics (or add evaluation-lab.md and keep a compatibility section); add evaluation-methods.md; update packages.md, local-packages.md, sessions.md, execution-policy.md, artifacts.md, runs.md, reconciliation-gc.md; update docs/database-schema.md and docs/db/erd.md plus the relevant projects/runs/evaluations domain ERDs; define every transition, emitter/wakeup, refusal, retry, cancellation, retention, and crash window.
  - Contract files: docs/api/web.openapi.yaml, docs/api/external/operations.openapi.yaml, new docs/api/async/web-evaluations.asyncapi.yaml, docs/configuration.md, docs/error-taxonomy.md, docs/pv/package-management.md, docs/screens/projects/project-experiments.md, new docs/screens/settings/evaluations.md, docs/screens/README.md.
  - Also freeze here: the exact new MaisterError codes added to the client-safe union in web/lib/errors-core.ts; the viewer-visible result scope (judge rationales member-only vs viewer-visible); the Study deletion surface (archive-only vs an explicit delete route).
  - Acceptance: route schemas/statuses/examples, event payloads, migration/backfill, JSON schemas, identifier trust table, two-phase side-effect tables, and state allow-lists are internally consistent before code.
  - Logging: no evidence bodies; validator output INFO per contract and ERROR with exact JSON pointer/route/state on drift.
  - Depends on: T0.1.

- [~] T0.3 Freeze acceptance, traceability, rollout, and adversarial review.
  - SESSION DECISION (2026-07-16): AC-01..25 remain the acceptance contract (this plan §Traceability); adversarial findings are resolved inline as each code phase implements the relevant contract, not as a separate up-front doc pass (lean-freeze directive).
  - Deliverable: copy AC-01..25 into the approved spec with requirement→contract→test→owner mapping; record reasonable assumptions; run an explicit refute-the-design pass for observed membership, mutable snapshots, judge anchoring, unequal evidence, invalid aggregation, slot/model resolution, trust-before-execution, migration loss, batch/evaluation races, and UI dead ends.
  - Acceptance: no code phase begins until all blocking findings are resolved in specs; nonblocking assumptions remain in the plan, not Inbox/HITL.
  - Logging: review tooling logs finding ID/severity/spec pointer only; never log private evidence.
  - Depends on: T0.2.

Phase 0 exit: docs/analytics/contracts complete and internally consistent; pnpm validate:docs:all and pnpm validate:contracts green; ADR anchors and migration reservations green.

### Phase 1 — Package-sourced Evaluation Method foundation

- [x] T1.1 RED/GREEN/REFACTOR the Evaluation Method parser, validator, projection, trust, compatibility, and Studio/local-package fan-out.
  - DONE (core): `web/lib/evaluations/method-schema.ts` (strict `evaluation-method.yaml` zod schema + closed AGGREGATION/OBJECTIVE_CHECK registries + modes), `web/lib/evaluations/method.ts` (`loadEvaluationMethod` + `normalizeEvaluationMethodDefinition` + `checkMethodEngineCompatibility` + digests), `evaluationMethods[]` in `maisterPackageManifestSchema` (default-empty, dup-guard), engine 3.1.0→3.2.0. 23 unit tests green (old-package empty, strict schema, weight/anchor/cap/ref/result-schema, unknown aggregator/check, engine range, deterministic digests). DEFERRED to Phase 2 (needs `evaluation_method_revisions` table): the DB projection + trust_status wiring + Studio/local-package UI fan-out — these co-evolve with T2.1's migration.
  - Files: web/lib/config.schema.ts, web/lib/packages/manifest.ts, install/catalog/attach modules, web/lib/flows/engine-version.ts, web/lib/local-packages/*, web/lib/catalog/authored-types.ts, web/lib/flows/editor/package-file-tree.ts, web/lib/queries/package-bom.ts, web/lib/studio/group-packages.ts, package viewer/editor components, messages/en.json, messages/ru.json.
  - RED: old-package default-empty; strict method schema; weight/anchor/cap/ref/result-schema validation; unknown aggregator/check; engine range; untrusted sentinel; local fork/edit/cut provenance; old engine/new entity refusal.
  - GREEN: evaluationMethods projection is inert until trusted+compatible; engine 3.2.0; closed registries; draft/invalid/published/enabled/disabled/degraded/incompatible presentation.
  - Acceptance: no package prompt/check/aggregation executes during install/parse; older packages are unchanged; SET/CLEAR/re-set catalog projection is symmetric.
  - Logging: DEBUG package/method IDs, digests and compatibility branch; INFO projection/activation; WARN degraded; ERROR validation/trust refusal; never prompt/schema body, installed_path, or secrets.
  - Depends on: Phase 0.

- [x] T1.2 Restore and extend the clean package-release compatibility gate.
  - DONE: `web/scripts/validate-package-compatibility.ts` + `validate:package-compatibility` in `web/package.json` (the exact command `maister-plugins/scripts/release-package.sh` invokes). Validates manifest + every flow.yaml + every Evaluation Method (schema + prompt/schema assets + normalization + engine range) with NO content execution; refuses name/tag mismatch + incompatible method. 5 unit tests green (added `scripts/**` to the vitest unit project). Verified end-to-end against the real maister-plugins core package. NOTE (co-evolve): the "real Postgres attach" leg of the gate is deferred to Phase 2 (needs the install/attach tables).
  - Files: web/package.json, a dedicated validation script under web/scripts or scripts, root/package docs, maister-plugins/scripts/release-package.sh contract tests.
  - RED: prove the current release wrapper fails because validate:package-compatibility is absent; add fixtures for old packages, method packages, incompatible engine/schema, invalid references, untrusted setup sentinel.
  - GREEN: one exact command validates manifest, flows, Evaluation Methods, engine range, package-root assets, immutable install/trust, and real Postgres attach without executing untrusted content.
  - Acceptance: runner include/list confirms tests run; release wrapper refuses dirty/incompatible packages before tag creation.
  - Logging: INFO package/tag/method counts and gate stages; WARN optional compatibility gaps; ERROR exact safe pointer/reason; no source/prompt/secret content.
  - Depends on: T1.1.

- [x] T1.3 Publish the default core sdd-quality method in maister-plugins after MAIster support is deployable.
  - DONE (content + commit): maister-plugins `865db4a` adds `packages/core/evaluation-methods/sdd-quality/{evaluation-method.yaml,prompts/judge.md,schemas/judge-result.schema.json}` (operationalized 5-criterion SDD rubric, weighted_mean@1, 3-attempt panel, quorum 2, strict result schema, no concrete runner/model/secret/MCP ids) + `evaluationMethods[]` in `maister-package.yaml` + README. Passes `validate:package-compatibility`. OWNER-GATED: annotated `core/v1.1.0` tag NOT created (needs the green MAIster release gate first); default Profile creation lands with Phase 3 config services.
  - Files: packages/core/maister-package.yaml, packages/core/evaluation-methods/sdd-quality/evaluation-method.yaml, prompts/judge.md, schemas/judge-result.schema.json, packages/core/README.md, root README/catalog as a separate commit.
  - Content: operationalized SDD rubric generated from one canonical schema; ground truth/evidence/objective protocol; logical judge roles; weighted_mean@1 policy; quorum/retry/disagreement/report metadata; no concrete runner/model/secret/MCP IDs.
  - Acceptance: package-scoped commit; clean release gate; annotated core/v1.1.0 tag; install/trust/enable in MAIster; default Profile creation is explicit and degrades if the tag is unavailable—migration never fetches network.
  - Logging: release gate logs package/tag/digests and validation stages only; no prompt/evidence bodies.
  - Depends on: T1.2 and deployable M46 parser.

Phase 1 exit: package parser/local workflow/release gate suites green; old package regressions green; no core tag exists before the gate.

### Phase 2 — Study schema, legacy migration, participants, and evidence

- [x] T2.1 RED/GREEN/REFACTOR migrations 0104–0107 and Drizzle schema.
  - DONE (0104): `evaluation_studies` / `evaluation_recipes` / `evaluation_participants` + `web/lib/evaluations/types.ts`; 7-test schema integration green.
  - DONE (0105/0106/0107, this session): config tables (`evaluation_method_revisions` / `evaluation_judge_panels` / `evaluation_profiles` / `evaluation_project_profile_overrides`); execution+evidence tables (11: snapshots/items/executions/objective_check_runs/metric_results/judge_attempts/criterion_results/aggregate_results/reviews/human_verdicts/events) with CAS `version`, score-state + zero-citation CHECKs, self-FKs (retry_of, supersedes), `executions.method_revision_id` NULLABLE for honest legacy executions, `studies.legacy_snapshot`; `0107` retained idempotent parity-asserting `evaluation_backfill_from_experiments()` (fixed status map, budget_restart→manual_relaunch, advisories→one Partial/`legacy_advisory` execution + attempt-per-advisory verbatim, advisory-less conclusions→zero-citation verdicts, RAISE+rollback on any mismatch). 10-test backfill integration green; journal-integrity(15) + drift-check(2) green; `validate:docs:all` green (367 mermaid). DB narrative + `docs/db/evaluations-domain.md` ERD added. **0108** = verdict-activity (T4.3); **0109 reserved** for the deferred legacy-contract drop.
  - Files: web/lib/db/schema.ts, migrations SQL/journal/snapshots, migration integration tests, docs DB artifacts already frozen in Phase 0.
  - RED: migrate a realistic 0090 database containing every Experiment status, variants, members, failures, snapshots, advisories, human verdicts, missing historical provenance, and package pins; assert count/digest parity and constraints, the fixed status mapping (incl. archived_reason=legacy_abandoned), Partial legacy executions with reason legacy_advisory, and zero-citation verdicts for advisory-less conclusions.
  - GREEN: create all foundation tables/indexes/FKs/checks; lossless legacy backfill; loud abort on invalid/mismatched data; no destructive drop.
  - Acceptance: latest journal entry has a snapshot; bare/main/Brain lineage checks pass; rollback limits documented; no constant fake defaults for per-row provenance.
  - Logging: migration emits bounded counts/IDs/checksum summaries; WARN unknown legacy provenance; ERROR abort reason; never JSON verdict/comment/evidence body.
  - Depends on: T0.2.

- [x] T2.2 RED/GREEN/REFACTOR Study, recipe, participant, and legacy adapter services.
  - DONE (this session): (1) launched-lineage predicate `lib/evaluations/membership.ts` (`isLaunchedLineageRun` = legacy experiment member OR launched eval participant; observed excluded by construction) migrated into ALL 4 no-auto/relaunch consumers (auto-promotion sweep reader, promote apply-site guard, auto-delivery short-circuit, HITL restart classification) — committed `1f6f5b7ac`, integration test proves observed/launched/legacy/plain + tombstone. (2) Neutral Study service `lib/evaluations/studies.ts` (createStudy + cross-project reject, patchStudy version-CAS, addObservedParticipants same-task/flow-only/idempotent/draft→open, removeParticipant hard-delete-vs-tombstone, createRecipe digest+dup-key) + shared `lib/evaluations/digest.ts` — committed `c06895b59`, 10-test service integration green. Legacy deep-link lossless mapping is structural (backfill preserves Experiment id AS Study id). CO-EVOLVE: HTTP routes + legacy `/experiments` route adapters land with Phase 5 UI (where consumed); GC/relaunch consumers already covered by the unified predicate.
  - Files: new web/lib/evaluations/{types,schemas,fsm,repository,service,participants,recipes,legacy}.ts; canonical/new routes; existing web/lib/experiments/* compatibility adapters; membership consumers in promote/auto-delivery/auto-promotion/GC/relaunch.
  - RED: observed same-task validation; observed in multiple Studies; launched owner uniqueness; tombstone rules; active/failed participants; optimistic concurrency/idempotency; every membership behavioral regression.
  - GREEN: neutral Study service and explicit launched-lineage predicate; legacy routes/deep links map losslessly.
  - Acceptance: observed selection leaves experiment_runs and every execution/promotion/retention field byte-identical; launched participants keep no-auto behavior at candidate query and apply site.
  - Logging: DEBUG bounded study/participant/run IDs and validation stage; INFO add/tombstone/state; WARN legacy adapter/deprecation; ERROR typed refusal; no task prompt/diff/path.
  - Depends on: T2.1.

- [x] T2.3 RED/GREEN/REFACTOR immutable evidence storage, capture, coverage, redaction, and bounded retrieval.
  - DONE (capture pipeline + GC, this session): `lib/evaluations/evidence/capture.ts` — `captureEvidenceForExecution` resolves each live participant's COMMIT-ANCHORED watermark (base..pinned tipSha, no live worktree scan) via an injectable `CaptureGitSource` seam (`defaultCaptureGitSource` wires `localBranchHead`+`diffRunWorkspace`; observed Run w/ removed workspace/branch → null → honest `unavailable` item), reuse-short-circuits before diff reads (D5), classifies coverage (`captured|truncated|redacted|uncommitted_not_captured|unavailable`), emits a per-active-Run `uncommitted_not_captured` marker, and seals via the built store. Pure `redactEvidenceText` (host-path + secret-token masking, recorded count/kinds). `sealEvidenceSnapshot` extended to persist `coverageSummary`+`warnings`. `lib/evaluations/evidence/gc.ts` — `sweepEvaluationEvidence` (orphan `preparing`→`pending_delete`; unreferenced `pending_delete` past grace→`deleted` with a NOT-IN(cited) guard over the RESTRICT FK) WIRED into the M24 system sweep GC bundle. Tests: 4 redaction unit + 4 capture/GC integration green; system-sweeps unit updated (evidence sweep mocked+asserted). Bounded judge retrieval routes already landed in T4.1.
  - DONE (storage core, prior session): `lib/evaluations/evidence/store.ts` (content-addressed blob write via atomicWriteBuffer tmp+fsync+rename; server-capped bounded read w/ `truncated` flag; `..`/root-escape path confinement) + `lib/evaluations/evidence/snapshots.ts` (`sealEvidenceSnapshot` blobs-before-DB seal, `findReusableSnapshot` reuse-by (watermark+protocol digest), redacted item DTO w/o locator/blobKey, bounded `readSnapshotItem` validating item∈snapshot); `evaluationEvidenceRoot()` in instance-config + `MAISTER_EVALUATION_EVIDENCE_ROOT` in .env.example + docs/configuration.md (host-only per ADR-023). 4-test integration green (seal/reuse/bounded-read/confinement). The security-critical retrieval boundary (AC-22 subset) is verified.
  - CO-EVOLVE (subsequent commits): the commit-anchored CAPTURE pipeline (git-object reads at the watermark SHA, coverage classification incl. `uncommitted_not_captured`, redaction), the evidence API routes, and GC/orphan/pending-delete recovery — these feed item bytes into the already-built seal/store core.
  - Files: web/lib/evaluations/evidence/*, instance-config/runtime-root helpers, evidence API routes, artifact/gate/run/session readers, GC/recovery modules.
  - RED: active and terminal watermarks; commit-anchored reads (git objects at resolved SHA, no live worktree scan; append-only logs cut at watermark offset; uncommitted_not_captured coverage class); sealed-snapshot reuse across executions on digest match and typed refusal on mismatch; identical panel snapshot; later Run mutation; truncation/redaction/digest; unequal coverage; secret/path sentinels; blob/DB crash windows; bounded range; authorization.
  - GREEN: content-addressed atomic store, manifest seal transaction, orphan and pending-delete recovery, opaque DTOs.
  - Deployment wiring: MAISTER_EVALUATION_EVIDENCE_ROOT in web/lib/instance-config.ts, .env.example, compose.yml and production override where applicable, deploy/maister-web.service, docs/configuration.md and docs/deployment.md; host mount/permissions documented.
  - Acceptance: no unbounded repo concatenation; judges cannot address arbitrary Study/Run/snapshot; same snapshot digest for every attempt.
  - Logging: DEBUG item kind/digest/size/coverage (no locator path); INFO capture/seal/delete; WARN truncation/redaction/asymmetry; ERROR storage/capture reason; never payload or private path.
  - Depends on: T2.1, T2.2.

Phase 2 exit: unit + real Postgres integration green; migration parity green; full existing Experiment suite green; evidence privacy adversarial tests green.

### Phase 3 — Platform configuration, objective facts, and durable orchestration

- [x] T3.1 RED/GREEN/REFACTOR Methodology, Judge Panel, Profile, and project-override services/APIs.
  - DONE (config CRUD, `073f5a371`): `lib/evaluations/config.ts` — createPanel/patchPanel(optimistic revision CAS)/deletePanel(usage-guarded by profile); createProfile(validates method+panel)/patchProfile(CAS)/deleteProfile(usage-guarded by override); putProjectOverride(upsert)/clearProjectOverride(delete) SET/CLEAR/re-set symmetry + idempotent clear; shared assertRevisionOrThrow (missing=PRECONDITION, stale=CONFLICT). 6-test integration green.
  - DONE (projection + resolution + routes + authz, this session): (1) `lib/evaluations/methods-registry.ts` — `registerPackageMethods`/`resyncMethods` project `manifest.spec.evaluationMethods[]` → `evaluation_method_revisions` (INERT parse via `loadEvaluationMethod`, per-install immutable rows, upsert on (install,method), invalid → report-only w/ validationErrors), `deriveMethodHealth` (ready|degraded|incompatible from trust+compat+errors, never persisted), `listMethodologies`, `setMethodActivation` (enable gated on ready). Wired into `packages/attach.ts` after `resyncAgents`. (2) `lib/evaluations/resolution.ts` — `resolveEffectiveProfile` precedence (method hard constraints → profile hard bounds → panel → project override → per-study) + structural-invariant enforcement (quorum≤attempts, maxParallel≤cap−1) + immutable snapshot; `assertOverridesAllowed` reused at override write-time. (3) Admin routes `/api/admin/evaluations/{methodologies[+/{id}/activation], judge-panels[+/{id}], profiles[+/{id}]}` (global admin) + project route `/api/projects/{slug}/evaluation-profiles/{profileId}/override` (GET/PUT/DELETE, project admin); `config-schemas.ts` (strict zod + DTO projections, no secret leak), `route-helpers.ts` (evalStatusForCode 422/409/404, If-Match). (4) authz `manageProjectEvaluationOverrides` + full eval action set. 18 tests green (10 projection/resolution integration + 8 schema/DTO unit). CO-EVOLVE: OpenAPI doc + full route authz E2E land in Phase 5.
  - Files: web/lib/evaluations/config/*, admin/project API routes, web/lib/authz.ts, token/action contracts.
  - RED: global/project permissions, optimistic revisions, hard-bound/allowed-override precedence, SET/CLEAR/re-set, dependency degradation, usage-guarded delete, immutable method revisions, historical snapshot stability.
  - GREEN: typed services and explicit DTOs; no secret/concrete credential in portable method.
  - Acceptance: changed Panel/Profile never mutates an existing Evaluation Execution; disabled/degraded dependency blocks new starts with actionable reason.
  - Logging: DEBUG resolution tiers and bounded IDs; INFO admin changes; WARN degraded dependencies; ERROR rejected overrides; never secret/env values.
  - Depends on: T1.1, T2.1.

- [x] T3.2 RED/GREEN/REFACTOR objective-check registry, execution, metrics, and replicate distributions.
  - DONE (live source reader, this session): `lib/evaluations/objective/source.ts` — `loadObjectiveFactSource` builds the live `ObjectiveFactSource` from REAL readers (`gate_results` → settled `passed`/`failed` verdicts only via pure `mapGateVerdicts`; `artifact_instances` current rows → `resolveArtifactCompleteness` against the required def set) + supplied platform facts (registered host profiles, per-participant diffStats); `schemaContract` stays honest-absence in M46; a null runId (removed observed link) yields honest absence — NEVER a source-appearance PASS. 5 pure-mapper unit + 4 live-reader integration tests green (end-to-end into `evaluateObjectiveCheck`: failed-gate→failed, missing-artifact→failed, no-gates→not_run, unregistered-host→unavailable). CO-EVOLVE: distribution UI surfacing (metrics.ts already built) lands with T5.2.
  - DONE (registry+execute+metrics, prior session): closed provider registry already frozen in `method-schema.ts` (`OBJECTIVE_CHECK_PROVIDERS` — 5 non-executable providers, no package command). `lib/evaluations/objective/providers.ts` — pure adapters (`evaluateObjectiveCheck`) over an injected `ObjectiveFactSource`; never infers PASS from source appearance (`schema_contract`/`diff_stats` → unavailable when uncaptured; `trusted_host_check` → unavailable unless the named host profile is registered, then not_run pending capture — no source-appearance PASS); exhaustive-switch guard. `lib/evaluations/objective/execute.ts` — `runObjectiveChecks` writes normalized `evaluation_objective_check_runs` + `evaluation_metric_results` rows in one tx (honest status/reason, metric-missing → `unavailable` never 0, gate-fail/gate-unresolved summary). `lib/evaluations/metrics.ts` — pure replicate distributions (median/P90/variance/mean/successRate, missing→null never 0) + cost-to-success (unavailable when unpriced, D18) + timing intervals (wall/queued/active-minus-HITL), all carrying `METRICS_FORMULA_VERSION`. 22 tests green (11 provider unit + 10 metrics unit + 1 execute integration).
  - CO-EVOLVE (with T2.3 capture + T5.2 UI): populating the live `ObjectiveFactSource` from real gate_results/artifact_instances/evidence-manifest/registered-host-profile readers, and surfacing distributions in the Study Lab. The injected-seam design keeps the registry + honest-status + distribution logic verified now.
  - Files: web/lib/evaluations/objective/*, metrics/*, trusted-check profile adapter, existing gates/artifacts/cost/session readers.
  - RED: status/reason rules, no source-appearance PASS, gate/check policy, objective-to-criterion policy, missing price, timing interval formulas, replicate median/P90/variance/success/cost-to-success.
  - GREEN: closed provider registry, normalized check/metric rows, formula/version provenance.
  - Acceptance: package cannot supply a command/script; trusted host check preconditions/trust are verified before execution; not_run/unavailable is visible.
  - Logging: INFO check lifecycle/metric counts; WARN not_run/unavailable/price missing; ERROR provider failure; no command output/evidence body unless stored as access-controlled evidence item.
  - Depends on: T2.3, T3.1.

- [x] T3.3 RED/GREEN/REFACTOR evaluation dispatcher, durable events, SSE replay, retries, poison policy, and recovery.
  - DONE (scheduler arm + start + SSE + poison, this session): `evaluation_dispatch` scheduler job-kind wired end-to-end (schema `SchedulerJobKind` union + both `job_kind` text-enums — NO DDL migration, text-enums carry no DB constraint; `job-catalog` ALL/CATALOG/SEEDED_SINGLETON; `budgets` key+limit=1 singleton; `claimDueJobs` CTE budget VALUES + all 3 CASE branches; seeded `evaluation_dispatch.dispatcher` in `ensureDefaultSchedulerJobs`; `tick-service` handler case). `lib/evaluations/dispatcher/start.ts` — `startEvaluationExecution` (resolve+snapshot effective profile via `resolveEffectiveProfile` + objective/judge/aggregation policy snapshots from the same method revision + `evaluation.queued` event + idempotency-key dedupe) + `retryFailedExecution` (copies snapshots, `retry_of` lineage, refuses non-terminal) + `deriveEvidenceProtocolDigest`. `lib/evaluations/dispatcher/tick.ts` — `runEvaluationDispatchTick` drives `queued→capturing→checking→judging` via CAS `advanceExecution` over an injectable step seam (`captureEvidence`/`runChecks`/`launchPanel`/`advancePanel`), reaps timed-out judge attempts (per-execution `timeoutMs`), re-checks judging panels (recovery), and poison-terminalizes capturing/checking failures to `failed` with bounded `retry_of` recovery (respects method `maxRetries` via a `retryDepth` chain walk); `runChecksForExecution` runs the live objective checks (T3.2); `kickEvaluationDispatch` immediate in-process kick. SSE route `GET /api/projects/[slug]/evaluations/studies/[studyId]/stream` replays the durable `evaluation_events` log by Last-Event-ID + server-side poll (read model, not a state-transition trigger; ownership-guarded, `readEvaluationStudies`). 4-test `dispatch-tick.integration.test.ts` green (full FSM walk queued→…→completed; poison→failed+retry successor; timeout→partial; durable event types asserted) + scheduler unit/integration updated (job-catalog count, jobs bootstrap=8 singletons, claimDueJobs CTE 10/10). 86 eval unit green; typecheck baseline-only. CO-EVOLVE: production `launchJudgePanel`→supervisor MCP token materialization (T4.1 debt); the `POST .../evaluations` start route lands with T5.2.
  - DONE (durable substrate, prior session): `lib/evaluations/dispatcher/fsm.ts` — pure allow-list `EVALUATION_TRANSITIONS` (aggregating non-cancellable; terminals have no edges) + `assertTransition` (illegal → CONFIG) + `eventTypeForTransition` (one emitter per waiting transition per the AsyncAPI list). `lib/evaluations/dispatcher/advance.ts` — `advanceExecution` intent-first exact-value CAS on (status,version) → mapped CONFLICT (never raw), event appended in the SAME tx (exactly-once, replayable), terminalAt/startedAt written with the flip (no post-terminal write); `createRetryExecution` creates a NEW queued row with retry_of, refuses to re-enter a terminal row. `lib/evaluations/dispatcher/events.ts` — `appendEvaluationEvent` (per-Study monotonic sequence, study-row FOR UPDATE so UNIQUE(study,sequence) never collides), `readEvaluationEvents` (Last-Event-ID replay by sequence), `formatSseFrame` (id=sequence). 11 tests green (5 FSM unit + 6 advance/events integration: lifecycle walk, illegal-transition CONFIG, stale-CAS CONFLICT, monotonic events, Last-Event-ID tail replay, retry lineage + non-terminal-retry refusal).
  - CO-EVOLVE (with Phase 5 study-start service): the scheduler job-kind ARM (`evaluation_dispatch` enum + budget + claimDueJobs CTE wiring + tick handler that drives capture→check→judge→aggregate via advanceExecution) + immediate in-process kick + the `GET .../{studyId}/stream` SSE route (both hang off the Study-start service + study routes that land in T5.2); poison-item terminalization + armed-at retry/backoff reuse the M24 job failure-backoff + the FSM's retry_of lineage. The CAS/event substrate that the tick handler drives is verified now.
  - Files: web/lib/evaluations/dispatcher/*, scheduler job/handler registration, domain-event integration, instrumentation kick, Study SSE route/hook, evaluation event projector.
  - RED: real runSchedulerTick jobKind wiring; immediate kick + restart recovery; capped-scan progress past ineligible rows; armed-at retry budget/backoff; poison item; Last-Event-ID replay; cancellation and duplicate claim races.
  - GREEN: intent-first CAS state machine with per-item attempt marker/keyset progress and bounded concurrency.
  - Acceptance: every wait state has exact emitter/recovery; no hidden client polling; new scheduler arm is exercised end to end.
  - Logging: DEBUG claims/cursor/attempt numbers; INFO state changes; WARN retry/backoff/poison/partial; ERROR terminal worker failure; redacted IDs/counts only.
  - Depends on: T2.3, T3.1, T3.2.

Phase 3 exit: unit/integration/contract green; dispatcher wiring and SSE replay green; full web suites green.

### Phase 4 — Multi-judge execution, aggregation, review, and verdict

- [x] T4.1 RED/GREEN/REFACTOR dedicated judge token, attempt launch, sealing, attribution, and bounded repair.
  - DONE (pure cores, prior session): `lib/evaluations/judges/result-validation.ts` — `validateJudgeResult` strict per-criterion validation against method criteria (fail-CLOSED: out-of-range score / scored-without-score / unknown criterion / out-of-[0,1] confidence / missing-required → terminal INVALID with violation list; absent non-required → insufficient_evidence NEVER zero). `lib/evaluations/judges/blinding.ts` — deterministic `seededShuffle` (mulberry32, no Math.random) + `assignBlindLabels`. 10 unit tests green.
  - DONE (integration seam, this session): (1) `types/token-scopes.ts` new `evaluations:{context,evidence,objective,result}:{read|submit}` scopes (NOT in `AGENT_TOKEN_SCOPES`) + `EVALUATION_JUDGE_TOKEN_SCOPES` + `issueJudgeAttemptToken` in `lib/agents/tokens.ts`. (2) Evaluator MCP facade tools `evaluation_{context_get,evidence_list,evidence_read,objective_results,result_submit}` in `mcp/src/tools.ts` TOOL_SPECS + resolveRouting; token-bound ext routes under `app/api/v1/ext/evaluations/*`; OpenAPI ops+schemas (`evaluations` tag); tool-contract + tools + scope-contract tests green. (3) `lib/evaluations/judges/facade.ts` — `resolveBoundAttempt` (token→attempt, no client ids; UNAUTHORIZED/CONFLICT refusals) + `getEvaluatorContext`/`listBoundEvidence`/`readBoundEvidenceItem`/`getBoundObjectiveResults` (blind labels, no real participant ids). (4) `lib/evaluations/judges/seal.ts` — `submitBoundJudgeResult` seals valid → criterion rows + attempt completed + token revoke; invalid → terminal-invalid attempt; triggers panel completion. (5) `lib/evaluations/judges/launch.ts` — `provisionJudgeAttempts` (idempotent ON CONFLICT matrix) + `launchJudgePanel` (duplicate-launch adoption, timeout-clock-at-Running, injectable spawn seam; `defaultJudgeSpawn` wires `launchAgentRun` workspace:none). (6) `lib/evaluations/aggregation/worker.ts` — AttemptResult adapter + `evaluateAndAdvancePanel`/`runAggregationForExecution` making FSM `judging→aggregating→(completed|partial|review_required)` LIVE feeding T4.2 `computeAggregate`. 7-test `judge-seam.integration.test.ts` green (416 eval+token unit / 53 eval integ / 229 mcp / typecheck baseline-only / contracts green).
  - CO-EVOLVE debt (Phase 5): production token→evaluator-facade MCP materialization (supervisor delivers the judge token to the agent MCP config) + the real dispatcher arm that transitions checking→judging then calls `launchJudgePanel`; bounded repair CHILD attempt spawn (invalid → repair) is a follow-up (seal marks invalid terminal; repair lineage columns exist).
  - Files: web/lib/evaluations/judges/*, web/lib/agents/tokens.ts, web/types/token-scopes.ts, external routes, mcp/src/tools.ts, agent launch trigger/idempotency.
  - RED: exact scopes, token-bound context, no peer result, blind/random order, dedicated agent Run per attempt, run_sessions attribution, invalid schema/ref/range, timeout/cancel/late submit, timeout clock anchored at session Running (cap-queued attempt never times out before start), duplicate launch adoption, token revocation.
  - GREEN: panel execution and normalized attempt/criterion writes; bounded repair lineage.
  - Acceptance: agentRunId/runner/model/method/evidence attribution is server-derived; no general agent mutation scopes; previous advisories cannot anchor a new independent attempt.
  - Logging: DEBUG attempt/role/ordinal/digests; INFO launch/terminal; WARN repair/timeout/exclusion; ERROR invalid/poison; never rationale/result/evidence body.
  - Depends on: T3.3.

- [x] T4.2 RED/GREEN/REFACTOR quorum, aggregation, disagreement, and partial-panel semantics.
  - DONE (this session): `lib/evaluations/aggregation/algorithms.ts` — pure `computeAggregate` for weighted_mean@1/median@1/majority@1 (deterministic, unrounded internally + explicit display rounding, invalid-attempt exclusion w/ reason, quorum-vs-valid-count, missing criterion → insufficient_evidence with weight-renormalized total NEVER zero, item/total cap enforcement, majority ties→lowest deterministically). `disagreement.ts` — `classifyDisagreement` over score spread / confidence spread / insufficient-evidence asymmetry / objective contradiction / panel completeness with EXPLICIT inclusive thresholds; low disagreement never relabeled as confidence; incomplete panel is a signal, not agreement. `persist.ts` — `persistAggregate` append-only (digest-anchored to method definition+schema digests, revision-incrementing, exact included/excluded attempt ids, unrounded calc + display values, quorum decision, dispersion). 11 tests green (10 golden unit + 1 persist integration).
  - CO-EVOLVE (with T4.1): feeding real `evaluation_judge_attempts` → `criterion_results` into `computeAggregate` (the AttemptResult adapter) + the worker handler that runs aggregate→disagreement→review-or-complete on the T3.3 FSM. The math + persistence are verified now.
  - Files: web/lib/evaluations/aggregation/*, disagreement/*, worker handler.
  - RED: property/golden tests for weighted_mean@1, median@1, majority@1; missing/NA/insufficient; cap enforcement; unrounded math; threshold inclusivity; objective contradiction; no cross-method aggregation; quorum/retry interaction.
  - GREEN: deterministic persisted aggregates and durable review flags.
  - Acceptance: every number traces to exact attempt/objective IDs and algorithm digest; missing never becomes zero.
  - Logging: INFO algorithm/version/quorum/counts/digest; WARN disagreement/partial/exclusion; ERROR invariant violation; no rationales.
  - Depends on: T4.1, T3.2.

- [x] T4.3 RED/GREEN/REFACTOR disagreement review and append-only human verdict.
  - DONE (route surface + social mirror, this session): session-auth `POST/GET .../studies/[studyId]/verdicts` (concludeEvaluationStudy; SESSION route so a judge/agent ext token can NEVER reach it; cites terminal executions only, zero-citation ack gate, NO Run mutation/promotion) + `PATCH .../reviews/[reviewId]` (resolveEvaluationReview, If-Match CAS→409) already landed `5b4d386b9`; NEW this session — `recordVerdict` emits the social-board `task_activity` `evaluation_decided` mirror in the SAME transaction as the verdict row + `verdict.recorded` event + open→decided flip (bounded metadata only, via the canonical `recordTaskActivity`; migration `0108_evaluation_verdict_activity` additively widens the `task_activity_event_kind` CHECK). 7-test verdicts integration green (incl. the new mirror assertion) + 6-test routes integration + journal-integrity(15) + drift-check(2) green. CO-EVOLVE residual: a domain_event mirror (M32 taxonomy extension) for outbound/webhook consumers is deferred — the in-tx task_activity satisfies the "row + event/activity atomically" acceptance.
  - DONE (services, prior session): `lib/evaluations/verdicts.ts` — `recordVerdict` append-only human verdict in ONE tx (study FOR UPDATE → verdict row + `verdict.recorded` event + open→decided flip; NO Run mutation/promotion/abandon): cites Completed/terminal-Partial executions only, zero-citation requires the no-evaluation-evidence ack (also DB CHECK), Partial citation requires acknowledged comparability warnings, cross-study citation refused, supersede requires a rationale; `listVerdicts`. `lib/evaluations/reviews.ts` — `openReview` (emits review.required) + `resolveReview` (status/version CAS → 409 on stale, emits review.resolved) + `listReviews`/`studyIdForExecution`. authz `concludeEvaluationStudy`(member)/`resolveEvaluationReview`(admin) already added. 7 tests green (verdict terminal-citation/ack/partial-warning/supersede + review CAS-409).
  - CO-EVOLVE (with Phase 5 study routes): the human-session POST `.../{studyId}/verdicts` + POST `.../{evaluationId}/reviews` routes (route-level human-only + judge-token refusal + Idempotency-Key/If-Match); task-activity/domain-event mirror. The append-only tx + no-side-effect invariant is verified now.
  - Files: web/lib/evaluations/reviews.ts, verdicts.ts, session routes/server actions, task activity/domain events, authz.
  - RED: human-only, terminal Completed/Partial requirement, zero-citation verdict with no-evaluation-evidence acknowledgement (and refusal without it), warning acknowledgement, If-Match/idempotency, supersede-with-reason, judge/token refusal, no Run mutation/promotion/abandon.
  - GREEN: review resolution and conclusive human verdict history.
  - Acceptance: verdict transaction writes row + event/activity atomically; external side effects are absent.
  - Logging: INFO actor ID/study/outcome/execution refs; WARN Partial acknowledgement/supersede; ERROR auth/state conflict; never rationale/comment body.
  - Depends on: T4.2.

Phase 4 exit: judge/MCP/external contract suites green; real multi-judge wiring green; cancellation/race suite green; existing hardcoded judge compatibility green.

### Phase 5 — Evaluation Foundation UI, compatibility, and rollout

- [ ] T5.1 RED/GREEN/REFACTOR admin Evaluations settings UI.
  - Files: web/app/(app)/settings/evaluations/*, methodology/panel/profile components, typed clients/actions, EN/RU messages.
  - RED: RBAC, package provenance/compatibility/errors, role bindings, effective preview, stale revision, keyboard/focus, dense/degraded states.
  - GREEN: Methodologies/Panels/Profiles CRUD/activation with no raw IDs/secrets.
  - Logging: client logs none beyond existing error boundary; server actions use structured config-change logs from T3.1; never form secrets.
  - Depends on: T3.1.

- [ ] T5.2 RED/GREEN/REFACTOR full-page creation and N-way Study Lab.
  - Files: existing experiments routes/components replaced or adapted; new creation steps; task/run contextual entry actions; typed selectors; scoreboard/heatmap/progress/verdict components; URL-state helpers; screen docs as-built labels.
  - RED: two entry actions, observed selection, partial/active warnings, N-way default, pairwise-only diff picker, distributions, objective/judge progress, missing data, long labels/large N, responsive/keyboard/focus/live regions, role-safe CTAs, EN/RU.
  - GREEN: guided flow and Study Lab over canonical APIs/SSE; legacy deep links render migrated Studies.
  - Acceptance: no raw JSON/CSV/free-text runner refs; effective trust/materialization preview before launch; localized actionable errors.
  - Logging: no evidence/body/client telemetry; server actions log bounded IDs/action/state only.
  - Depends on: T2.2, T3.3, T4.3, T5.1.

- [ ] T5.3 Complete foundation E2E, migration, privacy, and current-Experiment regressions.
  - Files: web/e2e/evaluation-lab.spec.ts, admin evaluation settings spec, existing experiment-comparison.spec.ts, focused integration suites and runner config if needed.
  - Scenarios: migrate legacy concluded/running; compare 2..N observed incl. active/failed; no semantic mutation; configure panel/profile; immutable snapshot; multiple judges/quorum/disagreement; human verdict; EN/RU; viewer/member/admin; secret/path sentinels; SSE replay.
  - Acceptance: playwright.config.ts testMatch includes every new spec; test listing proves execution; all touched assertions migrated in this phase.
  - Logging: E2E fixtures use synthetic safe data; test output may show IDs/statuses, never real local paths/secrets.
  - Depends on: T5.2.

- [ ] T5.4 Deploy M46 with expand/verify/rollback gates and release core/v1.1.0.
  - Actions: backup; drain old web; run migrations; verify parity SQL/digests; deploy engine 3.2.0; install/trust core/v1.1.0; enable default Method/Panel/Profile; smoke observed Study and legacy route; monitor worker/SSE/store; retain legacy tables.
  - Acceptance: no mixed writer version; rollback decision point recorded before first new write; validation commands below green; operator can disable method/profile without deleting history.
  - Logging: deployment logs versions/migration counts/health only; no DB row bodies or package prompt content.
  - Depends on: T1.3, T5.3.

Phase 5 / M46 exit: AC-01..18 and AC-22..25 green; default SDD method operational; existing Experiments still usable.

### Phase 6 — M47 Controlled Evaluation Expansion

- [ ] T6.1 Freeze and implement typed Evaluation Recipe/input-contract preflight.
  - Files: evaluation recipe schema/service, Flow/package catalog/resolver, form/output/artifact contract compatibility, preflight API.
  - RED: alternative Flow exact compatibility, missing required artifacts, incompatible form schema, trust/engine failures, stale package revision, no side effects on refusal.
  - GREEN: immutable recipe references explicit Flow/package revision and mappings; first scope exact compatible contracts only.
  - Logging: DEBUG contract/digest IDs; INFO preflight result; WARN comparability limitation; ERROR typed refusal; no task input/source bodies.
  - Depends on: M46.

- [ ] T6.2 Implement slot-keyed agent/runner/model bindings and immutable materialization recipe snapshots.
  - Files: runner-slots/resolver, evaluation recipe UI/API types, launchRun input seam, run_sessions insertion, capability/MCP/materialization resolvers.
  - RED: every session and consensus slot; unknown/stale slot; explicit agent binding; concrete runner model vs requested intent; exact run_sessions rows; all capability/MCP/materialization digests; no primary-session-only false claim.
  - GREEN: slot-keyed override map resolved before worktree; resolved server snapshots persisted through normal run launch.
  - Acceptance: model selection is honored by concrete runner snapshot or refuses/records an allowed mismatch; never persist an unenforced modelId claim.
  - Logging: DEBUG slotKey/resolution tier/requested-vs-launched safe model labels; WARN allowed mismatch; ERROR unbound/refused; never credentials/env.
  - Depends on: T6.1.

- [ ] T6.3 Implement durable controlled batch intents, interaction policy, and launched-participant invariants.
  - Files: evaluation launch batch/dispatcher, standard run launch idempotency seam, ExecutionPolicy preview, promotionHold, relaunch/GC consumers.
  - RED: partial batch/crash windows; duplicate click; retry/adopt; supervised/assisted/unattended-within-policy; human nodes/HITL; stuck/budget/check/promotion interactions; no-blind-ship; auto-promotion exclusion at query and apply site.
  - GREEN: one batch with per-item state and explicit recovery; promotion hold on every launched participant.
  - Logging: INFO batch/item transitions; WARN partial/retry/stuck; ERROR terminal item; no prompt/materialized path.
  - Depends on: T6.2, T3.3.

- [ ] T6.4 Complete controlled creation UX and materialization/trust/cost-scope preview.
  - Files: creation steps 2–5, typed searchable selectors, graph slot editor, policy expander, preflight result panels, EN/RU/a11y.
  - RED: large slot sets, alternative revisions, incompatible inputs, degraded MCP/agent/model, active partial batch, role-safe unattended control, keyboard/focus/responsive.
  - GREEN: no raw JSON/IDs; user sees effective per-slot runner/model, capabilities, MCPs, policy axes, promotion hold, evidence scope, and estimated token attempt count.
  - Logging: client none; server preflight bounded structured logs only.
  - Depends on: T6.1–T6.3.

- [ ] T6.5 Complete M47 integration/E2E/contracts and deploy behind Profile enablement.
  - Scenarios: hybrid Study; alternative compatible Flow; incompatible refusal before worktree; N-slot run_sessions; MCP/materialization trust; partial batch recovery; unattended-within-policy no-auto-promotion.
  - Acceptance: AC-19..21 green; all M46 regressions green; method/profile can disable controlled recipes independently if rollout degrades.
  - Logging: synthetic fixtures only; deployment health/counts, no evidence.
  - Depends on: T6.4.

### Phase 7 — M48 Advanced Evaluation

- [ ] T7.1 Add pairwise and tournament Evaluation Methods without changing the Study/participant/evidence model.
  - RED: pair generation/order, ties/byes, incomplete matches, quorum per match, tournament aggregation provenance, pairwise UI only where intrinsic.
  - GREEN: pairwise_tournament@1 registry + method schema mode; N-way overview remains default.
  - Logging: INFO match/round IDs and state; WARN incomplete/byes/disagreement; no result rationale.
  - Depends on: M47.

- [ ] T7.2 Add scheduled suites, package-upgrade regression Studies, and calibration/longitudinal read models.
  - Reuse M24 scheduler/domain events; no second clock. Define benchmark/suite parent outside the one-task Study; every generated Study remains one project/task.
  - RED: capped-scan progress, armed-at retry budget, poison suite, package revision change trigger, private-data minimization, calibration ground-truth and drift versioning, real dispatcher arm.
  - GREEN: versioned suite definitions and longitudinal metrics over immutable evaluations.
  - Logging: bounded suite/study/package IDs, counts and drift flags only.
  - Depends on: T7.1.

- [ ] T7.3 Add optional human-approved execution-recipe standardization.
  - This is not automatic Run promotion. A project admin may copy a winning immutable recipe into a project default/profile only after a conclusive human verdict and a fresh compatibility/trust preflight.
  - RED: judge/token refusal; stale dependency; incompatible Flow; two-phase config update; audit/supersede; no Run status change.
  - GREEN: explicit preview/confirm/audit path with rollback to prior project config revision.
  - Logging: INFO actor/project/recipe/config revisions; WARN changed dependency; ERROR refusal; never credentials or materialization bodies.
  - Depends on: T7.2.

M48 exit: advanced capabilities are separately labeled/shipped; M46/M47 contracts remain compatible; no machine can standardize or promote a winner.

## Exact Validation Commands

Run from repository root unless noted:

```sh
pnpm validate:docs:all
pnpm validate:contracts
pnpm --filter maister-web typecheck
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter maister-web test:e2e -- evaluation-lab.spec.ts
pnpm --filter maister-web test:e2e -- experiment-comparison.spec.ts
pnpm --filter maister-web test:e2e -- evaluation-settings.spec.ts
pnpm --filter @maister/mcp test
```

Before each phase exit:

- use vitest --project unit --list and --project integration --list for every new file family;
- run migration journal/snapshot integrity and 0090→010x backfill tests;
- run the new package compatibility command against all discoverable maister-plugins tags and the candidate core/v1.1.0 clean checkout;
- run focused ESLint on changed files plus the repository-required lint gate;
- run the full web unit and integration suites, not only focused tests;
- treat missing Docker/Testcontainers as an explicit environment blocker for integration/E2E, never as a green product result.

## Rollout and Operational Gates

1. Spec gate: Phase 0 approved; contracts and status labels consistent.
2. Compatibility gate: current packages/Experiments green before new package tag.
3. Expand gate: backup, drained writer, migrations/backfill parity.
4. Dark gate: methods/panels/profiles present but disabled; evidence capture synthetic smoke.
5. Internal enablement: default core method on one noncritical project; compare existing Runs only.
6. Controlled enablement: M47 Profiles opt in per project; promotion hold verified.
7. General enablement: after privacy, worker recovery, quorum, migration, and EN/RU/a11y telemetry show no blocker.
8. Contract migration: 0107 only after rollback window, parity queries, and legacy API/MCP sign-off.

Metrics/logging for rollout are metadata-only: execution counts/status/retry/latency/token totals/coverage categories. They must not persist source, prompts, diffs, evidence bodies, secrets, or private paths.

## Explicit Non-Goals

- Cross-project or cross-task participants inside one Study.
- Arbitrary executable aggregation scripts or package-supplied objective-check commands.
- Sending an unbounded repository or unrestricted filesystem/MCP access to judges.
- Automatic judge conclusion, winner promotion, loser abandonment, or project-default mutation.
- Silent Flow input coercion or arbitrary schema mapping in M47.
- A universal score across incompatible methods.
- Dollar cost without a versioned pricing catalog.
- Dataset marketplace, cross-run artifact reuse, external evidence ingestion, or remote blob storage in M46.
- Scheduled suites, package regressions, calibration analytics, tournament methods, and recipe standardization in M46.
- Dedicated UX for evaluating active Runs beyond coverage classes and comparability warnings.
- Project-linked agent bindings in Judge Panels (M46 binds package-qualified platform agents only).
- A Study-level bulk “stop losing participants” action (existing per-run workbench actions suffice; revisit only on real usage friction).

## Final Completeness and Logical-Hole Review

- Ownership: Study owns participants/recipes/verdict; Evaluation Execution owns one method/profile/evidence/panel result; Method is immutable package content; Panel/Profile are mutable configuration snapshotted at start.
- Wakeups: every queued/capturing/checking/judging/aggregating/cancelling state has an event emitter, immediate kick, durable backstop, retry budget, and recovery predicate.
- Observed safety: observed membership has no path into launched-lineage predicates.
- Historical immutability: method/profile/prompt/schema/evidence/runner/model/MCP/aggregation inputs are snapshotted and digested.
- Judge independence: attempt-bound tokens, sealed peer results, independent Runs, blind/randomized labels.
- Evidence symmetry: exactly one snapshot per execution, shareable across executions when participant set and evidence-protocol digests match; per-participant coverage difference is explicit and policy-controlled.
- Aggregation validity: one method per execution, strict result states, no missing-as-zero, exact algorithm/version/inputs.
- Flow/runtime truth: recipes key every stable session/consensus slot and persist run_sessions snapshots; no fake model override.
- Trust/privacy: no content execution before trust; no path/env/secret/source body in public DTO/log; evaluator retrieval is bounded.
- Migration: all legacy rows/JSON preserved or migration aborts; no destructive contract step in M46.
- Race safety: participant removal/start, batch fan-out, attempt submit/timeout/cancel, quorum/retry, verdict/supersede all have row locks/CAS/idempotency.
- Retention: observed selection does not hold a workspace; immutable evidence survives allowed Run cleanup; deletion is audited and recoverable.
- UI closure: every creation path can preflight, launch/capture/evaluate, inspect progress/results, and reach a human verdict or actionable refusal.
- Scope truth: M46, M47, and M48 status labels prevent future capability from appearing implemented early.

When all Phase 0 checks are approved, implementation starts with T1.1 or T2.1 as dependency order permits, using the RED → GREEN → REFACTOR gates above. Do not implement directly from this plan if Phase 0 changes any locked contract; update the plan and traceability matrix first.
