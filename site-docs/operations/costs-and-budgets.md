---
title: "Costs and execution budgets"
description: "Track token and time usage and bound runaway work with warn, escalate, and terminate thresholds."
---

MAIster attributes resource use to delivery work instead of leaving it in
provider logs. Current accounting covers tokens and elapsed execution time;
USD pricing and `maxCostUsd` enforcement are not part of the current contract.

## Cost views

Inspect rollups at the Run and node-attempt level. Observatory views aggregate
usage across projects, Flows, models, and runners so you can spot expensive
processes, retries, and uneven executor use.

Cost is one signal beside duration, evidence, readiness, and promotion outcome.
A cheaper Run is not automatically a better Run.

## Budget ladder

Execution budgets use three explicit responses:

1. **Warn** records and surfaces approaching exhaustion.
2. **Escalate** creates a human decision before more budget is consumed.
3. **Terminate** stops work with a typed `BUDGET_EXCEEDED` result.

Child Runs and platform agents consume governed budgets as part of their
visible run trees. Do not hide background work outside the ledger to avoid
budget accounting.

## Recommended starting point

Begin with warning thresholds on a qualified Flow. Observe several real Runs,
then add escalation and termination limits where the retry and evidence
behavior is understood.
