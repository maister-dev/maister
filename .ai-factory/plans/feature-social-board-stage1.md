# Implementation Plan: Social board layer — Stage 1 (task numbering, relations, comments / activity / subscribers / inbox)

Branch: `feature/social-board-stage1`
Created: 2026-06-11
Base: `main` @ `19888156` (worktree `infallible-jemison-9f23bf`, HEAD == main at branch time)
Mode: full (schema + domain + API + ext/MCP + UI)

## Settings
- Testing: yes (unit + integration mandatory per phase; one e2e happy path; component tests per repo convention)
- Logging: verbose (pino child loggers per module, `lib/tokens/ext-handler.ts` style; DEBUG for allocation/expansion/fanout internals, INFO for writes, WARN for validation rejects)
- Docs: yes — mandatory docs checkpoint; Phase 1 is docs/spec-first per skill-context front-load rule

## Roadmap Linkage
Milestone: "M31. Social board layer — Stage 1" — new entry to add to
`.ai-factory/ROADMAP.md` at ship time (roadmap currently ends at M27; M28
run-schedules and M29 harness-loop are merged but un-ticked there; M30 is
reserved by the unmerged gate-chat plan).
Rationale: first executable slice of the validated platform-agents + social
board design (Layer 2, Stage 1) — the substrate (numbering, relations,
polymorphic actor, inbox) that later agent-actor stages build on.

---

## 0. Scope and ground truth

### 0.1 Goal

Give every task a stable per-project identity (`KEY-N`), typed relations that
gate launchability, and a social substrate — comments with task-mentions,
domain-written activity, auto-subscriptions, and a per-user inbox — surfaced
on a new task detail page, a project Log page, and the portfolio. Polymorphic
actor (`user | agent | system`) on all four social tables; **no agent runtime
in this stage** — only `user`/`system` actors are ever written, `agent` is
schema-supported only.

### 0.2 Source spec

⚠ The referenced design doc `docs/plans/2026-06-11-platform-agents-social-board-design.md`
does **not exist** in the repo (verified: no `*social*` / `*platform-agents*`
file in worktree or main checkout). Per owner decision (2026-06-11), the
authoritative Stage-1 spec is the `/aif-plan` command text, restated through
this plan. If the design doc lands later, reconcile §1 decisions against it
before Phase 2.

### 0.3 Verified code facts this plan is built on

| Fact | Where |
| --- | --- |
| Single schema file; text PKs (`crypto.randomUUID()`), `text("col", { enum: […] })` inline enums (no `pgEnum`), `timestamp(…, { withTimezone: true, mode: "date" })`, composite `unique("name").on(…)` + `index()` in constraint tuple | `web/lib/db/schema.ts` (~2216 lines) |
| `projects`: `id, slug UNIQUE, name, repoPath UNIQUE, repoUrl, provider, mainBranch, branchPrefix, maisterYamlPath, defaultRunnerId, promotionMode, createdAt, archivedAt` — no task_key/counter today | `web/lib/db/schema.ts:108-124` |
| `tasks`: `id, projectId FK cascade, title, prompt, flowId FK, status enum(Backlog\|InFlight\|Done\|Abandoned), stage, attemptNumber, createdByUserId FK set-null, createdAt, updatedAt` + `unique(id, attemptNumber)` + `index(projectId, status)` — no number today | `web/lib/db/schema.ts:821-859` |
| Task creation: `createTask(input {title,prompt,flowId}, ctx {projectId, actorUserId?}, db?)` — **no transaction today** (bare `_db.insert`, returns `{taskId}` only); the shared `TaskDTO` (`taskToDTO`) serves BOTH internal and ext task routes | `web/lib/services/tasks.ts:34-73,88-141`, `web/app/api/projects/[slug]/tasks/route.ts`, `web/app/api/v1/ext/projects/[slug]/tasks/*` |
| Launchability classifier (M28): pure `classifyTaskLaunchability(task {status}, latestRun {status}\|null): "launchable"\|"busy"\|"crashed"\|"target_terminal"` + `getLatestFlowRun` | `web/lib/runs/launchability.ts` |
| Classifier call sites: run-schedules dispatcher (`decideFire`), board/portfolio read models, 20-case unit suite | `web/lib/run-schedules/dispatch.ts:238-239`, `web/lib/queries/project.ts`, `web/lib/queries/portfolio.ts`, `web/lib/runs/__tests__/launchability.test.ts` |
| `launchRun` gate is ALREADY classifier-based: `classifyTaskLaunchability(task, latestFlowRun) !== "launchable"` → `PRECONDITION` with the classification in the message; task `InFlight` flip + `attemptNumber` bump in the launch tx; ext `POST /api/v1/ext/runs` delegates to the same `launchRun` (single choke point, verified) | `web/lib/services/runs.ts:242-250,789-795`, `web/app/api/v1/ext/runs/route.ts:87` |
| Only TWO `update(tasks)` sites exist in the whole codebase: the launch flip (`InFlight` + attempt bump) and `updateTask` (title/prompt, Backlog-gated). **Nothing ever writes task `Done`/`Abandoned`** — one-way latch; Done/Abandoned board columns are projections (`lib/board.ts`) | `web/lib/services/runs.ts:789`, `web/lib/services/tasks.ts:148-189`, grep-verified |
| Run terminal writes are scattered (~10 sites, no `setRunStatus` choke point) | M28 plan fact, `runner.ts`/`runner-graph.ts`/`state-transitions.ts`/`promote.ts` |
| Transaction idiom: `db.transaction(async (tx) => …)`; race-safe insert via `.onConflictDoNothing().returning()` → empty array ⇒ `CONFLICT` | `web/app/api/projects/route.ts:248`, `web/app/api/admin/acp-runners/route.ts:295-310` |
| `users.id` = UUID string; session via `getSessionUser()` (DB-authoritative re-read) | `web/lib/authz.ts:87-109` |
| Authz: `requireProjectAction(projectId, action)` + `PROJECT_ACTION_MIN` (`createTask`/`launchRun` → `member`) | `web/lib/authz.ts` |
| Polymorphic-actor precedent exists but mismatched: `actor_identities.kind = user\|api_token\|internal_agent\|system` — schema-designed, only `user` written today | `web/lib/db/schema.ts:439-478` |
| Audit precedent: `token_audit_log` append-only (actor_label, scope_used, endpoint, method, result, status_code) | `web/lib/db/schema.ts:2181-2210` |
| Ext API: `handleExt()` wrapper — Bearer → `verifyToken()` → `TokenActor {tokenId, projectId, tokenKind, scopes, ownerUserId}` → `tokenHasScope` → handler → `recordRequiredTokenAudit` in-tx (`successAuditInWork: true`); `httpStatusForExtCode` | `web/lib/tokens/ext-handler.ts`, existing routes under `web/app/api/v1/ext/` |
| Ext task routes exist: `GET/POST /api/v1/ext/projects/[slug]/tasks`, `GET/PATCH …/tasks/[taskId]` | `web/app/api/v1/ext/projects/[slug]/tasks/` |
| Token scopes: single source `TOKEN_SCOPES` const (9 scopes today); no other code consumer found by grep (UI/docs enumerate independently — re-grep at impl) | `web/types/token-scopes.ts` |
| MCP facade: `TOOL_SPECS` record + `resolveRouting()` + `dispatchTool()` → `callExt()` HTTP+Bearer; ~14 tools incl. `hitl_list`/`hitl_respond` | `mcp/src/tools.ts` |
| Internal route exemplar: zod `.strict()`, auth-first, local `httpStatusForCode` (CONFIG→400 in runs family; tasks route maps CONFIG→422 — follow the runs-family mapping for new routes), JSON error `{code, message}` | `web/app/api/runs/route.ts` |
| Errors: `MaisterError` from `lib/errors-core.ts` (client-safe) re-exported by server-only `lib/errors.ts`; UI branches on `code` | `web/lib/errors-core.ts`, `web/lib/errors.ts` |
| Board projection precedence (Crashed → own column; latest ∈ {Failed, Abandoned} → Backlog-retry) | `web/lib/board.ts:80-128` |
| Task card: `BacklogCard` DTO; card renders priority stripe + flowRef chip; `LaunchPopover` + `NewTaskModal` (fetch-to-route, no server actions) | `web/components/board/task-card.tsx`, `web/lib/queries/board.ts` |
| Run detail layout = persistent heavy-load boundary: diff (`lib/diff/prepare.ts`), timeline (`getRunTimeline`), flow graph (`buildGraphTopology` + `getRunNodeStatuses`); reusable components `flow-graph-view-section.tsx`, `workbench/run-diff.tsx` (`{runId, labels, review?}`), `board/run-timeline.tsx` | `web/app/(app)/runs/[runId]/layout.tsx:136-141,222,273-275` |
| "Needs you (N)" has TWO scopes: portfolio = `getCrossProjectHitlInbox(userId, role)`; board page = project-scoped `getHitlInbox(projectId)` → `{items, count, oldest}` rendered at the board header (`hitl.count` at :151) | `web/app/(app)/page.tsx:25,81-103,151`, `web/app/(app)/projects/[slug]/page.tsx:117,151,227`, `web/lib/queries/hitl.ts:217`, `web/components/portfolio/hitl-inbox-block.tsx` |
| Project registration: `POST /api/projects` (admin), body `{repoUrl? \| target?}` `.refine`, `withRegistrationLock`, slug/repoPath collision → 409, atomic tx then flow-install compensation; form `new-project-form.tsx` | `web/app/api/projects/route.ts:201-215,248`, `web/components/projects/new-project-form.tsx` |
| `MAISTER_PROJECTS_DIR` auto-discovery is **NOT implemented** — zero code consumers; `web/lib/projects.ts` does not exist (architecture-doc aspiration only) | grep-verified across `web/` + `supervisor/` |
| `check()` constraints are house-style in schema.ts (review_comments anchor/side/status checks); drizzle-orm `^0.36.4` / drizzle-kit `^0.28.1` | `web/lib/db/schema.ts:1965-1975`, `web/package.json` |
| `e2e/_seed/seed-e2e.ts` (4652 lines) seeds via RAW `pg` SQL — 8+ `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)` sites + project insert helpers; all will omit the new NOT NULL columns | `web/e2e/_seed/seed-e2e.ts:1165,1265,1464,1641,1941,1964,2113,2252` |
| `run-diff` consumes PREPARED diff data (`PreparedFile`/`RunDiffFile` types); the run layout prepares via `lib/diff/prepare.ts`; git-diff-view server code imports from `/core`, plain DTO across the RSC boundary (ADR-066) | `web/components/workbench/run-diff.tsx:11-23`, `web/app/(app)/runs/[runId]/layout.tsx:136-141` |
| Ext token→user mapping helper already exists: `actorUserIdForToken` | `web/lib/tokens/verify.ts` (imported by `ext/runs/route.ts:16`) |
| i18n: `web/messages/{en,ru}.json` flat per-feature namespaces; `getTranslations` (RSC) / `useTranslations` (client); **parity enforced by test** | `web/lib/__tests__/i18n-parity.test.ts:26-37` |
| Tests: vitest projects `unit` (globs `lib/**`, `app/**/__tests__/**`, `components/**`) and `integration` (`**/*.integration.test.ts`, testcontainers postgres:16-alpine, self-contained per suite, 60s timeouts); component tests render via `renderToStaticMarkup` (no jsdom) | `web/vitest.workspace.ts:17-27`, repo convention |
| e2e: Playwright port 3100 (`E2E_PORT`), stub supervisor :7788, `e2e/_seed/seed-e2e.ts`, authed project via `e2e/auth.setup.ts` storageState; shared infra across worktrees — kill 3100/7788 first; ~10 pre-existing e2e reds are main's debt (baseline-prove before blaming the branch) | `web/playwright.config.ts`, memory `maister-e2e-shared-infra-trap` |
| Migrations: `web/lib/db/migrations/`, latest `0039_review_comments.sql`, journal v7; `db:generate` = `drizzle-kit generate`, `db:migrate` = `tsx lib/db/migrate.ts`; ⚠ never `generate --custom` (stale-snapshot gotcha), never edit journal `when` | `web/lib/db/migrations/meta/_journal.json`, memories `drizzle-*` |
| Lint: `pnpm --filter maister-web lint` runs `eslint --fix` repo-wide (reformats ~60 files) — gate with check-only `pnpm exec eslint .` or scoped `--fix` | memory `maister-pnpm-lint-reformats-repo` |
| `react-markdown@9.0.1` + `remark-gfm@4.0.0` are ALREADY dependencies, with a safe-by-default precedent wrapper (`Markdown`, remark-only, no rehype-raw) in the scratch transcript; no toast lib; client mutations = `fetch` to route handlers + `useState` errors keyed by `MaisterError.code` | `web/package.json`, `web/components/scratch/scratch-transcript.tsx:72-80` |
| No `console.log` — pino only (`no-console: warn`) | `web/eslint.config.mjs` |

### 0.4 Provisional global numbers + re-verify contract (T0.1)

Verified against `main` HEAD `19888156` on 2026-06-11:

| Artifact | Provisional value | Collision risk |
| --- | --- | --- |
| ADR | **ADR-075** (decisions.md tops out at ADR-074) | gate-chat plan reserves ADR-075..079; outbound-webhooks (implemented, unmerged) claims ADR-075. Whichever merges first takes it. |
| Migration | **0040_social_board** (journal ends at 0039) | gate-chat reserves 0040; outbound-webhooks claims 0040. |
| Roadmap milestone | **M31** | M30 reserved by gate-chat. |

**Contract:** T0.1 re-greps `main` HEAD at implementation time:
`git show main:docs/decisions.md | grep -oE 'ADR-[0-9]+' | sort -V | tail -1`
(**`sort -V`, not tail-of-file** — ADR-066 sits out of order mid-file) and
`git show main:web/lib/db/migrations/meta/_journal.json | grep -oE '"tag": "[0-9]+' | sort -V | tail -1`,
then renumbers every placeholder in this plan + ADR + migration before any
code. Renumbering rules (patches 2026-06-10-23.57 + 2026-06-09-18.47):
**never a global find-replace** — enumerate every `ADR-075`/`0040` occurrence
and classify it by which feature it names (this plan's §0.4 prose
legitimately references the SIBLINGS' claims on the same numbers — those
references must NOT be rewritten). Markdown anchor links lowercase the ADR id
— a second pass over `(decisions.md#adr-0nn…)` anchors is required, and
`validate-docs-adr-anchors` is blind to `_`-slugged anchors — re-run it AND
eyeball-grep both forms.

### 0.5 Locked constraints / out of scope

- **No agent runtime.** `actor_type='agent'` and `recipient_type='agent'` are schema-legal, never written in Stage 1. No triager, no agent sessions, no agent rows.
- **Single migration** (`0040_social_board.sql`) covering all DDL + data backfill.
- `task_activity` rows are written **only by the domain layer** (`web/lib/social/*` + the named service write-sites in D7) — never directly by route handlers.
- Existing conventions binding: `MaisterError` only, atomic `.maister/` writes N/A here, EN+RU i18n with parity test, strict TS (no `any`), view-table + popup-edit data pages, fetch-to-route-handler mutations, pino logging.
- Out of scope (Stage 2+ of the design): agent actors writing comments/activity, agent inbox consumption, @user/@agent mentions, task_key rename/migration tooling, cross-project relations, websocket/SSE live comment updates, comment editing/deleting/threading, full Kanban mechanics, outbound webhooks integration.

---

## 1. Design decisions

### D1 — Numbering allocation: counter column + `UPDATE … RETURNING` in a NEW `createTask` transaction

`projects.next_task_number integer NOT NULL DEFAULT 1`. Allocation:

```ts
const [{ allocated }] = await tx
  .update(projects)
  .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
  .where(eq(projects.id, projectId))
  .returning({ allocated: projects.nextTaskNumber });
const number = allocated - 1;
```

⚠ `createTask` is NOT transactional today (verified: bare `_db.insert`) —
T3.1 introduces the transaction (allocation + task insert + `task_created`
activity + `creator` subscription in ONE `db.transaction`; the flow-ownership
validation may stay outside it). The `db?` param may already carry a caller
tx — drizzle nests via savepoint, acceptable. The projects-row lock
serializes concurrent creates; `UNIQUE(project_id, number)`
on `tasks` is the backstop (violation ⇒ bug, not user error). Rejected:
`max(number)+1` (racy), per-project sequences (DDL-at-runtime), global sequence
(numbers must be per-project dense-ish). Numbers are never reused; deleting a
task leaves a hole — documented.

### D2 — `task_key`: platform-unique, immutable in Stage 1

- Format: `^[A-Z][A-Z0-9]{1,9}$` (2–10 chars). Shared TS validator + derivation util `deriveTaskKey(name)` = first 3 `[A-Za-z]` chars of project name, uppercased; pad from slug if name yields <2 letters.
- **Platform-wide UNIQUE** (`projects.task_key UNIQUE`): `KEY-N` mention resolution is global — two projects sharing `MAI` would make `MAI-12` ambiguous.
- Editable **only at creation**: optional `taskKey` field on `POST /api/projects` body (label: `body-controlled` — validated by regex allow-list + uniqueness check ⇒ `CONFLICT`; it names no filesystem path and no cross-resource lookup, it becomes a new attribute of the resource being created). Explicit-registration collision with derived/given key ⇒ refuse with `CONFLICT` (same semantics as slug collision). Migration backfill cannot ask ⇒ auto-uniquify: widen to 4 letters, then append `2`, `3`, … (deterministic, ordered by `created_at`). `MAISTER_PROJECTS_DIR` auto-discovery is unimplemented (verified) — no third key source exists.
- Immutable because comment bodies store **expanded** `KEY-N` links (D6); rename would strand them. Rename tooling = Stage 2.

### D3 — Polymorphic actor = `(actor_type, actor_id)` pair, not an `actor_identities` FK

Command-spec is explicit, and `actor_identities.kind` (`user|api_token|internal_agent|system`)
does not match the design's `user|agent|system` taxonomy; there is also no
agents table to join yet. The pair is self-contained for fanout SQL
(`INSERT … SELECT` compares subscriber pair vs actor pair without joins).
Columns on all four tables: `actor_type text CHECK in ('user','agent','system')`,
`actor_id text` with `CHECK ((actor_type = 'system') = (actor_id IS NULL))`.
No FK to `users` (polymorphic target) — a deleted user leaves a dangling id;
UI renders a "former user" fallback label. ADR-075 records the relationship to
`actor_identities` (parallel precedent, deliberately not reused) and the
Stage-1 write restriction (`user`/`system` only).

### D4 — Relations: canonical one-direction rows, inverses rendered

`task_relations (id, project_id, from_task_id, kind text CHECK in ('blocks','depends_on','parent_of'), to_task_id, actor_type, actor_id, created_at)`
with `UNIQUE(from_task_id, kind, to_task_id)`, `CHECK (from_task_id <> to_task_id)`,
both task FKs `ON DELETE cascade`, index on `to_task_id` (inverse lookups).
Same-project only in Stage 1 — enforced in the domain layer (cross-table CHECK
impossible), `CONFIG` on violation, integration-tested. Inverse labels are
render-time: `blocks` ↔ "blocked by", `depends_on` ↔ "required by",
`parent_of` ↔ "child of". No cycle detection: `A blocks B` + `B blocks A`
makes both unlaunchable until a relation is removed — documented edge case
(UI always shows the blocking task as a removable chip, so the user can
always recover).

### D5 — Launchability: new `"blocked"` classification, fanned to ALL consumers

`classifyTaskLaunchability` gains an optional third input
`relationGate?: { openBlockers: Array<{ key: string; number: number }> }` and a
new return value `"blocked"`. Precedence: `target_terminal` > `crashed` >
`busy` > `blocked` > `launchable` — relations only gate *launching*, they never
mask an active run's state. Blocking predicate (computed by a new batch query
`getOpenRelationBlockers(taskIds, db)`): task T is relation-blocked iff ∃
relation `(X blocks T)` or `(T depends_on Y)` where the counterpart task's
status ∈ {`Backlog`, `InFlight`} (i.e. `Done` releases, `Abandoned` releases —
a discarded blocker must not deadlock its dependents). `parent_of` never
gates.

Consumer fan-out (skill-context rule — allow-list, every consumer updated in
the same phase):

1. `web/lib/queries/project.ts` + `web/lib/queries/portfolio.ts` board read models — batch-load blockers (one grouped query, no N+1), pass to classifier, expose `blockedBy: KeyRef[]` on the card DTO.
2. `web/lib/run-schedules/dispatch.ts:238-239` — thread relation context into the existing `classifyTaskLaunchability` call; `blocked` ⇒ skip with reason in the attempt `summary` (mirrors existing skip semantics).
3. `web/lib/services/runs.ts:242-250` — `launchRun` ALREADY rejects on the classification (`launchability !== "launchable"`, classification string in the message — the patch-2026-06-10-20.48-compliant shape: precondition expressed in the classifier's terms). The change is ONLY threading relation context into that call; `"blocked"` then hard-refuses internal `POST /api/runs` AND ext `POST /api/v1/ext/runs` (verified: ext delegates to `launchRun` at `ext/runs/route.ts:87`). Append blocker `KEY-N`s to the message for operators.
4. `web/components/board/task-card.tsx` — launch disabled + reason chip listing blocker `KEY-N`s (i18n EN+RU).
5. `web/lib/runs/__tests__/launchability.test.ts` — extend the 20-case matrix with blocked × {backlog, busy, crashed, terminal} combinations.

### D6 — Mention expansion at write time, stored expanded

`web/lib/social/mentions.ts`: `expandMentions(body, db) → { expanded, mentioned: Array<{taskId, projectId, key, number}> }`.
- Token regex: `\b([A-Z][A-Z0-9]{1,9})-(\d+)\b`.
- Skip zones (scanned, not regex-only): fenced code blocks (``` / ~~~), inline code spans (backtick runs), existing markdown links `[…](…)` (both label and target). Implementation: segment the body, expand only in plain-text segments.
- Each candidate `KEY-N` resolves via `(projects.task_key = KEY) JOIN (tasks.project_id, tasks.number = N)`; unresolved candidates stay literal text.
- Resolved mentions become `[KEY-N](/projects/<slug>/tasks/<number>)` and the **expanded** body is what `task_comments.body` stores (single render path, immutable history; the cost — stale links after slug rename — is accepted and documented).

### D7 — Comment pipeline: ONE `db.transaction`, activity written only by the domain layer

`addTaskComment({ taskId, body, actor }, db)` in `web/lib/social/comments.ts`, single tx:

1. Resolve task + project (server-state), expand mentions (D6).
2. `INSERT task_comments` (expanded body, actor pair).
3. `INSERT task_activity`: `comment_added` on the commented task; `task_mentioned` on each mentioned task (payload: `{fromTaskId, fromKey, commentId}`).
4. Upsert subscriptions (`ON CONFLICT DO NOTHING` — first reason wins): commenter → commented task (`commenter`); mention rule per D8.
5. Inbox fanout (D9): one `INSERT … SELECT` over the commented task's subscribers + one per mentioned task's subscribers, each excluding the acting pair.

No external side-effect inside the tx (no supervisor call, no fs write) ⇒ the
two-phase-commit rule is satisfied trivially; the multi-store rule is
satisfied by full atomicity (all five steps one tx).

**Activity event kinds** (text + CHECK, enumerated for ADR + analytics doc):
`task_created | comment_added | task_mentioned | relation_added | relation_removed | run_launched`.
(`task_status_changed` was CUT: grep-verified, only two `update(tasks)` sites
exist — the launch flip, covered by `run_launched` in the same tx, and
title/prompt `updateTask`. Task `Done`/`Abandoned` are never written anywhere;
board columns are projections. Status events join when real writers appear.)
Write sites (the ONLY writers, all via `recordTaskActivity` from `web/lib/social/activity.ts`):
- `task_created` — `createTask` (`lib/services/tasks.ts`), actor = creating user.
- `comment_added`, `task_mentioned` — `addTaskComment`.
- `relation_added`, `relation_removed` — relations domain fns.
- `run_launched` — the `launchRun` task-flip tx (`runs.ts:789-795`; payload: `{runId, attemptNumber}`), actor = launching user or `system` (scheduler fires with `actorUserId: null` ⇒ `system`).
- **Deliberately deferred:** `run_finished` — run-terminal writes are scattered across ~10 sites with no choke point (verified M28 fact); wiring activity into all of them is high-risk noise. Fast-follow once a `setRunStatus` choke point exists (gate-chat F4 may introduce one). Documented in analytics doc as `(Phase 2)`.

### D8 — Subscription semantics (auto-subscribe on create / comment / mention)

`task_subscribers (task_id, subscriber_type CHECK in ('user','agent'), subscriber_id NOT NULL, reason CHECK in ('creator','commenter','mentioned','manual'), created_at)`
+ `UNIQUE(task_id, subscriber_type, subscriber_id)`.
- create → creator subscribed to the new task (`creator`) — inside `createTask` tx.
- comment → commenter subscribed to the commented task (`commenter`).
- mention of task B in a comment on task A → **B's creator subscribed to task A** (`mentioned`) — the only coherent person-target while mentions are task-typed; brings the owner of the referenced work into the discussion. (Default pending owner confirmation — unresolved Q1.)
- `manual` reserved for the task-page follow/unfollow button: **in scope** (small UI affordance, completes the enum): `POST/DELETE /api/projects/[slug]/tasks/[number]/subscription` for self only.
- `system` never subscribes (subscriber_type has no `system`).

### D9 — Inbox: batch `INSERT … SELECT` over subscribers, recipient pair, read marker

`inbox_items (id, recipient_type CHECK in ('user','agent'), recipient_id NOT NULL, project_id FK cascade, task_id FK cascade, event_kind, source_ref jsonb, read_at timestamptz NULL, created_at)`
+ index `(recipient_type, recipient_id, read_at, created_at DESC)`.
- Fanout (inside the same tx as the triggering write):
  `INSERT INTO inbox_items (…) SELECT … FROM task_subscribers WHERE task_id = $1 AND NOT (subscriber_type = $actorType AND subscriber_id = $actorId)`.
- Fanout triggers in Stage 1: `comment_added` (commented task's subscribers) and `task_mentioned` (mentioned task's subscribers). Activity kinds without fanout: `task_created`, `relation_*`, `run_launched`, `task_status_changed` (Log page covers them; inbox stays high-signal).
- `source_ref` = `{ kind: 'comment'|'mention', taskId, commentId, activityId }`.
- `recipient_type='agent'` rows are schema-legal, never produced in Stage 1 (no agent subscribers exist).
- Read tracking: `PATCH /api/inbox/[itemId]/read` (recipient must equal session user — `auth-context`, 404 on others' items) + `POST /api/inbox/read-all`. Unread count feeds "Needs you (N)" (D11).

### D10 — Comment rendering: reuse the EXISTING `react-markdown` + `remark-gfm` stack

`react-markdown@9.0.1` and `remark-gfm@4.0.0` are already dependencies, with a
safe-by-default precedent: the local `Markdown` wrapper in
`web/components/scratch/scratch-transcript.tsx:72-80` (remark-only, no
`rehype-raw` ⇒ raw HTML in comments renders as text, no XSS). Extract it into
a shared `components/social/markdown-body.tsx` (client leaf) and re-point the
scratch transcript to the shared component — or, if extraction would disturb
scratch styling, copy the small pattern and note the duplication. Fenced code
as plain `<pre>` (no Shiki for comments in Stage 1). **Zero new dependencies,
zero deployment touchpoints.**
Rejected: hand-rolled renderer (markdown corner cases), `marked`+DOMPurify
(needs manual sanitization), storing pre-rendered HTML (XSS surface in DB).

### D11 — "Needs you (N)" = pending HITL + unread inbox

New `getUnreadInboxCount(userId, projectId?)` / `getInboxItems(userId, …)` in
`web/lib/queries/inbox.ts`. The badge has TWO verified scopes — extend both:
portfolio (`app/(app)/page.tsx:151`, cross-project via
`getCrossProjectHitlInbox`) += cross-project unread inbox; board page
(`app/(app)/projects/[slug]/page.tsx:151`, project-scoped via
`getHitlInbox(projectId)` from `lib/queries/hitl.ts:217`) += project-scoped
unread inbox.
Existing test to migrate: `web/lib/queries/__tests__/portfolio-inbox.integration.test.ts`
(count semantics change). The badge shows the sum; the panel splits "HITL" and
"Inbox" sections (HITL block unchanged, inbox panel is a sibling section
reusing the block's layout idiom).

### D12 — Ext/MCP comment ops: same domain path, token-audited, mapped actor

- Routes: `GET/POST /api/v1/ext/projects/[slug]/tasks/[taskId]/comments` (ext family keys tasks by `taskId` — keep consistent with existing ext task routes).
- New scopes `comments:read`, `comments:create` appended to `TOKEN_SCOPES`; grep every consumer of the scope list at impl (token-create UI scope picker if any, `docs/system-analytics/external-operations.md` scope table).
- Actor mapping: reuse the existing `actorUserIdForToken` helper (`web/lib/tokens/verify.ts`, already imported by `ext/runs/route.ts:16`): resolved user ⇒ `('user', userId)`; ownerless token ⇒ `('system', NULL)` with the token recorded in the comment-activity payload (`{via: 'ext', tokenId}`). (Unresolved Q4.)
- Both routes call the SAME `addTaskComment`/`listTaskComments` domain fns — no parallel write path. Audit via `recordRequiredTokenAudit` in-tx, identical to existing ext routes.
- MCP facade: `comment_create`, `comment_list` added to `TOOL_SPECS` + `resolveRouting` in `mcp/src/tools.ts`.

### Route identifier audit (skill-context rule)

| Route | Identifiers |
| --- | --- |
| `GET/POST /api/projects/[slug]/tasks/[number]/comments` | `slug` url-param → project (server-state); `number` url-param → task via `(project_id, number)` (server-state); actor = session (auth-context); body = `{body: string}` only — no body-controlled ids. Mention `KEY-N`s inside body are content, validated against DB existence (D6), unresolved ⇒ literal text. |
| `POST/DELETE /api/projects/[slug]/tasks/[number]/relations` | `slug`/`number` url-params (server-state resolution); body `{kind, toNumber}` — `kind` allow-list-validated; `toNumber` is `body-controlled` but resolved STRICTLY within the url-param project (`(project_id, number)` lookup, server-state comparison) ⇒ no cross-project reach; missing ⇒ 404-equivalent `PRECONDITION`. |
| `POST/DELETE /api/projects/[slug]/tasks/[number]/subscription` | url-params as above; subscriber = session user only (auth-context). |
| `PATCH /api/inbox/[itemId]/read`, `POST /api/inbox/read-all` | `itemId` url-param; recipient ownership enforced vs session (auth-context); no body ids. |
| `POST /api/projects` (extended) | new optional `taskKey` body field — `body-controlled`, regex allow-list + UNIQUE check ⇒ `CONFLICT`; names no path/lookup. |
| Ext comments routes | `slug`/`taskId` url-params cross-checked (task.project must match slug-project — 404 on mismatch, existing ext idiom); token (auth-context); body `{body}`. |

---

## 2. Contract surfaces → spec files (all updated in Phase 1, status-tagged per R6)

| Surface | Spec file(s) |
| --- | --- |
| 5 new tables + 3 new columns (`projects.task_key`, `projects.next_task_number`, `tasks.number`) | migration `0040_social_board.sql` + `docs/database-schema.md` + `docs/db/erd.md` + `docs/db/runs-domain.md` (tasks domain ERD) |
| Internal routes: comments GET/POST, relations POST/DELETE, subscription POST/DELETE, inbox PATCH/read-all, registration `taskKey` field | `docs/api/web.openapi.yaml` |
| Ext routes: comments GET/POST + 2 new token scopes | `docs/api/web.openapi.yaml` + `docs/system-analytics/external-operations.md` |
| Ext task responses gain additive `number` + `taskKey` fields (shared `TaskDTO` propagates automatically) | `docs/api/web.openapi.yaml` ext task schemas |
| MCP tools `comment_create` / `comment_list` | `docs/system-analytics/external-operations.md` |
| Launchability `"blocked"` + relations semantics + numbering | `docs/system-analytics/tasks.md` (update) + `docs/system-analytics/run-schedules.md` (decideFire skip reason) |
| Social domain (comments/activity/subscribers/inbox/mentions, actor model, event kinds, fanout) | **new** `docs/system-analytics/social-board.md` (R5 sections) |
| Decision record | `docs/decisions.md` ADR-075 (provisional) |
| Error codes | none new — reuse `PRECONDITION/CONFLICT/CONFIG/UNAUTHORIZED`; `docs/error-taxonomy.md` untouched unless impl proves otherwise |
| New UI strings | `web/messages/en.json` + `ru.json` (parity test enforces) |
| Root docs | `CLAUDE.md` "Built since baseline" line + `web/CLAUDE.md` if conventions surface changes (final phase) |

No new env vars / ports / sidecars / config files / dependencies ⇒ no Dockerfile/compose/.env.example/package.json tasks (deployment-touchpoint rule consciously discharged — D10 reuses existing deps).

---

## 3. Phases and tasks

Phase exit criteria (every phase): `pnpm --filter maister-web exec tsc --noEmit` clean; `pnpm --filter maister-web test:unit` and `test:integration` green; check-only eslint on touched files clean. A test the phase adds that cannot run (glob mismatch) fails the phase — runner project named per task.

### Phase 0 — Preflight (no code)

- [x] **T0.1 Re-verify global numbers against current `main`.** `sort -V` greps per §0.4 (NOT tail-of-file — ADR-066 sits out of order mid-file). If gate-chat / outbound-webhooks landed: renumber ADR-075→next-free, 0040→next-free, M31→next-free by **enumerating and classifying every occurrence** (patch 2026-06-10-23.57: never a global sed — §0.4 prose legitimately references the siblings' claims on the same numbers and must NOT be rewritten), including the lowercase `#adr-0nn` anchor second pass. Record the resolved numbers in this file under a `## Progress` note.
  Verify: every `ADR-075` / `0040_social_board` / `M31` occurrence in this plan names THIS feature's resolved number or is an explicitly sibling-referencing sentence.
- [x] **T0.2 Baseline gate.** Run typecheck + unit + integration at branch point; record any pre-existing reds (expected: none per repo state; ~10 e2e reds are main's known debt — list them, do NOT fix). Kill ports 3100/7788 before any e2e run.
  Verify: baseline list recorded in `## Progress`.

### Phase 1 — SDD: complete, internally consistent specs (docs-first)

- [x] **T1.1 ADR-075 "Social board substrate: per-project task numbering, typed relations, polymorphic actor"** in `docs/decisions.md`. Content: D1–D9, D12 (actor pair vs `actor_identities` rationale; counter allocation; canonical one-direction relations; `blocked` launchability; expansion-at-write; fanout pattern; agent schema-readiness + Stage-1 write restriction; event-kind enum + deferred `run_finished`). Link from the ADR index if one exists.
- [x] **T1.2 New `docs/system-analytics/social-board.md`** — R5 sections (Purpose, Domain entities, State machine [comment/inbox-item lifecycle + subscriber set], Process flows [comment pipeline sequence incl. tx boundary; mention expansion flowchart; inbox fanout], Expectations ≤12 RFC-2119 bullets, Edge cases [dangling actor ids, mention of deleted task, mutual blocks, hole-y numbering, unresolved KEY-N], Linked artifacts). Every section tagged `(Designed)` initially.
- [x] **T1.3 Update `docs/system-analytics/tasks.md`** — numbering (task_key, counter, KEY-N), relations + inverse rendering, launchability `blocked` extension; update `docs/system-analytics/run-schedules.md` decideFire skip-on-blocked row. Status tags per R6.
- [x] **T1.4 DB docs** — `docs/database-schema.md` table entries + `docs/db/erd.md` and `docs/db/runs-domain.md` Mermaid ERDs: 5 new tables, 3 new columns, FKs, uniques.
- [x] **T1.5 API specs** — `docs/api/web.openapi.yaml`: all routes from the identifier-audit table (paths, request/response bodies, status codes incl. 409 CONFLICT / 400 CONFIG mapping, examples); ext comments routes + scope labels; ext task response schemas gain additive `number`/`taskKey` fields (shared DTO, see T5.2); `docs/system-analytics/external-operations.md` scope table + MCP tool rows.
  Phase exit: docs cross-consistent (entity names/kinds identical across ADR/analytics/ERD/OpenAPI); anchor validation script green.
  ⚠ Deviation note (recon correction): the `/api/v1/ext/*` surface is spec'd in
  `docs/api/external/operations.openapi.yaml` (NOT in `web.openapi.yaml`, which
  carries no ext paths) — ext comment routes + `TaskDTO` additive fields landed
  there; internal routes + `PostProjectBody.taskKey` + `postTask` response landed
  in `web.openapi.yaml`. Both lint clean (redocly; only pre-existing warnings).

**Commit C1** — `docs(social-board): ADR-075 + stage-1 analytics/ERD/API specs`

### Phase 2 — Schema + single migration

- [x] **T2.1 Schema changes in `web/lib/db/schema.ts`** (exact shapes from D2/D3/D4/D8/D9): `projects.taskKey` (text NOT NULL + UNIQUE), `projects.nextTaskNumber` (integer NOT NULL default 1), `tasks.number` (integer NOT NULL) + `unique("tasks_project_number_uq").on(projectId, number)` + index; tables `task_relations`, `task_comments` (id, taskId FK cascade, projectId FK cascade, actor pair, body text, createdAt), `task_activity` (id, taskId, projectId, actor pair, eventKind CHECK, payload jsonb NOT NULL default '{}', createdAt; index `(task_id, created_at)`, `(project_id, created_at)`), `task_subscribers`, `inbox_items` — CHECKs and indexes per §1. Follow house idioms (text PK + `$defaultFn(randomUUID)`, withTimezone timestamps).
- [x] **T2.2 Generate + hand-finish migration `0040_social_board.sql`.** `pnpm --filter maister-web db:generate -- --name=social_board` (drizzle-kit `^0.28.1` writes `0040_social_board.sql` + journal tag directly; NOT `--custom` — stale-snapshot gotcha). Hand-edit ONLY the new-column ordering for live data: `tasks.number` and `projects.task_key` are added nullable → backfill → `SET NOT NULL` → add UNIQUEs, all inside this one file. Backfill SQL: per project, number tasks by `(created_at, id)` from 1 (window function); `next_task_number = COALESCE(max,0)+1`; `task_key` = derivation per D2 with deterministic uniquify (DO block). Final schema state must equal `schema.ts` exactly (snapshot stays truthful).
  Logging: none (SQL); migration runner already logs.
- [x] **T2.3 Migration integration test** (`web/lib/db/__tests__/social-board-migration.integration.test.ts`, runner: `integration` project, glob `lib/**/*.integration.test.ts` — matches). Fresh testcontainer: all migrations apply green; constraints exist (insert dup `(project_id, number)` ⇒ 23505; dup task_key ⇒ 23505; actor CHECK rejects `('system', 'x')`); seeded-then-migrated path: insert 2 projects + 3 tasks via SQL *before* 0040 within the test harness if the harness applies migrations stepwise — if the harness only supports apply-all (verify at impl), cover backfill by asserting derivation/uniquify logic in a unit test against the extracted TS util instead, and assert post-migration invariants (`next_task_number = max(number)+1`) on rows created pre-backfill via raw SQL replay. State which path was taken in the test header comment.
  Verify: `pnpm --filter maister-web test:integration` green; `pnpm --filter maister-web db:migrate` green on the dev DB.
- [x] **T2.4 Migrate raw-SQL fixtures to the new NOT NULL columns.** `web/e2e/_seed/seed-e2e.ts` seeds via raw `pg` SQL: 8+ `INSERT INTO tasks (id, project_id, title, prompt, flow_id, status, stage)` sites (lines ~1165, 1265, 1464, 1641, 1941, 1964, 2113, 2252) and the project insert helpers — every one must provide `number` (+ project `task_key`, consistent `next_task_number`). Add a small seed helper (per-project counter) instead of hand-numbering 8 sites. Also grep ALL test suites for raw `INSERT INTO tasks|projects` fixtures and fix identically (drizzle `.values()` call sites are compile-time-caught; raw SQL is the silent-breakage class).
  Verify: e2e global-setup (migrate + seed) completes against a fresh `maister_e2e` DB; integration suite green.

**Commit C2** — `feat(db): social-board schema + migration 0040 (numbering, relations, actor tables, inbox)`

### Phase 3 — Domain layer (TDD: tests first per module)

- [x] **T3.1 Task-key util + numbering in `createTask`.** `web/lib/social/task-key.ts` (`deriveTaskKey`, `validateTaskKey`, uniquify helper shared with backfill doc). Rework `createTask` (`web/lib/services/tasks.ts:34-73`): introduce a `db.transaction` (none exists today — bare insert) wrapping allocation per D1 + task insert + `task_created` activity + `creator` subscription (D7/D8); flow-ownership validation stays outside; return extends additively to `{taskId, number, taskKey}` (existing callers: internal route, ext create route, schedule paths).
  Tests (unit project): `web/lib/social/__tests__/task-key.test.ts` (derivation, regex, uniquify); `web/lib/services/__tests__/tasks-numbering.test.ts` (allocation increments, number assigned).
  Logging: `log.debug({projectId, allocated}, "task number allocated")`; `log.info({taskId, key, number}, "task created")` (extend existing logger).
- [x] **T3.2 Registration task_key.** `POST /api/projects` body gains optional `taskKey` (zod `.strict()` regex); default `deriveTaskKey(config.project.name)`; collision (given OR derived) ⇒ `MaisterError("CONFLICT")`. Single code path: `web/app/api/projects/route.ts` (`MAISTER_PROJECTS_DIR` auto-discovery is unimplemented — verified, no second path exists).
  Tests: unit (validation/derivation paths); integration `web/app/api/projects/__tests__/*.integration.test.ts` extension if present, else `web/lib/__tests__/project-registration-taskkey.integration.test.ts` (explicit + derived collision refusal).
  Logging: `log.info({slug, taskKey, source: "explicit"|"derived"}, "task key assigned")`.
- [x] **T3.3 Mention expansion `web/lib/social/mentions.ts`** per D6 (pure segmentation + db resolution split: `segmentMarkdown(body)` pure, `expandMentions(body, db)` composed — pure part unit-testable without DB).
  Tests (unit): fences (``` and ~~~, nested ticks), inline code, existing links (label+target), multiple mentions, unknown KEY-N untouched, KEY-N at string edges, lowercase `mai-12` NOT matched.
  Logging: `log.debug({candidates, resolved}, "mentions expanded")`.
- [x] **T3.4 Relations domain `web/lib/social/relations.ts`.** `addTaskRelation` / `removeTaskRelation` (same-project enforcement ⇒ `CONFIG`; self ⇒ `CONFIG`; dup ⇒ idempotent no-op via `.onConflictDoNothing().returning()` — empty result returns existing state, no error; activity `relation_added`/`relation_removed` in tx). `getOpenRelationBlockers(taskIds, db)` batch query (D5) + `getTaskRelations(taskId)` for rendering (both directions, inverse-labeled).
  Tests (unit + one integration for the batch query shape): validation matrix, idempotency, inverse rendering DTO.
  Logging: `log.info({fromTaskId, kind, toTaskId, actor}, "relation added|removed")`.
- [x] **T3.5 Launchability extension** per D5: extend the pure classifier (signature + `"blocked"`) and thread relation context into its two verified call sites — `runs.ts:242-243` (launchRun already rejects on the classification; append blocker `KEY-N`s to the message) and `dispatch.ts:238-239` (decideFire skip + summary reason) — plus the board/portfolio read models. NO separate ext guard needed (ext delegates to `launchRun`, verified `ext/runs/route.ts:87`).
  Tests: extend `web/lib/runs/__tests__/launchability.test.ts` (named existing file — assertions WILL change: new param) + `decideFire` skip case in run-schedules tests (`web/lib/run-schedules/__tests__/*`).
  Logging: dispatch skip reason in attempt summary; `log.warn({taskId, blockers}, "launch refused: blocked")` in launchRun.
- [x] **T3.6 Comments + activity + subscriptions + inbox domain.** `web/lib/social/{comments,activity,subscriptions,inbox}.ts` per D7/D8/D9: `addTaskComment` (full tx), `listTaskComments(taskId, paging)`, `recordTaskActivity` (the ONLY activity writer; module doc-comment states the domain-only rule), `subscribe(taskId, pair, reason)`, `unsubscribe`, `fanoutToSubscribers(tx, taskId, event, excludeActor)`. Wire `run_launched` activity into the launch task-flip tx (`runs.ts:789-795` — the only real task-status transition; `task_status_changed` was cut per D7).
  Tests (unit project, pure parts; integration for tx semantics): subscription reasons (first-wins), fanout excludes actor, system actor rows (`run_launched` via scheduler path), mention → activity on mentioned task + creator-of-B subscription (D8 default).
  Logging: `log.info({taskId, commentId, mentions: n, fanout: n}, "comment added")`; `log.debug` per sub-step.
  Phase exit: unit + integration green, incl. migrated `launchability.test.ts`.

**Commit C3** — `feat(social): numbering, mentions, relations, comments/activity/subscribers/inbox domain + launchability gate`

### Phase 4 — HTTP + ext + MCP

- [x] **T4.1 Internal routes** (all: auth-first, `requireProjectAction`, zod `.strict()`, runs-family `httpStatusForCode` mapping, identifiers per §1 audit table): comments GET/POST + relations POST/DELETE + subscription POST/DELETE under `web/app/api/projects/[slug]/tasks/[number]/…`; inbox `PATCH /api/inbox/[itemId]/read` + `POST /api/inbox/read-all`. New `PROJECT_ACTION_MIN` entries: `commentTask` → `member`, `manageTaskRelations` → `member`; reads ride existing viewer-level membership checks.
  Tests (integration, testcontainers): **numbering under concurrency** (N parallel `createTask` via route or service ⇒ N distinct sequential numbers, zero 23505), **auto-subscriptions** (create→creator, comment→commenter, mention→D8), **inbox batches** (M subscribers ⇒ M-1 items, actor excluded; read/read-all ownership enforced), relations validation (cross-project ⇒ CONFIG, authz 403 for viewer mutation).
- [x] **T4.2 Ext comments routes + scopes** per D12 (`web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route.ts`, scopes in `web/types/token-scopes.ts`, grep + update every scope-list consumer). Same domain fns; audit in-tx.
  Tests (integration): scope enforcement (403 w/o `comments:create`), audit row written with the new scope label, actor mapping (ownerUserId vs ownerless ⇒ system).
- [x] **T4.3 MCP facade tools** `comment_create` / `comment_list` in `mcp/src/tools.ts` (`TOOL_SPECS` + `resolveRouting`), following the `hitl_*` idiom; mcp package tests per its existing convention (verify runner at impl — mcp has its own package).
  Phase exit: integration suite green; OpenAPI matches implemented routes (spot-check paths/status codes against T1.5).

**Commit C4** — `feat(api): social-board internal routes + ext comment ops + MCP facade tools`

### Phase 5 — UI (EN+RU throughout; component tests via renderToStaticMarkup)

- [x] **T5.1 Task detail page `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`** (RSC; single page, no persistent layout needed in Stage 1). Sections: header (`KEY-N` chip, title, status, prompt, relations list with inverse labels + add/remove client island + follow/unfollow); **timeline** = comments + task_activity merged by `created_at` (new `components/social/task-timeline.tsx`, server-rendered items, `markdown-body.tsx` client leaf per D10) + composer client island (`fetch POST`, `router.refresh()`, error by `MaisterError.code`); **run history** table (all task runs: attempt, status, started, links to `/runs/[id]` and workbench); **latest run** flow-graph state via existing `flow-graph-view-section.tsx` (`buildGraphTopology` + `getRunNodeStatuses`) and branch diff via `workbench/run-diff.tsx` — note `run-diff` consumes PREPARED data (`PreparedFile`), so replicate the run-layout prep (`lib/diff/prepare.ts` per `runs/[runId]/layout.tsx:136-141`; factor a shared helper if clean) and honor ADR-066 gotchas (server imports from `/core`, plain DTO across the RSC boundary) — both sections only when a latest flow run exists. Markdown via the shared wrapper per D10 (zero new deps).
  Data: new `web/lib/queries/task-detail.ts` aggregate (one server fetch: task by `(slug, number)`, relations, comments+activity page, runs, latest-run bundle hooks into existing query fns).
  Tests: component tests for task-timeline (comment + activity interleave, markdown link render) and relations header; query unit test for interleave ordering.
- [x] **T5.2 KEY-N references fan-out.** Board card chip (`task-card.tsx` + `BacklogCard` at `lib/queries/board.ts:53`); the shared `TaskDTO` (`taskToDTO`, `lib/services/tasks.ts:88-111`) gains `number` + `taskKey` — auto-propagating to ext task responses (OpenAPI covered by T1.5); card title links to the task page; run detail header links back to `KEY-N` (`runs/[runId]/layout.tsx`); HITL inbox block items show `KEY-N`; portfolio workspace grid rows show `KEY-N` where task title renders (`lib/queries/portfolio.ts` DTO + components). Grep `title` renders fed by task DTOs to catch stragglers; enumerate touched files in the commit body.
- [x] **T5.3 Project Log page** `web/app/(app)/projects/[slug]/log/page.tsx` (or `?tab=log` if board tabs are the established nav — follow `project-tabs.tsx` precedent, decide at impl with a one-line note): read-only view-table per admin convention (canonical: `scheduler-jobs-table.tsx`), URL-param filters `actor_type`, `event_kind`, `task` (KEY-N), pagination; query `web/lib/queries/activity.ts`. No edit affordances.
  Tests: query filter unit tests; component smoke test.
- [x] **T5.4 Portfolio inbox panel + Needs-you** per D11: `components/portfolio/inbox-panel.tsx` (sibling of HITL block: item rows — `KEY-N`, project, event kind, snippet, read-state dot; mark-read on click + read-all button), `lib/queries/inbox.ts` with BOTH badge scopes: portfolio += cross-project unread (`page.tsx:151`), board += project-scoped unread (`projects/[slug]/page.tsx:151` beside `getHitlInbox`).
  Tests: migrate `portfolio-inbox.integration.test.ts` (named — count semantics change) + new integration for unread count; panel component test.
- [x] **T5.5 Registration form task_key field** (`components/projects/new-project-form.tsx`): optional input (uppercase hint, regex client check), error keys for `CONFLICT` (taken) / `CONFIG` (format) wired to existing `ERROR_KEY` map.
  Tests: component test for error mapping.
- [x] **T5.6 i18n.** New namespaces (`taskDetail`, `social`, `inbox`, `projectLog`) + additions (`board` launch-blocked reason, `projects.new` task_key labels) in `messages/en.json` AND `messages/ru.json`. RU translations done properly (not transliterated EN).
  Verify: `i18n-parity.test.ts` green (runner: unit project).
  Phase exit: full unit + integration green; check-only eslint on touched files; manual smoke `pnpm --filter maister-web dev` — task page renders for a seeded task.

**Commit C5** — `feat(ui): task detail page, KEY-N references, project log, portfolio inbox + needs-you`

### Phase 6 — e2e + gate + docs flip

- [x] **T6.1 e2e spec `web/e2e/social-board.spec.ts`** (authed project; extend `e2e/_seed/seed-e2e.ts` with a second seeded task to mention, via the raw-SQL insert helpers + numbering from T2.4 — beware the known seed gotchas fixed only on the unmerged acp-model-discovery branch: `default_runner_id` clobber at seed-e2e.ts:1536 and `getByLabel('Project')` collision — do not depend on those fixes). Flow: open `/projects/<slug>/tasks/<n>` → post comment containing `KEY-M` of the second task → timeline shows the comment with an expanded link + `comment_added` activity row → board card shows `KEY-N` chip. Kill ports 3100/7788 first; never `test:e2e -- --last-failed`.
- [x] **T6.2 Full gate.** `tsc --noEmit`; check-only `pnpm --filter maister-web exec eslint .`; `test:unit`; `test:integration`; `test:e2e` (compare against T0.2 baseline — only pre-existing reds tolerated, list them); `i18n-parity`; ADR anchor validation script. Record results in `## Progress`.
- [x] **T6.3 Docs finalization.** Flip `(Designed)` → `(Implemented)` tags in social-board.md / tasks.md / external-operations.md; add M31 entry to `.ai-factory/ROADMAP.md` with as-built note; add "Built since baseline" line to root `CLAUDE.md`; reconcile any drift between specs and as-built (specs win or get fixed — no silent skew).
- [x] **T6.4 Mandatory docs checkpoint** (Settings: Docs=yes): run `/aif-docs` for narrative docs (configuration/getting-started untouched expected — confirm no env/script changes leaked in).

**Commit C6** — `test(e2e)+docs: social-board happy path, gate results, status flips, roadmap M31`

---

## 4. Commit plan

| # | After | Message |
| --- | --- | --- |
| C1 | Phase 1 | `docs(social-board): ADR-075 + stage-1 analytics/ERD/API specs` |
| C2 | Phase 2 | `feat(db): social-board schema + migration 0040 (numbering, relations, actor tables, inbox)` |
| C3 | Phase 3 | `feat(social): numbering, mentions, relations, comments/activity/subscribers/inbox domain + launchability gate` |
| C4 | Phase 4 | `feat(api): social-board internal routes + ext comment ops + MCP facade tools` |
| C5 | Phase 5 | `feat(ui): task detail page, KEY-N references, project log, portfolio inbox + needs-you` |
| C6 | Phase 6 | `test(e2e)+docs: social-board happy path, gate results, status flips, roadmap M31` |

(Adjust ADR/migration numbers in C1/C2 messages if T0.1 renumbered.)

## 5. Verification gate (final, before merge offer)

1. `pnpm --filter maister-web exec tsc --noEmit` → 0 errors.
2. `pnpm --filter maister-web test:unit` → green (incl. migrated `launchability.test.ts`, i18n parity).
3. `pnpm --filter maister-web test:integration` → green (numbering concurrency, subscriptions, inbox batches, ext audit).
4. Kill 3100/7788 → `pnpm --filter maister-web test:e2e` → social-board spec green; delta vs T0.2 baseline = zero new reds.
5. Check-only eslint clean on touched files; no `console.log`; no `any` without `FIXME(any)`.
6. Migration: fresh DB `db:migrate` green AND dev DB with existing rows migrates green (backfill verified by spot SQL: every task numbered, `next_task_number` = max+1, task_key unique).
7. Docs: anchor validator green; OpenAPI paths match implemented routes; R6 tags flipped; ROADMAP M31 present.
8. Grep-proofs: `task_activity` inserts appear ONLY under `web/lib/social/` + named D7 write-sites; no `fs.watch`/`chokidar`/polling introduced; `TOKEN_SCOPES` consumers all list the new scopes.
9. Number-collision re-check vs `main` at merge time (patch 2026-06-09-18.47): diff this branch's new ADR number + migration `idx`/`tag` against current `main`; collision ⇒ renumber per T0.1 rules BEFORE the merge offer.

## Progress

### T0.1 — Global numbers re-verified (2026-06-11)

Checked against `main` HEAD `19888156` (== branch point, no sibling merges since plan creation):
- `git show main:docs/decisions.md | grep -oE 'ADR-[0-9]+' | sort -V | tail -1` → **ADR-074** ⇒ this plan keeps **ADR-075**.
- `git show main:web/lib/db/migrations/meta/_journal.json` max tag → **0039** ⇒ this plan keeps **0040_social_board**.
- `.ai-factory/ROADMAP.md` on main: milestones end at M28; M29/M30/M31 absent ⇒ this plan keeps **M31** (M29 = harness-loop roadmap TODO, M30 = gate-chat reservation).

No renumbering performed.

### T0.2 — Baseline gate at branch point (`19888156`, 2026-06-11)

- `tsc --noEmit`: **0 errors**.
- `test:unit`: **270 files / 3082 tests — all green**.
- `test:integration`: **124 files / 948 tests — all green**.
- `test:e2e` (ports 3100/7788 killed first): **60 passed / 13 failed / 1 skipped**.
  Pre-existing reds (main's debt — NOT fixed on this branch, tolerated at T6.2):
  1. `flows-authoring.spec.ts:48` CodeMirror mounts
  2. `flows-authoring.spec.ts:73` invalid manifest lint marker
  3. `flows-authoring.spec.ts:93` Ctrl+Space autocomplete
  4. `flows-authoring.spec.ts:113` restored manifest persists
  5. `m15-readiness.spec.ts:54` readiness summary badge/panel
  6. `m17-hitl-hybrid.spec.ts:199` HITL inbox criticality styling
  7. `m18-branch-promotion.spec.ts:97` conflict/assignment card
  8. `m27-workbench-lifecycle.spec.ts:40` lifecycle actions + handoff
  9. `platform-acp-runners.spec.ts:5` admin settings/task/scratch launch (known seed `default_runner_id` clobber)
  10. `portfolio-board.spec.ts:5` seeded acceptance work
  11. `project-registration.spec.ts:18` register + dup conflict
  12. `project-registration.spec.ts:63` non-admin cannot register
  13. `scratch-launch.spec.ts:8` scratch launch controls (known `getByLabel('Project')` collision)

### Phase 2 notes (as-built deviations, 2026-06-11)

- **Stale-0039-snapshot fact confirmed:** `db:generate` re-emitted
  `run_schedules` DDL (the 0039 snapshot on main lacks the 0038 tables — the
  known gate-chat B1 finding). The redundant statements were stripped from
  `0040_social_board.sql` (the table already exists via 0038 everywhere); the
  0040 snapshot now correctly includes `run_schedules`, healing the chain for
  future generates.
- **Backfill proven on real data** via a CLONE of the dev DB
  (`CREATE DATABASE … TEMPLATE maister`), NOT the dev DB itself — applying
  0040 to the shared dev DB while main's code still runs against it would
  break main-checkout task creation (new NOT NULL columns). Clone results:
  `maister-dev`→`MAI`, colliding `maister`→`MAIS` (uniquify ladder), all
  tasks numbered, `next_task_number = max+1`. Clone dropped after.
- **Fixture sweep was bigger than planned:** 166 brace-form + 10 array-form +
  7 `as any`-cast drizzle insert sites across ~120 test files, plus 23 raw-SQL
  task inserts + 18 raw-SQL project inserts across `seed-e2e.ts` and two e2e
  specs (codemodded; tasks get an SQL-side
  `(SELECT COALESCE(MAX(number),0)+1 …)` value, projects a random `E…` key).
- **T3.1/T3.2 production wiring pulled forward into C2** out of necessity:
  the NOT NULL columns make any tree without `createTask` allocation /
  registration `task_key` derivation red, so `lib/social/task-key.ts`,
  the `createTask` allocation transaction, and the registration-route
  derivation+collision check landed with the schema commit. T3.1/T3.2 retain
  their test obligations.
- **Phase-2 exit proof:** tsc 0 errors; unit 270/3082 green (+23 new
  task-key tests); integration 125 files / 959 tests green (incl. 11 new
  migration tests); fresh `maister_e2e` reset+migrate+seed green (25/25
  tasks numbered, 20/20 distinct keys).

### Phase 6 — Final gate results (2026-06-11)

- `tsc --noEmit`: **0 errors** (web + mcp).
- check-only `eslint .`: **0 errors** (1675 pre-existing repo-wide warnings;
  touched files contribute none — the single warning in the touched set,
  `board.ts` unused `artifactInstances`, predates this branch).
- `test:unit`: **278 files / 3147 tests green** (incl. i18n parity).
- `test:integration`: **130 files / 1007 tests green** (three full runs; two
  interim one-off infra flakes — a testcontainers port-binding race and a
  fake-ACP stdout timing miss — each file green in isolation and in the
  final run).
- `test:e2e` (clean run, playwright-owned server): **63 passed / 11 failed /
  1 skipped — ZERO new reds**; the 11 are a strict subset of the 13-red
  T0.2 baseline (m17-hitl:199 and m18:97 even passed this run; the m18 file
  flips between :49/:97 across runs — same-file shared-fixture flake family,
  red at baseline too). `social-board.spec.ts` green.
- Docs: mermaid 176/176, ADR anchors 360/360 across the whole tree; both
  OpenAPI files lint valid (pre-existing warnings only).
- Grep-proofs: `task_activity` inserted ONLY via `lib/social/activity.ts`;
  no `fs.watch`/`chokidar`/`setInterval` introduced; `comments:*` scopes
  wired through types + token UI + ext route; no `acp_session_id` in any
  social DTO.
- e2e hardening found and fixed two REAL bugs this phase: (1) raw-SQL seeded
  tasks left `projects.next_task_number` stale → first runtime `createTask`
  collided (fixed by a global counter reconcile at seed end); (2) two specs'
  runtime raw task inserts used `MAX(number)+1`, racing the app allocator in
  parallel runs (fixed by allocating through the counter with a CTE).
- i18n gotcha fixed: `{ref}`-style placeholders in messages are ICU
  arguments to next-intl — switched the timeline event templates to `%ref%`
  with component-side substitution.
- T6.4 docs checkpoint: configuration.md / getting-started.md untouched
  (verified zero env/dep/script changes); system-analytics README +
  docs/CLAUDE.md glossaries gained the social-board rows; all (Designed)
  ADR-075 tags flipped to (Implemented); ROADMAP M31 added (milestone +
  Completed row); root CLAUDE.md "Built since baseline" entry added.

## 6. Unresolved questions

1. Семантика mention-подписки: при упоминании B в комменте на A — план подписывает СОЗДАТЕЛЯ B на задачу A (reason `mentioned`) + inbox подписчикам B. Ок, или mention-подписку в Stage 1 не делать (reason зарезервировать)?
2. `task_key` коллизия: регистрация (явный ИЛИ дефолтный ключ занят) → отказ CONFLICT; авто-суффикс только в backfill миграции (MAI → MAIS → MAI2). Ок? (авто-дискавери в коде не существует — ветка удалена из плана)
3. Relations только внутри проекта в Stage 1 — ок?
4. Ext-комменты: actor = владелец токена (`user`), для токена без владельца — `system` + tokenId в payload. Ок?
5. `blocked` = жёсткий отказ launch ВЕЗДЕ автоматически (через классификатор в `launchRun` — внутр./ext/schedules, verified). UI-only вариант потребовал бы параллельной логики — не рекомендую. Ок?
6. Log page: отдельный роут `/projects/[slug]/log` или таб `?tab=log` на борде? (выбор на имплементации по прецеденту `project-tabs.tsx` — есть предпочтение?)
7. `run_finished` activity отложен (нет choke point на ~10 terminal-сайтах; task `Done`/`Abandoned` вообще никем не пишутся — подтверждено grep). Ок для Stage 1?
8. `task_status_changed` вырезан из event kinds (единственный реальный переход — launch — уже покрыт `run_launched` в той же транзакции). Ок?
