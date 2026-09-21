# Observatory overview, period, and in-section navigation — design

**Date:** 2026-09-21 · **Routes:** `/observatory`, `/projects/{slug}/observatory`
· **Source:** `web/app/(app)/observatory/page.tsx`,
`web/app/(app)/projects/[slug]/observatory/page.tsx`,
`web/components/observatory/*`, `web/lib/queries/observatory*.ts`
· **Status:** Accepted (2026-09-21, owner) — implementation plan
[`../../.ai-factory/plans/claude-observatory-layout-navigation-4d13e6.md`](../../.ai-factory/plans/claude-observatory-layout-navigation-4d13e6.md);
ADR-177 is written in that plan's Phase 0.

Rewrites the layout half of [`../screens/observatory.md`](../screens/observatory.md)
(§"Navigation", §"Layout & regions") and amends the cost-window statements in
[`../system-analytics/observatory.md`](../system-analytics/observatory.md).
The formulas locked by ADR-059 / ADR-073 / ADR-134 are untouched.

## The problem this solves

Three defects, all visible on the portfolio page today:

1. **The first screen is the wrong ledger.** The page opens with the
   flow-ledger summary: three tiles (correction rate, rework, retries) plus the
   node heatmap, laid out as a two-column grid whose left column stretches to
   the height of a 360px aside (Autonomy Score, Signals, Artifacts). On a
   window with no flow `node_attempts` the left column is three zeros and an
   empty "Nodes" card, the aside is three empty states, and together they fill
   the viewport with nothing. Scratch- and agent-heavy projects see this
   permanently.
2. **There is no per-project view.** `getPortfolioObservatory` already
   computes `projects[]` (correction + autonomy per visible project) and
   `flows[]`; neither is rendered. The first questions the owner asks — how
   much did each project launch, where is it now, what came out — are not
   answerable anywhere in the section.
3. **The period is one `windowDays` number.** No custom range, no presets,
   and the cost panel ignores it: token totals are lifetime, which the label
   admits ("Stored lifetime cost; lookback does not filter token rollups").

The filter form also demands an explicit Apply, and half of its fields (flow,
node, artifact kind, artifact definition) are drill-down keys of the flow
ledger that mean nothing on a portfolio first screen.

## What the section is for

Settled with the owner on 2026-09-21: the Observatory answers, **for a chosen
period and per project, what was launched, where it is now, and what came
out**; then **what it cost and on which models / runners / flows**; and only
then the process-quality ledgers (correction pressure, autonomy, signals,
harness). It stays read-only (ADR-059): no write, no git call from a request,
no new table.

The Desk answers "what is true now" with no window (ADR-174 D3). The
Observatory is its windowed counterpart, so the two must share one vocabulary:
the in-flight columns below are exactly `WORK_IN_FLIGHT_STAGES`
(`web/lib/work/stage.ts`), and no third stage vocabulary is introduced.

## Decisions

### D1 — Period: whole UTC days, presets plus a custom range

- URL: `windowDays=7|30|90` (preset) **or** `from=YYYY-MM-DD&to=YYYY-MM-DD`
  (custom, both inclusive). When both are present, `from`/`to` wins. Absent →
  `windowDays=30`. Any other `windowDays` value is accepted and clamped to
  `1..365` as today, so every existing drill-down link keeps working.
- Resolution to `[since, until)`: preset `N` → `since = startOfUtcDay(now) −
  (N − 1) days`, `until = startOfUtcDay(now) + 1 day`; custom → `since =
  dateStart(from)`, `until = nextDateStart(to)` — the exact helpers `/runs`
  already uses. A span over 365 days is clamped by moving `since` forward; the
  bar renders the effective values, never the requested ones.
  `from > to`, or an unparsable date, drops the custom range and the preset
  default applies (owner, 2026-09-21).
- Every windowed read in the section switches from `now − windowDays` to
  `[since, until)`: correction, autonomy, signals, artifacts, harness and the
  node drill-down (`runs.started_at`); budget (`domain_events.occurred_at`);
  agentization (daily buckets; the cache horizon is
  `REPO_DELIVERY_WINDOW_DAYS = 365`, so the existing "insufficient" state
  already covers a range the cache does not reach); **and cost** (new, D5).
- Why day-aligned: the drill-down target (`/runs`) filters by whole UTC days,
  so a rolling `now − 30d` bound can never yield the same count as the list it
  links to. Day alignment makes "count = list" hold by construction. The only
  observable change versus today is that a preset window starts at 00:00Z of
  its first day rather than at the current time of day.

### D2 — "Work launched": runs by start, tasks by overlap

Runs are events. A run counts in the period when `runs.started_at ∈ [since,
until)`, bucketed by `run_kind` (`flow | scratch | agent`); orchestrator
children count as runs of their own kind.

Tasks are states. A task counts as **in work in the period** when it has at
least one `flow` run whose in-work interval overlaps the period. The interval
is `[started_at, settled_at)` with `settled_at = ended_at` when `status ∈
{Done, Failed, Abandoned}` and open otherwise: `Review` and `Crashed` carry an
`ended_at` (agent exit / crash) but are not settled, and a promoted run
receives a fresh `ended_at` at promotion finalize (`web/lib/runs/promote.ts`),
so for a delivered run `settled_at` is the promotion time. The secondary
number, **taken into work in the period**, counts tasks whose earliest flow
run started in the period.

No new column is needed. `tasks.status = 'InFlight'` is written in the same
transaction as the launching run's insert (`web/lib/services/runs.ts`), so
`min(runs.started_at)` per task is the durable "taken into work" moment; the
owner's fallback ("select by last change, or stamp the first launch on the
ticket") is therefore not required.

### D3 — One outcome bucket per run, shared by the overview and the ledger

Every run falls into exactly one bucket. The in-flight buckets are
`WORK_IN_FLIGHT_STAGES` by name; the settled buckets refine `WorkStage`'s
`Promoted` / `Abandoned` / `Ready`(Failed) with the PR lifecycle
(ADR-140/141):

| Bucket | Rule |
| --- | --- |
| `Queued` | `status = Pending` |
| `Executing` | `status ∈ {Running, WaitingOnChildren}` |
| `WaitingOnHuman` | `status ∈ {NeedsInput, NeedsInputIdle, HumanWorking}` |
| `Review` | `status = Review` and the workspace is not removed |
| `Crashed` | `status = Crashed` and the workspace is not removed |
| `Delivered` | `status = Done` and `workspaces.promotion_state = 'done'` and (`promotion_mode <> 'pull_request'` or `pr_state = 'merged'`) |
| `PrOpen` | `status = Done` and `promotion_state = 'done'` and `promotion_mode = 'pull_request'` and `pr_state ∈ {open, NULL}` |
| `ResultOnly` | `status = Done` and (`promotion_state = 'none'` or no workspace row) — ADR-165 result-only flows, agent runs without a worktree |
| `Failed` | `status = Failed` |
| `Abandoned` | `status = Abandoned`; **or** `Done` + `pull_request` + `pr_state = 'closed'` (closed without merge); **or** `Review` / `Crashed` with `workspaces.removed_at` set (the board's "historical evidence" rule in `deriveStage` / `deriveWorkStage`) |

Workspace columns are read from the run's **latest** `workspaces` row (`ORDER BY
created_at DESC, id ASC LIMIT 1`) — `workspaces.run_id` is not unique and the
`/runs` ledger already selects the branch this way, so both surfaces read the
same row.

`Done` never coexists with `promotion_state ∈ {claiming, failed, reopened}`
(a finalize failure leaves the run in `Review`; reopen flips it back to
`Review`), so the table is total over reachable rows.

The classification is **one SQL `CASE` fragment** (`runOutcomeBucketSql`)
used by both the overview's `GROUP BY` and the `/runs` ledger's new `bucket`
predicate, so a cell's count and the list it opens cannot disagree — the
ADR-169 "one query, one meaning" principle. A compile-time `satisfies` pins the
in-flight bucket names to `WorkInFlightStage`; an integration matrix over all
11 run statuses × promotion / PR / removed-workspace combinations pins the
rules. No `WorkStage` or bucket value is ever persisted (M51 `STG` rule).

### D4 — Rows: visible projects plus one Platform row

- One row per visible project (`getVisibleProjects`), sorted by name, and a
  totals row.
- **Platform row**: runs with `project_id IS NULL`. Today that is exactly the
  Studio assistant scratch run (ADR-097). Agent runs always carry a project —
  `agent_project_links.project_id` and `agent_schedules.project_id` are NOT
  NULL and `launchAgentRun` requires `projectId` — so the owner's "platform
  agent runs on their own row" is satisfied structurally and stays correct if a
  project-less agent kind appears later. Visible to global `admin` only;
  rendered only when it holds at least one run in the period; task cells
  empty.
- Project page: the project's own row, then a breakdown: one sub-row per flow
  (`flows.flow_ref_id`) for flow runs, plus `scratch` and `agent` sub-rows.

### D5 — Cost is windowed and gains "By flow"

`getCostSummary` already joins `runs`; it now applies `runs.started_at ∈
[since, until)` to both rollup tables. The "stored lifetime" caveat
disappears; the Cost view says "for the selected period". A third breakdown
card, **By flow**, keys `run_cost_rollups.flow_id → flows.flow_ref_id`, with
`scratch` and `agent` pseudo-rows for flow-less kinds. Tokens only — USD stays
out (M51 non-goal; ADR-101 defers pricing).

### D6 — Navigation: four URL views under one filter bar

`view=overview|cost|quality|harness`, default `overview`; default `quality`
when `flowId`, `nodeId`, `artifactKind` or `artifactDefId` is present without
`view`, so pre-existing drill-down links still land where their filters apply.
Rendered with the shared `Tabs` primitive in href mode (URL state,
`docs/screens/components.md`); the project page keeps `ProjectTabs` above it.

| View | Portfolio | Project |
| --- | --- | --- |
| Overview | overview table with totals and the Platform row; compact cost strip (period total, top models / runners / flows, link to Cost) | overview row plus per-flow breakdown; compact cost strip; Agentization; Run autonomy funnel |
| Cost | token tiles, By model, By runner, **By flow**, By run kind, Budget pressure | same |
| Quality | correction tiles; **per-project quality table** (`projects[]`: flow runs, rework, retries, correction rate, autonomy, wait); node heatmap; Autonomy Score; Signals; Artifacts | correction tiles; **per-flow quality table** (`flows[]`); heatmap; Autonomy Score; Signals; Artifacts; node drill-down |
| Harness | Sensor firing, Control effectiveness, Coverage map | same |

For `runKind ∈ {scratch, agent}` the Quality and Harness views render the
existing not-applicable state as the whole view. The Quality layout drops the
fixed 360px aside: cards flow in a responsive grid with `items-start`, so an
empty ledger is one short empty-state card, not a viewport.

### D7 — Filter bar without Apply

A client component owns the bar. Every change calls `router.replace` with the
new query (`scroll: false`) inside a transition, and the bar shows a busy
indicator (`aria-busy`) until the server component has re-rendered. Controls
commit on `change` (presets, selects, date inputs) and on blur / Enter
(free-text flow, node and artifact fields). Fields per view: period and run
kind everywhere; project (portfolio only, `project=<slug>`); flow and node on
Quality and Harness; artifact kind and definition on Quality. Clearing a field
removes its param. This is the first no-Apply filter bar in the app; other
screens receive their own task (owner, 2026-09-21).

### D8 — Drill-down into the ledger

Every numeric run cell of the overview links to `/runs` with `project`,
`from`, `to`, `kind` and `bucket`; task cells link to the project board. The
ledger gains `kind=flow|scratch|agent` and `bucket=<D3 name>`, both parsed by
`normalizeRunsListFilters` through the existing `oneOf` guard and both rendered
as selects in its filter form; `bucket` filters through the D3 fragment.

## Page order (portfolio, Overview view)

```
Header: eyebrow · H1 · subtitle
[ 7d | 30d | 90d | custom ] [from] [to]   [Run kind ▾] [Project ▾]        ⟳
[ Overview ] [ Cost ] [ Quality ] [ Harness ]

Project  | Tasks       | Runs               | In flight                            | Settled
         | in work new | flow scratch agent | queued exec waiting review crashed   | delivered pr-open result failed abandoned
maister  |   14    9   |  22    9      3    |   0     2      1      3      1       |   15       1       2      4       1
tausik   |    3    3   |   5    0      0    |   0     0      0      1      0       |    3       0       0      1       0
Platform |    –    –   |   0    4      0    |   0     1      0      0      0       |    0       0       3      0       0
Total    |   17   12   |  27   13      3    |   0     3      1      4      1       |   18       1       5      5       1
                                                                     live · 2 runs still active

Cost for the period: 1.2M tokens · by model … · by runner … · by flow …   → Cost
```

Numbers are illustrative. Each run cell is a link (D8); the `live` marker is
the existing `volatile` convention.

## Data and read model

- New `getObservatoryOverview(client, scope, period, runKind)` in
  `web/lib/queries/observatory-overview.ts`: two grouped SELECTs regardless of
  project count — runs by `(project_id, run_kind, bucket)` and tasks by
  `project_id` (overlap rule and first-start rule in one aggregate) — plus the
  project-less group when the caller is a global admin. Returns
  `rows: OverviewRow[]`, `platform: OverviewRow | null`, `totals`, `volatile`.
- `ObservatoryFilters` carries `since` / `until` (`Date`) instead of deriving a
  window from `windowDays` inside each query; `parseObservatorySearchParams`
  resolves D1 and returns the effective `current` values for the bar.
- `getCostSummary` gains the period predicate and `byFlow`.
- Shared fragment `runOutcomeBucketSql(alias)` in
  `web/lib/runs/outcome-bucket.ts`, imported by the overview and by
  `runs-list.ts`.
- No schema change and no new index (ADR-059: an index becomes an explicit
  migration task if volume proves the need).

## Documentation this invalidates

- `docs/screens/observatory.md` — Navigation, Layout & regions, States (view
  axis, Platform row, no-Apply bar).
- `docs/system-analytics/observatory.md` — scope entity (period), cost
  dimension ("lifetime" statements), the ADR-134 panel table's Cost row,
  expectations; add the overview read model and the D3 table.
- `docs/system-analytics/runs.md` — Runs ledger UI filter list.
- `docs/screens/runs/list.md` — ledger filter list (`kind`, `bucket`).
- `web/lib/queries/digest.ts` — the Desk `tokens` tile points at
  `/observatory?view=cost` (its test pins the href list).
- `docs/screens/components.md` — record the no-Apply filter bar as the
  reference pattern.
- `docs/decisions.md` and `docs/decisions/adr-177.md` — this decision set.
- `web/e2e/m23-observatory.spec.ts`,
  `web/e2e/observatory-cost-breakdown.spec.ts` — headings now live under
  `?view=…`.

## Out of scope

USD cost; any change to the run or task state machines; persisting stages or
buckets; a portfolio-level agentization headline (ADR-134 keeps it per
project); no-Apply filters on other screens; an instance timezone for day
boundaries (UTC, as `/runs`); HeroUI `DateRangePicker` (native date inputs,
consistent with `/runs`).

## Resolved questions (owner, 2026-09-21)

1. Platform row visibility: **global admin only** — project-less runs have no
   membership to scope by.
2. "PR closed without merge" and removed-workspace `Review` / `Crashed` fold
   into **`Abandoned`** by the one explicit rule in D3; five settled columns.
3. `from > to` (or an unparsable date) **drops the custom range**; the preset
   default applies and the bar shows the effective period.
