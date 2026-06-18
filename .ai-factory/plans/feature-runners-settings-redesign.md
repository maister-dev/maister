# Implementation Plan: Runners settings screen redesign

Branch: claude/quirky-torvalds-2dd78e
Created: 2026-06-18

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement

## Roadmap Linkage (optional)
Milestone: "none"
Rationale: Skipped by user — settings UX/honesty polish + CCR lifecycle, no dedicated milestone.

## Background / Research Context

Owner complaints about the settings → runners area:
1. A "huge table of preconfigured runners the user never made", incl. a fake-ready CCR/GLM runner.
2. Presets in the Add-runner popup are good; research which routing sidecars exist for other adapters + hint the user for unconfigured ones.
3. Router-sidecar card buttons (CCR) should move to the card's top-right as icons w/ tooltips; add the ability to start CCR from MAIster.
4. Move platform agents off settings into a dedicated admin-only section.
5. "Adapter support" cards are too big — use a color indicator, not a textual badge; remove repetition.

Root cause (verified): [`seed.ts`](../../web/lib/db/seed.ts) `ensurePlatformRuntimeDefaults()` inserts the **entire** `platformRunnerPresetRows()` catalog (10 rows) into `platform_acp_runners`; the same list is rendered again as "Provider presets"; `readinessStatus` is hardcoded in the preset, never verified.

Routing-sidecar research (per-adapter):
- **claude** — native Anthropic, or **CCR** sidecar (`@musistudio/claude-code-router`, `~/.claude-code-router/config.json`, port 3456) for multi-provider.
- **codex** — env-router (`~/.codex/config.toml`, OpenAI-compatible `base_url`+`env_key`, `wire_api = responses`); no "codex-router" exists.
- **gemini** — Google-only natively; non-Google needs a translating gateway (LiteLLM).
- **opencode** — native multi-provider; pkg is `opencode-ai`; `opencode auth login`.
- **mimo** — native multi-provider (OpenCode fork, Xiaomi MiMo Code); `mimo acp` **confirmed working** (owner verified in terminal 2026-06-18).
- Universal proxy (deferred): one LiteLLM instance can front several adapters via its OpenAI- and Anthropic-compatible endpoints.

Conclusion for point 2: there is **no** CCR-analog sidecar to install for the other adapters — the actionable thing is a **per-adapter setup hint** (install / key / smoke), not a sidecar zoo.

## Decisions (architecture)

- **Preset catalog = templates only.** `platformRunnerPresetRows()` is **kept unchanged** (still consumed by the Add-runner popup, the `/api/admin/acp-runners` GET, and a new collapsed reference list) but is **no longer seeded** into `platform_acp_runners`. Minimal blast radius — `presets.test.ts` stays green.
- **Default runners materialized on adapter scan, at admin settings load.** New `reconcilePlatformRunners({ db, diagnostics })`:
  - `nativeDefaultRunnerByAdapter`: `claude→claude-code`, `codex→codex-openai`, `gemini→gemini-cli`, `opencode→opencode-native`, `mimo→mimo-native` (each = the catalog row for that adapter's native provider).
  - For each adapter reported **available** by supervisor diagnostics, **upsert-if-absent** its native default row.
  - **Recompute readiness for ALL rows** via `evaluateRunnerReadiness(...)` against live diagnostics and store it (`readiness_status` / `readiness_reasons`).
  - Set `platform_runtime_settings.default_runner_id` if currently null and a Ready default exists.
  - **Never auto-delete.** A materialized row is a normal editable runner; if an adapter goes unavailable the row stays and reads not-ready. Deleting a still-available default re-materializes next load (disable to suppress) — accepted.
- **Honest readiness (scoped).** Stop trusting hardcoded preset `readinessStatus`; the reconcile is the single writer; UI shows a color dot + tooltip, never a hardcoded label. **Caveat (verified):** `evaluateRunnerReadiness` does NOT credential-verify native `anthropic`/`openai` providers — for `claude-code`/`codex-openai`, readiness = adapter binary available (`--version` ok, `supervisor/src/http-api.ts:303`), with NO API-key/login check. So a native default reads Ready whenever the binary is installed. We therefore label the native-provider state **"Available (ambient credentials)"** rather than a verified "Ready", and document the limitation (ADR-093 + acp-runners.md). A real per-adapter auth-smoke (parallel to the gemini/opencode/mimo smoke gate) is **deferred** by owner decision 2026-06-18.
- **Reconcile robustness.** When supervisor diagnostics are **unavailable** (null), the reconcile **skips** materialization and readiness recompute entirely (preserve last-known) — never clobber every runner to NotReady on a transient outage. Persist a row only when `status`/`reasons` actually changed (no `updated_at` churn). Auto-default selection uses a deterministic adapter preference order (claude > codex > gemini > opencode > mimo).
- **CCR start/stop reuses the existing supervisor `CcrManager`** (spawn / identity-validated `/health` / SIGTERM→SIGKILL / keyed instances, already invoked on `router:ccr`). We only expose start/stop endpoints + buttons — no new process manager. **Gap (verified):** `CcrManager.shutdown()` stops **ALL** instances and clears the map (`supervisor/src/ccr-manager.ts:596`) — there is no per-id stop; wiring `/sidecars/:id/stop` to it would kill every CCR instance and any live session routing through CCR. We add a per-instance `CcrManager.stop(instanceId)` and target it (T5.1a). CCR **runner configuration** (config.json contents + runners routing through CCR) is **deferred** to a separate session; Start just launches the process (healthcheck stays red until a config exists — honestly).
- **No DB schema change, no migration.** Existing auto-seeded rows on the local dev DB are cleaned by a one-off (a task), not a migration; fresh installs are clean because the seed no longer inserts the catalog.

### Trigger & consumer fan-out (per skill-context "fan out to ALL consumers")
The reconcile runs on the **admin settings page load** (which already fetches diagnostics) — the single writer of `readiness_status`. All readiness CONSUMERS read the **stored** column and need **no code change**, but the plan documents the trigger so the dependency is explicit:
| Consumer | File:line | Reads |
| --- | --- | --- |
| Launch dialog | `web/app/api/runs/launch-options/route.ts:105` | stored `readinessStatus` |
| Scratch launch | `web/app/api/scratch-runs/launch-options/route.ts:153` | stored |
| Run-create precondition | `web/lib/services/runs.ts:220` | stored |
| Scratch precondition | `web/lib/scratch-runs/service.ts:282` | stored |
| Agent launch | `web/lib/agents/launch.ts:203` | stored |
| Project default guard | `web/app/api/projects/route.ts:265,277`, `web/lib/queries/project.ts:157,234` | stored |
| Rail readiness chip | `web/lib/acp-runners/runner-readiness-rows.ts:14` → `app/(app)/layout.tsx:54` → `readiness-summary.ts:69` | stored |
| Set-default guard | `web/app/api/admin/acp-runners/route.ts:211` (`assertReadyRunner`) | stored + live recompute |

**Known limitation (documented, accepted):** on a fresh instance, runner rows + honest readiness materialize/refresh when an admin first opens **Settings**. Until then launch dialogs show no platform runners. Acceptable for an admin-operated instance; eager materialization is a later option if needed.

### Contract surfaces → spec files (per skill-context "trace every contract surface")
| Surface | Spec file |
| --- | --- |
| `POST /api/admin/router-sidecars/{sidecarId}/start` + `/stop` | `docs/api/web.openapi.yaml` (after the existing router-sidecars block) + prose in `docs/system-analytics/acp-runners.md` |
| `POST /sidecars/{id}/start` + `/stop` (supervisor) | `docs/api/supervisor.openapi.yaml` (before `components:`) + prose `docs/supervisor.md` (## HTTP API + ## CCR lifecycle) |
| Default-runner materialization + honest readiness (process flow) | `docs/system-analytics/acp-runners.md` (## Domain entities, ## Expectations, ## Process flows) |
| New error usage `EXECUTOR_UNAVAILABLE` on start failure | reuse — already in `docs/error-taxonomy.md`; no new code |
| ADR | `docs/decisions.md` → **ADR-093** |

No new env var, no new bound port (CCR's 3456 is pre-existing), no new DB column → **no** `.env.example` / compose / ERD changes required. Deployment touchpoint per skill-context: verify the `ccr` binary is on PATH in the supervisor container (it is the binary `CcrManager` already spawns) and document the admin start path; if absent in-container, document the gap in `docs/getting-started.md` + `docs/configuration.md` rather than silently shipping it.

### ADR numbering (per skill-context "reserve up front + budget renumber")
Next-free at **main HEAD** is `### ADR-092` → reserve **ADR-093**. ⚠ The unmerged Flow-Studio-Phase-C plan also targets ADR-093 (+ migration 0053). This plan adds **no migration**, so only the ADR number can collide. Budget an explicit **renumber pass** (after rebase onto main) — whichever branch merges second renumbers its ADR. `pnpm validate:docs` does not resolve ADR anchors → run `scripts/validate-docs-adr-anchors.mjs` explicitly.

### Identifiers & side-effect safety (per skill-context body-controlled + two-phase rules)
- **web start/stop route** `[sidecarId]` = `url-param`; the sidecar config is loaded from DB (`server-state`), forwarded to the supervisor. **No DB idempotency marker is written** — process state is owned by the supervisor (`CcrManager.ensureRunning`/`shutdown` are idempotent) and surfaced via `/diagnostics`. The route is a proxy returning the supervisor-reported state, so the two-phase-commit rule is satisfied by *not* persisting an AFTER-marker at all (no retry hazard).
- **supervisor start/stop route** `:id` = `url-param`; the `CcrInstanceConfig` (lifecycle/configPath/baseUrl/healthcheckUrl) arrives in the body = `body-controlled`, trusted because the only caller is the admin-gated web tier (server-to-server). The handler validates the `lifecycle` enum and that the body `id` matches the path `:id`.

## Commit Plan
- **Commit 1** (Phase 0): "docs(acp-runners): ADR-093 + analytics/OpenAPI for default-runner materialization & CCR start/stop"
- **Commit 2** (Phase 1): "feat(runners): materialize default runners from adapter scan; honest readiness; stop seeding catalog"
- **Commit 3** (Phase 2): "feat(settings): compact adapter-support cards + per-adapter setup hints"
- **Commit 4** (Phase 3): "feat(settings): collapsed provider-presets reference + Use-prefill"
- **Commit 5** (Phase 4): "feat(agents): move platform agents to admin-only /agents route"
- **Commit 6** (Phase 5): "feat(ccr): admin start/stop for managed router sidecar + iconified sidecar cards"
- **Commit 7** (Phase 6): "test+i18n(runners): migrate e2e/seed, en/ru parity, full gate"

## Tasks

### Phase 0 — Docs/analytics first (front-load; complete + internally consistent before code)
- [x] **T0.1** Reserve `### ADR-093` in `docs/decisions.md` documenting (a) default runners materialized from adapter scan instead of seeded; honest readiness **with the explicit limitation that native `anthropic`/`openai` readiness = adapter-binary-available, not credential-verified** (status surfaced as "Available (ambient credentials)"; auth-smoke deferred), (b) CCR managed-process admin start/stop **incl. the per-instance `stop(id)` addition**. Note the Flow-Studio-Phase-C collision + renumber budget. Logging: n/a (doc). Acceptance: header exists at HEAD; `node scripts/validate-docs-adr-anchors.mjs` green.
- [x] **T0.2** Update `docs/system-analytics/acp-runners.md`: `## Domain entities` (default runners no longer row-seeded; materialized on adapter scan at settings load; `platformRunnerPresetRows()` = templates only), `## Expectations` (reconcile is the single readiness writer; native `anthropic`/`openai` readiness = binary-available, NOT credential-verified → "Available (ambient credentials)"; reconcile skips writes when diagnostics are unavailable), `## Process flows` (new "Default-runner reconcile on settings load" flow incl. the supervisor-down skip path). Implementation-status tags on each piece.
- [x] **T0.3** Update `docs/supervisor.md`: add `### POST /sidecars/:id/start` + `### POST /sidecars/:id/stop` under `## HTTP API`; expand `## CCR lifecycle` with admin-triggered start/stop semantics + idempotency. Update `docs/api/supervisor.openapi.yaml` (`/sidecars/{id}/start|stop` before `components:`, referencing the existing `idle|starting|ready|failed|stopping` enum) and `docs/api/web.openapi.yaml` (`/api/admin/router-sidecars/{sidecarId}/start|stop`, `tags:[admin]`, `sidecarId` path param). Acceptance: `pnpm redocly lint` (or repo's OpenAPI lint) + `pnpm validate:docs` green.
<!-- Commit checkpoint: Phase 0 -->

### Phase 1 — Defaults via adapter scan + honest readiness (core)
- [x] **T1.1** New `web/lib/acp-runners/native-defaults.ts`: `nativeDefaultRunnerByAdapter` map + `reconcilePlatformRunners({ db, diagnostics })` — **if diagnostics are unavailable (null), no-op (preserve last-known; log + return)**; otherwise upsert-if-absent native default per AVAILABLE adapter; recompute readiness for ALL rows via `evaluateRunnerReadiness` (signature: `{runner, diagnostics, sidecar}`) and **persist only when status/reasons changed** (no `updated_at` churn); set `default_runner_id` if null and a Ready default exists, picking by **deterministic adapter order (claude > codex > gemini > opencode > mimo)**; never auto-delete. LOGGING (verbose): DEBUG on entry with available-adapter list; INFO+return when diagnostics unavailable; DEBUG per upsert (inserted vs skipped-existing); DEBUG per readiness change (id → old→new status + reasons; skip unchanged); INFO when default_runner_id is set; format `[reconcilePlatformRunners] msg {data}`. Files: `web/lib/acp-runners/native-defaults.ts`.
- [x] **T1.2** `web/lib/db/seed.ts`: remove the `platformAcpRunners.values(platformRunnerPresetRows())` insert; keep the `platformRouterSidecars` (`ccr-default`) insert and the `platform_runtime_settings` singleton but seed `default_runner_id = null`. LOGGING: INFO "catalog no longer seeded; defaults materialize on settings load". Files: `web/lib/db/seed.ts`.
- [x] **T1.3** Call the reconcile on admin settings load: in `web/app/(app)/settings/page.tsx` `loadPlatformRuntimeView()` (or just before it), after diagnostics are fetched, `await reconcilePlatformRunners({ db, diagnostics })`, then read rows. Guard admin-only (page is already admin-gated). LOGGING: DEBUG before/after reconcile. Files: `web/app/(app)/settings/page.tsx`.
- [x] **T1.4** `web/components/settings/acp-runners-panel.tsx`: render readiness as a color dot + tooltip (emerald Ready / amber NotReady / gray Unknown) via a small `statusDot()` helper; for **native `anthropic`/`openai`** providers the Ready tooltip reads **"Available (ambient credentials — key/login not verified)"** so it is not misread as credential-verified; keep the table driven off the (now honest) rows. Files: `acp-runners-panel.tsx`.
- [x] **T1.5** Tests: integration (testcontainers PG) `reconcilePlatformRunners` — upsert-if-absent, no auto-delete on adapter-unavailable, readiness recompute writes stored column, default-if-unset; unit (renderToStaticMarkup) for `statusDot()` mapping. Name runner: web integration project (`*.integration.test.ts`) + web unit (`*.test.ts`); confirm the new integration path is globbed (extend runner config if not). Acceptance: full suite green (`pnpm --filter maister-web test:unit && test:integration`).
<!-- Commit checkpoint: Phase 1 -->

### Phase 2 — Compact adapter-support cards + per-adapter setup hints
- [ ] **T2.1** New `web/lib/acp-runners/setup-hints.ts`: `adapterSetupHint(adapterId)` returning i18n key(s) for the research-derived per-adapter setup text (opencode pkg `opencode-ai`; codex `wire_api=responses`; CCR port 3456; gemini Google-only; mimo native fork). Files: `setup-hints.ts`.
- [ ] **T2.2** `web/components/settings/adapter-support-panel.tsx`: compact card — color status dot + tooltip (replace textual available/unavailable badge); move binary/providers/permission-policies into a `<details>`; drop the per-card "runners" list; show `adapterSetupHint` in the expansion when not ready; 2-col grid on wide. Files: `adapter-support-panel.tsx`.
- [ ] **T2.3** Surface the hint in the Add-runner popup: `web/components/settings/acp-runner-modal.tsx` shows `adapterSetupHint(adapter)` when the chosen adapter/preset is not available/ready. Files: `acp-runner-modal.tsx`.
- [ ] **T2.4** Tests: unit (renderToStaticMarkup) for `setup-hints` coverage (one per adapter) + adapter-card status-dot/expansion render. Acceptance: suite green.
<!-- Commit checkpoint: Phase 2 -->

### Phase 3 — Provider-presets reference (collapsed) + Use-prefill
- [ ] **T3.1** `acp-runners-panel.tsx`: replace the always-on "Provider presets" card grid with a `<details>` collapsed-by-default "Provider presets (reference)" list — each row `id` + `adapter · model · provider` + a "Use" button; no status badges. Files: `acp-runners-panel.tsx`.
- [ ] **T3.2** `acp-runner-modal.tsx`: add `initialPresetId?: string` prop, apply `applyPreset(initialPresetId)` on open (control the preset `<select>` value); panel wires "Use" → open modal in create mode prefilled. Files: `acp-runner-modal.tsx`, `acp-runners-panel.tsx`.
- [ ] **T3.3** Tests: component test — collapsed presets render + "Use" opens the modal prefilled (adapter/model/provider seeded). Acceptance: suite green.
<!-- Commit checkpoint: Phase 3 -->

### Phase 4 — Move platform agents to admin-only /agents
- [ ] **T4.1** New `web/app/(app)/agents/page.tsx`: admin-gated (mirror settings page `getSessionUser().role === "admin"` / `requireGlobalRole`), load agents + projects as `settings/page.tsx` does today, render `<AgentsPanel>`. Files: `web/app/(app)/agents/page.tsx`.
- [ ] **T4.2** Remove `<AgentsPanel>` and its now-unused agents/projects loads from `web/app/(app)/settings/page.tsx`. Files: `settings/page.tsx`.
- [ ] **T4.3** `web/components/chrome/left-rail.tsx`: remove the `agents` item from the general `sections` array (line ~241) and push it inside the `userRole === "admin"` block (lines ~246-271) with `ready: true`. Files: `left-rail.tsx`.
- [ ] **T4.4** Tests: e2e — `/agents` reachable + AgentsPanel visible as admin; hidden/403 for non-admin. Add the new spec to the playwright `AUTHED_SPEC` regex. Acceptance: e2e green (free :3000 first — Next refuses a 2nd dev server).
<!-- Commit checkpoint: Phase 4 -->

### Phase 5 — CCR start/stop + iconified sidecar cards
- [ ] **T5.1** Supervisor `supervisor/src/http-api.ts`: add `app.post<{Params:{id:string}}>("/sidecars/:id/start")` and `"/sidecars/:id/stop"` using `opts.spawnOverrides?.ccrManager` (409 PRECONDITION if absent); start = `ccr.ensureRunning({ instance })` built from the validated body `CcrInstanceConfig` (the full `{id,lifecycle,configPath,baseUrl,healthcheckUrl}` forwarded from the web DB; assert `lifecycle` enum + body.id === params.id); stop = `ccr.stop(params.id)` (per-instance method from T5.1a, NOT `shutdown()`); return `{ ok, state: ccr.getState(id) }`. LOGGING (verbose): DEBUG entry w/ id+lifecycle, INFO start/stop result + state, ERROR on spawn failure. Files: `supervisor/src/http-api.ts`.
- [ ] **T5.1a** Add a per-instance stop to `supervisor/src/ccr-manager.ts`: extend the `CcrManager` type with `stop(instanceId?: string)` and implement it in `createKeyedCcrManager` to stop ONLY `managers.get(id)` (default manager when no id) and delete it from the map; `shutdown()` (stop-all) stays for supervisor teardown. Rationale: `shutdown()` currently stops ALL instances (`ccr-manager.ts:596`), which would kill unrelated sidecars + live sessions. LOGGING (verbose): DEBUG id + resulting state. Files: `supervisor/src/ccr-manager.ts`.
- [ ] **T5.2** Supervisor tests: start/stop over a mocked `CcrManager` (ensureRunning/`stop(id)` called; 409 when no manager; state echoed; bad lifecycle → 4xx) + a `createKeyedCcrManager` test that `stop(id)` stops ONLY the targeted instance and leaves others running. Acceptance: `pnpm --filter @maister/supervisor test` green.
- [ ] **T5.3** `web/lib/supervisor-client.ts`: add `startSidecar(id, instanceConfig)` + `stopSidecar(id)` POST helpers (no auth header; `asMaisterError(res, "EXECUTOR_UNAVAILABLE")` on non-ok; `networkErrorToMaister` on fetch failure). Files: `supervisor-client.ts`.
- [ ] **T5.4** Web routes `web/app/api/admin/router-sidecars/[sidecarId]/start/route.ts` + `.../stop/route.ts`: admin gate, load sidecar from DB (404 PRECONDITION if missing), forward config to supervisor-client, return `{ ok, state }`. **No DB idempotency marker** (process state owned by supervisor). Error mapping via existing `statusForCode`. LOGGING: INFO start/stop request + outcome. Files: the two route files.
- [ ] **T5.5** `web/components/settings/router-sidecars-panel.tsx`: move card actions to the top-right corner as icon buttons with tooltips — Start/Stop (Start when not running, Stop when running), Refresh, Enable/Disable; show live process state as a color dot. Files: `router-sidecars-panel.tsx`.
- [ ] **T5.6** Integration tests: web start/stop routes against a stub supervisor (admin gate; 404 missing sidecar; EXECUTOR_UNAVAILABLE mapped; state echoed). Deployment wiring: verify `ccr` binary is on PATH for the supervisor (confirm `@musistudio/claude-code-router` in `supervisor/package.json`); document the admin start path in `docs/supervisor.md`/`docs/configuration.md`; if not in-container, document the gap (no new env/port introduced). Acceptance: integration green.
- [ ] **T5.7** Extend the e2e stub supervisor with `POST /sidecars/:id/start` + `/stop` (echo state idle→ready / ready→idle) and include the sidecar in `/diagnostics`, so the Start/Stop UI e2e can run. Files: the e2e stub supervisor (`web/e2e/_seed` or the stub server module). Blocks the sidecar-lifecycle e2e in T6.4.
<!-- Commit checkpoint: Phase 5 -->

### Phase 6 — i18n parity, e2e/seed migration, local cleanup, full gate
- [ ] **T6.1** i18n: add EN + RU keys (`settings` namespace) for start/stop, status-dot tooltips, "Provider presets (reference)" + "Use", `adapterSetupHint` text per adapter; `agents` page title. Keep `web/messages/en.json` ↔ `ru.json` key parity. LOGGING: n/a. Acceptance: `tsc` (next-intl typing) + i18n unit parity green.
- [ ] **T6.2** Migrate e2e to the new model: update `web/e2e/_seed/seed-e2e.ts` `seedPlatformRuntime` (seed claude-code + codex-openai + the NotReady custom `codex-zai-glm` + `ccr-default` sidecar **without** relying on hardcoded readiness — reconcile + stub diagnostics drive it) and the stub supervisor diagnostics so reconcile yields the asserted readiness; update `web/e2e/platform-acp-runners.spec.ts` assertions (default `claude-code` selectable; `codex-zai-glm` NotReady + disabled; `ccr-default` visible). Name each migrated assertion. Acceptance: e2e green.
- [ ] **T6.3** One-off local cleanup (NOT a migration): delete the previously auto-seeded preset runner rows from the local docker Postgres (id ∈ catalog set, not referenced by runs/projects/flows, not the active default). Document the exact SQL/command used. Verify via a settings reload that only honest, materialized rows remain.
- [ ] **T6.4** Full gate: `tsc` (web + supervisor) 0; `pnpm --filter maister-web test:unit && test:integration`; `pnpm --filter @maister/supervisor test`; i18n parity; e2e (settings without fake rows + `/agents` admin gate + sidecar start/stop via the T5.7 stub); OpenAPI lint (redocly) + `pnpm validate:docs` + `scripts/validate-docs-adr-anchors.mjs`. Then drop the superseded design doc `docs/plans/2026-06-18-runners-settings-redesign-design.md`.
<!-- Commit checkpoint: Phase 6 -->
