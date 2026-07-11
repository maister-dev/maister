# Capability Enforcement Flip — instructed → enforced at the supervisor ACP seam

> Branch: `claude/capability-enforcement-acp-seam-7f6053` · Created: 2026-07-11
> Base: `main` @ `52e72ade3` (worktree HEAD `5916d4ea8` = one ai-factory chore atop base; code anchors intact)
> Milestone: **completes the deferred enforcement half of M14** (unblocks ADR-041/042)
> ADR: **ADR-129** (contested three-way — see §Numbering) · Migration: **none** · Engine: **no bump**

## Goal

`enforcement: strict` on seam-coverable capability classes becomes **launchable and
actually enforced**, identically across adapters, via a new adapter-agnostic
`capability_guard` interceptor at the supervisor ACP seam (reusing the M40
guardrail substrate), gated per-adapter by cached live-smoke evidence.
`ENFORCEABILITY_BY_AGENT` stops being a frozen lie: `TODO(M14)` disappears from
`web/lib/flows/enforcement.ts`, and the ADR-032 invariant (strict never silently
degrades to instruction) holds everywhere.

**Success = the six behavioral acceptance criteria in §Acceptance all pass.**

## Settings

- **Testing**: yes — SDD + TDD. Every phase names its runner project and exits on a green suite.
- **Logging**: **verbose** (DEBUG). Every `capability_guard` decision (allow/deny + reason + tool identity + kind + path), profile digest on delivery, and escalation-counter transition is logged at DEBUG (supervisor) / DEBUG (web materialization). Secret values never logged (env NAMES only).
- **Docs**: **mandatory** — docs-first Phase 0 gate; docs changes route through `/aif-docs`. `/aif-implement` shows the mandatory documentation checkpoint at completion.

## Roadmap Linkage

- **Milestone**: `M14. Scoped capability materialization` (`.ai-factory/ROADMAP.md:207`, currently `[ ]`).
- **Rationale**: M14's own text — *"turns M11c node settings from descriptive YAML into enforceable runtime boundaries where the adapter supports enforcement"*, enforceability `enforced | instructed | unsupported` — is precisely this plan. M14 materialization shipped instructed-only; this is its enforcement half. On completion, `/aif-verify` checks the linkage; the milestone's "scoped materialization" + "trust/install UX" expectations are already met, and this plan closes the "where the adapter supports enforcement" clause.

---

## Load-bearing design (frozen at Phase 0 — the SDD is the SSOT; this is the summary)

All decisions below are owner-locked (D1/D3/W-C/W-D) or code-verified during planning.
Do not silently walk them back — reopen only with new evidence, and record it in ADR-129.

### DES-1 · `capability_guard` is a derived-only interceptor rule (D3)

- A new guardrail rule kind `capability_guard` lives **beside** `path_guard` in the
  supervisor interceptor (`supervisor/src/guardrail-hooks.ts` + `acp-client.ts`
  `requestPermission`). It is **adapter-agnostic by construction** — same seam, same
  deny-and-continue substrate as M40.
- It is **NOT** added to the flow-authorable `hooksSettingsSchema`
  (`web/lib/config.schema.ts:636-663`). It is **derived** by the web tier from the
  node/agent capability `settings` (`tools`/`mcps`/`restrictions`/`workspaceAccess`)
  filtered to classes declared `enforcement.<class>: strict` and enforceable.
  → **no engine bump** (no new authored manifest surface; ADR-129 documents why).
- The interceptor contract must **not preclude** a future generic ALLOW/DENY/ASK policy
  layer (separate plan) — the profile is a data input, not a policy language.

### DES-2 · The enforcement PROFILE and its delivery (W-B)

- New derived type `SessionEnforcementProfile` carried on a **new** session-create field
  `enforcementProfile` (distinct from the existing `capabilityProfilePath` M14 field and
  the platform-agent `capability_profile` frontmatter — naming collision avoided).
  Shape (frozen in Phase 0 SDD), per strictly-enforced class only:
  ```ts
  type SessionEnforcementProfile = {
    // present ⟺ `tools` strict+enforced. Allow-list of tool NAMES for the resolved
    // adapter (derived from settings.tools[resolvedAgent]). Tool-kind calls whose
    // identity ∉ set → deny. Empty/undefined allow-set under strict = CONFIG refusal
    // at launch (cannot enforce an undeclared allow-set — DES-7).
    tools?: { allow: string[] };
    // present ⟺ `mcps` strict+enforced. Allow-list of MCP server namespaces
    // (server LIST already gated at session/new; this enforces per-CALL).
    mcps?: { allowServers: string[] };
    // present ⟺ tool-shaped `restrictions` strict. (Path-shaped restrictions reuse
    // path_guard's allowedPaths — NOT re-implemented here.)
    deniedTools?: string[];
    // audit only: which classes this profile enforces, for the snapshot + logs.
    enforcedClasses: Array<"tools" | "mcps" | "restrictions">;
  };
  ```
- Delivered on `CreateSessionInput` (`web/lib/supervisor-client.ts:89-124`) alongside
  `hooksConfig`/`mcpServers`/`capabilityProfilePath`, threaded through
  `runner-graph.ts` → `runner-agent.ts` `createInput` → `StartSessionRequestSchema`
  (`supervisor/src/types.ts:168-271`), stored on `SessionRecord`
  (`supervisor/src/types.ts:443-501`), seeded at `spawn.ts:301-327`.
- Recorded in `node_attempts.materialization_plan` + `node_attempts.enforcement_snapshot`
  (both jsonb, `schema.ts:2324-2336`) exactly as M14 does today.
- **Folded into `profileDigest`** (`capabilities/resolver.ts:223-226,409`) so the
  existing long-lived-session consistency guard (`runner-agent.ts:135-150`) catches a
  mid-session enforcement change → refuse without a declared session boundary (W-B).

### DES-3 · Interceptor semantics + waterfall placement (W-A, D1)

Verified waterfall in `acp-client.ts` `requestPermission` (:437):
`L1 readOnlySession → L2 readOnlyTurn → M40 guardrails → B1 autoApprove → HITL`.
`capability_guard` slots **inside the guardrail block, after `path_guard`, before B1**
(same rationale M40 used: must win over auto-approve so an out-of-profile call is denied
even on unattended/auto-approve sessions).

Enforcement is armed whenever a class is declared `strict` (per Resolved-Decision 3 —
**not** gated on unattended/auto-approve; scratch runs carry no enforcement settings and
are naturally exempt). Per intercepted `requestPermission` (only when
`record.enforcementProfile` is present):
- **Call governed by a strict class** (a tool-kind call when `tools` enforced; an MCP
  tool call when `mcps` enforced; a tool-shaped restriction):
  - **in-profile** → resolve inline as `{ selected, optionId: <allow-shaped> }`
    (auto-allow; zero added HITL). Reset `record.capabilityDenyCount = 0`.
  - **out-of-profile** → `{ cancelled }` (deny-and-continue), `emitHookTrip("capability_guard", toolCall)` disposition `deny` (record-only downstream, like `path_guard`), `record.capabilityDenyCount += 1`, log the structured reason.
  - **Nth consecutive out-of-profile** (N default 3, env-tunable) → set
    `record.hookHalted = true`, emit `capability_guard` **halt** escalation, cancel every
    pending deferred for the session (mirror `no_progress`), and reset the counter.
    → web tier escalates via the existing `hook_trip` path (DES-5).
- **Call NOT governed by any strict class** → fall through unchanged to B1/HITL (today's
  UX preserved for non-enforced classes; enforcement only auto-decides the enforced subset).

**Deferred-release invariant (skill-context: deferred-release on every failure path):**
auto-decided calls (allow/deny) resolve the RPC **synchronously inside `requestPermission`
— no `pendingPermissions.register` runs for them**, so no deferred leaks. The Nth-denial
halt cancels all *other* pending deferreds via
`pendingPermissions.requestIds(sessionId).forEach(cancel)` (verified pattern,
`acp-client.ts:599`). Any throw inside profile evaluation must fall through to a deny +
release, never leave the RPC unresolved (regression test required, DES per skill-context).

### DES-4 · Permission-mode ownership + always-ask (W-C, D5)

- "Always-ask" is **emergent, not a wire field** (verified): it is
  `runner.permissionPolicy = "default"` (no `--dangerously-skip-permissions`), under
  which the adapter itself issues `session/request_permission` for tool calls it deems
  needing approval, so the seam sees them pre-execution. An enforced session is therefore
  spawned with `permissionPolicy = "default"`; the supervisor becomes the permission
  authority (auto-allow in-profile). The `permissionMode` class flips to **enforced by
  construction**.
- **New launch refusal (there is none today):** `enforcement.<class>: strict` (an armed
  `enforcementProfile`) + a runner whose `permissionPolicy = "dangerously_skip_permissions"`
  → **refuse launch** (`EXECUTOR_UNAVAILABLE`, message names the conflict). Under
  skip-permissions the adapter never calls `requestPermission`, so the seam is structurally
  inert — enforcing would be a silent lie (ADR-032 violation). Mirror the existing
  `web/lib/acp-runners/resolve.ts:226-233` refusal shape.
- **D5 runtime sentinel (owner-locked: fail-closed halt + hook_trip):** for an enforced
  session, if a **WRITE_KINDS `session/update` tool_call** is observed whose `toolCallId`
  was never arbitrated by `capability_guard` (adapter stopped honoring always-ask
  mid-session), latch `hookHalted` + emit a `capability_guard` halt escalation. Hooks into
  the existing `session/update` handler that already feeds `classifyProgressUpdate`
  (`acp-client.ts:395-434`).

### DES-5 · Escalation reuses the M40 `hook_trip` HITL path (W-A)

- `HookRule` union widens: `"path_guard" | "repetition" | "no_progress" | "capability_guard"`
  (`supervisor/src/types.ts:346`). `HOOK_RULE_META` gains a `capability_guard` entry
  (`guardrail-hooks.ts:200`) — lifecycle `pre_tool_call`. Because `capability_guard` is
  dual-disposition (per-call `deny`, Nth-denial `halt`), the halt emit passes the
  disposition explicitly rather than reading a single frozen value (small `emitHookTrip`
  extension; documented in SDD).
- Web mirror `SupervisorEvent` (`supervisor-client.ts:367-379`) + SSE contract
  (`supervisor-sse.asyncapi.yaml:445-478` rule enum) gain `capability_guard`.
- `HookTripHaltRule` widens to include `"capability_guard"`
  (`web/lib/runs/hook-trip.ts:37`); the two consumers (`runner-agent.ts:543-593` flow,
  `launch.ts:3083-3127` agent) map it into `escalateHookTrip` unchanged. The `hook_trip`
  HITL row (`kind:"hook_trip"`, `decisions:["resume","abort"]`), the human-actor-only
  guard (`hitl.ts:3416-3435`), and the resume path (`handleHookTripResponse`) are **reused
  as-is** — no new HITL kind, no new MaisterError code.

### DES-6 · Evidence-gated per-adapter flip via a new smoke dimension (D2/W-D/W-F)

- New optional dimension `capabilityEnforcement` on `AdapterSmokeCacheEntry`
  (`adapter-smoke-cache.ts:10-21`), **mirroring `readOnlySession`** exactly (same
  `{status, reason?, checkedAt, protocolVersion?}` shape, same demote-to-generic rule,
  same diagnostic surfacing through `GET /diagnostics`).
- `capabilityEnforcementSmoke: "required"` for **all five** adapters on `AdapterRuntime`
  (`adapter-registry.ts`) + the web mirror `ADAPTER_SUPPORT`
  (`web/lib/acp-runners/adapter-support.ts`) — unlike `readOnlySession`, claude/codex are
  also `required` (Blocking Spike #1 must prove them).
- The smoke script (`supervisor/scripts/smoke-acp-adapter.ts`) gains a
  `--capability-enforcement` probe (DES-8).
- **Table + gate:** `ENFORCEABILITY_BY_AGENT` (`enforcement.ts:35-81`) flips the five
  seam-coverable classes (`tools`, `mcps`, `restrictions`, `permissionMode`,
  `workspaceAccess`) to `"enforced"` for **all** adapters (the interceptor is
  adapter-agnostic); `hooks` is corrected to `"enforced"` (it already is, since M40);
  `skills` stays `"instructed"` with a permanent documented comment. A new **async**
  launch gate `assertEnforcementEvidence(...)` (mirror `assertReadOnlySessionEvidence`,
  `launch.ts:465-496`) refuses a strict-enforced launch when the resolved adapter's
  `capabilityEnforcement` smoke ≠ `ok`, with a diagnostic **naming the missing evidence**.
  Net effect: claude/codex enforce **after their smoke is cached ok** (operator ritual);
  gemini/opencode/mimo refuse-with-evidence-diagnostic until theirs lands; `skills` strict
  always refuses with the documented "not a tool call, not seam-interceptable" reason.
- **Grep-sentinel:** all **12** `TODO(M14)` comments in `enforcement.ts` (lines 37-42
  claude, 46-51 codex) are removed — 10 become `enforced`, the 2 `skills` cells become a
  permanent documented-instructed comment.

### DES-7 · Profile derivation posture (allow-list, ADR-032-safe)

- `tools` is a **per-agent-keyed allow-list** (`agentToolsSchema`, `config.schema.ts:665-673`):
  the enforced allow-set = `settings.tools[resolvedAgent]`. **Allow-list, never deny-list**
  (skill-context rule). If a class is declared `strict` but the resolved adapter has **no
  declared allow-set** for it, launch **refuses** (`CONFIG`, "strict enforcement requires a
  declared allow-set for <class> on <agent>") — never silently enforce-nothing (ADR-032:
  strict never degrades).
- `mcps` enforced allow-set = the resolved MCP server namespaces (already computed for
  session/new delivery); per-call denial for a server outside it.
- Node-level `workspaceAccess ∈ {read,write,none}` (`config.schema.ts:828`) is a
  **different** enum from the platform-agent `workspace ∈ {none,repo_read,worktree}`
  (`definition.ts:232`) — do not conflate; `workspaceAccess` enforcement reuses the M34
  L1–L3 read-only stack, not `capability_guard`.

### DES-8 · The tool-identity risk (Blocking Spike #1 — make-or-break per adapter)

Verified: the seam today reads only `kind` + `locations[0].path`
(`GuardrailToolCall`, `guardrail-hooks.ts:23-30`). `capability_guard` needs **tool
identity** (tool name + MCP server namespace). The raw `params.toolCall` **does** carry
more on the wire (`rawInput`/`title` — parsed elsewhere at
`web/lib/run-transcript/transcript.ts:240-320`) but is **not** in the narrowed guard type.
Spike #1 must confirm, **per adapter (claude-agent-acp, codex-acp)**:
(a) `requestPermission` fires for **every** WRITE_KINDS tool call under `permissionPolicy=default`
(no silent execution); (b) `params.toolCall` carries a **stable tool-name identifier** and,
for MCP calls, a **resolvable server namespace**; (c) per-call deferred latency is
negligible vs agent latency (report numbers). **Graceful degradation:** whichever adapter's
smoke proves (a)+(b) enforces; any adapter that fails refuses-with-diagnostic (ADR-032-safe,
never a false-enforce). This is why the flip is evidence-gated, not a hard prerequisite.

### DES-9 · In-flight run upgrade semantics (D4)

- `enforcement_snapshot` and the derived `enforcementProfile` are **per node-attempt**,
  computed at node dispatch (`runner-graph.ts:2580`). **Resume of an existing attempt reads
  the persisted snapshot/profile — it does NOT recompute against the live (post-flip)
  table** (skill-context: persist the launch-time decision the terminal path reads). A
  **fresh** attempt (new node, or a relaunch) computes fresh against the current table.
  Confirm no resume path (`runFlow`, `claimAndResumeAgentRun`) re-evaluates a *resumed*
  attempt with the new table mid-run (dedicated test).

---

## Contract surfaces → spec files (skill-context: trace every contract surface)

| Surface changed | Spec file(s) that MUST move in the same change |
| --- | --- |
| `POST /sessions` body gains `enforcementProfile` | `docs/api/supervisor.openapi.yaml` (`StartSessionRequest`) + `docs/supervisor.md` prose |
| `session.hook_trip` SSE `rule` enum gains `capability_guard` | `docs/api/async/supervisor-sse.asyncapi.yaml` (`SessionHookTripEvent`) |
| New guardrail rule kind + rule×lifecycle×disposition | `docs/system-analytics/guardrail-hooks.md` (rule matrix, waterfall, breaker, D5 sentinel) |
| `ENFORCEABILITY_BY_AGENT` flip + evidence gate | `docs/system-analytics/flow-settings.md` (all 3 FROZEN SPEC tables) + `docs/system-analytics/capabilities.md` (per-cell mechanism table) |
| Agent `capability_profile` enforcement note | `docs/system-analytics/agents.md` |
| New env vars | `docs/configuration.md` env-var table + `.env.example` |
| New smoke dimension + operator ritual | `docs/getting-started.md` "Scripts" (`pnpm smoke:acp`) + a ritual checklist |
| ADR | `docs/decisions.md` (`### ADR-129`) |
| Analytics doc status flip + index | `docs/system-analytics/guardrail-hooks.md` (Designed→Implemented, R5/R6) + the `docs/CLAUDE.md` doc-index row |
| No new domain error code | `docs/error-taxonomy.md` — confirm reuse of `CONFIG`/`PRECONDITION`/`EXECUTOR_UNAVAILABLE`; no edit unless reuse proven insufficient |

**In-code SSOTs** (skill-context): the guard tool-identity contract is shipped to no
agent-facing grammar/prompt file, so no `flow-dsl-grammar.ts` drift. Confirm during Phase 0.

## Deployment touchpoints (skill-context: enumerate every new env var)

| New env var | Read by | Lands in |
| --- | --- | --- |
| `MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD` (default 3, N) | supervisor interceptor (via web-resolved value on the profile) + web resolver | `.env.example` + `compose.yml` (web **and** supervisor `environment:`) + prod overlay if present + `docs/configuration.md` |
| `MAISTER_ADAPTER_SMOKE_CACHE_PATH` (already exists) | supervisor smoke cache | verify present; e2e overrides it to seed mock-adapter evidence |

N is resolved web-side (like `MAISTER_HOOK_REPETITION_MAX`) and delivered on the profile,
so the supervisor stays config-free for the threshold (matches the M40 pattern). If instead
the supervisor reads N directly, it must appear in **both** service `environment:` blocks.

## Fan-out consumers (skill-context: fan a new enum value to ALL consumers; allow-list guards)

`capability_guard` is a new value in three unions/enums — grep each into every consumer:
- `HookRule` (`supervisor/src/types.ts:346`) → `HOOK_RULE_META` (exhaustive `Record`, TS-enforced), `emitHookTrip`, the SSE mirror, the asyncapi enum.
- `HookTripHaltRule` (`hook-trip.ts:37`) → the flow consumer (`runner-agent.ts:543-593`) and agent consumer (`launch.ts:3083-3127`) `haltRule` maps; the scratch consumer (`scratch-runs/events.ts:588-608`) stays notify-only (confirm).
- `hitl_requests.kind` / `assignments.actionKind` already carry `hook_trip` — **reused, no new value** (no migration).
Guards are **allow-list** (DES-7): in-profile = an explicit allow-set membership test, never a deny-list complement. The evidence gate admits an adapter only when smoke `=== "ok"` (allow-list), refusing every other status by default.

## Numbering & process (skill-context: reserve numbers up front; budget a renumber pass)

- **ADR-129** — next free at HEAD is 129 (`docs/decisions.md` max = ADR-128; 123 absent).
  **Four-way contested**: `enforcement-flip` (this) + `postgres-graph-cutover` +
  `agent-format-superset` + `fork-loop` all target 129, none landed. Whoever lands
  2nd/3rd/4th renumbers to 130/131/132. **Re-grep `docs/decisions.md` at implementation
  entry** and again before merge. (`fork-loop` also takes one migration + no engine bump;
  this plan takes neither a migration nor an engine bump, so only the ADR number collides.)
  ADR-129 amends/executes ADR-042 (generalizes claude-first-per-cell → adapter-agnostic
  seam), unblocks the ADR-041 gating notes, and corrects the `hooks`-cell label. Never
  renumber ADR-041/042/044 history.
- **Migration: none.** Verified: no `pgEnum` in the repo; guardrail rule kinds are jsonb
  keys + TS unions; `enforcement_snapshot`/`materialization_plan` are existing jsonb columns;
  `hitl_requests.kind`/`assignments.actionKind` already include `hook_trip`. Precedent for a
  DB-layer no-op is `0066_hook_trip.sql` (a documentation marker). **Do not take migration
  0093** (contested with the cutover plan) — this change needs no DDL; ADR-129 records the
  no-op rationale.
- **Engine: no bump.** No new authored manifest surface (DES-1). Document in ADR-129.
- **No code overlap** with the parallel Postgres/graph cut-over plan (`enforcement.ts`,
  `guardrail-hooks.ts`, `acp-client.ts`, `adapter-*` are untouched there). Note both in the
  rebase section of each plan.
- **Renumber pass** is an explicit deliverable (T5.4), run in its own focused session AFTER
  rebasing onto main: re-grep ADR number, run `scripts/validate-docs-adr-anchors.mjs`
  (a green `pnpm validate:docs` is NOT evidence for ADR numbering), fold any
  mid-implementation surprises back into this plan.

## Gates (every phase exits on these where applicable)

`pnpm --filter maister-web typecheck` · `pnpm --filter @maister/supervisor typecheck` ·
`pnpm test:unit` (web + supervisor) · `pnpm test:integration` (real Postgres — set `DB_URL`,
integration tests must run, not skip — [[vitest-integration-db-url-gotcha]]) ·
`pnpm test:e2e` (mock-ACP) · `pnpm validate:docs:all` + ADR-anchor check ·
**`pnpm --filter maister-web db:generate` reports "No schema changes"** (proves migration-free) ·
i18n EN+RU parity for every new string.

---

## Implementation discipline (SDD + TDD — applies to every task)

**SDD (spec-driven).** Phase 0 artifacts are the **single source of truth**; no code phase
starts until the T0.5 completeness/consistency audit signs off. Implementation is **fully
consistent to the specs** — if a spec proves wrong or incomplete mid-build, fix the doc first
(docs-first), re-run the affected slice of T0.5, then code. Every functional requirement is
enumerated in the **T0.6 REQ→AC→test matrix**; nothing is built that isn't traced to a REQ,
and no REQ ships without a test proving its acceptance criterion.

**TDD (test-first, per code task).** Every code task follows **RED → GREEN → refactor**:
1. **RED** — write the failing test(s) first, one per REQ/AC + each enumerated edge case.
2. **GREEN** — minimum implementation to pass; no code beyond what a test demands.
3. **Refactor** — clean under green (SOLID/KISS/DRY) with the suite staying green.

Test-suite contract: cover **all** required functionality **and** the edge cases each task
enumerates; **minimum overlap** (one behavior asserted in one place); **no trivial tests**
(no asserting constants, getters, or framework behavior); each test names the REQ/AC it
proves. Behavior-changing tasks migrate the assertions they invalidate in the same phase
(named test files), never leaving red.

**Code quality.** SOLID — single-responsibility split across *evaluate* (`guardrail-hooks.ts`
pure), *deliver* (web resolver/materialize), *gate* (launch evidence check); the `HookRule`
union is the open/closed extension point (new rule kinds add a case, don't edit callers).
KISS — reuse the M40 substrate + M34 readOnly precedent; add no new abstraction a test doesn't
force. DRY — single-source `WRITE_KINDS`, the tool-identity extractor, and the deny-reason
strings (one i18n catalog); the twin adapter tables (`adapter-registry.ts` ↔
`adapter-support.ts`) get a **sync test** so they cannot drift. Project conventions —
`MaisterError` codes (never plain `Error`), `atomicWriteJson` for `.maister/`, no `any`
without `// FIXME(any):`, server-only secrets (env NAMES only), EN+RU for every user string.

## Tasks

### Phase 0 — SDD + analytics spec (docs-first gate; NO code) — Commit A

**T0.1 · Reserve ADR-129 + write the SDD/decision stub.** — ✅ DONE (ADR-129 body + Index row; anchor validated; honest 3-class-flip scope recorded with evidence)
Re-grep `docs/decisions.md` for the max ADR at HEAD (expect 128 → 129). Write
`### ADR-129: Adapter-agnostic capability enforcement at the ACP seam` (executes ADR-042's
authorized flip generalized to the seam; unblocks ADR-041 gating; corrects the `hooks`
label; records **no migration / no engine bump** rationale; contest note naming the two
siblings). Include the D1/D3/W-C/D2/D4/D5 decisions verbatim.
*Deliverable*: ADR-129 section. *Logging*: n/a (docs). *Verify*: anchor resolves via `scripts/validate-docs-adr-anchors.mjs`; ADR records the migration-free/no-engine-bump rationale that T5.5 proves via `db:generate`.

**T0.2 · Author the SDD (analytics) as the implementation SSOT.** — ✅ DONE (guardrail-hooks.md: capability_guard rule row + dual-disposition, waterfall placement, N-breaker, D5 sentinel, deferred-release invariant, evidence gate, derivation posture, Expectations + Edge cases blocks, Linked artifacts; doc-index row updated)
Write/extend `docs/system-analytics/guardrail-hooks.md` following **docs/CLAUDE.md R5**
structure (Purpose · Domain entities · State machine · Process flows · **Expectations** per
R5a acceptance-contract rules · **Edge cases** · Linked artifacts) and **R6** status tags —
**flip the doc's tag `Designed — M40` → `Implemented`** (M40 shipped) and add: the
`capability_guard` rule row (rule × lifecycle × dual-disposition), the **exact waterfall
placement** (after `path_guard`, before B1), the **N-consecutive breaker** (per-call deny →
Nth halt), the **D5 sentinel**, and the **deferred-release invariant**. State every state
transition and every refusal/precondition **exactly as the code will gate** (allow-list,
DES-7). Update the `docs/CLAUDE.md` doc-index row for `guardrail-hooks.md`.
*Deliverable*: R5/R6-compliant doc with concrete Expectations + Edge cases.
*Verify*: peer-consistent with T0.3/T0.4 tables (no contradiction); R5 sections all present.

**T0.3 · Flip the frozen truth tables in the docs (as the spec, ahead of code).** — ✅ DONE (flow-settings.md: header note rewritten, ENFORCEABILITY table flipped tools/mcps/hooks→enforced all 5 adapters + evidence gate, hooks rationale corrected, stale Expectations fixed; capabilities.md: per-cell mechanism table → capability_guard, status + Expectations reconciled)
Update `docs/system-analytics/flow-settings.md` (all three FROZEN SPEC tables:
`ENFORCEABILITY_BY_AGENT`, the `evaluateNodeEnforcement` truth table is unchanged, the
launch-refusal allow-list gains the evidence gate) and `docs/system-analytics/capabilities.md`
(per-cell mechanism table → `capability_guard` / reused-seam per class; `skills` documented
permanent-instructed). Reconcile the `hooks`-cell rationale (`flow-settings.md:243-250`) with
the corrected `enforced` label.
*Deliverable*: doc tables matching DES-6/DES-7. *Verify*: `skills` row explicitly documents why it stays instructed.

**T0.4 · Author the wire/API + config specs.** — ✅ DONE (supervisor.openapi.yaml: enforcementProfile + capabilityEnforcement smoke dimension; supervisor-sse.asyncapi.yaml + web-runs mirror: capability_guard rule enum; configuration.md: MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD row; agents.md: capability_profile enforcement note; getting-started.md: smoke:acp + ritual; error-taxonomy.md reuse confirmed — no edit, recorded in ADR-129)
`docs/api/supervisor.openapi.yaml` (`StartSessionRequest.enforcementProfile` shape per DES-2),
`docs/api/async/supervisor-sse.asyncapi.yaml` (`SessionHookTripEvent.rule` enum + `capability_guard`),
`docs/configuration.md` (new env var row), `docs/system-analytics/agents.md` (agent
`capability_profile` enforcement note), and the operator-ritual checklist appended to the
smoke-cache doc + `docs/getting-started.md` Scripts. Confirm `docs/error-taxonomy.md` needs
**no** new code (reuse `CONFIG`/`PRECONDITION`/`EXECUTOR_UNAVAILABLE`) — record the reuse
argument in the ADR.
*Deliverable*: all contract specs from §Contract surfaces. *Verify*: `pnpm validate:docs:all` green; every §Contract-surfaces row has a corresponding edit.

**T0.6 · Requirements → Acceptance → Test traceability matrix.** — ✅ DONE (27 REQs mapped to AC + exact test/layer/phase; AC coverage check; in the plan §T0.6)
Enumerate functional requirements `REQ-1..n` (each a concrete *"the system MUST …"*: profile
derivation, allow-list posture, CONFIG-on-undeclared-allow-set, in-profile auto-allow,
out-of-profile deny + reason, N-consecutive halt, D5 sentinel, skip-permissions refusal,
evidence gate per adapter, resume-reads-snapshot, digest drift-guard, table flip, skills
refusal, UX states, i18n). Map each REQ → an **observable acceptance criterion** → the
**exact test(s) + layer** (unit / integration / e2e) that prove it. The coverage contract:
every REQ has ≥1 test; **no REQ without a test; no test without a REQ**; overlaps flagged and
collapsed; trivial tests excluded. Lives in the plan (a matrix table) + linked from the SDD.
*Deliverable*: the REQ→AC→test matrix. *Verify*: every §Acceptance criterion appears as ≥1 REQ; every Phase 2-5 test task cites its REQ id(s).

**T0.5 · Spec completeness & consistency audit (Phase-0 EXIT GATE — no code before it).** — ✅ DONE (signed-off audit appended to SDD, zero open items; fullness/consistency/no-logical-holes/allow-list-gates all verified; mermaid 23/23 + ADR anchors 324 + OpenAPI/AsyncAPI parse green; **Phase 0 exit gate PASSED**)
Adversarial self-review of **all** Phase-0 artifacts (T0.1-T0.4 + T0.6). Checklist, each item
signed off:
- **Fullness** — every capability class has `{mechanism, expectation, acceptance, edge-cases}`
  defined; every REQ has an AC and a planned test; no "TBD".
- **Consistency** — no contradiction across `guardrail-hooks.md` ↔ `flow-settings.md` ↔
  `capabilities.md` ↔ `supervisor.openapi.yaml` ↔ `supervisor-sse.asyncapi.yaml` ↔ ADR-129 ↔
  the REQ matrix (rule names, enum values, field shapes, refusal messages all agree).
- **No logical holes** — each named hole has a written resolution: two-strict-class precedence
  (which class governs a call matching both `tools` and `mcps`); missing/ambiguous tool
  identity; in-profile-vs-fallthrough for ungoverned calls; resume-reads-snapshot vs
  fresh-attempt-recompute (D4); enforced × auto-approve interaction; scratch-run exemption.
- **Gates stated as code will implement them** — every refusal is an **allow-list**, never a
  deny-list complement.
*Deliverable*: signed-off audit checklist appended to the SDD. *Verify*: **zero open items**; T5.5 re-runs it against the shipped code as a drift check. **BLOCKS Phase 1.**

> **Phase 0 exit gate:** T0.1-T0.6 complete; the T0.5 audit checklist has **zero open items**;
> R5/R6-compliant analytics + API specs + ADR internally consistent; REQ matrix covers every
> §Acceptance criterion. No code phase starts until this is true. **Commit A.**

### Phase 1 — Blocking Spike #1: adapter evidence + smoke dimension — Commit B

**T1.1 · Add the `capabilityEnforcement` smoke dimension (mirror `readOnlySession`).** — ✅ DONE (adapter-smoke-cache.ts schema+diagnostic+resolver+write-merge; adapter-registry.ts + adapter-support.ts field on all 5 = required; wire schemas in types.ts + supervisor-client.ts; mirror tests both sides; migrated 5 diagnostics fixtures; TDD RED→GREEN)
`supervisor/src/adapter-smoke-cache.ts`: new optional key on `AdapterSmokeCacheEntry` +
`AdapterSmokeDiagnostic` + the per-dimension resolver (demote-to-generic rule) +
`writeAdapterSmokeCache` entry field. `supervisor/src/adapter-registry.ts` +
`web/lib/acp-runners/adapter-support.ts`: `capabilityEnforcementSmoke: "required"` for all
five adapters (keep the two tables hand-synced — add a sync test if one exists for readOnly).
*Files*: `adapter-smoke-cache.ts`, `adapter-registry.ts`, `adapter-support.ts`.
*Logging*: DEBUG on diagnostic derivation (`adapter`, dimension `status`, `reason`).
*Verify*: unit tests mirroring the readOnlySession dimension tests (pending/ok/error/demote).

**T1.2 · Extend the smoke script with a `--capability-enforcement` probe (DES-8).** — ✅ DONE (shared `extractToolIdentity`/`mcpServerFromToolName` in guardrail-hooks.ts + unit test; probe client + summarizer + driver in smoke-acp-adapter.ts; `--capability-enforcement` CLI flag + cache-write + exit-gate; mock `tool-name:X` hint; script test GREEN on mock-ACP)
`supervisor/scripts/smoke-acp-adapter.ts`: drive a real adapter with `permissionPolicy=default`
and assert (a) `requestPermission` fires for every WRITE_KINDS probe, (b) `params.toolCall`
carries a stable tool-name + (for an MCP probe) a resolvable server namespace, (c) record
per-call latency. Write the result under `cache.adapters[<adapter>].capabilityEnforcement`.
Reuse the production arbitration path where possible (as the readOnly probe reuses
`resolveReadOnlySessionDecision`).
*Logging*: INFO summary per adapter (observed kinds, identity field name, latency ms).
*Verify*: script runs green against the mock-ACP adapter in CI; documents the live ritual for claude/codex.

**T1.3 · Operator-ritual checklist deliverable (W-F) + fold the M40 native-hook residual.** — ✅ DONE (guardrail-hooks.md "Operator evidence ritual" section: pass/fail table for both dimensions, CI-vs-live split, M40 native-hook residual folded per Resolved-Decision 5; getting-started.md ritual commands from T0.4)
A repeatable checklist/script (docs + a `pnpm` entry if useful) caching the new dimension per
adapter; CI runs the mock-ACP proof, live confirmation is the documented ritual. Fold the
existing M40 native-hook live-verification residual into this same checklist.
*Deliverable*: ritual doc + the pass/fail criteria table. *Verify*: checklist references the exact `pnpm smoke:acp --capability-enforcement` invocation and cache path.

> **Commit B.** Gate: supervisor typecheck + unit green; smoke script green on mock-ACP.

### Phase 2 — Supervisor: capability_guard evaluator + interceptor + sentinel — Commit C

**T2.1 · Wire type + record + rule-kind widening (TDD).** — ✅ DONE (SessionEnforcementProfileSchema + StartSessionRequestSchema.enforcementProfile; SessionRecord.enforcementProfile/capabilityDenyCount/arbitratedIds; HookRule widened; spawn seeding; escalationThreshold on profile + docs; 12 schema tests)
`supervisor/src/types.ts`: `StartSessionRequestSchema.enforcementProfile` (zod, strict,
optional, DES-2 shape); `SessionRecord.enforcementProfile` + `capabilityDenyCount?`; widen
`HookRule` with `"capability_guard"`; `emitHookTrip` disposition extension (DES-5).
`supervisor/src/spawn.ts:301-327`: seed `enforcementProfile` + `capabilityDenyCount: 0`.
*Logging*: DEBUG on spawn: `enforcedClasses`, profile digest.
*Verify*: unit — `StartSessionRequestSchema` accepts/rejects the profile shape; record seeded.

**T2.2 · `resolveCapabilityGuardDecision` evaluator (pure, TDD-first).** — ✅ DONE (pure evaluator: allow-list, AND-of-allows two-strict precedence, fail-closed missing-identity, execute/bash by-name, MCP-namespace, pass_through; HOOK_RULE_META entry; 10 tests, RED→GREEN)
`supervisor/src/guardrail-hooks.ts`: widen `GuardrailToolCall` to read tool identity (name +
MCP namespace, from the wire field Spike #1 proved) + keep `kind`/`locations`. New pure
evaluator `(profile, toolCall) → { decision: "allow" | "deny" | "pass_through"; reason?; governedClass? }`.
`HOOK_RULE_META` gains `capability_guard`. Write the identity-extraction helper with the
adapter-proven field name.
SOLID: single-responsibility (evaluate only — no I/O, no `record` mutation). DRY: single-source
the identity extractor + `WRITE_KINDS`.
*Logging*: n/a (pure; caller logs). *Verify (RED-first, edge cases enumerated)*: in-profile allow; out-of-profile deny (tools + mcps + tool-restriction); ungoverned → pass_through; **MCP-namespace extraction** (`mcp__github__create_issue` → server `github`); **call governed by TWO strict classes** → defined precedence; **missing/malformed identity** → conservative deny; `execute`(bash) not name-matchable → defined behavior; tool-name case handling; path-shaped restriction delegated to `path_guard` (not here). Min-overlap, no trivial tests.

**T2.3 · Interceptor integration in `requestPermission` (DES-3, deferred-release).** — ✅ DONE (block after path_guard before B1; in-profile auto-allow, out-of-profile deny+continue, Nth halt+cancel-deferreds, hookHalted short-circuit for capability-only sessions, throw→deny; emitHookTrip disposition override; integration tests prove deny-wins-over-B1 + breaker + no leaked deferred)
`supervisor/src/acp-client.ts`: insert the `capability_guard` block after `path_guard`,
before B1. In-profile → return `{selected, allowOption}` inline (reset counter);
out-of-profile → `emitHookTrip("capability_guard", tc)` deny + `{cancelled}` + increment;
Nth consecutive → `hookHalted=true` + halt escalation + cancel pending deferreds. Ungoverned
→ fall through. Ensure a throw in evaluation falls through to a logged deny (never an
unresolved RPC).
*Logging*: DEBUG per decision (`toolIdentity`, `kind`, `governedClass`, `decision`, `reason`, `denyCount`); INFO on halt.
*Verify*: unit — waterfall ordering (readOnly/readOnlyTurn/path_guard still win above; capability_guard wins over B1); breaker at N; no deferred leaked on the auto-decided path.

**T2.4 · D5 always-ask sentinel.** — ✅ DONE (session/update handler: unarbitrated WRITE_KINDS tool_call → fail-closed halt; integration test)
`supervisor/src/acp-client.ts` `session/update` handler: for an enforced session, track
arbitrated `toolCallId`s; a WRITE_KINDS `tool_call` update with an unseen id → `hookHalted` +
`capability_guard` halt escalation (fail-closed).
*Logging*: WARN on sentinel trip (`toolCallId`, `kind`).
*Verify*: unit — a synthesized unseen write-kind update trips the sentinel; a normal arbitrated write does not.

> **Commit C.** Gate: supervisor typecheck + unit green (incl. the four new suites).

### Phase 3 — Web: profile derivation, delivery, evidence gate, table flip — Commit D

**T3.1 · Derive `SessionEnforcementProfile` from settings (allow-list, DES-7; TDD).** — ✅ DONE (enforcement-profile.ts: deriveSessionEnforcementProfile allow-list + CONFIG-on-undeclared-tools + resolveEscalationThreshold + foldEnforcementProfileIntoDigest; 13 tests incl. D4 determinism)
In the capability materialize/resolver path (`web/lib/capabilities/*` +
`web/lib/flows/settings-view.ts` sourcing): produce the profile from the node/agent
capability settings filtered to `enforcement.<class>: strict` **and** enforceable classes.
Refuse (`CONFIG`) a strict class with no declared allow-set for the resolved agent. Fold the
profile into `profileDigest` (`resolver.ts:223-226,409`) so the mid-session consistency guard
(`runner-agent.ts:135-150`) catches drift.
DRY: single-source the enforced-class filter (shared with `evaluateNodeEnforcement`). SOLID:
derivation is pure — delivery (T3.2) and the evidence gate (T3.3) are separate units.
*Logging*: DEBUG — derived `enforcedClasses`, allow-set sizes, digest.
*Verify (RED-first, edge cases enumerated)*: tools/mcps/tool-restriction derivation; strict + no declared allow-set for the resolved agent → **CONFIG** (never enforce-nothing); class **not** strict → absent from profile; **enforceable-but-unproven adapter** → still derives (the T3.3 gate refuses, not derivation); **two strict classes** → both present; digest changes when the allow-set changes, stable when it doesn't. Min-overlap, no trivial tests.

**T3.2 · Thread the profile to `createSession` + record in ledgers (DES-2, D4).** — ✅ DONE (CreateSessionInput.enforcementProfile; derived in materializeNodeCapabilities → folded into plan.profileDigest + persisted in MaterializationPlan write-once; threaded executeNodeAction→ctx→both createInputs; materialization integration green)
`web/lib/supervisor-client.ts` (`CreateSessionInput.enforcementProfile`),
`web/lib/flows/graph/runner-graph.ts` (resolve once per node dispatch alongside `hooksConfig`
at :1201) → `web/lib/flows/runner-agent.ts` `createInput` (:814-828). Record the profile in
`materialization_plan` + `enforcement_snapshot`. **Resume reads the persisted snapshot; a
fresh attempt computes fresh** (D4) — assert no resumed-attempt re-evaluation.
*Logging*: DEBUG on delivery (`runId`, `nodeAttemptId`, `enforcedClasses`, digest).
*Verify*: unit — profile present in `createInput`; snapshot persisted; resume reuses snapshot (regression test).

**T3.3 · Async evidence gate `assertEnforcementEvidence` (mirror readOnly; DES-6).** — ✅ DONE (enforcement-evidence.ts: strict tools/mcps → require capabilityEnforcement smoke ok + no-skip-perms + diagnostics reachable; wired at runner-graph gate + runs.ts preflight; 6 tests)
New async gate consulting `GET /diagnostics` (`checkSupervisorDiagnostics`) refusing a
strict-enforced launch when the resolved adapter's `capabilityEnforcement` smoke ≠ `ok`,
message naming the missing evidence. Also add the **skip-permissions incompatibility refusal**
(DES-4). Wire at the launch sites: `runner-graph.ts:2585` (before `assertNodeLaunchable`/snapshot)
and `services/runs.ts:1066`; agent path `launch.ts` alongside `assertReadOnlySessionEvidence`.
*Logging*: INFO on refusal (`agent`, `class`, smoke `status`).
*Verify*: unit — pending/error smoke → refuse w/ evidence diagnostic; ok → pass; skip-permissions+strict → refuse.

**T3.4 · Flip `ENFORCEABILITY_BY_AGENT` + remove all 12 `TODO(M14)` (grep-sentinel).** — ✅ DONE (tools/mcps/hooks→enforced all 5 adapters via SEAM_ENFORCED_ROW; skills/restrictions/permissionMode/workspaceAccess documented-instructed; grep TODO(M14)=0; migrated 4 frozen-table-mirror test files to the flip; 6121 web unit + typecheck green)
`web/lib/flows/enforcement.ts`: `tools`/`mcps`/`restrictions`/`permissionMode`/`workspaceAccess`
→ `"enforced"` for all adapters (comment: seam-enforced, evidence-gated at launch); `hooks`
→ `"enforced"` (corrected); `skills` → `"instructed"` with a permanent documented comment
(instructions, not tool calls). Verify `evaluateNodeEnforcement`/`assertNodeLaunchable`
(`enforcement.ts:144-226`) now admit strict on the flipped cells and still refuse `skills`
strict.
*Verify*: **`grep -c "TODO(M14)" web/lib/flows/enforcement.ts` → 0**; unit — strict tools/mcps launchable, strict skills refused with the documented reason.

> **Commit D.** Gate: web typecheck + unit + **real-Postgres integration** green.

### Phase 4 — UI + i18n — Commit E

**T4.1 · UI/UX maturity: enforced / evidence-pending / deny surfacing.** — ✅ DONE ((a) fixed stale capability-profile-panel comment + settingsDeclaredIntentNote/capabilitySubtitle honesty captions; enforced auto-flows via evaluateNodeEnforcement; (c) capability_guard hook_trip card renders via hookTripRule.capability_guard label; (d) launch-refusal EXECUTOR_UNAVAILABLE names missing evidence + smoke ritual; (e) transcript deny via hookTripNotice select; (f) flow-settings.md Run-detail UX note; renderToStaticMarkup test added)
A real UX pass (per `web/CLAUDE.md` affordance conventions — icon or icon+label buttons, green
check for success, branch on typed status never string-match):
- **(a)** Confirm `settings-view.ts:54` → `flow-settings-panel.tsx` + `capability-profile-panel.tsx`
  + `flight-card.tsx` render `enforced` for flipped classes (auto-flows via `evaluateNodeEnforcement`);
  **fix the now-stale `capability-profile-panel.tsx:8-9` comment** ("not live-enforced yet (ADR-041)").
- **(b) Evidence-pending affordance** — a strict class refused *because the adapter's smoke
  isn't cached* renders a distinct, **actionable** state ("awaiting adapter evidence — run the
  smoke ritual"), not a generic `refused`. This is a 4th nuance beyond the existing
  enforced/instructed/refused tones.
- **(c) `capability_guard` `hook_trip` inbox card** — reuse `hookTripFromSchema`
  (`hitl-decision-controls.tsx:278-300`) so `rule: "capability_guard"` renders with the
  offending tool identity + icon resume/abort.
- **(d) Launch-refusal diagnostic** surfaced actionably where Launch is refused (why strict
  node X won't launch on adapter Y — names the missing evidence).
- **(e)** Surface the structured **deny reason** in the run transcript.
- **(f)** Document the enforced/refused/evidence-pending UX concept in `flow-settings.md` (R5).
*Files*: `flow-settings-panel.tsx`, `capability-profile-panel.tsx`, `flight-card.tsx`, `hitl-decision-controls.tsx`, `settings-view.ts`, transcript renderer. *Logging*: n/a (client).
*Verify*: `renderToStaticMarkup` tests extended (`flow-settings-panel.test.ts`, `flight-card-refused.test.ts`, `capability-profile-panel.test.ts`) for enforced + evidence-pending + hook_trip-card states.

**T4.2 · EN+RU strings for every new diagnostic/reason.** — ✅ DONE (hookTripRule.capability_guard + hookTripNotice select + settingsDeclaredIntentNote + capabilitySubtitle in en.json + ru.json; i18n-parity green; wired hookTripRule.capability_guard through run-hitl-response)
Deny reasons, evidence-gate refusals, skip-permissions refusal, `capability_guard` hook_trip
prompt — add EN+RU keys.
*Verify*: i18n parity check green; no hard-coded strings.

> **Commit E.** Gate: web typecheck + unit green; i18n parity.

### Phase 5 — E2E, deployment wiring, renumber pass — Commit F

**T5.1 · Full e2e via mock-ACP (the acceptance harness).** — ✅ DONE (as-built: seed-based, mirroring `m40-guardrail-hooks.spec.ts`)
Seed the mock adapter's `capabilityEnforcement` smoke = `ok` (via
`MAISTER_ADAPTER_SMOKE_CACHE_PATH`). Drive: strict launch on claude **and** codex → an
in-profile tool call allowed with **zero extra HITL** → an out-of-profile call denied with a
structured reason (run continues) → **N** consecutive denials → `hook_trip` appears in the
inbox → respond `resume` → run resumes. Assert the same strict node on gemini/opencode/mimo
**refuses launch** with the evidence diagnostic.
*Verify*: `pnpm test:e2e` green; named spec `capability-enforcement.spec.ts` in the globbed e2e path (confirm `vitest list`/playwright include matches — skill-context runnability).
> **AS-BUILT (drift folded back):** the plan text assumed a mock-ACP tool-call-driving
> harness at the **e2e** layer — that harness does **not** exist (the web e2e stub serves
> only `GET /health`; the M40 spec's own comment documents this exact boundary). So
> `capability-enforcement.spec.ts` (added to the `AUTHED_SPEC` glob + registered in the
> playwright config) **seeds** a `capability_guard` `hook_trip` (via a new
> `seedCapabilityEnforcementFixture` on an `enforcement.tools: "strict"` node) and asserts
> the unique seam-to-UI fan-out: the run-detail card renders the localized `capability_guard`
> rule + the out-of-profile offending tool, and **resume round-trips a 2xx** through the real
> respond route (REQ-21/22/24, AC-2/AC-7). **3 passed, exit 0.** The *dynamic detection*
> (in-profile allow / out-of-profile deny / N-halt) stays proven at
> supervisor-unit + `guardrail-interceptor.integration` + web `enforcement-profile`; the
> *launch refusal* stays `m11c-settings-enforcement.spec.ts` scenario B; the *"Enforced"
> settings verdict* stays unit (`flow-settings-view`/`flow-settings-panel`) — it now renders
> behind the run-inspector Flow tab (T-C1), not a load-visible heading. **Flagged separately:**
> `m11c-settings-enforcement.spec.ts` scenario A is **pre-existing broken** on `main` (the
> T-C1 inspector move; not this branch — verified by `git diff main`) → spun off as its own task.

**T5.2 · Deployment wiring.** — ✅ DONE (as-built: host-env, not compose — ADR-023)
`MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD` into `.env.example` + `compose.yml` (web +
supervisor `environment:`) + prod overlay if present. Smoke-cache path availability inside the
container confirmed.
*Verify*: `docker compose config` resolves; env var present in both service blocks; `.env.example` documents it.
> **AS-BUILT (drift folded back):** the plan text assumed web + supervisor have `compose.yml`
> service blocks — they do **not**. Per ADR-023, only Postgres is containerized; web +
> supervisor are **host-run** (they spawn agent CLIs, need host agent auth, operate on host
> git worktrees) and read `.env`. So the threshold lives in **`.env.example`** (documented,
> commented default 3) + **`docs/configuration.md`** (which already states *"Host/service-env
> only (ADR-023) — never a container/compose var"*). There is no compose block to wire it
> into, and adding one would violate ADR-023. No prod overlay exists in-repo.

**T5.3 · Docs as-built reconciliation.** — ✅ DONE
Flip Phase-0 Designed→Implemented tags; ensure `docs/getting-started.md` Scripts, the ritual
checklist, and `docs/configuration.md` match shipped behavior.
*Verify*: `pnpm validate:docs:all` + ADR-anchor check green.
> **AS-BUILT:** `capability_guard` Expectations already tagged **Implemented**; corrected the
> SDD **Source** pointers to the real homes (`web/lib/flows/enforcement-profile.ts` +
> `enforcement-evidence.ts` + wiring in `graph/runner-graph.ts`, not the Phase-0-guessed
> `resolver.ts`/`launch.ts`); corrected the migration-free proof bullet (inspection, not the
> `db:generate` self-check which aborts on the pre-existing `0089/0090` collision); appended a
> **T5.5 as-built re-run** subsection. `getting-started.md` smoke ritual + `configuration.md`
> row already match shipped behavior (env-only feature, no new script). **Verify green:**
> mermaid **342/342**, ADR anchors **649** resolved.

**T5.4 · Renumber pass (own focused step, AFTER rebase onto main).** — ✅ DONE (pre-rebase portion; the number-bump itself is owner-gated at FF-merge)
Re-grep `docs/decisions.md` for the ADR number (the three-way contest may have moved it to
130/131); renumber ADR + every citation; confirm **no** migration was taken; run the
ADR-anchor validator; fold any mid-implementation surprises back into this plan.
*Verify*: ADR-anchor validator green; `grep -rn "ADR-129" docs/` consistent; no `0093` file from this branch.
> **AS-BUILT:** on this branch ADR-129 is internally consistent (index row + body anchor
> `#adr-129-adapter-agnostic-capability-enforcement-at-the-acp-seam`; 649 ADR anchors resolve).
> **No** migration taken (0 files under `web/lib/db/migrations/`; no `0093`). The actual
> renumber (if the still-contested 129 slot resolves to 130/131 at merge) is a mechanical
> `grep -rln "ADR-129" docs/ | xargs sed` the OWNER runs during the rebase+FF — it cannot be
> done meaningfully before the winning number is known. All mid-implementation surprises are
> folded back (T5.1 e2e harness reality, T5.2 host-env-not-compose, T5.3 source pointers,
> the pre-existing `0089/0090` `db:generate` collision).

**T5.5 · Final grep-sentinels + REQ/acceptance walk + spec-drift re-audit.** — ✅ DONE
Grep-sentinels: `grep -c "TODO(M14)" web/lib/flows/enforcement.ts` → 0; `capability_guard`
present in `HookRule`, `HOOK_RULE_META`, `HookTripHaltRule`, the SSE mirror + asyncapi enum,
and the supervisor openapi; `db:generate` reports "No schema changes" (migration-free proof).
Walk **every REQ in the T0.6 matrix** → its test is green; walk **all §Acceptance criteria**
against the running system. Re-run the T0.5 audit checklist **against the shipped code** as a
spec-drift check (docs match behavior).
*Verify*: all sentinels pass; **every REQ maps to a green test**; §Acceptance all green; zero T0.5 drift items.
> **AS-BUILT — all sentinels pass:** `TODO(M14)`=**0**; `capability_guard` present in
> `HookRule` (`types.ts:378`), `HOOK_RULE_META` (`guardrail-hooks.ts:333`), `HookTripHaltRule`
> (`hook-trip.ts:38`), SSE mirror `SupervisorEvent` (`supervisor-client.ts:394`), **both**
> asyncapi enums, supervisor openapi. Migration-free proven by **inspection** (0 new migration
> files; `schema.ts` delta is a jsonb `$type` key only) — `db:generate` aborts on the
> pre-existing `0089/0090` collision (on `main`, not this branch). **Green gate:** web unit
> **6123/6123** (597 files); supervisor unit **356/356** + integration **88/88** (incl.
> `guardrail-interceptor.integration` 16); `capability-enforcement.spec.ts` **3/3** e2e;
> typecheck clean both tiers. **Every REQ-1..27 maps to a green test** (T0.6 matrix; test files
> consolidated vs the Phase-0-guessed names — `enforcement-profile.test.ts`,
> `guardrail-capability.test.ts`, `guardrail-tool-identity.test.ts`,
> `guardrail-interceptor.integration.test.ts` on the supervisor; `enforcement-profile`,
> `enforcement-evidence`, `enforcement` (flip), `runner-agent-hooks` on the web). **§Acceptance
> 1-8 all hold** (2/3/4 seam+launch behavior proven at unit+integration+e2e; 5 verdict unit;
> 6 ADR-032 invariant via evidence gate; 7 grep=0; 8 traceability+migration-free). **Zero T0.5
> behavioral drift** — three doc-only reconciliations folded back (SDD source pointers, host-env
> wiring, e2e harness reality).

> **Commit F.** Gate: full stack green (typecheck·unit·integration·e2e·docs·i18n).

---

## Commit Plan

| Commit | After | Message (conventional) |
| --- | --- | --- |
| A | Phase 0 | `docs(enforcement): ADR-129 + SDD for adapter-agnostic capability_guard (M14 flip)` |
| B | Phase 1 | `feat(supervisor): capabilityEnforcement smoke dimension + adapter probe` |
| C | Phase 2 | `feat(supervisor): capability_guard interceptor + N-deny escalation + always-ask sentinel` |
| D | Phase 3 | `feat(web): derive+deliver enforcement profile, evidence gate, flip ENFORCEABILITY_BY_AGENT` |
| E | Phase 4 | `feat(web): surface enforced/evidence-pending capability status + EN/RU i18n` |
| F | Phase 5 | `test(e2e): capability enforcement round-trip; wire env; renumber pass` |

(MAIster convention: no `Co-Authored-By` trailer — [[maister-commit-no-ai-trailer]]. Integrate by rebase + owner FF — [[maister-integration-rebase-ff]].)

## Acceptance (behavioral — the definition of done)

1. A node declaring `enforcement: strict` on `tools` launches on **claude and codex**; an out-of-profile tool call is denied at the seam with a structured reason and the run continues.
2. **Three** consecutive denials produce a `hook_trip` HITL in the inbox; responding `resume` resumes the run.
3. In-profile calls add **zero** user-visible permission prompts vs today (auto-resolved at the seam).
4. The same strict node on **gemini/opencode/mimo** still refuses launch; the diagnostic names the missing smoke evidence.
5. `enforcement_snapshot` + `FlowSettingsPanel` show **enforced** for flipped classes; `skills: strict` still refuses with the documented reason.
6. **ADR-032 invariant holds everywhere**: no capability ever silently degrades from strict to instruction (strict on an unproven adapter/class refuses; never enforces-nothing).
7. **Grep-sentinel**: zero `TODO(M14)` in `web/lib/flows/enforcement.ts`.
8. **Traceability**: every REQ in the T0.6 matrix maps to a green test (all functionality + edge cases covered, minimum overlap); the T0.5 audit re-run against shipped code shows zero drift; `db:generate` confirms migration-free.

## T0.6 — REQ → AC → Test traceability matrix (authored Phase 0; the coverage contract)

Every functional requirement below is a concrete *"the system MUST …"*, mapped to an
observable **acceptance criterion** (AC-1..8 = §Acceptance; SDD-E = a
`guardrail-hooks.md` Expectation bullet) and the **exact test(s) + layer** that prove
it. Coverage contract: **every REQ has ≥1 test; no REQ without a test; no test without
a REQ; overlaps collapsed; trivial tests excluded.** Layers: U = unit, I =
integration (real Postgres), E = e2e (mock-ACP). Test files are created RED-first in
the cited phase.

| REQ | The system MUST … | AC / SDD | Test(s) · layer · phase |
| --- | --- | --- | --- |
| REQ-1 | Derive `SessionEnforcementProfile` from node/agent settings filtered to `enforcement.<class>: strict` AND enforceable (`tools`/`mcps` only). | SDD-E | `resolver.enforcement-profile.test.ts` (derive tools/mcps; class-not-strict absent) · U · P3 |
| REQ-2 | Populate `tools.allow` from `settings.tools[resolvedAgent]` as an **allow-list**, never a deny-list. | AC-6, SDD-E | same suite (allow-set = settings.tools[agent]) · U · P3 |
| REQ-3 | Refuse launch `CONFIG` when a strict class has **no declared allow-set** for the resolved agent (never enforce-nothing). | AC-6 | `resolver.enforcement-profile.test.ts` (strict tools + empty allow → CONFIG) · U · P3 |
| REQ-4 | Resolve an in-profile governed call inline as **allow** (zero added HITL) and reset `capabilityDenyCount`. | AC-3 | `acp-client.capability-guard.test.ts` (in-profile allow, counter reset) · U · P2 |
| REQ-5 | Resolve an out-of-profile governed call inline as `cancelled`, emit `hook_trip{capability_guard, deny}`, continue the run, increment counter. | AC-1 | same suite (out-of-profile deny tools/mcps/reason) · U · P2; `capability-enforcement.spec.ts` · E · P5 |
| REQ-6 | Allow a call governed by BOTH `tools`+`mcps` **iff both** allow-lists admit it (AND-of-allows). | SDD-E | `guardrail-hooks.capability.test.ts` (two-strict precedence) · U · P2 |
| REQ-7 | **Deny** (fail-closed) a governed call whose tool identity is missing/malformed. | AC-6, SDD-E | `guardrail-hooks.capability.test.ts` (missing identity → deny) · U · P2 |
| REQ-8 | `halt` on the **Nth** consecutive out-of-profile deny (`MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD`, default 3): cancel pending deferreds + reset counter. | AC-2 | `acp-client.capability-guard.test.ts` (breaker at N; cancel deferreds) · U · P2; `capability-enforcement.spec.ts` (N→hook_trip→resume) · E · P5 |
| REQ-9 | Never leak a deferred: auto-decided calls resolve synchronously (no `register`); a throw in evaluation → logged deny + release. | SDD-E | `acp-client.capability-guard.test.ts` (no deferred leaked; throw→deny) · U · P2 |
| REQ-10 | Run `capability_guard` **after `path_guard`, before B1**; an **ungoverned** call falls through unchanged. | AC-3, SDD-E | `acp-client.capability-guard.test.ts` (waterfall ordering; ungoverned fallthrough) · U · P2 |
| REQ-11 | Latch a `capability_guard` halt if a WRITE_KINDS `session/update` `tool_call` was never arbitrated (D5 sentinel). | SDD-E | `acp-client.always-ask-sentinel.test.ts` (unseen write trips; arbitrated does not) · U · P2 |
| REQ-12 | Refuse launch (`EXECUTOR_UNAVAILABLE`) for a strict-armed profile on a `dangerously_skip_permissions` runner. | AC-6 | `launch.enforcement-evidence.test.ts` (skip-perms + strict → refuse) · U · P3 |
| REQ-13 | Spawn an enforced session with `permissionPolicy=default` (supervisor = permission authority). | AC-3 | `runner-graph.enforcement-delivery.test.ts` (policy=default when armed) · U · P3 |
| REQ-14 | Refuse a strict `tools`/`mcps` launch (`EXECUTOR_UNAVAILABLE`) unless the resolved adapter's `capabilityEnforcement` smoke `=== "ok"`, AND refuse a `dangerously_skip_permissions` runner. | AC-4, AC-6 | `enforcement-evidence.test.ts` (pending/error/missing/skip-perms→refuse; ok→pass) · U · P3. (As-built: the evidence-gate refusal is adapter-agnostic and unit-owned; the e2e stub can't run real adapters, so gemini/opencode/mimo refusal is NOT re-driven e2e — the launch-refusal e2e is `m11c-settings-enforcement.spec.ts` scenario B.) |
| REQ-15 | Provide a `capabilityEnforcement` smoke dimension mirroring `readOnlySession` (pending/ok/error/demote), `required` for all five adapters, twin registry↔support tables synced. | AC-4 | `adapter-smoke-cache.capability.test.ts` (4 dimension cases) · U · P1; `adapter-registry.test.ts` + `adapter-support.test.ts` (+ sync test) · U · P1 |
| REQ-16 | Ship a `--capability-enforcement` smoke probe proving fire-per-write + stable identity + latency; green on mock-ACP. | AC-4 | `smoke-acp-adapter-script.test.ts` (capabilityEnforcement ok on fixture) · U · P1 |
| REQ-17 | On resume read the persisted `enforcement_snapshot`/`enforcementProfile`; only a **fresh** attempt recomputes. | AC-5, SDD-E | `runner-agent.resume-enforcement.test.ts` (resumed reuses snapshot; no recompute) · U/I · P3 |
| REQ-18 | Fold `enforcementProfile` into `profileDigest` so a mid-session enforcement change refuses (`CONFIG`) without a declared boundary. | SDD-E | `resolver.enforcement-profile.test.ts` (digest changes w/ allow-set; stable otherwise) · U · P3 |
| REQ-19 | Flip `tools`/`mcps`/`hooks` → `enforced` for all adapters; **0** `TODO(M14)`; keep skills/restrictions/permissionMode/workspaceAccess documented-instructed; strict `skills` still refuses. | AC-5, AC-7 | `enforcement.flip.test.ts` (strict tools/mcps launchable; strict skills CONFIG; grep TODO(M14)=0) · U · P3 |
| REQ-20 | Thread `enforcementProfile` `CreateSessionInput → createInput → StartSessionRequestSchema → SessionRecord → spawn seed`. | AC-1 | `types.enforcement-profile.test.ts` (schema accept/reject) · U · P2; `runner-graph.enforcement-delivery.test.ts` (present in createInput) · U · P3 |
| REQ-21 | Escalate a `capability_guard` halt through the existing `hook_trip` HITL (resume/abort), human-actor-only; scratch stays notify-only. | AC-2 | `hook-trip.capability.test.ts` (HookTripHaltRule widened; maps) · U · P2/P3; `capability-enforcement.spec.ts` (resume) · E · P5 |
| REQ-22 | Fan `capability_guard` to every consumer: `HookRule`, `HOOK_RULE_META`, `HookTripHaltRule`, SSE mirror, asyncapi enum, openapi. | AC-7 | `types.hookrule.test.ts` (exhaustive meta) · U · P2; T5.5 grep-sentinels · — · P5 |
| REQ-23 | Extract an MCP server namespace from `mcp__<server>__<tool>` and match it against `allowServers`. | SDD-E | `guardrail-hooks.capability.test.ts` (mcp__github__… → github) · U · P2 |
| REQ-24 | Surface enforced / evidence-pending / deny UX states + a `capability_guard` `hook_trip` inbox card + launch-refusal diagnostic; fix the stale `capability-profile-panel` comment. | AC-5 | `flow-settings-panel.test.ts`, `flight-card-refused.test.ts`, `capability-profile-panel.test.ts` (renderToStaticMarkup) · U · P4 |
| REQ-25 | Provide EN+RU keys for every new diagnostic/reason (no hard-coded strings). | AC-5 | i18n parity test + key-usage greps · U · P4 |
| REQ-26 | Take **no** migration and **no** engine bump. | AC-8 | `pnpm --filter maister-web db:generate` = "No schema changes" · gate · P5 |
| REQ-27 | Add **no** new `MaisterError` code (reuse `CONFIG`/`EXECUTOR_UNAVAILABLE`/`PRECONDITION`). | AC-6 | covered structurally by REQ-3/12/14 suites asserting the reused codes · U · P2-3 |

**AC coverage check (T0.5 / T5.5):** AC-1→{REQ-5,20}; AC-2→{REQ-8,21}; AC-3→{REQ-4,10,13}; AC-4→{REQ-14,15,16}; AC-5→{REQ-17,19,24,25}; AC-6→{REQ-2,3,7,12,27}; AC-7→{REQ-19,22}; AC-8→{REQ-8-matrix,26}. Every §Acceptance criterion maps to ≥1 REQ; every REQ has ≥1 test.

## Rebase / parallel-work notes

- **No code overlap** with `postgres-graph-cutover` (touches `db/client.ts`, `runner.ts`
  linear walker, `step-runs.ts`, schema) or `agent-format-superset` (touches
  `acp-runners/resolve.ts` read-only refusal, `definition.ts` typing). **Watch:**
  `agent-format-superset` also edits `resolve.ts` near the skip-permissions/read-only
  refusal DES-4 adds a sibling refusal to — coordinate that hunk at rebase.
- **Contested at merge:** ADR-129 (three-way) — renumber pass T5.4 is mandatory. Migration
  0093 is contested with the cutover plan — this plan takes **no** migration, sidestepping it.

---

## Resolved decisions (owner, 2026-07-11 — all five locked)

1. **N-порог = глобальный env** `MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD=3`. Per-node override deferred to the future policy-language plan. **(yes)**
2. **`tools: strict` with no declared allow-set for the resolved agent → `CONFIG` refusal** (DES-7). Never enforce-nothing. **(ok)**
3. **Enforcement applies wherever a class is declared `strict` — NOT gated on unattended.** Rationale (locked): auto-allowing in-profile calls honors the author's explicit allow-list (not new permissiveness — ADR-032 "contract only tightens"); the out-of-profile deny is a pure safety gain over interactive-human mis-approval; ungoverned classes still fall through to HITL, so the human keeps control where nothing was declared strict. The exploratory "human-driving" case is **scratch runs**, which carry no flow-node enforcement settings and whose guardrail consumer is notify-only → naturally exempt, no special-casing.
4. **Uniform, runner-agnostic evidence gate — no codex-specific handling.** The `capability_guard` interceptor is one code path for all five adapters. The gate requires each adapter's binary to *empirically* prove (uniform smoke bar) it surfaces every write to the seam with tool identity; codex enforces the same code the day its smoke passes. codex-acp is schema-backed for the fields DES-8 needs, so acceptance #1 (claude **and** codex) is expected to hold — the spike confirms it empirically; a failure yields the same refuse-with-diagnostic any unproven adapter gets (ADR-032-safe), not a codex carve-out.
5. **Fold the M40 native-hook live-verification residual into the T1.3 ritual** (option A) — identical operator action (run live smoke, cache evidence), near-zero marginal cost. (Option C — de-scope its live-verification entirely, since the native hook is defense-in-depth only and the supervisor seam is the real guarantee — is a legitimate fallback if operator time is scarce.)
