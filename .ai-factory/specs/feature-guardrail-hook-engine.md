# SDD Spec — Vendor-neutral guardrail/hook engine at the supervisor↔ACP seam (G4 / M40)

> **Status: FROZEN 2026-06-23 (Phase 0).** Implementation contract for Phases 1–6.
> Decision record: **ADR-104** (`docs/decisions.md`). Design home (diagrams, R5):
> `docs/system-analytics/guardrail-hooks.md`. Task plan:
> `.ai-factory/plans/feature-guardrail-hook-engine.md`.
> When code and this spec disagree during implementation, fix the code OR amend this
> spec in the same commit — never silently diverge.

## 0. One-line thesis

Per-tool-call enforcement at the supervisor's ACP `requestPermission` seam — the
one loop-safety primitive MAIster lacks. Gates evaluate post-node; the ADR-101
budget meters totals. Neither stops a mid-node tool-call loop, an out-of-lane
write, or a stall. The hook engine does, deterministically, before the tool runs.

## 1. Spike findings (FROZEN)

### 1.1 — T0.1 adapter toolCall-shape table

The write path is **standardized** at the ACP seam: `@agentclientprotocol/sdk@0.22.1`
types `RequestPermissionRequest.toolCall` as `ToolCallUpdate`, which carries
`locations?: Array<{ path: string; line?: number }>`. Path extraction is therefore
**one adapter-agnostic codepath** — `toolCall.locations?.[0]?.path` — with a
kind-only fallback. (This CORRECTS the plan's original ground-truth note #2, which
assumed an opaque adapter-specific body. Owner-approved 2026-06-23.)

| Adapter | Launch (`adapter-registry.ts`) | Readiness | Write `kind` | Path field | Confidence |
| --- | --- | --- | --- | --- | --- |
| claude | `claude-agent-acp` | ready (`not_required`) | `edit` (Write/Edit/MultiEdit) | `locations[0].path` ← `input.file_path` | **verified in source** (`claude-agent-acp/dist/tools.js`) |
| codex | `codex-acp` | ready (`not_required`) | (SDK `ToolKind`) | `locations[0].path` (same SDK schema) | schema-backed (minified bundle, not directly read) |
| gemini | `gemini --acp` | smoke-gated (`pending`) | unverified | — | **no evidence → kind-only fallback** |
| opencode | `opencode acp` | smoke-gated | unverified | — | **no evidence → kind-only fallback** |
| mimo | `mimo acp` | smoke-gated | unverified | — | **no evidence → kind-only fallback** |

`WRITE_KINDS = { edit, write, create, delete, move }` (the existing
`READ_ONLY_MUTATING_KINDS` in `acp-client.ts`). The current `ToolCallLike`
(`{toolCallId, title, kind}`) is **widened** with `locations?: Array<{ path: string;
line?: number }>` in Phase 2. The full `params.toolCall` is already forwarded to web
in the `session.permission_request` event (`acp-client.ts`), so `locations` reaches
the browser without extra plumbing.

**Frozen extractor (T2.2):**

```ts
function extractWritePath(tc: ToolCallLike): { isWrite: boolean; path?: string } {
  const isWrite = tc.kind !== undefined && WRITE_KINDS.has(tc.kind);
  const path = tc.locations?.[0]?.path;       // standardized ACP field
  return { isWrite, path };                    // path undefined => kind-only fallback
}
```

### 1.2 — T0.2 per-`run_kind` resume verification

| `run_kind` | Resume path | Reuse for `hook_trip`? |
| --- | --- | --- |
| `flow` | `runFlow(runId)`, CAS `NeedsInput → Running`; dispatched by `scheduleResume = queueMicrotask(runFlow)` | yes |
| `agent` | `startAgentSession({ resumeSessionId: run.acpSessionId })` → ACP `session/resume`; the consume loop flips `NeedsInput → Running` on the HITL answer. **Independent of `runFlow`** | **yes** — the budget flow-only trap (its `raise → runFlow` path) does NOT apply |
| `scratch` | in-session model; permission denial → `Crashed` dialog_status, no `NeedsInput` | n/a — deny + in-session notice |
| `orchestrator` | inherits via child run_kinds (flow/agent) | via children |

**P4 native-hook feasibility flag (unresolved by design — gates Phase 4):**
`@anthropic-ai/claude-agent-sdk@0.3.146`'s `sdk.d.ts` DOES declare `hooks?:
Partial<Record<HookEvent, …>>` with `'PreToolUse'` — but that is the **programmatic
`query()` channel**. Whether the adapter honors a `hooks` key from
`.claude/settings.local.json` (the M14 materialization channel) is **unverified**.
P4 leads with a spike; graceful degradation if not honored (see §7). `AgentSettingsLocal`
(`agent-map.ts`) confirmed to have **no `hooks` key** today.

## 2. Canonical contracts (FROZEN)

### 2.1 — Authored node-settings `hooks` (sparse; `config.schema.ts`)

```yaml
settings:
  hooks:
    disabled: false                 # opt out entirely (suppresses the unattended auto-arm)
    repetition:   { max: 5 }        # liveness breaker
    noProgress:   { maxTurns: 15 }  # liveness breaker
    pathGuard:    { allowedPaths: ["src/**", "tests/**"] }  # ALWAYS opt-in
  enforcement:
    hooks: instruct                 # strict | instruct (default) | off
```

Every key `.optional()` (no per-key `.default()` — sparse-default rule);
`enforcement.hooks` folds to `instruct` at evaluation. On `aiCodingSettingsSchema`
(inherited by `orchestratorSettingsSchema`) and `judgeSettingsSchema`. Engine floor:
`compat.engine_min >= 1.8.0`.

### 2.2 — Resolved `hooksConfig` (wire; `StartSessionRequest`)

```json
{ "repetition": { "max": 5 }, "noProgress": { "maxTurns": 15 }, "pathGuard": { "allowedPaths": ["src/**"] } }
```

Each top-level key optional; **absent = that rule not armed.** The supervisor
enforces exactly what it is given.

### 2.3 — `session.hook_trip` event

```json
{ "type": "session.hook_trip", "sessionId": "…", "monotonicId": 42,
  "rule": "repetition", "lifecycle": "pre_tool_call", "disposition": "halt",
  "toolCall": { … } }
```

`rule ∈ {path_guard, repetition, no_progress}`; `lifecycle ∈ {pre_tool_call,
post_turn}`; `disposition ∈ {deny, halt}`; `toolCall` present for `pre_tool_call`,
`null` for `no_progress`.

### 2.4 — Rule × lifecycle × disposition (FROZEN)

| Rule | Lifecycle | Disposition | Trip → action |
| --- | --- | --- | --- |
| `path_guard` | `pre_tool_call` | `deny` | deny inline (cancelled), run continues (deny-and-continue) |
| `repetition` | `pre_tool_call` | `halt` | cancel + stop work → web checkpoint + escalate |
| `no_progress` | `post_turn` | `halt` | stop work → web checkpoint + escalate |

## 3. Two-tier default resolution (D4, FROZEN)

The Phase-1 resolver reads the run's execution-policy preset
(`execution-policy.ts`: `supervised | assisted | unattended`):

- `unattended` AND node not opted out → seed `repetition.max =
  MAISTER_HOOK_REPETITION_MAX` (5) + `noProgress.maxTurns =
  MAISTER_HOOK_NO_PROGRESS_TURNS` (15); a node-explicit value wins.
- `supervised` / `assisted` / **absent snapshot** → no auto-arm (fail-safe to opt-in).
- `path_guard` → armed only when the node declares `hooks.pathGuard`; an
  opt-in-without-paths node resolves `allowedPaths` from
  `MAISTER_HOOK_DEFAULT_WRITABLE_PATHS`, else the worktree root.
- Opt-out = `hooks.disabled: true`.

## 4. Escalate transaction + run_kind routing (D1/D2, FROZEN)

`halt` → the **web** consumer (not the supervisor) escalates. **Branch on `run_kind`
BEFORE routing.** Mirror ADR-101 `actBudgetEscalate`:

1. checkpoint pre-tx (`POST /sessions/:id/checkpoint`); bail on `EXECUTOR_UNAVAILABLE`
   (retry next signal).
2. write `needs-input.json` pre-tx (unlink on tx failure).
3. ONE `db.transaction`:
   - CAS `runs.status` `Running → NeedsInput` (0 rows → mapped 409, never raw 23505).
   - `markNodeNeedsInput`.
   - `hitl_requests.insert(kind:"hook_trip")`.
   - `createHitlAssignmentForRun(action_kind:"hook_trip")` **iff** `onStuck !== "notify_only"`.
   - emit `run.needs_input` + `run.escalated{ reason:"hook_trip", rule }` (ADR-086 same-tx).
4. post-commit `logExecPolicyAction("escalated", { reason:"hook_trip", rule })`.

Resume: flow → `runFlow`; agent → the agent permission-HITL resume (`session/resume`);
scratch → deny + in-session notice, **no `NeedsInput`**. `onStuck` from
`onStuckFromSnapshot` (fail-closed `escalate`); `assign = onStuck !== "notify_only"`.

## 5. Supervisor seam (FROZEN — ordering amended Phase 2, 2026-06-23)

Interceptor lands in `acp-client.ts` `requestPermission`, **after** L1
`resolveReadOnlySessionDecision` / L2 `resolveReadOnlyAutoReject` and **before** B1
`autoApprovePermissions` + the `session.permission_request` emit + the
pending-permission deferred. Pre-hoc for `path_guard` + `repetition` (the callback
`await`s; the SDK does not run the tool until it resolves). `no_progress` is computed
in `sessionUpdate` (post-hoc; cannot block). New `SessionRecord` counters:
`lastToolCallSig?`, `repeatCount`, `turnsSinceProgress` (in-memory only; lost on
supervisor crash → run reconciled `Crashed`; reset on resume).

> **Amendment (Phase 2, owner-approved 2026-06-23).** The Phase-0 freeze placed the
> interceptor *after* B1. That is wrong: B1 (`autoApprovePermissions`) returns inline
> on any allow-shaped option, and **every `unattended` preset resolves to
> `permissions=auto_approve`** (`execution-policy.ts` `PRESET_AXES`) — the exact runs
> the two-tier default arms guardrails for. After-B1 placement would silently no-op
> `path_guard` + `repetition` on them (`repetition`, which only auto-arms under
> `unattended`, would be dead code). Guardrails are deny/halt layers like L1/L2 and
> MUST precede the B1 approve layer. Corrected in code + `guardrail-hooks.md` + ADR-104.

## 6. Number & namespace reservation (FROZEN — re-confirm in T6.3)

- **ADR-104** (max ADR in tree = 103). Studio holds 105/106/107.
- **Migration 0063** (max idx = 61). **0062 reserved by the Studio stream** → G4 yields to 0063. The ONLY schema change: `hook_trip` in `hitl_requests.kind` + `assignments.action_kind`.
- **Engine 1.7.0 → 1.8.0**; `HOOKS_ENGINE_MIN = "1.8.0"`.
- **Milestone M40** (M39 reserved for Studio; both unmerged on their branch, prior claim).
- **No new `MaisterError` code.**

## 7. Native split + P4 spike/degradation (D7, FROZEN)

`NativeHookMaterializer` = `{ adapter; materialize(hooksConfig, worktreePath): void }`,
resolved from an adapter→materializer registry. Phase 1 registers a **no-op** for
every adapter (universal path unaffected). Phase 4 registers the **claude** materializer
ONLY after a spike confirms the bundled adapter honors `.claude/settings.local.json`
hooks:

- **honored** → write a `PreToolUse` matcher (`Edit|Write|MultiEdit|NotebookEdit`) +
  a repo-local guard script (run via `node`); `allowedPaths` derive from the SAME
  resolved `hooksConfig.pathGuard`; respect the M14 ownership-marker / reclaim /
  `WORKTREE_EXCLUDE_PATTERNS` / cleanup protocol. Covers **only `path_guard`**.
- **NOT honored** → register no native materializer; document "native backend N/A for
  the current claude adapter; the universal supervisor layer carries enforcement";
  ship no dead code; STOP Phase 4 (Phases 5–6 unaffected).

Rules `repetition` / `no_progress` are **always** supervisor-only (cross-turn state).

## 8. Contract-surface → file trace (FROZEN)

| Surface | Files | Phase |
| --- | --- | --- |
| `hooks` DSL class + `enforcement.hooks` + engine_min | `config.schema.ts`; `docs/flow-dsl.md` ✓, `docs/system-analytics/flow-settings.md` ✓ | 1 (code), 0 (docs ✓) |
| `hooksConfig` on `POST /sessions` | `http-api.ts` body; `docs/api/supervisor.openapi.yaml` ✓, `docs/supervisor.md` ✓ | 2 (code), 0 (docs ✓) |
| `session.hook_trip` SSE | `acp-client.ts`, `events-log.ts`, web `supervisor-client.ts`; `supervisor-sse.asyncapi.yaml` ✓ + `web-runs.asyncapi.yaml` ✓ | 2 (code), 0 (docs ✓) |
| `hook_trip` in `hitl_requests.kind` + `assignments.action_kind` | migration 0063 + `schema.ts` (BOTH the column def AND the `enum:` array); `database-schema.md` ✓, `db/hitl-domain.md` ✓, `db/erd.md` ✓ | 1 (code), 0 (docs ✓) |
| `run.escalated` hook reason | `runner-graph.ts` / keepalive emit; `outbound-webhooks.asyncapi.yaml` ✓ | 3 (code), 0 (docs ✓) |
| native `settings.local.json` `hooks` | `agent-map.ts` `AgentSettingsLocal`, `materialize.ts`; `flow-settings.md` ✓ | 4 |
| env vars (`MAISTER_HOOK_*`) | `.env.example` + `deploy/maister.env.example` (Phase 1, with consumption); `docs/configuration.md` ✓ | 1 (.env), 0 (docs ✓) |
| ADR-104 + domain doc | `docs/decisions.md` ✓ + `## Index` ✓, `guardrail-hooks.md` ✓, `docs/CLAUDE.md` row ✓ | 0 ✓ |
| error taxonomy "no new code" | `docs/error-taxonomy.md` ✓ | 0 ✓ |

(✓ = landed in Phase 0.) **web.openapi.yaml needs NO edit**: its only HITL `kind` enum
is the scratch-scoped `ScratchPendingHitl` (scratch never gets a `hook_trip`), and
the sibling escalation kinds `infra_recovery`/`budget_breach` are absent there too —
following the `budget_breach` precedent exactly. **compose.yml needs NO edit**: it is
postgres-only (ADR-023 host-run); `MAISTER_HOOK_*` go to `.env.example` +
`deploy/maister.env.example`.

## 9. Atomicity & crash-window analysis (FROZEN)

- Escalate = ONE tx (the budget GOOD-in-tx pattern, §4).
- (a) supervisor crash mid-trip → counters lost, no live session → existing reconcile → `Crashed`.
- (b) web crash AFTER checkpoint, BEFORE escalate tx → run `Running` + valid checkpoint + session gone → existing crash-reconcile sweep; **test** that a checkpointed-but-not-escalated trip is reconciled, not stranded.
- (c) counters per-session in-memory → a resume resets them; document that a resumed run counts fresh.
- The supervisor counter mutation + deny/halt decision are synchronous within the single `requestPermission` callback (no partial state).

## 10. Per-phase implementation contracts (FROZEN acceptance)

- **Phase 1** — `hooks` class on `config.schema.ts` (+ `enforcementMapSchema.strict()`); engine 1.8.0 + `HOOKS_ENGINE_MIN` floor (load-time `validateGraphManifest` + compile-time `compile.ts`, firing ONLY when `hooks` present); `"hooks"` → `ALL_CLASSES` + `instructed` per agent in `ENFORCEABILITY_BY_AGENT` + `EnforcementSnapshotEntry["class"]`; migration 0063 (journal monotonic, snapshot committed); the pure `hooksConfig` resolver + two-tier default (§3) threaded into the `POST /sessions` body builder; the `NativeHookMaterializer` interface + no-op registry; `.env.example` + `deploy/maister.env.example` `MAISTER_HOOK_*`. Tests: valid/invalid blocks → `CONFIG`; floor accept/reject; snapshot test 6→7; `hook_trip` HITL row round-trip; resolver default-fill + unattended-vs-supervised + opt-out + SET/CLEAR symmetry; no-op materializer per adapter.
- **Phase 2** — parse + arm `hooksConfig` (Zod in `http-api.ts`, stored on the registry entry / `SessionRecord`); `SessionRecord` counters; the adapter-agnostic `extractWritePath` (§1.1, kind-only fallback + `WARN` once/session on fallback); the `pre_tool_call` interceptor (path_guard deny-and-continue; repetition trips at EXACTLY `max`, resets on differ); the `no_progress` watchdog in `sessionUpdate`; emit `session.hook_trip` + halt mechanics (cancel any in-flight deferred, stop prompts, do NOT self-kill); extend the mock ACP adapter(s) to script N-identical / out-of-path / M-idle streams. Tests against the mock for every branch; no leaked deferred.
- **Phase 3** — consume `session.hook_trip` (deny → record-only DEBUG; halt → escalate); branch on `run_kind` BEFORE routing; `escalateHookTrip` (§4, mirror `actBudgetEscalate`); per-run_kind arms + resume (flow `runFlow`; agent existing HITL resume — escalate NOT terminate; scratch deny + notice); `hook_trip` HITL fan-out (respond service resume-or-abort kind-switch; board + portfolio inbox + run-detail timeline + "Needs you" sum; Observatory count; EN/RU i18n). Tests: escalate (assigned) vs notify_only (unassigned); CAS rejects non-`Running`; crash-window reconcile; agent `hook_trip` HITL responds → run RESUMES; the kind appears in every inbox surface.
- **Phase 4** — the spike gate (§7); if honored, the claude materializer + shipped guard script + defense-in-depth integration test (native denies before the supervisor sees the permission; no double-count/double-escalate; supervisor remains the backstop + sole layer for codex/etc + rules 1 & 3).
- **Phase 5** — node side-form `hooks` editor (`node-side-form.tsx`, testids `node-hooks-*`, icon+label affordances) + `validateHooksDraft`; `FlowSettingsPanel` tags the 7th class; trip surfacing (distinct guardrail HITL affordance + timeline entry); EN/RU parity.
- **Phase 6** — seeded authed e2e `web/e2e/m40-guardrail-hooks.spec.ts` (repeat N× → `NeedsInput` → resume; out-of-path write → denied, run continues); dogfood capped nightly ralph-loop; renumber/rebase re-confirm (ADR-104 / 0063 / M40 vs main + Studio) + ADR-anchor script + full gate sweep + `/aif-verify`.

## 11. Test-runnability (FROZEN)

- Runners: web unit (`pnpm --filter maister-web test:unit`), web integration (real PG via `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` + `dangerouslyDisableSandbox`), supervisor (`pnpm --filter @maister/supervisor test`), e2e (`pnpm --filter maister-web test:e2e`).
- New path families: supervisor enforcement tests under `supervisor/src/__tests__/`; web hook-escalation + native-materializer tests under `web/lib/**`. The mock ACP adapter(s) MUST be extended to emit scripted tool-call streams (Phase 2, not a follow-up).
- Per-phase exit: full suite green + supervisor suite green; tsc 0; eslint 0 on changed files. Migration phase: `db:generate` clean + journal monotonic. Docs phases: `pnpm validate:docs:all` + the ADR-anchor script.
- Assertion migration in-scope: the supervisor `requestPermission` / `readOnlySession` tests the interceptor reorders → updated IN Phase 2; the `ENFORCEABILITY_BY_AGENT` / flow-settings snapshot tests (6→7) → updated IN Phase 1; the `agent-map` / `materialize` settings.local.json tests → updated IN Phase 4.
