---
title: "Flows, nodes, and Runs"
description: "Learn how versioned Flow packages become observable Run attempts with isolated workspaces."
---

A Flow is a versioned graph of delivery work. A Run is one execution of one
pinned Flow revision against one task or scratch intent.

## Flow package

A package is a git source with a version and a `flow.yaml` manifest. Installation
records the resolved commit so an upstream tag change cannot alter an active
Run. Untrusted executable content requires explicit trust before it can run.

## Node kinds

Common node responsibilities include:

- agent work through an ACP runtime;
- command and check execution;
- human forms and reviews;
- routing and bounded rework;
- orchestration or consensus across child Runs;
- promotion readiness.

The graph must declare named nodes and transitions. Rework loops are bounded;
an invalid graph is rejected before execution.

## Run lifecycle

A launch creates a Run, chooses a target branch, allocates an isolated worktree,
and starts the first eligible node. Each node execution creates an attempt.
Retries and operator restarts create new attempts instead of rewriting history.

The Run page is the canonical place to inspect current state, active ownership,
events, logs, changes, evidence, and requests that need a person.

## Queueing and concurrency

An instance enforces separate concurrency budgets for delivery Runs and platform
agents. A valid launch can wait in `Pending` until a slot is available. Pending
does not mean failed; the UI shows the reason and the Run starts when admitted.
