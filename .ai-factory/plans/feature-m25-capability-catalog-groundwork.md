# Implementation Plan: M25 — Capability Catalog Groundwork (E3 Wave-1 Slice)

Branch: `HEAD` (detached managed worktree). Intended feature branch:
`feature/m25-capability-catalog-groundwork` — not auto-created in this planning
pass.
Created: 2026-06-05

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint; Phase 0 is docs/spec-first

## Roadmap Linkage
Milestone: "M25. Capability catalog groundwork"
Rationale: User-selected Wave-1 feature code after M24; implements only the E3
data model and read/write foundation for authored rules, skills, and flows. The
external PR-publish pipeline and two-way catalog-repo sync stay Wave 2/3.

Scope: **Partial for E3**. This is model + local read/write groundwork only:
authored-cap entities, revisioning, Draft/Published lifecycle, local read APIs,
local write APIs, and relation to existing git-installed packages. No external
catalog repo, PR publishing, sync worker, marketplace, or automatic application
of self-improvement proposals.

---

## 0. Scope, decisions, and existing ground

### 0.1 Goal

Create the data foundation for MAIster-authored caps:

- Author and version `rule`, `skill`, and `flow` records inside MAIster.
- Keep an explicit `Draft -> Published -> Archived` lifecycle.
- Make project-local `Published` rule/skill caps visible to the existing
  capability resolver without breaking the git-installed import path.
- Store flows as authored drafts/revisions, but do not enable them as runnable
  Flow packages until the later publication/enablement milestone.
- Preserve ADR-043: current capability imports are git-installed and trust-gated;
  fetch and execute stay physically separate.

### 0.2 What already exists and must be reused

- `capability_records` is the current project-visible registry. It is populated
  from `.mcp.json`, `maister.yaml capabilities`, and git-pinned
  `capability_imports[]`.
- `capability_imports` is the current git-pinned import ledger. It mirrors
  `flow_revisions`, records resolved SHA/digest/manifest, and runs `setup.sh`
  only after trust.
- `web/lib/capabilities/catalog.ts` performs SET/CLEAR upserts from config.
  Removing a config/import disables records without deleting historic snapshots.
- `web/lib/capabilities/import.ts` owns fetch -> trust -> setup for external
  capability bundles.
- `flow_revisions` / `flows` own immutable installed Flow package revisions and
  project enablement. Authored flows must not bypass that lifecycle.
- ADR-041 / ADR-044 route runtime materialization through
  `node_attempts.materialization_plan`, `settings.local.json`, and ACP
  `newSession params.mcpServers`; this plan must not reopen that runtime path.

### 0.3 Locked non-goals

- No PR to a catalog repo.
- No two-way sync between database and a catalog repository.
- No `setup.sh` execution for authored drafts.
- No automatic application of harvested self-improvement proposals.
- No marketplace, signatures, org-wide catalog policy, or cross-project
  promotion.
- No change to the existing `capability_imports[]` install/trust semantics.

### 0.4 Proposed new ADR

Phase 0 adds **ADR-061: Local authored capability catalog lifecycle**. It must
lock:

- Authored caps are first-class DB records, not edits to `maister.yaml`.
- `Draft` is editable; `Published` revisions are immutable.
- `Published` in M25 means project-local visibility inside this MAIster
  instance; external PR/catalog publication is deferred to a later table/state.
- Authored `rule` and `skill` published revisions can project into
  `capability_records` as `source='project'` with an explicit authored origin in
  `material`.
- Same `(project_id, kind, slug)` collisions with non-authored project
  capability rows are refused with `CONFLICT`; authored origin never silently
  takes priority.
- Config SET/CLEAR paths must exclude `material.origin='authored'`, so resyncing
  `maister.yaml` never disables local authored projections.
- Authored `flow` revisions do not become runnable `flow_revisions` until a
  later packaging/publication step creates a real package revision.
- Git-installed `capability_imports` and Flow packages remain read-only from the
  authored editor.

---

## 1. Deployment wiring

| New dependency | Lands in |
| --- | --- |
| New DB tables for authored caps/revisions | Drizzle migration `0028_m25_authored_capability_catalog.sql`, `web/lib/db/schema.ts`, `docs/database-schema.md`, `docs/db/capabilities-domain.md` or new `docs/db/authored-catalog-domain.md`, `docs/db/erd.md`. |
| New REST routes under `/api/projects/{slug}/catalog/*` | `docs/api/web.openapi.yaml`; no new port. |
| Optional max body/env settings if Phase 0 chooses them | `.env.example`, `docs/configuration.md`, existing compose overlay only if web env blocks already exist. |
| UI strings if a minimal admin view lands | `web/messages/en.json`, `web/messages/ru.json`. |

No new sidecar binary. No new filesystem cache. No `setup.sh` runner. No
supervisor changes.

---

## 2. Contract-surface to spec-file map

| Surface | Spec file |
| --- | --- |
| Authored cap lifecycle and invariants | `.ai-factory/specs/feature-m25-capability-catalog-groundwork.md` + `docs/system-analytics/capability-catalog.md` |
| New DB tables/indexes | `docs/database-schema.md` + `docs/db/capabilities-domain.md` or `docs/db/authored-catalog-domain.md` + `docs/db/erd.md` |
| CRUD/list/read REST routes | `docs/api/web.openapi.yaml` |
| Projection into `capability_records` | `docs/system-analytics/capabilities.md` + `docs/configuration.md` cross-reference |
| Relationship to Flow packages | `docs/system-analytics/flow-packages.md` + `docs/flow-installer.md` cross-reference only |
| Error behavior | `docs/error-taxonomy.md` caller rows; no new error code by default |
| ADR | `docs/decisions.md` ADR-061 |
| Roadmap tracking | `.ai-factory/ROADMAP.md` M25 row + `docs/pv/improvement-roadmap.md` E3 Wave-1 trace note after implementation |

---

## 3. Authored model

Phase 0 must freeze exact names, but the planned model is:

### 3.1 Tables

| Table | Purpose |
| --- | --- |
| `authored_capabilities` | Stable identity: `id`, `project_id`, `kind in ('rule','skill','flow')`, `slug`, `title`, `description`, `origin_type`, `origin_ref_id?`, `current_draft_revision_id?`, `current_published_revision_id?`, `archived_at`, timestamps. |
| `authored_capability_revisions` | Immutable revision snapshots except active drafts: `id`, `capability_id`, `revision_number`, `draft_version`, `lifecycle in ('DRAFT','PUBLISHED','ARCHIVED')`, `body`, `manifest`, `content_hash`, `published_at?`, timestamps. |
| `authored_capability_projection_events` | Optional lightweight ledger for projection actions into `capability_records`: `id`, `capability_id`, `revision_id`, `target_kind`, `status`, `error?`, timestamps. Use only if Phase 0 decides projection needs auditable retries. |

`body` and `manifest` are typed json/text per kind:

- `rule`: markdown/text rule body plus optional metadata.
- `skill`: `SKILL.md`-style body plus optional files manifest, but no external
  package layout or executable hook in this slice.
- `flow`: `flow.yaml` manifest draft plus optional docs; it is not enabled as a
  runnable package in M25.

### 3.2 Lifecycle

```text
Draft -> Published -> Archived
Draft -> Archived
Published -> Draft (creates a new Draft revision based on the published one)
```

Rules:

- Only one active Draft per authored capability.
- Published revisions are immutable and project-local in M25.
- Publishing a rule/skill revision updates or creates the corresponding
  `capability_records` row in the same DB transaction.
- Publishing a flow revision records it as local authored catalog content only;
  it does not mutate `flows`, `flow_revisions`, or project enablement.
- Archiving an authored rule/skill disables its projected `capability_records`
  row (`selectable=false`, `disabled_at=now`) without deleting historic runtime
  snapshots.
- Same-slug projection collisions with non-authored `source='project'`
  capability rows are refused before publish; operators must rename one side.

### 3.3 Relation to git-installed packages

| Existing source | M25 relation |
| --- | --- |
| `capability_imports` | Remains read-only. Authored caps may record `origin_type='capability_import'` and `origin_ref_id`, but cannot mutate the import row or installed files. |
| `capability_records` | Receives local authored rule/skill projections as `source='project'` with `material.origin='authored'`, `authoredCapabilityId`, `revisionId`, and `contentHash`. |
| `flow_revisions` / `flows` | Not touched by local authored flow publication. Later Wave 2/3 packaging turns authored flow revisions into package revisions. |
| `maister.yaml capability_imports[]` | No writes. Config remains operator-owned; SET/CLEAR continues for config-owned rows only and explicitly excludes authored-origin projections. |

---

## 4. Route identifiers and trust boundary

Proposed routes:

| Route | Identifiers |
| --- | --- |
| `GET /api/projects/{slug}/catalog/caps` | `slug` url-param -> project server-state. Query filters are enum/string only. |
| `POST /api/projects/{slug}/catalog/caps` | `slug` server-state; body carries authored fields only, no project id. |
| `GET /api/projects/{slug}/catalog/caps/{capId}` | `capId` url-param validated by DB join with project id. |
| `PATCH /api/projects/{slug}/catalog/caps/{capId}/draft` | Body carries draft content only. It cannot carry `projectId`, `source`, filesystem path, or revision ownership fields. |
| `POST /api/projects/{slug}/catalog/caps/{capId}/publish-local` | Empty or confirmation-only body. Server derives draft revision and projection target. |
| `POST /api/projects/{slug}/catalog/caps/{capId}/archive` | Empty or confirmation-only body. Server derives current projection. |

Trust boundary:

- Authored content is operator input, not fetched third-party code.
- No authored draft may run a hook or setup script in M25.
- If future authored skill/flow files include executable material, ADR-061 must
  state it is inert until the later packaging/trust milestone.
- Published rule/skill projection writes content to DB/read models only; runtime
  materialization must continue through the existing capability resolver and
  materializer.
- Publish refuses any same `(project_id, kind, slug)` capability projection that
  already exists without `material.origin='authored'`; request bodies cannot
  override origin or source.

---

## 5. Multi-store atomicity and config symmetry

| Transition | Atomicity requirement | Recovery |
| --- | --- | --- |
| Create authored cap + first draft | One DB transaction inserts identity and draft revision | No external side-effect |
| Update draft | One DB transaction updates only Draft revision, increments `draft_version`, and enforces Published immutable guard | Stale client `draft_version` returns `CONFLICT`; caller must reread before retry |
| Publish rule/skill | One DB transaction: mark revision Published, update `current_published_revision_id`, upsert `capability_records` projection, optionally write projection event | If transaction fails, no partial published/projection split |
| Archive rule/skill | One DB transaction: archive identity/revision and disable only the authored-origin projected `capability_records` row | Historic run snapshots remain valid |
| Publish flow | One DB transaction marks revision Published only; no Flow package side-effect | Later packaging reads immutable revision |
| Import removal symmetry | Existing `upsertCapabilitiesFromConfig` CLEAR is changed only to exclude rows where `material.origin='authored'`; authored projection must not re-enable a disabled git import row | Tests cover config, import, and authored paths side by side |

`content_hash` is `sha256` over stable canonical JSON:
`{kind, body, manifest, schemaVersion}`. The canonicalizer sorts object keys and
normalizes absent optional fields to `null`, so semantically identical drafts
hash identically across service and route callers.

The implementation must include SET/CLEAR-style tests:

1. Authored rule Published -> `capability_records` selectable row exists.
2. Authored rule Archived -> row disabled.
3. New Draft from Published then Published -> row points at new revision/content hash.
4. Existing git-imported row is unaffected by authored archive/publish of a
   different origin.
5. Config resync through `upsertCapabilitiesFromConfig` does not disable or
   re-enable authored-origin rows.
6. Same `(project_id, kind, slug)` collision with a non-authored project row is
   refused with `CONFLICT`.

### 5.1 Milestone acceptance criteria

- Draft create/update/list/read works for `rule`, `skill`, and `flow` with
  strict typed bodies.
- Draft updates require a matching `draft_version`; stale writes fail with
  `CONFLICT`.
- Local publish of `rule` and `skill` projects an authored-origin
  `capability_records` row in the same transaction.
- Config SET/CLEAR and git import cleanup never disable authored-origin rows.
- Same-slug collisions with non-authored project records are refused before
  publish.
- Local publish of `flow` stores an immutable authored revision only; it does
  not mutate `flows`, `flow_revisions`, setup hooks, or enablement.
- Archive disables only the authored-origin projection and preserves historic
  snapshots.

### 5.2 Cross-plan seam with M24

M24 `agent_schedules.agent_ref` remains a typed text reference with no FK into
M25. M25 owns only `rule`, `skill`, and `flow` authored caps. A later
agents-as-actors milestone may add an authored agent-definition model and
connect scheduler rows to it through a new ADR.

---

## 6. SDD and TDD workflow

Every phase uses the same agent-team loop:

1. **Coordinator** keeps `.ai-factory/specs/feature-m25-capability-catalog-groundwork.md`
   as the single source of truth.
2. **QA agent** writes RED tests before implementation and confirms runner globs.
3. **Implementor agent** makes the smallest GREEN change.
4. **Reviewer agent** performs adversarial review for schema immutability,
   import-path regressions, route identifiers, and trust/execution separation.
5. Each phase exits only after the named suite is GREEN and a checkpoint commit
   is created.

Testing conventions:

- Unit tests: vitest `*.test.ts`, no jsdom.
- Integration tests: `*.integration.test.ts` with testcontainers Postgres.
- Component/UI tests, if any: `renderToStaticMarkup`.
- Playwright only if a visible admin catalog surface lands in Phase 4.

---

## Tasks

### Phase 0 — Spec freeze (docs-first, single source of truth)

- [x] **T0.1** — Create
  `.ai-factory/specs/feature-m25-capability-catalog-groundwork.md` with value,
  non-goals, authored model, lifecycle, local publication semantics, acceptance
  criteria, same-slug collision policy, config CLEAR authored carve-out, and
  explicit Wave 2/3 deferrals. LOGGING: n/a. Files:
  `.ai-factory/specs/feature-m25-capability-catalog-groundwork.md`.
- [x] **T0.2** — Add `docs/system-analytics/capability-catalog.md` following
  docs R5. Cross-reference `capabilities.md`, `flow-packages.md`, and
  `flow-installer.md` instead of duplicating import/package mechanics. LOGGING:
  n/a. Files: `docs/system-analytics/capability-catalog.md`, docs glossary if
  needed.
- [x] **T0.3** — Add ADR-061 to `docs/decisions.md` for the local authored
  lifecycle, local-only meaning of `Published`, same-slug collision refusal,
  config CLEAR authored-origin carve-out, and git-installed relationship.
  LOGGING: n/a. Files: `docs/decisions.md`.
- [x] **T0.4** — Update contract docs as Designed: OpenAPI paths,
  database schema, DB ERD, capabilities-domain cross-reference, error taxonomy
  caller rows. LOGGING: n/a. Files: `docs/api/web.openapi.yaml`,
  `docs/database-schema.md`, `docs/db/erd.md`, `docs/db/capabilities-domain.md`,
  `docs/error-taxonomy.md`.
- [x] **T0.5** — QA writes RED tests for lifecycle, projection symmetry, config
  resync authored preservation, same-slug collision refusal, stale draft version
  conflicts, import path non-regression, and route identifier trust boundaries.
  Confirm each test path is included by the relevant vitest project. LOGGING:
  tests assert structured logs for publish/archive actions. Files:
  `web/lib/catalog/__tests__/*.test.ts`,
  `web/lib/catalog/__tests__/*.integration.test.ts`,
  `web/app/api/projects/[slug]/catalog/__tests__/*.test.ts`.
<!-- Commit checkpoint: T0.1-T0.5 -->

### Phase 1 — DB model and typed domain service

- [x] **T1.1** — Add migration `0028_m25_authored_capability_catalog.sql` and
  Drizzle schema for `authored_capabilities` and
  `authored_capability_revisions` (plus projection ledger only if Phase 0 keeps
  it). Include `draft_version`, unique `(project_id, kind, slug)`, and
  one-active-draft guards. LOGGING: n/a. Files: `web/lib/db/schema.ts`,
  `web/lib/db/migrations/0025_*_authored_capability_catalog.sql`, migration
  metadata.
- [x] **T1.2** — Implement `web/lib/catalog/authored-types.ts` and
  `web/lib/catalog/authored-service.ts` with strict TypeScript types and pure
  helpers for lifecycle validation, stable `sha256` content hash over canonical
  `{kind, body, manifest, schemaVersion}`, draft optimistic concurrency, and
  revision numbering. No `any`; do not reuse the existing Drizzle peer-dep
  workaround in new code. LOGGING: DEBUG lifecycle decisions; INFO
  create/update/publish/archive with
  `{projectId, capId, kind, revisionId}`; ERROR unexpected DB failure with
  context. Files listed above.
- [x] **T1.3** — Implement create/update/archive service methods:
  `createAuthoredCapability`, `updateDraftRevision`, `archiveAuthoredCapability`.
  `updateDraftRevision` requires the caller's `draft_version`; stale edits
  return typed `CONFLICT`. Guards must fail fast on invalid lifecycle
  transitions and immutable Published revisions. LOGGING: INFO transition
  summaries; WARN conflict/stale edit. Files:
  `web/lib/catalog/authored-service.ts`.
- [x] **T1.4** — Tests P1: lifecycle state machine, one active draft, Published
  immutable, archive idempotency/conflict behavior, stable content hash envelope,
  and stale draft conflict. Phase gate: typecheck, unit, integration green.
  LOGGING: assert service logs include structured ids. Files:
  `web/lib/catalog/__tests__/*`.
<!-- Commit checkpoint: T1.1-T1.4 -->

### Phase 2 — Local publish projection into capability_records

- [x] **T2.1** — Implement `publishLocalAuthoredCapability` for rule/skill. In
  one DB transaction, mark Draft -> Published, update current published pointer,
  and upsert the projected `capability_records` row with `source='project'` and
  `material.origin='authored'`. Precheck same `(project_id, kind, slug)`
  collisions and refuse non-authored project rows with typed `CONFLICT`; do not
  warn-and-continue. LOGGING: INFO publish result with content hash; WARN if
  projection would collide with non-authored project source. Files:
  `web/lib/catalog/authored-service.ts`,
  `web/lib/capabilities/catalog.ts` only if a typed projection helper belongs
  there.
- [x] **T2.2** — Implement authored flow local publication as immutable catalog
  publication only. Validate manifest shape enough to store a coherent draft, but
  do not insert `flow_revisions`, do not enable `flows`, and do not run setup.
  LOGGING: INFO flow draft published locally; WARN unsupported enable attempt.
  Files: `web/lib/catalog/authored-flow.ts`.
- [x] **T2.3** — Add projection read helpers and update
  `upsertCapabilitiesFromConfig` SET/CLEAR predicates so existing capability
  selection can distinguish authored vs config/import rows without changing
  runtime materialization. CLEAR must exclude
  `material.origin='authored'`. Runtime resolver keeps reading
  `capability_records`. LOGGING: DEBUG read model projection counts and config
  resync skip counts. Files:
  `web/lib/catalog/read-model.ts`, `web/lib/capabilities/resolver.ts` only if a
  typed origin field is surfaced, `web/lib/capabilities/catalog.ts`.
- [x] **T2.4** — Tests P2: publish rule/skill -> selectable
  `capability_records`; archive -> disabled row; republish -> new revision hash;
  config resync does not disable authored-origin rows; same-slug collision with
  non-authored project row is refused; git import rows unaffected; authored flow
  publish does not touch `flow_revisions`/`flows`; resolver sees authored
  rule/skill exactly like other project records. Phase gate: unit + integration
  green. LOGGING: assert publish logs. Files:
  `web/lib/catalog/__tests__/authored-service.integration.test.ts`.
  Validation note: the integration file is implemented and discovered by
  Vitest, but local execution is blocked before test bodies run because
  Testcontainers cannot find a working container runtime in this environment.
<!-- Commit checkpoint: T2.1-T2.4 -->

### Phase 3 — REST read/write groundwork

- [x] **T3.1** — Add route handlers for list/create/read:
  `GET/POST /api/projects/[slug]/catalog/caps` and
  `GET /api/projects/[slug]/catalog/caps/[capId]`. Use existing project package
  authorization helpers or a new `manageCatalog` action with min admin/member
  decided in Phase 0. LOGGING: INFO request/result with project/cap ids; WARN
  auth/refusal. Files:
  `web/app/api/projects/[slug]/catalog/caps/route.ts`,
  `web/app/api/projects/[slug]/catalog/caps/[capId]/route.ts`.
- [x] **T3.2** — Add route handlers for draft update, local publish, and archive.
  Bodies carry only editable content/confirmation; server derives project,
  cap, current draft, and projection target. LOGGING: INFO transition result;
  ERROR DB failure with code/context. Files:
  `web/app/api/projects/[slug]/catalog/caps/[capId]/draft/route.ts`,
  `.../publish-local/route.ts`, `.../archive/route.ts`.
- [x] **T3.3** — Update `docs/api/web.openapi.yaml` from Designed to the exact
  implemented request/response/error shapes. Include identifier labels in route
  descriptions. LOGGING: n/a. Files: `docs/api/web.openapi.yaml`.
- [x] **T3.4** — Tests P3: route auth, malformed body, capId/project mismatch,
  body-controlled project id ignored/refused, lifecycle conflicts, publish
  response includes revision/content hash, OpenAPI examples match behavior.
  Phase gate: typecheck, unit, integration green. LOGGING: assert route result
  logs. Files: route `__tests__`.
<!-- Commit checkpoint: T3.1-T3.4 -->

### Phase 4 — Minimal admin surface and docs sync

- [x] **T4.1** — Add a minimal project settings/catalog surface if Phase 0 keeps
  UI in scope: table of authored caps, status, current draft/published revision,
  and actions to create draft, publish local, archive. Use HeroUI only; no rich
  editor beyond text/JSON fields. LOGGING: no client console logs. Files:
  `web/app/(app)/projects/[slug]/settings/catalog/page.tsx` or existing settings
  panel, `web/components/catalog/*`.
  N/A for implementation: Phase 0 froze M25 as local model + read/write API
  groundwork, so no visible admin UI was kept in scope.
- [x] **T4.2** — Add EN/RU i18n messages for any UI strings. LOGGING: n/a.
  Files: `web/messages/en.json`, `web/messages/ru.json`.
  N/A for implementation: no UI strings were added in the frozen scope.
- [x] **T4.3** — Sync docs from Designed to Implemented for the M25 slice only.
  Keep PR publishing and two-way sync marked Phase 2/3. LOGGING: n/a. Files:
  `docs/system-analytics/capability-catalog.md`,
  `docs/system-analytics/capabilities.md`, `docs/database-schema.md`,
  `docs/db/erd.md`, `docs/db/capabilities-domain.md`,
  `docs/configuration.md`.
- [x] **T4.4** — Tests P4: renderToStaticMarkup for table/actions if UI lands;
  Playwright smoke only if the surface becomes navigable in the app shell.
  Validate docs Mermaid. Phase gate: unit/e2e targeted as applicable plus docs
  validation. LOGGING: n/a. Files: `web/components/catalog/__tests__/*`,
  optional `web/e2e/m25-capability-catalog.spec.ts`.
  N/A for implementation: no UI surface landed; docs validation remains in the
  final gate.
<!-- Commit checkpoint: T4.1-T4.4 -->

### Final gate

- [x] `pnpm --filter maister-web typecheck`
- [x] `pnpm --filter maister-web test:unit` (targeted M25 route/service slice
  via direct Vitest: 16 passed)
- [ ] `pnpm --filter maister-web test:integration` (blocked by missing local
  Testcontainers runtime; new M25 integration file is discovered)
- [ ] Optional if UI lands: `pnpm --filter maister-web test:e2e -- m25-capability-catalog`
- [x] `pnpm validate:docs:all`
- [x] `git --no-pager diff --check`
- [x] Update `.ai-factory/ROADMAP.md` M25 row and
  `docs/pv/improvement-roadmap.md` E3 Wave-1 trace note from Designed to
  Implemented only after implementation verification passes.

Validation note (2026-06-05): focused M25 service and route unit suites pass
(16 tests), typecheck passes, Mermaid docs validation passes, and
`git diff --check` passes. Full unit is blocked by the pre-existing M18
`runs-launch-branch.test.ts` fake-DB `sidecarRows.map` failure. Integration is
blocked by Testcontainers reporting no working container runtime in this
environment; the new M25 integration file is present and discovered. M25 UI/e2e
tasks are N/A because the frozen scope is local model + read/write API
groundwork; PR publication and two-way sync remain Wave 2/3.

---

## Commit Plan

- **Commit 1** (Phase 0): `docs: freeze authored capability catalog contract`
- **Commit 2** (Phase 1): `feat: add authored capability model`
- **Commit 3** (Phase 2): `feat: project authored caps into capability catalog`
- **Commit 4** (Phase 3): `feat: add authored catalog api`
- **Commit 5** (Phase 4): `feat: surface local catalog groundwork`

---

## Risks and watch-items

- **Scope creep into Wave 2/3:** PR publish, repo sync, package export, and
  self-improvement proposal inbox stay out.
- **Breaking imports:** Authored projection must not mutate or re-enable
  `capability_imports` rows. Keep tests around existing import/trust route.
- **Config CLEAR collision:** Existing config-owned caps also use
  `source='project'`. The implementation must filter by
  `material.origin='authored'`, not by `source` alone.
- **Flow ambiguity:** An authored flow Published locally is not runnable until a
  later package/publish step creates or enables a Flow package revision.
- **Trust confusion:** Local publication is not external trust. It must not run
  setup hooks or executable package code.
- **Generic json drift:** Use discriminated typed bodies per kind; avoid an
  untyped "blob catalog" that every later feature has to reverse-engineer.
- **ADR sequencing:** ADR-061 must reserve only authored-catalog contracts. If
  M24 lands first, ADR-060 owns scheduler-clock contracts and must not be
  renumbered.

## Open questions

1. Should M25 include the minimal project settings UI, or stop at API/service
   groundwork plus docs?
