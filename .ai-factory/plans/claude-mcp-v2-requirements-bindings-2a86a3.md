# Implementation Plan: MCP Management v2 — Requirements & Bindings

Branch: claude/mcp-v2-requirements-bindings-2a86a3
Created: 2026-07-11
Base: main @ 5916d4ea8 (verified: max ADR 128, max migration idx 92)

## Settings
- Testing: yes
- Logging: verbose (detailed DEBUG on resolution / binding / overlay / probe seams; env-controlled `LOG_LEVEL`, reducible in prod without code edits)
- Docs: yes — mandatory docs checkpoint (docs-first Phase 0 gate)

## Roadmap Linkage
Milestone: "M43 — MCP Management v2: requirements & bindings across package/platform/project, per-project config, trust & health activation"
Rationale: closes the seven verified gaps in the M27/ADR-070 + M14/ADR-043 MCP substrate; recorded here only — `/aif-plan` does not edit ROADMAP.md (that is `/aif-roadmap`'s artifact).

---

## Scope & locked decisions (owner, 2026-07-11)

MCP servers become first-class manageable at all three scopes — **packages** (declare a requirement OR ship a server template), **platform** (catalog once, pick up everywhere), **projects** (connect platform MCPs, match them to package requirements, connect+configure package-shipped MCPs). The implicit `refId`-equality model is replaced by an **explicit requirements & bindings layer**. The `env:NAME`-only secret invariant is untouchable.

Owner-locked decision points (do not reopen):
- **D1** — binding entity = **new `project_mcp_bindings` table** (clean FK targets, audit, overlay jsonb), NOT an overload of `capability_records`.
- **D2** — platform→project pickup = **grandfather** implicit projection. Existing behavior stays; disconnect is an explicit per-project opt-out. Opt-in mode is a later platform setting.
- **D3** — requirement-only package declarations are **additive-optional**; confirmed **no `schemaVersion` bump** (see Findings §F9 — ADR-088 requires a bump only for a new *content kind*, not a new optional field on an existing kind).
- **D4** — **probe refuses untrusted-source stdio with a typed reason — NO admin override in v1** (owner lock; the request's "unless admin overrides" was the pre-lock phrasing, resolved to no-override). The gate is enforced **web-side before the supervisor call** (exec-trust never reaches the supervisor as a named signal — Findings §F13).
- **D5** — a binding **also satisfies agent `capability_profile.mcps` refs** (one resolution path for flows / agents / scratch — feasible: agent MCP resolution already funnels through the same `resolveCapabilityProfile`, Findings §F6).
- **Hub placement** — the project MCP hub is the **existing board `?tab=mcps` tab, NOT a separate page**.

### Non-goals (explicit)
MCP marketplace / reputation / malware-scan / sandbox / org-policy · storing any secret **value** web-side (invariant untouchable) · MCP version pinning/auto-update · changes to the maister external MCP facade (`mcp/`) · per-node **enforcement semantics** (owned by the enforcement-flip plan; `capability_guard` consumes whatever set materialization delivers — no overlap beyond shared vocabulary) · OAuth flows for remote MCPs.

---

## Numbering & cross-branch coordination (skill-context: "allocate ADR + migration numbers up front + renumber pass")

- **ADR:** next-free at `main` HEAD = **ADR-129** (verified `git show main:docs/decisions.md` max = 128). **Contested five-way** (agent-format-superset 07-07 · postgres/graph cut-over 07-11 · enforcement-flip 07-11 · fork-loop 07-11 · this). Reserve **ADR-129 nominal**; write the `### ADR-129` stub header before citing it. Later-landing branches renumber — **this plan owns a renumber pass** (T8.4) that re-greps `docs/decisions.md` at merge and reassigns to the true next-free (expected **130+**).
- **Migration:** next-free main-lineage idx at HEAD = **0093** (`web/lib/db/migrations/meta/_journal.json` max idx 92; journal has gaps at 64/69/74/75 — numbering is not contiguous, always use `max`). Reserve **0093 nominal**; memory notes 0093 may be claimed by a sibling → renumber to **0094+** at merge (T8.4). A migration is a **triple** — `.sql` + `_journal.json` entry + `meta/<NNNN>_snapshot.json`; the integrity check that the newest journal entry has a matching snapshot is part of T1.x and re-verified in T8.4. **Do not touch the separate `brain-migrations` lineage.**
- **Engine version:** node `settings.mcps` shape is unchanged → **no engine bump**. Package manifest change is additive-optional (D3) → `schemaVersion` stays `1`.
- **Anchor check:** `pnpm validate:docs` only parses Mermaid; it does NOT resolve `[ADR-NNN](...)` anchors. T8.4 runs the real anchor check (`scripts/validate-docs-adr-anchors.mjs`) — a green Mermaid gate is non-evidence for numbering.

### Overlap-watch — enforcement-flip plan (branch `claude/capability-enforcement-acp-seam-7f6053`)
That plan touches `agent-map.ts` / materialization delivery. **This plan MUST NOT change the `mcpServers` ACP wire shape** beyond applying the env overlay web-side (rewriting `envKeys`/`command`/`args`/`url`/`headerKeys` names in the `AgentMcpServer` before it reaches `acp-client.ts`). Coordinate rebase order; whichever lands second re-verifies `agent-map.ts` seams. The two plans share only the trust/withheld vocabulary, not the enforcement mechanism.

---

## Grounded findings from the current code (audit @ 5916d4ea8 — corrections to the request's `52e72ade3` line refs)

These shape the tasks; the request's line numbers drifted with recent commits. Anchors below are current.

- **§F1 — No `pgEnum` anywhere.** Every enum is inline `text(col,{enum})`. `platform_mcp_servers` ships SQL `CHECK` constraints (migration `0036`); `capability_records.kind`/`.source` are bare `text` (TS-only enforcement). New enum-ish columns follow the inline-text + optional-CHECK style.
- **§F2 — `capability_records` has NO `params` and NO `enabled` boolean.** Config jsonb is **`material`**; enabled/disabled is **`disabledAt timestamp` (NULL = enabled)**. Column is **`capability_ref_id`**. Unique key `(project_id, source, kind, capability_ref_id)` (`schema.ts:577-639`). Project MCP material type `ProjectMcpMaterial` at `web/lib/mcp/project-mcp.ts:15-28`; package-attach material carries `origin:'package-attachment'` + `packageInstallId` (`attach.ts:355-383,462-494`).
- **§F3 — `platform_mcp_servers.trust_status` EXISTS** (`{untrusted,trusted,trusted_by_policy}`, default `untrusted`, `schema.ts:330-334`) but is **consulted NOWHERE** in projection/resolution/materialization (grep-clean across `resolver.ts`, `projection.ts`, `agent-map.ts`, `materialize*.ts`, `runs.ts`). Only read on the `/mcps` admin page (display, `mcps/page.tsx:35`) + seed. **This is the inert-trust gap W-E closes.**
- **§F4 — Projection** `loadPlatformMcpCapabilitiesFromDb` (`projection.ts:78-84`) filters **only `row.enabled`**, maps every enabled row to `source:'platform', enforceability:'enforced', selected_by_default:true`. It runs **once at project registration** (`app/api/projects/route.ts:408` → `installAndIngestCapabilityImports` → `catalog.ts:181-185` writes `capability_records`). Adding a platform MCP later does **not** re-project into existing projects. **No per-project opt-out exists.**
- **§F5 — `project-mcp-service.ts` `listProjectMcps`** (`:101-117`) surfaces `source='project'` AND `material->>'origin'='project-mcp'` ONLY. Platform/package MCP rows are invisible project-side. `enabled` DTO field = `disabled_at === null`.
- **§F6 — Resolver** `SOURCE_PRECEDENCE {project:0,platform:1,flow-package:2}` (`resolver.ts:30-38`); winner-per-refId `selectedRecords` (`:288-307`); snapshot `buildResolvedCapabilitySet` (`:44-86`). `resolveCapabilityProfile` is **pure**, takes `catalog: CapabilityCatalogRecord[]`. **Agent runs use the SAME resolver** via `resolveAgentProfileMcpServers` (`launch.ts:2514-2563`) — D5 is naturally satisfiable by threading bindings into the shared resolver.
- **§F7 — `resolved_capability_set.mcps[]`** = `{refId, sha, scope}` (`schema.ts:1283-1297`, `resolver.ts:78-84`). **NO `provenance` field** (grep-confirmed). W-B adds it.
- **§F8 — Launch preconditions** live in `web/lib/services/runs.ts` (NOT resolver): CONFIG unknown-ref (`:1059-1064`, `:1081-1086`), **EXECUTOR_UNAVAILABLE** agent-unsupported required MCP (`:1118-1123`, detector `firstAgentUnsupportedRequiredMcp` `resolver.ts:125-158`). `required` gates launch; `required ∪ additional` materialize identically (`runner-graph.ts:1649-1654`).
- **§F9 — Package manifest MCP schema** `packageManifestMcpSchema` (`config.schema.ts:1406-1459`): transport **`stdio|http` only** (no `sse`), `command` required-when-stdio, `url` required-when-http via `superRefine`, `env:[env:NAME]`, `.strict()`. `schemaVersion: z.literal(1)`. ADR-088 (`decisions.md:6455`, bullet `:6479-6484`): *"New content **kinds** arrive via `schemaVersion` bump"* — silent on per-entry optional fields → **D3 confirmed, no bump.** The term `recommendedPlatformServerId` does **not** exist in code; `mcp-template-editor.tsx` `materialize()` deliberately drops provenance ("the source server id is NOT written into the template").
- **§F10 — Materialization output.** `mapProfileToAgentArtifacts` (`agent-map.ts:136-209`) emits `AgentMcpServer {name,transport,command,args,envKeys,env,url,headerKeys}` (`:22-31`) — no gating. `gateStdioMcpsByExecTrust(mcpServers, execTrust)` (`:217-224`) filters stdio when untrusted. **`materialization_plan` lives on `node_attempts`** (`schema.ts:2334-2336`, type `:3034-3046`) — has `refusedClasses`, **NO `withheldMcps`**.
- **§F11 — Withheld stdio computed at TWO sites, both warn-log-only, ephemeral:** flow path `runner-graph.ts:1758-1779` (:1774 warn), agent path `launch.ts:2552-2560`. The plan is built (`runner-graph.ts:1738-1756`) BEFORE the gate runs → withheld never enters the plan. **The agent path (`return gated`) persists NO plan** — agent runs have no `node_attempts` MCP sink (verified). W-E must add a run-level sink for agent runs.
- **§F12 — Supervisor delivery** `acp-client.ts:714-746`: stdio `{name,command,args,env:[{name,value}]}` (`envKeys[k]→process.env[k]`), http/sse `{type,name,url,headers:[{name,value}]}` (`headerKeys[k]→process.env[k]`); literal `env` map wins over `envKeys` (M34 facade token). **Values resolved supervisor-side; web sends NAMES only.** Same array to `newSession` (`:820`) + `resumeSession` (`:773`).
- **§F13 — Probe feasibility:** **NO MCP client library in supervisor** (`package.json` has ACP SDK + fastify/pino/zod only; `@modelcontextprotocol/sdk` absent). The `connection.initialize` calls are ACP, not MCP. `/mcp-probe` needs a real MCP client — **add `@modelcontextprotocol/sdk`** (client + Stdio/SSE/StreamableHTTP transports) OR hand-roll raw JSON-RPC. **Near-drop-in template exists:** `supervisor/src/model-catalog/sources/acp-probe.ts` (spawn→initialize→`withTimeout`→`terminateProbeChild` SIGTERM/grace/SIGKILL in `finally` — textbook deferred-release). Fastify routes: `http-api.ts registerRoutes` (`:357`), plain `app.post`, error handler `:363-386` returns `{code,message}` (ZodError→409 PRECONDITION). **exec-trust does NOT reach the supervisor** (only `readOnlySession`/`autoApprovePermissions` booleans do) → D4 gate is web-side.
- **§F14 — UI:** board tab `McpPanel` (`mcp-panel.tsx`, columns id/transport/target/agents/enabled/actions, project-only). Metacell hardcoded `value="—"` at `projects/[slug]/page.tsx:384` (`listProjectMcps` already imported at :578). Node selector `MultiSelectField` (`node-side-form.tsx:855-866`, `{value,label}`, free-add, writes `settings.mcps:string[]`). Scratch selector `CapabilityGroup` (`scratch-launcher.tsx:1014-1019`, `{id,recordId,kind,label,source,...}`, record-id keyed, `defaultSelectedMcpIds`). `CapabilityComposer` is prompt-chip only (skill/subagent) — **out of scope for W-G** (W-G = node + scratch + agents-read-only). `/mcps` admin `McpServersPanel` already selects `trustStatus` but does not display it; `lib/mcp/usage.ts loadMcpUsageReferences` already yields the "used by N" count. Run-detail `CapabilityProfilePanel` renders `enforced/instructed/refusedClasses` chips, no MCP concept; sibling `ResolvedCapabilitySetPanel` reads `runs.resolvedCapabilitySet` and already has an `mcps` label.
- **§F15 — i18n:** `web/messages/{en,ru}.json`, namespaces `mcps` (admin), `mcpPanel` (board), `settings` (platform panel), `scratch`, `flowEditor.nodeForm`. **Key-for-key parity enforced** by `web/lib/__tests__/i18n-parity.test.ts`. The `studio` namespace already has `usedBy`/`trust`/`needsTrust`/`filterTrust*` — mirror these for the new MCP trust + used-by UI.

---

## Decisions (design — apply before coding)

### DEC-1 — `project_mcp_bindings` table (D1)
Columns: `id` (pk), `project_id` (FK `projects` ON DELETE CASCADE), `ref_id text` (the capability ref being bound, e.g. `github`), `target_kind text {platform,project,package}`, `target_id text` (→ `platform_mcp_servers.id` | `capability_records.id`), `enabled boolean NOT NULL DEFAULT true`, `config_overlay jsonb NOT NULL DEFAULT '{}'` (W-C), `recommended_hint text` (nullable, W-A studio hint mirror), `created_at`/`updated_at`, `created_by` (nullable user id, audit). **Unique `(project_id, ref_id)`** — one binding per ref per project. Inline-text enums + CHECK per §F1.
- **Semantics:** enabled binding → its target **wins over `SOURCE_PRECEDENCE`** for that `ref_id` (W-B). Disabled binding → ref is **unresolvable in this project** (explicit opt-out / disconnect) even if a platform row matches. **Absent binding → today's behavior unchanged** (grandfather, D2) — zero migration of existing setups.
- **Identifier labels (skill-context "body-controlled cross-resource ids"):** on every binding route, `project_id` = **server-state** (derived from URL `slug` → project lookup, never body); `ref_id` = **body-controlled** → validated against the derived requirements ledger + registered refs; `target_kind`+`target_id` = **body-controlled** → validated against **server-state** (target row MUST exist, MUST match `target_kind`, platform target MUST be `enabled`+trusted to be *bindable-as-executable*). No body field names a filesystem path.

### DEC-2 — Requirements ledger (derived, never stored redundantly)
A read model computed on hub load + at launch, aggregating refs from: (1) attached packages' manifest `mcps[]` **requirement-only** entries, (2) `normalizeNodeMcps(settings.mcps).required/additional` across **enabled** flow revisions, (3) `capability_profile.mcps` of **attached** agents. Each requirement classified: `bound` (enabled binding) · `auto` (refId match to a projected platform/project/package record, no binding) · `unbound` (no candidate) · `misconfigured` (overlay invalid / target missing) · `not_ready` (target readiness/probe NotReady or platform trust withheld). **SET/CLEAR/re-SET symmetry** (skill-context): removing the last declaring flow revision/package/agent DROPS the requirement; re-adding RESTORES it — both halves are mandatory tests.

### DEC-3 — Trust made load-bearing (W-E) — gate placement
Model platform-trust like exec-trust: a **materialization-time filter** keyed by the winning `source='platform'` record's live `platform_mcp_servers.trust_status`. `untrusted` → excluded from the executable set, recorded as **withheld** with reason `platform-untrusted`; **still VISIBLE** in the hub/requirements ledger (visible-but-not-executable). `trusted`/`trusted_by_policy` → materializes. Live-join (not snapshot-at-projection) so an admin trust flip takes effect on next launch; the exclusion decision is snapshotted into `resolved_capability_set` at launch per skill-context "persist the launch-time decision".
- **Fan-out (skill-context "trust becomes load-bearing"):** the trust consult is added at the resolution/materialization boundary (`agent-map.ts` caller in `runner-graph.ts` + `launch.ts`), the hub read model, the admin trust route, the `/mcps` display, and the run-detail panel. Enumerated in T3.x.
- **Grandfather backfill (skill-context "migrations preserve live data or refuse loudly"):** every **existing enabled** `platform_mcp_servers` row is materializing TODAY regardless of trust (default `untrusted`). Migration backfills `trust_status='trusted' WHERE enabled=true AND trust_status='untrusted'` so behavior is unchanged. Serena (`enabled=false`) is untouched → stays `untrusted`+disabled and its projection test now passes through the **real** trust gate (fulfills the ADR-128 precondition).

### DEC-4 — Per-project config overlay (W-C) — application point + invariant
`config_overlay = { envRemap?: Record<slotName, "env:OTHER_NAME">, argsOverride?: string[], urlOverride?: string, headerRemap?: Record<slotName,"env:OTHER_NAME"> }`. Validated against the **target's declared slots** (unknown slot → `CONFIG` 422). Applied **web-side in `mapProfileToAgentArtifacts`** (or a thin wrapper immediately after) by rewriting the `AgentMcpServer`'s `envKeys`/`args`/`url`/`headerKeys` **NAMES** — the **ACP wire shape is unchanged** (§F12), supervisor still resolves values from `process.env`. Applied overlay (names only) recorded in `materialization_plan` (flow) / run-level snapshot (agent). **Invariant:** no secret value in any DB row, HTTP response, `session/update`, or log — enforced by a **grep-sentinel test** seeding `env:PROJ_A_TOKEN` and asserting the literal token value never appears in DB/response/log fixtures.

### DEC-5 — Probe (W-F) — feasibility, trust placement, deferred-release
- **MCP client:** add `@modelcontextprotocol/sdk` to `supervisor/package.json` (client + Stdio/SSE/StreamableHTTP transports). Rationale: hand-rolling three-transport JSON-RPC `initialize` is more code + risk than a maintained dep. New dep → lockfile commit + container smoke (skill-context deployment rule).
- **Endpoint:** supervisor `POST /mcp-probe` (body: `{transport, command?, args?, envKeys?, url?, headerKeys?}` — NAMES only, Zod-validated) → real MCP `initialize` handshake → `{ok, latencyMs, serverInfo?, reason?}`. Structure copied from `acp-probe.ts`: `withTimeout` race + `terminateProbeChild` in `finally` (SIGTERM→grace→SIGKILL). **Deferred-release (skill-context):** the spawned child + timer are released on EVERY path (success, handshake error, timeout, spawn error); regression test asserts a simulated handshake failure kills the child (spy on kill).
- **Trust gate (D4):** enforced **web-side** in the probe route (`platform_mcp_servers.trust_status`/exec-trust for the target) — untrusted-source stdio → **refuse with a typed reason, NO override in v1** (owner lock). Supervisor `/mcp-probe` executes what it is told (already inside the trust boundary). Trust→execute, never execute-then-trust (skill-context).
- **Cache (owner-locked Q3 — no new table):** platform rows get `last_probe_status`/`last_probe_at`/`last_probe_reason` **columns** beside `readiness_*` (for the admin `/mcps` global probe, no overlay). Project/package MCP rows (`capability_records`) have no readiness columns → cache probe + readiness in **`material.lastProbe`/`material.readiness`** (additive jsonb, no new columns, **no new table**). Per-project caching is correct-by-design: W-C overlays make the effective config per-project, so the same platform MCP can be Ready in project A and NotReady in project B — the result belongs on the per-project row. Probe never persists secret values.

### DEC-6 — `resolved_capability_set.mcps[]` provenance + withheld sinks
- Extend the `mcps[]` entry (`schema.ts:1283-1297`) with `provenance: 'binding'|'precedence'` (+ optional `boundTarget:{kind,id}`). Optional → pre-migration runs read absent. Fan-out: `ResolvedCapabilitySetPanel` reader.
- Add `withheldMcps: {refId, transport, reason, scope}[]` to (a) `MaterializationPlan` (`schema.ts:3034-3046`) for **flow** runs (per node_attempt), populated at BOTH withhold sites after the gate; (b) **owner-locked Q2 — a `runs.withheld_mcps jsonb` (nullable) run-level column** as the sink for **both** flow and agent launches (agent runs persist no materialization_plan, §F11). The run-level column is the durable "no silent withhold anywhere" record read by the run-detail panel; the flow `materialization_plan.withheldMcps` adds per-node granularity.

### DEC-7 — Fan-out enumeration (skill-context "fan a new state-changing surface to ALL consumers; allow-list guards")
New binding `enabled/disabled` state + trust-load-bearing → consumers to touch, each with an **allow-list** (not deny-list) guard: resolver (binding-aware winner), requirements-ledger read model, hub read model, launch precondition (`runs.ts`), scratch launch-options, node materialization selection, `/mcps` admin display + trust route, run-detail panels. A disabled binding is admitted to "suppress" only by explicit set membership, never by "not-enabled ⇒ include".

### DEC-8 — Atomic writes
Binding create/update/overlay = single `db.transaction` (row + audit columns together). Trust flip = single update. Materialization_plan + resolved_capability_set snapshots keep their existing write-once transaction boundary (skill-context "multi-store atomic"). `.maister/` artifacts (none new here) unaffected.

---

## Deployment touchpoints (skill-context: mandatory when a task adds env/dep/port)
| Added | Lands in |
| --- | --- |
| `@modelcontextprotocol/sdk` supervisor dep (T5.1) | `supervisor/package.json` + `pnpm-lock.yaml` commit + container smoke that the module imports |
| `MAISTER_MCP_PROBE_TIMEOUT_MS` (default 8000) + `MAISTER_MCP_PROBE_TEARDOWN_GRACE_MS` (default 2000) (T5.2/T5.3) | `.env.example` (MAISTER_* block) + supervisor `environment:` in `compose.yml` (+ `compose.production.yml` if prod-relevant) + env-vars table in `docs/configuration.md` |
| Supervisor `POST /mcp-probe` route (T5.2) | no new bound port (rides existing supervisor HTTP); `docs/api/supervisor.openapi.yaml` |

No new sidecar binary, no new bound port.

## Contract surfaces → spec file (skill-context: trace every changed contract surface)
| Surface | Spec file |
| --- | --- |
| `POST /api/projects/{slug}/mcp/bindings`, `PATCH/DELETE .../bindings/{refId}` (bind/rebind/disconnect) | `docs/api/web.openapi.yaml` (`mcp-management` tag) + `docs/system-analytics/mcp-management.md` |
| `POST /api/projects/{slug}/mcp/connect` / `disconnect` (platform pickup/opt-out) | same |
| `POST /api/projects/{slug}/mcp/probe` (web→supervisor proxy, trust-gated) | same |
| `POST /api/admin/mcp-servers/{id}/trust` + PATCH body gains `trustStatus` | same + `docs/screens/mcps.md` |
| Supervisor `POST /mcp-probe` | `docs/api/supervisor.openapi.yaml` + `docs/supervisor.md` |
| `resolved_capability_set.mcps[].provenance`, `withheldMcps[]` (wire field semantics) | `docs/system-analytics/mcp-management.md` + `docs/db/runs-domain.md` example payloads |
| `platform_mcp_servers.last_probe_*` + `project_mcp_bindings` table + `capability_records.material.lastProbe/readiness` | Drizzle migration + `docs/database-schema.md` + `docs/db/capabilities-domain.md` ERD + `docs/db/projects-domain.md` |
| Package manifest `mcps[]` requirement-only + `recommendedPlatformServerId` | `docs/configuration.md` (package manifest) + `web/lib/config.schema.ts` (the schema IS a contract SSOT) |
| New env vars | `docs/configuration.md` env table + `.env.example` |
No new `MaisterError` code (reuse `CONFIG`/`EXECUTOR_UNAVAILABLE`/`CONFLICT`/`PRECONDITION`). No new SSE/AsyncAPI event.

---

## Commit Plan
- **Commit 1** (Phase 0): `docs(mcp): SDD + analytics + ADR-129 stub for MCP management v2` (docs-only gate)
- **Commit 2** (Phase 1): `feat(mcp): project_mcp_bindings + probe/provenance/withheld schema + migration 0093`
- **Commit 3** (Phase 2): `feat(mcp): requirements ledger + binding-aware resolution + package requirement-only`
- **Commit 4** (Phase 3): `feat(mcp): trust made load-bearing + withheld-visibility (no silent downgrade)`
- **Commit 5** (Phase 4): `feat(mcp): per-project env-slot overlay (names-only, wire unchanged)`
- **Commit 6** (Phase 5): `feat(supervisor): POST /mcp-probe real MCP initialize handshake + web test-connection`
- **Commit 7** (Phase 6): `feat(mcp): project MCP hub (all 3 sources, match/connect/overlay) + admin trust + metacell count`
- **Commit 8** (Phase 7): `feat(mcp): unified MCP-select (node+scratch) + agent effective-MCPs list`
- **Commit 9** (Phase 8): `chore(mcp): EN/RU parity + docs reconcile + ADR/migration renumber + verification`

---

## Tasks

Logging convention (verbose): every service/route/resolver/probe fn logs entry with context, decision branches (binding-win vs precedence, trust withhold, overlay-applied, probe-refused), external boundaries (supervisor RPC, child spawn/kill), and errors with full context. Format `[Area.method] message {data}`. Levels DEBUG (flow) / INFO (bind, trust flip, probe result, withhold) / WARN / ERROR. Env-driven `LOG_LEVEL`. **Never log a secret value** — only `env:NAME` names.

### Phase 0 — SDD + analytics (docs-first GATE; must be COMPLETE & internally consistent before any code)
- [x] **T0.1 — Write the SDD.** New `.ai-factory/specs/feature-mcp-management-v2.md`: entities (`project_mcp_bindings`, requirements ledger, overlay, probe, trust), state machines (binding lifecycle: unbound→bound→disconnected; trust: untrusted→trusted; probe: unprobed→ok/failed), the binding-vs-precedence resolution rule, per-route identifier-label table (DEC-1), the withheld/provenance snapshot shapes, normative Expectations (≤12) with SET/CLEAR/re-SET, edge-case→`MaisterError` table. Status-tag every piece (Implemented/Designed). Log: n/a (doc).
- [x] **T0.2 — Rewrite `docs/system-analytics/mcp-management.md`.** Replace the M27-only model with the bindings/requirements/overlay/probe/trust model (R5 structure: Purpose, Entities, State machines, Process flows, Expectations, Edge cases, Linked artifacts). Add mermaid: binding resolution flow (binding wins over precedence), trust-gate + withheld-visibility sequence, probe handshake sequence. Fix line-149 plan-shape mismatch. Depends on T0.1.
- [x] **T0.3 — Fix audited doc drift.** `capabilities.md:284-295` precedence "(Designed, M27)" → "(Implemented)". `flow-settings.md`: correct the stale `TODO(M14)` MCP note (MCP IS materialized per session now) and the adapter-count staleness — **docs-only, do NOT flip `ENFORCEABILITY_BY_AGENT` cells** (owned by enforcement-flip plan; overlap-watch). Update `docs/screens/mcps.md` (trust action + used-by column) and add a **project-hub** screen doc (`docs/screens/projects/project-mcps-hub.md`) per the screens template + glossary row. Note the undocumented inert `trust_status` is now documented as load-bearing.
- [x] **T0.4 — ADR-129 stub + full ADR.** Append `### ADR-129: MCP management v2 — requirements & bindings, per-project overlay, trust & health activation` to `docs/decisions.md` (amends ADR-070 platform CRUD + ADR-043 materialization visibility; extends ADR-088 manifest; fulfills ADR-128 Serena trust-gate precondition). Record accepted D1–D5 + hub placement + the grandfather backfill + accepted residual crash windows. Update the ADR index table row.
- [x] **T0.5 — Author the contract specs (Designed-tagged).** Add OpenAPI paths to `docs/api/web.openapi.yaml` (bindings, connect/disconnect, project probe, admin trust + PATCH `trustStatus`) and `docs/api/supervisor.openapi.yaml` (`POST /mcp-probe`) with example payloads (NAMES only). Update `docs/db/capabilities-domain.md` + `docs/db/projects-domain.md` ERDs (`erDiagram`) and `docs/database-schema.md` narrative for the new table + columns + material fields. **Gate:** `pnpm validate:docs:all` green; specs internally consistent with T0.1; no section describes code that won't exist at each phase HEAD.

### Phase 1 — Schema + migration (foundation) — depends on Phase 0
- [x] **T1.1 — Drizzle schema.** In `web/lib/db/schema.ts`: add `projectMcpBindings` table (DEC-1), add `lastProbeStatus`/`lastProbeAt`/`lastProbeReason` to `platformMcpServers`, extend `ResolvedCapabilitySet` type (`mcps[].provenance`+`boundTarget`, new `withheldMcps[]` arm) and `MaterializationPlan` type (`withheldMcps[]`). Export inferred types. Log: n/a (types).
- [x] **T1.2 — Migration 0093 (triple).** Generate/author `web/lib/db/migrations/0093_mcp_management_v2.sql` (CREATE TABLE `project_mcp_bindings` with idempotent `DO $$ … EXCEPTION WHEN duplicate_object` FK block + `CREATE TABLE IF NOT EXISTS` + unique + CHECK; ALTER `platform_mcp_servers` ADD probe columns) + `_journal.json` entry + `meta/0093_snapshot.json`. **Grandfather trust backfill in the same migration:** `UPDATE platform_mcp_servers SET trust_status='trusted' WHERE enabled=true AND trust_status='untrusted'` (loud, explicit, preserves live behavior; Serena untouched). Verify newest journal entry ⇄ matching snapshot. Log: migration runner already logs.
- [x] **T1.3 — Run-level withheld sink (owner-locked Q2).** Add `runs.withheld_mcps jsonb` (nullable) in migration 0093 + schema as the run-level withheld sink for **both** flow and agent launches (§F11/DEC-6). Test: an agent run's withheld set has a durable home and surfaces in run detail.
- [x] **T1.4 — Migration integration test.** Real-Postgres: apply 0093, assert table shape + backfill result (pre-seeded enabled+untrusted row → trusted; Serena stays untrusted), then round-trip an insert/read of a binding row. Runner: `web/lib/db/__tests__/*.integration.test.ts` (confirm glob matches — extend if new path).

### Phase 2 — Requirements & bindings model (W-A) + binding-aware resolution (W-B) — depends on Phase 1
- [ ] **T2.1 — Binding service + routes.** New `web/lib/mcp/binding-service.ts` (CRUD in one transaction, DEC-8) + routes `POST /api/projects/[slug]/mcp/bindings`, `PATCH/DELETE .../bindings/[refId]`, `POST .../connect`, `POST .../disconnect`. Enforce DEC-1 identifier labels: derive `project` from slug (server-state); validate `target_kind`/`target_id` against server-state (exists+kind-match; platform target enabled+trusted to bind-as-executable → else `CONFLICT`/`CONFIG`); unknown ref → `CONFIG` 422. Overlay validated here against target slots (DEC-4, unknown slot → `CONFIG` 422). Log: bind/rebind/connect/disconnect decisions + validation failures.
- [ ] **T2.2 — Requirements ledger read model.** New `web/lib/mcp/requirements-ledger.ts` aggregating manifest + node-settings + agent-profile refs (DEC-2), classifying each. Pure + unit-tested for SET/CLEAR/re-SET symmetry. Log: derived requirement count + classification per ref (DEBUG).
- [ ] **T2.3 — Binding-aware resolver.** Thread `bindings` into `resolveCapabilityProfile` args + `buildResolvedCapabilitySet` + `firstAgentUnsupportedRequiredMcp` (all in `web/lib/capabilities/resolver.ts`): enabled binding target wins over `SOURCE_PRECEDENCE` for its ref; disabled binding makes the ref unresolvable (allow-list guard, DEC-7); absent binding = unchanged. Record `provenance:'binding'|'precedence'` (+ `boundTarget`) in the snapshot (§F7). Load bindings at the catalog-assembly layer feeding the resolver (keep the resolver pure). Log: per-ref winner {ref, source, provenance}.
- [ ] **T2.4 — Launch precondition messages.** In `web/lib/services/runs.ts`, keep CONFIG/EXECUTOR_UNAVAILABLE **shapes** but reword to name remediation ("bind or configure in Project → MCPs"); a disabled binding on a required ref → CONFIG naming the disconnect. Fan-out to the agent launch path (`launch.ts`) so agent required refs honor bindings (D5). Log: refusal reason + remediation.
- [ ] **T2.5 — Package manifest requirement-only + hint (D3).** In `config.schema.ts` `packageManifestMcpSchema`: relax `superRefine` so an entry with **neither** `command` nor `url` is a valid **requirement** (id + `env` slot names + description); an entry WITH an implementation stays a template. Add optional `recommendedPlatformServerId` (`capabilityRefIdSchema`). No `schemaVersion` bump. In `web/lib/packages/attach.ts` classify requirement vs template on ingest (requirement → a `capability_records` requirement marker in `material`, NOT an executable template). Persist `recommendedPlatformServerId` from `mcp-template-editor.tsx` (add the field, drop the "not persisted" comment). Log: per-mcp ingest classification.
- [ ] **T2.6 — Unit + integration tests.** Unit: binding-wins-over-precedence, disabled-binding-suppresses, overlay validation (unknown slot→CONFIG), requirement classification, SET/CLEAR/re-SET. Real-PG integration: bind→launch→`resolved_capability_set` records `provenance:'binding'`; disconnect→required-ref launch refusal names the disconnect; grandfather (no binding) → zero behavior change. Runner: `web/lib/capabilities/__tests__` + `web/lib/mcp/__tests__` + `app/api/.../*.integration.test.ts` (confirm globs; extend config if a new path family).

### Phase 3 — Trust activation + delivery visibility (W-E) — depends on Phase 1 (usable after Phase 2)
- [ ] **T3.1 — Trust gate in projection/materialization.** Add the live trust consult (DEC-3): `source='platform'` winner with `trust_status='untrusted'` → excluded from executable set + recorded withheld reason `platform-untrusted`, still visible in ledger/hub. Add at the resolution/materialization boundary consumed by BOTH `runner-graph.ts` and `launch.ts` (allow-list guard). Log: trust decision per platform ref.
- [ ] **T3.2 — Admin trust action.** Route `POST /api/admin/mcp-servers/[id]/trust` (body `{trustStatus}` allow-list `{untrusted,trusted,trusted_by_policy}`; id from URL = server-state). Add `trustStatus` to the PATCH body schema (`[id]/route.ts:36-50`). Recompute readiness on trust change if relevant. Log: trust transition {id, from, to, actor}.
- [ ] **T3.3 — Withheld recorded (both sites) + provenance in snapshot.** Populate `withheldMcps[]` after the gate at `runner-graph.ts:1758-1779` (into `materialization_plan`) AND `launch.ts:2552-2560` (into the run-level sink, DEC-6). Remove the "silent warn-only" as the sole record (keep the warn log, add the durable record). Log: withheld list persisted.
- [ ] **T3.4 — Run-detail visibility.** Extend `CapabilityProfilePanel` (or add a small MCP sub-panel) to render `withheldMcps` (refId, transport, reason) + provenance from `ResolvedCapabilitySetPanel`. EN/RU labels. Log: n/a (view).
- [ ] **T3.5 — Trust tests.** Untrusted platform MCP → visible in catalog, never materialized (integration); trusting via the new route → materializable; **Serena projection test now passes through the real trust gate** (update `web/lib/mcp/__tests__/platform-mcp-projection.integration.test.ts`); withheld appears in `materialization_plan` + panel (no silent path). Assertion-migration: enumerate the projection test's stale assertions.

### Phase 4 — Per-project config overlay (W-C) — depends on Phase 2
- [ ] **T4.1 — Overlay application.** Apply `config_overlay` (DEC-4) in `web/lib/capabilities/agent-map.ts` (or a wrapper immediately after `mapProfileToAgentArtifacts`) — rewrite `envKeys`/`args`/`url`/`headerKeys` NAMES per binding; **ACP wire shape unchanged**. Record applied overlay (names only) in `materialization_plan`/run-level snapshot. Coordinate with enforcement-flip overlap-watch. Log: overlay applied {ref, remappedSlots} (names only).
- [ ] **T4.2 — Overlay validation.** Validate overlay against target declared slots at write (T2.1) AND re-validate at materialization (defensive); unknown slot → `CONFIG` 422. Unit-test both.
- [ ] **T4.3 — Secret-invariant grep-sentinel test.** Real-PG integration: project A remaps `API_TOKEN→env:PROJ_A_TOKEN`, project B →`env:PROJ_B_TOKEN`; assert each session's ACP `newSession` receives its own **name**; seed a fake secret value and assert it appears in **no** DB row, HTTP response, or log fixture. This is the untouchable-invariant guard.

### Phase 5 — Supervisor health probe (W-F) + deployment wiring — mostly independent (integrates in Phase 6)
- [ ] **T5.1 — Add MCP client dep.** Add `@modelcontextprotocol/sdk` to `supervisor/package.json`; commit `pnpm-lock.yaml`; container smoke that it imports. Log: n/a.
- [ ] **T5.2 — Supervisor `POST /mcp-probe`.** In `supervisor/src/http-api.ts` (`registerRoutes`), add the route: Zod body (NAMES only), real MCP `initialize` per transport using the SDK, structured `{ok,latencyMs,serverInfo?,reason?}`. Reuse `acp-probe.ts` structure — `withTimeout(MAISTER_MCP_PROBE_TIMEOUT_MS)` + `terminateProbeChild` (SIGTERM→`MAISTER_MCP_PROBE_TEARDOWN_GRACE_MS`→SIGKILL) in `finally`; stdio env resolved supervisor-side from `process.env` by NAME. Error shape via the existing handler. **Deferred-release:** child+timer released on all paths. Log: probe start/result/teardown per target (no secret values).
- [ ] **T5.3 — Deployment wiring.** `.env.example` (MAISTER_* block) + supervisor `environment:` in `compose.yml` (+ prod overlay) + `docs/configuration.md` env table for the two probe env vars. Collision-check the env names.
- [ ] **T5.4 — Web probe proxy + trust gate.** Route `POST /api/projects/[slug]/mcp/probe` (and an admin variant for `/mcps`) resolving the target's material NAMES, enforcing the **web-side D4 trust gate** (untrusted-source stdio → refuse with a typed reason, **no override in v1**), calling supervisor `/mcp-probe`, caching `last_probe_*` (platform columns) / `material.lastProbe` (project/package) — never secrets. Extend `evaluateMcpReadiness` display to project/package records (same evaluator over their material + diagnostics envRefs). Log: probe request, trust-gate decision, cache write.
- [ ] **T5.5 — Probe tests.** Supervisor unit: initialize handshake happy-path (mock stdio server) + timeout kills child (deferred-release spy) + all three transports shaped correctly. Web unit: trust-gate refuses untrusted-source stdio (no override path exists in v1); no secret persisted. Runner: `supervisor/src/__tests__` + web route tests (confirm globs).

### Phase 6 — Project MCP hub (W-D) — depends on Phases 2/3/4/5
- [ ] **T6.1 — Hub read model.** New `web/lib/mcp/hub-service.ts` merging all three sources into one list with status columns (source, transport, readiness, trust, bound-to, used-by count) + the requirements ledger (unbound/misconfigured/not_ready). Reuse `lib/mcp/usage.ts` for used-by. Log: hub assembly counts.
- [ ] **T6.2 — Rebuild the board `?tab=mcps` (`McpPanel`).** All three sources + status columns; a **match dialog** (platform+project candidates, `recommendedPlatformServerId` pre-selected) to bind/rebind a requirement; connect/disconnect platform servers; keep existing project-local CRUD; a package-MCP overlay-config form (W-C). **Launch-precondition carried into the picker** (skill-context): the match dialog only offers bindable (existing, kind-matching, trusted-or-warned) candidates. Not a separate page (owner lock). Log: n/a (view) — actions log via their routes.
- [ ] **T6.3 — Board-header metacell real count.** Replace `projects/[slug]/page.tsx:384` `value="—"` with the project-effective MCP count from the hub read model (a `sub` listing sources like the neighbors). Log: n/a.
- [ ] **T6.4 — `/mcps` admin: trust action + used-by column.** Add the trust-action control (calls T3.2) + "used by N projects" column (from `lib/mcp/usage.ts`) to `McpServersPanel`; mirror `studio` namespace i18n (`trust`/`usedBy`/`needsTrust`). Log: n/a (view).
- [ ] **T6.5 — Hub e2e (mock ACP adapter).** Match a package requirement-only `github` to the platform `github` server → one-click bind → previously CONFIG-refused launch now succeeds and `resolved_capability_set` records `provenance:'binding'`; withhold-visibility renders; "Test connection" button drives the probe. Seeded e2e per project conventions.

### Phase 7 — Selection UX unification (W-G) — depends on Phase 6 component
- [ ] **T7.1 — Shared `McpSelect` component.** One component grouped by source with readiness/trust badges + binding-aware labels; reconcile the authoring `{value,label}` (node) vs runtime record-id (`{id,recordId,...}`) models behind one prop contract. Replace `node-side-form.tsx:855-866` (`MultiSelectField`) and `scratch-launcher.tsx:1014-1019` (`CapabilityGroup`) usages. Preserve node free-add semantics (forward-ref to not-yet-authored) and scratch defaults. Log: n/a (view). **Do NOT touch `CapabilityComposer`** (out of scope, §F14).
- [ ] **T7.2 — Agent effective-MCPs list.** In the agents attach panel (`agents-attach-panel.tsx` / edit modal), add a **read-only** "effective MCPs" list resolved from the agent's `capability_profile.mcps` through the project's bindings (reuse the resolver, D5). Log: n/a (view).
- [ ] **T7.3 — Selector tests.** renderToStaticMarkup snapshot per source-group + badge; node free-add preserved; scratch defaults preserved; agent effective list resolves through bindings. Runner: `web/components/**/__tests__` (confirm glob).

### Phase 8 — i18n parity + docs reconcile + numbering renumber + verification
- [ ] **T8.1 — EN+RU i18n parity.** Add every new key to BOTH `web/messages/en.json` and `web/messages/ru.json` (namespaces `mcpPanel` extended, new `mcpHub`, `mcps` admin trust/used-by, run-detail withheld labels). `web/lib/__tests__/i18n-parity.test.ts` MUST pass. Log: n/a.
- [ ] **T8.2 — Docs reconcile (as-built deltas only).** Reconcile the Phase-0 specs with any implementation deltas (Phase 0 was leading SOT; this only patches drift). Flip Designed→Implemented tags on shipped pieces. Update OpenAPI examples to final shapes.
- [ ] **T8.3 — Full green + contract cross-check.** `pnpm --filter maister-web lint` (use `eslint .` check-only to avoid whole-repo reformat), typecheck, `pnpm test:unit && pnpm test:integration`, supervisor tests, e2e, `pnpm validate:docs:all`. Every phase's suite stays green; no quarantined red without a tracked reason.
- [ ] **T8.4 — ADR + migration renumber pass (own focused step, AFTER rebase onto main).** Re-grep `git show main:docs/decisions.md` + `_journal.json` for the true next-free; reassign ADR-129→actual, migration 0093→actual (rename SQL + `_journal.json` tag + snapshot + every prose citation `pre-ADR-129`/`since 0093`); run `scripts/validate-docs-adr-anchors.mjs`; re-verify newest-journal ⇄ snapshot integrity. Prefer number-agnostic phrasing in long-lived comments.

---

## Test integrity (skill-context: runnability + per-phase green + assertion migration)
- Each promised test names its runner project; when a test lands in a new path family, extend the runner `include` glob in the same phase (T1.4, T2.6, T5.5, T7.3 call this out).
- Every phase exit = full suite green (`pnpm test:unit && pnpm test:integration` + supervisor + e2e). Pre-existing red is quarantined with a reason + tracked follow-up, never silently tolerated.
- Assertion migration is in-scope where behavior changes: the Serena projection test (T3.5), any resolver-precedence test that now sees provenance, launch-refusal message tests (T2.4). Enumerate each by path in-phase; `/aif-verify` re-derives from the diff.
- Real-Postgres integration is mandatory for: bind→launch→snapshot provenance, disconnect→refusal, overlay env-remap reaches supervisor as names, grandfather zero-change, trust withhold. (vitest workers don't load `.env.local` → ensure `DB_URL` is set for pg-gated paths.)

---

## Resolved decisions (владелец, 2026-07-11 — все локи закрыты)
1. **Probe MCP-клиент:** ✅ тянем `@modelcontextprotocol/sdk` в supervisor (T5.1). (F13)
2. **agent-run withheld sink:** ✅ добавляем `runs.withheld_mcps jsonb` — run-level sink для flow И agent (DEC-6/T1.3).
3. **project/package readiness+probe cache:** ✅ `capability_records.material` jsonb, **без новой таблицы** (DEC-5). Пер-проектный кэш корректен: W-C overlay делает эффективный конфиг пер-проектным.
4. **ADR/migration номер:** ✅ 129/0093 номинально → финал 130+/0094+ на renumber-проходе T8.4.
5. **flow-settings.md drift:** ✅ только проза (MCP материализуется + число адаптеров), **без флипа `ENFORCEABILITY_BY_AGENT`** — граница с enforcement-flip planом сохранена (T0.3).
6. **connect семантика:** ✅ platform MCP, добавленный после регистрации проекта, подключается через enabled-binding `target=platform`, НЕ до-проекцией в `capability_records` (DEC-1/W-D).
