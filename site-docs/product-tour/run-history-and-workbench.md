---
title: "Run history and Run workspace"
description: "Find any execution attempt, read its graph and node results, inspect evidence and files, and understand available actions."
---

MAIster records each execution attempt as a Run. The active-workspaces rail
shows current work; the Run ledger also keeps finished, failed, scheduled, and
scratch attempts.

Each rail row shows what the Run is doing or where it needs help. It may be
executing, waiting for a condition or child Runs, awaiting input or review,
or being edited. It may also be the latest failed or crashed attempt of an
open task. Finished and abandoned Runs, failed or crashed
attempts replaced by a newer one, and failed or crashed attempts of a closed
task leave the rail. They stay in the ledger, the task's Run history, and the
project's **Runs and working copies** list.

## Find a Run

![Run history with filters](/assets/screens/en/runs-history.png)

Choose **Active workspaces → See all** or open `/runs`. Filter the ledger by
project, state, source, runner, and date range. The URL stores the filters, so
you can send the same view to another project member.

Each row shows the task or Run identity, project, status, source, start time,
duration, execution time, runner, and token count. Times use your browser's
time zone. Flow and platform-agent rows open `/runs/{runId}`. Scratch rows open
`/scratch-runs/{runId}`.

**Duration** is the wall clock from start to end. **Execution** counts only the
time agents and automated steps were working. It excludes queueing, condition
waits, human input, and idle checkpoints and counts parallel time once. The
button beside Execution opens the breakdown. A value marked `≈` was still open
when the Run ended; `—` means no execution evidence was recorded.

The task page has a narrower history: it lists every Run created for that one
task. A retry creates another attempt and keeps the previous revision, cost,
evidence, and decisions intact.

## Read the Run page

![Run workspace with graph and current result](/assets/screens/en/run-workbench.png)

Start with the header and primary result:

- task title, project, branch, state, current node, and chosen Flow;
- pinned package and Flow revision;
- runner and model snapshots for the sessions that performed the work;
- duration, execution time, token usage, and recorded cost.

The graph shows the route taken through the Flow. Select a node to inspect its
attempts, resolved prompt, structured result, output artifacts, gates, and
transition. Rework may create several attempts for one node; MAIster keeps the
older attempts and marks superseded results as stale.

While a Run is `Waiting`, its wait node shows the condition and deadline.
The Run keeps its worktree and frees its execution slot. Open the wait card
to inspect deliveries and available [operator actions](/guides/flow-waits-and-ci#operate-a-wait).

![Selected node and its execution state](/assets/screens/en/run-nodes.png)

Recorded prompts are distinguished from template previews. A preview for an
older attempt is not proof of what was sent. Standalone agent transcripts show
dispatched initial, resume, rework, and message prompts alongside responses.
Steered messages appear in the same conversation. Open full artifacts when a
node or consensus result only shows a bounded excerpt.

Select **Changes** in the header to open the corresponding diff. Open the
graph full screen to inspect a wide Flow. Escape returns to the same selected
node. Long user messages in the transcript have a **Show full message** control.

## Read context usage and compaction

On the Run page or in the workbench inspector, open the context meter for the
selected agent session or node attempt. Scratch and Studio dialogs also show
the meter. It reports the tokens in use and the window size supplied by the
adapter. **Not reported** means there is no current measurement. A resumed
process needs a fresh reading.

When the adapter compacts the conversation, look for its marker in the
transcript. It shows the outcome and, when available, a summary and token
counts before and after compaction. After completion, the meter waits for
the next sample. See [runner settings](/administration/runners-and-models#context-window-and-compaction)
if the reported window looks wrong.

If a scratch turn ends with `context_exhausted`, open a fresh scratch session.
Check any queued instructions in the old dialog before deciding which ones to
carry over. For `max_output_tokens`, read the partial response and ask for a
smaller next step in the same dialog.

## Inspect a delegated child Run

Select a child in the Run tree or inspector to open a read-only peek beside the
main Run. Its status, conversation or Flow execution, and public result update
while the parent remains open. Execution status and public-result availability
are separate: a completed Run may still have a missing or invalid result.

Use the hierarchy, sibling list, child list, and **Previous selection** to inspect
related Runs in the same panel. The main Run stays the navigation anchor. The URL
preserves the selected child and view; browser Back and Forward restore them.

Closing peek keeps the parent's view, scroll position, inspector state, and draft,
and returns focus to the child entry. On narrower screens peek is a modal sheet;
Escape closes it. The personal librarian is temporarily hidden with its draft
retained; after resizing to a narrow screen, reopen it explicitly when needed.

Choose **Open full Run** to message an eligible agent, answer a human request,
review, promote, or use lifecycle controls. Peek offers inspection only. Content
remains subject to your project permissions and retained data availability.

## Understand why a Run ended

Failed, crashed, or abandoned Runs show a recorded terminal reason when one is
available. It distinguishes an operator stop, an agent-process crash, a lost
turn or event stream, a budget or duration limit, and an unavailable workspace.
Older records may have no further detail; the status alone does not establish
the cause.

Read the reason with the node attempt and retained work before choosing Recover,
relaunch, or review. A result that could not be applied safely is a visible
failure requiring investigation, not proof that the agent completed successfully.
Host-pressure pauses have their own notice and
[continuation rules](/operations/execution-hosts#when-the-host-pauses-work).

### Retry a failed Flow step

If a project Flow is **Failed** and still has its worktree, select the failed
attempt and look for **Restart this node**. Keep the current files to build on
partial work. To start from the state before the attempt, inspect the checkpoint
preview and confirm the restore. MAIster saves the current work in a Git rescue
snapshot first. If the files changed after the preview, review it again.
The next attempt runs in the same Run. An agent step starts a new ACP session.

## Open code, evidence, and history

The lower workbench provides these views:

| View | Use it for |
| --- | --- |
| Files | Read git-tracked files from the Run workspace. |
| Diff | Review changes for the whole Run, the current review, or the last node. |
| Results and checks | Read recorded verification and retained output, including after a failed execution, and every blocker that affects readiness. Artifact previews show up to 64 KiB with a link to the original. **Provenance graph** traces each result back to a node attempt. |
| Timeline | Read state changes, human decisions, retries, interrupts, and promotion events in order. |

Large diffs may display some files as plain text when they reach the syntax
highlighting limit. You can still read the changed lines.

The right inspector contains actions that apply to the current state: respond
to a human gate, recover an eligible attempt, interrupt a node, take over the
workspace, request rework, export, or promote. MAIster checks project rights and
Run state again when you submit an action.

## History after workspace removal

Removing an eligible workspace keeps the Run and its recorded history. Runtime
content remains subject to retention; a missing or expired artifact is reported
explicitly. Live file and worktree-dependent diff actions require a worktree.

The [Git panel](/guides/run-git) offers **Reattach** when a local branch,
publication, or archive reference can restore it. Restoration does not restart
the agent. Failed worktrees also have a cleanup countdown and are preserved
before scheduled removal.

## Compare attempts

The task page answers “what happened each time?” Use an
[Evaluation study](/evaluation/run-comparison) when you need a recorded
comparison across Flow revisions, coding agents, models, methods, quality
measures, and price.

## Related pages

- [Kanban board, tasks, and Runs](/product-tour/tasks-and-runs)
- [Review, rework, and human takeover](/guides/review-rework-and-takeover)
- [Costs and execution budgets](/operations/costs-and-budgets)
