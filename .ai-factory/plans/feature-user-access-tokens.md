# Implementation Plan: User Access Tokens

Branch: HEAD (detached; branch not created)
Created: 2026-06-23
Refined: 2026-06-23 via `$aif-improve`

> For agentic workers: implement task-by-task. This is an SDD-driven plan:
> Phase 0 freezes the spec and analytics contract before any production code,
> then every code phase follows RED -> GREEN -> REFACTOR.

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "none"
Rationale: the current roadmap has M16/M17/M31/M34 foundations implemented, but
no open milestone specifically owns global personal API tokens.

## Research Context
Source: none. `.ai-factory/RESEARCH.md` is absent in this checkout.

UI reference input: Lazyweb quick references for developer API-token settings
(Buildkite/Vercel/Musicful-style surfaces) show the relevant pattern: compact
settings page, table of keys, primary "New" action, masked/prefix key display,
created/last-used columns, explicit copy-once reveal, and destructive revoke.

## SDD Contract

The implementation is blocked until Task 8 completes. The SDD source of truth
is `.ai-factory/specs/feature-user-access-tokens.md`. It must contain:

- UI screen contracts for `/account` personal tokens, token creation modal,
  once-only secret reveal, revoke confirmation, and the unchanged project
  Integrations boundary.
- System analytics contracts for token lifecycle, owner-state authorization,
  external route project derivation, cross-project HITL inbox, human HITL
  response, MCP facade behavior, and token audit rows.
- DB migration definition for migration `0063`, including nullable fields,
  check constraints, indexes, FK delete behavior, and rollback/crash windows.
- API contracts for every added or modified route, including status codes,
  request/response DTOs, examples, and identifier trust labels.
- A spec-to-test matrix. Every acceptance criterion maps to at least one
  named RED test before GREEN implementation starts.

After Phase 0, code may change only to satisfy the frozen SDD. If implementation
discovers the SDD is wrong, update the SDD, analytics docs, and OpenAPI first,
then resume RED -> GREEN.

## Goal

Add first-class personal API tokens that a user creates from their account,
not from a project. These tokens operate across every project the owner can
currently access, are constrained by explicit scopes, and can optionally answer
human HITL gates through REST and MCP.

## Current State

- `project_tokens` already stores `token_kind in ('project', 'user', 'agent')`,
  `owner_user_id`, `agent_id`, and `scopes`, but `project_id` is `NOT NULL`.
- The project Integrations UX can create project-scoped `user` tokens, but
  there is no account-level token UX or session-auth account token API.
- `TokenActor.projectId`, `ExtCtx.projectId`, `handleExt()`, `listTokens()`,
  and `revokeToken()` all assume one token project.
- External task/run/HITL routes authorize by comparing addressed resources to
  `actor.projectId`. A global user token cannot pass this model.
- `respondToHitl()` treats `HitlActor.kind='user'` as human, but its user branch
  calls session-based `requireProjectAction()`. External token routes have no
  session, so this must become explicit-user authz before token-owned human
  responses are possible.
- The MCP facade forwards bearer tokens to `/api/v1/ext`; stdio reads only
  `MAISTER_PROJECT_TOKEN`. It has `hitl_list(runId)` and `hitl_respond(...)`,
  but no cross-project personal HITL inbox tool.
- `docs/screens/` has no account screen doc yet, even though `/account` exists.
- Existing docs intentionally call multi-project personal-agent API a future
  follow-up in `.ai-factory/plans/feature-token-actor-scope-support.md`.

## Decisions

- **D1 Storage:** keep the existing `project_tokens` table for compatibility;
  make `project_id` nullable instead of introducing a parallel token table.
- **D2 Token shape:** a global personal token is
  `token_kind='user'`, `owner_user_id NOT NULL`, `project_id IS NULL`.
  Existing project tokens and project-scoped user tokens remain valid.
- **D3 Check constraints:** enforce valid token rows at the DB layer:
  project tokens require `project_id`; agent tokens require `project_id` and
  `agent_id`; user tokens require `owner_user_id`; only agent tokens may have
  `agent_id`.
- **D4 Audit target:** make `token_audit_log.project_id` nullable. Per-resource
  external calls write the server-derived target project; cross-project personal
  inbox calls write `NULL`. Session-auth token lifecycle uses structured pino
  logs, not `token_audit_log`.
- **D5 FK behavior:** keep `project_tokens.project_id` `ON DELETE CASCADE` for
  project-bound tokens. Change `token_audit_log.project_id` to nullable
  `ON DELETE SET NULL` so audit rows for global personal tokens can survive
  target-project archival or hard-delete if hard-delete is later introduced.
- **D6 Scope model:** keep existing route scopes. Add `hitl:inbox:read` for
  cross-project pending HITL listing and `hitl:respond:human` for answering
  `human`, `infra_recovery`, and `budget_breach` HITL kinds.
  `hitl:respond` continues to cover permission/form automation only.
- **D7 Critical scope:** `hitl:respond:human` must be granted explicitly; `*`
  must not imply it. Broad automation tokens must not silently become human
  approvers.
- **D8 Resource authz:** global personal tokens never trust body-provided
  project ids. Each route derives the target project from URL slug or
  server-state, then authorizes the token owner against that project.
- **D9 Owner state:** a personal token is usable only while its owner account
  exists, is active, and is not forced to change password. Owner deletion
  (`owner_user_id` set null) fails closed.
- **D10 MCP compatibility:** keep `MAISTER_PROJECT_TOKEN`; add
  `MAISTER_ACCESS_TOKEN` as a clearer stdio alias. `MAISTER_PROJECT_TOKEN`
  stays first-precedence for backwards compatibility with existing injected
  agent tokens; `MAISTER_ACCESS_TOKEN` is the fallback.
- **D11 UI placement:** personal tokens live on `/account`, below Profile.
  Project Integrations stays project-bound and must not list or create global
  personal tokens.
- **D12 ADR/migration allocation:** reserve ADR-104 and migration `0063` for
  this slice. Re-run a numbering pass before implementation finishes if main
  has moved.
- **D13 Testing:** no trivial tests. Each test must prove behavior from the SDD,
  a security boundary, a DB invariant, an external contract, or a stable pure
  data transformation. Avoid overlapping coverage unless the same risk crosses
  multiple boundaries.
- **D14 Code shape:** prefer small single-purpose functions over flag-driven
  multi-mode helpers. Follow existing `server-only`, Drizzle, `MaisterError`,
  HeroUI, pino, and i18n patterns. No new component library, ORM, auth library,
  or token table.

## Contract Surface Ledger

| Surface | Change | Spec owner |
| ------- | ------ | ---------- |
| SDD spec | New source-of-truth spec | `.ai-factory/specs/feature-user-access-tokens.md` |
| ADR | New ADR-104 | `docs/decisions.md` |
| Account screen | Add personal-token section to `/account` | `docs/screens/account.md`, `docs/screens/README.md` |
| Project Integrations | Clarify project-bound token scope | `docs/screens/projects/project-board.md` |
| Token analytics | Global personal tokens, route authz, audit | `docs/system-analytics/external-operations.md` |
| HITL analytics | Inbox + exact-scope human responses | `docs/system-analytics/hitl.md` |
| Identity analytics | Account-token management and owner-state authz | `docs/system-analytics/identity-access.md` |
| DB schema | Nullable token project ids, checks, indexes | `docs/database-schema.md`, `docs/db/integrations-domain.md`, `docs/db/erd.md` |
| Web OpenAPI | Account token routes | `docs/api/web.openapi.yaml` |
| External OpenAPI | Ext authz semantics and `/api/v1/ext/hitl` | `docs/api/external/operations.openapi.yaml` |
| Config docs | MCP env alias | `docs/configuration.md`, `.env.example` |
| MCP facade | Auth alias and `hitl_inbox` tool | `mcp/src/auth.ts`, `mcp/src/tools.ts`, MCP tests/docs |
| Source | DB/token/authz/API/UI/MCP changes | `web/**`, `mcp/**` |

## UI Screen Contract

Phase 0 must fully specify these before UI code starts:

- `/account` layout keeps the existing Profile section and adds a "Personal API
  tokens" section below it. The section uses the same dense settings language
  as `/settings`: compact header, primary "New token" action, table-first
  layout, empty state, and no marketing copy.
- Token table columns: name, prefix, scopes/capability summary, human HITL
  capability, created at, last used at, expires at, revoked state, actions.
  Plaintext token and token hash never appear after creation.
- Create modal fields: name, expiry, permission groups, advanced raw scopes
  only if the existing token UI already has that affordance, and a separate
  toggle labelled for the human HITL capability. The human HITL toggle must
  have an inline warning that it lets this token act as the user on eligible
  human gates.
- Once-only reveal state: after successful creation, the modal replaces the form
  with a selectable secret, copy button, warning, and done action. Closing the
  modal loses the secret.
- Revoke state: row action opens a confirmation affordance; revoke is
  idempotent, table refreshes, and revoked rows are visibly disabled or marked.
- Error states: validation errors, insufficient session/account state, and
  network/server failures use existing error tone and do not expose held scopes
  or token material.
- Project Integrations keeps project/project-scoped user tokens only; it may
  link to `/account` for personal tokens but must not duplicate the global UX.
- EN/RU catalogs must cover all visible strings.

## DB Migration Definition

The SDD and migration task must define migration `0063` as generated by
Drizzle, not hand-edited SQL:

- `project_tokens.project_id`: nullable FK to `projects.id`, `ON DELETE CASCADE`.
- `token_audit_log.project_id`: nullable FK to `projects.id`,
  `ON DELETE SET NULL`.
- Preserve `project_tokens_agent_kind_check` semantics while extending checks:
  - `token_kind != 'project' OR project_id IS NOT NULL`
  - `token_kind != 'agent' OR (project_id IS NOT NULL AND agent_id IS NOT NULL)`
  - `token_kind != 'user' OR owner_user_id IS NOT NULL`
  - `token_kind = 'agent'` iff `agent_id IS NOT NULL`
- Indexes:
  - keep `project_tokens_prefix_idx`
  - keep `project_tokens_project_idx`
  - keep `project_tokens_owner_idx`
  - add owner listing index for global personal tokens, e.g.
    `(owner_user_id, created_at)` with the best Drizzle-supported shape
  - keep `token_audit_token_idx`
  - keep `token_audit_project_created_idx`, valid for nullable project ids
  - add a global-audit lookup only if SDD defines an account audit view
- Migration compatibility: existing project/project-scoped user/agent token rows
  remain valid. No data backfill should create global tokens.

## Identifier and Authz Boundary

Every route in the SDD must include an identifier table with these labels:
`url-param`, `auth-context`, `server-state`, `body-controlled`.

Required decisions:

- `POST /api/account/tokens`: owner is `auth-context`; name/scopes/expiry are
  `body-controlled`; project id is not accepted.
- `GET /api/account/tokens`: owner is `auth-context`; no body ids.
- `DELETE /api/account/tokens/{tokenId}`: token id is `url-param`, owner is
  `auth-context`; delete predicate includes owner id and `project_id IS NULL`.
- Project slug ext routes: slug is `url-param`; project id is `server-state`;
  global token owner authz is derived from project membership/global admin.
- Run ext routes: run id is `url-param`; project id is `server-state` from the
  run row; body ids never expand authority.
- `/api/v1/ext/hitl`: token owner is `auth-context` from bearer token;
  visible projects are `server-state` derived from owner membership/admin role.

## Development Discipline

- Phase 0 is docs/spec only. No production code, no migration files, no test
  files except validator fixtures if needed.
- Each implementation slice starts with RED tests from the SDD matrix, then
  GREEN code, then REFACTOR cleanup while the focused suite stays green.
- RED tests must fail for the intended reason. Record the failing command and
  assertion in the implementation notes or commit body.
- Refactor means removing duplication introduced during GREEN, aligning names,
  and extracting single-purpose helpers. It is not an invitation to remodel
  unrelated code.
- Keep tests focused and non-overlapping:
  - DB invariants in DB/token integration tests.
  - Route authz/status/DTO shape in route integration tests.
  - HITL actor-kind behavior in HITL service/route integration tests.
  - MCP mapping/env precedence in MCP unit/integration tests.
  - One browser smoke for the account token UX if the existing Playwright
    harness can do it without brittle selectors or token snapshots.
- Every phase exit runs the focused tests for that phase plus a runnability
  check for any new test path. Final phase runs full typecheck/lint/tests/docs.

## Deployment Touchpoints

- Database migration `0063` changes nullable constraints, FKs, checks, and
  indexes. No supervisor/web port or sidecar changes are expected.
- `.env.example` and `docs/configuration.md` need `MAISTER_ACCESS_TOKEN` as an
  MCP stdio alias. Existing `MAISTER_PROJECT_TOKEN` remains supported.
- Compose files should remain unchanged unless implementation discovers a
  service-level env list that must mirror `.env.example`; if so, update the
  compose file in the same task.

## Commit Plan

- **Commit 1** (Phase 0): `docs(user-tokens): freeze SDD and contracts`
- **Commit 2** (Phases 1-2): `feat(user-tokens): add storage and token domain`
- **Commit 3** (Phases 3-4): `feat(user-tokens): add owner authz and account UX`
- **Commit 4** (Phases 5-6): `feat(user-tokens): authorize ext routes and HITL`
- **Commit 5** (Phases 7-8): `feat(user-tokens): expose personal HITL through MCP`
- **Commit 6** (Phase 9): `docs(user-tokens): finalize specs and verification`

## Tasks

### Phase 0: SDD Freeze, Screens, Analytics, and Contracts

- [x] Task 1: Create `.ai-factory/specs/feature-user-access-tokens.md` as the
  frozen SDD. It must include goals, non-goals, UI contract, route contracts,
  DB migration definition, state machines, process flows, edge cases, exact
  authz rules, logging rules, and spec-to-test matrix. Logging: spec defines
  INFO/WARN/ERROR fields; no runtime logging.
- [x] Task 2: Add screen docs. Create `docs/screens/account.md`, update
  `docs/screens/README.md`, and update the relevant project board/settings
  screen doc for the project Integrations boundary. Include JTBD, roles,
  navigation, layout regions, states, data/APIs, i18n namespace, and linked
  artifacts. Logging: n/a; docs must mention no token material in browser logs.
- [x] Task 3: Update system analytics before code:
  `docs/system-analytics/external-operations.md`,
  `docs/system-analytics/hitl.md`, and
  `docs/system-analytics/identity-access.md`. They must fully cover global
  personal token lifecycle, owner-state gates, cross-project authz, human HITL
  exact-scope behavior, MCP stdio aliasing, and refusal tables. Logging: docs
  specify structured fields for create/revoke/authz/audit failures.
- [x] Task 4: Update DB docs and ERDs before code:
  `docs/database-schema.md`, `docs/db/integrations-domain.md`, and
  `docs/db/erd.md`. Include the full `0063` migration definition, nullable FK
  semantics, check constraints, indexes, cascade/set-null behavior, and existing
  row compatibility. Logging: n/a.
- [x] Task 5: Update API contracts before code:
  `docs/api/web.openapi.yaml` for `/api/account/tokens` routes and
  `docs/api/external/operations.openapi.yaml` for global-token authorization,
  `/api/v1/ext/hitl`, and HITL response semantics. Include every status code,
  DTO, example, security scheme wording, and identifier labels. Logging: each
  operation names its audit/log behavior and non-logged fields.
- [x] Task 6: Add ADR-104 to `docs/decisions.md` with one decision: global
  personal tokens reuse `project_tokens` with nullable `project_id`, exact
  human HITL scope, explicit-owner authz, and nullable audit target. Run the
  ADR anchor validator, not only Mermaid validation. Logging: n/a.
- [x] Task 7: Add the SDD spec-to-test matrix. Every acceptance criterion must
  map to a future test file and runner. Include runnability commands for new
  paths and identify existing tests whose assertions will migrate. Logging: n/a.
- [x] Task 8: Phase-0 gate. Run `pnpm validate:docs:all` and
  `pnpm validate:docs:adr:all`; inspect OpenAPI sections touched by hand.
  Phase exits only when SDD, analytics, screens, DB docs, ADR, and OpenAPI are
  internally consistent. Logging: record exact command/status on failure.

### Phase 1: RED Tests from the SDD Matrix

- [x] Task 9: Write RED DB/token integration tests in the existing token test
  area for nullable `project_id`, nullable audit target, check constraints,
  owner delete/null fail-closed behavior, exact critical scope, and unchanged
  project/agent token behavior. Verify the new test path is matched by the
  integration runner. Logging: tests assert no plaintext/hash is exposed.
- [x] Task 10: Write RED account-token route integration tests for create/list/
  revoke, once-only secret reveal, owner-only access, inactive and
  password-change owner denial, and absence from project token lists. Logging:
  tests assert structured responses and no token material after creation.
- [x] Task 11: Write RED authz/ext route integration tests for global user
  tokens across two projects: allowed project succeeds, inaccessible project is
  existence-hidden or 403 per SDD, body ids cannot expand authority, and audit
  rows carry target project/null correctly. Logging: tests assert failure audit
  scope/status fields.
- [x] Task 12: Write RED HITL tests for cross-project inbox, permission/form
  responses, human response with exact `hitl:respond:human`, human response
  without exact scope, project-token human refusal, inactive owner refusal, and
  session-route parity after service refactor. Logging: tests assert accepted
  and refused audit rows.
- [x] Task 13: Write RED MCP tests for `MAISTER_PROJECT_TOKEN` precedence,
  `MAISTER_ACCESS_TOKEN` fallback, `hitl_inbox` mapping, and updated
  `hitl_respond` description. Logging: tests must not snapshot token secrets.
- [x] Task 14: Run the RED focused commands from the SDD matrix and confirm
  failures are for the intended missing behavior, not broken setup. Do not
  proceed to GREEN until the failure reason is recorded. Logging: record command,
  status, and first expected failure.

Phase 1 RED record:
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration lib/db/__tests__/migration-0064-user-access-tokens.integration.test.ts lib/tokens/__tests__/tokens.integration.test.ts` from `web/` -> failed as expected: `project_tokens.project_id` and `token_audit_log.project_id` still `NOT NULL`, audit FK still `CASCADE`, owner index absent, ownerless user token accepted, wildcard satisfied human scope.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration app/api/account/tokens/__tests__/route.integration.test.ts` from `web/` -> failed as expected: missing `@/app/api/account/tokens/route`.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/projects/[slug]/tasks/__tests__/route.integration.test.ts'` from `web/` -> failed as expected: new global-token cases hit `project_tokens.project_id` `NOT NULL`; existing project-token cases passed.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/hitl/__tests__/route.integration.test.ts'` from `web/` -> failed as expected: missing `@/app/api/v1/ext/hitl/route`.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/runs/[runId]/hitl/__tests__/route.integration.test.ts'` from `web/` -> failed as expected: `hitl:respond:human` is not in `TOKEN_SCOPE_VALUES` yet; existing run-scoped HITL tests passed.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project unit src/__tests__/auth.test.ts src/__tests__/tools.test.ts` from `mcp/` -> failed as expected: `MAISTER_ACCESS_TOKEN` fallback missing, `hitl_inbox` missing, and `hitl_respond` description still says human-kind requests are refused.

### Phase 2: GREEN Storage and Token Domain

- [x] Task 15: Generate migration `0063_*` with Drizzle and update
  `web/lib/db/schema.ts` for nullable FKs, checks, and indexes exactly as the
  SDD defines. Do not hand-edit committed migration files. Logging: none in
  migration; no token material in logs.
- [x] Task 16: Refactor token issue/verify types so global user tokens are
  first-class: `IssueTokenInput.projectId` and `TokenActor.projectId` become
  nullable where required, and `issueUserAccessToken()` writes
  `project_id NULL`. Logging: INFO on issue with `tokenId`, `ownerUserId`,
  `scopeCount`, `global=true`, and expiry presence.
- [x] Task 17: Split token listing/revocation helpers into project-scoped and
  owner-scoped variants. Owner-scoped revoke predicates include `owner_user_id`
  and `project_id IS NULL`, hiding other users' tokens as not-found. Logging:
  INFO on revoke outcome, DEBUG for not-found probes.
- [x] Task 18: Extend scope helpers with `hitl:inbox:read`,
  `hitl:respond:human`, and an exact-scope predicate that intentionally does not
  honor `*`. Refactor duplicated scope label text only if needed by existing UI.
  Logging: scope-denial callers include `scopeUsed`, endpoint, method, status,
  token id, and no held scope list.
- [x] Task 19: GREEN checkpoint for Phase 2. Run the token DB focused tests,
  then run `pnpm --filter maister-web typecheck`. Refactor only duplicated
  token-domain code introduced in this phase. Logging: record any unrelated
  pre-existing failures with command and error.

### Phase 3: GREEN Explicit-User Authz and Ext Handler

- [x] Task 20: Add `requireProjectActionForUser(userId, projectId, action)` in
  `web/lib/authz.ts`, using DB-authoritative user loading, active-account and
  password-change checks, global-admin implicit owner behavior, and project
  membership checks. Make session `requireProjectAction()` delegate to it.
  Logging: DEBUG grants/denials with user, project, action, role, min; WARN for
  missing/inactive/password-change users.
- [x] Task 21: Add token-owner/project authorization helpers in the token auth
  layer. Project/agent/project-scoped user tokens keep exact project matching;
  global user tokens call explicit-user authz. Logging: WARN on ownerless or
  disabled user tokens with token and owner ids.
- [x] Task 22: Refactor `handleExt()` to authenticate first, support nullable
  actor project ids, accept a route-level target-project authorization callback,
  support `auditProjectId: string | null`, and preserve one audit row per
  identified external token call. Logging: keep ERROR for required audit write
  failures; DEBUG resolved target project and actor kind.
- [x] Task 23: Update token audit helpers and tests for nullable
  `project_id`, expired/revoked global user tokens, and `last_used_at` bump on
  global calls. Logging: failure audit still avoids invalid/unidentified tokens.
- [x] Task 24: GREEN checkpoint for Phase 3. Run authz/ext-handler focused
  tests plus migrated existing project-token tests. Refactor only for
  single-purpose helpers and removal of temporary duplication. Logging: record
  command/status.

### Phase 4: GREEN Account API and UI

- [x] Task 25: Add session-auth `GET/POST /api/account/tokens` and
  `DELETE /api/account/tokens/[tokenId]`. Keep Route Handlers thin: zod
  boundary validation, call token-domain helpers, explicit DTO projection, and
  typed `MaisterError` mapping. Logging: INFO create/revoke, WARN validation or
  account-state denial, no token material.
- [x] Task 26: Add the `/account` personal-token section using existing account
  page conventions and reusable token UI where it stays simple. The section must
  implement table, empty state, create modal, once-only reveal, copy, revoke,
  and errors exactly as the screen doc describes. Logging: client logs nothing.
- [x] Task 27: Keep project Integrations project-bound. Adjust project token
  labels/help only as needed so global personal tokens are not created or listed
  there; optionally link to `/account`. Logging: unchanged project-token route
  logs include slug, token id, kind, and scope count.
- [x] Task 28: Add EN/RU messages for all new account-token UI and errors
  under stable `account.personalTokens.*` keys (explicit-key style like
  `taskDetail.lcChecks`, no component-local visible-label literals). Verify
  message parity. Logging: n/a.
- [x] Task 29: GREEN checkpoint for Phase 4. Run account-token route tests,
  a focused UI/component test only if it asserts stateful behavior, and one
  account Playwright smoke only if existing auth setup supports stable selectors.
  Do not add snapshot-only or label-only tests. Logging: record command/status.

### Phase 5: GREEN External Resource Authorization

- [x] Task 30: Update project slug external routes for tasks, task detail,
  triage, comments, and relations to use server-derived project authorization.
  Preserve project-token exact matching and global-user owner authz. Logging:
  DEBUG endpoint, token kind, target project, action.
- [x] Task 31: Update run external routes to derive target project from
  server-state and reject body-controlled cross-resource expansion:
  readiness, run read, run create, plan, delegate, message, collect, cancel,
  promote, and rework as applicable. Preserve bound-run checks for ephemeral
  agent/orchestrator tokens. Logging: DEBUG server-derived project and bound
  run id; WARN stale or terminal bound tokens.
- [x] Task 32: Update `actorUserIdForToken()` and social actor mapping so
  global user tokens keep user attribution for task/comment/run writes, project
  tokens remain system, and agent tokens remain agent actors. Logging: mutation
  routes rely on existing task activity/audit logs.
- [x] Task 33: GREEN checkpoint for Phase 5. Run ext task/comment/relation/run
  focused tests and migrate existing assertions explicitly named in the SDD.
  Refactor only to remove duplicated resource-authz code. Logging: record
  command/status.

### Phase 6: GREEN HITL Personal Inbox and Human Responses

- [x] Task 34: Add `GET /api/v1/ext/hitl` for global personal tokens. It lists
  pending HITL across owner-visible projects using `getCrossProjectHitlInbox`
  semantics or a shared query helper. Gate with `hitl:inbox:read` where `*` is
  allowed because the route is read-only. Project tokens return 403
  `UNAUTHORIZED`. Logging: audit success with `projectId=null`; DEBUG visible
  project count and result count.
- [x] Task 35: Refactor run-scoped HITL list/response routes to support global
  user tokens by deriving `run.projectId` and authorizing the owner. Existing
  project/agent tokens keep permission/form behavior. Logging: audit target
  project is the run project; WARN unauthorized human-scope attempts.
- [x] Task 36: Refactor `respondToHitl()` so `HitlActor.kind='user'` authorizes
  by `actor.userId` via explicit-user authz, not ambient session. The session
  route keeps passing the active session user. Logging: service logs run id,
  hitl request id, actor kind, label, and target project on authz failure.
- [x] Task 37: Add external response dispatch for human kinds. A global user
  token with exact `hitl:respond:human` becomes `HitlActor.kind='user'`; every
  other token remains `api_token` and is refused for human, infra-recovery, and
  budget-breach gates. Logging: WARN missing exact scope; INFO accepted human
  response with token id, owner id, hitl kind, run id, and status.
- [x] Task 38: GREEN checkpoint for Phase 6. Run HITL route/service tests and
  session-route parity tests. Refactor only duplicated actor construction or
  target-project resolution. Logging: record command/status.

### Phase 7: GREEN MCP Facade

- [x] Task 39: Update MCP stdio auth to accept `MAISTER_ACCESS_TOKEN` as a
  personal-token alias while preserving `MAISTER_PROJECT_TOKEN` first
  precedence. Logging: MCP must not log token values; auth resolution remains
  silent or DEBUG-only with env-name presence.
- [x] Task 40: Add MCP `hitl_inbox` backed by `GET /api/v1/ext/hitl`. Keep
  `hitl_list(runId)` for run-scoped listings. Logging: mapping layer logs
  nothing; REST audit covers use.
- [x] Task 41: Update `hitl_respond` description and tests so human HITL can be
  answered only with global personal tokens carrying exact
  `hitl:respond:human`; project/agent tokens still refuse. Logging: none in
  the mapping layer.
- [x] Task 42: Verify agent-token injection in `web/lib/agents/launch.ts` keeps
  using project/run-bound tokens and is not accidentally converted to global
  personal credentials. Logging: existing launch logs must not include env token
  values.
- [x] Task 43: GREEN checkpoint for Phase 7. Run
  `pnpm --filter @maister/mcp test`, MCP typecheck, and the web agent-token
  injection test touched by Task 42 if any. Refactor only mapping/auth
  duplication. Logging: record command/status.

### Phase 8: Spec Consistency and As-Built Sync

- [x] Task 44: Reconcile SDD, system analytics, screens docs, OpenAPI, DB docs,
  and source code after GREEN. The SDD stays the SSOT; if code had to differ,
  update SDD and contracts first, then code/tests. Flip status tags from
  Designed/Planned to Implemented only for shipped behavior. Logging: n/a.
- [x] Task 45: Update `.env.example`, `docs/configuration.md`, and MCP docs for
  `MAISTER_ACCESS_TOKEN`, keeping `MAISTER_PROJECT_TOKEN` compatible language
  for project/run-bound tokens. If compose env surfaces need parity, update them
  here. Logging: n/a.
- [x] Task 46: Run docs and contract validation:
  `pnpm validate:docs:all`, `pnpm validate:docs:adr:all`, and OpenAPI lint for
  changed specs if available. Logging: record exact command/status and any
  reviewed warnings.

### Phase 9: Final Verification

- [x] Task 47: Run focused suites from the SDD matrix:
  token DB/domain tests, account-token route tests, ext route authz tests, HITL
  tests, MCP tests, and the optional account Playwright smoke if added.
  Logging: record command/status and first actionable failure.
- [x] Task 48: Run final broad gates:
  `pnpm --filter maister-web typecheck`,
  `pnpm --filter maister-web test:unit`,
  `pnpm --filter maister-web test:integration`,
  `pnpm --filter @maister/mcp typecheck`,
  `pnpm --filter @maister/mcp test`,
  and `pnpm validate:docs`. Use scoped lint on changed paths or full lint only
  if the repo's current workflow expects auto-fix churn. Logging: record
  unrelated pre-existing failures with exact command and error.
- [x] Task 49: Final review pass. Grep for token material leakage, body-derived
  project ids, unchecked `actor.projectId`, `hitl:respond:human` wildcard use,
  docs mentions of project-only tokens, and un-run test paths. Logging: include
  grep commands and results in the close-out.

Phase 2-9 GREEN verification record:
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration lib/db/__tests__/migration-0064-user-access-tokens.integration.test.ts lib/tokens/__tests__/tokens.integration.test.ts` from `web/` -> passed: 24 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/account/tokens/__tests__/route.integration.test.ts'` from `web/` -> passed: 5 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/projects/[slug]/tasks/__tests__/route.integration.test.ts'` from `web/` -> passed: 11 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/hitl/__tests__/route.integration.test.ts'` from `web/` -> passed: 3 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/runs/[runId]/hitl/__tests__/route.integration.test.ts'` from `web/` -> passed: 22 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project integration 'app/api/v1/ext/runs/__tests__/route.integration.test.ts' 'app/api/v1/ext/projects/[slug]/tasks/[taskId]/__tests__/route.integration.test.ts' 'app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/__tests__/route.integration.test.ts' 'app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/__tests__/route.integration.test.ts' 'app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/__tests__/route.integration.test.ts' 'app/api/v1/ext/runs/[runId]/gates/[gateId]/report/__tests__/route.integration.test.ts'` from `web/` -> passed: 48 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project unit lib/__tests__/i18n-parity.test.ts lib/__tests__/i18n-tokens-keys.test.ts components/board/panels/__tests__/integrations-panel.test.ts` from `web/` -> passed: 77 tests.
- `pnpm --filter maister-web typecheck` -> passed after the final authz/test-harness patch.
- `pnpm --filter maister-web test:unit` -> passed outside sandbox: 439 files, 4723 tests.
- `pnpm exec vitest run --workspace vitest.workspace.ts --project unit src/__tests__/auth.test.ts src/__tests__/tools.test.ts` from `mcp/` -> passed: 43 tests.
- `pnpm --filter @maister/mcp typecheck` -> passed.
- `pnpm --filter @maister/mcp test` -> passed earlier: unit 53 tests, integration no tests.
- `pnpm validate:docs:all` -> passed: 279/279 Mermaid blocks, 562 ADR anchors.
- OpenAPI parse smoke for `docs/api/web.openapi.yaml` and
  `docs/api/external/operations.openapi.yaml` -> passed.
- `pnpm --filter maister-web test:integration` -> passed on retry after the
  auth/test-harness fixes: 226 files, 1732 tests, 116.78s.
- Final grep/static checks passed: no `projectId: ctx.actor.projectId` remains
  under `web/app`/`web/lib`, `MAISTER_ACCESS_TOKEN` is absent from `web/app`,
  `web/lib`, and `supervisor`, and `git --no-pager diff --check` is clean.

## Acceptance Criteria

- SDD exists and was the implementation source of truth before code changed.
- `/account` has a fully documented and implemented personal-token management
  section with once-only secret reveal and revoke flow.
- Personal global tokens have `project_id NULL` and never appear in project
  Integrations token lists.
- Existing project tokens, project-scoped user tokens, agent tokens, and
  orchestrator run-bound tokens keep their behavior.
- Global personal tokens can use existing task/run/comment/relation external
  APIs only on projects the owner can currently access.
- Body-provided project identifiers never expand authority; routes derive
  project ids from URL slug or server-state.
- Cross-project HITL inbox is available through REST and MCP for personal tokens
  with `hitl:inbox:read`.
- Human HITL response through REST/MCP requires a live owner with project
  `answerHitl` access and exact `hitl:respond:human`; `*` alone is not enough.
- Every identified external token call writes exactly one audit row, with
  `project_id` set to the target project or `NULL` for global inbox calls.
- Specs, analytics, screens docs, OpenAPI, DB docs, MCP docs, EN/RU copy, tests,
  and validation commands are updated in the same implementation.

## Open Questions

- Should project-scoped user tokens continue to be creatable from project
  Integrations after global personal tokens ship, or should that UI become
  project/project-agent only? This plan preserves them for compatibility.
- Should the account UI expose raw scope checkboxes immediately, or group scopes
  into task/run/HITL/MCP capability clusters and keep raw scope editing behind an
  advanced toggle? Phase 0 SDD must decide before UI code.
