---
title: "Execution hosts"
description: "Understand the current single-host supervisor boundary and the safe path toward multiple execution hosts."
---

An execution host is the supervisor boundary that owns ACP sessions, agent
processes, and execution workspaces. Web Core addresses execution through a
durable host and assignment contract instead of treating a URL or filesystem
path as ownership.

## Current topology

The supported topology has one active trusted local execution host, loopback
HTTP, and shared local storage. There is no supported placement across multiple
simultaneous hosts and no mid-turn migration claim today.

The host contract already provides:

- durable host identity across supervisor restarts;
- monotonically increasing assignment epochs and stale-driver fencing;
- a durable command ledger and idempotent host receipts;
- opaque workspace handles on normal session operations;
- attributable sessions and node attempts.

## Path to multiple supervisors

These boundaries are the prerequisite for a future pool of supervisor hosts.
That stage must add remote transport, placement policy, host visibility, and
attempt-boundary recovery without weakening fencing or evidence ownership.

Until that stage ships, deploy one supervisor per MAIster control plane and
follow the [single-host deployment guide](/operations/deployment).
