---
title: "Review and promote a Run"
description: "Inspect changes and evidence, request rework when needed, then deliver through a merge, a pull request, or a published branch."
---

## 1. Confirm the target

Check the project, task, Flow revision, base branch, and intended target branch.
If the base moved, refresh the Run as directed by the UI before trusting old
evidence.

## 2. Inspect the result

Read the change summary and the actual diff. Then inspect required evidence,
logs, structured outputs, human decisions, and the attempt history. A green
agent node is not enough when blocking evidence is missing or stale.

## 3. Decide

- **Accept** when the result and required evidence are current.
- **Request rework** with concrete comments when the agent should continue.
- **Take over** when a person must edit the Run worktree.
- **Stop** when the task should not continue.

## 4. Promote

The project's delivery policy sets the default strategy. A launch can choose
another one, and the Run keeps the strategy it was launched with.

| Strategy | Result | Host requirement |
| --- | --- | --- |
| **Merge** | Merges the Run branch into the selected local target branch. | Clean repository and conflict-free merge |
| **Rebase + merge** | Rebases the Run branch onto the target, then merges. A conflict restores the previous state. | Clean repository |
| **AI rebase + merge** | Rebases and merges; a conflict goes to an AI resolver and the Run returns to **Review** for another promotion. | Clean repository |
| **Pull request** | Pushes a branch and opens a provider pull request. | Provider authentication and git push credentials |
| **Publish branch** | Pushes the Run branch under its public name and leaves the target branch untouched. | Git push credentials and a configured remote |

Select **Publish branch** when launching a task Run. After the required checks
and review pass, MAIster pushes the branch and shows the remote and branch on
the Run. A rejected push keeps the Run in **Review** with the Git error and
**Retry delivery**; a retry uses the same destination and never force-pushes.
Publishing a branch does not complete the task.

MAIster does not deploy the merged result. Deployment remains in your existing
CI/CD system.

With **Pull request**, the task completes by itself after the provider reports
the merge. Check **Partial work — keep the task open** before promoting when
the pull request does not finish the task. See
[when the task completes](/guides/run-git#when-the-task-completes).

## Publish before finalization

Use the [Run Git panel](/guides/run-git) to publish a branch and open a PR before
finalizing the Run. Opening a PR leaves the Run status unchanged. Finalize is a
separate action; its readiness requirements depend on the Run's state.

## Conflicts

If promotion conflicts, MAIster stops and reports the conflict. Resolve it in a
controlled workspace, rerun affected checks, and review the new evidence. Never
treat pre-conflict evidence as proof for the resolved code.
