# Project Roadmap

> MAIster — the control plane for AI-powered software delivery. Multi-project, multi-workspace web shell over ACP-driven agent execution, structured HITL, Flow-plugin engine, and per-project task boards.

## Milestones

- [x] **M0. Spike: ACP library + cross-process resume + codex parity** — completed 2026-05-25. Verdicts: (a) `@agentclientprotocol/claude-agent-acp@0.37.0` + `@agentclientprotocol/codex-acp@0.0.44` + `@agentclientprotocol/sdk@0.22.1` (Apache-2.0) — pin in `supervisor/package.json`; (b) cross-process `claude --resume <uuid>` verified live ("ALBATROSS-42" round-trip), sessions at `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`; (c) codex via `codex-acp` adapter binary (bundles `@openai/codex` 0.128+), supervisor spawn dispatches on `executor.agent`; (d) z.ai works as plain env-router (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` + `ANTHROPIC_AUTH_TOKEN`) — CCR is multi-provider intelligent routing, optional. Each respawn rebuilds ~$0.28 of cache_creation tokens, so 30-min keep-alive saves real money, not just UX.

- [x] **M1. Drizzle schema + Postgres** — tables `projects | tasks | runs | workspaces | hitl_requests | flows | executors`. New fields: `runs.executor_id`, `runs.acp_session_id`, `runs.flow_version`, `runs.checkpoint_at`, `tasks.attempt_number` UNIQUE per task. Docker compose for Postgres 16, migrations, seed. Shipped 2026-05-26 via `feature/poc-foundation`.

- [x] **M2. Core libs (errors, atomic, config v2)** — `MaisterError` taxonomy with new codes (`EXECUTOR_UNAVAILABLE`, `FLOW_INSTALL`, `ACP_PROTOCOL`, `CHECKPOINT`). `atomicWriteJson`. `maister.yaml` v2 loader (`project` + `executors[]` + `flows[]` with version pins). Flow manifest (`flow.yaml`) schema validator. Shipped 2026-05-26 via `feature/poc-foundation`.

- [x] **M3. Supervisor daemon (`supervisor/`)** — completed 2026-05-26 via `feature/m3-supervisor-daemon`. Separate Node package (`@maister/supervisor`) with Fastify + pino, pinned to `@agentclientprotocol/sdk@0.22.1`, `@agentclientprotocol/claude-agent-acp@0.37.0`, `@agentclientprotocol/codex-acp@0.0.44`. HTTP routes: `POST /sessions` (Zod-validated, 201 with sessionId+pid), `DELETE /sessions/:id` (SIGTERM → SIGKILL grace → 204), `GET /sessions/:id/stream` (SSE with monotonic ids + per-session ring buffer for `lastEventId`), `GET /sessions`, `POST /sessions/:id/checkpoint` (202 stub for M8), `POST /sessions/:id/input` (501 stub for M7). Process-per-session spawn dispatches on `executor.agent` (`claude-agent-acp` or `codex-acp`), stdio pipe/pipe/inherit, cwd=worktreePath, parallel write to `.maister/<slug>/runs/<id>/<step>.log`. Heartbeat watcher (exit/error handlers + 5s `process.kill(pid, 0)` orphan check) → `session.exited` or `session.crashed`. `cost.ts` lenient JSON-parses each stdout line and appends `cache_creation_input_tokens` / `input_tokens` / `output_tokens` to `cost.jsonl`. Web boundary at `web/lib/supervisor-client.ts` (server-only, fetch wrappers + async-generator SSE consumer, `MaisterError` translation). Promoted pnpm workspace to repo root; rewrote Dockerfile + compose for monorepo (single image, web/supervisor selected via `command:`). 105 tests green (30 supervisor unit, 9 integration, 66 web unit). Docs: `docs/supervisor.md` + getting-started + configuration updates.

- [x] **M4. Flow plugin loader** — shipped 2026-05-26 via `feature/m4-flow-plugin-loader`. `installFlowPlugin()` in `web/lib/flows.ts` runs the full pipeline: zod boundary validation (SAFE_PATH_SEGMENT + `.refine` no-`..`) → `git clone --branch <tag> --depth 1 --single-branch` into `~/.maister/flows/<id>@<tag>/` system cache (skips clone if `<target>/flow.yaml` already exists; 4 MB stdout buffer cap; 120 s AbortSignal timeout) → `loadFlowManifest()` validation → optional once-only `setup.sh` (60 s timeout; writes `.maister-setup-done` sentinel on success so re-installs skip; non-zero exit → WARN, no sentinel; AbortSignal → throw FLOW_INSTALL — POC trusts internal sources) → idempotent symlink `.maister/<slug>/flows/<id>/` (refuses to overwrite non-symlinks) → `INSERT … ON CONFLICT (project_id, flow_ref_id) DO UPDATE` (row id stable across version upgrades). In-process dedup map keyed by `projectId::flowId@version`. All failures wrapped as `MaisterError({code: "FLOW_INSTALL", cause})`. Ops CLI `pnpm install-flow --project <slug> --source <url> --version <tag> --flow-id <id>` for smoke-tests (uses an ESM loader shim to bypass `server-only` outside Next.js bundler). Tests: 36 new (28 flow-paths unit, 8 flows boundary unit, 7 flows integration) on top of existing 67 unit + 9 integration. Docs: `docs/flow-installer.md` + getting-started update.

- [x] **M5. Flow DSL parser + executor + aif plugin** — shipped 2026-05-27 via `feature/m5-flow-dsl-executor`. Step types `cli | agent | guard | human` walked by `web/lib/flows/runner.ts`. Mustache strict templating in `web/lib/flows/templating.ts` (undefined leaf → `MaisterError(CONFIG)`); `web/lib/flows/context.ts` builds `FlowContext` with env whitelist/blocklist + 8 KiB output truncation. Pre/post + standalone guards via `web/lib/flows/guards.ts` (observational on POC, metrics → `.maister/<slug>/runs/<id>/guards.jsonl`). Step-run store in new `step_runs` table (UNIQUE `(run_id, step_id, attempt)`, jsonb vars). CLI executor uses `bash -c` with AbortSignal timeout + 4 MiB maxBuffer. Agent executor in `web/lib/flows/runner-agent.ts` supports both modes; `slash-in-existing` reuses one supervisor session across steps via `AcpSessionState`. **Supervisor wire change**: `POST /sessions` body drops `prompt`; new `POST /sessions/:id/prompt` returns `{stopReason, meta?}`; new `session.update` + `session.permission_auto` SSE events; `requestPermission` auto-allows in M5 with WARN log (M7 replaces with HITL). ACP wire built on `@agentclientprotocol/sdk@0.22.1`'s `ClientSideConnection` in `supervisor/src/acp-client.ts`; supervisor tees stdout via `PassThrough` so `cost.ts` keeps consuming raw lines. `web/lib/worktree.ts` + `web/lib/scheduler.ts` (global cap = 3, env-tunable). `POST /api/runs` Route Handler validates preconditions, creates workspace+run rows in a transaction, runs `git worktree add`, claims a cap slot, kicks off `runFlow` background. Human step writes `needs-input.json` atomically and inserts `hitl_requests` row, transitions run to `NeedsInput`. **Second plugin shipped at `plugins/aif/`** (5 steps: `explore → plan → implement → fix → review` in slash-in-existing) — `installFlowPlugin()` gained an absolute-path / `file://` local-source path that fs-copies into the system cache (only when source is not a `.git` repo, so existing git-fixture tests stay on `git clone --branch <tag>`). ACP-conforming mock adapter at `web/lib/__tests__/_fixtures/mock-acp-adapter.mjs`. Dev CLI `pnpm --filter @maister/web run-flow --task <id>`. Tests: integration suite green (18 cases including end-to-end cli step + aif suspend at review + local-source install); 149 unit tests across `flows/__tests__/templating|context|guards|runner-cli|runner|step-runs` + flows local-source + supervisor-client `sendPrompt`. Docs: new `docs/flow-dsl.md` + `docs/flow-aif-plugin.md`, updated `docs/supervisor.md` + `docs/getting-started.md` + `docs/flow-installer.md`.

- [x] **M6. Executor registry: claude + codex + CCR** — shipped 2026-05-27 via `feature/m6-executor-registry`. Five-level override chain `launcher > task > flow override > project default > flow recommended` extracted to pure `resolveExecutor()` in `web/lib/executors.ts` (returns `{executorId, tier}`; callable with `override: undefined` for the M9 task-card computed-executor badge). New `upsertExecutorsFromConfig({projectId, config, db})` helper persists `maister.yaml executors[]` via `onConflictDoUpdate` and writes per-flow `executor_override` to the new nullable `flows.executor_override_id` FK column (`ON DELETE SET NULL`; additive migration `0002_safe_ma_gnuci.sql`). `web/scripts/seed.ts` and `web/lib/__tests__/foundation.integration.test.ts` now flow through the helper. `route.ts:resolveExecutor` removed; `POST /api/runs` logs `resolvedFromTier` alongside the existing INFO line. **Supervisor**: `@musistudio/claude-code-router@2.0.0` (MIT) added as exact-pin dep — bin discovered via workspace path. New `supervisor/src/ccr-manager.ts` singleton (`idle | starting | ready | failed | stopping` state machine, `ensureRunning` / `getProxyUrl` / `shutdown`); reads host+port from `~/.claude-code-router/config.json` (top-level `HOST`/`PORT`, defaults `127.0.0.1:3456`); env hatch `MAISTER_CCR_CONFIG_PATH` for tests. Health check is exponential-backoff `GET /` (configurable total, 10 s default). Wired into existing `main.ts` SIGTERM/SIGINT handler so the daemon dies with the supervisor. `spawn.ts` auto-injects `ANTHROPIC_BASE_URL=<proxy>` + `ANTHROPIC_AUTH_TOKEN` when `executor.router === "ccr"` — `ensureRunning()` runs first, then token resolves from `executor.env.ANTHROPIC_AUTH_TOKEN ?? MAISTER_CCR_AUTH_TOKEN`; missing token → `SupervisorError("EXECUTOR_UNAVAILABLE")`. Explicit `executor.env` still wins on key collision. `SpawnOverrides.ccrManager` injection point for tests. CCR config missing surfaces end-to-end as 503 `EXECUTOR_UNAVAILABLE` (existing supervisor-client translation + route.ts httpStatusForCode). Tests: 18 new web (8 unit + 7 integration for `upsertExecutorsFromConfig`/`resolveExecutor` chain coverage + 1 round-trip + 1 WARN-on-ghost-flow + 1 router=ccr DB round-trip), 22 new supervisor (10 unit + 4 integration for ccr-manager incl. health-check timeout + clean shutdown + restart-after-shutdown; 8 unit for spawn env precedence + 3 token-leak sentinels; 2 integration for end-to-end 503). Stub `mock-ccr.mjs` fixture + `write-ccr-config.ts` helper for hermetic CCR tests. Docs: `docs/system-analytics/executors.md` (5-level chain diagram + CCR setup section + computed-vs-launched contract), `docs/configuration.md` (`router: ccr` example + per-flow override + CCR bundling section), `docs/getting-started.md` (Optional CCR routing subsection), `docs/architecture.md` (Container/Component-level CCR daemon visibility, `lib/executors` row flipped to Implemented M6).

- [x] **M7. ACP integration + SSE bridge** — shipped 2026-05-28 via `feature/m7-acp-sse-bridge`. Supervisor: `PendingPermissionRegistry` (`supervisor/src/pending-permissions.ts`) with `register`/`resolve(optionId)`/`cancel(reason)`/`reject(err)`/`purgeSession`; per-deferred `MAISTER_KEEPALIVE_MINUTES` timeout → `HITL_TIMEOUT`. `requestPermission` mints v4 requestId, emits new `session.permission_request` SSE event with `{requestId, options, toolCall}`, awaits the deferred (auto-allow path deleted). Real `POST /sessions/:id/input` is permission-only with discriminated `action: "select" | "cancel"`; validation 409 PRECONDITION; missing session/requestId 404 NEEDS_INPUT; success 200. Structured `<stepId>.events.jsonl` writer (`supervisor/src/events-log.ts`) appends every SessionEvent in lockstep with ring buffer + SSE; closed on terminal events. `purgeSession` wired into session.exited/crashed and SIGTERM shutdown. Web: `supervisor-client.ts` mirrors the event union and adds `deliverPermission`/`cancelPermission` with HTTP-status-driven classification (404→`HITL_TIMEOUT` terminal, 5xx/network→`EXECUTOR_UNAVAILABLE` retryable). `runner-agent.ts` handles `session.permission_request` mid-stream: INSERT hitl_requests row with `schema={requestId, options, toolCall, supervisorSessionId}` + UPDATE runs→`NeedsInput`; insert-failure cancels supervisor deferred and transitions run→`Crashed` (Finding 3 fix). `runner-human.ts` resumes from existing `input-<stepId>.json` artifacts and differentiates `kind: "form" | "human"` via `on_reject`. `runner.ts` accepts `NeedsInput` as resume entry, re-uses existing step_run rows. NEW `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond` route with two-phase commit (Finding 2 fix): phase 1 stores user intent in `hitl_requests.response`; phase 2 calls `deliverPermission` and marks `respondedAt` only on supervisor ack; `HITL_TIMEOUT`→terminal `Failed` + 410, `EXECUTOR_UNAVAILABLE`→retryable 503. Form/human path: `atomicWriteJson` input artifact then commit + queueMicrotask(`runFlow`). NEW `GET /api/runs/[runId]/stream` Route Handler tails events.jsonl with Last-Event-ID resume and terminal-state close. `useRunStream` hook + dev fixture at `/dev/run-stream/[runId]`. Tests: 4 events-log unit + 9 pending-permissions unit + 2 spawn-events-log wiring = +15 supervisor unit (suite at 84 green); 12 supervisor permission-roundtrip integration cases. **Phase 3 unit-test backfill landed**: 40 new web unit cases (supervisor-client +11, runner-agent 6, runner-human 4, runner re-entry 3, HITL response route 16). Web unit suite at 208 green. **Adversarial review pass 2 (2026-05-28)** fixed under `feature/m7-acp-sse-bridge`: atomic claim model in the HITL response route (row-level FOR UPDATE + CAS for permission and form/human; conflicting payloads → 409 with no artifact write; same-payload retries → idempotent 200; supervisor 404 racing a concurrent winner → 200 instead of `runs→Failed`); schema validation of form/human response (`web/lib/flows/hitl-validate.ts`) before any state mutation (422 NEEDS_INPUT on failure); permission-persistence failure surfaced through `EventConsumer.permissionPersistFailure()` so `runAgentStep` returns `{ok:false, errorCode:"CRASH"}` and `runFlow`'s final transition cannot overwrite the crash with `Review`. Web tier API specs added: `docs/api/web.openapi.yaml` (POST /api/runs, POST /api/runs/{runId}/hitl/{hitlRequestId}/respond with the full retry-vs-terminal classification, GET /api/runs/{runId}/stream) and `docs/api/async/web-runs.asyncapi.yaml`. Supervisor OpenAPI/AsyncAPI already brought in sync (commit `91e691f`). **Remaining deferred follow-ups**: Phase 4 SSE bridge integration tests, and prose updates to `docs/error-taxonomy.md`/`docs/system-analytics/hitl.md`/`docs/system-analytics/runs.md`/`docs/flow-dsl.md`/`docs/database-schema.md`/`docs/configuration.md`. No new env vars in M7 — `MAISTER_KEEPALIVE_MINUTES` now drives both the supervisor's pending-permission deferred timeout and (in M8) the NeedsInputIdle keep-alive window.

- [x] **M8. Worker lifecycle: keep-alive + checkpoint + resume** — shipped 2026-05-29 via `feature/m8-worker-lifecycle`. T1 spike (mock-acp-adapter only — see `docs/kaa-maister-m8-spike-findings-20260529.md`) verifies the cancel-with-reason → SIGTERM → `--resume` → re-issue cycle end-to-end through the supervisor wire (`supervisor/src/__tests__/m8-resume-spike.integration.test.ts` passes). Supervisor: real `POST /sessions/:id/checkpoint` (`pendingPermissions.cancel(reason:"checkpoint")` + SIGTERM with grace + SIGKILL escalation → 500 `EXECUTOR_UNAVAILABLE`; idempotent 200 with `alreadyCheckpointed: true` for already-exited sessions); `session.exited` event gains optional `reason: "checkpoint" | "intentional"`; `cost.jsonl` entries from resumed sessions carry `resumed: true` (M0 cache-creation tax attribution). Web: state-transition helpers `web/lib/runs/state-transitions.ts` (`markCheckpointed`, `markResumed`, `bumpKeepalive`, `failResumedRun`, `crashResumedRun`); shared `keepalive-config.ts`; keep-alive sweeper singleton (`web/lib/runs/keepalive-sweeper.ts`, two passes — NeedsInput→NeedsInputIdle on `keepalive_until < now`, NeedsInputIdle→Abandoned on `checkpoint_at + MAISTER_NEEDSINPUTIDLE_TTL_HOURS < now`, per-tick LIMIT 50 / concurrency 4, booted via `instrumentation.ts`); `POST /api/runs/[runId]/activity` route (D6 identifier table: url-param `runId`, no body cross-resource ids; 204 / 409 idle / 410 terminal / 400 bad UUID / 404 missing); client `useActivityPing` hook (mount + visibilitychange + focus + debounced keystroke/pointer-down + heartbeat at `MAISTER_KEEPALIVE_MINUTES/2`); `resumeRun(runId)` helper (server-state-only locators per D7; failure classification: 5xx/network→`EXECUTOR_UNAVAILABLE` retryable, 400/404/empty-acpSessionId→`CHECKPOINT` terminal → Failed via `failResumedRun`); HITL `/respond` idle branch (D8 two-phase commit: phase 1 M7 CAS, phase 2 `resumeRun`, returns 202 `{state:"resume-in-progress"}` after spawn ack, 503 retryable on `EXECUTOR_UNAVAILABLE`, 410 terminal on `CHECKPOINT`); runner-agent auto-deliver on resumed session (`tryAutoDeliverStoredIntent` checks for open `hitl_requests` with response set + respondedAt null, auto-delivers against the new requestId, marks original respondedAt with audit `{originalRequestId, reissuedRequestId, deliveredViaResume: true}`); scheduler `releaseSlotOnIdle` for sweeper-driven `promoteNextPending`; the cap is now `count(status IN ('Running','NeedsInput'))` exactly — `NeedsInputIdle` does NOT count and resumes bypass the cap. Three new env vars (`MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS=30`, `MAISTER_NEEDSINPUTIDLE_TTL_HOURS=24`, `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS=60`) in `.env.example` + `compose.yml`; `MAISTER_KEEPALIVE_MINUTES` re-scoped to both supervisor and web service. Docs: `docs/supervisor.md` real checkpoint contract + "Checkpoint + Resume lifecycle" section; `docs/system-analytics/runs.md` M8 state-transition diagram + "Keep-alive sliding window" + "Idle sweeper + scheduler interaction"; `docs/system-analytics/hitl.md` live vs idle branch flowchart + two-phase commit table + idempotency / failure-classification tables; `docs/configuration.md` new env-var rows + updated semantics + "Cost tracking on resume" subsection; `docs/error-taxonomy.md` `CHECKPOINT` matrix activated, `EXECUTOR_UNAVAILABLE` extended with sweeper + idle-branch callers, `HITL_TIMEOUT` clarified as NOT raised on idle→Abandoned; `docs/api/supervisor.openapi.yaml` real `200/404/409/500` + `CheckpointResponse` component; `docs/api/async/supervisor-sse.asyncapi.yaml` `session.exited.reason` optional field; `docs/api/web.openapi.yaml` `POST /api/runs/{runId}/activity` and `/respond` idle-branch 202/410 documented. Tests: +6 supervisor unit (checkpoint endpoint + `requestIds`), +1 supervisor integration (M8 resume spike), +5 web unit (supervisor-client M8 CheckpointResponse), +11 web unit (activity route). Scheduler and state-transitions integration tests are in place (`web/lib/__tests__/scheduler.integration.test.ts`, `web/lib/runs/__tests__/state-transitions.integration.test.ts`) and execute on Docker-enabled CI; local dev box does not have Docker available. **Deferred follow-ups** (queued for post-M8 patches): runner-agent resume-prompt watchdog enforcement (helper `crashResumedRun` exists; env var `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` is wired through `.env.example` / compose / docs but the runner-agent timeout loop is not yet armed); `useActivityPing` jsdom unit tests (needs `@testing-library/react` install); `web-runs.asyncapi.yaml` `reason` pass-through (mechanical mirror of supervisor SSE spec); full web-tier Pending → … → Review E2E lifecycle integration test; richer abandon-reason audit column on `hitl_requests` (schema migration deferred).

- [x] **M9. Web UI core: registry + portfolio + board + auth + RU i18n** — shipped 2026-05-29. Replaced HeroUI template stubs with a themed login page, portfolio home, projects list, Add-Project form, and per-project board (Backlog / Prepare / In Delivery / In Review columns). Auth.js v5 credentials-only authentication with Drizzle adapter; global roles (`admin | member | viewer`) and per-project roles (`owner | admin | member | viewer`) enforced by `lib/authz.ts`; middleware protects all `(app)` routes. EN+RU via next-intl with cookie-based locale switching. Forest design-token system (light/dark via next-themes `class`). New tables: `users`, `accounts`, `sessions`, `verification_tokens`, `project_members`; new column `tasks.stage`; migration `0004_petite_gamora.sql`. New routes `POST /api/projects` (admin-only) and `POST /api/projects/{slug}/tasks` (member+); existing routes `POST /api/runs`, `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond`, and `GET /api/runs/{runId}/stream` gained RBAC guards.

- [x] **M10. Flow package lifecycle and distribution UX** — shipped 2026-05-30. Promotes Flows from "git repos the loader clones" (M4) to managed, multi-revision delivery packages. New `flow_revisions` table (`web/lib/db/schema.ts`): global, immutable, content-addressed by `(flow_ref_id, resolved_revision)`, carrying `source`, `versionLabel`, `resolvedRevision` (git SHA), `manifestDigest`, full `manifest` jsonb, `schemaVersion`, `engineMin`/`engineMax`, declared `contract` jsonb, `installedPath`, `setupStatus` (`not_required|pending|done|failed`), `packageStatus` (`Discovered|Installing|Installed|Failed|Removed`), `installedAt`. `flows` gains `enabled_revision_id` FK (project enablement pointer, kept separate from the revision rows), `trustStatus` (`untrusted|trusted|trusted_by_policy`), `enablementState` (`Installed|Enabled|UpdateAvailable|Deprecated|Disabled|Failed`); additive migration `0007_fast_misty_knight.sql` (renumbered from 0006 after rebase onto main, `fc00c5d`). Two-phase install in `web/lib/flows.ts` (`ensureRevisionIntentRow` → finalize): intent row `Installing` → `Installed`, with digest/manifest/contract populated only after `flow.yaml` validation; revision-aware loader + trust policy in `web/lib/flows/trust.ts` + `engine-version.ts`. Lifecycle service `web/lib/flows/lifecycle.ts`: `enableRevision` (atomic enabled-pointer switch under row lock), `upgradeFlow` (→ `UpdateAvailable`), `rollbackFlow` (delegates to enable), `disableFlow`, `removeRevision` (refuses with `CONFLICT` while any `runs.flow_revision_id` or `flows.enabled_revision_id` references it), and `UpgradePreview` diffing steps/gates/artifacts/capabilities/external-ops plus schema/setup changes. Launch preconditions in `web/app/api/runs/route.ts` refuse (`PRECONDITION` 409) when no enabled revision, `enablementState` not in `{Enabled, UpdateAvailable}`, `trustStatus = untrusted`, revision not `Installed`, `setupStatus` `pending|failed`, or schema/engine incompatible; launch then snapshots `flowRevisionId`, and `web/lib/flows/runner.ts` resolves the pinned revision's manifest/path so upgrade/rollback/disable never corrupt in-flight or completed runs. Settings UI `web/components/board/panels/flow-packages-panel.tsx` + `package-actions.tsx` (admin-gated install/enable/disable/upgrade/upgrade-preview/rollback/trust/remove) over `web/app/api/projects/[slug]/flow-packages/*` routes and `web/lib/queries/flow-packages.ts`; EN+RU i18n. `FLOW_INSTALL` errors are stage-tagged (`clone|resolve-revision|validate-manifest|intent|finalize`) with source, version, exit status, and captured stderr. Adversarial-review pass fixed setup-runs-only-after-trust, atomic enable/remove races, and setup-failure → `Failed`. Docs: ADR-021 (`docs/decisions.md`) + `docs/system-analytics/flow-packages.md`. Tests: revision-coexistence upgrade (v1.0.0 → v1.1.0), launch/trust precondition + remove-guard cases, plus the app integration suite. **Deferred follow-ups**: `Deprecated` enablement-state UI wiring, the `Discovered` external-tooling state, `Failed` enablement-state not yet actively set, and automatic GC of unreferenced `Removed` revisions (→ M19).

- [x] **M11a. Flow graph v1: node lifecycle, run ledger, review-driven rework, gates** — shipped 2026-05-31. The execution-model foundation. Replace the strictly linear `steps[]` walker (with recorded-but-unexecuted `on_reject.goto_step`) with a validated Flow graph v1; linear Flows stay valid by compiling to single-action nodes. First slice of the split M11 ([ADR-029](decisions.md#adr-029-split-m11-into-m11a--m11b--m11c)). Manual takeover + timeline → M11b; typed node settings + enforcement → M11c. **As-built** (`f97a327`…`b3b2227`): graph schema + exactly-one `steps`/`nodes` `.refine` and `MAISTER_ENGINE_VERSION` bump `1.0.0 → 1.1.0` (`web/lib/config.schema.ts`, `web/lib/flows/engine-version.ts`); `validateGraphManifest` rejecting unknown node/gate ids, dup ids, unknown gate kinds, cycles without `rework.maxLoops`, both/neither `steps`/`nodes`, and graph flows without `compat.engine_min ≥ 1.1.0` (`web/lib/config.ts`); additive migration `0010_m11a_graph_ledger.sql` adding append-only `node_attempts` (PascalCase status) + `gate_results` (lowercase status); graph compiler + runner (`web/lib/flows/graph/{compile,runner-core,runner-graph,ledger,gate-store,gates-exec}.ts`) dispatched from `web/lib/flows/runner.ts`, with linear `steps[]` Flows preserved (NOT re-routed through the graph) and the templating union reading `node_attempts` over `step_runs`; gate engine executing `command_check`/`ai_judgment`/`human_review`, `skill_check` best-effort, `artifact_required`(M12)+`external_check`(M16) schema-valid but stubbed, with structured verdicts, blocking/advisory modes, staleness propagation, and override-without-erasure; review-driven rework via a server-state allow-list (`web/lib/flows/hitl-validate.ts` + the `respond` route persisting `decision`/`workspace_policy`/`rework_target` before any mutation) with `commentsVar` injection into the rework target; the bundled `aif` Flow migrated to `nodes[]` (`plugins/aif/flow.yaml`); the review HITL UI (approve / request-rework + comments) + board `reworking` indicator + EN/RU i18n; and a seeded, authenticated Playwright e2e (`web/e2e/m11a-review-rework.spec.ts`, dedicated `maister_e2e` DB). Verified via vitest unit + portfolio integration + `pnpm test:e2e` (m11a authed specs green). **Deferred**: idle-checkpoint resume of graph runs; M11b (manual takeover + timeline) and M11c (typed node `settings` enforcement; `SETTINGS_NOT_ENFORCED_WARN` removal); `artifact_required`/`external_check` execution (M12/M16); promotion-gating readiness policy (M15).

  **Expectation: node lifecycle compile.** A node has `input` / `action` (`ai_coding`/`cli`/`check`/`judge`/`human`) / `pre_finish` (gates) / `finish` (auto or human) / `transitions` / `rework`. An optional top-level `nodes[]` is mutually exclusive with `steps[]` (`schemaVersion: 1` unchanged; graph flows declare `compat.engine_min: 1.1.0`; engine const bumped `1.0.0→1.1.0`). Existing `steps[]` flows compile to single-action nodes with default `transitions.success → next` and no rework ([ADR-026](decisions.md#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump)).

  **Expectation: append-only run ledger.** A new `node_attempts` table records every node execution as an immutable row (`attempt` auto-increments per `(run, node)`); rework never mutates prior rows. `step_runs` is retained for legacy reads; templating resolves highest-attempt-wins ([ADR-027](decisions.md#adr-027-append-only-node_attempts-run-ledger)).

  **Expectation: review-driven rework.** Human review chooses a Flow-declared decision (not a raw `goto_step`) validated against a server-state allow-list; rework marks downstream gates stale, moves the node pointer back within `Running`, and reruns the validation path before a fresh review. Rework is a node-pointer move — **no `HumanWorking`** status in M11a.

  **Expectation: full-featured gate execution** ([ADR-028](decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)). `command_check`/`ai_judgment`/`human_review` execute; `skill_check` runs best-effort (no capability scoping until M14); `artifact_required` (M12) and `external_check` (M16) are schema-valid + status-modelled but stubbed. Full status lifecycle (`pending|running|passed|failed|stale|skipped|overridden`), `blocking|advisory` modes, structured verdicts, staleness propagation, and override-without-erasure are real. Gate results **feed but do not gate promotion** (that is M15/M18).

  **Acceptance criteria:**

  - Linear back-compat: a `steps[]`-only manifest needs no graph syntax and runs to `Review` exactly as today.
  - Graph validation rejects unknown node ids (in `transitions`/`rework.allowedTargets`/`staleFrom`/`input.requires`), duplicate node/gate ids, unknown gate kinds, cycles without `rework.maxLoops`, unsupported workspace policies, human decisions targeting undeclared transitions, both/neither of `steps`/`nodes`, and graph flows without `compat.engine_min ≥ 1.1.0`. (Unknown **role** refs → M13; MCP/tool/skill/agent/restriction refs → M14; node-level **executor** refs → M11c.)
  - A graph Flow executes `plan → implement → checks → judge → review`, rejects from review back to `implement` with comments, marks `checks`/`judge` stale and reruns them, then reaches a fresh review gate.
  - Gates execute with `blocking`/`advisory` modes, structured verdicts, the full status lifecycle, staleness propagation, and override-without-erasure.
  - Every node execution is an immutable `node_attempts` row; rework never mutates prior rows; templating resolves highest-attempt-wins.
  - A graph flow on an `untrusted` revision never runs a gate command/agent (launch refused first).
  - The bundled `aif` Flow is migrated to `nodes[]` and demonstrates review-driven rework.
  - Docs cover the graph schema, run ledger, rework semantics, and backwards compatibility.

- [x] **M11b. Manual takeover + run-detail timeline** — shipped 2026-05-31. Second slice of the split M11. Local-worktree human takeover (consistent with [ADR-011](decisions.md#adr-011-workspace-lifecycle-via-git-worktree)) plus the rich run-detail timeline. Depends on M11a. **As-built** (`3016a75`…`1d79e94`): [ADR-030](decisions.md#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status); real `HumanWorking` run status (migration `0011`, counts toward the global cap, excluded from the crash-recovery sweep) + `node_attempts` takeover columns (`owner_user_id`/`base_ref`/`returned_commits`/`returned_diff`); read-only worktree git ops `logRange`/`diffRange`/`resolveBaseRef` (`web/lib/worktree.ts`, `--end-of-options`-hardened); `POST /api/runs/{runId}/takeover/{claim,return}` (claim = NeedsInput→HumanWorking on a `human_review` node offering `takeover`; return = two-phase commit — git ops then a single-transaction `recordTakeoverReturn`+`markDownstreamStale([reentry, …downstreamOf])` then the AFTER-side `Running` flip, owner-gated, empty body / server-derived refs) + an `abandon` route + `markAbandoned`; a runner resume gate that resumes a returned `Running` run at `current_step_id` (the `transitions.takeover` re-entry `checks`) — never `graph.entry` — under its own CAS claim (no clobber of the human's edits), plus an idempotent startup re-dispatch sweep for a return stranded by process death; the single run-detail timeline (`getRunTimeline`, current-vs-stale gates + handoff block with returned diff in a `<pre>`) + take-over/return UI; the board `HumanWorking` card (owner/elapsed/branch/return, distinct from running, no regression to the M11a `reworking` indicator) + EN/RU i18n; the `aif` Flow's `review` node wiring `takeover → checks`; and a seeded, real-worktree, authenticated Playwright e2e (`web/e2e/m11b-takeover.spec.ts`: claim→board→commit→return→diff→stale→rerun→fresh-review). Verified: typecheck 0, unit 617, integration 167, m11a+m11b authed e2e green; SDD spec-freeze + per-phase implementor→reviewer review (Codex adversarial pass on the Phase-0 contract). **Deferred**: typed `commit_set`/`diff` artifact instances + evidence-graph explorer (M12); `human_edit`/`merge` node types + PR/target promotion (M18); role-restricted / over-stale-takeover claim (M13); node typed `settings` enforcement (M11c).

  **Expectation: manual takeover.** A reviewer claims a task from the MAIster UI, is handed the run's **existing** worktree + branch (no new branch is created — local handoff per [ADR-011](decisions.md#adr-011-workspace-lifecycle-via-git-worktree)/[ADR-030](decisions.md#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status)), works locally, commits changes locally (no push/remote), then returns the run through the UI. The run enters a `HumanWorking` surface; the board shows owner, elapsed time, branch, and pending return action. On return, MAIster imports the commits, records a returned diff, marks downstream gates stale, and resumes with the Flow-declared validation path. Workspace policies `rewind-to-node-checkpoint` / `fresh-attempt` (recorded in M11a) execute here.

  **Expectation: run-detail timeline.** Run detail distinguishes current vs stale gates and shows all node attempts, decisions, checkpoints, handoffs, returned commits, and rerun results in one timeline.

  **Acceptance criteria:**

  - Manual takeover moves a run into `HumanWorking`, exposes the handoff branch and owner on the board, imports returned commits, shows the returned diff, and forces downstream checks/judges/user-review to rerun.
  - Run detail UI distinguishes current vs stale gates and shows all node attempts, decisions, checkpoints, handoffs, returned commits, and rerun results in one timeline.
  - The bundled `aif` Flow demonstrates manual takeover.
  - Docs cover manual takeover semantics.

- [x] **M11c. Node typed settings + runtime enforcement boundary** — shipped 2026-06-01. Third slice of the split M11. Every node type gets a typed `settings` section validated at the manifest level, with a launch-time **refusal boundary** (no positive materialized enforcement until M14); anticipates the M14 capability registry. Depends on M11a (which parsed `settings` as an opaque passthrough with a one-time `SETTINGS_NOT_ENFORCED_WARN`). Carves criterion #6 ([ADR-031](decisions.md#adr-031-node-typed-settings-schema-carve-b)/[ADR-032](decisions.md#adr-032-settings-enforcement-refusal-boundary)): **M11c owns the "settings visible in UI + launch-time REFUSAL boundary" half; M14 owns the "materialized positive enforcement / flip classes `instructed`→`enforced`" half.** #6 is NOT fully done after M11c — MCP/tool/skill/restriction classes are only refused-if-`strict`, never materially constrained until M14. Also inherits the node-settings-schema half of criterion #8 (docs). **As-built** (`c0084f1`…`0daaa88`): ADR-031 (typed settings, carve (b)) + ADR-032 (refusal boundary, static `ENFORCEABILITY_BY_AGENT`, CONFIG/EXECUTOR_UNAVAILABLE, no new error code, web-side time-limit watchdog); typed per-node-type discriminated `settings` schema replacing the M11a passthrough and **removing** `SETTINGS_NOT_ENFORCED_WARN` (`web/lib/config.schema.ts`, `web/lib/config.ts`); node-level validation (executor-ref / human-`decisions`-vs-`transitions` / enum / bound) → `CONFIG`; pure evaluator + `assertNodeLaunchable` (`web/lib/flows/enforcement.ts`) with the conservative all-`instructed` table (every `strict` → refused; `permissionMode` spike not verified, so no `enforced` cell); launch precondition in `POST /api/runs` (after executor resolution, before worktree) + per-node runtime gate in `runner-graph.ts` (refusal marks the `node_attempts` row `Failed`, no agent spawned → no leaked deferred); append-only `node_attempts.enforcement_snapshot` (migration `0013`) written on pass + refusal; web-side time-limit watchdog (`limits.maxDurationMinutes` → supervisor `DELETE`, node `Failed` with `PRECONDITION`; cost stays record-only); run-detail `FlowSettingsPanel` tagging each class enforced/instructed/refused + board "settings refused" card badge + EN/RU i18n (no secret leakage); `aif` `implement` node migrated to an all-`instruct` settings block + strict-refusal/greet fixtures; seeded authenticated Playwright e2e (`web/e2e/m11c-settings-enforcement.spec.ts`: settings-visible + strict-refusal). Verified: typecheck 0, unit 815, integration 191, full e2e 11/11, `pnpm validate:docs:all` 86/86. SDD spec-freeze (Phase 0 froze `ENFORCEABILITY_BY_AGENT` + the `evaluateNodeEnforcement` truth table in `docs/system-analytics/flow-settings.md`) + per-phase tester→implementor→reviewer TDD. **Deferred to M14**: the capability registry, import-from-git resolved SHA, agent-aware mapping resolution, per-session materialization, flipping classes `instructed`→`enforced`, and registry-ref validation (the rest of criterion #6 + the #1 capability-ref subset). Human role refs → M13. Cost-cap kill-on-cap → Phase 2.

  **Expectation: node-specific settings.** AI-coding nodes declare allowed executors/agent definitions, model/thinking-effort constraints, MCP servers, tools (agent-aware mappings), shipped skills, workspace/artifact access, permission mode, cost/time limits, and explicit restrictions. Human nodes declare roles/assignees, allowed decisions, further-track/takeover permission, SLA/staleness hints, return requirements. CLI/check/judge nodes declare commands, timeout, env policy, artifact I/O, failure classification.

  **Expectation: enforcement boundary (refusal slice; positive enforcement → M14).** The typed `settings` schema replaces the M11a opaque passthrough; each capability-bearing setting carries a declared `enforcement` intent (`strict | instruct | off`). At launch, a node declaring `enforcement: strict` on a capability class the build cannot strictly enforce (static `ENFORCEABILITY_BY_AGENT` table — every M14-materialized class is conservatively `instructed`) is **refused** (`CONFIG`/`EXECUTOR_UNAVAILABLE`, no silent fallback); settings are surfaced in the run-detail UI as `enforced/instructed/refused`. Node-level **executor** refs (`settings.executors`) are validated against `maister.yaml executors[]` (config-state, resolvable via the M6 override chain without the M14 registry). **Materialized positive enforcement** (writing per-session `settings.json`/MCP config/skills, flipping classes `instructed`→`enforced`) and **capability-registry refs** (MCPs/tools/skills/agents/restrictions) are validated/materialized in M14.

  **Acceptance criteria:**

  - Manifest validation rejects unknown node-level executor refs (`settings.executors` against `maister.yaml executors[]`) plus node-settings shape (enum/bound/`enforcement`/human-`decisions`-vs-`transitions`). This is the node-settings-shape + node-level-executor-ref slice of criterion #1; the MCP/tool/skill/agent/restriction _registry-ref_ subset of #1 stays → M14, the human _role_ refs subset stays → M13.
  - AI node settings are visible in the UI and a launch-time refusal boundary blocks any undeclared-as-enforceable `enforcement: strict` escape hatch (criterion #6 refusal/visibility slice). Materialized positive enforcement (`instructed`→`enforced`) stays → M14; #6 is not fully complete until then.
  - The opaque `settings` passthrough from M11a is replaced by typed validation; `SETTINGS_NOT_ENFORCED_WARN` is removed.
  - Docs cover the node settings schema (criterion #8 node-settings-docs half).

- [x] **M12. Typed artifacts and evidence graph** — make Flow
      inputs/outputs first-class runtime objects, stored as typed metadata with
      filesystem/git payloads. This is the review backbone: artifacts are not just
      files, they are evidence that a run is ready or not ready.

  **As-built (shipped 2026-06-02):** schema migration `0017` + `artifact-store`,
  runner-inline recording + the ADR-022/ADR-038 projector, manifest validation
  (`produces`/`requires`/`artifact_required`, engine 1.2.0), staleness FSM +
  blocking `artifact_required` review-refusal, path-confined `artifacts` +
  `artifacts/[id]/payload` API routes, the React Flow evidence-graph explorer +
  the board merge-blocked/evidence-stale badge, and the bundled `aif` manifest
  migrated to engine 1.2.0. ADRs 037/038/039 (renumbered from 033/034/035 after
  M19 claimed 033..036; migration renumbered 0015 → 0017 on the same rebase).

  **Expectation: Flow-declared artifacts.** Nodes can declare required inputs
  and produced outputs with `id`, `kind`, optional schema, path/ref, visibility,
  retention, and whether the artifact is required for review or merge. Initial
  artifact kinds are `diff`, `log`, `test_report`, `lint_report`,
  `ai_judgment`, `human_note`, `commit_set`, `checkpoint`, `preview`, and
  `generic_file`.

  **Expectation: artifact instances.** Runtime records immutable artifact
  instances for every node attempt: run id, node id, attempt, producer,
  artifact definition id, kind, uri/path, hash, size, created time, and
  validity state (`current | stale | superseded | failed | skipped`). Payloads
  remain in the run directory, worktree, or git repository; the database stores
  the queryable evidence index.

  **Expectation: evidence graph explorer.** Run detail includes an artifact
  graph view that shows task inputs, node attempts, produced artifacts, gates,
  human decisions, returned commits, stale/current status, and dependency edges.
  The graph is an explorer, not a Flow designer: the user can inspect, filter,
  open raw payloads, and understand why merge is blocked or allowed.

  **Expectation: staleness semantics.** Rework, rewind, fresh attempts, and
  manual takeover returns mark downstream artifacts and gates stale from the
  selected handoff point. New successful node attempts supersede old artifacts
  from the same node but never erase history.

  **Acceptance criteria:**

  - Flow validation rejects duplicate artifact ids, unknown required inputs,
    unsupported artifact kinds, invalid artifact paths/refs, and merge-required
    artifacts that no node can produce.
  - Existing linear v1 Flows record default artifacts for logs, guard metrics,
    human/form answers, and generated diffs without requiring graph syntax.
  - A graph Flow can declare required inputs and produced outputs per node;
    missing required inputs fail before action execution, and missing required
    outputs fail before the node finishes.
  - Rework or manual takeover return marks downstream artifacts stale; review
    and merge refuse when required evidence is missing, stale, failed, or
    skipped.
  - The artifact graph explorer renders node attempts and artifacts with
    current/stale/superseded states, supports filtering by node/kind/state, and
    opens raw payloads from the run directory or git diff.
  - Manual takeover return records a `commit_set` artifact and a returned
    `diff` artifact before rerunning downstream validation.
  - Artifact metadata survives process restart; the UI can explain run evidence
    without rescanning arbitrary worktree state.
  - Deferred explicitly: content-addressed blob store, artifact marketplace,
    benchmark dataset management, rich preview sandboxing, cross-run artifact
    reuse, full payload-schema validation for every artifact, and external
    artifact ingestion beyond M16's generic gate report contract.
  - Architecture note: artifact instances are written by the same web-side
    **projector** that derives them from the supervisor event stream — see ADR-022.

- [x] **M13. Role-owned work queue and assignment UX** — make human work
      visible and claimable across board, inbox, run detail, and manual takeover.
      This is not RBAC. For the current target, roles are Flow/project routing
      labels and ownership signals that make paused work obvious. Any project
      teammate may claim, respond, return, or merge; MAIster records who acted but
      does not block actions by role.

  **As-built (shipped 2026-06-02):** ADR-040, `maister.yaml flow_roles[]`,
  migration `0018`, `project_flow_roles`, non-human-capable
  `actor_identities`, `assignments`, and append-only `assignment_events`;
  launch-time Flow role validation against active project roles; runtime
  assignment creation for ACP permission HITL, linear form/human HITL, graph
  `human_review`, manual takeover, merge-conflict waits, and terminal cleanup;
  assignment claim/release/take-over APIs; HITL respond auto-claim and
  conflict handling; manual takeover return completes assignments after M12
  `commit_set`/`diff` artifacts; portfolio/project/run-detail assignment
  read models and EN/RU UI strings; run-detail assignment ledger history.
  Verified with focused unit tests, M13 Playwright, and docs validation; local
  Docker/Testcontainers availability is still required for the Postgres
  integration lane.

  **Expectation: role registry.** Projects can define roles such as
  `owner`, `reviewer`, `maintainer`, `qa`, and `release-owner`. Flow human
  nodes reference roles from that registry. In the solo-user target, and in
  early team usage, roles are labels only: they explain why the task is waiting
  and who picked it up, but do not restrict who can perform the action.

  **Expectation: assignment object.** Every human decision, form answer,
  review gate, manual takeover, conflict resolution, and later external hook
  wait creates an assignment with task, run, node, role, optional assignee,
  action kind, status, created time, claimed time, returned/responded time,
  SLA hint, branch/ref when relevant, and current/stale evidence summary.

  **Expectation: board and inbox UX.** The project board and portfolio inbox
  show who owns the next action, how long it has been waiting, what action is
  required, which branch is involved, and whether downstream evidence is stale.
  A task card in human work must not look like a normal running task.

  **Expectation: claim/return semantics.** Claiming is atomic and idempotent
  for the same actor. Another project teammate may deliberately take over or
  release stale work, and the ledger records that transfer. Conflicting
  simultaneous responses or branch returns are rejected with a typed conflict.
  Returning a manual takeover updates the assignment, records artifacts through
  M12, and resumes the M11a validation path.

  **Acceptance criteria:**

  - Flow validation rejects human nodes that reference unknown project roles.
  - Runtime creates assignments for `permission`, `form`, `human`,
    `human_review`, manual takeover, merge-conflict/manual-resolution waits.
  - Board cards and portfolio inbox display role, assignee or unclaimed state,
    elapsed time, action kind, branch/ref, and stale-evidence summary.
  - A user can claim, release, respond, and return assigned work from the UI;
    each transition is appended to the run ledger.
  - Any project teammate can act on any assignment; role mismatch never blocks
    the action in this milestone.
  - Manual takeover assignments expose checkout instructions and return action,
    then close only after returned commits/diff are recorded as artifacts.
  - Completed, cancelled, stale, and superseded assignments remain visible in
    run history but no longer appear as actionable inbox items.
  - Deferred explicitly: RBAC, project membership permissions, role-based
    action blocking, `human_edit` nodes (M18), external hook waits (M16),
    escalation calendars, notifications, external board sync, and org/team
    administration.

- [ ] **M14. Scoped capability materialization** — make node and session
      settings executable by giving MCP servers, skills, settings files, tools,
      agent definitions, restrictions, and Flow-shipped resources a project-visible
      registry plus runner-owned materialization. This turns M11c node settings from
      descriptive YAML into enforceable runtime boundaries where the adapter
      supports enforcement.

  **Expectation: capability registry.** Projects expose named capability
  records for MCP servers, skills, agent definitions, tool profiles,
  agent settings profiles, environment profiles, and restriction policies.
  Records include id, kind, source, version or revision when external,
  supported agents, install status, trust status, and enforceability
  (`enforced | instructed | unsupported`).

  **Expectation: skill and capability import.** A project can install skills or
  capability packs from a pinned git URL/tag or local path. Install records the
  resolved commit SHA, manifest metadata, shipped files, and setup outcome.
  Imports are project-scoped unless explicitly promoted to the system cache.

  **Expectation: agent-aware mapping.** Abstract Flow refs such as
  `tools: [shell, edit]` or `mcps: [github]` resolve through an agent-aware
  mapping before execution. Claude, Codex, and future agents may use different
  concrete tool names or config files, but the Flow author references the same
  capability ids.

  **Expectation: scoped materialization.** The Flow runner owns capability
  scope. For a fresh per-node agent session, it materializes that node's allowed
  skills, MCP config, adapter `settings.json` or equivalent settings file,
  environment profile, and tool restrictions before the node starts, then
  removes/restores them after the node completes. For a long-living ACP session,
  those same files are session-wide: every AI node inside that session must use
  the same resolved capability profile, or the Flow must declare a new session
  boundary. Cleanup happens when the session scope ends. Cleanup failures are
  explicit runner errors, not ignored warnings.

  **Expectation: trust/install UX.** Flow or capability install shows source,
  version, resolved revision, setup script presence, requested MCPs/tools,
  shipped skills/agents, and restrictions before first use. Current target may
  trust project-owned sources, but third-party sources must be visually marked
  and require explicit install confirmation.

  **Expectation: runtime enforcement boundary.** Before a node runs, MAIster
  builds the per-node agent environment from resolved capabilities only. If a
  node requires strict enforcement for a capability that is only `instructed`
  or `unsupported` for the selected executor, launch fails with `CONFIG` or
  `EXECUTOR_UNAVAILABLE`; silent fallback is forbidden. If an existing ACP
  session cannot safely swap to a different capability profile, the runner must
  start a fresh session at a declared boundary or reject the Flow/executor
  combination.

  **Acceptance criteria:**

  - Project config can declare capability records and Flow node settings can
    reference them by id.
  - Flow validation rejects unknown MCPs, tools, skills, agents, restriction
    policies, environment profiles, and unsupported agent/capability mappings.
  - Importing a skill/capability pack from git records source, tag, resolved
    SHA, manifest, setup status, and trust status.
  - Before each AI session scope starts, the runner writes a materialization
    plan for skills, MCP config, settings file, env profile, and tool
    restrictions, then records it in the run ledger.
  - For one-node sessions, the materialization plan may be node-scoped. For
    long-living sessions, every AI node in the session validates against the
    same profile.
  - After each AI session scope reaches a terminal outcome, the runner removes
    or restores every materialized skill/settings/MCP artifact, including
    failure and cancellation paths.
  - Run detail shows the resolved capability profile for each AI-coding node,
    including what was enforced, instructed, or refused.
  - Runtime starts agent sessions with only the resolved MCP/tool/skill/settings
    profile for that session and logs the profile id without leaking secrets.
  - Long-living session reuse is allowed only when all AI nodes inside the
    session use the same materialized capability profile, or the adapter
    supports safe profile swap and the Flow declares where it happens.
  - Capability changes after a run starts do not mutate that run; the run
    snapshots resolved capability revisions in its ledger.
  - The bundled `aif` Flow declares its required skills/tools through the
    registry and runs without hidden out-of-band capability assumptions.
  - Deferred explicitly: public marketplace, remote rating/reputation,
    automated malicious-code scanning, container sandboxing, organization-wide
    capability policy, and cross-project capability promotion workflows.

- [x] **M15. Readiness policy and verdict calibration** — make readiness an
      explicit Flow-distributed contract that decides when a run may promote.
      **Re-scoped ([ADR-028](decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)):**
      gate _execution_ — the six gate kinds, the `pending|running|passed|failed|stale|skipped|overridden`
      status lifecycle, `blocking|advisory` modes, structured verdicts, staleness
      propagation, and override-without-erasure — moved to **M11a**. M15 keeps only
      the readiness-policy DSL, verdict calibration, and `external_check` ingestion.

  **Expectation: readiness policy decides promotion.** A run can move forward,
  enter review, or merge only when its Flow-declared blocking gates (executed in
  M11a) are current and passed or explicitly overridden. Project config supplies
  reusable command profiles, skill mappings, capability/env profiles, and default
  timeout/cost overrides; the Flow declares which gates are required. In M11a
  gate results are _recorded_ but do not gate promotion; M15 adds the
  promotion-gating readiness check.

  **Expectation: verdict calibration.** Confidence thresholds and pass/fail
  policy per gate / Flow, so an `ai_judgment` verdict maps to a readiness state
  consistently across Flows.

  **Expectation: external_check ingestion.** `external_check` gates (schema-valid
  and `pending` in M11a) are satisfied through the M16 operations API report
  contract; M15 owns the readiness policy that consumes those reports and the
  staleness rules over external commits.

  **Acceptance criteria:**

  - Review and merge refuse when any required blocking gate is missing, pending,
    running, failed, stale, or skipped (M11a records gate results; M15 enforces
    the promotion gate).
  - Run detail and board cards show a readiness summary:
    `ready | blocked | stale | failed | waiting | overridden`.
  - Verdict calibration maps `ai_judgment` confidence to a readiness state per
    Flow-declared policy.
  - `external_check` reports ingested via the M16 operations API satisfy or fail
    the pending gate and participate in staleness.
  - Deferred explicitly: complex policy language, org-wide gate templates,
    deploy-environment gates, flaky-test intelligence, judge calibration lab,
    provider-specific CI apps, and external CI ingestion beyond the generic
    operations API/report contract.

  **As-built (shipped 2026-06-03):** [ADR-048](decisions.md#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15)
  + new domain doc [`docs/system-analytics/readiness.md`](../docs/system-analytics/readiness.md).
  Required-gate signal = the existing `mode: blocking` (no new `readiness_policy`
  grammar — the AC's "complex policy language" stays deferred). **No DB migration, no
  new `MaisterError` code, no new `runs.status`, no engine bump** (`MAISTER_ENGINE_VERSION`
  stays `1.2.0`). Delivered: gate `calibration { confidence_min, allow_missing_confidence }`
  + flow-level `verdict_calibration` folded into each `ai_judgment`/`skill_check` gate at
  compile time (`config.schema.ts`, `compile.ts`); blocking `human_review` rejected at
  validation (`CONFIG`); calibration applied at execution (`gates-exec.ts` `calibrateVerdict`)
  setting `gate_results.status` with a fail-closed `no_confidence` default + the
  `verdict.calibration` JSONB record; the engine gate around the Review chokepoint removed so
  enforcement applies to **all graph flows**, with `assertEvidenceReady` broadened from 2 to
  **all** evaluated blocking gate kinds; a shared pure `web/lib/flows/graph/readiness-core.ts`
  (per-kind allow-list + priority classifier `failed>stale>blocked>waiting>overridden>ready`
  + live-attempt/external-collapse helpers) adopted by the enforcer, `getRunReadiness`
  (now a 6-state DTO incl. `overridden`, `skipped`→`blocked` for all kinds), and the board +
  portfolio bulk queries (no N+1); a unified readiness badge on run-detail (`ReadinessSummary`),
  board flight-card (replacing the 3 bespoke badges), and portfolio card + EN/RU `readiness`
  i18n; the bundled `aif` flow exercises calibration via a flow-level default + an advisory
  `ai_judgment` gate. **Merge-refuse for flow runs is DEFERRED to M18** (Codex finding 2):
  the only merge route is scratch-only and scratch runs carry no flow gates, so
  `assertEvidenceReady(_, "merge")` is wired into the scratch promote route as the reusable,
  vacuously-ready call site / future-proofing — M18 (flow-run promotion) enforces it for real,
  reusing the same evaluator. Verified: typecheck 0; unit 1450; readiness/board/portfolio/
  evidence integration green; `m15-readiness` Playwright e2e 2/2; SDD Phase-0 spec-freeze
  (ADR + readiness.md) then per-task QA(RED)→implementor(GREEN)→reviewer TDD. **Deferred**:
  per the AC list above, plus project-level `command_profiles`/`skill_mappings`/default-limits
  (M14 already supplies env/agent/skill profiles).

- [x] **M16. External operations API, tokens, and thin MCP facade** — expose a
  small project-scoped control surface for CI, local scripts, external tools,
  and running agents. The canonical contract is the HTTP API with managed API
  tokens; MCP is a thin agent-facing facade over the same service layer and
  audit model, not a second orchestration backend.

  **As-built (shipped 2026-06-02):** ADR-045 (`external_check` enforced at the
  Review chokepoint), ADR-046 (project API token model), ADR-047 (thin MCP
  facade as a standalone REST-client package); migration
  `0020_m16_api_tokens.sql`. Phase 1 extracted `createTask`/`launchRun` into
  auth-decoupled services (`web/lib/services/{tasks,runs}.ts`). Phase 2 shipped
  project API tokens (`web/lib/tokens/*`: hashed secret, `issue`/`verify`/
  `revoke`/`list`, audit) with name/prefix/scopes/expiry/last-used and a
  once-shown secret, the `/api/projects/[slug]/tokens[/{tokenId}]` management
  routes, and the Integrations panel (`integrations-panel.tsx` +
  `token-actions.tsx`, EN+RU). Phase 3 added the token-authed `/api/v1/ext/*`
  surface (create/list/get/update task, launch/get run, get readiness, report
  gate), each route attributing token id/actor/scope/result in the audit trail
  and hiding cross-project existence behind a uniform 404. Phase 4 wired the
  `external_check` gate loop: a CI report records a typed gate artifact (status,
  source, external run URL, commit SHA, summary, payload, reporter token,
  reported-at) that joins the same readiness summary, staleness-on-new-commit
  rules, evidence graph, and review/promotion refusal path as native gates, with
  external-gate readiness fanned to board and portfolio via the shared
  `external-gate-readiness.ts` collapse helper. The thin MCP facade (`mcp/`
  package) is a token-scoped REST client over the same `/api/v1/ext` surface that
  cannot exceed token scope and (ADR-047) never falls back to an env token under
  HTTP. Contracts: `docs/api/external/operations.openapi.yaml` +
  `web.openapi.yaml`, `docs/db/integrations-domain.md`, error-taxonomy
  (`CONFIG`→422, `PRECONDITION`/`CONFLICT`→409). A deep `/aif-verify` adversarial
  pass then fixed an OpenAPI↔code status drift, a cross-tenant existence-hide
  leak on the ext `/runs` route, quadruplicated readiness logic (→ shared
  helper), and a manifest-config test gap. Verified: typecheck/lint 0, unit 1189,
  integration 489, `validate:docs:all` 104/104, both OpenAPI specs lint-clean,
  M16 Playwright e2e (`web/e2e/m16-external-operations.spec.ts`) green. Landed on
  `main` as the squashed `459a948` (pre-rebase linear history preserved at
  `backup/m16-pre-rebase-linear`). **Deferred:** OAuth apps, user impersonation,
  full RBAC, granular per-scope token grants, outbound webhooks,
  provider-specific GitHub/GitLab/Jenkins apps, external board sync, and
  public-internet webhook hardening beyond token/HMAC.

  **Expectation: API-first integration.** External systems use REST endpoints
  secured by project-scoped tokens to create tasks, launch runs, read run
  readiness, attach artifact metadata, and report external gate results. CI
  never marks a run done directly; it reports evidence for a Flow-declared
  `external_check` gate.

  **Expectation: token management UI.** Project settings expose an
  Integrations/API Tokens page. A teammate can create, list, and revoke tokens.
  Tokens have a name, prefix, hashed secret, project scope, scopes, optional
  expiry, created-by, created-at, last-used-at, and revoked-at. The secret is
  shown once. Full RBAC is still deferred; token scopes are the first control
  boundary.

  **Expectation: minimal scopes.** Initial scopes are `tasks:create`,
  `tasks:read`, `tasks:update`, `runs:launch`, `runs:read`,
  `readiness:read`, `artifacts:attach`, and `gates:report`. Token failure modes
  are explicit: invalid, expired, revoked, wrong project, or missing scope.

  **Expectation: external gate reports.** A CI/reporting call records a typed
  gate artifact with status, source, external run URL, commit SHA when present,
  summary, structured payload, reporter token id, and reported-at timestamp.
  The report participates in the same readiness summary, staleness rules,
  artifact graph, and review/promotion refusal path as native gates.

  **Expectation: thin MCP.** MAIster ships a narrow MCP server/tool facade for
  agents: create/list/get/update task, launch run, get run, get readiness, and
  report gate where the token permits. MCP calls must go through the same
  domain services or HTTP API, use the same token/scopes, and produce the same
  audit trail. MCP must not bypass API authorization, readiness, or run ledger
  rules.

  **Acceptance criteria:**

  - Project settings can create, list, and revoke project API tokens; token
    secrets are stored hashed and shown only once.
  - Token-authenticated requests are attributed in audit/ledger records with
    token id, actor label, scope used, project id, endpoint/tool, and result.
  - External clients can create a backlog task without UI interaction.
  - External clients can launch a run using the same launch contract as the UI,
    including Flow, executor/runner, base branch, and target branch once branch
    targeting lands.
  - External clients can report an `external_check` gate result and attach
    artifact metadata; the run detail evidence graph shows the result as normal
    evidence.
  - Readiness reflects external gate results and marks them stale when the
    dependent commit/artifact changes.
  - A failed, missing, stale, or skipped blocking external gate blocks review
    and promotion until rerun or explicitly overridden by human review.
  - MCP tools are a facade over the same service layer/API and cannot perform
    any operation the token lacks scope for.
  - Deferred explicitly: OAuth apps, user impersonation, full RBAC, generic
    outbound webhooks, provider-specific GitHub/GitLab/Jenkins apps, external
    board sync, and public-internet webhook hardening beyond token/HMAC.
  - Architecture note (see ADR-024/ADR-046): tokens are project-bound and
    route-scoped; `*` remains the full-project compatibility scope; every token
    action is audited; HITL carries `confidence` + `criticality` and the
    escalate-to-human decision is a Flow gate, never the external actor's.

- [x] **M17. HITL hybrid surface** — in-card form on task card (delivered via artifact + ACP notification), "Needs you (N)" badge on portfolio home, dedicated Inbox block listing pending HITL requests across all projects. `human` step type renders with review / send-back-with-comments flow through M11a's typed decisions, M11b's manual takeover, M12's evidence graph, M13's assignment states, M14's capability profile display, and M15's readiness summary.

- [x] **M18. Branch targeting, diff review, and manual promotion** — replace
      the narrow "merge to main" assumption with engineer-controlled branch
      targeting. A run starts from a selected base branch, works in a MAIster run
      branch/worktree, then promotes that result to a selected target branch by PR
      or local merge after readiness passes.

  **Expectation: launch branch selection.** Task launch UI lets the operator
  choose Flow, runner/executor, base branch, and optionally target branch. Base
  branch defaults to the project default branch; target branch defaults to the
  base branch. Advanced branch controls should stay compact so the normal path
  remains one-click.

  **Expectation: worktree from base branch.** Worktree creation checks out the
  selected base branch commit and creates the run branch from that commit. The
  run ledger records base branch, base commit, run branch, target branch, and
  launch-time executor/Flow selections.

  **Expectation: promotion modes.** Initial modes are `local_merge` and
  `pull_request`. Local merge merges the run branch into the target branch with
  `--no-ff`. Pull request mode pushes/uses the run branch and creates or
  updates a PR into the target branch. No deploy or release management is in
  scope; production/release work stays manual outside MAIster.

  **Expectation: review surface.** Review shows base branch -> run branch ->
  target branch, returned manual takeover diffs, readiness summary, and raw diff
  in a plain review surface. The final action says exactly where the result will
  be promoted, for example `Promote to release/2.1`.

  **Expectation: conflict handoff.** Conflicts never auto-resolve. A conflict
  creates an assignment/manual takeover with parent repo path, target branch,
  run branch, and exact failing command. The user resolves by hand and returns
  through the normal assignment/artifact/gate path.

  **Acceptance criteria:**

  - Launch can select base branch and optional target branch; both are validated
    against the project repo before worktree creation.
  - Run branches are created from the selected base branch commit, not
    hard-coded `main`.
  - Review and run detail display base branch, base commit, run branch, target
    branch, promotion mode, and readiness state.
  - Promotion refuses unless required blocking gates are current and passed or
    explicitly overridden.
  - Local merge promotes run branch into target branch with `--no-ff`; conflict
    aborts merge and creates a manual-resolution assignment.
  - Pull request mode creates or updates one PR per run branch/target branch
    pair and records PR URL/number as artifacts and ledger events.
  - Promotion attempts are idempotent across retryable failures and never create
    duplicate PRs/tags/promotion records for the same run.
  - Deferred explicitly: deploy management, release trains, rollback
    automation, semantic version inference, approval chains, changelog
    generation beyond a promotion summary, and production environment control.

  **As-built (shipped 2026-06-04):** ADR-058 (branch targeting at launch + shared
  promotion service + promote-time readiness re-gate; M18/M15 carve) + ADR-049 (PR
  promotion via a hybrid provider `PrAdapter`, credential model B — reverses the
  "gh is never invoked" invariant). Launch accepts optional `baseBranch`/`targetBranch`
  (`app/api/runs/route.ts`), both validated against the live repo via `listBranches`
  before any git side-effect (`lib/services/runs.ts`); worktree is created from the
  resolved base commit (`startPoint`, not hard-coded `main`) and the workspace ledger
  records base branch/commit, run branch, target branch, and promotion mode. Shared
  promotion service (`lib/runs/promote.ts`) re-gates readiness at promote time
  (`assertEvidenceReady`, reusing the M15 evaluator), then dispatches `local_merge`
  (`promoteLocalMerge` `git merge --no-ff`; conflict → abort + `createMergeConflictAssignment`
  carrying parent repo path, target branch, run branch, and failing command, run stays
  `Review`) or `pull_request` (`lib/runs/pr-adapter.ts` — `gh`/`glab` CLI + Gitea REST
  with bounded pagination; push → idempotent create-or-update one PR per run/target pair;
  PR url/number recorded as artifact + ledger). Idempotency via a durable
  `promotionAttemptId` CAS claim (stale-claim reclaim, token-scoped finalize) so retryable
  failures never duplicate PRs/promotion records. Review surface (`components/runs/review-panel.tsx`)
  renders the base → run → target spine with base commit, promotion mode, and readiness
  summary, and the final action names the exact target. Verified: all 7 acceptance criteria
  green with file-level evidence; seeded authenticated Playwright e2e
  (`web/e2e/m18-branch-promotion.spec.ts`: merge, conflict-handoff, and PR scenarios).
  **Deferred:** per-launch promotion-mode override (project-level in M18), managed
  per-project PR credentials (model C), and the M18.Phase-2 items in the AC list above.

- [x] **M19. Reconciliation + GC** — shipped 2026-06-02 via `claude/suspicious-chatelet-2b3a22`. Crash reconciliation + graceful garbage collection for stranded runs and old worktrees; also closes the M10 deferred follow-up (automatic GC of unreferenced `Removed` flow_revisions). **As-built** (`92ef0f4`…`ab881a6`, six phase-checkpoint commits): ADR-033 (crash-reconciliation model — allow-list `Running`-only classifier with grace guard + retry-safety split), ADR-034 (recovery semantics — durable-marker-first `--resume` hybrid + cap re-admission), ADR-035 (preserve-then-prune workspace GC), ADR-036 (flow-revision GC). Additive migration `0015_glorious_moondragon.sql`: `runs.resume_started_at` + `workspaces.{scheduled_removal_at,archived_branch,archived_at}` (no `gc_state` enum — UI TTL state derived). **Reconcile engine** (`web/lib/reconcile.ts`): pure `classifyRunReconcile` implementing the §0.3 table (worktree-gone / agent-session-gone-past-grace / `cli`-not-retry-safe → CRASH; session-less `check`/`judge` → re-dispatch; live → re-attach; `listSessions` failure → skip the whole tick) + `runReconcileSweep` (per-project, disjoint from `resume-recovery`/`takeover-return` via a `node_attempts` anti-join, bounded concurrency) + `startReconcileSweeper` singleton, both booted from `instrumentation.ts`. **Transition** `crashRunningRun` (CAS `Running→Crashed`, clears `resume_started_at`/`current_step_id`) + scheduler resume-on-promote (a promoted `Pending`+`acpSessionId` resumes via `driveResume`, not a fresh launch — closing the queued-resume loop) + `scheduled_removal_at` stamping on Abandoned/Done. **Recover/discard** (`web/lib/runs/recover.ts` + `POST /api/runs/{runId}/recover|discard`; new `recoverRun`=member RBAC action): §3.2 durable-marker-before-side-effect under the scheduler advisory lock, cap-full → `Crashed→Pending` queued (202, no over-spawn — Codex F2), transient → leave `Running` no rollback (503), `CHECKPOINT` → re-crash (410); discard = `markAbandoned` + GC countdown, no synchronous removal. **GC** (`web/lib/gc/*`): `preserveWorktree` (Codex F1 — `statusPorcelain` → snapshot commit captures tracked+untracked → `maister/archive/<runId>` branch + optional push, never merge-to-main; any git failure → `{ok:false}`, removal gated on preserve success), `runWorkspaceGcSweep` (effective deadline `scheduled_removal_at ?? ended_at+AGE` — Codex F3 backfill-free; pruned-not-marked crash window self-heals), `runRevisionGcSweep` (dual-FK re-assert under `FOR UPDATE` → delete + `rm`), `startGcSweeper` + token-guarded `GET`/`POST /api/cron/gc` (constant-time `X-Maister-Cron-Token`; empty→503, mismatch→401, 200/207, token never logged). **UI**: distinct Crashed board column + run-detail Crashed section with accessible Recover/Discard confirm dialogs (Recover warns it re-runs the current node — Codex F4; cap-full → queued state); left-rail worktree TTL color-ramp (green→amber→red via the effective deadline) + archived indication; EN+RU i18n. Seven env vars (`MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS`/`_GRACE_SECONDS`, `MAISTER_GC_SWEEP_INTERVAL_SECONDS`/`_AGE_DAYS`/`_WARNING_DAYS`/`_ARCHIVE_PUSH`, `MAISTER_CRON_TOKEN`) in `.env.example` + `docs/configuration.md` (compose stays Postgres-only per ADR-023). Docs: ADR-033..036 + new `docs/system-analytics/reconciliation-gc.md` + runs/workspaces/flow-packages updates + `web.openapi.yaml`/ERD/error-taxonomy. Verified: typecheck 0, unit 966, integration 260, `validate:docs:all` 95/95, all 5 M19 Playwright specs green; SDD docs-first Phase 0 + per-phase QA(RED)→implementor(GREEN)→adversarial-reviewer TDD with executable phase gates. **Deferred**: on-disk ACP `.jsonl` pruning, an immediate force-delete affordance, and a manifest `retry_safe: true` opt-in to widen `cli` auto-redispatch (all → Phase 2).

- [ ] **M20. Dogfood + external validation** — register MAIster repo in itself, ship ≥1 non-trivial PR through the **aif Flow plugin** against own backlog (validates aif-as-plugin end-to-end, Flow package lifecycle, review-driven rework, manual takeover, evidence graph review, role-owned assignments, capability registry, gate readiness, external operations API/MCP facade, and retry loop on a real task). Then onboard 3 installations on external repos using either `aif` or `superpowers` plugins, ≥1 PR shipped end-to-end on each within T+21d after dogfood. 0/3 → thesis not validated, reassess wedge.

- [x] **M21. Project repo onboarding (URL clone + configurable roots)** — shipped 2026-05-31 via `fix/integration-test-seeds`. Accept a git `repo_url` at registration and clone it (**model B**: host git credentials, no secrets stored in MAIster) for GitHub / GitLab / Gitea-family (incl. GitVerse) hosts, while keeping the existing local-`repo_path` mode (existing repos are never re-cloned). Config-schema union (`repo_url?` | `repo_path?`, `repo_path` derived), `projects.repo_url` + `projects.provider` columns, provider autodetect tag, two configurable roots `MAISTER_REPOS_ROOT` (`~/.maister/repos`) + `MAISTER_WORKTREES_ROOT` (`~/.maister/worktrees`), clone-if-missing in `POST /api/projects`, Add-Project URL field. Provider-specific PR/push and managed per-project credentials (model C) stay with M18. Independent of the M11–M20 ordering — can land anytime. See ADR-025.

- [x] **M22. Workbench visibility: flow-graph view + git-tracked file-tree + run diff** — shipped 2026-06-05 via the `m22` commit series (`587cde72`…`b5d5f1b4`). The dogfood-unblock UX slice: make a run inspectable without leaving MAIster. Three workbench surfaces behind `?wb=Files|Diff|Graph` tabs (`web/components/workbench/workbench-tabs.tsx`). **Graph** — `FlowGraphView` reusing the React Flow stack (`@xyflow/react` + dagre, same family as the M12 evidence graph, ADR-039) with live node-status coloring and visual metadata for labels, node roles, gate summaries, and review-loop edge affordances; topology is compiled from the pinned manifest and node positions are read from the `flow.yaml` **presentation section** (ADR-064, supersedes ADR-051's interim DB layout store); **read-only — no layout write action**; served by `GET /api/runs/[runId]/graph` + graph-status read models (`web/components/board/flow-graph-view.tsx`, `web/lib/queries/flow-graph-view.ts`, `web/lib/queries/run-node-status.ts`, `web/lib/flows/graph/presentation-layout.ts`). **Files** — a git-tracked-only file-tree browser in the project and per-run workbench, member-gated behind the new `readRepoFiles` action (ADR-053), backed by `listTree`/`readBlob` over the worktree and `GET /api/runs/[runId]/files/content` (`web/components/workbench/file-tree.tsx`, `repo-files-panel.tsx`). **Diff** — base→run raw diff over a 2-dot range via the `RawDiff` component (`web/components/runs/raw-diff.tsx`), extending the M18 base→run→target review surface, kept at `readBoard` (viewer). Migration `0030_m22_drop_flow_graph_layouts.sql` drops the interim layout table now that layout is authored in `flow.yaml` (no engine bump). EN/RU i18n parity; seeded authenticated Playwright e2e (`web/e2e/m22-workbench.spec.ts`). ADRs 051–053 + 064; docs: `docs/system-analytics/workbench.md`. **Deferred:** the flow-graph **editor** (write path for layout + on-canvas node edits) and agent-assisted Flow authoring → see `docs/pv/improvement-roadmap.md` §6 + `docs/pv/flow-authoring-assistant.md`.

- [x] **M23. Observatory read-only metrics surface** — shipped 2026-06-05. Wave-1 Observatory implements the read-only half of the correction/autonomy learning loop. It adds no migrations and no public Web API routes: server-component pages call batched read models over existing `runs`, `node_attempts`, `gate_results`, `hitl_requests`, and `artifact_instances` rows. Metrics: `correction_rate = (rework + retries) / runs` as an unbounded pressure ratio, Autonomy Score from merged HITL wait intervals over total run time, artifact buckets by definition/kind, and repeatable signal clusters for structured rework, failed blocking gates, and retries with redacted examples. UI: `/observatory` portfolio dashboard, `/projects/[slug]/observatory` project dashboard with GET filters, node drill-down links, EN/RU labels, and seeded M23 Playwright coverage. ADR-051 locks the formulas and harvest priority. **Deferred:** write-side learning, automatic fixes, recommendations, M17 `criticality`/`human_confidence` weighting, and any new analytics persistence/index migrations.

- [x] **M24. Scheduler service (one clock, polymorphic jobs)** — shipped 2026-06-05 via `feature/m24-m25-wave1-long-lead`. Adds ADR-060, the spec SSOT, migration `0027_m24_scheduler_service.sql`, `scheduler_jobs`, `scheduler_job_runs`, and `agent_schedules`; token-guarded `GET/POST /api/cron/tick`; `/api/cron/gc` compatibility wrapper over shared `system_sweep`; fixed-interval catch-up-not-backfill claim core; stuck-attempt reaping; command/agent/flow handler seams; disabled-by-default web-tier fallback timer; scheduler status read model; and docs/OpenAPI/env updates. The supervisor remains DB-free, and `flow_run` is the only scheduler kind that reaches the existing flow cap.

- [x] **M25. Capability catalog groundwork** — shipped 2026-06-05 via `feature/m24-m25-wave1-long-lead`. Adds ADR-061, the spec SSOT, migration `0028_m25_authored_capability_catalog.sql`, `authored_capabilities`, `authored_capability_revisions`, canonical content hashes, draft optimistic concurrency, local publish/archive services, REST groundwork under `/api/projects/{slug}/catalog/caps`, authored rule/skill projection into `capability_records`, authored flow catalog-only publication, and config SET/CLEAR preservation for `material.origin='authored'`. PR publication and two-way catalog-repo sync stay deferred.

- [ ] **M27. Flow Studio Stage 1 — editable + executable flow graph + MCP capability management** — turn the read-only M22 flow-graph **view** into an **editor** for ANY installed flow, make an edited flow **runnable on next launch** (executable bridge), and add first-class **MCP capability management** across platform-instance / project / flow-package scopes. Edits persist as **M25 authored `flow` drafts** (ADR-061 reuse) with layout in the `flow.yaml` `presentation` section (ADR-064); every save passes the `validateGraphManifest`+`compileManifest` **hard-gate** (invalid → `CONFIG`, never persisted). Publish bridges the authored revision into runnable `flows`/`flow_revisions` by reusing `installAuthoredFlowPackageBridge` (ADR-068), under a **two-axis trust model**: logic `flows.trustStatus` (implicit `trusted_by_policy`) + net-new executable `flow_revisions.exec_trust` gating `setup.sh`/MCP-stdio. Launch resolves the effective revision per `flows.version_binding` (`pinned|latest`, ADR-069) and snapshots the resolved set into `runs.resolved_capability_set` (in-flight immutable). MCP management adds a `platform_mcp_servers` admin CRUD surface (mirrors ADR-065), project + flow-package MCP declaration, **uniform local-first resolution precedence** (project→platform→flow-package, all capability kinds, ADR-070), setup-time resolve-by-id, required-vs-additional launch refusal, and `env:NAME`-only secrets — reusing M14 materialization. No engine bump, no new `runs.status`. SDD: `.ai-factory/specs/feature-m27-flow-studio-stage-1.md`; plan: `.ai-factory/plans/feature-m27-flow-studio-stage-1.md`; ADRs 066–069. **Continued by the Flow Studio redesign** (unified `/studio` IA): **Phase A** (overview · sources · packages-grouped · merged package detail with read-only preview) **shipped** over the existing backend — no migration, no new HTTP route; `/flows` landing removed + package Sources relocated to `/studio/sources`. **Phase B** (big-canvas editor usability redesign over the existing `/flows/{slug}/{capId}` route) **shipped** (→ **M35**); **Phase C** (editable local packages / standalone artifact kinds, incl. the `/studio/edit` route move) is planned. SDD `.ai-factory/specs/feature-flow-studio-redesign.md`; plan `.ai-factory/plans/feature-flow-studio-redesign.md`; ADR-092.

  **Acceptance criteria:**

  - The flow-graph editor edits any installed flow (all node types + 6 gate kinds + rework + M26 `output.result`), persists structural + presentation edits as an authored `flow` draft with M25 optimistic concurrency, and refuses an invalid manifest with `CONFIG` without persisting.
  - Publishing an authored flow bridges it into `flows`/`flow_revisions` (`trustStatus=trusted_by_policy`, `exec_trust=untrusted`); `setup.sh` and MCP stdio commands never execute until an explicit `exec_trust` flip.
  - Launch resolves the effective revision per `version_binding` (`latest`=newest published, never a draft, authored-wins tie-break; `pinned`=`enabled_revision_id`) and freezes `runs.resolved_capability_set`; an edit/publish during a run never mutates that run.
  - Platform MCP admin CRUD mirrors the ACP runner pattern (usage-guarded hard delete → 409, dup id → 409); project + flow-package MCP declarations resolve by project→platform→flow-package with one winner per `(kind,refId)` and no duplicate materialization.
  - A required MCP that cannot resolve+materialize refuses launch (`CONFIG`/`EXECUTOR_UNAVAILABLE`); an additional MCP absence is non-fatal; resolved MCP revisions are in the launch snapshot; secrets stay `env:NAME` server-side.
  - EN+RU parity for all new UI; per-phase full-suite-green; no engine bump; no new `runs.status`.

- [x] **M29. Flow Studio Phase 2 (part 1) — package viewing/reachability + artifact-aware editing** — direct continuation of M27 Stage 1. **Track 0:** make an INSTALLED (git-pinned, immutable) flow package browsable from the project UI — read-only graph (compiled from the DB `manifest`) + raw `flow.yaml` + every bundled artifact file (read from disk at `flow_revisions.installed_path`) — kill the decoy `cursor-pointer` cards, and add "Fork to edit" (immutable revisions always fork to an M25 authored draft with `source_flow_ref_id` lineage, via `POST …/revisions/{revisionId}/fork`). **Track 1:** replace the flat package-file list with a derived file tree + per-kind artifact editors (skill/rule/agent frontmatter forms, shell editor + heuristic lint, `form_schema` builder with live preview), wire per-kind content validation into the draft-save hard-gate (BLOCK/WARN severity), swap the `flow.yaml` `<textarea>` for CodeMirror with live YAML→graph re-seed, add the typed-edge modal-on-connect, and complete the presentation round-trip (persist canvas spawn x/y on add; carry width/height/color through to views). **No migration, no engine bump, no new `runs.status` / `MaisterError` code** (every column relied on already exists). Excluded: markdown/mermaid artifact preview, AI authoring assistant, governance/publication pipeline, in-place installed-file editing. SDD: `.ai-factory/specs/feature-flow-studio-phase2-viewing-editing.md`; plan: `.ai-factory/plans/feature-flow-studio-phase2-viewing-editing.md`; decision ADR-075.

  **Acceptance criteria:**

  - A member opens an installed package from the project flows/packages tab and views the read-only graph (honouring `presentation`, dagre fallback, OUTSIDE any run) + raw `flow.yaml` + every artifact file read-only; no decoy cards remain; a missing-on-disk bundle degrades (metadata + graph from the DB `manifest`) without throwing.
  - Every `?file=` read is path-confined (`repoRelPathSchema` sink-invariant → lexical prefix → `realpath`, 1 MiB cap); no client surface exposes `installed_path`.
  - A manager "Fork to edit" seeds an authored `flow` draft with `flow.yaml` + files + `source_flow_ref_id` in ONE transaction (executing nothing), slug defaults to `flowRefId` with `-fork`/`-fork-N` probe (explicit collision → 409, missing bundle → 422, foreign revision → 404), and lands in the editor.
  - Per-kind artifact editors block draft save on a BLOCK content issue (`CONFIG` 422, not persisted) on BOTH save paths; rule-guardrail/shell-lint/unreferenced-schema/unknown-key issues are WARN-only.
  - File tree with add/rename/move and kind-by-path inferred badge (no manual `<select>`); `flow.yaml` via CodeMirror with live YAML→graph re-seed and modal-typed edges; canvas drag + size/color round-trip save→reload and match the read-only view.
  - EN+RU parity for all new UI; per-phase full-suite-green; migrations: none.

- [x] **M30. Gate-chat + flow attempt/rework policies (workspacePolicy execution, retry_policy, session_policy, review-diff completeness)** — completes the M11b `workspacePolicy` execution deferral (`TODO(M11b)` at `runner-graph.ts`) and adds four capabilities on the existing graph/HITL/ledger/diff substrate. (1) **Gate-chat** — an answer-only reviewer↔agent Q&A at `human`/`form` HITL pauses (new `gate_chat_messages` table, new `session.chat_turn` SSE event) that NEVER resolves the HITL nor drives `→Running`, with 3-layer **workspace-neutrality** (L1 prompt preamble, L2 best-effort permission auto-deny, L3 unconditional fail-closed mutation-sensor restore — the only hard guarantee, consistent with ADR-041 instructed-only). (2) **Node `retry_policy`** — auto-retry on a retryable-error allow-list (`SPAWN`/`EXECUTOR_UNAVAILABLE`/`CHECKPOINT`/`ACP_PROTOCOL`), fresh-session attempts marked `auto_retry`. (3) **Rework `session_policy`** (`resume`-by-default) reusing the idle checkpoint / ACP `session/resume` path, with observable `session_fallback`. (4) **workspacePolicy execution** via namespaced dangling checkpoint refs (`keep` / `rewind-to-node-checkpoint` / `fresh-attempt`), the shared foundation for L3 neutrality, retry, and the `last-node` diff scope. Plus **review-diff completeness** — a pre-review dirty-state protocol (commit/discard/proceed, gate never blocked) and a 4-mode diff `scope` switcher (`run` / `since-last-review` / `last-node` / `uncommitted`). Engine `1.3.0 → 1.4.0`; single migration `0041`; ADRs 078–082. Plan: `.ai-factory/plans/feature-gate-chat-retry-rework-workspace-policy.md`. **(Done 2026-06-11 on `feature/gate-chat-retry-rework-workspace-policy`: Phase A docs + Phase B TDD implementation, full gate green — unit 3103 / integration 1019 / supervisor 145 / e2e 8.)**
- [x] **M31. Social board layer — Stage 1 (numbering, relations, comments/activity/subscribers/inbox)** — shipped 2026-06-11 via `feature/social-board-stage1` (ADR-083, migration `0043_social_board.sql`). Every task gains a stable per-project identity `KEY-N` (`projects.task_key` platform-UNIQUE + counter-allocated `tasks.number`, backfilled with a deterministic uniquify ladder), typed same-project relations (`blocks|depends_on|parent_of`, canonical one-direction rows, inverse labels render-time) that gate launching through a new `"blocked"` launchability classification (precedence `target_terminal > crashed > busy > blocked > launchable`, enforced via the single classifier at `launchRun` — internal + ext — and the schedules dispatcher as `skipped_blocked`), and a social substrate on a polymorphic `(actor_type, actor_id)` pair (`user|agent|system`; Stage 1 writes `user`/`system` only — `agent` is schema-ready for the platform-agents stages): markdown comments with write-time `KEY-N` mention expansion (fences/inline-code/links skipped), domain-only `task_activity` (`recordTaskActivity` is the single writer; 6 event kinds, `run_finished` deferred until a `setRunStatus` choke point), first-reason-wins auto-subscriptions (creator/commenter/D8 mention rule/manual follow), and batch-fanout `inbox_items` with recipient-owned read tracking. Surfaces: task detail page (timeline, composer, relations editor, run history, latest-run graph + diff), board/flight card `KEY-N` chips + blocked-launch chips, run-header back-link, HITL inbox task refs, task-activity Log table on the board's Activity tab (URL-param filters), portfolio inbox panel + "Needs you" = HITL + unread in both scopes, registration task-key field, ext comment routes (`comments:read`/`comments:create` scopes, token→actor mapping) + MCP `comment_create`/`comment_list`. As-built notes: ext surface spec'd in `docs/api/external/operations.openapi.yaml`; the Log landed as a section on the existing `?tab=activity` (tabs precedent); `getCrossProjectHitlInbox` stays pure-HITL with the badge summing at the page layer.

- [x] **M32. Domain-event outbox core (shared trigger bus)** — shipped 2026-06-11 via `feature/domain-event-outbox` (ADR-086, migration `0046_domain_events.sql`; Stage 2 of the platform-agents staged design — the lost design doc is superseded by `.ai-factory/specs/domain-event-outbox.spec.md` + ADR-086 per owner decision). `domain_events` is an immutable, append-only domain-fact log written by `emitDomainEvent` in the SAME transaction as the state change (CAS-winner path only): 8-kind taxonomy v1 (`task.created`, `task.comment_added`, `task.triage_requeued` registered emitter-less for the Stage-3 triager, the 4 terminal `run.*` kinds, `gate.failed`), polymorphic ADR-083 actor pair, and an `xid8 tx_id DEFAULT pg_current_xact_id()` commit-visibility horizon. Dispatch = per-consumer cursor rows (`domain_event_consumers`) with CAS lease claims, horizon-gated PK-range reads (`id > cursor AND tx_id < pg_snapshot_xmin(pg_current_snapshot())` — a late-committing lower id can never be skipped), fenced cursor advances (zombie-safe), at-least-once delivery with failure accounting, driven by the singleton `domain_event_dispatch.default` job (60s, budget 1, not user-creatable) on the M24 clock; a permanently-registered `noop` consumer proves the seam. Run-terminal/gate sites emit BOTH webhook + domain rows in one tx until the ADR-077 drainer re-points (takeover note in its plan); the previously emit-less `runPass2` TTL abandon became transactional and closed the `run.abandoned` webhook gap with `source: "ttl"`. As-built bonus: repaired main's gemini×social-board cross-merge debt (2 typecheck reds + 24 integration fixtures + the 0043 stepwise-replay tag addressing — 23 files/108 tests were red on merged main).

- [x] **M33. Package management (multi-flow packages, platform sources, project attachments)** — shipped 2026-06-12 via `feature/package-management` (ADR-088, migration `0048`). — packages become the first-class distribution unit (ADR-088; design: `docs/pv/package-management.md`; plan: `.ai-factory/plans/feature-package-management.md`). Scope P0–P2: **P0** — the AIF package extracted to the external `maister-plugins` monorepo (`packages/aif`, per-package tag `aif/v2.0.0`, engine-1.4.0 bump with retry/session policies + `must_touch` commit gates — repo already filled and tagged); maister-side cleanup (test-fixture snapshot, `plugins/aif` deletion, dogfood rewire). **P1** — `maister.yaml packages[]` single-import: `maister-package.yaml` loader, `installPackage` clone-once orchestrator with resolved-revision inheritance into member flow/capability sub-installs, registration expansion. **P2** — platform catalog: `package_sources`/`package_installs`/`project_package_attachments` (migration `0048`), `/settings` sources CRUD + tag discovery (`ls-remote` + manifest scan, startup debounce via `MAISTER_PACKAGE_DISCOVERY_STALE_HOURS`), attach/detach/upgrade as one-tx group ops with `maister.yaml` write-back, package-level trust fan-out, typed ingestion (MCP templates + restriction path-sets → unlocks `must_not_touch` for package flows), local package versions, whole-package viewer. PR-back channels (repo-as-project; Studio propose-upstream) and the `core` package are follow-up briefs in the design doc §8.
- [x] **M34. Platform-agent substrate — Stage 3 (catalog, triggers, repo_read enforcement, social integration)** — shipped 2026-06-12 via `feature/platform-agents-stage3`, **reworked in-branch 2026-06-13** to the package-source model (owner decisions 1–8) before merge (ADR-089/ADR-090, migrations `0049_platform_agents.sql` + `0050_agent_activity_kinds.sql` + `0051_agents_package_source.sql`, flow engine `1.5.0`; Stage 3 of the platform-agents staged design — Mα+Mβ of the Stage-0 vision, whose doc is superseded-by-design with three amendments: per-agent runner, standalone-first, social layer). Agents are `.md`-defined actors shipped INSIDE flow packages (`agents/<stem>.md` — same trust contour, versioning, Studio authoring/publish path; package-qualified ids `<flowRefId>:<stem>`, collisions impossible by construction): registration after install finalize projects the `agents` catalog from each package's newest Installed revision with provenance (`flow_ref_id`/`version_label`/`origin`) under SET/CLEAR symmetry; what a launch RUNS is the per-project EFFECTIVE definition resolved through that project's pinned revision behind the flow enablement+trust gates (pin divergence refuses; attach requires the package enabled in the project and pre-fills from the definition's `recommended` bindings; the package upgrade preview shows agent break-impact joined against live attachments/bindings); `workspace_ref: trigger|branch` gives repo_read agents an ephemeral detached checkout at the trigger-derived ref (run.* events → triggering run's branch; webhooks → payload `branch`/`ref`); capability_profile MCPs resolve from the platform catalog behind the exec-trust stdio gate. `agent_project_links` + reworked `agent_schedules` (cron + event bindings) attach them to projects. Standalone runs ride the existing substrate as `runs.run_kind='agent'` (nullable flow refs, `trigger_source`, partial-unique `(agent_id, trigger_event_id)` outbox claim) under a separate budget (`MAISTER_MAX_CONCURRENT_AGENTS`=3; flow/scratch default raised to 6) with per-agent runner resolution (launch override → link override → agent default → project default → platform default; subagent⇒claude and dangerous-policy⇒worktree refusals). Workspace axis `none|repo_read|worktree` with 3-layer read-only enforcement (ADR-041 untouched): L1 supervisor `readOnlySession` total inline arbitration (allow read/search/fetch/think, deny + cancel everything else, no HITL rows), L2 materialized deny-rules + `mcp__maister` allow, L3 dirty-watchdog at the terminal choke point — beyond-manifest dirt quarantines the agent in ONE tx (flag + system comment + `agent_quarantined` activity) and every entry point refuses quarantined/disabled/destructive agents. Five triggers: manual (task detail + catalog), cron (`agent_tick.dispatcher` singleton, atomic claim, no backfill), domain events (`agent_triggers` consumer with the self-exclusion anti-loop guard), inbound webhook (`POST /api/agents/{id}/event`, `agents:trigger` scope, 32KB), and flow binding (`settings.agent` on ai_coding nodes, engine ≥1.5.0: session-mode prompt substitution / subagent materialization). Social integration: per-launch ephemeral agent tokens (fixed 7-scope set, revoked at terminal/detach/GC, `agent:<id>` audit identity, injected into the session's maister MCP facade via the new literal-env channel), triage verdict ops (ext `POST .../triage` + MCP `triage_set`/`relation_*`, always stamping `triage_status='triaged'`), simple-intent creation (flowId optional everywhere; `unconfigured` launchability between `blocked` and `launchable` with full fan-out), the `task.triage_requeued` emitter ("Send to triage"), and the board card launch-popover extended with flow/runner/promotion-mode persisted via one aggregating PATCH (the ADR-087 launch dialog pre-fills from the triage verdict and doubles as set-up-&-launch for `unconfigured` tasks). Surfaces: `/settings` agents catalog panel (view + kill-switches with `pkg@version` provenance — no create/edit modal, definitions change only through packages), per-project attach panel (links/runner override/cron + event-kind bindings, recommended pre-fill), Studio frontmatter editor with the full platform-agent contract fields, portfolio + board agent-run chips, task-detail Run agent / Send to triage (EN+RU). E2E ×3 against a sessions-capable stub supervisor (manual launch, flow binding substitution, dirty→quarantine→refusal) with fixture agents seeded inside an installed e2e package.

- [x] **M35. Flow Studio editor usability redesign (Phase B)** — shipped 2026-06-15 on `claude/angry-chaum-31d223` (web-only; **no migration, no new HTTP/SSE route, no new `MaisterError` code, no env change**; ADR-092 lineage, continues M27/M29). A storage-agnostic redesign of the authored-flow editor over the **unchanged** draft/publish/trust backend, behind an injectable load/save **seam** (`saveAction`/`publishAction` props default to the existing authored-flow server actions, preserving the `expectedDraftVersion` CAS) so Phase C plugs in without rebuilding it. Delivers: a **node visual scheme** (per-type/per-gate inline-SVG icon chip + forest color token from the pure `web/lib/flows/node-visuals.ts` map) on the **shared** `FlowNodeBody`, composing **additively** with the run-status chip + current-node ring so the read-only package-detail preview AND the run workbench graph inherit it; **named-outcome edge labels** with dashed-amber back-edges (rework/takeover/reject); a **3-pane layout** (compact top bar — lifecycle/validation/readiness chips + Save/Publish + drawer toggles · dominant always-on canvas with MiniMap · collapsible right properties panel) replacing the tabs-in-a-form editor; **overlay drawers** for YAML / Diff / Files (the existing `PackageFilesEditor` re-homed, not redesigned — that is Phase C), with the YAML↔canvas reseed gated to the open YAML drawer + flush-on-close; and a **hideable left rail** (localStorage-persisted). Editor route stays `/flows/{projectSlug}/{capId}` in Phase B; the `/studio/edit` move is Phase C. SDD: `.ai-factory/specs/feature-flow-studio-editor.md`; plan: `.ai-factory/plans/feature-flow-studio-editor.md`; ADR-092. **(Verified 2026-06-15: tsc clean, web unit 3852, eslint 0-errors on changed files, flow-editor + delegated save-round-trip e2e green, EN+RU parity, `validate:docs:all` green; unmerged on its branch.)**
- [x] **M36. Flow Studio package viewer + local editing** — matures the package **browse** experience and completes the salvaged **Phase C** editable-local-package layer; ADR-092/ADR-075 lineage, continues M27/M35. **(0) Salvage** Phase C's `local_packages` substrate onto `main` (renumber migration `0053→0055`, `ADR-093→`**ADR-095**, drizzle snapshot rebuilt). **(1) Read-only mature viewer** — `/studio/packages/{ref}` becomes **tabbed groups** (Flows/Skills/Agents/MCPs/Rules, count-bearing, hidden when empty) with **cards + paging** collections and full **flow** (static canvas + read-only `NodeSideForm` inspector) / **skill-bundle** (file tree + asset preview) / **agent** (what-it-does + when-to-call, `risk_tier`/`workspace`, **no runner**) detail; reuses existing readers, no new backend. **(2) Editable local packages** — `/studio/local` + `/studio/edit/{id}/{...path}`, working-dir file routes under the session lock, per-kind editors (+ a new MCP-template editor), **Fork to local** (package + element grain), **cut version** + attach (migration `0056`: `is_default` virtual package + fork lineage). **(3) Batch import** — folder + zip/tar.gz, path-confined + capped. **(4) Git-backed diff + Commit/Discard** in the local editor (reuses the `[Diff]` drawer). **(5) Docked AI authoring assistant** (ADR-096) — a scratch-run ACP session rooted at the **non-project** local-package working dir (run_kind fan-out, migration `0057`, supervisor working-dir confinement) with right-panel **Properties⇆AI** tabs, live refresh, and inline HITL. No engine bump, no new `runs.status`, no new `MaisterError` code. Design SSOT: `docs/plans/2026-06-20-flow-package-viewer-and-local-editing-design.md`; plan: `.ai-factory/plans/feature-flow-studio-package-viewer.md`; ADR-095/096.

## Completed

| Milestone                                                                    | Date       |
| ---------------------------------------------------------------------------- | ---------- |
| M0. Spike: ACP library + cross-process resume + codex parity                 | 2026-05-25 |
| M1. Drizzle schema + Postgres                                                | 2026-05-26 |
| M2. Core libs (errors, atomic, config v2)                                    | 2026-05-26 |
| M3. Supervisor daemon (`supervisor/`)                                        | 2026-05-26 |
| M4. Flow plugin loader                                                       | 2026-05-26 |
| M5. Flow DSL parser + executor + aif plugin                                  | 2026-05-27 |
| M6. Executor registry: claude + codex + CCR                                  | 2026-05-27 |
| M7. ACP integration + SSE bridge                                             | 2026-05-28 |
| M8. Worker lifecycle: keep-alive + checkpoint + resume                       | 2026-05-29 |
| M9. Web UI core: registry + portfolio + board + auth + RU i18n               | 2026-05-29 |
| M10. Flow package lifecycle and distribution UX                              | 2026-05-30 |
| M11a. Flow graph v1: node lifecycle, run ledger, review-driven rework, gates | 2026-05-31 |
| M11b. Manual takeover (local worktree handoff) + run-detail timeline         | 2026-05-31 |
| M11c. Node typed settings + runtime enforcement boundary                     | 2026-06-01 |
| M12. Typed artifacts and evidence graph                                      | 2026-06-02 |
| M13. Role-owned work queue and assignment UX                                 | 2026-06-02 |
| M19. Reconciliation + GC                                                     | 2026-06-02 |
| M16. External operations API, tokens, and thin MCP facade                    | 2026-06-02 |
| M15. Readiness policy and verdict calibration                                | 2026-06-03 |
| M18. Branch targeting, diff review, and manual promotion                     | 2026-06-04 |
| M17. HITL hybrid surface                                                     | 2026-06-04 |
| M21. Project repo onboarding (URL clone + configurable roots)                | 2026-05-31 |
| M22. Workbench visibility: flow-graph view + file-tree + run diff            | 2026-06-05 |
| M23. Observatory read-only metrics surface                                   | 2026-06-05 |
| M24. Scheduler service (one clock, polymorphic jobs)                         | 2026-06-05 |
| M25. Capability catalog groundwork                                           | 2026-06-05 |
| M28. User-facing run schedules (cron)                                        | 2026-06-10 |
| M29. Flow Studio Phase 2 (part 1): viewer/reachability + artifact editing     | 2026-06-11 |
| M30. Gate-chat + flow attempt/rework policies                                | 2026-06-11 |
| M31. Social board layer — Stage 1 (KEY-N, relations, comments, inbox)        | 2026-06-11 |
| M32. Domain-event outbox core (shared trigger bus)                           | 2026-06-11 |
| M33. Package management (multi-flow packages, platform sources, attachments) | 2026-06-12 |
| M34. Platform-agent substrate — Stage 3 (catalog, triggers, enforcement)     | 2026-06-12 |
| M35. Flow Studio editor usability redesign (Phase B)                         | 2026-06-15 |
| M36. Flow Studio package viewer + local editing (viewer/local-edit/AI)       | 2026-06-20 |
