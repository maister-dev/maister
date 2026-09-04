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
