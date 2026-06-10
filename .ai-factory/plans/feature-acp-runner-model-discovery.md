# Implementation Plan — ACP Runner Model Discovery & Application

- **Branch:** `feature/acp-runner-model-discovery` (off `main` @ `633f74c7`)
- **Created:** 2026-06-10
- **Source design (owner-approved, to be deleted after this plan):**
  `docs/plans/2026-06-10-acp-model-discovery-design.md` — decisions below are copied
  from it verbatim and are **final** (do not re-litigate).
- **Approach:** SDD (spec-driven — analytics/ADR/API specs frozen and human-owned
  **before** any production code) + TDD (RED→GREEN→REFACTOR per task) + agent-teams
  parallel execution (see **Parallelization Map**).

> **Progress (2026-06-11):**
> - ✅ **Phase 0A** — spikes folded to documented findings (owner: lock-from-research,
>   no billable probes). Note: `docs/spikes/2026-06-11-acp-model-discovery-spikes.md`.
>   Locked: claude→`settings.local.json`, codex→`setSessionModel`, codex probe degrades
>   to `skipped` w/o auth, probe timeout = 15 s constant.
> - ✅ **Phase 0B** — spec authored + validated: ADR-076 (`decisions.md`),
>   `system-analytics/model-catalog.md` (R5), `supervisor.openapi.yaml` +
>   `web.openapi.yaml` (both redocly-valid), `supervisor-sse`/`web-runs` asyncapi
>   (0 errors), `architecture.md` (C4 + table row), `error-taxonomy.md`, cross-links,
>   `supervisor.md`. Changed-files gate green (17/17 mermaid, 164 ADR anchors).
>   **Frozen error contract** + **SSE advisory = `session.update` payload variant**
>   (no new union member) — see below.
> - ✅ **Owner freeze** — spec frozen + committed (checkpoint #1 `5a08910`; run-schedules
>   mermaid fix `b4c8d0d`). Phases 1–5 running autonomously with TDD + agent teams.
> - ✅ **Phase 1** — `buildChildEnv` extract (T1.1); model-catalog core types/registry/resolve
>   (T1.2); in-memory TTL cache (T1.3); `POST /model-catalog/resolve` route (T1.4). Reviewer
>   pass applied (router-without-sidecarId→409 `superRefine` + test). Gate: supervisor unit 141
>   + integration 40 green, tsc + scoped eslint clean. Checkpoint #2.
> - ✅ **Phase 2** — ACP active probe w/ deferred-release SIGTERM (T2.1, +mock-acp-models.mjs);
>   provider-API + curated GLM sources (T2.2); CCR source (T2.3); passive harvest + runner
>   threading in acp-client (T2.4); production source-registry wired in main.ts. Reviewer pass
>   applied (robust `/vN$` models-URL heuristic; defensive probe-timeout rejection catch).
>   Gate: supervisor unit 173 + integration 45 green, tsc + scoped eslint clean. Checkpoint #3.
> - ✅ **Phase 3** — claude application via settings.local.json `{model, availableModels:[model]}`,
>   always-on for every claude session (T3.1, web agent-map+materialize); codex via
>   `unstable_setSessionModel` on new+resume (T3.2); model-mismatch **advisory** `session.update`
>   variant — never fails the run (T3.3, supervisor acp-client `applyAndVerifyModel`). Reviewer
>   pass (explicit runner-narrowing). Gate: supervisor unit 178 + integration 45, web agent-map 14
>   + materialize 6, tsc + scoped eslint clean (both tiers). Checkpoint #4.
> - **Plan-vs-reality corrections found (branch == base `633f74c7`):** (a) the plan's
>   "architecture.md has NO component table" note is **wrong** — the table exists at
>   ~line 188; a row was added. (b) The T0B.3 advisory shape is **frozen** as a
>   `session.update` payload variant (`sessionUpdate: "model_advisory"`), NOT a new
>   `SessionEvent` kind (the union stays closed). (c) Resolve error model frozen:
>   per-source failures are `status:"error"|"skipped"` inside **200**; supervisor
>   throws only **409 PRECONDITION** (bad draft); the web proxy adds **422 CONFIG** +
>   **503 EXECUTOR_UNAVAILABLE**.

## Settings

- **Testing:** YES — TDD. Every behavior task lands a RED test first, then GREEN impl.
- **Logging:** Standard (INFO key events only). Log: resolve start/finish + per-source
  status, cache hit/miss/refresh, probe spawn/exit, model-application channel write,
  model mismatch advisory. **No** per-keystroke logging; **no** secret values ever logged.
- **Docs:** YES — mandatory docs checkpoint. SDD spec freeze is **Phase 0B**, a hard gate
  before code (per project rule *"front-load a complete, internally consistent
  analytics/design spec before any code phase"*).
- **Lint:** scoped check-only `eslint` (e.g. `pnpm --filter maister-web exec eslint <files>`).
  NEVER bare `pnpm --filter maister-web lint` (it `--fix`-reformats ~60 files).

## Roadmap Linkage

- **Milestone:** `M29 — ACP Runner Model Discovery & Application` *(tentative number —
  sibling unmerged branches may also target M29; confirm/realign via `/aif-roadmap` at
  merge. `/aif-plan` does not edit `ROADMAP.md`.)*
- **Rationale:** Closes two stacked, code-confirmed gaps in the runner catalog domain:
  (1) the `model` field is unguided free text; (2) the configured model never reaches the
  agent. Both are control-plane correctness gaps, not new product surface.

## Problem (two stacked gaps — both in scope)

1. **No discovery.** `platform_acp_runners.model` is free text (`z.string().min(1)`),
   rendered as a bare `<input type="text">` in
   [acp-runner-modal.tsx](web/components/settings/acp-runner-modal.tsx) (~line 438). Only
   guidance = 7 hardcoded presets in [presets.ts](web/lib/acp-runners/presets.ts).
2. **No application.** The configured model never reaches the agent.
   [spawn.ts:216](supervisor/src/spawn.ts) only **logs** `executor.model` — no env var, no
   settings write, no ACP call. The adapter runs its own default;
   [cost.ts:138](supervisor/src/cost.ts) scrapes the *actual* model from the wire after the
   fact. A dropdown without the application fix would be decorative.

## Decisions (final — copied from the approved design)

1. **Application fix ships in this same workstream** as discovery.
2. **Resolver lives on the supervisor.** Web is only the config surface; `env:NAME` secret
   refs resolve **supervisor-side** (supervisor may run on another host). Web proxies via an
   admin-gated route; keys never reach the browser.
3. **`anthropic_compatible` (z.ai) → curated GLM list** (GLM-5.1, GLM-5, GLM-5-Turbo,
   GLM-4.7, GLM-4.5-air) — z.ai has **no** listing endpoint (verified 2026-06-10). Optional
   single best-effort authed `GET {base}/models` with graceful fallback; curated is source
   of truth.
4. **A2 active probe** (spawn adapter → `initialize` + `session/new` → read `models` →
   SIGTERM) is the **primary** source, with backend caching. **Passive harvest** from real
   session spawns also lands (free — same code path).
5. **No mid-session model switcher** (out of scope — see §Out of Scope).
6. **No DB persistence** of the catalog — in-memory cache only (one supervisor host).
7. **Mismatch = advisory**, never a run failure. `cost.jsonl` model attribution stays
   ground truth.

## Verified base facts (research 2026-06-10, re-confirmed against `main`)

| Fact | Evidence |
|---|---|
| ACP carries model state: `NewSessionResponse.models?: SessionModelState { availableModels[], currentModelId }` (also on Resume/Load/Fork); client `unstable_setSessionModel()` | `@agentclientprotocol/sdk@0.22.1` |
| `claude-agent-acp@0.37.0` honors `settings.json` `model` (calls `query.setModel()` itself) + `availableModels` allowlist; implements ACP `setSessionModel`; advertises `availableModels` | adapter `dist/acp-agent.js` |
| `codex-acp@0.0.44` enumerates models dynamically (`fetchAvailableModels()` → `listModels()`), list reflects auth mode; implements `setSessionModel` | adapter `dist/index.js` |
| CCR `GET {proxy}/api/config` → `Providers[].models`; `CcrManager.getProxyUrl()`/`ensureRunning()` already own lifecycle | [ccr-manager.ts](supervisor/src/ccr-manager.ts) |
| OpenRouter `GET https://openrouter.ai/api/v1/models` is **public/keyless** | live fetch 2026-06-10 |
| Supervisor reads only `sessionId` from `session/new`; `models` is dropped; `session/resume` response ignored entirely | [acp-client.ts](supervisor/src/acp-client.ts) ~158–243 |
| `childEnv` assembly is **inline** in `spawnSession` (spawn.ts ~202–210), not exported | [spawn.ts](supervisor/src/spawn.ts) |
| `provisionRunnerLaunch()` / `effectiveStartSessionRequest()` build executor+env from a `RunnerLaunch`; `resolveEnvRef()` throws `EXECUTOR_UNAVAILABLE` on missing env; **`openai_compatible` THROWS** "requires Codex profile materialization before spawn" | [runner-provisioner.ts](supervisor/src/runner-provisioner.ts) |
| Supervisor error codes: `PRECONDITION|SPAWN|EXECUTOR_UNAVAILABLE|ACP_PROTOCOL|CHECKPOINT|CRASH|HITL_TIMEOUT` — **no `CONFIG`**; Zod→`PRECONDITION`(409); `httpStatusForCode`: EXECUTOR_UNAVAILABLE→503, ACP_PROTOCOL→500 | [types.ts](supervisor/src/types.ts) |
| M14/ADR-043 materializer writes `<worktree>/.claude/settings.local.json` as `{ permissions:{ allow?, defaultMode? } }` via `mapProfileToAgentArtifacts`; **model not yet materialized** | [materialize.ts](web/lib/capabilities/materialize.ts), [agent-map.ts](web/lib/capabilities/agent-map.ts) |
| **Only ONE live mount** of the runner modal: [acp-runners-panel.tsx](web/components/settings/acp-runners-panel.tsx) (platform `/settings`). **No project-scope runner modal** exists (project settings only pick existing platform runners). Scope B = the single platform modal. | grep of `AcpRunnerModal` |
| HeroUI `@heroui/react@3.0.4` ships `Autocomplete` + `ComboBox`; **neither used anywhere yet** (first adoption) | web/package.json + grep |
| Web→supervisor client: `MAISTER_SUPERVISOR_URL` (default `:7777`), `asMaisterError`/`networkErrorToMaister` | [supervisor-client.ts](web/lib/supervisor-client.ts) |
| Admin gate = `requireGlobalRole("admin")`; stub-supervisor for e2e at `web/e2e/_seed/stub-supervisor.ts` (port 7788) | [authz.ts](web/lib/authz.ts), e2e seed |

## Contract Surface Map (project rule: trace every contract surface to its spec file)

| Surface (this feature adds/changes) | Spec file(s) to update | Phase |
|---|---|---|
| `POST /model-catalog/resolve` (supervisor HTTP route + body/response/status) | `docs/api/supervisor.openapi.yaml` + prose `docs/supervisor.md` | 0B |
| `POST /api/admin/acp-runners/model-suggestions` (web admin proxy route) | `docs/api/web.openapi.yaml` (tag `[admin]`) | 0B |
| Mismatch **advisory** run event (SSE: new `SessionEvent` kind OR `session.update` payload variant — frozen in 0B) | `docs/api/async/supervisor-sse.asyncapi.yaml` (+ `docs/api/async/web-runs.asyncapi.yaml` if bridged to the browser) + flows in `model-catalog.md` | 0B |
| New domain (resolver + sources + cache + application) | NEW `docs/system-analytics/model-catalog.md` (R5) | 0B |
| New ADR (resolver-on-supervisor, source registry, A2 primary, in-memory cache, application channels, mismatch=advisory) | `docs/decisions.md` (tentative **ADR-076** — main owns 072 since 2026-06-11) | 0B |
| New call-sites for existing error codes (no new code) | `docs/error-taxonomy.md` (`CONFIG`/`EXECUTOR_UNAVAILABLE`/`ACP_PROTOCOL` callers) | 0B |
| Resolver component placement + edges | `docs/architecture.md` (component table + C4Component) | 0B |
| Model-discovery added to the resolution narrative | cross-link in `docs/system-analytics/{acp-runners,executors}.md` | 0B |
| **No new** env var / port / sidecar / config-file | — (see House-Rule Compliance §Deployment) | — |
| **No new** DB column / table / index / migration | — (model stays free text; cache in-memory) | — |
| **No new** `runs.status` / enum value | — (mismatch is an advisory run *event*, not a status) | — |
| **No new** `package.json` script | — | — |

## House-Rule Compliance (pre-cleared against project `/aif-plan` rules)

- **Deployment touchpoints:** NONE. The resolver reuses `MAISTER_SUPERVISOR_URL` (web→supervisor),
  the existing provider `env:NAME` mechanism (supervisor `process.env`), and the existing
  `CcrManager`. Probe timeout + cache TTL are **code constants** (not env vars) to avoid new
  deployment surface. → No `.env.example`/compose task required. *(If implementation proves a
  tunable is genuinely needed, adding it pulls in a Deployment-wiring task per the rule.)*
- **Config-state symmetry (YAML→DB):** N/A — nothing persists to DB.
- **Multi-store atomic transition:** N/A — resolver writes no DB state (read-only + in-memory cache).
- **Two-phase commit for downstream side-effects:** N/A — resolve route writes **no** persistent
  state, so there is no idempotency marker to mis-order. (It *does* spawn a probe — covered next.)
- **Deferred-release on every failure path:** **APPLIES** to the ACP probe. The probe spawns a child
  process + opens an ACP connection (a deferred-like resource). EVERY failure path (`initialize`
  reject, `session/new` reject, parse failure, **timeout**) MUST `SIGTERM` the child and close the
  connection before returning. T2.1 carries this as an acceptance criterion + a regression test
  (spy asserts `kill` was called on the simulated-failure path). "Log and continue" is forbidden.
- **Body-controlled cross-resource identifiers:** the resolve body is a runner **draft**
  (`{ adapter, provider, router?, sidecarId? }` + env-ref **names**), not a resource locator into
  live server state. Each route gets an identifiers sub-bullet. `sidecarId` (web route) is
  `body-controlled` → validated against the platform sidecar catalog (`server-state`) before use;
  secrets accepted **only** as `env:NAME` names (regex-validated), resolved supervisor-side, never
  echoed to the client.
- **Trust vs execution (fetch-then-execute):** the probe executes ONLY the already-trusted adapter
  binaries (`claude-agent-acp` / `codex-acp`) — the same binaries used for real runs; no third-party
  fetched content is executed. Provider/CCR sources fetch **data**, not code. → No new trust boundary.
- **Test-runnability + per-phase green:** every phase exit names the runner project that executes its
  tests and requires the touched suite GREEN; any new test-path family that an existing `include`
  glob does not match gets a same-phase runner-config task. Verified globs: supervisor projects
  live in `supervisor/vitest.workspace.ts` — `unit` = `src/**/*.test.ts` +
  `src/**/__tests__/**/*.test.ts` excluding `*.integration.test.ts`; `integration` =
  `src/**/*.integration.test.ts`. New supervisor tests MUST live under `src/**`
  (`supervisor/test/` is fixtures-only, never globbed) with the `.integration.test.ts` suffix for
  the integration project; both globs already cover `src/model-catalog/**` → NO runner-config
  task needed.

## Phase 0A — Spikes (de-risk; throwaway; gate the spec + the application wiring)

> No production code. Each spike produces a short findings note appended to this plan
> (or `docs/spikes/`), feeding Phase 0B. Spike T0A.3 **gates** the application channel in Phase 3.

### T0A.1 — Spike: `claude-agent-acp` probe cost is ~0 tokens
- **Goal:** Confirm `initialize` + `session/new` (no prompt) spends **0** tokens; measure
  wall-clock per probe. Strong prior: Zed does `session/new` on every thread open.
- **Method:** Drive a real `claude-agent-acp` via the supervisor ACP client (or a throwaway
  harness) in a tmp cwd; `initialize` → `session/new` → read `models` → SIGTERM. Measure via
  **absence** of usage in the session jsonl / `cost.jsonl`.
- **Verify:** Findings note states tokens spent (expect 0) + median/95p wall-clock. If non-zero,
  record the amount and decide whether probe stays default-on (design assumes free).
- **Output gate:** probe wall-clock informs the resolver probe-timeout constant (T2.1).

### T0A.2 — Spike: `codex-acp` probe under ChatGPT-plan auth
- **Goal:** Determine whether `session/new` requires a live login, and what `availableModels`
  contains per auth mode (ChatGPT plan vs API key). Determine the **env** codex needs (since
  `provisionRunnerLaunch` throws for `openai_compatible`).
- **Method:** Spawn `codex-acp` in a tmp cwd under the available auth; capture
  `NewSessionResponse.models` + any login requirement; note required env vars.
- **Verify:** Findings note enumerates auth modes, the model list shape per mode, and the env
  assembly codex needs.
- **Output gate:** decides the **codex branch of the probe env assembly** in T2.1 (whether it can
  reuse `provisionRunnerLaunch` or needs the codex materialization path), and whether the codex
  probe must be skipped/degraded under subscription auth (→ a per-source `skipped` status).

### T0A.3 — Spike: claude model-application channel on an env-router (z.ai) runner ⚠ GATES Phase 3
- **Goal:** Pick the channel that **pins** the model cleanly for claude: per-session
  `settings.local.json { model, availableModels }` (M14/ADR-043 channel) **vs** ACP
  `unstable_setSessionModel("glm-5.1")` after `session/new`.
- **Method:** On a z.ai env-router runner, drive a real session each way; read back
  `currentModelId` and confirm the model attributed in `cost.jsonl`.
- **Verify:** Findings note declares the WINNING channel with evidence (which one actually pins,
  incl. the `availableModels` allowlist path for GLM names). Also answer: **is the materializer
  invoked for every claude flow run** (not just scratch)? — this determines whether the
  `settings.local.json` channel needs an always-on write for claude sessions.
- **Output gate:** T3.1 implements the winning channel only.

**Phase 0A exit:** all three findings notes written; T0A.3 verdict recorded. Commit the notes.

## Phase 0B — SDD spec freeze (analytics/design COMPLETE + INTERNALLY CONSISTENT before any code)

> Human-owned checkpoint. The frozen spec is the single source of truth Phase 1–5 follow.
> Tasks are parallelizable (different files) but must be reconciled before the freeze.

### T0B.1 — ADR (tentative **ADR-076**)
- **File:** `docs/decisions.md` (append using the template at file bottom).
- **Content:** resolver-on-supervisor; pluggable `ModelSource` registry keyed by
  `(adapter, provider.kind, router)`; A2 probe = primary; provider-API + curated + CCR sources;
  in-memory cache (no DB); passive harvest; application channels (claude = T0A.3 winner, codex =
  `setSessionModel`); mismatch = advisory event; reuse of existing error codes (no new code).
- **⚠ Number check (re-verified 2026-06-11):** the BRANCH copy still shows max `071`, but MAIN
  already owns **ADR-072** (review-comments-rework merged @ `bca80467`) — grep MAIN, not the
  branch copy:
  `git show main:docs/decisions.md | grep -oE '^### ADR-[0-9]+' | sed 's/.*ADR-//' | sort -n | tail -1`
  → tentative next-free is **073**. Harness-loop (unmerged) also claims 072/073 → re-verify at
  commit time, take next-free, and update every back-reference in T0B.2–T0B.4. Record the chosen
  number once, reference it everywhere.
- **Verify:** `pnpm validate:docs:adr` resolves the new anchor; ADR Status = `Accepted`.

### T0B.2 — New domain doc `docs/system-analytics/model-catalog.md` (R5 full order)
- **Sections (mandatory, in order):** Purpose · Domain entities (sources, draft key, cache entry,
  suggestion DTO, application channel) · State machine (`stateDiagram-v2`: cache entry
  `empty→resolving→fresh→stale→refreshing`) · Process flows (`sequenceDiagram` ×: resolve fan-out,
  ACP probe spawn/SIGTERM, model application per adapter, passive harvest) · **Expectations** (≤12
  normative MUST/NEVER bullets, each testable; cover: secrets never returned to client; probe always
  SIGTERMs on every failure path; cache key components; mismatch never fails a run; curated list is
  z.ai source of truth) · Edge cases (each → `MaisterError` code) · Linked artifacts.
- **R6 status tags** on every described piece (`Designed` pre-code, flip to `Implemented` per phase).
- **Verify:** `pnpm validate:docs:all` green (mermaid + ADR anchors); section order matches R5.

### T0B.3 — API + prose contracts
- **`docs/api/supervisor.openapi.yaml`:** add `POST /model-catalog/resolve` (request =
  draft shape; response = `{ models[], sources[], resolvedAt, ttlSeconds }`; errors via
  `SupervisorErrorBody` — 409 PRECONDITION / 503 EXECUTOR_UNAVAILABLE / 500 ACP_PROTOCOL) + named
  schemas `ModelCatalogResolveRequest` / `ModelCatalogResolveResponse`.
- **`docs/supervisor.md`:** prose contract for the route (sources, cache TTL, `force`, secret
  handling).
- **`docs/api/web.openapi.yaml`:** add `POST /api/admin/acp-runners/model-suggestions`, tag
  `[admin]`, `401`/`403` via existing `$ref`s, response schema (UI DTO grouped by source).
- **`docs/api/async/supervisor-sse.asyncapi.yaml`** (+ `web-runs.asyncapi.yaml` if the event is
  bridged to the browser): spec the T3.3 mismatch **advisory** event. The supervisor
  `SessionEvent` union is CLOSED (`session.line|update|permission_request|exited|crashed`,
  types.ts ~283–323) — freeze HERE whether the advisory is a NEW event kind or a
  `session.update` payload variant; T3.3 implements the frozen shape only.
- **Bare env-ref names:** the supervisor draft takes BARE env names (`envNameSchema` =
  `/^[A-Za-z_][A-Za-z0-9_]*$/`, types.ts ~18–20 — `env:`-prefixed strings are REJECTED by Zod →
  409): document the format on `ModelCatalogResolveRequest`; the web proxy converts via
  `envRefName()` (T4.2).
- **Identifiers sub-bullets (project rule):** supervisor route — all body fields are draft config
  (`body-controlled`), no live-resource locator; env-ref values resolved server-side. Web route —
  `sidecarId` `body-controlled` → validate against sidecar catalog (`server-state`); admin via
  `auth-context`.
- **Verify:** `npx @redocly/cli lint docs/api/supervisor.openapi.yaml docs/api/web.openapi.yaml`
  zero errors + `npx @asyncapi/cli validate` on every touched asyncapi file (zero errors — the
  documented gate in `docs/CLAUDE.md`).

### T0B.4 — Architecture + error-taxonomy + cross-links
- **`docs/architecture.md`:** extend the supervisor `C4Component` mermaid with a
  `model-catalog.ts` component + `Rel(web → http_api)` edge and describe it (plus the web client
  method in `supervisor-client.ts`) in the surrounding prose. NOTE (verified): the doc has NO
  component table — match the existing diagram+prose structure, don't invent table rows.
- **`docs/error-taxonomy.md`:** add the new call-sites under existing codes (ADR-008 closed-union:
  NO new code). `CONFIG` (web: bad/raw secret or unknown env-ref name in draft),
  `EXECUTOR_UNAVAILABLE` (supervisor unreachable / missing env ref / probe spawn fail),
  `ACP_PROTOCOL` (malformed adapter/CCR/provider response).
- **Cross-links:** one sentence + link in `acp-runners.md` and `executors.md` pointing to
  `model-catalog.md` (no rationale duplication — R7).
- **Verify:** `pnpm validate:docs:all` green.

**Phase 0B exit (HARD GATE):** all four tasks reconciled; the chosen ADR number is consistent across
files; `pnpm validate:docs:all` + both OpenAPI lints green; **owner reviews & freezes the spec**.
**Commit checkpoint #1** (`docs(model-catalog): SDD spec freeze — ADR-0xx + model-catalog.md + API specs`).

## Phase 1 — Supervisor resolver core + registry + route (TDD)

### T1.1 — Extract reusable `buildChildEnv` from `spawn.ts` (refactor, no behavior change)
- **Files:** `supervisor/src/spawn.ts` (extract `childEnv` assembly ~202–210 into an exported
  `buildChildEnv(request, { ccrLayer }): NodeJS.ProcessEnv`), call it from `spawnSession`.
- **TDD:** reuse the `spawn-ccr.test.ts` `mockSpawn` env-capture pattern; assert the **exact same**
  `childEnv` precedence (process.env < ccrLayer < executor.env < capabilityProfilePath <
  adapterLaunch.env) before and after the extraction (characterization test).
- **Verify:** `supervisor` unit suite green; no diff in captured env across existing CCR tests.
- **Dep:** none. **Parallel-group P1a.**

### T1.2 — `ModelSource` contract + registry + resolver core + draft schema
- **Files (new):** `supervisor/src/model-catalog/{types.ts, registry.ts, resolve.ts}`.
- **Contract:** `interface ModelSource { kind: SourceKind; supports(draft): boolean;
  resolve(draft, ctx): Promise<{ models: ModelEntry[]; status: SourceStatus }> }` where
  `SourceStatus = { kind, status: "ok"|"skipped"|"error", reason? }`. Registry holds an ordered
  list; `resolveModelCatalog(draft)` runs all `supports()` sources, **merges + dedupes by `id`**
  (first-source-wins on dupes, but `source` tags accumulate), returns
  `{ models, sources, resolvedAt, ttlSeconds }`.
- **Draft Zod schema:** `{ adapter, provider (RunnerProvider union, reused from types.ts), router?:
  "ccr", sidecarId? }`. Reuse `RunnerProviderSchema` from `supervisor/src/types.ts`.
- **Extension doc:** a top-of-file comment + a `model-catalog.md` "How to add a source" note (a new
  adapter/provider kind = a new `ModelSource` module registered in `registry.ts`, resolver core
  untouched).
- **TDD:** registry dedupe/merge, `supports()` routing per `(adapter, provider.kind, router)`,
  per-source status aggregation (one `ok`, one `skipped`, one `error` → all surfaced).
- **Verify:** `supervisor` unit green. **Dep:** none. **Parallel-group P1a.**

### T1.3 — In-memory cache (TTL + force)
- **Files (new):** `supervisor/src/model-catalog/cache.ts`.
- **Spec:** key = stable hash of `(adapter, provider.kind, base_url, sorted env-ref NAMES, router,
  sidecarId)` — **names not values** (no secrets in keys). TTL constant ~3600 s; `force:true`
  bypasses + repopulates. Shared singleton consumed by the route AND passive harvest (T2.4).
- **TDD:** hit within TTL (no source call), miss after TTL, `force` refresh, key isolation across
  differing drafts, **no secret value** in any key.
- **Verify:** `supervisor` unit green. **Dep:** T1.2 (types). **Parallel-group P1b.**

### T1.4 — HTTP route `POST /model-catalog/resolve`
- **Files:** `supervisor/src/http-api.ts` (register inside `registerRoutes`).
- **Spec:** Zod-parse body (`force?` query/body flag) → cache lookup → on miss
  `resolveModelCatalog` → cache set → 200 `{ models, sources, resolvedAt, ttlSeconds }`. Errors via
  `SupervisorError` → existing `setErrorHandler` (Zod→409 PRECONDITION; missing env-ref→503
  EXECUTOR_UNAVAILABLE; malformed source response→500 ACP_PROTOCOL). **Never** include secret values
  in the response or logs.
- **Identifiers:** body = draft config only (`body-controlled`, no resource locator); safe.
- **TDD (integration):** 200 happy path with a stubbed registry; 409 on bad body; 503 on missing
  env ref; cache hit avoids re-resolve; response carries per-source status.
- **Verify:** `supervisor` integration green. **Dep:** T1.2, T1.3. **Parallel-group P1c.**

**Phase 1 exit:** `supervisor` unit + integration green. **Commit checkpoint #2.**

## Phase 2 — v1 sources + passive harvest (parallel after T1.2 contract; TDD each)

### T2.1 — ACP probe source (A2, primary) ⚠ deferred-release acceptance
- **Files (new):** `supervisor/src/model-catalog/sources/acp-probe.ts`; new mock fixture
  `supervisor/test/fixtures/mock-acp-models.mjs` (returns `NewSessionResponse.models`).
- **Spec:** synth a `RunnerLaunch` from the draft (model = throwaway `"model-probe"`,
  `capabilityAgent = adapter`, `permissionPolicy = "default"`); reuse `provisionRunnerLaunch` +
  `buildChildEnv` (T1.1) to assemble env; spawn the adapter binary in an isolated tmp cwd;
  `initialize` → `session/new`; read `NewSessionResponse.models`
  (`{ availableModels[], currentModelId }`) → map to `ModelEntry[]`; **SIGTERM**.
  **codex branch** per T0A.2 (env path, since `provisionRunnerLaunch` throws for
  `openai_compatible` → use the codex env assembly the spike defines; if subscription-only and
  login required → return `status:"skipped"` with reason).
- **Deferred-release (MANDATORY):** wrap spawn→probe→teardown so EVERY exit path (success,
  `initialize` reject, `session/new` reject, parse error, **timeout** via a constant ~15 s) calls
  `child.kill("SIGTERM")` + closes the ACP connection. **Regression test:** simulate a
  `session/new` rejection → assert `kill` was invoked (spy), no orphaned child.
- **Testability:** the probe's spawn accepts `binaryOverride`/`preArgs` injection (the same
  `spawnOverrides` pattern http-api passes to `spawnSession`) so `mock-acp-models.mjs` can stand
  in — that is how every existing adapter test works.
- **TDD (integration):** probe against `mock-acp-models.mjs` returns the advertised list; timeout
  path SIGTERMs; failure path SIGTERMs (the regression above); env assembly reuses
  `provisionRunnerLaunch` (claude/anthropic_compatible/ccr) — assert via captured env.
- **Verify:** `supervisor` integration green. **Dep:** T1.1, T1.2 (+ T0A.1/T0A.2 findings).
  **Parallel-group P2.**

### T2.2 — Provider-API source
- **Files (new):** `supervisor/src/model-catalog/sources/provider-api.ts`.
- **Spec:** `anthropic` → `GET {base ?? api.anthropic.com}/v1/models` (key from `authTokenEnv` via
  `resolveEnvRef`); `openai`/`openai_compatible` → `GET {base ?? api.openai.com}/v1/models` (Bearer
  from `apiKeyEnv`; OpenRouter keyless); `anthropic_compatible` → **curated GLM static list** +
  optional single authed `GET {base}/models` with graceful fallback to curated on any error.
  Network/timeout → `status:"error"` (resolver still returns other sources). Malformed JSON →
  `ACP_PROTOCOL` mapped per-source to `status:"error"` (not a hard 500 unless it's the only source —
  decide in resolver: per-source errors never fail the whole resolve).
- **TDD (unit, mocked `fetch`):** each provider kind maps response→`ModelEntry[]`; missing env ref →
  `status:"error"` reason "env ref not set" (NOT a thrown 500); curated fallback on z.ai 401;
  OpenRouter keyless path.
- **Verify:** `supervisor` unit green. **Dep:** T1.2. **Parallel-group P2.**

### T2.3 — CCR source
- **Files (new):** `supervisor/src/model-catalog/sources/ccr.ts`.
- **Spec:** when `router:"ccr"` → `ccrManager.ensureRunning({instance})` then
  `GET {getProxyUrl(sidecarId)}/api/config` → flatten `Providers[].models` to `"provider,model"`
  names (the format CCR expects). CCR down/unreachable → `status:"error"`.
- **TDD (unit/integration):** NO `mock-ccr.mjs` fixture exists (verified) — stub `CcrManager`
  with `vi.fn()` per the `spawn-ccr.test.ts` ~97–107 pattern + mock `fetch` for
  `GET {proxy}/api/config`; flatten shape; error path.
- **Verify:** `supervisor` green. **Dep:** T1.2. **Parallel-group P2.**

### T2.4 — Passive harvest in `acp-client.ts`
- **Files:** `supervisor/src/acp-client.ts` (read `newSessionResp.models` after `session/new` ~231;
  capture + read the **currently-ignored** `resumeSession` response's `models` ~208) → feed the
  shared cache with `source:"agent_observed"`. Zero extra spawns.
- **Runner-context threading (prerequisite, verified gap):** `createAcpConnection` today receives
  only a `SessionRecord` — NO runner/provider/model is in scope at the response point. Extend
  `CreateAcpConnectionArgs` with the launch runner (`parsed.runner` is available at the SINGLE
  call site, http-api.ts ~224, which covers BOTH create and resume) and derive the cache key from
  it (`RunnerLaunch.provider` already carries BARE env-ref names). T3.2/T3.3 reuse this threading.
- **Spec:** harvest is best-effort and side-effect-free on the live path (never blocks/errs the
  session). Reuses the T1.3 cache singleton + the same key derivation for the live runner snapshot.
- **TDD:** unit asserts a `session/new` response carrying `models` populates the cache; a response
  without `models` is a no-op; harvest failure never throws into the session path.
- **Verify:** `supervisor` unit/integration green. **Dep:** T1.3. **Parallel-group P2.**

**Phase 2 exit:** all sources green; resolver end-to-end with real registry across mocks.
**Commit checkpoint #3.**

## Phase 3 — Model application (the gap fix; gated by T0A.3; TDD)

### T3.1 — claude application (channel = T0A.3 winner)
- **If `settings.local.json` wins:** extend `AgentSettingsLocal` (agent-map.ts) to
  `{ permissions, model?, availableModels? }`; populate `model` (+ `availableModels` allowlist for
  `anthropic_compatible`/CCR with curated/CCR names) in `mapProfileToAgentArtifacts` from the runner
  snapshot. Verified base: `materializeCapabilityProfile` ALREADY receives `executor.model`
  (materialize.ts ~46–51; today written to profile.json only) and runs on BOTH launch paths
  (scratch service + flow runner-graph); the settings write is conditional on
  `artifacts.settingsLocal !== null` (materialize.ts ~248) — the "always-on" fix = return
  non-null `settingsLocal` whenever `model` is set (even with zero permission entries). Backup +
  `.maister-owned` marker machinery already guards overwrite/reclaim — extend CONTENT only.
- **If `setSessionModel` wins:** call ACP `unstable_setSessionModel(model)` in `acp-client.ts` after
  `session/new` for claude when `runner.model` set.
- **Files:** `web/lib/capabilities/{agent-map.ts, materialize.ts}` and/or
  `supervisor/src/{acp-client.ts, spawn.ts}` per the winning channel.
- **TDD:** assert the model (and allowlist for GLM) reaches the chosen channel (settings.local.json
  content OR a `setSessionModel` call spy) for an `anthropic`/`anthropic_compatible`/CCR runner.
- **Verify:** touched unit/integration suites green. **Dep:** T0A.3. **Parallel-group P3.**

### T3.2 — codex application
- **Files:** `supervisor/src/acp-client.ts`.
- **Spec:** after `session/new` AND after `session/resume` (every resume is a fresh adapter
  process; `ResumeSessionResponse` carries `models` too — SDK-verified), if
  `runner.model !== models.currentModelId`, call `unstable_setSessionModel(runner.model)`.
  Runner context comes from the T2.4 `CreateAcpConnectionArgs` threading.
- **TDD (integration):** mock adapter advertising `currentModelId` ≠ runner model → assert
  `setSessionModel` invoked; equal → not invoked; dedicated case for the RESUMED-session path.
- **Verify:** `supervisor` green. **Dep:** T2.4 (runner threading; lands in Phase 2). Independent
  of T3.1. **Parallel-group P3.**

### T3.3 — Verification loop + mismatch **advisory** event
- **Spec:** after application, read back `currentModelId` (set-model response /
  `config_option_update`); on mismatch emit an **advisory** run event (a `session.update`-class
  informational event / run-timeline note) — **NEVER** fail the run (env-router slot-mapping
  legitimately reports mapped names). `cost.jsonl` stays ground truth. **No new `runs.status`,
  no new enum.**
- **Files:** `supervisor/src/acp-client.ts` — emit via the existing emitter → registry
  `eventsLog` channel. The `SessionEvent` union is CLOSED (types.ts ~283–323): implement exactly
  the wire shape frozen in T0B.3 (new event kind OR `session.update` payload variant) — do NOT
  add a status. Acceptance: the web SSE bridge + transcript TOLERATE the new shape (an unknown
  event kind never breaks the stream); applies on both new and resumed sessions.
- **TDD:** mismatch → advisory event emitted AND run status unchanged (assert not `Failed`); match →
  no event.
- **Verify:** green. **Dep:** T3.1/T3.2. **Parallel-group P3 (after T3.1/T3.2).**

**Phase 3 exit:** application suites green; mismatch path proven non-fatal. **Commit checkpoint #4.**

## Phase 4 — Web proxy route + UI ComboBox + i18n (TDD)

### T4.1 — Web supervisor-client method
- **Files:** `web/lib/supervisor-client.ts` — add `resolveModelSuggestions(draft, { force }):
  Promise<ModelCatalogDTO>` (POST to `{base}/model-catalog/resolve`; `asMaisterError(res,
  "EXECUTOR_UNAVAILABLE")`; `networkErrorToMaister`).
- **TDD (unit):** success maps DTO; 409→`CONFIG`/`PRECONDITION` mapping; network→
  `EXECUTOR_UNAVAILABLE`.
- **Verify:** web unit green. **Dep:** Phase 1 contract. **Parallel-group P4a.**

### T4.2 — Admin proxy route `POST /api/admin/acp-runners/model-suggestions`
- **Files (new):** `web/app/api/admin/acp-runners/model-suggestions/route.ts`.
- **Spec:** `await requireGlobalRole("admin")` first; accept the draft + env-ref **NAMES** only
  (never raw secrets — reject raw secret with `CONFIG`/`422`, reuse `env:NAME` validation);
  validate `sidecarId` against the platform sidecar catalog (server-state) before forwarding; call
  `resolveModelSuggestions`; normalize to the UI DTO (grouped by source). Secrets never returned.
- **Conventions (verified):** there is NO shared route error helper — copy the per-route local
  `statusForCode` + `errorResponse` pattern from `web/app/api/admin/acp-runners/route.ts` ~83–120
  (`CONFIG`→422 confirmed there); `requireGlobalRole` first, `parseJson` → `CONFIG`. Convert UI
  `env:NAME` refs → BARE supervisor names via `envRefName()` (`spawn-intent.ts` ~15–20) before
  forwarding — supervisor `envNameSchema` REJECTS `env:`-prefixed strings (skipping this 409s
  every env-router/CCR draft at integration).
- **Identifiers:** admin via `auth-context`; `sidecarId` `body-controlled`→validated vs catalog;
  env-ref names `body-controlled`→shape-validated, resolved supervisor-side only.
- **TDD (route):** 403 for non-admin; 200 grouped DTO with stubbed client; raw-secret body →
  `CONFIG`/422; unknown `sidecarId` → `CONFIG`/422.
- **Verify:** web route test green. **Dep:** T4.1. **Parallel-group P4a.**

### T4.3 — `acp-runner-modal.tsx` model field → HeroUI `Autocomplete`/`ComboBox`
- **Files:** `web/components/settings/acp-runner-modal.tsx` (+ a small client hook for fetch/debounce
  if cleaner). First adoption of `@heroui/react` `Autocomplete` — confirm the 3.0.4 import/prop API
  (`allowsCustomValue`, sections/items) against installed types.
- **Spec:** `allowsCustomValue` (free text always valid; unknown model on save = **advisory hint**,
  NOT a validation error — `validateRunnerDraft` keeps `model.min(1)` only). Suggestions grouped by
  source (Agent / Provider / CCR / Preset) with an origin badge. Resolve on **modal open** + on
  **adapter / providerKind / baseUrl / sidecarId(router)** change (debounced ~400 ms) — **NOT** per
  keystroke (probe spawns a process). Loading state + manual **refresh** (`force:true`). Presets in
  `presets.ts` stay the offline fallback layer. Build to the data-management page bar (a11y: label,
  `aria`, focus). Send only env-ref **names** to T4.2 (the draft already stores `env:NAME`).
- **TDD (component, `renderToStaticMarkup`, no jsdom):** model field renders as the combobox;
  grouped sections + badges present given seeded suggestions; custom value path preserved; loading +
  refresh affordances present (assert on i18n keys per the mock-returns-key convention).
- **Verify:** web component test green; scoped eslint on touched files only.
- **Dep:** T4.2 (route), T4.4 (keys). **Parallel-group P4b.**

### T4.4 — i18n EN + RU
- **Files:** `web/messages/en.json` + `web/messages/ru.json` (`settings` namespace): keys for
  suggestions-loading, suggestions-empty, source group labels (Agent/Provider/CCR/Preset), refresh,
  unknown-model advisory hint.
- **TDD:** extend `web/lib/__tests__/i18n-acp-runner-keys.test.ts` (EN/RU parity for the new keys).
- **Verify:** web unit green. **Dep:** none. **Parallel-group P4a.**

**Phase 4 exit:** web unit + component + route tests green; scoped lint clean. **Commit checkpoint #5.**

## Phase 5 — Integration + e2e + verification

### T5.1 — Supervisor end-to-end resolve integration
- **Spec:** boot supervisor with mock adapter (`mock-acp-models.mjs`) + `mock-ccr.mjs` + mocked
  provider `fetch`; assert merged/deduped catalog with per-source status; cache hit/miss/force;
  error mapping (409/503/500).
- **Verify:** `supervisor` integration green. **Dep:** Phases 1–2.

### T5.2 — Web e2e (stub-supervisor)
- **Spec:** extend `web/e2e/_seed/stub-supervisor.ts` to answer `POST /model-catalog/resolve` with a
  seeded grouped catalog. e2e: admin opens the runner modal on `/settings` → suggestions render
  grouped with badges → selecting a suggestion fills `model` → a custom value also saves.
  **Kill ports 3100/7788 first**; **baseline-prove** any pre-existing e2e reds at the base commit
  before attributing them to this branch (per project memory — shared infra trap; never
  `test:e2e -- --last-failed`).
- **Verify:** `pnpm test:e2e` targeted spec green; pre-existing reds proven at base.
- **Dep:** Phase 4.

### T5.3 — Application integration (claude + codex)
- **Spec:** mock adapter assertion that the configured model reaches the chosen channel
  (settings.local.json content OR `setSessionModel` call); mismatch path emits the advisory event
  and the run is **not** `Failed`.
- **Verify:** `supervisor` (+ web if settings channel) integration green. **Dep:** Phase 3.

### T5.4 — Final verification + docs flip
- Flip R6 status tags in `model-catalog.md` (+ architecture rows) `Designed → Implemented`.
- Run: `supervisor` unit+integration, web unit+component+route, targeted e2e, `pnpm
  validate:docs:all`, both OpenAPI lints, scoped eslint on the full touched set.
- Surgical-diff audit: every changed line traces to this feature.
- **Verify:** all green; spec matches as-built. **Commit checkpoint #6.**

## Commit Plan

| # | After | Message (conventional) |
|---|---|---|
| 1 | Phase 0B | `docs(model-catalog): SDD spec freeze — ADR-0xx + model-catalog.md + supervisor/web API specs` |
| 2 | Phase 1 | `feat(supervisor): model-catalog resolver core + source registry + /model-catalog/resolve` |
| 3 | Phase 2 | `feat(supervisor): ACP-probe/provider/CCR sources + passive model harvest` |
| 4 | Phase 3 | `feat(runner): apply configured model to claude + codex sessions (advisory mismatch)` |
| 5 | Phase 4 | `feat(web): model-suggestions admin proxy + runner-modal combobox + EN/RU i18n` |
| 6 | Phase 5 | `test(model-catalog): integration + e2e + docs status flip` |

Phase 0A spike notes commit with Phase 0B (or standalone `chore(spike): …` if you prefer).

## Parallelization Map (agent-teams execution)

- **Phase 0A:** T0A.1 / T0A.2 / T0A.3 — independent, run in parallel (3 agents).
- **Phase 0B:** T0B.1–T0B.4 — parallel authoring, single reconcile+freeze gate.
- **Phase 1:** T1.1 ∥ T1.2 (P1a) → T1.3 (P1b) → T1.4 (P1c). T1.1 and T1.2 are independent.
- **Phase 2:** T2.1 ∥ T2.2 ∥ T2.3 ∥ T2.4 — four independent source modules (one barrier: all share
  the T1.2 contract + T1.3 cache).
- **Phase 3:** T3.1 ∥ T3.2 → T3.3.
- **Phase 4:** (T4.1 ∥ T4.4) → T4.2 → T4.3.
- **Phase 5:** T5.1 ∥ T5.3 → T5.2 → T5.4.
- **Hard barriers:** Phase 0A → 0B (spikes feed spec); Phase 0B freeze → all code; T0A.3 → T3.1.

## Out of Scope (design §5 — do NOT plan/build)

Mid-session model switching; model selector near the run prompt input; catalog persistence to
Postgres; LiteLLM managed sidecar (usable today as a plain compatible provider); structured
`usage_update` capture upgrade; adapter vendoring/patching.

## Open Questions (кратко, RU)

1. **ADR №:** main уже владеет ADR-072 (review-comments merged 2026-06-11, `bca80467`; копия на
   ветке всё ещё показывает 071) → беру **073**. Harness-loop (несмерженный) тоже метит 072/073 →
   перепроверить next-free ПО MAIN (`git show main:docs/decisions.md`) при коммите Phase 0B;
   коллизия → следующий свободный. Ок?
2. **Новый doc `model-catalog.md`** vs расширение `acp-runners.md`? Рекомендую отдельный doc
   (чище по R5). Согласен?
3. **Канал применения для claude** решает спайк T0A.3 (settings.local.json vs setSessionModel).
   Если победит settings.local.json — нужно ли гарантированно писать `model` для **всех** claude
   ран-сессий (не только scratch)? Подтвердить scope после спайка.
4. **Codex-проба:** `provisionRunnerLaunch` кидает на `openai_compatible`. Сборку env для codex-пробы
   определяет спайк T0A.2. Если под ChatGPT-подпиской нужен живой логин — codex-источник
   деградирует в `status:"skipped"`. Приемлемо для v1?
5. **Milestone M29** — номер предварительный (соседние ветки могут метить M29). Финализировать через
   `/aif-roadmap` при мерже. Ок?
6. **TTL/таймаут пробы — константы** (без env-var), чтобы не плодить deployment-поверхность.
   Если нужна операционная настройка — добавить env-var + Deployment-wiring задачу. Оставляем
   константами на v1?
