# Plan: Flow reference resolution (UUID **or** human ref)

**Branch:** `feature/flow-ref-resolution`
**Base:** `main` (`4badadcb4`)
**Created:** 2026-07-14
**Type:** Enhancement (ergonomics/robustness)

## Settings

- **Testing:** yes
- **Logging:** verbose (DEBUG on the resolver + each wired call site)
- **Docs:** yes (mandatory docs checkpoint — this changes a wire contract's semantics)

## Goal

Let every flow-accepting write path resolve `flowId` by **either** its UUID
(`flows.id`) **or** its human ref (`flows.flow_ref_id`, e.g. `aif-bugfix`), so
MCP/ext/web callers can pass the readable ref the `flow_list` tool already hands
them instead of an opaque UUID. On an unresolvable ref, return a **structured,
self-correcting error** (expected forms + received value + the project's valid
refs) so an agent fixes it in one shot.

Follow-up to the already-landed `confidence`-string coercion fix
(`coerceNumericArgs`, `mcp/src/tools.ts`) — same session theme (agents need
actionable errors), but a **separate** change.

## Confirmed facts (verified — live DB + code)

- `flows.flow_ref_id` = plain human slugs (`aif-bugfix`, `aif-dev`, `bugfix`);
  package-prefixed, never colon-qualified, never UUID-shaped.
- `unique("flows_project_ref_uq").on(project_id, flow_ref_id)`
  (`web/lib/db/schema.ts:476`) → a ref resolves to exactly one flow per project.
  No ambiguity; ref/UUID namespaces do not overlap.
- `createTask` already validates `flowId` against `flows.id`
  (`web/lib/services/tasks.ts:79-89`) → this is a strict **superset** (UUID keeps
  working, ref newly accepted, garbage still rejected).
- All stored `tasks.flow_id` / `runs.flow_id` are UUIDs → **no data migration**;
  input-resolution only.

## Key decisions

- **Error-detail carrier: in the `message` string** (owner-chosen, minimal). The
  resolver returns a discriminated result; callers format
  `{ expected, received, validRefs }` into the `MaisterError` message — mirrors
  how the Zod `confidence` error already surfaces and self-corrects an agent. **No
  new error code, no `error-taxonomy.md` change, no `MaisterError.details` field.**
- **Resolver returns `{ok:true;flowId} | {ok:false;detail}`, not a hard throw.**
  Each caller maps a miss to its **existing** error taxonomy — `CONFIG` for
  triage/create, `PRECONDITION` for launch — carrying the formatted detail.
- **Scope: shared service layer** (ext + web via one implementation). **Run-launch
  override included.** **Delegate excluded** — `runs/delegate` rejects any
  `target.flowId` as a Phase-3 stub (`delegate/route.ts:145-154`); a resolver on a
  path that rejects all flowIds is dead work.
- **Identifier trust labels** (per project plan rule — body-controlled cross-resource id):
  `flowId` / `ref` = **body-controlled** → MUST be validated against **server-state**;
  `resolveFlowRef` IS that validation (project-scoped `flows` lookup). `projectId`
  = **server-state** (caller-derived from the token/route, never the body).
- **No ADR, no migration.** Reuses existing codes; documented in
  `external-operations.md` Expectations. (If review disagrees, allocate the ADR
  number from `main` HEAD per the numbering rule.)

## Contract surfaces (trace each to its spec)

| Surface | Spec/SSOT file | Change |
| ------- | -------------- | ------ |
| MCP tool descriptions (in-code SSOT shipped to agents) | `mcp/src/tools.ts` (`triage_set`/`task_create`/`run_launch` `flowId`) + `mcp/src/__tests__/tool-contract.test.ts` | "flow UUID or ref (e.g. `aif-bugfix`)" — NOT delegate |
| ext body `flowId` semantics (meaning broadens: UUID → UUID-or-ref) | `docs/system-analytics/external-operations.md` (Expectations) + `docs/api/external/operations.openapi.yaml` (param *description* only — type stays `string`) | prose + one Expectations bullet |
| Agent guidance | `../maister-plugins/packages/core/maister-agents/triager.md` (~line 188) | note ref accepted (**external repo** — separate commit) |
| Facade bundle | `mcp/dist/main.js` | rebuild (`pnpm --filter @maister/mcp build`) — agents run the bundle, not source |

No DB/migration surface. No new error code.

## Phases

### Phase 0 — Housekeeping + docs-first

- [ ] **T0.1 — Commit the pre-existing `confidence` coercion fix as its own commit.**
  Files: `mcp/src/tools.ts`, `mcp/src/__tests__/tools.test.ts`,
  `docs/system-analytics/external-operations.md` (the *confidence* Expectations bullet only).
  It is a verified, self-contained fix from this session — keep it a clean unit
  *before* layering this feature. Stage only those three files (`git add`), commit
  via `/aif-commit`. (`mcp/dist/main.js` is gitignored — no need to stage.)
  → verify: `git log` shows a standalone confidence-fix commit; working tree clean of it.
- [ ] **T0.2 — Docs-first Expectations bullet (analytics before code).**
  `docs/system-analytics/external-operations.md`: add a bullet — a body `flowId`
  MAY be a flow UUID (`flows.id`) **or** the project's `flows.flow_ref_id`; both
  resolve to the same stored UUID; an unresolvable ref returns a structured
  `CONFIG`/`PRECONDITION` error naming the expected forms, the received value, and
  the project's valid refs. Also update the `flowId` param *description* in
  `docs/api/external/operations.openapi.yaml` (type unchanged). Tag `(Implemented)`
  at phase end. → verify: `pnpm validate:docs` green.

### Phase 1 — Core primitive (TDD)

- [ ] **T1.1 — `resolveFlowRef`.** New `web/lib/flows/resolve-flow-ref.ts`.
  Signature: `resolveFlowRef(projectId: string, ref: string, db?: Db): Promise<{ ok: true; flowId: string } | { ok: false; detail: { field: "flowId"; expected: string; received: string; validRefs: string[] } }>`.
  One project-scoped query `WHERE project_id = :projectId AND (id = :ref OR flow_ref_id = :ref) LIMIT 1` → on hit return `flows.id`; on miss, one follow-up query for the project's `flow_ref_id` list to fill `validRefs`, return `ok:false`.
  Plus `formatFlowRefError(detail): string` (expected/received/validRefs → message text) for callers.
  Logging: DEBUG on entry (`projectId`, `ref`), DEBUG on hit/miss.
  Identifiers: `ref` body-controlled → validated here against server-state.
  → verify: T1.2 green.
- [ ] **T1.2 — Unit tests** (`web/lib/flows/__tests__/resolve-flow-ref.test.ts`, **web integration project** — testcontainers, `pg-container.ts`).
  Cases: UUID hit → flowId; ref hit → flowId; cross-project UUID → miss (+validRefs); unknown string → miss (+validRefs); another project's ref → miss.
  → verify: confirm the file matches the integration runner glob (`vitest list`); suite green.

### Phase 2 — Wire into the shared service layer (TDD per site)

- [ ] **T2.1 — Triage verdict.** `web/lib/services/triage.ts` `validateVerdictRefs`:
  resolve `patch.flowId` at entry; miss → `throw MaisterError("CONFIG", formatFlowRefError(detail))`; hit → the launchability/trust gate runs on the resolved UUID.
  **Persistence subtlety:** callers must WRITE the resolved UUID. Audit all three:
  ext triage route (`…/triage/route.ts` builds `verdict` then `applyTriageVerdict` — same object), `updateTaskVerdict` (same object), `updateTask` (`tasks.ts:440` validates a *throwaway* `verdictPatch(input)` and writes `input.flowId` separately — resolution MUST rewrite the written value). Preferred shape: `resolveFlowRef` returns the UUID and each service assigns it explicitly (no reliance on in-place mutation).
  → verify: T2.4 triage integration green; `tasks.flow_id` = UUID after a ref verdict.
- [ ] **T2.2 — Task create/update.** `web/lib/services/tasks.ts` `createTask` + `updateTask`: resolve `flowId` → UUID before write; the existing `flows.id` existence check in `createTask` is subsumed by the resolver (miss → `CONFIG` with formatted detail).
  → verify: T2.4 task-create integration green.
- [ ] **T2.3 — Run launch.** `web/lib/services/runs.ts` `launchRun` (~717): resolve the `input.flowId` **override** → UUID before the `eq(flows.id, …)` lookup; `task.flowId` is already a UUID; miss → keep `PRECONDITION` with formatted detail.
  → verify: T2.4 launch integration green.
- [ ] **T2.4 — Integration tests** — mirror existing, pass a **ref**, assert stored UUID:
  - triage: `web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/__tests__/route.integration.test.ts` — `flowId:"aif-bugfix"` → `triaged` + `tasks.flow_id` = UUID; unknown ref → 422 `CONFIG` whose message contains `validRefs`.
  - task-create integration (mirror the existing ext tasks test): ref → `tasks.flow_id` = UUID.
  - launch: a ref override resolves; unknown ref → `PRECONDITION` with detail.
  → verify: web unit + integration suites green (`pnpm --filter maister-web test:unit && …:integration`).

### Phase 3 — MCP surface + agent guidance

- [ ] **T3.1 — MCP tool descriptions.** `mcp/src/tools.ts`: `triage_set.flowId`, `task_create.flowId`, `run_launch.flowId` → "flow UUID or ref (e.g. `aif-bugfix`), as returned by `flow_list`". **Do NOT touch `delegate`.**
  → verify: T3.2 green.
- [ ] **T3.2 — MCP tests.** `mcp/src/__tests__/tools.test.ts` / `tool-contract.test.ts`: assert the three `flowId` descriptions mention "ref"; routing unchanged (facade forwards the string; the web service resolves). Runner: **mcp unit project**.
  → verify: `pnpm --filter @maister/mcp test` green.
- [ ] **T3.3 — Rebuild facade bundle.** `pnpm --filter @maister/mcp build`; `grep -c resolveFlowRef` is web-side (n/a) — instead grep the new description text in `mcp/dist/main.js`.
  → verify: bundle contains the updated descriptions.
- [ ] **T3.4 — Triager guidance** (external repo). `../maister-plugins/packages/core/maister-agents/triager.md` (~line 188): note the ref is accepted alongside the id. Separate commit in that repo; flag to owner (not part of this repo's branch).
  → verify: owner-visible note; no change to this repo's tree.

### Phase 4 — Verification

- [ ] **T4.1 — Full green + typecheck + lint.** `pnpm --filter maister-web test:unit && test:integration`, `pnpm --filter @maister/mcp test`, `tsc --noEmit` (both packages), scoped `eslint` (check-only) on touched files.
  → verify: all green; touched files lint-clean (no repo-wide `--fix`).
- [ ] **T4.2 — End-to-end sanity.** Drive `triage_set` with `flowId:"aif-bugfix"` against `maister-dev` → `triaged`, `tasks.flow_id` = the `aif-bugfix` UUID; an unknown ref → 422 whose message lists `validRefs`.
  → verify: observed behavior matches.

## Commit Plan (checkpoints — 10 tasks)

1. **After Phase 0** — `chore: separate confidence coercion fix` (T0.1) + `docs(external-ops): flowId accepts uuid or ref` (T0.2). Two commits.
2. **After Phase 1** — `feat(flows): resolveFlowRef primitive + tests`.
3. **After Phase 2** — `feat(flows): resolve flowId ref across triage/task/launch services`.
4. **After Phase 3** — `feat(mcp): flowId tool descriptions accept ref + rebuild bundle`.
5. **After Phase 4** — no code; verification only.

Integration: rebase onto `main`, owner FF-merges (per repo convention). Ask before push.

## Non-goals

- No fuzzy/prefix/case-insensitive matching — exact ref or exact UUID only.
- No data migration (all stored flowIds already UUIDs).
- No change to the ext OpenAPI **type** of `flowId` (`string`); only its meaning/description broadens.
- No `MaisterError.details` field / no new error code (owner chose message-embedded detail).
- Delegate flow-target stays a Phase-3 stub.
