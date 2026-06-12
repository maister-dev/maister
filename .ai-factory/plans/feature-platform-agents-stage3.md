# M33 — Platform-agent substrate (Stage 3): catalog, triggers, repo_read enforcement, social integration

- **Branch**: `feature/platform-agents-stage3` (off `main` @ `f34769fd`)
- **Created**: 2026-06-12
- **Status**: Implemented (Phases 0–8 complete; gates green)
- **Design record**: the 2026-06-11 platform-agents design doc is LOST (owner: do not restore). Inputs for this plan: the /aif-plan task args (verbatim Stage-3 scope), `docs/pv/agents-as-environment-actors.md` (Stage-0 vision + locked brainstorm decisions), ADR-083/M31 (polymorphic `agent` actor, `task.triage_requeued` reserved), ADR-086/M32 (consumer seam), `.ai-factory/specs/domain-event-outbox.spec.md` (Stage-3 prep notes). The three design amendments over Stage-0: **per-agent runner**, **standalone-first**, **social layer**.

## Progress

- [x] Phase 0 — ADR-088/088 + analytics spec (commit 1)
- [x] Phase 1 — schema + migration 0048 (commit 2)
- [x] Phase 2 — definition parser + registry (commit 3)
- [x] Phase 3 — standalone launch + budgets (commit 4)
- [x] Phase 4 — enforcement L1/L3 + quarantine (commit 5; + migration 0048 for activity kinds)
- [x] Phase 5 — five triggers (commit 6)
- [x] Phase 6 — ext/MCP + tokens (commit 7)
- [x] Phase 7 — UI (commit 8)
- [x] Phase 8 — e2e + close-out (commit 9)

## Settings

- **Testing**: yes — TDD per repo convention; unit + integration + e2e matrix from the task args.
- **Logging**: standard — INFO on registration/sync, trigger fire, claim, spawn, quarantine; WARN on refusals; ERROR on spawn/protocol failures. No DEBUG flood.
- **Docs**: yes — mandatory docs checkpoint; all docs changes route through the Phase-0/Phase-8 docs tasks below.
- **Verify mode**: normal.

## Roadmap Linkage

- **Milestone**: `M33. Platform-agent substrate — Stage 3 (catalog, triggers, repo_read enforcement, social integration)` — NEW entry in `.ai-factory/ROADMAP.md` (added in Phase 8, mirroring how M31/M32 entries landed).
- **Rationale**: third stage of the validated platform-agents staged design; Stage 1 (M31 social board) and Stage 2 (M32 outbox) are merged prerequisites on `main`.

## Verified numbering (against main HEAD f34769fd)

| Artifact | Last on main | This milestone uses |
| --- | --- | --- |
| ADR | ADR-086 (domain-event outbox) | **ADR-088** (agent catalog + per-agent runner + trigger model), **ADR-089** (workspace axis + no-writes-outside-worktree invariant + quarantine) |
| Migration | `0046_domain_events.sql` | **`0048_platform_agents.sql`** (single migration) |
| Milestone | M32 | **M33** |
| Flow engine | `1.4.0` (M30) | **`1.5.0`** (new `agent:` node binding capability, per-capability floor) |

Sibling-branch collision risk: none known in flight; re-verify next-free numbers immediately before merge (M30/M32 lesson).

---

## Design decisions

### D1. Agent definition = `.md` file; DB row = parsed index (canonical-source split)

- ALL agent definitions live in the host catalog `~/.maister/agents/<id>/agent.md` (NO `@sha` pinning — owner-editable local catalog, unlike flows). Resolved via a new `systemAgentsRoot()` helper beside `web/lib/flow-paths.ts:100` patterns. **Owner decision 2026-06-12: project-scope agents do NOT live inside the project repo** — no `<repo>/.maister/<slug>/agents/` files, no project-registration sync hook. `scope=project` is a pure binding: frontmatter `project: <slug>` (required iff `scope=project`, validated against registered projects) + `agents.project_id` + the auto-link. UI CRUD writes the `.md` into the host catalog for BOTH scopes. Repo-shipped agents remain a flow-package capability (`agent_definition`), not a catalog source.
- Frontmatter (zod schema, extends the existing `agentFrontmatterSchema` precedent at `web/lib/flows/artifact-frontmatter.ts:154`): `name` (req), `description` (req), `scope: platform|project` (req), `project` (project slug; required iff `scope=project`), `runner` (optional runner id), `workspace: none|repo_read|worktree` (req), `mode: session|subagent` (req), `triggers: (manual|cron|domain_event|webhook|flow)[]` (req, non-empty), `capability_profile` (optional, M14 shape), `risk_tier: read_only|standard|destructive` (req). Body = base/system prompt. Unknown keys: refused (strict), NOT passthrough — this schema is ours, not Claude's.
- Invalid definition → `MaisterError("CONFIG")` **at registration**; the row is not written/updated. Parsing NEVER executes content (no `setup.sh` analog exists for agents — state this in ADR-088; satisfies the fetch-vs-execute rule trivially).
- **Config→DB symmetry (mandatory tests)**: re-registration syncs every parsed column. SET (field present → column = value), CLEAR (field removed → column = column default/NULL), idempotent re-set. Applies to `runner`, `capability_profile`, `triggers`, `risk_tier`.

### D2. Tables (migration `0048_platform_agents.sql`, one migration)

- **`agents`**: `id` (text PK = dir name, safe-path-segment), `scope` (`platform|project`), `project_id` (FK nullable; CHECK `(scope='project') = (project_id IS NOT NULL)`), `name`, `description`, `runner_id` (FK `platform_acp_runners`, nullable, ON DELETE SET NULL), `workspace` enum, `mode` enum, `triggers` jsonb, `capability_profile` jsonb nullable, `risk_tier` enum, `source_path` text, `quarantined_at` timestamptz nullable, `quarantine_reason` text nullable, `enabled` bool default true, timestamps. UNIQUE `(scope, project_id, id)` is implied by PK on id — **decision: PK = `id` globally unique** (platform ids and project ids share one namespace; registration refuses collisions, mirroring slug collision refusal).
- **`agent_project_links`**: `id` PK, `agent_id` FK cascade, `project_id` FK cascade, `enabled` bool default true, `runner_override_id` FK nullable SET NULL, timestamps. UNIQUE `(agent_id, project_id)`. Project-scope agents get an auto-link to their own project at registration (uniform downstream reads).
- **`agent_schedules` rework** (table exists since M24 migration 0027, dead code — zero readers/writers, safe to reshape): DROP `agent_ref` (text), `scheduler_job_id`, `desired_state` (continuous = Mγ, out of scope). ADD `agent_id` FK cascade (the "real FK replacing text agent_ref" from the args), `cron_expr` text nullable, `timezone` text nullable, `next_fire_at` timestamptz nullable, `last_fired_at` nullable. KEEP `project_id`, `event_match` jsonb, `enabled`. New `trigger_type` CHECK: `cron|event` only; CHECK cron rows have `cron_expr AND timezone AND next_fire_at`; event rows have `event_match`.
- **`runs` alters**: extend `run_kind` enum with `'agent'`; ADD `agent_id` FK nullable SET NULL; `trigger_source` text enum (`manual|cron|domain_event|webhook|flow`) nullable; `trigger_event_id` bigint nullable (domain_events.id); `trigger_payload` jsonb nullable (bounded ≤ 32KB at write time). **Partial UNIQUE index `runs(agent_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL`** — the DB-level no-dup backstop for the at-least-once outbox consumer.
- **`tasks` alters**: `flow_id` → NULLABLE (tasks may be created un-triaged, flowless; launch refuses flowless with `PRECONDITION`; board offers a "Set up & launch" dialog that PATCHes the task first — owner answer #3); ADD `triage_status` text nullable — single value `'triaged'` stamped by the verdict op, NULL = untriaged (owner: NO `needs_human` state — missing fields just prompt the human in the launch dialog; projects without a triager stay NULL, contradiction-free); ADD `runner_id` FK nullable SET NULL, `target_branch` text nullable, `promotion_mode` text enum (`local_merge|pull_request`) nullable — verdict fields that pre-fill launch (runner rides the existing `launchOverride` tier; branch/policy pre-fill the launch dialog/workspace row — the flow resolver chain is NOT modified).
- **`project_tokens` alters**: extend `token_kind` enum with `'agent'`; ADD `agent_id` FK nullable CASCADE.
- fakeDb stubs: add every new table (M32 lesson — fakeDb stubs need new tables or unit suites crash).

### D3. Runner resolution — standalone agent chain (ADR-088)

New `resolveAgentRunner()` in `web/lib/acp-runners/resolve.ts` beside `resolveRunner()` (:135): `launchOverride → agent_project_links.runner_override_id → agents.runner_id → projects.default_runner_id → platform default`. Reuses `assertLaunchableRunner()` (:107 — exists/enabled/ready, throws `EXECUTOR_UNAVAILABLE`, no fallback) and `snapshotRunner()` (:93) → `runs.runner_snapshot` as today. Tier labels get agent-chain values added to `runner_resolution_tier` enum (e.g. `agentLinkOverride`, `agentDefault`).

**Compatibility refusals (before spawn, `EXECUTOR_UNAVAILABLE`)**:
- `mode=subagent` resolved to a runner whose `capability_agent ≠ claude` (codex can't consume `.claude/agents/*.md`) — the args' canonical example.
- `workspace ∈ {none, repo_read}` resolved to a runner with `permission_policy = dangerously_skip_permissions` (suppresses permission requests at adapter launch → L1 auto-deny cannot exist; `supervisor/src/runner-provisioner.ts:89-99`).

Flow-bound runs keep the existing 6-tier flow chain untouched; `agents.runner_id` participates ONLY in the standalone chain (documented in ADR-088).

### D4. Execution substrate: `runs.kind='agent'`, separate budget

- Reuse `runs` end-to-end (Stage-0 locked decision #5): one SSE pipeline, one reconciliation, one HITL substrate.
- **`MAISTER_MAX_CONCURRENT_AGENTS`** (default **3**, owner-set) — separate budget; the flow cap stays a separate pool counting `run_kind IN ('flow','scratch')`. **Owner-requested in the same milestone: `MAISTER_MAX_CONCURRENT_RUNS` default 3 → 6** (env-tunable as today; default change + doc/test fan-out = task 3.6). `web/lib/scheduler.ts`: `countLiveRuns()` (:67), `tryStartRun()` (:140), `promoteNextPending()` (:225), `releaseSlotOnIdle()` (:214) become kind-aware (two pools, two FIFO Pending queues, queue position computed within kind). Same advisory lock.
- **Enum fan-out checklist for `run_kind='agent'` + `trigger_source`** (every consumer, per skill-context rule):
  - Read models: `web/lib/queries/portfolio.ts` (ACTIVE_RUN_STATUSES grid — agent runs visible w/ kind badge + trigger chip), `web/lib/queries/board.ts` (board stays flow-only by explicit `run_kind` allow-list filter; task-bound agent runs surface on the task detail run history), task detail run history, any rail queries.
  - Scheduler/cap: the kind-aware split above.
  - Sweeps: `web/lib/reconcile.ts` (`status='Running'` filter picks agent runs up automatically — classification must handle no-worktree kinds: worktree-missing check applies only to `workspace=worktree` runs), `web/lib/runs/keepalive-sweeper.ts` Pass 1/2 (kind-agnostic, correct as-is — verify with test), `closeTerminalRunAssignments` (kind-agnostic), GC (agent workdirs join the 7d sweep; agent ephemeral tokens revoked — see D9).
  - State guards: HITL respond guard allow-lists stay status-based (kind-agnostic) — add regression test that an agent run in `NeedsInput` (workspace=worktree only) responds normally.
  - API specs: `docs/api/web.openapi.yaml` run schemas gain `kind`, `agent_id`, `trigger_source`.
- Launchability classifier (`web/lib/runs/launchability.ts`) is task-scoped — agent standalone runs bypass it; task-bound manual agent launches (card button) do NOT consume the task's flow-launch slot semantics: an agent run never flips `tasks.status` to `InFlight` and never bumps `attempt_number` (it is commentary/triage machinery, not a delivery attempt). Documented in ADR-088.

### D5. Workspace axis (ADR-089)

| `workspace` | cwd passed to supervisor | git worktree | `workspaces` row | promote path |
| --- | --- | --- | --- | --- |
| `none` | `.maister/<slug>/runs/<run-id>/work/` (mkdir only) | no | no | no |
| `repo_read` | `project.repo_path` (the parent checkout) | no | no | no |
| `worktree` | worktree path (existing `addWorktree`, `web/lib/worktree.ts:175`) | yes | yes | yes (existing review/promotion machinery) |

Run artifacts (`*.log`, `run.events.jsonl`, `session.json`, `cost.jsonl`) always live under `.maister/<slug>/runs/<run-id>/` regardless — supervisor write path unchanged.

`repo_read` precondition: `statusPorcelain(repo_path)` (precedent `web/lib/gc/preserve.ts:60`) must be EMPTY at launch, else `PRECONDITION` — the dirty-watchdog contract is unverifiable on a dirty baseline. Concurrent `repo_read` agent runs against the same repo are allowed (read-only); a `repo_read` launch is refused while a worktree-creating launch is mid-prep only by normal git locking (no new locks).

### D6. repo_read / none — 3-layer no-write enforcement (ADR-089)

- **L1 (supervisor, live)**: new `readOnlySession: boolean` on `StartSessionRequest` (`supervisor/src/types.ts:151`). Session-scoped generalization of M30's per-prompt `readOnlyTurn` (`supervisor/src/http-api.ts:509-527`): the ACP permission handler auto-DENIES write-class/mutating tool-call kinds for the whole session, never creating pending-permission deferreds (no deferred-leak class: requests are answered inline with deny). Read-class requests under `permission_policy=default` are ALSO auto-approved for non-interactive agents — otherwise a headless cron agent stalls on its first Read; allow-list of read-safe kinds, deny everything else. No HITL inbox rows are ever created for `readOnlySession` sessions.
- **L2 (M14, materialize-only)**: `materializeCapabilityProfile`/`mapProfileToAgentArtifacts` (`web/lib/capabilities/materialize.ts:222-277`) writes `.claude/settings.local.json` deny rules (write-class tools: Edit/Write/NotebookEdit/mutating Bash) + the agent's `capability_profile` mcp/skills roster into the session cwd. For `repo_read` cwd = parent repo: every materialized file is recorded in a **manifest** (reuse the `.maister-owned` marker pattern, materialize.ts:271) and **restored/removed after the run**; the dirty-watchdog diff EXCLUDES exactly the manifest paths. ADR-041 boundary unchanged: this is materialize-only best effort, NOT enforcement.
- **L3 (dirty-watchdog, the hard layer)**: snapshot `statusPorcelain` before spawn (must be clean), re-check at every terminal transition (`web/lib/runs/state-transitions.ts` terminal choke point). **Sequencing invariant (patch 2026-06-10-23.44 lesson): the watchdog check + ephemeral-token revoke run INSIDE the terminal choke point — before/within the status-flip transaction; NO writes to the run row may be sequenced after the terminal flip.** Dirty beyond the L2 manifest → one **quarantine transaction**: `agents.quarantined_at = now()` + `quarantine_reason`, system comment (actor `{type:'system', id:null}`) on the task when `run.task_id` is set, `recordTaskActivity` entry (new `agent_quarantined` event kind), all in ONE `db.transaction` (multi-store atomicity rule). Standalone (no-task) runs: quarantine flag + catalog badge + portfolio run-row badge only — no new inbox/notification plumbing in Stage 3 (owner-confirmed). Quarantined agents are refused at every launch entry point (`PRECONDITION`); un-quarantine = explicit UI action clearing the flag.
- **ADR-041 unchanged**: `risk_tier=destructive` → launch refused (`PRECONDITION`) until the enforcement flip lands. Stated in ADR-089.

### D7. Triggers (`runs.trigger_source`)

- **manual**: `POST /api/agents/[id]/launch` (admin/member session auth; optional `taskId`, `projectId`, `runnerId` body) + catalog-row button + task-card/detail button. Task-bound manual launches attach `task_id` → agent prompt context includes KEY-N/title/prompt.
- **cron**: seeded singleton **`agent_tick.dispatcher`** scheduler job (60s, `ensureDefaultSchedulerJobs` 5th insert, `web/lib/scheduler/jobs.ts:167-276`) — the `agent-tick.ts` stub (`web/lib/scheduler/handlers/agent-tick.ts:9-21`) finally gets its launcher. M28-proven dispatcher pattern: scan `agent_schedules` cron rows `WHERE enabled AND next_fire_at <= now()`, **atomic claim** `UPDATE … SET next_fire_at = <croner nextFireAt>, last_fired_at = now() WHERE id = ? AND next_fire_at <= now() RETURNING` (claim-atomicity unit test; one catch-up fire, no backfill — Stage-0 guard), then launch. Cron parsing reuses `web/lib/run-schedules/cron.ts` (croner v10: `validateCronExpression`, `nextFireAt`). `agent_tick` is REMOVED from the user-creatable job kinds in `web/lib/scheduler/job-admin-schema.ts:3-9` (it becomes a seeded dispatcher like `run_schedule`/`domain_event_dispatch`) — all 4+ kind-registration points in `jobs.ts` (enum :20, budget switch :125, BOTH CTE CASE sites :312/:330) re-checked, openapi job-kind enums re-synced (they were synced at `cc81607b` — touch again).
- **domain_event**: new consumer `agent_triggers` (`startFrom: 'now'`) appended to `DOMAIN_EVENT_CONSUMERS` (`web/lib/domain-events/consumers.ts:43`). Per batch: match event kind+project against enabled `agent_schedules` event rows (`event_match.kinds`) joined `agents` × enabled `agent_project_links`; **self-exclusion guard: an event whose actor IS the matched agent (`actor_type='agent' AND actor_id = agents.id`) NEVER triggers that agent** — the hard anti-loop invariant for the Q&A loop (D13); for each surviving match, claim-first: INSERT the `runs` row (status `Pending`) carrying `(agent_id, trigger_event_id)` — the partial unique index makes the duplicate insert a no-op (`ON CONFLICT DO NOTHING`) → **outbox→spawn no-dup** under at-least-once redelivery. Consumer handler never throws on conflict (idempotent contract, consumers.ts:12).
- **webhook**: `POST /api/agents/[id]/event` — auth: project token with new scope `agents:trigger` (owner-confirmed; no per-agent secret mechanism); body = free-form JSON ≤ 32KB → `trigger_payload`. Identifiers: `id` = url-param (agent), project derived from token (auth-context) and validated against the agent's links (server-state); NO body-controlled cross-resource ids.
- **flow**: `agent: <agent-id>` field on `ai_coding`/`agent` node settings (`web/lib/config.schema.ts` aiCodingSettingsSchema :643), validated with engine floor `engine_min >= 1.5.0` (pattern: retry_policy floor check :333). Compile/save-time: unknown agent id or `triggers` lacking `flow` → `CONFIG`. At `runAgentStep` (`web/lib/flows/runner-agent.ts`): **mode=session** → catalog profile substitutes the inline prompt (agent body = system prompt; node `action.prompt` appended as the task block) + capability_profile merged (node settings win); **mode=subagent** → agent `.md` materialized into the run worktree `.claude/agents/<name>.md` (M14-extension pack; claude-capability runners only per D3). `trigger_source='flow'` is recorded ONLY when the binding spawns a standalone child run — in Stage 3 the binding runs INSIDE the flow run's session, so no separate run row is created and `trigger_source='flow'` is reserved/documented (no emitter writes it yet; mirror of how `task.triage_requeued` landed in M32).

**Crash windows (claim → spawn), enumerated**: (a) cron claim committed, process dies before `tryStartRun` → row already advanced `next_fire_at`; the run row was not created → the fire is LOST (accepted: one-shot semantics, no backfill — documented). Mitigation: claim+run-insert happen in ONE transaction (run row `Pending`), so the only loss window is post-commit pre-spawn → covered by (b). (b) run row `Pending` committed, dispatch crash before `tryStartRun` → recovery: the `agent_tick.dispatcher` tick ALSO calls `promoteNextPending(kind='agent')` as a sanctioned 60s recovery sweep (ADR-1-compliant: clock + recovery, not state polling). (c) event-consumer claim (run insert) committed, crash before spawn → same recovery as (b); redelivered event hits the unique index → no dup. Worktree-workspace agent runs use the existing pre-tx worktree + compensation pattern (`web/lib/services/runs.ts:816-835`).

### D8. Triage + relations ops (ext API + MCP facade)

- New scopes in `web/types/token-scopes.ts`: `tasks:triage`, `relations:read`, `relations:create`, `relations:delete`, `agents:trigger`.
- `POST /api/v1/ext/projects/{slug}/tasks/{taskId}/triage` (scope `tasks:triage`): body `{flowId?, runnerId?, targetBranch?, promotionMode?}` — at least one required; the op ALWAYS stamps `triage_status='triaged'` (the verdict mark per owner answer #3); validates flowId ∈ project flows, runnerId ∈ enabled runners, promotionMode ∈ enum, targetBranch = git ref-name shape; single transactional UPDATE of the task verdict columns + `recordTaskActivity` (`triage_set` event kind, payload = the verdict) — one aggregating endpoint (owner preference), no side effects outside the DB → no two-phase concern. Identifiers: slug/taskId = url-param validated against token project (server-state); flowId/runnerId/promotionMode = body-controlled validated against allow-lists; targetBranch = body-controlled free string, ref-name-validated (it pre-fills the launch dialog; the launch path re-validates against the repo as today).
- **Untriaged creation path (owner: "simple intent" creation)**: `flowId` becomes OPTIONAL on ext/MCP `task_create` AND on the web form (`web/components/board/new-task-modal.tsx`) — title + prompt suffice; flow/runner/branch/policy get filled by the triager or by a human on the card. Flowless tasks classify as a new `unconfigured` launchability value — allow-list fan-out per the skill-context rule: board chip, `launchRun` refusal `PRECONDITION`, run_schedules dispatcher skip reason `skipped_unconfigured`, ext `run_launch` 409; the card's launch popover (D11) collects the missing fields.
- **Authz-first invariant (patch 2026-06-11-14.45)**: every new route in this milestone (`/api/agents/[id]/launch`, `/api/agents/[id]/event`, `/api/admin/agents*`, ext triage/relations) runs `authorize`/scope-check immediately after the minimal lookups that resolve the project id — before any other precondition, classification, or enriched error.
- Relations ops: `GET/POST/DELETE /api/v1/ext/projects/{slug}/tasks/{taskId}/relations` wrapping `addTaskRelation`/`removeTaskRelation`/`getTaskRelations` (`web/lib/social/relations.ts`) with the token-derived actor.
- MCP facade (`mcp/src/tools.ts`): new tools `triage_set`, `relation_add`, `relation_remove`, `relation_list` → `resolveRouting` cases mapping to the routes above.

### D9. Agent tokens — per-launch ephemeral (owner-confirmed 2026-06-12)

Args say "auto-issued on attach, rotated on detach"; but `project_tokens` stores sha256 hashes only (`web/lib/db/schema.ts:2252`) — a durable attach-time token cannot be re-read for injection at each spawn without storing plaintext. **Decision: per-LAUNCH ephemeral token** — issued at agent-run spawn (`token_kind='agent'`, `agent_id`, fixed scope set `[tasks:read, tasks:triage, comments:read, comments:create, relations:read, relations:create, relations:delete]`, `expires_at` = keep-alive horizon + grace), revoked at terminal transition + by GC sweep. Detach (`agent_project_links` delete/disable) revokes all live tokens for that (agent, project) — the "rotation on detach" guarantee holds (stronger: every run gets a fresh token). `verify.ts` maps `token_kind='agent'` → `SocialActor {type:'agent', id: agent_id}` (the M31 schema-ready actor finally gets a writer); `token_audit_log.actor_label = 'agent:<id>'` — agent identity in the audit log per args. Token delivery: injected server-side into the session's `mcpServers` entry (facade over stdio with `MAISTER_EXT_BASE_URL`/`MAISTER_EXT_TOKEN` env) — never streamed, never logged, never in `session/update` (server-only-secrets rule).

### D10. Prompt assembly (standalone runs)

`agent.md` body = system prompt. Appended context block by trigger: task-bound → `KEY-N`, title, prompt, task URL; domain_event → event kind + payload JSON, and for `task.comment_added` ALSO the triggering comment body + a bounded recent-thread tail (last N comments via the comments service — the triager must see the human's answer, D13); webhook → payload JSON; cron → schedule id + fire time. No Mustache templating in Stage 3 (literal body; templating = later). No secrets in context.

### D11. UI (admin conventions: view tables + edit popups, full-width, role-gated)

- `/settings` **Agents panel** (mirror `web/components/settings/acp-runners-panel.tsx` + modal): table (id, scope, runner, workspace, mode, triggers, risk_tier, quarantine badge, enabled) + create/edit popup writing the `.md` into the host catalog (BOTH scopes; scope + project picker) + re-sync + delete (usage-guarded: refuse while live runs exist) + manual Launch button + un-quarantine action.
- Project settings: **attach panel** — link platform agents (enabled toggle, runner override, cron schedule editor (cron_expr+timezone), event subscription editor (kinds multi-select from the 8-kind taxonomy)); project-scope agents creatable/editable here too (same host-catalog CRUD, project pre-bound).
- Board card pre-launch editing (owner ask): **extend the EXISTING `web/components/board/launch-popover.tsx`** (it already carries an advanced section with base/target branch pickers fed by `/api/scratch-runs/launch-options`) with flow, runner, and promotion-mode selectors — available on EVERY Backlog card, pre-filled from the triage verdict columns; edits persist to the task via one aggregating PATCH (admin-conventions rule), then launch proceeds unchanged. `unconfigured` tasks use the same popover with the missing fields required — no separate "Set up & launch" dialog component.
- Portfolio: agent runs in the active-workspaces grid with `kind=agent` badge + trigger_source chip (`web/lib/queries/portfolio.ts`).
- Task detail/card: "Run agent" action (manual task-bound launch); quarantine system comments render via existing timeline.
- i18n: EN + RU for every new string (REQUIRED).

### D12. Stage-0 doc flip

`docs/pv/agents-as-environment-actors.md` header → superseded-by-design pointer to ADR-088/088 + `docs/system-analytics/agents.md`, listing the three amendments: per-agent runner (frontmatter `runner` + link override, vs "no FK" in Stage-0), standalone-first (Mβ shipped before flow-binding polish), social layer (quarantine comments/activity, agent actor, triage verdict). Keep Mγ (continuous + enforce) as the remaining future stage.

### D13. Triage Q&A loop (owner ask, 2026-06-12)

The classifying agent must be able to ASK questions and converge over several turns:

1. Task created with simple intent (title + prompt, no flow) → `task.created` triggers the triager (event subscription).
2. Triager either submits the verdict (D8 triage op) — or, when unsure, **posts a question as a normal task comment** via its agent token (`comment_create`, already in the fixed scope set). M31 fanout notifies the creator (auto-subscribed) through the inbox — no new notification machinery.
3. Human replies in the thread → `task.comment_added` re-triggers the triager (its event subscription includes `task.comment_added` + `task.triage_requeued`); the run context carries the comment + thread tail (D10).
4. Loop terminates structurally: the **self-exclusion guard** (D7) means the triager's own comments never re-trigger it; only human/other-actor events do.
5. **`task.triage_requeued` finally gets its emitter** (registered emitter-less in M32 exactly for this): a "Send to triage" action on the card/detail sets `triage_status = NULL` + emits the event + writes a `triage_requeued` activity entry in ONE transaction.

Integration test (Phase 5): agent-actor comment → no self-trigger; human comment on the same task → exactly one new agent run.

---

## Contract surfaces → spec files (tracing rule)

| Surface | Spec file(s) |
| --- | --- |
| `POST /api/agents/[id]/launch`, `POST /api/agents/[id]/event`, `GET/POST/PATCH/DELETE /api/admin/agents[...]` | `docs/api/web.openapi.yaml` |
| `runs` schema additions (`kind`, `agent_id`, `trigger_source`) in run DTOs | `docs/api/web.openapi.yaml` |
| Ext triage + relations routes | `docs/api/external/operations.openapi.yaml` |
| New scopes (`tasks:triage`, `relations:*`, `agents:trigger`) + `token_kind=agent` | `docs/api/external/operations.openapi.yaml` + `docs/system-analytics/external-operations.md` |
| MCP tools `triage_set`, `relation_*` | `docs/system-analytics/external-operations.md` (facade table) |
| Supervisor `StartSessionRequest.readOnlySession` | `docs/api/supervisor.openapi.yaml` + `docs/supervisor.md` |
| Scheduler job-kind admin enum change (agent_tick seeded-only) | `docs/api/web.openapi.yaml` (job-kind enums) + `docs/system-analytics/scheduler.md` |
| New tables/columns | Drizzle migration `0048` + `docs/database-schema.md` + `docs/db/agents-domain.md` (new ERD) + `docs/db/erd.md` + `docs/db/runs-domain.md` (runs columns) |
| Flow DSL `agent:` field + engine `1.5.0` | `docs/flow-dsl.md` + `web/lib/config.schema.ts` + `docs/system-analytics/flow-graph.md` (floor table) |
| New env vars | `docs/configuration.md` env table + `.env.example` |
| `tasks.flow_id` nullable + optional `flowId` on ext/MCP `task_create` + `unconfigured` launchability + triage verdict columns | `docs/api/external/operations.openapi.yaml` + `docs/system-analytics/tasks.md` + `docs/system-analytics/run-schedules.md` (`skipped_unconfigured`) |
| Error-code usages (CONFIG at registration, EXECUTOR_UNAVAILABLE pre-spawn, PRECONDITION quarantine/destructive/dirty-baseline) | `docs/error-taxonomy.md` |
| New domain docs | `docs/system-analytics/agents.md` (new), `scheduler.md`, `external-operations.md`, `domain-events.md` (consumer table), `social-board.md` (agent actor goes live) |

## Deployment wiring

| Added | Lands in |
| --- | --- |
| `MAISTER_MAX_CONCURRENT_AGENTS` (default 3) | `.env.example` + web service `environment:` in `compose.yml` (+ prod overlay) + `docs/configuration.md` |
| `MAISTER_MAX_CONCURRENT_RUNS` default 3 → 6 | `web/lib/scheduler.ts` `capFromEnv` (:49) + `.env.example` + compose + `docs/configuration.md` + root `CLAUDE.md` §4 + `.ai-factory/DESCRIPTION.md` + tests asserting default 3 |
| `~/.maister/agents/` catalog dir | covered by the existing `~/.maister` volume/bind used for flows/capabilities — VERIFY in compose; if flows mount is narrower than `~/.maister`, widen or add a sibling mount |
| MCP facade binary available to spawned sessions (D9 stdio entry) | verify `mcp/` build output path is reachable from the supervisor host; document in `docs/deployment.md` if a new path/env (`MAISTER_MCP_FACADE_BIN`) is needed |

No new ports, no new sidecars.

---

## Phases & tasks

Gate for EVERY phase: `pnpm --filter maister-web exec tsc --noEmit` + `pnpm --filter maister-web test:unit` + `pnpm --filter maister-web test:integration` green (plus `pnpm --filter @maister/supervisor test` when supervisor touched); scoped `eslint <changed dirs>` (NEVER bare `pnpm lint` — it reformats the repo); `pnpm validate:docs` when docs touched. New unit tests land under the existing vitest globs (`web/lib/**/*.test.ts`, `web/lib/**/*.integration.test.ts`, `supervisor/src/**/__tests__`) — confirm glob match per test file (runnability rule).

### Phase 0 — Docs-first analytics spec (complete + internally consistent BEFORE code)

| # | Task | Deliverable |
| --- | --- | --- |
| 0.1 | **ADR-088** — Agent catalog with per-agent runner: `.md` canon + DB index split, frontmatter contract, scope/dirs, registration CONFIG refusals (incl. no-execution statement), standalone runner chain + incompatibility refusals, trigger model (5 sources, dispatcher/consumer/claim design, crash windows D7), task-bound agent runs don't touch task status/attempts, per-launch ephemeral agent tokens + actor mapping, triage verdict op | `docs/decisions.md` |
| 0.2 | **ADR-089** — Workspace axis + no-writes-outside-worktree invariant: D5 table, repo_read clean-baseline precondition, 3-layer enforcement (L1 readOnlySession / L2 manifest-tracked materialization / L3 dirty-watchdog), quarantine transaction semantics, ADR-041 destructive gate unchanged | `docs/decisions.md` |
| 0.3 | **`docs/system-analytics/agents.md`** (new, full R5 structure): purpose, entities, agent-run state machine (reuses run FSM; no-worktree variants), process flows (registration, each of 5 triggers, quarantine, **triage Q&A loop D13**), Expectations (≤12 normative bullets: budget isolation, no-dup spawn, **self-exclusion anti-loop**, quarantine atomicity, no-run-row-writes-after-terminal, token scoping…), edge cases → error codes, linked artifacts. Status tags `(Designed)` | new file + `docs/CLAUDE.md` glossary row |
| 0.4 | ERDs + narrative: `docs/db/agents-domain.md` (new erDiagram: agents, agent_project_links, agent_schedules, token linkage), `docs/db/erd.md` consolidated, `docs/db/runs-domain.md` (runs additions), `docs/database-schema.md` narrative | db docs |
| 0.5 | API specs: `web.openapi.yaml` (admin agents CRUD, launch, webhook event route, run DTO fields, job-kind enum change), `external/operations.openapi.yaml` (triage, relations, scopes, token_kind agent), `supervisor.openapi.yaml` (readOnlySession) — `npx @redocly/cli lint` zero errors | api specs |
| 0.6 | Update `scheduler.md` (agent_tick dispatcher + admin enum change), `external-operations.md` (ops/scopes/MCP tools/agent actor), `domain-events.md` (agent_triggers consumer row + `task.triage_requeued` emitter lands), `flow-dsl.md` + `flow-graph.md` (agent: binding, engine 1.5.0), `tasks.md` (simple-intent creation, verdict columns, card pre-launch editing), `configuration.md` (env), `error-taxonomy.md` (new refusal rows) | docs |
| 0.7 | Exit checklist: every state transition + refusal row enumerated exactly as code will gate (allow-lists written as allow-lists); both ERD artifacts updated; `pnpm validate:docs` + redocly green | gate |

**Commit 1**: `docs(agents): ADR-088/088 + Stage-3 analytics spec (agents.md, ERDs, API contracts)`

### Phase 1 — Schema + migration

| # | Task | Deliverable |
| --- | --- | --- |
| 1.1 | Drizzle schema: all D2 tables/alters in `web/lib/db/schema.ts` + types; `runner_resolution_tier` agent values; scopes type additions (`web/types/token-scopes.ts`) | schema |
| 1.2 | Migration `0048_platform_agents.sql` via drizzle generate (mind the `--custom` snapshot gotcha — generated, not hand-written; snapshot must advance) | migration + meta |
| 1.3 | fakeDb stubs for new tables; stepwise-replay migration test extended (M31 tag-addressing precedent) | unit green |
| 1.4 | Unit: enum CHECKs (scope↔project_id pairing, schedule-row CHECKs), partial unique index behavior (insert conflict no-op) — integration (testcontainers) | tests |

**Commit 2**: `feat(agents): schema + migration 0048 (agents, links, schedules rework, runs/tasks/tokens alters)`

### Phase 2 — Definition parser + registry

| # | Task | Deliverable |
| --- | --- | --- |
| 2.1 | Frontmatter parser+validator (`web/lib/agents/definition.ts`): zod schema per D1, body extraction; reuse `artifact-frontmatter.ts` split helper. Unit: every invalid-field class → CONFIG with field-naming message | parser + unit tests |
| 2.2 | Registry service (`web/lib/agents/registry.ts`): scan/register/re-sync the host catalog dir (`~/.maister/agents/`); collision refusal; CRUD for BOTH scopes (create/update writes `.md` then parses+upserts row — write-then-parse, single source); project-binding validation (`project:` slug must be registered); auto-link project agents; SET/CLEAR/re-set column symmetry | service + unit |
| 2.3 | Registration entry points: `/settings` admin routes `GET/POST/PATCH/DELETE /api/admin/agents` (+ re-sync action over the host catalog). NO project-registration hook (owner answer #5 — nothing agent-related lives in project repos). Identifiers: agent id = url-param, path segments validated SAFE_PATH_SEGMENT; no body-controlled paths | routes |
| 2.4 | Integration (testcontainers): registration refusals (bad frontmatter, runner unknown, scope/project mismatch, id collision) → CONFIG; symmetry round-trip | tests |

**Commit 3**: `feat(agents): .md definition parser + registry sync + admin CRUD routes`

### Phase 3 — Standalone launch path + budget

| # | Task | Deliverable |
| --- | --- | --- |
| 3.1 | `resolveAgentRunner()` per D3 + incompatibility refusals; unit: full chain precedence + both refusal classes | resolve.ts + unit |
| 3.2 | `launchAgentRun()` (`web/lib/agents/launch.ts`): preconditions (agent enabled, not quarantined, link enabled for project, risk_tier≠destructive, trigger allowed by frontmatter `triggers`, repo_read clean baseline), workspace-axis workdir prep (D5), M14 materialization + L2 manifest, ephemeral token issue (D9), supervisor `POST /sessions` with `readOnlySession` for none/repo_read, `trigger_*` persistence. Two-phase: DB run row (intent) before spawn; spawn failure → status `Failed` + token revoke + workdir cleanup (compensation table in code review) | launch service |
| 3.3 | Budget split per D4 in `web/lib/scheduler.ts` (kind-aware count/queue/promote) + `MAISTER_MAX_CONCURRENT_AGENTS`; unit: budgets isolated (flow cap full ≠ agent blocked, vice versa); integration: budget by kind (args matrix) | scheduler |
| 3.4 | Sweeps fan-out per D4: reconcile no-worktree classification, terminal-transition token revoke + dirty-watchdog hook point, GC of agent workdirs + expired agent tokens; regression: keepalive Pass1/2 on an agent run | sweeps + tests |
| 3.5 | `.env.example` + compose env wiring for `MAISTER_MAX_CONCURRENT_AGENTS` (default 3) | deployment |
| 3.6 | Flow-cap default bump 3 → 6 (`capFromEnv`, `web/lib/scheduler.ts:49`): `.env.example`, compose, `docs/configuration.md`, root `CLAUDE.md` §4, `.ai-factory/DESCRIPTION.md`; migrate every test asserting the default-3 cap (enumerate by grep at implementation) | default bump |

**Commit 4**: `feat(agents): standalone launch path, agent runner chain, split concurrency budget`

### Phase 4 — Enforcement layers L1/L3 + quarantine

| # | Task | Deliverable |
| --- | --- | --- |
| 4.1 | Supervisor `readOnlySession`: types schema, http-api session create, acp-client session-scoped auto-deny (write-class deny + read-class allow, allow-list of kinds), no pending-permission rows. **Extend `supervisor/test/fixtures/fake-acp.mjs` to emit `session.permission_request`** (it can't today) so the auto-deny round-trip is actually exercised (patch 2026-06-11-23.39 lesson: adapter fixtures cover the full lifecycle). Supervisor unit/integration tests | supervisor |
| 4.2 | L3 dirty-watchdog (`web/lib/agents/dirty-watchdog.ts`): porcelain snapshot pre-spawn, terminal-transition re-check **inside the terminal choke point — watchdog + token revoke sequenced before/within the status-flip tx, zero run-row writes after the flip (D6)**, manifest-path exclusion, L2 file restore/cleanup | watchdog |
| 4.3 | Quarantine transaction (single tx): `agents.quarantined_at` + reason, system comment (task-bound), `task_activity` `agent_quarantined`, launch-guard refusal; un-quarantine admin action; integration test: dirty repo after run → quarantined + comment + activity, second launch refused | quarantine |
| 4.4 | Regression: L2 materialized files restored on clean run (no false-positive quarantine) | tests |

**Commit 5**: `feat(agents): readOnlySession auto-deny + dirty-watchdog + quarantine transaction`

### Phase 5 — Triggers

| # | Task | Deliverable |
| --- | --- | --- |
| 5.1 | Manual: `POST /api/agents/[id]/launch` route (session RBAC) + openapi sync | route |
| 5.2 | Cron: `agent_tick.dispatcher` seeded job + launcher wired into the stub handler; schedule service (CRUD + croner validation + next_fire_at); claim-atomicity unit (concurrent ticks, one fire); `job-admin-schema` removal + ALL kind-registration points re-checked (enum/budget/2×CTE) + openapi job-kind enums | cron trigger |
| 5.3 | Domain-event: `agent_triggers` consumer (match per D7 incl. **self-exclusion guard**, claim-first Pending insert w/ ON CONFLICT, then tryStartRun; promoteNextPending(agent) recovery on tick); integration: duplicate redelivery of same event → exactly ONE run (the args' no-dup test); **D13 loop test: agent-actor comment → no self-trigger, human comment → exactly one run** | consumer |
| 5.4 | Webhook: `POST /api/agents/[id]/event` (scope `agents:trigger`, payload bound 32KB, project-from-token validation per D7); openapi | route |
| 5.5 | Flow binding: `agent:` field in config.schema (engine floor 1.5.0, engine version bump + floor table), compile-time catalog validation → CONFIG, `runAgentStep` profile substitution (mode=session) + `.claude/agents/` materialization (mode=subagent) + codex incompatibility → EXECUTOR_UNAVAILABLE; unit: schema floor + substitution; integration: flow with `agent:` ref launches | flow DSL |

**Commit 6**: `feat(agents): five trigger sources (manual/cron/domain_event/webhook/flow-binding)`

### Phase 6 — Ext API + MCP facade + tokens

| # | Task | Deliverable |
| --- | --- | --- |
| 6.1 | Scopes additions + ephemeral agent-token issue/revoke service (issue at spawn, revoke at terminal/detach/GC); `verify.ts` agent-actor mapping; audit `actor_label='agent:<id>'` | tokens |
| 6.2 | Triage route (single transactional op per D8: flow/runner/targetBranch/promotionMode + auto-stamp `triage_status='triaged'`) + relations routes; allow-list validation of body ids; activity events (`triage_set`); ext/MCP `task_create` `flowId` → optional; `unconfigured` launchability value + full allow-list fan-out (board chip, `launchRun` PRECONDITION, schedules dispatcher `skipped_unconfigured`, ext `run_launch` 409) | ext routes |
| 6.3 | MCP facade tools `triage_set`/`relation_add`/`relation_remove`/`relation_list` + routing; facade mcpServers injection wiring into agent sessions (D9) | mcp |
| 6.4 | Integration: agent token scope ceiling (denied outside its set), audit rows carry agent identity, detach revokes live tokens; operations.openapi.yaml verified against routes | tests + spec |
| 6.5 | `task.triage_requeued` emitter (D13): "Send to triage" server action — `triage_status = NULL` + `emitDomainEvent` + `triage_requeued` activity entry in ONE transaction (M32 same-tx emission rule); card/detail wiring lands with Phase 7 | emitter |

**Commit 7**: `feat(agents): triage/relations ops, MCP tools, ephemeral agent tokens + audit identity`

### Phase 7 — UI

| # | Task | Deliverable |
| --- | --- | --- |
| 7.1 | `/settings` Agents panel + create/edit modal (D11, mirror acp-runners-panel) + quarantine badge/action + manual launch | settings UI |
| 7.2 | Project attach panel: links CRUD, runner override, cron schedule editor, event-kind subscriptions | project UI |
| 7.3 | Portfolio agent-run rows (kind badge, trigger chip, agent name); task card/detail "Run agent" + "Send to triage" actions + triage_status chip; **extend `launch-popover.tsx`** with flow/runner/promotion-mode selectors persisted to the task via one aggregating PATCH (every Backlog card; `unconfigured` makes missing fields required); `new-task-modal.tsx` flow → optional (simple-intent creation) | surfaces |
| 7.4 | i18n EN+RU for all new strings; renderToStaticMarkup component tests per repo convention | i18n + tests |

**Commit 8**: `feat(agents): catalog/attach UI, portfolio visibility, task-card launch (EN+RU)`

### Phase 8 — E2E + docs close-out

| # | Task | Deliverable |
| --- | --- | --- |
| 8.1 | E2E ×3 (playwright, seeded stub-supervisor + `fake-acp.mjs`): (a) manual catalog launch → stream visible; (b) flow-bound `agent:<id>` node runs with substituted profile; (c) repo_read agent + test-injected dirty file → quarantine + system comment + relaunch refused. New spec prefixes ADDED to `AUTHED_SPEC` (`web/playwright.config.ts:25`); kill :3100/:7788 before runs; never `--last-failed` (shared-infra trap) | e2e green |
| 8.2 | Docs status flips `(Designed)`→`(Implemented)`; Stage-0 doc flip per D12; roadmap M33 entry + completed table; root `CLAUDE.md` "Built since baseline" + §Current Scope additions; `web/CLAUDE.md` if structure shifted | docs |
| 8.3 | Full gate: web unit+integration, supervisor unit+integration, e2e suite ×2 (flake check), tsc, scoped eslint, `pnpm validate:docs:all`, redocly on all 3 specs; re-verify ADR/migration numbering against live main before merge | gates |

**Commit 9**: `docs(agents): flip to Implemented, roadmap M33, Stage-0 supersession, close-out gates`

---

## Test integrity (runnability + migration of existing assertions)

- Existing tests expected to need touch-ups (enumerate at implementation, verify by grep): scheduler unit tests asserting single-cap counting (`web/lib/scheduler*.test.ts`), `job-admin-schema` tests (agent_tick removal), `ensureDefaultSchedulerJobs` seed-count assertions, openapi job-kind enum sync tests if present, fakeDb-based suites touching `runs` inserts (new columns default-safe), token verify/scope tests (new kinds/scopes), portfolio/board query tests (new kind filter).
- Every new test file: name its runner (web unit / web integration / supervisor / e2e) and confirm glob inclusion before counting it delivered.
- Per-phase suite-green is an exit criterion; pre-existing reds (if any surface) get explicit quarantine notes, never silence.

## Out of scope (Stage 3)

Continuous daemons + crash-loop backoff (Mγ), ADR-041 enforcement flip + destructive agents, secret-refs vault, non-claude subagent materializers, agent benchmarking/memory (roadmap E4+), Mustache templating of agent prompts, webhooks-outbox re-point (separate takeover plan).

## Decision log (owner answers, 2026-06-12)

1. Webhook auth = project token + `agents:trigger` scope — confirmed; no per-agent secret mechanism.
2. Agent tokens per-launch ephemeral — confirmed (fork explained: durable attach-time tokens can't be re-injected at spawn since only sha256 hashes are stored).
3. Triage = stamping the verdict fields (flow / runner / target branch / promotion policy); `triage_status` reduced to nullable `'triaged'`; NO `needs_human` — missing fields prompt the human in the launch dialog; a project without a triager contradicts nothing (tasks stay NULL).
4. Taskless quarantine: agent flag + catalog/portfolio badges only; no new notification plumbing in Stage 3.
5. Project-scope agents: host catalog only (`~/.maister/agents/`), nothing inside project repos; UI CRUD for both scopes.
6. Budgets: `MAISTER_MAX_CONCURRENT_AGENTS` default 3; `MAISTER_MAX_CONCURRENT_RUNS` default raised 3 → 6 (both stay env-tunable).
7. CONFIRMED (improve pass): `tasks.flow_id` nullable + verdict columns (`target_branch`/`promotion_mode`) + card-level pre-launch editing. Plus three additions: simple-intent task creation (flow optional on web form too), triager Q&A via task comments with the self-exclusion anti-loop guard (D13), and card editing implemented by extending the existing `launch-popover.tsx` rather than a new dialog.

## E2E close-out notes (Phase 8, 2026-06-12)

- **Main e2e debt repaired in-branch (blocking):** the M29-era
  `seedFlowStudioArtifactsFixture` + `seedInstalledPackageFixture` project
  inserts predate M31's `projects.task_key NOT NULL` — on main HEAD
  `f34769fd` the seed crashes and the WHOLE suite cannot boot. Fixed here
  (2 inserts get the standard task_key expression); without it no e2e can
  run at all.
- **`platform-acp-runners.spec.ts` — pre-existing main debt (quarantined,
  NOT fixed here):** baseline-proven red at `f34769fd` (with only the seed
  fix applied). The unmerged `feature/acp-runner-model-discovery` branch
  carries its own fixes for this surface (see project memory); keep-both at
  merge.
- **E2E (b) adaptation:** the seeded suite holds 13 live flow runs vs the
  global cap 6, so NO flow launch can ever spawn in e2e. The binding spec
  asserts the full click-launch pipeline (gates passed → 201/202 → run row
  carries the bound flow → queues `Pending` on the saturated flow pool —
  real product behavior); the session prompt-substitution contract
  (agent body + `## Task` + node prompt) is asserted deterministically in
  `web/lib/flows/__tests__/runner-agent.test.ts` ("catalog-agent binding
  substitution"), composing with `flow-binding-floor.test.ts` for the
  resolver gates.
- `task-launch-gating.spec.ts` updated for simple-intent creation (the
  modal defaults to "no flow"; the spec now picks the flow explicitly).
- Stub supervisor gained the minimal `/sessions` surface with a release-file
  hold (deterministic injection window for the quarantine spec) and
  `keepAliveTimeout = 0` (socket-reuse race vs 1s-budget supervisor calls
  under the new request volume).

---

# REWORK — agents as flow-package contents (same branch, pre-merge)

- **Decided**: 2026-06-12, owner. The host-only catalog (`~/.maister/agents/` +
  `MAISTER_AGENTS_ROOT` + raw-file admin CRUD) was a planning MISREAD of owner
  Q5 (which was about agent LOGS — those already live outside project repos).
  Wrong functionality must not ship → rework in this branch before merge.
- **Owner decisions**: (1) agents live INSIDE flow packages, no separate
  package type; package trust contour gates registration AND launch;
  (2) authoring/versioning like flows — Studio authors `agents/<id>.md`
  inside authored flow packages, publish bridges to `flow_revisions`,
  projects update consumed versions via the existing per-project package
  pin; (3) manifest/frontmatter ships per-agent RECOMMENDED bindings
  (schedule / event kinds / runner) — the attach panel pre-fills them;
  (4) workspace ref configurable — ephemeral READ-ONLY worktree at a
  trigger-derived ref, never switching the user's checkout.
- **Constraint (UPDATED 2026-06-12)**: `feature/package-management` has
  MERGED to main (`0282235f`, owns ADR-088 packages + migration
  `0048_packages`) — the rework now REBASES onto it first (R0) and
  integrates its trust/ownership machinery instead of avoiding it. Keep the
  M33 runtime substrate (launch/enforcement/triggers/tokens/budgets) intact.
- **Numbering after R0 rebase**: M33's artifacts renumber AGAIN — agent
  catalog ADR-088→**ADR-089**, workspace axis ADR-089→**ADR-090**;
  migrations `0048_platform_agents`→**0049**, `0049_agent_activity_kinds`→
  **0050**; journal interleaves main's 0047+0048 rows; snapshot prevId
  chain re-bases onto main's rebuilt `0048_packages` snapshot (M30 recipe;
  verify `drizzle-kit generate` → no-diff after). The rework migration is
  therefore **`0051_agents_package_source.sql`**.
- **Settings**: inherited — Testing yes, Logging standard, Docs yes,
  Roadmap M33 (entry will be amended, not duplicated).

## Rework progress

- [ ] R0 — rebase onto main `0282235f` + renumber (ADR-089/090, migrations 0049/0050, snapshot transplant)
- [ ] R1 — schema + package registration core (migration 0051)
- [ ] R2 — per-project resolution + trust/launch gates + attach gate
- [ ] R3 — workspace ref (ephemeral read-only worktree at trigger ref)
- [ ] R4 — recommended bindings + UI demotion + Studio frontmatter fields
- [ ] R5 — capability-profile MCP materialization for agent sessions
- [ ] R6 — tests/e2e rework + docs amendments + gates

## Rework design decisions

### RD1. Source of truth = the installed flow-package revision

Discovered substrate (this is why the rework is cheap): the package format
ALREADY carries agents — `agents/<id>.md` classifies as `agent_definition`
(`web/lib/flows/package-authoring.ts` `classifyPackageFilePath`), gets
frontmatter-validated at draft save (`web/lib/flows/artifact-validate.ts:100-109`,
`agentFrontmatterSchema` at `artifact-frontmatter.ts:154`), is editable in
Studio's `PackageFilesEditor` + `frontmatter-artifact-editor.tsx`, survives
`export-authored-flow` / `install-authored-flow-package`, and the authored
bridge (`lib/flows/authored-bridge.ts` → `installAuthoredFlowPackageBridge`
`lib/flows.ts:1024`) lands it in the system cache like any git package.
Registration therefore hangs off **installed `flow_revisions`**: scan
`<flow_revisions.installed_path>/agents/*.md` → upsert the `agents` index
with provenance. No new authored capability kind — the authored UNIT stays
the flow package (kind `flow`); agents are files inside it (owner decision 2
maps exactly to this).

### RD2. `agents` table rework (migration `0050_agents_package_source.sql`)

- DROP `scope`, `project_id` (+ the scope-pairing CHECK): availability to a
  project is now derived — the providing package is enabled in that project.
  `agent_project_links` (attach) stays the explicit opt-in, unchanged.
- ADD provenance: `flow_ref_id` (text, NOT NULL), `version_label` (text,
  newest registered), `origin` (`git|authored`, derived like
  `flowOrigin` from `revision.source` absolute-path check,
  `lib/services/runs.ts:723` precedent), `recommended` jsonb (RD5),
  `workspace_ref` (RD6). `source_path` stays = path into the NEWEST
  installed revision (catalog display / fallback).
- `agents.id` = **package-qualified**: `<flowRefId>:<file-stem>` (owner
  decision — e.g. `aif:triager`). Collisions are impossible by
  construction: two packages shipping `triager` register as distinct
  agents. UI disambiguates by showing the package where needed; the
  per-project effective version comes from the project's pinned package
  version; attachments within a project cannot cross either. Fan-out: the
  agent-id regex (`^[A-Za-z0-9._-]+$` in admin-shared/launch routes)
  extends to allow exactly one `:`; flow-node `settings.agent` bindings
  reference the qualified id (v1 — no bare-stem same-package sugar);
  webhook route `/api/agents/[agentId]/event` URL-encodes the id.
- Frontmatter: `scope`/`project` fields REMOVED from `definition.ts`
  (parse error if present — fail loud, the fields are dead);
  `recommended:` + `workspace_ref:` added. `parseAgentDefinition` becomes
  the validator invoked by `artifact-validate.ts` for `agent_definition`
  files (replacing the thin name+description `agentFrontmatterSchema`),
  so Studio drafts fail at save time with the real contract.

### RD3. Registration + resync from revisions

`registerAgentsForRevision(revisionId)` scans the installed dir and upserts
(SET/CLEAR semantics preserved). Hook points: after `installRevision`
finalize (`lib/flows.ts:739-751` packageStatus→Installed) — covers git
install, upgrade, and the authored bridge (same code path). `resyncAgents`
reworks to sweep all `Installed` flow_revisions (newest version per
flow_ref wins the index row); agents whose providing package vanished from
the cache → `enabled=false` + reported (replaces the missing-dir handling).
`createAgent`/`updateAgentDefinition`/`deleteAgent` raw-file registry
functions are REMOVED — definitions change only through packages (git push
+ upgrade, or Studio draft→publish). `~/.maister/agents/`, `paths.ts`
`systemAgentsRoot()`, and `MAISTER_AGENTS_ROOT` are removed entirely
(env: `.env.example` + `configuration.md` rows deleted; e2e webServer env
cleaned).

### RD4. Per-project effective version + trust/launch gates

The platform `agents` row is the CATALOG projection (newest installed) and
carries the platform kill-switches (enabled, quarantine). The EFFECTIVE
definition for a launch in project P resolves at spawn: `agents.flow_ref_id`
→ P's `flows` row → require `enablementState ∈ {Enabled, UpdateAvailable}`
AND `trustStatus ≠ 'untrusted'` (exact `launchRun` precedent,
`lib/services/runs.ts:320-331`) → `enabled_revision_id.installed_path/
agents/<id>.md` → parse → THAT parse drives guards (triggers, workspace,
risk_tier, mode) + the prompt body. Consequences:
- **Attach gate**: attaching an agent to P requires the providing package
  present+enabled in P (`PRECONDITION` otherwise); the attach panel's
  "available" list filters by it.
- **Pin divergence edge**: trigger dispatch matches on the INDEX row's
  triggers; if P's pinned version lacks the trigger, the launch refuses
  with `PRECONDITION` (dispatcher/consumer already log refusals — same
  contract as disabled/quarantined).
- "Update versions of used agents" = the EXISTING package upgrade flow
  (`upgradeFlow` → `UpdateAvailable` → `enableRevision`,
  `lib/flows/lifecycle.ts:344/207`).
- **Upgrade break-impact (owner ask)**: the upgrade preview `ContractDiff`
  (`lifecycle.ts:549`) gains an **agents** section — agents added/removed/
  changed between revisions, JOINED against this project's live
  `agent_project_links`/`agent_schedules`: a removed agent with a live
  attachment, or a dropped trigger kind with a live schedule binding, or a
  workspace/risk_tier change, renders as an explicit "will stop working /
  behavior changes" warning in the packages panel before enable.

### RD5. Recommended bindings ride the agent frontmatter

`recommended:` block in `agents/<id>.md` frontmatter (NOT the manifest —
self-contained, travels with the file, validated by `parseAgentDefinition`):
`{ runner?: string, cron?: { expr: string, timezone: string },
events?: DomainEventKind[] }`. Stored on the index row (`recommended`
jsonb). Attach panel: selecting an agent pre-fills the attach/edit modal
(runner override + one cron row + one event row) from it; nothing
auto-applies without Save.

### RD6. Workspace ref — ephemeral read-only worktree

Frontmatter `workspace_ref: trigger | <branch-name>` (optional; only valid
with `workspace: repo_read`). Absent → today's behavior (live parent
checkout). Present → launch creates an EPHEMERAL DETACHED worktree
(`git worktree add --detach`) at the resolved ref under
`worktreesRoot()/<slug>/<runId>-ro`, points the session there, and removes
it at the terminal choke point (+ GC sweep backstop). The user's checkout
is NEVER switched. Ref resolution for `trigger` (v1): domain-event `run.*`
events → the triggering run's workspace branch; **webhook** → conventional
payload field `branch` (fallback `ref`) — the owner's tests-readiness case
arrives as a CI webhook, so it MUST resolve; cron/manual/task.* events →
no trigger context → `PRECONDITION` refusal unless a literal branch is
configured. Explicitly NOT in v1 (deferred, owner-reviewed): task.*-event
ref derivation (ambiguous which run), configurable JSONPath payload
extraction (fixed `branch`/`ref` fields only), and auto-`git fetch` of
refs absent from the local repo (unresolvable ref → `PRECONDITION`).
Enforcement mapping: clean-baseline precondition SKIPPED for ephemeral
(fresh checkout is clean by construction); L3 dirty-watchdog targets the
EPHEMERAL dir; L1/L2 unchanged.

### RD7. Agent capability-profile MCPs from the platform catalog

M33 gap: agent sessions receive only the maister facade. Rework wires
`capability_profile.mcps` refs through the existing resolution
(`resolveCapabilityProfile` precedence project>platform>flow-package,
`lib/capabilities/resolver.ts:310`) + `gateStdioMcpsByExecTrust`
(`lib/capabilities/agent-map.ts:169`) into `createSession.mcpServers`
alongside the facade. Untrusted exec ⇒ stdio MCPs filtered (existing
contract).

## Rework phases & tasks

### R0 — Rebase + renumber (pre-requisite)

| # | Task | Deliverable |
| --- | --- | --- |
| R0.1 | Rebase the 9 M33 commits onto main `0282235f`; resolve schema.ts/decisions.md/seed/journal conflicts | rebase |
| R0.2 | Renumber: ADR-088→089, ADR-089→090 (tree-wide sweep incl. lowercase anchors); migrations 0048→0049_platform_agents, 0049→0050_agent_activity_kinds (files+snapshots+journal idx/tag, `when` untouched); snapshot prevId transplant onto main's 0048_packages snapshot; `drizzle-kit generate` no-diff check | renumber |
| R0.3 | Full gate re-run on the rebased branch (web unit+integration, supervisor, mcp, e2e, tsc, validators) before any rework code | gates |

**Commit R-0**: `chore(agents): rebase onto main (packages), renumber ADR-089/090 + migrations 0049/0050`

### R1 — Schema + registration core

| # | Task | Deliverable |
| --- | --- | --- |
| R1.1 | Schema rework per RD2 (incl. qualified-id refactor) + drizzle migration `0051_agents_package_source.sql` (paced-keypress generate; verify snapshot diff) | migration |
| R1.2 | `definition.ts`: drop scope/project, add `recommended` + `workspace_ref` zod; `artifact-validate.ts` delegates `agent_definition` validation to `parseAgentDefinition` | parser |
| R1.3 | `registerAgentsForRevision` + install/bridge hooks + resync-from-revisions + id-collision refusal; remove paths.ts/`MAISTER_AGENTS_ROOT`/raw-file CRUD fns | registry |
| R1.4 | Unit+integration: registration from a real installed dir, collision refusal, vanished-package disable, SET/CLEAR re-parse on upgrade | tests |

**Commit R-1**: `refactor(agents): definitions become flow-package contents — registration from installed revisions`

### R2 — Per-project resolution + gates

| # | Task | Deliverable |
| --- | --- | --- |
| R2.1 | Effective-definition resolver (RD4) used by `launchAgentRun`/`startAgentSession`/`buildAgentPrompt` + trust/enablement launch gate | launch |
| R2.2 | Attach gate + available-list filter (package enabled in project); admin agents routes: drop create/definition-PATCH/delete, keep GET/enabled/unquarantine | routes |
| R2.3 | Integration: trusted/untrusted launch matrix, attach refusal, pin-divergence trigger refusal, per-project version resolution (two projects, two pinned versions) | tests |
| R2.4 | Upgrade-preview `ContractDiff` agents section + break-impact joins vs live links/schedules + packages-panel rendering (RD4) | preview |

**Commit R-2**: `feat(agents): per-project effective version + package trust gates launch and attach`

### R3 — Workspace ref

| # | Task | Deliverable |
| --- | --- | --- |
| R3.1 | Ref resolution (`trigger` from run.* event payload → triggering run branch; literal branch) + ephemeral RO worktree lifecycle (create at spawn, remove at terminal, GC backstop) | launch |
| R3.2 | Enforcement mapping: skip clean-baseline for ephemeral, point L3 watchdog at the ephemeral dir; integration tests incl. dirty-ephemeral quarantine | enforcement |

**Commit R-3**: `feat(agents): workspace_ref — ephemeral read-only checkout at trigger-derived ref`

### R4 — Recommended bindings + UI demotion + Studio

| # | Task | Deliverable |
| --- | --- | --- |
| R4.1 | Attach panel pre-fill from `recommended` (modal opens pre-populated on attach) | attach UI |
| R4.2 | Settings catalog panel: provenance column (`pkg@version`, origin chip), REMOVE add/edit modal (`agent-modal.tsx` deleted), keep enable/disable/un-quarantine/launch; "edit" affordance links to the providing authored flow in Studio when origin=authored | settings UI |
| R4.3 | Studio `frontmatter-artifact-editor` surfaces the full agent contract fields (workspace, mode, triggers, risk_tier, runner, recommended, workspace_ref) | studio |
| R4.4 | i18n EN+RU; renderToStaticMarkup component tests updated | i18n+tests |

**Commit R-4**: `feat(agents): recommended-binding pre-fill, package provenance UI, Studio agent fields (EN+RU)`

### R5 — Capability-profile MCPs

| # | Task | Deliverable |
| --- | --- | --- |
| R5.1 | RD7 wiring in `startAgentSession` + exec-trust stdio gate + integration test (profile MCP reaches createSession.mcpServers; untrusted filters stdio) | launch |

**Commit R-5**: `feat(agents): capability-profile MCPs resolved from the platform catalog at spawn`

### R6 — Tests/e2e + docs + gates

| # | Task | Deliverable |
| --- | --- | --- |
| R6.1 | e2e seed: agents ship inside the seeded local flow packages (`agents/*.md` in the package source dirs + registration rows); drop `MAISTER_AGENTS_ROOT` from playwright env; adapt the 3 platform-agents specs + quarantine fixture | e2e |
| R6.2 | Docs amended IN PLACE (branch unmerged — no supersession ceremony): ADR-088 source-of-truth section, `agents.md` analytics, `agents-domain.md` ERD, `configuration.md`/`.env.example` env removal + additions, openapi (admin agents CRUD shrink, attach pre-fill), roadmap M33 entry text | docs |
| R6.3 | Full gates: web unit+integration, supervisor, mcp, e2e ×2, tsc ×3, scoped eslint, validate:docs:all, redocly ×3; re-verify numbering vs live main | gates |

**Commit R-6**: `docs(agents): package-source rework close-out — ADR-088 amendment, e2e, gates`

## Rework decision log (owner, 2026-06-12)

1. Agents inside flow packages; no separate package type; trust contour mandatory.
2. Authoring like flows (Studio → publish → projects update versions) — maps to authored flow packages carrying `agents/*.md`; no new authored kind.
3. Recommended bindings: pre-fill on attach — confirmed ("давай попробуем").
4. Workspace ref configurable; main-only wrong; tests-readiness agents check out the triggering change's branch.
5. NO collision/refusal policy — platform agent ids are package-qualified `<package>:<name>`; version always from the project-pinned package; UI shows the package to disambiguate.
6. Settings-panel agent creation removed entirely — Studio/git package is THE single creation+distribution path ("оно должно быть одно").
7. Upgrade preview must surface agent break-impact (what stops working: removed agents with live attachments, dropped triggers with live schedules) before enabling a new version.
8. `workspace_ref: trigger` v1 covers run.* events AND webhooks (payload `branch`/`ref`); deferred: task.* derivation, JSONPath payload config, auto-fetch.

## Unresolved questions

None on the original M33 scope. Rework questions pending owner (see below).
