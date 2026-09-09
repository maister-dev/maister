# Test database infrastructure

## Purpose

This domain defines ephemeral PostgreSQL ownership for database-backed tests
(Implemented). It isolates test data by process, makes Docker an explicit
integration/E2E dependency, and keeps build/unit lanes database-free.

## Domain entities

- **Test database helper** — owner of a Testcontainers lifecycle.
- **Bare lineage** — empty PostgreSQL + pgvector database for historical SQL
  replay.
- **Main lineage** — bare database with `lib/db/migrations` applied.
- **Brain lineage** — main lineage followed by `lib/db/brain-migrations`.
- **E2E wrapper** — creates one bare E2E database through the helper, invokes
  E2E preparation with its URL, then starts Playwright with that URL.
- **E2E preparation** — applies main and Brain migrations and seeds E2E
  fixtures through the test-environment command path.

## State machine

```mermaid
stateDiagram-v2
  [*] --> ProbeDocker
  ProbeDocker --> Failed: runtime unavailable
  ProbeDocker --> ContainerStarted: runtime ready
  ContainerStarted --> Stopping: bare completes or main migration fails
  ContainerStarted --> MainMigrated: main lineage
  MainMigrated --> Stopping: main completes or Brain migration fails
  MainMigrated --> BrainMigrated: Brain lineage
  BrainMigrated --> Stopping: Brain lineage completes or E2E seed fails
  BrainMigrated --> PreparedE2E: E2E seed
  PreparedE2E --> PlaywrightRunning: wrapper passes DB_URL
  PlaywrightRunning --> Stopping: exit or SIGINT/SIGTERM
  Stopping --> [*]: pool ends before container
  Failed --> [*]
```

## Process flows

```mermaid
sequenceDiagram
  participant Test
  participant Helper
  participant Docker
  participant Postgres
  Test->>Helper: startMainAndBrainPostgresTestDb()
  Helper->>Docker: runtime probe and start pgvector container
  Docker->>Postgres: expose disposable database
  Helper->>Postgres: main migrations
  Helper->>Postgres: Brain migrations
  Test->>Helper: stop()
  Helper->>Postgres: end Pool
  Helper->>Docker: stop container
```

The E2E wrapper owns its complete database lifecycle, including cancellation.

```mermaid
sequenceDiagram
  participant Wrapper as E2E wrapper
  participant Helper
  participant Preparation as E2E preparation
  participant Postgres
  participant Playwright
  Wrapper->>Helper: start bare pgvector database
  Wrapper->>Preparation: prepare E2E database with ephemeral DB_URL
  Preparation->>Postgres: apply main migrations
  Preparation->>Postgres: apply Brain migrations
  Preparation->>Postgres: seed E2E fixtures
  Wrapper->>Playwright: start with ephemeral DB_URL
  alt Playwright exits normally
    Playwright-->>Wrapper: exit observed
  else SIGINT or SIGTERM
    Wrapper->>Playwright: forward signal to the process group, then SIGKILL after grace if needed
    Playwright-->>Wrapper: process-group exit observed
  end
  Wrapper->>Helper: stop database
  Helper->>Helper: end Pool before stopping container
```

## A/B stabilization isolation and fault injection (Implemented core — S5.1/S5.2; fault barriers and the partition matrix remain Designed)

**As built.** `web/test-support/filesystem-ownership.ts` is the operation-scoped scanner: it parses every production source (`.ts/.tsx/.mts/.cts/.js/.mjs/.cjs` under `app`, `lib`, `components`, `scripts`, `i18n`, `config`, `types`, the top-level entrypoints and the shared `../runtime`), role-tags test sources instead of dropping them, resolves `node:fs`, `node:fs/promises`, `node:child_process` and `node:sqlite` bindings through import aliases, `require`/`createRequire`/dynamic-import forms, destructuring and `promisify`, records each callsite as `{source, enclosing function, callee, operation, literal command}`, reports value uses it cannot resolve to a call as `unresolved`, and closes "performs a filesystem effect" over each module's local calls to enumerate exported wrappers. The inventory (`web/lib/execution-host/__tests__/fixtures/runtime-data-boundary-inventory.ts`) classifies 537 callsites in 110 modules and 261 wrappers in 80 modules; wrappers flagged path-generic (`atomicWriteJson`, the config/package loaders, …) have every caller enumerated, and the guard (`runtime-data-boundary-inventory.test.ts`) fails on any unclassified callsite, stale entry, `supervisor-runtime` class, `watch` operation or unexplained unresolved use, and carries three mutation cases (a host-runtime read injected into an already classified mixed file, a new call of a path-generic wrapper, an fs-using `.tsx` page and script). RED evidence: the previous file-level guard, brought current with the tree, passed 4/4 with the same host read injected into an allow-listed file.

`web/test-support/process-isolation.ts` resolves the kernel isolation driver this host can enforce (macOS `sandbox-exec`, denial = `EPERM`; the Linux uid/mount-namespace driver is scheduled with S5.3 and an unsupported host fails loudly) and `web/test-support/real-web.ts` starts the production web (`next build` of the checked-out tree, `server.ts`, production `instrumentation.ts` boot) in its own process group under that driver, with a credentials sign-in over the production Auth.js endpoints. `web/test-support/__tests__/execution-ab-isolation.integration.test.ts` (4/4) is AT-16's core: disjoint private roots for web and supervisor with only the worktrees root shared; the web identity is denied the host's sentinel and its live `state.sqlite` while the harness and the host keep them; a scratch launch with an upload completes through HTTP/Postgres with the real host executing the prompt; the object reads back under the AB-12 policy with the transcript; a SIGKILLed web restarts through production initialization under the same isolation, serves the same history and bytes, and completes a further turn on the still-live host session. It runs alone (`node scripts/run-stage-ab-tests.mjs isolation`, serial slice) with `MAISTER_TEST_EVIDENCE_DIR` keeping build/web/supervisor logs outside the worktree.

**Still Designed.** Replace file-level allowlisting with entries keyed by source file + enclosing function + resolved filesystem/child-process callee + operation kind + ownership class + rationale. Scan `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs` production roots, including `web/app`, `web/lib`, components that can import server utilities, scripts, instrumentation and imported shared helpers. Enumerate aliases/wrappers and child-process filesystem effects. Use TypeScript AST where practical; unresolved dynamic calls require explicit classification. Tests and migration-only sources are separately identified, not silently excluded from the ownership model.

Classes: manager-owned DB/config/package/evaluation artifacts; supervisor runtime bytes/state; repository/worktree/Git operations retained for Stage C; temporary operator import only. Mixed files contain multiple entries. A new host-runtime read in an already approved file must fail the guard. This static test supplements a real denied-access environment; it cannot prove isolation by itself.

Use disjoint private roots under separate process identities or Linux mount namespaces. Shared repository/worktree access remains permitted; supervisor SQLite/log/object/adapter-private roots are absent or inaccessible to web. Merely choosing different path strings or chmod under the same root user is insufficient. Negative control: a web-process access attempt to a seeded known private sentinel returns EACCES/ENOENT; positive controls prove supervisor access and authorized HTTP object read still work. Test harness may manage both roots; production web may not.

Extend `web/test-support/real-supervisor.ts` and add one real web-process harness with isolated ports, DBs, process groups and persistent restart roots. Reuse `web/test-support/pg-container.ts` as the sole Postgres constructor; no shared development database/ports or broad process killing. A test-only network proxy can drop ACKs, block receipts/SSE, delay old responses and cut streams deterministically without changing production branches. Fake ACP is permitted for deterministic protocol effects; the supervisor, HTTP stack, SQLite, Postgres, projector and owner entrypoints must be real.

Fault synchronization uses explicit fixture barriers after host acceptance/before HTTP ACK, after canonical commit/before owner apply, after consumer claim/before failing apply, and after object seal/before catalog ACK. Tests release barriers or terminate the owned process group; elapsed sleeps never prove that a failure window was reached. Each invocation uses unique ports, database, private roots and an artifact directory outside the worktree.

## A/B stabilization test lanes

S0 first writes complete requirements, route/message schemas, owner/refusal/recovery-window tables, state machines, schema constraints and primary acceptance mapping in the canonical docs. Mark missing behavior Designed, preserving accepted guarantees. No production implementation begins with unresolved required owner arms, a contradictory budget or an undefined destructive recovery window.

For every behavior task: **RED** executes its named primary scenario against the defect and records the discriminating failure; **GREEN** makes the minimal correction; **REFACTOR** stays within changed ownership boundaries while all affected tests remain green. If RED already passes, produce concrete counterevidence and update the finding, or prove the guard with a focused local mutation that the test kills. Do not weaken safety assertions to match broken behavior. No future-increment intentionally failing tests are committed as active tests in an earlier deployable increment.

Test inventory and mutation intent:

| Lane | Owner / runner | Planned file or existing suite to extend | Primary responsibility |
| --- | --- | --- | --- |
| Host output/pressure | E; supervisor Vitest `integration` | Existing `supervisor/src/__tests__/{runtime-event-outbox,runtime-event-pressure,runtime-storage,runtime-file-budget,output-memory}.integration.test.ts`; fixtures under `supervisor/test/fixtures/` | AT-01/02 with real ACP child, SQLite restart, actual bounded pipe behavior. |
| Canonical worker | E; web Vitest `integration` + real PG | Existing `web/lib/execution-host/events/__tests__/ingest.integration.test.ts`; new `projection-worker.integration.test.ts` | AT-03/04 real scheduling/claim/apply, first cursor failure, two consumers/runs, restart without new event. |
| Command reducer/transport | C/Q; web Vitest `integration` + real supervisor/PG | Existing `web/lib/execution-host/__tests__/{command-recovery,deliverer,lifecycle-regression}.integration.test.ts` | AT-06/07/08/10/17. Replace V3 receipt-only failure and keep V7b as minimum-runtime regression. |
| Owner restart | C; web Vitest `integration` + real peer/PG | New `web/lib/execution-host/__tests__/prompt-owner-recovery.integration.test.ts`, split by domain only when setup/size requires; existing gate/consensus/agent/scratch/sync suites | AT-05 full variant matrix; run real owner entrypoints, not invented fixture-only dispatch functions. |
| Object reconciliation/retention | O; web Vitest `integration` + PG/real peer | `runtime-object-retention.integration.test.ts`, real-peer `runtime-object-lifecycle.integration.test.ts` and `runtime-object-declarations-migration.integration.test.ts` under `web/lib/execution-host/__tests__/` | AT-09/14, event order and more-than-page retention, reference/delete race. |
| Host object integrity | O; supervisor Vitest `integration` | Existing `supervisor/src/__tests__/runtime-objects.integration.test.ts` | AT-13/15 no-follow/inode/hash/range/actual body evidence and restart after seal/tombstone. |
| Historical upgrade | M; web Vitest `integration` + real PG/peer | Existing `web/scripts/__tests__/import-legacy-execution-data-plane.integration.test.ts`, `web/lib/db/__tests__/migration-0135-canonical-data-plane-cutover.integration.test.ts`; new forward migration suite | AT-11 CLI invocation/interrupt/readback, complete historical source preservation, unchanged guards and fresh/upgrade paths. |
| Boundary inventory | Q; web Vitest `unit` | Existing `web/lib/execution-host/__tests__/runtime-data-boundary-inventory.test.ts` and fixture | AT-16 supplementary pure source classification; prohibited added operation in an already allowed mixed file kills guard. |
| Isolated processes | Q; web Vitest `integration` | New `web/test-support/__tests__/execution-ab-isolation.integration.test.ts` plus real harness | AT-16 real permissions/namespaces and process death; uses ordinary production web initialization, worker and transport. |
| Browser outcomes | Q/O; dedicated Playwright real-supervisor config/project | New `web/e2e/execution-ab-lifecycle.spec.ts` and `execution-ab-content.spec.ts`; retain existing `execution-host-contract.spec.ts` as supporting fake-peer coverage | AT-12 and user-visible history/HITL/cancel/resume/completion with unsafe artifact MIME. |
| Pure invariants only | Owning maintainer; existing unit projects | Only canonical request/identity transformation, bounded framing, range/digest parsing, pure reducer tables where stable | No mock-only replica of a real integration scenario; minimum added unit coverage. |

Current `web/vitest.workspace.ts` discovers lib/app/scripts/test-support/e2e integration tests and has `passWithNoTests` scripts. Supervisor integration discovers `src/**/*.integration.test.ts`. Playwright default `AUTHED_SPEC` is an explicit regex; new names do not automatically join authenticated tests. S0/S5 must wire the new real project and prove discovery. `vitest list` and `playwright test --list` must show each promised file/case; an empty successful run fails acceptance.

Phase gates use the actual package scripts, as separate commands:

```bash
pnpm --filter maister-web typecheck
pnpm --filter @maister/supervisor typecheck
pnpm --filter maister-web exec eslint .
pnpm --filter @maister/supervisor exec eslint .
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter @maister/supervisor test:unit
pnpm --filter @maister/supervisor test:integration
pnpm validate:contracts
pnpm validate:docs
pnpm --filter maister-web db:erd --check
```

Run full unit/integration suites at each completed increment, on the selected supported runtime; scoped new tests first. Build the web/qualified image when runtime/startup/transport/deployment changes; run dedicated real-browser scenarios in S3/S5. Tests introduced under new families require a runner include/config change in that same increment. Use the supported minimum/runtime matrix for AT-17 and affected binary tests. Do not rerun all tests repeatedly without intervening changes or unresolved failures.

Baseline failures are tracked by exact test names/error signatures and environment, never count deltas. Fix A/B failures in scope. A genuinely unrelated harness failure needs a narrowly scoped quarantine with explicit reason and tracked follow-up, reviewed in the phase gate; never quarantine AT-01–17 or claim the original full suite is green while quarantined failures remain. Existing notes about dirty-resolution/recursive harness/E2E failures are historical hints, not current verified exclusions. Qualify tests on disposable roots/DBs and capture stdout/stderr/reports as verifier artifacts outside the code worktree; do not use structured result transport as report storage.

## Expectations

1. Unit/build tests MUST NOT require a reachable Docker runtime.
2. Integration/E2E checks MUST fail with `TestDatabaseDockerUnavailableError`
   and the documented Docker-boundary message when Docker is unavailable,
   including a Docker failure that occurs after the runtime probe.
3. Every helper-created database MUST be unique to its test process and
   disposed through pool-before-container teardown; container shutdown MUST
   still be attempted if pool shutdown fails.
4. Raw historical SQL replay MUST start from the bare lineage only.
5. Main migrations MUST precede Brain migrations in every applicable lineage.
6. E2E MUST pass only its ephemeral `DB_URL` to Playwright and MUST NEVER
   mutate a developer database or reset a schema.
7. On E2E interruption, Playwright's process-group exit MUST be observed before the wrapper
   tears down its database.

## Edge cases

- A Docker probe timeout produces `TestDatabaseDockerUnavailableError` without
  exposing a connection-string password.
- A container startup failure after a successful Docker probe still produces
  `TestDatabaseDockerUnavailableError` without exposing a connection-string
  password.
- Migration or E2E seed failure still attempts to stop the pool and container.
- The E2E child receives the ephemeral `DB_URL`; its Next server keeps its
  normal runtime `NODE_ENV`.
- `SIGINT` and `SIGTERM` abort the wrapper, terminate the detached Playwright
  process group with bounded SIGKILL escalation, then follow the same database
  teardown path.

## Linked artifacts

- [ADR-135](../decisions.md#adr-135-testcontainers-only-ephemeral-postgres-for-database-backed-tests)
- [`pg-container.ts`](../../web/test-support/pg-container.ts)
- [`run.ts`](../../web/e2e/run.ts)
- [`pg-container.integration.test.ts`](../../web/test-support/__tests__/pg-container.integration.test.ts)
- [`run.test.ts`](../../web/e2e/__tests__/run.test.ts)
- [feature specification](../../.ai-factory/specs/feature-unified-test-database-testcontainers.md)

The mandatory S1 CI lane runs `test:integration:ab` in both application packages on Node 24.15.0 and 24.19.0. Its explicit suite inventory is `scripts/run-stage-ab-tests.mjs`; missing files, empty discovery, failed or skipped cases fail the lane. The same runner owns the serial `isolation` slice (AT-16 core, above) and the AT-12 browser lane is `pnpm --filter maister-web test:e2e:execution-ab` (`playwright.execution-ab.config.ts`: a REAL supervisor started by `e2e/execution-ab-global-setup.ts` behind a `next dev` web server; `e2e/execution-ab-content.spec.ts`). That lane must run on an otherwise idle host — concurrent CPU load or file writes under `web/` livelocked the dev server's edge-instrumentation recompile at boot (observed before the 2026-09-08 instrumentation split: ~135k warning lines and a 180 s readiness timeout versus ~3k lines and readiness in ~15 s when idle). `web/instrumentation.ts` now reaches its Node-only body (`web/instrumentation-node.ts`) solely through the `NEXT_RUNTIME === "nodejs"` branch, so the Edge instrumentation entry no longer bundles the server graph and a dev boot plus page compile prints none of those warnings; the idle-host requirement has not been re-measured since. Neither lane is wired into CI yet (S5.3). A separate mandatory image job builds the pinned Dockerfile, exercises real binary HTTP and runs `web/scripts/smoke-production-image.ts` through the default image ENTRYPOINT/CMD with a migrated PostgreSQL container. It verifies HTTP readiness, SIGTERM completion and no remaining web PostgreSQL sessions. The broader owner, import and browser/isolation lanes remain part of later stabilization increments.
