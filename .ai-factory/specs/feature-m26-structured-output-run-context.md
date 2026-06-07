# Feature M26 — Structured Node Output Channel (P1) + Run-Context File (P7)

## Status

Designed, Wave 1. Frozen SSOT for `feature/m26-structured-output-run-context`.
Plan: `.ai-factory/plans/feature-m26-structured-output-run-context.md`. ADR: `docs/decisions.md` ADR-063.
Re-frozen 2026-06-07 after the Phase-0 adversarial gate (resolves A1 compose, B1 stdout cap, B2
vacuous deferred, B3 read-scope, B4 gate status, B5 nested-grammar, cli-attempt threading).

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
- No P2 (prompt content injection), P4 (`decide` table), P6 (session continuity), or P3 (diff-path
  assertions / `hash`·`size_bytes`).
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
