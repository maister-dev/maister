# Implementation Plan: Flow Studio Package Authoring — Stream B (version-adopt launch + PR-to-source)

Branch: feature/studio-package-authoring-runtime (create off Stream A's tip, or off main + rebase onto A before merge)
Created: 2026-06-22
Milestone target: **M39** (shared with Stream A; M38 = implemented-but-unmerged flow-routing)
Sibling: **Stream A** = `feature/studio-package-authoring-editor` (editor IA + first-class kinds). Split per owner ("в 2 потока").

> **MODEL (locked):** packages are centralized (Studio-edited); projects **consume versions** via a per-project pin. Stream B owns: attach a Studio package version to a project, the launch-time **"newer version available — adopt or keep?"** prompt, cross-project version reuse, and PR-to-source. No working-dir drift, no per-project editing — a project only ever sees immutable **cut versions**.

## Settings
- Testing: **yes** (integration tests on real Postgres are hard acceptance for the launch + publish paths).
- Logging: **standard / structured** — name-scoped logger, NO `console.*`, never log tokens.
- Docs: **yes** — docs-first Phase B0; mandatory docs checkpoint at completion.

## Roadmap Linkage
Milestone: **M39 — "Flow Studio package authoring"** (Stream B delivers the runtime/publish half).
Rationale: Closes "use a central package's chosen version across projects" + "propose upstream".

---

## Scope (Stream B) — owns migration 0062 + ADR-106/107

Backend-heavy: the version-adopt launch + the PR-to-source publish path, plus their UI (project package-add + the launch prompt + propose-upstream).

**Dependency on Stream A:** B reuses A's shared `ChangeReviewDialog` (diff + commit message) for the PR flow, and A's "Customize for this project" fork for the project-side attach of a divergent copy. → Branch B off A, or off main + rebase onto A.

### Context (verified by /aif-improve trace)
- **Flow runs are task-bound.** `POST /api/runs` requires `taskId`; `projectId` derived from the task; `flowId` from `task.flowId`. (`web/app/api/runs/route.ts:28-38`, `web/lib/services/runs.ts:272-365`.)
- **Materialization is project-scoped** — `materializeProjectBundlesIntoWorktree` copies every `capability_imports WHERE project_id AND Installed` (`materialize-bundle.ts:205-213`). So adopting a newer version = **advancing the project's attached revision**, then normal project-scoped materialization runs. No run-scoped override.
- **`runs.local_package_id` is reserved for the M36 project-less assistant and HARD-BLOCKED for flow runs** (`run-kind-invariants.ts:81` → CONFIG). Provenance lives on the **cut install**, NOT on `runs` (the 32-consumer audit confirmed this is the only collision).
- **Cut + attach + flow-revision pinning all exist.** `installPackageRevision` (immutable, global `package_installs`); `attachPackage` (per-project `project_package_attachments` + member `flow_revisions`); `flows.enabled_revision_id` + `enablement_state ∈ {Enabled, UpdateAvailable}` is the existing "newer revision available → enable" mechanism that adopt reuses.
- `pushBranch` (`worktree.ts:623`) + `PrAdapter` (gh/glab/Gitea, `runs/pr-adapter.ts`) exist but are project-repo-only. `package_sources` (`schema.ts:2598`) = git URL, host-ambient creds.

---

## Decisions (owner-approved + trace-corrected)

### Version-adopt launch (ADR-106) — the corrected live-state model
- **Source link on the cut.** When a local package is cut (in Studio), the cut `package_installs` row records **`source_local_package_id` + `source_commit_sha`**. So any cut knows which central package + commit it came from, and `local_packages.last_cut_install_id` is that package's newest cut.
- **Attach = pin a version.** A project attaches package P at a chosen cut (the existing `attachPackage`); the attached flow's `enabled_revision_id` points at that cut's member revision.
- **Launch-time adopt.** In the existing `launchRunStaged` precondition chain, if the task's flow is backed by package P and P has a **newer cut** than the pin (`P.last_cut_install_id != attached cut`), prompt **"P has a newer version (vN) — adopt or keep?"**. Adopt = advance the project's attachment/`enabled_revision_id` to the newer cut (reusing the `UpdateAvailable`→enable path), then launch. Keep = launch on the pin. Several backed packages with newer cuts → the same prompt each.
- **No working-dir at launch.** A project only ever sees immutable cut versions; editing+committing+cutting happens in Studio (Stream A). The cut is the authoring→consumption handoff. (Uncut Studio edits are not auto-included — cut first.)
- **Provenance is derivable, no `runs` column.** `run.flowRevisionId → package_installs.(source_local_package_id, source_commit_sha)` = "which package @ which version this run used", reproducibly. Optional denormalized column deferred.
- **Reuse, don't rebuild.** Reuse `launchRunStaged` + scheduler + ~20 preconditions + the revision-enable machinery; B1 adds only the source link, the version-availability check, the adopt prompt + body field, and the advance-on-adopt step.

### Cross-project version reuse
A project's **"Add package"** can pick a Studio local package + a version (cut) → `attachPackage`. "Pick this version into project B" = attach that cut to B. The Stream-A **"Customize for this project"** copy is attached the same way (it's just another local package). Both reuse `attachPackage`.

### PR-to-source = trusted-sources-only (ADR-107)
- UI: the shared **`ChangeReviewDialog`** (Stream A) extended with a **target-source picker** (registered `package_sources`, allow-list) + **branch-name** (prefilled, editable) + commit message + diff. NEVER a body-supplied raw URL.
- **Preselect + retarget:** preselect the source mapped from `local_packages.source_repo_url`; allow any registered source ("pull from A, push to B"); cross-repo caveat flagged.
- Branch **reusable across publishes**; re-publish updates it, never duplicates the PR.
- Mechanism: add remote → `pushBranch(workingDir, branchName)` → provider+token detected (gh/glab/Gitea via `PrAdapter`) → open PR; else push-only + best-effort compare URL.

### Numbers
**ADR-106** (version-adopt launch) + **ADR-107** (PR-to-source). **Migration 0062**: `package_installs.{source_local_package_id, source_commit_sha}` + `local_packages.{last_pushed_branch, last_pr_url}`. **No `runs` column.** Reuse closed MaisterError union (`PRECONDITION | CONFLICT | CONFIG`).

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
- Migration 0062 lands in the standard Drizzle flow (journal `when` monotonic; snapshot rebuilt for clean `db:generate`).

## Contract surface → spec file
| Surface | Spec file |
| --- | --- |
| `package_installs.{source_local_package_id, source_commit_sha}`, `local_packages.{last_pushed_branch, last_pr_url}` | migration 0062 + `docs/database-schema.md` + `docs/db/projects-domain.md` erDiagram |
| `POST /api/runs` body extension (`packageVersions`) + adopt/keep state machine | `docs/api/web.openapi.yaml` + `docs/system-analytics/local-packages.md` |
| Project attach of a Studio package version (`POST /projects/{slug}/packages`) | `docs/api/web.openapi.yaml` + `local-packages.md` |
| POST `/local-packages/[id]/publish` | `docs/api/web.openapi.yaml` + `local-packages.md` (publish state machine) |
| Reused error codes | `docs/error-taxonomy.md` (note, no new code) |
| PR automation host requirement | `docs/configuration.md` |

---

## Commit Plan
- **Commit 1** — B0: `docs: M39 Stream-B SSOT — version-adopt launch + PR-to-source (ADR-106/107, migration 0062)`
- **Commit 2** — B1: `feat(studio): version-adopt launch (adopt newer central version) + cross-project attach`
- **Commit 3** — B2: `feat(studio): PR-to-package-source (trusted-source picker + new branch; gh PR or push fallback)`
- **Commit 4** — B3: `docs: flip Stream-B Designed→Implemented + M39 (part B); chore: renumber pass`

---

## Tasks

### Phase B0 — Design SSOT (docs-first, ADR-106/107, migration 0062) — Task #10
- [ ] Stub ADR-106 (version-adopt launch) + ADR-107 (PR-to-source) in `docs/decisions.md` (above reserved 103/104).
- [ ] Design migration 0062 (next after `0061_melodic_speed_demon`): `package_installs.{source_local_package_id (FK→local_packages, set null), source_commit_sha}` + `local_packages.{last_pushed_branch, last_pr_url}`. Confirm NO `runs` column; confirm flow→install join (`flows.package_install_id`).
- [ ] `local-packages.md`: **version-adopt launch state machine** + choice table written EXACTLY as code gates (flow backed-by-package? → newer cut than pin? → adopt [advance revision] | keep; multi-package = per-package). Project-attach-a-version state machine. Publish state machine + failure table. ERDs (narrative + Mermaid). OpenAPI (`POST /api/runs` body ext + attach + publish). `configuration.md` PR-host gap. error-taxonomy reuse note. Implementation-status `Designed`.
- [ ] **Verify**: `pnpm validate:docs:all` + `scripts/validate-docs-adr-anchors.mjs` + redocly 0 errors. ADR headers exist before B1/B2.

### Phase B1 — Version-adopt launch + cross-project attach — Task #11 (blockedBy #10)
- [ ] Migration 0062: source-link cols on `package_installs` + PR cols on `local_packages` (shared with B2). Snapshot + journal monotonic.
- [ ] **Source link**: record `source_local_package_id` + `source_commit_sha` on the cut install (extend the `cut-version` → `installPackageRevision` call, `web/lib/packages/attach.ts`).
- [ ] **Version-availability check** (`web/lib/local-packages/versions.ts`): given a project's attached package-backed flow, is `P.last_cut_install_id` newer than the pin? + the version labels / what's-new summary for the prompt.
- [ ] **Adopt-at-launch** — REUSE `web/lib/services/runs.ts` `launchRunStaged` (do NOT rebuild preconditions/scheduler): a precondition detects newer-version-available for the task flow's backing package(s); `POST /api/runs` gains `packageVersions` (server-constrained to the detected set; unknown → 409). `adopt` → advance the project's attachment/`enabled_revision_id` to the newer cut (reuse the `UpdateAvailable`→enable path) → launch. `keep` → launch on the pin. Multi-package: per-package.
- [ ] **Cross-project attach**: project "Add package" picks a Studio local package + a version (cut) → `attachPackage`; also the entry point for attaching a Stream-A "Customize for this project" copy. The launch prompt = a light "version available" dialog (NOT the commit ChangeReviewDialog — no commit at launch).
- [ ] **Run-provenance display**: run detail shows "flow from package <name> @ <version>" via `flowRevisionId → install → source link`.
- [ ] LOGGING: structured logger — newer-available set, per-package choice, adopted install id, advanced revision id, run id. NO console.*.
- [ ] **Verify**: integration real-PG (attach P@v1 → cut P→v2 in Studio → launch detects newer → "adopt" advances to v2 + runs; "keep" runs v1; multi-package both prompt; attach same cut to a 2nd project); two-phase failure (advance fails → no run, retryable); provenance via flowRevisionId; assert `runs.local_package_id` null on these flow runs. Full suite green, tsc 0, scoped eslint 0, db:generate clean.
- Files: `web/lib/db/schema.ts` + `migrations/0062_*`, NEW `web/lib/local-packages/versions.ts`, `web/lib/packages/attach.ts` (source link on cut), `web/lib/services/runs.ts` (newer-available precondition + adopt + advance-revision), `web/app/api/runs/route.ts` (+`packageVersions`), project package-attach route + UI, `web/components/studio/*` + board launch (adopt dialog), `web/lib/queries/run.ts` (provenance), i18n en/ru.

### Phase B2 — PR-to-package-source (trusted-source picker + new branch) — Task #12 (blockedBy #10)
- [ ] `publishLocalPackage(id, {targetSourceId, branchName})`: resolve source from `package_sources` allow-list (server-state) → git remote add/set → `pushBranch(workingDir, branchName)` → provider+token detected → `PrAdapter.createPr` OR push-only + compare URL. Parameterize `pr-adapter.ts` for package repos.
- [ ] Publish route (member-gated; `targetSourceId` allow-list validated; `branchName` charset-validated) + UI (shared `ChangeReviewDialog` + source picker [preselect mapped, retarget allowed] + new-branch input + cross-repo caveat) + `last_pr_url`/`last_pushed_branch` persistence + result display (PR url OR branch + compare URL + manual-PR hint).
- [ ] LOGGING: structured logger — resolved source, branch pushed, provider detected, PR url OR push-only reason; failure class. Never log tokens. NO console.*.
- [ ] **Verify**: unit (source allow-list rejects non-registered; compare-URL builder GitHub/GitLab/Gitea; branch-name validation; preselect resolution), integration (push to bare-remote mock; PrAdapter mock → PR url stored; push-only fallback; two-phase push-rejected → CONFLICT marker-unset, retry updates branch). Full suite green, tsc 0, scoped eslint 0.
- Files: NEW `web/lib/local-packages/publish.ts`, `web/lib/runs/pr-adapter.ts` (parameterize), `web/lib/worktree.ts` (pushBranch reuse), `web/app/api/studio/local-packages/[id]/publish/route.ts`, `web/components/studio/*` (publish via extended ChangeReviewDialog), `docs/configuration.md`, i18n.

### Phase B3 — Verify Stream B + docs flip + renumber — Task #13 (blockedBy #11,#12)
- [ ] Flip Stream-B docs Designed→Implemented + ADR-106/107 status.
- [ ] ROADMAP M39 (Stream-B scope).
- [ ] **Renumber pass** after rebase onto current main + Stream A (ADR 106/107 + migration 0062 vs main HEAD: flow-routing ADR-103/no-migr, G4 ADR-104, cost-budget migr 0061, priceless-goldstine may collide). Renumber in a focused commit if needed (SQL/journal/snapshots/anchors).
- [ ] Final `/aif-verify`: tsc 0 (web+supervisor), full unit+integration, e2e on host (free :3000), validate:docs:all, redocly 0, i18n parity, zero console.*.

---

## Resolved (owner)
- Live-state = **version-adopt launch**: project pins a cut; at launch, if the central package has a newer cut, adopt (advance revision) or keep. Provenance on the cut; materialization unchanged. ✅
- Cross-project reuse = attach a chosen cut to any project (+ the Stream-A "Customize" copy). ✅
- PR = trusted-sources-only picker + new branch; preselect mapped source + retarget. ✅
- No `runs.local_package_id` reuse (hard invariant); no new `runs` column. ✅

## Open questions (RU)
1. **Adopt-prompt vs project "Update" кнопка:** показываем выбор adopt/keep на ЗАПУСКЕ (как сейчас), или в списке пакетов проекта "доступно обновление → Update" (advance pin вне запуска), а запуск просто берёт pin? Или оба?
2. **Uncut Studio-правки:** запуск проекта видит только cut-версии (правки в Studio надо сначала «cut»). Ок, или нужен «cut latest & adopt» прямо из запуска?
3. **Default branch-name** для publish (`maister/<pkg>-<ts>`)? **Cross-repo push** когда таргет ≠ origin — флажок-предупреждение или «advanced»?
