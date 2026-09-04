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
id: feature
name: Feature delivery
version: 1.0.0
compat:
  engine_min: 3.0.0
start: implement
nodes:
  - id: implement
    kind: agent
    transitions:
      success: verify
  - id: verify
    kind: check
    transitions:
      success: review
      failure: implement
  - id: review
    kind: human_review
    transitions:
      approved: done
      rework: implement
  - id: done
    kind: terminal
```

Treat this as a structural example. Node settings depend on the node kind and
the engine compatibility floor declared by the package.

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
