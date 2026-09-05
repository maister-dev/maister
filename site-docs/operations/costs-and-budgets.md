---
title: "Observatory, Run costs, and budgets"
description: "Attribute token and time use to tasks, Runs, models, and runners, then set bounded execution policies."
---

MAIster records resource use with the work that caused it. A Run therefore
shows the token and time cost of one attempt on one task, while Observatory
aggregates the same facts across projects, Flows, models, runners, and nodes.

Current accounting covers tokens and elapsed time. Currency pricing and
`maxCostUsd` enforcement are not part of the current contract, so the UI must
not present token totals as an estimated dollar amount.

## Prerequisites

- At least one Run whose coding-agent adapter emitted usage records.
- Access to the Run, project Observatory, or portfolio Observatory.

## Cost of one task attempt

Open a task and choose a Run from its history. The Run workbench attributes:

- input tokens;
- output tokens;
- cache-read tokens;
- cache-creation tokens;
- resume or checkpoint overhead;
- elapsed Run and node-attempt time;
- the snapshotted model and runner session that produced the usage.

Several Runs of one task remain separate. A retry, alternative model, or
different Flow does not overwrite the previous attempt's usage. This is the
base unit for comparing the economics of agent-assisted delivery.

## Use Observatory

Open **Observatory** for the visible project portfolio, or **Project →
Observatory** for one repository. Choose the cost view and a time window.

| Breakdown | Question it answers |
| --- | --- |
| Project | Which product or repository consumes the most agent capacity? |
| Flow | Which delivery process is expensive or retry-heavy? |
| Node | Which part of planning, implementation, verification, or review causes the usage? |
| Model | How much work is attributed to each model label? |
| Runner | How much work is attributed to each `<adapter>/<model>` session snapshot? |

The page also shows correction pressure, autonomy, human wait, gate firing,
control effectiveness, and evidence coverage. Cost is most useful beside these
signals: fewer tokens are not an improvement when the result creates more
rework or weaker evidence.

## Runner attribution

Runner totals come from immutable session snapshots rather than the mutable
runner catalog. Historical usage therefore keeps its original label even if an
administrator later edits or deletes the catalog row.

Attribution is exact per named Flow session. If a Flow assigns planning and
implementation to separate sessions, Observatory can split their usage between
two runners. A single-session Flow, scratch Run, or standalone platform-agent
Run attributes all usage to its one default session. A record without a matching
session appears under `unknown` rather than being guessed.

To compare price/performance across stages:

1. Give materially different stages separate named sessions.
2. Bind the intended runner and model to each slot.
3. Run several representative tasks.
4. Compare token totals, duration, rework, evidence, and quality.
5. Move a cheaper or faster profile into the default only after the result is
   stable across tasks of similar complexity.

## Compare alternatives in a Study

Observatory explains aggregate behavior. Use an
[Evaluation Study](/evaluation/run-comparison) when several Runs of one task
must be compared under the same method. A Study can launch the same task with
different Flows, coding agents, models, capability overlays, and execution
policies, then combine objective facts, AI judges, and a human verdict.

This supports decisions such as using a stronger model for planning and judging,
a lower-cost model for routine implementation, or a different agent for a
specific class of task. The choice belongs in a versioned Flow or standardized
recipe, not in manual switching instructions for every team member.

## Budget ladder

Execution policies use explicit responses as a limit approaches or is exceeded:

1. **Warn** records the condition and lets work continue.
2. **Escalate** parks the Run and asks a person before consuming more budget.
3. **Terminate** stops work with a typed budget-exceeded result.
4. Where configured, a terminated attempt may remain restorable instead of
   discarding its work product.

Child Runs and platform agents consume visible, governed budgets. Orchestrator
nodes can also bound fan-out, depth, active children, wall-clock time, tokens,
child Run count, and consecutive failures.

Start with warnings on a qualified Flow. Observe real Runs before adding
termination thresholds. Set separate policies for routine and high-complexity
tasks when their normal consumption differs significantly.

## Data freshness

Active Run totals are marked volatile because more usage can arrive. Terminal
Run rollups are reconciled after completion, including a short settling window
for a late final usage record. Missing or stale derived data is shown as
insufficient, never as a fabricated zero.

## Failure signals

- No cost row: the adapter emitted no usage, the Run is still settling, or
  reconciliation has not completed.
- `unknown` runner: usage exists but no matching session snapshot can be proven.
- Unexpected single runner bucket: the Flow used one shared/default session;
  create named sessions if stage-level attribution is required.
- Budget escalation in Inbox: inspect current usage and work product before
  choosing continue, terminate, or restore.

## Related guides

- [Configure runners and models](/administration/runners-and-models)
- [Compare Runs](/evaluation/run-comparison)
- [Kanban board, tasks, and Runs](/product-tour/tasks-and-runs)
