# Database — ERDs

Entity-Relationship views of the MAIster schema. Source of truth for column
shape and constraints is the Drizzle schema — `web/lib/db/schema.ts` (main
lineage) plus `web/lib/brain/schema.ts` (Brain lineage, ADR-122); the prose
reference is [`../database-schema.md`](../database-schema.md).

Two kinds of view live here (ADR-159):

- **Consolidated** — [`erd.dbml`](erd.dbml), **generated** from both Drizzle
  lineages and drift-gated by `pnpm validate:docs`. Never hand-edit it;
  regenerate with `pnpm --filter maister-web db:erd`. [`erd.md`](erd.md) is
  its wrapper (how to view/regenerate).
- **Per-domain** — hand-maintained Mermaid `erDiagram`s, one file per domain.
  If a domain diagram disagrees with the Drizzle schema, the schema wins —
  open a PR to fix the ERD.

## Files

| File | Scope |
| ---- | ----- |
| [`erd.dbml`](erd.dbml) | Generated consolidated ERD across all tables of both lineages (ADR-159). |
| [`erd.md`](erd.md) | Wrapper for the consolidated ERD: view/regenerate instructions. |
| [`projects-domain.md`](projects-domain.md) | Projects + Executors + Flows. |
| [`runs-domain.md`](runs-domain.md) | Tasks + Runs + Workspaces + scratch-run tables. |
| [`hitl-domain.md`](hitl-domain.md) | HITL Requests + review-comment threads (ADR-072) + form-schema shape. |
| [`artifacts-domain.md`](artifacts-domain.md) | Typed artifact instances + projection cursors. |
| [`assignments-domain.md`](assignments-domain.md) | Flow roles, actors, assignments, and assignment events (ADR-040). |
| [`capabilities-domain.md`](capabilities-domain.md) | Capability records + git-pinned imports + materialization plan column (Implemented). |
| [`domain-events.md`](domain-events.md) | Domain-event outbox: `domain_events` fact log + per-consumer cursors (ADR-086, Implemented). |
| [`agents-domain.md`](agents-domain.md) | Platform-agent tables: `agents` catalog, `agent_project_links`, `agent_schedules` (ADR-089/090). |
| [`brain-domain.md`](brain-domain.md) | Project Brain lineage tables (ADR-122/127/128). |
| [`evaluations-domain.md`](evaluations-domain.md) | Evaluation Lab tables (ADR-142..147, ADR-150). |
| [`integrations-domain.md`](integrations-domain.md) | Project tokens + token audit log. |
| [`scheduler-domain.md`](scheduler-domain.md) | Scheduler jobs + run schedules + scheduled task launches (ADR-060/071, ADR-139). |
| [`webhooks.md`](webhooks.md) | Webhook subscriptions + events outbox + deliveries + attempts (ADR-077). |

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
