---
title: "Kanban board, tasks, and Runs"
description: "Create work, model dependencies, follow queue and execution state, and inspect each attempt of a task."
---

The board is the operating view of a project. A task describes the desired
outcome. A Run is one execution attempt of that task through a pinned Flow
revision and a resolved set of runners and capabilities.

## Prerequisites

- A registered project with at least one attached, trusted, launchable Flow.
- Project `member` access to create or launch work. Viewers can inspect it.

## Read the board

![Kanban board with backlog tasks and active work](/assets/screens/en/project-board.png)

Use the board to answer four questions:

- What is waiting in the backlog or scheduler queue?
- What is running now?
- Which task is waiting for a person, evidence review, or promotion?
- Which relations prevent a task from starting?

Cards show task identity, selected Flow, description, run count, relations,
triage state, and the active or latest Run. Automated steps do not create Inbox
noise. The Inbox receives an item only when a permission, form, review,
escalation, or assignment needs a person.

## Create and configure a task

![Task editor with delivery settings](/assets/screens/en/task-editor.png)

A task starts with a title and outcome-oriented prompt. You can also set or
inherit:

- Flow;
- runner or Flow-session bindings;
- base and target branches;
- promotion mode;
- execution policy;
- relations to other tasks.

The effective values are shown even when the task inherits project defaults.
Task fields can be edited before work starts; Run snapshots do not change when a
later project default changes.

### Relations

| Relation | Use it when |
| --- | --- |
| `blocks` | This task prevents the linked task from being admitted. |
| `depends_on` | This task needs another task, but should recover when that dependency ends unsuccessfully. |
| `requires` | The dependency must complete successfully before this task can launch. |
| `parent_of` | A larger task decomposes into linked child work. |
| `duplicate_of` | Both tasks describe the same outcome. |

Relations can cross projects when the caller has access to both sides. The
board displays blockers rather than bypassing them.

## Several Runs for one task

A task keeps its full Run history. Launching again creates another immutable
attempt; it does not overwrite the previous runner, Flow revision, evidence,
cost, or decisions. This supports retries, an alternative implementation, or a
controlled comparison across runners, models, and Flows.

Use the task page for history and discussion. Use an
[Evaluation Study](/evaluation/run-comparison) when the choice should be made
from frozen evidence, objective checks, judges, and a recorded human verdict.
[Run history and the Run workspace](/product-tour/run-history-and-workbench)
explains the global ledger and every region of one Run page.

## Follow a Run

![Run workbench with status, graph, and execution details](/assets/screens/en/run-workbench.png)

The Run workbench brings together:

- pinned Flow and package revision;
- current node, graph, and transitions;
- ACP sessions and resolved runner snapshots;
- node attempts, retries, rework, and timeline events;
- human-in-the-loop requests and assignments;
- structured results and produced evidence;
- logs, diff, review comments, readiness, and promotion;
- token totals, elapsed time, and budget actions.

![Run graph with node-level execution state](/assets/screens/en/run-nodes.png)

Open a node to distinguish its latest attempt from stale or superseded history.
After rework or a human takeover, downstream attempts, gates, and evidence become
stale until the Flow executes them again.

## Queue and admission

Submitting work does not guarantee immediate execution. MAIster admits Runs
under concurrency limits and keeps excess work Pending. Flow Runs and standalone
platform-agent Runs have separate capacity pools. Scheduled launches first
create durable intents; the scheduler turns an eligible intent into a Run.

Check the board and Run status before treating a delay as a runner problem. A
Pending item may be waiting for capacity, a scheduled time, an unmet relation,
or another admission prerequisite.

## Success and failure signals

- **Running** means the Flow owns execution and may still ask for input.
- **Needs input** means a person or external system must respond.
- **Human working** means a named person has claimed the worktree.
- **Review** means execution finished and the result awaits acceptance or
  promotion.
- **Done** means the governed completion path finished.
- **Failed, Crashed, or Abandoned** preserve attempts and diagnostics; they do
  not erase the task or its other Runs.

Before promotion, verify that required evidence is current, blocking gates pass,
the diff matches the task, and unresolved review threads are understood.

## Next steps

- [Handle human-in-the-loop requests](/guides/human-in-the-loop).
- [Review, rework, or take over a Run](/guides/review-rework-and-takeover).
- [Compare several Runs](/evaluation/run-comparison).
- [Analyze costs and execution pressure](/operations/costs-and-budgets).
