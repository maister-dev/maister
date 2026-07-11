# Implementation Plan: Forked-Package Loop, Complete (G1–G6)

Branch: claude/forked-package-loop-ef6b2f
Created: 2026-07-11
Mode: Full (SDD+TDD, docs-first Phase 0 gate)

Closes the ENTIRE fork-loop from the strategy audit §6 in one milestone:
fork → edit → attach → run fork-vs-upstream → compare → sync with moved
upstream → PR back — including G3 (upstream re-sync) and G4 (local catalog
sources). Owner locked this scope 2026-07-11 («сюда же все»).

## Settings

- Testing: yes (SDD+TDD — governed by the "TDD Execution Contract" section
  below: RED→GREEN→refactor per task, level separation with minimum overlap,
  no trivial tests; per-phase suite-green gates)
- Logging: standard — **repo idiom, not verbose scaffolding**: `web/lib/**` is
  console-free (verified: 0 `console.*` in `lib/`); every known domain failure
  throws typed `MaisterError` with a `code` from the existing taxonomy
  (`CONFIG | PRECONDITION | CONFLICT`; no new codes in this milestone). Client
  boundaries may use `// eslint-disable-next-line no-console` +
  `console.warn/debug("[namespace] msg", {context})` only where the touched
  component already does (e.g. `local-package-editor.tsx:139`).
- Docs: yes — docs-first Phase 0 gate + mandatory final docs checkpoint.

## Roadmap Linkage

Milestone: "none"
Rationale: ROADMAP.md's milestone ledger ends at M40 while later milestones
(M41/M42) live only in docs; this work's identity is ADR-129 ("forked-package
loop"). A milestone number (M43+) is allocated at merge together with the
ADR/migration renumber pass (four-way contest, see Numbering).

## Verified Context (recon 2026-07-11 on this branch = main @ 5916d4ea8)

The planning request's audit (@ 52e72ade3) still holds — the only commit since
touches `.ai-factory/skill-context/**` exclusively. Recon corrections that
change task scope:

1. **`web/components/board/package-actions.tsx:242/451` is the M10
   flow-package surface** (install/upgrade of individual flows), NOT the
   whole-package attach. The real "Add package" attach is
   `web/components/board/panels/project-packages-section.tsx:90-92` and it
   already posts `{packageInstallId}` to `POST /api/projects/[slug]/packages`
   (`attachBodySchema` at `web/app/api/projects/[slug]/packages/route.ts:28-30`)
   — the same contract as Studio's `attach-to-project-button.tsx:64-68`.
   → G5 narrows to: get local-cut installs into the picker + name-uniqueness UX.
2. **There is no retry-force in the local-package publish path.**
   `publishLocalPackage` calls `pushBranch` without `force`
   (`web/lib/local-packages/publish.ts:203-208`); non-FF already throws
   `GitPushRejectedError` (CONFLICT, `canForce: true`,
   `web/lib/worktree.ts:906-911`). Force-capable callers are only
   `web/lib/git-remotes.ts:164` and `web/lib/persist-config.ts:251` (other
   domains). → W-G publish work = per-source base branch + typed
   "upstream moved — sync first" refusal shape + a regression pinning
   "package publish never forces".
3. **The ADR-124 "experiment runs never auto-promote" invariant is UNENFORCED
   in code.** The auto-promote candidate SQL
   (`web/lib/scheduler/handlers/auto-promote.ts:95-143`) has no
   `experiment_runs` filter; `evaluateAutoPromotion`
   (`web/lib/auto-promotion/evaluate.ts:130-250`, 16 terms) never references
   membership; experiment runs launch with `promotionHold = null`
   (`web/lib/services/runs.ts:1372-1378`) and reach `Review`. A lane-enabled
   project WOULD auto-promote a member run today. → T9 adds the exclusion
   (sweep prefilter + evaluate term), required before packagePin variants ship.
4. **Provenance is derivable without a runs migration.** `runs.flowRevisionId`
   (FK, `schema.ts:1411`) + `runs.flowRevision` (resolved-SHA text,
   `schema.ts:1407`) are snapshotted at launch (`runs.ts:1405-1407`);
   `resolvePackageProvenanceByRevision`
   (`web/lib/local-packages/versions.ts:401-423`) already joins
   `package_installs.resolvedRevision = runs.flowRevision` — today filtered to
   local cuts (`sourceLocalPackageId IS NOT NULL`); T10 extends it to upstream
   installs.
5. **`capabilityOverlay` is validated but not threaded into `launchRun`**
   (only consumed at comparison time, `materialization-delta.ts:90`). The new
   `packagePin` axis therefore needs EXPLICIT wiring through
   `launchExperimentVariants` → `launchRun` (`launch.ts:422-447`), it does not
   come for free from the variant config.
6. **Composition view has 7 tabs = flows, skills, subagents, agents, mcps,
   rules, files** (`web/lib/local-packages/composition.ts:23`); there is no
   manifest tab (manifest edits go through the flow canvas /
   `package-manifest-form.tsx`). W-D UI plans accordingly.
7. **No production sweep deletes `package_installs` rows** — "GC'd source"
   means the on-disk bundle is missing or the lineage FK was nulled
   (`onDelete: set null`, `schema.ts:3218`); `loadInstallSource`
   (`web/lib/local-packages/fork.ts:47-86`) is the existing CONFIG-typed guard
   to reuse for degradation.
8. **Trust for local paths is already policy-trusted**: `resolveTrust`
   (`web/lib/flows/trust.ts:31-52`) maps `file://`/absolute-path sources to
   `trusted_by_policy`. W-F keeps this policy (admin-only registration is the
   gate) and documents it as an explicit ADR decision; setup execution stays
   gated on `trustStatus !== "untrusted"` (`install.ts:253-264`,
   `attach.ts:604-622`) — fetch→trust→execute ordering unchanged.

## Decisions

Owner-locked (2026-07-11): **D1** ephemeral pin targets an install, attachment
NOT required · **D2** `try_once` ships now in the launch version-choice dialog
· **D3** divergence/sync operate on local install bytes, no git-remote fetch
for comparison.

Planner resolutions (argued here per request):

- **D4 (persistence)**: variant `packagePin` lives in the existing
  `experiments.variants` jsonb (`schema.ts:1586`) — no experiments migration.
  Run provenance rides the existing `runs.flowRevisionId`/`runs.flowRevision`
  snapshot — no runs migration. Fork-sync lineage advance updates the existing
  `local_packages.source_install_id`/`source_ref` in place — no new lineage
  column. **One migration (0093)** with exactly three additions:
  `package_sources.kind` (`'git' | 'local'`, NOT NULL DEFAULT `'git'`),
  `package_sources.base_branch` (text NULL), `local_packages.sync_state`
  (jsonb NULL — durable sync intent + conflicted-file list).
- **D5 (fork sync mechanism)**: synthetic 3-way merge on install bytes ONLY
  (base = original `source_ref` install bytes via lineage, theirs = new-tag
  install bytes, ours = fork working dir at HEAD). Clone-with-history for new
  forks is REJECTED, not deferred silently: it creates a second sync path to
  test forever, breaks `forkPackageToLocal`'s dedup/lineage assumptions
  (`fork.ts:113-137`), and D3's byte-level comparison covers the need. All
  existing forks work identically. **Merge-shaped, NOT rebase-shaped**
  (owner-clarified 2026-07-11): fork repos are fresh `git init` with zero
  shared ancestry with upstream — there are no commits to replay; sync lands
  as exactly ONE commit on top of the fork's history (clean case: the
  auto-commit `Sync from upstream <tag>`; conflict case: the user's
  resolution commit). Local fork commits are never rewritten.
- **D6 (conflict UX)**: confirmed — standard conflict markers in the working
  dir + a conflicted-files list in the editor (idiom:
  `change-review-dialog.tsx:140-151` invalid-artifact list). No richer merge
  UI this milestone; resolution happens in the in-app file editor or locally
  on disk.
- **D7 (local-source re-check cadence)**: on-demand refresh button only (the
  existing `/{id}/refresh` route re-digests for `kind: local`). NO M24
  scheduler wiring in this milestone — that would drag in the
  background-automation contract (progress/backoff/poison rules) for no core
  value. Optional follow-up, out of scope.
- **ADR count: ONE (ADR-129)**. The request allowed arguing for two
  (comparison loop vs sources/sync). One is right: single migration, one
  interlocking loop contract (pin ⇄ sync ⇄ publish reference each other), and
  the four-way number contest gets strictly worse with two numbers to defend.
- **Sync preconditions** (owner-confirmed 2026-07-11): sync REQUIRES a clean
  working tree (uncommitted edits → `PRECONDITION` "commit or discard first";
  no auto-stash). This makes "local edits are never silently lost" structural
  (pre-merge state is always a commit) and makes abort/idempotent-re-sync
  trivial (reset to HEAD).
- **`try_once` offer condition** (owner-confirmed 2026-07-11): offered exactly
  when `adopt` is offered (a newer cut exists, `versions.ts:181`). No
  "cut-and-try-once" combo this milestone.
- **Cut-dialog multi-adopt semantics** (owner-confirmed + NARROWED
  2026-07-11): multi-select lists ONLY projects whose current attachment
  install is already a cut of THIS local package
  (`package_installs.sourceLocalPackageId = <localPackage.id>`) → pin advance
  via `upgradeAttachment` (`attach.ts:853`). Projects attached to the
  UPSTREAM install (same package name) are NOT listed and never silently
  migrated onto the fork — switching an upstream consumer to a fork stays an
  explicit per-project action in the packages UI. Fresh attach stays the
  existing single `attachToProjectId`.

## Numbering & Parallel-Branch Contest

- **ADR-129** — re-verified at plan entry: `docs/decisions.md` max is ADR-128
  (`### ADR-128` at line 10851). FOUR-way contested (agent-format-superset
  07-07 · Postgres/graph cut-over 07-11 · enforcement-flip 07-11 · this).
- **Migration 0093** — re-verified: `web/lib/db/migrations/meta/_journal.json`
  max idx 92 (`0092_graded_runner_resolution`, snapshot triple intact). Brain
  lineage untouched.
- A migration is a TRIPLE: SQL file + `_journal.json` entry +
  `meta/0093_snapshot.json` — generate via `drizzle-kit generate`, never
  `--custom` (stale-snapshot trap), and verify the newest journal entry has a
  matching snapshot.
- **Budget an explicit renumber pass at merge** (own focused session, after
  rebasing onto main): re-grep `### ADR-` max and journal max; later-landing
  sibling plans renumber. `pnpm validate:docs` does NOT prove numbering —
  run `node scripts/validate-docs-adr-anchors.mjs` (in `validate:docs:all`)
  AND the manual max-grep.
- Prefer number-agnostic prose in long-lived comments ("the fork-loop ADR"),
  never "since 0093".
- **Mutual rebase awareness**: no expected file overlap with the three sibling
  plans. If the Postgres/graph cut-over lands first, all fixtures here are
  already nodes-only by construction (mandatory: every test manifest in this
  plan uses the `nodes[]` DSL, never legacy `steps[]`).
- Engine: **no manifest schema change → no engine bump** (stays as-is).

## Deployment wiring

None. No new env vars, ports, sidecar processes, or runtime config files.
The migration flows through the existing `pnpm --filter maister-web
db:migrate`. (`.env.example`, compose files untouched — stated explicitly per
plan rules.)

## Contract Surfaces (spec files that MUST move with the code)

| Surface | Change | Spec file(s) |
| --- | --- | --- |
| `POST /api/runs` body | `packageVersions[].option` gains `try_once`; per-run pin semantics | `docs/api/web.openapi.yaml` `/api/runs` (~line 3523) + `docs/system-analytics/local-packages.md` |
| `GET /api/runs/launch-options` | offers `try_once` in `offeredOptions` | `web.openapi.yaml` (~941) |
| `POST /api/projects/{slug}/experiments` | variant `config.packagePin` | `web.openapi.yaml` (~2607) + `docs/system-analytics/experiments.md` |
| `GET …/experiments/{id}/comparison` | per-run `provenance` DTO field | `web.openapi.yaml` (~2836) + `docs/screens/projects/project-experiments.md` |
| `POST/PATCH /api/admin/package-sources(/{id})` | `kind`, `baseBranch` fields; local-path validation errors | `web.openapi.yaml` (~7864/7919) + `docs/system-analytics/packages.md` |
| `POST /api/admin/package-sources/{id}/refresh` | `kind: local` re-digest semantics | `web.openapi.yaml` (~7973) |
| `GET /api/studio/local-packages/{id}/divergence` | NEW route | `web.openapi.yaml` + `docs/system-analytics/local-packages.md` |
| `POST /api/studio/local-packages/{id}/sync` + `/sync/resolve` + `/sync/abort` | NEW routes | `web.openapi.yaml` + `local-packages.md` state machine |
| `POST /api/studio/local-packages/{id}/cut-version` | body gains `attachToProjectIds?: string[]` | `web.openapi.yaml` (~8221) |
| `POST /api/studio/local-packages/{id}/publish` | 409 refusal shape `{code: CONFLICT, details.reason: "upstream_moved"}`; base-branch source | `web.openapi.yaml` (~8254) + ADR-129 |
| `POST /api/projects/{slug}/packages` | 409 name-collision documented with rename guidance | `web.openapi.yaml` (~8851) |
| DB columns (3) | `package_sources.kind/base_branch`, `local_packages.sync_state` | migration 0093 + `docs/database-schema.md` (§524/§558) + `docs/db/erd.md` (PACKAGE_SOURCES) + `docs/db/projects-domain.md`, `docs/db/runs-domain.md` (local_packages) |
| Error taxonomy | NO new codes (CONFLICT/CONFIG/PRECONDITION reused) | `docs/error-taxonomy.md` — verify only, no edit expected |
| SSE / AsyncAPI | no changes | — |
| Flow DSL / grammar SSOT | no changes (no manifest schema change) | — |

## Non-goals

Background auto-adopt of new cuts · cross-task or cross-base-commit
experiments · marketplace/reputation/signed packages/sandboxing ·
provider-specific apps beyond the existing 4 PR adapters · direct push to the
upstream default branch (contribution stays PR-shaped) · auto-resolution of
merge conflicts · richer merge UI · package-content diffs inside the
experiment UI beyond provenance (content divergence lives in W-D) · M24
scheduler wiring for local-source re-check (D7) · clone-with-history forks
(D5 rejected).

## Commit Plan

- **Commit 1** (T1–T2b): `docs: ADR-129 forked-package loop — specs first + SDD review gate (system-analytics, ERDs, OpenAPI, screens)`
- **Commit 2** (T3): `feat(db): migration 0093 — package_sources.kind/base_branch, local_packages.sync_state`
- **Commit 3** (T4–T7): `feat(runs): ephemeral per-run package pin + try_once launch choice`
- **Commit 4** (T8–T11): `feat(experiments): packagePin variant axis, auto-promote exclusion, comparison provenance`
- **Commit 5** (T12–T14): `feat(packages): kind:local catalog sources with digest-as-version`
- **Commit 6** (T15–T16): `feat(packages): local-cut attach picker + multi-project adopt on cut`
- **Commit 7** (T17–T18): `feat(studio): fork-vs-upstream divergence view`
- **Commit 8** (T19–T21): `feat(studio): upstream sync (3-way) + publish base branch + sync-first refusal`
- **Commit 9** (T22–T23): `test(e2e): full forked-package loop + final gates/docs truing`

Commit messages: NO Co-Authored-By trailer (project convention).

---

## TDD Execution Contract (applies to every code task T3–T22)

- **RED first**: write the failing test(s) for the slice, RUN them, observe a
  wrong-code failure (not a setup error), note it in the task — only then
  implement. GREEN = minimal code to pass. Then refactor with the suite green
  (typecheck + unit + integration of the touched projects).
- **Level separation (minimum overlap)**: unit owns pure logic — refusal
  matrices, case tables, schema boundaries; integration owns wiring — DB
  effects, real git, REAL route shapes (route handler invoked, not only the
  service mock); e2e owns exactly ONE UI journey. A matrix asserted at one
  level is NOT re-asserted at another; T22 never re-proves what T7/T11/T20/
  T21 integration already proves.
- **No trivial tests**: no "valid input parses" without the paired refusal
  case; no snapshot-only tests; no asserting a mock was called when a state
  effect is observable. Every test encodes a requirement row from the Phase-0
  specs (traceable to a state-machine transition, refusal row, or acceptance
  criterion 1–8).
- **Route-contract rule** (patch 2026-07-07-18.04): every route whose OpenAPI
  body/response changes gets a route-level test asserting the documented
  fields are ACCEPTED and FORWARDED — here: `/api/runs`
  (`packageVersions.try_once`), experiments create (`config.packagePin`),
  `admin/package-sources` (`kind`, `baseBranch`), `cut-version`
  (`adoptInProjectIds`), `sync`/`sync/resolve`/`sync/abort`, `divergence`,
  publish 409 shape, `projects/{slug}/packages` 409.
- **Mid-implementation bugs**: regression test FIRST (red), then the fix.

## Definition of Done (every task)

1. RED→GREEN evidence: the observed failing run is noted in the task/PR.
2. Phase gates green: typecheck + full unit + integration (e2e where the
   phase says so); i18n EN+RU parity is enforced inside the unit suite.
3. **Spec consistency**: implementation matches the Phase-0 artifacts; any
   deviation discovered while coding updates the spec artifact IN THE SAME
   task (ADR / system-analytics / OpenAPI / screens) — silent drift is a
   defect. T23 re-derives the Contract Surfaces cross-check from the diff.
4. Acceptance traceability: the task states which behavioral acceptance
   criteria (1–8) it advances; T23 confirms all 8 covered.
5. Conventions: typed `MaisterError` codes, no string-matched errors, no
   console in `web/lib/**`; EN+RU keys land together; UI follows
   `web/CLAUDE.md` affordance conventions + `.ai-factory/rules/frontend.md`
   (icon-first buttons, green-check success glyph) and HeroUI v3 idioms;
   KISS/DRY + the repo's simplicity-first rules, SOLID at module seams — new
   libs (`divergence.ts`, `sync-merge.ts`, `sync.ts`) stay
   single-responsibility with the db handle injected per existing idiom;
   surgical changes — every changed line traces to the task.

---

## Tasks

### Phase 0 — Specs & numbering (docs-first gate; NO code before this is green)

- [x] **T1: Write ADR-129 + decisions.md index; re-verify contested numbers**
  - Files: `docs/decisions.md` (append `### ADR-129: Forked-package loop —
    ephemeral pins, package experiment axis, local sources, upstream sync`).
  - Content (one ADR, four contract sections): (a) **Ephemeral per-run pin** —
    launch resolves the task's flow revision from an explicitly named
    `package_installs` row; snapshot on `runs.flowRevisionId/flowRevision/
    flowVersion` unchanged; `project_package_attachments` NEVER mutated; full
    validation matrix (see T4) with error codes; D1: attachment not required —
    the pinned install must carry the SAME `flowRefId` as the task's flow.
    States explicitly that the terminal/recovery paths keep reading the run
    snapshot (launch-time decision persisted — existing columns).
    (b) **Amends ADR-124** — variant axis `packagePin?: {packageInstallId}`;
    replicates/judge/rubric unchanged; names the previously-unenforced
    auto-promotion invariant and the NEW two-arm exclusion (sweep prefilter +
    evaluate term). (c) **Extends ADR-088** — `package_sources.kind: git |
    local`; `url` keeps holding the location string (absolute path for
    `local`); digest-as-version `local-<digest12>` (same sentinel as cuts);
    boundary statement: Studio local packages = maister-managed git-backed
    working dirs; `kind: local` sources = arbitrary host directories; both
    funnel through `isLocalPackageSource` resolution (`install.ts:50-55`);
    trust decision: local sources inherit `resolveTrust` →
    `trusted_by_policy`, gated by admin-only registration
    (`requireGlobalRole("admin")`), fetch→trust→execute ordering preserved.
    Local sources never appear as publish targets. (d) **Fork sync + amends
    ADR-113** — synthetic 3-way on bytes (D5 with rejection rationale for
    clone-with-history); `sync_state` jsonb contract
    `{targetInstallId, targetRef, conflictedFiles: string[], startedAt}`;
    the full crash-window table (see T20) — durable intent (`sync_state`)
    persisted BEFORE disk writes, lineage advance is the AFTER-side write;
    clean-tree precondition; abort semantics; lineage advance
    `source_install_id/source_ref → new tag` on completion; publish base =
    `package_sources.base_branch ?? gitRemoteDefaultBranch ?? "main"`
    (replacing the guess-only chain at `publish.ts:213-215`, comment at
    `publish.ts:40-42`); non-FF publish → `CONFLICT` +
    `details.reason: "upstream_moved"` + sync CTA when lineage exists,
    manual-reconcile guidance when not; package publish NEVER forces
    (regression-pinned).
  - Also: re-grep `### ADR-` max and `_journal.json` max at task start
    (contest may have moved); record the observed values in the ADR header.
  - Acceptance: `pnpm validate:docs:all` green (incl. ADR anchor check);
    ADR-129 header exists before any code task cites it.
  - Logging: n/a (docs).

- [x] **T2: Sync all spec artifacts to the ADR (docs-first, complete + internally consistent)**
  - Files: `docs/system-analytics/experiments.md` (packagePin axis, provenance
    DTO, auto-promote exclusion as an enforced expectation + edge cases),
    `docs/system-analytics/local-packages.md` (divergence view; sync state
    machine `idle → syncing → conflicted → resolved` with EVERY transition and
    refusal row stated exactly as code will gate — clean-tree allow-list,
    dirty → refuse; try_once; publish base + sync-first refusal),
    `docs/system-analytics/packages.md` (source kinds, digest-as-version,
    local discovery mirror of git semantics, update-available carve by source
    kind), `docs/screens/projects/project-experiments.md` (provenance UI:
    package name, digest/version label, local-cut vs upstream badge,
    flow-revision delta beside materialization delta),
    `docs/screens/chrome/launch-dialog.md` (try_once option + hint, offer
    condition, refusal surface), `docs/screens/studio/editor.md` ("Compare
    with upstream" entry in the action cluster; sync banner states
    pending/conflicted; conflicted-file list; degraded source-missing state),
    `docs/screens/studio/local-workspace.md` (fork lifecycle gains
    upstream-sync + publish sync-first-refusal concepts),
    `docs/screens/projects/project-board.md` (Packages panel: local-cut
    picker + badge, name-collision explainer + rename path),
    NEW `docs/screens/studio/sources.md` (admin sources screen: kind toggle,
    local-path validation errors, per-source base branch, re-check button —
    follow the screens structure JTBD/Roles/Layout/States/Data&APIs/i18n),
    `docs/pv/package-management.md` (loop-closure narrative),
    `docs/database-schema.md` (§"Package management tables" line ~524 + §"Local
    package tables" line ~558: 3 new columns, migration 0093; flip stale
    "Designed" tags where the described code now exists),
    `docs/db/erd.md` (PACKAGE_SOURCES gains kind/base_branch),
    `docs/db/projects-domain.md` + `docs/db/runs-domain.md` (local_packages
    gains sync_state), `docs/api/web.openapi.yaml` (EVERY row of the Contract
    Surfaces table above: new paths `/divergence`, `/sync`, `/sync/resolve`,
    `/sync/abort`; changed bodies/enums/responses with example payloads),
    `docs/CLAUDE.md` line 108 — flip experiments glossary "(ADR-124,
    Designed)" → "Implemented".
  - Implementation-status tags (R6) on every new section: mark this
    milestone's pieces "Implemented (ADR-129)" only in the final docs
    checkpoint (T23); during Phase 0 write them as the target contract with
    the ADR reference — no section may describe code that will not exist at
    the phase HEAD it claims.
  - Acceptance: `pnpm validate:docs:all` green; every Contract Surfaces row
    checked off in the task; state machine + refusal tables enumerate ALL
    transitions (allow-lists, not deny-lists).
  - Logging: n/a (docs).
  - Mechanical gate: `pnpm validate:docs:all` green; ADR-129 +
    migration-0093 numbers re-verified same-day.

- [x] **T2b: Spec completeness & consistency review (SDD gate — closes Phase 0)**
  - Semantic review of the FROZEN T1+T2 spec set; the mechanical
    `validate:docs:all` green is a precondition, not the gate. Checklist
    recorded in the PR:
    1. R5 completeness: every touched system-analytics doc has all seven
       sections present AND updated (Purpose, Domain entities, State machine,
       Process flows, Expectations, Edge cases, Linked artifacts).
    2. Acceptance traceability: each behavioral acceptance criterion 1–8 maps
       to NAMED spec rows (state-machine transitions, refusal-table rows,
       OpenAPI paths) — the map lives in the PR description.
    3. Route completeness: every new/changed route has identifier labels,
       a status code per failure class, and example payloads in
       `web.openapi.yaml` + matching prose.
    4. Refusal tables are allow-lists phrased exactly as the guards will be
       coded (states/kinds/options enumerated — no coarse complements).
    5. Cross-artifact consistency: ADR-129 ↔ system-analytics ↔ OpenAPI ↔
       database-schema/ERDs ↔ screens docs agree on every name (sync states,
       option ids, provenance kinds, error reasons); list each checked pair.
    6. Logical holes: every sync state has an entry AND an exit; every typed
       error surfaces in a named screen state (degraded/conflict/refusal);
       no spec section describes behavior no task builds — and every task's
       behavior is specced.
    7. Adversarial pass (on paper): try to break the sync crash-window table
       (is a partial state outside the two enumerated rows reachable?) and
       the pin validation matrix (an install-state combination that slips
       through?). Record attempts + outcomes.
  - Any finding → fix the T1/T2 artifacts NOW, re-run `validate:docs:all`.
  - Exit = Phase 0 closed; ONLY then Phase 1 (T3) starts.
  - Logging: n/a (docs).
  - **T2b record (2026-07-11):**
    - Acceptance traceability map (criterion → named spec rows):
      1 → ADR-129 §b; experiments.md Variant/`provenance` entities; OpenAPI
      `ExperimentVariantConfig.packagePin`, `ExperimentRunComparison.provenance`,
      `ExperimentComparison.flowRevisionDelta`.
      2 → experiments.md Expectations "byte-identical"; local-packages.md
      try_once expectation; ADR-129 §a snapshot bullet.
      3 → ADR-129 §a validation matrix (7 refusal rows); experiments.md edge
      case "Pinned install degraded".
      4 → local-packages.md §Divergence view; editor.md §Fork ↔ upstream
      (drawer states incl. degraded); OpenAPI `/divergence` (409/422 rows).
      5 → project-board.md Packages-tab picker + explainer; OpenAPI attach 409
      `package_name_taken` example.
      6 → packages.md §Local source discovery + kind expectations; sources.md;
      OpenAPI package-sources kind/baseBranch + refresh semantics;
      publish-target exclusion rows.
      7 → local-packages.md §Upstream sync (state machine, precondition
      allow-list 6 rows, crash-window table, merge case table); ADR-129 §d;
      OpenAPI `/sync`+`/sync/resolve`+`/sync/abort`.
      8 → local-packages.md PR-to-source failure table (`upstream_moved` row +
      never-force note); ADR-129 §d publish bullets; OpenAPI publish 409.
    - Adversarial findings (BOTH fixed in the same pass): (a) `/resolve`
      marker scan was bounded to `sync_state.conflictedFiles` — a crash
      before the conflict-stamp tx leaves the list empty while markers sit on
      disk; scan widened to ALL dirty files (ADR §d + local-packages.md +
      OpenAPI). (b) Crash between the sync commit and the completion tx is
      observationally crash-window 1; specs now state the clean case commits
      only when the merge changed bytes and a no-change merge still completes
      (also covers re-sync-to-same-tag and abort-after-commit).
    - Independent reviewer findings (7, ALL fixed): (1) HIGH — "Resume" had
      no executable contract (precondition 4 refused ANY pending sync);
      contract is now Resume = same-target `POST /sync` re-invocation, FSM
      gained the re-entry edge, and `/sync/resolve` gained the
      nothing-to-resolve guard so window 1 can never advance lineage past a
      merge that never ran. (2) HIGH — resolve scan boundary contradicted
      across artifacts; unified to the UNION of listed files' current bytes
      + dirty files. (3) commit-skip carve mirrored into ADR §d +
      local-packages.md ("at most one commit"). (4) base-chain spelling
      normalized (`package_sources.base_branch ??
      gitRemoteDefaultBranch(...) ?? "main"`). (5) experiment create/launch
      descriptions + sequence diagram now enumerate packagePin validation.
      (6) editor.md refusal list gained the resolve refusals. (7) phantom
      "resolved" state prose fixed. Reviewer PASSes recorded for R5
      completeness, all name pairs, allow-list phrasing, route completeness,
      index consistency.
    - Plan-internal naming discrepancy resolved: Contract Surfaces said
      `attachToProjectIds`, T16 + TDD contract say `adoptInProjectIds` —
      specs standardized on `adoptInProjectIds`.
    - `docs/db/runs-domain.md` carries no `local_packages` entity block (FK
      comments only) — the sync_state ERD change lands in
      `projects-domain.md` + `database-schema.md` + `erd.md`
      (PACKAGE_SOURCES); no runs-domain edit required.

### Phase 1 — Migration

- [x] **T3: Migration 0093 (single file) + Drizzle schema + zod boundaries**
  - RED→GREEN evidence: catalog.test.ts kind/baseBranch cases observed red
    ("Unrecognized key(s): 'baseBranch'", kind default missing) before the
    schema fields landed; green after (19/19). Phase 1 gates: typecheck ✓,
    unit 595 files/6102 ✓, integration (testcontainers migrate()) ✓.
  - Pre-existing defects repaired to unblock `db:generate`: (a) 0089+0090
    snapshots both parented on 0088 (parallel-branch merge) → 0090.prevId
    re-parented onto 0089 (devtool metadata only); (b) 0090's stale snapshot
    had dropped the four ADR-126 promotion columns from the lineage, so the
    generator re-emitted them into 0093 — trimmed 0093 SQL to exactly the
    three ADR-129 ALTERs (0089's SQL already applied the promotion columns);
    the 0093 snapshot itself now heals the drift (full current baseline).
  - Files: `web/lib/db/schema.ts` (packageSources: `kind` text NOT NULL
    default `'git'` typed `"git" | "local"`, `baseBranch` text NULL;
    localPackages: `syncState` jsonb NULL typed
    `LocalPackageSyncState | null`), `web/lib/db/migrations/0093_*.sql` +
    `meta/_journal.json` + `meta/0093_snapshot.json` (via `pnpm --filter
    maister-web db:generate`; verify snapshot exists and journal `when` stays
    monotonic — ordering lint + boot guard already exist), zod:
    `web/app/api/admin/package-sources/route.ts` create body gains
    `kind: z.enum(["git","local"]).default("git")` (+ `[id]` update gains
    `baseBranch`), catalog types in `web/lib/packages/catalog.ts`.
  - Data preservation: additive-only. `kind` constant default `'git'` is
    correct-by-construction (every existing `package_sources.url` is a git
    URL today — local installs never wrote source rows); `base_branch`/
    `sync_state` NULL = "unset/never-synced" seeds. No backfill, no
    abort-guard needed — stated per migration rules.
  - **Consumer fan-out checklist for the new `kind` value** (each consumer
    gets its change in the named later task): `catalog.ts`
    create/update/delete + discovery refresh (T12) · `deriveUpdateAvailable`
    + `classifyVersionTargets` (`catalog.ts:93-150`) (T13) ·
    `getPublishOptions` publish-target picker (`publish.ts:123-145`) (T13) ·
    admin sources UI panel/modal (T14) · install resolution — none needed:
    `resolvePackageSource` (`install.ts:69-155`) already branches on
    `isLocalPackageSource`. Guards are allow-list (`kind === "local"` /
    `kind === "git"`), never `!== "git"` complements.
  - Tests: extend `web/lib/packages/__tests__/catalog.test.ts` (unit) for the
    body schema defaults; migration applies green on the integration
    testcontainer (every existing `*.integration.test.ts` re-runs `migrate()`
    — the suite itself is the migration gate).
  - Acceptance: `db:generate` produced the triple; `pnpm --filter maister-web
    typecheck && pnpm --filter maister-web test:unit && pnpm --filter
    maister-web test:integration` green.
  - Logging: repo idiom (typed errors only; no console).

### Phase 2 — W-A: ephemeral per-run package pin + try_once

- [x] **T4: Unit tests for pin resolution/refusals (TDD — written first, red)**
  - RED evidence: 10/11 fail as wrong-code failures (launch succeeds where
    the matrix demands refusal; enabled-revision snapshot written where the
    pinned one is asserted); the 1 pass is the intentional
    project-flow-gates regression pin. Harness discriminates the pin lookup
    from the enabled-revision site by chain shape (`.where().limit(1)` vs
    awaited `.where()`), mirroring the existing `runs` chain idiom.
  - Existing-suite migration: NONE — runs-launch-gate.test.ts asserts the
    classifier gate, orthogonal to pins; no assertion moves (plan
    anticipated some; recon found none load-bearing).
  - Files: NEW `web/lib/services/__tests__/runs-launch-pin.test.ts` (unit
    project: `lib/**/__tests__/**/*.test.ts`); extend
    `web/lib/services/__tests__/runs-launch-gate.test.ts` (existing
    precondition assertions gain pin arms — enumerate which asserts move).
  - Cases (exact refusal matrix — allow-list semantics): pinned install id
    unknown → `CONFIG` · install `packageStatus !== 'Installed'` →
    `PRECONDITION` · install `trustStatus === 'untrusted'` → `PRECONDITION`
    (local cuts arrive `trusted_by_policy` per `cutLocalPackageVersion`;
    upstream keeps its own trust) · pinned install lacks a flow revision with
    the task's `flowRefId` (join `flow_revisions.flowRefId = flow.flowRefId
    AND resolvedRevision = install.resolvedRevision`) → `CONFIG` naming both
    ids · pinned revision `schemaVersion` unsupported → `CONFIG` · engine
    min/max incompatible → `CONFIG` · revision `setupStatus`
    pending/failed → `PRECONDITION` · happy paths: local cut AND upstream
    install; project-flow gates (enabled/trust of the project `flows` row,
    `runs.ts:771-788`) still apply unchanged.
  - Acceptance: tests enumerate every row above; red before T5, green after.
  - Logging: assert typed `MaisterError.code`, never message-matching.

- [x] **T5: Implement the pin in `launchRunStaged` (core primitive)**
  - GREEN evidence: the T4 matrix 11/11 after implementing
    `resolvePinnedFlowRevision` (shared helper — used by direct `packagePin`
    AND the T6 try_once translation), hoisted before
    `applyPackageVersionChoices`; the pinned revision routes through the
    existing downstream guards (no re-select at the site). Full unit suite
    596 files/6115 green; typecheck clean.
  - `packagePin` is NOT exposed on the public POST /api/runs body (internal
    callers only — experiments + try_once translation), matching the OpenAPI
    (PostRunBody carries packageVersions only).
  - `enabledRevisionId` consumer grep (PR obligation): only
    `task-launch-config.ts` (pre-launch preview) + the launch gates
    themselves — no run-read/terminal path re-derives from the attachment.
  - Files: `web/lib/services/runs.ts` (launch input gains
    `packagePin?: { packageInstallId: string }`; resolution override at the
    effective-revision site `runs.ts:795-802`: when pinned, resolve the
    revision row from the pinned install instead of
    `resolveEffectiveFlowRevision(...) ?? flow.enabledRevisionId`, and SKIP
    `applyPackageVersionChoices` adopt/cut mutation for that package —
    attachment is never touched), `web/app/api/runs/route.ts` (body schema
    threading; `packagePin` is internal-caller-only for now — experiments
    (T8) and try_once translation (T6) feed it; if exposed on the public
    body, document in OpenAPI T2 row).
  - Identifier table (D-rule): `runId` n/a (create); `projectSlug` url-param;
    `taskId`/`flowId` body→server-state validated (existing); NEW
    `packagePin.packageInstallId` **body-controlled** → validated against the
    `package_installs` row set via the T4 matrix before ANY side effect (no
    filesystem use of the raw id; `installedPath` comes from the server row
    only and is never client-supplied).
  - Snapshot: unchanged columns (`flowVersion/flowRevision/flowRevisionId`
    from the pinned revision, `runs.ts:1405-1407`) — the terminal path
    already reads the snapshot; no re-derivation from the attachment anywhere
    (grep `enabledRevisionId` consumers on the run-read path to confirm; list
    findings in the PR).
  - Ordering: pin validation is a cheap deterministic precondition — hoisted
    BEFORE `applyPackageVersionChoices` (the shared-state mutation at
    `runs.ts:721-728`) so a refused pin never triggers adopt/revert
    compensation.
  - Acceptance: T4 green; existing launch suites
    (`runs-launch-branch/gate/materialize.test.ts`) green unmodified except
    enumerated assertion migrations.
  - Logging: typed `MaisterError` only.

- [x] **T6: `try_once` in the launch version-choice dialog**
  - RED evidence: version-adopt.integration.test.ts observed 6 failed /
    7 passed against the target contract (offer set, `{reverts,
    tryOncePins}` shape, new try_once case) before implementation; GREEN
    13/13 after. Route-contract case added to post-branch.test.ts
    (try_once accepted through the REAL body schema AND forwarded +
    paired out-of-enum refusal) — 17/17.
  - `applyPackageVersionChoices` returns `{reverts, tryOncePins}`;
    try_once validates like adopt, mutates nothing, contributes no
    AdoptRevert; translation to the pin happens INSIDE the compensation
    window (a refused translation after a same-launch adopt reverts that
    adopt); two packages both shipping the flow → CONFLICT ambiguous.
  - Enumerated-migration deviation: launch-options route.test.ts has NO
    offeredOptions assertions (plan anticipated some) — the offer contract
    is pinned in version-adopt.integration.test.ts instead;
    runs-launch-branch.test.ts mocks migrated to the new result shape.
  - EN+RU keys landed together (launch.packageVersionOption.try_once +
    launch.packageVersionTryOnceHint), JSON-validated; popover renders the
    hint when try_once is selected.
  - Files: `web/lib/local-packages/versions.ts` (`VersionAdoptOption` at `:42`
    gains `"try_once"`; `detectAvailablePackageVersions` offers it exactly
    when `adopt` is offered (`:179-182`) and carries the target `installId`;
    `applyPackageVersionChoices` (`:211-349`) — `try_once` branch validates
    like `adopt` (unknown install / unoffered option → `CONFLICT`) but
    returns a per-run pin instruction instead of calling `upgradeAttachment`;
    it contributes NO `AdoptRevert` (nothing to compensate)),
    `web/lib/services/runs.ts` (translate the try_once choice into the T5
    pin for that flow's package), `web/components/board/launch-popover.tsx`
    (`VersionChoice` at `:68`, options mapping at `:1105-1121`),
    `web/messages/en.json` + `ru.json` (`launch.packageVersionOption.try_once`
    + hint key; i18n-parity unit test enforces both).
  - Existing-test migration (enumerated): `web/app/api/runs/launch-options/
    __tests__/route.test.ts` — `offeredOptions` arrays gain `try_once`;
    `web/lib/local-packages/__tests__/version-adopt.integration.test.ts` —
    same + new case "try_once leaves attachment untouched".
  - Acceptance: dialog shows keep | adopt | cut_and_adopt | try_once; unit +
    the two migrated suites green.
  - Logging: typed errors; client dialog uses existing i18n error surface.

- [x] **T7: Integration proof — pin/try_once never mutate the attachment (real Postgres)**
  - 3/3 green on testcontainers: (1) pinned launch → attachment full-row
    byte-identical + run snapshot at the pinned revision; (2) try_once →
    same invariants, snapshot at the newer cut; (3) refused pin (install
    lacking the flow) → CONFIG, zero run rows, zero workspaces, addWorktree
    never called, attachment identical. Fixtures are nodes[] DSL with
    compat.engine_min (graph manifests refuse without it).
  - Files: NEW `web/lib/services/__tests__/runs-launch-pin.integration.test.ts`
    (integration project glob `lib/**/*.integration.test.ts`; testcontainers
    `PostgreSqlContainer("postgres:16-alpine")` per-test idiom as in
    `diff-commit-discard.integration.test.ts:1-45`).
  - Cases: (1) launch with pin → `project_package_attachments` row
    byte-identical before/after (full-row compare incl. `packageInstallId`,
    `attachedAt`); run snapshot columns point at the pinned revision;
    (2) try_once launch → same invariant; (3) pinned launch on an install
    lacking the flow → refused, NO run row, NO workspace, attachment
    untouched (compensation completeness); (4) fixtures use `nodes[]` DSL
    only.
  - Acceptance: suite green; `pnpm --filter maister-web test` (unit +
    integration) green at phase exit.
  - Logging: n/a (test).
  - **Phase 2 exit gate**: typecheck + full unit + integration green.

### Phase 3 — W-B/W-C: experiment axis + provenance (+ the missing exclusion)

- [x] **T8: `packagePin` variant axis end-to-end (create-time + fan-out)**
  - RED evidence: 4 wrong-code failures (schema rejected packagePin; fan-out
    neither threaded nor validated) before implementation; GREEN 18/18 after
    + create-route contract cases (accepted+forwarded through the REAL body
    schema, paired non-uuid refusal). Policy-axis interaction pinned:
    packagePin × runnerId × executionPolicy all apply on ONE variant.
  - Shared matrix extracted to `web/lib/packages/pin.ts` (one matrix, every
    entry point); batch validation in `web/lib/experiments/package-pin.ts`
    runs at create AND at fan-out (before the first side effect).
  - Picker feed: NEW `GET /api/projects/{slug}/experiments/pin-options`
    (readExperiments-gated, task validated against the slug project) —
    documented in OpenAPI in the same task; variant editor renders a
    server-filtered select (never free-text); EN+RU labels landed.
  - Files: `web/lib/experiments/variant-config.ts:91-97`
    (`packagePin: z.object({ packageInstallId: z.string().uuid() }).strict()
    .optional()` into the `.strict()` registry), `web/lib/experiments/
    http-schemas.ts` (flows through), `web/lib/experiments/service.ts`
    (CREATE-TIME batch validation mirroring `validateVariantOverlayBatch`
    idiom (`launch.ts:302-347`): every pinned install exists + Installed +
    trusted + carries the task-flow's `flowRefId` — "creatable now,
    unlaunchable later" is a design defect, so the create refuses early),
    `web/lib/experiments/launch.ts:421-447` (thread
    `packagePin` → `launchRun` input; re-validate at fan-out — launch stays
    authoritative), `web/components/experiments/create-experiment-modal.tsx`
    + `variant-editor.tsx` (picker listing eligible installs for the task's
    flow — filtered server-side to the T4-valid set: upstream installs of the
    attached package + local cuts carrying the flowRefId; NOT free-text),
    NEW/extended options endpoint if needed for the picker (document in
    OpenAPI), `web/messages/en.json`+`ru.json` (experiments.* keys).
  - Existing-test migration (enumerated):
    `web/lib/experiments/__tests__/variant-config.test.ts` (strict-schema
    unknown-key asserts + new axis), `web/lib/experiments/__tests__/
    launch.test.ts` (fan-out threading; runnerId/executionPolicy arms
    unchanged), `web/app/api/projects/[slug]/experiments/[experimentId]/
    launch/__tests__/route.test.ts`.
  - Policy-axis interaction tests (rule): `packagePin × runnerId` on one
    variant (both apply — pin changes recipe, runner changes executor) and
    `packagePin × executionPolicy` — explicit cases, not implied.
  - Acceptance: variants still share pinned `base_commit` + task
    (`launch.ts:383-387` untouched); judge/rubric/verdict machinery untouched.
  - Logging: typed errors.

- [x] **T9: Enforce the ADR-124 auto-promotion exclusion (two arms + wiring test)**
  - RED evidence: unit — member case failed (eligible where not_applicable
    expected); integration — prefilter temporarily disabled to observe the
    prefilter-specific red (candidates=2; promote still blocked by the
    evaluate arm — defense-in-depth demonstrated), then restored.
  - GREEN: evaluate term `experiment_member` (reader-backed, apply-site
    guard) + sweep `NOT EXISTS (experiment_runs)` prefilter + the
    runSchedulerTick through-dispatch member case; 122 unit + 14 integration
    green. Panel surfaces the reason via the enforced
    `autoPromotion.notApplicable.experiment_member` EN+RU keys (the i18n
    coverage loop made them mandatory).
  - Files: `web/lib/scheduler/handlers/auto-promote.ts` (candidate SQL
    `:95-143` gains `NOT EXISTS (SELECT 1 FROM experiment_runs er WHERE
    er.run_id = runs.id)` prefilter), `web/lib/auto-promotion/evaluate.ts`
    (`evaluateAutoPromotion` gains a `not_applicable` term keyed on
    experiment membership — the guard at the irreversible apply site, since
    `promoteRun` can be reached outside the sweep), `web/lib/auto-promotion/
    panel.ts` (term surfaces in the panel read model).
  - Tests: extend the existing auto-promote handler/evaluate suites (locate
    under `web/lib/scheduler/handlers/__tests__/` + `web/lib/auto-promotion/
    __tests__/`; enumerate the exact files in the task PR): (a) candidate
    query excludes a member run (integration), (b) evaluate term flips
    `not_applicable` on membership (unit), (c) wiring-seam: the existing
    `runSchedulerTick({jobKind: "auto_promote"})`-driven test gains a member
    run that is NOT promoted end-to-end.
  - Acceptance: a Review-state experiment member run in an
    auto-promotion-enabled project is never promoted by the sweep NOR by a
    direct evaluate/promote call path; non-member runs unaffected (regression
    arm).
  - Logging: term name in the evaluate output (existing structured verdict),
    no console.

- [x] **T10: Comparison-lab provenance (DTO + UI)**
  - RED evidence: 3 failures against the target DTO (exact-key pins +
    provenance/delta cases) before implementation; GREEN 8/8 + 124
    experiments/components tests after; fixture migrations enumerated
    (comparison-tabs, experiment-lab, verdict-panel, comparison-selection).
  - Helper extended ADDITIVELY (run-detail keeps localPackageName ??
    packageName and now shows upstream provenance too — consistent, noted);
    two-arm lookup with deterministic local-cut tie-break — proven on real
    PG: a fresh fork's cut is byte-identical to its source install (same
    digest), so both installs match one revision and local_cut wins; the
    true upstream arm asserted via a never-forked install.
  - Header badges (package · version · local-cut/upstream chip, runnerId
    idiom) + top-level flowRevisionDelta marker; tabs untouched; EN+RU keys.
  - Files: `web/lib/local-packages/versions.ts:401-438` (extend
    `resolvePackageProvenanceByRevision`: drop the local-only filter into a
    two-arm lookup — local-cut (join `local_packages`) vs upstream install —
    returning `{packageName, versionLabel, kind: "local_cut" | "upstream",
    installDigest12}`), `web/lib/experiments/comparison.ts` (per-run
    `provenance` on `ExperimentComparisonRunDTO` `:73-93`, filled in
    `buildComparison` `:371-395` from the already-fetched `runs.flowRevision`
    `:304-330`; plus a cross-variant `flowRevisionDelta` marker beside the
    existing materialization-delta), `web/components/experiments/
    variant-matrix.tsx:68-82` (header badges: package name ·
    `local-<digest12>`/tag label · local-cut vs upstream chip; runnerId badge
    idiom at `:77-81`), `web/messages/en.json`+`ru.json`.
  - Tabs (`comparison-tabs.tsx` diff/diffOfDiffs/files/gates/cost +
    verdict) semantically unchanged — provenance is header-level.
  - Tests: unit for the extended provenance helper (both arms + null
    degradation when no install matches); extend
    `version-adopt.integration.test.ts` provenance cases; DTO shape unit in
    `web/lib/experiments/__tests__/`.
  - Acceptance: lab shows per-variant provenance for A=upstream / B=fork-cut
    without touching tab semantics.
  - Logging: none (pure read path), typed errors on malformed state.

- [x] **T11: Integration proof — fork-vs-upstream experiment (real Postgres)**
  - GREEN first run: upstream install → attach → fork → edit → commit → cut →
    experiment A=upstream/B=cut → both launch from the experiment's pinned
    base commit (workspaces.baseCommit equal), two DISTINCT snapshotted
    flowRevisionIds, comparison DTO carries kind=upstream + kind=local_cut
    provenances + flowRevisionDelta=true, attachment row byte-identical,
    and (T9 join) both Review members yield candidates=0 in an
    auto-promotion-enabled project. nodes[] fixtures with real git repo for
    base-commit pinning.
  - Files: NEW `web/lib/experiments/__tests__/package-pin.integration.test.ts`.
  - Scenario: install upstream package (git fixture repo, `nodes[]` flow) →
    attach → fork → edit flow → commit → cut → create experiment variant
    A=upstream install / B=fork cut → launch both → assert: same
    `base_commit` snapshot; run A/B `flowRevisionId` point at different
    revisions; comparison DTO carries both provenances; attachment row
    byte-identical before/after; member runs excluded from auto-promote
    candidates (join with T9).
  - Acceptance: green on the integration project.
  - **Phase 3 exit gate**: typecheck + full unit + integration green.

### Phase 4 — W-F: local catalog sources (G4)

- [x] **T12: Kind-aware source CRUD + local discovery/refresh**
  - RED→GREEN: `catalog.test.ts` validation matrix (relative path CONFIG /
    missing dir CONFIG / plain file CONFIG / no-manifest CONFIG / monorepo
    ok / root-manifest ok) + local refresh re-digest observed failing on
    wrong-code (kind column absent → schema refusal; then refresh taking the
    git-clone arm for a directory path) before `assertValidLocalPackage-
    SourcePath` + `discoverLocalSourcePackages` + the kind-aware refresh
    branch landed. Bonus real bug caught: an empty walk silently overwrote
    `discovered` with `[]` → now throws CONFIG and refresh degrades keeping
    the stale snapshot. Regression pinned: git source failing the
    trusted-prefix policy still installs with setup DEFERRED.
  - GREEN: `local-source.integration.test.ts` (2 tests — re-digest changes
    label on file change, idempotent on no-op re-check) + 30 catalog unit
    tests.
  - Files: `web/lib/packages/catalog.ts` (`createPackageSource:160-190` /
    `updatePackageSource:192-218` accept `kind` + `baseBranch`; for
    `kind: "local"`: validate absolute path exists (stat) and contains
    `maister-package.yaml` at root OR ≥1 `packages/*/maister-package.yaml`
    (mirror `scanDefaultBranchManifests:281-327` semantics for a directory
    walk, no git); refresh/discovery for local sources re-digests each
    package dir via `localDirectoryContentDigest` (`flows.ts:443-460`) and
    writes `discovered` entries `{name, dir, tags: []}` + a digest-derived
    version label `local-<digest12>`), `web/app/api/admin/package-sources/
    route.ts:17-23` + `[id]/route.ts` (zod: `kind`, `baseBranch`; identifier
    table: all fields body-controlled but the route is
    `requireGlobalRole("admin")`-gated (`:56-77`) and the path is
    server-stat-validated before persistence; the stored path is used later
    only through `resolvePackageSource`'s existing local branch).
  - Trust/execution (rule): NO ordering change — install still runs
    fetch→trust→execute; local sources resolve `trusted_by_policy`
    (`trust.ts:31-52`, deliberate per ADR-129 §c). Regression test: a git
    source failing the trusted-prefix policy still installs with setup
    DEFERRED (`install.ts:253-264` path) — pin the existing behavior so the
    kind column can't loosen it.
  - Tests: `catalog.test.ts` (unit — validation matrix: relative path /
    missing dir / no manifest / monorepo ok / root ok), NEW
    `web/lib/packages/__tests__/local-source.integration.test.ts` for
    refresh-re-digest (digest changes when a file changes; stable when not —
    idempotent re-check).
  - Acceptance: register→discover works for an arbitrary host dir (e.g. a
    maister-plugins clone); re-check is on-demand only (D7).
  - Logging: typed `CONFIG` errors naming the failed validation.

- [x] **T13: Digest-as-version semantics + publish-picker exclusion**
  - RED→GREEN: by-kind carve arms observed failing while `deriveUpdate-
    Available`/`classifyVersionTargets` still blanket-skipped `local-*`
    labels (local drift reported no update); `publish.test.ts` picker case
    observed offering a kind:local source before the `kind === "git"`
    allow-list filter landed (fake-db chain extended with positional
    select slots for the kind/baseBranch projection).
  - Semantics pinned: local upgrade target = the discovered-digest install
    only; `downgrade = []` (installing an older digest impossible — D7
    re-check surfaces drift instead); Studio-cut installs (no source row →
    `sourceKind undefined`) keep the legacy skip arm.
  - Files: `web/lib/packages/catalog.ts` — `deriveUpdateAvailable:93-107` and
    `classifyVersionTargets:117-150` currently skip ALL `local-*` labels
    (`:98`); carve by SOURCE KIND instead: for attachments whose install's
    `sourceUrl` belongs to a `kind: "local"` source, a discovered digest ≠
    pinned digest label ⇒ update available (upgrade target
    `local-<newDigest12>`); Studio-cut installs (no source row) keep the
    existing skip. `web/lib/local-packages/publish.ts:123-145`
    (`getPublishOptions` filters `kind === "git"` — local sources are never
    publish targets; allow-list, not `!== "local"`).
  - Version install path: confirm `resolvePackageSource`'s local branch
    (`install.ts:78-116`) installs the CURRENT bytes and records digest as
    `resolvedRevision` — the "version" a local source offers is always its
    present digest (document: installing an older digest is not possible —
    re-check surfaces drift instead).
  - Existing-test migration: `catalog.test.ts` update-available/targets
    asserts split into by-kind arms; `publish.test.ts` (unit) gains the
    picker-exclusion case.
  - Acceptance: local-source attachment shows "update available" after the
    host dir changes + re-check; publish dialog never offers a local source.
  - Logging: none new.

- [x] **T14: Admin sources UI + end-to-end integration**
  - GREEN: `local-source-attach.integration.test.ts` full chain on real PG +
    tmp host dir — register kind:local → discover (`{name, dir}`) → install
    (digest label == discovered `digestVersionLabel`) → attach to project →
    `updateAvailable=false` → mutate host dir → re-check re-digests →
    `updateAvailable=true` → installing the fresh digest surfaces it as the
    one-click `upgradeTarget`. Passed first run (2.4s).
  - UI: modal kind radio (create-only) + localPath label switch + baseBranch
    field (git-only, SET/CLEAR via `null`), panel kind badge + digest
    install chip for tagless local entries; `loadPackageSourcesView`
    projects `kind`/`baseBranch`; admin install route derives `version:
    "local"` server-side and handles root-manifest (`dir: "."`) paths.
    47 components/settings tests + i18n EN/RU parity green.
  - Files: `web/components/settings/package-source-modal.tsx` (kind toggle
    git|local; for local: absolute-path field, server validation errors
    surfaced via the existing `apiErrors` idiom; baseBranch field for git
    sources — T21 consumes it), `web/components/settings/
    package-sources-panel.tsx` (kind badge column; re-check button per
    source — existing refresh route), `web/app/(app)/studio/sources/page.tsx`
    (wiring only), `web/messages/en.json`+`ru.json` (studio.sources* keys).
  - Tests: NEW `web/lib/packages/__tests__/
    local-source-attach.integration.test.ts` — full chain on real PG + tmp
    fixture dir: register local source → discover → install (digest label) →
    attach to project → attachment visible with `updateAvailable=false` →
    mutate fixture → refresh → `updateAvailable=true`. DOM test only if the
    modal gains logic beyond markup (follow `*.dom.test.ts` +
    `@vitest-environment jsdom` idiom if so).
  - Acceptance: an arbitrary host directory registers, discovers,
    installs, attaches like a git source with digest-as-version.
  - Logging: client boundary may `console.warn("[sources] refresh failed",
    {sourceId, err})` matching existing panel idiom if one exists; otherwise
    typed-error surface only.
  - **Phase 4 exit gate**: typecheck + full unit + integration green.

### Phase 5 — W-E: project-side attach + adopt polish (G5+G6)

- [x] **T15: Local-cut installs in the project attach picker + name-uniqueness UX**
  - RED→GREEN (3 observed wrong-code failures): query view returned
    `[undefined, undefined]` before `sourceLocalPackageId` was mapped;
    static markup dropped the name-colliding cut from the picker before the
    by-kind filter (cuts excluded by attached-install-id, upstream siblings
    still excluded by name — upgrade path pinned); dom test showed no
    explainer before the pre-flight block landed. Route RED: 409 arrived
    with `details: undefined` (and from the WRONG guard — the flow-id
    message) before the name pre-guard was hoisted ABOVE the flow guard in
    `attachPackage` (a whole-package fork collides on both, so guard order
    decides which story the user gets). `packageErrorResponse` now projects
    `details` (additive).
  - GREEN: `projects-packages-routes.integration.test.ts` 8/8 — fork cut
    beside upstream → `{reason: "package_name_taken", packageName}`; after
    manifest rename (name + flow id) + re-cut → 201, GET lists
    routepkg + routepkg-fork. Picker/dom/query units 10/10; i18n parity
    green; explainer links `/studio/edit/<sourceLocalPackageId>` and Attach
    stays disabled while colliding.
  - Files: `web/lib/queries/packages.ts` — the picker is fed by the
    `AvailablePackageInstallView` prop (type at `:66`, producing query at
    `:162`); extend THAT query to include installs with
    `sourceLocalPackageId IS NOT NULL` (local cuts) labeled with a local-cut
    badge + `local-<digest12>`;
    `web/components/board/panels/project-packages-section.tsx` renders the
    extended options (`availableInstalls` prop, `attachable` filter `:70`),
    `web/app/api/projects/[slug]/packages/route.ts` (map the
    `project_package_attachments_project_name_uq` violation
    (`schema.ts:3196`) to an explicit 409 `CONFLICT` whose details name the
    colliding `packageName` and the rename path — today it would surface as
    an opaque DB error; identifier note: `packageInstallId` body-controlled,
    already validated against `package_installs` by `attachPackage:652-657`),
    UI pre-flight: when the selected install's `name` equals an existing
    attachment's `packageName`, show the explainer BEFORE submit: "fork
    shares its upstream's package name — rename the fork (Studio → manifest
    `name` → commit → cut) to attach it beside the upstream", with a link to
    the fork's editor. `web/messages/en.json`+`ru.json`.
  - Explicitly NOT: no auto-rename, no attachment-level aliasing (the unique
    stays authoritative).
  - Tests: extend `web/app/api/__tests__/
    projects-packages-routes.integration.test.ts` — attach fork-cut beside
    upstream with same name → 409 with typed details; after manifest rename +
    re-cut → attach succeeds; unit for the extended `availableInstalls`
    query filter in `web/lib/queries/packages.ts`.
  - Acceptance: a local cut attaches from the project Packages tab;
    fork-beside-upstream surfaces the rename path, not an opaque 409.
  - Logging: typed errors; UI copy through i18n.

- [x] **T16: Cut-version dialog — multi-select "adopt in attached projects now"**
  - RED→GREEN: route unit RED observed 422 (strict schema rejecting
    `adoptInProjectIds`) across all three contract cases before the body +
    validation landed; GREEN pins: ineligible id → 409 pre-cut (cut fn never
    called), authz → 403 pre-cut, partial adopt failure → 201 with
    `adoptions: [{adopted},{failed,error}]` and exactly ONE cut; adopt-less
    body keeps the legacy shape (no `adoptions` key, eligibility query never
    consulted). Crash window (d) documented in the route comment.
  - Eligibility = the back-edge, never the name: `listAdoptTargetProjects`
    (batch-shaped, archived excluded) joins attachments ⋈ installs on
    `source_local_package_id`; fork-cut integration proves 2 cut-pinned
    projects advance to cut2 while the upstream-pinned project of the SAME
    name is not offered and its pin is byte-identical after the round.
  - UI: new `cut-version-dialog.tsx` (accessible modal per import-dialog
    idiom; default NO projects checked; ✓/✗ glyph outcomes; "retry failed"
    re-POSTs only the failed ids — safe because the cut is content-addressed
    and re-adopt is an idempotent same-install upgrade); list Cut button
    opens it; `/studio/local` page feeds `adoptTargets` client-safe
    (projectId+name only) from one batch query. Dom test pins the POST body
    (empty default / checked ids / retry subset). i18n EN+RU.
  - Eligibility (owner-narrowed): a project is offered iff its CURRENT
    attachment for this package points at a cut of THIS local package —
    attachment's install has `sourceLocalPackageId = <localPackage.id>`.
    Projects attached to the upstream install (same name) are NOT offered
    and never adopted.
  - Files: `web/app/api/studio/local-packages/[id]/cut-version/route.ts`
    (body `:32-34` gains `adoptInProjectIds?: string[]` alongside the
    existing `attachToProjectId?`; validation BEFORE the irreversible cut
    (`:89-109` idiom): per-project `requireProjectAction(id,
    "manageLocalPackages")` AND eligibility (the project's attachment install
    is a cut of this package — server-state check; ineligible id → 409
    `CONFLICT` pre-cut); after `cutLocalPackageVersion:114`, for each
    eligible project → `upgradeAttachment` (`attach.ts:853`) to the new
    install; results reported per-project `{projectId, status: "adopted" |
    "failed", error?}` — the cut itself is never rolled back by a failed
    adopt (adopt failures are retryable per-project; two-phase: cut
    (irreversible, first) → adopts (idempotent per-project after-writes);
    crash between → cut exists, adopts re-runnable from the dialog —
    enumerate this window in the route doc comment), Studio cut dialog
    component (locate the dialog that posts cut-version; add multi-select fed
    by an eligible-projects query, default none — explicit action, no
    background auto-adopt), `web/messages/*`.
  - Identifier table: `id` url-param (local package); `adoptInProjectIds[]`
    body-controlled → each validated via authz + eligibility lookup (server
    state) before ANY write; authz/eligibility failure → whole request
    refused pre-cut (nothing mutated).
  - Tests: route unit test under the route `__tests__` idiom (authz refusal
    pre-cut; eligibility refusal pre-cut — upstream-pinned project id → 409,
    no cut; partial adopt failure reporting); extend
    `fork-cut.integration.test.ts` — cut with 2 projects on this package's
    cuts → both pins advance; a 3rd project attached to the UPSTREAM install
    of the same name → not offered by the eligible-projects query and
    untouched after adopt.
  - Acceptance: G6 closed — edit→commit→cut→adopt is one dialog round-trip;
    no background adoption.
  - Logging: typed errors; per-project results in the response body.
  - **Phase 5 exit gate**: typecheck + full unit + integration green.

### Phase 6 — W-D: divergence view (fork vs source)

- [x] **T17: Divergence computation lib + route**
  - Empirically pinned `git diff --no-index` semantics first (scratchpad):
    exit 1 = differences; headers carry `a<absDir>/rel` with the leading
    slash merged into the prefix; ADDED files carry the RIGHT dir under
    BOTH prefixes — so the relativizer rewrites all four dir×prefix combos,
    on header-shaped lines only (content lines stay byte-exact).
  - `gitDiffNoIndex` (exit 0/1 success, maxBuffer → partial text +
    `truncated: true`); `divergence.ts` `computeUpstreamDivergence` — ours =
    working dir or an OWN cut (foreign `sourceLocalPackageId` → CONFLICT;
    id never a raw path), theirs = lineage install via a stat-guarded loader
    (missing row/bytes/lineage → typed CONFIG); `.git/`+runtime dirs
    block-filtered; `element` = relative-prefix scope; prepare failure
    degrades to summary (diffWorkingDir idiom).
  - Unit 7/7 (identical→empty · relative paths + .git excluded ·
    element narrowing · cut arm · foreign-cut CONFLICT · no-lineage CONFIG ·
    GC'd-bytes CONFIG) with an id-aware fake db (drizzle Param extraction —
    the source and cut lookups need DIFFERENT rows); route 4/4
    (passthrough, `..`-escape 422 at the boundary, CONFIG→422 per contract
    — switched the route to `packageErrorResponse` and closed its
    ACCOUNT_INACTIVE→500 gap to 403); fork-cut integration + divergence
    chain case 14/14 (uncommitted fork delta vs source, relative paths).
  - Files: `web/lib/local-packages/git.ts` (NEW `gitDiffNoIndex(dirA, dirB)`
    on the private `git()` runner `:21-27` — `git diff --no-index` exits 1 on
    differences: treat 0/1 as success, parse like the existing
    `diffWorkingDir` (`service.ts:671`) into the shared `DiffView` DTO shape),
    NEW `web/lib/local-packages/divergence.ts`
    (`computeUpstreamDivergence({localPackageId, cutInstallId?})`: ours = fork
    working dir (default) or a chosen cut's `installedPath`; theirs = the
    lineage source install's `installedPath` via `loadInstallSource`-style
    guard (`fork.ts:47-86`) — source row missing/`set null` or bytes gone →
    typed `CONFIG` "source install unavailable" for graceful degradation;
    exclude `.git/`; D3: purely local bytes, no network), NEW route
    `web/app/api/studio/local-packages/[id]/divergence/route.ts` (GET,
    read-only, viewer-permitted like `/diff`; query `cutInstallId?`
    validated against the package's own cut lineage
    (`sourceLocalPackageId = id`) — body-controlled id never used as a raw
    path; per-element scope param `element?` for composition-tab entries
    where element lineage exists, degrade to package-level otherwise).
  - Tests: unit `web/lib/local-packages/__tests__/divergence.test.ts`
    (fixture dirs: identical → empty; modified/added/deleted files → entries;
    missing source → CONFIG); integration: extend
    `fork-cut.integration.test.ts` — fork, edit (uncommitted), divergence
    shows the uncommitted delta vs source install.
  - Acceptance: divergence works for working dir AND chosen cut; GC'd source
    degrades with a typed error the UI can render.
  - Logging: typed errors only.

- [x] **T18: Divergence UI (editor header + composition entries)**
  - `UpstreamDivergenceDrawer` (diff-drawer pattern minus commit/discard):
    header cut-picker (working dir | each cut via new `listPackageCuts`),
    base-version chip, shared `DiffView`, and a DEGRADED panel for the typed
    CONFIG "source unavailable" refusal (distinct from generic failure).
    Editor gets `divergence: {cuts} | null` from the edit page
    (`pkg.sourceInstallId` gate) — "Compare with upstream" button renders
    only with lineage. Per-element compare: `ElementCard.compare` slot
    (server callers can't pass a callback → degrades to absent exactly where
    lineage doesn't exist; clickable-card markup unchanged when absent) wired
    through `PackageComposition.onCompareElement` for skills + subagents +
    agents + rules (mcps have no content path → silently absent), opening
    the drawer scoped to that element.
  - Dom test 4/4 (clean+base chip · degraded-on-CONFIG · DiffView + cut
    re-query · element in query). Test caught a real robustness gap: the
    unstable-`t` mock exposed a render→load loop (t dropped from load deps;
    render owns the localized headline) and a null-body 200 crash (now a
    typed error state). i18n EN+RU (`studio.divergence.*`).
  - **Phase 6 exit gate**: typecheck ✓ · unit 602 files / 6163 ✓ ·
    integration 296 files / 2237 ✓.
  - Files: `web/components/studio/local-package-editor.tsx` — "Compare with
    upstream" button in the breadcrumb action cluster (`:735-801`, next to
    Commit-state/Publish; rendered only when lineage exists), opening a NEW
    read-only `UpstreamDivergenceDrawer` (pattern:
    `local-package-diff-drawer.tsx` minus the commit/discard bar; renders
    shared `DiffView` from `web/components/workbench/diff-view.tsx` — plain
    DTO across the Flight boundary, `@git-diff-view` core-import gotcha
    respected), `web/components/studio/package-composition.tsx` /
    `ElementCard` — per-element "compare" entry only where element lineage
    exists (degrades silently to absent), cut-picker select (working dir |
    each cut) in the drawer header, degraded state panel for CONFIG
    "source install unavailable", `web/messages/en.json`+`ru.json`
    (`studio.divergence.*`).
  - Tests: `*.dom.test.ts` for the drawer states (loading/empty/degraded)
    following `package-file-navigator.dom.test.ts` idiom.
  - Acceptance: Studio divergence view diffs fork (working dir or cut)
    against its source install incl. uncommitted edits; after T20's sync it
    automatically compares against the NEW base (lineage advanced).
  - Logging: client boundary `console.warn("[divergence] load failed",
    {packageId, err})` allowed per editor idiom.
  - **Phase 6 exit gate**: typecheck + full unit + integration green.

### Phase 7 — W-G: upstream sync for forks + publish base (G3)

- [x] **T19: Synthetic 3-way merge lib (pure, heavily unit-tested)**
  - GREEN first run 17/17: every case-table row has a named test (incl. the
    two extra converged rows the table implies: deleted-in-both and
    deleted-in-ours+theirs-unchanged), add/add via a shared empty synthetic
    base, binary NUL-sniff keeps ours byte-identical, runtime dirs
    (.git/.maister/.claude) never merged, marker content matches
    `git merge-file` defaults with `-L ours -L base -L <markerLabel>`, and
    re-running on the merged clean tree returns `{[], []}` (the Resume
    idempotency guarantee). `gitMergeFile` exit >0 = conflict count.
    Bytes ride `Uint8Array` end-to-end (dual @types/node Buffer clash).
  - `cleanFiles` = paths actually written/deleted; no-op rows unlisted —
    this is what makes "at most one commit" decidable in T20.
  - Files: `web/lib/local-packages/git.ts` (NEW `gitMergeFile(ours, base,
    theirs, {markerLabel})` wrapping `git merge-file -L ours -L base -L
    theirs` — exit 0 clean, >0 = conflict count, markers written into ours),
    NEW `web/lib/local-packages/sync-merge.ts` (`mergeTrees({baseDir,
    theirsDir, oursDir})` over the union of file sets, byte-compare
    fast-paths; case table — implemented EXACTLY as enumerated: unchanged
    ours + changed theirs → take theirs · changed ours + unchanged theirs →
    keep ours · both changed same → keep · both changed different →
    `gitMergeFile` (clean or markers) · added in theirs only → add · added
    in ours only → keep · added both identical → keep · added both different
    → merge-file with empty base (add/add conflict) · deleted in theirs +
    ours unchanged → delete · deleted in theirs + ours changed →
    modify/delete conflict (keep ours, list as conflicted) · deleted in ours
    + theirs changed → delete/modify conflict (list; do NOT resurrect) ·
    binary (NUL-sniff) differing → conflict entry "binary", ours kept;
    returns `{cleanFiles, conflictedFiles}`).
  - Tests: NEW `web/lib/local-packages/__tests__/sync-merge.test.ts` (unit)
    — one case per table row + idempotency: re-running mergeTrees on the
    already-merged clean result is a no-op; conflict-marker content matches
    `git merge-file` defaults.
  - Acceptance: pure lib, no DB; every table row has a named test.
  - Logging: none (pure); typed errors for I/O failures.

- [x] **T20: Sync operation — routes, state, conflict UX (multi-store, crash-windowed)**
  - SPEC CORRECTION (docs-first): the T2 OpenAPI omitted `sessionId` from
    all three sync bodies, making the edit-lock precondition unenforceable —
    amended to required `sessionId` (commit-route idiom) before
    implementation.
  - `sync.ts`: full precondition allow-list (lock via assertHoldsLock ·
    active · lineage CONFIG · pending-different-target CONFLICT ·
    pending+dirty = window 2 → CONFLICT "resolve or abort" (Resume is
    window-1-only) · dirty-tree PRECONDITION · target must be an Installed
    install of the lineage's name+sourceUrl). Two-phase exactly as spec'd:
    tx-persist `sync_state` BEFORE disk → mergeTrees → clean: at most ONE
    commit (no-change merge skips) + ONE tx advancing lineage + clearing
    state; conflict: stamp conflictedFiles, markers stay uncommitted.
    Resolve: union marker scan (listed files + dirty files; `<<<<<<<`/
    `>>>>>>>` only — a bare `=======` is a legal markdown underline),
    nothing-to-resolve → PRECONDITION "resume", commit-with-message when
    dirty, SAME single completion tx, idempotent no-op retry. Abort:
    pending-gated, discard-to-HEAD + clear, never rewrites commits.
  - Integration 5/5 GREEN first run on real PG + git (local-dir upstream,
    digest-as-version v1/v2 installs): clean (one commit · lineage advanced ·
    T17 divergence now empty vs NEW base · same-target re-sync = no-op with
    HEAD unchanged) · conflict→marker-refusal→hand-resolve→completed→
    idempotent retry · abort byte-identical restore (+ second abort 409) ·
    precondition matrix · both crash windows by direct state injection.
    Route shell 7/7 (422 without sessionId pins the amended contract).
  - UI: `UpstreamSyncButton` (target picker; installed target → one POST;
    discovered tag → install-then-sync chain through the NORMAL install
    path) + `UpstreamSyncBanner` (pending recovery surface: conflicted list,
    Resolve with optional message, confirm-gated Abort) fed by
    `listSyncTargets`; dom tests 4/4 pin the POST bodies. i18n EN+RU.
  - Files: NEW `web/lib/local-packages/sync.ts` + routes
    `web/app/api/studio/local-packages/[id]/sync/route.ts` (POST
    `{targetInstallId}`), `sync/resolve/route.ts` (POST), `sync/abort/route.ts`
    (POST); editor UI: sync entry beside the T18 divergence entry (upstream
    tag picker fed from the lineage source's discovered tags —
    `package_sources.discovered` for `sourceRepoUrl`; "install & sync"
    installs the new tag through `installPackageRevision` (normal path, bytes
    land in the content-addressed cache) then merges), conflict banner in
    `local-package-editor.tsx` listing `sync_state.conflictedFiles`
    (`change-review-dialog.tsx:140-151` idiom) with Resolve/Abort actions,
    `web/messages/en.json`+`ru.json` (`studio.sync.*`).
  - Preconditions (allow-list): lock held (`assertHoldsLock`,
    `lock.ts:149-171`) · package `status = active` · lineage present
    (sourceInstallId row + bytes, else `CONFIG`) · NO pending `sync_state`
    (else 409 `CONFLICT` "sync in progress") · clean working tree (else
    `PRECONDITION` "commit or discard first") · `targetInstallId`
    body-controlled → must be an Installed install of the SAME package name +
    sourceUrl as the lineage (server-state comparison; mismatch → 409).
  - **Order of operations + crash windows (two-phase, enumerated — mirrored
    into ADR-129 §d)**:
    1. tx: persist `sync_state = {targetInstallId, targetRef,
       conflictedFiles: [], startedAt}` (durable intent, BEFORE any disk
       write).
    2. disk: `mergeTrees` writes into the working dir.
    3. clean case: `gitCommitWorkingDir("Sync from upstream <tag>")`, then
       one tx: advance `source_install_id/source_ref` + clear `sync_state`.
    4. conflict case: tx update `sync_state.conflictedFiles = [...]`; working
       dir holds markers (uncommitted).
    - Crash after 1 before 2: `sync_state` pending, tree clean → editor
      banner offers Resume (re-merge; idempotent: inputs unchanged) or Abort.
    - Crash after 2 before 3/4: `sync_state` pending, tree dirty with merged
      content → banner shows it as conflicted/in-review; Resolve validates +
      completes; Abort resets. NO sweep involvement — recovery is user-driven
      through the banner, and every partial state is one of the two rows
      above (no third state exists; `sync_state` is the single discriminant).
    - `/resolve`: preconditions lock + pending `sync_state` + no conflict
      markers remain in the listed files (scan) + tree committed (or commit
      as part of resolve with the user's message); then the SAME single tx as
      step 3 (advance lineage + clear). Idempotent retry: if lineage already
      advanced and state cleared → 200 no-op.
    - `/abort`: lock + pending state → `git reset --hard HEAD` (tree was
      clean pre-merge — nothing user-authored is lost, structurally) + tx
      clear `sync_state`. Never force-overwrites commits.
  - After completion, T17's divergence compares against the new base
    (lineage advanced) — assert in tests.
  - Tests: NEW `web/lib/local-packages/__tests__/sync.integration.test.ts`
    (real PG + real git fixture repo with two tags): clean merge → committed
    + lineage advanced + sync_state null · conflict → files listed, resolve →
    cut → lineage advanced · abort → tree back at HEAD byte-identical +
    state cleared · re-sync idempotency (running sync twice to the same tag:
    second → no-op/refused pending semantics) · dirty-tree refusal · crash
    windows simulated (kill between phases by direct state injection).
    Route unit tests for the precondition matrix.
  - Acceptance: local edits never silently lost (clean-tree precondition +
    abort proof); sync never force-overwrites; session-lock guarded
    throughout.
  - Logging: typed errors; `sync_state` is the durable audit of the
    operation.

- [x] **T21: Publish base branch + "upstream moved — sync first" refusal**
  - `resolvePrBase` (configured `base_branch` → remote default → "main";
    a configured base also SKIPS the network lookup) + the pushBranch
    `GitPushRejectedError` catch rethrown as CONFLICT
    `{reason: "upstream_moved", canSync: <lineage present>, localPackageId}`
    — never retried with force.
  - Integration 9/9: existing non-FF case upgraded to assert the TYPED
    details + remote SHA unchanged; NEW canSync=true arm (lineage seeded,
    remote branch moved independently via `commit-tree`+`update-ref` inside
    the bare — still not force-updated after the refusal); NEW configured
    base_branch → adapter receives `targetBranch: "develop"` (mock captures
    args). Unit 13/13 incl. `resolvePrBase` order + the no-force regression
    pin (source-level: no `force:`/`--force` in publish.ts, the force
    capability stays quarantined).
  - Dialog: typed refusal renders the "Upstream moved — sync first" panel
    (probe via `res.clone()` so the generic path keeps `readApiError`);
    canSync → "Close & sync from upstream" CTA (the header sync entry is
    the T20 surface), else manual-reconcile guidance naming the branch.
    i18n EN+RU.
  - **Phase 7 exit gate**: typecheck ✓ · unit 605 files / 6194 ✓ ·
    integration 297 files / 2244 ✓.
  - Files: `web/lib/local-packages/publish.ts` (`:213-215` becomes
    `source.baseBranch ?? gitRemoteDefaultBranch(...) ?? DEFAULT_PR_BASE`;
    catch `GitPushRejectedError` from `pushBranch:203-208` and rethrow
    `MaisterError({code: "CONFLICT", details: {reason: "upstream_moved",
    canSync: <lineage present>, localPackageId}})` — NEVER retry with force;
    delete nothing: assert no force path exists (regression below)),
    `web/app/api/studio/local-packages/[id]/publish/route.ts` (409 shape
    documented), publish dialog component (refusal renders the message + a
    "Sync from upstream" CTA linking the T20 entry when `canSync`, manual
    guidance otherwise — e.g. delete/inspect the remote `maister/<slug>`
    branch), source edit UI already carries baseBranch (T14),
    `web/messages/*` (`publishDialog.*` keys).
  - Existing-test migration (enumerated): `web/lib/local-packages/__tests__/
    publish.test.ts` (base-resolution order incl. configured base) +
    `publish.integration.test.ts` (non-FF against a local bare remote whose
    `maister/<slug>` moved → typed CONFLICT `upstream_moved`, remote branch
    NOT force-updated — assert remote SHA unchanged; with configured
    `base_branch` → PR/compare URL uses it).
  - Regression pin: grep-level test or assertion that
    `publishLocalPackage` never passes `force: true` to `pushBranch` (the
    force capability stays quarantined to `git-remotes.ts`/`persist-config.ts`).
  - Acceptance: behavioral acceptance #8 (see below) satisfied.
  - Logging: typed errors.
  - **Phase 7 exit gate**: typecheck + full unit + integration green.

### Phase 8 — e2e + final gates + docs truing

- [ ] **T22: E2E — the full loop through the UI (mock ACP adapter)**
  - Files: NEW `web/e2e/forked-package-loop.spec.ts` + **mandatory**: add the
    spec stem to the `AUTHED_SPEC` regex in `web/playwright.config.ts:26`
    (runnability rule — a spec outside the regex runs unauthenticated and
    silently misses); fixtures via `web/e2e/_seed/{db,fixtures,seed-e2e}.ts`
    + stub supervisor (`_seed/stub-supervisor.ts`, port 7788) + an on-disk
    git package fixture with two tags (idiom: `studio-local-edit.spec.ts` /
    `package-management.spec.ts`).
  - Scenario (single authed journey; heavy git/DB assertions stay in the
    T7/T11/T20/T21 integration suites — e2e proves the UI path): fork
    installed git package → edit a flow file → commit → cut → attach cut
    beside upstream (hits the rename explainer, rename via manifest, re-cut,
    attach) → create experiment A=upstream/B=fork on a task bound to the
    flow → launch (stub adapter) → comparison lab shows per-variant
    provenance + six tabs render → re-tag upstream fixture + refresh source →
    "Update fork from upstream" → conflict listed → resolve in editor →
    commit → cut → publish to a local bare remote with configured base
    branch → non-FF case shows "sync first" refusal.
  - Infra notes (pinned in the spec header): ports 3100/7788 + `maister_e2e`
    DB are shared across ALL worktrees — kill stale listeners first;
    baseline-prove on a red run before blaming the branch.
  - Assertion style: stable user-visible labels/testids only — never
    implementation text (renderer swaps invalidate text matching; lesson
    from patch 2026-07-04-14.25).
  - Acceptance: `pnpm --filter maister-web test:e2e` green locally with
    Docker up.
  - Logging: n/a (test).

- [ ] **T23: Final gates + docs checkpoint (mandatory)**
  - Run and record: `pnpm --filter maister-web typecheck` · `pnpm --filter
    maister-web test:unit` (includes `lib/__tests__/i18n-parity.test.ts` —
    EN+RU key parity is enforced here) · `pnpm --filter maister-web
    test:integration` (real-Postgres testcontainers; Docker required) ·
    `pnpm --filter maister-web test:e2e` · `pnpm validate:docs:all` ·
    `pnpm --filter maister-web lint` check-only via `eslint .` (NEVER bare
    `pnpm --filter maister-web lint` — it reformats the repo).
  - Docs truing: flip Phase-0 sections' status tags to
    "Implemented (ADR-129)"; re-verify `docs/CLAUDE.md:108` flip landed;
    sweep `docs/database-schema.md` "Designed" tags touched by this work;
    confirm the Contract Surfaces table — every row's spec file actually
    changed (re-derive from `git diff --name-only` as the cross-check).
  - Numbering re-check: re-grep ADR max + journal max one last time (contest
    may have moved during implementation); if taken, renumber NOW (ADR
    header + all `[ADR-129]` anchors + migration triple rename + prose
    greps `0093`/`ADR-129`).
  - Acceptance: all six gates green with output recorded in the PR
    description; plan checklist fully ticked.

---

## Acceptance (behavioral — from the owner request, verbatim targets)

1. Fork an installed git package → edit a flow → commit → cut → on a task
   bound to that flow, create an experiment with variant A = upstream
   install, B = fork cut; both launch from the same pinned base commit;
   comparison lab shows per-variant provenance + the usual tabs. (T8/T10/T11)
2. The project's attachment pin is byte-identical before/after the experiment
   and after any try_once launch. (T7/T11)
3. A variant/try_once pin on an install lacking the flow id, untrusted, or
   not Installed refuses with a typed error naming the reason. (T4/T8)
4. Studio divergence view diffs the fork (working dir or cut) against its
   source install, incl. uncommitted edits; GC'd source degrades gracefully.
   (T17/T18)
5. A local cut attaches from the project Packages tab; fork-beside-upstream
   surfaces the name-uniqueness requirement with a rename path. (T15)
6. An arbitrary host directory registers as a `kind: local` source; its
   package(s) discover/install/attach like git sources with
   digest-as-version; it never appears as a publish target. (T12–T14)
7. Upstream releases a new tag → "Update fork from upstream" 3-way merges:
   clean case commits; conflict case lists conflicted files, is resolvable
   in-app, then cut; local edits are never silently lost; after sync the
   divergence view compares against the new tag. (T19/T20)
8. Publish uses the per-source configured base branch when set; a non-FF
   publish refuses with "upstream moved — sync first" instead of
   force-setting the branch. (T21)

## Risks & Watch Items

- **Numbering contest (highest)**: ADR-129 + migration 0093 are claimed by up
  to four in-flight plans — re-grep at T1, T23, and the merge renumber pass.
- **`applyPackageVersionChoices` compensation surface**: T5/T6 must not
  widen the adopt-revert window — try_once contributes no `AdoptRevert`;
  pinned launches skip adopt entirely (hoisted validation).
- **`git diff --no-index` exit-code semantics** (0/1 both success) and
  `git merge-file` conflict-count exit codes — wrap once in `git.ts`, test
  there, never re-handle at call sites.
- **Shared e2e infra** (ports 3100/7788, `maister_e2e`): kill-first,
  baseline-prove.
- **`.next` cache** after any `globals.css`-adjacent change:
  `rm -rf web/.next` before blaming code.
- **Provenance join is revision-string keyed** (no FK): a package install and
  its member flow revisions share `resolvedRevision` by construction
  (`attach.ts:266-275`); if that invariant ever changes, T10's helper is the
  single seam.

## Owner answers (2026-07-11 — all questions resolved, plan updated in place)

1. **Q1 (try_once offer): ДА** — only alongside `adopt` (existing newer cut);
   no cut-and-try-once.
2. **Q2 (sync precondition): ДА** — clean-tree refusal, no auto-stash.
   Follow-up "а в случае конфликта? rebase?" answered: sync is MERGE-shaped,
   never a rebase — fork repos are fresh `git init` with no shared ancestry,
   nothing to replay; conflict flow = markers in the working dir +
   conflicted-file list banner → resolve in-app or locally → one resolution
   commit → lineage advances (see D5 + T20). Local fork commits are never
   rewritten.
3. **Q3 (e2e publish): достаточно** — local bare-remote without a PR-provider
   mock; "pushed + compare URL" fallback is the asserted outcome.
4. **Q4 (multi-adopt): ДА, NARROWED** — only projects already on a cut of
   THIS local package (attachment install `sourceLocalPackageId =
   localPackage.id`); upstream-pinned same-name attachments are not offered
   and never migrated silently (D-decision + T16 updated).
