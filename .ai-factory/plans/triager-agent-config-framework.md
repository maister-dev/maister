# Plan — Triager Agent + Generic Agent-Config Framework

- **Branch:** `claude/keen-golick-97e1b2` (worktree; no new feature branch created)
- **Created:** 2026-06-25 · **Refined:** 2026-06-25 (2nd-iteration adversarial pass)
- **Design spec (source of truth):** [`docs/superpowers/specs/2026-06-24-triager-agent-design.md`](../../docs/superpowers/specs/2026-06-24-triager-agent-design.md)
- **Method:** SDD (docs/contracts first) → TDD (RED → GREEN → refactor) per code task.

## Settings

- **Testing:** YES — TDD. RED first (failing test), then GREEN (minimum impl), then refactor. Two vitest projects (`web/vitest.workspace.ts`): `unit` (`lib/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`, `components/**`) and `integration` (`lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`, real Postgres via `@testcontainers/postgresql`). Both globs already cover the paths this plan adds — **no runner-config change required** (confirmed `vitest.workspace.ts:18-38`).
- **Logging:** VERBOSE. Existing `pino` boundaries (root rule: `no-console`). DEBUG for decision tracing (config resolution, dedup match, routing choice, tick candidate selection/rejection), INFO for state changes (verdict applied, `flagged` set, enqueue intent set, tick launch), WARN for refusals/skips (unroutable→flag, candidate refused, cap→Pending, give-up).
- **Docs:** YES (mandatory). Phase 0 front-loads the COMPLETE, internally-consistent SDD spec set BEFORE any code. Final docs gate in Phase 6.
- **SOLID / KISS / DRY:** reuse existing seams (`applyTriageVerdict`, `validateVerdictRefs`, `launchRun`, `classifyTaskLaunchability`/`classifyManualTaskLaunchability`, `getOpenRelationBlockers`, `upsertAgentRow` SET/CLEAR, `handleExt`, scheduler `runClaimedJob`, the `flowIssue` enablement/trust check `launch-options` already computes). New abstraction only for the generic config framework (owner-requested; triager is its first consumer).

## Roadmap Linkage

- **Milestone:** none (new capability). Realizes the **Stage-3 triager** anticipated by M32 (`task.triage_requeued` registered emitter-less "for the Stage-3 triager") and M34 (triage verdict ops, `unconfigured` launchability). `/aif-verify --strict` should WARN (not fail) on missing linkage.

## Reserved numbers (from `main` HEAD, 2026-06-25)

> Plan-rule: reserve ADR + migration numbers from **main's HEAD**, not the branch. Branch is behind main (branch migration max = 0068, ADR max = 109; **main** migration journal max = **idx 70**, ADR max = **109**).

- **ADR-110** — Generic agent-config framework.
- **ADR-111** — Triager agent (`duplicate_of`/`flagged` substrate, `auto_launch_triaged` tick, `flow_list`/`runner_list` MCP, `flows:read`/`runners:read` scopes, triage `flag`/`enqueue`).
- **Migration 0071** — config-framework columns (`agents.config_schema`, `agent_project_links.config`, `runs.agent_config`).
- **Migration 0072** — dedup substrate (`tasks.triage_status` += `flagged`; `task_relations.kind` += `duplicate_of` + check).
- **Rebase-first (Phase 0.0, refinement N1):** the branch is **2 migrations behind main** (0068 vs 0070). Rebase onto main BEFORE any code so `db:generate` yields **0071/0072 + ADR-110/111 directly** — otherwise dev would generate 0069/0070, colliding by number with main's unmerged 0069/0070 (same idx, different content → journal/snapshot conflict at merge).
- **Renumber pass = Phase 6, T6.1** (mandatory safety re-check): after the build, re-derive max ADR + migration at the (possibly-advanced) main HEAD and renumber if collided. `pnpm validate:docs` only parses Mermaid + ADR anchors — NON-evidence for numbering; run `scripts/validate-docs-adr-anchors.mjs` + a manual journal-max check.

---

## Decisions & plan-rule compliance

### D1. Contract-surface → spec-file map

| Surface | Spec file(s) to update |
| --- | --- |
| `GET /api/v1/ext/projects/{slug}/flows`, `GET …/runners` | `docs/api/external/operations.openapi.yaml` + `docs/system-analytics/triage.md` + `external-operations.md` |
| `POST …/tasks/{taskId}/triage` gains `flag` + `enqueue` (semantics change) | `operations.openapi.yaml` (body schema + examples) + `triage.md` |
| MCP tools `flow_list`, `runner_list` | `mcp/src/tools.ts` tool list + `triage.md`/`agents.md` MCP-facade section |
| Token scopes `flows:read`, `runners:read` | `operations.openapi.yaml` (scopes) + `external-operations.md` |
| `agents.config_schema`, `agent_project_links.config`, `runs.agent_config` | migration 0071 + `docs/database-schema.md` + `docs/db/agents-domain.md` + `docs/db/runs-domain.md` |
| `tasks.triage_status` += `flagged` | migration 0072 + `database-schema.md` + tasks ERD + `tasks.md` + `triage.md` |
| `task_relations.kind` += `duplicate_of` (+ check) | migration 0072 + `database-schema.md` + relations ERD + `social-board.md` + `tasks.md` |
| Agent frontmatter `config:` | `docs/system-analytics/agents.md` |
| Scheduler job kind `auto_launch_triaged` | `docs/system-analytics/scheduler.md` + `job-catalog.ts` |
| ADR-110, ADR-111 | `docs/decisions.md` (index + body + anchors) |

### D2. HTTP route identifier trust labels

- `GET …/flows` & `GET …/runners`: `slug` = **url-param** (validated by `handleExt` against the token's project; cross-project → 404); `projectId` = **server-state** (`ctx.projectId`). Runners are platform-scoped → runners route returns the global `enabled` catalog (no project filter). **No body-controlled cross-resource id.**
- `POST …/triage` (extended): `taskId` = **url-param** (re-validated → 404); `flag`/`enqueue` = **body-controlled** booleans (not locators; safe).

### D3. New-enum-value fan-out + allow-list guards — FULL consumer set (refinement I2)

**`tasks.triage_status` += `flagged`** — fan out to EVERY consumer; guard as **allow-list**:
- **Type:** `TaskDTO.triageStatus` (`web/lib/services/tasks.ts:173`) widens to `"triaged" | "flagged" | null`; `taskToDTO` maps it.
- **Classifier functions:** `web/lib/runs/launchability.ts` — `TaskLaunchability` += `flagged`; BOTH `classifyTaskLaunchability` AND `classifyManualTaskLaunchability` return non-launchable for `flagged` **even when `flowId` is set** (a human could set a flow on a flagged dup — must still be held). Precedence: `flagged` above `unconfigured`.
- **The 5 classifier call-sites, each given a `flagged` arm:** `lib/services/runs.ts:343` (`launchRun` → refuses `flagged`, defence for the tick); `app/api/runs/launch-options/route.ts:381` (response `launchability='flagged'` → UI shows "resolve first", NOT "set up & launch"); `lib/run-schedules/dispatch.ts:262` → `decideFire` (a user cron schedule skips a flagged task — add a `skipped_flagged` outcome alongside `skipped_unconfigured`/`skipped_blocked`); task-detail `app/(app)/projects/[slug]/tasks/[number]/page.tsx:173`; `lib/runs/task-launch-config.ts:291`.
- **Read models / UI:** `lib/queries/board.ts` + portfolio/home + `lib/queries/task-detail.ts` — `flagged` chip ("needs review"); the launch-popover variant.
- **Tick predicate:** keyed on `triage_status='triaged'` → `flagged` excluded by construction (assert in a test).
- **i18n:** `messages/en.json` + `ru.json` chip label (parity green).

**`task_relations.kind` += `duplicate_of`** — non-blocking by construction: `getOpenRelationBlockers` (`relations.ts:215`) queries ONLY `blocks`/`depends_on`/`requires`; `duplicate_of` is never queried → never gates launch (explicit regression). Blocking-kind set stays the allow-list `{blocks, depends_on, requires}`. Touch `TaskRelationKind` union (`relations.ts:27`), schema enum + check (`schema.ts:3160,3181`), `relation_add` MCP + ext, relation display.

**`launchMode='auto'` producer (triage enqueue)** — consumed by the NEW `auto_launch_triaged` tick only; **disjoint** from `auto_launch_run_plan` (requires `parent_of`-under-orchestrator + `delegation_spec.agentId`, launches agent runs). Disjointness asserted by test.

### D4. Multi-store atomicity & two-phase

- Triage write (verdict OR `flag`; optional `enqueue`→`launchMode='auto'`; `triage_status`; `task_activity`; token audit) = **ONE `db.transaction`** (extend `applyTriageVerdict` `triage.ts:133`).
- `auto_launch_triaged` tick reuses `launchRun` (`runs.ts:1032`), which owns the git side-effect (before tx) + run insert + supervisor spawn (after commit). Tick writes NO idempotency mark before `launchRun`; idempotency = `hasAnyRun`-style live-run guard (mirror `auto-launch.ts:57`) + singleton scheduling (budget = 1).

### D5. Launch-time snapshot

`runs.agent_config` is resolved ONCE at spawn and written in the `runRow` insert (`launch.ts` ~978, alongside `executionPolicy`/`runnerSnapshot`). `buildAgentPrompt` injects from the **snapshot `run.agentConfig`**, never re-resolves from the (mutable) link/definition (refinement I4).

### D6. Deployment touchpoints

**No new env var, config file, bound port, or sidecar.** Tick cadence = a hardcoded `DEFAULT_*_CADENCE_SECONDS = 60` constant (mirrors existing singletons). Core package uses the EXISTING `MAISTER_DEFAULT_PACKAGE_SOURCES` env. → **No deployment-wiring task / no compose change** (explicitly checked).

### D7. Trust-before-execute

Triager ships in a core package with **no `setup.sh`** (no fetch-then-execute). Launch gated by the EXISTING contour (`launch.ts:295-347`): refuse disabled / quarantined / untrusted / pin-divergent; `risk_tier:read_only`; `workspace:none`. Package must be enabled + trusted before launch (asserted).

### D8. Test-integrity

Each code task names its runner project + path (globs already match). Each phase exits on **full suite green** (`pnpm -C web test:unit && pnpm -C web test:integration`). Assertion-migration is in-scope and names touched tests. Integration tests run against real Postgres (host docker via `DOCKER_HOST=$HOME/.docker/run/docker.sock` + `dangerouslyDisableSandbox`).

### D9. No-silent-stall on the triage→enqueue→tick path (refinement I1 — closes a logical hole)

`validateVerdictRefs` (`triage.ts:68`) today validates a verdict `flowId` for **existence + project only** — NOT enablement/trust. A triager could stamp `triaged`+`enqueue` on a **disabled/untrusted** flow → the tick's `launchRun` refuses (flow not in `LAUNCHABLE_ENABLEMENT_STATES` / `trustStatus='untrusted'`) → the task hangs `triaged`+`auto` forever while the tick WARN-spams every 60s. **Two-sided fix:**
1. **Read side** (`flow_list`, T2.2): return ONLY assignable flows — `enablementState ∈ {Enabled, UpdateAvailable}` ∧ `trustStatus ≠ untrusted` — so the agent can only pick launchable flows.
2. **Write side** (`validateVerdictRefs`, T4.3): validate the verdict flow's enablement + trust → `CONFIG` at triage time (reuse the `flowIssue` logic `launch-options/route.ts` already computes). Regression: `triage_set` with a disabled flow → **422 `CONFIG`** (not a silent stall).
3. **Give-up** (tick, T4.4): if a flow becomes unlaunchable AFTER a valid triage, the tick must not loop forever — see T4.4.

---

## Tasks

### Phase 0.0 — Rebase precondition (refinement N1)

**T0.0 — Commit spec+plan, rebase branch onto `main`**
- Commit the design spec + this plan + (later) ADR stubs; rebase `claude/keen-golick-97e1b2` onto `main` (brings the branch to migration 0070 / ADR-109). Resolve any conflicts.
- Acceptance: `git show main:web/lib/db/migrations/meta/_journal.json` max idx == the branch's max idx; `db:generate` (dry) would yield 0071 next; ADR-110/111 free at the rebased HEAD. **Blocks Phase 1, 2, 3.**

*(If the owner prefers develop-then-renumber instead of rebase-first, skip T0.0 — then dev migrations are 0069/0070 branch-local and Phase 6 T6.1 renumbers them. Rebase-first is recommended for migration-heavy work to avoid journal/snapshot surgery.)*

---

### Phase 0 — SDD foundation (docs/contracts FIRST; no code)

> Exit: docs COMPLETE + internally consistent; every transition + refusal written as code will gate it (allow-list); implementation-status = `Designed`; `npx @redocly/cli lint …operations.openapi.yaml` = 0 errors; `pnpm validate:docs` + `node scripts/validate-docs-adr-anchors.mjs` green.

**T0.1 — Write ADR-110 + ADR-111** — `docs/decisions.md` index rows + bodies. ADR-110: config framework (declare→project→instance→resolve→inject→snapshot). ADR-111: triager, two-tier clarity, `duplicate_of`/`flagged`, `auto_launch_triaged` (disjoint from ADR-098), `flow_list`/`runner_list`, scopes, triage `flag`/`enqueue`, **the D9 no-silent-stall contract**. Acceptance: headers + index rows exist; anchors slugify-match; `validate-docs-adr-anchors.mjs` green.

**T0.2 — Create `docs/system-analytics/triage.md`** (R5). State machine: `triage_status null→triaged|flagged`, `launchMode` enqueue intent, **full launchability precedence incl. `flagged` exactly as the classifier gates**. Process flows: two-tier clarity, dedup, deps, enqueue, tick launch + dependency-release + give-up. Edge cases: clarify max-rounds→flag, dup-no-verdict, blocked+auto waits, cap→Pending, disjoint orchestrator, **stale-flow give-up (D9/T4.4)**. Implementation-status `Designed`; Mermaid valid.

**T0.3 — Update agents/tasks/scheduler/social-board docs** — agents.md (config framework + triager); tasks.md (`flagged` in launchability table at the right precedence + `auto_launch_triaged`); scheduler.md (`auto_launch_triaged` kind); social-board.md (`duplicate_of`, non-blocking). Cross-doc consistency.

**T0.4 — Update ERD (both artifacts)** — `docs/database-schema.md` narrative (0071 + 0072) AND every relevant `docs/db/*.md` erDiagram (agents-domain, runs-domain, tasks/relations). One without the other fails the rule.

**T0.5 — API contracts** — `operations.openapi.yaml`: 2 GET paths (flows = launchable-only projection per D9; runners = enabled-only) + scopes `flows:read`/`runners:read`; **extend the triage `POST` body** with `flag:boolean` + `enqueue:boolean` + the **refine semantics (refinement I3):** `flag` is mutually exclusive with verdict fields (`flag` + any verdict → 422 `CONFIG`); `enqueue:true` requires a verdict yielding a `flowId`; the existing "≥1 field" refine still holds (`flag` alone is valid). Add examples + response schemas. Document `flow_list`/`runner_list` MCP shapes + the D2 identifiers table in `triage.md`. Acceptance: redocly lint = 0 errors; schemas match Phase 2 projections.

*Commit checkpoint C0: "docs(triage): SDD foundation — ADR-110/111, triage.md, ERD, OpenAPI (Designed)".*

---

### Phase 1 — Generic agent-config framework (migration 0071)

**T1.1 — RED: config declaration parsing** — `web/lib/agents/__tests__/definition.test.ts` (unit). Each type `boolean|enum|string|number` + default/label/description; missing→null; enum w/o values→`CONFIG`; unknown type→`CONFIG`; dup key→`CONFIG`; default∉values→`CONFIG`; `renderAgentDefinition` round-trips.

**T1.2 — GREEN: config schema** — `definition.ts`: `configParamDeclSchema` + `config:` into `agentDefinitionFrontmatterSchema` (~157); extend `ParsedAgentDefinition` (~194); map in parse (~254) + render (~292); reuse strict-`CONFIG` (~233-240).

**T1.3 — RED: `config_schema` projection (SET/CLEAR/re-set)** — `registry.integration.test.ts`. Declared `config:` → column SET; `.md` drops `config:` → re-sync → `null` (CLEAR); re-add → equal again (idempotent). (Mandatory config-state-symmetry round trip.)

**T1.4 — GREEN: columns + migration 0071** — `schema.ts` (`agents.config_schema` jsonb ~797; `agent_project_links.config` jsonb ~850; `runs.agent_config` jsonb after `budgetState` ~1350); `registry.ts` `syncedColumns += configSchema: parsed.config ?? null` (~108). `pnpm -C web db:generate` → after T0.0 this yields tag **`0071_agent_config_framework`** (3 additive columns); verify SQL + `meta/0071_snapshot.json` (journal contiguous). *(Without T0.0, the branch yields 0069 here; Phase 6 renumbers.)*

**T1.5 — RED: `resolveAgentConfig`** — `config.test.ts` (unit). Instance overrides default; null instance→defaults; partial override; unknown instance key ignored; type-coerced.

**T1.6 — GREEN: `resolveAgentConfig`** — `web/lib/agents/config.ts` `resolveAgentConfig(declared, instanceValue)` (mirror 2-level resolve `launch.ts:796,928`); wire `agent_project_links.config` read.

**T1.7 — RED: prompt injection + run snapshot** — `launch.test.ts` (fake DB) + `launch-config-snapshot.integration.test.ts`. `buildAgentPrompt` includes an "Effective configuration" block before the task block; `runs.agent_config` persisted in the run-insert row; **injection reads the SNAPSHOT** (mutate the link after spawn → injected block + snapshot unchanged).

**T1.8 — GREEN: inject from snapshot** — `launch.ts`: resolve config in `startAgentSession`, write `agentConfig: resolvedConfig` into `runRow` (~978); `buildAgentPrompt` pushes `buildConfigContextBlock(run.agentConfig)` from the **snapshot** (~1313) — per D5, never re-resolve. DEBUG-log resolved keys.

**T1.9 — RED+GREEN: instance Config UI + aggregating PATCH** — `agents-attach-edit-modal.tsx` (Config section after the policy selects ~325, each `config_schema` param → toggle/select/input seeded from effective) + `agents-attach-panel.tsx` (`configSummary` column) + PATCH `app/api/projects/[slug]/agents/[agentId]/route.ts` (`configValues` into the one aggregating tx; SET/CLEAR symmetric). Component + route tests (SET then CLEAR).

**T1.10 — i18n + phase green** — en/ru config labels; `i18n-parity.test.ts` green. Phase exit: `test:unit && test:integration` green; `tsc`+`lint` clean; 0071 + snapshot consistent.

*Commit C1: "feat(agents): generic agent-config framework [ADR-110, migr 0071]".*

---

### Phase 2 — Discovery MCP `flow_list` / `runner_list` (no migration)

**T2.1 — RED: ext routes** — `…/flows/__tests__/route.integration.test.ts` + `…/runners/…`. 200 projection (flows → `{id, ref, metadata:{title,summary,route_when,labels}}`, **launchable-only per D9**; runners → `{id, adapter, model, …}`, `enabled=true` only); 401; 403 wrong scope; 404 cross-project; audit row.

**T2.2 — GREEN: scopes + routes + projections** — `types/token-scopes.ts` (`TOKEN_SCOPES` + `AGENT_TOKEN_SCOPES` += `flows:read`,`runners:read`); `ext-handler.ts` `PROJECT_ACTION_BY_SCOPE` += both `→ readBoard`; 2 GET routes (mirror `tasks/route.ts:116`); flows projection (derive from `project.ts:138`, cast `manifest as FlowYamlV1` for `metadata`, **filter `enablementState ∈ {Enabled,UpdateAvailable}` ∧ `trustStatus ≠ untrusted`** — D9 read side) + enabled-runners projection (`project.ts:151`).

**T2.3 — RED: MCP routing** — `mcp/src/__tests__/tools.test.ts`: bump "registers all **24**" → **26** + add names to sorted list; GET routing (`flow_list→GET …/flows`, `runner_list→GET …/runners`, no body).

**T2.4 — GREEN: MCP specs** — `mcp/src/tools.ts`: `TOOL_SPECS.flow_list`/`runner_list` (`inputSchema {slug}`) + `resolveRouting` cases (mirror `task_list:436`). Phase exit: mcp + web suites green; redocly green.

*Commit C2: "feat(mcp,ext): flow_list/runner_list (launchable-only) + flows:read/runners:read [ADR-111]".*

---

### Phase 3 — Dedup substrate: `duplicate_of` + `flagged` (migration 0072)

**T3.1 — RED: relations + status writes** — extend `social-domain.integration.test.ts`. `addTaskRelation('duplicate_of')` persists (check accepts) + remove idempotent; **`duplicate_of` NOT in `getOpenRelationBlockers`** (stays launchable) — explicit regression; `triage_status='flagged'` write/read.

**T3.2 — GREEN: schema + migration 0072** — `schema.ts` (`task_relations.kind` enum ~3160 + `kind_check` sql ~3181 += `duplicate_of`; `tasks.triage_status` enum ~1048 += `flagged`); `relations.ts` `TaskRelationKind` += `duplicate_of`. `pnpm -C web db:generate` → **`0072_dedup_substrate`** (verify it emits DROP/ADD CONSTRAINT for the check + snapshot). *(Number after T0.0; else 0070 branch-local, renumbered in Phase 6.)*

**T3.3 — RED: launchability for `flagged`** — `launchability.test.ts`. `flagged` → non-launchable in BOTH classifiers **even with `flowId` set** + no blockers; precedence (flagged > unconfigured/blocked); non-flagged triaged stays launchable; `duplicate_of` alone non-blocking.

**T3.4 — GREEN: launchability + FULL fan-out (refinement I2)** — per D3: `TaskLaunchability += flagged` (allow-list, precedence); `TaskDTO.triageStatus` widen + `taskToDTO`; the **5 call-sites** each get a `flagged` arm — `runs.ts:343` (refuse), `launch-options/route.ts:381` (UI hint), `dispatch.ts:262`→`decideFire` (`skipped_flagged`), task-detail `page.tsx:173`, `task-launch-config.ts:291`; read models `board.ts`/portfolio/`task-detail.ts` chip; `relation_add` MCP+ext accept `duplicate_of`. Grep `triageStatus`/`triage_status` consumers → each handled.

**T3.5 — RED+GREEN: triage `flag` outcome** — `triage.ts` (`flag` path: `triage_status='flagged'`, NO verdict columns, activity, in the one-tx) + triage route (accept `flag:true` under `tasks:triage`; **mutual exclusion** per I3: verdict + `flag` → 422 `CONFIG`). Tests: `flag`→`flagged` one-tx + audit; verdict+flag → 422.

**T3.6 — i18n + phase green** — en/ru `flagged` chip; parity green. Phase exit: web suites green; `flagged` held everywhere; `duplicate_of` non-blocking proven; 0072 + snapshot consistent.

*Commit C3: "feat(tasks): duplicate_of + flagged, launch-held + full fan-out [ADR-111, migr 0072]".*

---

### Phase 4 — `auto_launch_triaged` tick (no migration)

**T4.1 — RED: tick behavior** — `web/lib/scheduler/handlers/__tests__/auto-launch-triaged.integration.test.ts`. Candidate (`triaged` + `launchMode='auto'` + `flowId` + launchable + no live flow run + not orchestrator) → `launchRun` flow run; **dependency-wait** (`depends_on` blocker Backlog/InFlight → not launched; blocker→Done → next tick launches); `flagged` → not launched; cap → `Pending`; **disjoint** (orchestrator as-plan: `parent_of`+`delegation_spec.agentId` → not picked); **idempotent** (live flow run → no double).

**T4.2 — GREEN: handler + registration** — `handlers/auto-launch-triaged.ts` (D3 predicate; per-candidate `classifyTaskLaunchability` + `getOpenRelationBlockers` + `hasAnyRun` guard; `launchRun(input,{authorize:async()=>{},actorUserId:null})` mirroring `handlers/flow-run.ts`; WARN-not-throw on refusal); register kind in `job-catalog.ts` (`creatable:false, systemManaged:true`, seeded id), `budgets.ts` (key + limit 1), `jobs.ts` (2 SQL `CASE` blocks + seeded INSERT 60s + `schedulerBudgetForKind`), `tick-service.ts` (`case`). Predicate disjoint from `auto-launch.ts`.

**T4.3 — RED+GREEN: enqueue intent + D9 write-side validation** — `triage.ts` + route accept `enqueue:true` → set `tasks.launchMode='auto'` in the verdict tx (only valid with a verdict yielding `flowId`; `CONFIG` otherwise). **Refinement I1 (write side):** extend `validateVerdictRefs` to validate the verdict flow's enablement + trust (reuse the `flowIssue` enablement/trust check) → `CONFIG`. Tests: verdict+`enqueue` → `launchMode='auto'` one-tx; wire-through (tick launches); **`triage_set(disabled/untrusted flow)` → 422 `CONFIG`** (no silent stall).

**T4.4 — RED+GREEN: tick give-up for stale flow (refinement N2)** — if `launchRun` refuses a triaged+auto candidate with a **terminal `PRECONDITION`** (flow disabled/untrusted post-triage, target branch taken), the tick must not loop forever: clear `launchMode` (back to manual-launchable) + post a system comment (or set `flagged`) + INFO-log. Transient refusals (cap→Pending) are NOT give-up. Tests: stale-flow candidate → one give-up action, not re-attempted next tick; cap-hit candidate → stays `auto`, retried. Phase exit: web suites green.

*Commit C4: "feat(scheduler): auto_launch_triaged tick + no-silent-stall guards [ADR-111]".*

---

### Phase 5 — Triager agent + core package + register/trust

**T5.1 — Author `triager.md`** — frontmatter (`workspace:none`, `mode:session`, `triggers:[domain_event,manual]`, `risk_tier:read_only`, `recommended.events:[task.created,task.triage_requeued,task.comment_added]`, `config:` = `auto_enqueue(off|when_confident|always=off)`/`detect_duplicates(bool=true)`/`intake_mode(triage_only|clarify=clarify)`); body = two-tier policy (load task+backlog+catalog via `task_get`/`task_list`/`flow_list`/`runner_list`; dedup→`relation_add(duplicate_of)`+`comment_create`+`flag`; routing-floor → `clarify` asks / `triage_only` flags; deps→`relation_add`; verdict→`triage_set`; enqueue per `auto_enqueue`; **only assign flows returned by `flow_list`** — D9). Location: maister-plugins core package (external) + a fixture under `web/lib/agents/__tests__/fixtures/core-package/`. Acceptance: `parseAgentDefinition` ok; config valid; `risk_tier=read_only`; no `flow:`.

**T5.2 — RED+GREEN: register→attach→launch with config + trust gate** — `triager-package.integration.test.ts`. Install fixture core package → `resyncAgents` → `agents` row `<core>:triager` with `config_schema`; attach link (seeded from `recommended`); launch via stub-supervisor → `runs.agent_config` snapshot + config injected; **trust gate**: untrusted/disabled launch → `PRECONDITION` (D7). GREEN: verify flow-less package registration (fix if a gap surfaces); document the external maister-plugins core-package deliverable.

**T5.3 — RED+GREEN: behavioral wire-through** — `triager-wire.integration.test.ts`. `task.created` with the triager event binding → `agent_triggers` consumer enqueues a triager run (self-exclusion intact); simulated triager `triage_set`(verdict)+`enqueue` → `triaged`+`launchMode='auto'` → `auto_launch_triaged` tick launches the flow run. Wiring only; live-agent E2E manual (note in `triage.md`). Phase exit: web suites green.

*Commit C5: "feat(agents): triager agent + core package + behavioral wiring [ADR-111]".*

---

### Phase 6 — Renumber pass + final verification

**T6.1 — Renumber pass (mandatory)** — after the final rebase onto main: re-derive `max(### ADR-NNN)` (`git show main:docs/decisions.md`) + `max idx` (`git show main:…/_journal.json`). If ADR-110/111 or migration 0071/0072 collide, renumber (headers + index + every `[ADR-NNN]` xref + migration tags/journal/snapshots) + re-run `validate-docs-adr-anchors.mjs`. `validate:docs` green is NON-evidence for numbering.

**T6.2 — Final gates** — make green: `pnpm -C web typecheck`; `lint`; `test:unit`; `test:integration`; `pnpm -C mcp test`; `npx @redocly/cli lint …operations.openapi.yaml`; `pnpm validate:docs` + `validate:docs:all`; `i18n-parity`; supervisor `tsc` if touched. Flip implementation-status `Designed → Implemented`. No skipped/quarantined test without a tracked reason.

---

## Commit Plan

- **C0.0** (Phase 0.0): chore — commit spec+plan, rebase onto main.
- **C0** (Phase 0): docs SDD foundation (`Designed`).
- **C1** (Phase 1): config framework [ADR-110, migr 0071].
- **C2** (Phase 2): `flow_list`/`runner_list` + scopes [ADR-111].
- **C3** (Phase 3): `duplicate_of` + `flagged` [ADR-111, migr 0072].
- **C4** (Phase 4): `auto_launch_triaged` tick + no-silent-stall guards [ADR-111].
- **C5** (Phase 5): triager agent + core package.
- **C6** (Phase 6): renumber pass + `Designed → Implemented`.

(Conventional commits; no Co-Authored-By trailer per owner preference.)

## Unresolved questions (RU, краткие)

1. `triager.md` в maister-plugins — внешний репо склонирован локально (создам core-пакет там) или ручная задача после мерджа? (план: фикстура здесь + external deliverable)
2. Core-пакет: авто-преинсталл (default-source/seed) или вручную в проект? (план env не трогает)
3. `intake_mode=clarify`: максимум раундов вопросов до `flag` — фиксирую **3** или конфиг-кноб?
4. Rebase-first (T0.0) сейчас, или предпочитаешь develop-then-renumber (миграции 0069/0070 на ветке → renumber в Phase 6)?
