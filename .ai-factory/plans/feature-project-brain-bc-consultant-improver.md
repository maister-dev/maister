# Implementation Plan: Project Brain B/C - Consultant Tier and Improvement Bridge

> **For agentic workers:** REQUIRED IMPLEMENTATION STYLE: SDD first, then strict
> TDD. Do not start production code until Phase 0 contract artifacts are
> complete and validator-clean. Each behavior task must go RED -> GREEN ->
> refactor, with the RED command, GREEN command, and refactor check recorded in
> the task notes before moving to the next task.

**Goal:** Deliver Project Brain Sub-project B (read-only Consultant/indexed tier)
and Sub-project C (self-improvement proposal bridge) without weakening the
canonical-source boundary: indexed sources remain pointers to truth, while all
write-back enters the M25 authored catalog or the normal task/run/promotion
machine.

**Architecture:** Extend ADR-122's in-app Postgres + pgvector bounded context.
Use brain-lineage migrations only (`0003` for B, `0004` for C), keep
`web/lib/brain/*` as the domain boundary, reuse project git-file browsing for
canonical pointers, reuse the external operations/MCP facade for agent access,
reuse M25 authored catalog drafts for rule/skill/flow proposals, and reuse
board tasks plus the existing triage/auto-launch machinery for docs-as-code
projection. Sub-project B is read-only over repo/catalog sources. Sub-project C
owns all proposal/write-back behavior.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Drizzle raw-SQL brain
lineage, Postgres 16 + pgvector, HeroUI/Tailwind, vitest unit/integration,
Playwright E2E, `docs/` OpenAPI/AsyncAPI/Mermaid contracts, external
`maister-plugins` core package for the improver platform agent.

Branch: planned `feature/project-brain-bc-consultant-improver` (plan written
from detached `main` worktree)
Created: 2026-07-03
Primary anchors:
- `docs/plans/2026-07-01-project-brain-architecture.md`
- `docs/system-analytics/project-brain.md`
- ADR-122 in `docs/decisions.md`
- Attachment: Planning Request - Project Brain, Sub-projects B and C - FINAL

## Settings
- Testing: yes. Implementation is strict TDD. Prefer high-signal integration,
  smoke, and E2E tests over trivial unit tests; use unit tests for pure
  chunkers, DTO transforms, ranker policy, and schema reducers.
- Logging: verbose during implementation. Use structured pino fields in server
  code. Do not add client `console.*`. Pure helpers and render-only components
  must not log.
- Docs: yes. Phase 0 is a mandatory docs/contracts checkpoint; no production
  code until docs/spec/contracts are internally consistent.

## Roadmap Linkage
Milestone: "none in current roadmap"
Rationale: Current `.ai-factory/ROADMAP.md` does not yet carry a dedicated
Project Brain B/C milestone. This plan links instead to the Vision "Knowledge"
axis, ADR-122, and the Project Brain design spec. Add a roadmap entry only when
implementation starts and the owner chooses the milestone slot.

## SDD/TDD Protocol
- Phase 0 is SDD-only: ADR stubs, as-built docs, ERD, OpenAPI diffs, screens
  cards, migration design, traceability matrix, and three self-check passes.
- The Phase 0 exit gate is: `pnpm validate:docs`, Redocly lint for changed
  OpenAPI files, AsyncAPI validation for changed AsyncAPI files, and a recorded
  completeness/consistency/logical-holes pass.
- Every code task starts by writing the smallest meaningful failing test. Record
  the expected RED failure in the task notes. Implement only enough to pass.
  Refactor only after GREEN.
- Tests must cover required behavior and edge cases with minimum overlap. Do
  not add assertion-only tests that repeat type checking or merely render text.
- API contracts, DB migrations, and system analytics change only where required
  by the acceptance criteria. In this plan they are required and are first-class
  deliverables.
- Implementation must satisfy the accepted specs exactly, follow project
  conventions, and keep boundaries simple: SOLID where service boundaries exist,
  KISS for every task slice, DRY for shared policy/DTO/schema logic, and no
  speculative abstractions.
- A task is not complete until its specs, implementation, tests, docs, and
  recorded acceptance criteria agree with each other.

## Ground Truth Confirmed
- `HEAD`, `main`, and `origin/main` currently point at `e27bd51d` with ADR-122
  and Sub-project A present.
- Brain lineage is separate at `web/lib/db/brain-migrations/`, journal table
  `__drizzle_brain_migrations`, with entries `0001_brain_foundation` and
  `0002_brain_review_fixes`.
- Main migration journal currently ends at `0088_mixed_hercules` in this
  checkout. Target for this plan is zero main-lineage migrations unless Phase 0
  proves a shared ALTER is unavoidable.
- Current `brain_items.kind` supports only `lesson|observation|state_fact`.
  `decision|direction` are not implemented.
- Current `brain_embeddings` is item-only: `item_id NOT NULL` plus
  `brain_embeddings_generation_uq(item_id, split_ordinal, embedding_model,
  embedding_dimensions)`.
- Current `brain_index_jobs.reason` supports only `model_switch|manual`.
  `source_id`, `event`, and `chunker_upgrade` are not implemented.
- Current explicit recall returns owned item content and snapshots
  `returned_items: [{itemId, score}]`. It does not yet carry `tier`, `chunkId`,
  or canonical `pointer`.
- Current MCP facade registers `TOOL_SPECS` statically. SQLite/disabled Brain
  must fail closed at route/service/tool execution time; do not rely on dynamic
  tool disappearance.
- Current external token scopes already include `memory:read` and
  `memory:write`; `web/lib/tokens/ext-handler.ts` maps them to `readBrain` and
  `writeBrain`. The default contract for B/C is to reuse those scopes. Add a
  new proposal-specific scope only if Phase 0 explicitly changes the auth
  model and updates token issuance, route auth, OpenAPI, and MCP tests together.
- Current `agent_project_links` has only `can_read_brain` and
  `can_write_brain` axes. Treat the schema comment about `can_propose_brain` as
  a design hint, not a current contract, until Phase 0 decides whether FR-C6 is
  satisfied by `can_write_brain` or needs a separate main-lineage ALTER.
- Existing file-viewer plumbing is reusable: project repo files use
  `web/app/api/projects/[slug]/files/route.ts`, `RepoFilesPanel`,
  `readRepoFiles`, and `web/lib/worktree.ts` `listTree`/`readBlob`.
- Current Brain UI exists only as Admin Brain settings, project Brain toggle,
  and agent-link read/write axes. There is no `docs/screens/*` card for a
  Brain page or Brain settings block yet.
- Current ADR max visible on this checkout is ADR-125. The pasted request says
  ADR-124 and ADR-126 are reserved by parallel work; Phase 0 must re-check main
  before writing ADR-B/C numbers.

## Non-goals
- No package-extensible chunkers/connectors in this slice. The registry shape
  must be extension-ready, but E-9 enforcement applies when package-delivered
  chunkers ship.
- No LSP edge connector in C v1. Serena ships as an optional platform MCP
  catalog entry only.
- No `auto_publish`.
- No direct repo writes from Brain services.
- No ext rate limiting until multi-tenant middleware exists.
- No new `domain_events` kinds.
- No RU stemming/indexing config change.
- No separate DB or PG schema for Brain.

## Contract Surface Trace
| Surface | Change | Spec/document that must move |
| --- | --- | --- |
| Brain DB schema | Yes: brain migration `0003`, `0004`; no main migration unless Phase 0 proves a shared ALTER is unavoidable. A separate `can_propose_brain` axis is not assumed; FR-C6 defaults to existing `can_write_brain`. | `web/lib/db/brain-migrations/*`, `web/lib/brain/schema.ts`, `docs/db/brain-domain.md`, `docs/db/erd.md`, `docs/database-schema.md`; main Drizzle lineage only if Phase 0 records the reason |
| Token scopes/authz | No new scope expected. `memory_clusters` uses `memory:read` + `can_read_brain`; `memory_propose` uses `memory:write` + `can_write_brain`. If Phase 0 introduces a new scope, update issuance and handlers atomically. | `web/types/token-scopes.ts`, `web/lib/tokens/ext-handler.ts`, `web/lib/authz.ts`, OpenAPI security docs, ext/MCP auth tests |
| External operations HTTP | Yes: recall response extension, `GET /api/v1/ext/projects/{slug}/memory/clusters`, `POST /api/v1/ext/projects/{slug}/memory/proposals`; source/reindex/proposal ops only if Phase 0 marks them external-facing. | `docs/api/external/operations.openapi.yaml`, `docs/system-analytics/external-operations.md` |
| Web HTTP | Yes: Project Brain page data, source CRUD/reindex, proposal review, project settings Brain config, admin autonomy defaults if UI-backed by routes. Every route must resolve slug to project server-side and use the same auth-first pattern as current project routes. | `docs/api/web.openapi.yaml`, `docs/system-analytics/project-brain.md`, screen docs |
| MCP facade | Yes: `memory_recall` shape extension, new `memory_clusters`, `memory_propose`; update `TOOL_SPECS`, `TOOL_OP`, dispatch routing, and the external OpenAPI mirror together. | `mcp/src/tools.ts`, `mcp/src/__tests__/tool-contract.test.ts`, `mcp/src/__tests__/tools.test.ts`, external OpenAPI mirror |
| AsyncAPI/SSE | No new events expected | Re-check `docs/api/async/*`; leave unchanged unless a route/event is added |
| Error taxonomy | No new `MaisterError` code expected | Use existing `CONFIG`, `PRECONDITION`, `UNAUTHORIZED`, `CONFLICT`, `EMBEDDING_UNAVAILABLE` |
| System analytics | Yes, canonical before code | `docs/system-analytics/project-brain.md`, `docs/system-analytics/external-operations.md`, `docs/system-analytics/mcp-management.md` for Serena note |
| Screens | Yes | New `docs/screens/projects/project-brain.md`, new `docs/screens/projects/project-settings-brain.md`, admin Brain settings card update/new `docs/screens/settings-brain.md`, `docs/screens/README.md` index |
| i18n | Yes | `web/messages/en.json`, `web/messages/ru.json` |
| Package deps | Yes, parser/chunker libraries and possibly contract validators | `web/package.json`, `pnpm-lock.yaml`; deployment docs only if runtime image needs new system binary or env |
| Deployment | Maybe | `.env.example`, compose files, Dockerfile only if Phase 0 adds env vars, sidecars, ports, or host-mounted files. Parser npm deps alone need no compose change. |
| External repo | Yes | `maister-plugins` core package improver agent definition, version bump, tag, MAIster package-source discovery notes |

## Traceability Matrix
| FR | Spec anchors | Owning tasks | Required tests |
| --- | --- | --- | --- |
| FR-B1 schema | D2, D4, E-1, E-2, spec sec.4 | T1.1, T1.2 | `indexed-schema.integration.test.ts`, `check-brain-migrations.test.ts` |
| FR-B2 ChunkerRegistry | D5, D6, E-9 disposition, spec sec.7 | T2.1, T2.2 | `chunker-registry.test.ts`, fixture snapshots |
| FR-B3 sources/selection | D7, sec.3.2 | T3.1, T3.2, T14.1 | `sources.integration.test.ts`, project Brain UI E2E |
| FR-B4 incremental indexing | E-7, E-8, sec.5.2 | T3.2, T4.1 | `indexer.integration.test.ts`, recovery test |
| FR-B5 cross-tier recall/pointers/ambient | D9, E-12, E-13, sec.5.3 | T5.1, T5.2 | `recall.integration.test.ts`, ext memory route test, MCP contract test, `ambient.integration.test.ts` |
| FR-B6 decision/direction home-resolution | D7, sec.3.1, sec.3.2, E-13 | T6.1 | `home-resolution.integration.test.ts`, ext retain route test |
| FR-B7 state_fact supersede | sec.3.1 expectation | T6.2 | `retain.integration.test.ts` race case |
| FR-B8 edges/re-anchor | D10, E-14 | T7.1 | `edges.integration.test.ts`, re-anchor chunker-version test |
| FR-C1 proposals table/FSM | E-5, sec.4, sec.5.4 | T9.1, T11.1 | `proposals.integration.test.ts` |
| FR-C2 improver platform agent | D8, ADR-111, sec.5.4, sec.14-C | T10.1, T10.2 | `clusters.integration.test.ts`, scripted agent-path test, maister-plugins package smoke |
| FR-C3 review surface/accept path | E-5, M25 authored catalog | T11.1, T12.1 | proposal review route tests, UI E2E |
| FR-C4 autonomy dial | D8 | T12.1 | autonomy reducer tests, proposal integration |
| FR-C5 docs projection via task | D7, D8, E-5, sec.3.2 | T12.2 | task creation integration, auto-launch tick integration |
| FR-C6 memory_propose | E-5, agent write-half | T10.1 | ext route authz tests, MCP dispatch tests |
| FR-C7 Serena seed | D6, sec.8 trust | T13.1 | MCP catalog seed integration, projection test |
| AC-Docs | docs contract, R5/R6/R7, screen template | T0.2, T14.1 | docs validators, OpenAPI/AsyncAPI validators |
| Edge cases sec.8 | pasted request sec.8 | T2-T14 | one owning test per row in Edge-Case Ownership |

## Commit Plan
- Commit 1 (Phase 0): `docs(brain): freeze consultant and improver SDD`
- Commit 2 (Tasks T1-T2): `feat(brain): add indexed-tier schema and chunkers`
- Commit 3 (Tasks T3-T4): `feat(brain): index canonical project sources`
- Commit 4 (Tasks T5-T7): `feat(brain): recall indexed pointers and reanchor edges`
- Commit 5 (Tasks T9-T10): `feat(brain): add proposal and improver operations`
- Commit 6 (Tasks T11-T12): `feat(brain): review proposals and project docs through tasks`
- Commit 7 (Tasks T13-T14): `feat(brain): add brain UI and serena catalog seed`
- Commit 8 (Task T15): `test(brain): complete acceptance gates`

## Tasks

### Phase 0 - SDD, Contracts, and Numbering

- [x] **T0.1 - Preflight prerequisite and collision audit.**
  - Verify the P7 marker regression fix from the pasted prerequisite is landed
    on `main` before starting Sub-project B. Specifically inspect
    `web/lib/flows/graph/runner-graph.ts` and `web/lib/flows/graph/run-context.ts`
    for the marker/explanation split and run-context tests.
  - Run `git worktree list --porcelain` and `git status --short --branch`.
    Identify in-flight branches touching `runner-graph.ts`, Brain migrations,
    `docs/decisions.md`, and OpenAPI docs.
  - Re-check ADR numbers from `main` with
    `git --no-pager show main:docs/decisions.md | rg "^### ADR-" | tail`.
    Do not assume this checkout's ADR-125 max is final. Tentative allocation:
    ADR-B and ADR-C use the next two free numbers after parallel reservations.
  - Re-check brain migration journal from `main`; reserve brain `0003` for B
    and `0004` for C. Re-check main migration journal; assert zero main DDL is
    still viable.
  - Audit current token/auth contracts before adding any route: confirm
    `memory:read -> readBrain`, `memory:write -> writeBrain`, current
    `agent_project_links` axes, and whether the `can_propose_brain` comment is
    intentionally deferred or promoted to schema work.
  - Audit current platform MCP trust semantics before the Serena task: confirm
    whether `enabled=false` plus `trust_status='untrusted'` is sufficient for a
    visible but non-materialized catalog row, or document the needed trust-gate
    change before implementation.
  - Acceptance: a short preflight note is added to this plan or the Phase 0
    spec with current HEAD, ADR allocation, brain migration allocation, main
    migration disposition, token-scope disposition, Serena trust disposition,
    and rebase order around the `runner-graph.ts` collision.
  - Logging requirements: no runtime logging.
  - Files: this plan or `.ai-factory/specs/project-brain-bc-preflight.md`.
  - Verify: `git --no-pager diff --check`.

- [x] **T0.2 - RED-free SDD traceability freeze.**
  - Update/create the SDD artifact that implementation treats as the SSOT for
    B/C. Keep `docs/plans/2026-07-01-project-brain-architecture.md` as the
    design source; add B/C as-built pins only where the old phasing text still
    says projection/LSP belongs in B/C contrary to the owner-approved split.
  - Add a traceability section matching this plan: anchor -> FR -> task -> test
    -> code path. Every D1-D10, E-1..E-14, and sec.14-B/sec.14-C acceptance
    item must be either in-scope with an FR or explicitly deferred/non-goal.
  - Record the three self-check passes:
    1. Completeness: anchors <-> FRs <-> tasks <-> tests are complete.
    2. Consistency: chunk shape, recall DTO, snapshots, MCP/ext responses,
       and docs use the same fields.
    3. Logical holes: every edge case in this plan has an owning test and
       concurrency decision.
  - Acceptance: no FR lacks an anchor; no in-scope anchor lacks a task/test; E-9
    package-extensible chunkers and the LSP edge connector are explicitly
    deferred.
  - Logging requirements: no runtime logging.
  - Files: `docs/plans/2026-07-01-project-brain-architecture.md`, this plan.
  - Verify: `pnpm validate:docs`.

- [x] **T0.3 - Contract-first docs and ADRs before code.**
  - Add ADR-B for the Consultant/indexed tier: schema, full built-in chunker
    lineup, source selection, pointers, home-resolution, state_fact supersede,
    edges/re-anchor, ambient tier-mix.
  - Add ADR-C for the self-improvement bridge: `brain_proposals`, improver as a
    platform agent, `memory_clusters`, `memory_propose`, autonomy dial,
    projection-via-task, Serena seed.
  - Update `docs/system-analytics/project-brain.md` from "Sub-project A only"
    to an as-built-compatible A+B+C domain doc with R5 sections, exact state
    machines, process flows, expectations, edge cases, and R6 status tags.
  - Update DB docs: `docs/db/brain-domain.md`, `docs/db/erd.md`,
    `docs/database-schema.md`.
  - Update API contracts before code:
    - `docs/api/external/operations.openapi.yaml`: recall response extension,
      `GET /api/v1/ext/projects/{slug}/memory/clusters`,
      `POST /api/v1/ext/projects/{slug}/memory/proposals`, source/reindex/
      proposal ops if they are external-facing, and explicit oneOf/enum shapes
      for owned item hits versus indexed chunk hits.
    - `docs/api/web.openapi.yaml`: Brain page queries, source CRUD/reindex,
      proposal review and conclusion routes, settings Brain fields, admin
      autonomy defaults if route-backed, plus security/action notes for each
      route.
  - Update `docs/system-analytics/external-operations.md` with MCP/ext parity.
  - Add an authz matrix to the SDD docs: route/tool -> token scope -> project
    action -> agent-link axis when applicable. Include `readBrain`,
    `writeBrain`, `readRepoFiles`, `editSettings`, `manageCatalog`, and task
    projection actions `createTask`/`editTask`.
  - Add screen docs: `docs/screens/projects/project-brain.md`,
    `docs/screens/projects/project-settings-brain.md`, and
    `docs/screens/settings-brain.md` or the existing admin settings card.
    Update `docs/screens/README.md`.
  - Acceptance: docs state B is read-only and C owns all write-back; docs state
    "ext rate limiting deferred until multi-tenant"; docs use the same recall
    item shape as the API/MCP contracts.
  - Logging requirements: no runtime logging.
  - Files: docs listed above.
  - Verify: `pnpm validate:docs`; Redocly lint for changed OpenAPI files;
    AsyncAPI CLI only if an AsyncAPI file changes.

- [x] **T0.4 - Contract validator tooling gate.**
  - If Redocly/AsyncAPI CLIs are not reliably available in the implementation
    environment, add a minimal root `validate:contracts` script and dev
    dependencies instead of relying on ad-hoc global tools. Keep package
    installs project-local.
  - Acceptance: implementation has one documented command set for docs +
    OpenAPI + AsyncAPI validation. If no AsyncAPI files change, record that
    AsyncAPI validation is a no-op for this plan.
  - Logging requirements: no runtime logging.
  - Files: `package.json`, `pnpm-lock.yaml` only if local validator tooling is
    added; otherwise no file change.
  - Verify: `pnpm validate:docs`; contract validator command from the task note.

### Phase 1 - Indexed-Tier Schema and Chunkers (Sub-project B Foundation)

- [x] **T1.1 - RED: indexed schema integration tests.**
  - Add failing testcontainer coverage for brain migration `0003`.
  - Assert `brain_sources`, `brain_chunks`, `brain_edges`,
    `brain_project_config`, and the altered `brain_embeddings`/`brain_items`/
    `brain_index_jobs` shapes.
  - Assert every new `brain_*` row carries `project_id` directly or through a
    NOT NULL FK chain; project delete cascades sources, chunks, edges, config,
    chunk embeddings, and index jobs.
  - Assert `brain_embeddings` enforces exactly one of `item_id` or `chunk_id`
    and the generation unique works for both item and chunk arms.
  - Assert SQLite still fails through `assertBrainProvisioned`.
  - Expected RED: tables/columns/checks do not exist.
  - Logging requirements: test-only, no runtime logging.
  - Files: `web/lib/brain/__tests__/indexed-schema.integration.test.ts`,
    `web/lib/db/__tests__/check-brain-migrations.test.ts`.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/indexed-schema.integration.test.ts`.
  - RED evidence: sandboxed run failed before test execution because
    Testcontainers could not see a container runtime; escalated rerun reached the
    schema and failed on missing `brain_sources` / `brain_chunks` / 0003 columns:
    `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/indexed-schema.integration.test.ts`.

- [x] **T1.2 - GREEN: brain migration 0003 and schema mirror.**
  - Add hand-authored `web/lib/db/brain-migrations/0003_brain_indexed_tier.sql`
    and update `web/lib/db/brain-migrations/meta/_journal.json`.
  - Create `brain_sources` with source kind, path/glob metadata, `source_hash`,
    `chunker_id`, `chunker_version`, `enabled`, `last_indexed_at`,
    `last_error`, timestamps, and project FK cascade.
  - Create `brain_chunks` with closed chunk shape:
    `{source_id, project_id, stable_id, kind, title, path, symbol, content,
    metadata, source_range, content_hash, tsv}`. Include unique source/stable
    guard and GIN `tsv`.
  - Create `brain_edges` with `project_id`, `from_ref`, `to_ref`, relation
    enum, confidence, `degraded`, timestamps, and project FK cascade.
  - Create `brain_project_config` with `project_id` PK, `home_resolution` jsonb,
    `projection_flow_id`, and future-safe policy jsonb fields only if Phase 0
    specs them.
  - Alter `brain_items` to include `decision|direction` kinds and `source_ref`
    canonical pointer jsonb. Keep `lesson|observation` reinforce semantics.
  - Alter `brain_embeddings`: add nullable `chunk_id` FK cascade,
    `chunker_id`, `chunker_version`; relax `item_id`; add exactly-one-of check;
    replace generation unique so item and chunk arms are both idempotent.
  - Alter `brain_index_jobs`: add `source_id` nullable FK, extend reason to
    `event|chunker_upgrade`.
  - Update `web/lib/brain/schema.ts` mirror. The SQL lineage remains source of
    truth.
  - Acceptance: T1.1 turns GREEN; no main-lineage migration added unless T0.1
    recorded the unavoidable reason.
  - Logging requirements: migration/schema mirror, no runtime logging.
  - Files: brain migration SQL, brain journal, `web/lib/brain/schema.ts`.
  - Verify GREEN: T1.1 command; `pnpm --filter maister-web typecheck`.
  - GREEN evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/indexed-schema.integration.test.ts`
    passed; `CI=true pnpm --filter maister-web typecheck` passed;
    `CI=true pnpm --filter maister-web exec vitest run --project unit lib/db/__tests__/check-brain-migrations.test.ts`
    passed.

- [x] **T2.1 - RED: ChunkerRegistry and fixture corpus tests.**
  - Add fixture corpus with one real file per source kind:
    TS code, Python code, markdown, HTML, OpenAPI, AsyncAPI, SQL, `flow.yaml`,
    `maister-package.yaml`, `agent.md`, plus malformed/oversized/binary samples.
  - Add pure tests for `ChunkerRegistry`:
    - chunk shape is exactly `{kind,title,path,symbol?,content,metadata,
      source_range,stable_id}`.
    - stable IDs are stable across identical re-chunks.
    - HTML normalizes to markdown and uses `chunker_id=markdown`.
    - fallback chunker handles unknown text but records the fallback chunker id.
    - parser errors are typed and source-scoped, not process crashes.
  - Expected RED: registry and chunkers do not exist.
  - Logging requirements: pure chunkers do not log; indexer records parser
    errors later.
  - Files: `web/lib/brain/__fixtures__/sources/*`,
    `web/lib/brain/__tests__/chunker-registry.test.ts`.
  - Verify RED: `pnpm --filter maister-web exec vitest run --project unit lib/brain/__tests__/chunker-registry.test.ts`.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project unit lib/brain/__tests__/chunker-registry.test.ts`
    failed because `@/lib/brain/chunkers/registry` did not exist.

- [x] **T2.2 - GREEN: built-in ChunkerRegistry and parser dependencies.**
  - Add project-local npm dependencies after verifying ESM/Node 24 compatibility
    by inspecting installed package docs/source. Candidate libraries:
    `code-chunk`, unified/remark/rehype pipeline, OpenAPI parser,
    `@asyncapi/parser`, SQL parser, `gray-matter`, and a recursive fallback
    splitter. Use the exact packages chosen in Phase 0; do not guess APIs.
  - Implement `web/lib/brain/chunkers/types.ts`, `registry.ts`, and one module
    per built-in chunker. Keep slicers thin and pure.
  - Support full built-in lineup from the request: TS/JS/Py/Rust/Go/Java code,
    markdown, HTML-to-markdown, OpenAPI operation, AsyncAPI channel/operation,
    SQL statement, flow/package YAML, agent markdown/frontmatter, fallback text.
  - Acceptance: T2.1 turns GREEN; `pnpm-lock.yaml` reflects dependencies; no
    runtime env/compose change needed unless a parser requires a native binary.
  - Logging requirements: no logging in chunkers; return typed errors to caller.
  - Files: `web/lib/brain/chunkers/*`, `web/package.json`, `pnpm-lock.yaml`.
  - Verify GREEN: T2.1 command; `pnpm --filter maister-web typecheck`.
  - GREEN evidence: `CI=true pnpm --filter maister-web exec vitest run --project unit lib/brain/__tests__/chunker-registry.test.ts`
    passed; `CI=true pnpm --filter maister-web typecheck` passed.

### Phase 2 - Sources, Index Jobs, and Event-Driven Reindexing

- [x] **T3.1 - RED: source registration and git HEAD reading tests.**
  - Add integration tests for per-project source registration, suggested
    defaults, kind autodetect, and server-derived repo/default-branch reads.
  - Assert file reads use the project row's `repo_path` and `main_branch`, never
    a body-controlled path or worktree path.
  - Assert no source registration can read `.git`, ignored/untracked files, or a
    path outside `repoRelPathSchema`.
  - Expected RED: source service/routes do not exist.
  - Logging requirements: source service logs source id, project id, kind, path,
    and redacted error class at DEBUG/WARN.
  - Files: `web/lib/brain/__tests__/sources.integration.test.ts`,
    route tests under `web/app/api/projects/[slug]/brain/sources/__tests__/`.
  - Verify RED: targeted integration command recorded in task notes.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/sources.integration.test.ts`
    failed because `@/lib/brain/sources` did not exist; `CI=true pnpm --filter maister-web exec vitest run --project unit 'app/api/projects/[slug]/brain/sources/__tests__/routes.test.ts'`
    failed because the source route module did not exist.

- [x] **T3.2 - GREEN: sources service, routes, and defaults.**
  - Implement `web/lib/brain/sources.ts` and any git reader wrapper needed over
    `web/lib/worktree.ts` to read tracked blobs from the default branch.
  - Implement project routes for listing/adding/updating/removing sources and
    manual per-source/index-all actions. Use auth-first routing: session
    required before body parse, slug resolved server-side, then
    `requireProjectAction(projectId, "readBrain")` for source metadata reads
    and `requireProjectAction(projectId, "editSettings")` for source mutation
    or reindex requests.
  - Do not expose repository file content through Brain source routes. Any
    source preview or pointer opening must delegate to the existing project
    files API/viewer and therefore pass the `readRepoFiles` gate as well as
    repo-relative path validation.
  - Seed suggested defaults on first setup: `docs/**/*.md`, ADR/roadmap files,
    `docs/api/*.yaml`, `maister.yaml`, plus explicit user-added globs.
  - Acceptance: T3.1 turns GREEN; identifiers section in the plan/spec labels
    URL slug as `url-param`, project id as `server-state`, body path/glob as
    validated body input with allow-list checks.
  - Logging requirements: structured logs for create/update/delete/reindex with
    `{projectId, sourceId, kind, path, reason}`; no secret/path disclosure beyond
    validated repo-relative paths.
  - Files: `web/lib/brain/sources.ts`,
    `web/app/api/projects/[slug]/brain/sources/*`, OpenAPI docs.
  - Verify GREEN: targeted tests; `pnpm --filter maister-web typecheck`.
  - GREEN evidence: `CI=true pnpm --filter maister-web exec vitest run --project unit 'app/api/projects/[slug]/brain/sources/__tests__/routes.test.ts'`
    passed; `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/sources.integration.test.ts`
    passed; `CI=true pnpm --filter maister-web typecheck` passed.

- [x] **T4.1 - RED: indexer, source_hash no-op, and recovery tests.**
  - Add integration tests for:
    - first index inserts chunks and chunk embeddings.
    - unchanged `source_hash` reindex is a no-op.
    - source change re-embeds only changed chunks.
    - interrupted job resumes from the missing-worklist.
    - deterministic malformed source marks `brain_sources.last_error` and
      continues other sources.
    - vanished source path marks a documented terminal source state and retires
      chunks/embeddings per Phase 0 decision.
    - embedding-provider outage mid-index leaves the job retryable/running and
      reuses A's `EMBEDDING_UNAVAILABLE` handling.
  - Expected RED: indexer/service behavior absent.
  - Logging requirements: test target expects WARN with `{projectId, sourceId,
    jobId, stage, errorCode}` for deterministic per-source errors.
  - Files: `web/lib/brain/__tests__/indexer.integration.test.ts`.
  - Verify RED: targeted integration command recorded in task notes.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/indexer.integration.test.ts`
    failed because source-scoped jobs did not write chunks, source hashes, source errors, or retryable embedding outage state.

- [x] **T4.2 - GREEN: resumable source indexer and domain-event trigger consumer.**
  - Implement `web/lib/brain/indexer.ts` with source_hash gating,
    chunker-version gating, per-source error isolation, resumable worklist, and
    chunk embedding insertion into immutable current generation rows.
  - Extend `brain_index_jobs` worker/reconcile path for source jobs without
    regressing A's model-switch item reindex.
  - Add `brain_index_triggers` domain-event consumer for run-terminal/promotion
    kinds decided in Phase 0. Do not add new domain-event kinds. Do not use
    `fs.watch`, `chokidar`, or polling.
  - Acceptance: T4.1 turns GREEN; brain-disabled projects skipped; external
    edits without domain events are documented as manual reindex only.
  - Logging requirements: DEBUG for job claim/progress, INFO for completion,
    WARN for source-level parser/index failures, ERROR only for unrecoverable
    job failure. Always include `{projectId, jobId, sourceId?, reason}`.
  - Files: `web/lib/brain/indexer.ts`, `web/lib/brain/reindex.ts`,
    domain-event registration files, scheduler/tick integration where needed.
  - Verify GREEN: targeted tests; `pnpm --filter maister-web typecheck`.
  - GREEN evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/indexer.integration.test.ts`
    passed; `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/sources.integration.test.ts`
    passed; `CI=true pnpm --filter maister-web exec vitest run --project unit 'app/api/projects/[slug]/brain/sources/__tests__/routes.test.ts'`
    passed; `CI=true pnpm --filter maister-web typecheck` passed.

### Phase 3 - Cross-tier Recall, Pointers, Home Resolution, and Edges

- [x] **T5.1 - RED: cross-tier recall DTO and contract tests.**
  - Add tests proving `recall` returns a shared union shape:
    - owned hit: `{tier:"owned", itemId, content, confidence, score, provenance}`
    - indexed hit: `{tier:"indexed", chunkId, pointer:{sourcePath,
      sourceRange, stableId}, preview, confidence, score}`
  - Update ext route tests and MCP contract tests to expect `tier`, `pointer`,
    `chunkId`, capped previews, and snapshots with chunk entries.
  - Add index-usage assertion under `SET LOCAL enable_seqscan=off` for the chunk
    vector/lexical legs.
  - Expected RED: recall ranker and API shape are owned-only.
  - Logging requirements: recall route logs only errors via existing route
    patterns; no query text in logs.
  - Files: `web/lib/brain/__tests__/recall.integration.test.ts`,
    `web/app/api/v1/ext/projects/[slug]/memory/__tests__/route.integration.test.ts`,
    `mcp/src/__tests__/tool-contract.test.ts`,
    `mcp/src/__tests__/tools.test.ts`.
  - Verify RED: targeted unit/integration/MCP test commands.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/recall.integration.test.ts`
    failed because recall returned only owned items and no `tier`/indexed pointer; `CI=true pnpm --filter maister-web exec vitest run --project integration 'app/api/v1/ext/projects/[slug]/memory/__tests__/route.integration.test.ts'`
    failed because ext recall returned no indexed hit; `CI=true pnpm --filter @maister/mcp exec vitest run src/__tests__/tools.test.ts`
    passed, proving MCP passthrough already preserves enriched REST fields.

- [x] **T5.2 - GREEN: cross-tier RecallRanker and ambient tier-mix.**
  - Extend `web/lib/brain/recall-ranker.ts`, `recall.ts`, and DTO types to rank
    items union chunks over active embedding generation plus lexical fallback.
  - Add `web/lib/brain/policy.ts` constants for ambient tier mix: owned priority
    for all K=5 slots, indexed fills remaining slots only, max 2, dedicated
    relevance threshold, preview cap around 400 chars, one-constant rollback to
    owned-only.
  - Update explicit ext memory route and MCP `memory_recall`.
  - Update `brain_snapshots.returned_items` writer/readers to record
    `{tier,itemId?,chunkId?,score,pointer?}` while preserving old rows if any
    exist.
  - Update P7 ambient projection and `web/lib/flows/graph/run-context.ts` types
    so the marker/explanation split remains intact.
  - Acceptance: T5.1 turns GREEN; with >=5 relevant owned items ambient injects
    zero indexed chunks; with 4 owned it injects at most 1-2 indexed above
    threshold; no LLM call at read.
  - Logging requirements: ambient best-effort path may WARN once per degraded
    recall with `{projectId, runId, reason}` and must not log query content.
  - Files: `web/lib/brain/recall*.ts`, `web/lib/brain/ambient.ts`,
    `web/lib/brain/policy.ts`, ext route, MCP tools, run-context types, docs.
  - Verify GREEN: targeted tests; `pnpm --filter maister-web typecheck`.
  - GREEN evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/recall.integration.test.ts`
    passed; `CI=true pnpm --filter maister-web exec vitest run --project integration 'app/api/v1/ext/projects/[slug]/memory/__tests__/route.integration.test.ts'`
    passed; `CI=true pnpm --filter @maister/mcp exec vitest run src/__tests__/tools.test.ts`
    passed; `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/ambient.integration.test.ts`
    passed; `CI=true pnpm --filter maister-web typecheck` passed.

- [x] **T6.1 - RED/GREEN: decision/direction home-resolution and retain refusal.**
  - RED: add integration tests for docs-as-code and no-docs projects:
    - registered ADR/roadmap sources make `decision`/`direction` indexed-tier.
    - project without a covering source allows owned-tier retain.
    - after registering a covering source, `memory_retain(kind=decision)` fails
      `CONFIG` naming the canonical source and proposal path.
  - GREEN: implement home resolution in `brain_project_config`,
    `web/lib/brain/home-resolution.ts`, retain validation, ext route schemas,
    MCP schemas, and project settings save/reconcile.
  - Acceptance: read/write Brain axes stay separate; read never grants retain or
    propose; `lesson`/`observation` behavior unchanged.
  - Logging requirements: structured WARN on refused retain with `{projectId,
    kind, sourceId}`; do not log content.
  - Files: `web/lib/brain/home-resolution.ts`, `web/lib/brain/retain.ts`,
    ext route, MCP tools, project settings route/UI docs.
  - Verify: targeted integration tests; `pnpm --filter maister-web typecheck`.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/retain.integration.test.ts`
    failed because canonical `decision`/`direction` retained as owned items;
    `CI=true pnpm --filter maister-web exec vitest run --project integration 'app/api/v1/ext/projects/[slug]/memory/__tests__/route.integration.test.ts'`
    failed because the ext schema rejected `decision` before home resolution;
    `CI=true pnpm --filter @maister/mcp exec vitest run src/__tests__/tools.test.ts`
    failed because MCP kind enums omitted `decision`/`direction`;
    `CI=true pnpm --filter maister-web exec vitest run --project integration 'app/api/projects/[slug]/settings/__tests__/brain-enable-gate.integration.test.ts'`
    failed because project settings could not save `homeResolution`.
  - GREEN evidence: the same four targeted commands passed after adding
    `web/lib/brain/home-resolution.ts`, retain pre-embedding refusal, ext/MCP
    enum parity, and project-settings `homeResolution` upsert/clear support.

- [x] **T6.2 - RED/GREEN: state_fact supersede-on-change writer.**
  - RED: extend retain integration tests:
    - identical `state_fact` content_hash is no-op.
    - near-duplicate changed hash supersedes exactly one active prior row and
      inserts a new active row.
    - race with decay/reinforce is serialized by the existing advisory lock and
      the second write compares against the new active row.
    - `lesson` near-dup still reinforces as A does today.
  - GREEN: implement state_fact-specific supersede path inside retain without
    changing lesson/observation semantics.
  - Acceptance: status transitions are allow-listed; superseded rows excluded
    from recall.
  - Logging requirements: DEBUG on supersede with `{projectId, oldItemId,
    newItemId}`; no content.
  - Files: `web/lib/brain/retain.ts`, tests, docs.
  - Verify: targeted retain integration test.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/retain.integration.test.ts`
    failed because changed near `state_fact` retained as a reinforcement and
    left the prior fact active.
  - GREEN evidence: the same retain integration command passed after changing
    the same-kind near path so `state_fact` inserts a fresh active row and marks
    the prior active row `superseded`, while lesson/observation reinforcement
    behavior stayed green. Docs drift was fixed in
    `docs/system-analytics/project-brain.md`, `docs/db/brain-domain.md`, and
    `docs/api/external/operations.openapi.yaml`.

- [x] **T7.1 - RED/GREEN: edges and re-anchor.**
  - RED: add tests for derived_from/references edge creation from retain
    provenance to source chunks, chunker-version bump re-chunk, symbol/path
    re-map, removed-symbol degraded edge, and count preservation.
  - GREEN: implement `web/lib/brain/edges.ts` and re-anchor logic in the indexer.
    Store `degraded=true` for unmappable edges. No traversal API in B.
  - Add item-detail edge display data for the Brain page only.
  - Acceptance: edges are never silently dropped; degraded state appears in UI
    and docs; no cross-project edge target is allowed.
  - Logging requirements: INFO summary after re-anchor with `{projectId,
    sourceId, remapped, degraded}`.
  - Files: `web/lib/brain/edges.ts`, `web/lib/brain/indexer.ts`, Brain page data
    queries, docs.
  - Verify: targeted integration tests.
  - RED evidence: `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/edges.integration.test.ts`
    failed because `@/lib/brain/edges` did not exist.
  - GREEN evidence: the new edge suite passed after adding
    `web/lib/brain/edges.ts`, retain-derived `source_ref`/`derived_from` edge
    creation, chunk ref metadata, and source re-anchor/remap/degrade behavior.
    `CI=true pnpm --filter maister-web exec vitest run --project integration lib/brain/__tests__/indexer.integration.test.ts`
    and the retain integration suite also passed after wiring re-anchor into
    the source indexer. Docs drift was fixed in system analytics and DB docs.

### Phase 4 - Proposal Bridge, Improver, and Projection (Sub-project C)

- [ ] **T9.1 - RED/GREEN: brain_proposals schema and FSM.**
  - RED: integration tests for brain migration `0004` and proposal FSM:
    `pending -> accepted -> applied`, `pending -> rejected`; invalid
    transitions rejected; project delete cascades; evidence ids remain allowed
    even after evidence expires.
  - GREEN: add brain migration `0004_brain_proposals.sql`, journal entry,
    schema mirror, `web/lib/brain/proposals.ts`, and status transition helpers.
  - Include `kind(rule|skill|flow|adr|roadmap|state)`, `evidence_item_ids`,
    `draft`, `status`, `blast_radius`, `autonomy_decision`, `cluster_hash`,
    polymorphic actor fields, resolution fields, and link fields for authored
    draft/task/run as Phase 0 specifies.
  - Acceptance: Brain never publishes and never writes repo files directly.
  - Logging requirements: INFO on proposal create/conclude with `{projectId,
    proposalId, kind, status, actorType}`; no draft body in logs.
  - Files: brain migration `0004`, journal, `web/lib/brain/schema.ts`,
    `web/lib/brain/proposals.ts`, docs.
  - Verify: targeted integration test; `pnpm --filter maister-web typecheck`.

- [ ] **T10.1 - RED/GREEN: memory_clusters and memory_propose operations.**
  - RED: tests for `memory_clusters` returning recurring lesson clusters
    computed server-side from embedding proximity plus shared provenance, gated
    by `memory:read` and `can_read_brain`.
  - RED: tests for `memory_propose` gated by `memory:write` and
    `can_write_brain`, closed proposal kinds, invalid kind -> `CONFIG`, duplicate
    `cluster_hash` -> idempotent no-op, no `cluster_hash` duplicate behavior per
    Phase 0 decision.
  - RED: contract tests prove `memory_propose` is unavailable with
    `memory:read` only, `memory_clusters` is unavailable with write-only tokens,
    and disabled/SQLite Brain fails closed even though MCP tools remain listed.
  - GREEN: implement `web/lib/brain/clusters.ts`, ext routes, MCP tool specs,
    OpenAPI mirrors, and dispatch mappings. Update `mcp/src/tools.ts`
    `TOOL_SPECS`, the `TOOL_OP` OpenAPI mirror map, and `resolveRouting`
    together.
  - Default routes:
    `GET /api/v1/ext/projects/[slug]/memory/clusters` and
    `POST /api/v1/ext/projects/[slug]/memory/proposals`. Add a new token scope
    only if T0.1 changes the contract; otherwise preserve existing
    `memory:read`/`memory:write` issuance.
  - Acceptance: server computes clusters; the improver agent judges and drafts;
    web tier does not add bespoke LLM plumbing for this path.
  - Logging requirements: DEBUG cluster query summary with `{projectId, kinds,
    clusterCount}`; INFO proposal submit with ids only; never log evidence text.
  - Files: `web/lib/brain/clusters.ts`, ext routes, `mcp/src/tools.ts`,
    tests, OpenAPI docs.
  - Verify: targeted route/MCP tests; `pnpm --filter maister-web typecheck`.

- [ ] **T10.2 - RED/GREEN: improver platform agent package.**
  - In the external `maister-plugins` repo, add the core-package improver agent
    definition following the triager precedent.
  - Config must match ADR-111 exactly: `min_recurrence` default 3, `kinds`,
    `max_proposals_per_run` default 3. Agent: workspace `none`, mode `session`,
    risk tier `read_only`, triggers `[cron, manual]`, default weekly schedule.
  - Add a scripted session test path in MAIster: seed >=3 recurring lessons with
    shared provenance -> `memory_clusters` -> agent path -> one pending proposal;
    second improver run no-ops by `cluster_hash`.
  - Acceptance: brain-disabled project launch/ops refused; live-agent quality is
    a dogfood checklist, not CI.
  - Logging requirements: package-side agent prompt has no logging; MAIster
    operations log only ids/counts.
  - Files: external `maister-plugins` package files, package version/tag notes,
    MAIster tests/docs that reference the package.
  - Verify: maister-plugins package validation; MAIster scripted integration.

- [ ] **T11.1 - RED/GREEN: proposal review surface and authored draft accept path.**
  - RED: route/service tests:
    - accept rule/skill/flow proposal creates an M25 authored DRAFT and links it.
    - publishing remains untouched.
    - reject records reason.
    - machine actor cannot accept/reject.
    - stale/non-pending proposal conclusion is refused by allow-list.
    - accepting catalog-affecting proposals requires both human session access
      to the project and `manageCatalog`; a member who can write Brain but
      cannot manage catalog is refused.
    - accepting docs/state projection proposals requires the projection task
      action chosen in Phase 0, so Brain write access alone cannot create
      board tasks.
  - GREEN: implement proposal review routes/services and reuse existing M25
    authored catalog APIs/services rather than duplicating draft storage. Call
    the existing route-auth/service layer where practical so proposal accept
    has the same RBAC as manual authored-catalog creation.
  - Acceptance: conclusion is human-actored unless the autonomy dial explicitly
    chooses auto_draft; `auto_publish` is absent from schema and codebase.
  - Logging requirements: INFO on accept/reject with `{projectId, proposalId,
    kind, resolvedBy}`; no draft body.
  - Files: `web/lib/brain/proposals.ts`,
    `web/app/api/projects/[slug]/brain/proposals/*`, authored catalog service
    integration, docs.
  - Verify: targeted integration tests.

- [ ] **T12.1 - RED/GREEN: autonomy dial defaults and auto_draft.**
  - RED: tests prove all defaults are manual; `auto_draft` for `(rule, low)`
    turns an improver proposal into an authored draft without human accept and
    leaves it unpublished; `auto_publish` is rejected by config/schema grep.
  - GREEN: implement autonomy config in `brain_project_config` or the C
    migration's chosen table, plus admin/project UI controls from Phase 0.
  - Acceptance: accept/reject counters recorded per kind/blast radius for
    graduation evidence.
  - Logging requirements: INFO on auto decision with `{projectId, kind,
    blastRadius, decision}`; no proposal body.
  - Files: config schema/service, admin/project settings UI, messages, docs.
  - Verify: targeted unit/integration tests; i18n parity.

- [ ] **T12.2 - RED/GREEN: docs-as-code projection via board task.**
  - RED: tests:
    - accepting ADR/roadmap/state outside autonomy zone creates a board task
      with drafted file path/content and no repo write.
    - inside zone with `projection_flow_id` set, task carries triage verdict and
      `launch_mode='auto'`; auto-launch tick launches it.
    - with `projection_flow_id` unset, task enters normal triage intake.
    - projection run failure follows standard task 1:N behavior; proposal stays
      applied and link shows failed attempt.
  - GREEN: implement projection service by composing existing task create,
    triage, and auto-launch mechanics. Do not add a Brain repo writer.
  - Acceptance: task/run/promotion machine is the only path to repo content.
  - Logging requirements: INFO with `{projectId, proposalId, taskId,
    launchMode}`; no file content in logs.
  - Files: `web/lib/brain/projection.ts`, tasks/triage service integration,
    proposal routes, docs.
  - Verify: targeted integration tests with mock adapter where launch occurs.

### Phase 5 - UI/UX, Serena Seed, and Final Acceptance

- [ ] **T13.1 - RED/GREEN: Serena platform MCP catalog seed.**
  - RED: tests for an idempotent seed that creates a visible platform MCP
    catalog row for `serena` and does not grant execution by default.
  - RED: projection/materialization tests prove the default seeded Serena row is
    not returned as an executable project capability until the explicit
    admin/project trust path is completed.
  - GREEN: implement a boot/admin ensure path mirroring the default package
    source insert-only pattern. Seed only the catalog shape after Phase 0
    verifies the exact Serena command/args. Do not enable project materialization
    automatically.
  - Existing schema has `platform_mcp_servers.trust_status`, not a standalone
    `exec_trust` column. The implementation must preserve "no executable trust
    by default" using the current trust/materialization model. Prefer
    `enabled=false` with `trust_status='untrusted'` if `enabled` is what drives
    projection; if product visibility requires `enabled=true`, add the trust
    gate before seeding.
  - Acceptance: row is visible out of the box; stdio execution remains an
    explicit admin/project act; seed is idempotent; Brain tables are untouched.
  - Logging requirements: INFO on seed ensure with `{id:"serena", created,
    skipped}`; no secrets.
  - Files: MCP seed service/tests, docs/system-analytics/mcp-management.md,
    docs/api/web.openapi.yaml if a new route/script is added.
  - Verify: MCP catalog integration/projection tests.

- [ ] **T14.1 - RED/GREEN: Project Brain page and settings blocks.**
  - RED: component/route/E2E tests for:
    - Project Brain page Memory search with tier badges, confidence, canonical
      pointer links opening the existing file viewer at path/range.
    - Sources tab with path, kind, chunker, status, last indexed, error,
      per-source reindex and index-all icon actions.
    - Proposals tab with pending badge, evidence links, draft diff, accept and
      reject with reason.
    - Project Settings Brain block: A enablement, per-kind home-resolution,
      projection flow picker.
    - Admin Brain settings: A embedding/distill settings plus autonomy defaults.
    - EN/RU parity and no horizontal page scroll.
  - GREEN: implement UI under existing app shell patterns. Use view-only tables
    plus popup edits; icon+label for clear commands; green-check glyph states;
    existing file viewer rather than a parallel viewer.
  - Acceptance: screens docs match actual routes/components; viewer/member/admin
    auth matches route gates; source pointer links use the existing file viewer
    and do not duplicate file content in Brain APIs; no cards nested inside
    cards; no in-app explainer text describing how UI works.
  - Logging requirements: client components do not log; server data loaders use
    structured WARN/ERROR only on failures.
  - Files: `web/app/(app)/projects/[slug]/brain/*`, components under
    `web/components/brain/*`, settings components, routes, messages, screen docs.
  - Verify: targeted unit/E2E tests; `pnpm --filter maister-web typecheck`.

- [ ] **T15.1 - Full acceptance, edge-case, and consistency gate.**
  - Run every AC from the pasted request and record evidence:
    - AC-B1 through AC-B7
    - AC-C1 through AC-C7
    - AC-Docs
  - Run consistency checks:
    - chunk shape identical across registry, DB, recall DTO, MCP/ext contracts,
      docs, and snapshots.
    - recall response identical across MCP tool, ext route, ambient P7
      projection, and snapshots.
    - route/authz matrix identical across OpenAPI docs, route handlers,
      token-scope handlers, MCP dispatch tests, and screen docs.
    - every new route follows auth-first body handling and server-side slug to
      project resolution.
    - Brain routes never bypass the existing `readRepoFiles` gate for source
      file content or pointer opening.
    - improver config knobs match ADR-111 declaration exactly.
    - Serena seed remains non-executable by default under the current
      `platform_mcp_servers` trust/materialization model.
    - no `auto_publish` string in schema/code except non-goal docs.
    - no direct repo write from `web/lib/brain/*`.
  - Run the validation suite:
    - `git --no-pager diff --check main...HEAD`
    - `pnpm --filter maister-web typecheck`
    - `pnpm validate:docs`
    - contract validator command from T0.4
    - targeted Brain unit/integration suites
    - targeted MCP facade tests
    - targeted Playwright Brain E2E
    - broader `pnpm --filter maister-web test:unit` and
      `pnpm --filter maister-web test:integration` unless a known unrelated
      flake is explicitly quarantined by the owner.
  - Acceptance: all required tests green; any pre-existing unrelated flake is
    isolated with a named follow-up and not used to hide Brain regressions.
  - Logging requirements: no code changes unless acceptance exposes a defect.
  - Files: acceptance note in this plan or `.ai-factory/specs/project-brain-bc-acceptance.md`.
  - Verify: commands above.

## Edge-Case Ownership
| Edge case | Owning test/task |
| --- | --- |
| Binary/oversized source skipped with recorded reason, no crash | T4.1 |
| Malformed chunker input sets `last_error`, job continues | T4.1 |
| Source path vanished from HEAD | T4.1, terminal-state decision in T0.2 |
| HTML->markdown source range maps to markdown intermediate | T2.1/T2.2 docs and snapshot |
| Embedding outage mid-index leaves retryable job | T4.1 |
| Supersede vs reinforce race | T6.2 |
| Improver evidence expires mid-run | T9.1/T10.2 |
| Proposal accepted after evidence expires | T9.1/T11.1 |
| Duplicate `memory_propose` without `cluster_hash` | T10.1 Phase 0 decision and test |
| Projection task run fails | T12.2 |
| Project deleted cascades every new table | T1.1/T9.1 |
| SQLite mode routes/services/tools fail closed | T1.1/T5.1/T10.1 |
| MCP tools listed but execution fails closed | T5.1/T10.1 |
| Reindex vs retain race | T4.1/T5.1 |
| Chunker-version bump re-anchor with degraded edges | T7.1 |
| Machine actor tries accept/reject | T11.1 |
| Serena seed repeated across boots | T13.1 |

## Phase Exit Gates
- **Phase 0 exit:** docs/contracts validator-clean, ADR/migration numbers
  allocated, traceability matrix complete, three self-check passes recorded.
- **Phase 1 exit:** brain `0003` migration and chunkers GREEN; no main-lineage
  DDL; fixture corpus committed.
- **Phase 2 exit:** sources/indexer jobs GREEN, source_hash no-op and recovery
  covered, no watch/polling.
- **Phase 3 exit:** cross-tier recall, ambient tier-mix, home-resolution,
  supersede, edges/re-anchor GREEN and contract-clean.
- **Phase 4 exit:** proposals, improver ops, autonomy, and projection transport
  GREEN; maister-plugins deliverable packaged/tagged or explicitly blocked.
- **Phase 5 exit:** UI/UX and Serena seed GREEN, full acceptance suite recorded,
  consistency/logical-holes checks pass.

## Implementation Handoff Notes
- Start implementation only after reviewing this plan against the latest `main`.
- If branch work starts from a detached worktree, create/switch to a real branch
  before code: `feature/project-brain-bc-consultant-improver`.
- If parallel branches have claimed ADR/migration numbers after this plan was
  written, renumber before code and before docs anchors are cited.
- Keep B and C trust boundaries separate in commits and reviews. If a B task
  starts writing to repo/catalog state, stop and move that behavior to C.
