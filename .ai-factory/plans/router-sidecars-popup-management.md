# Plan — Router-sidecar management: popup create + edit (+ delete)

**Branch:** `claude/trusting-kilby-378568` (existing worktree — no new branch created)
**Created:** 2026-06-20
**Type:** Enhancement / UI rework (data-management convention alignment)

## Goal

Bring `RouterSidecarsPanel` in line with the project's documented
**"view-only list + create|edit popup"** data-management convention (the
`AcpRunnersPanel` + `AcpRunnerModal` pair is the reference implementation):

1. Replace the **always-visible inline create form** with an **"Add sidecar"
   button** that opens a **modal** in `create` mode.
2. Make a configured sidecar **editable via the same modal** (`edit` mode),
   opened by an **edit (pencil) button** on each sidecar card.
3. Add a **Delete** action inside the edit modal (owner decision), backed by a
   **new `DELETE` API route** with a usage-guard mirroring the runner delete.
4. **Unify the settings-page "Add" buttons** (owner follow-up) — one shared
   `AddButton` (leading **plus icon**, single size + style) used by Add runner,
   Add webhook, and Add sidecar so they stop diverging. Today they don't:
   Add runner is large amber (`h-10`), Add webhook is small neutral (`h-8`,
   `font-mono`); Add sidecar would have been a third variant.

The configured-sidecar **card layout is kept** (owner decision) — process dot,
readiness reasons, and the live `start`/`stop`/`refresh`/`enable` lifecycle
controls stay on the card. Only the *create form* and the *edit/delete affordance*
move into the popup.

## Settings

- **Testing:** YES — pure form-helper unit tests + modal render tests + DELETE
  route tests + updated panel test. Pattern: `renderToStaticMarkup` (no jsdom),
  per `web/CLAUDE.md` testing conventions.
- **Logging:** Standard. Server route reuses the existing `pino` logger
  (info on delete + blocked-delete + best-effort-stop failure). **No client
  `console`** — the panel/modal honor the `no-console` lint rule and surface
  errors through `role="alert"` UI (mirrors `acp-runner-modal.tsx`).
- **Docs:** YES (light) — update `docs/system-analytics/acp-runners.md`
  (new DELETE route + usage-guard, sidecar modal mirrors runner modal, new
  linked artifacts). No OpenAPI change (admin routes are not in `docs/api/*`).
- **Scope guard (no deployment/config drift):** this rework introduces **no**
  new env var, sidecar binary, bound port, config-file path, DB column,
  migration, or `MaisterError` code. The CCR sidecar binary, ports, and env are
  pre-existing. ⇒ **no `Dockerfile` / `compose*.yml` / `.env.example` change**
  is required (preempts the "Plan MUST enumerate deployment touchpoints" rule —
  there are none).

## Roadmap Linkage

- **Milestone:** none.
- **Rationale:** Small UX-convention alignment on an existing admin surface;
  not tied to a roadmap milestone. (`/aif-verify --strict` should WARN-not-fail
  on missing linkage.)

## Key facts established during reconnaissance

- **`PATCH /api/admin/router-sidecars/[sidecarId]` already accepts every
  editable config field** (`lifecycle`, `commandPreset`, `configPath`,
  `baseUrl`, `healthcheckUrl`, `authTokenRef`, `enabled`) and recomputes
  readiness server-side. The edit feature therefore needs **zero PATCH change** —
  the current panel simply never used PATCH for anything but `{enabled}` / `{}`.
- The PATCH disable-guard already blocks `enabled:false` on a referenced sidecar
  (`loadSidecarUsageReferences` → `CONFLICT`). The new DELETE reuses the same
  helper.
- **No `DELETE` route exists** for sidecars today — it must be added.
- `settings/page.tsx` already passes the **full** sidecar rows
  (`sidecars={runtime.sidecars}` = `db.select().from(platformRouterSidecars)`),
  so edit-prefill has every field with **no settings-page change**.
- New test files land in already-globbed vitest unit dirs
  (`components/**/__tests__/**`, `lib/**/__tests__/**`) — runnable by contract.

## Contract surfaces that change (traced to spec)

| Surface | Change | Spec file |
| ------- | ------ | --------- |
| `DELETE /api/admin/router-sidecars/{sidecarId}` | **new route** (204 / 409 CONFLICT-referenced / 409 PRECONDITION-missing / 401 / 403 / 503-or-best-effort on supervisor) | `docs/system-analytics/acp-runners.md` (admin routes are not in OpenAPI; prose doc is canonical) |
| `MaisterError` codes | none new — reuses `CONFLICT` / `PRECONDITION` | `docs/error-taxonomy.md` — no change |
| Wire fields | none new | — |

## Tasks

### Phase 0 — Docs-first (contract surface)

**T0. [x] Document the new DELETE route + sidecar modal in `acp-runners.md`.**
- File: `docs/system-analytics/acp-runners.md`.
- Add: `DELETE /api/admin/router-sidecars/{sidecarId}` to the admin route list
  with its status-code table and the usage-guard semantics (refuse with
  `CONFLICT` when any runner references the sidecar via `sidecar_id`); note the
  **best-effort stop-before-delete** for `managed` sidecars (non-fatal if the
  supervisor is unavailable).
- Add: a line that sidecar **create/edit/delete now run through a modal**
  (`components/settings/sidecar-modal.tsx`) mirroring `AcpRunnerModal`, while the
  configured-sidecar **cards keep** their live lifecycle controls.
- Update the "Linked artifacts" file list to add `sidecar-modal.tsx`,
  `lib/acp-runners/sidecar-form.ts`, and the new DELETE route.
- Logging: n/a (docs). Verify: `pnpm --filter maister-web validate:docs:all`
  (or repo doc validator) green; ADR anchors unaffected (no new ADR).
- Acceptance: doc describes the route exactly as implemented in T1.

### Phase 1 — Backend: DELETE route

**T1. [x] Add `DELETE` to `app/api/admin/router-sidecars/[sidecarId]/route.ts`.**
- Mirror `app/api/admin/acp-runners/[runnerId]/route.ts` `DELETE`.
- **Identifiers (trust labels):** `sidecarId` = `url-param` (trusted — the route
  is admin-gated). **No request body.** No `body-controlled` cross-resource id
  (preempts the body-identifier rule).
- **Order of operations (side-effect ordering rule):**
  1. `requireGlobalRole("admin")` (auth-first, before any read).
  2. Load the row → `PRECONDITION` (`router sidecar not found`) if missing.
  3. `loadSidecarUsageReferences(db, sidecarId)` → if `refs.length > 0` throw
     `CONFLICT` with a `runner:<id>, …` summary. **This precedes the side-effect**
     (a blocked delete performs no stop, no row delete).
  4. **Best-effort stop** (only when `lifecycle === "managed"`): call
     `stopSidecar(sidecarId)` inside `try/catch`; on failure `log.warn` and
     **continue** (a down supervisor must not block removing config). Stop is
     ordered **before** the row delete so a crash-between leaves the row intact
     and the retry is a no-op re-stop, never an orphaned process.
  5. `db.delete(platformRouterSidecars).where(eq(id, sidecarId))` → `204`.
- Reuse the file's existing `statusForCode` / `errorResponse`; `loadSidecarUsageReferences`
  is **already imported** in this file (the PATCH disable-guard uses it). Add the
  `stopSidecar` import from `@/lib/supervisor-client`.
- **Why the guard is load-bearing:** the `platform_acp_runners.sidecar_id` FK is
  `onDelete: "set null"` (confirmed in schema) — without the CONFLICT guard,
  deleting a referenced sidecar would silently null a runner's binding (dropping
  it to NotReady) instead of refusing. The guard makes deletion refuse-not-mutate.
- Logging: `log.info({ sidecarId }, "router sidecar deleted")`;
  `log.info({ sidecarId, refs }, "router sidecar delete blocked")`;
  `log.warn({ sidecarId, err }, "best-effort sidecar stop before delete failed")`.
- Verify: see T2.

**T2. [x] Tests for the DELETE route — dedicated file with proper mocks.**
- **New file** `app/api/admin/router-sidecars/[sidecarId]/__tests__/delete.test.ts`.
  Do **NOT** extend `lifecycle.test.ts`: its `fakeDb` exposes only `.select()`
  (no `.delete()`), and `loadSidecarUsageReferences` calls `db.select().from(...)`
  **without `.where()`** (that fakeDb returns `{ where }` there → `.map` throws).
  Extending it would also perturb the start/stop mocks.
- Mocks: `vi.mock("@/lib/authz")` (`requireGlobalRole`);
  `vi.mock("@/lib/db/client")` with a fakeDb exposing **both**
  `select: () => ({ from: () => ({ where: async () => state.sidecars }) })`
  **and** `delete: () => ({ where: async () => undefined })`;
  **`vi.mock("@/lib/acp-runners/usage")`** stubbing `loadSidecarUsageReferences`
  (`[]` happy path / `[{ kind:"runnerSidecar", runnerId:"r1", sidecarId }]` for
  CONFLICT); `vi.mock("@/lib/supervisor-client")` (`stopSidecar`).
- Cases (each MUST execute and stay green):
  - 204 + `delete` issued when `loadSidecarUsageReferences` → `[]`.
  - 409 `CONFLICT` + **no** `delete` when it returns a ref.
  - 409 `PRECONDITION` when the sidecar id is unknown (`state.sidecars = []`).
  - 403 for a non-admin (auth-first — no delete, no stop attempted).
  - best-effort stop: `stopSidecar` **rejection** still yields 204 + delete for a
    `managed` sidecar (assert the spy was called); `external` ⇒ `stopSidecar`
    **not** called.
- Verify: `pnpm --filter maister-web test:unit` green for this file.

### Phase 2 — Pure form helper + i18n

**T3. [x] Create `web/lib/acp-runners/sidecar-form.ts` (pure, framework-free).**
- Mirror `lib/acp-runners/runner-form.ts` shape:
  - `export interface SidecarDraft { id; lifecycle: "managed"|"external";
    configPath?: string; baseUrl?: string; healthcheckUrl?: string;
    authTokenRef?: string; enabled: boolean }`.
  - Export `emptySidecarDraft()` → the create defaults (`lifecycle:"managed"`,
    `enabled:true`, empty optionals) so the modal seeds create mode from it.
  - `validateSidecarDraft(draft) → { ok, errors }`: id regex
    `^[A-Za-z0-9._-]+$`; `baseUrl`/`healthcheckUrl` valid-URL when non-empty;
    `authTokenRef` `^env:[A-Za-z_][A-Za-z0-9_]*$` when non-empty; `configPath`
    must not contain `..` (reuse the rule from
    `lib/acp-runners/sidecar-schema.ts` — keep the two in sync).
  - `buildCreateBody(draft)`: `{ id, kind:"ccr", lifecycle,
    commandPreset: lifecycle==="managed" ? "ccr_start" : null,
    configPath|null, baseUrl|null, healthcheckUrl|null, authTokenRef|null,
    enabled }` (mirrors today's create payload; server recomputes readiness).
  - `buildPatchBody(draft, original)`: **diff only** — emit a field only when it
    changed; when `lifecycle` changes also emit the derived `commandPreset`.
    Critically, **never emit `enabled:false` unless `enabled` actually changed**
    (avoids tripping the PATCH disable usage-guard during a config-only edit).
    Empty string ⇒ `null` (CLEAR half) so removing a value persists as null.
- No comments-on-what; only WHY notes where non-obvious (the `enabled` guard).
- Logging: n/a (pure). Verify: T4.

**T4. [x] Unit test `web/lib/acp-runners/__tests__/sidecar-form.test.ts`.**
- `validateSidecarDraft`: valid draft ok; bad id; bad URL; bad `env:` ref;
  `..` in `configPath`.
- `buildCreateBody`: managed ⇒ `commandPreset:"ccr_start"`; external ⇒ `null`;
  empty optionals ⇒ `null`.
- `buildPatchBody`: unchanged ⇒ `{}`; config-only edit ⇒ no `enabled` key;
  toggling `enabled` ⇒ present; clearing `baseUrl` ⇒ `baseUrl:null`; switching
  lifecycle ⇒ both `lifecycle` and `commandPreset`.
- Verify: `pnpm --filter maister-web test:unit` green.

**T5. [x] Add i18n keys (EN + RU parity).**
- Files: `web/messages/en.json`, `web/messages/ru.json` (`settings` namespace).
- New keys: `addSidecar`, `createSidecarTitle`, `editSidecarTitle`,
  `lifecycle`, `deleteSidecar`, `deleteSidecarConfirm`. Reuse existing
  `cancel`/`save`/`saving`/`saveFailed`/`editAction`/`sidecarId`/`configPath`/
  `baseUrl`/`healthcheckUrl`/`authTokenRef`/`fieldEnabled`/`validId`/`validUrl`/
  `validEnvRef`. If existing `deleteBlockedTitle`/`deleteBlockedIntro` read
  runner-specific, add sidecar variants; otherwise reuse.
- Verify: i18n parity gate green (EN key-set == RU key-set); no missing-key
  render warnings.

### Phase 3 — Modal component

**T6. [x] Create `web/components/settings/sidecar-modal.tsx`.**
- Mirror `components/settings/acp-runner-modal.tsx` structure exactly for the
  accessibility contract: fixed overlay + backdrop button, focus-trap +
  initial-focus + focus-restore refs, Escape-to-close, body scroll-lock,
  `role="dialog"` + `aria-modal` + `aria-labelledby`.
- Props: `{ mode: "create"|"edit"; sidecar?: SidecarRow; onClose; onSaved }`.
- Create seed = `emptySidecarDraft()` (T3): `lifecycle:"managed"`, `enabled:true`,
  empty optionals. Edit seed = the passed `sidecar` row.
- Fields: `id` (text on create, read-only `<code>` on edit — id is immutable,
  not in the PATCH schema); `lifecycle` (`managed`/`external` select);
  `configPath`, `baseUrl`, `healthcheckUrl`, `authTokenRef` (text); `enabled`
  (checkbox). Validation via `validateSidecarDraft` → disable Save + per-field
  error text. `commandPreset` is **derived, not surfaced** (matches current
  create form).
- Submit: create ⇒ `POST /api/admin/router-sidecars` `buildCreateBody`; edit ⇒
  `PATCH /api/admin/router-sidecars/{id}` `buildPatchBody(draft, original)`.
  On ok ⇒ `onSaved(); onClose()`. On error ⇒ `role="alert"` message.
- Delete (edit mode only): two-click confirm (`confirmingDelete`) →
  `DELETE /api/admin/router-sidecars/{id}`; 204 ⇒ `onSaved(); onClose()`;
  `CONFLICT` ⇒ set delete-blocked + show the server message (mirror runner
  modal `remove()`).
- Logging: no client console. Verify: T7.

**T7. [x] Unit test `web/components/settings/__tests__/sidecar-modal.test.ts`.**
- Mock `next-intl` (key passthrough) and `next/navigation` (`useRouter`),
  mirroring `acp-runner-modal.test.ts`.
- Render `create` ⇒ asserts editable `id` input + lifecycle select + config
  fields + create title; **no** delete button.
- Render `edit` with a seeded `sidecar` ⇒ asserts prefilled values, read-only id
  `<code>`, edit title, and the delete button present.
- Verify: `pnpm --filter maister-web test:unit` green.

### Phase 4 — Panel rewrite (keep cards)

**T8. [x] Rewrite `web/components/settings/router-sidecars-panel.tsx`.**
- **Remove** the inline create form and the `useState(items)` copy; render the
  card list **directly from the `sidecars` prop** (server truth, like
  `acp-runners-panel`).
- Add a panel-header **"Add sidecar"** button using the shared `AddButton`
  from **T11** (plus icon + `t("addSidecar")` label) → opens modal `create`.
- Add an **edit pencil** icon button (`PencilSquareIcon`, `aria-label`/`title`
  `editAction`) to each card's action cluster → opens modal `edit` with that
  sidecar. Keep the existing `start`/`stop`/`refresh`/`power` controls.
- Keep `processState` in local `useState` (seeded from `processStateById`),
  still updated by `start`/`stop` (ephemeral runtime state — unchanged
  behavior).
- Switch create/edit/enable/refresh-readiness to drive a server re-render via
  `useRouter().refresh()` inside `useTransition` (drop the local `setItems`
  patches). `start`/`stop` keep their local `processState` update.
- Render `{creating || editing ? <SidecarModal …/> : null}` (mirror runner
  panel), `onSaved = refresh`.
- Consumer fan-out check (status/enum rule generalization): this is the **only**
  read model of `platform_router_sidecars` rows in the panel; the modal writes
  through existing routes whose readiness recompute already fans to runner rows
  (`reconcilePlatformRunners*`). No additional consumer to update.
- Logging: no client console. Verify: T9.

**T9. [x] Update `web/components/settings/__tests__/router-sidecars-panel.test.ts`.**
- Add the `next/navigation` mock mirroring the runner panel:
  `useRouter: () => ({ refresh: vi.fn() })`, `usePathname: () => "/settings"`
  (the panel now calls `refresh()` inside `useTransition`).
- Keep the existing assertions that still hold: readiness reasons, `authTokenRef`
  shown, `refresh`, `bg-mute`/`bg-good`, `sidecarStart`/`sidecarStop`, no raw
  token. (These survive because the cards + lifecycle controls are kept.)
- Add assertions: an **Add sidecar** control renders; each card renders an
  **edit** control (`editAction`). The modal stays closed in static markup
  (conditionally rendered), so its fields are absent — assert that too.
- Verify: `pnpm --filter maister-web test:unit` green (full file).

### Phase 4b — Settings "Add" button consistency

**T11. [x] Create a shared `AddButton` and apply it to every settings Add button.**
- New file `web/components/settings/add-button.tsx` (client): icon + label,
  one canonical style — standardize on the **prominent amber primary** size
  (`h-10`, `px-4`, `text-[13px]`, `font-semibold`, amber bg, white text,
  `hover:bg-amber-2`, `disabled:opacity-50`) with a **leading
  `PlusIcon`** (`@heroicons/react/24/outline`, `aria-hidden`, `h-4 w-4`).
  Props: `{ label: string; onClick: () => void; disabled?: boolean }`. The
  visible `label` is the accessible name (icon is decorative). `@heroicons` is
  already the project icon source; `PlusIcon` is net-new usage (first plus icon
  in the app).
- Apply to all three settings-page Add buttons:
  - `acp-runners-panel.tsx` — replace the inline `addRunner` button (was the
    large amber `h-10` no-icon button) with `<AddButton label={t("addRunner")} …>`.
  - `webhooks/webhooks-panel-inner.tsx` — replace the **add-webhook button at
    line ~262** (`t("add")`, currently amber-but-small:
    `px-2.5 py-1.5 text-[10px] uppercase font-mono`) with
    `<AddButton label={t("add")} …>`. **Do NOT touch the global on/off toggle at
    line ~288** (`h-8 font-mono`, `t("globalOn")`/`t("globalOff")`) — that is a
    different control. **Blast-radius note:** this inner panel is shared with the
    project-scope webhooks page, so its Add button is normalized there too
    (intended consistency, not settings-only).
  - `router-sidecars-panel.tsx` — already consumes `AddButton` via T8.
- Do NOT touch non-Add buttons (Save default-runner, Use-preset, lifecycle
  controls, modal Save/Cancel/Delete) — scope is the per-panel **create** button.
- i18n: no new key — each caller passes its existing label: `t("addRunner")`
  (runners ns), `t("add")` (webhooks ns — NOT `addWebhook`), `t("addSidecar")`
  (settings ns, T5).
- Logging: none (presentational).
- Tests: **no mandatory edits** — `acp-runners-panel.test.ts` asserts only
  `toContain("addRunner")` (the label, which survives the `AddButton` swap) with
  no class assertions, and no webhook test asserts the add button. Keep those
  suites green; optionally add a plus-icon `<svg>`-presence assertion.
- Acceptance: all three settings Add buttons render identical size/style + a
  leading plus icon; `typecheck` + `test:unit` + scoped `eslint` green.

### Phase 5 — Verification

**T10. [x] Full gate + manual smoke.**
- `pnpm --filter maister-web typecheck` → 0 errors.
- `pnpm --filter maister-web test:unit` → green (incl. all new/updated files).
- `npx eslint` on the **changed files only** → 0 errors (do NOT run repo-wide
  `pnpm lint` — it is `eslint --fix` with no path and reformats the whole repo;
  see project memory).
- i18n parity gate → EN == RU key sets.
- Manual smoke (if a dev server is run): `/settings` as admin → "Add sidecar"
  opens modal, create persists + card appears; edit pencil opens prefilled
  modal, save persists; delete blocked with `CONFLICT` when a runner references
  it, succeeds otherwise; start/stop/refresh still work on the card.
- Button-consistency check: Add runner / Add webhook / Add sidecar render at
  the **same size + style** with a leading plus icon.

## Commit Plan (11 tasks → checkpoints)

1. **`docs(acp-runners): document sidecar delete route + modal`** — T0.
2. **`feat(api): DELETE router-sidecar with usage-guard + best-effort stop`** —
   T1, T2.
3. **`feat(settings): sidecar form helper + modal + i18n`** — T3, T4, T5, T6, T7.
4. **`refactor(settings): router-sidecars panel → add/edit popup`** — T8, T9.
5. **`style(settings): unify Add buttons (shared AddButton + plus icon)`** — T11.
6. **`chore: verify (typecheck, unit, eslint, i18n parity)`** — T10 (fold into
   the prior commit if no fixes are needed).

Conventional-commit messages; no AI trailer (project preference).

## Risks / watch-items

- **`router.refresh()` vs local `processState`:** `refresh()` re-renders the
  server component but does **not** remount the client panel, so local
  `processState` (start/stop) survives — verified against the runner-panel
  precedent. Render cards from the `sidecars` **prop** (not a `useState` copy)
  so the refresh is actually reflected.
- **Best-effort stop on DELETE:** must be non-fatal — a `503` from a down
  supervisor must not block removing the config row. Ordered before the row
  delete to avoid orphaning a managed CCR process.
- **`buildPatchBody` `enabled` guard:** a config-only edit must not send
  `enabled:false`, or the PATCH disable usage-guard fires spuriously.
- **EN/RU parity gate** is enforced — every new key must land in both catalogs.

## Unresolved questions

None blocking. (Owner already chose: full plan / keep cards / add delete / write
tests.) Minor default taken without asking: a `managed` sidecar is **best-effort
stopped** before delete rather than refusing delete-while-running — flag if you
prefer a hard "stop it first" precondition instead.
