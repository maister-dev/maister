# M17 — HITL Hybrid Surface (assessment taxonomy, cross-project inbox, inline response, HITL-over-MCP)

> Roadmap milestone **M17**. Unify the human-in-the-loop surface that prior
> milestones built piecemeal: render the `human` step's review / send-back flow
> through M11a typed decisions, M11b manual takeover, M12 evidence graph, M13
> assignment states, M14 capability-profile display, and M15 readiness summary —
> inline on the task card, on a cross-project Inbox block on the portfolio home,
> behind a precise "Needs you (N)" badge. Adds the HITL `confidence`/`criticality`
> assessment taxonomy and HITL-over-MCP (the ADR-024 clause M16 parked here), and
> closes the flat-runner `on_reject.goto_step` send-back gap.

**Branch:** `feature/m17-hitl-hybrid-surface` — **created 2026-06-04** from HEAD
(`main`-equivalent: `main...HEAD` = `0 0`; carries shipped M11a–c/M12/M13/M15/M16/M18/M19/M21).
**Created:** 2026-06-04
**Engine baseline:** `MAISTER_ENGINE_VERSION = 1.2.0` (M12). **No engine bump in M17** — all additive (columns, routes, DSL fields).
**Anchor ADRs:** ADR-050 (HITL assessment taxonomy — closes the ADR-024 `confidence`/`criticality` clause), ADR-051 (HITL response service + HITL-over-MCP + token-actor), ADR-052 (flat-runner `on_reject` atomic execution), ADR-053 (HITL hybrid-surface composition).

---

## Settings

- **Testing:** YES — **strict TDD** (RED → GREEN → adversarial review) per phase. Non-negotiable (user: "implementation TDD-driven").
- **Logging:** Verbose — `pino` child loggers per new module (`hitl-service`, `hitl-mcp`, `flat-rework`). DEBUG on the flat-runner repark path and the respond-service actor-resolution branch; INFO on every HITL response + every cross-project inbox query + every ext-HITL action (audited); WARN on validation/auth failure class; ERROR on supervisor-deliver / artifact-write failure. NEVER log token secrets, hashes, or HITL response payloads that may contain secrets.
- **Docs:** YES — mandatory docs-first **Phase 0** (SDD spec-freeze) gating all code phases; final as-built reconciliation in Phase 7. `pnpm validate:docs:all` is a phase gate.
- **Roadmap linkage:** see `## Roadmap Linkage`.
- **Method:** SDD (spec-frozen Phase 0 = single source of truth) + multiagent per-phase TDD (see `## Multiagent Execution Model`). Mirrors M16/M19 as-built method.

## Roadmap Linkage

- **Milestone:** "M17. HITL hybrid surface"
- **Rationale:** Implements M17 against current codebase reality — the underlying machinery (M11a typed-decision buttons, M11b takeover panel, M12 evidence graph, M13 per-project inbox + assignment actions, M14 capability-profile **display**, M15 readiness summary, M9 portfolio `NeedsYouStrip`/`totalNeeds`) is **already shipped**; M17 is the *composition* layer plus the two pieces M16 explicitly deferred here. Scope confirmed **Full** with the user (2026-06-04): UI hybrid surface **+ HITL `confidence`/`criticality` fields + HITL-over-MCP tools**. Closes ADR-024's HITL-assessment clause (re-scoped to M17 by ADR-045) so it is not re-deferred. M14 remains `[ ]` (enforcement-flip blocked per ADR-041); M17 consumes only its already-shipped capability-profile **display** (ADR-043).

---

## Scope Decisions (locked with user, 2026-06-04)

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | **Full scope: UI hybrid surface + `confidence`/`criticality` fields + HITL-over-MCP.** | Adds a DB-migration phase (assessment columns), a service-extraction phase, and an MCP/ext-routes phase on top of the pure-UI surface. Closes ADR-024's parked HITL clause (ADR-045 pointer) — recorded in **ADR-050/051**. |
| D2 | **Cross-project Inbox = a BLOCK on the portfolio home** (`app/(app)/page.tsx`), not a new `/inbox` route. Lifts `getHitlInbox` to portfolio scope (all pending items across visible projects, not the one-item-per-project `NeedsYouStrip`). | No new nav destination/route. Reuses the per-project inbox row rendering. The existing `NeedsYouStrip` (one-per-project) is **replaced/absorbed** by the full block; the compact "Needs you (N)" badge stays. Recorded in **ADR-053**. |
| D3 | **Close the flat `steps[]` runner `on_reject.goto_step` gap** (not graph-only). Implement the goto jump + `comments_var` injection in `runner.ts` with a single atomic `currentStepId` repark + crash-window recovery. | Touches the legacy linear runner. Flips `hitl.md`/`flow-dsl.md`/`database-schema.md` "Designed loop" → "Implemented". Higher-risk; governed by `## Multi-Store Atomicity` below. Recorded in **ADR-052**. |
| D4 | **`criticality` = flow-author-declared metadata** (`low\|medium\|high`) on the `human` node/step, stored on `hitl_requests.criticality` at creation. **`confidence` = responder self-reported certainty** (numeric `0..1`), captured at response time, stored on `hitl_requests.human_confidence` + echoed in `response` jsonb. | Distinct from the **existing** `GateVerdict.confidence` (M15 AI-judge machine confidence on `gate_results.verdict`). Surfaced in HITL surfaces (criticality badge/sort, confidence on the decision/evidence). **Annotates, does NOT re-gate** readiness — the escalate-to-human decision stays the Flow's `human_review` gate (ADR-024 clause), never the external actor's. Recorded in **ADR-050**. |
| D5 | **HITL-over-MCP = `hitl_list` + `hitl_respond` tools** in the existing `@maister/mcp` package, backed by **new `/api/v1/ext/runs/{runId}/hitl[/{hitlRequestId}/respond]`** routes (scopes `hitl:read`/`hitl:respond`). Both reuse a **newly-extracted `web/lib/services/hitl.ts`** (mirrors M16's `createTask`/`launchRun` extraction). Token actor recorded via new `ensureApiTokenActor`. | The session respond route and the ext routes share ONE two-phase-commit implementation (no duplicate). A token actor may answer pending `permission`/`form` HITL within its project; **`human`-kind requests (incl. `human_review`) require a human actor — see D7**; it can never create or skip a gate (the Flow owns gate placement). Existence-hide trust boundary (`run.projectId == token.projectId` else 404). Recorded in **ADR-051**. |
| D6 | **No new `runs.status`. No engine bump.** Migrations `0022` (assessment columns) + `0023` (actor-token uniqueness) are additive. | The HITL surface reuses the existing `NeedsInput`/`NeedsInputIdle` states and the existing respond two-phase commit. Confirmed against the skill-context "fan a new status/route out to ALL consumers" rule: **only new routes + columns + scopes fan out** (enumerated in `## New-Surface Consumer Fan-Out`); the run-status state machine is unchanged. |
| D7 | **Answering a `human`-kind HITL requires a human actor** (adversarial-review finding, codex CRITICAL). `respondToHitl` refuses any `actor.kind !== "user"` on `hitlRow.kind === "human"` (covers linear `on_reject` human steps AND graph `human_review`) → `UNAUTHORIZED` (403). Token / internal-agent actors may answer only `kind ∈ {permission, form}`. | Makes ADR-024's "escalate-to-human is a Flow gate, never the external actor's" executable — a machine token can never satisfy a human gate, even holding `hitl:respond` scope. HITL-over-MCP stays useful for the machine-appropriate `permission`/`form` cases. Recorded in **ADR-051**; tested in P6 (T6.1 a1). Supersedes the prior Open Question on MCP answering `human_review` (→ **no**). |
| D8 | **HITL ext routes enforce token scope** (adversarial-review finding, codex CRITICAL) via an **opt-in `requireScope: true` on `handleExt`**: the route's `scopeLabel` must be in `actor.scopes` or `"*"` → else 403. ONLY the two new HITL routes opt in; all other `/api/v1/ext/*` routes keep ADR-046 binary enforcement unchanged. | Closes the "scope labels are audit-only" gap for the most sensitive surface **without** reopening ADR-046's global binary model (a separate, deferred decision). No-op for today's `["*"]`-issued tokens; future-proof the moment granular issuance lands. The real-time boundary remains D7. Recorded in **ADR-051**; tested in P6 (T6.1 a2). |

---

## Current-State Grounding (verified by exploration, 2026-06-04)

**Already shipped — M17 composes, does not rebuild:**

- **HITL data + two-phase respond**: `hitl_requests` (`web/lib/db/schema.ts:1246`) with `kind ∈ {permission,form,human}`, `decision`/`workspacePolicy`/`reworkTarget` (M11a). Respond route `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts` (1058 lines): `handlePermissionResponse` + `handleFormHumanResponse`, full two-phase commit (Phase-1 tx `SELECT … FOR UPDATE` via `lockHitlRow:125`; idempotency marker `respondedAt`; allow-list `PENDING_FORM_RUN_STATUS = {"NeedsInput","NeedsInputIdle"}:54`; `assertReviewDecision` at Phase 0; `decision`/`workspacePolicy`/`reworkTarget` written inside the Phase-1 tx). **No `web/lib/services/hitl.ts` exists** — logic is inline in the route.
- **Validation SSOT**: `web/lib/flows/hitl-validate.ts` — `validateReviewDecision`/`assertReviewDecision` (imperative, no Zod), `ResolvedReviewDecision = {decision, workspacePolicy?, reworkTarget?}:118`, `isReviewSchema` discriminates on `schema.review === true`.
- **M11a typed-decision UI**: `web/components/board/run-hitl-response.tsx` (`"use client"`, 235 lines) — three branches (graph `human_review` decision buttons + comments; `permission` options; `form/human` raw-JSON). POSTs to the respond route, then `router.refresh()`. No `onRespond` callback, no `compact` variant, no confidence/criticality input.
- **M11b takeover**: `web/components/board/run-takeover-actions.tsx` + `ledger.ts` (`getActiveTakeover`). **M12 evidence graph**: `web/components/board/evidence-graph.tsx` + `buildEvidenceGraph`. **M13 inbox/assignments**: `web/components/board/{hitl-inbox,hitl-actions,assignment-actions}.tsx` + `web/lib/queries/hitl.ts::getHitlInbox(projectId)` (project-scoped). **M14 capability display**: `web/components/board/panels/capability-profile-panel.tsx` + `getRunCapabilityProfiles` (shipped; enforcement-flip blocked, M14 `[ ]`). **M15 readiness**: `web/components/run/readiness-summary.tsx` + `readiness-core.ts::rollupReadiness` + `computeReadinessByRun` (batched, used by board + portfolio).
- **Portfolio cross-project feed**: `web/lib/queries/portfolio.ts::getPortfolio` builds `effectiveNeedRows` = assignments (`open|claimed`) ∪ legacy `hitl_requests` (unanswered, `NeedsInput|NeedsInputIdle`) deduped by `runId` (`:485`); `pendingHitlCount` per project + `totalNeeds`. `NeedsYouStrip` (`needs-you-strip.tsx`) renders **one item per project**; `ProjectCard` has `pendingHitlCount` in the DTO but renders **no badge**.
- **External API + MCP (M16)**: `handleExt` wrapper (`web/app/api/v1/ext/.../ext-handler.ts`) — token verify → `{tokenId,projectId,actorLabel,scopes}`, `recordTokenAudit`, `successAuditInWork` opt-in. Scopes are string labels (`tasks:create`, `runs:launch`, `readiness:read`, `gates:report`, …); **enforcement is binary** (scope label is audit-only, not yet gated). MCP package `mcp/src/` — `TOOL_SPECS` + `resolveRouting` + `dispatchTool`; 8 tools; auth via stdio env `MAISTER_PROJECT_TOKEN` or HTTP per-request inbound bearer (ADR-047, never falls back to env under HTTP). Services `web/lib/services/{tasks,runs}.ts` (M16 extraction precedent).
- **Actor identities**: `actorIdentities` (`schema.ts:283`) `kind ∈ {user,api_token,internal_agent,system}`; `ensureUserActor` upserts on unique `(projectId,userId)`. **No unique on `(projectId,tokenId)`** and no `ensureApiTokenActor`.

**The flat-runner gap (D3):**

- `web/lib/flows/runner.ts::runFlow` is the single entry; dispatches **flat `steps[]`** via `executeStep` loop (`:295` `allSteps = manifest.steps ?? []`; `resumeIndex = findIndex(currentStepId):297`; `stepsToRun = allSteps.slice(resumeIndex):323`; linear `for..of`, **no jump mechanism**) OR **graph `nodes[]`** via `runGraph`. Manifest declares exactly one of `steps[]`/`nodes[]` (`config.schema.ts:611` refine).
- `runHumanStep` (`runner-human.ts`) persists `on_reject` only into `needs-input.json` (`:206`), **not** the `hitl_requests` row (insert at `:217` carries only id/runId/stepId/kind/schema/prompt); `kind = on_reject ? "human" : "form"` (`:214`). On resume it returns `{ok:true, vars: input-<stepId>.json}` and the flat runner **advances unconditionally** — `on_reject.goto_step`/`comments_var` are never read.
- Flat runner status writes: per-step `currentStepId` write at loop top (`:327`); NeedsInput write `{status:"NeedsInput",currentStepId}` (`:407`); terminal `{status,endedAt,currentStepId:null}` (`:573`). The only CAS is the `NeedsInput→Running` resume claim (tx `:230`). **No single CAS covers "repark `currentStepId` to the goto target + invalidate skipped step_runs".**
- **No shipped flow uses flat `human`+`on_reject`** (only test fixtures + `plugins/aif/flow.yaml` is graph). The graph runner already implements rework/send-back fully (`runner-graph.ts:1497` rework, `commentsVar` injection `:1523`). D3 closes the linear path for parity + because the user requested it.

**Migrations / docs anchors:**

- Highest migration on disk: `web/lib/db/migrations/0021_m18_workspace_branch_promotion.sql` → next **`0022`**, then **`0023`**. `drizzle-kit generate` (random suffix replaced by milestone tag); journal `migrations/meta/_journal.json`.
- Last ADR: **ADR-049** → next **ADR-050**. ⚠ **Pre-existing doc bug**: two distinct `### ADR-048` headings exist (M15 readiness at `decisions.md:2556`, M18 branch-targeting at `:2747`). Phase-0 consistency reviewer should **flag** it (TODO at bottom of `decisions.md` per docs R9); M17 does **not** renumber (immutable history, surgical-changes).
- Docs that exist and will be edited: `system-analytics/hitl.md` (R5; the "Designed loop: on_reject.goto_step" note at the human-review sequence diagram), `db/hitl-domain.md` (ERD, no `on_reject_goto` col), `database-schema.md` (`## hitl_requests` `:990`; narrative says `kind=human` wire-equivalent to `form`, loop "designed"), `api/web.openapi.yaml` (`POST …/respond` `:1348`, tag `hitl` `:97`), `api/external/operations.openapi.yaml` (paths + `projectToken` scheme `:409`, tags tasks/runs/readiness/gates — no hitl), `flow-dsl.md` (`### human step` `:550` — no confidence/criticality), `error-taxonomy.md` (token-auth section `:169`), `configuration.md` (`flow.yaml` human-node settings `:448`, env table `:699`).
- Test harness: vitest **`unit`** project globs `lib/**/*.test.ts`, `lib/**/__tests__/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`, `components/**/*.test.ts`, `components/**/__tests__/**/*.test.ts` (excludes `*.integration.test.ts`); **`integration`** globs `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts` (60 s). Component tests use `renderToStaticMarkup(createElement(...))` — **cannot** render `"use client"` hook components (split a pure display subcomponent). MCP package has its own `vitest.config.ts`. Playwright `AUTHED_SPEC` regex (`playwright.config.ts:20`) does **not** include `m17-` — **must add `|m17-.*`** or the spec falls into the unauthenticated project.

---

## Multiagent Execution Model

Mirrors the M16/M19 as-built method ("SDD docs-first Phase 0 + per-phase QA(RED)→implementor(GREEN)→adversarial-reviewer with executable phase gates"). Driven by `/aif-implement` (`implement-coordinator`); one phase = one checkpoint commit.

**Roles per code phase (3 hand-offs):**
1. **Tester (RED)** — writes failing unit+integration tests from the Phase-0 frozen spec ONLY. Names the runner project for each test; confirms the `include` glob matches (`vitest list`). No implementation. Exit: tests exist and fail for the right reason.
2. **Implementor (GREEN)** — minimal code to pass RED + spec. Verbose logging. No scope creep. Exit: `pnpm typecheck` 0 + the phase's tests green.
3. **Adversarial reviewer** — `code-reviewer` + `security-sidecar` + `rules-sidecar` (and `codex:rescue` for the trust-boundary + flat-runner-atomicity passes). Hunts the specific failure classes in each phase's "Reviewer focus". Findings fixed before the phase commit.

**Phase 0 roles:** parallel `docs-architect`/`backend-architect` per doc domain (ADRs, system-analytics, ERD, OpenAPI, flow-dsl) → consistency reviewer cross-checks the artifact families against each other and against the planned migrations before freeze.

**Global gate (every phase):** `pnpm typecheck && pnpm test:unit && pnpm test:integration` GREEN; relevant `pnpm test:e2e` GREEN; `pnpm validate:docs:all` GREEN; `pnpm lint` clean; MCP package `pnpm --filter @maister/mcp test` GREEN when touched. A test the phase touches left RED fails the phase (quarantine only via explicit `*.skip` + reason + tracked follow-up).

---

## Contract-Surface → Spec-File Trace (skill-context rule)

Every external-facing contract surface M17 changes, and the spec file naming it. Implementation has this checklist; `/aif-verify` re-derives it from the diff.

| Surface | Spec file(s) | Phase |
|---------|-------------|-------|
| `hitl_requests` gains `criticality`, `human_confidence` columns | `docs/database-schema.md` + `docs/db/hitl-domain.md` (ERD) | 0, 2 |
| `actor_identities` gains unique `(project_id, token_id)` (partial: `kind='api_token'`) | `docs/database-schema.md` + `docs/db/erd.md` (+ projects-domain or integrations-domain ERD) | 0, 6 |
| `flow.yaml` `human` node/step gains `criticality` (`low\|medium\|high`); responder `confidence` capture is response-time (not declared) | `docs/flow-dsl.md` (`### human step`) + `web/lib/config.schema.ts` (`humanSettingsSchema`, `humanStepSchema` — additive, no engine bump) + `docs/configuration.md` (node settings) | 0, 2 |
| `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond` body accepts optional `confidence` (0..1) on form/human/review responses | `docs/api/web.openapi.yaml` (`respondHitl` requestBody) | 0, 2 |
| **new** `GET /api/v1/ext/runs/{runId}/hitl` (`hitl:read`) | `docs/api/external/operations.openapi.yaml` (+ `hitl` tag) | 0, 6 |
| **new** `POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond` (`hitl:respond`) | `docs/api/external/operations.openapi.yaml` | 0, 6 |
| **new** MCP tools `hitl_list`, `hitl_respond` (REST client of the two ext routes) | `docs/api/external/operations.openapi.yaml` (the surface they wrap) + `docs/architecture.md` (MCP tool count) + `docs/flow-dsl.md` (MCP facade tool list) | 0, 6 |
| Flat `steps[]` `human` `on_reject.goto_step` + `comments_var` now **executed** (Designed→Implemented) | `docs/system-analytics/hitl.md` (human-review process flow) + `docs/flow-dsl.md` (`### human step`) + `docs/database-schema.md` (drop the "loop designed" caveat) | 0, 3 |
| HITL `confidence`/`criticality` surfaced in hybrid surfaces (inline card form, cross-project inbox, evidence/decision record) | `docs/system-analytics/hitl.md` (Expectations) | 0, 4, 5 |
| Cross-project Inbox block + "Needs you (N)" badge composition | `docs/system-analytics/hitl.md` (Process flows) + `docs/architecture.md` (Component note: portfolio inbox) | 0, 5 |
| New scope labels `hitl:read`/`hitl:respond` **+ `handleExt.requireScope` enforcement (D8)** | `docs/error-taxonomy.md` (token-auth 403) + `docs/api/external/operations.openapi.yaml` (security-scheme carve-out + 403) + `docs/system-analytics/hitl.md` (Expectations) | 0, 6 |
| **Actor-kind gate (D7): `human`-kind HITL requires a human actor** | `docs/system-analytics/hitl.md` (Expectations) + `docs/api/external/operations.openapi.yaml` (403 for `human` by token) + `docs/decisions.md` (ADR-051) | 0, 6 |
| ADR-050/051/052/053 | `docs/decisions.md` | 0, 7 |

**No new env var / port / sidecar** (skill-context deployment-touchpoint rule): M17 adds DB columns, web routes, DSL fields, MCP tools (shipped in the **existing** `@maister/mcp` package). `.env.example`, `compose*.yml`, bound ports are **unchanged**. Stated explicitly so the gap is intentional, not silent.

**Fetch-then-execute trust rule:** N/A — M17 fetches/installs no third-party content and executes no hooks.

---

## HTTP Identifier Trust-Boundary Table (skill-context rule)

Every identifier each new/changed route consumes, labeled. **No `body-controlled` cross-resource locator is admitted** — cross-resource ids derive from the URL and re-validate against the token's `project_id` (server-state). Mismatch → 404 (existence-hide) cross-project.

| Route | Identifier | Label | Guard |
|-------|-----------|-------|-------|
| `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond` (session; **changed: +confidence body**) | `runId`, `hitlRequestId` | url-param | unchanged: `requireProjectAction(run.projectId,"answerHitl")` (session); `hitlRow.runId == runId` (404 else) |
| same | `confidence` | body-controlled **data** | Zod `number().min(0).max(1)`; NOT a locator; written to `human_confidence` in Phase-1 tx |
| `GET /api/v1/ext/runs/{runId}/hitl` (**new**) | bearer token | auth-context | `handleExt` → `{tokenId,projectId,actorLabel}` (server-issued) |
| same | `runId` | url-param | `run.projectId == token.projectId` else **404** (existence-hide) |
| `POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond` (**new**) | bearer token | auth-context | `handleExt` |
| same | `runId`, `hitlRequestId` | url-param | `run.projectId == token.projectId` else 404; `hitlRow.runId == runId` else 404 |
| same | `optionId`/`response`/`confidence` | body-controlled **data** | validated by the shared `respondToHitl` service (same Zod/allow-list as the session route); `decision` validated against server-state `schema.allowedDecisions` (never body-trusted) |
| both new HITL routes | token `scopes` | auth-context | **D8**: `handleExt({requireScope:true})` — `scopeLabel ∈ actor.scopes ∥ "*"` else **403** (response does not leak which scopes the token holds) |
| `POST …/hitl/{id}/respond` (ext) | `hitlRow.kind` | server-state | **D7**: `kind === "human"` requires `actor.kind === "user"` else **403**; token/agent actors limited to `permission`/`form` |

Token actor: the ext respond path uses `ensureApiTokenActor({projectId: token.projectId, tokenId: token.tokenId, label: token.actorLabel})` for assignment attribution; the project scope is `handleExt`'s `ctx.projectId == run.projectId` check (replaces the session RBAC gate). The external actor can answer a pending request but cannot create one or alter gate placement (ADR-024 / ADR-051).

---

## Multi-Store Atomicity & Two-Phase Commit (skill-context rule)

**(a) Flat-runner `on_reject` repark (D3 / ADR-052) — the highest-risk transition.** On resume after a `human` step response that routes to reject, the runner reparks to `on_reject.goto_step` and ensures the steps in the re-execution window `[gotoTarget..humanStep]` actually re-run (incl. the triggering human step re-prompting). This is a **multi-store transition** (`runs.currentStepId` + `step_runs` rows + the on-disk `input-<stepId>.json` completion sentinels + the comments side-channel). Requirements (generalizing the two-phase-commit rule):

1. **The comments channel is NOT a completion sentinel (adversarial-review finding, codex HIGH).** `runHumanStep` treats `input-<stepId>.json` as the step's completion artifact (`runner-human.ts:131-151` returns `ok:true` + SKIPS HITL creation when it exists). The reviewer's `comments_var` MUST therefore be injected via a **dedicated** `rework-comments-<gotoStepId>.json` (overwrite-safe, never a completion sentinel), read into the target step's context under `comments_var` through a new `buildContext`/`executeStep` `injectedVars` param — mirroring the graph runner's in-memory `pendingInjectedVars` (`runner-graph.ts:1515-1535`) but durable. Writing comments into `input-<gotoStep.id>.json` is **forbidden** — it would falsely auto-satisfy a human/form goto target.
2. **Stale completion sentinels MUST be invalidated for the re-execution window (the deeper bug behind the finding).** A backward repark re-reaches the triggering human step (and any human/form step between target and it); their prior-pass `input-<stepId>.json` would auto-satisfy with the **stale reject** and the loop would never re-prompt. On repark, the runner deletes `input-<stepId>.json` for every step in `[gotoTarget..humanStep]`. **Ordering is delete-sentinels (fs) → repark-CAS-commit (DB)** so a crash between them is benign (see 4). The canonical `input-<stepId>.json` contract for the **non-rework path is unchanged**.
3. **One transaction for the durable repark.** A SINGLE `db.transaction`: CAS `runs {currentStepId := gotoStep.id}` guarded on `status='Running' AND currentStepId=<humanStepId>` (the just-claimed resume state). New `step_runs` are created per pass by the existing loop (`runner.ts:352`), so re-execution versions naturally — **no separate `step_runs` supersede write is required**. Then `break` + re-enter via the existing resume-claim path at the reparked `currentStepId` (chosen over a mutable in-loop pointer: smaller blast radius, reuses the resume claim). A bounded re-entry guard (default `maxLoops`, mirroring graph `rework.maxLoops`) prevents a reject→goto→reject cycle from looping forever; exceed → terminal `MaisterError`.
4. **Crash-window enumeration** (for the delete→commit ordering). (a) death **before** sentinel-delete → `currentStepId` still = human step, sentinels intact; resume re-drives the stored reject (idempotent) and reparks again. (b) death **after** sentinel-delete, **before** repark commit → `currentStepId` still = human step but its sentinel is gone; resume re-prompts the human (the reject response is lost — a **benign degradation, never corruption**). (c) death **after** repark commit → `currentStepId` = goto target, window sentinels already gone; resume re-enters at the target and re-prompts cleanly. The orphan `rework-comments-*.json` is harmless (ignored unless the target expects `comments_var`; overwritten next repark). Each state has a tested recovery path; confirm `reconcile.ts`/`resume-recovery.ts` candidate filters re-dispatch the `Running`+reparked-`currentStepId` state rather than crashing it.

**(b) HITL response service extraction (P1) + ext reuse (P6).** The extracted `respondToHitl` keeps the existing route's commit discipline **byte-for-byte**: Phase-0 validation (no mutation), Phase-1 `db.transaction` row-lock CAS write of `response`+`reviewFields`+`human_confidence` (idempotency marker `respondedAt` stays the **AFTER**-side write), Phase-2 `atomicWriteJson` (form/human) OR `deliverPermission` supervisor RPC (permission), Phase-3 `respondedAt` stamp + `scheduleResume`/`resumeRun`. The reviewer asserts the extraction changed **no ordering** and introduced **no new deferred** (permission path inherits M7/M8 deferred-release unchanged). The ext route adds no new side-effect beyond what the session route does.

**(c) Assessment columns (P2).** `criticality` is written once at `hitl_requests` INSERT (creation paths) — no SET/CLEAR round-trip (each request is fresh; the config-state-symmetry rule targets config→DB upserts, N/A here). `human_confidence` is written in the existing Phase-1 tx of `respondToHitl` — no new store, no new window.

---

## New-Surface Consumer Fan-Out (skill-context rule)

M17 adds **no new `runs.status`** (stated D6). It adds new **columns**, **routes**, **scopes**, and a **DSL field** — fanned to ALL consumers:

| New surface | Consumers that MUST be updated |
|-------------|-------------------------------|
| `hitl_requests.criticality` | creation paths (`runner-human.ts`, `runner-graph.ts::runReviewHuman`), read models (`getHitlInbox`, the new cross-project inbox query, `getRunDetail` pendingHitl), UI (inline response component, inbox row badge), docs ERD + schema |
| `hitl_requests.human_confidence` | `respondToHitl` Phase-1 write, read models (inbox + run detail), UI (decision/evidence record), `validateReviewDecision` (resolve + bound 0..1) |
| `flow.yaml` `human.criticality` | `config.schema.ts` (`humanSettingsSchema` + `humanStepSchema`), `lib/config.ts` cross-ref validation, the graph compiler (`CompiledNode`), both creation paths, `flow-dsl.md` + `configuration.md` |
| `GET/POST /api/v1/ext/.../hitl…` routes | `operations.openapi.yaml`, MCP `TOOL_SPECS`+`resolveRouting`, `error-taxonomy.md` token-auth section, audit (`handleExt` records both) |
| scopes `hitl:read`/`hitl:respond` **+ `handleExt.requireScope` (D8)** | the two ext route files (`scopeLabel` + `requireScope:true`), `handleExt` enforcement branch, audit `scope_used`, `operations.openapi.yaml` (security carve-out + 403) |
| **actor-kind gate (D7): `human` requires a user** | `respondToHitl` (the gate), ext respond route (403), MCP `hitl_respond` doc, `hitl.md` Expectations |
| cross-project inbox + "Needs you (N)" badge | `portfolio.ts` (new `getCrossProjectHitlInbox`), `app/(app)/page.tsx`, `ProjectCard` (badge), i18n `portfolio.*` EN+RU |

Allow-list guards stay allow-list (the respond service keeps `PENDING_FORM_RUN_STATUS` exactly `{NeedsInput,NeedsInputIdle}` — a new status is rejected by default). No new terminal transition / slot-release added.

---

## Tasks

### Phase 0 — SDD Spec Freeze (docs-first, NO code)

> Single source of truth for all code phases. Exit = COMPLETE + INTERNALLY CONSISTENT. Parallel `docs-architect`/`backend-architect` per domain → consistency reviewer. *blockedBy: none.*

- [x] **T0.1 — ADR-050: HITL assessment taxonomy.** Append ADR-050 to `docs/decisions.md`: `criticality` (flow-declared `low|medium|high`, on `hitl_requests`) vs `human_confidence` (responder self-report `0..1`, on `hitl_requests` + `response` jsonb); the distinction from the existing `GateVerdict.confidence` (M15 AI-judge); **annotate-not-re-gate** semantics (escalate-to-human stays the Flow `human_review` gate — ADR-024 clause **closed**, supersedes the ADR-045 M17 pointer). *Verify:* ADR renders; `validate:docs:all` green.
- [x] **T0.2 — ADR-051: HITL response service + HITL-over-MCP + token-actor + auth gates.** Append ADR-051: extract `respondToHitl` (session route + ext routes share it, zero behavior change); new ext routes `GET …/hitl` (`hitl:read`) + `POST …/hitl/{id}/respond` (`hitl:respond`); MCP tools `hitl_list`/`hitl_respond`; `ensureApiTokenActor` + unique `(project_id,token_id)`; existence-hide trust boundary; external actor answers but never creates/skips a gate. **Plus (adversarial review): the D7 actor-kind gate** — `hitlRow.kind === "human"` requires `actor.kind === "user"` (403 for token/agent); token actors limited to `permission`/`form`. **And the D8 scope enforcement** — `handleExt({requireScope:true})` gates the two HITL routes on `scopeLabel ∈ actor.scopes ∥ "*"` (403), explicitly WITHOUT reopening ADR-046's global binary model for other routes (record that boundary). *Verify:* ADR renders.
- [x] **T0.3 — ADR-052: flat-runner `on_reject` atomic execution.** Append ADR-052: the single-tx repark model + crash-window table (from `## Multi-Store Atomicity (a)`); break+re-enter loop form; bounded re-entry guard (default `maxLoops`); flips the linear `on_reject` path Designed→Implemented. **Includes (adversarial review): comments ride a dedicated `rework-comments-<gotoStepId>.json` (NEVER the `input-<stepId>.json` completion sentinel), and the repark invalidates the window's completion sentinels with delete-then-commit ordering** so a re-reached human/form step re-prompts instead of auto-satisfying a stale response. *Verify:* ADR renders.
- [x] **T0.4 — ADR-053: HITL hybrid-surface composition.** Append ADR-053: cross-project Inbox as a portfolio-home block (lift `getHitlInbox` to membership scope; absorb the one-per-project `NeedsYouStrip`); inline embeddable response component (board card un-`Link`, `onRespond` callback, `compact` variant); the "Needs you (N)" numeric badge from `totalNeeds`/`pendingHitlCount`. *Verify:* ADR renders.
- [x] **T0.5 — system-analytics/hitl.md.** Update per R5: Domain entities (+`criticality`,`human_confidence`); add a **Process flow** for the executed linear `on_reject.goto_step` (replace the "Designed loop" note in the human-review sequence), a flow for the cross-project inbox/badge, and a flow for HITL-over-MCP (list→respond→audit). **Expectations** (≤12, RFC-2119, verbatim identifiers): respond idempotency + `PENDING_FORM_RUN_STATUS` allow-list; `criticality` write-once at creation; `human_confidence ∈ [0,1]`; escalate-to-human is a Flow gate; token actor never creates/skips a gate; flat `on_reject` bounded by `maxLoops`. **Edge cases** each → `MaisterError` code (or token-auth 401/404, `NEEDS_INPUT` 422). *Verify:* R5 order; Mermaid parses.
- [x] **T0.6 — ERD + schema freeze.** Update `docs/db/hitl-domain.md` (add `criticality`,`human_confidence` to the `hitl_requests` ERD + jsonb shapes) AND `docs/database-schema.md` `## hitl_requests` (columns, drop the "loop designed" caveat once P3 lands — tag `Designed`→flips in P3) AND the `actor_identities` unique `(project_id,token_id)` in `db/erd.md` + the relevant domain ERD. Columns MUST match the planned `0022`/`0023` migrations exactly. *Verify:* Mermaid parses; columns ↔ migration shape.
- [x] **T0.7 — API specs freeze.** `docs/api/web.openapi.yaml`: add optional `confidence` (0..1) to the `respondHitl` requestBody (form/human/review). `docs/api/external/operations.openapi.yaml`: add `GET /api/v1/ext/runs/{runId}/hitl` + `POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond` under the existing `projectToken` scheme, new `hitl` tag, full bodies + status codes (200/202/401/**403**/404/409/422), example payloads. Document the **403** cases — missing scope (D8) and a token actor answering a `human`-kind request (D7) — and add a carve-out note to the `projectToken` security-scheme description: HITL routes additionally require the matching scope (or `*`). *Verify:* `npx @redocly/cli lint` zero errors on both; `validate:docs:all` green.
- [x] **T0.8 — flow-dsl + configuration + error-taxonomy.** `docs/flow-dsl.md` `### human step`: add `criticality` (`low|medium|high`) + responder-`confidence` capture note; mark linear `on_reject.goto_step` Implemented; add `hitl_list`/`hitl_respond` to the MCP facade tool list. `docs/configuration.md`: `criticality` in node settings (M11c settings block) — additive, no engine bump; confirm **no new env var**. `docs/error-taxonomy.md`: `hitl:read`/`hitl:respond` in the token-auth section (existence-hide 404; **403 on missing scope (D8) and on a token actor answering a `human`-kind request (D7)**; `NEEDS_INPUT` 422 on bad response). *Verify:* `validate:docs:all`; env table ↔ `.env.example` parity (unchanged).
- [x] **T0.9 — status tags + consistency review + pre-existing ADR-048 flag.** Tag every described piece `Designed` (flips to `Implemented` in its code phase). Consistency reviewer cross-checks ERD == OpenAPI == analytics == planned migration; refusal/allow-list stated as code (`PENDING_FORM_RUN_STATUS`, decision allow-list, `confidence ∈ [0,1]`). File a TODO at the bottom of `decisions.md` for the **duplicate ADR-048 heading** (do NOT renumber). *Verify:* no spec describes code absent at its phase HEAD.

**Phase 0 exit gate:** `pnpm validate:docs:all` green; both OpenAPI files lint-clean; ERD/analytics/API/migration-shape mutually consistent (reviewer sign-off). **No code merged in Phase 0.**

---

### Phase 1 — HITL response service extraction (refactor, zero behavior change)

> Prereq for ext+MCP reuse and the P2 confidence write. *blockedBy: T0.* Tester writes characterization tests; implementor extracts; reviewer asserts no drift / no new deferred / no auth bypass.

- [x] **T1.1 (RED) — characterization tests.** Add `web/lib/services/__tests__/hitl.test.ts` + `hitl.integration.test.ts` pinning the EXACT outputs/transitions of today's inline respond handlers for all three kinds (permission: optionId CAS + `deliverPermission` + idle-resume 202; form: validation + `atomicWriteJson` + `scheduleResume`; human_review: `assertReviewDecision` + `decision`/`workspacePolicy`/`reworkTarget` write; idempotency 409 on conflicting payload; `PENDING_FORM_RUN_STATUS` reject for `HumanWorking`). Keep the existing route integration tests as the oracle. *Runner:* unit + `app/api/**/__tests__` integration. *Verify:* new tests fail (service absent); existing route tests green.
- [x] **T1.2 (GREEN) — extract `respondToHitl`.** New `web/lib/services/hitl.ts::respondToHitl(input, actor, {db})` holding the two-phase logic verbatim from `respond/route.ts`. **Actor is a union:** `{ kind:"user"; userId; label }` | `{ kind:"api_token"; tokenId; projectId; label }`. Assignment attribution branches via `ensureUserActor` vs (P6) `ensureApiTokenActor` — in P1 only the user branch exists; the token branch is a typed stub throwing `UNAUTHORIZED` until P6 (no behavior change for the session route). Add `getHitlRequestsForRun(runId, projectId, {db})` to `web/lib/queries/hitl.ts` (run-scoped read for the ext list route, P6). Rewrite `respond/route.ts` to a thin wrapper calling `respondToHitl({kind:"user",…})`. *Log:* INFO on response with actor label + kind + runId; DEBUG on the branch taken. *Verify:* T1.1 green; existing route + trust-boundary integration tests green.
- [x] **T1.3 (REVIEW).** Reviewer focus: transition parity (tx ordering, `respondedAt` stays AFTER-side, idempotency markers, `deliverPermission`/`scheduleResume` placement unchanged); no `actor` field becomes a trust hole; no new deferred; `git diff` shows only extraction + wrapper rewire. *Verify:* full suite green.

**Exit:** behavior byte-identical; respond route a thin wrapper; `pnpm typecheck && test:unit && test:integration` green.

---

### Phase 2 — Assessment fields: schema + DSL + validation + creation + write

> *blockedBy: T1.* Migration `0022`. Tester RED; implementor GREEN; reviewer.

- [x] **T2.1 (RED) — schema/DSL/validation/creation tests.** Tests for: `config.schema.ts` accepts `human` node/step `criticality ∈ {low,medium,high}` and rejects others; `lib/config.ts` cross-ref still passes; `hitl-validate.ts::validateReviewDecision` resolves+bounds `confidence ∈ [0,1]` (reject `>1`/`<0`/non-number) and carries it on `ResolvedReviewDecision`; creation paths (`runner-human.ts`, `runner-graph.ts::runReviewHuman`) write `criticality` to the `hitl_requests` row; `respondToHitl` writes `human_confidence` in the Phase-1 tx + echoes into `response` jsonb. Migration test: `0022` applies; columns present + nullable. *Runner:* unit + integration (`web/lib/flows/graph/__tests__`, `web/lib/services/__tests__`). *Verify:* RED.
- [x] **T2.2 (GREEN) — implement.** (1) `web/lib/db/migrations/0022_m17_hitl_assessment.sql` (drizzle-kit generate, tag-renamed): `hitl_requests.criticality text`, `hitl_requests.human_confidence` (`real`/numeric, nullable). (2) `config.schema.ts`: `humanSettingsSchema.criticality` + `humanStepSchema.criticality` (additive, `.optional()`); compiler carries it onto `CompiledNode`. (3) `hitl-validate.ts`: extend `ResolvedReviewDecision` (`confidence?`) + `validateReviewDecision` (bound + resolve). (4) creation paths set `criticality` from the compiled node/step (graph `schema` jsonb + the new column; linear `runHumanStep` `.values({…, criticality})`). (5) `respondToHitl` Phase-1 writes `human_confidence` + `response.confidence`. *Log:* DEBUG criticality resolved at creation; INFO confidence recorded on response. *Verify:* T2.1 green; typecheck 0.
- [x] **T2.3 (REVIEW).** Reviewer focus (`code-reviewer`+`rules-sidecar`): additive-only migration (old manifests/rows valid); `confidence` bound enforced server-side (not UI-only); `criticality` write-once (no clear-loop expected); no engine bump; both creation paths fanned (skill-context fan-out). *Verify:* full suite green; `validate:docs:all` (status tag flip for the schema/ERD).

**Exit:** columns live; DSL+validation accept the fields; both creation paths + the respond service write them.

---

### Phase 3 — Flat-runner `on_reject.goto_step` execution (atomic repark)

> Highest-risk. *blockedBy: T0 (spec) — independent of P1/P2; sequence after P2 for narrative.* Governed by `## Multi-Store Atomicity (a)` + ADR-052. `codex:rescue` joins the review.

- [x] **T3.1 (RED) — repark + sentinel + crash-window tests.** Integration tests (mock/seeded run, no live agent): a linear `steps[]` flow with a `human` step `on_reject:{goto_step, comments_var}` → submit a reject → assert: (1) `currentStepId` reparks to the goto target and execution re-enters there; (2) `comments_var` is injected from `rework-comments-<gotoStepId>.json` — **not** `input-<gotoStepId>.json`; (3) **goto target = cli/agent**: executes with comments visible; (4) **goto target = human/form**: its HITL is re-created (NOT auto-satisfied), comments visible in its prompt context; (5) the triggering human step **re-prompts** on the second pass (its prior `input-<stepId>.json` was invalidated — no stale auto-satisfy); (6) reject→goto→reject bounded by the re-entry guard (no infinite loop). Crash-window tests for the **delete-sentinels → repark-commit** ordering: death before delete (re-drives stored reject), death after delete before commit (re-prompts human; benign), death after commit (re-enters at target). Approve path unchanged. *Runner:* integration (`web/lib/flows/__tests__`). *Verify:* RED.
- [x] **T3.2 (GREEN) — implement.** In `runner.ts`, on a resumed `human` step whose stored response routes to reject: (1) `atomicWriteJson(rework-comments-<gotoStepId>.json, {[comments_var]: comments})` (pre-tx); (2) delete `input-<stepId>.json` for every step in `[gotoTarget..humanStep]` (idempotent unlink, pre-tx); (3) single repark `db.transaction` CAS `runs {currentStepId := gotoStep.id}` guarded on `status='Running' AND currentStepId=<humanStepId>`; (4) `break` + re-enter via the existing resume-claim path. Add `injectedVars` to `buildContext`/`executeStep` so the target step's context carries `comments_var` from the rework-comments file (mirrors graph `pendingInjectedVars`). Bounded re-entry guard (count reject re-entries per run/step; default cap mirroring graph `rework.maxLoops`; exceed → terminal `MaisterError`). Confirm `reconcile.ts`/`resume-recovery.ts` candidate filters cover the reparked `Running` state. **Leave the canonical `input-<stepId>.json` contract unchanged for the non-rework path.** *Log:* INFO repark `{from,to,runId}` + window sentinels cleared; DEBUG decision read + guard count; WARN on cap hit. *Verify:* T3.1 green; typecheck 0; **no regression** in existing flat-runner + graph-runner + resume/reconcile tests.
- [x] **T3.3 (REVIEW).** Reviewer focus (`code-reviewer`+`codex:rescue`): comments ride `rework-comments-*.json`, **NEVER** an `input-<stepId>.json`; the repark invalidates window sentinels so no human/form step auto-satisfies from a prior pass; the **delete-sentinels → repark-commit** ordering holds (every crash window benign-or-correct); the repark CAS is a single guarded tx; the re-entry guard cannot be bypassed; the non-rework `input-<stepId>.json` path is unchanged; graph runner untouched. *Verify:* full suite green; flip `hitl.md`/`flow-dsl.md`/`database-schema.md` Designed→Implemented.

**Exit:** linear `on_reject.goto_step`+`comments_var` execute with full atomicity + bounded loop; docs reflect Implemented.

---

### Phase 4 — Inline HITL response component + board flight card

> *blockedBy: T2.* Tester RED; implementor GREEN; reviewer.

- [x] **T4.1 (RED) — component + read-model tests.** (a) Extract a PURE display subcomponent (e.g. `HitlDecisionControls`) testable via `renderToStaticMarkup` — RED tests assert decision buttons from `allowedDecisions`, the confidence input (when `showConfidence`), the criticality badge, the send-back-with-comments control, and `compact` height. (b) Board read-model integration test: `getBoardData` returns `hitlRequestId`/`hitlKind`/`hitlOptions`/`hitlSchema`/`criticality` on a `NeedsInput*` flight card via a bulk `hitl_requests` join (`isNull(respondedAt)`). *Runner:* unit (`components/board/__tests__`) + integration (`lib/queries/__tests__`). *Verify:* RED.
- [x] **T4.2 (GREEN) — implement.** (1) Refactor `run-hitl-response.tsx`: extract `HitlDecisionControls` (pure), add `onRespond?:()=>void` (replaces hard `router.refresh()`), `compact?:boolean`, a confidence input (form/human/review), a dedicated send-back-with-comments control distinct from a plain rework button, and render `criticality`. (2) `FlightCard` DTO + `getBoardData`: add `hitlRequestId|hitlKind|hitlOptions|hitlSchema|criticality` via the bulk join (no N+1). (3) `flight-card.tsx`: on `NeedsInput*`, un-`Link` (move nav off the `<a>`) and render the inline response (client wrapper) so a `<form>` is not nested in `<a>`. (4) New i18n keys (`run.confidenceLabel`, `run.criticality*`, `run.sendBackWithComments`, …) in EN+RU at parity. *Log:* INFO inline response submitted from board. *Verify:* T4.1 green; typecheck 0; lint clean.
- [x] **T4.3 (REVIEW).** Reviewer focus (`code-reviewer`+`frontend`): no `<form>`/`<button>` inside `<a>`; `RunHitlResponse` still works on run-detail (`onRespond` defaults to `router.refresh()`); confidence bound mirrored client+server; EN/RU parity; accessibility (labels/`aria-live` on async error per data-management page rules). *Verify:* full suite green.

**Exit:** one reusable response component renders inline on the board `NeedsInput*` card AND run-detail, with confidence/criticality + send-back.

---

### Phase 5 — Cross-project Inbox block + "Needs you (N)" badge

> *blockedBy: T2 (criticality), T4 (reuses the inline component + `HitlItem.schema`). *Tester RED; implementor GREEN; reviewer.

- [x] **T5.1 (RED) — query + render tests.** (a) Integration test: `getCrossProjectHitlInbox(userId, globalRole)` returns ALL pending `HitlItem[]` across visible projects (admin=all; member=`project_members` join), each carrying `schema`/`criticality`/assignment state, sorted (criticality desc then oldest), respecting RBAC (a member sees only their projects). (b) `HitlItem` gains `schema:unknown` + `criticality`; `getHitlInbox` propagates them. (c) Pure-render tests for the inbox block + the numeric badge (`portfolio.totalNeeds`) + `ProjectCard` `pendingHitlCount` chip. *Runner:* integration (`lib/queries/__tests__/portfolio*.integration.test.ts`) + unit (`components/portfolio/__tests__`). *Verify:* RED.
- [x] **T5.2 (GREEN) — implement.** (1) `portfolio.ts`: `getCrossProjectHitlInbox` (lift `getHitlInbox` to membership scope; same assignment∪legacy dedup-by-runId). (2) `HitlItem.schema`+`criticality` propagated in `hitl.ts`. (3) New cross-project inbox block component on `app/(app)/page.tsx` reusing the inbox row + the P4 inline response component (respond without leaving home); the one-per-project `NeedsYouStrip` is absorbed into the block (keep the compact badge). (4) Numeric "Needs you (N)" badge on home + `pendingHitlCount` chip on `ProjectCard`. (5) i18n `portfolio.*` EN+RU at parity. *Log:* INFO cross-project inbox query (count, projects). *Verify:* T5.1 green; typecheck 0; lint.
- [x] **T5.3 (REVIEW).** Reviewer focus (`code-reviewer`+`security-sidecar`): RBAC — a member NEVER sees another project's HITL; no N+1 (batched like `getPortfolio`); dedup parity with `getPortfolio`; badge count == block item count; EN/RU parity. *Verify:* full suite green.

**Exit:** portfolio home shows a full cross-project Inbox block with inline response + a precise numeric badge; per-project card shows a pending chip.

---

### Phase 6 — HITL-over-MCP + external REST routes

> *blockedBy: T1 (service), T2 (confidence in body). *Migration `0023`. Tester RED; implementor GREEN; adversarial reviewer + `codex:rescue` (trust boundary).

- [x] **T6.1 (RED) — ext routes + auth-gate + MCP tests.** (a) Ext integration tests: `GET /api/v1/ext/runs/{runId}/hitl` (`hitl:read`) lists pending HITL for a run; cross-project run → 404 (existence-hide); audit row written. `POST …/hitl/{id}/respond` (`hitl:respond`) answers **permission/form** via `respondToHitl({kind:"api_token",…})`; idempotency 409; `hitlRow.runId != runId` → 404; bad response → 422; audit written. **(a1) Actor-kind gate (D7):** a token answering a `human`-kind request → **403** (a session user → ok). **(a2) Scope enforcement (D8):** a token lacking the route scope (and not `*`) → **403**; a read-only-scope token cannot `respond`; a `*` token passes both; an unrelated route (e.g. `gate_report`) is **unaffected** (still binary). (b) `ensureApiTokenActor` upserts on unique `(projectId,tokenId)`; migration `0023` test. (c) MCP unit tests (`mcp/`): `hitl_list`/`hitl_respond` in `TOOL_SPECS`+`resolveRouting` map to the two routes; HTTP transport forwards inbound bearer (no env fallback); error mapping (incl. 403). *Runner:* `app/api/**/__tests__` integration + `@maister/mcp` unit. *Verify:* RED.
- [x] **T6.2 (GREEN) — implement.** (1) `0023_m17_actor_token_uniqueness.sql`: unique `(project_id, token_id)` on `actor_identities` (NULL token_id = user rows distinct). (2) `ensureApiTokenActor` in `web/lib/assignments/service.ts`; wire the `api_token` actor branch in `respondToHitl` (replaces the P1 stub) **with the D7 actor-kind gate: `hitlRow.kind === "human"` + non-user actor → `MaisterError("UNAUTHORIZED")` (403).** (3) **`handleExt` gains opt-in `requireScope` (D8): when set, `scopeLabel ∈ actor.scopes ∥ "*"` else 403** — every other ext route leaves it unset (binary, byte-unchanged). (4) ext routes `…/hitl/route.ts` (GET, `hitl:read`, `requireScope`, calls `getHitlRequestsForRun`) + `…/hitl/[hitlRequestId]/respond/route.ts` (POST, `hitl:respond`, `requireScope`, calls `respondToHitl` token-actor) — both via `handleExt` (existence-hide, audit). (5) MCP `hitl_list`/`hitl_respond` (mirror `gate_report`). *Log:* INFO each ext-HITL action (audited); WARN on scope/actor-kind denial; never log response payloads. *Verify:* T6.1 green; typecheck 0; `pnpm --filter @maister/mcp test`+typecheck green.
- [x] **T6.3 (REVIEW).** Reviewer focus (`security-sidecar`+`codex:rescue`): **the D7 actor-kind gate cannot be bypassed** (no token/agent path satisfies a `human`/`human_review` request); **D8 `requireScope` enforced on both HITL routes while other ext routes are provably unchanged** (binary); 403 responses don't leak which scopes a token holds; existence-hide on cross-project runId/hitlRequestId; token actor cannot create/skip a gate (ADR-024); no ambient-token bypass on HTTP transport; bearer never logged; audit on success AND every rejected/errored request (incl. 403s); `respondToHitl` two-phase parity preserved for the token actor. *Verify:* full suite green; both OpenAPI lint-clean.

**Exit:** an agent (token-scoped) can list + answer HITL via MCP/REST through the same service + audit as the UI; gate placement stays the Flow's.

---

### Phase 7 — e2e + as-built reconciliation + final verify

> *blockedBy: T3, T4, T5, T6.* No new behavior — wiring, e2e, docs flip.

- [x] **T7.1 — Playwright e2e.** Add `web/e2e/m17-hitl-hybrid.spec.ts` and **add `|m17-.*` to `AUTHED_SPEC`** in `playwright.config.ts`. Covers (stub supervisor, seeded `NeedsInput` runs): inline response on a board `NeedsInput*` card → resolves; cross-project inbox block on home lists items across ≥2 projects + numeric badge; a `human_review` decision with confidence + a criticality badge; a linear `on_reject` send-back reparks (seeded). *Verify:* full authed e2e green (no regression).
- [x] **T7.2 — as-built reconciliation.** Flip every `Designed`→`Implemented` for shipped pieces (hitl.md, flow-dsl.md, database-schema.md, hitl-domain.md, erd, web/external OpenAPI, error-taxonomy, configuration, architecture MCP tool count). ADR-050..053 status Accepted. Tick **ROADMAP M17 `[x]`** + add a Completed row dated 2026-06-04. Leave the duplicate-ADR-048 TODO as filed (not fixed). Also correct ADR-052/hitl.md crash-window (c): a death after the repark CAS commit reconciles to **Crashed** (benign degradation, operator Recover → crashResume resumes cleanly), NOT auto-clean-re-entry; drop the "must re-dispatch rather than crashing it" bullet. *Verify:* `validate:docs:all`; both OpenAPI lint-clean.
- [x] **T7.3 — final verify.** `pnpm typecheck && test:unit && test:integration` green; `pnpm --filter @maister/mcp test` green; relevant e2e green; `validate:docs:all` green; `pnpm lint` clean. Confirm the Contract-Surface trace ↔ diff and the New-Surface fan-out are fully satisfied. *Verify:* all gates green.

**Exit:** M17 acceptance met end-to-end; docs honest; suite green.

---

## Commit Plan

One checkpoint commit per phase (8 commits), conventional-commit `feat(m17:pN): …` (docs phase `docs(m17:p0): …`, refactor `refactor(m17:p1): …`). Each commit ships only after its phase exit gate is green. Migration commits (`0022` in P2, `0023` in P6) ride their phase.

| Phase | Commit subject |
|-------|----------------|
| 0 | `docs(m17:p0): SDD spec freeze — ADR-050..053, hitl/flow-dsl/ERD/OpenAPI` |
| 1 | `refactor(m17:p1): extract respondToHitl service (zero behavior change)` |
| 2 | `feat(m17:p2): HITL criticality + confidence fields (migration 0022)` |
| 3 | `feat(m17:p3): execute linear on_reject.goto_step with atomic repark` |
| 4 | `feat(m17:p4): inline HITL response on board card (confidence/criticality/send-back)` |
| 5 | `feat(m17:p5): cross-project HITL inbox block + Needs-you badge` |
| 6 | `feat(m17:p6): HITL-over-MCP + ext routes (migration 0023)` |
| 7 | `feat(m17:p7): e2e + as-built + ROADMAP M17 closed` |

---

## Open Questions (для пользователя)

1. **`criticality` шкала** — `low|medium|high` ок, или нужна 4-я (`critical`)? По умолчанию беру 3.
2. **`human_confidence` тип** — `real` (0..1) ок, или дискретные `low|med|high`? По умолчанию `real 0..1`.
3. **`NeedsYouStrip`** — поглотить в кросс-проектный блок (убрать) или оставить как компактную полосу над блоком? По умолчанию: поглотить, оставить только бейдж.
4. **Флэт-раннер `on_reject` `maxLoops`** — дефолтный кап для линейного reject-цикла (в графе он явный в DSL)? Предлагаю 3.

> **Resolved by adversarial review** (was Q3): MCP `hitl_respond` for `human`/`human_review` → **no**. Token actors are limited to `permission`/`form`; `human`-kind requires a human actor (D7).
