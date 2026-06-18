# Runner-Readiness Rail — Hover Popover + Admin Settings Link — Implementation Plan

**Branch:** `claude/unruffled-panini-ed541f` (stay on it — NO new branch; this is a **handoff artifact**) · **Created:** 2026-06-17 · **Consumer:** separate coding session (task chip `task_9e7823c5`)

Make the left-rail "Runners readiness" block a richer info surface + jump-off point:

- Each adapter chip in the **EXPANDED** rail gets a hover/focus popover listing that coding agent's configured platform runners (`agent · model · provider kind · enabled · readiness`), with the amber reason and an empty **"no runners configured"** state. Secret values are never rendered.
- **Admin** click on a chip → navigate to plain `/settings`. **Non-admin** chip is not a link.
- Hidden (binary-unavailable) adapters stay hidden (unchanged).

This is a **READ-ONLY presentational change over data already loaded server-side**. No new HTTP route, no DB schema/migration, no state machine, no wire/SSE surface, no env/config/sidecar/port. Per the project `aif-plan` rules, the deployment-wiring, contract-surface, two-phase-commit, multi-store-atomicity, status/enum fan-out, fetch-then-execute, and Phase-0-analytics gates are **N/A** and are marked so inline below.

## Settings

- **Testing:** yes — vitest **unit** project (`pnpm exec vitest run --project unit <file>`); component tests via `renderToStaticMarkup` per `web/CLAUDE.md`. e2e only if warranted (not required for this slice).
- **Logging:** none/minimal — pure UI; no new server logging.
- **Docs:** yes — update `docs/screens/chrome/left-rail.md`; one-line note in `docs/system-analytics/acp-runners.md`.

## Roadmap Linkage

- **Milestone:** "none". **Rationale:** standalone UI/UX enhancement on an already-shipped surface (web-shell rail, M-web-shell-nav-unlock); not tied to a roadmap milestone. (`/aif-verify --strict` should WARN, not fail, for missing linkage alone.)

## Conventions

Follow `web/CLAUDE.md`: HeroUI v3 + Tailwind 4 + `tailwind-variants` only (no new libs); `@/` alias; Server Components by default, `"use client"` only when required; kebab-case files; **EN+RU i18n REQUIRED**; strict TS (no `any`); admin areas are role-gated in nav but the **route** stays the authz boundary; never ship secrets to the client. Surgical changes. Scoped lint (`eslint <paths>`, never repo-wide `--fix`) + scoped vitest only.

## Decisions (locked with user)

1. **Data via server props — no new API route.** Extend the existing `loadRunnerReadinessRows` + `summarizeAdapterReadiness` to attach a per-adapter list of **safe** runner DTOs; thread through `layout.tsx` → `LeftRail`. This avoids any new HTTP route (so the project's route-identifier / two-phase-commit / status-fan-out rules do not apply).
2. **Secret redaction (security boundary).** The web tier maps each runner to a SAFE DTO `{ id, capabilityAgent, model, providerKind, enabled, readinessStatus, firstReason }`. Only `provider.kind` crosses to the client — never `provider.authToken / apiKey / baseUrl / projectId` (even though those are `env:NAME` refs, they are not surfaced). Mapping happens server-side in `readiness-summary.ts`, BEFORE the prop reaches the client tree.
   - **Visibility (resolved 2026-06-18):** non-admin members may see runner identity in the popover (no secrets). To keep the footprint minimal, `enabled` and `readiness` render as **icons / color indicators (each with an `aria-label`)**, not spelled-out text; only `capabilityAgent · model · providerKind` are textual (+ `firstReason` as small text when not `Ready`). No ADR — documented in the screens doc.
   - **Accepted deviation (2026-06-18, /aif-fix — supersedes the row-identity wording in this bullet, Task 2, Task 4 case (1), and Resolved-Q #2):** the shipped popover drops the per-row `capabilityAgent` text and instead shows the adapter once in the popover **header**; each runner row is `model · providerKind` only. Rationale: `capability_agent == adapter` for all five ready families, so per-row it duplicates the header, and `model` is the distinguishing identity. `capabilityAgent` stays a field on `RailRunnerDTO` server-side — it is simply not rendered. Clipping (Resolved-Q #1): shipped uses `z-[140]` + anchors the popover to the `relative` chips container (not a wrapping `overflow-visible`); the fixed `w-[220px]` panel fits inside the `w-[260px]` rail's ~232px content box and opens upward, so it is not clipped by the rail's `overflow-x-hidden`.
3. **Popover = CSS hover/focus** (`group-hover` + `group-focus-within`), server-rendered, so the block stays a Server-Component sub-view and is `renderToStaticMarkup`-testable. The existing `AutoCloseDetails` (`web/components/chrome/auto-close-details.tsx`) is **click-based** and is **NOT** reused for the expanded chips — it stays for the collapsed flyout only. Keep the chip's `title`/aria as an always-available fallback (progressive enhancement + a11y). **a11y (resolved 2026-06-18):** non-admin chips are NOT made focusable (kept simple, per user) — they rely on hover + the `title`/aria fallback; admin chips are `<Link>`s, so keyboard focus reveals the popover via `group-focus-within` for free.
4. **Admin click-through:** `userRole === "admin"` → wrap chip in `<Link href="/settings">` (plain, **no** adapter scoping/filter). Non-admin → non-interactive chip. The link is convenience, not the authz boundary — `/settings` enforces admin access itself.
   - **Accepted deviation (2026-06-18, /aif-fix — Codex Finding 1):** the earlier wording "admin-gated by `requireGlobalRole('admin')`" was inaccurate. `web/app/(app)/settings/page.tsx` **soft-gates**: `getSessionUser()` → `role === "admin"` conditional render, a localized "forbidden" panel for non-admins, and NO admin data fetched for them (`hostToolStatus` / `loadPlatformRuntimeView` / `checkSupervisorDiagnostics` are all `isAdmin`-guarded) — so it is secure, just not a hard 403. The sibling admin pages (`/mcps`, `/admin/users`, `/admin/scheduler`) DO hard-gate via `requireGlobalRole("admin")`; `/settings` is the deliberate exception. Owner chose (2026-06-18) to correct the docs to match reality + add a non-admin `/settings` page-contract test, rather than harden the route (which would swap the friendly forbidden panel for an error boundary and touch a file outside this branch's scope).
5. Keep `visibleAdapters = runnersReadiness.filter(i => i.state !== "hidden")` **UNCHANGED** — do not surface binary-unavailable adapters.
6. Only the **EXPANDED** rail block (`left-rail.tsx` ~523-552) is enriched; the collapsed flyout (~368-404) is left as-is per spec.

### Identifiers / routes (per aif-plan trust-boundary rule)

No HTTP route is added or changed. The only navigation is a static client-side `<Link href="/settings">`; `/settings` authorization is unchanged — it soft-gates page-side (`getSessionUser()` + admin check + forbidden panel, no admin data loaded for non-admins; see the Decision #4 deviation note), not via `requireGlobalRole`. N/A: body-controlled identifiers, two-phase commit, migrations, ADR.

## Consumers of the changed data contract (full set — grepped)

`summarizeAdapterReadiness` / `AdapterReadinessSummary` / `loadRunnerReadinessRows` consumers:

- `web/app/(app)/layout.tsx` — composes + passes `runnersReadiness` to `LeftRail`; update to feed the extended rows.
- `web/components/chrome/left-rail.tsx` — renders; consume the new `runners` field.
- `web/lib/acp-runners/readiness-summary.ts` — definition; extend.
- **Test:** `web/lib/acp-runners/__tests__/readiness-summary.test.ts` — MIGRATE assertions for the new `runners` field.

(No other consumers — small blast radius. `readiness.test.ts` covers `evaluateRunnerReadiness`, untouched here.)

## Dependencies / order

```
T1 data+safe DTO (+migrate summary test) ─► T2 sync view + hover popover ─► T3 admin link + i18n EN/RU ─► T4 component tests ─► T5 docs
```

---

## Phase 1 — Data path (safe DTO)

### Task 1 ✅: Extend readiness rows + summary with per-adapter safe runner DTOs

- **Deliverable:** each `AdapterReadinessSummary` carries `runners: RailRunnerDTO[]` (the adapter's configured runners, safe fields only); empty array when none.
- **Files:**
  - `web/lib/acp-runners/runner-readiness-rows.ts` — extend the `.select({...})` to also pull `id`, `capabilityAgent`, `model`, `provider` from `platformAcpRunners`. Widen `RunnerReadinessRow` (defined in `readiness-summary.ts:25`) accordingly.
  - `web/lib/acp-runners/readiness-summary.ts` — add `export type RailRunnerDTO = { id: string; capabilityAgent: AdapterId; model: string; providerKind: ProviderKind; enabled: boolean; readinessStatus: "Unknown"|"Ready"|"NotReady"; firstReason: string | null }`. In `summarizeAdapterReadiness`, for each adapter map its `own` runners → `RailRunnerDTO` (`providerKind = runner.provider.kind`; `firstReason` = first non-empty entry of `readinessReasons`); attach as `summary.runners`; add `runners` to `AdapterReadinessSummary`. **CRITICAL:** map ONLY the safe fields — never spread `provider` (drop `authToken/apiKey/baseUrl/projectId`).
  - `web/app/(app)/layout.tsx` — no call-site change beyond the widened return type flowing through; confirm the extended rows feed `summarizeAdapterReadiness` unchanged.
- **Tests (MIGRATE + ADD):** `web/lib/acp-runners/__tests__/readiness-summary.test.ts` — update existing cases for the new `runners` field; ADD cases asserting: (a) per-adapter grouping (a `gemini` runner appears under gemini's `runners`, not another adapter's); (b) **redaction** — a runner whose `provider` has `authToken: "env:X"` yields a DTO with NO `authToken`/`provider` key, only `providerKind`; (c) `firstReason` picks the first non-empty reason; (d) adapters with no runner → `runners: []`.
- **Logging:** none.
- **Exit:** `tsc --noEmit` clean; `pnpm exec vitest run --project unit web/lib/acp-runners/__tests__/readiness-summary.test.ts` GREEN; scoped eslint clean.

## Phase 2 — Rail UI

### Task 2 ✅: Extract a sync, testable runners-readiness view + hover/focus popover

- **Deliverable:** the EXPANDED-rail block extracted into a SYNC presentational component renderable via `renderToStaticMarkup` (mirrors the existing `LeftRailNavView` split — async `LeftRail` resolves data + translations, passes plain props to the sync view).
- **Files:**
  - `web/components/chrome/runners-readiness-rail.tsx` (new) — a **Server Component** (NO `"use client"`), mirroring the existing `web/components/chrome/left-rail-nav.tsx` split (its `LeftRailNavView` is the precedent: async `LeftRail` resolves data + i18n, passes plain props to a sync view tested via `renderToStaticMarkup` with `href`s). Signature `RunnersReadinessRailView({ adapters: AdapterReadinessSummary[] /* visible, with runners */, causeLabels: Record<AdapterReadinessCause, string>, popoverLabels: {...resolved strings}, isAdmin: boolean })`. The cause-label resolution currently inline in `left-rail.tsx` (`tPortfolio(runnerCauseLabelKey[adapter.cause])`) moves up into the async `LeftRail` and is passed down as the resolved `causeLabels` map — the sync view does no translation. Each chip = dot + name (unchanged) + a sibling popover panel (`group-hover:` / `group-focus-within:` reveal, `absolute`, `z-[130]`, token styling `border-line bg-paper shadow-[var(--shadow-lg)]` like the collapsed flyout). Popover body: per-runner row = `capabilityAgent · model · providerKind` (text identity) + an **enabled** icon and a **readiness** color dot, EACH carrying an `aria-label` (a11y + testability) rather than spelled-out text (Heroicons + the existing `bg-accent-4`/`bg-amber`/`bg-mute` tokens) + that runner's `firstReason` (small text) when not `Ready`. Do NOT also repeat the adapter-level `summary.detail` in the body (avoid duplication — `summary.detail` may serve only as the chip `title` fallback). Empty "no runners configured" state when `runners: []`. Wrapping container gets `overflow-visible` so the popover is not clipped.
  - `web/components/chrome/left-rail.tsx` — replace the inline block (~523-552) with `<RunnersReadinessRailView ... />`, passing resolved `tPortfolio(...)` strings + `visibleAdapters` + `isAdmin`. Keep the chip `title`/aria fallback.
- **Tests:** deferred to Task 4 (kept together for one green checkpoint).
- **Logging:** none.
- **Exit:** `tsc` clean; scoped eslint clean; existing `web/components/chrome/__tests__/left-rail-nav.test.ts` still GREEN.

### Task 3 ✅: Admin-only `/settings` link + i18n EN/RU

- **Deliverable:** admin chips link to `/settings`; non-admin chips do not. All new popover strings localized EN+RU.
- **Files:**
  - `web/components/chrome/runners-readiness-rail.tsx` — when `isAdmin`, wrap each chip in Next `<Link href="/settings">`; else a non-interactive wrapper. `isAdmin = userRole === "admin"` passed from `LeftRail`.
  - `web/messages/en.json` + `web/messages/ru.json` — add `portfolio.*` keys: `runnersConfiguredHeading`, `runnerNoneConfigured`, `runnerEnabledShort` / `runnerDisabledShort`, `runnerConfigureCta` ("Configure in Settings" / "Настроить в настройках"), plus any field labels. Reuse existing `runnerReady | runnerNotReady | runnerNoRunner | runnerAllDisabled | runnerDiagnosticsUnavailable`.
- **Tests:** Task 4.
- **Logging:** none.
- **Exit:** tsc clean; scoped eslint; **i18n EN/RU key parity** for all new keys — gate: `web/lib/__tests__/i18n-parity.test.ts` GREEN. If a `portfolio` key-presence list test exists alongside `i18n-tokens-keys.test.ts` / `i18n-settings-keys.test.ts`, extend it with the new keys (assertion migration is in-scope, not a follow-up).

## Phase 3 — Tests (per-phase green)

### Task 4 ✅: Component tests for the popover (`renderToStaticMarkup`)

- **Deliverable:** unit tests on `RunnersReadinessRailView` (sync) covering content, roles, redaction, empty state.
- **Files:** `web/components/chrome/__tests__/runners-readiness-rail.test.ts` (new). It lands in the already-globbed `__tests__/*.test.ts` family → runnable by the **unit** project. **Runnability check (mandatory):** `pnpm exec vitest list --project unit | grep runners-readiness` must show the file before relying on it.
  - Cases: (1) a green adapter with 2 runners renders both rows (text `capabilityAgent`/`model`/`providerKind`), each with an enabled indicator + a readiness indicator carrying an `aria-label`; (2) an amber adapter shows its `firstReason` text; (3) an adapter with `runners: []` shows the "no runners configured" empty state; (4) `isAdmin=true` → output contains `href="/settings"` wrapping the chip; `isAdmin=false` → NO `/settings` link; (5) **redaction** — rendered HTML contains `providerKind` but NEVER the substrings `env:`, `authToken`, or `apiKey`; (6) an `all_disabled` adapter (runners present, all `enabled:false`) renders its runners with the **disabled** indicator (assert via `aria-label`) — NOT the empty state.
- **Logging:** none.
- **Exit:** the new test file GREEN; **full unit suite GREEN** (`pnpm exec vitest run --project unit`) — no pre-existing red introduced; tsc clean; scoped eslint. Any pre-existing red surfaced must be quarantined with a reason + tracked follow-up, never silently tolerated.

## Phase 4 — Docs

### Task 5 ✅: Update screen doc + acp-runners note

- **Files:**
  - `docs/screens/chrome/left-rail.md` — document the runners-readiness chip popover (what it lists, hover/focus trigger, admin click → `/settings`, hidden adapters omitted, secrets redacted, non-admin = info-only).
  - `docs/system-analytics/acp-runners.md` — one-line note: the rail surfaces per-adapter configured-runner identity read-only (kind only) + admin jump-off to the platform catalog.
- **Gate:** `pnpm validate:docs` clean for changed docs (validates Mermaid only; no ADR anchors added → no anchor check needed).
- **Exit:** docs gate green.

## Commit Plan

5 tasks → checkpoints:

- **CP-A** (T1): `feat(acp-runners): per-adapter safe runner DTOs on readiness summary`
- **CP-B** (T2–T3): `feat(rail): runners-readiness hover popover + admin settings link + i18n`
- **CP-C** (T4): `test(rail): runners-readiness popover unit coverage`
- **CP-D** (T5): `docs(screens): runners-readiness rail popover + acp-runners note`

## Verification

- **Per task:** scoped unit GREEN + `tsc --noEmit` clean + scoped eslint clean on touched files.
- **Phase 3 gate:** full `pnpm exec vitest run --project unit` GREEN (no pre-existing red introduced by this branch).
- **Manual (chromeDevtools, optional):** expanded rail → hover gemini/opencode chip shows runner list + reason; admin sees a working `/settings` link, non-admin does not; popover not clipped by the rail; mimo (hidden) absent.
- **i18n:** EN/RU key parity for all new keys.

## Out of scope

- Adapter-scoped `/settings` (plain navigation only — confirmed with user).
- Surfacing hidden / binary-unavailable adapters (deliberately omitted).
- Enriching the collapsed-rail flyout (left as-is).
- Any change to runner CRUD, the settings panel, supervisor diagnostics, or the readiness verdict logic.

## Resolved questions (2026-06-18, user)

1. **Overflow:** lock `overflow-visible` + high `z-index`; client-component fallback ONLY if it actually clips.
2. **Non-admin visibility:** OK to show runner identity (no secrets). Minimize the footprint — `enabled` + `readiness` as `aria-label`led icons/color, identity (`capabilityAgent · model · providerKind`) as text. **No ADR** — screens-doc only.
3. **a11y:** non-admin chip is NOT focusable (kept simple); hover + `title`/aria fallback; admin `<Link>` gets keyboard reveal via `group-focus-within`.
