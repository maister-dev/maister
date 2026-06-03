# M16 — External Operations API, Tokens, and Thin MCP Facade

> Roadmap milestone **M16**. A project-scoped, token-authenticated control
> surface for CI / local scripts / external tools / running agents, plus a thin
> MCP facade over the **same** service layer and audit model. Closes the
> `external_check` gate loop end-to-end through the existing `Review` chokepoint.

**Branch:** `feature/m16-external-operations-api` — **created 2026-06-02** from
HEAD (`main`-equivalent: `main...HEAD` = `0 0`, carries shipped M12/M19).
**Created:** 2026-06-02
**Engine baseline:** `MAISTER_ENGINE_VERSION = 1.2.0` (M12). No engine bump in M16.
**Anchor ADR:** [ADR-024](../../docs/decisions.md) (external operations surface — Accepted, status flips Designed→Implemented).

---

## Settings

- **Testing:** YES — strict TDD (RED → GREEN → adversarial review) per phase. Non-negotiable (user: "TDD-driven").
- **Logging:** Verbose — `pino` child loggers per new module (`tokens`, `external-api`, `external-gates`, `mcp-facade`), DEBUG on token-verify path (NEVER log secrets/hashes), INFO on every audited action, WARN on auth failure class, ERROR on side-effect failure.
- **Docs:** YES — mandatory docs-first **Phase 0** (SDD spec-freeze) gating all code phases; final as-built reconciliation in Phase 8. `pnpm validate:docs:all` is a phase gate.
- **Roadmap linkage:** see `## Roadmap Linkage`.
- **Method:** SDD (spec-frozen Phase 0 = single source of truth) + multiagent per-phase TDD (see `## Multiagent Execution Model`).

## Roadmap Linkage

- **Milestone:** "M16. External operations API, tokens, and thin MCP facade"
- **Rationale:** This plan implements M16 verbatim against the current codebase reality (M11a–c, M12, M19, M21 shipped; M13–M15, M17, M18 not). It honors ADR-024 (token grants full project API in v1; thin MCP facade; mandatory audit) and adds the M16/M15/M18 carve (ADR-045) needed because M15/M18 are unbuilt.

---

## Implementation Progress (autonomous run, 2026-06-02)

| Phase | Status | Commit | Verification |
|-------|--------|--------|--------------|
| 0 — SDD spec-freeze | ✅ shipped | `b4161a4` | validate:docs:all 104/104; OpenAPI lint clean; adversarial consistency review (1 BLOCKER + 3 nits fixed) |
| 1 — service extraction | ✅ shipped | `17453c9` | typecheck 0; integration 54 green (no drift). httpStatusForCode centralization dropped (CONFIG 422 vs 400 differ) |
| 2 — token model | ✅ shipped | `e316fc0` | typecheck 0; unit 12/12 + integration 20/20; security review (H1 fixed). Migration 0018 |
| 3 — external REST API | ✅ shipped | (this commit) | typecheck 0; integration 21/21; adversarial trust-boundary review passed (no blocker/high; N3 defence-in-depth applied). handleExt auth+audit wrapper, /api/v1/ext routes, getRunReadiness. All failures were QA test-harness bugs (header API, workspace-unique, audit isolation, slug/projectId mismatch, empty manifest), root-caused + fixed |
| 4 — external_check loop | ✅ shipped | `5241bab` | typecheck 0; unit 1097; integration 455/455; validate:docs 104/104; lint clean. Multiagent TDD (7 RED files → GREEN → adversarial security/rules/bugs review). Reviewer-found HIGH bug fixed via RED-regression: both readiness readers must collapse `external_check` to latest-per-gateId after a supersede, else a new-commit passing report strands a `stale` row and wrongly blocks review. `handleExt.successAuditInWork` opt-in keeps the success audit in the gate-report tx (atomic rollback proven). No engine bump, no migration |
| 5 — token-management UI | ✅ shipped | (this commit) | typecheck 0; target 74/74; full unit 1171/1171; lint clean. Multiagent TDD (QA RED: i18n EN/RU parity + pure-component render tests via `renderToStaticMarkup` → Implementor GREEN → adversarial review APPROVE-WITH-FIXES). Reviewer-found MEDIUM fixed: inert Copy button on the one-time secret reveal (data-loss trap) wired to `navigator.clipboard` + `copied` toggle. `TokensTable`/`TokenSecretReveal` kept pure/`renderToStaticMarkup`-safe via `createSlot`/`renderRevoke` injection; secret shown once, never re-fetchable/logged/persisted; `isAdmin`-gated (non-admin → `adminOnly` notice, no list query); EN+RU 26-key `tokens` namespace + `nav.integrations` at parity. New `integrations` tab. No engine bump, no migration |
| 6 — thin MCP facade | ✅ shipped | (this commit) | mcp unit 31/31; typecheck 0; lint clean; validate:docs:all 104/104; web tsc 0 (no regression); stdio run-smoke OK. New `@maister/mcp` workspace pkg (`@modelcontextprotocol/sdk@1.29.0`), 8 tools as a pure REST client of `/api/v1/ext/*`, zero web/lib/DB import. Multiagent TDD (QA scaffold + RED: auth resolver, REST mapping, transport-auth, error mapping → Implementor GREEN + SDK wiring: `McpServer` + Stdio/StreamableHTTP transports, inbound bearer via `extra.requestInfo.headers["authorization"]` → adversarial review: all 5 ADR-024/042 invariants CLEAN). Reviewer fixes landed TDD-first: HIGH-1 silent-swallow of network/non-JSON failures (now graceful `isError` + ERROR log), MEDIUM-1 `restResponseToToolError` non-JSON crash (text+try-parse fallback, status preserved), LOW-3 `extra.signal`→`callExt` AbortSignal wiring, extracted+tested pure `httpAuthContext`, LOW-1 stale `.env.example` tag. No ambient-token bypass on HTTP; bearer never logged. No engine bump, no migration |
| 7 — consumer fanout | ✅ shipped | (this commit) | typecheck 0; board+portfolio integration 45/45; full unit 1176/1176; full integration 474/474 (no regression); lint clean. `externalGatePending` fanned to `FlightCard` (board.ts) AND `PortfolioWorkspace` (portfolio.ts) with allow-list semantics (ready only `passed`/`overridden`/`skipped`) + the Phase-4 dual collapse (live-attempt + latest-per-gateId, max-createdAt tiebreak id desc) mirrored byte-for-byte from `readiness.ts`; `◉` badge in flight-card + portfolio indicator; EN+RU `board.externalGatePending`. Run-detail already surfaces the gate+`test_report` via Phase-4 readiness + M12 timeline/evidence (no new code). Multiagent TDD (QA RED incl supersede case → Implementor GREEN → adversarial review: all 5 correctness invariants CLEAN). Reviewer-found MEDIUM closed: portfolio collapse was a separate copy shipped without supersede/live-attempt tests → added supersede(both dirs)+live-attempt+overridden/skipped+advisory regression cases; +N3 board `READY` Set hoist. No new run status, no engine bump, no migration |
| 8 — e2e + as-built + final verify | ✅ shipped | (this commit) | Playwright `m16-external-operations.spec.ts` green (token→ext task→ext launch 202→readiness pending/not-ready→gate report passed→readiness ready→evidence-graph `test_report`→re-stale on new commit; + 401 auth-negative). Full authed e2e 29 passed/1 skipped (no regression); typecheck 0; unit 1176/1176; integration 480/480; validate:docs:all 104/104; both OpenAPI specs valid (0 errors); lint clean. Supervisor-stub e2e (seeded review run; no live agent). As-built reconciliation: ADR-024 body→Implemented; external-operations/flow-graph/artifacts + DB (database-schema, db/erd, db/integrations-domain), error-taxonomy, both OpenAPI specs, flows/tasks/flow-dsl all flipped Designed→Implemented; ROADMAP M16 ticked + Completed row 2026-06-02. Adversarial review (CHANGES-REQUIRED) fully addressed: HIGH-2 (9 stale tags missed by first pass) flipped; HIGH-1 (e2e overclaimed "approval refused") corrected to an honest readiness-proxy SCOPE note citing `external-check-loop.integration.test.ts` for the literal transition; MEDIUM-1/2 (launch-202≠session-spawn, supersede mechanism) clarified. ADR historical refs left immutable per docs R4 |

## Scope Decisions (locked with user, 2026-06-02)

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | **`external_check` enforced via the existing `Review` chokepoint** — the gate-report endpoint flips the `pending` gate_result to `passed`/`failed`, records a typed `test_report` artifact, and `assertEvidenceReady` (extended) refuses review approval while any **blocking** `external_check` is `pending\|failed\|stale\|skipped` unless human-overridden. **No new run status, no suspend/resume.** | Full M16 acceptance met standalone. M15 later adds only the richer readiness DSL / verdict calibration / roll-up. M18 promotion reuses the same readiness check. Recorded in **ADR-045**. |
| D2 | **Thin MCP facade = standalone top-level `mcp/` workspace package**, a pure REST client of the M16 external API. **Transport-scoped auth:** Streamable-HTTP (default, remote) requires a **per-request inbound bearer** (the caller's project token) forwarded verbatim to `/api/v1/ext` — the server holds **no ambient token** and rejects unauthenticated HTTP calls (401); stdio (local) may read `MAISTER_PROJECT_TOKEN` from env (process owner == token owner). | Provably "cannot perform any operation the token lacks scope for" (ADR-024) by construction; identical audit trail; zero Next.js/DB coupling. Recorded in **ADR-047**. |
| D3 | **HITL `confidence`/`criticality` + HITL-over-MCP deferred to M17.** | M16 ships exactly its acceptance-criteria MCP tool set (task create/list/get/update, run launch/get, readiness read, gate report). ADR-024's HITL-assessment clause is re-scoped to M17 — noted in ADR-045. |
| D4 | **Token scopes: store a `scopes` column (default = full project API) but enforce binary** (valid, active, project-matched token → full project API), per ADR-024. Audit records the endpoint's **logical scope label** (`tasks:create`, `gates:report`, …) for forward-compat. | Granular scope *enforcement* stays deferred (ADR-024); the scope taxonomy is materialized as labels now so the audit trail is future-proof. Recorded in **ADR-046**. |
| D5 | **External surface lives under `/api/v1/ext/...`** — a **versioned (`v1`) token-auth subset** of the API, frozen for external consumers and evolvable independently of the UI routes; session-auth routes never accept tokens and vice-versa. Token storage = 256-bit random secret, `sha256` at rest (NOT bcrypt — too slow per-request), prefix-indexed lookup + `timingSafeEqual` compare. No server pepper (high-entropy token ⇒ sha256 sufficient, mirrors GitHub-PAT model). | Unambiguous trust boundary; per-request verify is O(1) index lookup. Recorded in **ADR-046**. |

---

## Current-State Grounding (verified by exploration)

- `external_check` is **stubbed** (`web/lib/flows/graph/gates-exec.ts:412`): creates a `pending` gate_result, returns `"pending"`, which today blocks nothing (`runNodeGates` only fails on `status==="failed"`).
- Review chokepoint already exists: `assertEvidenceReady(runId, phase, db)` (`web/lib/flows/graph/evidence-readiness.ts:57`) is called from `web/lib/flows/graph/runner-graph.ts:~1239` on terminal transition when `artifactEnforcementActive` (engine ≥ 1.2.0). It currently iterates only `kind="artifact_required"` gate_results.
- Gate machinery is complete: `gate_results` FSM (`pending|running|passed|failed|stale|skipped|overridden`), `markGateOverridden` (override-without-erasure), `markDownstreamStale` (flips ALL downstream `passed` gate_results → `stale`, incl. `external_check`), `blockingGatesSatisfied` (exists, unused) — all in `web/lib/flows/graph/{gate-store,ledger}.ts`.
- Artifacts (M12): `artifact_instances` with kind `test_report`, producer `gate`, `recordArtifact`/`recordCurrentArtifact` (`web/lib/flows/graph/artifact-store.ts`). External gate report → `test_report` artifact.
- **Task-create & run-launch logic is fully INLINED** in `web/app/api/projects/[slug]/tasks/route.ts` and `web/app/api/runs/route.ts` — must be extracted to services for API+MCP reuse. Precedent: `web/lib/scratch-runs/service.ts` (but it couples `requireProjectAction` internally — M16 decouples auth from the core).
- **No audit table** (only `node_attempts.enforcement_snapshot` append-only precedent). **No `@modelcontextprotocol/sdk`** anywhere. Token-secret precedent: `MAISTER_CRON_TOKEN` + `timingSafeEqual` (`web/app/api/cron/gc/route.ts`); password hashing = `bcryptjs` (`web/lib/password.ts`); content hashing = `node:crypto` `createHash("sha256")`.
- Auth: `web/lib/authz.ts` (`requireProjectAction`, `httpStatusForAuthz`, separate `AuthzError`, NOT a MaisterError code). Token-auth mirrors this pattern.
- Migrations: highest on disk `0017_m12_artifacts_evidence.sql` → next **`0018`**.
- Tests: vitest unit glob `app/**/__tests__/**/*.test.ts` (route tests MUST live under `__tests__/`), integration `*.integration.test.ts`; Playwright `web/e2e/*.spec.ts` (`authed` regex in `web/playwright.config.ts` must gain `m16-`). Commands `pnpm test:unit | test:integration | test:e2e`.
- Read models to fan readiness into: `web/lib/queries/board.ts` (`FlightCard`, `mergeBlocked`, `evidenceStale`) AND `web/lib/queries/portfolio.ts` (cross-project home).
- Settings UI: `web/components/board/panels/*`, tab union in `web/components/board/project-tabs.tsx`, `isAdmin` gating; i18n `web/messages/{en,ru}.json`.
- Sweeper boot pattern: `web/instrumentation.ts` + `Symbol.for(...)` singleton + `.unref()` (only if a staleness sweeper proves necessary — see Phase 4; default: no sweeper).

---

## Multiagent Execution Model

Mirrors the M11c / M19 as-built method ("SDD docs-first Phase 0 + per-phase QA(RED)→implementor(GREEN)→adversarial-reviewer with executable phase gates"). Driven by `/aif-implement` (`implement-coordinator`), one phase = one checkpoint commit.

**Roles per code phase (3 hand-offs):**
1. **Tester (RED)** — writes failing unit+integration tests from the Phase-0 frozen spec ONLY. Names the runner project for each test; confirms the `include` glob matches (`vitest list`). No implementation. Exit: tests exist and fail for the right reason.
2. **Implementor (GREEN)** — minimal code to pass the RED tests + Phase-0 spec. Verbose logging. No scope creep. Exit: `pnpm typecheck` 0 + the phase's tests green.
3. **Adversarial reviewer** — `code-reviewer` + `security-sidecar` + `rules-sidecar` (and `codex:rescue` for trust-boundary passes). Hunts the specific failure classes named in each phase's "Reviewer focus". Findings fixed before the phase commit.

**Phase 0 roles:** parallel `docs-architect` / `backend-architect` per doc domain (ADRs, system-analytics, ERD, OpenAPI) → consistency reviewer cross-checks the four artifact families against each other before freeze.

**Global gate (every phase):** `pnpm typecheck && pnpm test:unit && pnpm test:integration` GREEN; relevant `pnpm test:e2e` GREEN; `pnpm validate:docs:all` GREEN; `pnpm lint` clean. A test the phase touches left RED fails the phase (quarantine only via explicit `*.skip` + reason + tracked follow-up).

---

## Contract-Surface → Spec-File Trace (skill-context rule)

Every external-facing contract surface M16 changes, and the spec file that names it. Enumerated here so implementation has a checklist and `/aif-verify` re-derives it from the diff.

| Surface | Spec file(s) | Phase |
|---------|-------------|-------|
| `POST/GET /api/projects/{slug}/tokens`, `DELETE …/tokens/{tokenId}` | `docs/api/web.openapi.yaml` + `docs/system-analytics/external-operations.md` | 0, 2 |
| `POST/GET/PATCH /api/v1/ext/projects/{slug}/tasks[/{taskId}]`, `POST /api/v1/ext/runs`, `GET /api/v1/ext/runs/{runId}[/readiness]`, `POST /api/v1/ext/runs/{runId}/gates/{gateId}/report` | **new** `docs/api/external/operations.openapi.yaml` + `projectToken` bearer security scheme | 0, 3, 4 |
| `external_check` now executes + gates review (wire/state change) | `docs/system-analytics/flow-graph.md` (gate exec) + `docs/system-analytics/external-operations.md` (state machine) | 0, 4 |
| **new** `flow.yaml` `gates[].external` block (typed `external_check` settings: `description?`, `staleOnNewCommit?`) | `docs/flow-dsl.md` + `web/lib/config.schema.ts` (`gateSchema.external`, additive, no engine bump) | 0, 4 |
| External gate report → `test_report` artifact (evidence) | `docs/system-analytics/artifacts.md` | 0, 4 |
| New tables `project_tokens`, `token_audit_log` | `docs/database-schema.md` + **new** `docs/db/integrations-domain.md` + `docs/db/erd.md` | 0, 2 |
| Token-auth failure modes (401 invalid/expired/revoked, 403 wrong-project/scope) | `docs/error-taxonomy.md` (token-auth section; NOT a MaisterError code — mirrors `httpStatusForAuthz`) | 0, 3 |
| New env vars (`MCP` base URL/token; no new web secret beyond per-token hash) | `docs/configuration.md` env table + `.env.example` | 0, 6 |
| New `mcp/` package + container | `docs/architecture.md` (Container/Component rows) + `docs/api/external/operations.openapi.yaml` (the surface it wraps) + `docs/deployment.md` (how it's run) | 0, 6 |
| MCP-HTTP inbound auth (per-request bearer; 401 on unauthenticated; no ambient token) | `docs/error-taxonomy.md` + `docs/deployment.md` + ADR-047 | 0, 6 |
| ADR-024 status + ADR-045/041/042 | `docs/decisions.md` | 0, 8 |

---

## HTTP Identifier Trust-Boundary Table (skill-context rule)

Every identifier each new route consumes, labeled. **No `body-controlled` cross-resource locator is admitted** — all cross-resource ids derive from the URL (project/run/task/gate) and are re-validated against the token's `project_id` (server-state). Mismatch → 404 (existence-hiding) for cross-project, 403 for in-project scope/role.

| Route | Identifier | Label | Guard |
|-------|-----------|-------|-------|
| `…/tokens` (mgmt) | `slug` | url-param | session + `requireProjectAction(editSettings)`; project from DB slug lookup |
| `…/tokens/{tokenId}` DELETE | `tokenId` | url-param | row's `project_id` MUST equal the slug's project id, else 404 |
| all `/api/v1/ext/*` | bearer token | auth-context | `verifyToken` → `{ tokenId, projectId, actorLabel }` (server-issued) |
| `/api/v1/ext/projects/{slug}/tasks` | `slug` | url-param | resolved project's id MUST equal `token.projectId`, else 404 |
| `…/tasks/{taskId}` GET/PATCH | `taskId` | url-param | task.project_id MUST equal `token.projectId`, else 404 |
| `POST /api/v1/ext/runs` | `taskId` (body **data**, not locator) | body-controlled | task resolved server-side; task.project_id MUST equal `token.projectId`, else 404; same launch contract as UI |
| `GET /api/v1/ext/runs/{runId}[/readiness]` | `runId` | url-param | run.project_id MUST equal `token.projectId`, else 404 |
| `POST …/runs/{runId}/gates/{gateId}/report` | `runId`, `gateId` | url-param | run.project_id == token.projectId (404 else); `gateId` MUST be a declared `external_check` gate on the run's flow (404 else) |
| gate report body | `status`, `commitSha`, `externalRunUrl`, `summary`, `payload` | body-controlled **data** | validated as typed evidence (Zod); `commitSha` is a staleness anchor, NOT a resource locator |

---

## Multi-Store Atomicity & Two-Phase Commit (skill-context rule)

- **Token issuance** — single `INSERT` into `project_tokens`; the plaintext secret is returned in the response and never persisted. No multi-store window.
- **Gate report ingestion** (`/gates/{gateId}/report`) — a **successfully ingested** report (verdict `passed` OR `failed`) commits the three writes (`gate_results` UPDATE → `artifact_instances` INSERT → **success** `token_audit_log` INSERT) in ONE `db.transaction`. No cross-service side-effect: the run already sits in `Review`; the report does not call the supervisor. ⇒ fully atomic; either the gate flips + artifact + success-audit all commit, or none do (a failed audit INSERT rolls the gate/artifact back — **no accepted evidence without its audit row**). **Rejected/errored** ingestion (bad token, validation, cross-project, non-external gate) writes only a failure audit, AFTER (next bullet) — it mutates no gate/artifact.
- **Audit on the other `/api/v1/ext/*` endpoints** (task create/read/update, run launch/read, readiness, AND every *rejected/errored* request incl. failed gate reports) — audit row is the **AFTER**-side write: `recordTokenAudit({ result, statusCode })` runs after the handler resolves its outcome, so a crash before the response leaves no false "succeeded" audit. These endpoints have a non-DB side-effect (`launchRun` worktree + fire-and-forget `runFlow`) or no DB write to bind to, so a shared tx is impossible — **only** the gate-report *success* path (above) folds its audit into the tx. `last_used_at` bump is best-effort, non-blocking.
- **`createTask` / `launchRun` services** — inherit the existing route's commit discipline: `launchRun` keeps the pre-tx `addWorktree` + compensating `removeWorktree` + single DB tx (`runs`+`workspaces`+`tasks`) + post-commit fire-and-forget `runFlow`; the service extraction must NOT change ordering. Reviewer asserts byte-for-byte transition parity.
- **Deferred-release:** `launchRun` (via supervisor session) inherits M7/M8 deferred-release contracts unchanged; the external route adds no new deferreds. The gate-report route creates no deferreds.

---

## Tasks

### Phase 0 — SDD Spec Freeze (docs-first, NO code)

> Single source of truth for all code phases. Exit = COMPLETE + INTERNALLY CONSISTENT. Parallel `docs-architect`/`backend-architect` agents per domain → consistency reviewer.

- **T0.1 — ADR-045: external_check enforcement carve.** Append ADR-045 to `docs/decisions.md`: `external_check` enforced via the existing `Review` chokepoint (extend `assertEvidenceReady`); no new run status; the **M16/M15/M18 boundary** (M16 = external-gate loop end-to-end through review + mechanical staleness; M15 = readiness DSL/verdict calibration/roll-up; M18 = promotion reuses the readiness check); HITL `confidence`/`criticality` re-scoped to **M17**. *Log:* n/a (doc). *Verify:* ADR renders; `validate:docs:all` green.
- **T0.2 — ADR-046: token model.** Append ADR-046: project-scoped tokens, 256-bit random secret, `sha256` at rest, prefix lookup + `timingSafeEqual`, no pepper, binary enforcement with stored `scopes` labels (D4), `/api/v1/ext/*` namespace, auth decoupled from `createTask`/`launchRun` services. *Verify:* ADR renders.
- **T0.3 — ADR-047: thin MCP facade.** Append ADR-047: standalone `mcp/` workspace package, REST-client facade, **transport-scoped auth** (HTTP = per-request inbound bearer forwarded to `/api/v1/ext`, no ambient token, 401 on unauthenticated; stdio = env `MAISTER_PROJECT_TOKEN`, local-only), zero DB coupling. *Verify:* ADR renders.
- **T0.4 — system-analytics doc.** New `docs/system-analytics/external-operations.md` per `docs/CLAUDE.md` R5: Purpose; Domain entities (`project_tokens`, `token_audit_log`, `external_check` gate, `test_report` artifact); **State machines** (`stateDiagram-v2`) for token lifecycle (`active→revoked`/`expired`) AND external_check (`pending→passed|failed`, `passed→stale`, `failed/stale→overridden`); **Process flows** (`sequenceDiagram`) for token issue/verify/revoke, task-create-via-token, run-launch-via-token, gate-report→artifact→review-refusal, MCP-tool→REST; **Expectations** (≤12 normative bullets, RFC-2119, verbatim identifiers); **Edge cases** (each linked to a status code / refusal); **Linked artifacts**. *Verify:* R5 section order; Mermaid parses.
- **T0.5 — ERD freeze.** Add `docs/db/integrations-domain.md` (Mermaid `erDiagram`: `project_tokens`, `token_audit_log` + FKs to `projects`/`users`); update `docs/db/erd.md` (consolidated) AND `docs/database-schema.md` narrative (columns, indexes, cascade). Both artifacts in lockstep. *Verify:* Mermaid parses; columns match the planned `0018` migration exactly.
- **T0.6 — API specs freeze.** New `docs/api/external/operations.openapi.yaml` (OpenAPI 3.0.3) for all `/api/v1/ext/*` routes + `projectToken` bearer `securityScheme` (full paths, bodies, status codes incl. 401/403/404/409/422, example payloads). Add the token-management routes + `projectToken` scheme to `docs/api/web.openapi.yaml`. Freeze the additive optional `gates[].external` manifest block (`description?`, `staleOnNewCommit?` default `true`) in `docs/flow-dsl.md` (mirrors the `web/lib/config.schema.ts` `gateSchema.external` shape; additive — old manifests stay valid, **no engine bump**). *Verify:* `npx @redocly/cli lint` zero errors on both; `validate:docs:all` green.
- **T0.7 — error-taxonomy + configuration + architecture.** `docs/error-taxonomy.md`: token-auth failure section (401 invalid/expired/revoked; 403 wrong-project; 404 existence-hide) explicitly NOT a `MaisterError` code (mirrors `httpStatusForAuthz`); **plus the MCP-HTTP inbound-auth 401** (missing/invalid inbound bearer on the Streamable-HTTP transport). `docs/configuration.md`: new env rows (MCP `MAISTER_API_BASE_URL`; `MAISTER_PROJECT_TOKEN` documented as **stdio/local-only** — ignored under HTTP transport, which requires a per-request inbound bearer; no new web-tier secret env — per-token hashes live in DB). `docs/architecture.md`: `mcp/` container + component rows (`Designed`). `.env.example` mirrors new vars. *Verify:* `validate:docs:all` green; env table ↔ `.env.example` parity.
- **T0.8 — implementation-status tags + consistency review.** Tag every described piece `Designed` (flips to `Implemented` in its code phase). Consistency reviewer cross-checks: ERD columns == OpenAPI schemas == analytics entities == planned migration; refusal rules stated as the allow-list the code will use (`not-ready when status ∈ {pending,failed,stale,skipped}`). *Verify:* no spec describes code that won't exist at its phase HEAD.

**Phase 0 exit gate:** `pnpm validate:docs:all` green; both OpenAPI files lint-clean; ERD/analytics/API/migration-shape mutually consistent (reviewer sign-off). **No code merged in Phase 0.**

> ✅ **Shipped 2026-06-02.** 104/104 mermaid blocks green; both OpenAPI specs lint-clean; adversarial consistency review passed after fixing 1 BLOCKER (`token_audit_log.token_id` NOT NULL + audit-attribution model) + 3 nits (`skipped` in the NOT-ready set; reconciled stale `c003f34` prose in `configuration.md`/`flow-dsl.md`). Artifacts: ADR-045/041/042, `system-analytics/external-operations.md`, `db/integrations-domain.md` + ERD/schema, `api/external/operations.openapi.yaml` + web.openapi.yaml token routes, error-taxonomy/configuration/architecture/flow-dsl/.env.example.

---

### Phase 1 — Service-layer extraction (refactor, zero behavior change)

> Prereq for API+MCP reuse. *blockedBy: T0.* Tester writes characterization tests; implementor extracts; reviewer asserts no drift / no auth bypass.

- **T1.1 (RED) — characterization tests.** Add service-level unit tests `web/lib/services/__tests__/{tasks,runs}.test.ts` pinning the exact outputs/transitions of today's inline handlers (status codes, DB rows, `attemptNumber`, executor resolution, error classes). Keep existing route tests as the integration oracle. *Runner:* unit + the existing `app/api/**/__tests__` integration. *Verify:* new tests fail (service doesn't exist yet); existing route tests still green.
- **T1.2 (GREEN) — extract `createTask` + `launchRun`.** New `web/lib/services/tasks.ts::createTask(input, actor, {db?})` and `web/lib/services/runs.ts::launchRun(input, actor, {db?})` holding the business logic verbatim from `web/app/api/projects/[slug]/tasks/route.ts` and `web/app/api/runs/route.ts`. **Auth decoupled:** the service takes a resolved `actor` (`{ userId? , tokenId?, label }`) and the already-authorized `projectId`; the route performs `requireProjectAction` and passes results in. Rewrite both existing route handlers to call the services. Centralize the duplicated `httpStatusForCode` into `web/lib/errors.ts` (`httpStatusForCode(code)`), update both routes to import it. *Log:* INFO on create/launch with actor label + ids; DEBUG on precondition branch taken. *Verify:* T1.1 green; existing route + trust-boundary integration tests green.
- **T1.3 (REVIEW).** Reviewer focus: transition parity (worktree compensation + tx ordering of `launchRun` unchanged), no `actor` field becomes a trust hole, no `body-controlled` projectId introduced, `httpStatusForCode` dedup didn't drop a code. *Verify:* full suite green; `git diff` shows only extraction + import rewires.

**Exit:** behavior byte-identical; both routes thin wrappers over services; `pnpm typecheck && test:unit && test:integration` green.

---

### Phase 2 — Token model: schema + lib + management API + audit

> *blockedBy: T0, T1.* Deployment-touchpoint phase (new tables, new routes).

- **T2.1 (RED) — schema + lib tests.** Unit tests for `web/lib/tokens/__tests__/`: `issueToken` (returns plaintext once; stores only `sha256`; prefix derivable), `verifyToken` (valid→actor; expired→null/`expired`; revoked→null/`revoked`; unknown→null/`invalid`; wrong-project handled by caller), `timingSafeEqual` use, `recordTokenAudit`, `revokeToken` (idempotent). Integration tests for `app/api/projects/[slug]/tokens/__tests__/route.{test,integration.test}.ts`: create (admin→201 secret-once), list (no secrets, ever), delete (revoke→204; cross-project tokenId→404; non-admin→403). *Verify:* all RED.
- **T2.2 (GREEN) — migration `0018_m16_api_tokens.sql`.** Drizzle schema additions in `web/lib/db/schema.ts`: `project_tokens` (`id`, `project_id` FK cascade, `name`, `prefix` indexed, `token_hash`, `scopes` jsonb default full-set, `created_by` FK users, `created_at`, `last_used_at?`, `expires_at?`, `revoked_at?`) + `token_audit_log` (`id`, `token_id` FK, `project_id`, `actor_label`, `scope_used`, `endpoint`, `method`, `result`, `status_code`, `created_at` indexed). `pnpm db:generate` → rename to `0018_m16_api_tokens.sql`. *Verify:* migrates clean; columns == T0.5 ERD.
- **T2.3 (GREEN) — `web/lib/tokens/{issue,verify,audit,revoke}.ts`.** `issueToken`: `randomBytes(32).toString("base64url")` → `prefix = first 8 chars`, `token_hash = sha256(secret)`; store; return `{ tokenId, secret }`. `verifyToken(presented)`: parse prefix → indexed lookup → `timingSafeEqual(sha256(presented), row.token_hash)` → active/expiry/revoked checks → `{ tokenId, projectId, actorLabel, scopes }` or a typed `TokenAuthError(kind)`. `httpStatusForTokenAuth(kind)` (401/403). *Log:* DEBUG verify outcome (NEVER the secret/hash); WARN on auth-fail class; INFO on issue/revoke with tokenId+actor. *Verify:* T2.1 lib tests green.
- **T2.4 (GREEN) — management API.** `web/app/api/projects/[slug]/tokens/route.ts` (`POST` create + `GET` list) and `…/tokens/[tokenId]/route.ts` (`DELETE` revoke), session-auth + `requireProjectAction(editSettings)`; project from slug; tokenId row's project_id must match (404 else). Secret returned once on create; list omits hash+secret. *Verify:* T2.1 route tests green.
- **T2.5 — deployment wiring + docs flip.** Update `.env.example` (no new web secret — note tokens are per-row hashed in DB; this is the explicit "no new env" statement), `docs/configuration.md` token rows, flip `project_tokens`/`token_audit_log` analytics tags to `Implemented`. *Verify:* env table ↔ `.env.example` parity; `validate:docs:all` green.
- **T2.6 (REVIEW).** `security-sidecar` focus: hash-at-rest (no plaintext column), timing-safe compare, secret never logged/listed/echoed, revoked/expired truly rejected, audit cannot be skipped on the mgmt routes, no token id enumeration leak. *Verify:* full suite green.

**Exit:** issue/verify/revoke/audit green; secret shown once; sha256 at rest; constant-time verify.

---

### Phase 3 — External REST API (`/api/v1/ext/*`, token-authed, reuses services)

> *blockedBy: T1, T2.* The machine-facing surface for tasks + runs + readiness.

- **T3.1 (RED) — route tests.** Integration tests under `app/api/v1/ext/**/__tests__/`: `POST /api/v1/ext/projects/[slug]/tasks` (tasks:create → 201), `GET …/tasks` + `GET …/tasks/[taskId]` (tasks:read), `PATCH …/tasks/[taskId]` (tasks:update), `POST /api/v1/ext/runs` (runs:launch → 202, same contract as UI), `GET /api/v1/ext/runs/[runId]` (runs:read), `GET …/readiness` (readiness:read). Trust-boundary cases: missing/invalid/expired/revoked token → 401; wrong-project slug/taskId/runId vs token → 404; valid token → full project API (D4). Audit row asserted for every call. *Verify:* RED.
- **T3.2 (GREEN) — token-auth helper.** `web/lib/tokens/require-token.ts::requireToken(req, { slug?, scopeLabel })` → `verifyToken` + (if `slug`) assert resolved project id == token.projectId (404 else) → returns `{ actor, projectId }`; wraps the handler so `recordTokenAudit` is the AFTER-write with the final `result`/`statusCode`. *Log:* INFO audited action; WARN auth-fail. *Verify:* helper unit tests green.
- **T3.3 (GREEN) — routes.** Implement the six routes calling `createTask`/`launchRun` services (Phase 1) and read queries (`lib/queries/run.ts`, a new `getRunReadiness(runId)` that summarizes blocking gates incl. external_check + required artifacts). All cross-resource ids derive from URL + re-checked against `token.projectId`. NO body-controlled locators. *Verify:* T3.1 green.
- **T3.4 (REVIEW).** `codex:rescue` adversarial trust-boundary pass (the M7-class review): no cross-project access, no `body-controlled` project/run id, audit unskippable, error classes match `docs/error-taxonomy.md`, launch contract identical to UI. *Verify:* full suite green; flip `/api/v1/ext/*` analytics tags to `Implemented`.

**Exit:** external clients create/read/update tasks, launch + read runs + readiness via token; every call audited; cross-project denied.

---

### Phase 4 — `external_check` loop: ingestion + artifact + review-refusal + staleness

> *blockedBy: T0, T3.* The milestone's core. *Closes the M11a stub.*

- **T4.1 (RED) — gate-report + readiness tests.** Unit: manifest validation of `gates[].external` (`description?`, `staleOnNewCommit?` default `true`; unknown keys rejected); `markGatePassed`/`markGateFailed` for `external_check` (flip latest live `pending`/`stale` row → passed/failed; verdict carries `externalRunUrl,commitSha,reporterTokenId,reportedAt`); `assertEvidenceReady` extended (blocking `external_check` `pending|failed|stale|skipped` → not ready; `overridden`/`passed` → ready; opt-in vacuous-ready preserved; live-attempt filter). Integration: `POST /api/v1/ext/runs/[runId]/gates/[gateId]/report` (gates:report) — passed→gate passed + `test_report` artifact + **success-audit row, all in ONE tx**; failed→gate failed + artifact + success-audit in the same tx; **forced audit-INSERT failure on the success path → gate flip + artifact rolled back (no partial commit, no orphaned evidence)**; non-external gateId→404; cross-project→404 (failure-audit only, no gate/artifact write); re-report with new `commitSha`→prior superseded + re-stale. Runner test: a flow with a blocking `external_check` reaches `Review`, approval REFUSED while pending, ALLOWED after passed report, REFUSED again after downstream rework re-stales, ADMITTED after human override. *Verify:* RED.
- **T4.2 (GREEN) — gate-store + artifact.** Add the optional `external` block to `gateSchema` in `web/lib/config.schema.ts` (additive; `description?`, `staleOnNewCommit?` default `true`; no engine bump). Extend `web/lib/flows/graph/gate-store.ts` with `reportExternalGate({ runId, gateId, status, verdict }, db)` (transactional UPDATE of the live external_check row + supersede-on-new-commit) and a `test_report` artifact via `recordArtifact` (producer `gate`, locator inline/file). *Log:* INFO gate flip with gateId+status+commitSha (no token secret); DEBUG supersede decision. *Verify:* T4.1 unit green.
- **T4.3 (GREEN) — readiness extension.** Extend `web/lib/flows/graph/evidence-readiness.ts::assertEvidenceReady` to also query `kind="external_check"` blocking gates and add not-ready reasons (allow-list: ready only when `passed`/`overridden`). Keep the existing `artifact_required` logic intact. Confirm the `runner-graph.ts` review chokepoint already invokes it (engine ≥ 1.2.0); add `external_check`-aware reasons to the refusal message. *Verify:* T4.1 runner test green.
- **T4.4 (GREEN) — report route.** `web/app/api/v1/ext/runs/[runId]/gates/[gateId]/route.ts` `POST` (gates:report) via `requireToken`; on **successful ingestion** `reportExternalGate` performs the gate UPDATE + `test_report` artifact + **success `token_audit_log` INSERT in ONE `db.transaction`** (rollback-safe — see Atomicity §). Rejected requests (bad token/validation/cross-project/non-external gate) write only a **failure audit AFTER** and mutate no gate/artifact. `gateId` validated as a declared `external_check` gate on the run's flow (404 else). `commitSha` is evidence data, not a locator. *Verify:* T4.1 integration + rollback test green.
- **T4.5 — readiness endpoint wiring + staleness rule.** `getRunReadiness` (Phase 3) returns `{ external_check gates: [{gateId, status, description?, externalRunUrl?, commitSha?}], ... }` so CI knows which gate ids to report and what each expects (`description` from `gate.external`). Staleness anchors: (a) downstream rework/takeover → existing `markDownstreamStale` already flips external_check `passed→stale` (assert in test, no new code); (b) when `gate.external.staleOnNewCommit !== false`, a fresh report with a different `commitSha` supersedes the prior passed report and re-stales. **No sweeper** — staleness is event-driven (M15 owns any commit-watching policy). *Verify:* staleness tests green.
- **T4.6 (REVIEW).** Adversarial focus: pending blocking external_check truly refuses review (allow-list, not deny-list); failed/stale refuse; override admits without erasing verdict; multi-store tx atomic (gate+artifact+audit all-or-nothing); cross-project/non-external gate rejected; report idempotency (same commitSha+status → idempotent, no duplicate artifact). *Verify:* full suite + the new e2e (below stub) green; flip `external_check` analytics tags to `Implemented`.

**Exit:** full external-gate loop functional; review refuses on pending/failed/stale unless overridden; evidence graph shows the `test_report`.

---

### Phase 5 — Token-management UI (Integrations panel, EN+RU)

> *blockedBy: T2.* Data-management page built to the `web/CLAUDE.md` bar first time.

- **T5.1 (RED) — component/integration tests.** Tests for the Integrations panel: list renders tokens (view-only table, no inline edit), create-modal shows secret once + copy, revoke confirm; admin-gated (non-admin sees read-only/empty); URL-synced tab state. *Verify:* RED.
- **T5.2 (GREEN) — UI.** Add `integrations` to the `ProjectTab` union + `TABS` in `web/components/board/project-tabs.tsx`; new `web/components/board/panels/integrations-panel.tsx` (async Server Component, `isAdmin` gated) + a create-token modal (focus-trap, `aria-labelledby`, Escape, secret-shown-once with `role="alert"`) following `flow-packages-panel.tsx`/`InstallPackageModal`. Render in `web/app/(app)/projects/[slug]/page.tsx` under `tab === "integrations"`. *Log:* client logger boundary (no `console.log`). *Verify:* T5.1 green.
- **T5.3 (GREEN) — i18n.** Add `tokens` namespace + `nav.integrations` to `web/messages/en.json` AND `web/messages/ru.json`. *Verify:* both catalogs have identical key sets; RU present.
- **T5.4 (REVIEW).** Focus: secret never re-fetchable after create, accessibility (focus management, aria-live on errors), full-width table + narrow modal per `web/CLAUDE.md`, no secret in client logs. *Verify:* suite green.

**Exit:** admin creates/lists/revokes tokens; secret shown once; EN+RU; accessible.

---

### Phase 6 — Thin MCP facade (standalone `mcp/` package, REST client)

> *blockedBy: T3, T4.* New sidecar process → deployment-touchpoint phase.

- **T6.1 (RED) — tool-mapping + transport-auth tests.** Unit tests (in the new package) asserting each MCP tool maps to the correct `/api/v1/ext/*` REST call and faithful error mapping: `task_create|task_list|task_get|task_update|run_launch|run_get|readiness_get|gate_report`; a 401/403/404 from REST surfaces as a tool error (facade adds no authority). **Transport-auth tests:** under Streamable-HTTP, an unauthenticated/missing-inbound-bearer tool call is rejected with **401 and makes NO REST call**; a request WITH an inbound bearer forwards *that* token (not any env value) to `/api/v1/ext`; env `MAISTER_PROJECT_TOKEN` is **ignored under HTTP** transport and used only under stdio. *Verify:* RED.
- **T6.2 (GREEN) — package.** New top-level `mcp/` pnpm workspace package (`@maister/mcp`): `@modelcontextprotocol/sdk` (exact-pin), a thin REST client over `MAISTER_API_BASE_URL`, the eight tools, a `bin` entry. **Auth per transport:** Streamable-HTTP requires a per-request inbound bearer (extracted from the MCP request, forwarded verbatim as `Authorization` to `/api/v1/ext`; missing/invalid → 401, no REST call, **no ambient fallback**); stdio uses env `MAISTER_PROJECT_TOKEN`. NO DB/`web/lib` import — REST only. *Log:* INFO tool invocation (tool name + run/task id, never the token); WARN on rejected HTTP auth; ERROR on REST failure. *Verify:* T6.1 green; `pnpm --filter @maister/mcp build` clean.
- **T6.3 — deployment wiring.** Root `package.json`/workspace registration; `docs/deployment.md` "Running the MCP facade" (stdio = local + env token; **HTTP = per-request inbound bearer, never an ambient token; bind/expose guidance + reject-unauthenticated note**); `docs/configuration.md` + `.env.example` MCP vars (`MAISTER_PROJECT_TOKEN` tagged stdio-only); `docs/architecture.md` flips `mcp/` rows to `Implemented`. *Verify:* `validate:docs:all` green; binary on PATH check documented.
- **T6.4 (REVIEW).** Focus (ADR-024 thin-facade invariant): the facade can perform NO operation the token lacks authority for (proven by routing 100% through `/api/v1/ext/*`); **no ambient-token bypass on the HTTP transport** (an open listener must reject unauthenticated tool calls and never fall back to an env token); identical audit trail (every tool call lands a `token_audit_log` row via the REST layer); no second orchestration path; token never logged. *Verify:* package tests green (incl. the unauthenticated-HTTP-rejection case); an integration test drives a tool against a mock `/api/v1/ext/*` and asserts the audit row.

**Exit:** MCP facade builds + tools green; provably thin (REST-only, token-scoped, audited).

---

### Phase 7 — Consumer fanout + readiness surfacing

> *blockedBy: T4.* skill-context "fan a new state-changing surface to ALL consumers".

- **T7.1 (RED) — read-model tests.** Tests asserting a blocking `external_check` `pending|failed|stale` is reflected in BOTH `web/lib/queries/board.ts` (`FlightCard.mergeBlocked`/a new `externalGatePending` signal) AND `web/lib/queries/portfolio.ts` (cross-project home) — a run blocked on an external gate must NOT silently look ready on either surface. Run-detail timeline/evidence-graph shows the external `test_report` + gate status. *Verify:* RED.
- **T7.2 (GREEN) — surface it.** Extend `board.ts` + `portfolio.ts` read models + run-detail (`lib/queries/run.ts` / evidence-graph) to include external_check readiness; EN+RU strings for any new label. *Verify:* T7.1 green.
- **T7.3 (REVIEW).** Focus: no read model omitted (board AND portfolio AND run-detail), allow-list semantics (a future gate status doesn't silently read as ready), no capacity/slot accounting affected (no new run status was introduced — confirm). *Verify:* suite green.

**Exit:** external-gate readiness visible on board, portfolio, and run detail; no surface silently misreports.

---

### Phase 8 — E2E, as-built reconciliation, final verify

> *blockedBy: all.*

- **T8.1 — Playwright e2e.** `web/e2e/m16-external-operations.spec.ts` (seeded, authed): admin creates a token (secret once) → external `POST /api/v1/ext/projects/{slug}/tasks` + `POST /api/v1/ext/runs` with that token → run reaches `Review` with a blocking `external_check` pending → review approval refused → `POST …/gates/{gateId}/report` passed → approval allowed → evidence graph shows the `test_report` → new commit re-stales → re-report. Add `m16-` to the `authed` regex in `web/playwright.config.ts`; add an `m16` key to `web/e2e/_seed/fixtures.ts` (a flow declaring an `external_check` gate). *Verify:* `pnpm test:e2e` green (m16 spec).
- **T8.2 — as-built docs sync.** Flip ADR-024 status note (Designed→Implemented M16); reconcile `docs/system-analytics/external-operations.md` + `flow-graph.md` + `artifacts.md` + all four spec families to as-built; tick ROADMAP `M16` with an as-built note + Completed-table row. Migrate any assertion changed by behavior (name the files). *Verify:* `validate:docs:all` + both OpenAPI lints green.
- **T8.3 — final verify gate.** `pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm test:e2e && pnpm validate:docs:all && pnpm lint`. *Verify:* all green; run `/aif-verify` against the M16 acceptance criteria.

**Exit:** every M16 acceptance criterion demonstrably met; suites + docs green.

---

## Commit Plan (one checkpoint commit per phase, conventional commits)

| Commit | After | Message |
|--------|-------|---------|
| 1 | P0 | `docs(m16): SDD spec-freeze — ADR-045/041/042, external-ops analytics, ERD, OpenAPI` |
| 2 | P1 | `refactor(m16): extract createTask/launchRun services, centralize httpStatusForCode` |
| 3 | P2 | `feat(m16): project API tokens — schema, issue/verify/revoke, audit, mgmt API` |
| 4 | P3 | `feat(m16): /api/v1/ext token-authed external operations API (tasks, runs, readiness)` |
| 5 | P4 | `feat(m16): external_check gate loop — report ingestion, test_report artifact, review-refusal, staleness` |
| 6 | P5 | `feat(m16): integrations token-management UI (EN+RU)` |
| 7 | P6 | `feat(m16): thin MCP facade package (REST client, token-scoped)` |
| 8 | P7+P8 | `feat(m16): fan external-gate readiness to board/portfolio; e2e + as-built docs` |

---

## Acceptance Criteria → Phase Map (M16 roadmap)

- Create/list/revoke project tokens, hashed + shown once → **P2, P5**.
- Token-attributed audit (token id, actor, scope, project, endpoint, result) → **P2, P3**.
- External create backlog task without UI → **P3**.
- External launch run, same contract as UI (Flow/executor/base; target when M18 lands) → **P3**.
- Report `external_check` + attach artifact metadata; evidence graph shows it → **P4**.
- Readiness reflects external gate; stale on dependent commit/artifact change → **P4, P7**.
- Failed/missing/stale/skipped blocking external gate blocks **review** (promotion = M18, reuses the same check) until rerun or human override → **P4**.
- MCP tools = facade over the same service/API, cannot exceed token scope → **P6**.
- Deferred (unchanged): OAuth apps, impersonation, full RBAC, generic webhooks, provider-specific CI apps, board sync, public-internet hardening beyond token.

---

## Rules-Compliance Checklist (skill-context, self-verified)

- [x] Deployment touchpoints enumerated (T0.7, T2.5, T6.3; new env vars + `.env.example` + configuration.md + deployment.md + new `mcp/` sidecar).
- [x] Every contract surface traced to its spec file (table above).
- [x] Body-controlled cross-resource ids challenged → all derive from URL + token (table above); none admitted.
- [x] Two-phase / multi-store atomicity specified (gate-report = one tx; audit = AFTER-write; launchRun parity).
- [x] Deferred-release inherited unchanged; no new deferreds introduced.
- [x] Test-runnability + per-phase green explicit (tests under `__tests__/`, runner named, e2e regex updated, assertion migration in-scope).
- [x] Complete analytics/design spec front-loaded as Phase 0 before any code.
- [x] Trust-vs-execution: N/A (MCP facade fetches no third-party code; it is a REST client only — noted).
- [x] New state-changing routes/gate-behavior fanned to ALL consumers (board + portfolio + run-detail) with allow-list guards (P4, P7).

---

## Resolved Decisions (2026-06-02)

1. **Namespace:** `/api/v1/ext` — versioned token-auth subset (D5).
2. **MCP transport:** Streamable-HTTP default (remote CI/agents) with **mandatory per-request inbound bearer** (no ambient token); stdio optional, env-token local-only (D2, Phase 6).
3. **`external_check` manifest:** typed `gates[].external` block (`description?`, `staleOnNewCommit?`); additive, no engine bump (Phase 0 T0.6, Phase 4 T4.2).
4. **DB domain doc:** `docs/db/integrations-domain.md` (T0.5).
5. **Branch:** `feature/m16-external-operations-api` created from HEAD (`main`-equivalent).

No open questions remain — plan is implementation-ready.
