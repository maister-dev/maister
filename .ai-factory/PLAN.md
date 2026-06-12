# AIF Flow-Package: single-import model — Implementation Plan

> **✅ STATUS (2026-06-12): SUPERSEDED. Do not implement this fast plan.**
> The Package-management milestone this plan deferred to is now designed and in
> delivery: design `docs/pv/package-management.md` (ADR-088), implementation
> plan `.ai-factory/plans/feature-package-management.md` (M33). The locked
> decisions below were carried into that design (with `flow_packages[]` renamed
> to `packages[]`); the AIF package itself was extracted to the external
> `maister-plugins` repo (`packages/aif`, tag `aif/v2.0.0`). Body kept for
> history only.

> **⏸ PRIOR STATUS (2026-06-09): DEFERRED + EXPANDED. Do not implement this fast plan as-is.**
> The user expanded scope: packages are a **first-class product surface**, not just backend wiring. This plan becomes the backend slice of a larger **"Package management" milestone** to be designed (a proper design doc) **after** the T9 dogfood validates the engine on the current 5-source wiring.
> **Locked decisions for that milestone (2026-06-09):**
> 1. **Two-scope model:** a package installs once at the **platform instance** (instance-wide catalog, viewable), then is **attached/enabled per project**. Mirrors the platform ACP-runner catalog + `platform|project|flow-package` capability scopes.
> 2. **UI authoring:** the user *forms the package description* (`maister-package.yaml` + flows + bundle) from the UI when creating a package — extend `package-authoring.ts` (today single-`flowYaml`) + `package-files-editor.tsx` + `/flows/new` to multi-flow packages. "Needed very soon."
> 3. **Package viewer:** browse packages **attached to a project** AND **platform-instance** packages, inspecting **all contents** (every flow graph + every skill/agent/rule + files + metadata + version). Extends `/flows` + `/flows/[projectSlug]/[capId]`.
> 4. **Package-as-first-class-entity:** a DB row groups an installed package → its installed flows + capabilities + scope + version → **requires a migration** (this fast plan's "no migration" is now void). `maister-package.yaml` is the single artifact authored ↔ installed ↔ viewed.
> Sequencing: **T9 dogfood first** (current 5-source wiring), **then** the Package-management design + phased plan. The single-import details below feed that design.

**Branch:** `feature/aif-flow-package` (stay on it — no new branch) · **Created:** 2026-06-09 · **Consumer:** Package-management design (deferred)
**Supersedes:** Task 8's 5-source wiring in `.ai-factory/plans/feature-aif-flow-package.md`.
**Re-opens:** design finding **F3** ("one flow.yaml per source") for the *package* case.

Deliver the AIF package as **one versioned import**. Today `maister.yaml` must list 5 separate `flows[]` entries (each `{source, version}`) + a `capability_imports[]` entry — six things to version in lockstep ("config/version hell"). Add an explicit **flow-package manifest** so a single import registers all 5 flows + the capability bundle, pinned to one version. The 5 authored `flow.yaml` graphs and the `capability/` bundle are **unchanged** — only the packaging/install/wiring layer is new and additive (existing single-flow `flows[]` keeps working).

## Settings

- **Testing:** yes — TDD for every platform change (failing test → implement → green). Reuse the project harnesses (`renderToStaticMarkup` n/a here; `*.test.ts` unit + the `fakeDb`/testcontainers integration patterns).
- **Logging:** verbose — `pino` DEBUG at manifest-load + per-flow/per-bundle install decisions; WARN on manifest/schema rejects; never log secrets.
- **Docs:** yes — update the design doc (F3/§4), add an ADR, update `docs/configuration.md`.

## Roadmap Linkage

- **Milestone:** M20. Dogfood + external validation (same as the parent plan — this unblocks the dogfood T8/T9 with a sane single-import wiring).

## Conventions

Follow `web/CLAUDE.md`. Throw `MaisterError` with a `code` (CONFIG/FLOW_INSTALL) — never plain `Error`; strict TS (no `any`); zod-validated config; atomic writes to `.maister/`. Surgical, additive changes (do NOT break `flows[]`/`capability_imports[]`). Scoped lint only (`eslint <paths>`, never repo-wide `--fix`); scoped vitest (`pnpm exec vitest run --project <unit|integration> <file>`).

## Key decisions (baked into this plan — user-confirmed)

1. **maister.yaml surface = a new `flow_packages[]` field** (NOT overloading `flows[]`). Entry shape `{ id, source, version, path? }`:
   - `source` — a **git repo URL** (real distribution; pulled from git/github on register) OR a `file://`/abs path (local dogfood). Same `isLocalDirectorySource` split the flow installer already uses.
   - `path` — optional **subpath to the package within the source** (e.g. `plugins/aif` in a monorepo). Defaults to the source root.
   - `version` — git tag/ref (or `local-dev` for file://).
   Keeps `flows[]` ("one flow per entry") intact + backward-compatible; `flow_packages[]` = "one package → many flows + bundle".
2. **Package manifest filename = `maister-package.yaml`** at the package root — generic for ALL packages (per user). Lists each flow `{id, path}` and the capability bundle(s) `{id, path}`. The package is **self-contained**: the bundle ships INSIDE the package (no separate `capability_imports[]` line in the project `maister.yaml`).
3. **Flow ids are authoritative from the manifest** (`flows[].id`), validated against each referenced `flow.yaml` (`name` must match, else CONFIG) so the catalog id and the graph agree.
4. **One version pins everything.** Every flow + the bundle inherit the `flow_packages[].version`; content-addressing still uses each sub-dir's own digest (`flow-paths.ts`), but the *project-declared* version is the single package version.
5. **Clone/resolve ONCE, then sub-install locally.** `installFlowPackage` resolves the package root a single time — `git clone <source>@<version>` into a temp (real) OR the local dir (dogfood) — then installs each flow + the bundle from the **local** subpath (`file://<pkgRoot>/<sub>`), so a 5-flow + bundle package costs **one** clone, not six. Existing `installFlowPlugin`/`installAndIngestCapabilityImports` are reused on the local sub-sources; the clone temp is cleaned up after.

## Dependencies / order

```
T1 manifest schema+loader ─┐
T2 maister flow_packages[] ─┼─► T3 installFlowPackage ─► T4 registration expansion ─► T5 author manifest + rewire dogfood ─► T6 docs
                            ┘
```

---

## Phase 1 — Config surface (TDD)

### Task 1: Package manifest schema + loader
- **Deliverable:** `maisterPackageManifestSchema` + a validating loader for `<packageRoot>/maister-package.yaml`.
- **Files:** modify `web/lib/config.schema.ts` (add `maisterPackageManifestSchema`: `{ schemaVersion: literal(1), name: string, flows: [{id, path}].min(1), capability_imports?: [{id, path}] }`, `.strict()`, export `MaisterPackageManifest` type); modify `web/lib/config.ts` (add `loadMaisterPackageManifest(packageRoot)` mirroring `loadFlowManifest`: read `maister-package.yaml`, YAML-parse, zod-validate, escape-guard each `path` as a relative segment (no `..`/abs — reuse the SAFE-path discipline), reject duplicate flow/capability ids).
- **TDD:** `web/lib/__tests__/config.schema.test.ts` — valid manifest round-trips; missing `flows` / bad `path` (`../x`, `/abs`) / dup id rejected. `web/lib/__tests__/config.test.ts` — `loadMaisterPackageManifest` returns parsed flows+capability; CONFIG on missing file / bad YAML / escape path.
- **Logging:** WARN on manifest validation reject (path + zod issues); DEBUG on load (flow count).

## Phase 2 — Install + registration (TDD)

### Task 2: `maister.yaml` `flow_packages[]` field
- **Deliverable:** maister.yaml accepts `flow_packages: [{id, source, version, path?}]` (additive; defaults `[]`).
- **Files:** modify `web/lib/config.schema.ts` (`flowPackageEntrySchema = { id: capabilityRefIdSchema, source: string.min(1), version: capabilityRefIdSchema, path: relativeSubpath.optional() }` — `path` escape-guarded (no `..`/abs); add `flow_packages: z.array(flowPackageEntrySchema).default([])` to `maisterYamlV2Schema`); modify `web/lib/config.ts` `loadProjectConfig` (validate: no duplicate `flow_packages[].id`; reject id collisions across `flows[]` ∪ `flow_packages[]` ∪ `capability_imports[]`).
- **TDD:** `web/lib/__tests__/config.test.ts` — a maister.yaml with `flow_packages[]` (git source + `path`, and a file:// variant) parses; bad `path`, duplicate package id, and cross-list id collision all throw CONFIG. Existing `flows[]`-only configs still parse (backward compat).
- **Logging:** DEBUG `flow_packages` count in the existing `maister.yaml loaded` line.

### Task 3: `installFlowPackage` orchestrator (clone-once → local sub-install)
- **Deliverable:** `installFlowPackage({projectId, projectSlug, source, version, path?, db, signal?})` installs **all** flows in the package + its capability bundle(s) from one source, sharing the declared version, with a SINGLE clone/resolve.
- **Files:** create `web/lib/flow-packages.ts` (new module; keeps `flows.ts` focused). Steps:
  1. Resolve the package root ONCE: `isLocalDirectorySource(source)` → local → `pkgRoot = join(absPath, path ?? ".")`; else `git clone <source>@<version>` into a temp (reuse the `flows.ts` `gitClone` helper) → `pkgRoot = join(tmp, path ?? ".")`. `try/finally` removes the temp clone.
  2. `loadMaisterPackageManifest(pkgRoot)`.
  3. For each manifest flow → `installFlowPlugin({ source: <file:// pkgRoot/flow.path>, version, projectId, projectSlug, flowId: flow.id, db })` (local sub-source ⇒ no re-clone; content-addressed by the subdir digest). Validate `loadFlowManifest(<sub>/flow.yaml).name === flow.id` (CONFIG mismatch).
  4. For each manifest `capability_imports` entry → `installAndIngestCapabilityImports` (`@/lib/capabilities/import`) on the local `pkgRoot/cap.path`.
  5. Return `{ flows: InstallResult[], capabilities: [...] }`.
  Read `installFlowPlugin` (`lib/flows.ts:974`), `installRevision` source-kind split (`lib/flows.ts:600`, `gitClone`), and `installAndIngestCapabilityImports` (`lib/capabilities/import.ts:697`) signatures first; confirm whether the `file://` sub-source path is accepted as a local dir by `isLocalDirectorySource` (else pass the abs path form it expects).
- **TDD:** `web/lib/__tests__/flow-packages.test.ts` — with a fixture package dir (tmp holding `maister-package.yaml` + 2 stub `flows/*/flow.yaml` + a stub `capability/`), `installFlowPackage` (local source, no `path`, and a `path`-subdir variant) invokes `installFlowPlugin` once per manifest flow (correct local sub-source/`flowId`/`version`) and the capability import once; `name`≠`id` mismatch throws CONFIG; the temp clone is cleaned up on both success and sub-install failure. `fakeDb`/spy harness (mock the two installers + `gitClone`) — assert the orchestration + single-clone contract, not real disk installs.
- **Logging:** INFO clone/resolve (source, version, resolved sha, pkgRoot); INFO per installed flow (`flowId`, sub-path); INFO per bundle import; WARN+rethrow on any sub-install failure (after temp cleanup).

### Task 4: Registration expansion
- **Deliverable:** project registration installs `flow_packages[]` (each → all its flows + bundle) alongside the existing `flows[]`/`capability_imports[]` loops.
- **Files:** modify `app/api/projects/route.ts` POST — after `loadProjectConfig` (line ~203) and the existing `for (const flow of config.flows)` (line ~341) + `installAndIngestCapabilityImports` (line ~383), add `for (const pkg of config.flow_packages) { await installFlowPackage({...}) }`. A package-install failure must unwind via the SAME slug-scoped cleanup/compensation the existing flow-install failure path uses (trace it at line ~415) — no orphan rows/dirs.
- **TDD:** registration integration test (testcontainers + the seeded `stub-supervisor` pattern used by existing project-register tests): a maister.yaml with one `flow_packages` entry pointing at a fixture package registers N flow rows + the capability rows; a bad manifest fails the registration cleanly (compensation runs). Locate the existing project-register test to extend it.
- **Logging:** INFO `flow_packages` expansion (package id → installed flow ids).

## Phase 3 — Package + dogfood rewire

### Task 5: Author `maister-package.yaml` + collapse the dogfood `maister.yaml`
- **Files:** create `plugins/aif/maister-package.yaml` (`schemaVersion:1`, `name: aif`, `flows: [{id: aif-dev, path: flows/dev}, …×5]`, `capability_imports: [{id: aif-bundle, path: capability}]`). Rewrite the worktree-root `maister.yaml` to ONE `flow_packages` entry and remove the 5 `flows[]` + 1 `capability_imports[]` entries. For local dogfood use `{id: aif, source: file://…/peaceful-mclean-6a799f, path: plugins/aif, version: local-dev}` (mirrors the real git shape `source: <repo>, path: plugins/aif, version: <tag>`).
- **TDD:** `web/lib/__tests__/aif-package.test.ts` — `loadMaisterPackageManifest("…/plugins/aif")` succeeds, lists exactly the 5 flow ids + `aif-bundle`, and each referenced `flows/<path>/flow.yaml` + `capability/` exists on disk (path-resolution guard). Complements `aif-flows.test.ts`.
- **Logging:** n/a (content).

## Phase 4 — Docs

### Task 6: Docs — F3 revision + ADR + configuration reference
- **Files:** `docs/plans/2026-06-08-aif-flow-package-design.md` (revise **F3** and **§4**: the package is one import via `maister-package.yaml`; one version pins all flows + bundle; git source + `path` subpath). `docs/decisions.md` (new ADR: "Flow packages — multi-flow single-import via package manifest, pulled from git by source@version with subpath"; supersede/annotate the F3 stance). `docs/configuration.md` (document `maister.yaml flow_packages[]` = `{id, source, version, path?}` + the `maister-package.yaml` manifest schema, cross-referenced, EN only per docs R8).
- **Logging:** n/a.
- **Gate:** `pnpm validate:docs` (Mermaid/doc gate) clean for changed docs.

## Commit Plan

6 tasks → checkpoints (each task also commits on green):
- **CP-A** (T1–T2): `feat(config): flow-package manifest schema + maister.yaml flow_packages[]`
- **CP-B** (T3–T4): `feat(flows): installFlowPackage orchestrator + registration expansion`
- **CP-C** (T5): `feat(aif): maister-package.yaml manifest + single-import dogfood maister.yaml`
- **CP-D** (T6): `docs(flows): flow-package single-import model — F3 revision + ADR + configuration`

## Verification

- Scoped unit + integration green for each task; full `pnpm exec vitest run --project unit` green; `tsc --noEmit` clean; scoped eslint clean on touched files.
- **Dogfood re-verify (resumes parent T8/T9):** re-register the `maister` project from the worktree dir → ONE `flow_packages` import installs all 5 flows + `aif-bundle` into `~/.maister/` (same end state as today's 6-entry wiring), then launch `aif-dev`.

## Out of scope

A **live git-remote integration test** for the subpath clone (no test remote; the `path`-resolution + clone-once logic is unit-tested with a mocked `gitClone` + a local fixture, and the file://+`path` shape is exercised end-to-end — real `github.com` pull is a manual/later check, see Unresolved Q1). Per-flow `runner`/`version` overrides inside a package (one shared version is the whole point). Removing the legacy `flows[]`/`capability_imports[]` surfaces (kept for backward compat).

## Resolved decisions (2026-06-09, user)

1. Манифест пакета: **`maister-package.yaml`** (единое имя для всех пакетов).
2. Поверхность в `maister.yaml`: новое поле **`flow_packages[]`** = `{id, source, version, path?}` (source = git-репо или file://, path = подпуть пакета в репо).
3. Бандл — **внутри пакета** (его `maister-package.yaml` перечисляет capability_imports); в проектном `maister.yaml` отдельной строки под бандл нет. При импорте проекта пакет тянется из git/github по `source@version`.

## Unresolved questions

1. Реальная git-дистрибуция (`source: github.com/…`, `path: plugins/aif`, `version: <tag>`) — клонировать через существующий `gitClone` хелпер с поддержкой подпути (план это закладывает), но тест на git-подпуть требует живого remote → проверяем локально (file://+path), git-путь — вручную/позже. Ок?
