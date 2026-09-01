# Feature M26 — Structured Node Output Channel (P1) + Run-Context File (P7)

## Status

Wave 1 (P1) **Implemented**; P7 + Wave-2 routing **Implemented (M38)**; Wave 3
(transport matrix + open JSON grammar + schema identity) **Implemented** — see
"## Wave 3 (2026-09-01)" below. Frozen SSOT.
Plan (Wave 1): `.ai-factory/plans/feature-m26-structured-output-run-context.md`.
Plan (M38): `.ai-factory/plans/feature-flow-routing-runcontext.md`.
ADRs: `docs/decisions.md` ADR-063 (Wave 1), **ADR-103 (M38: `decide` routing + `on_mismatch` +
engine 1.7.0 + P7)**, **ADR-162 (Wave 3: transport matrix + open JSON grammar + schema identity +
engine 3.6.0)**.
Plan (Wave 3): `.ai-factory/plans/claude-maister-structured-result-40b293.md`.
Re-frozen 2026-06-07 after the Phase-0 adversarial gate (resolves A1 compose, B1 stdout cap, B2
vacuous deferred, B3 read-scope, B4 gate status, B5 nested-grammar, cli-attempt threading).
Extended 2026-06-22 (M38) with the **P4 `decide` table**, **`on_mismatch` rework**, **engine
`1.6.0 → 1.7.0`**, and the **P7 run-context file** (Designed → built this milestone).
Extended 2026-09-01 (Wave 3, **ADR-162**) with the **per-node-type transport matrix**
(`orchestrator` sentinel · `consensus` engine vars · `human`/`form` refused), the **open JSON schema
grammar** (`json` type, typed array `items`, formalized openness, structural limits, unsafe-key
rejection), **per-attempt schema identity** (`node_attempts.output_contract`, migration `0127`), and
**engine `3.5.0 → 3.6.0`** — see "## Wave 3 (2026-09-01)" below.

## Value

Today only `human`/HITL nodes write a structured result into `node_attempts.vars`; `ai_coding`, `cli`,
`check`, and `judge` nodes emit only free `stdout` text and files-on-disk (`node_attempts.vars` is
always `{}` for them). The flow engine therefore cannot pass a node's *structured* result to a later
node, route on a node's self-reported outcome, or feed first-class node signals to the Observatory.

M26 delivers the **keystone pair** of `docs/pv/improvement-roadmap.md`:

- **P1 — structured node output channel:** every graph node may emit a **schema-validated** structured
  result into the existing `node_attempts.vars`, declared opt-in per node.
- **P7 — run-context file:** a session-independent JSON blackboard the agent reads from its own
  worktree, projecting run-level state (intent + node vars + gate verdicts) so a brand-new/cleared/
  resumed session can reconstruct the run.

Together they complete the Wave-1 exit goal "every run emits structured signal" and unblock Wave-2
(P2 prompt injection, P4 dynamic routing, P3 diff-path assertions) and richer E2 Observatory signals —
with **no DB migration and no new dependency**.

## Non-goals

- No legacy linear `steps[]` support — graph engine (`web/lib/flows/graph/runner-graph.ts` /
  `node_attempts`) only.
- No P2 (prompt content injection), P6 (session continuity), or P3 (diff-path assertions /
  `hash`·`size_bytes`). **P4 (`decide` table) is delivered in M38 — see "## Wave 2 (M38)".**
- No config-driven P7 projection selector — M26 hardcodes "all" (intent + every node's vars + every
  gate result).
- No new JSON-Schema dependency (`ajv`) — extend the existing `formSchemaSchema` grammar.
- No DB migration, no new HTTP route, no new `runs.status`/enum, no new `MaisterError` code.
- No `compose.yml` change — `web` runs on the host (ADR-023); env vars it reads are wired in
  `.env.example` + `docs/configuration.md` only, never a compose service block.
- No change to the M17 `extraVars` rework-comment channel (P1/P7 converge on it, never duplicate it).
- Not in scope and not this milestone: the in-flight M22/ADR-064 `flow_graph_layouts` drop.

## Transport & validation model (P1)

**Opt-in.** P1 activates for a node only when its manifest declares `output.result`. A node without it
behaves exactly as today (`vars: {}`); behavior is byte-identical.

**Declaration.** `output.result = { schema: <"./path">, required?: boolean }` attaches to the existing
node `output:` block (sibling of M12 `produces[]`). `schema` is a **path** (not inline), resolved
against the flow install dir with the same escape-guard as `form_schema` (`runner-human.ts:65-72`), and
the resolved file is validated as a `formSchemaSchema` document. `required` defaults to `false`.

**Grammar (extended this milestone).** `formSchemaSchema` (`config.schema.ts:703`) is **flat today**
(`type ∈ {string, number, boolean, enum, array}`). M26 **adds an `object` type with nested `fields`**
to that grammar (and keeps it the single grammar — HITL forms keep delegating to it). This is net-new
work, not reuse-as-is; nested validation is RED-test territory in Phase 1.

**Transport is by execution mechanism:**

| Node action runs via | Node types | Transport |
| --- | --- | --- |
| `runAgentStep` | `ai_coding`, `judge` | Agent ends its response with a single sentinel-tagged fenced block ` ```json maister:output … ``` `; the runner extracts the **last** such block from `result.stdout` (the 1 MiB-capped capture snapshot — `STDOUT_CAP_BYTES`, `runner-agent.ts:385`). **No file write by the agent.** A block pushed past the 1 MiB stdout cap is treated as **absent**. |
| `runCliStep` | `cli`, `check` | Runner injects `MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json` into the command env; the command writes its JSON there; the runner reads that file. The per-attempt filename prevents a non-writing rework attempt from inheriting a prior attempt's file. `attempt` MUST be threaded into `RunCliStepCtx` (it is not present today). |

`human` nodes are unchanged (their `vars` come from the HITL input artifact). The cli output file lives
under `<runDir>` (not the worktree) because the **runner**, not the agent, reads it.

**Validation pipeline** (insert at `web/lib/flows/graph/runner-graph.ts` ~1124-1138 — *after* `if (!result.ok)` returns and
`result.vars` is still mutable, *before* `if (node.gates.length > 0)` and `markNodeSucceeded`; only when
the node declares `output.result` and the manifest's `compat.engine_min >= 1.3.0`):

1. Acquire the raw payload (last `maister:output` block from the capped `result.stdout` for agent nodes;
   file contents for cli nodes; **absent** if no block / no file).
2. Enforce `MAISTER_NODE_OUTPUT_MAX_BYTES` (default 256 KiB) on the raw payload bytes.
3. `JSON.parse` defensively.
4. `validateStructuredOutput(parsed, resolvedSchema)` against the extended `formSchemaSchema`
   (string/number/boolean/enum/array/**object-with-fields**).
5. On success, fold the validated object into `result.vars`, persisted by the **existing single**
   `markNodeSucceeded(..., { vars })` UPDATE (`ledger.ts:127`) — no new write, no new crash window.
6. On any failure — payload absent while `required: true`, oversize, invalid JSON, or schema mismatch —
   `markNodeFailed` with `MaisterError("CONFIG")` (`errorCode: "CONFIG"`).

Payload absent while `required: false` → `vars` stays `{}`, node proceeds. **No ACP-deferred handling is
involved**: this seam runs only after the agent turn reached `end_turn` (`result.ok`), at which point
`sendPrompt` has already drained every permission deferred — `markNodeFailed` here leaks nothing.

**Forward handoff** reuses `reduceLedger` unchanged: once a node's `vars` are populated, a later node's
prompt resolves `{{steps.<nodeId>.vars.<key>}}` with no new plumbing.

## Run-context file model (P7)

**Location (in the worktree, agent-readable).** `<worktreePath>/.maister/run.json`, written by the
runner via `atomicWriteJson`. It lives **inside the agent's worktree cwd** so both `claude` and `codex`
can read it from their own working directory with no out-of-cwd-read assumption and no dependence on
`.claude` settings (codex ignores those). To keep the user's repository clean regardless of its
`.gitignore`, the runner ensures `.maister/` is excluded for the repo by idempotently appending
`.maister/` to the repo's git exclude file (resolved via `git rev-parse --git-path info/exclude`). That
file lives in the **shared common git dir**, so the exclude is **repo-wide** (it covers every worktree
and the main checkout) and persists after worktree removal — benign here because `.maister/` is
MAIster's runtime dir and is never committed. As a result `run.json` never appears in `git status` or
the base→run diff. Run **logs** (`<stepId>.log`,
`run.events.jsonl`, `cost.jsonl`) stay at `<runDir>` (operator-facing); only `run.json` (agent-facing)
lives in the worktree.

**Shape** (M26 hardcoded "all"):

```json
{
  "intent": "<task.prompt>",
  "nodes": { "<nodeId>": { "summary": "<truncated node stdout>", "vars": { } } },
  "gates": { "<gateId>": { "status": "passed", "verdict": { } } },
  "promoted": { }
}
```

- `intent` = `task.prompt`.
- `nodes.<id>.summary` = the node's truncated stdout (the existing `reduceLedger` `output` field;
  truncated by `reduceLedger`'s cap, not `MAISTER_NODE_OUTPUT_MAX_BYTES`). Named "summary" for the agent;
  it is raw truncated output, not a generated summary.
- `nodes.<id>.vars` = the node's structured vars (P1; `{}` for nodes that declared none).
- `gates.<id>` = `{ status, verdict? }` — **`status` is always present** (the source of truth for
  `command_check`/`human_review`, whose `gate_results.verdict` is null); `verdict` is included when
  non-null. Latest result per gate.
- `promoted` = a flat convenience union of every node's `vars`. The tiebreak on a key collision is
  **last-wins by `reduceLedger` node-iteration order** — the insertion order of the per-node
  highest-attempt rows `reduceLedger` already returns (NOT execution/topo order, which `reduceLedger`
  does not carry). That order is stable for a given ledger, so regenerating `promoted` from the same
  ledger yields byte-identical content. Reserved to become selective when the P7 selector lands (later
  wave).

**Derivation & lifecycle.** `run.json` is a **pure projection** of `node_attempts` + `gate_results` +
`task.prompt`, rebuilt by `buildRunContext(...)` and rewritten (a) once at run start (intent only) and
(b) after **any `node_attempts` terminal transition** — `markNodeSucceeded`, `markNodeFailed`,
`markNodeReworked`. Because it is derived, it is **idempotent and self-healing**: a missing/stale
`run.json` is regenerated on the next transition; **correctness never depends on it** — a fresh,
cleared, or resumed session reconstructs identical state from the ledger + worktree.

**Access.** The runner appends a one-line pointer `[Run context: <abs run.json path>]` to each agent
node's resolved prompt (after `renderStrict`, before dispatch; graph agent nodes dispatch
`new-session`); the agent reads the file from its own worktree on demand.

**Secret-safety.** `run.json` is built only from `vars` + gate results + `task.prompt` — **never** from
`context.env`. No env secret can enter the file.

## Engine gate

`MAISTER_ENGINE_VERSION` bumps `1.2.0 → 1.3.0`. A manifest declaring `output.result` on any node MUST
declare `compat.engine_min >= 1.3.0`; otherwise `validateGraphManifest` (`config.ts:634-662`) rejects it
with `MaisterError("CONFIG")` (mirrors the existing `ARTIFACT_ENGINE_MIN = "1.2.0"` gate, `config.ts:606`).
Flows that do not declare `output.result` stay valid at any `engine_min` (back-compat). `aif` declares no
`engine_max`, so the bump is safe.

## Configuration / deployment

`MAISTER_NODE_OUTPUT_MAX_BYTES` (default `262144` = 256 KiB) caps the raw structured-output payload
before parse. It is read by a new `instance-config.ts` helper mirroring `workbenchMaxFileBytes()`, and
wired into `.env.example` + the `docs/configuration.md` env table **only** — **not** `compose.yml`
(`web` runs on the host per ADR-023; this matches the `MAISTER_WORKBENCH_MAX_FILE_BYTES` precedent).

## Expectations

- A node declaring `output.result` MUST have its structured output validated against the resolved
  (extended `formSchemaSchema`) document BEFORE the attempt reaches `Succeeded`.
- A node NOT declaring `output.result` MUST behave exactly as today (`vars: {}`, no transport
  provisioning, no parsing).
- Agent-executed nodes (`ai_coding`/`judge`) MUST emit output via the last ` ```json maister:output `
  fenced block in `result.stdout`; cli-executed nodes (`cli`/`check`) MUST emit via `MAISTER_OUTPUT_FILE`.
- A `maister:output` block pushed past the 1 MiB `result.stdout` capture cap MUST be treated as absent.
- The cli output file MUST be per-attempt (`output-<nodeId>-<attempt>.json`); attempt N MUST NOT read
  attempt N-1's file.
- Validation failure (absent-while-required, oversize past `MAISTER_NODE_OUTPUT_MAX_BYTES`, invalid
  JSON, schema mismatch) MUST fail the attempt with `MaisterError("CONFIG")` and MUST NOT promote.
- Validated `vars` MUST persist through the existing single `markNodeSucceeded` UPDATE — no new DB
  write, no migration, no new crash window.
- A downstream node MUST resolve `{{steps.<id>.vars.<key>}}` from an upstream node's validated output
  via `reduceLedger` (highest-attempt-wins), with no new templating plumbing.
- `run.json` MUST live at `<worktreePath>/.maister/run.json`; the runner MUST append `.maister/` to the
  repo's git exclude (`$(git rev-parse --git-path info/exclude)`, repo-wide and benign) so `run.json`
  never appears in `git status` / the base→run diff, and it MUST be readable by the agent from its own
  cwd (claude and codex).
- `run.json` MUST contain `{intent, nodes(summary+vars), gates(status+verdict?), promoted}`, be a derived
  projection regenerated from the ledger; a fresh/cleared/resumed session MUST reconstruct identical
  content with no dependency on prior in-process state.
- `run.json` MUST NOT contain any value sourced from `context.env`.
- Each agent node's prompt MUST carry the `[Run context: <abs path>]` pointer on its `new-session` dispatch.
- A manifest declaring `output.result` without `compat.engine_min >= 1.3.0` MUST be rejected
  (`CONFIG`); a manifest without `output.result` MUST stay valid at any `engine_min`.
- `MAISTER_NODE_OUTPUT_MAX_BYTES` MUST default to 256 KiB and MUST be wired into `.env.example` +
  `docs/configuration.md` (NOT `compose.yml`).
- M26 MUST add no DB migration, no HTTP route, no `runs.status`/enum value, and no new `MaisterError`
  code.

## Acceptance criteria

- AC1 — A graph `ai_coding`/`judge` node declaring `output.result` whose response ends in a valid
  ` ```json maister:output ` block has the block's object in `node_attempts.vars` after `Succeeded`.
- AC2 — A graph `cli`/`check` node declaring `output.result` that writes `$MAISTER_OUTPUT_FILE` has
  that JSON in `node_attempts.vars` after `Succeeded`.
- AC3 — A downstream node's prompt renders `{{steps.<upstream>.vars.<key>}}` from AC1/AC2 output.
- AC4 — Schema mismatch, invalid JSON, oversize, absent-while-required, and a block lost past the 1 MiB
  cap each fail the attempt with `errorCode = "CONFIG"` and leave the run unpromotable.
- AC5 — A node with no `output.result` produces a byte-identical run to pre-M26 (regression).
- AC6 — Rework: attempt 2 of a node that does not re-emit output does NOT inherit attempt 1's
  `output-<nodeId>-1.json` (per-attempt isolation).
- AC7 — `run.json` exists with `intent`, per-node `summary`+`vars`, gate `{status, verdict?}` (incl. a
  `command_check` gate represented by `status` with null verdict), and a flat `promoted` union whose
  key-collision tiebreak is last-wins by `reduceLedger` node-iteration order; regenerating from the same
  ledger yields byte-identical content (including identical `promoted` collision winners).
- AC8 — `run.json` contains no value present in the run's `context.env` (secret-safety).
- AC9 — `run.json` lives at `<worktree>/.maister/run.json`; `.maister/` is appended to the repo's git
  exclude (`$(git rev-parse --git-path info/exclude)`, repo-wide) so `run.json` is absent from
  `git status` and the base→run diff, and it is readable from the agent's cwd.
- AC10 — Every agent node's dispatched prompt contains `[Run context: <abs run.json path>]` on its
  `new-session` dispatch (the only mode graph agent nodes use).
- AC11 — A flow declaring `output.result` without `compat.engine_min >= 1.3.0` is rejected (`CONFIG`);
  a flow without `output.result` validates at `engine_min: 1.2.0`.
- AC12 — `MAISTER_NODE_OUTPUT_MAX_BYTES` unset → 256 KiB default applied; set → override honored;
  present in `.env.example` + `docs/configuration.md` (and NOT added to `compose.yml`).
- AC13 — `git grep` confirms no new migration file, route, `runs.status` value, or `MaisterError` code
  was added for M26.

## Contract trace

- DSL: `docs/flow-dsl.md` (`output.result { schema, required }`; agent fenced-block + cli
  `MAISTER_OUTPUT_FILE` contracts; `compat.engine_min: 1.3.0`).
- Domain: `docs/system-analytics/flow-graph.md` (post-action validate seam + Run-context subsection +
  Expectations + Edge cases).
- Schema/runtime: `web/lib/config.schema.ts` (`nodeOutputSchema.result`, `formSchemaSchema` object
  type), `web/lib/flows/engine-version.ts`, `web/lib/config.ts` (`OUTPUT_ENGINE_MIN`),
  `web/lib/instance-config.ts` (`nodeOutputMaxBytes()`), `web/lib/flows/runner-cli.ts`
  (`RunCliStepCtx.attempt`).
- Config: `docs/configuration.md`, `.env.example` (`MAISTER_NODE_OUTPUT_MAX_BYTES`). NOT `compose.yml`.
- ADR: `docs/decisions.md` ADR-063.
- DB: none (reuses `node_attempts.vars`; explicitly no migration).

## Spec-to-test matrix

| AC | Test (named, created by QA-RED in the cited phase) |
| --- | --- |
| AC1 | `runner-graph` integration: agent node fenced-block → `node_attempts.vars` (Phase 2) |
| AC2 | `runner-graph` integration: cli node `MAISTER_OUTPUT_FILE` → `node_attempts.vars` (Phase 2) |
| AC3 | forward-handoff integration: `{{steps.A.vars.k}}` resolves in node B (Phase 2) |
| AC4 | `runner-graph` unit/integration: mismatch/bad-JSON/oversize/absent-required/over-1MiB → `CONFIG` (Phase 2) |
| AC5 | regression: no-`output.result` flow byte-identical (Phase 2) |
| AC6 | rework integration: per-attempt cli file isolation (Phase 2) |
| AC7 | `run-context` unit: projection shape incl. gate `status` (command_check null verdict) + idempotent regen (Phase 3) |
| AC8 | `run-context` unit: no `context.env` value in `run.json` (Phase 3) |
| AC9 | `run-context` integration: worktree location + `.maister/` git-excluded (clean `git status`) (Phase 3) |
| AC10 | `runner-agent` unit: pointer present on `new-session` dispatch (Phase 3) |
| AC11 | `config`/`engine-version` unit: engine gate accept/reject (Phase 1) |
| AC12 | config + grep: env default/override + `.env.example`/`configuration.md` wiring, no compose (Phase 2) |
| AC13 | repo-level assertion in `/aif-verify`: no migration/route/status/error-code (Phase 5) |

Plus Phase-4 Playwright e2e: happy (AC1+AC3+AC7) and negative (AC4 surfaced in run detail, no promote).

## Open dependencies / assumptions (verified against source)

- `validateStructuredOutput` generalizes `validateHitlResponse` and the `formSchemaSchema` grammar is
  **extended** with a nested `object` type (Phase 1, Task 4); HITL forms keep delegating to it.
- The 1 MiB-capped `result.stdout` snapshot is the only stdout available; the `maister:output` block is
  expected to be small and near the end. A block lost to the cap is an absent block (Edge case).
- The post-action seam (`web/lib/flows/graph/runner-graph.ts` ~1124-1138) has `result.ok === true` and `result.vars`
  mutable before `markNodeSucceeded`; no ACP deferred is open there (the turn reached `end_turn`).
- Gate `status` is read from `gate_results.status` (always set); `verdict` from `gate_results.verdict`
  (nullable) for the `gates` projection.
- `attempt` is threaded into `RunCliStepCtx` (new field) for the per-attempt cli output filename.

## Wave 2 (M38) — output/verdict-driven routing (`decide`) + malformed-output rework (`on_mismatch`)

ADR-103. Engine `1.6.0 → 1.7.0`. **No migration, no new `MaisterError` code** (every refusal reuses
`CONFIG`), no new HTTP route / SSE event / `runs.status` value / env var / compose change. Reuses
`node_attempts.vars` (P1), the transition machinery (`resolveTransition`), and the rework machinery
(`markNodeReworked` → `markDownstreamStale` → `pendingInjectedVars`).

### P4 — the `decide` routing table

**Opt-in, node-level.** A node may declare a `decide` block. When absent, routing is byte-identical to
M26/today (action node → `"success"`; `human` → `result.decision`). When present, `decide` **replaces**
the hardcoded `"success"` at the single outcome site (`runner-graph.ts`, the `const outcome = …` site).

**Frozen schema (`decideSchema`, node-level — added to `nodeCommon`):**

```yaml
decide:
  from: verdict | output.<dot.path>     # required
  cases:                                # for from: verdict — ordered, optional
    - when: "<field> <op> <number>"     # exactly one predicate per case
      target: <outcome>                 # an outcome string ∈ this node's transitions keys
    - default: true                     # EXACTLY ONE default case required when `cases` present
      target: <outcome>
```

- `from` matches `verdict` **or** the regex `^output\.<dotpath>$` where
  `dotpath = seg('.'seg)*`, `seg = [A-Za-z_][A-Za-z0-9_]*`. Any other `from` value is a compile/load
  `CONFIG`.
- `cases` is meaningful for `from: verdict` only. Each case is **either** `{ when, target }`
  **or** `{ default: true, target }`. The block MUST contain **exactly one** `default` case.
- The `decide` object is `.strict()` (unknown keys rejected).

**D1 — applicability.** `from: output.<path>` works on any node declaring `output.result`
(`ai_coding | cli | check | judge`). `from: verdict` works on any node with a verdict-producing gate
(`ai_judgment | skill_check`). NOT judge-only. `<path>` is a **nested dot-path** into the validated
structured-output object (M26's `object`-with-`fields` grammar), e.g. `output.triage.outcome`.

**D2 — outcome computation.**
- `from: output.<path>`: `outcome = String(getPath(vars, <dotpath>))`, where `getPath` is the shared
  safe nested getter (missing → `undefined`, never throws). A missing/`undefined` value yields no
  transition (terminal/Review), surfaced by the runtime allow-list guard.
- `from: verdict`: evaluate `cases` in order against the verdict object via the `when` grammar; first
  match wins, else the `default` case. The verdict object exposes `verdict` (string), `confidence`
  (number, optional), and nested fields via `getPath`.

**D3 — `from: verdict` makes the verdict gate routing-input (engine-owned).** Today a blocking verdict
gate `markNodeFailed`s + `break`s *before* the outcome site (`runner-graph.ts`, the
`if (!gateOutcome.ok)` branch), so the verdict never reaches routing. When `node.decide.from ===
"verdict"`, **the engine** treats the verdict-producing gate as routing-input: its parsed verdict
is surfaced out of `runNodeGates` (`GateRunResult.verdict`) instead of hard-failing the node, and
the node always reaches the outcome site with the verdict. A parseable verdict gate under routing is
recorded **`passed`** (the verdict value retained in `gate_results.verdict` for routing + audit), so it
never hard-fails the node finish AND never blocks review-readiness — the decide table owns
approve/review/rework, and `confidence_min` calibration is bypassed (the `when` predicates threshold).
**No author-declared `mode: advisory` is
required.** `confidence_min` **without** `decide` keeps today's blocking behavior; it is also
expressible as a 2-case `decide:{from:verdict}` (sugar). This is the highest-risk seam.

### `when` grammar v1 (frozen)

`web/lib/flows/graph/when-grammar.ts` — a pure module, no I/O:

- `parseWhen(s) → Predicate | { error }`: `s = "<field> <op> <number>"`, ops `>= > <= < == !=`,
  whitespace-tolerant. `<field>` is a nested dot-path resolved by `getPath`. Malformed → typed error.
- `evalWhen(pred, ctx) → boolean`: resolves `getPath(ctx, pred.field)`; a missing/non-numeric lhs →
  **no-match** (`false`), never throws.
- `getPath(obj, dotpath) → unknown`: shared safe getter (also used by D2's `from: output.<path>`).
- AND/OR compound predicates are explicit future headroom, NOT v1.

### `on_mismatch` — engine-initiated rework on structured-output validation failure

**Opt-in on `output.result`.** The strict `output.result` sub-object gains
`on_mismatch?: "retry" | <outcome>`. When **absent** (default), a structured-output validation failure
(`!structuredOutput.ok`) hard-fails the attempt with `CONFIG` exactly as M26 today. When **present**, the
failure instead drives the **existing rework path from a non-`human` node**, bounded by
`rework.maxLoops`, with the validation-error text (`structuredOutput.reason`) injected via `commentsVar`:

- **`on_mismatch: retry`** (reserved literal) — self-target re-run of the **same node** with the error
  fed back. Requires a `rework` block (for `maxLoops`/`commentsVar`/workspace/session policy) but does
  NOT require the node's own id in `transitions`/`rework.allowedTargets`. `retry` is special **only**
  inside `on_mismatch` (no collision with transition keys).
- **`on_mismatch: <outcome>`** — a transition outcome routed via `transitions[outcome]` to another node,
  which MUST be ∈ `rework.allowedTargets`. Requires a `rework` block.

**D5 — ADR-080 retry rejected.** `CONFIG ∉ RETRYABLE_ERROR_CODES` and `scheduleAutoRetry` injects no
error feedback; the rework machinery is the only fit. No `scheduleAutoRetry` change.

### Verifiability (compile + runtime)

- **Compile/load (`compile.ts`, `CONFIG` on violation):** for `from: verdict`, every `case.target` ⊆
  `node.transitions` keys, exactly one `default`, each `when` parses; for `from: output.<path>`, only the
  `from` dot-path **syntax** is checked (the value set is data-dependent → enforced at runtime); for
  `on_mismatch: retry`, a `rework` block is required (NOT the node's own id in `allowedTargets`); for
  `on_mismatch: <outcome>`, `transitions[outcome]` ∈ `rework.allowedTargets` AND `rework` declared.
- **Runtime allow-list guard (`runner-graph.ts`, `CONFIG`):** after `decide` picks an outcome, assert it
  ∈ `node.transitions` keys (defense in depth beyond compile-time), else `CONFIG`. An allow-list, not a
  deny-list.

### Engine gate (Wave 2)

`MAISTER_ENGINE_VERSION` bumps `1.6.0 → 1.7.0`. A manifest declaring `decide` **or**
`output.result.on_mismatch` on any node MUST declare `compat.engine_min >= 1.7.0`; otherwise
`validateGraphManifest` rejects it (`CONFIG`), mirroring the `OUTPUT_ENGINE_MIN = "1.3.0"` gate. Manifests
declaring neither stay valid at their pinned floor.

### Crash-window parity (Wave 2)

`on_mismatch` rework reuses the **existing** human-rework write sequence (`markNodeReworked` →
`markDownstreamStale` → `pendingInjectedVars`), which is not a single transaction today and is the
established contract. This milestone does NOT refactor it into a transaction (surgical — untouched code,
separate concern). It introduces **no new partial state** beyond human-triggered rework: same writes,
same order, run stays `Running`, identical recovery profile. A crash between `markNodeReworked` and
`markDownstreamStale` leaves the same recoverable state as a human rework.

### Wave-2 Expectations

- A node with no `decide` MUST route byte-identically to M26 (action → `"success"`, `human` →
  `result.decision`).
- `decide.from: output.<path>` MUST route on `String(getPath(vars, <dotpath>))`; a missing path MUST
  yield no transition (terminal/Review), never a thrown getter.
- `decide.from: verdict` MUST evaluate `cases` first-match-else-`default`, and the engine MUST surface
  the verdict (not hard-fail) for a verdict-producing gate on such a node, with NO author `mode:
  advisory`.
- A `confidence_min`-only node (no `decide`) MUST keep today's blocking verdict-gate behavior.
- A `decide`-chosen outcome ∉ `node.transitions` keys MUST be refused at runtime with `CONFIG`
  (allow-list guard); a producible `decide` outcome with no transition MUST fail to compile.
- `on_mismatch: retry` MUST re-run the same node (self-target) with `structuredOutput.reason` in
  `commentsVar`, bounded by `rework.maxLoops`, with NO own-id in `transitions`/`allowedTargets` required.
- `on_mismatch: <outcome>` MUST route to `transitions[outcome]` (∈ `rework.allowedTargets`), bounded by
  `rework.maxLoops`.
- A node WITHOUT `on_mismatch` MUST still `CONFIG`-fail on structured-output validation failure
  (M26 regression).
- `on_mismatch` `maxLoops` exhaustion MUST halt the run with `CONFIG` via the loop-top `rework.maxLoops`
  backstop (initial visit + `maxLoops` reworks = `maxLoops + 1` attempts, then `CONFIG`). It **fails
  closed** — the escalate/ship execution-policy arms are deliberately NOT applied to malformed-output
  exhaustion, because shipping invalid structured output is unsafe.
- A manifest declaring `decide` or `on_mismatch` without `compat.engine_min >= 1.7.0` MUST be rejected
  (`CONFIG`); a manifest declaring neither MUST stay valid at its pinned floor.
- M38 MUST add no migration, no HTTP route, no `runs.status`/enum value, no new `MaisterError` code, no
  new env var, no `compose.yml` change; `MAISTER_ENGINE_VERSION === "1.7.0"`.

### Wave-2 Acceptance criteria

- AC14 — A node with `decide:{from:output.outcome}` whose validated output is `{outcome:"x"}` routes via
  `transitions.x`; a nested `decide:{from:output.a.b}` routes on the nested value.
- AC15 — A node with `decide:{from:verdict, cases:[{when:"confidence >= 0.8", target:approve},
  {default:true, target:review}]}` routes by the raw parsed verdict (calibration bypassed); the verdict gate does NOT hard-fail.
- AC16 — A `confidence_min`-as-`decide` 2-case sugar selects the same branch a legacy `confidence_min`
  would.
- AC17 — A `decide` outcome ∉ transitions keys → runtime `CONFIG`; a compile-time producible outcome ∉
  transitions keys (verdict cases) → load `CONFIG`.
- AC18 — `on_mismatch: retry` on a malformed-output node re-runs the same node with the validation error
  in `commentsVar`, bounded by `maxLoops`; an always-malformed node halts at `maxLoops + 1` attempts with
  a `Failed` run (`CONFIG`).
- AC19 — `on_mismatch: <outcome>` routes to the redirect target (∈ `allowedTargets`); a node without
  `on_mismatch` still `CONFIG`-fails (regression).
- AC20 — A flow declaring `decide`/`on_mismatch` without `compat.engine_min >= 1.7.0` is rejected
  (`CONFIG`); a flow without them validates at its old floor.
- AC21 — A crash between `markNodeReworked` and `markDownstreamStale` on an `on_mismatch` rework leaves
  the same recoverable state as a human rework.
- AC22 — `git grep` confirms no new migration/route/`runs.status`/`MaisterError` code/env-key/compose
  service for M38; `MAISTER_ENGINE_VERSION === "1.7.0"`.

## Known limitations (Phase 1)

- ~~**`array` element shape is unconstrained.**~~ **Resolved in Wave 3** — the grammar gains an optional
  recursive nameless `items`; arrays declared without it stay untyped by design (see C-5/C-6 below).
- ~~**`output.result.schema` paths are NOT validated at manifest load.**~~ **Stale — corrected 2026-09-01.**
  Package install DOES resolve and validate every referenced schema document:
  `validatePackageRootSchemaReferences` (`web/lib/flows.ts`) walks
  `collectReferencedSchemaPaths(manifest)` — which collects `output.result.schema` — and calls
  `readAndValidateFormSchemaDoc` on each, refusing the install (`FLOW_INSTALL`) on an escaping path, a
  missing file, bad JSON, or a bad `formSchemaSchema` shape. The Studio lifecycle validation performs the
  equivalent check and reports `form_schema_invalid`. What remains runtime-only is re-resolution at the
  post-action seam, which is by design (the pinned revision's bytes are the runtime source of truth).


## Wave 3 (2026-09-01) — universal transport matrix, open JSON grammar, per-attempt schema identity

**Status: Implemented** (reconciled as-built 2026-09-01; the only delta from the
Phase-0 contract is C-9's `NULL` rule, tightened below and recorded as an
ADR-162 amendment).

ADR-162. Engine `3.5.0 → 3.6.0`. **One additive nullable column** (migration `0127`,
`node_attempts.output_contract`), no new HTTP route / SSE event / `runs.status` value /
`MaisterError` code / env var / compose change. The seam position, the `required` semantics, the
`on_mismatch` rework machinery, and the `decide` routing contract are unchanged.

Each clause below is numbered `C-n` and mirrored by an acceptance criterion in
"### Wave-3 Acceptance criteria".

### C-1 — Transport matrix (single SSOT, keyed by node type)

`NODE_OUTPUT_TRANSPORT` (`web/lib/flows/graph/node-output.ts`) is the ONE map from node type to
transport. The seam, the load-time refusals, and the shipped authoring grammar all derive from it.
Transport is chosen by the node's **execution mechanism** and is never author-declared.

| Node type | Transport | Semantics |
| --- | --- | --- |
| `ai_coding`, `judge`, `orchestrator` | `sentinel` | Last properly-fenced ` ```json maister:output ` block in the 1 MiB-capped (`STDOUT_CAP_BYTES`) stdout of the **completing** turn. |
| `cli`, `check` | `file` | Per-attempt `MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json`. Unchanged from Wave 1. |
| `consensus` | `engine_vars` | The engine-produced `result.vars` object is validated directly. |
| `human`, `form` | *(none)* | Declaring `output.result` is refused at load. Their `vars` come from the HITL input artifact. |

The map MUST cover all eight node types (TypeScript exhaustiveness + a runtime pin test). The
`ai_coding`/`judge`/`cli`/`check` arms MUST behave byte-identically to Wave 1.

### C-2 — `engine_vars` semantics (`consensus`)

The `engine_vars` arm validates `result.vars` **and mutates nothing**: no merge back into `vars`, no
key rewrite. The engine produced those keys; a validated copy folded over them would be either a
no-op or a silent overwrite of engine state. Absent ⇔ the object has zero own keys (defensive — the
completing consensus path always carries `vars.consensus`). The byte cap applies to the serialized
value. Failure semantics are identical to the other arms (`CONFIG`, `on_mismatch`-eligible).

### C-3 — Orchestrator completing-turn rule

An orchestrator turn that parks (pending children, `result.needsInput`) breaks out of the traversal
**before** the seam and MUST NOT be validated. Only the turn that completes without pending children
reaches the seam, and only that turn's stdout is scanned for the sentinel block. A `required: true`
orchestrator therefore never fails a parked turn.

### C-4 — `json` field type and its presence rule

`type: "json"` accepts **any** JSON value: scalar, `null`, array, or object. For `json` — and for
`json` only — an explicit JSON `null` is a **present** value; absence means the key is missing (or
`undefined`). Every other type keeps the Wave-1 rule (`null` counts as absent) byte-identically.

### C-5 — `items` shape

`array` gains an optional **nameless recursive** `items: { type, options?, fields?, items? }`. With
`items` present each element is validated and a violating element fails naming `field[i]`. Without
`items` the array is untyped and accepts mixed/empty content — the Wave-1 behavior, preserved.

### C-6 — Open by default, undeclared fields preserved

The validator iterates **schema fields**, never payload keys. Undeclared keys — at the top level and
at any nesting depth, inside declared `object` fields included — pass validation and MUST survive
into `node_attempts.vars` unmodified. The validator MUST NOT strip, rewrite, or clone-normalize the
value. There is no `additionalProperties` knob: the default is already open and closing it would
break every existing payload carrying extra keys.

### C-7 — Structural limits

One recursive pre-pass walk enforces, before any field check:

| Limit | Value | Failure |
| --- | --- | --- |
| Nesting depth | ≤ 64 | error naming the limit and the JSON path |
| Total object keys (whole payload) | ≤ 10 000 | error naming the limit |
| Array length (any single array) | ≤ 10 000 | error naming the limit and the JSON path |

They are exported constants, **not** env-tunable: they are safety bounds on an LLM-authored payload,
not a capacity dial. Per-string length needs no own limit — `MAISTER_NODE_OUTPUT_MAX_BYTES` (default
256 KiB, enforced pre-parse on the raw bytes) already bounds the total payload and therefore every
string inside it.

### C-8 — Unsafe keys, and the three-consumer blast radius

An own key `__proto__`, `constructor`, or `prototype` at **any** depth is rejected with an error
naming the JSON path, in the same pre-pass and therefore **before** any field check.

`validateStructuredOutput` has exactly three consumers: the node-output seam, HITL form/human
response validation (`web/lib/flows/hitl-validate.ts`), and Brain lesson distillation
(`web/lib/brain/distill.ts` `LESSON_SCHEMA`). C-7 and C-8 apply to all three. That is intended — all
three validate LLM-origin payloads reaching the same flow-visible plane — and is verified by
regression sweep, not assumed.

### C-9 — Audit contract shape and write points

`node_attempts.output_contract` (nullable `jsonb`):

```json
{
  "schemaRef":     "./schemas/review.json",
  "schemaVersion": 1,
  "sha256":        "<64 hex chars of the raw schema file bytes>",
  "transport":     "sentinel | file | engine_vars",
  "engineVersion": "3.6.0"
}
```

Written on the **same ledger UPDATE that closes the attempt**, on both the success path
(`markNodeSucceeded`) and the seam-failure path (`markNodeFailed`). `markNodeReworked` MUST NOT
clear it. Identity is captured once, at schema resolution, by hashing the raw file bytes; the shared
form-schema readers keep their signatures and behavior.

`NULL` means "pre-feature row, the node declared no `output.result`, or the seam failed BEFORE the
schema was read" — never "unknown contract". The seam resolves the schema only on paths that need it,
so a pre-resolution failure (absent while `required`, malformed JSON, over the byte cap, unresolvable
path) records no contract. Resolving eagerly on every declaring attempt is rejected: it would turn a
today-passing optional-absent run whose schema file is broken into a `CONFIG` failure.

### C-10 — Refusal table (exact `CONFIG` texts)

| Condition | Where | Code | Message |
| --- | --- | --- | --- |
| `output.result` on a `human`/`form` node | `validateGraphManifest` | `CONFIG` | ``graph flow <path> declares output.result on node "<id>" of type <type> — human/form nodes take their vars from the HITL input artifact; remove output.result`` |
| `output.result` on `orchestrator`/`consensus` with `engine_min < 3.6.0` | `validateGraphManifest` | `CONFIG` | ``graph flow <path> declares output.result on an orchestrator/consensus node but engine_min "<min>" < 3.6.0 — bump compat.engine_min to 3.6.0 (host engine is <engine>)`` |
| Schema doc uses `type: "json"` or `items` with `engine_min < 3.6.0` | package install | `FLOW_INSTALL` | ``flow install failed [stage=schema] <ref> uses the json field type or typed array items but engine_min "<min>" < 3.6.0 — bump compat.engine_min to 3.6.0`` |
| Same, in Studio lifecycle validation | authored-flow validation | finding | `form_schema_invalid`, severity BLOCK, same sentence |
| Unsafe own key at any depth | seam / any validator consumer | `CONFIG` | ``unsafe key "<key>" at <jsonPath>`` |
| Depth / key-count / array-length over limit | seam / any validator consumer | `CONFIG` | ``payload exceeds the maximum nesting depth (64) at <jsonPath>`` · ``payload exceeds the maximum object key count (10000)`` · ``array at <jsonPath> exceeds the maximum length (10000)`` |
| `items` element mismatch | seam / any validator consumer | `CONFIG` | ``field "<name>[<i>]" must be a <type>`` |
| `engine_vars` absent while `required: true` | seam (`consensus`) | `CONFIG` | ``structured output required but absent: the node produced no engine vars`` |

Seam failures keep the Wave-1 envelope: the reason is appended to the attempt's stdout as
`[structured output] <reason>` and the attempt is marked `Failed` with `CONFIG` unless `on_mismatch`
routes it into rework.

### C-11 — Engine floors

`MAISTER_ENGINE_VERSION` bumps `3.5.0 → 3.6.0`. `OUTPUT_COORDINATOR_ENGINE_MIN = "3.6.0"` gates
`output.result` on `orchestrator`/`consensus` and the `json`/`items` schema-document features. The
`human`/`form` refusal carries **no** floor — the combination is dead configuration at every engine
version, so the honest gate is an unconditional refusal, not a version gate.

### C-12 — Rejected alternative: engine prompt injection of the sentinel instruction

The engine does NOT append "emit a ` ```json maister:output ` block" to any node prompt. Doing so
would mutate `resolved_prompt` for every run of every declaring node, breaking the prompt stability
that reruns and provenance depend on, and would take ownership of prompt text away from the package
that ships it. The instruction channel stays package-owned; the shipped authoring grammar
(`buildFlowDslGrammar()` → the `/flow-authoring` skill + the Studio assistant) carries the full
runtime contract instead.

### C-13 — Plane separation (result vs evidence)

`stdout`/logs are **diagnostics**; `node_attempts.vars` is the **result**; `artifact_instances` is
the **evidence graph**. A structured result MUST NOT carry an artifact body. An artifact id appearing
inside a payload is **inert data** — nothing in the engine dereferences it, and a payload key that
looks like an artifact reference confers no evidence.

### Wave-3 Expectations

- The transport for a node MUST be `NODE_OUTPUT_TRANSPORT[nodeType]`, MUST cover all eight node
  types, and MUST NOT be influenced by any author-declared field.
- An `orchestrator` node's parked turn MUST NOT be validated; only its completing turn MUST be.
- A `consensus` node's `output.result` MUST validate `result.vars` in place and MUST NOT mutate it.
- `output.result` on a `human`/`form` node MUST be refused at manifest load (`CONFIG`), at every
  engine version.
- `output.result` on an `orchestrator`/`consensus` node, and a schema document using `json`/`items`,
  MUST require `compat.engine_min >= 3.6.0`.
- A `json` field MUST accept any JSON value and MUST treat an explicit `null` as present; every
  other type MUST keep `null` = absent.
- An `array` with `items` MUST validate every element and name `field[i]` on failure; an `array`
  without `items` MUST stay untyped.
- Undeclared payload keys at any depth MUST pass validation and MUST reach `node_attempts.vars`
  unmodified.
- A payload with an own `__proto__`/`constructor`/`prototype` key at any depth, or over the depth /
  key-count / array-length limits, MUST be rejected before any field check — in all three validator
  consumers.
- `node_attempts.output_contract` MUST be written on attempt close (success AND a post-resolution
  seam failure) once the declared schema has been resolved, MUST survive `markNodeReworked`, and MUST
  stay `NULL` otherwise.
- No documented API response, OpenAPI/AsyncAPI schema, or client DTO may gain `output_contract`.
- `MAISTER_ENGINE_VERSION === "3.6.0"`; Wave 3 MUST add no HTTP route, no `runs.status` value, no
  `MaisterError` code, no env var, and no compose change.

### Wave-3 Acceptance criteria

- AC23 (C-1/C-14) — The transport map covers all eight node types; the `ai_coding`/`judge`/`cli`/
  `check` arms pass their existing suites without assertion edits.
- AC24 (C-1/C-3) — An `orchestrator` node with a valid completing-turn sentinel block folds its
  payload into `vars` and persists it to `node_attempts.vars`; downstream `{{ steps.<id>.vars.* }}`
  renders it.
- AC25 (C-3) — An `orchestrator` node with `required: true` that completes WITHOUT a sentinel block
  fails the attempt `CONFIG` (sentinel-flavored reason) and gates do not run; the same node parking
  with pending children produces NO validation and NO `CONFIG`.
- AC26 (C-2) — A `consensus` node's synthesis completion validates its engine vars with the object
  unmutated; a schema mismatch fails `CONFIG`; `required` + zero-key vars fails; optional +
  zero-key passes.
- AC27 (C-10/C-11) — `output.result` on `human`/`form` refuses at load; on `orchestrator`/
  `consensus` below `3.6.0` refuses naming the floor and the identical manifest at `3.6.0` loads and
  runs.
- AC28 (C-11) — A schema document using `json`/`items` under `engine_min < 3.6.0` refuses at package
  install (`FLOW_INSTALL`) and BLOCKs in Studio validation; the same document at `3.6.0` installs.
- AC29 (C-4/C-5) — A required `json` field is satisfied by `null` and violated by a missing key, and
  accepts any JSON value; an `items` violation names `field[i]`; an `items`-less array accepts mixed
  elements.
- AC30 (C-6) — A payload with undeclared nested structures passes validation, is not mutated by the
  validator, survives into `node_attempts.vars` deep-equal, and re-renders through templating.
- AC31 (C-7/C-8) — At-limit payloads pass and limit+1 payloads fail naming the limit; an unsafe own
  key at any depth fails naming the JSON path, before any field check.
- AC32 (C-8) — The `hitl-validate` and Brain-distill suites pass unmodified under the hardening.
- AC33 (C-9) — `output_contract` is persisted on success and on a post-resolution seam failure
  (schema mismatch), survives `markNodeReworked`, and is `NULL` for nodes without a declaration, for
  HITL attempts, and for pre-resolution failures; `sha256` is the hash of the raw schema bytes and is
  stable across attempts; `transport` matches the arm; `engineVersion` is `3.6.0`.
- AC34 (C-9) — `git grep` confirms the only full-row `select().from(nodeAttempts)` outside tests is
  `ledger.ts`, and the diff leaves `docs/api/**` untouched.
- AC35 (C-10) — Each new failure class (unsafe key, depth/keys/array limit, `items` mismatch,
  `engine_vars` mismatch) with `on_mismatch: retry|<outcome>` enters engine rework with the reason in
  `commentsVar`; without `on_mismatch` it is a hard `CONFIG`.
- AC36 (C-12) — The shipped authoring grammar contains the literals `maister:output`,
  `MAISTER_OUTPUT_FILE`, every supported node type in the structured-output section, and the `3.6.0`
  floor string; `resolved_prompt` gains no engine-injected sentinel instruction.
