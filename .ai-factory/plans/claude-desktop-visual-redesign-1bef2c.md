# Implementation Plan: Desk — one object per work item

Branch: `claude/desktop-visual-redesign-1bef2c`
Created: 2026-09-17 · Refined: 2026-09-17 (`/aif-improve` — SDD + TDD pass)

**Specification (normative):** [`../specs/desk-one-object-per-work-item.spec.md`](../specs/desk-one-object-per-work-item.spec.md)
**Design rationale:** [`../../docs/plans/2026-09-17-desk-visual-redesign-design.md`](../../docs/plans/2026-09-17-desk-visual-redesign-design.md)

The spec owns the requirements (`REQ-D*`), the acceptance criteria (`AC-D*`), the API
and DB contracts, and the system-analytics contract. **This plan owns sequencing,
TDD discipline and gates only, and does not restate them.** Every task cites the
requirement it implements and the acceptance criterion that proves it; a task citing
neither is out of scope by construction.

## Settings

- Testing: yes
- Logging: verbose for new handlers only — see "Logging policy"
- Docs: yes (mandatory documentation checkpoint at completion)

## Roadmap Linkage

Milestone: "M51. See everything"
Rationale: segment (D) of M51 is ADR-172 "The Desk"; this increment revises that
segment's information architecture, and M51's traceability gate governs it.

## Method

**SDD.** The spec is written first and is the single source of truth. Implementation
follows it; where implementation must deviate, the spec is amended in the same commit
— never left describing code that does not exist.

**TDD, per task.** Every implementation task runs:

1. **RED** — write the test named by its acceptance criterion, run it, **observe it
   fail for the stated reason**. A test that passes before the implementation is
   evidence of nothing and MUST be rewritten.
2. **GREEN** — the smallest change that turns it green. No adjacent refactoring.
3. **REFACTOR** — SOLID / KISS / DRY and project conventions, with the test staying
   green throughout.

A task whose RED step cannot fail — because the assertion is trivially true — is a
signal the criterion is wrong. Fix the criterion, not the test.

**Test layering (minimum overlap).** The rule and the forbidden-test list live in the
spec's "Acceptance criteria traceability". In short: pure computation → unit; markup
from props → unit via `renderToStaticMarkup`; structural invariants → the source
contract test; anything needing interaction, layout or a viewport → e2e only, because
**both vitest projects are `environment: "node"` and there is no jsdom project.** No
requirement is asserted at two layers.

## Logging policy

This increment adds **no server logic and no new query** (`REQ-D2`, `REQ-D15`). Tasks
therefore carry no server-log requirements; inventing them would be noise.

One exception, stated in its task: **T3.2** inherits `HitlCard`'s existing
loading/error branch around `GET /api/runs/:id/inbox-context` and MUST preserve it
(`REQ-D16`). No `console.*` in committed code.

## Deployment touchpoints

**None.** No new env var, config path, sidecar binary, bound port, or host-mounted
file. `Dockerfile`, `compose*.yml` and `.env.example` are untouched.

## Contracts

API and DB contracts are specified — including the evidence that both are empty — in
the spec's `## API contract` and `## DB contract`. Summary: one endpoint is *consumed*
and already specified (`docs/api/web.openapi.yaml:5745`), unchanged; no migration,
with `0170` reserved as the next free number if that ever stops being true, and
`drizzle-kit generate` reporting "No schema changes" as the check.

## Reserved numbers

- **ADR-174** — next free at `git show master:docs/decisions.md` (max is 173; index
  and body agree). If another branch merges an ADR first, a renumber pass is required
  **after** rebasing onto master, as its own step.
- No migration number is consumed.

## Gates

**CI enforces:** `lint`, `typecheck`, `test:unit`, `test:integration`,
`validate:docs:all`, `validate:contracts`.

**CI does NOT enforce — run these by hand:**

- `pnpm validate:m51-coverage` — proves every cited primary test resolves to a real
  test title. No workflow invokes it.
- `pnpm --filter maister-web test:e2e` — **no Playwright job exists in CI.** Most of
  this change's behavioural proof lives in `desk.spec.ts`, so skipping this gate
  means shipping the interaction unverified.

**Every phase exits on:**

1. lint + typecheck clean;
2. `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration`
   green — a test the phase touched left red **fails the phase**; quarantine is an
   explicit task with a reason and a follow-up, never silence;
3. `vitest list --project unit` (or `integration`) **shows every test file the phase
   added** — a committed test no runner runs gives false confidence;
4. `pnpm validate:docs:all` green;
5. `pnpm validate:m51-coverage` green;
6. `pnpm --filter maister-web test:e2e` green **for `desk.spec.ts`** — except where a
   task explicitly declares an e2e test parked RED (permitted because Playwright is
   outside CI; each such park names the task that turns it green).

**Phase-ownership rule (the fix for two contradictions found in the first cut).**
*Each phase owns every test change and every expectation amendment its own behaviour
change causes.* The first cut removed the table's internal scroll in Phase 2 while
parking the `EDGE-NAV-02` amendment in Phase 5, and retargeted the tile ids in Phase 1
while parking the spec rewrite in Phase 5 — each would have left the suite red across
intervening phases, violating gate 2.

---

## Commit Plan

- **Commit 1** (T0.1–T0.4): `docs: specify the Desk rebuild and record ADR-174`
- **Commit 2** (T1.1–T1.6): `feat(desk): replace the digest window with a state partition strip`
- **Commit 3** (T2.1–T2.6): `feat(work): fold run status into the stage chip and drop two columns`
- **Commit 4** (T3.1–T3.3): `refactor(inbox): extract a body-only HITL panel`
- **Commit 5** (T4.1–T4.4): `feat(desk): expand a work row into its decision panel`
- **Commit 6** (T5.1): `fix(activity): give every feed row a subject`
- **Commit 7** (T6.1–T6.5): `feat(desk): single-column layout, NAV-08, and the expectation deltas`

---

## Tasks

### Phase 0 — Specification (no code)

**T0.1 [x] — Write the SDD specification**

`.ai-factory/specs/desk-one-object-per-work-item.spec.md` — 24 requirements, 24
acceptance criteria, API/DB/system-analytics contracts, verified baseline, non-goals.
Done during the `/aif-improve` pass.

**T0.2 [x] — Write ADR-174, successor to ADR-172 D1**

Successor, **not** an amendment: ADR-172 D1 enumerates the composed regions *as a
decision*, so removing two and inverting the order changes the decision, and ADR-172
stays historically accurate if left intact. Add one line to ADR-172 noting it is
superseded in part.

Record the motivating finding with its counted example (spec `## Purpose`), and the
five decisions (spec scope source 3–7).

Implements: the spec's premise. Proves: nothing — documentation.
Files: `docs/decisions/adr-174.md`, `docs/decisions.md`.

**T0.3 [x] — Respec `docs/screens/desk.md`**

Rewrite §"Layout & regions" and §"As built" to `REQ-D21`'s order. State that the
strip's sum is total work in flight, not visible rows (`REQ-D2`), and that the
expansion adds no mutation path (`REQ-D18`). Tag every piece Implemented / Designed
per `docs/CLAUDE.md` R6.

**T0.4 [x] — Re-scope `docs/screens/work.md`**

Scope the **three** view-only clauses (roles table, layout, next action) to `/work`
explicitly, naming the Desk's opt-in panel as the exception (`REQ-D12`, `REQ-D14`).
Correct the pre-existing "run dot" vs raw-enum drift, noting `REQ-D8` moves the code
toward the spec.

Exit: gates 1, 4, 5. `NAV-08` is **not** declared yet — its declaration, matrix row
and test land together in T6.3, or CI goes red on a requirement with no resolvable
test.

---

### Phase 1 — The Now strip

**T1.1 [x] — RED: the partition count**

Write `web/lib/work/__tests__/stage-counts.test.ts` (**T-D1**, project `unit`) against
a function that does not exist. Assert the map has exactly the five
`WORK_IN_FLIGHT_STAGES` members and its values sum to the input length, including for
a row set larger than `DESK_WORK_ROWS`.

Observe it fail on the missing module. Confirm `vitest list --project unit` shows the
file.

Proves: `AC-D1` · Implements: `REQ-D1`, `REQ-D2`.

**T1.2 [x] — GREEN: implement the count**

`web/lib/work/stage-counts.ts` — pure, `readonly WorkTableRow[] → Record<stage,
number>` as a `satisfies` map so an eleventh stage is a compile error. No DB handle,
no clock.

**T1.3 [x] — Retarget `NowTiles` and add the URL filter**

`now-tiles.tsx` has one consumer, so it is free to reshape. Tiles become the five
in-flight stages; a tile links to `/?stage=<Stage>`; the Desk reads `searchParams` and
filters **before** the row slice. Validate the value like
`normalizeWorkTableFilters` — unknown falls back to unfiltered, never throws.

Add the filtered-empty state (`REQ-D6`), distinct in copy from "nothing is running".

e2e cases **T-D3 / T-D5 / T-D6** are written in this phase and may be parked RED until
T6.1 lands the final layout; each park is declared in the commit message and named
here. `AC-D2` is asserted in T1.6.

Proves: `AC-D3`, `AC-D5`, `AC-D6` · Implements: `REQ-D3`, `REQ-D5`, `REQ-D6`.

**T1.4 [x] — Stop rendering the digest window**

Remove the digest sentence and the `getNowTileCounts` / `formatDigest` calls from
`page.tsx`. Both stay in the codebase for ADR-173; `digest.test.ts` and
`digest.integration.test.ts` MUST pass **unmodified** — if either needs editing, the
change has overreached.

Move the `NOW_TILE_HREFS` route assertion out of `desk-contract.test.ts` into
`lib/queries/__tests__/digest.test.ts`, where it belongs: it is about the digest
module, which survives.

Proves: `AC-D4` · Implements: `REQ-D4`.

**T1.5 [x] — Migrate the assertions this phase invalidates**

Named individually, because a bare "migrate the tests" line reliably gets trimmed.
**This phase owns them** — deferring any of these is what the phase-ownership rule
forbids.

- `web/e2e/desk.spec.ts` test 1 (`E2E-NAV-01`) — the five `data-now-tile` ids change
  from `promoted/crashed/decisions/events/tokens` to the five in-flight stages, and
  the `desk-digest` assertion goes.
- `web/e2e/desk.spec.ts` test 6 (`E2E-EDGE-NAV-01`) — its `desk-digest` assertion goes.
- `web/app/(app)/__tests__/desk-contract.test.ts` — the `NOW_TILE_HREFS` block moves
  (T1.4).

**T1.6 [x] — i18n, and close the orphan-key hole**

The five stage names already exist in the `workStage` namespace, and `desk.nowLabel`
is already in both catalogs — **the strip needs no new keys.** Render `nowLabel` as
the strip heading, which converts a standing orphan into a used key.

Prune the keys this phase orphans from **both** catalogs in one edit, preserving
parity. Then extend `desk-contract.test.ts` with the coverage half of `AC-D23`: every
`en.desk` key has a render site in `page.tsx`. Parity alone does not catch this —
which is how `desk.sub` and `desk.nowLabel` became orphans in the first place.

`desk.sub` is a **pre-existing** orphan, not one this change creates. Prune it here
anyway: this task is the one that makes the rule enforceable, and leaving a known
violation behind a newly-added gate would simply turn the gate red.

Proves: `AC-D23` · Implements: `REQ-D23`.

Exit: gates 1–5; gate 6 modulo declared RED parks.

---

### Phase 2 — The shared work table

Both consumers change together. `WorkTableLabels extends WorkRowsLabels` makes a
column change a compile error at both call sites — that is the anti-drift mechanism
working. **Do not fork the component** (`REQ-D12`).

**T2.1 [x] — RED → GREEN: hide the project column under project grouping**

Test first (**T-D7**, `unit`, markup, 2 cases): under `group=project` no project cell
renders; under another grouping it does.

Then implement. Adjust the group-header `colSpan`, currently hardcoded `11`.

Proves: `AC-D7` · Implements: `REQ-D7`.

**T2.2 [x] — RED → GREEN: fold the run-status refinement into the chip**

Test first (**T-D8**, `unit`, markup, **6 cases including the negative**): each of
`NeedsInput` / `NeedsInputIdle` / `HumanWorking` gives a distinguishable accessible
name; `Running` and `WaitingOnChildren` likewise; **a chip given no run status renders
byte-identically to the pre-change output.** That last case is the one that protects
`decision-card.tsx` and `hitl-card.tsx`, which pass none.

Fan-out checklist — enumerate every consumer, do not trust the file list:

- `WorkRowsTable` — both surfaces;
- `WorkStageChip` — grep every consumer first; `decision-card.tsx` and `hitl-card.tsx`
  pass no run status, so the new input MUST be optional;
- `WorkRowsLabels.columns` — removing the `run` key is the compile-error mechanism;
  let it fire and fix both call sites;
- `buildWorkRowsLabels`;
- `work.columns` in **both** catalogs.

Refinement labels go in the `workStage` namespace, EN and RU.

Proves: `AC-D8` · Implements: `REQ-D8`.

**T2.3 [x] — RED → GREEN: the run affordance and the next-action affordance**

Tests first: **T-D9** (the run stays reachable by a named affordance) and **T-D10**
(2 cases: `none` → em dash; otherwise the affordance). `workNextAction` stays a pure
function of the stage.

Proves: `AC-D9`, `AC-D10` · Implements: `REQ-D9`, `REQ-D10`.

**T2.4 [x] — Responsive columns — and the `colSpan` rule that goes with them**

Drop columns by priority (`tokens`, `readiness` first) instead of horizontal scroll.

**Hiding is CSS-driven, so the `<td>` elements remain in the DOM.** Any `colSpan`
must therefore be the **full** column count, never the visible count — the first cut
of this plan said "derive from the rendered column count", which breaks at narrow
widths and would have produced a misaligned expanded row.

Proves: `AC-D11` · Implements: `REQ-D11`.

**T2.5 [x] — Amend `EDGE-NAV-02` and its assertions, in this phase**

T2.4 falsifies `EDGE-NAV-02`, which currently reads "…the work table scrolls inside
its own container". The expectation, its matrix row and its e2e assertion move
**here**, with the behaviour change — not in a later phase.

- `docs/system-analytics/home-navigation.md` — both halves of the clause.
- `docs/system-analytics/m51-traceability.md` — the `EDGE-NAV-02` row; the
  `E2E-EDGE-NAV-02` title must still resolve.
- `web/e2e/desk.spec.ts` test 3 — the internal-scroll assertion inverts; pin a short
  viewport per the project's scroll-regression convention.

**T2.6 [x] — Migrate `/work`'s own assertions**

`web/app/(app)/work/__tests__/page-contract.test.ts` — column expectations. Add
**T-D12** (`unit`, markup, negative): `/work` renders no expand affordance and its row
markup is otherwise unchanged.

Proves: `AC-D12` · Implements: `REQ-D12`.

Exit: gates 1–6.

---

### Phase 3 — Extract the HITL panel

**T3.1 [x] — RED: the panel's markup and error contract**

Write `web/components/inbox/__tests__/hitl-panel.test.ts` (**T-D17** plus the markup
half, `unit`, `renderToStaticMarkup`) against a module that does not exist: collapsed
markup, expanded markup, and the error branch.

Mocking note, from the project's accumulated rules: a mock for a hook-returned
function used in `useCallback`/`useEffect` deps MUST preserve the real hook's stable
identity — cache one translator per namespace inside the hoisted factory. A fresh
function per render has previously looped this suite to a 4 GB OOM.

**T3.2 [x] — GREEN: extract, then rebuild `HitlCard` on it**

`HitlCard` is a client component and monolithic — its own `useState` expansion, its
own header toggle, a lazy `inbox-context` fetch, a trailing `RunHitlResponse`, and a
private `ExpandedContext`. Extract a panel whose `expanded` state is **owned by its
parent**, carrying the fetch/loading/error closure.

**Then rebuild `HitlCard` on the extracted panel** so `/inbox` and the Desk render one
implementation (`REQ-D17`). Shipping the extraction without this step leaves two
copies, which is the drift ADR-172 D1 exists to prevent.

Logging: preserve the existing loading/error branch **verbatim** (`REQ-D16`).

Proves: `AC-D17` · Implements: `REQ-D16`, `REQ-D17`.

**T3.3 [x] — Verify `/inbox` is unchanged**

`/inbox` renders the rebuilt card. Run the inbox e2e spec and the existing
`components/inbox/__tests__/hitl-card.test.ts` unmodified — if either needs editing,
the extraction changed behaviour it should not have.

Exit: gates 1–6.

---

### Phase 4 — Expandable rows (Desk only)

**T4.1 [ ] — RED: expansion behaviour, in e2e**

Nothing in this repo expands a `<tr>`; `<details>` cannot wrap one. This is new
ground, and **vitest cannot prove it** — write **T-D13** (4 cases: click, Enter,
Space, and a nested link that navigates *without* toggling) in `desk.spec.ts`.

Park it RED; T4.2 turns it green.

Proves: `AC-D13` · Implements: `REQ-D13`.

**T4.2 [ ] — GREEN: the expandable row shape**

A second `<tr>` with a `colSpan`-spanning cell, behind an `expandable` prop defaulting
to `false`. Follow the repo's disclosure idiom — `useState(open)` + `aria-expanded` +
a conditionally rendered sibling.

Open state gates rendering, so it lives in `useState`, **never a `useRef`** — a ref
read during render is a silent no-re-render bug the project has already paid for.
`colSpan` is the full column count (T2.4).

**T4.3 [ ] — Join on `runId`, and wire the panel by stage**

Build a `Map<runId, DecisionItem>` in `page.tsx` from the queue it **already loads**.
`getWorkTable` is not modified. Keep the literal `hitlDecisionsOf(queue.items)` — the
source-contract test string-matches that exact substring — and keep the
`@/lib/queries/decisions` import, which `UT-ATN-05` names by file.

Wire the four stage panels. `Review` is a **link**, never an inline promote.

Tests: **T-D14** (e2e, 4 stages + the negative that no promote control renders),
**T-D15** (`unit`, source contract), **T-D16** (e2e, network-intercepted, 3 cases:
no request while collapsed, exactly one on expand, error branch on failure).

`T-D16` is the guard against the Desk firing one request per `WaitingOnHuman` row on
load — the failure mode a mount-time fetch would produce.

Proves: `AC-D14`, `AC-D15`, `AC-D16` · Implements: `REQ-D14`, `REQ-D15`, `REQ-D16`.

**T4.4 [ ] — Remove the Decisions region; keep Held**

Drop `HitlInboxList` and the `hitl` / `crashed` / `promotable` sections.
`DecisionSections` keeps rendering `flagged` as its own region — `Held` is in
`WORK_BACKLOG_STAGES`, the one decision kind the table does not carry.

Migrate in this phase: `desk.spec.ts` test 2 (`ATN-05`) and test 5, both of which
assert `desk-decisions-count`. Test 2's equality re-homes to `/inbox` (T6.4 records
it in the matrix); test 5 asserts the Held region and the zeroed strip instead.

Exit: gates 1–6.

---

### Phase 5 — Activity

**T5.1 [ ] — RED → GREEN: every row names its subject**

Test first — `web/components/activity/__tests__/activity-row-list.test.ts` is **new**;
no test imports this component today. **T-D19** (2 cases: a row with no task join
names its run; one with a task names the task) and **T-D20** (events given out of
natural order render in input order, with the row count preserved).

`T-D20` is the regression guard for `REQ-D20` — it is what would catch a future
"helpful" collapse or re-sort.

Then implement the short-run-id fallback. Do **not** collapse or reorder.

Proves: `AC-D19`, `AC-D20` · Implements: `REQ-D19`, `REQ-D20`.

Exit: gates 1–6.

---

### Phase 6 — Layout, identity, close-out

**T6.1 [ ] — Single column, region order, composer removed**

Replace the `xl:grid-cols-[...]` grid with one column at every width; order header ·
strip · work · Held · activity. Delete the `ScratchLaunchPopover` call — the rail
renders it as `variant="primary"` with the global ⌘K listener, so nothing is lost.

Turns green every e2e case parked RED in T1.3.

Proves: `AC-D21`, `AC-D22` · Implements: `REQ-D21`, `REQ-D22`.

**T6.2 [ ] — Finish `desk-contract.test.ts`**

This test reads `page.tsx` **as source text**, so it breaks on nearly every change here
by design. Each assertion, named:

- `HitlInboxList`, `ScratchLaunchPopover` JSX tags — gone;
- `DecisionSections`, `NowTiles`, `WorkRowsTable`, `ActivityRowList`,
  `OnboardingChecklist`, `EmptyState` — survive;
- the four `xl:` grid classes — gone;
- region source order — the new order (`AC-D21`);
- the composer's `hasProjects ?` gate — gone;
- **no `"use server"`, no `fetch(`, no `method: "POST"`** — must still hold; this is
  what proves `REQ-D18`, and it is the one assertion that must not be relaxed;
- `getDecisionsQueue`, never `computeDecisionsQueue` — must still hold;
- the `AC-D2` no-new-query assertion — new.

Proves: `AC-D2`, `AC-D18`, `AC-D21`.

**T6.3 [ ] — Declare `NAV-08` with its matrix row and its test, in one commit**

`REQ-D24` — one work item appears as exactly one object on the Desk — is the change's
reason for existing and currently nothing would catch its regression.

All three land together, or CI goes red on a declared id with no resolvable test:

- the declaration in `docs/system-analytics/home-navigation.md`;
- the row in `docs/system-analytics/m51-traceability.md`;
- the test, whose title must contain the literal **`E2E-NAV-08`** — seed a task that is
  simultaneously in flight and blocked on a human, and assert the Desk renders exactly
  one object naming it.

Proves: `AC-D24` · Implements: `REQ-D24`.

**T6.4 [ ] — Re-home the `ATN-05` assertion and amend `EDGE-NAV-01`**

`ATN-05`'s text is untouched — "Every surface MUST render one layout-level `decisions`
value" is surface-agnostic. Only the Desk-side assertion moves to `/inbox` (the
rewrite happened in T4.4; record it in the matrix here).

`EDGE-NAV-01` — "…the composer is absent until a project exists" — becomes
unconditional. Update the clause, its matrix row, and `desk.spec.ts` test 6.

Verify, do not rewrite: `IT-ATN-05` and both `UT-ATN-05` suites assert at the query
layer and are unaffected.

**T6.5 [ ] — Documentation checkpoint**

Mandatory per Settings. Re-verify every contract surface in the spec against the code
at HEAD **by opening each file**, not by assuming the edit landed. Flip
implementation-status tags from Designed to Implemented. Confirm `drizzle-kit
generate` still reports "No schema changes". Route narrative changes through
`/aif-docs`.

Exit: gates 1–6, and the spec's non-goals still hold.

---

## Risks

1. **The interaction proof lives outside CI.** `AC-D3`, `AC-D5`, `AC-D6`, `AC-D11`,
   `AC-D13`, `AC-D14`, `AC-D16`, `AC-D22` and `AC-D24` are all Playwright, and no CI
   job runs Playwright. Every phase gate lists `test:e2e` explicitly for this reason;
   skipping it ships the behaviour unverified while CI stays green.
2. **T3.2 touches a live `/inbox` surface.** How cleanly `HitlCard` splits is only
   knowable at implementation. T3.3 exists to catch a behaviour change there; if the
   existing inbox tests need editing, stop and re-plan rather than adapt them.
3. **ADR-174 collides** if another branch merges an ADR first. Recheck against master
   before the docs checkpoint.
4. **This host runs Node 26.3.0 while the repo pins `>=24.15.0 <25`** — every pnpm
   invocation warns. The docs gates pass regardless, but the suites are the gates that
   matter and Node 26 has previously produced process kill/recovery hangs here. Switch
   Node before trusting a red or green from gate 2.

## Out of scope, tracked

Enumerated in the spec's `## Non-goals` with reasons. The two carrying follow-ups:

- **`queryTokensSpentSince`** measures the lifetime cost of runs merely *started* in
  the window, and `run_cost_rollups` has no time dimension (PK `runId`), so a true
  per-period figure is not computable from it. Spun out as its own task; it must not
  be closed by deleting the clause from the ADR-173 payload without deciding what the
  number should mean.
- **`/work` expandable rows** — T4.2 designs the prop for it; the follow-up turns it
  on and answers what a backlog or settled row expands into.

## Open questions

None. The five carried into planning were resolved and recorded in the spec; the four
raised after the first cut were answered by the owner on 2026-09-17 (drop columns at
narrow widths; the Phase-0 docs-first resolution; `/work` adopts expansion later;
tokens spun out).
