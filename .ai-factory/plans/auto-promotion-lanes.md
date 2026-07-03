# Implementation Plan (SDD): Tact 3 — Auto-Promotion Lanes

Branch: `claude/optimistic-leakey-8fde07` (session worktree — no separate `feature/*` branch created; this worktree IS the isolation, matching the Tact-1/Tact-2 pattern)
Created: 2026-07-02

## Settings
- Testing: yes — TDD RED→GREEN→REFACTOR; unit (pure fns) / integration (testcontainers real-PG + real git fixtures + mock promote deps) / route tests / one stub-supervisor-style e2e pair
- Logging: standard — INFO on promote/give-up, DEBUG per-candidate verdicts, WARN on non-fatal follow-up failures; pino child logger `pino({name:'auto-promote'})` per the `auto-delivery`/runner precedent (improve-pass: repo uses pino, not bracket prefixes)
- Docs: yes — mandatory docs checkpoint; Phase 0 is docs-first and blocks code phases

## Roadmap Linkage
Milestone: "none"
Rationale: Tact series is owner-directed outside the M-roadmap; this completes the delivery half of the VISION autonomy loop (front half = triage → `auto_launch_triaged`, ADR-112/121).

---

## 1. Problem statement & verified premise

Every flow promotion today ends in a human click on `promoteRun` even when readiness is green and the diff is three Markdown files. This tact adds **auto-promotion lanes**: project-scoped, path/content-bounded diff classes (v1: `docs | tests | deps | config`) promoted by a system sweep through the **same** `promoteRun` choke point. Everything outside an enabled lane behaves exactly as today.

Recon-verified premise (2026-07-02, this branch @ `a0c99fdd`):
- `promoteRun(runId, input, ctx, db?)` at `web/lib/runs/promote.ts:1583`; `PromoteRunInput` has `mode?`, `deliveryPolicyOverride?`, `targetBranch?`, `reviewedTargetCommit?`, `allowTargetDrift?`, `autoOnReady?` (:64-71); `PromoteRunContext.actor?: {kind:'user'|'agent'|'system'}` (:73-86).
- **Concurrency guard already EXISTS**: `workspaces` row `FOR UPDATE` + `promotionAttemptId` token CAS (claim tx :462-667, finalize token re-check :770-773, `RECLAIMABLE_STATES = {none, failed}`). A concurrent second caller gets `MaisterError("CONFLICT")` and never attempts the git merge. → **REUSE, do not build** (FR-5 "recon what exists" resolved).
- In-path readiness re-gate: `assertEvidenceReady(runId, "review", tx)` (`web/lib/flows/graph/evidence-readiness.ts:67`, called at promote.ts:573) → `PRECONDITION`. Re-runs inside the claim tx ⇒ the eval-vs-promote staleness window is closed by the choke point itself.
- Target-drift gate (promote.ts:592-627): `reviewedTargetCommit` required **unless `autoOnReady: true`** — the established waiver for system promotions.
- Conflict path: merge/rebase abort → `CONFLICT`, run stays `Review`, workspace `promotionState='failed'` (reclaimable); human callers get a `merge_conflict` assignment, system callers don't (:715-764).
- On success: `runs.status='Done'` (+ shared-tree children fan-out :900-940), `workspaces.{promotionState:'done', promotedAt, scheduledRemovalAt, prUrl/prNumber}`, webhook `run.promoted` + `run.done`, domain event `run.done`, assignments closed, diff artifact recorded. **No new event kinds needed** (FR-7 resolved).
- PR mode is fully implemented (`selectPrAdapter` → preflight → push → `createOrUpdatePr`, promote.ts:1068-1130); after PR creation the run flips **`Done`** immediately — that IS the "existing PR-promotion semantics" AC-9 references.
- Scratch runs dispatch inside `promoteRun` to `promoteScratchRun` (:1592); orchestrator children promote via `promoteChildRunForToken` (:1609) / ext route `web/app/api/v1/ext/runs/promote/route.ts:175`.
- **An unconditional auto-promotion path already exists**: `deliverRunIfAutoReady` (`web/lib/runs/auto-delivery.ts:50`, invoked inline at both Review flips — runner.ts:1039, runner-graph.ts:4209) promotes when **EITHER** knob says so: `deliveryPolicySnapshot.trigger === 'auto_on_ready'` **OR** `promotionFromSnapshot(execution_policy) === 'auto_on_ready'` (OR-combined, auto-delivery.ts:81-85; as-plan children additionally via `web/lib/domain-events/auto-launch.ts:193,216`). On any promote error it self-disarms via `switchRunToManual` (CAS on the trigger, :25-48) — the precedent our give-up hold mirrors. Lanes must compose with it, not duplicate or race it (→ §4.4 term 8, D-6).
- Diff source: `diffChangeStats` (`web/lib/worktree.ts:2047`) → `DiffChangeStatEntry {path, status, oldPath?, additions, deletions, binary}` with `--find-renames` (status `R` + `oldPath`). Base = `workspaces.baseCommit` / merge-base (run scope).
- Review-entry anchor: the flow Review flips emit only the WEBHOOK `run.review` today (`runner.ts:1025-1037`, `runner-graph.ts:4225-4237` — the adjacent Failed/Crashed branches emit webhook+domain paired; Review doesn't). ⚠ The domain kind `run.review` is a live **SETTLED** kind (`web/lib/domain-events/taxonomy.ts:51`, `RUN_SETTLED_EVENT_KINDS`) consumed by **7** registered consumers (`consumers.ts:62-78`), including user-configurable `agentTriggers` (bindable to `run.review` — `triggers.ts:211`, `schema.ts:3300/3769`, `launch.ts:1776`) and `orchestratorResume` (`orchestrator-resume.ts:135`). Emitting a top-level `run.review` domain event at flow Review flips would silently fire configured agents on every flow→Review and add a seq-scan (no `domain_events(run_id,kind)` index). → the grace anchor is a new **`runs.review_entered_at` column** stamped at the Review-flip sites (consumed by nobody), NOT a domain event (D-3 revised, T8).
- Policy checks axis: `runs.execution_policy` (schema.ts:1099) → `checksFromSnapshot()` (`web/lib/runs/execution-policy.ts:367`) → `"strict" | "advisory" | "skip"` (defaults strict on null/malformed — the platform's own default semantics).
- Gates: `gate_results.gateId` = flow-declared id (schema.ts:2254); `external_check` latest-per-gateId collapse in `web/lib/flows/graph/readiness-core.ts` — the string `requireExternalCheckId` matches against.
- Config precedent: `projects.taskQueueSettings` jsonb (schema.ts:144) + aggregating `PATCH /api/projects/[slug]/settings` (`route.ts:25-33` `patchBodySchema`, `editSettings` gate) + `QueueSettingsControl` (`web/components/board/panels/queue-settings-control.tsx`) hosted by `settings-panel.tsx:133-139`. OpenAPI: `ProjectSettingsPatchBody`/`TaskQueueSettings`/`ProjectSettingsResponse` (web.openapi.yaml:11180-11227).
- Sweep precedent: `auto_launch_triaged` (`web/lib/scheduler/handlers/auto-launch-triaged.ts`; budget 1 at `budgets.ts:40`; 60 s at `jobs.ts:120`; give-up = flag + ONE comment on terminal refusal, silent retry on transient).
- System comments: `addTaskComment` (`web/lib/social/comments.ts:49`) accepts `actor {type:'system', id:null}`, takes a `db`/tx param, expands mentions and fans out to inbox **in the same transaction** (`web/lib/social/inbox.ts:22`); worked example `web/lib/agents/dirty-watchdog.ts:159`. `addTaskComment` also records `comment_added` task_activity — **no new task_activity kind needed**.
- `picomatch@4.0.4` already in `web/package.json` (:79) — no new dependency.
- `runs.run_kind ∈ {flow, scratch, agent}` (schema.ts:1291); `runs.parentRunId` (:1418); `runs.workspaceMode` (`shared` trees fan out promotion — ADR-102); `runs.deliveryPolicySnapshot` (:1412).
- Hold/skip fields on runs: **ABSENT** → migration.
- Experiments substrate (Tact-2): **ABSENT on this branch** → the experiment-exclusion predicate term is a merge-coordination obligation (§8 MO-3), not codeable here.
- Launch options: `postBodySchema` `web/app/api/runs/route.ts:28-45` (`.strict()`, `allowConcurrent` precedent at :43); dialog `web/components/board/launch-popover.tsx` `buildLaunchBody` (:172); service `launchRun` in `web/lib/services/runs.ts`.

## 2. Goals / Non-goals

Goals: FR-1…FR-8 of the planning request; hands-free `triaged task → auto-launch → gates → auto-promote → Done` for lane-bounded diffs; no-blind-ship **extended** (evidence rules untouched; only the click is removed).

Non-goals (record in ADR): code-class lanes; earned-trust lane widening (Phase-2 direction); PR lifecycle beyond creation (PR-automerger agent = Phase-2 direction); full per-format lockfile consequence-proof (Phase-2 — v1 uses specifier allow-list + no-lockfile-only + best-effort scan, D-11); deploy/release mgmt; per-flow lane overrides; notification channels; readiness/gate semantics changes; retroactive backfill (runs already in Review evaluate on the next tick); configurable deny-list; ext/MCP surface for lane config or holds (web API only in v1); changes to the existing `auto_on_ready` path.

## 3. Reserved numbers (2026-07-02) — collision guards

- **ADR-126 — claimed** (moved from 125 during the improve pass). Max **committed** = ADR-122 post-rebase (ADR-122 = project-brain, now **landed on main**, `docs/decisions.md`); ADR-123/124 presumed held by Tact-2; **ADR-125 is CONFIRMED taken by the budget-breach-fork plan** (owner-approved, uncommitted on another worktree — discovered 2026-07-02 via the cross-session memory index, exactly the parallel-branch squat the numbering rule warns about). Owner confirmed reservations exist but exact numbers are unconfirmed → numbers stay as claimed here; the post-rebase renumber pass (T21/MO-1) is the authoritative resolution. Write the `### ADR-126` stub header + Index row (Status: Proposed) in `docs/decisions.md` in Phase 0 so citations resolve.
- **Migration `0089_auto_promotion_lanes`** — local-next **post-rebase**: this branch is now rebased onto main, whose journal max = `0088_mixed_hercules` (the brain work, ADR-122) — so the old `0087` premise is stale and true local-next is `0089`. ⚠ Tact-2 may also claim `0089`. → **Phase 5 mandatory renumber pass** at merge: renumber file+journal to true next-free, keep journal `when` **monotonic above DB max** (known hazard; boot guard exists), regenerate via `drizzle-kit generate` — never hand-edit the snapshot. A green `pnpm validate:docs` is NOT numbering evidence; run `node scripts/validate-docs-adr-anchors.mjs`.
- New scheduler job kind `auto_promote` — no numeric namespace, but **12 registration points** (§4.6) must all be touched in one task.

## 4. SPECIFICATION (the contract — authored in Phase 0, binds all tests)

### 4.1 Data model (migration 0089, `web/lib/db/schema.ts`)

| Table | Column | Type | Null | Default | Notes |
|---|---|---|---|---|---|
| `projects` | `auto_promotion` | `jsonb` | NULL | NULL | zod `autoPromotionConfigSchema`; NULL ⇒ shipped defaults with master OFF (mirrors `task_queue_settings`) |
| `runs` | `promotion_hold` | `jsonb` | NULL | NULL | `{source:'user'\|'system'\|'launch', reason?: string, createdAt: string}`; NULL ⇒ no hold. Survives rework by construction (never cleared by state transitions) |
| `runs` | `review_entered_at` | `timestamptz` | NULL | NULL | stamped by every flow Review-flip alongside `status='Review'` (T8); the grace-window anchor (§4.4 term 16), read by PK. NULL ⇒ no anchor ⇒ fail-closed (legacy pre-column runs stay manual). Re-stamped on rework re-entry ⇒ window restarts. Consumed by no domain-event consumer (the D-3 revision — see §9) |
| `workspaces` | `promotion_lane` | `text` | NULL | NULL | lane class written by `promoteRun` finalize when the input carries auto-promotion attribution; the queryable "auto" glyph datum |

One migration, **four** ALTERs (≤1-migration budget honored). Generated via `drizzle-kit generate` (snapshot hazard memory).

### 4.2 Lane config schema (single source of truth: `web/lib/auto-promotion/config.ts`)

```ts
laneClassSchema = z.enum(["docs", "tests", "deps", "config"]);
autoPromotionLaneSchema = z.object({
  class: laneClassSchema,
  enabled: z.boolean(),
  mode: z.enum(["local_merge", "rebase_merge", "pull_request"]).optional(), // omitted ⇒ promoteRun's own policy resolution
  delayMinutes: z.number().int().min(0).max(1440).default(10),
  requireExternalCheckId: z.string().min(1).optional(),
  excludeGlobs: z.array(z.string().min(1)).max(64).optional(),
}).strict();
autoPromotionConfigSchema = z.object({
  enabled: z.boolean(),                       // master toggle, shipped false
  lanes: z.array(autoPromotionLaneSchema).max(4),
}).strict();
```

- `BUILT_IN_LANES`: all four classes, `enabled: true`, `delayMinutes: 10`, no mode/check/excludes — so flipping the master ON needs zero tuning (AC-8).
- `resolveAutoPromotionConfig(projectRow)`: NULL column ⇒ `{enabled:false, lanes: BUILT_IN_LANES}`; stored config validated with `safeParse` — **malformed ⇒ treated as disabled** (fail-closed) + WARN log; a stored config's lanes are normalized so each class appears at most once (dedupe keeps first).
- Built-in class path sets (fixed beyond `excludeGlobs`; matched with `picomatch` **`{dot: true}`** — the config lane is all dotfiles):
  - `docs`: `**/*.md`, `**/*.mdx`, `docs/**`, plus doc image assets `docs/**/*.{png,jpg,jpeg,gif,svg,webp}`;
  - `tests`: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `e2e/**`, `**/e2e/**`, `**/__fixtures__/**`, `**/fixtures/**`;
  - `deps`: `**/package.json`, `pnpm-lock.yaml`, `**/pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` (+ manifest & lockfile content check §4.3);
  - `config`: `.gitignore`, `.gitattributes`, `.editorconfig`, `.prettierrc*`, `prettier.config.*`, `eslint.config.*`, `.eslintrc*`, `stylelint*`, `.stylelintrc*`, `markdownlint*`, `.markdownlint*` (each at repo root AND `**/`-nested). Deliberately NOT: `tsconfig*`, `Dockerfile*`/`compose*`, husky/git hooks, package manifests.
- `HARD_DENY_GLOBS` (non-configurable, `web/lib/auto-promotion/classify.ts` const): `.github/workflows/**`, `.env*`, `**/.env*`, `maister.yaml`, `**/maister.yaml`, `CLAUDE.md`, `**/CLAUDE.md`, `AGENTS.md`, `**/AGENTS.md`, `GEMINI.md`, `**/GEMINI.md`, `.claude/**`, `.codex/**`, `.agents/**`, `.ai-factory/**` (root-anchored agent dirs). Evaluated BEFORE lane matching, against **both** `path` and rename `oldPath`.

### 4.3 Classifier + deps content check (pure, `web/lib/auto-promotion/{classify,deps-check}.ts`)

- Input: `DiffChangeStatEntry[]` (from `diffChangeStats`, run scope `baseCommit..branch`) + resolved config. Output: discriminated verdict (§4.5 reason codes). Deny-list first → `{denied, files[]}`. Then, **per file**, compute the set of enabled lanes whose globs match it (after deny-list + `excludeGlobs` subtraction), matching **both** `path` and (for renames) `oldPath` in the same file's lane-set — a rename INTO docs FROM src is not docs-only; deletions/binary classified by `path`. ⚠ The built-in globs are **NOT disjoint** (`**/__tests__/**` ∩ `**/*.md`; `**/__fixtures__/**` ∩ `**/package.json`; `docs/**` ∩ `**/e2e/**`), so a file can match ≥2 lanes and this MUST be handled, not assumed away. Per file: **0** matching lanes ⇒ `no_lane`; **≥2** ⇒ `ambiguous_lane` (both name the first offending files). A diff is **eligible iff every file matches exactly one enabled lane AND all files share the same lane**; files split across ≥2 distinct single-match lanes ⇒ `no_lane` (mixed); empty diff ⇒ `empty_diff`. An `excludeGlob`-subtracted file that then matches 0 lanes ⇒ `no_lane` (fail-to-manual).
- `deps` content check (manifest + lockfile, pure — codex F1 hardening, D-11):
  - **Manifest:** for every changed `package.json`, load both sides (base via existing git file-at-ref read used by the workbench repo-file routes — reuse, do not shell out ad hoc; branch side from the worktree/branch ref). `JSON.parse` both — **any parse failure ⇒ disqualify, never throw**. Deep-compare: the ONLY allowed differences are value changes at `(dependencies|devDependencies|peerDependencies|optionalDependencies).<name>` where the key exists on BOTH sides **AND both the old and new value pass `isRegistryVersionSpecifier`** — a strict allow-list accepting bare semver and range syntax (caret/tilde/comparators/hyphen-ranges/`x`-ranges/`*`/`||`/exact pins) and REJECTING any specifier carrying a protocol or path: `file:`, `link:`, `portal:`, `git`/`git+…`, `github:` / `<owner>/<repo>` shorthand, `ssh:`, `http(s):`, `workspace:`, `npm:`-alias, or a path (`./`, `../`, `/`). A rejected specifier on EITHER side ⇒ disqualify (**protocol-swap defense**). Key added/removed anywhere (incl. inside dep blocks), or any change outside those four blocks ⇒ disqualify with the offending JSON path in the verdict detail. Manifest file deleted/added (status A/D) ⇒ disqualify.
  - **Lockfile:** a **lockfile-only diff — any changed lockfile with NO changed `package.json` in the same run diff ⇒ disqualify** (`deps_content`, detail `lockfile change without manifest evidence`): no unattended shipping of a changed dependency graph that no manifest explains. When a lockfile changes ALONGSIDE a validated manifest change, a cheap **lockfile specifier scan** (both sides read via the same file-at-ref util; introduced-line set-difference) disqualifies if any added resolution line points at a non-registry source (`git`/`git+`/`file:`/`link:`/`portal:`/`ssh:`, or an `http(s)` host outside the registry allow-list). Best-effort textual guard, NOT a full parse.
  - **Residual (documented, ADR-126, Risk R4):** a lockfile riding a valid manifest bump could still alter transitive resolutions the scan misses; full per-format lockfile-consequence-proof (pnpm/npm/yarn) is a **Phase-2** hardening. v1 stays fail-closed at the two concrete holes (protocol-swap, lockfile-only) + the best-effort scan — every disqualification is fail-to-manual.
- Determinism: classifier + deps check are pure and shared verbatim by sweep and panel (FR-2 ONE-function requirement — consistency-pass item).

### 4.4 Eligibility predicate (server-side, fail-closed; `web/lib/auto-promotion/evaluate.ts` — the ONE shared evaluation function)

`evaluateAutoPromotion({run, project, files, db}) → AutoPromotionEvaluation`. A run is `eligible` iff ALL hold (each term has an owning test, §7):

| # | Term | Source of truth |
|---|---|---|
| 1 | platform env switch on (`MAISTER_AUTO_PROMOTION` ≠ `off`; unset ⇒ on) | helper `autoPromotionEnabledFromEnv()`, direct `process.env` read per repo convention |
| 2 | project master `enabled === true` (resolved config; malformed ⇒ disabled) | `resolveAutoPromotionConfig` |
| 3 | `runs.status = 'Review'` | runs row |
| 4 | `runs.run_kind = 'flow'` | allow-list, not deny-list |
| 5 | `runs.task_id IS NOT NULL` | runs row |
| 6 | `runs.parent_run_id IS NULL` (not an orchestrator child) | runs row |
| 7 | `runs.workspace_mode ≠ 'shared'` (shared-tree promotion fans out to children — multi-run blast radius; fail-closed v1 addition, decision D-7) | runs row |
| 8 | NOT auto-delivering already: `delivery_policy_snapshot.trigger ≠ 'auto_on_ready'` **AND** `promotionFromSnapshot(execution_policy) ≠ 'auto_on_ready'` — the two knobs OR-combine in `deliverRunIfAutoReady` (auto-delivery.ts:81-85), so the exclusion must OR them too; reuse `promotionFromSnapshot` (`web/lib/runs/execution-policy.ts`). Either knob set ⇒ verdict `not_applicable` (D-6) | snapshot columns + policy helper |
| 9 | `runs.promotion_hold IS NULL` | new column |
| 10 | deny-list clean (§4.2, path + rename oldPath) | classifier |
| 11 | exactly one enabled lane matches ALL files (+ deps content check for `deps`) | classifier |
| 12 | `checksFromSnapshot(runs.execution_policy) === 'strict'` (relaxed/skip ⇒ never eligible — the no-blind-ship extension) | policy helper |
| 13 | no open HITL (`hitl_requests` row with `response IS NULL` absent — belt over the status=Review term) | existing tables |
| 14 | readiness green: read-only evaluation via the same readiness classifier `promoteRun` enforces (`readiness-core` live blocking gates + required artifacts). No synthesized approvals — a blocking `human_review` gate must have genuinely passed. The choke point re-asserts transactionally at promote time (staleness window closed there) | readiness-core |
| 15 | `requireExternalCheckId` (if set on the matched lane): a `gate_results` row with `gateId = <id>`, `kind='external_check'`, on live attempts, latest status ∈ {passed, overridden} exists (readiness-core latest-per-gateId collapse). The id **declared** in the flow but not yet passed ⇒ `external_check_not_passed`; the id **not declared in the compiled FlowGraph at all** (the `flow_revisions` graph gate set — the declared-gate source, distinct from `gate_results` evidence rows) ⇒ `external_check_missing` (misconfig surfaced on the panel, not a crash). Both ⇒ ineligible/fail-to-manual | compiled FlowGraph gates (declared) + gate_results via readiness-core collapse (evidence) |
| 16 | grace elapsed: `now ≥ reviewEnteredAt + delayMinutes`, where `reviewEnteredAt = runs.review_entered_at` (the column, T8). NULL ⇒ `ineligible: no_review_anchor` (fail-closed; legacy runs stamped before this ships stay manual). Rework re-entry re-stamps the column ⇒ window restarts | runs row |
| 17 | *(Designed, NOT codeable on this branch)* not a member of a non-concluded experiment — Tact-2 substrate absent here; permanent invariant recorded in ADR-126 + doc as **Designed**; wiring = merge obligation MO-3 | — |

Any failed term ⇒ `ineligible`/`not_applicable`/`held`/`disabled` verdict with a closed `reasonCode` — silently (panel explains; NO comment). Ineligibility is always fail-to-manual, never fail-to-stuck: the run stays in `Review`, the human Promote button keeps working.

### 4.5 Evaluation verdict type (panel DTO = sweep decision)

```ts
type AutoPromotionEvaluation =
  | { verdict: "eligible"; lane: LaneClass; mode: EffectiveLaneMode; reviewEnteredAt: string; eligibleAt: string }
  | { verdict: "held"; hold: PromotionHold }
  | { verdict: "ineligible"; reason: IneligibleReason; files?: string[]; detail?: string; eligibleAt?: string }
  | { verdict: "disabled"; scope: "platform" | "project" }
  | { verdict: "not_applicable"; reason: "status" | "run_kind" | "no_task" | "orchestrator_child" | "shared_workspace" | "auto_on_ready" };
type IneligibleReason = "deny_list" | "no_lane" | "ambiguous_lane" | "empty_diff" | "deps_content" | "checks_not_strict" | "pending_hitl" | "readiness_not_green" | "external_check_missing" | "external_check_not_passed" | "no_review_anchor" | "grace_pending" | "config_invalid";
```
`grace_pending` carries `eligibleAt` (the optional field on the `ineligible` variant, set only for `grace_pending`) so the panel renders the countdown. `reasonCode → i18n label` map; `files`/`detail` rendered verbatim (untranslated), labels translated (edge-case E10).

### 4.6 Sweep (`auto_promote` scheduler job — mirrors `auto_launch_triaged`)

systemManaged singleton, budget **1**, interval **60 s**, seeded id `auto_promote.default`. **All registration points** (one task, exhaustive — the "4th registration point" gotcha generalized):
1. `SchedulerJobKind` union `web/lib/db/schema.ts:607-615`; 2-3. `jobKind` enum on `schedulerJobs` (:630-640) + `schedulerJobRuns` (:689-700); 4. `web/lib/scheduler/job-catalog.ts` — `ALL_SCHEDULER_JOB_KINDS`, catalog record (systemManaged, NOT creatable), `SEEDED_SINGLETON_IDS`; 5. `web/lib/scheduler/budgets.ts:3-11,26-42`; 6. budget switch `web/lib/scheduler/jobs.ts:129-147`; 7. **`claimDueJobs` CTE CASE ×3** `jobs.ts:354-409`; 8. dispatch switch `web/lib/scheduler/tick-service.ts:86-179`; 9. `ensureDefaultSchedulerJobs` INSERT `jobs.ts:170-331`; 10. OpenAPI `jobKind` enums ×2 `docs/api/web.openapi.yaml:6833-6843,6870-6880`; 11. `docs/system-analytics/scheduler.md:244-247` + job description block; **12. i18n job-kind label** `messages/{en,ru}.json` `jobKind.auto_promote` (+ `targetHint.auto_promote`) — enforced by closure tests (`job-catalog.test.ts` "every kind exactly once"; `scheduler-jobs-table.test.ts` "offers every kind in the filter", since `FILTERABLE_SCHEDULER_JOB_KINDS = ALL_SCHEDULER_JOB_KINDS`), so a missing label fails CI even for a systemManaged non-creatable kind. **Dispatch proof (codex F2):** point 8 is exercised end-to-end by a through-`runSchedulerTick({jobKind:'auto_promote'})` integration test (T13), so a missing dispatch arm fails CI instead of silently never promoting.

Handler `web/lib/scheduler/handlers/auto-promote.ts`:
```
if (!autoPromotionEnabledFromEnv()) return {skipped:'env'}          // within-one-tick kill switch
candidates = SQL prefilter: runs.status='Review' AND run_kind='flow' AND task_id IS NOT NULL
             AND parent_run_id IS NULL AND workspace_mode IS DISTINCT FROM 'shared'
             AND promotion_hold IS NULL AND projects.auto_promotion IS NOT NULL   (cheap; config/enabled re-checked in code)
for each candidate (bounded, e.g. LIMIT 20 per tick):
  eval = evaluateAutoPromotion(...)          // FULL re-evaluation at claim time — a lane disabled
  if eval.verdict !== 'eligible' → skip      // between ticks is re-read here (edge E4)
  try promoteRun(run.id, { autoOnReady: true, mode: lane.mode, attribution: {source:'auto_promotion', laneClass} },
                 systemPromoteCtx(run.projectId))
                 // ctx mirrors promoteChildRunForToken (promote.ts:1626-1635), the established NON-user
                 // caller: placeholder sessionUser {id:'auto-promotion:<projectId>'} (never dereferenced for
                 // non-user actors — owner resolves null, conflict-assignment skipped), authorize: async()=>{},
                 // actor: {kind:'system'}. NOT auto-delivery's ctx (it attributes to createdByUserId as a
                 // USER actor and degrades on NULL creator — FR-7 requires system attribution instead).
  on success → tx: addTaskComment(system, "auto-promoted via <lane> — N files, readiness ✓, evidence: /runs/<id>")
  on CONFLICT | terminal PRECONDITION | CONFIG →
      one tx: CAS UPDATE runs SET promotion_hold={source:'system', reason} WHERE id=:id AND promotion_hold IS NULL
              RETURNING → if row returned, addTaskComment(system, reason) in the SAME tx   // exactly-ONE comment, proven by the CAS
  on EXECUTOR_UNAVAILABLE | transient → skip, retry next tick (no hold, no comment)
```
- Cross-caller race safety = `promoteRun`'s existing claim token (verified premise). The sweep's own singleton lease (budget 1 + `claimDueJobs` CAS) prevents overlapping ticks during a long merge (edge E8).
- Give-up never retry-loops: the hold makes the run invisible to the prefilter (term 9). Held runs re-enter evaluation ONLY after explicit release.
- **Crash windows** (multi-store rule): (W1) crash after `promoteRun` success, before success-comment tx → run is Done, glyph correct (`workspaces.promotion_lane` written inside finalize), webhooks/domain events fired; ONLY the task comment is missing. Accepted residual (documented in ADR-126): candidate predicate excludes Done runs so no retry/dup; "exactly one comment" = at-most-one. (W2) crash after conflict, before hold tx → workspace `promotionState='failed'` (reclaimable); next tick re-evaluates, re-attempts, conflicts again deterministically, and sets hold+comment then — converges, no dup comment (CAS). (W3) crash mid-`promoteRun` → covered by the existing claim-timeout reclaim (`promotionClaimTimeoutSeconds`), not this feature's concern.

### 4.7 promoteRun attribution delta (the ONLY choke-point change)

`PromoteRunInput` gains optional `attribution?: { source: "auto_promotion"; laneClass: LaneClass }`. The finalize txs (merge :767-1027 and PR :1140-1269 variants) write `workspaces.promotion_lane = laneClass` alongside `promotionState='done'`. No behavior change for callers that omit it; scratch path never receives it. Board "auto" glyph + panel "promoted automatically via lane X" derive from `workspaces.promotion_lane IS NOT NULL`. No readiness/evidence/target-gate semantics change (Expectation X1).

### 4.8 API contract deltas (`docs/api/web.openapi.yaml` — touched artifacts redocly-clean; gate = T3 AC + MO-2)

| Route | Change | Identifier labels (skill-context D7 rule) |
|---|---|---|
| `PATCH /api/projects/{slug}/settings` (:965-1003) | `ProjectSettingsPatchBody` + `autoPromotion: AutoPromotionConfig \| null` (null clears to defaults+OFF); `ProjectSettingsResponse` mirrors | `slug` url-param; body = config values only, NO cross-resource ids |
| `PUT /api/runs/{runId}/promotion-hold` (new) | set hold `{reason?}` → 200 `{hold}`; idempotent re-PUT overwrites reason, keeps `source:'user'` | `runId` url-param; `projectId` server-state via run row; body has NO locators |
| `DELETE /api/runs/{runId}/promotion-hold` (new) | clear hold (any source) → 200; run re-enters normal evaluation | same |
| `GET /api/runs/{runId}/auto-promotion` (new — no bare run-detail GET exists; sibling-route convention per `/delivery-policy` :4443) | returns `{evaluation: AutoPromotionEvaluation \| null, promotedLane: string \| null}` (evaluation computed via §4.4 for Review flow runs; null otherwise); authz `readBoard` (read-only, run-scoped, mirrors the diff route); the run-detail RSC embeds the same object server-side for first paint — both call the ONE evaluator | `runId` url-param; no body |
| `GET/POST /api/cron/tick` `jobKind` enums | + `auto_promote` | — |
| `POST /api/runs` body | + `autoPromote?: boolean` (default true; `false` ⇒ launch writes `promotion_hold={source:'launch'}`) | body boolean, no locators |

Hold routes are pure DB (no downstream side-effect) ⇒ the two-phase-commit rule is satisfied trivially; authz = `requireProjectAction(projectId, "promoteRun")` (same authority that could promote manually — decision D-9). No ext/MCP mirror in v1 (non-goal) ⇒ no `TOOL_SPECS` sweep needed.

### 4.9 Invariants (must-hold, testable)

- INV-1 Auto-promotion calls the SAME `promoteRun`; no second promotion path; no evidence/readiness rule is relaxed (`autoOnReady` waiver = the pre-existing system-promotion semantics).
- INV-2 Deny-list is evaluated before lanes, is not configurable, and a deny-listed file (incl. rename target/source) defeats EVERY lane, with files named on the panel.
- INV-3 The predicate is fail-closed: unknown file, ambiguous/zero lane, malformed config, missing anchor, non-strict checks, pending HITL, stale/failed/missing blocking gate ⇒ not eligible, silent; always fail-to-manual (human Promote unaffected).
- INV-4 A blocking `human_review` gate is never satisfied by this feature.
- INV-5 Exactly one promotion wins under concurrency (sweep vs human vs ext) — existing claim token; the loser gets `CONFLICT`; exactly one terminal transition.
- INV-6 Conflict give-up = today's manual conflict semantics + `promotion_hold{source:'system'}` + exactly ONE system comment (CAS-guarded); a held run is never retried.
- INV-7 deps lane admits ONLY registry-version-specifier value changes on both-sided dependency-block keys; non-version specifiers (`file:`/`link:`/`portal:`/`git`/`github:`/`ssh:`/`http(s)`/`workspace:`/`npm:`-alias/path), additions/removals/out-of-block/parse-failure, **and lockfile-only diffs (no manifest change)** disqualify without throwing; a lockfile riding a validated manifest passes a best-effort non-registry-resolution scan (full per-format consequence-proof = Phase-2 residual, R4).
- INV-8 Scratch, orchestrator-child, shared-workspace, and (once Tact-2 lands) non-concluded-experiment-member runs are never candidates — permanent, by design.
- INV-9 Grace timing derives from the `runs.review_entered_at` column (stamped at each Review-flip, consumed by no domain-event consumer — the D-3 revision); rework re-entry re-stamps (restarts the window); NULL ⇒ not eligible.
- INV-10 Sweep and panel render from ONE evaluation function — byte-identical verdicts for identical state.
- INV-11 `MAISTER_AUTO_PROMOTION=off` and the project master toggle stop NEW promotions within one tick; in-flight `promoteRun` calls complete; master default is OFF; a never-configured project gets the four shipped lanes + 10-min grace the moment the master flips ON.
- INV-12 Every auto-promotion is attributable from the task thread alone (system comment: lane, file count, readiness ✓, run link) and from data (`workspaces.promotion_lane`, system actor on the existing webhook/domain events).
- INV-13 All new strings EN+RU; the touched OpenAPI artifacts are redocly-clean — only the enumerated pre-existing baseline errors remain (task_64b9a8dd) and no error ships at a location this plan adds/edits; exactly one migration.

---

## 5. Implementation phases (TDD: RED → GREEN → REFACTOR)

> Every task: write its named failing tests FIRST, implement to green, refactor with suite green. Per-phase exit = `pnpm --filter maister-web typecheck && pnpm --filter maister-web test:unit && pnpm --filter maister-web test:integration` green + new test files confirmed globbed (unit: `lib/**/*.test.ts` + `__tests__`; integration: `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts` — `web/vitest.workspace.ts:13-39`; all planned paths match). Lint check-only via `npx eslint <changed paths>` (repo `pnpm lint` = `eslint --fix`, known whole-repo reformat hazard — never run bare).

### Phase 0 — SDD docs-first (MANDATORY, blocks all code)
- [x] **T1: ADR-126** in `docs/decisions.md` (stub header + Index row first, then full text): lanes model + shipped defaults; hard deny-list + prompt-injection rationale (CLAUDE.md is `*.md` and would auto-merge under docs; workflows/env = code-exec/secret surfaces; deny-list = security boundary, not a knob); no-blind-ship extension framing; relationship to the existing `auto_on_ready` autopilot (BOTH knobs — delivery trigger OR execution-policy C1 `promotionFromSnapshot`, OR-combined per auto-delivery.ts:81-85; lanes = diff-bounded autopilot; `auto_on_ready` runs are `not_applicable` to the sweep); give-up semantics + W1 accepted residual, with auto-delivery's error→`switchRunToManual` self-disarm (auto-delivery.ts:25-48) cited as the precedent the CAS-hold mirrors; PR-mode boundary (create-and-stop = existing Done-on-PR semantics; auto-merge → PR-automerger agent, Phase-2 direction); permanent exclusions incl. shared-workspace roots (D-7) and the Designed experiment term (MO-3); config-not-snapshotted decision (D-8); **deps-lane supply-chain hardening (D-11 — specifier allow-list, no-lockfile-only, best-effort lockfile scan) + its transitive-smuggle residual (R4)**; Phase-2 directions (earned-trust widening, PR-automerger, full per-format lockfile consequence-proof). AC: `node scripts/validate-docs-adr-anchors.mjs` green.
- [x] **T2: product docs** — `docs/PRODUCT_VIEW.md:81` promotion bullet rewritten (manual final action → manual by default; lane-bounded classes may auto-promote through the same choke point) + JTBD table row; root `CLAUDE.md` §8 promotion-policy note (docs-win rule: PRODUCT_VIEW is canonical, CLAUDE.md mirrors).
- [x] **T3: system-analytics + contract specs** (R5/R6/R7 of `docs/CLAUDE.md:204-269`):
  - `docs/system-analytics/workspaces.md` — new "Auto-promotion lanes" section: Purpose, entities (config/lane/hold/verdict), verdict state machine (`stateDiagram-v2`), sweep flow (`flowchart`), **Expectations = INV-1…13 (≤12 bullets — merge INV-12/13)**, Edge cases E1…E10 each → `MaisterError` code, Linked artifacts. This is the ONE canonical lanes doc (R7).
  - `docs/system-analytics/execution-policy.md` — cross-ref only: C1 `auto_on_ready` vs lanes boundary, link to workspaces.md (no duplication).
  - `docs/system-analytics/scheduler.md` — `auto_promote` kind in the shared-catalog list (:244-247) + seeded-singleton description.
  - ERD, all three artifacts (R4 gotcha): `docs/database-schema.md` + `docs/db/{projects-domain,runs-domain}.md` (workspaces lives in runs-domain — verify at edit) + consolidated `docs/db/erd.md` for ALL 4 columns (incl. `runs.review_entered_at`). Schema-doc parity acceptance: each column appears in Drizzle schema, migration snapshot, database-schema.md, domain ERD, `db/erd.md`.
  - `docs/configuration.md` env table: `MAISTER_AUTO_PROMOTION` row (values `on`(default)/`off`); `docs/error-taxonomy.md`: extend CONFLICT/PRECONDITION caller notes with the sweep (no new codes).
  - OpenAPI deltas per §4.8. AC (BLOCKING, codex F3): note `pnpm validate:docs` runs ONLY mermaid + ADR-anchor checks — it does **NOT** run redocly, so the contract gate is a SEPARATE required step. `pnpm validate:docs` green **AND** `npx @redocly/cli lint docs/api/web.openapi.yaml` reports **exactly** the enumerated pre-existing baseline errors — captured at Phase 0 by `{ruleId, JSON-pointer}` (the 2 known non-brain errors, task_64b9a8dd), NOT a count — and **zero** others; **any** lint error whose location falls in a path/schema/example this plan adds or edits is blocking. (A count-delta gate is insufficient: it can mask a new invalid path when a pre-existing error is coincidentally resolved.)
  - Implementation-status tags `(Designed)` everywhere, flipped per phase (R6). No spec section may describe code absent at its phase HEAD.

### Phase 1 — Pure domain core (no DB, no migration)
- [x] **T4 (RED first): config module** `web/lib/auto-promotion/config.ts` — §4.2 schemas, `BUILT_IN_LANES`, `resolveAutoPromotionConfig`, `autoPromotionEnabledFromEnv`. Tests `web/lib/auto-promotion/__tests__/config.test.ts`: NULL ⇒ defaults+OFF; malformed jsonb ⇒ disabled (fail-closed) — SET/CLEAR/re-SET round-trip of the column value (config-state symmetry rule); duplicate lane class deduped; env `off`/unset/garbage. LOG: WARN `[autoPromote.config] invalid stored config {projectId}` on safeParse failure.
- [x] **T5 (RED first): classifier + deny-list** `classify.ts`. Tests `classify.test.ts` — AC-2 complete: mixed docs+1 `.ts` ⇒ `no_lane`; empty ⇒ `empty_diff`; rename within docs ⇒ docs; rename src→docs ⇒ `no_lane` (oldPath rule); test-file deletion ⇒ tests; **glob-overlap property test**: built-in globs are NOT disjoint — a file matching ≥2 enabled lanes (`x/__tests__/notes.md` ⇒ docs∧tests; `x/__fixtures__/package.json` ⇒ deps∧tests) ⇒ `ambiguous_lane` (assert the classifier PRODUCES it, not that globs are disjoint); mixed single-match docs+tests ⇒ `no_lane`; deny fixtures: `CLAUDE.md` (docs would otherwise match — panel names file), `.github/workflows/x.yml`, `.env.local`, `maister.yaml`, `.claude/settings.json`, **rename INTO `.claude/`** (E9); dotfile matching (`.prettierrc` — `{dot:true}`); `excludeGlobs` subtraction ⇒ fail-to-manual; AC-4: `.prettierrc`+`eslint.config.js` ⇒ config; `tsconfig.json` ⇒ no lane; `Dockerfile` ⇒ no lane; binary image under `docs/` ⇒ docs. LOG: none (pure).
- [x] **T6 (RED first): deps content check** `deps-check.ts`. Tests `deps-check.test.ts` — AC-3 unit half: registry version-bump manifest+lockfile ⇒ eligible; `scripts` change ⇒ `deps_content`; dependency added ⇒ `deps_content`; removed ⇒ `deps_content`; malformed JSON ⇒ `deps_content`, no throw; **manifest value swapped to a non-registry specifier — one RED case per family (`file:../x`, `git+https://…`, `github:o/r`, `link:../p`, `portal:../p`, `workspace:*`, `npm:alias@1`, bare path) on the new side AND (separately) the base side ⇒ `deps_content`** (protocol-swap defense; skill-context sibling-sweep — every rejected-specifier family owns a case); **lockfile-only diff (no changed package.json) ⇒ `deps_content`** (flipped from eligible, F1); **lockfile introduces a non-registry resolution alongside a valid manifest bump ⇒ `deps_content`** (specifier-scan); manifest added (status A) ⇒ disqualify. LOG: none (pure).
- [x] **T7 (RED first): evaluation function** `evaluate.ts` — §4.4 terms 1-16 composed over injected inputs (run row, project row, files, gate/HITL/anchor readers — injectable for unit tests). Tests `evaluate.test.ts`: **one owning test per predicate term** (each term flipped individually against an otherwise-eligible fixture, incl. `auto_on_ready` ⇒ `not_applicable`, shared workspace, checks `advisory`/`skip`, hold, `no_review_anchor`, `grace_pending` w/ eligibleAt, `external_check_missing` vs `not_passed`); verdict i18n-code closure (every `IneligibleReason` has a message key — asserted against `messages/en.json`). LOG (pino): DEBUG `evaluated {runId, verdict, reason?}`.

### Phase 2 — Persistence + choke-point delta
- [x] **T8 (RED first): `runs.review_entered_at` grace anchor — column stamp, NOT a domain event (D-3 revised).** Set `review_entered_at = now()` inside the SAME `UPDATE runs SET status='Review' …` at EVERY flow Review-flip site: `web/lib/flows/runner.ts:1025-1037`, `web/lib/flows/graph/runner-graph.ts:4225-4237`, `web/lib/runs/resume-driver.ts:~305`, plus a grep sweep for any other `status: "Review"` writer (beware dynamic writers). **Do NOT emit a `run.review` domain event at these top-level flow flips.** `run.review` is a live SETTLED kind (`taxonomy.ts:51`) consumed by 7 registered consumers — a top-level emit would fire user-configured `agentTriggers` bound to `run.review` (`triggers.ts:211`; bindable per `schema.ts:3300/3769` + `launch.ts:1776`) and wake `orchestratorResume` (`orchestrator-resume.ts:135`, safe only by its null-`parentRunId` guard); the column is consumed by nobody and read by PK (no `domain_events` seq-scan). Integration test `web/lib/auto-promotion/__tests__/review-anchor.integration.test.ts`: first Review entry stamps the column; rework→re-Review re-stamps a fresh timestamp; **regression probe: a top-level flow Review flip adds NO `run.review` domain_events row** (guards against a future re-introduction of the emit). Files: the three Review-flip sites + the test. LOG: none.
- [x] **T9: migration 0089 + schema** — §4.1 **four** columns (incl. `runs.review_entered_at`) via `drizzle-kit generate`; `web/lib/db/schema.ts` + types. Post-rebase number = `0089` (main's journal max is now `0088_mixed_hercules`); T21/MO-1 renumbers to true next-free if Tact-2 also took 0089. Tests: migrate clean on fresh + existing DB (existing harness); all four columns present. Journal `when` monotonic above DB max (hazard memory). LOG: n/a.
- [x] **T10 (RED first): launch opt-out + hold write** — `postBodySchema` + `autoPromote` (route.ts:28-45); `launch-popover.tsx` `buildLaunchBody` threads it; `launchRun` (`web/lib/services/runs.ts`) writes `promotion_hold={source:'launch', createdAt}` at run INSERT when `false` (launch-time decision persisted on the run — snapshot rule). Tests: route integration — launch with `autoPromote:false` ⇒ run row holds; default/true ⇒ NULL. LOG: INFO existing launch line gains `autoPromote:false` note.
- [x] **T11 (RED first): promoteRun attribution** — §4.7 `attribution` input + `workspaces.promotion_lane` writes in merge + PR finalize txs. Tests: integration — promote with attribution ⇒ lane persisted; without ⇒ NULL; scratch/ext callers unchanged (regression probe). Surgical: no other promote behavior may change (assert existing promote suite green). LOG: INFO `[promoteRun] auto-promotion attribution {runId, lane}`.
- [x] **T12 (RED first): AC-7 race proof** — real-PG + real git fixture: concurrent `promoteRun` (system ctx w/ attribution) vs `promoteRun` (user ctx), same Review run ⇒ exactly one merge commit on target, one `Done` transition, loser `CONFLICT`, no second comment/glyph. File: `web/lib/runs/__tests__/auto-promote-race.integration.test.ts`. LOG: n/a (asserts existing).

### Phase 3 — Sweep job + deployment wiring
- [x] **T13: register `auto_promote` kind** — ALL 12 points of §4.6 in one commit-atomic task (checklist in task body, incl. point 12 = the EN+RU i18n job-kind label + its closure tests; grep-verify no point missed: `grep -rn "auto_launch_triaged" web/lib web/docs web/messages` parity). Tests: `job-catalog.test.ts` extension; `jobs.integration.test.ts` claim-CTE case for the new kind; **(RED first) through-dispatch integration test `web/lib/scheduler/__tests__/auto-promote-tick.integration.test.ts` (mirrors `lib/run-schedules/__tests__/tick.integration.test.ts`): seed the due `auto_promote.default` singleton + one eligible Review run (reuse T14's git-fixture builder) + one ineligible run, call `runSchedulerTick({ jobKind: 'auto_promote' })` — the REAL claim→`runClaimedJob` dispatch, NOT a direct handler call — and assert the eligible run promoted (Done) while the ineligible one is untouched.** This test FAILS if the `case "auto_promote"` dispatch arm (point 8), the `SchedulerJobKind`/`isSchedulerJobKind` registration, or the catalog/claim wiring is missing — closing the codex F2 gap where a missed dispatch case still passes every catalog/claim/direct-handler test, and giving AC-1's "next tick merges" an end-to-end proof rather than a direct-handler simulation. LOG: n/a (framework).
- [x] **T14 (RED first): sweep handler** `web/lib/scheduler/handlers/auto-promote.ts` per §4.6 + `systemPromoteCtx()` mirroring `auto-delivery.ts:108`. Integration tests `handlers/__tests__/auto-promote.integration.test.ts` (testcontainers + real git fixtures, direct handler invocation like the auto-launch suite):
  - AC-1 happy path: docs-only run at Review, green readiness, grace shortened via config ⇒ next tick merges (merge commit on target), run `Done`, board card derives `done` (`runStatusToCard`, board.ts:224-232 — improve-pass verified there is NO persisted `tasks.status='Done'` flip for flow runs, only the agent as-plan consumer/launch-InFlight/cascade-Abandoned write task status; assert parity with a manual promote of the same seed, NOT a DB task flip), ONE system comment (lane, 3 files, evidence link), `promotion_lane='docs'`;
  - AC-3 integration half: registry-version dep-bump (manifest+lockfile) promotes; disqualified diff (protocol-swap specifier / lockfile-only / out-of-block) stays Review + manually promotable (fail-to-manual probe);
  - AC-4: config-lane run promotes;
  - AC-5: red blocking gate ⇒ skip; gate re-run green ⇒ promoted next tick with no re-arming; gate flipped stale between eval and promote ⇒ choke point refuses (simulate via readiness mutation between injected eval and promote — asserts PRECONDITION, nothing promoted, no hold for transient…, actually PRECONDITION here IS terminal give-up: assert hold+comment per §4.6 — stale evidence needs human eyes);
  - AC-6: target moved to conflict ⇒ abort, Review, hold set, exactly ONE comment, next 2 ticks do nothing; manual conflict path unchanged;
  - AC-8: hold blocks eligible run; release re-enables; project toggle off + env off each stop within one tick; never-configured project + master ON ⇒ defaults active;
  - AC-9: `mode:'pull_request'` lane ⇒ PR created (stub adapter), system attribution, run transitions per existing `finalizePullRequest` semantics (code flips `Done` + `prUrl`/`prNumber`, promote.ts:1176-1191 — ⚠ a stale M37-era comment at :1605-1606 claims otherwise; verify actual behavior at RED time and assert per actual), no further PR lifecycle actions;
  - AC-10 probe: scratch / orchestrator-child / shared-workspace runs with docs-only diffs never selected;
  - Edge E1 zero-file diff skip; E2 target branch deleted ⇒ give-up names branch; E4 lane disabled between ticks ⇒ re-eval skips; E5 manual promote during grace ⇒ no double comment (candidate gone); E7 promotion-mode change mid-grace ⇒ current config used; E8 singleton lease vs long merge.
  LOG (pino `{name:'auto-promote'}`): INFO `promoted {runId, lane, fileCount}` / `gave up {runId, code}`; DEBUG per-candidate `{runId, verdict, reason?}`; WARN `success comment failed {runId}` (W1).
- [x] **T15: deployment wiring** — `MAISTER_AUTO_PROMOTION` in `.env.example` + web service `environment:` block in `compose.yml` (+ prod overlay if present) — same phase as first env read (skill-context rule). AC: grep both files.

### Phase 4 — Web surfaces (API + UI + i18n)
- [x] **T16 (RED first): settings PATCH + hold routes** — extend `patchBodySchema` (`app/api/projects/[slug]/settings/route.ts:25-33`) with `autoPromotion` (null clears; `.strict()` zod from T4; response mirrors); new `app/api/runs/[runId]/promotion-hold/route.ts` PUT/DELETE per §4.8 (authz `promoteRun` action; 404 unknown run, 400 bad UUID — reuse route conventions). Tests: route integration — PATCH round-trip SET/CLEAR/re-SET; hold PUT idempotent, DELETE clears system hold, authz refusals. LOG: INFO `[settings.patch] autoPromotion updated {projectId}`; INFO `[promotionHold] set/cleared {runId, source}`.
- [x] **T17 (RED first): panel data route + panel** — new `app/api/runs/[runId]/auto-promotion/route.ts` GET per §4.8 (readBoard authz) + `getRunDetail` (`web/lib/queries/run.ts`) embeds the same `autoPromotion` object (via `evaluateAutoPromotion` for Review flow runs, `diffChangeStats` file list) + `promotedLane` (workspaces join) for first paint. `ReviewPanel` (`app/(app)/runs/[runId]/layout.tsx` subtree): verdict chip (eligible ⇒ "promotes in Xm" + client countdown from `eligibleAt`; held ⇒ reason + Release icon; ineligible ⇒ reason + files verbatim; disabled ⇒ label), Hold/Release icon button (heroicons pause/play, `aria-label`, green-check success glyph per affordance conventions). Done state renders "promoted automatically via lane X". Tests: renderToStaticMarkup unit for each verdict branch + countdown boundary; DTO integration for eligible/held. LOG: none client; DEBUG server in evaluate (T7).
- [x] **T18: settings UI block** — `AutoPromotionSettingsControl` in `web/components/board/panels/` (hosted in `settings-panel.tsx` after `QueueSettingsControl:133-139`): master `Switch`; lanes **view table** (class · enabled ✓ · mode · delay · CI gate · exclude globs) + per-lane **popup edit modal** (admin conventions: view table + popup edits, focus-trap per repo modal precedent); deny-list rendered read-only with a lock glyph; saves via the ONE aggregating PATCH. i18n: `settings.autoPromotion*` keys EN+RU (`web/messages/{en,ru}.json`) + `runDetail`/panel + reason-code labels from T7. Tests: renderToStaticMarkup (table renders defaults; deny-list read-only; RU snapshot for labels). LOG: none.
- [x] **T19: board/rail "auto" glyph** — Done cards (board query `web/lib/queries/board.ts`) + `PortfolioWorkspace` (`web/lib/queries/portfolio.ts:106`) gain `autoPromotedLane: string | null` from the workspaces join; card chip renders a small "auto" glyph with tooltip (lane). Tests: query unit (field threading) + card render unit. LOG: none.

### Phase 5 — E2E, traceability, merge gate
- [ ] **T20: e2e** (`web/e2e/auto-promotion.spec.ts`, seeded stub-supervisor pattern; ⚠ shared-infra trap — ports 3100/7788 + `maister_e2e` DB shared across worktrees, kill both ports first, baseline-prove before blaming the branch): settings block CRUD incl. read-only deny-list; run panel verdict + hold button round-trip; BOTH locales (EN+RU) — AC-11 e2e half.
- [x] **T21: gates + as-built + renumber pass** (owner-gated at merge): rebase onto main → renumber ADR-126/migration-0089 to true next-free (§3) → `pnpm validate:docs` + ADR anchor script + redocly lint (touched artifacts clean vs the enumerated Phase-0 baseline per MO-2) → full `typecheck + test:unit + test:integration + test:e2e` green → flip R6 tags `(Designed)`→`(Implemented)` → record MO-1..MO-3 status. Traceability matrix (§7) re-verified against the final diff.

## 6. Commit plan
- **Commit 1** (T1-T3): `docs(promotion): ADR-126 auto-promotion lanes — specs, contracts, ERDs`
- **Commit 2** (T4-T7): `feat(auto-promotion): lane config, classifier, deny-list, deps check, shared evaluator`
- **Commit 3** (T8-T12): `feat(auto-promotion): review_entered_at anchor, migration 0089, launch opt-out, promoteRun attribution + race proof`
- **Commit 4** (T13-T15): `feat(scheduler): auto_promote sweep job + env kill switch + deploy wiring`
- **Commit 5** (T16-T19): `feat(web): auto-promotion settings, hold routes, panel verdict, board glyph, i18n`
- **Commit 6** (T20-T21): `test(e2e)+chore: auto-promotion e2e, renumber pass, as-built tags`
(No AI trailer — repo convention.)

## 7. Traceability matrix (FR/AC/edge → task → owning test)

| Req | Task(s) | Owning test(s) |
|---|---|---|
| FR-1 config+defaults+kill switch | T4, T15, T16, T18 | config.test.ts; settings route integration; T14 AC-8 env case |
| FR-2 classifier one-lane-all-files | T5 | classify.test.ts incl. overlap⇒ambiguous_lane property |
| FR-2a deny-list first, non-configurable | T5, T18 (read-only UI) | classify deny fixtures + E9 rename; e2e deny-list render |
| FR-3 deps content check | T6, T14 | deps-check.test.ts (registry-specifier allow-list per family, lockfile-only, lockfile-tamper scan); AC-3 integration pair |
| FR-4 predicate fail-closed | T7 (+T8 anchor, T10 hold) | evaluate.test.ts — one test per term 1-16 |
| FR-5 sweep + concurrency + give-up | T13, T14, T12 | handler integration; **through-dispatch tick test (T13, `runSchedulerTick`)**; race test; give-up CAS one-comment |
| FR-6 holds & opt-outs | T9, T10, T16, T17 | hold routes; launch opt-out; hold-survives-rework (E6, T14) |
| FR-7 attribution & audit | T11, T14 | attribution integration; comment content assert; existing webhook/domain-event asserts |
| FR-8 explanation surface | T7, T17 | verdict-branch renders; reason-key closure test |
| AC-1 … AC-10 | T14 (+T12 for AC-7, T5/T6 units) | listed inline in T14/T12 |
| AC-11 surfaces & docs | T1-T3, T18, T20, T21 | validate:docs, redocly, anchors, e2e both locales |
| E1 zero files / E2 target gone / E3 check-id absent / E4 lane disabled mid-tick / E5 manual during grace / E6 hold across rework / E7 mode change mid-grace / E8 tick vs long merge / E9 deny via rename / E10 i18n verbatim files | T14 (E1,2,4,5,6,7,8) · T7 (E3) · T5 (E9) · T7+T18 (E10) | one named case each |
| INV-1…13 | spec §4.9 ↔ tests above | each INV cites its test in workspaces.md Expectations |

## 8. Merge obligations & risks

- **MO-1 (numbers):** renumber ADR-126 + migration 0089 at merge per §3 (main already holds `0088_mixed_hercules`; Tact-2 may hold 0089); journal `when` monotonic; anchor script green.
- **MO-2 (openapi baseline, codex F3):** at Phase 0 capture the redocly baseline as the EXACT set of pre-existing errors by `{ruleId, JSON-pointer}` (the 2 known non-brain errors, task_64b9a8dd) — not a count. Merge gate: redocly lint on the touched spec shows that exact set and nothing else; any error at a location this plan touches is blocking. (No `redocly.yaml` exists today; optionally add one with a scoped `ignore` for the 2 enumerated errors so the gate becomes a plain non-zero-exit check — deferred to implementation, enumeration is the fallback.)
- **MO-3 (experiments term):** whichever of Tact-2/Tact-3 merges second adds predicate term 17 (experiment-membership exclusion) + the AC-10 experiment probe. Recorded in ADR-126 as Designed. **Owner-resolved 2026-07-02: confirmed as the standing rule — no further arbitration needed.**
- **Risk R1 (resolved by /aif-improve — D-3 revised):** the original domain-`run.review` anchor was unsafe — `run.review` is a live SETTLED kind consumed by 7 consumers incl. user-configurable `agentTriggers` (bindable to it) + `orchestratorResume`, so a top-level emit at flow Review flips would have silently fired configured agents on every flow→Review and added a seq-scan (no `domain_events(run_id,kind)` index). Replaced by the `runs.review_entered_at` column (consumed by nobody). Residual: the column must be stamped at every Review-flip site — T8's grep sweep covers the unenumerated-site risk.
- **Risk R2:** W1 crash window (promoted, comment missing) — accepted residual, WARN-logged, documented in ADR-126.
- **Risk R3:** `pnpm lint` auto-fix reformat hazard — check-only eslint on changed paths.
- **Risk R4 (deps lockfile residual, codex F1):** the v1 lockfile specifier scan is best-effort textual, not a per-format consequence-proof — a crafted lockfile riding a valid manifest bump could alter transitive resolutions it misses. Bounded by: lockfile-only diffs disqualified, manifest specifier allow-list, deny-list, strict-checks term, and fail-to-manual. Full pnpm/npm/yarn consequence-proof = Phase-2 (recorded in ADR-126, D-11). Accepted for v1.

## 9. Decisions log (owner-resolved in request §10 + plan-resolved)

Owner-resolved (do not re-ask): lane set docs/tests/deps/config shipped-preconfigured; master OFF; deps strict registry-version-values-only + fail-to-manual; grace 10 min + countdown + Hold; conflict ⇒ auto-hold + exactly one comment; PR-mode creates-and-stops; scratch/orchestrator-child/experiment exclusions permanent.

Plan-resolved (recorded in ADR-126):
- **D-1** Config home = `projects.auto_promotion` jsonb via the aggregating settings PATCH (no new CRUD routes) — mirrors ADR-121 `taskQueueSettings` + repo aggregating-endpoint convention.
- **D-2** Reuse `promoteRun`'s existing claim-token concurrency guard; no new locking.
- **D-3 (revised /aif-improve 2026-07-03)** Grace anchor = new `runs.review_entered_at` column, stamped at each Review-flip (no wall clock). Supersedes the original `run.review`-domain-event anchor: that kind is SETTLED (`taxonomy.ts:51`) and consumed by 7 consumers incl. user-configurable `agentTriggers` (bindable to `run.review`) + `orchestratorResume` — a top-level emit would silently fire configured agents on every flow→Review and add a seq-scan (no `domain_events(run_id,kind)` index). The column is consumed by nobody, read by PK, fail-closed on NULL; cost = +1 ALTER (still one migration).
- **D-4** Attribution = `PromoteRunInput.attribution` → `workspaces.promotion_lane` in finalize (single-tx with the Done flip); task-thread evidence via ONE `addTaskComment` (which itself records `comment_added` activity + inbox fanout) — no new task_activity/domain/webhook kinds.
- **D-5** Give-up hold+comment in ONE tx, CAS on `promotion_hold IS NULL` ⇒ exactly-one comment provable.
- **D-6** Runs already auto-delivering — `delivery_policy_snapshot.trigger='auto_on_ready'` OR `promotionFromSnapshot(execution_policy)='auto_on_ready'` (the knobs OR-combine, auto-delivery.ts:81-85) — are `not_applicable` (existing autopilot owns them, including its degraded-to-manual states).
- **D-7** Shared-workspace (`workspace_mode='shared'`) runs excluded (fan-out blast radius) — permanent exclusion, owner-confirmed 2026-07-02.
- **D-8** Lane config is deliberately NOT snapshotted onto runs (unlike delivery/execution policy): the sweep enforces CURRENT operator intent, fail-closed; policy snapshots keep governing evidence. (Divergence from the snapshot rule, justified + recorded.)
- **D-9** Hold set/clear authz = `promoteRun` project action; sweep ctx mirrors `auto-delivery.ts` system-caller construction; `autoOnReady: true` waiver reused (established system-promotion semantics).
- **D-10** No ext-API/MCP surface in v1 ⇒ no TOOL_SPECS sweep — owner-confirmed 2026-07-02.
- **D-11** Deps-lane hardening depth (codex F1, owner-picked 2026-07-02): **specifier allow-list + no-lockfile-only + best-effort lockfile scan** (NOT a full per-format lockfile-consequence-proof, NOT dropping lockfiles from the lane). Rationale: closes the two concrete supply-chain holes codex named (protocol-swap manifest values; lockfile-only diffs that ship a changed dependency graph with no manifest evidence) while keeping the deps lane useful (real bumps touch the lockfile) and the classifier pure/KISS; the transitive-smuggle residual is fail-to-manual-bounded and recorded (R4), with full consequence-proof as a Phase-2 direction.

## 10. Self-check passes (recorded)

**Pass 1 — Completeness.** Every FR (1,2,2a,3-8) and AC (1-11) maps to ≥1 task and ≥1 test (§7); every predicate term 1-16 has an owning test in T7 (terms 3-9 additionally SQL-prefiltered and re-proven in T14); term 17 explicitly Designed+MO-3 (not silently dropped). All §8-edge cases E1-E10 own a named test. Touched files enumerated verbatim in §4/§5. Found+fixed during the pass: launch opt-out initially lacked a server-side persistence home → resolved as `promotion_hold{source:'launch'}` at run INSERT (T10); deployment wiring for the env var was missing → T15; ERD triple-artifact rule (R4) added to T3.
**Pass 2 — Consistency.** Config schema (§4.2) ↔ OpenAPI `AutoPromotionConfig` (§4.8) ↔ settings UI fields (T18) ↔ classifier inputs (§4.3) ↔ docs (T3) use identical field names (`class/enabled/mode/delayMinutes/requireExternalCheckId/excludeGlobs`); the sweep and the panel both call `evaluateAutoPromotion` (T7) — the DTO type IS the sweep verdict type (§4.5), so divergence is structurally impossible; lane `mode` values = `LegacyPromotionMode` exactly (promoteRun input contract); job-kind string `auto_promote` identical across all 12 registration points (T13 checklist). Found+fixed: verdict needed a `not_applicable` family distinct from `ineligible` so the panel doesn't tell users to "fix" scratch/auto_on_ready runs.
**Pass 3 — No logical holes.** Human-vs-sweep race → existing claim token + T12 proof (INV-5). Eval-vs-promote staleness → `assertEvidenceReady` re-runs inside the claim tx; AC-5 third leg asserts it. Exactly-one give-up comment → CAS in one tx (D-5). Success-comment crash window W1 → enumerated, accepted, WARN (R2). Conflict re-attempt loop → hold makes candidate invisible; W2 converges. Sweep overlap on long merges → singleton budget-1 lease + claim CTE (E8). Deny-list bypass via rename → oldPath+path both checked (E9). Dotfile config lane vs picomatch defaults → `{dot:true}` mandated (T5 fixture). Legacy runs without `run.review` anchor → fail-closed `no_review_anchor`. `auto_on_ready` double-processing → term 8 (D-6). Experiments absence → MO-3, not a silent gap.
**Pass 4 — Improve pass (/aif-improve, 2026-07-02, applied with owner approval).** Deep re-read of `auto-delivery.ts`, `promoteChildRunForToken`, the Review-flip sites, the `auto_launch_run_plan` consumer, and all `tasks.status` write sites found and fixed: (i) predicate term 8 missed the execution-policy `promotionFromSnapshot` knob (OR-combined with the delivery trigger); (ii) AC-1 asserted a persisted task-Done flip that does not exist for flow runs — corrected to board-derived parity; (iii) the domain `run.review` anchor is not emitted at flow Review flips today — T8 upgraded from verification to known work with a consumer-impact checklist; (iv) sweep ctx recipe pinned to `promoteChildRunForToken` (system actor) instead of auto-delivery (user-actor quirk); (v) AC-9 stale-comment caveat; (vi) pino logging convention; (vii) ADR-126 gains the OR-interplay + self-disarm precedent.
**Pass 5 — Adversarial review (codex, 2026-07-02, all 3 findings applied, owner-approved).** (F1/high) deps lane could ship a changed dependency graph with no manifest-controlled proof → §4.3 now requires both-sided registry-version specifiers (rejects `file:`/`link:`/`portal:`/`git`/`github:`/`ssh:`/`http(s)`/`workspace:`/`npm:`-alias/path protocol-swaps), disqualifies lockfile-only diffs, and adds a best-effort lockfile non-registry-resolution scan; T6 gains one RED case per rejected-specifier family + lockfile-only + lockfile-tamper; residual + Phase-2 consequence-proof recorded (D-11, R4, ADR-126). (F2/med) a missing dispatch arm would pass every catalog/claim/direct-handler test → T13 gains a through-`runSchedulerTick({jobKind:'auto_promote'})` integration test that fails if the `case "auto_promote"` dispatch/registration is absent (§4.6 point 8 dispatch-proof note; §7 FR-5 row). (F3/med) the "zero NEW errors vs count baseline" gate contradicted the "validator-clean" claims → T3/INV-13/MO-2/§4.8/T21 now require the touched artifacts to be redocly-clean against an ENUMERATED baseline (2 known errors by `{ruleId, pointer}`, task_64b9a8dd), any touched-location error blocking, and record that `validate:docs` does not run redocly.
**Pass 6 — /aif-review defect-fix (2026-07-03, post-rebase onto main `e9bf6a76`, owner-approved).** A `/aif-review` surfaced 2 HIGH + 4 MED defects the earlier passes missed; all re-verified against the rebased tree and fixed. **(H1)** the `run.review`-domain-event grace anchor (D-3) is unsafe — that kind is SETTLED (`taxonomy.ts:51`) with **7** consumers (`consumers.ts:62-78`) incl. user-configurable `agentTriggers` bindable to it (`triggers.ts:211`, `launch.ts:1776`) + `orchestratorResume`, so T8's top-level emit would have silently fired configured agents on every flow→Review and seq-scanned an unindexed table → D-3 reopened to a `runs.review_entered_at` **column** (§4.1, §4.4 term 16, §4.9 INV-9, T8, T9, R1). **(H2)** the built-in lane globs are NOT disjoint (`**/__tests__/**` ∩ `**/*.md`; `**/__fixtures__/**` ∩ `**/package.json`) and `ambiguous_lane` was declared but never produced → §4.3 now produces `ambiguous_lane` for any ≥2-lane file; T5's disjointness test replaced by an overlap-⇒-`ambiguous_lane` test. **(M1)** §4.5 `grace_pending` promised `eligibleAt` the `ineligible` variant lacked → field added. **(M2)** §4.6 registration points 11→12 — the EN+RU i18n job-kind label + its closure tests (`job-catalog.test.ts`, `scheduler-jobs-table.test.ts`), verified landed on main via `8d186aa4`. **(M3)** term-15's declared-gate source named (compiled FlowGraph gates vs `gate_results` evidence). **(F1)** migration renumbered 0088→0089 (main now holds `0088_mixed_hercules`, ADR-122). **(F2)** ADR-122 now committed on main (§3). **(F3)** the rebase added a 7th domain-event consumer (`memoryHarvest`) — verified safe (excludes `run.review`, `memory-harvest.ts:41`).

---

## Owner answers (2026-07-02) — no unresolved questions remain

1. Merge order Tact-2 ↔ Tact-3: **second-to-merge adds the experiment term** (MO-3 standing rule) — confirmed.
2. Numbering: reservations by Tact-2/budget-fork **exist, exact numbers (123/124, 0089) unconfirmed** — keep ADR-126 + local 0089 as claimed (post-rebase local-next; may collide with a Tact-2 0089); the post-rebase renumber pass (T21/MO-1) fixes final numbers.
3. D-7 shared-workspace exclusion — confirmed permanent.
4. D-10 no ext/MCP surface in v1 — confirmed.
5. "Auto" glyph via `workspaces.promotion_lane` join (D-4) — confirmed sufficient; no separate activity-feed render.
