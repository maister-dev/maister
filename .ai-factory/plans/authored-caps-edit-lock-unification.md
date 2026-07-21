# Implementation Plan: Authored-Caps Edit-Lock Unification

Branch: claude/session-5e8256 (existing session branch — no new branch; prerequisite commit `13d9d1674` "fix(studio): serialize editor lock ops to stop release/acquire race" is already on it)
Created: 2026-07-21 · Refined: 2026-07-21 (/aif-improve — SDD/TDD pass)

**Status:** Planned

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement

## Roadmap Linkage
Milestone: "none"
Rationale: Skipped by user — standalone editor-robustness/unification hardening outside M45/M46 scope.

## Problem

Two editing-concurrency mechanisms exist:

1. **Local-package editor** (`/studio/edit/[id]`): session edit-lock — acquire on
   open via `POST lock-refresh`, 60s keep-alive, ordered release through the
   client lock-op queue (`web/lib/local-packages/lock-op-queue.ts`), server
   helpers in `web/lib/local-packages/lock.ts` (lock columns on
   `local_packages`, lazy stale takeover, same-user takeover, holder label,
   per-write `assertHoldsLock`), read-only banner when not held.
2. **Authored-catalog capability editor** (`/flows/[projectSlug]/[capId]`):
   ONLY optimistic CAS on `authored_capabilities.draft_version` — a concurrent
   edit is discovered at save time as `CONFLICT "stale authored capability
   draft"` which currently escapes uncaught to the root error boundary. No
   session lock, no keep-alive, no holder indication, no read-only mode.

Goal: give the authored-catalog editor the SAME session edit-lock mechanism,
keeping `draft_version` CAS as the write-time correctness backstop
(lock = coordination/UX, CAS = correctness).

## Requirements (spec traceability — canonical home: `.ai-factory/specs/authored-caps-edit-lock-unification.md`, frozen by Task 0)

| Req | Requirement | Acceptance evidence (task → test) |
| --- | --- | --- |
| ACL-01 | Migration `0118`: `locked_by_user_id` (FK users, SET NULL) / `locked_by_session` / `lock_expires_at` on `authored_capabilities` — nullable, no new indexes; journal `when` monotonic. | T3 → journal-integrity test; migration applies in every integration container |
| ACL-02 | Lock semantics parity with `lock.ts`: acquire or-clause (free/mine/same-user/expired → take), refresh live-own-only, release session-fenced, `readLockState` holderLabel = `users.name ?? email`, TTL = `localPackageLockMinutes()`. | T4 → `authored-lock.integration.test.ts` scenario |
| ACL-03 | Routes `POST .../caps/{capId}/lock-refresh` + `/lock-release` under `manageCatalog`; `LockState` JSON parity; missing/foreign-project/ARCHIVED cap → 404. | T5 → route unit tests; `pnpm validate:contracts` |
| ACL-04 | Seam INSIDE the CAS tx right after `loadCapability`: sessionId → `assertHoldsLock`; absent → `assertNoForeignLiveLock(userId)`; archive → foreign-live refusal only; ALL creates lock-free (brain auto-draft, seed-from-revision, CLI import). | T6 → seam gated-matrix |
| ACL-05 | CAS preserved: lock HOLDER with stale `expectedDraftVersion` still gets stale-draft CONFLICT; absent sessionId + free/expired lock = exactly today's behavior. | T6 → matrix cases (e), (c) |
| ACL-06 | Client: acquire-on-open, 60s keep-alive, ordered release via `createLockOpQueue` (verbatim), pagehide beacon, optimistic RSC snapshot, read-only banner + holder label, EN + RU. | T7 controller test + T8 wiring + manual matrix |
| ACL-07 | Save/publish forms carry `sessionId` (hidden input, optional at parse — progressive enhancement); foreign write refused `edit_lock_not_held`. | T6 (f) + T8; manual matrix |
| ACL-08 | Both editors consume ONE `useEditorLock` hook; studio behavior unchanged. | T9 → existing tests green UNCHANGED, net-negative lock-region diff |
| ACL-09 | Contract surfaces complete: ADR-149, capability-catalog.md, flow-studio.md, database-schema.md, docs/db/erd.md, OpenAPI (new paths + 2 legacy local-packages lock spec-gap fixes), configuration.md TTL note. | T1/T2/T10 → `pnpm validate:docs:all` + `pnpm validate:contracts` |
| ACL-10 | Test discipline: RED→GREEN(→REFACTOR) per implementation phase; coverage boundaries, zero overlap, no trivial tests; per-phase suite-green. | every implementation task's gate |

Coverage boundaries (ACL-10): lock SEMANTICS end-to-end ONLY in
`authored-lock.integration.test.ts` (T4); route handlers mock lock helpers
(T5); seam matrix tests ONLY gating, никаких takeover/expiry re-runs (T6);
queue reorder semantics ONLY in `lock-op-queue.test.ts` (existing); hook
controller test asserts wiring/state, not queue internals (T7).

## Design decisions (resolved open questions)

| Question | Decision | Evidence |
| --- | --- | --- |
| Generalize `lock.ts` over tables vs twin module? | **Twin** `web/lib/catalog/authored-lock.ts` (~120 lines, header comment cross-links `lock.ts` + ADR-149). Drizzle strict-mode table-generic typing is the known `FIXME(any)` pain; two instances do not justify the abstraction. The CLIENT side is fully shared instead (queue + hook). | `lock.ts:20-24` FIXME(any) dual-peer-dep note |
| Authz gate for new lock routes | `authorizeCatalogRouteProject(slug)` → `requireProjectAction(project.id, "manageCatalog")` — identical to every existing caps mutation (NOT `requireGlobalRole` as in local-packages; caps are project-scoped). | `web/lib/catalog/route-auth.ts:18-39` |
| ARCHIVED / missing / foreign-project capability on lock routes | **404** `notFoundResponse` — mirrors local-packages `status !== "active"`; recorded in ADR-149. | `lock-refresh/route.ts:52-54` precedent |
| AI-assistant path needing the lock? | **None exists.** `StudioAiTab` + `/assistant` routes are local-packages-only; `FlowEditorTabs` mounts on the flows page without any AI props. Brain proposals mint NEW draft rows — creates are lock-free by design. | Explore report §3; `flow-editor-tabs.tsx:117-140` props unused on flows page |
| RSC initial lock snapshot? | Yes — flows `page.tsx` is RSC; mirror the studio page: authored `readLockState(capId, "")` + optimistic `heldByMe: !held` (ADR-105 pattern, no read-only flash). | `app/(app)/studio/edit/[id]/[[...path]]/page.tsx:152-246` |
| Lock seam location | **Service layer, inside the same transaction as the `draft_version` CAS** — immediately after `loadCapability(...)` in `updateAuthoredDraft` / `publishAuthoredCapabilityLocal` / `archiveAuthoredCapability`; asserts run ON THE TX HANDLE (no TOCTOU, unlike the route-layer precedent in local-packages `commit/route.ts:63`). | `authored-service.ts:417,574,665 → loadCapability :799-818` |
| Headless callers (PATCH route, publish-local/archive with `assertEmptyBody`, CLI import, brain auto-draft) | `sessionId` **optional** at the seam: present → `assertHoldsLock`; absent → `assertNoForeignLiveLock` (refuse only a LIVE lock of ANOTHER user). Archive never takes `sessionId`. Creates lock-free. Progressive enhancement: a no-JS form submit lacks `sessionId` → headless semantics, graceful. | `service.integration.test.ts:629` precedent |
| Client hook location | `web/components/flows/use-editor-lock.ts` — hooks live beside components (`use-new-local-package.ts` precedent), pure testable controller core + thin React binding. | `components/studio/use-new-local-package.ts` |
| TTL knob | Reuse `MAISTER_LOCAL_PACKAGE_LOCK_MINUTES` via `localPackageLockMinutes()` — one "editor lock TTL" concept, **no new env var → no deployment wiring** (documented in `docs/configuration.md`). | skill-context deployment-touchpoints rule |
| Error surface | Reuse `CONFLICT` + `details.reason = "edit_lock_not_held"` — **no new `MaisterError` code**, no error-taxonomy change. | `lib/errors.ts` taxonomy frozen |
| Keep-alive cadence | Same `LOCK_REFRESH_MS = 60_000`, same queue-ordering invariant (release must never overtake a newer same-session acquire — the `13d9d1674` race). `createLockOpQueue` reused VERBATIM. | `lock-op-queue.ts` race regression test |
| ADR / migration numbers | **ADR-149** (ADR-148 is current max) · migration **0118** (journal last idx 117). | `docs/decisions.md:12743`, `meta/_journal.json` |

## Contract surfaces (skill-context tracing)

| Surface | Spec file(s) |
| --- | --- |
| New routes `POST /api/projects/{slug}/catalog/caps/{capId}/lock-refresh` + `/lock-release` | `docs/api/web.openapi.yaml` (caps path family ~8541-8790) + `docs/system-analytics/capability-catalog.md` |
| PATCH `.../caps/{capId}/draft` body gains optional `sessionId` | `docs/api/web.openapi.yaml` (~8636) |
| Pre-existing spec gaps fixed while mirroring: local-packages `lock-refresh` missing `requestBody`; `lock-release` path missing entirely | `docs/api/web.openapi.yaml` (~9709) |
| 3 new nullable columns on `authored_capabilities` | migration `0118` + `docs/database-schema.md` + `docs/db/erd.md` |
| Lock state machine + refusal rows (written EXACTLY as gated, allow-list style) | `docs/system-analytics/capability-catalog.md` (+ `flow-studio.md` save/publish sequence) |
| Decision record | `docs/decisions.md` ADR-149 |
| Env-var doc note (shared TTL knob; no new var) | `docs/configuration.md` |
| SDD spec | `.ai-factory/specs/authored-caps-edit-lock-unification.md` |

Route identifier trust table (both new routes): `slug` = url-param (project
resolved server-side); `capId` = url-param validated against the project via
the server-state load (foreign-project capId → 404); `sessionId` =
body-controlled OPAQUE bearer token (1..200, zod `.strict()`) — never a lookup
key or path component, only compared against the server-state lock column.
Single-store, single-tx, no external side effects → two-phase-commit rule N/A.

## Non-goals & surfaced known gaps

- No change to the local-package lock protocol or `lock-op-queue` semantics
  (just fixed in `13d9d1674`); no weakening of `draft_version` CAS; no
  `flow_revisions` publication/bridging changes; no `runs.keepalive_until`
  changes.
- **Surfaced hole (follow-up, out of scope):** `archiveAuthoredCapability` has
  NO CAS today — an archive racing a draft-save silently wins. The
  foreign-live-lock refusal added here narrows the race; full CAS on archive is
  a documented follow-up candidate.
- **Known gap (pre-existing, narrowed not redesigned):** stale-draft CONFLICT
  from save/publish escapes uncaught to the root error boundary. The lock makes
  the concurrent-editor path unreachable in the UI (buttons gate on
  `heldByMe`), so the crash path remains only for true races — graceful
  stale-draft UX is a follow-up candidate.

## Commit Plan
- **Commit 1** (after tasks 0-2): `docs(catalog): design authored-caps session edit lock (ADR-149)`
- **Commit 2** (after tasks 3-4): `feat(catalog): add authored-capability lock columns and helpers`
- **Commit 3** (after tasks 5-6): `feat(catalog): lock routes and service seam for authored caps`
- **Commit 4** (after tasks 7-8): `feat(flows): session edit lock in the authored flow editor`
- **Commit 5** (after tasks 9-10): `refactor(studio): share the editor-lock hook + as-built docs`

## Tasks

### Phase 0 — SDD spec + analytics first (exit: spec frozen; docs complete & internally consistent, tagged Designed; `validate:docs:all` + `validate:contracts` green)
- [x] Task 0: Freeze the SDD specification `.ai-factory/specs/authored-caps-edit-lock-unification.md` (Problem / Requirements ACL-01..ACL-10 / Acceptance criteria / Non-goals / Traceability; project format per `feature-unified-test-database-testcontainers.md`).
- [x] Task 1: ADR-149 + `capability-catalog.md` lock state machine (transitions + refusal rows EXACTLY as gated, allow-list style; ARCHIVED→404 decision; holderLabel = name ?? email) + `flow-studio.md` sequence/Expectations (lock assert BEFORE CAS in the same tx) + `database-schema.md` + `docs/db/erd.md`; ACL cross-refs. (depends on 0)
- [x] Task 2: OpenAPI — new caps lock paths (request bodies + `AuthoredCapabilityLock`), optional `sessionId` on PATCH draft, fix the two pre-existing local-packages lock spec gaps. Gate: root `pnpm validate:docs:all` + `pnpm validate:contracts`. (depends on 0)
<!-- Commit checkpoint 1 -->

### Phase 1 — Schema + server helpers (exit: lock-scenario integration green; suite no new reds)
- [ ] Task 3: migration `0118` — 3 nullable lock columns on `authored_capabilities` (FK users SET NULL); drizzle-kit generate (NOT --custom); journal `when` monotonic; journal-integrity test green. (depends on 1)
- [ ] Task 4: `web/lib/catalog/authored-lock.ts` twin (read/acquire/refresh/release/assertHoldsLock/assertNoForeignLiveLock; tx-handle honoring; holderLabel join; shared TTL; pino debug/warn) + RED→GREEN→REFACTOR `authored-lock.integration.test.ts` (acquire/hold/same-user takeover/foreign read-only/lazy stale takeover/release + refusal matrix + tx-visibility case). ONLY end-to-end home of lock semantics (ACL-10). (depends on 3)
<!-- Commit checkpoint 2 -->

### Phase 2 — Routes + service seam (exit: route tests + seam matrix green; `validate:contracts` green)
- [ ] Task 5: `lock-refresh`/`lock-release` routes under the caps family (manageCatalog gate; missing/foreign/ARCHIVED → 404; identifier trust table honored) + RED-first route unit tests with mocked helpers (acquire-default, refresh-heartbeat, 403, 404-ARCHIVED; release, 422, 403). (depends on 2, 4)
- [ ] Task 6: service seam — optional `sessionId` through update/publish (asserts ON THE TX HANDLE inside the CAS transaction), archive foreign-live refusal; optional form field in both actions (progressive enhancement) + optional body field on PATCH draft; publish-local/archive keep empty bodies. RED matrix (a)-(f) incl. ACL-05 holder-with-stale-CAS case; backward-compat: absent sessionId + free lock = today. (depends on 2, 4)
<!-- Commit checkpoint 3 -->

### Phase 3 — Client (exit: editor acquires/renews/releases; RU+EN banner; suite green)
- [ ] Task 7: `web/components/flows/use-editor-lock.ts` — pure controller core (`createEditorLockController`) + thin hook; `createLockOpQueue` reused verbatim; RED-first controller unit test (issue-order under adversarial latencies, refresh-fail degrade, teardown release, rejection non-wedging). (depends on 1)
- [ ] Task 8: flows page wiring — RSC optimistic initial snapshot, new `authored-cap-lock-shell.tsx` (banner + holder label + effective canManage), `FlowEditorTabs` optional `lockSessionId` hidden input, EN+RU i18n keys. (depends on 5, 6, 7)
<!-- Commit checkpoint 4 -->

### Phase 4 — Unification closure (exit: full matrix green)
- [ ] Task 9: REFACTOR leg — migrate `local-package-editor.tsx` to `useEditorLock`; STRICT no-behavior-change; existing tests green UNCHANGED; lock-region diff net-negative/equal LOC; abort on any doubt. (depends on 8)
- [ ] Task 10: docs + spec as-built flip (Designed → Implemented), `configuration.md` shared-TTL note, ACL traceability closed, final verification matrix. (depends on 8, 9)
<!-- Commit checkpoint 5 -->

## Final verification matrix

| Check | Expected result |
| --- | --- |
| `pnpm --filter maister-web typecheck` | Strict TypeScript succeeds |
| `pnpm --filter maister-web test:unit` | Zero NEW reds (5 pre-existing runs/experiments reds are baseline) |
| `pnpm --filter maister-web exec vitest run --project integration` (authored-lock, seam matrix, local-packages lock suites) | Green |
| Scoped `eslint` on changed files (check-only) | No new warnings vs baseline |
| Repo root: `pnpm validate:docs:all` + `pnpm validate:contracts` | Green |
| `git --no-pager diff --check` | Clean |
| Manual: two sessions on one authored cap | Second session sees read-only banner + holder label; save/publish from holder passes; holder with stale draft still gets stale-draft CONFLICT (ACL-05); foreign save refused `edit_lock_not_held`; reload/take-over works; lock survives StrictMode remount (ordered queue) |
