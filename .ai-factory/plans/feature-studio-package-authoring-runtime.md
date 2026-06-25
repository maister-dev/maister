# Implementation Plan: Flow Studio Package Authoring — Stream B (version-adopt launch + PR-to-source)

Branch: feature/studio-package-authoring-runtime (rebased onto current main `ad82f442`, which ALREADY contains the merged Stream A + package-based-agents work — NO "rebase onto A" needed)
Created: 2026-06-22 · Refreshed: 2026-06-25 (renumbered + re-traced against current main)
Milestone target: **M39** (shared with Stream A, now MERGED to main; M38 flow-routing also merged)
Sibling: **Stream A** = `feature/studio-package-authoring-editor` (editor IA + first-class kinds) — **MERGED to main**. Split per owner ("в 2 потока").

> **MODEL (locked):** packages are centralized (Studio-edited); projects **consume versions** via a per-project pin. Stream B owns: attach a Studio package version to a project, the launch-time **"newer version available — adopt or keep?"** prompt, cross-project version reuse, and PR-to-source. No working-dir drift, no per-project editing — a project only ever sees immutable **cut versions**.

## Settings
- Testing: **yes** (integration tests on real Postgres are hard acceptance for the launch + publish paths).
- Logging: **standard / structured** — name-scoped logger, NO `console.*`, never log tokens.
- Docs: **yes** — docs-first Phase B0; mandatory docs checkpoint at completion.

## Roadmap Linkage
Milestone: **M39 — "Flow Studio package authoring"** (Stream B delivers the runtime/publish half).
Rationale: Closes "use a central package's chosen version across projects" + "propose upstream".

---

## Scope (Stream B) — owns migration 0071 + ADR-107/110

Backend-heavy: the version-adopt launch + the PR-to-source publish path, plus their UI (project package-add + the launch prompt + propose-upstream).

**Dependency on Stream A:** B reuses A's shared `ChangeReviewDialog` (diff + commit message) for the PR flow, and A's "Customize for this project" fork for the project-side attach of a divergent copy. Both are now ON main — this branch is off current main, so no rebase-onto-A is needed.

### Context (re-traced against current main `ad82f442`, 2026-06-25)
- **Flow runs are task-bound.** `POST /api/runs` requires `taskId` (`z.string().min(1)`); `projectId` derived from the task row inside `launchRun`; `flowId` optional. (`web/app/api/runs/route.ts:30,107`, `web/lib/services/runs.ts` `launchRunStaged`@268.)
- **⚠ launchRunStaged run-insert is now `onConflictDoNothing`-aware** (migration 0069 trigger-task idempotency, MERGED): the `runs` insert inside `_db.transaction` (`runs.ts:924-965`) dedups on `(agent_id, trigger_event_id)`. Adopt-at-launch is a **board launch** (user-initiated, NO `trigger_event_id`) ⇒ never conflicts ⇒ unaffected. The B1 "advance-revision + run-insert ONE tx" still holds; slot the revision-advance into / just-before that transaction.
- **Materialization is project-scoped** — `materializeProjectBundlesIntoWorktree` copies every `capability_imports WHERE project_id AND packageStatus='Installed'` (`web/lib/capabilities/materialize-bundle.ts:198-211`). So adopting a newer version = **advancing the project's attached revision**, then normal project-scoped materialization runs. No run-scoped override.
- **`runs.local_package_id` is reserved for the M36 project-less assistant and HARD-BLOCKED for flow runs** (`web/lib/runs/run-kind-invariants.ts:49-70` → CONFIG). Provenance lives on the **cut install**, NOT on `runs`.
- **Cut + attach + flow-revision pinning all exist.** `installPackageRevision`@160 (immutable, global `package_installs`); `attachPackage`@628 (per-project `project_package_attachments` + member `flow_revisions`); `flows.enabled_revision_id`(schema@394) + `enablement_state ∈ {Enabled, UpdateAvailable}`(schema@398-402) is the existing "newer revision available → enable" mechanism that adopt reuses; `flows.package_install_id`(schema@420) is the flow→install join.
- **Cols the migration ADDs are confirmed absent today:** `package_installs.{source_local_package_id, source_commit_sha}` absent; `local_packages.{last_pushed_branch, last_pr_url}` absent — but `local_packages.source_repo_url`@2767 + `last_cut_install_id`@2770 already exist (reused, not added).
- `pushBranch` (`web/lib/worktree.ts:673`) + `PrAdapter` (`GhCliAdapter`@161 / `GlabCliAdapter`@223 / `GiteaApiAdapter`@347 + `selectPrAdapter`@602, `runs/pr-adapter.ts`) exist but are project-repo-only. `package_sources` (`schema.ts:2654`) = git URL, host-ambient creds.

---

## Decisions (owner-approved + trace-corrected)

### Version-adopt launch (ADR-107) — the corrected live-state model
- **Source link on the cut.** When a local package is cut (in Studio), the cut `package_installs` row records **`source_local_package_id` + `source_commit_sha`**. So any cut knows which central package + commit it came from, and `local_packages.last_cut_install_id` is that package's newest cut.
- **Attach = pin a version.** A project attaches package P at a chosen cut (the existing `attachPackage`); the attached flow's `enabled_revision_id` points at that cut's member revision.
- **Launch-time adopt.** In the existing `launchRunStaged` precondition chain, if the task's flow is backed by package P and P has a **newer cut** than the pin (`P.last_cut_install_id != attached cut`), prompt **"P has a newer version (vN) — adopt or keep?"**. Adopt = advance the project's attachment/`enabled_revision_id` to the newer cut (reusing the `UpdateAvailable`→enable path), then launch. Keep = launch on the pin. Several backed packages with newer cuts → the same prompt each.
- **Cut-first, with a launch-time `cut_and_adopt` escape (owner 2026-06-25).** A project sees immutable cut versions by default; editing happens only in Studio (Stream A). BUT when the backing package has **uncut Studio edits** newer than its last cut, the launch prompt offers a third option **"cut latest & adopt"**: run the Studio cut-version gate (validate → `installPackageRevision` → `stampLastCutInstall`) to mint a fresh cut, then adopt it. The launch only *triggers* the cut — it does not edit. Wrinkles to handle: the cut needs the package's Studio **edit-lock** (someone mid-edit → PRECONDITION) and must pass the **validate gate** (invalid artifacts → PRECONDITION; fall back to keep / adopt-existing-cut).
- **Provenance is derivable, no `runs` column.** `run.flowRevisionId → package_installs.(source_local_package_id, source_commit_sha)` = "which package @ which version this run used", reproducibly. Optional denormalized column deferred.
- **Reuse, don't rebuild.** Reuse `launchRunStaged` + scheduler + ~20 preconditions + the revision-enable machinery; B1 adds only the source link, the version-availability check, the adopt prompt + body field, and the advance-on-adopt step.

### Cross-project version reuse
A project's **"Add package"** can pick a Studio local package + a version (cut) → `attachPackage`. "Pick this version into project B" = attach that cut to B. The Stream-A **"Customize for this project"** copy is attached the same way (it's just another local package). Both reuse `attachPackage`.

### PR-to-source = trusted-sources-only (ADR-110)
- UI: the shared **`ChangeReviewDialog`** (Stream A) extended with a **target-source picker** (registered `package_sources`, allow-list) + **branch-name** (prefilled, editable) + commit message + diff. NEVER a body-supplied raw URL.
- **Preselect + retarget:** preselect the source mapped from `local_packages.source_repo_url`; allow any registered source ("pull from A, push to B"); cross-repo caveat flagged.
- Branch = stable **`maister/<pkg-slug>`** (reusable across publishes; re-publish updates it, never duplicates the PR) — NOT timestamped (owner 2026-06-25).
- Mechanism: add remote → `pushBranch(workingDir, branchName)` → provider+token detected (gh/glab/Gitea via `PrAdapter`) → open PR; else push-only + best-effort compare URL.

### Numbers
**ADR-107** (version-adopt launch) + **ADR-110** (PR-to-source). **Migration 0071**: `package_installs.{source_local_package_id, source_commit_sha}` + `local_packages.{last_pushed_branch, last_pr_url}`. **No `runs` column.** Reuse closed MaisterError union (`PRECONDITION | CONFLICT | CONFIG`).

### Route identifier trust labels (skill-context)
| Route | Identifier | Label | Handling |
| --- | --- | --- | --- |
| POST `/api/runs` (extended) | `taskId` | body → server row | `projectId`/`flowId` derived server-side (existing) |
| same | `packageVersions` (map packageInstallId→`adopt`/`keep`) | body | each key MUST be in the server-detected "newer available" set; unknown → 409. Server advances the revision for `adopt`. |
| POST `/projects/{slug}/packages` (attach) | `slug` | url-param → project | membership-checked |
| same | `localPackageId`,`version` | body | validate the package exists + the cut belongs to it (server-state) |
| POST `/local-packages/[id]/publish` | `id` | url-param → server row → working_dir | trusted |
| same | `targetSourceId` | body | validate vs `package_sources` allow-list; mismatch → 409 |
| same | `branchName` | body | ref-name charset validated |

### Two-phase / multi-store atomicity (skill-context)
- **Adopt-at-launch:** advance `enabled_revision_id`/attachment to the newer cut + create the run row in the existing `launchRunStaged` ONE tx → spawn (after). Idempotency marker = run-row commit. Crash windows: advance-without-run → next launch sees no-newer (already adopted), runs it (intended); spawn death sweep-recoverable. `runs.local_package_id` stays NULL (assert in test).
- **Publish:** push (side-effect) → write `last_pushed_branch`/`last_pr_url` AFTER success. Failure table: push rejected → CONFLICT (retryable, marker unset); auth/no-remote → PRECONDITION; no source url → CONFIG. Re-publish updates the branch, never duplicates the PR.

---

## Deployment touchpoints
- No new env var: PR automation uses host-ambient `GH_TOKEN`/`GITLAB_TOKEN`/`GIT_SSH_COMMAND`. `.maister` host-only (ADR-023) → no compose change.
- **Doc-the-gap** in `docs/configuration.md`: PR automation needs `gh`+token; else push-only fallback.
- Migration 0071 lands in the standard Drizzle flow (journal `when` monotonic; snapshot rebuilt for clean `db:generate`).

## Contract surface → spec file
| Surface | Spec file |
| --- | --- |
| `package_installs.{source_local_package_id, source_commit_sha}`, `local_packages.{last_pushed_branch, last_pr_url}` | migration 0071 + `docs/database-schema.md` + `docs/db/projects-domain.md` erDiagram |
| `POST /api/runs` body extension (`packageVersions`) + adopt/keep state machine | `docs/api/web.openapi.yaml` + `docs/system-analytics/local-packages.md` |
| Project attach of a Studio package version (`POST /projects/{slug}/packages`) | `docs/api/web.openapi.yaml` + `local-packages.md` |
| POST `/local-packages/[id]/publish` | `docs/api/web.openapi.yaml` + `local-packages.md` (publish state machine) |
| Reused error codes | `docs/error-taxonomy.md` (note, no new code) |
| PR automation host requirement | `docs/configuration.md` |

---

## Commit Plan
- **Commit 1** — B0: `docs: M39 Stream-B SSOT — version-adopt launch + PR-to-source (ADR-107/110, migration 0071)`
- **Commit 2** — B1: `feat(studio): version-adopt launch (adopt newer central version) + cross-project attach`
- **Commit 3** — B2: `feat(studio): PR-to-package-source (trusted-source picker + new branch; gh PR or push fallback)`
- **Commit 4** — B3: `docs: flip Stream-B Designed→Implemented + M39 (part B); chore: renumber pass`

---

## Tasks

### Phase B0 — Design SSOT (docs-first, ADR-107/110, migration 0071) — Task #10
- [x] Stub ADR-107 (version-adopt launch) + ADR-110 (PR-to-source) in `docs/decisions.md` (107 is free; 108 = guardrail-hooks, so PR-to-source takes 109 — both appended at the end of the ADR log).
- [x] Design migration 0071 (next after `0070_consensus_round_verdicts`): `package_installs.{source_local_package_id (FK→local_packages, set null), source_commit_sha}` + `local_packages.{last_pushed_branch, last_pr_url}`. Confirm NO `runs` column; confirm flow→install join (`flows.package_install_id`).
- [x] `local-packages.md`: **version-adopt launch state machine** + choice table written EXACTLY as code gates (flow backed-by-package? → newer cut than pin? → adopt [advance revision] | keep; multi-package = per-package). Project-attach-a-version state machine. Publish state machine + failure table. ERDs (narrative + Mermaid). OpenAPI (`POST /api/runs` body ext + attach + publish). `configuration.md` PR-host gap. error-taxonomy reuse note. Implementation-status `Designed`.
- [x] **Verify**: `pnpm validate:docs:all` + `scripts/validate-docs-adr-anchors.mjs` + redocly 0 errors. ADR headers exist before B1/B2.

### Phase B1 — Version-adopt launch + cross-project attach — Task #11 (blockedBy #10)
- [x] Migration 0071: source-link cols on `package_installs` + PR cols on `local_packages` (shared with B2). Snapshot + journal monotonic.
- [x] **Source link**: record `source_local_package_id` + `source_commit_sha` on the cut install (extend the `cut-version` → `installPackageRevision` call, `web/lib/packages/attach.ts`).
- [x] **Version-availability check** (`web/lib/local-packages/versions.ts`): for a project's attached package-backed flow report (a) is `P.last_cut_install_id` newer than the pin (an existing newer cut)? AND (b) does P have **uncut Studio working-dir edits** newer than its last cut (working dir dirty vs `last_cut_install_id`'s `source_commit_sha`)? + version labels / what's-new summary for the prompt.
- [x] **Adopt-at-launch** — REUSE `web/lib/services/runs.ts` `launchRunStaged` (do NOT rebuild preconditions/scheduler): a precondition detects available-version state for the task flow's backing package(s); `POST /api/runs` gains `packageVersions` (per package: `keep` | `adopt` | `cut_and_adopt`; server-constrained to the detected set; unknown/ineligible → 409). `adopt` → advance the project's attachment/`enabled_revision_id` to the newer cut (reuse the `UpdateAvailable`→enable path) → launch. `cut_and_adopt` → run the cut-version gate first (Studio edit-lock + validate → `installPackageRevision` → `stampLastCutInstall`; locked/invalid → PRECONDITION) → advance to the fresh cut → launch. `keep` → launch on the pin. Multi-package: per-package.
- [x] **Cross-project attach**: project "Add package" picks a Studio local package + a version (cut) → `attachPackage`; also the entry point for attaching a Stream-A "Customize for this project" copy. The launch prompt = a light "version available" dialog (NOT the commit ChangeReviewDialog — no commit at launch).
- [x] **Run-provenance display**: run detail shows "flow from package <name> @ <version>" via `flowRevisionId → install → source link`.
- [x] LOGGING: structured logger — newer-available set, per-package choice, adopted install id, advanced revision id, run id. NO console.*.
- [x] **Verify**: integration real-PG (attach P@v1 → cut P→v2 in Studio → launch detects newer → "adopt" advances to v2 + runs; "keep" runs v1; **uncut edits in P → "cut_and_adopt" mints v3 + advances + runs; invalid-artifact working dir → cut_and_adopt PRECONDITION while "keep" still works; locked-by-another-session → PRECONDITION**; multi-package both prompt; attach same cut to a 2nd project); two-phase failure (advance fails → no run, retryable); provenance via flowRevisionId; assert `runs.local_package_id` null on these flow runs. Full suite green, tsc 0, scoped eslint 0, db:generate clean.
- Files: `web/lib/db/schema.ts` + `migrations/0071_*`, NEW `web/lib/local-packages/versions.ts`, `web/lib/packages/attach.ts` (source link on cut), `web/lib/services/runs.ts` (available-version precondition + adopt/cut_and_adopt + advance-revision; reuse the cut-version gate), `web/app/api/runs/route.ts` (+`packageVersions`), project package-attach route + UI, `web/components/studio/*` + board launch (adopt dialog w/ cut_and_adopt), `web/lib/queries/run.ts` (provenance), i18n en/ru.

### Phase B2 — PR-to-package-source (trusted-source picker + new branch) — Task #12 (blockedBy #10)
- [x] `publishLocalPackage(id, {targetSourceId, branchName})`: resolve source from `package_sources` allow-list (server-state) → git remote add/set → `pushBranch(workingDir, branchName)` → provider+token detected → `PrAdapter.createPr` OR push-only + compare URL. Parameterize `pr-adapter.ts` for package repos.
- [x] Publish route (member-gated; `targetSourceId` allow-list validated; `branchName` charset-validated) + UI (shared `ChangeReviewDialog` + source picker [preselect mapped, retarget allowed] + new-branch input (prefilled stable `maister/<pkg-slug>`, editable) + **cross-repo WARNING flag** when target ≠ origin) + `last_pr_url`/`last_pushed_branch` persistence + result display (PR url OR branch + compare URL + manual-PR hint).
- [x] LOGGING: structured logger — resolved source, branch pushed, provider detected, PR url OR push-only reason; failure class. Never log tokens. NO console.*.
- [x] **Verify**: unit (source allow-list rejects non-registered; compare-URL builder GitHub/GitLab/Gitea; branch-name validation; preselect resolution), integration (push to bare-remote mock; PrAdapter mock → PR url stored; push-only fallback; two-phase push-rejected → CONFLICT marker-unset, retry updates branch). Full suite green, tsc 0, scoped eslint 0.
- Files: NEW `web/lib/local-packages/publish.ts`, `web/lib/runs/pr-adapter.ts` (parameterize), `web/lib/worktree.ts` (pushBranch reuse), `web/app/api/studio/local-packages/[id]/publish/route.ts`, `web/components/studio/*` (publish via extended ChangeReviewDialog), `docs/configuration.md`, i18n.

### Phase B3 — Verify Stream B + docs flip + renumber — Task #13 (blockedBy #11,#12)
- [x] Flip Stream-B docs Designed→Implemented + ADR-107/110 status.
- [x] ROADMAP M39 (Stream-B scope).
- [x] **Renumber check at merge.** Numbers chosen against current main `ad82f442` (migration **0071**, ADR-**107** + ADR-**110**) — already renumbered once on 2026-06-25 after the `consensus node` merge (`ad82f442`) grabbed 0070 + ADR-109. A FURTHER renumber is needed only if another sibling merges first and grabs 0071 / ADR-107 / ADR-110: re-check `_journal.json` max idx + the highest `### ADR-` header before merge, and renumber in a focused commit (SQL/journal/snapshots/anchors) if so.
- [x] Final `/aif-verify`: tsc 0 (web+supervisor), full unit+integration, e2e on host (free :3000), validate:docs:all, redocly 0, i18n parity, zero console.*.

---

## Resolved (owner)
- Live-state = **version-adopt launch**: project pins a cut; at launch, if the central package has a newer cut, adopt (advance revision) or keep. Provenance on the cut; materialization unchanged. ✅
- Cross-project reuse = attach a chosen cut to any project (+ the Stream-A "Customize" copy). ✅
- PR = trusted-sources-only picker + new branch; preselect mapped source + retarget. ✅
- No `runs.local_package_id` reuse (hard invariant); no new `runs` column. ✅

## Resolved — open questions (owner 2026-06-25)
1. **Adopt UX = launch-time prompt ONLY.** No project-side "Update" button; the pin advances only via the adopt/keep/cut_and_adopt choice at launch. ✅
2. **Uncut Studio edits → ALSO offer "cut latest & adopt" at launch** (not cut-first-only): when uncut edits exist, the prompt adds a `cut_and_adopt` option that mints a fresh cut via the Studio gate (edit-lock + validate), then adopts it. ✅
3. **Publish branch = stable `maister/<pkg-slug>`** (reusable; re-publish updates it, never duplicates the PR). **Cross-repo push** (target source ≠ origin) shows a **warning flag**, not hidden behind "advanced". ✅
