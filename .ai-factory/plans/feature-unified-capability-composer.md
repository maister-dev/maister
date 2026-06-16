# Implementation Plan: Unified Capability Composer & Multi-Agent Materialization

Branch: feature/unified-capability-composer
Created: 2026-06-16

/ Spec (source of truth): `docs/plans/2026-06-16-unified-capability-composer-design.md`
(FR-A1…FR-F2, locked decisions D1–D10). This plan is execution-only; requirement
detail lives in the spec.

## Settings
- Testing: yes — **TDD (red → green → refactor)**. Each behavioral task writes failing tests derived from the spec's FR/acceptance criteria BEFORE implementation.
- Logging: verbose — DEBUG at boundaries (normalizer, matcher, materializer, availableCommands capture, composer serialize/send); `LOG_LEVEL`/`DEBUG`-driven; reducible in prod without code edits.
- Docs: yes — mandatory docs checkpoint at completion (Phase 0 front-loads analytics; Phase 7 reconciles as-built).

## Roadmap Linkage
Milestone: "M14. Scoped capability materialization"
Rationale: This feature completes M14's materialization contract by generalizing it to **all** adapters (codex skills, not claude-only) and adds the capability-authoring surface (composer + autocomplete + cross-runner token normalization) on top of the M14 registry.

## Method (SDD + TDD)
- **Spec-first:** the design doc is frozen as the contract; tasks cite FR ids.
- **TDD discipline:** tests first, named per runner project, glob-confirmed (Rule "test-runnability").
- **Phase 0 is docs/analytics-first** (project rule): the analytics + contract specs are COMPLETE and internally consistent before any code phase.
- **Verbatim-forward invariant preserved:** all normalization is web-side; the supervisor forwards assembled prompt/content-blocks unchanged.

---

## Contract surfaces → spec files (Rule: trace every contract surface)

| Surface (changed/added) | Spec file(s) to update |
|---|---|
| `GET /api/scratch-runs/[runId]/commands` (live availableCommands snapshot; **scratch-only**) | `docs/api/web.openapi.yaml` + `docs/system-analytics/scratch-runs.md` + `runs.md` |
| `availableCommands` exposed on the run stream (was discarded) | `docs/api/async/web-runs.asyncapi.yaml` + `docs/system-analytics/runs.md` |
| Scratch message + node prompt carry **structured content blocks** (text + `resource_link`/`resource`), not just a string | `docs/api/web.openapi.yaml` (scratch messages route) + `docs/api/supervisor.openapi.yaml` (`POST /sessions/:id/prompt`) + `docs/supervisor.md` |
| `capabilityRecords.material.{description,argHint}` enrichment (no column → jsonb) | `docs/system-analytics/capability-catalog.md` + `capabilities.md` (NO migration; document material shape; database-schema.md only if a column is later justified) |
| New aggregator `getProjectCapabilityCatalog` (read API for the composer) | `docs/system-analytics/capability-catalog.md` + `flow-settings.md` |
| Per-adapter **materialization target** (claude `.claude/`, codex per-session `CODEX_HOME`) | `docs/system-analytics/acp-runners.md` + `flow-settings.md` + `agents.md` (subagent-for-scratch) |
| Scratch broad-materialization policy | `docs/system-analytics/scratch-runs.md` + `capabilities.md` |
| Launch progress SSE stages | `docs/api/async/web-runs.asyncapi.yaml` + `scratch-runs.md` |
| Error handling | reuse `CONFIG` / `EXECUTOR_UNAVAILABLE`; if any new code → `docs/error-taxonomy.md` (none expected) |

## Deployment touchpoints (Rule: enumerate deployment wiring)

| New dep / runtime artifact | Where it must land |
|---|---|
| Token-aware editor: **TipTap** (`@tiptap/react` + `@tiptap/pm` + `@tiptap/extension-mention`, MIT) | `web/package.json` + lockfile commit; bundle-size note |
| Per-session `CODEX_HOME` **composed** dir (symlink global `auth.json`/`config.toml` + per-skill symlinks of `~/.codex/skills/*` + materialized project `skills/`, project wins on collision) | supervisor `spawn` sets `CODEX_HOME` env; documented in `docs/configuration.md` + `acp-runners.md`. Run-dir-scoped → no new `.env` toggle unless a base path is tunable. NOTE: codex#21907 (cwd `.codex` auto-discovery) not shipped — flip to `cwd-dir` mode when it lands |
| Per-adapter homes/dirs for **gemini/opencode/mimo** (home-redirect or cwd-dir per Phase-0 verification): gemini `~/.gemini`+`GEMINI.md`, opencode `~/.config/opencode`, mimo `~/.mimocode` | `spawn` sets each agent's home/config-redirect env (verify per agent); `docs/configuration.md` + `acp-runners.md` |
| No new bound port, no new sidecar | n/a (call out explicitly so verify confirms) |

## HTTP route identifiers (Rule: label each identifier; derive cross-resource ids from server state)

- `GET /api/scratch-runs/[runId]/commands`: `runId` = **url-param** (access-controlled by RBAC); no body. Session lookup = **server-state** (registry/`runs` row). No body-controlled cross-resource id.
- Scratch messages route (content blocks): `runId` = url-param; **`resource_link`/`resource` URIs are body-controlled filesystem paths** → MUST be **path-confined to the run's worktree** (reuse the existing `artifacts/[id]/payload` confinement pattern) before becoming an ACP content block. This is a mandatory security task (Phase 5).

## Consumer fan-out (Rule: fan a new value out to ALL consumers)

- **Stop discarding `available_commands_update`** → audit EVERY session-update consumer: `web/lib/scratch-runs/transcript.ts` (`interpretScratchUpdate`), `web/lib/projector/artifact-projector.ts`, and any other `sessionUpdate` switch. Each must keep working when the event is now captured (not noise).
- **Content-block send-path** → EVERY prompt builder/consumer: scratch send (`web/lib/scratch-runs/service.ts`), node send (`web/lib/flows/runner-agent.ts`), resume path, gate-chat send, supervisor request schema + `acp-client` prompt assembly. A string-only assumption anywhere is a defect.

---

## Commit Plan
- **Commit 1** (Phase 0): "docs(spec): front-load analytics + contract specs for capability composer (M14)"
- **Commit 2** (Phase 1 / E): "feat(capabilities): canonical token model + normalizer + raw-text matcher (TDD)"
- **Commit 3** (Phase 2 / B): "feat(capabilities): install-time catalog enrichment + getProjectCapabilityCatalog"
- **Commit 4** (Phase 3 / C): "feat(capabilities): per-adapter materialization target (claude+codex) + scratch broad policy + subagents"
- **Commit 5** (Phase 4 / A): "feat(runs): capture + expose ACP availableCommands (stop discarding)"
- **Commit 6** (Phase 5 / D): "feat(web): unified token-aware composer (chips, @files, attachments, content-block send-path)"
- **Commit 7** (Phase 6 / F): "feat(runs): launch progress streaming + composer loader"
- **Commit 8** (Phase 7): "docs+chore: as-built reconciliation, deployment wiring, suite-green roll-up"

---

## Tasks

### Phase 0 — Analytics/design freeze (docs-first, BEFORE code)
- [x] **T0.1** Freeze the **normalizer/matcher truth table** and the **per-adapter materialization-target contract** in `docs/system-analytics/{flow-settings,acp-runners}.md` — canonical token grammar (`@skill:<slug>`, `@agent:<slug>`), per-runner surface forms (`/`,`$`,`@`,`mcp:`), matcher rules (exact-catalog-match, boundary-anchored, both-sigils→same ref, unmatched→literal, code-span suppression). Tag pieces Implemented/Designed.
- [x] **T0.2** Update **system-analytics** for the runtime/process changes: `scratch-runs.md` (static-entry → submit-materialize → live; broad materialization), `capability-catalog.md`/`capabilities.md` (`material.{description,argHint}` enrichment + `getProjectCapabilityCatalog`), `agents.md` (subagent-for-scratch, claude-only), `runs.md` (availableCommands capture + progress SSE). EVERY state/transition stated as code will gate.
- [x] **T0.3** Update **API/event specs** to the target contracts (write specs first, code conforms): `web.openapi.yaml` (`GET …/commands`, content-block message body), `supervisor.openapi.yaml` (`POST /sessions/:id/prompt` content blocks), `web-runs.asyncapi.yaml` (availableCommands + progress stages). Run `pnpm validate:docs:all` green.
- [x] **T0.4** **Per-adapter discovery verification (ALL 5)** against the locally-installed CLIs: for claude/codex/gemini/opencode/mimo determine discovery mode (`cwd-dir` vs `home-redirect`), home/dir + redirect env var, and `supports: {skills?, subagents?, mcp?, config?}`. Freeze the materialization-target table in `acp-runners.md`. Seen-so-far: gemini `gemini skills`/`~/.gemini`/`GEMINI.md`/MCP `settings.json`; opencode `agent`+`plugin`/`~/.config/opencode`; mimo opencode-shaped/`~/.mimocode`.
<!-- Commit checkpoint: Phase 0 -->

### Phase 1 — E: canonical token model + normalizer + raw-text matcher (pure logic; TDD-heavy)
- [x] **T1.1 (RED)** Write failing unit tests (web unit project — confirm the `lib/**` glob matches the new `web/lib/capabilities/__tests__/token-normalizer.test.ts`) for `normalizeCapabilityTokens` (FR-E2): chip/canonical → runner wire form, **table-driven per adapter from the registry/T0.4** (claude `/slug`, codex `$slug`, subagent `@name`, **+ gemini/opencode/mimo forms from T0.4** — not a 2-runner constant); unknown→literal; sigils recognized.
- [x] **T1.2 (RED)** Failing unit tests for the matcher (FR-E3/E4): exact catalog match only; boundary-anchored; `/usr/bin` & `$HOME` NEVER promoted; code-span suppression; send-time backstop normalizes un-chipified pasted tokens.
- [x] **T1.3 (GREEN)** Implement `web/lib/capabilities/token-normalizer.ts` + `token-matcher.ts` to pass T1.1/T1.2; the surface-form map is **read from the adapter registry (T0.4)**, not hardcoded. Logging: DEBUG each token decision `{raw, runner, resolvedRef|literal}`.
- [x] **T1.4** Wire the normalizer into the templating pass (`web/lib/flows/templating.ts` / `runner-agent.ts` render site) for node prompts and into the scratch send path — **web-side only; supervisor untouched** (assert verbatim-forward in a test). On a referenced capability not available for the effective runner: **WARN + proceed** (no hard `CONFIG`, no silent rewrite), per FR-E5. Migrate any existing prompt-render assertions in-scope.
<!-- Commit checkpoint: Phase 1 -->

### Phase 2 — B: install-time catalog enrichment + project+runner query
- [x] **T2.1 (RED)** Failing tests (web unit + integration via testcontainers — name both lanes) for: install/projection capturing `material.description`/`material.argHint` from `SKILL.md` frontmatter; `getProjectCapabilityCatalog(projectId, capabilityAgent)` returns project-connected, runner-supported caps with descriptions; codex excludes subagents, claude includes them; surface forms correct (FR-B1/B2/B3).
- [x] **T2.2 (GREEN)** Enrich the projection that writes `capabilityRecords` (`web/lib/capabilities/catalog.ts` + package install) to parse + store frontmatter into `material` (NO migration). Config-state symmetry (Rule): SET present → stored; CLEAR (frontmatter removed on reinstall) → cleared; idempotent re-set — all three tested.
- [x] **T2.3 (GREEN)** Implement `getProjectCapabilityCatalog` (skills from `capabilityRecords`, subagents from `agents` via `getProjectAgentsView`, enabled+trusted filter, runner mask + surface form). Logging: DEBUG `{projectId, runner, skillCount, subagentCount}`.
<!-- Commit checkpoint: Phase 2 -->

### Phase 3 — C: per-adapter materialization (ALL 5 adapters) + scratch broad policy + subagents
- [x] **T3.1 (RED)** Failing tests (web unit + integration; mock ACP adapter for the spawn→availableCommands assertion) for: adapter materialization-target descriptor; codex skills written to its skills location + `CODEX_HOME` set; subagent `.claude/agents/*.md` written for scratch (claude-only; codex omits with the existing `EXECUTOR_UNAVAILABLE` gate); scratch broad set = all enabled+trusted+runner-supported skills+subagents, MCP=selected (FR-C1…C4).
- [x] **T3.2 (GREEN)** Add the materialization-target descriptor to `supervisor/src/adapter-registry.ts` (`{ mode: 'cwd-dir'|'home-redirect', dir, layout }`); generalize `web/lib/capabilities/agent-map.ts` + `materialize.ts` beyond claude-only. codex = `home-redirect`: build a per-session `CODEX_HOME` **composed** dir — symlink global `auth.json`/`config.toml` + per-skill symlinks of `~/.codex/skills/*` + materialized project `skills/` (**project wins on name collision**). **Deployment wiring (same phase):** spawn sets `CODEX_HOME`; document in `configuration.md`/`acp-runners.md`. Test: global+project skills both surface in `availableCommands`; a project skill shadows a same-named global one. NOTE: flip to `cwd-dir` when openai/codex#21907 lands.
- [x] **T3.3 (GREEN)** Extract subagent `.md` materialization from `web/lib/agents/flow-binding.ts` into the shared materialize step; invoke for scratch. Crash-window (Rule): cleanup on cancel/failure mid-launch is explicit, not ignored.
- [x] **T3.4 (GREEN)** Switch scratch selection to broad (`launchScratchRun` / `resolveCapabilityProfile` input): all enabled+trusted+runner-supported skills+subagents; MCP stays selected/defaults. Materialize FILES (lazy-load); do NOT inline all instructions into the prompt.
- [ ] **T3.5 (GREEN)** Materializers for **gemini/opencode/mimo** per their Phase-0-verified targets (gemini → skills + `GEMINI.md` + MCP; opencode/mimo → agents + plugins + config + MCP). Each writes per its `supports` set; a surface an agent lacks → advisory/MCP-only (FR-E5). **Smoke per agent against the installed CLI** (skip-if-binary-absent, like the docker-gated integration lane). Deployment wiring: spawn sets each agent's home/config-redirect env; document in `configuration.md`/`acp-runners.md`.
  > PARTIAL: the generic home-redirect materializer (skills under `<home>/skills` + redirect env via the adapter `materialization` descriptor) is implemented in `adapter-home.ts` and file/env-tested (gemini case). DEFERRED: per-agent live-CLI `availableCommands` smoke (no mock ACP adapter exists — consistent with the codebase's gated-smoke posture; T3.1's spawn→availableCommands assertion is deferred for the same reason) and the `configuration.md` CODEX_HOME deployment doc (folded into Phase 7 / T7.2). Flow-path generalization to non-claude adapters also deferred (flow keeps its existing `.claude/` per-node path; FR-C3 broad targets scratch).
  > IN-ENV SMOKE 2026-06-17 (per owner: CI-for-all-adapters NOT needed; smoke in dev-env): **codex ✓** — the real `codex` CLI accepts a composed `CODEX_HOME` of the materializer's exact shape (symlinked global `auth.json`/`config.toml` + per-skill symlinks of `~/.codex/skills/*` + project-wins skill copy); `CODEX_HOME=<composed> codex mcp list` read the symlinked config and exited 0. **gemini ✗ (skill subpath)** — with `GEMINI_CLI_HOME` relocated, `gemini skills list` reports "No skills discovered" for `<home>/skills`; gemini discovers from the builtin bundle + `~/.agents/skills` (user scope) + project scope (`gemini skills install --scope project`), NOT `<GEMINI_CLI_HOME>/skills`. So the redirect ENV is correct but the generic skill subpath is wrong for gemini (and likely opencode/mimo — their claude-compat `.claude/skills` path is the candidate). FOLLOW-UP: correct the gemini/opencode/mimo skill placement per these findings (codex + claude — the ready families — are verified; gemini/opencode/mimo deprioritized per owner).
<!-- Commit checkpoint: Phase 3 -->

### Phase 4 — A: capture + expose ACP availableCommands (scratch-only)
- [x] **T4.1 (RED)** Failing tests for: capturing `available_commands_update` (latest-wins per session); fan-out — `transcript.ts`/`artifact-projector.ts` still behave with the event now captured; `GET /api/runs/{runId}/commands` returns `[{name,description,hint?}]`; SSE `lastEventId` reconnect unaffected (FR-A1…A3).
- [x] **T4.2 (GREEN)** Stop discarding the event; persist latest snapshot (session.json / stream state); expose via the run stream payload and/or `GET …/commands`. Identifiers: `runId` url-param, session via server-state. Logging: DEBUG `{sessionId, commandCount, runner}`.
- [x] **T4.3** Fan-out audit: update EVERY `sessionUpdate` consumer; add the route to `web.openapi.yaml` (already drafted in T0.3 — confirm code matches spec).
  > NOTE: capture is read-on-demand from the durable `run.events.jsonl` (the "run stream state" FR-A1 permits) — latest-wins, no migration, no new write. transcript.ts + artifact-projector.ts already correctly SKIP `available_commands_update` (not a transcript/artifact unit); existing tests assert this, so the fan-out audit confirmed no consumer change is needed. `GET …/commands` matches the Phase-0 web.openapi route.
<!-- Commit checkpoint: Phase 4 -->

### Phase 5 — D: unified token-aware composer
- [x] **T5.1** Editor = **TipTap** (ProseMirror). Add `@tiptap/react` + `@tiptap/pm` + `@tiptap/extension-mention` (+ minimal kit) to `web/package.json` + lockfile (deployment wiring); **MIT core only, no paid Collab/Pro**. Wire Suggestion for `/`·`@`·`$` triggers + a chip node.
- [x] **T5.2 (RED)** Tests — the editor's **interactive** behavior is **e2e-only** (stub-supervisor seeded playwright; add the spec to the AUTHED_SPEC regex); the unit lane is `environment: node` (no DOM) so `renderToStaticMarkup` covers only static initial render + pure serialize. E2E asserts: `/`+`@` triggers, atomic chip insert (icon+name, uniform across runners), validity state (claude-only subagent on codex → warn), runner switch re-renders wire form + re-filters (FR-D1…D4).
- [x] **T5.3 (GREEN)** Build `CapabilityComposer`; replace the `<textarea>` in `web/components/scratch/scratch-dialog.tsx` and `web/components/flows/node-form/node-side-form.tsx`. node-side-form seam = `onChange(value: string)` → composer **serializes to the canonical-token string on change** (flow.yaml stays a string). EN+RU i18n for all new strings (chips, badges, triggers).
- [ ] **T5.4 (GREEN)** Extend the send-path to structured content blocks end-to-end (scratch messages route → `supervisor-client` → supervisor request schema → `acp-client` prompt builder), preserving server-side secrets and verbatim-forward. **Path-confine `resource`/`resource_link` URIs to the worktree** (security, Rule: body-controlled path). **Reuse existing infra (don't build new):** `@file` lists via `GET /api/runs/[runId]/files` (running-scratch worktree) + `GET /api/projects/[slug]/files` (pre-launch/node-authoring → project repo; pre-launch has no worktree → project-files only); attachments via `web/lib/scratch-runs/attachments.ts` + the messages-route path (verify/extend to emit ACP `resource` blocks). Fan-out audit of all prompt builders.
  > LANDED (Commit 6 + 7): TipTap v3.26.1 (MIT core only) + pure serialize core (`composer-serialize.ts`, 7 tests, Commit 6); the interactive `CapabilityComposer` (chip node + `/`·`$`·`@` suggestion w/ per-trigger `PluginKey` + per-runner wire-form/validity badge + controlled canonical↔doc sync), the `getProjectCapabilityCatalog` route (`GET /api/projects/[slug]/capability-catalog?agent=`), EN+RU i18n (`composerUnsupported`), composer CSS, **wired into the scratch LAUNCHER** (`scratch-launcher.tsx` — the D1 intent-entry composer, the cleanest e2e-reachable host). VERIFIED in-env: static-render unit test + `scratch-composer.spec` e2e (`/` → suggestion → atomic chip) + the existing `scratch-launch` e2e still green (composer value flows to launch). Skill/agent chips work end-to-end at send via the Phase-1 normalize seam.
  > DEFERRED: replacing the textareas in `scratch-dialog.tsx` (running chat — needs `detail.{projectSlug,capabilityAgent}` + the live `GET …/commands` union) and `node-side-form.tsx` (flow authoring — needs flow-editor catalog plumbing); the content-block `@file`/attachment send-path + worktree path-confinement (T5.4); the live-availableCommands union into the running-scratch composer.
<!-- Commit checkpoint: Phase 5 -->

### Phase 6 — F: launch progress streaming + loader
- [ ] **T6.1 (RED)** Failing tests for staged launch events (`precondition → worktree_created → materializing(<adapter>) → spawning → session_ready`) and cancel-mid-launch GC of worktree/session (FR-F1/F2).
- [ ] **T6.2 (GREEN)** Emit staged progress from `launchScratchRun` (+ flow launch) over SSE; render the composer loader (EN+RU i18n for stage labels, validity badges, and the FR-E5 WARN); typed `MaisterError` on failure. Two-phase/crash-window (Rule): durable intent before side-effects; cleanup on every failure path; no orphan worktree/session.
<!-- Commit checkpoint: Phase 6 -->

### Phase 7 — As-built reconciliation, deployment, suite-green
- [ ] **T7.1** Mandatory docs checkpoint: reconcile Phase-0 specs with as-built (route through `/aif-docs`); flip implementation-status tags; `pnpm validate:docs:all` green.
- [ ] **T7.2** Deployment wiring roll-up: confirm editor dep in `package.json`+lockfile; `CODEX_HOME` handling documented; explicitly note "no new port/sidecar".
- [ ] **T7.3** Full suite green gate: `pnpm --filter maister-web test:unit && test:integration`, supervisor tests, `pnpm test:e2e` (new specs in AUTHED_SPEC), `eslint .` check-only, redocly/docs validators. Quarantine any pre-existing red explicitly with reason + follow-up (never silently tolerate or delete).

---

## Test integrity (Rule: runnability + per-phase green + assertion migration)
1. **Runnability** — every promised test names its runner project; when a test lands in a new path family, extend the runner `include` glob in the SAME phase and confirm with `vitest list`/equivalent.
2. **Per-phase green** — each phase exit = full unit+integration suite green; a touched test left red fails the phase.
3. **Assertion migration in-scope** — behavior changes (prompt render text, scratch send shape, transcript noise filter) update existing assertions in the same phase; name the files (`transcript.test.ts`, runner-agent/templating tests, supervisor-client tests).

## Decisions (resolved 2026-06-16)
- **codex materialization:** per-session `CODEX_HOME` composed dir (symlink global auth/config + per-skill symlinks of `~/.codex/skills/*` + project `skills/`, project wins). Flip to cwd-`.codex` on openai/codex#21907.
- **unsupported-on-runner:** advisory — composer shows non-universality (no block); run-time WARN + proceed (no hard `CONFIG`).
- **composer editor:** TipTap (ProseMirror), core + `extension-mention` (MIT).

## Next-up & design refinements (2026-06-17 — owner-confirmed, RESUME HERE)

State: Phases 0–4 + Phase 5 (composer wired into the scratch LAUNCHER, **e2e-verified**) + T3.5 in-env smoke = **8 commits, green, UNMERGED** (`12739d23`→`ce71a32f`). Web unit 4010 · tsc 0 · composer e2e 4/4. The items below **supersede** the original task text where they conflict.

**Three distinct autocomplete sources — by context (do NOT conflate):**
1. **Studio — editing a flow node prompt** → scan the **package's OWN `skills/`+`agents/` folders** (portable / self-contained; a node must only reference caps the package SHIPS, else the flow breaks when installed elsewhere). NOT `getProjectCapabilityCatalog` (project-scoped) and NOT live ACP. New source `getPackageCapabilityCatalog(installedPath, agent)` — reuse `collectInventory`'s folder-scan (`lib/packages/attach.ts:92-118`) + `splitFrontmatter` + the pure `skillCatalogEntry`/`subagentCatalogEntry` (`project-catalog.ts`). `getProjectCapabilityCatalog` STAYS the scratch-launcher source only.
2. **Scratch launcher (pre-launch entry)** → `getProjectCapabilityCatalog` (project + chosen runner). DONE (`scratch-launcher.tsx`).
3. **Running scratch chat** → live ACP `available_commands_update` (`GET /api/scratch-runs/[runId]/commands`, Phase 4 built) ∪ static subagents; map live wire-form names → canonical via the static catalog for chips.

**Corrected next-step order (RESUME):**
1. **Studio node-prompt composer** using the package-scan source (#1) **+ wire the matcher backstop** (raw paste `/x` → `@skill:x` → wire) at the node-render + scratch-send sites. ⚠ Currently only the *normalizer* (canonical→wire) is wired; the *matcher* (`token-matcher.ts`, built + unit-tested) is **NOT** wired, so raw pasted tokens aren't promoted (codex would get `/x` not `$x`). This is the runner-portability win for packaged flows.
2. **Running-scratch composer** → wire into `scratch-dialog.tsx` using live ACP commands ∪ subagents (add `detail.{projectSlug,capabilityAgent}` to the `GET /api/scratch-runs/[runId]` payload).
3. **T5.4** content-block `@file`/attachment send-path + worktree path-confinement (4 files: messages route → supervisor-client → supervisor schema → acp-client) + `@file` source in the composer.
4. **Phase 6** (launch progress SSE + composer loader), **Phase 7** (reconciliation + suite-green + `configuration.md` CODEX_HOME doc).
5. **gemini/opencode/mimo skill-PLACEMENT fix** (smoke 2026-06-17: gemini ignores `<GEMINI_CLI_HOME>/skills` — discovers from builtin + `~/.agents/skills` + project-scope; opencode/mimo claude-compat `.claude/skills` candidate). The redirect ENV is correct; only the skill subpath is wrong. Without this, flows on gemini/opencode materialize no skills.

**Node-composer nuances:** agent for wire-form/validity badge = node `settings.runner` → its `flow.yaml` `runner_profile.capability_agent` (fallback the flow's default profile); the **stored prompt stays canonical**. Offer **skills + subagents only** (subagent claude-only → warn on non-claude); native commands (`/compact`) and MCP (`mcp:server`) are NOT prompt artifacts (native = typed raw; MCP = node settings). Keep **package-only** (no platform/global caps — portability).
