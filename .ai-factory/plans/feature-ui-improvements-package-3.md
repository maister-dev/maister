# Implementation Plan: MAIster UX/Product Improvement Package 3

Branch: `feature/ui-improvements-package-3`

Base: `master` at `b84f47eef` (Package 2 merge, PR #46; local and `origin/master` checked 2026-11-15)

Created: 2026-11-15

Status: Designed. Planning only — no code, migrations, instructions, Runs, pushes or deployments were changed while preparing this plan.

## Settings

- Delivery: specification-driven (SDD). Phase 0 publishes the owning analytics, wire, data, ADR and acceptance specifications before any behavior code. This plan is the work order and traceability map; the owning specs become the source of truth.
- Testing: yes — RED → GREEN → REFACTOR per acceptance ID with one primary assertion owner. Prefer real PostgreSQL (Vitest `integration`) and authenticated Playwright with local Git/supervisor fixtures. Migrate existing assertions whose observable contract changes inside the owning phase.
- TDD protocol (applies to every behavior task T1–T13): **RED** — write the owning test cases named in the task, run them and record the failing assertion (not a compile/import error; a missing module is stubbed first so the failure is behavioral). **GREEN** — minimum code to pass; no unrequested branches. **REFACTOR** — remove duplication against existing helpers named in the task, re-run the phase suite. Test-quality rules: one owning test per acceptance ID (other layers may only reference it); pure decision logic is owned by unit tests, locks/races/persistence by real-Postgres integration tests, interaction by Playwright; exhaustiveness over a closed union is a compile-time `satisfies Record<Union, …>` check (typecheck gate), never a runtime test; no test that only asserts a constant, a label copy or a mock call without an observable outcome.
- Logging: standard structured logging through the owning server logger (`[module.operation] message {data}`): INFO for durable transitions (binding created/backfilled, task auto-completed, completion refused with reason), WARN for refusals/ambiguous evidence/retryable failures, ERROR for exhausted or unexpected failures. No logs for UI disclosure, tooltip, rendering or routine reads. Never log prompts, issue bodies, tokens or URLs with credentials.
- Docs: yes — mandatory docs checkpoint; Phase 0 specs first, Implemented status only after the owning checks pass.
- Workflow: manual `aif-plan full`, English artifacts, `paths.plans` + branch-derived slug. No Handoff task (not in Handoff mode). Branch/worktree already exist at `../mAIster-ui-improvements-package-3`.

## Roadmap Linkage

Milestone: "none"

Rationale: Focused dogfooding follow-up across delivered milestones, matching Packages 1 and 2; it does not open or close a roadmap milestone.

## Evidence classes

Every claim in this plan carries one of these labels:

- **[Deployed]** — observed on the authenticated instance on 2026-11-13 (supplied audit). Historical; not re-verified in planning. Deployed revision parity is unknown.
- **[Source]** — confirmed in source at `b84f47eef` during planning (paths below).
- **[Plan]** — a design in an existing, unimplemented plan.
- **[Assumption]** — not established; T0 must verify or the plan must be amended.

### Dependency status

| Work | Status | Package 3 relationship |
| --- | --- | --- |
| Package 1 (`feature-ux-dogfooding-package-1.md`, PR #37, `9b5fb6c3d`) | Merged **[Source]** | No overlap. Keep its readiness/evidence links, transcript and Run-history header contracts untouched. |
| Package 2 (`feature-ux-dogfooding-package-2.md`, PR #46, `b84f47eef`) | Merged **[Source]**; deployment unknown | Reuse: UX-06 launch draft/preview (do not change launch semantics), UX-08 outcome-first Run layout, UX-10 results/checks projection, UX-11 `ProjectWorkspaces` disclosure and its counts. Package 3 extends only the retained-workspace listing (T9) and the Run header timing (T8). |
| GitHub task reconciliation (`codex-github-task-reconciliation.md`) | Designed, not started; no schema exists **[Source]** | Package 3 owns only the **provider-neutral identity core** (binding table, create/lookup/bind, backfill, DTO/MCP, intake dedup switch) and **MAIster-side completion after a MAIster-delivered PR merges**. Its observations, leases, admission holds, conflicts, external closure dispositions, watch/skip of PR-linked issues, receipt intents and `external_task_sync` capability stay in that plan, which must be re-based onto the Package 3 table (T14 records the hand-off). Its locked decisions D1 (no new run/task status), "keep `task_complete` human-only" and "numbers/URLs are never identity" are adopted. |

## Verified baseline (source at `b84f47eef`)

### Source identity

- `tasks` has no external-source column or table; uniques are `(project_id, number)`, `created_via_operation_id`, and agent trigger idempotency (`web/lib/db/schema.ts:1584-1750`). Task key = `projects.task_key` + number. **[Source]**
- `POST /api/v1/ext/projects/{slug}/tasks` body is `{title, prompt?, statement?, flowId?}.strict()` (`web/app/api/v1/ext/projects/[slug]/tasks/route.ts:36-45`); PATCH is `{title?, prompt?, expectedRevision?}.strict()`. MCP `task_create`/`task_update` (`mcp/src/tools.ts:31,452,1417,1707`) forward only those fields (MCP does not forward `expectedRevision`). `TaskDTO` (`web/lib/services/tasks.ts:328-408`) has no source. **[Source]**
- Canonical intake instructions live in the companion repo `maister-dev/maister-plugins`: `packages/core/capability/skills/github-issue-intake/SKILL.md` and `packages/core/maister-agents/github-intake-{gh,mcp}.md`; latest tag `core/v1.4.1` (only the skill changed since `core/v1.4.0`). The skill dedups by exact `Source-GitHub-ID`/`Source-GitHub-Issue` prompt text plus GitHub comment receipts `<!-- maister-intake:v1 project=… source=<GitHub-ID> outcome=imported task=<KEY-N> -->`, and states no transactional uniqueness exists. Title is `[GitHub #NUMBER] <title>`. **[Source]** (read via `gh api` at the tag; the local `../maister-plugins` clone is stale at `core/v1.2.0`).
- Platform mirror: `web/test-support/fixtures/operational-core/**` + `web/lib/packages/__tests__/operational-core.integration.test.ts` (installs as `core/v1.4.0` or `OPERATIONAL_CORE_CANDIDATE`). The platform repo's own `maister.yaml` pins `core/v1.3.0`; the deployed project's pin is unknown **[Assumption]**.
- Launched operational runs freeze their definition (`runs.result_contract` via `buildOperationalContract`, `web/lib/agents/launch-contract.ts:49-97`, digest allow-list `SUPPORTED_V1_DIGESTS`) and read skills from the pinned install path. New instructions reach only runs launched after a re-pin. **[Source]**
- No provider-neutral "connection" entity exists. `projects.provider` describes the code host only (`web/lib/repo-source.ts:32`); intake source config lives in `agent_project_links.config` (`github_repository`). **[Source]**

### Completion

- `completeTaskInTransaction` (`web/lib/services/task-completion.ts:51`) locks the task `FOR UPDATE`, is idempotent on `Done`, evaluates the newest flow run with `taskCompletionEvidence` (`web/lib/tasks/completion-evidence.ts:38`: `run_missing | run_not_done | delivery_not_done | pull_request_not_merged`), writes `Done` + revision + `task_completed` activity `{runId}`; no domain event. Callers: UI route (`editTask`), ext `task_complete` (personal tokens only), MCP. **[Source]**
- Promotion with `pull_request` sets run `Done`, `workspaces.promotion_state='done'`, `pr_url/pr_number`, leaves `pr_state` NULL (`web/lib/runs/promote.ts:1927-2117`). No promotion path writes `tasks.status`. **[Source]**
- `pr_state_scan` (`web/lib/scheduler/handlers/pr-state-scan.ts`, per-project job, 300 s) sets `pr_state='merged'`, `pr_merged_at`, `pr_merge_commit_sha` once via a guarded edge, sends webhook `run.pr_merged` and `run_pr_merged` task activity; failed reads never write state; it emits no domain event and never touches `tasks`. **[Source]**
- **Nothing completes a task when its PR merges.** **[Source]** This matches **[Deployed]** MAI-27 Done only after a separate completion.
- `auto_launch_run_plan` marks as-plan child tasks (`launch_mode='auto'`) `Done` directly on `run.done` without delivery/merge evidence (`web/lib/domain-events/auto-launch.ts:280-298`). **[Source]**
- `publish_branch` satisfies completion evidence without any merge (strategy ≠ `pull_request`). **[Source]**
- Run Git panel Open PR (ADR-181) leaves the Run parked (`Review | Crashed | Failed | Abandoned`) and records `workspaces.pr_state='open'` (`web/lib/workbench-git/service.ts:519`); `pr/finalize` later moves it to `Done` + `promotion_state='done'` and emits `run.done` (`promote.ts:2152`). When GitHub merges **before** finalize, the scan's merged edge fires while the Run is not Done, and no merge event follows the finalize. **[Source]**
- Task title/prompt/statement are immutable while the task is not `Backlog`: `BACKLOG_GATED_FIELDS` (`web/lib/services/tasks.ts:467`, except pre-run queued intents) and `updateTaskStatement` refuses `task_not_backlog` (`web/lib/tasks/statement.ts`). `tasks.revision` also advances on `queuePaused` writes while InFlight (`tasks.ts:606`) and on completion, so it is not a statement-revision signal. **[Source]**
- Statement history exists: `task_statement_revisions (task_id, revision, statement jsonb, …)` (`web/lib/db/schema.ts:9282`). **[Source]**
- `task_activity` dedup precedent: partial unique index `task_activity_agent_summon_uq` + `onConflictDoNothing` (`schema.ts:8504`). `inbox_items` carries its own `event_kind` CHECK (`schema.ts:8611`). **[Source]**
- Attention wake: `/api/attention/stream` scans every `task_activity` row (`web/app/api/attention/stream/route.ts:177-190`), so any new activity wakes the rail. **[Source]**
- PR bodies are platform-generated strings with no closing keywords: promotion (`promote.ts:1916-1920`), Run Git panel defaults (`web/lib/workbench-git/pull-request.ts:150`, user-editable), local packages (`web/lib/local-packages/publish.ts:281`, out of scope). `.github/PULL_REQUEST_TEMPLATE.md` is never used because `--body` is always passed. **[Source]**

### Timing

- Task page duration = `endedAt − startedAt` (`web/lib/queries/task-detail.ts:234`), where `runs.started_at` defaults to insert time, so it includes queue and HITL waits; single-unit `formatDuration` (`page.tsx:143`). **[Source]**
- Run page "Active time" = sum of node-attempt durations (`web/app/(app)/runs/[runId]/layout.tsx:970,1163`) — double counts parallel attempts and includes waits. **[Source]**
- Evidence available: `runs.{started_at, ended_at, checkpoint_at, resume_requested_at, resume_started_at, review_entered_at, parent_run_id}`, `node_attempts.{node_type, started_at, ended_at, attempt}` (no lane/parent column), `hitl_requests.{run_id, step_id, kind, created_at, responded_at, superseded_at}`, `agent_turns.{run_id, created_at, completed_at}` (no `started_at`), `domain_events`. No run status-transition history table. `computeTimingIntervals` (`web/lib/evaluations/metrics.ts:144`) exists but is unused outside tests. **[Source]** `runs.launched_at` is agent-activity provenance only (CHECK `activity_timestamp_provenance`, `schema.ts:2401`) and is **not** a timing input. **[Source]** Whether `agent_turns` covers every scratch/agent execution turn is an **[Assumption]** (T0).
- Five private `formatDuration` copies exist (`runs/page.tsx:60`, `runs/[runId]/layout.tsx:309`, `scratch-runs/[runId]/layout.tsx:50`, task `page.tsx:143`, `components/board/run-timeline.tsx:100`) plus `components/admin/observability-format.ts:18`. **[Source]**

### Sidebar

- Rail = `getRailWorkspaceGroups` (`web/lib/queries/portfolio.ts:968-1040`): `ACTIVE_RUN_STATUSES` (Running, NeedsInput, NeedsInputIdle, Review, Crashed, HumanWorking, WaitingOnChildren, **Failed** — ADR-181 D14 owner decision 2026-09-23) OR (`Done|Abandoned` AND `workspaces.scheduled_removal_at IS NOT NULL`), AND `removed_at IS NULL`. The "active" counter counts every row, including Done/Abandoned. No task-state or supersession input. **[Source]** This explains **[Deployed]** MAI-27's successful and Failed attempts staying in the sidebar.
- Live refresh: `AttentionLiveRefresh` → SSE `/api/attention/stream` → `router.refresh()`. **[Source]**
- `getProjectPageData` (`web/lib/queries/project.ts:304,411`) lists retained work by `ACTIVE_RUN_STATUSES` only (no Done/Abandoned TTL rows). **[Source]**

### Task page and presentation

- One Server Component (`web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`, 958 lines) fed by `getTaskDetail` (`web/lib/queries/task-detail.ts:286`); always renders queue controls, agent actions/re-triage, first launch + a second concurrent `LaunchPopover forceRelaunch`, full prompt editor, `RelationsEditor` with create form, qualification control, inline launch-defaults grid, token aggregates, a raw `<table>` run history, timeline, full `FlowGraphViewSection` and `RunDiff`. **[Source]** matches **[Deployed]**.
- Run status rendered raw (`page.tsx:865`); delivery column from `deliveryStatusLabel()` (`task-detail.ts:263-284`) mixes `PR #N` (plain text), raw `pull_request` and the configured strategy; `prState`/`promotionState` selected but unused. **[Source]**
- Timeline labels cover 8 of `TASK_ACTIVITY_EVENT_KINDS`; others (`triage_set`, `run_pr_merged`, `clarification_*`, …) leak raw (`task-timeline.tsx:27-50`, `page.tsx:417-426`). `buildActivityRowLabels` covers the activity feed kinds. **[Source]**
- Time zone: task page run table, timeline, `task-activity-log.tsx:165`, `token-audit-table.tsx:144` format UTC via `toISOString()`; home (`activity-row-list.tsx:63`, `work-rows-table.tsx:146`) formats in the browser zone after hydration; `/runs` formats in the server zone; several agent views force `timeZone:"UTC"`. No user/instance timezone setting. UTC (17:26) vs browser UTC+3 (20:26) explains the **[Deployed]** discrepancy **[Source]**; the viewer's actual zone is an **[Assumption]** consistent with the 3 h offset.
- No HeroUI `Table`; raw tables. Task run table and `components/agents/agent-history.tsx` lack right alignment/tabular numerals; `work-rows-table.tsx` right-aligns tokens without tabular numerals; `/runs`, token-audit, scheduler and observatory tables already comply using **inline** Tailwind classes (`text-right … tabular-nums`). `web/components/primitives.ts` does not exist (the `web/CLAUDE.md` structure line is stale) and no component uses `tv()`. **[Source]**

## Design and decisions

### D1. Provider-neutral external source binding (owner: `web/lib/tasks/external-source/`)

New table `task_external_sources` (main lineage, migration `0340_task_external_sources`). Name is shared with the reconciliation plan on purpose; that plan later adds lifecycle columns/tables to it instead of a competing table.

| Column | Rule |
| --- | --- |
| `id` | server ULID/UUID |
| `project_id` | FK projects, NOT NULL |
| `task_id` | FK tasks, NOT NULL, UNIQUE (one binding per task); `ON DELETE CASCADE`. No production path hard-deletes a task (only a project cascade, and projects are never hard-deleted), so a nullable/orphan binding would be an unreachable state every reader must handle — KISS |
| `source_kind` | NOT NULL; bounded slug `^[a-z][a-z0-9_-]{1,31}$` (e.g. `github`, `gitlab`, `jira`, `gitverse`); open vocabulary, **independent of `projects.provider`** |
| `source_instance` | NOT NULL; normalized instance identity (lower-cased host, or a configured connection ID); no scheme, credentials, path or query |
| `scope_key` | NOT NULL; namespace locator (`owner/repo`, Jira project key, …). Display + closing-reference input, **not** part of identity |
| `external_id` | NOT NULL; stable machine identifier, unique within the instance. Writers whose provider only has scope-local IDs must compose `<scope-immutable-id>:<local-id>` (documented per kind in the spec; GitHub uses the issue node ID) |
| `external_key` | nullable; human key/number (`#7`, `PROJ-12`) |
| `external_url` | nullable; `https://` only, ≤2048, no userinfo |
| `origin` | `import | backfill | manual` |
| `created_by_actor_type/_id` | polymorphic actor (user/agent/system) like `task_activity` |
| `created_at`, `updated_at` | UTC |

- DB CHECKs (generated constraint, real-Postgres covered by M1): `source_kind ~ '^[a-z][a-z0-9_-]{1,31}$'`; `length(source_instance) BETWEEN 1 AND 253` and no `/`, `@`, `:` scheme or whitespace; `length(scope_key) BETWEEN 1 AND 256`; `length(external_id) BETWEEN 1 AND 256`; `external_key` ≤ 64; `external_url IS NULL OR (external_url ~ '^https://[^/@\s]+(/|$)' AND length(external_url) <= 2048)`; `origin IN ('import','backfill','manual')`. The zod schema in `validate.ts` mirrors the same bounds (S7) so the API refuses with 422 before the DB does.
- Identity: UNIQUE `(project_id, source_kind, source_instance, external_id)`. Same visible number in two instances/repos never collides because the number is not identity. Compatible with reconciliation D2's `(project, provider, host, issue_node_id)`.
- Bindings are immutable after creation except `external_key`, `external_url`, `scope_key` refresh by the same identity (a rename). Re-binding a task to a different identity is refused; only an explicit human detach frees it. Detach deletes the binding row and writes `task_activity source_detached {kind, instance, externalId, externalKey}` in the same transaction; afterwards the identity is free and a later import creates (or binds) a task normally.
- Title/prompt edits never read or write the binding. Display = `external_key ?? external_id`, label = per-kind localized name or the raw `source_kind`, optional link only when `external_url` is present.
- Create-with-source: in the `createTask` transaction, after the existing project allocation lock, insert the binding; a unique violation becomes `CONFLICT {reason:"source_already_bound", existingTaskId, existingTaskKey}` with the task insert rolled back (no orphan task). This is the transactional dedup the intake skill lacks today.
- Lookup: by `(source_kind, source_instance, external_id)` within the project, across all task statuses.

### D2. Legacy backfill (owner: `web/lib/tasks/external-source/backfill.ts`, script `pnpm --filter maister-web tasks:backfill-sources`)

- Input only durable DB facts: each task's current `prompt` **and** every `task_statement_revisions.statement` row of that task (string leaves of the jsonb are scanned; MAI-27 shows markers can disappear from the current description). Markers found in any of these inputs are merged; two different identities across them → `conflicting`. No title-similarity or number inference; the title `[GitHub #N]` is corroboration only.
- A candidate requires `Source-GitHub-ID` whose value is a GitHub node ID (`^I_[A-Za-z0-9_-]+$`) and a `Source-GitHub-Issue` `https://<host>/<owner>/<repo>/issues/<n>` URL. Result: `source_kind=github`, `source_instance=<host>`, `scope_key=<owner>/<repo>` (lower-cased), `external_id=<node id>`, `external_key=#<n>`, `external_url=<canonical URL>`, `origin=backfill`.
- Classification (each a finding, none guessed): `bindable`; `already_bound_same` (no-op); `incomplete` (missing ID or URL); `malformed` (unparsable URL/ID, numeric-only ID); `conflicting` (title number ≠ URL number, multiple distinct markers in one task, or task already bound to another identity); `duplicate` (same identity in >1 task of the project — none bound; operator decides); `foreign_project` markers are irrelevant (identity is project-scoped).
- Default `--dry-run` prints a JSON report (counts + per-task key/classification, no prompt text); `--apply` binds only `bindable` rows, one transaction per task with `ON CONFLICT DO NOTHING`, re-runnable with identical results. Never edits titles/prompts, never creates or deletes tasks, never touches runs/relations/history.
- Expected **[Deployed]** fixtures: MAI-8 → `I_kwDOUPjedM8AAAABU8w1nQ`/#7, MAI-20 → `I_kwDOUPjedM8AAAABYDsXwA`/#29, MAI-24 → `I_kwDOUPjedM8AAAABU8w0Wg`/#6 bind; MAI-27 has no markers → no binding. The remaining 14 GitHub-prefixed tasks are classified by the dry run, not assumed.
- Repeatable for tasks created by old pinned intake runs after the cut-over (D4).

### D3. Source binding API/MCP and authorization

| Surface | Contract | Identifiers |
| --- | --- | --- |
| `POST /api/v1/ext/projects/{slug}/tasks` (`task_create`) | Optional `source {kind, instance, scope, externalId, externalKey?, url?}` (strict, bounded per D1 CHECKs). 201 as today with `source` in the receipt; 409 `CONFLICT source_already_bound` with existing task key/id; 422 `CONFIG` for invalid shape; 422 `CONFIG {reason:"source_not_allowed_for_token"}` when a **librarian** token sends `source` (librarian tasks originate in a conversation, not an external tracker). Idempotency-Key replay exists only for librarian tokens (which cannot send `source`); for every other token the binding is the dedup (S8, amended in T3). Scope `tasks:create` (unchanged). | slug `url-param`; actor `auth-context`; project `server-state`; `source.*` `body-controlled` — validated, identity derived only within the server-state project; never a fetch instruction |
| `GET /api/v1/ext/projects/{slug}/tasks/by-source?kind=&instance=&externalId=` (`task_find_by_source`) | 200 `{task: TaskDTO|null}` across all statuses; 422 invalid query. Scope `tasks:read`. Existence scoped to the project. | slug `url-param`; query `body-controlled` (validated); project `server-state` |
| `PUT /api/v1/ext/projects/{slug}/tasks/{taskId}/source` (`task_source_bind`) | Bind an **unbound** task; same identity → 200 no-op; task bound to other identity → 409 `source_conflict`; identity bound elsewhere → 409 `source_already_bound`; `expectedRevision` optional → 409 stale. Scope `tasks:update`; agent tokens may bind only tasks in their project. | slug, taskId `url-param`; project/task `server-state`; body `body-controlled` |
| Human detach (`DELETE …/tasks/{taskId}/source`, session-only UI route) | Requires `editTask` and a session actor (no agent/project token); audited `task_activity` `source_detached`. | url-param + auth-context |
| `TaskDTO`, task detail, MCP `task_get/list` | Add nullable `source {kind, instance, scope, externalId, externalKey, url}` | read under existing task visibility |

No new token scopes (reuse `tasks:create/read/update`); `CROSS_PROJECT_AGENT_SCOPES` unchanged (cross-project create keeps its current rules; source identity stays project-scoped). Positive and negative grant tests per route. MCP `task_update` remains title/prompt only.

### D4. GitHub intake agent compatibility (companion repo + platform mirror)

- Canonical source: `maister-plugins/packages/core/capability/skills/github-issue-intake/SKILL.md` and `maister-agents/github-intake-{gh,mcp}.md`. Mirror: `web/test-support/fixtures/operational-core/**`. Tests: `operational-core.integration.test.ts`, MCP `tool-contract.test.ts`.
- New core tag (proposed `core/v1.5.0`, reserved at implementation time) changes only intake identity: look up by source (`task_find_by_source`) before creating; create with `source{kind:github, instance:<host>, scope:<owner/repo>, externalId:<issue node ID>, externalKey:#N, url}`; treat `source_already_bound` as "reuse existing task and repair its receipt"; keep GitHub comment receipts as the durable provider-side journal; keep the human-readable `Source-GitHub-*` lines as non-authoritative provenance (so legacy-aware readers still work); bind legacy matching tasks via `task_source_bind` only on an exact marker match (same rules as D2).
- Compatibility: the new instructions require a platform that accepts `source`; set the core package compat floor to the platform release that ships T3 (T0 confirms the mechanism — `compat.engine_min` or equivalent). Old pins/launched snapshots keep the old instructions and keep creating marker-only tasks; the platform keeps accepting them; re-running the D2 backfill binds them. No `SUPPORTED_V1_DIGESTS` change unless the operational appendix changes (T0 verifies). Tag creation/push and project re-pin are owner actions after review, outside this branch.

### D5. Completion after confirmed merge (owner: `web/lib/services/task-completion.ts` + new consumer)

Relationship: task 1:N delivery Runs; a Run's delivery publishes at most one recorded PR (`workspaces.pr_url/number`); the PR's merge is observed only by `pr_state_scan`; external issue linkage comes only from the D1 binding.

- **Platform-owned triggers (two, same evaluation).** (a) In the `mergedEdge` transaction of `pr_state_scan`, also emit a new domain event `run.pr_merged` `{runId, taskId, workspaceId, prNumber, mergeCommitSha, mergedAt}` (migration `0342_domain_event_run_pr_merged` widens the kind CHECK — its own migration). (b) The existing `run.done` emitted by every PR promotion/finalize path (`promote.ts:1452, 2152, 2706`). Trigger (b) closes the "merged before finalize" order (Run Git panel PR merged on GitHub while the Run is parked; finalize later moves it to Done with `pr_state` already `merged` and no further merge edge). A new consumer `taskDeliveryCompletion` (registered in `web/lib/domain-events/consumers.ts`, handles exactly `run.pr_merged | run.done`) calls `completeTaskFromConfirmedMerge(taskId, runId, tx)`, a new entry point in `task-completion.ts` that reuses the same lock and `taskCompletionEvidence`, with a `system` actor and activity payload `{runId, cause:"pr_merged", prNumber}`.
- **Silent skip (no activity, DEBUG log only), evaluated first:** event has no `taskId`; Run is not `run_kind='flow'`; the Run's workspace `pr_state` is not `merged` (covers every `run.done` of local-merge, result-only, publish_branch and PR-opened-not-merged Runs). A merge is not yet confirmed, so there is nothing to refuse.
- **Eligibility (all must hold under the task `FOR UPDATE` lock, merge confirmed):** task `InFlight` (`Done` → idempotent no-op; `Backlog`/`Abandoned` → refused `task_not_in_flight`); the merged Run is the task's newest flow Run (else `superseded_by_newer_attempt`); `taskCompletionEvidence(newest).ok` (Done + promotion done + `pull_request` + `prState='merged'`; a merged-but-not-finalized Run refuses `run_not_done` **silently** because trigger (b) will re-evaluate it); the Run's delivery resolution is `resolves` (D6, else `partial_resolution`). No statement-revision check: title/prompt/statement are immutable while a task is not `Backlog` (`BACKLOG_GATED_FIELDS`, `updateTaskStatement` `task_not_backlog`), so the launched statement is the current one for an InFlight task — this invariant is asserted by C3, not re-implemented. `tasks.revision` is not used (it advances on `queuePaused` and completion).
- **Refusal reasons (closed union, allow-list):** `task_not_in_flight | superseded_by_newer_attempt | partial_resolution`. Pure evaluator `evaluateMergeCompletion(state) → {apply} | {skip} | {refuse, reason}` lives in `web/lib/tasks/completion-evidence.ts` next to `taskCompletionEvidence` and is the single decision owner (unit-tested); the service only loads state, locks and writes.
- **Refusal handling:** a refused automatic completion inserts one `task_activity` `delivery_completion_not_applied {runId, reason}` with `onConflictDoNothing` against the partial unique index `task_activity_delivery_refusal_uq (task_id, payload->>'runId', payload->>'reason') WHERE event_kind='delivery_completion_not_applied'` (same pattern as `task_activity_agent_summon_uq`), and logs WARN; the task stays `InFlight`, the board/task page show "PR merged — completion needs a decision" and the existing manual Complete (human-only) remains the recovery path. Missing or failed provider reads never reach the consumer (the scan writes nothing on failure).
- **Progress and poison events:** each event is processed independently; a deterministic refusal or skip advances the cursor, so one ineligible task never stalls the singleton dispatcher. Only unexpected errors throw and are retried by the existing dispatcher policy.
- **New activity kinds:** `delivery_completion_not_applied` and `source_detached` join `TASK_ACTIVITY_EVENT_KINDS`; their CHECK widening plus the refusal unique index is its own migration `0341_task_activity_source_completion_kinds`. Membership decided: `delivery_completion_not_applied` **joins** the `inbox_items` kind CHECK (`schema.ts:8611`) — it is a decision for subscribers; `source_detached` does not. Both get EN/RU labels in the task timeline map and `buildActivityRowLabels`; both wake the attention stream by construction (it scans all `task_activity`).
- **`run.pr_merged` domain-event fan-out (exhaustive, T4):** `DOMAIN_EVENT_KINDS` + CHECK; `PulseEventKind` enum in `docs/api/external/operations.openapi.yaml` and the exhaustive `mapDomainEvent` switch in `web/lib/ext-activity/domain-events.ts:38` (compile break otherwise); **excluded** from agent triggers (added to an exclusion so `AGENT_TRIGGER_EVENT_KINDS` does not grow — completion is platform-owned, decision 2026-11-15); `ATTENTION_PLANE_EVENT_KINDS` (`taxonomy.ts:404`) — **included** (it changes what the board shows); **not** in `RUN_TERMINAL_EVENT_KINDS` / `RUN_SETTLED_EVENT_KINDS` (otherwise orchestrator resume, cost-rollup, memory-harvest and source-reindex consumers fire); `docs/db/domain-events.md` and `docs/system-analytics/domain-events.md` taxonomy table. The outbound webhook of the same name (`outbound-webhooks.asyncapi.yaml:652`) is a separate plane and is unchanged; the spec states both explicitly.
- **Ordering/duplicates/restarts:** the edge fires once per workspace (column-guarded); the dispatcher is at-least-once with a durable cursor; the consumer is idempotent (already-Done no-op, deduped refusal activity). Both triggers may arrive for the same Run in either order; the first that sees full evidence completes, the second is an already-Done no-op. A delayed event re-evaluates current state under the lock, so a newer attempt wins. A merge observed before restart is delivered after restart from the outbox. A PR closed unmerged produces no event and every later `run.done` skips silently.
- **Missed history (one-time):** a reconciliation pass (part of T6, idempotent, dry-run first) evaluates `InFlight` tasks whose newest flow Run has `pr_state='merged'` and applies the same entry point; output is a report. Existing `Done` tasks are untouched.
- **Other strategies unchanged:** local merge/rebase/ai-rebase (promotion ⇒ delivered to target, manual completion as today), result-only (never auto-completed; unchanged), `publish_branch` (not completion; manual as today — see Q2).
- **as-plan children:** the direct `tasks.status='Done'` write in `auto-launch.ts` is replaced by the completion evidence check for PR-delivered children (they complete through the new consumer on merge); local-merge/result-only children keep today's behavior (see Q3).
- **Agents:** no agent is required to complete tasks. `task_complete` stays human-only. Agents may only explain a refusal in comments (no new grant).

### D6. Delivery resolution: full vs partial (see Q1)

Default recommendation: snapshot `resolvesTask: boolean` (default `true`) into the Run's existing `delivery_policy_snapshot` at launch and allow the promoter to switch it to partial on Promote/Open PR (single checkbox "Partial work — keep the task open"). No new column (jsonb field; legacy absent ⇒ `true` for the evidence check, because before this package every PR delivery of a task was intended to resolve it — T0 confirms there is no counter-evidence). A PR that merely references a task (not recorded on its Run's workspace) never completes it.

Writers and readers of the field (all in T5):

- Type + schemas: `DeliveryPolicy`/`StoredDeliveryPolicy` and both `.strict()` zod schemas in `web/lib/runs/delivery-policy.ts:11-52` gain optional `resolvesTask: boolean`; one reader helper `snapshotResolvesTask(snapshot): boolean` (absent ⇒ `true`) is the only place the default lives.
- Launch: the launch snapshot writer sets `resolvesTask: true` explicitly for new Runs.
- Change: the existing `PATCH /api/runs/[runId]/delivery-policy` route (`web/app/api/runs/[runId]/delivery-policy/route.ts`) accepts `resolvesTask` in its strict body; no new route. It is refused `409 CONFLICT {reason:"delivery_already_started"}` once `workspaces.promotion_state ∈ {claiming, done}` or a PR is recorded (`pr_number IS NOT NULL`), checked under the same run row lock the route already takes — the flag that rendered the PR body (D7) can never change afterwards. Promote dialog and Run Git panel Open-PR send the flag through this route before promotion. `docs/api/web.openapi.yaml` documents the field and the 409. Identifiers: runId `url-param`, actor `auth-context`, run/workspace `server-state`, `resolvesTask` `body-controlled` (boolean, no locator).
- Preservation: `web/lib/runs/auto-delivery.ts:36` rewrites the snapshot (`nextPolicy`); it must spread the stored `resolvesTask` (regression test in C3 suite).

### D7. GitHub closing references (owner: `web/lib/runs/promote.ts`, `web/lib/workbench-git/pull-request.ts`)

- "Project's GitHub host" = the host parsed from the project's repository source by the existing `web/lib/repo-source.ts` helpers when `projects.provider` is GitHub, lower-cased; no new configuration. The resolution flag is read from the Run's snapshot via `snapshotResolvesTask` at body-render time.
- When the task has a binding with `source_kind='github'`, `source_instance` equal to the project's GitHub host, `external_key` numeric, and resolution `resolves`, both generated bodies append `Closes <scope_key>#<n>` (cross-repo form is valid on the same host; same-repo too). Otherwise no keyword (never derived from the internal number; never for non-GitHub kinds or other hosts).
- GitHub only auto-closes when the PR merges into the repository's default branch; when the target differs, the body still carries the reference and the task page states "Issue closes only if merged to the default branch". Panel bodies stay user-editable; the prefill includes the line.
- Separately verifiable outcomes: MAIster records "closing reference included" (derived at render from the binding + PR target) and task completion (D5). Actual GitHub issue closure is **not** observed in this package (reconciliation plan); the UI never claims the issue is closed.

### D8. Run timing (owner: new `web/lib/runs/run-timing.ts`, loaded via `web/lib/queries/run-timing.ts`)

- **Duration** = `end − start` where `start = runs.started_at` and `end = ended_at ?? now` (active Runs tick on refresh and are labeled live).
- **Execution** = measure of `(⋃ execution intervals) − (⋃ wait intervals)`, clipped to `[start, end]`:
  - execution intervals: `node_attempts` of types `ai_coding | judge | cli | check | orchestrator | consensus` (human/form excluded); agent and scratch Runs use `agent_turns [created_at, completed_at ?? end]` (T0 verifies coverage; a gap ⇒ quality `partial`); child Runs contribute their own execution intervals clipped to the parent window (parent `WaitingOnChildren` time counts as execution only where a child executed).
  - wait intervals: `hitl_requests [created_at, responded_at ?? superseded_at ?? end]`; checkpoint idle `[checkpoint_at, resume_started_at]`; admission/queue before the first execution interval.
  - Union-based measure: parallel branches and retries never exceed wall clock; a retry adds only its own interval; recovery preserves earlier closed intervals.
- **Quality:** `exact`, `partial` (open interval on a terminal Run clipped to `ended_at`, missing turn rows) or `unavailable` (no execution evidence, e.g. legacy pre-ledger Run). Partial shows the value with "≈"; unavailable shows "—" with the reason; never `0` for missing.
- **Breakdown** (detail surface only): queue/admission, human input, idle/checkpoint, waiting for child Runs, other non-execution (`duration − execution − known waits`).
- **Surfaces:** task-page Run history (exactly two time columns "Duration/Длительность" and "Execution/Исполнение") and the Run header (replaces summed "Active time"; keeps wall clock as Duration). The `/runs` ledger also replaces its single Duration column with Duration + Execution (Q5, owner 2026-11-15), fed by the same batched loader (T8) for the page's Run ids only.
- Detail opens from an icon button next to Execution (HeroUI Popover, `aria-label`, Enter/Space/tap; Escape restores focus), not a hover-only tooltip.
- Formatting: one shared `formatDurationMs(ms, locale)` in new `web/lib/format/duration.ts` (multi-unit, e.g. `1 h 05 min`, localized units) used by every D8 surface (task Run history, Run header, timing popover). The Run header's and task page's private `formatDuration` copies are replaced by it; the other copies (`/runs`, scratch layout, `run-timeline.tsx`, admin) are out of scope and listed as a follow-up, not touched.

### D9. Active sidebar membership (owner: new `web/lib/runs/active-attention.ts`; amends ADR-181 D14 and the M19 Phase 5 rail rule)

One predicate (SQL fragment + exhaustive TS classifier `satisfies Record<RunStatus, …>`) used by the rail rows **and** its counter:

| Run | Member? | Reason label |
| --- | --- | --- |
| Running | yes (even if task closed) | Executing |
| NeedsInput / NeedsInputIdle | yes | Needs input |
| HumanWorking | yes | Being edited |
| WaitingOnChildren | yes | Waiting on child Runs |
| Review | yes | Awaiting review / unpromoted work (closed task: "Unpromoted work on a closed task") |
| Crashed | yes only if newest attempt of an open task, or taskless | Recover or discard |
| Failed | yes only if newest attempt of an open task, or taskless with retained workspace | Failed — retry or inspect retained work |
| Crashed/Failed superseded by a newer attempt, or task Done/Abandoned | no | — |
| Done / Abandoned (with or without TTL) | no | — |
| Pending | unchanged (not in rail today) | — |

- Excluded rows stay reachable: task Run history, `/runs`, Run pages, and the project "Runs and working copies" retained surface, which T9 extends with Done/Abandoned rows that still have a workspace and TTL so retained work is not lost from view. No status rewrite, no archive/GC/workspace change; TTL/GC predicates (`run-status-sets.ts`) are untouched.
- Live updates reuse the attention stream; completion (`task_completed` activity) and new attempts already wake it (T0 verifies `task_activity` coverage; add the consumer's activity if absent).

### D10. Task page around state and next action (owner: task route + `web/components/tasks/` new folder)

| Task state | Primary | Secondary ("More" menu) |
| --- | --- | --- |
| Incoming / needs qualification | Qualification action or blocking reason | Queue controls, run agent |
| Backlog, launchable | Launch | Send to triage, run agent, queue controls |
| Backlog, blocked | Blocker reason + link | same |
| InFlight, Running/Pending | Open Run | queue controls, run agent |
| InFlight, NeedsInput | Respond (HITL link) | — |
| InFlight, Review | Open review | Complete (when `completionReady`) |
| InFlight, PR open / merged-not-applied | Open PR; "Complete" when `completionReady` | Run again |
| Done | Result card: resolving Run, merged PR link + state, diff stat, open changes | Run again (new attempt), Send to triage |
| Abandoned | Status + reason | — |

- **Resolving attempt** = `runId` of the latest `task_completed` activity (durable), not the newest Run. Fallback for legacy Done without payload: "resolving Run unknown".
- **One "Run again" entry** (remove the duplicate runs-section `LaunchPopover forceRelaunch`); eligibility from the existing `classifyForceRelaunchLaunchability`; on a Done task it is labeled "Start a new attempt" with an explanation of the status effect the existing launch path applies (T0 records it; admission/launch rules unchanged).
- Description collapses to a bounded preview (always for Done; when > N lines otherwise) with "Show full statement"; acceptance criteria stay reachable; editing unchanged.
- Relations list shown; create form behind "Add relation".
- Qualification compact summary; details/revisions on demand; blocking problems stay expanded.
- Launch settings in a collapsed "Next launch settings" section labeled as future defaults; each history row shows the Run's frozen runner/model (already from the Run snapshot) with "used in this attempt".
- Run history: localized status chips; Delivery column split into intended strategy (muted) and actual artifact (PR link `#N` with `PrStateChip`, published branch, merged commit, or "not delivered"); resolving attempt marked; token totals moved to a compact secondary line; two timing columns (D8).
- Activity: every `TASK_ACTIVITY_EVENT_KINDS` member has EN/RU text — the label-key map is typed `satisfies Record<TaskActivityEventKind, MessageKey>` (compile-time exhaustiveness) and the i18n key-parity check covers EN/RU; consecutive system events of the same kind group into an expandable row keeping each entry; completion/merge/comments emphasized; composer stays at the top of the discussion.
- Run details: replace always-mounted graph + diff with a compact result summary and on-demand disclosure (graph and `RunDiff` mount only when opened) plus direct links to `/runs/{id}` workbench tabs.

### D11. Numeric alignment and time presentation (owner: new `web/components/ui/local-time.tsx`)

- Numeric cells use the project's existing inline convention `text-right tabular-nums` (as `/runs`, token-audit, scheduler tables do); no new shared variant module (`components/primitives.ts` does not exist; introducing `tv()` for one class pair is over-engineering). Apply to: task Run history (durations, tokens), `components/agents/agent-history.tsx` numeric columns, `components/work/work-rows-table.tsx` tokens (add `tabular-nums`). Already compliant tables are untouched; IDs, statuses and dates stay left-aligned. Missing values render "—" (never 0).
- `<LocalTime iso=…>` client component: renders after mount in the viewer's browser zone with `Intl.DateTimeFormat(locale, {dateStyle, timeStyle, timeZoneName:"short"})`, `<time dateTime>` and a title with the full zone; SSR placeholder is the UTC string labeled "UTC" to avoid an unlabeled mismatch. Used on task page (history, timeline, activity log), home activity/work tables and `/runs`. Stored instants unchanged. Explicitly UTC-labeled agent/admin views stay as they are (inventory recorded in T0).

### Locks, invariants and recovery summary

| Invariant | Scope | Enforcement |
| --- | --- | --- |
| One binding per identity per project | project + identity | UNIQUE index; create in the same tx as task insert under the existing project allocation lock |
| One binding per task | task | UNIQUE `task_id` |
| Completion once, latest attempt only | task | `FOR UPDATE` task lock in `completeTaskFromConfirmedMerge` + CAS on status; launch keeps its existing conditional status write (two-racer test: merge consumer vs concurrent relaunch) |
| One refusal record per (task, run, reason) | task activity | partial unique index `task_activity_delivery_refusal_uq` + `onConflictDoNothing` |
| Resolution flag frozen once delivery starts | run | `PATCH …/delivery-policy` refuses when `promotion_state ∈ {claiming, done}` or `pr_number` set, under the route's run lock |
| Statement immutable while task not Backlog | task | existing `BACKLOG_GATED_FIELDS` + `updateTaskStatement` gate (asserted by C3, not re-implemented) |
| Merge observed once | workspace | existing column-guarded edge; event emitted in the same tx |
| Backfill/reconciliation idempotent | task | `ON CONFLICT DO NOTHING`, deterministic classification, dry-run default |
| Sidebar never mutates | read model | read-only predicate; no writes in rail query |

Crash windows: event emission is inside the scan transaction (no window); consumer crash before completion → redelivered; after completion → already-Done no-op. No external side effects are added to any transaction (PR body text is computed before the existing PR creation call).

## Specification baseline (Phase 0 owners)

| Area | Canonical documents (update in place; R5 structure; Designed → Implemented) |
| --- | --- |
| Source identity + backfill | `docs/system-analytics/tasks.md` (binding entity, lifecycle, refusal table), `docs/system-analytics/external-operations.md` (task_create source, by-source, bind, librarian refusal), new ADR-206; `docs/database-schema.md`, `docs/db/runs-domain.md` (the ERD that draws `tasks`) Mermaid entity + relation, generated `docs/db/erd.dbml` |
| Completion after merge | `docs/system-analytics/tasks.md` (completion matrix by strategy × resolution × trigger order; skip vs refuse table), `docs/system-analytics/domain-events.md` + `docs/db/domain-events.md` (`run.pr_merged`, consumer, membership decisions), `docs/db/attention-domain.md` (new activity kinds, refusal unique index, inbox CHECK), `docs/system-analytics/scheduler.md` (pr_state_scan emits), `docs/system-analytics/workbench-git.md` + `branch-sync.md` (PR body references, merged-before-finalize order), `docs/api/web.openapi.yaml` (`PATCH /api/runs/{runId}/delivery-policy` `resolvesTask` + 409), `docs/api/external/operations.openapi.yaml` (`PulseEventKind`), new ADR-207 |
| Timing | `docs/system-analytics/runs.md` (metric definitions, quality states), `docs/screens/runs/flow-run.md`, new ADR-208 |
| Sidebar | `docs/screens/chrome/active-workspaces.md`, `docs/screens/chrome/left-rail.md`, `docs/system-analytics/workbench-git.md` (amend D14 text), `docs/system-analytics/projects.md` (retained surface), new ADR-209 amending ADR-181 |
| Task page, alignment, time | new `docs/screens/projects/task-detail.md` (state → action matrix, result card, history columns; linked from `project-board.md`), `docs/screens/components.md` (numeric cell convention, LocalTime) |
| Wire | `docs/api/external/operations.openapi.yaml` (task_create `source`, `TaskDTO.source`, by-source GET, bind PUT), `docs/api/web.openapi.yaml` (human detach route), MCP tool schemas in `mcp/src/tools.ts` + `tool-contract.test.ts` |
| Public docs | `site-docs/guides/run-git.md` and `site-docs/ru/guides/run-git.md` (completion after merge, closing reference) |
| Scripts | `docs/getting-started.md` Scripts + `web/CLAUDE.md` for `tasks:backfill-sources` |

No new env var, port, mount, sidecar or error code (existing `CONFIG | CONFLICT | PRECONDITION | UNAUTHORIZED`); no deployment wiring changes. ADR numbers 202–205 and migrations `0340`–`0342` are reserved from `master` at `b84f47eef`; recheck against `master` immediately before merge (renumber pass budgeted in T14).

## Tasks

### Phase 0 — Freeze contracts and verify assumptions

- [x] **T0. Specify and verify before code.** No dependencies. Write the specification baseline above (ADR stubs 202–205 headers first), OpenAPI/MCP examples, refusal tables, and the acceptance IDs below. Already resolved from source during refinement (record in specs as facts, do not re-investigate): statement history = `task_statement_revisions`; statement immutable while not Backlog; `launched_at` is not a timing input; attention stream covers all `task_activity`; Run Git panel merged-before-finalize order. Verify and record: `agent_turns` coverage for agent/scratch timing; force-relaunch effect on a Done task; core compat-floor mechanism and whether `SUPPORTED_V1_DIGESTS` must change; no counter-evidence for legacy `resolvesTask ⇒ true` (D6); every reader of `INTERNAL_PROJECTION_EVENT_KINDS` / `AGENT_TRIGGER_EVENT_KINDS` so the `run.pr_merged` trigger exclusion is placed where it changes nothing else; deployed MAI-27 Run IDs only if readable without mutation. Write the skip-vs-refuse table and the completion matrix (strategy × resolution × trigger order) in `tasks.md` exactly as `evaluateMergeCompletion` will branch. Run discovery for every test file in the traceability table (`vitest list`, `playwright --list`) and record baselines. Validators: `pnpm validate:contracts`, `pnpm validate:docs`, `pnpm --filter maister-web db:erd --check`. Logging: none. Exit: specs reviewed, assumptions resolved or plan amended, baselines green.

  - **T0 findings (2026-11-15):** `agent_turns` rows are written for agent and scratch turns (`lib/agents/turn-claim.ts`, `generation-turn.ts`, `execution-host/create-intent.ts`), so agent/scratch execution = `[created_at, completed_at ?? end]`; a Run with no turns is `unavailable`. A manual relaunch of a `Done` task is accepted only when the human decision accepted that status (`taskLaunchAllowsTaskStatus`) and returns the task to `InFlight` — "Start a new attempt" copy states this. The only package compatibility mechanism is `compat.engine_min` (flow **engine** version, currently `3.10.0` in the fixture); there is no platform-release floor, so D4 is amended: the new intake instructions call `task_find_by_source` and, when the tool is absent or `task_create` refuses `source` with 422, fall back to the legacy marker dedup (old platforms keep working; no engine bump). `SUPPORTED_V1_DIGESTS` is computed over the platform's own `OPERATIONAL_FORM_SCHEMA` + appendix, not package skill text — no change. Legacy `resolvesTask` has no prior field, so absent ⇒ `true` has no counter-evidence. `AGENT_TRIGGER_EVENT_KINDS` readers: `lib/agents/{triggers,definition,project-links}.ts`; `INTERNAL_PROJECTION_EVENT_KINDS` has no reader outside `taxonomy.ts` — T4 adds a separate `PLATFORM_ONLY_EVENT_KINDS = ["run.pr_merged"]` excluded from agent triggers instead of reusing the projection list (it is a real run update for the pulse). Baselines: targeted integration files (pr-state-scan, task-completion, portfolio, task-detail, auto-launch, ext tasks route, operational-core) 7 files / 85 tests green; full unit suite recorded in the T0 commit message.

<!-- Commit checkpoint: T0 -->

### Phase 1 — Source identity

- [x] **T1. Binding schema and service.** Depends T0. Files: `web/lib/db/schema.ts`, migration `0340_task_external_sources` (SQL + `_journal.json` + snapshot; `drizzle-kit generate` reports no changes; D1 CHECKs; `task_id NOT NULL ON DELETE CASCADE`), new `web/lib/tasks/external-source/{model,validate,service}.ts`, `web/lib/services/tasks.ts` (`createTask` with optional source in the same tx). RED: `web/lib/tasks/external-source/__tests__/service.integration.test.ts` — cases: same key different instance/scope persists both; duplicate identity → `source_already_bound` with no task row left (S1); no URL/no key display fallback (S2); title/prompt edit leaves binding; rebind refused; detach deletes row + writes `source_detached` (S3); migration fresh / upgrade from `0229` with legacy tasks / re-apply, and each CHECK rejects its bad value at the DB layer bypassing zod (M1). Unit `web/lib/tasks/external-source/__tests__/validate.test.ts` — boundary table for every bound (min/max/just-over, `http://`, userinfo, query in instance) (S7). GREEN: minimal service + `createTask` branch. REFACTOR: reuse the existing project allocation lock helper and `recordTaskActivity`; no second insert path. Logging: INFO `[taskSource.bind] created {projectId, taskId, kind, instance, origin}`, WARN on conflict with `{reason}`; never URL query/credentials.
- [x] **T2. Legacy backfill command.** Depends T1. Files: `web/lib/tasks/external-source/backfill.ts`, `web/scripts/backfill-task-sources.ts`, `web/package.json` script `tasks:backfill-sources`. RED: `web/lib/tasks/external-source/__tests__/backfill.integration.test.ts` (S4) with MAI-8/20/24/27-shaped fixtures, a marker present only in an older `task_statement_revisions` row, two different identities across prompt/history (`conflicting`), duplicates, numeric IDs, title mismatch, repeat run. Pure marker parsing/classification is owned by unit `backfill-classify.test.ts`; the integration file asserts only dry-run no-write, apply writes, idempotent re-apply and untouched tasks/runs/relations/activity. GREEN/REFACTOR: classification is a pure function reused by D4's `task_source_bind` exact-match rule (one parser, two callers). Logging: INFO summary counts per classification; WARN per conflicting/duplicate task key (no prompt text).
- [x] **T3. Ext API, MCP and DTO parity.** Depends T1. Files: `web/app/api/v1/ext/projects/[slug]/tasks/{route.ts,by-source/route.ts,[taskId]/source/route.ts}`, session detach route under `web/app/api/projects/[slug]/tasks/[number]/source/route.ts`, `web/lib/services/tasks.ts` (`TaskDTO.source`), `mcp/src/tools.ts` (`task_create.source`, `task_find_by_source`, `task_source_bind`), `mcp/src/toolsets.ts`. RED: `web/app/api/v1/ext/projects/[slug]/tasks/__tests__/source.integration.test.ts` — S5 (HTTP behavior per route), S8 (same Idempotency-Key + same body → stored receipt; same key + different `source` → 409; librarian token + `source` → 422), A1 (one positive grant per route + foreign-project 404 + missing-scope 403 + agent token cannot detach); `mcp/src/__tests__/tool-contract.test.ts` owns MCP schema/forwarding parity only (no re-test of server semantics). GREEN/REFACTOR: routes delegate to the T1 service; `TaskDTO.source` projected once in `taskToDTO`. Logging: existing ext-handler audit; WARN refusals with reason.

  - **Implementation amendment (T1, 2026-11-15):** migration numbers swapped so every phase applies its own CHECKs in journal order: `0341_task_activity_source_completion_kinds` (both activity kinds, `inbox_items` CHECK, `task_activity_delivery_refusal_uq`) ships with T1 because detach writes `source_detached`; `0342_domain_event_run_pr_merged` ships with T4. Migration coverage lives in `lib/db/__tests__/migration-0340-task-sources.integration.test.ts` (repo convention for migration suites) instead of the service suite. Re-application is the migrator's journal guarantee and is not re-tested. `createTask`/`bindTaskSource` take raw `source` and validate at the service seam (`requireTaskSource` → `CONFIG`). Unit baseline: 27 known environmental/flaky failures reproduced on a clean `b84f47eef` checkout (launch-options/scratch-runs route tests, sweeper timing, atomic file mode, instrumentation, pg-container daemon probe); phase gates compare failing-name sets against that union.

  - **Gate amendment (2026-11-15):** the full web integration suite (660 files) takes hours on the 4-core host, so each phase gate runs the full **unit** suite plus every integration file in the phase's domain (task/ext routes, services, the new suites); the full integration suite runs once in T14 before the final commit. MCP: `mcp/src/rest.ts` and the routing type gain `PUT` for `task_source_bind`; the bind body is a flat schema in the OpenAPI because the contract checker dereferences only single-element `allOf`.

<!-- Commit checkpoint: T1–T3 -->

### Phase 2 — Completion after merge

- [x] **T4. `run.pr_merged` event and activity kinds.** Depends T0, **T1** (migration journal order `0340 → 0341 → 0342` must match implementation order; `when` stays monotonic). Files: `web/lib/domain-events/taxonomy.ts`, migration `0342_domain_event_run_pr_merged` (CHECK widening only) and `0341_task_activity_source_completion_kinds` (task_activity CHECK + `inbox_items` CHECK widening for `delivery_completion_not_applied` + partial unique index `task_activity_delivery_refusal_uq`) (each a SQL + journal + snapshot triple; `drizzle-kit generate` reports no changes), `web/lib/db/schema.ts`, `web/lib/scheduler/handlers/pr-state-scan.ts` (emit inside `mergedEdge` tx), `web/lib/ext-activity/domain-events.ts` (`mapDomainEvent` arm), trigger exclusion per T0 finding, `docs/api/external/operations.openapi.yaml` `PulseEventKind`. Fan-out is the exhaustive list in D5; any additional reader found by `grep -rn "DOMAIN_EVENT_KINDS\|DomainEventKind" web/lib web/app` gets an explicit membership line in ADR-207. RED: extend `pr-state-scan.integration.test.ts` (C1: merged edge emits exactly one event; failed read, closed-unmerged and re-scan emit none); M1 cases for both migrations (upgrade from `0340`, re-apply, duplicate refusal insert is a no-op). Logging: existing scan logs plus INFO `[prStateScan] merge event emitted {runId, workspaceId}`.
- [x] **T5. Resolution snapshot and completion entry point.** Depends T4. Files: `web/lib/runs/delivery-policy.ts` (`resolvesTask` in type + both strict schemas + `snapshotResolvesTask`), launch snapshot writer, `web/app/api/runs/[runId]/delivery-policy/route.ts` (accept field; 409 `delivery_already_started`), `web/lib/runs/auto-delivery.ts` (preserve field), `web/lib/services/task-completion.ts` (`completeTaskFromConfirmedMerge`), `web/lib/tasks/completion-evidence.ts` (`evaluateMergeCompletion`), promote dialog + `web/components/workbench/git-panel-pr.tsx` (partial checkbox), `docs/api/web.openapi.yaml`. RED: unit `lib/tasks/__tests__/completion-evidence.test.ts` owns the decision table (every skip and every refusal reason, one row each); integration `task-completion.integration.test.ts` owns C2 (applies once, redelivery no-op), C3 persistence (one deduped refusal row; statement edit on an InFlight task refused and completion still applies; `auto-delivery` keeps `resolvesTask=false`), C4 racer; delivery-policy route integration case for the 409 after PR recorded. GREEN/REFACTOR: `completeTaskFromConfirmedMerge` and `completeTaskInTransaction` share one private lock-and-load helper; no duplicated evidence query. Logging: INFO auto-completion `{taskId, runId}`; WARN refusal `{taskId, runId, reason}`.
  - **T5 amendments (2026-11-15):** `resolvesTask` is a run-snapshot-only field (`DeliveryPolicy.resolvesTask?`), excluded from `StoredDeliveryPolicy`/override schemas (project/flow config never sets it); launch writes nothing — absent ⇒ `true` via `snapshotResolvesTask`, which avoids churning every snapshot-equality test. `run.pr_merged` lives in `OPERATIONAL_ATTENTION_EVENT_KINDS` (invalidate-only): the taxonomy partition test requires every `run.*` kind to be attention-visible, and the counted list would double-count the `run_pr_merged` activity twin. Refusal inbox items use a new `InboxSourceRef` kind `delivery_refusal` (needs the activity id → `insertTaskActivityOnce`). UI: the git-state read model exposes `taskResolution {resolvesTask, frozen}`; the panel's `mutate` gains an optional `before` prerequisite (PATCH runs under the same busy/error handling); the review panel shows the checkbox for `pull_request` mode via `taskResolutionEditable`. The C4 racer uses the launch claim's critical section (task `FOR UPDATE` + Backlog/InFlight admission + newer run insert) with the loser proven parked via `pg_stat_activity`; a guard-disabled variant is not included because the lock cannot be disabled without a production toggle.

- [x] **T6. Consumer, as-plan fix and history reconciliation.** Depends T5. Files: new `web/lib/domain-events/consumers/task-delivery-completion.ts`, `web/lib/domain-events/consumers.ts`, `web/lib/domain-events/auto-launch.ts`, reconciliation in `web/scripts/reconcile-merged-task-completion.ts` (dry-run default). Consumer handles exactly `run.pr_merged | run.done`. RED: new `web/lib/domain-events/__tests__/task-delivery-completion.integration.test.ts` driving the real dispatcher (`runSchedulerTick` → dispatch) — C5 (restart between scan and consumption), C6 (reconciliation dry-run/apply), C9 (panel PR merged before finalize: merge event skips silently, finalize `run.done` completes; and reverse order); extend `lib/domain-events/__tests__/auto-launch.integration.test.ts` (C7). Logging: INFO per applied completion; WARN per refusal; ERROR only on unexpected consumer failure (dispatcher retries).
- [x] **T7. Closing references in generated PR bodies.** Depends T1, T5. Files: `web/lib/runs/promote.ts`, `web/lib/workbench-git/pull-request.ts`, `web/lib/workbench-git/read-model.ts`. RED: extend `promote-pr.test.ts`, `pull-request.test.ts` (C8). Logging: none beyond existing PR creation logs.

<!-- Commit checkpoint: T4–T7 -->

### Phase 3 — Timing and sidebar

- [x] **T8. Run timing projection.** Depends T0. Files: new `web/lib/runs/run-timing.ts` (pure), `web/lib/queries/run-timing.ts` (batched loader for N Runs — one query per evidence table, no N+1), new `web/lib/format/duration.ts` (`formatDurationMs`), `web/lib/queries/task-detail.ts`, `web/app/(app)/runs/[runId]/layout.tsx` (replace summed active time and its private `formatDuration`), `web/app/(app)/runs/page.tsx` (Duration + Execution columns via the batched loader, Q5), new `web/components/runs/run-timing-detail.tsx`. RED: unit `web/lib/runs/__tests__/run-timing.test.ts` owns T-1–T-4 and the T-5 child-clipping arithmetic (interval algebra on literal inputs); integration `web/lib/queries/__tests__/run-timing.integration.test.ts` owns only loader mapping (one fixture per evidence source: node_attempts, hitl, checkpoint, agent_turns, child Run) and batching; unit `lib/format/__tests__/duration.test.ts` owns unit boundaries (59 s, 60 s, 1 h, missing → "—"). GREEN/REFACTOR: evaluate whether `computeTimingIntervals` (`lib/evaluations/metrics.ts:144`) can be reused for the union measure; reuse if semantics match, otherwise leave it untouched. Logging: WARN once per load when evidence is inconsistent (`ended_at < started_at`), no per-row logs.
- [x] **T9. Active-attention predicate and rail.** Depends T0. The TS classifier is `satisfies Record<RunStatus, …>` (compile-time exhaustiveness — no runtime exhaustiveness test); the SQL fragment and the classifier are cross-checked by one integration table test over every status × task-state × supersession cell (R-1/R-2). `ACTIVE_RUN_STATUSES` keeps its other consumers (`project.ts`, attention stream, launch-intent) unchanged — the rail stops using it. Files: new `web/lib/runs/active-attention.ts`, `web/lib/queries/portfolio.ts` (`getRailWorkspaceGroups` rows + counter), `web/components/chrome/{left-rail,active-workspace-row}.tsx` (reason label), `web/lib/queries/project.ts` + `web/components/projects/project-workspaces.tsx` (retained Done/Abandoned rows with TTL). RED: extend `portfolio.integration.test.ts` (R-1–R-3), `e2e/active-workspaces.spec.ts` (R-4). Logging: none (read model).

<!-- Commit checkpoint: T8–T9 -->

### Phase 4 — Task page and presentation

- [ ] **T10. Numeric alignment and local time.** Depends T0. Numeric cells get inline `text-right tabular-nums` (no shared variant module). Files: new `web/components/ui/local-time.tsx`, `web/components/agents/agent-history.tsx`, `web/components/work/work-rows-table.tsx`, `web/components/activity/activity-row-list.tsx`, `web/app/(app)/runs/page.tsx`, `web/components/board/panels/{task-activity-log,token-audit-table}.tsx`. RED: `e2e/desk.spec.ts` + task page case comparing the same event across surfaces with a fixed browser timezone (P-5). Logging: none.
- [ ] **T11. Task page data and state model.** Depends T3, T5, T8. Files: `web/lib/queries/task-detail.ts` (source, resolving Run, delivery split, timing, PR state), new `web/lib/tasks/task-next-action.ts` (pure state → primary/secondary actions). RED: extend `task-detail.integration.test.ts` (P-1, P-2), new `task-next-action.test.ts`. Logging: none.
- [ ] **T12. Task page composition and localization.** Depends T10, T11. Files: `web/app/(app)/projects/[slug]/tasks/[number]/page.tsx`, new `web/components/tasks/{task-header-actions,task-result-card,task-run-history,task-statement-preview,task-source-chip}.tsx`, `web/components/social/{task-timeline,relations-editor}.tsx`, `web/components/agents/task-qualification-control.tsx`, `web/messages/{en,ru}.json`. Label maps typed `satisfies Record<TaskActivityEventKind, …>`. Also create `docs/screens/projects/task-detail.md` content as Implemented. RED: new `e2e/task-detail-states.spec.ts` (P-3 state → primary action, one "Run again", on-demand graph/diff; P-4 grouping of repetitive system events with entries retained) + migrate `task-timeline.test.ts` (drop raw-kind fallback assertion), `relations-editor.test.ts`, `task-complete-action.dom.test.ts`. Unit `lib/tasks/__tests__/task-next-action.test.ts` (T11) owns the state matrix; the Playwright spec samples one state per primary action, not the full matrix. Logging: none.

<!-- Commit checkpoint: T10–T12 -->

### Phase 5 — Companion package, docs and acceptance

- [ ] **T13. Intake instructions and mirror.** Depends T3. Companion repo `maister-plugins` (separate branch/commit, no tag push without owner approval): intake skill + both agents per D4. Platform: mirror into `web/test-support/fixtures/operational-core/**`, extend `operational-core.integration.test.ts` (S6: create with source, `source_already_bound` reuse, legacy bind, old-pin marker-only create still accepted). Logging: skill emits existing operational_v1 diagnostics.
- [ ] **T14. Docs status, renumber pass and combined verification.** Depends T2, T6, T7, T9, T12, T13. Mark verified sections Implemented; recheck ADR/migration numbers against `master`; record hand-off note in `codex-github-task-reconciliation.md` ("identity core delivered by Package 3; re-base D2 on `task_external_sources`") without rewriting its design; run the full gates below at 1366×768, 1440×1000, 390×844, EN/RU, light/dark. Logging: none.

<!-- Commit checkpoint: T13 (companion + mirror), T14 -->

## Acceptance criteria

| ID | Given → when → expected |
| --- | --- |
| S1 | Two bindings with the same `external_key` `#7` in different instances or scopes (and different `external_id`) both persist; the same `(kind, instance, external_id)` twice in one project → 409 with the existing task, no second task. |
| S2 | A binding with no URL and no key works end to end; display falls back to `external_id`; no link rendered. |
| S3 | Editing title/prompt (UI, PATCH, MCP) leaves the binding unchanged; re-binding to another identity is refused; human detach is audited and agent tokens cannot detach. |
| S4 | Backfill dry-run classifies bindable/incomplete/malformed/conflicting/duplicate without writes; apply binds MAI-8/20/24-shaped tasks to their node IDs/#7/#29/#6, skips the MAI-27 shape, and a second apply changes nothing; task IDs, runs, relations, activity unchanged. |
| S5 | `task_create` with source, `task_find_by_source`, `task_source_bind`, `TaskDTO.source` behave identically over HTTP and MCP; positive grant per route, foreign-project and missing-scope refusals. |
| S7 | Every `source` field bound (D1 CHECKs) is refused with 422 `CONFIG` at the API just over its limit and accepted at its limit; `http://`, userinfo and a scheme/path in `instance` are refused; the same bad values inserted directly are refused by the DB CHECK (M1). |
| S8 | A librarian token sending `source` → 422 `source_not_allowed_for_token` (librarian is the only token kind with `Idempotency-Key` replay on `task_create`); for project/personal/agent tokens a repeated create for a bound identity returns 409 `source_already_bound` naming the existing task and creates nothing (the binding is the dedup — amended in T3: the original "same key + different source" case is unreachable). |
| S6 | New intake instructions reuse an existing bound task instead of creating one; old pinned snapshot still creates marker-only tasks that a later backfill binds. A Jira-kind binding on a GitVerse-hosted project is accepted (source independent of code host). |
| C1 | A PR merge observed by `pr_state_scan` emits exactly one `run.pr_merged`; failed/partial reads emit nothing; closed-unmerged emits nothing. |
| C2 | Eligible merged PR of the newest attempt completes the task once with `task_completed {runId, cause:"pr_merged"}`; redelivery is a no-op. |
| C3 | Merge confirmed but newer attempt started (`superseded_by_newer_attempt`), partial resolution (`partial_resolution`) or task `Backlog`/`Abandoned` (`task_not_in_flight`) → no completion and exactly one `delivery_completion_not_applied {runId, reason}` even after redelivery; PR-open-only, local-merge, result-only and publish_branch `run.done` → no completion and **no** activity. An attempted statement/title edit on the InFlight task is refused and does not prevent completion. `auto-delivery` rewriting the snapshot keeps `resolvesTask=false`. Manual completion still works where evidence allows. |
| C4 | Two-racer from the invariant "no Done task with a newer live attempt": racer A = `completeTaskFromConfirmedMerge`, racer B = relaunch of the same task; the winner holds its writes uncommitted while the loser is asserted parked on the task lock via `pg_stat_activity`; both orders end in exactly one consistent outcome (Done with no newer Run, or newer Run with task InFlight + refusal `superseded_by_newer_attempt`). A guard-disabled variant (lock removed) is shown to fail, proving the test exercises the lock. |
| C5 | Consumer driven through the real dispatcher survives a restart between scan and consumption and completes once after restart. |
| C6 | History reconciliation dry-run lists eligible InFlight tasks with merged PRs; apply completes them once; existing Done tasks untouched. |
| C7 | as-plan PR-delivered child is not Done on `run.done`; becomes Done after merge; local-merge child behavior unchanged. |
| C9 | Run Git panel PR merged on GitHub **before** finalize: the `run.pr_merged` event skips silently (Run not Done, no activity); the later finalize's `run.done` completes the task once. Reverse order (finalize first, merge later) also completes once. `resolvesTask` change after the PR is recorded → 409 `delivery_already_started`. |
| M1 | Migrations `0340`–`0342`: apply on a fresh DB, upgrade from `0229` with legacy tasks/activity/inbox rows (all preserved), re-application is a no-op, `drizzle-kit generate` reports no changes; each new CHECK rejects its invalid value and the refusal unique index makes a duplicate insert a no-op. |
| C8 | Generated bodies include `Closes owner/repo#N` only for an eligible GitHub binding on the same host; never for internal numbers, other kinds, other hosts or partial resolution. |
| T-1 | A Run with 30 min human wait between two 5 min nodes: Duration ≈ 40 min, Execution = 10 min, breakdown shows 30 min human input. |
| T-2 | Two parallel 10 min attempts overlapping fully: Execution = 10 min, not 20. |
| T-3 | Retry and checkpoint/resume: earlier closed intervals kept; idle period excluded; no double count. |
| T-4 | Terminal Run with an open attempt → `partial` "≈"; pre-ledger Run → `unavailable` "—" with reason; never 0. |
| T-5 | Orchestrator waiting on a child counts only child execution inside its window; the detail popover opens by mouse, keyboard and touch. The `/runs` ledger shows the same Duration and Execution values as the task page for the same Run. |
| R-1 | Done/Abandoned Runs (with TTL) and superseded Failed/Crashed attempts leave the rail and counter, for open, closed and task-less contexts; the MAI-27 shape (Done task with successful + superseded Failed attempt) shows nothing. |
| R-2 | Running Run of a Done task, NeedsInput, Review, newest Failed of an open task and a task-less Failed scratch with retained workspace remain with their reason labels. |
| R-3 | Excluded Runs stay in task history, `/runs` and project "Runs and working copies"; no status, workspace, archive or GC change. |
| R-4 | After completion, refresh and live attention update show identical membership and counter. |
| P-1 | Done task shows result card (resolving Run from completion activity, merged PR link + state) above the statement and launch settings; resolving ≠ newest Run handled. |
| P-2 | History shows historical runner per attempt vs "Next launch settings"; delivery strategy vs actual artifact separated; statuses localized. |
| P-3 | Every task state shows its primary action per D10; one "Run again" entry; secondary actions in the menu; relations form, qualification details, graph and diff open on demand; HITL/blocking reasons stay visible. |
| P-4 | All activity kinds localized EN/RU (compile-time `satisfies` map + i18n key parity, no runtime exhaustiveness test); repetitive system events grouped with entries retained. |
| P-5 | The same completion event shows the same local time with zone on home, task page and `/runs`; numeric columns right-aligned with tabular numerals; missing ≠ 0; EN/RU, light/dark, 390 px, keyboard. |
| A1 | Authorization: viewer reads `source`; member with `editTask` binds via UI; agent token binds only in its project; no token detaches; foreign project → scoped 404. |

## Requirement → task → test traceability

Paths under `web/` unless noted. IT = Vitest `integration`, U = Vitest `unit`, PW = Playwright `authed`.

| IDs | Tasks | Owner test |
| --- | --- | --- |
| S1–S3 | T1, T3, T12 | IT new `lib/tasks/external-source/__tests__/service.integration.test.ts`; PW `e2e/task-detail-states.spec.ts` (chip, no-URL) |
| S7 | T1 | U new `lib/tasks/external-source/__tests__/validate.test.ts` (API bounds); DB half owned by M1 |
| M1 | T1, T4 | IT `service.integration.test.ts` (0340) and `pr-state-scan.integration.test.ts` migration block (0341–0342); plus `pnpm --filter maister-web db:migrate` on a fresh DB and `pnpm --filter maister-web db:check` + `db:generate` (no changes) in gates |
| S4 | T2 | U new `lib/tasks/external-source/__tests__/backfill-classify.test.ts` (parsing/classes); IT new `lib/tasks/external-source/__tests__/backfill.integration.test.ts` (write behavior) |
| S5, S8, A1 | T3 | IT new `app/api/v1/ext/projects/[slug]/tasks/__tests__/source.integration.test.ts`; U `mcp/src/__tests__/tool-contract.test.ts` (MCP parity only) |
| S6 | T13 | IT `lib/packages/__tests__/operational-core.integration.test.ts` |
| C1 | T4 | IT `lib/scheduler/handlers/__tests__/pr-state-scan.integration.test.ts` |
| C2–C4 | T5 | U `lib/tasks/__tests__/completion-evidence.test.ts` (decision table: every skip + refusal reason); IT `lib/services/__tests__/task-completion.integration.test.ts` (persistence, dedup, racer) |
| C5–C7, C9 | T5, T6 | IT new `lib/domain-events/__tests__/task-delivery-completion.integration.test.ts` (C5, C6, C9 trigger order); IT `lib/domain-events/__tests__/auto-launch.integration.test.ts` (C7); delivery-policy route 409 in the route's existing integration suite (C9) |
| C8 | T7 | U `lib/runs/__tests__/promote-pr.test.ts`, `lib/workbench-git/__tests__/pull-request.test.ts` |
| T-1–T-5 | T8 | U new `lib/runs/__tests__/run-timing.test.ts` (algebra, owner); U new `lib/format/__tests__/duration.test.ts`; IT new `lib/queries/__tests__/run-timing.integration.test.ts` (loader mapping only); PW popover in `e2e/task-detail-states.spec.ts` |
| R-1–R-3 | T9 | IT `lib/queries/__tests__/portfolio.integration.test.ts`; U `components/chrome/__tests__/left-rail.test.ts` (migrate counter assumptions) |
| R-4 | T9 | PW `e2e/active-workspaces.spec.ts`, `e2e/portfolio-board.spec.ts` (retained rows) |
| P-1–P-2 | T11 | IT `lib/queries/__tests__/task-detail.integration.test.ts` (migrate `deliveryStatus`/`durationMs` assertions) |
| P-3–P-4 | T12 | PW new `e2e/task-detail-states.spec.ts`; migrate `e2e/{task-launch-gating,run-task-context,social-board}.spec.ts` selectors; U `components/social/__tests__/{task-timeline,relations-editor}.test.ts`, `task-complete-action.dom.test.ts` |
| P-5 | T10 | PW `e2e/desk.spec.ts`, `e2e/activity-feed.spec.ts` with `timezoneId` set; new task page assertion |

Existing assertions to migrate (in-phase): task-detail delivery label strings and duration (T11); left-rail counter including TTL rows and Failed rows (T9); `active-workspaces.spec.ts` TTL-row expectations (T9); auto-launch "as-plan Done on run.done" for PR strategy (T6); run layout "Active time" label tests if present (T8); `task-timeline.test.ts` raw-kind fallback (T12); MCP tool list snapshot in `tool-contract.test.ts` (T3). New Playwright spec must be added to the `web/playwright.config.ts` authed allowlist in T12; new integration files match `lib/**/__tests__/*.integration.test.ts` / `app/**` globs (verify with `vitest list` in T0).

## Validation commands and exit gates

```sh
pnpm install --frozen-lockfile
pnpm --filter @maister/mcp build
pnpm --dir web exec vitest list --configLoader runner --filesOnly --project integration service.integration.test.ts backfill.integration.test.ts source.integration.test.ts pr-state-scan.integration.test.ts task-completion.integration.test.ts task-delivery-completion.integration.test.ts run-timing.integration.test.ts portfolio.integration.test.ts task-detail.integration.test.ts operational-core.integration.test.ts
pnpm --dir web test:integration -- <files of the phase>
pnpm --dir web test:unit -- run-timing duration completion-evidence validate backfill-classify promote-pr pull-request left-rail task-timeline relations-editor task-next-action
pnpm --filter @maister/mcp test
env -u E2E_BASE_URL pnpm --dir web test:e2e --project authed --workers=1 task-detail-states.spec.ts active-workspaces.spec.ts portfolio-board.spec.ts desk.spec.ts activity-feed.spec.ts task-launch-gating.spec.ts run-task-context.spec.ts social-board.spec.ts
pnpm --filter maister-web tasks:backfill-sources --dry-run   # against the disposable fixture DB only
```

Every phase exits with its focused checks green plus `pnpm --dir web test:unit`, `pnpm --dir web test:integration`, `pnpm --dir web typecheck`, `pnpm --dir web exec eslint .` (zero new warnings). Contract/doc phases also run `pnpm validate:contracts`, `pnpm validate:docs`, `pnpm --filter maister-web db:erd --check`. Migration tasks verify fresh DB, upgrade from `0229` with legacy rows, and a second application. Pre-existing red tests get an explicit quarantine task with reason, never silent tolerance. Adversarial review after each fix cycle for T3 (authorization), T5–T6 (completion races) and T9 (predicate fan-out).

## Rollout sequence

1. Deploy platform (migrations `0340`–`0342`, new routes/MCP, consumer, UI). Old intake pins keep working (marker-only creates accepted).
2. Run `tasks:backfill-sources --dry-run` on the instance, review the report (owner), then `--apply`.
3. Run the merged-PR history reconciliation dry-run, review, apply.
4. Owner tags the companion core release and re-pins project attachments; new intake runs use structured identity. Re-run the backfill once after re-pin to catch marker-only tasks created in between.
5. Rollback: application rollback to a pre-package build ignores the additive table and event kind (old binaries never read them; the widened CHECK accepts old kinds). Do not downgrade the core pin below the compat floor while new bindings exist.

## Commit Plan

Future review boundaries (no commits during planning):

- T0: `docs: specify third UX package contracts`
- T1–T3: `feat(tasks): persist structured external source bindings`
- T4–T7: `feat(tasks): complete tasks after confirmed PR merge`
- T8–T9: `feat(runs): measure execution time and focus the active rail`
- T10–T12: `feat(tasks): simplify the task page around state and result`
- T13: companion `feat(core): create GitHub intake tasks with structured source identity` + platform `test(packages): mirror structured intake identity`
- T14: fold docs status and renumber fixes into owning commits where possible; otherwise `docs: record third UX package verification`

## Risks and limits

- Deployed instance revision, core pin and the 14 unverified GitHub-prefixed tasks are unknown; the backfill dry-run is the only authority for them.
- Timing for legacy Runs may be `unavailable` or `partial`; this is intended, not a defect.
- GitHub issue closure is not observed by MAIster in this package; only the closing reference and task completion are verifiable here.
- The task page rewrite touches a 958-line Server Component; keep data loading in `task-detail.ts` and composition in new components to avoid a second loader.

## Decided during refinement (2026-11-15, owner-approved recommendations)

- `run.pr_merged` is **not** an agent trigger (completion is platform-owned).
- `delivery_completion_not_applied` **joins** `inbox_items` (it is a decision for subscribers); `source_detached` does not.
- Librarian tokens may **not** send `source` on `task_create` (422 `source_not_allowed_for_token`).
- Refinement removed `task_revised_since_launch` / `revision_unknown` (statement is immutable while InFlight; legacy Runs would otherwise all refuse) and added the `run.done` trigger (merged-before-finalize order).
- Unrelated drift noted, not in scope: `web/CLAUDE.md` structure lists a non-existent `components/primitives.ts`; four other private `formatDuration` copies remain.

## Owner answers (2026-11-15)

1. Q1 — accepted: `resolvesTask` snapshot flag, default `true`, "Partial work" checkbox on Promote/Open PR.
2. Q2 — `publish_branch` keeps its current delivery behavior (pushes the branch per the delivery policy; configured gates/review run before promote as today). It merges nothing, so there is no merge to observe and it never auto-completes a task; completion stays the existing manual action. No change in this package.
3. Q3 — yes: as-plan PR-delivered children become Done only after merge (dependents wait for the merge).
4. Q4 — yes: a Done Run with an open PR leaves the sidebar; it stays reachable from the inbox/task page/Run page.
5. Q5 — yes: `/runs` also gets Duration + Execution (D8, T8).
6. Q6 — yes: a task-less Failed scratch Run stays in the sidebar while its workspace is retained.

No unresolved decisions remain.
