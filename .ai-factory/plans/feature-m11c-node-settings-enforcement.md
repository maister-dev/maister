# M11c — Node typed settings + runtime enforcement boundary

> Third slice of the split M11 milestone (after M11a graph/ledger/rework and
> M11b takeover/timeline). Implement on a matching
> `feature/m11c-node-settings-enforcement` branch so branch-based consumers
> (`/aif-implement`, `/aif-verify`) discover this file.

## Context

M11 ("Flow graph maturity") was split into **M11a / M11b / M11c** (ADR-025,
recorded in the M11a plan). M11a ships the graph manifest (`nodes[]`), the
append-only `node_attempts` ledger, the rework loop, and full-featured gate
execution. **Critically, M11a deliberately punts on node `settings`:** Phase 1
task 1.6 of the M11a plan accepts an **optional opaque `settings` passthrough**,
records it unparsed, and emits a one-time
`WARN [flow] node settings parsed but not enforced until M11c`. M11a's `flow-dsl.md`
update tags the `settings` block as **M11c-Designed (NOT M11a-Implemented)**.
M11c is the milestone that turns that opaque blob into a typed, validated,
visible, and partially-enforced contract.

M11c owns **roadmap criterion #6** ("AI node settings are visible in the UI and
enforced by runtime boundaries: no undeclared MCP/tool/skill/restriction escape
hatch is silently allowed") and the **node-settings-schema half of criterion #8**
("Docs cover the Flow graph schema, **node settings schema**, run ledger, …").

**The hard problem — and the central analysis the reviewer will check — is the
M11c↔M14 dependency.** Roadmap **M14 ("Scoped capability materialization")**
owns the capability **registry** (named MCP/skill/agent/tool/restriction
records with `enforceability: enforced | instructed | unsupported`), the
**import-from-git-with-resolved-SHA** flow, the **agent-aware mapping**
resolution (`tools: [shell]` → concrete Claude/Codex tool names), and the
**materialization** that actually writes `settings.json` / MCP config / skills
per session and cleans them up. M14's own acceptance criteria already state the
runtime-enforcement-boundary verbatim: *"Before a node runs, MAIster builds the
per-node agent environment from resolved capabilities only. If a node requires
strict enforcement for a capability that is only `instructed` or `unsupported`
… launch fails with `CONFIG` or `EXECUTOR_UNAVAILABLE`; silent fallback is
forbidden."* **Real enforcement of criterion #6 therefore DEPENDS on the M14
registry: you cannot resolve `mcps: [github]` to an enforceability verdict
without the registry that records that verdict.**

Roadmap criterion **#1's "unknown MCP/tool references" clause is assigned to
M14** (M14 AC: "Flow validation rejects unknown MCPs, tools, skills, agents,
restriction policies, environment profiles, and unsupported agent/capability
mappings"). The M11a carve table explicitly hands "#1 unknown MCP/tool/skill
refs + node-level executor refs → **M14**". **M11c MUST NOT duplicate M14's
registry-reference validation.**

**Decision taken (this plan), made unmistakable in Context / Scope / Acceptance:**
adopt carve **(b)** — *ship the typed settings SCHEMA + shape validation + UI
visibility + the launch-time REFUSAL boundary now; defer capability-ref
resolution + materialization + enforceability lookup to M14.* Concretely:

- M11c replaces the M11a opaque `settings` passthrough with a **typed,
  per-node-type discriminated `settings` schema** and **removes the M11a
  "parsed but not enforced" WARN**.
- M11c validates settings **shape and intra-manifest references** only:
  enum membership (`permissionMode`, `failureClass`), structural well-formedness,
  numeric bound sanity (`limits`), and references that resolve **inside the
  manifest or against already-known server-state** (executor refs against
  `maister.yaml executors[]` via the existing M6 chain; human `decisions`
  against the node's declared `transitions`, reusing M11a's validator).
- M11c **records an explicit, declared `enforcement` intent per capability-
  bearing setting** (`strict | instruct | off`) and builds the launch-time
  **REFUSAL boundary**: if any node declares `enforcement: strict` on a
  capability class that the current MAIster build can only INSTRUCT or that is
  UNSUPPORTED for the resolved executor's agent, **launch fails with
  `MaisterError("CONFIG")` or `MaisterError("EXECUTOR_UNAVAILABLE")` — silent
  fallback is FORBIDDEN.** Until M14 lands the materializing registry, the
  *static enforceability table* (which capability classes MAIster can strictly
  enforce per agent) is a code constant in M11c, conservatively set so that
  every capability class whose enforcement requires M14 materialization is
  `instructed` (thus a `strict` declaration on it correctly REFUSES launch
  rather than silently weakening the boundary).
- M11c surfaces the resolved settings in the **run-detail UI** as
  `enforced / instructed / refused-before-launch`, satisfying the "visible in
  the UI" half of criterion #6.

This gives criterion #6 a **complete, honest, non-silent** slice now: the
schema and visibility are real, the refusal boundary is real and correct, and
M14 later flips capability classes from `instructed` to `enforced` (and adds
ref-resolution against the registry) **without weakening the contract** —
strictly *more* will be enforceable, never less. The carve below states exactly
which clauses M14 inherits.

Intended outcome of M11c: a graph `aif` node declares a typed `ai_coding`
`settings` block; the run-detail UI shows each setting tagged
`enforced/instructed/refused`; a flow that declares `enforcement: strict` on a
capability class MAIster cannot yet strictly enforce is **refused at launch**
with the typed error surfaced in the UI; and the M11a opaque-passthrough WARN
is gone, replaced by typed validation.

## Scope boundary — what M11c does and does NOT include

| In M11c | Deferred |
| ------- | -------- |
| Typed per-node-type `settings` discriminated schema (replaces M11a opaque passthrough) | The capability **registry** of named MCP/skill/agent/tool/restriction records (**M14**) |
| Removing the M11a `WARN [flow] node settings parsed but not enforced until M11c` | Import-from-git-with-resolved-SHA for capabilities (**M14**) |
| Shape + enum + bound validation of settings at the **node** level | **Agent-aware mapping** resolution (`tools:[shell]` → concrete names) (**M14**) |
| Executor-ref validation in `settings.executors` against `maister.yaml executors[]` (reuses M6 chain) | **Materialization**: writing `settings.json` / MCP config / skills per session + cleanup (**M14**) |
| Human `settings.decisions`/`allowFurtherTracks`/`allowTakeover`/`returnRequires`/SLA hints — shape + cross-ref to `transitions` (reuses M11a validator) | Registry **reference validation** of `mcps`/`tools`/`skills`/`agents`/`restrictions` ("unknown MCP/tool" = roadmap #1) (**M14**) |
| Explicit per-setting `enforcement: strict\|instruct\|off` intent recorded in the manifest | `enforceability` *lookup against registry records* (`enforced/instructed/unsupported` per concrete capability) (**M14**) |
| Launch-time **REFUSAL boundary**: `strict` on a class MAIster can only instruct / that is unsupported → `CONFIG`/`EXECUTOR_UNAVAILABLE`, no silent fallback | Long-living-session profile-swap / fresh-session-boundary enforcement (**M14**) |
| Static per-agent enforceability table (code constant; conservative) | Flipping classes from `instructed`→`enforced` as materialization lands (**M14**) |
| Run-detail UI: settings shown as `enforced/instructed/refused` (criterion #6 "visible") | Evidence-graph capability-profile panel with resolved revisions (**M14** AC: "Run detail shows the resolved capability profile … enforced/instructed/refused") |
| `cli/check/judge` `settings`: `command`/`timeout`/`environmentPolicy`/`inputArtifacts`/`outputArtifacts`/`failureClass` — shape + enum validation | Human-node **role** refs validated against a project role registry (**M13**) |
| Docs: node settings schema promoted Designed→Implemented (M11c subset) | Cost/time `limits` **enforcement** (kill-on-cap) — recorded + displayed, not enforced (ADR open question; Phase 2) |

## Locked architecture decisions (from this session's carve → new ADRs in Phase 0)

1. **Carve (b): schema + shape-validation + visibility + refusal now; capability
   resolution + materialization → M14.** The M11c↔M14 boundary is a hard
   dependency, not an overlap. M11c never reads a capability registry, never
   resolves an abstract capability id, never materializes a settings file, and
   never validates an MCP/tool/skill/agent/restriction *reference* against a
   registry (that is M14, roadmap #1). M11c validates settings *shape* and
   *enforcement intent* and refuses launch when a declared `strict` intent
   exceeds the build's static enforcement capability. → **ADR-027**.
2. **Typed `settings` discriminated by node `type`.** `ai_coding` / `human` /
   `cli` / `check` / `judge` each get a distinct settings shape. The M11a opaque
   passthrough (`z.unknown()` recorded + WARN) is **replaced** by these typed
   schemas; the WARN is **removed**. A node MAY omit `settings` (back-compat:
   compiled-linear nodes and minimal graph nodes carry no settings). → **ADR-027**.
3. **Explicit declared `enforcement` per capability-bearing setting**
   (`strict | instruct | off`, default `instruct`). Enforcement is a
   *declaration by the flow author*, resolved against a **static per-agent
   enforceability table** (code constant `ENFORCEABILITY_BY_AGENT` in
   `web/lib/flows/enforcement.ts`). The table is conservative: any class that
   needs M14 materialization to be strictly enforced is `instructed`, so
   `strict` on it correctly REFUSES rather than silently weakens. M14 flips
   entries `instructed → enforced` as materialization lands — the contract only
   ever tightens. → **ADR-028**.
4. **Refusal throws an EXISTING `MaisterError` code (ADR-008 closed union).**
   A `strict` declaration on a class MAIster cannot strictly enforce for the
   resolved executor's agent → `MaisterError("CONFIG")` when the flow/manifest
   is internally over-declaring (build cannot enforce this class at all), or
   `MaisterError("EXECUTOR_UNAVAILABLE")` when the class is enforceable for some
   agents but `unsupported` for the *resolved* executor's agent. **No new error
   code.** → **ADR-028** + contract-surface trace row D.
5. **Enforcement attaches at LAUNCH precondition + node-action build, not at the
   supervisor wire.** The refusal runs in `web/app/api/runs/route.ts`
   precondition block (whole-manifest static check at launch) AND immediately
   before a node's `action` is built in the graph runner
   (`web/lib/flows/graph/runner-graph.ts`, per-node, post executor-resolution),
   so a per-node executor override (M14-era) cannot smuggle an unenforceable
   class past the launch check. The supervisor `spawn.ts` env construction is
   **unchanged in M11c** (the materialized env layer is M14); M11c only *gates*
   whether the node is allowed to launch at all. → **ADR-028**.

## Settings

- **Testing:** yes (project norm; every prior milestone shipped unit +
  integration suites). M11c additionally **migrates the M11a settings-passthrough
  tests** (the `settings no-strip` + WARN assertions) — see Phase 1.
- **Logging:** verbose (`pino` INFO on typed-settings parse with per-class
  enforcement tally; WARN per `instruct`-downgraded class; the refusal path logs
  the offending node id + class + resolved agent at the throw site).
- **Docs:** mandatory checkpoint (route through `/aif-docs`). Docs are **Phase 0**
  (analytics-first per skill-context), reconciled as-built before completion.

## Roadmap Linkage

- **Milestone:** "M11. Flow graph maturity …" — this plan delivers the **M11c**
  slice (node typed settings + enforcement-boundary refusal + UI visibility).
  M11a (graph/ledger/rework/gates) and M11b (takeover/timeline) precede it.
  M11c depends on M11a's `nodes[]` schema, `node_attempts` ledger, and graph
  runner; it depends on M14 for *materializing* enforcement (carve (b) above).

---

## Acceptance Criteria (M11c)

Each M11c AC names its originating roadmap criterion (#6, or #8-settings-docs)
and the Verification item that proves it.

**M11c owns:**

- **AC-1 (roadmap #6, "settings exist as typed config") — Typed settings schema.**
  Every node `type` accepts a typed `settings` block; `ai_coding` declares
  allowed executors/agent-definitions, model/thinking-effort constraints,
  allowed MCP servers, allowed tools (agent-aware *map shape*), shipped skills,
  workspace+artifact access rules, permission mode, cost/time limits, explicit
  restrictions; `human` declares roles/assignees, allowed decisions, further-
  tracks/rework allowed, manual-takeover allowed, SLA/staleness hints, return
  requirements; `cli/check/judge` declare commands, timeout, environment policy,
  artifact inputs/outputs, failure classification. The M11a opaque passthrough
  and its WARN are removed. → Verify #1.
- **AC-2 (roadmap #6, "no silent escape hatch") — Launch-time refusal boundary.**
  Before a node runs, MAIster builds the per-node agent environment from
  resolved settings ONLY; if a node declares `enforcement: strict` on a
  capability class MAIster can only INSTRUCT or that is UNSUPPORTED for the
  resolved executor's agent, **launch fails** with `MaisterError("CONFIG")` or
  `MaisterError("EXECUTOR_UNAVAILABLE")`. No silent fallback path exists.
  → Verify #2, #3.
- **AC-3 (roadmap #6, "visible in the UI") — Settings visibility.** Run-detail UI
  shows, per `ai_coding` node, each setting tagged `enforced / instructed /
  refused`, including the refusal reason when launch was blocked. EN+RU.
  → Verify #4.
- **AC-4 (roadmap #1 subset, node-level only — see carve) — Node-level
  settings-shape validation.** Manifest validation rejects: unknown
  `permissionMode`/`failureClass`/`thinkingEffort` enum values; malformed
  agent-aware `tools` map; out-of-range `limits`; `settings.executors` ids not
  present in `maister.yaml executors[]`; human `settings.decisions` not matching
  the node's declared `transitions`; unknown `enforcement` value. It does **NOT**
  validate MCP/tool/skill/agent/restriction *registry references* (that is M14).
  **(P1) `settings.executors` ref validation is confirmed M11c-owned — the M11a
  carve table was updated to hand node-level executor refs here (both plans now
  agree; M14 keeps only the capability-registry refs).** → Verify #5.
- **AC-5 (roadmap #8, node-settings docs) — Docs.** `docs/flow-dsl.md` promotes
  the node `settings` block from M11c-Designed to Implemented for the M11c
  subset, tags the M14 capability-resolution/materialization parts, and
  documents the enforcement-boundary semantics + the static enforceability
  table. A system-analytics doc covers the enforcement boundary. → Verify #6.
- **AC-6 — Back-compat.** A `steps[]`-only manifest (compiles to settings-less
  nodes) and a graph node with no `settings` both run unchanged; absence of
  `settings` never triggers a refusal. → Verify #1.
- **AC-7 — Trust before execute (skill-context).** The M10 launch precondition
  refuses `untrusted` revisions BEFORE the settings refusal check runs; a graph
  flow on an untrusted revision carrying `enforcement: strict` is refused on the
  trust gate first, never reaching the enforcement evaluator. → Verify #7.

**Explicitly NOT M11c (carve table — no clause double-listed):**

| Clause from roadmap M11 / M14 | Owner | Why not M11c |
| ----------------------------- | ----- | ------------ |
| #1 "unknown **MCP/tool/skill/agent/restriction** references" (registry-ref validation) | **M14** | M14 already owns "rejects unknown MCPs, tools, skills, agents, restriction policies, environment profiles, and unsupported agent/capability mappings". M11c validates *shape* + *intra-manifest/executor refs* only; it never reads the registry. |
| #1 "unknown **roles**" (human-node role refs) | **M13** | M13 owns "rejects human nodes that reference unknown project roles". M11c validates `human.settings.decisions` against `transitions` (shape), NOT roles against a registry. |
| Capability **registry**, import-from-git resolved SHA, **agent-aware mapping** resolution | **M14** | M14 expectations: "capability registry", "skill and capability import", "agent-aware mapping". |
| **Materialization** (write `settings.json`/MCP config/skills per session + cleanup) and flipping classes `instructed→enforced` | **M14** | M14 expectations: "scoped materialization" + "runtime enforcement boundary" *materialized*. M11c only *gates launch* on the static table. |
| Run-detail **capability-profile panel** with resolved capability revisions snapshotted in the ledger | **M14** | M14 AC: "Run detail shows the resolved capability profile for each AI-coding node, including what was enforced, instructed, or refused." M11c ships the *settings-visibility* view from the *manifest* (no resolved-revision snapshot). |
| Manual takeover (`HumanWorking`), rich run-detail timeline, returned diff | **M11b** | — |
| Graph/`nodes[]` schema, `node_attempts` ledger, rework loop, gate execution | **M11a** | M11c *consumes* these; it does not create them. |
| Cost/time `limits` **enforcement** (kill-on-cap) | **Phase 2** | ADR open question "guard enforcement"; M11c records + displays limits, does not kill on cap. |

> M11c's AC-4 deliberately covers only the *node-level settings-shape* subset of
> roadmap #1. The MCP/tool/skill/agent/restriction-reference subset of #1 is M14;
> the role subset is M13. This keeps the three milestones' #1 coverage **complete
> and non-overlapping**, and is the authoritative input for any Phase 0 roadmap
> reconciliation (delegated to the roadmap owner, not hand-edited here).

---

## Phase 0 — Analytics, schema design, ADRs (docs-first; no code) 🔴 gate before any code

Per skill-context: analytics is an **input** to implementation. This phase MUST
be complete and internally consistent before Phase 1. Exit criterion: every
artifact below exists, cross-references resolve, and implementation-status tags
(Implemented/Designed/Phase 2) are correct for HEAD-after-M11c.

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 0.1 | ADR-027 (node typed settings schema; carve (b) M11c↔M14 boundary), ADR-028 (enforcement-boundary refusal: declared `enforcement` intent, static `ENFORCEABILITY_BY_AGENT` table, CONFIG/EXECUTOR_UNAVAILABLE mapping, attach points, NO new error code). **(P2) M11c owns ADR range 027–028** (HEAD `decisions.md` ceiling = ADR-021; M11a = 022–025; M11b = 026). Drafted as 026/027, renumbered to clear the M11b collision; **read `decisions.md` HEAD before committing** since M11a/M11b land first | `docs/decisions.md` (append, index rows) | 2 ADRs `Accepted`, sequential (027, 028), template-conformant; both explicitly cite the M14 dependency and ADR-008 closed union |
| 0.2 | Roadmap reconciliation (delegate to roadmap owner): confirm M11c inherits **roadmap #6 + #8-settings-docs**; confirm #1-MCP/tool/skill/agent/restriction-refs stays **M14**, #1-roles stays **M13**, **#1-node-settings-shape AND node-level executor refs (`settings.executors`) are M11c** (P1 — M11a's carve hands executor refs here) — **no clause dropped, none double-listed**. **(P8) Record criterion #6 as SPLIT: "settings visible in UI + launch-time REFUSAL boundary (M11c)" vs "materialized positive enforcement / `instructed→enforced` flip (M14)".** #6 must NOT be marked fully "done" after M11c while MCP/tool/skill are only refused-if-strict, never materially constrained until M14 | `.ai-factory/ROADMAP.md` via `/aif-roadmap` | M11c entry carries criterion #6 (refusal slice) + #8-settings; #6 split M11c/M14 recorded; the #1 split across M11c/M13/M14 recorded; ownership boundary respected (not hand-edited here) |
| 0.3 | New/extended system-analytics doc: the **enforcement boundary** — per-node settings resolution, declared `enforcement` intent, static enforceability table, the launch-time refusal allow-list (per `docs/CLAUDE.md` R5: Purpose/Entities/State machine/Process flows/Expectations/Edge cases/Linked). MUST enumerate **every** refusal precondition exactly as code will gate (allow-list shape: "launch proceeds iff for every capability-bearing setting with `enforcement: strict`, `ENFORCEABILITY_BY_AGENT[agent][class] === 'enforced'`"). MUST state the invariant that M14 only ever flips `instructed→enforced` (contract tightens, never loosens). | `docs/system-analytics/flow-settings.md` (new) or a dedicated section in `flows.md` | refusal allow-list written the way it is implemented; CONFIG vs EXECUTOR_UNAVAILABLE branch enumerated; M14 hand-off stated |
| 0.4 | Promote `docs/flow-dsl.md` node `settings` block from **M11c-Designed → Implemented (M11c subset)**; tag the M14 parts (registry resolution, agent-aware mapping, materialization) as **M14-Designed**; document the per-setting `enforcement` field + the refusal semantics; document back-compat (settings optional). MUST NOT imply M11c resolves capability refs or materializes anything. | `docs/flow-dsl.md` | node `settings` sections marked Implemented for the M11c subset; M14 parts tagged; `enforcement` field documented; "no materialization in M11c" stated |
| 0.5 | Update `docs/configuration.md` Flow-DSL section: the typed `settings` shape per node type, the `enforcement` enum, the static enforceability table reference. Add an env-var row ONLY if Phase 4 introduces one (see deployment-touchpoints — currently **none planned**). | `docs/configuration.md` | settings shape + `enforcement` enum documented; env-var table unchanged unless 0.7 says otherwise |
| 0.6 | ERD touch — confirm whether any new column is needed (see Phase 2). If `runs`/`node_attempts` gains a resolved-settings/enforcement snapshot column, update BOTH `docs/database-schema.md` narrative AND `docs/db/runs-domain.md` Mermaid `erDiagram`. If no column is added (settings live in the pinned manifest, read at launch/run), state that explicitly. | `docs/database-schema.md` + `docs/db/runs-domain.md` (only if a column is added) | narrative AND Mermaid both updated OR an explicit "no schema change in M11c" note in the plan + Phase 2 acceptance |
| 0.7 | **Deployment-touchpoints task (skill-context).** Determine whether M11c adds any new env var / bound port / sidecar / config-file path. **Current design adds NONE** — the static enforceability table is a code constant, settings live in the manifest, enforcement attaches in existing web routes. Record the explicit "no new env var / port / sidecar → no `.env.example`/`compose.*` change required" finding; if Phase 4 surfaces a tunable (e.g. `MAISTER_SETTINGS_ENFORCEMENT_MODE`), this task wires `.env.example` + `compose.yml` web service block. | this plan + (conditionally) `.env.example`, `compose.yml`, `docs/configuration.md` | explicit deployment-touchpoints finding present; nothing silently skipped |
| 0.8 | **Contract-surface tracing table** (skill-context): map each changing surface → spec file (see below) | this plan + Phase 0 docs | every surface in the table has an owning task |

**Contract surfaces this milestone touches (skill-context trace):**

| Surface | Spec file | Owning task |
| ------- | --------- | ----------- |
| Manifest node `settings` (typed per type) + per-setting `enforcement` field + removal of M11a opaque passthrough | `docs/flow-dsl.md` + `web/lib/config.schema.ts` | 0.4 / Phase 1 |
| Node-level settings validation rejections (enum/bound/executor-ref/decision-ref) | `docs/system-analytics/flow-settings.md` + `web/lib/config.ts` | 0.3 / Phase 1 |
| Launch refusal → `CONFIG` / `EXECUTOR_UNAVAILABLE` (existing codes; richer message) | `docs/error-taxonomy.md` (extend existing code matrices with the new caller; NO new code) + `web/app/api/runs/route.ts` + `runner-graph.ts` | 0.3 / Phase 0.9 / Phase 3 |
| Run-detail settings-visibility view (server-rendered; no new HTTP route) | `docs/system-analytics/flow-settings.md` UI section (no OpenAPI change — server component reads the pinned manifest) | 0.3 / Phase 4 |
| (conditional) resolved-settings snapshot column on `node_attempts`/`runs` | migration `0010` (P3 — after M11b's `0009`) + `docs/database-schema.md` + `docs/db/runs-domain.md` | 0.6 / Phase 2 |

| 0.9 | Extend `docs/error-taxonomy.md`: add the M11c **settings-enforcement refusal** as a new *caller* under the EXISTING `CONFIG` and `EXECUTOR_UNAVAILABLE` matrices (no new code, ADR-008). State the branch rule: build-cannot-enforce-this-class-at-all → `CONFIG`; class-enforceable-for-some-agents-but-`unsupported`-for-resolved-agent → `EXECUTOR_UNAVAILABLE`. | `docs/error-taxonomy.md` | both matrices gain an M11c caller row; closed-union exhaustiveness note unchanged |

> No new env var, bound port, sidecar binary, or config-file path is introduced
> in M11c (the enforceability table is a code constant; settings ride in the
> already-pinned manifest) → no `Dockerfile`/`compose.*`/`.env.example` change
> required (skill-context deployment-touchpoints rule: explicitly nothing to
> wire). Revisit only if Phase 4 adds a tunable.

---

## Phase 1 — Typed settings schema + node-level validation (replace M11a passthrough)

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 1.1 | Add `aiCodingSettingsSchema`: `executors?: string[]`, `model?: string`, `thinkingEffort?: enum(low\|medium\|high)`, `mcps?: string[]`, `tools?: { claude?: string[]; codex?: string[] }`, `skills?: string[]`, `settingsProfile?: string`, `workspaceAccess?: enum(read\|write\|none)`, `artifactAccess?: string[]`, `permissionMode?: enum(ask\|allow\|deny)`, `limits?: { maxDurationMinutes?: number>0; maxCostUsd?: number>0 }`, `restrictions?: string[]`, and the per-class `enforcement?: { mcps?: Enf; tools?: Enf; skills?: Enf; restrictions?: Enf; permissionMode?: Enf; workspaceAccess?: Enf }` where `Enf = enum(strict\|instruct\|off)` default `instruct` | `web/lib/config.schema.ts` | zod parses the `flow-dsl.md` `implement` example; rejects unknown enum values |
| 1.2 | Add `humanSettingsSchema`: `roles?: string[]`, `assignees?: string[]`, `decisions?: string[]`, `allowFurtherTracks?: boolean`, `allowTakeover?: boolean`, `slaHours?: number>0`, `stalenessHint?: string`, `returnRequires?: string[]`; `cliCheckJudgeSettingsSchema`: `command?: string`, `timeoutMs?: number>0`, `environmentPolicy?: enum(inherit\|clean\|whitelist)`, `inputArtifacts?: string[]`, `outputArtifacts?: string[]`, `failureClass?: enum(blocking\|advisory\|retryable)` | `web/lib/config.schema.ts` | each rejects unknown enum; shape asserted in tests |
| 1.3 | Wire `settings` into the M11a `nodeSchema` discriminated union: `ai_coding` → `aiCodingSettingsSchema.optional()`, `human` → `humanSettingsSchema.optional()`, `cli`/`check`/`judge` → `cliCheckJudgeSettingsSchema.optional()`. **REMOVE** the M11a opaque `z.unknown()` passthrough field and the WARN emission. | `web/lib/config.schema.ts`, `web/lib/config.ts` | the M11a passthrough is gone; a node with no `settings` still validates |
| 1.4 | Node-level settings validation in `loadFlowManifest`: reject `settings.executors[]` ids not present in `maister.yaml executors[]` (resolve via existing M6 ref set passed into the loader / cross-checked at launch — see note); reject human `settings.decisions[]` whose members are not keys of the node's `transitions`; reject out-of-range `limits`; reject `enforcement` on a node type that has no such class. Each rejection throws `MaisterError("CONFIG", …)` with the node id + field. INFO log per validated manifest with per-node settings + enforcement tally. | `web/lib/config.ts` | each rejection path asserted; INFO line present |
| 1.5 | Export `AiCodingSettings`, `HumanSettings`, `CliCheckJudgeSettings`, `EnforcementMode`, `EnforcementMap` TS types | `web/lib/config.schema.ts` | consumed by enforcement evaluator + UI |
| 1.6 | **Supersede the M11a settings-passthrough tests.** Enumerated migration (skill-context — do not trim): the M11a `config.schema` test asserting "a manifest carrying `settings` validates, the block is preserved (not stripped)" → rewrite to assert the block is now **typed-parsed** into the discriminated shape; the M11a `config` test asserting the WARN fires → **delete the WARN assertion and add an assertion that NO such WARN is emitted**. **(P14) Assert against the named symbol: the M11a `SETTINGS_NOT_ENFORCED_WARN` constant is removed from `config.ts` (its export is deleted / never logged), not a brittle string match** — this hardens the M11a→M11c handoff against message drift. Add fixtures: valid typed `ai_coding`/`human`/`cli` settings; each rejection case. | `web/lib/__tests__/config.schema.*`, `web/lib/__tests__/config.*` | per skill-context: name the runner project (`unit`), confirm `vitest list --project unit` matches the files; old WARN assertion gone; new typed assertions green |

> **Executor-ref validation note (skill-context body-controlled / config-state).**
> `settings.executors[]` is a *manifest-controlled* set of executor *ref ids*.
> M11c validates them against the project's `executors[]` ref set (the same set
> the M6 `resolveExecutor` chain uses), NOT against a body field. There is no
> YAML→DB persistence of settings in M11c (settings live in the pinned manifest),
> so the config-state SET/CLEAR/re-SET symmetry rule is **N/A** — state this in
> the plan. Per-step executor *override* refs remain M14 (carve).

---

## Phase 2 — (Conditional) schema snapshot column + decide persistence

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 2.1 | **Decide persistence (analytics-driven, Phase 0.6).** Default: settings are NOT persisted to a new column — the run pins `flowRevisionId` (M10) whose `manifest` jsonb already carries the node `settings`; the enforcement evaluator and the run-detail UI read settings from the pinned manifest. If Phase 0.6 concludes a *resolved enforcement verdict snapshot* is needed for audit (which classes were `enforced/instructed/refused` at launch), add `node_attempts.enforcement_snapshot jsonb` (M11a table) in migration **`0010`** (P3 — `0008`=M11a < `0009`=M11b < `0010`=M11c-if-needed; NOT `0009`, which M11b owns). | `web/lib/db/schema.ts`, `web/lib/db/migrations/0010_*.sql` (only if needed) | EITHER an explicit "no schema change — settings read from pinned manifest" note + zero migration, OR additive `0010` with both ERD artifacts updated (0.6) |
| 2.2 | If 2.1 adds a column: type export (`NodeAttempt` extended) + drizzle peer-dep `as any` cast pattern matching existing usage | `web/lib/db/schema.ts` | — |

> **DB symmetry note (skill-context):** no YAML→DB *removable* settings field is
> persisted in M11c (settings ride in the immutable pinned manifest), so the
> SET/CLEAR/re-SET round-trip rule does not apply (N/A). The optional
> `enforcement_snapshot` (if added) is an append-only audit record, never a
> mutable mirror of a YAML field.

---

## Phase 3 — Enforcement evaluator + launch refusal boundary

The core of M11c. A pure evaluator over `(node.settings, resolvedAgent)` that
returns, per capability class, one of `enforced | instructed | refused`, plus
the launch-gate wiring that throws on any `refused`.

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 3.1 | `ENFORCEABILITY_BY_AGENT: Record<'claude'\|'codex', Record<CapabilityClass, 'enforced'\|'instructed'\|'unsupported'>>` — the **static** table. Conservative seed: every class whose strict enforcement needs M14 materialization (`mcps`, `tools`, `skills`, `restrictions`, `workspaceAccess`) is `instructed` for both agents; `permissionMode` is `enforced` for `claude` ONLY IF the `--permission-mode` flag is **verified end-to-end** against `claude-agent-acp@0.37.0` (that a `deny`/`ask` mode is actually honored by the adapter). **(P11) If that flag cannot be verified to hold within M11c, seed the ENTIRE table `instructed`** — a wrongly-`enforced` cell would let a `strict permissionMode` declaration PASS the launch gate while nothing enforces it, the exact silent escape hatch #6 forbids. Conservative-`instructed` always REFUSES `strict` correctly; M14 flips cells to `enforced` once it owns the spawn-env layer. TODO(M14) comment on every `instructed` cell M14 will flip. | `web/lib/flows/enforcement.ts` (new) | table present; NO cell seeded `enforced` without an end-to-end adapter-flag verification recorded in Phase 0.3; TODO(M14) markers on flippable cells |
| 3.2 | `evaluateNodeEnforcement(settings, agent)` → `{ class, declared: Enf, capability: 'enforced'\|'instructed'\|'unsupported', verdict: 'enforced'\|'instructed'\|'refused' }[]`. Rule: `verdict='refused'` iff `declared==='strict' && capability!=='enforced'`; `'enforced'` iff `declared==='strict' && capability==='enforced'`; else `'instructed'` (or `off`→omitted). Pure, no DB, no logging. | `web/lib/flows/enforcement.ts` | unit-tested truth table for every (declared × capability) combo |
| 3.3 | `assertNodeLaunchable(node, agent)` → throws on any `refused` class: `MaisterError("CONFIG")` when `capability==='instructed'` for ALL agents (build cannot strictly enforce this class at all), `MaisterError("EXECUTOR_UNAVAILABLE")` when the class is `enforced` for some agent but `unsupported`/`instructed` for the resolved agent. Error message names node id + class + agent + the declared/capability pair. **No new error code.** | `web/lib/flows/enforcement.ts` | both branches asserted; message shape asserted |
| 3.4 | **Launch precondition wiring.** In `web/app/api/runs/route.ts`, AFTER the M10 trust + enablement preconditions and AFTER executor resolution (M6 `resolveExecutor`), run a **whole-manifest** static check: for every `ai_coding` node, resolve the node's effective agent (run-launcher executor → its `agent`) and call `assertNodeLaunchable`. Any throw maps to 409 (`CONFIG`) / 503 (`EXECUTOR_UNAVAILABLE`) via the existing `httpStatusForCode`-equivalent, and creates NO worktree/run/workspace (precondition order: trust → enablement → executor → **settings-enforcement** → worktree). | `web/app/api/runs/route.ts` | refusal returns 409/503 with no side-effect; INFO log on pass with per-node verdict tally |
| 3.5 | **Per-node runtime gate.** Immediately before the graph runner builds a node's `action` (post per-node executor resolution, so an M14-era per-step override is also gated), call `assertNodeLaunchable(node, resolvedAgent)` again. A refusal here transitions the run terminal (`Failed`) with the typed `errorCode` recorded on the `node_attempts` row (M11a ledger). This is the belt-and-suspenders gate the carve mandates ("enforcement attaches in the supervisor spawn / runner-agent path"). | `web/lib/flows/graph/runner-graph.ts` | per-node refusal recorded on the ledger row; run → `Failed`; no agent process spawned for that node |
| 3.6 | **Deferred-release (skill-context).** The refusal in 3.5 fires BEFORE any ACP session / permission deferred is created for the node, so no deferred leaks. Add a regression test asserting that a node refused at 3.5 never calls `spawnSession` / never registers a permission deferred (spy asserts zero supervisor calls on the refusal path). | `web/lib/flows/graph/runner-graph.ts`, tests | spy verifies no supervisor session created on refusal |
| 3.7 | Enforcement unit + integration tests: truth table (3.2), CONFIG vs EXECUTOR_UNAVAILABLE branch (3.3), launch-precondition 409/503 no-side-effect (3.4), per-node ledger-recorded `Failed` (3.5) | `web/lib/flows/__tests__/enforcement.*`, `web/app/api/runs/__tests__/*.integration.test.ts` | per-phase green; runner `unit`+`integration` globs match; `app/**/__tests__` glob already covered |

**Identifier trust labels for the launch path (skill-context, ADR — body-controlled):**
`POST /api/runs` body is unchanged by M11c. `taskId` = `body-controlled` but
validated against server-state (existing M5/M9 behavior); `projectId`,
`flowRevisionId`, `agent` = `server-state` (derived from the task→flow→run row
and the pinned revision's manifest + resolved executor). The settings under
evaluation come from the **pinned `flow_revisions.manifest`** (server-state,
immutable), never from the request body. No new body-controlled identifier is
introduced.

---

## Phase 4 — Run-detail settings-visibility UI + i18n

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 4.1 | Server component panel that, for the run's pinned manifest, lists each `ai_coding` node's settings and runs `evaluateNodeEnforcement(settings, resolvedAgent)` to tag each capability class `enforced / instructed / refused`. For a run that was refused at launch, surface the refusal reason (read from the typed error recorded on the launch failure / `node_attempts` row). Server-derived labels pattern (mirror `package-actions.tsx` / `flow-packages-panel.tsx`). | `web/components/board/panels/flow-settings-panel.tsx` (new), wired into run-detail | panel renders the three states; no client secret leakage (settings carry no secrets — assert env-key fields excluded) |
| 4.2 | i18n keys for `enforced`/`instructed`/`refused`, capability-class labels, and the refusal reason in a `settings` (or `run`) namespace, **EN + RU** (ADR-014) | `web/messages/en.json`, `web/messages/ru.json` | both locales present; lint passes |
| 4.3 | Minimal indicator on the in-flight / review card when a node's settings were refused at launch (links to the panel); no regression to M11a/M11b card surfaces | `web/components/board/flight-card.tsx`, `web/lib/board.ts` | shows a "settings refused" hint; existing card tests green |

> **Security-relevant default (skill-context server-only-secrets):** the settings
> panel renders capability *classes* and *ids* only. It MUST NOT render any
> `executor.env` value or token; the `ai_coding` settings schema carries no
> secret fields (env/secrets stay in `executors.env`, server-side). Assert in a
> test that the panel's serialized props contain no `*TOKEN*`/`*KEY*`/`*SECRET*`
> substrings.

---

## Phase 5 — `aif` migration + back-compat fixtures

| # | Task | Files | Acceptance / logging |
| - | ---- | ----- | -------------------- |
| 5.1 | Add a typed `ai_coding` `settings` block to the migrated `aif` `implement` node (M11a migrated it to `nodes[]`): declare `tools`, `skills`, `permissionMode`, `limits`, and an `enforcement` map that is **all `instruct`** (so the bundled demo launches cleanly on the conservative table — M14 later flips to `strict` once materialization can honor it). | `plugins/aif/flow.yaml` | manifest validates; `aif` launches without refusal; demonstrates criterion #6 "visible" |
| 5.2 | Add a fixture flow that declares `enforcement: strict` on a class the static table marks `instructed` (e.g. `mcps`) → asserts launch is REFUSED with the typed error (drives Verify #2/#3 + the e2e). Keep a settings-less linear `greet` fixture asserting no refusal (AC-6). | test fixtures under `web/lib/flows/__tests__/_fixtures/` | strict-refusal fixture + settings-less back-compat fixture both present |

---

## Phase 6 — Playwright e2e

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 6.1 | E2e spec: (a) launch the migrated `aif` (all-`instruct` settings) → run-detail panel shows each `ai_coding` setting tagged `enforced/instructed`; (b) attempt to launch the strict-refusal fixture flow → launch is REFUSED and the run-detail / board surfaces the typed `CONFIG`/`EXECUTOR_UNAVAILABLE` error with the offending node + class. Playwright is already scaffolded (`web/playwright.config.ts`, `web/e2e/`, `test:e2e` script) — add `web/e2e/m11c-settings-enforcement.spec.ts`; no scaffolding needed. | `web/e2e/m11c-settings-enforcement.spec.ts` | `pnpm --filter maister-web test:e2e` green; both scenarios assert visible state |

---

## Phase 7 — As-built docs reconciliation + verify

| # | Task | Files | Acceptance |
| - | ---- | ----- | ---------- |
| 7.1 | Reconcile Phase-0 docs against shipped code; flip implementation-status tags (node `settings` Implemented for M11c subset, M14 parts Designed); confirm contract-surface table fully satisfied; confirm error-taxonomy gained ONLY new callers (no new code) | all Phase-0 docs | `/aif-verify` re-derives surfaces from the diff with no gaps |
| 7.2 | Run `pnpm validate:docs` (Mermaid gate), OpenAPI/AsyncAPI validators (no API contract change expected — confirm) | docs | zero errors |
| 7.3 | Full suite green; enumerate any quarantined (Docker-only) tests with reasons | — | `pnpm test:unit && pnpm test:integration && pnpm test:e2e` green (Docker-gated ones noted) |

---

## Commit Plan (checkpoints every ~1 phase)

1. **Phase 0** → `docs(m11c): node-settings + enforcement-boundary ADRs + analytics + flow-dsl/config/error-taxonomy`
2. **Phase 1–2** → `feat(m11c): typed per-node settings schema + node-level validation (replace M11a passthrough)`
3. **Phase 3** → `feat(m11c): enforcement evaluator + launch refusal boundary (CONFIG/EXECUTOR_UNAVAILABLE)`
4. **Phase 4** → `feat(m11c): run-detail settings visibility panel + EN/RU i18n`
5. **Phase 5** → `feat(m11c): migrate aif settings + back-compat/strict-refusal fixtures`
6. **Phase 6** → `test(m11c): playwright e2e — settings visible + strict-enforcement refusal`
7. **Phase 7** → `docs(m11c): as-built reconciliation + verify gate`

## Verification (end-to-end)

1. **Back-compat + visibility (criterion #6 "visible"):** launch the migrated
   `aif` (all-`instruct` settings) and a settings-less `greet`; both run; the
   run-detail panel shows each `aif` `ai_coding` setting tagged
   `enforced/instructed`; `greet` shows no settings and is never refused.
2. **Refusal boundary — CONFIG (criterion #6 "no silent escape hatch"):** a flow
   declaring `enforcement: strict` on a class `instructed` for ALL agents is
   refused at launch with `MaisterError("CONFIG")`, 409, no worktree/run created.
3. **Refusal boundary — EXECUTOR_UNAVAILABLE:** a flow declaring `enforcement:
   strict` on a class `enforced` for one agent but `unsupported` for the resolved
   executor's agent is refused with `MaisterError("EXECUTOR_UNAVAILABLE")`, 503,
   no side-effect.
4. **UI surfaces the refusal:** the run-detail / board surfaces the typed error
   (node id + class + agent) for the refused launch — proven in the Playwright
   e2e (Phase 6).
5. **Node-level validation (criterion #1 node-settings subset):** unit-assert
   each rejection — unknown `permissionMode`/`failureClass`/`thinkingEffort`
   enum, malformed `tools` map, out-of-range `limits`, `settings.executors` id
   absent from `executors[]`, human `decisions` not in `transitions`. Confirm M11c
   does NOT reject unknown MCP/tool/skill *registry* refs (that path is M14).
6. **Docs gate:** `pnpm validate:docs` + OpenAPI lint clean; `flow-dsl.md` node
   `settings` marked Implemented (M11c subset); error-taxonomy has new callers,
   no new code.
7. **Trust-before-execute:** an `untrusted` revision carrying `enforcement:
   strict` is refused on the M10 trust gate first — the enforcement evaluator is
   never reached (precondition order trust → … → enforcement).
8. **No passthrough/WARN regression:** the M11a `WARN [flow] node settings
   parsed but not enforced until M11c` is GONE; a test asserts it is not emitted
   and that `settings` is typed-parsed.

Run locally: `pnpm --filter maister-web test:unit`,
`pnpm --filter maister-web test:integration`,
`pnpm --filter maister-web test:e2e`,
`pnpm --filter maister-web lint`, `pnpm validate:docs`.

---

## Неразрешённые вопросы (ответь до старта)

1. **M11c↔M14 секвенс (главный вопрос).** Принимаем carve (b): сейчас —
   схема+shape-валидация+видимость+launch-refusal; capability-resolution +
   materialization + enforceability-lookup → M14. ИЛИ пересеквенсить M11c
   ПОСЛЕ M14 (тогда enforcement сразу настоящий, без статической таблицы)?
2. **`ENFORCEABILITY_BY_AGENT` стартовые значения.** Какой класс реально
   strict-enforceable БЕЗ M14-материализации? Предлагаю: только `permissionMode`
   для claude (через `--permission-mode`); всё остальное `instructed` до M14.
   Подтверждаешь, или знаешь adapter-флаг, который уже сейчас жёстко режет
   tools/mcps?
3. **CONFIG vs EXECUTOR_UNAVAILABLE граница.** Build-не-может-вообще → `CONFIG`;
   enforceable-для-другого-агента-но-не-для-resolved → `EXECUTOR_UNAVAILABLE`.
   Норм, или оба случая хочешь одним кодом (`CONFIG`)?
4. **default `enforcement`.** По умолчанию `instruct` (не `strict`), чтобы старые
   графы M11a не начали падать при launch. Согласен? (`strict`-по-умолчанию
   сломал бы back-compat.)
5. **Снапшот вердиктов в ledger.** Нужен ли `node_attempts.enforcement_snapshot
   jsonb` для аудита (что было enforced/instructed/refused на момент launch),
   или достаточно читать из pinned-манифеста (без миграции 0010)?
6. **Разнос критерия #1.** node-settings-shape → M11c; MCP/tool/skill/agent/
   restriction-refs → M14; roles → M13. M11c НЕ дублирует M14/M13. Согласен,
   чтобы критерии оставались distinct?
7. **`limits` (cost/time).** В M11c — только запись+отображение, без kill-on-cap
   (ADR open question). Норм, или хочешь хотя бы time-limit enforcement уже
   сейчас?
8. **M11a/M11b предшествуют.** M11c строится на M11a `nodes[]`/`node_attempts`/
   graph-runner (в этой ветке ещё НЕ влиты — текущий HEAD = M10). Подтверждаешь,
   что M11a (и M11b?) мёржатся до старта M11c?
