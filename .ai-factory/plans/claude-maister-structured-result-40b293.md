# Implementation Plan: Universal structured node result mechanism (output.result transport matrix)

Branch: claude/maister-structured-result-40b293
Created: 2026-09-01 · Refined: 2026-09-01 (/aif-improve — SDD+TDD pass)

## Settings
- Testing: yes (TDD: RED → GREEN → refactor per phase; integration-first, unit only for pure parse/validate functions)
- Logging: verbose (structured DEBUG for transport selection + validation outcomes; never full payload bodies)
- Docs: yes  # mandatory — SDD artifacts lead (Phase 0), as-built flip closes (Phase 5)

## Roadmap Linkage
Milestone: "none"
Rationale: Inspected `.ai-factory/ROADMAP.md` (milestones through M50 + the 2026-08-31 Backlog/triage ledger) — no active milestone or backlog row matches; M26/M38 that shipped the mechanism are closed. Skipped per task instruction.

---

## Verified current state (code-inspected 2026-09-01)

All claims read from source on this branch (fork of main `20a4307f3`).

| # | Fact | Evidence |
|---|------|----------|
| 1 | Single validator: `validateStructuredOutput` validates a value against a `formSchemaSchema` doc (`string\|number\|boolean\|enum\|array\|object`). Iterates **schema fields only** → undeclared payload keys pass through into vars (open, undocumented). `array` checks `Array.isArray` only (no items). `object` with `fields` recurses; without `fields` it is open. `null` counts as absent for every type. No depth/keys/length limits, no unsafe-key rejection. | `web/lib/flows/output-schema.ts:14-92` |
| 2 | The validator has **three consumer channels**: the node-output seam, HITL form/human responses (`hitl-validate.ts:16`), and Brain lesson distillation (`brain/distill.ts:250`, `LESSON_SCHEMA`). Hardening the shared validator touches all three. | grep `validateStructuredOutput` callers |
| 3 | Transport selection: `transport = nodeType === "ai_coding" \|\| "judge" ? "sentinel" : "file"` after excluding only `human`/`form`. **`orchestrator` and `consensus` fall to `file`** — a transport neither provisions (`MAISTER_OUTPUT_FILE` is armed only inside `runCliStep`). Declared `output.result` on them ⇒ always-absent payload: `required:true` = guaranteed misleading CONFIG, `required:false` = silent no-op. | `web/lib/flows/graph/node-output.ts:219-258`, `runner-graph.ts:1497-1511` |
| 4 | Orchestrator runs the same `runAgentStep` ACP path as `ai_coding` (`RUNNER_BEARING_NODE_TYPES`); `runOrchestratorStep` wraps park-vs-complete only. The park branch (`result.needsInput`) breaks **before** the validate seam → only the **completing turn's** stdout ever reaches validation. | `compile.ts:79-83`, `runner-graph.ts:1519,1704-1708,3295-3379,3453` |
| 5 | Consensus produces engine vars: the only `ok && !needsInput` result reaching the seam is synthesis completion returning `vars: { consensus: { source, round, consensusPlanArtifactId, debateLogArtifactId } }`. The seam never validates them. | `consensus/runtime.ts:756-768,902-909,956-1032` |
| 6 | Seam lifecycle: post-action, pre-gates (`runner-graph.ts:3453`). Absent+required → `failAttempt` (markNodeFailed, CONFIG, `[structured output]` stdout line); absent+optional → vars unchanged; present-but-broken → always fails (spec-strict). Success: `result.vars = {...vars, ...value}` merged in place; single `markNodeSucceeded(..., {vars})` persists to `node_attempts.vars`. `on_mismatch` (`retry`\|outcome) drives engine rework (commentsVar injection, workspace policy, downstream-stale); absent = hard CONFIG. | `node-output.ts:207-327`, `runner-graph.ts:3448-3626`, `ledger.ts:152-183`, `db/schema.ts:4196` |
| 7 | Schema resolution: `resolveOutputResultSchema` = `readAndValidateFormSchemaDoc` (escape-guarded realpath, JSON parse, zod). Also validated at **install** via `validatePackageRootSchemaReferences` → `collectReferencedSchemaPaths`, which **does** collect `output.result.schema`. No per-attempt identity (hash) persisted anywhere. | `config.ts:1868-1941`, `flows.ts:400-420`, `flows/artifact-validate.ts` |
| 8 | Zod DSL: `nodeOutputSchema.result = { schema, required?, on_mismatch? } .strict()` sits in `nodeCommon` → **all 8 node types accept it at load**; no per-type gating. Compile checks (`verifyDecideAndOnMismatch`) are type-agnostic. Floors exist: `output.result` 1.3.0, `decide`/`on_mismatch` 1.7.0. | `config.schema.ts:489-507`, `compile.ts:85-191`, `config.ts:1047-1123` |
| 9 | Byte cap: `MAISTER_NODE_OUTPUT_MAX_BYTES` default 262 144, pre-parse, both transports; sentinel additionally bounded by the 1 MiB `STDOUT_CAP_BYTES` capture (over-cap block = absent by spec). | `instance-config.ts:364-374`, `node-output.ts:44-110` |
| 10 | `computeDecideOutcome` `from: output.<path>` walks vars via `getPath` using `Object.hasOwn` → prototype-chain reads already blocked in routing. Residual unsafe-key risk = other vars consumers (template context, run-context `promoted` union, future merges). | `decide-eval.ts:36-67`, `when-grammar.ts` |
| 11 | Docs claim exactly four supported types in two near-verbatim transport tables; `artifacts.md` never mentions the result channel; frozen-spec "limitation (b)" (no load-time schema validation) is stale — install-time validation exists. | `docs/flow-dsl.md:829,1350-1405`, `docs/system-analytics/flow-graph.md:173-215,669-718`, spec |
| 12 | Authoring grammar shipped to agents (`buildFlowDslGrammar()` → `/flow-authoring` skill + Studio assistant every turn) covers the mechanism in **one line** — no sentinel format, no `MAISTER_OUTPUT_FILE`, no matrix, no floors. Drift guard checks zod-derived facts only → prose hole invisible. | `flow-dsl-grammar.ts:186,237-239`, `authoring-skill.ts:121,186-190` |
| 13 | Usage census: one in-repo fixture (`_fixtures/m26-output-flow/`, ai_coding) + e2e seeds; **no shipped package uses `output.result`; nothing exercises cli/check transport in examples; zero human/form declarations** → new refusals/floors break nothing real. | docs/tests sweep, `web/e2e/_seed/seed-e2e.ts:1243-1372` |
| 14 | `node_attempts` has no engine-metadata slot: `vars` = **flow-visible** plane (`{{ steps.<id>.vars.* }}`, decide, run-context), `decision` = rework/takeover provenance, `enforcementSnapshot`/materialization = capability-typed, `stdout` = truncated diagnostics. Its ERD lives in `docs/db/runs-domain.md`. | `db/schema.ts:4117-4230`, `docs/db/runs-domain.md` |
| 15 | **API exposure sweep**: the only no-arg (full-row) `select().from(nodeAttempts)` in non-test code is engine-internal `ledger.ts`; every UI/ext query module (`queries/run.ts`, `board.ts`, observatory, evidence-graph, ext services, diff route) selects explicit columns → a new column reaches **no** client DTO or documented response implicitly. | grep sweep 2026-09-01 |
| 16 | Numbers: `MAISTER_ENGINE_VERSION = "3.5.0"` (3.5.0 = `REENTRY_ENGINE_MIN`, ADR-160 — its comment line in engine-version.ts is missing), max ADR = 161, max migration = `0126_claim_head_sha`. | `engine-version.ts:66`, `config.ts:552`, `docs/decisions.md`, `db/migrations/meta/_journal.json` |
| 17 | Vitest layout: filename decides the project — `*.test.ts` → `unit`, `*.integration.test.ts` → `integration` (`web/vitest.workspace.ts`); `pnpm test:unit` / `pnpm test:integration` (Docker/testcontainers). Graph seeding helper: `web/test-support/graph-run-seed.ts`. | `web/vitest.workspace.ts`, `web/package.json` |

## Requirements (from the task; each carries its ACs below)

- **R1 — Contract retention.** `output.result` stays the node-level contract; schema file under the package's `schemas/` is the runtime source of truth; payload is `unknown` until validation; schemas resolve from the Run's pinned flow/package revision; immutable schema identity persisted per attempt for audit.
- **R2 — Transport matrix.** `ai_coding|judge|orchestrator` → sentinel; `cli|check` → `MAISTER_OUTPUT_FILE`; `consensus` → engine-produced `result.vars` validated directly; `human|form` → native HITL path retained; unsupported node+transport combinations rejected at load/compile time.
- **R3 — Lifecycle.** Validate post-action, pre-gates; persist into `node_attempts.vars`; `required`, byte limits, malformed handling, `on_mismatch`, rework, `decide.from: output.<path>` consistent across supported nodes; present-but-malformed → actionable `MaisterError("CONFIG")`; absent optional → vars unchanged; never fall back to stdout/artifacts/`{}`.
- **R4 — Open JSON.** `json` field type (any JSON value); open objects; undeclared fields preserved, never stripped; optional typed array items while untyped arrays stay valid; payload byte / nesting-depth / object-key / array-length bounds (string length subsumed by the byte cap); unsafe keys (`__proto__`, `constructor`, `prototype`) rejected.
- **R5 — Plane separation.** stdout/logs = diagnostics; `node_attempts.vars` = result; `artifact_instances` = evidence; no artifact bodies in results; agent-supplied artifact ids are inert data.
- **R6 — Compatibility.** Undeclared nodes byte-identical; existing four-type manifests valid; existing schema semantics preserved except documented-unsafe behavior; DB migration only because inspection proved necessity (facts 14–15).
- **R7 — TDD.** RED → GREEN → refactor per phase; tests cover all required behavior + edge cases with minimum overlap and no trivial tests; suites green at every phase boundary.
- **R8 — Observability.** Structured DEBUG for transport selection and validation outcomes; never full private payloads.
- **R9 — SDD docs.** Spec/ADR/system-analytics/API-contract/DB-contract complete and internally consistent BEFORE code (Designed), flipped as-built after (Implemented); authoring grammar carries the full runtime contract.
- **R10 — Code quality.** SOLID/KISS/DRY + repo conventions (single matrix SSOT, one validator walk, no new deps, surgical diffs, `MaisterError` codes, no new env vars).

## Locked design decisions

**D1 — Transport matrix (single SSOT map)** — one exported map in `node-output.ts` keyed by node type; the seam, load-time refusals, and grammar text all derive from it:

| Node type | Transport | Semantics |
|---|---|---|
| `ai_coding`, `judge`, `orchestrator` | `sentinel` | Last properly-fenced ```` ```json maister:output ```` block in the 1 MiB-capped stdout of the **completing** turn (orchestrator: the turn with no pending children; parked turns are never validated). |
| `cli`, `check` | `file` | Unchanged per-attempt `MAISTER_OUTPUT_FILE`. |
| `consensus` | `engine_vars` | Validate engine-produced `result.vars` directly. Validation-only: **no merge, no mutation**. Absent ⇔ zero keys (defensive; the completing path always carries `vars.consensus`). Failure semantics identical (CONFIG / `on_mismatch`). |
| `human`, `form` | native HITL | Declaring `output.result` on them refused at load (D12-pattern rule) — today silently-dead config, so refusal corrects an authoring error, never working behavior. Seam keeps its defensive skip. |

Transport chosen by node type (execution mechanism), never author-declared.

**D2 — Engine floors (3.6.0).** Bump `MAISTER_ENGINE_VERSION` 3.5.0 → 3.6.0. `OUTPUT_COORDINATOR_ENGINE_MIN = "3.6.0"`: `output.result` on `orchestrator|consensus` requires `compat.engine_min >= 3.6.0` (load-time). Schema docs using `type:"json"` or `items` require the same floor, enforced where manifest+doc meet: `validatePackageRootSchemaReferences` (install, `FLOW_INSTALL`) and the lifecycle validation emitting `form_schema_invalid` (Studio, BLOCK). human/form refusal gets **no** floor (dead config → hard refusal). Restore the missing `3.4.0 -> 3.5.0` comment line (`reentry`, ADR-160) while editing the chain.

**D3 — Schema grammar additions.** `type: "json"`: any JSON value; **for `json` only, JSON `null` is a present value** (absent = key missing/`undefined`); all other types keep `null = absent` byte-identically. `array` gains optional recursive nameless `items` `{type, options?, fields?, items?}`; arrays without `items` stay untyped. Objects stay **open by default**; undeclared payload fields preserved (formalized + pinned). No `additionalProperties` knob (default already open; no closing use-case — KISS).

**D4 — Structural limits + unsafe keys (shared validator).** One recursive pre-pass walk in `output-schema.ts`: reject own-keys `__proto__|constructor|prototype` at any depth (error names the JSON path); depth > 64, total object keys > 10 000, array length > 10 000 → error naming the limit. Exported constants, **no new env vars** (byte cap stays the tunable; per-string length subsumed by it — documented). Shared-validator consequence (fact 2): HITL form/human responses **and Brain lesson distillation** get the same hardening — deliberate (same flow-visible plane / same LLM-origin), named in Compatibility and regression-swept.

**D5 — Schema identity audit (migration 0127).** Facts 14–15 prove no existing column fits (`vars` = flow-visible plane) and no DTO leaks a new column. Add nullable jsonb `node_attempts.output_contract`:
`{ schemaRef: string, schemaVersion: number, sha256: string, transport: "sentinel"|"file"|"engine_vars", engineVersion: string }`
written on the same ledger UPDATE that closes the attempt (success AND seam-failure paths; `markNodeReworked` must not clear it — pinned). NULL = pre-feature or no decl. Identity captured once at resolution (`resolveOutputResultSchemaWithIdentity` hashing raw bytes); shared form-schema readers keep signatures/behavior.

**D6 — Author instruction channel stays package-owned.** No engine prompt injection of the sentinel instruction (keeps `resolved_prompt` stable; packages own prompts). The authoring grammar gains the full runtime contract instead; rejected alternative recorded in ADR-162.

**D7 — Data planes (R5).** No artifact bodies in results; payload artifact ids are inert (nothing dereferences them — stated in docs). flow-dsl.md gets a short "produces (evidence) vs result (result)" paragraph; artifacts.md gets one cross-ref line.

**D8 — Logging (R8).** Extend existing pino pattern (keys/identity only, never values): DEBUG `transport selected` {nodeId, nodeType, transport}; DEBUG/INFO outcome {ok/reason-class, keys, schemaRef, sha256 prefix}; WARN refusals. `LOG_LEVEL`-driven. Enforcement: task-acceptance grep (no payload interpolation in log calls) — review-enforced, stated honestly.

**D9 — Lifecycle invariants (R3).** Seam position untouched (`runner-graph.ts:3453`); `required` excuses absence only; present-but-broken always fails; no fallbacks; `on_mismatch`/rework/decide identical across supported types (compile rules already type-agnostic).

**D10 — Numbers.** ADR-162 (verify max against main HEAD at write time); migration `0127` (verify `_journal.json` max); engine `3.6.0`. Renumber pass budgeted (Phase 5).

## SDD contract artifacts

**S1 — Spec extension** (`.ai-factory/specs/feature-m26-structured-output-run-context.md`, dated section, M38-extension pattern). Clauses, each numbered `C-n` and mirrored by an AC: matrix table (C-1); engine_vars semantics (C-2); orchestrator completing-turn rule (C-3); json presence rule (C-4); items shape (C-5); open-by-default + preservation (C-6); limits table + byte-cap subsumption rationale (C-7); unsafe-key rule + three-consumer blast radius (C-8); audit contract shape + write points (C-9); refusal table with exact CONFIG texts (C-10); floors (C-11); rejected prompt-injection alternative (C-12); stale-limitation-(b) reconcile (C-13).

**S2 — API contract statement.** No HTTP/SSE/webhook surface changes. Verified (fact 15): only `ledger.ts` selects node_attempts full-row (engine-internal); all client/ext DTOs enumerate columns → `output_contract` reaches no documented response. `docs/api/web.openapi.yaml`, `external/*`, `async/*` stay untouched; re-assert the sweep at Phase-3 exit (grep in T3.2 acceptance). Any future exposure is a separate decision.

**S3 — DB migration contract.** `0127_output_contract.sql`: `ALTER TABLE "node_attempts" ADD COLUMN "output_contract" jsonb;` — additive, nullable, no default, no backfill (NULL = "not audited"; satisfies migrations-preserve). Quadruple: SQL + `_journal.json` (idx 127, `when` monotonic) + `meta/0127_snapshot.json` + `schema.ts` column with `$type<NodeAttemptOutputContract>`. Integrity gates: newest journal entry has matching snapshot; `drizzle-kit generate` proposes nothing after the edit; testcontainers bootstrap applies it (integration suite). Docs: `docs/database-schema.md` narrative + `docs/db/runs-domain.md` erDiagram + `pnpm --filter maister-web db:erd` regen (generated artifact follows code — Phase 3; narrative may carry a (Designed) note from Phase 0).

**S4 — System-analytics contract.** Phase 0 writes `docs/system-analytics/flow-graph.md` target state with **(Designed)** tags: matrix in the seam section (§173-215), engine_vars pipeline step, the refusal/precondition table stated exactly as code will gate (allow-list wording), Expectations re-consolidated **within the ≤12-bullet budget**; every MUST bullet names its enforcing test/gate (patch 2026-07-27-09.30 rule). Phase 5 flips tags to (Implemented) + as-built reconcile. No new system-analytics file (stays in the flow-graph domain; index untouched — KISS).

**S5 — Authoring-grammar contract.** `flow-dsl-grammar.ts` gains the runtime contract (sentinel fence, file transport, matrix, floors, byte cap, "the schema file is the contract — reference `./schemas/<name>.json`, never restate it"); drift guard gains prose pins so the contract cannot silently vanish from the shipped `/flow-authoring` skill.

## Acceptance criteria (Given/When/Then → enforcing test)

Validator (R4, D3, D4):
- **AC-1** Given a schema with a required `json` field: payload value `null` → passes; key missing → CONFIG "required". Any JSON value (scalar/array/object) accepted. → `web/lib/flows/__tests__/output-schema.test.ts` (unit)
- **AC-2** Given `array` with `items`: conforming elements pass; a violating element fails naming `field[i]`; an array field without `items` accepts mixed elements (openness pin). → output-schema.test.ts
- **AC-3** Given undeclared keys (incl. nested trees) beside declared fields: validation passes and the validator does not mutate/strip the value. → output-schema.test.ts (+ AC-16 round-trip)
- **AC-4** Given `__proto__`/`constructor`/`prototype` as an own key at top or nested level: CONFIG naming the JSON path; applies before field checks. → output-schema.test.ts
- **AC-5** Given payloads at each structural limit (depth 64 / total keys 10 000 / array length 10 000): at-limit passes, limit+1 fails naming the limit. → output-schema.test.ts
- **AC-6** All pre-existing validator cases pass unmodified (byte-identical semantics for existing types incl. `null`=absent). → existing output-schema.test.ts cases (unchanged)

Matrix (R2, D1, D2):
- **AC-7** Orchestrator node with valid completing-turn sentinel → payload folded into vars (unit) and persisted to `node_attempts.vars`, downstream `{{ steps.<id>.vars.* }}` renders (integration). → `node-output.test.ts` + `node-output.integration.test.ts`
- **AC-8** Orchestrator `required:true`, completion without sentinel → attempt Failed CONFIG (sentinel-flavored reason), run Failed, gates did not run. → node-output.integration.test.ts
- **AC-9** Orchestrator with pending children parks WITHOUT validation (attempt NeedsInput, no CONFIG); after children settle, only the final turn's stdout is validated. → orchestrator-arm integration (park seeding per `orchestrator-park.integration.test.ts` pattern)
- **AC-10** Consensus completion: valid engine vars pass with vars unmutated; schema mismatch → CONFIG; `required` + zero-key vars → CONFIG; optional + zero-key → ok. → node-output.test.ts (unit) + `consensus-output.integration.test.ts`
- **AC-11** Manifest declaring `output.result` on `human`/`form` → load CONFIG naming the node id and pointing at native HITL vars. → config load unit test
- **AC-12** `output.result` on orchestrator/consensus with `engine_min < 3.6.0` → CONFIG naming the floor; **positive arm:** identical manifest at `3.6.0` loads and runs. → config load unit test (+ AC-7/10 integration are the run-side positives)
- **AC-13** Package schema doc using `json`/`items` with manifest `engine_min < 3.6.0` → `FLOW_INSTALL` refusal at install and BLOCK finding in Studio validation; **positive arm:** same doc at `3.6.0` installs. → flows install + artifact-validate unit suites
- **AC-14** The transport map covers all 8 node types (TS exhaustiveness + runtime pin test); `ai_coding|judge|cli|check` arms byte-identical — their existing suites pass without assertion edits. → node-output.test.ts + existing suites
- **AC-15** `decide.from: output.<path>` routes on orchestrator output and on `consensus.*` vars; undeclared-outcome allow-list guard still CONFIGs. → orchestrator/consensus arm integration tests

Lifecycle & hardening (R3, R4):
- **AC-16** Open payload with undeclared nested structures survives into `node_attempts.vars` deep-equal and re-renders via templating. → node-output.integration.test.ts
- **AC-17** Each new failure class (unsafe key, depth/keys/array limit, items mismatch, engine_vars mismatch) with `on_mismatch: retry|<outcome>` → engine rework with the reason in `commentsVar`; without `on_mismatch` → hard CONFIG. → `runner-graph-on-mismatch.integration.test.ts` extension (one case per class, no duplicates)

Audit (R1, D5):
- **AC-18** `output_contract` persisted on: success, seam-failure, and survives `markNodeReworked`; NULL on nodes without decl and on human/form/HITL attempts. `sha256` = hash of raw schema bytes, stable across attempts; `transport` matches the arm; `engineVersion` = 3.6.0. → ledger unit tests + integration extensions
- **AC-19** No documented API response gains the column: full-row select sweep still returns only `ledger.ts`; `docs/api/**` untouched by the diff. → T3.2 acceptance grep (review-enforced gate)
- **AC-20** Migration integrity: journal max+1 = 0127 with matching snapshot; post-edit `drizzle-kit generate` proposes no drift; fresh testcontainer bootstrap applies 0127. → Phase-3 gate commands

Docs/grammar (R9, S4, S5):
- **AC-21** Grammar output contains literals `maister:output`, `MAISTER_OUTPUT_FILE`, every supported node type in the structured-output section, and the `3.6.0` floor string. → `flow-dsl-grammar.test.ts` prose pins
- **AC-22** Shared-validator co-consumers stay green under hardening: `hitl-validate` and brain-distill suites pass unmodified. → their existing suites (enumerated in T4.3)

## Traceability (R → AC → phase)

| R | ACs | Phase |
|---|-----|-------|
| R1 | AC-18, AC-19, AC-20 | 3 |
| R2 | AC-7…AC-15 | 2 |
| R3 | AC-8, AC-16, AC-17, AC-6 | 2, 4 |
| R4 | AC-1…AC-5, AC-16, AC-17 | 1, 4 |
| R5 | S1 C-8/C-10 prose + docs tasks | 0, 5 |
| R6 | AC-6, AC-14, AC-22 | 1, 2, 4 |
| R7 | TDD protocol below; every phase gate | all |
| R8 | D8 grep acceptance (T2.G, T3.G) | 2, 3 |
| R9 | S1–S5; AC-21 | 0, 5 |
| R10 | matrix SSOT (D1), single walk (D4), no new deps/env, surgical diffs | review at every gate |

## TDD protocol (binding for /aif-implement)

1. **RED first, per phase.** Write the phase's new tests before touching implementation; run them; confirm each fails **for the intended reason** (assertion message, not import/type error). Compile-blocking cases (new zod fields) may use `expect(...).toThrow`-style shape probes that fail red pre-implementation.
2. **GREEN minimal.** Implement until the phase's RED set passes; no speculative behavior beyond the ACs.
3. **REFACTOR under green.** DRY/naming/extraction only after green; full `pnpm test:unit && pnpm test:integration` at every phase exit.
4. **Minimum overlap.** Each AC has exactly ONE primary enforcing test (named above); other suites may touch the behavior incidentally but must not re-assert it as their purpose. No trivial tests (no zod-passthrough re-tests, no constant assertions).
5. **Extend, don't duplicate.** Prefer extending the enumerated existing files; new files only where listed (`consensus-output.integration.test.ts`, optionally `orchestrator-output.integration.test.ts` if the shared fixture gets crowded).
6. **Integration tests execute the real seam** (`runGraph` + real Postgres + real ledger writes) — a test that mocks the thing it claims to pin is a defect (patch 2026-08-06-19.10).
7. Tests land in the same commit as the code they drive (no separate red commits).

## Compatibility notes

1. `ai_coding|judge|cli|check` manifests: byte-identical; their suites must pass without assertion edits (AC-14).
2. `human|form` + `output.result`: silently-dead → load-time CONFIG refusal; census (fact 13) found zero users; documented as a correction.
3. `orchestrator|consensus` + `output.result`: broken-silent → functional behind `engine_min >= 3.6.0`; a pre-existing declaring manifest (none exists) would now refuse loudly — intended.
4. Schema docs: semantics preserved (openness, untyped arrays, preservation) except unsafe keys — the task's documented-unsafe carve-out. Blast radius: node output + HITL forms + brain distill (fact 2), all regression-swept (AC-22).
5. DB: one additive nullable column; old rows read NULL ("not audited"); no response-shape changes (S2).
6. No new env vars ⇒ no `.env.example`/compose wiring (ADR-023 precedent governs if Phase 0 review flips limits to env-tunable: `.env.example` + `docs/configuration.md` only, never compose).
7. e2e `m38-decide-routing.spec.ts` (cli transport) unaffected — must stay green.

## Contract-surface enumeration

| Surface | Files |
|---|---|
| Flow DSL | `web/lib/config.schema.ts`, `web/lib/config.ts`, `docs/flow-dsl.md` §1350-1405/§778-891/§1601-1605 |
| Runtime seam | `web/lib/flows/graph/node-output.ts`, `docs/system-analytics/flow-graph.md` §173-280 + Expectations (≤12 budget) |
| Validator | `web/lib/flows/output-schema.ts` (+ co-consumers `hitl-validate.ts`, `brain/distill.ts` — behavioral note only) |
| Engine version/floors | `web/lib/flows/engine-version.ts`, `web/lib/config.ts` |
| DB | migration 0127 quadruple + `docs/database-schema.md` + `docs/db/runs-domain.md` + `db:erd` regen |
| API | **no change** — S2 statement + sweep gate |
| Authoring grammar/skill | `web/lib/flows/flow-dsl-grammar.ts`, `web/lib/flows/authoring-skill.ts`, drift guard `flow-dsl-grammar.test.ts` |
| Studio | `form-schema-builder.tsx` (+ `messages/en.json`, `messages/ru.json`), `template-variable-catalog.ts` |
| Spec/ADR | `.ai-factory/specs/feature-m26-structured-output-run-context.md`, `docs/decisions.md` ADR-162 |
| Project docs | root `CLAUDE.md` §6 matrix line + engine number |

## Commit Plan
- **Commit 1** (Phase 0): `docs(specs): SDD contracts for the universal output.result transport matrix (ADR-162)`
- **Commit 2** (Phase 1): `feat(flows): json fields, typed array items, structural limits and unsafe-key rejection in the output schema grammar`
- **Commit 3** (Phase 2): `feat(flows): per-node-type output transports — orchestrator sentinel, consensus engine vars, load refusals (engine 3.6.0)`
- **Commit 4** (Phase 3): `feat(runs): persist output-contract identity on node attempts (migration 0127)`
- **Commit 5** (Phase 4): `test(flows): transport-arm hardening sweep and assertion migration`
- **Commit 6** (Phase 5): `docs(flows): as-built transport matrix, schema semantics, authoring-grammar contract`

No AI co-author trailer (repo convention).

---

## Tasks

### Phase 0: SDD contracts (no implementation code)

- [x] **T0.1 Spec extension** — write S1 clauses C-1…C-13 into the frozen spec (dated section, M38 pattern), including the refusal table with exact CONFIG texts and the AC list frozen as the contract. Reconcile stale limitation (b) citing `validatePackageRootSchemaReferences`.
- [x] **T0.2 ADR-162** — verify next free number against main HEAD (`git show main:docs/decisions.md | grep -o '### ADR-[0-9]*' | tail -3`); write the decision (matrix, floors, audit column, refusals, rejected prompt-injection alternative D6).
- [x] **T0.3 System-analytics (Designed)** — apply S4 to `docs/system-analytics/flow-graph.md`: matrix + engine_vars step + refusal table (allow-list wording, exactly as code will gate) with **(Designed)** tags; consolidate Expectations within the ≤12-bullet budget; every MUST names its enforcing test/gate. Update `docs/database-schema.md` narrative with a (Designed) note for `output_contract` (generated ERD follows in Phase 3).
- **Phase 0 gate:** `pnpm validate:docs` green (repo root); every D-decision and AC has a spec clause; internal-consistency self-check (no clause contradicts the current-state table).

### Phase 1: Validator grammar — TDD

- [x] **T1.R (RED)** — extend `web/lib/__tests__/config.schema.test.ts` (json/items parse + unknown-type still rejected) and `web/lib/flows/__tests__/output-schema.test.ts` with AC-1…AC-5 cases + AC-6 untouched; run `pnpm test:unit` → new cases fail for intended reasons.
- [x] **T1.G (GREEN)** — `config.schema.ts`: add `"json"` to `FormFieldShape`/`formFieldSchema`, recursive nameless `items`; `output-schema.ts`: json presence rule, items element validation with `field[i]` paths, structural pre-pass walk (unsafe keys with JSON path; depth/keys/array limits as exported constants). Existing error messages unchanged. No logging in the pure function.
- [x] **T1.F (REFACTOR + authoring touch)** — `form-schema-builder.tsx`: add `json` type option + EN/RU labels (`messages/en.json`, `messages/ru.json`); `template-variable-catalog.ts`: `json` field = opaque leaf (verify; adjust only if it warns) + extend `template-variable-catalog.test.ts`. Typed-items editing stays raw-JSON-mode (documented, no new UI).
- **Phase 1 gate:** `cd web && pnpm typecheck && pnpm exec eslint . && pnpm test:unit` green (never `pnpm lint` — it reformats the repo).

### Phase 2: Transport matrix — TDD

- [x] **T2.R (RED)** — author failing tests first: (a) `node-output.test.ts`: matrix exhaustiveness pin (AC-14), orchestrator sentinel unit cases (AC-7/8 unit half), consensus engine_vars unit cases (AC-10); (b) config load unit tests: human/form refusal (AC-11), floor refusal + 3.6.0 positive (AC-12); (c) install/Studio floor tests (AC-13); (d) integration: orchestrator arm in `node-output.integration.test.ts` (or `orchestrator-output.integration.test.ts`) covering AC-7/8/9/15 via `runGraph` + `graph-run-seed` (park case seeded per `orchestrator-park.integration.test.ts`); new `consensus-output.integration.test.ts` covering AC-10/15 at the synthesis boundary (persisted draft/verdict rows per the resume pattern; floor = real DB + real ledger writes, no mocks). Run → red.
- [x] **T2.G (GREEN)** — `node-output.ts`: exported `NODE_OUTPUT_TRANSPORT` map + sentinel/file/engine_vars arms (engine_vars: value = `result.vars`, absent ⇔ zero keys, byte-cap via serialized length, no mutation); DEBUG logs per D8. `config.ts`: `validateGraphManifest` refusals (D12 pattern) + `OUTPUT_COORDINATOR_ENGINE_MIN`; `flows.ts` + `artifact-validate.ts`: json/items floor checks. `engine-version.ts`: 3.6.0 bump + comment + restore the missing 3.5.0 line. Migrate any suite pinning `MAISTER_ENGINE_VERSION`.
- [x] **T2.F (REFACTOR)** — fixture `_fixtures/m26-output-flow/` extended for the new arms with readable comments (doubles as the reference example — none ships today, fact 13).
- **Phase 2 gate:** unit + integration green (`pnpm test:unit && pnpm test:integration`, Docker up); D8 grep: no log call interpolates payload values.

### Phase 3: Audit identity — TDD (depends on Phase 2)

- [x] **T3.R (RED)** — ledger unit tests: `markNodeSucceeded`/`markNodeFailed` persist `outputContract`, `markNodeReworked` leaves it intact (AC-18); seam unit: contract built on success + failure with correct transport/sha256; integration extensions asserting `output_contract` on the sentinel/file/engine_vars arms. Red (column/type not yet present — shape probes).
- [x] **T3.G (GREEN)** — migration `0127_output_contract.sql` + journal + snapshot + `schema.ts` (`NodeAttemptOutputContract` type) per S3; `config.ts`: `resolveOutputResultSchemaWithIdentity` (raw-bytes sha256, shared readers' signatures untouched); `node-output.ts` + `ledger.ts` threading; DEBUG identity log (sha256 prefix only).
- [x] **T3.F (docs + integrity)** — `pnpm --filter maister-web db:erd` regen; `docs/db/runs-domain.md` erDiagram + `docs/database-schema.md` as-built. Integrity per AC-20; API sweep per AC-19 (`grep -rn "select().from(nodeAttempts)" web/lib web/app --include='*.ts'` → only ledger.ts outside tests; `git diff --stat docs/api/` empty).
- **Phase 3 gate:** unit + integration green; `pnpm validate:docs` green (incl. `db:erd --check`); AC-19/AC-20 command outputs recorded in the commit message body.

### Phase 4: Hardening + completion sweep — TDD (depends on Phase 3)

- [x] **T4.R (RED)** — integration additions: open-JSON deep-equal round-trip + templating re-render (AC-16); one on_mismatch case per new failure class (AC-17) in `runner-graph-on-mismatch.integration.test.ts`; limit/unsafe-key arms through the real seam. Red where behavior is new; already-green cases are completion evidence, not failures of the protocol.
- [x] **T4.G (GREEN)** — close any gaps the RED set exposes (expected: small seam fixes only).
- [x] **T4.3 Assertion-migration + overlap sweep** — enumerate and re-green (no quarantine, no deletion): `node-output.test.ts`, `node-output.integration.test.ts`, `runner-graph-on-mismatch.integration.test.ts`, `runner-graph-decide-routing.integration.test.ts`, `output-schema.test.ts`, `output-result-schema.test.ts`, `runner-cli.test.ts`, `config.schema.test.ts`, `config.schema.decide.test.ts`, `config-artifacts.test.ts`, `template-variable-catalog.test.ts`, `flow-dsl-grammar.test.ts`, consensus `runtime.test.ts`, orchestrator park/resume integration suites, `hitl-validate` + brain-distill suites (AC-22). Overlap review: each AC maps to exactly one primary test; delete accidental duplicates **added by this work** only.
- **Phase 4 gate:** full `cd web && pnpm test:unit && pnpm test:integration` green; `pnpm typecheck`; `pnpm exec eslint .`.

### Phase 5: Docs as-built + grammar (depends on Phase 4)

- [x] **T5.1** `docs/flow-dsl.md` — transport table + both supported-type lists; human/form refusal; json/`null` rule, items, openness + preservation, limits (+ byte-cap subsumption), unsafe keys; 3.6.0 floors; "produces (evidence) vs result" paragraph near §1367.
- [x] **T5.2** `docs/system-analytics/flow-graph.md` — flip (Designed) → (Implemented); as-built reconcile; re-validate touched Mermaid.
- [x] **T5.3** `docs/system-analytics/artifacts.md` — one cross-ref line (plane separation). Root `CLAUDE.md` §6: matrix sentence + engine number 3.6.0.
- [x] **T5.4** Grammar + skill per S5: `flow-dsl-grammar.ts` structured-output section; `authoring-skill.ts` `REF_PACKAGE_LAYOUT` mentions `output.result` as a `schemas/` consumer; drift-guard prose pins (AC-21).
- [x] **T5.5** Finalize ADR-162 + spec as-built; renumber pass: re-verify ADR-162/migration-0127 are still max+1 vs main HEAD after rebase (`_journal.json` `when` monotonicity included); renumber if a parallel branch landed first.
- **Phase 5 gate (final):**
```
cd web && pnpm typecheck
cd web && pnpm exec eslint .
cd web && pnpm test:unit
cd web && pnpm test:integration     # Docker required
pnpm validate:docs                  # repo root; includes db:erd --check
```
All green. Owner-side after merge: `pnpm --filter maister-web db:migrate` (0127) on the dev DB.

## Out of scope (do not implement)
Public Run-level result exports · `run_collect` changes · RAH orchestration · Flow-target delegation · RLM runtimes · Prime Agent integration · autonomous skill/policy mutation · engine prompt-injection of the sentinel instruction (D6) · `additionalProperties` knob (D3) · env-tunable structural limits (D4) · API exposure of `output_contract` (S2) · new Studio UI beyond the builder type option.

## Unresolved questions (владельцу)
1. Sentinel-инструкцию агенту — инжектить движком в промпт или оставить пакету (грамматика учит автора)? План: пакет (D6).
2. Лимиты depth/keys/array — константы без env-тюнинга, ок? (D4)
3. Миграция 0127 `node_attempts.output_contract` jsonb — ок? (vars = flow-visible, класть туда нельзя; D5)
4. Hardening общего валидатора заденет HITL-формы И brain distill (три канала, факт 2) — ок?
5. Флор 3.6.0: молча-сломанный orchestrator/consensus+output.result манифест начнёт громко отказывать при загрузке — ок?
