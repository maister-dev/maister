# HITL domain ERD

Single table — `hitl_requests` — plus the in-jsonb shape of the
`schema` (form schema) and `response` payload. See
[`../system-analytics/hitl.md`](../system-analytics/hitl.md) for
process flows.

```mermaid
erDiagram
    RUNS ||--o{ HITL_REQUESTS : "raises during execution"

    HITL_REQUESTS {
        text id PK
        text run_id FK
        text step_id "Flow step / node that raised it"
        text kind "permission | form | human"
        jsonb schema "form_schema or permission descriptor (+ review allow-list)"
        text prompt "human-readable rationale"
        jsonb response "operator's answer (NULL while open)"
        text decision "M11a review decision (claimed from response.decision)"
        text workspace_policy "M11a chosen rework workspace policy"
        text rework_target "M11a resolved rework target node"
        text criticality "M17 Implemented: flow-declared low|medium|high|critical (write-once at creation, NULL if undeclared)"
        real human_confidence "M17 Implemented: responder self-report 0..1 (written at respond time, NULL while open)"
        timestamp responded_at "NULL while open"
        timestamp created_at
    }
```

> **(M11a — Designed, migration `0010`.)** The `decision`, `workspace_policy`,
> and `rework_target` columns are populated only for a graph `human_review`
> HITL. The reviewer's choice rides inside the `response` form payload; the
> respond route validates it against the manifest-derived allow-list stored in
> `schema` at creation and copies the resolved values into these columns at claim
> time. See [`../system-analytics/flow-graph.md`](../system-analytics/flow-graph.md).

> **(M17 — Implemented, migration `0025`.)** The HITL assessment taxonomy (ADR-054):
> - `criticality` — flow-author-declared severity (`low | medium | high | critical`,
>   enforced at the app layer), copied from the `human` node/step manifest into the
>   row at INSERT. **Write-once**: set at creation, never updated; `NULL` when the
>   Flow author leaves it undeclared (no DB default).
> - `human_confidence` — the responder's self-reported certainty in `[0, 1]`,
>   written in the respond service's Phase-1 transaction and **also echoed into the
>   `response` jsonb** as `{ confidence: <number> }`. `NULL` while the row is open.
>   This is the *human* responder's self-report — distinct from the M15 AI-judge
>   `GateVerdict.confidence` on `gate_results.verdict` (machine confidence). The two
>   are never conflated.

## In-jsonb shape — `schema` column

For `kind=form` and `kind=human`, `schema` stores the form schema and
is validated by `formSchemaSchema` in `web/lib/config.schema.ts`. For
`kind=permission`, `schema` stores `{ requestId, options, toolCall,
supervisorSessionId }`.

```mermaid
classDiagram
    class FormSchema {
        +integer schemaVersion
        +FormField[] fields
    }
    class FormField {
        +string name
        +string label?
        +'string'|'number'|'boolean'|'enum'|'array' type
        +boolean required?
        +unknown default?
        +string[] options?
    }
    FormSchema *-- FormField
```

The `schemaVersion` integer is mandatory. Mismatched versions throw
`MaisterError("CONFIG")` via `validateFormSchemaVersion`.

## In-jsonb shape — `response` column

Shape varies by kind:

| Kind | Response shape |
| ---- | -------------- |
| `permission` | `{ optionId: string }` |
| `form` | An object whose keys match `schema.fields[].name`, with the matching `type`. |
| `human` | Form-shaped object, optionally including review fields such as `{ rejected?: boolean, comments?: string }`. **(M11a — Designed)** a graph `human_review` payload carries `{ decision, comments?, workspacePolicy? }` validated against the row's `schema` allow-list and mirrored into the `decision`/`workspace_policy`/`rework_target` columns. |

**(M17 — Implemented.)** On any `form`/`human`/review response the responder's
self-reported `human_confidence` is echoed into `response` as `{ confidence: <number> }`
(`0..1`), alongside whatever the kind's payload already carries. The canonical
store for the value is the `human_confidence` column; the `response.confidence`
echo keeps the answer self-describing without a separate read.

Free-form `additionalProperties` are tolerated (forward-compat).

## Constraints

- `hitl_requests_run_idx` on `(run_id)` — pending HITL panel queries.
- No UNIQUE on `(run_id, step_id)` — one step can raise multiple HITL
  asks over a run's lifetime.

## Lifecycle

```
open (response IS NULL, responded_at IS NULL)
  -> claimed (response populated, responded_at IS NULL)
  -> delivered (response populated, responded_at IS NOT NULL)
  -> timed out (permission deferred -> Failed; designed idle timeout -> Abandoned)
```

The row is never deleted (cascades from `runs` and `projects` only).

## Linked artifacts

- Process flows: [`../system-analytics/hitl.md`](../system-analytics/hitl.md).
- Config: [`../configuration.md`](../configuration.md) §`form_schema versioning`.
- Source: `web/lib/db/schema.ts` (`hitl_requests` table),
  `web/lib/config.schema.ts` (`formSchemaSchema`),
  `web/lib/config.ts` (`validateFormSchemaVersion`).
