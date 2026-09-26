---
title: "Flow manifest reference"
description: "Define a versioned graph of agent, command, check, human, and orchestration nodes in flow.yaml."
---

`flow.yaml` is the package contract for a delivery process. Schema version 1
defines metadata, compatibility, nodes, transitions, inputs, outputs, gates,
and bounded rework.

## Shape

```yaml
schemaVersion: 1
name: Feature delivery
compat:
  engine_min: 3.0.0
nodes:
  - id: implement
    type: ai_coding
    action:
      prompt: "Implement the task: {{ task.prompt }}"
    transitions:
      success: verify
  - id: verify
    type: check
    action:
      command: git diff --check
    transitions:
      success: review
      failure: review
  - id: review
    type: human
    finish:
      human:
        decisions: [approve, rework]
    transitions:
      approve: done
      rework: implement
    rework:
      allowedTargets: [implement]
      workspacePolicies: [keep]
      maxLoops: 3
      commentsVar: review_comments
```

Execution starts at the first node. `done` is a reserved transition target, not
a node type. This example uses the resolved default runner and only a whitespace
check; add your project's actual tests and required evidence before using it
for delivery. The reviewer inspects a failed check before requesting rework.

The current engine is **3.8.0**. Keep the minimum at the earliest version that
supports the Flow's contracts. Flows that rely on rendering a consensus draft
prompt with Run context before fan-out should declare `engine_min: 3.8.0`.
Participant output is inserted as data into verifier and synthesizer prompts;
template-like text in that output is not expanded again.

## Authoring rules

- Give every node a stable unique identifier.
- Declare all transition targets.
- Bound every rework loop.
- Keep runner selection explicit or inherit it intentionally.
- Declare required inputs and evidence rather than relying on prompt prose.
- Use setup scripts only in packages whose executable content is trusted.
- Raise `compat.engine_min` only when the Flow needs the newer contract.

## Installation contract

MAIster validates the graph and compatibility before a package can run. The
installed revision and trust status are recorded. Editing the package source
does not mutate an already active Run.
