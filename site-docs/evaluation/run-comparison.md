---
title: "Compare Runs in Evaluation Lab"
description: "Launch controlled variants, freeze evidence, apply objective checks and AI judges, and record a human verdict."
---

Evaluation Lab compares several Runs of the same task. It is designed for
questions such as: Which Flow produced the better implementation? Does another
coding agent or model improve quality? Is the improvement worth its token and
time cost?

## Prerequisites

- A project and one task that all compared Runs address.
- At least two existing Runs, or one or more launch recipes for controlled
  participants.
- A compatible evaluation method and trusted judge agents when AI judging is
  required.

## Create a Study

Open **Project → Evaluations** and create a Study for one task. Add participants
in either mode:

- **Observed**: select an existing Run. Use this for a retrospective comparison.
- **Launched**: define an immutable recipe and let the Study create new Runs.
  Use this when the experiment must control the execution axes.

A recipe records the pinned Flow revision, optional package pin, slot-keyed
runner or model selection, capability overlay, execution policy, inputs, and
replicate count. Preflight checks compatibility, trust, runner availability,
required artifacts, and whether every requested axis is actually threaded into
launch.

## Design useful variants

Change one important axis at a time when you need a causal answer. Examples:

| Question | Variants |
| --- | --- |
| Which coding agent works better? | Same Flow and task, different runner adapter. |
| Which model has the best price/quality ratio? | Same adapter, Flow, and capabilities, different model profiles. |
| Does a richer process help? | Same task and comparable models, different Flow revisions. |
| Does additional tooling help? | Same runner and Flow, different MCP/skill capability overlay. |
| Is recursion worthwhile? | Flat agent, externalized context, depth-1 orchestrator, and depth-2 recursive harness. |

Use replicates when model variance could be larger than the expected difference.
A single Run can reveal a defect, but it rarely establishes a stable ranking.

## What the Study freezes

Starting an evaluation seals the participant set and bounded evidence snapshots.
A participant added later does not enter an in-flight execution. The method,
judge panel, effective policy, and candidate evidence are also snapshotted so a
catalog edit cannot rewrite the meaning of an old score.

Evidence can include diffs, test and lint reports, judgments, result objects,
Run-tree metrics, duration, and token use. Unavailable evidence stays
unavailable; MAIster does not convert missing data into a zero.

## Evaluation methods

An evaluation can combine several tool types:

| Method component | Purpose |
| --- | --- |
| Objective check | Reads recorded facts and computes a metric or pass/fail result without asking a model. |
| Scalar judge | Scores each blinded participant against declared criteria. |
| Pairwise tournament | Presents every unordered participant pair to judges and ranks wins and ties. |
| Judge panel | Fans out independent package-defined judge agents and exposes disagreement or missing quorum. |
| Human review | Resolves disagreement, insufficient evidence, or a consequential final choice. |

Judge candidates are blinded and receive only the evidence allowed by the
method. AI judgments are advisory. Only a person can record the conclusive
Study verdict, correct it with a superseding verdict, or standardize a winning
recipe.

## Read the result

Evaluate each participant across four dimensions:

1. **Correctness and evidence**: required checks, artifact freshness, diff, and
   promotion readiness.
2. **Quality judgment**: criterion scores, pairwise results, judge agreement,
   and the reasons behind them.
3. **Execution behavior**: retries, rework, crashes, child Runs, and human wait.
4. **Economics**: input, output, cache-read, and cache-creation tokens; elapsed
   time; runner/model attribution; resume overhead; and budget events.

Cost does not decide quality. Read it beside evidence and verdicts. A cheaper
variant may be the correct default for routine tasks while a more capable model
remains appropriate for high-complexity work.

## Compare recursive work

For orchestrated Runs, objective providers can measure child Run count, invalid
result count, result collection and consumption ratios, rework, crashes, tree
tokens, tree wall-clock, and promotion readiness. These facts show whether a
recursive harness used its children effectively; a judge or person still decides
whether the trade-off was worthwhile.

## Standardize a winner

After a conclusive human verdict, a project member can standardize an eligible
launched recipe for a project slot. MAIster reruns preflight at confirmation and
appends an audit revision. Rollback appends another revision; it does not rewrite
history.

Standardization does not promote the participant and does not change any Run
status. Promotion remains a separate human-governed action.

## Failure signals

- Preflight refusal: fix the named compatibility, trust, artifact, or runner
  condition before creating the batch.
- Partial evaluation: one or more objective checks, pairs, or judge attempts did
  not produce sufficient valid evidence.
- Review required: judges disagree or quorum was not met.
- Inconclusive verdict: the evidence does not justify a winner; preserve it
  rather than forcing a ranking.

## Related guides

- [Tasks and Runs](/product-tour/tasks-and-runs)
- [Flow Studio and package forks](/studio/flow-studio-and-packages)
- [Costs and execution budgets](/operations/costs-and-budgets)
- [Evidence, review, and rework](/guides/review-rework-and-takeover)
