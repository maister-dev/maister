# Feature M26 — Structured Node Output Channel (P1) + Run-Context File (P7)

## Status

Wave 1 (P1) **Implemented**; P7 + Wave-2 routing **delivered this milestone (M38)** — see
"## Wave 2 (M38)" below. Frozen SSOT, extended on `feature/flow-routing-runcontext`.
Plan (Wave 1): `.ai-factory/plans/feature-m26-structured-output-run-context.md`.
Plan (M38): `.ai-factory/plans/feature-flow-routing-runcontext.md`.
ADRs: `docs/decisions.md` ADR-063 (Wave 1), **ADR-103 (M38: `decide` routing + `on_mismatch` +
engine 1.7.0 + P7)**.
Re-frozen 2026-06-07 after the Phase-0 adversarial gate (resolves A1 compose, B1 stdout cap, B2
vacuous deferred, B3 read-scope, B4 gate status, B5 nested-grammar, cli-attempt threading).
Extended 2026-06-22 (M38) with the **P4 `decide` table**, **`on_mismatch` rework**, **engine
`1.6.0 → 1.7.0`**, and the **P7 run-context file** (Designed → built this milestone).

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
node's resolved prompt (after `renderStrict`, before dispatch — both `new-session` and
`slash-in-existing`); the agent reads the file from its own worktree on demand.

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
- Each agent node's prompt MUST carry the `[Run context: <abs path>]` pointer in both session modes.
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
- AC10 — Every agent node's dispatched prompt contains `[Run context: <abs run.json path>]` in both
  `new-session` and `slash-in-existing` modes.
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
| AC10 | `runner-agent` unit: pointer present, both session modes (Phase 3) |
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
"verdict"`, **the engine** treats the verdict-producing gate as routing-input: its `calibrateVerdict`
result is surfaced out of `runNodeGates` (`GateRunResult.verdict`) instead of hard-failing the node, and
the node always reaches the outcome site with the verdict. **No author-declared `mode: advisory` is
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
- `on_mismatch` `maxLoops` exhaustion MUST behave like human-rework exhaustion (execution-policy
  `fail`/`escalate`/`ship_with_warning`).
- A manifest declaring `decide` or `on_mismatch` without `compat.engine_min >= 1.7.0` MUST be rejected
  (`CONFIG`); a manifest declaring neither MUST stay valid at its pinned floor.
- M38 MUST add no migration, no HTTP route, no `runs.status`/enum value, no new `MaisterError` code, no
  new env var, no `compose.yml` change; `MAISTER_ENGINE_VERSION === "1.7.0"`.

### Wave-2 Acceptance criteria

- AC14 — A node with `decide:{from:output.outcome}` whose validated output is `{outcome:"x"}` routes via
  `transitions.x`; a nested `decide:{from:output.a.b}` routes on the nested value.
- AC15 — A node with `decide:{from:verdict, cases:[{when:"confidence >= 0.8", target:approve},
  {default:true, target:review}]}` routes by the calibrated verdict; the verdict gate does NOT hard-fail.
- AC16 — A `confidence_min`-as-`decide` 2-case sugar selects the same branch a legacy `confidence_min`
  would.
- AC17 — A `decide` outcome ∉ transitions keys → runtime `CONFIG`; a compile-time producible outcome ∉
  transitions keys (verdict cases) → load `CONFIG`.
- AC18 — `on_mismatch: retry` on a malformed-output node re-runs the same node with the validation error
  in `commentsVar`, bounded by `maxLoops`; exhaustion applies the execution policy.
- AC19 — `on_mismatch: <outcome>` routes to the redirect target (∈ `allowedTargets`); a node without
  `on_mismatch` still `CONFIG`-fails (regression).
- AC20 — A flow declaring `decide`/`on_mismatch` without `compat.engine_min >= 1.7.0` is rejected
  (`CONFIG`); a flow without them validates at its old floor.
- AC21 — A crash between `markNodeReworked` and `markDownstreamStale` on an `on_mismatch` rework leaves
  the same recoverable state as a human rework.
- AC22 — `git grep` confirms no new migration/route/`runs.status`/`MaisterError` code/env-key/compose
  service for M38; `MAISTER_ENGINE_VERSION === "1.7.0"`.

## Known limitations (Phase 1)

- **`array` element shape is unconstrained.** A `{ type: "array" }` field validates only `Array.isArray`
  (`output-schema.ts` `case "array"`); the grammar has no `items` slot
  (`config.schema.ts` `formFieldSchema` has `name/label/type/required/default/options/fields` only), so
  element type is not checked. `{ type: "array" }` accepts any array, including a mixed/empty one. A
  Phase-2 `items?` field is the candidate to add element typing.
- **`output.result.schema` paths are NOT validated at manifest load.** `resolveOutputResultSchema`
  (`web/lib/config.ts`) reads + parses + `formSchemaSchema`-validates the `./path` at the **runtime parse
  seam** (Phase 2), not at flow install/load (`validateGraphManifest`). A non-existent, non-JSON, or
  malformed schema file is therefore caught at the post-action seam (run-time `CONFIG`), not at flow
  install/load time yet. Manifest-load-time resolution is a Phase-2 candidate.
