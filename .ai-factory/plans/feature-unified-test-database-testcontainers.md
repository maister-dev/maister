# Unified Testcontainers database plan

**Status:** Implemented

## Scope and contract surface

This change consolidates test-only PostgreSQL ownership. It introduces no
production API, SSE, runtime schema/migration, compose, deployment, or
`MaisterError` contract change; OpenAPI, AsyncAPI, database-schema, and
error-taxonomy updates are therefore not required.

| Requirement | Contract and acceptance evidence |
| --- | --- |
| TDB-01 | One typed helper owns pgvector selection and structured lifecycle logs; it attempts container teardown even if pool teardown fails. |
| TDB-02 | Bare, main, and main-plus-Brain lineages apply main before Brain migrations. |
| TDB-03 | Docker discovery emits the typed, password-safe test-harness error. |
| TDB-04 | Static ownership scan leaves no integration fixture importing or constructing Testcontainers. |
| TDB-05 | One E2E invocation owns bare DB → main/Brain migration → seed → Playwright → observed child exit → teardown, including SIGINT/SIGTERM. |
| TDB-06 | E2E has no fixed `E2E_DB_URL`, database/schema creation, or reset path. |
| TDB-07 | Unit/build CI has an unreachable Docker host; Docker integration remains labelled. |

## Phase 0 — SDD contract and analytics

- [x] Freeze [the specification](../specs/feature-unified-test-database-testcontainers.md), ADR-135, and the test-infrastructure state/process analytics.
- [x] Record the explicit non-goal decision above and index the new analytics domain.
- [x] Define interruption semantics: the wrapper captures SIGINT/SIGTERM, observes Playwright's process-group exit, and then tears down the database exactly once.

## Phase 1 — Shared helper (RED → GREEN → refactor)

- [x] RED: define helper integration assertions for bare migration absence, main migration ledger plus schema-aware query, Brain migration ledger, and requested pool size.
- [x] GREEN: add `web/test-support/pg-container.ts` with typed bare/main/Brain entry points and safe Docker failure reporting.
- [x] Refactor: compose the schema-aware `mainSchema` client with the legacy loose handle required by existing fixtures, without an `unknown` schema assertion.
- [x] Gate: `pnpm --filter maister-web exec vitest run --project integration test-support/__tests__/pg-container.integration.test.ts`.

## Phase 2 — Fixture migration

- [x] Replace every web integration fixture's direct container lifecycle with the smallest applicable helper lineage.
- [x] Keep historical migration replay on the bare lineage; preserve its explicit per-test database setup inside the disposable container.
- [x] Gate: repository scan reports 281 helper-backed integration suites and zero direct Testcontainers fixture imports/constructors.

## Phase 3 — E2E lifecycle (RED → GREEN → refactor)

- [x] RED: `e2e/__tests__/run.test.ts` proved the absent signal handler and child-before-database ordering failure on 2026-07-13.
- [x] GREEN: the wrapper owns the bare Testcontainer lifecycle, passes its `DB_URL` to E2E preparation, and E2E preparation runs main migration, Brain migration, and seed with `NODE_ENV=test`; only the `DB_URL` reaches Playwright while the app keeps its normal runtime mode.
- [x] GREEN: abort regressions prove SIGINT and SIGTERM stop the Playwright process group, observe its exit, then invoke database teardown once; pre-Playwright interruption and preparation failure do not spawn Playwright.
- [x] Refactor: the wrapper shares one AbortSignal from its CLI boundary through database preparation and child lifecycle; a SIGTERM-resistant real process group proves SIGKILL escalation and no web-server leak.
- [x] Gate: `pnpm --filter maister-web exec vitest run --project unit e2e/__tests__/run.test.ts e2e/__tests__/run-lifecycle.test.ts`.

## Phase 4 — CI and documentation

- [x] Configure the unit/build CI job with unreachable `DOCKER_HOST`; retain the labelled Testcontainers integration job.
- [x] Update operator guidance, web conventions, ADR-135, analytics, and the current E2E harness comment.
- [x] Gate: `CI=true pnpm validate:docs:all` and `git --no-pager diff --check`.

## Final verification matrix

| Check | Expected result |
| --- | --- |
| `pnpm --filter maister-web typecheck` | Strict TypeScript succeeds. |
| Focused unit tests | Environment, signal, process-group-exit ordering, preparation-failure, and escalation contracts pass. |
| Focused Docker integration | Bare/main/Brain boundaries and runtime Drizzle schema access pass. |
| Static scans | One Testcontainers constructor; no E2E DB/schema reset code. |
| Docs validation | Mermaid and ADR anchors pass. |
| Full E2E suite | The wrapper completes and releases its database/server. A 2026-07-11 pre-Testcontainers baseline was already red (34 failed, 103 passed); the current run is also red (36 failed, 104 passed) with UI locator/state failures and no database lifecycle failures. These failures are tracked outside this contract and must not be described as green. |
