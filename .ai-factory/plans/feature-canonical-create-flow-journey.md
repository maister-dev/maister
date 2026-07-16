# Implementation Plan: Canonical Studio Create Flow Journey

> **Implementation status:** planned only. This artifact deliberately contains no
> production implementation. The implementation phase must work task-by-task in
> the stated RED -> GREEN -> refactor order.

**Goal:** Let a member create any valid Flow in a Git-backed local package.
Creating a new package bootstraps it with one Flow; an editable package can use
the same journey repeatedly for additional Flows. Both paths use the existing
Commit -> content-addressed Cut -> Attach/Repoint -> launch lifecycle. The
success path stays inside Studio and opens the new Flow in the existing package
editor immediately.

**Architecture:** Keep local packages as the sole authored source of
launchable/pinnable Flows. Add one server-side operation for the initial
package-and-Flow scaffold and one lock-guarded operation for adding a Flow to
an existing working directory. A nullable, server-only durable operation state
on `local_packages` coordinates the database row with the private filesystem
journal; it is **not** a DB-authored Flow model. Reuse existing Git, cut,
install, attachment, and graph-runner services; do not add a second narrow
editor, a version-label input, or a Flow DSL change.

**Tech stack:** Next.js 16 App Router, React 19, TypeScript strict, Zod, Drizzle
and Postgres, local Git, next-intl EN/RU, Vitest, Playwright.

Branch: `feature/canonical-create-flow-journey`
Created: 2026-07-16
Spec target: `.ai-factory/specs/feature-canonical-create-flow-journey.md`

## Settings

- Testing: yes. All behavior work is strict TDD: capture a focused failing RED
  test, implement only enough for GREEN, then refactor inside the touched
  surface while the exact test stays green.
- Logging: verbose structured server logging for operation state transitions
  and recovery only. Fields are `operationId`, `localPackageId`, `flowId`, and
  enum `phase`/`outcome`; never log package names, filesystem paths, YAML,
  manifest bytes, form values, Git output, or package file contents. No client
  `console.*`.
- Docs: yes. Phase 0 freezes the product, HTTP, recovery, security, database,
  and legacy contract before code. New API routes require OpenAPI changes. One
  generated Drizzle migration adds durable operation state; its schema and DB
  documentation must change in the same task. No AsyncAPI, deployment, or
  engine-document change is planned.

## Product Contract and UX Expectations

### Canonical journey

1. On **Studio Packages** and **Local Packages**, the primary action is
   **Create package and Flow**. It opens one compact Flow-specific dialog,
   rather than navigating to a separate editor or exposing generic Add File.
2. The dialog asks for package name plus Flow ID, title, summary, and
   `metadata.route_when`. Labels, links, and sources are optional, progressive
   fields. The UI calls these values **Flow metadata**, never Markdown
   frontmatter.
3. A successful request creates the package, package manifest membership,
   `flows/<flow-id>/flow.yaml`, and initial Git commit atomically enough to
   recover from every identified interruption. It opens
   `/studio/edit/<localPackageId>/flows/<flow-id>/flow.yaml`.
4. At an existing editable local package's package home, **Add Flow** opens the
   same dialog with the package name fixed and omitted from submission. It uses
   a server-side operation, not the current client-side multi-file save. It
   leaves the working tree dirty so the existing Commit control remains the
   explicit checkpoint. It can be repeated for every additional Flow; it is not
   limited to a package's first Flow.
5. The fast success track is deliberately in-place: one dialog, one submit,
   direct navigation to the existing graph/YAML editor, and no mandatory
   intermediate package-home, catalog, or separate authored-Flow screen.

### Required generated files and invariant

The operation must generate exactly one package membership and one Flow file:

```yaml
# maister-package.yaml (relevant membership)
flows:
  - id: <flow-id>
    path: flows/<flow-id>

# flows/<flow-id>/flow.yaml
schemaVersion: 1
name: <flow-id>                 # machine-readable ID
metadata:
  title: <display-title>         # human-readable title
  summary: <summary>
  route_when: <route-when>
  labels: [...]                  # only when supplied
  links: [...]                   # only when supplied
  sources: [...]                 # only when supplied
compat:
  engine_min: "3.0.0"
capabilities: []
artifacts: []
nodes:
  - id: start
    type: ai_coding
    action:
      prompt: "Describe the task."
    transitions:
      success: done
```

The exact serialization must come from existing schemas/serializers where
available and must pass the current graph parser and package validator before
any durable write. The starter graph is intentionally conservative and does not
extend the DSL, engine, artifact model, capability model, or engine minimum.

### Empty existing packages

`flows: []` remains valid for already-created capability/agent-only local
packages. Do **not** retrospectively migrate, delete, or make those packages
uncuttable: current code permits that lifecycle and changing it would strand a
supported package type. Instead, Local Packages and the package home display a
localized, persistent **No Flow yet** state explaining that it has no launchable
Flow and offering **Add Flow** as the primary recovery action. A newly created
scratch package can never enter that state because `flow` is required.

### Lifecycle boundaries that must remain unchanged

- Creation performs file scaffolding plus local Git initialization only. It
  never invokes `setup.sh`, package hooks, MCPs, Flow nodes, installers, or any
  arbitrary package code. `git init`/initial commit continue to use
  `--no-verify`.
- Existing package Flow creation does not commit automatically. The user uses
  the existing lock-protected Commit control, then Cut.
- Cut remains `local-<digest>` and content-addressed. There is no editable
  local version name field.
- First attachment/repoint remains the existing Project Packages surface;
  post-cut adoption/repoint remains existing behavior. `try_once` remains an
  ephemeral experiment choice, not a replacement for durable Attach/Repoint.
- A real launch uses the attached immutable package revision. Test-only
  conversion of the starter Flow to an all-`cli` graph is allowed so the real
  engine can run without an ACP test adapter; production defaults remain the
  starter graph above.

## Ground Truth and Reconciliation Decisions

| Surface | Verified current behavior | Planned resolution |
| --- | --- | --- |
| New scratch package | `POST /api/studio/local-packages` accepts `{name}` and creates `flows: []`, then redirects to package home. | Require `flow`; scaffold both files and the initial Git commit, then open the Flow canvas. |
| Existing package Add | Generic composition can scaffold a flow with only a name; client `runSave` writes manifest and Flow separately. | Give Flow a dedicated entry to the shared wizard and a single server-side operation; retain generic Add only for non-Flow artifacts. |
| Empty packages | Valid and currently cuttable/attachable, but have no launchable Flow. | Keep compatibility; surface an explicit localized recovery/CTA. Correct docs that claim installation rejects them. |
| Legacy `/flows/new` | Creates a DB catalog draft, not a Git local package. | Redirect to `/studio/packages?create=flow`; no new DB-authored Flow is created. |
| Authored publish bridge | The authored page/server action publishes catalog state only. The REST `publish-local` endpoint separately calls the bridge. Existing docs say UI publication always bridges. | Code is authoritative. Keep existing authored detail as explicitly limited compatibility UI; label it catalog-only and link to Studio for launchable Flows. Correct docs and tests; do not silently wire a new bridge into this feature. |
| Flow runtime | Graph manifests are current; legacy `steps:` fixtures are incompatible. | Reuse current graph schema and replace stale lifecycle fixtures with graph-only data. |
| Local-package recovery | `createLocalPackage` persists a row before filesystem/Git initialization; durable upstream sync already stores `sync_state` on that row. A filesystem-only journal would have no database-owned recovery claim. | Add a nullable `creation_state` operation record with safe IDs/phases/hashes. It blocks normal lifecycle actions until deterministic reconciliation clears it or exposes a localized recovery-required state. |
| Working-dir concurrency | The edit lock prevents a different session, but it does not serialize same-session file writes, commit/discard/import, Cut, or a live local-package assistant. | Reuse the existing database-backed working-dir mutation lease for every changed writer, with one documented lock order and an explicit active-assistant refusal. |
| UI authority | The editor passes `canManage` unconditionally and Studio list pages expose mutation affordances without a server-derived active-member capability. | Derive one shared active-member capability for the Studio pages/components; HTTP routes remain authoritative. |
| OpenAPI drift | The collection POST describes an unimplemented `sourceInstallId` fork, file-write omits its required `sessionId`, and `/files/{path}/move` is documented without a route. | Reconcile these exact local-package contract inaccuracies while documenting the two real create endpoints; do not mark an unimplemented route as shipped. |

## Locked Contract Decisions

1. **One durable-operation migration; no authored-Flow table.** Add nullable
   `local_packages.creation_state jsonb`, decoded through a strict server-only
   `LocalPackageCreationState` type. It contains `operationId`, operation kind,
   phase, Flow ID, and expected/original hashes only—never YAML, paths, names,
   form data, or package bytes. `NULL` means ready. It does not alter package
   membership, the authored catalog, or package-version data.
2. **Three HTTP changes are necessary.** Reusing the file PUT API cannot make
   package-manifest membership plus `flow.yaml` atomic.
   - Extend `POST /api/studio/local-packages` to require
     `{ name, flow }`; return `{ localPackage, createdFlow }` with
     `createdFlow: { id, path }`.
   - Add `POST /api/studio/local-packages/{id}/flows`, accepting
     `{ sessionId, flow }`, and return `{ createdFlow }`.
   - Add `POST /api/studio/local-packages/{id}/creation-recovery` with no body.
     It retries only deterministic hash-based reconciliation for the URL-owned
     package and returns the safe recovery status; it never accepts a path,
     payload, action selector, or cross-resource identifier.
   `sourceInstallId` is removed from the scratch-create contract: it does not
   actually clone source content, and real forks retain their dedicated path.
3. **Identifier trust is explicit.** On collection create, user identity comes
   from auth and the server derives slug, database ID, working directory,
   branch, and operation ID; the body contains no project ID, package ID, path,
   or version. On add Flow, `{id}` is URL -> server package row -> server-only
   working directory; auth user is server-derived; `sessionId` is only a
   lock-capability value and must be checked against that row; the body contains
   no redundant package/project/path identifier. On recovery retry, `{id}` is
   URL -> server package row -> durable recovery state; authentication is
   server-derived and there is no body. No response exposes a working directory
   or journal location.
4. **RBAC and locks:** both mutations require an active global `member`; add
   Flow also requires the existing live edit lock before validation or
   filesystem work. Every writer touched by this feature takes the existing
   working-dir mutation lease after the edit-lock check and releases it in a
   `finally`; Cut uses the same lease before reading/exporting. A live
   local-package assistant is a typed `CONFLICT` for Add Flow. Read-only,
   inactive, and password-change-required users see a localized explanation and
   no enabled submit action; routes remain authoritative and refuse forged
   requests.
5. **Legacy scope:** `/flows/new` redirects permanently to Studio. Existing
   `/flows/[projectSlug]/[capId]` remains only for legacy catalog drafts and
   states that publishing there is catalog-local/non-launchable. The distinct
   REST bridge remains documented exactly as implemented. This feature does not
   migrate historical drafts or make it a second launch path.
6. **No deployment/runtime expansion:** no environment variable, sidecar, port,
   package dependency, Compose change, AsyncAPI event, Flow DSL, or engine
   change is added. The generated database migration and its documentation are
   part of this feature.

## Atomicity, Rollback, Crash Recovery, and Safety

### New package plus Flow

Use a private staging directory and private filesystem journal under the local
package runtime root (outside the package export and excluded from Git), paired
with `local_packages.creation_state` as the database-owned recovery claim:

1. Validate the request, normalize optional metadata, and build the complete
   manifest plus Flow bytes in memory. The server runs client-safe Flow schema /
   graph checks **and** full package validation over that complete in-memory
   file set before any DB or filesystem write; it rechecks the staged bytes
   before advancing durable state.
2. Allocate `operationId`, an explicit local-package UUID, unique package slug,
   final working directory, and sibling staging directory. Insert the package
   row with `creation_state={kind:"create_package_flow", phase:"claimed", ...}`
   before filesystem work; unique slug conflicts fail without a stage.
3. Atomically write a hash-only private journal, scaffold the complete staged
   package, validate it, and perform the initial `git init`/commit with
   `--no-verify`. Advance the DB state to `stage_ready` only after the expected
   staged hashes and initial commit exist.
4. Rename staging to final, verify final hashes, then clear `creation_state` in
   the row. Only a row whose state still carries this exact `operationId` may be
   finalized or compensated.
5. On an ordinary failure, compensate in reverse: remove uncommitted staging,
   delete only this operation's unfinished row, and remove the private journal.
   Compensation failure leaves durable recovery state intact; it never deletes a
   path solely by name.
6. Reconciliation is idempotent and always takes the mutation lease. It may
   finish an exact stage/final state, clear an already-completed or proven
   compensated state, or mark `recovery_required` on any missing/mismatched
   hash. The last case is read-safe but blocks editor writes, Commit, Cut,
   archive, and delete until a localized recovery action resolves it. Existing
   immutable cuts may still be attached/repointed because that path never reads
   the inconsistent working tree. Reconciliation never guesses, overwrites, or
   executes package code.

The initial commit therefore contains both `maister-package.yaml` and the
new Flow and leaves a clean working tree.

### Add Flow to an existing package

1. Parse and validate the requested Flow, verify unique ID in both package
   membership and target path, assert the caller's edit lock, reject a live
   local-package assistant, then acquire the existing per-package
   working-directory mutation lease. Lock order is invariant: authorization /
   edit lock -> mutation lease -> reload row and working tree -> write ->
   validate -> release in `finally`.
2. Claim `creation_state={kind:"add_flow", phase:"claimed", ...}` with a
   compare-and-set that rejects an existing operation. Create a private journal
   and backup under local operation state. The durable state stores original and
   expected hashes only; payload bytes never leave private journals/backups and
   are never logged.
3. Write the Flow and manifest through server-only atomic writes, run complete
   package/graph validation, verify final hashes, and clear both journal and
   `creation_state`. The working tree is intentionally dirty until the user
   invokes existing Commit.
4. On an ordinary failure, restore the original manifest and remove the created
   Flow only when the stored hashes prove ownership, then clear state. If that
   compensation is unsafe or fails, retain recovery state and show
   recovery-required rather than silently continuing.
5. Recovery may finish an exact intended state, clear a proven original state,
   or fail closed on drift. No client retries per-file PUTs, no recovery
   executes package code, and no normal writer may pass a non-NULL state.

### Recovery surface and operation visibility

- `creation_state` is never serialized verbatim. List/editor projections expose
  only `ready | recovering | recovery_required` plus localized remediation.
- A recovering package is omitted from ordinary ready-only creation choices; a
  recovery-required package remains visible as a non-editable row/card so it is
  not silently stranded. Its only offered actions are deterministic service
  recovery operations; generic file mutation is disabled.
- Reconciliation has a single service owner and runs before a targeted package
  lifecycle action, rather than making unrelated list reads silently mutate the
  filesystem. Listing uses a short safe projection for visibility only.
- Existing `sync_state` remains the upstream-sync state machine. Creation and
  sync cannot overlap because the shared mutation lease serializes both.

## API Contract Delta

`CreateFlowInput` is shared by both operations. Its client-safe Zod contract,
normalization, and starter-manifest factory live outside `server-only` modules;
the server-only operation subsequently performs complete package validation:

```ts
type CreateFlowInput = {
  id: string;
  metadata: {
    title: string;
    summary: string;
    route_when: string;
    labels?: string[];
    links?: Array<{ kind?: string; title: string; url: string }>;
    sources?: Array<{ component: string; origin: string }>;
  };
};
```

The implementation must derive the exact Zod shape from existing Flow metadata
and capability-ID schemas rather than introduce parallel regexes or looser
link/source types. Client validation provides immediate feedback; server
validation, full package validation, and graph compilation are authoritative.

| Endpoint | Request authority | Success response | Refusal boundary |
| --- | --- | --- | --- |
| `POST /api/studio/local-packages` | Authenticated active member supplies only `{name, flow}`. The server derives user, package UUID, slug, operation ID, working directory, and branch. `sourceInstallId` is not accepted. | `201 { localPackage, createdFlow: { id, path } }` | Body validation `422`; name/slug collision `409`; no row/final directory is presented as ready before recovery completes. |
| `POST /api/studio/local-packages/{id}/flows` | URL `{id}` resolves the package and server-only working directory. Auth provides user; body supplies only `{sessionId, flow}`. | `201 { createdFlow: { id, path } }` | `401/403/404/409/422` distinguish authentication, authorization, missing package, lock/mutation/recovery/duplicate conflict, and malformed input. Foreign package/project/path/version identifiers are never accepted. |
| `POST /api/studio/local-packages/{id}/creation-recovery` | URL `{id}` resolves the durable operation state; auth supplies the active member. There is no request body. | `200 { recoveryStatus }` | `404` for missing package; `409 PRECONDITION` when repair remains required. It only performs deterministic hash-based reconciliation and accepts no repair payload. |

Every affected writer uses the same trust sources: route URL -> server row;
auth -> active member; `sessionId` -> exact local-package edit lock; filesystem
paths -> server-derived only. Do not add a project ID, attachment ID, version
label, working directory, Flow path, or journal reference to either body.

OpenAPI must document all three route shapes; 201 responses; 401/403/404/409/422
semantics;
`PRECONDITION` for lock/recovery refusal; identifier authority; and the fact
that no paths or content are accepted or returned. It must also correct the
existing local-package surface: remove the false collection `sourceInstallId`
fork claim, require `sessionId` for file writes, and remove the unimplemented
`/files/{path}/move` operation (rather than relabeling it). No existing
per-file route is widened.

## Test Strategy and Runner Inclusion

All new or changed tests below are intentionally narrow and collectively cover
the lifecycle. Each path is included by the stated runner configuration.

| Test location and behavior | Runner and inclusion proof |
| --- | --- |
| `web/lib/local-packages/__tests__/create-flow-contract.test.ts`: client-safe schema/factory serialization, required metadata, optional-field omission, duplicate ID/path detection, valid `done` terminal graph, and no input mutation. It must not import `server-only`. | `pnpm --filter maister-web exec vitest run --project unit -- 'lib/local-packages/__tests__/create-flow-contract.test.ts'`; `web/vitest.workspace.ts` unit includes `lib/**/__tests__/**/*.test.ts`. |
| `web/lib/db/__tests__/migration-journal-integrity.test.ts`: generated migration is journaled, ordered, has a matching snapshot, and the expected newest migration tag is advanced. | `pnpm --filter maister-web exec vitest run --project unit -- 'lib/db/__tests__/migration-journal-integrity.test.ts'`; the same unit include covers `lib/**/__tests__/**/*.test.ts`. |
| `web/lib/local-packages/__tests__/create-flow-recovery.integration.test.ts`: real Postgres + temporary filesystem/Git proof of create-package initial commit, add-Flow dirty state, every durable phase/crash boundary, hash-proven finalize/compensate, fail-closed drift, and no setup/hook execution. | `pnpm --filter maister-web exec vitest run --project integration -- 'lib/local-packages/__tests__/create-flow-recovery.integration.test.ts'`; integration includes `lib/**/*.integration.test.ts`. |
| `web/lib/local-packages/__tests__/create-flow-concurrency.integration.test.ts`: CAS recovery-state claim, same-session writer serialization with file write/commit/Cut, stale mutation-lease release safety, and active-assistant refusal with no partial manifest. | `pnpm --filter maister-web exec vitest run --project integration -- 'lib/local-packages/__tests__/create-flow-concurrency.integration.test.ts'`; integration includes `lib/**/*.integration.test.ts`. |
| `web/app/api/studio/local-packages/__tests__/create-flow-route.test.ts`, `web/app/api/studio/local-packages/[id]/flows/__tests__/route.test.ts`, and `web/app/api/studio/local-packages/[id]/creation-recovery/__tests__/route.test.ts`: exact body/response contracts, 422 fields, active-member/viewer/inactive refusal, URL/body identifier authority, lock/assistant/recovery refusal, recovery no-body constraint, and safe projection. | `pnpm --filter maister-web exec vitest run --project unit -- 'app/api/studio/local-packages/__tests__/create-flow-route.test.ts' 'app/api/studio/local-packages/[id]/flows/__tests__/route.test.ts' 'app/api/studio/local-packages/[id]/creation-recovery/__tests__/route.test.ts'`; unit includes `app/**/__tests__/**/*.test.ts`. |
| `web/components/studio/__tests__/create-flow-dialog.test.ts`, `local-packages-list.test.ts`, `packages-list.test.ts`, and page/editor tests: metadata wording, fixed-package mode, empty/recovery CTA, active-member affordances, viewer read-only state, EN/RU parity, focus/error behavior, and no raw errors. | `pnpm --filter maister-web exec vitest run --project unit -- 'components/studio/__tests__/create-flow-dialog.test.ts' 'components/studio/__tests__/local-packages-list.test.ts' 'components/studio/packages-list.test.ts'`; unit includes both `components/**/__tests__/**/*.test.ts` and `components/**/*.test.ts`. |
| `web/app/(app)/flows/__tests__/new-route.test.ts`, existing authored action tests, and `web/lib/flows/__tests__/authored-bridge.integration.test.ts`: `/flows/new` redirect; legacy catalog publish stays non-bridge; the separately implemented REST bridge remains accurate. | `pnpm --filter maister-web exec vitest run --project unit -- 'app/(app)/flows/__tests__/new-route.test.ts'` and `pnpm --filter maister-web exec vitest run --project integration -- 'lib/flows/__tests__/authored-bridge.integration.test.ts'`; workspace includes app unit and lib integration patterns above. |
| `web/lib/local-packages/__tests__/version-adopt.integration.test.ts`, `web/lib/packages/__tests__/attach.integration.test.ts`, and `web/lib/services/__tests__/runs-launch-pin.integration.test.ts`: the canonical service/API path creates then commits, cuts `local-<digest>`, attaches/repoints, and launches a graph-only all-`cli` Flow from the immutable pin to terminal run/node-attempt evidence. | `pnpm --filter maister-web exec vitest run --project integration -- 'lib/local-packages/__tests__/version-adopt.integration.test.ts' 'lib/packages/__tests__/attach.integration.test.ts' 'lib/services/__tests__/runs-launch-pin.integration.test.ts'`; all match `lib/**/*.integration.test.ts`. |
| `web/e2e/studio-local-edit.spec.ts`: one browser journey creates package + Flow, opens its canvas, adds another Flow, displays duplicate/error/empty/recovery states, changes only the test Flow to all-`cli`, commits/cuts, attaches or repoints through the existing surface, launches from Board, and observes terminal evidence. | `pnpm --filter maister-web test:e2e -- e2e/studio-local-edit.spec.ts`; Playwright `testDir` is `web/e2e`, and `AUTHED_SPEC` explicitly matches `studio-local-edit.spec.ts`. It uses the real E2E Postgres DB and all-`cli` engine pattern, never the stale `forked-package-loop` `steps:` fixture. |

The no-execution integration test must make a pre-existing `setup.sh`/hook
sentinel observable and assert it was not invoked; it may assert Git calls are
limited to initialization/commit with `--no-verify`. It must not rely merely on
the absence of a log line. A focused structured-logging assertion must also
prove operation events contain only safe IDs/enums and omit working directory,
path, package name, YAML, form values, Git output, and package bytes.

## Commit Plan

- Commit 1 (Phase 0): `docs(studio): freeze canonical create-flow contract`
- Commit 2 (Phases 1-2): `feat(studio): add atomic local Flow creation`
- Commit 3 (Phase 3): `feat(studio): add canonical create-flow wizard`
- Commit 4 (Phase 4): `fix(flows): route new flow creation through Studio`
- Commit 5 (Phase 5): `test(studio): cover local flow creation lifecycle`

## Tasks

### Phase 0 — SDD, Contract Reconciliation, and RED Test Design

- [x] **T0.1 — Freeze the canonical product and recovery contract before code.**
  - Depends on: none.
  - Create `.ai-factory/specs/feature-canonical-create-flow-journey.md`.
  - Capture the canonical two-mode journey, generated-file invariant, all
    identifiers/trust sources, RBAC/lock rules, empty-existing-package state,
    `creation_state` plus private-journal state machines, deterministic
    reconciliation ownership, rollback/crash table, no-code-execution proof,
    content-addressed cut boundary, legacy authored-flow decision, and full
    acceptance matrix from this plan.
  - State the one durable-operation migration precisely: it records no authored
    Flow/package content and does not create a new authored-Flow table. Also
    state no DSL/engine expansion, no manual local version labels, no
    deployment/AsyncAPI change, and that old package drafts and intentional
    empty internal packages remain supported.
  - Define the shared mutation-lease lock order, the recovery-required UI
    projection/actions, and the prohibition on normal lifecycle actions during
    pending recovery.
  - Require RED -> GREEN -> refactor evidence for every code task.
  - Logging: document safe fields and redaction rule; no runtime logging.
  - Verify: `git --no-pager diff --check`.

- [x] **T0.2 — Reconcile current docs and screen contracts before implementation.**
  - Depends on: T0.1.
  - Update `docs/system-analytics/local-packages.md` to distinguish the new
    scratch path from existing empty packages; correct any stale claim that
    zero-flow packages fail installation; document `creation_state`, mutation
    serialization, recovery state transitions, and lifecycle.
  - Update `docs/system-analytics/flow-studio.md` to identify local packages as
    canonical for launchable Flows, label the new behavior Designed until code
    lands, and precisely distinguish catalog-only authored publication from the
    REST authored bridge.
  - Update `docs/screens/studio/editor.md` with the dialog fields, metadata
    terminology, direct canvas landing, empty-package CTA, lock/read-only
    behavior, localized errors, and no separate editor.
  - Update `docs/api/web.openapi.yaml` now because T0.3 commits to actual new
    API surface: revised collection POST schema/201 response, new nested Flow
    POST schema/201 response, body-less deterministic creation-recovery POST,
    auth/lock/identifier notes, removed misleading scratch `sourceInstallId`
    description, required file-write `sessionId`, and removal of the
    unimplemented `/files/{path}/move` operation. Correct only verified drift;
    do not relabel unrelated routes wholesale.
  - Update `docs/database-schema.md` and `docs/db/projects-domain.md` with the
    nullable durable-operation field, its server-only/no-content boundary, and
    generated migration reference. Do not change AsyncAPI, deployment docs, or
    ADR numbers.
  - Logging: document only; no runtime logs.
  - Verify: `pnpm validate:docs`; `pnpm validate:contracts`.

- [x] **T0.3 — Record code-over-doc bridge truth and route decision.**
  - Depends on: T0.1.
  - In the spec, record that `publishAuthoredFlowAction` calls catalog publish
    only, while `POST /api/projects/{slug}/catalog/caps/{capId}/publish-local`
    calls the authored bridge. Record the redirect decision for `/flows/new`
    and the limited legacy-detail state.
  - Search `docs/system-analytics`, `docs/screens`, `docs/api`, `web/app/(app)/flows`,
    `web/lib/catalog`, and `web/lib/flows` for claims that UI publication bridges
    or that an authored draft is launchable; list exact corrections in the spec.
  - Logging: no runtime logs.
  - Verify: `rg -n "authored.*bridge|publish-local|/flows/new|flows: \[\]" docs web .ai-factory` and `git --no-pager diff --check`.

- [ ] **T0.4 — Write failing behavior tests before production changes.**
  - Depends on: T0.1-T0.3.
  - Add the RED tests named in the test strategy for manifest generation,
    migration/state decoding, service saga/recovery, mutation concurrency,
    routes, component markup/RBAC, legacy redirect, and the E2E journey
    skeleton. Update stale graph-only lifecycle fixtures while adding tests,
    never by preserving `steps:` compatibility.
  - Record the expected failing reason per file (missing module/route/fields or
    old empty scaffold behavior).
  - Logging: test capture must assert only safe structured fields where logs are
    asserted; package contents must never be expected in logs.
  - Verify RED with each exact runner command in the test table; do not proceed
    after an unrelated failure.

### Phase 1 — Typed Flow Contract, Durable State, and Server Operations

- [ ] **T1.1 — GREEN: create a pure, client-safe Flow contract/factory.**
  - Depends on: T0.4 RED contract tests.
  - Add `web/lib/local-packages/create-flow-contract.ts` with client-safe
    input/output types and pure functions to normalize `CreateFlowInput`, build
    the valid starter graph, serialize `flows/<id>/flow.yaml`, append exactly
    one `maister-package.yaml` Flow member, and reject duplicate membership/path.
  - Reuse `capabilityRefIdSchema`, Flow metadata schemas, manifest serializers,
    `flowYamlV1Schema`, and non-server graph validation. Return fresh
    structures; never mutate caller data.
  - This module must have no `server-only`, Node, database, Git, environment,
    logging, filesystem, or `validatePackageArtifacts` import. Server-only full
    package validation belongs to T1.3.
  - Verify GREEN: contract unit command from the table.
  - Refactor: consolidate only duplicate client/server normalization; do not
    alter generic non-Flow artifact scaffolding.
  - Logging: pure module logs nothing.

- [ ] **T1.2 — GREEN: add durable creation-state schema and generated migration.**
  - Depends on: T0.4 RED migration/recovery tests.
  - Modify `web/lib/db/schema.ts` with nullable `creationState` and a strict
    server-only decoded `LocalPackageCreationState` union. Its values are only
    `operationId`, kind, phase, Flow ID, and original/expected hashes; it must
    not store a path, package name, request data, YAML, or backup bytes.
  - Generate—not handwrite—the next migration with
    `pnpm --filter maister-web db:generate`. Commit the SQL, snapshot, and
    journal metadata together; update the hard-coded newest-tag assertion in
    `web/lib/db/__tests__/migration-journal-integrity.test.ts` only to the
    generated migration tag.
  - Add a client-safe DTO projection of only `ready | recovering |
    recovery_required`; never expose the raw JSONB operation state.
  - Verify GREEN: migration-integrity unit command and generated migration
    inspection. Refactor only the local-package schema/DTO boundary.
  - Logging: no payload-bearing migration or DTO logs.

- [ ] **T1.3 — GREEN: introduce the operation journal, recovery service, and package operations.**
  - Depends on: T1.1, T1.2, and RED recovery integration tests.
  - Add `web/lib/local-packages/create-flow-operation.ts` for operation IDs,
    staging/private backups, hash-only journals, atomic journal writes,
    compare-and-set state transitions, compensation, and deterministic recovery.
  - Modify `web/lib/local-packages/service.ts` to expose
    `createLocalPackageWithFlow`, `addFlowToLocalPackage`, and one targeted
    `reconcileLocalPackageCreation` owner. Reuse existing
    `insertLocalPackageRow`, atomic write/Git helpers, and the mutation lease;
    do not add a second lock or make ordinary list reads mutate files.
  - The operation validates the complete proposed package in memory before its
    first DB/filesystem write. The new-package operation then claims the DB row
    before staging, creates an initial Git commit containing both required
    files, verifies staged/final hashes, then clears state. The existing-package
    operation CAS-claims state, retains a private original-manifest backup,
    revalidates actual resulting bytes, and deliberately leaves the tree dirty.
  - Keep `createLocalPackage` as a purpose-restricted internal primitive for
    existing default/fork plumbing and fixtures. Only the public collection
    create route becomes Flow-required; do not strand intentional empty
    packages by globally changing the primitive.
  - Add an injectable filesystem/Git boundary limited to this operation so
    integration tests can force every failure boundary and prove neither setup
    nor hooks execute.
  - Verify GREEN: recovery integration command. Refactor: keep payload factory,
    durable state, and filesystem journal separate; the journal has no UI/RBAC
    concerns.
  - Logging: emit start, claimed, stage-ready, finalized, compensated,
    recovered, and recovery-refused with safe IDs/enums only. Remove or redact
    reused Git/service logs that expose `workingDir`, paths, names, content, or
    Git output.

- [ ] **T1.4 — Preserve existing empty package support while making it visible.**
  - Depends on: T1.3.
  - Add a server-safe `hasFlows`/`flowCount` projection through
    `web/lib/local-packages/bom.ts`, `web/app/(app)/studio/local/page.tsx`, and
    `web/components/studio/local-packages-list.tsx`; derive it from parsed
    package content, not stale client state.
  - Do not add `min(1)` to `maisterPackageManifestSchema`, alter
    `assertPackageCuttable`, or change install/attach semantics. Update cut
    compatibility wording only if needed to distinguish “cuttable but has no
    launchable Flow.”
  - Add the recovery-status projection to the same list/package-home read
    model so an unfinished package is visible but not editable or silently
    treated as ready.
  - Verify GREEN: focused component/service tests and current
    `service.integration.test.ts` exact command.
  - Logging: only recovery/service logs; UI adds no logs.

### Phase 2 — API, Authorization, and Error Contract

- [ ] **T2.1 — GREEN: make collection create package-plus-Flow only.**
  - Depends on: T1.3 and RED route tests.
  - Modify `web/app/api/studio/local-packages/route.ts` to parse required
    `{name, flow}` with the shared typed schema, derive creator identity
    from `requireGlobalRole("member")`, call the new saga, and return the safe
    DTO plus `createdFlow` on 201.
  - Remove `sourceInstallId` from this request schema and update any stale
    internal caller; do not accept working directory, package, project, path,
    attachment, or version IDs in the body.
  - Map validation to localized client-readable 422 responses and expected
    domain failures through existing `errorResponse`; do not expose raw Zod
    payloads, journal details, filesystem errors, operation state, or package
    contents. Use active-member authorization, not page-only session state.
  - Verify GREEN: collection route unit test and `pnpm validate:contracts`.
  - Logging: one safe success event in the service; route errors use the
    existing structured handler without request content.

- [ ] **T2.2 — GREEN: add lock-guarded existing-package Flow endpoint.**
  - Depends on: T1.3 and T2.1.
  - Add `web/app/api/studio/local-packages/[id]/flows/route.ts`.
  - Resolve `id` from URL to server package row and server working directory;
    require an active `member`; check `sessionId` holds the lock for exactly
    that package; parse only `{sessionId, flow}`; call `addFlowToLocalPackage`;
    return safe `createdFlow` on 201.
  - Test 401/403/404/409/422 and stale/foreign-lock, assistant-active, and
    recovery-state refusal before any write; test a forged body cannot select
    another package/project/path. Keep ordinary file PUT payloads unchanged.
  - Verify GREEN: nested route test command and integration operation command.
  - Logging: `localPackageId`, `flowId`, `operationId`, and outcome only.

- [ ] **T2.3 — GREEN: expose deterministic recovery retry without widening repair authority.**
  - Depends on: T1.3 and RED recovery-route tests.
  - Add `web/app/api/studio/local-packages/[id]/creation-recovery/route.ts`.
    It rejects every non-empty request body with `422`, resolves `{id}` to the
    server row, requires an active member, calls only
    `reconcileLocalPackageCreation`, and returns the safe recovery-status
    projection.
  - A ready package returns `200`; missing package remains `404`; an unresolved
    hash mismatch returns localized `409 PRECONDITION` with repair guidance. It
    cannot write a caller-supplied manifest, delete a file, change operation
    phase, or execute package code.
  - Test body rejection, member/viewer authorization, URL-only identifier
    authority, success after deterministic repair, and fail-closed mismatch.
  - Verify GREEN: recovery route unit and recovery integration commands.
  - Logging: safe local-package/operation IDs and outcome only.

- [ ] **T2.4 — GREEN: serialize all affected working-directory writers.**
  - Depends on: T1.3 and RED concurrency tests.
  - Extend `web/lib/local-packages/lock.ts` with one scoped mutation-lease
    helper/release discipline, reusing the existing database-backed lease rather
    than introducing an in-process mutex. It must preserve token ownership and
    never release a newer holder's lease.
  - Route/service owners that can overlap the new operation—`files` PUT/DELETE,
    import commit, Commit, Discard, Cut, sync/publish where relevant, and
    local-package assistant materialization—must use the documented order or be
    rejected while a conflicting operation is live. Cut acquires the lease
    before validating/exporting so it cannot digest a torn package.
  - Keep each existing route's URL/body identifier authority unchanged; update
    OpenAPI only where the real behavior/body contract changes. Test same-session
    interleaving, stale release, and clean conflict/error mapping.
  - Verify GREEN: concurrency integration and impacted route tests.
  - Logging: lease events use local-package/operation IDs and enum outcome only.

### Phase 3 — In-Place Studio Wizard and Direct Editor Landing

- [ ] **T3.1 — GREEN: add one reusable Flow-specific dialog.**
  - Depends on: T2.1-T2.2 and RED component tests.
  - Create `web/components/studio/create-flow-dialog.tsx` and a client-safe
    form state helper if the component needs it. It supports `mode: "newPackage"
    | "existingPackage"`; the latter displays the target package read-only.
  - Required fields: package name in new-package mode; Flow ID; display title;
    `metadata.summary`; `metadata.route_when`. Optional progressive controls:
    labels, repeatable typed links, repeatable sources. Use the exact metadata
    field terminology in EN/RU labels and errors.
  - Make Enter submit only from a valid form; keep field-level errors next to
    fields, show a single translated request failure alert, prevent double
    submit, and focus the first failing control. Do not display raw server
    errors or package content.
  - Add translations in `web/messages/en.json` and `web/messages/ru.json`,
    preserving exact key parity. Use accessible labels, dialog semantics, and
    stable test IDs.
  - Verify GREEN: dialog/component test command.
  - Logging: browser code logs nothing.

- [ ] **T3.2 — Replace scratch creation affordances with the wizard.**
  - Depends on: T3.1 and T2.4.
  - Modify `web/components/studio/use-new-local-package.ts`,
    `web/components/studio/local-packages-list.tsx`, and
    `web/components/studio/packages-list.tsx` to open the shared dialog and
    call the collection endpoint. Honor `?create=flow` to support the legacy
    redirect. On 201, route directly to the returned Flow path.
  - Modify `web/components/studio/package-composition.tsx` and
    `web/components/studio/local-package-editor.tsx`: Flow gets **Add Flow**;
    the generic create control remains only for agents/skills/MCPs/rules/etc.
    Add Flow uses the nested endpoint with the editor's live session ID and
    routes directly to the returned Flow. Do not call `runSave` or stage a
    generic Flow scaffold.
  - Render the empty-package and recovery-required states in list and
    package-home surfaces. Preserve existing local-package overview, lock
    refresh/release, Commit, Cut, and editor layout; disable normal mutation
    controls while recovery is pending/required.
  - Verify GREEN: component tests plus `studio-local-edit.spec.ts` focused
    creation/empty-state scenarios.
  - Logging: no client logs; server endpoint logs only safe operation fields.

- [ ] **T3.3 — GREEN: align Studio UI authority with the existing RBAC contract.**
  - Depends on: T2.1-T2.4 and RED role/render tests.
  - Add a single server-derived active-member capability and pass it through
    `web/app/(app)/studio/packages/page.tsx`,
    `web/app/(app)/studio/local/page.tsx`, and
    `web/app/(app)/studio/edit/[id]/[[...path]]/page.tsx` into the relevant
    list/editor components. Replace the editor's unconditional `canManage`.
  - Members get create/add/lock affordances; viewers receive localized
    read-only explanation; inactive/password-change-required sessions do not
    receive a misleading enabled control. Server routes remain the enforcement
    point and do not trust this prop.
  - Verify GREEN: focused Studio page/list/editor tests in the test matrix.
  - Logging: no browser logs.

### Phase 4 — Retire New Authored Draft Entry and Clarify Compatibility UI

- [ ] **T4.1 — Redirect `/flows/new` to canonical Studio creation.**
  - Depends on: T3.2-T3.3 and RED redirect test.
  - Replace `web/app/(app)/flows/new/page.tsx` DB-draft form with an authenticated
    redirect to `/studio/packages?create=flow`. Remove imports and form-only
    dependencies made dead by that page, but do not remove the legacy detail
    route or historical data.
  - Update `web/app/(app)/flows/actions.ts` only as needed to remove a now
    unreachable create action. Preserve update/publish behavior for existing
    catalog drafts and make its catalog-only/non-launchable semantics visible
    in the legacy detail UI and translations.
  - Verify GREEN: `/flows/new` unit test, current authored action tests, and
    authored bridge integration test. The latter must still prove the REST
    bridge rather than falsely claiming UI publish bridges.
  - Logging: retain existing safe catalog IDs; do not log authored YAML.

- [ ] **T4.2 — Flip docs from Designed to Implemented after behavior is green.**
  - Depends on: T4.1 and all feature tests green.
  - Revisit the Phase 0 docs/spec and change only delivered items to
    Implemented. Verify generated API routes/responses, database field/migration
    reference, recovery/mutation state diagrams, and screen labels match code
    exactly. Keep legacy authored limitation and bridge distinction explicit.
  - Verify: `pnpm validate:docs`; `pnpm validate:contracts`; targeted
    `rg` checks from T0.3; `git --no-pager diff --check`.
  - Logging: docs only.

### Phase 5 — Lifecycle Proof, Refactor, and Completion Review

- [ ] **T5.1 — GREEN: prove Commit -> Cut -> Attach/Repoint -> launch.**
  - Depends on: T3.2-T3.3.
  - Extend the focused integration suites to create through the canonical
    service/API, add a second Flow, commit, cut a `local-<digest>` revision,
    attach or repoint it using existing package services, and launch a
    graph-only all-`cli` test Flow from the immutable package pin. Assert the
    terminal run/node-attempt evidence, not merely a rendered button.
  - Extend `web/e2e/studio-local-edit.spec.ts` through the browser: wizard ->
    direct canvas -> optional YAML change to test-only all-`cli` -> Commit ->
    Cut -> existing project attach/repoint UI/API -> board launch -> terminal
    run evidence. It must use the real E2E DB and engine, not a mocked launch.
  - Verify GREEN: all lifecycle commands in the test table.
  - Logging: assert no content/path/name logging for creation operations; use
    run IDs only for existing runtime observability.

- [ ] **T5.2 — Refactor only after end-to-end green.**
  - Depends on: T5.1.
  - Remove dead generic Flow creation branches, duplicated local form
    validation, and stale docs/test fixture claims. Keep generic artifact
    creation for non-Flows. Do not refactor unrelated local-package lifecycle
    code.
  - Rerun focused unit/integration/E2E commands after each cleanup; stop on the
    first regression.
  - Logging: preserve safe event schema and no-content rule.

- [ ] **T5.3 — Final completeness, consistency, and logical-hole review.**
  - Depends on: T5.2.
  - Check every changed HTTP route for URL/auth/server/body identifier authority
    and every write for active-member/edit-lock/mutation-lease verification
    before side effects.
  - Trace both creation modes through all states: invalid form, duplicate ID,
    duplicate path, no access, lost lock, FS/Git failure, caught rollback,
    crash at every durable marker, hash-proven recovery completion/compensation,
    recovery refusal, same-session writer contention, active assistant, direct
    editor landing, commit, content-addressed cut, attach/repoint, and launch.
  - Check migration SQL/snapshot/journal integrity; EN/RU key parity; database,
    system-analytics, screen, and OpenAPI consistency; no raw package
    paths/content/names in logs/errors; no executable package code path;
    graph-only output; no manually named cut; and preservation of existing empty
    packages.
  - Final validation commands:
    - `pnpm --filter maister-web typecheck`
    - `pnpm --filter maister-web exec vitest run --project unit -- 'lib/local-packages/__tests__/create-flow-contract.test.ts' 'lib/db/__tests__/migration-journal-integrity.test.ts' 'app/api/studio/local-packages/__tests__/create-flow-route.test.ts' 'app/api/studio/local-packages/[id]/flows/__tests__/route.test.ts' 'app/api/studio/local-packages/[id]/creation-recovery/__tests__/route.test.ts' 'components/studio/__tests__/create-flow-dialog.test.ts'`
    - `pnpm --filter maister-web exec vitest run --project integration -- 'lib/local-packages/__tests__/create-flow-recovery.integration.test.ts' 'lib/local-packages/__tests__/create-flow-concurrency.integration.test.ts' 'lib/local-packages/__tests__/version-adopt.integration.test.ts' 'lib/packages/__tests__/attach.integration.test.ts' 'lib/services/__tests__/runs-launch-pin.integration.test.ts'`
    - `pnpm --filter maister-web test:e2e -- e2e/studio-local-edit.spec.ts`
    - `pnpm validate:docs`
    - `pnpm validate:contracts`
    - `git --no-pager diff --check`

## Acceptance Criteria Matrix

| Requirement | Observable completion evidence |
| --- | --- |
| Create package + Flow | Both Studio entry points open one metadata dialog; one submit makes a Git-backed package whose initial commit contains valid manifest membership and Flow; browser lands on its existing editor canvas. |
| Add Flow to editable package | Package home uses the same dialog with fixed package identity; a member holding the lock can add each additional valid Flow atomically, navigates directly, and sees ordinary uncommitted changes awaiting Commit. |
| Required and optional metadata | Empty/invalid Flow ID, title, summary, or route condition cannot submit; labels, links, sources serialize only when supplied and validate via existing metadata schema. UI names them metadata, not frontmatter. |
| Duplicate Flow IDs and invalid paths | Existing manifest ID or `flows/<id>/flow.yaml` collision returns localized 409/422 without changing either file; test proves no dangling membership/file. |
| Valid safe starter | `name` equals Flow ID, `metadata.title` equals display title, compatibility/capabilities/artifacts are safe defaults, and graph/package validators accept it without DSL or engine changes. |
| Durable recovery and filesystem/Git failure | Generated DB state records safe operation identity/hashes only. Any injected failure compensates files/row/journal only when ownership is proven; each durable crash marker either completes an exact state, clears a proven compensation, or fails closed without overwriting drift. A recovery-required package stays visible but is never silently treated as ready. |
| Existing empty packages | Existing zero-flow packages remain valid/cuttable/attachable as before, visibly say there is no launchable Flow, and provide Add Flow; no new scratch package can be empty. |
| RBAC, edit lock, and mutation serialization | Non-members, inactive users, and malformed/forged requests are rejected before filesystem work; Add Flow with absent/stale/foreign lock, active assistant, pending recovery, or a conflicting mutation lease is refused. Same-session file write/Commit/Cut cannot observe a torn manifest. Viewers receive actionable read-only messaging. |
| Commit/Cut/Attach/Repoint/Launch | A canonical package follows existing Commit, `local-<digest>` Cut, durable attachment/repoint, and a real graph-only test launch from pinned immutable content to terminal evidence. |
| No code execution | Creation/add tests prove no setup script, Git hook, package installer, Flow node, or arbitrary package code ran; Git initialization is limited to `--no-verify` commands. |
| Logging and safe projection | Operation logs contain only `operationId`, `localPackageId`, `flowId`, and enum phase/outcome. DTOs, errors, and logs omit working directories, paths, package names, YAML/form values, Git output, backups, and package content. |
| Legacy route / bridge accuracy | `/flows/new` cannot create a DB draft and redirects to Studio; legacy detail is catalog-only; docs/tests accurately describe the separate REST bridge. |
| Localization and UX | Every added visible label/error/CTA exists in EN and RU, metadata wording is correct, dialog is keyboard/accessibility-safe, errors are localized/actionable, and success reaches the Flow in one operation. |
| Documentation/contracts and migration | Local packages, Flow Studio, Studio editor screen reference, database schema/projects-domain docs, OpenAPI, migration journal/snapshot, and the frozen spec state the same implementation truth and correct prior drift. |
