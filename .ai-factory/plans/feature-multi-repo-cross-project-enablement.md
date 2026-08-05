# Multi-repo enablement: cross-project task graph, agent facade reach, read-only sibling context

**Branch:** `claude/eager-nash-8fea98` (no feature branch created — owner chose to stay on the current worktree branch)
**Base:** `main` @ `208764791`
**Created:** 2026-08-05
**Plan id format:** `slug` (owner stayed on the current branch, so branch-based consumers cannot derive this stem — pass the plan path explicitly to `/aif-implement`)

## Settings

| Setting | Value |
| ------- | ----- |
| Method | **SDD → TDD** — Phase 0 produces the executable contract; every implementation task runs RED → GREEN → REFACTOR against it |
| Testing | **yes** — unit + integration (testcontainers PG via `test-support/pg-container.ts`) + e2e where the surface is user-visible |
| Logging | **verbose** — DEBUG on every new cross-project decision point (relation cross check, reach grant/deny, mount resolution), INFO on outcomes, WARN on refusals |
| Docs | **yes** — mandatory documentation checkpoint at completion; Phase 0 is analytics-first (docs are an INPUT, not a trailing sync) |
| Roadmap linkage | yes — see below |

## Method: SDD → TDD

### Spec is the contract (SDD)

Phase 0 is not "write some docs first". It produces the **acceptance contract** that every
later phase is measured against, and it is the only place requirements are authored.

- Every `system-analytics/*.md` this plan touches MUST carry R5's **seven sections in
  order**: Purpose · Domain entities · State machine · Process flows · **Expectations** ·
  Edge cases · Linked artifacts.
- The **Expectations** section is the acceptance checklist (docs/CLAUDE.md R5a). Each
  bullet: one MUST-hold invariant, one sentence, normative phrasing (MUST / NEVER / exactly
  / at most), identifiers **verbatim** (`runs.agent_chain_depth`, `task_relations.project_id`,
  `MaisterError("CONFLICT")`, `MAISTER_MAX_AGENT_CHAIN_DEPTH`) — never paraphrased. ≤ 12
  bullets per file; if a domain needs more, the boundary is wrong.
- **Every Expectations bullet MUST be testable**, and T7b binds each one to the test that
  asserts it. A bullet with no test is an unimplemented requirement; a test with no bullet
  is either a missing requirement or a trivial test.
- **Edge cases** are the named deviations from Expectations, each linked to its
  `MaisterError` code. Do not restate Expectations there.
- Status tags (R6) on every described piece: `(Implemented)` / `(Designed)` / `(Phase 2)`.
  Phase 0 writes `(Designed)`; T36 flips them.

### Tests come first (TDD)

Every implementation task below is written as **RED → GREEN → REFACTOR**. Two hard rules:

1. **RED must be observed, and for the right reason.** Run the new test and read the
   failure before writing implementation. A test that fails on an import error, a missing
   fixture, or a type error is **not** RED — it is broken scaffolding. The expected failure
   is the assertion failing on the behavior under test.
2. **GREEN is minimal, REFACTOR is separate.** Write the least code that turns the test
   green, then refactor under a green suite — SOLID / KISS / DRY applied in the refactor
   step, not smuggled into the GREEN step. Reuse before you add: prefer an existing helper
   (`resolveProjectTaskByNumber`, `removeWorktree`, `guardrail-hooks`' path resolver,
   `test-support/graph-run-seed.ts`) over a parallel implementation.

### Test-quality bar (no trivial tests, minimum overlap)

- **One behavior = one test.** If two tests fail together for the same defect, merge them.
- **Edge cases are derived, not invented** — enumerate them from the Expectations and Edge
  cases sections written in Phase 0. An edge case nobody specified is either a missing
  Expectation (fix Phase 0) or noise (drop it).
- **Banned as trivial:** asserting a constant; re-asserting a zod schema's own built-in
  behavior (that `z.string()` rejects a number); asserting a getter returns what the
  constructor was handed; snapshotting a DTO with no invariant behind it.
- **Required per behavior:** the happy path, every refusal branch named in Expectations, and
  the concurrency/crash window when the Expectation claims one.
- A behavior covered by an integration test does **not** also get a unit test of the same
  assertion — pick the level that owns the invariant.

### The four test runners (a test in the wrong path never runs)

| Runner | Command | `include` globs |
| ------ | ------- | --------------- |
| web unit | `pnpm --filter maister-web test:unit` | `lib/**/*.test.ts` · `lib/**/__tests__/**/*.test.ts` · **`app/**/__tests__/**/*.test.ts`** · `components/**` · `scripts/**` · `test-support/**` · `e2e/**` |
| web integration | `pnpm --filter maister-web test:integration` | `lib/**/*.integration.test.ts` · **`app/**/*.integration.test.ts`** (no `__tests__` needed) · `test-support/**` · `e2e/**` |
| supervisor | `pnpm --filter @maister/supervisor test` | its own `unit` / `integration` projects |
| mcp | `pnpm --filter <mcp-pkg> test` | its own `unit` / `integration` projects |

⚠ An **app-route unit test outside a `__tests__/` directory is never collected** — the unit
project globs `app/**/__tests__/**`, not `app/**`. This is the exact M10 defect the project
rule was written for. Every task that adds a test names its runner, and
`vitest list --project <name>` must show the file before the phase closes.

## Roadmap Linkage

**Milestone:** `M49. Multi-repo task-graph enablement` (**proposed — not yet in `.ai-factory/ROADMAP.md`**)
**Rationale:** none of the open milestones fit. `M45` is core-package process qualification; `M48` is Advanced Evaluation. This work establishes the platform's answer to multi-repo work (`project = repo` stays; decomposition + coordination + read-only context sharing carry the load), so it deserves its own milestone.
**Action:** `/aif-plan` owns plan files only. Adding the `M49` entry to `.ai-factory/ROADMAP.md` is `/aif-roadmap`'s job — run it before `/aif-verify --strict`, or the roadmap gate reports a dangling linkage.

---

## Locked direction (do not reopen)

`project = repo` **stays**. Multi-repo work is served by decomposing it into per-project
tasks coordinated through the task graph, plus read-only context sharing between
sessions. Three independent-but-synergistic features, implemented in this order
(F2 partially builds on F1):

- **F1** — cross-project task relations (lift the Stage-1 same-project restriction)
- **F2** — cross-project agent facade reach (opt-in, write-safe subset, no run ops)
- **F3** — read-only sibling-repo context mounts for `ai_coding` nodes AND platform-agent runs

**Explicit non-goals (rejected — do not design for them):** multi-repo runs/workspaces
(N worktrees per run), coordinated cross-repo promotion, orchestrator cross-project
delegation, meta-project / project-group entity, umbrella / submodule repos, any
platform chat surface or concierge agent (deferred separately), cross-project task moves.

---

## Number reservations (allocate FIRST, renumber LAST)

Per project rule "Plan MUST allocate ADR + migration numbers up front".

| Artifact | Reserved | Source of truth checked |
| -------- | -------- | ----------------------- |
| ADR (F1) | **ADR-155** | `git show main:docs/decisions.md` → max `ADR-154` |
| ADR (F2) | **ADR-156** | ” |
| ADR (F3) | **ADR-157** | ” |
| Migration (F2) | **0123** | `git show main:web/lib/db/migrations/meta/_journal.json` → max `idx` 122 (`0122_agent_memory_files`) |
| Migration (F3) | **0124** | ” |

⚠ Several sibling branches recorded in project memory are FF-merged into **local**
`main` but **unpushed**. The numbers above are read from local `main`'s HEAD, which is
the correct baseline for this worktree. **T34 is a mandatory renumber pass** executed
AFTER rebasing onto the integration target. `pnpm validate:docs` only parses Mermaid —
it does **not** resolve `[ADR-NNN](decisions.md#…)` anchors, so a green docs gate is
**not** evidence of correct numbering.

Each migration is a **TRIPLE**: SQL file + `_journal.json` entry + `meta/<NNNN>_snapshot.json`.
T34 verifies the newest journal entry has a matching snapshot and that `when` values stay
monotonic (a non-monotonic `when` makes `db:migrate` silently skip — see
`.ai-factory` project memory `drizzle-journal-when-skip`).

---

## Verified baseline (code-checked 2026-08-05 — do not re-derive)

### F1

| Fact | Location |
| ---- | -------- |
| Same-project refusal is ONE domain check | `web/lib/social/relations.ts:185-192` |
| Schema already tolerates cross-project rows (FKs → `tasks.id`, uniqueness `(from,kind,to)`) | `web/lib/db/schema.ts:5788-5838` |
| Kinds: `blocks \| depends_on \| parent_of \| requires \| duplicate_of`; gating subset `blocks/depends_on/requires` | `relations.ts:27-43` |
| Cycle BFS is project-scoped (both legs carry `eq(taskRelations.projectId, …)`) | `relations.ts:101-121` |
| Advisory lock is **per-project** | `relations.ts:67-76,198` |
| `getOpenRelationBlockers` is project-agnostic **by construction** (filters only on task ids + kind + counterpart status) — ✅ verified, needs no change | `relations.ts:339-431` |
| `getTaskRelations` / `getTaskRelationsByTaskIds` resolve the counterpart's OWN `projects.task_key` — ✅ already correct cross-project | `relations.ts:446-567` |
| Internal route addresses the target by number-within-slug | `web/app/api/projects/[slug]/tasks/[number]/relations/route.ts:113` |
| Ext route mirrors it; its body enum **omits `requires`** (drift vs the internal route's 5 kinds) | `web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/route.ts:38` |
| MCP facade tools `relation_list / relation_add / relation_remove` proxy the ext route by `toNumber` | `mcp/src/tools.ts:602-641,1304-1330` |
| ⚠ `auto_launch_run_plan` launches with the **candidate task's** projectId; the parent select does not even fetch `runs.projectId` | `web/lib/domain-events/auto-launch.ts:241-248,317-329` |
| ⚠ Abandon cascade walks `parent_of` with no project predicate | `web/lib/queries/run.ts:712-733` (`getUnlaunchedAutoChildTaskIds`) |
| ⚠ Board bakes the **board's** `projectTaskKey` into a child's `keyRef` | `web/lib/queries/board.ts:411-424,445-456` |
| `manageTaskRelations` → min role `member` | `web/lib/authz.ts:57` |
| `projects.task_key` is **platform-unique** (`.notNull().unique()`) — KEY-N is a valid global address | `web/lib/db/schema.ts:181` |

**No other read path filters `task_relations` by `project_id`.** Verified by grepping every
`taskRelations` reference: only `relations.ts`'s BFS carries the predicate. Board /
task-detail / auto-launch / run queries are all task-id-keyed.

### F2

| Fact | Location |
| ---- | -------- |
| Ext cross-project refusal (the seam): `actor.projectId !== null && project.id !== actor.projectId` → 404 (existence-hidden) | `web/lib/tokens/ext-handler.ts:255-274` (slug arm), `:358-377` (`resolveProjectId` arm) |
| NULL-project **user** tokens already get a per-request RBAC re-check | `ext-handler.ts:276-328, 379-431` |
| Scope → project-action map (unmapped write scope silently resolves to viewer-level `readBoard`) | `ext-handler.ts:84-116` |
| Agent tokens are per-launch, single-project, name `agent-run:<runId>` | `web/lib/agents/tokens.ts:63-92` |
| `AGENT_TOKEN_SCOPES` — **`tasks:create` is NOT in it** | `web/types/token-scopes.ts:61-84` |
| `agent_project_links` per-link axes precedent (`canReadBrain`, `canWriteBrain`, `memoryEnabled`), unique `(agent_id, project_id)` | `web/lib/db/schema.ts:923-977` |
| `domain_events.actor_type` supports `'agent'` — the hop-budget provenance already exists | `web/lib/db/schema.ts` (`domain_events`, `actor_type` enum + CHECK) |
| Attach UI + edit modal | `web/components/board/panels/agents-attach-panel.tsx`, `…/agents-attach-edit-modal.tsx` |
| Attach route | `web/app/api/projects/[slug]/agents/[agentId]/route.ts` |

**Consequence (important, shapes F2's scope):** because `tasks:create` is absent from
`AGENT_TOKEN_SCOPES`, an agent cannot create a task in *any* project today. The
cross-project write-safe subset therefore cannot include task creation. F2 v1 delivers
**read + comment + relate** across projects; creating the sibling task stays a human or
orchestrator act. This is stated as a contract, not a gap to paper over.

### F3

| Fact | Location |
| ---- | -------- |
| `addDetachedWorktree({projectRepoPath, worktreePath, committish})` is fully parameterized — reusable against a sibling repo unchanged | `web/lib/worktree.ts:272-330` |
| `resolveWorkspaceRefCommittish` (literal ref \| `trigger`) | `web/lib/agents/launch.ts:668-…` |
| Ephemeral `-ro` checkout path + its terminal removal + GC backstop | `launch.ts:653-658,3204-3241,2377-2416`; `web/lib/gc/ephemeral-agent-gc.ts` |
| Prompt-confinement allow-set = `worktreePath ∪ runDir ∪ repoPath` (or `confineRoot` alone) | `supervisor/src/prompt-confinement.ts:14-27,66-77`; roots assembled at `supervisor/src/http-api.ts:611-614` where **`runDir = dirname(logPath)`** |
| Flow `ai_coding` sessions send **no** `repoPath` → their allow-set is `worktreePath ∪ runDir` | `web/lib/flows/runner-agent.ts:840-855` |
| ACP child env: `process.env` ∪ ccrLayer ∪ `executor.env` ∪ `MAISTER_CAPABILITY_PROFILE_PATH` ∪ `adapterLaunch.env` — **`MAISTER_CAPABILITY_PROFILE_PATH` is the precedent for a first-class request→env field** | `supervisor/src/spawn.ts:107-120` |
| ADR-154's `MAISTER_FLOW_DIR` is a **cli/check child** env var, **not** an ACP-session var | `web/lib/flows/runner-cli.ts:257-261`; `web/lib/flows/graph/runner-graph.ts:1500-1502` |
| Guardrail-hook `pathGuard` **is** enforced inside the live permission handler (not accept-and-ignore) | `supervisor/src/acp-client.ts:579-630`; `supervisor/src/guardrail-hooks.ts:200-240` |
| Engine version + floor pattern | `web/lib/flows/engine-version.ts:61` (`MAISTER_ENGINE_VERSION = "3.3.0"`); floors + gates in `web/lib/config.ts:510-530,1064-1230` |
| Workspace reconciler scans **only** `worktreesRoot()/<slug>/<entry>` (exactly 2 segments) and quarantines anything without matching v2 provenance | `web/lib/gc/workspace-reconciler.ts:138-147,219-325,404-438,1079-1089` |

**★ Trap resolved by design:** the memory note "the sibling project's workspace
reconciler must not treat foreign context checkouts as stray worktrees" is satisfied by
placing mounts under the **run dir** (`.maister/<slug>/runs/<runId>/context/<sibling>/`),
which is outside `worktreesRoot()` and therefore never enters `listCandidates()`.
Placing them under `worktreesRoot()` would guarantee a `quarantined:untrusted_candidate`
finding, because `loadTrustedProject` requires
`project.repoPath === provenance.parentRepoPath` and a sibling mount's parent repo is by
definition a *different* project's repo. The run dir also sits inside the existing
prompt-confinement allow-set, so no supervisor confinement change is required.

---

## Design decisions

### D1 — F1 advisory lock: ONE platform-wide lock, not sorted per-project pairs

The request specifies "take the per-project locks of BOTH endpoint projects in canonical
(sorted) order". **That is insufficient and I am deviating deliberately.**

Counterexample (4-cycle across 4 projects `A→B→C→D→A`): edges `AB` and `CD` lock disjoint
project sets and run concurrently; neither closes a cycle alone. Then edges `BC` and `DA`
also lock disjoint sets `{B,C}` and `{D,A}` and run concurrently. `BC`'s BFS asks "can C
reach B?" — the path needs `D→A`, uncommitted. `DA`'s BFS asks "can A reach D?" — the path
needs `B→C`, uncommitted. Both commit; a 4-cycle now exists and every gated task in it is
permanently blocked. Pairwise locking only serializes cycles of length ≤ 3 (where every
edge pair shares an endpoint project).

**Decision:** replace `takeProjectRelationLock(tx, projectId)` with a single
`takeGatingRelationLock(tx)` — `pg_advisory_xact_lock(RELATION_LOCK_NAMESPACE, 0)` — taken
for **every** gating-kind insert, same-project or not. Relation creation is human/agent
paced (order 1/min at the busiest), so platform-wide serialization of a sub-millisecond
BFS is free. Correctness beats a throughput optimization nobody needs. Same-project
inserts get *strictly stronger* serialization than today.

### D2 — F1 BFS becomes platform-global and bounded

Dropping the `project_id` predicate makes the gating graph platform-wide. Add a hard
traversal bound (`GATING_BFS_MAX_NODES`, default 5000) and, on exceeding it, refuse with
`CONFLICT` + WARN. Refusing is the *safe* direction for a cycle check (a false refusal is
visible and recoverable; a missed cycle is a permanent deadlock).

### D3 — F1 row ownership + RBAC

`task_relations.project_id` = the **from-task's** project (already the case). The domain
layer changes from "both ends must equal `input.projectId`" to "**the from-end** must
equal `input.projectId`; the to-end may differ". Creating a cross-project relation
requires `manageTaskRelations` on **both** projects:

- Internal route: `requireProjectAction(from.project.id, "manageTaskRelations")` **and**
  `requireProjectAction(to.project.id, "manageTaskRelations")`.
- Ext route: `handleExt` authorizes the URL-param project; the **target** project needs an
  explicit second authorization. A **project-bound** token has no authority outside its
  project → cross-project targets are **refused** for project-bound user/project tokens.
  Only NULL-project user tokens (RBAC re-checked on both ends) and F2 reach-granted agent
  tokens may cross.

### D4 — F1 KEY-N addressing

Add `toTaskKey` (e.g. `"API-42"`) as a mutually-exclusive alternative to `toNumber` on the
relation-mutation bodies.

**Identifier trust table** (required by project rule):

| Field | Label | Gate |
| ----- | ----- | ---- |
| `slug` (internal) / `slug` (ext) | `url-param` | route shape + project lookup |
| `number` (internal) / `taskId` (ext) | `url-param` | resolved strictly within the URL project |
| `toNumber` | `body-controlled` | resolved strictly within the URL project — cross-project reach impossible (unchanged) |
| `kind` | `body-controlled` | enum-validated; **now the same 5 kinds on every surface** — see D4b |
| **`toTaskKey`** | **`body-controlled`, names a cross-resource locator** | resolved against the globally-unique `projects.task_key`, then **`manageTaskRelations` re-checked on the resolved target project**; a caller without it gets the project's normal refusal shape. Existence is not hidden here (unlike ext project 404s) because the caller supplied a global key and the refusal must be actionable — this asymmetry is recorded in ADR-155. |
| token / session actor | `auth-context` | trusted |

### D4b — F1 kind-set parity: `requires` lands on ext + MCP (owner decision, 2026-08-05)

`opBodySchema` in the ext route is shared by **POST and DELETE**, so today's missing
`requires` is not "cannot create" — it is **"cannot remove"**. A `requires` edge minted by
the orchestrator's `run_plan` is visible through `relation_list` but unremovable over
ext/MCP. That is a functional hole, and it is the more dangerous half: `requires` is
success-gated and does **not** release on `Abandoned`/`Failed`, so a wrong edge blocks
forever.

**Decision:** all five kinds on every surface — internal route, ext route (POST and
DELETE), MCP `relation_add` / `relation_remove`. Rejected the "DELETE-only" middle: two
different enums on one route is added surface for a boundary that is porous anyway (agents
already hold `relations:create` and can mint the gating `blocks` / `depends_on`).

**Accepted risk + its mitigation, recorded in ADR-155:** `requires` never releases on a
failed dependency, so a liberal agent can wedge a board. The mitigation is *visibility*,
not a schema restriction — the `blocked` chip already names the blocker's `KEY-N`, and a
human removes the relation from the board. The `blocked` chip must therefore stay
actionable; this becomes a stated contract, not an implementation detail.

### D5 — F1 cross-project **cascade** gates (the asymmetry class)

Relations may cross projects; **automation driven by them may not**. Three sites gate to
same-project candidates with a WARN:

1. `auto_launch_run_plan` (`web/lib/domain-events/auto-launch.ts`) — add `projectId` to the
   parent-run select, skip candidates whose `projectId` differs.
2. `getUnlaunchedAutoChildTaskIds` (`web/lib/queries/run.ts`) — an abandon cascade in
   project A must not mark tasks Abandoned in project B.
3. Board decomposition `keyRef` (`web/lib/queries/board.ts`) — join the child's own project
   and render the child's own `KEY-N` + slug, or the card links to the wrong board.

Cross-project orchestrator DAGs are explicitly out of scope (rejected non-goal).

### D6 — F2 grant model

Reuse the existing attachment as the grant, per the recorded owner decision: an agent
token minted for project **A** may act in project **B** iff the agent has an **enabled**
`agent_project_links` row in **B** whose new `cross_project_reach` flag is `true`.
No new table; the owner's per-project attach confirmation is already the consent event.

**Write-safe subset** (`CROSS_PROJECT_AGENT_SCOPES`), intersected with the token's actual
scopes at check time:

```
tasks:read · tasks:create · comments:read · comments:create ·
relations:read · relations:create · relations:delete
```

Deliberately **excluded**: every run op (`runs:*` — never in `AGENT_TOKEN_SCOPES` anyway),
`tasks:update`, `tasks:triage` (mutating a sibling's *existing* task content/triage from
outside), `hitl:request` (would create HITL in a project whose humans did not opt in),
`flows:read` / `runners:read` (catalog disclosure), `memory:*` and `agent_memory:write`
(project-scoped knowledge stores).

### D6b — `tasks:create` joins `AGENT_TOKEN_SCOPES` (owner decision, 2026-08-05)

Agents hold no `tasks:create` today, in **any** project. The owner confirmed it is needed.
Per the project rule "an *agent gains an op* change moves the route scope + scope→action map
+ `AGENT_TOKEN_SCOPES` grant list together": the route
(`POST /api/v1/ext/projects/[slug]/tasks`, `scopeLabel: "tasks:create"`) and the mapping
(`PROJECT_ACTION_BY_SCOPE["tasks:create"] = "createTask"`) **already exist** — only the
grant list changes. Verify all three at implementation time; do not assume.

⚠ **This is a same-project privilege expansion, not just a cross-project one.** Every agent
in every project gains task creation the moment the grant lands. That is the owner's
decision, and it is what forces D7 below to widen.

**Launch-precondition carry-back:** a task created by an agent with no `flowId` is a
flowless simple-intent task — `unconfigured` until triage fills the flow. That is the
existing ADR-112 path and needs no new work, but the ADR must say so, or "the agent created
a task that will not launch" reads as a defect.

### D7 — Loop containment: agent chain depth (widened by D6b)

Two hazards, one mechanism:

1. **Cross-project ping-pong** — an A-agent acts in B → the B-side domain event triggers a
   B-agent → it acts in A → …
2. **Same-project ping-pong (new, caused by D6b)** — agent A creates a task → `task.created`
   → triggers agent B → creates a task → triggers A → … Existing self-exclusion covers only
   an agent's **own** events, so an A↔B pair loops freely.

The original design's `cross_project_hops` only closes (1). Closing (2) as well costs
nothing extra — same column, same increment, one more enforcement point.

**Decision:** `runs.agent_chain_depth integer NOT NULL DEFAULT 0`, snapshotted at launch.
An agent run launched from a domain event whose `actor_type = 'agent'` inherits
`parentDepth + 1`; every other trigger source (manual, cron, webhook, flow-node binding)
seeds `0`. Enforced at **two** points against
`MAISTER_MAX_AGENT_CHAIN_DEPTH` (default **2**, owner decision):

| Enforcement point | On breach |
| ----------------- | --------- |
| Cross-project reach check (`canAgentReachProject`) | deny → existence-hidden 404, audited, WARN with `reason: "chain_depth_exhausted"` |
| Agent launch from an agent-authored domain event | refuse the launch, WARN, skip the candidate — never throw (the consumer's idempotent contract) |

Both reuse `domain_events.actor_type`, which already carries `'agent'`.

### D8 — F3 declaration surfaces

- **Flow nodes `ai_coding`, `judge`, `orchestrator`** (owner decision, 2026-08-05 — all
  three already dispatch to the same ACP-session arm in
  `runner-graph.ts`, so the marginal cost is three zod schemas instead of one):
  ```yaml
  settings:
    context_repos:
      - project: other-service      # project SLUG, resolved at launch
        ref: main                    # optional; default = that project's default branch
  ```
  Engine floor `CONTEXT_REPOS_ENGINE_MIN = "3.4.0"`; `MAISTER_ENGINE_VERSION` bumps
  `3.3.0 → 3.4.0`. Load-time gate mirrors the ADR-154 `MAISTER_FLOW_DIR` floor gate.
  `cli` / `check` nodes are **excluded** — they are not ACP sessions; see D8b.
- **Platform agent:** `agent_project_links.context_repos jsonb` — the **attachment** is the
  config point (an owner confirms per project). The definition's
  `recommended.context_repos` is **prefill only** — package slugs are not portable across
  installations, so a definition can never bind a real project by itself.

### D8b — `MAISTER_CONTEXT_REPOS` is JSON (owner decision, 2026-08-05)

```
MAISTER_CONTEXT_REPOS=[{"slug":"api","path":"/abs/mount","ref":"main","commit":"<sha40>"}]
```

A `:`-joined path list would have been shell-cheaper, but it throws away exactly the two
fields a consumer wants: the **slug** (to say *which* sibling a path is) and the resolved
**commit** (to record what was actually read). JSON keeps the payload self-describing and
matches how every other structured MAIster payload travels. Cost: a shell consumer needs
`jq`. Accepted — the primary consumer is the agent, which reads the prompt preamble anyway.

⚠ **The var does NOT reach `cli` / `check` children.** ADR-153 gives those an allow-listed
env; `MAISTER_CONTEXT_REPOS` is deliberately not on that list, matching D8's node-type
exclusion. If a packaged script ever needs sibling paths, that is a separate ADR-153
allow-list change — not something to slip in here.

### D9 — F3 materialization + lifecycle

- Mount path: `<runDir>/context/<siblingSlug>/` where `runDir =
  .maister/<consuming-slug>/runs/<runId>/`. Outside `worktreesRoot()` (reconciler-safe),
  inside the prompt-confinement allow-set (no supervisor confinement change).
- Created via `addDetachedWorktree({projectRepoPath: sibling.repoPath, worktreePath, committish})`.
- **Persist the launch-time decision the terminal path reads** (project rule):
  `runs.context_mounts jsonb` snapshots `[{projectId, slug, repoPath, mountPath, committish}]`
  at spawn. Terminal cleanup and crash recovery read the snapshot, never re-derive from a
  manifest/link that can drift after launch.
- Removal at the terminal choke via `removeWorktree({projectRepoPath: sibling.repoPath, …})`
  **plus** a GC backstop sweep (extends the `system_sweep` family) that reaps mounts whose
  owning run is terminal/absent and runs `git worktree prune` on touched sibling repos.
  Without the sibling-side removal, the sibling repo accumulates stale worktree
  registrations.
- **Ordering:** git side-effects happen BEFORE the durable status write; the snapshot is
  written in the same transaction as the run insert. A crash between mount creation and
  the snapshot leaves an orphan the GC backstop reaps by path shape — this residual window
  is documented in ADR-157.

### D10 — F3 read-only enforcement (three layers, honest about each)

| Layer | Mechanism | Covers |
| ----- | --------- | ------ |
| **L1** | existing `readOnlySession` | `none` / `repo_read` agent runs only — a writable-worktree session cannot use it (a session-wide read-only would break the run's own work) |
| **L2** | supervisor-side **unconditional** path guard denying write-class tool calls resolving under any declared mount root, threaded on the session request alongside `hooksConfig` and evaluated in the same permission handler (`acp-client.ts:579-630`) | every session with mounts, writable or not |
| **L3** | terminal dirty-check per mount (`git status --porcelain`) → WARN + quarantine evidence | detects any bypass; the mount is discarded regardless (detached, no branch) |

L3 matters even though mounts are ephemeral: `git worktree add --detach` writes a `.git`
*file* pointing into the **sibling's** `.git/worktrees/<name>`, so an escaped write could
touch the sibling repo's metadata. ADR-041 is untouched.

### D11 — F3 consent

Owner decision stands: **no donor-side consent flag in v1** (single-owner installations;
the launcher's read-RBAC suffices). Concretely:

- Flow node launch: the launching user must hold `readRepoFiles` on each sibling project;
  a missing grant refuses the launch with `PRECONDITION` naming the project.
- Agent run: there is no launching user, so the **attach-time** admin action is the consent
  event — `context_repos` is written by a project admin who is separately authorized on the
  sibling (checked at write time on the attach route, not at launch).

---

## Deployment touchpoints

Per project rule "Plan MUST enumerate deployment touchpoints". Every new env var lands in
`.env.example` **and** the consuming service's `environment:` block.

| New env var | Read by | Files T33 must touch |
| ----------- | ------- | -------------------- |
| `MAISTER_MAX_AGENT_CHAIN_DEPTH` (default `2`) | web | `.env.example`, `compose.yml` (web), prod overlay if present, `docs/configuration.md` env-vars **table** |
| `MAISTER_CONTEXT_MOUNT_ENABLED` (default `true`; kill-switch) | web | same |
| `MAISTER_CONTEXT_REPOS` (**derived JSON**, injected into the ACP child only — never into `cli`/`check` children, D8b) | supervisor → adapter | `supervisor/src/spawn.ts` `buildChildEnv`, `supervisor/src/types.ts` request schema, `docs/supervisor.md`, `docs/configuration.md` |

No new bound port, no new sidecar, no new host-mounted file.

## Contract surfaces → spec files

Per project rule "Plan MUST trace every contract surface to its spec file".

| Surface | Spec file(s) |
| ------- | ------------ |
| `POST/DELETE /api/projects/[slug]/tasks/[number]/relations` — new `toTaskKey` body field, new 403 arm | `docs/api/web.openapi.yaml` + `docs/system-analytics/social-board.md` |
| `POST/DELETE /api/v1/ext/projects/[slug]/tasks/[taskId]/relations` — same, plus the `requires` kind | **`docs/api/external/operations.openapi.yaml`** + `docs/system-analytics/external-operations.md` |
| MCP `relation_add` / `relation_remove` input schema gains `toTaskKey` **and the `requires` kind** (D4b) | `mcp/src/tools.ts` + `docs/system-analytics/external-operations.md` (MCP tool table) |
| `AGENT_TOKEN_SCOPES` gains `tasks:create` (D6b) — an agent-gains-an-op change | `web/types/token-scopes.ts` + `docs/system-analytics/{identity-access,agents,external-operations}.md` |
| `PATCH /api/projects/[slug]/agents/[agentId]` — `crossProjectReach`, `contextRepos` | `docs/api/web.openapi.yaml` + `docs/system-analytics/agents.md` |
| Supervisor `POST /sessions` — new `contextMounts[]` request field | `docs/api/supervisor.openapi.yaml` + `docs/supervisor.md` |
| Flow DSL `settings.context_repos` + engine floor `3.4.0` | `docs/flow-dsl.md` + `web/lib/config.schema.ts` + `web/lib/flows/flow-dsl-grammar.ts` (in-code SSOT shipped to agents — and its drift-guard test) + `docs/system-analytics/flow-settings.md` |
| New columns `agent_project_links.cross_project_reach`, `agent_project_links.context_repos`, `runs.agent_chain_depth`, `runs.context_mounts` | **five places, verified by grep — see the DB-surface note below** |
| New env vars | `docs/configuration.md` env-vars **table** (the canonical one, not prose) + `.env.example` |
| Token scope subset `CROSS_PROJECT_AGENT_SCOPES` | `docs/system-analytics/identity-access.md` + `docs/system-analytics/agents.md` |

No new `MaisterError` code is introduced — reuses `CONFIG`, `PRECONDITION`, `CONFLICT`,
`UNAUTHORIZED`. If implementation finds a case none of them fit, that is a
`docs/error-taxonomy.md` change and belongs in Phase 0, not mid-implementation.

**No new AsyncAPI surface.** F1/F2/F3 add no `domain_events` kind, no SSE event, and no
webhook envelope field. The 11-kind taxonomy is unchanged. Stated explicitly so the
implementer does not hunt for an event spec to update. (T21a *populates an existing
column* on existing kinds — that is not a wire change.)

### DB-surface note — a new column lands in FIVE places

The project rule says "the narrative table and the ERD diagram are two separate artifacts";
in this repo it is worse than two. For each new column:

| # | Artifact | Shape |
| - | -------- | ----- |
| 1 | `docs/database-schema.md` — schema block | the Drizzle-shaped listing for the table |
| 2 | `docs/database-schema.md` — per-migration changelog | the `- \`table\` += \`column\` (type NOT NULL DEFAULT …) — why` entries near the file's tail |
| 3 | `docs/db/agents-domain.md` (for `agent_project_links`) | `erDiagram` **attribute block**; match the existing style exactly: `boolean can_read_brain "NOT NULL DEFAULT false — gates memory recall (ADR-122, 0088)"` |
| 4 | `docs/db/runs-domain.md` (for `runs`, and `task_relations` lives here too) | same attribute-block style: `text agent_workspace "M34: none\|repo_read\|worktree (migration 0052) …"` |
| 5 | `docs/db/erd.md` | the consolidated view **and** its constraint/index tables |

⚠ `docs/db/brain-domain.md` **also renders `agent_project_links`** — check it whenever that
table changes. Grep the column name across `docs/` and expect a hit in every place above
before calling the task done.

### Contract validation gates

| Gate | Command | Covers |
| ---- | ------- | ------ |
| Mermaid + ADR anchors | `pnpm validate:docs` | every changed `docs/**/*.md` Mermaid block; `[ADR-NNN](decisions.md#…)` anchor resolution |
| **API contracts** | **`pnpm validate:contracts`** | all three OpenAPI files (`web`, `supervisor`, **`external/operations`**) + all four AsyncAPI files + adapter mirrors. **The plan's original gate list omitted this** — a broken `$ref` passed every other check |
| OpenAPI lint | `npx @redocly/cli lint <file>` | docs/CLAUDE.md R3: zero errors, warnings reviewed |

---

## Tasks

### Phase 0 — Analytics & contracts (docs-first; NO code)

Exit criteria: every artifact below is complete and internally consistent, with
`Implemented / Designed / Phase 2` status tags per `docs/CLAUDE.md` R6, so Phases 1-8 can
follow them as the single source of truth.

- [x] **T1 — Write ADR-155 (cross-project task relations).**
  `docs/decisions.md`. Write the `### ADR-155` header FIRST (a cited ADR with no header at
  HEAD is a build break). Record: the lifted Stage-1 restriction and which ADR-078 D4
  clause it supersedes; **D1** (one platform-wide gating lock) *including the 4-cycle
  counterexample* — this is the load-bearing rationale and a future reader will otherwise
  "optimize" it back to per-project locks; **D2** bounded BFS; **D3** row ownership + dual
  RBAC; **D4** the `toTaskKey` identifier-trust row and the deliberate
  existence-disclosure asymmetry vs ext project 404s; **D4b** kind parity + the accepted
  `requires` wedge risk with visibility as its only mitigation; **D5** the three cascade
  gates and why relations may cross while automation may not.
  **Also record the F1 one-way door explicitly:** unlike F2 (`cross_project_reach` defaults
  false) and F3 (`MAISTER_CONTEXT_MOUNT_ENABLED`), **F1 ships no kill switch**. Once
  cross-project rows exist, reverting the code restores a project-scoped BFS that cannot
  see them — cycles across projects would go undetected while the rows keep gating. Rolling
  F1 back therefore means deleting the cross-project rows first. Accepted; must be written
  down, not discovered.
  Verify: `### ADR-155` present; every later task's ADR citation resolves.

- [x] **T2 — Write ADR-156 (cross-project agent facade reach).**
  `docs/decisions.md`. Record **D6** (attachment-as-grant; why no new table), the exact
  `CROSS_PROJECT_AGENT_SCOPES` list **and the exclusion rationale per scope**, the
  **D6b** the `tasks:create` grant (naming it a same-project expansion, and that a flowless
  agent-created task is the existing ADR-112 `unconfigured` path — not a defect), **D7** the
  agent chain depth with **both** mutual-triggering scenarios it kills and both enforcement
  points, and the audit shape (`agent:<id>` identity, target project on the audit row).

- [x] **T3 — Write ADR-157 (read-only sibling context mounts).**
  `docs/decisions.md`. Record **D8** declaration surfaces and why the definition carries
  only `recommended` prefill; **D9** mount path choice *with the reconciler-quarantine
  reasoning* (`worktreesRoot()` 2-segment scan + `parentRepoPath` provenance mismatch) and
  the `runs.context_mounts` launch snapshot; **D10** the three enforcement layers with an
  explicit statement that L1 is unavailable to writable-worktree sessions; **D11** consent;
  and the accepted residual crash window (mount created, snapshot not yet committed).

- [x] **T4 — Update `docs/system-analytics/social-board.md` for cross-project relations.**
  Sections: Domain entities (row ownership), Process flows (create with `toTaskKey`),
  Expectations, Edge cases. Enumerate **every** refusal row exactly as the code will gate
  it — allow-list form, since that is how it will be implemented. Fold in the known doc
  drift: `docs/system-analytics/tasks.md:48` lists 3 relation kinds where the code has 5.

- [x] **T5 — Update `docs/system-analytics/agents.md` + `identity-access.md` for F2.**
  New per-link axis, the scope subset table, the `tasks:create` grant, the agent chain
  depth (both enforcement points), and the audit contract.

- [x] **T6 — Write the F3 sections: `docs/system-analytics/flow-settings.md`, `agents.md`, `workspaces.md`, `reconciliation-gc.md`.**
  Mount lifecycle state machine (declare → resolve → mount → use → terminal remove → GC
  backstop), the enforcement layer table, and — in `reconciliation-gc.md` — an explicit
  statement that context mounts are **out of the workspace reconciler's scan scope by
  path**, so a future move under `worktreesRoot()` is a known-breaking change.

- [x] **T7 — Update the API/DSL specs and the DB surfaces.**
  - OpenAPI: `docs/api/web.openapi.yaml` (internal relations route + the agent attach
    PATCH), **`docs/api/external/operations.openapi.yaml`** (the ext relations route — note
    this is OUR ext surface; `docs/api/external/README.md` + `acp.asyncapi.yaml` are the
    third-party ones), `docs/api/supervisor.openapi.yaml` (`contextMounts[]` on
    `POST /sessions`). Paths, bodies, status codes, **example payloads**, and the new
    refusal statuses (403 on a project-bound token crossing projects).
  - `docs/flow-dsl.md`: `settings.context_repos` on `ai_coding` / `judge` / `orchestrator`
    + the 3.4.0 floor.
  - **DB: all five places** per the DB-surface note above, for every column in migrations
    0123/0124, with types and defaults. Check `docs/db/brain-domain.md` too.
  - **No AsyncAPI file changes** — assert this by diffing `docs/api/async/` at the end of
    the phase; a change there means a wire surface was added that this plan did not design.
  Verify: `pnpm validate:docs` **and** `pnpm validate:contracts` green (T7a owns the gate);
  `grep -rn "cross_project_reach\|agent_chain_depth\|context_repos\|context_mounts" docs/`
  hits every one of the five places.

- [x] **T7a — Wire the contract-validation gate into the plan's definition of done.**
  `pnpm validate:contracts` (three OpenAPI + four AsyncAPI + adapter mirrors) is a gate this
  plan originally omitted; `pnpm validate:docs` does not validate API specs at all.
  - Run it at the end of Phase 0 and again in T36; record both in the phase exit criteria.
  - Run `npx @redocly/cli lint` on each of the three OpenAPI files touched (R3: zero errors,
    warnings reviewed).
  - If `validate-contracts.mjs` rejects something the spec genuinely needs (it refuses
    external `$ref`s), fix the spec — never weaken the validator.
  **This task is a gate, not a doc:** its deliverable is a green run recorded in the phase
  exit, plus the command added to T36's verify list.

- [x] **T7b — Build the spec → test traceability matrix.**
  Append a `## Traceability` table to this plan file mapping **every** Expectations bullet
  written in T4/T5/T6 to the test that will assert it:

  | Expectation (verbatim bullet) | Doc | Asserting test | Task |
  | ----------------------------- | --- | -------------- | ---- |

  Rules: every bullet gets exactly one owning test (an extra test asserting the same bullet
  is the overlap the test-quality bar forbids); a bullet with no test means the requirement
  is unimplemented — either add the test or delete the bullet in T4/T6; a planned test with
  no bullet means either a missing Expectation (go back to Phase 0) or a trivial test (drop
  it). The matrix is the artifact `/aif-verify` re-derives from the diff.
  **Phase 0 cannot exit with an unmapped row in either direction.**

**Phase 0 exit:** all nine artifacts complete + internally consistent (R5 seven-section
order, R5a Expectations rules, R6 status tags); `pnpm validate:docs` green;
`pnpm validate:contracts` green; ADR anchors resolve; the T7b matrix has no unmapped row in
either direction.

---

### Phase 1 — F1 domain layer

> **RED first.** T10 is written and observed failing **before** T8/T9 are implemented.
> The task order below is presentational; the execution order is T10(RED) → T8/T9(GREEN) →
> T10 re-run → refactor.

- [x] **T8 — Lift the same-project refusal + switch to the platform-wide gating lock.**
  *(GREEN step for the T10 cases marked `domain`.)*
  `web/lib/social/relations.ts`.
  - Replace the `from.projectId !== input.projectId || to.projectId !== input.projectId`
    refusal (`:185-192`) with a from-end-only assertion; the to-end may differ.
  - Replace `takeProjectRelationLock(tx, projectId)` with `takeGatingRelationLock(tx)`
    (`pg_advisory_xact_lock(RELATION_LOCK_NAMESPACE, 0)`), keeping the namespace constant
    so the lock space stays disjoint from the scheduler. Delete the now-unused
    project-lock helper (an orphan **my** change creates).
  - Drop `eq(taskRelations.projectId, projectId)` from both BFS legs (`:106,:117`).
  - Add `GATING_BFS_MAX_NODES` (5000) — on exceed, WARN + throw `CONFLICT`
    ("gating graph too large to verify").
  - `removeTaskRelation` needs no cross-project change (it deletes by the
    `(from, kind, to)` triple) — confirm and leave alone.
  **Logging (verbose):** DEBUG `{fromProjectId, toProjectId, crossProject, kind}` before the
  cycle check; DEBUG `{visited, frontierRounds}` after a passing BFS; WARN on cycle refusal
  and on the node-cap refusal (both already log — extend the payload with both project ids).

- [x] **T9 — Add the KEY-N resolver.**
  New `resolveTaskByKeyRef(keyRef: string, db?): Promise<ResolvedProjectTask | null>` in
  `web/lib/social/task-lookup.ts`. Parse `^([A-Za-z][A-Za-z0-9]*)-(\d+)$`, uppercase the
  key, join `projects.task_key` + `tasks.number`. Return the existing
  `ResolvedProjectTask` shape (it already carries `project.slug` / `taskKey` /
  `archivedAt`). Malformed input → `null`, never a throw.
  **Logging:** DEBUG `{keyRef, resolved: boolean}`.

- [x] **T10 — RED: domain-layer tests, written and failing before T8/T9 exist.**
  Extend `web/lib/social/__tests__/relations-cycle.integration.test.ts` and
  `social-domain.integration.test.ts`.
  **Runner:** web integration (`lib/**/*.integration.test.ts` — both files are already in
  the glob; confirm with `vitest list --project integration`).
  Cases, one behavior each, all derived from the `social-board.md` Expectations bullets:
  - cross-project `blocks` created and readable from both ends *(domain)*
  - cross-project 2-cycle refused `CONFLICT` *(domain)*
  - **cross-project 4-cycle across 4 projects refused under concurrent inserts** — the D1
    regression: two concurrent transactions inserting `BC` and `DA` over committed
    `AB`/`CD`; assert exactly one commits and the other gets `CONFLICT`. **This is the test
    that proves the platform-wide lock; it must be RED against per-project locks** *(domain)*
  - BFS node-cap refusal at `GATING_BFS_MAX_NODES` *(domain)*
  - `getOpenRelationBlockers` returns a cross-project blocker carrying the **counterpart's**
    `task_key` *(domain — asserts today's behavior is already correct; keep it, it is the
    regression guard for the BFS change, not a trivial test)*
  - `requires` stays success-gated cross-project: an `Abandoned` dependency keeps the
    dependent blocked *(domain)*
  - `resolveTaskByKeyRef`: happy · malformed (`"nope"`) · unknown key · unknown number
    *(unit — `lib/**/*.test.ts`)*
  **RED verification:** run before implementing and confirm each fails on its **assertion**,
  not on a missing export. A `resolveTaskByKeyRef` that does not exist yet fails at import —
  stub it returning `null` first so the RED is honest.
  **Assertion migration in scope:** the existing "relations are same-project only in Stage 1"
  assertion in `social-domain.integration.test.ts` asserts the **removed** refusal — migrate
  it to assert the new from-end assertion. `grep -rn "same-project only" web/` must return
  zero test hits before the phase closes.

**Phase 1 exit:** every T10 case GREEN; full suite green
(`pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration`);
`vitest list` shows every new file; refactor pass done under a green suite.

---

### Phase 2 — F1 API + MCP surfaces

- [x] **T11 — Internal relations route: `toTaskKey` + dual RBAC.**
  `web/app/api/projects/[slug]/tasks/[number]/relations/route.ts`.
  - Body: `toNumber` XOR `toTaskKey` (zod `.refine` — exactly one; both or neither → 400
    `CONFIG`). Keep `.strict()`.
  - `toTaskKey` path: `resolveTaskByKeyRef` → 404 if unresolved or the project is archived.
  - `requireProjectAction(to.project.id, "manageTaskRelations")` in **addition** to the
    from-end check, for the cross-project case.
  - Update the stale route comment at `:17-19` ("cross-project reach is impossible by
    construction") — it is now false and would mislead the next reader.
  **Identifiers sub-bullet:** `slug`=url-param · `number`=url-param · `toNumber`=body-controlled
  (project-confined) · `toTaskKey`=body-controlled, cross-resource → gated by target-project
  `manageTaskRelations` · actor=auth-context.
  **Logging:** INFO on mutation now carries `{fromProjectId, toProjectId, crossProject}`.

- [x] **T12 — Ext relations route: `toTaskKey`, dual authorization, project-bound refusal.**
  `web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/route.ts`.
  - Same XOR body change.
  - Cross-project target + **project-bound** token (`actor.projectId !== null`, not
    reach-granted) → **403 `UNAUTHORIZED`** with an audited row. Cross-project target +
    NULL-project user token → `requireProjectActionForUser(ownerUserId, targetProjectId,
    "manageTaskRelations")`.
  - **Add `requires` to `opBodySchema:38`** (D4b) so all five kinds exist on every surface.
    The schema is shared by POST and DELETE, so this closes the *unremovable orchestrator
    edge* hole as well as opening creation. Comment the success-gated semantics inline
    (never releases on `Abandoned`/`Failed`).
  - The success audit already lives in `work`'s transaction (`successAuditInWork`) — the
    new refusal paths must write their **own** failure audit before returning (the handler
    only auto-audits on `>=400` responses it sees, which it does here — verify by test).
  **Two-phase note:** this route's only side effect is the DB write; no downstream service
  call, so the two-phase-commit rule does not bind. State that explicitly in the ADR so a
  reviewer does not look for it.

- [x] **T13 — MCP facade: `toTaskKey` + the `requires` kind on `relation_add` / `relation_remove`.**
  `mcp/src/tools.ts` — extend both `inputSchema`s and the dispatch bodies
  (`:1312-1330`). Update the tool descriptions to say the target may be a per-project
  number **or** a platform-unique `KEY-N`, and to document `requires` as success-gated
  (does **not** release on `Abandoned`/`Failed`) so a model reaches for `depends_on` when
  it wants the self-healing kind.
  ⚠ **The facade runs `mcp/dist`, not `mcp/src`** — this task is not done until the bundle
  is rebuilt (project memory `mcp-facade-numeric-coercion-and-bundle`). Also apply the
  numeric-coercion convention at `dispatchTool` for any numeric arg.

- [x] **T13a — RED-first: lock the MCP↔OpenAPI mirror BEFORE touching `tools.ts`.**
  [`mcp/src/__tests__/tool-contract.test.ts`](mcp/src/__tests__/tool-contract.test.ts) already
  anchors every tool's `inputSchema` (property-name set, required set, per-field base types,
  enum values, declared bounds) to its operation in
  `docs/api/external/operations.openapi.yaml`, with a `TOOL_OP` map at `:96` and a
  "maps every registered tool" case at `:283`.
  **Order is not negotiable:** update the OpenAPI operation (T7) → run the contract test →
  it goes **RED** on the `toTaskKey` / `requires` drift → then update `TOOL_SPECS` +
  `dispatchTool` (T13) → GREEN. The project rule records this test was written RED-first
  because *it caught drift no human spotted*; running it afterwards proves nothing.
  **Runner:** `pnpm --filter <mcp-pkg> test` — a **separate runner**; the web suite never
  collects `mcp/src/**`.
  Also assert `dispatchTool` **forwards** the new field: destructuring known keys drops
  unknown args silently, so a schema-only change ships a facade that accepts `toTaskKey` and
  never sends it.

- [x] **T14 — RED: route tests, written before T11/T12 are implemented.**
  - Internal route — **unit**, and the file MUST live under
    `web/app/api/projects/[slug]/tasks/[number]/relations/__tests__/`. The unit project globs
    `app/**/__tests__/**/*.test.ts`; a file placed directly beside `route.ts` is **never
    collected** — this is the exact M10 defect. Cases: `toNumber` XOR `toTaskKey`
    both-present → 400 `CONFIG`; neither-present → 400; dual-RBAC 403 when the caller lacks
    `manageTaskRelations` on the **target** project; the same dual check on **DELETE** (the
    handler is shared — assert it, do not assume it).
  - Ext route — **integration**, `*.integration.test.ts` under `app/**` (that project needs
    no `__tests__` directory). Cases: NULL-project user token creates a cross-project
    relation; project-bound token → 403 **with the audit row written**; `toTaskKey` targeting
    an archived project → 404; `requires` created **and removed** over ext (the D4b hole).
  - **RED verification:** each case fails on its assertion. Confirm with
    `vitest list --project unit` and `--project integration` that both new paths are
    collected, before writing implementation.

**Phase 2 exit:** every T13a/T14 case GREEN; web suite green; **`pnpm --filter <mcp-pkg> test`
green**; `mcp/dist` rebuilt; `pnpm --filter maister-web exec eslint .` clean
(**check-only** — never bare `pnpm lint`, which is `eslint --fix` with no path and
reformats ~60 unrelated files).

**COMMIT CHECKPOINT 1** — `feat(relations): allow cross-project task relations (ADR-155)`

---

### Phase 3 — F1 cross-project cascade gates + read paths

- [x] **T15 — Gate `auto_launch_run_plan` to same-project candidates.**
  `web/lib/domain-events/auto-launch.ts`. Add `projectId: runs.projectId` to the parent-run
  select (`:241-248`); before the launch (`:317`), skip when
  `candidate.projectId !== parent.projectId`.
  **Logging:** WARN `{eventId, taskId, candidateProjectId, parentProjectId}` —
  "auto-launch: cross-project as-plan candidate skipped (orchestrator DAGs are same-project)".
  The consumer's idempotent contract holds: skip, never throw.

- [x] **T16 — Gate the abandon cascade to same-project children.**
  `web/lib/queries/run.ts` `getUnlaunchedAutoChildTaskIds` (`:712-733`) — restrict children
  to the orchestrator task's own project.
  **Decision (KISS — do not re-litigate):** self-join `tasks` on the orchestrator end inside
  the query and compare `child.projectId = orchestrator.projectId`. **No signature change,
  no call-site sweep.** Threading a `projectId` argument was the alternative; it moves the
  invariant to every caller, where the next new call site can forget it.

- [x] **T17 — Fix the board decomposition `keyRef` + link target.**
  `web/lib/queries/board.ts:411-424,445-456` — join `projects` on the **child's** project and
  select its `taskKey` + `slug`; build `keyRef` from the child's own key. Extend
  `ChildTaskRef` (`:84-90`) with `projectSlug` and route the link in
  `web/components/board/task-decomposition.tsx` through it (falling back to the current
  board's slug keeps same-project rendering byte-identical).
  Repeat the audit for `web/lib/queries/task-detail.ts` — it uses `getTaskRelations`, which
  already resolves the counterpart's own key, so it needs **no** change; record that in the
  task notes so a reviewer does not "fix" it.

- [x] **T18 — Consumer-fanout sweep + tests.**
  Grep every `parent_of` / `taskRelations` consumer once more against the Phase-3 change set
  and confirm each is either project-agnostic by design or explicitly gated:
  `lib/queries/board.ts`, `lib/queries/run.ts`, `lib/queries/task-detail.ts`,
  `lib/domain-events/auto-launch.ts`, `lib/runs/launchability.ts`,
  `lib/runs/task-launch-config.ts`, `lib/scheduler/c2-eligibility.ts`,
  `lib/run-schedules/dispatch.ts`, `lib/services/runs.ts`, `lib/services/hitl.ts`,
  `app/api/runs/launch-options/route.ts`, `app/api/v1/ext/runs/{plan,delegate}/route.ts`.
  Tests: integration case proving a cross-project `parent_of` child is **not** auto-launched
  and **not** abandon-cascaded; a board integration case asserting a cross-project child
  renders the sibling's `KEY-N` and slug (extend
  `web/lib/queries/__tests__/board.integration.test.ts`, which already seeds
  `schema.taskRelations`).

**Phase 3 exit:** full suite green. **F1 is complete and independently shippable here.**

**COMMIT CHECKPOINT 2** — `fix(flows): keep cross-project relations out of automation cascades (ADR-155)`

---

### Phase 4 — F2 reach grant + ext-handler seam

- [x] **T19 — Migration 0123: reach grant + agent chain depth.**
  **Generated, not hand-authored.** Order: edit `web/lib/db/schema.ts` **first**, then
  `pnpm --filter maister-web db:generate` (`drizzle-kit generate`) emits the triple —
  `web/lib/db/migrations/0123_<name>.sql` + the `_journal.json` entry +
  `meta/0123_snapshot.json`. Review the emitted SQL before committing.
  ⚠ **Never `drizzle-kit generate --custom`** here — it copies the previous snapshot
  verbatim and stales the diff baseline for every later migration (project memory
  `drizzle-snapshot-custom-gotcha`). Hand-writing the `.sql` has the same effect.
  Columns:
  - `agent_project_links.cross_project_reach boolean NOT NULL DEFAULT false`
  - `runs.agent_chain_depth integer NOT NULL DEFAULT 0`
  Both are **additive, constant-default** columns. Safe here precisely because the defaults
  carry the right meaning for pre-migration rows — `false` = no reach (deny-by-default),
  `0` = no chain spent. Say so in the migration comment; the "looks populated but isn't"
  trap the project rule warns about applies to defaults that *lie*, not to these.
  No backfill, no abort-guard, no `DELETE FROM`.
  **Docs:** all five places per the DB-surface note (incl. `docs/db/agents-domain.md` and
  `docs/db/runs-domain.md` attribute blocks, and a check of `brain-domain.md`) — T7 wrote
  them as `(Designed)`; confirm the emitted SQL matches what was documented, and fix the
  doc if the generator disagrees.
  Verify: `pnpm --filter maister-web db:migrate` on a fresh DB **and** on a copy of a
  populated dev DB; `select count(*) from agent_project_links where cross_project_reach` = 0;
  `_journal.json`'s newest entry has a matching snapshot file and a monotonic `when`.

- [x] **T20 — Scope grant + subset + the reach predicate.**
  - `web/types/token-scopes.ts`: add **`tasks:create` to `AGENT_TOKEN_SCOPES`** (D6b) with a
    comment naming ADR-156 and the fact that this is a same-project expansion too. Verify
    the other two legs of the agent-gains-an-op triple already exist and do not assume it:
    the route `POST /api/v1/ext/projects/[slug]/tasks` (`scopeLabel: "tasks:create"`) and
    `PROJECT_ACTION_BY_SCOPE["tasks:create"] = "createTask"`.
  - `export const CROSS_PROJECT_AGENT_SCOPES = [...] as const satisfies readonly (typeof
    TOKEN_SCOPES)[number][];` with the D6 list (now including `tasks:create`) and a comment
    naming each exclusion's reason.
  - New `web/lib/agents/cross-project-reach.ts`:
    `canAgentReachProject({agentId, targetProjectId, scopeLabel, callingRunId, db})` →
    `{allowed: boolean, reason: "ok" | "no_link" | "link_disabled" | "reach_off" | "scope_not_in_subset" | "chain_depth_exhausted"}`.
    Checks in order: scope ∈ `CROSS_PROJECT_AGENT_SCOPES` → enabled `agent_project_links`
    row in the target with `cross_project_reach` → `runs.agent_chain_depth <
    MAISTER_MAX_AGENT_CHAIN_DEPTH`.
  **Allow-list, never deny-list** (project rule): a scope absent from the subset is refused
  by default, so a future scope addition cannot silently gain cross-project reach.
  **Logging:** DEBUG the full decision `{agentId, targetProjectId, scopeLabel, reason}` on
  every call; WARN on every deny.

- [x] **T21 — Wire the reach check into `ext-handler`.**
  `web/lib/tokens/ext-handler.ts` — a third arm in **both** cross-project refusal sites
  (`:255-274` slug, `:358-377` resolveProjectId): when `actor.tokenKind === "agent"` and
  `actor.agentId` is set and `canAgentReachProject(...)` allows, **continue** instead of
  404-ing; otherwise keep today's existence-hidden 404 (an agent must not be able to probe
  for project existence). Write the audit row with `projectId = target` so the trail shows
  where the agent acted; the actor label stays `agent:<id>`.
  The two refusal sites are near-identical today — extract the shared arm into one helper so
  a future change cannot fix one and miss the other.
  `PROJECT_ACTION_BY_SCOPE` needs no new entries (the subset's scopes are all mapped) —
  assert that with a test rather than assuming it, since an unmapped scope silently resolves
  to viewer-level `readBoard`.

- [x] **T21a — Stamp the producing `run_id` on agent-authored `task.*` domain events.**
  **Without this, D7's same-project arm cannot work — the loop D6b opens stays open.**
  Verified hole: `addTaskComment` calls `emitDomainEvent` **without `runId`**
  ([`web/lib/social/comments.ts:138`](web/lib/social/comments.ts:138)), so
  `domain_events.run_id` is NULL for `task.comment_added` — and the same is true of
  `task.created`. The row carries `actor_type='agent'` + `actor_id=<agentId>` but **no
  producing run**, so T22's `parentDepth = runs[event.runId].agent_chain_depth` is
  unresolvable for exactly the two kinds that drive the same-project loop. Depth would
  always seed `0` and the cap would never bind.
  `emitDomainEvent` already accepts `runId` ([`outbox.ts:71`](web/lib/domain-events/outbox.ts:71))
  — nothing schema-side is missing; the callers simply never pass it.
  **Fix:** derive the calling run server-side and thread it through. An agent authenticates
  with a run-bound token whose name is deterministically `agent-run:<runId>`, so the ext
  handler can resolve it from `actor.tokenId` without trusting any request field. Pass it
  into the `emitDomainEvent({ runId })` calls on the agent-authored paths (`task.created`,
  `task.comment_added`), leaving user/system-authored emissions unchanged (`runId: null`).
  **Scope discipline:** touch only the emitters this plan's loop depends on. Widening
  provenance to every event kind is a separate change.
  **Logging:** DEBUG `{kind, runId, actorType}` at the emit seam so a NULL `run_id` on an
  agent-authored event is visible rather than silent.
  **RED first:** an integration test asserting `domain_events.run_id IS NOT NULL` for an
  agent-authored `task.comment_added`. It fails today; that failure is the hole.

- [x] **T22 — Seed `runs.agent_chain_depth` at launch + enforce it on the launch path.**
  **Depends on T21a** — the walk below reads `domain_events.run_id`, which T21a is what
  populates.
  `web/lib/agents/launch.ts` — at run insert, set `agentChainDepth` from the trigger: for
  `trigger.source === "domain_event"` with a resolvable event whose `actor_type = 'agent'`,
  resolve the producing run via `event.run_id` and use `<that run's depth> + 1`; every other
  source seeds `0`. **If an agent-authored event has a NULL `run_id`** (a pre-T21a row, or
  an emitter T21a did not cover), treat the depth as **the cap** — fail closed, WARN, and
  skip. Seeding `0` there is the fail-open that reopens the loop. Read
  `MAISTER_MAX_AGENT_CHAIN_DEPTH` through `web/lib/instance-config.ts` (never `process.env`
  at the call site).
  **Second enforcement point (D7):** when the computed depth would reach the cap, **refuse
  the launch** — WARN `{agentId, projectId, depth, cap, triggerEventId}` and skip the
  candidate. Never throw: the domain-event consumer's idempotent contract means a throw
  redelivers the whole window forever.
  This is a **launch-time decision the enforcement path reads** — it must be on the run row,
  not re-derived from a projection that can drift after launch.

- [x] **T23 — F2 tests.**
  Integration (`pnpm test:integration`): agent token from project A reaching B with a
  granted+enabled link succeeds for each subset scope; the same token is 404'd for a scope
  outside the subset; `enabled=false` link → 404; `cross_project_reach=false` → 404;
  chain depth exhausted → 404 with the WARN reason; the audit row records the **target**
  project and `agent:<id>`.
  Unit: `canAgentReachProject` truth table (one case per `reason`); a guard test asserting
  every member of `CROSS_PROJECT_AGENT_SCOPES` has a `PROJECT_ACTION_BY_SCOPE` entry; a
  guard test asserting `tasks:create` is in `AGENT_TOKEN_SCOPES` **and** mapped to
  `createTask` (the agent-gains-an-op triple).
  **Loop-containment regressions — BOTH arms of D7 (a test per discriminant arm; half-A
  tested + half-B tested ≠ A∘B tested):**
  (a) two-project mutual reach terminates at the cap;
  (b) **same-project** A-creates-task → triggers-B → B-creates-task → triggers-A terminates
  at the cap — the loop D6b opened.
  ⚠ Integration tests here need Docker; per project memory run them with
  `dangerouslyDisableSandbox` when the sandbox blocks testcontainers.

**Phase 4 exit:** full suite green; migration applies cleanly on a populated DB.

**COMMIT CHECKPOINT 3** — `feat(agents): cross-project facade reach + tasks:create, bounded by agent chain depth (ADR-156, migr 0123)`

---

### Phase 5 — F2 surface: attach UI + external docs

- [ ] **T24 — Expose `crossProjectReach` on the attach route + UI.**
  Route: `web/app/api/projects/[slug]/agents/[agentId]/route.ts` — add the field to the
  **existing aggregating PATCH** (one transactional endpoint, never a per-field route or a
  client-side saga — project convention). It participates in the existing
  `schedules_revision` fence so a stale editor cannot silently re-grant.
  UI: `web/components/board/panels/agents-attach-edit-modal.tsx` (edit lives in the popup;
  the panel table stays view-only) — a toggle beside the `memoryEnabled` axis, EN+RU copy
  in `web/messages/{en,ru}.json`, with helper text stating exactly what the grant admits
  (read + comment + relate) and what it never admits (runs, triage, memory).
  **Launch-precondition carry-back** (project rule): the modal must show the grant as
  *inert* when the agent has no enabled attachment in this project — "grantable now,
  ineffective later" is a design defect.
  Accessibility: label + `aria-live` on the async save, per the data-management page rules.

- [ ] **T25 — F2 surface tests + docs sync.**
  DOM test alongside `agents-attach-config.dom.test.ts` (renderToStaticMarkup, no jsdom —
  project convention); route unit test for the aggregated PATCH including the revision
  fence. Confirm the `docs/system-analytics/agents.md` + `external-operations.md` text
  written in Phase 0 matches what shipped; fix the doc, not the code, if they diverge on
  wording only.

**Phase 5 exit:** full suite green. **F2 is complete and independently shippable here.**

**COMMIT CHECKPOINT 4** — `feat(agents): cross-project reach grant in the attach panel (ADR-156)`

---

### Phase 6 — F3 declaration, schema, engine floor

- [x] **T26 — Migration 0124: context-repo declaration + launch snapshot.**
  Same generated flow as T19 — edit `schema.ts` first (typed
  `$type<ContextRepoDecl[]>()` / `$type<ContextMountSnapshot[]>()`), then
  `pnpm --filter maister-web db:generate`; never `--custom`, never hand-written SQL.
  - `agent_project_links.context_repos jsonb` (nullable — absent = no mounts)
  - `runs.context_mounts jsonb` (nullable — the launch snapshot)
  Additive, nullable, no backfill.
  **Docs:** the same five places as T19 (`docs/db/agents-domain.md` +
  `docs/db/runs-domain.md` attribute blocks, `docs/database-schema.md` schema block **and**
  changelog, `docs/db/erd.md`; check `brain-domain.md`).
  Verify: journal newest entry ↔ matching snapshot, monotonic `when`; migrate on fresh and
  populated DBs.

- [x] **T27 — Flow DSL: `settings.context_repos` + engine bump to 3.4.0.**
  - `web/lib/config.schema.ts`: `contextRepoSchema = z.object({ project: z.string().min(1),
    ref: z.string().min(1).optional() }).strict()`; attach `context_repos:
    z.array(...).max(8).optional()` to the **`ai_coding`, `judge`, and `orchestrator`** node
    settings (`~:962-1020`) — all three dispatch to the same ACP-session arm. `cli`/`check`
    stay excluded (D8/D8b).
  - `web/lib/flows/engine-version.ts`: `MAISTER_ENGINE_VERSION` `3.3.0 → 3.4.0` with the
    running comment block extended in the established style.
  - `web/lib/config.ts`: `CONTEXT_REPOS_ENGINE_MIN = "3.4.0"` + a load-time gate mirroring
    the ADR-154 `MAISTER_FLOW_DIR` floor gate (`:1131-1150`) — a manifest declaring
    `context_repos` below the floor refuses at manifest load with an actionable message
    naming the required bump.
  - `web/lib/flows/flow-dsl-grammar.ts` (the in-code SSOT shipped to agents as the
    `/flow-authoring` skill) + its drift-guard test.
  **SET/CLEAR symmetry** (project rule): removing `context_repos` from a manifest on the
  next install must clear the resolved value — no `if (!x) continue` write loop. Both
  halves are mandatory tests.

- [x] **T28 — Attach-side declaration + write-time authorization.**
  `agent_project_links.context_repos` on the same aggregating PATCH as T24. At **write
  time**, verify the acting admin holds `readRepoFiles` on every referenced sibling project
  and that each slug resolves to an active project — refuse `PRECONDITION` naming the
  offending slug. `agents.recommended.context_repos` is read as **prefill only** in the
  attach modal (never an implicit grant), matching the ADR-089 `recommended` convention.

- [x] **T29 — Phase-6 tests.**
  Manifest-load: declaring `context_repos` at `engine_min` 3.3.0 refuses; at 3.4.0 loads;
  unknown/over-max array refuses. **One case per node type** (`ai_coding`, `judge`,
  `orchestrator`) plus a negative case proving a `cli` node declaring `context_repos` is
  rejected by the schema. SET/CLEAR/idempotent-re-set round trip on the link column.
  Attach route: unauthorized sibling → `PRECONDITION`; unknown slug → `PRECONDITION`.

**Phase 6 exit:** full suite green; `pnpm --filter maister-web typecheck` clean.

---

### Phase 7 — F3 materialization, enforcement, lifecycle

- [x] **T30 — Mount resolution + creation + launch snapshot.**
  New `web/lib/context-mounts/service.ts`:
  - `resolveContextMounts({consumingProjectSlug, runId, decls, db})` → resolve each slug to
    an active project, resolve the committish (`ref` literal, else the sibling's default
    branch; `trigger` only for agent runs via `resolveWorkspaceRefCommittish`), and return
    the snapshot array. Refuse `PRECONDITION` on unknown/archived slug or unresolvable ref
    (**no auto-fetch**, matching the ADR-090 v1 rule).
  - `materializeContextMounts(snapshot)` → for each, `removeWorktree(force)` then
    `addDetachedWorktree` at `<runDir>/context/<siblingSlug>/` (remove-first makes a
    crashed prior spawn of the same run recoverable, mirroring `launch.ts:3224-3233`).
  - `releaseContextMounts(snapshot)` → `removeWorktree` against **each sibling's** repo
    path, then `git worktree prune` on touched sibling repos.
  Wire into: `web/lib/flows/graph/runner-graph.ts` (the shared
  `ai_coding | judge | orchestrator` dispatch arm, before `runAgentStep`) and
  `web/lib/agents/launch.ts` (before `createSession`). Persist the
  snapshot on `runs.context_mounts` in the same transaction as the run/attempt write.
  **Ordering + crash windows** (project rule): git side-effects run BEFORE the durable
  status write; a crash between mount creation and snapshot commit leaves an orphan reaped
  by T32 on path shape alone. Document that residual window in ADR-157 — it is the only one.
  **Logging:** INFO per mount `{runId, siblingSlug, committish, mountPath}`; WARN on
  refusal with the failing slug; DEBUG the resolved snapshot before persisting.

- [x] **T31 — Read-only enforcement (L2 + L3).**
  - **Supervisor contract:** add `contextMounts: z.array(worktreePathSchema).max(8).optional()`
    to `StartSessionRequestSchema` (`supervisor/src/types.ts`) — carrying
    `{slug, path, ref, commit}` per entry, not bare paths. Thread into `buildChildEnv`
    (`supervisor/src/spawn.ts:107-120`) as `MAISTER_CONTEXT_REPOS=<JSON array>` (D8b) — the
    exact `MAISTER_CAPABILITY_PROFILE_PATH` pattern, a first-class request field, **not** an
    overload of `executor.env` (which is the provider-secret channel). The `path` values
    still validate against `worktreePathSchema`.
    Also render a **prompt preamble** listing each mount's slug, path, ref, and
    read-only status — the env var serves scripts, but the preamble is how the agent
    actually learns the mounts exist.
  - **L2:** in the permission handler (`supervisor/src/acp-client.ts:579-630`, beside the
    `hooksConfig.pathGuard` evaluation) deny every write-class tool call whose resolved path
    is inside any mount root. **Unconditional** when mounts exist — not opt-in via
    `settings.hooks`, because the read-only contract is the mount's whole point. Reuse
    `guardrail-hooks.ts`'s path-resolution helper rather than hand-rolling a second one.
  - **L3:** at the terminal choke, `git status --porcelain` per mount; non-empty → WARN with
    the mount + run + the offending paths, and record quarantine evidence in the same
    one-transaction shape the ADR-090 dirty-watchdog uses. Removal proceeds regardless
    (detached, no branch — nothing is lost that was ever legitimate).
  - Web-side, thread `contextMounts` through `web/lib/supervisor-client.ts` `CreateSessionInput`
    and the `runner-agent.ts` `createInput` (`:840-855`).

- [x] **T32 — Terminal release + GC backstop.**
  - Terminal choke: call `releaseContextMounts(run.context_mounts)` from the flow and agent
    terminal paths, reading the **snapshot**, never re-deriving from the manifest/link.
  - New backstop sweep in the `system_sweep` family reaping mounts under
    `.maister/*/runs/*/context/*` whose owning run is terminal or absent — model it on
    `web/lib/gc/ephemeral-agent-gc.ts`.
  **Background-automation requirements** (project rule): a durable per-item attempt marker
  so a permanently-failing mount cannot starve the rest of the scan; bounded retries with
  explicit backoff; a **poison-item policy** (deterministic failure → permanent `failed`
  with recorded evidence; transient → bounded retry); and **one wiring-seam test** that
  drives the real `runSchedulerTick({jobKind})` claim→dispatch path — a registration
  checklist nothing executes is an unverified claim.

- [x] **T33 — F3 tests + reconciler non-interference proof + deployment wiring.**
  - Integration: a flow run with one sibling mount materializes it at the right committish,
    the path is inside the prompt-confinement allow-set, and the terminal path removes it
    from the **sibling's** `git worktree list`.
  - **Reconciler non-interference (the ★ trap):** run `runWorkspaceReconciliationSweep()`
    with live context mounts present and assert `quarantined === 0` and that no finding
    references a mount path. This test is the guard against a future move under
    `worktreesRoot()`.
  - L2: a write-class tool call into a mount is denied by the supervisor — a **supervisor**
    unit test against the permission handler. **Runner: `pnpm --filter @maister/supervisor
    test`** (its own `unit`/`integration` projects; the web suite never collects
    `supervisor/src/**`). Write it RED against the un-guarded handler first.
  - L3: a mount dirtied out-of-band produces the WARN + quarantine evidence and is still
    removed.
  - GC backstop: an orphan mount from a killed run is reaped; a live run's mount is not.
  - **Deployment wiring:** `.env.example` + `compose.yml` (web + supervisor) +
    prod overlay + the `docs/configuration.md` env-vars **table** for
    `MAISTER_MAX_AGENT_CHAIN_DEPTH`, `MAISTER_CONTEXT_MOUNT_ENABLED`, and the
    supervisor-side `MAISTER_CONTEXT_REPOS` derivation. Acceptance criteria name which file
    each var lands in.

**Phase 7 exit:** full suite green including supervisor tests
(`pnpm --filter @maister/supervisor test`).

**COMMIT CHECKPOINT 5** — `feat(flows): read-only sibling-repo context mounts (ADR-157, migr 0124)`

---

### Phase 8 — F3 surface + close-out

- [x] **T34 — Renumber pass (mandatory, AFTER rebasing onto the integration target).**
  Its own focused session, not a merge-time surprise.
  - Re-read `max(### ADR-NNN)` at the integration target's HEAD; renumber ADR-155/156/157
    and **every citation** (code comments, docs, migration comments, test names).
  - Re-read `max(idx)` in `_journal.json`; renumber migrations 0123/0124 as SQL file +
    journal entry + snapshot **triples**; verify the newest journal entry has a matching
    snapshot and that `when` values are monotonic.
  - Grep prose forms (`pre-0123`, `since ADR-155`, `as of 0124`) and prefer number-agnostic
    phrasing in long-lived comments.
  - Verify with `git diff <old> <new> --quiet` semantics that the rewrite changed only what
    was intended (project convention: rebase + FF, never a merge commit; the owner performs
    the FF).

- [ ] **T35 — E2E: the multi-repo story, end to end.**
  Playwright, two seeded projects. Create a task in each; link them cross-project from the
  board (`KEY-N` target); assert the dependent shows `blocked` on **its own** board with the
  sibling's key on the chip; complete the blocker; assert the dependent becomes launchable.
  ⚠ Project memory: e2e shares ports 3100/7788 and the `maister_e2e` DB across **all**
  worktrees — kill those ports first and prove a green baseline before adding cases.

- [x] **T36 — Documentation checkpoint (`/aif-docs`) + verify.**
  Reconcile every Phase-0 artifact against what actually shipped; flip
  `Designed → Implemented` tags; update `CLAUDE.md` (root) — the Flow-engine version line
  `3.3.0 → 3.4.0`, the relation-kinds count, and a Current-Scope line for cross-project
  relations; update `web/CLAUDE.md` if a UI convention moved. Also fold the two drifts found
  during this plan's research: root `CLAUDE.md` says "8-kind taxonomy v1" where
  `domain_events` has **11** kinds, and `docs/system-analytics/tasks.md:48` lists 3 relation
  kinds where the code has 5.
  Then run `/aif-verify` and confirm **all** of:
  - `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration`
  - `pnpm --filter @maister/supervisor test` · `pnpm --filter <mcp-pkg> test`
  - `pnpm --filter maister-web exec eslint .` (check-only) · `typecheck` clean
  - `pnpm validate:docs` **and `pnpm validate:contracts`** (T7a's gate — the one the
    original plan omitted)
  - ADR anchors resolve; migration triples intact (journal ↔ snapshot, monotonic `when`)
  - **the T7b traceability matrix has no unmapped row in either direction** — every
    Expectations bullet has a green test, every test maps to a bullet

**Phase 8 exit:** everything above green; plan complete.

**COMMIT CHECKPOINT 6** — `docs: reconcile multi-repo enablement analytics with the shipped code`

---

## Commit plan

| # | After | Message |
| - | ----- | ------- |
| 0 | T1-T7b | `docs(adr): record ADR-155/156/157 + multi-repo analytics and traceability (Phase 0)` |
| 1 | T8-T14 | `feat(relations): allow cross-project task relations (ADR-155)` |
| 2 | T15-T18 | `fix(flows): keep cross-project relations out of automation cascades (ADR-155)` |
| 3 | T19-T23 | `feat(agents): cross-project facade reach + tasks:create, bounded by agent chain depth (ADR-156, migr 0123)` |
| 4 | T24-T25 | `feat(agents): cross-project reach grant in the attach panel (ADR-156)` |
| 5 | T26-T33 | `feat(flows): read-only sibling-repo context mounts (ADR-157, migr 0124)` |
| 6 | T34-T36 | `docs: reconcile multi-repo enablement analytics with the shipped code` |

MAIster convention: **no `Co-Authored-By` / AI trailer** in commit messages.
Integration is **rebase + fast-forward**, never a merge commit; the owner performs the FF.

## Shipping seams

F1 (Phases 1-3), F2 (Phases 4-5), and F3 (Phases 6-7) are each independently shippable at
their phase exit. If scope has to be cut, cut from the back — never mid-feature.

---

## Resolved decisions (owner, 2026-08-05) — no open questions remain

| # | Question | Answer | Where it landed |
| - | -------- | ------ | --------------- |
| 1 | Mirror `relation_added` activity onto the to-end? | **No** — from-end only, the surgical option. The to-end board still shows the relation chip (task-id-keyed, already cross-project correct) | T8 unchanged; stated in ADR-155 |
| 2 | Add `requires` to ext + MCP? | **Yes, both POST and DELETE** — the shared `opBodySchema` means the real hole was *unremovable* orchestrator edges | **D4b**, T12, T13 |
| 3 | `GATING_BFS_MAX_NODES = 5000`, refuse on breach? | **Yes** | D2, T8 |
| 4 | Chain budget | **2** | D7, T22 |
| 5 | Add `tasks:create` to `AGENT_TOKEN_SCOPES`? | **Yes** — needed shortly. Forced D7 to widen (see below) | **D6b**, T20, T23 |
| 6 | `MAISTER_CONTEXT_REPOS` format | **JSON** `[{slug, path, ref, commit}]` | **D8b**, T31 |
| 7 | Which node types carry `settings.context_repos`? | **`ai_coding` + `judge` + `orchestrator`** (`cli`/`check` excluded) | D8, T27, T29, T30 |
| 8 | Milestone name | **`M49. Multi-repo task-graph enablement`** | Roadmap Linkage |

## Refinement pass (`/aif-improve`, 2026-08-05)

SDD/TDD hardening. 40 tasks (was 36). What changed and why:

| Change | Cause |
| ------ | ----- |
| **T21a added** (blocks T22) | 🔴 **D7's same-project arm could not work.** `addTaskComment` emits without `runId`, so `domain_events.run_id` is NULL for `task.comment_added` / `task.created` — the depth walk was unresolvable for exactly the kinds that drive the loop `tasks:create` opens. Depth would always seed `0`. T22 now also fails **closed** on a NULL `run_id` |
| **T7a added** | `pnpm validate:contracts` (3 OpenAPI + 4 AsyncAPI + adapter mirrors) was missing from every gate list; `validate:docs` does not validate API specs at all |
| **T7b added** | Spec→test traceability matrix — the artifact that makes "consistent to specs" checkable instead of a review-time opinion |
| **T13a added** | The MCP↔OpenAPI contract test must run **RED before** `tools.ts` changes; mcp is also a **separate test runner** the plan never invoked |
| Method section added | RED→GREEN→REFACTOR, the test-quality bar (no trivial tests, minimum overlap, edge cases derived from Expectations), and the four runners with their exact globs |
| Spec paths corrected | The ext API is **`docs/api/external/operations.openapi.yaml`** — the plan had a wrong glob and mislabeled `docs/api/external/` as third-party-only |
| DB-surface note added | A new column lands in **five** places, not two (both halves of `database-schema.md`, two `docs/db/*-domain.md` attribute blocks, `erd.md` — plus `brain-domain.md` renders `agent_project_links`) |
| T19/T26 rewritten | Migrations are **generated** (`db:generate`), not hand-authored; `--custom` stales the snapshot baseline |
| T1 extended | F1 ships **no kill switch** — reverting the code leaves cross-project rows a project-scoped BFS cannot see. Accepted one-way door, now written down |
| T16 decided | Self-join `tasks` on the orchestrator end; no signature change, no call-site sweep |
| T31, Phase-8 verify | Named the supervisor runner; Phase 8 now runs all four suites + both validators + the T7b matrix |

**Answer 5 changed the design.** Granting `tasks:create` opens a *same-project* loop the
original cross-project hop budget did not cover: agent A creates a task → `task.created` →
triggers agent B → creates a task → triggers A. Existing self-exclusion only filters an
agent's **own** events, so an A↔B pair loops freely. The fix costs one rename and one extra
enforcement point — `runs.cross_project_hops` became `runs.agent_chain_depth`, enforced at
**both** the cross-project reach check and the agent launch path (D7). Shipping answer 5
without that widening would have introduced an unbounded loop.

---

## Traceability (T7b) — every Expectations bullet ↔ its one owning test

Built 2026-08-05 from the Expectations sections written in T4/T5/T6. Rules
applied: exactly one owning test per bullet; no bullet without a test; no
planned test without a bullet.

### `social-analytics/social-board.md` (ADR-155)

| Expectation (abridged — verbatim in the doc) | Asserting test | Task |
| --- | --- | --- |
| row `project_id` MUST equal the from-task's project; to-task MAY differ | `social-domain.integration` → "creates a cross-project relation owned by the from-task's project" | T10 |
| create/remove MUST require `manageTaskRelations` on BOTH endpoint projects | internal-route unit → dual-RBAC 403 on target project (POST + DELETE) | T14 |
| every gating insert MUST take ONE platform-wide lock, never per-project | `relations-cycle.integration` → **AC-X2** 4-project cycle under concurrent inserts | T10 |
| BFS MUST refuse `CONFLICT` beyond `GATING_BFS_MAX_NODES` | `relations-cycle.integration` → **AC-X3** node-cap refusal | T10 |
| `toNumber`/`toTaskKey` MUST be mutually exclusive (400 internal / 422 ext) | internal-route unit → both-present + neither-present | T14 |
| `getOpenRelationBlockers` MUST return the blocker's OWN key; chip renders it | `social-domain.integration` → "reports a cross-project blocker carrying the blocker's own KEY-N" | T10 |
| `requires` MUST stay success-gated across projects | `social-domain.integration` → "keeps `requires` success-gated across projects: Abandoned still blocks" | T10 |
| relations MAY cross projects; automation MUST NOT (launcher + C2 exclusion stay a partition) | `auto-launch.integration` "never auto-launches a cross-project as-plan candidate" · `cascade.integration` "never abandon-cascades a cross-project parent_of child" · `admission-gate.integration` "excludes a SAME-project parent_of child but still admits a CROSS-project one" · `board.integration` "a cross-project child carries the SIBLING's key and project slug" | T18 |
| `resolveTaskByKeyRef` resolves against `projects.task_key`, uppercases, returns null (never throws) on malformed/over-long/out-of-range/unknown | `task-lookup.test.ts` (12 unit cases) + `social-domain.integration` "resolves a KEY-N ref…" / "returns null for an unknown key and for an unknown number" | T9/T10 |
| `getTaskRelations` renders each end with the COUNTERPART's own key | `social-domain.integration` → "renders each end with the counterpart's OWN task_key" | T10 |
| a gating cycle is refused identically same-project or cross-project | `relations-cycle.integration` → **AC-X1** cross-project 2-cycle | T10 |

### `system-analytics/external-operations.md` (ADR-155/156)

| Expectation (abridged) | Asserting test | Task |
| --- | --- | --- |
| ext `opBodySchema` MUST offer all five kinds on POST **and** DELETE | ext relations integration → `requires` created **and removed** over ext | T14 |
| `toNumber`/`toTaskKey` mutually exclusive → `CONFIG` 422 on ext | ext relations integration → XOR violation returns 422 | T14 |
| project-bound token crossing MUST be 403 + audited row | ext relations integration → 403 with the audit row asserted | T14 |
| NULL-project user token MUST pass target-project RBAC re-check | ext relations integration → NULL-project token creates cross-project relation | T14 |
| agent token reaches only via subset + enabled reach link + depth; denial stays 404 | reach integration → per-scope allow + each deny reason 404s | T23 |
| every `CROSS_PROJECT_AGENT_SCOPES` member MUST have a `PROJECT_ACTION_BY_SCOPE` entry | unit guard test over the subset | T23 |
| MCP `TOOL_SPECS` MUST mirror the ext body schema | `mcp/src/__tests__/tool-contract.test.ts` (OpenAPI-anchored) | T13a |

### `system-analytics/agents.md` (ADR-156/157)

| Expectation (abridged) | Asserting test | Task |
| --- | --- | --- |
| reach only with an ENABLED link carrying `cross_project_reach = true` | reach integration → `enabled=false` and `reach_off` both 404 | T23 |
| reach limited to `CROSS_PROJECT_AGENT_SCOPES`, evaluated as an allow-list | unit → `canAgentReachProject` truth table, one case per `reason` | T23 |
| every denial existence-hidden 404 + audited with TARGET project + `agent:<id>` | reach integration → audit row records target project and actor label | T23 |
| `runs.agent_chain_depth` snapshotted at INSERT, never re-derived | launch integration → depth persisted on the run row at launch | T23 |
| agent-authored event with NULL `run_id` MUST be treated as at the cap | launch integration → NULL `run_id` fails closed | T23 |
| cap-refused launch MUST WARN and skip, NEVER throw | launch integration → consumer completes, candidate skipped | T23 |
| mount MUST be read-only and under the run dir, never `worktreesRoot()` | mount integration → path shape + L2 denial | T33 |
| `runs.context_mounts` MUST be the sole source for terminal/recovery | mount integration → release reads the snapshot | T33 |

### `system-analytics/identity-access.md` (ADR-156)

| Expectation (abridged) | Asserting test | Task |
| --- | --- | --- |
| a project-bound token MUST NEVER be authorized against another project | ext relations integration → 403 arm | T14 |
| every subset member MUST have a `PROJECT_ACTION_BY_SCOPE` entry | unit guard (shared with external-operations row — one owning test) | T23 |
| `tasks:create` MUST be in `AGENT_TOKEN_SCOPES` and map to `createTask` | unit guard → the agent-gains-an-op triple | T23 |

### `system-analytics/flow-settings.md` (ADR-157)

| Expectation (abridged) | Asserting test | Task |
| --- | --- | --- |
| accepted only on `ai_coding`/`judge`/`orchestrator`; rejected elsewhere | manifest-load unit → one case per node type + `cli` negative | T29 |
| below-floor `engine_min` MUST refuse at manifest load with `CONFIG` | manifest-load unit → 3.3.0 refuses, 3.4.0 loads | T29 |
| at most 8 entries | manifest-load unit → over-max refusal | T29 |
| removal MUST clear the resolved value (SET/CLEAR symmetry) | link round-trip integration → set, then clear | T29 |
| launch MUST refuse `PRECONDITION` without `readRepoFiles` on a sibling | attach/launch integration → unauthorized sibling refusal | T29 |

### `system-analytics/workspaces.md` (ADR-157)

| Expectation (abridged) | Asserting test | Task |
| --- | --- | --- |
| mount created at `<runDir>/context/<slug>/` via `addDetachedWorktree`, never under `worktreesRoot()` | mount integration → materializes at the right committish + path | T33 |
| `context_mounts` written in the run-insert tx; sole input to release/recovery | mount integration → snapshot-driven release | T33 |
| terminal release MUST `removeWorktree` per sibling + `git worktree prune` | mount integration → gone from the SIBLING's `git worktree list` | T33 |
| write-class calls under a mount denied unconditionally at the handler | **supervisor** unit → permission-handler denial (own runner) | T33 |
| dirty mount MUST WARN + quarantine evidence and still be removed | mount integration → out-of-band dirty case | T33 |

### `system-analytics/reconciliation-gc.md` (ADR-157)

| Expectation (abridged) | Asserting test | Task |
| --- | --- | --- |
| mounts MUST stay out of the reconciler's scan scope by path | reconciler non-interference → `quarantined === 0`, no finding names a mount | T33 |
| GC backstop reaps orphaned mounts, leaves live ones, isolates poison items | GC integration + one real `runSchedulerTick({jobKind})` wiring-seam test | T32 |

**Coverage: 41 bullets ↔ 41 owning tests, no unmapped row in either direction.**

Corrected 2026-08-05 after the Phase-1/2 review: the first cut claimed 38↔38 but
left five Phase-1 tests unmapped (`AC-X1`, the counterpart-key render, both
`resolveTaskByKeyRef` integration cases, and the whole `task-lookup.test.ts`
unit file), because `resolveTaskByKeyRef` had no Expectations bullet at all —
only an Edge case. Three bullets were added to `social-board.md` rather than
deleting the tests. The migrated "rejects self-relations and a mis-owned
from-end" case maps to the new **Edge case** for a mis-owned `projectId`, not to
an Expectations row (the matrix maps Expectations only).
Shared owning tests are noted inline where two docs state the same invariant from
different sides (the subset↔action-map guard) — one test, one owner, cited twice.

### Phase 0 exit evidence (recorded 2026-08-05)

| Gate | Result |
| ---- | ------ |
| `node scripts/validate-docs-mermaid.mjs` | 77/77 blocks across 13 changed files, exit 0 |
| `node scripts/validate-docs-adr-anchors.mjs` | 426 anchors resolved, exit 0 |
| `node scripts/validate-contracts.mjs` (T7a) | all 7 spec files ok, exit 0 |
| `npx @redocly/cli lint` ×3 | supervisor valid; web 2 errors + operations 1 error — **byte-identical to HEAD**, all pre-existing `nullable-type-sibling` findings in unrelated sections (R9: not fixed in passing) |
| `pnpm --filter @maister/mcp test` | **6 RED on `relation_add`/`relation_remove`** — the designed T13a order (spec first, facade in T13) |

### Deviations from the plan, recorded

1. **Ext `CONFIG` is 422, not 400.** The plan said 400 on both surfaces.
   `httpStatusForExtCode` (`web/lib/tokens/ext-handler.ts:122-140`) maps `CONFIG`
   → 422 across all of `/api/v1/ext/*`. Docs and specs record 400 internal /
   422 ext. The 403 project-bound refusal is unaffected.
2. **The Stage-1 restriction is ADR-083 clause 4, not ADR-078 D4.** ADR-078 is
   gate-chat. ADR-155 supersedes exactly one sentence of ADR-083 clause 4.
   Pre-existing stale `ADR-078 D4/D5` citations remain at 7 code sites and 9
   `tasks.md` lines — left alone per R9, folded into T36.
3. **R5a's ≤ 12-bullet cap is exceeded in four files** — every one of them was
   already over the cap before this work (`social-board.md` 13,
   `external-operations.md` 19, `agents.md` 21, `identity-access.md` 14).
   Reaching 12 would mean deleting shipped `(Implemented)` acceptance criteria
   that have tests bound to them. R5a's own remedy is to split the file, which is
   an owner decision. Reported, not silently compressed.

### Additional deviations found during implementation (Phases 4-7)

4. **`createTask` could not express an agent actor at all.** It derived its actor
   from `actorUserId` only, and `actorUserIdForToken` returns `null` for an agent
   token — so every agent-created task emitted `task.created` with
   `actor_type='system'`. That silently disarmed BOTH enforcement points D7
   depends on: `resolveAgentChainDepth` keys on `actor_type='agent'`, and
   `triggers.ts` self-exclusion compares `actorType === "agent" && actorId ===
   agentId`. The loop `tasks:create` opens was therefore unbounded even with the
   depth column in place, and an agent did not exclude its own task events.
   Fixed by threading a `SocialActor` through `CreateTaskContext` and passing
   `socialActorForToken(ctx.actor)` from the ext route; pinned by asserting
   `actor_type='agent'` AND `run_id` on the emitted row. **`run_id` alone was not
   enough — T21a as written closed only half the hole.**

5. **`compose.yml` / `compose.production.yml` contain no web or supervisor
   service block** — only Postgres is containerized (ADR-023; web and supervisor
   run on the host via pnpm). The plan's deployment-touchpoint table asked for a
   web `environment:` block that does not exist. The real touchpoints are
   `.env.example` and the `docs/configuration.md` env table, both done.
   `MAISTER_CONTEXT_REPOS` is deliberately NOT in `.env.example` as a settable
   var — the supervisor derives it per child.

6. **Deferred, owner decision (not a defect):** `canAgentReachProject` checks
   `agent_project_links` only — never `agents.enabled` or `agents.quarantined_at`.
   An admin disabling an agent row leaves a live run-bound token able to keep
   reaching cross-project until that run ends. This MATCHES same-project
   behavior (the token is the authority there too), so tightening it
   cross-project only would be an inconsistency; tightening both is a scope
   change beyond this plan.

7. **The plan's claim that `pnpm validate:docs` "only parses Mermaid" is wrong.**
   `package.json` defines it as
   `validate-docs-mermaid.mjs && validate-docs-adr-anchors.mjs`, so it DOES
   resolve `[ADR-NNN](decisions.md#…)` anchors. What it does NOT validate is the
   OpenAPI/AsyncAPI specs — that is `pnpm validate:contracts` (T7a's point
   stands; only the stated reason was wrong).

8. **`workspace_reconciliation_findings` is the WRONG store for the context-mount
   GC marker**, despite `reconciliation-gc.md` implying it. Its `candidate_kind`
   CHECK has only four values, and `loadDueReconciliationFindings` carries no
   kind predicate — context-mount rows would be claimed and processed by the
   *workspace reconciler itself*. The sweep keeps the ADR-142 semantics
   (durable marker, bounded backoff, poison policy) in a purpose-built on-disk
   marker under `<runDir>/context/.gc/` instead.

9. **`WaitingOnChildren` belongs in the context-mount live allow-list**, which
   `reconciliation-gc.md` originally omitted. A parked orchestrator WILL be woken
   by a child-terminal event and resumed via `session/resume` into the same node,
   so reaping its mounts mid-park hands the resumed coordinator paths that no
   longer exist — the same argument the doc already makes for `Review`, in its
   strongest form. Code and doc now agree.

10. **Terminal release is wired at four chokes**, not every path that terminalizes
    a run: the graph terminal chain, `finalizeAgentRun`, `markAbandoned`, and
    `promoteRun`. Five long-tail paths (keepalive TTL abandon, orchestrator
    cascade, `services/hitl.ts`, `services/agent-question.ts`, scratch discard)
    have no shared choke and fall to the GC backstop within one `system_sweep`
    tick — the same deferral the run's own worktree already relies on. Stated
    rather than implied.
