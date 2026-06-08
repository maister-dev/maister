# Implementation Plan: Platform Flows Management

Branch: detached HEAD
Created: 2026-06-08

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "post-M25 platform Flow authoring and management"
Rationale: This builds on M10 Flow package lifecycle and M25 authored catalog groundwork to make Flows a first-class platform section.

## Decisions
- Flow package meaning stays unchanged: a portable git-tagged bundle with `flow.yaml`, optional setup scripts, shipped CLIs, skills, agents, rules, and future adapter mappings.
- Installed executable packages remain owned by M10 `flow_revisions` + project `flows`; authored drafts remain owned by M25 `authored_capabilities`.
- Authored Flow publish is local catalog publication only. It must not mutate `flows`, `flow_revisions`, setup sentinels, install caches, symlinks, or launch preconditions.
- YAML editing stores the raw draft text in `body.flowYaml` and the parsed object in `manifest`; execution still reads installed package revisions only.
- Create, edit, publish, import, and export authoring actions use the same project-scoped `manageCatalog` axis. Global `admin` may pass through the existing project-role bypass, but UI and actions must not use `user.role === "admin"` as the primary create gate.
- Server actions must authorize against the server-resolved project before parsing user-supplied YAML or package file content.
- Package contents for authored Flows should use the existing `authored_capability_revisions.body` JSON store before adding new tables. Introduce a typed `AuthoredFlowPackageBody` with `flowYaml`, `packageMetadata`, `files[]`, and `validation` fields; add a migration only if a future query truly needs artifact-level indexing.
- Draft saving may parse and store incomplete package contents, but local publish/export/installer bridge must require a valid Flow package: valid YAML object, `flowYamlV1Schema` + graph validation, safe package file paths, no duplicate artifact paths, and no executable hook crossing trust boundaries. Phase 1 publish is not accepted until this gate exists.
- The canonical AIF package should be imported/scaffolded from the existing `plugins/aif/` bundle instead of inventing a parallel format. This plan must also schedule materializing the current AIF skills, rules, agent definitions, CLI helpers, schemas, `setup.sh`, and `README.md` into portable package files rather than deferring skills/rules/agents indefinitely.
- TDD is part of acceptance, not a later cleanup. A task is not complete until its relevant tests exist and were observed failing before the implementation change where practical.
- Every visible status, enum, role, trust state, validation state, and package state renders through EN/RU message keys. Raw enum strings are not acceptable UI copy.

## Contract Surfaces
- UI routes: `/flows`, `/flows/new`, `/flows/[projectSlug]/[capId]`.
- Server actions: project slug and capability id are form/url values, then resolved through server-state project authorization; `expectedDraftVersion` is a body-controlled optimistic-lock value and must be compared against server state.
- Existing HTTP routes already available for authored catalog: `/api/projects/{slug}/catalog/caps*`. If package artifact CRUD or export is exposed over HTTP instead of server actions, update `docs/api/web.openapi.yaml` in the same task.
- Existing HTTP routes already available for installed packages: `/api/projects/{slug}/flow-packages/*`. The installer bridge must reuse these only after an explicit trust decision; do not add a body-controlled filesystem path.
- CLI surfaces planned: `pnpm --filter maister-web validate-authored-flow`, `export-authored-flow`, and `import-flow-package-draft` only if the implementation adds scripts under `web/scripts/`. Any new package script must update `web/package.json`, `docs/getting-started.md`, and the relevant `CLAUDE.md`/docs script list.
- No new env var, bound port, sidecar process, or compose wiring is planned for the authored/package-management slices. If an output root becomes configurable, add `.env.example`, `docs/configuration.md`, and compose wiring in the same phase.
- Docs/spec files to update when broadening beyond this slice: `docs/system-analytics/capability-catalog.md`, `docs/system-analytics/flow-packages.md`, `docs/configuration.md`, `docs/flow-dsl.md`, `docs/api/web.openapi.yaml` only if an HTTP API is added, and `docs/database-schema.md` + `docs/db/erd.md` only if a migration is added.

## Plan Refinement Findings
- Missing task: define typed authored Flow package body before building a contents manager.
- Missing task: validate authored `flow.yaml` with the same manifest/graph rules as installed packages before publish/export.
- Missing task: add a docs-first contract update for the new authoring/export semantics.
- Missing task: add CLI/import-export tasks because the user explicitly wants portable packages and tooling.
- Dependency fix: installer bridge must come after export + trust review, not immediately after the contents manager.
- Scope correction: package setup execution remains out of the editor; it belongs only in the existing M10 trust -> setup -> enable lifecycle.

## Review Fixes Applied To This Plan
- High: Phase 1 is re-opened. The existing listing/create/edit prototype is not accepted until project-scoped create authorization, TDD coverage, and page/action role gates pass.
- High: Creation now follows project `manageCatalog`, matching edit/publish and the M25 authored catalog model.
- Medium: Publish validation is pulled into Phase 1 acceptance instead of being deferred behind an exposed publish button.
- Medium: EN/RU enum/status translation is a Phase 1 acceptance requirement.
- Medium: AIF package skills, rules, agents, and CLI helpers are now a concrete package-materialization task.
- Medium: Specs-first is now Task 1, before UI/action implementation.
- Low: Installed-package listing should reuse the existing package query/read model where possible, or carry an explicit `// FIXME(any):` if a temporary raw-SQL seam is unavoidable.
- Low: YAML/package parsing follows authorization, not the other way around.
- Low: `/flows` gets project/status/filter URL state in the first accepted listing slice.

## Tasks

### Phase 0: Specs First
- [x] Task 1: Author the acceptance spec before accepting any Phase 1 code.
  Files: `.ai-factory/plans/feature-platform-flows-management.md`, `docs/system-analytics/capability-catalog.md`, `docs/system-analytics/flow-packages.md`, `docs/configuration.md`, `docs/flow-dsl.md`.
  Acceptance: spec defines Draft, Published local catalog content, Exported portable package, Installed executable package, and Enabled project attachment; spec names project-scoped `manageCatalog` as the authoring permission; spec states publish/export/install validity gates; spec lists EN/RU enum rendering requirements; spec states the first accepted slice must include red -> green tests.
  LOGGING REQUIREMENTS: no runtime logging; record decisions in this plan and keep any new runtime logs structured.

### Phase 1: First Usable Management Surface
- [x] Task 2: Add red -> green tests for the first usable surface before accepting the prototype.
  Files: tests under `web/lib/queries/__tests__/`, `web/app/(app)/flows/__tests__/`, or the closest existing route/action test convention.
  Acceptance: tests cover listing authz filtering for global admin, project admin/owner, project member/viewer, and non-member; create/update/publish action authz boundaries; optimistic-lock conflict; YAML parse/schema failure; invalid publish refusal; `/flows/new` project-role create gate; raw enum translation coverage where practical; confirm runner globs execute the tests with `pnpm --filter maister-web exec vitest list`.
  LOGGING REQUIREMENTS: test logs must not include raw YAML, package files, or secrets.
- [x] Task 3: Fix create/edit/publish authorization and parsing order.
  Files: `web/app/(app)/flows/actions.ts`, `web/app/(app)/flows/new/page.tsx`, `web/app/(app)/flows/[projectSlug]/[capId]/page.tsx`, `web/lib/authz.ts` only if the existing `manageCatalog` action lacks a needed helper.
  Acceptance: create CTA appears for users who can `manageCatalog` in at least one project; `/flows/new` requires selecting or resolving a project before creation; global-member project admins/owners can create drafts; non-admin project members/viewers cannot create/edit/publish; actions authorize the server-resolved project before parsing YAML or package content; body-controlled project/capability identifiers are never trusted without server lookup.
  LOGGING REQUIREMENTS: action failures use existing structured service logging with `{ projectId, capId?, action, code }`; never log YAML or package bodies.
- [x] Task 4: Add the `/flows` listing with accepted filters, translated status copy, and a typed installed-package read path.
  Files: `web/lib/queries/platform-flows.ts`, `web/lib/queries/flow-packages.ts` if reusable, `web/app/(app)/flows/page.tsx`, `web/messages/en.json`, `web/messages/ru.json`.
  Acceptance: listing shows authored Flow drafts/published local catalog entries and installed executable package attachments across accessible projects; URL-synced filters cover project and status/package state; displayed status/trust/enablement/source labels are translated through EN/RU keys; installed package rows reuse the existing package query/read model when practical, or raw SQL carries an explicit `// FIXME(any):` with a reason and typed boundary.
  LOGGING REQUIREMENTS: query layer remains read-only and silent; authorization failures use existing authz logs.
- [x] Task 5: Add create/edit/publish actions for authored Flow YAML drafts with the publish validity gate.
  Files: `web/app/(app)/flows/actions.ts`, `web/app/(app)/flows/new/page.tsx`, `web/app/(app)/flows/[projectSlug]/[capId]/page.tsx`, `web/lib/flows/package-authoring.ts`, `web/lib/config.ts` if a string-based manifest validator is extracted.
  Acceptance: admins can create/name/save drafts; draft save records parse/schema/graph validation status; publish requires valid `flowYamlV1Schema` plus graph validation; invalid drafts remain visibly non-runnable and cannot publish; optimistic locking prevents lost updates; YAML parse failures fail fast with actionable field context.
  LOGGING REQUIREMENTS: action failures throw `MaisterError` with project/capability context through existing service logs; validation status changes log `{ projectId, capId, draftVersion, status, issueCount }`; no raw YAML is logged.
- [x] Task 6: Turn the left-rail Flows item into a real navigation target and add complete EN/RU strings.
  Files: `web/components/chrome/left-rail.tsx`, `web/messages/en.json`, `web/messages/ru.json`.
  Acceptance: rail navigation reaches `/flows`; all new labels, empty states, status pills, trust states, enablement states, validation states, buttons, and errors have EN/RU entries; no raw enum is rendered as user-facing copy.
  LOGGING REQUIREMENTS: no runtime logging.

### Phase 2: Package Authoring Expansion
- [x] Task 7: Define typed authored Flow package body and validation helpers without adding a DB table unless query needs prove it.
  Files: `web/lib/catalog/authored-types.ts`, `web/lib/catalog/authored-schema.ts`, new `web/lib/flows/package-authoring.ts`, tests under `web/lib/flows/__tests__/package-authoring.test.ts`.
  Acceptance: `AuthoredFlowPackageBody` includes `flowYaml`, `packageMetadata`, `files[]`, and `validation`; file kinds cover `asset`, `skill`, `rule`, `script`, `agent_definition`, `schema`, `template`, `readme`, and `setup`; safe relative paths reject absolute paths, `..`, duplicate paths, and non-text/binary payloads; scripts are represented but never executed; unclassified portable text files import as `asset` instead of being dropped.
  LOGGING REQUIREMENTS: log validation failures with `{ projectId, authoredCapabilityId, packageSlug, artifactKind, artifactPath, reason }`; never log file contents or secret-looking values.
- [x] Task 8: Add package contents management UI for authored Flow packages.
  Files: route components under `web/app/(app)/flows/[projectSlug]/[capId]/`, shared components under `web/components/flows/`, EN/RU keys in `web/messages/en.json` and `web/messages/ru.json`.
  Acceptance: project admins can add/edit/remove package files by kind; the UI shows flow.yaml, package metadata, file inventory, validation status, and local publish/export readiness; viewers can inspect but not edit; controls are compact and consistent with the current workbench style.
  Current status: implemented. The detail page shows flow.yaml, package metadata, inventory, validation, publish/export readiness, and typed add/edit/remove controls by file kind while serializing package files through the server action boundary.
  LOGGING REQUIREMENTS: server actions log create/update/remove with `{ projectId, capId, draftVersion, artifactKind, artifactPath }`; never log contents.
- [x] Task 9: Materialize the canonical AIF package contents as portable package artifacts.
  Files: `plugins/aif/`, `.codex/skills/`, `.claude/`, `.agents/`, `.ai-factory/rules/`, new package artifact templates under `plugins/aif/` as needed.
  Acceptance: package inventory includes `flow.yaml`, `README.md`, `setup.sh`, schemas, relevant AIF skills, project rules, agent definitions, and CLI/helper scripts when they are part of the portable experience; managed source directories are read as inputs, not hand-edited; package file paths are safe and stable; unsupported adapters are explicitly marked unsupported instead of silently omitted.
  LOGGING REQUIREMENTS: no runtime logging; scripts added in this task must log only artifact paths, counts, and validation status.
- [x] Task 10: Import/scaffold the canonical AIF package as an authored Flow package draft.
  Files: `plugins/aif/`, new `web/scripts/import-flow-package-draft.ts`, `web/package.json`, optional UI action under `/flows/new`, tests under `web/lib/flows/__tests__/package-authoring.test.ts`.
  Acceptance: importer reads a local package directory (`plugins/aif` by default), captures `flow.yaml`, `README.md`, `setup.sh`, schemas, skills, rules, agents, templates, and CLI/helper scripts into `AuthoredFlowPackageBody`; it refuses unsafe paths and missing/invalid `flow.yaml`; it creates a Draft authored Flow rather than an installed package.
  LOGGING REQUIREMENTS: log import start/end with `{ projectSlug, sourceDir, packageSlug, fileCount, validationStatus }`; redact file bodies and setup script content.
- [x] Task 11: Add export tooling that writes an authored Flow package to a portable git-ready directory.
  Files: new `web/scripts/export-authored-flow.ts`, `web/package.json`, `web/lib/flows/package-authoring.ts`, docs in `docs/getting-started.md` and `docs/configuration.md`.
  Acceptance: CLI accepts project slug, authored Flow id/slug, and output directory; export writes via temp directory + rename; output includes `flow.yaml` plus typed package files in their relative paths; export refuses invalid package validation status; export does not run setup or mutate `flow_revisions`/`flows`.
  LOGGING REQUIREMENTS: log export intent, destination, content hash, manifest digest, and file counts with structured fields; warn on overwrite refusal; never log contents.
- [x] Task 12: Add focused tests for authored package validation, UI permissions, import, and export.
  Files: `web/lib/flows/__tests__/package-authoring.test.ts`, route/action tests under `web/app/(app)/flows/__tests__/` or API-route tests if HTTP routes are added, message-key tests if a local pattern exists.
  Acceptance: tests cover safe path rejection, duplicate path rejection, invalid YAML, schema-invalid manifest, publish/export refusal for invalid drafts, non-admin edit refusal, raw enum translation coverage, AIF package materialization/import, and export directory contents; confirm runner globs execute the tests with `pnpm --filter maister-web exec vitest list`.
  LOGGING REQUIREMENTS: tests assert sensitive file bodies are not present in logs when log capture is practical; otherwise document why not.

### Phase 3: Installer Bridge (Trust-Gated, Later)
- [x] Task 13: Design and document the authored export -> install bridge before wiring execution.
  Files: `docs/system-analytics/flow-packages.md`, `docs/system-analytics/capability-catalog.md`, `docs/api/web.openapi.yaml` if a route is added, `docs/decisions.md` if a new ADR is warranted.
  Acceptance: docs specify fetch/export -> trust -> setup -> enable ordering; identifiers are classified (`slug` url-param, `capId` server-state after lookup, revision id server-state, no body filesystem path); failure classification covers validation, trust missing, setup failure, and source/path mismatch.
  LOGGING REQUIREMENTS: no runtime logging; docs specify expected `FLOW_INSTALL` stage fields.
- [x] Task 14: Implement the bridge only after Task 13 passes review.
  Files: `web/lib/flows/lifecycle.ts`, `web/lib/flows.ts`, package route/action under `web/app/(app)/flows/` or `web/app/api/projects/[slug]/flow-packages/`, and tests under `web/app/api/projects/[slug]/flow-packages/__tests__/` if HTTP is used.
  Acceptance: bridge creates or selects an exported package revision without executing setup before explicit trust; local authored sources are not auto-trusted for executable setup unless an explicit policy decision says so; enablement uses existing M10 `enableRevision`; removal/rollback/run pinning semantics stay unchanged.
  LOGGING REQUIREMENTS: preserve existing `FLOW_INSTALL` stage tags; setup execution logs `{ source, version, revisionId, stage, exitStatus, stderrSummary }` after trust only.

## Acceptance Criteria
- `/flows` is no longer a coming-soon rail item.
- A project admin/owner, including one whose global role is only `member`, can create an authored Flow draft, name it, save YAML, and publish it locally when the package is valid.
- Published authored Flow content remains inert: no install cache write, no symlink, no setup execution, no launch enablement.
- Installed Flow package attachments are visible from the same section and link back to existing project package controls.
- Non-admin users can view accessible Flow/package inventory but cannot create or edit authored flows.
- YAML parse/schema/graph failures fail fast with actionable context after project authorization has succeeded.
- Phase 1 includes red -> green tests for listing authz, action authz, optimistic locking, YAML validation, invalid publish refusal, and page role gates.
- `/flows` has URL-synced project/status filters before the listing is accepted.
- EN/RU message keys cover every visible enum/status/trust/enablement/validation state; raw enums are not rendered as user-facing copy.
- Authored Flow package bodies can represent `flow.yaml`, skills, rules, scripts, agents, schemas, setup hooks, and package metadata as typed files.
- Invalid authored packages can be saved as drafts only when clearly marked invalid; they cannot publish, export, install, or launch.
- Exported authored packages are portable directories suitable for committing to git and importing into another MAIster instance.
- The canonical `plugins/aif` package includes or imports the relevant AIF skills, rules, agent definitions, schemas, setup hook, README, and CLI/helper scripts as typed portable artifacts, then can be imported/scaffolded into the authored catalog as a draft without becoming an installed executable package.
- Any future installer bridge preserves M10 run-pinning, rollback, remove guards, and fetch -> trust -> execute ordering.

## Commit Plan
- **Commit 1** (tasks 1-6): `feat: add tested platform flows management surface`
- **Commit 2** (tasks 7-9): `feat: model authored flow package contents`
- **Commit 3** (tasks 10-12): `feat: export authored flow packages`
- **Commit 4** (tasks 13-14, later): `feat: bridge authored packages to installer`
