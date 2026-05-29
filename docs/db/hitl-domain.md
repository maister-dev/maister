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
        text step_id "Flow step that raised it"
        text kind "permission | form | human"
        jsonb schema "form_schema or permission descriptor"
        text prompt "human-readable rationale"
        jsonb response "operator's answer (NULL while open)"
        timestamp responded_at "NULL while open"
        timestamp created_at
    }
```

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
| `human` | Form-shaped object, optionally including review fields such as `{ rejected?: boolean, comments?: string }`. Rejection is audit data until the designed loopback path lands. |

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
