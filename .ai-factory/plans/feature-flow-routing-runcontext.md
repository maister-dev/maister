# Implementation Plan: Output-driven dynamic routing + output-mismatch rework + P7 run-context

Branch: feature/flow-routing-runcontext
Created: 2026-06-22
Spec (SSOT, to extend): `.ai-factory/specs/feature-m26-structured-output-run-context.md`
Brief: `.ai-factory/requests/2026-06-22-flow-decide-routing-runcontext.md`

## Settings
- Testing: yes — strict TDD (RED → GREEN → refactor) per task; `pnpm --filter maister-web test:unit` + `test:integration`, `pnpm --filter @maister/supervisor test`, playwright e2e.
- Logging: verbose — DEBUG at every routing decision (outcome chosen, source, predicate match), `decide` table evaluation, `on_mismatch` rework trigger, and `run.json` write/regeneration. Use the existing `pino` child-logger pattern (`log2` in `runner-graph.ts`).
- Docs: yes — mandatory docs checkpoint; SDD-first (Phase 0 freezes spec + ADR + UI design before any code).

## Roadmap Linkage
Milestone: "M38. Output-driven dynamic routing + run-context (P4 + P7, Wave 2)"
Rationale: Continues the M26 keystone (P1 shipped) by pulling P4 dynamic routing forward and finishing P7; this milestone does not yet exist in `.ai-factory/ROADMAP.md` and is registered in Phase 0 (T0.1) via `/aif-roadmap` (plan owns plan files only — roadmap edits route through the owner command).

---

## ⚠ Ground-truth corrections (verified in code on current `main` @ 4ff8fadd — the brief was pinned to the stale `7344260f`)

The brief's "Current ground truth" was largely **CONFIRMED** structurally (the M30/M34/M37 waves did **not** touch the routing or rework cores), but three load-bearing facts **drifted** and one brief "locked decision" is now **impossible**:

| Brief claim | Verified current truth | Action |
| --- | --- | --- |
| Locked #4: engine bump **`1.3.0 → 1.4.0`** | `1.4.0` (M30 retry/rework, ADR-080/081), `1.5.0` (M34 agent binding, ADR-089), `1.6.0` (M37 orchestrator, ADR-098) are **all taken**. Current `MAISTER_ENGINE_VERSION = "1.6.0"` (`web/lib/flows/engine-version.ts:24`). | **Bump `1.6.0 → 1.7.0`.** New `decide`/`on_mismatch` keys require `compat.engine_min >= 1.7.0`. |
| SDD: ADR "next free — note ADR-101 cost-budget, sibling may claim 102" | At main HEAD `docs/decisions.md` runs through **ADR-102** (101 = cost-budget, 102 = shared-worktree review/promote — both merged). | **Use ADR-103.** Reserve **ADR-104** for the sibling g4-guardrail-hooks plan (Plan 2). |
| (implied) migration number | Max journal `idx` = 60 / tag `0061_*`. Next free = `0062`. | **No migration** (reuses `node_attempts.vars` + rework machinery). `0062` left unused; `/aif-verify` asserts none added. |
| Outcome computation @ `runner-graph.ts:2868` | **CONFIRMED exact line** — action→`"success"`, `human`→`result.decision`; `judge`/`orchestrator`/`cli`/`check` fall through to `"success"`. | Single hook site for `decide`. |
| `resolveTransition` in `compile.ts` | **CONFIRMED**, now `compile.ts:137-150`. `transitions[outcome]` → node id or `"done"`/undefined → null (terminal). | Reused unchanged. |
| `transitions` schema | **CONFIRMED**, `config.schema.ts:821-822`: `z.record(z.string(), z.string().min(1)).optional()` in `nodeCommon` (shared by all node types incl. `orchestrator`). | No change to `transitions` shape. |
| `route_when` flow-level NL hint | **CONFIRMED**, `flowMetadataSchema` `config.schema.ts:983`, runner-ignored. | **Leave untouched.** |
| `confidence_min` | **CONFIRMED gate-level only** (`gates-exec.ts:172-237` `calibrateVerdict`, `compile.ts:78-95`). There is **no path today from calibration → a branchable outcome string** — `decide:{from:verdict}` is a genuinely new hook. | See Design D3. |
| `output.result` shape | **CONFIRMED** `{ schema, required? }`, `config.schema.ts:530-559`; the `result` sub-object is **`.strict()`**. `on_mismatch` **absent**. | Extend the strict sub-object with `on_mismatch?`. |
| P1 validate seam | `validateNodeStructuredOutput` `node-output.ts:214`; failure → `failAttempt` `node-output.ts:313-327` (`markNodeFailed`, `CONFIG`); called at `runner-graph.ts:2500-2519`; on `!ok` → `failed=true; runErrorCode="CONFIG"; break`. | `on_mismatch` intercepts here. |
| Rework machinery | **CONFIRMED**, `runner-graph.ts:3061-3263`. `isRework` computed `:2873`, **human-decision-only** trigger. **Not** wrapped in one `db.transaction` (git mutation → `markNodeReworked` → `markDownstreamStale`, run stays `Running`). `commentsVar` injection → `pendingInjectedVars` → next iteration `extraVars` (`:3207-3235`, `:2166`). | `on_mismatch` reuses this sequence with a new non-human trigger. |
| `scheduleAutoRetry` (ADR-080) | **CONFIRMED** `runner-graph.ts:1811-1908`; only `ai_coding`/`cli`; bounded by `retry_policy.attempts`. `RETRYABLE_ERROR_CODES = [SPAWN, EXECUTOR_UNAVAILABLE, CHECKPOINT, ACP_PROTOCOL]` — **`CONFIG` is NOT retryable.** | See Design D5 (rejected for `on_mismatch`). |
| `maxLoops` enforcement | **CONFIRMED two sites**: loop-top backstop `:1966-1975` (`nodeAttemptCount > maxLoops` → `CONFIG`) + decision-validation `:2917-2920`. | `on_mismatch` rework bounded by the same backstop. |
| P7 `run.json` writer | **CONFIRMED ABSENT** — no `buildRunContext`, no `.maister/run.json` writer anywhere in `web/`/`supervisor/` (only docs + unrelated aif-loop `run.json` + UI `runContext` props). | Build it (Phase 4). |
| `.maister/` git-exclude | `atomicWriteJson` exists (`web/lib/atomic.ts:11-16`). `ensureWorktreeGitExclude` exists (`web/lib/capabilities/materialize.ts:164`, writes `WORKTREE_EXCLUDE_PATTERNS` to `$(git rev-parse --git-path info/exclude)`) but its pattern list **omits `.maister/`**. | Add `.maister/` to that list, or a runner-side ensure (Phase 4, T4.3). |

> **All line numbers above are current-`main` verified.** They will drift again at implementation time — re-grep the anchor symbol, do not trust the number.

---

## Locked decisions (carry-forward + corrections)
1. Field name = **`decide`** (NOT `route`). `route_when` (flow-level hint) untouched.
2. `on_mismatch` is **opt-in** on `output.result`; default-absent = today's `CONFIG`-fail.
3. `when` grammar v1 = **one predicate per case + exactly one `default`**. AND/OR compound = future headroom, NOT now.
4. **engine_min bump `1.6.0 → 1.7.0`** (corrected). Existing packages keep working at their pinned floor.
5. P7 `run.json` shape v1 = hardcoded `"all"` (per M26 spec — do not invent a second shape).
6. **ADR-103** (corrected). No DB migration.

## Design decisions resolved (rationale → freeze in Phase 0 spec/ADR) — refined 2026-06-22 per owner Q1–Q5
- **D1 — `decide` applicability.** `decide.from: output.<path>` works on **any** node declaring `output.result` (`ai_coding | cli | check | judge`); `decide.from: verdict` works on a node with a **verdict-producing gate** (`ai_judgment | skill_check`). NOT judge-only. **(Q2) `<path>` is a nested dot-path** into the validated structured-output object (M26's `object`-with-`fields` grammar), e.g. `output.triage.outcome` — not just a top-level key.
- **D2 — Outcome hook.** `decide` evaluation **replaces** the hardcoded `"success"` at the single outcome site `runner-graph.ts:2868` when `node.decide` is present; otherwise byte-identical (action→`"success"`, human→`result.decision`). For `from: output.<path>`, outcome = the value at the `vars` dot-path resolved by a **safe nested getter** (missing → `undefined`, never throws), coerced to string for the transition key. For `from: verdict`, outcome = first `when`-matching case, else the `default` case.
- **D3 — `from: verdict` ↔ gate interaction (RESOLVED Q1: engine-owned).** Today a blocking verdict gate `markNodeFailed`s + `break`s **before** `:2868` (`runner-graph.ts:2555-2567`), so the verdict never reaches the outcome site. **The engine itself** treats the verdict-producing gate as **routing-input, not a hard-fail**, whenever the node declares `decide:{from:verdict}` — **no explicit `mode: advisory` is required from the author** (keeps the YAML clean). Its `calibrateVerdict` result feeds the `decide` table; the node always reaches `:2868` with the verdict; the table owns approve/review/rework. `confidence_min` **without** `decide` keeps today's blocking behavior; it is also expressible as a 2-case `decide:{from:verdict}` (sugar). Still the **highest-risk** seam → frozen in the Phase-0 spec and sequenced **after** `from: output` (T2.2 → T2.3).
- **D4 — `on_mismatch` = engine-initiated rework (RESOLVED Q4: `retry` sugar).** On structured-output validation failure (`runner-graph.ts:2512`, `!structuredOutput.ok`) AND `node.output.result.on_mismatch` present → drive the **rework path from a non-human node**, bounded by `rework.maxLoops`, with the validation-error text (`structuredOutput.reason`) injected via `commentsVar`. Node ids are **human-readable slugs (verified — not UUIDs)**, so two readable forms:
  - **`on_mismatch: retry`** — reserved literal = **self-target re-run** of the same node with the error fed back. Requires a `rework` block (for `maxLoops`/`commentsVar`/workspace/session policy) but **does NOT** require the node's own id in `transitions`/`rework.allowedTargets`. The readable common case.
  - **`on_mismatch: <outcome>`** — a transition outcome routed via `transitions[outcome]` to another node, which MUST be ∈ `rework.allowedTargets`.
  Default-absent → today's `CONFIG`-fail, unchanged. `retry` is special only inside `on_mismatch` (no collision with transition keys).
- **D5 — ADR-080 retry rejected for `on_mismatch`.** `CONFIG ∉ RETRYABLE_ERROR_CODES` and `scheduleAutoRetry` injects **no** error feedback. The rework machinery (feedback via `commentsVar` + `maxLoops` + workspace/session policy) is the only fit for **both** the `retry` self-target and the `<outcome>` redirect. Uniform path; no `scheduleAutoRetry` change.
- **D6 — P7 `run.json`.** New `buildRunContext(...)` **pure projection** of `node_attempts` + `gate_results` + `task.prompt` (reuse `reduceLedger`); `atomicWriteJson` to `<worktree>/.maister/run.json`; **(Q3)** `.maister/` git-excluded by **extending `WORKTREE_EXCLUDE_PATTERNS`** (`materialize.ts:29`), ensured **before** the first `run.json` write; `[Run context: <abs>]` pointer appended to each agent prompt (both session modes); rewritten at run start (intent) + after every `node_attempts` terminal transition; secret-safe (never from `context.env`). Idempotent & self-healing — correctness never depends on it.

---

## Number & namespace reservation (skill-context rule)
- **ADR-103** — "Output-driven dynamic routing (`decide`) + `on_mismatch` rework + engine 1.7.0". Write the `### ADR-103` header stub in `docs/decisions.md` in T0.1 **before** citing it.
- **ADR-104** — reserved for the sibling **Plan 2** (`2026-06-22-g4-guardrail-hooks.md`); do not squat.
- **Migration** — none. `0062` deliberately unused.
- **Engine version** — `1.6.0 → 1.7.0` is also a shared, append-only namespace; the `engine-version.ts` comment block gets one new line (T1.2).
- **Renumber pass** — budgeted as T6.3 (own focused step, after rebasing onto main): re-confirm ADR-103 free at main HEAD and that no migration crept in.

## Deployment touchpoints (skill-context rule)
**None.** No new env var (`MAISTER_NODE_OUTPUT_MAX_BYTES` already shipped with M26 and is already in `.env.example` + `docs/configuration.md`), no new sidecar, no bound port, no host-mounted file. `web` runs on the host (ADR-023) → no `compose.yml` change. This is explicitly asserted by the T6.2 grep gate (`git grep` shows no new env key, compose service, or port).

## Contract-surface → spec-file trace (skill-context rule)
| Surface that changes | Spec file(s) that must move in the same change |
| --- | --- |
| New Flow DSL node field `decide` (`from`, `cases`, `when`, `default`) | `docs/flow-dsl.md` + `web/lib/config.schema.ts` (`decideSchema`) |
| New Flow DSL field `output.result.on_mismatch` | `docs/flow-dsl.md` + `web/lib/config.schema.ts` (extend strict `result`) |
| Engine version `1.6.0 → 1.7.0` + new `engine_min` floor for `decide`/`on_mismatch` | `web/lib/flows/engine-version.ts` (const + comment) + `docs/flow-dsl.md` (compat note) |
| P7 `run.json` projection (Designed → Implemented) | `docs/system-analytics/flow-graph.md` (P7 section `:211-263` + Expectations `:486-496`) + the M26 spec |
| `decide` runtime seam + outcome computation + verdict-gate interaction | `docs/system-analytics/flow-graph.md` (new "Dynamic routing" subsection) |
| Studio decide-editor | `docs/screens/studio/editor.md` |
| ADR | `docs/decisions.md` ADR-103 (+ index entry) |
| **No** HTTP route, SSE/AsyncAPI event, `runs.status`/enum value, `MaisterError` code, DB column | T6.2 asserts each is absent |

## Outcome-consumer fan-out + allow-list guards (skill-context rule)
`decide` introduces **arbitrary new outcome strings** (today only `"success"` + human decisions exist). Every consumer of "outcome" must be audited:

| Consumer | What to verify |
| --- | --- |
| Outcome site `runner-graph.ts:2868` | `decide` eval replaces `"success"` only when `node.decide` present; else unchanged. |
| `resolveTransition` `compile.ts:137` | unchanged — already maps any outcome string → target/terminal. |
| Review-readiness guard `runner-graph.ts:2890` | a `decide` outcome with no transition → null → terminal/Review (verify behaves as intended, not a silent dead-end). |
| Loop-advance `runner-graph.ts:3287` | advances on the `decide`-chosen outcome. |
| `isRework` `runner-graph.ts:2873` | a `decide` outcome whose target ∈ `rework.allowedTargets` correctly triggers rework. |
| `maxLoops` backstops `:1966`, `:2917` | `decide`/`on_mismatch` loops are bounded. |
| `edge-style.ts` + Studio canvas | new outcome strings get an edge style/role. |

**Allow-list, not deny-list:** the runtime guard (T2.4) is `chosen outcome ∈ declared transitions keys` (allow-list) → `CONFIG` otherwise. Compile-time (T1.4): every **producible** `decide` outcome ⊆ `transitions` keys; exactly one `default`; `on_mismatch` ⊆ `rework.allowedTargets`. A `decide` config that could emit an outcome with no transition fails to compile.

## Atomicity & crash-window analysis (skill-context rule)
- **`on_mismatch` rework** reuses the **existing** human-rework write sequence (`markNodeReworked` → `markDownstreamStale` → `pendingInjectedVars`), which is **not** a single transaction today and is the established contract. Per surgical-changes, this plan **does not** refactor that sequence into a transaction (untouched code, separate concern). It **does** assert that the new non-human trigger introduces **no new partial state** beyond human-triggered rework: same writes, same order, run stays `Running`, recovery profile identical. Documented in the ADR; a test asserts a crash between `markNodeReworked` and `markDownstreamStale` leaves the same recoverable state as a human rework.
- **P7 `run.json` write** is a **pure projection** (no DB write, idempotent, self-healing). A crash mid-write leaves a stale/absent `run.json` that the next terminal transition regenerates; **run correctness never depends on it** (ledger + worktree are the source of truth). No two-phase commit needed; `atomicWriteJson` already does tmp+rename so no torn file.
- **No new deferreds.** The structured-output seam runs after `end_turn` (`result.ok`), at which point `sendPrompt` has drained every permission deferred (per M26 spec) — `on_mismatch` here leaks nothing. The rework path creates no ACP deferred.

## Test-runnability & per-phase green (skill-context rule)
- Every promised test names its runner project: `web` unit/integration via `vitest` (`renderToStaticMarkup`, `.test.ts` globs — project convention), supervisor `vitest`, e2e `playwright` (`web/e2e/*.spec.ts`).
- Each phase exit criterion = **full suite green** for the touched project(s).
- **Assertion migration is in-scope, not a follow-up.** Existing tests that assert outcome/routing/rework behavior and must be re-checked for byte-identical back-compat: `web/lib/flows/graph/__tests__/*` (runner-graph routing + rework integration), `web/lib/flows/__tests__/compile*.test.ts` (transition resolution), `web/lib/flows/editor/__tests__/{editor-state,node-form,validation}.test.ts`, `web/components/flows/node-form/__tests__/node-side-form.test.ts`, `web/lib/flows/__tests__/context*.test.ts` (`reduceLedger`). The Phase-2 back-compat task (T2.1/AC-backcompat) enumerates the exact files at implementation time.

---

## Commit Plan
- **Commit 1** (after T0.1–T0.6): `docs(routing): SDD freeze — ADR-103, M26 spec extension (decide/on_mismatch/P7), flow-dsl + flow-graph + studio editor design, M38`
- **Commit 2** (after T1.1–T1.4): `feat(flows): decide/on_mismatch schema + when-grammar parser + compile-time verification + engine 1.7.0`
- **Commit 3** (after T2.1–T2.4): `feat(flows): runtime decide routing (from output, from verdict) + back-compat + allow-list guard`
- **Commit 4** (after T3.1–T3.4): `feat(flows): on_mismatch engine-initiated rework with error-feedback injection, maxLoops-bounded`
- **Commit 5** (after T4.1–T4.4): `feat(flows): P7 run-context blackboard (buildRunContext, atomic write, .maister exclude, prompt pointer)`
- **Commit 6** (after T5.1–T5.5): `feat(studio): decide-table node editor + verdict edge rendering + i18n`
- **Commit 7** (after T6.1–T6.3): `test(flows): e2e routing/rework/run-context + verify gate + renumber pass`

---

## Tasks

### Phase 0 — SDD & design freeze (docs-first; complete + internally consistent BEFORE any code)
- [x] **T0.1 — Reserve numbers (M38 already registered).** Write `### ADR-103` header stub in `docs/decisions.md` (one-line title, status Designed). Note ADR-104 reserved for the g4 plan. Confirm no migration (`0062` unused). **M38 was already added to `.ai-factory/ROADMAP.md` during the 2026-06-22 /aif-improve pass — verify the entry stays consistent with the final design, do not re-add.** LOG: n/a (docs). Files: `docs/decisions.md` (+ verify `.ai-factory/ROADMAP.md`).
- [x] **T0.2 — Extend the frozen M26 spec.** In `.ai-factory/specs/feature-m26-structured-output-run-context.md`: flip the P7 section `Designed → Implemented`; add the **P4 `decide`** contract (D1 applicability, D2 outcome hook, D3 verdict-gate interaction), the **`on_mismatch`** contract (D4), engine `1.7.0`, and the verifiability rules (compile + runtime). Internally consistent (every described piece tagged Implemented/Designed correctly). Files: the spec.
- [x] **T0.3 — Write ADR-103.** Decision, alternatives (incl. D5 ADR-080-retry rejection rationale), consequences, engine `1.7.0`, back-compat contract, crash-window-parity note. Update `docs/decisions.md` index. Files: `docs/decisions.md`.
- [x] **T0.4 — Studio decide-editor UI design.** Update `docs/screens/studio/editor.md`: decide sub-panel (source select · cases table · default · `on_mismatch`→target), plain-routing renders single labeled edge, conditional renders a decision table on the node + outcome-labeled edges. Follow `web/CLAUDE.md` UI-affordance conventions. Files: `docs/screens/studio/editor.md`.
- [x] **T0.5 — Update DSL + domain docs.** `docs/flow-dsl.md` (`decide`/`on_mismatch`/`when`-grammar/`compat.engine_min: 1.7.0`); `docs/system-analytics/flow-graph.md` (new "Dynamic routing" subsection at the outcome seam + flip P7 to Implemented at `:211` & `:486`); `docs/configuration.md` (confirm no new env var — note only). Files: those three docs.
- [x] **T0.6 — Phase-0 consistency gate.** Verify the contract-surface trace table is complete, ADR anchor resolves (`scripts/validate-docs-adr-anchors.mjs`), `pnpm validate:docs` (Mermaid) green, all implementation-status tags correct. EXIT: no spec section describes code that will not exist at the phase HEAD.

### Phase 1 — Schema + compile-time verification (RED → GREEN → refactor)
- [x] **T1.1 — RED: schema + engine-gate tests.** Failing tests: `decideSchema` accepts `{from: "output.<dotpath>"}` (incl. nested `output.a.b`) and `{from: "verdict", cases:[…]}` with exactly-one-`default`; rejects two defaults / cases-on-output / a malformed `from` dot-path / unknown keys; `output.result.on_mismatch` accepts the literal `"retry"` AND any other string on the strict sub-object; a manifest with `decide` or `on_mismatch` and `engine_min < 1.7.0` is rejected (`CONFIG`), `>= 1.7.0` accepted; a manifest with neither stays valid at its old floor. Files: `web/lib/__tests__/config.schema*.test.ts`, `web/lib/flows/__tests__/engine-version.test.ts`.
- [x] **T1.2 — Schema + engine bump (GREEN).** Add `decideSchema` to `web/lib/config.schema.ts` (node-level per D1): `from` = `verdict` OR `^output\.<dotpath>$` (dotpath = `seg(.seg)*`, `seg = [A-Za-z_][A-Za-z0-9_]*`); optional `cases` (verdict). Extend the strict `output.result` with `on_mismatch: z.union([z.literal("retry"), z.string().min(1)]).optional()` (literal `retry` = self-target sugar; any other string = a transition outcome). Bump `MAISTER_ENGINE_VERSION "1.6.0" → "1.7.0"` + the comment line in `web/lib/flows/engine-version.ts`; add the `decide`/`on_mismatch` `engine_min` floor const + the `validateGraphManifest` gate (mirror `OUTPUT_ENGINE_MIN`). LOG: DEBUG on engine-gate accept/reject with declared vs required. Files: `config.schema.ts`, `engine-version.ts`, `web/lib/config.ts`.
- [x] **T1.3 — `when` parser + shared nested getter (RED → GREEN).** Pure module `web/lib/flows/graph/when-grammar.ts`: parse `"<field> <op> <number>"`, ops `>= > <= < == !=`; `<field>` may be a **nested dot-path** (e.g. `verdict.confidence`) resolved by a shared safe getter `getPath(obj, dotpath)` (missing → `undefined`, never throws) that **D2's `from: output.<path>` reuses**; export `parseWhen(s): Predicate | error`, `evalWhen(pred, ctx): boolean`, `getPath`. Unit tests: every op, whitespace tolerance, malformed → typed error, missing/nested-missing field → no-match (never throw). LOG: DEBUG on parse + on eval (field, op, rhs, lhs, result). Files: `when-grammar.ts` + its `__tests__`.
- [x] **T1.4 — Compile-time verification (RED → GREEN).** In `web/lib/flows/graph/compile.ts`: (a) `from: verdict` — every `case.outcome` ⊆ `node.transitions` keys, exactly one `case.default`, each `when` parses; (b) `from: output.<path>` — validate **only the `from` dot-path syntax** (the value set is data-dependent → enforced at runtime by the T2.4 allow-list guard; note this in the spec); (c) `on_mismatch: retry` → require a `rework` block (NOT the node's own id in `allowedTargets`); `on_mismatch: <outcome>` → require `transitions[outcome]` ∈ `rework.allowedTargets` AND `rework` declared. Each violation → `MaisterError("CONFIG")` at compile/load. RED test per refusal. LOG: DEBUG listing produced-outcome set vs transition keys. Files: `compile.ts` + `__tests__/compile*.test.ts`. EXIT: full `web` unit suite green.

### Phase 2 — Runtime decide routing (from: output first, then from: verdict)
- [x] **T2.1 — RED: runtime routing + back-compat tests.** Failing integration/unit: (a) `from: output.<path>` → the nested-resolved value drives the branch (incl. a nested `output.a.b`); (b) `from: verdict` → first `when`-match else `default` drives the branch; (c) `confidence_min`-as-`decide` sugar selects the same branch a legacy `confidence_min` would; (d) **back-compat**: a flow with no `decide` produces a byte-identical run (outcome `"success"`/human decision) — enumerate the exact existing test files re-asserted; (e) strict-templating: an absent optional var routes via the `default` case and never throws mid-route. Files: `web/lib/flows/graph/__tests__/runner-graph*routing*.test.ts` (new), plus the enumerated regressions.
- [x] **T2.2 — decide eval at the outcome site, `from: output` (GREEN).** At `runner-graph.ts:2868`: if `node.decide?.from` starts with `output.`, resolve `outcome = String(getPath(vars, <dotpath>))` via the shared safe getter (T1.3); `undefined`/missing → no transition (terminal/Review, surfaced by the T2.4 guard); else today's logic. LOG: DEBUG `{nodeId, from, dotpath, resolvedValue, chosenOutcome}`. Files: `runner-graph.ts`.
- [x] **T2.3 — decide eval, `from: verdict` + engine-owned gate interaction (GREEN, D3).** **The engine** makes the verdict-producing gate routing-input (not hard-fail) when `node.decide?.from === "verdict"` — **no author-declared `mode: advisory`**: the `calibrateVerdict` result reaches `:2868`; evaluate `cases` via `evalWhen` against the verdict object (nested fields allowed via `getPath`); pick first match else `default`. Keep `confidence_min`-only (no `decide`) blocking behavior intact. LOG: DEBUG `{nodeId, confidence, matchedCase|default, chosenOutcome}`. Files: `runner-graph.ts`, `gates-exec.ts` (engine-owned gate-routing-input branch).
- [x] **T2.4 — Runtime allow-list guard (GREEN).** After `decide` picks an outcome, assert it ∈ `node.transitions` keys (defense-in-depth beyond compile-time); else `MaisterError("CONFIG")`. LOG: WARN on guard hit. Files: `runner-graph.ts`. EXIT: routing + back-compat tests green; full `web` unit+integration green.

### Phase 3 — `on_mismatch` → engine-initiated rework (RED → GREEN → refactor)
- [x] **T3.1 — RED: on_mismatch tests.** Failing: (a) `on_mismatch: retry` re-runs the **same node** (self-target) with `structuredOutput.reason` text in `commentsVar`, no own-id in `transitions`/`allowedTargets` needed; (b) `on_mismatch: <outcome>` routes to `transitions[outcome]` (∈ `allowedTargets`); both bounded by `maxLoops`; (c) **default-absent** (no `on_mismatch`) still `CONFIG`-fails (regression); (d) `maxLoops` exhaustion behaves like human-rework exhaustion (`fail`/`escalate`/`ship_with_warning` per execution policy); (e) crash-parity: state after `markNodeReworked` (pre-`markDownstreamStale`) matches a human rework. Files: `web/lib/flows/graph/__tests__/runner-graph*onmismatch*.test.ts` (new).
- [x] **T3.2 — Engine-initiated rework trigger (GREEN, D4).** At `runner-graph.ts:2512` (`!structuredOutput.ok`): if `node.output.result.on_mismatch` present → set the rework path (reuse `markNodeReworked` + `markDownstreamStale`): for `retry` the target = the **current node** (self re-run); for any other value the target = `transitions[on_mismatch]`. Else today's `failed=true; runErrorCode="CONFIG"; break`. Guard: `on_mismatch` requires `rework` (compile-enforced; re-assert defensively). LOG: DEBUG `{nodeId, reason, on_mismatch, target, attempt}`. Files: `runner-graph.ts`, `node-output.ts` (already returns `{ok:false, reason}`).
- [x] **T3.3 — Error-feedback injection (GREEN).** Inject `structuredOutput.reason` into `pendingInjectedVars[commentsVar]` (reuse the `:3207-3235` channel) so the reworked node's agent prompt renders the validation error as the fix instruction. LOG: DEBUG on injection. Files: `runner-graph.ts`.
- [x] **T3.4 — maxLoops bound for on_mismatch (GREEN/refactor).** Verify the `:1966` loop-top backstop + `:2917` decision-validation count `on_mismatch` attempts and terminate per execution policy; add a test that an infinite-mismatch node halts at `maxLoops`. LOG: WARN on bound hit. Files: `runner-graph.ts`. EXIT: on_mismatch + default-absent regression green; full suite green.

### Phase 4 — P7 run-context blackboard (RED → GREEN)
- [x] **T4.1 — RED: run.json tests.** Failing: shape `{intent, nodes{summary,vars}, gates{status,verdict?}, promoted}`; `promoted` flat union last-wins by `reduceLedger` node-iteration order; idempotent regen byte-identical; **secret-safety** (no `context.env` value present); worktree location `<wt>/.maister/run.json` + `.maister/` git-excluded (clean `git status`, absent from base→run diff); prompt pointer present in **both** `new-session` and `slash-in-existing`. Files: `web/lib/flows/__tests__/run-context*.test.ts` (new unit + integration).
- [x] **T4.2 — `buildRunContext` projection (GREEN).** New `web/lib/flows/run-context.ts`: pure projection from `node_attempts` + `gate_results` + `task.prompt` (reuse `reduceLedger` for nodes; `promoted` = flat vars union, last-wins by node-iteration order per M26 spec; gates `{status, verdict?}` with `status` always present). No `context.env` read. LOG: DEBUG node/gate counts. Files: `run-context.ts` + tests.
- [x] **T4.3 — Writer + git-exclude (GREEN, Q3 locked).** `atomicWriteJson` to `<worktreePath>/.maister/run.json` at run start (intent-only) and after every `node_attempts` terminal transition (`markNodeSucceeded`/`markNodeFailed`/`markNodeReworked`). **Git-exclude: add `.maister/` to `WORKTREE_EXCLUDE_PATTERNS` (`web/lib/capabilities/materialize.ts:29`)** — locked, not the runner-side variant. **Ordering invariant:** the exclude MUST be in place before the first `run.json` write — verify capability materialization runs before run-start for every flow run; if that ordering is not guaranteed, the runner idempotently re-ensures the exclude at run start. RED test: a flow run leaves `run.json` absent from `git status`. LOG: DEBUG on write + path; DEBUG on exclude-ensure. Files: `runner-graph.ts` (+ `ledger.ts` hook points), `materialize.ts`.
- [x] **T4.4 — Prompt pointer (GREEN).** Append `[Run context: <abs run.json path>]` to each agent node's resolved prompt after `renderStrict`, before dispatch, in both session modes. LOG: DEBUG on pointer attach. Files: `runner-graph.ts` (agent dispatch path) / `runner-agent.ts`. EXIT: P7 tests green; secret-safety + git-clean integration green; full suite green.

### Phase 5 — Flow Studio UI (decide editor + edges + i18n)
- [x] **T5.1 — RED: editor tests.** Failing: `node-side-form.test.ts` — a node fixture (judge + `decide:{from:verdict}`, and an `ai_coding` + `decide:{from:output.x}`) renders `data-testid="node-decide-*"` (source select, cases rows, default, `on_mismatch`); `node-form.test.ts` — `validateDecideDraft` valid/invalid; `validation.test.ts` — a decide issue maps to the right `nodeId`. Files: those three `__tests__`.
- [x] **T5.2 — DecideForm section (GREEN).** New section in `web/components/flows/node-form/node-side-form.tsx`, gated on "node has `output.result` OR a verdict gate": source select (`output` → a nested-dot-path text field; `verdict`), **cases table** (ordered array of `{when, target}` rows with add/remove — mirror the transitions table `:524-587` but array-modeled like gates), `default` target field, and an **`on_mismatch` control offering `retry` (self) or a transition outcome → target**. `replaceNode` (`editor-state.ts:202`) already round-trips arbitrary node fields (passthrough). LOG: n/a (client form). Files: `node-side-form.tsx`.
- [x] **T5.3 — Editor validation (GREEN).** Add `blankDecide` + `validateDecideDraft` to `web/lib/flows/editor/node-form.ts` (mirror `blankGate`/`validateGateDraft`); wire into `validateEditorManifest` (`editor/validation.ts:30`) mapping issues to `nodeId`. Files: `node-form.ts`, `validation.ts`.
- [x] **T5.4 — Edge rendering (GREEN).** Extend `web/lib/flows/edge-style.ts` so verdict/decide outcomes get a style/role (new bucket or generalize the existing `BACK_EDGE_KEYS`/`FAILURE_KEYS`); render conditional nodes with a small decision table + outcome-labeled edges in both the read-only viewer (`flow-graph-view.tsx:449` `makeFlowEdgeView`) and the editor canvas (`flow-graph-editor.tsx` `toEditorEdges`). Plain routing edge unchanged. Files: `edge-style.ts`, `flow-graph-view.tsx`, `flow-graph-editor.tsx`.
- [x] **T5.5 — i18n (GREEN).** Add `flowEditor.nodeForm.decide*` keys to `web/messages/en.json` + `web/messages/ru.json` (parity), wire in `web/lib/flows/node-side-form-labels.ts` (`buildNodeSideFormLabels`) + the `NodeSideFormLabels` type. Files: `en.json`, `ru.json`, `node-side-form-labels.ts`, `node-side-form.tsx`. EXIT: Studio unit tests green; i18n key parity; `eslint` 0.

### Phase 6 — E2E + verify gate + renumber pass
- [ ] **T6.1 — Playwright e2e.** Happy: a flow with `decide:{from:output.outcome}` routes to the declared branch and `run.json` is present + pointer in prompt. Negative: an output-mismatch node with `on_mismatch` enters bounded rework (visible in run detail); a node **without** `on_mismatch` surfaces `CONFIG`-fail and does NOT promote. Files: `web/e2e/m38-decide-routing.spec.ts` (new); confirm the spec is in the playwright `include` set. NOTE: Next 16 single-dev lock — free `:3000` before running e2e (a `next dev` on the main checkout blocks the e2e webServer).
- [ ] **T6.2 — Repo-level verify gate.** `git grep` assertions: no new migration file, no new HTTP route, no new `runs.status`/enum value, no new `MaisterError` code, no new env key/compose service; `MAISTER_ENGINE_VERSION === "1.7.0"`; ADR-103 anchor resolves (`scripts/validate-docs-adr-anchors.mjs`). Wire into the `/aif-verify` checklist. Files: verify script/checklist.
- [ ] **T6.3 — Renumber pass (after rebase onto main).** Re-confirm ADR-103 still free at main HEAD (else renumber `decisions.md` + every citation, grep-to-zero on the OLD number across active docs/specs/plans), and that no migration crept in. Budgeted as its own focused step per the parallel-branch rule. EXIT: full suite green (unit+integration+e2e), docs + ADR-anchor gates green, byte-identical back-compat regression green.

---

## Resolved questions (owner answers, 2026-06-22 /aif-improve)
1. **D3 — verdict-gate routing-input** — ✅ **движок сам** делает гейт routing-input при `decide:{from:verdict}`; явный `mode: advisory` НЕ требуется (YAML чище). Заморозить точную семантику в T0.2.
2. **`from: output.<path>`** — ✅ **вложенный dot-path** (погибче), не только top-level. Общий safe-getter `getPath` (T1.3), переиспользуется в `when`.
3. **`.maister` git-exclude** — ✅ **расширить `WORKTREE_EXCLUDE_PATTERNS`**; инвариант порядка (exclude до первого write `run.json`) зафиксирован в T4.3.
4. **`on_mismatch` self-target** — ✅ node id = читаемый slug (НЕ UUID, проверено), но сахар **`on_mismatch: retry`** всё равно читается чище для self-повтора → добавлен; `on_mismatch: <outcome>` — для редиректа на другой узел через `transitions`. См. D4.
5. **M38** — ✅ **создан** в `.ai-factory/ROADMAP.md` в этом /aif-improve проходе; T0.1 теперь только сверяет запись, не добавляет заново.

## Remaining open questions
Нет — все 5 вопросов плана закрыты. Перед кодом остаётся обычный SDD-фриз (Phase 0): заморозить точные тексты схемы `decideSchema`, грамматики `when` и контракта `from:verdict`-гейта в spec/ADR.
