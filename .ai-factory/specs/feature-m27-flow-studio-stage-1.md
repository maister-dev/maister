# SDD Spec (FROZEN) — M27 Flow Studio Stage 1

> **Status:** Phase-0 spec freeze. This is the **single source of truth** for M27
> implementation. Every later deviation requires a spec amendment, never an
> ad-hoc code change. Plan: [`.ai-factory/plans/feature-m27-flow-studio-stage-1.md`](../plans/feature-m27-flow-studio-stage-1.md).
> All described pieces are **(Designed)** at Phase-0 HEAD (R6); the docs phase
> flips them to **(Implemented)** as code lands.
> Conventions inherited: `MaisterError` taxonomy (no plain Error), atomic writes
> to `.maister/`, EN+RU parity, HeroUI v3 + React Flow (no new deps), strict TS,
> verbose+configurable logging, no engine bump, no new `runs.status`.

---

## 1. Purpose & scope

Turn the read-only M22 flow-graph **view** into an **editor** for ANY installed
flow, make an edited flow **runnable on next launch** (executable bridge), and add
**MCP capability management** across platform-instance / project / flow-package
scopes. Edits persist as an **M25 authored `flow` draft** (ADR-061 reuse); layout
in the `flow.yaml` `presentation` section (ADR-064); every save passes the
`validateGraphManifest` + `compileManifest` hard-gate before persistence. Launch
**resolves** the effective revision (`version_binding`), compiles it, and
**snapshots the resolved set** so in-flight runs stay immutable.

Out of scope (do not implement): multi-artifact package bundling / integrity /
build-distributable / lockfile pin; agent-assisted authoring; proposal-return;
PR publication + two-way catalog sync; scheduling; MCP marketplace / reputation /
malware scan / sandboxing / org policy. ADR-051 `flow_graph_layouts` is DEAD.

## 2. Reuse map (build on, do NOT rebuild)

| Capability | Reused symbol (verified) | M27 change |
|---|---|---|
| Authored draft + optimistic concurrency | `web/lib/catalog/authored-service.ts` `updateAuthoredDraft` (`draft_version` CAS, `:279-352`) | flow-kind drafts also run the graph hard-gate before the CAS write |
| Executable bridge (flows row + flow_revisions + materialize) | `web/lib/flows.ts` `installAuthoredFlowPackageBridge` (`:999`) → `installFlowPluginImpl(args, trust)`; two-phase `ensureRevisionIntentRow`→finalize (`:507,588,811`) | call from in-app publish, parameterized to `trusted_by_policy`; add `trustStatusOverride` param |
| Trust-gated setup.sh runner (physically separate, sentinel) | `web/lib/flows.ts` `runRevisionSetup` (`:785`), `runSetupSh` (`:273`) | **change its gate from `flows.trustStatus` to the new `exec_trust` axis** |
| Pinned-revision launch + in-flight immutability | `web/lib/services/runs.ts` `launchRun` (`:215-543`); `runner-core.ts` `loadRun` (`:206-231`) | insert `resolveEffectiveFlowRevision` + resolved-set snapshot |
| Capability resolution | `web/lib/capabilities/resolver.ts` `selectedRecords` (`:134-164`) | add **winner-picking** by precedence (today returns ALL → duplicates) |
| Per-session MCP/skill materialization | `web/lib/capabilities/materialize.ts` (`:208`), `agent-map.ts` (`:89-101`), supervisor `acp-client.ts:172` | extend MCP transport (sse/http); codex flip-or-document |
| Admin CRUD pattern | `app/api/admin/acp-runners/**` + `acp-runners-panel.tsx` + `acp-runner-modal.tsx` + `lib/acp-runners/{usage,runner-form}.ts` (ADR-065) | mirror for `platform_mcp_servers` |
| Read-only graph view | `flow-graph-view.tsx` (`nodesDraggable=false` hardcoded), `buildGraphTopology` (pure), `presentationLayout` | sibling **editor** component (edit mode), project-scoped graph API |

## 3. Domain entities (deltas)

- **Authored flow draft/revision** — `authored_capabilities` (kind=`flow`) + `authored_capability_revisions` (`manifest`, `content_hash`). NEW column `authored_capabilities.source_flow_ref_id text NULL` (links an edited *installed* flow to its `flow_ref_id`).
- **Bridged runnable flow** — the existing `flows` (+ NEW `version_binding`) and `flow_revisions` (+ NEW `exec_trust`) rows produced by the bridge.
- **Run resolved-set** — NEW `runs.resolved_capability_set jsonb NULL`.
- **Platform MCP server** — NEW table `platform_mcp_servers` (admin-managed, mirrors `platform_acp_runners`).
- **MCP capability record** — existing `capability_records` (kind=`mcp`, source∈{platform,project,flow-package}); extended `material` transport shape.

### 3.1 Schema deltas (DDL — migration `0031+`; hand-authored SQL + `_journal.json` idx; NEVER `db:generate`)

```sql
-- flows.version_binding (B1)
ALTER TABLE flows ADD COLUMN version_binding text NOT NULL DEFAULT 'latest';
ALTER TABLE flows ADD CONSTRAINT flows_version_binding_ck CHECK (version_binding IN ('pinned','latest'));

-- flow_revisions.exec_trust (B3) — the NET-NEW second trust axis, per-revision
ALTER TABLE flow_revisions ADD COLUMN exec_trust text NOT NULL DEFAULT 'untrusted';
ALTER TABLE flow_revisions ADD CONSTRAINT flow_revisions_exec_trust_ck CHECK (exec_trust IN ('untrusted','trusted'));

-- authored_capabilities.source_flow_ref_id (A5.1) — link edited installed flow → its flow_ref_id
ALTER TABLE authored_capabilities ADD COLUMN source_flow_ref_id text NULL;

-- runs.resolved_capability_set (B5) — frozen at launch, read by the runner
ALTER TABLE runs ADD COLUMN resolved_capability_set jsonb NULL;

-- platform_mcp_servers (C1) — mirrors platform_acp_runners
CREATE TABLE platform_mcp_servers (
  id text PRIMARY KEY,
  transport text NOT NULL CHECK (transport IN ('stdio','sse','http')),
  command text NULL,             -- stdio
  args jsonb NOT NULL DEFAULT '[]',
  env_keys jsonb NOT NULL DEFAULT '[]',   -- NAMES only (env:NAME); values resolved supervisor-side
  url text NULL,                 -- sse|http
  header_keys jsonb NOT NULL DEFAULT '[]',-- NAMES only
  supported_agents jsonb NOT NULL DEFAULT '["claude","codex"]',
  trust_status text NOT NULL DEFAULT 'untrusted' CHECK (trust_status IN ('untrusted','trusted','trusted_by_policy')),
  readiness_status text NOT NULL DEFAULT 'Unknown' CHECK (readiness_status IN ('Unknown','Ready','NotReady')),
  readiness_reasons jsonb NOT NULL DEFAULT '[]',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`resolved_capability_set` shape: `{ flowRevisionId: string, flowOrigin: "authored"|"git", capabilities: {refId,kind,sha}[], mcps: {refId,sha,scope}[] }`.

### 3.2 Config-schema deltas (`web/lib/config.schema.ts`)

- `mcpCapabilitySchema` → discriminated `transport`: `stdio` {command, args?, env?} | `sse`|`http` {url, headers?}. Secrets only `env:NAME` (regex `^env:[A-Za-z_][A-Za-z0-9_]*$`); values never stored.
- Node `settings.mcps` (string[]) → distinguish **required** vs **additional**: `settings.mcps: { required?: string[], additional?: string[] }` (back-compat: a bare `string[]` is treated as `additional`). `judge` settings same.
- Flow-package required-MCP declaration: `flow.yaml` top-level `mcps?: string[]` (capability ref ids) — validated by the hard-gate (unknown ref → CONFIG).
- `presentation` unchanged (ADR-064); the editor writes `nodes[].{id,x,y,width,height,color}`.

## 4. State machines

### 4.1 Authored flow → executable (process flow)
```
edit on canvas → serialize manifest → validateGraphManifest+compileManifest
  (FAIL → CONFIG, NOT persisted)
  → PATCH /draft (expectedDraftVersion CAS; stale → CONFLICT)        [DRAFT]
→ publish-local → M25 revision commit                                [PUBLISHED]
  → bridge: export package dir → installAuthoredFlowPackageBridge(trusted_by_policy)
     two-phase intent(Installing) → finalize(Installed)              [flows row + flow_revisions, trustStatus=trusted_by_policy, exec_trust=untrusted]
→ (operator) POST trust-executable                                   [exec_trust=trusted]
  → runRevisionSetup (gated on exec_trust) runs setup.sh once (sentinel)
→ launch: resolveEffectiveFlowRevision(version_binding) → snapshot resolved-set → run [IMMUTABLE]
```

### 4.2 Trust axes (two, independent)
- `flows.trustStatus` (LOGIC): `untrusted | trusted | trusted_by_policy`. Gates launch precondition #9. In-app authored publish sets `trusted_by_policy`.
- `flow_revisions.exec_trust` (EXECUTABLE): `untrusted | trusted`. Gates `runRevisionSetup` (setup.sh) AND MCP stdio `command` spawn. Default `untrusted`; explicit flip required.
- **Invariant:** logic-trust alone NEVER runs setup.sh or an MCP stdio command.

### 4.3 version_binding
- `pinned` → resolve `flows.enabled_revision_id` (M10 pointer).
- `latest` → newest **PUBLISHED** `flow_revisions` for the `flow_ref_id`, **never a draft**; **authored-wins** tie-break when authored & git revisions are both newest.

## 5. HTTP routes (Identifiers labeled; bodies; status codes)

Labels: U=url-param→server-state, A=auth-context, B=body-controlled, S=server-state.

| Route | Method | Ids | Body | Success | Errors |
|---|---|---|---|---|---|
| `/api/projects/[slug]/catalog/caps/[capId]/graph` | GET | slug(U), capId(U, asserted ∈ slug) | — | 200 `{topology,layout,draftVersion,kind}` | 401/403, 404 |
| `/api/projects/[slug]/catalog/caps/[capId]/draft` | PATCH (reuse M25) | slug(U),capId(U); expectedDraftVersion(B) | `{title?,manifest,body?,expectedDraftVersion}` | 200 revision | 409 stale CAS, 422/CONFIG invalid manifest (NOT persisted) |
| `/api/projects/[slug]/catalog/caps/[capId]/diff` | GET | slug(U),capId(U) | — | 200 `{publishedYaml,draftYaml}` | 401/403,404 |
| `/api/projects/[slug]/catalog/caps/[capId]/publish-local` | POST (reuse+bridge) | slug(U),capId(U) | empty | 200 `{revision, flowRowId, revisionId}` | 409 stale, CONFIG invalid |
| `/api/projects/[slug]/flows/[flowId]/version-binding` | PATCH | slug(U),flowId(U) | `{binding: pinned\|latest}` | 200 `{ok}` | 422 bad enum, 404 |
| `/api/projects/[slug]/flows/[flowId]/trust-executable` | POST | slug(U),flowId(U) | empty | 200 `{ok, exec_trust:"trusted"}` | 403, 404 |
| `/api/admin/mcp-servers` | GET | A=admin | — | 200 `{servers[],adapters?}` | 401/403 |
| `/api/admin/mcp-servers` | POST | A=admin | server body, secrets env:NAME | 201 `{ok,id}` | 409 dup id, 422 |
| `/api/admin/mcp-servers/[id]` | PATCH | id(U),A=admin | partial (≥1) | 200 `{ok}` | 409 usage-blocked disable, 404, 422 |
| `/api/admin/mcp-servers/[id]` | DELETE | id(U),A=admin | — | 204 | 409 usage-referenced, 404 |
| `/api/projects/[slug]/mcp` | GET/POST | slug(U), RBAC project admin | server body (project scope) | 200 / 201 | 409 dup, 422 |
| `/api/projects/[slug]/mcp/[mcpId]` | PATCH/DELETE | slug(U),mcpId(U) | partial | 200 / 204 | 409, 404 |
| `/api/projects/[slug]/mcp/resolve` | POST | slug(U) | operator-confirmed params (env:NAME) | 200 `{resolved[],proposed[]}` | 422 |

All routes: secrets accepted ONLY as `env:NAME`; never echoed in any response. Two-phase commit reused from the bridge for publish-local (intent before disk, `Installed` marker after).

## 6. Allow-lists & gates (write code EXACTLY as stated)

### 6.1 Capability resolution precedence (ALL kinds: mcp, skill, rule, agent_definition, restriction)
Winner per `(kind, capability_ref_id)`: **project > platform > flow-package** (local-first). Same id + different params → higher-precedence record used, lower **shadowed (no merge)**, **no duplicate emitted**. (Supersedes the current `resolver.ts` return-all/no-winner behavior + fixes its latent duplication.)

### 6.2 Required vs additional MCP at launch
- REQUIRED MCP that cannot resolve+materialize → launch **REFUSED** (`CONFIG` unresolved-ref / `EXECUTOR_UNAVAILABLE` agent-unsupported), inserted AFTER the M14 unknown-cap-ref check in `launchRun`.
- ADDITIONAL MCP absent → non-fatal (session augmented if present).
- Long-living `slash-in-existing` sessions share ONE resolved MCP profile (existing `profileDigest` consistency, `runner-agent.ts:105`).

### 6.3 launchRun insertion points (preserve existing order)
1. After existing trust/setup/engine guards, BEFORE worktree+snapshot: `resolveEffectiveFlowRevision(flow, {binding})` → the resolved revision still passes trust(#9)+setupStatus+engine-compat.
2. Required-MCP refusal: after the M14 cap-ref check (`runs.ts:475`).
3. Resolved-set snapshot: written in the EXISTING `runs` insert tx (`runs.ts:590`).

### 6.4 Two-axis trust gates
- Launch guard #9 (`trustStatus≠untrusted`) unchanged — gates LOGIC trust.
- `runRevisionSetup` gate: change from `flows.trustStatus` → `flow_revisions.exec_trust === 'trusted'`.
- MCP stdio `command` spawn gate: `exec_trust === 'trusted'` for the owning revision.

## 7. Expectations (R5a — normative, testable)

### 7.1 Flow Studio (authoring + executable resolution)
1. A draft save MUST run `validateGraphManifest`+`compileManifest` BEFORE the `draft_version` CAS write; an invalid manifest MUST throw `CONFIG` and MUST NOT mutate the draft row.
2. A stale `expectedDraftVersion` MUST fail with `CONFLICT` (409) and MUST NOT write.
3. Editing an installed flow MUST record its `source_flow_ref_id` so publish→bridge targets the SAME `flows` lineage; a net-new authored flow MUST mint a fresh `flow_ref_id`.
4. Publishing an authored `flow` MUST bridge it into a `flows` row + `flow_revisions` row via `installAuthoredFlowPackageBridge`, `trustStatus=trusted_by_policy`, `exec_trust=untrusted`.
5. `setup.sh` MUST NOT run on publish/bridge; it runs ONLY after an explicit `exec_trust` flip, via `runRevisionSetup` (physically separate, sentinel once-only).
6. An MCP stdio `command` MUST NOT be spawned for a revision whose `exec_trust≠trusted`.
7. Launch with `version_binding=latest` MUST resolve the newest PUBLISHED revision, NEVER a draft; authored-wins on tie.
8. Launch MUST snapshot the resolved set into `runs.resolved_capability_set`; the runner MUST read the snapshot, never the live catalog; an edit/publish during a run MUST NOT mutate that run.
9. The editor MUST be read-write only for users with `manageCatalog`; the run-scoped view stays read-only (`readBoard`).
10. No engine bump; no new `runs.status`; presentation stays additive/runner-ignored.

### 7.2 MCP management
1. MCP secret values MUST be stored/accepted ONLY as `env:NAME`; values MUST be resolved supervisor-side and MUST NEVER appear in any HTTP response, DB column, or `session/update` payload.
2. Capability id-collision MUST resolve project > platform > flow-package, picking exactly ONE winner per `(kind, refId)`, no duplicate materialization.
3. A platform MCP DELETE MUST be refused (409) while any usage reference exists (mirror `assertCanDisable`); zero refs → 204.
4. A platform MCP POST with a duplicate id MUST return 409 (via `onConflictDoNothing().returning()`), never a raw 500.
5. Setup-time resolve MUST reuse an already-present MCP by id (dedupe, no silent duplicate); an absent REQUIRED MCP MUST block launch until configured.
6. A REQUIRED MCP that cannot resolve+materialize MUST refuse launch; an ADDITIONAL MCP absence MUST NOT.
7. Resolved MCP revisions MUST be included in the launch resolved-set snapshot.
8. Materialization MUST reuse M14 (`materialize.ts`/`agent-map.ts`/supervisor wire) — no parallel materialization path.
9. Flow-package MCP declarations MUST honor config SET/CLEAR/re-SET symmetry (declared→required; removed→not required; re-added→required).
10. Codex MCP support MUST be either materialized (if `codex-acp` supports it) OR explicitly documented as a gap (no silent degrade).

## 8. Edge cases → MaisterError

| Case | Code | HTTP |
|---|---|---|
| Invalid manifest on draft save / publish | `CONFIG` | 422 (not persisted) |
| Stale `expectedDraftVersion` | `CONFLICT` | 409 |
| Unknown MCP/skill ref in manifest | `CONFIG` | 422 |
| Required MCP unresolved at launch | `CONFIG` | 409 |
| Required MCP agent-unsupported (strict) | `EXECUTOR_UNAVAILABLE` | 503 |
| setup.sh / MCP stdio before exec_trust flip | refused (no exec) | n/a (guarded) |
| Bridge of invalid package | `CONFIG` | 422 |
| Platform MCP delete while referenced | `CONFLICT` | 409 |
| version-binding bad enum | `CONFIG` | 422 |

## 9. Spec-to-test matrix (acceptance → named test)

| # | Acceptance | Test (project · file) |
|---|---|---|
| 7.1.1 | invalid manifest → CONFIG, row unchanged | int · `authored-service.flow-hardgate.integration.test.ts` |
| 7.1.2 | stale draft_version → 409 | int · same |
| 7.1.3 | source_flow_ref_id recorded / minted | unit+int · `authored-flow-link.test.ts` / `.integration.test.ts` |
| 7.1.4 | publish → flows+flow_revisions, trusted_by_policy/untrusted | int · `authored-bridge.integration.test.ts` |
| 7.1.5 | setup.sh not on publish; runs after flip | int · `exec-trust.integration.test.ts` |
| 7.1.6 | MCP stdio not spawned until exec_trust | int · `exec-trust.integration.test.ts` |
| 7.1.7 | latest→newest-published-never-draft; authored-wins | unit · `resolve-effective-revision.test.ts` |
| 7.1.8 | resolved-set snapshot + in-flight immutability | int · `resolved-set-snapshot.integration.test.ts` |
| 7.1.9 | editor RBAC manageCatalog; view stays readBoard | int · `flow-editor-rbac.integration.test.ts` |
| 7.2.2 | precedence project>platform>package, no dup | unit · `resolver-precedence.test.ts` |
| 7.2.3/4 | platform MCP usage-guard delete; dup 409 | int · `admin-mcp-crud.integration.test.ts` |
| 7.2.5/6 | setup-resolve present-reuse/absent-propose; required refusal | int · `mcp-setup-resolve.integration.test.ts` |
| 7.2.9 | package MCP SET/CLEAR/re-SET symmetry | int · `mcp-config-symmetry.integration.test.ts` |
| editor E2E | open→add node→rewire→edit settings→save→reopen→invalid refused | e2e · `m27-flow-editor.spec.ts` |
| admin MCP E2E | create/edit/delete + block (mirror runner) | e2e · `m27-platform-mcp.spec.ts` |

Runnability: unit files match `lib/**/__tests__/**/*.test.ts` or `components/**/*.test.ts`; integration match `lib/**/*.integration.test.ts` or `app/**/*.integration.test.ts`; e2e under `web/e2e/`. Prove with `vitest list` per phase.

## 10. Implementation status

All sections above: **(Designed)** at Phase-0 HEAD. Docs phase (T0.3–T0.8) flips
each to **(Implemented)** as the owning code task lands. Reused symbols (§2) are
**(Implemented)** — M27 only wires/extends them.
