# Implementation Plan: Per-Navigation Tax & Hot-Path Indexes (Perf Findings #1, #2, #6, #8a)

Branch: optimize_diagnostics_i18n (existing worktree branch; no new branch created)
Created: 2026-11-25
Refined: 2026-11-25 (`/aif-improve`: spec-driven (SDD) Phase 0, RED→GREEN→REFACTOR tasks, requirement→test traceability)

## Settings
- Testing: yes. Development is test-first (TDD): each code task runs RED → GREEN → REFACTOR.
- Logging: verbose (DEBUG)
- Docs: yes. There is a mandatory docs checkpoint at completion (route through `/aif-docs`).

## Roadmap Linkage
Milestone: "none"
Rationale: "Skipped by user"

## Method (applies to every task)

**SDD.** Phase 0 produces the complete specs: ADRs, API contracts, system analytics, DB schema docs and requirement IDs. It produces them before any code. Code tasks implement only what a requirement ID states. If an implementation discovers a spec gap, update the spec first and the code second, in the same task.

**TDD.** Every code task runs these three steps:
1. **RED.** Write the tests named in the task. Run them and confirm that each one fails *for the stated reason*. A test that passes before implementation is either trivial or misplaced; delete or move it.
2. **GREEN.** Write the minimum production code that makes the tests pass. Production code must not anticipate later tasks.
3. **REFACTOR.** Apply the task's named SOLID/KISS/DRY constraints while the tests stay green. The refactor adds no new behavior.

**Test economy.** Each requirement ID is asserted at exactly one level: unit (pure policy), integration (wiring and real Postgres/SQLite/supervisor), or E2E (browser). Integration tests prove wiring and never repeat policy permutations that unit tests already cover. These kinds of test are banned: constant echoes, type-only assertions, snapshots of whole objects, and "renders without crashing".

**Gates.** Each phase exits only when every suite it touches is green:
- `pnpm -C supervisor lint typecheck test:unit test:integration`
- `pnpm -C web lint typecheck test:unit test:integration`
- `pnpm validate:docs`

Every new test file is confirmed with `vitest list --project <unit|integration>` (or `playwright test --list`) in the same task. Pre-existing red tests surfaced by a phase get an explicit quarantine entry with a reason and a follow-up, never silent tolerance.

## Validation Summary (findings vs. code at HEAD)

| # | Claim | Verdict | Correction carried into this plan |
|---|-------|---------|-----------------------------------|
| 1 | `AppLayout` blocks on `getPlatformDiagnostics()`. Supervisor `GET /diagnostics` re-reads the smoke cache, walks PATH and spawns `gemini/opencode/mimo --version` on every call, with no TTL and no singleflight | **VALID.** `web/app/(app)/layout.tsx:80-98` awaits it before `<main>`. `(app)/loading.tsx` renders *inside* the layout. `supervisor/src/http-api.ts:2444-2462` computes per request. `web/lib/execution-host/platform-status.ts:14` is only a per-request `React.cache` | Callers have different freshness needs. `/settings` reconcile is the *single writer* of runner readiness and is specified on live diagnostics (`docs/system-analytics/acp-runners.md` §Default-runner reconcile). Launch evidence must describe the host at launch. So freshness is an explicit `refresh` opt-in, not a blanket TTL |
| 2 | A bare `<NextIntlClientProvider>` ships the whole catalog in every document and on every `router.refresh()` | **VALID.** `web/app/layout.tsx:47-49` passes no props. `web/i18n/request.ts:42` returns `messagesByLocale[locale]`; next-intl 4.14.9 inherits `getMessages()` when `messages` is omitted. On the wire this is the minified catalog: **en 310 KB / ru 486 KB**, 83 namespaces | The proposed root list (`nav, librarian, feedback, common`) is wrong. The shell's client components need `librarian`, `workStage`, `run.runStatus`, `contextUsage`, `transcriptUser`, `scratch`, `workbenchGit`, `workbenchLifecycle`, `portfolio` and `errorBoundary`. A nested `messages` set **replaces** its parent rather than merging with it. A missing message does not throw: it renders `ns.key` silently. So an enforcing scanner is mandatory. **Owner decision (2026-11-25): root-only pruning now; per-route providers are Phase 2, pending the UI regrouping** |
| 6 | Hot-path indexes are missing | **VALID with corrections** (D6) | The `workspaces` tie-break is `id ASC`. The worker statuses are `Running, NeedsInput, NeedsInputIdle, WaitingOnChildren`. The `/runs` ordering index must be non-partial. The webhook prune also needs the `event_id` index for its cascade |
| 8a | The `getDecisionsQueue` `React.cache` key is broken by the `scope = {}` default. `getSessionUser` and the visible-project lookups have no memoization | **VALID.** Layout `getDecisionsCount(id, role)` → `getDecisionsQueue(id, role, {})`, while desk and inbox call `getDecisionsQueue(id, role)`. The queue is therefore computed twice, and the two results can disagree, which violates `ATN-05` | The proposed normalization collapses `companyIds: []` into "no narrowing". That would widen `/api/v1/ext/decisions` (which sends `{ companyIds: [] }`) to every company (`decisions.ts:255-263`) |

## Decisions

### D1: Supervisor diagnostics snapshot (Finding #1, ADR-224, spec `host-diagnostics.md`)

**Module and shape**
- New `supervisor/src/diagnostics-cache.ts`: `createDiagnosticsCache<T>({ ttlMs, staleWhileRevalidateMs, now, compute, sourceVersion, logger })` returning `get({ force }): Promise<T>`. `compute` returns `{ startedAt, value }`. `sourceVersion()` returns the smoke-cache `mtimeMs | null`. The module has a single responsibility (policy) and no knowledge of adapters (DIP: Dependency Inversion). The probe logic moves unchanged into `computeSupervisorDiagnostics(runtimeRoot, logger)`.

**Age and staleness**
- Snapshot age = `now − startedAt`, where `checkedAt = startedAt`.
- A snapshot is fresh when its age is below `ttlMs = 30_000`.
- A snapshot is stale-servable when its age is below `staleWhileRevalidateMs = 300_000`.

**Read rules**
- **Non-forced:**
  - fresh → return the snapshot;
  - stale-servable → return the snapshot and start one background compute;
  - otherwise → join or start a compute and await it.
- **Forced** (`refresh=1|true`): join an in-flight compute only if it started at or after the request arrived; otherwise start a new one.
- **Ordering:** results are stored only when their generation is newer than the stored one.
- **Invalidation:** a `sourceVersion` change counts as no snapshot.
- **Failures:** a failure is never stored and is propagated to all joined waiters. A background failure is logged and never thrown.

**Contract, posture and deployment**
- **Wire:** the response shape is unchanged. `checkedAt` now means "probe start time of this snapshot". An invalid `refresh` returns 409 `PRECONDITION` (supervisor `httpStatusForCode`), `details.reason: "diagnostics_query_invalid"`, using the existing `/health?includeStream` pattern (`http-api.ts:306-315`).
- **Identifiers:** `refresh` is a query flag that carries no resource locator. The route reads no body fields and stays unauthenticated (ADR-166 posture unchanged).
- **Lifetime:** the snapshot is in-memory per process; a supervisor restart starts empty.
- **Deployment:** no env var, config file, sidecar, port or mount is added. The TTL values are constants plus `RegisterRoutesOptions` overrides for tests.

**Web freshness classes**

| Class | Call sites |
|---|---|
| **snapshot** | `getPlatformDiagnostics` (chrome layout), `web/lib/mcp/readiness-host.ts` |
| **fresh** (`{ refresh: true }`) | `/settings` reconcile via new `getFreshPlatformDiagnostics` (`web/app/(app)/settings/page.tsx:44`), `web/app/api/admin/acp-runners/route.ts:259`, `web/app/api/admin/acp-runners/[runnerId]/route.ts:183`, `web/lib/flows/enforcement-evidence.ts:65`, `web/lib/flows/graph/runner-graph.ts:3912`, `web/lib/agents/runner-readonly-evidence.ts:36` |

**Accepted residuals (recorded in ADR-224)**
- The rail indicator may lag a host change by up to the TTL, or by up to the SWR window on the first request after an idle period.
- On `/settings`, the rail (snapshot) and the page (fresh) may briefly differ.
- The seven-day smoke freshness boundary shifts by at most the snapshot age.

### D2: Root client-message pruning (Finding #2, ADR-225, spec `client-messages.md`)

**Owner decision (2026-11-25).** Optimize the root provider only. Per-route providers (about 18 owners) are deferred to Phase 2. The tabbed UI is being regrouped into sections, so route-level owners would churn.

**Modules**
- `web/i18n/client-namespaces.ts`: `CLIENT_NAMESPACES: readonly MessagePath[]` is the **minimal covering set** of message paths used by client-reachable code. A path is the literal namespace a client `useTranslations("…")` passes, so it uses dotted subkeys (`run.runStatus`, `run.terminalCause.reasons`, `inbox.reviews`, …) whenever no client code asks for the parent namespace.
- `web/i18n/pick-messages.ts` (server-only): `pickMessages(messages, paths)` copies by reference and builds nested objects for dotted paths. An unknown path throws outside production; in production it is omitted with a WARN.
- Root `web/app/layout.tsx`: `<NextIntlClientProvider messages={pickMessages(await getMessages(), CLIENT_NAMESPACES)}>`. No other production file renders `NextIntlClientProvider`.

**Enforcement**
- `web/test-support/client-namespace-scanner.ts` is a pure function: `scanClientNamespaces(fileMap) → { literals, violations }`.
- It builds the client graph:
  - it resolves `@/` aliases, relative imports and `import()`/`next/dynamic`;
  - it skips `import type`;
  - it starts from `"use client"` files and stops at `"use server"` files.
- It collects every reachable `useTranslations` literal and reports these violations:
  - root or non-literal `useTranslations`;
  - client `useMessages`;
  - a stray `NextIntlClientProvider`.
- The repo test asserts that `CLIENT_NAMESPACES` **equals** `minimalCover(literals)`, sorted. `minimalCover` keeps the literals and drops any literal nested under another literal.
- So the list is complete (no `MISSING_MESSAGE`) and minimal (no dead weight), and it stays that way: adding or removing a client `useTranslations` fails the test until the list is updated. The failure message prints the expected list.
- Splitting the pure engine from the repo walker (SRP) lets fixtures prove detection.

**Expected effect (honest bound)**
- Choosing paths at namespace granularity saves at least about 16%: about 260 KB en / 410 KB ru, against 310 KB / 486 KB minified today, per document and per `router.refresh()`.
- Dotted subkeys raise the saving wherever the client uses only part of a large namespace.
- The measured figure is recorded in the ADR-225 Validation section.
- The large win needs the Phase 2 per-route scoping. The same scanner engine extends to per-owner coverage, and `CLIENT_NAMESPACES` becomes the root owner's set.

### D3: Request memoization (Finding #8a + memo, spec: `attention.md` ATN-05 amendment and `identity-access.md` §Per-render memoization)

**Decisions queue (`web/lib/queries/decisions.ts`)**
- Pure `decisionsCacheKey(scope?)` returns `[projectId: string, companyKey: string]`:
  - `projectId` is `""` when absent;
  - `companyKey` is `"*"` when `companyIds === undefined`, otherwise `JSON.stringify(sorted unique ids)`, so `[]` becomes `"[]"`.
- An internal `cache((userId, role, projectId, companyKey) => computeDecisionsQueue(userId, role, decodeScope(...)))` does the work. `decodeScope` must round-trip `decisionsCacheKey` exactly.
- An explicit `client` argument bypasses the cache.
- `getDecisionsCount` delegates through the same public wrapper. That gives one key builder (DRY).

**Session user (`web/lib/authz.ts` + `web/auth.ts`)**
- `export const loadUserCached = cache(loadUser)`.
- `getSessionUser = cache(async () => …)` uses `loadUserCached`.
- The `jwt` callback re-reads through `loadUserCached`, so the row is read once per render. Its null-on-missing invalidation is unchanged.
- Outside an RSC render, `cache` passes through, so route handlers and server actions stay DB-authoritative on every call.

**Visible projects (`web/lib/queries/visible-projects.ts`)**
- `getVisibleProjects` and `getActionableProjectIds` are cached only on the default-client path.
- The wrappers return a fresh array on each call, so a caller mutating the result cannot poison the render cache.

### D4: Migration numbering and lock posture (Finding #6)

**Owner decision (2026-11-25).** No large installation needs a non-blocking rollout, so use the simplest approach.

**Migration 0410**
- One migration, **0410 `hot_path_indexes`**, generated by `drizzle-kit generate` from `schema.ts`.
- It is left **unedited**: plain `CREATE INDEX` statements, following the precedent of `0335_company_pending_pool_index.sql`. There is no `IF NOT EXISTS`, no guard and no `CONCURRENTLY` runbook.

**Constraints**
- It runs inside the migrator's single transaction under the maintenance fence (`lock_timeout 5s`, `statement_timeout 120s`). The SHARE locks are brief at current data volumes.
- A concurrent rollout for large installs is a one-line `(Phase 2)` note in `docs/database-schema.md`, not engineered now.
- The indexes are purely additive: no data rewrite, no backfill.
- `schema.ts` is the fourth leg of the migration contract. `pnpm -C web db:generate` must report "No schema changes" afterwards.

**Number reservation**
- Re-verify at implementation time that 0410 / ADR-224 / ADR-225 are free at `master` HEAD, using `git show master:docs/decisions.md` and `git show master:web/lib/db/migrations/meta/_journal.json`.
- Budget a renumber pass after rebasing, including prose greps for the numbers.

### D5: Supervisor SQLite v23

- `HOST_STATE_SCHEMA_VERSION` goes 22 → 23.
- `CREATE INDEX IF NOT EXISTS session_process_run_idx ON session_process_obligations(run_id, registered_at, command_id)` is added in two places:
  - in `SESSION_PROCESS_SCHEMA`, for fresh stores;
  - in an `if (user_version < 23)` `BEGIN IMMEDIATE; …; PRAGMA user_version = 23; COMMIT;` step (precedent: `MIGRATE_V14_TO_V15`).

### D6: Final Postgres index set (requirement IDs IDX-01..IDX-11)

| ID | Index | Definition | Reader that must use it |
|----|-------|------------|-------------------------|
| IDX-01 | `workspaces_run_created_idx` | `workspaces (run_id, created_at DESC, id ASC)` | `latestWorkspaceLateralSql` (`web/lib/runs/outcome-bucket.ts:93-103`) via `listRunsPage`; `getRunDetail` join (`run.ts:642-645`) |
| IDX-02 | `runs_project_started_idx` | `runs (project_id, started_at DESC, id DESC)` | `getObservatoryOverview` run groups/breakdown (`observatory-overview.ts:363-375,465-478`) |
| IDX-03 | `runs_started_id_idx` | `runs (started_at DESC, id DESC)` | `listRunsPage` ordering (`runs-list.ts:366-392`) |
| IDX-04 | `runs_continuation_active_idx` | `runs (run_kind, id) WHERE status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren')` | flow (`web/lib/flows/graph/continuation-worker.ts:103-347`) and agent (`web/lib/agents/continuation-worker.ts:149-394`) candidate selection |
| IDX-05 | `runs_host_restart_recovery_idx` | `runs (id) WHERE status='Crashed' AND run_kind='flow' AND parent_run_id IS NULL AND agent_kind IS NULL` | `findHostRestartRecovery` (`web/lib/runs/host-restart-recovery.ts:35-72`) |
| IDX-06 | `domain_events_project_occurred_idx` | `domain_events (project_id, occurred_at DESC, id DESC) WHERE project_id IS NOT NULL` | activity feed (`activity-feed.ts:229-266`), `getBudgetSummary` (`observatory.ts:664-705`), attention stream (`api/attention/stream/route.ts:252-255`) |
| IDX-07 | `webhook_deliveries_event_idx` | `webhook_deliveries (event_id)` | `runPrunePass` NOT EXISTS + cascade (`webhook-delivery.ts:197-209`) |
| IDX-08 | `webhook_deliveries_settled_updated_idx` | `webhook_deliveries (updated_at DESC, id DESC) WHERE status IN ('delivered','dead')` | attention stream (`route.ts:266-270`), activity feed deliveries (`activity-feed.ts:268-307`) |
| IDX-09 | `webhook_events_fanout_prune_idx` | `webhook_events (fanout_at) WHERE fanout_at IS NOT NULL` | `runPrunePass` |
| IDX-10 | `librarian_messages_segment_seq_idx` | `librarian_messages (segment_id, seq)` | `retrieveLibrarianContext` (`retrieval.ts:62-80`) |
| IDX-11 | `librarian_turns_segment_knowledge_idx` | `librarian_turns (segment_id) WHERE knowledge_access IS NOT NULL` | `retrieveLibrarianContext` (`retrieval.ts:257-266`) |

If the IDX-04 predicate cannot be proven from the workers' OR arms, use non-partial `(run_kind, status, id)` instead. Record the switch in the spec first; never ship an unusable index.

## Requirements Catalogue (spec owner → requirement IDs)

| Spec file (owner) | IDs | Summary |
|---|---|---|
| `docs/system-analytics/host-diagnostics.md` (new) | DIAG-01…DIAG-12 | Snapshot policy (fresh hit, singleflight, SWR, cold await, forced, generation ordering, source invalidation, failure non-caching, `checkedAt`, query validation, caller freshness classes, in-memory lifetime) |
| `docs/system-analytics/client-messages.md` (new) | CMSG-01…CMSG-08 | Root supplies the picked set; list equals the minimal cover of client literals; forbidden hooks; catalog existence; single provider; picker semantics; unknown-path policy; no `MISSING_MESSAGE` at runtime |
| `docs/system-analytics/attention.md` | ATN-05 (amended), EDGE-ATN-09 (new; next free number re-checked at implementation) | One computation per render; `companyIds: []` stays project-only |
| `docs/system-analytics/identity-access.md` §Per-render memoization (new topical section) | MEMO-01…MEMO-05 | Equivalent scopes share one computation; `[]` ≠ `undefined` company scope; explicit client bypasses; session row read once per render and re-read outside renders; memoized lists returned as fresh arrays |
| `docs/database-schema.md` §Hot-path query plan contract (new) | IDX-01…IDX-11 | Reader → index usability |
| `docs/supervisor.md` §Host state | IDX-12 | `session_process_run_idx` serves `sessionProcessesForRun` |

## Contract Surfaces → Spec Files

| Surface | Spec file(s) |
|---------|--------------|
| `GET /diagnostics?refresh`, 409 `diagnostics_query_invalid`, cache semantics, `checkedAt` meaning | `docs/api/supervisor.openapi.yaml` (`/diagnostics` ~l.721 + `SupervisorDiagnosticsResponse.checkedAt`) + `docs/supervisor.md` |
| `ExecutionHostTransport.diagnostics(opts)` gains `refresh?: boolean` (in-code contract) | JSDoc at `web/lib/execution-host/client.ts:270` + `host-diagnostics.md` Linked artifacts |
| Client message rule ("a new client `useTranslations` namespace is added to `CLIENT_NAMESPACES`") | `client-messages.md`, `web/CLAUDE.md`, `.ai-factory/rules/frontend.md`, ADR-225 |
| 11 Postgres indexes | migration 0410 quadruple (SQL + `_journal.json` + `meta/0410_snapshot.json` + `schema.ts`), `docs/database-schema.md` (both duplicate index tables at ~5352 and ~5408 + per-table prose `## runs` ~2280, `## workspaces` ~3084, librarian ~1627-1790), `docs/db/{runs-domain,domain-events,webhooks,librarian-domain}.md`, generated `docs/db/erd.dbml` |
| SQLite host-state v23 | `docs/supervisor.md` ~l.1232-1277 (also fix the stale "currently 16") |
| Decisions | `docs/decisions/adr-224.md`, `docs/decisions/adr-225.md` + `### ADR-NNN:` stubs + index rows in `docs/decisions.md` |
| Stale texts | `.ai-factory/rules/database.md:31` (claims `workspaces.run_id` is indexed); `docs/screens/chrome/left-rail.md` (readiness freshness) |

No new env vars, config files, sidecars, ports or mounts are added, so Dockerfile, compose files and `.env.example` are unchanged. ADR-224 states this explicitly.

## Commit Plan
- **Commit 1** (tasks 1–6): `docs: specify diagnostics snapshot, scoped client messages, render memoization and hot-path indexes`
- **Commit 2** (tasks 7–9): `perf(supervisor): snapshot and coalesce GET /diagnostics; host-state v23 run index`
- **Commit 3** (tasks 10–11): `perf(db): add hot-path indexes with plan-usability tests`
- **Commit 4** (tasks 12–13): `perf(web): fix decisions cache key, memoize session/visible projects, diagnostics freshness classes`
- **Commit 5** (tasks 14–16): `perf(web): prune root client i18n messages to client-used namespaces`
- **Commit 6** (task 17): `docs: mark perf work implemented and record validation metrics`

## Tasks

### Phase 0: Specs (SDD). Exit: every artifact complete and consistent with D1–D6, every piece tagged `(Designed)`, `pnpm validate:docs` green, OpenAPI lint clean

- [x] **Task 1: ADR-224 and ADR-225 (number reservation + records)**
  - Confirm that the numbers are free at `master` HEAD.
  - Create `docs/decisions/adr-224.md` "Supervisor diagnostics snapshot cache", status `Designed`. Sections:
    - Context: per-navigation spawn cost.
    - Decision: D1.
    - Consequences: the accepted residuals, no deployment touchpoints, and a background compute with no retry loop (the next request retries).
    - Alternatives: web-only cache (it doesn't protect other callers); Suspense-streaming the rail (left as a follow-up); blanket TTL (it breaks readiness writing and launch evidence).
  - Create `docs/decisions/adr-225.md` "Root client-message pruning", status `Designed`. Sections:
    - Context: catalog serialization.
    - Decision: D2, including the owner decision.
    - Consequences:
      - the honest saving bound;
      - the silent-fallback risk;
      - the scanner equality test as the enforcement point;
      - "new client namespace → update the list".
    - Alternatives:
      - per-route providers (deferred to Phase 2, because of the UI regrouping);
      - `messages={null}` (it breaks the shell's client components);
      - a client `onError` throw (functions can't cross into the client provider);
      - key-level pruning (dynamic keys such as `t(status)` make it unsound).
  - Add the `### ADR-224:` and `### ADR-225:` stubs and the index rows in `docs/decisions.md`. Add a TODO (R9) for the duplicate index tables in `database-schema.md`.
  - **Acceptance:** `pnpm validate:docs` passes the stub↔record bijection and the anchors; each ADR states every alternative with its rejection reason.

- [x] **Task 2: Supervisor wire contract** (depends on 1)
  - **OpenAPI `/diagnostics`:**
    - add the `refresh` query parameter (`enum: ["1","true"]`);
    - add a `409` response referencing the existing error schema, with an example `{ code: PRECONDITION, details: { reason: diagnostics_query_invalid } }`;
    - extend the description with the snapshot/TTL/SWR/singleflight semantics and a link to `host-diagnostics.md`;
    - document that `SupervisorDiagnosticsResponse.checkedAt` is the "probe start time of the returned snapshot".
  - **`docs/supervisor.md`:** add the same diagnostics prose (citing ADR-224, R4) and the host-state v23 index under IDX-12, and fix "currently 16".
  - **Acceptance:**
    - `npx @redocly/cli lint docs/api/supervisor.openapi.yaml` has no new errors;
    - the prose and the OpenAPI agree on every status code and parameter.

- [x] **Task 3: `host-diagnostics.md` system analytics** (depends on 1)
  - New `docs/system-analytics/host-diagnostics.md`, following the R5 order.
  - **Purpose:** the read path of supervisor runtime diagnostics, from the host probe to web consumers.
  - **Domain entities:** snapshot, generation, source version, freshness class.
  - **State machine** (`stateDiagram-v2`):
    - states: `Empty`, `Computing`, `Fresh`, `Stale` and `Expired`;
    - transitions on: request, forced request, compute success, compute failure, TTL elapse, SWR elapse and source-version change.
  - **Process flows** (`sequenceDiagram`):
    - cold request;
    - coalesced burst;
    - stale-while-revalidate;
    - forced refresh racing an older in-flight compute (generation ordering);
    - smoke-cache rewrite;
    - compute failure.
  - **Freshness-class table:** D1.
  - **Expectations DIAG-01…DIAG-12**, one normative, testable sentence each:
    - DIAG-01: fresh hit spawns no process and returns an identical body;
    - DIAG-02: at most one compute in flight; non-forced callers join it;
    - DIAG-03: a stale-servable snapshot returns immediately and starts exactly one background compute;
    - DIAG-04: no snapshot, or one beyond the SWR window → the request awaits a compute;
    - DIAG-05: forced never returns data from a compute that started before its arrival;
    - DIAG-06: an older generation never overwrites a newer one;
    - DIAG-07: a source-version change is treated as no snapshot;
    - DIAG-08: a failure is never stored, every joined waiter gets it, and the next request recomputes;
    - DIAG-09: `checkedAt` equals the snapshot's probe start;
    - DIAG-10: an invalid `refresh` → 409 `PRECONDITION`/`diagnostics_query_invalid` with no compute;
    - DIAG-11: fresh-class callers send `refresh`, and snapshot-class callers never do;
    - DIAG-12: the snapshot is process memory only and is empty after a restart.
  - **Edge cases:**
    - supervisor unreachable → web `SupervisorDiagnosticsStatus.kind="unavailable"` (unchanged);
    - background failure while serving stale;
    - smoke file deleted (`null` version);
    - clock regression (age below 0 → treated as expired);
    - concurrent forced requests compute independently (bounded by admin frequency).
  - **Linked artifacts:** OpenAPI, ADR-224, source files.
  - Add the README index row. Amend the `acp-runners.md` reconcile sequence so that `A->>D` reads `fetch diagnostics (refresh=1)`, and link `host-diagnostics.md` instead of restating it (R7). Add a one-line freshness note to `docs/screens/chrome/left-rail.md`.
  - **Acceptance:**
    - Mermaid validates;
    - ≤ 12 expectations;
    - every edge case names an existing code path or status;
    - the README gate passes.

- [x] **Task 4: `client-messages.md` system analytics + conventions** (depends on 1)
  - New `docs/system-analytics/client-messages.md`, following the R5 order.
  - **Purpose:** delivery of i18n messages to client components.
  - **Domain entities:** catalog, client namespace list, message path, client-reachable module.
  - **Process flows** (`sequenceDiagram`):
    - document render (root picks `CLIENT_NAMESPACES`);
    - `router.refresh()` (the root provider props are re-sent);
    - a developer adds a client `useTranslations` (the scanner test fails, the list is updated, the test turns green).
  - **Expectations CMSG-01…CMSG-08:**
    - CMSG-01: the root provider supplies exactly `pickMessages(messages, CLIENT_NAMESPACES)`;
    - CMSG-02: `CLIENT_NAMESPACES` equals the minimal cover of client-reachable `useTranslations` literals (complete and minimal);
    - CMSG-03: client code never calls `useMessages()` or a root/non-literal `useTranslations`;
    - CMSG-04: every `CLIENT_NAMESPACES` path exists in `web/messages/en.json` (ru parity via the existing `i18n-parity.test.ts`);
    - CMSG-05: no production file other than `web/app/layout.tsx` renders `NextIntlClientProvider`;
    - CMSG-06: `pickMessages` returns namespace objects by reference, and a dotted path yields only the requested subtree;
    - CMSG-07: an unknown path throws outside production, and in production it is omitted with a WARN;
    - CMSG-08: no covered route emits `MISSING_MESSAGE` in EN or RU.
  - Mark per-route scoping as `(Phase 2: revisit with the UI regrouping; see ADR-225)`.
  - **Edge cases:**
    - `t.has` silently returns false for a missing namespace (`run-peek-navigation.tsx:201`);
    - a `next/dynamic` import is followed;
    - a module without a directive is reached from a client file (it counts as client);
    - a server component's `getTranslations` is unaffected (it reads the request config, not the provider).
  - **Linked artifacts:** ADR-225, `client-namespaces.ts`, the scanner, the e2e spec.
  - Add the README row. Add the rule to `web/CLAUDE.md` and `.ai-factory/rules/frontend.md`: "a new client `useTranslations('ns')` requires `ns` in `CLIENT_NAMESPACES`; enforced by `i18n-client-namespaces.test.ts`".
  - **Acceptance:** Mermaid validates, ≤ 12 expectations, the README gate passes.

- [x] **Task 5: Render-memoization specs**
  - `docs/system-analytics/attention.md`:
    - amend `ATN-05` to "…one layout-level `decisions` value, computed once per render; no surface may recompute its own" (a clarification of the existing contract; `notifications.md:133` already states "one computation");
    - add `EDGE-ATN-09`: "`companyIds: []` MUST stay project-only through the cached reader";
    - update the §As built paragraph on caching.
  - `docs/system-analytics/identity-access.md`: add a new topical section "Per-render memoization (Designed)" after Process flows, with MEMO-01…MEMO-05 (D3: MEMO-01 equivalent scopes share one computation, MEMO-02 `companyIds: []` ≠ `undefined`, MEMO-03 explicit client bypasses the cache, MEMO-04 session row read at most once per render and on every call outside a render, MEMO-05 memoized lists returned as fresh arrays). It states that outside an RSC render every call re-reads, so "deleted user loses authority on next request" (`identity-access.md:409`) is unchanged.
  - Add the `EDGE-ATN-09` row to `docs/system-analytics/m51-traceability.md` (primary test `IT-EDGE-ATN-09`); `validate-docs-indexes.mjs` requires a row for every declared ATN id.
  - **Acceptance:** `attention.md` Expectations stay at 12 bullets; the MEMO IDs are referenced by tests in Task 12.

- [x] **Task 6: DB schema specs**
  - In `docs/database-schema.md`:
    - add the IDX-01…IDX-11 rows to the `## Indexes` table, tagged `(Designed)`, each once next to its table's existing rows (the table's two halves overlap only partially; the duplication is logged as a TODO in `decisions.md`);
    - add per-table prose for `runs`, `workspaces`, `domain_events`, `webhook_deliveries`, `webhook_events`, `librarian_messages` and `librarian_turns`;
    - add a new "Hot-path query plan contract" table (ID → index → reader → test file);
    - add a one-line `(Phase 2)` note: large installs may need a `CONCURRENTLY` pre-create path; not needed today.
  - Update `docs/db/{runs-domain,domain-events,webhooks,librarian-domain}.md` index sections.
  - Fix `.ai-factory/rules/database.md:31`.
  - **Acceptance:** the table definitions equal D6 verbatim.

<!-- Commit checkpoint: tasks 1-6 -->

### Phase 1: Supervisor. Exit: `pnpm -C supervisor lint typecheck test:unit test:integration` green

- [x] **Task 7: Diagnostics snapshot policy (TDD)** (depends on 2, 3)
  - **RED:** `supervisor/src/__tests__/diagnostics-cache.test.ts` (unit project). It uses a fake clock, a deferred `compute`, and a mutable `sourceVersion`. One test per requirement, each titled with its ID:
    - DIAG-01: a second call within the TTL resolves to the same object with `compute` called once;
    - DIAG-02: 20 concurrent calls during a pending compute → one compute;
    - DIAG-03: age between the TTL and SWR returns the old value synchronously-resolved, and exactly one background compute starts even under 5 concurrent stale calls;
    - DIAG-04: beyond SWR, the call awaits a new compute;
    - DIAG-05: forced, while an in-flight compute that started before it is pending, starts a second compute and resolves with its value; forced arriving before an in-flight compute starts joins it;
    - DIAG-06: when the older generation resolves last, a subsequent read returns the newer value;
    - DIAG-07: a version change within the TTL → recompute;
    - DIAG-08: a rejection is propagated to all joiners, nothing is stored, and the next call recomputes; a background rejection is logged at WARN and never surfaces;
    - DIAG-09: the returned `startedAt` equals the clock at compute start, not at completion.
  - Expected RED reason: the module does not exist.
  - **GREEN:** implement `createDiagnosticsCache<T>` per D1. A clock regression (age below 0) is treated as expired.
  - **REFACTOR:**
    - it is a single pure policy unit with no I/O imports (SRP/DIP);
    - the states are a discriminated union, not boolean flags (KISS);
    - it has no adapter knowledge.
  - **LOGGING** (pino child `{ component: "diagnostics.cache" }`):
    - DEBUG per `get` `{ outcome: "fresh"|"stale_served"|"coalesced"|"computed"|"forced"|"source_changed", ageMs, generation }`;
    - DEBUG on compute start and end `{ generation, durationMs }`;
    - INFO when `durationMs > 1000`;
    - WARN on background failure `{ err }` and on a discarded older generation.
    - The level comes from the existing `LOG_LEVEL`.
  - Files: `supervisor/src/diagnostics-cache.ts` (new), the test (new).

- [x] **Task 8: `/diagnostics` route wiring (TDD)** (depends on 7)
  - **RED:** `supervisor/src/__tests__/diagnostics-route.integration.test.ts` (integration project). It boots a real Fastify app via `registerRoutes`, with PATH-prepended shim executables `gemini`, `opencode` and `mimo` that append one line per invocation to a counter file and print a version. It proves wiring only; the policy is already unit-proven:
    - DIAG-02 e2e: 10 concurrent `GET /diagnostics` → each shim invoked exactly once, and all bodies are equal;
    - DIAG-05 wiring: `GET /diagnostics?refresh=1` → each shim invoked once more;
    - DIAG-07 wiring: rewriting the smoke-cache file via `writeAdapterSmokeCache` → the next non-forced request re-invokes the shims;
    - DIAG-10: `?refresh=yes` and a repeated `?refresh=1&refresh=1` → 409 `PRECONDITION` with `details.reason="diagnostics_query_invalid"`, and zero shim invocations.
  - Expected RED reason: today every request spawns, and `refresh` is ignored.
  - **GREEN:**
    - extract `computeSupervisorDiagnostics(runtimeRoot, logger)` from the handler (a move, not a rewrite);
    - instantiate one cache per `registerRoutes`, with `sourceVersion` reading the `stat(adapterSmokeCachePath(runtimeRoot)).mtimeMs` or `null`;
    - add `parseDiagnosticsRefresh(query)`, mirroring `parseHealthStreamOption`;
    - add the `RegisterRoutesOptions.diagnosticsCacheTtlMs` / `diagnosticsStaleWhileRevalidateMs` overrides.
  - **Assertion migration:** read `lifecycle.integration.test.ts`, `env-refs.integration.test.ts` and `steering-capability.integration.test.ts`. Any case that mutates host state between two `/diagnostics` calls switches to `?refresh=1`. List each migrated assertion in the commit body.
  - **REFACTOR:** the handler is ≤ 15 lines (parse → `cache.get` → send). The query parser shares the existing `PRECONDITION` error builder (DRY).
  - **LOGGING:** the existing `[FIX] adapter diagnostics computed` DEBUG stays inside compute. Add a DEBUG `http GET /diagnostics { refresh }`.
  - Files: `supervisor/src/http-api.ts`, the new test, and the migrated tests.

- [x] **Task 9: Host-state v23 (TDD)** (depends on 2)
  - **RED:** `supervisor/src/__tests__/host-state-v23.integration.test.ts`:
    - IDX-12a: a fresh store has `session_process_run_idx` in `sqlite_master` with columns `(run_id, registered_at, command_id)`;
    - IDX-12b: a store created at v22 (reuse the CBS-02 upgrade fixture pattern) reopens at `user_version = 23` with the index;
    - IDX-12c: `EXPLAIN QUERY PLAN` of the exact `sessionProcessesForRun` statement reports `USING INDEX session_process_run_idx`.
  - Expected RED reason: the index is absent.
  - **GREEN:** D5.
  - **REFACTOR:** the index DDL is one shared constant used by both the fresh schema and the step (DRY).
  - Confirm that `host-identity` H9 and `command-receipts:677` stay green unchanged, because they follow the constant.
  - **LOGGING:** reuse the existing migration-step log shape `{ from: 22, to: 23 }` at INFO.
  - Files: `supervisor/src/host-state.ts`, the new test.

<!-- Commit checkpoint: tasks 7-9 -->

### Phase 2: Postgres indexes. Exit: web unit + integration green; `pnpm -C web db:generate` → "No schema changes"; `pnpm --filter maister-web db:erd --check` clean

- [x] **Task 10: Plan-capture harness + RED index tests** (depends on 6)
  - New `web/test-support/query-plan-capture.ts`:
    - `capturePlans(db, run: () => Promise<unknown>, { tables })` wraps the pg client's `query` and records the `(text, values)` that the **public reader** actually emits;
    - for each statement touching `tables`, it runs `EXPLAIN (FORMAT JSON)` with the same values inside a transaction with `SET LOCAL enable_seqscan = off; SET LOCAL enable_sort = off`;
    - it returns the index names per statement.
  - This proves predicate provability and column-order match without exporting private builders and without planner-cost flakiness.
  - Before writing it, grep `web/test-support` for an existing equivalent and reuse it if found.
  - **RED:** `web/lib/db/__tests__/hot-path-indexes.integration.test.ts` (integration project). It seeds a representative dataset:
    - several projects plus company runs with `project_id NULL`;
    - runs spanning all statuses and kinds;
    - workspaces with equal `created_at` ties;
    - domain events of mixed kinds;
    - delivered, dead and pending deliveries;
    - fanned-out events;
    - librarian segments with messages and turns.
  - It then runs `ANALYZE` and has one table-driven case per ID, invoking the public entry point:
    - IDX-01: `listRunsPage` and `getRunDetail`;
    - IDX-02: `getObservatoryOverview`;
    - IDX-03: `listRunsPage` (admin, no filters);
    - IDX-04: the flow and agent continuation candidate selectors (via their exported tick/claim entry);
    - IDX-05: `findHostRestartRecovery`;
    - IDX-06: the activity feed reader, the attention stream `GET` handler scan and `getBudgetSummary`;
    - IDX-07/IDX-09: `runWebhookDeliveryJob` prune phase;
    - IDX-08: the attention stream scan and the activity feed deliveries;
    - IDX-10/IDX-11: `retrieveLibrarianContext`.
  - Each case asserts that its index name appears.
  - Expected RED reason: the indexes are absent.
  - If an entry point can't be driven without a heavy fixture, use its smallest existing integration fixture rather than hand-copied SQL.
  - **LOGGING:** test-only.

- [x] **Task 11: Declare indexes + migration 0410 (GREEN)** (depends on 10)
  - **GREEN:**
    - add the D6 indexes to the `schema.ts` table builders, with `.desc()`/`.asc()` exactly as specified and `.where(sql\`…\`)` for partials;
    - run `pnpm -C web db:generate` to produce `0410_hot_path_indexes.sql`, the snapshot and the journal entry;
    - keep the generated SQL unedited (D4);
    - re-run `db:generate` → no diff;
    - run `pnpm --filter maister-web db:erd`.
  - **REFACTOR:**
    - partial-index predicates reuse the existing status-set constants only where `schema.ts` already does so for partial indexes; otherwise use literal SQL matching the spec;
    - no reader query changes, unless Task 10 proved a predicate unprovable, in which case the spec is amended first.
  - IDX-04 fallback per D6 if needed (spec first).
  - **LOGGING:** none at runtime (DDL); the migration runner already logs applied tags.
  - Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0410_hot_path_indexes.sql`, `meta/_journal.json`, `meta/0410_snapshot.json`, `docs/db/erd.dbml`.

<!-- Commit checkpoint: tasks 10-11 -->

### Phase 3: Web memoization & diagnostics freshness. Exit: web unit + integration green

- [x] **Task 12: Decisions key, session and visible-project memoization (TDD)** (depends on 5)
  - New `web/test-support/react-cache-emulation.ts`. It emulates React's `cache` semantics with a positional `Object.is` argument trie and an explicit `withRender(fn)` scope. In vitest's node build React's `cache` passes through, so per-render behavior is unobservable without it.
  - **RED:** `web/lib/queries/__tests__/decisions-cache.test.ts` (unit, with `vi.mock("react")` using the emulation and a spy on `computeDecisionsQueue`):
    - MEMO-01: in one render, `getDecisionsCount(u, r)`, `getDecisionsQueue(u, r)`, `getDecisionsQueue(u, r, {})` and `getDecisionsQueue(u, r, { companyIds: ["b","a","a"] })` vs `["a","b"]` → computations equal to the number of distinct normalized keys (expected: 2);
    - MEMO-01/02 key: `decisionsCacheKey` round-trips through `decodeScope` for `undefined`, `{}`, `{ projectId }`, `{ companyIds: [] }` and multi-id inputs; `[]` ≠ `undefined`;
    - MEMO-03: an explicit `client` → a compute on every call.
  - **RED:** `web/lib/__tests__/authz-session-memo.test.ts`:
    - MEMO-04: in one render, two `getSessionUser()` calls plus the `jwt` callback trigger one `users` select;
    - across two renders → two selects;
    - outside any render → one select per call.
  - **RED:** extend `web/lib/queries/__tests__/visible-projects*.test.ts` (or create one):
    - MEMO-03: an explicit client is uncached;
    - MEMO-05: two calls in one render return distinct array instances with equal contents, and mutating one doesn't affect the other.
  - **RED (integration):** extend `web/lib/queries/__tests__/decisions.integration.test.ts`. EDGE-ATN-09 is a positive test: a user who sees a company decision and a project decision gets only the project item via `getDecisionsQueue(u, r, { companyIds: [] })`, and both items via `getDecisionsQueue(u, r)`.
  - Expected RED reasons: the double compute, the missing key builder, and the session re-select.
  - **GREEN:** D3.
  - **REFACTOR:** one key builder and one decoder (DRY); the cached functions are private, and the public signatures are unchanged (OCP: Open/Closed, for callers). Remove the obsolete `cache(computeDecisionsQueue)` comment.
  - **LOGGING:** DEBUG `[decisions.cache] key { userId, projectId, companyKey }`. The existing `decisions queue` timing log stays and now fires once per render, which is the validation signal. Add DEBUG `[authz] loadUser { userId }` inside the cached loader, so it only fires on a miss.
  - Files: `web/lib/queries/decisions.ts`, `web/lib/authz.ts`, `web/auth.ts`, `web/lib/queries/visible-projects.ts`, `web/test-support/react-cache-emulation.ts`, the tests.

- [x] **Task 13: Diagnostics freshness classes on the web (TDD)** (depends on 3, 8)
  - **RED:** `web/lib/execution-host/__tests__/diagnostics-freshness.test.ts` (unit; DIAG-11). It statically scans `app/`, `lib/` and `components/` for `.diagnostics(` call sites and `getPlatformDiagnostics`/`getFreshPlatformDiagnostics` usages, and asserts that each is listed in a `{ file → "fresh" | "snapshot" }` table equal to D1's table. Fresh entries must pass `refresh: true`; snapshot entries must not. An unlisted call site fails, which forces every future caller to choose a class.
  - **RED:** `web/lib/__tests__/supervisor-client.test.ts`: `checkSupervisorDiagnostics({ refresh: true })` requests `/diagnostics?refresh=1`, and the default requests `/diagnostics` with no query.
  - **RED (parity, integration):** add one case to `web/lib/execution-host/__tests__/diagnostics-steering-wire.integration.test.ts` against the real supervisor: `diagnostics({ refresh: true })` returns `kind: "ready"` with a `checkedAt` later than the previous snapshot's. The e2e `test-supervisor.ts` and `stub-supervisor.ts` accept and ignore `refresh` (no behavior to test).
  - **GREEN:**
    - `ExecutionHostTransport.diagnostics(opts?: { timeoutMs?: number; refresh?: boolean })`;
    - `local-direct.ts` forwards it;
    - the client appends the query;
    - add `getFreshPlatformDiagnostics = cache(() => executionHosts.local().diagnostics({ refresh: true }))`;
    - update the five fresh call sites and `settings/page.tsx`.
  - **Assertion migration:** update the call-arg assertions in:
    - `web/app/api/admin/acp-runners/__tests__/route.test.ts`;
    - `route.concurrency.integration.test.ts`;
    - `web/app/api/admin/mcp-servers/__tests__/admin-mcp-crud.integration.test.ts`;
    - `web/app/(app)/settings/__tests__/page-contract.test.ts`;
    - enforcement-evidence and read-only-evidence tests;
    - every `ExecutionHostTransport` fake, which must accept the option.
  - List each one in the commit body.
  - **REFACTOR:** a single `diagnosticsUrl(refresh)` helper in the client; no duplication of the freshness table between the test and the code (the test owns it).
  - **LOGGING:** extend the existing DEBUG `checkSupervisorDiagnostics { url, refresh }`.

<!-- Commit checkpoint: tasks 12-13 -->

### Phase 4: Root client-message pruning. Exit: web unit + integration green; Playwright spec green

- [x] **Task 14: Picker and root provider (TDD)** (depends on 4)
  - **RED:** `web/lib/__tests__/pick-messages.test.ts` (unit; matched by `lib/**/*.test.ts`):
    - CMSG-06:
      - by-reference identity for a whole namespace;
      - a dotted path yields `{ run: { runStatus: <same ref> } }` with no sibling keys;
      - two dotted paths under one parent merge into one parent object;
    - CMSG-07: an unknown path throws when `NODE_ENV !== "production"`; in production it returns without the path and logs WARN.
  - Expected RED reason: the module does not exist.
  - **GREEN:**
    - `web/i18n/pick-messages.ts`;
    - `web/i18n/client-namespaces.ts` seeded from the validated inventory;
    - root `web/app/layout.tsx` passes `messages={pickMessages(await getMessages(), CLIENT_NAMESPACES)}`.
  - **REFACTOR:** the picker has no list knowledge (SRP); the root layout's change is a single prop.
  - **LOGGING:** DEBUG `[i18n.client-messages] provided { paths }`; `bytes` is computed only when debug is enabled. WARN on an unknown path in production.

- [x] **Task 15: Client-namespace scanner + list equality (TDD)** (depends on 14)
  - **RED (engine):** `web/test-support/__tests__/client-namespace-scanner.test.ts`. It uses in-memory fixture file maps, one case per distinct detection path with no overlap:
    - a literal reached through a 2-hop import from a `"use client"` file is collected;
    - a literal used only by server code is not collected;
    - `import type` is ignored;
    - a `next/dynamic(() => import("…"))` edge is followed;
    - a `"use server"` boundary stops traversal;
    - root or non-literal `useTranslations` is flagged;
    - `useMessages` is flagged;
    - a stray `NextIntlClientProvider` is flagged;
    - `minimalCover(["run", "run.runStatus", "inbox.reviews"])` returns `["inbox.reviews", "run"]`.
  - **RED (repo):** `web/lib/__tests__/i18n-client-namespaces.test.ts` runs the engine over the real tree and asserts:
    - CMSG-02: `CLIENT_NAMESPACES` equals `minimalCover(literals)`, sorted;
    - CMSG-03 and CMSG-05: no violations;
    - CMSG-04: every path resolves in `en.json`.
  - Expected RED reasons: the engine does not exist; the seeded list may differ from the computed cover.
  - **GREEN:**
    - `web/test-support/client-namespace-scanner.ts`; model the file walker and regexes on `web/lib/__tests__/parameterized-messages.test.ts`, and reuse its walker if it is exportable without behavior change (DRY);
    - correct `CLIENT_NAMESPACES` to the computed cover.
  - **REFACTOR:** the engine is pure (`fileMap` in, result out); the repo test only does I/O.
  - **LOGGING:** test-only. The equality failure prints the missing and extra paths plus the client module chain for each missing one.

- [x] **Task 16: Runtime `MISSING_MESSAGE` E2E (CMSG-08)** (depends on 15)
  - RED demonstrated by temporarily removing `"librarian"` from `CLIENT_NAMESPACES` (`MISSING_MESSAGE: librarian (en)/(ru)` caught across routes), then restored and verified GREEN (`desk-html-bytes-en=786993`, `desk-html-bytes-ru=955262`).
  - **RED → GREEN:** `web/e2e/i18n-client-messages.spec.ts`. For EN and RU, it collects browser console messages, visits the routes below, and asserts that no message contains `MISSING_MESSAGE`:
    - desk and inbox;
    - `/projects/[slug]` with the board, settings and webhooks tabs;
    - `/runs/[runId]` and `/scratch-runs/[runId]`;
    - studio, knowledge, settings, specialist-assignments and account;
    - login and change-password;
    - opening the librarian panel.
  - RED is demonstrated once during development by temporarily removing one path from the list; record that in the task notes, not in code.
  - It records the `/` HTML byte size for EN and RU as test annotations for Task 17.
  - Use the existing seeded fixtures; run via `pnpm -C web test:e2e -- i18n-client-messages`.
  - **LOGGING:** test-only.

<!-- Commit checkpoint: tasks 14-16 -->

### Phase 5: Close-out (mandatory docs checkpoint)

- [x] **Task 17: As-built reconciliation, metrics, gates, adversarial review** (depends on 9, 11, 12, 13, 16)
  - Flip ADR-224/225, `host-diagnostics.md`, `client-messages.md`, the `identity-access.md` section, the `database-schema.md` rows, the `docs/db/*` sections and the `supervisor.md` sections from `(Designed)` → `(Implemented)`. Reconcile every deviation (for example, the IDX-04 fallback or a corrected client namespace list) back into the spec.
  - Run a **traceability check:** every requirement ID in the matrix below has its test(s) and every test title carries its ID. Grep both directions; no orphan IDs, no orphan tests.
  - Record the **Validation** sections in ADR-224/225:
    - TTFB on `/` and `/projects/[slug]` (`curl -w "%{time_starttransfer}"`, 10 samples, idle supervisor, before/after);
    - shim spawn count under 20 concurrent navigations;
    - HTML and `?_rsc=` payload bytes for EN/RU before/after;
    - per-render query counts on `/` and `/inbox` (the `decisions queue` log fires once per render; one `[authz] loadUser` miss).
  - **Full gates:**
    - `pnpm -C web lint typecheck test:unit test:integration`
    - `pnpm -C supervisor lint typecheck test:unit test:integration`
    - `pnpm -C web test:e2e` (scoped spec + existing suite baseline per `web/CLAUDE.md`)
    - `pnpm validate:docs`
    - redocly lint
  - Run an **adversarial review** (`/aif-review`) of the full diff, with these focus points:
    - the D1 concurrency ordering;
    - the D3 `[]` vs `undefined` key;
    - the scanner's false-negative paths.
  - Every fix cycle gets its own review pass.
  - Route the docs pass through `/aif-docs`.

<!-- Commit checkpoint: task 17 -->

## Requirement → Test Traceability

| ID | Spec | Test (level) |
|----|------|--------------|
| DIAG-01…09 | host-diagnostics.md | `supervisor/src/__tests__/diagnostics-cache.test.ts` (unit) |
| DIAG-02, 05, 07 (wiring), DIAG-10 | host-diagnostics.md, OpenAPI | `supervisor/src/__tests__/diagnostics-route.integration.test.ts` (integration) |
| DIAG-11 | host-diagnostics.md | `web/lib/execution-host/__tests__/diagnostics-freshness.test.ts` (unit, static), `web/lib/__tests__/supervisor-client.test.ts` (unit, URL), `diagnostics-steering-wire.integration.test.ts` (parity) |
| DIAG-12 | host-diagnostics.md | Review checklist (no persistence code path); cache instance per `registerRoutes` asserted implicitly by integration isolation |
| CMSG-01 | client-messages.md | Review checklist (single prop in root layout) + CMSG-08 E2E |
| CMSG-02…05 | client-messages.md | `web/lib/__tests__/i18n-client-namespaces.test.ts` (unit, repo) + `web/test-support/__tests__/client-namespace-scanner.test.ts` (unit, engine) |
| CMSG-06, 07 | client-messages.md | `web/lib/__tests__/pick-messages.test.ts` (unit) |
| CMSG-08 | client-messages.md | `web/e2e/i18n-client-messages.spec.ts` (E2E) |
| ATN-05 / MEMO-01, 03 | attention.md, identity-access.md | `decisions-cache.test.ts` (unit, emulated cache) |
| EDGE-ATN-09 / MEMO-02 | attention.md | `decisions.integration.test.ts` (integration, positive) + key round-trip in `decisions-cache.test.ts` |
| MEMO-04 | identity-access.md | `authz-session-memo.test.ts` (unit, emulated cache) |
| MEMO-03, 05 (visible projects) | identity-access.md | visible-projects unit test |
| IDX-01…11 | database-schema.md | `web/lib/db/__tests__/hot-path-indexes.integration.test.ts` (integration, real Postgres) |
| IDX-12 | supervisor.md | `supervisor/src/__tests__/host-state-v23.integration.test.ts` (integration, real SQLite) |

## Out of Scope (tracked follow-ups)
- **Per-route client message scoping (Phase 2):** revisit with the UI regrouping. The scanner engine extends to per-owner coverage.
- **Concurrent index rollout for large installs (Phase 2).**
- **Finding #8 remainder:**
  - `RunDetailLayout` / `getRunDetail` / `TaskDetailPage` `Promise.all` waves;
  - the write-on-read `reconcileRunCostRollups` in `getRunTimeline`/`getRunCostSummary`;
  - `ProjectBoardPage` tab-gated `getBoardData`;
  - DB pool sizing (Finding #5).
- Streaming the left-rail readiness behind `<Suspense>`, so `AppLayout` never awaits diagnostics at all.
- **Further unindexed paths found during validation:**
  - `domain_events.run_id` and `webhook_events.run_id` (runs ON DELETE CASCADE);
  - `workspaces.promoted_at` (attention-stream scan);
  - the unbounded Observatory `selectTaskGroups` scan (ADR-059 caveat);
  - `session_process_obligations` released-row retention (there is no deletion path).
- **`run` namespace split (deferred 2026-11-28, review of this branch):** 17 client components call `useTranslations("run")`, so the whole `run` namespace (38 KB EN, about 14% of the picked payload) ships in every document. Converting them to dotted subkeys needs no per-route provider, but the repo has no compile-time message keys, so the conversion is only verifiable in the browser. Land it where the E2E lane runs, ideally behind a static key-coverage guard.
- **i18n E2E route coverage (deferred 2026-11-28):** `web/e2e/i18n-client-messages.spec.ts` visits 14 routes. The admin, agents and evaluation surfaces behind most remaining `CLIENT_NAMESPACES` entries are never rendered, so a scanner miss there would ship silently.
