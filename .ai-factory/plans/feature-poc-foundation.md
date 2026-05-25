# Phase 0 — POC Foundation: M1 + M2 + Test Infra

- **Branch**: `feature/poc-foundation` (off `main`)
- **Created**: 2026-05-25
- **Parent plan**: [`poc-implementation.md`](./poc-implementation.md) — Phase 0 (sequential, ~3-5 days)
- **Roadmap milestones**: M1 (Drizzle schema + Postgres) + M2 (Core libs: errors, atomic, config v2) + cross-cutting test infrastructure
- **Critical-path**: yes. Every later phase imports from `lib/db/schema.ts`, `lib/errors.ts`, `lib/atomic.ts`, `lib/config.ts`. Changing the foundation mid-implementation forces N rewrites.

## Settings

- **Testing**: yes — `vitest` for unit + integration, `@playwright/test` scaffolded (no specs yet — first specs land in Phase 3).
- **Logging**: verbose — `pino` JSON logs at DEBUG by default. Every module covered here emits structured logs on load + every public function emits INFO on entry / DEBUG on details / WARN on degraded paths / ERROR before throwing.
- **Docs**: yes (mandatory) — `/aif-docs` checkpoint runs after this branch ships (before PR merge).
- **Roadmap Linkage**: M1 + M2 in `.ai-factory/ROADMAP.md` get checked off when this branch merges.

## Roadmap Linkage

**Milestone**: M1 (Drizzle schema + Postgres) AND M2 (Core libs: errors, atomic, config v2).
**Rationale**: this branch IS the implementation of M1 + M2 plus the test infrastructure (M0.T) every later milestone depends on. They ship together because (a) they form one logical PR boundary (web/lib/* + web/lib/db/* + tooling), and (b) executing them as separate PRs would mean either landing tests-without-tested-code or tested-code-without-tests — both bad.

## Pre-flight Context

Already on disk (do NOT re-create):

- `compose.yml` — Postgres 16 service with named volume `postgres_data`, healthcheck, env vars `POSTGRES_USER/PASSWORD/DB` defaulting to `maister/maister/maister`. **Reuse this**, don't add another Postgres service.
- `compose.override.yml` + `compose.production.yml` — dev/prod overlay (already wired by `/aif-dockerize`).
- `Dockerfile` — Node 24 + Python 3.12 + uv + pnpm multi-stage build.
- `.env.example` — already declares `DB_URL=postgres://maister:maister@postgres:5432/maister` and the secret-key placeholders.
- `.dockerignore` — already configured.
- `web/eslint.config.mjs` — ESLint 9 flat config, will be extended (NOT rewritten).
- `web/tsconfig.json` — `strict: true`, `noEmit: true`, `paths: {"@/*": ["./*"]}`. Already correct for our purposes; do NOT widen `strict`.

Not yet on disk (this branch creates):

- `web/lib/` — does not exist. This branch creates `lib/errors.ts`, `lib/atomic.ts`, `lib/config.ts`, `lib/config.schema.ts`, `lib/db/schema.ts`, `lib/db/client.ts`, `lib/db/seed.ts`, `lib/db/migrations/*`.
- `web/vitest.config.ts`, `web/playwright.config.ts`, `web/drizzle.config.ts` — none exist yet.
- `.github/workflows/` — entire directory missing.
- `.pre-commit-config.yaml` — missing.
- Local DB URL adjustment: `compose.yml` references `postgres://...@postgres:5432/...` (container hostname). For `pnpm dev` outside Docker, set `DB_URL=postgres://maister:maister@localhost:5432/maister` (different port mapping if Docker is up — handle in `.env.example` doc note).

## Tasks

Tasks are file-level. Each is sized for one focused `/aif-implement` step. Dependencies use `blockedBy` semantics (Task X cannot start until Task Y is `Done`).

### Group A — Test infrastructure & scripts (lands first; unblocks B/C/D)

#### Task A1 — Add dev dependencies to `web/package.json`

- **Deliverable**: append the following to `web/package.json` `devDependencies` and `dependencies` (run `pnpm add -D ... && pnpm add ...` from `web/` so the lockfile updates atomically):
  - **Runtime (`dependencies`)**: `drizzle-orm@^0.36`, `pg@^8.13`, `zod@^3.23`, `pino@^9`, `pino-pretty@^11` (pretty is dev-only — actually put under devDependencies).
  - **Dev (`devDependencies`)**: `drizzle-kit@^0.28`, `@types/pg@^8.11`, `vitest@^2.1`, `@vitest/ui@^2.1`, `testcontainers@^10`, `@playwright/test@^1.49`, `pino-pretty@^11`, `tsx@^4` (for running scripts like seed + migrations).
- **Files**: `web/package.json`, `web/pnpm-lock.yaml`.
- **Logging**: not applicable — config only.
- **Verification**: `cd web && pnpm install --frozen-lockfile` succeeds (after lockfile updated); `pnpm ls drizzle-orm zod vitest testcontainers` shows the resolved versions.
- **Logging requirement check**: n/a.
- **blockedBy**: none.

#### Task A2 — `web/vitest.config.ts`

- **Deliverable**: vitest config with two projects:
  - `unit` — globs `web/lib/**/*.test.ts` + `web/lib/**/__tests__/**/*.test.ts`, no setup file, runs fast (target: <10s for the whole suite at end of Phase 0).
  - `integration` — globs `web/lib/**/*.integration.test.ts`, longer timeout (60s — testcontainers boot is slow on first run), uses `testcontainers` to provision Postgres ephemerally.
  - Coverage via `@vitest/coverage-v8` is OPTIONAL for POC; omit unless lint complains.
- **Files**: `web/vitest.config.ts`.
- **Logging**: n/a.
- **Verification**: `cd web && pnpm exec vitest run --project unit` exits 0 (no tests yet, but the config loads cleanly); same for `--project integration`.
- **blockedBy**: A1.

#### Task A3 — `web/playwright.config.ts` (scaffolded, no specs)

- **Deliverable**: minimal Playwright config pointing `testDir: './e2e'` (create empty `web/e2e/.gitkeep`), `baseURL: 'http://localhost:3000'`, single Chromium project. No specs land in this branch — Playwright is scaffolded so Phase 3 can add specs without re-doing config.
- **Files**: `web/playwright.config.ts`, `web/e2e/.gitkeep`.
- **Logging**: n/a.
- **Verification**: `cd web && pnpm exec playwright test --list` returns 0 tests, exit 0.
- **blockedBy**: A1.

#### Task A4 — `web/package.json` scripts

- **Deliverable**: append the following scripts to `web/package.json`:
  ```json
  {
    "scripts": {
      "dev": "next dev",
      "build": "next build",
      "start": "next start",
      "lint": "eslint --fix",
      "typecheck": "tsc --noEmit",
      "test": "pnpm test:unit && pnpm test:integration",
      "test:unit": "vitest run --project unit",
      "test:integration": "vitest run --project integration",
      "test:watch": "vitest --project unit",
      "test:e2e": "playwright test",
      "db:generate": "drizzle-kit generate",
      "db:migrate": "tsx lib/db/migrate.ts",
      "db:seed": "tsx lib/db/seed.ts",
      "db:studio": "drizzle-kit studio"
    }
  }
  ```
- **Files**: `web/package.json`.
- **Logging**: n/a.
- **Verification**: `cd web && pnpm typecheck` exits 0 (no TS errors yet — repo currently typechecks clean). `pnpm test:unit` exits 0 (empty suite).
- **blockedBy**: A1.

#### Task A5 — `.pre-commit-config.yaml` at repo root

- **Deliverable**: pre-commit config (https://pre-commit.com) running on changed files only:
  - `pre-commit-hooks` v4.6+: `trailing-whitespace`, `end-of-file-fixer`, `check-yaml`, `check-added-large-files`.
  - `local` ESLint hook (auto-fix mode) — runs `cd web && pnpm exec eslint --fix` on changed `.ts|.tsx`.
  - `local` tsc hook — `cd web && pnpm exec tsc --noEmit` on any `.ts|.tsx` change (no `--incremental` arg — pre-commit caches better than tsc here for the POC scale).
  - `local` Prettier hook — `cd web && pnpm exec prettier --write` on changed files in `web/`.
- **Files**: `.pre-commit-config.yaml`, `README.md` (add a one-line setup note: `pre-commit install`).
- **Logging**: n/a.
- **Verification**: run `pre-commit install` then `pre-commit run --all-files` — exits 0 on a clean checkout (current repo state).
- **blockedBy**: A1 + A4.

#### Task A6 — `.github/workflows/ci.yml`

- **Deliverable**: GitHub Actions workflow triggered on `push` to any branch + `pull_request` to `main`:
  - Job `lint-typecheck-unit`: ubuntu-latest, Node 24, pnpm 11. Steps: checkout, setup-node, setup-pnpm, `cd web && pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`.
  - Job `integration` is gated by `if: contains(github.event.pull_request.labels.*.name, 'integration')` (don't run testcontainers on every PR — too slow on free-tier GH runners; the dev runs locally before pushing). Out of POC mandatory scope per `CLAUDE.md` "out of POC: GitHub Actions CI/CD" — but having the stub is fine, just don't make integration mandatory.
- **Files**: `.github/workflows/ci.yml`.
- **Logging**: n/a (CI logs are structured by GH Actions).
- **Verification**: `actionlint .github/workflows/ci.yml` reports 0 errors (run locally; install via `brew install actionlint` or `go install github.com/rhysd/actionlint/cmd/actionlint@latest`).
- **blockedBy**: A4.

#### Group A commit checkpoint

After A1-A6 complete + verified:

```
git commit -m "chore: M0.T — test infra (vitest, playwright, CI scaffold, pre-commit, pnpm scripts)"
```

### Group B — M2 core libs: errors + atomic (independent of DB)

#### Task B1 — `web/lib/errors.ts` (MaisterError + taxonomy)

- **Deliverable**: file establishing the typed error taxonomy.
  ```ts
  // web/lib/errors.ts
  import 'server-only';

  export type MaisterErrorCode =
    | 'PRECONDITION'
    | 'SPAWN'
    | 'NEEDS_INPUT'
    | 'HITL_TIMEOUT'
    | 'CRASH'
    | 'CONFLICT'
    | 'CONFIG'
    | 'EXECUTOR_UNAVAILABLE'
    | 'FLOW_INSTALL'
    | 'ACP_PROTOCOL'
    | 'CHECKPOINT';

  export class MaisterError extends Error {
    readonly code: MaisterErrorCode;

    constructor(code: MaisterErrorCode, message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'MaisterError';
      this.code = code;
      Object.setPrototypeOf(this, MaisterError.prototype); // ES5 class inheritance fix
    }
  }

  export function isMaisterError(err: unknown): err is MaisterError {
    return err instanceof MaisterError;
  }
  ```
- **Files**: `web/lib/errors.ts`, `web/lib/__tests__/errors.test.ts`.
- **Logging**: not applicable here — errors are the substrate that other modules log against.
- **Tests** (`errors.test.ts`):
  - `new MaisterError('CONFIG', 'msg')` sets `name`, `code`, `message` correctly.
  - `instanceof MaisterError` works across (a) direct construction, (b) thrown + caught, (c) Promise-rejected + awaited.
  - `isMaisterError` returns `true` for `MaisterError` instances and `false` for `Error`, `null`, `undefined`, `{ code: 'CONFIG' }` plain object.
  - All 11 codes type-check (compile-time assertion via `satisfies` — a const array `CODES satisfies readonly MaisterErrorCode[]` covering all of them).
- **Verification**: `pnpm test:unit web/lib/__tests__/errors.test.ts` → all assertions pass.
- **Logging requirement**: not applicable — this module is logged-against, not logging.
- **blockedBy**: A1.

#### Task B2 — `web/lib/atomic.ts` + tests

- **Deliverable**: atomic JSON writer used by every artifact under `.maister/`.
  ```ts
  // web/lib/atomic.ts
  import 'server-only';
  import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
  import { dirname } from 'node:path';
  import { randomUUID } from 'node:crypto';
  import pino from 'pino';

  const log = pino({ name: 'atomic' });

  export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${randomUUID()}.tmp`;
    log.debug({ path, tmpPath }, 'atomicWriteJson start');
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8' });
      await rename(tmpPath, path);
      log.debug({ path }, 'atomicWriteJson done');
    } catch (err) {
      log.error({ err, path }, 'atomicWriteJson failed; attempting tmp cleanup');
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
  ```
- **Files**: `web/lib/atomic.ts`, `web/lib/__tests__/atomic.test.ts`.
- **Logging**: per implementation — `log.debug` on start + done, `log.error` on failure + cleanup attempt.
- **Tests** (`atomic.test.ts`, unit-level; uses `os.tmpdir()` to scope writes):
  - Writing to `tmpdir/sub/sub2/file.json` creates the parent dirs.
  - Writing the same path 100× in parallel via `Promise.all` produces a final file with valid JSON content matching one of the inputs (no torn writes). Use a sentinel reader running in `setInterval` while writes are in flight — it must never observe a malformed parse.
  - Write failure cleans up the tmp file (force-fail by giving `data` a circular structure → `JSON.stringify` throws → assert tmp file is gone after the catch).
  - Final file has 0o644 permissions (or whatever Node default is — assert exact value to lock in).
- **Verification**: `pnpm test:unit web/lib/__tests__/atomic.test.ts` → all assertions pass.
- **Logging requirement check**: ✅ debug on entry + exit, error on failure.
- **blockedBy**: A1.

#### Group B commit checkpoint

After B1 + B2 complete + verified:

```
git commit -m "feat(lib): M2 — MaisterError taxonomy + atomicWriteJson"
```

### Group C — M1: Drizzle schema, client, migrations, Postgres

#### Task C1 — `web/lib/db/schema.ts` (all 7 tables)

- **Deliverable**: full Drizzle schema covering the 7 tables defined in `web/CLAUDE.md`. Use `pg-core` from `drizzle-orm`. Use `text` for string IDs (cuid2 / nanoid — generate via app code), `timestamp` with `{ withTimezone: true, mode: 'date' }`, `jsonb` for `env`, `manifest`, `schema (form_schema)`, `response`. Index `runs(project_id, status)`, `tasks(project_id, status)`, `hitl_requests(run_id)`.

  Concrete shape (full, NOT a sketch):
  ```ts
  // web/lib/db/schema.ts
  import 'server-only';
  import { pgTable, text, timestamp, jsonb, integer, unique, index } from 'drizzle-orm/pg-core';

  export const projects = pgTable('projects', {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    repoPath: text('repo_path').notNull().unique(),
    mainBranch: text('main_branch').notNull().default('main'),
    branchPrefix: text('branch_prefix').notNull().default('maister/'),
    maisterYamlPath: text('maister_yaml_path').notNull(),
    defaultExecutorId: text('default_executor_id'), // FK validated in app, deferred to avoid circular
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  });

  export const executors = pgTable(
    'executors',
    {
      id: text('id').primaryKey(),
      projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
      // Executor ID as referenced in maister.yaml (e.g. 'claude-sonnet') — unique within the project.
      executorRefId: text('executor_ref_id').notNull(),
      agent: text('agent', { enum: ['claude', 'codex'] }).notNull(),
      model: text('model').notNull(),
      env: jsonb('env').$type<Record<string, string> | null>(),
      router: text('router', { enum: ['ccr'] }), // nullable
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    (t) => ({
      uniqExecutorRefPerProject: unique('executors_project_ref_uq').on(t.projectId, t.executorRefId),
    }),
  );

  export const flows = pgTable(
    'flows',
    {
      id: text('id').primaryKey(),
      projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
      // Flow ID as referenced in maister.yaml (e.g. 'bugfix') — unique within the project.
      flowRefId: text('flow_ref_id').notNull(),
      source: text('source').notNull(),
      version: text('version').notNull(),
      installedPath: text('installed_path').notNull(),
      manifest: jsonb('manifest').notNull(),
      schemaVersion: integer('schema_version').notNull(),
      recommendedExecutorId: text('recommended_executor_id'), // nullable, FK to executors.id, deferred
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    (t) => ({
      uniqFlowRefPerProject: unique('flows_project_ref_uq').on(t.projectId, t.flowRefId),
    }),
  );

  export const tasks = pgTable(
    'tasks',
    {
      id: text('id').primaryKey(),
      projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
      title: text('title').notNull(),
      prompt: text('prompt').notNull(),
      flowId: text('flow_id').notNull().references(() => flows.id),
      executorOverrideId: text('executor_override_id').references(() => executors.id),
      status: text('status', { enum: ['Backlog', 'InFlight', 'Done', 'Abandoned'] }).notNull().default('Backlog'),
      attemptNumber: integer('attempt_number').notNull().default(1),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    (t) => ({
      uniqAttempt: unique('tasks_id_attempt_uq').on(t.id, t.attemptNumber),
      idxProjectStatus: index('tasks_project_status_idx').on(t.projectId, t.status),
    }),
  );

  export const runs = pgTable(
    'runs',
    {
      id: text('id').primaryKey(),
      taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
      projectId: text('project_id').notNull().references(() => projects.id),
      flowId: text('flow_id').notNull().references(() => flows.id),
      executorId: text('executor_id').notNull().references(() => executors.id),
      status: text('status', {
        enum: ['Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'Review', 'Crashed', 'Done', 'Abandoned', 'Failed'],
      })
        .notNull()
        .default('Pending'),
      acpSessionId: text('acp_session_id'),
      flowVersion: text('flow_version').notNull(),
      checkpointAt: timestamp('checkpoint_at', { withTimezone: true, mode: 'date' }),
      keepaliveUntil: timestamp('keepalive_until', { withTimezone: true, mode: 'date' }),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
      endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    },
    (t) => ({
      idxProjectStatus: index('runs_project_status_idx').on(t.projectId, t.status),
      idxTaskAttempt: index('runs_task_idx').on(t.taskId),
    }),
  );

  export const workspaces = pgTable('workspaces', {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id),
    branch: text('branch').notNull(),
    worktreePath: text('worktree_path').notNull().unique(),
    parentRepoPath: text('parent_repo_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  });

  export const hitlRequests = pgTable(
    'hitl_requests',
    {
      id: text('id').primaryKey(),
      runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
      stepId: text('step_id').notNull(),
      kind: text('kind', { enum: ['permission', 'form', 'human'] }).notNull(),
      schema: jsonb('schema'), // form_schema JSON, with required `schemaVersion` field at runtime
      prompt: text('prompt').notNull(),
      response: jsonb('response'),
      respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'date' }),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    (t) => ({
      idxRun: index('hitl_requests_run_idx').on(t.runId),
    }),
  );

  // Bi-directional FK for projects.defaultExecutorId / flows.recommendedExecutorId is enforced
  // at the application layer (lib/projects.ts in Phase 2). Drizzle does not natively support
  // deferred FKs without a manual migration; we accept the app-level check on POC.

  export type Project = typeof projects.$inferSelect;
  export type Executor = typeof executors.$inferSelect;
  export type Flow = typeof flows.$inferSelect;
  export type Task = typeof tasks.$inferSelect;
  export type Run = typeof runs.$inferSelect;
  export type Workspace = typeof workspaces.$inferSelect;
  export type HitlRequest = typeof hitlRequests.$inferSelect;
  ```

- **Files**: `web/lib/db/schema.ts`.
- **Logging**: not applicable — schema is declarative.
- **Verification**: `cd web && pnpm typecheck` passes; `pnpm db:generate` produces a non-empty SQL migration file under `web/lib/db/migrations/`.
- **blockedBy**: A1 + A4 (need `drizzle-kit` and the `db:generate` script).

#### Task C2 — `web/drizzle.config.ts`

- **Deliverable**: drizzle-kit config:
  ```ts
  import 'dotenv/config';
  import { defineConfig } from 'drizzle-kit';

  export default defineConfig({
    schema: './lib/db/schema.ts',
    out: './lib/db/migrations',
    dialect: 'postgresql',
    dbCredentials: {
      url: process.env.DB_URL ?? 'postgres://maister:maister@localhost:5432/maister',
    },
    verbose: true,
    strict: true,
  });
  ```
  Note: SQLite alt-dialect support is deferred to Task C3 — the migration files we generate are Postgres-specific. SQLite path uses the same Drizzle ORM API at runtime; only `drizzle-kit` is PG-only here. The `DB_URL=file:./dev.db` runtime path documented in `web/CLAUDE.md` works by switching the Drizzle client driver (Task C3), not the migrations (which always target PG on POC).
- **Files**: `web/drizzle.config.ts`.
- **Logging**: n/a.
- **Verification**: `cd web && pnpm db:generate` succeeds, produces SQL files under `lib/db/migrations/`.
- **blockedBy**: C1.

#### Task C3 — `web/lib/db/client.ts` (PG/SQLite dialect switch)

- **Deliverable**: Drizzle client factory that picks driver based on `DB_URL` env shape:
  - `DB_URL=postgres://...` → use `drizzle-orm/node-postgres` + `pg` Pool.
  - `DB_URL=file:./...` → use `drizzle-orm/better-sqlite3` + `better-sqlite3` (add `better-sqlite3` to deps in this task; small enough to bundle).
  - Throw `MaisterError({code: 'CONFIG'}, 'DB_URL must be postgres:// or file: …')` on unknown prefix.

  Note on Postgres pool sizing: default `max: 10` is fine for POC. Surface `MAISTER_DB_POOL_MAX` env override.

  ```ts
  // web/lib/db/client.ts
  import 'server-only';
  import { Pool } from 'pg';
  import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
  import Database from 'better-sqlite3';
  import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
  import pino from 'pino';
  import { MaisterError } from '@/lib/errors';
  import * as schema from './schema';

  const log = pino({ name: 'db' });

  function resolveDbUrl(): string {
    const url = process.env.DB_URL;
    if (!url) {
      throw new MaisterError('CONFIG', 'DB_URL env is required (postgres://... or file:./dev.db)');
    }
    return url;
  }

  function maskUrl(url: string): string {
    return url.replace(/(:\/\/[^:]+:)([^@]+)(@)/, '$1***$3');
  }

  function buildClient() {
    const url = resolveDbUrl();
    log.info({ url: maskUrl(url) }, 'db client init');

    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      const pool = new Pool({
        connectionString: url,
        max: Number(process.env.MAISTER_DB_POOL_MAX ?? 10),
      });
      return drizzlePg(pool, { schema });
    }
    if (url.startsWith('file:')) {
      const sqlitePath = url.replace(/^file:/, '');
      const sqlite = new Database(sqlitePath);
      return drizzleSqlite(sqlite, { schema });
    }
    throw new MaisterError('CONFIG', `Unsupported DB_URL prefix: ${maskUrl(url)} (expected postgres:// or file:)`);
  }

  export const db = buildClient();
  export { schema };
  ```

  Add `better-sqlite3` to `web/package.json` runtime deps in this task.
- **Files**: `web/lib/db/client.ts`, `web/package.json` (adds `better-sqlite3` + `@types/better-sqlite3` dev), `web/pnpm-lock.yaml`.
- **Logging**: per implementation — `log.info` on init with masked URL. NEVER log unmasked URL (would leak the password).
- **Tests** (`web/lib/db/__tests__/client.test.ts`):
  - `DB_URL=postgres://u:p@h/d` → returns a Drizzle client with PG dialect (`db.session` / runtime check via a benign `select 1` — needs container or skipped in unit suite). Move the actual query to the integration test C5.
  - `DB_URL=file::memory:` → returns a SQLite client; `db.execute(sql\`select 1\`)` returns `[{ '?column?': 1 }]` or equivalent.
  - `DB_URL=mysql://...` → throws `MaisterError({code: 'CONFIG'})`.
  - Missing `DB_URL` → throws `MaisterError({code: 'CONFIG'})`.
  - `maskUrl` test: `postgres://u:secret@h/d` → `postgres://u:***@h/d`.
- **Verification**: unit tests pass.
- **Logging requirement check**: ✅ INFO on init with masked URL; no plaintext secret in logs.
- **blockedBy**: C1, B1 (MaisterError).

#### Task C4 — `web/lib/db/migrate.ts` (migration runner script)

- **Deliverable**: script invoked by `pnpm db:migrate`:
  ```ts
  import 'dotenv/config';
  import { migrate } from 'drizzle-orm/node-postgres/migrator';
  import { Pool } from 'pg';
  import { drizzle } from 'drizzle-orm/node-postgres';
  import pino from 'pino';

  const log = pino({ name: 'db:migrate' });

  async function main() {
    const url = process.env.DB_URL;
    if (!url || !url.startsWith('postgres')) {
      log.error({ url }, 'DB_URL must point at Postgres for migration runs');
      process.exit(1);
    }
    log.info({ url: url.replace(/:[^:@]+@/, ':***@') }, 'running migrations');
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: './lib/db/migrations' });
    log.info('migrations done');
    await pool.end();
  }

  main().catch((err) => {
    log.error({ err }, 'migration failed');
    process.exit(1);
  });
  ```
  SQLite migrations are not auto-run on POC — SQLite path is dev-only, schema is pushed via `drizzle-kit push:sqlite` manually (document this in `web/lib/db/README.md`).
- **Files**: `web/lib/db/migrate.ts`, `web/lib/db/README.md`.
- **Logging**: per implementation.
- **Verification**: with `compose.yml` Postgres up (`docker compose up postgres -d`), `cd web && DB_URL=postgres://maister:maister@localhost:5432/maister pnpm db:migrate` runs to completion; `psql` shows all 7 tables present.
- **blockedBy**: C2.

#### Task C5 — `web/lib/db/__tests__/schema.integration.test.ts` (testcontainers PG)

- **Deliverable**: integration test asserting the schema round-trips:
  - Boot Postgres 16 via `@testcontainers/postgresql` (npm: `testcontainers`).
  - Apply migrations from `web/lib/db/migrations/`.
  - Insert one row in each of `projects`, `executors`, `flows`, `tasks`, `runs`, `workspaces`, `hitl_requests` with FK chain intact.
  - Assert UNIQUE constraints fire: duplicate `projects.slug` rejects; duplicate `(tasks.id, tasks.attempt_number)` rejects; duplicate `(executors.project_id, executors.executor_ref_id)` rejects.
  - Assert `onDelete: cascade` removes child rows when parent project is deleted.
- **Files**: `web/lib/db/__tests__/schema.integration.test.ts`.
- **Logging**: testcontainers writes its own logs to stderr; our test's own logs at DEBUG via `pino` when adverse paths are exercised.
- **Verification**: `cd web && pnpm test:integration` boots PG (slow first run — ~30s for container pull) and exits 0.
- **Logging requirement check**: ✅ adverse paths logged.
- **blockedBy**: C1, C2, C3, C4, B1.

#### Group C commit checkpoint

After C1-C5 complete + verified:

```
git commit -m "feat(db): M1 — Drizzle schema (7 tables) + PG/SQLite client + migrations + integration tests"
```

### Group D — M2 config v2 loader + `form_schema` versioning

#### Task D1 — `web/lib/config.schema.ts` (zod schemas for `maister.yaml` v2 + `flow.yaml`)

- **Deliverable**: zod schemas covering every documented field in `CLAUDE.md` §6 + the resolved `form_schema` versioning decision.

  Schemas required:
  - `maisterYamlV2Schema` — root: `{ schemaVersion: 2, project: {...}, executors: [...], default_executor: string, flows: [...] }`.
  - `executorSchema` — `{ id, agent: 'claude'|'codex', model, env?: Record<string,string>, router?: 'ccr' }`.
  - `flowEntrySchema` — `{ id, source, version, executor_override?: string }`.
  - `flowYamlV1Schema` — `{ schemaVersion: 1, name, recommended_executor?, setup?, steps: [...] }`.
  - `stepSchema` — discriminated union on `type`: `cli | agent | guard | human`. Each variant has its own required fields (e.g. `human` requires `form_schema`, `agent` requires `prompt` and `mode`, `cli` requires `command`, `guard` requires `cost?|time?|regex?`).
  - `formSchemaSchema` — `{ schemaVersion: number, fields: [...] }` — every Flow plugin's user-input form MUST declare its own `schemaVersion`. Runtime validators will compare this against the form schema at the time the agent step started; mismatch → `MaisterError({code: 'CONFIG'})` per the resolved decision (Master Plan §"Resolved Decisions"). Field types limited to `string | number | boolean | enum | array` on POC.
- **Files**: `web/lib/config.schema.ts`, `web/lib/__tests__/config.schema.test.ts`.
- **Logging**: not applicable — pure types.
- **Tests**: golden fixture passes; 10+ malformed fixtures each reject at the right field path. Discriminated-union exhaustiveness compile-checked.
- **Verification**: unit tests pass.
- **blockedBy**: A1 (need `zod` installed).

#### Task D2 — `web/lib/config.ts` (loader + cross-reference validation)

- **Deliverable**: functions:
  - `loadProjectConfig(maisterYamlPath: string)` — reads file, YAML-parses (use `yaml` npm package; add to deps), validates via `maisterYamlV2Schema`, runs cross-reference checks:
    - `default_executor` must exist in `executors[].id`.
    - Every `flows[].executor_override` must exist in `executors[].id`.
    - No duplicate executor IDs; no duplicate flow IDs.
  - `loadFlowManifest(flowYamlPath: string)` — reads, parses, validates via `flowYamlV1Schema`, cross-references:
    - No duplicate step IDs.
    - Every `goto_step` reference exists.
    - `recommended_executor` (if set) is a non-empty string (existence in project's executors[] is validated at project-load time, not here — the manifest can be loaded standalone).
  - `validateFormSchemaVersion(formSchema: unknown, expectedVersion: number)` — runtime check used by the HITL form runtime (Phase 4). Throws `MaisterError({code: 'CONFIG'}, 'form_schema version mismatch: expected X, got Y')` on mismatch.
  - All failure paths throw `MaisterError({code: 'CONFIG'})`.

  Add `yaml@^2.6` to `web/package.json` runtime deps in this task.
- **Files**: `web/lib/config.ts`, `web/lib/__tests__/config.test.ts`, `web/package.json` (adds `yaml`).
- **Logging**: every load logs at DEBUG with `path` + parsed-structure summary (executor count, flow count). Every validation error logs at WARN with the failing field path before throwing.
- **Tests**:
  - Golden `maister.yaml` v2 from `web/test-fixtures/maister.yaml.golden` loads cleanly. Include 1 executor with `router: ccr` and 1 with bare `env: {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN}`.
  - 8 malformed fixtures rejected with the right offending field path.
  - Cross-reference check: golden v2 with `default_executor: 'nonexistent'` rejects.
  - `loadFlowManifest` golden `flow.yaml` with all 4 step types loads.
  - `loadFlowManifest` with `goto_step: 'missing'` rejects.
  - `validateFormSchemaVersion({ schemaVersion: 2 }, 1)` throws CONFIG with both versions named in the message.
  - `validateFormSchemaVersion({ schemaVersion: 1 }, 1)` returns successfully.
- **Verification**: unit tests pass.
- **Logging requirement check**: ✅ DEBUG on load, WARN on adverse field.
- **blockedBy**: D1, B1.

#### Group D commit checkpoint

After D1 + D2 complete + verified:

```
git commit -m "feat(lib): M2 — config v2 loader + flow.yaml validator + form_schema versioning"
```

### Group E — Seed + cross-module integration test

#### Task E1 — `web/lib/db/seed.ts` (dev seed)

- **Deliverable**: idempotent dev seed. Inserts:
  - 1 project (`maister-dev`).
  - 2 executors (`claude-sonnet`, `codex-default`) with `default_executor = claude-sonnet`.
  - 1 flow (`bugfix` pointing at a fake `installed_path` — not exercised here; real install lands in Phase 1 Workstream B).
  - 0 tasks / runs (those land via the UI in Phase 3).
  - Skips inserts if the project slug already exists (idempotent — re-runnable).
- **Files**: `web/lib/db/seed.ts`.
- **Logging**: INFO per row inserted with the table + row ID. INFO if skip-because-exists.
- **Verification**: `cd web && pnpm db:seed` twice in a row — first inserts, second skips. `select * from projects` shows the one row.
- **Logging requirement check**: ✅ INFO per row.
- **blockedBy**: C5 (need the schema validated against real PG).

#### Task E2 — `web/lib/__tests__/foundation.integration.test.ts` (cross-module)

- **Deliverable**: one integration test exercising the full foundation surface end-to-end (proves Phase 1 workers can rely on it):
  - Boot Postgres via testcontainers.
  - Apply migrations.
  - `loadProjectConfig(fixture)` returns a parsed config.
  - Insert a project row + linked executors + linked flow via Drizzle.
  - `atomicWriteJson('.maister/test-slug/runs/r1/needs-input.json', { schemaVersion: 1, fields: [...] })` writes the file.
  - `validateFormSchemaVersion(readBack, 1)` succeeds; `validateFormSchemaVersion(readBack, 2)` throws `MaisterError({code: 'CONFIG'})`.
  - Cleanup tmp `.maister/test-slug/` after test.
- **Files**: `web/lib/__tests__/foundation.integration.test.ts`.
- **Logging**: testcontainers + module-level pino — adverse paths logged.
- **Verification**: `pnpm test:integration` includes this test and exits 0.
- **blockedBy**: B1, B2, C5, D2.

#### Group E commit checkpoint

After E1 + E2 complete + verified:

```
git commit -m "feat(foundation): M1+M2 — dev seed + cross-module integration test"
```

## Commit Plan (summary)

5 commits, 16 tasks. Each commit lands as one logical chunk; `/aif-implement` should pause for review at each checkpoint.

| # | Commit | Tasks | Tag (local) |
|---|---|---|---|
| 1 | `chore: M0.T — test infra (vitest, playwright, CI scaffold, pre-commit, pnpm scripts)` | A1, A2, A3, A4, A5, A6 | — |
| 2 | `feat(lib): M2 — MaisterError taxonomy + atomicWriteJson` | B1, B2 | — |
| 3 | `feat(db): M1 — Drizzle schema (7 tables) + PG/SQLite client + migrations + integration tests` | C1, C2, C3, C4, C5 | — |
| 4 | `feat(lib): M2 — config v2 loader + flow.yaml validator + form_schema versioning` | D1, D2 | — |
| 5 | `feat(foundation): M1+M2 — dev seed + cross-module integration test` | E1, E2 | `poc-phase-0-done` |

After commit 5: open PR from `feature/poc-foundation` to `main`, run `/aif-docs` for the schema + error taxonomy, run `/aif-review` for a sanity scan, then merge.

## Acceptance Criteria for the Whole Branch

All of the following must be true before opening the PR:

- `cd web && pnpm install --frozen-lockfile` ✅
- `cd web && pnpm lint` ✅
- `cd web && pnpm typecheck` ✅
- `cd web && pnpm test:unit` — all tests green ✅
- `cd web && pnpm test:integration` — testcontainers PG round-trip green ✅
- `docker compose up postgres -d && cd web && pnpm db:migrate && pnpm db:seed` — migrations + seed succeed against a fresh container ✅
- `pre-commit run --all-files` — clean on this branch's diff ✅
- Master plan ([`poc-implementation.md`](./poc-implementation.md)) checklist for Phase 0 fully checked off
- ROADMAP.md M1 + M2 boxes ticked
- `web/lib/db/README.md` documents the migration workflow + SQLite caveat
- `/aif-docs` run produces clean docs deltas

## Notes / Caveats

- **Master plan + dockerize files carry over**: this branch was created off `main` while `.ai-factory/plans/poc-implementation.md` and the dockerize artifacts (`compose*.yml`, `Dockerfile`, `.dockerignore`, `.env.example`) were uncommitted. They WILL be part of the PR. Acceptable — these are the coordination artifacts for the POC; they belong in the foundation PR. Don't try to commit them separately.
- **SQLite path is best-effort on POC**: migrations are Postgres-specific. SQLite is supported at runtime for ultra-light dev only — schema must be pushed via `drizzle-kit push:sqlite` manually. Documented in `web/lib/db/README.md`. If SQLite proves friction during Phase 1+, drop it.
- **`MAISTER_DB_POOL_MAX` env var**: documented, defaults to 10. Surface in `.env.example` even though it's optional.
- **No `lib/runner.ts`** — agent subprocess lifecycle lives in `supervisor/`. Don't be tempted to add one here.
- **No supervisor-client yet** — that's M3 / Phase 1 Workstream A.
- **No `lib/projects.ts` yet** — that's M9-partial / Phase 2 Workstream C.
- **Pre-commit gotcha**: `pre-commit install` writes a hook to `.git/hooks/pre-commit`. Document this in `README.md` under "Setup".

## Next Steps After This Branch Lands

1. Tag local commit `poc-phase-0-done`.
2. Update `ROADMAP.md` to mark M1 + M2 done.
3. Per the master plan, Phase 1 starts: 3 parallel branches off the new `main`:
   - `feature/m3-supervisor` (Workstream A)
   - `feature/m4-flow-plugin-loader` (Workstream B)
   - `feature/m6-executor-registry` (Workstream C)
4. Each branch invoked via its own `/aif-plan full` against the milestone.
