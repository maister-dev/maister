---
title: "Tasks, Runs, and evaluation"
description: "Model task dependencies, keep multiple implementation Runs, and compare results with reproducible methods."
---

A **Task** stores the durable intent. A **Run** records one attempt to execute
it. A team can retry, compare, and audit implementations while the task keeps
its complete history.

## Task graph and queue

Tasks have stable project keys and typed relations:

- `blocks` and `depends_on` express delivery order;
- `parent_of` connects decomposed work;
- `requires` represents orchestrator success dependencies;
- `duplicate_of` keeps triage decisions visible.

Launchability is calculated from these relations and the current task states.
Eligible work enters the priority queue; concurrency limits, pause state, and
available capacity determine when a Pending Run starts. Queue position remains
visible instead of failing a valid launch because the execution host is busy.

## Multiple Runs for one Task

One Task can own many Runs. Each Run keeps its own Flow revision, runner and
provider snapshot, workspace, evidence, cost, gates, diff, and terminal result.
A failure and an alternative implementation both remain in the same lineage.

## Compare implementations

An Evaluation Study compares 2..N Runs of one Task. Participants can be existing
Runs or Runs launched specifically for the Study. Comparison uses immutable,
bounded evidence snapshots and keeps these planes separate:

- objective facts such as checks, artifacts, schema validation, diff statistics,
  duration, and cost;
- independent AI-judgment attempts from configured Judge Panels;
- deterministic aggregation and disagreement;
- an append-only human verdict: winner, tie, or inconclusive.

Evaluation Methods are versioned package content. N-way, pairwise, and tournament
methods remain identifiable and auditable. The UI shows incompatible
methodologies side by side and does not calculate a universal score across them.
