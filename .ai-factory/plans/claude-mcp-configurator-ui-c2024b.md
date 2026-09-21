# Implementation Plan: MCP configurator — env/header value maps, bearer token field, value-replacing overlays, host env-ref readiness, adapter transport gate

Branch: `claude/mcp-configurator-ui-c2024b` (worktree HEAD = `6cd95560` = local `master`; the branch is kept as-is — the five newest plans in this directory use the worktree branch and name the plan after it, which is how `/aif-implement` resolves the plan file)
Created: 2026-09-21 · Refined: 2026-09-21 (`/aif-improve` — SDD/TDD pass: acceptance matrix, overlap budget, refactor ledger, commit sequencing, 12 additions)
Design SSOT: [`docs/plans/2026-09-21-mcp-configurator-env-model-design.md`](../../docs/plans/2026-09-21-mcp-configurator-env-model-design.md) — decisions D1–D12 are frozen there; its §11 open point and the three questions this plan raised were answered by the owner on 2026-09-21 (see Resolved). This plan adds the ground truth the design did not have, the decisions the corrections force, and the task ledger.

## Settings

- Testing: **yes** — RED-first TDD per plan item, against real seams: real Postgres (testcontainers) for the migration/backfill, overlay and readiness integration cases; supervisor routes booted in-process with the recording mock adapter (`supervisor/src/__tests__/_fixtures/boot-host.ts`); jsdom per UI surface (`// @vitest-environment jsdom`, unit project). No trivial tests; existing assertions that the behavior change invalidates are migrated IN the phase that changes them (enumerated per task).
- Logging: **standard** — key NAMES and counts only. The invariant "MAIster never stores, returns, streams or logs the value behind a reference" (design §3) forbids verbose value logging by construction; each task names its log lines.
- Docs: **yes** — mandatory docs checkpoint. Phase 0 is docs-first per the project's `aif-plan` skill-context rule; Phase 6 is the truth pass.

## Roadmap Linkage

Milestone: "none".
Rationale: owner-approved design doc (2026-09-21) with no `ROADMAP.md` row; the only open milestone is M51 (visibility layer), unrelated. `/aif-verify --strict` should report WARN for missing linkage alone, not fail.

---

## Ground truth — corrections and additions to the design doc

Verified against `6cd95560` on 2026-09-21. The design is accurate except where noted; **C1, C3, C4, C10, C12 change the work**. Do not re-derive them.

### C1 — The literal-value channel already exists end-to-end, keyed `env`

`supervisor/src/types.ts:207` — `env: z.record(z.string().min(1).max(256), z.string()).optional()` (comment `:194-199`: the ADR-089 channel for server-generated secrets). `web/lib/capabilities/agent-map.ts:22-31` — `AgentMcpServer` carries BOTH `envKeys?: string[]` and `env?: Record<string,string>`. `supervisor/src/acp-client.ts:973-981` already merges them (`envKeys` from `process.env`, literal `env` wins on the same name). The only production writer of literal `env` is the facade generator `web/lib/agents/launch.ts:2693-2710` (`MAISTER_API_BASE_URL`, `MAISTER_PROJECT_TOKEN`).

**Consequence:** D12 is a *collapse* of two fields into one map whose values are `literal | env:NAME`, not the introduction of a map. The facade generator keeps writing literal `env` and needs no change; the e2e test-supervisor reads it the same way (`web/e2e/_seed/test-supervisor.ts:314-325`, `env?.MAISTER_PROJECT_TOKEN`). `headers` and `bearerTokenEnv` are the net-new fields.

### C2 — Facade precedence is a plain concat, not a key-merge

`web/lib/agents/launch.ts:3383-3386` — `mcpServers: [...profileMcpServers, ...(facadeServer ? [facadeServer] : [])]`, no dedupe by `name`; the facade entry never passes `gateAndOverlayMcpServers`. The design's "merged by key over catalog entries" describes nothing in the tree; ADR-089 precedence holds only because no catalog server is named `maister`. **Kept as-is (out of scope); recorded as trap T12.**

### C3 — Scratch runs bypass the shared gate (the codex + SSE fix is half a fix without a decision)

`web/lib/scratch-runs/service.ts:869` and `:1561` call `materializeCapabilityProfile` (`web/lib/capabilities/materialize.ts`, which imports `mapProfileToAgentArtifacts` but no gate/overlay), then hand `materialized.mcpServers` straight to the create payload (`service.ts:1097`, `:1713`). `gateAndOverlayMcpServers` has exactly two callers — `web/lib/flows/graph/runner-graph.ts:2076-2089` and `web/lib/agents/launch.ts:2664-2671` — while its own header (`materialization-gate.ts:185-191`) claims it is "shared by every launch surface (flow node, agent, scratch)". A transport pass inside `partitionWithheldMcps` therefore leaves a codex scratch session with an `sse` server crashing at `session/new`. → **Resolved: scratch goes through the full shared gate (D17).**

### C4 — Readiness exists only for platform rows, is recomputed only on two admin writes, and its reasons are never shown

`evaluateMcpReadiness` is called from `web/app/api/admin/mcp-servers/route.ts:141-154` (POST) and `[id]/route.ts:184-197` (PATCH) only; not on trust flip, not on DELETE, and `web/lib/mcp/project-mcp-service.ts` never imports it. Nothing writes `material.readiness`. `docs/system-analytics/mcp-management.md:224-226` claims "v2 extends the same evaluator over project/package `capability_records` material … caching into `material.readiness`" — a docs defect, and the design's §6 sentence "the same evaluator serves project/package rows" inherits it. Separately, `readiness_reasons` is computed and stored but `web/app/(app)/mcps/page.tsx:26-40` does not select it and `mcp-servers-panel.tsx:113-117` renders the status only — unlike the runner panel's tooltip (`acp-runners-panel.tsx:68-69`). Under a presence check, the reason (`env ref missing: X`) is the whole point. → **Resolved: write-time cache for project and package rows (D18); D19 for the reasons.**

### C5 — Two supervisor schemas and two header shapes must move together

`supervisor/src/types.ts:200-226` (`McpServerInputSchema`: strict, bounded, has `env`) and `supervisor/src/http-api.ts:133-158` (`McpProbeRequestSchema`: strict, unbounded, no `env`, no `name`) already drift. ACP wants `HttpHeader[]` (`acp-client.ts:960`); the MCP SDK probe wants `Record<string,string>` (`mcp-probe.ts:77-79`). The new `mcp-values.ts` emits both shapes and composes `Authorization: Bearer` in both; both zod schemas derive from one field set.

### C6 — The supervisor has no 400

`http-api.ts:1334-1341`: `ZodError → 409 {code:"PRECONDITION", message:"<path>: <issue>; …"}`. D12's strict rejection of `envKeys`/`headerKeys` therefore yields `409` whose message names `mcpServers.0.envKeys` — adequate; no named legacy-field guard is added (the `LEGACY_SESSION_PATH_FIELDS` pattern at `types.ts:304-323` / `http-api.ts:2041-2054` is for path fields). The OpenAPI documents malformed bodies as 409 already (`supervisor.openapi.yaml:1400-1404`).

### C7 — The supervisor OpenAPI has no `McpServerInput` schema and forbids `mcpServers`

`docs/api/supervisor.openapi.yaml` contains no `McpServerInput` component and no `mcpServers` property on `StartSessionRequest` (`additionalProperties: false` at `:2110`), while `types.ts:363` accepts it — drift older than this work. `supervisor/src/__tests__/openapi-examples.test.ts` validates only `components.schemas.*.example`, so the new component MUST ship an `example` to be parity-checked. Phase 0 adds the component, the property, the probe body change, and the `/diagnostics/env-refs` path.

### C8 — Three `env:` grammars are live; the MCP one is copied four times

Runner: `web/lib/acp-runners/runner-form.ts:31-36` (`literal | env:NAME`, any case — the canonical shape, and the exact zod twin already exists in the supervisor as `runnerEnvValueSchema`, `supervisor/src/types.ts:37-48`). MCP: `ENV_KEY_RE = /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/` (`web/lib/mcp/mcp-form.ts:35`) duplicated verbatim as `envKeyRefSchema` in `web/app/api/admin/mcp-servers/route.ts:24-29`, `[id]/route.ts:29`, `web/app/api/projects/[slug]/mcp/route.ts:19-24`, `[mcpId]/route.ts:21`. Package: `PACKAGE_ENV_REF = /^env:[A-Z0-9_]+$/` (`web/lib/config.schema.ts:1502`, uppercase-only, mandatory prefix). One grammar module replaces the four MCP copies and the package regex relaxes to it (D4).

### C9 — Stored keys exist in two spellings; the backfill must strip

`ENV_KEY_RE` accepted both `GITHUB_TOKEN` and `env:GITHUB_TOKEN` as KEYS, so live `env_keys` rows hold either. Every reader strips (`projection.ts:24 stripEnvPrefix`, `materialization-gate.ts:109-111 bareName`, `probe-service.ts bare()`, `readiness.ts envRefName`). A backfill that does not strip turns `env:X` into the map key `env:X`. The migration uses `regexp_replace(k, '^env:', '')` on both sides.

### C10 — `capability_records.material` for `kind='mcp'` has three shapes today, and package-template slots resolve empty

Project rows: `web/lib/mcp/project-mcp.ts:19-28` (`envKeys`, `headerKeys`). Platform-from-YAML rows: `web/lib/capabilities/catalog.ts:101-115` (`envKeys: redactedEnv(c.env)` — `redactedEnv` at `:68-70` throws the VALUES of `maister.yaml capabilities.mcps[].env/headers` away; the YAML schema `config.schema.ts:94-105` is already a value map). Package rows: `web/lib/packages/attach.ts:429-471` — a requirement row stores `envKeys: string[]` (`:457`), a template row stores `env: Record` with `env:NAME` values (`:466`). `resolveBindTarget` (`web/lib/mcp/binding-service.ts:250-253`) reads only `material.envKeys/headerKeys`, so an overlay on a package-template target can name no slot today (pre-existing defect). The migration rewrites all three shapes to `env`/`headers` maps and "slots = keys of the maps" fixes the defect by construction. The YAML path → **Resolved: values are carried under the shared grammar (D31).**

### C11 — `mcpTransports` is dead data; the adapter facts are verified in `node_modules`

`web/lib/acp-runners/adapter-support.ts:86,106,124,146,164,186` — `["stdio","sse","http"]` for all five adapters, zero readers repo-wide; the supervisor has no per-adapter transport knowledge at all (`adapter-registry.ts`, `spawn.ts`). Verified: `@agentclientprotocol/codex-acp@1.10.0` `dist/index.js:28576-28594` (`createMcpSeverConfig`) throws `invalidRequest` for `sse` and `acp`, accepts `http` (`url` + `http_headers`) and untagged stdio; `@agentclientprotocol/claude-agent-acp@0.75.1` `dist/acp-agent.js:5812-5836` accepts `http|sse` + untagged stdio and **silently drops** a server carrying an explicit `type:"stdio"` (the v2 shape). `@agentclientprotocol/sdk@1.4.0` `dist/v2` has no `sse` variant; the supervisor imports v1 (`acp-client.ts:10`). Keep emitting untagged stdio (T4).

### C12 — The required-ref refusal already has a home; the gate only logs

`firstAgentUnsupportedRequiredMcp` (`web/lib/capabilities/resolver.ts:210-247`) is thrown as `EXECUTOR_UNAVAILABLE` at `web/lib/services/runs.ts:1304-1317` BEFORE the worktree exists — today for `supported_agents` only. `runner-graph.ts:2070-2150` and `launch.ts:2664-2682` only `warn` on withholds; neither refuses. So: the transport check for REQUIRED flow refs lands in that precondition (same code, new reason, `material.transport` added to the select at `services/runs.ts:1290-1302`), and `partitionWithheldMcps` withholds the ADDITIONAL ones with a persisted reason. `docs/error-taxonomy.md:262-264` already carries the row as Designed.

### C13 — Three test doubles serve `/diagnostics`; `HostAdminClient` is not where the design says

`web/e2e/_seed/stub-supervisor.ts:517-540`, `web/e2e/_seed/test-supervisor.ts:1130-1145`, `web/test-support/fake-execution-host.ts:932-943` all implement diagnostics and all need the env-refs surface. `HostAdminClient` is declared in `web/lib/execution-host/client.ts:221-248` (re-exported by `index.ts:62`), not `contracts.ts`; the local-direct transport is `web/lib/execution-host/transports/local-direct.ts:81`; the wire call lives in `web/lib/supervisor-client.ts:728-786` (`checkSupervisorDiagnostics`). New wire types must be re-exported through `web/lib/execution-host/index.ts` — `web/eslint.config.mjs:184-218` fences `@/lib/supervisor-client` to `lib/execution-host/**`, tests and e2e.

### C14 — R5a caps and a contradicting edge-case row

`docs/system-analytics/mcp-management.md:227-240` Expectations is a numbered list of exactly 12 (the cap); `capabilities.md` has 13 and `acp-runners.md` 19 (already over — do not make them worse). Edge-case row `:257` "Raw (non-`env:`) secret in any MCP field → `CONFIG` 422" contradicts D1/D9 and is rewritten. The e2e MCP specs (`m27-platform-mcp`, `mcps`, `mcp-hub`) fill only the `Server id` / `Command` labels and assert no readiness value — the rows UI does not break them.

### Confirmed verbatim from the design

- `acp-client.ts:960-963` sends `{ name: k, value: process.env[k] ?? "" }` per header key (defect 1); `readiness.ts:63-71` flags every name absent from `/diagnostics.envRefs` (defect 4); `overlay-apply.test.ts:21-30` pins the rename `expect(out.envKeys).toEqual(["PROJ_A_GH", "GH_HOST"])` (defect 3).
- `web/lib/execution-host/redact.ts:70` reduces `mcpServers` to `mcpServerCount` (E-EH-12 holds); `supervisor/src/runtime-events.ts:92-93` `SECRET_KEY` already matches `headers`, `env`, `authorization`.
- Migration test helpers exist: `startMainPostgresTestDbUpTo` + `applyMainMigration` (`web/test-support/pg-container.ts:340-375`), pattern `web/lib/db/__tests__/mcp-management-v2.integration.test.ts`; `migration-journal-integrity.test.ts:133` enforces the newest-snapshot rule.
- `pnpm validate:docs` is green on this tree with the design doc + README row (2026-09-21).

---

## Decisions (frozen — do not relitigate during implementation)

D1–D12 are the design doc's and are restated only where a correction sharpens them.

| # | Decision | Reason |
|---|---|---|
| D13 | Stay on `claude/mcp-configurator-ui-c2024b`; plan file `.ai-factory/plans/claude-mcp-configurator-ui-c2024b.md`. No `feature/*` branch. | Precedent of the five newest plans; `/aif-implement` derives the stem from the current branch. |
| D14 | ONE grammar module `web/lib/mcp/value-grammar.ts` (isomorphic, pure, no imports beyond zod): `ENV_NAME_RE`, `HEADER_NAME_RE` (RFC 7230 token), `ENV_REF_RE`, `isEnvRef`, `classifyMcpValue(v) → "literal" \| "env-ref" \| "malformed-env-ref"`, zod `mcpValueSchema`, `envRefSchema`, `mcpEnvMapSchema`, `mcpHeaderMapSchema`, `hasAuthorizationHeader(headers)`, `secretShapedKey(kind, key)`, and `HEADER_VALUE_RE` (RFC 7230 field-value alphabet `^[\t\x20-\x7E\x80-\xFF]*$` — applied to LITERAL header values so CR/LF/control characters are refused at write, not discovered as a runtime `fetch` TypeError). Consumed by `mcp-form.ts`, the four routes, `binding-schemas.ts`, `config.schema.ts` (package manifest), the Studio editor. The supervisor reuses `runnerEnvValueSchema` (`types.ts:37-48`) under an `mcpValueSchema` alias. | C8 — four verbatim copies and three grammars is the defect shape; one validator per D-§3. |
| D15 | Wire and storage shape: `env: Record<envName, value>`, `headers: Record<headerName, value>`, `bearerTokenEnv?: env:NAME`, `description?: string`; `envKeys`/`headerKeys` removed everywhere. Normalization by transport (web `buildMcpServerFields` + supervisor `superRefine`): stdio drops `url/headers/bearerTokenEnv`; sse/http drop `command/args/env`. `bearerTokenEnv` on stdio → refused by the supervisor, normalized away by the web form. | D10, D12; one shape on both sides of the seam. |
| D16 | Facade concat at `launch.ts:3383-3386` stays. | C2; out of scope. |
| D17 | Transport gate placement: REQUIRED flow refs refuse at the launch precondition (`resolver.ts` `firstAgentUnsupportedRequiredMcp` + `services/runs.ts:1304`), `EXECUTOR_UNAVAILABLE`, before any write; ADDITIONAL refs (flow + agent) are withheld by a third `partitionWithheldMcps` pass with reason `agent-unsupported-transport`, persisted like the other two. Pass order: `platform-untrusted` > `exec-untrusted-stdio` > `agent-unsupported-transport`. `gateAndOverlayMcpServers` gains an `adapter` argument threaded from all THREE callers (`capabilityAgent`): flow, agent, and — new — both scratch launch sites (`scratch-runs/service.ts:869/1097`, `:1561/1713`), so trust, overlay and transport apply to scratch exactly as to the other surfaces (owner, 2026-09-21). | C12; makes the documented edge case (`mcp-management.md:254`) real without a new refusal site. |
| D18 | Readiness evaluator: `evaluateMcpReadiness(row, { presence, adapters })` — `presence` from `HostAdminClient.checkEnvRefs(names)` (names = env-ref names across `env`, `headers`, `bearerTokenEnv`; literals contribute nothing), `adapters` from `diagnostics()` (unchanged adapter gate). Either host read failing → `Unknown` (today's behavior for a dead host). The reads happen BEFORE the DB write; they are reads, not side effects — the write proceeds with `Unknown`. `GET /diagnostics.envRefs` is untouched (runner readiness). `HostAdminClient.checkEnvRefs(names)` accepts ANY number of names: the local-direct transport dedupes, chunks by the route cap of 64 (D22) and merges the answers in request order; the fake refuses more than 64 per call exactly like the real route (patch 2026-09-15-23.35: a lenient double is a defect). **Scope (owner, 2026-09-21): write-time cache everywhere** — platform rows in `readiness_status/readiness_reasons` (as today), project rows in `material.readiness` on `createProjectMcp`/`updateProjectMcp`, package rows in `material.readiness` at `attachPackage`/`upgradeAttachment` ingestion (host reads before the transaction); `composeProjectMcpHub` reads `material.readiness` for non-platform entries. | D3, D7; C4. |
| D19 | Readiness reasons are rendered: `mcps/page.tsx` selects `readiness_reasons`; the platform panel shows them as a tooltip on the status chip (the runner panel pattern `acp-runners-panel.tsx:68-69`). | C4 — a presence check whose reason is invisible is not actionable. |
| D20 | `description` lands on `platform_mcp_servers` (column) AND on project material (`ProjectMcpMaterial.description?`); package templates already carry it. UI field order per design §9 on both modals. | Design §4/§9 lists it for both surfaces. |
| D21 | ONE migration, `0172_mcp_env_values`: add `env`/`headers` (`jsonb NOT NULL DEFAULT '{}'`), `bearer_token_env text`, `description text`; backfill both maps with the prefix stripped (C9); rewrite `capability_records.material` for `kind='mcp'` from all three shapes (C10) to `env`/`headers` maps (requirement rows: keys with `env:NAME` values; template rows: values untouched); `DROP COLUMN env_keys, header_keys`. Backfill is SQL-derivable → no abort guard. Overlay rows are not rewritten (keys unchanged; a stored `{GITHUB_TOKEN: "env:PROJ_A_GH"}` now MEANS what the operator meant). Every statement self-contained: the drizzle migrator applies the file inside one transaction, the replay helper applies it statement-by-statement — both paths must succeed. Pre-deploy in-flight runs are safe: resume/recover re-materialize from the catalog (`runner-graph.ts:3504` passes `materialized?.mcpServers`) and the command ledger stores only `mcpServerCount` (`redact.ts:70`), so no old-shape payload is ever replayed (verified 2026-09-21). | Skill-context "preserve live data or refuse loudly"; design §7. |
| D22 | `POST /diagnostics/env-refs` — body `{ names: string[] }` (1..64 after dedupe, each `^[A-Za-z_][A-Za-z0-9_]*$`), response `{ refs: [{ name, present }] }` in request order, `present = Boolean(process.env[name])` (empty string = absent, consistent with `diagnosticEnvRefs()` at `http-api.ts:335-348`), malformed → 409 `PRECONDITION` (C6). Unauthenticated, same posture as `GET /diagnostics` (ADR-166 `adr-166.md:23-25`, `:270-271`). The route is a **presence oracle for host env names**; ADR-179 records it as an accepted exposure bounded by count + regex, closed by Stage D host auth. | D7; skill-context "identifiers" rule — `names[]` is body-controlled, allow-listed by regex, names no cross-resource locator. |
| D23 | `bearerTokenEnv` set AND an `Authorization` header row (case-insensitive) → `CONFIG` at web validation and `PRECONDITION` 409 at the supervisor schema (belt and braces; both cheap). | Design §3, one source of truth for the header. |
| D24 | Secret guard is UI-only (D9): `KeyValueRows` accepts `warningFor(row)`; consumers feed it `secretShapedKey`. Routes accept the value; a test asserts they do. | D9. |
| D32 | Overlay values (`envRemap`/`headerRemap`) use the same grammar as server values: `literal \| env:NAME` (design §11, owner 2026-09-21). One validator (`value-grammar.ts`), unchanged wire; existing overlay rows stay valid. | One grammar for web, supervisor, manifest and overlay (design §3). |
| D25 | Shared component at `web/components/settings/key-value-rows.tsx` (origin-adjacent to the runner modal it is extracted from), labels passed as props (the `McpSelect` / `McpTemplateEditor` pattern — no `useTranslations` inside), helpers `rowsFromRecord` / `recordFromRows` exported and imported by the runner modal so its behavior is byte-identical (`acp-runner-modal.test.ts:58-118` unchanged). | D11; testable with SSR + jsdom. |
| D26 | Test doubles: `stub-supervisor.ts` and `test-supervisor.ts` gain `POST /diagnostics/env-refs` answering `present:false` for every name except a small fixture allow-list (deterministic); `fake-execution-host.ts` gains `checkEnvRefs` scripted + recorded like `diagnostics`. | C13; the e2e lane boots `next dev` against the stub. |
| D27 | Package manifest (`packageManifestMcpSchema`): `env` = `string[]` of `env:NAME` (legacy, normalized at load to `{NAME: "env:NAME"}`) OR `Record<string, value>`; new `headers?: Record`, `bearerTokenEnv?: env:NAME` (http only); `PACKAGE_ENV_REF` replaced by the shared grammar (names become case-insensitive — a relaxation, recorded); no `schemaVersion` bump; `sse` stays absent from templates. | D4. |
| D28 | Studio prefill from a platform server copies `env:NAME` references as-is and converts a platform LITERAL value to a reference: env key `K` → `env:K`; header `H` → `env:` + `H` uppercased with every non-`[A-Za-z0-9_]` character replaced by `_` and a leading digit prefixed by `_` (`X-Api-Key` → `env:X_API_KEY`) — a literal never lands in a package template and the generated name always satisfies `ENV_NAME_RE`. | Packages are shareable; `flowEditor.artifacts.mcp.prefillHint` already promises "only env-var references are written". |
| D29 | `WithheldMcp.reason` union (`web/lib/db/schema.ts:1648-1653`) gains `"agent-unsupported-transport"` (jsonb-only, no migration); i18n `withheldReason.agentUnsupportedTransport`; `docs/db/runs-domain.md:173,749` enumerations extended. | D17 fan-out. |
| D30 | `sse` remains creatable on both modals, labelled `sse (legacy)`; docs state it is deprecated by MCP 2025-03-26 and absent from ACP v2. | Design §8. |
| D33 | Commit sequencing across the two processes: the supervisor commit is ADDITIVE (maps, `bearerTokenEnv`, resolver, env-refs) and keeps mapping `envKeys`/`headerKeys` for that ONE intermediate commit; their strict removal lands in the same commit as the web wire switch. D12 (no legacy acceptance) holds at the branch tip and at deploy; every commit stays green and bisectable. | No real-supervisor suite sends catalog MCP servers today (verified), but a cut-over window between commits is still an unexplained red for `git bisect`. |
| D34 | `loadMaisterPackageManifest` returns a `NormalizedPackageManifest` whose `mcps[].env` is always `Record<string, value>` (legacy list folded at load); `attach.ts` and Studio see ONE shape. The zod schema keeps the union; the normalizer is the only place that knows both. | DRY — one reader per shape; no `.transform` so the zod output type stays honest. |
| D31 | `maister.yaml capabilities.mcps[].env/headers` values are carried as-is under the shared grammar (`catalog.ts:68-70 redactedEnv` retired); the YAML is the operator's host file, same trust level as `supervisor/.env`. Owner, 2026-09-21. Exposure stated in `configuration.md`: a literal YAML value is returned by `GET /api/projects/{slug}/mcp` to every user who passes `authorizeCatalogRouteProject` (catalog read) — the D1 declaration applies. | C10; defect 2 otherwise survives on the YAML path. |

### Reserved numbers (allocate now — skill-context rule)

- **ADR-179** — next free at `master` HEAD (`### ADR-176` is the highest in `docs/decisions.md:1781`; `docs/decisions/adr-176.md` exists). Record `docs/decisions/adr-179.md` + stub + index row, header first.
- **Migration 0172** — `_journal.json` max idx is 171 (`0171_crash_recover_continuation_retry`, `when 1789943168941`); the newest snapshot `meta/0171_snapshot.json` exists. Tag `0172_mcp_env_values`; the snapshot `meta/0172_snapshot.json` is the fourth leg with `schema.ts`.
- No parallel branch allocates either number today (`git branch --list` reviewed 2026-09-21); a renumber pass is budgeted in Phase 6 anyway.

### Deployment touchpoints (skill-context rule — explicit negative)

- No new env var, port, sidecar, config file or bind mount. `MAISTER_DIAGNOSTIC_ENV_REFS` is unchanged and unrelated to the new route.
- Prose only: `supervisor/.env.sample:106-113` ("the supervisor resolves the VALUE here, by NAME … stdio env var / header value") is rewritten for literal values + `bearerTokenEnv`; `.env.example:235-240` stays.
- Compose files untouched; `docs/configuration.md:125-127` keeps "no new web environment variable".

### Contract surfaces (skill-context rule)

| Surface | Change | Spec file(s) |
|---|---|---|
| Supervisor `POST /sessions` body `mcpServers[]` | `env`/`headers` maps + `bearerTokenEnv`; `envKeys`/`headerKeys` removed (strict) | `docs/api/supervisor.openapi.yaml` — NEW `McpServerInput` component (with `example`) + `StartSessionRequest.mcpServers` (C7); `docs/supervisor.md` |
| Supervisor `POST /mcp-probe` body | same field set | `supervisor.openapi.yaml:1350-1385`; `docs/supervisor.md` |
| Supervisor `POST /diagnostics/env-refs` (new) | request/response/409 | `supervisor.openapi.yaml` new path; `docs/supervisor.md:278-360` new section; `docs/system-analytics/execution-hosts.md:124-125` admin surface |
| Web `/api/admin/mcp-servers` (+`/{id}`) | body + response fields; `readinessReasons` selected | `docs/api/web.openapi.yaml:13044-13286`, schemas `PlatformMcpServer :22007`, `PlatformMcpServerBody :22068`, `McpTransport :21421` (sse legacy note) |
| Web `/api/projects/{slug}/mcp` (+`/{mcpId}`) | body + response fields | `web.openapi.yaml:13338-13425`, `ProjectMcpServer :22121`, `ProjectMcpServerBody :22164` |
| Web bindings overlay | `McpConfigOverlay` value semantics (+`bearerTokenEnv`) | `web.openapi.yaml` `McpConfigOverlay :22237`; `/bindings` paths `:13627-13675` descriptions |
| DB `platform_mcp_servers` | +`env`, +`headers`, +`bearer_token_env`, +`description`, −`env_keys`, −`header_keys` | migration triple 0172 + `schema.ts:333-350`; `docs/database-schema.md:378-423`; `docs/db/projects-domain.md:62-96,220,264-271` (hand ERD); `docs/db/erd.dbml` regenerated (`db:erd`) |
| DB `capability_records.material` (`kind='mcp'`) | one map shape for all sources | `docs/database-schema.md` material description; `docs/system-analytics/mcp-management.md:60` |
| DB `runs.withheld_mcps` reason union | +`agent-unsupported-transport` (jsonb-only) | `docs/db/runs-domain.md:173,749`; `docs/database-schema.md:1505` |
| Error taxonomy | no new code; `EXECUTOR_UNAVAILABLE` gains the transport reason (Designed → Implemented); `CONFIG` rows for malformed `env:` and bearer/Authorization conflict; the raw-secret refusal row is removed | `docs/error-taxonomy.md:51-52,262-264`; `mcp-management.md:242-261` |
| Package manifest `mcps[]` | `env` map \| legacy list, `headers`, `bearerTokenEnv` | `web/lib/config.schema.ts:1504-1560`; `docs/configuration.md:405-430`; `docs/flow-dsl.md:285-306`; `docs/system-analytics/packages.md:61` |
| In-code SSOT shipped to agents | **checked, unchanged**: `web/lib/flows/flow-dsl-grammar.ts` mentions MCPs only as node refs (`:99,103`); its `:192` env sentence is about RUNNER env (out of scope, see Follow-up) | `web/lib/flows/__tests__/flow-dsl-grammar.test.ts` — no edit |
| Screens | field order, rows component, readiness reasons, bearer field | `docs/screens/mcps.md:33-78`, `docs/screens/projects/project-mcps-hub.md:44-92`, `docs/screens/settings-acp-runners.md` (shared rows) |
| Public docs | overlay = value replace, literals, bearer, sse legacy | `site-docs/administration/mcp-and-secrets.md:30-50`, `site-docs/ru/administration/mcp-and-secrets.md:28-46` |
| Analytics | see Phase 0 | `mcp-management.md` (rewrite), `capabilities.md:368,438` (wording only, no new bullet), `acp-runners.md:456-459` (mirror note), `execution-hosts.md:124-125` |
| SSE / AsyncAPI | none | — |

### Identifiers (skill-context rule — body-controlled cross-resource ids)

- `POST /diagnostics/env-refs`: `names[]` — `body-controlled`; allow-listed by `^[A-Za-z_][A-Za-z0-9_]*$`, capped at 64, deduped; it names no run/session/path. Nothing else in the body.
- `POST/PATCH /api/admin/mcp-servers[/{id}]`: `{id}` — `url-param`; `env`/`headers`/`bearerTokenEnv` — `body-controlled`, grammar-validated (D14), never used as a path or lookup; readiness — `server-state` (derived from host reads).
- `POST/PATCH /api/projects/{slug}/mcp/bindings[/{refId}]`: `slug`, `refId` — `url-param`; `envRemap`/`headerRemap` KEYS — `body-controlled`, compared against the `server-state` slot set (target's `env`/`headers` keys) at write AND materialization (unchanged rule, new source); values — the shared grammar (D32).
- Data class of the read responses (skill-context authorization rule): `env`/`headers` VALUES are either names (`env:NAME`) or operator-declared non-secrets (D1/D31); the existing gates stay — `requireGlobalRole("admin")` for `/api/admin/mcp-servers*`, `authorizeCatalogRouteProject` for `/api/projects/{slug}/mcp*`. No response exposes a resolved host value; `bearerTokenEnv` is a name.

### Side-effect ordering for the readiness writes (skill-context two-phase rule)

Platform POST/PATCH, project create/update, and package attach/upgrade ingestion (D18): `diagnostics()` + `checkEnvRefs(names)` are host READS issued before the transaction; failure classes: host unreachable / timeout / 5xx / 409 → readiness `Unknown` + one WARN log with the host cause code, the write commits, the route returns 2xx. There is no idempotency marker because there is no side effect. The probe route (`probeAndCache`) is unchanged.

---

## Design details the implementer follows

### Value grammar (D14) — one table

| Value | Class | Web | Supervisor | Resolution |
|---|---|---|---|---|
| does not start with `env:` | literal | accepted; UI warns under a secret-shaped key | accepted | passed verbatim, never interpolated (`${X}` reaches the server unchanged) |
| `env:NAME` matching `^env:[A-Za-z_][A-Za-z0-9_]*$` | env-ref | accepted | accepted | `process.env.NAME ?? ""` |
| starts with `env:`, fails the regex | malformed | `CONFIG` 422, field `env.<key>` / `headers.<name>` / `bearerTokenEnv` | 409 `PRECONDITION` | never reaches resolution |
| `bearerTokenEnv` | env-ref only | `CONFIG` unless `env:NAME`; `CONFIG` with an `Authorization` header row (D23) | same (409) | `Authorization: Bearer ` + `(process.env.NAME ?? "")`, appended LAST |
| literal header value containing CR, LF or another control character | invalid field-value | `CONFIG` 422, field `headers.<name>` | 409 `PRECONDITION` | never reaches resolution (an env-ref VALUE is not checked at write; an invalid resolved value fails the request on the host, which readiness cannot predict) |

Keys: env names `^[A-Za-z_][A-Za-z0-9_]*$`; header names RFC 7230 token `^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$`. Secret-shaped: env key with a `_`-delimited segment ∈ {`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `PRIVATE_KEY`, `ACCESS_KEY`} (`TOKENIZER_MODE` is not; `MY_TOKEN_2` is), or header name ∈ {`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `X-Auth-Token`}, both case-insensitive — a warning only when the VALUE is a literal.

### Supervisor resolution (`supervisor/src/mcp-values.ts`)

`resolveMcpValue(value)`, `resolveMcpMap(map) → Record`, `resolveMcpEnvVariables(map) → EnvVariable[]` (stdio, untagged object — T4), `resolveMcpHeaders(headers, bearerTokenEnv) → HttpHeader[]` (ACP), `resolveMcpHeaderRecord(headers, bearerTokenEnv) → Record` (probe). Used at `acp-client.ts:951-983` and `mcp-probe.ts:46-84`. No logging inside; `POST /sessions` adds `mcpServerCount` to its existing scalar log line; `/mcp-probe` keeps `{transport, ok, latencyMs}`.

### Overlay application (`applyMcpOverlays`, `materialization-gate.ts:119-159`)

For each overlay key present in the server's `env`/`headers`: replace the VALUE, keep the KEY. `bearerTokenEnv` in an overlay replaces the server's `bearerTokenEnv` (http/sse targets only — validated at write and materialization). `argsOverride`/`urlOverride` unchanged. Defensive re-validation stays (`assertOverlayAgainstSlots` with slots = map keys).

### Transport gate (D17)

`mcpTransportsForAdapter(adapter)` accessor in `adapter-support.ts`; codex → `["stdio","http"]`; the other four keep their lists with a `// unverified against the adapter binary` comment. `partitionWithheldMcps({ …, adapter })` third pass. `firstAgentUnsupportedRequiredMcp(required, rows, agent, bindings)` — rows gain `material.transport`; a winner whose transport ∉ `mcpTransportsForAdapter(agent)` is returned as the offending ref; the thrown message names the ref, the transport and the agent.

### Migration 0172 (D21) — statement order

1. `ALTER TABLE platform_mcp_servers ADD COLUMN env jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN headers jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN bearer_token_env text, ADD COLUMN description text;`
2. `UPDATE platform_mcp_servers p SET env = COALESCE((SELECT jsonb_object_agg(regexp_replace(k, '^env:', ''), 'env:' || regexp_replace(k, '^env:', '')) FROM jsonb_array_elements_text(p.env_keys) AS k), '{}'::jsonb), headers = COALESCE((… p.header_keys …), '{}'::jsonb);`
3. `UPDATE capability_records SET material = <rewrite> WHERE kind = 'mcp' AND (material ? 'envKeys' OR material ? 'headerKeys');` — `env` = map from `envKeys` when present else existing `material->'env'` else `{}`; `headers` likewise; `- 'envKeys' - 'headerKeys'`.
4. `ALTER TABLE platform_mcp_servers DROP COLUMN env_keys, DROP COLUMN header_keys;`
Then `schema.ts`, `_journal.json` (idx 172, `when` > 1789943168941), `meta/0172_snapshot.json`; `pnpm --filter maister-web db:generate` must report "No schema changes"; `db:erd` regenerates `docs/db/erd.dbml`.

### `KeyValueRows` (D25)

```
type KeyValueRow = { id: string; key: string; value: string };
props: rows, onChange(rows), labels { title, hint?, key, value, add, remove },
       keySuggestions?: readonly string[] (datalist), warningFor?(row) → string | null (inline, non-blocking),
       errorFor?(row) → string | null (inline), disabled?, testId?
exports: rowsFromRecord(record?) → KeyValueRow[]; recordFromRows(rows) → Record | undefined
```
Consumers: `acp-runner-modal.tsx` (env), `mcp-server-modal.tsx` (env or headers by transport), `board/panels/mcp-modal.tsx` (same), `mcp-bind-dialogs.tsx` `remapEditor` (slot datalist from the target's map keys), `mcp-template-editor.tsx` (env + headers of the template).

### Acceptance criteria ↔ evidence (SDD traceability)

Every row names the normative text that states it, the RED test that proves it, and the falsification (Task 28) that shows the test can fail. A row without all three is not done.

| AC | Requirement | Normative text | RED evidence | Falsified by |
|---|---|---|---|---|
| AC-01 | A literal env value reaches the child process verbatim, `${X}` included; an `env:NAME` value resolves from the supervisor environment; unset → `""` | `mcp-management.md` Expectation #5 (merged); `configuration.md` grammar table | `mcp-values.test.ts`; `mcp-forwarding` env-map case | 28(c) |
| AC-02 | A value starting with `env:` that fails the regex is refused with `CONFIG` 422 (field path) on the web and 409 on the supervisor | Edge-case rows (Task 2) | `value-grammar.test.ts` (table); ONE wiring case each in `mcp-form.test.ts`, `types.test.ts`, the route suite | — (schema-level; covered by the table) |
| AC-03 | `bearerTokenEnv` composes `Authorization: Bearer <value>` LAST on both header shapes; with an `Authorization` row it is refused on both sides | D23; `supervisor.md` MCP paragraph | `mcp-values.test.ts`; `types.test.ts`; `mcp-forwarding` http case; `mcp-server-modal.dom.test.ts` | 28(c) |
| AC-04 | A literal header value with CR/LF/control characters is refused at write | Grammar row (above) | `value-grammar.test.ts`; `types.test.ts` | — |
| AC-05 | Overlay application replaces VALUES for declared keys and preserves KEYS; a literal overlay value is accepted; `bearerTokenEnv` override is http/sse-only | Expectation #4 (merged); ADR-129 amendment | `overlay-apply.test.ts` (rewritten); `binding-overlay`, `binding-schemas`, `binding-service` cases | 28(a) |
| AC-06 | No resolved host value and no literal sentinel appears in `execution_commands.payload`, `runs.withheld_mcps`, `node_attempts.materialization_plan`, or any HTTP response | Expectation #5; E-EH-12 | `overlay-secret-invariant.integration.test.ts` (extended) | — (invariant sentinel) |
| AC-07 | Readiness reads presence from `POST /diagnostics/env-refs`; a literal never produces a reason; any host failure yields `Unknown` and one WARN; reasons are rendered | Readiness flow (Task 2); D18/D19 | `readiness.test.ts`; `admin-mcp-crud` cases; `mcp-servers-panel.test.ts` | 28(f) |
| AC-08 | Project rows cache readiness on create/update; package rows at attach/upgrade; the hub shows both; CLEAR through upgrade flips a stale `NotReady` | D18 scope | Task 15/21 integration cases | — |
| AC-09 | `POST /diagnostics/env-refs`: request order after dedupe, 64 accepted / 65 refused / 0 refused, no value in the body; the fake and the real host agree | D22; `supervisor.md` section | Task 7 cases; parity case (Task 15) | — |
| AC-10 | Migration 0172 backfills both key spellings, unifies the three material shapes, drops the columns, leaves overlay rows untouched | D21 | `migration-0172-mcp-env-values.integration.test.ts` | 28(d) |
| AC-11 | codex + `sse` is withheld `agent-unsupported-transport` and persisted; claude + `sse` is kept; `platform-untrusted` wins for the same server | D17; Expectation #8 (merged) | `materialization-gate.test.ts`; `trust-gate.integration.test.ts` | 28(b) |
| AC-12 | A REQUIRED `sse` ref on a codex runner refuses launch `EXECUTOR_UNAVAILABLE` 503 before any write | D17; `error-taxonomy.md:262-264` | `required-mcp-agent-support.test.ts`; `services/runs` precondition case | 28(e) |
| AC-13 | Scratch launches pass the same gate (transport, trust, overlay); the assistant launch is a proven non-path | D17 (owner) | Task 19 scratch cases | — |
| AC-14 | Manifest `env` accepts the legacy list and the map identically; `headers` and `bearerTokenEnv` land in material; a literal is accepted; lowercase names are accepted | D27/D34; `configuration.md:405-430` | `manifest.test.ts`; `attach.integration.test.ts` | — |
| AC-15 | Studio prefill never writes a literal; header names are sanitized into valid env names | D28 | `mcp-template-editor.dom.test.ts` | — |
| AC-16 | `KeyValueRows` flags duplicate keys and empty-key rows, allows an empty literal, drops empty rows; the runner modal's assertions are byte-identical | D25 | `key-value-rows.dom.test.ts`; `acp-runner-modal.test.ts` unchanged | — |
| AC-17 | EN/RU key parity holds and every retired key is gone from both catalogs and every consumer | `docs/screens/*` i18n sections | `i18n-parity.test.ts`; `i18n-settings-keys.test.ts` | — |
| AC-18 | Docs gates green; no touched doc claims "names only"; ADR-179 status equal in record, stub and index | `docs/CLAUDE.md` R4/R6 | `pnpm validate:docs:all` (Task 30) | — |

### Test overlap budget (minimum overlap, no trivial tests)

- The grammar TABLE (env names, header tokens, header field-values, value classes, secret-shaped keys) is asserted ONCE, in `value-grammar.test.ts`. Every other suite that touches validation asserts WIRING with exactly one malformed case per surface (`mcp-form.test.ts`, `types.test.ts`, one route case, one dom case).
- The backfill is asserted ONCE (the replay test); `check-migrations` and `migration-journal-integrity` are lineage/snapshot guards, not backfill tests.
- `POST /diagnostics/env-refs` behaviour is asserted in the supervisor suite; the web side asserts only the client contract (chunking, merge order) and the parity case — no re-test of the route's 409s from the web.
- Component suites assert behaviour (a callback fired, a body shaped, a warning shown), never "renders without crashing" or a snapshot of markup.
- Migrated assertions replace their predecessors; a case kept "for coverage" whose predicate is now unreachable is deleted and named obsolete in the commit body.

### Refactor ledger (RED → GREEN → REFACTOR — delete, do not leave dead)

After each GREEN, the refactor step removes what the change orphaned; the orphan check is `git grep` for each symbol → 0 outside history docs:
`refsToMap` (`projection.ts:31-43`) · `stripEnvPrefix` (`projection.ts:24`, if no reader remains) · `bareName` (`materialization-gate.ts:109-111`) · `bare()` (`probe-service.ts`) · `resolveNames` (`supervisor/src/mcp-probe.ts:46-58`) · `envKeysOf` / `headerKeysOf` (`agent-map.ts:99-106`) · `redactedEnv` (`catalog.ts:68-70`) · the four `envKeyRefSchema` copies (C8) · `PACKAGE_ENV_REF` (`config.schema.ts:1502`) · `remapEditor` (`mcp-bind-dialogs.tsx:356-422`) · the runner modal's inline row JSX and `envRowsFrom`/`envFromRows` (moved, not duplicated) · the `McpProbeRequestSchema` copy in `http-api.ts:133-158` · `ENV_KEY_RE` (`mcp-form.ts:35`) · i18n `fieldEnvKeys`/`fieldHeaderKeys`/`secretRefHint` (both catalogs).

---

## ⚠ Traps (carry into every phase)

- **T1** `pnpm lint` is `eslint --fix` in both packages — it rewrites files; check `git status` before staging (memory `pnpm-lint-mutates-the-tree`).
- **T2** A module-scope call into a partially mocked module fails whole files as SKIPS (memory) — `value-grammar.ts` and `mcp-values.ts` must be pure at import.
- **T3** Two stored key spellings (C9): every backfill/rewrite strips `^env:` on both key and value derivation; the replay test seeds both.
- **T4** `claude-agent-acp` drops explicit `type:"stdio"` (C11) — stdio ACP entries stay untagged; the recording mock adapter asserts the shape.
- **T5** R5a: `mcp-management.md` Expectations are at 12 — MERGE, never append; `capabilities.md` (13) and `acp-runners.md` (19) are over the cap already — edit wording only, no new bullets.
- **T6** ESLint fence (C13): every new wire type crosses through `web/lib/execution-host/index.ts`; `probe-service.ts` imports from `@/lib/execution-host`, never `@/lib/supervisor-client`.
- **T7** Integration lane load sensitivity (memory): classify a red by re-running the file idle; compare failure SETS to the `web/CLAUDE.md:257-473` baselines; wait for the late summary flush.
- **T8** The overlay-grammar tests (`binding-overlay.test.ts:49`, `binding-schemas.test.ts:51`) FLIP (D32): "rejects a non-env: value" becomes "accepts a literal; rejects a malformed `env:` value" — classify them obsolete, not broken.
- **T9** `redact.ts:70` must keep reducing `mcpServers` to a count; the secret-invariant integration test gains a LITERAL sentinel and asserts it is absent from `execution_commands.payload`, `runs.withheld_mcps`, `node_attempts.materialization_plan` and every HTTP response body.
- **T10** `POST /diagnostics/env-refs` answers in REQUEST order after dedupe (not `localeCompare` like `diagnosticEnvRefs()`); the web evaluator must not depend on order.
- **T11** Migration triple: hand-written SQL + `schema.ts` + journal + snapshot must agree — `db:generate` "No schema changes" is the gate; prefer number-agnostic prose (`pre-ADR-179`) in long-lived comments.
- **T12** A catalog server named `maister` would be duplicated on the wire (C2) — not fixed here; do not name test fixtures `maister`. The flow path has the same concat at `runner-graph.ts:3383-3396` (generated entry appended to `materialized.mcpServers`); same rule.
- **T13** The e2e lane's stub supervisor must answer env-refs or every platform save logs a WARN and stores `Unknown`; the specs assert no readiness value, so a missing route would pass silently — add the route anyway (D26) and assert it is hit.
- **T14** `openapi-examples.test.ts` only validates components with an `example` (C7) — give `McpServerInput` and `EnvRefsRequest/Response` examples.
- **T15** Boundaries are tested strictly inside AND strictly outside (patch 2026-09-15-23.35): 64 names accepted, 65 refused, 0 refused; a test that picks the one satisfiable value proves nothing.
- **T16** A requirement's scope word comes from the seam, not the plan (patch 2026-09-17-09.57): "every launch surface" is written from the count of `gateAndOverlayMcpServers` call sites after Task 19 (three: `runner-graph.ts:2076`, `launch.ts:2664`, `scratch-runs/service.ts:869`), and the assistant launch (`service.ts:1561`) is named as a non-path with its own test.

---

## Commit Plan

One commit per design item (§12), no co-author trailer.

| Commit | After tasks | Message |
|---|---|---|
| 0 | — (already in the tree) | `docs(plans): MCP configurator env-model design + README row` |
| 1 | 1–4 | `docs(mcp): ADR-179 — value maps, bearer field, value-replacing overlays, env-ref readiness, transport gate; analytics/API/DB contracts` |
| 2 | 5–8 | `feat(supervisor): MCP value maps, Authorization bearer composition, POST /diagnostics/env-refs` — ADDITIVE: `envKeys`/`headerKeys` still mapped in this one commit (D33) |
| 3 | 9–16 | `feat(mcp): value model — migration 0172, one grammar, value-replacing overlays, host env-ref readiness, probe maps; supervisor drops envKeys/headerKeys` — the migration cannot stand alone: dropping `envKeys` from `schema.ts` breaks typecheck across the model, so item 3 is one commit (scratch sub-commit excluded) |
| 4 | 17–19 | `fix(mcp): adapter transport gate — codex withholds sse, required refs refuse launch (D6)` (+ the scratch sub-commit of Task 19) |
| 5 | 20–22 | `feat(packages): mcps[] env map, headers, bearerTokenEnv; Studio template editor writes maps` |
| 6 | 23–27 | `feat(ui): shared KeyValueRows; MCP modals, overlay dialog and readiness reasons on the value model (EN/RU)` |
| 7 | 28–31 | `docs(mcp): truth pass — ADR-179 Implemented, surfaces re-derived from the diff, README row` |

Cut-over window (D33): between commits 2 and 3 the supervisor accepts BOTH the old names and the maps; after commit 3 only the maps. The web never sends both. Every commit's gate (`typecheck`, unit, integration in both packages) is green.

---

## Tasks

**Logging contract (applies to every task; per-task lines add specifics).** Web routes/services log through the existing pino `log` with key NAMES and counts at DEBUG, host fallbacks at WARN with the host cause code, never a resolved value, never a map; the supervisor logs scalars only (`http-api.ts` convention) and never `mcpServers` material; UI code emits no `console.*`; docs and test-only tasks have no logging deliverable. `LOG_LEVEL` governs both processes (`supervisor/src/main.ts:63-69`).

### Phase 0 — SDD: freeze the contracts before any code

Exit criteria: every artifact below complete and internally consistent; `pnpm validate:docs` and `pnpm validate:docs:adr` green; ADR-179 record + stub + index row exist at HEAD; ADR-070 and ADR-129 carry their amendments; R5a bullet counts recorded (12 / 13 / 19, none increased); no touched doc still says "names only" / "NAMES" about MCP env or headers.

- [x] **Task 1 — ADR-179 + amendments to ADR-070 and ADR-129.** Three artifacts per `docs/CLAUDE.md` R4: `docs/decisions/adr-179.md` from the template, the stub in `docs/decisions.md` (heading + Status + Date + link), the index-table row — header first so nothing cites a missing anchor.
  **Title:** *MCP configuration values — literal-or-reference env/header maps, a bearer token field, value-replacing project overlays, host env-ref readiness, and an adapter transport gate.*
  **Decision text covers:** the value grammar table (D14 — cite, do not restate, `configuration.md`); D1–D12 by reference to the design doc; the collapse of `envKeys`+`env` into one map (C1); overlay = value replace, keys preserved, values under the same grammar (D32); readiness = host-scoped presence via `POST /diagnostics/env-refs` with write-time caches on all three row kinds (D18) and the presence-oracle exposure accepted under ADR-166's unauthenticated posture (D22); transport gate placement (D17) and the codex fact (C11); ONE gate for flow, agent and scratch launches (D17, C3); `maister.yaml` values carried (D31); `sse (legacy)` (D30); the OAuth direction note (D8) and the JSON-import deferral (D5) as Consequences; the required-vs-additional distinction now covering two reasons (`supported_agents` and transport).
  **ADR-070 edit (additive):** `adr-070.md:34` "Secrets accepted only as `env:NAME`" → dated `**Amendments:**` bullet naming ADR-179 (literals allowed; secret guard is a UI warning). **ADR-129 edit (additive):** `adr-129.md:59-62` (overlay rewrites NAMES) and `:63-68` (probe names only) → dated `**Amendments:**` bullet. Set `Status: Implemented; amended by ADR-179` in each record body, stub and index row (status equality is gated).
  Mark ADR-179 `Accepted`; flip to `Implemented` in Task 30.
  - Logging: n/a.
  - Verify: `pnpm validate:docs:adr` green (stub ↔ record bijection and status equality); `ls docs/decisions/adr-179.md`; `grep -c 'amended by ADR-179' docs/decisions.md` = 2.

- [x] **Task 2 — `docs/system-analytics/mcp-management.md` rewrite (R5 order, R6 tags).** Domain entities `:43-44` (platform row shape → `env`, `headers`, `bearer_token_env`, `description`), `:60` (material = one map shape for every source), `:74-84` (transport union: stdio `{command, args?, env?}` \| sse/http `{url, headers?, bearerTokenEnv?}`; the withheld-reason list at `:82-84` gains `agent-unsupported-transport`); Process flows: `:182-188` overlay → "replaces VALUES for declared keys, keys preserved, wire shape unchanged", `:190-215` probe (`{transport, maps, bearerTokenEnv}` — references unresolved on the wire, resolved on the host), `:215-226` readiness → presence via `POST /diagnostics/env-refs` + adapter gate, host-scoped, the three write-time cache sites of D18, reasons rendered (D19); the trust-gate flow `:161-178` gains scratch as a third launch surface; NEW topical section **"Value grammar, secret guard and transport gate"** (after Process flows, before Expectations) with the grammar table, the secret-shaped list, the gate pass order and the required/additional split (D17). **Expectations (at the cap — MERGE):** #4 → "overlay application MUST replace only VALUES for keys declared by the target; keys MUST be preserved"; #5 → "no secret VALUE … only references — a literal is the operator's declaration that the value is not a secret, warned in the UI under secret-shaped names"; fold "`bearerTokenEnv` and an `Authorization` header row MUST NOT coexist (`CONFIG`)" into #5's sentence family or #4 — net count stays ≤ 12; fold the transport gate into #8 ("every withhold — trust, exec-trust or adapter-unsupported transport — MUST be persisted"); fold "presence is host-scoped and values never leave the host" into the readiness sentence of #5. Every bullet names its enforcement point (zod schema, `superRefine`, `partitionWithheldMcps`, the named test). Scope words come from the seam (T16): "every launch surface" = the three gate call sites after Task 19; the assistant launch is named as a non-path (no project, no catalog MCPs). **Edge cases:** delete `:257` (raw secret → CONFIG); add "value starts with `env:` and fails the regex → `CONFIG` 422", "`bearerTokenEnv` with an `Authorization` header row → `CONFIG` 422", "`bearerTokenEnv` on a stdio server → normalized away (web) / `PRECONDITION` 409 (supervisor)", "`POST /diagnostics/env-refs` unreachable → readiness `Unknown`", and re-tag `:254` (transport) as Implemented with the reason token `agent-unsupported-transport`; NEW row "scratch launch with a server the adapter cannot use → withheld, persisted to `runs.withheld_mcps`". Linked artifacts: ADR-179, migration 0172, `mcp-values.ts`, `value-grammar.ts`.
  - Verify: bullet count ≤ 12 recorded before/after; `grep -n 'names only\|NAMES' docs/system-analytics/mcp-management.md` returns only historical/changelog lines; `pnpm validate:docs`.

- [x] **Task 3 — API contracts.** Supervisor (`docs/api/supervisor.openapi.yaml`): NEW component `McpServerInput` (`name`, `transport`, `command?`, `args?`, `env?` map, `url?`, `headers?` map, `bearerTokenEnv?`, `additionalProperties: false`, with an `example` — T14) + `StartSessionRequest.mcpServers` (`:2107-2300`); `/mcp-probe` body `:1350-1385` → the same field set minus `name`; NEW `POST /diagnostics/env-refs` (request `EnvRefsRequest {names[]}` with `maxItems: 64` + pattern, response `EnvRefsResponse {refs[{name,present}]}`, 409 for malformed; description states "presence only, values never returned"; `mcp-probe`/`diagnostics` tag). `docs/supervisor.md:278-360`: new `### POST /diagnostics/env-refs` subsection and an "MCP servers on the session wire" paragraph (resolution rules, bearer composition, logging prohibition `:358-360` extended to maps). Web (`docs/api/web.openapi.yaml`): `PlatformMcpServer`/`PlatformMcpServerBody`/`ProjectMcpServer`/`ProjectMcpServerBody` → `env`, `headers`, `bearerTokenEnv`, `description`, `readinessReasons` on the platform read shape; `McpConfigOverlay` → value semantics + `bearerTokenEnv`; `McpTransport` description notes `sse` legacy; path descriptions `:13044-13286`, `:13338-13425`, `:13627-13675`.
  - Verify: `pnpm validate:docs` (links) green; `pnpm validate:contracts` green if it lints OpenAPI (check `package.json:10`); `grep -n 'envKeys\|headerKeys' docs/api/*.yaml` → 0.

- [x] **Task 4 — DB, configuration, taxonomy, screens, public docs.** `docs/database-schema.md:378-423` (columns; material shape; `:1505` reason union), `docs/db/projects-domain.md:62-96,220,264-271` (hand ERD: `PLATFORM_MCP_SERVERS` fields), `docs/db/runs-domain.md:173,749` (+`agent-unsupported-transport`); `docs/configuration.md:102-127` (`platform_mcp_servers` block: grammar table, bearer, literal + warning; `:114-118` is the reference grammar — extend, keep the env-ref regex), `:405-430` (manifest `mcps[]`: map \| legacy list, `headers`, `bearerTokenEnv`; drop the uppercase-only rule); `supervisor/.env.sample:106-113` prose; `docs/error-taxonomy.md:262-264` → Implemented + the two `CONFIG` rows; `docs/system-analytics/capabilities.md:368,438` wording (literal allowed, no new bullet — T5); `docs/system-analytics/acp-runners.md:456-459` (the MCP mirror note: same grammar as runner `env`); `docs/system-analytics/execution-hosts.md:124-125` (+ env-refs in the admin surface); `docs/system-analytics/packages.md:61`; `docs/flow-dsl.md:285-306`; `docs/pv/package-management.md:121,129` (historical design doc — a dated one-line note pointing at ADR-179, no rewrite); `configuration.md` also states the D31 exposure (a literal YAML value is visible to every project catalog reader); screens `docs/screens/mcps.md:33-78`, `docs/screens/projects/project-mcps-hub.md:44-92`, `docs/screens/settings-acp-runners.md` (shared rows component named); `site-docs/administration/mcp-and-secrets.md:30-50` + `site-docs/ru/administration/mcp-and-secrets.md:28-46` (overlay = value replace, literals, bearer, sse legacy, EN/RU parity of meaning). All tagged `(Designed)` until Task 30 flips them.
  - Verify: `pnpm validate:docs`; `grep -rn 'env_keys\|header_keys\|envKeys\|headerKeys' docs site-docs --include='*.md' --include='*.yaml'` returns only `docs/plans/**`, `docs/decisions/adr-044.md`, `adr-096.md` (historical) and the ADR-179 record.

### Phase 1 — Supervisor (design item 2)

- [x] **Task 5 — RED: resolver + schema unit tests.** New `supervisor/src/__tests__/mcp-values.test.ts`: literal passthrough incl. a `${X}` literal (D2); `env:NAME` → `process.env.NAME`; unset → `""` (D3); `resolveMcpHeaders` appends `{name:"Authorization", value:"Bearer <v>"}` LAST and `"Bearer "` when unset; `resolveMcpHeaderRecord` mirrors it; `resolveMcpEnvVariables` returns `{name,value}[]` in map order. `supervisor/src/__tests__/types.test.ts` (no MCP coverage today, C5): `McpServerInputSchema` accepts maps + `bearerTokenEnv` on http; rejects `envKeys` and `headerKeys` with the issue path naming the key; rejects a malformed `env:` value; rejects `bearerTokenEnv` on stdio; rejects `bearerTokenEnv` + an `authorization` header (case-insensitive); rejects a header name with a space; rejects a literal header value containing `\r\n` (AC-04); rejects > 64 map entries; `McpProbeRequestSchema` shares the field set (same cases minus `name`).
  - Named failing assertions on this HEAD: `mcp-values.ts` does not exist (import failure); `McpServerInputSchema.safeParse({…, env:{…}, headers:{…}})` today accepts `headers` as an unknown key? No — `.strict()` rejects it, so the "accepts maps" case fails with `Unrecognized key(s): headers`.

- [x] **Task 6 — GREEN: `mcp-values.ts`, one field set, ACP + probe mapping.** `supervisor/src/mcp-values.ts` (pure); `supervisor/src/types.ts`: `mcpValueSchema` (alias of `runnerEnvValueSchema` `:37-48`), `mcpEnvNameSchema`, `mcpHeaderNameSchema`, `mcpHeaderValueSchema`, a shared `mcpServerFields` object → `McpServerInputSchema` (`:200-226`, ADD `headers` + `bearerTokenEnv`, superRefine for bearer rules; `envKeys`/`headerKeys` STAY accepted and mapped in this commit — D33 — their removal is Task 13) and `McpProbeRequestSchema` (moved from `http-api.ts:133-158`, derived from the same fields); `acp-client.ts:951-983` build via the resolver (stdio untagged — T4); `mcp-probe.ts:46-84` via `resolveMcpMap`/`resolveMcpHeaderRecord` (delete `resolveNames`); `http-api.ts` imports the probe schema. Type exports `:835` follow.
  - Logging: `POST /sessions` scalar line (`http-api.ts:2247-2261`) gains `mcpServerCount`; nothing else. Never key names in the probe log.
  - Verify: Task 5 green; `pnpm -C supervisor typecheck`; `grep -n 'envKeys\|headerKeys' supervisor/src/*.ts` → 0 outside `__tests__` (which Task 8 migrates).

- [x] **Task 7 — `POST /diagnostics/env-refs` (RED then GREEN).** RED in `supervisor/src/__tests__/lifecycle.integration.test.ts` beside the `/diagnostics` case (`:322-413`) or a new `env-refs.integration.test.ts` booted with `bootHost`: 200 with `{refs:[{name,present}]}` in request order after dedupe (set `MCP_PRESENT_SENTINEL=value-1` → present true; unset → false; empty string → false); the serialized response body does not contain `value-1`; 64 names accepted and 65 refused (T15), 409 `PRECONDITION` on an empty list and on `"BAD NAME"`; the route ignores `MAISTER_DIAGNOSTIC_ENV_REFS`. GREEN in `http-api.ts` next to `:1847` reusing `DIAGNOSTIC_ENV_NAME_RE` (`:173`); `EnvRefsRequestSchema` / `EnvRefsResponseSchema` in `types.ts` (strict; `example` in the OpenAPI — T14).
  - Logging: one INFO `{ count }` per call — no names.
  - Verify: the integration case green; `curl -s -XPOST localhost:7777/diagnostics/env-refs -d '{"names":["PATH"]}'` documented in `docs/supervisor.md` returns `present:true` on a dev host.

- [x] **Task 8 — Migrate the supervisor wire tests.** `supervisor/src/__tests__/mcp-forwarding.integration.test.ts` (recording adapter `supervisor/test/fixtures/mock-acp-record-newsession.mjs`): `:97` → "env map: `env:TEST_MCP_TOKEN` resolves from `process.env`, a literal passes verbatim, `${X}` stays literal" (subsumes `:131`, which is now the same map — mark the old literal-precedence case obsolete); `:167` → "http: headers resolved + composed `Authorization: Bearer tok-123` LAST"; NEW "sse is forwarded as `type:"sse"` for claude" (the gate is web-side; the supervisor forwards); (the "`envKeys` refused 409" case belongs to Task 13, with the strict removal). `mcp-probe.test.ts:86-113` gains header-record + bearer assertions. `openapi-examples.test.ts` — assert the new components are present in the example set.
  - Verify: `pnpm -C supervisor test` green (unit + integration), `pnpm -C supervisor lint` (T1), typecheck.

### Phase 2 — Web model (design item 3)

- [x] **Task 9 — RED: migration replay + backfill.** New `web/lib/db/__tests__/migration-0172-mcp-env-values.integration.test.ts`: `startMainPostgresTestDbUpTo(…, "0171_crash_recover_continuation_retry")`; seed a platform row with `env_keys = ["env:GITHUB_TOKEN","GH_HOST"]` and `header_keys = ["env:MCP_AUTH"]`, a second row with empty arrays, four `capability_records` (`kind='mcp'`) in the three legacy material shapes + one package template with `env: {A: "env:A"}`, and one `project_mcp_bindings` row with `config_overlay = {envRemap:{GITHUB_TOKEN:"env:PROJ_A_GH"}}`; `applyMainMigration("0172_mcp_env_values")`; assert `env = {GITHUB_TOKEN:"env:GITHUB_TOKEN", GH_HOST:"env:GH_HOST"}`, `headers = {MCP_AUTH:"env:MCP_AUTH"}`, empty arrays → `{}`, `bearer_token_env` and `description` NULL, `env_keys`/`header_keys` absent from `information_schema.columns`, every material row now has `env`/`headers` maps and no `envKeys`/`headerKeys`, the template's values untouched, the overlay row byte-identical. Also assert `check-migrations.integration.test.ts` (full lineage) and `migration-journal-integrity.test.ts` stay green after Task 10.
  - Named failing assertion on this HEAD: `applyMainMigration("0172_mcp_env_values")` throws ENOENT.

- [x] **Task 10 — GREEN: the migration triple + schema.** `web/lib/db/migrations/0172_mcp_env_values.sql` (statement order per Design details), `meta/_journal.json` entry (idx 172, `when` > 1789943168941), `meta/0172_snapshot.json`, `web/lib/db/schema.ts:333-350` (`env`, `headers`, `bearerTokenEnv`, `description`; delete `envKeys`/`headerKeys`), `McpConfigOverlay` comment `:1537-1538` (value semantics). Regenerate `docs/db/erd.dbml` (`pnpm --filter maister-web db:erd`).
  - Verify: Task 9 green on a real container; `pnpm --filter maister-web db:generate` → "No schema changes" (T11); `pnpm --filter maister-web db:erd --check` green; `pnpm --filter maister-web db:migrate` on the dev DB (shared with other worktrees — coordinate; the memory `dev-machine-node-and-workspace-roots` says the dev DB is shared).

- [x] **Task 11 — Value grammar module (RED then GREEN).** `web/lib/mcp/__tests__/value-grammar.test.ts`: env-name and header-token regexes (positive/negative table), `classifyMcpValue` (literal / env-ref / malformed incl. `env:` alone, `env:1BAD`, `env:a-b`), `mcpEnvMapSchema` rejects a malformed value with the path `env.<key>`, `HEADER_VALUE_RE` (tab and printable accepted; `\r`, `\n`, `\x00`, `\x7f` refused), `hasAuthorizationHeader` case-insensitive, `secretShapedKey` table (positives `GITHUB_TOKEN`, `api_key`, `MY_TOKEN_2`, `Authorization`, `x-api-key`; negatives `TOKENIZER_MODE`, `FASTMCP_LOG_LEVEL`, `X-Request-Id`). Then `web/lib/mcp/value-grammar.ts` (D14).
  - Verify: unit project picks it up (`web/vitest.workspace.ts:50-76` glob `lib/**/__tests__/**/*.test.ts`); no `server-only` import (client components consume it).

- [x] **Task 12 — Form model + the four routes on the grammar.** `web/lib/mcp/mcp-form.ts`: `McpServerDraft` → `env: Record`, `headers: Record`, `bearerTokenEnv?`, `description?`; per-entry errors (`field: "env.<key>"`, `"headers.<name>"`, `"bearerTokenEnv"`); `buildMcpServerFields` normalization (D15); `buildCreateBody`. One exported zod body schema (`platformMcpBodySchema` / `projectMcpBodySchema`) built from the grammar module replaces the four `envKeyRefSchema` copies (`admin/mcp-servers/route.ts:24-53`, `[id]/route.ts:29-54`, `projects/[slug]/mcp/route.ts:19-40`, `[mcpId]/route.ts:21-42`). Row semantics (also enforced here, not only in the component): a row with an empty key and a non-empty value → error `env.` "key required"; a key with an empty value → an empty literal, accepted; fully empty rows are dropped before validation; duplicate keys never reach the form (the component collapses them only after flagging). Overlap budget: form tests assert WIRING — exactly one malformed-`env:` case and one header-value case; the grammar table is Task 11's. RED first: `mcp-form.test.ts` migrations — `:68` "rejects an invalid env key reference (no plaintext)" → obsolete, replaced by "accepts a literal value; rejects a malformed `env:` value with field `env.GH`"; `:106`/`:123` normalization cases on the map shape; NEW: bearer on http accepted, bearer on stdio normalized away, bearer + `Authorization` row → error field `bearerTokenEnv`; route integration `admin-mcp-crud.integration.test.ts:115,143,239,255` and `projects/[slug]/mcp/__tests__/route.integration.test.ts:209,264,290` → maps; NEW route case "a literal under `GITHUB_TOKEN` is ACCEPTED (D24)".
  - Logging: route WARN when readiness falls back to `Unknown` (Task 15); nothing else.
  - Verify: `mcp-form.test.ts` and both route integration suites green; `grep -rn 'envKeyRefSchema' web/app` → 0.

- [x] **Task 13 — Material projections and read models on one map shape.** `web/lib/mcp/projection.ts:24-76` (`refsToMap` retired; pass maps through), `web/lib/mcp/project-mcp.ts:19-78` (+`description`, maps), `web/lib/mcp/project-mcp-service.ts`, `web/lib/capabilities/catalog.ts:68-70,101-115` (D31: carry `env`/`headers` values; `redactedEnv` deleted), `web/lib/packages/attach.ts:429-471` (requirement rows → `env: {NAME:"env:NAME"}` map from either manifest form; template rows → maps + `headers` + `bearerTokenEnv`; the manifest schema itself is Task 20 — until then the loader still yields `string[]`), `web/lib/capabilities/agent-map.ts:22-31,99-132` (`AgentMcpServer` = `env?`, `headers?`, `bearerTokenEnv?`; `mcpServerFromMaterial`), `web/lib/mcp/hub-service.ts:40-73,312-342` (`PlatformCandidateView` slots from map keys), `web/lib/queries/platform-mcp-catalog.ts:10-50`, `web/app/(app)/mcps/page.tsx:26-40` (+`readinessReasons`, +`description`), `web/lib/mcp/serena-seed.ts:25`, `web/lib/mcp/requirements-ledger.ts` / `setup-resolve.ts` (only if they read keys — verify by grep). RED first, migrating: `projection.test.ts:44` ("projects env NAME references as an env:NAME map" → now identity), `:88`; `agent-map.test.ts:211,234,304`; `platform-mcp-projection.integration.test.ts:114`; `hub-service.test.ts:35`; `catalog.test.ts`, `catalog.m14.test.ts`, `resolver-materialize.test.ts`, `resolver-precedence.test.ts`, `resolver.binding.test.ts`; `lib/flows/graph/__tests__/resolved-set-snapshot.integration.test.ts`, `runner-graph.materialize.integration.test.ts`, `runner-graph.matplan.integration.test.ts`, `exec-trust-mcp-gate.integration.test.ts`; `lib/agents/__tests__/effective.integration.test.ts`; `cleanup-settings-local.integration.test.ts`; `components/studio/__tests__/package-composition.test.ts`. State per file whether the changed expectation is obsolete or broken.
  - Supervisor strict removal (D33, same commit): delete `envKeys`/`headerKeys` from `types.ts` (`McpServerInputSchema` + the probe field set), the legacy branch at `acp-client.ts:974-976`, and `mcp-probe.ts`; RED case in `mcp-forwarding.integration.test.ts`: "a body with `envKeys` is refused 409 and the message names `mcpServers.0.envKeys`" (moved from Task 8).
  - Config-state symmetry (skill-context rule): `upsertCapabilitiesFromConfig` gets a round-trip integration case — SET (`env: {GH_HOST: "ghe.example"}` in `maister.yaml` → `material.env.GH_HOST = "ghe.example"`), CLEAR (key removed → absent from `material.env` after the next registration), re-SET (back). Both halves are mandatory; an `if (!c.env) continue` write loop is a defect.
  - Verify: `grep -rn 'envKeys\|headerKeys' web/lib web/app --include='*.ts' --include='*.tsx'` → 0.

- [x] **Task 14 — Overlay = value replace (RED shown red against the old code).** Rewrite `web/lib/mcp/__tests__/overlay-apply.test.ts`: `:21` → "replaces the VALUE of `GITHUB_TOKEN` with `env:PROJ_A_GH` and keeps the KEY (`Object.keys(out.env)` unchanged)"; `:32` → "project A and B receive different SOURCES for the same key"; `:47`, `:71`, `:78` kept on the map shape; NEW "`bearerTokenEnv` overlay replaces the server's bearer on an http target and is refused on stdio (`CONFIG`)"; NEW "a literal overlay value replaces the value verbatim" (D32). Run the rewritten `:21` against the OLD `applyMcpOverlays` first and record the red (key renamed). Then `materialization-gate.ts:109-159`, `binding-service.ts:25,149-185,250-253` (slots = map keys; values under the shared grammar — D32; bearer only for http/sse targets — needs the target's transport in `McpTargetSlots`), `binding-schemas.ts:10-22` (`bearerTokenEnv` + `mcpValueSchema`). Migrate `binding-overlay.test.ts:23,32,43,49` (T8), `binding-schemas.test.ts:51,57` (T8), `binding-service.integration.test.ts:247`, `overlay-secret-invariant.integration.test.ts:87,132` (extend with a LITERAL sentinel `lit-9f3a` — T9: absent from `execution_commands.payload`, `runs.withheld_mcps`, `materialization_plan`, and the bindings GET body; and the env-ref VALUE sentinel remains absent everywhere as today).
  - Raw-SQL seeds that name the dropped column (column-drop sweep): `overlay-secret-invariant.integration.test.ts:70` and `binding-service.integration.test.ts:80` `INSERT INTO platform_mcp_servers (…, env_keys, …)` → `env` map; also `probe-service.integration.test.ts:57` (Task 16).
  - Verify: the recorded red + green; `web/lib/mcp/__tests__/trust-gate.integration.test.ts` unchanged and green.

- [x] **Task 15 — Host env-ref presence + readiness (RED then GREEN).** Wire: `web/lib/supervisor-client.ts` (`checkSupervisorEnvRefs(names)` POST + zod response `:398-405` sibling, `SupervisorEnvRefPresence` type), chunking in the local-direct transport (dedupe, ≤ 64 per call, merge in request order — D18; unit case: 65 names → two calls, merged order preserved, duplicate collapsed), `web/lib/execution-host/client.ts:221-248` (`HostAdminClient.checkEnvRefs(names, opts?)`), `transports/local-direct.ts:81` sibling, `index.ts` re-exports (T6), `web/test-support/fake-execution-host.ts:932-943` sibling (`checkEnvRefs` scripted via the same `diagnostics`-style setter + recorded call; refuses > 64 names per call like the real route — lenient-double rule), `web/e2e/_seed/stub-supervisor.ts:517-540` and `test-supervisor.ts:1130-1145` (`POST /diagnostics/env-refs`, D26). Evaluator `web/lib/mcp/readiness.ts:42-96` → `evaluateMcpReadiness(row, { presence, adapters })` (D18): names collected from `env`, `headers`, `bearerTokenEnv` values that are env-refs; literals never produce a reason; reason text stays `env ref missing: <NAME>`. Platform routes `route.ts:141-154` and `[id]/route.ts:184-197`: `diagnostics()` + `checkEnvRefs(names)` before the write, `Unknown` + WARN on any host failure. Project rows: `createProjectMcp`/`updateProjectMcp` (`project-mcp-service.ts:152,211`) cache `material.readiness = {status, reasons}` the same way; package rows: `attachPackage`/`upgradeAttachment` ingestion (`attach.ts:724,973`) computes it once per manifest before the transaction (one `checkEnvRefs` over the union of names); `composeProjectMcpHub` (`hub-service.ts:94`; platform entries keep `platform.readiness_status` at `:139`) reads `material.readiness` for non-platform entries and `McpPanel` renders it in the existing readiness cell (`mcp-panel.tsx:528-531`) with the same reasons tooltip (a reader for the cache exists — patch 2026-09-17-03.20: write-only state is not state). RED: `readiness.test.ts` 11 cases migrate to the map shape (`:64`, `:79` become "flags a missing ref by its NAME from an `env:` value" / "a bare literal value never flags"); NEW: bearer name checked; presence list independent of `diagnostics.envRefs`; `Unknown` when presence is `null`; route integration: platform POST with `env:{X:"env:MISSING_SENTINEL"}` → `readiness_status='NotReady'`, `readiness_reasons=['env ref missing: MISSING_SENTINEL']`; with the fake scripted `present:true` → `Ready`; fake `loseAdminResponse("checkEnvRefs")` → `Unknown` + the WARN line; project POST with `env:{X:"env:MISSING_SENTINEL"}` → `material.readiness.status='NotReady'` with the reason; attach of a package whose template references `MISSING_SENTINEL` → the package row's `material.readiness` is `NotReady`, an upgrade whose next version drops the reference flips it to `Ready` (SET/CLEAR through the cache); hub composition surfaces both. PARITY (skill-context): one integration case runs `checkEnvRefs(["PATH","NOPE_SENTINEL"])` against BOTH `fake-execution-host` and the real supervisor booted by `web/test-support/real-supervisor.ts`, asserting identical shapes and order.
  - Logging: platform/project write path WARN `mcp-readiness-host-unavailable {serverId, cause}` once per write; DEBUG `{serverId, referencedNames: count}`.
  - Verify: `readiness.test.ts`, `admin-mcp-crud.integration.test.ts`, the parity case, and `web/app/(app)/settings/__tests__/page-contract.test.ts` green.

- [x] **Task 16 — Probe path on maps.** `web/lib/mcp/probe-service.ts:85-195` builds `SupervisorMcpProbeRequest` (`supervisor-client.ts:842-856` → `env`, `headers`, `bearerTokenEnv`, re-exported via `execution-host`), platform branch `:132-142` and project/package branch `:145-194` (no more `envKeys ?? Object.keys(env)` dual read). RED: `probe-service.integration.test.ts:82` ("resolves NAMES only" → "sends maps with references unresolved; the literal sentinel is sent verbatim; no env-ref VALUE appears in the request"), `:101`, NEW "http target with `bearerTokenEnv` forwards it unresolved".
  - Verify: `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` green at the end of Phase 2 (idle host — T7); `pnpm --filter maister-web typecheck`; `pnpm --filter maister-web lint` then `git status` (T1).

### Phase 3 — Transport gate + codex (design item 4, D6)

- [x] **Task 17 — Adapter facts.** `web/lib/acp-runners/adapter-support.ts`: codex `:124` → `["stdio","http"]`; claude `:106` keeps `["stdio","sse","http"]` (verified — C11); gemini/opencode/mimo keep their lists with `// unverified against the adapter binary` ; NEW accessor `mcpTransportsForAdapter(adapter)` beside `:202-226`. RED: cases in the existing `web/lib/acp-runners/__tests__/adapter-support.test.ts` pinning codex = `["stdio","http"]` and claude ∋ `sse` through the accessor (two cases; no per-adapter enumeration — trivial).

- [x] **Task 18 — Third withhold pass + fan-out (D17, D29).** `partitionWithheldMcps` (`materialization-gate.ts:68-107`) gains `adapter` and the `agent-unsupported-transport` pass AFTER the two trust passes; `gateAndOverlayMcpServers` (`:192-232`) threads `adapter` from `runner-graph.ts:2076-2089` and `launch.ts:2664-2671` (`capabilityAgent`); `WithheldMcp.reason` union (`schema.ts:1648-1653`); `mergeRunWithheldMcps` unchanged; i18n `withheldReason.agentUnsupportedTransport` (en/ru `:2563-2565`); `resolved-capability-set-panel.tsx:107-118` label; `docs/db/runs-domain.md` already updated in Task 4. RED: `materialization-gate.test.ts` NEW "codex + sse → withheld `agent-unsupported-transport`", "claude + sse → kept", "platform-untrusted wins over transport for the same server"; `trust-gate.integration.test.ts:125` gains the new reason in the dedupe set; `components/runs/__tests__/resolved-capability-set-panel.test.ts:69` renders the label.
  - Logging: the existing warn lines (`runner-graph.ts:2142-2147`, `launch.ts:2673-2682`) already print `refId:reason` — no change.

- [x] **Task 19 — Required refs refuse launch (C12) + scratch through the shared gate (D17).** `resolver.ts:210-247` `firstAgentUnsupportedRequiredMcp`: rows gain `material.transport`; a winner with transport ∉ `mcpTransportsForAdapter(agent)` is the offending ref; `services/runs.ts:1290-1317` selects `material` and the message names ref + transport + agent. RED: `web/lib/capabilities/__tests__/required-mcp-agent-support.test.ts` NEW case (codex + required sse ref → returned; codex + required http → null); a `services/runs` precondition integration case: codex runner + required `sse` ref → `EXECUTOR_UNAVAILABLE` 503 and NO worktree / run row created (assert both). Scratch (owner: full gate): `web/lib/scratch-runs/service.ts:869/1097` and `:1561/1713` route `materialized.mcpServers` through `gateAndOverlayMcpServers` before the create payload — own sub-commit inside commit 4. Source `execTrust` the way the agent path does (`launch.ts:2664` `args.execTrust`; verify where it comes from and mirror it — do not invent a scratch-only rule); `adapter` from the scratch runner snapshot. RED: `web/lib/scratch-runs/__tests__/` integration cases "codex scratch with an `sse` server launches with the server withheld `agent-unsupported-transport` and persisted to `runs.withheld_mcps`", "an untrusted platform stdio server selected for scratch is withheld `platform-untrusted` (first run red proves today's hole or proves an upstream filter — record which)", "a project overlay applies to a scratch launch". The local-package assistant launch (`service.ts:1561`) has NO project ("the assistant has no project catalog") and cannot take the gate (it loads bindings by `projectId`): a RED case asserts its `materialized.mcpServers` contains no catalog entry, so the gate's absence there is a proven non-path (T16). Update the header comment `materialization-gate.ts:185-191` only if its wording changes; it becomes true.
  - Verify: `pnpm --filter maister-web test:unit && test:integration` green; the withheld reason visible in the run's capability panel (`data-testid="withheld-mcp-<ref>"`).

### Phase 4 — Package manifest + Studio (design item 5)

- [x] **Task 20 — Manifest schema (D27).** `web/lib/config.schema.ts:1502-1560`: `env: z.union([z.array(envRefSchema), mcpEnvMapSchema]).optional()`, `headers: mcpHeaderMapSchema.optional()`, `bearerTokenEnv: envRefSchema.optional()` (superRefine: http only; not with an `Authorization` header); `PACKAGE_ENV_REF` deleted in favour of the grammar module; normalization of the legacy list to a map in `web/lib/packages/manifest.ts` after `safeParse` (`:57`) into a `NormalizedPackageManifest` type (D34 — `mcps[].env: Record<string, value>` always; no `.transform`, the zod output type stays honest); `attach.ts` and Studio consume only the normalized type. RED: `web/lib/packages/__tests__/manifest.test.ts:37,58,69,119,136` — the plaintext-secret rejection case is OBSOLETE (D1) → replaced by "accepts a literal value; rejects a malformed `env:` value; accepts lowercase env names"; NEW legacy-list normalization, `headers`, bearer rules; `web/lib/__tests__/config.schema.mcp.test.ts`, `config.schema.test.ts`, `package-mcps.test.ts` migrations.
  - Verify: `grep -n 'PACKAGE_ENV_REF' web/lib` → 0.

- [x] **Task 21 — Attach ingestion on the map form.** `web/lib/packages/attach.ts:429-471` reads the normalized map for both requirement and template rows (requirement: keys → `{NAME:"env:NAME"}`; template: values as declared, `headers`, `bearerTokenEnv`); `writeIngestionRecords` (single caller: `wireMembers` `attach.ts:621`, call at `:672`, inside the transaction of BOTH `attachPackage` `:724` and `upgradeAttachment` `:973`) receives a precomputed `readinessByRef` map; the host reads (`diagnostics()` + one chunked `checkEnvRefs` over the union of the manifest's env-ref names) run in the two public entry points BEFORE `db.transaction`, `Unknown` on failure (D18). RED: `web/lib/packages/__tests__/attach.integration.test.ts` — a package with the legacy list and one with the map produce identical requirement material; a template with `headers` + `bearerTokenEnv` lands in material; `resolveBindTarget` on that template now returns its env keys as slots (C10 defect closed — assert). Config-state symmetry across `upgradeAttachment`: a template whose next version drops `headers` leaves no `material.headers` entry behind (SET → CLEAR → re-SET, all three asserted). Readiness for package rows is cached at ingestion (D18, Task 15).

- [x] **Task 22 — Studio MCP template editor.** `web/components/flows/artifact-editors/mcp-template-editor.tsx:31-62`: `McpTemplate.env: Record`, `headers?`, `bearerTokenEnv?`; prefill from the platform catalog (`platform-mcp-catalog.ts`) copies references and converts literals to `env:<KEY>` (D28), sets `bearerTokenEnv` from the platform row, writes the map form to YAML; the `materialize()` sse→http mapping stays. RED: `__tests__/mcp-template-editor.dom.test.ts` (jsdom; respect the CodeEditor remount-key contract in its header) — prefill from a row with a literal writes `env:<KEY>` not the literal; a literal header `X-Api-Key` becomes `env:X_API_KEY` (D28 sanitization; a name starting with a digit gets `_`); headers and bearer appear; `package-composition.test.ts` migration.
  - Verify: `pnpm --filter maister-web test:unit` green; lint + `git status` (T1).

### Phase 5 — UI (design item 6)

- [x] **Task 23 — `KeyValueRows` extraction + runner modal swap (D25).** RED `web/components/settings/__tests__/key-value-rows.dom.test.ts` (jsdom): renders rows with `aria-label`s from `labels`, add appends an empty row, remove deletes by id, edits call `onChange` with the full array, `keySuggestions` renders a `<datalist>`, `warningFor` renders inline `role="note"` text that does NOT set `aria-invalid`, `errorFor` renders with `aria-invalid`, `disabled` disables every control, `rowsFromRecord`/`recordFromRows` round-trip (drops fully empty rows, keeps a key-only row as an empty literal); duplicate keys → every duplicate row flagged with `errorFor`-style inline text while `recordFromRows` stays last-wins (the consumer blocks submit on any flagged row); an empty key with a value → flagged "key required". Then extract from `acp-runner-modal.tsx:38-45,131-153,338-356,754-815`; the runner modal imports the helpers and renders the component with `labels` from `settings.fieldEnv*`/`addEnv`/`removeEnv`.
  - Verify: `acp-runner-modal.test.ts:58-118` passes UNCHANGED (byte-identical assertions); the modal's markup diff is limited to the extracted block.

- [x] **Task 24 — Platform MCP modal + panel.** `web/components/settings/mcp-server-modal.tsx`: field order id, description, transport (`sse (legacy)` label — D30), command + args OR url + bearer token env, env rows OR header rows via `KeyValueRows` (`warningFor` from `secretShapedKey`, `errorFor` from the per-entry form errors), supported agents, enabled; hint states the grammar; submit body = maps. Launch precondition carried into the create UI (skill-context rule): when transport is `sse` and `codex` is among the supported agents, an inline non-blocking note says the server will be withheld for codex runs (`agent-unsupported-transport`). `mcp-servers-panel.tsx:113-117` tooltip with `readinessReasons` (D19) and `mcps/page.tsx` already selects it (Task 13). RED: migrate `mcp-server-modal.test.ts:33,51` (SSR) to the new fields; NEW `mcp-server-modal.dom.test.ts` (jsdom): typing `ghp_x` under key `GITHUB_TOKEN` shows the warning and the submitted body still carries the literal (D24); `env:bad name` shows a row error and blocks submit; bearer + an `Authorization` row blocks with the `bearerTokenEnv` error; switching to stdio hides bearer/headers. `mcp-servers-panel.test.ts:47` asserts the reasons tooltip.

- [x] **Task 25 — Project MCP modal + hub panel.** `web/components/board/panels/mcp-modal.tsx:30-59,347-394` on the same model (uses `useModalFocusTrap` already; the same `sse` + codex note); `mcp-panel.tsx:57-65,147-163` slot hints from map keys; `PlatformCandidateView` shape. RED: NEW `web/components/board/panels/__tests__/mcp-modal.dom.test.ts` (no test exists today — C14) mirroring Task 24's four cases; `mcp-panel.test.ts` migration.

- [x] **Task 26 — Overlay dialog.** `web/components/board/panels/mcp-bind-dialogs.tsx:268-282,291-345,356-422`: `remapEditor` → `KeyValueRows` with `keySuggestions` = the target's env/header keys, values under the shared grammar (D32; `warningFor` for a literal under a secret-shaped slot), `bearerTokenEnv` override field shown only for http/sse targets (`isHttp` gate `:424-425`), sparse payload build keeps sending only touched keys; i18n `overlayIntro` (no longer "env:NAME references only"), `overlayValuePlaceholder` (`value or env:NAME`) reworded. RED: `mcp-bind-dialogs.test.ts` + `mcp-bind-dialogs.dom.test.ts` migrations; NEW dom case: bearer override PATCH body carries `bearerTokenEnv`.

- [x] **Task 27 — EN/RU strings, lint, typecheck.** `web/messages/en.json` + `ru.json`: `settings` (reuse `fieldEnv`, `fieldEnvKey`, `fieldEnvValue`, `addEnv`, `removeEnv`; NEW `fieldHeaders`, `fieldHeaderName`, `fieldHeaderValue`, `addHeader`, `removeHeader`, `fieldBearerTokenEnv`, `bearerTokenEnvHint`, `fieldDescription`, `valueGrammarHint`, `secretShapedWarning`, `transportSseLegacy`, `readinessReasonsTitle`; retire `fieldEnvKeys`, `fieldHeaderKeys`, `secretRefHint`), `mcpPanel` (same set + `overlayIntro`/`overlayValuePlaceholder`/`overlayBearer`), `flowEditor.artifacts.mcp.secretNotice` + `prefillHint` reworded (D28), `withheldReason.agentUnsupportedTransport`. Parity: `web/lib/__tests__/i18n-parity.test.ts:87-92`; `i18n-settings-keys.test.ts` extended with the new keys; retired keys removed from BOTH files and from every consumer (grep).
  - Verify: `pnpm --filter maister-web lint` then `git status` (T1); `pnpm --filter maister-web typecheck`; `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` green (phase exit); screens docs (Task 4) name the final key set.

### Phase 6 — Falsification, sweep, truth pass, lanes

- [x] **Task 28 — Falsification (name the failing assertion in each case).** (a) Revert `applyMcpOverlays` to key-rename → `overlay-apply.test.ts` "keeps the KEY" goes red on `Object.keys(out.env)`. (b) Revert codex `mcpTransports` to three → `materialization-gate.test.ts` "codex + sse → withheld" red on the withheld length. (c) Revert the bearer composition in `acp-client.ts` → `mcp-forwarding` "composed Authorization" red on the missing header. (d) Revert the `regexp_replace` strip in the backfill → the replay test red on the key `env:GITHUB_TOKEN`. (e) Revert Task 19's transport branch → the precondition case red (run row created). (f) Script `checkEnvRefs` to throw → route case red without the `Unknown` fallback? No — that one must stay GREEN (it IS the fallback); instead revert the fallback and assert the route now 500s. Restore after each; every guard must fail in isolation with exactly one assertion.
  - Verify: each recorded with the assertion text and the observed failure.

- [x] **Task 29 — Column-drop sweep beyond grep (memory `column-drop-sweeps-need-more-than-grep`).** `git grep -nE 'env_keys|header_keys|envKeys|headerKeys' -- . ':!web/lib/db/migrations' ':!docs/plans' ':!docs/decisions' ':!.ai-factory' ':!site-docs'` → 0; raw SQL re-read by eye: `hub-service.ts:312-342`, `mcps/page.tsx:26-55`, `platform-mcp-catalog.ts:25-50`, `services/runs.ts:1290-1302`, `probe-service.ts`, `serena-seed.ts`; NUL-containing files excluded from grep are checked with `git grep -I`; `web/e2e/_seed/seed-e2e.ts:3562` (bare `github` row — still valid with `material` omitted? assert the seed still loads); `pnpm --filter maister-web db:erd --check`; `check-migrations.integration.test.ts` full lineage.

- [x] **Task 30 — Truth pass: re-derive surfaces FROM THE DIFF, flip statuses.** Run over the actual diff: `grep -rn 'bearerTokenEnv\|bearer_token_env\|checkEnvRefs\|env-refs\|agent-unsupported-transport\|value-grammar\|mcp-values' docs/ site-docs/ web/CLAUDE.md supervisor/*.md` — every hit outside the Phase 0 list is an unlisted surface: fix or explain. Re-verify every Phase 0 artifact against the shipped code (the three readiness cache sites of D18, the gate pass order, the migration statement order, the field order in screens). Flip `(Designed)` → `(Implemented)` in `mcp-management.md`, `configuration.md`, `error-taxonomy.md:262-264`; ADR-179 → `Implemented` in the record body, stub and index row; `docs/plans/README.md` row → `Shipped (2026-MM-DD) — ADR-179`; `web/CLAUDE.md` data-management/affordance sections mention `KeyValueRows` if they name the runner modal as the pattern (`web/CLAUDE.md:766-772`). Renumber check: `max(### ADR-NNN)` at `master` HEAD is still 176 and `_journal.json` max idx is still 171 on `master` before merging — otherwise renumber 177/0172 and re-run the whole gate.
  - Verify: `pnpm validate:docs:all` green (Mermaid, ADR anchors incl. `--all`, links, indexes, DBML); counts recorded; Expectations counts re-confirmed (≤ 12 / 13 / 19).

- [ ] **Task 31 — Full lanes against the master baseline.** `pnpm --filter maister-web typecheck && pnpm -C supervisor typecheck`; `pnpm --filter maister-web test:unit`, `test:integration` (idle host — T7; expected 0 failures except the known-flaky `dirty-resolution-race.integration.test.ts`, per `web/CLAUDE.md:262-265` — compare failure SETS); `pnpm -C supervisor test`; e2e: `m27-platform-mcp.spec.ts`, `mcps.spec.ts`, `mcp-hub.spec.ts` first, then the full `pnpm --filter maister-web test:e2e` compared against the 2026-09-21 sets at `web/CLAUDE.md:434-453` (branch 4 failed / 4 flaky / 185 passed vs master 5 failed / 187 passed) — any NEW name is this branch's; `pnpm lint` in both packages with a clean `git status` afterwards (T1). Record counts, not adjectives; if a lane's totals moved, update `web/CLAUDE.md:257-473` (suite baselines) in the same commit.

**Review protocol (owner's standing pipeline, not a task):** after Task 31, `/aif-verify`, then `/aif-review` on a different model, then the codex adversarial review; every fix cycle — especially the launch-wiring (`services/runs.ts`, `runner-graph.ts`, `launch.ts`) and migration diffs — is re-reviewed, not only the original change. Merge to `master` with `--no-ff`; the docs truth pass (Task 30) is re-run on the exact merged tree.

---

## Out of scope (do not drift into these)

- JSON import of `.mcp.json`-shaped configs and the ACP-shape preview (D5, design §10).
- OAuth / `elicitation.url` client capability / `needs-auth` surfacing (D8, design §9 note).
- Facade key-merge or dedupe by name at `launch.ts:3383-3386` (C2, T12).
- Timeouts, `cwd`, tool allow/deny lists, OAuth client settings — agent-local config MAIster does not materialize (design §1).
- Supervisor host auth (Stage D) — the env-refs oracle is accepted and recorded (D22).
- A per-host readiness matrix (design §6 — until a second host exists).
- Bringing `capabilities.md` / `acp-runners.md` Expectations back under the R5a cap (pre-existing debt; do not worsen — T5).
- `web/lib/flows/flow-dsl-grammar.ts:192` says runner `env` values are "`env:NAME` references only (never literal secrets)" while `runner-form.ts:31-36` accepts literals — a RUNNER-surface drift, not MCP; see Follow-up.

## Follow-up (separate items)

- Runner grammar sentence in `flow-dsl-grammar.ts:192` (and its drift-guard `flow-dsl-grammar.test.ts`) to say `literal | env:NAME`, matching `runner-form.ts` and `acp-runners.md:376-381`.
- Stage D host auth closes the env-refs presence oracle (D22) — the ADR-179 Consequences name it.
- The `execution-hosts.md` identifier table (`:646-658`) could list `names[]` of env-refs as a worked `body-controlled` example.

---

## Resolved (owner, 2026-09-21)

**Answers to this plan's questions (2026-09-21):**

- **Q1 — overlay-значения по общей грамматике `literal | env:NAME`: да** → D32; T8 переворачивает два теста как obsolete.
- **Q2 — scratch через общий gate целиком** (trust + overlay + transport) → D17, Task 19; отдельный саб-коммит в коммите 4.
- **Q3 — readiness для project/package: кэш на записи** → D18, Task 15 (project на create/update, package на attach/upgrade, хаб читает `material.readiness`).
- **Q4 — `maister.yaml capabilities.mcps[].env/headers`: нести значения** по общей грамматике → D31, Task 13 (`redactedEnv` удаляется; SET/CLEAR/re-SET тест обязателен).

**Design doc D1–D12:** literals allowed (D1) · no interpolation (D2) · unset ref → `""` (D3) · manifest map + legacy list (D4) · JSON import deferred (D5) · codex+SSE fixed here (D6) · env-ref presence ships now (D7) · OAuth stays a note (D8) · secret guard = UI warning (D9) · `bearerTokenEnv` field (D10) · shared rows component (D11) · hard wire cut-over (D12). ADR number confirmed as **177**, migration as **0172** (allocated above).

## Unresolved questions

Нет — все открытые вопросы закрыты владельцем (2026-09-21). План готов к `/aif-implement`.

---

## Implementation record (2026-09-21)

### Acceptance criteria — where each is proven

| AC | Evidence |
|---|---|
| AC-01 | `supervisor/src/__tests__/mcp-values.test.ts` (literal verbatim incl. a `${X}` literal, `env:NAME` from `process.env`, unset → `""`) + `mcp-forwarding.integration.test.ts` env-map case through the recording adapter. |
| AC-02 | `web/lib/mcp/__tests__/value-grammar.test.ts` (the table, asserted once) + one wiring case each in `mcp-form.test.ts`, `supervisor/src/__tests__/types.test.ts`, `admin-mcp-crud.integration.test.ts`, the project MCP route suite, and `mcp-server-modal.dom.test.ts`. |
| AC-03 | `mcp-values.test.ts` (appended LAST, `"Bearer "` when unset) · `types.test.ts` (both sides refuse the `Authorization` pair, case-insensitively) · `mcp-forwarding` http case · `mcp-server-modal.dom.test.ts` blocks submit. |
| AC-04 | `value-grammar.test.ts` (CR/LF/NUL/DEL refused, tab and printable accepted) · `types.test.ts` · `mcp-form.test.ts`. |
| AC-05 | `overlay-apply.test.ts` rewritten (`Object.keys` unchanged; literal accepted; bearer http/sse-only) · `binding-overlay.test.ts` and `binding-schemas.test.ts` flipped (obsolete, not broken) · `binding-service.integration.test.ts` · `mcp-bind-dialogs.dom.test.ts`. |
| AC-06 | `commands.integration.test.ts` — a LITERAL sentinel in `env`/`headers` plus a bearer ref, asserted absent from `execution_commands.payload` (which keeps only `mcpServerCount`) · `scratch-mcp-gate.integration.test.ts` asserts the literal is absent from `runs.withheld_mcps` · `overlay-secret-invariant.integration.test.ts` keeps the reference sentinel absent and now asserts the literal IS present where D1 says it must be. |
| AC-07 | `readiness.test.ts` (presence independent of `diagnostics.envRefs`; a literal never flags; `Unknown` when presence is null) · `admin-mcp-crud.integration.test.ts` (Ready / NotReady-with-reason / literal-no-reason / degrade-to-Unknown-and-commit) · `mcp-servers-panel.test.ts` renders the reasons. |
| AC-08 | Project rows: `project-mcp-service` cache asserted through the DTO. Package rows: `attach.integration.test.ts` asserts `material.readiness` is written at ingestion and that an upgrade REBUILDS material (SET → CLEAR → re-SET). |
| AC-09 | `supervisor/src/__tests__/env-refs.integration.test.ts` — 64 accepted / 65 refused / 0 refused, request order after de-duplication, malformed name refused, and the sentinel VALUE absent from the response bytes. |
| AC-10 | `migration-0172-mcp-env-values.integration.test.ts` — both stored key spellings, all three material shapes, template values untouched, columns dropped, overlay row byte-identical. |
| AC-11 | `materialization-gate.test.ts` (codex+sse withheld, claude+sse kept, `platform-untrusted` wins, no adapter = no gate) · `trust-gate.integration.test.ts` (the reason persists and the dedupe key is `(refId, reason)`). |
| AC-12 | `required-mcp-agent-support.test.ts` (adapter varied) · `route.capability-refs.integration.test.ts` pins the SEND site — that `material.transport` is selected and reaches the predicate. |
| AC-13 | `scratch-mcp-gate.integration.test.ts` — trust, transport and overlay through the shared gate, plus the assistant launch asserted as a proven non-path by call-site count. |
| AC-14 | `manifest.test.ts` (list and map produce identical `env`; literal accepted; lowercase names; headers/bearer rules) · `attach.integration.test.ts` (identical material from both forms). |
| AC-15 | `mcp-template-editor.dom.test.ts` — a platform literal becomes `env:<KEY>`, a header name is sanitized (`X-Api-Key` → `X_API_KEY`), and the literal appears nowhere in the template. |
| AC-16 | `key-value-rows.dom.test.ts` (14 cases) · `acp-runner-modal.test.ts` passes with a ZERO diff through the extraction. |
| AC-17 | `i18n-parity.test.ts` green; every new key grepped for a consumer before commit; `readinessReasonsTitle` removed as an orphan. |
| AC-18 | `pnpm validate:docs:all` green (14/14 + ERD current at 125 tables); no touched doc claims "names only" about MCP env or headers; ADR-179 status equal in record, stub and index row. |

### Deviations from the plan, and why

1. **`readinessReasonsTitle` (Task 27) was not shipped.** The tooltip renders the
   reasons themselves, so the key had no render site. A key nothing consumes is
   an orphan, not a deliverable.
2. **The supervisor's D33 window closed in commit 7, not commit 3.** Task 13's
   sub-bullet was missed; the Task 29 sweep caught it. Every commit still
   bisects green, but the branch tip only satisfied D12 after commit 7.
3. **C6's predicted refusal message was wrong.** Zod reports an unrecognized key
   against the object's path, so it reads `mcpServers.0: Unrecognized key(s) in
   object: 'envKeys'`, not `mcpServers.0.envKeys`. The test and the two docs
   assert what the code emits.
4. **The project MCP route body key is `id`, not `refId`.** The OpenAPI said
   `refId`; the route has always taken `id`. Drift older than this work, fixed
   in the spec rather than the route.
5. **Task 19's scratch cases live in a new file** (`scratch-mcp-gate.integration.test.ts`)
   rather than an existing one, to avoid perturbing `scratch-placement`'s serial
   Q1–Q5 ordering. Same directory, as the plan specified.
6. **Tasks 24–26's UI work landed in commit 3, its tests in commit 6.** Dropping
   the name-list columns from `schema.ts` does not compile while the modals still
   read them, so the surfaces had to move with the model.
