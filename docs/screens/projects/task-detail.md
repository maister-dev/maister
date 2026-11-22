# Task detail

- **Type:** screen.
- **Route:** `/projects/{slug}/tasks/{number}` (session-required).
- **Status:** Implemented — [ADR-207](../../decisions.md#adr-207-task-completion-after-a-confirmed-pull-request-merge), [ADR-208](../../decisions.md#adr-208-run-duration-and-execution-time).
- **Source:** `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx` (composition), `web/lib/queries/task-detail.ts` (single loader), `web/lib/tasks/task-next-action.ts` (state → actions), `web/components/tasks/*`.

## JTBD

When I open a task, I want to see what state it is in, what I should do next and
what the result was, so I do not have to read every control and the full history
to decide.

## Roles & capabilities

| Role | Capabilities |
| --- | --- |
| Viewer | Read everything, including the source chip and Run history |
| Member with `editTask` | Primary/secondary actions, edit, relations, detach source |
| Agent / project token | No UI; uses the ext API (see [external operations](../../system-analytics/external-operations.md)) |

## Navigation

Reached from the board card `KEY-N`, inbox items, the Run header task link and
activity rows. Run history rows link to `/runs/{runId}`; workbench links open the
Run page tabs directly.

## Layout & regions

1. **Header** — `KEY-N`, title, status chip, source chip (label = localized kind
   or raw `source_kind`; text = `external_key ?? external_id`; link only when
   `external_url` is set) with an icon-only **Detach source** control for
   members (`web/components/tasks/task-source-detach.tsx`; shared confirmation
   dialog, then `router.refresh()`), one primary action and a "More" menu.
2. **Result card** (Done) — resolving Run (from the latest `task_completed`
   activity's `runId`; legacy completion without one shows "Resolving Run
   unknown"), merged PR link `#N` with its PR state chip, diff stat, "Open
   changes". Rendered above the statement.
3. **Statement** — bounded preview (always for Done; when over the line limit
   otherwise) with "Show full statement"; acceptance criteria reachable; editing
   unchanged.
4. **Relations** — list; create form behind "Add relation".
5. **Qualification** — compact summary; open for unassessed or held incoming work. Manual backlog admission collapses the assessment and retains access to its evidence.
6. **Next launch settings** — collapsed, labeled as defaults for the next
   attempt.
7. **Run history** — localized status chip; Duration and Execution (right-aligned,
   `tabular-nums`, Execution has a breakdown icon button); intended delivery
   strategy (muted) and actual artifact (PR link `#N` + state chip, published
   branch, merged commit, or "Not delivered"); the attempt's frozen runner/model
   ("used in this attempt"); token totals on a compact secondary line; the
   resolving attempt marked.
8. **Run details** — compact summary; flow graph and diff mount only when opened.
9. **Discussion / activity** — composer on top; every activity kind localized;
   consecutive system events of the same kind grouped into an expandable row that
   keeps each entry; completion, merge and comments emphasized.

## States

State → primary / secondary actions (owned by `taskNextAction`):

| Task state | Primary | Secondary ("More") |
| --- | --- | --- |
| Incoming, qualification missing or held | Add to backlog and Launch Flow (or its blocker reason) | Send to triage, run agent, queue controls |
| Backlog, launchable | Launch | Send to triage, run agent, queue controls |
| Backlog, blocked | Blocker reason + link | Send to triage, run agent, queue controls |
| InFlight, Running / Pending | Open Run | Queue controls, run agent |
| InFlight, NeedsInput | Respond (HITL link) | — |
| InFlight, Review | Open review | Complete (when completion evidence is ready) |
| InFlight, PR open / merged but not applied | Open PR; Complete when ready | Run again |
| Done | Result card | Start a new attempt, Send to triage |
| Abandoned | Status + reason | — |

There is exactly one "Run again" entry (eligibility from
`classifyForceRelaunchLaunchability`); on a Done task it reads "Start a new
attempt" and explains that the task returns to In flight. A merged PR whose
automatic completion was refused shows "PR merged — completion needs a
decision" with the refusal reason.

## Data & APIs

- `getTaskDetail` returns `source`, `resolvingRunId`, per-Run `timing`
  (`web/lib/runs/run-timing.ts`), `delivery {strategy, artifact}` and PR state.
- Detach: `DELETE /api/projects/{slug}/tasks/{number}/source` (session +
  `editTask`), see [`web.openapi.yaml`](../../api/web.openapi.yaml).
- Times render through `<LocalTime>` in the viewer's zone with the zone name.

## i18n

EN + RU for every label above, every task activity kind (compile-time
`satisfies Record<TaskActivityEventKind, …>` map) and every Run status.

## Linked artifacts

- [`tasks.md`](../../system-analytics/tasks.md) (source binding, completion)
- [`runs.md`](../../system-analytics/runs.md#run-timing) (timing)
- [`project-board.md`](project-board.md), [`components.md`](../components.md)
