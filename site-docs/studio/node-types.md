---
title: "Flow node and gate types"
description: "Choose the correct execution, coordination, validation, and human node for each part of a Flow graph."
---

A Flow is a directed graph in `flow.yaml`. Each node has one execution model and
explicit outcome transitions. Gates run around a node boundary; they are not
independent graph nodes.

## Prerequisites

- A local package open in [Flow Studio](/studio/flow-studio-and-packages).
- A non-empty `nodes[]` graph. Legacy `steps[]` manifests are not accepted.

## Executable node types

| Type | Use it for | Execution and output |
| --- | --- | --- |
| `ai_coding` | Planning, coding, repository analysis, or any normal agent turn. | Runs in an ACP session, can use a writable worktree and selected capabilities, and can emit artifacts and a structured result. |
| `orchestrator` | Decomposing work and governing child Runs. | Long-lived ACP coordinator that can park while children run, collect their results, and continue under fan-out, depth, active-child, time, token, and failure bounds. |
| `consensus` | Independent proposals followed by cross-checking and synthesis. | MAIster runs at least two participants in read-only workspaces, records rounds and disagreements, then runs a synthesizer. |
| `judge` | An AI assessment that should be distinct from implementation. | Uses an ACP runner and judge capabilities, emits a verdict or structured result, and can route to approval, rework, or a person. |
| `cli` | A package script or deterministic command that changes or produces work. | Runs a command in the worktree. It can write structured JSON to `MAISTER_OUTPUT_FILE` and supports bounded automatic retry for transient infrastructure errors. |
| `check` | A deterministic validation command. | Uses the same command transport as `cli`, but communicates validation intent and does not carry the agent retry policy. |
| `human` | Review, approval, escalation, or manual takeover choice. | Creates a human-in-the-loop request with declared decisions, roles, assignees, severity, and rework options. Submitted values become node variables. |
| `form` | Collecting typed input before later work. | Pauses for fields defined by a schema, has no action, follows `transitions.success`, and exposes submitted fields as node variables. |

Choose by authority, not by presentation. Use `check` for a deterministic test,
`judge` for an AI interpretation, and `human` when accountability or missing
business context requires a person.

## Common node sections

| Section | Purpose |
| --- | --- |
| `input.requires` | Declares prior outputs or current artifacts that must exist. Prompt-bearing nodes can inline artifact bodies. |
| `settings` | Selects runner, session, capabilities, permissions, limits, workspace access, roles, or command policy according to node type. |
| `action` | Contains the ACP prompt or command. A `form` has no action. |
| `output.produces` | Declares typed evidence such as a diff, test report, log, judgment, plan, or checkpoint. |
| `output.result` | Declares a small schema-validated value for downstream templates and routing. |
| `pre_finish.gates` | Runs blocking or advisory checks before the node can finish. |
| `finish.human` | Requests a final human decision at the node boundary. |
| `transitions` | Maps outcomes such as `success`, `approve`, or `rework` to another node or `done`. |
| `rework` | Bounds loops, allowed targets, workspace behavior, and feedback injection. |
| `decide` | Derives a transition outcome from structured output or a verdict. |

## Gate types

| Kind | What it proves |
| --- | --- |
| `command_check` | A local command exited with the required result. |
| `skill_check` | A named review or verification skill evaluated the work. |
| `ai_judgment` | An AI evaluator returned a calibrated verdict. |
| `artifact_required` | Required evidence exists and optional path-mutation assertions hold. |
| `external_check` | CI or another external system reported a signed result through the external API. |
| `human_review` | A person inspected the work and chose an allowed decision. |

Blocking gates prevent the node from finishing. Advisory gates record evidence
without stopping traversal. A verdict used by `decide` becomes routing input;
the Flow's cases determine the next node.

## Sessions and runners

Runner-bearing nodes can join a named session or use their own slot. Nodes in
one named session share the session's runner and conversational context. Separate
sessions can bind different adapter/model/provider profiles, so a Flow can use a
different coding agent for planning, implementation, and verification.

Consensus participant and synthesizer slots are also explicit. Every slot is
resolved before execution and snapshotted on the Run.

## Rework and retry are different

- `retry_policy` repeats an `ai_coding` or `cli` node after selected transient
  infrastructure errors. It can restore the node checkpoint first.
- `rework` is a graph-level correction loop initiated by a reviewer, verdict,
  or structured-result mismatch. It can target an earlier node and makes
  downstream attempts and evidence stale.
- `retry_safe` permits operator re-dispatch of a session-less crashed node. Set
  it only when repeating that node's side effects is safe.

Bound every automatic loop. Use a human escalation when the Flow cannot make a
safe decision after the declared number of attempts.

## Evidence, result, and logs

Do not combine these channels:

- evidence is durable proof used by review and promotion;
- a structured result is a small value used by later nodes and dynamic routing;
- stdout and event logs explain execution but are not a typed result contract.

Continue with [structured results and Run context](/studio/structured-results-and-context)
for exact transports and template paths.
