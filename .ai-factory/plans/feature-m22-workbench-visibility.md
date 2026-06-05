# Implementation Plan: M22 — Workbench visibility (flow-graph view · file-tree · workbench diff)

Branch: `feature/m22-workbench-visibility` — **NOT auto-created** (this is a
PLAN-ONLY pass on `main`). Create it at `/aif-implement` time; this file already
uses that branch stem so the branch-based consumer skills discover it.
Created: 2026-06-05 · Refined: 2026-06-05 (Codex adversarial pass — RBAC/visibility hardened)

## Settings
- Testing: yes (strict TDD — per-task QA(RED) → implementor(GREEN) → adversarial reviewer)
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint; Phase 0 is docs-first (single source of truth)

## Roadmap Linkage
Milestone: **"M22. Workbench visibility (flow-graph view · file-tree · diff)"** —
the next free milestone number (M17 HITL-hybrid and M20 dogfood are the only open
lines; M21 is shipped; M22 is the next sequential free number). **Propose adding
the M22 line to `.ai-factory/ROADMAP.md` at `/aif-implement` time.**
Rationale: implements **Wave-1 / E1 "Workbench usability"** verbatim from
[`docs/pv/improvement-roadmap.md`](../../docs/pv/improvement-roadmap.md) §E1 +
"Graph rendering & layout" — the dogfood-unblocking track. **Scope: Full** (one
cohesive milestone, three independently-shippable tracks A/B/C; see §0.1).

---

## 0. Scope, decisions, and what already exists

### 0.1 What the milestone delivers

Three independent tracks (roadmap: "all four tracks are independent"), one
milestone. Each track is a sequence of phases that ends GREEN and shippable.

| Track | Deliverable | Phases |
|---|---|---|
| **A — Flow-graph view** | A per-run flow-graph **VIEW** with **live node-status coloring** (reuse `@xyflow/react` + dagre, ADR-039). Dagre seeds auto-layout; **manual placement persists** in a separate, **project-scoped** layout store (NEVER `flow.yaml`). **Node-selection side-forms are explicitly deferred** (view first). | 0,1,2,3 |
| **B — Repo file-tree** | A read-only **file-tree browser** over **git-tracked** files of the worktree (per-run workbench) and the project repo (project page), lazy per-level, with a capped file viewer. Reads only tracked content (no `.git`, no gitignored secrets, no untracked output). | 0,4 |
| **C — Workbench diff** | The base→run **diff** in the per-run workbench, extending the M18 review surface's `diffRange` + raw-`<pre>` rendering to any run state (not only `Review`). | 0,5 |
| (shared) | i18n EN+RU + Playwright e2e + final gate | 6 |

Locked product constraints (from the command + roadmap §E1):
- **HeroUI v3 only**; EN+RU i18n required; live updates via **SSE only — NO
  polling / `fs.watch`** (ADR #1).
- **Canvas node positions persist in a SEPARATE, project-scoped layout store,
  NEVER in the `flow.yaml` manifest** (the DSL stays logic-only). *(The backlog
  doc §E1 floats an in-manifest "presentation section"; the command overrides —
  see "Resolved during refinement" R1.)*
- Dagre seeds auto-layout; manual placement overrides persist and round-trip.
- The view is read-only inspect + drag-to-reposition. **No node logic editing**
  (the graph EDITOR is Wave-3, explicitly out of scope here).
- **File access is git-tracked-only and gated above `viewer`** (new
  `readRepoFiles = member`); layout writes are project-scoped and gated by a new
  `editFlowLayout = member` action. Two new authz boundaries, not a reuse of
  `readBoard` (Codex hardening — §0.3.B/D).

### 0.2 What ALREADY exists (do not rebuild — verified during exploration)

**React Flow + dagre stack (ADR-039) — the reuse spine for Track A:**
- `@xyflow/react@12.11.0` + `@dagrejs/dagre@3.0.0` are the entire graph/layout
  stack (`web/package.json`). **No new dependency.**
- `layoutGraph(nodes: Node[], edges: Edge[]): Node[]` in
  `web/lib/board/evidence-graph-layout.ts` is **already generic** — it takes plain
  React-Flow `Node[]`/`Edge[]`, runs dagre `{rankdir:"LR", nodesep:40, ranksep:80}`,
  returns nodes with `position.x/y`. **Reuse as-is** to seed auto-layout.
- `toFlowGraph(...)` in the same file is **evidence-specific** (`type:"evidence"`)
  — Track A needs its own transform (`toFlowGraphView`) following the same shape.
- `web/components/board/evidence-graph.tsx` (`"use client"`) is the precedent
  component: custom node factory `makeEvidenceNodeView`, `colorForState()` →
  HeroUI `<Chip color>`, `<Handle>` source/target, `ReactFlow` used directly (no
  generic wrapper exists). **Mirror this pattern; do not share a wrapper.**
- `web/components/board/evidence-graph-section.tsx` (`"use client"`) is the
  `dynamic(() => import(...), { ssr: false })` SSR-barrier wrapper — **replicate**.

**Compiled (logic-only) graph — the topology source for Track A:**
- `web/lib/flows/graph/compile.ts` exports `CompiledNode` and `FlowGraph`
  (`{ entry: string; order: string[]; nodes: Map<string, CompiledNode> }`).
  Adjacency lives in `CompiledNode.transitions: Record<string,string>` (outcome →
  node id or `"done"`). `compileManifest(manifest)` is the entrypoint;
  `resolveTransition(node, outcome)` resolves an edge. **No x/y anywhere.**
  `CompiledNode.nodeType` ∈ `ai_coding|cli|check|judge|human|guard`, `gates:
  GateDef[]`, `rework?`.

**Live node/gate status — the coloring source for Track A:**
- `getRunTimeline(runId): Promise<RunTimeline>` (`web/lib/queries/run.ts`) returns
  `TimelineEntry[]` — per `node_attempts` row: `{nodeId, nodeType, attempt, status
  (Pending|Running|Succeeded|Failed|NeedsInput|Reworked|Stale), gates:
  TimelineGate[]}`. **Color a node: group by `nodeId`, take the highest
  `attempt`.** `TimelineGate.status` ∈ `pending|running|passed|failed|stale|
  skipped|overridden`. `runs.current_step_id` is on `RunDetail.currentStepId`.
- **CRITICAL GAP:** the SSE stream `GET /api/runs/[runId]/stream` carries only
  **supervisor session events** (`session.line|update|permission_request|exited|
  crashed`) — **NO `nodeId→status` delta**. The run-detail page
  (`web/app/(app)/runs/[runId]/page.tsx`) is a **pure Server Component with no
  live subscription** (re-renders only on navigation or an action's
  `router.refresh()`). So live coloring needs an explicit design (§0.3.A).
- `useRunStream(runId)` (`web/lib/use-run-stream.ts`) already exists: native
  `EventSource`, `{events, status, lastEventId, error, reconnect}`. Wired only
  into a dev fixture today — **reuse it as the live trigger.**

**Diff — the reuse spine for Track C:**
- `diffRange({worktreePath, baseRef, branch}): Promise<string>` (`web/lib/worktree.ts`)
  = raw `git diff --no-color base..branch` (truncation-guarded). `logRange`,
  `resolveBaseRef`, `resolveRefSha`, `statusPorcelain`, `listBranches`,
  `for-each-ref` also present (no `ls-tree`/`cat-file` yet — Track B adds them).
- `GET /api/runs/[runId]/diff/route.ts` **already returns `{runId, baseCommit,
  sourceBranch, targetBranch, diff}`** — but is **scratch-only** (`runKind !==
  "scratch"` → `PRECONDITION`). Track C **extends it to flow runs** (§0.3.C).
- M18 `web/components/runs/review-panel.tsx` renders the diff as a raw `<pre>`
  (`font-mono text-[11px]`, no parser, **no syntax highlighting — Phase 2**);
  `buildReviewPanelData` computes the diff server-side via `diffRange`.

**File-tree — greenfield for Track B (verified: NOTHING exists):**
- No file-tree / directory-listing UI or API exists anywhere in `web/`.
- `web/lib/worktree.ts` is purely git-op oriented; reads happen through validated
  git plumbing (`execFileAsync("git", [...], {AbortSignal.timeout})`,
  `--end-of-options`-hardened, zod-validated refs/paths). Track B adds
  `listTree`/`readBlob` in the **same module + same hardening** — **no raw `fs`
  read of arbitrary paths** (the security pivot, §0.3.D).
- `getRunDetail(runId)` already exposes `worktreePath`, `projectRepoPath`,
  `branch`, `baseBranch`, `baseCommit`, `projectMainBranch`, `projectId`
  (`web/lib/queries/run.ts`).
- HeroUI v3 has **`Disclosure`/`Accordion`/`ListBox`/`Tabs` but NO `Tree`** — the
  tree is built from `Disclosure`/`ListBox` + icons.

**RBAC + schema linkage (for the hardened keying/permission decisions):**
- `web/lib/authz.ts` `PROJECT_ACTION_MIN` = `{readBoard:viewer, readScratchRun:
  viewer, launchRun:member, operateScratchRun:member, promoteRun:member,
  recoverRun:member, createTask:member, answerHitl:member, editSettings:admin,
  managePackages:admin}`; `requireProjectAction(projectId, action)` maps an action
  → min role; `projectId` MUST be server-derived. **M22 adds `readRepoFiles:
  member` and `editFlowLayout: member`.**
- `flows` is **per-project** (every consumer keys `project_id` with `flow_id`;
  `tasks.flow_id`/`runs.flow_id` reference `flows.id`). `runs.flow_id` is set for
  every flow run (null only for scratch, which has no flow graph). `runs.
  flow_revision_id` is **nullable** (legacy rows). **⇒ the layout store keys on
  `flow_id` (project-scoped, upgrade-stable), NOT `flow_revision_id`** (§0.3.B).
- Last ADR = **ADR-050**; new ADRs = **ADR-051..053**. Last migration =
  `0023_drop_legacy_executors.sql`; next = **0024** (verify highest at implement
  time). Engine stays **1.2.0** (the layout store is pure DB, outside the
  manifest — **no engine bump**, no DSL change).

### 0.3 Core designs

#### 0.3.A — Live node-status coloring (Track A keystone, ADR-052)

The view is a `"use client"` `<FlowGraphView>` mounted via the `{ssr:false}`
wrapper. Data flow:

1. **Server (run-detail page, static at render):** `compileManifest(pinnedManifest)`
   → topology (nodes+edges, no x/y); load layout overrides for `runs.flow_id`;
   load initial statuses (`getRunTimeline` → highest-attempt-per-node map). Pass
   `{topology, layout, initialStatuses, currentStepId, runStatus, labels}` to the
   client component.
2. **Client layout:** run `layoutGraph` (dagre) over the topology for a baseline,
   then **apply stored overrides on top** (override x/y wins; un-overridden nodes
   keep the dagre seed). Topology + layout are stable → dagre runs **once**.
3. **Client live coloring (ADR #1-compliant, NO polling):** subscribe to
   `useRunStream(runId)`. On each SSE event, **debounce ~1 s** and refetch the
   lightweight `GET /api/runs/[runId]/graph-status` JSON (node→status + gate
   rollup + `currentStepId`); recolor in place (no dagre re-run, no page refresh).
   **Skip refetch when `runStatus` is terminal** (no live session → statuses are
   frozen; the server snapshot is authoritative). The refetch is *triggered by*
   SSE events, never a timer — the sanctioned SSE notification path, not a poll.
   ADR-052 states this explicitly so a reviewer does not read it as polling.
4. **Color map:** node `status` → HeroUI `<Chip color>` via `colorForNodeStatus`
   (mirror of `colorForState`): `Running`→accent, `Succeeded`→success,
   `Failed`→danger, `NeedsInput`→warning, `Reworked`/`Stale`→warning/muted,
   `Pending`→default. The **current node** (`currentStepId`) gets ring emphasis; a
   blocking-gate `failed`/`stale` rollup tints a node badge.

#### 0.3.B — Layout-metadata store (project-scoped; ADR-051, Codex #2 hardened)

A **new DB table `flow_graph_layouts`** (migration 0024) — the separate store the
command mandates (NEVER `flow.yaml`), **keyed by the per-project `flow_id`** so a
member of one project can NEVER mutate the layout another project sees:

```
flow_graph_layouts
  id                  text PK
  flow_id             text NOT NULL  FK → flows.id  ON DELETE CASCADE
  node_id             text NOT NULL
  x                   double precision NOT NULL
  y                   double precision NOT NULL
  updated_by_user_id  text NULL      FK → users.id  ON DELETE SET NULL
  updated_at          timestamptz NOT NULL default now()
  UNIQUE (flow_id, node_id)
```

- **Keying = per `flow_id` (the per-project flow binding).** Rationale (resolves
  Codex #2 + old Q1): `flows.id` is project-scoped, so the layout is
  **project-isolated by construction** — the write authorizes against the run's
  project and can only touch that project's `flow_id` rows; a global
  `flow_revision_id` key (which `flow_revisions` shares across projects) would let
  project A's member overwrite project B's view. `flow_id` keying is also
  **upgrade-stable** (survives a revision bump). `runs.flow_revision_id` is
  nullable anyway. Stale node-ids (a revision dropped a node) are **ignored at
  render** (the node isn't in the compiled topology → its row is skipped; dagre
  seeds the rest).
- **Round-trip with auto-layout:** dagre always computes a baseline; stored rows
  are **overrides merged on top**. No flag — a node with no row = dagre-seeded;
  a node with a row = pinned.
- **Write = single-store upsert** (no multi-store transition, no external
  side-effect): `PUT /api/runs/[runId]/graph/layout` body `{nodeId, x, y}` →
  `onConflictDoUpdate` keyed `(flow_id, node_id)`. `runId` = url-param; `flow_id`
  = **server-state** (from the run); `node_id` = **body, validated against the
  run's pinned-manifest node set (allow-list)** before write; `x/y` = bounded
  floats. **RBAC = new `editFlowLayout` action (`member`)** — explicit and
  tunable to `admin` later without touching call sites (layout is shared
  *within* the project).
- **GC interaction:** layout rows are children of `flows` (CASCADE), **not** of
  `flow_revisions` — so M19 revision-GC does NOT delete layout (it survives a
  revision upgrade; only deleting the project/flow removes it). T1.5 asserts this.

#### 0.3.C — Workbench diff (Track C, no new ADR — reuses M18)

- **Extend `GET /api/runs/[runId]/diff` to flow runs:** for a flow run, base =
  `workspaces.base_commit ?? resolveBaseRef(worktreePath, branch,
  projectMainBranch)` (legacy-null fallback), branch = `workspaces.branch`, via
  `diffRange`. Return the **same JSON shape** as scratch + add `files`
  (changed-file summary). RBAC: flow path = `readBoard` (viewer — the diff is
  **run-scoped**, only that run's `base..branch` changes, matching the existing
  M18 review-panel visibility); scratch path keeps `readScratchRun`.
- **Changed-files summary:** add `diffNameStatus({worktreePath, baseRef, branch})`
  (`git diff --name-status base..branch`) so the workbench renders a changed-files
  list beside the raw diff (cheap, no parser dep). Clicking a file anchors/filters
  the `<pre>` client-side (no new route). **Syntax highlighting stays Phase 2.**
- Diff rendering = the M18 `<pre>` block, extracted into a reusable
  `web/components/runs/raw-diff.tsx` shared by the review panel and the workbench
  (DRY; the review panel keeps its promotion controls).

#### 0.3.D — File-tree: git-tracked-only, member-gated (Track B, ADR-053, Codex #1 hardened)

The file browser reads **only git-tracked content via git plumbing** — it never
does a raw `fs.readdir`/`readFile` of an arbitrary worktree/repo path. This makes
the trust boundary "what is committed to the repo," excluding `.git/`, gitignored
secrets (`.env*`), `node_modules`, and untracked agent output **by construction**
(not by a leaky denylist). Combined with a **dedicated `readRepoFiles = member`
permission** (stricter than `readBoard`/viewer), a low-privilege viewer cannot
browse source at all, and even a member cannot reach service/secret files.

- **Reads (git plumbing, on-demand — NOT a watcher; ADR #1-compliant):**
  - `listTree({repoOrWorktreePath, ref, dir}) → {path, entries:[{name,
    type:"file"|"dir"}]}` via `git ls-tree --name-only -z <ref> -- <dir>/`
    (one level). `readBlob({repoOrWorktreePath, ref, path, maxBytes}) →
    {kind:"text", content} | {kind:"too-large", size} | {kind:"binary"}` via
    `git cat-file -s` (size) then `git cat-file blob <ref>:<path>` capped at
    `MAISTER_WORKBENCH_MAX_FILE_BYTES` (default 512 KiB). Both new in
    `web/lib/worktree.ts`, `--end-of-options`-hardened.
  - **ref** = the run branch tip (run workbench) or `projects.main_branch` HEAD
    (project page) — **server-state**, never body-controlled.
  - **path/dir** is **body/query-controlled and UNTRUSTED** → validated by a new
    `repoRelPathSchema` (reject `..`, absolute, leading `/`, leading `-`, NUL).
    Git plumbing additionally scopes to the repo object DB (it cannot read
    outside the tree), so a tracked-only read is doubly confined.
- **Routes (RBAC = `readRepoFiles` = member):**
  - `GET /api/runs/[runId]/files?path=` + `…/files/content?path=` — run worktree.
  - `GET /api/projects/[slug]/files?path=` + `…/files/content?path=` — project repo.
  - `runId`/`slug` = url-param → server-state `projectId`/`worktreePath`/`repoPath`/
    `ref`; over-cap → `413` marker, binary → `415` marker, unknown path → `404`.
- **Untracked-file viewing is explicitly deferred** (the diff covers committed
  changes; untracked WIP is the secret-disclosure surface we are excluding). A
  later milestone can add an opt-in, member+ "show untracked" mode with an
  explicit secret-pattern denylist if dogfood demands it.

---

## 1. Deployment wiring (skill-rule: every new env var/route/table lands in deploy artifacts)

| New dependency | Lands in |
|----------------|----------|
| `MAISTER_WORKBENCH_MAX_FILE_BYTES` (default `524288`) — `readBlob` cap | `.env.example` + `compose.yml` web `environment:` + `compose.override.yml` + `compose.production.yml` + `docs/configuration.md` env table |
| Migration **0024** (`flow_graph_layouts`, FK → `flows.id` CASCADE) | Drizzle migration committed + `docs/database-schema.md` + the flows ERD in `docs/db/*.md` + `docs/db/erd.md` |
| New authz actions `readRepoFiles`/`editFlowLayout` | code (`web/lib/authz.ts`) + `web/CLAUDE.md` RBAC section + `docs/error-taxonomy.md` caller rows (no new error code) |
| `GET /api/runs/[runId]/graph` · `…/graph-status` · `PUT …/graph/layout` | web port (3000); `web.openapi.yaml` + `docs/system-analytics/workbench.md` |
| `GET /api/runs/[runId]/files[/content]` · `GET /api/projects/[slug]/files[/content]` | web port; `web.openapi.yaml` + `workbench.md` |
| `GET /api/runs/[runId]/diff` extended to flow runs (status/body unchanged) | `web.openapi.yaml` (flow-run case) + `workbench.md` |

No new sidecar binary, no new bound port, no new npm dependency, no Dockerfile
change, no engine bump.

---

## 2. Contract-surface → spec-file map (skill-rule: trace every contract surface)

| Surface | Spec file |
|---------|-----------|
| `GET /api/runs/{runId}/graph` (200/401/403/404) — topology + layout | `docs/api/web.openapi.yaml` + `docs/system-analytics/workbench.md` |
| `GET /api/runs/{runId}/graph-status` (200/401/403/404) — live node/gate statuses | `web.openapi.yaml` + `workbench.md` |
| `PUT /api/runs/{runId}/graph/layout` (200/400/401/403/404/409) — single-store upsert, `editFlowLayout` | `web.openapi.yaml` + `workbench.md` |
| `GET /api/runs/{runId}/files` + `…/files/content` (200/400/401/403/404/413/415), `readRepoFiles` | `web.openapi.yaml` + `workbench.md` |
| `GET /api/projects/{slug}/files` + `…/files/content` (same), `readRepoFiles` | `web.openapi.yaml` + `workbench.md` |
| `GET /api/runs/{runId}/diff` — **flow-run case added** (no body/status change) | `web.openapi.yaml` + `workbench.md` + `docs/system-analytics/runs.md` |
| New table `flow_graph_layouts` | `docs/database-schema.md` + `docs/db/*.md` ERD + `docs/db/erd.md` |
| New authz actions `readRepoFiles`/`editFlowLayout` | `web/CLAUDE.md` RBAC section + `docs/error-taxonomy.md` caller rows |
| New env var `MAISTER_WORKBENCH_MAX_FILE_BYTES` | `docs/configuration.md` env table (canonical) + `.env.example` |
| Reuse of `CONFIG`(400)/`PRECONDITION`/`CONFLICT`(409)/`UNAUTHENTICATED`(401)/`UNAUTHORIZED`(403) by the new routes | `docs/error-taxonomy.md` caller rows (**no new error code** — ADR-008 closed union) |
| New domain analytics | `docs/system-analytics/workbench.md` (new, per docs R5) + glossary row in `docs/CLAUDE.md`; pointers from `flow-graph.md` (view) and `workspaces.md` (file source) |
| ADR-039 (renderer) cited; ADRs 051/052/053 proposed | `docs/decisions.md` |

---

## 3. Decisions (skill-mandated checklists)

### 3.1 Identifiers per route (skill-rule: body-controlled vs server-state)

- `GET …/graph` · `…/graph-status` · `…/files[/content]` · `…/diff`: `runId`/`slug`
  = **url-param** (trusted via route shape + RBAC). `projectId`, `worktreePath`,
  `repoPath`, `ref`, `flow_id`, pinned manifest = **server-state** (DB joins via
  `getRunDetail` / slug→project). The file routes' `?path=` is
  **query-controlled and UNTRUSTED** → validated by `repoRelPathSchema` and used
  only as a git pathspec under a tracked-only `ls-tree`/`cat-file` (no fs/DB
  cross-resource use). ✅
- `PUT …/graph/layout`: `runId` = **url-param**; `flow_id` = **server-state** (from
  the run); body `{nodeId, x, y}` — `nodeId` is **body-controlled but validated
  against the pinned-manifest node set (allow-list)** before upsert (unknown id →
  `400 CONFIG`, no write); `x/y` bounded floats. **No body cross-resource
  locator.** ✅
- `GET /api/projects/{slug}/files[/content]`: `slug` = **url-param** → server-state
  `projectId`/`repoPath`/`ref`; `?path=` UNTRUSTED → `repoRelPathSchema` + tracked
  `ls-tree`. ✅

### 3.2 Two-phase commit (skill-rule) — N/A, stated explicitly

Every new route is a **read** except `PUT …/graph/layout`, a **single in-DB
upsert with no downstream side-effect** (no supervisor RPC, no file write, no git
op). The two-phase-commit rule does not apply; there is no BEFORE/AFTER
idempotency marker and no external delivery to classify. The upsert is idempotent
by `(flow_id, node_id)` last-writer-wins. ✅

### 3.3 Multi-store atomic transition + crash windows (skill-rule) — N/A, stated

No transition writes across more than one store. The layout upsert touches exactly
one table. No run-status flip, no ledger row, no on-disk artifact, no cursor — no
crash-window matrix to enumerate. ✅

### 3.4 Fan-out to ALL consumers (skill-rule, allow-list guards)

**No new `runs.status` value, no new enum case, no state-changing run route, no
scheduler/cap/sweep touch.** Track A *reads* existing `node_attempts.status`/
`gate_results.status`/`current_step_id`; it adds **no** status — the
new-status fan-out is empty by design (assert it so `/aif-verify` confirms
nothing was missed). The genuine fan-outs are:

| Consumer class | Update |
|----------------|--------|
| RBAC actions | `readRepoFiles`/`editFlowLayout` added to `PROJECT_ACTION_MIN` (`web/lib/authz.ts`) AND documented in `web/CLAUDE.md` RBAC list AND error-taxonomy; every new route uses the action allow-list (role-min, never `!terminal`) |
| API spec | the six new read routes + the layout `PUT` + the extended diff case get `web.openapi.yaml` paths in the same change |
| ERD / DB narrative | `flow_graph_layouts` lands in `database-schema.md` + `db/*.md` + `db/erd.md` |
| Run-detail read surface | the run-detail page mounts `<FlowGraphView>` + `<RunWorkbench>` (file-tree + diff) sections; additive, no status-read-model change |
| Project page | a `repo` (files) tab; add to `ProjectTab`/`VALID_TABS`/`project-tabs.tsx` (the project flow-graph **preview is deferred** — see R2) |
| i18n | new `workbench` namespace in **both** `en.json` and `ru.json` |
| GC (M19) | `flow_graph_layouts` is `flow_id`-CASCADE (NOT `flow_revision_id`) — confirm M19 revision-GC does NOT delete layout (it survives a revision bump); T1.5 regression-asserts this |
| Cross-project authz | `flow_id` keying makes a project-A member's layout write structurally unable to touch project B; T1.5 two-project integration test proves it |

### 3.5 Path confinement / trust (skill-rule: untrusted input, no fetch-then-execute)

- The file routes read untrusted-`path` content but only via **git plumbing over
  tracked objects** — there is **no execute path** (no `setup.sh`, no hook, no
  `child_process` of repo content) and **no raw `fs` read of an arbitrary path**.
  So both the fetch-then-execute separation rule and the path-traversal risk are
  satisfied: `git ls-tree`/`cat-file` cannot leave the repo object DB, untracked/
  ignored/`.git` paths are not in the tree, and `repoRelPathSchema` rejects
  `..`/absolute/`-`-prefixed/NUL pathspecs. The security boundary is **tracked
  files + `readRepoFiles` = member** (Codex #1).
- The existing artifact payload route keeps its own inline `serveFile` confinement
  (it reads run-dir artifact files, a different surface) — **not modified** by
  this milestone (no shared `confineToRoot` extraction; Track B does not read fs).

### 3.6 No-polling reaffirmation (ADR #1) — the central review risk

Live coloring (§0.3.A) refetches `…/graph-status` **only on SSE-event ticks**
(debounced), never on a timer, and stops on terminal runs. ADR-052 MUST state this
is the *sanctioned SSE notification path*, NOT a banned `fs.watch`/poll. File-tree
reads are user-driven (expand/open), not watchers. ✅

---

## Commit Plan

- **Commit 1** (Phase 0, T0.1–T0.7): `docs(m22): workbench analytics, ADR-051..053, graph/file-tree/diff + RBAC contracts`
- **Commit 2** (Phase 1, T1.0–T1.5): `feat(m22): readRepoFiles/editFlowLayout actions + flow_graph_layouts (flow_id-scoped) + layout PUT`
- **Commit 3** (Phase 2, T2.1–T2.4): `feat(m22): graph topology + live node-status read models + graph/graph-status routes`
- **Commit 4** (Phase 3, T3.1–T3.4): `feat(m22): FlowGraphView (React Flow reuse) + live coloring + run mount`
- **Commit 5** (Phase 4, T4.1–T4.5): `feat(m22): git-tracked listTree/readBlob + member-gated file-tree routes + browser`
- **Commit 6** (Phase 5, T5.1–T5.4): `feat(m22): flow-run diff + RawDiff component + workbench diff surface`
- **Commit 7** (Phase 6, T6.1–T6.3): `feat(m22): EN+RU i18n + Playwright e2e + final gate`

Every phase exit requires (executable gate, from repo root): `pnpm --filter
maister-web typecheck` (0) · `pnpm --filter maister-web test:unit` · `pnpm --filter
maister-web test:integration` · `pnpm validate:docs:all` — all green. Any test the
phase touches that is left red fails the phase (quarantine only via explicit
`*.skip` + tracked follow-up).

---

## Tasks

### Phase 0 — Analytics, ADRs & contracts (docs-first, source of truth; NO code)

- [x] **T0.1** — ADR-051 *Flow-graph layout metadata store (project-scoped)*. In
  `docs/decisions.md` (next number). Capture: a **separate `flow_id`-keyed DB
  table** (`flow_graph_layouts`), NEVER `flow.yaml`; **why `flow_id` not
  `flow_revision_id`** — `flows` is per-project so the key is project-isolated AND
  upgrade-stable, closing the cross-project write leak Codex flagged; the
  dagre-seed + override-merge round-trip (§0.3.B); the `(flow_id, node_id)` UNIQUE
  upsert; stale-node ignore at render; `editFlowLayout`=member RBAC; the deviation
  from the backlog doc's "presentation section in `flow.yaml`". Files:
  `docs/decisions.md`.
- [x] **T0.2** — ADR-052 *Live node-status coloring via SSE-triggered refetch*.
  The §0.3.A flow; the explicit statement that the debounced `…/graph-status`
  refetch is **SSE-triggered, never a timer** (reaffirms ADR #1 — no polling/
  `fs.watch`); terminal runs freeze coloring to the server snapshot; topology/
  layout static so dagre runs once. Files: `docs/decisions.md`.
- [x] **T0.3** — ADR-053 *Workbench file-tree: git-tracked-only, member-gated*.
  Reads only tracked content via `ls-tree`/`cat-file` (NOT raw fs; NOT a watcher →
  ADR #1-compliant); `.git`/gitignored/`node_modules`/untracked excluded by
  construction; `readRepoFiles`=member (stricter than `readBoard`); the file-size
  cap; run-branch vs project-main-branch ref; untracked-view deferral with
  rationale. Files: `docs/decisions.md`.
- [x] **T0.4** — New `docs/system-analytics/workbench.md` per docs R5 (Purpose,
  Domain entities [`flow_graph_layouts`, graph-view DTO, tracked file node,
  workbench diff], **State machine** `stateDiagram-v2` for node-status→color +
  layout override/auto-seed, **Process flows** `flowchart`/`sequenceDiagram` for:
  graph render + SSE-triggered recolor, layout drag→upsert→reload, lazy tracked
  file-tree expand, flow-run diff render, **Expectations** ≤12 testable MUST
  bullets referencing `flow_graph_layouts.flow_id`, `node_attempts.status`,
  `MAISTER_WORKBENCH_MAX_FILE_BYTES`, `readRepoFiles`, `editFlowLayout`, "git
  ls-tree tracked-only" verbatim — INCLUDING the visibility invariants (a `viewer`
  cannot read files; only tracked content is reachable; cross-project layout write
  refused), **Edge cases** linked to `MaisterError` codes, **Linked artifacts**).
  Add the glossary row to `docs/CLAUDE.md`; add a "view" pointer to
  `flow-graph.md` and a "tracked-file source" pointer to `workspaces.md`. Tag
  every piece Implemented/Designed per R6. (depends on T0.1–T0.3)
- [x] **T0.5** — DB design for migration 0024: `flow_graph_layouts` (§0.3.B exact
  shape, FK → `flows.id` CASCADE). Document in `docs/database-schema.md`
  (narrative + cascade chain: child of `flows`, NOT `flow_revisions` — survives
  revision GC) AND a `docs/db/*.md` Mermaid `erDiagram` AND `docs/db/erd.md`.
  (depends on T0.4)
- [x] **T0.6** — Contract specs: add to `docs/api/web.openapi.yaml` the six new
  read routes + the layout `PUT` + the flow-run case of `GET …/diff`, each with
  status codes, query/body shapes, example payloads, and the `readRepoFiles`/
  `editFlowLayout`/`readBoard` security note; update `docs/configuration.md` env
  table (`MAISTER_WORKBENCH_MAX_FILE_BYTES`); add the two new authz actions to the
  `web/CLAUDE.md` RBAC list and caller rows to `docs/error-taxonomy.md`. (depends
  on T0.1–T0.3)
- [x] **T0.7** — Phase-0 exit gate: `pnpm validate:docs:all` (Mermaid) green;
  **cross-consistency check**: §0.3 designs byte-consistent across ADR-051..053 and
  `workbench.md`; every described route/column/env/action is tagged and matches
  the planned code; no spec describes code that won't exist at the phase HEAD;
  `web.openapi.yaml` lints clean (`npx @redocly/cli lint`). (depends on T0.1–T0.6)
<!-- Commit checkpoint: T0.1–T0.7 -->

### Phase 1 — RBAC actions + project-scoped layout store (Track A foundation)

- [x] **T1.0** — Authz actions: add `readRepoFiles: "member"` and `editFlowLayout:
  "member"` to `PROJECT_ACTION_MIN` (`web/lib/authz.ts`); update the
  `ProjectAction` union consumers; document both in the `web/CLAUDE.md` RBAC
  section. Tests: unit — `requireProjectAction(projectId, "readRepoFiles")` denies
  a `viewer` (403) and admits a `member`; same for `editFlowLayout`. LOGGING:
  none (pure authz map). Files: `web/lib/authz.ts`, `web/lib/__tests__/authz*.test.ts`.
  (no dep)
- [x] **T1.1** — Migration 0024 + `web/lib/db/schema.ts`: add `flow_graph_layouts`
  (§0.3.B; additive, `flow_id` FK CASCADE, `updated_by_user_id` FK SET NULL,
  UNIQUE `(flow_id, node_id)`). Verify the highest existing migration number
  first; generate via the project's drizzle flow. Files: `web/lib/db/schema.ts`,
  `web/lib/db/migrations/0024_*.sql`. (depends on T0.5)
- [x] **T1.2** — `web/lib/queries/flow-layout.ts` (server-only):
  `getFlowLayout(flowId, db?): Promise<Record<nodeId, {x,y}>>` — the override map;
  pure, testable. LOGGING: DEBUG `[flow-layout.get] {flowId, count}`. Files:
  `web/lib/queries/flow-layout.ts`. (depends on T1.1)
- [x] **T1.3** — `web/lib/runs/flow-layout-write.ts`: `upsertNodeLayout({runId,
  nodeId, x, y, userId, db}) → {ok}` — resolve `flow_id` from the run
  (server-state; refuse if the run has no flow, e.g. scratch → `CONFIG`), compile
  the pinned manifest, **assert `nodeId` ∈ node set** (allow-list; else
  `MaisterError("CONFIG")`), bound `x/y`, `onConflictDoUpdate` on `(flow_id,
  node_id)`, stamp `updated_by_user_id`. LOGGING: DEBUG entry, INFO on upsert,
  WARN on unknown-node/no-flow refusal, format `[flow-layout.upsert]`. Files:
  `web/lib/runs/flow-layout-write.ts`. (depends on T1.2)
- [x] **T1.4** — `PUT /api/runs/[runId]/graph/layout/route.ts`:
  `requireActiveSession` + `requireProjectAction(projectId /* server-state */,
  "editFlowLayout")`; zod body `{nodeId:string, x:number, y:number}` (runId
  url-param only); call `upsertNodeLayout`; map `CONFIG`→400, RBAC→401/403,
  missing run→404, conflict→409. LOGGING: INFO request/result. Files:
  `web/app/api/runs/[runId]/graph/layout/route.ts`. (depends on T1.3)
- [x] **T1.5** — Tests P1. Unit: `getFlowLayout` shape; `upsertNodeLayout`
  known-node upsert, **unknown-node → CONFIG (no write)**, no-flow run → CONFIG,
  bound enforcement, idempotent re-upsert. Route: RBAC denial (`viewer` → 403),
  400 on bad body, 200 round-trip. Integration (testcontainers): upsert→read-back;
  **cross-project isolation (Codex #2)** — two projects each enable the same flow
  source (distinct `flows.id`); a `member` of project A upserts → only A's
  `flow_id` rows change, B's layout is untouched, and a write authorized against
  A but naming B's run is refused; **M19 revision-GC of a revision with layout
  rows does NOT delete the layout** (flow-scoped survives revision removal). Name
  vitest projects; confirm `include` globs match. Files:
  `web/lib/queries/__tests__/flow-layout*.test.ts`,
  `web/lib/runs/__tests__/flow-layout-write*.test.ts`,
  `web/app/api/runs/[runId]/graph/layout/__tests__/*`. Phase-1 exit gate:
  typecheck 0 + test:unit + test:integration green. (depends on T1.0, T1.4)
<!-- Commit checkpoint: T1.0–T1.5 -->

### Phase 2 — Graph topology + live node-status read models + routes

- [x] **T2.1** — `web/lib/queries/flow-graph-view.ts` (server-only): pure
  `buildGraphTopology(compiled: FlowGraph): {nodes:[{id, nodeType, label}],
  edges:[{id, source, target, outcome}]}` — nodes from `compiled.nodes`/`order`,
  edges from each `CompiledNode.transitions` (skip `"done"`; one edge per outcome).
  No DB, fully unit-testable. Files: `web/lib/queries/flow-graph-view.ts`. (no dep)
- [x] **T2.2** — `web/lib/queries/run-node-status.ts` (server-only):
  `getRunNodeStatuses(runId, db?) → {currentStepId, runStatus, nodes:
  Record<nodeId, {status, attempt, gates:{blocking:boolean, status}[], rollup}>}`
  — reuse `getRunTimeline`, **highest-attempt-per-node** (§0.2), gate rollup. Pure
  mapping. LOGGING: DEBUG `[run-node-status] {runId, nodeCount}`. Files:
  `web/lib/queries/run-node-status.ts`. (no dep)
- [x] **T2.3** — Routes: `GET /api/runs/[runId]/graph/route.ts` (compile pinned
  manifest → `buildGraphTopology` + `getFlowLayout(run.flow_id)` →
  `{topology, layout}`) and `GET /api/runs/[runId]/graph-status/route.ts`
  (`getRunNodeStatuses`). Both `requireActiveSession` +
  `requireProjectAction(…, "readBoard")`, `runId` url-param, server-derived
  `projectId`; 404 on missing run/manifest or a run with no flow. LOGGING: INFO
  request/result. Files: `web/app/api/runs/[runId]/graph/route.ts`,
  `web/app/api/runs/[runId]/graph-status/route.ts`. (depends on T2.1, T2.2, T1.2)
- [x] **T2.4** — Tests P2. Unit: `buildGraphTopology` — linear `steps[]` → chain;
  graph flow with `rework`/multi-outcome `transitions` → right edges; `"done"`
  omitted. `getRunNodeStatuses` — highest-attempt wins; `Reworked`/`Stale`
  surfaced; gate rollup picks worst-blocking. Route — RBAC denial; 404 missing
  run / no-flow run; topology+layout merge shape; status snapshot shape.
  Integration — a seeded run's `/graph-status` reflects a fresh `node_attempts`
  row. Name vitest projects; confirm globs. Phase-2 exit gate: typecheck 0 +
  test:unit + test:integration green. Files:
  `web/lib/queries/__tests__/flow-graph-view*.test.ts`,
  `web/lib/queries/__tests__/run-node-status*.test.ts`,
  `web/app/api/runs/[runId]/graph/__tests__/*`,
  `web/app/api/runs/[runId]/graph-status/__tests__/*`. (depends on T2.3)
<!-- Commit checkpoint: T2.1–T2.4 -->

### Phase 3 — FlowGraphView component (React Flow reuse) + live coloring + run mount

- [x] **T3.1** — `web/lib/board/flow-graph-view-layout.ts`: `toFlowGraphView(topology,
  layoutOverrides) → {nodes:Node[], edges:Edge[]}` (mirror `toFlowGraph`; set
  `type:"flowNode"`), reuse `layoutGraph` for the dagre baseline and **apply
  `layoutOverrides` on top** (override wins; **ignore overrides for node-ids not in
  the topology** — stale-node safety). `colorForNodeStatus(status, isCurrent) →
  ChipColor`. Pure, unit-tested. Files: `web/lib/board/flow-graph-view-layout.ts`.
  (depends on T2.1)
- [x] **T3.2** — `web/components/board/flow-graph-view.tsx` (`"use client"`):
  mirror `evidence-graph.tsx` — custom node factory (`<Chip color>` + `<Handle>`
  source/target + current-node ring + gate-rollup badge), `ReactFlow` direct,
  `nodesDraggable={editable}` with `onNodeDragStop` → `PUT …/graph/layout`
  (optimistic; `aria-live` on save error). **Live coloring:**
  `useRunStream(runId)` → debounced (~1 s) refetch of `…/graph-status` → recolor in
  place; **skip when `runStatus` terminal**; never a timer (ADR-052). Props:
  `{runId, topology, layout, initialStatuses, currentStepId, runStatus, labels,
  editable}`. Plus a `{ssr:false}` wrapper
  `web/components/board/flow-graph-view-section.tsx` (replicate
  `evidence-graph-section.tsx`). Files: both. (depends on T3.1, T2.3, T1.4)
- [x] **T3.3** — Mount on run-detail: `web/app/(app)/runs/[runId]/page.tsx` adds a
  **Flow graph** section (server-side: compile pinned manifest → topology;
  `getFlowLayout(run.flow_id)`; `getRunNodeStatuses` for `initialStatuses`;
  `editable` only when the viewer has `editFlowLayout`/member — pass a server-
  computed boolean, never trust the client), behind the `{ssr:false}` wrapper,
  alongside the evidence graph. Additive panel, no status-read-model change.
  Files: run-detail page. (depends on T3.2)
- [x] **T3.4** — Tests P3: unit — `toFlowGraphView` override-merge + dagre seed +
  **stale-node-id ignored**; `colorForNodeStatus` mapping incl. current-node
  emphasis. Component render (renderToStaticMarkup, no jsdom) — nodes render with
  correct chip colors from `initialStatuses`; draggable wiring present only when
  `editable`; current node emphasized. Name vitest projects; confirm globs.
  Phase-3 exit gate: typecheck 0 + test:unit + test:integration green. Files:
  `web/lib/board/__tests__/flow-graph-view-layout*.test.ts`,
  `web/components/board/__tests__/flow-graph-view*.test.ts`. (depends on T3.2,
  T3.3)
<!-- Commit checkpoint: T3.1–T3.4 -->

### Phase 4 — Repo file-tree (Track B — git-tracked-only, member-gated)

- [x] **T4.1** — `web/lib/worktree.ts`: add `repoRelPathSchema` (zod: non-empty,
  no `..` segment, not absolute, no leading `/` or `-`, no NUL) + `listTree({repo,
  ref, dir}): Promise<{path, entries:[{name, type}]}>` (`git ls-tree --name-only
  -z --end-of-options <ref> -- <dir>/`, dirs-first sort) + `readBlob({repo, ref,
  path, maxBytes}): Promise<{kind:"text",content}|{kind:"too-large",size}|
  {kind:"binary"}>` (`git cat-file -s <ref>:<path>` for size → over cap →
  `too-large`; binary sniff → `binary`; else `git cat-file blob`). All ref/path
  args validated (`gitRefSchema`/`repoRelPathSchema`), `--end-of-options`-hardened.
  `workbenchMaxFileBytes()` parser in `web/lib/instance-config.ts`. **Adversarial
  unit tests:** `..`/absolute/`-`-prefixed/NUL path → schema reject; a `.git/config`
  / gitignored `.env` / untracked file path → `ls-tree`/`cat-file` returns
  nothing (not in the tree) → 404, never disclosed; in-tree happy path; over-cap →
  `too-large`; binary → `binary`. LOGGING: DEBUG list/read. Files:
  `web/lib/worktree.ts`, `web/lib/instance-config.ts`,
  `web/lib/__tests__/worktree-tree*.test.ts`. (no dep)
- [x] **T4.2** — Run-workbench file routes: `GET /api/runs/[runId]/files/route.ts`
  (+ `…/files/content/route.ts`), `requireActiveSession` +
  `requireProjectAction(projectId, "readRepoFiles")`; `runId` url-param →
  server-state `worktreePath` + `ref = run branch`; `?path=` → `repoRelPathSchema`
  → `listTree`/`readBlob`; over-cap → 413 marker, binary → 415 marker, unknown
  path → 404. Files: the two routes. (depends on T4.1, T1.0)
- [x] **T4.3** — Project file routes: `GET /api/projects/[slug]/files/route.ts`
  (+ `…/files/content/route.ts`), same guard (`readRepoFiles`), slug →
  `projects.repo_path` + `ref = projects.main_branch`. Files: the two routes.
  (depends on T4.1, T1.0)
- [x] **T4.4** — Routes tests P4a: **a `viewer` is denied (403)** on every file
  route; a `member` is admitted; `.git`/gitignored/untracked path → 404 (not in
  the tracked tree); `..`/absolute path → 400; over-cap → 413; binary → 415;
  cross-project slug/run → 404 (uniform existence-hide). Name vitest projects;
  confirm globs. Files: route `__tests__`. (depends on T4.2, T4.3)
- [x] **T4.5** — File-tree UI: `web/components/workbench/file-tree.tsx`
  (`"use client"`, lazy expand via the `/files` routes; HeroUI `Disclosure`/
  `ListBox` + file/dir icons; accessible — keyboard expand, `aria-expanded`) +
  `file-viewer.tsx` (fetch `/files/content`, render text in `<pre>`, show
  too-large/binary markers). Mount: a **Repo files** section in the run workbench
  (run-detail page, behind the `?wb=` Tabs from T5.4) AND a project `repo` tab
  (add to `ProjectTab`/`VALID_TABS`/`project-tabs.tsx` + a `repo-files-panel.tsx`
  server panel passing `repo_path`+`main_branch`, gated server-side by
  `readRepoFiles`). Component render tests (renderToStaticMarkup) of a seeded
  entry list. Phase-4 exit gate: typecheck 0 + test:unit + test:integration green.
  Files: components, the panel, `project-tabs.tsx`, run-detail page,
  `web/components/workbench/__tests__/*`. (depends on T4.4)
<!-- Commit checkpoint: T4.1–T4.5 -->

### Phase 5 — Workbench diff (Track C)

- [ ] **T5.1** — `web/lib/worktree.ts`: add `diffNameStatus({worktreePath, baseRef,
  branch}): Promise<{path, status}[]>` (`git diff --name-status --no-color
  --end-of-options base..branch`, parsed). Unit-test the parse (rename/add/delete/
  modify). LOGGING: via the module logger. Files: `web/lib/worktree.ts`. (no dep)
- [ ] **T5.2** — Extend `GET /api/runs/[runId]/diff/route.ts` to flow runs: a
  `runKind === "flow"` branch resolves base = `workspaces.base_commit ??
  resolveBaseRef(...)`, branch = `workspaces.branch`, via `diffRange`; returns the
  **same JSON** as scratch + adds `files: diffNameStatus(...)`. RBAC: flow →
  `readBoard` (run-scoped diff, viewer — parity with the M18 review panel), scratch
  → `readScratchRun` (unchanged). **Assertion migration:** the existing
  scratch-only test asserting `PRECONDITION` on a flow run is updated to assert the
  new flow-run success. Files: diff route, its `__tests__`. (depends on T5.1)
- [ ] **T5.3** — `web/components/runs/raw-diff.tsx`: extract the M18 review-panel
  `<pre>` diff block into a shared component (raw text, no highlighting — Phase 2);
  **refactor `review-panel.tsx` to use it** (behavior-preserving; review-panel
  tests stay green — assertion migration). Files: `raw-diff.tsx`, `review-panel.tsx`.
  (no dep)
- [ ] **T5.4** — Workbench diff surface + Tabs: `web/components/workbench/run-diff.tsx`
  (`"use client"`, fetch `GET …/diff`, render `<RawDiff>` + a changed-files list
  from `files`; clicking a file anchors/filters the `<pre>` client-side). Mount in
  the run workbench via a HeroUI `Tabs`: *Files* | *Diff* | *Graph* (`?wb=`
  URL-synced per the data-mgmt page convention), wrapping T3.3's graph section and
  T4.5's file-tree. Tests P5: unit — `diffNameStatus` parse; diff route flow-run
  success + RBAC; `RawDiff` render; `run-diff` render of a seeded diff+files.
  Phase-5 exit gate: typecheck 0 + test:unit + test:integration green. Files:
  `web/components/workbench/run-diff.tsx`, run-detail page, `__tests__`. (depends
  on T5.2, T5.3)
<!-- Commit checkpoint: T5.1–T5.4 -->

### Phase 6 — i18n EN+RU + Playwright e2e + final gate

- [ ] **T6.1** — i18n EN+RU: new `workbench` namespace in `web/messages/en.json`
  + `web/messages/ru.json` — graph (`graph.title`, `graph.empty`,
  `graph.node.<status>`, `graph.currentNode`, `graph.saveError`), file-tree
  (`files.title`, `files.empty`, `files.tooLarge`, `files.binary`,
  `files.loadError`, `files.forbidden`), diff (`diff.title`, `diff.empty`,
  `diff.changedFiles`), tabs (`tab.files|diff|graph`). Mirror the existing
  `run`/`evidence` namespace structure; both locales must have an identical key
  set. Files: `web/messages/en.json`, `web/messages/ru.json`. (depends on T3.3,
  T4.5, T5.4)
- [ ] **T6.2** — Playwright e2e (seeded, authed; dedicated test DB)
  `web/e2e/m22-workbench.spec.ts`: (a) open a seeded run → flow-graph renders, the
  current node is emphasized, node colors match seeded `node_attempts` statuses;
  drag a node (as a `member`) → reload → position persisted; (b) the file-tree
  lists tracked worktree files, expands a dir, opens a file (and shows the
  too-large marker for an oversized tracked fixture); **a `viewer` cannot see the
  Repo files tab / gets 403 on the file route**; a `.git/config` path returns 404;
  a `../` path returns 400; (c) the workbench diff renders the seeded base→branch
  diff + changed-files list; (d) the project `repo` tab lists tracked repo files
  for a member. Confirm the spec is in the e2e project glob. Files:
  `web/e2e/m22-workbench.spec.ts`, seed helpers. (depends on T6.1)
- [ ] **T6.3** — Final gate: `pnpm --filter maister-web typecheck` (0) ·
  `test:unit` · `test:integration` · `test:e2e` (m22 + prior) · root
  `pnpm validate:docs:all` · `npx @redocly/cli lint docs/api/web.openapi.yaml` —
  all green. Roadmap: tick M22 in `.ai-factory/ROADMAP.md` + Completed table (done
  by `/aif-verify`). (depends on T6.1, T6.2)
<!-- Commit checkpoint: T6.1–T6.3 -->

### Final gate
- [ ] `pnpm --filter maister-web typecheck` (0) · `test:unit` · `test:integration`
  · `test:e2e` · `pnpm validate:docs:all` · OpenAPI lint — all green ·
  roadmap M22 ticked (by `/aif-verify`).

---

## Risks / watch-items

- **Live coloring read as polling (ADR #1 review risk).** The debounced
  `…/graph-status` refetch is SSE-triggered, never timed — ADR-052 states so
  explicitly. The e2e asserts no `…/graph-status` traffic after a run goes terminal.
- **File disclosure (Track B top security risk — Codex #1).** Mitigated by
  **tracked-only git plumbing** (`.git`/gitignored/untracked unreachable) +
  **`readRepoFiles` = member** (viewers denied) + `repoRelPathSchema`. T4.1/T4.4
  adversarial coverage (sensitive-path → 404, viewer → 403, traversal → 400) is
  mandatory and non-negotiable.
- **Cross-project layout write (Codex #2).** Closed structurally by `flow_id`
  (per-project) keying; T1.5 proves a project-A member cannot touch project-B
  layout. Watch: any future code that loads/writes layout by `flow_revision_id`
  re-opens the leak — keep all access keyed on `flow_id`.
- **Layout stale node-ids on flow upgrade.** Tolerated by ignore-at-render
  (T3.1); a copy-forward of still-valid node positions on `enableRevision` is a
  later additive option, not needed for Wave-1.
- **Run-page growth.** Graph + Files + Diff are gated behind a `?wb=` HeroUI
  `Tabs` strip (T5.4), not three more always-on stacked panels.
- **Big repos / big files / big diffs.** Listing is lazy-per-level (one `ls-tree`
  dir); blob reads are capped (`MAISTER_WORKBENCH_MAX_FILE_BYTES`); diffs reuse
  the existing `diffRange` truncation guard. No full-tree walk, no unbounded read.
- **SSR + React Flow.** Must use the `{ssr:false}` dynamic-import wrapper or
  hydration breaks.

## Resolved during refinement (Codex adversarial pass, 2026-06-05)

- **R1 — Layout store location & key (was Q1; Codex #2 high).** RESOLVED → a
  separate DB table `flow_graph_layouts` (NOT `flow.yaml`), keyed by **`flow_id`**
  (per-project ⇒ no cross-project write leak; upgrade-stable). Global
  `flow_revision_id` keying rejected (shared across projects = authz leak).
- **R2 — Project flow-graph preview (was Q2).** RESOLVED → **deferred out of
  Wave-1.** Layout editing happens on the run graph (drag persists per `flow_id`);
  the project page gets only the file-tree. Removes the
  `GET /api/projects/[slug]/flows/[flowId]/graph` route (smaller surface). A
  static project preview can reuse `<FlowGraphView editable>` in a later pass.
- **R3 — Project file-tree source (was Q3; Codex #1 high).** RESOLVED → **git
  tracked tree** (`ls-tree`/`cat-file`) of the run branch (workbench) / project
  `main_branch` (project page), NOT the raw working copy.
- **R4 — Hidden/secret paths (was Q4; Codex #1 high).** RESOLVED → tracked-only
  reads exclude `.git`/gitignored (`.env*`)/`node_modules`/untracked **by
  construction**; no denylist. Untracked-file viewing deferred with rationale.
- **R5 — Layout-write RBAC (was Q5; Codex #2 high).** RESOLVED → new
  `editFlowLayout` action = `member`; file reads = new `readRepoFiles` = `member`
  (stricter than `readBoard`). Both are explicit, tunable to `admin` later.
- **R6 — Workbench layout (was Q6).** RESOLVED → HeroUI `Tabs` (`?wb=` URL-synced):
  *Files* | *Diff* | *Graph*.
- **R7 — `confineToRoot` extraction removed.** Track B no longer reads raw `fs`
  (git plumbing only), so the payload-route refactor is dropped (don't refactor
  working code with no consumer — surgical-changes rule).

## Unresolved questions (ответьте кратко)

1. **Номер вехи.** M22 — следующий свободный (M17/M20 открыты, M21 закрыт). Ок,
   единая M22 (Full, три трека), или предпочитаешь разбивку (например A=M22,
   B+C=M23)? План — единая M22.
2. **Доступ к файлам = `member`.** Подтвердить: `readRepoFiles`/`editFlowLayout` =
   `member` ок (просмотрщик-`viewer` НЕ видит файлы и граф-редактирование)? Или
   чтение файлов оставить `viewer` (как доска), а строже только запись layout?
   План (по итогам Codex) — оба `member`; диф остаётся `viewer` (он run-scoped).
