# Plan — Post-issuance mutation of API tokens

- **Branch:** `claude/lucid-poincare-8c951d` (worktree; no new feature branch created)
- **Created:** 2026-09-11 · **Refined:** 2026-09-11 (2nd iteration — SDD/TDD pass)
- **Trigger:** a project token for `aidev-mipt-course` was issued without
  `hitl:respond:human`, `flows:read`, `runners:read`. The only remedy available
  through the product was a direct `UPDATE project_tokens.scopes` in Postgres.
- **Method:** **SDD** — Phase 0 produces the complete, internally consistent
  contract set (analytics, OpenAPI, ERD, ADR); **the spec is normative and the
  code conforms to it**, never the reverse. Then **TDD** per code task:
  RED (failing test naming the invariant) → GREEN (minimum implementation) →
  REFACTOR (SOLID/KISS/DRY, no behavior change, suite stays green).

## Settings

- **Testing:** YES — TDD, enforced per task. Runner projects
  (`web/vitest.workspace.ts:47-99`): `unit` globs `lib/**/__tests__/**/*.test.ts`
  and `app/**/__tests__/**/*.test.ts`; `integration` globs
  `lib/**/*.integration.test.ts` and `app/**/*.integration.test.ts`.
  **Every file this plan adds already falls under an existing glob — no
  runner-config change required.** Integration suites use
  `startMainPostgresTestDb` from `@/test-support/pg-container` (real Postgres via
  testcontainers), the harness `lib/tokens/__tests__/tokens.integration.test.ts`
  already uses. Coverage is governed by the matrix in D13 — one invariant, one
  owning test, no trivial tests.
- **Logging:** VERBOSE. Existing `pino` boundaries (root rule: `no-console`).
  INFO on every applied mutation (token id, actor, changed field NAMES); WARN on
  every refusal with its reason; DEBUG on the computed diff. Never the secret,
  never the hash, never a scope value outside what the lifecycle table already
  persists.
- **Docs:** YES (mandatory). Phase 0 is a hard gate — no code task starts until
  its exit criteria are met. Final truth pass in Phase 6.
- **SOLID / KISS / DRY:** reuse existing seams — `revoke.ts`'s scoping-predicate
  and CAS shape, `normalizeTokenScopes`, `handleExt`'s in-transaction audit
  discipline, `ScopeField`/`Field` in `token-actions.tsx`, `SCOPE_OPTIONS` in
  `personal-tokens-panel.tsx`, `readApiError` + the `apiErrors` namespace.
  **One** new predicate (`isManagedToken`, D3) owns both editability and
  lifecycle-trail membership — the same rule must not be spelled twice.

## Roadmap Linkage

- **Milestone:** none. Closes a gap in the M16/ADR-046 token model, not a
  roadmap milestone. `/aif-verify --strict` should WARN, not fail.

## Reserved numbers (from `master` HEAD, 2026-09-11)

Verified via `git show master:docs/decisions.md` (max `### ADR-167`) and
`git show master:web/lib/db/migrations/meta/_journal.json` (max `idx: 162`,
tag `0162_event_skip_ledger`, 159 entries).

- **ADR-168** — Post-issuance mutation of API tokens.
- **Migration 0163** — `token_lifecycle_events`.
- **Renumber pass = T6.1** (mandatory). `pnpm validate:docs` runs Mermaid +
  ADR-anchor + link + index validators and `db:erd --check` — the anchor
  validator is real evidence for the ADR header, but **nothing** in that gate
  checks the migration journal. Verify `_journal.json` max by hand, the TRIPLE
  (SQL + journal entry + `meta/0163_snapshot.json`), and the fourth leg:
  `drizzle-kit generate` reporting "No schema changes".

---

## Decisions

### D1. The finding: immutability was never a decision

Recorded because ADR-168 must state it, and because it is the premise the plan
rests on.

1. **ADR-046** (`docs/decisions/adr-046.md`) states the threat model as: a
   compromised token "must grant only the addressed project's API, must be
   revocable, and must leave an audit trail". Mutation appears nowhere — not in
   the decision, not in the consequences, not in the four rejected alternatives.
2. The lifecycle state machine at `external-operations.md:262` documents
   `active → revoked | expired | owner_blocked`. It **describes what was built**;
   nothing forbids mutation.
3. This repository records real invariants compulsively and adjacently — "Do not
   introduce `fs.watch`", "The 403 body MUST NOT leak which scopes the token
   holds" (`ext-handler.ts:498`, three lines from the code in question). There is
   no such note for token rows. In *this* codebase the absence is evidence.
4. The row is already mutated in production: `bumpTokenLastUsed` issues an
   `UPDATE` on every authenticated call (`lib/tokens/audit.ts:47`).
5. Even `name` — a pure label — is frozen. No trust model requires freezing a
   label. That is an unwritten route, not a decision.

**Conclusion: uncovered scenario. Build the missing write path.**

### D2. Mutability matrix

| Column | Mutable | Rationale |
| --- | --- | --- |
| `scopes` | **yes**, audited | the originating gap. Widen and narrow. |
| `expires_at` | **yes**, audited | extend, shorten, clear, or revive an expired token (D2a). |
| `name` | **yes**, audited, guarded | see D4 — not a cosmetic edit. |
| `revoked_at` | **no** — terminal | un-revoking re-arms a repudiated secret. |
| `token_hash`, `prefix` | **no** — out of scope | rotation is a distinct feature (old-secret fate, overlap window). Deferred; see Non-goals. |
| `project_id`, `token_kind`, `owner_user_id`, `agent_id` | **no** — identity | moving a token between projects or owners silently rewrites the meaning of its existing `token_audit_log` history. |

**D2a. Reviving an expired token is allowed.** Expiry is a policy timer, not a
repudiation; the secret was never disavowed. GitHub and GitLab both permit
extending a PAT. The lifecycle row records the past `before` value, so a revival
is legible. `revoked_at` IS a repudiation and stays terminal.

### D3. The managed-token predicate — ONE rule, two consumers

> **Refinement finding (2nd iteration).** The first draft refused only
> `token_kind='agent'`. That is **wrong**: `issueOrchestratorRunToken`
> (`lib/agents/tokens.ts:166`) inserts `token_kind: "project"` with the name
> `orchestrator-run:<runId>`. A live orchestrator credential would have passed a
> kind-only check and had its scopes or expiry mutated. It is also visible in the
> project token table today, because `listTokens` filters by `project_id` only.

```
isManagedToken(row) =
  row.token_kind !== 'agent'
  && !/^(orchestrator-run|agent-run):/i.test(row.name)
```

A **managed** token is a durable, human-issued credential. A **non-managed**
token is machine-minted, run-bound, and revoked by its own lifecycle.

This single predicate governs **both**:

1. **Editability** — a PATCH against a non-managed token is `PRECONDITION`,
   refused before any write.
2. **Lifecycle-trail membership** — `token_lifecycle_events` holds rows for
   managed tokens only.

Note the deliberate distinction the first draft conflated: refusing to **set** a
reserved name (D4) and refusing to **edit a row that already carries one** (here)
are two different rules. Both are required.

### D4. `name` is load-bearing — the reserved-prefix guard

`verify.ts:160` derives `boundRunId: parseBoundRunId(row.name)` via
`^(orchestrator-run|agent-run):(.+)$`. That `boundRunId` is the **authorization
subject** on `/api/v1/ext/runs/{promote,delegate,collect,cancel,rework,message,plan}`;
`lib/runs/bound-run.ts:35` instructs every one of them to take the binding from
`ctx.actor.boundRunId` and "never body fields". `actorLabel` (`token:<name>`)
also lands in `token_audit_log.actor_label`, so a rename rewrites future audit
attribution.

**No live escalation exists today** — verified end to end, and the plan must not
overstate it:
- Run-bound ext routes call `handleExt` with **no** `slug` and **no**
  `resolveProjectId`, so a global personal token (`project_id IS NULL`) never
  passes `if (targetProjectId === null && !allowGlobalActorWithoutProject)` → 403.
- Naming a *project-bound* token requires `editSettings` (admin), and
  `promoteRun`'s minimum is `member` — admin ≥ member, so no new authority.

The balance rests on **one guard plus a role coincidence**. The forging surface
exists and is merely inert: `POST /api/account/tokens` accepts any `name` matching
`z.string().trim().min(1).max(120)`. It goes live the day someone adds
`allowGlobalActorWithoutProject` or a `resolveProjectId` to a run-bound route.

**Decision:** refuse `^(orchestrator-run|agent-run):` (case-insensitive) with
`CONFIG` on the two new PATCH routes **and on both existing POST routes**.
Closing it on edit while leaving issuance open is incoherent — a deliberate,
stated widening beyond "add PATCH".

**Route layer only — NOT a DB CHECK.** The machine path legitimately writes
exactly those names (`issueOrchestratorRunToken`, `issueAgentRunToken`); a
table-level CHECK would break agent launches. Asserted both ways in the matrix
(I11 refuses, I12 still mints).

### D5. Partial-update semantics — absent vs `null` vs value

> **Refinement finding.** The first draft said "all four fields optional,
> `minProperties: 1`" and left three holes: whether `expiresAt: null` clears or
> is rejected, whether an existing `hitl:respond:human` survives a `scopes` patch
> that omits `humanHitl`, and what an all-whitespace name does.

| Field | Absent | `null` | Value |
| --- | --- | --- | --- |
| `name` | unchanged | **422** `CONFIG` (not nullable) | trimmed; 1..120 after trim; reserved prefix → 422 |
| `scopes` | unchanged | **422** `CONFIG` | ≥1 element, each in `TOKEN_SCOPE_VALUES`, then `normalizeTokenScopes` |
| `humanHitl` (account route only) | unchanged — **recomputed from the stored row**, so an existing human scope survives | **422** `CONFIG` | `true` adds, `false` removes `hitl:respond:human` |
| `expiresAt` | unchanged | **clears** expiry (token never expires) | new expiry instant |

A body with no field present at all → **422** `CONFIG` (nothing to do is a
client error, not a silent 200).

**Account-route effective-scope rule** (mirrors `scopesForBody` in
`app/api/account/tokens/route.ts:70`): the client's `scopes` never contains
`hitl:respond:human` (POST refuses it; PATCH mirrors). So:

```
base    = patch.scopes ?? (stored.scopes minus 'hitl:respond:human')
human   = patch.humanHitl ?? stored.scopes.includes('hitl:respond:human')
final   = normalizeTokenScopes(human ? [...base, HUMAN] : base)
```

### D6. `normalizeTokenScopes([])` returns `["*"]` — guard at the service layer

> **Refinement finding.** `scopes.ts:13` — `if (!scopes || scopes.length === 0)
> return [TOKEN_SCOPE_ALL]`. On the create path an empty input is a benign
> "default to full". On the **update** path it is a silent grant of full access
> to a token the caller was editing. Today only the route's zod `.min(1)` stands
> between the two.

The update service **must not** rely on the route's validator. It refuses an
empty resolved scope set with `CONFIG` before calling `normalizeTokenScopes`.
`normalizeTokenScopes` itself is left unchanged — its create-path contract is
relied on by `issueToken` and is not this plan's to alter (surgical changes).
Owned by test I10.

### D7. HTTP routes — identifier trust labels

Per the project rule on body-controlled cross-resource identifiers.

**`PATCH /api/projects/[slug]/tokens/[tokenId]`**

| Identifier | Label | Note |
| --- | --- | --- |
| `slug` | `url-param` | resolved to a project row, then `requireProjectAction(project.id, "editSettings")` — same gate as the sibling POST/DELETE. |
| `tokenId` | `url-param` | never trusted alone: the service WHERE re-asserts `project_id = <resolved>`, so a cross-project id is `not-found`, never a mutation. Mirrors `revokeToken` (`revoke.ts:56-64`). |
| `actorUserId` | `auth-context` | from `requireActiveSession()`. **Never** a body field. |
| `name`, `scopes`, `humanHitl`, `expiresAt` | `body-controlled` | none is a cross-resource locator. `scopes` allow-listed by `z.enum(TOKEN_SCOPE_VALUES)`; `name` by D4. |

**`PATCH /api/account/tokens/[tokenId]`**

| Identifier | Label | Note |
| --- | --- | --- |
| `tokenId` | `url-param` | WHERE re-asserts `owner_user_id = session.user.id AND token_kind='user' AND project_id IS NULL`. Another user's token, and any project-bound token, is `not-found`. Mirrors `revokeOwnerToken` (`revoke.ts:76-90`). |
| `ownerUserId` | `auth-context` | from the session. **Never** a body field. |
| body fields | `body-controlled` | as above. |

**No `body-controlled` field names a project, run, workspace, or path component
on either route.** Project and owner are server-state throughout.

### D8. Atomicity, concurrency, crash windows

One `db.transaction` per PATCH: the `UPDATE project_tokens` and **all** implied
`token_lifecycle_events` INSERTs commit together. A rollback discards both — the
discipline `handleExt`'s `successAuditInWork` uses.

- **No external side-effect** on this path (no supervisor call, no filesystem
  write, no queue publish). The two-phase-commit rule does not apply; stated
  rather than silently skipped.
- **No cache to invalidate.** `verifyToken` re-reads `project_tokens` by prefix on
  every authenticated call (`verify.ts:80-86`); nothing caches scopes in web,
  supervisor, or the MCP facade. A committed edit is in force on the next
  request. Re-confirmed by grep in T6.3.
- **Crash windows:** the only persistent writes sit inside the one transaction —
  reachable states are "committed" and "not committed". No partial state, so no
  recovery sweep to specify.
- **Revoke race:** the UPDATE carries `isNull(revoked_at)` (CAS). A zero-row
  result is `PRECONDITION`, never a silent success.
- **Concurrent edits (refinement finding):** two admins editing the same token is
  **last-write-wins on field values**, deliberately — no `If-Match`, no version
  column. The collision window is two humans editing one token within seconds,
  and both edits produce lifecycle rows, so the sequence is reconstructible after
  the fact. Optimistic concurrency here would be machinery without a demonstrated
  need (KISS). Recorded in ADR-168 as an accepted residual.

### D9. Authorization — derived from data class, not route neighbourhood

The data class is **a live credential's authority**. The gate is the one that
already governs minting that authority:

| Surface | Gate | Why |
| --- | --- | --- |
| project tokens | `requireProjectAction(projectId, "editSettings")` (admin) | identical to POST/DELETE on the same collection. A principal who could mint this exact scope set a minute ago may add a scope now — no authority appears that did not already exist. |
| personal tokens | active session + `owner_user_id` match | identical to POST/DELETE on `/api/account/tokens`. The token can only act on projects its owner can currently access (`ext-handler` re-checks `requireProjectActionForUser` per call), so widening never exceeds the owner's live project role. |

**POSITIVE grant tests are mandatory** (I15, I16) — a deny-only suite cannot
distinguish "correctly refused" from "route broken". Adversarial review of every
fix cycle is T6.4.

### D10. The 403 disclosure boundary

`ext-handler.ts:498` carries a hard invariant: the body must not leak **which
scopes the token holds**. The *required* scope is a different fact — published in
`operations.openapi.yaml`, printed in the route source, identical for every
caller. Disclosing it reveals nothing about any token.

`{ code: "UNAUTHORIZED", message: "insufficient scope: this endpoint requires
'flows:read'", details: { requiredScope: scopeLabel } }`.

The adjacent comment is amended in place to draw the line explicitly, so the next
reader cannot mistake the loosening for an erosion. Owned by test I18.

### D11. Lifecycle-event writers — the full fan-out

> **Refinement finding.** The first draft named two writers of `revoked_at`.
> There are **seven**: `revoke.ts` ×2, and five in `lib/agents/tokens.ts`
> (the supersede inside `issueOrchestratorRunToken`, `revokeAgentRunToken`,
> `revokeAgentRunTokensForRun`, `revokeOrchestratorRunTokensForRun`,
> `revokeAgentProjectTokens`). Left unaddressed, the trail would carry `issued`
> rows with no matching `revoked` — tokens that look perpetually live.

Resolved by D3, not by fanning out to seven sites: **all five machine sites
operate exclusively on non-managed tokens**, which the trail does not cover.

| Consumer class | Touched |
| --- | --- |
| Writers | exactly three modules — `lib/tokens/update.ts` (`scopes_changed`, `renamed`, `expiry_changed`), `lib/tokens/issue.ts` (`issued`), `lib/tokens/revoke.ts` (`revoked`). All go through one helper, `recordTokenLifecycleEvent`, which **itself refuses non-managed tokens** — the rule cannot be forgotten at a call site. |
| Machine revokes (5 sites) | **not** touched. Their WHERE clauses constrain to `orchestrator-run:` / `agent-run:` names or `token_kind='agent'` — except `revokeAgentRunToken`, which matches by id alone. T2.5 adds `eq(token_kind,'agent')` there: a one-line defence-in-depth predicate that makes the invariant this design relies on actually true. |
| Read models | none — no UI reads the table (see Non-goals). |
| Scheduler / sweeps / caps | none — append-only evidence, in no predicate. |
| Cascade chain | `project_tokens` → CASCADE; `projects` → `project_id` SET NULL. Mirrors `token_audit_log` exactly, so project/token deletion behaves identically for both evidence tables. |
| API spec | internal; no route returns it in this plan. |

`event` is an allow-list union in `schema.ts` (`text(..., { enum: [...] })`) —
an unlisted value is rejected by default.

### D12. Migration data preservation

`0163` is **purely additive**: one `CREATE TABLE` plus two indexes. No DROP, no
re-key, no NOT-NULL-default on an existing table. The backfill-or-loud-guard rule
has no live state to protect.

**Stated honestly in the ADR and the docs:** history is **not** reconstructed.
Tokens issued before `0163` have no `issued` row and no synthetic one is
invented — a fabricated provenance row is worse than an absent one. The trail
starts at the migration.

### D13. Test coverage matrix — one invariant, one owning test

> **Refinement finding.** The first draft declared TDD in Settings and had one
> RED task. The user's contract is explicit: all functionality and edge cases,
> **minimum overlap, no trivial tests**, RED → GREEN → refactor per task.

Rules binding every test task:

- **One invariant → exactly one owning test.** A second test asserting the same
  invariant at a different layer is overlap and must be deleted, not kept "for
  safety".
- **Route tests assert the HTTP contract only** — status code, body shape, and
  the authorization gate. They never re-assert service semantics already owned at
  the service layer.
- **No trivial tests.** Nothing asserts that a module exports a function, that
  zod rejects a number where a string is declared, or that a constant equals
  itself.
- **RED means RED for the stated reason.** Each task confirms the new test fails
  with the *expected* assertion message before implementing — not merely that it
  fails.

| # | Invariant | Owning test | Project |
| --- | --- | --- | --- |
| I1 | widening persists and writes exactly one `scopes_changed` row with correct `before`/`after` | `lib/tokens/__tests__/update.integration.test.ts` | integration |
| I2 | narrowing persists and writes exactly one row | same file | integration |
| I3 | a no-op patch writes nothing and reports `unchanged` | same file | integration |
| I4 | a multi-field patch writes one row per changed field, all in one commit | same file | integration |
| I5 | a failure inside the transaction discards BOTH the update and its lifecycle rows | same file | integration |
| I6 | `token_kind='agent'` is refused `PRECONDITION` | same file | integration |
| I7 | `token_kind='project'` named `orchestrator-run:<id>` is refused `PRECONDITION` (D3) | same file | integration |
| I8 | a revoked token is refused `PRECONDITION` | same file | integration |
| I9 | an already-expired token accepts an expiry extension and becomes verifiable again | same file | integration |
| I10 | an empty resolved scope set is refused at the SERVICE layer, independent of route zod (D6) | `lib/tokens/__tests__/update.test.ts` | unit |
| I11 | a reserved-prefix name is refused on PATCH and on both POST routes | `lib/tokens/__tests__/update.integration.test.ts` + route suites | integration |
| I12 | `issueOrchestratorRunToken` / `issueAgentRunToken` still mint their reserved names (D4) | `lib/tokens/__tests__/update.integration.test.ts` | integration |
| I13 | a cross-project `tokenId` is `not-found`, never a mutation | same file | integration |
| I14 | another user's personal token is `not-found` via the account path | same file | integration |
| I15 | **positive:** an admin widens a project token and the scope is present afterwards | `app/api/projects/[slug]/tokens/__tests__/route.integration.test.ts` | integration |
| I16 | **positive:** an owner widens their own personal token | `app/api/account/tokens/__tests__/route.integration.test.ts` | integration |
| I17 | a non-admin project member is refused 403 on the project PATCH | project route suite | integration |
| I18 | the 403 body carries `requiredScope` and contains none of the actor's held scopes (D10) | `lib/tokens/__tests__/ext-handler.test.ts` | unit |
| I19 | `humanHitl` absent preserves an existing `hitl:respond:human` across a `scopes` patch (D5) | `lib/tokens/__tests__/update.integration.test.ts` | integration |
| I20 | `expiresAt: null` clears expiry; `expiresAt` absent preserves it (D5) | same file | integration |
| I21 | a non-managed token NEVER appears in `token_lifecycle_events`, on any path (D11) | same file | integration |
| I22 | an empty body (no field present) is refused 422 (D5) | route suites | integration |
| I23 | a rename racing a narrowing preserves the committed scopes (read `FOR UPDATE` inside the writing tx) | `lib/tokens/__tests__/update.integration.test.ts` | integration |
| I24 | a revoke through the DELETE route attributes the acting user, not `system` | `app/api/projects/[slug]/tokens/__tests__/route.integration.test.ts` | integration |

> **I23/I24 added 2026-09-13** after adversarial review. Both are defects the
> original matrix could not have caught: I23 because D8 was read as licensing
> the stale-snapshot restore, and I24 because the service test supplied the
> actor the production route omitted.

### D14. Deliberate carry-overs (flagged, not silent)

- **The `humanHitl` asymmetry is preserved, not unified.** `POST /api/account/tokens`
  refuses `hitl:respond:human` inside `scopes` and requires the separate boolean
  (`route.ts:29`); the project picker offers it as an ordinary checkbox. Each
  PATCH mirrors **its own surface's** POST. Unifying them is a separate decision
  about an existing contract; doing it as a side-effect here would violate
  surgical changes. Open question 1.
- **`issued` and `revoked` rows are in scope** though the request was about scope
  changes: ~6 lines at two existing call sites, same table, same transaction
  discipline, and without them the trail cannot answer "what did this token look
  like when created". Open question 2.
- **Ephemeral tokens are listed in the project token table today** (`listTokens`
  filters by `project_id` only, so `orchestrator-run:*` rows render with a Revoke
  button). Pre-existing; **not fixed here** — the Edit affordance is simply
  withheld from them via D3. Flagged, not silently inherited. Open question 5.

### Non-goals (stated, not silently dropped)

- **Secret rotation** — owner-decided, deferred to its own task.
- **Un-revoking** — see D2.
- **A lifecycle-audit UI.** Rows are written and queryable; no panel reads them
  back. Flagged so the omission is visible and reversible. Open question 3.
- **Bulk edit across tokens.**
- **Hiding ephemeral tokens from the token table** — see D14.

### D15. Deployment touchpoints — none

Checked explicitly rather than skipped: no env var, no config file path, no
sidecar binary, no bound port, no host-mounted file. `Dockerfile`, `compose*.yml`
and `.env.example` are untouched. The only deployment-visible artifact is
migration `0163`, which runs through the existing
`pnpm --filter maister-web db:migrate` lineage.

---

## Tasks

### Phase 0 — SDD: specs are normative (no code)

**Exit gate (all must hold before any Phase-1 task starts):** every artifact
below complete, mutually consistent, tagged per `docs/CLAUDE.md` R6, and
`pnpm validate:docs` green. Phases 1-5 implement these documents; where code and
spec disagree during implementation, **the spec wins or the spec is amended in
the same commit** — never a silent divergence.

**T0.1 — New domain doc `docs/system-analytics/token-lifecycle.md`.**

> **Refinement finding.** `external-operations.md` → `## Expectations` already
> holds **18 bullets** against the `docs/CLAUDE.md` §R5a cap of ≤12 ("If a domain
> needs more, the boundary is wrong — split the file"). It is over the cap before
> this change. And §R5 mandates seven sections — the first draft assigned only
> the state machine, leaving Expectations and Edge cases unowned.

Create the file with the full §R5 structure, owning the **token lifecycle**
domain (issue → edit → revoke/expire, the event ledger, who may do what);
`external-operations.md` keeps the `/api/v1/ext` surface (routes, scopes,
per-call audit, MCP facade).

Acceptance:
- [x] All seven §R5 sections present, in order: Purpose · Domain entities ·
      State machine · Process flows · Expectations · Edge cases · Linked artifacts.
- [x] State machine is a `stateDiagram-v2` with `active → active` (three
      triggers: `scopes_changed`, `renamed`, `expiry_changed`) alongside the
      existing `revoked` / `expired` / `owner_blocked` transitions.
- [x] **Expectations ≤ 12 bullets**, each normative (MUST/NEVER), each testable,
      each referencing identifiers verbatim (`project_tokens.scopes`,
      `MaisterError("PRECONDITION")`, `isManagedToken`), each naming **what
      enforces it** — a CHECK, the CAS, the one-transaction rule, or a matrix
      test id from D13.
- [x] Edge cases enumerate every refusal in D3/D4/D5/D6 with its `MaisterError`
      code, in the `- **Name** → code` style the sibling doc uses.
- [x] Registered in `docs/system-analytics/README.md` (gate-enforced index).
- [x] `external-operations.md` gains a pointer line to the new doc and **loses no
      existing bullet** — this is a split of new material, not a migration of old.

**T0.2 — ADR-168 record.**
`docs/decisions/adr-168.md` + the `### ADR-168` header and index row in
`docs/decisions.md`. ADR-046 is **not** edited (Accepted decision text is
immutable) — the pointer lives in the analytics doc.

Acceptance:
- [x] Records the D1 finding with all five pieces of evidence.
- [x] Records the D2 matrix and why each frozen column is frozen.
- [x] Records D3 including the orchestrator-token discovery (`token_kind='project'`).
- [x] Records the D4 coupling, the statement that no live escalation exists today,
      and the exact two guards that make that true.
- [x] Records D8's accepted residual (last-write-wins, no optimistic concurrency)
      and D12's "no synthetic history".
- [x] Records the D10 disclosure boundary.
- [x] Status `Accepted`; anchor resolves under `scripts/validate-docs-adr-anchors.mjs`.

**T0.3 — `docs/api/web.openapi.yaml`: two PATCH paths.**

Acceptance:
- [x] Both paths documented beside their existing siblings (~9314, ~9456).
- [x] Request schema encodes **D5 exactly**: every field optional; `name`,
      `scopes`, `humanHitl` non-nullable; `expiresAt` nullable with `null`
      documented as "clear expiry"; empty object rejected.
- [x] `200` returns the token DTO, **never** the secret.
- [x] Every status code present with its trigger: `401`, `403`, `404`,
      `409` (`PRECONDITION` — non-managed, revoked, CAS no-row),
      `422` (`CONFIG` — unknown scope, reserved name, empty body, empty scopes).
- [x] Example payloads for: widen, `expiresAt: null`, reserved-name refusal.

**T0.4 — `docs/api/external/operations.openapi.yaml`: 403 shape.**

Acceptance:
- [x] `ExtErrorBody` gains optional `details` (object, `requiredScope: string`).
- [x] `HitlForbidden` prose distinguishes "never reveals which scopes the token
      HOLDS" from "names the scope the ROUTE requires".

**T0.5 — DB docs: both ERD artifacts.**

Acceptance:
- [x] `docs/database-schema.md` gains a `token_lifecycle_events` section beside
      `## project_tokens` (~2806), columns and indexes named exactly as T1.1 will
      create them.
- [x] `docs/db/integrations-domain.md` gains the `erDiagram` entity **and** the
      cascade-chain block (~55) — one artifact updated is not both updated.

### Phase 1 — Schema

**T1.1 — `schema.ts` → generated migration 0163.**

> **Refinement finding.** The first draft had the SQL authored by hand. `0162` is
> drizzle-kit output; the generator owns the SQL, the journal, and the snapshot.

Order: add the `pgTable` to `web/lib/db/schema.ts` (snake_case JS keys, matching
the `projectTokens`/`tokenAuditLog` convention in the same file; export both
inferred types) → `pnpm --filter maister-web db:generate` → review the emitted
SQL.

Columns: `id` text PK · `token_id` text NOT NULL FK → `project_tokens(id)` ON
DELETE CASCADE · `project_id` text NULL FK → `projects(id)` ON DELETE SET NULL ·
`event` text NOT NULL (allow-list enum: `issued | scopes_changed | renamed |
expiry_changed | revoked`) · `actor_user_id` text NULL FK → `users(id)` ON DELETE
SET NULL · `actor_label` text NOT NULL · `before` jsonb NULL · `after` jsonb NULL
· `created_at` timestamptz NOT NULL default now().
Indexes: `(token_id, created_at)`, `(project_id, created_at)`.

Acceptance:
- [x] Migration TRIPLE complete: `0163_*.sql` + `_journal.json` entry +
      `meta/0163_snapshot.json`. `_journal.json` is **generated, never hand-edited**.
- [x] Re-running `db:generate` reports **"No schema changes"** (the fourth leg).
- [x] `pnpm --filter maister-web db:migrate` applies cleanly on a fresh database.
- [x] Column and index names match T0.5 verbatim.

### Phase 2 — Core service (TDD)

Each task runs RED → GREEN → REFACTOR. RED must fail for the **stated** reason.

**T2.1 — RED: the service test set.**
Write `lib/tokens/__tests__/update.integration.test.ts` and
`lib/tokens/__tests__/update.test.ts` covering **exactly** the invariants D13
assigns to them (I1-I14, I19-I21) — one `it` per invariant, named for the
invariant, no others. Harness: `startMainPostgresTestDb` from
`@/test-support/pg-container`.

Acceptance:
- [x] Every listed invariant has exactly one owning `it`; no invariant has two.
- [x] No test asserts module shape, constant identity, or zod's declared types.
- [~] All failed before implementation, but as one module-absent error
      (`Cannot find module '@/lib/tokens/update'`), NOT as per-invariant
      assertion messages. Staging a partial stub purely to manufacture
      prettier failure text would have made some invariants pass at RED,
      which is weaker evidence. Deviation recorded, not hidden.

**T2.2 — GREEN: `lib/tokens/update.ts` + `isManagedToken`.**
`updateProjectToken({tokenId, projectId}, patch, actor, db)` and
`updateOwnerToken({tokenId, ownerUserId}, patch, actor, db)`. Shape mirrors
`revoke.ts`: scoping predicates → `not-found`; CAS on `isNull(revoked_at)`.
Diff-then-write: compute the changed-field set (a no-op returns `unchanged` and
writes nothing), then `UPDATE` + one lifecycle INSERT per changed field inside
**one** `db.transaction` (D8). `isManagedToken` (D3) lives in one exported
helper used by both the refusal and the ledger. Refusals are `MaisterError` with
typed `code` — no string matching (CLAUDE.md §3).

Acceptance:
- [x] I1-I9, I13, I14, I19, I20 green.
- [x] D5's table implemented literally, including `humanHitl` recomputation.
- [x] D6's service-layer empty-scope refusal present and **not** delegated to zod.
- [x] Logging per Settings; no secret, hash, or `token_hash` in any log line.

**T2.3 — GREEN: `recordTokenLifecycleEvent` + `issued` / `revoked`.**
One helper owning every write, refusing non-managed tokens internally (D11).
Wire `issued` into `issueToken`'s existing insert and `revoked` into
`revokeToken`/`revokeOwnerToken`, each in the same transaction as its own write.
The `already-revoked` early return writes **no** row.

Acceptance:
- [x] I21 green: no non-managed token reaches the table on any path.
- [x] `revokeToken` on an already-revoked row writes no second `revoked` row.
- [x] Machine mints (`issueAgentRunToken`, `issueOrchestratorRunToken`) produce
      **zero** lifecycle rows.

**T2.4 — GREEN: reserved-name guard, both directions.**
Shared validator refusing `^(orchestrator-run|agent-run):` case-insensitively,
wired into **both** PATCH paths and **both** existing POST routes (D4).

Acceptance:
- [x] I11 green — user routes refuse with `CONFIG`/422.
- [x] I12 green — `issueOrchestratorRunToken` and `issueAgentRunToken` still mint
      their reserved names. The guard is route-layer, **never** a DB CHECK.

**T2.5 — `revokeAgentRunToken` predicate hardening.**
Add `eq(projectTokens.token_kind, 'agent')` to its WHERE (`lib/agents/tokens.ts:189`).
One line; it makes the D11 invariant — machine revokes only ever touch
non-managed tokens — actually true rather than merely conventional.
Flagged as a deliberate, minimal widening beyond "add PATCH".

Acceptance:
- [x] Revoking a managed token id through this function is a no-op (0 rows).
- [x] The existing agent-revoke behavior is unchanged.

**T2.6 — REFACTOR.**
Extract nothing that is used once; collapse anything spelled twice. Confirm the
D3 predicate has exactly one definition, the D5 table exactly one implementation,
and the lifecycle write exactly one call path. Suite stays green; no behavior
change.

### Phase 3 — Routes (TDD)

**T3.1 — RED: route test set.**
Extend the two existing suites with exactly I15, I16, I17, I22 plus the
route-level half of I11. Route tests assert **status, body shape, and gate
only** — never service semantics already owned in Phase 2 (D13).

**T3.2 — GREEN: `PATCH /api/projects/[slug]/tokens/[tokenId]`.**
Added beside `DELETE` in the existing file. Zod body `.strict()`, D5 semantics,
`requireProjectAction(editSettings)`, reusing the file's existing
`httpStatusForAuthz`/`errorResponse` helpers unchanged. Identifiers exactly per D7.

**T3.3 — GREEN: `PATCH /api/account/tokens/[tokenId]`.**
Same, beside its `DELETE`. Preserves its own POST's `humanHitl` contract (D14) —
`hitl:respond:human` inside `scopes` is refused here as it is on POST.

Acceptance (T3.2 + T3.3):
- [x] I15, I16, I17, I22 green, including both **positive** grant tests (D9).
- [x] Responses match T0.3's OpenAPI exactly — status codes and body shape.
- [x] No new error code introduced; `docs/error-taxonomy.md` needs no change
      (confirmed, not assumed, in T6.3).

### Phase 4 — Required-scope disclosure (TDD)

**T4.1 — RED: I18** in `lib/tokens/__tests__/ext-handler.test.ts`.

**T4.2 — GREEN:** amend the refusal at `ext-handler.ts:~499` and rewrite the
adjacent invariant comment to draw the D10 line explicitly.

Acceptance:
- [x] I18 green — body carries `requiredScope`; for a token holding a distinctive
      scope set, the serialized body contains none of its held scopes.
- [x] The comment names precisely what stays secret and what does not.

### Phase 5 — UI + i18n

**T5.1 — Project token edit modal.**
`EditTokenModal` in `web/components/board/token-actions.tsx`, reusing the file's
`AccessibleModal`, `Field`, `ScopeField`, `useAction`, `readApiError`. Prefilled
from the row.

Acceptance:
- [x] Icon button beside Revoke; green check glyph on success, never the word
      "Succeeded" (`web/CLAUDE.md` UI affordance conventions).
- [x] Edit is withheld for revoked tokens **and for non-managed tokens** (D3) —
      the `orchestrator-run:*` rows currently rendered by `listTokens` must not
      offer it.

**T5.2 — Personal token edit modal.**
Same in `web/components/account/personal-tokens-panel.tsx`, reusing its
`SCOPE_OPTIONS` and the `humanHitl` checkbox.

**T5.3 — Edit-mode scope selection must never auto-widen.**

> **Refinement finding.** `toggleScope` in **both** panels returns `["*"]` when
> the last checkbox is unticked. On a create form that is a defensible default.
> On an edit form the user unticking their last scope silently **grants full
> access** to the token they were trying to restrict — the exact opposite of
> intent.

Acceptance:
- [x] In edit mode an empty selection stays empty; Submit is disabled with a
      message directing the user to pick a scope or revoke the token.
- [x] Create-mode behavior is **unchanged** (out of scope — surgical changes).
- [x] Component test covers the empty-selection branch in edit mode.

**T5.4 — i18n EN + RU.**
Every new key in **both** `web/messages/en.json` and `web/messages/ru.json`
(`tokens.*`, `account.personalTokens.*`), including refusal messages surfaced
through `apiErrors`. Current parity is 63/63 and 12/12 — it must stay exact.

### Phase 6 — Truth pass

**T6.1 — Renumber pass.** Re-derive max ADR and max `_journal.json` idx at the
current `master` HEAD; renumber on collision. Grep prose forms (`pre-0163`,
`since 0163`, `as of ADR-168`); prefer number-agnostic phrasing in long-lived
comments. Re-verify the migration triple and the "No schema changes" fourth leg.

**T6.2 — Test runnability + green.** `vitest list` confirms every added file is
matched by a runner project. Then `pnpm --filter maister-web test:unit &&
pnpm --filter maister-web test:integration` green, plus
`pnpm --filter maister-web lint`. Any red suite is classified obsolete-vs-broken
and resolved in this increment — never tolerated, never deleted silently.

**T6.2 outcome (recorded).** Blast radius is deterministically green:
64/64 token integration (service + both route suites), 343/344 ext integration,
and the whole unit suite bar the items below. `vitest list` confirms each added
file is matched by exactly one runner project.

Red suites classified:
- `test-support/__tests__/pg-container.test.ts` — **broken, fixed here.** Two
  real defects: it parsed `stdout.at(-1)`, but pino's async write for the same
  probe lands either side of the child's result line (failed ~1 run in 3); and
  it granted the child 10s while the unit project's 5s default fired first.
  Untouched by this plan otherwise; fixed because T6.2 forbids tolerating it.
- `app/api/runs/[runId]/hitl/[hitlRequestId]/respond`, `app/api/scratch-runs/
  [runId]/recover`, `app/api/v1/ext/runs/message` — **neither broken nor
  obsolete: load-sensitive.** None is touched by this branch; each passes 2-3/3
  in isolation and fails only inside a full lane while a CONCURRENT session on
  this machine runs its own integration suite (34 Docker containers live, ~10
  created per minute during the runs). Their budgets are 1000 ms matchers and
  the 5 s vitest default. NOT resolved here: the fix is a timing-budget review
  of those three suites, which is a separate change. The full unit + integration
  lanes should be re-run on an idle machine before merge.

**T6.3 — Docs truth pass.** Re-verify every Phase-0 artifact against the shipped
code. Regenerate the ERD (`pnpm --filter maister-web db:erd`) and run
`pnpm validate:docs`. Re-confirm the two assumptions this plan asserts rather
than proves at write time: no scope cache exists anywhere (D8), and no new error
code was needed (D7/T3.3).

**T6.4 — Adversarial review.** Refute-the-design pass over the whole diff:
authorization gates, the D3 predicate, the reserved-name guard both ways, the
transaction boundary, the 403 disclosure, and the D11 invariant. Per the project
rule, review **every** fix cycle this produces, not only the original change.

---

## Commit Plan

| Checkpoint | After | Message |
| --- | --- | --- |
| 1 | T0.5 | `docs(tokens): specify the token lifecycle domain (ADR-168)` |
| 2 | T1.1 | `feat(db): add token_lifecycle_events (migration 0163)` |
| 3 | T2.6 | `feat(tokens): mutate name/scopes/expiry with a lifecycle trail` |
| 4 | T3.3 | `feat(api): PATCH routes for project and personal tokens` |
| 5 | T4.2 | `feat(ext): name the required scope in the 403 body` |
| 6 | T5.4 | `feat(ui): edit token name, scopes and expiry` |
| 7 | T6.4 | `docs(tokens): truth pass after post-issuance mutation` |

---

## Open questions

1. `humanHitl` — оставляем расхождение двух поверхностей (D14) или унифицируем отдельной задачей?
2. `issued`/`revoked` в трейле — оставить или сузить до `scopes_changed`?
3. Панель чтения lifecycle-трейла — нужна или достаточно записи в БД?
4. Ротация секрета — заводить отдельную задачу сейчас или позже?
5. Эфемерные токены (`orchestrator-run:*`) видны в таблице токенов проекта. Прятать — сейчас, отдельной задачей или не трогать?
