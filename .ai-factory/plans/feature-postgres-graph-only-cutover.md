# Implementation Plan: M43 Postgres-only + Graph-only Cut-over

Branch: `feature/postgres-graph-only-cutover`
Created: 2026-07-11
Base observed: `main` at `5916d4ea`
Mode: Full · SDD + TDD · hard cut-over
Engine target: `3.0.0`
ADR: `ADR-130` (one ADR for both removals; renumbered on rebase)
Migration sequence: `0094_postgres_graph_only_cutover`, then
`0095_close_m43_cutover_task_claims`, then `0096_index_m43_cutover_events`

## Settings

- Testing: yes. Use docs/spec freeze first, then RED -> GREEN -> refactor for
  parser/refusal/type work and real-Postgres integration/E2E for migration,
  locking, lifecycle, and UI behavior.
- Development process: SDD-driven. No implementation code starts until the
  normative spec, affected API operations, DB migration invariants, system
  analytics, and screen-state contracts are complete and pass a consistency
  review. Implementation is a conformance exercise against those artifacts.
- Logging: verbose. New/changed runtime paths use structured fields; DEBUG for
  classification and refusal context, INFO for boot/cut-over summaries, WARN for
  each legacy run terminalized at upgrade, ERROR immediately before a fatal
  CONFIG/DB failure. Never log DB credentials or manifest bodies.
- Docs: yes. Phase 0 is a mandatory docs-first contract gate; final as-built
  synchronization is mandatory.
- Code quality: follow the repository conventions plus SOLID/KISS/DRY. Prefer
  pure, single-purpose classifiers and one canonical boundary per invariant;
  do not introduce boolean mode flags, duplicate parsers/status sets, silent
  fallbacks, or speculative abstractions.
- Roadmap: link to new `M43 — Postgres-only + graph-only cut-over`. M41 and M42
  are already implemented in code/docs even though the current roadmap stops at
  M40; do not reuse those numbers.
- Branch/worktree: this Codex worktree was detached exactly at `main` and clean;
  it is now the fresh isolated worktree on
  `feature/postgres-graph-only-cutover`.

## Roadmap Linkage

- Milestone: `M43 — Postgres-only + graph-only cut-over`.
- Rationale: this is a single breaking platform simplification spanning the DB
  contract, Flow DSL, execution engine, stored revisions, upgrade behavior,
  package intake, Studio, and operational docs.
- Roadmap repair in the same docs-first task: add M41/M42 as shipped context,
  add M43, and correct the stale M14/M27/M39/M40 checkboxes only after verifying
  their current implementation status. Do not rewrite unrelated milestone prose.

## Goal

Ship one breaking release in which:

1. Postgres is the only database dialect. Missing or non-Postgres `DB_URL`
   fails boot and every DB CLI entry point with a typed/actionable CONFIG error;
   no catch path continues startup.
2. `nodes[]` is the only accepted Flow manifest shape. Any manifest containing
   legacy `steps[]` is refused through one shared typed classification with the
   exact cut-over message:

   > `legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]`

3. Engine `3.0.0` removes the linear runner, linear guards, `step_runs`, and all
   SQLite dependencies/typing branches.
4. D1: migration `0094` intentionally drops `step_runs` without exporting or
   backfilling pre-M11a step detail. `runs` rows remain as run-level history.
5. D2: before `step_runs` is dropped, every unfinished legacy linear Flow run is
   atomically terminalized to `Failed` with a durable
   `run.failed.payload.reason = "legacy_steps_engine_3_cutover"`; graph runs and
   already terminal linear history are untouched.

## Locked Decisions

- Hard cut-over only: no SQLite fallback, no `steps[] -> nodes[]` converter,
  codemod, compatibility shim, dual parser, or legacy runtime feature flag.
- D1 is accepted: loss of `step_runs` history is deliberate. This is an explicit
  owner-approved exception to the normal project rule that destructive
  migrations backfill or abort; the ADR and upgrade runbook must say so plainly.
- D2 applies to every legacy Flow run not finally settled as `Done`, `Failed`, or
  `Abandoned`, including recoverable `Crashed` and unpromoted `Review` rows.
- D2 is implemented in migration `0094` before `DROP TABLE step_runs`, while the
  upgrade runbook requires both web and supervisor to be stopped. This keeps the
  durable transition and data deletion in one Postgres transaction and prevents
  the new process from ever observing an actionable legacy run.
- The D2 explanation uses the existing terminal event contract, not a new broad
  `runs.failure_reason` column. The run/activity read model must surface the
  stable reason for affected rows. No new run status or `MaisterError` code.
- D2 closes every DB lifecycle store reachable for the selected runs in the same
  transaction: `runs` terminal fields/resume markers, open `node_attempts`, open
  HITL requests, open/claimed assignments plus assignment events, and stale
  per-run ACP handles. Workspaces and run-level history are retained for normal
  inspection/GC.
- D2 emits exactly one `run.failed` domain event with the stable `reason` and a
  matching webhook outbox record using the existing `errorCode: "CONFIG"` wire
  shape per CAS-winning run. Re-running the migration/test helper cannot emit a
  duplicate; the webhook contract is not widened with a new field.
- Follow-on migration `0095_close_m43_cutover_task_claims` runs after 0094 in
  the same stopped-service main-lineage sequence. It clears only a non-null C2
  `tasks.queue_claimed_at` at or before that task's latest durable D2 event;
  later claims (including a later re-triage) stay intact. It creates no run or
  event and changes no schema shape.
- `flow_revisions.manifest` is the primary discriminator for D2; unpinned legacy
  rows fall back to the project `flows.manifest`. Non-Flow `run_kind` values are
  excluded before any terminalization.
- `flow_revisions` rows containing `steps[]` remain stored history but are
  classified as incompatible. Enable/upgrade/launch/read paths must never raw-cast
  and compile them.
- `flowYamlV1Schema` remains `.passthrough()` for unrelated extension fields, so
  `steps` needs an explicit custom refusal. Simply deleting the schema property
  would silently accept it as unknown data and is forbidden.
- `MAISTER_ENGINE_VERSION` becomes `3.0.0`. Existing first-party `nodes[]`
  packages with open-ended compatibility stay compatible without retagging;
  manifest shape, not an artificial `engine_min`, rejects legacy packages.
- Preserve the `{{ steps.<id>.* }}` template namespace. It remains the stable
  author-facing lookup name and is populated only from `node_attempts` after the
  cut-over.
- Remove only linear `pre_guards`/`post_guards` and `web/lib/flows/guards.ts`.
  Graph `pre_finish.gates`, node gates, readiness gates, and gate result ledgers
  remain unchanged.
- No external API import surface exists today. Ext launch routes converge on the
  normal launch service; do not invent a fifth importer.
- Postgres advisory/row locks become unconditional and fail fast. No
  `typeof tx.execute` escape hatch and no catch-and-continue serialization
  fallback survives.
- Brain remains separately provisioned through its own migration lineage.
  Remove dialect-based `isBrainProvisioned`, but retain the distinct
  `isBrainSchemaApplied`/`assertBrainSchemaApplied` contract.
- Type cleanup is surgical: remove the 28-file
  `FIXME(any): getDb() returns a pg|sqlite drizzle union` class and the `any`
  caused by that union. Broader Drizzle-peer/type refactors are out of scope
  unless the lockfile/typecheck makes them mandatory.
- One ADR covers both removals because they are one release-level cut-over
  decision. Rebase allocated ADR-129 and migration 0093 to MCP management, so
  the cut-over uses ADR-130 and migrations 0094–0096.
- Every migration has a SQL file, `_journal.json` entry, and generated snapshot.
  The rebase regenerated the M43 snapshot chain from main's 0093 snapshot.

## Normative SDD Contract

Phase 0 creates
`.ai-factory/specs/feature-postgres-graph-only-cutover.md` as the normative
implementation contract. It must contain, in reviewable tables rather than
open-ended prose:

1. requirement IDs `PG-*`, `GRAPH-*`, `MIG-*`, `API-*`, `UX-*`, `DOC-*`, and
   `TEST-*`;
2. current-state evidence and the exact target invariant for every requirement;
3. a manifest-shape truth table (nodes-only, steps-only, both, neither,
   malformed, stored legacy JSONB, unsupported engine bounds);
4. a DB migration precondition/transition/postcondition table, including every
   affected run status and lifecycle store;
5. the API operation matrix below, with exact `MaisterError.code`, HTTP status,
   response shape, side-effect guarantee, and UI behavior;
6. state/process diagrams for package intake, launch refusal, D2 upgrade
   terminalization, event-consumer fan-out, and rollback;
7. screen-state contracts for legacy package, task launch, Studio editing, and
   historical failed run views;
8. a bidirectional traceability matrix:
   `requirement -> normative artifact -> task -> test -> acceptance criterion`
   and the reverse `test/task -> requirement`; no orphan row is allowed;
9. explicit non-functional requirements: fail-fast configuration, transaction
   atomicity, idempotency, accessibility, EN/RU parity, no secret/manifest-body
   logging, and bounded query/event behavior;
10. a resolved-questions section with no implementation-blocking `TBD`,
    “as needed”, or unowned follow-up.

The ADR records why the cut-over is accepted. The SDD spec records what must be
built and tested. System analytics records the resulting domain behavior.
Screen artifacts record user-visible states. These artifacts may link to one
another but must not duplicate competing rules.

## API Contract Matrix

The cut-over adds no route. It changes validation/refusal semantics on existing
operations, so implementation and OpenAPI must preserve each operation's
existing status-family conventions:

| Surface / operation | Legacy `steps[]` result | Side-effect contract |
| --- | --- | --- |
| `POST /api/projects` · `postProject` | `502 FLOW_INSTALL` with the locked cut-over message | Registration compensation removes the project/member/flow rows and slug-scoped artifacts; shared cache may remain exactly as today. |
| `POST /api/projects/{slug}/flow-packages/install` · `installFlowPackage` | `502 FLOW_INSTALL` | Revision never reaches `Installed`/enabled; no project enablement pointer changes. |
| `POST /api/admin/package-installs` · `postAdminPackageInstall` | `422 CONFIG` (member-manifest validation) | No usable package install/member projections are finalized. Clone/copy failures remain `502 FLOW_INSTALL`; do not collapse the two classes. |
| `POST /api/projects/{slug}/catalog/caps/{capId}/publish-local` · `publishLocalAuthoredCapability` | `422 CONFIG` | Authored revision/bridge does not publish or create `flows`/`flow_revisions`. |
| `POST /api/studio/local-packages/{id}/cut-version` · `cutStudioLocalPackageVersion` | `409 PRECONDITION` with `details.invalidArtifacts` from the existing full-tree cut gate | No export/install/stamp/attach occurs. This surface intentionally differs from authored publish. |
| Flow lifecycle enable/upgrade/rollback endpoints | `422 CONFIG` | Enabled revision pointer and cached `flows.manifest` remain unchanged. Upgrade preview is read-only and returns incompatibility instead of throwing a page error. |
| `GET /api/runs/launch-options` | `200`, `flowIssue="incompatible"`, actionable cut-over reason, `launchable=false` | Read-only; must not synthesize a runner override or hide the manifest failure. |
| `POST /api/runs` · `postRun` | `400 CONFIG` before worktree/run/session side effects | No run, workspace, session, capability materialization, or task mutation. Both JSON and pre-stream staged paths use the same precondition result. |
| `POST /api/v1/ext/runs` · `extLaunchRun` | `422 CONFIG` | Same service refusal and zero side effects; token failure audit remains consistent with existing ext-handler behavior. |
| Package/run read models | `200` with typed incompatibility/failure-reason DTO state | Pages remain renderable; no raw Zod/compile exception crosses the RSC/route boundary. |

`docs/api/web.openapi.yaml` must update the exact operation blocks above, not
global search-and-replace. `docs/api/external/operations.openapi.yaml` must
document `extLaunchRun`'s graph-only `422 CONFIG`. AsyncAPI is audited and stays
unchanged because the webhook payload remains `{errorCode}`; the internal
domain-event `reason/source` belongs in system analytics, not the outbound wire
schema. `pnpm validate:contracts` is a required phase gate.

## DB Migration Contract

Migration 0094 must be reviewed as executable D2/D1 data-state logic, not
merely a schema drop; migration 0095 is its ordered data-only C2-claim closure:

- Candidate identity is “`run_kind='flow'` and the authoritative manifest has
  a `steps` key”, regardless of whether the array is empty. Pinned
  `flow_revisions.manifest` wins; only an unpinned row may fall back to
  `flows.manifest`.
- A temporary candidate relation is materialized once and reused by every
  statement so lifecycle stores cannot be updated from drifting predicates.
- The actionable set is exactly `Pending | Running | NeedsInput |
  NeedsInputIdle | HumanWorking | WaitingOnChildren | Review | Crashed`.
  `Done | Failed | Abandoned` run rows remain unchanged.
- Before mutation, abort with an actionable migration error if an actionable
  Flow run has no resolvable manifest/project identity. Never guess its shape
  or silently skip a row that cannot satisfy the terminal event contract.
- The same transaction: closes open node attempts with `Failed/CONFIG`, marks
  unanswered HITL rows with a system cancellation response and `responded_at`,
  cancels open/claimed assignments and appends `system_closed` assignment
  events, clears resumable ACP handles/cursors, CAS-updates the run, and emits
  one domain/webhook event only for CAS winners.
- Domain payload is the existing terminal shape plus
  `reason="legacy_steps_engine_3_cutover"` and
  `source="upgrade_cutover"`; webhook data remains exactly
  `{errorCode:"CONFIG"}`.
- After 0094 commits, 0095 groups the durable D2 events by `task_id` and clears
  only a non-null `tasks.queue_claimed_at <= max(D2.occurred_at)` for that task.
  A later claim remains unchanged. The migration creates no run/event and is
  idempotent after clearing its bounded stale set.
- The shared C2 funnel then treats a latest D2 run as a terminal hold, not a
  retry: when `launch_armed_at` is absent or `<=` that event's `occurred_at`,
  both the poll and slot-free gate atomically flag the task, clear its auto
  launch mode, and append one system comment without a claim or `launchRun`.
  A human re-triage with a later arm is a distinct new intent and is eligible.
- Automation consumers must not treat this planned upgrade transition as a new
  work signal. A shared predicate excludes it from Ralph relaunch, configured
  agent triggers, Brain harvest, and source reindex. Cost reconciliation may
  consume it; a parked graph parent may be woken to observe its failed child;
  success-gated dependent tasks must not launch.
- The migration does not delete workspaces, artifacts, `runs`, or stored
  revisions. Normal terminal GC owns later workspace cleanup.
- Slot release is verified after restart: the scheduler can admit eligible
  graph runs, no D2 row remains in an active-capacity predicate, and no
  event-bounded stale C2 claim remains.
- Rollback is restore-from-backup only after `DROP step_runs`; down-migration or
  fabricated step history is explicitly unsupported.

## System Analytics and Screen Contract

Phase 0 improves existing artifacts; it creates a new artifact only when the
existing domain boundary cannot express the contract:

- `docs/system-analytics/flows.md`: nodes-only manifest lifecycle, typed intake
  refusal table, stored-revision incompatibility, engine 3.0.0 expectations and
  edge cases.
- `docs/system-analytics/flow-graph.md`: remove linear compilation/runtime and
  state that `node_attempts` is the sole execution ledger.
- `docs/system-analytics/projects.md` and `packages.md`: registration/install
  compensation, package/member validation code differences, enable/upgrade
  refusal and unchanged-pointer guarantees.
- `docs/system-analytics/runs.md`: D2 state transition matrix, terminal reason,
  control removal, capacity release, and historical inspection.
- `docs/system-analytics/reconciliation-gc.md`: distinguish one-time migration
  terminalization from recurring reconcile/GC; document retained workspaces and
  post-start cleanup.
- `docs/system-analytics/domain-events.md`, `outbound-webhooks.md`, and
  `project-brain.md`: exact cut-over event fan-out/filters and Postgres-only
  Brain provisioning semantics.
- `docs/database-schema.md`, `docs/db/erd.md`, and `docs/db/runs-domain.md`:
  remove `step_runs`, update `node_attempts` wording, cascade/index inventory,
  and migration 0094/0095/0096 notes. All three must agree with `schema.ts` and the
  generated snapshot.
- `docs/screens/projects/add-project.md`, `chrome/launch-dialog.md`,
  `projects/project-board.md`, `studio/package-viewer.md`, `studio/editor.md`,
  `studio/local-workspace.md`, `runs/flow-run.md`, `runs/list.md`, and
  `runs/run-inspector.md`: freeze the states below and their controls/copy.

UI/UX acceptance is behavior, not decoration:

1. installed/stored legacy package remains inspectable in read-only viewer with
   an “Incompatible with engine 3.0.0” badge and republish-with-`nodes[]`
   remediation; attach/enable/upgrade-to/launch controls are disabled at their
   earliest truthful surface;
2. a local legacy package may open raw YAML for manual rewriting, but canvas,
   commit, cut, and publish show a blocking validation panel; no automatic
   conversion is offered;
3. registration/install errors preserve form input and focus an accessible
   `role=alert` summary using the typed code, never message string matching;
4. the board derives a visible disabled-launch reason from the authoritative
   enabled revision, while the launch picker shows the same specific
   incompatibility reason, exposes no runner override that could bypass it, and
   cannot submit;
5. a D2 run shows a persistent Failed cut-over banner, timestamp/reason, and
   retained history/evidence/worktree links, while Recover, Resume, Respond,
   Promote, and retry controls are absent;
6. EN/RU copy is semantically equivalent, keyboard/focus behavior is covered,
   and generic package/graph screens do not regress.

## TDD Execution Contract

No phase or commit is allowed to remain red. Every implementation task follows
this local loop and records the focused command/evidence in its checklist:

1. **RED** — add the smallest non-trivial test for the next normative
   requirement; run it and confirm it fails for the intended missing behavior,
   not import, fixture, timeout, or environment failure.
2. **GREEN** — implement the minimum production change; run the focused test
   and the directly affected suite until green.
3. **REFACTOR** — remove duplication, narrow types/interfaces, preserve pure
   functions and single-purpose boundaries; rerun focused + affected suites.
4. **PHASE GREEN** — run the full unit/integration lanes and contract/docs gates
   named for that phase before its commit checkpoint.

Coverage is partitioned to minimize overlap and trivial assertions:

| Layer | Owns | Must not duplicate |
| --- | --- | --- |
| Pure unit | DB URL parser, manifest-shape classifier, compatibility/reason mapper, automation-event exclusion predicate | Route status mapping, SQL behavior, or DOM snapshots |
| Real-PG integration | migration candidate/status matrix, lifecycle-store closure, event idempotency/fan-out, advisory locks, graph projections | Re-test pure string helpers |
| Route contract | exact operation status/code/body and zero-side-effect boundary for each row in API matrix | Re-run the service's internal branch matrix |
| Component/DOM | typed DTO -> badge/banner/control/focus behavior and EN/RU key closure | Backend parsing or SQL |
| Playwright | one graph-only golden journey and one user-visible legacy refusal/D2-history journey | Exhaustive permutations already covered below E2E |
| Static/drift gates | dependency removal, forbidden symbol greps, OpenAPI/AsyncAPI, ERD/docs/screens/i18n parity | Behavioral assertions |

Tests that only assert a function exists, an object is truthy, or static copy is
present without exercising a decision boundary are rejected. Deleting a legacy
test is allowed only when its behavior is removed and a cut-over refusal or
graph-only replacement covers the boundary.

## Implementation Quality Contract

- Reuse one Postgres URL resolver, one graph-only manifest classifier/parser,
  one compatibility reason model, and one cut-over event predicate.
- Keep pure classification separate from IO/application. Routes, services,
  migration/read models, and UI consume the same typed outputs rather than
  re-parsing messages.
- Prefer dependency injection at existing test seams; do not add production
  abstractions solely to mock them.
- Preserve fail-fast `MaisterError` behavior and structured logs. No broad
  catch, catch-and-continue serialization, or fallback dialect/runner path.
- No input/global mutation, no untyped collections, and no new `any` unless an
  existing external boundary makes it unavoidable and the plan records why.
- Refactoring is limited to duplication/type debt exposed by this cut-over.
  Every changed line must trace to a requirement or a required green gate.

## Non-goals

- No SQLite data export/import tooling.
- No Flow `steps[]` converter, auto-republish, or compatibility package.
- No new engine features or graph gate changes.
- No removal or rename of the `steps.*` template namespace.
- No CCR/supervisor adapter changes.
- No new HTTP/SSE route, run status, domain-event kind, error code, environment
  variable, sidecar, port, or host-mounted file.
- No deletion of old `flow_revisions`/`runs` rows solely because their manifest
  is legacy.
- No broad cleanup of unrelated `any`, stale roadmap prose, or historical ADRs.

## Ground Truth Checked

- DB client: `web/lib/db/client.ts`; boot wrapper:
  `web/instrumentation.ts`; Drizzle CLI: `web/drizzle.config.ts`.
- SQLite/PG helpers: `web/lib/db/{migrate,migrate-brain,check,check-migrations,seed,select-for-update}.ts`,
  `web/lib/scheduler.ts`, `web/lib/social/relations.ts`, Brain guards and callers.
- Flow schema/validation: `web/lib/config.schema.ts`, `web/lib/config.ts`,
  `web/lib/flows/engine-version.ts`.
- Install/bootstrap: `web/lib/flows.ts`, `web/lib/packages/install.ts`,
  `web/app/api/projects/route.ts`.
- Studio/authored import: `web/lib/flows/package-authoring.ts`,
  `web/lib/catalog/authored-service.ts`, `web/app/(app)/flows/actions.ts`,
  `web/scripts/import-flow-package-draft.ts`.
- Stored revision/runtime raw casts: `web/lib/flows/lifecycle.ts`,
  `web/lib/services/runs.ts`, `web/lib/flows/graph/runner-core.ts`,
  `web/lib/flows/graph/current-node-kind.ts`, `web/lib/queries/run-manifest.ts`.
- Compatibility/picker/UI classifiers: `web/app/api/runs/launch-options/route.ts`,
  `web/lib/runs/task-launch-config.ts`, `web/lib/queries/flow-packages.ts`.
- Linear runtime: `web/lib/flows/{runner,runner-human,runner-agent,runner-cli,guards,step-runs}.ts`,
  `web/lib/flows/graph/compile.ts`, `web/lib/runs/resume-driver.ts`.
- `step_runs` readers: `web/lib/flows/context.ts`,
  `web/lib/flows/graph/run-context.ts`, `web/lib/queries/{board,board-progress,activity,inbox-context}.ts`,
  `web/lib/runs/node-status-visual.ts`.
- In-code authoring SSOT: `web/lib/flows/{flow-dsl-grammar,authoring-skill,artifact-validate,authored-complete}.ts`,
  editor manifest IO/template-variable catalog, local-package scaffold.
- Current maximums at `5916d4ea`: engine `2.2.0`, ADR-128, migration 0092;
  M41/M42 are implemented but absent from the stale roadmap tail.

## Contract Surface Trace

| Surface | Source/code | Contract/docs |
| --- | --- | --- |
| DB URL and boot | `web/lib/db/client.ts`, `web/instrumentation.ts`, `web/drizzle.config.ts`, DB CLI files | `.env.example`, `README.md`, `docs/configuration.md`, `docs/getting-started.md`, `docs/deployment.md`, `web/lib/db/README.md` |
| Database dialect/type | PG client return type, lock/select helpers, Brain guards, 28 union FIXMEs | `CLAUDE.md`, `.ai-factory/DESCRIPTION.md`, `.ai-factory/ARCHITECTURE.md`, `.ai-factory/rules/database.md`, `docs/architecture.md` |
| Flow manifest grammar | `config.schema.ts`, `config.ts`, `flow-dsl-grammar.ts`, `authoring-skill.ts` | `docs/flow-dsl.md`, `docs/configuration.md`, root/web `CLAUDE.md` |
| Engine compatibility | `engine-version.ts`, stored-revision compatibility classifier | `docs/configuration.md`, `docs/system-analytics/flows.md`, `docs/system-analytics/flow-graph.md` |
| Package/Studio intake | installer/package/bootstrap/Studio/authored/import callers | `docs/flow-installer.md`, Studio screen docs where refusal is visible |
| Runtime launch/read | launch service, lifecycle, graph runner-core/current-node, run-manifest query | `docs/system-analytics/runs.md`, `docs/system-analytics/flows.md`, run/Studio screen docs |
| D1 schema removal | `schema.ts`, migration 0094, step store/readers | `docs/database-schema.md`, `docs/db/erd.md`, `docs/db/runs-domain.md` |
| D2 upgrade transition + C2 claim closure/hold | migrations 0094/0095/0096 + C2 latest-run decision | `docs/system-analytics/runs.md`, `docs/system-analytics/task-queue.md`, `docs/system-analytics/triage.md`, `docs/system-analytics/reconciliation-gc.md`, upgrade section in `docs/deployment.md` |
| Terminal events | existing `run.failed` domain/webhook outboxes, no new event kind | audit `docs/api/async/outbound-webhooks.asyncapi.yaml`, `docs/system-analytics/outbound-webhooks.md`; update only the documented emit-site/reason semantics if exposed |
| Typed refusal | one graph-only classifier consumed through the operation-specific `FLOW_INSTALL` / `CONFIG` / cut-gate `PRECONDITION` mappings in API Contract Matrix | `docs/error-taxonomy.md`, both OpenAPI specs, route tests, and unchanged AsyncAPI wire audit |
| i18n/UI | incompatible revision badge, launch refusal, D2 reason display | `web/messages/en.json`, `web/messages/ru.json`, parity test, relevant screen refs |
| Decision/roadmap | one ADR and M43 | `docs/decisions.md`, `.ai-factory/ROADMAP.md` |

## Deployment and Upgrade Touchpoints

- No new env var, service, sidecar, port, volume, or binary.
- Existing `DB_URL` remains the only DB locator but accepts only
  `postgres://`/`postgresql://`; `.env.example` and compose files must agree.
- Audit `Dockerfile`, `compose.yml`, `compose.override.yml`, and
  `compose.production.yml`; expected code change is none because they already
  provision Postgres. Record that result in the spec rather than adding noise.
- Upgrade runbook is mandatory and ordered:
  1. audit/republish all legacy package manifests;
  2. finish or explicitly accept failure of open linear runs;
  3. back up Postgres;
  4. stop web and supervisor;
  5. run main migrations 0094, 0095, and 0096, then Brain migrations/checks;
  6. start supervisor/web and verify no legacy actionable runs/packages or
     event-bounded stale C2 claims;
  7. retain the DB backup as the only rollback path because D1 is irreversible.

## Commit Plan

- Commit 1 (Tasks 1-3): `docs: freeze postgres and graph-only cutover contract`
- Commit 2 (Tasks 4-6): `refactor(db): remove sqlite dialect support`
- Commit 3 (Tasks 7-10): `refactor(flows): enforce graph-only engine 3`
- Commit 4 (Tasks 11-13): `refactor(flows): drop legacy linear run storage`
- Commit 5 (Tasks 14-16): `docs: finalize m43 cutover contracts and verification`

## Dependency Graph

- Tasks 1 and 2 may run in parallel; Task 3 depends on both and is the Phase-0
  approval gate.
- Task 4 depends on Task 3. Task 5 depends on Task 4; Task 6 depends on Tasks 4
  and 5.
- Task 7 depends on Task 3. Task 8 depends on Task 7; Task 9 depends on Task 8;
  Task 10 depends on Tasks 7 and 8.
- Task 11 depends on Tasks 6, 7, 8, and 10. Task 12 depends on Task 11; Task 13
  depends on Tasks 9, 10, 11, and 12.
- Task 14 depends on all implementation Tasks 4-13. Task 15 depends on Task 14.
  Task 16 depends on Task 15 and is the only final rebase/renumber/release gate.
- No code task may bypass Task 3 even when its implementation could otherwise
  run in parallel: the SDD artifacts and traceability matrix are the shared
  contract.

## Tasks

### Phase 0 — Preflight, ADR, and executable contract freeze

- [x] **Task 1 — Reserve the shared numbers and freeze one cut-over ADR/spec.**
  Create `.ai-factory/specs/feature-postgres-graph-only-cutover.md`; reserve the
  `### ADR-130` header in `docs/decisions.md` after rebase number allocation; add
  exactly one ADR covering Postgres-only and graph-only as one breaking release.
  Freeze all sections required by Normative SDD Contract: D1/D2, engine 3.0.0,
  exact API matrix, manifest/status truth tables, database transaction order,
  event-consumer fan-out, UI state matrix, no-converter policy,
  upgrade/rollback order, compatibility classification, NFRs, and bidirectional
  traceability. Improve/create the exact system-analytics, ERD, API/AsyncAPI,
  and `docs/screens` artifacts listed above before code. Add M41/M42/M43 and
  verified checkbox repairs to
  `.ai-factory/ROADMAP.md`. Reserve the M43 forward migration sequence in the
  spec, not the journal yet. Files:
  `.ai-factory/specs/feature-postgres-graph-only-cutover.md`,
  `docs/decisions.md`, `.ai-factory/ROADMAP.md`, relevant Phase-0 analytics/ERDs.
  Logging: the spec defines structured boot/refusal/migration logs and redaction;
  docs code adds no runtime log. Acceptance: one ADR only; no split SQLite/Flow
  ADR; Phase-0 docs are complete per `docs/CLAUDE.md` R5/R6 and internally
  consistent; every requirement has concrete expectations and acceptance
  criteria; no blocking TBD remains; `pnpm validate:contracts`, docs validation,
  and ADR anchor validation pass.

- [x] **Task 2 — Run the owner-assisted legacy inventory and block on stragglers.**
  Audit `~/.maister/flows/*/flow.yaml`, all `flow_revisions.manifest`,
  `flows.manifest`, package-installed member manifests, current first-party
  bundles, and the external `maister-plugins` repository. Record IDs/versions,
  owning source, current project attachments, and whether each is `nodes[]` or
  `steps[]`. The owner republishes every straggler as `nodes[]` before merge;
  this branch adds no converter. Include SQL that separately lists unfinished
  legacy runs affected by D2 and completed run counts/step detail affected by
  D1. Files: Phase-0 spec and `docs/deployment.md` upgrade section only; external
  package repo changes are owner/external work. Logging: inventory commands log
  counts and identifiers at INFO, never manifest bodies/secrets; SQL is read-only.
  Acceptance: all live install/cache sources have an explicit disposition;
  merge gate blocks while an attached first-party `steps[]` package remains.

- [x] **Task 3 — Complete the acceptance/test design and run an adversarial SDD review.**
  Build the requirement -> task -> test -> acceptance matrix without committing
  intentionally failing tests. Allocate each invariant to exactly one primary
  test layer per TDD Execution Contract; enumerate edge cases including empty
  `steps`, both manifest shapes, unpinned/missing manifests, every D2 status,
  null project identity abort, duplicate event delivery, automation consumers,
  stream/non-stream launch, lifecycle pointer immutability, inaccessible UI
  controls, EN/RU/focus, and graph-only regression. Name the exact Vitest
  project/Playwright spec and focused command for every row; confirm planned
  paths match runner globs with `vitest list`. Perform separate completeness,
  internal consistency, logical-hole, migration-crash-window, API-code/status,
  analytics-state-machine, and screens-vs-UI reviews; resolve all material
  findings in the spec/plan before approval. Files: normative spec and this plan
  only. Logging: test design identifies structured fields/redaction assertions;
  no runtime log is added. Acceptance: zero orphan requirements/tests, zero
  duplicate primary ownership, zero unresolved high/medium findings, and the
  pre-existing full suite remains GREEN.

Phase 0 exit gate: spec/ADR/API/AsyncAPI/analytics/ERDs/screens agree; preflight
has no unresolved first-party straggler; the TDD matrix is complete and every
planned test is discoverable; `pnpm validate:contracts`,
`CI=true pnpm validate:docs:all`, and ADR-anchor validation pass; the full
existing unit/integration suites remain GREEN. No failing RED test is committed
at a phase boundary.

### Phase 1 — Postgres-only database and test/runtime contract

- [x] **Task 4 — Make DB construction and every DB CLI Postgres-only/fail-fast.**
  Delete `better-sqlite3`/`drizzle-orm/better-sqlite3` imports and the `file:`
  branch; give `buildClient/getDb` an explicit PG database type; simplify
  `closeDb` to `Pool.end`; require postgres URLs in `migrate`, `migrate-brain`,
  `check`, `check-migrations`, `seed`, and `drizzle.config.ts`; remove silent
  defaults/no-ops. Make `web/instrumentation.ts` rethrow CONFIG/DB initialization
  failures instead of logging “continuing boot.” Files:
  `web/lib/db/{client,migrate,migrate-brain,check,check-migrations,seed}.ts`,
  `web/drizzle.config.ts`, `web/instrumentation.ts`, DB tests. Logging: INFO
  masked URL on init; ERROR structured error code/context before fatal exit;
  never print credentials. Acceptance: missing, `file:`, mysql, and malformed
  URLs produce typed/actionable Postgres-required failure; boot cannot continue;
  `postgres://` and `postgresql://` work. TDD: RED on the pure URL table and a
  boot-level `instrumentation.register` failure (not only `buildClient`), GREEN
  with one shared resolver, REFACTOR to remove duplicate CLI prefix checks.

- [x] **Task 5 — Remove dialect gates and make Postgres semantics unconditional.**
  Delete `dbIsSqlite/dbIsPostgres/isPostgresDb`, optional `.for()` shims,
  SQLite JSON predicates, advisory-lock skips, and catch-and-continue lock
  fallbacks. Make scheduler and project-relation advisory locks unconditional;
  update row locks/JSONB paths in HITL, scratch, graph runner, readiness,
  takeover-return, external gate reporting, run/experiment services. Remove
  `isBrainProvisioned/assertBrainProvisioned` and their caller branches while
  retaining Brain-schema-applied checks. Files include
  `web/lib/db/select-for-update.ts`, `web/lib/{scheduler,social/relations}.ts`,
  `web/lib/brain/guard.ts` and callers, and the exact dialect branches found by
  the Phase-0 grep inventory. Logging: DEBUG lock acquisition with stable
  resource IDs; ERROR then throw on lock/query failure; no “unavailable —
  skipping.” Acceptance: real-PG concurrent relation/scheduler tests prove the
  lock executes; injected lock failure aborts; Brain absent-lineage behavior
  remains actionable on Postgres. TDD partitions pure lock selection from
  real-PG serialization/race behavior; no mock-only concurrency claim counts.

- [x] **Task 6 — Remove SQLite dependencies and the union-caused type debt.**
  Remove `better-sqlite3` and `@types/better-sqlite3` from `web/package.json`,
  remove `better-sqlite3` from `web/next.config.mjs`, refresh `pnpm-lock.yaml`,
  and delete only the 28-file `FIXME(any)` class caused by the pg|sqlite union,
  replacing those `any`s with the now-single PG/Drizzle types. Rewrite SQLite
  client/Brain/check tests; every DB integration suite must provision a real
  Testcontainers Postgres and set DB_URL before importing global DB callers—no
  DB_URL-based `skip`/early return. Do not add a pre-suite assertion that runs
  before per-file containers initialize. Logging: no new runtime logging beyond
  typed boundary logs; testcontainers log lifecycle at DEBUG/INFO only on
  failure. Acceptance: `pnpm --filter maister-web ls better-sqlite3` is empty;
  union FIXME grep is empty; typecheck and full unit/integration suites green.
  RED is the dependency/type/static sentinel, GREEN is lockfile/typecheck, and
  REFACTOR must not widen into unrelated Drizzle peer cleanup.

Phase 1 exit gate: DB/boot RED tests are GREEN; real-PG lock tests are GREEN;
`pnpm --filter maister-web typecheck`, full web unit and integration suites, and
`pnpm validate:contracts`/docs validation are GREEN.

### Phase 2 — Graph-only schema, intake, stored revisions, and engine

- [x] **Task 7 — Make `nodes[]` required and bump the engine to 3.0.0.**
  Delete four legacy step variants, `stepSchema`, `guardConfigSchema`, and
  legacy `pre_guards/post_guards` fields from `config.schema.ts`; require
  non-empty `nodes[]`; add a raw-object precheck that explicitly refuses a
  present `steps` key despite `.passthrough()`. Centralize parsing/classification
  so filesystem YAML and stored JSONB use the same exact message and typed
  caller-selected `CONFIG`/`FLOW_INSTALL` code. Delete the linear validation
  branch in `config.ts`; bump `MAISTER_ENGINE_VERSION` to 3.0.0; update the
  in-code Flow DSL grammar/authoring skill and drift guards. Logging: DEBUG
  `{surface, flowRefId, revision, manifestShape}`; WARN typed refusal without
  manifest content. Acceptance: `steps` only, both `steps`+`nodes`, and empty
  nodes all refuse deterministically; valid nodes packages with open-ended
  compatibility remain compatible on 3.0.0. TDD: one table-driven pure unit
  suite owns the manifest-shape/error-message matrix; route tests do not repeat
  that combinatorial table.

- [x] **Task 8 — Enforce typed refusal at every real intake and stored-revision surface.**
  Wire the shared graph-only parser into direct install, package install,
  project registration/bootstrap, Studio save/import/publish, authored hard
  gate, CLI import, lifecycle enable/rollback/upgrade preview, launch service,
  graph runner load, current-node resolution, run-manifest queries, launch
  options, task launchability, and package compatibility read models. Remove the
  legacy `steps` upgrade-diff vocabulary. Stored legacy revisions render an
  incompatible badge/reason and refuse launch without crashing the page.
  Files are the exact Ground Truth list above plus EN/RU messages and affected
  screen/read-model tests. Logging: INFO/WARN with surface, revision ID, and
  typed error code; no duplicated logs at wrapper layers. Acceptance: direct
  install/package/bootstrap/Studio/lifecycle/launch behavior matches every row
  of API Contract Matrix exactly; JSON and staged-stream launches refuse before
  the first side effect; ext launch inherits the same service refusal; no
  invented ext importer. TDD: one route-level test per changed operation asserts
  code/status/body/zero-side-effect, while service integration owns shared
  persisted-state invariants.

- [x] **Task 9 — Deliver mature refusal and historical-compatibility UI states.**
  Implement the Phase-0 screen contracts across project registration, package
  install/viewer, Studio local editor, task/board launch affordances, and stored
  revision views. Reuse a typed incompatibility reason DTO; do not string-match
  error messages. Installed legacy packages stay inspectable but cannot be
  enabled/attached/launched; local legacy YAML remains manually editable while
  canvas/commit/cut/publish are blocked; forms preserve input and focus an
  accessible alert; board cards expose the enabled-revision incompatibility next
  to a disabled launch affordance; launch-options exposes no bypassing runner
  override. Files: current package/Studio/launch components and pages named in
  the Screen Contract, `web/messages/{en,ru}.json`, focused component tests and
  one Playwright refusal journey. Logging: UI adds none; server read models log
  one structured incompatibility classification, never manifest bodies.
  Acceptance: badge/copy/control/focus/keyboard/EN-RU states match screen docs;
  generic graph packages remain usable; component tests own state rendering and
  E2E owns only the end-to-end refusal journey.

- [x] **Task 10 — Delete the linear engine, guard subsystem, and legacy editor helpers.**
  Delete the `runFlow` linear dispatch/walker, `runner-human.ts`, `guards.ts`,
  linear compiler path, legacy current-node classifier, `slash-in-existing`
  execution branch and dead cleanup/session state, plus legacy editor/artifact
  scanners/scaffold output. Keep graph human/form handling and M42 run-session
  resume. Simplify `runner-cli.ts`/`runner-agent.ts` signatures to single-purpose
  graph behavior; remove guard metric writer. Preserve `steps.*` template output
  from node attempts and keep graph gates byte-for-byte. Logging: delete
  linear-only logs; retain structured graph node/session logs; add no fallback
  dispatch log. Acceptance: no executable path can select a linear runner;
  graph human/form/CLI/AI/session tests stay green; template compatibility test
  proves `{{ steps.node_id.stdout }}` still resolves. TDD starts with focused
  graph regression and legacy-refusal tests, then removes code; it must not add
  trivial tests for deleted exports.

Phase 2 exit gate: all refusal/engine RED cases GREEN; full unit/integration
suites GREEN; route/API matrix, component refusal states, targeted Playwright,
in-code grammar drift guard, i18n parity, typecheck,
`pnpm validate:contracts`, and docs validation GREEN.

### Phase 3 — D1/D2 destructive migration, C2 claim closure, and graph-only read models

- [x] **Task 11 — Implement the 0094/0095/0096 M43 forward migration sequence.**
  Generate all migration triples, then hand-audit SQL order. In 0094's one
  transaction:
  abort on ambiguous actionable rows; materialize the exact legacy candidate
  relation from key-presence in pinned revision manifest with unpinned-flow
  fallback and `run_kind='flow'`; CAS-terminalize the eight actionable statuses;
  close open attempts/HITL/assignments with the exact DB Migration Contract
  metadata; clear ACP handles/cursors; insert exactly one domain event with
  `{reason:"legacy_steps_engine_3_cutover",source:"upgrade_cutover"}` plus the
  existing-shape webhook outbox event (`errorCode: "CONFIG"`) for each winner;
  finally `DROP TABLE step_runs`. Preserve
  terminal `runs`, workspaces, revisions, artifacts, and graph runs. Then 0095
  uses the durable D2 event ledger to clear only stale pre-D2 C2 task claims,
  preserves later claims, and emits no run/event. The shared C2 decision then
  holds a latest D2 failure without a claim/run and permits only a post-D2 human
  re-triage arm. Files: `web/lib/db/schema.ts`,
  `web/lib/db/migrations/{0094,0095,0096}_*.sql`, journal/snapshots, migration
  integration tests, shared C2 eligibility/consumer tests, shared cut-over event
  predicate and affected domain-event consumers. Logging: migration runner logs
  aggregate counts; consumers log structured skip/hold reason/event/run IDs,
  never prompts/manifests.
  Acceptance: all eight D2 statuses fail once; Done/Failed/Abandoned stay byte-
  stable; empty-steps key is selected; null/ambiguous identity aborts atomically;
  lifecycle stores close; repeated helper/redelivery emits or acts zero extra
  times; Ralph/agent/Brain/reindex do not run, cost reconcile may run, parent
  wake/dependency behavior is correct; graph/non-flow rows are unchanged; a
  pre-D2 C2 claim clears, a later claim stays, and rerunning 0095 is a no-op;
  a D2 task has no automatic claim/run and is held once, while a later human
  re-triage launches normally; slot admission for eligible graph work resumes
  after restart; both journal entries have snapshots.
  TDD: real-PG migration integration is the primary owner—RED per invariant
  cluster, GREEN SQL, REFACTOR only after the full transaction/idempotency
  matrix is green. Completion evidence: the renamed
  `migration-0094.integration.test.ts` applies 0094 and 0095 separately,
  asserts stale-claim clear, later-claim preservation, and a second-0095
  no-op. C2 poll and slot-free integration tests assert the no-launch terminal
  hold and later-retriage re-arm. These remain Testcontainers gates and must
  execute in a container-capable CI runner.

- [x] **Task 12 — Delete the step store/read-unions and mature D2 history UX.**
  Delete `web/lib/flows/step-runs.ts` and schema/type exports. Remove step-run
  joins/unions from board, progress, activity, inbox context, Flow context,
  graph run context, node-status visuals, and resume driver. Derive every live
  progress/context/status value from `node_attempts`; remove legacy-only
  `Skipped` only where no graph consumer uses it. Add one typed D2 reason lookup
  from the existing domain-event ledger and render the persistent Failed banner,
  timestamp, retained history/evidence/worktree links, and absence of
  Recover/Resume/Respond/Promote/retry controls required by the screen contract.
  Logging: DEBUG
  read-model counts/source=`node_attempts`; WARN only on actual query failure;
  never silently return legacy fallback data. Acceptance: graph progress,
  activity, inbox context, resume, and run context match before/after semantics;
  D2 reason is visible and accessible without adding a `runs` column; terminal
  controls cannot act through another surface; run list/inspector/detail agree;
  no `step_runs` reference exists outside migration/ADR history. TDD partitions
  the query integration from component control/banner tests and one seeded E2E
  history check.

- [x] **Task 13 — Migrate the fixture/test surface and delete linear-only tests.**
  Change `build-flow-plugin.ts`, DB seeds, E2E seed, local-package scaffold, and
  generic test manifests to minimal valid nodes graphs. Delete tests whose sole
  contract is linear execution/on_reject/guard/slash-in-existing/step-run
  persistence; replace them with focused negative cut-over tests. Retain
  `templating.test.ts` and editor variable-catalog assertions for the `steps.*`
  namespace, now fed by node attempts. Use Appendix A as the mandatory per-file
  assertion migration inventory; Phase 0 must classify every candidate
  `rewrite`, `delete-linear`, `retain-template`, or `negative-refusal` before
  editing. Logging: fixtures add none; integration failures print fixture path
  and typed code, not full manifests. Acceptance: no positive legacy manifest
  fixture remains; no test is deleted without a mapped removed requirement or
  graph/refusal replacement; duplicate/trivial tests identified in the TDD
  matrix are consolidated; all promised tests are listed by Vitest/Playwright
  and full suites are GREEN.

Phase 3 exit gate: 0094/0095/0096 migration tests run against real Postgres; journal
integrity, snapshots, event-consumer fan-out, stale-claim predicate, full
unit/integration suites, D2 UI and targeted E2E are GREEN;
`pnpm validate:contracts`, docs/screens validation, and D1/D2/C2 manual SQL
checks match the upgrade runbook.

### Phase 4 — Current-state docs, renumber/rebase, and release gates

- [x] **Task 14 — Flip all normative/current-state contracts to as-built.**
  Update current-state docs and in-code SSOTs listed in Contract Surface Trace;
  remove legacy DSL examples, dialect-switch promises, SQLite Brain no-op text,
  and stale `step_runs` ERD/table references. Keep one concise cut-over/migration
  note pointing to ADR-130 instead of duplicating rationale. Flip the SDD spec,
  analytics and screens from Designed to Implemented only after their acceptance
  rows are green. Update every API Contract Matrix operation by `operationId`,
  external `extLaunchRun`, internal domain-event analytics, EN/RU messages, and
  screen refs; record AsyncAPI as audited-unchanged and preserve intentional
  differences (`502 FLOW_INSTALL`, `422
  CONFIG`, `409 PRECONDITION`, `400 CONFIG`). Logging: documentation describes
  exact structured events/levels; no code-only report task. Acceptance: code,
  SQL/snapshot, SDD, ADR, API/AsyncAPI, analytics, ERDs, screens and messages all
  describe the same current state; R5/R6 structure holds;
  Mermaid/contracts/i18n/ADR-anchor validators pass.

- [x] **Task 15 — Prove completeness, consistency, and spec conformance.**
  Re-read the normative spec and all changed code/tests/contracts without using
  the implementation diff as the only checklist. For every requirement and
  acceptance criterion, record concrete evidence (source symbol/SQL statement,
  test name/command, API operation, analytics section, screen state). Run six
  explicit audits: scope/fullness, bidirectional traceability, internal
  consistency, logical holes/crash windows, negative-space/forbidden survivors,
  and UX/API/DB cross-surface parity. Verify all edge-case rows, no hidden
  `steps[]`/SQLite fallback, no automatic D2 run/retry (the one terminal C2
  hold is explicit), no orphan controls, and no test that passes on the wrong
  error branch. Fix findings in their owner task; do not create a summary-only
  workaround. Files: plan/spec checklists and any owner artifact requiring
  correction. Logging: audit commands emit counts and file/symbol IDs only.
  Acceptance: every matrix row is evidenced, zero unverified acceptance
  criterion, zero unresolved material finding, zero “implemented by assertion”
  docs claim, and all suites/gates remain green.

- [x] **Task 16 — Rebase, resolve global numbers, and run release verification.**
  Rebase onto current `main`; recompute maximum ADR and migration journal idx;
  renumber ADR-130/0094/0095/0096 and every prose/anchor/snapshot reference if
  contested; verify M43 remains next unused milestone. Run a refute-the-cut-over review for
  hidden dialect branches, raw JSONB casts, old manifest entry points, lifecycle
  partial states, template namespace regression, and test files not discovered
  by runners. Logging: verification commands produce concise counts; no secrets.
  Acceptance: all gates below pass from a clean tree; no merge commit or AI
  trailer; integration into main is a separate owner-approved implementation
  action, not part of planning.

  Verification note: rebase allocated ADR-129 and migration 0093 to `main`'s MCP
  management work; M43 was renumbered to ADR-130 and migrations 0094/0095/0096. Source, focused
  behavior, contracts, docs, i18n, discovery, typecheck, lint, and Drizzle gates
  pass. Full listener/container/browser gates were executed and are recorded in
  the spec's as-built verification section as environment-blocked (`listen
  EPERM` / no container runtime), for rerun in the normal CI environment.

## Final Verification Gates

### Review remediation (2026-07-11)

- [x] Route every stored-manifest read surface through a typed graph-only
  boundary; restore pinned-revision authority and isolate watchdog anomalies.
- [x] Reconcile admin install, authored publish, launch options, graph/status/
  transcript and upgrade-preview API contracts with exact refusal semantics.
- [x] Disable incompatible package controls, preserve package-wide Studio
  blocking, focus typed alerts, and render cut-over timing in run history.
- [x] Make the 0094/0095/0096 migration sequence idempotent, discriminate pinned vs
  cache manifests, exclude non-flow runs, close only event-bounded stale C2
  claims, and add deletion-sensitive consumer tests.
- [x] Reconcile current docs, ADR supersession/indexing, HITL analytics,
  positive fixtures, Drizzle snapshots, and graph-only authoring vocabulary.
- [x] Run the complete verification gates below and record environment-qualified
  results without converting unavailable infrastructure into a passing claim.

- `pnpm install --frozen-lockfile`
- `pnpm --filter maister-web typecheck`
- `pnpm --filter maister-web test:unit`
- `pnpm --filter maister-web test:integration` (real Testcontainers Postgres)
- `pnpm --filter @maister/supervisor test:unit`
- `pnpm --filter @maister/supervisor test:integration`
- `pnpm --filter maister-web test:e2e`
- `pnpm validate:contracts`
- `CI=true pnpm validate:docs:all`
- `pnpm validate:docs:adr:all`
- `pnpm --filter maister-web exec vitest list --project unit` and
  `--project integration` include every planned test path
- existing i18n parity test and migration journal/order/snapshot integrity tests
- `git --no-pager diff --check`
- `pnpm --filter maister-web ls better-sqlite3` returns no package
- the frozen forbidden-symbol audit for
  `better-sqlite3|drizzleSqlite|dbIsSqlite|dbIsPostgres|file:./dev.db|step_runs|stepRuns|pre_guards|post_guards`
  matches only its explicit allow-list: migration 0094/0095/0096 metadata/test, locked
  negative refusal/boot tests, ADR/spec/plan history; no production/current-doc
  hit is allowed
- `rg -n 'FIXME\(any\): getDb\(\) returns a pg\|sqlite drizzle union' web`
  returns no hit
- positive manifest fixtures contain `nodes:` only; `steps:` survives only in
  negative cut-over inputs and documentation of the preserved `steps.*`
  template namespace
- real-PG relation-cycle and scheduler concurrency tests prove advisory locks
  execute and failures propagate
- boot smoke: missing DB_URL and `file:./dev.db` exit non-zero with CONFIG;
  Postgres boot/migrate/check/seed/Brain-migrate path succeeds
- package matrix: every current first-party nodes package installs and launches
  unchanged on engine 3.0.0; stored legacy revision shows incompatible and
  refuses launch without a page crash
- requirement/spec/task/test/acceptance traceability is complete in both
  directions; the completeness/consistency/logical-hole audit has zero open
  material finding

## Appendix A — Existing test/fixture assertion migration inventory

Every file below currently contains a `steps:` manifest/fixture or an explicit
legacy-step assertion. Task 13 must classify and disposition every path; do not
bulk replace the two legitimate `steps.*` template-namespace test families.

### API and route integration tests

`web/app/api/admin/webhooks/__tests__/route.integration.test.ts`,
`web/app/api/assignments/[assignmentId]/claim/__tests__/route.integration.test.ts`,
`web/app/api/assignments/[assignmentId]/release/__tests__/route.integration.test.ts`,
`web/app/api/projects/[slug]/assignments/__tests__/route.integration.test.ts`,
`web/app/api/projects/[slug]/flow-runner-remaps/__tests__/route.test.ts`,
`web/app/api/projects/[slug]/flows/[flowId]/version-binding/__tests__/route.integration.test.ts`,
`web/app/api/projects/[slug]/tasks/[number]/__tests__/social-routes.integration.test.ts`,
`web/app/api/projects/[slug]/tasks/__tests__/route.integration.test.ts`,
`web/app/api/projects/[slug]/webhooks/__tests__/route.integration.test.ts`,
`web/app/api/runs/[runId]/abandon/__tests__/abandon-capability-cleanup.integration.test.ts`,
`web/app/api/runs/[runId]/abandon/__tests__/abandon.integration.test.ts`,
`web/app/api/runs/[runId]/graph-status/__tests__/route.test.ts`,
`web/app/api/runs/[runId]/graph/__tests__/route.test.ts`,
`web/app/api/v1/ext/hitl/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/projects/[slug]/flows/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/projects/[slug]/tasks/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/runs/[runId]/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/runs/[runId]/gates/[gateId]/report/__tests__/route-atomicity.integration.test.ts`,
`web/app/api/v1/ext/runs/[runId]/gates/[gateId]/report/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/runs/[runId]/hitl/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/runs/[runId]/readiness/__tests__/route.integration.test.ts`,
`web/app/api/v1/ext/runs/__tests__/route.integration.test.ts`.

### Core config, DB, flow, runtime, and query tests

`web/lib/__tests__/config.schema.test.ts`, `web/lib/__tests__/config.test.ts`,
`web/lib/__tests__/foundation.integration.test.ts`,
`web/lib/__tests__/reconcile-sweep.integration.test.ts`,
`web/lib/__tests__/scheduler-crash-promote.integration.test.ts`,
`web/lib/__tests__/scheduler.integration.test.ts`,
`web/lib/assignments/__tests__/assignments.integration.test.ts`,
`web/lib/db/__tests__/artifacts-schema.integration.test.ts`,
`web/lib/db/__tests__/migration-0041.integration.test.ts`,
`web/lib/db/__tests__/schema.integration.test.ts`,
`web/lib/db/__tests__/webhooks-schema.integration.test.ts`,
`web/lib/domain-events/__tests__/emit-sites.integration.test.ts`,
`web/lib/domain-events/__tests__/emit-terminal.integration.test.ts`,
`web/lib/flows/__tests__/artifact-validate.test.ts`,
`web/lib/flows/__tests__/compile-artifacts.test.ts`,
`web/lib/flows/__tests__/crash-resume.integration.test.ts`,
`web/lib/flows/__tests__/digest.test.ts`,
`web/lib/flows/__tests__/runner-agent-hooks.test.ts`,
`web/lib/flows/__tests__/runner-agent.test.ts`,
`web/lib/flows/__tests__/runner-cli.test.ts`,
`web/lib/flows/__tests__/runner-default-artifacts.integration.test.ts`,
`web/lib/flows/__tests__/runner-human.test.ts`,
`web/lib/flows/__tests__/runner-onreject.integration.test.ts`,
`web/lib/flows/__tests__/runner-reentry.test.ts`,
`web/lib/flows/__tests__/runner-terminal.test.ts`,
`web/lib/flows/__tests__/runner.integration.test.ts`,
`web/lib/flows/__tests__/templating.test.ts`,
`web/lib/flows/editor/__tests__/manifest-io.test.ts`,
`web/lib/flows/editor/__tests__/template-variable-catalog.test.ts`,
`web/lib/flows/graph/__tests__/artifact-store.integration.test.ts`,
`web/lib/flows/graph/__tests__/compile-calibration.test.ts`,
`web/lib/flows/graph/__tests__/compile.test.ts`,
`web/lib/flows/graph/__tests__/dirty-protocol.integration.test.ts`,
`web/lib/flows/graph/__tests__/gate-store-atomicity.integration.test.ts`,
`web/lib/flows/graph/__tests__/runner-core.test.ts`,
`web/lib/flows/graph/__tests__/workspace-policy.integration.test.ts`,
`web/lib/flows/graph/consensus/__tests__/runtime.test.ts`,
`web/lib/gc/__tests__/revision-gc.integration.test.ts`,
`web/lib/gc/__tests__/workspace-gc.integration.test.ts`,
`web/lib/queries/__tests__/flow-graph-view.test.ts`,
`web/lib/queries/__tests__/flow-package-detail.integration.test.ts`,
`web/lib/queries/__tests__/inbox-context.integration.test.ts`,
`web/lib/queries/__tests__/observatory.integration.test.ts`,
`web/lib/queries/__tests__/package-bom.test.ts`,
`web/lib/queries/__tests__/portfolio-inbox.integration.test.ts`,
`web/lib/queries/__tests__/portfolio.integration.test.ts`,
`web/lib/queries/__tests__/readiness-overridden-skipped.integration.test.ts`,
`web/lib/queries/packages-bom.test.ts`,
`web/lib/runs/__tests__/dirty-resolution-race.integration.test.ts`,
`web/lib/runs/__tests__/resume-driver.test.ts`,
`web/lib/runs/__tests__/state-transitions-crash.integration.test.ts`,
`web/lib/runs/__tests__/state-transitions.integration.test.ts`,
`web/lib/scheduler/handlers/__tests__/auto-launch-paused.integration.test.ts`,
`web/lib/services/__tests__/gate-chat.integration.test.ts`,
`web/lib/services/__tests__/triage.integration.test.ts`,
`web/lib/social/__tests__/social-domain.integration.test.ts`,
`web/lib/webhooks/__tests__/delivery.integration.test.ts`,
`web/lib/webhooks/__tests__/emit-gate.integration.test.ts`,
`web/lib/webhooks/__tests__/emit-hitl.integration.test.ts`,
`web/lib/webhooks/__tests__/emit-run-status.integration.test.ts`,
`web/lib/webhooks/__tests__/outbox.integration.test.ts`,
`web/lib/webhooks/__tests__/replay.integration.test.ts`,
`web/lib/webhooks/__tests__/retention.integration.test.ts`,
`web/lib/webhooks/__tests__/subscriptions-delete-race.integration.test.ts`,
`web/lib/workbench-lifecycle/__tests__/lifecycle-claim.integration.test.ts`.

### Packages, Studio, scratch, and E2E tests/fixtures

`web/lib/__tests__/_fixtures/build-flow-plugin.ts`,
`web/lib/local-packages/__tests__/bom.test.ts`,
`web/lib/local-packages/__tests__/diff-commit-discard.integration.test.ts`,
`web/lib/local-packages/__tests__/fork-cut.integration.test.ts`,
`web/lib/local-packages/__tests__/rename-artifact.test.ts`,
`web/lib/local-packages/__tests__/validate.test.ts`,
`web/lib/local-packages/__tests__/version-adopt.integration.test.ts`,
`web/lib/packages/__tests__/attach.integration.test.ts`,
`web/lib/packages/__tests__/catalog.integration.test.ts`,
`web/lib/packages/__tests__/install.integration.test.ts`,
`web/lib/packages/__tests__/install.test.ts`,
`web/lib/scratch-runs/__tests__/local-package-assistant.integration.test.ts`,
`web/lib/studio/flow-assistant/__tests__/actions.test.ts`,
`web/e2e/_seed/seed-e2e.ts`, `web/e2e/active-workspaces.spec.ts`,
`web/e2e/flow-package-viewer.spec.ts`,
`web/e2e/flow-studio-artifacts.spec.ts`, `web/e2e/flows-authoring.spec.ts`,
`web/e2e/studio-package-viewer.spec.ts`.

## Next Step

Review this plan, especially the locked D2 migration transaction and the
owner-assisted Phase-0 straggler gate. Start implementation with `$aif-implement`.
