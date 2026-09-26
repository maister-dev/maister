---
title: "Execution hosts"
description: "Understand the current single-host supervisor boundary and the safe path toward multiple execution hosts."
---

An execution host is the supervisor boundary that owns ACP sessions, agent
processes, and execution workspaces. Web Core addresses execution through a
durable host and assignment contract instead of treating a URL or filesystem
path as ownership.

## Current topology

The supported topology has one active trusted local execution host and loopback
HTTP. Web and supervisor still share repository and worktree storage. Runtime
events and artifact content cross the host API instead of requiring Web to read
the supervisor's private runtime files. Placement across multiple simultaneous
hosts and mid-turn migration are not supported.

The host contract already provides:

- durable host identity across supervisor restarts;
- monotonically increasing assignment epochs and stale-driver fencing;
- a durable command ledger and idempotent host receipts;
- opaque workspace handles on normal session operations;
- attributable sessions and node attempts;
- durable event replay across reconnects and restarts;
- runtime content addressed through opaque object references.

## Event delivery and lag

The supervisor persists events before delivery. Web accepts bounded batches and
acknowledges committed progress; interrupted delivery can replay safely. A slow
subscriber pauses and catches up from stored events when its connection can
drain again, rather than being disconnected simply for being slow.

Host-to-web delivery and processing into transcript, artifact, and usage views
can lag independently. Stream diagnostics distinguish measurable backlog from
unknown or stale data. A live connection alone does not prove that the displayed
Run state is current. Check both services' logs when progress stops.

## Preserve state during upgrades

Back up Postgres, the supervisor's persistent state and runtime content, and
repository/worktree storage. Keeping only the worktree or the database does not
preserve the entire Run. Keep the host identity stable across service restarts;
do not clear supervisor state to repair a stalled stream. Use the reported
recovery action and retain diagnostics as described in
[Troubleshooting](/operations/troubleshooting).

## Path to multiple supervisors

These boundaries are the prerequisite for a future pool of supervisor hosts.
That stage must add remote transport, placement policy, host visibility, and
attempt-boundary recovery without weakening fencing or evidence ownership.

Until that stage ships, deploy one supervisor per MAIster control plane and
follow the [single-host deployment guide](/operations/deployment).
