---
title: "Project Brain and platform agents"
description: "Use governed project knowledge, durable agent memory, and explicit triggers for background work."
---

Project Brain is MAIster's managed knowledge layer. Platform agents are named,
package-defined workers that can use that knowledge outside a delivery Flow.
Together they let a project learn without turning local notes and background
automation into invisible state.

## What Project Brain stores

Project Brain separates curated project sources from agent-owned memory:

- managed references, project rules, dependency notes, and Flow documentation;
- accepted lessons with source trace, review state, and freshness signals;
- proposals that a person can accept, reject, or revise;
- private durable memory for an agent attached to a project.

Agents recall only the context allowed for their run. A retained observation is
not automatically a project rule: it enters the proposal and review path first.

## Platform agents

A platform agent has a package revision, capability profile, project grants,
budget, and trigger policy. It can be launched manually or by a schedule,
webhook, domain event, or explicit mention. Its run appears in the same ledger
and attention surfaces as other MAIster work.

Use platform agents for bounded routines such as triage, dependency watches,
documentation review, or project-knowledge maintenance. Use a Flow when the
work belongs to a delivery process with declared gates and promotion.

## Agents in the built-in Core package

MAIster Core provides working examples of the platform-agent contract:

| Agent | Trigger | Responsibility |
| --- | --- | --- |
| `core:triager` | Task domain events or manual | Selects Flow, runner, branch, priority, dependencies, duplicates, clarification, and enqueue intent. It never launches around the normal admission gate. |
| `core:improver` | Schedule or manual | Finds recurring Project Brain evidence clusters and drafts small proposals for human review. It never applies them. |
| `core:experiment-judge` | Evaluation Lab | Scores blinded Run candidates against a versioned rubric. It is advisory and cannot conclude or promote a winner. |

Trusted packages can ship additional agents through the same identity,
capability, trigger, policy, budget, and project-attachment model.

## Operational rule

Treat Brain updates and agent output as governed artifacts. Review durable
knowledge, keep triggers narrow, and inspect the run and budget before allowing
an agent to create follow-up work.
