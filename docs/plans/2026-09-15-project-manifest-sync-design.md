# Project manifest sync: drift model, explicit persist, adopt-from-repo

- **Date:** 2026-09-15
- **Status:** Design — validated with the owner in-session (decisions D1–D8
  below); input for `/aif-plan`. Not implemented.
- **Scope:** the `maister.yaml` write path
  ([yaml-writeback.ts](../../web/lib/packages/yaml-writeback.ts),
  [persist-config.ts](../../web/lib/persist-config.ts), the bootstrap branch of
  [POST /api/projects](../../web/app/api/projects/route.ts)), the package
  attach/detach/upgrade routes, the persist banner + Settings → Git card, the
  project page header, the portfolio card, and one migration.
- **Amends:** [ADR-088](../decisions/adr-088.md) (consequence "write-back
  dirties the consuming repo's working tree by design" is withdrawn),
  [ADR-093](../decisions/adr-093.md) (persist generalized; `maister_yaml_path`
  dropped), and the 2026-07-14 bootstrap patch (commit `4be74410`, reverted by
  design). Recorded as **ADR-174**.

## 1. Problems (verified 2026-09-15 at `f78927d3`)

1. **Package attach / detach / upgrade rewrite `maister.yaml` in the working
   tree, uncommitted.** `writeBackPackagesPin` runs after the DB transaction
   commits and edits `packages[]` in place. ADR-088 calls the resulting dirty
   tree "by design; the user commits when ready". In practice the in-app
   **Pull from origin** refuses with `PRECONDITION {reason:"dirty_worktree"}`
   ([worktree.ts:1243](../../web/lib/worktree.ts)) because `statusPorcelain`
   runs `--untracked-files=all`, and `repo_read` agent launches refuse on the
   same dirty parent checkout ([launch.ts:1063](../../web/lib/agents/launch.ts)).
2. **Registering a repo without a manifest leaves an untracked `maister.yaml`.**
   `bootstrapMaisterYaml` writes the file so the normal validation path can
   read it; nothing ever commits it. Same dirt, from day one of a project.
3. **Settings edits silently stale the committed manifest.** The settings
   PATCH ([settings/route.ts:216](../../web/app/api/projects/[slug]/settings/route.ts))
   and per-flow runner defaults ([launch-options/route.ts](../../web/app/api/runs/launch-options/route.ts))
   write the DB only, while `project.default_runner`, `project.promotion.mode`
   and `flows[].runner` exist in the manifest. Nothing shows the divergence.
4. **Persist is legacy-only and one-shot.** `persistProjectConfig` refuses
   unless `maister_yaml_path IS NULL` and answers `CONFLICT` forever after the
   first commit. It cannot re-sync.
5. **The runtime never re-reads the manifest.** `loadProjectConfig` has one
   caller (registration); [runs.ts:1164](../../web/lib/services/runs.ts) states
   the DB-mirror rule. A manifest edited upstream and pulled is invisible to the
   DB and to the operator.
6. **The manifest is already a partial mirror.** `sync_strategy_default`,
   `sync_runner_id`, `delivery_policy_default`, `execution_policy_default`,
   `task_queue_settings`, `auto_promotion`, `brain_enabled` live only in the
   DB. The copy "re-create this project from git alone" is not literally true
   today, and this design does not try to make it true (N2).

Only `maister.yaml` is ever written into a consuming repo: runtime artifacts
live under the MAIster install (`runtimeRoot()`), not under the project.

## 2. Goals / non-goals

Goals:

- **G1 Invariant.** No MAIster code path writes into a project repository's
  working tree except the explicit persist action, which commits in the same
  operation. "MAIster never leaves a project checkout dirty."
- **G2 Drift is visible and inspectable in both directions**: DB projection vs
  the manifest committed on `main_branch`.
- **G3 Persist DB → repo** with per-item selection, comment-preserving edit of
  the committed file, exactly one commit, optional push.
- **G4 Adopt repo → DB** with per-item selection, through the existing
  mutation services (attach / detach / upgrade / settings gates).
- **G5 Per-project ignore list** so environment-specific fields (the default
  runner is the owner's example) stop nagging.
- **G6 The DB stays runtime truth.** No runtime read of the manifest.

Non-goals:

- **N1** Drift, persist or adopt over `capability_imports[]`, `capabilities`,
  `flow_roles[]`. The Document-API edit preserves them verbatim; they are never
  compared. Their UI mutations already write the DB only (verified: no other
  manifest write site exists) and must stay that way (D5).
- **N2** Mirroring DB-only settings (problem 6). Never.
- **N3** Committing to `main_branch` when it is not checked out (plumbing or a
  temporary worktree). Precondition stays HEAD-on-main, as ADR-093.
- **N4** PR-mode persist (branch + PR following `promotion_mode`). A later
  mode; nothing here precludes it.
- **N5** Inbox / "Needs you" integration. No `inbox_items`, no `hitl_requests`
  (both are task/run-bound; D4).
- **N6** An audit table or new `domain_events` kinds. The git commit is the
  persist audit; adopt is logged (pino) only.
- **N7** Auto-adopt after pull; auto-persist after a settings change.
- **N8** `MAISTER_PROJECTS_DIR` auto-discovery (stays manifest-gated).
- **N9** Removing or re-versioning a standalone `flows[]` entry through adopt
  (no service exists; refused `unsupported_item`, Q2).
- **N10** Runner defaults of package member flows have no manifest home and
  are never drift.

## 3. Owner decisions (locked 2026-09-15)

- **D1** Option A: DB is truth; drift model; explicit persist; no side-effect
  writes anywhere ("иначе грязный чекаут мы не починим").
- **D2** Registration without a manifest writes **no** file. The initial
  manifest lands through the same persist path, with a warning that the repo
  has none and an offer to commit.
- **D3** Partial persist: the operator picks items (e.g. packages, but not the
  default runner).
- **D4** Adopt repo → DB exists, with checkboxes, as a plain dialog. Not on
  the HITL substrate.
- **D5** Drift surface v1 = `project` block + `packages[]` + `flows[]`. Other
  sections untouched, uncompared, and never written on change.
- **D6** Ignore list, with value normalization.
- **D7** Visibility: a small chip on the project page (and on the portfolio
  card, replacing the persist banner); drift detail lives in the dialog;
  nothing full-screen; no "Needs you" count.
- **D8** `maister_yaml_path` is dropped (owner: "а нужен он, если в БД лежит
  уже?"; confirmed as Q1 (a)).
- **D9** Committing a runner reference is always a conscious choice:
  `project.default_runner` and `flows[*].runner` are never pre-selected in the
  dialog, in any state. The chip may keep warning about them; the ignore list
  is the way to silence it.
- **D10** Q2–Q4 resolved as (a): standalone `flows[<id>]` removal /
  re-versioning through adopt is `unsupported_item`; the chip also lives on the
  portfolio card; identity fields are adoptable as plain column updates.
- **D11** When persist creates the file (state `missing`) the identity trio
  (`name`, `main_branch`, `branch_prefix`) is written per the serializer's
  omit-defaults rule and is not a selectable item (§7 step 2).

## 4. Invariant and its guard

The invariant (G1) is enforced three ways:

1. The two side-effect write sites are deleted (`writeBackPackagesPin`, the
   registration bootstrap file).
2. Exactly one module may write the file: `web/lib/manifest/persist.ts`. It
   writes and commits under `withRepoPromotionLock(repo)` (the lock pull and
   promotion already take).
3. A regression guard (T1): register (no manifest) → attach → upgrade →
   settings PATCH → runner-default PATCH → detach against a real git repo,
   asserting `git status --porcelain --untracked-files=all` is empty after each
   step. Re-enabling the old write-back must turn T1 red (falsification is part
   of the definition of done).

## 5. Workstream 1 — projection and drift model

### 5.1 Projection (DB → manifest view)

| Manifest path | DB source | Notes |
| --- | --- | --- |
| `project.name` | `projects.name` | identity |
| `project.main_branch` | `projects.main_branch` | identity |
| `project.branch_prefix` | `projects.branch_prefix` | identity |
| `project.promotion.mode` | `projects.promotion_mode` | `null` ⇒ key absent |
| `project.default_runner` | `projects.default_runner_id` | `null` ⇒ key absent |
| `packages[<id>]` | `project_package_attachments ⨝ package_installs` | `{id: name, source: source_url, version: version_label, path?: manifest.sourceSubpath}` (today's `gatherAttachments`) |
| `flows[<id>]` | `flows` where `package_install_id IS NULL` | `{id: flow_ref_id, source, version}` |
| `flows[<id>].runner` | `project_flow_runner_defaults.runner_id` for that flow | `null` ⇒ key absent |

### 5.2 Repo side

`git -C <repo_path> show refs/heads/<main_branch>:maister.yaml` — the
**committed** manifest on the main branch, never the working tree, so the chip
does not depend on what is checked out. Missing ref (unborn branch) or missing
path ⇒ state `missing`. The bytes go through `parseProjectConfig(raw, label)`
(the parse half of today's `loadProjectConfig`, split in WS2); parse or schema
failure ⇒ state `invalid` carrying the message.

### 5.3 Normalization (comparison only; never rewrites either side)

- Absent optional scalars ≡ `null`: `promotion.mode`, `default_runner`,
  `flows[].runner`, `packages[].path`.
- Schema defaults folded: `main_branch` absent ≡ `main`; `branch_prefix`
  absent ≡ `maister/`.
- Strings trimmed.
- `source`: for URL-shaped sources (`scheme://…`, `git@host:…`) a trailing `/`
  and one trailing `.git` are stripped before comparing; local directory
  sources compare as resolved absolute paths. Different transports
  (`ssh://` vs `https://`) stay different sources.
- `version`: exact string (tag, or a `local-<digest>` label).
- Sequences compare as maps keyed by `id`; order never drifts. Duplicate ids in
  the repo file ⇒ `invalid` (the schema loader already refuses them).
- Keys the projection does not know (extra keys under `project`, other
  sections) are ignored.

### 5.4 Items and states

```ts
type ManifestDriftItem = {
  path: string;   // "project.default_runner" | "packages[aif]" | "flows[bugfix]" | "flows[bugfix].runner" | …
  section: "project" | "packages" | "flows";
  kind: "db_only" | "repo_only" | "changed";
  db?: unknown;   // normalized DB value; absent when repo_only
  repo?: unknown; // normalized repo value; absent when db_only
  ignored: boolean;
};

type ManifestDrift = { branch: string; repoHead: string | null; ignore: string[] } & (
  | { state: "in_sync"; items: [] }
  | { state: "drifted"; items: ManifestDriftItem[] }   // count = items not ignored
  | { state: "missing"; items: ManifestDriftItem[] }   // every projected element as db_only, identity trio excluded (§7 step 2)
  | { state: "invalid"; error: string }                // repo file unparseable / schema-invalid; no actions
  | { state: "unavailable"; error: string }            // git failed (not a repo, timeout); chip hidden, WARN
);
```

A `changed` package or flow item carries the whole entry on both sides; the UI
renders the differing fields. `flows[<id>].runner` is a separate item from
`flows[<id>]` because a runner is environment-specific and will be ignored on
its own. Drift is symmetric: no side is ever inferred to be newer or right;
the operator picks the direction per item.

### 5.5 Ignore list

`projects.manifest_drift_ignore jsonb NOT NULL DEFAULT '[]'` — array of item
paths, grammar-validated
(`^(project\.(name|main_branch|branch_prefix|promotion\.mode|default_runner)|packages\[[^\]]+\]|flows\[[^\]]+\]|flows\[[^\]]+\]\.runner)$`),
deduplicated, ≤ 200 entries. Ignored items are still computed (`ignored:
true`), excluded from the chip count, rendered collapsed in the dialog, and
remain selectable for persist / adopt (an explicit selection wins over ignore).
Stale entries (a package detached later) are harmless and pruned only when the
operator un-ignores them.

### 5.6 Module and read model

`web/lib/manifest/`: `projection.ts` (DB → projection; absorbs
`gatherAttachments`), `serialize.ts` (today's `serializeProjectConfig`, moved),
`repo.ts` (`readCommittedManifest(repoPath, branch)`), `drift.ts` (pure
`computeManifestDrift(projection, repoManifest | null, ignore)`), `persist.ts`,
`adopt.ts`. `readManifestDrift(db, project)` serves the project page (server
component), the portfolio query (per active project via `Promise.allSettled`;
a failing repo yields `unavailable` for that project only and never blocks the
page), and `GET /api/projects/{slug}/manifest`. After an in-app pull the client
already calls `router.refresh()`; the chip recomputes with the page. No extra
plumbing.

## 6. Workstream 2 — registration without a file; write-back removal

- `loadProjectConfig(path)` becomes `readFile` + `parseProjectConfig(raw,
  sourceLabel)`. The missing-manifest branch of `POST /api/projects` builds the
  minimal config in memory (`serializeProjectConfig({name, mainBranch:
  getDefaultBranch(dir), branchPrefix: "maister/", defaultRunnerId: null,
  promotionMode: null})`), feeds `parseProjectConfig`, and continues on the
  unchanged registration path. No file, no `removeUnchangedBootstrapMaisterYaml`.
  Post-registration drift is `missing`; the chip reads "Manifest not in repo".
- Delete `writeBackPackagesPin` and its unit test; the package routes drop
  `writeBack` from their responses; `project-packages-section.tsx` drops the
  failed-write-back notice.
- Delete `persist-config.ts`, the `persist-config` route, `ConfigPersistBanner`,
  and `needsPersist` (portfolio DTO + both pages). The Settings → Git card
  becomes the **Manifest** card hosting the chip and an **Open** button, so the
  durable entry point stays where ADR-093 put it.
- The `packages[]` / `flows[]` bootstrap at registration is unchanged (it reads
  the parsed config, not the file).

## 7. Workstream 3 — persist (DB → repo)

`POST /api/projects/{slug}/manifest/persist`, `editSettings`; body
`{ items: string[] /* 1..500, grammar of §5.5 */, push?: boolean }`.

Preconditions, all `PRECONDITION` (409) with `details.reason`:
`not_git_repo`; `branch_mismatch` (HEAD detached or ≠ `main_branch`; payload
`{branch, checkedOutBranch}`); `manifest_dirty` (working-tree `maister.yaml`
differs from HEAD and is not this call's own crash residue, step 5);
`invalid_repo_manifest` (drift state `invalid`: there is no sane base to edit);
`dependency_missing` (`flows[x].runner` selected while `flows[x]` is neither in
the repo file nor selected; payload `{item, requires}`).
`CONFLICT {reason:"drift_changed"}` when a selected path is not in the freshly
computed drift (stale dialog; the client reloads). `CONFIG` if the resulting
document fails `maisterYamlV2Schema` (self-check; unreachable by construction).

Algorithm, under `withRepoPromotionLock(repo)`:

1. Compute drift; validate every item against it.
2. Base document. State `missing` ⇒ a new document from `serialize.ts` seeded
   with the **identity trio** written per the serializer's omit-defaults rule
   (`name` always — schema-required; `main_branch` and `branch_prefix` only when
   they differ from `main` / `maister/`, otherwise a `master` project would
   re-read as `main`) and `flows: []`. The trio is not a selectable item (D11). Otherwise
   `parseDocument(HEAD bytes)` (yaml Document API: comments and ordering
   survive, as today's write-back proves).
3. Apply the selected items: project scalars set, or delete the key when the
   DB value is `null` or equals the schema default (keeps the file minimal,
   matching the serializer's omit-defaults convention); `packages[id]` upsert
   `{id, source, version, path?}` or remove; `flows[id]` upsert
   `{id, source, version}` keeping an existing `runner` key unless
   `flows[id].runner` is also selected, or remove; `flows[id].runner` set or
   delete key. Unselected items are untouched and stay drifted.
4. Self-check: `maisterYamlV2Schema.parse(doc.toJS())`.
5. `bytes = doc.toString()`. If the working-tree file exists and differs from
   HEAD: equal to `bytes` ⇒ our own crash residue, skip the write; otherwise
   `manifest_dirty` (never clobber an operator edit). Else `atomicWriteText`.
6. `git add -- maister.yaml`, then `git commit -m "chore(maister): persist
   project config" -m "<one line per applied item>" -- maister.yaml`. The
   pathspec makes the commit contain only this file: other staged files stay
   staged and other dirty files no longer block persist (the ADR-093
   whole-tree-clean precondition is relaxed to this file). `commitFile` gains
   the pathspec; identity defaults (`commitIdentityArgs`) unchanged.
7. `push` ⇒ `pushBranch(origin, main_branch)`; a failure is advisory
   (`pushWarning`) and never rolls back the commit.
8. `200 { commitSha, applied: string[], usedDefaultAuthor, pushed,
   pushWarning?, drift }`.

Crash windows: write-then-crash ⇒ the next call completes via step 5 or refuses
`manifest_dirty` if the operator edited meanwhile; commit-then-crash ⇒ push is
re-runnable from Settings → Git. Persist performs no DB write, so there is
nothing else to reconcile.

## 8. Workstream 4 — adopt (repo → DB)

`POST /api/projects/{slug}/manifest/adopt`; body `{ items: string[] }`.
Authorization: `editSettings` for `project.*` and `flows[*].runner`;
`authorizeManagePackages` for `packages[*]` and `flows[*]`. A request mixing
items the caller may not perform is refused whole (`UNAUTHORIZED`), nothing
applied.

Items are applied **sequentially in this fixed order, stopping at the first
failure**, each through the existing service (never the HTTP route):

1. `project.main_branch`, `project.branch_prefix`, `project.name` ⇒ column
   update (`main_branch` must pass `branchNameSchema`; `slug` and `task_key`
   are never re-derived).
2. `project.promotion.mode` ⇒ `promotion_mode` (validated by
   `projectPromotionSchema`; `null` when absent).
3. `project.default_runner` ⇒ the settings-PATCH gate (`assertRunnerUsable`:
   exists, enabled, `Ready`); failure `PRECONDITION {reason:"runner_unusable",
   item}`.
4. `packages[id]` `db_only` ⇒ `detachPackage` (live-run guard ⇒ `PRECONDITION`
   as today).
5. `packages[id]` `repo_only` ⇒ `installPackageRevision({sourceUrl, name,
   version, path})` + `attachPackage` — the registration bootstrap pair; the
   source resolves exactly as at registration.
6. `packages[id]` `changed`: version-only ⇒ `installPackageRevision` +
   `upgradeAttachment` (in-flight runs keep their pins); source or path changed
   ⇒ `detachPackage` + install/attach.
7. `flows[id]` `repo_only` ⇒ the registration `flows[]` install path
   (`installFlowPlugin` + the row insert) extracted into a shared service;
   `flows[id]` `changed` or `db_only` ⇒ `PRECONDITION {reason:"unsupported_item"}`
   (N9, Q2).
8. `flows[id].runner` ⇒ `assertRunnerUsable` + upsert
   `project_flow_runner_defaults` (`null` ⇒ delete the row).

Adopt never trusts a revision, never runs `setup.sh`, never touches git.
Response: `200 { applied: string[], failed?: { item, code, reason, message },
drift }` when at least one item applied; when the **first** item fails, its
error is returned as-is (409/422) so clients branch on `code` as everywhere
else. Drift is recomputed in the response either way.

## 9. Workstream 5 — UI

- **`ManifestDriftChip`** (client), rendered in the project page header beside
  `ProjectTabs` (`web/app/(app)/projects/[slug]/page.tsx:446`),
  on every tab. States: `in_sync` ⇒ muted green check glyph, tooltip "Config
  matches maister.yaml on <branch>"; `drifted` ⇒ warning chip "Differs from
  repo · N"; `missing` ⇒ "Manifest not in repo" (no count); `invalid` ⇒ danger
  chip "Repo manifest invalid"; `unavailable` ⇒ hidden. Click opens the dialog
  in every visible state (in `in_sync` it shows the ignored items to un-ignore).
- **Portfolio card**: the same chip, `compact` variant, linking to
  `/projects/{slug}?manifest=1`, which opens the dialog on load. Replaces the
  `ConfigPersistBanner` slot on home.
- **`ManifestSyncDialog`**: header with branch and HEAD short sha; rows grouped
  Project / Packages / Flows; per row: path, repo value, DB value (entries as
  `version · source · path`), one three-way selector "→ repo | ← DB | ignore"
  (unset by default; state `missing` pre-selects "→ repo" on package and flow
  entries — the onboarding case — but never on runner items:
  `project.default_runner` and `flows[*].runner` are committed only by an
  explicit tick, in every state, D9); ignored rows collapsed under "Ignored (k)" with "Track
  again"; footer: **Commit N to repo** (+ "also push" checkbox; disabled with
  the precondition hint when `branch_mismatch` / `manifest_dirty` is already
  known from GET) and **Adopt N into DB**; a results panel shows the commit sha
  or the per-item failure mapped from `code` + `details.reason`; drift reloads
  after each action. Icon + label buttons; success is a green check glyph
  (`web/CLAUDE.md` UI conventions). Not full-screen.
- **Settings → Git**: the persist card becomes the **Manifest** card (chip +
  Open). `repo-fetch-button` unchanged.
- Viewers without `editSettings` see the chip and a read-only dialog (no
  selectors, no footer actions) — never an action that would 403.

## 10. API / contract changes (`docs/api/web.openapi.yaml`)

- Remove `POST /api/projects/{slug}/persist-config` (`postProjectPersistConfig`).
- Add `GET /api/projects/{slug}/manifest` (`getProjectManifestDrift`) ⇒
  `ManifestDrift` (§5.4). Read authorization = the project page's.
- Add `POST /api/projects/{slug}/manifest/persist` (`persistProjectManifest`,
  §7) and `POST /api/projects/{slug}/manifest/adopt` (`adoptProjectManifest`,
  §8).
- Add `PATCH /api/projects/{slug}/manifest/ignore` (`setProjectManifestIgnore`),
  `editSettings`, body `{path, ignored}` ⇒ `{ignore: string[]}`.
- `attachProjectPackage`, `detachProjectPackage`, `upgradeProjectPackage`: drop
  `writeBack` (and from the `required` arrays).
- `POST /api/projects` description: registration never writes into the repo;
  a missing manifest is validated from an in-memory default.
- Portfolio DTO: `needsPersist: boolean` ⇒ `manifest: { state, count } | null`.
- No new `MaisterError` code. New `details.reason` values, enumerated in the
  spec: `not_git_repo | branch_mismatch | manifest_dirty |
  invalid_repo_manifest | dependency_missing | drift_changed | runner_unusable |
  unsupported_item`.

## 11. Data model — migration `0170_project_manifest_sync`

- `ALTER TABLE projects ADD COLUMN manifest_drift_ignore jsonb NOT NULL DEFAULT '[]'::jsonb;`
- `ALTER TABLE projects DROP COLUMN maister_yaml_path;` (D8 / Q1). After this
  design nothing reads the column: the manifest location is fixed by contract
  (`<repo_path>/maister.yaml`) and its presence is a git fact that a cached
  column can only misreport. Cost: Drizzle schema + journal + snapshot,
  `db:erd` regenerate, `seed.ts`, the register insert, and a scripted sweep
  removing `maisterYamlPath:` from the **244** test fixtures that set it (one
  mechanical commit); the e2e assertion on the column is rewritten (T5).
- `docs/db/projects-domain.md`, `docs/database-schema.md` updated in the same
  task.

## 12. i18n (EN + RU parity, REQUIRED)

New `projects.manifest.*` namespace: chip states, dialog labels and column
headers, the eight `details.reason` remediations, result messages, commit
message preview. Removed: `projects.persistBanner.*`, `projects.git.persist*`,
the package write-back notice key. `board.pullDirty` stays.

## 13. Docs (canonical files per `docs/CLAUDE.md`)

- **ADR-174** `docs/decisions/adr-174.md` + index row + summary block:
  "Project manifest sync — no side-effect writes, drift model, explicit
  persist, adopt-from-repo"; amends ADR-088 and ADR-093 as in the header;
  reverts `4be74410` by design.
- `docs/system-analytics/project-manifest.md` (new, R5 structure: drift state
  machine, persist and adopt sequence diagrams, expectations, edge cases with
  the `reason` values) + README index row; `projects.md` (registration flow
  without bootstrap; state-machine note "edit maister.yaml" ⇒ adopt;
  expectations); `packages.md` (write-back contract and its crash-table row
  removed); `git-integration.md` (persist section repointed).
- `docs/screens/projects/project-board.md` (chip + dialog),
  `project-settings-git.md` (Manifest card), `docs/screens/README.md:193`
  (row text), `add-project.md` if it mentions the generated file.
- `docs/configuration.md` §`maister.yaml` v2 (bootstrap callout rewritten),
  `docs/getting-started.md:144` and `:330`, `web/CLAUDE.md:382`, root
  `CLAUDE.md` (Conventions: the invariant in one bullet; §6 registration note).
- RU: `docs/ru/manual/04-projects.md` plus the mentions in `concepts.md`,
  `workflow.md`, `operators-guide.md`, `README.md`.
- `docs/plans/README.md`: this file's row; status kept current.

## 14. Testing and acceptance criteria (TDD, real seams, no trivial tests)

- **T1 guard** (integration, real git + DB): after register(no manifest),
  attach, upgrade, settings PATCH, runner-default PATCH, detach — `git status
  --porcelain --untracked-files=all` in the project repo is empty after each
  step. Falsified by restoring the old write-back.
- **T2 drift** (unit table): defaults folding; `.git` and trailing slash;
  order independence; ids as keys; ignore flag and count; `missing` /
  `invalid` / `unavailable`; `flows[x].runner` as its own item; `changed`
  package item carries both sides; unknown repo keys ignored.
- **T3 persist** (integration): the commit contains only `maister.yaml` while
  another file is staged and a third is untracked; comments and key order of
  the HEAD file survive; a partial selection leaves the rest drifted; `missing`
  creates the file with the identity trio + selected items and a `master`
  main branch round-trips; `manifest_dirty` on an operator edit; crash-residue
  completion (write, simulated crash, second call commits without rewriting);
  `dependency_missing`; `drift_changed`; push failure advisory; a concurrent
  pull waits on the lock; **pull succeeds immediately after persist** (the
  original bug).
- **T4 adopt** (integration, local package source fixture): `repo_only`
  package attaches untrusted and the item clears; `db_only` with a live run ⇒
  `PRECONDITION`, nothing applied; `changed` version upgrades and in-flight
  runs keep their pins; `runner_unusable` ⇒ 409 when first, `failed` + 200
  after a success; fixed order and stop-at-first-failure; `flows[x].runner`
  upsert and delete; identity fields adopt without touching `slug` /
  `task_key`; an unauthorized mix is refused whole.
- **T5 registration + e2e**: no file written; drift `missing`; the portfolio
  and page DTOs carry no `maisterYamlPath`; e2e onboarding: chip → dialog (runner rows not
  pre-selected) → Commit ⇒ file and commit exist, `git status` clean.
- **T6 read models**: portfolio with one unreadable repo renders with that
  project `unavailable` only.
- **T7 pull**: an upstream commit changing `packages[]` shows a `repo_only`
  item after Pull from origin.
- Gate battery on the exact tree: `pnpm --filter maister-web lint`,
  `test:unit`, `test:integration` (AB lane), the onboarding e2e spec,
  `pnpm validate:docs`, `pnpm validate:contracts`, `db:erd --check`.

## 15. Security

- Item paths are grammar-validated and the ids inside brackets must satisfy the
  existing id schemas before any yaml node is touched; values come only from
  the DB projection or the parsed repo file, never from the request body.
- Repo path and branch are server-state; git runs with validated arguments,
  timeouts, and `NETWORK_GIT_ENV` for push only.
- Adopt installs packages with the registration trust posture: nothing is
  trusted, `setup.sh` never runs, exec-trust is untouched (ADR-021/042/069/088).
- Authorization per §7/§8; the chip is read-only for viewers.
- The projection carries runner ids only, never provider config or secrets.

## 16. Build order (each phase independently shippable)

1. **P1 — stop the bleeding.** WS1 (projection, drift, parse split, GET route),
   WS2 (no bootstrap file; write-back removal; `writeBack` contract removal),
   chip + read-only dialog, T1/T2/T6, contract docs for the changed routes.
2. **P2 — persist.** WS3, migration `0170` (+ fixture sweep, ERD), ignore
   route, removal of persist-config/banner, dialog "→ repo", T3, T5.
3. **P3 — adopt.** WS4, dialog "← DB", T4, T7.
4. **P4 — truth pass.** ADR-174, `project-manifest.md`, the §13 list, RU,
   `CLAUDE.md`, `docs/plans/README.md` status.

Per the owner's planning rules the ADR, the migration (SQL + journal +
snapshot) and every §13 doc are plan tasks inside their phase, not follow-ups.

## 17. Decisions and open questions

Answered in-session: D1–D11 (§3). Assumptions carried: HEAD-on-main stays a
persist precondition (N3); adopt is sequential with stop-at-first-failure
(install does `git clone` outside any transaction, so all-or-nothing is not
achievable); adopt never trusts.

Resolved 2026-09-15 (owner answers to the five forks):

1. `maister_yaml_path` → **(a)** dropped in `0170`, fixture sweep included (D8).
2. Standalone `flows[<id>]` removal / re-versioning via adopt → **(a)**
   `unsupported_item` (D10, N9).
3. Chip on the portfolio card → **(a)** yes, `unavailable` degradation (D10).
4. Identity fields in adopt → **(a)** plain column updates (D10).
5. Identity trio on file creation → clarified, not a fork: written per the
   omit-defaults rule, never selectable (D11). The runner is a separate,
   selectable item that is never pre-selected (D9).

No open questions remain.
