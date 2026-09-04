---
title: "Evidence, readiness, and review"
description: "Use current evidence and explicit human review to decide whether a Run may be promoted."
---

Completion is an agent state. Readiness is a product decision backed by the
Flow's declared evidence and human review requirements.

## Evidence types

A Flow can require command results, test reports, changed files, structured
agent output, external checks, or human judgments. Each item has identity,
provenance, status, and freshness relative to the code being reviewed.

## Readiness states

| State | Meaning |
| --- | --- |
| Ready | Every blocking requirement is present, current, and accepted. |
| Blocked | A required item failed or a required decision is unresolved. |
| Stale | Evidence was produced for an older workspace state. |
| Missing | A required artifact or result was not delivered. |

Do not replace a missing required artifact with a placeholder report. Fix the
producer or rerun the responsible check.

## Review

Review combines the patch, evidence graph, Run history, and any previous rework
comments. A reviewer may accept, request rework, or take over manually. Rework
creates a traceable new attempt and preserves earlier evidence.

## Promotion rule

Promotion is available only through the configured readiness choke point. An
agent finishing its node does not merge code. The operator still chooses the
target and the supported promotion mode.
