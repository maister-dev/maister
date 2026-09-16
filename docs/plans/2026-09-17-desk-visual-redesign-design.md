# Desk visual redesign — design

**Date:** 2026-09-17 · **Route:** `/` · **Source:** `web/app/(app)/page.tsx`
· **Status:** Design, not implemented.

Supersedes the layout half of [`../screens/desk.md`](../screens/desk.md)
§"Layout & regions" once built. Touches [ADR-172](../decisions/adr-172.md) D1,
which enumerates the composed regions.

## The problem this solves

The Desk is not hard to read because the blocks are in the wrong order. It is
hard to read because **a handful of work items are rendered as several times
that many visual objects**.

Counted from the shipped page, one task — `AID-1` — appears four times: in the
rail's active-workspace list, as a HITL card under Decisions, as a card under
"Готово к продвижению", and as a row in the work table. `MAI-4` appears the
same four times, plus roughly six rows in the activity feed. Two tasks, ~16
objects.

The duplication is structural, not accidental.
[`STAGE_BY_KIND`](../../web/lib/queries/decisions.ts) maps three of the four
decision populations onto stages that are members of
[`WORK_IN_FLIGHT_STAGES`](../../web/lib/work/stage.ts):

| Decision kind | Stage | In `WORK_IN_FLIGHT_STAGES`? |
| --- | --- | --- |
| `hitl` | `WaitingOnHuman` | yes |
| `crashed` | `Crashed` | yes |
| `promotable` | `Review` | yes |
| `flagged` | `Held` | **no** (backlog) |

So the Decisions region and the work table are, for three populations out of
four, two renderings of one population. Reordering the page moves the copies
closer together; it does not remove them.

A second, independent duplication: the digest sentence and the Now tiles are
the same five numbers rendered as words and then as digits, adjacent — by
construction, as `lib/queries/digest.ts` documents.

## What the Desk is for

Settled with the owner during design: the Desk is a **state-of-the-platform
summary** — projects, tasks, events, current work, the queue, and later
multiple supervisors — not a triage queue and not a live control room. The
usage pattern is not yet known (it needs dogfooding across teams and projects),
so the design does **not** optimize for one.

The one quality criterion available without that knowledge is that the page
must **survive growth**: one shouty entity must not be able to crowd out every
other region. The shipped page fails this — ten near-identical crash events fill
the whole activity region, and the decision region grows as 4 populations × N
projects.

Quiet projects are explicitly out of scope: they live on `/projects`.

## Page order

| # | Region | Answers |
| --- | --- | --- |
| 1 | Header | — (eyebrow + H1 only) |
| 2 | **Now strip** — 5 tiles | what the platform is doing right now |
| 3 | **Work** — grouped by project, expandable rows | what is running and what of it is on me |
| 4 | **Held** | what is asking for triage |
| 5 | **Activity** | what happened |

Removed: the scratch composer, the digest sentence, the Decisions region, and
the desktop two-column grid.

### 1. Header

The digest sentence is removed from the page. `formatDigest` and
`getNowTileCounts` stay in the codebase — the push-notification trigger
(ADR-173, `lib/notifications/digest-trigger.ts`) is their other consumer. The
Desk simply stops being one.

### 2. Now strip

Five tiles, and they are exactly `WORK_IN_FLIGHT_STAGES`:

```
Идёт N · В очереди N · Ждёт человека N · На ревью N · Упало N
```

Why this set rather than five chosen numbers:

- **Every run falls in exactly one tile.** Any set pairing "blocked on you"
  with "crashed" double-counts, because `crashed` is one of the decision kinds.
  Five large numbers that do not add up is how a dashboard loses trust.
- **The sum is the total work in flight.** The table below shows the first
  `DESK_WORK_ROWS` of that total, so the invariant is *sum = work in flight*,
  not *sum = visible rows*.
- **No new query.** The counts are computed from the rows `getWorkTable`
  already returns, which the page already filters through `isWorkInFlight`.
  Strip and table are one population *by construction* — the same discipline
  `ATN-05` applies to the badge.
- **The partition is already guaranteed.** `UT-STG-11` fails if an eleventh
  stage lands in no bucket, so a new run status cannot silently vanish from
  the home screen.

**A tile filters the table; it does not navigate away.** The shipped tiles link
to other surfaces, which takes the reader off the Desk instead of focusing it.
Filtering applies before the row slice.

**Window semantics are gone.** The shipped strip counts a window of
`cursor ?? now − 24h` that is stated nowhere in the UI, which is what made the
numbers unreadable — for a reader who is present all day the cursor keeps
moving and the numbers sit near zero (the shipped screenshot reads 0, 3, 0, 9,
0, with the zeros in the largest type on the page). State numbers need no
window and therefore need no label or selector. Zeros stay meaningful:
"в очереди 0" is a fact.

Cursor semantics survive where they belong: the unread divider in Activity and
the rail badge.

**The concurrency cap (`N/6`) does not go in the strip.** It is a property of
the platform, not of the work, and belongs in the status bar beside
"Супервизор готов" — which is also where multiple supervisors will land.

### 3. Work table

The spine of the page, grouped by project, moved up from the bottom.

**Columns: 11 → 8.**

- **`ПРОЕКТ` — cut.** Under project grouping the group header already carries
  it.
- **`ЗАПУСК` — reworked, not merely cut.** It renders `{row.runStatus}` — a raw
  English enum (`NeedsInput`, `Running`) in a Russian UI. It *looks* like a
  duplicate of the stage chip but is not: `STAGE_BY_RUN_STATUS` is
  many-to-one. For `Queued`, `Review` and `Crashed` the mapping is 1:1 and the
  column adds nothing; for the other two it carries a real distinction —
  `NeedsInput` / `NeedsInputIdle` / `HumanWorking` all collapse into one
  "Ждёт человека" chip, though they are a live session, a checkpoint and a
  manual takeover. That distinction moves **into the chip**; the raw-enum
  column goes; the run link becomes an icon at the end of the row.
- **`ДАЛЬШЕ` becomes an affordance**, per the project's icon-button
  convention. "Ничего — идёт работа" becomes `—`.

**Rows expand on a full-row click**, replacing the removed Decisions cards:

| Stage | Expanded panel |
| --- | --- |
| Ждёт человека | the `HitlCard` body — form/options, "Ревью кода", "Взять" |
| На ревью | "Проверить и продвинуть" |
| Упало | "Восстановить" / "Удалить" |
| Идёт / В очереди | that run's recent events |

No new mutation path: the panels post to the same promote / recover / discard /
HITL-respond routes `/inbox` uses, which is ADR-172 D1's rule and is unchanged.

**Narrow viewports drop columns by priority** (`ТОКЕНЫ`, `ГОТОВНОСТЬ` first)
rather than scrolling horizontally. A first-position block must not need a
horizontal scroll to be read; the shipped table is `min-w-[1180px]`.

### 4. Held

The only decision population that is not a subset of work in flight
(`Held` ∈ `WORK_BACKLOG_STAGES`). It survives as its own small region.

### 5. Activity

Full width, below the table. The right column existed to sit beside Decisions,
and Decisions is gone.

**One fix: guarantee the row a subject.** The task key and title render
conditionally (`row.taskKey && row.taskNumber !== null`, `row.taskTitle`), so
an event whose join misses degrades to

```
13h    сбой рана   system   Открыть ран              maister
```

— time, kind, actor, link, and **nothing about what crashed**. Ten such rows
cannot be told apart, and this hits `run.crashed`, the highest-signal kind.
When no task is joined, show the short run id. A row with no subject is not
information.

**Repeated events are NOT collapsed.** Considered and rejected by the owner:
grouping non-adjacent rows breaks the chronology that is the feed's whole
point, and collapsing only adjacent runs buys little. Once rows carry a
subject, ten crash rows for one run read as a crash loop — signal, not noise.
If volume still crowds the page, `DESK_ACTIVITY_ROWS` drops from 12 to 8; the
full feed is one click away.

**Per-run events live in the expanded row; the feed answers "what happened at
all", including to work no longer in flight.** The feed is *not* filtered to
exclude what the table shows — "everything except what is already on screen"
is a stranger rule than the problem it solves.

## Out of scope, but found on the way

**`queryTokensSpentSince` does not measure what its tile claimed.** It filters
`runs.startedAt >= since` (`lib/runs/cost-rollups.ts`), summing the **lifetime**
spend of runs that *started* in the window. A live run that started before the
window contributes nothing — which is why the tile read 0 while `MAI-4` showed
401,744,479 tokens. And it cannot be fixed cheaply: `run_cost_rollups` is one
row per run (PK `runId`) with no time dimension at all, so "tokens spent in a
period" is not computable from it.

The redesign removes the tokens tile, so the Desk no longer depends on this.
**The bug survives in the ADR-173 notification payload**, which still prints a
tokens clause with these semantics. Tracked, not fixed here.

## Documentation this invalidates

- `docs/screens/desk.md` — §"Layout & regions" and §"As built" are normative
  and describe the removed arrangement.
- `docs/decisions/adr-172.md` — **D1 enumerates the composed regions.** Dropping
  the composer and the Decisions region changes D1; needs an amendment or a
  successor ADR.
- `docs/system-analytics/attention.md` — `ATN-05` is asserted between the Desk's
  Decisions-region count and the rail badge. With that region gone the
  invariant needs a new home (the natural candidate is the Held region plus the
  strip, but they do not sum to the badge — `Held` is one of four kinds).
- `docs/system-analytics/home-navigation.md` — `EDGE-NAV-02` states the narrow
  stack order as Decisions → Work → Activity.

## Open questions

1. ATN-05 — куда переезжает инвариант «счётчик == бейдж» без региона «Решения»?
2. ADR-172 D1 — поправка или ADR-наследник?
3. Раскрытие строки и фильтр по плитке — в URL (deep link, refresh) или локальным состоянием?
4. Уточнение в чипе «Ждёт человека» — три подписи, иконка или тултип?
5. Held — карточками как сейчас или тоже строкой?
6. Токены в пуш-дайджесте (ADR-173) — чинить в этот заход или отдельной задачей?
