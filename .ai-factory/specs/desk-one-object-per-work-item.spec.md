# Desk — one object per work item (ADR-174)

**Date:** 2026-09-17
**Status:** Specification — not implemented
**Plan:** [`../plans/claude-desktop-visual-redesign-1bef2c.md`](../plans/claude-desktop-visual-redesign-1bef2c.md)
**Design rationale:** [`../../docs/plans/2026-09-17-desk-visual-redesign-design.md`](../../docs/plans/2026-09-17-desk-visual-redesign-design.md)

## Purpose

The Desk (`/`) renders a handful of work items as several times that many visual
objects. One task was observed four times on one screen — in the rail's active
workspaces, as a HITL card, as a promotable card, and as a work-table row — and a
second task the same four times plus six activity rows. Two tasks, roughly sixteen
objects.

The duplication is structural.
[`STAGE_BY_KIND`](../../web/lib/queries/decisions.ts) maps three of the four decision
populations onto stages that are members of
[`WORK_IN_FLIGHT_STAGES`](../../web/lib/work/stage.ts):

| Decision kind | Stage | In `WORK_IN_FLIGHT_STAGES`? |
| --- | --- | --- |
| `hitl` | `WaitingOnHuman` | yes |
| `crashed` | `Crashed` | yes |
| `promotable` | `Review` | yes |
| `flagged` | `Held` | **no** — `WORK_BACKLOG_STAGES` |

So the Decisions region and the work table are, for three populations out of four,
two renderings of one population. Reordering the page moves the copies closer
together; only merging them removes the duplication.

A second, independent duplication: the digest sentence and the Now tiles are the same
five numbers rendered as words and then as digits, adjacent — by construction, as
`web/lib/queries/digest.ts` documents in its own comments.

## Scope source

Owner brainstorming session, 2026-09-17. Decisions taken there and treated as fixed
input to this specification:

1. The Desk is a **state-of-the-platform summary** — not a triage queue and not a live
   control room. The usage pattern is not yet known, so the design optimizes for
   legibility under growth rather than for one workflow.
2. Quiet projects are **out of scope** — they live on `/projects`.
3. The work table, grouped by project, becomes the spine of the page.
4. Duplication is resolved by **merging the decision into the row**, not by splitting
   the populations across regions.
5. The number strip is **current state only** — no period, no selector, no window.
6. Repeated activity events are **not collapsed**; chronology is the feed's point.
7. `/work` gains expandable rows in a **later** increment.

## Verified baseline (read before implementing)

Every claim below was checked against the tree at
`claude/desktop-visual-redesign-1bef2c`, not inferred.

- `web/components/attention/now-tiles.tsx` has exactly **one** consumer, the Desk. It
  is free to change shape.
- `web/components/work/work-rows-table.tsx` has **two** consumers — the Desk and
  `/work` via `web/components/work/work-table.tsx` — and
  `WorkTableLabels extends WorkRowsLabels` deliberately, so a column change is a
  compile error at both call sites (ADR-172 amendment 2). It must not be forked.
- `WorkTableRow` carries `runId` and `runStatus`, and **not** `hitlRequestId`.
- `hitlDecisionsOf(queue.items)` returns `CrossProjectHitlItem[]`, each carrying
  `runId`. The Desk page already loads both `queue` and `table`, so the row→decision
  join needs **no** read-model change.
- `HitlCard` is a **client component and monolithic**: its own `useState` expansion,
  its own header toggle, a lazy `GET /api/runs/:id/inbox-context` on first expand, and
  a trailing `RunHitlResponse`. Its `ExpandedContext` helper is private and takes an
  already-loaded context.
- `DecisionCard` is synchronous with no server-only imports — it renders inside a
  client parent without a boundary problem. Its `promotable` arm is a **link** to
  `/runs/:id`, never an inline promote, because the drift-guarded reviewed target
  commit exists only on the run's review surface.
- **Nothing in this repository expands a `<tr>`.** `<details>` cannot wrap a table
  row. The transferable idiom is `useState(open)` + `aria-expanded` + a conditionally
  rendered sibling.
- `/work` keeps filter and grouping state **in the URL**, submitted by a plain
  `<form action="/work">`; only the saved-view list is `localStorage`.
- Both vitest projects are `environment: "node"`, but that does **not** mean a
  click cannot be simulated in vitest. **Corrected 2026-09-17, during Phase 1:**
  the repository has an established per-file idiom — a `// @vitest-environment
  jsdom` pragma atop a `*.dom.test.ts`, driven with `react-dom/client` + `act()`.
  There are **28** such files, `jsdom@25.0.1` is installed, and they are
  collected by the `unit` project, which **CI runs**. "No jsdom project" is true
  and irrelevant; it had been used to route all interaction proof to Playwright,
  which CI does not run.
- **Playwright does not run in CI.** CI enforces lint, typecheck, `test:unit`,
  `test:integration`, `validate:docs:all` and `validate:contracts` — nothing else.
  `test:e2e` and `validate:m51-coverage` are manual gates.
- `desk.sub` and `desk.nowLabel` are **already orphan keys** — nothing renders them.
  `desk-contract.test.ts` checks EN/RU key parity, not usage, so nothing catches this.

## Requirements

Normative. `MUST` / `MUST NOT` are binding; each is traced to an acceptance criterion
below.

### Feature A — the Now strip

| ID | Requirement |
| --- | --- |
| **REQ-D1** | The strip MUST render exactly the five `WORK_IN_FLIGHT_STAGES` members — `Queued`, `Executing`, `WaitingOnHuman`, `Review`, `Crashed` — one tile each, in that order. All five MUST render even at zero; a strip whose tiles appear and disappear destroys the fixed positions a reader scans by. |
| **REQ-D2** | Tile counts MUST be derived from the same row array the table renders, so the strip and the table are one population by construction. The implementation MUST add no database query. The sum of the five tiles MUST equal the **total** work in flight, NOT the number of visible rows — the table slices to `DESK_WORK_ROWS`. |
| **REQ-D3** | Activating a tile MUST filter the table in place via `?stage=<WorkStage>` on `/`, and MUST NOT navigate away from the Desk. The filter MUST be applied **before** the row slice. An absent, unknown, or non-in-flight `stage` value MUST render the unfiltered Desk, never an error. |
| **REQ-D4** | The Desk MUST render no time window, no digest sentence and no period selector. `formatDigest` and `getNowTileCounts` MUST remain in the codebase for the ADR-173 notification trigger, and their existing tests MUST stay green unmodified. |
| **REQ-D5** | An active filter MUST survive the attention-stream refetch tick. |
| **REQ-D6** | A filter matching zero rows MUST render a filtered-empty state that names the active filter and offers to clear it. It MUST be distinguishable from the unfiltered "nothing is running" state — otherwise a filtered Desk reads as a dead platform. |

### Feature B — the shared work table

| ID | Requirement |
| --- | --- |
| **REQ-D7** | The `project` column MUST be hidden when and only when `groupBy === "project"`, at **both** surfaces. The rule is grouping-derived, not surface-derived: under project grouping the group header already names the project. |
| **REQ-D8** | The column rendering the raw `runStatus` enum MUST be removed. The distinction it carried MUST move into `WorkStageChip`: `STAGE_BY_RUN_STATUS` is many-to-one, and `NeedsInput` / `NeedsInputIdle` / `HumanWorking` (a live session, a checkpoint, a manual takeover) collapse into one chip, as do `Running` / `WaitingOnChildren`. The new chip input MUST be optional, and a chip given none MUST render exactly as before — `decision-card.tsx` and `hitl-card.tsx` pass none. |
| **REQ-D9** | The run link MUST survive as a trailing affordance carrying an accessible name. Removing the column MUST NOT remove the ability to open the run. |
| **REQ-D10** | `nextAction` MUST render as an affordance per the project's UI convention. `workNextAction(stage) === "none"` MUST render an em dash, not a sentence. `workNextAction` MUST remain a pure function of the stage. |
| **REQ-D11** | Narrow viewports MUST drop columns by priority (`tokens`, `readiness` first) instead of scrolling horizontally. Because hiding is CSS-driven the `<td>` elements remain in the DOM, so any `colSpan` MUST be the **full** column count, never the visible count. |
| **REQ-D12** | `/work` behaviour MUST be otherwise unchanged. Row expansion MUST be behind a prop defaulting to off. The component MUST NOT be forked. |

### Feature C — expandable rows (Desk only)

| ID | Requirement |
| --- | --- |
| **REQ-D13** | A row MUST expand on full-row activation, MUST be operable from the keyboard, and MUST carry `aria-expanded`. Links and buttons inside the row MUST NOT toggle it. |
| **REQ-D14** | Panel content MUST resolve by stage: `WaitingOnHuman` → the HITL panel; `Review` → a **link** to the run's review surface, never an inline promote; `Crashed` → recover/discard; `Executing`/`Queued` → that run's recent events. |
| **REQ-D15** | The row→decision join MUST be on `runId`, built in the page from the queue it already loads. `getWorkTable` MUST NOT be modified, and MUST gain nothing Desk-shaped or decision-shaped. The page MUST keep reading the canonical queue through `@/lib/queries/decisions`. **Amended 2026-09-17, during Phase 4:** this originally also required the literal `hitlDecisionsOf(queue.items)` to remain. `REQ-D14` removes that call's only consumer — the HITL list in the Decisions region — so keeping the literal would mean keeping a call whose result nothing reads. Dead code pinned by a test is worse than no assertion: it looks like a contract and is only a fossil. The invariant that mattered — the Desk reads the ONE canonical queue and recomputes nothing — is preserved and still asserted. |
| **REQ-D16** | The HITL panel MUST fetch `inbox-context` on **first expand only**, never on mount — the Desk may hold many `WaitingOnHuman` rows, and a mount-time fetch would fire one request per row on page load. Its loading and error branches MUST be preserved; a panel that fails silently is worse than the card it replaces. |
| **REQ-D17** | `HitlCard` MUST be rebuilt on the extracted panel so `/inbox` and the Desk render **one** implementation. A second copy is the drift ADR-172 D1 exists to prevent. |
| **REQ-D18** | The Desk MUST add no mutation path. Every action MUST post to the route `/inbox` already uses. |

### Feature D — activity

| ID | Requirement |
| --- | --- |
| **REQ-D19** | Every feed row MUST name its subject. When no task is joined the row MUST fall back to a short run id. A row reading only time + kind + actor + link is not information, and this degradation hits `run.crashed`, the highest-signal kind. |
| **REQ-D20** | Repeated events MUST NOT be collapsed, grouped or reordered. Chronological order is the feed's contract. |

### Feature E — layout, identity and i18n

| ID | Requirement |
| --- | --- |
| **REQ-D21** | The Desk MUST be a single column at every width, ordered header · strip · work · Held · activity. |
| **REQ-D22** | The scratch composer MUST be removed outright. The rail already renders the launcher with the global Cmd/Ctrl+K listener, so no capability is lost. |
| **REQ-D23** | Every key in the `desk` message namespace MUST have a render site. Keys this change orphans MUST be pruned from **both** catalogs in the same edit, preserving EN/RU parity. A key-coverage assertion MUST enforce this — parity alone does not, which is how `desk.sub` and `desk.nowLabel` became orphans. |
| **REQ-D24** | One work item MUST appear as exactly one object on the Desk. This is the change's reason for existing and MUST be asserted, not assumed. Declared as **`NAV-08`** in `docs/system-analytics/home-navigation.md`. |

## API contract

**No route is added, removed, or changed.** Verified, not assumed: grepping the entire
changed file set for `/api/` yields exactly one endpoint —
`GET /api/runs/{runId}/inbox-context`, called from `hitl-card.tsx`.

That endpoint is already specified at `docs/api/web.openapi.yaml:5745` and its route
exists at `web/app/api/runs/[runId]/inbox-context/route.ts`. REQ-D16/REQ-D17 move the
**call site** into the extracted panel; the request shape, response shape and status
codes are untouched, so no OpenAPI edit is required.

Binding consequence: if implementation finds itself changing that call — adding a
parameter, batching it across rows, changing its error handling — the OpenAPI entry
becomes in scope in the same commit, per the project's contract-symmetry rule. The
`?stage=` filter of REQ-D3 is a **page search parameter**, not an API route, and has no
OpenAPI surface.

## DB contract

**No migration.** No table, column, index, constraint or enum value changes. REQ-D15
exists precisely so the row→decision join needs no read-model change.

The newest journal entry is `0169_cutover_writer_floor`, so **`0170`** is the next free
number should this ever stop being true. `web/lib/db/schema.ts` is untouched, and
`drizzle-kit generate` must therefore report "No schema changes" at every phase — that
report is the check, not an assumption.

## System-analytics contract

No new domain, so no new `docs/system-analytics/*.md`. The Desk is owned by
`home-navigation.md`, and the changes land there.

| Artifact | Change |
| --- | --- |
| `docs/system-analytics/home-navigation.md` | **New** `NAV-08` (REQ-D24). **Amend** `EDGE-NAV-01` — it currently reads "…the scratch composer is absent until a project exists"; the composer is now absent unconditionally. **Amend** `EDGE-NAV-02` — it currently names the stack order "Decisions, then Work, then Activity" and asserts the table scrolls inside its own container; both halves change. |
| `docs/system-analytics/m51-traceability.md` | Row for `NAV-08`; updated rows for `EDGE-NAV-01` / `EDGE-NAV-02`. Every `Primary test` cell must resolve to a real `describe`/`it` title under `web/`. |
| `docs/system-analytics/attention.md` | **No change.** `ATN-05` reads "Every surface MUST render one layout-level `decisions` value; no surface may recompute its own" — surface-agnostic, and it survives. Only its Desk-side *assertion* moves to `/inbox`. |
| `docs/screens/desk.md` | §"Layout & regions" and §"As built" rewritten. |
| `docs/screens/work.md` | The **three** "view-only" clauses (roles table, layout, next action) scoped to `/work` explicitly. Also correct a pre-existing drift: it specifies a "run dot" while the code ships raw enum text — REQ-D8 moves the code toward the spec. |
| `docs/decisions/adr-174.md` + `docs/decisions.md` | New ADR, successor to ADR-172 D1. |

Gate note: `validate-docs-indexes.mjs` (CI) fails when a declared id has no matrix row
or a blank primary-test cell. `validate-m51-coverage.mjs` additionally proves each
cited test id resolves — and **is not run by CI**. Declaring `NAV-08` before its test
exists therefore turns CI red, which is why REQ-D24's declaration, matrix row and test
land in one commit.

## Acceptance criteria traceability

`unit` = vitest project `unit` · `e2e` = Playwright (`authed` project, **not in CI**).

**Layering rule — this is what keeps overlap minimal.** Each requirement is proved at
the *cheapest layer that can actually prove it*, and at exactly one layer:

- pure computation → `unit`, pure function, no rendering;
- markup given props → `unit` via `renderToStaticMarkup`;
- structural invariants readable from source → `unit`, the source-contract test;
- **interaction on a mounted component** (a click, a key, a fetch that must not
  fire) → `unit` via a `*.dom.test.ts` jsdom pragma, because that runs in CI;
- anything requiring real layout, a viewport, navigation or a URL → `e2e`, the
  only layer that can see those, and the one CI does not run.

The interaction layer is preferred over `e2e` wherever it can carry the proof: a
guard in the lane CI runs is worth more than the same guard in a lane that is
green because nobody ran it.

**Forbidden:** "renders without crashing", "the export is defined", snapshot-only
assertions, and re-asserting one requirement at two layers.

| AC | Criterion | Requirements | Test |
| --- | --- | --- | --- |
| **AC-D1** | The count map has exactly the five in-flight members and its values sum to the input length; a row set larger than `DESK_WORK_ROWS` still sums to the total | REQ-D1, REQ-D2 | T-D1 (unit, pure) |
| **AC-D2** | The Desk page calls no query beyond those it already made — asserted on source: no new `await` on a `lib/queries/*` import | REQ-D2 | T-D2 (unit, source contract) |
| **AC-D3** | `?stage=Crashed` narrows the table to crashed rows and the URL stays on `/`; an unknown value renders unfiltered; the filter narrows before the slice | REQ-D3 | T-D3 (e2e, 3 cases) |
| **AC-D4** | The Desk source contains no `formatDigest`/`getNowTileCounts` call and no `desk-digest` testid, while `digest.test.ts` and `digest.integration.test.ts` pass unmodified | REQ-D4 | T-D4 (unit, source contract + the untouched digest suites) |
| **AC-D5** | An active filter is still applied after a refetch tick | REQ-D5 | T-D5 (e2e) |
| **AC-D6** | A filter matching zero rows renders the filtered-empty state naming the filter, distinct from the unfiltered empty copy | REQ-D6 | T-D6 (e2e) |
| **AC-D7** | Under `group=project` no project cell renders; under every other grouping it does — at both surfaces | REQ-D7 | T-D7 (unit, markup, 2 cases) |
| **AC-D8** | Each of `NeedsInput` / `NeedsInputIdle` / `HumanWorking` yields a distinguishable accessible name; `Running` and `WaitingOnChildren` likewise; a chip given no run status renders byte-identically to the pre-change output | REQ-D8 | T-D8 (unit, markup, 6 cases incl. the negative) |
| **AC-D9** | The run remains reachable from the row by an affordance with an accessible name | REQ-D9 | T-D9 (unit, markup) |
| **AC-D10** | A `none` next action renders an em dash; a non-`none` one renders the affordance | REQ-D10 | T-D10 (unit, markup, 2 cases) |
| **AC-D11** | At 390px the low-priority columns are not visible, the page does not scroll horizontally, and the expanded row's cell still spans the full width | REQ-D11 | T-D11 (e2e, short viewport) |
| **AC-D12** | `/work` renders no expand affordance and its row markup is otherwise unchanged | REQ-D12 | T-D12 (unit, markup, negative) |
| **AC-D13** | Clicking a row expands it; Enter and Space do the same; `aria-expanded` flips; clicking a link inside the row does not toggle | REQ-D13 | T-D13 (unit, jsdom, 4 cases) |
| **AC-D14** | Each stage expands to its own panel; the `Review` panel exposes a link and no promote control | REQ-D14 | T-D14 (e2e, 4 stages + the negative) |
| **AC-D15** | The page builds `decisionByRunId` from `queue.items`, still imports from `@/lib/queries/decisions`, calls `getWorkTable` with its original arguments, and `lib/queries/work-table.ts` mentions neither the Desk nor a decision | REQ-D15 | T-D15 (unit, source contract) |
| **AC-D16** | No `inbox-context` request is issued while every row is collapsed; expanding one issues exactly one; a failing response renders the error branch | REQ-D16 | T-D16 (unit, jsdom, 3 cases, `fetch` stubbed) |
| **AC-D17** | `hitl-card.tsx` contains no second copy of the panel body — it renders the extracted panel | REQ-D17 | T-D17 (unit, source contract) |
| **AC-D18** | The Desk source contains no `"use server"`, no `fetch(`, and no `method: "POST"` | REQ-D18 | T-D18 (unit, source contract — the existing assertion, retained) |
| **AC-D19** | A feed row whose task join is absent still names its run; one with a task names the task | REQ-D19 | T-D19 (unit, markup, 2 cases) |
| **AC-D20** | Given events out of natural order, rendered order matches input order and the row count equals the input count | REQ-D20 | T-D20 (unit, markup) |
| **AC-D21** | The Desk source carries no `xl:grid-cols-` / `xl:col-start-` classes, and region testids appear in the order strip → work → held → activity | REQ-D21 | T-D21 (unit, source contract) |
| **AC-D22** | No scratch-run control renders on the Desk, with projects or without | REQ-D22 | T-D22 (e2e, 2 fixtures) |
| **AC-D23** | Every key in `en.desk` has a render site in `app/(app)/page.tsx`; EN and RU key sets are identical; every `*Count` key carries `$count` | REQ-D23 | T-D23 (unit, source contract — the coverage half is new) |
| **AC-D24** | For a seeded task that is simultaneously in flight and blocked on a human, the Desk renders exactly one object naming it | REQ-D24 | `E2E-NAV-08` (e2e — id is m51-matrix-facing and must appear verbatim in the test title) |

## Non-goals

- Project cards on the Desk. Quiet projects live on `/projects` (scope source 2).
- Expandable rows on `/work` — a later increment (scope source 7). The prop is
  designed for it; turning it on, and deciding what a backlog or settled row expands
  into, is not in this change.
- Collapsing or grouping repeated activity events (REQ-D20, scope source 6).
- Idea-mode intake, paging, any change to `/inbox`'s own surface.
- **Moving the remaining e2e cases into jsdom.** `AC-D3`, `AC-D5`, `AC-D6`,
  `AC-D11`, `AC-D14`, `AC-D22` and `AC-D24` each turn on a URL, a viewport, real
  layout, or navigation between pages; jsdom can see none of those, so they stay
  in Playwright and stay outside CI.
- **Fixing `queryTokensSpentSince`.** It filters `runs.startedAt >= since`, summing the
  lifetime cost of runs that merely *started* in the window, and `run_cost_rollups` has
  no time dimension at all (PK `runId`), so a true per-period figure is not computable
  from it. This change removes the tokens tile; the ADR-173 push payload still prints
  the clause. Spun out as its own task.
- Any change to the run or task state machines, to `WORK_STAGES`, or to the decision
  queue's composition.

## Linked artifacts

- [ADR-174](../../docs/decisions/adr-174.md) (to be written) · [ADR-172](../../docs/decisions/adr-172.md) · [ADR-169](../../docs/decisions.md) · [ADR-173](../../docs/decisions.md)
- [`docs/screens/desk.md`](../../docs/screens/desk.md) · [`docs/screens/work.md`](../../docs/screens/work.md)
- [`docs/system-analytics/home-navigation.md`](../../docs/system-analytics/home-navigation.md) · [`docs/system-analytics/attention.md`](../../docs/system-analytics/attention.md) · [`docs/system-analytics/m51-traceability.md`](../../docs/system-analytics/m51-traceability.md)
- [`docs/api/web.openapi.yaml`](../../docs/api/web.openapi.yaml) (`/api/runs/{runId}/inbox-context`, unchanged)
