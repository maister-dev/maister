---
title: "Structured results and Run context"
description: "Validate node output, reuse it through Flow variables, route on values, and distinguish results from evidence."
---

Structured results let one node publish a small JSON value that later nodes can
read without scraping prose. MAIster validates the value against a package
schema and stores it with that node attempt.

## Prerequisites

- A graph Flow with a package-root `schemas/*.json` file.
- `compat.engine_min` compatible with the result features used by the Flow.

## Declare a result

```yaml
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: "Plan {{ task.prompt }} and return a structured result."
    output:
      result:
        schema: ./schemas/plan-output.json
        required: true
      produces:
        - id: plan-document
          kind: plan
          path: plan.md
```

The result and the `plan-document` are separate. The result can contain fields
such as `risk`, `components`, or `recommended_runner`. The evidence entry points
to the reviewable plan body.

An example schema:

```json
{
  "schemaVersion": 1,
  "fields": [
    {
      "name": "risk",
      "type": "enum",
      "options": ["low", "medium", "high"],
      "required": true
    },
    {
      "name": "components",
      "type": "array",
      "items": { "type": "string" }
    },
    { "name": "details", "type": "json" }
  ]
}
```

Schemas support `string`, `number`, `boolean`, `enum`, `array`, `object`, and
`json`. Objects are open: declared fields are validated, while additional keys
are preserved. The complete payload is capped by
`MAISTER_NODE_OUTPUT_MAX_BYTES`, 256 KiB by default.

## How each node returns JSON

| Node type | Transport |
| --- | --- |
| `ai_coding`, `judge`, `orchestrator` | End the completing response with a fenced block tagged `json maister:output`. MAIster reads the last correctly fenced block. |
| `cli`, `check` | Write JSON to the per-attempt path in `MAISTER_OUTPUT_FILE`. |
| `consensus` | MAIster validates the result object produced by the consensus engine. |
| `human`, `form` | Their submitted HITL values already become variables; declaring `output.result` is invalid. |

For an agent response, the final block looks like:

````markdown
```json maister:output
{"risk":"medium","components":["web","supervisor"]}
```
````

If `required: true`, a missing block or file fails the attempt. Any present but
invalid JSON fails regardless of `required`.

## Reuse results downstream

Validated fields are stored in `node_attempts.vars` and exposed through the
stable template namespace:

```yaml
- id: implement
  type: ai_coding
  action:
    prompt: >-
      Implement {{ task.prompt }}.
      Planning risk: {{ steps.plan.vars.risk }}.
```

Useful template paths include:

| Path | Value |
| --- | --- |
| `task.id`, `task.title`, `task.prompt` | Task identity and requested outcome. |
| `run.id` | Current Run identity. |
| `executor.model` | Snapshotted model label for the active runner. |
| `steps.<id>.output` | Truncated text output of the latest attempt. |
| `steps.<id>.vars.<field>` | Validated structured value from the latest attempt. |
| `steps.<id>.exitCode` | Command exit code from the latest attempt. |
| `artifacts.<id>.kind`, `.uri`, `.validity`, `.nodeId` | Current evidence metadata. |
| `artifacts.<id>.content` | Bounded body of a current artifact for prompt-bearing nodes. |

Templates are strict. A missing bare path stops with a configuration error.
Use a default only when absence is valid:

```text
{{ steps.plan.vars.risk ?? "unknown" }}
```

When a node is retried or reworked, `steps.<id>` resolves to its highest
attempt. Earlier attempts remain in the Run ledger for audit.

## Route on a structured value

```yaml
decide:
  from: output.risk
transitions:
  low: implement-fast
  medium: implement
  high: human-review
```

Every value the Flow can produce should have a declared transition. You can
also route on an AI or skill verdict with `from: verdict` and an ordered cases
table ending in one default case.

## Recover from a schema mismatch

By default, malformed structured output fails the Run. To give the producer a
bounded correction attempt, configure `output.result.on_mismatch` and a rework
block:

```yaml
output:
  result:
    schema: ./schemas/plan-output.json
    required: true
    on_mismatch: retry
rework:
  allowedTargets: [plan]
  workspacePolicies: [keep]
  maxLoops: 2
  commentsVar: result_errors
```

MAIster injects the validation reason into `result_errors`. Exhausting the loop
fails closed; invalid data is never accepted as a result.

## The Run context file

MAIster also projects task intent, latest node summaries and variables, gate
statuses, promoted values, and optional Project Brain context into
`.maister/run.json` inside the worktree. Each agent prompt receives a pointer to
this file. It is regenerated from the ledger after node transitions and is
excluded from git.

The file is a session-independent blackboard. Flow correctness still uses the
ledger and strict templates, so a resumed or replacement session can reconstruct
the same state.

## Public Run results

A Flow can export a schema-validated Run result for a parent orchestrator or an
Evaluation Study. The top-level `result.export` names the schema and permitted
producer nodes. The export uses the pinned Flow revision and gains its own
revision history; rework can make an older result stale or superseded.

Use public results for delegation contracts. Use `output.produces[]` for files,
diffs, reports, and other evidence that a person or gate must inspect.

## Failure signals

- Missing required payload: the producer did not use its assigned transport.
- Schema mismatch: inspect the field path and compare the output with the pinned
  schema.
- Undefined template variable: add a real upstream dependency or a deliberate
  default; do not replace it with an empty string.
- Stale result after rework: rerun the producer before collection or conclusion.
