# Fix Plan: ADR-139/140 review findings — Phase 2..5

**Problem:** `/aif-review` on branch `claude/pr-merge-workflows-4d0e7e` (ADR-139 PR
lifecycle + ADR-140 branch sync) produced 10 merge-blocking findings and ~25 more.
Phase 1 (2 criticals) landed as `167bc9b1e`. This plan covers everything remaining.
**Created:** 2026-07-16 11:40

> **Every finding below was verified in source during the review session** — file:line
> are accurate as of `167bc9b1e`. Re-verify before editing (skill-context rule "Verify
> the finding before fixing it": a prior round's note is a CLAIM, not evidence), but do
> NOT re-derive the list from scratch.

## Owner decisions already made (do not re-ask)

1. **Scope** = ALL findings (owner said "all findings"; skill-context forbids narrowing).
2. **Migration 0103 collision (#1) is OUT of scope** — owner does the rebase onto main in
   a SEPARATE session AFTER all other fixes land. Do not renumber, do not touch
   `_journal.json` / `meta/*_snapshot.json`. See "Owner-gated" below.
3. **`POST /sync` becomes async (#4)** — owner chose "Background it (202 + SSE)".
4. **Pre-existing IN scope:** `/api/runs/[runId]/activity` auth hole + the
   `run.escalated` enum gap. Everything else pre-existing → flag in patch only.

## Analysis — root causes

Two root causes explain most of the code defects:

- **The sync claim hand-rolls the lifecycle claim.** `sync-target.ts:544-552` writes
  `lifecycle_operation_*` directly instead of going through `claimLifecycleOperation`,
  so it inherits neither the staleness reclaim nor the fenced release. This causes #3
  and made #2 terminal. Routing it through
  `claimLifecycleOperation`/`finalizeLifecycleOperation` closes both.
- **Docs describe an intended design the code diverged from** (target-scoped fetch, ONE
  transaction, 202=Running). In every case verified, the CODE is right and the DOC is
  wrong — except #4, where the doc is right and the code is wrong. Per "code wins", fix
  the doc; per the owner's #4 decision, fix the code there.

---

## Phase 2 — tests owed for Phase 1 — ✅ DONE (`83184e758`)

1. [x] `sync-recovery.integration.test.ts`: seed a **mechanical** attempt at
       `phase='verifying'`, no driver → assert the sweep terminalizes it AND releases
       `lifecycle_operation_state`. Must FAIL against `167bc9b1e~1`.
2. [x] Same at `phase='pushing'` where the push did NOT land → assert `failed`, claim
       released, and the worktree is **NOT** restored.
3. [x] Same at `phase='pushing'` where origin HEAD == worktree HEAD (push LANDED) →
       assert `succeeded` + `pushed=true` + claim released + **no** `git reset`.
4. [x] Two-racer for the W5 CAS: seed `agent_running` past the cap, advance the row to
       `pushing` between the candidate pre-read and the arm (one-shot
       `vi.spyOn(db,'update')` or a 2nd pg connection) → assert the cap kill is SKIPPED.
       Project rule: a single-threaded test is NOT evidence for a race contract.

## Phase 3 — remaining code defects — ✅ DONE (`7b40199db`, `b8eeb697b`, `c65e84276`, `fdd380071`)

> Design notes where the fix DIVERGED from this plan's text (all verified in source):
> **#3** — routing through `claimLifecycleOperation` cannot work (it IS the thief:
> archive/drop call it), and no fixed window works because `agent_running_since` is
> re-stamped on every HITL resume. Fixed by HEARTBEATING `lifecycle_operation_claimed_at`
> so it means "last known alive" (what the reclaim window already assumes) +
> fencing the release on the slot's own attempt id. `canReclaimLifecycle` untouched,
> so its `Date.now()` testability blocker is moot.
> **#4** — both routes ALREADY returned 202, so no route change was needed (see item 27).
> **#12** — re-runs the pure gate under FOR UPDATE, not a WHERE: `pr_state` is nullable
> and the conflicted-only case has it NULL, where `eq()` never matches.
> **run-header runId** — from `detail.runId`, NOT `promotionOperation` (only built for a
> promotable Review run; reopen exists for a DONE one).

5. [x] **#3 CRITICAL — 300s claim steal vs a 30-min sync.** `sync-target.ts:544-552`
       bypasses `claimLifecycleOperation`; `canReclaimLifecycle`
       (`workbench-lifecycle/service.ts:453-470`) steals any `claiming` slot older than
       `promotionClaimTimeoutSeconds()` (default **300**, `instance-config.ts:106`) while
       `SYNC_ATTEMPT_MAX_MINUTES = 30` (`sync-recovery.ts:44`) and
       `lifecycle_operation_claimed_at` is never refreshed. After 6 min any workbench op
       silently overwrites `name='sync'` → the `promote.ts:750-757` fence stops matching
       → **promotion can `git merge` a branch mid-rebase**; `releaseSyncClaim`
       (`sync-target.ts:331-334`, guarded on `name='sync'`) becomes a silent no-op.
       *Fix:* route through `claimLifecycleOperation`/`finalizeLifecycleOperation` (use
       the `lifecycle_operation_attempt_id` fence — `sync-target.ts:549` currently writes
       a throwaway `randomUUID()` and never uses it), OR make the reclaim sync-aware
       (≥ `SYNC_ATTEMPT_MAX_MINUTES`) + heartbeat `claimed_at`.
       *Testability blocker:* `canReclaimLifecycle` calls `Date.now()` directly
       (`service.ts:467`) — inject a clock or no test can prove this.
6. [x] **#4 CRITICAL — background the resolver.** `route.ts:122` awaits `syncRunTarget`
       → awaits `sendPrompt` (`sync-resolver.ts:246`). Design settled during review:
       - **Cut-line = after the CAS tx (`sync-target.ts:992`) / after `sessionInput` is
         built (`:994-1003`), BEFORE `runResolverSession` (`:1015`).** NOT at the conflict
         (`:638`) — everything in the pre-session try (`:901-1003`) still surfaces typed
         HTTP errors (cap `CONFLICT`, runner unavailable, CAS loss) and must stay sync.
         At the cut the run IS `Running` and the attempt IS `agent_running`, so
         `agent_launched` becomes honest and matches the existing docs.
       - **Pattern:** `queueMicrotask(() => void fn().catch(err => log.error(...)))`.
         No shared helper exists. Template: `hitl.ts:836` (backgrounds then returns 202).
         `resume-driver.ts:286` documents this exact contract.
       - **⚠ THE TRAP:** `return await` at `sync-target.ts:638` is the ONLY reason the
         `finally` at `:774` (`unregisterSyncDriver`) doesn't fire early. Background it
         naively → the driver deregisters at RESPONSE time while the resolver runs →
         `reconcile.ts:250-269` sees `syncDriverActive=false` + `liveSession=false` (always
         false, see #7) → `sync-orphaned-idle` → **the sweep hard-resets the worktree under
         the live agent**. `reconcile.ts:254-258` records this as a regression that already
         shipped once. Requires an explicit ownership handoff: the agent path hands
         `unregisterSyncDriver` to the background task's own `finally`; never both, never
         neither. The `catch` at `:764-770` (`terminalizeSafetyNet`) must follow it too.
       - **Response:** `behind` is known at the cut (`:605`, passed through untouched);
         `pushed:false` is factually true there (OpenAPI already has `behind` nullable).
       - **Callers to sweep:** `ext/runs/sync/route.ts:105-124`, and `promote.ts:898-919`
         (`ai_rebase_merge` — its `autoFinalize` chain at `sync-target.ts:1240-1272` also
         backgrounds; `promoteRun`'s response no longer reflects a completed promotion).
       - **UI needs no change:** `review-panel.tsx:224-246` uses `res.ok`, which covers 202.
         SSE already wraps it (`RunStreamProvider` in `layout.tsx:1304`; `Review` is a live
         status; `run-live-refresh.tsx:48-77` polls `graph-status` on `eventCount` and both
         resolver edges change `runViewKey`). **Two gaps to design for:** the finalize may
         have no trailing event to tick on (panel stuck on Running), and the stream breaks
         on a quiet window. **Not serverless** — systemd host process, `void` genuinely
         outlives the response; nginx sets `proxy_read_timeout 3600s` on `/api/runs/`.
       - Tests currently `await syncRunTarget` and assert final state — they WILL need to
         await the background task.
7. [x] **#13 MAJOR — W2 recovery arm is unreachable.** `sync-target.ts:977` inserts the
       resolver's `run_sessions` row with `acpSessionId: null` and nothing ever updates it
       (only write in all 3 sync modules). `reconcile.ts:1065` resolves `liveSession` from
       it → always null (or, worse, the OLD flow session's handle via the fallback at
       `active-run-session.ts:181-183`). Persist the real `acp_session_id` after
       `createSession`. Note the review's test finding: `reconcile-classify.test.ts:557`
       and `sync-recovery.integration.test.ts:278` both FEED `liveSessionId` in — they
       prove the consumer, never the producer.
8. [x] **#12 MAJOR — reopen decides on a stale `pr_state`.** `reopen.ts:138-149` reads
       lock-free; `fetchRemote` (`:168`, network) + `addWorktreeForBranch` (`:187`) run;
       the tx at `:191` re-asserts ONLY `status='Done'` (`markReopenFromDone`) and the
       workspace UPDATE at `:206-215` carries no `prState` predicate. Concurrent writer =
       `pr-state-scan.ts:397-411` (`mergedEdge`). → reopen onto a merged PR → re-promotion
       opens a SECOND PR, defeating the refusal `reopen.ts:86-99` documents as
       load-bearing. *Fix:* re-assert `pr_state`/`pr_has_conflicts` inside the tx WHERE +
       `RETURNING`. Mirror `promote.ts:564-568`, already hardened against this exact class.
9. [x] **#6 MAJOR — machine promotions recorded as a phantom human.** `promote.ts:906`
       hardcodes `actor: { type:"user", id: ctx.sessionUser.id }` while `ctx.actor` (the
       canonical authority, declared `:97-99`) sits unread. `resolvedMode` comes from the
       project delivery policy (`:685` → `delivery-policy.ts:107-111`), not `input.mode`,
       so the ADR-126 **cron lane** (`auto-promote.ts:52-57`, `sessionUser.id =
       "auto-promotion:<projectId>"`) and the orchestrator (`promote.ts:2021`) both reach
       it. `0104_branch_sync.sql:22-23` gives `actor_type`/`actor_id` no FK, so the phantom
       id writes silently — on a FORCE-PUSH ledger. Both placeholders' own comments say
       they are "never dereferenced for a non-user actor". *Fix:* map `ctx.actor` →
       `SyncActor` (the ext routes already do this right via `socialActorForToken`).
       **Also** guard `sync-target.ts:1243`: `if (args.autoFinalize && args.actor.id)`
       does not check `type === "user"` and passes `authorize: async () => undefined` —
       unreachable today only because `autoFinalize` is absent from both sync body schemas.
10. [x] **#17 MAJOR — `published` re-implemented, diverges.** `sync-target.ts:478` and
       `sync-recovery.ts:333` use `prUrl != null || branchHasUpstream(...)`;
       `sync-panel-data.ts:61` uses `branchHasUpstream(...)` ONLY. It seeds the `syncPush`
       checkbox (`review-panel.tsx:187`) consumed as `input.push ?? published` → a run with
       a `pr_url` but no upstream shows push OFF and silently isn't pushed. Extract one
       predicate; the flag must derive from the function that performs the capability.
11. [x] **Pre-existing (owner opted IN): `/api/runs/[runId]/activity` has NO auth.**
       `activity/route.ts:46` — POST, zero auth imports/calls, queries `runs` (`:62-65`) and
       calls `bumpKeepalive` (`:114`, a state-changing write). Unauthenticated caller with a
       leaked run id gets a status oracle (404/409/410/204 discriminate) and can extend
       `keepalive_until` indefinitely, defeating the idle-checkpoint cost control
       (~$0.28/respawn) and pinning slots against the cap of 6. Add `requireActiveSession`
       + `requireProjectAction(projectId, "readBoard")` with `projectId` server-derived,
       auth BEFORE any DB lookup.
12. [x] **Minors:** `sync-driver-registry.ts:52` `activeSyncDriverRunIds` — dead export, no
       importer incl. tests · `sync-target.ts:848` `project: any` — unflagged (convention
       requires `// FIXME(any):`); it only uses `syncRunnerId`/`defaultRunnerId` so type it ·
       `sync-target.ts:720`/`:1127` `published && remoteShaIndeterminate` — the flag is only
       set inside `if (published)` (`:483-492`), so the left operand is redundant ·
       `run-header.tsx:193-200` renders `PrStateChip` without `runId` → reopen permanently
       disabled on run detail (`runId` is available at `:71`) · `RunSyncPhase`
       (`schema.ts:2071-2081`) has ZERO importers while `["succeeded","failed","aborted"]`
       is re-listed 5× (`sync-target.ts:85`, `sync-recovery.ts:46`, `sync-panel-data.ts:17`,
       `reconcile.ts:751`, `keepalive-sweeper.ts:98`) and every `phase` is typed `string`
       (`setAttemptPhase(…, phase: string)`) — a typo compiles · `pr-state-scan.ts:25-28`
       hand-mirrors `EXEC_TIMEOUT_MS` (`pr-adapter.ts:19`, not exported) — export + import,
       since `scanBudgetMs()` reserves it as lease headroom · `promote.ts:900-908` drops the
       injected `db` into `syncRunTarget` (falls back to `getDb()`).

## Phase 4 — tests for Phase 3 + the untested contract invariants

13. [ ] **#C1 — `remoteShaIndeterminate` → refuse has ZERO tests.** `grep -i indeterminate`
        across every test file returns nothing. Implemented at `sync-target.ts:481,492,720,1127`.
        This is the ONLY guard between a resolver and an unleased force-push.
14. [ ] **#C3 — the ADR's "matrix tested" claim is FALSE.** Actual coverage = 3 point tests.
        Missing: `promotionState === "done"` (only `"claiming"` tested, `:627`); the
        **`reopened` pass-through carve-out** (`sync-target.ts:501` comment) — that is the
        reopen→sync path, the feature's whole reason to exist, and if the fence ever blocked
        `reopened` every test stays green; `drop`/`exportBranch`/`snapshotCommit`/`handoffBranch`
        (`:648` tests `archive` only).
15. [ ] **#C4 — the entire W3 recovery arm is untested.** `recoverSyncAttemptOnReconcile` is
        invoked once in the suite (`sync-recovery.integration.test.ts:288`), always with
        `liveSessionId:"sess-orphan"` → W2. The W3 arm (`sync-recovery.ts:299-397`: re-verify →
        gate → **push** → finalize) has zero coverage.
16. [ ] **#C6 — W6 / `autoFinalize=true` chain untested** (`sync-target.ts:1239-1270`).
        `promote-service.test.ts:839` asserts delegation with an `expect.objectContaining`
        that OMITS `autoFinalize` — the flag's plumbing is unpinned.
17. [ ] **#C8 — the `[FIX:ADR-139]` lease-deadline path has zero tests**
        (`pr-state-scan.ts:35-39,142-193`). A defect fix shipped with no regression test.
18. [ ] **#C9 — the headline e2e passes on a REFUSED promote.** `run-sync.spec.ts:47-50`
        clicks `review-promote` then asserts `toBeHidden()`, but `review-panel.tsx:696` is a
        ternary `{drift ? <review-drift> : <review-promote>}` and `:286` sets `drift=true` on
        a target-drift refusal → the button unmounts either way. Assert the response status
        like the sibling does (`pr-reopen.spec.ts:36-41`, `expect((await posted).status()).toBe(200)`).
19. [ ] **#M9 — poison-guard clone dropped the case that mattered.**
        `jobs.integration.test.ts:119-175` clones the seed test but not the
        `consecutive_failures < max_failures` guard (`jobs.ts:481-482`); only
        `ensureRepoDeliveryScanJobs` covers it (`:177-205`). Delete the guard and the
        `pr_state_scan` clone still passes → a poison-disabled scan re-enables every seed →
        retry-forever, which ADR-139 explicitly forbids.
20. [ ] **#M10 — `system-sweeps.test.ts:103` no longer covers what it claims.**
        `system-sweeps.ts:145,165-171` added `runSyncRecoverySweep` but the test never mocks
        `@/lib/runs/sync-recovery`, which calls `getDb()` → throws → swallowed into `errors[]`;
        the test asserts neither `syncRecovery` nor `errors` emptiness.
21. [ ] **Delete / repair trivial tests** (each verified): `sync-target…:425` asserts a SHA the
        test itself read from git looks like hex, under a name claiming "PRECONDITION naming
        both SHAs" — nothing inspects the message · `review-panel.test.ts:294-303` asserts a
        label string it passed in · `pr-adapter-getprstate…:456-484` (`glab`) asserts
        `Array.isArray(argv)` + the number it passed · `:268-282` (`gh`) omits
        `--json state,mergedAt,mergeCommit,mergeable,mergeStateStatus` — drop
        `mergeStateStatus` and production conflict detection breaks with every test green ·
        `pr-state-tracking-migration…:138` inserts the workspace AFTER the whole chain applies,
        so a backfill UPDATE could never touch it (stepwise-replay template exists at
        `social-board-migration…:361`) · `pr-state-scan…:100-101` seeds closed/conflict
        candidates without `withTask:true` so the merged-only negative is vacuous ·
        `sync-target…:856-863` stubs `requireProjectAction` and never asserts
        `(projectId, "promoteRun")` — rebinding it to `readBoard` fails nothing.
22. [ ] **Overlap to collapse:** `reopen…:390` (pure) vs `:581` (DB) enumerate the same 4
        refusals — keep one representative at the service layer · `pr-state-tracking…:190-206`
        + `branch-sync…:218-233` re-check journal/snapshot pairing that
        `migration-journal-integrity.test.ts` already covers MORE strictly (incl. the `when`
        check they omit) Docker-free — delete · `branch-sync…:106-128`,
        `pr-state-tracking…:92-107` DDL-echo the `.sql`; `:109-116` asserts a "partial index"
        by NAME only, so a non-partial index passes — assert the predicate (`0103:8`).

## Phase 5 — docs (code wins; do LAST, after code is final)

23. [ ] **#7 `PromoteRunBody`** (`web.openapi.yaml:15990-16036`): `additionalProperties:false`
        + no `autoFinalize`, while `promote/route.ts:26` accepts it and
        `promotion-operation.ts:77-79` SENDS it → the spec rejects the branch's own request.
24. [ ] **#8 `WebhookEventType`** (`web.openapi.yaml:18039`): enum has 12 entries; code
        (`taxonomy.ts:9-27`) has 16. Missing `run.pr_merged`/`run.pr_closed`/`run.pr_conflicts`
        (this branch) **and `run.escalated`** (pre-existing — owner opted IN). The enum feeds
        live subscription bodies (`:18131`, `:18190`, `:18237`). Also fix the stale counts:
        `web.openapi.yaml:18042` "(12 types)", `docs/CLAUDE.md:97` "12-type taxonomy",
        `outbound-webhooks.asyncapi.yaml:17` "Events are 12 curated" (same file's `:308`
        already says 16), `system-analytics/outbound-webhooks.md:198` "Exactly 13 types",
        `taxonomy.test.ts:250` "all 13 types".
25. [ ] **#9 "target-scoped fetch" does not exist** — `worktree.ts:1203` is
        `git fetch --end-of-options origin`, NO refspec → all refs → `origin/<branch>` IS
        refreshed. Documented as the RATIONALE for the explicit-SHA lease in 6 places:
        `branch-sync.md:85` + `:179-181`, `git-integration.md:365` + `:378`,
        `web.openapi.yaml:4905-4906`, `database-schema.md:1705-1706`, `decisions.md:11952,11980`,
        plus a wrong comment at `schema.ts:2103`. The code is SAFE for the opposite reason
        (`ls-remote` capture at `:485` precedes the fetch at `:576`) and its own comment
        (`:476-478`) is honest. **Dangerous drift:** a reader could "optimize away" the
        `ls-remote`. Fix the docs to describe the real mechanism.
26. [ ] **#10 "ONE transaction" is impossible as written** — `branch-sync.md:161-163`
        (Expectations), `:46` (state diagram "one tx with claim + attempt"), `:104`
        (sequence), `database-schema.md:1719-1722`, `decisions.md:11993`. Code has TWO:
        claim (`sync-target.ts:497-557`) and the CAS (`:941-992`), separated by the rebase.
        The code is RIGHT — you cannot know it is the agent path until the rebase conflicts,
        and mechanical sync must not flip to `Running`. Rewrite the docs.
27. [ ] **#11 202 semantics** — `web.openapi.yaml:4952-4955` +
        `operations.openapi.yaml:1711-1714` say 202 ⇒ "the run is now `Running`". After
        Phase 3 item 6 this becomes TRUE; verify rather than edit.
28. [ ] **#C3 doc half** — `decisions.md` ADR-140's "Both directions are matrix tested"
        claim must go or become true (see item 14).
29. [ ] **#15 `database-schema.md`**: `:1714` documents `actorUserId? // FK -> users.id` —
        does not exist (`schema.ts:2122-2123` / `0104:22-23` are `actor_type`/`actor_id`,
        no FK; the sibling ERD `runs-domain.md:236-237` is right) · `:1702` says
        `mode // sync | ai_rebase_merge` — code is `["mechanical","agent"]` (`schema.ts:2095`)
        and `runs-domain.md:221` + `operations.openapi.yaml:3226-3227` agree with the code ·
        `:1708` `runnerId // FK -> platform_acp_runners.id` — deliberately NOT an FK
        (`schema.ts:2110-2111`) · `workspaceId` (NOT NULL, cascade) missing from the block
        (`:1694-1716`).
30. [ ] **#16 `docs/db/erd.md` has NONE of ADR-139/140** (untouched; `docs/CLAUDE.md`
        "Adding a new artifact" requires it): `WORKSPACES` (`:791-819`) missing all five
        `pr_*`; `:818` `lifecycle_operation_name` omits `sync`; `:810` `promotion_state`
        omits `reopened`; no `RUN_SYNC_ATTEMPTS`; no `PROJECTS.sync_strategy_default` /
        `sync_runner_id`; `:645` `task_activity.event_kind` omits `run_pr_merged` (`0103:10`).
31. [ ] **#14 screens docs describe a UI built elsewhere** — the biggest doc cluster.
        `workbench.md:190-200` claims a 6th lifecycle **matrix** column; `lifecycle-actions.tsx`
        + `policy.ts` have ZERO sync refs and are unchanged, and `workbench-lifecycle.md:94-98`
        (same PR) says sync takes NO matrix column · `flow-run.md:265-267` names
        `sync-branch-dialog.tsx` — no such file (it is inline at `review-panel.tsx:392-396`) ·
        `:98-104` puts the behind/ahead chip in `run-header.tsx` — it is
        `review-panel.tsx:357-364` · `:273-275` names `run-header-promotion-action.tsx` — no
        sync affordance · `:269-272` documents a **Stop** control that does not exist
        (`review-panel.tsx:386-389` is text only) · `flow-run.md:211-214` +
        `run-inspector.md:169-172` claim `getRunDetail` supplies `prMergedAt`/`prMergeCommitSha`
        + the phase — `queries/run.ts:280-281,479-480` adds only `prState`/`prHasConflicts`;
        the phase comes from `sync-panel-data.ts:78-86` · `run-inspector.md:86-92,109-114`
        documents Overview PR facts + Actions-tab Sync/Reopen that do not exist.
32. [ ] **#M20 stale `(Designed)` tags on Implemented ADRs** (`decisions.md:11853`, `:11931`
        both say Implemented): `git-integration.md:527-530`, `workspaces.md:615-618` + `:626`,
        `tasks.md:441` + `:618` + `:626`, `flow-run.md:244`, `workbench.md:190`,
        `run-inspector.md:86`.
33. [ ] **Stale claims this branch falsified** (files untouched): `runs.md:132` `Done --> [*]`
        with no `Done --> Review` (`state-transitions.ts:390-416`) and no `Review --> Running`
        sync edge (`:321-347`), while `:136-137` claims the diagram matches the enum exactly ·
        `runs.md:442-447` + `hitl.md:98-100` + `:244-252` + `:262-263` still document the
        DELETED `merge_conflict` path for `ai_rebase_merge` (`promote.ts:915` returns above
        `createMergeConflictAssignment` at `:934`; the branch's own test now asserts
        `createAssignment` NOT called — `promote-service.test.ts:814,831`) ·
        `tasks.md:496` "Done is terminal for the task" (`reopen.ts:217-222` sets `InFlight`) ·
        `tasks.md:75,78` board diagram missing `Done --> InFlight` (contradicts the PR's own
        `:449-455`) · `M2`: `branch-sync.md:199` says non-FF divergence leaves "no attempt row"
        but `sync-target…:424` asserts `phase='aborted'` — a row EXISTS (claim inserts
        `starting`, then `abortAttempt` at `:593`); the dirty case (`:446`) is the real
        no-row one.
34. [ ] **Minor doc/N-items:** `error-taxonomy.md` `CONFIG` row omits the ADR-140 sync 422
        (`sync/route.ts:72`, `ext/runs/sync/route.ts:48`) — ADR-140's "no new error codes"
        list omits `CONFIG` entirely · `CRASH` row misses the throw at `sync-resolver.ts:264` ·
        `run_sync_attempts.target_sha` is NEVER written (`database-schema.md:1703` implies it
        is) · `run_sync_attempts_run_idx` (`schema.ts:2136`, `0104:43`) documented nowhere ·
        `runs-domain.md:41,63` cite `(ADR-140, 0101)` and `:198,420` cite `(ADR-139, 0100)` —
        pre-renumber; the same file's `:535,539` say 0103/0104 · `runs-domain.md:535`
        `workspaces_pr_scan_idx` — real name is `workspaces_pr_state_scan_idx`
        (`0103:8`, `schema.ts:2059`; `scheduler-domain.md:107` is right) · stale
        `schema.ts:148,2039,2067,4167` comments citing 0100/0101 · `branch-sync.md:63` labels
        `rebasing --> aborted` "conflict + agent=false" only, but `sync-target.ts:1007-1009`
        takes it on every pre-session refusal with `agent=true` · `scope-contract.test.ts:36-43`
        never asserts `ORCHESTRATOR_TOKEN_SCOPES` lacks `runs:sync` (safe today only by the
        spread at `tokens.ts:36`) · `SyncRunResponse.behind` nullable in spec, non-nullable in
        code (`sync-target.ts:98`) — after item 6 the spec becomes right · ext `runId`
        `format: uuid` (`operations.openapi.yaml:1685-1688`) vs `z.string().min(1)` ·
        reopen 409 list (`web.openapi.yaml:5019-5024`) omits shared-tree (`reopen.ts:76-81`)
        and merged/closed-PR (`:94-99`) · `scheduler.md:359-361` claims a terminal `Skipped`
        job status `pr_state_scan` can never produce (`tick-service.ts:216-220` excludes it
        from `isSkip`; `:200-205` always records `Succeeded`).

## Owner-gated — DO NOT DO IN THIS PLAN

- **#1 migration collision.** Main already has `0103_repair_trusted_package_flow_enablement`
  (`when=1784127378683`). Branch's `0103_pr_state_tracking` (`when=1784123792177`) collides on
  idx AND on `meta/0103_snapshot.json`, with `when` going BACKWARDS. Proven: `git merge-tree`
  conflicts on `_journal.json`, `meta/0103_snapshot.json`, `decisions.md`, `playwright.config.ts`
  (the last is a benign both-append to one regex; `decisions.md` is the ADR table + body — main
  has 137/138, branch has 139/140, no renumber needed).
  **The silent half:** commit `e6a0bab83` renumbered by PURE RENAME (`similarity index 100%`),
  so the snapshot `prevId` chain is still rooted at **0099** and the newest snapshot
  (`0104_snapshot.json`) is MISSING `public.gate_chat_turns` (main's 0101), the `hitl_requests`
  columns (0100), and the CHECK (0102). Renumbering again to 0104/0105 fixes the lint but NOT
  this — the next `db:generate` would emit a duplicate `CREATE TABLE gate_chat_turns`.
  **The snapshots must be regenerated on top of main, not renamed.** Nothing guards this: no
  test references `prevId`. `migration-journal-integrity.test.ts` DOES catch the idx/`when`
  collision loudly at merge (so the branch cannot silently ship it).
  Skill-context: renumber is grep-to-zero, ONE pass covering ADR+migration together, AFTER the
  rebase, as its own session.

## Close-out gate battery (skill-context — run before declaring done)

```
CI=true pnpm validate:docs
CI=true pnpm validate:contracts
CI=true pnpm --filter maister-web typecheck
<focused behavior tests>
git --no-pager diff --check
```
Plus: run prettier on every NEW test file (`test:unit` green ≠ `prettier/prettier` clean; scope
`eslint --fix` to new files only, NEVER repo-wide — `pnpm lint` is `eslint --fix` with no path
and reformats ~60 files). For bracket paths (`app/api/runs/[runId]/…`) eslint needs a `*`
wildcard. When a fix adds a precondition to a SHARED function, re-run that function's FULL
consumer suite.

## Known environment facts (save re-discovery)

- Integration/E2E need Docker (Testcontainers, ADR-135). Docker IS available here.
- `pnpm test:unit` currently **passes** (exit 0) — the drawer OOM was fixed in `4632639dc`,
  which repairs a PRE-EXISTING main problem, not this branch's work.
- Pre-existing failures proven by the branch author via merge-base differential: 17 integration
  files / 38 tests fail at base too; `comm -23 mine base` is EMPTY.
- Redocly lint errors in `web.openapi.yaml` are PRE-EXISTING (ExperimentComparison
  `nullable-type-sibling` + `info.license.url`) — not this branch.
- Do NOT run `pnpm lint` (it is `eslint --fix`, no path → reformats the repo).
</content>
