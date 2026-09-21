# MCP configurator: env/header value model, transport gate, host env-ref readiness

**Date:** 2026-09-21
**Status:** Shipped 2026-09-21 as [ADR-179](../decisions.md#adr-179). D1–D12 were
taken with the owner on 2026-09-21; the §11 open point was confirmed the same day
(overlay values use the shared grammar). Where this document and the ADR differ,
the ADR is canonical: implementation added the ground truth this design did not
have — the literal `env` channel already existed end-to-end, `capability_records.
material` held three shapes rather than one, `evaluateMcpReadiness` had no
project/package callers at all, and scratch launches bypassed the shared gate.
**Touches:** ADR-070 (platform MCP catalog), ADR-129 (MCP management v2:
overlay, readiness, probe), ADR-089 (facade literal env channel), ADR-088
(package manifest `mcps[]`), ADR-166 (host admin surface), ADR-065 (runner
`env` precedent).

## 1. Problem

The platform and project MCP forms show env and header entries as a single
column of names because that is what the model stores: `env_keys` and
`header_keys` are name lists. The name of the variable handed to the MCP child
process is the name of the variable in the supervisor environment, and the HTTP
header name is the name of an environment variable. Five defects follow, none
of them caught by the current suites:

1. **`Authorization: Bearer <token>` cannot be expressed.** The supervisor
   sends a header whose name is the env-var name and whose value is that
   variable ([`supervisor/src/acp-client.ts`](../../supervisor/src/acp-client.ts),
   `headers: headerKeys.map(k => ({ name: k, value: process.env[k] }))`). The
   MCP authorization spec requires `Authorization: Bearer`, so no authenticated
   remote MCP is reachable today.
2. **No non-secret literal can be passed** (`FASTMCP_LOG_LEVEL=ERROR`, a
   `--flag` that takes a value) without defining a host variable.
3. **The per-project overlay renames the child variable.** `applyMcpOverlays`
   in [`web/lib/mcp/materialization-gate.ts`](../../web/lib/mcp/materialization-gate.ts)
   replaces the key `GITHUB_TOKEN` with `PROJ_A_GH`, and
   [`overlay-apply.test.ts`](../../web/lib/mcp/__tests__/overlay-apply.test.ts)
   pins that. The server expects `GITHUB_TOKEN` and never receives it. The v2
   remap is green in CI and wrong in production.
4. **Readiness is falsely red.** [`web/lib/mcp/readiness.ts`](../../web/lib/mcp/readiness.ts)
   treats a name as missing unless it appears in the supervisor's fixed
   `/diagnostics` list (nine provider names plus `MAISTER_DIAGNOSTIC_ENV_REFS`).
   Every MCP referencing `env:GITHUB_TOKEN` is `NotReady` until an operator
   edits a supervisor env var.
5. **SSE breaks a codex session.** `codex-acp` 1.10.0 (`createMcpSeverConfig`)
   throws `invalidRequest` for transport `sse` and `acp` while building the
   session config, so `session/new` fails for the whole session.
   [`web/lib/acp-runners/adapter-support.ts`](../../web/lib/acp-runners/adapter-support.ts)
   declares `sse` for all five adapters, and `mcpTransports` is read nowhere:
   the "agent-unsupported transport → `EXECUTOR_UNAVAILABLE`" edge case in
   [`mcp-management.md`](../system-analytics/mcp-management.md) is documented,
   not implemented. The ACP v2 schema (`@agentclientprotocol/sdk` 1.4.0,
   `dist/v2`) has no `sse` variant at all; v1 (what the supervisor imports)
   still has it.

What the wire can carry is fixed by ACP and both adapters: stdio
`{ name, command, args, env[] }`, http/sse `{ type, name, url, headers[] }`.
`claude-agent-acp` 0.75.1 maps these 1:1 onto the Agent SDK `mcpServers`
option; `codex-acp` maps stdio to `command/args/env` and http to
`url/http_headers`. Timeouts, `cwd`, tool allow/deny lists and OAuth client
settings are agent-local config that MAIster deliberately does not
materialize (no `.mcp.json`, no `config.toml` MCP entries). They stay out of
the form.

## 2. Decisions taken with the owner (2026-09-21)

| # | Decision |
| --- | --- |
| D1 | Literal values are allowed in env and header maps (parity with runner `env`). |
| D2 | No interpolation inside strings. A value is whole-value: `literal` or `env:NAME`. A literal containing `${X}` reaches the server unchanged. Rationale: a provisioner substituting inside literals would corrupt values meant for the server. |
| D3 | A referenced host variable that is unset resolves to the empty string (today's MCP behavior), not fail-fast. Readiness and the probe are the guard. |
| D4 | The package manifest `mcps[].env` is extended to a map in v1; the legacy `env:NAME` string list stays accepted. |
| D5 | Import from a pasted JSON block and a JSON preview are deferred (§10 records the sources). |
| D6 | The codex + SSE defect is fixed in this milestone as its own plan item and commit. |
| D7 | The host-scoped env-ref presence check ships now. |
| D8 | OAuth stays a note. Direction recorded in §9. Pre-obtained static tokens are covered by the bearer field. |
| D9 | The secret guard is a UI warning, not a server-side refusal. |
| D10 | Bearer auth is a dedicated field `bearerTokenEnv` (an `env:NAME` reference, http/sse only); the supervisor composes `Authorization: Bearer <value>`. The MCP authorization spec fixes the header name and scheme for every compliant server; non-standard API-key headers are ordinary header rows. |
| D11 | The key/value rows component is extracted from the runner modal and reused; the runner modal keeps its behavior. |
| D12 | Hard cut-over on the supervisor wire: `env`/`headers` maps replace `envKeys`/`headerKeys` in one deploy; no legacy acceptance. Web and supervisor ship from the same commit on the single supported host. |

## 3. Value grammar

One grammar shared by web validation
([`web/lib/mcp/mcp-form.ts`](../../web/lib/mcp/mcp-form.ts)), the supervisor
schema ([`supervisor/src/types.ts`](../../supervisor/src/types.ts)), the
package manifest and the binding overlay:

| Form | Where | Resolution on the execution host |
| --- | --- | --- |
| `literal` (does not start with `env:`) | env, headers, overlay, manifest | passed verbatim, never interpolated |
| `env:NAME` (`^env:[A-Za-z_][A-Za-z0-9_]*$`) | env, headers, overlay, manifest, `bearerTokenEnv` | `process.env[NAME] ?? ""` |

- A value that starts with `env:` and fails the regex is refused with
  `CONFIG` (mirrors `validRunnerEnvValue` in
  [`runner-form.ts`](../../web/lib/acp-runners/runner-form.ts)).
- `bearerTokenEnv` accepts only `env:NAME`. A server that sets it and also
  declares an `Authorization` header row is refused with `CONFIG` (one source
  of truth for the header). Resolution: `Authorization: Bearer ` +
  `(process.env[NAME] ?? "")`.
- Keys: env names `^[A-Za-z_][A-Za-z0-9_]*$`; header names are RFC 7230
  tokens `^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$`.
- **Secret guard (UI warning, D9).** The form shows an inline warning, never a
  block, when a literal value sits under an env key ending in `TOKEN | SECRET
  | PASSWORD | PASSWD | API_KEY | APIKEY | PRIVATE_KEY | ACCESS_KEY`
  (case-insensitive, `_`-anchored) or under a header named `Authorization |
  Proxy-Authorization | Cookie | X-Api-Key | X-Auth-Token` (case-insensitive).
  Routes accept the value. The heuristic lives next to the grammar in
  `mcp-form.ts` so every form surface shows the same warning.

Invariant, restated: MAIster never stores, returns, streams or logs the value
behind a reference. A literal is the operator's declaration that the value is
not a secret; the UI warns under secret-shaped names. The `env:NAME` regex in
[`configuration.md`](../configuration.md) stays the reference grammar.

## 4. Data model

**`platform_mcp_servers`** — `env jsonb NOT NULL DEFAULT '{}'`
(`Record<childName, value>`), `headers jsonb NOT NULL DEFAULT '{}'`
(`Record<headerName, value>`), `bearer_token_env text NULL` (`env:NAME`,
http/sse only, normalized away for stdio like `url`), `description text
NULL`. `env_keys` and `header_keys` are dropped after backfill (§7).

**`capability_records.material`, kind=mcp** — `env`, `headers` and
`bearerTokenEnv` replace `envKeys`/`headerKeys` for every source (`platform |
project | flow-package`). A package *requirement* row (no implementation)
keeps its declared slots as the keys of `env`; values are the declared
default sources.

**`project_mcp_bindings.config_overlay`** — `envRemap: Record<childName,
value>`, `headerRemap: Record<headerName, value>`, `bearerTokenEnv?:
env:NAME`. Remap keys are validated against the target's `env`/`headers`
**keys** at write and at materialization (unchanged rule, new source of
slots); `bearerTokenEnv` is accepted only for a target whose transport is
http/sse. Application replaces the **value** for the same key and never the
key. `argsOverride` and `urlOverride` are unchanged. Overlay values use the
same grammar as the server (§3), pending §11.

**Package manifest (`maister-package.yaml` v1) `mcps[]`** — `env` accepts the
legacy `string[]` of `env:NAME` (normalized to `{ NAME: "env:NAME" }` at load)
or `Record<string, value>`; new optional `headers: Record<string, value>` and
`bearerTokenEnv: env:NAME` for http templates. Additive, no `schemaVersion`
bump. Studio's
[`mcp-template-editor.tsx`](../../web/components/flows/artifact-editors/mcp-template-editor.tsx)
writes the map form.

**`AgentMcpServer`** ([`agent-map.ts`](../../web/lib/capabilities/agent-map.ts))
— `env?: Record<string,string>`, `headers?: Record<string,string>`,
`bearerTokenEnv?: string`; `envKeys`/`headerKeys` removed. The generated facade
entries (`MAISTER_PROJECT_TOKEN`, `MAISTER_API_BASE_URL` in
[`web/lib/agents/launch.ts`](../../web/lib/agents/launch.ts)) are merged by key
over catalog entries, so ADR-089 precedence is unchanged.

## 5. Wire and resolution

- `McpServerInputSchema` and `McpProbeRequestSchema`
  ([`supervisor/src/types.ts`](../../supervisor/src/types.ts),
  [`supervisor/src/http-api.ts`](../../supervisor/src/http-api.ts)): `env:
  z.record(envName, value)`, `headers: z.record(headerName, value)`,
  `bearerTokenEnv: envRef.optional()`; `envKeys`/`headerKeys` are removed
  (D12, strict schemas reject them).
- New module `supervisor/src/mcp-values.ts`: `resolveMcpValue(value)`,
  `resolveMcpMap(map)` and `resolveMcpHeaders(headers, bearerTokenEnv)`, used
  by the ACP `McpServer` build in `acp-client.ts` and by `buildMcpTransport`
  in [`supervisor/src/mcp-probe.ts`](../../supervisor/src/mcp-probe.ts). stdio
  env → `EnvVariable[]`, http/sse headers → `HttpHeader[]` with the composed
  `Authorization` appended when `bearerTokenEnv` is set.
- Logging: key names only, never resolved maps. The command ledger already
  reduces `mcpServers` to `mcpServerCount`
  ([`web/lib/execution-host/redact.ts`](../../web/lib/execution-host/redact.ts)),
  so literal values never persist in `execution_commands.payload` (E-EH-12
  holds).
- Web wire types in `web/lib/supervisor-client.ts` and the execution-host
  contracts follow; [`docs/api/supervisor.openapi.yaml`](../api/supervisor.openapi.yaml)
  and [`docs/api/web.openapi.yaml`](../api/web.openapi.yaml) are updated in the
  same commits.

## 6. Readiness: host env-ref presence

- Supervisor `POST /diagnostics/env-refs` `{ names: string[] }` →
  `{ refs: [{ name, present }] }`. Names validated by the env-name regex,
  at most 64 per call, values never returned, unauthenticated like
  `/diagnostics` (same admin-surface posture, ADR-166 T4.6).
- `HostAdminClient.checkEnvRefs(names)` in
  [`web/lib/execution-host/contracts.ts`](../../web/lib/execution-host/contracts.ts)
  and the local-direct transport.
- `evaluateMcpReadiness(row, presence)` reads the names referenced by `env:`
  values across `env`, `headers` and `bearerTokenEnv` and consults the
  presence list. Recomputed on every POST/PATCH as today; the same evaluator
  serves project/package rows (`material.readiness`). `GET
  /diagnostics.envRefs` stays for runner readiness.
- Multi-host: presence is host-scoped by construction and no value ever
  leaves a host. With one registered host, readiness is computed against it;
  a per-host matrix is out of scope until a second host exists. Pushing
  resolved values from the web tier is rejected: it would put secrets on the
  web→supervisor wire, in the command ledger's input, and in web env.

## 7. Migration and column-drop sweep

- `web/lib/db/migrations/<next>_mcp_env_values.sql`: add `env`, `headers`,
  `bearer_token_env`, `description`; backfill `env =
  coalesce(jsonb_object_agg(strip(k), 'env:' || strip(k)), '{}')` from
  `env_keys` (same for headers); rewrite `capability_records.material` for
  `kind = 'mcp'` the same way; drop `env_keys`/`header_keys`. Overlay rows
  need no rewrite (keys unchanged).
- Sweep beyond grep (raw SQL, seeds, fixtures, ERD): `probe-service.ts`,
  `hub-service.ts`, `usage.ts`, `serena-seed.ts`, integration fixtures,
  `pnpm --filter maister-web db:erd --check`, both OpenAPI files, and a
  migration replay against a pre-migration snapshot in the integration lane.

## 8. Transport gate and the codex fix (D6)

- `partitionWithheldMcps` gains a pass: a server whose transport is not in the
  adapter's `mcpTransports` is withheld with reason
  `agent-unsupported-transport`, persisted like every other withhold; a
  **required** ref refuses launch with `EXECUTOR_UNAVAILABLE`. This makes the
  documented edge case real.
- `adapter-support.ts`: codex `mcpTransports: ["stdio", "http"]` (verified
  against `codex-acp` 1.10.0). Other adapters keep their declared lists with a
  comment that they are unverified.
- UI: transport choices `stdio`, `http`, `sse (legacy)`; docs note SSE is
  deprecated by MCP 2025-03-26 and absent from ACP v2.

## 9. UI

- Shared `KeyValueRows` component extracted from
  [`acp-runner-modal.tsx`](../../web/components/settings/acp-runner-modal.tsx)
  (rows, onChange, key/value labels, hint, optional key datalist, per-row
  warning, disabled). Consumers: the runner modal (no behavior change), the
  platform MCP modal, the project MCP modal, the overlay dialog (replaces its
  local editor), and the Studio template editor (D11).
- Field order: id, description, transport, command + args or url + bearer
  token env, env rows or headers rows, supported agents, enabled. Per-row
  validation messages; the secret-shaped warning (§3) is inline and
  non-blocking; the hint states the grammar. EN and RU strings.
- Readiness reasons stay in the panel column, refreshed after save as today.

### OAuth note (D8)

MCP authorization (2025-06-18) is OAuth 2.1 with RFC 9728 discovery, RFC 8707
resource indicators and PKCE; 2025-11-25 added OIDC discovery, Client ID
Metadata Documents, incremental scopes and URL elicitation. The Agent SDK does
not run the flow: a challenged server reports `needs-auth` and Anthropic's
guidance is to complete OAuth in the host application and pass
`Authorization: Bearer` in `headers`, which `bearerTokenEnv` now covers for
pre-obtained tokens. `claude-agent-acp` 0.75.1 bridges Claude Code's startup
OAuth to ACP `elicitation/create { mode: "url" }` when the client advertises
`clientCapabilities.elicitation.url`; the callback listener lives on the
adapter host. Our supervisor advertises only `fs`
([`supervisor/src/adapter-registry.ts`](../../supervisor/src/adapter-registry.ts)).
Codex authorizes only through `codex mcp login`. Owner direction: the feature
earns its place with platform-wide OAuth, where a MAIster user identity issues
per-user tokens to MCPs and a launch shows "this run acts on your behalf; your
token is used for MCPs X, Y". Until then: a note in the ADR, and the hub may
surface `needs-auth` if an adapter reports it.

## 10. JSON import (deferred, D5)

Sources that share the `{"mcpServers": {"<name>": {...}}}` shape: Claude Code
`.mcp.json` and `~/.claude.json`, Claude Desktop `claude_desktop_config.json`,
Cursor `mcp.json`, Windsurf. VS Code `.vscode/mcp.json` uses `"servers"` plus
`inputs`. Gemini `settings.json` uses `mcpServers` with `httpUrl` for
streamable HTTP. Codex `config.toml` is TOML and out of scope. Mapping when it
lands: `${VAR}` / `${VAR:-default}` → `env:VAR` (default dropped and flagged),
`Authorization: Bearer ${VAR}` → `bearerTokenEnv: env:VAR`, other
placeholders kept as literals for the operator to replace, `streamable-http`
→ `http`, `httpUrl` → `url` + `http`, `ws`/`acp` refused. A preview of the
effective ACP shape (references shown unresolved) is the same component in
read mode.

## 11. Open point

- Confirm that overlay values use the same grammar as server values
  (`literal | env:NAME`). Today `envRemap` is `env:NAME`-only while
  `argsOverride`/`urlOverride` are already literal. One grammar means one
  validator, an unchanged wire, and a project can override a non-secret
  literal such as `GH_HOST` without a host variable. Existing overlay rows
  stay valid. If declined, `envRemap`/`headerRemap` keep the `env:NAME`-only
  rule.
- ADR number: the next free one at implementation time (ADR-176 is the
  latest as of this document).

## 12. Plan (one commit per item, TDD)

| # | Item | Verify |
| --- | --- | --- |
| 0 | This document + `docs/plans/README.md` row | `pnpm validate:docs` |
| 1 | ADR (amends ADR-070/129, notes ADR-089/166), spec non-goal reworded | `pnpm validate:docs:adr` |
| 2 | Supervisor: `mcp-values.ts`, schema maps + `bearerTokenEnv` (strict, legacy keys rejected), acp-client and probe mapping, `POST /diagnostics/env-refs`, supervisor OpenAPI | supervisor unit: resolver (literal/env/missing/bearer), schema, route bounds and no values, ACP `EnvVariable`/`HttpHeader` shape incl. composed `Authorization` |
| 3 | Web model: schema, migration, grammar + warning heuristic in `mcp-form.ts`, projection, catalog ingestion, project material, `agent-map`, overlay apply (value remap), slot validation, readiness + `checkEnvRefs`, probe service, seed, raw-SQL sweep | unit + real-PG integration: backfill, secret-invariant sentinel, overlay integration; `overlay-apply` rewritten to "key preserved, source replaced" and shown red against the old code |
| 4 | Transport gate + codex `mcpTransports` | gate unit: withheld reason persisted, required → `EXECUTOR_UNAVAILABLE`; adapter-support test |
| 5 | Package manifest map + headers + bearer, attach ingestion, Studio editor | manifest schema tests incl. legacy array; attach integration |
| 6 | UI: `KeyValueRows`, runner modal swap, both MCP modals, overlay dialog, EN/RU | jsdom tests per surface; `pnpm --filter maister-web lint` (it rewrites files — check `git status` before staging); typecheck |
| 7 | Docs truth pass: `mcp-management.md`, `capabilities.md`, `configuration.md`, `acp-runners.md` note, screens, web OpenAPI, ERD | `pnpm validate:docs:all` |
| 8 | Full lanes against the master baseline; zero integration failures expected on this host | lane summaries |
