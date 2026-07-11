# `web/lib/db/`

Drizzle ORM schema, client factory, and migration runner.

## Workflow

### 1. Edit `schema.ts`

Add tables, columns, or indexes in `lib/db/schema.ts`. Use Drizzle's
`pgTable` builder. Server-only — never import from a Client Component.

### 2. Generate a migration

```bash
pnpm db:generate
```

Reads `schema.ts`, diffs it against the snapshot, writes a new SQL file
under `lib/db/migrations/`. Never hand-edit committed migrations — generate
a new one if you need to change shape.

### 3. Apply migrations

Run against the local Postgres in docker compose:

```bash
docker compose up postgres -d
DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:migrate
```

The runner exits 1 if `DB_URL` is missing or does not point at Postgres.
Migrations and the runtime always use Postgres.

### 4. Seed (optional)

```bash
pnpm db:seed
```

Idempotent: re-runs recreate or update platform runtime defaults, then are
no-ops once the sample project exists.

## Local destructive reset

For the platform ACP runner feature, local MAIster installs are disposable.
When a schema rewrite is cleaner than legacy compatibility, use an explicit
local reset instead of preserving stale project-scoped executor rows.

A reset command or runbook may delete only MAIster-owned state:

- the MAIster Postgres database;
- `.maister/` runtime artifacts created by the app;
- MAIster Flow and capability caches;
- MAIster-created worktrees;
- generated platform runtime config files.

It must print every root it will remove before deletion and must not delete
arbitrary source repositories.

Use the repository script first as a dry-run:

```bash
pnpm local:blast-maister-state
pnpm local:blast-maister-state -- --confirm BLAST_MAISTER_LOCAL_STATE
pnpm local:blast-maister-state -- --confirm BLAST_MAISTER_LOCAL_STATE --reset-postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:seed
```

The confirmed script deletes only MAIster-owned runtime/cache/worktree/config
roots. `--reset-postgres` additionally resets the `public` schema through
`DB_URL`; it accepts only `postgres://` or `postgresql://` URLs and never
removes project repositories. An invalid URL aborts before any local root is
removed.

## Connection pool

`buildClient` reads `MAISTER_DB_POOL_MAX` for the Postgres pool size
(default 10). Surface it in `.env.example` even though it is optional.

## Public API

- `buildClient()` — fresh Drizzle client per call (no module-level side
  effects). Throws `MaisterError({ code: "CONFIG" })` on missing or
  unsupported `DB_URL`.
- `getDb()` — process-wide lazy singleton built on first call.
- `maskUrl(url)` — masks the password portion for safe logging.
- `schema` — re-exported `* as schema` for query type inference.
