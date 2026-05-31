# M11a — Flow Graph v1: node lifecycle, run ledger, review-driven rework

> First slice of the split M11 milestone. Implement on a matching
> `feature/m11a-flow-graph-lifecycle` branch so branch-based consumers
> (`/aif-implement`, `/aif-verify`) discover this file.

## Context

M11 ("Flow graph maturity") is the execution-model foundation that must exist
before the HITL UI becomes product-grade. Today the engine
(`web/lib/flows/runner.ts`) is a **strictly linear** `for (const step of steps)`
walker; `on_reject.goto_step` is parsed and validated but **never executed**
(`docs/flow-dsl.md:348`), so review-driven rework does not work. `step_runs`
reuses the same row on resume and hard-codes `attempt = 1`, so there is no
append-only history. There is no graph, no rework loop, no node lifecycle, no
gate execution, no manual takeover, and no run-detail timeline.

A detailed **"Designed"** M11 spec already exists in `docs/flow-dsl.md:23-186`
(node `input / settings / action / output / pre_finish / finish / transitions /
rework`). The roadmap M11 acceptance criteria deliberately span territory later
milestones own: M12 (typed artifacts/evidence graph), M14 (capability
enforcement), M15 (gate readiness policy), M18 (diff/branch-targeting/promotion).

**Decision taken (user, this session):** split M11 into **M11a / M11b / M11c**
and ship **M11a first**:

- **M11a (this plan)** — Flow graph v1 manifest + node lifecycle compile +
  append-only `node_attempts` ledger + review-driven rework loop +
  **full-featured gate execution** (real gates, per user directive). Linear
  `steps[]` flows stay valid by compiling to single-action nodes.
- **M11b (next)** — manual takeover (local worktree handoff per ADR-011) + the
  rich run-detail timeline (current vs stale gates, all attempts/decisions/
  handoffs/returned commits) + board `HumanWorking` surface.
- **M11c (after)** — node-specific **typed settings** + runtime **enforcement
  boundary** (refuse undeclared MCP/tool/skill/restriction), anticipating the
  M14 capability registry.

Intended outcome of M11a: the bundled `aif` Flow runs
`plan → implement → checks → judge → review`, a reviewer rejects from `review`
back to `implement` with comments, the downstream `checks`/`judge` gates go
**stale** and **rerun**, and the run reaches a fresh `review` gate — all recorded
in an immutable per-attempt ledger. Backwards compatibility: the minimal linear
`greet` flow still runs unchanged.

## Scope boundary — what M11a does and does NOT include

| In M11a | Deferred |
| ------- | -------- |
| `nodes[]` manifest (graph v1), mutually exclusive with `steps[]` | Node `human_edit` / `merge` types (M11b / M18) |
| Compile `steps[]` → normalized node graph (back-compat) | Manual takeover, `HumanWorking`, commit import, returned diff (**M11b**) |
| `node_attempts` append-only ledger table | Rich run-detail timeline UI (**M11b**) |
| Graph runner: traversal + rework jump + loop limits | Node typed `settings` + enforcement refusal (**M11c**) |
| Gate engine: `command_check`, `ai_judgment`, `skill_check` (best-effort), `human_review` — both modes, full status lifecycle, structured verdicts, staleness, override-without-erasure | `artifact_required` execution (needs M12 artifact instances) — schema-defined + validated, **execution stubbed** |
| Review-driven rework via declared decisions/targets/workspace policies | `external_check` execution (needs M16 ops API) — schema-defined + `pending`, **no ingestion endpoint** |
| Minimal review UI: approve / rework + comments | Evidence-graph explorer, all artifact kinds, rich previews (**M12**) |
| `aif` migrated to nodes; `greet` linear back-compat preserved | Readiness-policy DSL, verdict calibration (**M15**); capability scoping for `skill_check` (**M14**) |

## Locked architecture decisions (from this session's Q&A → new ADRs in Phase 0)

1. **Manifest stays `schemaVersion: 1`**; add an **optional top-level `nodes[]`**,
   mutually exclusive with `steps[]` (zod `.refine`: exactly one present). Graph
   flows MUST declare `compat.engine_min: 1.1.0`. Bump
   `MAISTER_ENGINE_VERSION` const `1.0.0 → 1.1.0` (it is a code constant in
   `web/lib/flows/engine-version.ts:14`, **not** an env var — no compose wiring).
   `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays `[1]`. → **ADR-022**.
2. **Run ledger = new append-only `node_attempts` table.** `attempt`
   auto-increments per `(run_id, node_id)`. Linear `steps[]` flows compile to
   nodes and write `node_attempts` too. `step_runs` is **retained for
   back-compat reads/migration only** — the graph runner writes `node_attempts`
   and templating `steps.<id>.output` / `steps.<id>.vars` reads from
   `node_attempts` (highest-attempt-wins), falling back to `step_runs` for
   legacy rows. → **ADR-023**.
3. **Gates are real and full-featured** (user directive) within dependency
   limits: `command_check` + `ai_judgment` + `human_review` fully execute;
   `skill_check` runs a slash command via an agent session (best-effort, no
   capability scoping until M14); `artifact_required` + `external_check` are
   schema-valid + status-modelled but **not executed** in M11a (M12 / M16
   dependencies). Gate status lifecycle
   `pending|running|passed|failed|stale|skipped|overridden`, modes
   `blocking|advisory`, structured verdicts, staleness propagation, and
   override-without-erasure are all real. → **ADR-024**. **(P4) Because M11a
   takes the gate-EXECUTION engine that the roadmap originally assigned to M15,
   ADR-024 MUST record M15 as re-scoped to "readiness-policy DSL + verdict
   calibration + `external_check` ingestion ONLY" — the status lifecycle +
   structured verdicts + override-without-erasure move to M11a. This is a
   recorded DECISION (the user accepted M11a open-Q#5), not an open question.**
4. **Manual takeover = local worktree handoff** (ADR-011 consistent: no remote
   required). **Recorded now, built in M11b.** No `HumanWorking` run status in
   M11a.
5. **M11 split** recorded as **ADR-025**; roadmap renumbered M11 → M11a/M11b/M11c
   via the roadmap owner (`/aif-roadmap`), not edited directly by this command.

## Settings

- **Testing:** yes (project norm; every prior milestone shipped unit +
  integration suites).
- **Logging:** verbose (`pino` DEBUG/INFO at each node-attempt transition, gate
  start/verdict, rework jump, staleness mark).
- **Docs:** mandatory checkpoint (route through `/aif-docs`). Docs are
  **Phase 0** (analytics-first per skill-context), reconciled as-built before
  completion.

## Roadmap Linkage

- **Milestone:** "M11. Flow graph maturity: node lifecycle, typed settings,
  rework, and human takeover" — this plan delivers the **M11a** slice (graph +
  ledger + rework + gates). Rationale: the user split M11 into sequential
  sub-milestones and chose to ship the graph/ledger/rework engine first; M11b
  (manual takeover + timeline) and M11c (node settings + enforcement) follow.

---

## Acceptance Criteria (M11a)

Derived from the 8 roadmap **M11** criteria, carved across the M11a/M11b/M11c
split so coverage is **complete** and **non-overlapping**. Each M11a AC names its
originating roadmap criterion and the Verification item that proves it.

**M11a owns:**

- **AC-1 (roadmap #2) — Linear back-compat.** A `steps[]`-only manifest needs no
  `nodes[]` and no graph syntax; it compiles to default single-action nodes and
  runs to `Review` exactly as today. → Verify #1.
- **AC-2 (roadmap #1, M11a-scoped subset) — Graph validation.** Manifest
  validation rejects: unknown node ids (in `transitions`/`rework.allowedTargets`/
  `staleFrom`/`input.requires`); duplicate node/gate ids; unknown gate kinds;
  unsafe cycles without `rework.maxLoops`; unsupported workspace policies; human
  decisions targeting undeclared transitions; both-or-neither of `steps`/`nodes`;
  graph flow without `compat.engine_min ≥ 1.1.0`. → Verify #3.
- **AC-3 (roadmap #3) — Rework loop.** A graph flow runs
  `plan→implement→checks→judge→review`; reject `review`→`implement` with comments
  marks `checks`/`judge` stale, reruns them, and reaches a fresh `review` gate.
  → Verify #2.
- **AC-4 (roadmap #1, gate/ledger sub-clause) — Full-featured gate execution.**
  `command_check`/`ai_judgment`/`human_review` execute with `blocking`/`advisory`
  modes, structured verdicts, the full `pending|running|passed|failed|stale|
  skipped|overridden` lifecycle, staleness propagation, and
  override-without-erasure. → Verify #4.
- **AC-5 — Append-only ledger.** Every node execution is an immutable
  `node_attempts` row (`attempt` auto-increments per `(run,node)`); rework never
  mutates prior rows; templating resolves highest-attempt-wins. → Verify #6.
- **AC-6 (roadmap #7, rework half) — `aif` migrated** to `nodes[]` and
  demonstrates review-driven rework. (Manual-takeover half → M11b.) → Verify #2.
- **AC-7 (roadmap #8, M11a docs) — Docs** cover graph schema, run ledger, rework
  semantics, and backwards compatibility. → Verify #7.
- **AC-8 — Trust before execute.** A graph flow on an `untrusted` revision never
  runs a gate command/agent (launch refused first). → Verify #5.

**Explicitly NOT M11a (carved out to keep criteria distinct — no double-listing):**

| Clause from roadmap M11 | Owner | Why not M11a |
| ----------------------- | ----- | ------------ |
| #1 "unknown **roles**" (human-node role refs) | **M13** | M13 already owns "rejects human nodes that reference unknown project roles" — do not duplicate here |
| #1 "unknown **MCP/tool/skill/agent/restriction** refs" (registry-ref validation) | **M14** | M14 already owns "rejects unknown MCPs, tools, skills, agents, restriction policies…" |
| #1 node-level **executor** refs (`settings.executors`) | **M11c** | config-state, resolvable via the M6 chain without the M14 registry (P1 — owner fixed) |
| #4 manual takeover (`HumanWorking`, handoff branch, commit import, returned diff, downstream rerun) | **M11b** | — |
| #5 run-detail timeline (current vs stale gates; attempts/decisions/handoffs/returned commits) | **M11b** | — |
| #6 AI node **settings** enforced (no undeclared MCP/tool/skill escape hatch) | **M11c** | — |
| #7 "manual takeover" half · #8 "manual takeover semantics" docs | **M11b** | — |
| #8 "node **settings** schema" docs | **M11c** | — |

> Flow-level executor refs are already validated by the existing M6
> `recommended_executor` check; node-level `settings.executors` validation is
> **M11c** (config-state, no registry needed), while capability registry refs
> (mcps/tools/skills/agents/restrictions) are **M14**. This redistribution is the
> authoritative input for the Phase 0.2 roadmap renumber — M11a/M11b/M11c each
> inherit exactly the rows above.

---

## Phase 0 — Analytics, schema design, ADRs (docs-first; no code) 🔴 gate before any code

Per skill-context: analytics is an **input** to implementation. This phase MUST
be complete and internally consistent before Phase 1. Exit criterion: every
artifact below exists, cross-references resolve, and implementation-status tags
(Implemented/Designed/Phase 2) are correct for HEAD-after-M11a.

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 0.1 | ADR-022 (graph manifest + engine bump), ADR-023 (node_attempts ledger), ADR-024 (full-featured gates + deferred kinds), ADR-025 (M11 split M11a/b/c) | `docs/decisions.md` (append, index rows) | 4 ADRs `Accepted`, sequential, template-conformant |
| 0.2 | Roadmap renumber M11 → M11a/M11b/M11c (delegate to roadmap owner) — distribute the 8 roadmap criteria **exactly per the "Acceptance Criteria (M11a)" carve above** (M11a owns AC-1..AC-8; #4/#5/#7-takeover/#8-takeover → M11b; #6/#8-settings → M11c; #1-roles → M13; #1-MCP/tool/skill/agent/restriction → M14; **#1 node-level executor refs → M11c**). **(P4) ALSO re-scope roadmap M15 in the same renumber**: M11a annexes the gate-EXECUTION engine, so M15 becomes "readiness-policy DSL + verdict calibration + `external_check` ingestion ONLY" — record this so M15 does not read as a duplicate/false-failure. | `.ai-factory/ROADMAP.md` via `/aif-roadmap` | M11a/b/c entries carry the carved criteria with **no clause dropped and none double-listed**; M15 re-scope recorded; **ownership boundary respected** (not hand-edited here) |
| 0.3 | New system-analytics doc: node lifecycle state machine, graph traversal, gate execution, staleness, rework loop (per `docs/CLAUDE.md` R5 — Purpose/Entities/State machine/Process flows/Expectations/Edge cases/Linked). **(P7) MUST include a status-casing + mapping note:** `node_attempts.status` is PascalCase (`Pending\|Running\|Succeeded\|Failed\|NeedsInput\|Reworked\|Stale`, extending `step_runs` vocab — it ADDS `Reworked`/`Stale`, OMITS `Skipped`) while `gate_results.status` is lowercase (`pending\|…\|overridden`, the M15 gate vocabulary). State this dual-casing is **intentional** (node lifecycle vs gate verdict are distinct domains) and give the legacy `step_runs`→`node_attempts` value mapping used by the templating highest-attempt-wins union | `docs/system-analytics/flow-graph.md` (new) | Every node-attempt transition + every gate refusal/precondition enumerated **exactly as code will gate** (allow-list shape); dual-casing + step_runs mapping stated |
| 0.4 | Update run state machine (rework loop: review→rework target, NeedsInput re-entry), HITL decision flow (declared decisions vs raw goto_step) | `docs/system-analytics/runs.md`, `docs/system-analytics/hitl.md`, `docs/system-analytics/flows.md` | rework path drawn; `on_reject.goto_step` marked superseded-by-`transitions`. **MUST also state three invariants** so the analytics don't over-claim: (1) rework is a **node-pointer move within `Running`**, NOT a new run status (no `HumanWorking` in M11a); (2) `runs.current_step_id` now carries the **node id** (≡ step id for compiled-linear) and the existing fail-closed check applies to the compiled graph; (3) M11a `gate_results` **feed but do not gate promotion** — the `runs.md` promote sequence's "verify required gates" is M15/M18 scope, not M11a |
| 0.5 | ERD: `node_attempts`, `gate_results`, `hitl_requests` new columns (BOTH artifacts) | `docs/database-schema.md` + `docs/db/runs-domain.md` (+ `docs/db/erd.md`) | narrative AND Mermaid `erDiagram` both updated |
| 0.6 | API contract: document the review-decision shape on `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond`. **Decision/comments/workspacePolicy ride INSIDE the existing `response` form payload** (matching the review `form_schema`) — NOT new top-level body params; the route's `bodySchema` `{optionId?, response?}` is unchanged. Document the review-`response` sub-schema + the new 4xx for an invalid/undeclared decision | `docs/api/web.openapi.yaml` | review-`response` sub-schema + status codes + example payloads present; no new top-level body field added |
| 0.7 | Promote `docs/flow-dsl.md` "Planned M11" → Implemented for the **M11a subset**; tag M11b/M11c/M12/M15 parts; document backwards-compat (steps→nodes compile). **MUST tag the node `settings` block as M11c-Designed (NOT M11a-Implemented)** so promoting the example doesn't imply M11a enforces it. Also add the `MAISTER_ENGINE_VERSION 1.0.0→1.1.0` note to `docs/configuration.md` (owns the engine-version contract-surface row). **(P4) MOVE the gate-execution clauses (six gate kinds, status lifecycle, structured verdicts, blocking/advisory, override-without-erasure) from flow-dsl.md "Planned M15" → "Implemented (M11a)"; leave only readiness-policy DSL + verdict calibration + `external_check` ingestion under "Planned M15"** | `docs/flow-dsl.md`, `docs/configuration.md` | node lifecycle sections in M11a marked Implemented; `settings` tagged M11c-Designed; deferred kinds tagged; gate-execution clauses moved off "Planned M15"; configuration.md engine-version note present |
| 0.8 | **Contract-surface tracing table** (skill-context): map each changing surface → spec file (see below) | this plan + Phase 0 docs | every surface in the table has an owning task |

**Contract surfaces this milestone touches (skill-context trace):**

| Surface | Spec file |
| ------- | --------- |
| `respond` route body gains `decision`/`comments`/`workspacePolicy` (load-bearing) | `docs/api/web.openapi.yaml` + this route prose |
| New `node_attempts`, `gate_results` tables; `hitl_requests` columns | migration `0008` + `docs/database-schema.md` + `docs/db/runs-domain.md` ERD |
| New manifest `nodes[]` + node/gate types/fields | `docs/flow-dsl.md` + `web/lib/config.schema.ts` |
| (none — see D) M11a adds **NO new `MaisterError` code** (closed union, ADR-008) | `docs/error-taxonomy.md` unchanged; gate verdict-parse failure = `gate_results.status='failed'`, not a thrown code |
| `MAISTER_ENGINE_VERSION` const bump (NOT an env var) | `docs/configuration.md` engine-version note + `docs/flow-dsl.md` |

> No new env var, bound port, sidecar binary, or config-file path is introduced
> in M11a → no `Dockerfile`/`compose.*`/`.env.example` change required
> (skill-context deployment-touchpoints rule: nothing to wire).

---

## Phase 1 — Manifest: `nodes[]` graph schema + validation

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 1.1 | Add `nodeSchema` discriminated union (`ai_coding\|cli\|check\|judge\|human`) with `input.requires?`, `output.produces?` (typed artifact decls), `action` (type-specific), `pre_finish.gates?`, `finish.human?` (`decisions[]`, `commentsVar?`), `transitions` (decision→nodeId map), `rework?` (`allowedTargets[]`, `workspacePolicies[]`, `maxLoops`, `commentsVar`); add `gateSchema` (`command_check\|skill_check\|ai_judgment\|artifact_required\|external_check\|human_review`, `mode`, `command?`/`prompt?`/`skill?`, `inputArtifacts?`, `output?`, `staleFrom?`); add optional `nodes` to `flowYamlV1Schema` with `.refine` enforcing **exactly one** of `steps`/`nodes`. **(P13) This requires relaxing the currently-required `steps` field (`config.schema.ts` `steps: z.array(...).min(1)`) to optional FIRST, then making `nodes` optional, so the `.refine` can reject both-absent AND both-present; name the existing "steps required / min(1)" config-schema test as one needing migration** | `web/lib/config.schema.ts` | zod parses sample graph manifest; rejects both-present and neither-present; `steps` now optional |
| 1.2 | Graph cross-reference validation in `loadFlowManifest`: unknown node id in `transitions`/`rework.allowedTargets`/`staleFrom`/`input.requires`; duplicate node ids; duplicate gate ids; unknown gate kinds; unsupported workspace policy; **cycle without `rework.maxLoops`** (graph cycle detection); human `decisions` that target undeclared transitions; mustache validation on node `action.prompt`/`action.command` | `web/lib/config.ts` (`loadFlowManifest`) | each rejection throws `MaisterError("CONFIG", …)`; INFO log per validated manifest with node/gate counts |
| 1.3 | Bump engine const + require graph flows to declare `compat.engine_min >= 1.1.0` (validation in `loadFlowManifest`) | `web/lib/flows/engine-version.ts`, `web/lib/config.ts` | `MAISTER_ENGINE_VERSION="1.1.0"`; graph flow without engine_min≥1.1.0 → CONFIG |
| 1.4 | Export `NodeDef`, `GateDef`, `WorkspacePolicy`, `HumanDecision` TS types | `web/lib/config.schema.ts` | types consumed by runner/ledger |
| 1.5 | Tests: graph manifest fixtures (valid + each rejection case); confirm runner project glob matches new test paths | `web/lib/__tests__/config.schema.*`, `web/lib/__tests__/config.*` | per skill-context: name the runner project; `vitest list` shows the files |
| 1.6 | **Node `settings` handling (no silent strip).** A node `settings` block (the M11c/M14 capability fields shown in `flow-dsl.md`) MUST NOT be silently dropped by zod. M11a accepts an **optional opaque `settings` passthrough**, records it, and emits a one-time WARN. **(P14) Emit the WARN via a NAMED exported constant `SETTINGS_NOT_ENFORCED_WARN` in `web/lib/config.ts`** (message `[flow] node settings parsed but not enforced until M11c`) so M11c can assert its removal against the symbol, not a brittle string match. (Enforcement + typed validation = M11c.) | `web/lib/config.schema.ts`, `web/lib/config.ts` | a manifest carrying `settings` validates, the block is preserved (not stripped), and `SETTINGS_NOT_ENFORCED_WARN` fires once; test asserts no silent strip |

---

## Phase 2 — DB migration `0008` + ledger + gate-result helpers

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 2.1 | `node_attempts` table: `id`, `run_id` FK, `node_id`, `node_type`, `attempt` (auto-increment per run+node), `status` (`Pending\|Running\|Succeeded\|Failed\|NeedsInput\|Reworked\|Stale`), `decision?`, `workspace_policy?`, `rework_from_node?`, `acp_session_id?`, `stdout?`, `vars jsonb`, `exit_code?`, `error_code?`, `started_at`, `ended_at?`; UNIQUE `(run_id, node_id, attempt)`; index `(run_id)` | `web/lib/db/schema.ts`, `web/lib/db/migrations/0008_*.sql` | append-only; migration additive; `pnpm drizzle-kit` generates 0008 |
| 2.2 | `gate_results` table: `id`, `run_id` FK, `node_attempt_id` FK, `gate_id`, `kind`, `mode`, `status` (`pending\|running\|passed\|failed\|stale\|skipped\|overridden`), `verdict jsonb` (structured: verdict/confidence/reasons/recommendedAction), `input_artifact_refs jsonb`, `output_artifact_ref?`, `stale_from jsonb`, `overridden_by?`, `created_at`, `ended_at?`; index `(run_id)`, `(node_attempt_id)` | `web/lib/db/schema.ts`, migration `0008` | covers full status lifecycle |
| 2.3 | `hitl_requests` columns for review decisions: `decision text?`, `workspace_policy text?`, `rework_target text?`; enrich `schema` jsonb at creation with manifest-derived `allowedDecisions`/`transitions`/`reworkTargets`/`workspacePolicies` (server-state for validation) | `web/lib/db/schema.ts`, migration `0008` | additive; existing rows unaffected |
| 2.4 | Ledger helpers: `appendNodeAttempt`, `markNodeRunning/Succeeded/Failed/NeedsInput/Reworked`, `getNodeAttemptsForRun`, `nextAttemptFor(run,node)`, `markDownstreamStale(run, fromNode, graph)` (sets `node_attempts.status='Stale'` + dependent `gate_results.status='stale'`) | `web/lib/flows/graph/ledger.ts` (new) | DEBUG log on each transition incl. attempt number |
| 2.5 | Gate-result helpers: `createGateResult`, `markGatePassed/Failed/Stale/Skipped/Overridden`, structured-verdict writer | `web/lib/flows/graph/gate-store.ts` (new) | verdict jsonb shape asserted in tests |
| 2.6 | Type exports (`NodeAttempt`, `GateResult`) + drizzle peer-dep `as any` cast pattern matching existing `runner.ts:42` | `web/lib/db/schema.ts` | — |

> **DB symmetry note (skill-context):** no YAML→DB removable field is persisted
> in M11a, so the SET/CLEAR/re-SET round-trip rule does not apply (N/A).

---

## Phase 3 — Graph compiler + graph runner (traversal, preserving M5–M8 semantics)

The hard core. Build a graph executor that **reuses** the per-step primitives
(`runCliStep`, `runAgentStep`, `runHumanStep`) and the hard-won M5–M8
resume/checkpoint/claim machinery — replacing only the linear `for` loop with
graph traversal + ledger + gates + rework.

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 3.1 | `compileManifest(manifest)` → normalized `FlowGraph` (nodes, adjacency, entry node). `steps[]` compiles to a linear chain of single-action nodes with default `transitions.success → next`, no rework. `nodes[]` validated graph passes through | `web/lib/flows/graph/compile.ts` (new) | linear + graph both yield a `FlowGraph`; unit-tested |
| 3.2 | `runGraph(loaded, ctx)`: walk from entry/resume node; per node → append `node_attempts` row (attempt = `nextAttemptFor`), run `action`, run `pre_finish.gates`, run `finish` (auto or human), evaluate `transitions`/decision → set next node; honor `rework.maxLoops` (and a hard const ceiling); on rework jump call `markDownstreamStale` | `web/lib/flows/graph/runner-graph.ts` (new) | INFO per node enter/exit + chosen transition; rework jump logged with from/to + attempt |
| 3.3 | Preserve resume: atomic NeedsInput→Running CAS claim (port `runner.ts:312-361`); resume entry = `runs.current_step_id` reused as node pointer (no new run column); `STEP_CHECKPOINTED` checkpoint path; slash-session cleanup; `promoteNextPending` on every terminal/checkpoint exit | `web/lib/flows/graph/runner-graph.ts` | resume of a NeedsInput review node continues at that node; checkpoint path unchanged |
| 3.4 | Rewire `runFlow` to dispatch on manifest shape. **As-built (M11a):** `nodes[]` manifests route to `compileManifest` → `runGraph`; `steps[]` flows REMAIN on the original linear runner (NOT recompiled through the graph), preserving behavioral parity AND legacy resume (`runner.ts:158-163`). This is more conservative than the original "linear flows traverse the compiled graph" wording — parity is preserved without re-routing legacy runs | `web/lib/flows/runner.ts` | `greet` + existing aif-suspend integration test pass unchanged |
| 3.5 | Templating reads `node_attempts` (highest-attempt-wins) for `steps.<id>.output`/`.vars`/`.exitCode`, falling back to `step_runs` for legacy rows | `web/lib/flows/context.ts` | unit test: after rework, `steps.<id>` resolves to the highest attempt |
| 3.6 | **Deferred-release (skill-context):** any agent session / permission deferred created during a node action or gate MUST be released on every failure path (reuse `runner-agent` `cancelPermission` + `cleanupSlashSession`). Add regression test asserting cancel is called on simulated mid-node DB failure | `web/lib/flows/graph/runner-graph.ts`, tests | spy verifies deferred release on failure |
| 3.7 | Migrate existing runner tests to graph path; enumerate touched files (below) | `web/lib/flows/__tests__/runner*.test.ts`, integration suite | per-phase suite green |
| 3.8 | **Resume-compat for in-flight pre-M11a runs — ⚠️ As-built MOOT (consequence of 3.4).** Because `steps[]` flows stay on the linear runner, a pre-M11a `NeedsInput` run (always a `steps[]` flow) never enters the graph runner, so no `step_runs`→`node_attempts` seed is required; the graph runner intentionally has **no `step_runs` fallback** (documented inline at `runner.ts:160-162`). _Original intent (not implemented, superseded by the 3.4 dispatch choice):_ seed the graph-resume entry from the latest `step_runs` row when no `node_attempts` exist | `web/lib/flows/runner.ts` (dispatch comment) | no graph `step_runs` seed needed; linear runner continues to resume legacy `step_runs` runs unchanged |

**Tests requiring migration (skill-context — enumerate, don't trim):**
`web/lib/flows/__tests__/runner.*` (linear walk assertions → compiled-graph
parity), `templating.*` (now reads `node_attempts`), `step-runs.*` (kept; assert
back-compat read path), the flows integration suite "aif suspend at review"
case, and the `mock-acp-adapter.mjs` fixture wiring. Each phase exit:
`pnpm test:unit && pnpm test:integration` green; any harness-limited test
(Docker-only) quarantined with a reason + follow-up, never silently red.

> **(P13) Citation hygiene at implementation time:** the line numbers in this
> plan's `runner.ts` references are indicative, not literal — resolve them by
> SYMBOL, not line (the resume CAS block is the `db.transaction` in the
> `isResume` branch; the linear loop is the `for (const step of stepsToRun)`;
> there is no `as any` at a fixed line). When a "migrate" target file does not
> actually exist yet (e.g. a `templating.*`/`step-runs.*` glob with no match),
> reframe the task as **add** the test, not migrate it. Name the real
> integration case verbatim — `web/lib/flows/__tests__/runner.integration.test.ts`
> "aif plugin halts at review step" — rather than a glob.

---

## Phase 4 — Gate execution engine (full-featured)

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 4.1 | Gate dispatcher: run a node's `pre_finish.gates` in order; per gate create `gate_results` row (`running`), execute by kind, write status + structured verdict; `mode: blocking` failure aborts the node finish (run → `Failed` unless rework available), `advisory` records + continues | `web/lib/flows/graph/gates-exec.ts` (new) | INFO per gate kind/mode/status/verdict |
| 4.2 | `command_check`: render + run `command` via `bash -c` (reuse `runCliStep` plumbing, AbortSignal timeout, 4 MiB maxBuffer); exit 0 = `passed`, else `failed`; stdout captured into verdict | `web/lib/flows/graph/gates-exec.ts` | exit-code mapping asserted |
| 4.3 | `ai_judgment`: run `prompt` via an agent session (**defaults to `new-session`** for an isolated verdict unless the gate declares reuse — affects ~$0.28/spawn cache cost, M0); parse a structured verdict (`{verdict, confidence, reasons, recommendedAction}`) from agent output (tolerant parse; unparseable → `gate_results.status='failed'` + raw prose stored as evidence). **NO new `MaisterError` code** (ADR-008 closed union) — parse failure is a `failed` gate result, not a thrown code | `web/lib/flows/graph/gates-exec.ts` | verdict jsonb populated; parse-failure path produces a `failed` gate result (no thrown domain code); session-reuse mode asserted |
| 4.4 | `skill_check`: run a slash command (e.g. `/aif-review`) via agent session (**`new-session` default**, same as 4.3) — best-effort, **no capability scoping** (flagged TODO(M14)); verdict like ai_judgment | `web/lib/flows/graph/gates-exec.ts` | runs; TODO(M14) comment present |
| 4.5 | `human_review`: emits the review HITL (Phase 5); `artifact_required` → `skipped` with WARN + `TODO(M12)`; `external_check` → `pending` with WARN + `TODO(M16)` (no ingestion endpoint) | `web/lib/flows/graph/gates-exec.ts` | deferred kinds clearly stubbed, not silently passed |
| 4.6 | Staleness: on rework/return, `markDownstreamStale` flips dependent gate_results `passed→stale`; stale blocking gates force rerun before the node can finish again | `web/lib/flows/graph/ledger.ts`, `gates-exec.ts` | stale gate reruns on next node attempt |
| 4.7 | **Trust-before-execute (skill-context):** confirm launch precondition (M10) refuses `untrusted` revisions BEFORE any gate command/agent runs; add regression: launch a graph flow on an untrusted revision carrying a `command_check` → refused, command side-effect absent | `web/app/api/runs/route.ts` (verify existing M10 gate covers graph), test | untrusted graph flow never executes a gate command |
| 4.8 | Gate unit + integration tests (each kind, both modes, stale→rerun, blocking-abort) | `web/lib/flows/__tests__/gates-exec.*` | per-phase green; runner glob matches |

---

## Phase 5 — Review-driven rework (declared decisions, validated)

Reuse the existing two-phase HITL commit (`respond/route.ts`) **unchanged
structurally** — the reviewer's decision rides inside the form `response`
payload; validation happens against the manifest-derived allowed sets stored in
`hitl_requests.schema` at creation time (server-state, not body-trusted).

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 5.1 | When creating a `human_review` HITL, store manifest-derived `allowedDecisions`, `transitions`, `reworkTargets`, `workspacePolicies` in `schema` jsonb | `web/lib/flows/runner-human.ts` (+ graph runner) | schema carries server-state allow-list |
| 5.2 | Extend `assertHitlResponse` (or a sibling `assertReviewDecision`) to validate the submitted `decision` ∈ `allowedDecisions`, resolved target ∈ `transitions`, and (if rework) `workspacePolicy` ∈ `workspacePolicies` & target ∈ `reworkTargets` — **before** any state mutation (Phase 0 of the commit) | `web/lib/flows/hitl-validate.ts` | invalid decision → 422/400 with no artifact write; **body-controlled ids validated against server-state (skill-context)** |
| 5.3 | Persist `decision`/`workspace_policy`/`rework_target` columns on the HITL row at claim time; keep `respondedAt` as the AFTER-side marker (two-phase invariant preserved) | `respond/route.ts` (minimal: write columns alongside `response`) | two-phase commit unchanged; idempotent retries safe |
| 5.4 | Graph runner resume reads the stored decision: `approve` → follow `transitions.approve`; `rework` → `markDownstreamStale(from review node)`, set pointer to rework target, inject `commentsVar` into the target node's context, increment attempt, continue loop | `web/lib/flows/graph/runner-graph.ts` | rework jump recorded as `node_attempts.status='Reworked'` on review node + new attempt on target |
| 5.5 | `workspacePolicy` handling for M11a: `keep` (default, no worktree change). `rewind-to-node-checkpoint` and `fresh-attempt` validated + recorded but **execution deferred** (worktree rewind = M11b) with explicit WARN + `TODO(M11b)`; manifest may only require `keep` for the aif demo | `web/lib/flows/graph/runner-graph.ts` | `keep` works end-to-end; others recorded-not-executed |
| 5.6 | Tests: approve-advances; rework-jumps-with-comments-and-restales; invalid-decision-rejected-pre-mutation; maxLoops exhausted → run `Failed` with clear error | `web/lib/flows/__tests__/rework.*`, integration | per-phase green |

**Identifier trust labels for the `respond` route (skill-context):**
`runId`, `hitlRequestId` = `url-param` (route shape). `projectId` = `server-state`
(from run row). `decision`/`comments`/`workspacePolicy`/`reworkTarget` =
`body-controlled` → validated against `hitl_requests.schema` allow-list derived
from the **pinned** manifest. No body-controlled field names a filesystem path.

---

## Phase 6 — `aif` migration + minimal review UI + i18n + back-compat

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 6.1 | Migrate `plugins/aif/flow.yaml` from `steps[]` to `nodes[]`: `plan → implement → checks(command_check) → judge(ai_judgment) → review(human, decisions:[approve,rework])`; `transitions.approve → (done)`, `transitions.rework → implement`; `rework.allowedTargets:[implement]`, `workspacePolicies:[keep]`, `maxLoops`; `compat.engine_min: 1.1.0` | `plugins/aif/flow.yaml`, `plugins/aif/schemas/review.json` | manifest validates; demonstrates criterion #3 |
| 6.2 | Keep a minimal linear flow (e.g. `greet`) as back-compat fixture; assert it still runs unchanged (criterion #2) | test fixtures | linear flow green |
| 6.3 | Minimal review UI: replace the run-detail JSON textarea / inbox snooze no-op with approve / rework buttons + comments textarea for `human_review`; submit decision in the `response` payload | `web/components/board/run-hitl-response.tsx`, `web/components/board/hitl-actions.tsx` | reviewer can choose rework + comments; HeroUI + Server-derived labels pattern (mirror `package-actions.tsx`) |
| 6.4 | i18n keys for decisions/comments/rework in `hitl` + `run` namespaces (EN + RU, ADR-014) | `web/messages/en.json`, `web/messages/ru.json` | both locales present |
| 6.5 | Board card: minimal rework/stale indicator on the in-flight card (full timeline is M11b) | `web/components/board/flight-card.tsx`, `web/lib/board.ts` | shows a "reworking" hint; no regression |
| 6.6 | **(P5b) Shared Playwright auth+seed harness — BORN HERE** (M11a is the first plan with an e2e and the first place a graph-run seed exists; M11b/M11c REUSE it). `playwright.config.ts` today has no `webServer`/`globalSetup`/`storageState` and the only specs are unauth `/login` smoke. Add: `web/e2e/global-setup.ts` (sign in the seeded `admin@maister.local` from migration 0005, persist `storageState`); a `webServer` block (or a documented + CI-gated `pnpm dev` + seeded-DB step); and a shared `tsx` seed helper that installs `aif`, creates a task, launches a run, and drives it to the `human_review` node via the mock-acp-adapter | `web/playwright.config.ts`, `web/e2e/global-setup.ts` (new), `web/e2e/_seed/*` (new) | authenticated `storageState` produced; seed helper drives a graph run to `human_review`; M11b/M11c can import it |
| 6.7 | **(P5a) M11a e2e: `web/e2e/m11a-review-rework.spec.ts`** — launch migrated `aif` → reach review HITL → click **rework** + comments → assert downstream `checks`/`judge` go **stale** → run returns to a **fresh review** gate → **approve** → run reaches `Review`. Uses the 6.6 harness | `web/e2e/m11a-review-rework.spec.ts` (new) | `pnpm --filter maister-web test:e2e` green; full review→rework→rerun→approve loop driven through the browser |

---

## Phase 7 — As-built docs reconciliation + verify

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 7.1 | Reconcile Phase-0 docs against shipped code; flip implementation-status tags; confirm contract-surface table fully satisfied | all Phase-0 docs | `/aif-verify` re-derives surfaces from the diff with no gaps |
| 7.2 | Run `pnpm validate:docs` (Mermaid gate), OpenAPI/AsyncAPI validators | docs | zero errors |
| 7.3 | Full suite green; enumerate any quarantined (Docker-only) tests with reasons | — | `pnpm test:unit && pnpm test:integration` green (Docker-gated ones noted) |

---

## Commit Plan (checkpoints every ~1 phase)

1. **Phase 0** → `docs(m11a): graph/ledger/gate ADRs + analytics + ERD + flow-dsl`
2. **Phase 1–2** → `feat(m11a): nodes[] schema + validation + node_attempts/gate_results migration 0008`
3. **Phase 3** → `feat(m11a): graph compiler + runner (linear back-compat preserved)`
4. **Phase 4** → `feat(m11a): full-featured gate execution + staleness`
5. **Phase 5** → `feat(m11a): review-driven rework via declared decisions`
6. **Phase 6** → `feat(m11a): migrate aif to nodes + review UI + i18n + e2e auth/seed harness + review-rework spec`
7. **Phase 7** → `docs(m11a): as-built reconciliation + verify gate`

## Verification (end-to-end)

1. **Back-compat:** install + launch the linear `greet`/legacy `aif`-style flow →
   runs to `Review` exactly as before (criterion #2). Integration: existing
   "aif suspend at review" case still green.
2. **Graph rework demo (criterion #3):** launch migrated `aif`
   (`plan→implement→checks→judge→review`); at `review` submit `decision: rework`
   + comments → assert: review node attempt = `Reworked`; `checks`/`judge`
   `gate_results` flip to `stale`; `implement` gets attempt N+1 with
   `review_comments` in context; gates rerun; run returns to a fresh `review`
   HITL. Approve → run → `Review`.
3. **Validation (criterion #1):** unit-assert each rejection — unknown node id,
   unknown decision target, cycle without `maxLoops`, unsupported workspace
   policy, both/neither of steps/nodes, engine_min<1.1.0.
4. **Gates full-featured:** `command_check` pass/fail by exit code;
   `ai_judgment` structured verdict in `gate_results.verdict`; blocking gate
   failure aborts finish; advisory records + continues; stale→rerun.
5. **Trust-before-execute:** launch a graph flow on an `untrusted` revision with
   a `command_check` → refused before any command runs (no side effect).
6. **Ledger immutability:** after a rework loop, `node_attempts` shows every
   attempt append-only (no row mutation/overwrite), highest-attempt-wins in
   templating.
7. **Docs gate:** `pnpm validate:docs` + OpenAPI lint clean; suite green.
8. **Settings no-strip:** a manifest carrying a node `settings` block validates,
   the block is preserved (not zod-stripped), and the
   `WARN [flow] node settings parsed but not enforced until M11c` fires.
9. **Legacy resume:** a fabricated pre-M11a `NeedsInput` run with `step_runs`
   rows but no `node_attempts` resumes cleanly (seeds from `step_runs`), no
   fail-closed/restart.
10. **(P5) Playwright e2e:** `m11a-review-rework.spec.ts` drives the migrated
    `aif` through the browser: review → rework + comments → downstream gates
    stale → fresh review → approve → `Review`. Runs on the shared auth/seed
    harness born in Phase 6.6.

Run locally: `pnpm --filter maister-web test:unit`,
`pnpm --filter maister-web test:integration` (Docker-gated cases on CI),
`pnpm --filter maister-web test:e2e`, `pnpm --filter maister-web lint`,
`pnpm validate:docs`.

---

## Неразрешённые вопросы (ответь до старта)

1. **M11b/M11c границы ок?** M11a = граф+леджер+рерработка+гейты; takeover+timeline → M11b; typed settings+enforcement → M11c. Подтверждаешь нумерацию роадмапа?
2. **`skill_check` без скоупинга** в M11a (полный capability-скоупинг = M14) — приемлемо как "best-effort"?
3. **`artifact_required` / `external_check`**: в M11a только схема+статус, без исполнения (M12 / M16). Норм, или один из них нужен исполняемым уже сейчас?
4. **workspacePolicy**: в M11a реально работает только `keep`; `rewind-to-checkpoint`/`fresh-attempt` — записываются, но исполнение в M11b. Ок?
5. ✅ **РЕШЕНО (user: «все так»)** — Гейты "full-featured" vs M15: M11a забирает исполнение гейтов; M15 ре-скоупится в "readiness-policy DSL + калибровка вердиктов + ingestion external_check". Зафиксировано в ADR-024 + Phase 0.2 roadmap-renumber + Phase 0.7 flow-dsl (P4).
6. **`node_attempts` заменяет `step_runs`** для graph-флоу (step_runs только legacy-чтение). Не против постепенной депрекации step_runs?
7. **Разнос критерия #1 роадмапа**: валидация ролей → M13, MCP/tool/skill/node-executor → M14 (в M11a НЕ дублируем — иначе пересечение с M13/M14). Согласен с такой передачей, чтобы критерии были distinct?
8. **`settings` в M11a**: парсим как opaque passthrough + WARN (без enforcement до M11c) — ок, или лучше жёстко reject `settings` в M11a?
