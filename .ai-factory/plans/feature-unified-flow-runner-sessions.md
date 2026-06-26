# Unified Flow Runner & Session Model (portable, host-bound, multi-session)

**Branch:** `feature/unified-flow-runner-sessions`
**Created:** 2026-06-26
**Mode:** Full · clean cutover (no backward compat, no run-data migration)

## Settings

- **Testing:** YES — unit + integration + e2e. Each phase exits only on a
  green suite (`pnpm test:unit && pnpm test:integration`, supervisor tests,
  Playwright for UI). New tests MUST name their runner project and be proven
  discoverable (`vitest list`); assertion migration for changed behavior is
  IN-SCOPE in the phase that changes it.
- **Logging:** VERBOSE — structured, DEBUG-level for diagnostic reads, INFO for
  state transitions. NEVER log secrets, runner `env` values, or provider
  credentials. The `env` field carries only `env:NAME` references.
- **Docs:** YES — mandatory **docs-first Phase 0** (analytics/ADR/API/ERD
  complete and internally consistent BEFORE any code), per the project's
  `/aif-plan` rules. As-built status flip in Phase 7.

## Roadmap Linkage

- **Milestone:** "M42 — Unified Flow runner & session model" (new — to be added
  to `.ai-factory/ROADMAP.md`; latest existing are M40 guardrail-hooks / M41
  consensus).
- **Rationale:** A cross-cutting engine change (DSL + resolution + DB + runtime
  + supervisor semantics + Studio) that earns its own milestone; it is the
  prerequisite for portable multi-runner flows.

---

## Goal

Replace the three divergent per-node runner mechanisms with ONE unified,
portable runner config, add first-class **sessions** to the flow DSL (lifting
"one runner per run" → "one runner per session"), and make flow packages
portable by binding runner intent to concrete host runners **per project at
connect-time** — never baked into the git artifact.

---

## Verified current state (exploration findings — load-bearing)

Confirmed by reading the code; several contradict the original request and
**change the design**:

1. **`runner_profiles` value schema** (`web/lib/config.schema.ts:698–710`,
   `flowRunnerProfileSchema`) already uses `capability_agent` + `permission_policy`
   (NOT `agent`/`permission_mode`) and has **no `effort` and no `env`**. →
   Decision: reuse existing names + ADD `effort` (reuse `thinkingEffort` enum)
   and `env`.
2. **`judge.settings.model` is never read at runtime** — only shown in a tooltip
   (`web/lib/flows/graph/node-tooltips.ts:65`). `materializeNodeCapabilities`
   (`runner-graph.ts:1401`, ~1480) always uses `loaded.executor.model` (the
   run's single runner). So "judge runs on its own model" is **new wiring**, not
   a removal of working behavior.
3. **`session.json` does NOT exist on disk today** — `acp_session_id` lives only
   in `runs.acp_session_id` (DB). Reconciliation is **web-tier and DB-driven**
   (`web/lib/reconcile.ts`), not supervisor-side, under the hard
   no-`fs.watch`/polling invariant. → Disk-only per-session state cannot drive
   reconcile/resume. **Decision (user): DB `run_sessions` table is the SOLE
   source of truth (full migration); drop the run-level runner/session columns.**
4. **Engine 1.9.0 is already taken** (consensus, M41). `MAISTER_ENGINE_VERSION`
   = "1.9.0" in `web/lib/flows/engine-version.ts`; per-feature floors are
   private consts in `web/lib/config.ts`. → New baseline = **2.0.0**
   (stable-version fixation, user decision — first stable clean-cutover engine).
5. **The supervisor is already multi-session-ready**: registry keyed by
   supervisor `sessionId` (not `runId`), `run.events.jsonl` + `cost.jsonl` are
   per-run with monotonic seeding designed for multi-session, checkpoint/input/
   permission-deferreds are per supervisor session. The "one runner per run"
   lock is entirely web-tier.
6. **"One runner per run" blast radius (9 sites)**: `flow-step-target.ts:60–67`
   (CONFIG-on-divergence throw), `resolve.ts:223–261` (single resolution),
   `flow_runner_remaps` table (no session axis), `launch-options/route.ts`,
   `task-launch-config.ts`, `runs.ts:612–626/1003–1014` (single insert),
   `schema.ts:1293–1330` (single columns), `resume.ts`, `spawn-intent.ts`.
7. **`flow_runner_remaps`** keyed `(projectId, flowRevisionId, stepId,
   sourceRunnerId)` — per-step, not per-session. Bind UI today is a settings-tab
   control (`flow-runner-reconfiguration-control.tsx`), not connect-time.
8. **Consensus** participant/synthesizer runners resolve via a DIRECT
   `platformAcpRunners.id` lookup (`consensus/roles.ts:92`) — **not portable**.
   Participants run as ephemeral parallel **child runs**, not "sessions".
9. **maister-plugins** (SEPARATE external repo — local checkout verified at
   `/repos/maister-plugins`): 24 `flow.yaml` across
   **8** packages (incl. `core`); ALL use an identical
   `runner_profiles.claude-code`; engine_min 1.4.0 (**15**) / 1.5.0 (**9**);
   **zero** judge/consensus/orchestrator/`settings.runner` usage. Rewrite is
   mostly an engine bump + profile-shape pass + two NEW example flows — but it
   is a CROSS-REPO change (see #22).

**Reserved numbers (verified at HEAD `fa68deec`):** next ADR = **ADR-114**;
next migration idx = **0080**.

---

## Target model (decisions — locked)

- **Unified runner config** (`flowRunnerConfigSchema`): `runner_type`,
  `capability_agent`, `adapter?`, `model?`, `model_family?`, `provider?`,
  `permission_policy`, `sidecar?` **+ new `effort?`, `env?`** (values =
  `env:NAME` refs only). Used for `runner_profiles` values, `sessions[].runner`,
  node `settings.runner` (ai_coding/orchestrator/judge), and consensus
  participant/synthesizer `runner`. Any slot accepts a profile-ref string OR an
  inline object. Node CAPABILITY settings (mcps/skills/restrictions/tools/
  enforcement/hooks) stay on the node, unchanged.
- **Sessions** (top-level `sessions:` + node `session:`):
  - node with neither `session:` nor `runner:` → joins the implicit **`default`**
    session (preserves today's single-session behavior, zero ceremony);
  - node with `runner:` and no `session:` → its own **solo** one-node session;
  - node with `session:` → joins that named group, sharing one ACP process + one
    continuous `acp_session_id` resumed in graph order; all sessions share the
    run's single worktree; sessions are **sequential** (not parallel); session
    switch reuses checkpoint→resume (≈$0.28/respawn).
  - **judge** becomes an ordinary runner-bearing node (via `runner:`/`session:`);
    `judge.settings.model` is **removed entirely** (clean cutover — it was never
    read at runtime), including its tooltip reference (`node-tooltips.ts:65`).
  - **consensus** stays a fan-out node EXCLUDED from `sessions:`; its
    participants/synthesizer use the unified runner config and are made portable
    via bindings.
- **Per-project bindings (connect-time OR first launch)** — bind EVERY runner
  slot whose config has no unique host auto-match; covers all sessions + all
  consensus slots, not just `default`. Triggered at Flow-connect, or at first
  launch if still unbound (whichever first). DB table keyed
  `(project_id, flow_revision_id, slot_key)`, `slot_key ∈ {session:<name>,
  consensus:<nodeId>:<participantId>, consensus:<nodeId>:synthesizer}`
  (**slot_key REQUIRED, not just preferred**: a consensus node may legitimately
  declare N participants with IDENTICAL runner intent — LLMs are non-deterministic,
  so two `claude+opus` participants can and should yield different drafts;
  intent-dedup would ERASE a valid configuration by collapsing them. slot_key keeps
  each participant a distinct, independently-bindable slot. **Slot enumeration AND
  the binding UI MUST NOT dedup by intent.** Binding key does NOT affect crash
  recovery — that reads the resolved `run_sessions` snapshot). `mapped_runner_id →
  platform_acp_runners`; status `Pending|Mapped`. Auto-match by intent
  (agent+model+provider); re-prompt on a revision that introduces new slots.
  flow.yaml never names a host runner or secret.
- **Per-session run state** — `run_sessions` table is the SOLE source of truth
  (id, run_id, session_name, runner_id, runner_resolution_tier, capability_agent,
  runner_snapshot, acp_session_id, resolution_source, timestamps;
  `UNIQUE(run_id, session_name)`). `runs.{runner_id, runner_resolution_tier,
  capability_agent, runner_snapshot, acp_session_id}` are DROPPED. Non-flow runs
  (scratch/agent) have exactly one `default` row.
- **Per-session resolution precedence** (per slot): connect-time/first-launch
  **binding** for any slot whose runner config lacks a unique host auto-match →
  auto-match → for the `default` session with no explicit runner only:
  project-flow → platform-flow → project → platform default. An OPTIONAL
  ephemeral per-session override MAY be offered at the Launch dialog for a single
  run (does not persist) — see residual question.
- **Supervisor `sessionName`** — `POST /sessions` gains a `sessionName` field so
  cost (`cost.jsonl`) and events (`run.events.jsonl`) are attributable per
  logical session, not only per supervisor `sessionId`.
- **No new MaisterError code** — reuse `CONFIG` (invalid/unbound session graph)
  and `EXECUTOR_UNAVAILABLE` (no concrete host runner).
- **Engine 2.0.0** — first stable clean-cutover baseline;
  `MAISTER_ENGINE_VERSION` → "2.0.0"; the new features' floor = 2.0.0; all
  rewritten manifests declare `compat.engine_min: 2.0.0`.

---

## Phases & Tasks

> Tasks are tracked in the task list (IDs #1–#24). Dependencies are wired
> blockedBy. Per-phase exit = full suite green.

### Phase 0 — Docs-first analytics & design spec (blocks ALL code)
- [x] **#1 P0.1** ADR-114 + reserve migration 0080 + engine 2.0.0 + no-new-error-code + rule-1 deployment note.
- [x] **#2 P0.2** `system-analytics/sessions.md` (R5) + cross-domain updates (flow-graph, acp-runners, consensus, runs, reconciliation-gc, executors, flow-settings).
- [x] **#3 P0.3** ERD (db/runs-domain.md + db/erd.md) + database-schema.md narrative for `run_sessions`, binding refactor, dropped columns.
- [x] **#4 P0.4** Contract specs (web/supervisor OpenAPI, flow-dsl.md, configuration.md, error-taxonomy.md) + contract-surface checklist + **Phase-0 EXIT gate**.

### Phase 1 — Schema & DSL in code
- [x] **#5 P1.1** Unified runner config + `sessions:` + node `session:`/`runner:` + judge runner (config.schema.ts) + engine bump + loadFlowManifest validation (config.ts).
- [x] **#6 P1.2** Grammar string update + **EXTEND drift-guard test** for top-level `sessions:` (currently invisible to the guard). The guard MUST mirror the **compile invariants** (loader `superRefine`/`config.ts`: undefined-`session:`-ref → `CONFIG`, consensus-excluded-from-`sessions:`, judge-now-runner-bearing), not just the Zod shape — per the 2026-06-26-12.17/12.43 patches (which caught the grammar omitting the consensus `output.produces` contract because the guard only checked Zod keys). Export the invariant consts and assert the grammar text mirrors them.
- [x] **#7 P1.3** compile.ts session assignment (default/solo/named) + CompiledNode threading + run session set.

### Phase 2 — Resolution & binding (DB + resolve)
- [x] **#8 P2.1** Migration 0080/0081 + schema.ts (`run_sessions` table, binding slot_key refactor). NOTE: the DROP of the `runs` runner columns is deferred to migration **0082** (#24) per the expand-contract cutover.
- [x] **#9 P2.2** Per-session resolution (`resolveRunSessions`, remove divergence throw) + binding sync/auto-match + portable consensus. Binding sync = generalize the EXISTING install-time populator `acp-runners/flow-reconfiguration.ts` (`syncFlowRunnerReconfigurationRequirements`, today writes `flow_runner_remaps` Pending rows on flow install) from per-step → per-slot. Map the existing 6-tier `resolve.ts:223–261` chain (launchOverride → stepTarget → projectFlowDefault → platformFlowDefault → projectDefault → platformDefault) onto the per-session model — the top two tiers are NOT dropped: launchOverride becomes the ephemeral per-run override, stepTarget becomes the session runner config.
- [x] **#10 P2.3** Binding HTTP routes (session/slot-keyed) + connect-time endpoint (identifier labels, allow-lists, SET/CLEAR/re-SET).
- [x] **#11 P2.4** launch-options + task-launch-config per-session surface.

### Phase 3 — Run lifecycle (multi-session web + supervisor)
- [x] **#25 P3.0** Supervisor: accept + stamp `sessionName` (StartSessionRequest, CostRecord, SessionRecord, events) for per-session cost/event attribution.
- [x] **#12 P3.1** Launch: resolve N sessions + atomic run + N `run_sessions` insert (one tx) + pass `sessionName` per session.
- [x] **#13 P3.2** Runtime dispatch: per-node session resume + persist acp_session_id; judge runs on its session runner (model field removed; materialize uses the session runner's model).
- [x] **#14 P3.3** Fan `run_sessions` to ALL run creators (scratch×2/agent/consensus-child via `agents/launch.ts`) + runner-delete guard (`activeRunSession` ref) + **gate-chat ACTIVE-session live-delivery** (`services/gate-chat.ts` reads the latest `run_sessions.acp_session_id`). NOTE: `services/hitl.ts` resume path delegates to `resumeRun` (active-session lands in #16); UI read models still read the `runs.*` mirror (tsc-forced move to `run_sessions` at #24).

### Phase 4 — Reconcile / resume / recover / terminal
- [ ] **#15 P4.1** Reconcile active-session-aware classification + run_kind branch + crash-window coverage.
- [ ] **#16 P4.2** Resume + recover session-aware respawn + run_kind branch.
- [ ] **#17 P4.3** Terminal transition closes ALL sessions (no leaked deferreds) + slot-release.

### Phase 5 — Studio UI + i18n
- [ ] **#18 P5.1** Node-form runner picker (replace model field) + session selector.
- [ ] **#19 P5.2** Consensus participant/synthesizer unified runner dropdown.
- [ ] **#20 P5.3** Connect-time binding screen + refactor reconfiguration control.
- [ ] **#21 P5.4** Canvas session viz (chip + grouping) + EN/RU i18n parity.

### Phase 6 — Manifest rewrite + validation
- [ ] **#22 P6.1** Rewrite all 24 maister-plugins manifests + author multi-session & consensus example flows. **Cross-repo**: maister-plugins is a separate repo (`/repos/maister-plugins`) on its own branch/tag — engine-2.0.0 + `compat.engine_min: 2.0.0` manifests only run against THIS branch's engine, so land the two as a coordinated pair (decide the release order — see residual question). ALSO bump the in-repo fixtures that declare `runner_profiles` (`web/test-fixtures/aif-flows/*`, `web/lib/flows/__tests__/_fixtures/*`, `web/lib/agents/__tests__/_fixtures/*`) to the unified config + judge-model removal so #23 stays green (the SCHEMA change is the breakage risk, not the engine-floor bump — `2.0.0 ≥ 1.1.0` still satisfies a low `engine_min`).
- [ ] **#23 P6.2** End-to-end success-criteria validation (2 runners/run, portable consensus, connect-time binding reuse, judge-on-own-runner).

### Phase 7 — Close-out
- [ ] **#24 P7.1** As-built status flip + ADR/migration renumber check vs main + full verification gate.

---

## Contract-surface checklist (rule-2 — /aif-verify re-derives from diff)

| Surface | Spec file |
| --- | --- |
| `GET/PATCH /api/projects/{slug}/flow-runner-remaps` → session/slot bindings + connect-time endpoint | `docs/api/web.openapi.yaml` |
| `GET /api/runs/launch-options` per-session response | `docs/api/web.openapi.yaml` |
| `POST /sessions` **adds `sessionName`** (per-session cost/event attribution) | `docs/api/supervisor.openapi.yaml` |
| New DSL: `sessions:`, node `session:`/`runner:`, unified runner config, judge `runner:` | `docs/flow-dsl.md` + `web/lib/config.schema.ts` + `web/lib/flows/flow-dsl-grammar.ts` (+ drift-guard test) |
| `compat.engine_min` 2.0.0 + unified config + `env`/`effort` | `docs/configuration.md` |
| `run_sessions` + binding table + dropped runs columns | migration 0080 + `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/db/erd.md` |
| Error codes (confirm reuse, no new code) | `docs/error-taxonomy.md` |
| The model decision | `docs/decisions.md` ADR-114 |

## Per-route identifier labels (rule-4)

Binding route(s): `slug` = **url-param** (access-controlled); `slot_key` =
**body-controlled** → validate ∈ revision-declared slots (server-state) else
409/422; `mapped_runner_id` = **body-controlled** → validate ∈
`platform_acp_runners` (allow-list). DB-only, no downstream side-effect → no
two-phase commit required (state it in the task).

## Atomicity & crash windows (rule-10)

- Launch: `git worktree add` BEFORE tx; `runs` + N `run_sessions` rows in ONE
  `db.transaction`; supervisor spawn AFTER commit. Crash before commit → no run
  (clean retry); crash after commit before spawn → recoverable by sweep.
- Terminal/abandon: run status flip + per-session closure in one tx; close
  EVERY `run_sessions` live process + cancel its deferreds; honor
  `promoteNextPending`.
- Reconcile must cover: partial `run_sessions` insert, spawned-but-unpersisted
  `acp_session_id`, mid-run session switch.

## Consumer fan-out for dropped runs columns (rule-11)

`runs.ts` launch · `runner-core.ts` loadRun · `runner-graph.ts` dispatch/park ·
`flows/runner-agent.ts` (the per-node `acp_session_id` persist site, :896–1170) ·
`resume.ts` · `recover.ts` · `runs/resume-recovery.ts` (idle keep-alive sweeper —
`WHERE isNotNull(runs.acpSessionId)` :87 must JOIN `run_sessions`) ·
`reconcile.ts` · `scratch-runs/service.ts` · `agents/launch.ts` (also the
orchestrator-child creator, reached via `/api/v1/ext/runs/delegate`) ·
`consensus/drafts.ts` · `runs/promote.ts` (nulls `acp_session_id`
:904/928/1182/1511 → must close ALL sessions) ·
`workbench-lifecycle/service.ts` (stop/archive nulls `acp_session_id`
:1531/1624 → close ALL sessions) · `services/gate-chat.ts` (:349/439/638 reads
`acp_session_id` + `runner_snapshot` fields) · `services/hitl.ts` (:225/710) ·
`acp-runners/usage.ts` (delete guard) · UI reads (`portfolio.ts`,
`runs-list.ts`, `task-detail.ts`) · `spawn-intent.ts`. Each reads/writes
`run_sessions` (active/default session); shared dispatch branches on `run_kind`.
`tsc` forces touching all of these when the columns drop — but `promote`/
`workbench-lifecycle` must close **every** session and `gate-chat`/`hitl` must
target the **ACTIVE** session, so a naive "make it compile against the default
row" is semantically wrong for those four. NOTE: `step_runs.acp_session_id`
(`flows/step-runs.ts`) is a SEPARATE per-step-run column that STAYS — it records
which session a step used; do NOT drop or migrate it.

## Deployment touchpoints (rule-1)

NONE. No new host env var, sidecar, bound port, or runtime config file (the
`env` field is a flow-authored passthrough-NAME map; secrets stay `env:NAME`).
→ no `Dockerfile`/`compose*.yml`/`.env.example` change. Stated explicitly so the
absence is intentional, not an omission.

## ADR / migration reservation (rule-12)

ADR-114 + migration 0080 reserved at HEAD. Parallel branches may collide —
Phase 7 budgets a renumber check vs `main` (`git show main:docs/decisions.md`,
`_journal.json`) after rebase.

---

## Commit Plan (checkpoints every 3–5 tasks)

1. After **#4** — `docs: ADR-114 + session model analytics/contracts (M42 Phase 0)`
2. After **#7** — `feat(flows): unified runner config + sessions DSL + compile (M42 Phase 1)`
3. After **#11** — `feat(acp-runners): per-session resolution + connect-time bindings + migration 0080 (M42 Phase 2)`
4. After **#14** — `feat(runs): multi-session launch + runtime dispatch + run_sessions fan-out (M42 Phase 3)`
5. After **#17** — `feat(runs): session-aware reconcile/resume/recover/terminal (M42 Phase 4)`
6. After **#21** — `feat(studio): runner pickers + binding screen + session viz + i18n (M42 Phase 5)`
7. After **#23** — `chore(plugins): rewrite 24 manifests + e2e validation (M42 Phase 6)`
8. After **#24** — `docs+chore: as-built flip + renumber + final gate (M42 Phase 7)`

---

## Out of scope

- Parallel multi-session execution beyond existing consensus/orchestrator
  fan-out (sessions are sequential, context-sharing groups).
- Cross-host runner federation; sidecar lifecycle changes.
- Disk `sessions/<name>.json` mirror (DB-only model chosen).

---

## Решённые вопросы (зафиксировано 2026-06-26)

1. **Ключ binding** = `slot_key` — ОБЯЗАТЕЛЬНО (не предпочтение). Consensus может иметь N участников с ОДИНАКОВЫМ intent (LLM недетерминированы → два `claude+opus` дают разные драфты; пользователь вправе так настроить); intent-dedup стёр бы валидную конфигурацию. Перечисление слотов И UI binding-а НЕ дедуплицируют по intent. На crash-recovery ключ не влияет (читается `run_sessions`).
2. **judge `settings.model`** — удалить полностью (включая tooltip). judge — обычная runner-нода.
3. **Binding** покрывает ВСЕ слоты без хост-матча, на connect-time или при первом запуске (что раньше), для всех сессий + consensus, не только `default`.
4. **supervisor `POST /sessions`** — добавляем `sessionName` (атрибуция cost/events по сессии). Новая задача #25.
5. **Переключение сессий** = checkpoint→resume (≈$0.28/respawn). Принято.
6. **Engine = 2.0.0** — фиксация стабильной версии; `MAISTER_ENGINE_VERSION` → "2.0.0", floor новых фич = 2.0.0.

## Остаточный вопрос — решён

- **Эфемерный per-run override** на Launch-диалоге — оставляем минимальный per-session override (подтверждено пользователем 2026-06-26).

## Остаточные вопросы — открыты после improve-прохода (2026-06-26)

1. **maister-plugins (cross-repo)**: какая ветка/тег под engine 2.0.0? Релиз парой (движок-в-main + манифесты одновременно) или сначала движок, потом плагины? Кто держит совместимость в окне рассинхрона (старые pinned-теги пакетов на проде продолжат тянуть `engine_min ≤ 1.9.0` — они НЕ ломаются, но новые 2.0.0-манифесты не запустятся на проде до деплоя движка)?

---

## RESUMPTION STATE — 2026-06-27 (Phases 0–3 COMPLETE; resume at #15)

> THIS section + the `- [x]` checkboxes are the durable record (the harness task
> list is lost on context clear). On resume, read this and continue at **#15**.

**Branch:** `feature/unified-flow-runner-sessions` — **11 commits, UNMERGED + UNPUSHED**.
**Done: #1–#14 + #25 (Phases 0–3).** All gates green (re-verified 2026-06-27):
web `tsc 0` / `unit 5154`, supervisor `tsc 0` / `unit 300`, docs `306` mermaid +
`594` ADR anchors, `db:generate` → "No schema changes" (journal monotonic
0079…03 → 0080…04 → 0081…05), eslint 0.

Phase-2/3 commits (newest first): `1a49fd0e` format · `1efe7b38` plan ·
`fdb4c60b` #14 (run_sessions fan-out + active-session gate-chat) · `f85184a9`
#13 (per-node session dispatch) · `20bcedaa` #25+#12 (supervisor sessionName +
multi-session launch) · `998893fc` #9–#11 (resolution + slot routes + launch
surface). Earlier: `0514d59f`/`cd0c8e91`/`05c77f53` Phase 2 schema+binding ·
`603f7a3b` Phase 1 · `667b037a` Phase 0.

**★★ EXPAND-CONTRACT STATE (critical to understand before #15):** the 5 `runs`
runner columns (`runner_id, runner_resolution_tier, capability_agent,
runner_snapshot, acp_session_id`) + `runs_runner_idx` **STILL EXIST and are STILL
WRITTEN** as a MIRROR of the run's PRIMARY session (launch writes them from the
primary; dispatch sets `runs.acp_session_id` first-time-only). `run_sessions` is
the additive **sole source of truth**, written by ALL creators (flow=N rows,
scratch/agent/consensus-child=1 `default`). **Readers are SPLIT:** the per-node
graph DISPATCH reads `run_sessions` (#13); **reconcile / resume / recover /
terminal / UI read-models STILL read the `runs.*` mirror** — which is CORRECT for
every existing single-session flow. The mirror columns DROP in **migration 0082
(#24)**, which `tsc`-forces the full rule-11 reader fan-out. So #15–#17 are only
needed for MULTI-session correctness (no such flow exists until #22 ships them).

**NEXT — #15 reconcile / #16 resume+recover / #17 terminal-closes-all.** REUSE the
active-session pattern already shipped in `lib/services/gate-chat.ts`
`activeRunSessionAcpId` (latest non-null `run_sessions.acp_session_id`, fallback
`runs.acp_session_id`). For resume/recover (#16) you also need the active
session's `runner_snapshot` (not just acp id) — extend the helper to return
`{ acpSessionId, runnerSnapshot }`. #17 (terminal/promote/workbench/abandon) must
close EVERY live `run_sessions` session (sequential sessions → only the active is
live, so in practice close the active + no-op the exited). **These touch
crash-recovery and are NOT runtime-verifiable in the sandbox (no live ACP
agents)** → implement to tsc+unit green; the owner verifies in #23's env. Consider
folding #15–#17 INTO #24's tsc-forced reader fan-out (when the mirror drops, every
reader is forced correct + the owner runtime-verifies once).

**KEY ANCHORS (built this session — reuse for #15–#24):**
- `lib/flows/graph/runner-core.ts` — `loadRun` builds `loaded.sessions:
  Map<name, LoadedRunSession{ runner, acpSessionId, capabilityAgent,
  runnerResolutionTier }>` (legacy run synthesizes a `default` from run-level).
  `executorFromRunnerSnapshot` is EXPORTED.
- `lib/acp-runners/resolve.ts` — `resolveRunSessions` / `resolveRunnerSlot` /
  `autoMatchRunners` / `resolveSlotConfig` / `defaultRunSessionValues` +
  tiers `binding`/`autoMatch` added to `RunnerResolutionTier`.
- `lib/acp-runners/catalog.ts` — `loadRunnerCatalog` / `loadFlowRunnerBindings`.
- `lib/acp-runners/usage.ts` — `activeRunSession` delete-guard ref (pattern for
  any new `run_sessions` reader).
- `flow-step-target.ts` was DELETED (legacy single-runner divergence path; all
  callers now on `resolveRunSessions`).

**#18–#21 (Studio UI + i18n):** the node-form ALREADY has runner-picker infra
(`components/flows/node-form/reference-combobox.tsx` "Runners" group +
`node-side-form.tsx` runner/agent source kinds — judge `settings.model` removal
compiles clean). NEW work = node `session:` selector, consensus
participant/synthesizer unified runner dropdown, the **connect-time binding
screen** (seed = `components/board/panels/flow-runner-reconfiguration-control.tsx`,
already re-pointed to the slot-keyed PATCH in #10; GET supports `?flowRevisionId`
scope), canvas per-session chip+grouping, EN/RU parity. VERIFIABLE here.

**#22 (cross-repo — ASK-FIRST):** `/repos/maister-plugins`
(SEPARATE repo). OPEN release-order Q (which branch/tag carries engine-2.0.0
manifests; engine-first vs paired). ALSO bump in-repo fixtures
(`web/test-fixtures/aif-flows/*`, `web/lib/flows/__tests__/_fixtures/*`,
`web/lib/agents/__tests__/_fixtures/*`) to unified config + judge-model removal.

**#23 (e2e):** needs owner env (live Claude/Codex + Postgres).
**#24 (close-out):** as-built docs flip (`sessions.md` etc. Designed→Implemented) +
migration **0082** (drop the 5 `runs` mirror cols + `runs_runner_idx`; recreate
FK/idx already on `run_sessions`) — `db:generate` is PTY-interactive for
drops/renames (BLOCKED in sandbox) → hand-SQL + `_journal.json` `when` bump
(>…05) + snapshot JSON-surgery (per the MIGRATION TOOLING note above) + the
rule-11 reader fan-out + renumber check vs `main`.

**TEST-MOCK GOTCHAS (hit + fixed this session — re-apply when touching these):**
- launch-test `compileManifest` mocks need `sessions: new Map([["default",
  { name: "default" }]])` (else `compiled.sessions` undefined).
- `runner-terminal.test.ts` / `runner-reentry.test.ts` DB mocks need a
  `run_sessions` table (`Omit<TableRows,"run_sessions"> & { run_sessions?: Row[] }`
  + `project()` `rows[name] ?? []`; baseFixture literal gets `run_sessions: []`).
- consensus `runtime.test.ts`/`drafts.test.ts` mock `@/lib/acp-runners/catalog`;
  the `loaded` mock needs a `manifest`.
- supervisor `SessionRecord` now REQUIRES `sessionName` (6 fixtures stamp
  `"default"`).

---

### Historical build detail — Phase 0–2 (superseded by the section above)

**Branch:** `feature/unified-flow-runner-sessions`. **5 commits, all green**
(tsc 0, unit 5130, docs validators, eslint 0):
- `667b037a` Phase 0 — ADR-114 + analytics/ERD/OpenAPI/flow-dsl/configuration/error-taxonomy
- `603f7a3b` Phase 1 — `config.schema.ts` unified runner config (`flowRunnerConfigSchema`+`effort`/`env`, `runnerSlotSchema`, `runnerSlotProfileRef`, `sessionNameSchema`) + `sessions:`/node `session:`/judge `runner:` (model removed) + engine **2.0.0** + `config.ts` loader validation (`SESSIONS_ENGINE_MIN`, `validateSessions`, `declaresSessionFeatures`) + grammar drift-guard + `compile.ts` (`CompiledNode.session`, `FlowGraph.sessions`, `CompiledSession`, `RUNNER_BEARING_NODE_TYPES`)
- `05c77f53` `run_sessions` table + migration **0080** (expand)
- `cd0c8e91` `flow_runner_remaps` → `slot_key` refactor + migration **0081** + `lib/acp-runners/runner-slots.ts` (`enumerateRunnerSlots`) + reader fan-out (flow-reconfiguration/usage/queries.project/admin-acp-runners route/reconfiguration-control + tests) + EN/RU `slot` i18n

Done: **#1–#8 + the binding-refactor half of #9.** Working tree CLEAN.

**★ DECISION — expand-contract cutover (deviates from plan's drop-first):** the 5
`runs` runner cols (`runner_id, runner_resolution_tier, capability_agent,
runner_snapshot, acp_session_id`) + `runs_runner_idx` are NOT yet dropped — they
drop LAST in a final **migration 0082** once every reader moved to `run_sessions`
(tsc still force-completes the rule-11 fan-out at that drop). Keeps every step
green/committable. Same locked end-state.

**★ MIGRATION TOOLING (sandbox-critical):** `db:generate` is PTY-interactive for
column renames → BLOCKED (no PTY). PROVEN workaround: hand-write SQL (DROP+CREATE
for clean cutover, no data), append `_journal.json` entry with `when` STRICTLY >
prior max (`0079`=1782777600003 → `0080`=…04 → `0081`=…05; real clock ~1782492…
is BEHIND, so drizzle's auto-`when` is non-monotonic — ALWAYS bump), JSON-surgery
`meta/NNNN_snapshot.json` (copy prev, edit the table, new `id`=uuid4, `prevId`=prev
`id`). VALIDATE by `pnpm db:generate` → "No schema changes". Additive tables don't
prompt → plain db:generate works (that's how 0080 was made).

**NEXT — #9 core (`resolveRunSessions` + portable consensus):**
- Add `resolveRunSessions` to `lib/acp-runners/resolve.ts` (reuse `snapshotRunner`/
  `assertLaunchableRunner`/`Candidate`; `RunnerResolution`). Per session in the
  compiled `FlowGraph.sessions` Map, precedence: ephemeral per-run override
  (tier `launchOverride`, src `launch-dialog`) → binding (Mapped
  `flow_runner_remaps` for the `session:<name>` slot_key, tier `binding`) →
  profile-ref that IS a platform runner id (tier `stepTarget`) → auto-match by
  intent `(capability_agent, model, provider.kind)` UNIQUE enabled+ready catalog
  runner (tier `autoMatch`) → **default session + no config ONLY**:
  `projectFlowDefault → platformFlowDefault → projectDefault → platformDefault` →
  else `EXECUTOR_UNAVAILABLE`. Out: N `{ sessionName, runnerId,
  runnerResolutionTier, capabilityAgent, runnerSnapshot, resolutionSource }`.
  Helpers: `resolveSlotConfig(slot, manifest.runner_profiles)` (deref ref),
  `autoMatchRunner(config, runners)`. Unit-test.
- Portable consensus: `lib/flows/graph/consensus/roles.ts`
  `resolveConsensusRoleRuntime` currently narrows `runnerSlotProfileRef(role.runner)`
  → direct `platformAcpRunners.id` lookup (the P1 shim). Make it resolve via
  binding (`consensus:<nodeId>:<participantId>` / `:synthesizer`) + auto-match.
- `enumerateRunnerSlots` already yields all slots — reuse for resolution.

**THEN #10→#24** (per plan): slot-keyed binding HTTP routes (validate slot_key ∈
revision slots, mapped_runner_id ∈ platform_acp_runners) → launch-options
per-session → supervisor `sessionName` (#25) → multi-session launch (atomic N
`run_sessions` in ONE tx, `git worktree add` BEFORE tx, spawn AFTER commit) →
runtime dispatch (per-node `session/resume`, judge on session runner,
`materializeNodeCapabilities` uses session runner's model not `loaded.executor.model`)
→ fan `run_sessions` to ALL creators + rule-11 reader fan-out + HITL/gate target
ACTIVE session + runner-delete guard → reconcile/resume/recover session-aware →
terminal closes ALL sessions → Studio UI (replace model field w/ runner picker;
consensus dropdown; connect-time binding screen) + EN/RU i18n → **#22 cross-repo
`/repos/maister-plugins` (SEPARATE repo — OPEN
release-order Q, ASK first)** + in-repo fixtures (`web/test-fixtures/aif-flows/*`,
`web/lib/flows/__tests__/_fixtures/*`, `web/lib/agents/__tests__/_fixtures/*`) →
e2e → #24 as-built flip + **migration 0082 (drop runs cols)** + renumber check vs main.

**rule-11 reader fan-out** (tsc lists them when 0082 drops the cols): `runs.ts`,
`runner-core.ts`, `runner-graph.ts`, `flows/runner-agent.ts` (:896-1170), `resume.ts`,
`recover.ts`, `runs/resume-recovery.ts` (:87 JOIN run_sessions), `reconcile.ts`,
`scratch-runs/service.ts`, `agents/launch.ts`, `consensus/drafts.ts`, `runs/promote.ts`
(close ALL), `workbench-lifecycle/service.ts` (close ALL), `services/gate-chat.ts`
(ACTIVE), `services/hitl.ts` (ACTIVE), `acp-runners/usage.ts`, UI reads
(`portfolio.ts`/`runs-list.ts`/`task-detail.ts`), `spawn-intent.ts`. `step_runs.acp_session_id` STAYS.

**GOTCHAS:** `node-tooltips.ts:65` is generic (`settings.model` any-node) → NO edit
(judge returns undefined, ai_coding keeps model). 2 PRE-EXISTING web.openapi
`nullable-type-sibling` errors (StudioAssistant/ADR-110, not mine). pgTable TS6387
+ IDE `@/lib` "cannot find module" + TS7044 = LSP/pre-existing noise (`pnpm
typecheck` exit 0 is truth). Commits OMIT Co-Authored-By (owner pref). Integration
tests via `dangerouslyDisableSandbox`→host docker (DOCKER_HOST). Live-agent e2e
(#23) needs owner env.
