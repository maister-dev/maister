# Flow rework loop: `onExhaustion` routing + human-driven counter reset

**Branch:** `feature/flow-rework-reset-loop`
**Created:** 2026-06-29 · **Refined (SDD/TDD):** 2026-06-29
**Type:** feature (flow-graph engine) · **Target repo:** `/repos/mAIster`

## Settings

- **Testing:** yes — TDD (RED → GREEN → refactor); failing-first checkpoint per behavior unit.
- **Logging:** verbose (DEBUG on every new routing/reset branch).
- **Docs:** yes — mandatory checkpoint (ADR + flow-dsl + flow-graph + execution-policy + database-schema).
- **Method:** SDD — the §Specifications below are authored FIRST and are the single source of truth; code follows them.

## Goal

Let a bounded auto fix↔verify↔review loop **escalate to a human deterministically**
on `maxLoops` exhaustion, and let that human **restart the loop with a fresh
budget** by re-entering it with an extra prompt — bounded, no engine-policy
dependency, ADR-041 untouched.

Two new optional `rework` fields:

1. **`rework.onExhaustion: <outcome>`** (loop-owning judge/ai_coding node) — on
   effective-attempt exhaustion, route via `transitions[<outcome>]` to a human
   node INSTEAD of the execution-policy **A1 `reworkExhaustion`** action.
2. **`rework.resetTargets: [<nodeId>...]`** (human node) — a human rework decision
   re-baselines each listed loop node's attempt counter → fresh `maxLoops` budget.

---

## Specifications (SSOT — authored first)

### S1. Engine version & floor

- `MAISTER_ENGINE_VERSION` `2.0.0 → 2.1.0` (`web/lib/flows/engine-version.ts:35` + changelog line).
- `REWORK_RESET_ENGINE_MIN = "2.1.0"` (`web/lib/config.ts`, next to `DECIDE_ENGINE_MIN:593`).
- A flow whose ANY node's `rework` declares `onExhaustion` or `resetTargets` requires
  `compat.engine_min >= 2.1.0`; else `loadFlowManifest` (gate ~lines 913-933) throws
  `MaisterError("CONFIG")`. Mirrors `declaresDecideOrOnMismatch`.

### S2. DSL schema (`web/lib/config.schema.ts` `reworkSchema` 580-589)

```yaml
rework:
  allowedTargets: [<nodeId>...]      # existing
  workspacePolicies: [...]           # existing
  maxLoops: <int > 0>                # existing
  commentsVar: <string>?             # existing
  session_policy: resume|new_session # existing
  onExhaustion: <outcome>?           # NEW — a transitions key (string, min 1)
  resetTargets: [<nodeId>...]?       # NEW — array(string min 1).min(1)
```

- `onExhaustion: z.string().min(1).optional()`
- `resetTargets: z.array(z.string().min(1)).min(1).optional()`

### S3. Compile-time validation (`compile.ts`, mirror `verifyDecideAndOnMismatch` 133-233; wire at compileGraph:283)

A node is invalid (`MaisterError("CONFIG")`) when:
- `onExhaustion` present AND (`rework` absent OR `onExhaustion ∉ Object.keys(transitions)`).
- `resetTargets` present AND `rework` absent.
- any `resetTargets[i]` ∉ graph node ids.
- any `resetTargets[i]` is not itself a rework-loop node (target node has no `rework` block).
- any `resetTargets[i]` is not reachable from this human node via its `rework.allowedTargets`
  transitive forward chain (a reset must target a loop the rework re-enters).
- (engine floor handled in `config.ts`, not here — same split as decide.)

### S4. DB — `node_attempts.rework_baseline` (migration 0085)

- DDL: `ALTER TABLE "node_attempts" ADD COLUMN "rework_baseline" integer;` (nullable, no default).
- Schema: `reworkBaseline: integer("rework_baseline")` in `node_attempts` pgTable (`db/schema.ts:1981`).
- **Semantics:** `NULL ⇒ baseline 0` (byte-identical to today). The value is the
  attempt number at which the node's CURRENT rework epoch began.
- **Carry-forward (write):** `appendNodeAttempt` (`ledger.ts:72`) stamps the new row's
  `rework_baseline` = the node's prior attempt's `rework_baseline` (or `NULL`/0 if none).
- **Reset (write):** `UPDATE node_attempts SET rework_baseline = <current persisted
  attempt count for that node> WHERE id = <latest attempt row id of that node>`. The
  next `appendNodeAttempt` carries that value forward.
- **Effective count (read):** `effective = nodeAttemptNumber - (baseline ?? 0)`.
- Generated via `pnpm db:generate`; `pnpm db:check` (journal-ordering guard).

### S5. Runtime — exhaustion is baseline-aware at BOTH sites

- Loop-top backstop (`runner-graph.ts:2118-2127`): `(nodeAttemptCount - baseline) > maxLoops`.
- Decision-time (`runner-graph.ts:3315`): `(nodeAttemptNumber - baseline) > maxLoops`.
- `baseline` read from the node's latest attempt row (helper near `latestAttemptForNode:220`).

### S6. Runtime — `onExhaustion` routing (decision-time site)

- When `isRework && effective > maxLoops`:
  - `node.rework.onExhaustion` SET → route via `transitions[onExhaustion]` through the
    UNCHANGED `resolveTransition` + staleness/transition fan-out; do NOT call
    `reworkExhaustionFromSnapshot`. Runtime allow-list guard: outcome ∈ transitions keys
    (defense in depth, `CONFIG` otherwise).
  - `node.rework.onExhaustion` ABSENT → existing A1 branch
    (`fail`/`escalate`/`ship_with_warning`) **byte-identical**.
- `onExhaustion` is a routing transition (typically to a human node); it is NOT itself a
  rework jump, so it does not stale or increment the loop node further.

### S7. Runtime — `resetTargets` re-baseline (human-node rework, atomic)

- Trigger: a `human` node finishes with a **rework** decision AND `node.rework.resetTargets`
  is set (human response path ~`runner-graph.ts:3590-3660`).
- In the SAME `db.transaction` as `markNodeReworked` (human node) + `markDownstreamStale`:
  for EACH target node id, `UPDATE` its latest attempt row's `rework_baseline` to that
  node's current persisted attempt count. The human's comment rides the existing
  `commentsVar → pendingInjectedVars` channel into the re-entered loop.
- If a target has zero prior attempts → no-op (its epoch already starts at 0).

### S8. Bounding & the two `maxLoops` (logical-hole closure)

- Loop node `maxLoops` bounds iterations **per round**.
- The human node's OWN `rework.maxLoops` bounds the number of **reset rounds** (each
  human rework is a visit to the human node → its `gateAttempt` increments).
- The human node's own exhaustion uses the STANDARD A1 path (it IS a human node, so
  `runReviewHuman` has non-empty `finishHuman.decisions`) → default `escalate` re-pauses
  it ("rounds spent — approve or end"). No recursion, naturally bounded.
- HITL wire contract UNCHANGED: the human node's HITL already carries
  `{allowedDecisions, transitions, reworkTargets, workspacePolicies, maxLoops, gateAttempt}`
  (hitl.md:273-290). `resetTargets` is server-side, not a reviewer choice → no new field.

### S9. Acceptance criteria (testable)

- **AC-1** A flow with `onExhaustion`/`resetTargets` and `engine_min < 2.1.0` → load fails `CONFIG`; `>= 2.1.0` loads.
- **AC-2** `onExhaustion ∉ transitions` OR without `rework` → compile `CONFIG`.
- **AC-3** `resetTargets` with unknown id / non-loop node / unreachable target / without `rework` → compile `CONFIG`.
- **AC-4** `rework_baseline` NULL behaves as 0: a flow using neither field produces a byte-identical attempt ledger + identical exhaustion behavior vs `main` (back-compat).
- **AC-5** A loop node with `onExhaustion: X` reaching `effective > maxLoops` routes to `transitions[X]` (a human node) that opens a usable HITL (`allowedDecisions` non-empty) — NOT a `CONFIG` fail and NOT an A1-escalate on the loop node itself.
- **AC-6** Without `onExhaustion`, exhaustion is byte-identical to today's A1 (`fail`/`escalate`/`ship_with_warning`) per the run's policy.
- **AC-7** After a human rework with `resetTargets: [L]`, node `L` runs a FULL fresh `maxLoops` budget again (an attempt count beyond the original cap occurs without `CONFIG`), and the human comment is present in `L`'s next resolved prompt.
- **AC-8** WITHOUT `resetTargets`, a human rework after exhaustion re-exhausts immediately (documents the contrast).
- **AC-9** The reset write + `markNodeReworked` + `markDownstreamStale` commit in ONE transaction (no partial-state crash window; a crash after commit is recovered because the next `appendNodeAttempt` reads the persisted baseline).
- **AC-10** `effective = nodeAttemptNumber - (baseline ?? 0)` holds at BOTH the loop-top backstop and the decision-time check (no off-by-one; total allowed = `maxLoops + 1`).

---

## Decisions

- **D1** Baseline storage: column `node_attempts.rework_baseline` (chosen over jsonb-on-runs — normalized, per-node, on the ledger that already owns attempt counting).
- **D2** `onExhaustion` handled at decision-time (S6); loop-top backstop made baseline-aware as defense-in-depth.
- **D3** `onExhaustion` is a distinct transition outcome (e.g. `exhausted`), not reuse of `success`/`commit`, so the human node can render exhaustion context.
- **D4** Engine bump 2.1.0 (additive, backward compatible).
- **D5** Reserved numbers (vs main HEAD): **ADR-118** (max=117), **migration 0085** (max idx 84). Re-check at merge (parallel-branch hazard).
- **D6** Out of scope (edited directly in `maister-plugins`, no plan): `aif/flows/dev/flow.yaml` rewrite + `aif-review/SKILL.md` native `maister:output`.

## Contract surfaces → spec file (skill-context trace rule)

| Surface | Spec file |
| ------- | --------- |
| `rework.onExhaustion` / `rework.resetTargets` DSL | `docs/flow-dsl.md` + `web/lib/config.schema.ts` |
| Routing/Expectations + A1 interaction | `docs/system-analytics/flow-graph.md` + `docs/system-analytics/execution-policy.md` |
| `node_attempts.rework_baseline` | migration 0085 + `docs/database-schema.md` + `docs/system-analytics/flow-graph.md` ERD |
| Engine-version floor | `web/lib/flows/engine-version.ts` + `web/lib/config.ts` |
| HITL wire | **No change** (S8 justification) — note explicitly in `hitl.md` that `resetTargets` is server-side. |
| New ADR | `docs/decisions.md` ADR-118 |

No new env var / port / sidecar / compose touchpoint (deployment rule N/A).

---

## Tasks (TDD; RED → GREEN → refactor)

### Phase 0 — Specs SSOT (docs-first; reserve numbers)

1. **ADR-118 + number reservation.** `### ADR-118` header + table row + body (S1–S8,
   A1 interaction, rejected jsonb-on-runs) in `docs/decisions.md`. Confirm 0085 next free
   in `_journal.json`. AC: ADR anchor resolves; `INFO [adr] reserved ADR-118`.
2. **Spec docs + acceptance criteria.** Author S2–S9 into the contract files: `flow-dsl.md`
   (§rework new fields, examples, validation, floor — tag `(Designed)` now), `flow-graph.md`
   (onExhaustion routing + baseline-aware counting + Expectations bullets mapping AC-1..10 +
   `rework_baseline` in node_attempts ERD/index table), `execution-policy.md` (onExhaustion
   overrides A1 when present), `database-schema.md` (column row + 0085 anchor), `hitl.md`
   (one line: `resetTargets` server-side, no wire change). Run `pnpm validate:docs:all`.

### Phase 1 — Schema + floor + version (RED → GREEN)

3. **RED: schema/floor unit tests.** In `web/lib/__tests__/config.schema.decide.test.ts`
   (or sibling `config.schema.rework-reset.test.ts`, **project: unit**) write FAILING tests:
   reworkSchema accepts the two new fields + rejects malformed; `loadFlowManifest` over a
   tempdir YAML fails `CONFIG` below 2.1.0 and passes at 2.1.0 (AC-1). Update version
   assertions `config-schema-artifacts.test.ts:11` + `engine-version.test.ts` → `2.1.0` (RED until bump).
4. **GREEN: schema + floor + version.** `config.schema.ts` reworkSchema fields (S2);
   `engine-version.ts` bump 2.0.0→2.1.0 + changelog; `config.ts` `REWORK_RESET_ENGINE_MIN`
   + `declaresReworkResetOrOnExhaustion` + `loadFlowManifest` gate. Verbose
   `DEBUG [engine-floor] rework-reset gate`. Make Phase-1 tests green.

### Phase 2 — Compile validation (RED → GREEN)

5. **RED: compile tests.** `web/lib/flows/graph/__tests__/compile-rework-reset.test.ts`
   (**project: unit**), inline fixtures at `engine_min: "2.1.0"`: AC-2 (onExhaustion ∉
   transitions; without rework), AC-3 (resetTargets unknown id / non-loop node / unreachable
   / without rework), plus one VALID compile. Failing first.
6. **GREEN: verifyReworkReset.** Add validator in `compile.ts` (S3), wire into `compileGraph`
   (next to line 283). Confirm `CompiledNode.rework` threads the new fields (no new type). Green.

### Phase 3 — Migration (GREEN-only; schema change)

7. **node_attempts.rework_baseline + 0085.** Add column to `db/schema.ts:1981`; `pnpm db:generate`
   → `0085_*.sql` (S4 DDL) + snapshot + `_journal.json`; `pnpm db:check`. Commit generated artifacts.
   (No RED — pure schema; covered by integration tests in P4/P5 against real PG.)

### Phase 4 — Baseline-aware exhaustion + `onExhaustion` (RED → GREEN → refactor)

8. **RED: baseline math unit + onExhaustion integration.** Unit (**project: unit**): a pure
   `effectiveAttempts(attemptNumber, baseline)` helper — AC-10 boundary (`maxLoops+1`, null⇒0).
   Integration (**project: integration**, real-PG, model
   `runner-graph-decide-routing.integration.test.ts`): AC-5 (onExhaustion → human HITL with
   non-empty decisions) + AC-6 (absent → A1 byte-identical). Failing first.
9. **GREEN: implement.** `ledger.ts` carry-forward in `appendNodeAttempt` + baseline reader;
   `runner-graph.ts` baseline-subtract at 2118-2127 AND 3315; onExhaustion routing branch (S6)
   with allow-list guard. Verbose `INFO [rework.onExhaustion] <node> -> <target>`. Refactor the
   shared effective-count into the helper (DRY). Green.

### Phase 5 — `resetTargets` re-baseline (RED → GREEN)

10. **RED: reset integration tests.** Real-PG (**project: integration**): AC-7 (exhaust →
    onExhaustion → human_final → rework `resetTargets:[L]` + comment → L runs FRESH maxLoops,
    comment in next prompt), AC-8 (no resetTargets → re-exhausts), AC-9 (single-transaction:
    assert atomic write set). Failing first.
11. **GREEN: implement.** Human-node rework path (`runner-graph.ts:~3590-3660`): same-tx
    multi-target re-baseline UPDATE (S7) alongside `markNodeReworked` + `markDownstreamStale`.
    Enumerate crash windows in the commit/PR body (multi-store rule). Verbose per reset. Green.

### Phase 6 — Back-compat + full green

12. **Suite green + regression.** AC-4 byte-identical for neither-field flows (existing
    decide/on_mismatch/flow-graph tests stay green). Gates (each a phase-exit): `pnpm typecheck`,
    `pnpm test:unit`, `pnpm test:integration` (real PG), `pnpm validate:docs:all`,
    `pnpm exec eslint` (check-only — NEVER `lint`/`--fix`, rewrites drift repo-wide).
    Flip doc status tags Designed → Implemented.

## Commit Plan

- After P0: `docs(flow): ADR-118 + rework onExhaustion/resetTargets spec + acceptance criteria`
- After P2: `feat(flow): rework onExhaustion/resetTargets schema + floor + compile validation`
- After P3: `feat(db): node_attempts.rework_baseline (migration 0085)`
- After P5: `feat(flow): baseline-aware exhaustion, onExhaustion routing, human-driven reset`
- After P6: `test(flow): onExhaustion + reset coverage; back-compat green`

(Omit Co-Authored-By trailer per project convention.)

## Unresolved questions (Russian)

1. Имя outcome для `onExhaustion` — фиксируем `exhausted` или свободное? — план: свободное.
2. `maxLoops` human-ноды (число reset-раундов) — дефолт 3 в aif-dev flow ок? (это уже flow, не движок).
3. Колонка `rework_baseline` ок? (альтернатива `rework_epoch`).
