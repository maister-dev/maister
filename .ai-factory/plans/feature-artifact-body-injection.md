# Plan — P2: Artifact body injection into prompts (`{{ artifacts.X.content }}` / `inline: true`)

**Branch:** `feature/artifact-body-injection`
**Created:** 2026-06-30
**Type:** feature (Flow DSL + templating engine)
**Driver:** PV gap P2 — forward-handoff of one node's artifact body into the next node's prompt. Today only artifact **metadata** (`kind`/`uri`/`validity`/`nodeId`) + an 8 KiB `steps.<id>.output` stdout slice are reachable; the artifact **body** is not. This forces flows to re-derive context that a prior node already produced.

## Settings

- **Testing:** YES — TDD, strict RED → GREEN → refactor. No trivial tests; edge cases covered with minimal overlap.
- **Logging:** Verbose (DEBUG during resolution/injection; INFO on inject; WARN on dedup/truncation). Module-local `pino`, never `console.log`. Secrets never logged.
- **Docs:** Mandatory — SDD, docs-first **Phase 0** is a hard gate before any code.
- **Roadmap Linkage:** Milestone `none` (PV-gap-driven P2 item; not a roadmap milestone).

## Roadmap Linkage

- **Milestone:** "none"
- **Rationale:** Driven by `docs/pv` gap audit (P2), not an `.ai-factory/ROADMAP.md` milestone.

---

## Goal (verifiable)

A graph flow node can inject a prior artifact's **resolved body** into its prompt, two ways:

1. **Manual placement** — `{{ artifacts.<id>.content }}` template var, author controls position.
2. **Auto placement** — `input.requires: [{ artifact: <id>, kind: <k>, inline: true }]`, engine appends a deterministic labeled block to the rendered prompt (dedup-guarded against manual placement).

**Headline acceptance:** a 2-node flow where node A produces artifact `X` and node B references it inline → the agent process spawned for node B receives a prompt that **contains X's body** (verified in the graph-runner integration harness), with **no re-derivation**.

## Locked design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **`inline: true` auto-appends an XML-tag-delimited block** `\n<artifact id="X" kind="K">\n…body verbatim…\n</artifact>` to the **rendered** prompt. The prompt body stays markdown; only the **delimiter** is an XML tag. | **Chosen over a markdown ` ``` ` fence on purpose:** artifact bodies routinely contain markdown fences (diffs, code, logs, plans) — a ` ``` ` wrapper collides with them and the boundary collapses. An XML tag has no fence-collision (only a literal `</artifact>` in the body breaks it — far rarer, and Anthropic models are trained to respect XML-tag document delimiters). Author needs zero prompt edits for forward-handoff. |
| D2 | **Dedup guard:** if the node's **raw** templates (`action.prompt` / `cli.command` / scanned gate prompts — see D9) already reference `artifacts.X.content`, the engine does **not** auto-append for `X` and emits a `WARN`. | Prevents double-injection when an author mixes both surfaces. Manual placement wins. |
| D3 | **Size cap = 256 KiB** (`MAISTER_ARTIFACT_INLINE_MAX_BYTES`, default `262144`), UTF-8-boundary-safe **truncate + in-band marker**, applied **only at the inline-injection seam** (`capForInline()` in the runner path) — **NOT** inside `resolveArtifactContent` and **NOT** on the payload route. Env-tunable. | Bounds prompt token cost without changing the payload API (see D7/D11 — Codex finding #1). Mirrors the 8 KiB stdout pattern. Never fails the run on a large body. |
| D4 | **Scope = graph `nodes[]` only.** `.content` lives in the shared `buildContext`/`reduceArtifacts` seam; the linear `runner.ts` path never populates it. A linear flow referencing `{{ artifacts.X.content }}` gets a clean strict `CONFIG`. | Zero shipped flow uses linear `steps[]` (all 8 repo manifests + all installed packages are `nodes:`). Wiring the dead path = test surface with no users. |
| D5 | **Engine floor `2.2.0` gates BOTH surfaces.** `inline: true` (grammar) AND any `{{ artifacts.<id>.content }}` reference (detected by a **manifest-load template scan**, delimiter-aware, sharing the runtime scan regex) require `compat.engine_min >= 2.2.0`, else `CONFIG` at load. `MAISTER_ENGINE_VERSION` bumps `2.1.0 → 2.2.0`. | **Revised (Codex finding #2, owner-confirmed):** the earlier "`.content` rides 1.2.0" left a cross-host hole — a package declaring `engine_min: 1.2.0` + `.content`, shared to an older host, is accepted at load but fails at runtime instead of being refused. The whole feature debuts at `2.2.0`; gating both surfaces makes `compat.engine_min` honest. The load-time scan reuses the runtime `collectContentArtifactIds` regex (DRY). |
| D6 | **No DB migration.** Pure render-time + manifest grammar. `inline` lives in the `flows.manifest` jsonb; content is resolved from existing `artifact_instances` rows + their payloads. | Sidesteps the migration-numbering hazard entirely. Stated explicitly so `/aif-verify` does not expect one. |
| D7 | **Shared resolver returns RAW content, no cap, no divergence.** Extract locator→content resolution out of `payload/route.ts`'s `switch(locator.kind)` into a server-only `resolveArtifactContent()` that returns the **uncapped** resolved value (`{kind:"text",text} \| {kind:"json",value} \| {kind:"gone"} \| {kind:"notfound"}`), reused by **both** the route (delegates directly → HTTP contract byte-identical, incl. >256 KiB payloads) and the runner. | **Revised (Codex finding #1):** putting the inline cap inside the resolver would silently truncate the payload API. The resolver does pure locator resolution (SRP); the cap is a separate injection-only concern (D3/D11). DRY: the two switches never drift. |
| D8 | **Validity = current-wins.** Content resolves from the `current` artifact row (`reduceArtifacts` is already current-wins). No current row for a referenced id → strict `CONFIG` (`{{...content}}`) or the existing `input.requires` `PRECONDITION` (`inline:true`). | One satisfying validity; consistent with M12. |
| D9 | **`gate-verdict` / `hitl-response` locators inject as pretty JSON** via the **named converter `artifactContentToTemplateText(result)`** (`kind:"json"` → `JSON.stringify(value, null, 2)`; `kind:"text"` → `text`). Inline is allowed for every locator kind. | **Pinned (Codex finding #4):** the json→text step is a single named, tested function — not scattered — so a JSON locator can never silently become `[object Object]`/undefined. The converter runs BEFORE `capForInline` (D11). |
| D10 | **Template-scan breadth = `action.prompt` + `cli.command` + `ai_judgment`/`skill_check` gate `prompt`s**, delimiter-aware (matches only inside `{{ … }}` tags). Content resolution covers ids referenced in any of them; `inline` auto-inject is restricted to prompt-bearing nodes (D12). | Confirmed `.content` usable in `ai_judgment`. Gate prompts render through `runAgentStep`'s `renderStrict` over the **same** node `context` (`runNodeGates(context)` at `runner-graph.ts:2942` → `gates-exec` → `runAgentStep:718`) — **no `gates-exec` edit**, only that the scan collects gate-referenced ids into the shared `context`. Delimiter-aware scanning avoids false positives on prose mentions (and false floor-gating in D5). |
| D11 | **Injection pipeline (named, ordered):** `resolveArtifactContent` (raw) → `artifactContentToTemplateText` (json pretty-print, D9) → `capForInline` (256 KiB, D3) → `{ text, truncated }` into `artifactContents`. The route uses **only** the resolver step (no convert-for-route — it keeps `NextResponse.json` for JSON locators; no cap). | **Codex findings #1+#4 combined:** one explicit pipeline removes the `{kind:json}`-vs-`{text,truncated}` impedance mismatch and keeps the cap off the route. |
| D12 | **`inline: true` is valid ONLY on prompt-bearing runner nodes** (`ai_coding` / `judge` / `orchestrator`); on `cli` / `check` / `human` / `form` it is **refused at manifest validation** (`CONFIG`). Manual `{{ artifacts.X.content }}` still renders in any template (incl. `cli.command`). | **Codex finding #3:** `input.requires[].inline` is on the generic `nodeInputSchema`, but auto-append only makes sense for a prompt. Appending an XML block to a shell `command` would corrupt it; on `human`/`form` there is no prompt. Explicit refusal beats a silent no-op. |

## Identifiers / trust boundary (skill-context: body-controlled-id rule)

- The artifact id in `{{ artifacts.X.content }}` and in `input.requires[]` is **`server-state`** — manifest-declared, resolved against the run's own `artifact_instances` rows via a `runId`-scoped query. No body-controlled cross-resource id. ✓
- `file` locator path is **server-written**; the shared resolver re-confines it (lexical prefix + symlink-realpath) to `.maister/<slug>/runs/<runId>/`, **identical** to the route's `serveFile`. MUST be preserved verbatim. ✓
- `gate-verdict`/`hitl-response` locators resolve through `runId`-scoped row reads (the resolver filters by `runId`). ✓
- **No secret surface added:** bodies are worktree/git/inline content the agent already has worktree access to; the resolver never reads `process.env`. The env secret-blocklist is N/A. ✓

## Rules explicitly N/A (stated for plan hygiene)

- **Two-phase commit / deferred-release / multi-store atomicity / status-fan-out** — the feature creates **no** deferreds, no external side-effects, no new routes with downstream effects, no multi-store transition, no new `runs.status`/enum. Pure read + render. None of these skill-context rules apply.

## Contract surfaces → spec files (skill-context: trace-every-surface rule)

| Surface | Spec file(s) |
|---|---|
| New Flow DSL field `input.requires[].inline: boolean` (valid only on `ai_coding`/`judge`/`orchestrator` — D12) | `docs/flow-dsl.md` (templating + node lifecycle) + `web/lib/config.schema.ts` (`nodeInputSchema` + node-type refine) |
| New template-context path `artifacts.<id>.content` | `docs/flow-dsl.md` (Templating context table) + `docs/system-analytics/artifacts.md` |
| New env var `MAISTER_ARTIFACT_INLINE_MAX_BYTES` | `docs/configuration.md` (env-vars table) + `.env.example` |
| Engine floor `2.2.0` — gates BOTH `inline:true` AND `{{ artifacts.X.content }}` (D5) (+ `MAISTER_ENGINE_VERSION` bump) | `docs/configuration.md` (engine-floor section) + `docs/flow-dsl.md` |
| ADR-120 | `docs/decisions.md` |
| Payload route refactor — **NO contract change** | `docs/api/web.openapi.yaml` (unchanged; verify byte-identical) |
| Content-resolution + injection process flow | `docs/system-analytics/artifacts.md` (new sequence/flow + Expectations + Edge cases) |

**No** new HTTP route, **no** new event, **no** new `MaisterError` code (reuse `CONFIG` / `PRECONDITION`).

## ADR / migration allocation (skill-context: reserve-up-front rule)

- **ADR-120** — "Artifact body injection into prompts (`{{ artifacts.X.content }}` + `input.requires.inline`)". Max ADR at `main` HEAD = ADR-119. **This branch claims ADR-120 and merges FIRST** (owner decision); the unmerged `dependency-ordered-task-queue` branch (which also pencilled ADR-120 per project memory) will be **moved separately by the owner**. Write the `### ADR-120` stub header before citing it anywhere.
- **Migration:** none (D6).
- **Renumber-pass task** budgeted (T8) — run AFTER rebasing onto `main`, verify ADR-120 still free at merge + (absence of) migration collision. No self-renumber expected since this branch is first.

---

## Phase 0 — SDD design spec (docs-first; HARD GATE)

> Exit criteria: every doc below is COMPLETE + INTERNALLY CONSISTENT and tagged with implementation status, so the code phases follow them as the single source of truth. `pnpm validate:docs` green; ADR anchor check green.

### T0.1 — ADR-120 stub + full decision
- **File:** `docs/decisions.md`
- Append `### ADR-120 — Artifact body injection into prompts` (context, decision, the D-table decisions above condensed, consequences, the **2.2.0 floor gating BOTH surfaces** via the load-time scan, the **resolver-returns-raw / cap-at-injection** split, the **`inline:true` node-type restriction**, the named **`artifactContentToTemplateText`** converter). One decision per ADR.
- **Verify:** anchor `decisions.md#adr-120-...` resolves; `### ADR-120` present at branch HEAD before any citation.

### T0.2 — `system-analytics/artifacts.md`: content resolution + injection
- **File:** `docs/system-analytics/artifacts.md`
- Add a **Domain entity** note: artifact **content accessor** (`artifacts.<id>.content`) + the `inline` input flag (D12 node-type restriction).
- Add a **Process flow** (`sequenceDiagram`): runner → collect content-ids (delimiter-aware template scan ∪ inline requires) → filter `currentArtifacts` (current-wins) → `resolveArtifactContent` (locator switch + confinement, **raw, no cap**) → `artifactContentToTemplateText` (json pretty-print) → `capForInline` (256 KiB) → `buildContext(artifactContents)` → shared `renderStrict` (action + gate prompts) → `inline` auto-inject tag (dedup).
- Extend **Expectations** (≤12 bullet cap — split file if over): content resolves only from `current`; **cap applied at injection only, NOT on the payload route**; file-locator confinement preserved; gate-verdict/hitl-response → pretty JSON via `artifactContentToTemplateText`; **both `inline:true` AND `{{...content}}` require floor `2.2.0`**; `inline:true` valid only on `ai_coding`/`judge`/`orchestrator` (D12); dedup single-injection; no secret/env read; graph-only; **content injected only via context var — never re-rendered (a body with `{{ }}` passes verbatim)**; gate prompts resolve `.content` through the shared node context.
- Extend **Edge cases:** payload gone → `CONFIG`/`PRECONDITION`; body over cap → truncated (injection only); manual+inline both → single inject + WARN; stale ref → strict `CONFIG`; linear flow `.content` ref → `CONFIG`; `inline:true` on cli/check/human/form → `CONFIG` at load; **artifact body containing literal `{{ … }}` → verbatim**; **>256 KiB payload through the API route → full, untruncated** (contract preserved).
- Tag everything `(Implemented — P2)` at branch HEAD (or `Designed` until code lands; flip in T7).
- **Verify:** R5 section order intact; mermaid parses.

### T0.3 — `flow-dsl.md`: templating + `inline` grammar
- **File:** `docs/flow-dsl.md`
- Templating context table: add `artifacts.<id>.content` row (source: resolved artifact body, capped **at injection**, `??`-guardable when absent, **requires `engine_min >= 2.2.0`**).
- `input.requires` section: document the `{ artifact, kind, inline: true }` object form, the **node-type restriction (D12)**, the `2.2.0` floor (both surfaces), the auto-inject XML-tag (`{{ artifacts.X.content }}` tag, not resolved text) + dedup rule.
- Add an engine-floor note: `2.2.0` gates `inline:true` AND any `{{ artifacts.X.content }}` reference (load-time scan).
- **Verify:** examples render; consistent with `config.schema.ts` shape from Phase 1.

### T0.4 — `configuration.md`: env var + engine floor
- **File:** `docs/configuration.md`
- Env-vars table: `MAISTER_ARTIFACT_INLINE_MAX_BYTES` (default `262144`, the per-injection body cap — does NOT affect the artifact payload API).
- Engine-floor section: **both** `inline: true` AND any `{{ artifacts.X.content }}` reference require `compat.engine_min >= 2.2.0` (the latter via a manifest-load template scan); `MAISTER_ENGINE_VERSION` is now `2.2.0`.
- **Verify:** matches `.env.example` (T6) + `engine-version.ts` (T1).

### T0.5 — Phase-0 consistency sweep
- Cross-check: artifacts.md ↔ flow-dsl.md ↔ configuration.md ↔ ADR-120 agree on every identifier (`MAISTER_ARTIFACT_INLINE_MAX_BYTES`, `2.2.0`, block format, error codes).
- **Verify:** `pnpm validate:docs` + ADR-anchor check green.

---

## Phase 1 — Schema + engine floor (TDD)

### T1.1 — RED: `nodeInputSchema` accepts `inline`, node-type rule, dual floor gate
- **Files (test):** `web/lib/__tests__/config.schema.test.ts` (or the nearest existing schema test), `web/lib/__tests__/config-engine-floor.test.ts`.
- Tests:
  - `{ artifact, kind, inline: true }` parses; `inline` typed `boolean`; non-boolean → zod error.
  - bare-string requires entry unchanged (no `inline` expressible).
  - **Node-type restriction (D12):** `inline:true` on `cli`/`check`/`human`/`form` → `MaisterError("CONFIG")` at validation; on `ai_coding`/`judge`/`orchestrator` → OK.
  - **Floor — `inline:true`:** `engine_min "2.1.0"` → `CONFIG`; `"2.2.0"` → OK.
  - **Floor — `.content` scan (D5):** a node whose `action.prompt` / `cli.command` / `ai_judgment` gate `prompt` contains `{{ artifacts.X.content }}` with `engine_min "2.1.0"` → `CONFIG`; `"2.2.0"` → OK. A bare-text (non-`{{ }}`) `artifacts.x.content` mention → NOT gated (delimiter-aware).
  - **SET/CLEAR symmetry (both surfaces):** add `inline:true` / add a `{{...content}}` ref → floor required; remove → floor NOT required (manifest valid at lower floor again).
- **Logging:** none (pure schema/validation).

### T1.2 — GREEN
- **Files:** `web/lib/config.schema.ts` — `nodeInputSchema.requires` object branch: add `inline: z.boolean().optional()` (drop `.passthrough()` reliance for this key); add a node-level `superRefine` (or graph-validate rule) rejecting `inline:true` on non-prompt nodes (D12).
- `web/lib/flows/engine-version.ts` — `MAISTER_ENGINE_VERSION = "2.2.0"`.
- `web/lib/config.ts` — new `const ARTIFACT_INLINE_ENGINE_MIN = "2.2.0"`; floor-gate check (mirror existing blocks ~L873+): `CONFIG` when, with `engineMin < 2.2.0`, ANY node has (a) an `input.requires` entry `inline === true`, OR (b) a `{{ artifacts.<id>.content }}` reference in `action.prompt` / `cli.command` / `ai_judgment`·`skill_check` gate `prompt` — using the **shared `collectContentArtifactIds`** scan (delimiter-aware) from `artifact-inject.ts` so load-time and runtime detection never drift.
- **Refactor:** keep the gate beside the sibling floor checks; reuse the existing version-compare helper; the scan regex is defined once (Phase 4) and imported here.

### T1.3 — Verify
- `pnpm --filter maister-web test:unit` green for the touched files; `vitest list` confirms the new test files are globbed.
- **Note (build order):** the load-time gate imports `collectContentArtifactIds` from Phase 4's `artifact-inject.ts`. Land that pure helper (T4.1/T4.2) first OR co-locate the scan regex in a shared module both phases import — pick the shared-module option to keep Phase 1 self-contained.

---

## Phase 2 — Shared content resolver (TDD)

### T2.1 — RED: `resolveArtifactContent` (RAW, no cap) + converter + cap helpers
- **File (test):** `web/lib/flows/graph/__tests__/artifact-content.test.ts`.
- `resolveArtifactContent` result shape (RAW, **no cap, no truncation here**): `{ kind: "text"; text } | { kind: "json"; value } | { kind: "gone" } | { kind: "notfound" }`.
- Resolver tests (minimal overlap, one behavior each):
  - `inline` → `text` = locator.text (**full, even >256 KiB** — proves no cap in the resolver).
  - `file` inside run dir → reads full content.
  - `file` `../` traversal → `notfound` (asserts **no** fs read of outside path).
  - `file` symlink escaping run dir → `notfound`.
  - `file` ENOENT → `gone`.
  - `git-range` → `text` from mocked `diffRange` (preserves diffRange's own truncation marker — pre-existing, unrelated to the inline cap).
  - `git-log` → `text` from mocked `logRange`.
  - `gate-verdict` → `json` value from mocked db row (runId-scoped).
  - `hitl-response` → `json` value from mocked db row (runId-scoped).
- `artifactContentToTemplateText(result)` tests (D9): `kind:"text"` → text; `kind:"json"` → `JSON.stringify(value, null, 2)` (NOT `[object Object]`); `gone`/`notfound` → caller-defined throw (CONFIG).
- `capForInline(text)` tests (D3): over-cap → truncated + `ARTIFACT_TRUNCATED_MARKER` & `{truncated:true}`; under-cap → untouched `{truncated:false}`; cap honored from `MAISTER_ARTIFACT_INLINE_MAX_BYTES` override; UTF-8 multibyte at the boundary → not split into invalid bytes.

### T2.2 — GREEN
- **File:** `web/lib/flows/graph/artifact-content.ts` (server-only).
- `resolveArtifactContent(row, ctx)` where `ctx = { worktreePath, projectSlug, runId, runtimeRoot, db }` — pure locator resolution, **returns raw** (SRP; D7). Port the locator switch from `payload/route.ts`; reuse `diffRange`/`logRange`/`DIFF_TRUNCATED_MARKER` from `@/lib/worktree`; port the lexical+symlink confinement verbatim into a small `confineRunFile()` helper.
- `artifactContentToTemplateText(result)` (D9) — json pretty-print; `gone`/`notfound` → `MaisterError("CONFIG")`.
- `capForInline(text): { text; truncated }` (D3) — byte-bounded, UTF-8-safe, appends `ARTIFACT_TRUNCATED_MARKER`; reads `MAISTER_ARTIFACT_INLINE_MAX_BYTES`.
- **Logging:** DEBUG per resolve `{runId, artifactId, locatorKind}`; WARN on `gone`/`notfound`; DEBUG on cap `{artifactId, truncated}`.

### T2.3 — REFACTOR: route delegates to the resolver (no cap)
- **File:** `web/app/api/runs/[runId]/artifacts/[artifactId]/payload/route.ts`.
- Replace the inline switch with `resolveArtifactContent`; map `text→text/plain`, `json→NextResponse.json(value)`, `gone→410`, `notfound→404`. **No cap, no `artifactContentToTemplateText`** on the route (it keeps the structured JSON response for json locators).
- **Acceptance + regression (Codex #1):** route HTTP contract **byte-identical**; existing payload-route tests pass **unmodified**; **ADD a regression test: a >256 KiB `inline` (and `file`) artifact returns the FULL untruncated body through the route** (proves the injection cap never reaches the API). `docs/api/web.openapi.yaml` unchanged.

### T2.4 — Verify
- Unit green; existing route tests green unmodified; new over-cap route regression green; `vitest list` globs the new tests.

---

## Phase 3 — Context plumbing (TDD)

### T3.1 — RED: `buildContext` carries content
- **File (test):** extend `web/lib/flows/__tests__/context.test.ts` (or the nearest).
- Tests:
  - `artifactContents` present → `ctx.artifacts[id].content` set (+ `contentTruncated` when truncated).
  - absent → `.content` undefined.
  - content attached only to the **current-wins** id.

### T3.2 — GREEN
- **Files:** `web/lib/flows/types.ts` — `FlowContext.artifacts[*]` gains `content?: string; contentTruncated?: boolean`.
- `web/lib/flows/context.ts` — `BuildContextArgs` gains `artifactContents?: Record<string, { text: string; truncated: boolean }>`; `reduceArtifacts` attaches `.content`/`.contentTruncated` from it. The map values are the OUTPUT of the D11 pipeline (`artifactContentToTemplateText` → `capForInline`), built by the runner (Phase 4) — `buildContext` stays pure (no I/O, no cap logic).
- **Logging:** DEBUG `{ ids: Object.keys(artifactContents) }`.

### T3.3 — Verify
- Unit green. `{{ artifacts.X.content }}` render covered by a small renderStrict test fixture: renders content; bare ref absent → `CONFIG`; `?? 'none'` guarded default when absent; **a body whose text is `"see {{ task.prompt }}"` renders the braces VERBATIM (not re-resolved) — the mustache re-render invariant.**

---

## Phase 4 — Runner collect + inject (TDD)

> **Render seam (verified):** `runAgentStep` (`runner-agent.ts:718`) calls `renderStrict(promptTemplate, ctx.context)` **itself** — the node prompt is passed **raw** and rendered downstream, NOT in runner-graph. Gate prompts use the **same** path: `runNodeGates(context)` (`runner-graph.ts:2942`) passes the node's `context` (built at ~L2382) into `gates-exec`, which hands `gate.prompt` to `runAgentStep` → `renderStrict(context)`. **Consequence:** (a) the inline surface must inject a `{{ artifacts.X.content }}` **template tag** into the raw prompt (resolved later by the shared render), never a string-concat of resolved body; (b) gate-prompt `.content` works with **no `gates-exec` edit** — it only needs the gate's referenced ids resolved into the shared `context`.

> **Mustache re-render invariant (correctness):** artifact bodies can contain literal `{{ … }}`. Inject content **only via the context var** — mustache substitutes the value literally and does **NOT** recursively render it. NEVER string-concatenate a resolved body into a template and re-render (the body's braces would be re-processed → `CONFIG`/corruption). This is why the inline surface appends a `{{ artifacts.X.content }}` *tag*, not the resolved text.

### T4.1 — RED: pure helpers
- **File (test):** `web/lib/flows/graph/__tests__/artifact-inject.test.ts`.
- `collectContentArtifactIds(node)` → ids from a **delimiter-aware** template scan (matches `artifacts.<id>.content` ONLY inside `{{ … }}` tags — e.g. `/\{\{[^}]*\bartifacts\.([\w-]+)\.content\b[^}]*\}\}/g`) over `action.prompt` + `cli` `command` + `pre_finish` gate `prompt`s of kind `ai_judgment`/`skill_check` (D10) ∪ `inline:true` requires.
  - hyphenated ids (`plan-summary`); no false positive on `artifacts.x.uri`; **no false positive on a bare-text `artifacts.x.content` outside `{{ }}`**; matches `{{ artifacts.X.content ?? 'x' }}` (guarded form); union dedup; id referenced only in a gate prompt is collected. **(This is the SAME function the Phase-1 load-time floor gate imports — single source of truth.)**
- `augmentPromptWithInlineTags(rawPrompt, inlineEntries)` → returns the raw prompt **template** with one XML block per inline id **not** already referencing `artifacts.<id>.content` in `rawPrompt`, each block = `\n<artifact id="X" kind="K">\n{{ artifacts.X.content }}\n</artifact>` (a **template tag**, resolved later by the shared `renderStrict`). Deterministic order; appended AFTER the existing `[Run context: …]` pointer.
  - inline id manually referenced in `rawPrompt` → skipped + WARN (single injection).
- **Note:** json pretty-print (`artifactContentToTemplateText`) + truncation (`capForInline`) happen in the runner BEFORE `buildContext` (T4.3 / D11) — the value is already final text in `context` when the tag renders; this helper is pure string composition with no body knowledge.

### T4.2 — GREEN
- **File:** `web/lib/flows/graph/artifact-inject.ts` (pure functions, no I/O — testable in isolation). Houses `collectContentArtifactIds` + the shared scan regex (imported by Phase 1's load-time gate).
- **Logging:** WARN on dedup skip `{ nodeId, artifactId }`; INFO on inject `{ nodeId, artifactIds[] }`.

### T4.3 — RED→GREEN: wire into `runner-graph.ts`
- **File:** `web/lib/flows/graph/runner-graph.ts` (the `buildContext` call site, ~L2378-2392, and the `executeNodeAction` prompt-augment seam ~L1115).
- After the existing `getArtifactsForRun` (L2380): `ids = collectContentArtifactIds(node)`; resolve content by **filtering the already-fetched `currentArtifacts`** (current-wins) for those ids — NOT N+1 `getCurrentArtifact` calls — then per id run the **D11 pipeline** `resolveArtifactContent(row, ctx)` → `artifactContentToTemplateText` → `capForInline` → `{text, truncated}` into `artifactContents`; pass into `buildContext`. This single `context` feeds both the action prompt AND the gate prompts (shared-seam fact above), so gate-prompt `.content` works automatically.
- Inline auto-inject: `augmentPromptWithInlineTags(def.action.prompt, inlineRequires)` at the `executeNodeAction` prompt-augment seam (where `[Run context: …]` is already appended), so the appended `{{ artifacts.X.content }}` tags render through the shared `renderStrict`. Persona/agent-binding prepend (`runAgentStep` L695/714) is upstream and unaffected — the tags ride in the task block. **(D12: this seam only fires for prompt-bearing nodes; `inline:true` on cli/check/human/form was already refused at load in Phase 1.)**
- `gone`/`notfound` on a referenced/inline id → fail the node (`CONFIG`) before spawn (consistent with the existing `input.requires` `PRECONDITION` for a missing current row).
- **Test (integration):** graph-runner harness — node A produces artifacts; node B asserts injection across **all locator families**:
  - `file` + `inline` artifact `X` referenced via `{{ artifacts.X.content }}` in `action.prompt`, via `inline:true`, AND via an `ai_judgment` gate prompt → action prompt AND gate prompt contain X's body; dedup → single copy when manual + inline both used.
  - **`gate-verdict` and `hitl-response` artifacts** referenced the same way → prompt contains the **pretty-printed JSON** (not `[object Object]`), proving the converter path (Codex #4).
  - Edge: payload gone → node `CONFIG`-fails; stale artifact → not current → strict error; **body containing `{{ … }}`** → verbatim, not re-processed; **`inline:true` on a `cli` node** → refused at load (negative case, may live in Phase 1 but assert here too if the harness loads such a flow).

### T4.4 — Verify
- `pnpm --filter maister-web test:unit && test:integration` green; new integration test globbed.

---

## Phase 5 — Full-suite green checkpoint
- Run `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` — **green**.
- `pnpm --filter maister-web lint` (scoped; do not let `eslint --fix` reformat the repo — gate with `eslint .` check-only or scope the fix).
- `pnpm --filter maister-web typecheck`.
- Any pre-existing red surfaced → explicit quarantine task with reason, never silent.

---

## Phase 6 — Deployment wiring (skill-context: deployment-touchpoints rule)
- **Files:** `.env.example` (add `MAISTER_ARTIFACT_INLINE_MAX_BYTES=262144` near the other `MAISTER_*` tunables) + `docs/configuration.md` env table (T0.4 already drafted — reconcile values).
- Check compose files for the `MAISTER_*` `environment:` pattern; the var is optional (has a default), so add to the web service `environment:` **only if** sibling `MAISTER_MAX_*` vars are already wired there — otherwise the `.env.example` + default is sufficient (note the decision).
- **Verify:** `.env.example` ↔ `configuration.md` ↔ `artifact-content.ts` default agree (`262144`).

---

## Phase 7 — Docs as-built reconcile
- Flip any `(Designed)` → `(Implemented — P2)` in `artifacts.md` / `flow-dsl.md` / `configuration.md`.
- Confirm `docs/api/web.openapi.yaml` is **unchanged** (route refactor only).
- **Verify:** `pnpm validate:docs` + ADR anchor check green.

---

## Phase 8 — Renumber pass (AFTER rebase onto main)
- Rebase onto `main`; re-resolve ADR-120 vs. the `dependency-ordered-task-queue` branch (renumber if it merged first).
- Confirm no migration was added anywhere (D6).
- Re-run the doc anchor check + full suite.

---

## Commit plan (5+ tasks → checkpoints)

| Checkpoint | Covers | Suggested message |
|---|---|---|
| C1 | Phase 0 | `docs(flows): SDD spec for artifact body injection (ADR-120)` |
| C2 | Phase 1 | `feat(flows): inline requires flag + engine floor 2.2.0` |
| C3 | Phase 2 | `refactor(artifacts): shared resolveArtifactContent + route delegates` |
| C4 | Phase 3–4 | `feat(flows): inject artifact body into prompts ({{artifacts.X.content}} / inline)` |
| C5 | Phase 5–7 | `chore(flows): deployment wiring + as-built docs reconcile` |

(Per project convention — omit the AI co-author trailer.)

---

## Acceptance criteria (turn green to ship)

- [x] `{{ artifacts.<id>.content }}` renders the resolved, capped body of the `current` artifact in a graph node prompt.
- [x] `input.requires: [{ artifact, kind, inline: true }]` auto-injects an XML-tag block via a `{{ artifacts.X.content }}` tag; dedup-guarded + WARN when the prompt also references the tag manually.
- [x] **Both** `inline: true` AND any `{{ artifacts.X.content }}` reference with `engine_min < 2.2.0` → `CONFIG` at load; `>= 2.2.0` → OK. SET/CLEAR symmetric for both surfaces (D5).
- [x] `inline: true` on `cli`/`check`/`human`/`form` → `CONFIG` at load; allowed only on `ai_coding`/`judge`/`orchestrator` (D12).
- [x] Body > 256 KiB → truncated + in-band marker **at injection**; cap honored from `MAISTER_ARTIFACT_INLINE_MAX_BYTES`.
- [x] **Payload API contract preserved:** a >256 KiB `inline`/`file` artifact returns the FULL untruncated body through the route; `resolveArtifactContent` returns raw (no cap); existing route tests green unmodified; OpenAPI unchanged (Codex #1).
- [x] All 6 locator kinds resolve via the **shared** `resolveArtifactContent`; `gate-verdict`/`hitl-response` inject as **pretty JSON** via `artifactContentToTemplateText` (not `[object Object]`) — proven in integration (Codex #4).
- [x] `file` locator confinement (lexical + symlink) preserved; traversal → no read.
- [x] No DB migration; no new error code; no new HTTP route/event.
- [x] Graph integration: node B's spawned `action.prompt` AND an `ai_judgment` gate prompt contain node A's artifact body across all locator families (no re-derivation); inline injects via a tag, never re-rendered body.
- [x] An artifact body containing literal `{{ … }}` renders verbatim (mustache re-render invariant) — covered by a test.
- [x] Full unit + integration suite green; lint (scoped) + typecheck clean; `validate:docs` + ADR-anchor green.
- [x] Docs (artifacts.md / flow-dsl.md / configuration.md / decisions.md) consistent and status-tagged.

---

## Решённые вопросы (зафиксировано)

1. ✅ **Формат блока** — XML-тег `<artifact id kind>…</artifact>` (D1). Причина выбора над md-fence: тела артефактов часто содержат ` ``` ` → fence-обёртка ломается; XML-граница нет. Тело внутри — verbatim (md/diff/json), сам промпт остаётся markdown.
2. ✅ **gate-verdict/hitl-response** — оборачиваем stringified JSON в тот же блок; inline разрешён для всех видов локаторов (D9).
3. 🔁 **`.content` ПОДНЯТ до floor 2.2.0** (D5, пересмотрено по Codex#2, owner-confirmed). Раньше было 1.2.0; дыра кросс-хост портабельности (пакет с engine_min 1.2.0 + `.content` на старом хосте падал в рантайме вместо отказа на load). Теперь оба сюрфейса (`inline:true` + `{{...content}}`) гейтятся на 2.2.0; `.content` детектится load-time скан-ом (тот же regex, что и рантайм — DRY).
4. ✅ **Скан шаблонов** — `action.prompt` + `cli.command` + `ai_judgment`/`skill_check` gate `prompt` (D10), delimiter-aware (только внутри `{{ }}`). Gate-промпты рендерятся через общий `context` (runNodeGates→gates-exec→runAgentStep) — правки `gates-exec` НЕ нужны. Бывший T4.5 удалён.
5. ✅ **ADR-120** — эта ветка мержится первой; dependency-ordered-task-queue двигаешь отдельно.

## Изменения по adversarial-review (Codex)

- **#1 (high)** — `resolveArtifactContent` теперь возвращает RAW (без cap); cap (`capForInline`) только на injection-шве, не на route. Route отдаёт полное тело (>256 KiB) byte-identical. Регресс-тест добавлен (T2.3).
- **#2 (high)** — `.content` гейтится на 2.2.0 через load-time скан (D5, T1).
- **#3 (medium)** — `inline:true` валиден только на `ai_coding`/`judge`/`orchestrator`; на cli/check/human/form → CONFIG (D12, T1). Негативные тесты.
- **#4 (medium)** — именованный `artifactContentToTemplateText` (json→pretty) + интеграционные тесты для gate-verdict/hitl-response (D9, D11, T2/T4).

## Остаточный риск

- Build-order: load-time floor gate (Phase 1) импортит `collectContentArtifactIds` из Phase 4 — разрешено вынесением скан-regex в общий модуль (T1.3 note). Главный инвариант корректности — инъекция тела ТОЛЬКО через context-var (mustache не ре-рендерит подставленное значение).
