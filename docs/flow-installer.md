[← Configuration](configuration.md) · [Back to README](../README.md)

# Flow Plugin Installer

`installFlowPlugin()` in `web/lib/flows.ts` is the **install pipeline**:
clone a tagged git repo into the system cache, validate the manifest,
symlink it into the project's `.maister/` subtree, and upsert the row
into the `flows` table. The runner consumes installed bundles through
the content-addressed cache.

For what a Flow IS (entities, step DSL, lifecycle) see
[`docs/system-analytics/flows.md`](system-analytics/flows.md). For the
planned package lifecycle product surface see
[`docs/system-analytics/flow-packages.md`](system-analytics/flow-packages.md).
For the manifest schema (`flow.yaml` v1) see [Configuration](configuration.md).

## Layout

```
~/.maister/flows/<flowId>@<short_sha>/      # system cache, content-addressed
  flow.yaml                                  # parsed + validated v1 manifest
  setup.sh                                   # optional, executed once on install
  …shipped CLIs, skills, agents…

<project repo>/.maister/<slug>/flows/<flowId>  # symlink → ../../../../~/.maister/...@<short_sha>
```

The system cache is keyed by `<flowId>@<short_sha>` — the 12-character
prefix of the git commit SHA captured at install time via
`git rev-parse HEAD` after the tag-pinned clone. Installing the same
tag at the same upstream commit for two projects produces one cache
directory and two symlinks. The per-project symlink is what agents and
Flow steps reference (steps like `form_schema: ./schemas/review.json`
resolve relative to it).

### Version upgrade and immutability

The system cache is **content-addressed**, not tag-addressed:

- Re-installing the same tag at a different upstream commit
  (force-pushed tag, replaced tag) produces a new cache directory at
  the new SHA. The old directory stays on disk untouched.
- Re-installing a different tag that resolves to the same commit
  shares the cache directory with the original install.

Current implementation updates `flows.installed_path`, `flows.version`,
`flows.revision`, and `flows.manifest` in place on upgrade — the row is
the project's "currently installed" pointer. **Runs in flight do not read this
column**: each run snapshots `flows.revision` into `runs.flow_revision` at
launch and the runner derives the bundle path from `(flowRefId,
runs.flow_revision)` via `systemCachePath`. A flow upgrade therefore cannot
mutate the bytes of a still-running flow — the SHA-pinned directory remains
intact and the runner keeps reading from it until the run completes or is
discarded.

Planned M10 moves the mutable project pointer out of the package revision
record: package revisions become immutable rows, while project enablement
selects which installed revision new runs should use. That unlocks explicit
install, trust, enable, upgrade, rollback, disable, and removal UX without
weakening the run pinning contract above.

Local-source installs (file:// to a non-git directory, used by
test fixtures and in-repo plugins) use the literal `"unknown"` sentinel as the
revision; their cache directory lives at
`~/.maister/flows/<flowId>@unknown/` and is NOT content-addressed.
Production flows are git-only.

Garbage collection of orphaned SHA-keyed directories
(`@<old_sha>` with no live run pinned to it) is **future work** — a
cron / install-time hook that scans `runs.flow_revision` and removes
unreferenced directories. Until that ships, expect the cache to grow
proportionally to the number of upgrades.

## Public API

```ts
import { installFlowPlugin } from "@/lib/flows";

const result = await installFlowPlugin({
  source: "github.com/<org>/<repo>",   // git URL accepted by `git clone`
  version: "v1.2.3",                   // git tag
  projectId: "<uuid>",                 // FK into `projects` table
  projectSlug: "demo-app",             // kebab-case, used in symlink path
  flowId: "bugfix",                    // flow reference id used in maister.yaml
  workspaceRoot: "/repos/demo-app",    // optional; defaults to process.cwd()
  db: drizzleClient,                   // optional; defaults to getDb()
  signal: abortSignal,                 // optional; cancels long clones
});
// → { flowRowId, installedPath, symlinkPath, manifest, revision }
```

`revision` is the 40-char git commit SHA captured at install time
(or `"unknown"` for local-source fixtures). Callers that launch
runs MUST snapshot this into `runs.flow_revision` so the runner can
derive the immutable bundle path.

All known failures throw `MaisterError({ code: "FLOW_INSTALL", cause })`.
`cause` carries the original `Error` (git stderr, fs error, manifest
validation issues). The UI never string-matches `message` — it branches
on `code` only.

## Behavior

1. **Validate** `flowId`, `version`, `projectSlug`, `source` at the
   sink's invariant (filesystem segment regex + `..` rejection +
   length cap). Bad inputs throw before any I/O. See
   [Error Taxonomy](error-taxonomy.md) for the boundary-validation
   rationale (the same rule applies to supervisor's
   `StartSessionRequestSchema`).
2. **Idempotent clone**: if `<target>/flow.yaml` already exists, skip
   `git clone` entirely. Otherwise `git clone --branch <version>
--depth 1 --single-branch <source> <target>` runs with a 120 s
   timeout and a 4 MB stdout buffer cap.
3. **Manifest validation** via `loadFlowManifest()` in
   `web/lib/config.ts` (zod-checked against `flowYamlV1Schema`).
   Any validation failure becomes `FLOW_INSTALL` (not `CONFIG`) so
   callers branch on a single code.
4. **`setup.sh`** (optional, once-only): if the cloned tree contains
   `setup.sh`, run it once via `bash` with `cwd=<target>` and a 60 s
   timeout. Successful runs write a `.maister-setup-done` sentinel
   next to `flow.yaml`; subsequent installs see the sentinel and skip
   re-execution (so callers can re-invoke `installFlowPlugin()`
   without re-running side-effectful setup like dependency installs).
   Non-zero exit → WARN log, install continues, **no sentinel written**
   (so the next install will retry the script). `AbortSignal`
   cancellation → throws `FLOW_INSTALL` so the caller can surface it.
   Current MAIster trusts internal Flow sources; sandboxing and trust UI
   are Phase 2.
5. **Symlink**: `mkdir -p` parent, then:
   - missing → `symlink(target, linkPath)`,
   - symlink with correct target → no-op,
   - symlink with wrong target → `unlink` + recreate,
   - **non-symlink file** at `linkPath` → throw `FLOW_INSTALL`
     ("refuse to overwrite non-symlink"). The installer never
     deletes regular files the user may have placed there.
6. **DB upsert**: `INSERT INTO flows ... ON CONFLICT (project_id,
flow_ref_id) DO UPDATE SET ...` — same row id stays stable on
   version upgrade; only `version`, `installed_path`, `manifest`,
   `schema_version`, `recommended_executor_id` change. The unique
   constraint `flows_project_ref_uq` is the conflict target.

## Concurrency

In-process dedup map keyed by `projectId::flowId@version`. Two parallel
calls with the same triple share one promise (the symlink + DB upsert
run exactly once). Two parallel calls with the same `flowId@version`
but **different** `projectId` run independent pipelines; the
filesystem-level `pathExists(target)` check prevents both from running
`git clone` against the shared cache target.

Current deployment is single-host + single-process — no cross-process file lock. If
two Next.js processes ever installed the same flow tag simultaneously
on the same host, the second `git clone` would fail with "destination
already exists"; the second caller would still get a valid manifest
through the FS-level idempotency check on retry. Cross-process locking
is Phase 2.

## Errors

All install failures bubble as `MaisterError({ code: "FLOW_INSTALL",
cause })`:

| Trigger | Cause `Error.message` excerpt |
| --- | --- |
| Boundary validation (bad `flowId`, `version`, slug, source URL) | `Invalid <field>: <zod issues>` |
| `git clone` non-zero exit / unreachable tag / network timeout | `git clone failed for <source>@<version>: <stderr>` |
| `flow.yaml` invalid (schemaVersion mismatch, missing fields, dup step ids) | `flow.yaml invalid in <target>: <zod issues>` |
| Symlink path occupied by non-symlink | `refuse to overwrite non-symlink at <path>` |
| DB upsert race / connection drop | `db upsert failed for flow <flowId>@<version>` |

See [Error Taxonomy](error-taxonomy.md) for the full code map.

## Ops CLI

For smoke-testing without going through the UI:

```bash
DB_URL=postgres://... \
  pnpm install-flow \
    --project demo-app \
    --source github.com/org/maister-flow-bugfix \
    --version v0.1.0 \
    --flow-id bugfix
```

The project must already be registered (`projects.slug = demo-app`).
The CLI calls `installFlowPlugin()` with `workspaceRoot =
projects.repo_path`, prints structured pino logs, exits `0` on success
and `1` on `MaisterError`. It is not in the CI matrix — manual smoke
test only. The Add-Project UI will replace it for normal use.

The CLI runs under `tsx` with a tiny ESM loader
(`web/scripts/_register-shim.mjs`) that maps `server-only` to its empty
shim — without it, `tsx` outside Next.js would throw on the
`import "server-only"` lines in `lib/*`.

## Local-directory sources

`installFlowPlugin()` accepts an absolute filesystem path or `file://`
URL as `source`, in addition to git URLs. The installer auto-detects
which path applies:

- Absolute path → `fs.stat()` it. If it's a directory containing
  `flow.yaml` **and not a `.git` directory**, copy via
  `fs.cp(source, target, { recursive: true })` into the system cache.
- Otherwise fall through to `git clone --branch <version> <source>`.

The `.git` check is important: when a test fixture or an in-repo plugin
happens to live inside a git repo, the installer still honors the
`--version` tag instead of fs-copying the working tree.

`version` becomes a label on the target path
(`~/.maister/flows/<id>@<version>/`) and the row regardless of source
kind, so `local-dev` (or any other label) is fine for in-monorepo
plugins.

The in-repo `aif` plugin uses this path — see
[aif plugin](flow-aif-plugin.md). When `aif` extracts to its own repo,
the only change is the `source` / `version` flip in `maister.yaml`. No
code edits.
