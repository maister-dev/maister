# Unified Capability Composer & Multi-Agent Materialization — Design / Requirements

- **Date:** 2026-06-16
- **Status:** Approved design (converged in brainstorming 2026-06-16) — requirements spec for SDD/TDD planning
- **Owner:** Albert Kanishchev
- **Method:** Spec-first (SDD). Requirements below are numbered (FR-*) and carry acceptance criteria so tests can be written **before** implementation (TDD: red → green → refactor).

## 0. Problem

The web control plane has no autocomplete for skills/agents when a user writes a
prompt — neither in the **Scratch Run** composer nor in the **AI-coding node**
prompt editor. Both are plain `<textarea>`s
([scratch-dialog.tsx](../../web/components/scratch/scratch-dialog.tsx),
[node-side-form.tsx](../../web/components/flows/node-form/node-side-form.tsx)).
Coding-agent CLIs surface skills/commands as typeahead; we want the equivalent in
the web, and it must work across runners whose invocation syntax differs
(claude `/skill`, codex `$skill`), without the author having to care.

Three intertwined needs:
1. **Autocomplete** of the capabilities actually available for the chosen
   project + runner, in a **unified composer** used everywhere (scratch start,
   running scratch chat, node prompts).
2. **Cross-runner unification** of how a skill/agent is written in a prompt — one
   authoring experience, correct wire syntax per runner.
3. **Materialization for every supported agent** (not claude-only today), so the
   running session genuinely has the project's package capabilities.

## 1. Verified ground truth (informs every requirement)

- **Prompt is forwarded verbatim** to the adapter; no per-runner rewriting exists
  ([acp-client.ts `sendPromptOnConnection`], [supervisor-client.ts `sendPrompt`]).
  This invariant must be preserved — all normalization stays web-side.
- **ACP `available_commands_update` is emitted by both pinned adapters** and is the
  authoritative, runner-correct command list per live session. **codex-acp bakes
  `$` into the `name`** (`` `$${skill.name}` ``); **claude-agent-acp emits bare
  names** (+ `mcp:` prefix for MCP commands). MAIster **currently discards** this
  event as noise ([transcript.ts:184](../../web/lib/scratch-runs/transcript.ts),
  [artifact-projector.ts:150](../../web/lib/projector/artifact-projector.ts)).
- **`AvailableCommand` shape:** `{ name, description, input?: { hint } }`.
- **Catalog has no description for skills.** `capabilityRecords` carries `label` +
  `material` jsonb (paths), **no `description`/`argHint`**
  ([schema.ts capabilityRecords](../../web/lib/db/schema.ts)). The `agents` table
  **does** have `name` + `description` + `mode`.
- **Coder subagents** = `agents` rows with `mode='subagent'`, sourced from a flow
  package's `agents/<stem>.md`, materialized to `.claude/agents/<stem>.md`
  ([flow-binding.ts `resolveFlowBoundAgent`](../../web/lib/agents/flow-binding.ts));
  **claude-only** (codex → `EXECUTOR_UNAVAILABLE`). Not present in the
  `availableCommands` stream. Enumerable via `getProjectAgentsView`
  ([project-links.ts](../../web/lib/agents/project-links.ts)).
- **Templating is the normalization seam.** `renderStrict`
  ([templating.ts](../../web/lib/flows/templating.ts)) runs **web-side** in
  `runAgentStep` ([runner-agent.ts:603](../../web/lib/flows/runner-agent.ts))
  before `sendPrompt`; context already carries `executor.agent` (claude/codex)
  resolved from the launch-pinned `runnerSnapshot` ([types.ts FlowContext]).
- **Scratch materialization today** is the shared `materializeCapabilityProfile`
  ([materialize.ts](../../web/lib/capabilities/materialize.ts)) over a **selected
  subset**; `mapProfileToAgentArtifacts` writes skills + `settings.local.json`
  **claude-only**, codex gets MCPs but **no skills**
  ([agent-map.ts](../../web/lib/capabilities/agent-map.ts)). Subagent `.md` files
  are **not** materialized for scratch. **Runner is fixed at launch**, immutable on
  recover ([recover route](../../web/app/api/scratch-runs/[runId]/recover/route.ts)).
- **Social-board mentions use `KEY-N`, not `@`**
  ([mentions.ts:25](../../web/lib/social/mentions.ts)); `@` is free in-product. The
  adapter does **not** parse `@` in incoming prompt text (`promptToClaude` only
  rewrites a `/mcp:` special case); file/resource mentions arrive as structured
  `resource_link`/`resource` content blocks.

## 2. Locked decisions

- **D1 — No pre-warm / template worktree.** Intent-entry uses **static-only**
  autocomplete; materialization + real session happen **on submit** for the final
  chosen runner. Rationale: any live materialized session during entry forces
  per-(project,runner) materialization and fragile re-spawn on runner switch.
- **D2 — Static source = enriched catalog**, filtered to the project's
  enabled+trusted packages and to runner support. Descriptions/arg-hints are
  captured **at install** so autocomplete is a pure DB read.
- **D3 — Live source = ACP `available_commands_update`**, authoritative once a
  session runs (includes the agent's **native/global** commands). Union with
  **static subagents** (claude-only, never in the stream).
- **D4 — Token-aware composer with chips.** Three layers: **display** (uniform
  chip + icon, agent-agnostic) / **storage** (canonical token) / **wire**
  (runner-specific form). One component for scratch + node prompts + running chat.
- **D5 — Canonical token** `@skill:<slug>` / `@agent:<slug>`; normalizer →
  `/<slug>` (claude) · `$<slug>` (codex) for skills, `@<name>` for subagents
  (claude-only).
- **D6 — One matcher, multiple call sites** (load/paste/blur/send), bound to the
  available-command catalog; **send/compile is the correctness backstop**; chips
  are an **enhancement, not a correctness requirement**; unmatched `/`-text stays
  literal (agent resolves natively or as text).
- **D7 — Per-adapter materialization contract** generalized beyond claude; for
  **scratch**, materialization is **broad** (all enabled+trusted+runner-supported
  skills + subagents); **MCP stays selected/defaults** (each stdio MCP = a process).
- **D8 — Sigils by meaning:** `@` = files/folders/resources + agents (categorized
  typeahead); `/`·`$` = skills/commands. Mentionable **MAIster-orchestrated** agents
  reserve the qualified `@agent:` namespace for a **future** phase (spawn-as-run via
  interception at the normalize seam).
- **D9 — Launch progress streaming** over SSE (worktree → materialize → spawn →
  ready); no UI freeze.
- **D10 — Runner switch during entry = instant re-filter + chip re-normalization**;
  no materialization, no spawn.

## 3. Components & functional requirements

### A. Live `availableCommands` capture & exposure

- **FR-A1** Stop discarding `available_commands_update`. Persist the **latest**
  snapshot per session (e.g. `session.json` / run stream state); last-write-wins.
- **FR-A2** Expose the snapshot to the web composer (extend the run stream payload
  and/or `GET /api/scratch-runs/[runId]/commands`) as `[{ name, description, hint? }]`.
  (Scratch-only — flow nodes are non-interactive; the node composer is static-catalog-only.)
- **FR-A3** Names are exposed **as emitted** (codex `$x`, claude bare / `mcp:`); the
  composer maps them to canonical refs via the catalog (B). No supervisor rewriting.
- **Acceptance:** for a running session the list is retrievable and equals the
  adapter's emission; SSE `lastEventId` reconnect still works; the event no longer
  appears as transcript noise.

### B. Catalog enrichment at install + project+runner capability query

- **FR-B1** In the install/projection pass that writes `capabilityRecords`, parse
  `SKILL.md` frontmatter and store **`description`** + **`argument-hint`** (in
  `material` jsonb to avoid a migration; columns only if justified). Agents already
  carry `name`/`description`.
- **FR-B2** New aggregator `getProjectCapabilityCatalog(projectId, capabilityAgent)`
  returns a unified list:
  `{ kind: 'skill'|'subagent', refId, slug, displayName, description, argHint?,
  canonicalToken, surfaceForm, supported }`, sourced from `capabilityRecords`
  (kind=skill) ∪ `agents` (mode=subagent), filtered to **enabled+trusted** packages.
- **FR-B3** Runner filter + surface-form computation: skill supported iff the
  per-agent map includes the runner; subagent supported **iff runner=claude**;
  `surfaceForm` = `/<slug>` (claude) · `$<slug>` (codex) for skills, `@<name>` for
  subagents.
- **Acceptance:** result contains only project-connected, runner-supported caps with
  descriptions; codex result excludes subagents; switching the `capabilityAgent`
  argument flips surface forms and subagent inclusion with no other change.

### C. Per-adapter materialization

- **FR-C1** Add a **materialization target** to the runner/adapter registry
  ([adapter-registry.ts](../../supervisor/src/adapter-registry.ts)):
  `{ mode: 'cwd-dir' | 'home-redirect', dir, layout }`. claude → `cwd-dir`: worktree
  `.claude/` (`skills/`, `agents/`, `settings.local.json`). codex → `home-redirect`:
  a **per-session `CODEX_HOME`** *composed* dir — symlink global `auth.json` +
  `config.toml` and per-skill symlinks of `~/.codex/skills/*` (restores global+project
  parity with claude), plus materialized project `skills/` (**project wins on name
  collision**); `CODEX_HOME` env set on spawn.
  **All five adapters get a verified target** — the descriptor also carries
  `supports: { skills?, subagents?, mcp?, config? }` (surfaces differ per agent;
  verified 2026-06-16 vs installed CLIs: gemini 0.46 = `gemini skills` + home
  `~/.gemini` + project `GEMINI.md` + MCP `settings.json`; opencode 1.16 =
  `agent`+`plugin` + `~/.config/opencode`; mimo 0.1 = opencode-shaped + `~/.mimocode`).
  Phase 0 freezes each agent's discovery mode + home/dir + `supports` set.
  NOTE: codex does **not** auto-read cwd `.codex/skills` yet (openai/codex#21907) —
  flip codex to `cwd-dir` mode when it lands.
- **FR-C2** Generalize materialization (`mapProfileToAgentArtifacts` /
  `materializeCapabilityProfile`) to write **per the target**, not claude-only.
  **codex skills must be written** to codex's skills location and `CODEX_HOME` set at
  spawn so `listSkills` discovers them.
- **FR-C3** **Scratch policy = broad**: materialize all enabled+trusted+
  runner-supported **skills + subagents** (claude); **MCP = selected/defaults**.
  Flow runs keep per-node selection. Skill/subagent files are lazy-loaded by the
  agent → materialize **files**, do not dump all instructions into the prompt.
- **FR-C4** Extract subagent `.claude/agents/*.md` writing from flow-binding into the
  shared materialize step and invoke it for scratch (claude-only; codex omits).
- **Acceptance:** a codex scratch session surfaces project skills via
  `$`-prefixed `availableCommands`; a claude scratch session surfaces skills +
  subagents; scratch materialized set is broad; flow runs unchanged; secrets stay
  server-side.

### D. Token-aware composer (unified)

- **FR-D1** Replace the `<textarea>` in scratch-dialog and node-side-form with one
  shared **token-aware editor** (`CapabilityComposer`, built on **TipTap**/ProseMirror
  — Mention/Suggestion extension drives the `/`·`@`·`$` typeahead + chip nodes).
- **FR-D2** Triggers: `/` (skills/commands typeahead), `@` (files/folders/resources +
  agents, categorized), optional `$` alias for skills. Selection inserts an **atomic
  chip** (icon + display name), never raw text.
- **FR-D3** Chips hold the canonical token + metadata, render **uniformly across
  agents**, and show an **advisory non-universality badge** (capability not available
  on the selected runner → warn, e.g. `claude-only` / runner-specific — **no block**).
- **FR-D4** File/folder mentions and attachments serialize to ACP
  `resource_link` / `resource` content blocks (**reuse** existing
  `GET /api/runs/[runId]/files` + `GET /api/projects/[slug]/files` for listing and
  `web/lib/scratch-runs/attachments.ts` for uploads — don't build new); skill/agent
  chips serialize to wire text via the normalizer (E).
- **FR-D5** Extend the send path to carry **structured content blocks** (not just a
  string) end-to-end: scratch messages route → `supervisor-client` → supervisor
  request schema → `acp-client` prompt builder. Server-side secret handling and
  verbatim-forward of the assembled blocks preserved.
- **Acceptance:** chip looks identical across runners; runner switch re-renders the
  chip's wire form and re-filters the typeahead with no materialization; a file
  mention produces a resource block; an unsupported-cap chip warns.

### E. Canonical token model + normalizer + raw-text matcher (cross-cutting)

- **FR-E1** Grammar: `@skill:<slug>`, `@agent:<slug|pkgQualified>`. Stored in node
  prompts (portable) and scratch drafts.
- **FR-E2** `normalizeCapabilityTokens(content, capabilityAgent, catalog)` expands
  chips/canonical tokens → runner wire form. Runs in the **`renderStrict` pass** for
  nodes and at **scratch send**. Per-adapter wire form is **table-driven** from the
  adapter materialization-target/registry (FR-C1 `supports` + T0.4), not a claude/codex
  constant. Supervisor untouched (verbatim-forward).
- **FR-E3** Matcher: recognizes `/x`, `$x`, `@x` that **exactly** match a catalog
  command → canonical ref. Boundary-anchored; both sigils → same ref; **unmatched
  left literal**; suppressed inside code spans/fences. Never deletes/mangles
  non-matches.
- **FR-E4** Matcher call sites: **load** (chipify a node prompt), **paste** (promote,
  undoable), **blur/save** (safety net), **send/compile** (correctness backstop —
  guarantees correct wire form even for un-chipified pasted text).
- **FR-E5** Capability not universal across runners: the composer **shows
  non-universality** on the chip (advisory badge) — it does **not** block submit. At
  run time, if the effective runner cannot honor a referenced capability, **emit a
  WARN** ("may be incorrect on <runner>") and **proceed** — no hard `CONFIG` fail, no
  silent token rewrite. (Owner decision 2026-06-16: advisory over fail-fast.)
- **Acceptance:** pasted `/aif-plan` runs correctly on codex (→ `$aif-plan`);
  `/usr/bin` and `$HOME` are **never** promoted; unknown `/foo` stays literal and
  reaches the agent verbatim; a claude-only subagent chip on codex warns.

### F. Launch progress streaming

- **FR-F1** `launchScratchRun` (and flow launch) emit staged SSE progress:
  `precondition → worktree_created → materializing(<adapter>) → spawning →
  session_ready`.
- **FR-F2** Composer renders a loader from the stream; no freeze; failure surfaces a
  typed `MaisterError` code; cancel mid-launch GCs the worktree/session.
- **Acceptance:** UI shows live stages with server-provided labels; failure shows the
  typed error; cancellation leaves no orphan worktree/session.

## 4. Token model — the three layers

| Layer | Form | Where |
|---|---|---|
| Display | chip: icon + display name (no sigil) | composer UI |
| Storage | canonical `@skill:<slug>` / `@agent:<slug>` | node prompt / scratch draft |
| Wire | `/slug` (claude) · `$slug` (codex) · `@name` (subagent, claude) · `mcp:<server>` | string sent to the agent |

## 5. Per-runner surface forms

| Entity | claude | codex |
|---|---|---|
| Skill | `/slug` (bare name; client/normalizer adds `/`) | `$slug` (`$` baked into ACP name) |
| MCP command | `mcp:<server>` | built-in `/mcp` |
| Built-ins | `/compact`, … | `/status`, `/skills`, … |
| Subagent | `@name` | — (mode=subagent unsupported) |

> gemini/opencode/mimo surface forms + `supports` set are frozen in Phase 0 (T0.4);
> the normalizer (FR-E2) reads them table-driven from the adapter registry.

## 6. Lifecycle flows

- **Intent entry:** static catalog (B) → chips; no session. Runner switch →
  re-filter + chip re-normalization (D10/E2). Native commands not shown yet.
- **Submit:** materialize for final runner (C) + spawn → progress stream (F).
- **Running:** autocomplete = live `availableCommands` (A) ∪ static subagents.
- **Paste / blur / load:** matcher (E3/E4) promotes recognized tokens; send-time
  backstop guarantees correctness regardless.

## 7. Data / contract changes

- `capabilityRecords.material` gains `description` + `argHint` (no migration if jsonb).
- New `getProjectCapabilityCatalog` (read API) + a composer-facing endpoint.
- Run stream payload (or new route) exposes `availableCommands`.
- Send path carries content blocks; supervisor request schema extended; assembled
  blocks still forwarded verbatim.
- Adapter registry gains a materialization-target descriptor.

## 8. Out of scope / deferred

- **Mentionable MAIster-orchestrated agents** (spawn-as-run via `@agent:`): reserve
  the namespace now; orchestration + prompt interception later (ties to the
  `orchestrator`-node direction).
- **Pre-warm / template worktree** for latency: dropped; revisit only if post-submit
  cold start is a measured bottleneck.
- **(now in scope)** Concrete materializers for **all five** adapters
  (claude/codex/gemini/opencode/mimo) — the CLIs are installed locally + on the
  server, so each is smoke-tested. A surface an agent genuinely lacks (e.g. codex
  subagents, opencode skills) falls back to advisory (FR-E5) / MCP-only.
- **Promotion UX polish** (auto-promote vs suggest-with-undo on paste): decide at
  composer design time.

## 9. Risks / edge cases

- Matcher false positives → strict exact-match against catalog + code-span
  suppression + literal passthrough (E3).
- Native/global agent commands invisible until the session is live (accepted; D3).
- Rich-editor dependency: **TipTap** (ProseMirror) chosen — Mention/Suggestion maps
  onto `/`·`@`·`$` typeahead+chips; MIT core only (no paid Collab/Pro); justified
  because the unified composer needs tokens for `@files`/attachments regardless.
- MCP process/secret cost → MCP stays selected, not eager (C3); secrets server-side
  only, never in `session/update` to the browser.
- Concurrency: no oracle session is introduced (D1); submit-time session counts
  against the existing cap.

## 10. Testing strategy (TDD)

Write failing tests from the acceptance criteria first, per layer (vitest unit;
testcontainers integration; mock ACP adapter for runtime; stub-supervisor seeded
playwright e2e; React via `renderToStaticMarkup`, `.test.ts`).

- **Unit (logic-first):** normalizer (canonical↔wire per runner, both sigils,
  unknown→literal); matcher (exact catalog match, boundary, code-span suppression,
  no false positives on `/usr/bin`/`$HOME`); `getProjectCapabilityCatalog`
  (project+runner filter, enrichment fields, subagent claude-only); per-adapter
  materializer (claude `.claude/` writes; codex `CODEX_HOME` skills; subagent gate).
- **Integration:** install → catalog enrichment; materialize → spawn → mock-adapter
  `availableCommands` reflects the materialized set; scratch broad materialization.
- **E2E:** composer autocomplete lists project skills; chip insert; runner switch
  re-renders wire form + re-filters; paste raw token → promoted; submit shows
  progress stages; cancel GCs.
- **Note:** the composer's **interactive** behavior (TipTap/ProseMirror — Suggestion
  popup, chip insert, runner-switch) is **e2e-only**; the unit lane is
  `environment: node` (no DOM), so `renderToStaticMarkup` covers only the static
  initial render + pure serialize.

## 11. Proposed phasing (logic-first for TDD)

1. **E** — token model + normalizer + matcher (pure, unit-test heavy).
2. **B** — catalog enrichment + query.
3. **C** — per-adapter materialization (claude + codex).
4. **A** — `availableCommands` capture + exposure.
5. **D** — unified token-aware composer (integrates A/B/E).
6. **F** — launch progress streaming.

## 12. Decisions (resolved 2026-06-16)

- **codex materialization:** per-session `CODEX_HOME` composed dir = symlink global
  `auth.json`/`config.toml` + per-skill symlinks of `~/.codex/skills/*` + materialized
  project `skills/` (project wins on collision). Restores global+project parity; flip
  to cwd-`.codex/skills` when openai/codex#21907 lands.
- **unsupported-on-runner:** advisory — composer shows non-universality on the chip
  (no block); run-time WARN + proceed (no hard `CONFIG`, no silent rewrite).
- **composer editor:** TipTap (ProseMirror) — core + `extension-mention` (MIT); no
  paid modules.

## 13. Cross-references

`docs/system-analytics/`: scratch-runs, capabilities, capability-catalog,
flow-settings, agents, acp-runners, flow-studio, runs.
