# Full database ERD

The consolidated ERD across every table of both Drizzle lineages lives in
[`erd.dbml`](erd.dbml) — a **generated** DBML artifact ([ADR-159](../decisions.md#adr-159)).
The previous hand-maintained Mermaid diagram was retired: at ~78 entities it
exceeded the 50,000-character `maxTextSize` every Mermaid renderer enforces
(so it no longer rendered anywhere) and it had silently fallen ~30 tables
behind the schema. The generated DBML cannot drift — a gate fails the build
when it does.

## Source of truth and regeneration

- Source: `web/lib/db/schema.ts` (main lineage) + `web/lib/brain/schema.ts`
  (Brain lineage, ADR-122). The generator merges both, de-duplicating alias
  exports and expression-index column repeats.
- Regenerate after any schema change:

  ```bash
  pnpm --filter maister-web db:erd
  ```

- Drift gate: `pnpm --filter maister-web db:erd --check` regenerates in
  memory and fails when the committed `erd.dbml` differs. It runs as part of
  `pnpm validate:docs`, so a schema change that forgets to regenerate cannot
  merge quietly.

## Viewing

- Import `erd.dbml` into [dbdiagram.io](https://dbdiagram.io/d) (File →
  Import → DBML) or any DBML-aware renderer/IDE plugin.
- The file is also plainly greppable: `table <name> { … }` blocks with
  column types, `indexes { … }`, and `ref:` lines for every foreign key.

## Scope notes

- The DBML is the **shape** view (tables, columns, types, FKs, indexes).
  Column semantics, index rationale, and cascade behavior live in
  [`../database-schema.md`](../database-schema.md); expression-index details
  live in the migrations.
- For focused, reviewable diagrams use the per-domain Mermaid ERDs listed in
  [`README.md`](README.md) — those stay hand-maintained Mermaid by design
  (each is well under renderer limits).
