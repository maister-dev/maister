# Database — Mermaid ERDs

Domain-grouped Entity-Relationship Diagrams for the MAIster schema.
Source of truth for column shape and constraints is the Drizzle
schema in `web/lib/db/schema.ts`; the prose reference is
[`../database-schema.md`](../database-schema.md).

The diagrams in this folder are the **visual** view. If they disagree
with the Drizzle schema, the Drizzle schema wins — open a PR to fix
the ERD.

Scratch-run persistence, the selectable capability catalog, M12 artifacts, and
M13 assignment persistence are included in the ERDs because migrations now back
those contracts. Roadmap persistence for API tokens and external operation
events remains tracked in
[`../database-schema.md#planned-roadmap-persistence`](../database-schema.md#planned-roadmap-persistence)
until migrations exist.

## Files

| File | Scope |
| ---- | ----- |
| [`erd.md`](erd.md) | Full ERD across implemented tables. |
| [`projects-domain.md`](projects-domain.md) | Projects + Executors + Flows. |
| [`runs-domain.md`](runs-domain.md) | Tasks + Runs + Workspaces + scratch-run tables. |
| [`hitl-domain.md`](hitl-domain.md) | HITL Requests + form-schema shape. |
| [`assignments-domain.md`](assignments-domain.md) | M13 Flow roles, actors, assignments, and assignment events. |

## Cardinality notation

Mermaid `erDiagram` cardinality symbols used throughout:

| Symbol | Meaning |
| ------ | ------- |
| `||--||` | One-to-one (mandatory both sides). |
| `||--o{` | One-to-many (mandatory parent, zero-or-more children). |
| `||--|{` | One-to-many (mandatory parent, one-or-more children). |
| `o|--o{` | Optional one to zero-or-more children. |

All FK relationships in MAIster are `||--o{` unless explicitly noted —
the parent is mandatory (NOT NULL FK), the children are zero-or-more.

## Cascade chain

Every FK is `ON DELETE CASCADE`. Deleting a project drops the entire
descendant tree in one statement. See [`../database-schema.md#cascade-chain`](../database-schema.md#cascade-chain).
