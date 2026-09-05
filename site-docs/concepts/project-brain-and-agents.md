---
title: "Project Brain, embeddings, and platform agents"
description: "Index canonical project sources, retain governed lessons, recall context, and turn recurring evidence into reviewed improvements."
---

Project Brain is a project-scoped knowledge layer. It combines vector and
lexical retrieval over canonical repository sources with governed memory
retained from delivery events. Platform agents can read or propose changes to
that knowledge only through explicit project grants.

## Prerequisites

- A pgvector-enabled Postgres database with the Brain migrations applied.
- Global embedding and distillation provider settings.
- Project Brain enabled in project settings.
- For an agent, explicit Brain read or write permission on its project
  attachment.

![Project Brain sources, indexing, and governed knowledge](/assets/screens/en/project-brain.png)

## Two knowledge tiers

| Tier | Contents | Authority |
| --- | --- | --- |
| Indexed | Typed chunks from canonical repository sources such as project documentation, decisions, and code-oriented sources. | The repository remains canonical. Recall returns a preview and source pointer. |
| Owned memory | Lessons, observations, and state facts retained from Runs, gates, or explicit agent operations. | MAIster owns lifecycle, confidence, reinforcement, and expiry. |

Decisions and directions prefer a declared canonical home. When such a home
exists, an agent must propose a change to that source instead of silently
creating a competing memory item.

## Configure providers

Open **Settings → Project Brain providers** as a global administrator and set:

- embedding base URL, model, dimensions, and an `env:NAME` API-key reference;
- optional separate distillation URL, model, and key reference;
- otherwise, distillation uses the embedding provider route.

The secret value lives in the web service environment. Changing model or vector
dimensions creates a new immutable embedding generation and queues reindexing;
it does not rewrite old vectors in place.

## Enable Brain for a project

Open **Project → Settings → Brain**. Enabling is refused until embedding and
distillation configuration is complete. Then open **Project → Brain** to manage
sources and indexing.

A source identifies a bounded repository-relative path or glob. MAIster reads
tracked content from the project's default branch, chunks it with a typed
parser, stores source pointers and previews, and creates vector embeddings.
Ignored, untracked, absolute, or escaping paths are refused.

Indexing runs through scheduler jobs. Repository events can enqueue source
reindexing, and an operator can request it manually. The source row shows the
last indexed time and a deterministic error when a file, glob, parser, or
provider prevents progress.

## Recall

Recall embeds the query once and combines:

- vector similarity against the active embedding generation;
- lexical rank over indexed chunks and owned memory;
- confidence and lifecycle policy for retained items.

It performs no completion-model call while reading. Indexed hits include a
bounded preview and canonical source pointer. Every consumption records a
snapshot of the query, model, returned item IDs, scores, and pointers so later
audits can reconstruct which knowledge was supplied.

A Flow Run can opt into ambient Brain context. MAIster recalls against the task
title and prompt, adds only sufficiently reinforced items to `.maister/run.json`,
and marks them as background context rather than instructions. A provider outage
does not fail the Run; it omits ambient context and leaves a diagnostic signal.

## Retention and improvement

Terminal Run and gate events can be distilled into a bounded lesson. Near
duplicate lessons and observations reinforce an existing item. A changed state
fact supersedes the old fact. Time-limited items expire through the scheduler;
state facts do not decay in the same way.

Recurring evidence can become an improvement proposal:

1. MAIster groups related retained evidence.
2. A person or the `core:improver` agent drafts a proposal.
3. A person accepts, rejects, or revises it.
4. Accepted rule, skill, or Flow changes become unpublished local drafts.
5. Documentation, roadmap, or state changes can become board tasks routed
   through the project's normal delivery process.

Brain never publishes a package or writes repository files directly. The
proposal, task, Studio draft, review, and promotion boundaries remain visible.

## Platform agents

A platform agent is a package-defined actor with a runner policy, workspace
mode, capability profile, triggers, budget, and project attachment. Use one for
bounded routines such as triage, monitoring, error handling, dependency review,
pull-request assistance, or knowledge maintenance. Use a Flow for the reusable
delivery process that produces and validates a project change.

Built-in examples include:

| Agent | Responsibility |
| --- | --- |
| `core:triager` | Suggests Flow, runner, branch, priority, relations, clarification, and enqueue intent for a task. |
| `core:improver` | Finds recurring Brain evidence and drafts proposals for review. |
| `core:experiment-judge` | Evaluates blinded Study participants under a versioned method. |

The agent attachment has separate `can read Brain` and `can write Brain` grants.
Write access permits retention and proposals; it does not permit publication.

## Failure signals

- Brain tab absent: the project has not enabled Brain or the installation is not
  provisioned.
- Enable refused: configure both embedding and distillation models first.
- Source error: correct the repository-relative path, reduce an overbroad glob,
  fix parsing, or restore provider access.
- Embedding unavailable: retry after transient provider failure; deterministic
  authentication or request errors require configuration changes.
- No ambient context: the Run did not opt in, the project is disabled, no item
  met the confidence threshold, or recall degraded safely.

## Related guides

- [Scheduler and platform agents](/administration/scheduler-and-platform-agents)
- [Structured results and Run context](/studio/structured-results-and-context)
- [Project workspace](/product-tour/project-workspace)
