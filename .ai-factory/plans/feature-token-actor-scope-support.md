# Token Actor Scope Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing M16 project-token surface so token calls are consistently scoped and first-class audit can distinguish project automation from a named human-owned token.

**Architecture:** Keep the existing `project_tokens` and `token_audit_log` storage boundary instead of introducing a second token system. Add token kind and owner metadata, enforce the already-recorded scope labels on every external route, and thread user-owned token identity into task/run creation through existing service contexts.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Drizzle/Postgres migrations, Vitest integration tests, Playwright E2E.

---

## Current State

- Implemented: project-scoped API token lifecycle in `web/lib/tokens/*`, `/api/projects/[slug]/tokens`, external REST routes under `/api/v1/ext/*`, token audit rows, external gate reporting, and MCP facade. Canonical docs: `docs/system-analytics/external-operations.md`, `docs/api/external/operations.openapi.yaml`, `docs/api/web.openapi.yaml`.
- Implemented: `scopes` are persisted and enforced by default through `handleExt()` on `/api/v1/ext/*`; `*` remains the compatibility scope for broad automation.
- Implemented but incomplete for attribution: `project_tokens.created_by` records who created a token, and `token_audit_log.token_id` records which token was used. There is no `token_kind`, no owner identity for a personal token, and external task/run creation passes `actorUserId: null`.
- Relevant now: project tokens and named user-owned project tokens. Project tokens power CI/Jenkins/crons and broad project automation; user-owned tokens power personal agents, chat/webhook channels, and accountable automation.
- Not relevant for code in this slice: platform tokens. There is no `/api/v1/platform/*` external surface or platform-token-protected operation yet, so platform tokens remain a designed follow-up with reserved semantics, not active code.

## Decisions

- **D1 Token kind:** add `project_tokens.token_kind` with `"project" | "user"`; existing rows default to `"project"`.
- **D2 Token owner:** add `project_tokens.owner_user_id` (`ON DELETE SET NULL`). `token_kind="user"` requires a live owner at issuance time; route-created user tokens default owner to the active caller.
- **D3 Scope enforcement:** every `/api/v1/ext/*` route enforces `scopeLabel` unless a route explicitly opts out with `requireScope: false`. A token with `"*"` still grants all scopes for backward compatibility.
- **D4 Attribution:** `verifyToken()` returns `tokenKind` and `ownerUserId`; external create-task and launch-run pass `actorUserId = ownerUserId` for `tokenKind="user"` and keep `null` for project tokens. `tasks.created_by_user_id` is added so task creation can be attributed the same way `runs.created_by_user_id` already is.
- **D5 Audit:** `token_audit_log` remains append-only and token-centric. It does not duplicate owner fields; audit can join `token_id -> project_tokens.owner_user_id` and keeps historical token name in `actor_label`.
- **D6 Platform tokens:** update docs to mark them `Designed / deferred`; do not add inactive DB enum values or unused route families.

## Contract Surfaces

- DB: `web/lib/db/schema.ts`, generated migration under `web/lib/db/migrations/`, `docs/database-schema.md`, `docs/db/integrations-domain.md`, `docs/db/erd.md`.
- HTTP routes: `/api/projects/{slug}/tokens`, `/api/projects/{slug}/tokens/{tokenId}`, all existing `/api/v1/ext/*` routes. Specs: `docs/api/web.openapi.yaml`, `docs/api/external/operations.openapi.yaml`.
- Analytics/spec docs: `docs/system-analytics/external-operations.md`, `docs/system-analytics/tasks.md`, `docs/system-analytics/identity-access.md`.
- UI/i18n: `web/components/board/token-actions.tsx`, `web/components/board/panels/integrations-panel.tsx`, `web/messages/en.json`, `web/messages/ru.json`.

## Trust Boundary Notes

- `POST /api/projects/{slug}/tokens`: `slug` is `url-param`; `name`, `expiresAt`, `kind`, and `scopes` are `body-controlled`; `ownerUserId` is not accepted from the body for this slice and is derived from `auth-context`.
- `GET /api/projects/{slug}/tokens`: `slug` is `url-param`; project id is `server-state`; no body identifiers.
- `DELETE /api/projects/{slug}/tokens/{tokenId}`: `slug` and `tokenId` are `url-param`; token mutation is scoped by `server-state project.id`, returning 404 for cross-project tokens.
- `/api/v1/ext/projects/{slug}/tasks`: `slug` is `url-param`; token identity is `auth-context`; `projectId` is `server-state`; `flowId` is `body-controlled` and must be validated against `server-state projectId`.
- `/api/v1/ext/runs`: `taskId` is `body-controlled`; route must pre-check task ownership against `auth-context projectId` before calling launch logic.

## Phase 0 - Spec Freeze

- [ ] Update `docs/system-analytics/external-operations.md` to describe token kind, owner user, all-route scope enforcement, and platform-token deferral.
- [ ] Update `docs/system-analytics/tasks.md` so external task creation is implemented, not planned, and mentions user-token attribution.
- [ ] Update DB docs/ERD for `project_tokens.token_kind`, `project_tokens.owner_user_id`, and `tasks.created_by_user_id`.
- [ ] Update OpenAPI specs for token-management body/response/list fields and external scope enforcement.
- [ ] Acceptance: `pnpm --filter maister-web run validate:docs:all` is run if available; otherwise run the repo docs validator script that exists in this checkout and record any unrelated gap.

## Phase 1 - Token Metadata and Scope RED/GREEN

- [ ] RED: extend `web/lib/tokens/__tests__/tokens.integration.test.ts` with a failing case that `issueToken({ tokenKind: "user", ownerUserId, scopes: ["tasks:create"] })` persists kind/owner/scopes and `verifyToken()` returns them.
- [ ] RED: extend `web/app/api/v1/ext/projects/[slug]/tasks/__tests__/route.integration.test.ts` with a failing case where a token scoped only to `tasks:read` receives 403 on `POST` and writes one error audit row with `scope_used="tasks:create"`.
- [ ] GREEN: update `web/lib/db/schema.ts`, generate migration, and update `web/lib/tokens/{issue,verify,list,audit}.ts`.
- [ ] GREEN: make `handleExt()` enforce scope by default and keep the 403 body scope-blind.
- [ ] Acceptance: focused token + ext task integration tests pass.

## Phase 2 - User-Owned Token Attribution

- [ ] RED: extend external task route integration to assert a `tokenKind="user"` token stores `tasks.created_by_user_id = ownerUserId`.
- [ ] RED: extend external run route integration to assert a `tokenKind="user"` token stores `runs.created_by_user_id = ownerUserId`.
- [ ] GREEN: add `tasks.createdByUserId` in schema/migration and thread `actorUserId` through `createTask()`.
- [ ] GREEN: update ext task and ext run routes to derive `actorUserId` from token kind.
- [ ] GREEN: update `ensureApiTokenActor()` callers for HITL to carry `ownerUserId` into `actor_identities.user_id`.
- [ ] Acceptance: focused ext task, ext run, and HITL token attribution tests pass.

## Phase 3 - Management API and UI

- [ ] RED: extend `/api/projects/[slug]/tokens` integration tests to create a user token with explicit scopes and assert list responses include `kind`, `ownerUserId`, and `scopes` while never returning `token_hash` or plaintext after creation.
- [ ] GREEN: update token-management route schemas, response DTOs, `listTokens()`, token table UI columns, create modal type/scope controls, and EN/RU messages.
- [ ] Acceptance: token route integration tests and token table unit tests pass.

## Phase 4 - E2E and Review

- [ ] Add/extend a Playwright spec for project Integrations: create a user-owned token, verify the once-only secret reveal, see kind/scope in the table, revoke the token.
- [ ] Run focused integration tests:
  - `pnpm --filter maister-web test:integration -- web/lib/tokens/__tests__/tokens.integration.test.ts`
  - `pnpm --filter maister-web test:integration -- 'web/app/api/projects/[slug]/tokens/__tests__/route.integration.test.ts'`
  - `pnpm --filter maister-web test:integration -- 'web/app/api/v1/ext/projects/[slug]/tasks/__tests__/route.integration.test.ts'`
  - `pnpm --filter maister-web test:integration -- 'web/app/api/v1/ext/runs/__tests__/route.integration.test.ts'`
- [ ] Run `pnpm --filter maister-web typecheck`, `pnpm --filter maister-web lint`, and the relevant Playwright spec.
- [ ] Dispatch reviewer/QA sidecars over the diff and fix Critical/Important findings.

## Open Questions

- Platform tokens should wait until the first platform external operation exists. The likely future shape is host-scoped, admin-created, and separate from project/user tokens so it cannot accidentally pass a project authorization check.
- If MAIster later supports user tokens across multiple projects, migrate from project-scoped `project_tokens` to a general `access_tokens` table. This plan deliberately avoids that churn until a multi-project personal-agent API is designed.
