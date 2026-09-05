---
title: "Run history and Run workspace"
description: "Find any execution attempt, read its graph and node results, inspect evidence and files, and understand available actions."
---

MAIster records each execution attempt as a Run. The active-workspaces rail
shows current work; the Run ledger also keeps finished, failed, scheduled, and
scratch attempts.

## Find a Run

![Run history with filters](/assets/screens/en/runs-history.png)

Choose **Active workspaces → See all** or open `/runs`. Filter the ledger by
project, state, source, runner, and date range. The URL stores the filters, so
you can send the same view to another project member.

Each row shows the task or Run identity, project, status, source, start time,
duration, runner, and token count. Flow and platform-agent rows open
`/runs/{runId}`. Scratch rows open `/scratch-runs/{runId}`.

The task page has a narrower history: it lists every Run created for that one
task. A retry creates another attempt and keeps the previous revision, cost,
evidence, and decisions intact.

## Read the Run page

![Run workspace with graph and current result](/assets/screens/en/run-workbench.png)

Start with the header and primary result:

- task title, project, branch, state, current node, and chosen Flow;
- pinned package and Flow revision;
- runner and model snapshots for the sessions that performed the work;
- total duration, token usage, and recorded cost.

The graph shows the route taken through the Flow. Select a node to inspect its
attempts, resolved prompt, structured result, output artifacts, gates, and
transition. Rework may create several attempts for one node; MAIster keeps the
older attempts and marks superseded results as stale.

![Selected node and its execution state](/assets/screens/en/run-nodes.png)

## Open code, evidence, and history

The lower workbench provides these views:

| View | Use it for |
| --- | --- |
| Files | Read git-tracked files from the Run workspace. |
| Diff | Review changes for the whole Run, the current review, or the last node. |
| Evidence | Trace test reports, checks, judgments, review notes, and produced artifacts back to a node attempt. |
| Timeline | Read state changes, human decisions, retries, interrupts, and promotion events in order. |

The right inspector contains actions that apply to the current state: respond
to a human gate, recover an eligible attempt, interrupt a node, take over the
workspace, request rework, export, or promote. MAIster checks project rights and
Run state again when you submit an action.

## History after workspace removal

Removing an eligible workspace does not delete the Run row, transcript, cost,
or evidence. File and diff actions become unavailable because their source
workspace no longer exists; the historical page identifies the removal instead
of reading another path as a fallback.

## Compare attempts

The task page answers “what happened each time?” Use an
[Evaluation study](/evaluation/run-comparison) when you need a recorded
comparison across Flow revisions, coding agents, models, methods, quality
measures, and price.

## Related pages

- [Kanban board, tasks, and Runs](/product-tour/tasks-and-runs)
- [Review, rework, and human takeover](/guides/review-rework-and-takeover)
- [Costs and execution budgets](/operations/costs-and-budgets)
