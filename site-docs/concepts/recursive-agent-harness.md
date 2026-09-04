---
title: "Recursive Agent Harness (RAH)"
description: "Coordinate bounded agent and Flow trees through typed results, independent verification, and human review."
---

RAH is MAIster's governed pattern for recursive multi-agent work. An
`orchestrator` can delegate bounded child Runs, wait without occupying an active
agent session, collect typed results, and reduce them into one result that the
normal evidence and review path can evaluate.

## Reference delivery shape

```text
orchestrator → writer → independent judge → human review → promotion
      └──── read-only agent or Flow researchers ────┘
```

The reference shape deliberately has one worktree writer. Research children are
read-only and publish schema-validated public Run results. The coordinator
collects those results by Run identity rather than scraping assistant prose.

## Governance boundaries

RAH preserves the properties that hidden subagents usually lose:

- every child is a first-class Run in a visible recursive tree;
- depth, fan-out, active-child count, total child count, token, time, and failure
  budgets are bounded and snapshotted;
- agent and Flow children use the same admission queue;
- result schemas, revisions, producer identity, validity, and artifact manifests
  are durable;
- failures route through bounded rework or human escalation;
- independent verification and the standard readiness gate still apply before
  promotion.

## Result-only research

A result-bearing research Flow that changes no code can finish as `Done` after
publishing a valid result. It does not create a meaningless diff-review step.
A Run that writes code still follows the normal Review and promotion path.
