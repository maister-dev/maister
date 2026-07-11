# Spec — MCP Management v2: requirements & bindings, per-project overlay, trust & health activation

Status: approved (owner lock 2026-07-11) — **Implemented** at the backend + read-model + admin/board-surface layers (bindings/resolver/trust/overlay/probe/hub, migration 0093); **follow-up (Designed, routes-ready):** board match/connect/overlay dialogs, shared node/scratch MCP-select (W-G), seeded hub e2e.
Owner surface: `web/` (Next.js routes + services + Drizzle) + `supervisor/` (probe route).
Scope axis: **all three MCP scopes** — package (requirement/template), platform (catalog), project (bindings).
Decision record: ADR-129 (nominal; renumber at merge). Amends ADR-070 (platform MCP CRUD) + ADR-043 (M14 materialization visibility); extends ADR-088 (package manifest); fulfills ADR-128 (Serena trust-gate precondition).
Analytics doc: [`docs/system-analytics/mcp-management.md`](../../docs/system-analytics/mcp-management.md) (canonical process/state view; this spec is the acceptance SSOT).

---

## 1. Goal

Make MCP servers first-class **manageable** at all three scopes through an **explicit requirements & bindings layer**, replacing the implicit `refId`-equality resolution model:

- **Packages** declare a **requirement** (a ref an installed flow/agent needs) OR ship a **template** (an executable MCP implementation).
- **Platform** catalogs a server once (`platform_mcp_servers`) and it is picked up everywhere (grandfather projection).
- **Projects** connect platform MCPs, **match** platform/project candidates to package requirements, connect+configure package-shipped MCPs, and **override** per-project config (env-slot names) — all from the existing board `?tab=mcps` hub.

Two dormant signals become load-bearing: `platform_mcp_servers.trust_status` (untrusted → visible-but-not-executable) and a real supervisor **health probe** (`initialize` handshake). The `env:NAME`-only secret invariant is untouchable.

## 2. Non-goals (out of scope — do not build)

- MCP marketplace / reputation / malware-scan / sandbox / org-policy.
- Storing any secret **value** web-side (invariant untouchable — only `env:NAME` names persist).
- MCP version pinning / auto-update.
- Changes to the maister **external MCP facade** (`mcp/`) — a different domain.
- Per-node **enforcement semantics** (owned by the enforcement-flip plan; `capability_guard` consumes whatever set materialization delivers — this spec shares only the trust/withheld vocabulary, not the enforcement mechanism).
- OAuth flows for remote MCPs.
- A separate project MCP page — the hub **is** the board `?tab=mcps` tab (owner lock).

## 3. Grounding facts (current code @ base `5916d4ea8`)

These are load-bearing constraints for the design; verified by audit, do not re-derive.

- **G1** — No `pgEnum` anywhere; enums are inline `text(col,{enum})` with optional SQL `CHECK`.
- **G2** — `capability_records` has **no** `params`/`enabled`. Config jsonb is **`material`**; enabled = **`disabled_at IS NULL`**; ref column is **`capability_ref_id`**; unique key `(project_id, source, kind, capability_ref_id)`.
- **G3** — `platform_mcp_servers.trust_status ∈ {untrusted,trusted,trusted_by_policy}` (default `untrusted`) is consulted **nowhere** in projection/resolution/materialization today.
- **G4** — Projection `loadPlatformMcpCapabilitiesFromDb` filters **only `enabled`**, runs **once at project registration**; a later platform MCP is **not** re-projected; no per-project opt-out exists.
- **G5** — Resolver `SOURCE_PRECEDENCE = {project:0, platform:1, flow-package:2}`; `resolveCapabilityProfile` is pure over `catalog: CapabilityCatalogRecord[]`; **agent runs use the same resolver** → D5 is naturally satisfiable.
- **G6** — `resolved_capability_set.mcps[]` = `{refId, sha, scope}` — **no provenance**. `materialization_plan` lives on **`node_attempts`** (has `refusedClasses`, no `withheldMcps`). **Agent runs persist no `materialization_plan`** → need a run-level withheld sink.
- **G7** — Launch preconditions live in `web/lib/services/runs.ts` (CONFIG unknown-ref, EXECUTOR_UNAVAILABLE agent-unsupported required MCP), not in the resolver. `required` gates launch; `required ∪ additional` materialize identically.
- **G8** — Package manifest `packageManifestMcpSchema` transport is `stdio|http` only; `superRefine` requires `command`-when-stdio / `url`-when-http. `recommendedPlatformServerId` does not exist yet. ADR-088 bumps `schemaVersion` only for a new content **kind**, not a new optional field → no bump.
- **G9** — Materialization: `mapProfileToAgentArtifacts` → `AgentMcpServer {name,transport,command,args,envKeys,env,url,headerKeys}`; `gateStdioMcpsByExecTrust` filters stdio when exec-untrusted. Withheld stdio is computed at **two** sites, both warn-log-only, ephemeral (`runner-graph.ts` flow + `launch.ts` agent).
- **G10** — Supervisor `acp-client.ts` sends stdio `{name,command,args,env:[{name,value}]}` and http/sse `{type,name,url,headers}` — **values resolved supervisor-side from `process.env` by NAME**; web sends names only. **exec-trust does not reach the supervisor** (only `readOnlySession`/`autoApprovePermissions` booleans do) → trust gates are **web-side**.
- **G11** — **No MCP client library in supervisor** (`@modelcontextprotocol/sdk` absent); `acp-probe.ts` is the near-drop-in spawn→initialize→`withTimeout`→`terminateProbeChild` template for the new probe.
- **G12** — i18n parity is hard-enforced (`i18n-parity.test.ts`); the `studio` namespace already has `usedBy`/`trust`/`needsTrust`/`filterTrust*` to mirror.

## 4. Entities & data model

### 4.1 `project_mcp_bindings` (new table — DEC-1) — Designed

The explicit binding of a **ref** to a concrete MCP **target** within one project.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text pk | server-generated id (project id-gen convention) |
| `project_id` | text FK `projects(id)` **ON DELETE CASCADE** | server-state (from URL slug) |
| `ref_id` | text NOT NULL | the capability ref bound, e.g. `github` |
| `target_kind` | text NOT NULL `∈ {platform, project, package}` | inline-text enum + CHECK |
| `target_id` | text NOT NULL | → `platform_mcp_servers.id` (platform) \| `capability_records.id` (project/package) |
| `enabled` | boolean NOT NULL DEFAULT `true` | disabled = explicit opt-out / disconnect |
| `config_overlay` | jsonb NOT NULL DEFAULT `'{}'` | overlay shape §4.3 (W-C) |
| `recommended_hint` | text NULL | studio hint mirror (W-A) |
| `created_by` | text NULL | audit (user id) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

- **Unique `(project_id, ref_id)`** — exactly one binding per ref per project.
- **Semantics:** enabled binding → its target **wins over `SOURCE_PRECEDENCE`** for that `ref_id`; disabled binding → ref is **unresolvable in this project** (opt-out) even if a platform row matches; **absent binding → today's behavior unchanged** (grandfather, D2) — zero migration of existing setups.

### 4.2 Requirements ledger (derived read model — DEC-2) — Designed

Computed on hub load + at launch, never stored redundantly. Aggregates refs from:
1. attached packages' manifest `mcps[]` **requirement-only** entries,
2. `normalizeNodeMcps(settings.mcps).required/additional` across **enabled** flow revisions,
3. `capability_profile.mcps` of **attached** agents.

Each requirement is classified:

| Classification | Meaning |
| --- | --- |
| `bound` | an enabled binding exists for the ref |
| `auto` | refId matches a projected platform/project/package record, no binding (grandfather) |
| `unbound` | no candidate at any scope |
| `misconfigured` | binding target missing, or overlay invalid against target slots |
| `not_ready` | target readiness/probe NotReady, or winning platform record trust withheld |

**SET/CLEAR/re-SET symmetry (mandatory):** removing the last declaring flow-revision/package/agent **drops** the requirement; re-adding **restores** it. Both halves are tested.

### 4.3 `config_overlay` (per-project — DEC-4) — Designed

```jsonc
{
  "envRemap":    { "<slotName>": "env:OTHER_NAME" },   // rewrites an env-slot NAME
  "argsOverride": ["--flag", "value"],                  // replaces stdio args (non-secret)
  "urlOverride":  "https://project-a.example/mcp",      // replaces http/sse url (non-secret)
  "headerRemap": { "<slotName>": "env:OTHER_NAME" }     // rewrites a header-slot NAME
}
```

- Validated against the **target's declared slots** (unknown slot → `CONFIG` 422) at write **and** re-validated at materialization (defensive).
- Applied **web-side** in/after `mapProfileToAgentArtifacts` by rewriting the `AgentMcpServer`'s `envKeys`/`args`/`url`/`headerKeys` **NAMES** — the **ACP wire shape is unchanged** (G10); supervisor still resolves values from `process.env`.
- **Invariant:** no secret **value** ever appears in a DB row, HTTP response, `session/update`, or log — only `env:NAME` names.

### 4.4 Trust (activation — DEC-3) — Designed

`platform_mcp_servers.trust_status` becomes load-bearing at the resolution/materialization boundary:
- `untrusted` → **excluded from the executable set**, recorded **withheld** with reason `platform-untrusted`, **still VISIBLE** in hub/requirements ledger (visible-but-not-executable).
- `trusted` / `trusted_by_policy` → materializes.
- **Live-join** (not snapshot-at-projection) so an admin trust flip takes effect on next launch; the exclusion decision is snapshotted into `resolved_capability_set` at launch.
- **Grandfather backfill:** migration sets `trust_status='trusted' WHERE enabled=true AND trust_status='untrusted'` so existing setups are unchanged. Serena (`enabled=false`) stays `untrusted` and now flows through the real gate.

### 4.5 Probe (health — DEC-5) — Designed

- Supervisor `POST /mcp-probe` performs a real MCP `initialize` handshake per transport via `@modelcontextprotocol/sdk` (new supervisor dep); body carries **NAMES only**; returns `{ok, latencyMs, serverInfo?, reason?}`.
- **Deferred-release:** the spawned child + timer are released on every path (success, handshake error, timeout, spawn error) — SIGTERM→grace→SIGKILL in `finally`.
- **Trust gate (D4):** enforced **web-side** in the probe proxy route. Probing an untrusted-source stdio MCP is **refused with a typed reason — NO admin override in v1** (owner lock).
- **Cache (no new table):** platform rows gain `last_probe_status`/`last_probe_at`/`last_probe_reason` columns; project/package rows cache under `material.lastProbe` / `material.readiness` jsonb. Per-project caching is correct-by-design (overlays make the effective config per-project). Probe never persists a secret value.

### 4.6 Provenance + withheld sinks (DEC-6) — Designed

- `resolved_capability_set.mcps[]` gains `provenance: 'binding' | 'precedence'` (+ optional `boundTarget: {kind,id}`). Optional → pre-migration runs read absent.
- `withheldMcps: {refId, transport, reason, scope}[]` added to (a) `MaterializationPlan` on `node_attempts` (flow, per-node) and (b) **`runs.withheld_mcps` jsonb** (nullable run-level column) as the durable sink for **both** flow and agent launches (agent runs persist no `materialization_plan`, G6).

## 5. State machines

### 5.1 Binding lifecycle

```
unbound ──POST bind──▶ bound(enabled) ──DELETE/disconnect──▶ disconnected(disabled)
   ▲                        │  ▲                                     │
   │                        │  └────────── POST connect/re-bind ─────┘
   └──── requirement dropped (SET/CLEAR) ──┘
```

- `bound(enabled)` → target wins over precedence.
- `disconnected(disabled)` → ref explicitly unresolvable (opt-out), even if a platform row matches.
- Absent row → grandfather (today's behavior).

### 5.2 Trust

`untrusted ──admin trust route──▶ trusted ⇄ trusted_by_policy`. `untrusted` = visible, never materialized (withheld `platform-untrusted`).

### 5.3 Probe (per target, per project)

`unprobed ──probe──▶ ok(latencyMs,serverInfo) | failed(reason)`; result cached (platform columns / project-package `material.lastProbe`). Untrusted-source stdio → `refused(reason)` (never reaches supervisor).

## 6. Resolution rule (binding vs precedence) — the core invariant

For a given `(project, refId)`:

1. If an **enabled binding** exists → its `(target_kind, target_id)` is the winner; `provenance='binding'`, `boundTarget` recorded.
2. Else if a **disabled binding** exists → the ref is **unresolvable** (winner = none); a `required` ref here refuses launch with `CONFIG` naming the disconnect.
3. Else (absent binding) → apply `SOURCE_PRECEDENCE` (project > platform > flow-package) as today; `provenance='precedence'`.

Then, for the winner: if `source='platform'` and its live `trust_status='untrusted'` → **withheld** (`platform-untrusted`), excluded from the executable set, still visible in the ledger.

`required` refs with no executable winner refuse launch; `additional` refs degrade silently. Agent required refs honor bindings identically (D5, one resolver).

## 7. Per-route identifier-label table (DEC-1 — security boundary)

| Field | Label | Source of truth |
| --- | --- | --- |
| `project` (`project_id`) | server-state | derived from URL `slug` → project lookup; **never** a body field |
| `ref_id` | body-controlled | validated against the derived requirements ledger + registered refs |
| `target_kind` + `target_id` | body-controlled | validated against **server-state**: row MUST exist, MUST match `target_kind`; a platform target MUST be `enabled` + trusted to be **bindable-as-executable** |
| `config_overlay` | body-controlled | validated against the **target's declared slots** (unknown slot → `CONFIG` 422) |
| trust `id` (admin route) | server-state | from URL path param |

No binding-route body field names a filesystem path.

## 8. Contract surfaces (routes + wire) — Designed

| Method + path | Purpose | Body (client→server) |
| --- | --- | --- |
| `POST /api/projects/{slug}/mcp/bindings` | bind a ref to a target | `{refId, targetKind, targetId, configOverlay?}` |
| `PATCH /api/projects/{slug}/mcp/bindings/{refId}` | rebind / edit overlay / toggle enabled | `{targetKind?, targetId?, configOverlay?, enabled?}` |
| `DELETE /api/projects/{slug}/mcp/bindings/{refId}` | remove a binding (back to grandfather) | — |
| `POST /api/projects/{slug}/mcp/connect` | connect a platform MCP (enabled binding `target=platform`) | `{platformServerId, refId?}` |
| `POST /api/projects/{slug}/mcp/disconnect` | opt-out a platform MCP (disabled binding) | `{refId}` |
| `POST /api/projects/{slug}/mcp/probe` | test connection (web→supervisor proxy, trust-gated) | `{refId}` or `{targetKind, targetId}` |
| `POST /api/admin/mcp-servers/{id}/trust` | flip platform trust | `{trustStatus}` |
| `PATCH /api/admin/mcp-servers/{id}` | (extended) accepts `trustStatus` | +`trustStatus?` |
| Supervisor `POST /mcp-probe` | real MCP `initialize` handshake | `{transport, command?, args?, envKeys?, url?, headerKeys?}` (NAMES only) |

Response DTOs are explicit projections (never a raw DB row); no `env:` value ever appears. No new `MaisterError` code (reuse `CONFIG` / `EXECUTOR_UNAVAILABLE` / `CONFLICT` / `PRECONDITION`). No new SSE/AsyncAPI event.

## 9. Expectations (normative acceptance contract — ≤12, testable)

1. A binding row MUST be unique on `(project_id, ref_id)`; an enabled binding's `(target_kind,target_id)` MUST win over `SOURCE_PRECEDENCE` for that `ref_id`, and a disabled binding MUST make the ref unresolvable in that project.
2. An **absent** binding MUST leave resolution exactly as today (grandfather) — no behavior change for any project without bindings.
3. Every binding route MUST derive `project_id` from the URL slug (server-state) and MUST validate `target_kind`/`target_id` against existing rows of the matching kind; a platform target MUST be `enabled`+trusted to be bound as executable, else `CONFLICT`/`CONFIG`.
4. `config_overlay` MUST validate against the target's declared slots at write AND at materialization; an unknown slot MUST yield `MaisterError("CONFIG")` (422). Overlay application MUST rewrite only NAMES, keeping the ACP `mcpServers` wire shape unchanged.
5. No secret **value** MUST EVER appear in a `project_mcp_bindings` row, any HTTP response, a `session/update` payload, `materialization_plan`, `runs.withheld_mcps`, or a log — only `env:NAME` names.
6. A winning `source='platform'` record with live `trust_status='untrusted'` MUST be excluded from the executable set and recorded as withheld `platform-untrusted`, while remaining VISIBLE in the requirements ledger/hub.
7. The grandfather migration MUST set `trust_status='trusted'` for every `enabled=true AND trust_status='untrusted'` platform row and MUST leave `enabled=false` rows (Serena) untouched.
8. Every withhold (trust or exec-trust, flow or agent) MUST be persisted — flow into `node_attempts.materialization_plan.withheldMcps`, both flow and agent into `runs.withheld_mcps` — with NO silent warn-only path as the sole record.
9. `resolved_capability_set.mcps[]` MUST record `provenance ∈ {'binding','precedence'}` (+ `boundTarget` when bound) at launch; pre-migration runs MUST read the field as absent without error.
10. The requirements ledger MUST honor SET/CLEAR/re-SET symmetry: dropping the last declaring flow-revision/package/agent drops the requirement; re-adding restores it.
11. Supervisor `POST /mcp-probe` MUST release the spawned child and timer on every path (success, handshake failure, timeout, spawn error); the web probe proxy MUST refuse an untrusted-source stdio probe with a typed reason and MUST have NO override path in v1.
12. A package manifest `mcps[]` entry with neither `command` nor `url` MUST be a valid **requirement** (no `schemaVersion` bump); an entry WITH an implementation MUST stay a template; `recommendedPlatformServerId` MUST be an optional `capabilityRefId`.

## 10. Edge cases → `MaisterError`

| Case | Code | HTTP |
| --- | --- | --- |
| Bind unknown ref (not in ledger + not a registered ref) | `CONFIG` | 422 |
| Bind to a non-existent target, or `target_kind` mismatch | `CONFIG` | 422 |
| Bind a platform target that is disabled or untrusted, as executable | `CONFLICT` | 409 |
| `config_overlay` names an unknown slot (write or materialization) | `CONFIG` | 422 |
| Second binding for the same `(project, ref)` | `CONFLICT` | 409 |
| Required ref with a **disabled** binding at launch | `CONFIG` | 409 (names the disconnect) |
| Required ref unresolved (no candidate, no binding) at launch | `CONFIG` | 409 |
| Required ref agent-unsupported transport at launch | `EXECUTOR_UNAVAILABLE` | 503 |
| Probe an untrusted-source stdio MCP | `CONFIG` (typed refusal, no override) | 409 |
| Probe target missing / not connected | `PRECONDITION` | 409 |
| Trust route unknown platform id | `PRECONDITION` | 409 |
| Trust/binding as non-admin / unauthorized project role | `UNAUTHORIZED` | 403 |

## 11. Workstreams → acceptance mapping

| WS | Deliverable | Key ACs |
| --- | --- | --- |
| W-A | `project_mcp_bindings` + requirements ledger + requirement-only package manifest + `recommendedPlatformServerId` | 1,2,10,12 |
| W-B | binding-aware resolver + `provenance` | 1,2,9 |
| W-C | per-project env-slot overlay (names-only) | 4,5 |
| W-D | board `?tab=mcps` hub (3 sources, match/connect/overlay, metacell) + admin trust/used-by | 3,6 |
| W-E | trust made load-bearing + withheld visibility | 6,7,8 |
| W-F | supervisor `POST /mcp-probe` + web proxy (trust-gated) + readiness for project/package | 11 |
| W-G | unified MCP-select (node + scratch) + agent effective-MCPs read-only list | 1 (D5) |

## 12. Test matrix (TDD red→green — minimum-overlap, no trivial tests)

| Behavior | Kind | Location |
| --- | --- | --- |
| binding wins over precedence; disabled suppresses; absent unchanged | unit | `web/lib/capabilities/__tests__/resolver.binding.test.ts` |
| requirement classification + SET/CLEAR/re-SET symmetry | unit | `web/lib/mcp/__tests__/requirements-ledger.test.ts` |
| overlay slot validation (unknown slot → CONFIG); names-only rewrite | unit | `web/lib/capabilities/__tests__/overlay.test.ts` |
| binding routes: identifier-label enforcement, target validation, 409/422 | route unit | `web/app/api/projects/[slug]/mcp/bindings/__tests__/route.test.ts` |
| bind→launch→`resolved_capability_set` provenance='binding'; disconnect→refusal; grandfather zero-change | real-PG integration | `web/lib/capabilities/__tests__/binding-launch.integration.test.ts` |
| trust gate: untrusted platform visible-not-materialized; trust→materializes; Serena via real gate | real-PG integration | `web/lib/mcp/__tests__/platform-mcp-projection.integration.test.ts` |
| withheld persisted (flow matplan + run-level) — no silent path | integration | `web/lib/capabilities/__tests__/withheld.integration.test.ts` |
| secret-invariant grep-sentinel (proj A/B remap; no value in DB/response/log) | real-PG integration | `web/lib/capabilities/__tests__/overlay-secret-invariant.integration.test.ts` |
| supervisor probe: initialize happy-path + timeout kills child (deferred-release spy) + 3 transports | unit | `supervisor/src/__tests__/mcp-probe.test.ts` |
| web probe proxy: untrusted-source stdio refused, no override; no secret persisted | route unit | `web/app/api/projects/[slug]/mcp/probe/__tests__/route.test.ts` |
| migration 0093: table shape + grandfather backfill + binding round-trip | real-PG integration | `web/lib/db/__tests__/mcp-management-v2.integration.test.ts` |
| package manifest requirement-only accepted (no `command`/`url`); template stays; `recommendedPlatformServerId` optional | unit | `web/lib/__tests__/config.schema.mcp.test.ts` |
| McpSelect renders per-source groups + trust/readiness badges; node free-add; scratch defaults; agent effective list | render (renderToStaticMarkup) | `web/components/**/__tests__/mcp-select.test.ts` |
| hub match→bind→previously-refused launch succeeds; withhold renders; test-connection | e2e (seeded, mock ACP) | `web/e2e/.../mcp-hub.spec.ts` |
| i18n EN+RU parity for all new keys | parity | `web/lib/__tests__/i18n-parity.test.ts` |

Every promised test names its runner project; a test in a new path family extends the runner `include` glob in the same phase. Assertion migration is in-scope where behavior changes (Serena projection, resolver provenance, launch-refusal messages).

## 13. Invariants (SOLID / KISS / DRY / conventions)

- One resolution path for flows / agents / scratch — bindings thread through the shared pure resolver (DRY; do not fork).
- Binding create/update/overlay = single `db.transaction` (row + audit together). Trust flip = single update.
- No `any` without `// FIXME(any):`; `MaisterError` with `code` for all domain failures; UI branches on `code`.
- Overlay/probe/trust routes stay thin (parse → `web/lib/mcp/*` service → HTTP map); orchestration in the service layer.
- Verbose env-driven `LOG_LEVEL` logging at every resolution/binding/overlay/probe seam; never log a secret value.

## 14. Observability

- INFO on: bind/rebind/connect/disconnect, trust flip `{id,from,to,actor}`, probe result `{target,ok,latencyMs}`, withhold persisted `{refId,reason,scope}`.
- DEBUG on: per-ref resolver winner `{ref,source,provenance}`, requirement classification, overlay applied `{ref,remappedSlots}` (names only).
- Secret values MUST NEVER appear in any log line.

## 15. Deployment touchpoints

| Added | Lands in |
| --- | --- |
| `@modelcontextprotocol/sdk` supervisor dep | `supervisor/package.json` + `pnpm-lock.yaml` + container import smoke |
| `MAISTER_MCP_PROBE_TIMEOUT_MS` (8000) — teardown grace is fixed by the MCP SDK transport (~2s), so no `MAISTER_MCP_PROBE_TEARDOWN_GRACE_MS` is shipped | `.env.example` + `docs/configuration.md` env table (supervisor runs on the host — compose containerizes Postgres only, no supervisor `environment:` block) |
| Supervisor `POST /mcp-probe` | rides existing supervisor HTTP (no new port); `docs/api/supervisor.openapi.yaml` |

No new sidecar binary, no new bound port.
