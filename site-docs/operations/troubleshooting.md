---
title: "Troubleshooting"
description: "Diagnose launch, workspace, agent runtime, evidence, and promotion failures without hiding the root cause."
---

Start from the Run page and keep the Run identifier, active node, attempt, and
reported error code together. Fix the stated precondition before retrying.

## Run stays Pending

Check the queue reason and instance concurrency budgets. Pending work starts
when a compatible slot becomes available. If the configured runner is not
ready, fix its diagnostics instead of increasing concurrency.

## Launch fails before agent work

Verify that the parent repository is clean, the target branch exists, the Run
branch is not already owned, and the worktree path is available. Check that the
selected Flow revision and runner still exist and are trusted.

## Agent runtime is unavailable

Open platform runner settings and inspect readiness reason codes. On the
supervisor host, verify that the adapter binary is installed, credentials are
available to the service account, and configured `env:NAME` references resolve.
MAIster does not substitute another runtime.

## A saved answer has not resumed the Run

Read the HITL card's saved choice and delivery status. Use its identical-answer
retry when offered; do not submit a different choice to clear the wait. A
session-ended error needs the recovery or relaunch action shown by the UI.
See [saved answers and delivery](/guides/human-in-the-loop).

## A Run is Crashed

Inspect the failure classification, failed node, and retained work. **Recover**
re-enters the eligible execution path; in a Flow it resumes graph processing
rather than treating one finished agent turn as completion of the entire Flow.
A node without a resumable session may require the author's `retry_safe`
declaration before it can be repeated. Follow the refusal instead of repeatedly
relaunching a side-effecting command.

Use the [Git panel](/guides/run-git) to preserve or publish useful work, or to
reattach a missing worktree before an eligible recovery. Reattach alone does
not resume execution.

## Recover staged work after worktree cleanup

Before archive, drop, or automatic cleanup removes a worktree, MAIster preserves
its changes. This also applies to orphan worktrees whose ownership has been
verified. If a file was staged and then edited or deleted again, MAIster saves
the index before taking the working-tree snapshot. A preservation failure
prevents removal.

The staged version is kept in the second parent of a local
`refs/maister/rescue/<runId>/<n>` reference. The web service logs its name in
`rescueRef`. For an orphan, the working-tree snapshot is kept separately on a
`maister/orphan/...` branch; that snapshot does not contain the earlier staged
version of the file.

On the host, open the project's parent repository and list the retained refs:

```bash
git for-each-ref --format='%(refname)' refs/maister/rescue/ refs/heads/maister/orphan/
```

Match the Run id and inspect the staged file without changing your checkout.
Replace `<runId>`, `<n>`, and `path/to/file` with the actual values:

```bash
git show 'refs/maister/rescue/<runId>/<n>^2:path/to/file'
```

Use [Reattach](/guides/run-git#5-restore-a-removed-worktree) when the Run still
exists and you need its working tree back. Reattach does not automatically
restore the separately preserved index. Rescue refs are local to the repository;
they are not a remote backup.

## Transcript or status stops advancing

Check both the Run connection indicator and execution-host health. A connected
browser does not prove that the host's events and derived Run views have caught
up. Inspect web and supervisor logs for stalled delivery, worker failures, or
lag. Brief subscriber pauses under load can catch up from durable events; do
not delete runtime state to force a refresh. See
[execution hosts](/operations/execution-hosts).

## Evidence is missing or stale

Open the responsible node attempt. Missing means the declared producer did not
deliver the artifact. Stale means the workspace changed afterward. Rerun the
producer or required check against the current code; do not upload a placeholder
or manually mark it ready.

## Promotion fails

For pull requests, verify provider authentication, remote permissions, and git
push credentials in the web service environment. For local merge, confirm the
target repository is clean. A merge conflict requires manual resolution and new
evidence for the resolved code.

## Collect before escalation

Provide the Run id, node and attempt id, error code, relevant structured logs,
runner readiness result, and the exact operation that failed. Remove tokens,
credentials, repository secrets, and private source content from shared reports.
