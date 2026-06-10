# Implementation Plan: Harness-Loop Foundation (A+B+C)

Branch: feature/harness-loop-foundation
Created: 2026-06-10
Mode: full

Foundation of the harness self-correction / steering loop, in three tracks:

- **A — Observatory harness adequacy & coherence** — the SENSING layer (read-only).
- **B — P1 structured node output channel** — the keystone (ADR-063, M26 "Designed" → runtime).
- **C — P3 artifact post-conditions** — deterministic mutation sensor (`must_touch` / `must_not_touch`).

These are PREREQUISITES for the later automatic self-correction loop (P2 injection +
P4 routing + loop assembly) — explicitly OUT of this plan.

## Settings

- Testing: **yes** (unit + integration per track; e2e for Track A)
- Logging: **standard** — match existing pino conventions (`log.info({...}, "msg")`
  transition logs); new seam functions add DEBUG extraction traces, WARN for
  optional-validation/advisory failures, INFO for state writes. No `console.log`.
- Docs: **yes** — mandatory docs checkpoint; route docs changes through `/aif-docs`,
  honor `docs/CLAUDE.md` R1–R9 (`pnpm validate:docs` must pass on every docs commit).

## Roadmap Linkage

Milestone: "none"
Rationale: No matching open milestone in `.ai-factory/ROADMAP.md` (open: M14, M20, M27 —
all owned elsewhere). This work completes the P1 half of ADR-063/M26 (plan
`feature-m26-structured-output-run-context.md`, milestone never entered ROADMAP) and
implements P1+P3 of `docs/pv/improvement-roadmap.md`; treat as a new milestone entry
(suggest "M29. Harness-loop foundation") to be added via `/aif-roadmap` at completion.

## Hard constraints (collision map — read before touching anything)

- **DO NOT TOUCH** (owned by the in-flight `feature/review-comments-rework` branch,
  worktree `gifted-haibt-95d342`): the runner-graph REVIEW region (`runReviewHuman`,
  `web/lib/flows/graph/runner-graph.ts` ~167–325), `web/lib/flows/hitl-validate.ts`,
  review UI components. Leave the OUTCOME region (~1662, transition resolution) for
  future P4.
- **File ownership.** A = observatory query/component/page/i18n files only (no engine
  file). B = `runner-agent.ts` (read-only hook discovery; extraction util is a new
  file), `runner-cli.ts` (env injection — addition to the prompt's list, justified:
  the cli transport must be injected where the child spawns; collides with nothing),
  a NAMED sub-function called from the runner-graph node-finalize seam,
  `output-schema.ts`, `config.ts`/`config.schema.ts`, `instance-config.ts`.
  C = `gates-exec.ts` (artifact_required case), artifact-store/materializer touch
  points, the DIFF-ARTIFACT portion of the finalize seam (helper extraction + a
  3–5-line write-if-absent node-start capture at attempt creation — outside the
  forbidden regions), `config.schema.ts`/`config.ts` (gate fields + kind + widened
  1.3.0 gate), `readiness-core.ts` (assertion-aware re-eval — see TC.4).
  A additionally owns a tiny `harnessNeverFiredMin()` reader in
  `web/lib/instance-config.ts` (additive; B adds `nodeOutputMaxBytes()` to the same
  file — pure additions, no conflict).
- **B↔C share the node-finalize seam** (`runner-graph.ts` `executeNodeAction`):
  B adds `validateNodeStructuredOutput(...)` (post-action, pre-gates); C extends the
  `artifact_required` executor in `gates-exec.ts` and extracts a shared diff-range
  helper from the produces-recording block. Edit only your named sub-function/case;
  do NOT refactor the surrounding loop. **Sequence B before C.**
- Conventions: `MaisterError` typed codes only; i18n EN+RU; strict TS; honor
  engine-version floors; no new clock; no `fs.watch`/polling; atomic `.maister/`
  writes; surgical changes.
- **No new HTTP routes anywhere in this plan** → the skill-context two-phase-commit,
  body-controlled-identifier, and deferred-release rules are N/A by construction.
  No new deferreds are created.
- **No DB migrations expected.** `node_attempts.vars` exists; `artifact_instances.kind`
  and `.producer` are **text columns with TS-level enums** (`schema.ts:1537–1554`),
  not pg enums — adding `mutation_report` needs no DDL. If any task discovers a real
  DDL need, stop and re-plan (Drizzle `_journal.json` drift gotcha).

## Verified substrate facts (file:line, checked 2026-06-10 on this branch)

### Track A

- Read models: `web/lib/queries/observatory.ts` (`getPortfolioObservatory`,
  `getProjectObservatory`, `getNodeObservatoryDetail`; bulk loader
  `loadObservatoryRows` at :422–626 — 5 bulk SELECTs over `runs+flows`,
  `node_attempts`, `artifact_instances`, `gate_results`, `hitl_requests`).
  Pure rollups in `observatory-core.ts` (`rollupCorrectionMetrics` :79–119 — retries =
  `max(attempt)-1` per (run,node); reworks = `status === "Reworked"`), signals in
  `observatory-signals.ts`. Window: `ObservatoryFilters.windowDays` default 30, clamp
  365 (`web/lib/observatory/filters.ts:24`); explicit `now` param (ADR-059 style).
- No per-gate aggregation exists today — gates only feed `clusterGateSignals`
  (blocking failed/stale → signal clusters).
- `gate_results` columns: `runId`, `nodeAttemptId`, `gateId`, `kind`, `mode`,
  `status` (`pending|running|passed|failed|stale|skipped|overridden`), `verdict`
  jsonb, `createdAt`, `endedAt`.
- `runs.flow_revision_id` EXISTS (`schema.ts:988`) → per-run revision join for the
  coverage map. `runs.resolved_capability_set` jsonb (`ResolvedCapabilitySet`:
  `{flowRevisionId, flowOrigin, capabilities[{refId,kind,sha,scope}], mcps[]}`),
  nullable on older runs.
- Declared gates live in `flow_revisions.manifest` → `nodes[].pre_finish.gates[]`
  (zod `gateSchema`, `config.schema.ts:335–373`).
- Pages: `app/(app)/observatory/page.tsx` (portfolio; `requireSession` +
  `getVisibleProjects`), `app/(app)/projects/[slug]/observatory/page.tsx` (project;
  role check → `notFound()`). Components in `components/observatory/*`; labels via
  `labels.ts` + `messages/{en,ru}.json` namespace `observatory.*`.
- Tests: `components/observatory/__tests__/observatory-components.test.ts`
  (renderToStaticMarkup, no jsdom), `lib/queries/__tests__/observatory-core.test.ts`,
  `observatory-signals.test.ts`, `observatory.integration.test.ts` (testcontainers,
  `seedObservatoryIntegration`), e2e `web/e2e/m23-observatory.spec.ts` (seeded).

### Track B

- **Phase 0 already exists**: ADR-063 (`docs/decisions.md`), frozen spec
  `.ai-factory/specs/feature-m26-structured-output-run-context.md` (has Expectations
  + spec-to-test matrix), `docs/flow-dsl.md` §M26 (:497–552), 
  `docs/system-analytics/flow-graph.md` §"Structured output validate seam" (:161–202)
  + edge cases (:416–445), `docs/configuration.md` env table row (:915). All tagged
  **(M26 — Designed)**. The run-context file (P7) sections stay Designed — P7 is OUT.
- Transport contract (flow-dsl.md :532–552): agent/judge = LAST sentinel block
  ` ```json maister:output ` in the **1 MiB-capped** `result.stdout`; block pushed
  past the cap = absent. cli/check = runner injects
  `MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json` (per-attempt; a
  non-writing rework attempt never inherits a prior file). `required` default false:
  absent+required → fail attempt; absent+optional → `vars: {}`, proceed.
- Payload cap: `MAISTER_NODE_OUTPUT_MAX_BYTES` default **262144 (256 KiB)** — host
  env only, wired to `.env.example` + `configuration.md` ONLY, never `compose.yml`
  (ADR-023 precedent, decided in configuration.md:915). Reader is specced as
  `web/lib/instance-config.ts:nodeOutputMaxBytes()` — **not implemented yet**, and
  the `.env.example` row is **missing** → TB.1.
- Engine floor ALREADY ENFORCED: `OUTPUT_ENGINE_MIN = "1.3.0"` + validateGraphManifest
  check (`web/lib/config.ts:552, 621–626`). `MAISTER_ENGINE_VERSION = "1.3.0"`
  (`web/lib/flows/engine-version.ts:18`). B adds no floor code.
- Validators EXIST, zero runtime callers: `resolveOutputResultSchema`
  (`config.ts:1118–1123`, resolves `./path` against flow install dir, formSchemaSchema
  grammar incl. nested `object`), `validateStructuredOutput`
  (`output-schema.ts:70–92`, returns `{ok}|{ok:false,message}`; tests in
  `lib/flows/__tests__/output-schema.test.ts`).
- Persistence channel: `markNodeSucceeded(nodeAttemptId, {vars, ...})`
  (`ledger.ts:128–160`) → `node_attempts.vars` jsonb → `reduceLedger`
  (`context.ts:119–143`, line 137 `vars: na.vars ?? {}`) → `buildContext` :235 →
  `{{ steps.<id>.vars.* }}`. **Non-human vars flow with zero templating changes.**
- "M17 injectedVars" = the durable rework-comments injection
  (`buildContext`/`executeStep` `injectedVars` param, mirroring graph
  `pendingInjectedVars` at `runner-graph.ts:1515–1535`; decisions.md:3368).
  **Convergence = persist through `node_attempts.vars` via `markNodeSucceeded` —
  no new column, no parallel context param.** Do not touch `pendingInjectedVars`.
- Agent text hook: `runner-agent.ts` `startEventConsumer` (:395–478) accumulates
  `buf` from `agent_message_chunk` + `session.line`; `consumer.snapshot()` is the
  capture returned as `result.stdout`. `runAgentStep` returns `vars: {}` at :581,
  :609, :719, :747. **Extraction parses `result.stdout` at the seam — runner-agent.ts
  itself needs no behavioral change** (`STDOUT_CAP_BYTES` = 1 MiB confirmed at
  `runner-agent.ts:385` — zero changes to runner-agent.ts).
- CLI execution: `runner-cli.ts` `runCliStep` (:49–159) — `execFileAsync("bash",
  ["-c", resolved], {cwd, signal, maxBuffer})` at :92, **no env passed today**;
  `RunCliStepCtx` lacks `attempt`. `judge` nodes run through the same `runAgentStep`
  (`runner-graph.ts:486–516`).
- Failure pattern: `markNodeFailed(nodeAttemptId, {errorCode: "CONFIG", stdout}, db)`
  (`ledger.ts:162–188`); existing finalize failure paths at `runner-graph.ts:1297`,
  :1381 use the same shape.
- No collision with ai_judgment gates: `parseVerdict` (`gates-exec.ts:106–214`) scans
  loose brace-balanced JSON for `{verdict: string}` — distinct from the fenced
  sentinel grammar.

### Track C

- `artifact_required` executor: `gates-exec.ts:439–506` — checks every
  `gate.inputArtifacts` def has a `validity='current'` instance
  (`getCurrentArtifact`); pass → `markGatePassed` + optional
  `gateResults.outputArtifactRef = gate.output.id`; fail → (blocking)
  `failStaleArtifactsForDef` + `markGateFailed`. `GateRunContext` (:37–43) carries
  `runtimeRoot`, `worktreePath`, `sessionState`, `db` — **worktreePath is available
  at gate time**.
- Diff artifact recording: `runner-graph.ts:1411–1471` — locator
  `{kind:"git-range", baseCommit, headRef}` where `baseCommit =
  resolveBaseRef({worktreePath, branch, mainBranch:"main"})` (= **merge-base vs
  main**, EMPTY_TREE fallback) and `headRef = resolveRefSha(...)` (immutable SHA,
  branch-name fallback when git unavailable). **The recorded diff is the CUMULATIVE
  branch diff, not a per-node delta.** Gates run BEFORE the current node's produces
  are recorded (gates :1316–1352 → produces :1354–1531) → the gate computes the
  range itself with the same helpers; nothing commits between gates and recording.
- Git exec: `web/lib/worktree.ts` `runGit(repo, args)` (:124–132, execFile,
  4 MB maxBuffer, 60 s timeout). Touched paths = `git diff --name-only
  <base>..<head>`.
- `artifact_instances.hash` / `size_bytes` (`schema.ts:1556–1557`) exist, never
  written. `producer` enum already includes `"gate"`. Locator union member
  confirmed: `{ kind: "inline"; text: string }` (`schema.ts:1509–1515`).
- `ARTIFACT_KINDS` (`config.schema.ts:279–290`); DB `kind` text-enum
  (`schema.ts:1537–1550`). **Kind consumer fan-out** (for `mutation_report`):
  `config.schema.ts` enum + `gate.output.kind`; `config.ts` `artifactKindSet`
  (:799–819); `db/schema.ts` text enum; `observatory/filters.ts`
  `parseArtifactKind`; i18n kind labels `observatory.kind.*` + artifact UI labels
  (`messages/{en,ru}.json`); `board/evidence-graph-layout.ts:56` kind switch;
  run-detail artifact renderer; `artifact-store.ts:265–295`
  `getCurrentRequiredForGitArtifacts` filters `["diff","commit_set"]` (mutation_report
  intentionally excluded — verify no change needed); docs (`artifacts.md` kind
  catalog, `database-schema.md`, `db/artifacts-domain.md`).
- **M14 restriction reality check**: a restriction capability is
  `capabilityCommon + {kind:"restriction", path?, content?}`
  (`config.schema.ts:116–121`) — **free text, NO structured glob list exists**.
  Node settings select restrictions by id (`settings.restrictions: string[]`,
  :507/:573/:583); resolver: `web/lib/capabilities/resolver.ts:324–334`
  (`selectedRecords(catalog, "restriction", selectedRestrictionIds)`); the graph
  runner resolves them at node start (`runner-graph.ts:624–639`). Enforcement today
  is `"instructed"` only (`enforcement.ts:32–40`, TODO(M14)/ADR-041) — exactly why a
  detect-after sensor is valuable. → Decision D-C2 adds an optional structured
  `paths` field to `restrictionCapabilitySchema` as the machine-readable subset.
- Readiness: `readiness-core.ts:111–128` — **CAUTION**: a `failed` artifact_required
  gate is re-evaluated and reads `"clear"` when all `inputArtifactRefs` are present
  (:119–125). An assertion-failed mutation gate HAS its inputs present → would
  silently self-clear. TC.4 makes the re-eval respect assertion verdicts.
- Glob dep: **none in web/package.json** (no minimatch/picomatch/micromatch) →
  Decision D-C5.
- Engine floor pattern to mirror: `OUTPUT_ENGINE_MIN` (`config.ts:552, 621–626`).

## Design decisions

### Track A

- **D-A1 Metric set v1** (pure rollups take thresholds as explicit params; one env
  knob — see never-fired below):
  1. *Sensor firing-rate*: per `(projectId, flowId, nodeId, gateId)` and rolled up per
     gate `kind`: counts of `passed/failed/stale/skipped/overridden` + executions
     (= rows with terminal status) + fail-rate, over the existing window.
  2. *Never-fired flag*: gate declared in ≥1 flow revision used by runs in the window
     AND executions ≥ threshold AND `failed + stale == 0` → flag "verify: quality
     or blind spot". Threshold = env `MAISTER_HARNESS_NEVER_FIRED_MIN` (default 10),
     read at the query layer (instance-config pattern) and passed into the pure
     rollup as a param (ADR-059). Per-flow override deliberately NOT in v1: this is
     a sensing-display heuristic, not flow behavior — putting it in the manifest
     would add engine surface for no loop value (revisit if the flag proves noisy).
  3. *Per-control effectiveness*: (a) per gate: P(downstream rework | gate failed on
     attempt) vs P(downstream rework | gate passed), where downstream rework for an
     attempt = a later attempt exists for the same (run, node) OR the attempt's
     status is `Reworked`; report both rates + lift. (b) per capability `refId`
     (from `runs.resolved_capability_set.capabilities[]`): correction-rate
     (reuse `rollupCorrectionMetrics`) for runs WITH vs WITHOUT the capability;
     runs with null capability set are excluded (not counted as "without").
  4. *Coverage map*: per flow (latest-used revisions in window, joined via
     `runs.flow_revision_id`; the column is nullable on legacy rows — null-revision
     runs are excluded from the declared/coverage side, firing stats unaffected):
     per node — gate count by mode, `blocking` count,
     guide-side presence (node settings declare skills/rules/restrictions) →
     "guides without sensors" imbalance flag (guides ≥1 AND blocking gates == 0).
- **D-A2 On-the-fly rollup** (ADR-059 style): pure functions over bulk rows; extend
  `loadObservatoryRows` to also select `runs.resolved_capability_set` +
  `runs.flow_revision_id`, and add exactly ONE new bulk SELECT:
  `flow_revisions WHERE id IN (distinct revision ids of scoped runs)` (manifests
  parsed in TS for declared gates + node settings). No caching, no read-model table,
  no read-cursor, no per-run query loops, no schema change.
- **D-A3 UI home**: a new "Harness" section on BOTH existing pages (portfolio +
  project), composed of three cards: SensorFiring (table, never-fired badge),
  CoverageMap (per flow), ControlEffectiveness (table). No new routes → RBAC
  inherited from existing page guards. Filters (`windowDays`, `flowId`) apply.
- **D-A4 Honest-N rule**: every rate displays its denominator (n runs / n executions);
  groups with executions < 3 render as "—" (insufficient data), never as 0%.

### Track B

- **D-B1 SSOT**: implement EXACTLY the frozen spec
  (`.ai-factory/specs/feature-m26-structured-output-run-context.md` §Transport &
  validation + `flow-graph.md` §:161–202 + `flow-dsl.md` §:497–552) — P1 parts only;
  P7 run-context stays Designed. Any contradiction discovered → record in the spec's
  assumptions section FIRST, then code (TB.0).
- **D-B2 Seam placement**: `validateNodeStructuredOutput(...)` (new named function,
  new file `web/lib/flows/graph/node-output.ts`) is called in `executeNodeAction`
  immediately AFTER the `!result.ok` action-failure check and BEFORE `pre_finish`
  gates (matches the spec flowchart `Act → Validate`). No-op when
  `node.output?.result` is undefined or node type is `human`/`form` (transport table
  covers `ai_coding|judge|cli|check`). On success MUTATES `result.vars` in place
  (spec step 5) — the single existing `markNodeSucceeded` call
  (`runner-graph.ts:1758–1766`) already persists `vars: result.vars`, so no
  call-site edits anywhere. On failure per D-B4: `markNodeFailed` CONFIG and abort
  the finish exactly like the action-failure path. The spec cites the seam at
  ~1124–1138; the file has since drifted (`!result.ok` ~:1294, gates ~:1316) —
  anchor by code shape, not line numbers.
- **D-B3 Transports**: agent/judge — parse LAST ` ```json maister:output ` fenced
  block from `result.stdout` (pure util in `node-output.ts`); cli/check — read
  `<runDir>/output-<nodeId>-<attempt>.json` (path reconstructed deterministically at
  the seam; `runCliStep` only INJECTS the env var `MAISTER_OUTPUT_FILE` into the
  child env, gains `attempt` in `RunCliStepCtx`). Raw payload > `nodeOutputMaxBytes()`
  (256 KiB default) OR unparseable JSON OR schema-invalid ⇒ treated per
  required/optional semantics below. Absent = no block found / file missing.
- **D-B4 Semantics** (revised at /aif-improve review — user picked SPEC-STRICT over
  the brief's record-and-warn): `required` governs ABSENCE only. Absent +
  `required: true` → `markNodeFailed` with `errorCode: "CONFIG"` and a one-line
  reason in the stdout context; absent + `required: false` (default) → `vars: {}`,
  silent proceed. A PRESENT-but-broken payload — oversize past
  `nodeOutputMaxBytes()`, invalid JSON, or schema mismatch — fails the attempt with
  `CONFIG` REGARDLESS of `required` (frozen-spec Expectations + AC4: a malformed
  payload is a flow defect, not an option; a silent `vars:{}` would poison
  downstream templating). Valid → folded into `result.vars` (spec step 5),
  persisted by the existing single `markNodeSucceeded` UPDATE — no new write, no
  new crash window; atomicity rule satisfied by construction.
- **D-B5 No engine work**: floor + schema + validators already shipped (M26 Phase 0 /
  Task 4). B is transport + seam + persistence + tests + status flips only.

### Track C

- **D-C1 Gate schema** (`gateSchema`, valid ONLY on `kind: artifact_required` —
  enforce via zod refine in `validateGraphManifest`):
  `must_touch?: string[]` (≥1 glob; FAIL when the diff touches NONE of the globs);
  `must_not_touch?: z.literal("restrictions")` (v1: the only legal value — reads the
  M14 restriction set, never an own path list; future explicit lists would be a new
  engine floor). Assertions evaluate per the gate's existing `mode`
  (blocking|advisory) — no new default invented.
- **D-C2 Restriction paths contract**: extend `restrictionCapabilitySchema` with
  optional `paths: string[]` — the machine-readable subset of a restriction. The
  sensor checks `diff ∩ paths`; free-text-only restrictions (no `paths`) are listed
  in the mutation_report as `unmatchable` (counted, never failed on). Single source
  of truth preserved: the same capability record feeds M14 instruction
  materialization AND this sensor; ADR-041 strict enforcement can later read the
  same field. The node's resolved restriction records are threaded into
  `GateRunContext` (new optional field `restrictionPaths`) from the node-start
  materialization site (`runner-graph.ts:624–639` already holds the resolved set);
  fallback if not reachable in scope: re-resolve via `capabilities/resolver.ts` with
  the run's snapshot — implementer picks at the seam, no new resolver.
- **D-C3 Range semantics** (revised at plan review 2026-06-10 — user call:
  `must_touch` belongs to the node that does the touching):
  - **`must_touch` is node-scoped.** Range = `<head at this node's FIRST attempt
    start>..<HEAD at gate time>` — "did this node (across its attempts) touch X
    since it first began". Capture: right after the `node_attempts` row creation in
    `executeNodeAction`, write `node-start-<nodeId>.json` `{head}` into the run dir
    via `atomicWriteJson`, **write-if-absent** — one file per (run, node); attempt
    2+ and mid-attempt checkpoint/resume keep the original, so the TRUE start
    survives process death and rework loops (a no-op rework attempt does NOT
    false-fail: attempt 1's commits are inside the range). Known, accepted
    inaccuracy: changes by OTHER nodes executed between this node's rework loops
    fall inside the range (tightly bounded window; per-ATTEMPT strict deltas are
    out of scope). File absent (legacy run, git unavailable at start) → fall back
    to the cumulative range with `basis: "cumulative-fallback"` in the report.
  - **`must_not_touch` is cumulative** — a safety net: range = `<merge-base vs
    main>..<HEAD>` via a shared `resolveDiffRange(workspace)` helper extracted from
    the produces-recording block (`runner-graph.ts:1411–1446`, diff portion only;
    same `resolveBaseRef`/`resolveRefSha` as the diff artifact). A restricted-path
    violation anywhere on the branch so far flags at every checking node —
    detection beats attribution while ADR-041 prevention is blocked.
  - Git unavailable at gate time (synthetic test envs): blocking → gate FAILS with
    reason `"git unavailable — cannot evaluate mutation assertions"`; advisory →
    warn + report records `evaluated: false`. A blocking sensor that cannot sense
    must not pass.
- **D-C4 mutation_report artifact**: ALWAYS recorded when assertions are configured
  (pass AND fail) — `producer: "gate"`, `kind: "mutation_report"`, locator
  `{ kind: "inline", text: JSON.stringify(report) }` (member confirmed,
  `schema.ts:1515`); report shape:
  `{basis: "node" | "cumulative-fallback", nodeRange: {base, head},
  cumulativeRange?: {base, head}, touched: string[] /* node range, truncated at 500
  with a truncated flag */, mustTouch: {globs, matched: string[]},
  restrictions: {checked: [{id, paths, violations: string[]}], unmatchable: string[]},
  violations: string[], evaluated: boolean}`). Write `hash` (sha256 of the locator `text`) + `size_bytes` (its byte
  length) — first writer of those columns. `artifactDefId = gate.output.id` when declared (kind must then
  be `mutation_report`), else `null` with deterministic instance id
  `run:<nodeAttemptId>:mutation:<gateId>`. Record the artifact BEFORE the terminal
  gate transition (crash between leaves gate `running` → re-executed on rework; same
  crash-window shape as the existing gate/artifact sequence, no new partial state).
- **D-C5 Glob matcher**: add `picomatch` (tiny, zero-dep, the de-facto standard) as a
  web prod dependency — the repo has no glob lib. Match against repo-relative
  POSIX paths, `dot: true`. (Deployment wiring: pure JS dep, lockfile commit only —
  no Dockerfile/compose change needed since web runs on host per ADR-023.)
- **D-C6 Engine versioning** (revised at plan review — user call: no installed base
  of older engines, bumping is ceremony): **NO version bump** —
  `MAISTER_ENGINE_VERSION` stays `1.3.0`; the fields are additive-optional. Drift
  protection reuses the EXISTING gate: widen the `validateGraphManifest` check
  (`config.ts:621–626`) so a manifest declaring `must_touch`/`must_not_touch` OR
  `gate.output.kind === "mutation_report"` also requires
  `compat.engine_min >= 1.3.0` (same constant, broader trigger). Flows not using
  the features stay valid at any `engine_min`. `restriction.paths` is capability
  config, not graph-manifest surface — additive, no floor. Bundled `aif` package
  flows untouched; they raise their own `engine_min` only if they adopt the fields.
- **D-C7 Readiness**: the mutation verdict is stored in `gate_results.verdict`
  (`payload.assertionFailed: true` + reasons). `readiness-core.ts`
  `blockingGateContribution` artifact_required re-eval (:119–125) MUST NOT clear a
  failed gate whose verdict carries `assertionFailed` — inputs-present is no longer
  sufficient. Everything else (blocking/advisory, rollup, staleness, rework
  re-execution) is inherited unchanged.

## Contract surfaces → spec files (skill-context rule)

| Surface changed | Spec file(s) to update |
| --- | --- |
| Flow DSL: `gate.must_touch` / `must_not_touch`, `restriction.paths` | `docs/flow-dsl.md` + zod in `web/lib/config.schema.ts` |
| Flow DSL: `output.result` transports go live | `docs/flow-dsl.md` §M26 + `docs/system-analytics/flow-graph.md` §M26 (status flips, P1 only) |
| New artifact kind `mutation_report` | `docs/system-analytics/artifacts.md` kind catalog + `docs/database-schema.md` + `docs/db/artifacts-domain.md` |
| Readiness assertion-aware re-eval | `docs/system-analytics/readiness.md` |
| New env var `MAISTER_NODE_OUTPUT_MAX_BYTES` reader | `docs/configuration.md` env table (row exists — flip status) + `.env.example` (MISSING — add). Host-env only per ADR-023 — explicitly NOT in compose (documented exception, mirrors `MAISTER_WORKBENCH_MAX_FILE_BYTES`) |
| Mutation gate fields under the existing 1.3.0 engine gate (no bump) | `docs/flow-dsl.md` engine-gate prose + ADR (D-C6) |
| New env var `MAISTER_HARNESS_NEVER_FIRED_MIN` (A) | `docs/configuration.md` env table + `.env.example`; host-env only per ADR-023 — no compose |
| Observatory metrics | `docs/system-analytics/observatory.md` + new ADR (D-A1..D-A4 formulas, mirrors ADR-051) |
| New decisions | `docs/decisions.md`: ADR-072 (tentative) "Harness adequacy metrics" (A), ADR-073 (tentative) "Mutation sensor post-conditions" (C) — ADR-071 is claimed by the sibling outbound-webhooks branch; RE-VERIFY numbering against main at merge (patch lesson 2026-06-09-18.47). B needs NO new ADR (ADR-063 covers it) |

No HTTP/SSE/AsyncAPI surface changes. No error-taxonomy additions (reuses `CONFIG`,
`PRECONDITION`). New env vars: `MAISTER_NODE_OUTPUT_MAX_BYTES` and
`MAISTER_HARNESS_NEVER_FIRED_MIN` (both above).

## Tasks

> Per-phase exit criteria (every phase): `pnpm --filter maister-web typecheck` = 0
> errors; full unit + integration suites GREEN (`vitest` projects already glob
> `lib/**`, `components/**`, `app/**` test dirs — all new test files land inside
> already-globbed families; if a new path family appears, extend the runner config
> in the SAME task); scoped lint only (`eslint <changed paths>` or check-only
> `eslint .` — NEVER bare `pnpm lint`, it reformats the repo). Docs-touching tasks:
> `pnpm validate:docs` green. Pre-existing reds (if any) get quarantined explicitly
> with a tracked follow-up, never silently tolerated.

### Phase 0 — Docs-first specs (A & C; B is already specced)

- [x] **T0.1 — ADR + observatory.md spec for harness adequacy (A).** Append ADR
  ("Harness adequacy & coherence metrics", tentatively **ADR-072** — ADR-071 is
  claimed by the sibling outbound-webhooks branch; re-verify the number against
  main at merge) to
  `docs/decisions.md`: D-A1 formulas (firing-rate, never-fired env threshold
  `MAISTER_HARNESS_NEVER_FIRED_MIN` default 10,
  effectiveness lift incl. exclusion of null capability sets, coverage/imbalance),
  D-A2 on-the-fly + one new bulk SELECT, D-A4 honest-N. Extend
  `docs/system-analytics/observatory.md` per R5 (entities, process flow for the new
  rollup, Expectations bullets, edge cases: zero-execution gates, null
  `resolved_capability_set`, revision drift) — tag everything **(Designed)**.
  *Files:* `docs/decisions.md`, `docs/system-analytics/observatory.md`.
  *Logging:* n/a (docs). *Verify:* `pnpm validate:docs` green; ADR follows R4
  template; no formula duplicated outside the ADR (R7).
- [x] **T0.2 — ADR + docs spec for the mutation sensor (C).** Append ADR ("Artifact
  post-conditions — mutation sensor", tentatively **ADR-073**, same merge-time
  numbering re-verify as T0.1): D-C1..D-C7 (gate fields,
  `restriction.paths` contract + `unmatchable` semantics, node-scoped `must_touch`
  + cumulative `must_not_touch` ranges incl. node-start capture file and fallback
  basis, git-unavailable behavior, mutation_report shape + hash/size first-write,
  no-bump engine gating (widened 1.3.0 check), readiness assertion-aware re-eval). Spec the
  DSL in `docs/flow-dsl.md` (gate fields table + YAML example), kind in
  `artifacts.md`, re-eval in `readiness.md`, gate-dispatch note in `flow-graph.md`
  — all **(Designed)** tags.
  *Files:* `docs/decisions.md`, `docs/flow-dsl.md`,
  `docs/system-analytics/{artifacts,readiness,flow-graph}.md`.
  *Verify:* `pnpm validate:docs`; internally consistent with D-C1..D-C7; states
  exactly what the code will gate (allow-list wording).
- [x] **T0.3 — B spec drift audit (read-only).** DONE during the /aif-improve pass
  (2026-06-10): frozen spec (§Transport/§Engine/§Expectations/§AC/§matrix) +
  `flow-graph.md` §M26 + `flow-dsl.md` §M26 + `configuration.md:915` read
  end-to-end. ONE drift found and RESOLVED: the plan's original record-and-warn
  semantics for optional+invalid contradicted the spec — user chose SPEC-STRICT
  (D-B4 revised; NO spec amendment needed). Also confirmed: seam mutates
  `result.vars` (single `markNodeSucceeded` :1758 already persists it),
  `STDOUT_CAP_BYTES` 1 MiB exists (:385), `RunCliStepCtx.attempt` threading is
  spec-mandated verbatim, spec's absolute line refs (~1124–1138) drifted — anchor
  by code shape. At implement start: skim the spec once more; no changes expected.

<!-- Commit checkpoint 1: "docs(harness): ADRs + Designed specs for adequacy metrics and mutation sensor" -->

### Phase A — Observatory sensing layer (independent of B/C; may run in parallel after T0.1)

- [x] **TA.1 — Pure rollups.** In `web/lib/queries/observatory-core.ts` add:
  `rollupGateFiringStats(gates)` (per-(flow,node,gate) + per-kind counts/rates),
  `detectNeverFired({declaredGates, firingStats, minExecutions})`,
  `rollupControlEffectiveness({gates, attempts, runs})` (gate→rework lift; attempt
  keyed maps, NO nested scans per run), `rollupCapabilityEffectiveness({runs,
  attempts})` (with/without correction-rate via existing `rollupCorrectionMetrics`),
  `buildCoverageMap({manifests, firingStats})`. `detectNeverFired` takes
  `minExecutions` as an explicit param (no baked constant — env-fed, see TA.2);
  export `MIN_GROUP_EXECUTIONS = 3` (honest-N display constant).
  *Files:* `web/lib/queries/observatory-core.ts`,
  `web/lib/queries/__tests__/observatory-core.test.ts`.
  *Logging:* none — pure functions (matches existing file).
  *Verify:* unit tests cover: empty window, never-fired vs fired-once, lift with
  zero denominators (honest-N "—"), null capability-set exclusion, multi-revision
  declared-gate union, null-`flowRevisionId` runs excluded from coverage,
  guides-without-sensors flag.
- [x] **TA.2 — Query layer wiring.** Extend `loadObservatoryRows`
  (`web/lib/queries/observatory.ts`) to select `runs.resolvedCapabilitySet` +
  `runs.flowRevisionId`; add ONE bulk `flow_revisions` SELECT (`inArray` on distinct
  revision ids of scoped runs); parse manifests (`nodes[].pre_finish.gates`, node
  settings guide presence) in TS; thread new rollups into `getPortfolioObservatory`
  + `getProjectObservatory` result types (`harness: {firing, neverFired,
  effectiveness, coverage}`). No per-run loops; no new tables.
  Threshold knob: new `harnessNeverFiredMin()` reader in
  `web/lib/instance-config.ts` (env `MAISTER_HARNESS_NEVER_FIRED_MIN`, default 10,
  invalid → default + one-time WARN), passed into `detectNeverFired`. Deployment
  wiring in the SAME task: `.env.example` row + `docs/configuration.md` env-table
  row (host-env only per ADR-023 — compose untouched).
  *Files:* `web/lib/queries/observatory.ts`, `components/observatory/types.ts`,
  `web/lib/instance-config.ts` (+ test), `.env.example`, `docs/configuration.md`,
  `web/lib/queries/__tests__/observatory.integration.test.ts` (+ seed extension in
  `seedObservatoryIntegration`: a declared-never-failed gate, a failed gate followed
  by a rework attempt, runs with/without a capability refId).
  *Logging:* keep the existing legacy-run `log.warn` pattern; no new logs unless a
  manifest fails to parse → `log.warn({flowRevisionId}, "coverage: manifest parse
  failed — revision skipped")`.
  *Verify:* integration test asserts counts from seeds; query count unchanged except
  +1 (assert via existing patterns if the suite tracks it, else code review).
- [x] **TA.3 — Components + i18n.** New `components/observatory/`:
  `sensor-firing-card.tsx` (table per gate: kind, mode, executions, pass/fail/stale,
  fail-rate, never-fired badge), `coverage-map-card.tsx` (per flow: nodes, gates by
  mode, imbalance flag), `control-effectiveness-card.tsx` (gate lift table +
  capability with/without table, honest-N dashes). Server components unless HeroUI
  forces client. Extend `labels.ts` + `observatory.*` keys in `messages/en.json` AND
  `messages/ru.json` (full parity).
  *Files:* the three components, `components/observatory/labels.ts`, `types.ts`,
  `messages/{en,ru}.json`,
  `components/observatory/__tests__/observatory-components.test.ts`.
  *Logging:* none (render-only).
  *Verify:* renderToStaticMarkup tests (no jsdom): renders stats, never-fired badge
  shown/hidden, "—" for insufficient n, RU labels resolve.
- [x] **TA.4 — Pages wiring.** Render the "Harness" section on
  `app/(app)/observatory/page.tsx` (portfolio: across visible projects) and
  `app/(app)/projects/[slug]/observatory/page.tsx` (project-scoped); existing GET
  filters (`windowDays`, `flowId`) apply to the new section; node drill-down links
  reuse the existing `nodeId` link pattern. RBAC: inherited — assert NO new route,
  NO client fetch.
  *Files:* the two `page.tsx`, `app/(app)/observatory/__tests__/page-contract.test.ts`.
  *Logging:* none.
  *Verify:* page-contract tests updated; manual `pnpm dev` smoke on both pages.
- [x] **TA.5 — E2E over seeded fixtures.** Extend the M23 seed fixture + spec (or a
  sibling `m29-harness-observatory.spec.ts` reusing the same seeded-DB harness):
  assertions — firing table renders with seeded counts, never-fired badge appears
  for the seeded silent gate, coverage map lists the seeded flow, RU locale renders
  the section. Kill stale :3100 server first (project e2e gotcha).
  *Files:* `web/e2e/` spec + `_seed` fixture extension.
  *Logging:* n/a. *Verify:* `pnpm test:e2e` green for the new/extended spec; full
  unit+integration green. **Phase A exit: suites green.**

<!-- Commit checkpoint 2: "feat(observatory): harness adequacy & coherence — sensor firing, never-fired, effectiveness, coverage (EN+RU)" -->

### Phase B — P1 structured node output (before C; engine seam)

- [x] **TB.1 — Config reader + deployment wiring.** Implement `nodeOutputMaxBytes()`
  in `web/lib/instance-config.ts` (env `MAISTER_NODE_OUTPUT_MAX_BYTES`, default
  `262144`, NaN/≤0 → default + `log.warn` once, mirroring existing readers in that
  file). Add the row to `.env.example` (commented, with default). Compose files
  intentionally untouched (host-env only per ADR-023/configuration.md:915 — state
  this in the commit body).
  *Files:* `web/lib/instance-config.ts` + its test file, `.env.example`.
  *Logging:* WARN on invalid value (existing instance-config pattern).
  *Verify:* unit test: unset/garbage/valid env; `.env.example` row present.
- [x] **TB.2 — Extraction utils (pure).** New `web/lib/flows/graph/node-output.ts`:
  `extractSentinelBlock(stdout, maxBytes)` — finds the LAST
  ` ```json maister:output ` fenced block (tolerant of trailing whitespace/CRLF;
  block must be properly fenced; pushed-past-cap or unterminated = absent),
  byte-length guard BEFORE `JSON.parse`; `readCliOutputFile(path, maxBytes)` —
  absent file = absent, oversize/unparseable = invalid with reason. Both return
  `{kind:"absent"} | {kind:"invalid", reason} | {kind:"value", value}`. The 1 MiB
  stdout capture cap ALREADY exists (`STDOUT_CAP_BYTES`, `runner-agent.ts:385`) —
  `runner-agent.ts` is NOT touched.
  *Files:* `web/lib/flows/graph/node-output.ts`,
  `web/lib/flows/graph/__tests__/node-output.test.ts`.
  *Logging:* none in pure utils.
  *Verify:* unit: multiple blocks (last wins), block inside prose, loose
  `{verdict:...}` JSON NOT matched (no ai_judgment collision), 256 KiB boundary ±1,
  truncated fence, empty block, CRLF, missing file, BOM.
- [x] **TB.3 — CLI transport injection.** `RunCliStepCtx` gains `attempt: number`;
  `runCliStep` (`web/lib/flows/runner-cli.ts:92`) passes
  `env: {...process.env, MAISTER_OUTPUT_FILE: <runDir>/output-<nodeId>-<attempt>.json}`
  to `execFileAsync`; runner-graph call sites pass `currentAttempt` (in scope —
  used at :1399). `check` nodes use the same path. NO file reading here (seam owns
  it). Update existing `runner-cli` tests for the new ctx field.
  *Files:* `web/lib/flows/runner-cli.ts`, runner-graph cli/check call sites,
  `web/lib/flows/__tests__/runner-cli*.test.ts`.
  *Logging:* DEBUG `{nodeId, attempt, outputFile}` "cli output transport armed".
  *Verify:* unit: env var present in spawn options with per-attempt filename;
  existing cli tests migrated (enumerate any asserting exec options).
- [x] **TB.4 — The seam: `validateNodeStructuredOutput`.** In `node-output.ts` export
  `validateNodeStructuredOutput({node, result, nodeAttemptId, runId, projectSlug,
  runtimeRoot, flowInstallPath, db})`: no-op (`{vars:{}}`) when no `output.result`
  or node type `human|form`; pick transport by node type (D-B3); resolve schema via
  `resolveOutputResultSchema` (`config.ts:1118`), validate via
  `validateStructuredOutput` (`output-schema.ts:70`); apply D-B4 semantics
  (spec-strict). Call it in `executeNodeAction` (`runner-graph.ts`) immediately
  after the `!result.ok` check (post-action, pre-gates); on failure:
  `markNodeFailed(..., {errorCode:"CONFIG", stdout: <reason suffix>}, db)` + abort
  finish (mirror the :1294–1306 action-failure path); on success: MUTATE
  `result.vars` with the validated object — the single existing
  `markNodeSucceeded` call (:1758–1766) already persists `vars: result.vars`, no
  call-site edits, human-node path untouched. DO NOT touch review region
  (:167–325), outcome region (~1662),
  `pendingInjectedVars` (:1515–1535), or the loop structure.
  *Files:* `web/lib/flows/graph/node-output.ts`,
  `web/lib/flows/graph/runner-graph.ts` (call + vars threading only).
  *Logging:* DEBUG "structured output: extracting {nodeId, nodeType, transport}";
  INFO "structured output captured {nodeId, attempt, keys}" on persist; DEBUG on
  absent-while-optional; the CONFIG failure logs via existing `markNodeFailed`
  INFO.
  *Verify:* unit (mock ledger/db): required-absent fails CONFIG; optional-absent
  proceeds `vars:{}`; present-but-invalid (bad JSON / schema mismatch / oversize)
  fails CONFIG regardless of `required`; valid persists into `result.vars`; human
  node bypass; gates NOT executed after a seam failure.
- [x] **TB.5 — Round-trip integration + test migration.** Integration (testcontainers,
  existing `runner.integration` family): graph flow `ai_coding(output.result,
  sentinel in stdout)` → downstream `cli` node receives `{{ steps.<id>.vars.<f> }}`
  (assert rendered command), judge-node sentinel captured, cli-node file transport
  round-trip, required-absent AND present-but-invalid each → attempt `Failed` +
  `errorCode=CONFIG` + run fails per existing semantics (spec AC4), rework attempt
  N with absent per-attempt file does NOT inherit N−1 file (AC6). Map test names to
  the frozen spec's spec-to-test matrix (AC1–AC6; AC11 is already green via the
  existing engine-gate tests; AC12 lands in TB.1). **Migrate existing assertions** that pin `vars: {}` for
  non-human nodes — enumerated targets: `web/lib/flows/__tests__/runner-agent.test.ts`
  (return-shape asserts), `web/lib/flows/graph/__tests__/runner-core.test.ts` /
  runner-graph finalize tests (vars persistence asserts), templating/`context`
  tests touching `reduceLedger`. Engine floor already tested — no changes.
  *Files:* integration test file(s) under `web/lib/flows/graph/__tests__/`, migrated
  test files above, a local fixture flow (mirror the `runner.integration` local
  fixture pattern from commit 7e981b3c).
  *Logging:* n/a.
  *Verify:* **Phase B exit: typecheck 0; unit + integration suites fully green;
  no review/outcome region diffs (`git diff --stat` eyeball).**

<!-- Commit checkpoint 3: "feat(flows): P1 structured node output — sentinel + MAISTER_OUTPUT_FILE transports, validate seam, vars persistence (ADR-063)" -->

### Phase C — P3 mutation sensor (after B lands; shares the seam)

- [ ] **TC.1 — Schema + floor + kind fan-out.** `config.schema.ts`: gate fields per
  D-C1 (+ refine: assertions only on `artifact_required`; `gate.output.kind ===
  "mutation_report"` requires assertions present); `restrictionCapabilitySchema`
  += `paths?: string[]` (D-C2); `ARTIFACT_KINDS` += `"mutation_report"`.
  `config.ts`: widen the existing `engine_min >= 1.3.0` check (:621–626) so
  mutation assertions / `gate.output.kind === "mutation_report"` also require it
  (D-C6 — NO version bump; `engine-version.ts` untouched). DB `schema.ts` kind
  text-enum += value (NO migration — text column). Kind fan-out checklist (each touched or explicitly
  no-op'd): `config.ts` `artifactKindSet`; `observatory/filters.ts`
  `parseArtifactKind`; i18n kind labels EN+RU; `board/evidence-graph-layout.ts`
  kind switch (icon/color); run-detail artifact renderer (inline JSON payload
  render); `getCurrentRequiredForGitArtifacts` (verify mutation_report correctly
  excluded).
  *Files:* `web/lib/config.schema.ts`, `web/lib/config.ts`,
  `web/lib/db/schema.ts`, fan-out files above,
  `messages/{en,ru}.json`, schema/config unit tests.
  *Logging:* none (validation throws CONFIG with precise messages, mirror :626 text).
  *Verify:* unit: manifest with assertions + `engine_min: 1.2.0` rejected `CONFIG`,
  accepted at 1.3.0; assertions on non-artifact_required rejected;
  `must_not_touch: "anything-else"` rejected; restriction `paths` parses; ALL
  existing suites green (no version bump — no engine-assert migrations needed).
- [ ] **TC.2 — Diff-range helpers + path-set engine.** Extract
  `resolveDiffRange(workspace): {base, head, evaluated}` (cumulative: merge-base vs
  main) from the produces-recording block (`runner-graph.ts:1411–1446` — diff
  portion ONLY; commit_set block stays); recording block and gates share it. Add
  the node-start capture (D-C3): write-if-absent `node-start-<nodeId>.json`
  `{head}` via `atomicWriteJson` right after the attempt-row creation in
  `executeNodeAction` (one file per (run, node); attempt 2+/resume keep the
  original) + `readNodeStartHead(runDir, nodeId)`. Add `picomatch` dep (pnpm,
  lockfile). New pure module `web/lib/flows/graph/mutation-check.ts`:
  `touchedPaths(worktreePath, base, head)` via `runGit(["diff","--name-only",...])`;
  `evaluateMutationAssertions({nodeTouched, cumulativeTouched, mustTouch,
  restrictionSets, basis})` → `{pass, report}` per D-C1/D-C2/D-C4 shapes (pure;
  picomatch with `dot:true`, POSIX-relative paths).
  *Files:* `web/lib/flows/graph/mutation-check.ts`, `runner-graph.ts` (extraction +
  start-capture only), `web/package.json` + lockfile,
  `web/lib/flows/graph/__tests__/mutation-check.test.ts`.
  *Logging:* DEBUG `{base, head, touchedCount}` in `touchedPaths`; DEBUG
  `{nodeId, head}` on node-start capture.
  *Verify:* unit (no git): glob hit/miss matrices, dotfiles, dirs, `unmatchable`
  restrictions, empty diff, 500-path truncation, `basis` fallback shape; unit (tmp
  git repo, existing worktree-test pattern): touched set matches actual commits;
  write-if-absent preserves the first head across a second write; existing
  diff-artifact tests green after extraction (byte-identical locators).
- [ ] **TC.3 — Gate executor extension.** In `gates-exec.ts` `artifact_required` case
  (:439–506): AFTER the existing inputArtifacts presence check, when
  `must_touch`/`must_not_touch` declared → ranges per D-C3 (`must_touch`:
  `readNodeStartHead(...)..HEAD`, file absent → cumulative fallback with `basis`
  flag; `must_not_touch`: cumulative `resolveDiffRange`) → `touchedPaths` per range
  (+ `ctx.restrictionPaths` threaded per D-C2 from the node-start materialization
  site) → `evaluateMutationAssertions`; record the mutation_report artifact
  (D-C4: `recordCurrentArtifact`, producer `"gate"`, hash sha256 + size_bytes
  written, BEFORE the terminal gate transition); then `markGatePassed` /
  `markGateFailed` with verdict carrying `payload.assertionFailed`,
  reasons (`"must_touch: no path matched [globs]"` / `"must_not_touch: N
  violation(s): …"` / `"git unavailable…"` per D-C3). Gates WITHOUT assertions are
  byte-identical to today. Advisory mode: failed result recorded, node proceeds
  (existing advisory semantics — verify, don't reimplement).
  *Files:* `web/lib/flows/graph/gates-exec.ts`, `GateRunContext` type +
  the runner-graph ctx construction site (restrictionPaths threading),
  `web/lib/flows/graph/__tests__/gates-exec.integration.test.ts`.
  *Logging:* INFO "mutation report {gateId, nodeId, touched, violations,
  evaluated}"; WARN on advisory failure.
  *Verify:* integration: must_touch no-match → blocking fail + report artifact
  exists (validity current, hash+size non-null); must_touch match → pass + report;
  must_not_touch violation via seeded restriction `paths` → fail; restriction
  without `paths` → `unmatchable`, no fail; advisory failure → node proceeds;
  git-unavailable → blocking fail with reason; rework attempt with a no-op delta
  PASSES `must_touch` (range spans from the node's first attempt: seed attempt-1
  commit inside the glob, re-run gate on attempt 2); start-file-absent run records
  `basis: "cumulative-fallback"`.
- [ ] **TC.4 — Readiness assertion-awareness + UI labels.** `readiness-core.ts`
  (:111–128): the artifact_required failed-gate re-eval returns `"failed"` (not
  `"clear"`) when the verdict carries `assertionFailed: true`, regardless of input
  presence; rework that re-runs the gate and passes clears it naturally. Confirm
  blocking mutation failure → run readiness blocked end-to-end; advisory → readiness
  unaffected. i18n: report violations are rendered by the artifact renderer from
  TC.1 — verify EN+RU labels render in the run-detail evidence list.
  *Files:* `web/lib/flows/graph/readiness-core.ts`,
  `web/lib/flows/graph/__tests__/readiness-core.test.ts`,
  `__tests__/evidence-readiness*.integration.test.ts` extension.
  *Logging:* none (pure classifier — match existing file).
  *Verify:* unit: assertionFailed → failed even with inputs present; legacy failed
  artifact_required (no assertions) keeps the existing inputs-present → clear
  behavior (regression); integration: readiness summary blocked on blocking
  mutation gate, unblocked after passing rework attempt.
- [ ] **TC.5 — Track C suite green + collision audit.** Full unit + integration;
  `git diff main...HEAD --stat` audit: NO diffs in review region
  (runner-graph :167–325), `hitl-validate.ts`, review UI, outcome region (~1662)
  beyond what B/C tasks own. **Phase C exit: suites green.**
  *Files:* none new. *Verify:* as stated.

<!-- Commit checkpoint 4: "feat(gates): P3 mutation sensor — must_touch/must_not_touch on artifact_required, mutation_report artifact, readiness assertion-awareness" -->

### Phase D — Docs flip + final gate

- [ ] **TD.1 — Docs checkpoint (mandatory, via `/aif-docs` flow).** Flip status tags
  Designed→Implemented for: B's P1 parts (`flow-dsl.md` §M26 — P1 rows only,
  `flow-graph.md` §validate-seam + edge cases, `configuration.md:915` env row,
  ADR-063 status note; run-context/P7 sections explicitly STAY Designed), A's
  observatory.md sections + ADR, C's flow-dsl/artifacts/readiness/flow-graph
  sections + ADR. Update `docs/database-schema.md` + `docs/db/artifacts-domain.md`
  (kind list, hash/size_bytes now written by gate producer). Cross-check the
  Contract-surfaces table above — every row touched. Surgical edits only (R9).
  *Files:* per the table. *Verify:* `pnpm validate:docs` green; grep finds no
  leftover "(M26 — Designed)" on P1 behaviors; no rationale duplicated outside ADRs.
- [ ] **TD.2 — Full verification gate.** `pnpm --filter maister-web typecheck` (0);
  full unit + integration + e2e (A spec + existing m23/m11a/etc.); check-only
  `eslint .` on web (no `--fix` repo-wide); EN/RU message parity check (key-set
  diff); `git diff main...HEAD --stat` final collision audit; confirm NO migration
  files appeared; confirm `.env.example` row present. Update this plan's Progress
  section + prepare the merge note (local merge to main or PR per promotion
  policy).
  *Files:* none. *Verify:* all listed gates green and reported with output.

<!-- Commit checkpoint 5: "docs(harness): flip M26-P1/adequacy/mutation specs to Implemented + final verification" -->

## Commit Plan

- **Commit 1** (T0.1–T0.3): `docs(harness): ADRs + Designed specs for adequacy metrics and mutation sensor`
- **Commit 2** (TA.1–TA.5): `feat(observatory): harness adequacy & coherence — sensor firing, never-fired, effectiveness, coverage (EN+RU)`
- **Commit 3** (TB.1–TB.5): `feat(flows): P1 structured node output — sentinel + MAISTER_OUTPUT_FILE transports, validate seam, vars persistence (ADR-063)`
- **Commit 4** (TC.1–TC.5): `feat(gates): P3 mutation sensor — must_touch/must_not_touch, mutation_report, readiness assertion-awareness`
- **Commit 5** (TD.1–TD.2): `docs(harness): flip specs to Implemented + final verification`

Phase A commits may interleave with Phase B (independent file sets); Phase C strictly
after Commit 3.

## Acceptance (track-level, from the task brief — verbatim targets)

- **A:** per-gate firing-rate + never-fired flags render per-project & portfolio;
  per-control effectiveness (gate-failure / capability-presence vs rework-rate)
  computed without per-run query loops; coverage map shows nodes-without-sensors per
  flow; EN+RU; read-only (no new routes/tables); unit + e2e over seeded fixtures.
- **B:** an `ai_coding`/`judge`/`cli` node with `output.result` emits a structured
  value captured into `node_attempts.vars`, readable by a later node via
  `{{ steps.<id>.vars.<field> }}`; an absent payload fails the node with
  `MaisterError("CONFIG")` when `required` and proceeds `vars:{}` when optional; a
  present-but-invalid payload fails `CONFIG` regardless of `required` (spec-strict,
  resolution #6); NO edits to review/outcome regions; unit + integration (vars
  round-trip).
- **C:** a node declaring `must_touch` fails (per blocking|advisory) if the
  node-scoped diff range (D-C3: since the node's first attempt started; cumulative
  fallback) touches none of the globs and emits a `mutation_report`;
  `must_not_touch` flags
  any diff path in the M14 restriction set (via `restriction.paths`); readiness
  honors a blocking mutation gate; narrow path-set logic only; unit (path-set over a
  diff) + integration tests.

## Out of scope (do not drift into)

P2 prompt content injection · P4 dynamic routing · automatic self-correction loop
assembly · LLM-optimized sensor messages · P7 run-context file · self-improvement
write-side (Improver/proposal inbox) · per-agent frontmatter variants · UI auto-fix
actions · ADR-041 strict (preventive) restriction enforcement · cached observatory
read-models · per-flow never-fired threshold overrides (env-only in v1) ·
per-ATTEMPT strict diff deltas (v1 uses the since-first-attempt node range, D-C3).

## Progress

(filled by /aif-implement)

## Plan-review resolutions (user, 2026-06-10)

1. `must_not_touch` — **IN**, via the `restriction.paths` structured field (D-C2).
2. `must_touch` — **node-scoped**, not cumulative (user: the assertion belongs to
   the node that does the touching). D-C3 revised: since-first-attempt range via a
   durable `node-start-<nodeId>.json` capture (write-if-absent), cumulative
   fallback recorded as `basis`; `must_not_touch` stays cumulative as a safety net.
3. `picomatch` — approved.
4. Engine — **NO bump**: stay `1.3.0`, widen the existing `engine_min >= 1.3.0`
   gate to the new fields (D-C6 revised); the bundled `aif` package raises its own
   `engine_min` only if it adopts the fields.
5. Never-fired threshold — **env** `MAISTER_HARNESS_NEVER_FIRED_MIN` (default 10),
   not a baked constant; per-flow override deferred (display heuristic, not flow
   behavior).
6. (second pass, /aif-improve) Optional+INVALID payload — **SPEC-STRICT** confirmed:
   `required` excuses only ABSENCE; a present-but-broken payload (oversize / bad
   JSON / schema mismatch) always fails `CONFIG` (D-B4 revised; frozen spec stays
   unchanged — no amendment sweep needed).

No open questions remain.
