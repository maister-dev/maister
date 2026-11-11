# Test model audit

Scope: repository at `f38053b3192a24738c8b0920852cfd229c56721f`, with the
working-tree changes described here. Local validation: macOS ARM64, initially Node
24.15.0, followed by Node 24.22.3/26.13.1 and the updated frozen lockfile. The target deployment budget is approximately
8 GiB on a shared 4-vCPU VPS; this host was not available for measurement.

## Inventory and cost model

Inventory covers all tracked test/spec files, package runners, Vitest and
Playwright projects, CI, pre-commit hooks, Docker build and TypeScript inputs.
Suspicious source-text, schema, i18n, retired-feature and browser tests received
targeted semantic review. This is not a claim that every assertion in the
roughly half-million-line suite has been mutation-tested.

| Layer | Original files | Current files | Main cost and purpose |
| --- | ---: | ---: | --- |
| Web unit/component | 888 | 872 | Module transforms and isolated workers; 8,979 current cases |
| Web integration | 657 | 656 | Real Postgres startup/migrations, service and process fixtures |
| Web browser | 95 | 95 | Next server, database seed, browser and authentication; separate default, A/B, Librarian and live lanes |
| Supervisor unit | 51 | 51 | Protocol/data transforms and bounded process fixtures |
| Supervisor integration | 39 | 39 | Real ACP subprocess/HTTP/lifecycle contracts |
| MCP unit + integration | 7 | 7 | Public tools, API and stdio behavior |
| Root script tests | 9 | 9 | Contract, runtime, cleanup, CI and documentation tooling |

`site` and `site-docs` have separate build/typecheck/documentation validation,
not additional Vitest/Playwright suites. Their checks are not required for a
web-only change. No byte-identical test files were found; the useful reductions
are semantic duplication, repeated discovery/work and retired assertions.

The largest structural costs are compiling all test/fixture code again during
Next builds, unbounded ordinary Vitest parallelism, duplicated integration lane
ownership, and starting a database/process stack for integration files. Existing
per-case database templates and invocation cleanup are valuable: replacing them
with one shared mutable database would create ordering dependencies.

## Coverage consolidation and deletion

Seventeen test files are absent from the current suite: sixteen unit files and
one integration file. Web unit discovery falls from 9,248 to 8,979 cases; much
of that reduction is consolidating identical assertions, not removing behavior.

| Removed family | Reason | Remaining behavioral owner |
| --- | --- | --- |
| `i18n-settings-keys`, `i18n-acp-runner-keys`, `i18n-tokens-keys`, `i18n-readiness-keys` | Repeated locale traversal/parity and per-key boilerplate | `web/lib/__tests__/i18n-parity.test.ts`: all 101 required message paths retained for both locales; one global parity check |
| `i18n-external-gate-keys` | Tombstone assertion for long-retired copy | Global locale parity and current UI/API scenarios |
| `desk-contract`, `relocation-contract`, `home-links`, `needs-you-retired`, `decision-surface-single-source` | Source substrings, import paths and file absence pin a historical implementation | Desk/navigation browser scenarios, decisions integration; Desk placeholder assertions retained in i18n parity |
| `schema.m14`, `schema-hook-trip`, both `schema-shape` files | ORM-property presence and self-authored type/data literals | Current schema integration, ACP-runner route/native-default tests, hook-trip/HITL integrations and full typecheck |
| `migration-0100-plan-review` unit test | SQL substring checks duplicate real execution | `migration-0100-plan-review.integration.test.ts` |
| `migrations.m17` | SQL-text checks describe inserts/backfills without executing them | Real schema/migrations, `services/__tests__/hitl.integration.test.ts` and migration-journal integrity |
| `migration-0090-experiments.integration` | Stops at a retired experiments schema intentionally dropped by 0120 | `evaluation-legacy-backfill`, `migration-0120-experiment-drop`, current evaluation schema tests |

Old migrations themselves remain intact. Legacy-data upgrade tests, runtime
filesystem-boundary guards, A/B command/recovery contracts, process-death tests,
kernel isolation and resource reapers remain. Their cost alone is not evidence
of redundancy.

The browser criticality scenario that compared only CSS class strings is absent;
the actual branch and criticality context assertions remain.
The browser theme/language family has two concrete persistence scenarios instead
of three overlapping tests; the theme test cannot silently pass when the toggle
is missing. The empty permanent review-refusal skip is gone: real refusal is
owned by graph integration. Desk verifies the render baseline on the actual
stream request without `waitForTimeout(4000)`; unchanged-baseline silence remains
owned by the component and stream API tests. The ordinary lane excludes live
Librarian cases, has zero retries and retains failed-run traces.

## Execution model

The current 656-file web integration inventory partitions into 46 A/B files,
8 Linux-inclusive isolation files, 1 preflight, 2 opt-in load files, and 599
ordinary files. `test:integration:remainder` discovers the ordinary files and
uses the existing ownership/report/cleanup runner. A root test checks the actual
inventory for complete, disjoint ownership, including newly added ordinary
files. CI's label-gated job uses the remainder; its mandatory A/B and isolation
jobs remain. The full `test:integration` command remains available.

Vitest's empty-selection success flags and redundant overlapping discovery globs
are absent. Empty selections now fail in web, supervisor and MCP. Two root
regression tests cover resource configuration and integration partitioning.

Shared-host commands and configuration have one canonical home:
[validation on a shared host](../../docs/system-analytics/test-infrastructure.md#validation-on-a-shared-host).
Both test and build worker controls are opt-in, independent and validated.
The build control limits Next page-data/prerender workers, not Turbopack threads.
Production builds check runtime code and generated routes using
`tsconfig.build.json`; full `typecheck` continues to include tests and tooling.

## Evidence and limits

With generated production route types present, separate non-incremental
`tsc --extendedDiagnostics` runs under the same 4 GiB heap setting report:

| TypeScript program | Reported memory | Total time |
| --- | ---: | ---: |
| Full `tsconfig.json`, including tests | 4,041,234 KiB | 37.78 s |
| `tsconfig.build.json`, production inputs | 2,426,563 KiB | 17.61 s |

This is approximately **40% less compiler-reported memory**. It is one local
measurement of the type-check phase, not process-tree RSS or a controlled
end-to-end build benchmark. Full test type checking remains a separate gate.

Passed locally:

- Web unit: **872 files / 8,979 cases**, two workers, about 118 seconds.
- Supervisor unit: **51 files / 518 cases**.
- MCP: **6 unit files / 378 cases**, **1 integration file / 12 cases**.
- Root runner/runtime/CI tests: **33 cases**; explicit empty selections fail
  in all three packages.
- Preserved DB owners: **5 files / 41 cases** with one worker and shuffled
  order, seed 9752: migration 0100, experiment-drop 0120, evaluation legacy
  backfill, graph review-refusal and decisions query.
- Consolidated i18n and attention component: **22 cases**, shuffled seed 9752.
- Browser: theme persistence, language persistence, Desk baseline and admin
  authentication setup; no retries. Invocation cleanup reports zero leaks.
- Web, supervisor and MCP typechecks; scoped ESLint/Prettier; documentation
  links/indexes/Mermaid/ADR validation and generated ERD check.
- Ordinary production build with type checking enabled and 4 GiB Node heap;
  another build with `MAISTER_BUILD_MAX_WORKERS=2` confirms exactly two page-data
  and prerender workers, versus fifteen with defaults on the local machine.

The first unit baseline ran inside a restricted sandbox: local socket/process
access failed and introduced timeouts. Its 231 seconds must not be compared
with the unrestricted 118-second run as a performance improvement. Count and
ownership reductions are reproducible; end-to-end VPS savings are unmeasured.
The first browser invocation correctly refused an occupied port; scoped free
test ports were used without touching the other server.

The subsequent [full regression validation](full-validation.md) records the broad
integration and browser runs under the constrained profile, their failures and
corrections. Live providers, opt-in load qualification, image builds and hosted CI
remain separate release owners; local passes do not replace their evidence.

## Remaining cost and scope boundaries

- The full integration model is still expensive. Use relevant behavior owners
  during a task and the partitioned broad checks at the integration/release
  boundary. Do not run full integration plus A/B/isolation again for one change.
- CI runs the heavy web A/B inventory once on Node 24.22.3, replacing the
  duplicate Node 24 minor-version run. Node 26.13.1 receives runtime/supervisor
  checks, web unit coverage, four real integration owners and the A/B browser
  lane. Platform isolation qualification remains separate. See the follow-up
  validation report for current runtime and dependency evidence.
- Pre-commit currently runs whole-package lint/typecheck/format commands.
  File-scoped formatting/linting is another possible reduction, but hook
  behavior and unrelated working-tree rewrites are outside this test cleanup.
- The rebased production build has zero filesystem-tracing warnings after
  runtime file access moved to validated absolute file URLs and development
  facade discovery was removed from production. No trace exclusions or warning
  filters were added. Other statically inferred directory assets remain in NFT
  manifests; this is not a standalone deployment-size qualification.
- The Docker image still copies the monorepo and development dependencies.
  Production dependency pruning is a separate packaging change requiring image
  smoke qualification; test cleanup does not claim to reduce image size.
- `maister.yaml` imports pinned external packages and has no checked-in validation
  command field. No live server, package Flow or agent environment was changed.
  Apply the documented environment prefixes to the commands the stand executes.
- An 8 GiB total cap cannot be promised by per-process heaps or worker counts.
  The host must account for concurrent MAIster jobs, container memory and native
  compiler processes. Local defaults remain fast when the opt-in variables are
  unset.
