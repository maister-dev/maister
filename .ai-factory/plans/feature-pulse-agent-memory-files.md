# Implementation Plan: Pulse Follow-ups + Agent Memory Files v1

Branch: `feature/pulse-agent-memory-files` (forked at `78abc67b3`, == `main`)
Created: 2026-07-27 · Refined: 2026-07-27 (`/aif-improve` — SDD restructure + TDD cut + 5 blocking-hole fixes)

## Settings

- Testing: **TDD** — every behavioral slice goes RED → GREEN → REFACTOR. Unit + integration (real PG via Testcontainers for DB paths, tmp dirs for FS) + contract/drift guards.
- Logging: verbose (DEBUG-level flow logs, pino, `LOG_LEVEL`-driven)
- Docs: **specs first** — Phase 0 is the source of truth every later phase implements against.

## Roadmap Linkage

Milestone: "none"
Rationale: the assistant-loop surface has no ROADMAP milestone; this plan stands on **ADR-152**. `/aif-plan` does not own `ROADMAP.md` — add an M49 entry later via `/aif-roadmap` if the assistant loop becomes a tracked milestone.

## Reserved numbers (allocated from `main` HEAD, per skill-context rule)

| Artifact | Reserved | Basis |
| --- | --- | --- |
| ADR | **ADR-152** | `max(### ADR-NNN)` at `main` = 151 (ADR-151, agent mentions) |
| Migration | **`0122_agent_memory_files`** | `max(idx)` in `web/lib/db/migrations/meta/_journal.json` at `main` = 121 (`0121_agent_mention_summons`) |

Both are a **globally sequential shared namespace**. Owner confirmed (2026-07-27) **no parallel branch is holding these numbers**, so no renumber pass is budgeted. Standing hygiene still applies: if this branch is ever rebased after a sibling merges, re-derive both maxima from `main` HEAD and grep prose forms (`pre-0122`, `since ADR-152`) before trusting them. A migration is a **triple** — `.sql` + `_journal.json` entry + `meta/0122_snapshot.json`; verify the newest journal entry has a matching snapshot (a missing snapshot silently starves future `db:generate`) and that `_journal.json` `when` stays **monotonically increasing** after any rebase (non-monotonic `when` ⇒ `db:migrate` silently skips).

**`0122` carries TWO additive columns** (owner-confirmed 2026-07-27, see D23): `agent_project_links.memory_enabled` and `runs.agent_memory_hash`. One migration, one triple, two ERD entities.

---

## §1 · Verified baseline (read from source on this branch — supersedes the request's premises where they differ)

| # | Fact | Source of truth |
| --- | --- | --- |
| V1 | `ActivityPulseResponse = { happened{items,nextCursor,hasMore}, now{generatedAt,runs}, needsYou{generatedAt,items} }` | `web/lib/ext-activity/types.ts:125` |
| V2 | `NeedsYouItem.hitlRequestId: string` (non-null) | `web/lib/ext-activity/types.ts:90` |
| V3 | Pulse assembly entry point `getActivityPulse(projectId, {since,salience,now?,client?})` `service.ts:334`; wire shape produced by `serializePulseResponse()` `service.ts:469` | `web/lib/ext-activity/service.ts` |
| V4 | `ACTIVE_PULSE_RUN_STATUSES = ["Running","NeedsInput","NeedsInputIdle","HumanWorking"]` — **`Review` is NOT in `now.runs`** | `web/lib/ext-activity/service.ts` |
| V5 | `needsYouCount` is **not a wire field** — it exists only in the route's `log.debug` line | `web/app/api/v1/ext/activity/route.ts:63` |
| V6 | `computeReadinessByRun(client, runIds): Promise<Map<string, ReadinessState>>` — **4 batched `inArray` queries total, no N+1**, shared verbatim by board/portfolio/project read models, same contributions as the merge guard | `web/lib/queries/readiness-batch.ts:36` |
| V7 | `getRunReadiness()` (behind `readiness_get`) is `5 + 2×externalGates + 1×requiredArtifactDefs` queries — **must not** be looped per run | `web/lib/queries/readiness.ts` |
| V8 | `ReadinessState = "ready" \| "blocked" \| "stale" \| "failed" \| "waiting" \| "overridden"` | `web/lib/flows/graph/readiness-core.ts:85` |
| V9 | The auto-promotion lane's green test is `assertEvidenceReady(runId,"review",db)` not throwing | `web/lib/auto-promotion/readers.ts:123` |
| **V10ʹ** | **⚠ CORRECTED.** `promoteRun`'s `promotionHold` and `isLaunchedLineageRun` refusals are **conditional on unattended attribution**: `isUnattendedPromotion(input) = input.autoOnReady === true \|\| input.attribution?.source === "auto_promotion"` gates the lineage guard, and `attribution?.source === "auto_promotion"` alone gates the hold check. The code comment is verbatim: *"Only HUMAN promotes set neither flag, so they are allowed."* A human/assistant promote of a held or launched-lineage run **succeeds**. Only the `status='Review'` CAS is unconditional. | `web/lib/runs/promote.ts:125,575,623` |
| V11 | **The summonability predicate already exists**: `listMentionCandidateAgents(dbOrTx, projectId): Promise<MentionableAgent[]>` → `{id, stem, name, summonable}` | `web/lib/agents/summonability.ts:46` |
| V12 | `summonable` = 5 conjuncts: link `enabled` ∧ `agents.enabled` ∧ `quarantinedAt === null` ∧ `agents.triggers` includes `"domain_event"` ∧ an enabled `agent_schedules` mention row exists | `web/lib/agents/summonability.ts:111-116` |
| V13 | **⚠ The request's premise is wrong**: the qualified agent id is **`<packageName>:<stem>`**, not `<flowRefId>:<stem>` — `stem = row.id.slice(row.packageName.length + 1)` | `web/lib/agents/summonability.ts:108-109` |
| V14 | **⚠ Never join `agents` × `agent_project_links` × `agent_schedules`** — all three carry columns named `id` and `enabled`; under this repo's dual drizzle-orm peer-dep variants a multi-table select **mis-maps them in the APP runtime only** (tests pass). Use flat single-table reads. | `web/lib/agents/summonability.ts:52-58` |
| V15 | The prompt-composition seam is `buildAgentPrompt(_db, parsed, run): Promise<string>` — `sections = [persona, scopeBlock, configBlock, taskBlock, commentTriggerBlock, triggerContextBlock]` | `web/lib/agents/launch.ts:1712` |
| V16 | Launch site: `const basePrompt = await buildAgentPrompt(...); const prompt = opts.overridePrompt ?? (draftPayload ? consensusAgentDraftPrompt(basePrompt, …) : basePrompt)` — **`overridePrompt` discards `basePrompt` entirely** | `web/lib/agents/launch.ts:3103-3108` |
| V17 | `issueAgentRunToken({agentId, projectId, runId, db})` mints the per-launch ephemeral token | `web/lib/agents/launch.ts:3110` |
| V18 | `TokenActor = { tokenId, projectId, tokenKind, ownerUserId, agentId, actorLabel, scopes, boundRunId }` — `boundRunId` is derived **server-side** from the token name `agent-run:<id>` | `web/lib/tokens/verify.ts:42` |
| V19 | `agent_project_links` columns: `id, agent_id, project_id, enabled, runner_override_id, branch_base, execution_policy_override, config, can_read_brain, can_write_brain, schedules_revision, created_at, updated_at`; UNIQUE `(agent_id, project_id)` | `web/lib/db/schema.ts:923` |
| V20 | The attachment UI is ONE aggregating `PATCH /api/projects/{slug}/agents/{agentId}` (partial body, one transaction); panel = `agents-attach-panel.tsx`, modal = `agents-attach-edit-modal.tsx` | `docs/screens/projects/project-settings-agents.md` |
| V21 | Ext error mapping: `CONFIG`→422, `CONFLICT`/`PRECONDITION`→409, explicit `forbidden()`→403. **No new `MaisterError` code is needed.** | `web/lib/tokens/ext-handler.ts:119` |
| V22 | Drift guard `mcp/src/__tests__/tool-contract.test.ts` asserts a **bijection** `TOOL_OP` keys ≡ `TOOL_SPECS` keys, plus properties ≡ path∪query∪body params, `required` set equality, base types, enums, and bounds — anchored on `docs/api/external/operations.openapi.yaml` | `mcp/src/__tests__/tool-contract.test.ts` |
| V23 | `web` runs on the **host** (ADR-023); the default compose is Postgres-only. New env vars are **host/service-env only** — `.env.example` + the `docs/configuration.md` table, **never** a compose var. | `docs/configuration.md`, ADR-023 |
| V24 | `docs/system-analytics/agents.md` Expectations already holds **21 bullets** (over the R5a cap of 12) — pre-existing; do **not** refactor it (docs R9, surgical edits) | `docs/system-analytics/agents.md` |
| V25 | **⚠ The request mis-cites ADR-133.** `### ADR-133` is *"Versioned read-only evidence and run-owned package materialization"* — unrelated. The agent-definition frontmatter schema is `agentDefinitionFrontmatterSchema` (lineage ADR-089 / ADR-106 / ADR-111 / ADR-151). Cite the symbol, not ADR-133. | `docs/decisions.md:11654`, `web/lib/agents/definition.ts:267` |
| V26 | That schema is **`.strict()`** — unknown frontmatter keys are *refused*, not ignored. A package shipping `memory:` fails to parse on a platform without T17. `renderAgentDefinition()` (`definition.ts:447`) is the round-trip renderer, and it **self-validates by calling `parseAgentDefinition` on its own output**, so a field added to the schema but not the renderer is silently dropped rather than caught. | `web/lib/agents/definition.ts:267,447,473` |
| V27 | Attach prefill from `recommended` is **client-side** — `rowFromAvailable(agent)` at `agents-attach-panel.tsx:395` seeds the modal, which then saves via `PATCH`. The service `attachAgent({projectId, agentId, enabled?, runnerOverrideId?})` accepts **none** of the other fields, so a direct `POST` bypasses every prefill. | `web/lib/agents/project-links.ts:264`, `web/components/board/panels/agents-attach-panel.tsx:395` |
| V28 | **⚠ i18n namespace is `agentsAttach`** (52 keys, EN ≡ RU — verified by parse), not `projectSettings.agents` — `projectSettings` does **not exist** in either catalog. The screen doc's claim is stale; code wins (docs/CLAUDE.md). | `web/messages/{en,ru}.json`, vs. `docs/screens/projects/project-settings-agents.md:166` |
| V29 | `atomicWriteText(path, data)` (mkdir -p → tmp → rename, unlink on failure) is the text sibling of `atomicWriteJson`. Run-dir path: `runDirPath(runtimeRoot, projectSlug, runId)` exported at `mutation-check.ts:207`; `runtimeRoot()` re-exported from `instance-config.ts`. | `web/lib/atomic.ts`, `web/lib/flows/graph/mutation-check.ts:207` |
| V30 | **⚠ A flow-bound agent gets no memory.** When the effective definition declares `flow:`, `launchAgentRun` diverts to `launchAgentDrivenFlowRun` (`launch.ts:939`), producing a `run_kind='flow'` run that never reaches `startAgentSession` / `buildAgentPrompt`. | `web/lib/agents/launch.ts:939-941` |
| V31 | `revokeAgentProjectTokens` fires on both **disable** (`updateAgentLink` with `enabled:false`) and **detach** — so a disabled/detached attachment's ephemeral tokens die at the token layer too (defense in depth under the memory-write gate). | `web/lib/agents/project-links.ts:326,609` |
| V32 | Launch-time gate `loadAgentContext` throws `AgentLaunchError` with 10 `AgentLaunchErrorKind` values, all carrying `MaisterError` code `PRECONDITION`; four of them (`not_attached`, `disabled`, `quarantined`, `trigger_missing`) correspond to D9's block reasons. | `web/lib/agents/launch.ts:221,310` |
| V33 | **`isPhaseReady(state) = state === "ready" \|\| state === "overridden"` already exists and is exported**, commented *"A run may promote when its readiness is 'ready' or 'overridden'"*. `assertEvidenceReady` agrees: it throws only when `contribution !== "clear" && contribution !== "overridden"`. `overridden` outranks `ready` in `READINESS_PRIORITY` (index 4 vs 5; lowest index wins), so a run with one waived gate rolls up to `overridden` — a `state === "ready"` test would **silently drop genuinely promotable runs**. | `web/lib/flows/graph/readiness-core.ts:103,209`, `evidence-readiness.ts:184-188` |
| V34 | **Nothing validates HTTP responses against the OpenAPI spec.** `scripts/validate-contracts.mjs` is a static YAML/`$ref` linter; `mcp/src/__tests__/tool-contract.test.ts` compares tool **inputSchema** against request params. Spec and server ship in the same commit. There is **no** contract test at all for `docs/api/web.openapi.yaml`. | `scripts/validate-contracts.mjs`, `mcp/src/__tests__/tool-contract.test.ts` |
| **V35** | **`getActivityPulse` has no `Promise.all` over `listProjectNeedsYou`.** It `await`s it sequentially at the top (`service.ts:334`), then the events queries, then `Promise.all(activeRuns.map(buildRunSnapshot))`. `needsYou` is a **required input** to `buildRunSnapshot`, so it cannot move past the snapshot loop — the parallel fetch must be *introduced*, with `needsYou` still threaded in. | `web/lib/ext-activity/service.ts:334,400` |
| **V36** | **`runs` has NO memory/hash column.** Its snapshot-class columns are `runner_snapshot` (jsonb, read by resume/recover) and `resolved_prompt` (text). The run dir `.maister/<slug>/runs/<run-id>/` is GC'd for terminal runs older than 7d, so a snapshot **file** is not a durable provenance record. | `web/lib/db/schema.ts:1685+,3249,4139` |
| **V37** | `resolveProjectAction(scope) = PROJECT_ACTION_BY_SCOPE[scope] ?? "readBoard"` — an **unmapped scope silently resolves to the viewer-level action**. `ProjectAction = keyof typeof PROJECT_ACTION_MIN` (`authz.ts:44,82`); the map has no agent-memory member. `memory:write → writeBrain` (`member`) is the closest sibling. | `web/lib/tokens/ext-handler.ts:84,112`, `web/lib/authz.ts:44,82` |
| **V38** | `resolveEffectiveAgentDefinition` is **already imported into** `web/lib/agents/project-links.ts` (line 11) and used at line 383 — so `attachAgent` can read the effective definition with no new import cycle. `assertAgentPackageAttachable` (called earlier in `attachAgent`) is what guarantees the project pin exists; a definition read placed *before* it would throw on an unpinned package with the wrong error. | `web/lib/agents/project-links.ts:11,290,383` |
| **V39** | `runs.review_entered_at` exists (`timestamp`, nullable) — the real source for `inReviewSince`. `runs` has **no** `target_branch`; it lives on `workspaces.target_branch` (nullable) and `tasks.target_branch` (nullable). | `web/lib/db/schema.ts:1880,3456,1390` |
| **V40** | `resolveRouting` (`mcp/src/tools.ts:717`) IS the arg→HTTP switch called by `dispatchTool` (line 629) — there is no separate dispatch arm. `coerceNumericArgs` (line 687) handles string-typed numerics; a tool with only string args needs nothing from it. Every existing MAIster facade tool takes a required `slug`, and `buildAgentPrompt`'s project-scope block instructs the agent to *always pass it*; `dispatchTool` **silently drops** args absent from the routing arm. | `mcp/src/tools.ts:629,687,717`, `web/lib/agents/launch.ts:1700` |
| **V41** | Vitest projects: `unit` = `lib/**/*.test.ts` + `app/**/__tests__/**/*.test.ts` + … , **excluding** `**/*.integration.test.ts`; `integration` = `lib/**/*.integration.test.ts` + `app/**/*.integration.test.ts` + …, `testTimeout: 60_000`. Bracketed route dirs (`app/api/…/[slug]/…`) are already globbed today. Precedent for the DB-integration suffix: `web/lib/ext-activity/__tests__/pulse.db.integration.test.ts`. | `web/vitest.workspace.ts:46-96` |

---

## §2 · Requirements (SDD — the contract implementation must satisfy)

Each requirement has: a normative statement, **testable** acceptance criteria, the spec artifact that publishes it, and the test that proves it. `/aif-verify` re-derives §5's matrix from the diff.

### A · Assistant pulse — promotion readiness

**REQ-A1 — `promotable` is a required, always-emitted sibling of `needsYou.items`.**
AC1: `GET /api/v1/ext/activity` responses always contain `needsYou.promotable`; when nothing qualifies it is `[]`, never omitted and never `null`.
AC2: `NeedsYouItem` is unchanged — no discriminated union, no widened field.
AC3: Each item carries exactly `{runId, taskId, taskKey, taskTitle, targetBranch, readiness, inReviewSince}`; `targetBranch` is `workspaces.target_branch` (nullable — `null` means "resolved from task/project default at promote time"); `inReviewSince` is `runs.review_entered_at` serialized ISO.
Spec: `ExtActivityNeedsYouBlock` + `ExtPromotionReadyItem` in `docs/api/external/operations.openapi.yaml`; `docs/system-analytics/assistant-activity.md`.

**REQ-A2 — The promotable set is an allow-list with two named layers.**
AC1 (*mechanical*): a run qualifies only when `run_kind = 'flow'` ∧ `status = 'Review'` ∧ `isPhaseReady(computeReadinessByRun(...).get(runId))`.
AC2 (*operator-intent suppression*): a mechanically-qualifying run is still excluded when `runs.promotion_hold IS NOT NULL` **or** `isLaunchedLineageRun(runId)`. ⚠ **Corrected during T6 (2026-07-27):** `runs.promotion_hold` is a **`jsonb`** column typed `PromotionHold | null` (`schema.ts:1874`), NOT a boolean — the original `IS NOT TRUE` spelling is a Postgres type error (`argument of IS NOT TRUE must be type boolean`). `promoteRun` itself tests plain truthiness of the parsed value (`if (liveRun.promotionHold)`, `promote.ts:623`), so presence IS the hold. Use `isNull(runs.promotionHold)` in Drizzle; never a `::boolean` cast (skill-context: non-throwing predicates only). Per V10ʹ this is a **deliberate divergence** from what a human `promoteRun` would accept — the assistant must not recommend an action an operator has held or a study still owns.
AC3: the status/kind admission set is an exported named const; an unrecognized `runs.status` is **rejected by default** (allow-list, never `!terminal`).
AC4: ordering is deterministic — `inReviewSince` ascending, `runId` ascending as tiebreak.
Spec: `docs/system-analytics/assistant-activity.md` Expectations; ADR-152.

**REQ-A3 — Readiness for the pulse is bulk-computed.**
AC1: exactly one `computeReadinessByRun` call per pulse request, over the candidate id set.
AC2: `getRunReadiness` is never reachable from the pulse path.
Spec: `docs/system-analytics/readiness.md` Expectations (existing no-N+1 bullet extended to name the pulse).

**REQ-A4 — No cross-block duplication.**
AC1: a promotable run never appears in `now.runs` (structurally guaranteed by V4, asserted anyway).
AC2: a promotable run never appears in `needsYou.items` (a `Review` run with an unanswered review-gate HITL classifies `waiting`/`blocked`, so it fails REQ-A2 AC1).
Spec: `assistant-activity.md` Expectations (mirrors the existing frozen no-duplication rule).

**REQ-A5 — Replay is unaffected.**
AC1: for a fixed `since`, the serialized `happened` block is **byte-identical** with and without promotable rows present.
AC2: `nextCursor` is unchanged by the new blocks.
Spec: `assistant-activity.md` Expectations.

**REQ-A6 — The batched classifier and the merge guard agree on the mechanical layer.**
AC1: across **all six** `ReadinessState` values, `isPhaseReady(computeReadinessByRun→state)` ⟺ `assertEvidenceReady(runId,'review',db)` does not throw.
AC2: the `overridden` case is explicitly covered (this is the case a `state === 'ready'` comparison would have lost).
Spec: ADR-152 rationale; `assistant-activity.md` Expectations.

### B · Assistant pulse — summonable-agent metadata

**REQ-B1 — `agents` is a required top-level block.**
AC1: response carries `agents: {generatedAt, items}` at top level, shaped identically to `now`/`needsYou`; `items` is `[]` when nothing is attached, never omitted.
Spec: `ExtActivityPulseResponse` + `ExtActivityAgentsBlock` + `ExtPulseAgentItem`.

**REQ-B2 — `agents` reports exactly the attached set; non-summonable agents are reported, never filtered.**
AC1: item count ≡ `agent_project_links` row count for the project.
AC2: each item is `{agentId, stem, displayName, enabled, summonable, summonBlockedReason}`, where `enabled` is the **attachment** axis (`agent_project_links.enabled`).
Spec: `assistant-activity.md`; mirrors the mention-chip contract in `agent-mentions.md`.

**REQ-B3 — One predicate, one spelling.**
AC1: `summonable` is derived as `blockedReason === null` inside `listMentionCandidateAgents`; no second spelling of the five conjuncts exists anywhere.
AC2: existing consumers (`social/mentions.ts`, `social/comments.ts`, `queries/task-detail.ts`) compile and pass unchanged — the field is purely additive.
AC3: the resolver keeps **three flat single-table reads** (V14); a join is a defect, not an optimization.
Spec: ADR-152; `docs/system-analytics/agent-mentions.md` cross-link.

**REQ-B4 — Block reasons are a closed enum with deterministic precedence.**
AC1: `SummonBlockedReason ∈ {link_disabled, agent_disabled, quarantined, trigger_missing, mention_binding_missing}`, precedence in that order.
AC2: with N conjuncts failing simultaneously, the reported reason is the highest-precedence one — deterministically, not incidentally.
AC3: `summonBlockedReason === null` ⟺ `summonable === true`.
Spec: OpenAPI enum on `ExtPulseAgentItem.summonBlockedReason`; `assistant-activity.md`.

### C · Agent memory files

**REQ-C1 — Memory is a per-attachment axis, independent of Brain.**
AC1: `agent_project_links.memory_enabled boolean NOT NULL DEFAULT false`.
AC2: no code path lets `can_read_brain`/`can_write_brain` imply `memory_enabled` or vice versa.
AC3: the `agent_memory:write` **token scope** and the `memory_enabled` **link flag** must both pass; neither alone authorizes a write.
Spec: `docs/db/agents-domain.md` ERD + `docs/database-schema.md`; `docs/system-analytics/agent-memory.md`.

**REQ-C2 — `memory: none | enabled` is a first-class definition field with a server-side attach default.**
AC1: `agentDefinitionFrontmatterSchema` accepts `memory`, default `none`; a package shipping `memory: enabled` parses (today it is refused — the schema is `.strict()`, V26).
AC2: `renderAgentDefinition()` round-trips the field byte-identically (V26: the renderer self-validates, so a missing render branch *drops* the field silently rather than erroring).
AC3: a bare `POST /api/projects/{slug}/agents` attach with **no follow-up `PATCH`** lands `memory_enabled = true` for a definition declaring `memory: enabled` (V27 — client prefill alone is bypassable).
AC4: the attachment value is **effective** — a package upgrade never re-enables memory an operator turned off.
AC5: the Studio frontmatter editor preserves the field across an edit (its `editRecommended` mutator rebuilds from known sub-fields).
Spec: `docs/system-analytics/agents.md` definition-field list; `agent-memory.md`.

**REQ-C3 — Path derivation is injective and confined.**
AC1: `.maister/<project-slug>/agents/<enc(packageName)>/<enc(stem)>/memory.md`, split on the id's own first `:` (the real id is `<packageName>:<stem>`, V13).
AC2: `enc` keeps `[A-Za-z0-9._-]` verbatim, rewrites every other byte as `%XX` (uppercase hex); a component encoding to `.` or `..` is refused.
AC3: **no two distinct qualified ids map to the same path** — collisions are impossible by construction, not merely improbable.
AC4: every derived path stays inside the project's `agents/` subtree.
AC5: an id with no `:` is a `CONFIG` refusal, never a silent single-level fallback.
AC6: keyed by qualified id and **never** by revision — package re-pin/upgrade preserves the file.
Spec: `agent-memory.md` Domain entities + Edge cases; ADR-152 (injectivity argument).

**REQ-C4 — Launch injects memory at a defined position, for agent runs only.**
AC1: prompt section order becomes persona → scope → config → **memory** → task → commentTrigger → trigger.
AC2: injection is gated on `run_kind = 'agent'`; a flow-bound agent (V30) never reaches the seam and receives no memory.
AC3: resolution + snapshot happen at the **launch site**, not inside `buildAgentPrompt` — `opts.overridePrompt` discards `basePrompt` wholesale (V16), so an inside-`buildAgentPrompt` resolution would stamp provenance for a launch that injected nothing.
AC4: injection happens at **initial spawn only**; a `session/resume` carries it in restored context.
AC5: the injected block carries the standard maintenance instruction (keep current; compact near the cap; link tasks as `KEY-N`; this file is the agent's only durable cross-run memory; `memory_recall` remains the unchanged on-demand Project Brain query).
Spec: `agent-memory.md` Process flows; ADR-152 D12/D13/D14.

**REQ-C5 — Degradation never blocks a launch.**
AC1: memory disabled / file absent / unreadable / over-cap ⇒ **no** MEMORY section and the launch proceeds normally.
AC2: unreadable and over-cap each emit a `log.warn` naming **which** failure occurred.
AC3: no degradation path throws.
Spec: `agent-memory.md` State machine (`absent → present → over_cap|unreadable → degraded`) + Edge cases.

**REQ-C6 — Every memory-injecting launch is provenance-recorded.**
AC1: `memory-snapshot.md` is written into `runDirPath(runtimeRoot(), projectSlug, runId)` via `atomicWriteText`.
AC2: the content hash is stamped on `runs.agent_memory_hash` — durable past the 7-day run-dir GC (V36).
AC3: a launch taking the `overridePrompt` branch writes **neither** (D12).
Spec: `agent-memory.md`; `database-schema.md`.

**REQ-C7 — The agent writes through a content-hash CAS.**
AC1: `POST /api/v1/ext/agent/memory` body is `{content, ifHash}` only; `ifHash === null` is the first-writer form (an absent file hashes to `null`).
AC2: a stale `ifHash` returns **409 `CONFLICT`** whose body carries the current `{content, hash}` so the agent can merge and retry.
AC3: ordering is read-current → compare CAS → atomic write → return the **post-write** hash.
AC4: two concurrent writers leave the file containing **exactly** one writer's bytes — no interleaving, no partial write.
AC5: the MCP tool `agent_memory_write` mirrors the route exactly and passes the `TOOL_SPECS`↔OpenAPI bijection guard (V22).
Spec: `extAgentMemoryGet`/`extAgentMemoryWrite` ops; `agent-memory.md` Process flows.

**REQ-C8 — The write path fails closed on every authorization axis.**

| Condition | Response |
| --- | --- |
| `actor.tokenKind !== "agent"` or `actor.agentId` null | 403 `UNAUTHORIZED` |
| no `agent_project_links` row (detached) | 403 `UNAUTHORIZED` |
| `memory_enabled = false` | 403 `UNAUTHORIZED` |
| token lacks `agent_memory:write` | 403 (scope enforcement, `handleExt` default) |
| `content.length > agentMemoryMaxChars()` | 422 `MaisterError("CONFIG")` |
| `ifHash` ≠ current on-disk hash | 409 `MaisterError("CONFLICT")` + current `{content, hash}` |
| ok | 200 `{content, hash, sizeChars, updatedAt}` |

AC1: **every** identifier is `auth-context` or `server-state` — zero `body-controlled` locators (no `slug` path segment, no `agentId`/`runId` in the body).
AC2: the scope resolves to a **named** `ProjectAction`, never the `readBoard` fallback (V37).
AC3: the write targets `.maister/<slug>/agents/…`, never the worktree — so it works in **every** workspace mode including `none`, and the L1–L3 read-only enforcement contour is untouched.
Spec: OpenAPI responses; `agent-memory.md` Expectations; ADR-152 D15/D16.

**REQ-C9 — The owner can see and control memory.**
AC1: `GET | PUT | DELETE /api/projects/{slug}/agents/{agentId}/memory`; `PUT` carries `ifHash` — **CAS applies to the human too** (a blind human Save would clobber a concurrent agent write).
AC2: `DELETE` clears the file and is idempotent when already absent.
AC3: `memoryEnabled` is threaded through the **existing** aggregating `PATCH /api/projects/{slug}/agents/{agentId}` — one transaction, never a new per-field route (V20).
AC4: UI: a `mem` chip in the axes cluster, a memory action in the row cluster, a portaled drawer (not the 520–760px form modal — this is a 32k-char document), a live `sizeChars / max` indicator, and a Memory toggle in the modal labelled as a **separate axis** from `canWriteBrain`.
AC5: for a flow-bound agent the toggle renders **disabled with its reason shown** (V30) — never hidden, never silently inert.
AC6: EN + RU key-set parity under the **`agentsAttach`** namespace (V28).
Spec: `docs/api/web.openapi.yaml`; `docs/screens/projects/project-settings-agents.md`.

**REQ-C10 — Attachment lifecycle semantics.**
AC1: detach (`DELETE` of the link row) makes memory inert — no injection, write refused — while the **file survives untouched**.
AC2: re-attach revives the file and re-applies the definition default, so re-attaching an agent whose definition says `memory: none` revives the file but leaves it inert. Correct by construction, non-obvious, therefore a documented Edge case.
AC3: package re-pin/upgrade preserves the file (REQ-C3 AC6).
Spec: `agent-memory.md` Edge cases; ADR-152 D19.

**REQ-C11 — The cap is configurable, character-denominated, and enforced at both ends.**
AC1: `MAISTER_AGENT_MEMORY_MAX_CHARS`, default `32768` **characters** (matching the `MAX_CONTENT_CHARS = 32_000` brain-route precedent and reasoning in prompt-budget units).
AC2: invalid / non-positive ⇒ default + one-time WARN (the `positiveIntFromEnv` convention).
AC3: over-cap on **write** refuses `CONFIG` (422); over-cap on **read** degrades (REQ-C5).
AC4: host/service-env only per ADR-023 — `.env.example` + `docs/configuration.md`, **never** a compose var (V23).
Spec: `docs/configuration.md` env table (canonical); `.env.example`.

**REQ-C12 — Memory content is never exposed in the pulse.**
AC1: no pulse block carries memory content, size, or hash.
Spec: `assistant-activity.md` (reinforces the existing "no file contents" Expectation).

---

## §3 · Decisions (locked before implementation)

**D1 — `needsYou.promotable` is a parallel list, not a widened `NeedsYouItem`.**
`NeedsYouItem.hitlRequestId` is non-null (V2) and every consumer types it so. A discriminated union would break every existing reader. `needsYou` gains a sibling array.

**D2 — `agents` is a top-level block, not `meta.agents`.**
The response's frozen contract is "one block per semantic class, section boundary makes persisted-vs-synthesized obvious". A 4th top-level synthesized block shaped `{generatedAt, items}` is consistent; `meta.*` introduces a new nesting concept for no gain.

**D3 — Both new fields are REQUIRED and always emitted (`[]` when empty). No compatibility shim.** *(owner-confirmed)*
Mirrors the existing frozen rule "`needsYou.items` is `[]`, not omitted". The `additionalProperties: false` on the response schemas costs nothing: **nothing validates responses against the spec** (V34), spec and server ship in one commit, and no external consumer is pinned to a v1 copy.

**D4 — `needsYouCount` stays HITL-only; add sibling `promotableCount` / `agentCount` / `summonableCount` log fields.**
`needsYouCount` is a `log.debug` field, not wire (V5). Inflating it would silently change the meaning of an existing telemetry series.

**D5ʹ — "Promotable" is a TWO-LAYER predicate, and the second layer is a deliberate divergence.** *(corrected 2026-07-27 — the original D5 was falsified by V10ʹ)*
The original text claimed the predicate equals "what `promoteRun` would accept". **It does not**, and could not: `promoteRun` refuses on `promotionHold` only for `attribution.source === "auto_promotion"`, and on launched lineage only for `isUnattendedPromotion` — *"Only HUMAN promotes set neither flag, so they are allowed."* A held, green, `Review` run **is** human-promotable.
The honest predicate is:
- **Layer 1 — mechanical acceptance.** `run_kind='flow'` ∧ `status='Review'` ∧ `isPhaseReady(...)`. This layer *is* provably equivalent to the merge guard (REQ-A6) and is what `promoteRun` unconditionally enforces (the `status='Review'` CAS + readiness).
- **Layer 2 — operator-intent suppression.** `promotion_hold` and launched lineage exclude the run from the **recommendation** even though a human promote would succeed. Rationale: a hold means an operator said stop; a launched-lineage participant is decided by its study, not by an assistant nudge. Recommending either is worse than staying silent.
The two layers are tested **separately and in both directions** (T-A6, T-A2b) precisely because they have different justifications.

**D6 — A1 uses `computeReadinessByRun` (V6), not `getRunReadiness` (V7), and no cache.**
4 bounded `inArray` queries regardless of N. A TTL cache would add a staleness class (a just-promoted run lingering in the "promote me" list) for no measurable gain.

**D6a — `overridden` IS promotable; call the existing `isPhaseReady` helper (V33).**
`readiness-core.ts:209` already exports it with the comment *"A run may promote when its readiness is 'ready' or 'overridden'"*, and `assertEvidenceReady` throws only when a contribution is neither `clear` nor `overridden`. A human who waived a blocking gate has *made* the run promotable.
⚠ **`overridden` outranks `ready` in `READINESS_PRIORITY`**, so a run with one waived gate rolls up to `overridden`, and a `state === 'ready'` comparison would **silently drop genuinely promotable runs**. Call `isPhaseReady`; never re-spell it.

**D7ʹ — Prove the two classifiers agree on Layer 1 only.**
Sharing `isPhaseReady` removes *predicate* drift, not *input* drift: `computeReadinessByRun` and `assertEvidenceReady` gather contributions through separate query paths whose equivalence is only asserted in comments. A fixture matrix over all six `ReadinessState` values (incl. `overridden`) asserts biconditional agreement. Layer 2 is asserted as an intentional, enumerated divergence — not folded into the same `iff`.

**D8 — A2 extends the ONE existing resolver; it never re-spells the predicate.**
`listMentionCandidateAgents` (V11) gains `blockedReason` and derives `summonable = blockedReason === null`. **Flat single-table reads only (V14).**

**D9 — `SummonBlockedReason` has 5 members with deterministic precedence**, one per conjunct in V12:
`link_disabled` > `agent_disabled` > `quarantined` > `trigger_missing` > `mention_binding_missing`.
`trigger_missing` deliberately reuses the launch-gate spelling at `launch.ts:214`.

**D10 — Two-level path, split on the id's own `:` separator, each component injectively encoded.** *(owner-confirmed)*
Per-component encoding is what makes the two-level form safe: because an encoded component can never itself contain `/`, the `(packageName, stem)` → path map stays **injective**, so collisions are *impossible* rather than merely collision-*resistant* (which is all a truncated-hash suffix would give).

**D11 — Cap: `MAISTER_AGENT_MEMORY_MAX_CHARS`, default `32768` characters.** See REQ-C11.

**D12 — Memory resolution + snapshot happen at the LAUNCH SITE, not inside `buildAgentPrompt`.** See REQ-C4 AC3.

**D13 — Injected MEMORY section sits after `configBlock`, before `taskBlock`.**
Standing project knowledge belongs with standing config; the current ask comes after.

**D14 — Memory is injected at INITIAL spawn only.** A resumed session already carries it in restored context; re-injecting would duplicate it. Stated in the domain doc as a known boundary.

**D15 — The write route takes NO body-controlled identifiers.**
`POST|GET /api/v1/ext/agent/memory` — **no `slug` path segment**. Identifier table:

| Identifier | Source | Label |
| --- | --- | --- |
| `projectId` | `ctx.actor.projectId` (token binding) | `auth-context` |
| `agentId` | `ctx.actor.agentId` (token binding) | `auth-context` |
| writing `runId` (log/audit only) | `ctx.actor.boundRunId`, derived server-side from the token name (V18) | `auth-context` |
| `projectSlug` (path component) | `projects` row looked up by `projectId` | `server-state` |
| `content`, `ifHash` | request body — **not** locators; neither reaches a path or a cross-resource lookup | `body-controlled` (benign) |

Zero `body-controlled` cross-resource ids exist, so there is nothing to validate against a server-state twin.

**D16 — A distinct token scope `agent_memory:write`, mapped to a NEW `ProjectAction`.** *(owner-confirmed)*
Reusing `memory:write` would make one grant open **two** stores — re-coupling exactly the two axes the owner separated. The two-axis pattern already in place (`memory:read`/`memory:write` scope × `can_read_brain`/`can_write_brain` flag) is reproduced as `agent_memory:write` scope × `memory_enabled` flag.
Per the "agent gains an op" fanout rule the scope moves together with **five** sites (V37 makes the fifth mandatory — an unmapped scope silently resolves to `readBoard`, i.e. viewer):
1. `web/types/token-scopes.ts` → `TOKEN_SCOPES`
2. `web/types/token-scopes.ts` → `AGENT_TOKEN_SCOPES` grant list
3. `web/lib/authz.ts` → **new** `PROJECT_ACTION_MIN.writeAgentMemory = "member"` *(owner-confirmed: a new action, not a reuse of `writeBrain`)*
4. `web/lib/tokens/ext-handler.ts` → `PROJECT_ACTION_BY_SCOPE["agent_memory:write"] = "writeAgentMemory"`
5. `web/lib/tokens/__tests__/scope-contract.test.ts`

**D17 — No `memory_read` MCP tool in v1.** The content is already in the prompt, and a lost CAS returns the current content + hash (the only genuine refresh need). `GET /api/v1/ext/agent/memory` exists for symmetry and diagnostics but ships no tool.

**D18 — The owner's edit endpoint carries CAS too.** See REQ-C9 AC1.

**D19 — Detach semantics are correct by construction; no work, but a documented surprise.** See REQ-C10.

**D20 — Agent memory gets its OWN system-analytics doc.**
`docs/system-analytics/agent-memory.md`. `agents.md` Expectations is already at 21 bullets, over the R5a cap (V24); R5a's own remedy for an over-full domain is to split, and `agent-mentions.md` is the precedent. `agents.md` gets a single cross-link line (R7), not a restatement.

**D21ʹ — The definition default is applied SERVER-SIDE in `attachAgent`, positioned and failure-specified.** *(sharpened 2026-07-27)*
The `recommended` prefill lives in `rowFromAvailable` in the panel (V27), so a direct `POST` bypasses it. Because `memory` is a capability axis, `attachAgent` reads the effective definition itself. Two things the original D21 left open:
- **Ordering:** the read happens **after** `assertAgentPackageAttachable` (V38) — that call is what guarantees the project pin exists; reading first would surface pin problems as the wrong error.
- **Failure branch:** if `resolveEffectiveAgentDefinition` throws (pin divergence), the **attach fails** and propagates that error. An attach that silently lands `memory_enabled = false` because resolution failed is a "looks configured but isn't" trap.
The client prefill stays for UX symmetry with the mention binding. The attachment value remains **effective** — a package upgrade never re-enables memory an operator turned off.

**D22 — Flow-bound agents are out of scope for v1 memory (V30), surfaced not hidden.** *(owner-confirmed)*
Show the Memory toggle **disabled, with the reason** — "this agent drives a Flow; Flow runs do not carry agent memory". A hidden control teaches nothing; a disabled one with a reason makes the boundary discoverable at the moment it matters.

**D23 — `runs.agent_memory_hash` rides migration `0122`.** *(owner-confirmed 2026-07-27)*
`memory-snapshot.md` alone is not a durable provenance record — the run dir is GC'd for terminal runs older than 7d (V36). One additive nullable `text` column mirrors the `runs.runner_snapshot` philosophy: post-hoc, "what did this agent remember when it acted" stays answerable and *queryable*. Rejected alternative: stamping into `runner_snapshot` jsonb — that column is read by resume/recover and must stay runner identity only.

**D24 — `agent_memory_write` is the ONE facade tool without `slug`, and says so.** *(new — closes the H10 gap)*
Every other MAIster MCP tool requires `slug`, and the project-scope prompt block instructs the agent to *always pass it* (V40). Since D15 derives the project from the token, `agent_memory_write` accepts no `slug` — and `dispatchTool` **silently drops** unknown args, so a habitual `slug` would vanish without a signal. Mitigations, both required:
- the tool `description` states explicitly that this tool takes no `slug` because the project comes from the run-bound token;
- `TOOL_SPECS.agent_memory_write.inputSchema` sets `additionalProperties: false`, so a stray `slug` is a visible client-side validation failure rather than a silent drop.

**D25 — `readinessSummary` is cut from `PromotionReadyItem`.** *(new — closes the H8 gap)*
It had no source: `computeReadinessByRun` returns only a `ReadinessState`, and producing a *summary* would require the per-run `getRunReadiness` that D6 forbids. It is also semantically empty here — by construction every item's state is `ready` or `overridden`. The enum `readiness` field alone carries the signal.

---

## §4 · Contract surfaces → spec files (enumerated at plan time; `/aif-verify` re-derives from the diff)

| Surface changed | Spec file that must move with it |
| --- | --- |
| `GET /api/v1/ext/activity` response shape (`needsYou.promotable`, `agents`) | `docs/api/external/operations.openapi.yaml` (`ExtActivityPulseResponse`, `ExtActivityNeedsYouBlock`, new `ExtPromotionReadyItem`, `ExtActivityAgentsBlock`, `ExtPulseAgentItem`) + `docs/system-analytics/assistant-activity.md` |
| New route `GET|POST /api/v1/ext/agent/memory` | `docs/api/external/operations.openapi.yaml` (`extAgentMemoryGet`, `extAgentMemoryWrite`) + `docs/system-analytics/agent-memory.md` |
| New MCP tool `agent_memory_write` | `mcp/src/tools.ts` `TOOL_SPECS` + `resolveRouting` arm + `TOOL_OP` row in `mcp/src/__tests__/tool-contract.test.ts` (bijection, V22/V40) |
| New token scope `agent_memory:write` | `web/types/token-scopes.ts` (×2 lists) + `web/lib/authz.ts` `PROJECT_ACTION_MIN` + `PROJECT_ACTION_BY_SCOPE` + `scope-contract.test.ts` — **five** sites (D16) |
| New DB column `agent_project_links.memory_enabled` | migration triple + `docs/database-schema.md` narrative **and** `docs/db/agents-domain.md` `erDiagram` (updating one is not updating the other) |
| **New DB column `runs.agent_memory_hash`** | same migration triple + `docs/database-schema.md` `runs` narrative **and** the `runs` entity in the relevant `docs/db/*.md` ERD |
| New env var `MAISTER_AGENT_MEMORY_MAX_CHARS` | `docs/configuration.md` env-var table (canonical) + `.env.example`. **No compose change** (V23) |
| Agent definition frontmatter gains `memory:` | `web/lib/agents/definition.ts` zod schema + `docs/system-analytics/agents.md` (definition field list) + `docs/system-analytics/agent-memory.md` |
| `PATCH /api/projects/{slug}/agents/{agentId}` gains `memoryEnabled` + 3 new memory routes | `docs/api/web.openapi.yaml` + `docs/screens/projects/project-settings-agents.md` |
| New ADR | `docs/decisions.md` — `### ADR-152` header **and** an `## Index` row (a cited ADR with no header at HEAD is a build break) |
| Readiness no-N+1 invariant now names the pulse | `docs/system-analytics/readiness.md` Expectations |

No new `MaisterError` code (V21) ⇒ `docs/error-taxonomy.md` is untouched.

**Accepted spec-verification gap (V34):** `docs/api/web.openapi.yaml` has **no** contract test — the Phase-6 owner routes are lint-verified and hand-reviewed only. This is pre-existing and out of scope; it is recorded here so `/aif-verify` does not report it as a miss.

---

## §5 · Traceability matrix (REQ → spec → test → task)

Test ids are stable handles; each names the vitest project that runs it. `unit` and `integration` are the only two (V41).

| REQ | Spec artifact | Test id → file | Project | Task |
| --- | --- | --- | --- | --- |
| A1 | OpenAPI `ExtPromotionReadyItem`, `assistant-activity.md` | `T-A1u` → `lib/ext-activity/__tests__/pulse.test.ts` · `T-A1w` → `app/api/v1/ext/activity/__tests__/route.integration.test.ts` | unit · integration | T10, T12 |
| A2 | `assistant-activity.md` Expectations | `T-A2a` (layer 1 + ordering + allow-list) → `lib/ext-activity/__tests__/promotable.test.ts` · `T-A2b` (layer 2 suppression) → `lib/ext-activity/__tests__/promotable.db.integration.test.ts` | unit · integration | T9, T11 |
| A3 | `readiness.md` Expectations | `T-A3` (query-count assertion) → `promotable.db.integration.test.ts` | integration | T9, T11 |
| A4 | `assistant-activity.md` Expectations | `T-A4` → `pulse.test.ts` | unit | T10, T12 |
| A5 | `assistant-activity.md` Expectations | `T-A5` (byte-identical `happened`) → `route.integration.test.ts` | integration | T12 |
| A6 | ADR-152, `assistant-activity.md` | `T-A6` (6-state biconditional matrix) → `promotable.db.integration.test.ts` | integration | T11 |
| B1 | OpenAPI `ExtActivityAgentsBlock` | `T-B1u` → `pulse.test.ts` · `T-B1w` → `route.integration.test.ts` | unit · integration | T14, T15 |
| B2 | `assistant-activity.md` | `T-B2` → `pulse.test.ts` | unit | T14, T15 |
| B3 | ADR-152 | `T-B3` (consumers unchanged) → existing `social`/`task-detail` suites, unmodified | unit | T13 |
| B4 | OpenAPI enum, `assistant-activity.md` | `T-B4` (5 single-failure cases + precedence + null⟺summonable) → `lib/agents/__tests__/summonability.integration.test.ts` | integration | T13 |
| C1 | ERD + `database-schema.md` | `T-C1` (migration applies fresh + at-0121; default false) → `lib/agents/__tests__/memory-lifecycle.integration.test.ts` | integration | T16 |
| C2 | `agents.md`, `agent-memory.md` | `T-C2a` (parse + render round-trip) → `lib/agents/__tests__/definition.test.ts` · `T-C2b` (bare POST attach lands `true`; effective-value; resolver-throw fails the attach) → `memory-lifecycle.integration.test.ts` | unit · integration | T17 |
| C3 | `agent-memory.md` | `T-C3` (adversarial injectivity table + confinement + no-`:` refusal) → `lib/agents/__tests__/memory-store.test.ts` | unit | T18 |
| C4 | `agent-memory.md` Process flows | `T-C4` (verbatim injection, section position, flow-bound gets none) → `lib/agents/__tests__/memory-launch.integration.test.ts` | integration | T20 |
| C5 | `agent-memory.md` State machine | `T-C5` (absent · over-cap · unreadable ⇒ no section + WARN + launch proceeds) → `memory-launch.integration.test.ts` | integration | T20 |
| C6 | `agent-memory.md`, `database-schema.md` | `T-C6` (snapshot + hash written; `overridePrompt` writes neither) → `memory-launch.integration.test.ts` | integration | T21 |
| C7 | OpenAPI ops, `agent-memory.md` | `T-C7a` (CAS win/lose, post-write hash, concurrent-writer byte integrity) → `app/api/v1/ext/agent/memory/__tests__/route.integration.test.ts` · `T-C7b` (bijection) → `mcp/src/__tests__/tool-contract.test.ts` | integration · mcp unit | T23, T24 |
| C8 | OpenAPI responses, `agent-memory.md` | `T-C8a` (the 7-row refusal table) → `route.integration.test.ts` · `T-C8b` (scope catalog + action mapping ≠ `readBoard`) → `lib/tokens/__tests__/scope-contract.test.ts` | integration · unit | T22, T23 |
| C9 | `web.openapi.yaml`, screen doc | `T-C9a` (human CAS 409 · DELETE idempotent · `memoryEnabled` through the aggregating PATCH) → `app/api/projects/[slug]/agents/[agentId]/memory/__tests__/route.integration.test.ts` · `T-C9b` (EN≡RU key parity) → existing i18n parity check | integration · unit | T25, T26 |
| C10 | `agent-memory.md` Edge cases | `T-C10` (detach inert + file survives · re-attach revives incl. the `none` surprise · re-pin preserves) → `memory-lifecycle.integration.test.ts` | integration | T27 |
| C11 | `configuration.md`, `.env.example` | `T-C11` (cap boundary `max`/`max+1`, invalid env ⇒ default + WARN) → `memory-store.test.ts` | unit | T18, T19 |
| C12 | `assistant-activity.md` | Covered structurally — `PulseAgentItem` has no content field; `T-B1w`'s exact-JSON assertion is the guard | integration | T14 |

**Every REQ has ≥1 test. Every test names a REQ. No test exists without a REQ.** A task is not done until its row's tests are green.

---

## §6 · TDD protocol (binding for Phases 1–6)

### The cycle

Every implementation task below is written as three ordered sub-steps. They are **not** optional and **not** reorderable.

- **RED.** Write the test first. Run it. Record the actual failure output in the task's notes. The failure must be the **specified** failure (a wrong value, a missing field, an unthrown error) — an `ERR_MODULE_NOT_FOUND` or a TypeScript compile error is *not* a valid RED. When the module under test does not exist yet, create the minimal exported stub that makes the test fail on **behavior**, then proceed.
- **GREEN.** Write the **minimum** implementation that turns the test green. No speculative fields, no unrequested configurability, no error handling for impossible states. Run the test. It must pass, and no previously-green test may go red.
- **REFACTOR.** With the test green, apply SOLID/KISS/DRY: extract only duplication that already exists twice, collapse anything a senior reviewer would call overcomplicated, align naming and comment density with the surrounding file. Re-run. Still green.

### Test-design discipline

1. **One test per requirement clause.** A test's name cites its REQ id (`REQ-A2 AC3 — an unknown run status is rejected by default`). A clause with no test is an unmet requirement; a test with no clause is scope creep.
2. **Edge cases are table-driven inside the owning test file** — never a duplicated sibling suite. The path-injectivity adversarial set (REQ-C3) is one `it.each`, not fourteen `it`s.
3. **No trivial tests.** Explicitly forbidden: asserting a constant equals itself; asserting a type/const merely exists; asserting a getter returns what a setter just set; asserting zod rejects a wrong primitive type (that is the library's contract, not ours); snapshotting an object with no invariant.
4. **Minimum overlap — one proof per fact, at the lowest layer that can prove it.**
   - *unit* proves pure logic: predicate assembly, ordering, path derivation, hashing, cap boundaries, block-reason precedence.
   - *route integration* proves **only** serialization, status codes, and authorization — never re-proving a predicate a unit test already pinned.
   - *DB/FS integration* proves **only** cross-boundary composition: real query behavior, real atomic writes, real concurrency.
   A fact proven at the unit layer is **not** re-asserted above it. Where a route test must exercise a predicate to reach its own assertion, it asserts the status code, not the predicate.
5. **Concurrency is proven with real concurrency.** REQ-C7 AC4 launches two genuinely parallel writes and asserts the file's final bytes equal exactly one writer's payload — not a mocked sequence.
6. **Fixture matrices are exhaustive over closed enums.** `ReadinessState` has six members (V8); `T-A6` covers six. `SummonBlockedReason` has five; `T-B4` covers five singly, plus the multi-failure precedence case.
7. **Assertion migration is in-scope, in the breaking phase.** Named up front in §9.

---

## §7 · Commit Plan

- **Commit 1** (T1–T8): `docs: freeze ADR-152 contracts for pulse follow-ups + agent memory files`
- **Commit 2** (T9–T12): `feat(ext-activity): surface promotion-ready runs in the pulse`
- **Commit 3** (T13–T15): `feat(ext-activity): surface summonable-agent metadata in the pulse`
- **Commit 4** (T16–T19): `feat(agents): agent memory files — config axis and on-disk store`
- **Commit 5** (T20–T21): `feat(agents): inject agent memory at launch with a provenance snapshot`
- **Commit 6** (T22–T24): `feat(agents): agent_memory_write facade tool with content-hash CAS`
- **Commit 7** (T25–T26): `feat(agents): owner memory viewer/editor in the attachment panel`
- **Commit 8** (T27–T28): `test: agent-memory lifecycle integration + full gate sweep`

Each commit boundary equals a phase boundary (the `<!-- Commit checkpoint -->` markers in §8), so a commit is never made against a phase whose exit criteria have not held.

---

## §8 · Tasks

### Phase 0 — Specs & analytics (SDD source of truth; nothing in Phases 1–7 starts until this phase's exit criteria hold)

Analytics is an **input** to implementation, not a trailing sync. Every state transition, refusal row, and wire field below must be written **exactly as the code will gate it**. §2's requirements are the contract these artifacts publish.

- [x] **T1. Reserve ADR-152 and write it.**
  Append `### ADR-152: Assistant pulse promotion-readiness + summonable-agent metadata, and per-attachment agent memory files` to `docs/decisions.md` using the template at the file's bottom, **and** add the matching `## Index` row with the correct anchor slug. Record D1–D25 as rationale (not restatement elsewhere — R4). Must explicitly record: **D5ʹ's two-layer split and why Layer 2 diverges from `promoteRun`** (V10ʹ), D3's `additionalProperties: false` consequence, D10's injectivity argument, D16's five-site fanout including the new `ProjectAction`, D23's choice of a `runs` column over the GC-able snapshot file, and D25's cut.
  *Verify:* `pnpm validate:docs` green; `grep '^### ADR-152' docs/decisions.md` and the Index row both resolve.

- [x] **T2. New domain doc `docs/system-analytics/agent-memory.md`** (D20), full R5 structure in order: Purpose · Domain entities · State machine (`stateDiagram-v2`: `absent → present → over_cap|unreadable → degraded`, plus `attached ↔ detached-inert`) · Process flows (`sequenceDiagram` ×3: launch injection + snapshot; agent CAS write incl. the losing branch; owner view/edit/clear) · **Expectations** (≤12 normative bullets, each traceable to a REQ-C id, identifiers verbatim: `agent_project_links.memory_enabled`, `runs.agent_memory_hash`, `MAISTER_AGENT_MEMORY_MAX_CHARS`, `memory.md`, `memory-snapshot.md`, `MaisterError("CONFIG")`, `MaisterError("CONFLICT")`) · **Edge cases** (over-cap read, unreadable file, CAS loss, workspace-mode `none`, detach-inert + the D19 re-attach surprise, package re-pin preserves, `overridePrompt` path injects nothing per D12/D14, flow-bound agent per D22) · Linked artifacts. Tag every piece `(Designed)` here; T28 flips to `(Implemented)`.
  *Verify:* Mermaid parses under `pnpm validate:docs`; Expectations ≤12 bullets; every bullet maps to a §5 row.

- [x] **T3. Glossary + cross-link.** Add the `system-analytics/agent-memory.md` row to `docs/CLAUDE.md`, and a **single** cross-link line in `docs/system-analytics/agents.md` (R7 — do not restate; do not touch `agents.md`'s existing 21-bullet Expectations, V24/R9).
  *Verify:* both links resolve; `git diff docs/system-analytics/agents.md` is one added line.

- [x] **T4. Update `docs/system-analytics/assistant-activity.md` for A1 + A2.**
  Domain entities: add `Promotion-ready item` and `Summonable-agent item`. Process flows: add the two pulse-assembly steps. Expectations, stated **exactly as gated**: (a) the promotable set is the Layer-1 allow-list **plus** the Layer-2 operator-intent suppression, naming both and stating that Layer 2 deliberately withholds runs a human promote would accept (D5ʹ/V10ʹ); (b) `agents` reports **exactly** the attached set with a deterministic block reason; (c) promotable items never duplicate `now.runs` or `needsYou.items`; (d) readiness for the pulse MUST be bulk-computed (no per-run `getRunReadiness`); (e) no pulse block carries memory content (REQ-C12). Edge cases: "no promotable runs ⇒ `[]`, not omitted", "no attached agents ⇒ `[]`". Bump the Status line to note the v1.1 additive extension and D3's strict-validator consequence.
  *Verify:* `pnpm validate:docs`; **do not** reflow unrelated bullets (R9).

- [x] **T5. Update `docs/system-analytics/readiness.md` Expectations** so the existing "board and portfolio MUST bulk-fetch; neither MUST call `getRunReadiness` per run" bullet also names the **assistant pulse** (D6/REQ-A3).
  *Verify:* one-bullet surgical diff.

- [x] **T6. Extend `docs/api/external/operations.openapi.yaml` additively.**
  Add `ExtPromotionReadyItem` (`runId`, `taskId`, `taskKey`, `taskTitle`, `targetBranch` **nullable**, `readiness` enum, `inReviewSince` — **no `readinessSummary`**, D25), `ExtActivityAgentsBlock` (`{generatedAt, items}`), `ExtPulseAgentItem` (`agentId`, `stem`, `displayName`, `enabled`, `summonable`, `summonBlockedReason` nullable enum of D9's 5 members). Add `promotable` to `ExtActivityNeedsYouBlock.properties` **and** its `required`; add `agents` to `ExtActivityPulseResponse.properties` **and** its `required` (D3). Add ops `extAgentMemoryGet` / `extAgentMemoryWrite` for `GET|POST /api/v1/ext/agent/memory` with body `{content, ifHash}`, `200 {content, hash, sizeChars, updatedAt}`, `409` (CAS loss, body carries current `content` + `hash`), `422` (over-cap), `403` (not an agent token / detached / memory disabled). The write body must be spelled so the `TOOL_SPECS` bijection (V22) can mirror it exactly — no `slug`, no ids (D15/D24).
  *Verify:* `npx @redocly/cli lint docs/api/external/operations.openapi.yaml` — **zero new errors** against a `git stash`-proved baseline pinned by enumerated `{ruleId, pointer}`, never by count.

- [x] **T7. Extend `docs/api/web.openapi.yaml`** with `memoryEnabled` on the `patchProjectAgentLink` partial body and as a `canReadBrain`-sibling read field on `AttachedAgent`, plus the three owner routes `GET|PUT|DELETE /api/projects/{slug}/agents/{agentId}/memory` (`PUT` body `{content, ifHash}`, `409` on stale hash carrying current content).
  *Verify:* redocly lint, zero new errors vs. the enumerated baseline. Record in the task notes that **no contract test enforces this spec** (V34) — it is lint + review only.

- [x] **T8. DB + config docs.**
  (a) `docs/db/agents-domain.md` — add `memory_enabled` to the `agent_project_links` entity **and** `agent_memory_hash` to the `runs` entity in the Mermaid `erDiagram` (if `runs` is not in this file, update the ERD file that owns it). (b) `docs/database-schema.md` — add **both** columns to their narrative sections with defaults and meaning. (c) `docs/configuration.md` — add the canonical `MAISTER_AGENT_MEMORY_MAX_CHARS` row (`no` / `32768` / description naming the reader function and stating **host/service-env only per ADR-023, never a compose var**). (d) `.env.example` — commented block next to the assistant-activity block, same style. (e) `docs/screens/projects/project-settings-agents.md` — document the `mem` chip, the row's memory action, the memory drawer, and the modal's Memory toggle (incl. the D22 disabled-with-reason state); **and correct the stale i18n line** — it names `projectSettings.agents`; the catalogs use `agentsAttach` (V28), and `projectSettings` does not exist in either file. In-scope because this task already edits the file (docs R9).
  *Verify:* `pnpm validate:docs`; `grep -c MAISTER_AGENT_MEMORY_MAX_CHARS docs/configuration.md .env.example` ≥ 1 each; `grep -c agent_memory_hash docs/database-schema.md docs/db/*.md` ≥ 1 each.

**Phase 0 exit criteria (all must hold):** every artifact written and internally consistent with §2; every REQ in §2 published by at least one spec artifact; `pnpm validate:docs` green; both OpenAPI files lint with zero **new** errors vs. an enumerated baseline; ADR-152 header **and** Index row present; **no code touched**.

---

### Phase 1 — A1: promotion readiness in the pulse

- [ ] **T9. `web/lib/ext-activity/promotable.ts` — the single promotable predicate (REQ-A2, REQ-A3).**

  **RED.** Write `web/lib/ext-activity/__tests__/promotable.test.ts` (`unit`) covering, per §6.1, with REQ ids in the test names:
  - `REQ-A2 AC1` — a mechanically-qualifying row is included; each of `run_kind ≠ 'flow'`, `status ≠ 'Review'`, and `¬isPhaseReady` excludes it.
  - `REQ-A2 AC3` — an unrecognized `runs.status` value is **rejected** (drive the exported allow-list const with a synthetic status; a deny-list implementation passes the first case and fails this one).
  - `REQ-A2 AC4` — ordering: oldest `inReviewSince` first, `runId` ascending tiebreak, `null` `inReviewSince` sorts last deterministically.
  - `REQ-A1 AC3` — item assembly: `targetBranch` comes from the workspace and is `null` when unset; `inReviewSince` is a `Date` on the domain type.
  Run it. Expect behavioral failures, not import errors.

  **GREEN.** Implement `listProjectPromotable(projectId, deps?: {db?, now?}): Promise<PromotionReadyItem[]>`:
  one query for candidates (`runs` ⋈ `workspaces` ⋈ `tasks`) filtered `project_id = $1 AND run_kind = 'flow' AND status = 'Review' AND promotion_hold IS NULL` (⚠ jsonb column — see REQ-A2 AC2's correction; `isNull(runs.promotionHold)`, never `IS NOT TRUE`); **one** `computeReadinessByRun(client, candidateIds)` call (D6); filter with the **exported `isPhaseReady`** from `readiness-core.ts:209` — **not** `state === 'ready'` (V33/D6a); drop launched-lineage rows via `isLaunchedLineageRun` from `web/lib/evaluations/membership.ts:41`. Export the status/kind admission set as a named const (allow-list). Add `PromotionReadyItem` to `web/lib/ext-activity/types.ts` — `{runId, taskId, taskKey, taskTitle, targetBranch: string | null, readiness: ReadinessState, inReviewSince: Date | null}`.

  **REFACTOR.** Keep the two layers (D5ʹ) *visibly* separate in the code — the SQL predicate carries Layer 1's kind/status plus the cheap `promotion_hold` prefilter, and the Layer-2 lineage drop is its own named step with a WHY comment citing V10ʹ (so a future reader does not "simplify" it into the SQL and lose the fact that it is an intentional divergence from `promoteRun`).

  *Files:* `web/lib/ext-activity/promotable.ts` (new), `web/lib/ext-activity/types.ts`.
  *Logging (verbose):* `log.debug({projectId, candidateCount, readyCount, excludedHold, excludedLineage}, "[ext-activity.promotable] classified")`; `log.warn` when `computeReadinessByRun` returns no entry for a candidate id (a shape regression, not a normal state).
  *Depends on:* T1–T8.

- [ ] **T10. Wire `promotable` into the pulse response and the wire serializer (REQ-A1, REQ-A4).**

  **RED.** Extend `web/lib/ext-activity/__tests__/pulse.test.ts`:
  - `REQ-A1 AC1` — `needsYou.promotable` is `[]`, not omitted and not `undefined`, on a project with no candidates.
  - `REQ-A4 AC1/AC2` — a promotable run appears in **neither** `now.runs` nor `needsYou.items`.
  Run. Expect `undefined` where `[]` is asserted.

  **GREEN.** Extend `ActivityPulseResponse.needsYou` with `promotable: PromotionReadyItem[]` (`types.ts`). In `getActivityPulse`, **introduce** a `Promise.all([listProjectNeedsYou(...), listProjectPromotable(...)])` before the events queries — ⚠ per **V35 there is no existing `Promise.all` to join**; `listProjectNeedsYou` is awaited sequentially at `service.ts:334` and its result is a **required input** to `buildRunSnapshot`, so it stays threaded there unchanged. Extend `serializePulseResponse` so `inReviewSince` emits as ISO (or `null`). Add `promotableCount` to the route's `log.debug`; leave `needsYouCount` untouched (D4).

  **REFACTOR.** If Phase 2's `agents` fetch will join the same `Promise.all` (it will — T14), leave the array shape ready for a third element rather than restructuring twice.

  *Files:* `web/lib/ext-activity/{types,service}.ts`, `web/app/api/v1/ext/activity/route.ts`.
  *Logging:* `getActivityPulse` logs total elapsed ms at DEBUG so a slow readiness pass is visible without a profiler.
  *Depends on:* T9.

- [ ] **T11. Classifier-agreement + suppression-divergence integration proof (REQ-A6, REQ-A2 AC2, REQ-A3).**

  **RED.** Write `web/lib/ext-activity/__tests__/promotable.db.integration.test.ts` (`integration`, real PG via `test-support/pg-container.ts`):
  - `T-A6` / `REQ-A6` — a fixture matrix over **all six** `ReadinessState` values (V8), including an `overridden` run with one waived blocking gate, asserting the **biconditional**: `listProjectPromotable` includes the run ⟺ `assertEvidenceReady(runId,'review',db)` does not throw. This is Layer 1 only.
  - `T-A2b` / `REQ-A2 AC2` — the **enumerated divergence**: a green `Review` run with `promotion_hold = true`, and a green launched-lineage participant, are each **excluded** from `listProjectPromotable` *even though* `assertEvidenceReady` does not throw and a human `promoteRun` would accept them (V10ʹ). Assert the exclusion and its reason separately, so the test documents the intent rather than accidentally encoding it.
  - `T-A3` / `REQ-A3` — instrument the db client and assert `computeReadinessByRun` is invoked **exactly once** per call and `getRunReadiness` **zero** times, at N = 1 and N = 12 candidate runs (a per-run implementation passes N=1 and fails N=12).
  Run. Expect failures on the divergence and query-count cases.

  **GREEN.** Only fixture/seed helpers should be needed — T9's implementation already satisfies these if it is correct. Any production change here is a T9 defect; fix it in `promotable.ts`, not in the test.

  **REFACTOR.** Extract the six-state fixture builder into the test file's own helper (not a shared `test-support` module — one consumer, DRY does not apply yet).

  *Runner:* `integration` — matches `lib/**/*.integration.test.ts` (V41); confirm with `vitest list` before calling it delivered.
  *Depends on:* T9.

- [ ] **T12. Route-contract proof (REQ-A1 AC1/AC3, REQ-A5).**

  **RED.** Extend `web/app/api/v1/ext/activity/__tests__/route.integration.test.ts`:
  - `T-A1w` — the exact serialized JSON now carries `needsYou.promotable` with `inReviewSince` as an ISO string (or `null`) and `targetBranch` nullable, matching `ExtPromotionReadyItem`.
  - `T-A5` — **cursor replay unaffected**: for a fixed `since`, `JSON.stringify(body.happened)` is byte-identical across a poll pair in which promotable rows appear and disappear, and `nextCursor` is unchanged.
  Per §6.4 this test asserts **serialization and status only** — it does not re-prove the predicate.
  Run. Expect a missing key.

  **GREEN.** Serializer fixes only if RED exposes one.

  **REFACTOR.** n/a unless duplication appears.

  *Depends on:* T10.
  <!-- Commit checkpoint: T9–T12 -->

**Phase 1 exit:** `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` green; REQ-A1…A6 rows in §5 all have a passing test.

---

### Phase 2 — A2: summonable-agents metadata

- [ ] **T13. Extend `listMentionCandidateAgents` with a block reason (REQ-B3, REQ-B4).**

  **RED.** Extend `web/lib/agents/__tests__/summonability.integration.test.ts`:
  - `REQ-B4 AC1` — five cases, each failing exactly one conjunct, each yielding its own reason.
  - `REQ-B4 AC2` — a fixture failing **all five** simultaneously yields `link_disabled` (highest precedence), and a fixture failing conjuncts 3+4 yields `quarantined` — proving precedence is deterministic, not incidental ordering.
  - `REQ-B4 AC3` — all-pass yields `blockedReason === null` **and** `summonable === true`; the biconditional is asserted, not just one direction.
  Run. Expect `blockedReason` to be `undefined`.

  **GREEN.** Add `SummonBlockedReason` (5 members, D9 precedence) to `MentionableAgent` in `web/lib/social/mentions.ts:230`. In `web/lib/agents/summonability.ts`, compute `blockedReason` from the same five conjuncts already present at lines 111–116 and derive `summonable = blockedReason === null` — **one** predicate, no second spelling.
  ⚠ **Keep the three flat single-table reads; do not "optimize" into a join (V14)** — a join mis-maps `id`/`enabled` in the app runtime only, so the whole suite would stay green while production silently reports every agent non-summonable.

  **REFACTOR.** Express the precedence as an ordered list of `[conjunct, reason]` pairs evaluated first-match, so adding a sixth conjunct cannot silently land at the wrong precedence.

  *Files:* `web/lib/agents/summonability.ts`, `web/lib/social/mentions.ts`.
  *Logging (verbose):* `log.debug({projectId, attached, summonable, reasonHistogram}, "[agents.summonability] resolved")`.
  *Verify (REQ-B3 AC2):* `social/comments.ts` and `queries/task-detail.ts` compile untouched and their existing suites stay green — the field is additive.

- [ ] **T14. Add the `agents` block to the pulse (REQ-B1, REQ-B2, REQ-C12).**

  **RED.** Extend `web/lib/ext-activity/__tests__/pulse.test.ts`:
  - `REQ-B1 AC1` — `agents` is present with `{generatedAt, items}` and `items === []` when nothing is attached.
  - `REQ-B2 AC1/AC2` — `items` count ≡ attached-link count; a **non-summonable** agent is present with its reason, never filtered out; `enabled` reflects the **attachment** axis, not `agents.enabled` (fixture: link enabled + catalog row disabled ⇒ `enabled: true`, `summonBlockedReason: "agent_disabled"` — this single fixture pins both facts and would pass a naive implementation only by accident).
  Run.

  **GREEN.** `ActivityPulseResponse.agents = { generatedAt: Date; items: PulseAgentItem[] }`, assembled in `getActivityPulse` from `listMentionCandidateAgents(client, projectId)` **in the same `Promise.all` as `needsYou`/`promotable`** (the one T10 introduced). Map `{id→agentId, stem, name→displayName, enabled(link axis), summonable, blockedReason→summonBlockedReason}`. Extend `serializePulseResponse`. Add `agentCount`/`summonableCount` to the route's debug log.

  **REFACTOR.** n/a.

  *Files:* `web/lib/ext-activity/{types,service}.ts`, `web/app/api/v1/ext/activity/route.ts`.
  *Depends on:* T13.

- [ ] **T15. A2 route-contract proof (REQ-B1 AC1).**

  **RED.** Extend `route.integration.test.ts`: the serialized `agents` block matches `ExtActivityAgentsBlock`/`ExtPulseAgentItem` exactly — enum members present, `summonBlockedReason` nullable, **no field carrying memory or content** (REQ-C12's structural guard). Serialization only (§6.4).

  **GREEN / REFACTOR.** Serializer fixes only if RED exposes one.

  *Depends on:* T14.
  <!-- Commit checkpoint: T13–T15 -->

**Phase 2 exit:** both suites green; REQ-B1…B4 proven.

---

### Phase 3 — B1/B2: configuration axis + on-disk store

- [ ] **T16. Migration `0122_agent_memory_files` — the triple, TWO columns (REQ-C1, D23).**

  ```sql
  ALTER TABLE "agent_project_links" ADD COLUMN "memory_enabled" boolean NOT NULL DEFAULT false;
  ALTER TABLE "runs" ADD COLUMN "agent_memory_hash" text;
  ```
  Both additive: no DROP, no data-bearing change, so no backfill or abort-guard is owed. `false` is the correct constant default (not a "looks populated but isn't" trap): a pre-existing attachment genuinely has no memory until an operator or a re-attach prefill turns it on. `agent_memory_hash` is nullable — `NULL` means "this run injected no memory", which is the honest seed. Hand-name the file (precedent: `0121_agent_mention_summons`).
  Update `web/lib/db/schema.ts`: `agentProjectLinks.memoryEnabled = boolean("memory_enabled").notNull().default(false)` with a WHY comment (separate axis from `can_write_brain`), and `runs.agentMemoryHash = text("agent_memory_hash")` with a WHY comment (provenance survives the 7-day run-dir GC).

  *Verify (`T-C1`):* the triple exists (`.sql` + `_journal.json` entry idx 122 + `meta/0122_snapshot.json`); `_journal.json` `when` is strictly greater than 0121's; `pnpm --filter maister-web db:migrate` applies cleanly on a fresh DB **and** on a DB already at 0121. No RED/GREEN cycle — a migration is not behavior; T-C1's assertions live in `memory-lifecycle.integration.test.ts` and read the applied schema.

- [ ] **T17. Definition frontmatter `memory: none | enabled` (REQ-C2).**

  **RED.**
  - `web/lib/agents/__tests__/definition.test.ts` (`unit`) — `T-C2a`: a definition carrying `memory: enabled` **parses** (today `.strict()` refuses it, V26), surfaces on `ParsedAgentDefinition`, and `renderAgentDefinition()` round-trips it **byte-identically** (⚠ the renderer self-validates by re-parsing its own output, so a schema-only change leaves this test failing on a *missing key*, which is exactly the silent-drop bug it guards); a definition omitting `memory` defaults to `none`.
  - `web/lib/agents/__tests__/memory-lifecycle.integration.test.ts` (`integration`) — `T-C2b`: a bare `attachAgent` call with **no follow-up `PATCH`** lands `memory_enabled = true` for a `memory: enabled` definition and `false` for `memory: none`; a subsequent package upgrade does **not** flip an operator's `false` back to `true` (REQ-C2 AC4); when `resolveEffectiveAgentDefinition` throws (pin divergence fixture), the **attach fails** and no link row is written (D21ʹ).
  Run both.

  **GREEN.** Because the schema is `.strict()` (V26), four sites move together or the field is refused / silently lost:
  1. `agentDefinitionFrontmatterSchema` in `web/lib/agents/definition.ts:267` — the zod field, default `none`.
  2. `renderAgentDefinition()` (`definition.ts:447`) — the render branch.
  3. `web/components/flows/artifact-editors/frontmatter-artifact-editor.tsx` — the Studio field (its `editRecommended` mutator rebuilds objects from *known* sub-fields, so an unknown key is dropped on the next edit — REQ-C2 AC5).
  4. `attachAgent()` in `web/lib/agents/project-links.ts:264` — the server-side default, read via `resolveEffectiveAgentDefinition` (**already imported at line 11**, V38) **after** `assertAgentPackageAttachable` (D21ʹ ordering), propagating a resolution throw. Plus the client prefill in `rowFromAvailable` (`agents-attach-panel.tsx:395`), `memoryEnabled` on the `AttachedAgentView` DTO, and `memoryEnabled?: boolean` on the `updateAgentLink` patch type (~lines 341/439, following the `canReadBrain`/`canWriteBrain` not-null-boolean pattern: only an explicit `true`/`false` writes).

  **REFACTOR.** Keep `memory` adjacent to the other capability-axis fields in both the schema and the renderer so the two stay visibly paired.

  *Logging (verbose):* `log.debug({agentId, projectId, definitionDefault, effective}, "[agents.attach] memory axis prefilled")`.
  *Depends on:* T16.

- [ ] **T18. `web/lib/agents/memory-store.ts` — path, read, write, hash, cap (REQ-C3, REQ-C11).**

  **RED.** Write `web/lib/agents/__tests__/memory-store.test.ts` (`unit`):
  - `T-C3` / `REQ-C3 AC3` — **one `it.each` table** (§6.2) of adversarial id pairs asserting *no two distinct ids map to the same path*: `a:b/c` vs `a` + `b/c`; `a/b:c` vs `a` + `b/c`; components containing `..`, `%`, `/`, `:`, spaces, unicode; an empty stem; a stem containing further `:`. A naive `split(":")`-then-`join` collides on these; per-component encoding does not.
  - `REQ-C3 AC2/AC4` — a component encoding to `.` or `..` is refused; every derived path is inside `<runtimeRoot>/.maister/<slug>/agents/`.
  - `REQ-C3 AC5` — an id with no `:` throws `CONFIG`, never a single-level fallback.
  - `T-C11` / `REQ-C11` — cap boundary at exactly `max` (accepted) and `max+1` (refused); invalid/zero/negative `MAISTER_AGENT_MEMORY_MAX_CHARS` ⇒ default + one WARN.
  - hash stability: the same bytes hash equal, one changed byte does not; an absent file yields `null`.
  Run.

  **GREEN.** Exports:
  - `agentMemoryPath(projectSlug, agentId)` — splits the id on its **first** `:` and returns `path.join(runtimeRoot(), ".maister", projectSlug, "agents", enc(packageName), enc(stem), "memory.md")`, mirroring the `runDirPath` formula (V29). `enc` keeps `[A-Za-z0-9._-]`, rewrites every other byte as `%XX` uppercase; rejects `.`/`..` results.
  - `readAgentMemory(projectSlug, agentId): Promise<{content, hash, sizeChars} | null>`
  - `writeAgentMemory(projectSlug, agentId, content): Promise<{hash}>` — via the existing **`atomicWriteText`** (V29), never a bare `writeFile`.
  - `hashAgentMemory(content): string` — sha256 hex over the exact byte content.
  - `agentMemoryMaxChars()` in `web/lib/instance-config.ts` via `positiveIntFromEnv("MAISTER_AGENT_MEMORY_MAX_CHARS", 32_768)` — mirroring `assistantActivitySilentAfterSeconds` exactly (`instance-config.ts:296`).

  **REFACTOR.** `enc` is one small pure function used twice in one expression — inline duplication is not DRY-worthy; keep it as a single named helper and resist generalizing it into a shared path util with one consumer (KISS).

  *Files:* `web/lib/agents/memory-store.ts` (new), `web/lib/instance-config.ts`.
  *Logging (verbose):* DEBUG on every read/write with `{agentId, projectSlug, sizeChars, hash}`; WARN on unreadable/over-cap read naming the reason; **never** log `content`.
  *Depends on:* T16.

- [ ] **T19. Deployment wiring verification (REQ-C11 AC4).**
  `.env.example` block + `docs/configuration.md` row were written in T8 — here, **verify** the reader resolves them end to end and confirm **no compose change is owed** (V23: `web` runs on the host, default compose is Postgres-only, ADR-023). Record that verification explicitly in the task notes rather than silently skipping compose — the skill-context deployment rule requires a stated outcome, not an absence.
  *Depends on:* T18.
  <!-- Commit checkpoint: T16–T19 -->

**Phase 3 exit:** both suites green; migration applies on fresh **and** at-0121 DBs; REQ-C1, C2, C3, C11 proven.

---

### Phase 4 — B3/B5: launch injection + provenance

- [ ] **T20. `resolveAgentMemoryForLaunch` + prompt injection (REQ-C4, REQ-C5).**

  **RED.** Write `web/lib/agents/__tests__/memory-launch.integration.test.ts` (`integration`; precedent: `brain-launch-axes.integration.test.ts`):
  - `T-C4` / `REQ-C4 AC1` — a memory-enabled agent launch composes a prompt containing the file's content **verbatim**, positioned **after** the config block and **before** the task block.
  - `REQ-C4 AC2` — a **flow-bound** agent (definition declaring `flow:`) produces a `run_kind='flow'` run whose prompt contains no MEMORY section (V30 — it diverts at `launch.ts:939` before ever reaching the seam). Asserting this boundary is the point; leaving it implicit is how it silently changes.
  - `T-C5` / `REQ-C5` — three degradation fixtures (file absent · over-cap · unreadable, e.g. a directory in the file's place): each produces **no** MEMORY section, the launch **completes normally**, and a `log.warn` names which failure occurred. No path throws.
  Run.

  **GREEN.** `resolveAgentMemoryForLaunch(db, run): Promise<{text, hash} | null>` — reads the link's `memory_enabled` (**flat single-table read**, V14), returns `null` when disabled / absent / unreadable / over-cap. Add a `memoryBlock(text)` section to `buildAgentPrompt` between `configBlock` and `taskBlock` (`buildAgentPrompt` at `launch.ts:1712` gains an optional `memory` argument), clearly delimited, carrying the standard maintenance instruction block (REQ-C4 AC5). Gate the whole path on `run_kind = 'agent'`.

  **REFACTOR.** The maintenance instruction is a constant template — keep it as a module-level const next to `memoryBlock`, not interpolated at three call sites.

  *Files:* `web/lib/agents/launch.ts`, `web/lib/agents/memory-store.ts`.
  *Logging (verbose):* DEBUG `{runId, agentId, injected: true, hash, sizeChars}` on inject; **WARN** `{runId, agentId, reason: "over_cap"|"unreadable", sizeChars?}` on degradation — this is the visible warning REQ-C5 AC2 requires, and it must state which failure occurred.
  *Depends on:* T18.

- [ ] **T21. Provenance snapshot + hash stamp (REQ-C6).**

  **RED.** Extend `memory-launch.integration.test.ts` with `T-C6`:
  - a normal memory-enabled launch writes `memory-snapshot.md` into `runDirPath(...)` **and** stamps `runs.agent_memory_hash` equal to `hashAgentMemory(content)`;
  - a launch taking the `opts.overridePrompt` branch writes **neither** the file nor the hash (D12 — `overridePrompt` discards `basePrompt` wholesale per V16, so stamping there would claim provenance for a prompt that carried no memory).
  Run.

  **GREEN.** At the launch site (`launch.ts:3103`), **only on the branch that actually uses the composed prompt**, write `memory-snapshot.md` into `runDirPath(runtimeRoot(), projectSlug, runId)` (the exported helper at `mutation-check.ts:207`, V29 — do not hand-roll a third copy of the `.maister/<slug>/runs/<run-id>` formula) via `atomicWriteText`, and set `runs.agent_memory_hash`.

  **REFACTOR.** Resolution + snapshot + stamp is one cohesive step — extract it into a single named function at the launch site so the `overridePrompt` branch condition is expressed once, not twice.

  *Depends on:* T20.
  <!-- Commit checkpoint: T20–T21 -->

**Phase 4 exit:** both suites green; REQ-C4, C5, C6 proven, including both boundary branches (flow-bound, `overridePrompt`).

---

### Phase 5 — B4: write path with CAS

- [ ] **T22. Token scope `agent_memory:write` — the FIVE-point fanout (REQ-C8 AC2, D16).**

  **RED.** Extend `web/lib/tokens/__tests__/scope-contract.test.ts` with `T-C8b`:
  - `agent_memory:write` is in `TOKEN_SCOPES` **and** in the `AGENT_TOKEN_SCOPES` grant list;
  - `resolveProjectAction("agent_memory:write")` returns `"writeAgentMemory"` — explicitly asserting it is **not** `"readBoard"`, since V37's `?? "readBoard"` fallback makes an unmapped write scope resolve to the viewer action silently;
  - `"writeAgentMemory"` is a key of `PROJECT_ACTION_MIN` with minimum `"member"`.
  Run — three failures.

  **GREEN.** Move all five sites together (D16): `web/types/token-scopes.ts` (`TOKEN_SCOPES` + `AGENT_TOKEN_SCOPES`), `web/lib/authz.ts` (`PROJECT_ACTION_MIN.writeAgentMemory = "member"`, adjacent to `writeBrain` with a WHY comment that it is a *separate* store), `web/lib/tokens/ext-handler.ts` (`PROJECT_ACTION_BY_SCOPE`).

  **REFACTOR.** n/a.
  *Depends on:* T18.

- [ ] **T23. Route `web/app/api/v1/ext/agent/memory/route.ts` (`GET` + `POST`) (REQ-C7, REQ-C8).**

  **RED.** Write `web/app/api/v1/ext/agent/memory/__tests__/route.integration.test.ts` (`integration`):
  - `T-C8a` — the **full 7-row refusal table** from REQ-C8, one case each: non-agent token · null `agentId` · detached · `memory_enabled = false` · missing scope · over-cap (422 `CONFIG`) · stale `ifHash` (409 `CONFLICT` **with** current `{content, hash}` in the body).
  - `T-C7a` / `REQ-C7 AC1/AC3` — first write with `ifHash: null` succeeds and returns the **post-write** hash; a second write with that hash succeeds; a third with the now-stale hash loses.
  - `REQ-C7 AC4` — **real concurrency** (§6.5): two genuinely parallel writes; the loser gets 409 and the file's final bytes equal **exactly** the winner's payload — no interleaving, no partial write.
  - `REQ-C8 AC3` — a run whose agent has `workspace: none` writes and re-reads successfully (the write targets `.maister/<slug>/agents/…`, never the worktree).
  Run.

  **GREEN.** Identifiers per D15's table — **every one `auth-context` or `server-state`, zero `body-controlled` locators**: `projectId` ← `actor.projectId`, `agentId` ← `actor.agentId`, `runId` ← `actor.boundRunId` (V18, log/audit only), `projectSlug` ← a `projects` lookup by `projectId`. Body is `{content: string, ifHash: string | null}` only; **no `slug` path segment**. Use `handleExt` **without** `slug` (the pulse-route pattern) so a project-less token is refused 403. Ordering: read-current → compare CAS → atomic write → return the **post-write** hash.

  **REFACTOR.** The three 403 branches share one refusal shape — one guard helper returning the typed response, not three copies.

  *Logging (verbose):* DEBUG on success `{agentId, projectId, runId, sizeChars, priorHash, newHash}`; INFO on CAS loss with both hashes; **never** log `content`.
  *Depends on:* T18, T22.

- [ ] **T24. MCP tool `agent_memory_write` + drift guard (REQ-C7 AC5, D24).**

  **RED.** Add the `TOOL_OP` row to `mcp/src/__tests__/tool-contract.test.ts`. Because the test asserts a **bijection** (V22), the row alone turns it red until the tool exists — and it will then check properties ≡ the OpenAPI body params, `required` set equality, types, and bounds. Run.

  **GREEN.** Three coordinated code edits: a `TOOL_SPECS` entry in `mcp/src/tools.ts` (`properties: {content, ifHash}`, `required: ["content"]`, **`additionalProperties: false`** per D24) and a `resolveRouting` arm (`mcp/src/tools.ts:717`, the switch `dispatchTool` calls — V40 confirms there is no separate dispatch arm) → `POST /api/v1/ext/agent/memory`. The `description` must state the CAS contract, that a lost CAS returns current content + hash, **and that this tool takes no `slug` because the project comes from the run-bound token** (D24 — every other facade tool requires `slug` and the project-scope prompt block tells the agent to always pass one; `dispatchTool` silently drops unknown args, so `additionalProperties: false` turns a habitual `slug` into a visible validation failure instead of a silent drop).
  **The facade ships from `mcp/dist`** — run `pnpm --filter @maister/mcp build` or the agent-side facade keeps serving the old bundle.

  **REFACTOR.** n/a.
  *Depends on:* T6, T23.
  <!-- Commit checkpoint: T22–T24 -->

**Phase 5 exit:** web + mcp suites green; REQ-C7, C8 proven including real-concurrency byte integrity.

---

### Phase 6 — B6: owner visibility & control

- [ ] **T25. Owner routes `GET | PUT | DELETE /api/projects/{slug}/agents/{agentId}/memory` (REQ-C9 AC1–AC3).**

  **RED.** Write `web/app/api/projects/[slug]/agents/[agentId]/memory/__tests__/route.integration.test.ts` (`integration`; bracketed dirs are already globbed, V41) with `T-C9a`:
  - `PUT` with a stale `ifHash` returns **409** carrying the current content — CAS applies to the human too (D18); a blind human Save must not clobber a concurrent agent write.
  - `DELETE` clears the file and is **idempotent** when already absent.
  - `memoryEnabled` flows through the **existing aggregating** `PATCH /api/projects/{slug}/agents/{agentId}` in one transaction (V20) — assert via the PATCH route, proving no new per-field route was added.
  - authz: `PUT`/`DELETE` require `editSettings`; `GET` requires the `readBoard`-equivalent; a viewer is refused on write.
  Run.

  **GREEN.** Implement the three handlers with `requireProjectAction(projectId, …)`, `projectId` server-derived from `slug`. Thread `memoryEnabled` through the existing PATCH.

  **REFACTOR.** The CAS compare/refuse logic is now used by both the ext route (T23) and here — **this is the second occurrence, so extract it** into `memory-store.ts` as `writeAgentMemoryCas(projectSlug, agentId, content, ifHash)` returning a discriminated `{ok:true,hash} | {ok:false,current}`. Re-point T23's route at it and re-run both suites.

  *Logging (verbose):* INFO on human write/clear with `{actorUserId, agentId, projectId, sizeChars}` — an owner edit is audit-worthy.
  *Depends on:* T18, T23.

- [ ] **T26. Attachment-panel UI + i18n (REQ-C9 AC4–AC6).**

  **RED.** Extend the i18n parity check (`T-C9b`) to cover the new `agentsAttach` keys in both catalogs — EN ≡ RU key sets, as the namespace already maintains (52 ≡ 52, V28). UI rendering itself is proven by the existing `renderToStaticMarkup` convention where a component test already exists for the panel; do **not** add a jsdom harness for this slice (§6.3 — no trivial tests).

  **GREEN.** Per `web/CLAUDE.md` data-management patterns and the screen doc (V20):
  - a **`mem` chip** in the attached-agents table's State/axes cluster (sibling of `brain:rw`);
  - a **memory icon button** in the row action cluster (left→right Edit ⚙ · **Memory 📄** · Launch ▶ · Enable/Disable · Detach 🗑 danger) opening a **dedicated portaled drawer** — *not* the 520–760px instance-config modal, which is the wrong container for a 32k-char document. Rendered `memory.md` read-only by default; an **Edit** affordance switching to a textarea; **Save** behind a confirmation popup (sends `ifHash`); **Clear** as a destructive confirmation; a live `sizeChars / max` indicator so "compact when near the cap" is actionable;
  - a **Memory** toggle (`memoryEnabled`) in the modal's Brain-access section, labelled as a **separate axis** from `canWriteBrain`;
  - for a **flow-bound agent**, the toggle renders **disabled with its reason shown** (D22/V30) — "this agent drives a Flow; Flow runs do not carry agent memory". Never hidden, never silently inert.
  - Accessible: focus trap, initial focus, focus restore, Esc, body scroll lock, `aria-labelledby`, `role="alert"` for save errors; `createPortal` to `document.body` (a `position:fixed` panel inside a transformed ancestor gets the wrong containing block).
  - i18n: **EN + RU parity** under the **`agentsAttach`** namespace (V28 — *not* `projectSettings.agents`, which exists in neither catalog): every label, `aria-label`, empty state, cap warning, CAS-conflict message, and the D22 disabled-reason string.

  **REFACTOR.** Reuse the shared confirmation and feedback providers (`web/CLAUDE.md` → "Feedback and confirmation"); do not hand-roll a third confirm dialog.

  *Files:* `web/components/board/panels/agents-attach-panel.tsx`, `agents-attach-edit-modal.tsx`, new `agent-memory-drawer.tsx`, `web/messages/{en,ru}.json`.
  *Depends on:* T25.
  <!-- Commit checkpoint: T25–T26 -->

**Phase 6 exit:** both suites green; EN≡RU parity holds; REQ-C9 proven.

---

### Phase 7 — Lifecycle integration, the loop acceptance, and gates

- [ ] **T27. Lifecycle + loop integration (REQ-C10, plus the end-to-end acceptance).**

  **RED.** Write `web/lib/agents/__tests__/memory-lifecycle.integration.test.ts` — extending the file T17 started — with the cases no earlier phase could reach because they span *two* runs or *two* lifecycle events:
  1. `T-C1` — the migration's applied shape: `memory_enabled` defaults `false`; `agent_memory_hash` defaults `NULL`.
  2. **Round-trip (REQ-C4 + REQ-C7 composed)** — content written by run N is injected **verbatim** into run N+1's prompt.
  3. **The loop acceptance** — a **mention-summoned** agent (the ADR-151 path) sees memory written by a **previous run of the same attachment**. This is the requirement the whole feature exists for; it is proven once, here, end to end.
  4. `T-C10` — **detach** makes memory inert (write refused, no injection) while the **file survives**; **re-attach** revives it and re-applies the definition default, including the D19 surprise (a `memory: none` definition revives the file but leaves it inert); **package re-pin** preserves the file (REQ-C3 AC6).
  5. **Memory off** — no MEMORY section **and** `agent_memory_write` refused with the typed error (the composed both-halves case; each half alone is already proven in Phases 4–5, so this asserts only their conjunction — §6.4).
  Run.

  **GREEN.** No new production code should be required. Anything red here is a defect in T17/T20/T21/T23 — fix it at its owning module, never by weakening the test.

  **REFACTOR.** Fold T17's `T-C2b` fixtures and these into one seed helper inside the file if the duplication is real.

  *Runnability:* confirm with `vitest list` that every file this plan adds is matched by its project's `include` glob (V41) before calling any of them delivered. A test that does not execute is not a deliverable.

- [ ] **T28. Full gate sweep + as-built spec sync.**
  Run and record output for each:
  ```bash
  pnpm --filter maister-web typecheck && pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration && pnpm --filter @maister/mcp build && pnpm --filter @maister/mcp typecheck && pnpm --filter @maister/mcp test && pnpm validate:docs && pnpm validate:contracts
  ```
  Lint **check-only**:
  ```bash
  pnpm --filter maister-web exec eslint .
  ```
  — never bare `pnpm --filter maister-web lint`, which is `eslint --fix` with no path and reformats ~60 unrelated files.
  Then: re-derive §4's contract-surface table from the actual diff and fix any drift; re-walk §5's traceability matrix and confirm every REQ row has a **passing** named test; flip every `(Designed)` tag added in Phase 0 to `(Implemented)`.
  **Per-phase green rule:** a test this plan touches that is left red fails the phase. Any pre-existing red must be quarantined explicitly (config `exclude` or `.skip` with a written reason + a tracked follow-up), never silently tolerated and never deleted.
  *Depends on:* T27.
  <!-- Commit checkpoint: T27–T28 -->

---

## §9 · Test-integrity acceptance (applies to every phase)

1. **Runnability** — each promised test names its vitest project (`unit` | `integration`) and its `include` glob is confirmed to match via `vitest list` before it counts as delivered (V41).
2. **Per-phase green checkpoint** — each phase exits only on `pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` green (plus `@maister/mcp test` for Phase 5).
3. **RED is recorded** — every implementation task's notes carry the observed RED output, and that output shows a *behavioral* failure, not a module-resolution or type error (§6).
4. **Assertion migration is in-scope, named up front.** The existing files this plan invalidates:
   - `web/lib/ext-activity/__tests__/pulse.test.ts` — response shape gains two blocks (Phase 1 T10, Phase 2 T14)
   - `web/app/api/v1/ext/activity/__tests__/route.integration.test.ts` — exact serialized JSON (Phase 1 T12, Phase 2 T15)
   - `mcp/src/__tests__/tool-contract.test.ts` — `TOOL_OP` bijection (Phase 5 T24)
   - `web/lib/tokens/__tests__/scope-contract.test.ts` — scope catalog + action map (Phase 5 T22)
   - `web/lib/agents/__tests__/definition.test.ts` — frontmatter schema surface (Phase 3 T17)
   Updating each is a task **in the phase that breaks it**, never a follow-up.

## §10 · Acceptance criteria (from the request, mapped to REQ + test)

| Criterion | REQ | Proven by |
| --- | --- | --- |
| Review run with green readiness appears under `needsYou`, disappears after promotion | A1, A2, A6 | `T-A1u`, `T-A2a`, `T-A6` |
| A held or study-owned run is *deliberately* withheld from the recommendation | A2 AC2 | `T-A2b` |
| Readiness stays O(1) queries as run count grows | A3 | `T-A3` |
| `agents` lists exactly the ADR-151 summonable set with block reasons | B2, B4 | `T-B2`, `T-B4` |
| Existing pulse consumers unbroken (cursor replay unaffected) | A5, B3 | `T-A5`, `T-B3` |
| Memory off ⇒ no MEMORY section + typed refusal | C5, C8 | `T-C5`, `T-C8a`, T27.5 |
| Run N's write injected verbatim into run N+1 + provenance recorded | C4, C6, C7 | T27.2, `T-C6` |
| A mention-summoned agent reads its own prior memory | C4, C7, C10 | T27.3 (**the loop acceptance**) |
| Two concurrent runs cannot silently clobber (loser gets content + hash) | C7 AC4 | `T-C7a` |
| Package re-pin preserves; detach inert; re-attach revives | C10 | `T-C10` |
| Workspace-mode `none` maintains memory | C8 AC3 | `T-C8a` |
| Oversized/corrupt degrades with a visible warning, never blocks | C5 | `T-C5` |
| Owner views, edits, clears in the admin UI (EN + RU) | C9 | `T-C9a`, `T-C9b` |
| Memory never leaks into the assistant pulse | C12 | `T-B1w` |
| All gates green; single main-lineage migration applies via `db:migrate` | C1 | `T-C1`, T28 |

## §11 · Non-goals (restated as guardrails)

No embeddings, vector search, or brain-ledger involvement for agent memory; `memory_recall` / `memory_propose` untouched. No cross-project or cross-agent sharing. No encryption. No autonomous consolidation job. No memory for flow `ai_coding` nodes or scratch runs (`run_kind='agent'` only). Memory content is **never** exposed in the pulse response. No package-shipped seed templates. No `memory_read` MCP tool (D17). No `readinessSummary` on the promotable item (D25). No contract test for `docs/api/web.openapi.yaml` (pre-existing gap, V34).

---

## §12 · Открытые вопросы

**Нет.** Семь закрыты 2026-07-27 при планировании, три — при `/aif-improve`.

| # | Решение | Где в плане |
| --- | --- | --- |
| 1 | Никакого shim'а. Ответы **никто** не валидирует по спеке (V34), спека и сервер едут одним коммитом. | D3 |
| 2 | Двухуровневый путь `agents/<enc(packageName)>/<enc(stem)>/memory.md`. Инъективность держится **пер-компонентным** кодированием. | D10, T18 |
| 3 | Cap = `32768` символов, env `MAISTER_AGENT_MEMORY_MAX_CHARS`. | D11, REQ-C11 |
| 4 | `isPhaseReady()` уже есть: `ready \|\| overridden`. **`overridden` выше `ready` в `READINESS_PRIORITY`** — сравнение `state === 'ready'` молча теряло promotable-раны. | D6a, V33 |
| 5 | Новый scope `agent_memory:write`. | D16 |
| 6 | Параллельных веток нет → renumber-pass не закладываю. | Reserved numbers |
| 7 | Тумблер Memory показываем **disabled + причина**. | D22, T26 |
| **8** | **Хеш памяти — колонка `runs.agent_memory_hash` в той же миграции 0122.** Файл `memory-snapshot.md` не переживает GC run-dir'а (7 дней), значит провенанс на одном файле — иллюзия. | **D23**, T16 |
| **9** | **Новый `ProjectAction` `writeAgentMemory` (`member`).** Без него `resolveProjectAction` молча падает в `readBoard` — viewer-уровень на write-операции. Фанаут скоупа = **5** точек, не 4. | **D16**, V37, T22 |
| **10** | **`readinessSummary` вырезан.** Источника нет: `computeReadinessByRun` отдаёт только `ReadinessState`, а сводка требовала бы запрещённого `getRunReadiness`. Плюс по построению состояние всегда `ready`/`overridden` — сводка пустая. | **D25**, T6 |

### Поправки к премиссам запроса и к первой редакции плана (проверено по коду)

- **«ADR-133 superset»** — ADR-133 это *"Versioned read-only evidence and run-owned package materialization"*. Схема — `agentDefinitionFrontmatterSchema` (V25).
- **`<flowRefId>:<stem>`** — реальный id агента `<packageName>:<stem>` (V13). От этого зависит путь к `memory.md`.
- **`needsYouCount`** — не поле ответа, только debug-лог (V5).
- **i18n `projectSettings.agents`** — такого namespace нет; в каталогах `agentsAttach` (V28).
- **⚠ «promotable = что примет `promoteRun`»** — **неверно** (V10ʹ). `promoteRun` отказывает по `promotionHold` только при `attribution.source === "auto_promotion"`, а по launched-lineage — только при `isUnattendedPromotion`. Комментарий в коде дословно: *"Only HUMAN promotes set neither flag, so they are allowed."* Предикат разделён на два слоя, второй — осознанное расхождение (D5ʹ), и тестируется отдельно.
- **⚠ «в тот же `Promise.all`, что `listProjectNeedsYou`»** — такого `Promise.all` нет (V35); `needsYou` ждётся последовательно и является **входом** для `buildRunSnapshot`. Параллельную выборку надо **создать**.
- **⚠ «застампить хеш на run-записи»** — колонки не существовало (V36). Теперь есть, D23.
- **⚠ `promotion_hold IS NOT TRUE`** — найдено при T6 (2026-07-27): колонка `runs.promotion_hold` — **`jsonb`** (`PromotionHold | null`, `schema.ts:1874`), не boolean. `IS NOT TRUE` по jsonb = ошибка типа в Postgres. Правильный предикат — `IS NULL` / `isNull(runs.promotionHold)`; `promoteRun` проверяет обычную truthiness (`promote.ts:623`). Исправлено в REQ-A2 AC2 и T9.
- **⚠ `runs.task_id` NULLABLE** — найдено при T6: `taskId` без `.notNull()` (`schema.ts:1725`), поэтому `taskId`/`taskKey`/`taskTitle` в `ExtPromotionReadyItem` объявлены nullable, как в `ExtNeedsYouItem`.
