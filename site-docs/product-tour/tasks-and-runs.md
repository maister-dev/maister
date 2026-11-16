---
title: "Kanban board, tasks, and Runs"
description: "Create work, model dependencies, follow queue and execution state, and inspect each attempt of a task."
---

The board is the operating view of a project. A task describes the desired
outcome. A Run is one execution attempt of that task through a pinned Flow
revision and a resolved set of runners and capabilities.

## Prerequisites

- A registered project and an available trusted Flow or task-bound code-delivery
  agent. A repository-less agent may use its supported `none` workspace.
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

## Read the task page

The task page leads with the task's state and one primary next action; other
actions are under **More**:

| Task state | Primary action |
| --- | --- |
| Needs qualification | **Qualify the task**, or the blocking reason |
| Backlog | **Launch**, or the reason launch is blocked |
| In flight, running or queued | **Open run** |
| In flight, waiting for a person | **Respond** |
| In flight, in review | **Open review** |
| In flight, latest Run finished | **Open PR** or **Open run**; **Complete task** when completion is ready |
| In flight, latest Run failed, crashed, or abandoned | **Run again** |
| Done | **View result** |

A **Done** task shows a **Result** card: the Run that resolved it, the merged
pull request and its state, the change size, and a link to the changes. **Start
a new attempt** launches again and returns the task to in flight.

A task whose Run was delivered through a pull request completes by itself once
the provider reports the merge and the Run is finalized; see
[when the task completes](/guides/run-git#when-the-task-completes). If that
completion is refused, the page shows **PR merged — completion needs a
decision** with the reason, so you can complete the task yourself or start
another attempt.

A task imported from an external tracker shows its source next to the status,
for example the GitHub issue number. MAIster stores this identity separately
from the title and prompt, so editing them keeps the link. One external item
maps to one task in a project: a repeated import is refused and identifies the
existing task instead of creating a duplicate.

A long statement shows a preview with **Show full statement**. The relation form
opens from **Add relation**, qualification shows a summary with details on
demand, and **Next launch settings** is collapsed. Those settings are defaults
for the next attempt; each Run in the history keeps the runner and model it
used.

## Launch deliberately

Selecting a Flow or runner configures the task; it does not start execution.
Open **Launch**, check the task revision, runner/model and delivery settings, then
press **Launch** to authorize that request. The accepted receipt stays visible
while it waits for capacity or prepares its workspace. Open the linked Run to
follow execution; acceptance alone does not mean the model started.

Missing, outdated or negative Triager assessments and infrastructure failures
while preparing an assessment remain visible. They prevent automatic launch, but do not require you to complete the seven-check
assessment form before an authorized manual launch. Manual Launch records your
one-time decision without changing the Triager result or enabling later automatic
runs. Explicit holds, open blocking questions/relations, access checks, target
availability, capacity, isolation and the Flow's validation gates still apply.

For a task-bound agent, check its actual workspace and runner/model in the agent
launch preview, then press its separate Launch action. An agent that drives a
Flow uses that declared Flow; it does not become a standalone execution.

If task input or selected configuration changes before dispatch, the request is
held with a reason. Review the current settings and explicitly replace it. A
lost response keeps the same request for recovery; do not create another launch
to guess whether the first one was accepted. Ordinary repeated clicks identify
existing work. Use the separately labelled concurrent action only when you intend
another attempt alongside it.

## Relations

| Relation | Use it when |
| --- | --- |
| `blocks` | This task prevents the linked task from being admitted. |
| `depends_on` | This task needs another task, but should recover when that dependency ends unsuccessfully. |
| `requires` | The dependency must complete successfully before this task can launch. |
| `parent_of` | A larger task decomposes into linked child work. |
| `duplicate_of` | Both tasks describe the same outcome. |

Relations can cross projects when the caller has access to both sides. The
board displays blockers rather than bypassing them.

## Clarify before launch

The [personal librarian](/guides/personal-librarian) can create a structured
task statement and ask an addressed teammate a question while the task is in
**Backlog**. State the recipient, question, answer format, and whether it blocks
launch. The recipient must be an active project member with permission to answer.

The request appears on the task and in that person's Inbox and decisions queue.
Open it and answer as the named recipient. Text, choice, and yes/no formats are
supported. An open blocking request shows `clarification_pending` and prevents
launch; the task keeps its existing status. Non-blocking questions do not hold
launch.

The answer remains on the task and becomes context for subsequent execution.
Answering does not itself accept a revised statement or launch a Run. When a
request is cancelled or replaced, inspect the recorded reason; a corrected
question supersedes the previous record rather than overwriting its answer.
Requests are also cancelled if the recipient loses the required access or the
task is abandoned.

## Several Runs for one task

A task keeps its full Run history. Launching again creates another immutable
attempt; it does not overwrite the previous runner, Flow revision, evidence,
cost, or decisions. This supports retries, an alternative implementation, or a
controlled comparison across runners, models, and Flows.

Each history row shows the Run's status, **Duration** (wall clock from start to
end) and **Execution** (time agents and automated steps were working, without
queueing, human input, or idle checkpoints), the intended delivery strategy,
and what was delivered: a pull request with its state, a published branch, a
merged commit, or **Not delivered**. The Run that completed the task is marked
**Resolved the task**.

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

Submitting work does not guarantee immediate execution. MAIster retains accepted
work in the queue under concurrency limits. A Run that already exists may remain
Pending; an accepted request can also wait before a Run is created. Flow Runs and
standalone platform-agent Runs have separate capacity pools. Manual and automatic
task launches first create durable requests; the scheduler prepares and binds an
eligible request to a Run. Automatic task launch additionally needs a current accepted Ready assessment
and its configured automatic intent.

Check the board and Run status before treating a delay as a runner problem. A
Pending item may be waiting for capacity, a scheduled time, an unmet relation,
or another admission prerequisite.

## Success and failure signals

- **Running** means the Flow owns execution and may still ask for input.
- **Needs input** means a response is pending. A [host-pressure pause](/operations/execution-hosts#when-the-host-pauses-work)
  is identified separately and can resume automatically after host recovery.
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
