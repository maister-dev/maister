# Authored-capability editor session edit-lock

**Status:** Designed

## Problem

MAIster has two editing-concurrency mechanisms that diverged:

1. **Local-package editor** (`/studio/edit/[id]`) holds a session **edit-lock**:
   acquire on open (`POST lock-refresh mode=acquire`), a 60s keep-alive refresh,
   an ordered release through the client lock-op queue
   (`web/lib/local-packages/lock-op-queue.ts`), server helpers in
   `web/lib/local-packages/lock.ts` (lock columns on `local_packages`, lazy
   stale takeover, same-user takeover, holder label, per-write
   `assertHoldsLock`), and a read-only banner when the lock is not held.
2. **Authored-catalog capability editor** (`/flows/[projectSlug]/[capId]`) has
   ONLY an optimistic CAS on `authored_capabilities.draft_version`. A concurrent
   edit is discovered at save time as `CONFLICT "stale authored capability
   draft"`, which currently escapes uncaught to the root error boundary. There
   is no session lock, no keep-alive, no holder indication, and no read-only
   mode — a second editor overwrites blind until one of them loses the CAS.

**Goal:** give the authored-catalog editor the SAME session edit-lock mechanism,
keeping the `draft_version` CAS as the write-time correctness backstop. The lock
is coordination/UX; the CAS remains the correctness guarantee. The two are
layered, not substituted.

## Requirements

| Req | Requirement |
| --- | --- |
| **ACL-01** | Migration `0118` adds `locked_by_user_id` (FK `users`, `ON DELETE SET NULL`), `locked_by_session`, and `lock_expires_at` to `authored_capabilities`. All three nullable; no new indexes; the migration journal `when` stays strictly monotonic and applies cleanly in every integration container. |
| **ACL-02** | A twin lock module (`web/lib/catalog/authored-lock.ts`) reaches semantic parity with `local-packages/lock.ts`: acquire takes the lock iff free / this-session / same-user / expired (lazy stale takeover); refresh extends TTL only for a live own-session lock (else `CONFLICT`); release is session-fenced; `readLockState` computes `holderLabel = users.name ?? users.email`; TTL is `localPackageLockMinutes()` (the shared editor-lock TTL knob). |
| **ACL-03** | Two routes `POST /api/projects/{slug}/catalog/caps/{capId}/lock-refresh` and `.../lock-release` are gated by `manageCatalog` (project-scoped, not global role). Their JSON bodies mirror the `LockState` contract. A missing, foreign-project, or `ARCHIVED` capability returns `404`. |
| **ACL-04** | The lock seam runs INSIDE the existing `draft_version` CAS transaction, immediately after `loadCapability(...)`, asserting on the transaction handle: a present `sessionId` → `assertHoldsLock`; an absent `sessionId` → `assertNoForeignLiveLock(userId)` (refuse only a LIVE lock held by ANOTHER user); archive takes no `sessionId` and applies only the foreign-live refusal. All create paths (brain auto-draft, seed-from-revision, CLI import) stay lock-free. |
| **ACL-05** | The `draft_version` CAS is preserved unchanged: a lock HOLDER submitting a stale `expectedDraftVersion` still receives the stale-draft `CONFLICT`; an absent `sessionId` with a free or expired lock behaves EXACTLY as it does today (no regression for headless / no-JS callers). |
| **ACL-06** | The client acquires the lock on editor open, refreshes on a 60s keep-alive, releases through `createLockOpQueue` (reused verbatim so a release can never overtake a newer same-session acquire — the `13d9d1674` race), sends a `pagehide` beacon, renders from an optimistic RSC lock snapshot (no read-only flash), and shows a read-only banner with the holder label when the lock is not held. All copy is EN + RU. |
| **ACL-07** | The save and publish forms carry the `sessionId` as a hidden input, optional at parse (progressive enhancement — a no-JS submit degrades to the headless seam). A foreign write is refused with `CONFLICT` `details.reason = "edit_lock_not_held"`. |
| **ACL-08** | Both editors consume ONE shared `useEditorLock` hook. The studio editor's observable behavior is unchanged after the migration. |
| **ACL-09** | Every contract surface is closed: ADR-149; `capability-catalog.md` lock state machine; `flow-studio.md` save/publish sequence; `database-schema.md`; `docs/db/erd.md`; OpenAPI (the two new paths, the `sessionId` on PATCH draft, and the two pre-existing local-packages lock spec gaps); the `docs/configuration.md` shared-TTL note. |
| **ACL-10** | Test discipline: RED → GREEN (→ REFACTOR) per implementation phase; coverage boundaries with zero overlap (see below); no trivial tests; the suite is green (or explicitly quarantined) at each phase checkpoint. |

### Coverage boundaries (ACL-10)

- Lock SEMANTICS end-to-end live ONLY in `authored-lock.integration.test.ts`.
- Route handler tests mock the lock helpers (assert wiring / status codes, not
  semantics).
- Seam-matrix tests assert ONLY gating (present/absent `sessionId` × free /
  mine / foreign-live / stale-CAS) — no takeover/expiry re-runs.
- Queue reorder semantics stay ONLY in the existing `lock-op-queue.test.ts`.
- The hook controller test asserts wiring/state (issue order, refresh-fail
  degrade, teardown release, rejection non-wedging) — not queue internals.

## Acceptance criteria

1. `pnpm --filter maister-web typecheck` passes under strict TypeScript.
2. `pnpm --filter maister-web test:unit` has zero NEW reds (the 5 pre-existing
   runs/experiments reds are the accepted baseline).
3. The integration project is green for the authored-lock scenario suite, the
   seam matrix, and the untouched local-packages lock suites.
4. Root `pnpm validate:docs:all` and `pnpm validate:contracts` are green.
5. Scoped `eslint` on changed files adds no new warnings vs baseline.
6. `git --no-pager diff --check` is clean.
7. Manual two-session matrix on one authored capability: the second session sees
   a read-only banner + holder label; save/publish from the holder passes; the
   holder with a stale draft still gets the stale-draft `CONFLICT` (ACL-05); a
   foreign save is refused `edit_lock_not_held`; reload / take-over works; the
   lock survives a React StrictMode remount (ordered queue).

## Non-goals

- No change to the local-package lock protocol or `lock-op-queue` semantics
  (just fixed in `13d9d1674`).
- No weakening of the `draft_version` CAS.
- No `flow_revisions` publication / bridging changes.
- No `runs.keepalive_until` changes.
- **Surfaced hole (follow-up, out of scope):** `archiveAuthoredCapability` has
  no CAS today — an archive racing a draft-save silently wins. The foreign-live
  refusal added here narrows the race; full CAS on archive is a documented
  follow-up candidate.
- **Known gap (pre-existing, narrowed not redesigned):** the stale-draft
  `CONFLICT` from save/publish still escapes uncaught to the root error
  boundary. The lock makes the concurrent-editor path unreachable in the UI
  (buttons gate on `heldByMe`), so the crash path remains only for true races;
  graceful stale-draft UX is a follow-up candidate.

## Traceability

| Requirement | Task | Evidence |
| --- | --- | --- |
| ACL-01 | T3 | migration `0118`; journal-integrity test; applies in every integration container |
| ACL-02 | T4 | `web/lib/catalog/authored-lock.ts` + `authored-lock.integration.test.ts` scenario suite |
| ACL-03 | T5 | `lock-refresh` / `lock-release` route unit tests; `pnpm validate:contracts` |
| ACL-04 | T6 | seam gated-matrix cases (present/absent `sessionId`, archive foreign-live) |
| ACL-05 | T6 | matrix cases (e) holder-with-stale-CAS and (c) absent-sessionId-free-lock |
| ACL-06 | T7, T8 | `createEditorLockController` controller test + flows-page wiring + manual matrix |
| ACL-07 | T6, T8 | seam case (f) foreign-write refusal + hidden-input wiring; manual matrix |
| ACL-08 | T9 | existing studio tests green UNCHANGED; net-negative/equal lock-region diff |
| ACL-09 | T1, T2, T10 | `pnpm validate:docs:all` + `pnpm validate:contracts`; as-built docs flip |
| ACL-10 | T3–T9 | per-phase RED→GREEN evidence; suite-green at each checkpoint |
