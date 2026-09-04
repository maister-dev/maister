---
title: "Review and promote a Run"
description: "Inspect changes and evidence, request rework when needed, then promote through a pull request or local merge."
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

The project chooses one promotion mode:

| Mode | Result | Host requirement |
| --- | --- | --- |
| `pull_request` | Pushes a branch and opens a provider pull request. | Provider authentication and git push credentials |
| `local_merge` | Merges into the selected local target branch. | Clean repository and conflict-free merge |

MAIster does not deploy the merged result. Deployment remains in your existing
CI/CD system.

## Conflicts

If promotion conflicts, MAIster stops and reports the conflict. Resolve it in a
controlled workspace, rerun affected checks, and review the new evidence. Never
treat pre-conflict evidence as proof for the resolved code.
