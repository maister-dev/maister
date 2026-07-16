# Plan: Flow reference resolution (UUID **or** human ref) — SDD

**Branch:** `feature/flow-ref-resolution`
**Base:** `main` (`ce005fbd7`)
**Created:** 2026-07-14 · **Refined:** 2026-07-14 (`/aif-improve`, SDD pass)
**Type:** Contract-drift fix + ergonomics

## Settings

- **Testing:** yes — TDD, strict RED → GREEN → refactor
- **Logging:** verbose (DEBUG on the resolver + each wired call site)
- **Docs:** yes — **specs lead** (Phase 1 gates all code)

## Problem

`docs/api/external/operations.openapi.yaml` documents the triage body with
**executable examples that use a human ref**:

```yaml
verdict:            { flowId: "bugfix", runnerId: "claude-code", ... }   # line ~462
verdict-enqueue:    { flowId: "bugfix", runnerId: "claude-code", enqueue: true }  # ~473
```

`bugfix` is a real `flows.flow_ref_id` in the live DB. But
`validateVerdictRefs` (`web/lib/services/triage.ts`) matches **`flows.id` (UUID)
only** — so **a client following the spec's own example gets 422**.

Per `docs/CLAUDE.md` **R3**: *"API specs are the source of truth… Implementation
drift is a bug — fix code OR fix the spec, never both silently."* This plan fixes
the **code** (makes the documented examples true), because the ref is what
`flow_list` already hands the caller.

The spec is additionally **self-inconsistent**: `ExtFlowSummary.id` is described
as *"The flow id (the value passed back as `ExtTriageBody.flowId`)"* while the
examples pass `ref`. Phase 1 resolves that contradiction explicitly.

## Confirmed facts (evidence)

| Fact | Evidence |
| ---- | -------- |
| `flow_ref_id` = plain human slugs (`aif-bugfix`, `bugfix`), never UUID-shaped | live DB query over `flows ⋈ projects` |
| A ref resolves to **exactly one** flow per project | `unique("flows_project_ref_uq").on(project_id, flow_ref_id)` — `web/lib/db/schema.ts:476` |
| `createTask` already validates `flowId` against `flows.id` | `web/lib/services/tasks.ts:79-89` → this change is a strict **superset** |
| All stored `tasks.flow_id` / `runs.flow_id` are UUIDs | resolution is **input-only** → **no migration** |
| ext `POST /api/v1/ext/runs` **refuses** `flowId` (ADR-085, v1-compat) | openapi ~line 1092 → launch override is **session-auth only** |
| MCP `run_launch` has **no** `flowId` param | `mcp/src/tools.ts` `run_launch.inputSchema` = `{taskId, runnerId, executorOverrideId, baseBranch, targetBranch}` |
| `runs/delegate` `target.flowId` is a **Phase-3 stub** (`CONFIG` "not yet supported") | `web/app/api/v1/ext/runs/delegate/route.ts:145-154` |
| Prior art for project-scoped ref lookup | `web/app/api/projects/[slug]/flow-packages/[flowRefId]/upgrade-preview/route.ts:40` — `and(eq(flows.projectId, …), eq(flows.flowRefId, …))` |

## Requirements

- **R1** — A `flowId` accepted from a request body MUST resolve when it equals
  either `flows.id` **or** `flows.flow_ref_id`, scoped to the acting project.
- **R2** — Matching MUST be **exact**; no prefix/fuzzy/case-insensitive matching.
- **R3** — Persistence MUST always store the resolved **UUID** (`tasks.flow_id`,
  `runs.flow_id`); a ref MUST NEVER reach the DB.
- **R4** — A UUID belonging to **another project** MUST NOT resolve
  (existence-hide; unchanged from today).
- **R5** — An unresolvable `flowId` MUST produce a **structured, self-correcting**
  error message naming: the field, the expected forms, the received value, and the
  project's valid refs.
- **R6** — Each call site MUST keep its **existing** error code — `CONFIG` for
  triage/task-create/update, `PRECONDITION` for launch. Codes MUST NOT change.
- **R7** — The existing **launchability/trust gate** (enabled + trusted +
  not pin-divergent) MUST still run, on the **resolved UUID**.
- **R8** — Resolution MUST be implemented **once** (DRY) and reused by every
  write path (SOLID: one reason to change; KISS: one query, no cache).
- **R9** — No DB migration, no new error code, no ext OpenAPI **type** change.

## Acceptance criteria

- **AC1** — The OpenAPI `verdict` and `verdict-enqueue` examples (`flowId: "bugfix"`)
  **execute successfully** against a project owning the `bugfix` flow → `200 {ok:true, triageStatus:"triaged"}`. *(The drift is closed.)*
- **AC2** — After a ref verdict, `tasks.flow_id` equals the flow's **UUID** (R3).
- **AC3** — A UUID verdict behaves exactly as before (no regression).
- **AC4** — An unknown ref → `422` whose message contains the received value **and**
  the project's valid refs (R5).
- **AC5** — Another project's UUID or ref → refused, not resolved (R4).
- **AC6** — A disabled/untrusted flow referenced **by ref** is still refused by the
  launchability gate (R7) — resolution MUST NOT bypass it.
- **AC7** — `ExtFlowSummary.id`/`ref` docs state that **either** may be passed as
  `ExtTriageBody.flowId`; no spec sentence contradicts the examples.
- **AC8** — Full suites green: `maister-web` unit+integration, `@maister/mcp`, `tsc`,
  scoped eslint; `pnpm validate:docs` clean; `npx @redocly/cli lint` reports **zero NEW
  problems vs the pinned baseline** (see T1.1 — 1 pre-existing error + 2 warnings live
  in the untouched experiments schema and are NOT in scope).

## Contract surfaces → spec file

| Surface | Spec/SSOT | Change |
| ------- | --------- | ------ |
| `ExtTriageBody.flowId` (~2492) | `docs/api/external/operations.openapi.yaml` | description → "flow UUID (`flows.id`) **or** the project's `flows.flow_ref_id`" |
| Triage route prose (~409, ~433) + 422 (~496) | same | note ref acceptance + the structured 422 detail |
| `ExtFlowSummary.id` / `.ref` (~2558-2566) | same | **fix contradiction** — either may be passed back |
| Task-create prose (~116) | same | "Validates that `flowId` belongs to the project" → UUID-or-ref |
| `ExtTaskDto.flowId` (~3008) | same | clarify: always the **resolved UUID** |
| `POST /api/v1/ext/runs` (~1092) | same | **no change** — correctly refuses `flowId` (ADR-085) |
| delegate / plan `target.flowId` | same | **no change** — Phase-3 stub |
| Triage domain behavior (`validateVerdictRefs` at line 184; Expectations ~229/233) | `docs/system-analytics/triage.md` | describe ref-or-UUID resolution; add a testable Expectation (R5a: normative, verbatim ids, ≤12 bullets) |
| ext facade contract | `docs/system-analytics/external-operations.md` | one Expectations bullet |
| MCP tool descriptions (in-code SSOT shipped to agents) | `mcp/src/tools.ts` — **`triage_set.flowId` + `task_create.flowId` ONLY** | "UUID or ref (e.g. `aif-bugfix`), as returned by `flow_list`" |
| Facade bundle | `mcp/dist/main.js` | rebuild — agents run the bundle, not source |
| Agent guidance | `../maister-plugins/.../triager.md` (~188) | **external repo**, separate commit |

### DB migrations — **NONE** (evidence-backed)

No column/table/index is added or altered. Resolution is **input-only**; every
stored `flow_id` is already a UUID, so there is **nothing to backfill and no
crash window**. The ref lookup is already index-backed by the existing
`flows_project_ref_uq (project_id, flow_ref_id)` unique index; `flows.id` is the
PK. Flows-per-project is single-digit, so no new index is warranted. → No
`_journal.json` entry, no snapshot, no ADR number to reserve.

## Phases

### Phase 1 — SPECS (SDD gate — no code before this is green)

- [x] **T1.1 — API contract.** `docs/api/external/operations.openapi.yaml`: apply
  every row of the table above marked as changing. Do **not** touch the runs-launch
  or delegate flowId prose. Keep `type: string` (R9).
  → verify: `npx @redocly/cli lint docs/api/external/operations.openapi.yaml` reports
  **zero NEW problems vs the pinned baseline**. "0 errors" is NOT achievable: the file
  carries 1 pre-existing error + 2 warnings, all in the **untouched** experiments
  schema — pinned by `{ruleId, pointer}`:
  `nullable-type-sibling` @ `#/components/schemas/ExtExperimentDTO/properties/verdict/nullable`;
  `no-unused-components` @ `#/components/schemas/ExtExperimentStatus`;
  `no-unused-components` @ `#/components/schemas/ExtExperimentRubric`.
  Do NOT fix the experiments schema here (R9 — unrelated section).
  The `verdict` examples stay unchanged (they become *true* in Phase 3, AC1).
- [x] **T1.2 — System analytics.** `docs/system-analytics/triage.md` — added ONE
  Expectation (resolution + UUID-persistence + structured refusal) tagged `(Designed)`,
  and amended the launchability bullet to state the gate runs on the **resolved** id, so
  a ref cannot bypass it (AC6). Flip `(Designed)` → `(Implemented)` at T3.5 (R6).
  **Corrections vs the original task:** (a) **no mirroring bullet** in
  `external-operations.md` — duplicating one contract across two docs violates **R7**;
  the wire contract is canonical in the OpenAPI (T1.1, per R3), the domain invariant in
  `triage.md`. (b) `triage.md:184` left **alone** — it is ADR-112 historical rationale
  ("today … only" describes the PRE-guard state), not a live contract statement;
  retrofitting it is out of scope (R9).
  **R5a cap note:** `triage.md` Expectations was already 14 bullets (and
  `external-operations.md` 18) — both pre-existing over the ≤12 cap; splitting those
  domains is not in this feature's scope.
  → verify: `pnpm validate:docs` green (4/4 mermaid); grep proves the bullet landed AND
  that `flow_ref_id` does NOT appear in `external-operations.md` (R7 respected).
- [x] **T1.3 — Spec consistency gate.** Audited every `flowId` sentence in the ext
  spec: none contradicts the `flowId: "bugfix"` examples (AC7 ✔). Traceability:
  R1/R3/R4/R5 → `ExtTriageBody.flowId` + task-create prose + the 422 description;
  R2 → `triage.md` Expectation ("exact match"); R7 → amended launchability bullet +
  the OpenAPI enablement/trust re-validation prose; R9 → verified `flowId` carries no
  `format: uuid` (type stayed `string`). R6's launch half (`PRECONDITION`) and R8 (DRY)
  are code-level, NOT wire contracts — correctly absent from the spec, tracked here.
  **Left alone (R9):** `RunDTO.flowId` (~3084) — a response echo of `runs.flow_id`;
  the ext runs route never accepts a ref (ADR-085), so it contradicts nothing.
  → verify: audit walked; AC7 satisfied.

### Phase 2 — Core primitive (TDD: RED → GREEN → refactor)

- [x] **T2.1 — RED.** `web/lib/flows/__tests__/resolve-flow-ref.test.ts`
  (**web integration project**, testcontainers). Exactly 5 non-overlapping cases —
  this is the ONLY place resolver edge cases are enumerated:
  1. UUID hit → returns the UUID (R1)
  2. ref hit → returns the UUID (R1 — the new capability)
  3. unknown string → miss, `validRefs` populated (R5)
  4. another project's UUID → miss (R4)
  5. another project's ref → miss (R4)
  *(No trivial tests: empty/absent `flowId` is already rejected by route zod
  `minLength(1)` / skipped by `!= null` — not re-tested here.)*
  → verify: `vitest list` confirms the runner glob matches; all 5 **fail**.
- [x] **T2.2 — GREEN.** `web/lib/flows/resolve-flow-ref.ts` — minimal code to pass:
  `resolveFlowRef(projectId, ref, db?): Promise<{ok:true; flowId:string} | {ok:false; detail:{field:"flowId"; expected:string; received:string; validRefs:string[]}}>`.
  One project-scoped query `WHERE project_id = ? AND (id = ? OR flow_ref_id = ?) LIMIT 1`
  (mirror the prior-art predicate); on miss, one query for the project's refs → `detail`.
  Plus `formatFlowRefError(detail): string`. DEBUG log on entry + hit/miss.
  → verify: 5/5 green; no other suite regresses.
- [x] **T2.3 — Refactor.** Names, JSDoc for the non-obvious WHY (ref/UUID namespaces
  cannot collide — see the unique constraint). No behavior change; stay green.
  → verify: suite still green; `tsc` clean.

### Phase 3 — Wire into the shared service layer (TDD per site)

> Each site: RED (its integration test) → GREEN (wire `resolveFlowRef`) → stay green.
> Service tests assert **wiring + persistence + error mapping ONLY** — they do
> not re-enumerate resolver cases (minimum overlap).

- [ ] **T3.1 — RED (all sites).** Add the failing integration tests:
  - triage (`web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/__tests__/route.integration.test.ts`): ref verdict → `triaged` + `tasks.flow_id` == UUID (AC1, AC2); unknown ref → 422 whose message carries received + validRefs (AC4); **ref → disabled/untrusted flow still refused** (AC6).
  - task-create (mirror the existing ext tasks integration test): ref → `tasks.flow_id` == UUID.
  - task-update: ref → the **written** value is the UUID (guards the throwaway-patch trap below).
  - launch (**web session-auth only** — ext refuses flowId per ADR-085): ref override resolves; unknown ref → `PRECONDITION` (R6).
  → verify: each new test fails for the right reason.
- [ ] **T3.2 — GREEN: triage.** `web/lib/services/triage.ts` `validateVerdictRefs` —
  resolve `patch.flowId` at entry; miss → `CONFIG` + `formatFlowRefError`; hit → the
  launchability/trust gate runs on the resolved UUID (R7).
  **Trap:** `updateTask` (`tasks.ts:440`) validates a *throwaway* `verdictPatch(input)`
  and writes `input.flowId` separately — in-place mutation would NOT reach the write.
  Return/assign the resolved UUID explicitly at each of the three callers (ext triage
  route, `updateTaskVerdict`, `updateTask`).
  → verify: triage + task-update tests green.
- [ ] **T3.3 — GREEN: task create/update.** `web/lib/services/tasks.ts` — resolve
  before write; `createTask`'s existing `flows.id` existence check is **replaced** by
  the resolver (DRY — one resolution path, R8).
  → verify: task-create test green.
- [ ] **T3.4 — GREEN: run launch (web-only).** `web/lib/services/runs.ts` `launchRun`
  (~717) — resolve the `input.flowId` **override** before the `eq(flows.id, …)` lookup;
  `task.flowId` is already a UUID; miss → keep `PRECONDITION` (R6). Scope note: only
  the session-auth `POST /api/runs` supplies `flowId`.
  → verify: launch test green.
- [ ] **T3.5 — Refactor + status flip.** Remove duplication across the four sites
  (DRY); flip the Phase-1 `(Designed)` tags to `(Implemented)` (R6).
  → verify: web unit + integration green.

### Phase 4 — MCP surface + agent guidance

- [ ] **T4.1 — Tool descriptions.** `mcp/src/tools.ts`: **`triage_set.flowId` and
  `task_create.flowId` ONLY** → "flow UUID or ref (e.g. `aif-bugfix`), as returned by
  `flow_list`". **Do NOT touch `run_launch`** (no `flowId` param) **or `delegate`** (stub).
  → verify: T4.2 green.
- [ ] **T4.2 — MCP tests.** `mcp/src/__tests__/tools.test.ts` / `tool-contract.test.ts`:
  the two descriptions mention "ref"; routing unchanged (the facade forwards the string;
  the web service resolves). Runner: **mcp unit project**.
  → verify: `pnpm --filter @maister/mcp test` green.
- [ ] **T4.3 — Rebuild facade bundle.** `pnpm --filter @maister/mcp build`; grep the new
  description text in `mcp/dist/main.js` (agents run the bundle, not source).
  → verify: bundle carries the text.
- [ ] **T4.4 — Triager guidance** (external repo `maister-plugins`, separate commit):
  `packages/core/maister-agents/triager.md` ~188 — note the ref is accepted.
  → verify: owner-visible; this repo's tree untouched.

### Phase 5 — Verification

- [ ] **T5.1 — Gates.** web unit+integration, mcp suite, `tsc --noEmit` (both), scoped
  check-only eslint on touched files, `pnpm validate:docs`, `redocly lint`.
  → verify: AC8 green.
- [ ] **T5.2 — Spec↔code conformance (AC1).** Execute the OpenAPI `verdict` example
  verbatim (`flowId: "bugfix"`) against a project owning `bugfix` → `200 triaged`,
  `tasks.flow_id` == UUID. The drift is closed.
  → verify: observed.

## Commit Plan (checkpoints)

1. **Phase 1** → `docs(api,analytics): flowId accepts uuid or ref (spec-first)`
2. **Phase 2** → `feat(flows): resolveFlowRef primitive + tests`
3. **Phase 3** → `feat(flows): resolve flowId ref across triage/task/launch services`
4. **Phase 4** → `feat(mcp): triage_set/task_create flowId accept ref + rebuild bundle`
5. **Phase 5** → verification only (no commit)

Integration: rebase onto `main`, owner FF-merges. Ask before push.
**Do not amend or rewrite existing `main` commits** (incl. `b95add686`) — this
branch's own plan commit may be amended freely.

## Non-goals

- No fuzzy/prefix/case-insensitive matching (R2).
- No migration, no new error code, no ext OpenAPI type change (R9).
- No ref support on ext run-launch (ADR-085 refuses `flowId` there) or delegate (stub).
- No `MaisterError.details` field — the structured detail rides in `message` (owner-chosen).
