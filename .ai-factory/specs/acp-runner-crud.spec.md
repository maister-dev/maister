# Spec — ACP Runner CRUD configurator in `/settings`

Status: approved (brainstorm 2026-06-08)
Owner surface: `web/` (Next.js settings page + admin API)
Scope axis: platform-scoped `platform_acp_runners` catalog (admin-only)

## 1. Goal

Give an admin a full Create / Read / Update / Delete surface for platform ACP
runners directly inside `/settings`, and make the settings page full-width with
a multi-column layout. Today the page exposes only: set platform default,
enable/disable, read presets. `POST`/`PATCH` already exist server-side; `DELETE`
does not.

## 2. Non-goals (out of scope)

- Filters in the runner table (explicitly dropped — small N).
- A separate route / menu item (decided: everything stays in `/settings`).
- Touching the `enable/disable` semantics or `assertCanDisable` behaviour.
- Sidecar CRUD changes (router sidecars panel stays as-is).
- Changing runner resolution, launch, or readiness evaluation logic.
- Editing `id` or `adapter` of an existing runner (identity is immutable; the
  `PATCH` schema already rejects both).

## 3. Behaviors & acceptance criteria

### B1 — Create runner (UI → existing `POST /api/admin/acp-runners`)
- GIVEN an admin on `/settings`, WHEN they click **Add runner**, THEN a modal
  opens with fields: `id`, `adapter`, `model`, `provider.kind` (+ conditional
  provider fields), `permissionPolicy`, `sidecarId` (optional), `enabled`.
- Provider/policy options are constrained by adapter:
  - `claude` → providers `anthropic | anthropic_compatible`; policies
    `default | dangerously_skip_permissions`.
  - `codex` → providers `openai | openai_compatible`; policy `default` only.
- Conditional provider fields:
  - `anthropic_compatible` → `baseUrl` (URL), `authToken` (`env:NAME`).
  - `openai_compatible` → `baseUrl` (URL), `apiKey` (`env:NAME`), `wireApi`
    (`responses`, optional).
  - `anthropic` / `openai` → no extra fields.
- Secrets are accepted ONLY as `env:NAME` references (regex
  `^env:[A-Za-z_][A-Za-z0-9_]*$`); a raw token is rejected client-side AND
  server-side. `id` must match `^[A-Za-z0-9._-]+$`.
- WHEN the form is valid and submitted, THEN it `POST`s the camelCase body the
  existing route expects; on success the modal closes and the table reflects the
  new runner (via `router.refresh()`), with readiness computed server-side.
- Optional **Start from preset**: selecting a preset prefills the form from
  `platformRunnerPresetRows()`; `id` stays editable to avoid PK collision.

### B2 — Read / list (UI table)
- The runner list renders as a **view-only table**: columns `id`, `adapter`,
  `model`, `provider`, `sidecar`, `policy`, `readiness`, `enabled`, plus a
  per-row **Edit** action. No inline mutation. Matches the data-management bar
  (`users-table.tsx`).
- Platform-default selector and provider-presets display are preserved.

### B3 — Update runner (UI → existing `PATCH /api/admin/acp-runners/{id}`)
- GIVEN a runner row, WHEN admin clicks **Edit**, THEN the modal opens in edit
  mode with `id` + `adapter` shown read-only and the other fields editable.
- Only changed fields are sent (single aggregating PATCH). Server recomputes
  readiness; UI reflects it via `router.refresh()`.

### B4 — Delete runner (NEW `DELETE /api/admin/acp-runners/{id}`)
- Hard delete (physical row removal); `enabled=false` already covers soft
  disable.
- Auth: non-admin → `403`. Unknown id → `PRECONDITION` (`409`).
- **Block on ANY usage reference** (symmetric with `assertCanDisable`): if
  `loadRunnerUsageReferences(db, id)` returns ≥1 ref, respond `409 CONFLICT`
  with a message that **enumerates the blocking reference kinds/targets**
  (platform default, project default, platform/project flow default, flow-step
  remap, active run, historical run snapshot, scratch run).
- WHEN there are zero references, THEN the row is deleted and the response is
  success; the table no longer shows it (`router.refresh()`).
- DB note: `platform_runtime_settings.default_runner_id` is a NOT-NULL FK to the
  runner (no cascade) → the platform-default case is also a DB-level guard; the
  app-level check returns the friendly enumerated message first.
- Delete is exposed in the edit modal (footer), mirroring `user-edit-modal`.
  On `409 CONFLICT` the modal shows the blocker list; it does NOT offer
  "disable instead" (disable is blocked by the same refs).

### B5 — Settings layout (full-width, multi-column)
- Remove `mx-auto max-w-[520px]`; the page becomes full-width (relies on the
  `main` px gutter), responsive (single column on mobile).
- Top: `md:grid-cols-2` — left **Host & tools** (repo home, worktrees root, host
  tools, env note), right **Adapter support**.
- Below, full-width: **ACP Runners** (default selector + table + modals), then
  **Router sidecars**.
- Modals/forms stay narrow (≤520px) — "forms stay narrow" rule.

## 4. Test matrix (TDD red→green)

| Behavior | Test kind | Location |
| --- | --- | --- |
| B4 auth 403 | route unit | `app/api/admin/acp-runners/[runnerId]/__tests__/route.test.ts` |
| B4 block-by-ref → 409 + enumerated blockers | route unit | same |
| B4 success (no refs) → row removed | route unit | same |
| B4 unknown id → PRECONDITION 409 | route unit | same |
| B1/B3 form logic: adapter→providers/policies, env:/url validation, payload build | unit | `lib/acp-runners/__tests__/runner-form.test.ts` |
| B1/B3 modal renders create & edit modes | render (renderToStaticMarkup) | `components/settings/__tests__/acp-runner-modal.test.ts` |
| B2 panel renders table headers + rows + Add button | render | `components/settings/__tests__/acp-runners-panel.test.ts` |
| B1→B3→B4 end-to-end (admin) | e2e (stub-supervisor seeded) | `e2e/…/runner-crud.spec.ts` |

Render tests use `renderToStaticMarkup` (no jsdom) per project testing
conventions; interactive flows are covered by the seeded Playwright e2e.

## 5. Invariants

- No `any` in committed code without `// FIXME(any):`. (Existing runner routes
  already use `as any` for the db handle — follow the local precedent only where
  the existing files do.)
- Secrets never leave the server as raw values; only `env:NAME` refs persist.
- UI has no `console.*` (lint `no-console`); server logs via pino at INFO.
- Every changed line traces to this spec (surgical).

## 6. Personas & user scenarios

Persona: **Platform admin** (solo-technical CEO/CIO/staff-eng) — the only role
with global `admin`; owns the host's runner catalog.

- **US1 — Discover the surface.** As an admin I open the sidebar and click
  **Settings**, landing on a full-width page where I can see and manage every
  platform ACP runner. (Before: the page was unreachable in the UI.)
- **US2 — Add a runner from scratch.** As an admin I click **Add runner**, pick
  adapter `claude`, provider `anthropic_compatible`, enter a model, a base URL,
  and a token as `env:ZAI_API_KEY`, and save. The new runner appears with a
  server-computed readiness badge.
- **US3 — Add a runner from a preset.** As an admin I click **Add runner →
  Start from preset → codex-openai**, adjust the id, and save without retyping
  the provider block.
- **US4 — Edit a runner.** As an admin I open a runner, change its model and
  sidecar, and save; `id` and `adapter` are read-only.
- **US5 — Delete a free runner.** As an admin I delete a runner that nothing
  points at; it disappears (HTTP 204).
- **US6 — Be stopped from deleting a referenced runner.** As an admin I try to
  delete the platform-default runner; the modal explains it is blocked and
  lists the references (HTTP 409). I repoint the default, then delete succeeds.
- **US7 — Be stopped from a duplicate id.** As an admin I create a runner whose
  id already exists; I get a clear "already exists" error (HTTP 409), not a
  crash.
- **US8 — Bilingual.** As a RU-locale admin every label, button, and error in
  the runner surface is translated.

## 7. Acceptance criteria (testable checklist)

| # | Criterion | Verified by |
| - | --------- | ----------- |
| AC1 | `DELETE` with zero usage refs → 204, row removed | route unit test |
| AC2 | `DELETE` with ≥1 usage ref → 409 CONFLICT, row kept, blockers enumerated | route unit test |
| AC3 | `DELETE` unknown id → 409 PRECONDITION | route unit test |
| AC4 | `DELETE`/`POST`/`PATCH` as non-admin → 403 | route unit test |
| AC5 | `POST` duplicate id → 409 CONFLICT (not 500) | route unit test |
| AC6 | Raw (non-`env:`) secret → 422 CONFIG | route unit test (existing) |
| AC7 | `runner-form` maps adapter→providers/policies, validates env:/url, builds POST/PATCH bodies | helper unit test |
| AC8 | i18n: every new `settings.*` key present in EN AND RU | i18n parity test |
| AC9 | Modal renders create AND edit modes with adapter-driven fields | render test |
| AC10 | Panel renders a view-only table + Add runner button + a row per runner | render test |
| AC11 | `/settings` is a clickable admin sidebar link | manual / e2e |
| AC12 | Settings page is full-width, 2-column on desktop | manual / e2e |
| AC13 | End-to-end admin create→edit→delete(blocked→repoint→success) | Playwright e2e |

## 8. Observability / analytics expectations

- Server logs (pino, level `standard`) MUST emit an INFO line on runner delete
  (`{ runnerId }`) and on a blocked delete (`{ runnerId, refs }`); secret values
  MUST NEVER appear in logs.
- The UI MUST surface server-computed `readiness_status` + `readiness_reasons`
  verbatim (no client recomputation).
- No client-side `console.*` (lint `no-console`); user-facing errors render in a
  `role="alert"` / `aria-live` region.
