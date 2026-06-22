# /aif-plan request — Plan 1: Output-driven dynamic routing + output-mismatch rework + P7 run-context

> **How to use:** run `/aif-plan` (full mode) in this worktree
> (`feature/flow-routing-runcontext`) with this file as the brief.
> **Workflow mandate:** SDD-first (generate/extend spec + ADR + UI design), then
> strict TDD (RED → GREEN → refactor) per task. This is the continuation of the
> M26 keystone (P1 shipped) — pulling P4 dynamic routing forward and finishing P7.

## Goal (one line)

Turn MAIster's already-shipped structured node output (P1) into **dynamic flow
routing**: a node can route on its own structured output or on a gate/judge
verdict via a declared, verifiable `decide` table; a node whose output fails its
schema can be sent into a **bounded rework loop** instead of hard-failing; and a
session-independent **run-context blackboard** (P7) gives agents the cross-node
state to reason over. Plain (unconditional) routing stays byte-identical.

## Current ground truth (verified in code on `main` @ 7344260f — cite, don't re-discover)

- **P1 structured output is SHIPPED (M26).** A node declares
  `output.result: { schema: ./path, required?: bool }`
  (`web/lib/config.schema.ts:536`). `ai_coding`/`judge` emit a
  ` ```json maister:output ` sentinel block in stdout; `cli`/`check` write
  `MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json`. The seam
  `validateNodeStructuredOutput` (`web/lib/flows/graph/node-output.ts:214`,
  called at `web/lib/flows/graph/runner-graph.ts:2500`) runs post-action /
  pre-gates, validates the payload against the schema, and **folds it into
  `node_attempts.vars`** via the single `markNodeSucceeded`. Downstream reads
  `{{ steps.<nodeId>.vars.<key> }}` through `reduceLedger`
  (`web/lib/flows/context.ts:120`, highest-attempt-wins) under **strict**
  templating (`web/lib/flows/templating.ts`, `CONFIG` on unknown var).
  `compat.engine_min >= 1.3.0`.
- **Routing is STATIC.** Outcome is hardcoded: action nodes → `"success"`,
  `human` → its chosen decision (`web/lib/flows/graph/runner-graph.ts:2868`).
  `transitions: Record<string,string>` (outcome → nodeId | `"done"`,
  `web/lib/config.schema.ts:800`); `resolveTransition` →
  `node.transitions[outcome]` or null (`web/lib/flows/graph/compile.ts`). The
  engine never reads vars/verdict to choose a branch.
- **Output-mismatch currently HARD-FAILS.** A validation failure →
  `markNodeFailed` + `CONFIG` → run Failed (`web/lib/flows/graph/node-output.ts:313`).
- **P7 run.json = DESIGNED only** (`docs/system-analytics/flow-graph.md:211`);
  there is **no writer in code** (the `runContext={{…}}` props in page
  components are unrelated UI props).
- **`route_when` is NOT a routing mechanism** — it is a flow-level natural-language
  hint in `flowMetadataSchema` (`web/lib/config.schema.ts:929`), runner-IGNORED,
  used by all 5 aif flows for flow-selection. **Different concept. Leave it
  untouched. Do not rename or repurpose it.**
- **Rework machinery exists** (`web/lib/flows/graph/runner-graph.ts:3061`):
  `rework.allowedTargets`/`maxLoops`/`commentsVar`, downstream-stale via
  `downstreamOf`, workspace policy (`keep|rewind-to-node-checkpoint|fresh-attempt`),
  session policy (ADR-081). Today it is triggered ONLY by a human decision.
- **Node retry policy exists** (ADR-080, `scheduleAutoRetry` at
  `web/lib/flows/graph/runner-graph.ts:2467`) — re-dispatch a failed node bounded
  by attempts.

## Scope — build these (support BOTH plain and conditional routing; keep it clean in the Studio UI)

### 1. Node-level `decide` table (conditional routing) — opt-in
- **No `decide`** → behavior is byte-identical to today (outcome `success` /
  human decision). This is the back-compat contract.
- **Phase 1 — `from: output`** (rides shipped P1, no predicate grammar): the
  node's `output.result` schema carries an `enum` field (e.g. `outcome`); the
  engine uses `vars.<field>` as the transition key.
  ```yaml
  output: { result: { schema: ./schemas/triage.json, required: true } }
  decide: { from: output.outcome }
  transitions: { bug: fix, feature: plan, invalid: reject }
  ```
- **Phase 2 — `from: verdict`** (gate/judge verdict + confidence) with a closed
  `when` predicate grammar (`field · operator · number`), exactly one `default`.
  Subsumes the existing `confidence_min` (it becomes sugar for a 2-case verdict
  table — keep `confidence_min` working).
  ```yaml
  decide:
    from: verdict
    cases:
      - { outcome: approve, when: "confidence >= 0.8" }
      - { outcome: review,  when: "confidence >= 0.5" }
      - { outcome: rework,  default: true }
  transitions: { approve: promote, review: human-review, rework: implement }
  ```
- **Verifiability (hard requirement):** compile-time — every produced outcome ∈
  `transitions` keys; exactly one `default`; `when` parses to the closed grammar.
  Runtime — chosen outcome ∈ declared set. Engine change site:
  `web/lib/flows/graph/runner-graph.ts:2868`.

### 2. Output-mismatch → controlled rework — opt-in
- New `output.result.on_mismatch: <outcome>`. **Default absent = today's
  `CONFIG`-fail** (nodes that must hard-fail keep doing so).
- On mismatch (schema-invalid OR an emitted `outcome` ∉ the declared set), emit
  `on_mismatch` → `transitions` → a rework target (∈ `rework.allowedTargets`),
  **bounded by `maxLoops`**, with the validation-error text injected into
  `commentsVar` as the rework feedback (so the agent knows what to fix).
- Reuses the existing rework machinery; the NEW part is an **engine-initiated
  rework trigger on a non-human node**. **Evaluate reuse of the ADR-080 node
  retry path** for the self-target case (re-run the same node) + add
  error-feedback injection; use the rework path for route-to-other-node.

### 3. P7 run-context blackboard (promote M26 Designed → Implemented)
- Write `<worktreePath>/.maister/run.json` via `atomicWriteJson`, **git-excluded**
  via the common-dir `info/exclude` (repo-wide), injected as a **pointer** into
  each agent node's prompt so both `claude` and `codex` read it from their cwd.
- Shape v1 = hardcoded `"all"`: `{ intent, nodes: { <id>: { summary, vars } },
  gates: { <id>: { status, verdict } }, promoted }`. Same data model as the vars
  produced by P1 (co-design — do not invent a second shape).

### 4. Flow Studio UI (clean, transparent, editable)
- Edit `decide` on the node: source (`output`/`verdict`) · cases · `default` ·
  `on_mismatch` → target. Plain routing renders as a single labeled edge;
  conditional renders as a small decision table on the node + outcome-labeled
  edges. Wire through `web/components/flows/node-form/node-side-form.tsx` +
  `web/lib/flows/editor/editor-state.ts`. Follow `web/CLAUDE.md`
  data-management + UI-affordance conventions.

## Locked micro-decisions (do not relitigate)
1. Field name = **`decide`** (NOT `route`). `route_when` (flow-level hint) is left untouched.
2. `on_mismatch` is **opt-in**; default = current `CONFIG`-fail.
3. `when` grammar v1 = **one predicate per case + one `default`**. AND/OR compound predicates are future headroom — NOT now.
4. **engine_min bump `1.3.0` → `1.4.0`** — `decide` / `on_mismatch` require it; existing packages keep working at their pinned floor.
5. P7 `run.json` shape v1 = hardcoded `"all"`.

## SDD requirements (do these first, freeze before coding)
- **Extend** the existing frozen spec
  `.ai-factory/specs/feature-m26-structured-output-run-context.md`: flip the P7
  section Designed → Implemented, and add the P4 `decide` + `on_mismatch`
  contract.
- **New ADR** for output-driven dynamic routing + `on_mismatch` + engine `1.4.0`.
  Use the **next free number** — note: `ADR-101` is cost-budget; the sibling
  branch `claude/priceless-goldstine-33d1f1` may also claim `ADR-102`, so
  confirm/renumber at plan time to avoid collision.
- **UI design** for the Studio decide-editor (a `docs/screens/studio/*` update).
- Update docs: `flow-dsl.md`, `flow-graph.md`, `configuration.md`,
  `decisions.md` index, `screens/studio/editor.md`.

## TDD requirements
RED → GREEN → refactor per task. Minimum coverage:
- Compile-time: outcome ⊆ transitions; exactly-one-default; `when` grammar parse.
- Runtime: outcome selection from `output` and from `verdict`; `confidence_min` still works via the verdict path.
- `on_mismatch`: routes to rework target, bounded by `maxLoops`, error text in `commentsVar`; default-absent still `CONFIG`-fails.
- P7: `run.json` written atomically, git-excluded, pointer injected into prompt; both adapters.
- Back-compat: a flow with no `decide` routes byte-identically to today.
- Strict-templating: an absent optional var is handled by the `default` case, never throws mid-route.

## Out of scope (deferred — do not build here)
- USD / "cost-per-accepted" economics — stays token-only (ADR-101 budget).
- Cross-run STATUS / project-memory; morning-report digest (external agent over maister API later).
- AND/OR compound predicates; multi-signal-source `decide`; a dedicated router node type.
- Agent/scratch escalate paths (per ADR-101 — flow-only escalate).

## Follow-up (separate process, not this plan)
Sweep existing flow packages to adopt `decide` / bump their `engine_min` where beneficial.
