# M11 split (M11a / M11b / M11c) — cross-milestone review

> **⚠️ SUPERSEDED (numbering) — 2026-05-31.** This review was written against
> `decisions.md` HEAD = **ADR-021** / migration **0007** (pre-M11a). M11a then
> shipped and the branch was **rebased onto `main`**, which had concurrently
> taken ADR-022–025 (run-data projection, host-run topology, external-ops
> surface, repo onboarding) and migration slot 0008 — and a later main commit took
> migration `0009` (admin user management). m11a was therefore
> renumbered and the whole M11 allocation shifted. **Authoritative post-rebase
> allocation:** M11a = **ADR-026–029 / migration `0010`** (shipped on main);
> M11b takes **ADR-030 / migration `0011`**; M11c takes **ADR-031–032 /
> migration `0012`** (the `feature-m11b` / `feature-m11c` plans are renumbered
> accordingly). The numbers in the collision analysis below are the **pre-rebase**
> figures, retained as a historical record — do not treat them as current.

> Consolidated synthesis of four adversarial verification lenses against the three
> plans. Grounded against HEAD: `decisions.md` ceiling = **ADR-021**, migrations
> ceiling = **0007**, no `HumanWorking` in `runs.status`, no `web/lib/flows/graph/`
> (M11a not yet landed). Verified 2026-05-30.

Plans reviewed:
- M11a — `/.ai-factory/plans/feature-m11a-flow-graph-lifecycle.md`
- M11b — `/.ai-factory/plans/feature-m11b-manual-takeover-timeline.md`
- M11c — `/.ai-factory/plans/feature-m11c-node-settings-enforcement.md`

## Verdict: fix-then-ready

> **Status (2026-05-30): punchlist P1–P15 APPLIED** to all three plans
> (`feature-m11a/b/c`). Each fix is tagged inline with its `(Pn)` marker. The
> three resource collisions (ADR-026 double-claim, migration 0009 double-claim,
> #1.4 executor-ref contradiction) are resolved; M11c renumbered to ADR-027/028
> + migration 0010; M15 re-scope, e2e auth/seed harness, `HumanWorking`
> consumer-enumeration, and `transitions.takeover → checks` are recorded. This
> review file remains the as-of-review snapshot.

The criteria carve is unusually disciplined — every plan ships an explicit "Explicitly
NOT" carve table naming the receiving milestone per roadmap clause, all three have a
written `## Acceptance Criteria` section, and every AC traces to a roadmap `#` and a
Verify item. No roadmap sub-clause is dropped; only ONE sub-clause (executor refs) has a
contradictory owner statement. The substantive defects are **not** in the criteria carve —
they are three concrete merge-time **resource-numbering collisions** the three
independently-authored plans never reconciled (ADR-026 double-claimed, migration 0009
double-claimed, executor-ref ownership contradiction), plus a Phase-2 scope breach (M11a
annexes M15's gate-execution territory) and a missing M11a Playwright e2e + a missing
shared auth/seed e2e harness. All are fixable by editing the plans before implementation;
none require re-architecting the split.

---

## 1. Criteria matrix — 8 roadmap M11 criteria (ROADMAP.md:72-92) → single owner

Legend: ✅ single clean owner · ⚠️ contradictory/ambiguous owner statement · ❌ dropped/double-listed (none).

| Roadmap criterion / sub-clause | Owner | Status | Note |
| --- | --- | --- | --- |
| **#1.1** validation rejects unknown node ids | M11a | ✅ | AC-2 |
| **#1.2** unknown roles | M13 | ✅ | hand-off honored; M11c validates `human.decisions` vs `transitions` only, never roles-vs-registry |
| **#1.3** unknown MCP/tool/skill refs | M14 | ✅ | hand-off honored; M11c validates shape only, never reads registry |
| **#1.4** unknown **executor** refs (node `settings.executors`) | M11c (recommended) | ⚠️ | **CONTRADICTION**: M11a carve row says → M14; M11c AC-4 + Phase 1.4 implement it node-level. Pick one (see P1) |
| **#1.5** unsafe cycles without loop limits | M11a | ✅ | AC-2 (`rework.maxLoops`) |
| **#1.6** unsupported workspace policies | M11a | ✅ | AC-2 |
| **#1.7** human decisions targeting undeclared nodes | M11a | ✅ | AC-2 (validated vs `transitions`) |
| **#2** linear v1 flow still runs | M11a | ✅ | AC-1 |
| **#3** graph rework loop (plan→implement→checks→judge→review, reject→implement, rerun, fresh review) | M11a | ✅ | AC-3 |
| **#4** manual takeover (HumanWorking, branch+owner, import commits, returned diff, force downstream rerun) | M11b | ✅ | AC-1..4 |
| **#5** run-detail timeline (current vs stale + attempts/decisions/checkpoints/handoffs/commits/rerun) | M11b | ✅ | AC-5 |
| **#6** AI node settings visible in UI AND enforced | M11c | ✅ | AC-1..3 — but enforcement is the static-refusal slice; **materialized positive enforcement depends on M14** (see P5) |
| **#7a** aif demonstrates rework | M11a | ✅ | AC-6 |
| **#7b** aif demonstrates manual takeover | M11b | ✅ | AC-6 — only lands when M11b merges (M11a ships aif with `[approve,rework]` only) |
| **#8.1** docs: Flow graph schema | M11a | ✅ | AC-7 |
| **#8.2** docs: node settings schema | M11c | ✅ | AC-5 |
| **#8.3** docs: run ledger | M11a | ✅ | AC-7 |
| **#8.4** docs: rework semantics | M11a | ✅ | AC-7 |
| **#8.5** docs: manual takeover semantics | M11b | ✅ | AC-7 |
| **#8.6** docs: backwards compatibility | M11a | ✅ | AC-7 |

**Dropped (owned by nobody): NONE.** **Double-listed: only #1.4** (executor refs — contradictory owner statements between M11a-carve and M11c-actual). The other 19 sub-clauses each map to exactly one owner.

**Overlap to resolve (not a criteria-carve defect, a cross-plan reconciliation):** roadmap M15
("Gate execution and readiness policy") and M11a both claim the gate-execution engine —
same six gate kinds, same `pending|running|passed|failed|stale|skipped|overridden`
lifecycle, structured verdicts, blocking|advisory, override-without-erasure. M11a pulls
this forward under "full-featured gates (user directive)" but never records M15 as
re-scoped. This is a milestone-boundary overlap that must be made explicit (see P3).

---

## 2. Top risks

1. **ADR-026 collision (M11b + M11c both claim it; +M11c invents ADR-027 on top).** HEAD ceiling is ADR-021; M11a takes 022-025, so M11b's 026 is correct but M11c's 026/027 collide head-on. Numbering is "sequential and immutable" per `docs/decisions.md`. Every M11c cross-reference points at the wrong decision once M11b is in main. Exactly the 0006→0007 rebase pain the repo already paid.
2. **Migration 0009 collision (M11b definite + M11c conditional, same `node_attempts` table).** HEAD ceiling is 0007; M11a=0008, M11b=0009. If M11c ever adds its `enforcement_snapshot` column it emits a second `0009_*.sql` against the same table — hard filename/sequence conflict.
3. **M11a annexes M15's gate-execution milestone.** "Full-featured gate execution" (full status lifecycle + structured verdicts + override-without-erasure) is M15's verbatim headline deliverable in ROADMAP and `flow-dsl.md` "Planned M15". Shipping it under M11a while M15 still lists it double-claims a milestone and will read as a false M15 failure or duplicate work.
4. **No M11a Playwright e2e + no shared auth/seed e2e harness.** M11a builds the review→rework UI but never drives it through a browser; M11b/M11c specs require an authenticated session on protected `(app)` routes + a seeded graph run, but `playwright.config.ts` has no `webServer`/`globalSetup`/`storageState` and existing specs are unauthenticated `/login` smoke tests. Both plans assert "no scaffolding needed" — false.
5. **`HumanWorking` is only partially enumerated across `runs.status` consumers.** M11b handles the scheduler cap and abandon, but `reconcile.ts` and the keepalive sweeper SELECTs are not enumerated — a session-less-by-design `HumanWorking` run could be mis-classified `Crashed` on restart or never swept. Both scheduler cap predicates (`scheduler.ts:78` and `:160`) must be updated, not just one.
6. **#6 enforcement honesty + #1.4 executor-ref contradiction.** Risk that roadmap #6 is marked "done" after M11c while no MCP/tool/skill is ever actively constrained until M14; and that the #1.4 contradiction yields either a duplicate validator or a gap depending on which plan the implementer trusts.

---

## 3. Recommended execution order

```
M11a  ──────────────►  M11b  ──────────────►  M11c
(graph+ledger+gates)   (takeover+timeline)    (typed settings+refusal)
        │                                          ▲
        │                                          │ depends on M14 ONLY for
        └─ ADR 022-025, migration 0008             │ MATERIALIZED enforcement
           e2e auth/seed harness BORN here         │ (carve (b): M11c ships static
                                                    │  refusal now; M14 flips
                                       M14 ─────────┘  instructed→enforced later)
                       ADR 026, migration 0009      ADR 027-028, migration 0010 (if any)
```

1. **M11a first** (hard prerequisite for both others). It births: `nodes[]` schema, `node_attempts` ledger, `gate_results`, `markDownstreamStale`, graph compiler+runner, ADR-022..025, migration 0008, and — added per P-A1 below — the **shared Playwright auth+seed e2e harness** (M11a is where the graph-run seed first exists).
2. **M11b second.** Hard-depends on M11a's ledger/gate-store/`markDownstreamStale`/graph-runner. Owns ADR-026, migration 0009 (`HumanWorking` + `node_attempts` takeover columns). Phase 1 (`worktree.ts` range ops) is the one piece M11b can build in parallel while M11a lands. Reuses the M11a e2e harness.
3. **M11c third.** Hard-depends on M11a's `nodes[]`/ledger/runner and supersedes M11a's opaque-settings passthrough + WARN. Owns ADR-027 + ADR-028 (renumbered from 026/027) and, only if Phase 0.6 decides a snapshot column is needed, migration 0010 (renumbered from 0009). Default is **no** migration (read settings from the pinned `flow_revisions.manifest`).
4. **M14 interleaves AFTER M11c for materialized enforcement.** Adopt carve (b): M11c ships schema + shape validation + visibility + the launch-time refusal boundary over a conservative static `ENFORCEABILITY_BY_AGENT` table now; M14 later adds the capability registry, ref resolution, agent-aware mapping, materialization, and flips classes `instructed→enforced`. The contract only ever tightens. **Do not resequence M11c after M14** — that was explicitly considered and rejected.

---

## 4. Prioritized punchlist (deduped across all four lenses)

### P1 — `#1.4` executor-ref ownership contradiction (HIGH) — M11a + M11c
M11a carve row 149 says node-level executor refs → M14; M11c AC-4 (line 202-206) + Phase 1.4 (286) implement `settings.executors[]` validation against `maister.yaml executors[]`. **Resolve to M11c** (it is config-state, available without the M14 registry). Edit M11a carve row to read "node `settings.executors` refs → **M11c**; capability registry refs (mcps/tools/skills/agents/restrictions) → **M14**" so both plans agree. Edit M11c to keep AC-4 and add a one-line note confirming M11a's carve was updated to match.

### P2 — ADR-number collision (HIGH/CRITICAL) — M11b + M11c
HEAD = ADR-021; M11a = 022-025; M11b = 026 (correct). **M11c must renumber to ADR-027 (typed settings) + ADR-028 (enforcement boundary)** and update all five locked-decision back-references (M11c lines 118, 123, 132, 139, 148), Phase 0.1 (250), and contract-surface row D. Safest construction: each plan's Phase 0 states its owned ADR range explicitly (M11a: 022-025; M11b: 026; M11c: 027-028) and the implementer reads `decisions.md` HEAD before committing rather than hard-coding numbers in two unmerged plans.

### P3 — Migration-number collision (HIGH/CRITICAL) — M11b + M11c
HEAD = 0007; M11a = 0008; M11b = 0009 (definite: `HumanWorking` + takeover columns). **M11c's conditional migration must be 0010, not 0009** (update M11c lines 267, 304, contract-surface row E, Verify refs). Better: M11c defaults to **no migration** (read settings from the pinned `flow_revisions.manifest`, which Phase 2.1 already prefers) and only falls back to 0010 if Phase 0.6 concludes an audit snapshot is required. State `0008(M11a) < 0009(M11b) < 0010(M11c-if-needed)` as the only valid order in each Phase 2.

### P4 — M11a annexes M15's gate-execution territory (HIGH) — M11a
M11a Phase 4 + ADR-024 implement M15's verbatim gate-execution contract while M15 still lists it. **Resolve M11a's own open question #5 as a DECISION, not a question.** Either (a) record in ADR-024 + the Phase 0.2 roadmap renumber that M15 is re-scoped to "readiness-policy DSL + verdict calibration + `external_check` ingestion ONLY", and update `flow-dsl.md` "Planned M15" → "Planned M11a" for the moved clauses; or (b) descope M11a Phase 4 to gate schema + status modelling + `human_review` only and leave the full lifecycle/verdict/override engine to M15. Do not leave both M11a and M15 claiming the same status lifecycle + override-without-erasure.

### P5 — Missing M11a Playwright e2e + missing shared auth/seed harness (HIGH) — M11a (+M11b, M11c)
- **P5a:** Add `web/e2e/m11a-review-rework.spec.ts` (M11a has zero e2e): launch migrated aif → reach review HITL → click rework + comments → assert downstream `checks`/`judge` go stale → run returns to a fresh review gate → approve. Add a Verify bullet for it before Phase 7's gate.
- **P5b:** In the FIRST plan that ships an e2e (M11a), add an explicit e2e-scaffold task: `web/e2e/global-setup.ts` (sign in the seeded `admin@maister.local` from migration 0005, persist `storageState`), a `webServer` block in `playwright.config.ts` (or a documented+gated `pnpm dev` + seeded-DB CI step), and a shared `tsx` seed helper that installs aif, creates a task, launches a run, and drives it to the `human_review` node via the mock-acp-adapter. **M11b/M11c reuse it.** Change both plans' "Playwright is already configured … no scaffolding needed" to "config+binary exist; auth+seed harness added in `<task>`".
- **P5c:** Promote M11b's conditional "6.0 seed-helper" (line 413) to **mandatory** and a hard predecessor of 6.1; tie its acceptance to the shared harness. Convert "passes against `pnpm dev` + seeded DB" prose into a concrete gate so the spec cannot be green by being skipped.

### P6 — `HumanWorking` not enumerated across all `runs.status` consumers (MEDIUM) — M11b
M11b Phase 2.5 handles the cap and Phase 3.5 handles abandon, but `reconcile.ts` (orphan→Crashed classification) and the keepalive-sweeper SELECTs are not enumerated. Add a Phase 0.2 sub-task amending `runs.md` reconcile flowchart + the "at most one live ACP session" invariant so a `HumanWorking` run (session-less by contract, holds a worktree) is **excluded** from orphan-Crashed classification, plus a Phase 2/3 code task updating the reconcile predicate and a regression: a `HumanWorking` run survives a simulated restart without flipping to `Crashed`. **Also:** Phase 2.5 says "update the cap predicate" (singular) — enumerate **both** `scheduler.ts:78` and `:160` and assert the test covers a `HumanWorking` run occupying a slot through both the initial-promote and under-lock-recheck paths.

### P7 — Status-enum casing inconsistency in new tables (MEDIUM) — M11a
`node_attempts.status` is PascalCase (`Pending|Running|Succeeded|Failed|NeedsInput|Reworked|Stale`, matching `step_runs`) but `gate_results.status` is lowercase (`pending|running|passed|...`, inherited from M15 prose). Two casings in the same migration 0008 will leak into TS type names, UI branching, and tests. Pick one — schema precedent is PascalCase for lifecycle statuses — or, if lowercase is kept deliberately to match M15 prose, state that exception explicitly in the analytics doc. Also add a Phase 0.3 status-mapping note: `node_attempts` adds `Reworked`/`Stale` and omits `Skipped` vs `step_runs`; state how legacy `step_runs` values map for the templating highest-attempt-wins union.

### P8 — `#6` enforcement honesty in the roadmap renumber (MEDIUM) — M11c
M11c delivers a launch-time **refusal** boundary over a static table where every M14-materialized class is seeded `instructed`, so `strict` on mcps/tools/skills/restrictions REFUSES rather than enforces. This is honest (carve (b), contract-tightens-only), but mark criterion #6 in the roadmap renumber as split: "visibility + refusal-boundary (M11c)" vs "materialized positive enforcement / `instructed→enforced` flip (M14)". M11c verification must assert REFUSAL on strict-over-instructed and must NOT claim a non-strict (instruct) mcps/tools declaration is enforced — only displayed.

### P9 — `transitions.takeover` target contradicts the cited doc (MEDIUM) — M11b
M11b AC-6/Phase 3.3/5.4 assert the aif `human_review` node's `transitions.takeover` points to a validation re-entry (`implement`/`checks`) and cite `flow-dsl.md:104` as support — but `flow-dsl.md:107` actually wires `takeover → human-edit` (a `human_edit` node type M11b defers to M18). **Resolve M11b's open question #4 as a Phase 0 DECISION:** `transitions.takeover` routes to a real M11a node (`checks` or `implement`), NOT `human_edit`. Update `flow-dsl.md:107` in a Phase 0.7 task so the canonical example matches the M11b runtime (note that the `human_edit` node TYPE is M18-Designed).

### P10 — M11b roadmap reconciliation: "push" prose contradicts ADR-011 (MEDIUM) — M11b
Roadmap M11 criterion #4 Expectation prose says the reviewer "commit and push changes"; M11b correctly forbids push (ADR-011 local handoff). M11b has **no** roadmap-reconciliation Phase 0 task (unlike M11a 0.2 and M11c 0.2). Add one (delegated to the roadmap owner) that rewrites the #4 Expectation from "commit and push" to "commit changes locally", and that VERIFIES M11b's inherited roadmap row matches the M11a-authored three-way carve (so no slice silently skips roadmap reconciliation). The authoritative full three-way carve lives in M11a's carve table — M11b/M11c Phase 0 only verify their inherited row, no re-distribution.

### P11 — `ENFORCEABILITY_BY_AGENT` may over-claim `enforced` (LOW) — M11c
M11c Phase 3.1 seeds `permissionMode='enforced'` for claude via an assumed `--permission-mode` adapter flag, but open question #2 admits this is unverified and `spawn.ts` is unchanged in M11c. A wrongly-`enforced` cell would let a `strict permissionMode` declaration PASS the launch gate while nothing actually enforces it — the exact silent escape hatch #6 forbids. **Before seeding any cell `enforced`, verify against `claude-agent-acp@0.37.0` that the flag is honored end-to-end.** If unverifiable in M11c, seed the ENTIRE table `instructed` (conservative refusal holds with certainty) and let M14 flip `permissionMode→enforced` once it owns the spawn env layer.

### P12 — M11b abandon surface unverified (LOW) — M11b
Phase 3.5 cites an "existing abandon surface … `web/app/api/runs/[runId]/...`" but `[runId]/` contains only `activity`, `hitl`, `stream` — no `abandon/` route. Add a Phase 0 task to locate and pin the real abandon surface (route handler vs server action) and name the exact file in Phase 3.5; if abandon is not yet a route, the plan must add it or wire `releaseHumanWorking` into the actual server-action path.

### P13 — M11a schema-relaxation + stale line citations (LOW) — M11a
- Phase 1.1: making `steps`/`nodes` mutually exclusive requires relaxing the currently-required `steps` field (`config.schema.ts:117` `.min(1)`) to optional before the `.refine` can enforce exactly-one. State explicitly: `steps` becomes optional, `nodes` optional, `.refine` rejects both-absent AND both-present; name the existing "steps-required" config test as one needing migration.
- Phase 3.3/3.5/Phase-3 migration list: line citations into `runner.ts` are stale (CAS is ~314-317 not 312-361; linear loop at 416; no as-any at line 42) and the migration list uses globs (`templating.*`, `step-runs.*`) that may name non-existent files. Replace with symbol references and concrete paths (e.g. `web/lib/flows/__tests__/runner.integration.test.ts` "aif plugin halts at review step" case); reframe missing files as "add" not "migrate".

### P14 — WARN-string handoff brittleness (LOW) — M11a + M11c
M11a Phase 1.6 emits a literal `WARN [flow] node settings parsed but not enforced until M11c` and M11c Phase 1.6 asserts its absence. Emit it via a named exported constant (e.g. `SETTINGS_NOT_ENFORCED_WARN` in `config.ts`); M11c asserts that constant is removed/never logged — hardens the handoff against string drift. (The path-level handoff is already correct.)

### P15 — Intermediate WARN noise during M11b (LOW, informational) — M11b
The M11a opaque-settings WARN remains expected on every aif load between M11a and M11c (M11b never touches the settings field). Note in M11b that this WARN is not a regression during M11b verification. No structural change.

---

## 5. Per-lens summaries

### Lens 1 — Criteria completeness + distinctness
Full sub-clause matrix of all 8 roadmap M11 criteria maps to exactly one owner with NO dropped sub-clauses; only #1.4 (executor refs) has contradictory owner statements (M11a-carve says M14, M11c implements node-level). All three plans have written `## Acceptance Criteria` sections; every AC cites its roadmap `#` and a Verify item. Hand-offs to M13 (#1-roles) and M14 (#1-MCP/tool/skill) are honored and NOT re-implemented in M11c. The carve is "unusually disciplined" — substantive defects are in cross-plan resource numbering, not the carve: executor-ref contradiction (HIGH), ADR-026 double-claim (HIGH), migration 0009 double-claim (HIGH), plus #6 enforcement-honesty and #7 aif-takeover-sequencing notes (MEDIUM).

### Lens 2 — Consistency with locked decisions + schema
All three plans are disciplined on the ADR-008 closed error union (no invented codes — all reuse existing `lib/errors.ts` codes), on ADR-011 (M11b forbids push/remote, models takeover as local worktree handoff), and on the two-phase-commit invariant (M11b puts the idempotency marker on the AFTER side). Two hard cross-plan collisions break sequential implementation: ADR-026 (M11b+M11c) and migration 0009 (M11b+M11c). Substantive scope contradiction: M11a claims FULL gate execution that the roadmap+flow-dsl assign verbatim to M15. New-table status-enum casing is internally inconsistent (PascalCase vs lowercase) and `node_attempts.status` extends `step_runs` vocab without a stated mapping. `HumanWorking` layered onto `runs.md`/schema but reconcile/sweeper consumers not fully enumerated. The runs.md rework re-entry diagram (NeedsInput→Running) is asserted in prose but not drawn.

### Lens 3 — SDD + dependency ordering
All three plans are genuinely docs-first: each opens with a 🔴-gated Phase 0 (no code) carrying the system-analytics doc, ERD-both-artifacts, OpenAPI, implementation-status tags, and the contract-surface tracing table. Deployment-touchpoint reasoning is sound (all honestly conclude "no new env var/port/sidecar → no compose change"; engine-version const-vs-env distinction is correct). Three concrete cross-milestone integrity defects: ADR-026 collision (next free is 022 per decisions.md HEAD=021), migration 0009 collision (HEAD=0007), and M11a's Phase-2-boundary breach annexing M15's gate-execution territory. The M11c↔M14 dependency is the best-handled part (carve (b) is explicit, honest, contract-tightening-only, resolved without resequencing). M11b's `transitions.takeover` target contradicts the doc it cites (flow-dsl.md:107 → human_edit, an M18 node type); the new `HumanWorking` status opens an unaddressed reconciliation gap; only M11a has a roadmap-renumber task (M11b's is missing).

### Lens 4 — TDD + Playwright e2e discipline
TDD discipline is strong: each phase carries a "`pnpm test:unit && pnpm test:integration` green" gate, assertion-migration is in-scope and enumerated (M11a Phase 3 file list; M11c Task 1.6 explicitly supersedes M11a's settings-passthrough+WARN tests by path), and test-runnability is verified against the existing vitest workspace globs — no runner-config extension is in fact required. The Playwright story breaks down: (1) M11a has NO e2e at all though it is the plan that introduces the review→rework UI; (2) `playwright.config.ts` has no `webServer`/`globalSetup`/`storageState` and the only existing specs are unauthenticated `/login` smoke tests, yet M11b/M11c specs both require an authenticated session on protected `(app)` routes + a seeded graph run — scaffolding neither plan provisions despite asserting "no scaffolding needed". Same two cross-milestone collisions surfaced (ADR-026, migration 0009).

---

## Appendix — HEAD facts verified (2026-05-30)

| Fact | HEAD value | Implication |
| --- | --- | --- |
| `decisions.md` ADR ceiling | **ADR-021** | M11a 022-025 OK; M11b 026 OK; M11c MUST be 027-028 |
| `web/lib/db/migrations/` ceiling | **0007** | M11a 0008 OK; M11b 0009 OK; M11c MUST be 0010-if-needed |
| `runs.status` has `HumanWorking` | **No** | M11b adds it; enumerate all consumers (P6) |
| `web/lib/flows/graph/` exists | **No** | M11a not landed; M11b/M11c phases 2+ blocked on M11a merge |
