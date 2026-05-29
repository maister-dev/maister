# M10 — Flow package lifecycle and distribution UX

> Branch convention: `feature/m10-flow-package-lifecycle` off `main`.
> Refined once (`/aif-improve`): docs-first Phase 0, microsoft/apm evaluation,
> backfill script, ops-script + existing-test migration tasks.

## Context

M4 proved the Flow **loader** (clone a git-tagged repo into a content-addressed
system cache, symlink it per project, validate `flow.yaml`, upsert one row). M10
promotes Flows from "git repos the loader can clone" into **managed delivery
packages** that a product user can install, trust, upgrade, roll back, and
disable — safely — through the project-settings UI. This is the foundation every
later milestone (M11 graph, M12 artifacts, M14 capabilities, M15 gates) builds on,
because all of them ship *inside* Flow packages and must be version-pinned and
trust-gated.

The hard runtime guarantee is already half-built: `runs.flow_revision` snapshots
the resolved SHA at launch and the runner derives the bundle path from the
**immutable** content-addressed cache (`systemCachePath(flow.flowRefId,
run.flowRevision)`, `web/lib/flows/runner.ts:164`). Two gaps make multi-revision
lifecycle impossible today:

1. `flows` is `UNIQUE(project_id, flow_ref_id)` — exactly **one** revision row
   per (project, flow). Upgrade/rollback/coexistence are unrepresentable.
2. The runner reads the manifest from the **live** `flows.manifest` column
   (`runner.ts:160`), not from a pinned snapshot. The moment "upgrade" exists,
   an upgrade would silently corrupt every in-flight run's manifest. Latent bug.

M10 closes both: an immutable `flow_revisions` table, the `flows` row repurposed
as a project **enablement pointer**, a `runs.flow_revision_id` FK so the runner
reads the manifest from the pinned revision, lifecycle operations
(install/enable/disable/upgrade/rollback/trust/remove), launch preconditions that
refuse disabled/failed/untrusted/incompatible/missing-setup packages, and a Flow
Packages settings surface.

## Roadmap Linkage

- **Milestone:** "M10. Flow package lifecycle and distribution UX"
- **Rationale:** This plan implements the M10 roadmap entry in full — package
  identity, the 9-state lifecycle, the package surface in settings, install/trust
  review, upgrade/rollback, the package contract (recorded), setup/migration
  safety, and all 9 acceptance criteria.

## Settings

- **Testing:** yes — unit + integration (vitest). DB-integration tests run on
  Docker-enabled CI (per M8 note; local box may lack Docker).
- **Logging:** verbose — pino `debug`/`info` at every lifecycle transition,
  trust decision, compatibility verdict, two-phase boundary, and launch refusal.
- **Docs:** yes — **docs-first** (Phase 0 authors the complete M10 design spec
  *before* implementation) + mandatory as-built docs sync at completion (`/aif-docs`).

## Confirmed decisions (from clarification)

1. **Scope:** full M10 in one branch (docs → schema → loader → preconditions →
   lifecycle API → settings UI → contract/compat → as-built docs/tests).
2. **Contract depth:** *record + display* the package contract
   (engine/API compat range, declared capability/gate/artifact kinds, external
   ops, setup hooks) as **opaque** manifest metadata; **enforce only**
   `schemaVersion` + engine-version compatibility at enablement. Semantic
   validation (does this gate/capability kind exist?) is deferred to the
   milestone that introduces each concept (M11+).
3. **Trust policy:** `local`/`file://` auto-trusted; git sources whose URL
   matches `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` → `trusted_by_policy`;
   everything else requires an explicit per-(project, revision) trust
   confirmation persisted in DB before enable/setup.
4. **Schema model:** new immutable `flow_revisions` table; `flows` repurposed
   as the project-enablement pointer; `runs.flow_revision_id` FK; data migration
   of existing rows.
5. **microsoft/apm:** evaluated and **NOT adopted in M10** — see ADR below;
   recorded as a reference for M14 capability materialization.

### microsoft/apm evaluation (decision → ADR in Phase 0)

[microsoft/apm](https://github.com/microsoft/apm) — *Agent Package Manager* — is a
dependency manager for agent **context primitives** (instructions, skills,
prompts, agents, hooks, MCP servers) via an `apm.yml` manifest + `apm.lock.yaml`
lockfile (transitive resolution), content-security scanning, integrity hashes,
MCP trust prompts, and an `apm-policy.yml` governance layer. Python CLI, MIT,
built on AGENTS.md / Agent Skills / MCP.

**Decision: do not adopt in M10.**
- **Different layer.** APM packages are *static context bundles*; a MAIster Flow
  package is an *executable delivery process* (`flow.yaml` step DSL + runner +
  HITL + guards). APM has no flow/step/run concept — it cannot replace
  `flow.yaml`, the loader, or the runner.
- **Architecture conflict.** APM is a standalone **Python** CLI with its own
  global install state + lockfile. Integrating it means spawning a Python
  subprocess from the web tier (forbidden: `lib/*` must not spawn processes) and
  re-adding a hard Python dependency the stack deliberately dropped.
- **Roadmap already defers APM's distinctive value.** APM's content-scanning,
  signed packages, org policy, and dependency solver map onto M10's *explicitly
  deferred* list. Pulling APM in drags deferred scope into M10.

**Forward pointer:** APM (and the AGENTS.md / Agent Skills / MCP standards it
builds on) is a strong reference for **M14 (Scoped capability materialization)** —
where a Flow's shipped skills/agents/MCP servers are actually installed and
materialized. M10 only *records* those as opaque contract metadata.

**Alternatives considered:** borrow APM's lockfile/integrity mindset (M10 already
does this via `manifest_digest` — no action); adopt APM's content-security scan
(overlaps the roadmap's deferred "malicious-code scanning" — out of M10).

### Schema model detail (single source of runtime truth)

- **`flow_revisions`** — *immutable, globally content-addressed* per
  `(flow_ref_id, resolved_revision)` (the system cache is shared across
  projects). Holds: `source`, `version_label` (tag), `resolved_revision`
  (git SHA or content digest for local), `manifest_digest`, `manifest` (jsonb
  snapshot), `schema_version`, `engine_min`/`engine_max`, `contract` (jsonb,
  opaque), `installed_path`, `setup_status`
  (`not_required|pending|done|failed`), `package_status`
  (**global** revision lifecycle: `Discovered|Installing|Installed|Failed|Removed`),
  `installed_at`. `UNIQUE(flow_ref_id, resolved_revision)`.
- **`flows`** (repurposed) — *project-scoped enablement pointer*, keeps
  `UNIQUE(project_id, flow_ref_id)`. Add `enabled_revision_id` FK →
  `flow_revisions`, `enablement_state` (**project-relative**:
  `Installed|Enabled|UpdateAvailable|Deprecated|Disabled|Failed`),
  `trust_status` (`untrusted|trusted|trusted_by_policy`), `updated_at`. Keep the
  existing `source/version/revision/installed_path/manifest/schema_version/
  recommended_executor_id/executor_override_id` columns as a **denormalized
  cache of the currently-enabled revision** (updated atomically on
  enable/upgrade/rollback) so launch/UI/`resolveExecutor` reads stay one-row
  cheap. *Authority for runtime bytes is `flow_revisions`, never this cache.*
- **`runs`** — add `flow_revision_id` FK → `flow_revisions` (nullable for
  back-compat with pre-migration terminal runs). New runs always set it; the
  runner reads the manifest + install path from this pinned revision, falling
  back to `flows.manifest` only when `flow_revision_id` is null (legacy rows).

Rationale for keeping the denormalized columns rather than dropping them:
minimizes churn in `resolveExecutor` (`web/lib/executors.ts`), queries, and the
launch path; keeps the data migration trivial (each existing `flows` row seeds
exactly one `flow_revisions` row from its own columns); the only behavior change
for correctness is the runner reading from the pinned revision.

---

## Phase 0 — Complete M10 feature documentation (docs-first)

> Implementation starts only after this phase. The design spec is the source of
> truth Phases 1–7 follow.

**T0.0 — Author the complete M10 design spec + ADR**
- New `docs/system-analytics/flow-packages.md` — the authoritative feature doc:
  package identity; the 9-state lifecycle with the **global revision states**
  (`Discovered|Installing|Installed|Failed|Removed`) vs **project enablement
  states** (`Installed|Enabled|UpdateAvailable|Deprecated|Disabled|Failed`)
  split; the schema model (`flow_revisions` / repurposed `flows` /
  `runs.flow_revision_id`); trust policy; compatibility model (engine + schema);
  install/upgrade/rollback/disable/remove flows; launch-precondition refusal
  table; two-phase install state machine + failure classification.
- New ADR in `docs/decisions.md` — "M10 Flow package lifecycle" recording the
  4 confirmed decisions **and the microsoft/apm evaluation outcome** (not
  adopted in M10; M14 reference).
- Acceptance: the doc enumerates every table/column, every lifecycle transition,
  every launch refusal, and the contract-surface map that Phase 7 will sync; a
  reviewer can implement Phases 1–7 from this doc alone.

*Commit checkpoint after Phase 0 (`docs(m10): flow package lifecycle design spec + ADR`).*

## Phase 1 — Engine version + manifest contract schema

**T1.1 — MAIster engine/API version constants**
- New `web/lib/flows/engine-version.ts`: export `MAISTER_ENGINE_VERSION`
  (semver string, e.g. `"1.0.0"`) and `SUPPORTED_FLOW_SCHEMA_VERSIONS = [1]`.
  Pure semver compare helper `isEngineCompatible(min?, max?)`.
- Log: `info` the resolved engine version once at module load.
- Acceptance: unit tests for in-range / below-min / above-max / open-ended.

**T1.2 — Manifest contract fields + digest**
- Extend `flowYamlV1Schema` in `web/lib/config.schema.ts` with **optional**
  blocks (all default-empty, validated structurally only — opaque):
  `compat?: { engine_min?, engine_max? }`, `capabilities?: string[]`,
  `gates?: string[]`, `artifacts?: string[]`, `external_ops?: string[]`.
  (`recommended_executor`, `setup`, `steps` already exist.)
- New `web/lib/flows/digest.ts`: `manifestDigest(manifest): string` —
  sha256 over canonical (stable-key-sorted) JSON of the parsed manifest.
- `loadFlowManifest` (`web/lib/config.ts`): new keys must parse. Log `debug` the
  parsed contract summary + digest.
- Acceptance: a manifest with/without the contract block both parse; digest is
  stable across key reordering; unsupported `schemaVersion` still rejected.

*Commit checkpoint after Phase 1 (`feat(m10): manifest contract fields + engine version`).*

## Phase 2 — Schema: multi-revision model + migration

**T2.1 — Drizzle schema edits** (`web/lib/db/schema.ts`)
- Add `flowRevisions` table per the model above (+ `$inferSelect` export type).
- Add to `flows`: `enabledRevisionId` (FK → flowRevisions, `on delete set null`),
  `enablementState` (enum, default `Installed`), `trustStatus` (enum, default
  `untrusted`), `updatedAt`.
- Add `runs.flowRevisionId` (FK → flowRevisions, nullable).
- Generate DDL migration `0006_*.sql` via `pnpm db:generate`. **DDL only — no
  data backfill in the SQL** (digests need sha256 of canonical JSON; see T2.3).

**T2.3 — Revision-backfill script** (NEW — split out of the old T1.2)
- New `web/scripts/backfill-flow-revisions.ts` (tsx via the existing
  `_register-shim.mjs`/`_server-only-shim.mjs` pattern): for each existing
  `flows` row INSERT a `flow_revisions` row copying
  `source/version→version_label/revision→resolved_revision/installed_path/
  manifest/schema_version`, `manifest_digest = manifestDigest(manifest)` (T1.2),
  `package_status='Installed'`, `setup_status='done'`; SET
  `flows.enabled_revision_id`, `enablement_state='Enabled'`,
  `trust_status='trusted_by_policy'` (grandfather existing installs); UPDATE
  `runs SET flow_revision_id` by matching `(flow_ref_id, flow_revision)`,
  leaving legacy/unmatched rows null.
- Add `pnpm backfill-flow-revisions` to `web/package.json` + a getting-started note.
- Acceptance: run DDL `0006` then the backfill on a seeded DB; every `flows` row
  has an enabled revision; existing runs resolve their manifest; idempotent on
  re-run.

*Commit checkpoint after Phase 2 (`feat(m10): flow_revisions schema + backfill`).*

## Phase 3 — Loader refactor to revision-aware install (two-phase)

**T3.1 — Trust policy resolver** (`web/lib/flows/trust.ts`)
- `resolveTrust(source): "trusted_by_policy" | "untrusted"` — local/`file://`
  and prefix-match against `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` (comma-split)
  → `trusted_by_policy`; else `untrusted`. Log `info` the verdict.

**T3.2 — `installFlowPlugin` → revision-aware, two-phase** (`web/lib/flows.ts`)
- Local sources resolve `resolved_revision = manifestDigest` (T1.2) — drop the
  `"unknown"` overwrite path so local bundles are immutable too.
- **Two-phase commit** (skill-context rule):
  1. BEFORE disk side-effects: INSERT/lock a `flow_revisions` row at
     `package_status='Installing'` (durable "intent"), keyed by
     `(flow_ref_id, resolved_revision)` — for git, resolve the SHA first via a
     shallow clone to temp (current behavior), then the intent row; idempotent
     `onConflictDoNothing` if the revision is already `Installed`.
  2. Run clone-finalize/symlink/`setup.sh`.
  3. AFTER success: UPDATE `package_status='Installed'`, `setup_status`,
     `manifest_digest` (via `manifestDigest()`), `contract`, `engine_min/max`.
     The `Installed` marker is the **AFTER**-side write.
  - On any failure: UPDATE `package_status='Failed'` (never leave `Installing`);
    wrap as `FLOW_INSTALL` carrying `{source, version, stage, command,
    exitStatus, output}` in the message. No new error code.
- Upsert the project `flows` enablement row: point `enabled_revision_id` at the
  new revision, refresh the denormalized cache columns, set `trust_status` from
  `resolveTrust`, `enablement_state='Installed'` (NOT auto-`Enabled`; the
  register path may auto-enable trusted-by-policy flows to preserve the
  one-shot register UX — see T3.3).
- **Failure-classification table** (install): clone auth/4xx → Failed +
  FLOW_INSTALL; clone timeout/network → Failed + FLOW_INSTALL; setup.sh non-zero
  → revision `Installed` but `setup_status='failed'`; manifest invalid → Failed +
  FLOW_INSTALL.

**T3.3 — Config-state symmetry on register** (skill-context rule)
- Re-registering a project (`web/app/api/projects/route.ts` → `installFlowPlugin`
  per `flows[]`) must handle the **CLEAR** half: a flow removed from
  `maister.yaml` on the next register → its `flows` row
  `enablement_state='Disabled'` (NOT silently left enabled); `executor_override`
  removal → column back to null. In-flight runs keep their pinned revision.
- Acceptance (mandatory round-trip): SET / CLEAR / re-SET for flow enablement AND
  for `executor_override` (the M6 asymmetry bug class).

**T3.4 — Update ops scripts for the revision-aware loader** (NEW)
- `web/scripts/install-flow.ts` and `web/scripts/run-flow.ts` call
  `installFlowPlugin` / read flow rows; update them to the new return shape
  (revision id + enablement) and the repurposed `flows` columns. Verify
  `pnpm install-flow` / `pnpm run-flow` still smoke-test end-to-end.
- Acceptance: both scripts run against a local fixture flow without referencing
  dropped/changed fields.

*Commit checkpoint after Phase 3 (`feat(m10): revision-aware loader + trust + ops scripts`).*

## Phase 4 — Launch preconditions + runner correctness

**T4.1 — Launch refuses bad packages + pins revision** (`web/app/api/runs/route.ts`)
- After loading `task.flowId → flows` row, resolve the **enabled revision**:
  load `flow_revisions` by `flows.enabled_revision_id`.
- New precondition checks (each → typed error, logged):
  - `enablement_state ∈ {Disabled, Failed}` → `PRECONDITION` (409).
  - `trust_status='untrusted'` → `PRECONDITION` (409, "package not trusted").
  - engine/schema incompatible → `CONFIG` (422).
  - `setup_status='pending'|'failed'` → `PRECONDITION` (409, "setup incomplete").
  - `enabled_revision_id` null → `PRECONDITION`.
- Snapshot `runs.flow_revision_id = enabled revision id` (alongside existing
  `flowVersion`/`flowRevision` text). `resolveExecutor`'s `flow` arg keeps using
  the denormalized `flows.recommended_executor_id`/`executor_override_id`.
- **Identifiers** (skill-context rule): `taskId` = `body-controlled` (task lookup
  → project derived as `server-state`); `executorOverrideId` = `body-controlled`
  (validated against `executors WHERE id AND project_id`); no body flow/revision
  id — revision is **server-derived** from the enabled pointer.

**T4.2 — Runner reads manifest from the pinned revision** (`web/lib/flows/runner.ts`)
- In `loadRun`: if `run.flowRevisionId` set, load the `flow_revisions` row and
  use its `manifest` + `installed_path`; else fall back to `flows.manifest` +
  `systemCachePath(flow.flowRefId, run.flowRevision)` (legacy rows).
- Fixes the in-flight upgrade-corruption latent bug.
- Acceptance: upgrade a flow mid-run → the in-flight run still loads the **old**
  manifest; a new run loads the new one.

*Commit checkpoint after Phase 4 (`feat(m10): launch preconditions + pinned-revision runner`).*

## Phase 5 — Lifecycle operations (lib service + API routes)

**T5.1 — Lifecycle service** (`web/lib/flows/lifecycle.ts`, server-only)
- Pure-ish functions over `{db}`:
  - `enableRevision(projectId, flowRefId, revisionId)` — set enabled pointer +
    refresh denormalized cache + `enablement_state='Enabled'`. Refuse if
    untrusted / incompatible / setup incomplete. **Refresh
    `recommended_executor_id` from the new revision manifest but PRESERVE the
    project-level `executor_override_id`** (don't clobber on rollback).
  - `disableFlow(projectId, flowRefId)` → `Disabled` (in-flight runs keep their
    pinned revision).
  - `upgradeFlow(projectId, flowRefId, source, version)` — install a NEW
    immutable revision beside the old (T3.2), run compat validation, set the
    project `flows` row to `UpdateAvailable`; does NOT auto-enable. (No remote
    auto-check: `UpdateAvailable` means a newer **installed-but-not-enabled**
    revision exists — aligns with the roadmap's deferred "automatic update
    rollout".)
  - `rollbackFlow(projectId, flowRefId, revisionId)` — switch enabled pointer to
    an older **installed** revision; never mutates completed/active run history.
  - `setTrust(projectId, flowRefId, trusted)` — only where policy allows; log.
  - `removeRevision(flowRefId, revisionId)` — **refuse** if any
    `runs.flow_revision_id` references it OR it is any project's enabled revision
    (`CONFLICT` 409); else mark `package_status='Removed'` + best-effort cache
    rm. (Automatic GC stays M19 — guard + manual remove only.)
  - `upgradePreview(projectId, flowRefId, candidateRevisionId)` — structured diff
    of enabled vs candidate manifest **contract**: added/removed/changed
    nodes(steps), gates, artifacts, capabilities, external_ops, setup hooks,
    schemaVersion.
- Log `info` every transition `{projectId, flowRefId, from, to, revisionId}`.

**T5.2 — RBAC action**
- Add `managePackages: "admin"` to `PROJECT_ACTION_MIN` in `web/lib/authz.ts`.

**T5.3 — API routes** under `web/app/api/projects/[slug]/flow-packages/`
- `POST .../install` (body: `flowRefId`, `source`, `version`),
  `POST .../[flowRefId]/enable` (body: `revisionId`),
  `POST .../[flowRefId]/disable`,
  `POST .../[flowRefId]/upgrade` (body: `source`, `version`),
  `POST .../[flowRefId]/rollback` (body: `revisionId`),
  `POST .../[flowRefId]/trust` (body: `trusted`),
  `POST .../[flowRefId]/revisions/[revisionId]/remove`,
  `GET  .../[flowRefId]/upgrade-preview?revisionId=…`.
- Pattern: zod body → `requireActiveSession()` → resolve `project` from **slug**
  (`server-state`) → `requireProjectAction(project.id, "managePackages")` →
  validate `flowRefId`/`revisionId` against `project.id` (`server-state` join,
  mismatch → `PRECONDITION`) → service call → `httpStatusForCode`.
- **Identifiers per route**: `slug` = `url-param`; `flowRefId`/`revisionId`
  always validated against the project's own rows before use — no filesystem path
  built from a body field (paths come from validated `flow_revisions.installed_path`).
- **Two-phase** for `install`/`upgrade`: the durable `Installing →
  Installed/Failed` state machine (T3.2) is the two-phase boundary; the route
  returns only after the AFTER-side write; failure-classification table in the
  route Decisions + OpenAPI.

*Commit checkpoint after Phase 5 (`feat(m10): flow-package lifecycle service + API`).*

## Phase 6 — Flow Packages settings UI

**T6.1 — Query layer** (`web/lib/queries/flow-packages.ts`)
- `getFlowPackages(projectId)` → per flow_ref: enabled revision, enablement/trust
  state, all installed revisions (rollback candidates), available update
  (installed-but-not-enabled newer revision), compatibility warnings, required
  capabilities, shipped skills/agents, setup scripts, declared artifacts/gates
  (from `contract`), projects-using count, and **active runs pinned to old
  revisions** (`runs` join on `flow_revision_id` != enabled, non-terminal).

**T6.2 — UI panel + modals**
- Add `"packages"` to `VALID_TABS` in `web/app/(app)/projects/[slug]/page.tsx`;
  render `FlowPackagesPanel` (server) in the tab switch.
- `web/components/board/panels/flow-packages-panel.tsx` (server) — package list:
  ref, enabled version+resolved revision, state badge, trust badge,
  available-update indicator, compatibility warning, "active runs on old
  revision" count. Mirror `flows-panel`/`settings-panel` (forest tokens).
- `web/components/board/package-action-modal.tsx` (`"use client"`) —
  install/upgrade/trust **review** modals: source, version, resolved revision,
  setup-script presence, declared capabilities, MCP/tool/skill requests, gates,
  artifacts, risk labels. Upgrade modal renders the `upgrade-preview` diff.
  `submit()` → fetch Phase 5 routes → `router.refresh()`. Busy/disabled/error
  per the HITL-actions pattern.

**T6.3 — i18n**
- Add a `packages` namespace to `messages/en.json` AND `messages/ru.json`
  (title, state/trust labels, install/enable/disable/upgrade/rollback/trust/
  remove, review-modal field labels, compatibility/risk warnings, confirm copy).
  RU REQUIRED (no English fallback strings left).

**T6.4 — Exercise the bundled `aif` flow with contract fields** (NEW, small)
- Add optional `compat` + a representative `capabilities`/`artifacts` block to
  `plugins/aif/flow.yaml` so the new manifest schema + contract display path is
  exercised end-to-end (success criteria reference the bundled aif Flow). Keep
  surgical — only add the new optional block.

*Commit checkpoint after Phase 6 (`feat(m10): flow packages settings UI + i18n`).*

## Phase 7 — Deployment wiring, as-built contract docs, tests

**T7.1 — Deployment wiring** (skill-context rule: new env var)
- `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` lands in: `.env.example` (documented
  example + empty default), the web service `environment:` block in `compose.yml`
  and `compose.production.yml`, and the env-var table in `docs/configuration.md` +
  a getting-started note. No new port/sidecar/bound file.

**T7.2 — As-built contract-spec sync** (skill-context rule: trace each surface)
  > The design narrative already shipped in Phase 0 (`flow-packages.md`); this
  > task syncs the **contract specs** to what was actually built.

  | Surface | Spec file |
  | --- | --- |
  | 8 new HTTP routes (flow-packages/*) | `docs/api/web.openapi.yaml` (paths, bodies, 200/409/422/502, two-phase failure classes) |
  | New DB tables/columns (`flow_revisions`, `flows.*`, `runs.flow_revision_id`) | migration `0006_*.sql` + `docs/database-schema.md` + `docs/db/*` ERD |
  | New env var | `docs/configuration.md` env table + `.env.example` |
  | New manifest fields (`compat`, `capabilities`, `gates`, `artifacts`, `external_ops`) | `docs/flow-dsl.md` + `web/lib/config.schema.ts` |
  | New `pnpm backfill-flow-revisions` script | `docs/getting-started.md` "Scripts" + `web/CLAUDE.md` |
  | Lifecycle doc (Phase 0) cross-links | `docs/system-analytics/flow-packages.md` |
  | Prose contract | update `CLAUDE.md` §6 + `web/CLAUDE.md` flows section; flip ROADMAP M10 only at `/aif-verify` |
- `FLOW_INSTALL` structured-detail convention noted in `docs/error-taxonomy.md`.

**T7.3 — Tests** (vitest unit + integration)
- **Migrate the existing suite to the new model** (NEW): `lib/__tests__/flows.test.ts`,
  `flows.integration.test.ts`, `foundation.integration.test.ts`,
  `lib/flows/__tests__/runner.integration.test.ts`, `runner-terminal.test.ts`,
  `runner-reentry.test.ts`, `lib/db/__tests__/schema.integration.test.ts`,
  `app/api/__tests__/projects-register.integration.test.ts`,
  `lib/queries/__tests__/portfolio.integration.test.ts`,
  `app/api/runs/__tests__/route.trust-boundary.integration.test.ts` — update
  fixtures/assertions to the `flow_revisions` model + revision-aware install.
- Unit (new): engine-compat, manifest digest stability, trust resolver,
  lifecycle state transitions, upgrade-preview diff, launch-precondition refusals
  (table), runner manifest-from-pinned-revision + legacy fallback,
  `recommended_executor` refresh vs `executor_override` preservation.
- Integration (new, DB): `0006` migration + backfill script; revision-aware
  install two-phase (Installing→Installed and Installing→Failed); coexisting
  revisions; upgrade installs beside old + in-flight run keeps old manifest;
  rollback; `removeRevision` refused while referenced (CONFLICT) and allowed when
  unreferenced; config-state symmetry round-trips (flow + executor_override);
  route trust-boundary (cross-project flowRefId/revisionId rejected) + RBAC
  (`managePackages` admin-only).

*Final commit (`feat(m10): deployment wiring, as-built docs, tests`) then `/aif-verify`.*

---

## Skill-context compliance summary

- **Deployment touchpoints:** T7.1 dedicates a task to
  `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` in `.env.example` + both compose files + docs.
- **Contract → spec file:** T7.2 enumerates every surface against its spec file.
- **Config-state symmetry:** T3.3 + T7.3 enforce SET/CLEAR/re-SET round-trips for
  flow enablement and `executor_override`.
- **Body-controlled identifiers:** T4.1 + T5.3 label every route identifier;
  revision/flowRef are server-validated; no FS path is built from a body field.
- **Two-phase commit:** T3.2/T5.3 make `Installing → Installed/Failed` the durable
  two-phase boundary with a failure-classification table; the `Installed` marker
  is the AFTER-side write.
- **Deferred-release:** install stays awaited inside the request (no new ACP
  deferred); the in-flight dedup `Map` already releases in `finally`. N/A beyond that.

## Verification (end-to-end)

0. Phase 0 design spec (`docs/system-analytics/flow-packages.md`) + ADR exist and
   match the shipped schema/flows (reviewed at `/aif-verify`).
1. `pnpm --filter maister-web db:migrate` applies `0006`; `pnpm
   backfill-flow-revisions` populates `flow_revisions` + `flows.enabled_revision_id`
   + `runs.flow_revision_id`; existing runs/flows intact.
2. `pnpm --filter maister-web lint` + `tsc --noEmit` clean; full web + supervisor
   test suites green (including the migrated existing suite).
3. Install two revisions of one Flow (tag A then tag B) → both rows in
   `flow_revisions`; project enabled = A; Packages shows "update available (B)".
4. Launch on enabled A → run pins `flow_revision_id=A`. Upgrade-enable B → the
   in-flight run still loads A's manifest (T4.2); a new launch pins B.
5. Rollback to A; new launches pin A; B-pinned run history unchanged;
   `executor_override` preserved across rollback.
6. Disable → launch refused `PRECONDITION`. Untrusted git source → refused until
   trust. Incompatible engine/schema → `CONFIG`.
7. `removeRevision` on a run-referenced revision → `409 CONFLICT`; unreferenced
   disabled revision → succeeds.
8. RU locale: Packages panel fully translated; admin-only actions hidden for
   non-admin roles (RBAC `managePackages`).

## Open questions (carried; non-blocking)

1. `MAISTER_ENGINE_VERSION` starting value — `1.0.0`? Bump at M11 graph?
2. Local/`file://` sources: default `trusted_by_policy` — keep, or require
   explicit confirmation too?
3. Manual revision removal in M10 — needs a UI button, or is API + deferring
   auto-GC to M19 enough?
4. Auto-enable (`Enabled`) flows on first project registration (preserve current
   one-shot register UX), or registration only sets `Installed` and enablement
   is always explicit?
5. microsoft/apm at M14 — adopt the CLI, or just borrow its `apm.yml`/lockfile +
   AGENTS.md/Agent-Skills/MCP conventions for capability packaging?
