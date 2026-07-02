# Implementation Plan: Tact 0 — Workspace-Boundary Default-Deny at the ACP Seam + First Dogfood Pull-Agents (build-sentinel, standup-digest)

Branch: `claude/upbeat-kalam-ba36f7` (worktree; **rebased onto `main` `a0c99fdd`** 2026-07-02 — no branch commits of its own)
Created: 2026-07-02 · Revised: 2026-07-02 (owner review round 1 — decisions locked, see bottom; improve pass same day — code-verified deltas, see "Improve-pass deltas")
Style: SDD (docs-first Phase 0) · TDD (RED→GREEN→REFACTOR) · surgical diffs

## Settings
- Testing: **yes** (every FR/AC → ≥1 owning test; tiers: unit `renderToStaticMarkup`/pure, `*.integration.test.ts` testcontainers real-PG, supervisor vitest, e2e stub-supervisor seed; **RED→GREEN→REFACTOR binding per task** — the failing owning test lands FIRST within the same task, implementation turns it green, refactor only on green)
- Logging: **standard** (INFO for key launch/route events; ERROR on fail-closed boundary-config/realpath failure; the boundary audit is a structured SSE event, NOT a log line — no paths/secrets in general logs)
- Docs: **yes** — mandatory docs-first Phase 0; `pnpm validate:docs` (mermaid + ADR-anchor) green is a hard gate

## Roadmap Linkage
Milestone: **M40 (guardrail/hook engine) follow-on + M20 (dogfood) enabler**
Rationale: item A adds the implicit workspace-boundary rule onto the shipped M40 ACP-seam interceptor; items B/C ship the first two dogfood pull-agents on the MAIster repo (closes the P0 run-summary/attention-digest gap and the CI-failure→task loop). New "Tact 0" axis; link is advisory, not a completion gate.

## Numbering & collision guards (verified at `main` HEAD `a0c99fdd`)
- **ADR-123** — new ADR. `grep '### ADR-' docs/decisions.md` max = **121** (122 reserved by the brain plan; 122/123 absent). Reserve the `### ADR-123:` header FIRST (stub) so `validate-docs-adr-anchors.mjs` resolves citations.
- **Zero new migrations.** Journal max = **0087** (0088 reserved by the brain plan). Reuses: token `scopes` jsonb (no column), `runs.trigger_event_id`/`trigger_payload`/`agent_config` (present), `agent_project_links`/`agent_schedules` (present). If unavoidable → **0089** + monotonic-`when` care; engineered to need none.
- `pnpm validate:docs` runs mermaid + **ADR-anchor** validators — a stale ADR anchor is a build break.
- Brain plan reservations (ADR-122 / migration 0088) untouched.

## Cross-branch coordination — RESOLVED
- The `nifty-hamilton` triager work **landed on `main` as `a0c99fdd fix(triage): full triage_set MCP surface + agent tasks:update scope`**. This branch is rebased on top of it. Consequences, baked in below:
  - **`triage_set` MCP full-surface fix is DONE on main** (`mcp/src/tools.ts:320-340` schema + `:718-742` forwarding, all 9 fields) → **task TC.5 is DROPPED** (FR-B6 satisfied upstream; no re-implementation, no conflict).
  - **`AGENT_TOKEN_SCOPES` base is now 10 members** (adds `tasks:update`): `tasks:read, tasks:update, tasks:triage, comments:read, comments:create, relations:read, relations:create, relations:delete, flows:read, runners:read`. → `AGENT_SCOPE_ALLOWLIST` = those 10 ∪ `{runs:read, tasks:create}` = **12**.
- **Core-package release is OWNER-OWNED** (owner extends `core`, commits the triager rewrite, cuts the first `core/v1.0.0` tag). This plan **hands off** the two finished agent `.md`s (TD.1/TD.2) for inclusion. My platform-side fixtures + tests + substrate integration (TD.3/TD.4) run against **byte-identical platform fixtures + the mock adapter**, so they are **not** blocked by the tag; only the real attach-on-project (TE.4) waits for it.

## As-built recon anchors (verified code — do NOT re-recon)

**Guardrail seam (item A)** — `HookRule = path_guard|repetition|no_progress` (`supervisor/src/types.ts:346`). **Only veto seam** = `requestPermission` (`acp-client.ts:437`); `sessionUpdate` (`acp-client.ts:374`) is observe-only. `path_guard` already denies write-class inline via `resolvePathGuardDecision({pathGuard, toolCall, worktreePath})` (`guardrail-hooks.ts:95`) using `extractWritePath` (`WRITE_KINDS = edit|write|create|delete|move`, `locations[0].path`, conservative kind-only-fallback deny). Reads are NOT arbitrated (write-only). **Multi-root prefix-containment logic already exists** in `prompt-confinement.ts` (worktreePath|repoPath|runDir|confineRoot; string-based `path.relative` — NO realpath/case normalization, those are NEW code in TA.1) — REUSE the containment core. `extractWritePath` reads only `locations[0]` — the boundary needs a NEW all-locations extractor (leave `path_guard` untouched). `runDir` derived `runtimeRoot + .maister/<slug>/runs/<runId>` (like `logPath`, `spawn.ts:134`). Spawn payload `StartSessionRequestSchema` `.strict()` (`types.ts:168`); env resolved web-side (`hooks-config.ts` `hookEnvDefaults`→`resolveHooksConfig`), shipped in payload, frozen per session. Audit = `run.events.jsonl` append (every `SessionEvent` via `registry.ts:84`). `session.hook_trip` event + `EventBase.type` enum exist (`web-runs.asyncapi.yaml:162`).

**Scopes/tokens (item B)** — `AGENT_TOKEN_SCOPES` = 10 (post-a0c99fdd, incl `tasks:update`); master `TOKEN_SCOPES` already has `runs:read`+`tasks:create`; no `memory:*` (brain not landed). Frontmatter `.strict()` zod `agentDefinitionFrontmatterSchema` (`definition.ts:205`), unknown key → `MaisterError("CONFIG")`; `recommended.cron = {expr, timezone}` **both required** (`definition.ts:112`); mirror `config[]`/`triggers` for the new `scopes` array. Effective def `resolveEffectiveAgentDefinition()` (`effective.ts:65`, `launch.ts:337`). Mint `issueAgentRunToken()` (`tokens.ts:49`, `scopes:[...AGENT_TOKEN_SCOPES]` at :68) — jsonb column, hash-only DB row, revoked at terminal. Enforce `handleExt` `tokenHasScope()` (`ext-handler.ts:444`); `PROJECT_ACTION_BY_SCOPE` already maps `runs:read→readBoard`, `tasks:create→createTask`. Upgrade-preview `agentFieldChanges()`/`AgentUpgradeImpact` (`lifecycle.ts:534,625`) — scalar list + `droppedTriggers` (mirror site for scopes). UI `agent-view.tsx` (Triggers chip pattern); `projectAgentSummary()` DTO (`admin-shared.ts:81`).

**Ext/MCP/runs/cost (item B)** — only `GET /api/v1/ext/projects/{slug}/runs` is net-new (`handleExt` template: projectId-from-token, 404 existence-hide, success/failure token audit). `task_create` route + MCP tool EXIST. **`triage_set` full-surface fix already on main** (see Coordination). `run_cost_rollups` (`schema.ts:1566`, PK `run_id`) = token totals (no `$`), nullable. `runs` has no `createdAt` (use `startedAt`); `runnerId` via `activeSessionRunnerId(runId)`; `taskKey` via `runs→tasks→projects`; `pendingHitlCount` via `hitl_requests responded_at IS NULL` + status filter; **`queuePosition`** computed only in `scheduler.ts tryStartRun` → factor a shared helper. MCP `dispatchTool→resolveRouting→callExt` verbatim bearer; `TOOL_SPECS` = hand-mirror of ext zod.

**Trigger/webhook substrate (item C)** — webhook `POST /api/agents/{agentId}/event`; auth = project bearer + scope `agents:trigger`; payload cap `MAX_PAYLOAD_BYTES=32*1024`; dedup = caller header `X-Maister-Trigger-Event-Id` → `runs.trigger_event_id` + partial unique index (convergence `INSERT … ON CONFLICT DO NOTHING`). `workspace_ref: trigger` → `resolveWorkspaceRefCommittish()` (`launch.ts:507`) webhook branch at **`:524-529`** reads `payload.branch` (fallback `ref`) — **the 5a-B change site** (add `payload.sha` preference). Ephemeral `git worktree add --detach`, clean-baseline skipped, removed post-terminal, `readOnlySession=true`. Agent cap `MAISTER_MAX_CONCURRENT_AGENTS`=3 (pool ≠ flow/scratch=6). Self-exclusion by actor agent id (`triggers.ts:216`). Cron singleton `agent_tick.dispatcher` (`FOR UPDATE SKIP LOCKED`+lease) + per-row atomic UPDATE claim (`triggers.ts:104`, one winner/one catch-up/no backfill). Config generic 2-level (`resolveAgentConfig`, snapshot `runs.agent_config`). Attach `POST .../agents`; configure `PATCH .../agents/[agentId]` (`schedules` full-replace, `configValues`). **Agent-schedule editor `agents-attach-edit-modal.tsx` defaults TZ to `"UTC"` (`:70,407,425`) — does NOT autodetect** (unlike the run-schedule editor `schedule-edit-modal.tsx:113` which uses `Intl…resolvedOptions().timeZone`) — the Q1 gap. **Platform-agent MCP mechanism EXISTS** (`capability_profile.mcps` → `resolveAgentProfileMcpServers` → platform catalog, exec-trust-gated); only the `github` catalog **row** is missing.

---

## Design decisions (pre-written ADR-123 content — Phase 0 authors it, code conforms)

### A. Workspace-boundary rule
- **Scope (5c-A, locked):** applies only to **workspace-bearing** sessions (flow, scratch, `agent workspace: worktree`). `none`/`repo_read` sessions keep the existing L1 (`readOnlySession`, all-writes-denied) untouched — the boundary would be redundant there and touching them risks regression. (The two dogfood agents are `none`/`repo_read` → NOT governed by this rule.)
- **Roots** = `realpath(worktreePath)` + `realpath(runDir)`, resolved **supervisor-side at spawn** (multi-host correctness — realpath must run where the filesystem is), memoized on `SessionRecord`, immutable. Only `workspaceBoundary.mode` travels in the payload; `worktreePath` is already there; `runDir` is derived. Missing/invalid config or realpath failure → **fail closed to `warn` + one ERROR log**, never crash spawn.
- **Modes** `off | warn | enforce`, resolved web-side from `MAISTER_WORKSPACE_BOUNDARY` (default **`warn`**), snapshotted per session; mid-run env changes never affect a live session.
- **Enforcement semantics (5b-C, locked — simplified, deviates from spec FR-A5/AC-A4 with owner approval):**
  - **Writes** → arbitration path. `enforce` → **deny inline** (run continues; agent gets a denial) + audit `action=denied`. `warn` → allow + audit `action=warned`. Adapters lacking `locations[].path` → conservative kind-only-fallback deny (enforce).
  - **Reads / non-write** → observation path (cannot be vetoed). **Both `warn` and `enforce` only AUDIT** (`action=warned`). **No per-session counter, no threshold, no observation-path halt, no `hook_trip` reuse.** Rationale: a delayed pause can't un-read anything; enforce's honest teeth is the inline write-deny. (Spec's threshold-tripwire is a modest add if unattended-enforce dogfooding later shows a need — explicitly out of v1.)
  - So `enforce` vs `warn` differ **only on writes**; the boundary never pauses a run.
- **Audit surface (Q3 "dedicated surface"):** new dedicated SSE event `session.workspace_boundary` — `{ tool, path, classification: read|write, mode, action: denied|warned, monotonicId }` — appended to `run.events.jsonl` (auto via registry) + streamed + added to `web-runs.asyncapi.yaml` + `supervisor-sse.asyncapi.yaml` + `EventBase.type` + mirrored into the hand-maintained web `SupervisorEvent` union (`web/lib/supervisor-client.ts:299-365`) + projected into the run-detail surface (TA.7 — web event projectors silently drop unknown types today). **No new DB table.** NOT piggybacked on `session.hook_trip` (a warn/read-audit is not a trip; hook_trip's payload can't carry classification/mode/path). No secrets/file-contents/env — path string only.
- **Composition:** additive to explicit `path_guard` (which narrows WITHIN the worktree); explicit rules only narrow, never widen. `off` bypasses evaluation entirely.
- **Unknown-shape calls (Q2 "recommended"):** no parseable path arg → pass through with `unclassified` audit tag; reuse `extractWritePath`/`toolCall.locations`.
- **Non-goals (ADR):** shell/Bash command-string parsing; network egress; container/OS isolation; MCP capability allow-lists (future ADR-041); L1–L3 changes. Deterrent + audit layer, not a hard security boundary.

### B. Agent surface extension
- **`AGENT_SCOPE_ALLOWLIST`** = `[...AGENT_TOKEN_SCOPES, "runs:read", "tasks:create"]` (12; base already includes `tasks:update` from a0c99fdd; no memory scopes). Allowlist = the security boundary; per-agent declaration = least-privilege within it.
- **`scopes: string[]`** frontmatter: `z.array(z.enum(AGENT_SCOPE_ALLOWLIST)).optional()` + uniqueness superRefine → out-of-allowlist fails the enum → `MaisterError("CONFIG")`, row not written (impossible at parse, never a silent mint-time filter). No-`scopes` agents keep today's exact 10-member set.
- **Effective scope at launch** = `AGENT_TOKEN_SCOPES ∪ declared`, from the project-pinned `.md` (ADR-111 discipline), snapshotted into the minted token (jsonb, revoked at terminal). No column, no migration.
- **Instance scopes out of scope v1**; ADR fixes the future rule: instance may only **narrow** (inverse of `execution_policy_override`).
- **Upgrade-preview:** package upgrade adding scopes = privilege escalation → `addedScopes`/`droppedScopes` in `AgentUpgradeImpact`.
- **Runs read API** `GET /api/v1/ext/projects/{slug}/runs` (`runs:read`), query `since`/`status?`/`kind?`/`limit`(≤100, default 50, newest-first). DTO `RunSummary { id, taskId, taskKey?, kind, status, flowId?, runnerId?, startedAt, endedAt?, durationMs?, pendingHitlCount, queuePosition?, costSummary? }` (`startedAt` = launch time; `endedAt` mirrors the actual column name — `runs.endedAt`, `schema.ts:1383`, NOT `finishedAt`; `costSummary` = `run_cost_rollups` token counts, null when unreconciled). `slug` = url-param validated vs token project (404 existence-hide); no body-controlled ids; summary only (no logs/artifacts/env/secrets).
- **MCP** `run_list` (new). `triage_set` full-surface + `task_create` **already on main** (verify only).

### C. Two agents (package content; platform code limited to the two small refinements TB.5/TB.6)
- **standup-digest** — `workspace: none`, `mode: session`, `risk_tier: read_only`, `triggers: [cron, manual]` (NO `domain_event` — loop-safety), `scopes: [runs:read, tasks:create]` (`tasks:create` is REQUIRED — the agent find-or-creates its singleton digest task), `recommended.cron = { expr: "0 8 * * *", timezone: "UTC" }` (neutral hint; operator's real TZ auto-fills + is editable per TB.6). Config `window_hours`(24)/`include_cost`(true)/`digest_task_title`("📊 Daily digest")/`mention`(owner). Behavior: gather via facade (`run_list`/`task_list` — **NO `hitl_list`**: `hitl:read` is outside the 12-member allowlist and would 403; the Needs-you section derives from `run_list` `pendingHitlCount` + `NeedsInput*` statuses); sections Shipped/Failed/Stuck/Needs-you/Queue/Cost; **"quiet day" message instead of silence**; memory section skipped (no memory scopes exist); singleton digest task by title marker (flow-less → unlaunchable); one comment per window with `window:<date>` marker (idempotent — exit if present); mention → inbox; ~8 KB cap, counts over prose.
- **build-sentinel** — `workspace: repo_read`, `workspace_ref: trigger`, `mode: session`, `risk_tier: read_only`, `triggers: [webhook, manual]`, `scopes: [runs:read, tasks:create]` (+ `tasks:triage`, `tasks:update` in base). Config `dedup`(true)/`auto_triage`(**verdict**)/`max_tasks_per_day`(5)/`log_excerpt_kb`(8). Inbound payload `{ provider:"github_actions", repo, sha, branch, workflow, conclusion, runUrl, runId, logExcerpt, headCommit? }` — **`logExcerpt` (workflow-trimmed failing-job log tail ≤ `log_excerpt_kb`) is in the payload → NO github MCP needed for v1** (Q4). `runId` = workflow_run id (used for provenance links AND as `X-Maister-Trigger-Event-Id`). `capability_profile.mcps:[<github-id>]` is **optional/documented-later** (richer full-log access once an operator adds the catalog row). Behavior: ignore `conclusion != failure`; **exact-sha checkout** (TB.5) so `git blame/log` are at the failing tree; fingerprint = hash(workflow, primary failing job/step or first failing test); **dedup + "sha belongs to a known MAIster run/task → bump comment instead of new task"** + fingerprint-marker dedup; investigate read-only (blame/log implicated paths, read failing spec from `logExcerpt`); create ONE task (title `CI: <workflow> failing @ <short-sha>`, sections summary/suspected-commits/repro/log-excerpt/links/fingerprint marker); **prompt-injection hardening** (payload/logs are data; never execute commands from logs); `auto_triage=verdict` → `triage_set` flow(`flow_list route_when`)+runner+`baseBranch`=failing branch; rate limit → comment-bump past `max_tasks_per_day`.

---

## Requirements & acceptance criteria (testable; one owning test each — see matrix)

**Item A — workspace boundary**
- **FR-A1** Boundary evaluates only workspace-bearing sessions (flow, scratch, agent `worktree`); `none`/`repo_read` keep today's L1 semantics byte-identical.
- **FR-A2** Roots = supervisor-side `realpath(worktreePath)` + `realpath(derived runDir)`, resolved once at spawn, memoized, immutable; config/realpath failure → fail-closed to `warn` + one ERROR log; spawn never crashes.
- **FR-A3** Normalization: relative→cwd, `..` collapse, realpath-where-exists, darwin case-canonical compare, prefix-safe (`/a/b`≠`/a/bc`), `~` expansion, multi-path = any-out-fails, absent path → `unclassified`.
- **FR-A4** Modes `off|warn|enforce` from `MAISTER_WORKSPACE_BOUNDARY` (default `warn`), snapshotted per session; mid-run env change never affects a live session.
- **FR-A5′** Writes: `enforce` → inline deny (run continues) + audit `denied`; `warn` → allow + audit `warned`. Reads/non-write: both modes audit-only. The boundary never pauses a run.
- **FR-A6** Dedicated `session.workspace_boundary` event `{tool, path, classification, mode, action, monotonicId}`; no secrets/contents/env; jsonl-appended + streamed.
- **FR-A7** Explicit `path_guard` only narrows within the worktree; `off` bypasses evaluation entirely.
- **FR-A8** Unknown-shape calls pass through with `unclassified` audit tag.
- **AC-A1** out-of-worktree write in `enforce` denied inline, same op inside worktree succeeds · **AC-A2** same op in `warn` proceeds + exactly one `warned` audit · **AC-A3** FR-A3 normalization matrix green · **AC-A5** `repo_read`/`none` suites unchanged, `off` byte-identical · **AC-A6** ADR-123 + docs + contracts land, `pnpm validate:docs` green · **AC-A7** zero new migrations (journal max stays 0087) · **AC-A8** a boundary audit renders in the run-detail surface (EN+RU), not silently dropped by projectors.

**Item B — scopes + runs API**
- **FR-B1** `scopes[]` frontmatter validated against `AGENT_SCOPE_ALLOWLIST` (12) at parse; out-of-allowlist → `MaisterError("CONFIG")`, row not written.
- **FR-B2** `GET /api/v1/ext/projects/{slug}/runs` under `runs:read`: filters `since/status?/kind?/limit≤100` (default 50, newest-first), 404 existence-hide, success+failure token audit, summary-only DTO. Query semantics pinned: `since` = ISO 8601 date-time, inclusive lower bound on `runs.started_at`; `status` = the `runs.status` enum values; `kind` = `flow|scratch|agent` (`runs.run_kind`). Unknown enum value / unparsable `since` → 422 `CONFIG`.
- **FR-B3** `costSummary` = `run_cost_rollups` token counts only (never `$`), `null` until reconciled — FIRST external cost exposure (no ext endpoint returns cost today), decision recorded in ADR-123.
- **FR-B4** MCP `run_list` mirrors the ext query surface verbatim; bearer passes through unchanged.
- **FR-B5** Agent-created tasks carry `actor_label=agent:<id>` in `token_audit_log`.
- **AC-B1** parse accepts `runs:read`, rejects `projects:admin` (CONFIG, row not written), render→reparse round-trip preserves `scopes` · **AC-B2** route integration: filter/order/`pendingHitlCount`/`costSummary`; wrong project → 404; missing scope → 403 + failure audit; unauthenticated/malformed → 401/403 BEFORE body parse · **AC-B3** MCP round-trip returns the route DTO · **AC-B4** minted scopes = `AGENT_TOKEN_SCOPES ∪ declared` (dedup); no-`scopes` agent mints exactly today's 10; token revoked at run terminal.

**Item C — dogfood agents**
- **AC-C1** cron → agent run under agent budget, correct token scopes, facade calls succeed, digest comment created, token revoked at terminal, dirty-watchdog green · **AC-C2** two same-window fires → one comment · **AC-C3** manual: next-morning digest exists, numbers spot-checked vs DB, mention in inbox · **AC-C4** webhook → `trigger_source='webhook'`, ≤32KB, exact-sha `repo_read` checkout, duplicate delivery → one run · **AC-C5** task actor `agent:<id>`; dedup → comment-bump not task; `auto_triage=verdict` lands flow+runner+baseBranch · **AC-C6** failing test on main → task ≤10 min with verbatim-reproducing repro; re-delivered webhook no dup; auto-launch on fixture project.

---

## Tasks

### Phase 0 — SDD / docs-first (specs complete & internally consistent BEFORE code; exit = `pnpm validate:docs` green + impl-status tags correct)
- [ ] **T0.1 — ADR-123 (stub header first).** `docs/decisions.md`: `### ADR-123: Implicit workspace-boundary default-deny rule at the guardrail seam (+ per-agent declared token scopes)` — decision, modes, arbitration(writes)/audit(reads) semantics (no threshold), supervisor-side realpath roots, dedicated `session.workspace_boundary` event, composition, non-goals, scopes-as-frontmatter/allowlist(12)/instance-narrow-only; record the first-external-cost-exposure decision (token counts only, never `$` — no ext endpoint returns cost today, no prior policy). Cite ADR-108/111/112/121. Verify `grep 'ADR-123'` + `pnpm validate:docs:adr`.
- [ ] **T0.2 — `guardrail-hooks.md`.** Correct stale `(Designed — ADR-108)` → `(Implemented — ADR-108; native-hook live-fire residual)`; add the boundary section (rule, modes, write-arbitration/read-audit, dedicated event, scope=worktree-only, composition); extend `## Expectations` ≤12 testable MUST-bullets (R5a) + `## Edge cases` bolded scenarios; update `## Linked artifacts`.
- [ ] **T0.3 — agents/external-operations/triage docs.** `agents.md` (declared `scopes` mechanism, allowlist, upgrade-preview escalation, `workspace_ref: trigger` sha-preference note, + testable `## Expectations` MUST-bullets for the scopes mechanism in T0.2's format); `external-operations.md` (`GET …/runs` + `runs:read` in the agent-token set via "New scopes (ADR-123)" format, `run_list` tool, + MUST-bullets for the runs read API); `triage.md` only if contract text changes (triage_set already on main).
- [ ] **T0.4 — `supervisor.openapi.yaml`.** Add `workspaceBoundary: { mode: enum[off,warn,enforce] }` to `StartSessionRequest` (sibling to `hooksConfig`/`readOnlySession`). Lint clean.
- [ ] **T0.5 — `operations.openapi.yaml`.** Add `extListProjectRuns` (`GET …/runs`, `security:[projectToken:[runs:read]]`, query `since/status/kind/limit` — field semantics per FR-B2, `RunSummary` schema — terminal field `endedAt`; nullable `costSummary` MUST carry an explicit `type` sibling to `nullable: true` (redocly convention, cf. `operations.openapi.yaml:1937-1940` / commit `db28c37c`) — 200/401/403/404) mirroring `extListProjectFlows`; document `runs:read` in the agent-token set. (`ExtTriageBody` already complete on main.) Lint clean.
- [ ] **T0.6 — AsyncAPI dedicated event.** Add `SessionWorkspaceBoundary`/`session.workspace_boundary` to `web-runs.asyncapi.yaml` + `supervisor-sse.asyncapi.yaml` + `EventBase.type` (fields tool/path/classification/mode/action). Lint clean.
- [ ] **T0.7 — Numbering/migration record.** State zero migrations + ADR-123 + brain reservations; re-verify against `main` `a0c99fdd`.
- [ ] **T0.8 — Env/config docs.** `configuration.md` env table + `getting-started.md`: `MAISTER_WORKSPACE_BOUNDARY` (web tier, default `warn`). (No trip-threshold env — dropped.) Actual `.env.example`/compose edits = TF.1.

### Phase A — Supervisor boundary rule (item A) [depends: T0.1,T0.2,T0.4,T0.6]
- [ ] **TA.1 — Pure boundary evaluator (RED first).** `resolveWorkspaceBoundaryDecision({ roots, toolCall, cwd, mode })` in `supervisor/src/guardrail-hooks.ts` (or `workspace-boundary.ts`), reusing `prompt-confinement.ts` multi-root prefix containment (string-based `path.relative` — realpath + darwin case-canonicalization are NEW code here). Classify read/write — read-class kinds = existing `READ_ONLY_SESSION_ALLOWED_KINDS` (`read|search|fetch|think`, `acp-client.ts:114`), write-class = `WRITE_KINDS`; NEW all-locations extractor (existing `extractWritePath` reads only `locations[0]` — leave `path_guard` untouched); resolve path (relative→cwd, `..`, realpath-where-exists); prefix-safe (`/a/b`≠`/a/bc`); case-canonical darwin; multi-path arrays (any out fails); absent/empty→`unclassified`; `~/` expand; `.git` gitdir target outside roots→out. Tests: `supervisor/src/__tests__/workspace-boundary.test.ts` (owns AC-A3 + normalization edge cases).
- [ ] **TA.2 — Spawn plumbing + frozen roots (fail-closed).** `workspaceBoundary` on `StartSessionRequestSchema` (`types.ts`, `.strict`); `boundaryMode`+`boundaryRoots` on `SessionRecord`; supervisor-side `realpath(worktreePath)`+`realpath(runDir-derived)` at spawn, memoized; fail-closed-to-`warn`+ERROR. Web env resolver `resolveWorkspaceBoundary` (mirror `hookEnvDefaults`), shipped in payload. LOGGING: ERROR on fail-closed; INFO once with armed mode. Files: `supervisor/src/types.ts`,`spawn.ts`,`http-api.ts`; `web/lib/supervisor-client.ts`(+mirror),`web/lib/flows/hooks-config.ts` (or sibling). Tests: `spawn.test.ts` (roots frozen; fail-closed).
- [ ] **TA.3 — Write arbitration.** In `acp-client.ts requestPermission`, after `path_guard`, boundary-evaluate write-class: `enforce`→deny inline + `session.workspace_boundary`(`action=denied`); `warn`→allow + audit(`action=warned`). Resolve the ACP deferred on every branch (no leak). Files: `acp-client.ts` + emit helper. Tests: `guardrail-interceptor.integration.test.ts` — AC-A1 (sibling write denied; same op inside worktree succeeds), AC-A2 (warn proceeds + audit).
- [ ] **TA.4 — Read/observation audit (no halt).** In `sessionUpdate` tool_call handling, boundary-classify reads (kind sets from TA.1's evaluator — no second read-kind set); **both modes audit only** (`action=warned`), never halt, no counter. Files: `acp-client.ts`. Tests: read out-of-boundary → audit event, run continues, no HITL (owns the read-audit behavior). *(No `HookRule`/`HookTripHaltRule`/web `hook-trip` changes — boundary never trips.)*
- [ ] **TA.5 — Dedicated audit event.** `session.workspace_boundary` in the `SessionEvent` union (`types.ts`) `{tool,path,classification,mode,action,monotonicId}`; emit from TA.3/TA.4; appended via registry; MIRROR into the hand-maintained web `SupervisorEvent` union (`web/lib/supervisor-client.ts:299-365`, "Mirrors supervisor/src/types.ts" — must-sweep pair); no secrets/contents. Tests: audit-field correctness + no-content-leak (owns FR-A6).
- [ ] **TA.6 — Composition & no-regression.** Additive to `path_guard` (narrower explicit deny inside worktree still fires); `none`/`repo_read` L1–L3 untouched; `off` bypass (byte-identical golden path); runDir + worktree writes (incl `.claude/`) allowed. Tests: AC-A5 (repo_read/none suites unchanged; off byte-identical) + edge cases (boundary+narrower path_guard; runDir/worktree writes allowed).
- [ ] **TA.7 — Run-detail visibility of boundary audits.** Project `session.workspace_boundary` into the web run-detail/transcript surface the way `session.hook_trip` is surfaced — web event projectors silently drop unknown types today (e.g. `web/lib/scratch-runs/events.ts:140` `default`); render tool/path/classification/mode/action; i18n EN+RU. Files: web event projector(s) (`web/lib/scratch-runs/events.ts`, hook-trip-style surface, run-detail components). Tests: projector unit + `renderToStaticMarkup` EN+RU (owns AC-A8).

*Exit: supervisor suite green; AC-A1,A2,A3,A5,A8 pass; no regression.*

### Phase B — Agent scopes + launch/UX refinements (item B) [depends: T0.1,T0.3; parallel with A]
- [ ] **TB.1 — Allowlist(12) + frontmatter `scopes`.** `AGENT_SCOPE_ALLOWLIST` in `token-scopes.ts`; `scopes: z.array(z.enum(AGENT_SCOPE_ALLOWLIST)).optional()` + uniqueness superRefine in `definition.ts`; thread through `ParsedAgentDefinition`/`AgentDefinitionInput`/`renderAgentDefinition`. Tests: `definition.test.ts` — AC-B1 (`scopes:["runs:read"]` ok; `scopes:["projects:admin"]`→CONFIG row-not-written; render→reparse round-trip).
- [ ] **TB.2 — Effective union + mint.** `issueAgentRunToken()` gains `scopes` param; `launch.ts` passes `ctx.effective.parsed.scopes`; mint = `[...AGENT_TOKEN_SCOPES, ...declared]` (dedup). Tests: `tokens.test.ts` (union; no-scopes snapshot = current 10-member set) + launch integration.
- [ ] **TB.3 — Upgrade-preview scope-diff.** `agentFieldChanges()` (`lifecycle.ts`) → `addedScopes`/`droppedScopes` in `AgentUpgradeImpact.changed[]`; `addedScopes` = privilege escalation; MIRROR into the client `PreviewAgentImpact` DTO + rendering + i18n labels (`web/components/board/package-actions.tsx:43-66`). Tests: lifecycle scope-diff + upgrade-preview render (EN+RU).
- [ ] **TB.4 — UI effective scopes + DTO.** `agent-view.tsx` Scopes chip-row (effective = base ∪ declared); `scopes` into `projectAgentSummary()` allow-list if surfaced. i18n EN+RU. Tests: `renderToStaticMarkup` (EN+RU).
- [ ] **TB.5 — Exact-sha webhook checkout (5a-B).** `resolveWorkspaceRefCommittish()` (`launch.ts:524`): for `source==="webhook"`, prefer `payload.sha` when present, fallback to `payload.branch`/`ref` when absent; AND on an unresolvable sha retry with `branch`/`ref` + record a degradation note for the sentinel (downstream `resolveBaseCommit` throws `PRECONDITION` today, `launch.ts:582` — NO fallback exists). Small, correct, unblocks build-sentinel at the failing tree. Files: `web/lib/agents/launch.ts`. Tests: unit — `sha` present→committish=sha; absent→branch fallback; unresolvable sha→branch fallback + degradation note.
- [ ] **TB.6 — Agent-schedule TZ autodetect (Q1).** `agents-attach-edit-modal.tsx`: default a new/blank schedule's timezone to `Intl.DateTimeFormat().resolvedOptions().timeZone` (reuse the run-schedule editor pattern) instead of `"UTC"`; still editable. Tests: dom test — STUB `Intl.DateTimeFormat().resolvedOptions().timeZone` (CI may itself run in UTC; asserting a real non-UTC value is flaky): new schedule prefills the stubbed TZ; existing/recommended TZ preserved.

### Phase C — Ext runs API + run_list MCP (item B) [depends: T0.3,T0.5 — fully parallel with B: `runs:read` is already in master `TOKEN_SCOPES` + `PROJECT_ACTION_BY_SCOPE`→`readBoard` (`ext-handler.ts:97`); nothing here touches the agent allowlist]
- [ ] **TC.1 — Shared `computeQueuePosition`.** Factor the Pending-position `count(*)` out of `scheduler.ts tryStartRun`; admission behavior identical. Tests: parity (admission vs read-side).
- [ ] **TC.2 — `RunSummary` DTO + `listRunSummaries`.** `runs→tasks→projects` (taskKey), `activeSessionRunnerId` (runnerId), `startedAt`/`endedAt`/`durationMs`, batch `pendingHitlCount`, `queuePosition` (Pending-only via TC.1), `costSummary` from `run_cost_rollups` (token counts, nullable). Filters `since/status/kind/limit≤100 default 50 newest-first`. Files: `web/lib/services/runs.ts`. Tests: integration (real PG).
- [ ] **TC.3 — `GET /api/v1/ext/projects/[slug]/runs`.** `handleExt({slug,scopeLabel:"runs:read"})`; projectId server-derived; 404 existence-hide; token audit success+failure; summary-only. Files: `web/app/api/v1/ext/projects/[slug]/runs/route.ts`. Tests: AC-B2 (filtered/ordered + pendingHitlCount + costSummary; wrong-project→404; no `runs:read`→403+failure audit; unauthenticated/malformed body→401/403 BEFORE parse — auth-first regression; mirror `flows/__tests__/route.integration.test.ts`).
- [ ] **TC.4 — MCP `run_list`.** `TOOL_SPECS.run_list={slug,since?,status?,kind?,limit?}` (hand-mirror ext query) + `resolveRouting`→`GET …/runs?<query>`; docs in `external-operations.md`. ALSO add the `{method, path}` entry to `mcp/src/__tests__/tool-contract.test.ts` `TOOL_OP` — the OpenAPI-anchored contract guard fails BY DESIGN until the T0.5 spec op + this entry exist, and its per-field assertions (types/enums/bounds) then drive the inputSchema. Files: `mcp/src/tools.ts`, `mcp/src/__tests__/tool-contract.test.ts`. Tests: MCP round-trip (AC-B3) + the contract guard.
- [ ] **TC.5 — DROPPED.** `triage_set` full-surface fix is on `main` (`a0c99fdd`). No work; a schema-equivalence guard test already ships with that commit.
- [ ] **TC.6 — Verify `task_create` (FR-B5).** Confirm ext route + MCP tool exist; assert agent-created tasks carry `actor_label=agent:<id>` in `token_audit_log`; confirm no self-loop (sentinel webhook-only). Tests: task_create actor-attribution assertion.

### Phase D — Two agents + platform fixtures/tests (item C) [depends: B,C green — both agents are `none`/`repo_read`, outside the §A boundary; Phase A is independent]
- [ ] **TD.1 — `standup-digest.md`** (hand-off to owner for the core package). Frontmatter + behavior per Design §C (cron+manual only, `scopes:[runs:read,tasks:create]` — task-create for the singleton digest task; Needs-you from `run_list` counts, NO `hitl_list`; quiet-day, idempotent window marker, memory skipped, neutral UTC recommended cron).
- [ ] **TD.2 — `build-sentinel.md`** (hand-off). Frontmatter + behavior per Design §C (`repo_read`+`workspace_ref:trigger`, `scopes:[runs:read,tasks:create]`, **`logExcerpt` in payload → no github MCP**, `capability_profile.mcps:[github]` optional/commented, exact-sha investigation, fingerprint+sha-known-run dedup, prompt-injection hardening, `auto_triage=verdict`).
- [ ] **TD.3 — Platform fixtures + parse tests.** Byte-identical `standup-digest.md`+`build-sentinel.md` under `web/lib/agents/__tests__/fixtures/core-package/maister-agents/`; parse tests (mirror `triager-definition.test.ts`) asserting frontmatter + declared scopes, + `toContain` pinning of load-bearing prompt guards (sentinel prompt-injection section; digest window-marker idempotency — triager pinning pattern). Tests: parse + effective-scope-set (digest base∪{runs:read,tasks:create}; sentinel base∪{runs:read,tasks:create}) + prompt-pinning.
- [ ] **TD.4 — Substrate integration (mock adapter).** AC-C1 (cron→agent run under agent budget, correct token scopes, facade calls, comment created, token revoked at terminal, dirty-watchdog green); AC-C2 (two same-window fires→one comment); AC-C4 (webhook→`trigger_source='webhook'`, payload ≤32KB, **exact-sha repo_read checkout** (TB.5), clean-baseline; duplicate delivery via `X-Maister-Trigger-Event-Id`→one run); AC-C5 (task actor `agent:<id>`; dedup→comment-not-task; `auto_triage=verdict` lands flow+runner+baseBranch). Files: `web/lib/agents/__tests__/*.integration.test.ts`.

### Phase E — Dogfood wiring [depends: D]
- [ ] **TE.1 — OWNER: core release.** Owner extends `core`, commits the triager rewrite + folds in TD.1/TD.2, reconciles the platform-fixture drift, cuts the first **`core/v1.0.0`** tag. This plan supplies the agent `.md` content; the commit/tag is owner-owned.
- [ ] **TE.2 — OPTIONAL / deferred: `github` MCP catalog.** Only if richer full-log access beyond `logExcerpt` is wanted later: `POST /api/admin/mcp-servers` github stdio def (`envKeys:["GITHUB_TOKEN"]`) + exec-trust flip + set build-sentinel `capability_profile.mcps`. **Not on the v1 critical path** (logExcerpt covers the loop).
- [ ] **TE.3 — `maister-notify.yml`.** CI EXISTS (`.github/workflows/ci.yml` — lint-typecheck-unit web+supervisor + label-gated integration; contingency dropped). Add `maister-notify.yml`: `on: workflow_run [completed]` with `workflows: ["CI"]` (ci.yml's exact `name:`), filter `conclusion=='failure' && head_branch=='main'`, build the ≤32KB payload incl. **`logExcerpt` = trimmed failing-job log tail** + `runId`, `POST /api/agents/<build-sentinel-id>/event` with `Authorization: Bearer <agents:trigger token>` (GH secret) + `X-Maister-Trigger-Event-Id: <workflow_run id>`.
- [ ] **TE.4 — Attach/enable on MAIster project [after TE.1 tag].** Attach both agents; configure standup-digest cron `0 8 * * *` + operator TZ (autodetected via TB.6); build-sentinel `auto_triage=verdict`; mint the `agents:trigger` token for CI. Rollout guard: `MAISTER_WORKSPACE_BOUNDARY=warn` for the first dogfood days.

### Phase F — Deployment wiring + verification [depends: all]
- [ ] **TF.1 — Deployment wiring (skill-context rule #1).** `.env.example` + `compose.yml` web `environment:` (+ prod overlay): `MAISTER_WORKSPACE_BOUNDARY`; `docs/configuration.md` env table canonical. (github MCP/`GITHUB_TOKEN` only if TE.2 is taken.) Files: `.env.example`,`compose.yml`(+overlays),`docs/configuration.md`.
- [ ] **TF.2 — Full-suite green + manual dogfood.** `pnpm --filter maister-web test:unit && test:integration`, supervisor suite, e2e, `eslint .` (check-only), `pnpm validate:docs` — all green. Record: AC-C3 (next-morning digest exists; numbers spot-checked vs DB with exact SQL; mention in inbox), AC-C6 (failing test on `main`→task ≤10 min, repro reproduces verbatim; re-delivered webhook no dup; `verdict_and_enqueue` auto-launch on a fixture project). Finalize as-built tags.

---

## Commit Plan
- **Commit 1** (T0.*): `docs(tact0): ADR-123 + boundary/scopes specs + API contracts (docs-first)`
- **Commit 2** (TA.*): `feat(supervisor,web): implicit workspace-boundary rule at ACP seam + run-detail audit surfacing (ADR-123)`
- **Commit 3** (TB.*): `feat(agents): declared token scopes + exact-sha webhook checkout + schedule TZ autodetect (ADR-123)`
- **Commit 4** (TC.*): `feat(ext): runs read API + run_list MCP`
- **Commit 5** (TD.*): `test(agents): standup-digest + build-sentinel fixtures + substrate integration` (+ owner's maister-plugins commit)
- **Commit 6** (TE.3): `chore(dogfood): maister-notify.yml CI→sentinel webhook`
- **Commit 7** (TF.*): `chore(deploy): boundary env wiring + verification`

---

## Traceability matrix (FR/AC → task → owning test)

| FR / AC | Task(s) | Owning test |
|---|---|---|
| FR-A1 boundary on worktree sessions; none/repo_read unchanged | TA.2,TA.6 | `guardrail-interceptor.integration` + AC-A5 |
| FR-A2 realpath roots frozen | TA.2 | `spawn.test.ts` |
| FR-A3 path normalization | TA.1 | `workspace-boundary.test.ts` (AC-A3) |
| FR-A4 modes + env snapshot | TA.2 | `spawn.test.ts` + hooks-config env test |
| FR-A5′ (locked) enforce=deny writes inline / warn+read=audit, no halt | TA.3,TA.4 | AC-A1, AC-A2, read-audit test |
| FR-A6 dedicated audit event, no secrets | TA.5,T0.6 | TA.5 audit-field test |
| FR-A7 composition | TA.6 | boundary+narrower path_guard test |
| FR-A8 unknown-shape unclassified | TA.1 | `workspace-boundary.test.ts` |
| AC-A1,A2,A3,A5 | TA.1–TA.6 | as above |
| AC-A8 boundary audit visible in run detail (EN+RU) | TA.7 | projector unit + `renderToStaticMarkup` |
| Web `SupervisorEvent` mirror carries the new event | TA.5 | mirror-union type check / projector test |
| AC-A6 docs+ADR | T0.1,T0.2,T0.4,T0.6 | `pnpm validate:docs` |
| AC-A7 no migration | T0.7 | journal-diff |
| ~~AC-A4 threshold~~ | — | dropped (5b-C) |
| FR-B1 declared scopes CONFIG-at-parse | TB.1 | `definition.test.ts` (AC-B1) |
| FR-B2 runs read API + DTO | TC.2,TC.3 | runs-route integration (AC-B2) |
| FR-B3 costSummary (rollup tokens, nullable) | TC.2 | runs-service integration |
| FR-B4 run_list MCP | TC.4 | MCP round-trip (AC-B3) |
| FR-B5 task_create + actor attribution | TC.6 | actor-attribution test |
| FR-B6 triage_set full-surface | — | **inherited from main `a0c99fdd`** (guard test ships with it) |
| AC-B1,B2,B3,B4 | TB.1,TC.2,TC.3,TC.4 | as above |
| AC-B4 scope union mint + terminal revocation (no-scopes snapshot = today's 10) | TB.2 | `tokens.test.ts` |
| Upgrade-preview scope escalation | TB.3 | lifecycle scope-diff |
| UI effective scopes | TB.4 | renderToStaticMarkup EN+RU |
| Exact-sha webhook checkout (5a-B) | TB.5 | `launch` unit + AC-C4 checkout |
| Schedule TZ autodetect (Q1) | TB.6 | `agents-attach-edit-modal` dom test |
| standup-digest AC-C1/C2/C3 | TD.1,TD.3,TD.4,TF.2 | substrate integration + manual |
| build-sentinel AC-C4/C5/C6 | TD.2,TD.3,TD.4,TE.3,TF.2 | substrate integration + manual |

---

## Edge-case coverage (each → one owning test)
| Edge case | Owning test (task) |
|---|---|
| Multi-path tool call — any out-of-boundary member fails | `workspace-boundary.test.ts` (TA.1) |
| Path arg absent/empty → unclassified pass-through | `workspace-boundary.test.ts` (TA.1) |
| `.git` gitdir-file target outside roots → denied (intended) | `workspace-boundary.test.ts` (TA.1) |
| Roots deleted mid-session (GC race) — string-based, MUST NOT throw | `workspace-boundary.test.ts` (TA.1) |
| `~/…` exotic path → expanded then evaluated | `workspace-boundary.test.ts` (TA.1) |
| Boundary + explicit narrower `path_guard` deny inside worktree → explicit fires | `guardrail-interceptor.integration` (TA.6) |
| Prefix-collision `/a/b`≠`/a/bc`; case-variant darwin | `workspace-boundary.test.ts` (TA.1) |
| `off` mode → zero audit, byte-identical golden path | AC-A5 (TA.6) |
| Read out-of-boundary in enforce → audited, run continues (no halt) | TA.4 read-audit test |
| `session.workspace_boundary` not silently dropped by web projectors (unknown-type `default`) | TA.7 projector unit |
| Digest facade calls stay within minted scopes (no `hitl_list`; task-create allowed) | TD.4 (AC-C1) |
| Duplicate webhook delivery → one run (`X-Maister-Trigger-Event-Id`) | TD.4 (AC-C4) |
| Cron overlap / missed tick (singleton + one catch-up) | existing substrate; TD.4 cron path |
| Crash between claim and spawn (`INSERT … ON CONFLICT`) | TD.4 dedup convergence |
| Digest idempotency (two same-window fires → one comment) | TD.4 (AC-C2) |
| sentinel no self-loop; digest (cron-only) not woken by task.created | TD.4 + design (no domain_event trigger) |
| Failing sha unreachable (force-push/GC) after exact-sha checkout | TB.5 fallback-to-branch + sentinel graceful note |

---

## Self-check passes (recorded, post-review)
**1. Completeness — PASS.** Every live FR/AC → task + owning test (matrix). Dropped items explicitly marked: AC-A4 (5b-C), FR-B6/TC.5 (inherited from main). Every touched contract/doc/identifier named. Deployment touchpoints → TF.1. Contract-surface tracing → Phase 0.

**2. Consistency — PASS.** Scope strings identical across `AGENT_SCOPE_ALLOWLIST`(spreads the 10-member base incl `tasks:update`), `tokenHasScope`, `PROJECT_ACTION_BY_SCOPE`, MCP docs, `operations.openapi.yaml` — no new strings. Frontmatter `scopes` ↔ `agent-view.tsx` ↔ docs agree. OpenAPI ↔ route ↔ `RunSummary` ↔ system-analytics agree (Phase 0 first). AsyncAPI `session.workspace_boundary` ↔ supervisor `SessionEvent` union agree. `workspace_ref` sha-preference documented (T0.3) ↔ code (TB.5).

**3. No logical holes — PASS.** Every edge case has a tested behavior (table). Concurrency/crash: duplicate webhook (`X-Maister-Trigger-Event-Id` + `ON CONFLICT`), cron overlap (singleton + atomic per-row claim), crash-between-claim-and-spawn (pre-check + authoritative insert), GC race (string-based eval MUST NOT throw), exact-sha unreachable (fallback-to-branch). Deferred-release: boundary deny resolves the ACP deferred on every branch (TA.3). Fail-closed (TA.2). Launch-time snapshot: boundary mode + token scopes snapshotted; terminal path reads snapshot. Allow-list guards: modes and `AGENT_SCOPE_ALLOWLIST` are allow-lists. **Simplification vs spec is deliberate + owner-approved:** dropped observation-path threshold (5b-C) — enforce prevents only what CAN be prevented (writes); reads are audited.

---

## Locked decisions (owner review, 2026-07-02)
1. **TZ** — per-schedule + editable already exists; add browser-TZ autodetect to the agent schedule editor (TB.6); digest recommended cron TZ = neutral `UTC`. No project-default column, no migration.
2. **triage_set / nifty-hamilton** — landed on `main` `a0c99fdd`; branch rebased; **TC.5 dropped**; base `AGENT_TOKEN_SCOPES` now 10 (incl `tasks:update`).
3. **Core package** — owner-owned commit + first `core/v1.0.0` tag (TE.1); this plan hands off the two `.md`s; platform fixtures/tests unblocked.
4. **github MCP** — NOT required; `logExcerpt` in the webhook payload covers v1 (TD.2/TE.3); the `capability_profile.mcps` mechanism already exists → github catalog is an optional later enhancement (TE.2).
5a. **Checkout** — exact-sha via `resolveWorkspaceRefCommittish` preferring `payload.sha` for webhook (TB.5).
5b. **Enforce** — drop the observation-path threshold/halt; enforce denies out-of-boundary writes inline + audits reads; warn audits all (no run ever paused by the boundary).
5c. **Scope** — boundary applies to worktree-bearing sessions only; `none`/`repo_read` stay on L1.

### Residual owner-gated handoffs (not blockers to Phases 0–D)
- **TE.1** core commit + `core/v1.0.0` tag (owner) — gates only TE.4.
- **TE.2** github MCP catalog + `GITHUB_TOKEN` — optional, only if richer-than-8KB log access is wanted later.
- **TE.4** the `agents:trigger` CI token + digest cron TZ value — set at attach time in project settings.

---

## Improve-pass deltas (2026-07-02, code-verified against `main` `a0c99fdd`; owner-approved)
- **TA.7 added** (run-detail visibility of boundary audits; AC-A8 minted) — web projectors silently drop unknown event types; warn-mode dogfood needs a visible surface.
- **TA.5** gains the web `SupervisorEvent` mirror site (`web/lib/supervisor-client.ts:299-365`, hand-maintained pair).
- **TA.1/TA.4 precision**: `prompt-confinement` containment is string-based (realpath + darwin case-canonicalization = new code); all-locations extractor is new (`extractWritePath` reads `locations[0]` only); read-class kinds reuse `READ_ONLY_SESSION_ALLOWED_KINDS`.
- **TB.3** gains the client `PreviewAgentImpact` mirror (`package-actions.tsx:43-66`) + i18n.
- **TB.5** upgraded to two-level fallback — `resolveBaseCommit` throws `PRECONDITION` on unresolvable refs today; no fallback existed.
- **Digest scopes fixed**: `[runs:read, tasks:create]` (singleton-task creation needs `tasks:create`); `hitl_list` dropped — `hitl:read` is outside the allowlist, Needs-you derives from `run_list` `pendingHitlCount`. Allowlist stays **12**.
- **DTO terminal field = `endedAt`** (`runs.endedAt`, `schema.ts:1383`; was inconsistently `finishedAt`); nullable `costSummary` gets the redocly `type` sibling (`db28c37c` convention).
- **TC.3** gains the auth-first 401/403-before-parse regression; **TD.3** gains `toContain` prompt-pinning (triager pattern).
- **TE.3**: CI exists (`.github/workflows/ci.yml`, workflow name `CI`) — "create CI" contingency dropped.
- **Deps loosened**: Phase C no longer depends on TB.1 (B ∥ C); Phase D depends on B,C only (agents are outside the §A boundary).
- **New "Requirements & acceptance criteria" section** — all live FR/AC now defined in one testable sentence each; dangling AC-B4 defined and owned by TB.2.
- **Settings**: RED→GREEN→REFACTOR made binding per task.
