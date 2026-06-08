# Plan — ACP Runner CRUD configurator in `/settings`

Branch: `feature/acp-runner-crud-config`
Base: `main`
Created: 2026-06-08
Approach: **SDD (spec-first) + multi-agent TDD (Red → Green)**

## Settings

- **Testing:** yes — TDD red→green; render tests via `renderToStaticMarkup`, route unit tests, seeded Playwright e2e.
- **Logging:** standard — server-side pino INFO on the new DELETE route; UI has no `console.*` (lint `no-console`).
- **Docs:** yes — mandatory docs checkpoint at completion (Task #9 via `/aif-docs`).

## Roadmap Linkage

Milestone: "none" — Rationale: no `.ai-factory/ROADMAP.md` artifact in repo.

## Specification

Contract: **`.ai-factory/specs/acp-runner-crud.spec.md`** (approved 2026-06-08).
Behaviors B1 (create) · B2 (list/read) · B3 (update) · B4 (delete, NEW route) ·
B5 (full-width multi-column layout). Decisions locked this session:

- Placement: **everything inside `/settings`** (no separate route/menu item).
- **No filters** in the runner table (small N).
- DELETE: hard delete, **blocked by ANY usage reference** (symmetric with
  `assertCanDisable`); `id`/`adapter` immutable on edit; secrets only as
  `env:NAME`; readiness computed server-side.

Backend reality: `POST` + `PATCH` already exist; only **`DELETE` is new**.
`loadRunnerUsageReferences` already classifies all reference kinds.

## Tasks (multi-agent waves)

Dependencies are encoded in the task list (`blockedBy`). An implement-coordinator
can fan out each wave in parallel.

**Wave 0 — unblock visibility (land first, standalone):**
- **#10** — flip `left-rail.tsx` settings `ready:false → true` so `/settings`
  becomes reachable (fixes the original "ACP config not in UI" complaint).
  One-line nav fix; independent of all other tasks.

**Wave 1 — three independent streams (after spec):**
- **#1 RED** — failing DELETE tests, **added to the EXISTING shared file**
  `acp-runners/__tests__/route.test.ts` (it already imports `../[runnerId]/route`).
  Extend `fakeDb` with `delete` + `state.deletes`; drive refs via `state` (no
  usage mock). Cases: 403 / unknown→PRECONDITION / any-ref→409 CONFLICT /
  zero-ref→success.
- **#2 GREEN** — implement the `DELETE` handler (reuse `loadRunner` +
  `loadRunnerUsageReferences`; pino INFO; returns 200 `{ok:true}`). *(blocked by #1)*
- **#11** — friendly **409 on duplicate id** in `POST` (pre-check before insert;
  today a dup PK → 500). Test in the same shared route.test.ts. *(blocked by #2 —
  serializes shared index-route + test edits)*
- **#3** — pure `lib/acp-runners/runner-form.ts` (adapter→providers/policies,
  draft validation, `buildCreate/PatchBody`) + unit tests (red→green).
- **#4** — i18n keys EN+RU under `settings` namespace **+ a focused TDD parity
  test** `lib/__tests__/i18n-acp-runner-keys.test.ts` (no global en/ru gate
  exists; `i18n-settings-keys.test.ts` guards the `run` ns, not `settings`).

**Wave 2 — UI build (sequential):**
- **#5** — `components/settings/acp-runner-modal.tsx` (create/edit/delete, one
  modal w/ mode) + render test (harness: mirror
  `admin/__tests__/scheduler-jobs-table.test.ts` — mock `next-intl` +
  `next/navigation`). *(blocked by #3, #4)*
- **#6** — refactor `acp-runners-panel.tsx` → view-only table + Add/Edit +
  modal wiring + `router.refresh()`; **also update `platform-acp-runners.spec.ts`
  selectors** (runner id `<h3>`→`<td>`) so the e2e stays green at C3.
  *(blocked by #5)*
- **#7** — `app/(app)/settings/page.tsx` full-width `md:grid-cols-2` layout +
  pass `sidecars` to panel. *(blocked by #6)*

**Wave 3 — verification & docs:**
- **#8** — **EXTEND the existing** `e2e/platform-acp-runners.spec.ts` (reuses
  `_seed/fixtures` + auth.setup) with admin create→edit→delete(blocked-as-default→
  repoint→success). *(blocked by #2, #6, #7)*
- **#9** — docs checkpoint via `/aif-docs`: amend `web/CLAUDE.md` read-only-
  settings note + ADR for DELETE semantics. *(blocked by #8)*

## Commit Plan

- **C0** after #10 → `fix(nav): make /settings reachable in left-rail (admin)`
- **C1** after #2 + #11 → `feat(api): delete platform ACP runner + dup-id guard`
- **C2** after #4 → `feat(settings): runner-form logic + i18n keys + parity test`
- **C3** after #7 → `feat(settings): runner CRUD UI + full-width layout`
- **C4** after #8 → `test(e2e): admin runner CRUD flow`
- **C5** after #9 → `docs(settings): runner CRUD + DELETE-semantics ADR`

Stage only runner/settings files — the working tree has unrelated
uncommitted changes in `web/lib/scratch-runs/*` (not ours; do not stage).

## Risks / notes

- ⚠️ The table refactor (#6) moves runner ids from `<h3>` headings to `<td>`,
  which **breaks `e2e/platform-acp-runners.spec.ts`** (`getByRole("heading",
  {name:"codex-zai-glm"})`). #6 must update those selectors so the suite is
  green at C3 — do not defer it to #8.
- Render-test convention is `renderToStaticMarkup` (no DOM events) → interactive
  coverage rests on the e2e; if the seeded harness can't drive the
  block-by-default branch, that branch stays covered by the #1 route test (log
  the gap, don't drop it).
- i18n: no global en/ru parity gate exists; the new `settings.*` keys are
  guarded by the focused test added in #4. Keep EN/RU in lock-step.
- `platform_runtime_settings.default_runner_id` NOT-NULL FK is a second,
  DB-level guard for deleting the platform default — app check returns the
  friendly message first.
- Test/route file sharing: #1, #2, #11 all touch
  `acp-runners/__tests__/route.test.ts` (and #2/#11 the index/[runnerId] routes)
  → run that chain **serially** (`#1→#2→#11`), not in parallel.
- Do not touch `enable/disable` / `assertCanDisable` semantics.
