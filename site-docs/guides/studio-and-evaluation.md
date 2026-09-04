---
title: "Author and compare in Studio"
description: "Design Flow packages, inspect upstream divergence, and compare competing implementations in Evaluation Studies."
---

MAIster provides two complementary comparison surfaces: Flow Studio for the
process definition and Evaluation Lab for the results of execution.

## Flow Studio

Use Studio to edit a Flow as a graph and as package content. Validate nodes,
transitions, gates, agent sources, and composition before installing a trusted
revision.

For a local package derived from an upstream source, open **Compare with
upstream** on the package or an individual element. Review the selected lineage
cut before syncing or publishing; MAIster does not treat a newer upstream
revision as an automatic overwrite.

## Evaluation Studies

Create a Study for one project and task when you need to answer which
implementation performed better. Add existing Runs as observed participants or
launch controlled participants from a pinned recipe.

The Study compares immutable evidence snapshots. Objective checks and
package-sourced judge methods can produce rankings, while the final human
verdict remains append-only and explicit. A Study never auto-approves or
auto-promotes a participant.

## Choose the right comparison

- Compare package lineage in Studio when the question is **what changed in the
  process definition?**
- Compare participant Runs in Evaluation Lab when the question is **which
  implementation and evidence are better?**
