# Implementation Plan: M4 — Flow Plugin Loader

Branch: feature/m4-flow-plugin-loader
Created: 2026-05-26

## Settings

- Testing: yes — unit (pure helpers + error wrapping) + integration (testcontainers Postgres + local file:// bare git repo as fixture)
- Logging: verbose — pino at `name: "flows"`, INFO on every install lifecycle event (start, clone-or-skip, symlink, db upsert, done), DEBUG for git stdout/stderr and individual fs ops, WARN on `setup.sh` non-zero exit, ERROR via `MaisterError` only
- Docs: yes — mandatory docs checkpoint at completion (new `docs/flows.md`, update `docs/getting-started.md`, update `.ai-factory/ROADMAP.md` M4 → `[x]`)

## Roadmap Linkage

Milestone: "M4. Flow plugin loader"
Rationale: Directly implements the next unimplemented milestone in `.ai-factory/ROADMAP.md`. M0/M1/M2/M3 are shipped; M4 unblocks M5 (Flow DSL parser) and M9 (Add Project UI), both of which consume installed Flow rows.

## Research Context

Source: code exploration of worktree on 2026-05-26 (no `.ai-factory/RESEARCH.md` Active Summary present).

Goal: implement `installFlowPlugin({ source, version, projectId, projectSlug, flowId })` that idempotently clones a tagged git repo into `~/.maister/flows/<id>@<tag>/`, validates the bundled `flow.yaml`, symlinks it into `.maister/<projectSlug>/flows/<flowId>/`, and upserts the row into the `flows` table.

Constraints carried over from existing M0–M3 work:

- `web/lib/` modules start with `import "server-only";` (atomic.ts:1, config.ts:1, errors.ts:1, db/client.ts:1, supervisor-client.ts:1). The new `flows.ts` MUST follow.
- Pino logger naming: `const log = pino({ name: "flows" })` (mirrors atomic.ts:9, config.ts:17).
- Error pattern: wrap every failure as `new MaisterError("FLOW_INSTALL", message, { cause: asError(err) })` (mirrors config.ts:31–48). `FLOW_INSTALL` is already in `MaisterErrorCode` (web/lib/errors.ts).
- Manifest parsing already shipped: call `loadFlowManifest(<target>/flow.yaml)` from `web/lib/config.ts:119`. Do NOT re-implement YAML parsing or zod validation.
- DB shape already shipped: `flows` table at web/lib/db/schema.ts:50–74 — columns `id, projectId, flowRefId, source, version, installedPath, manifest, schemaVersion, recommendedExecutorId, createdAt`. Unique constraint `flows_project_ref_uq` on `(projectId, flowRefId)` is the upsert target.
- Boundary validation per the three patches in `.ai-factory/patches/` (2026-05-26 11.13 / 12.45 / 12.53): every string flowing into `path.resolve` / `spawn` argv MUST have `SAFE_PATH_SEGMENT` regex + explicit `.max(N)` zod schema. Applies to `flowId`, `version`, `projectSlug`. `source` URL needs a separate, looser URL validator.
- No `simple-git` dep, no existing git shell-out in `web/`. M4 introduces the first `node:child_process.execFile("git", [...])` usage in the web tier.
- Test patterns already in place:
  - Unit (filesystem): `mkdtemp` + `beforeEach`/`afterEach` cleanup, vitest, `@/` alias — see `web/lib/__tests__/config.test.ts`.
  - Integration (DB + FS): `PostgreSqlContainer` + drizzle migrate + `mkdtemp`, single `it()` per suite to amortize container cost — see `web/lib/__tests__/foundation.integration.test.ts:27–46`.
- `web/package.json` declares `test:unit` + `test:integration` scripts that pass `--project unit` / `--project integration`, but `web/vitest.config.ts` does NOT define named projects (the `--passWithNoTests` flag hides the gap). Plan must add the named-project config so the existing scripts dispatch correctly.
- `.maister/` is NOT in any `.gitignore` (root, web/, supervisor/). M4 creates per-project symlinks under `.maister/<slug>/flows/<id>`; the symlinks must be ignored from commits.

Decisions:

- Use raw `node:child_process.execFile("git", [...args], { signal })` (consistent with `supervisor/src/spawn.ts:3` pattern). No new dependency. Wrap stdout/stderr capture in a helper inside `flows.ts` (small enough to not justify a separate `lib/git.ts`).
- Concurrent-install dedup: in-process `Map<string, Promise<void>>` keyed by `<flowId>@<version>` inside `flows.ts`. Two simultaneous calls for the same key share one clone promise. POC is single-host single-process; no cross-process file-lock needed.
- `setup.sh` execution: included in the loader code path (per `.ai-factory/plans/poc-implementation.md:172`), but the first plugin (`superpowers` per ROADMAP M4) is skills-only and won't trigger it. Non-zero exit → WARN log, do NOT throw — POC trusts all sources.
- DB upsert: `db.insert(flows).values({...}).onConflictDoUpdate({ target: [flows.projectId, flows.flowRefId], set: {...} })`. Reuses the existing `flows_project_ref_uq` unique constraint. Re-install with new version updates `installedPath`, `version`, `manifest`, `schemaVersion`, `recommendedExecutorId`.
- Symlink idempotency: if symlink exists and points to the right target — no-op. If it exists and points elsewhere — unlink + recreate. If a non-symlink file exists at the path — throw `FLOW_INSTALL` (refuse to delete user files).
- Out of M4 scope: `lib/projects.ts`, `app/api/projects/route.ts`, recursive `MAISTER_PROJECTS_DIR` discovery — those are M9 (Web UI core: registry). M4 ships the `installFlowPlugin()` function + a dev CLI (`web/scripts/install-flow.ts`) for ops smoke-testing without a UI.

Open questions: none blocking — all the architectural calls were made in CLAUDE.md and `.ai-factory/plans/poc-implementation.md:163–183`.

## Commit Plan

13 tasks — 4 commit checkpoints:

- **Commit 1** (after tasks 1–4): `chore(flows): ignore .maister/, wire vitest projects, add flow-paths helpers + safety regex`
- **Commit 2** (after tasks 5–8): `feat(flows): installFlowPlugin (git clone + manifest validation + symlink + db upsert + optional setup.sh)`
- **Commit 3** (after tasks 9–11): `test(flows): bare-repo fixture + 6 integration scenarios + unit tests`
- **Commit 4** (after tasks 12–13): `feat(flows): dev CLI + docs/flows.md + mark M4 done in ROADMAP`

## Tasks

### Phase 1: Foundation prep

- [x] **Task 1: Add `.maister/` to root `.gitignore`**
  - Files: `.gitignore`
  - Append a `.maister/` line in a sensible section (after the existing `node_modules`/`.next` block). Confirm `web/.gitignore` and `supervisor/.gitignore` don't need a separate entry (root gitignore covers the whole tree).
  - Logging: n/a (build-system change).
  - Acceptance: `git check-ignore -v .maister/test/flows/x` returns root `.gitignore` as the source.

- [x] **Task 2: Configure vitest named projects (`unit`, `integration`) in `web/vitest.config.ts`** — already shipped via `web/vitest.workspace.ts` in an earlier milestone; verified `pnpm test:unit` runs only unit tests (67 green, no testcontainer spin-up).
  - Files: `web/vitest.config.ts`
  - The existing `web/package.json` scripts call `vitest run --project unit` / `--project integration`, but the current config does NOT define projects. Add a `test.projects` array that splits by filename suffix: `unit` matches `**/__tests__/**/*.{unit,test}.test.ts` excluding `*.integration.test.ts`; `integration` matches `**/__tests__/**/*.integration.test.ts`.
  - Preserve the existing `@` alias and `environment: "node"` in both projects.
  - Logging: n/a.
  - Acceptance: `pnpm test:unit` runs only unit tests (no testcontainers spin-up), `pnpm test:integration` runs only integration tests. Existing `foundation.integration.test.ts` and `schema.integration.test.ts` continue to pass under `--project integration`. Existing `errors.test.ts`, `atomic.test.ts`, `config.test.ts`, `config.schema.test.ts` continue to pass under `--project unit`.

### Phase 2: Pure path helpers + safety

- [x] **Task 3: `web/lib/flow-paths.ts` — deterministic path computation + boundary validation**
  - Files: `web/lib/flow-paths.ts` (new)
  - Exports:
    - `SAFE_PATH_SEGMENT` regex constant (already defined in `supervisor/src/types.ts:?` — read it and either reuse via import or duplicate; web/ MUST NOT import from supervisor/ per ARCHITECTURE.md dependency rules, so duplicate the regex with a `// see also supervisor/src/types.ts` comment).
    - `flowIdSchema` (zod): `z.string().regex(SAFE_PATH_SEGMENT).min(1).max(64)`.
    - `versionTagSchema` (zod): `z.string().regex(/^[A-Za-z0-9._\-+]+$/).min(1).max(64)` (looser than path segment — allows `v1.2.3-rc.1+build.5`).
    - `projectSlugSchema` (zod): `z.string().regex(SAFE_PATH_SEGMENT).min(1).max(64)`.
    - `sourceUrlSchema` (zod): `z.string().url().max(2048).or(z.string().regex(/^[a-zA-Z0-9._\-/:@~]+$/).max(2048))` — accepts both full URLs and shorthand like `github.com/x/y`. Length-capped per the boundary patches.
    - `systemCachePath(flowId, version): string` — returns `path.join(os.homedir(), ".maister", "flows", `${flowId}@${version}`)`. Validates inputs via the schemas above; throws `MaisterError("FLOW_INSTALL", ...)` on validation failure.
    - `projectFlowSymlinkPath(workspaceRoot, projectSlug, flowId): string` — returns `path.join(workspaceRoot, ".maister", projectSlug, "flows", flowId)`. Same validation.
    - `workspaceRoot` param explicit (defaults to `process.cwd()` for the CLI/dev path; the future `lib/projects.ts` will pass the registered `project.repo_path`).
  - Logging: per-call DEBUG on the resolved path (no sensitive data, just the path string).
  - Acceptance: pure function — tested in Task 4. No I/O.

- [x] **Task 4: Unit tests for `flow-paths.ts`** — 28 assertions across systemCachePath / projectFlowSymlinkPath / schemas; all green under `pnpm test:unit`.
  - Files: `web/lib/__tests__/flow-paths.unit.test.ts` (new)
  - Test cases:
    1. `systemCachePath("bugfix", "v1.2.3")` returns `<HOME>/.maister/flows/bugfix@v1.2.3`.
    2. `projectFlowSymlinkPath("/repos/foo", "foo", "bugfix")` returns `/repos/foo/.maister/foo/flows/bugfix`.
    3. Reject `flowId` with `/` (path traversal) → throws `MaisterError` with `code: "FLOW_INSTALL"`.
    4. Reject `flowId` with `..` → throws `FLOW_INSTALL`.
    5. Reject empty `flowId` / `version` / `projectSlug` → throws `FLOW_INSTALL`.
    6. Reject `flowId` longer than 64 chars → throws `FLOW_INSTALL`.
    7. Reject `version` containing `/` → throws `FLOW_INSTALL`.
    8. `sourceUrlSchema` accepts `https://github.com/org/repo.git`, `github.com/org/repo`, `git@github.com:org/repo.git`. Rejects strings with whitespace or `;`.
  - Logging: tests assert no `pino` output leaks secrets (sanity check).
  - Acceptance: 8 cases green under `pnpm test:unit`.

### Phase 3: Loader core

- [x] **Task 5: `web/lib/flows.ts` — `installFlowPlugin` skeleton + git clone (idempotent) + in-process dedup**
  - Files: `web/lib/flows.ts` (new)
  - Module starts with `import "server-only";`. Logger: `const log = pino({ name: "flows" })`.
  - Private `asError(err: unknown): Error` helper (same shape as `config.ts:19`).
  - Private `inFlightInstalls = new Map<string, Promise<InstallResult>>()` keyed by `${flowId}@${version}`.
  - Export `installFlowPlugin({ source, version, projectId, projectSlug, flowId, workspaceRoot?, db? }): Promise<InstallResult>`.
  - Step A: validate inputs via `flow-paths.ts` schemas. Compute `target = systemCachePath(flowId, version)`. Compute dedup key.
  - Step B: if dedup map has the key, `await` the existing promise (idempotent under concurrent registration).
  - Step C: otherwise, create the install promise and store it in the map. The promise body:
    1. INFO log: `{ flowId, version, source, target }` "installing flow plugin".
    2. `stat(target)`. If exists and is a directory containing `flow.yaml` — skip clone, INFO log "skip clone (already installed)".
    3. Otherwise: `await mkdir(dirname(target), { recursive: true })` then `await execFile("git", ["clone", "--branch", version, "--depth", "1", source, target], { signal: AbortSignal.timeout(120_000) })`. DEBUG log stdout+stderr. On non-zero exit / timeout → `throw new MaisterError("FLOW_INSTALL", \`git clone failed for \${source}@\${version}: \${err.message}\`, { cause: asError(err) })`.
    4. After clone: `await loadFlowManifest(path.join(target, "flow.yaml"))`. On throw → catch + re-throw as `MaisterError("FLOW_INSTALL", ..., { cause })` so the UI branches on `FLOW_INSTALL` regardless of root cause.
  - Step D: finally, delete the dedup key from the map (whether success or failure).
  - Defer Tasks 6–8 work (symlink, db, setup.sh) — this task ships clone + manifest validation + dedup in isolation.
  - Logging: INFO on lifecycle events (install start, skip-or-clone decision, validation success), DEBUG on git stdout/stderr lines, ERROR via thrown `MaisterError` (caller logs).
  - Acceptance: returns when manifest is validated. Caller can read the cached manifest. Subsequent calls with same `flowId@version` skip clone.

- [x] **Task 6: `web/lib/flows.ts` — idempotent symlink creation**
  - Files: `web/lib/flows.ts` (extend)
  - After manifest validation, compute `linkPath = projectFlowSymlinkPath(workspaceRoot, projectSlug, flowId)`.
  - `await mkdir(dirname(linkPath), { recursive: true })`.
  - `lstat(linkPath)` — three branches:
    1. ENOENT → `symlink(target, linkPath)`, DEBUG log "created symlink".
    2. exists + is symlink:
       - `readlink` it.
       - If it already points to `target` (use `path.resolve` for comparison) — no-op, DEBUG log "symlink already correct".
       - Otherwise → `unlink(linkPath)` + `symlink(target, linkPath)`, DEBUG log "repointed symlink".
    3. exists + NOT symlink → `throw new MaisterError("FLOW_INSTALL", \`refuse to overwrite non-symlink at \${linkPath}\`)`. Never `rm` a regular file the user may have put there.
  - Logging: DEBUG on every fs op; INFO on the final symlink path.
  - Acceptance: tested in Task 11. After install, `fs.readlink(linkPath)` returns `target`.

- [x] **Task 7: `web/lib/flows.ts` — DB upsert into `flows` table**
  - Files: `web/lib/flows.ts` (extend)
  - Import `flows` table from `@/lib/db/schema` and `getDb` from `@/lib/db/client`. Accept an optional `db` param for testability (integration test passes a `drizzle(pool)` constructed against the testcontainer); production code calls `getDb()` when `db` is undefined.
  - Compute the row payload from the validated manifest:
    - `id: randomUUID()` (on insert) — on conflict, keep existing `id` (use `onConflictDoUpdate({ set: { ... }})` and do NOT include `id` in the `set` object).
    - `projectId, flowRefId: flowId, source, version, installedPath: target, manifest: <validated manifest>, schemaVersion: manifest.schemaVersion, recommendedExecutorId: manifest.recommended_executor ?? null`.
  - `await db.insert(flows).values({...}).onConflictDoUpdate({ target: [flows.projectId, flows.flowRefId], set: { source, version, installedPath, manifest, schemaVersion, recommendedExecutorId } })`.
  - Return `{ flowRowId, installedPath, symlinkPath, manifest }` so the caller can chain.
  - Logging: INFO "upserted flow row" with the row id + flowRefId + version.
  - Acceptance: tested in Task 11. After install, a row exists in `flows` with the expected payload. Re-install with the same `(projectId, flowRefId)` updates the row in place (verified by row `id` unchanged but `version` updated).

- [x] **Task 8: `web/lib/flows.ts` — optional `setup.sh` execution**
  - Files: `web/lib/flows.ts` (extend)
  - After the symlink (Task 6) and before the DB upsert (Task 7) — or after, order is invariant — check `stat(path.join(target, "setup.sh"))`.
  - If absent → DEBUG log "no setup.sh, skipping" and continue.
  - If present → `await execFile("bash", [path.join(target, "setup.sh")], { cwd: target, signal: AbortSignal.timeout(60_000) })`.
  - Non-zero exit / timeout → WARN log with stderr (do NOT throw — POC trusts internal sources per CLAUDE.md and the install is still useful even if setup.sh is buggy).
  - Logging: INFO "running setup.sh", WARN on non-zero exit.
  - Acceptance: tested in Task 11. Fixture without setup.sh installs cleanly. Fixture with setup.sh `exit 0` runs it. Fixture with setup.sh `exit 1` logs WARN and install completes.

### Phase 4: Test fixture + tests

- [x] **Task 9: Build the test fixture bare git repo** — implemented as `web/lib/__tests__/_fixtures/build-flow-plugin.ts` with 4 kinds (`valid` with v1.0.0+v1.1.0, `invalid-manifest`, `with-setup-ok`, `with-setup-fail`).
  - Files: `web/test-fixtures/build-flow-plugin.sh` (new) and `web/test-fixtures/.gitignore`.
  - Add a shell script that builds three bare git repos in `os.tmpdir()` (NOT committed) used by the integration test. Each repo has:
    - `flow.yaml` (valid v1 manifest with one `agent` step).
    - Variant A (`valid-flow`): valid manifest, tagged `v1.0.0`. Also a `v1.1.0` tag with the same flow.yaml but a different recommended_executor.
    - Variant B (`invalid-manifest`): `flow.yaml` with `schemaVersion: 99` (invalid), tagged `v1.0.0`.
    - Variant C (`with-setup`): valid manifest + `setup.sh` (exit 0 variant + exit 1 variant via env switch).
  - Decision: do the fixture build INLINE inside the integration test's `beforeAll` using `simple-git`-free shell-outs (`execFile("git", ["init", ...])`). Easier reproducibility than shipping a committed bare repo blob. The `web/test-fixtures/build-flow-plugin.sh` is the documented form but the test invokes the same logic in-process.
  - Logging: n/a (test helper).
  - Acceptance: helper produces three valid bare repos in `mkdtemp` that the integration test can clone via `file://` URLs.

- [x] **Task 10: `web/lib/__tests__/flows.unit.test.ts` — unit tests for pure logic** — landed as `web/lib/__tests__/flows.test.ts` with 8 boundary-validation cases. Mocked-execFile scenarios moved to integration suite (avoids `util.promisify(execFile)` symbol-table mocking pain).
  - Files: `web/lib/__tests__/flows.unit.test.ts` (new)
  - Test cases (no real git, no real db — mock `execFile` via vitest `vi.mock("node:child_process")`):
    1. `installFlowPlugin` validates inputs and rejects bad `flowId` → `FLOW_INSTALL`.
    2. Dedup map: two parallel calls with the same `flowId@version` execute git clone exactly once. Asserted via mock call count.
    3. `git clone` non-zero exit → throws `FLOW_INSTALL` with cause set to the original error.
    4. Manifest invalid (mock `loadFlowManifest` to throw `MaisterError("CONFIG", ...)`) → re-thrown as `FLOW_INSTALL` (UI branches on FLOW_INSTALL only).
  - Logging: tests use `pino` test stream to assert no token-like strings leak (defensive — there are none, but the patches set the precedent).
  - Acceptance: 4 unit tests green under `pnpm test:unit`.

- [x] **Task 11: `web/lib/__tests__/flows.integration.test.ts` — full install pipeline against real git + Postgres** — 7 scenarios green: end-to-end install, idempotent reinstall, invalid manifest, non-existent tag, version upgrade, setup.sh non-zero exit, concurrent same-project install dedup. ~3s once testcontainer is warm.
  - Files: `web/lib/__tests__/flows.integration.test.ts` (new)
  - Setup (in `beforeAll`, 180s timeout):
    1. Spin `PostgreSqlContainer` + `drizzle(pool)` + `migrate(db, { migrationsFolder: "./lib/db/migrations" })` (matches `foundation.integration.test.ts:27–46`).
    2. `mkdtemp` for both the fake `HOME` (set via `process.env.HOME` override OR by passing an explicit `homeDir` arg to `flow-paths.ts` helpers — pick the explicit-arg path to avoid env mutation in parallel tests).
    3. Build three fixture bare repos (variants A/B/C from Task 9) under another `mkdtemp`.
    4. Insert one `projects` row so the `flows` FK is satisfied.
  - Test cases (all in a single `it` to amortize container cost, OR multiple `it` if vitest concurrency is set to 1):
    1. Install valid v1.0.0 once → row in `flows`, `installedPath` exists with `flow.yaml`, symlink at `<workspaceRoot>/.maister/<slug>/flows/valid-flow` points to the cache path.
    2. Install valid v1.0.0 a second time → idempotent, skips clone (assert by checking the mtime didn't change), row `id` unchanged.
    3. Install variant B (invalid manifest) → throws `MaisterError` with `code: "FLOW_INSTALL"`, cause's message mentions schema version.
    4. Install with a non-existent tag (`v99.0.0`) on variant A → throws `FLOW_INSTALL`, cause's message contains git stderr.
    5. Install valid v1.1.0 over an existing v1.0.0 row → row updated in place (same `id`, new `version`, new `installedPath`), symlink repointed.
    6. Install variant C with `setup.sh exit 1` → completes successfully, WARN log captured (use a pino test stream).
  - Cleanup (`afterAll`): `pool.end()`, `container.stop()`, `rm` all temp dirs.
  - Logging: integration test captures pino output into a stream for assertion of WARN on setup.sh failure.
  - Acceptance: 6 scenarios green under `pnpm test:integration`. Container startup happens once.

### Phase 5: Dev CLI + docs

- [x] **Task 12: `web/scripts/install-flow.ts` — ops smoke-test CLI** — landed with arg parser, `getDb()` lookup of project by slug, `installFlowPlugin()` call, `flushLogger()` before `process.exit`, and `scripts/_register-shim.mjs` + `_server-only-shim.mjs` ESM loader to make tsx work outside Next.js bundler.
  - Files: `web/scripts/install-flow.ts` (new), update `web/package.json` to add `"install-flow": "tsx scripts/install-flow.ts"` script.
  - Arg parsing (no dep needed — `process.argv` + a tiny inline parser): `--project <slug> --source <url> --version <tag> --flow-id <id> [--workspace-root <path>]`.
  - Requires `DB_URL` env (so the row gets persisted). Looks up the `projects` row by `slug` to get `projectId` + `repo_path`. Throws `MaisterError("PRECONDITION", ...)` if the project isn't registered (manual `db.insert(projects)` step happens in M9 — for M4 the CLI works against a seeded row from `web/lib/db/seed.ts`).
  - Calls `installFlowPlugin(...)`. Logs result. Exits 0 on success, 1 on `MaisterError`.
  - Logging: INFO on each lifecycle event (matches `flows.ts` log output).
  - Acceptance: `DB_URL=... pnpm install-flow --project bugfix-demo --source <local-fixture-bare-repo-path> --version v1.0.0 --flow-id bugfix` succeeds against a locally-seeded project + a fixture repo. Manual smoke-test only (not part of CI test matrix).

- [x] **Task 13: Documentation + ROADMAP update** — `docs/flow-installer.md` (new), `docs/getting-started.md` "Install a Flow plugin" section, README.md docs table updated, `.ai-factory/ROADMAP.md` M4 marked `[x]` with shipping summary.
  - Files: `docs/flows.md` (new), `docs/getting-started.md` (extend), `.ai-factory/ROADMAP.md` (mark M4 `[x]`).
  - `docs/flows.md` contents:
    - What a Flow plugin is (git repo with `flow.yaml` manifest + optional `setup.sh` + shipped CLIs/skills).
    - System cache layout: `~/.maister/flows/<id>@<tag>/`.
    - Per-project symlink layout: `.maister/<slug>/flows/<id>/`.
    - `flow.yaml` schema reference (link to `web/lib/config.schema.ts`).
    - `installFlowPlugin()` API signature + error codes.
    - Concurrent-install behavior (in-process dedup, NOT cross-process file lock — single-host POC).
    - `setup.sh` trust model: POC trusts all sources; Phase 2 sandboxing.
    - Dev CLI usage (`pnpm install-flow ...`).
  - `docs/getting-started.md` extension: short section on how to register a flow plugin against a project (manual seed + CLI workflow on POC).
  - `.ai-factory/ROADMAP.md`: change `- [ ] **M4. Flow plugin loader**` to `- [x] **M4. Flow plugin loader** — shipped 2026-05-26 via `feature/m4-flow-plugin-loader`. ...` and add the row to the Completed table.
  - This task runs through `/aif-docs` per the docs-policy setting; the mandatory docs checkpoint is the gate.
  - Acceptance: `docs/flows.md` exists with the sections above. `docs/getting-started.md` references it. `.ai-factory/ROADMAP.md` M4 line shows `[x]` with a shipping summary.

## Out of scope (defer to follow-up milestones)

- `web/lib/projects.ts` — project registry CRUD, recursive `MAISTER_PROJECTS_DIR` discovery, slug + `repo_path` uniqueness enforcement. → M9.
- `POST /api/projects` route handler that calls `installFlowPlugin()` per `flows[]` entry. → M9.
- Add-project UI form. → M9.
- Phase 2 plugin sandboxing / trust UI. → out of POC.
- Cross-process file-lock for installs. → not needed on single-host POC; in-process Map dedup is sufficient.
