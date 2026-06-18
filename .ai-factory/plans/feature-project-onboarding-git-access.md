# Implementation Plan: Project onboarding + git-access redesign

Branch: claude/zealous-mayer-67c3e9 (current worktree — **no new branch created**; nested
worktree/branch would be wrong. Plan filename uses a descriptive slug per the
no-new-branch path.)
Created: 2026-06-17

> **Source spec (SDD):** [`docs/plans/2026-06-17-add-project-onboarding-and-git-access-design.md`](../../docs/plans/2026-06-17-add-project-onboarding-and-git-access-design.md).
> That design doc is the single source of truth for behavior; this plan is the
> ordered, test-first execution of it. Where they disagree, the design doc wins
> for intent and **the code wins for current-state facts** (two facts already
> corrected below).

> **Design-doc facts this plan corrects (verified in code 2026-06-17):**
> 1. §7B / web/CLAUDE.md call Project Settings "read-only today". It is **not** —
>    settings-write already ships: `web/components/board/panels/settings-panel.tsx`
>    has writable admin sections via `PATCH /api/projects/[slug]/settings`,
>    `.../settings/runner`, `.../flow-runner-remaps`. Settings is a **tab**
>    (`?tab=settings`) on the board page, not a separate route. The P3 "Git"
>    section therefore **follows the existing settings-write pattern** + the
>    acp-runners data-management template — it is not a new green-field surface.
> 2. The portfolio home DTO `getPortfolio()` (`web/lib/queries/portfolio.ts`)
>    does **not** expose `maisterYamlPath`. The home persist-banner needs that
>    field added to the portfolio summary DTO (consumer fan-out, T-P3). The board
>    page already has it via `getProjectBySlug()`.

## Settings
- Testing: yes — **TDD** (red → green → refactor) on every behavior task.
- Logging: verbose — pino `debug`/`info` on every new helper & route, gated by
  `LOG_LEVEL`; **always** redact (`redactUrl`) and **never** log the HTTPS token.
- Docs: yes — **mandatory** docs checkpoint. The project's own rule
  (`.ai-factory/skill-context/aif-plan/SKILL.md`: "front-load a complete,
  internally-consistent analytics/design spec before any code phase") makes
  Phase 0 a hard gate before any code phase, per `docs/CLAUDE.md` R5/R6.

## Roadmap Linkage (optional)
Milestone: "none"
Rationale: Skipped by user. This work extends shipped **M21** (URL-clone
onboarding, ADR-025); the design doc is the spec of record. `/aif-verify --strict`
should treat missing linkage as WARN, not failure.

---

## Execution model — agent teams (Coordinator / QA / Implementor / Reviewer)

Every behavior task runs the same TDD micro-cycle, orchestrated by the
**Coordinator**:

| Role | Agent(s) | Owns |
| ---- | -------- | ---- |
| **Coordinator** | `implement-coordinator` (or the main session) | Phase sequencing, dispatch, per-phase **green checkpoint** + **review gate**, commits per the Commit Plan, ADR/migration-number guard, renumber pass. |
| **QA** | `test-automator` / `aif-qa` skill | Writes the **failing test first** (RED). Names each test's **runner project + glob** and confirms `pnpm exec vitest list --project <p>` matches BEFORE handing off. Owns i18n parity + runnability gates. |
| **Implementor** | `implement-worker` | Minimal, surgical code to turn RED → GREEN. No adjacent refactors (root CLAUDE.md surgical rule). |
| **Reviewer** | `review-sidecar` + `code-reviewer` + `security-sidecar` + `rules-sidecar` | Adversarial per-phase review against the **Cross-cutting invariants** below. Branches on `MaisterError.code`, never string-matching. |

Cycle per task: **QA writes RED test → Implementor makes it GREEN → Reviewer
audits → Coordinator folds into the phase's commit once the suite is green.**
A task is "done" only when its test EXECUTES under a named runner and the full
suite is green (no dead/quarantined test without a logged reason).

---

## Shared-namespace reservations (allocate up front)

Per the skill-context rule "allocate ADR + migration numbers up front for
parallel branches and budget a renumber pass". Measured at **main's HEAD**
(2026-06-17): max ADR = **ADR-092**, max migration idx = **0053**.

- **ADR-093** — reserved for this feature: "Project onboarding — optional
  `maister.yaml`, host-ambient git auth (Q2=A), onboarding modes, advisory
  clone-failure reasons." Written as a stub header in Phase 0 (T1) before any
  citation; finalized at Phase 4.
- **Migration 0054** — reserved for P1: `projects.maister_yaml_path DROP NOT NULL`.
- **⚠ Collision risk:** memory flags an unmerged `feature/flow-studio-phase-c-local-packages`
  worktree that also intends **ADR-093 + migration 0053/0054**. **T-FIN budgets an
  explicit renumber pass** (own focused step, AFTER rebasing onto main) — re-derive
  `max(### ADR-NNN)` from `git show main:docs/decisions.md` and `max(idx)` from
  `git show main:web/lib/db/migrations/meta/_journal.json`, renumber if taken,
  re-run the ADR-anchor validator. A green `pnpm validate:docs` is **not** evidence
  for numbering (it only parses Mermaid).

---

## Cross-cutting invariants (Reviewer checklist — apply to every phase)

These encode the project's accumulated `/aif-plan` rules. Each is a Reviewer gate.

### A. Route identifier trust labels (every new/changed route)
Label every identifier a handler consumes: `url-param` | `auth-context` |
`server-state` | `body-controlled`. A `body-controlled` value naming a
filesystem/cross-resource locator must be allow-list-validated OR derived from
`server-state`.

- **`POST /api/projects`** (modified, CREATE — no pre-existing resource):
  `repoUrl`/`target`/`name`/`mode`/`token`/`taskKey` are all `body-controlled`
  **creation attributes** (no existing server resource to derive from — acceptable),
  but each MUST be validated: `mode` ∈ allow-list `{clone,existing,new}`; `repoUrl`
  scheme allow-list; `target` absolute-no-`..` / `SAFE_SEGMENT`; `name` → `deriveSlug`;
  `taskKey` → `TASK_KEY_REGEX`; `token` → secret handling (§ invariant C). The server
  **re-validates the path against `mode`** (intent, never blind trust — never create
  a dir implicitly on a typo). `adminId` = `auth-context`.
- **`POST /api/projects/[slug]/persist-config`** (new): `slug` = `url-param`
  (access-controlled by `requireProjectAction(projectId,"editSettings")`); `projectId`
  + `repo_path` = `server-state` (from the project row, **never** body). No
  `body-controlled` cross-resource id.
- **`/api/projects/[slug]/remotes`** (new; **single collection route**,
  GET/POST/PATCH/DELETE — `name` travels in the **body** for PATCH/DELETE so names
  with `/` or `.` work, which a `[name]` path segment cannot represent; owner
  2026-06-17): `slug` = `url-param`; `repo_path` = `server-state`. Remote `name` =
  `body-controlled` → **reuse the existing exported `remoteNameSchema`**
  (`web/lib/worktree.ts`: `/^[A-Za-z0-9_./-]+$/`, no leading `-`) — it ALREADY
  permits dots + slashes (decision 4) and is the SAME schema `listRemotes`/
  `pushBranch` validate, so a slashed remote added here never throws in those
  readers (do NOT invent a new schema). Remote `url` =
  `body-controlled` → scheme allow-list (`validateUrl`) + redacted in every
  response. Push/fetch reuse host-ambient auth. Origin-sync writes
  `projects.repo_url/provider` from the validated url.

### B. Multi-store atomicity & crash-window recovery
For any transition spanning >1 store (filesystem + git + DB), enumerate the
crash windows and give each a tested recovery.

- **`persist-config`** = 3 stores (working-tree file → git commit → DB column)
  **+ an optional push** (opt-in; owner 2026-06-17). Order: preconditions →
  (1) `atomicWriteText(maister.yaml)` → (2) `commitFile` → (3) `UPDATE projects
  SET maister_yaml_path` → (4) optional `git push` (only if requested). Windows:
  - precondition fail → `PRECONDITION` 409, **no writes**.
  - write fail → no commit/flip; temp removed by `atomicWriteText`.
  - **unset git author** → do NOT fail (owner 2026-06-17): detect via
    `git config user.name`/`user.email`; only when unset, commit with a **default
    identity** (`git -c user.name=maister -c user.email=noreply@maister.local commit`
    — never override a configured host author) and return success with
    `usedDefaultAuthor: true` so the UI **informs** the user. Other commit failures
    → `PRECONDITION` with remediation; remove the just-written file (precondition
    guaranteed it didn't pre-exist); **DB stays null → banner stays**.
  - **DB-flip fail AFTER commit** (the real crash window) → file committed, DB
    null. **Recovery (tested):** the route is **idempotent-completing** — if
    `maister_yaml_path IS NULL` AND `maister.yaml` exists at HEAD AND its content
    equals `serializeProjectConfig(...)`, **skip write+commit and only flip the
    DB** (200 reconcile). A present-but-dirty/uncommitted file → `PRECONDITION`.
  - **push fail AFTER flip** → persist already SUCCEEDED (commit + DB flip done).
    Reuse `pushBranch` (it THROWS `GitPushRejectedError`/`EXECUTOR_UNAVAILABLE`):
    **catch it** and return 200 with a `pushWarning` advisory (host-ambient auth via
    `NETWORK_GIT_ENV`). **Never** roll back the local commit / DB on a push failure.
- **`remotes` add/set `origin`** = 2 stores (git → DB `repo_url`/`provider`).
  Order: (1) `git remote add|set-url` → (2) DB update (origin only). `repo_url`
  is a **denormalized cache**; the remotes list reads `git remote -v` (live truth).
  DB-fail-after-git window self-heals: origin read re-derives `repo_url` from
  `git remote get-url origin` when the DB value is null/stale. Test the reconcile.
  Push / fetch / set-upstream are **separate, non-atomic** actions (no DB write) —
  host-ambient auth; a failure is an advisory, nothing to roll back.

### C. Secret handling (HTTPS token, P2)
Token only ever in: the git **child-process env** + a `mkdtemp` `0700` askpass
script (removed in `finally`). **Never** in argv, on disk as a key file, in the
clone's `.git/config`, in `projects.repo_url`, or in any log line. `redactUrl`
strips `://user:pass@`. Not persisted (one-off override; durable auth = host-ambient).

### D. New-state consumer fan-out — the `maisterYamlPath == null` signal
`null` = "config lives only in the DB". Grep it into **every** consumer:
- **read models:** `getProjectBySlug` (board — already exposes `maisterYamlPath`)
  **AND** `getPortfolio` (home — **must be extended with a derived
  `needsPersist: boolean`**, NOT the raw path, to limit path leakage to the client;
  owner 2026-06-17).
- **`writeBackPackagesPin`** (`web/lib/packages/yaml-writeback.ts`) — must
  early-return a benign `"skipped"` when the project's `maisterYamlPath` is null
  (DB authoritative). Its caller(s) must treat `"skipped"` like a non-fatal result.
- **`loadProjectConfig`** — only reached on the present-path register branch (safe);
  assert it is never called with null.
- **`persist-config`** route — requires `maisterYamlPath IS NULL` (else 409).
- **banner** — renders iff the project needs persist (board: `maisterYamlPath ==
  null`; home: the derived `needsPersist`) **AND the viewer can `editSettings`**
  (project admin/owner, or global admin) — never show a persist CTA that would 403.

### E. Contract-surface → spec-file map (Phase 0 enumerates; T-FIN cross-checks)
| Surface | Spec file(s) |
| ------- | ------------ |
| `POST /api/projects` body `+name/+mode/+token`, error `+reason/+detail` | `docs/api/web.openapi.yaml` |
| `POST /api/projects/[slug]/persist-config` (new) | `docs/api/web.openapi.yaml` |
| `GET/POST/PATCH/DELETE /api/projects/[slug]/remotes` (new) | `docs/api/web.openapi.yaml` |
| Advisory clone `reason` (code stays `PRECONDITION`) | `docs/error-taxonomy.md` |
| `projects.maister_yaml_path` → nullable | migration 0054 + `docs/database-schema.md` + `docs/db/projects-domain.md` ERD |
| `maister.yaml` optional at manual register; host-ambient auth; `gh` optional | `docs/configuration.md` + `docs/deployment.md` + `docs/system-analytics/{projects,git-integration}.md` |
| Add-project screen + Settings→Git | `docs/screens/` |

### F. Deployment touchpoints
- **No new host-read env var.** `MAISTER_GIT_TOKEN` (P2) is set **transiently** in
  the git child-process env via the askpass path only — it is **not** read from
  host config, so **no `.env.example` / compose entry**. State this explicitly in
  `docs/configuration.md` so the absence is intentional, not an oversight.
- **`gh` CLI is an optional host tool** (P2, best-effort `gh auth token`). Document
  it in `docs/deployment.md` (git-auth options) + `docs/getting-started.md`
  (prerequisites, optional) + surface in the host-tool status doc
  (`docs/system-analytics/instance-config.md`). Auth is host-ambient (Q2=A):
  ssh-agent/keys + `gh` + the one-off token field.
- **Push / fetch reuse host-ambient auth** (persist push + remotes push/fetch, P3;
  owner 2026-06-17): ssh-agent/keys, `gh`, env, the one-off token — no managed
  credential store (Q2=A). On auth failure the action returns an advisory; the
  local commit / DB state is **never** rolled back.

### G. Test runnability & per-phase green (skill-context hard rule)
Every promised test names its **runner project**:
- `unit` globs: `lib/**/*.test.ts`, `lib/**/__tests__/**/*.test.ts`,
  `app/**/__tests__/**/*.test.ts`, `components/**/*.test.ts`,
  `components/**/__tests__/**/*.test.ts`. (`pnpm test:unit`)
- `integration` globs: `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`.
  (`pnpm test:integration`) — **⚠ `components/**/*.integration.test.ts` is NOT
  globbed**; component-touching integration tests live under `app/**` or `lib/**`.
- **component tests:** `.test.ts` (NOT `.tsx`), `createElement` +
  `renderToStaticMarkup`, `vi.mock("next-intl")` + `vi.mock("next/navigation")`
  (pattern: `web/components/board/__tests__/flight-card.test.ts`).
- **integration tests:** per-file testcontainers PG, `vi.mock("@/lib/db/client")`,
  dynamic-import the route, call `POST(new NextRequest(...))`
  (pattern: `web/app/api/__tests__/projects-register.integration.test.ts`).
- **e2e:** new spec stem MUST be added to the `AUTHED_SPEC` regex in
  `web/playwright.config.ts`; stub-supervisor on `:7788`, seeded `maister_e2e`.
  **Shared-infra trap:** only one `next dev` per project dir — kill `:3000`/`:3100`
  + `:7788` first; never `--last-failed`; baseline-prove before blaming a branch.
- **Per-phase exit:** `pnpm typecheck` 0, `pnpm test:unit && pnpm test:integration`
  green, scoped `eslint` clean, named e2e green. Pre-existing red → explicit
  quarantine task with reason, never silent toleration.
- **i18n parity:** `web/lib/__tests__/i18n-parity.test.ts` (runs under `unit`) must
  stay green — en/ru deep key-tree equality on every new `projects.*` key. **Every
  UI task (T7/T12/T16/T23/T26) adds its new keys to BOTH `en.json` and `ru.json` in
  the same task** (a one-locale key fails the phase).

---

## Commit Plan

- **Commit 0** (Phase 0, T1–T5): `docs(onboarding): ADR-093 + analytics/contracts for project onboarding + git access`
- **Commit 1** (P1, T6–T8): `feat(projects): client-safe repo-name + URL→name/key prefill + getDefaultBranch`
- **Commit 2** (P1, T9–T13): `feat(projects): maister.yaml optional at register + 3 onboarding modes + migration 0054` <!-- T9 lands WITH its migration T10 (dependency order) -->
- **Commit 3** (P2, T14–T17): `feat(projects): classified clone failures + real stderr to UI`
- **Commit 4** (P2, T18–T20): `feat(projects): HTTPS token (askpass) + gh best-effort + SSH guidance`
- **Commit 5** (P3, T21–T23): `feat(settings): serialize + persist maister.yaml (idempotent commit + opt-in push) + banner`
- **Commit 6** (P3, T24–T26): `feat(settings): git remotes CRUD (push/fetch/set-upstream) with origin DB sync`
- **Commit 7** (T-FIN): `chore(onboarding): finalize docs status, renumber check, full-suite verify`

---

## Tasks

### Phase 0 — Analytics & contracts FIRST (hard gate before any code)

> Exit criteria for the whole phase: every doc below is **complete and
> internally consistent**, every described P1/P2/P3 piece carries an R6 status
> tag (P1 pieces `(Designed)` → flipped to `(Implemented)` by their phase; P2/P3
> `(Designed)`), and all validators pass (`pnpm validate:docs`, ADR-anchor
> check, `npx @redocly/cli lint docs/api/web.openapi.yaml`). No code phase
> starts until this is green.

- [x] **T1 — Reserve ADR-093 stub.** Append `### ADR-093: Project onboarding —
  optional maister.yaml, host-ambient git auth, onboarding modes, advisory clone
  reasons` to [`docs/decisions.md`](../../docs/decisions.md) using the file's ADR
  template (Context = the 5 problems in §1; Decision = §3 owner decisions incl.
  Q2=A; Consequences; Status: Accepted). One-line stub is enough to make later
  citations resolve; full prose finalized in T-FIN.
  - *Logging:* n/a (doc). *Files:* `docs/decisions.md`.
  - *Acceptance:* `ADR-093` header exists; `node scripts/validate-docs-adr-anchors.mjs`
    (or the project's anchor validator) resolves it. Reviewer confirms next-free
    is still 093 vs `git show main:docs/decisions.md`.

- [x] **T2 — Projects domain + DB docs.** Update
  [`docs/system-analytics/projects.md`](../../docs/system-analytics/projects.md):
  the **DB-default registration path** (absent `maister.yaml` → DB defaults, repo
  untouched), the **three onboarding modes** (`clone | existing | new`), and the
  `maisterYamlPath == null` signal (R5 structure: state machine + process flows +
  Expectations + Edge cases linked to `MaisterError` codes). Update
  [`docs/database-schema.md`](../../docs/database-schema.md) narrative AND
  [`docs/db/projects-domain.md`](../../docs/db/projects-domain.md) Mermaid ERD for
  the nullable `maister_yaml_path` (both artifacts, R5a). Tag P1 pieces `(Designed)`.
  - *Files:* `docs/system-analytics/projects.md`, `docs/database-schema.md`,
    `docs/db/projects-domain.md`. *Acceptance:* `pnpm validate:docs` green; the
    register state machine enumerates present / absent / present-but-invalid
    branches exactly as the code will gate (allow-list, not deny-list).

- [x] **T3 — Git-integration domain + error taxonomy.** Update
  [`docs/system-analytics/git-integration.md`](../../docs/system-analytics/git-integration.md):
  clone-failure **classification** (`SSH_AUTH | SSH_HOSTKEY | HTTPS_AUTH |
  NOT_FOUND | NETWORK | UNKNOWN`), the token / `gh` / SSH-guidance paths, and
  remote management. Update [`docs/error-taxonomy.md`](../../docs/error-taxonomy.md):
  the clone `reason` is **advisory context on `PRECONDITION`** (code unchanged) —
  document the `{ reason, detail }` shape and that UI maps `reason`→remediation,
  never string-matches. Tag P2/P3 pieces `(Designed)`.
  - *Files:* `docs/system-analytics/git-integration.md`, `docs/error-taxonomy.md`.
    *Acceptance:* every reason has a one-line remediation; the `MaisterError`
    additive `details?` shape is described once and cross-referenced (R7).

- [x] **T4 — API + config + deployment + screens.** Update
  [`docs/api/web.openapi.yaml`](../../docs/api/web.openapi.yaml): `POST /api/projects`
  body `+name?/+mode?/+token?` and error body `+reason?/+detail?`; new
  `POST /api/projects/[slug]/persist-config` (body `+push?`, response
  `+usedDefaultAuthor?`/`+pushWarning?`); new
  `GET/POST/PATCH/DELETE /api/projects/[slug]/remotes` (**single collection
  route**, `name` in body for PATCH/DELETE; add/set-url/remove + push/fetch/
  set-upstream) — paths, bodies, status codes, **example payloads**. Update [`docs/configuration.md`](../../docs/configuration.md)
  (`maister.yaml` optional for manual register; **explicit note: no new host-read
  env var — `MAISTER_GIT_TOKEN` is transient child-process env only**),
  [`docs/deployment.md`](../../docs/deployment.md) (host-ambient auth options; `gh`
  optional), [`docs/getting-started.md`](../../docs/getting-started.md) (`gh`
  optional prereq), and add/refresh [`docs/screens/`](../../docs/screens/) for the
  Add-project screen + Settings→Git. Note in `web/CLAUDE.md`/root `CLAUDE.md` §6
  that `maister.yaml` is optional at manual register + the null signal.
  - *Files:* as listed. *Acceptance:* `npx @redocly/cli lint docs/api/web.openapi.yaml`
    zero errors; contract-surface map (invariant E) fully covered.

- [x] **T5 — Phase 0 consistency gate.** Coordinator + Reviewer run all doc
  validators and a cross-read: the OpenAPI bodies, the error-taxonomy reasons, the
  ERD nullability, and the system-analytics state machines must agree with each
  other and with the design doc. Fix drift before any code. *(no commit of code)*

### Phase 1 (P1) — Onboarding core *(removes the registration blocker)*

- [x] **T6 — Extract client-safe repo-name deriver (TDD).** New
  `web/lib/repo-name.ts`: `deriveRepoNameSafe(url: string): string | null` (the
  segment/regex logic from `deriveRepoName`, **minus** the `MaisterError` throw —
  no `server-only`, no `node:*`). Refactor `web/lib/repo-source.ts` `deriveRepoName`
  into a thin wrapper that calls it and throws `PRECONDITION` on `null` (server
  behavior unchanged, rule single-sourced).
  - *RED:* `web/lib/__tests__/repo-name.test.ts` (`unit`) — scp `git@h:o/r.git`,
    https, ssh://, bare path, `.git` strip, garbage→`null`, `.`/`..`→`null`.
    Add a case to the existing repo-source test asserting the wrapper still throws.
  - *Logging:* pure fn, none. *Acceptance:* `repo-name.ts` has **no** `server-only`
    import (Reviewer greps); unit green.

- [x] **T7 — Live URL→name/key prefill (TDD, client).** Rework
  `web/components/projects/new-project-form.tsx` per design §4: add `nameDirty` /
  `taskKeyDirty` state; on `repoUrl` change prefill name (`deriveRepoNameSafe`) then
  key while not dirty; manual edits set the dirty flag and stop auto-prefill for
  that field; `previewKey(s)` = `deriveTaskKey(s)` but `""` when it fails
  `TASK_KEY_REGEX`. Import `deriveTaskKey`/`TASK_KEY_REGEX` from
  `web/lib/social/task-key.ts` (already pure) and `deriveRepoNameSafe` from T6.
  - *RED:* `web/components/projects/__tests__/new-project-form.test.ts` (`unit`,
    `renderToStaticMarkup` + mocked `next-intl`/`next/navigation`) — assert prefill
    on URL, dirty-stops-prefill, invalid-key→empty. (Interaction-heavy assertions
    that `renderToStaticMarkup` can't drive move to the T13 e2e.)
  - *Logging:* client; none. *Acceptance:* depends on T6; unit green.

- [x] **T8 — `getDefaultBranch` helper (TDD).** Add to
  [`web/lib/worktree.ts`](../../web/lib/worktree.ts)
  `getDefaultBranch(repo): Promise<string>` — `git -C <repo> symbolic-ref --short
  refs/remotes/origin/HEAD` (strip `origin/`) → fallback `git rev-parse
  --abbrev-ref HEAD` → final `"main"`. Mirrors `readRemoteOrigin`.
  - *RED:* `web/lib/__tests__/worktree-default-branch.test.ts` (`unit`) — mock the
    git exec layer; assert each of the three fallback tiers.
  - *Logging:* `log.debug` the resolved branch + tier. *Acceptance:* unit green.

- [x] **T9 — `maister.yaml`-optional registration (TDD, integration).** Rework
  `register()` in [`web/app/api/projects/route.ts`](../../web/app/api/projects/route.ts):
  after `resolveProjectSource`, `stat` `maister.yaml` at `resolved.dir`:
  **present** → today's path (`loadProjectConfig` → flows/packages install,
  `maisterYamlPath` set); **absent** → DB-default insert: `name = body.name?.trim()
  || path.basename(resolved.dir)`, `slug = deriveSlug(name)`, `taskKey = body.taskKey
  ?? deriveTaskKey(name, slug)`, `mainBranch = await getDefaultBranch(resolved.dir)`,
  `branchPrefix="maister/"`, `defaultRunnerId=null`, `promotionMode=null`,
  `repoUrl=resolved.repoUrl`, `provider=resolved.provider`, **`maisterYamlPath=null`**,
  same slug/repoPath/taskKey uniqueness → `CONFLICT`, **no flow/package/import
  install** (none declared — and therefore **no `setup.sh` runs** on the DB-default
  path; note this for the Reviewer's fetch-then-execute check); keep the deferred
  `gitInit` when `gitStatus==="initialized"`. **Present-but-invalid `maister.yaml`
  still → `CONFIG` 422** (only a *missing* file branches to DB defaults).
  - *RED:* extend `web/app/api/__tests__/projects-register.integration.test.ts`
    (`integration`, testcontainers PG): (a) no yaml → row with `maisterYamlPath
    null` + derived name/slug/taskKey/mainBranch; (b) valid yaml → unchanged
    (regression); (c) invalid yaml → `CONFIG` 422; (d) explicit `name`/`taskKey`
    win; (e) taskKey collision → `CONFLICT`.
  - *Logging:* `log.info` the branch taken (`present` vs `db-default`) + assigned
    slug/taskKey/mainBranch. *Acceptance:* depends on T8; integration green; the
    present-path regression stays green.

- [x] **T10 — Migration 0054 (nullable column).** Drop `.notNull()` on
  `maisterYamlPath` in [`web/lib/db/schema.ts`](../../web/lib/db/schema.ts) (line
  ~127 → `text("maister_yaml_path")`), then run the project's Drizzle generate
  script (`web/package.json` `db:*`) to emit `0054_*.sql` containing
  `ALTER TABLE projects ALTER COLUMN maister_yaml_path DROP NOT NULL;` + the
  snapshot. **No backfill** (existing rows keep their path → no banner). Prefer the
  generated path over hand-written SQL (avoids the `--custom` stale-snapshot
  gotcha).
  - *Gotchas (must verify):* `_journal.json` new `when` is **monotonic** above the
    current max (journal-drift gotcha → otherwise "already exists" / silent skip);
    snapshot regenerated cleanly; idx = 54.
  - *RED:* the T9 no-yaml integration test (writing `null`) is the executable proof
    the column is nullable — it fails against the old `NOT NULL`. *Logging:* n/a.
    *Acceptance:* fresh testcontainers migrate applies 0054; T9 green.

- [x] **T11 — `writeBackPackagesPin` null guard (TDD).** Per invariant D: make
  `writeBackPackagesPin` (`web/lib/packages/yaml-writeback.ts`) early-return a
  benign `"skipped"` when the target project's `maisterYamlPath` is null (extend
  the `WriteBackResult` union to `"ok" | "failed" | "skipped"`), and update its
  caller(s) (package attach/detach/upgrade) to treat `"skipped"` as non-fatal.
  Grep every call site.
  - *RED:* `web/lib/packages/__tests__/yaml-writeback.test.ts` (`unit`) — null path
    → `"skipped"`, no fs write attempted; existing-path cases stay green.
  - *Logging:* `log.info` skip reason (DB authoritative). *Acceptance:* unit green;
    Reviewer confirms all callers handle `"skipped"`.

- [x] **T12 — New-empty mode + form reframe (TDD).** Server: extend
  `resolveProjectSource` (`web/lib/repo-source.ts`) — body gains `mode: "clone" |
  "existing" | "new"`; on the no-URL branch, if the path is absent **and
  `mode==="new"`** (explicit; never on a typo), `mkdir -p` + mark created for
  cleanup-on-failure (mirror `clonedByUs` → `createdByUs`), and let `register()`'s
  deferred `gitInit` run → `gitStatus:"initialized"`, no remote. Add an **optional**
  `mode` to `postBodySchema` (allow-list `{clone,existing,new}`): when absent, infer
  `clone` (repoUrl present) / `existing` (target present) — preserving the current
  `POST /api/projects` contract + the existing register test; **`new` must be
  explicit** (never inferred). Client: top **mode selector** (segmented control)
  in `new-project-form.tsx` replacing the overloaded field — Clone-from-URL (+token
  field arrives in P2) / Existing-local-repo / New-empty-project; relabel `target`
  → "Local path or clone folder"; add the optional "Project name" field (T7); rewrite
  `addSub` copy. Wire cleanup-on-failure for the created dir into POST's outer catch
  (mirror the `clonedByUs` cleanup).
  - *RED:* `web/lib/__tests__/repo-source.test.ts` (`unit`) — `mode:"new"` + absent
    path → mkdir + `initialized`; absent path + `mode!=="new"` → `PRECONDITION`
    (no implicit create). Integration: `web/app/api/__tests__/projects-register.integration.test.ts`
    new-empty → dir created + git-init + row. Component: mode-selector visibility in
    `new-project-form.test.ts`.
  - *Logging:* `log.info` the resolved mode + created dir. *Acceptance:* depends on
    T9 **+ T7** (both edit `new-project-form.tsx` — land prefill first);
    unit+integration green; **cleanup-on-failure tested** (create fails mid-register
    → dir removed).

- [x] **T13 — P1 E2E + green checkpoint.** Playwright spec
  `web/e2e/project-onboarding.spec.ts` (add stem `project-onboarding` to the
  `AUTHED_SPEC` regex in `web/playwright.config.ts`): add a **new-empty** project
  with no `maister.yaml` → lands on board; assert URL→name/key prefill + dirty-stop
  in the form. (Persist-banner + remotes covered in P3 e2e.) Respect the e2e
  shared-infra trap (kill `:3000`/`:3100`/`:7788`, serial where needed).
  - *Acceptance (phase gate):* `pnpm typecheck` 0; `pnpm test:unit && pnpm
    test:integration` green; scoped eslint clean; this e2e green. **Reviewer gate:**
    invariants A (POST identifiers), D (null fan-out), G (runnability). Coordinator
    commits 1 + 2.

### Phase 2 (P2) — Git access *(fixes private-clone pain, e.g. gitverse)*

- [x] **T14 — `classifyGitError` + `MaisterError.details` (TDD).** Pure helper in
  `web/lib/repo-source.ts`: `classifyGitError(stderr): CloneFailureReason`
  (`SSH_AUTH | SSH_HOSTKEY | HTTPS_AUTH | NOT_FOUND | NETWORK | UNKNOWN`) with the
  marker sets from design §5.1. Confirm `web/lib/errors-core.ts` `MaisterError`
  carries structured context; if it only holds `code/message/cause`, add an additive
  optional `details?: Record<string, unknown>`. `cloneRepo`'s catch attaches
  `{ reason, detail }` (`detail` = **redacted** stderr, **truncated to ~4 KB**) to
  the `PRECONDITION` error.
  - *RED:* `web/lib/__tests__/classify-git-error.test.ts` (`unit`) — one case per
    reason from real stderr strings (incl. the verified gitverse `Permission denied
    (publickey)` → `SSH_AUTH`); `errors-core` test for `details` round-trip.
  - *Logging:* `log.debug` `{ reason }` (never raw token; stderr already redacted).
    *Acceptance:* unit green; `details` is additive (existing throws unaffected).

- [x] **T15 — `errorResponse` carries reason/detail (TDD, integration).** In
  `web/app/api/projects/route.ts`, `errorResponse` serializes `{ code, message,
  reason?, detail? }` from `MaisterError.details` (UI still branches on `code`).
  Keep all other codes unchanged.
  - *RED:* integration test — a forced clone failure returns 409 body with
    `reason` + redacted `detail`; non-clone errors unchanged.
  - *Logging:* existing. *Acceptance:* depends on T14; integration green.

- [x] **T16 — UI remediation per reason + collapsible detail (TDD).** In
  `new-project-form.tsx`: widen the error model from a single `ERROR_KEY` string to
  map clone `reason` → a specific i18n remediation, with a collapsible "git output"
  block showing `detail`. `SSH_AUTH` leads with `ssh-add`; `HTTPS_AUTH` on
  `github.com` surfaces the `gh` fork (T19). Keep the `urlHasCreds` nudge.
  - *RED:* `new-project-form.test.ts` (`unit`) — render per `reason` shows the right
    remediation key + the detail block.
  - *Acceptance:* depends on T15; unit + i18n-parity green.

- [x] **T17 — Fix untranslated ru keys (TDD).** In
  [`web/messages/ru.json`](../../web/messages/ru.json) translate the
  `projects.*` keys flagged in design §5.1 (`errorConflict`, `errorForbidden`,
  `successTitle`, verify `errorConfig`) + all new P2 keys. Mirror in
  [`web/messages/en.json`](../../web/messages/en.json).
  - *RED:* `web/lib/__tests__/i18n-parity.test.ts` (`unit`) is the gate — it fails
    until en/ru key trees match. *Acceptance:* parity green; no English left in ru
    values for these keys (Reviewer spot-check).

- [ ] **T18 — HTTPS token askpass (TDD, integration).** `postBodySchema` gains
  `token: z.string().min(1).optional()`. `cloneRepo` accepts optional `token`; when
  present and scheme is http(s): write a `mkdtemp` `0700` askpass
  (`#!/bin/sh\nprintf '%s' "$MAISTER_GIT_TOKEN"`), clone the **plain** URL with env
  `GIT_ASKPASS=<script>`, `MAISTER_GIT_TOKEN=<token>`, `GIT_TERMINAL_PROMPT=0`;
  remove the temp dir in `finally`. Token never in argv / disk-key / `.git/config`
  / log / `projects.repo_url`; not persisted. Client: token field (`type="password"`,
  `autoComplete="off"`) shown only for http(s) URLs in the Clone mode; sent as
  `token`.
  - *RED:* `web/app/api/__tests__/projects-token-clone.integration.test.ts` or a
    `lib/**` integration test exercising the askpass injection (cover at integration
    level per design §11 — not e2e). Assert: temp dir removed in `finally`; token
    absent from any captured argv/log; plain URL stored.
  - *Logging:* `log.debug` "token askpass used" (boolean only, **never** the value).
    *Acceptance:* depends on T14/T15; integration green; **invariant C** Reviewer gate.

- [ ] **T19 — `gh` best-effort + SSH guidance (TDD).** `detectGhAuth(): "ok" |
  "unauthed" | "absent"` (probe `execFile("gh", ["auth","token"])`). For
  `github.com` http(s) with no `token`: `ok` → use the token via the askpass path;
  `absent`/`unauthed` → proceed tokenless (likely `HTTPS_AUTH`) and let the
  `github.com` `HTTPS_AUTH` remediation surface the fork (`gh auth login` / paste
  token / SSH). Add the `SSH_AUTH` remediation copy (en+ru) from design §5.4
  (`ssh-add --apple-use-keychain`; HTTPS+token; passphrase-less deploy key).
  - *RED:* `web/lib/__tests__/detect-gh-auth.test.ts` (`unit`) — mock `execFile`
    for the three outcomes; remediation copy keys exist in both locales.
  - *Logging:* `log.info` gh-auth outcome (enum only). *Acceptance:* unit + parity green.

- [ ] **T20 — P2 green checkpoint.** *(phase gate)* `pnpm typecheck` 0;
  `pnpm test:unit && pnpm test:integration` green; scoped eslint clean. Update the
  `project-onboarding` e2e (or a `git-access` spec) to assert a classified-clone
  error renders with the collapsible detail (using a deliberately-bad URL against
  the stub). **Reviewer gate:** invariants A, C (secret), E (OpenAPI matches).
  Coordinator commits 3 + 4. Flip P2 doc status tags `(Designed)`→`(Implemented)`.

### Phase 3 (P3) — Git in settings: persist + remotes *(depends on P1)*

- [ ] **T21 — `serializeProjectConfig` (TDD).** New serializer (in
  `web/lib/packages/yaml-writeback.ts` or a sibling) →
  `serializeProjectConfig(project, attachments): string` producing a complete,
  **schema-valid** `maister.yaml` v2: `schemaVersion: 2`; `project.{name,
  main_branch (omit if "main"), branch_prefix (omit if "maister/"), default_runner
  (omit if null), promotion (omit if null)}`; `flows: []` (or the project's attached
  flows). **Round-trip through `maisterYamlV2Schema.parse`** before returning
  (self-check) — `flows: []` is valid (config.schema.ts:261, no `.min(1)`).
  - *RED:* `web/lib/__tests__/serialize-project-config.test.ts` (`unit`) — output
    parses under `maisterYamlV2Schema`; defaults omitted; attached flows/packages
    emitted; round-trip identity on the project fields.
  - *Logging:* none (pure). *Acceptance:* unit green.

- [ ] **T22 — `persist-config` endpoint (TDD, integration) — two-phase per
  invariant B.** New `POST /api/projects/[slug]/persist-config`
  (`requireProjectAction(projectId,"editSettings")`): load project (slug→`server-state`);
  require `maisterYamlPath IS NULL` (else 409); preconditions on `repo_path` — git
  repo, **HEAD on `main_branch`**, clean tree, no `maister.yaml` on disk → else
  clear `PRECONDITION`. Then **write → commit → DB flip → optional push** (body
  `push?: boolean`) with the idempotent-completing recovery (invariant B). Add
  `commitFile({repo,file,message})` as an **exported `worktree.ts` op** (next to
  `listRemotes`/`pushBranch`, reusing the private `runGit` — do NOT export `runGit`):
  `git add` → detect `git config user.name`/`user.email`, then commit with
  `git [-c user.name=… -c user.email=…] commit -m` **only when unset** → default
  identity `maister <noreply@maister.local>` + `usedDefaultAuthor: true` (never
  override a configured host author; never fail for unset). Optional push reuses
  `pushBranch`, which **throws** (`GitPushRejectedError`/`EXECUTOR_UNAVAILABLE`) →
  **catch it** → 200 + `pushWarning` (persist already succeeded). Edge: a **new-empty
  repo has an unborn HEAD** → `commitFile` makes the first commit (clean-tree
  precondition holds on the empty repo). Commit message: `chore(maister): persist project config`.
  - *Identifiers:* invariant A (persist-config row). *RED:*
    `web/app/api/__tests__/projects-persist-config.integration.test.ts`
    (`integration`, real git in the testcontainers-backed temp repo): happy path
    (file + commit + flip); **unset author → default identity + `usedDefaultAuthor`**;
    wrong-branch / dirty / detached / file-exists → typed `PRECONDITION`;
    already-persisted → 409; **DB-flip-fail recovery → re-run reconciles by flipping
    only** (idempotent); **push requested + push fails → 200 + `pushWarning`, DB
    still flipped**. *Logging:* `log.info` each step (write/commit/flip/push) +
    outcome. *Acceptance:* depends on T21; integration green; **invariant B**
    Reviewer gate (crash windows enumerated + tested).

- [ ] **T23 — Persist banner (TDD) + home DTO fan-out.** Client island
  `web/components/projects/config-persist-banner.tsx` rendering iff the project needs
  persist **AND the viewer can `editSettings`** (admin/owner — never a CTA that
  403s), mounted on **both** the portfolio home
  (`web/app/(app)/page.tsx`) and the board (`web/app/(app)/projects/[slug]/page.tsx`).
  Action → confirm dialog (target path + branch + commit message) →
  `POST …/persist-config` → success hides + toast (the toast surfaces
  `usedDefaultAuthor`/`pushWarning` when present). **Dismiss** is client-persisted
  (`localStorage` per project); on dismiss, point to Settings→Git (T26). **Fan-out
  (invariant D):** add a **derived `needsPersist` boolean** (NOT the raw path; owner
  2026-06-17) to the `getPortfolio` DTO in `web/lib/queries/portfolio.ts` so the home
  banner can decide; the board derives it from `getProjectBySlug`.
  - *RED:* `web/components/projects/__tests__/config-persist-banner.test.ts`
    (`unit`) — renders only when needsPersist + can-edit; dialog content; dismiss
    copy. A `lib/**` test asserts the portfolio DTO now carries `needsPersist`.
  - *Logging:* client. *Acceptance:* depends on T22; unit + parity green.

- [ ] **T24 — Git remote primitives (TDD).** Add **exported** ops to
  `web/lib/worktree.ts` — `remoteAdd` / `remoteSetUrl` / `remoteRemove` /
  `listRemoteUrls` (`git remote -v`) — next to `listRemotes`/`pushBranch`, reusing
  the private `runGit` + the **existing exported `remoteNameSchema`** (do NOT export
  `runGit`; do NOT invent a new schema — `remoteNameSchema` already permits
  dotted/slashed names per decision 4 and is the schema `listRemotes`/`pushBranch`
  validate). New `web/lib/git-remotes.ts` orchestrates: list with URLs redacted via
  `redactUrl`, add/set-url/remove + **push/fetch/set-upstream** (reuse `pushBranch`
  → catch its throw → advisory) + `validateUrl` on the url, and the **origin DB
  sync** (invariant A/B): adding/setting `origin` updates `projects.repo_url` +
  `provider` (`detectProvider`); removing `origin` nulls them. All ops
  **path-confined to `repo_path`** (server-state).
  - *RED:* `web/lib/__tests__/git-remotes.test.ts` (`unit`, mocked git layer) —
    `remoteNameSchema` accepts dotted/slashed names + rejects leading-dash;
    url validation; redaction on list; provider derivation;
    plus a `web/app/api/__tests__/projects-remotes.integration.test.ts` against a
    real temp repo for add/set/remove + origin `repo_url`/`provider` sync +
    DB-fail-after-git reconcile.
  - *Logging:* `log.info` op + redacted url + origin-sync result. *Acceptance:* unit
    + integration green.

- [ ] **T25 — Remotes API route (TDD, integration).** **Single collection route**
  `web/app/api/projects/[slug]/remotes/route.ts`: `GET` list, `POST` add,
  `PATCH` set-url, `DELETE` remove (remote `name` in the **body** for PATCH/DELETE
  so `/`-containing names work; owner 2026-06-17), plus push/fetch/set-upstream
  actions. All `requireProjectAction(projectId,"editSettings")`, repo_path from
  `server-state`. Push/fetch reuse `pushBranch` (catch its throw → advisory; no DB rollback).
  - *Identifiers:* invariant A (remotes). *RED:* extend
    `projects-remotes.integration.test.ts` — RBAC (non-admin/owner → 403), bad name
    → `PRECONDITION`, origin add → `repo_url` set, push-failure → advisory (no DB
    rollback).
  - *Logging:* `log.info` route + op (redacted url). *Acceptance:* depends on T24;
    integration green.

- [ ] **T26 — Settings → Git section (TDD) + P3 e2e + green checkpoint.** Add a
  **Git** section to `web/components/board/panels/settings-panel.tsx` (a **Server
  Component**) as a **client-island control** imported alongside its existing
  siblings (`DeliveryPolicySettingsControl` etc., gated on `isAdmin`; the route's
  `editSettings` is the real boundary). The acp-runners panel
  (`web/components/settings/acp-runners-panel.tsx` + `acp-runner-modal.tsx`) is the
  table+modal **UX** template, not the mount pattern:
  view-only remotes table + add/edit/remove modal + **push/fetch** actions calling
  the T25 route; a durable **persist** action (with an opt-in "also push" toggle)
  while `maisterYamlPath == null` (the banner's durable home).
  E2E (extend `project-onboarding.spec.ts`): new-empty project → board → persist
  banner → persist → banner gone; add a remote in Settings→Git.
  - *RED:* component test for the Git panel (view-only table + modal visibility);
    e2e as above. *Acceptance (phase gate):* `pnpm typecheck` 0; unit+integration
    green; scoped eslint; e2e green. **Reviewer gate:** invariants A, B, D, E.
    Coordinator commits 5 + 6. Flip P3 doc status tags `(Designed)`→`(Implemented)`.

### Phase 4 — Finalization

- [ ] **T-FIN — Renumber check, docs status, full verify.**
  1. **Renumber pass** (own focused step, after rebase onto main): re-derive
     `max(### ADR-NNN)` from `git show main:docs/decisions.md` and `max(idx)` from
     `git show main:.../meta/_journal.json`; if ADR-093 / 0054 were taken by the
     Flow Studio Phase C branch, renumber (header + all citations + migration file +
     journal + snapshot) and re-run the ADR-anchor validator. Finalize ADR-093 prose.
  2. **Docs status:** confirm every described piece is now `(Implemented)`; no spec
     section describes absent code.
  3. **Full gate:** `pnpm typecheck` 0; `pnpm test:unit && pnpm test:integration`
     green; `pnpm test:e2e` (named specs) green; scoped eslint clean;
     `pnpm validate:docs` + ADR-anchor + `npx @redocly/cli lint docs/api/web.openapi.yaml`.
  4. Run `/aif-verify` against this plan.
  - *Acceptance:* all gates green; renumber confirmed against live main.

---

## Resolved decisions (owner, 2026-06-17)

1. **Push после persist** — **в этом плане** (opt-in). Persist = commit + optional
   push; remotes get push/fetch/set-upstream. Reuses host-ambient auth (Q2=A).
2. **persist-config реконсиляция** — идемпотентное дозавершение (НЕ строгий
   `PRECONDITION`): файл закоммичен + БД=null на повторе → только флип БД.
3. **`commitFile` автор git** — при незаданном авторе **дефолтим**
   (`maister <noreply@maister.local>`) и **оповещаем юзера** (`usedDefaultAuthor`
   → toast); не падаем.
4. **Remote name** — **поддержать** имена с `.`/`/` → `gitRemoteNameSchema`
   (не `SAFE_SEGMENT`); `name` едет в body для PATCH/DELETE на коллекционном
   маршруте `/remotes` (сегмент `[name]` не умеет `/`).
5. **`getPortfolio` fan-out** — только производный **`needsPersist: boolean`**
   (не сырой путь) в DTO дома.
6. **ADR-093/0054 коллизия** — **ренумерую** в T-FIN автоматически (re-derive из
   live main; если занято — сдвигаю номера + правлю цитаты/journal/snapshot).
