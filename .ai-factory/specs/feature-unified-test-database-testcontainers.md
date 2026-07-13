# Unified test-database mechanism

**Status:** Implemented

## Problem

Database-backed integration tests created their own `postgres:16-alpine`
containers, Brain maintained a second lifecycle, and E2E used an externally
managed, schema-reset database. That split allowed image/migration drift and
made Docker requirements implicit.

## Requirements

- **TDB-01:** A single typed helper owns Testcontainers startup, `pgvector`
  image selection, and safe structured lifecycle logs. Teardown attempts the
  pool before the container and still attempts container shutdown when pool
  shutdown fails.
- **TDB-02:** The helper exposes bare, main-schema, and main-plus-Brain
  lineages. Main migration order is always before Brain migration.
- **TDB-03:** Integration and E2E failures caused by unavailable Docker are
  typed and say `integration/e2e require Docker; build/unit do not`.
- **TDB-04:** No fixture imports Testcontainers or creates a Postgres container
  directly; historical migration replay tests use the bare lineage.
- **TDB-05:** `test:e2e` creates one disposable Testcontainers database,
  migrates main then Brain, seeds it, passes only its `DB_URL` to Playwright,
  and on `SIGINT` or `SIGTERM` observes the Playwright process-group exit
  before it tears the database down.
- **TDB-06:** No E2E path creates/drops a database or schema, and no fixed
  `E2E_DB_URL` contract remains.
- **TDB-07:** Unit/build CI has an unreachable `DOCKER_HOST`; Docker-backed
  integration remains a separately labelled job.

## Acceptance criteria

1. The shared helper is the only web import site for
   `@testcontainers/postgresql` and the only constructor site.
2. Bare/main/main+Brain integration checks prove their migration boundaries and
   requested pool size.
3. E2E wrapper tests prove preparation uses `NODE_ENV=test`, the app process
   does not inherit forced test mode, and SIGINT/SIGTERM observe the Playwright
   process-group exit before the disposable database is torn down.
4. Typecheck, strict lint, unit contracts, helper integration, and representative
   Brain integration pass.

## Non-goals

No production API contract, runtime database schema, deployment compose file,
or application analytics data model changes.

## Traceability

| Requirement | Evidence |
| --- | --- |
| TDB-01–03 | `web/test-support/pg-container.ts`, helper integration tests |
| TDB-04 | repository static sentinel and migrated integration fixtures |
| TDB-05–06 | `web/e2e/run.ts`, `prepare-db.ts`, wrapper unit contract |
| TDB-07 | `.github/workflows/ci.yml` Docker-free job environment |
