# Spike findings — ACP runner model discovery & application (Phase 0A)

- **Date:** 2026-06-11
- **Plan:** `.ai-factory/plans/feature-acp-runner-model-discovery.md` (Phase 0A)
- **Feeds:** Phase 0B spec freeze; **gates** the Phase 3 application channel (T0A.3 → T3.1).
- **Method note (owner decision, 2026-06-11):** The three Phase 0A spikes
  (T0A.1–T0A.3) were planned as *live* probes against z.ai / ChatGPT-plan auth —
  real, billable inference calls. The owner elected to **lock the spike-gated
  decisions from already-verified research + adapter-source analysis** rather than
  spend billable calls, because (a) every gated decision is answerable from the
  pinned adapter sources and the M14/ADR-043 materialization code already on this
  branch, and (b) the entire implementation + its TDD suite run against **mocks**
  (`mock-acp-models.mjs`, stubbed `CcrManager`, mocked `fetch`, stub-supervisor),
  so live auth is not needed to build or verify. These findings are therefore
  **documented determinations**, not live measurements; each records its evidence
  basis. A live confirmation pass remains available as a follow-up but is **not** a
  blocker for this workstream.

---

## T0A.1 — `claude-agent-acp` probe cost & latency

**Question.** Does `initialize` + `session/new` (no prompt) spend tokens? What is
the per-probe wall-clock, to size the resolver probe-timeout constant (T2.1)?

**Determination.**
- **Token cost ≈ 0.** A probe drives only `initialize` → `session/new` → read
  `NewSessionResponse.models` → `SIGTERM`. No `session/prompt` is ever sent, so no
  inference request reaches the provider. Strong corroborating prior: Zed issues
  `session/new` on every thread open without billing a turn, and the M0 spike's
  `cost.jsonl` only ever recorded usage *after* a prompt. The cache-creation cost
  noted in the root `CLAUDE.md` (~$0.28/respawn) attaches to **resume + replay of a
  real conversation**, not to a promptless handshake.
- **Wall-clock.** Dominated by adapter process spawn + the ACP `initialize`
  round-trip (Node process start + stdio JSONL handshake). Budget conservatively.

**Locked output gate.** Resolver probe timeout = **15 s constant** (code constant,
not an env var — keeps deployment surface flat per the House-Rule Compliance
section of the plan). 15 s comfortably covers a cold adapter spawn + handshake
while bounding a hung probe. If real-world telemetry later shows a tighter or
looser bound is warranted, changing the constant is a one-line follow-up;
promoting it to an env var pulls in a Deployment-wiring task per the project rule.

---

## T0A.2 — `codex-acp` probe under ChatGPT-plan auth

**Question.** Does `session/new` require a live login? What does `availableModels`
contain per auth mode? What env must the codex probe assemble (given
`provisionRunnerLaunch()` **throws** for `openai_compatible`)?

**Determination.**
- `codex-acp@0.0.44` enumerates models **dynamically** (`fetchAvailableModels()` →
  `listModels()`); the returned list **reflects the active auth mode** (ChatGPT
  plan vs API key). So a probe's value depends entirely on whether the supervisor
  host carries usable codex credentials.
- `provisionRunnerLaunch()` throws `EXECUTOR_UNAVAILABLE` for `openai_compatible`
  ("requires Codex profile materialization before spawn"). The codex probe
  therefore **cannot** reuse the claude env-assembly path unchanged.

**Locked output gate (conservative, degrade-not-fail).** The codex ACP-probe
source is **best-effort with graceful degradation**:
- When the codex env/credentials needed to spawn `codex-acp` are present, the probe
  runs exactly like the claude probe (spawn → `initialize` → `session/new` → read
  `models` → SIGTERM) and contributes its `availableModels`.
- When codex requires a live login that the supervisor host cannot satisfy
  non-interactively (subscription-only, no API key in env), or when the
  `openai_compatible` env cannot be assembled, the probe returns
  **`status: "skipped"`** with a human-readable `reason` (e.g. `"codex probe
  skipped: no non-interactive auth"`). It **never** throws into the resolve and
  **never** fails the whole catalog — the provider-API + curated sources still
  answer. This is acceptable for v1 (design §, owner-confirmed).

---

## T0A.3 — claude model-application channel ⚠ GATES Phase 3 (T3.1)

**Question.** Which channel **pins** the configured model for a claude session:
the per-session `settings.local.json { model, availableModels }` (M14/ADR-043
materialization channel) **or** the ACP `unstable_setSessionModel(model)` call
after `session/new`? And: is the materializer invoked for **every** claude flow
run (not just scratch)?

**Determination — WINNER: `settings.local.json`.** Evidence basis (all current on
this branch @ `633f74c7`):
- `claude-agent-acp@0.37.0` **honors** `settings.json`'s `model` field — it calls
  `query.setModel()` itself at session start — and enforces an `availableModels`
  allowlist. So writing `{ model, availableModels }` into the per-session settings
  pins the model *before the first turn*, with no extra protocol round-trip and no
  dependency on reading back state.
- The M14/ADR-043 materializer (`materializeCapabilityProfile`,
  `mapProfileToAgentArtifacts`) **already receives `executor.model`**
  (`materialize.ts` ~46–51, today written only to `profile.json`) and **already
  runs on BOTH claude launch paths** — the scratch service *and* the flow
  runner-graph. The settings write is gated on `artifacts.settingsLocal !== null`
  (`materialize.ts` ~248). The backup + `.maister-owned` marker machinery already
  guards overwrite/reclaim. *(Implementation correction: on the runner-graph path
  the materializer ran only for capability-DECLARING nodes — a bare node skipped
  it entirely, so the apply fix added an explicit-empty materialization for
  claude nodes with a configured model; see ADR-075 §5.)*
- Therefore the application fix for claude is **minimal** (content plus the
  explicit-empty materialization above): extend
  `AgentSettingsLocal` to `{ permissions, model?, availableModels? }`, populate
  `model` (+ `availableModels` allowlist for `anthropic_compatible`/CCR GLM names)
  from the runner snapshot, and **return a non-null `settingsLocal` whenever
  `model` is set** (even with zero permission entries) so the existing write path
  fires for every claude session, not only when permissions are present.

**Why not `unstable_setSessionModel` for claude.** It is a post-`session/new`
protocol call that pins *after* the session exists, needs a read-back to confirm,
and is redundant with a channel the adapter already consults at startup. It
remains the **correct** channel for **codex** (T3.2), whose settings surface
differs and whose `setSessionModel` is the SDK-blessed switch.

**Locked output gate (T3.1 / T3.2).**
- **claude →** `settings.local.json { model, availableModels }` (always-on write
  whenever `runner.model` is set).
- **codex →** `unstable_setSessionModel(runner.model)` after `session/new` **and**
  after `session/resume` when `runner.model !== models.currentModelId`.

---

## Phase 0A exit

All three findings recorded; the **T0A.3 verdict (settings.local.json for claude,
setSessionModel for codex)** is locked and gates T3.1/T3.2. Probe timeout constant
= 15 s. Codex probe degrades to `status: "skipped"` without non-interactive auth.
These determinations are frozen into the Phase 0B spec (ADR-075 + `model-catalog.md`).
