# Platform user management + project member management (admin-surface carve)

**Branch:** `feature/platform-user-project-member-mgmt`
**Plan file:** `.ai-factory/plans/feature-platform-user-project-member-mgmt.md`
**Created:** 2026-06-07
**Type:** feature (admin surface on top of the already-shipped RBAC enforcement layer)

## Settings

- **Testing:** YES — vitest unit + vitest integration (testcontainers Postgres) + Playwright e2e. TDD: red → green per phase.
- **Logging:** Verbose. Server-side `pino` boundary only (one `const log = pino({ name: "...", level: process.env.LOG_LEVEL ?? "info" })` per route/lib module, mirroring existing admin routes). `no-console` stays clean. **NEVER** log: plaintext temp passwords, `password_hash`, or full email lists.
- **Docs:** Mandatory same-PR docs checkpoint (route through `/aif-docs`). Phase 0 is docs-first and is a hard gate.
- **DB engine:** No flow-engine bump. Additive migration(s) only, web-tier identity.

## Roadmap Linkage

- **Milestone:** "Platform user + project member administration — admin-surface carve" (carve pulled forward from the **RBAC + project-membership-permissions** work explicitly deferred at `ROADMAP.md:202` (M13) and `ROADMAP.md:450` (M16)).
- **Rationale:** The enforcement layer (`web/lib/authz.ts`: `requireGlobalRole` / `requireProjectRole` / `requireProjectAction`, DB-authoritative, global-admin-implicit-owner, last-active-admin + no-self guards) shipped in **M9**. This plan delivers only the **administration surface** on top of it. It introduces **no new enforcement semantics** and **no team-governance model** — full RBAC / org-team governance (the Wave-4 / E5 item) stays deferred.

---

## 1. Summary & scope

Build the management surface for:

- **(A) Platform users — full lifecycle:** admin create/provision (temp password, no SMTP), edit identity (name/email) + role/status/password (aggregating PATCH), hard-delete of *unused* accounts, lightweight who/when audit, admin list with filters + pagination. UI: extend `users-table` + `user-edit-modal`, add a create modal with a once-shown temp password.
- **(B) Project members — members only (not project-flow routing labels):** per-project roster panel (new **Members** tab), add an *existing* platform user with a role, change role, remove — race-safe (concurrent conflict → `CONFLICT`). **No last-owner guard** (see D8). EN+RU i18n.

### Locked decisions (operator + this planning round)

| # | Decision |
|---|----------|
| D1 | **Provisioning** = **admin-set** one-time temp password (primary path), with an optional auto-generate fallback when the admin leaves it blank; `must_change_password=true`. Generated length = `MAISTER_TEMP_PASSWORD_LENGTH` (default **12**, clamped ≥12); typed passwords keep `min(12)`. The effective password is shown once in the create response. **No SMTP / email invites / forgot-password self-service / email verification.** Recovery stays admin-reset (already exists). |
| D2 | **Deletion** = soft-disable (default, exists) + **hard-delete only for unused**. Hard-delete eligible **iff** `account_status='pending'` **AND** `last_login_at IS NULL` **AND** zero rows referencing the user in `runs`, `scratch_runs`, `node_attempts`, `actor_identities`, `project_tokens`, `workspaces`, `flow_graph_layouts`. `password_hash` is **ignored** (admin-created-but-unused users are deletable). `project_members` / `accounts` / `sessions` cascade. Otherwise → typed error (409) and the UI offers **Disable**. |
| D3 | **Audit** = lightweight who/when stamps on the affected rows (generalize the existing `account_status_updated_by/_at` pattern). **No** separate append-only audit-log table. |
| D4 | **Project member add** = attach an **existing** platform user (searchable by email/name). No user creation at project level. |
| D5 | **A3 list** = reconcile OpenAPI drift to reality (drop the 3 phantom single-purpose paths + the phantom collection `GET`) and **paginate the existing Server-Component query** (limit/offset + count). **No** new `GET /api/admin/users` JSON route. |
| D6 | **Members surface** = new `members` tab on the project page (`VALID_TABS`); roster visible to any project member, mutations gated to project-admin+/global-admin. |
| D7 | Mode = full plan on a dedicated **`feature/platform-user-project-member-mgmt`** branch. |
| D8 | **No last-owner / self-as-last-owner guard on project members.** `project_members.role='owner'` confers **no capability beyond `admin`** today — nothing in `PROJECT_ACTION_MIN` requires `owner` — and global admins are implicit owners of every project, so a project can never become inaccessible. Member mutations are unrestricted for project-admin+/global-admin, subject only to race-safety (`CONFLICT`) and existence (`PRECONDITION`) checks. |

### Non-goals (explicitly out)

Email/SMTP anything · forgot-password · email verification · bulk ops · `project_flow_roles` / M13 routing labels · per-user creation at project level · a separate audit-log table · new `MaisterError` code · last-owner/role-hierarchy guards (D8) · team/org governance (Wave-4 E5).

---

## 2. Cross-cutting design (read before any task)

### 2.1 Contract-surface → spec map (skill-context R: "trace every contract surface to its spec file")

Every surface below is **owned** by the named spec and MUST be updated in Phase 0 **before** code. `/aif-verify` re-derives this from the diff.

| Surface (change) | Spec file owner |
|------------------|-----------------|
| `POST /api/admin/users` (NEW) | `docs/api/web.openapi.yaml` + `docs/system-analytics/identity-access.md` |
| `PATCH /api/admin/users/{userId}` (EXTEND: +name,+email) | `docs/api/web.openapi.yaml` + `identity-access.md` |
| `DELETE /api/admin/users/{userId}` (NEW) | `docs/api/web.openapi.yaml` + `identity-access.md` |
| REMOVE phantom `GET /api/admin/users`, `PATCH .../{userId}/status`, `PATCH .../{userId}/role`, `POST .../{userId}/password-reset` | `docs/api/web.openapi.yaml` (reconcile to real aggregating PATCH) |
| `GET` / `POST /api/projects/{slug}/members` (NEW) | `docs/api/web.openapi.yaml` + new `docs/system-analytics/project-membership.md` |
| `GET /api/projects/{slug}/members/candidates` (NEW) | `docs/api/web.openapi.yaml` + `project-membership.md` |
| `PATCH` / `DELETE /api/projects/{slug}/members/{memberId}` (NEW) | `docs/api/web.openapi.yaml` + `project-membership.md` |
| New columns `users.{created_by,updated_at,updated_by}` | Drizzle migration + `docs/database-schema.md` + `docs/db/erd.md` |
| New columns `project_members.{added_by,updated_at,updated_by}` | Drizzle migration + `docs/database-schema.md` + `docs/db/erd.md` |
| New `PROJECT_ACTION_MIN` entry `manageMembers` | `identity-access.md` Expectations + `project-membership.md` |
| Error codes thrown by new routes (`CONFIG`/`PRECONDITION`/`CONFLICT`/`UNAUTHORIZED`) | `docs/error-taxonomy.md` ("where thrown" columns) — **no new code** |
| New `system-analytics/project-membership.md` | `docs/CLAUDE.md` glossary row |
| New env var `MAISTER_TEMP_PASSWORD_LENGTH` | env-vars table in `docs/configuration.md` + `web/.env.example` |
| New ADR-062 | `docs/decisions.md` |

### 2.2 Identifier trust table (skill-context R: "label every identifier; derive cross-resource ids from server state")

| Route | Identifier | Label | Handling |
|-------|-----------|-------|----------|
| `POST /api/admin/users` | acting admin id | `auth-context` | `requireGlobalRole("admin")` → stamp `created_by` |
| `PATCH`/`DELETE /api/admin/users/{userId}` | `userId` | `url-param` | trusted (route behind global-admin gate); pass to service |
| all admin user routes | `adminUserId` | `auth-context` | from session; `isSelf = userId === adminUserId` |
| all member routes | `slug` | `url-param` | resolve `project` via `getProjectBySlug(slug)` (server-state); 404/PRECONDITION if missing/archived |
| member routes | `project.id` | `server-state` | derived from slug lookup, **never** from body |
| `PATCH`/`DELETE .../members/{memberId}` | `memberId` | `url-param` | every query scoped `WHERE project_id = <server-state> AND id = memberId` — a `memberId` from another project resolves to "not found", never cross-project mutation |
| `POST .../members` | `userId` (body) | `body-controlled` (target, not a path component) | validate the user **exists**; uniqueness `(project_id,user_id)` → `CONFLICT`; it is a lookup target, never a filesystem path or cross-tenant locator |
| `POST .../members`, `PATCH .../members/{memberId}` | `role` (body) | `body-controlled` | zod allow-list `enum(["owner","admin","member","viewer"])` |

**No body-controlled field names a filesystem path or a cross-resource locator that the handler already holds in server state.** No `runId`/`projectSlug`/`stepId`-style redundant body ids.

### 2.3 Atomicity & guard ordering (skill-context R: "atomic multi-store; allow-list guards; CAS-first")

All mutations here are **DB-only** — no supervisor RPC, no `.maister/` file write, no queue publish. Therefore:

- **Two-phase-commit rule: N/A** (no downstream side-effect outside the route's own DB; bcrypt hashing is pure in-process). State this explicitly in each route task.
- **Hidden-deferred rule: N/A** (no deferreds created/observed).
- **Trust-vs-execution rule: N/A** (no fetch-then-execute of third-party content).
- **Config-state-symmetry rule: N/A** (no YAML→DB persistence).

Where a transition reads-then-writes a row whose count/role must stay invariant, run the **guard inside one `db.transaction`** and make the write a **CAS** so a concurrent loser maps to `CONFLICT`, never a raw `23505`/500:

- **User hard-delete:** `tx` → re-assert eligibility predicate under `SELECT ... FOR UPDATE` on the `users` row → count inbound content FKs → if any, throw `PRECONDITION` (no write) → else `DELETE` (cascades fire atomically in Postgres). `isSelf` → `PRECONDITION` ("cannot delete yourself").
- **Member role-change:** `tx` → load member row scoped to project `FOR UPDATE` → `UPDATE ... WHERE id=memberId AND project_id=<server-state> AND role=<observed current> RETURNING` → 0 rows → `CONFLICT` (raced/stale) → stamp `updated_by/updated_at`. **No last-owner guard** (D8).
- **Member remove:** `tx` → load member `FOR UPDATE` → `DELETE ... WHERE id=memberId AND project_id=<server-state> AND role=<observed> RETURNING` → 0 rows → `CONFLICT`. **No last-owner / self guard** (D8).
- **User create / identity edit:** email uniqueness — pre-normalize `toLowerCase()`, rely on the `users.email` UNIQUE constraint; catch the unique violation and map to `CONFLICT` (do not pre-check-then-insert in a TOCTOU window). Keep the existing in-`tx` last-active-admin count guard for role/status edits.

**Guards are allow-lists.** Role checks go through `requireProjectAction`/`requireGlobalRole` (threshold over `GLOBAL_ORDER`/`PROJECT_ORDER` — already allow-list-by-minimum). Status edit body remains `enum(["active","disabled"])` (no `pending` write-back — matches today).

### 2.4 Consumer fan-out (skill-context R: "fan a new value/route out to EVERY consumer")

No new `runs.status` / run enum. The new **route + action + tab** consumers to update **together**:

- `PROJECT_ACTION_MIN` gains `manageMembers` → `authz.ts` + its unit tests + `identity-access.md` Expectations.
- Project page `VALID_TABS` gains `members` → the tab switch in `app/(app)/projects/[slug]/page.tsx` (the existing meta-cell member **count** keeps reading `pageData.members.length`; the new panel uses the richer `listProjectMembers`).
- Every new route gets an OpenAPI path **in the same change** (Phase 0).

### 2.5 Audit columns (D3) — exact additive set

| Table | New columns (all nullable, no FK — match existing `account_status_updated_by` text style) | Stamped by |
|-------|------|-----------|
| `users` | `created_by text`, `updated_at timestamptz`, `updated_by text` | create → `created_by`; any admin edit/role/status/password/delete-precheck → `updated_at`+`updated_by`. Keep existing `account_status_updated_at/by` untouched (status edits stamp both). |
| `project_members` | `added_by text`, `updated_at timestamptz`, `updated_by text` | add → `added_by`; role change → `updated_at`+`updated_by`. |

### 2.6 Deployment touchpoints (skill-context R: "enumerate deployment touchpoints")

**One new env var:** `MAISTER_TEMP_PASSWORD_LENGTH` (default **12**, clamped ≥12; read server-side by `generateTempPassword`). Per the deployment-touchpoints rule it MUST be wired into **`.env.example`** (T1.6) and the env-vars table in **`docs/configuration.md`** (T0.8). **Compose stays Postgres-only per ADR-023** — app env vars live in `.env`, not in compose (matches the M19 convention). No sidecar, no bound port, no host-mounted file.

### 2.7 Error → HTTP mapping (reuse the per-route private `statusForCode`, verbatim copy)

`UNAUTHENTICATED`→401 · `UNAUTHORIZED`/`PASSWORD_CHANGE_REQUIRED`/`ACCOUNT_INACTIVE`→403 · `CONFIG`→422 · `PRECONDITION`/`CONFLICT`→409 · default→500. Success: create→`201 {id, tempPassword?}`; PATCH/DELETE→`200 {ok:true}`. **No new `MaisterError` code.**

---

## PHASE 0 — SDD: specs first (HARD GATE, docs-first, must be complete & internally consistent before any code)

> skill-context R: "front-load a complete, internally consistent analytics/design spec before any code phase." Phase 0 exit is a gate: code phases follow the specs as the single source of truth.

### T0.1 — ADR-062: provisioning, deletion, lightweight audit, project-member management
- **File:** `docs/decisions.md` (append using the canonical template; next number **ADR-062**, status Accepted, date 2026-06-07).
- **Content:** D1 (temp-password provisioning, no SMTP) · D2 (soft-disable default + hard-delete-unused predicate, exact eligibility) · D3 (who/when stamps, no audit-log table) · D4/D6 (project-member management = attach existing user, new Members tab, `manageMembers` action). Cite M9 enforcement; state team-governance stays deferred. Alternatives considered: SMTP invites (rejected — out of scope), separate audit-log table (rejected — D3 lightweight), separate per-field user routes (rejected — aggregating PATCH per memory + existing code).
- **Logging:** n/a (doc).
- **Acceptance:** ADR renders; numbered 062; no renumbering of prior ADRs; `pnpm validate:docs` clean.

### T0.2 — Reconcile + extend `identity-access.md`
- **File:** `docs/system-analytics/identity-access.md`.
- **Content:**
  - Reconcile the "Admin user management" sequence to the **real** aggregating `PATCH /api/admin/users/{userId}` (drop the "single-purpose mutation route" wording and the phantom `GET /api/admin/users?status=`).
  - Add process flows: **Admin create user** (temp password once → `must_change_password` → forced change on first login), **Admin edit identity** (name/email normalize+unique), **Admin hard-delete unused** (predicate → cascade vs refuse→offer disable).
  - Expectations (append, normative, ≤12 total — split if over): admin create sets `must_change_password=true` and never returns `password_hash`; temp password returned **once** in the create response only, never logged, never re-readable; email stored lowercase + unique, edit rejected with `CONFLICT` on collision; hard-delete permitted **only** for the D2 predicate, else `PRECONDITION`; every admin mutation stamps `updated_by/updated_at` (and `created_by` on create).
  - Edge cases: duplicate email (`CONFLICT`); hard-delete of a referenced user (`PRECONDITION` → disable); self-delete/self-disable/self-demote/last-active-admin (`PRECONDITION`).
  - Tag new pieces `(Designed)`.
- **Acceptance:** R5 section order intact; Mermaid valid; no contradiction with the real PATCH.

### T0.3 — NEW `system-analytics/project-membership.md`
- **Files:** `docs/system-analytics/project-membership.md` (new) + add a glossary row to `docs/CLAUDE.md` + fix the boundary sentence in `identity-access.md` ("project membership semantics live in …") and the single mention in `projects.md` to point here.
- **Content (R5 order):** Purpose (per-project roster management; boundary: routing labels in `project_flow_roles` are **out**) · Domain entities (`project_members`, project role `owner|admin|member|viewer`, global-admin implicit owner) · State machine (member added → role-changed → removed) · Process flows (list, search-candidates, add, change-role, remove) · Expectations (one row per `(project,user)`; `role='owner'` confers **no capability beyond `admin`** today and global admins are implicit owners → **no last-owner guard** (D8); `manageMembers` = project-admin+ or global admin; roster readable by any project member; concurrent stale mutation → `CONFLICT`; add stamps `added_by`, role change stamps `updated_by/at`) · Edge cases (duplicate add → `CONFLICT`; cross-project `memberId` → not found; raced delete/role → `CONFLICT`) · Linked artifacts (ERD, OpenAPI members paths, `authz.ts`, ADR-062).
- **Acceptance:** present in glossary; Mermaid valid; boundary text in the two neighbor docs no longer contradicts reality.

### T0.4 — `web.openapi.yaml` reconcile + additions
- **File:** `docs/api/web.openapi.yaml`.
- **Remove (phantom, no implementing route):** `GET /api/admin/users`, `PATCH /api/admin/users/{userId}/status`, `PATCH /api/admin/users/{userId}/role`, `POST /api/admin/users/{userId}/password-reset`.
- **Add:** `POST /api/admin/users` (body `AdminCreateUserBody`: name, email, role, status[active|pending], password? min12; response 201 `AdminCreateUserResponse`: id + tempPassword) · real `PATCH /api/admin/users/{userId}` (body `AdminUpdateUserBody`: role?/status?/password?/mustChangePassword?/**name?**/**email?**, ≥1 field) · `DELETE /api/admin/users/{userId}` (200 ok | 409 `Conflict`/precondition).
- **Add members paths:** `GET`+`POST /api/projects/{slug}/members`, `GET /api/projects/{slug}/members/candidates`, `PATCH`+`DELETE /api/projects/{slug}/members/{memberId}`.
- **Schemas:** add `ProjectMember`, `ProjectMemberRole`, `AddProjectMemberBody`, `UpdateProjectMemberRoleBody`, `MemberCandidate`; keep `AdminUser` (add `createdBy/updatedAt/updatedBy`). Reuse existing `Forbidden`/`Conflict` responses (underlying code `UNAUTHORIZED`/`CONFLICT`).
- **Acceptance:** `npx @redocly/cli lint docs/api/web.openapi.yaml` → 0 errors; every route in §2.1 present; phantom paths gone.

### T0.5 — DB ERD + narrative (additive columns)
- **Files:** `docs/database-schema.md` (USERS + PROJECT_MEMBERS narrative) + `docs/db/erd.md` (USERS + PROJECT_MEMBERS `erDiagram` blocks).
- **Content:** add `created_by`, `updated_at`, `updated_by` to USERS; `added_by`, `updated_at`, `updated_by` to PROJECT_MEMBERS; document them as nullable audit columns + which actions stamp them; note the D2 cascade/refuse chain for hard-delete (which inbound FKs `set null`/cascade/block). Tag `(Designed)`.
- **Acceptance:** `pnpm validate:docs` parses both Mermaid blocks; columns match the migration generated in T1.1 exactly (cross-checked at Phase-1 close).

### T0.6 — error-taxonomy "where thrown" update (no new code)
- **File:** `docs/error-taxonomy.md`.
- **Content:** add the new admin-user + members routes to the "where thrown" column for `CONFIG` (body/zod), `PRECONDITION` (hard-delete-referenced, add-nonexistent-user, self-delete), `CONFLICT` (dup email, dup member, raced CAS), `UNAUTHORIZED` (role gate). State explicitly: **M-admin-surface reuses existing codes; adds none.**
- **Acceptance:** no union change; surgical edit only.

### T0.8 — `configuration.md` env var
- **File:** `docs/configuration.md`.
- **Content:** add `MAISTER_TEMP_PASSWORD_LENGTH` to the env-vars table (default **12**, clamped ≥12; governs **generated** temp-password length only — typed passwords keep `min(12)`). Tag `(Designed)`. Compose unchanged (ADR-023).
- **Acceptance:** env table row present; `pnpm validate:docs` clean.

### T0.7 — Phase-0 exit gate (no new file)
- **Checklist:** T0.1–T0.6 **and T0.8** complete & mutually consistent; every §2.1 surface traced; implementation-status tags applied; `pnpm validate:docs:all` green; OpenAPI lint 0; AsyncAPI **N/A** (no events). **No code may merge before this gate passes.**

**Commit checkpoint C0:** `docs(identity): SDD specs for platform-user + project-member admin (ADR-062)`

---

## PHASE 1 — Foundation: migration + schema + password util (TDD)

### T1.1 — Additive migration + schema
- **Files:** `web/lib/db/schema.ts` (add the 6 columns from §2.5) → then `pnpm db:generate --name identity_admin_audit` → produces `web/lib/db/migrations/0029_identity_admin_audit.sql` (do **not** hand-edit).
- **Acceptance:** migration is additive (only `ADD COLUMN`, all nullable, no data backfill); `pnpm db:migrate` applies clean on a testcontainer; `$inferSelect` types expose the new columns; T0.5 ERD matches the generated SQL (reconcile if drizzle names differ).
- **Logging:** n/a.

### T1.2 — `generateTempPassword` util (red→green)
- **File:** `web/lib/password.ts` (extend; keep `hashPassword`/`verifyPassword`).
- **Deliverable:** `export function generateTempPassword(length = Number(process.env.MAISTER_TEMP_PASSWORD_LENGTH) || 12): string` — clamp to `Math.max(12, length)`; `node:crypto` `randomInt` over an unambiguous alphabet (no `O/0/l/1/I`); guarantee ≥1 of each class. (Used only as the create fallback when the admin leaves the password blank — D1.)
- **Tests:** `web/lib/__tests__/password.test.ts` — default length 12; env override respected (e.g. 20); clamp floor 12 when env < 12; charset; class coverage; 1000 calls all unique; never throws.
- **Logging:** n/a (never log the output).

### T1.3 — `users.ts` service (red→green, integration)
- **File:** `web/lib/users.ts` (extend).
- **Deliverables:**
  - `createAdminUser(input: { actorId; name; email; role; status: "active"|"pending"; password?: string }): Promise<{ id: string; tempPassword: string }>` — normalize email lowercase; password = provided or `generateTempPassword()`; `hashPassword`; insert with `mustChangePassword=true`, `created_by=actorId`; map unique-email violation → `MaisterError("CONFLICT", …)`. Returns the effective temp password **once** (caller surfaces it; service never logs it).
  - Extend `UpdateAdminUserInput` + `updateAdminUser` with `name?`, `email?` (normalize+unique→`CONFLICT`); stamp `updated_at`/`updated_by=adminUserId` on every patch; **keep** existing no-self-disable / no-self-demote / last-active-admin in-`tx` guards verbatim.
  - `hardDeleteAdminUser(input: { actorId; targetUserId }): Promise<void>` — §2.3 transaction: `FOR UPDATE` the user; `isSelf` → `PRECONDITION`; assert `account_status='pending' && last_login_at IS NULL`; count inbound content FKs (`runs`, `scratch_runs`, `node_attempts`, `actor_identities`, `project_tokens`, `workspaces`, `flow_graph_layouts`); any → `PRECONDITION` ("offer disable"); else `DELETE` (cascades `project_members`/`accounts`/`sessions`). Stamp nothing (row is gone).
  - Extend `listAdminUsers` with `{ limit?: number; offset?: number }` + a sibling `countAdminUsers(filters)` (same WHERE) for pagination; keep `q/role/status/projectId`; **never** select `password_hash`.
- **Tests:** `web/lib/__tests__/users.integration.test.ts` (matches `lib/**/*.integration.test.ts`): create→list; dup email→`CONFLICT`; edit name/email; email uniqueness on edit→`CONFLICT`; hard-delete eligible (pending+no refs) succeeds and cascades members/sessions; hard-delete blocked when a `runs` row references the user→`PRECONDITION`; self-delete→`PRECONDITION`; last-active-admin demote/disable→`PRECONDITION`; `password_hash` never in any returned shape; pagination limit/offset + count.
- **Logging:** `log.info({ targetUserId, actorId, action })` on create/edit/delete (no secrets, no email PII beyond id).

### T1.4 — Routes: create + extended PATCH + DELETE
- **Files:** `web/app/api/admin/users/route.ts` (NEW — `POST`); `web/app/api/admin/users/[userId]/route.ts` (extend `PATCH` body with `name`/`email`; add `DELETE`).
- **Pattern:** mirror admin-CRUD verbatim — private `statusForCode`/`errorResponse`/`parseJson`, `await requireGlobalRole("admin")` inside `try`, `zod safeParse` → `CONFIG` on failure. Identifiers per §2.2 (no body-controlled cross-resource ids; **no two-phase commit needed** — DB-only). `POST` body: `{ name, email, role, status, password? }`; response `201 { id, tempPassword }`. `PATCH` body adds `name? (1..120)`, `email? (.email())`. `DELETE` → 200 `{ok}` or 409.
- **Tests:** `web/app/api/admin/users/__tests__/route.integration.test.ts` (matches `app/**/*.integration.test.ts`): 201 create + tempPassword present; 422 bad body; 403 non-admin; 409 dup email; PATCH name/email 200; DELETE eligible 200; DELETE referenced 409; DELETE self 409.
- **Logging:** pino name `api-admin-users`; never log temp password or body password.

### T1.5 — Pagination wiring on the list page
- **File:** `web/app/(app)/admin/users/page.tsx`.
- **Deliverable:** read `?page` + `?perPage` (default `perPage=25`); pass `limit/offset` to `listAdminUsers`; fetch `countAdminUsers`; forward `statusUpdatedAt/By` + `createdAt` + total/page to the table. Keep `q/role/status/projectId`. Server Component; no fetch to own API.
- **Tests:** covered via e2e (T6.1) + a unit render of the page's mapping if feasible (`renderToStaticMarkup`, per project testing convention — no jsdom).
- **Logging:** n/a.

### T1.6 — Deployment wiring: `MAISTER_TEMP_PASSWORD_LENGTH` (skill-context: dedicated deployment-touchpoint task)
- **File:** `web/.env.example` (add the var with default 12 + a one-line comment that it governs generated temp-password length, min 12).
- **Deliverable:** confirm `generateTempPassword` (T1.2) reads `process.env.MAISTER_TEMP_PASSWORD_LENGTH` with default 12 + clamp ≥12. **No compose change** — app env vars live in `.env` per ADR-023 (M19 convention).
- **Acceptance:** `.env.example` lists the var; the env-override + clamp cases in T1.2 pass; `docs/configuration.md` (T0.8) row matches the `.env.example` default.
- **Logging:** n/a (never log the value).

**Phase-1 exit:** `pnpm typecheck` 0; `pnpm test:unit && pnpm test:integration` green; migration applies; T0.5 ERD reconciled to generated SQL; `.env.example` + `configuration.md` carry the new env var.
**Commit checkpoint C1:** `feat(users): admin create/edit-identity/hard-delete service + routes + pagination + temp-pw env + migration 0029`

---

## PHASE 2 — Platform-user UI + i18n (Track 1)

### T2.1 — Create-user modal (once-shown temp password)
- **File:** `web/components/admin/user-create-modal.tsx` (NEW).
- **Deliverable:** mirror the hand-rolled `role="dialog"` modal pattern (plain `useState`, focus-trap/scroll-lock effect, inline `role="alert"` error, `fetch` POST). Fields: name, email, role, status (active|pending), **password — admin types it (primary, D1)** with a "Generate" helper button + a hint that blank submit lets the server generate at the configured length. On 201, switch to a **success state** showing the effective temp password with a copy button + "shown once" warning (adapt `TokenSecretReveal` from `web/components/board/token-actions.tsx`). `onSaved` → `router.refresh()`.
- **Tests:** exercised via e2e (T6.1).

### T2.2 — Extend edit modal (name/email + delete affordance)
- **File:** `web/components/admin/user-edit-modal.tsx`.
- **Deliverable:** add name + email inputs to the aggregating patch; add a **Delete** button — enabled only when the row is hard-delete-eligible (server decides; UI may optimistically gate on `status==='pending' && !lastLoginAt`), else disabled with a tooltip → "Disable instead". Delete → `DELETE` route; on 409 show the typed message and surface a **Disable** shortcut. Keep role/status/password-reset/force-change.
- **Tests:** e2e (T6.1).

### T2.3 — Table: New-user button + pagination + new columns
- **File:** `web/components/admin/users-table.tsx`.
- **Deliverable:** "New user" button opening the create modal; pagination controls (prev/next, `router.replace` in `startTransition`, scroll:false); surface `created`/`statusUpdatedAt` columns; `router.refresh()` on any save/delete.
- **Tests:** e2e (T6.1).

### T2.4 — i18n (lockstep)
- **Files:** `web/messages/en.json` + `web/messages/ru.json` — extend `adminUsers`: `newUser`, `createTitle`, `name`, `email`, `tempPassword`, `tempPasswordOnce`, `copy`, `copied`, `generatePassword`, `delete`, `deleteBlocked`, `offerDisable`, `pagePrev`, `pageNext`, `pageOf`. **EN+RU parity is mandatory.**
- **Tests:** a key-parity assertion (existing convention if present) / e2e label checks.

**Phase-2 exit:** lint 0 new warnings; typecheck 0; unit+integration green; EN/RU key parity.
**Commit checkpoint C2:** `feat(users): create modal + once-shown temp password + delete affordance + pagination UI + i18n`

---

## PHASE 3 — Project members: authz + service + routes (Track 2)

### T3.1 — `manageMembers` action
- **File:** `web/lib/authz.ts` — add `manageMembers: "admin"` to `PROJECT_ACTION_MIN`.
- **Tests:** `web/lib/__tests__/authz.test.ts` — project `admin`/`owner` and global `admin` pass `requireProjectAction(p,'manageMembers')`; `member`/`viewer` → `UNAUTHORIZED`.

### T3.2 — `project-members.ts` service (red→green, integration)
- **File:** `web/lib/project-members.ts` (NEW; layer: imports `db`/`errors`, below route layer).
- **Deliverables:**
  - `listProjectMembers(projectId): Promise<MemberRow[]>` — join `users`; return `{ memberId, userId, name, email, role, createdAt, addedBy }` (richer than `ProjectMemberView`).
  - `searchMemberCandidates(projectId, q, limit=10)` — users NOT already members, matching email/name (case-insensitive), `{id,name,email}`.
  - `addProjectMember({ projectId, userId, role, actorId })` — validate user exists (`PRECONDITION` if not); insert with `added_by=actorId`; unique `(project_id,user_id)` violation → `CONFLICT`.
  - `changeProjectMemberRole({ projectId, memberId, role, actorId })` — §2.3 tx + CAS → `CONFLICT` on 0 rows; stamp `updated_by/at`. **No last-owner guard** (D8).
  - `removeProjectMember({ projectId, memberId, actorId })` — §2.3 tx + CAS → `CONFLICT`. **No last-owner / self guard** (D8).
- **Tests:** `web/lib/__tests__/project-members.integration.test.ts` — add; dup→`CONFLICT`; add nonexistent user→`PRECONDITION`; role change (incl. owner↔admin, and demoting an owner succeeds — D8); remove (incl. removing an owner row succeeds — D8); raced role/remove (stale expected role) → `CONFLICT`; cross-project `memberId` → not found.
- **Logging:** `log.info({ projectId, memberId, actorId, action })`.

### T3.3 — Member routes
- **Files:** `web/app/api/projects/[slug]/members/route.ts` (`GET` list + `POST` add); `web/app/api/projects/[slug]/members/candidates/route.ts` (`GET` search); `web/app/api/projects/[slug]/members/[memberId]/route.ts` (`PATCH` role + `DELETE`).
- **Pattern:** resolve `project` from `slug` (server-state; 404/`PRECONDITION` if missing/archived); `GET` list → `requireProjectRole(project.id,'viewer')`; mutations + candidates → `requireProjectAction(project.id,'manageMembers')`. All `memberId` queries scoped to `project.id` (§2.2). Mirror admin-CRUD boilerplate; **no two-phase commit** (DB-only).
- **Tests:** `web/app/api/projects/[slug]/members/__tests__/route.integration.test.ts` — list 200 (viewer) / 403 (non-member); add 201 / 409 dup / 403 non-admin; role 200 / 409 raced; delete 200; candidates excludes members.
- **Logging:** pino name `api-project-members`.

**Phase-3 exit:** typecheck 0; unit+integration green.
**Commit checkpoint C3:** `feat(members): authz manageMembers + project-members service + REST routes`

---

## PHASE 4 — Project members UI + i18n (Track 2)

### T4.1 — Members tab + panel data
- **Files:** `web/app/(app)/projects/[slug]/page.tsx` (add `members` to `VALID_TABS`; fetch `listProjectMembers`; compute `canManage = role ∈ {owner,admin} || global admin`; render `<ProjectMembersPanel>`).
- **Tests:** e2e (T6.2).

### T4.2 — Panel + modals
- **Files:** `web/components/project/project-members-panel.tsx` (NEW, client) + `member-add-modal.tsx` + `member-role-modal.tsx` (or inline role select) + remove-confirm. Roster table (name/email/role/joined/self-badge); admin-only Add/role/remove. Add modal: debounced candidate search → `fetch` candidates endpoint → pick → role → POST. Inline errors by `code` (`CONFLICT`→"already a member / changed by someone else"; `PRECONDITION`→"last owner cannot be removed"). `router.refresh()` on success.
- **Tests:** e2e (T6.2).

### T4.3 — i18n (lockstep)
- **Files:** `web/messages/en.json` + `web/messages/ru.json` — NEW namespace `projectMembers`: title/sub/add/searchPlaceholder/roleOwner|Admin|Member|Viewer/joined/you/changeRole/remove/removeConfirm/lastOwnerError/alreadyMember/save/saving/cancel/noResults/noCandidates. **EN+RU parity.**

**Phase-4 exit:** lint 0 new; typecheck 0; unit+integration green; EN/RU parity.
**Commit checkpoint C4:** `feat(members): Members tab + roster panel + add/role/remove modals + i18n`

---

## PHASE 5 — E2E, test integrity, verification (skill-context R: runnability + per-phase green)

### T5.1 — Extend `e2e/admin-users.spec.ts`
- **Flow:** admin creates user → temp password shown once (assert reveal + copy) → sign in as new user → forced `/change-password` → set password → sign back as admin → edit name/email → attempt hard-delete on a referenced user (blocked, Disable offered) → hard-delete an eligible pending user (succeeds, row gone). Seed fixtures in `e2e/_seed`.
- **Runnability:** `admin-users` already in the `AUTHED_SPEC` regex — confirm via `playwright test --list`.

### T5.2 — NEW `e2e/project-members.spec.ts`
- **Flow:** project admin opens Members tab → lists → searches + adds an existing user as member → changes their role → removes the added member. (No last-owner block — D8.)
- **Runnability (CRITICAL):** add `project-members` to the `AUTHED_SPEC` regex in `web/playwright.config.ts` (same change) so the spec actually runs with auth state. Confirm via `playwright test --list`.

### T5.3 — Runnability matrix + per-phase green (gate)
- Confirm every new test path is globbed: services → `lib/**/*.integration.test.ts`; routes → `app/**/*.integration.test.ts`; unit → `lib/**/*.test.ts`. No test lands in an unglobbed path.
- Full suite green: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. No pre-existing red silently tolerated; any unavoidable quarantine is an explicit `*.skip` with a reason (none expected).

### T5.4 — Docs checkpoint + validators (mandatory)
- Run `/aif-docs`; confirm Phase-0 specs match as-built (route shapes, columns, error sites); `pnpm validate:docs:all` green; `npx @redocly/cli lint docs/api/web.openapi.yaml` 0. Flip `(Designed)` → `(Implemented)` tags for shipped pieces.

**Commit checkpoint C5:** `test(identity): admin-users + project-members e2e; docs as-built; suites green`

---

## Commit plan (≥5 tasks → checkpoints)

| Checkpoint | After | Message |
|-----------|-------|---------|
| C0 | Phase 0 | `docs(identity): SDD specs for platform-user + project-member admin (ADR-062)` |
| C1 | Phase 1 | `feat(users): admin create/edit-identity/hard-delete service + routes + pagination + migration 0029` |
| C2 | Phase 2 | `feat(users): create modal + once-shown temp password + delete affordance + pagination UI + i18n` |
| C3 | Phase 3 | `feat(members): authz manageMembers + project-members service + REST routes` |
| C4 | Phase 4 | `feat(members): Members tab + roster panel + add/role/remove modals + i18n` |
| C5 | Phase 5 | `test(identity): admin-users + project-members e2e; docs as-built; suites green` |

## Final acceptance (maps to the prompt's acceptance bullets)

- [ ] Admin creates a user → one-time temp password (shown once, never logged) → new user forced to change on first login.
- [ ] Admin edits name/email (unique, lowercase-normalized)/role/status/password — all guarded (no self-disable/-demote, last-active-admin); `password_hash` never returned.
- [ ] Hard-delete succeeds only for the D2 predicate; else refused (`PRECONDITION`/409) + Disable offered.
- [ ] Project admin / global admin can list/add(existing)/re-role/remove members (no last-owner guard — D8); concurrent conflict → `CONFLICT`/409; roster readable by any project member.
- [ ] Every mutation stamps who/when (D3); EN+RU parity; `identity-access.md` / new `project-membership.md` / `projects.md` boundary / `web.openapi.yaml` / `database-schema.md` / `db/erd.md` / `error-taxonomy.md` / `configuration.md` / `decisions.md` (ADR-062) updated; additive migration `0029`; unit+integration+e2e green with new coverage.
- [ ] Exactly one new env var (`MAISTER_TEMP_PASSWORD_LENGTH`, in `.env.example` + `configuration.md`, compose unchanged per ADR-023); no sidecar/port; no new `MaisterError` code; no `project_flow_roles` change.

---

## Решённые вопросы (зафиксировано)

1. **Ветка** — отдельная `feature/platform-user-project-member-mgmt`; план переименован в `feature-platform-user-project-member-mgmt.md`.
2. **Temp-password** — admin задаёт пароль сам (primary, D1); auto-generate — fallback при пустом поле; показ один раз в ответе на create. Отдельный reveal-эндпоинт не нужен.
3. **`manageMembers` + поиск по всем юзерам** — ок для single-host.
4. **Длина temp-password** — env `MAISTER_TEMP_PASSWORD_LENGTH`, дефолт **12** (clamp ≥12); добавлены задачи T0.8 (configuration.md) + T1.6 (.env.example).
5. **Last-owner guard — убран** (D8): роль `owner` сегодня не даёт прав сверх `admin` (нет записи в `PROJECT_ACTION_MIN`), а глобальные админы — implicit owner везде. Управление участниками не ограничено для project-admin+/global-admin (кроме race→`CONFLICT`, existence→`PRECONDITION`).

_Открытых вопросов нет._
