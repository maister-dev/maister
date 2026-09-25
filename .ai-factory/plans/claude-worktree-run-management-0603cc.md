# Run git panel — status-independent worktree git operations, public branch names, PR before promotion (ADR-181)

**Branch**: `claude/worktree-run-management-0603cc` (this worktree; the plan file is
named after the branch so `/aif-implement` finds it)
**Base**: `master` @ `c36ff5b1` + `40152869` (docs(adr-181), the branch's only commit —
1 ahead / 0 behind)
**Created**: 2026-09-22 · **Refined**: 2026-09-22 (`/aif-improve` pass 1 — 8 additions, 7
improvements, 2 dependency fixes, 3 removals; corrections C14–C16 added)
**ADR**: ADR-181 (Accepted → Implemented at T4.3). No new ADR. **Migration `0173`
reserved** (journal max is `idx 172`, `when 1790016407278`; the new entry must be
strictly greater).
**Contract**: `docs/decisions/adr-181.md` (frozen) + `docs/system-analytics/workbench-git.md`
(Designed → Implemented). Nothing below reopens a decision recorded there; every
"D" is an implementation refinement the ADR leaves open, or a correction of a
premise the code refutes (§Ground truth).

## Goal

One git panel per run over one status-independent policy and one lazy read model,
so an operator on a server installation (no host shell) can commit, discard,
publish under a public branch name, update from base / target / their own remote
pushes, open a PR before any promotion, finalize a PR-backed run, and re-attach a
removed worktree — in every parked status (`Review | Crashed | Failed | Done |
Abandoned`, plus `HumanWorking` for the rework-claim owner). The three defects that
hide the ADR-160 carve-out are fixed, `Failed` is listed as a parked workbench, and
the scratch promote modes the UI already offers are honoured by the server.

## Settings

- **Testing**: yes. TDD, **RED → GREEN → REFACTOR**, real seams: policy matrices in
  the `unit` project; publish / update / discard / reattach against **real git**
  (bare remote + parent repo + run worktree, the `real-git.integration.test.ts`
  shape); DB-backed controls on real Postgres (`test-support/pg-container.ts`, the
  only Testcontainers constructor); the provider boundary mocked at
  `node:child_process`/`fetch` (the `pr-adapter.test.ts` idiom) and at the service
  seam (`promote-pr.test.ts`); panel/dialog states in jsdom (`*.dom.test.ts`, per-file
  `// @vitest-environment jsdom`); one authed Playwright smoke. No trivial controls
  (shape/constant/presence assertions); minimal overlap (§Test plan audit).
- **Logging**: verbose, structured pino through the module loggers already present
  in `web/lib/worktree.ts`, `web/lib/workbench-lifecycle/service.ts`,
  `web/lib/runs/sync-target.ts`, `web/lib/runs/promote.ts` — same field
  conventions (`runId`, `workspaceId`, `op`, `remote`, `branch`, `publicBranch`,
  `sha`, `leaseSha`, `outcome`, `latencyMs`). DEBUG: every git argv (URLs through
  `redactUrl`); INFO: each completed operation and each name resolution
  (`source: upstream | request | template`); WARN: non-fast-forward / lease
  refusals, `ls-remote` unreachable, template fallback; ERROR: unexpected git
  failure. Never a token, never a credentialed URL. Level is the existing web
  logger configuration — **no new knob**.
- **Docs**: yes — mandatory checkpoint. **SDD**: Phase 0 freezes every contract
  surface (OpenAPI, ERD, taxonomy, configuration, screens, RU manual) BEFORE code;
  Phase 4 re-derives the surface list from the diff.
- **Migration**: one — `0173_*` (SQL + `_journal.json` + `0173_snapshot.json`), ERD
  regenerated (`pnpm --filter maister-web db:erd`), `drizzle-kit generate` reports
  "No schema changes" afterwards (schema.ts is the fourth leg).
  If `master` gains a `0173` before this branch merges, the triple is regenerated as
  `0174` in the rebase session (renumber pass), never edited in place.
  **As merged (2026-09-25, Commit 16):** `master` had claimed `0173`-`0175`, so the
  triple was regenerated as `0176_workbench_git_publication` on master's `0175`
  (same five statements, a newer journal `when`, `drizzle-kit generate` clean).

## Roadmap Linkage

**Milestone**: `none`
**Rationale**: the only open roadmap milestone is M51 ("See everything", a read-only
visibility layer); ADR-181 is workbench operability. A roadmap entry is proposed in
the questions (Q6) and belongs to `/aif-roadmap`, not this plan.

---

## Ground truth — verified, and sixteen corrections

Everything the request cites was re-read on this branch (`40152869` = `master`
`c36ff5b1` + docs). The mechanism is as stated. The following premises are refined
or refuted by the code; the plan is built on the corrected ones.

### Verified as stated (abridged; line drifts in C13)

| # | Fact | Evidence |
|---|---|---|
| G1 | Policy gates only on status + `hasWorkspace` + `!workspaceRemoved` | `web/lib/workbench-lifecycle/policy.ts:74-80` (`WORKTREE_ACTION_STATUSES`, module-local, NOT exported), `:141-175` (branch order: HumanWorking carve-out → stop arm → status → row → removed → worktree arm) |
| G2 | The carve-out is dead in production | `service.ts:179` `requireActiveSession: () => Promise<{ id: string } | void>`; `:1980-1984` awaits and DISCARDS the user; `portfolio.ts:278-281` hard-codes `claimOwnerUserId: null, viewerUserId: null`; `layout.tsx:1226-1240` passes neither field to `deriveInspectorActions` (`lib/runs/inspector-actions.ts:152-153` defaults them to `null`) |
| G3 | `Failed` is invisible | `portfolio.ts:77-90` `ACTIVE_RUN_STATUSES` (no `Failed`), consumers `:396`, `:946`, `lib/queries/project.ts:358`, `app/api/attention/stream/route.ts:149`; `board.ts:100-102` `Failed|Abandoned → Backlog`; `queries/board.ts:696` Backlog rows become `BacklogCard` (`:100-142`, no `lifecycleActions`) while `FlightCard` carries them (`:190`, filled `:811-818`) |
| G4 | Rail never offers export; export dialog never snapshots; worktree-gone sticks | `lifecycle-actions.tsx:189-215` `railMenuItems` (early return after stop items, then archive/drop only); `:656` `snapshotDirty: false`; `:872-893` Push/Handoff `disabled` while `metadata === null`; `service.ts:990-1042` `getWorkbenchHandoffMetadata` → `statusPorcelain` (`worktree.ts:2856-2889`) throws `CONFLICT` on a vanished path; `reconcile.ts:388-391` is a pure classifier — `crashRunningRun` (`state-transitions.ts:1394-1400`) writes `runs` only, so the row keeps `removed_at IS NULL` and a stale `worktree_path` |
| G5 | Inspector Actions tab is inert | `run-inspector.tsx:203-222` renders `<span>` when `href` is absent; `layout.tsx:1240-1245` never sets `href` although `inspector-actions.ts:69-92` already computes `endpoint`/`method` |
| G6 | Export pushes the internal name, no upstream, records nothing | `worktree.ts:959-1009` `pushBranch` — argv `push [--force-with-lease] [--set-upstream] --end-of-options <remote> <branch>` (`:977` opt-in only, no caller sets it), **no refspec**; `service.ts:1485-1590` `exportWorkbenchBranch` writes no DB column; `branch-published.ts:21-28` `prUrl != null || branchHasUpstream()` |
| G7 | Sync is Review-only, target-only, leases on the internal name | `sync-target.ts:174-212` six `PRECONDITION` arms (`:175` status); `:710-713` `targetBranch = workspace.targetBranch ?? project.mainBranch ?? "main"`; `:732-741` `remoteShaBefore = remoteBranchHead({remote:"origin", branch})`; `:1076` `shouldPush = input.push ?? published`; `worktree.ts:3866-3922` `forceWithLeasePush` lease `refs/heads/${branch}:${expectedSha ?? ""}` (`:3873`), remote **hard-coded `origin`** (`:3889-3891`) |
| G8 | PR is a promotion | `promote.ts:606-611` Review guard; `:1378-1386` push `origin`/internal, no upstream; `:1391-1398` `createOrUpdatePr` args, no `draft`; `:1413-1419` `prTitle`/`prBody`; `pr-adapter.ts:31-38` `CreateOrUpdatePrArgs` (`remote` declared, never read); `:605-624` `selectPrAdapter` (github/gitlab/gitea/gitverse, `generic → PRECONDITION`); `:172-199` gh list-by-head/base then reuse |
| G9 | `finalizePullRequest` writes | `promote.ts:1421-1674`: fence `:1426-1452`; sibling flip `:1520-1555`; `runs` `:1557-1571` (`Done`, `promotedHeadSha`, `mergeCommitSha: null`); `workspaces` `:1576-1592` (`promotionState:"done"`, `promotedAt`, `scheduledRemovalAt`, `prUrl`, `prNumber`, `promotionLane`); events `:1594-1636` |
| G10 | Scratch promote refuses two of the three UI modes | `promote.ts:1751-1757`; `scratch-inspector-actions.tsx:96-98`; target `:1785` `input.targetBranch ?? scratch.baseBranch`; scratch `workspaces` rows carry no base/target (`scratch-runs/service.ts:926-933`), only `scratch_runs` does (`schema.ts:5099-5101`) |
| G11 | `pr_state_scan` needs no change for a non-scratch `pr_url` | `pr-state-scan.ts:288-296` |
| G12 | Rework-claim ingest and reopen assume remote name = internal name | `rework-claim-ingest.ts:82` `` `${remote}/${args.branch}` ``; `reopen.ts:158-188` (`ORIGIN` const, `createLocalBranchAt` + `addWorktreeForBranch`), and `:236-246` **clears `archived_*`**, re-stamps no provenance |
| G13 | Preservation and the archive knob | `gc/preserve.ts:63` `maister/archive/<runId>`, `:104-127` `archivePush` only pushes when true; `instance-config.ts:271-275` `gcArchivePush()`; `archiveWorkbenchForCtx`/`removeWorkbenchForCtx` never pass it; reconciler `workspace-reconciler.ts:656-668` INSERTS a row only when none exists |

### C1 — the lifecycle op name `discard` is taken; the new op is `discardChanges`

`web/app/api/runs/[runId]/discard/route.ts` → `discardWorkbench` →
`removeWorkbench(runId, "discard")` (`service.ts:1317-1322`) is the crashed-run
**workspace removal**, and `"discard"` is already a member of both op-name unions
(`schema.ts:4596-4605`, `service.ts:80-91`). ADR-181 §11's TS-only value `discard`
would alias a different operation. **The new op is `discardChanges`** (route
`discard-changes` as the ADR already names it). Recorded as a dated, non-direction
amendment on ADR-181 (T0.7) and in `workbench-git.md` Domain entities / Route
contracts.

### C2 — `{task_key}` has no column to read

`tasks` has `number` (`schema.ts:1404`) and `title` (`:1405`) but no `task_key`; the
human key is `projects.task_key` (`:228`) + `-` + `tasks.number`, composed at every
consumer (`queries/board.ts:416-419`, `queries/activity.ts:303`). The template
resolver JOINs `projects`; `run-<8hex>` covers the task-less run. `{attempt}` has no
`runs` column either: for a flow run it is the `attempt-N` suffix the internal
branch already carries (`services/runs.ts:1474-1476`), `1` for agent and scratch.

### C3 — the sync conflict path does not restore

The mechanical `agent:false` abort (`sync-target.ts:1024-1043`) calls
`abortSyncOperation` only; `restoreWorktreeToCommit` (`worktree.ts:3776`) is used on
the **resolver** failure path. ADR-181 D5's "ALWAYS aborts and restores the
pre-operation SHA" is therefore a code change (T2.1), not a re-wire.

### C4 — `Failed` is already admitted by the policy and already absent from the counters

`WORKTREE_ACTION_STATUSES` (`policy.ts:74-80`) contains `Failed`; the visibility gap
is `ACTIVE_RUN_STATUSES` + the board's `BacklogCard`, not the policy.
`decisions.ts:175-215` sums HITL + promotable (`Review` only,
`ext-activity/promotable.ts:29`) + crashed (`decision-sources.ts:149`
`eq(runs.status,"Crashed")`) + flagged — `Failed` counts nowhere today, so ADR-181
D2's "stays OUT" is a **guard control** (RED 3), not a change. Likewise
`lib/work/stage.ts:85` maps `Failed → "Ready"` by ADR-170 design and is untouched.

### C5 — `run.promoted` is a webhook-only event; `attribution.source` has one value

`webhooks/taxonomy.ts:19` lists `run.promoted`; `domain-events/taxonomy.ts` has no
such kind (`run.done` is emitted both ways, `promote.ts:1607-1636`).
`PromoteRunInput.attribution` (`promote.ts:92`) is `{ source: "auto_promotion";
laneClass }` and only writes `promotion_lane`. ADR-181's `source:"pr_finalize"`
needs a home: **D12** puts it on the `attribution` union (no `laneClass`,
`promotion_lane` stays `null`), on the `run.promoted` webhook `data.source`
(additive AsyncAPI field), and on the INFO log line.

### C6 — no push primitive can push a refspec or lease against a different remote name

`pushBranch` has no refspec; `forceWithLeasePush` hard-codes `origin` and the local
name; `remoteBranchHead` (`worktree.ts:1658-1693`) is the only `ls-remote` helper
and takes the remote-side name as `branch`; `remoteTrackingBranchHead` (`:1703-1739`)
builds `refs/remotes/<remote>/<branch>`; `branchHasUpstream` (`:3837-3851`) reads the
configured upstream but **discards the resolved name**. **D4** collapses these into
one push primitive with `remoteBranch` + explicit-SHA lease + `setUpstream`, and adds
`branchUpstream()` that returns `{remote, branch} | null`.

### C7 — `reopen` and `reattach` are not the same write

`reopen.ts:236-246` clears `archived_at` / `archived_branch`; ADR-181 §8 keeps
`archived_*` as history. The shared helper (**D10**) revives the worktree only;
each caller owns its `workspaces` write.

### C8 — `pr_state` is not written by finalize, and root `CLAUDE.md` §8 will be false

`finalizePullRequest` never writes `pr_state` (it stays `NULL` until `pr_state_scan`),
which is why finalize is admitted at `pr_state ∈ {NULL, open, merged}`. Root
`CLAUDE.md:437-440` asserts `pr_url`/`pr_state` are "written ONLY by the
`pr_state_scan` job" — `POST /pr` becomes a second writer of `pr_url`/`pr_number`
and the FIRST writer of `pr_state='open'`; the paragraph is amended in T4.3.

### C9 — the git-identity edge case is unreachable on commit and rescue

`workspace_git_identity_invalid` is raised only by `gc/preserve.ts:70-83`
(`git var GIT_AUTHOR_IDENT`). Snapshot commits use `commitIdentityArgs`
(`worktree.ts:1500-1511`), which supplies `user.name=maister` /
`user.email=noreply@maister.local` when unset — they cannot fail on identity. The
rescue snapshot (**D8**) uses the same helper, so `workbench-git.md`'s edge case is
re-worded as-built in T0.7 (identity failure belongs to the archive preserve path).

### C10 — no task write on promotion; the board derives `Done`

`promote.ts` contains no `update(tasks)`; `tasks.status` is flipped to `InFlight` at
launch (`services/runs.ts:1880-1886`) and `Done` is derived by `deriveStage` from the
latest run. PR finalize from `Crashed|Failed|Abandoned` therefore mirrors
`finalizePullRequest` exactly and writes no task row.

### C11 — `docs/configuration.md` already documents fields the loader rejects

`:322-323` list `project.repo_path` and `project.default_branch`; `projectBlockSchema`
(`config.schema.ts:190-196`) accepts `name | main_branch | branch_prefix | promotion |
default_runner` and is not `.strict()`, so unknown keys are silently stripped. This is
the section the new `public_branch_template` row lands in → **R9 TODO** (T0.8), not
fixed in passing.

### C12 — `docs/screens/runs/workbench.md:196` carries a stale `(Designed)` tag

"Lifecycle operations (Designed)" describes shipped behaviour. The section is the one
the panel replaces, so it is rewritten and retagged in T0.5 (in scope, not a
drive-by).

### C13 — line drifts (request → actual)

| Request | Actual | What |
|---|---|---|
| `layout.tsx:1231` | `:1226` call, `:1231` the `hasWorkspace` line, `:1512-1521` the `<WorkbenchLifecycleActions>` render | inspector vs lifecycle render sites |
| `board.ts:67-70`, `:97-101` | `:66-69`, `:100-102` | `TERMINAL_FAILED_STATUSES`, Failed→Backlog |
| `decision-sources.ts:91-107` | `:91-106`; filter `:149` | Crashed source |
| `lifecycle-actions.tsx:189-216` | `:189-215` | rail menu |
| `worktree.ts:2876-2890` | `:2856-2889` | `statusPorcelain` |
| `sync-target.ts:730-733`, `:1017-1038` | `:710-713`, `:1024-1043` | target resolution, mechanical abort |
| `promote.ts:1547-1592`, `:1497-1520` | `:1421-1674` (fn), `:1576-1592` (workspaces write), `:1520-1555` (sibling flip) | finalize |
| `pr-adapter.ts:643-663` | `:605-624` | provider dispatch |
| `pr-state-scan.ts:289-297` | `:288-296` | candidate predicate |

Also: `run.ts:808-815` computes `hasWorkspace: Boolean(row.workspaceId)` while
`layout.tsx:1231` uses `Boolean(detail.worktreePath)` after `run.ts:502` defaulted it
to the project repo path — the same page disagrees with itself (fixed by D2/D3).

### C14 — parked runs keep an `active` execution assignment; the ADR's assignment arm would disable `Crashed`

`releaseAssignmentForRun` (`execution-host/assignments.ts:240-272`) is called by the
graph's `Review` flip (`runner-graph.ts:~5522`, `run_terminal`), by `failed`
(`state-transitions.ts:921`), checkpoint (`:192`), waiting-on-children (`:440`),
park, stop and agent finalization — but **not** by `crashRunningRun`
(`state-transitions.ts:1364-1412`) nor `markAbandoned` (`:1155`). A `Crashed` (and an
abandoned-by-TTL) run therefore keeps `execution_assignments.state = 'active'` until
a recover re-entry supersedes it — by ADR-166 design: the retained driver generation
is what the recover CAS fences against. Read literally, ADR-181 D1's "no active
`execution_assignments` row" refuses every action on the ADR's primary case.
**Re-derived**: a parked status IS the no-live-writer witness — every re-entry
(resolver, recover, rework return, interrupt restart) flips `runs.status` inside its
CAS before it touches the tree — so the arm is implied by the status class and is
not an admission condition; `git-state` reports `hasActiveAssignment` as
information. Recorded as an ADR-181 amendment (T0.7); RED 1 pins "`Crashed` with an
active row is admitted". Q11 offers the alternative (release on crash), not
recommended.

### C15 — route error bodies drop `details`

`workbench-lifecycle/route-utils.ts:38-66` `errorPayload` forwards a top-level
`reason` for exactly two tokens (`workspace_preservation_failed`,
`workspace_git_identity_invalid`) plus `pushRejected`/`canForce`/`retryHint`, and
never `err.details`; the `sync` route's own `errorResponse` (`sync/route.ts:52-67`)
returns `{code, message}`. Every `details.reason` the panel branches on would be
lost. The established client-facing shape is `MaisterErrorBody.details`
(`web.openapi.yaml`, `additionalProperties: true`; ADR-093/132/149 precedent:
`{reason: "upstream_moved"}`, `{reason: "edit_lock_not_held"}`), already forwarded by
`rework-claim/return/route.ts:99-105`. **D24** widens both formatters additively; the
top-level `reason` enum is untouched.

### C16 — the e2e Gitea stub cannot be reached

`parseGiteaRemote` (`pr-adapter.ts:293-350`) derives `apiBase: https://${host}` —
the scheme is forced and the port dropped, so a `http://127.0.0.1:<port>/…` stub is
never called. The e2e provider is a **fake `gh` executable** on the web server's
PATH (T4.1); the adapter is not changed.

### C17–C25 — found during `/aif-implement` Phase 0 (2026-09-22/23)

Each is either decided by text the ADR already fixes, or was put to the owner
(Q12). Every one is recorded as an ADR-181 amendment in T0.7 where it touches the
record.

- **C17 — the ext sync route shares the core.** `api/v1/ext/runs/sync/route.ts`
  calls the same `syncRunTarget`, and `operations.openapi.yaml` documents
  `status='Review'` eligibility. Moving `assertSyncEligible`'s status arm to the D1
  predicate would silently widen the ext API, which ADR-181 Consequences fixes as
  unchanged. `SyncRunInput` gains `admission: "workbench" | "review"`; the web
  route passes `workbench`, the ext route `review` (the old arm, verbatim). The ext
  response is an explicit projection (`{runId, attemptId, outcome, behind,
  pushed}`), so `conflictedFiles` never reaches it. RED 14 gains the ext case.
- **C18 — `reused` needs the adapter.** `PrResult` is `{url, number}`; only the
  adapter knows whether `findOpenPr` returned an existing PR (a `pr_url` pre-image
  misses a PR opened outside MAIster, and would then claim the operator's
  title/draft were applied — the honesty rule). `PrResult` gains `reused: boolean`;
  T3.1's "`PrResult` unchanged" is superseded.
- **C19 — policy refusals carry a token.** `requireActionAllowed` throws a bare
  `PRECONDITION` today. It now carries `details.reason` = the disabled reason in
  snake_case (the closed set in C28, e.g. `worktree_missing`, `pr_closed` — one
  vocabulary, mechanically transformed; three tokens coincide with the service
  refusals `not_published`, `no_reattach_source`, `pr_missing`/`pr_closed` by
  construction), and `busy` is `CONFLICT` (the analytics edge case "another op holds the slot →
  `CONFLICT`"), every other reason `PRECONDITION`.
- **C20 — paths in responses.** No new response carries a worktree path except the
  copyable restore command. `git -C <worktree> restore --source=<ref> -- .` keeps
  its `-C`: a path-free restore pasted into the parent checkout would overwrite
  the parent's files. Precedent: `CheckoutContext` (ADR-160) already hands members
  the real path for copying. `reattach` answers `{ok, runId, source, head}`; the
  panel re-reads `git-state`.
- **C21 — `promotion_hold` gates auto-promotion only.** `promote.ts:619-639`
  checks it only when `attribution.source === "auto_promotion"` (ADR-126: "stop
  new auto-promotions"); a human `promoteRun` ignores it. "Fenced exactly as
  promotion is" therefore means a human finalize ignores it too. D12's
  `promotion_hold → PRECONDITION` fence and RED 20's case are dropped.
- **C22 — finalize's status allow-list is ADR-181 D6's.** D6 admits finalize from
  `Review` (via `promoteRun`) and `Crashed | Failed | Abandoned`; the D1 "whole
  set" wording and the analytics table's `HumanWorking`-owner and `Done` cells
  over-state it. The policy disables `finalizePr` on `Done` (`unsupported-status`:
  already finalized) and for the `HumanWorking` owner (`human-owned`: a status
  change while the claim is open, the same reasoning that keeps
  `archive | drop | stop` refused). RED 1's owner set loses `finalizePr`.
- **C23 — manual promotion requires `reviewedTargetCommit`.** `promote.ts:747-752`
  refuses every non-auto promotion without it ("never promote blind"). Owner answer
  Q12 (a): `POST /pr/finalize` takes `{reviewedTargetCommit?, allowTargetDrift?}`,
  forwarded to `promoteRun` from `Review`. Either field outside `Review` is 400
  `CONFIG` (never accepted-and-dropped). `git-state` gains `targetHead` (the local
  target ref SHA the panel rendered), and the panel offers "Finalize anyway" on
  the drift refusal.
- **C24 — Open PR needs the publication on `origin`.** gh/glab run in the parent
  repo and resolve `--head` in the base repository, and
  `promotePullRequestSideEffect` pushes to `origin`. A branch published to another
  remote → `PRECONDITION` `published_remote_not_origin` ("publish to origin
  first"); cross-repository (fork) PRs are out of scope.
- **C25 — sync's settle and recovery assumed `Review`.** `settleAttempt`
  (`sync-target.ts:548-553`) stamps `runs.review_entered_at` whenever HEAD moved,
  which restarts the auto-promotion grace window. Outside `Review` that would be
  false, so the stamp moves into the UPDATE's `WHERE status = 'Review'`. T2.1 also
  re-derives every stale-sync-claim recovery arm for the non-`Review` parked
  statuses (the recovery-window table is normative). This includes
  `releaseSyncClaimOnTerminal` (`state-transitions.ts:81-140`), whose `name='sync'`
  fence rests on "a sync can only ever be claimed by a `Review` run"
  (`sync-target.ts:761-762`). The new argument is: the claim tx re-validates the
  run under its row lock, so the sync holding the slot was admitted for the run's
  pre-terminal status and is exactly the one the terminalization cancels.
- **C26 — one writer per worktree includes promotion.** Promotion takes the
  PROMOTION claim, not the lifecycle slot. `claimLifecycleOperation`
  (`service.ts:2380-2446`) never reads `promotion_state`, and `promoteRun`'s
  reverse fence (`promote.ts:789-798`) refuses only a live `sync` claim. So a
  discard or reattach could run inside a worktree a `rebase_merge` promotion is
  rebasing. D20's invariant is closed in both directions, under the same
  `workspaces` row lock: `claimLifecycleOperation` refuses a live
  (non-`canReclaim`) promotion claim with `CONFLICT`, and the reverse fence refuses
  ANY live lifecycle claim. The `ai_rebase_merge` delegation already releases its
  promotion claim before calling sync (`promote.ts:936-939`), so nothing
  legitimate holds both. In the policy, a live promotion claim is `busy`, and
  `promotion_state = 'done'` disables `update` with the new reason `promoted`
  (sync's forward fence `sync-target.ts:778-783` refuses it; reopen is the
  designed way back). The policy input carries `busy` and `promotionState` as
  facts computed by the D1a loader (the pure predicate takes no clock).
- **C27 — a different PR clears the old PR's lifecycle fields.** When Open PR
  records a `pr_url` that differs from the stored one, the previous PR's ADR-140
  fields (`pr_has_conflicts`, `pr_merged_at`, `pr_merge_commit_sha`) are reset to
  `NULL` in the same UPDATE (null = unknown until scanned). Otherwise a new PR
  would inherit the old one's merge or conflict evidence. A reused PR with the same
  url keeps them.
- **C28 — the policy covers sync's shape arms.** `update` is refused by
  `assertSyncEligible` for a scratch run, an orchestrator child, a shared tree
  and a launched evaluation participant (`sync-target.ts:184-207`). The policy
  would otherwise enable a button the server always refuses. The shape arms are
  extracted as a pure `syncShapeRefusal(run)`, consumed by both the D1a loader
  (`updateShapeOk`) and `assertSyncEligible`. A refusal disables `update` with
  the new reason `unsupported-run`. Likewise `openPr` without a publication is
  disabled `not-published`, and `reattach` on a usable worktree is disabled
  `worktree-present` or, with no source, `no-reattach-source`. The closed
  reason set is `live-workbench | human-owned | missing-workspace |
  removed-workspace | worktree-missing | worktree-present | busy |
  unsupported-status | unsupported-run | promoted | no-remote | not-published |
  no-reattach-source | pr-missing | pr-closed`.
- **C29 — an unknown run is 409 on the lifecycle family today.**
  `loadLifecycleContext` throws a bare `PRECONDITION` (`service.ts:2070-2072`), so
  archive/drop/discard answer 409 although their spec already documents 404.
  D19's "unknown run → 404" is met at the one shared loader: the throw carries
  `details.reason: "run_not_found"`, and `route-utils` maps that token to 404.
  This brings the existing family-A routes in line with their spec, and the token
  is inert on the ext token paths (same code, same `PRECONDITION`).
- **C30 — the handoff branch keeps a UI.** The handoff form (remote + handoff
  name, `GET handoff-metadata` + `POST handoff-branch`) lives INSIDE the Export
  dialog today (`lifecycle-actions.tsx` footer). Removing the dialog would
  silently remove handoff, which the plan says stays. The form moves unchanged
  into the panel's Publish section as a secondary **Handoff branch…** action;
  `loadMetadata` survives for it. T1.R's orphan list loses `loadMetadata`.
- **C31 — reattach's crash window vs the reconciler's removal arm.**
  `processTrustedCandidate` (`gc/workspace-reconciler.ts:595-630`) REMOVES a
  worktree whose matching row has `removed_at` set
  (`removed_already_removed_workspace`), without reading the workspace lifecycle
  claim. It would therefore delete a reattach's freshly added worktree, both
  mid-flight (between `worktree add` and the DB write) and after a crash. The
  arm reads the claim first: a live claim (any op) → hold and retry; a stale or
  failed `reattach` claim → complete the reattach (`removed_at` /
  `scheduled_removal_at` → NULL, claim released, finding `workspace_reattached`);
  otherwise the existing removal. Symmetrically, a reattach RETRY that finds a
  directory which is a registered worktree of the parent repo, on the internal
  branch, whose provenance names this run (its own crashed attempt) adopts it:
  no second `worktree add`; it re-stamps provenance and writes the row. Any
  other directory stays `worktree_path_occupied`, untouched. RED 17 gains the
  mid-flight hold, the adoption retry and the foreign-directory refusal.
- **C32 — "keeps its signature" cannot hold as written.** The rail, cards and
  inspector need the widened id set, and the legacy input lacks the facts that
  decide it. `deriveWorkbenchLifecycleActions` stays as a re-export of the ONE
  predicate (`lib/workbench-git/policy.ts`). Its input keeps every legacy field
  and gains OPTIONAL facts: `worktreePresent`, `busy`, `promotionState`,
  `publishedBranch`, `hasRemote`, `prUrl`, `prState`, `updateSupported`,
  `reattachSource`. A git-probed fact left `null`/`undefined` means "not
  probed" and never hides an action. Consequently `policy.test.ts` migrates
  (contract moved: a usable parked worktree now also admits commit, discard
  and update, per ADR-181 D1), and `service.test.ts`'s exact
  `preserveWorktree` argument gains `archivePush` (D17).
- **C33 — test ids.** The plan's `git-panel-<section>` and `git-panel-<action>`
  collide on `update` and `reattach`. Sections are `git-panel-section-<s>`,
  buttons `git-panel-action-<id>`, and the run-detail host button is
  `workbench-git-open`.
- **C34 — the inspector lists only href-bearing items.** Each renders as a
  link; a disabled one keeps its reason text. `deriveInspectorActions` computes
  `href` through one shared `gitPanelHref` (the rail uses the same helper) for
  the git ids, plus `handoffBranch` → publish. `stop | archive | drop |
  promote | recover` have no deep link and drop out of the list; their controls
  live on the page. The inspector id set widens with `discardChanges | update |
  openPr | finalizePr | reattach`. `run-inspector.test.ts`'s two href-less
  fixtures migrate (contract moved), and so does the rail's `menu-exportBranch`
  absence assertion (G4 names that absence the defect).
- **C35 — the panel pre-fills from the server.** `GitStateResponse` gains
  `suggestedPublicBranch` and `prDefaults` (OpenAPI updated in this phase). The
  PR body's run link uses the request origin: no public-URL setting exists for
  the web, and this plan adds no env var. RED 7's "update-from-published brings
  a remote push back" step moves to RED 14, because it needs Phase 2's
  `onto:"published"`.
- **C36–C44 — found during Phase 1 GREEN and REFACTOR (2026-09-23).**
  - **C36 — error bodies forward the reason TOKEN, not `details`.** D24 said
    `...(err.details ? { details: err.details } : {})`. The existing route
    suite pins that other `details` fields (`private: "not public"`) never
    leave the server. `route-utils` and the `sync` route therefore forward
    `details: { reason }` only — the UI's one branch key — so no server-side
    context (attempt ids, SHAs) can ride a refusal. `run_not_found` maps to
    404 in the same formatter (C29).
  - **C37 — T1.R does NOT fold the three local git fixtures.** They are not
    copies. real-git builds a non-clone repo with a SEPARATE worktrees root (the
    drop tests' allowed-root check needs it); sync-target sets repo identity
    config and cuts worktrees with the production `addWorktree`. Folding them
    would change behaviour, which the refactor gate forbids. The shared fixture
    gained what it lacked instead: a repo `user.name/email`, without which a
    production rebase (Phase 2) fails on a host with no global identity.
  - **C38 — `remoteTrackingBranchHead` / `remoteBranchExists` gain no
    `remoteBranch?`.** Their `branch` argument already IS the remote-side name;
    callers pass the public name. A second parameter would duplicate it.
  - **C39 — `discardWorktreeChanges` is its own primitive.** `reset --hard HEAD`
    + `clean -fd` with the shared containment guard, not the ADR-079
    `discardWorktree` (`restore --staged --worktree`), because a parked tree can
    hold an unmerged index that `restore` refuses.
  - **C40 — no placeholder sections.** Update and PR land WITH their operations
    (T2.3, T3.5) rather than as disabled Phase-1 placeholders (no throwaway UI).
    Reattach ships in Phase 1 because RED 12 renders it; its route is T2.2.
  - **C41 — the lifecycle race test injects the session/role deps.** vitest
    2.1.9's `requestWithMock` skips a manual mock while the importer's shared
    callstack holds it, so two racers' first lazy `import("@/lib/authz")` hands
    the second the REAL module. The race under test is the claim; every other
    default dep stays production.
  - **C42 — surfaces.** The Backlog card uses the `menu` variant (D14); the
    flight card keeps `compact`, its git ids rendered as deep links. Only the
    detail host (`DetailGitHost`) reads `?git=` and the run stream, so a rail row
    never re-renders on a query change. `getRunDetail` feeds its D2 facts from
    the ONE loader (`loadWorkbenchGitFacts`). Promotion's reverse fence was
    widened to any live lifecycle claim in Phase 1 (C26), beside the lifecycle
    claim's refusal of a live promotion claim.
  - **C43 — an existing publication outranks the template (a regression the
    integration lane caught).** D4's order was upstream → request → template.
    A PR opened BEFORE ADR-181 has the INTERNAL branch as its head and no
    publication record, so re-promoting a reopened run rendered the template,
    pushed a second branch and opened a SECOND PR — the exact failure reopen
    exists to prevent (`reopen.integration.test.ts` "re-promote REUSES the same
    PR"). The same hole lets an edited task title re-render a new slug once the
    upstream config is gone (a re-attach from the archive ref). The order is now:
    upstream on this remote → the recorded `published_*` on this remote → a
    pre-ADR-181 PR head (`pr_url` set, no record, on `origin`) → request →
    template, each fixed case refusing a different request with
    `public_name_fixed`. `nameSource: "upstream"` names every fixed case (the
    OpenAPI description is widened in T4.3). A promotion derives the name from
    the WORKSPACE's owning run, so a shared tree's branch name does not depend on
    which sibling promotes. Pinned by `publication.test.ts` (10 cases; reverting
    the precedence fails 5 of them and the reopen reuse case).
  - **C44 — the recovery sweep's landed-push proof read the old name (found in
    T1.R).** An orphaned mechanical sync in `pushing` is settled forward only
    when the remote head equals the worktree HEAD. The sweep (W4b) read
    `origin/<internal>`, but T1.7 moved the push itself to the publication, so a
    push that DID land was recorded `failed`. It now reads `syncPushTarget`, the
    same target the live path and the W3 arm use. Pinned by a
    `sync-recovery.integration.test.ts` case on a publication at `fork`
    (reverting the read fails it).
- **C45–C53 — found during Phase 2 (2026-09-23).**
  - **C45 — `admission` defaults to `review`.** Only the web route opts into
    the policy (`workbench`); the ext API passes `review` explicitly (C17) and
    every internal caller — the `ai_rebase_merge` delegation — keeps ADR-141's
    arm by default. The RED 14–15 cases pass `admission: "workbench"`.
  - **C46 — RED 15 cannot falsify the restore.** For a plain conflict
    `git rebase --abort` already returns HEAD, so reverting to abort-only left
    RED 15 green. The reset exists for the case where the operation's own
    state is gone before the abort (an operator's `git rebase --quit`); a twin
    control drops it mid-conflict through a `rebaseOntoRef` seam, and
    falsification 9 runs against the twin (abort-only leaves HEAD on the
    target's tip).
  - **C47 — an update onto the run's own publication may land on it.** The
    verify gate's "identical to the target" refusal guards the run's own
    commits; for `onto:"published"` with nothing local past the ref
    (`aheadBefore === 0`) landing exactly on it IS the update, so the check is
    waived there only. Local-only commits must still survive.
  - **C48 — the workbench admission is the policy, and only the policy stops a
    non-owner.** The status set re-checked under the row lock admits
    `HumanWorking` (for the claim owner); a control pins that anyone else gets
    `human_owned` (dropping the policy call fails it).
  - **C49 — recovery re-verifies against the attempt's own `target_ref`.** A
    resolver may now run for `onto` base or published (in `Review`); W3 read the
    promotion target. A local branch resolves to its head, `<remote>/<public>`
    to the tracking ref.
  - **C50 — one revival for reattach and reopen, with reattach's contract.**
    `publishedTarget` (moved from `sync-target.ts` to `publication.ts`) names
    where a branch lives on a remote — the recorded publication, else
    `origin/<internal>` — for the revival, the sync push and the
    reattach-source fact alike. A failed fetch is `EXECUTOR_UNAVAILABLE` (the
    OpenAPI 503), where reopen used to swallow it and revive from a possibly
    stale tracking ref; reopen also gains the archive source and the upstream
    re-set.
  - **C51 — a stamped tree is never compensated.** Reattach removes the
    worktree it added only when the provenance stamp failed; once the tree
    names the run it is an adoptable attempt (C31). A failed `worktree add`
    behind the claim (the branch checked out elsewhere) pins that the row stays
    removed (falsification 10).
  - **C52 — the review panel links into the git panel.** Its three sync entry
    points (chip, conflict card, drift card) are links to `?git=update`
    (`gitPanelHref`); the detail host opens on a `?git=` change without a
    remount. The resolver runner choice moved into the Update section (Review
    only) through `syncDefaults`, so no ADR-141 capability is lost.
    `buildRunSyncPanelData` drops the dialog's seeds (`strategyDefault`,
    `published`), ten `run.sync*` keys are removed, and `e2e/pr-reopen.spec.ts`
    — which drove the dialog too — is migrated with `run-sync.spec.ts`.
  - **C53 — one `onto` → ref mapping.** `resolveSyncRef` lives in
    `lib/runs/sync-ref.ts`; the git-state read model counts each update option
    against the same ref, so it drops the `baseCommit` fallback: a base the
    update would refuse (`base_branch_unknown`) shows no counts.
- **C54–C68 — found during Phase 3, the T4.3 truth pass, the T4.1 smoke, T4.4 and Phase 5 (2026-09-23).**
  - **C54 — attribution rides the finalize, not `PromoteRunInput`.** D12 widened
    `PromoteRunInput.attribution` with `{source:"pr_finalize"}`, but that source
    is minted only by the parked finalize, which never enters `promoteRun`. The
    input keeps its one value; `finalizePullRequest` takes a
    `PromotionAttribution` (auto-promotion | pr_finalize) and derives
    `promotion_lane` from it. A finalize from Review is a promotion and carries
    no source (RED 20 pins the absence).
  - **C55 — the shared-tree flip includes the finalized run.** "Review siblings
    only — a no-op from a non-Review root" would leave a finalized Failed
    allocator Failed under `promotion_state='done'`. The flip is
    `status = 'Review' OR id = <run>`; for a promotion from Review the promoting
    run is Review already, so nothing changes there.
  - **C56 — C26 on the scratch claim.** Phase 1's reverse fence covered the
    workspace-run claim only; a scratch `rebase_merge` now rebases inside the
    worktree and a scratch PR pushes, so the scratch claim reads the same
    `assertNoLiveWorkbenchClaim` (extracted from the workspace claim, one fence
    for both and for the parked finalize). Pinned by a promote-service case.
  - **C57 — a scratch rebase lands by fast-forward.** It records
    `promoted_head_sha` and no `merge_commit_sha`, as a flow run's
    `rebase_merge` does, and its `run.promoted` names the real mode (the scratch
    finalize said `local_merge` unconditionally).
  - **C58 — Open PR honours the scratch target lock.** A scratch PR opened to a
    foreign base would not be the PR a later finalize-from-Review promotion
    looks up (head/base), which would open a second one. `scratchPromotionTarget`
    (`scratch_runs.target_branch ?? base_branch`) is the one lock, read by the
    scratch promotion and by Open PR.
  - **C59 — a promotion keeps its own PR title and body.** The Open PR defaults
    (`pullRequestDefaults`, one function with git-state's `prDefaults`) apply to
    the panel; `promotePullRequestSideEffect` passes its existing title/body
    and `draft: false`. The shared core is the provider resolution
    (`preflightedPrAdapter`, extracted from promotion; `provider_unsupported` on
    both paths) plus the one `createOrUpdatePr` contract.
  - **C60 — a missing published ref.** Open PR reads a vanished
    `origin/<public>` as `not_published` (publish first) and a different head as
    `publish_stale`; finalize reads both as `publish_stale`, the one token its
    contract lists.
  - **C61 — authorization order on `/pr` and `/pr/finalize`.** The route gates
    the session before the body (an anonymous caller never reaches up to 64 KiB
    of body); the service then authorizes `promoteRun` on the run's own project,
    as discard and reattach do — one pattern for the git service's ops.
  - **C62 — RED 20's race holds its window open.** Two finalizes started
    together can serialize before either claims — the first finishes, the
    second is refused as already Done — and would pass against a tree with no
    claim fence at all. The control holds the first arrival at its HEAD read
    until the second arrives (both past every pre-claim check, the slot free)
    and, like RED 11, injects the session/role deps (C41). Falsification 13 —
    no claim CAS and no attempt fence — then shows both finalizes fulfilled.
  - **C63 — `prFinalize` is not a lifecycle op value.** D15 added it to both
    op-name unions, but a finalize holds the PROMOTION claim (D12, D20), so
    the name was never written. It is removed from the unions and from the
    op-name lists in the ERD comment, the schema doc, the analytics and the
    ADR amendment.
  - **C64 — the parked finalize confirms first.** T0.6's manual promises a
    confirmation before a finalize outside `Review`, where no readiness is
    asserted; the panel opens the shared destructive confirmation there (and
    not in `Review`, where the finalize is a promotion). Finalize is shown only
    while a PR is recorded (the screen contract), and Open PR is the PR
    section's own form rather than a modal — the screen doc says so as built.
  - **C65 — the "remote moved" hint needs the tracking head.** Q3 (a) spends
    `git-state`'s one network read so the panel can say the publication moved
    on the remote; the read model computed the tracking ref's head but never
    served it, so the screen's hint could not render. `GitStateResponse` gains
    `publishedTrackingHead` (additive, OpenAPI updated) and the Update section
    shows the hint when the two differ. Likewise the served `rescueRefs` were
    never listed; the Tree section lists them newest first. The header chip's
    "with its source" was never served (the name source is the publish
    response's `nameSource`); the screen doc now says so.
  - **C66 — a vanished worktree failed the run page (found by the T4.1
    smoke's `[WebServer]` log).** `withTempIndexCopy`'s `rev-parse --git-path
    index` threw a raw error when the worktree directory was gone, so the run
    layout's change summary rethrew it (it renders only a `MaisterError` as
    "unavailable") — exactly the `worktree-gone` page Reattach is offered on.
    Pre-existing code, made reachable by this plan; it now refuses `CONFLICT`
    like every sibling git read (`worktree-diff-namestatus.test.ts` pins it,
    red on the unfixed helper).
  - **C67 — the ADR-160 comment in `getRunDetail` was displaced (found in
    T4.4, profiling the m11b e2e failure).** Phase 1 inserted the git fact
    loader between that comment and `deriveRunContinuation`, so the comment
    ("the launched-lineage probe [is] paid ONLY on that path") read as if it
    described the loader, which probes on every non-scratch run. Moved back above
    `deriveRunContinuation`; no code change.
  - **C68 — the rail labelled a `Failed` row "Running" (found in T5.2, the rail
    screen doc's tone table).** `railStatus` fell through to `{label:
    "Running", tone: "running"}` for any status it did not name, and D14 made
    `Failed` rows reachable there — a failed workbench read as a live, pulsing
    run. It now maps to `{label: "Failed", tone: "crashed"}` (EN "Failed", RU
    "Ошибка", `portfolio.railStatus`), outside the rail's attention labels as
    ADR-181 D2 requires; RED 3 pins it (red on the unfixed mapping).
- **Token set (final, T0.1).** Service refusals: `public_name_fixed`,
  `public_branch_template_invalid` (400 `CONFIG`), `clean_worktree`,
  `dirty_worktree`, `not_published`, `published_remote_not_origin`,
  `publish_stale`, `target_branch_unknown`, `provider_unsupported`,
  `agent_requires_review`, `base_branch_unknown`, `pr_missing`, `pr_closed`,
  `target_drift` (added at `promote.ts`'s drift throw; `isTargetDriftResponse`
  prefers it over its message match), `review_only_field` (400),
  `no_reattach_source`, `worktree_path_occupied`, `run_not_found` (404). Policy
  refusals: C19 over C28's set. Redocly baseline: `master` already carries 8
  `nullable-type-sibling` errors and 46 warnings (unrelated schemas; R9 TODO
  (c) in T0.8). The T0.1 AC therefore reads "no new Redocly error or warning" and
  `validate:contracts` green.

---

## Decisions

### D1 — One predicate, one module: `web/lib/workbench-git/policy.ts`

Pure, no I/O. Input is the fact set the ADR names, nothing more:

```
WorkbenchGitPolicyInput = {
  runKind: "flow" | "scratch" | "agent";
  runStatus: RunStatusValue | (string & {});      // unknown admits nothing
  scratchDialogStatus: string | null;              // stop arm only (existing rule)
  viewerUserId: string | null;
  claimOwnerUserId: string | null;                 // open review_rework_claim owner
  workspace: null | {
    removedAt: Date | null;
    worktreePresent: boolean;                      // fs.stat by the read model
    lifecycleOp: { state; name; leaseExpiresAt } | null;
    prUrl: string | null; prState: "open"|"merged"|"closed"|null;
    publishedBranch: string | null;
    hasRemote: boolean;
  };
  hasLiveSharedSibling: boolean;                 // a shared-tree sibling in SLOT_HOLDING_RUN_STATUSES
  reattachSources: { local: boolean; published: boolean; archive: boolean };
}
WorkbenchGitActionId = "snapshotCommit" | "discardChanges" | "exportBranch" | "update"
  | "openPr" | "finalizePr" | "reattach" | "archive" | "drop" | "stop"
  // ADR names → code ids: commit→snapshotCommit, discard→discardChanges, publish→exportBranch
WorkbenchGitDisabledReason = "live-workbench" | "human-owned" | "missing-workspace"
  | "removed-workspace" | "worktree-missing" | "busy" | "unsupported-status"
  | "no-remote" | "pr-missing" | "pr-closed"
```

- **Status axis is an exhaustive map** `STATUS_CLASS satisfies Record<RunStatusValue,
  "live" | "parked" | "human">` (`Pending | Running | NeedsInput | NeedsInputIdle |
  WaitingOnChildren → live`, `HumanWorking → human`, `Review | Crashed | Failed | Done
  | Abandoned → parked`); a twelfth status is a compile error, an unknown runtime
  string admits nothing. `WORKTREE_ACTION_STATUSES` is derived from this map and
  **exported** — one source for the policy, `deriveWorkbenchLifecycleActions`,
  `assertSyncEligible` (T2.1) and the finalize allow-list (T3.3).
- **Order** is the `workbench-git.md` flowchart verbatim: live → none; `HumanWorking`
  → owner (both ids real strings and equal — keep `ownsOpenReworkClaim`'s
  `undefined === undefined` guard, `policy.ts:118-139`) gets the full git set incl.
  `discardChanges` and `update`, never `archive | drop | stop` (`human-owned`); parked →
  row? → usable? (`removedAt IS NULL AND worktreePresent`) → busy? → all; not usable
  → only `reattach`, and only if a source resolves (else `removed-workspace` for all;
  `worktree-missing` is the reason shown on the others when the row is not removed
  but the path is gone).
- `busy` = `lifecycleOp.state === "claiming"` with an unexpired lease
  (`canReclaimLifecycle`'s rule, `service.ts:540-559`, exported for reuse) **or**
  `hasLiveSharedSibling` (a parked allocator root whose shared tree a live child
  still writes — `countUnsettledSharedSiblings`, `promote.ts:39`). The ADR's
  execution-assignment arm is NOT an admission condition (C14): a parked status is
  the witness that no driver owns the tree; `hasActiveAssignment` is reported by
  `git-state` only.
- `finalizePr` additionally needs `prUrl` (`pr-missing`) and `prState !== "closed"`
  (`pr-closed`); `openPr`/`publish`/`update(onto:published)` need `hasRemote`
  (`no-remote`) — the server re-checks each with the real remote list.
- `deriveWorkbenchLifecycleActions` keeps its signature (six callers) and is
  re-implemented on top of this predicate; `WorkbenchLifecycleActionId` widens to
  the full git set (`snapshotCommit | discardChanges | update | openPr | finalizePr
  | reattach` beside `stop | archive | drop | exportBranch`) and `ACTION_ORDER` is
  extended. **One vocabulary**: policy ids = DTO ids = UI ids = testids = i18n keys
  (patch `2026-09-21-17.09`: two vocabularies for one closed set); op names are a
  separate mapping — `exportBranch→exportBranch`, `snapshotCommit→snapshotCommit`,
  `update→sync`, `discardChanges→discardChanges`, `openPr→prOpen`,
  `finalizePr→prFinalize`, `reattach→reattach`. The 101-line matrix test stays
  green unchanged except the carve-out file (§Assertion migration).

### D1a — One fact loader: `web/lib/workbench-git/facts.ts`

The predicate is pure; `loadWorkbenchGitFacts({ run, workspace, viewerUserId, db })`
is the ONE place its inputs are assembled — `claimOwnerUserId` through
`openReworkClaimOwnerUserId` (D2), `hasLiveSharedSibling` through
`countUnsettledSharedSiblings`, `hasActiveAssignment` (informational) through
`getActiveAssignment` (`execution-host/assignments.ts:63`), `worktreePresent` through
`worktreePresence`, `reattachSources` (three git reads, computed only when the row is
not usable), the lifecycle slot and PR fields from the `workspaces` row. Four
callers, one loader: `loadContext` (`service.ts:2040+`, so `requireActionAllowed` at
`:395-440` gates the mutating ops), the `git-state` read model (D3), `syncRunTarget`
admission (D9 — `viewerUserId = input.actor.type === "user" ? input.actor.id :
null`), and `finalizePullRequestRun` (D12). No caller re-derives a fact the loader
already returns (patch `2026-09-21-15.45`: DRY by question).

### D2 — The carve-out opens: viewer and claim owner reach every read model

- `WorkbenchLifecycleDeps.requireActiveSession: () => Promise<{ id: string }>`
  (drop `| void`); the default impl returns the authz user. The six
  `sessionUser?.id ?? null` sites become `sessionUser.id`.
- The claim-owner predicate at `service.ts:2117-2121` (`getActiveTakeover` +
  `decision === REVIEW_REWORK_CLAIM_DECISION`) is extracted to
  `web/lib/runs/rework-claim.ts` as `openReworkClaimOwnerUserId(runId, db)` and
  called by `loadContext`, `getRunDetail` and the run-detail layout — **one question,
  one function**.
- `lifecycleActionsForWorkspace` (`portfolio.ts:263-285`) gains explicit
  `claimOwnerUserId` / `viewerUserId` parameters; the rail, portfolio and board
  callers pass `null, null` with the ADR-160 comment (no `HumanWorking` actions off
  the run detail) — their behaviour is unchanged and RED 2 asserts it.
- `getRunDetail` is `cache()`-wrapped and keyed on `runId` alone (`run.ts:437`), so a
  viewer-dependent projection cannot live inside it: it returns the FACTS
  (`workspaceId`, `removedAt`, `archivedBranch`, `worktreePresent`, `claimOwnerUserId`
  from the shared predicate) and keeps the viewer-less `lifecycleActions` for
  non-detail consumers; the run-detail layout (which has the viewer,
  `layout.tsx:345`) derives both the lifecycle actions and the
  `deriveInspectorActions` input with `lifecycleActionsForViewer(facts, viewerUserId)`
  — the same policy call, one level up.
- `hasWorkspace` is `workspaceId != null` on both `run.ts:812` and `layout.tsx:1231`
  (the `worktreePath` fallback at `run.ts:502` stays for display, it no longer feeds
  a policy).

### D3 — `git-state`: one route, ~10 git calls, degrades field-wise, never in an RSC

`web/lib/workbench-git/read-model.ts` `loadGitState(runId, viewer)` and
`GET /api/runs/{runId}/git-state` (family A route, `recoverRun` = member — the
response class is branch names, SHAs, **counts** and ref names; no file paths, no
diff bodies, so it stays below `readRepoFiles`).

```
GitStateResponse = {
  runId, runKind, runStatus,
  internalBranch, publicBranch, publishedRemote, publishedAt,
  upstream: { remote, branch } | null,           // git config branch.<internal>.{remote,merge}
  remotes: string[],
  worktreePresent, workspaceRemoved, head: sha | null,
  dirty: { tracked: number; untracked: number },
  unpushedCommits: number | null,                // ahead of <publishedRemote>/<publicBranch>
  aheadBehind: { base, target, published }: ({ahead, behind} | null) each,
  publishedRemoteHead: sha | null, remoteReachable: boolean,   // ls-remote, best effort
  pr: { url, number, state, hasConflicts } | null,
  busy: { name, claimedAt } | null,
  hasActiveAssignment,                           // informational only (C14)
  hasLiveSharedSibling,
  reattachSources: { local: sha|null; published: sha|null; archive: sha|null },
  rescueRefs: [{ ref, sha, createdAt }],
  actions: WorkbenchGitAction[],                 // D1 output
  commands: { checkout: string[]; restoreRescue: string | null },
  warnings: string[]                             // sub-reads that degraded to null
}
```

- Base/target for `flow|agent` come from `workspaces.base_branch/target_branch`; for
  `scratch` from `scratch_runs.base_branch/target_branch` (the `workspaces` row has
  none — G10). Counts reuse `aheadBehindCounts` (`worktree.ts:3564-3607`), presence
  is one `fs.stat`, rescue refs one `for-each-ref refs/maister/rescue/<runId>/`.
- **Network**: one `ls-remote` of the public name (existing `remoteBranchHead`,
  `NETWORK_GIT_ENV`, its 60 s cap) reported as `publishedRemoteHead`; a failure sets
  `remoteReachable:false` and a warning — never a route error. `unpushedCommits`
  and `aheadBehind.published` are computed against the **tracking ref** (kept fresh
  by publish/update); `publishedRemoteHead !== tracking head` is what the panel
  renders as "the remote moved — update from published". (Q3 offers the no-network
  variant.)
- Fetched by the panel on open, after every action, and debounced on the run SSE
  tick — the `node-transcript-panel.tsx:70-115` pattern (no SWR in this repo).
  `getRunDetail` and the layout never call it.
- When the worktree is absent, worktree-scoped reads are skipped (`dirty`, `head`
  null) and repo-scoped ones still run (`reattachSources`, `pr`, `rescueRefs`).

### D4 — Publish: one push primitive, refspec + upstream + explicit-SHA lease

`pushBranch` (`worktree.ts:959`) becomes the single push primitive:

```
PushBranchArgs = { projectRepoPath; remote; branch; remoteBranch?: string;
  setUpstream?: boolean; force?: boolean; leaseSha?: string | null }
// argv: push [--force-with-lease=refs/heads/<remoteBranch>:<leaseSha|''>] [--set-upstream]
//       --end-of-options <remote> refs/heads/<branch>:refs/heads/<remoteBranch ?? branch>
```

`forceWithLeasePush` (`:3866`) and `pushWithLease` (`sync-target.ts:283`) become
thin wrappers (`remote`, `remoteBranch` threaded), so sync and publish share the
lease code path. `remoteTrackingBranchHead` / `remoteBranchExists` gain an optional
`remoteBranch`; `branchUpstream(repo, branch): { remote; branch } | null` is new
(`rev-parse --symbolic-full-name <b>@{upstream}` → `refs/remotes/<r>/<b>`);
`branchHasUpstream` is re-expressed as `branchUpstream(...) !== null`.

`exportWorkbenchBranch` (`service.ts:1485-1590`) is the publish operation (op
`exportBranch`), extended:

1. `requireActionAllowed` → D1 `publish`.
2. **Name** (the `publishBranchName` core, also used by `promotePullRequestSideEffect`
   — D11): (a) `branchUpstream(internal)` whose `remote === args.remote` → its branch;
   a request `branchName` that differs is refused `PRECONDITION`
   `details.reason:"public_name_fixed"` (loud, per the no-silent-defaults rule; the UI
   hides the field when an upstream exists); (b) `args.branchName` through
   `branchNameSchema`; (c) D5 template. `workspaces.published_branch` is a
   consistency witness only — a mismatch with the upstream logs WARN and the upstream
   wins.
3. Claim `exportBranch`; optional snapshot commit (unchanged).
4. `leaseSha = remoteBranchHead({remote, branch: public})` — captured **before** the
   push, the ADR-141 property.
5. `pushBranch({branch: internal, remoteBranch: public, setUpstream: true, force,
   leaseSha: force ? leaseSha : undefined})`. Non-force non-fast-forward →
   `GitPushRejectedError` (`CONFLICT`, `pushRejected:"non_fast_forward"`,
   `canForce:true`); a stale lease on the forced retry is the same classification
   (`isNonFastForwardPush` matches "stale info"), local branch kept.
6. **After** the push: `recordPublished(workspaceId, { remote, branch: public, at })` —
   the ONE writer of `published_branch`, `published_remote`, `published_at`, under
   the lifecycle CAS; the same helper runs after sync's push (D9) and promotion's
   push (D11), so a public-name push is never left unrecorded (patch
   `2026-09-18-16.45`: a marker released by one of three arms); finalize the claim.
7. Result gains `publishedBranch`, `publishedRemote`, `publishedRef`
   (`<remote>/<public>`), `nameSource: "upstream"|"request"|"template"`; `pushedRef`
   is kept equal to `publishedRef` for the existing callers.

Crash between 5 and 6: the retry resolves the same name from the now-set upstream,
`ls-remote` returns the pushed SHA, the push is a no-op, step 6 records — idempotent
by construction (ADR Consequences), pinned by RED 7.

### D5 — Template rendering and transliteration (`web/lib/workbench-git/public-branch-name.ts`)

`renderPublicBranchName(template, { taskKey, title, attempt, runId })`:

- `{task_key}` → `<projects.task_key>-<tasks.number>` or `run-<runId.slice(0,8)>`;
  `{attempt}` → C2; `{slug}` → `transliterate(title)` (fixed table: `а→a б→b в→v г→g
  д→d е→e ё→yo ж→zh з→z и→i й→y к→k л→l м→m н→n о→o п→p р→r с→s т→t у→u ф→f х→kh
  ц→ts ч→ch ш→sh щ→shch ъ→'' ы→y ь→'' э→e ю→yu я→ya`, upper-case rows likewise;
  every other non-ASCII code point dropped), lower-cased, `[^a-z0-9]+` → `-`,
  trimmed, sliced to 40, trimmed again; when empty the surrounding separators
  collapse (`feature/ABC-12-` → `feature/ABC-12`).
- Unknown placeholder, empty result, or a rendered name failing `branchNameSchema` →
  `MaisterError("CONFIG")` `details.reason:"public_branch_template_invalid"`; the
  dialog falls back to the editable field pre-filled with `{task_key}` alone.
- The template itself is validated at YAML parse and at registration (`allowed
  placeholders only; at least one placeholder`) — validation on the action path, not
  only on preview.

### D6 — Migration `0173` and the YAML ↔ DB round-trip

```sql
ALTER TABLE workspaces ADD COLUMN published_branch text,
                       ADD COLUMN published_remote text,
                       ADD COLUMN published_at timestamptz;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_published_shape_check
  CHECK ((published_branch IS NULL) = (published_remote IS NULL)
     AND (published_branch IS NULL) = (published_at IS NULL));
ALTER TABLE projects ADD COLUMN public_branch_template text NOT NULL
  DEFAULT 'feature/{task_key}-{slug}';
```

- Additive; no live data moves; the constant default IS the intended value for every
  pre-migration project (no "looks populated" trap: the template is a policy, not a
  per-row computed marker). The co-nullity CHECK is the same shape discipline as
  `workspaces_lifecycle_claim_shape_check` (`schema.ts:4719`). Generated by
  `drizzle-kit generate` from `schema.ts` (never hand-edited); rationale header in
  the `0171/0172` style.
- `maister.yaml`: `project.public_branch_template?: string` on `projectBlockSchema`
  (`config.schema.ts:190-196`, D5 validation); registration
  (`app/api/projects/route.ts:402-418`) maps it (absent → column default);
  `serializeProjectConfig` (`yaml-writeback.ts:135-168`) emits it, omitted when equal
  to the default, like `branch_prefix`; the bootstrap at `route.ts:178-200` leaves it
  absent (default).
- **Round-trip controls (RED 5)**: SET (YAML value → column), CLEAR (YAML without the
  key → column = default), re-SET, and the reverse (column default → key omitted;
  non-default → key emitted, `maisterYamlV2Schema.parse` round-trips). There is **no
  live YAML→DB re-sync for an already-registered project** today (`branch_prefix`
  has the same shape); the plan does not add one. The settings panel shows the
  template read-only beside `branch_prefix` (`settings-panel.tsx:121-130`); editing is
  Q1.

### D7 — Every "remote name = local name" reader moves to `published_*`

| Consumer | Today | After |
|---|---|---|
| `isBranchPublished` (`branch-published.ts:21-28`) | `prUrl != null \|\| branchHasUpstream()` | `prUrl != null \|\| publishedBranch != null \|\| branchHasUpstream()` — new arg `publishedBranch`; **no `.catch`** on the live sync path (header comment kept) |
| sync push (`sync-target.ts:732-741`, `:1094-1108`) | `remoteBranchHead(origin, internal)` / `pushWithLease(internal)` | `remote = published_remote ?? "origin"`, `remoteBranch = published_branch ?? internal` for both the lease capture and the push, then `recordPublished` |
| rework-claim ingest (`rework-claim-ingest.ts:70-93`) | `fetch <remote>` + `merge --ff-only <remote>/<internal>` | when `published_*` set: fetch `published_remote`, tracking ref `<published_remote>/<published_branch>`; else unchanged; the body-controlled `remote` stays allow-listed against `listRemotes` |
| reopen revival (`reopen.ts:158-188`) | `origin/<internal>` | the D10 helper (local → published → archive) |
| `promotePullRequestSideEffect` (`promote.ts:1378-1398`) | push `origin`/internal, PR head = internal | the D4 core (public name, upstream, `published_*`) and D11 core |
| verify gate `HEAD is not on <branch>` (`sync-target.ts:237-245`) | internal | **unchanged** — the worktree is always on the internal branch |

### D8 — Discard-changes is preserve-first and index-safe (op `discardChanges`)

`discardWorkbenchChanges(runId)` in `web/lib/workbench-git/service.ts`, route
`POST /api/runs/{runId}/discard-changes` (family A, body `{}` strict, authz
`promoteRun` in deps):

1. D1 `discardChanges`; `statusPorcelain` empty → `PRECONDITION` `details.reason:
   "clean_worktree"` (the existing reason `isCleanWorkbenchPrecondition` matches).
2. Claim `discardChanges`.
3. **Rescue** without touching the real index: `GIT_INDEX_FILE=<tmp>` `git add -A` →
   `write-tree` → `commit-tree <tree> -p HEAD -m "maister: rescue <runId> #<n>"` with
   `commitIdentityArgs` (C9) → `update-ref refs/maister/rescue/<runId>/<n> <sha>`;
   `n = max(existing) + 1` from `for-each-ref`. New helpers in `worktree.ts`:
   `writeRescueRef({worktreePath, runId}) → {ref, sha}`, `listRescueRefs`.
4. `reset --hard HEAD` then `clean -fd` (no `-x`: ignored files are not the
   operator's work).
5. Result `{ rescueRef, sha, restoreCommand: "git -C <wt> restore --source=<ref> --
   ." }`; `git-state` lists the refs.

The rescue ref is the point of no return: a crash after step 3 and before 4 leaves
the tree dirty and the ref written; the retry writes `#n+1` (a second ref, never a
lost one — the ADR's idempotence). Rescue refs are repo refs, untouched by `git
worktree remove`, `branch -D` (`worktree.ts:517-530` deletes `refs/heads/*` only) and
the preserve path; lifetime is Q10.

### D9 — Update is the ADR-141 core with `onto`, admitted by D1, restoring on conflict

`POST /api/runs/{runId}/sync` body (`sync/route.ts:22-28`, `.strict()`) gains
`onto: z.enum(["target","base","published"]).optional()` (default `target`).
`syncRunTarget`:

- **Admission**: `assertSyncEligible` (`sync-target.ts:174-212`) replaces its `:175`
  status arm with the D1 predicate (`update` enabled for the viewer), keeping the
  run-kind / parent / shared / lineage / removed arms (RED 14 asserts those five
  still refuse after the status arm moves — patch `2026-09-21-21.55`). `agent:true` with
  `runs.status !== "Review"` → `PRECONDITION` `details.reason:"agent_requires_review"`
  (the resolver's `Review → Running` CAS is the only path that changes status).
  **Default**: `agent ?? (status === "Review")` — the ADR-141 default (resolver ON)
  is preserved in `Review`; every other status defaults to mechanical. The panel
  always sends `agent` explicitly.
- **Ref by `onto`**: `target` — unchanged (`workspaces.target_branch ??
  project.main_branch`, fetched from `origin` and fast-forwarded locally);
  `base` — `workspaces.base_branch` (null → `PRECONDITION` `base_branch_unknown`),
  same fetch + local ff-update as target; `published` — requires `published_*`
  (else `PRECONDITION` `not_published`), `fetchRemote(published_remote)`, ref
  `refs/remotes/<published_remote>/<published_branch>`. `run_sync_attempts.target_ref`
  records the chosen ref string (`<branch>` or `<remote>/<public>`); `target_sha`
  its SHA.
- **Conflict**: `abortSyncOperation` **and** `restoreWorktreeToCommit(headShaBefore)`
  (C3), then `abortAttempt` with `conflictedFiles`; the 200 body gains
  `conflictedFiles: string[]` (additive on `SyncRunResponse`). The resolver branch
  (`:936-1022`) is untouched.
- **Push**: D7 row — lease captured on the public name before the fetch, refspec
  `internal:public`, default `push ?? published` unchanged; `recordPublished` after a
  successful push (D4).
- **Errors**: the route's own `errorResponse` (`sync/route.ts:52-67`) forwards
  `details` (D24); its status mapping (422 on shape) is unchanged.
- The ReviewPanel's sync dialog (`review-panel.tsx:403-530`) is removed; its
  `review-sync-open` opens the panel's Update section. `review-ahead-behind`,
  `review-sync-in-progress`, promote and the readiness/drift chips stay.

### D10 — Reattach re-creates the worktree; reopen shares the revival, not the write

`reattachWorkbench(runId)` (op `reattach`, authz `recoverRun`, route
`POST /api/runs/{runId}/reattach`, family A, body `{}`):

1. D1 `reattach` (the row exists, is NOT usable, a source resolves). A directory
   already at `worktree_path` → `CONFLICT` `details.reason:"worktree_path_occupied"`,
   **before any git call**, nothing removed.
2. Claim `reattach`.
3. `reviveWorktreeForWorkspace({ parentRepoPath, worktreePath, branch,
   publishedRemote, publishedBranch, archivedBranch })` in `web/lib/runs/revive-worktree.ts`
   → `{ source: "local" | "published" | "archive"; head }`:
   local `localBranchHead` → else `fetchRemote(published_remote)` +
   `createLocalBranchAt(branch, <remote>/<public>)` + `branch --set-upstream-to`
   (so D4(a) holds on the next publish) → else `createLocalBranchAt(branch,
   archived_branch)` → `addWorktreeForBranch` (`worktree.ts:3945`).
   No source → `PRECONDITION` `details.reason:"no_reattach_source"`.
4. Provenance v2 from DB facts: `installWorktreeProvenance({worktreePath, metadata:
   { version: 2, runId, parentRepoPath, projectId, branch, workspaceKind: run_kind,
   createdAt: workspaces.created_at, task?: "<key>-<n>", flow?:
   "<flowRefId>@<runs.flow_revision>" }})` (the `services/runs.ts:1522-1538` shape).
   A provenance failure removes the just-added worktree (compensation, as
   `addWorktree` does at `worktree.ts:259`) and rethrows.
5. **Only then** `UPDATE workspaces SET removed_at = NULL, scheduled_removal_at =
   NULL` (`archived_*` kept); finalize the claim.

`reopenRun` (`reopen.ts:158-188`) calls the same helper and keeps its own writes
(`promotionState:"reopened"`, clears `archived_*` — C7). Crash between 4 and 5: the
worktree exists with valid provenance while the row says removed — the workspace
reconciler's sweep gains the arm "row exists, `removed_at IS NOT NULL`, worktree
present with matching provenance → null `removed_at`/`scheduled_removal_at`,
finding `workspace_reattached`" (today it only INSERTS when no row exists,
`workspace-reconciler.ts:656-668`; RED 17 pins the new arm).

### D11 — Open PR is a claim-fenced core shared with `pull_request` promotion

`openPullRequest(runId, input, ctx)` in `web/lib/workbench-git/service.ts` (op
`prOpen`), route `POST /api/runs/{runId}/pr` (inline authz as `sync` does: `requireActiveSession`
→ body → `runProjectId` → `requireProjectAction(projectId,"promoteRun")`; body
`{ title?: string(≤256), body?: string(≤65536), draft?: boolean, targetBranch?:
branchNameSchema }` strict; errors through `workbench-lifecycle/route-utils.ts` —
400 on shape, `details` forwarded, D24):

1. D1 `openPr`. Dirty tree → `PRECONDITION` `dirty_worktree` naming commit and
   discard. Not published → `PRECONDITION` `not_published`. Published head
   (`remoteBranchHead(published_remote, published_branch)`) ≠ local `HEAD` →
   `PRECONDITION` `publish_stale` ("publish first").
2. Target = `input.targetBranch ?? workspaces.target_branch ?? project.main_branch`,
   validated by the same rule `promoteWorkspaceRun` applies to `input.targetBranch`
   (extracted into `resolvePromotionTarget` if it is not already a function — one
   rule, two callers; RED 19 asserts a target promotion would refuse is refused here
   too).
3. Provider: `project.repo_url ?? readRemoteOrigin`, `project.provider ??
   detectProvider`, `selectPrAdapter` + `preflight` (`promote.ts:1362-1374`,
   extracted to the core); `generic` → `PRECONDITION` exactly as promotion.
4. Claim `prOpen`; `createOrUpdatePr({ repoPath, remote: published_remote,
   sourceBranch: published_branch, targetBranch, title, body, draft })`. `PrAdapter`
   gains `draft` (gh/glab `--draft` on create; gitea/gitverse `title = "WIP: " +
   title` — the lookup `findOpenPr` matches head/base only, so a `WIP:` PR is still
   found). An existing open PR for the same head/base is returned **untouched**
   (title/body/draft are never patched — unchanged adapter semantics, documented).
5. **After** provider success: `UPDATE workspaces SET pr_url, pr_number, pr_state =
   'open', target_branch = <target>` (so finalize and `repo_delivery_scan` read the
   PR's real base); `runs.status` unchanged; finalize the claim.
6. Result `{ ok, url, number, state: "open", reused: boolean, draft }`.

Server defaults when the body omits them: `title = "<task_key>: <task title>"`
(`"<internal branch>"` for a task-less run), `body = "<run link>\n\nPublished
<public> → <target> (run <id>)."` — the UI pre-fills the same. Failure table in D19.
`promotePullRequestSideEffect` (`promote.ts:1342-1411`) is re-based on the D4 core
(publish under the public name) + this core (open/find), then finalizes — so a
Review-run `promoteRun(pull_request)` and the panel's publish → openPr → finalize
converge on identical rows.

### D12 — Finalize is `finalizePullRequest` extracted, under the promotion claim

`finalizePullRequestRun(runId, ctx)` (op `prFinalize`), route
`POST /api/runs/{runId}/pr/finalize` (inline authz, body `{}`, errors through
route-utils — D24):

- D1 `finalizePr` (`pr_url` set, `pr_state ∈ {NULL, open, merged}`; `closed` →
  `PRECONDITION` `pr_closed`; missing → `pr_missing`).
- **From `Review`**: `promoteRun(runId, { mode: "pull_request" }, ctx)` — readiness,
  target drift and the ADR-126 gates apply unchanged; with the branch already
  published and the PR already open, the re-based side effect is a no-op push + a
  found PR + finalize.
- **From `Crashed | Failed | Abandoned`** (allow-list, exhaustive over the D1
  `parked` class minus `Review|Done`): mint the promotion claim with the existing
  CAS (`canReclaim`, `promote.ts:176-196`; `promotion_state='claiming'`,
  `promotionMode:'pull_request'`, `targetBranch = workspaces.target_branch`,
  `promotionOwnerUserId`) in the `FlowClaim` shape (`promote.ts:1324-1334`:
  `resolvedMode = responseMode = promotionMode = "pull_request"`, `resolvedTarget =
  workspaces.target_branch ?? project.main_branch`, `policy =
  deliveryPolicyFromLegacyPromotionMode("pull_request")`, `baseCommit =
  workspaces.base_commit`), fenced exactly as promotion is — an active `sync` claim
  (`:788-799`) → `CONFLICT`, `runs.promotion_hold` (`:620`) → `PRECONDITION`
  `promotion_hold`, unsettled shared siblings (`countUnsettledSharedSiblings`,
  `:652`) → `CONFLICT` — then call the extracted `finalizePullRequest({ runId, ctx, db, claim, pr: {url, number},
  sourceHead, promotionLane: null, attribution: { source: "pr_finalize" } })` where
  `sourceHead = remoteBranchHead(published)`; when the worktree is usable it must
  equal local `HEAD` (`publish_stale` otherwise), so `promoted_head_sha` is what the
  operator reviewed. The extracted function keeps every write of
  `promote.ts:1421-1674`: the attempt fence, the shared-tree sibling flip
  (`:1520-1555`, `Review` siblings only — a no-op from a non-Review root, still
  executed by the shared path), `runs` (`Done`, `endedAt`, `promotedHeadSha`,
  `mergeCommitSha: null`, `diffStat: null`), `workspaces` (`promotionState:"done"`,
  `promotedAt`, `scheduledRemovalAt = now + gcAgeDays`, `prUrl`, `prNumber`,
  `promotionLane`), `systemCloseActiveAssignmentsForRun` (M13 human assignments —
  not execution assignments, C14), `run.promoted` webhook,
  `run.done` webhook + domain event per settled run, `recordPrArtifact` after commit.
  `run_kind` is dispatched **before** routing: a scratch run additionally sets
  `scratch_runs.dialog_status = 'Done'` and `target_branch` (`promote.ts:1942-1949`).
- **Attribution** (C5): `PromoteRunInput.attribution` union gains
  `{ source: "pr_finalize" }`; `promotion_lane` stays `null`; `isUnattendedPromotion`
  returns false for it; the `run.promoted` webhook `data` gains optional
  `source: "pr_finalize"` (AsyncAPI additive); the INFO line carries it.
- No slot is held by any admitted status (`SLOT_HOLDING_RUN_STATUSES`), so no
  slot-release call; no `tasks` write (C10). Response is `PromoteRunResult`.

### D13 — Scratch: three modes, target from `scratch_runs`

`promoteScratchRun` (`promote.ts:1744`) drops the `:1751-1757` refusal:
`local_merge` unchanged; `rebase_merge` runs the workspace-run rebase+merge side
effect with `targetBranch = scratch.targetBranch ?? scratch.baseBranch` (the
existing target lock `:1784-1792` stays); `pull_request` = D4 core + D11 core +
D12 finalize (scratch arm) with the same target. The scratch launch insert
(`scratch-runs/service.ts:926-933`) is **not** widened — the cores take
`targetBranch` from the caller; `git-state` reads scratch base/target from
`scratch_runs` (D3). The scratch inspector keeps its `<select>` (now honoured) and
hosts the panel through `WorkbenchLifecycleActions` (`scratch-inspector-actions.tsx:75`).
`pr_state_scan` keeps `run_kind <> 'scratch'` (ADR text; Q5) — a scratch PR opened
standalone shows its chip as "open (not tracked)" and finalizes manually.

### D14 — `Failed` fan-out: every consumer, decided

| Consumer | Change |
|---|---|
| `ACTIVE_RUN_STATUSES` (`portfolio.ts:77-90`) | `+ "Failed"`; pinned by a direct unit assertion (none exists — `run-status-sets.test.ts:9-14` style) |
| portfolio `:396`, `:946`; `queries/project.ts:358` | inherit: portfolio grid, project workspace list, rail list a `Failed` workbench |
| `RAIL_TTL_STATUSES` (`portfolio.ts:100`) | unchanged — no TTL countdown on `Failed` |
| `app/api/attention/stream/route.ts:149,183` | inherits as a **change-scan predicate only** (refresh ticks, no count); accepted; RED 3 asserts `decisions.count` unchanged |
| `queries/board.ts` | `BacklogCard` gains `latestRun: { id, kind, status, lifecycleActions }` when the latest run is `Failed \| Abandoned` (or `Review \| Crashed` with a removed workspace — `board.ts:88-90`) **and** the worktree is usable; `TaskCard` renders `<WorkbenchLifecycleActions variant="menu">` from it |
| `decisions.ts` / `decision-sources.ts:149` | **unchanged**; guard control |
| `lib/work/stage.ts:85` | unchanged (`Failed → Ready`, ADR-170) |
| scheduler / caps / sweeps / GC | unchanged — `Failed` holds no slot and is not `DISPOSABLE` |
| `deriveWorkbenchLifecycleActions` | already admits `Failed` (C4) |
| `docs/screens/*`, RU manual | the Backlog card menu and the portfolio row documented (T0.5, T0.6) |

Worktree presence for cards: the board/portfolio queries call one helper
`worktreePresence(paths: string[]) → Map<path, boolean>` (bounded `Promise.all` of
`fs.stat`, only rows with `removed_at IS NULL`, one page) so "usable" has one
definition on every surface; it is a stat, not git state (ADR D3 stands).

### D15 — Lifecycle op names

Both unions (`schema.ts:4596-4605`, `service.ts:80-91`) gain
`"discardChanges" | "reattach" | "prOpen" | "prFinalize"`; `publish` reuses
`exportBranch`, `update` reuses `sync`. The column is plain `text`
(`workspaces_lifecycle_claim_shape_check` is name-agnostic) — no migration for the
names. The `docs/db/runs-domain.md:253` comment lists the full set.

### D16 — Surfaces

- **`WorkbenchGitPanel`** (`web/components/workbench/git-panel.tsx`, client) —
  sections, in order: header (internal branch, public-name chip with `nameSource`,
  PR chip with state, busy chip from `busy`), **Tree** (dirty counts; Commit →
  existing snapshot dialog; Discard → shared destructive confirmation showing the
  rescue ref + copyable restore command), **Publish** (remote select from `remotes`,
  name field pre-filled by the template — hidden when `upstream` exists, force
  checkbox shown only after a `non_fast_forward` refusal), **Update** (`onto`
  select with per-option ahead/behind, strategy, push toggle default = published,
  AI-resolver toggle rendered only when `runStatus === "Review"`), **PR** (Open PR
  dialog: title/body/draft/target pre-filled; Finalize button; chip), **Reattach**
  (rendered instead of the rest when `!worktreePresent`; lists resolvable sources),
  **Commands** (copyable checkout and restore lines, the `checkoutContext` strings).
  Every button is enabled from `actions[]`; a disabled one carries the reason's
  tooltip. Every completed mutation → shared feedback provider + re-fetch
  `git-state` + `router.refresh()`. Errors branch on `MaisterError.code` and
  `details.reason` only (EN/RU copy under `workbenchGit.errors.*`).
- **Hosting**: `WorkbenchLifecycleActions variant="detail"` opens the panel where it
  opened the Export dialog (`lifecycle-actions.tsx:524-526`, `:646-660`); the Export
  dialog, `loadMetadata` and the `GET handoff-metadata` call are removed from the
  component (the route stays for the handoff-branch dialog until it is folded — see
  Out of scope). Flow, agent and scratch run detail get it through the same
  component; `layout.tsx:1512-1521` passes the D2 facts.
- **Cards and rail**: `railMenuItems` emits every enabled git action id
  (`snapshotCommit | discardChanges | exportBranch | update | openPr | finalizePr |
  reattach`) as **deep links** (`/runs/<id>?git=<section>` — the run detail's URL
  state contract, `docs/screens/runs/workbench.md:63`), never blind mutations from a
  card (a publish needs a name, an update an `onto`). `menu-<item>` testids as today
  (`lifecycle-actions.tsx:945`).
- **Inspector Actions tab**: `layout.tsx:1240-1245` sets `href` = the same deep link
  for every lifecycle item; `run-inspector.tsx:203-222` lists **only** href-bearing
  items (the `<span>` fallback is deleted); `inspector-actions.ts` `endpoint`/`method`
  stay for the API consumers.
- **i18n**: action labels extend the existing `workbenchLifecycle.action.*` (one
  copy of the closed action set — patch `2026-09-21-17.09`); panel-only copy
  (sections, dialogs, disabled reasons, commands, PR chip states) lives under
  `workbenchGit.*`; EN + RU (parity enforced by `lib/__tests__/i18n-parity.test.ts`)
  + a named-key suite `lib/__tests__/i18n-workbench-git-keys.test.ts` in the existing
  per-surface style.
- **Typed input survives a refresh**: the Open PR form, the publish name field and
  the commit message are rendered outside the `git-state` refresh boundary and keep
  their state across a refetch tick (patch `2026-09-17-12.25`: a conditional unmount
  discarded an unsent answer); RED 12 asserts it.
- **Testids**: `git-panel`, `git-panel-<section>`, `git-panel-<action>`,
  `git-panel-busy`, `git-panel-pr-chip`, `git-panel-name`, `git-panel-force`.

### D17 — Unpushed-work guard and the archive knob

The Archive and Drop confirmations (`lifecycle-actions.tsx`) fetch `git-state` on
open and render `unpushedCommits` + `dirty` counts with two primaries: "Publish,
then archive/drop" (runs publish first, the destructive op only after its 200) and
"Archive/drop anyway". Server side, `archiveWorkbenchForCtx` and
`removeWorkbenchForCtx` pass `archivePush: gcArchivePush()` into `prepareWorkspaceRemoval`
→ `preserveWorktree` (today they pass nothing → `false`), so operator archive/drop
honour `MAISTER_GC_ARCHIVE_PUSH` exactly like GC; the configuration row's "Used by"
widens (T0.4). The archive ref stays local by default.

### D18 — Identifiers per route

| Route | Identifier | Source | Handling |
|---|---|---|---|
| all | `runId` | `url-param` | the only trusted locator; project/workspace/branch/paths/remote/PR derived by DB lookup (`server-state`) |
| all | viewer | `auth-context` | `requireActiveSession` → `requireProjectAction(projectId,…)` with `projectId` from the run row |
| `export-branch` | `remote` | `body-controlled` | allow-listed against `listRemotes` (existing `PRECONDITION`) |
| `export-branch` | `branchName` | `body-controlled` | `branchNameSchema`; used only as a remote ref name in argv after `--end-of-options`; refused when an upstream fixes the name |
| `export-branch` | `commitMessage`, `snapshotDirty`, `force` | `body-controlled` | existing bounds |
| `sync` | `onto`, `strategy`, `agent`, `push` | `body-controlled` | closed enums / booleans; `runnerId` validated against the runner catalog (existing) |
| `pr` | `targetBranch` | `body-controlled` | `branchNameSchema` + the promotion target rule (D11 step 2); passed to gh/glab via `assertSafeBranchRefs` |
| `pr` | `title`, `body`, `draft` | `body-controlled` | length-bounded strings, boolean; never interpreted |
| `pr/finalize`, `discard-changes`, `reattach`, `git-state` | — | — | **no body fields**; strict `{}` |

No body field names a filesystem path component, a project, a workspace or a PR.

### D19 — Two-phase commit and crash windows per mutating operation

Every operation runs under the lifecycle claim (`claimLifecycleOperation`, `FOR
UPDATE`, lease = `promotionClaimTimeoutSeconds()`); git/provider effects run OUTSIDE
any DB transaction; the durable record is the AFTER-side write. Retryability follows
the existing rule: `EXECUTOR_UNAVAILABLE` leaves the claim `claiming`
(`markLifecycleClaimFailed`, `service.ts:662-692`), typed refusals finalize it
`failed`.

| Op | Before the effect | Effect (point of no return) | After | Crash between effect and after → retry |
|---|---|---|---|---|
| publish | claim; name; `ls-remote` lease | `git push … internal:public` | `published_*`; release | upstream now set → same name; push no-op; record |
| discard | claim | rescue ref (`update-ref`) then `reset --hard` + `clean -fd` | release | second rescue ref; reset idempotent |
| update | attempt row + sync claim (one tx) | fetch, rebase/merge, verify, optional lease push | `settleAttempt` | existing ADR-141 recovery (safety net + sweep of stale `sync` claims) |
| reattach | claim; occupied-path check | `worktree add` + provenance | `removed_at = NULL` | reconciler `workspace_reattached` arm (D10) |
| openPr | claim; publish-stale check | provider create (or find) | `pr_url/pr_number/pr_state/target_branch` | found by head/base; recorded |
| finalize | promotion claim (CAS) | — (DB-only; one tx) | — | claim CAS: superseded → `CONFLICT` |

Failure classification (shared): body shape → 400 on every new route (route-utils;
`sync` keeps its 422); `PRECONDITION`/`CONFLICT` → 409 (the payload carries
`details` incl. `details.reason`, plus `pushRejected`, `canForce`, `retryHint`,
through the widened `errorPayload` — D24); `EXECUTOR_UNAVAILABLE` → 503, claim
retryable; `UNAUTHORIZED` → 403; unknown run → 404. Both directions are reasoned:
"effect succeeded, DB write failed" is the retry column above; "effect failed" never
writes the AFTER-side row. No deferred is created by any of these paths (no
supervisor call, no ACP request), so the deferred-release rule has no consumer here
— stated, not assumed.

### D20 — Lock scope = invariant scope; the racer is designed from the invariant

Invariant: **one writer per worktree at a time**. Lock: the per-workspace lifecycle
slot taken under `SELECT … FOR UPDATE` on that `workspaces` row (existing). Every new
op takes it before its first git command; `prFinalize` takes the promotion claim
(same row, CAS on `promotion_attempt_id`) and is fenced against an active `sync`
claim exactly as `promoteRun` is. RED 11: two racers that could both violate the
property (`publish` vs `discard` on one workspace, real Postgres, the winner's git
effect uncommitted while the loser is parked at the `FOR UPDATE`), asserted at the
service layer with the second call resolving `MaisterError("CONFLICT")` — and a
guard-disabled control showing both would have run without the claim.

### D21 — No new background automation

`pr_state_scan` keeps its progress cursor, batch, lease headroom and skip semantics;
`POST /pr` only widens its candidate population (RED 23 proves a `Failed`-run PR is
scanned). No timer, sweep or consumer is added; the reconciler gains one arm (D10)
inside its existing sweep.

### D22 — SOLID / KISS / DRY rulings (checkable)

| Ruling | Verdict | Why |
|---|---|---|
| One push primitive (`pushBranch` with `remoteBranch`/`leaseSha`/`setUpstream`) used by publish, sync and promotion | **merge** | one question: "put this branch on the remote under that name, safely" |
| Name resolution (`publishBranchName`) shared by export and `promotePullRequestSideEffect` | **merge** | one question |
| PR open core shared by `/pr` and `pull_request` promotion | **merge** | one question; keeps `pr_url` semantics identical |
| `finalizePullRequest` extracted, two callers | **merge** | already one function; extraction only |
| `reviveWorktreeForWorkspace` shared by reopen and reattach | **merge** | the revival is one question; the row write is two (C7) — callers keep their own writes |
| `openReworkClaimOwnerUserId` shared by service and read models | **merge** | one predicate, three readers |
| `discardWorkbenchChanges` vs `discardWorkbench` | **NOT merged** | different questions (reset a tree vs remove a workspace) |
| `reattach` vs `reopen` | **NOT merged** | reopen changes run status and promotion state |
| Scratch launch insert widened with base/target | **NOT done** | the cores take the target from the caller; surgical |
| SRP | `policy.ts` decides, `read-model.ts` observes, `service.ts` mutates, `public-branch-name.ts` renders; no module imports a higher one | keeps each unit testable in the `unit` project |
| KISS | no new `runs.status`, no new `MaisterError` code, no new env var, no new table, no SWR | each rejected with a reason recorded here |

### D23 — Authorization from data class; positive grants; adversarial budget

- `git-state` → `recoverRun` (member): branch names, SHAs, counts, ref names —
  the same class the run header and `review-ahead-behind` already show to members;
  conflict **paths** (`conflictedFiles`) come back only from `sync`, which is
  `promoteRun`, matching today's response class. All mutating routes → `promoteRun`,
  except `reattach` → `recoverRun` (it restores state, mutates no branch content —
  the same floor as archive/drop).
- One **positive** control per new grant (member 200) beside the viewer 403, per
  route (RED 10, 19, 20).
- Adversarial review is budgeted for **every fix cycle** of this branch (the owner's
  pipeline: `/aif-verify` → `/aif-review` → codex adversarial review → fix confirmed
  findings), with the publish/force/PR-open paths named as the irreversible-effect
  surfaces to attack.

### D24 — Error bodies carry `details`; the top-level `reason` enum is untouched

`errorPayload` (`route-utils.ts:38-66`) gains `...(err.details ? { details:
err.details } : {})` — the `rework-claim/return/route.ts:99-105` shape — and the
`sync` route's `errorResponse` (`sync/route.ts:52-67`) the same line. The five new
routes format errors through route-utils (400 on body shape, 409/503 as today). The
UI branches on `code` + `details.reason` only; `MaisterErrorBody.details` is already
`additionalProperties: true` in the spec, and the two-value top-level `reason` enum
and the `pushRejected` enum are not touched. Every 409 in T0.1 documents its
`details.reason` token(s). Never a server-only handle in `details` (existing rule).

---

## Contract surfaces → spec files

| Surface | Change | Spec file(s) |
|---|---|---|
| `GET /api/runs/{runId}/git-state` | new | `docs/api/web.openapi.yaml` (+ `components/schemas/GitStateResponse`); `docs/system-analytics/workbench-git.md` Route contracts |
| `POST /api/runs/{runId}/discard-changes` | new | same; op name `discardChanges` |
| `POST /api/runs/{runId}/pr` | new | same (+ `OpenPrBody`, `OpenPrResponse`) |
| `POST /api/runs/{runId}/pr/finalize` | new | same (response `PromoteRunResponse`) |
| `POST /api/runs/{runId}/reattach` | new | same |
| `POST /api/runs/{runId}/export-branch` | body `+ branchName`; response `+ publishedBranch/publishedRemote/publishedRef/nameSource` | `web.openapi.yaml:9208-9290` (inline body, `additionalProperties: false`) |
| `POST /api/runs/{runId}/sync` | body `+ onto`; response `+ conflictedFiles` | `web.openapi.yaml:6529-6622`, `SyncRunResponse:19560` |
| Error bodies (`export-branch`, `sync`, the five new routes) | `details` forwarded (additive; `MaisterErrorBody.details` is already `additionalProperties: true`); top-level `reason` enum untouched — D24 | `web.openapi.yaml` `MaisterErrorBody` description; per-route `details.reason` documentation |
| `run.promoted` webhook payload | `+ data.source: "pr_finalize"` (optional) | `docs/api/async/outbound-webhooks.asyncapi.yaml` (`:630` description; payload schema) |
| `workspaces.published_branch/remote/at`, `projects.public_branch_template` | migration `0173` | `web/lib/db/migrations/0173_*.sql` + journal + snapshot; `docs/db/erd.dbml` (regenerated); `docs/db/runs-domain.md:222-254` (+ PROJECTS stub `:94-97`); `docs/db/projects-domain.md:25`; `docs/database-schema.md:2183-2239`, `:265-295` |
| `maister.yaml` `project.public_branch_template` | new optional key | `docs/configuration.md:231-238` (example), `:318-329` (table); `web/lib/config.schema.ts:190-196`; `web/lib/packages/yaml-writeback.ts:118-168` |
| `MAISTER_GC_ARCHIVE_PUSH` | new consumer (operator archive/drop) | `docs/configuration.md:1146` (Used by); no `.env.example`/compose change (host-run, ADR-023; compose passes env wholesale) |
| Error cells | `PRECONDITION`, `CONFLICT`, `CONFIG`, `EXECUTOR_UNAVAILABLE` gain `Also (Implemented, ADR-181): …` clauses with the `details.reason` tokens `public_name_fixed`, `public_branch_template_invalid`, `clean_worktree`, `dirty_worktree`, `not_published`, `publish_stale`, `agent_requires_review`, `base_branch_unknown`, `pr_missing`, `pr_closed`, `no_reattach_source`, `worktree_path_occupied` | `docs/error-taxonomy.md:43-52` |
| Lifecycle op names | `+ discardChanges \| reattach \| prOpen \| prFinalize` (TS-only) | `docs/db/runs-domain.md:253`; `docs/system-analytics/workbench-lifecycle.md` matrix; `workbench-git.md` Domain entities |
| Policy / read model / operations | Designed → Implemented, as-built | `docs/system-analytics/workbench-git.md` (Expectations stay at 12 — edit in place, each names its enforcer); `workbench-lifecycle.md:53,69,131,147-159,243,270`; `branch-sync.md` (`onto`, restore, public-name lease); `git-integration.md:242,299,360` (+ a `### Publish, discard, re-attach (Implemented, ADR-181)` topical section — room: 9 bullets); `scratch-runs.md:292`; `workspaces.md:188,333,552`; `attention.md` unchanged (cited) |
| Screens | new `docs/screens/runs/git-panel.md` + README row `:202-206`; `flow-run.md:260`, `scratch-run.md`, `run-inspector.md`, `workbench.md:196` (retag, C12); board card menu in `projects/*` | `docs/screens/**` |
| RU manual | operator paths: publish / update / PR / discard / reattach; the Failed card | `docs/ru/manual/07-review.md:7,18`; `05-tasks-runs.md:39,62` |
| ADR | Amendments list (C1, C2, C9, C12); status Accepted → Implemented at T4.3 (record + stub `decisions.md:1838-1843` + index row `:225`) | `docs/decisions/adr-181.md`, `docs/decisions.md` |
| Root agent contract | §7 workbench bullet `:382-384` (+ panel ops), §8 `:437-440` (C8) | `CLAUDE.md` |

**No** new `runs.status` · **No** new `MaisterError` code · **No** new env var ·
**No** ext API / MCP change · **No** supervisor change.

## Commit plan

Eight commits, one per phase boundary, RED before GREEN in every code phase:

1. `docs(workbench-git): freeze the ADR-181 contracts (OpenAPI, ERD, taxonomy, screens, RU)` — after T0.1–T0.8
2. `test(workbench-git): RED — parked runs have no git path` — after T1.0
3. `feat(workbench-git): git panel, git-state, publish under a public name, discard, Failed visibility, carve-out` — after T1.1–T1.R
4. `test(workbench-git): RED — update is Review-only, removed worktrees are dead ends` — after T2.0
5. `feat(workbench-git): update onto base|target|published; re-attach a removed worktree` — after T2.1–T2.R
6. `test(workbench-git): RED — a PR is a promotion` — after T3.0
7. `feat(workbench-git): open a PR before promotion, finalize from any parked status, scratch promote modes` — after T3.1–T3.R
8. `docs(workbench-git): ADR-181 Implemented — as-built sweep, e2e smoke, live PR check` — after T4.1–T4.4

No AI co-author trailer (owner rule). Merge to `master` with `--no-ff` after `/aif-verify` → `/aif-review` → codex adversarial review → confirmed findings fixed.

---

## Phases

Four phases, each landing green on the exact tree (`pnpm --filter maister-web test`,
`pnpm lint` at the 0-errors baseline for changed files, `pnpm typecheck`,
`pnpm validate:docs`, `pnpm validate:contracts`). RED controls are written first in
every code phase and committed before the GREEN work. Task ids are the plan's task
list (no TaskCreate tool is available in this session).

### Phase 0 — SDD freeze (docs only; no code)

**Exit criteria**: every contract surface in the table above exists as `(ADR-181 —
Designed)` text, internally consistent with the ADR and with each other;
`pnpm validate:docs` green (Mermaid, ADR bijection, links, indexes, ERD check —
the ERD check stays green because no schema changes yet);
`npx @redocly/cli lint docs/api/web.openapi.yaml` zero errors;
`npx @asyncapi/cli validate docs/api/async/outbound-webhooks.asyncapi.yaml` zero
errors; `pnpm validate:contracts` green.

- [x] **T0.1 — OpenAPI.** `docs/api/web.openapi.yaml`: five new paths under
      `/api/runs/{runId}/` — `git-state` (GET, `GitStateResponse` in
      `components/schemas`, D3 field list, 200/401/403/404), `discard-changes`
      (POST `{}`, 200 `{rescueRef, sha, restoreCommand}`, 409 `clean_worktree`),
      `pr` (POST `OpenPrBody`, 200 `OpenPrResponse`, 409 reasons, 422, 503),
      `pr/finalize` (POST `{}`, 200 `PromoteRunResponse`, 409 `pr_closed|pr_missing`),
      `reattach` (POST `{}`, 200 `{worktreePath, source}`, 409
      `no_reattach_source|worktree_path_occupied`); extend `export-branch` body
      (`:9227-9246`, `+ branchName`) and response (`+ publishedBranch,
      publishedRemote, publishedRef, nameSource`); extend `sync` body (`:6556-6576`,
      `+ onto`) and `SyncRunResponse` (`:19560`, `+ conflictedFiles`). Summaries
      `(ADR-181 — Designed) …`; every 4xx/5xx `$ref MaisterErrorBody`; example
      payloads for each 200.
      **AC**: redocly zero errors; every `details.reason` token in D-table appears
      in exactly one response description under `details` (the top-level `reason`
      enum is untouched — D24); body-shape errors are 400 on the five new routes;
      no path outside `/api/runs/{runId}/`.
- [x] **T0.2 — ERD + DB narrative + AsyncAPI.** `docs/db/runs-domain.md:222-254`
      WORKSPACES gains `text published_branch "ADR-181 (0173)"`, `text
      published_remote`, `timestamp published_at`; `:253` op-name comment lists the
      four new names; PROJECTS stub `:94-97` + `docs/db/projects-domain.md:25`
      gain `text public_branch_template "default 'feature/{task_key}-{slug}' (ADR-181,
      0173)"`; `docs/database-schema.md:2183-2239` and `:265-295` add the columns
      with `(Designed — migration 0173)`; the journal/snapshot triple rule at
      `:2078-2085` is cited, not restated. `docs/api/async/outbound-webhooks.asyncapi.yaml`
      `run.promoted` payload gains optional `source` (`enum: [pr_finalize]`),
      description at `:630` updated.
      **AC**: Mermaid parses; `db:erd --check` still green (no schema change yet);
      asyncapi validate zero errors; the migration number `0173` is written once, in
      the ERD comments and this plan only (no `pre-0173` prose).
- [x] **T0.3 — Error taxonomy.** `docs/error-taxonomy.md:45,50,51,52` cells gain
      `Also (Implemented, ADR-181): …` clauses naming the `details.reason` tokens of
      D-table and the HTTP mapping (409 / 400 / 503) per route family.
      **AC**: no new row; the four codes' "Where thrown" cells name the new
      modules (`workbench-git/{service,read-model,public-branch-name}.ts`).
- [x] **T0.4 — Configuration.** `docs/configuration.md`: example line near `:237`
      (`public_branch_template: feature/{task_key}-{slug}`), optional-field row at
      `:318-329` (placeholders, transliteration, ≤40, fallback, `CONFIG` on invalid),
      `:1146` `MAISTER_GC_ARCHIVE_PUSH` "Used by" widened to "GC preserve **and**
      operator archive/drop (ADR-181)". No `.env.example` / compose change —
      recorded as a decision (host-run, ADR-023; no new knob).
      **AC**: row padding matches neighbours; the pre-existing `repo_path` /
      `default_branch` drift (`:322-323`) is NOT touched here (T0.8).
- [x] **T0.5 — Screens.** New `docs/screens/runs/git-panel.md` (README template
      `screens/README.md:57-81`: header · JTBD · roles · navigation incl. the
      `?git=<section>` deep link · layout/regions per D16 · `stateDiagram-v2` of
      the panel states (loading, usable, busy, worktree-missing, published,
      pr-open, pr-closed) · Data & APIs (all seven routes) · i18n `workbenchGit` ·
      linked artifacts); README row at `:202-206`; `flow-run.md:260` and
      `scratch-run.md` gain the panel and the Backlog/portfolio `Failed` row;
      `run-inspector.md` Actions tab = href-only; `workbench.md:196` rewritten as
      "Lifecycle operations (Implemented)" naming the panel (C12); the board card
      menu in the project board screen doc.
      **AC**: `validate-docs-indexes` green (README row present); every screen doc
      links `workbench-git.md` for behaviour (R7) and restates none of it.
- [x] **T0.6 — RU manual.** `docs/ru/manual/07-review.md` gains the panel walk-through
      (commit → publish under a public name → open PR → finalize; update from base /
      target / your own pushes; discard with the rescue ref) after `:18`;
      `05-tasks-runs.md:39` (run page) and `:62` (statuses: a `Failed` run stays
      listed with its git actions).
      **AC**: Russian operator prose only (R8), UI strings match the `ru.json` keys
      T1.11 will add (listed in the doc as a checklist for T4.3).
      **RU string checklist (T1.11 ships exactly these; T4.3 verifies):**
      `workbenchLifecycle.action.exportBranch` = «Опубликовать» (was «Экспорт»),
      `.snapshotCommit` = «Коммит» (unchanged), `.discardChanges` = «Отменить
      изменения», `.update` = «Обновить», `.openPr` = «Открыть PR», `.finalizePr` =
      «Завершить по PR», `.reattach` = «Вернуть рабочую копию»; `workbenchGit.title` =
      «Git-панель», `workbenchGit.section.tree` = «Рабочее дерево»,
      `workbenchGit.section.update` = «Обновление». The manual promises a
      confirmation before a finalize outside `Review` (the shared destructive
      confirmation, T3.5).
- [x] **T0.7 — ADR-181 amendments + `workbench-git.md` refinements.** Dated
      `**Amendments:**` list on `docs/decisions/adr-181.md` (non-direction): action and op
      name `discardChanges` (C1); the execution-assignment arm is implied by the
      parked status and is not an admission condition (C14); `{task_key}` composed from `projects.task_key` +
      `tasks.number`, `{attempt}` from the branch suffix (C2); identity edge case
      is the preserve path (C9); reattach/reopen row-write split (C7).
      `workbench-git.md`: Domain entities + Route contracts say `discardChanges`;
      Edge cases: git-identity bullet re-worded, `worktree_path_occupied`,
      `public_name_fixed`, `publish_stale`, `agent_requires_review` added (Edge
      cases are uncapped); Expectations **edited in place, still 12**, each bullet
      naming its enforcer (policy test, claim CAS, CHECK, route test); the read-model
      field list matches `GitStateResponse`; the network best-effort rule (D3) stated.
      **AC**: bullet count 12; every `MaisterError("…")` in Edge cases appears in
      T0.3; `pnpm validate:docs` green.
- [x] **T0.8 — R9 TODOs.** `docs/decisions.md` TODO section: (a) `configuration.md:322-323`
      documents `project.repo_path`/`project.default_branch` which
      `projectBlockSchema` rejects (C11); (b) `docs/db/runs-domain.md` WORKSPACES
      block is already missing `archived_commit`, `preservation_outcome`,
      `removal_kind`, `lifecycle_operation_lease_expires_at`,
      `lifecycle_operation_expected_run_status` (found while adding the ADR-181
      columns; left alone). Each names file, date, and "left alone because R9".
      **AC**: two entries; no unrelated section edited. **As built:** five —
      (a), (b) plus `promotion.remote` documented Implemented but unread, the Redocly
      baseline (eight `nullable-type-sibling`, not two), and `DataRunPromoted`
      forbidding fields the emitter sends.

**Commit 1** — `docs(workbench-git): freeze the ADR-181 contracts (OpenAPI, ERD, taxonomy, screens, RU)`

### Phase 1 — Panel, git-state, commit / discard / publish, visibility, carve-out

**Exit criteria**: RED 1–13 green; full web suite green; the panel replaces the
Export dialog on flow, agent and scratch run detail; `git-state` served only by its
route; `Failed` listed on portfolio / project list / rail / Backlog card; the
`HumanWorking` owner sees the git set on the run detail; refactor gate passed.

- [x] **T1.0 — RED battery (Phase 1).** Write RED 1–13 (§Test plan) and confirm each
      fails on this tree for its stated reason. Runnability: unit files under
      `lib/**/__tests__/*.test.ts` and `components/**/__tests__/*.dom.test.ts`
      (`.tsx` is NOT collected — `review-panel.test.ts:24-30`); integration files
      `*.integration.test.ts` (`vitest.workspace.ts:84-88`); confirm each new path is
      matched (`vitest list --project <p>`). New shared fixture
      `web/test-support/git-remote-fixture.ts` (`initRepoWithBareRemote`,
      `addRunWorktree`, `advanceRemoteBranch`) lifted from
      `real-git.integration.test.ts:78-103` / `sync-target.integration.test.ts:142-200`
      (the first three suites keep their local copies until T1.R folds them).
      **AC**: 13 controls, each red with a distinct failure; none uses `expect.poll`
      (`web/CLAUDE.md:250-256`); route suites load their module in `beforeAll`.

**Commit 2** — `test(workbench-git): RED — parked runs have no git path`

- [x] **T1.1 — Migration `0173` + schema.** `schema.ts`: `workspaces` `+
      publishedBranch/publishedRemote/publishedAt` (after `:4665`) + the co-nullity
      CHECK; `projects` `+ publicBranchTemplate` (after `:191`); the two op-name
      unions (D15). `pnpm --filter maister-web db:generate` → `0173_<name>.sql` +
      journal entry (`when > 1790016407278`) + `0173_snapshot.json`; rationale
      header in the `0171/0172` style; `pnpm --filter maister-web db:erd` regenerates
      `docs/db/erd.dbml`.
      **AC**: RED 5 (journal integrity + co-nullity CHECK refuses a half-null row,
      real Postgres) green; a second `db:generate` reports "No schema changes";
      `db:erd --check` green; `migration-journal-integrity` suite green.
- [x] **T1.2 — `maister.yaml` field + registration + write-back.**
      `config.schema.ts:190-196` `public_branch_template` (D5 validation, `CONFIG`
      with `public_branch_template_invalid`); `app/api/projects/route.ts:402-418`
      maps it (absent → column default); `yaml-writeback.ts:118-168`
      `SerializeProjectInput.publicBranchTemplate` emitted unless default;
      `persist-config.ts:163-172` passes it; `settings-panel.tsx:121-130` read-only
      row + `board.publicBranchTemplate(Desc)` keys (EN/RU).
      **AC**: RED 5 round-trip (SET / CLEAR / re-SET, and column → YAML omit/emit)
      green; an invalid template refuses registration with `CONFIG` before any row
      is written.
- [x] **T1.3 — Git primitives (`web/lib/worktree.ts`).** `pushBranch` per D4
      (`remoteBranch`, `leaseSha`, `setUpstream`, refspec after `--end-of-options`);
      `forceWithLeasePush` and `sync-target.ts:283` `pushWithLease` become wrappers
      taking `remote`/`remoteBranch`; `branchUpstream(repo, branch)`;
      `remoteTrackingBranchHead` / `remoteBranchExists` `+ remoteBranch?`;
      `writeRescueRef` (temp `GIT_INDEX_FILE`, `write-tree`, `commit-tree` with
      `commitIdentityArgs`, `update-ref`), `listRescueRefs`, `nextRescueIndex`;
      `worktreePresence(paths)`; every new call goes through `runGit` (local) or
      `NETWORK_GIT_ENV` (network) with `--end-of-options`, URLs through `redactUrl`.
      **AC**: RED 7 (refspec + upstream config + lease + non-FF + stale lease +
      no-op re-push), RED 9 (rescue ref content incl. untracked, real index
      untouched) green at the primitive level; `worktree-sync.test.ts` and
      `real-git.integration.test.ts:336` (force-with-lease retry) green with the
      wrappers.
- [x] **T1.4 — Policy module.** `web/lib/workbench-git/policy.ts` per D1 (exhaustive
      `STATUS_CLASS`, exported `WORKTREE_ACTION_STATUSES`, `canReclaimLifecycle`
      exported from the service and reused, the widened `WorkbenchLifecycleActionId`
      + `ACTION_ORDER`); `deriveWorkbenchLifecycleActions` re-based on it; op-name
      unions (D15). Pure — depends on nothing in T1.3.
      **AC**: RED 1 green (status × viewer × workspace-state × busy matrix; unknown
      status admits nothing; a `Crashed` run with an `active` execution-assignment
      row is admitted (C14); a live shared sibling → `busy`; `HumanWorking` owner
      gets `snapshotCommit, discardChanges, exportBranch, update, openPr, finalizePr,
      reattach` and never `archive|drop|stop`);
      `policy.test.ts` matrix unchanged and green; the carve-out file migrated
      (§Assertion migration).
- [x] **T1.5 — The carve-out opens.** `service.ts:179` type → `Promise<{id}>`,
      `:1980-1984` returns the user, six `?? null` sites simplified;
      `openReworkClaimOwnerUserId` extracted to `lib/runs/rework-claim.ts` and used by
      `loadContext` (`:2117-2121`), `getRunDetail` (`run.ts:808`), `layout.tsx:1226`;
      `lifecycleActionsForWorkspace` (`portfolio.ts:263`) takes explicit
      viewer/owner; `hasWorkspace = workspaceId != null` on both detail sites;
      `getRunDetail` returns facts and the layout derives the viewer-dependent
      actions with `lifecycleActionsForViewer` (D2 — `cache()` keyed on `runId`).
      **AC**: RED 2 green (real DB: a `HumanWorking` run with an open rework claim
      → the owner's run detail lists the git set, another member's lists
      `human-owned`, the board/rail/portfolio list none); the falsification "revert
      `:1980-1984`" turns RED 2 red again.
- [x] **T1.5b — Fact loader.** `web/lib/workbench-git/facts.ts`
      `loadWorkbenchGitFacts` per D1a (claim owner, live shared sibling, informational
      active assignment, presence, lazy reattach sources, slot + PR fields), wired
      into `loadContext`/`requireActionAllowed` (`service.ts:395-440`, `:2040+`).
      After T1.3 (presence/sources) and T1.5 (predicate). T1.7, T1.8, T1.9, T2.1 and
      T3.3 consume it.
      **AC**: RED 1's integration twin (real DB: the loader's facts for a `Crashed`
      run with an active assignment, a shared root with a live child, a removed row
      with a published source) feed the predicate to the expected sets; no second
      fact derivation exists (grep control: `countUnsettledSharedSiblings` and
      `openReworkClaimOwnerUserId` are called from the loader only, outside their
      original modules).
- [x] **T1.6 — Public branch name.** `web/lib/workbench-git/public-branch-name.ts`
      per D5 (`renderPublicBranchName`, `transliterate`, `validatePublicBranchTemplate`);
      the `{task_key}` loader JOINs `projects` (C2).
      **AC**: RED 6 green (Cyrillic → Latin table incl. `щ→shch`, `ё→yo`; 40-char
      cap; empty slug collapses separators; `run-<8hex>`; `{attempt}` from the
      branch suffix; unknown placeholder / invalid result → `CONFIG`).
- [x] **T1.7 — Publish + the `published_*` readers.** `exportWorkbenchBranch`
      (`service.ts:1485-1590`) per D4 (name core, lease before push, refspec +
      upstream, `published_*` after, result fields); `export-branch/route.ts:16-29`
      body `+ branchName`; `isBranchPublished` (`branch-published.ts`) `+
      publishedBranch`, no `.catch`; `rework-claim-ingest.ts:70-93` tracking ref
      from `published_*`; `sync-target.ts:724-741` and `:1094-1108` lease/push on the
      public name; `promotePullRequestSideEffect` (`promote.ts:1378-1386`) pushes
      through the name core (public name, upstream, `published_*`) — its PR head
      becomes the public name in the same change so the branch stays coherent;
      `recordPublished` is the ONE writer of `published_*` (publish, sync's push,
      promotion's push — D4).
      **AC**: RED 7 (service level: three name sources; `public_name_fixed`;
      `published_*` written after the push; crash-window retry idempotent) and
      RED 8 (`isBranchPublished` order; ingest fast-forwards from
      `<published_remote>/<published_branch>`) green; `promote-pr.test.ts` migrated
      (push args now carry the public name and `setUpstream`); `rework-claim.integration.test.ts:725`
      still green for an unpublished branch.
- [x] **T1.8 — Discard-changes.** `web/lib/workbench-git/service.ts`
      `discardWorkbenchChanges` per D8; route `app/api/runs/[runId]/discard-changes/route.ts`
      (family A, `errorResponse` from `workbench-lifecycle/route-utils.ts`, whose
      `errorPayload` now forwards `details` — D24; `routes.test.ts` gains the
      passthrough case and the `sync` route's `errorResponse` gets the same line).
      **AC**: RED 9 green (rescue ref holds tracked + untracked changes; tree clean
      after; clean tree → 409 `clean_worktree`; the ref survives `dropWorkbench`;
      viewer 403 / member 200).
- [x] **T1.9 — `git-state`.** `web/lib/workbench-git/read-model.ts` `loadGitState`
      per D3 (scratch base/target from `scratch_runs`; field-wise degradation with
      `warnings`; `ls-remote` best-effort); route `git-state/route.ts` (GET, family A
      with `recoverRun` in the deps). `getRunDetail` and the layout are asserted NOT
      to import it.
      **AC**: RED 10 green (usable / removed / `worktree-gone` with `removed_at IS
      NULL` → `worktreePresent:false` and only `reattach` enabled; unreachable remote
      → `remoteReachable:false` + 200; member 200 / viewer 403; a grep control that
      `read-model.ts` is imported only by the route and the component tests).
- [x] **T1.10 — `Failed` visibility.** `portfolio.ts:77-90` `+ "Failed"`; pin it
      with a unit assertion; `queries/board.ts` `BacklogCard.latestRun` (+ `worktreePath` added to the
      run-row select at `:549-551`) + the `worktreePresence` helper
      (`web/lib/workbench-git/presence.ts`, D14); `TaskCard` renders the menu; attention stream
      accepted (D14 row); decision sources untouched.
      **AC**: RED 3 (portfolio / project list / rail list a `Failed` run; no TTL
      chip; `decisions.count` unchanged; `listCrashedForProjects` excludes it) and
      RED 4 (Backlog card DTO carries `lifecycleActions` only when the latest run's
      worktree is usable) green; `portfolio.integration.test.ts` counts migrated.
- [x] **T1.11 — Panel (Phase-1 sections) + hosting + menus + inspector + i18n.**
      `git-panel.tsx` (header, Tree, Publish, Commands; Update/PR/Reattach sections
      render disabled placeholders until Phases 2–3), the `git-state` fetch pattern
      (`node-transcript-panel.tsx:70-115`), `lifecycle-actions.tsx` hosts it and
      drops the Export dialog + `loadMetadata`; `railMenuItems` deep links;
      `layout.tsx:1240-1245` `href`; `run-inspector.tsx:203-222` href-only;
      `?git=<section>` URL state; labels in `workbenchLifecycle.action.*`, panel copy
      in `workbenchGit.*`, EN + RU + key suite; dialogs keep typed input across a
      refresh (D16).
      **AC**: RED 12 green (jsdom: busy → all disabled with reason; dirty → Commit +
      Discard enabled; unpublished → name field pre-filled from the template;
      published → chip + hidden name field; `non_fast_forward` → force checkbox
      appears; worktree-missing → only Reattach; inspector renders zero `<span>`
      actions; rail menu emits deep links; a typed PR title survives a `git-state`
      refresh tick); `i18n-parity` green; `lifecycle-actions.dom.test.ts`
      migrated (export dialog cases → panel cases).
- [x] **T1.12 — Unpushed-work guard + archive knob.** Archive/Drop dialogs fetch
      `git-state`, render counts and the two primaries (D17);
      `archiveWorkbenchForCtx` / `removeWorkbenchForCtx` pass
      `archivePush: gcArchivePush()`.
      **AC**: RED 13 green (`preserveWorktree` receives `archivePush:true` when the
      env is `"true"`, `false` otherwise; the dialog shows `unpushedCommits` and runs
      publish before archive on the first primary).
- [x] **T1.R — REFACTOR gate (Phase 1).** Suite green; re-read the diff against D22:
      fold the three hand-rolled bare-remote fixtures onto
      `git-remote-fixture.ts`; remove orphans this change created (the Export
      dialog's helpers, `loadMetadata`, the `| void`); no behaviour change, zero test
      edits across the refactor.
      **AC**: `pnpm --filter maister-web test` green before and after; `pnpm lint`
      0 errors on changed files (`git status` checked before staging — it is
      `eslint --fix`); `pnpm typecheck` clean.
      **Verified 2026-09-23** on the Commit-3 tree: unit 825 files / 8583 tests
      green; integration 487/508 on the first pass — the Mac slept 08:35–09:17
      mid-lane (`pmset` "Maintenance Sleep", on battery) and two other sessions
      ran full lanes (load 45–100). Every one of the 21 failures passed on
      re-run under `caffeinate`: 16 in one batch, `deliverer`,
      `run-transcript-projector`, `projection-worker`, `permission-deadline`
      solo, and `lib/agents/__tests__/prompt-owners` by failing group (3 + 8 +
      18 tests; its failing names changed on every run). tsc, lint (74 changed
      files, 0 problems), `validate:docs`, `validate:contracts` green. C37 keeps
      the three fixtures; orphans removed (the `| void`, three exports nothing
      else imports); C44 fixed with a falsified control.

**Commit 3** — `feat(workbench-git): git panel, git-state, publish under a public name, discard, Failed visibility, carve-out`

### Phase 2 — Update + reattach

**Exit criteria**: RED 14–17 green; full web suite green; the ReviewPanel sync
dialog is gone; a `Failed` run updates onto base / target / published and re-attaches
after drop; refactor gate passed.

- [x] **T2.0 — RED battery (Phase 2).** RED 14–17, red on the Phase-1 tree.
      **AC**: as T1.0.

**Commit 4** — `test(workbench-git): RED — update is Review-only, removed worktrees are dead ends`

- [x] **T2.1 — `sync` gains `onto`, admission, restore.** `sync/route.ts:22-28`
      `+ onto`; `sync-target.ts`: `assertSyncEligible:175` → D1 predicate;
      `agent` default and `agent_requires_review`; ref resolution per `onto`
      (`:710-713` becomes a `resolveSyncRef(onto)`), `target_ref`/`target_sha`;
      conflict path `+ restoreWorktreeToCommit(headShaBefore)` and
      `conflictedFiles` in the outcome; the resolver branch untouched; the route's
      `errorResponse` forwards `details` (D24); `recordPublished` after a public-name
      push (D4).
      **AC**: RED 14 (three `onto` values on real git; `base_branch_unknown`;
      `not_published`; `target_ref` records `<remote>/<public>`; `agent:true`
      outside `Review` → 409; the other five eligibility arms still refuse; the
      `Review` default still launches the resolver — existing
      `sync-target.integration.test.ts` cases green), RED 15 (conflict →
      `HEAD === headShaBefore`, tree clean, `outcome:"conflict"` with paths; a
      `Failed` run may update), RED 16 (push after update leases and pushes the
      public name and records `published_*`) green; `sync-target.integration.test.ts:33-41` spy sites updated.
- [x] **T2.2 — Reattach + revival helper + reconciler arm.**
      `lib/runs/revive-worktree.ts` per D10; `reattachWorkbench` + route
      `reattach/route.ts` (family A, `recoverRun`); `reopen.ts:158-188` re-based on
      the helper (own writes kept); provenance v2 rebuilt from DB;
      `workspace-reconciler.ts` `workspace_reattached` arm.
      **AC**: RED 17 green (local → published (upstream re-set) → archive sources;
      provenance file present and parseable; `removed_at`/`scheduled_removal_at`
      null only after `worktree add`; `archived_*` kept; no source → 409; occupied
      path → 409 and the directory untouched; reopen still clears `archived_*`;
      the reconciler restores a re-attached-but-unrecorded row); `reopen.integration.test.ts`
      green unchanged.
- [x] **T2.3 — Panel Update + Reattach sections; ReviewPanel sync dialog removed.**
      `review-panel.tsx:403-530` deleted, `review-sync-open` → panel deep link;
      `git-panel.tsx` Update (`onto` with per-option ahead/behind, strategy, push,
      resolver toggle only in `Review`) and Reattach.
      **AC**: RED 12 extension green (Update section states; resolver toggle absent
      outside `Review`; Reattach lists sources); `review-panel.test.ts:293-324`
      migrated (obsolete → deleted, chip cases kept); `run-sync.spec.ts` testids
      re-pointed at the panel (`review-sync-*` → `git-panel-update-*`).
- [x] **T2.R — REFACTOR gate (Phase 2).** As T1.R; verify `resolveSyncRef` is the
      only place that maps `onto` to a ref.
      **Verified 2026-09-23.** `resolveSyncRef` is the one mapping: `syncRunTarget`
      and the git-state read model call it; the route and the panel carry only
      the enum. The orphans this phase made are gone (`syncPushTarget` →
      `publishedTarget`; the review panel's dialog, its state and ten `run.sync*`
      keys; `isBranchPublished` in `sync-panel-data`). Lanes: unit 825 files /
      8586 tests green. The full integration lane ran at load 100–384 and ended
      9 files / 64 tests red, every one timeout-shaped, and every one green idle:
      `deliverer` 4, `run-transcript-projector` 10, `launch-paths` 4,
      `projection-worker` 12, `permission-resume` 9, `permission-result-failure`
      23 (one batch); `permission-deadline` 10/10 alone twice (its RED 14 missed
      again inside that batch — load-sensitive; the branch touches none of that
      path); `prompt-owners` agents 50/50 and flows 58/58 alone.

**Commit 5** — `feat(workbench-git): update onto base|target|published; re-attach a removed worktree`

### Phase 3 — PR before promotion + scratch modes

**Exit criteria**: RED 18–23 green; full web suite green; `promoteRun(pull_request)`
and the panel's publish → open PR → finalize converge on identical rows; scratch
honours its three modes; refactor gate passed.

- [x] **T3.0 — RED battery (Phase 3).** RED 18–23, red on the Phase-2 tree.
      **AC**: as T1.0; the provider boundary is mocked at `node:child_process` /
      `fetch` (RED 18) and at the service seam (RED 19–22).
      **Confirmed 2026-09-23** against the Phase-2 `promote.ts` / `pr-adapter.ts`:
      unit 9 red for the stated reasons (4 adapter, 3 scratch promotion incl. the
      scratch claim's workbench fence, the promotion's `draft: false`, the
      scratch PR), the two
      foreign-target controls green by design; RED 19 (13) and RED 20 (16) red at
      the absent routes; RED 23 green (a guard). The `seedCandidate` gains a
      `status`, `seedWorkbenchRun` a `sharedTreeAllocator`.

**Commit 6** — `test(workbench-git): RED — a PR is a promotion`

- [x] **T3.1 — `PrAdapter.draft`.** `pr-adapter.ts:31-38` `+ draft?: boolean`;
      gh `:201-220` and glab `:262-279` add `--draft`; gitea/gitverse `:459-464`
      map `draft` to a `WIP: ` title prefix; `PrResult` unchanged.
      **AC**: RED 18 green (argv contains `--draft` exactly when requested; Gitea
      body title prefixed; `findOpenPr` still matches by head/base; no token in any
      thrown message); `pr-adapter.test.ts` contract header updated.
- [x] **T3.2 — Open-PR core + `/pr` route + promotion re-base.**
      `workbench-git/service.ts` `openPullRequest` per D11 (`resolvePromotionTarget`
      extracted from `promoteWorkspaceRun`; provider resolution extracted from
      `promote.ts:1362-1374`); route `pr/route.ts` (inline authz; errors through
      route-utils — 400 on shape, `details` forwarded);
      `promotePullRequestSideEffect` re-based on the core.
      **AC**: RED 19 green (opens from the public name to the resolved target;
      writes `pr_url/pr_number/pr_state='open'/target_branch`; `runs.status`
      unchanged; reuse by head/base; `dirty_worktree`, `not_published`,
      `publish_stale`, out-of-policy target, `generic` provider → 409; provider 5xx
      → 503 with the claim `claiming`; viewer 403 / member 200);
      `promote-pr.test.ts` migrated (createOrUpdatePr args: public head, `draft`).
- [x] **T3.3 — Finalize extracted + `/pr/finalize`.** `finalizePullRequest`
      (`promote.ts:1421-1674`) exported with the D12 signature (`attribution`,
      `run_kind` arm for scratch); `finalizePullRequestRun` (claim for
      `Crashed|Failed|Abandoned` via `canReclaim` in the `FlowClaim` shape, with the
      `sync`, `promotion_hold` and unsettled-sibling fences — D12; `Review` →
      `promoteRun`); route `pr/finalize/route.ts` (inline authz, route-utils errors); `attribution` union
      `+ {source:"pr_finalize"}`; `run.promoted` webhook `data.source`.
      **AC**: RED 20 green (from `Failed`: `runs` Done + `promoted_head_sha` =
      published head + `merge_commit_sha` null; `workspaces` `promotion_state='done'`,
      `promoted_at`, `scheduled_removal_at`, `promotion_lane` null; webhook pair
      `["run.promoted","run.done"]` with `data.source:"pr_finalize"`; domain
      `run.done` with `parentRunId`; from `Review` the readiness refusal is observed
      through `promoteRun`; `pr_closed` / `pr_missing` / `promotion_hold` → 409;
      unsettled shared siblings → 409 `CONFLICT`; one step further: `pr_state_scan`
      then marks the PR `merged` and `repo_delivery_scan` closes the loop
      (`merge_commit_sha` set); `publish_stale` when
      the worktree is usable and behind; two concurrent finalizes → one `CONFLICT`;
      shared-tree `Review` siblings flipped by the extracted path);
      `promote-service.test.ts:632-639` pair ordering still green.
- [x] **T3.4 — Scratch modes.** `promoteScratchRun` per D13 (`:1751-1757` removed;
      `rebase_merge` and `pull_request` arms with the scratch target).
      **AC**: RED 22 green (both modes admitted; `local_merge` byte-identical;
      target = `scratch_runs.target_branch ?? base_branch`; an explicit foreign
      target still refused); `promote-service.test.ts` scratch refusal case
      classified obsolete and replaced.
- [x] **T3.5 — Panel PR section + scratch.** Open-PR dialog (title/body/draft/target
      pre-filled from `task_key`, title, run link), Finalize, chip states
      (`open` / `merged` / `closed` / `not tracked` for scratch); the scratch
      `<select>` (`scratch-inspector-actions.tsx:96-98`) unchanged and now honoured.
      **AC**: RED 12 extension green (PR section states; Finalize disabled with
      `pr-closed` tooltip; Open PR hidden until published); RED 23 (integration:
      `pr_state_scan` picks a `Failed`-run PR, `:373`-style eligibility case) green
      with **no** scan code change.
- [x] **T3.R — REFACTOR gate (Phase 3).** As T1.R; verify the promotion `pull_request`
      path contains no second push or PR-lookup implementation (one core each).
      **Verified 2026-09-23.** One core each: the push is `pushBranch` (D4);
      find-or-create is the adapter's `createOrUpdatePr`, called by Open PR and
      the promotion side effect only; the provider resolution is
      `preflightedPrAdapter` alone (the package publish in `local-packages`
      resolves the PACKAGE source's provider — a different question); the
      finalize is `finalizePullRequest`, reached from the promotion side effect
      and the parked finalize; the fence is `assertNoLiveWorkbenchClaim` for the
      workspace claim, the scratch claim and the parked claim; the target rule is
      `resolvePromotionTarget`, the scratch lock `scratchPromotionTarget`, the
      PR defaults `pullRequestDefaults` (git-state's `prDefaults` reads it).
      Orphans removed: promote.ts's `selectPrAdapter` / `detectProvider` /
      `readRemoteOrigin` imports, the read model's `runPath` / `prName`; the D10
      inventory moved the `readRemoteOrigin` entry to `pull-request.ts`. The
      `KEY-N` template stays inline — the house idiom at 20+ sites. Falsified
      and restored: 12 (`draft` ignored → 3 RED 18 cases), 13 (no claim CAS, no
      attempt fence → both concurrent finalizes fulfilled, window proven open),
      14 (the scratch refusal back → 3 RED 22 cases), the C56 fence dropped →
      its case. Suites: RED 18–23 green; 21 promotion-adjacent integration files
      253/253 at load 85–150.

**Commit 7** — `feat(workbench-git): open a PR before promotion, finalize from any parked status, scratch promote modes`

### Phase 4 — e2e smoke, manual live check, as-built truth pass, lane re-qualification

- [x] **T4.1 — e2e smoke.** Seed `seedWorkbenchGitFixture` in `e2e/_seed/seed-e2e.ts`:
      a project with a bare remote (the `provisionM27Repo:5166-5191` shape), a
      task, a run inserted `Failed` with a real worktree carrying an uncommitted
      change, `provider: "github"` and a `repo_url` that is never contacted. The
      provider boundary is a **fake `gh` executable** (`e2e/_seed/bin/gh`, a node
      script: `--version` → ok; `pr list --head … --base … --json …` → the in-memory
      list; `pr create …` → prints a URL and records `{head, base, title, draft}` in a
      state file under the fixture dir so the spec can read it), prepended to `PATH`
      with `GH_TOKEN` set in the webServer env (`playwright.config.ts:101-120`). C16
      is why it is not a Gitea stub.
      Spec `e2e/workbench-git.spec.ts` (added to `AUTHED_SPEC`, `:47-48`): the
      `Failed` run is visible on `/projects` and the board's Backlog card menu →
      run detail → Commit (dialog, `waitForResponse` on `/snapshot-commit`) →
      Publish (name pre-filled `feature/<KEY>-<n>-<slug>`, `waitForResponse` on
      `/export-branch`, then `git -C <remote> rev-parse refs/heads/<public>` equals
      the worktree HEAD) → Open PR (`/pr` 200, chip `open`, the fake recorded one
      create with `head = <public>` and the chosen `draft`) → Finalize
      (`/pr/finalize` 200) → status `Done` on the run header and the board.
      `--workers=2`.
      **AC**: passes twice on a quiet host; no `networkidle`; every assertion waits
      on the specific response; the fake `gh` recorded exactly one create.
      **Verified 2026-09-23.** `e2e/workbench-git.spec.ts` passed 3/3 at
      `--workers=2` (12.4 s, 28.5 s, and 13.8 s inside the full lane on the final
      code tree). No host was quiet today (load 30-72 — another worktree's vitest
      lane and a VM at ~600 % CPU), so "quiet" is not claimed. The run is reached
      through the portfolio's run link, the Backlog card's latest-run actions
      (`task-card-latest-run-actions`) and the detail's panel host
      (`workbench-git-open`); Commit, Publish, Open PR and Finalize each await
      their own response; the bare remote's `refs/heads/<public>` equals the
      worktree HEAD; the fake recorded exactly one create `{head: <public>, base:
      main, title: "EWG-1: Fix the widget", draft: true}` and none on finalize,
      which confirms first outside `Review` (C64); the board then shows the Done
      run in In Delivery. Also here: `e2e/m27-workbench-lifecycle.spec.ts`
      migrated — the Phase 1 migration row that never landed (contract moved: the
      card surfaces show Archive/Drop plus the `card-git-*` deep links, the detail
      hosts the panel, commit and the handoff branch go through it), with the
      run-detail specs' 120 s budget; and C66, found by this smoke's `[WebServer]`
      log.
- [ ] **T4.2 — Manual live check (owner-executed, recorded).** Against a real
      remote: `gh pr create --draft` (github), `glab mr create --draft` (gitlab), and
      the Gitea family `WIP:` prefix on the owner's Gitea/GitVerse instance —
      draft flag honoured, dedup finds the PR on a second Open PR, finalize marks
      `Done`, `pr_state_scan` sees `open` → `merged` after a merge. Results (provider,
      version, outcome) recorded in the commit body of Commit 8 and in
      `workbench-git.md` Linked artifacts as the ADR-049-style manual evidence line.
      **AC**: three providers listed with a version and an outcome; any gap becomes
      an Edge-case bullet, not a silent pass.
      **Not executed (2026-09-23) — owner-executed, left open.** No real remote or
      provider credential is used from this session. The gap is recorded, not
      passed: `workbench-git.md` Linked artifacts carries the pending evidence line
      with the exact checks, and its Edge cases state that draft handling is
      proven at the adapter boundary and against the fake `gh` only (a
      Gitea-family server ignoring the `WIP:` convention opens a ready PR).
      Commit 8's body says the same. **Owner (2026-09-23): after rollout.**
- [x] **T4.3 — As-built docs truth pass + status flips.** Re-derive the contract
      surface list from `git diff master...HEAD` and reconcile with the Phase-0
      table (every difference explained in the commit body);
      `workbench-git.md` → **Implemented** (every Expectation re-verified against
      code and naming its enforcer; Route contracts = the served routes;
      `(Designed)` tags removed); `workbench-lifecycle.md`, `branch-sync.md`,
      `git-integration.md`, `scratch-runs.md`, `workspaces.md` as-built deltas;
      OpenAPI summaries `(ADR-181 — Implemented)`; ERD comments;
      `docs/error-taxonomy.md`, `docs/configuration.md`, screens, RU checked against
      the shipped `ru.json` keys; ADR-181 `**Status:** Implemented` in the record,
      the stub (`decisions.md:1840`) and the index row (`:225`); root `CLAUDE.md`
      §7 `:382-384` (+ `discard-changes | git-state | pr | pr/finalize | reattach`,
      public branch names) and §8 `:437-440` (C8). Gates: `pnpm validate:docs`,
      `pnpm validate:contracts`, redocly, asyncapi.
      **AC**: no `(Designed)` tag remains for ADR-181 surfaces; the three-way ADR
      bijection passes; no `M-NN` token in any new sentence (R6).
      **Verified 2026-09-23.** `workbench-git.md` → Implemented (Expectations
      edited in place, each naming its enforcer; edge cases for C55/C58/C60 and
      the live-check gap); `workbench-lifecycle.md`, `branch-sync.md` (its 12
      Expectations edited in place), `git-integration.md` (+ the topical ADR-181
      section), `scratch-runs.md`, `workspaces.md`; OpenAPI tags and summaries,
      C31/C43/C58/C60, the promote route's reason tokens and scratch modes,
      `publishedTrackingHead` (C65); the ERD comments, schema doc, error taxonomy,
      configuration, AsyncAPI, the screens as built (RU labels against
      `ru.json`); ADR-181 Implemented in the record, the stub and the index, with
      as-built amendments; root `CLAUDE.md` §7 and §8 (C8). The surface
      reconciliation's four differences (the promote route's forwarded reasons,
      C36, C63, C65) are in Commit 8's body. Gates: `pnpm validate:docs` green
      (58/58 mermaid, 363 ADR anchors + 180 stub↔body pairs in sync, 847 links,
      142 indexed files, ERD current at 125 tables), `pnpm validate:contracts`
      green (OpenAPI + AsyncAPI meta-schemas, adapter mirrors), Redocly the SAME
      8-error / 41-warning set as `master` (all pre-existing, none in an ADR-181
      schema). No `(Designed)` tag remains beside an ADR-181 mention and no
      `M-NN` token is in any added doc line (grep of the branch diff).
- [x] **T4.4 — Lanes green, by name.** Quiet host, ports 3100/7788 freed:
      `pnpm --filter maister-web test:unit`, `test:integration` (~25 min; the two
      `prompt-owners` files dominate), `pnpm --filter @maister/supervisor test`
      (untouched — must still be green), `pnpm --filter maister-web test:e2e
      --workers=2`; failure sets compared **by name** against a `master` run on the
      same host; `| N skipped` grepped in every lane; `pmset -g log` read before
      attributing a timeout.
      **AC**: unit and integration 0 failures beyond the documented load-sensitive
      names (`dirty-resolution-race` pair, `deliverer` D3), each re-run idle and
      green 4/4 when hit; e2e set ⊆ the documented `master` set + zero new names;
      `pnpm lint` 0 errors on changed files; `pnpm typecheck` clean; `git status`
      clean of `eslint --fix` collateral.
      **Verified 2026-09-23, with two stated deviations.** No host was quiet (load
      20-72; `pmset -g log`: no sleep after 09:17, so no timeout is a sleep). Unit
      825 files / 8606 tests green, 0 skipped. Integration: the full lane ran at
      Commit 7 (511 / 4535, load 25-240) with 6 reds in 5 files — beyond the
      documented `deliverer` D3, four names (`permission-deadline` RED 13/14,
      `run-transcript-projector`, `projection-worker` AT-03,
      `gate-permission-resume`) in code this branch does not touch, green on ONE
      idle batch re-run, not 4/4 each (deviation 1). The final tree changed
      since only by C66 (an error-path refusal) and C67 (a comment), so the 28
      integration files this branch adds or edits plus every C66 caller re-ran on
      it: 383/383. Supervisor untouched, 449 + 244/245 (runtime-file-budget AT-02
      8/8 alone twice). e2e, the full lane on the final code tree: 191 passed, 7
      failed, 1 static skip, 1 not run (serial). Deviation 2 — three names are
      not in the documented 2026-09-22 set, but the plan's own comparison is "a
      `master` run on the same host": run on this branch's merge base c36ff5b1
      (a detached worktree, same host, same session), `orchestrator-loop:56`
      and `flow-target-delegation:36` fail at the identical assertions (paths
      with no line of this branch), and `m11b-takeover:67` fails at `:202`
      where the branch fails one step earlier (`:95`, Return 5 s after the
      claim) — the branch's run page renders ~10-20 % slower on the e2e
      database (claim → Return median 3.46 s vs 2.91 s, n = 3 interleaved;
      probed: git fact loader ~26 ms, rail + presence ~50 ms over 33 rows; see
      Follow-ups). `push-notifications:103` (documented flaky) is intermittent
      under either config. So the documented set is stale, not this branch's
      set larger. Lint: eslint on the 125 changed web files 0 errors / 0
      warnings, no `--fix` collateral; `tsc --noEmit` clean.

**Commit 8** — `docs(workbench-git): ADR-181 Implemented — as-built sweep, e2e smoke, lane re-qualification`
(as committed, `d35ccb6c`: the planned "live PR check" is T4.2, not executed).

### Phase 5 — owner follow-ups (decided 2026-09-23, after Commit 8)

- [x] **T5.1 — One writer per worktree covers recover (Follow-up 1).** Recover
      refuses while a live workbench claim owns the tree, and every claimant
      decides on the run's status under the `runs` row lock.
      **AC**: a recover under a live lifecycle claim or a live promotion claim is
      `409 CONFLICT details.reason:"busy"` with nothing moved (still `Crashed`, no
      generation minted, no dispatch), a lapsed lease owns nothing; a lifecycle
      claim whose run's status moved after admission refuses `busy` with the tree
      untouched; a parked finalize whose run a recover flipped mid-claim is not
      finalized; the scratch recover refuses the same way; the recover panel
      names `busy` as retryable, never as a discard; each control falsified.
      **Verified 2026-09-23.** `resumeCrashedRun` reads the workspace's claims
      after its run row lock and answers `workspace-busy` (`409 CONFLICT busy`
      through the shared `recoverHttpResponse`, so the ext twin answers the
      same); the scratch recover route refuses inside its CAS transaction;
      `workbenchClaimHoldsTree` (`lifecycle-claim.ts`) is the one rule both read.
      `claimLifecycleOperation` locks the `runs` row after the busy checks
      (workspace row first — the sync claim's order, and after the busy checks so
      it never waits on a holder's `recordDrop`, run then workspace) and refuses
      `busy` unless the status equals `expectedRunStatus`;
      `finalizeParkedPullRequest` reads the run `FOR UPDATE` in the same place.
      The recover panel's 409 used to say "discard its workspace" for every
      refusal — for `busy` that advice destroys the work the git operation
      preserves — so `recoverHttpToUiState` takes the typed `details.reason` and
      `busy` renders `run.recoverBusy` (EN/RU). Beyond the Follow-up's two
      fences: the parked finalize's unlocked re-read (a recover committing
      mid-claim was finalized to `Done` while running) and the scratch recover,
      the same gap one route over. Controls: `recover.integration.test.ts` (3),
      `lifecycle-race.integration.test.ts` (1, the window held at the pre-claim
      dirty read), `pr-finalize.integration.test.ts` (1, a raw transaction holds
      the run row; the waiter is matched by `pg_blocking_pids`, because
      `pg_stat_activity.query` truncates a `select *` over `runs` before its
      FROM), `scratch-placement.integration.test.ts` Q6, `recover-http.test.ts`,
      `recover-ui.test.ts`, `run-recover-actions.dom.test.ts` (2). RED first on
      the unfixed tree (4 red, the lapsed-lease pin green); falsified — the four
      guards reverted together turned all five integration controls red, and the
      dropped reason turned the busy banner into the discard advice. The 67
      integration suites that reach a lifecycle claim, a recover or a promotion:
      620/620. Contracts: the web and ext recover 409s (the ext "only `503` is
      retryable" was false for `busy`), the scratch recover 409, the discard 409's
      `busy` causes; the error taxonomy (`CONFLICT` row + a `busy` recover
      token); `reconciliation-gc.md`, `workbench-git.md` (Expectation 3 edited in
      place), `workbench-lifecycle.md` (plus its stale "do NOT otherwise
      cross-guard", false since C26), `flow-run.md`, the RU manual, an ADR-181
      amendment.
- [x] **T5.2 — A `Failed` workbench expires (Follow-up 2, owner: TTL).** A
      `Failed` run's worktree is collected like `Done | Abandoned` —
      `gcAgeDays` after `ended_at` (or at `scheduled_removal_at`), preserved
      first (snapshot commit + `maister/archive/<runId>`, which Reattach
      restores from) — and the rail and run detail show its TTL countdown. A
      new `WORKTREE_TTL_RUN_STATUSES` carries it; `DISPOSABLE_WORKSPACE_RUN_STATUSES`
      keeps its other readers' meaning (runtime-object retention, the shared-tree
      removal guard), because those were not decided.
      **AC**: the GC collects a `Failed` worktree past its TTL and not before,
      with the dirty tree preserved and re-attachable; `Crashed` and `Review`
      are still never collected; the rail and run detail carry the countdown;
      runtime objects of a `Failed` run are untouched; each control falsified;
      docs/ADR/RU updated.
      **Verified 2026-09-23.** `WORKTREE_TTL_RUN_STATUSES` (`run-status-sets.ts`)
      is read by the GC's candidate filter and its held-back log, and by
      `deriveTtlInfo`, so the countdown can never show for a status the sweep
      would not collect; `DISPOSABLE_WORKSPACE_RUN_STATUSES` keeps runtime-object
      retention and the shared-tree removal guard. The shared-tree sibling
      subqueries now exclude the candidate itself — a `Failed` allocator counted
      as a live sibling of its own tree and could never be collected — while a
      `Failed` reuser still holds the tree (no row of its own to count down).
      C68 below. Contract moved (owner): `workspace-gc`'s protected list and
      `ttl.test.ts`'s never-counts-down list lose `Failed`, and RED 3's "no GC
      countdown" becomes the `ended_at + gcAgeDays` deadline. Controls: two
      `workspace-gc` cases (collected past the TTL, preserved first, archived;
      kept inside it), the `shared-tree-gc` Failed allocator, two `ttl` cases,
      RED 3's deadline and label, and a `runtime-object-retention` guard (a
      `Failed` run's run-class object survives the workspace deadline). RED on
      the unchanged tree (5 + the label); falsified in three isolated rounds —
      the candidate set and `ttl.ts` reverted (5 red), the self-exclusion dropped
      (the allocator case red), `Failed` pushed into the narrower set (the
      evidence guard red). 38 GC / query / retention / reattach integration
      suites 368/368; unit 81/81 across TTL, statuses, i18n parity and the rail;
      tsc clean; eslint 0/0; `validate:docs` green. Docs: `workbench-git.md`
      (Expectation 12 in place, an edge case), `reconciliation-gc.md` (the
      ADR-148 boundary sentence and its collection line), `workspaces.md`,
      `orchestrator.md`, `configuration.md` (`MAISTER_GC_AGE_DAYS`), the rail
      screen doc (a `Failed` row, the TTL badge), root and web `CLAUDE.md`, the
      RU manual, an ADR-181 amendment.
- [x] **T5.3 — The three master-side e2e names (owner: diagnose here).**
      `orchestrator-loop:56`, `flow-target-delegation:36`, `m11b-takeover:67` fail
      on this branch's merge base `c36ff5b1` too. Root-cause each from its FIRST
      attempt with the dev server's logs; fix the product or the spec.
      **AC**: each passes twice alone on this host, or stays red with a named,
      evidenced cause the owner can act on; its own commit.
      **Verified 2026-09-23.** Diagnosed from the dev server's own log (the lane
      discards stdout; a temporary `webServer.stdout: "pipe"`, reverted).
      `flow-target-delegation:36` was a deterministic race, red alone at load
      ~19 with one worker: both two-node cli children logged `runGraph ended
      Review` before "orchestrator turn ended with no pending children —
      completing node", so the coordinator correctly never parked and the wake
      never ran. The delegated flow's first node now waits for
      `e2e/_seed/delegated-release.ts`'s file, which the spec clears before the
      launch and creates once it sees `WaitingOnChildren`; the log then reads
      park → two `run.review` → "woke parked coordinator". `orchestrator-loop:56`
      and `m11b-takeover:67` passed alone at load ~19 (18.6 s, 22.5 s) and had
      failed only at load 40-72 with `--workers=2`, on the merge base too — the
      30 s default budget, not the product (the branch's ~10-20 % slower run page
      is T4.4's measurement); both carry 120 s now, and m11b waits 15 s for the
      claim's refresh and 60 s for the post-return resume. All three passed
      together twice at `--workers=2` (35.5 s, 32.2 s), flow-target-delegation
      alone twice more. Noted, not fixed (another fixture's): the observatory
      seed's task-less `Pending` flow run, which the scheduler promotes whenever
      a slot frees. `web/CLAUDE.md`'s baseline records all of it. The final lane
      then surfaced a fourth name of the same class: `adr160-rework-claim:66`
      (29.8 s, out of budget at the post-return fresh-review wait; 7.7 s and
      6.9 s alone, where the previous lane had needed 24.6 s) — its own 45 s wait
      had always been cut off by the 30 s default; it now carries 120 s too. With
      the hold in place flow-target-delegation reached its last step for the
      first time and met `read ECONNRESET` on a dispatcher tick in a lane at load
      151 (a keep-alive socket the dev server had just closed); the tick is
      idempotent, so both specs' tick helper retries once on a fresh connection.
      The four specs then passed together twice at `--workers=2`, at load 62 and
      39.
- [x] **T5.4 — The observatory seed queues no run (owner, 2026-09-24: fix).**
      T5.3's log showed the M23 fixture's task-less `Pending` flow run promoted by
      the real scheduler whenever a slot freed, failing its dispatch (`task not
      found`) and stranding as `Running`. `Pending` is transient under a live
      scheduler (the e2e cap is 64), so the fixture cannot hold one; no spec read
      `pendingRunId` and `m23-observatory` asserts only settled buckets. The row,
      its id and the fixture field are gone.
      **AC**: the promotion failure is absent from the dev server's log on the
      spec pair that produced it; the Observatory spec stays green.
      **Verified 2026-09-24.** `orchestrator-loop` + `m23-observatory` with a
      temporary `webServer.stdout: "pipe"` (reverted): 12/12, zero `task not
      found`; the same pair over `HEAD`'s seed: 12/12 and one `promoteNextPending
      runFlow dispatch failed — task not found` (the falsification). tsc clean,
      eslint 0/0 on both seed files.
- [x] **T5.5 — `permission-deadline` RED 13/14 stop going red (owner,
      2026-09-24: "make it not red").**
      **Superseded 2026-09-25 (`/aif-verify` blocker 3; owner: drop the
      knob).** The diagnosis below is wrong about the product. The `result`
      grant it calls correct-by-rule marked the operator's stored answer
      delivered although no `session.input` ever carried it — a product bug,
      which master fixed the same day in its ADR-180 correction (`04a3a39a`): a
      checkpointed permission without confirmed input resumes as `continue`
      whatever the prompt's outcome. Measured on a scratch `master` worktree
      under the same 16 burners (load 75-278): RED 13+14 12/12 twice with no
      knob, and the succeeded-prompt race fired in 7 of 12 cases — so the knob
      would have hidden master's fix from this suite. It was reverted after the
      master merge (Commit 16, Commit 17); `web/CLAUDE.md` and the memory note
      carry the corrected account. What follows is the 2026-09-24 record.
      Event order dumped under 16 `yes`
      burners: in a red run the mock's reply to the cap's cancelled permission
      (`end_turn`) reached the host before the SIGTERM, so the prompt COMPLETED
      and the agent grant read `kind: "result"` — the manager's own rule, "a
      complete response … retains its result even during checkpoint teardown"
      (`permission-handoff-evidence.ts`), deterministically controlled by
      `permission-result-failure`'s `MOCK_ACP_COMPLETE_ON_CHECKPOINT` cases. Not a
      product race: once teardown starts (the same tick as the cancel)
      `runAsyncPromptCommand` holds every prompt terminal behind `outputDrained`
      (`supervisor/src/http-api.ts`), so it lands after `session.exited` whatever
      the adapter answers and the order stays `after_checkpoint`; only a
      complete answer changes the kind. A real adapter cannot give one in that
      window — claude-agent-acp turns a cancelled outcome into "Tool use aborted"
      and asks the model again. The resumable mock gains an opt-in
      `MOCK_ACP_HOLD_AFTER_CANCELLED` (a turn whose permission was cancelled ends
      only by the teardown), set in this suite alone; the six other suites on
      the fixture do not set it.
      **AC**: RED 13/14 green in every loaded round in which the same runs
      without the knob go red; the whole suite and every other fixture user
      green.
      **Verified 2026-09-24.** RED 13+14, 8 rounds alternating with a temporary
      copy of the suite minus the knob (deleted), load 100-246: with the knob
      16/16 green; without it 8/16 red in 6 of 8 rounds, every one
      `expected { kind: 'result' } to match { kind: 'continue' }`, no timeout.
      Whole suite idle 10/10 twice and under the burners 10/10 three times (load
      172-215); the fixture's other users idle — web 5 files / 43 tests,
      supervisor 2 files / 5 tests; eslint 0/0 on both files.

**Post-verify fix lanes (merged tree, 2026-09-25, Commits 16-19).** Battery:
`validate:docs:all`, `validate:contracts`, `@maister/mcp` typecheck + build, web
and supervisor typecheck, `next build` — all exit 0. Web unit 850 files / 8835
tests green. Supervisor unit 449/449; the post-merge run's one red was master's
missing `stream_health_unavailable` enum value (`29858e11`, Commit 19), and one
intermittent `spawn.test` case passed 5/5 alone. Supervisor integration 246/247
(`permission-cap` RED 3 once, 5/5 alone; the supervisor sources are master's).
Web integration 523 files / 4641 tests, 14 red in 5 files, and every file passed
alone on a quiet host:
- `consensus-prompt-owners` (2 reds, 21/21 alone);
- `cost-rollups` (Docker port starvation, 7/7 alone);
- `durable-workers-concurrency` E (3/3 alone);
- `execution-ab-partitions` (5) and `execution-ab-process-death` (6), 6/6 each
  alone. These are master's production-boot suites, which the AB lane runs
  alone because their `next build` owns `web/.next`; in the shared lane a
  concurrent build removed the stamp (`ENOENT .maister-lane-build`).

e2e: 197 passed, 4 failed (all in the documented set), 3 flaky. **Master moved
again during these lanes** (`9925b041` → `8ff196d4`, 33 commits, migrations
`0176`-`0178`), so the final sync before the merge renumbers to the next free
number (`0179` as of `8ff196d4`; a trial merge has 3 textual conflicts:
`error-taxonomy.md`, the journal, the `0176` snapshot) and re-runs these lanes.

**Phase 5 lanes (final tree, 2026-09-23).** Unit 826 files / 8611 tests, 0
failed, 0 skipped (a run overlapping a load spike to 151 timed out 17 cases in
10 untouched files; the idle re-run is this one). Integration 511 files / 4544
tests: 4 red in 3 files, all in code with no line of this branch —
`permission-deadline` RED 13/14 (ADR-180; red at load >= 28, green at <= 20
across four idle rounds), `deliverer` D3 (documented), `permission-resume`
"owner-flow-repeated-permission" (once, in a lane that started at load 151;
green in every re-run) — recorded in `web/CLAUDE.md`. e2e: the documented set
(`platform-agents-page:26`, `review-diff-scopes:43`, `studio-ai-assistant:69`,
`push-notifications:103/218` intermittent), the flaky `scratch-detail:50`,
`work-table:97`; under load 151 also `flow-studio-artifacts:155` (a React Flow
handle without a bounding box) and `flow-package-viewer:79` (a 500 on save,
green on retry) — Studio code this branch does not touch; the four T5.3 specs
green.

**Commit 9** — `fix(workbench-git): recover respects the one writer of a worktree` (T5.1)
**Commit 10** — `feat(workbench-git): a Failed workbench expires like a finished one` (T5.2)
**Commit 11** — the T5.3 fixes (separate, as the owner asked)
**Commit 12** — `fix(scratch-runs): the recover fence reads the workspace row as its route does` (T5.1, found by the final unit lane)
**Commit 13** — `test(e2e): survive a reset dispatcher tick; budget the rework-claim loop` (T5.3, found by the final e2e lane)
**Commit 14** — `test(e2e): the observatory seed queues no run` (T5.4)
**Commit 15** — `test(permission-deadline): only the teardown ends a turn whose permission the cap cancelled` (T5.5; superseded by Commit 17)
**Commit 16** — `Merge master into claude/worktree-run-management-0603cc` (`/aif-verify` blocker 2: 46 master commits, 8 conflicts, `0173` → `0176`). Gone since the rebase onto `8ff196d4` (below): its resolutions live in the replayed commits.
**Commit 17** — `test(permission-deadline): drop the T5.5 fixture setting` (`/aif-verify` blocker 3)
**Commit 18** — `fix(workbench-git): a commit needs no remote` (`/aif-verify` blocker 1)
**Commit 19** — `docs(supervisor): publish stream_health_unavailable in the ReasonToken enum` (master's `29858e11` gap, surfaced by the post-merge supervisor lane)

**Post-review fixes (`/aif-review` of the whole branch, 2026-09-25; the owner:
fix now, every finding).** Five MAJOR, eleven MINOR, plus one gap found while
fixing them (and one regression caught in self-review, Commit 37). One commit per finding. Each guard was falsified: reverted, seen
red, restored.

| # | Finding | Commit |
|---|---|---|
| M1 | Force publish was unconfirmed, and its lease was re-read at retry time. The refusal now names `remoteHead` + `remoteRef`, the shared dialog confirms, and the retry leases exactly `expectedHead` (400 without it). The handoff branch never forces. | 20 `c0378b52` |
| M2 | `git-state` 403 read as a load failure → the members-only state | 21 `10822bf5` |
| M3 | ADR-181 prose inside the supervisor-code table of `error-taxonomy.md` | 22 `0306ffe2` (with m15 and the rules GC line) |
| M4 | The scratch PR target branch had no test, and the seed wrote no `scratch_runs` row. The fix: `target_locked`, and the panel's target field is read-only | 23 `9b4b87d7` |
| M5 | The facts loader's degrade path had no test. Found by the test: a failed probe hid Re-attach | 24 `d371142a` |
| m6 | The publish pushed without re-proving its lease | 25 `ea431d3e` |
| m7 | ABA: HumanWorking claims re-checked only the status → `requireReworkClaimOwner` under the lock, in the lifecycle and sync claims | 26 `3a3de34e`, 37 `3e8a6902` (26 also gated the reconciler's actor-less claim; 37 exempts system callers and makes every workbench call name its actor) |
| m8 | The "who holds the tree" rule duplicated in facts.ts → `workbenchClaimHolder` | 27 `7b06859c` |
| m9 | The sync and promote routes copied the D24 body → `maisterErrorBody` | 28 `d9615ecd` |
| m10 | Bare `getDb()` in the git service → the injected `db` | 29 `615c0437` |
| m11 | `warnings` fetched, never rendered | 30 `af7b3cf5` |
| m12 | Disabled inspector links carried `aria-disabled` while still navigating → `aria-describedby` | 31 `b0df94c0` |
| m13 | A 1300-line panel → one component per section | 32 `ec1a358d` |
| m14 | Text-only Handoff toggle → icon + `aria-expanded` | 33 `c6553c97`, 34 `d4b3774c` (33 was committed with its new test red; 34 fixes the test) |
| m16 | A template without `{task_key}` could collide across tasks | 35 `574514ec` |
| + | `branchNameSchema` accepted names git refuses. That became reachable once the operator types the public name. | 36 `80ccb02b` |

**Rebased onto `master` `8ff196d4` (owner, 2026-09-25).**
- The branch is linear on `master`: 43 commits, no merge commit. Commit 16's
  merge is gone. Its 8 conflict resolutions were re-applied where each change
  first appears, and master's 33 newer commits added one more conflict (the
  `error-taxonomy.md` `EXECUTOR_UNAVAILABLE` row; master's text precedes the
  branch's).
- The migration takes the next free number, `0179_workbench_git_publication`,
  from the commit that introduces it:
  - the SQL is byte-identical;
  - the journal `when` `1790286237211` is newer than master's `0178`;
  - the snapshot was regenerated by drizzle-kit and chains to `0178`
    ("No schema changes");
  - the RED commit's migration test is renamed `0179` with predecessor
    `0178_host_span_verdict`;
  - the docs freeze and the as-built sweep cite `0179`. Master's own `0173` and
    `0176` mentions are untouched.
- The SHAs cited in this plan are the rebased ones.
- Verified: the rebased tree equals a trial merge of the pre-rebase head with
  `8ff196d4`, renumbered the same way, except the regenerated snapshot. The
  pre-rebase head is kept as `backup/run-management-pre-rebase-2026-09-25`.
- The first lane on the rebased tree found a semantic conflict that no text
  merge shows (Commit 39 `85a3e45f`). To carry its `busy` refusal, the branch
  made the scratch recover route forward every thrown `details.reason`.
  Master had since documented that route's ADR-167 D5 503 as "the body carries
  only `code` and `message`", and its new case failed on the leaked
  `prompt_incarnation_pending`. The route now forwards only `busy`.
- **Lanes on the rebased tree (final tree `85a3e45f`).**
  - Web unit: 855 files / 8936 tests, 0 red.
  - Supervisor unit: 45 / 449, 0 red. Supervisor integration: 27 / 247, 0 red.
  - Web integration: 533 files / 4741 tests, 2 red and 1 file whose setup
    failed. Each passed alone:
    - `execution-ab-partitions` P4, 6/6 alone;
    - `durable-workers-concurrency` E, 3/3 alone;
    - `ext/projects/[slug]/flows`: Docker ran out of host ports at setup,
      4/4 alone.
  - e2e (`--workers=2`, no `CI`; re-run after a clamshell sleep at 19:20 had
    frozen the first run's dev server): 196 passed, 4 failed, 4 flaky.
    - The four failures are the documented set: `desk:205`,
      `platform-agents-page:26`, `review-diff-scopes:43`,
      `studio-ai-assistant:69`.
    - Flaky: `desk:454`, `desk:485`, `push-notifications:103`, `work-table:97`.
      `desk:485` is master's Desk code (no line of this branch). It failed 1
      of 2 solo runs because two `desk-empty` copies rendered, one hidden; it
      is flagged as a separate task.
  - Battery, all exit 0: `next build`, the web, supervisor and mcp
    typechecks, the mcp build, `validate:docs:all` and `validate:contracts`.

**Option C — no force-push drops the publication's own commits (owner,
2026-09-25: "C, now, everywhere").** The follow-up below ("Update with push
drops remote-only commits without asking") is decided as C, which covers every
force-push of a run branch, not only the panel's Update.

| # | Change | Commit |
|---|---|---|
| C1 | One guard, `lib/runs/publication-guard.ts`, before every forced run-branch push. After a fetch it counts the commits reachable from the lease head that are in neither the pushed result's ref, nor any head the run branch's reflog records, nor the same patch as one of the run's own; merges do not count. The sync refuses `CONFLICT` `publication_diverged` (`remoteHead`, `remoteRef`, `remoteOnlyCommits`) before its claim; only the web route's `expectedRemoteHead` confirms, and only for the `workbench` admission, and the push then leases exactly that head. The squashing PR promotion refuses before its squash and releases its claim. The ext API, `ai_rebase_merge` and the resolver cannot confirm. | 40 `36bfa05b` |
| C2 | The panel's Update refusal dialog: the same update onto the publication first (primary), or "Overwrite N commits" with `expectedRemoteHead`; a moved publication re-asks with its new head. The review panel and the header's one-click Promote show a refused promotion as that, never as the merge-conflict card. | 41 `d21430d6` |
| C3 | One step further than the primary way out: after the update onto the publication, the update onto the target asks nothing and keeps the reviewer's commit. | 42 `48f792af` |
| C4 | D10's static guard lists every exported filesystem wrapper; `remoteOnlyCommitCount` was missing (found by the full unit lane on Commit 40). | 43 `a97fee20` |

- Publish needed no new check: every publish force was already confirmed
  against the exact head (M1, Commit 20). The handoff branch never forces.
- Found before C1 was committed: counting by patch alone refused a retry after
  an update whose push never landed. A clean rebase that shifts a hunk's
  context changes its patch id, so the run's own old commit on the remote
  counted as the publication's (scratch repo: count 1; sync suite: refused).
  The branch's reflog records every head the branch had, so the count now
  excludes them. The same record covers the squash reclaim, so the
  pre-squash ref the first draft wrote (`refs/maister/pre-squash/<runId>`,
  plus a `squashRunBranch` option) was removed before the commit. With
  reflogs expired or off, only the patch match is left and such a push is
  refused, never guessed.
- Falsified, each seen red and restored: without the reflog exclusion (the
  rewrite case and the squash case, 2 instead of 0); without `--cherry-pick`
  (the expired-reflog case); without the known reason, without the dialog's
  head check, and with the promote helper keyed on the code (the plain
  `CONFLICT` controls).
- **Lanes on the C tree (2026-09-26; two other sessions ran vitest lanes
  and a VM held ~430 % CPU, load 9–270).**
  - Battery, all exit 0: `next build`, the web, supervisor and mcp
    typechecks, the mcp build, `validate:docs:all` and `validate:contracts`.
  - Supervisor unit: 45 files / 452 tests, 0 red. Supervisor integration: 28
    files / 252 tests, 0 red.
  - Web unit: 857 files / 8950 tests.
    - The first run, on Commit 42, had 1 red: D10's wrapper inventory lacked
      `remoteOnlyCommitCount`. Fixed by Commit 43.
    - The re-run on Commit 43 had 1 different red: `continuation-observability`
      hit its 5 s timeout at load 270. The same file failed on `master` at
      load 212 (1 of 2 runs) and passed 2/2 alone at load 13.
  - Web integration: 533 files / 4753 tests, 3 red, 1 skipped. The skip is
    `host-span-load`'s opt-in `describe.skipIf`. The reds were
    `bounded-output` AT-07 and `launch-paths` P2/P3, at load ~120. Alone at
    load ~15 they passed 26/26 and 4/4. Neither file is touched by this
    branch.
  - e2e (`--workers=2`, no `CI`, load 81 at start): 195 passed, 3 failed, 7
    flaky.
    - Failed, all documented: `platform-agents-page:26`,
      `studio-ai-assistant:69` and `review-diff-scopes:99`. That file's
      failing case trades between `:43` and `:99`.
    - Flaky, passed on retry: `admin-execution-host:46` and
      `studio-package-viewer:56` (both 2/2 alone), `review-diff-scopes:43`,
      `scratch-detail:50`, and three in one class.
    - That class is `desk:454` and `push-notifications:103/218`: strict-mode
      violations on page content. React parks a streamed copy of every `(app)`
      page outside `<main>`, and the attention stream's first refresh renders
      another copy into it. The Desk is fixed on its own branch off `master`
      (`claude/desk-empty-streamed-duplicate`, `3232dcac`). The other specs in
      that class are not scoped yet.

**Post-review fix lanes (the pre-rebase tree `2a42866c`, 2026-09-25; re-run on the rebased tree below).**
- Battery, all exit 0: `next build`, the web, supervisor and mcp typechecks,
  the mcp build, `validate:docs:all` and `validate:contracts`.
- Web unit: 851 files / 8873 tests, 0 red.
- Supervisor unit: 45 files / 449 tests, 0 red. Supervisor integration: 27
  files / 247 tests, 0 red.
- Web integration: 523 files / 4649 tests, 2 red. Both are master's
  production-boot process fixtures, which the branch does not touch:
  - `execution-ab-process-cleanup` "O-exit: 'success'" ("refusing
    unverifiable fixture group"), 13/13 alone;
  - `execution-ab-process-death` D3 (fixture cleanup), 6/6 alone.
- e2e (`--workers=2`, no `CI`): 195 passed, 6 failed, 3 flaky.
  - Four failures are the documented set: `platform-agents-page:26`,
    `review-diff-scopes:43`, `studio-ai-assistant:69`, `scratch-detail:50`.
  - Two were master's `consensus-resolution:209/264`. Its describe-level
    `beforeAll` runs once per worker under `fullyParallel`, so two workers
    raced `tasks_project_number_uq` or seeded two identical cards. Measured
    with the spec alone: 1 worker green, 2 workers red. Serial describe:
    2 workers green 3/3 (Commit 38 `3efd0083`).
  - Flaky: `activity-feed:51` and `work-table:97` (documented) and `desk:454`
    (2/2 alone).

---

## Refactor gates (the R in RED → GREEN → REFACTOR)

`T1.R`, `T2.R`, `T3.R` are first-class tasks: each runs after its phase is green,
changes no behaviour, and is bounded by three questions — **DRY by question, not by
shape** (D22); **orphans this change created** are removed, pre-existing dead code
is left alone (root `CLAUDE.md`); **the suite is the invariant** — a refactor that
needs a test edited is not a refactor.

## Test plan

### Controls (23 + e2e, disjoint)

| # | Control | Lane / file | Fails on this tree because |
|---|---|---|---|
| RED 1 | policy matrix: status × viewer × usable/removed/missing × busy; unknown status; `HumanWorking` owner full set, non-owner `human-owned`; `Crashed` with an active execution assignment admitted (C14); live shared sibling → busy | unit `lib/workbench-git/__tests__/policy.test.ts` | module absent |
| RED 2 | production deps return the user; `getRunDetail` / layout actions for the claim owner; board/rail/portfolio still none | integration `lib/workbench-lifecycle/__tests__/carve-out-production.integration.test.ts` | `viewerUserId` always null |
| RED 3 | `ACTIVE_RUN_STATUSES` pins `Failed`; portfolio, project list, rail list a `Failed` run without TTL; `decisions.count` and `listCrashedForProjects` unchanged | unit `lib/queries/__tests__/active-run-statuses.test.ts` + integration `portfolio.integration.test.ts` case | `Failed` absent |
| RED 4 | Backlog card DTO carries `lifecycleActions` iff the latest run's worktree is usable | integration `lib/queries/__tests__/board-failed-card.integration.test.ts` | `BacklogCard` has no such field |
| RED 5 | migration triple + co-nullity CHECK; YAML SET/CLEAR/re-SET; column → YAML omit/emit; invalid template → `CONFIG` | integration `lib/db/__tests__/migration-0173.integration.test.ts`, unit `lib/packages/__tests__/yaml-writeback.test.ts` cases | columns/field absent |
| RED 6 | template rendering + transliteration + cap + collapse + fallback + `CONFIG` | unit `lib/workbench-git/__tests__/public-branch-name.test.ts` | module absent |
| RED 7 | publish: refspec, upstream config, `published_*`, name order incl. `public_name_fixed`, non-FF → `canForce`, explicit-SHA lease, stale lease keeps local, crash-window retry no-op; one step further: publish again is a no-op and update-from-published brings a remote push back | integration `lib/workbench-git/__tests__/publish.integration.test.ts` (real git + bare remote) | pushes internal name, no upstream, no record |
| RED 8 | `isBranchPublished` reads `published_branch` before the upstream probe; ingest fast-forwards from the published ref | unit `branch-published.test.ts` case + integration `rework-claim.integration.test.ts` case | internal name assumed |
| RED 9 | rescue ref holds tracked + untracked, real index untouched, tree clean after, clean tree 409, ref survives drop; restoring from the rescue ref reproduces the bytes | integration `lib/workbench-git/__tests__/discard.integration.test.ts` | route/service absent |
| RED 10 | `git-state`: usable / removed / worktree-gone DTOs; unreachable remote → 200; member 200, viewer 403; not imported by RSC modules | route integration `app/api/runs/[runId]/git-state/__tests__/route.integration.test.ts` | route absent |
| RED 11 | racer: publish vs discard on one workspace → one `CONFLICT`; guard-disabled control shows both run | integration `lib/workbench-git/__tests__/lifecycle-race.integration.test.ts` | ops absent |
| RED 12 | panel states (busy, dirty, unpublished, published+chip, non-FF force, worktree-missing → Reattach only; later: Update/PR sections); inspector href-only; rail deep links; a typed PR title survives a refresh tick | jsdom `components/workbench/__tests__/git-panel.dom.test.ts`, `run-inspector.dom.test.ts` | component absent; `<span>` fallback present |
| RED 13 | archive/drop pass `archivePush` from the env; dialog shows unpushed counts and publishes first | unit `service.test.ts` case + jsdom `lifecycle-actions.dom.test.ts` case | `archivePush` never passed |
| RED 14 | `onto` ×3 on real git; `base_branch_unknown`; `not_published`; `target_ref`; `agent_requires_review`; Review default still launches the resolver; the other five eligibility arms still refuse | integration `sync-target.integration.test.ts` new cases | `onto` unknown (422), status gate |
| RED 15 | conflict restores `headShaBefore`, clean tree, paths returned; a `Failed` run updates | integration same file | no restore; Review-only |
| RED 16 | post-update push leases and pushes the public name and records `published_*` | integration same file | internal name |
| RED 17 | reattach: three sources, upstream re-set, provenance v2, DB nulls after add, `archived_*` kept, no source 409, occupied path 409 untouched, reopen unchanged, reconciler `workspace_reattached`; publish after reattach uses the re-set upstream | integration `lib/workbench-git/__tests__/reattach.integration.test.ts` + `workspace-reconciler.integration.test.ts` case | route absent; reconciler has no arm |
| RED 18 | adapter `draft`: gh/glab argv, Gitea `WIP:`, dedup by head/base, no token leak | unit `pr-adapter.test.ts` cases | no `draft` |
| RED 19 | `/pr`: open from the public name, rows written, status unchanged, reuse, five 409 reasons, 503 keeps the claim, viewer 403 / member 200 | route + service integration `app/api/runs/[runId]/pr/__tests__/route.integration.test.ts` | route absent |
| RED 20 | `/pr/finalize` from `Failed` (rows + events + attribution), from `Review` (readiness through `promoteRun`), `pr_closed`, `pr_missing`, `publish_stale`, concurrent finalize, shared-tree siblings; `promotion_hold`; unsettled siblings → CONFLICT; one step further: scan → `merged`, delivery scan closes the loop | integration `lib/workbench-git/__tests__/pr-finalize.integration.test.ts` | route absent; finalize private |
| RED 21 | `promoteRun(pull_request)` from `Review` publishes the public name + reuses the open PR (rows identical to the panel path; `published_*` recorded) | unit `promote-pr.test.ts` migrated cases | internal name, no upstream |
| RED 22 | scratch `rebase_merge` and `pull_request` admitted; `local_merge` unchanged; target from `scratch_runs`; foreign target refused | unit `promote-service.test.ts` cases | `:1751-1757` refusal |
| RED 23 | `pr_state_scan` scans a `Failed`-run PR | integration `pr-state-scan.integration.test.ts` case | guard — passes on this tree; kept as the widened-population proof |
| e2e | Failed visible → commit → publish → open PR (fake `gh`) → finalize → Done | `e2e/workbench-git.spec.ts` (authed) | nothing exists |

**Overlap audit**: RED 7 owns the push semantics (RED 16 asserts only the name
choice after an update; RED 21 only that promotion reuses the same rows); RED 10
owns `git-state` (RED 12 mocks it); RED 20 owns finalize rows (RED 22 only the
scratch admission); RED 23 asserts no code and is labelled a guard. **No trivial
controls**: none asserts a constant, a type or a field's mere presence — RED 3's
pin of the status array is the one deliberate literal assertion, justified because
four query modules consume it and nothing else would go red.

**Assertion style**: outcome, not shape — RED 7 reads `git config branch.<internal>.merge`
and `ls-remote` on the bare remote rather than the push argv; RED 9 restores from
the rescue ref and diffs the file bytes; RED 17 parses the provenance file; RED 20
asserts the webhook pair and the domain row, not the emitter's call count.

### Falsification (each run and recorded, tree restored after)

| # | Revert | Control that must fail | Expected observation |
|---|---|---|---|
| 1 | `requireActiveSession` discards the user again | RED 2 | owner sees `human-owned` |
| 2 | `lifecycleActionsForWorkspace` hard-codes `null, null` again | RED 2 (detail path) | `getRunDetail.lifecycleActions` empty |
| 3 | drop `"Failed"` from `ACTIVE_RUN_STATUSES` | RED 3 | run absent from `activeWorkspaces` |
| 4 | push without `--set-upstream` / refspec | RED 7 | `branch.<internal>.merge` unset; remote branch named `<internal>` |
| 5 | capture the lease AFTER the push | RED 7 (stale-lease case) | remote head overwritten |
| 6 | `isBranchPublished` without the `publishedBranch` arm | RED 8 | published-without-PR reads unpublished |
| 7 | reset before `update-ref` | RED 9 | rescue ref absent or empty |
| 8 | remove the claim from `discardWorkbenchChanges` | RED 11 | both racers succeed |
| 9 | remove `restoreWorktreeToCommit` from the conflict path | RED 15 | HEAD ≠ `headShaBefore` |
| 10 | null `removed_at` before `worktree add` | RED 17 | row usable, path missing |
| 11 | drop the reconciler arm | RED 17 (crash case) | row stays removed |
| 12 | `draft` ignored | RED 18 | no `--draft` / no `WIP:` |
| 13 | finalize writes rows before the fence check | RED 20 (concurrent) | two `Done` writes |
| 14 | re-add the scratch refusal | RED 22 | 409 |
| 15 | drop `recordPublished` from sync's push arm | RED 16 | `published_*` null after a public-name push |
| 16 | re-add the execution-assignment admission arm | RED 1 | `Crashed` admits nothing |
| 17 | drop `details` from `errorPayload` | RED 9 / RED 19 | the client sees `code` only, no `details.reason` |

Verify each patch landed (`grep` the marker) before reading the result — a
falsification that did not apply is indistinguishable from a control that cannot
fail (patch `2026-09-22`, ADR-180 plan).

### Assertion migration (in scope, per phase)

| File | What changes | Classification |
|---|---|---|
| `lib/workbench-lifecycle/__tests__/policy-rework-claim-carve-out.test.ts:42-58` | owner now gets the full git set (projected: `exportBranch` still the only lifecycle id enabled) — extend, not weaken | obsolete expectation of "export only" at the git level |
| `lib/runs/__tests__/inspector-actions.test.ts:87-130` | inputs gain viewer/owner; items gain `href` | contract moved |
| `components/workbench/__tests__/lifecycle-actions.dom.test.ts` | Export dialog cases → panel cases; `handoff-metadata` fetch cases deleted | obsolete (dialog removed) |
| `app/api/runs/[runId]/workbench-lifecycle/__tests__/routes.test.ts:193-299` | `exportWorkbenchBranch` arg object gains `branchName` | contract moved |
| same file, `errorPayload` cases | error bodies now carry `details` (D24) | contract moved |
| `lib/workbench-lifecycle/__tests__/real-git.integration.test.ts:314,336` | export push assertions read the public name + upstream | broken by the change — fixed |
| `lib/runs/__tests__/sync-target.integration.test.ts:33-41` spies, status cases | spy sites; `onto`; non-Review admission | contract moved |
| `lib/runs/__tests__/promote-pr.test.ts` | push args (`remoteBranch`, `setUpstream`), `createOrUpdatePr` head = public, `draft` | contract moved |
| `lib/runs/__tests__/pr-adapter.test.ts:19-37` header | `draft` added to the contract | contract moved |
| `lib/runs/__tests__/branch-published.test.ts` | new argument | contract moved |
| `lib/runs/__tests__/promote-service.test.ts` scratch refusal | admitted now | obsolete → replaced by RED 22 |
| `components/runs/__tests__/review-panel.test.ts:293-324` | sync dialog gone | obsolete → deleted; chip cases kept |
| `lib/queries/__tests__/portfolio.integration.test.ts:400,457,590` | `activeWorkspaces` counts include `Failed` | contract moved |
| `e2e/run-sync.spec.ts` | `review-sync-*` testids → `git-panel-update-*` | contract moved |
| `e2e/m27-workbench-lifecycle.spec.ts:27-37` | "Export" button → "Publish" in the panel | contract moved |

Every migrated assertion carries its classification in the commit body; none is
loosened.

### Existing suites that must stay green without loosened expectations

`policy.test.ts`, `service.test.ts`, `race.test.ts`, `handoff.test.ts`,
`real-git.integration.test.ts`, `sync-target.integration.test.ts`,
`dirty-resolution-race.integration.test.ts` (known load-flaky pair),
`rework-claim.integration.test.ts`, `reopen.integration.test.ts`, `preserve.test.ts`,
`workspace-reconciler.integration.test.ts`, `promote-service.test.ts`,
`promote-pr.test.ts`, `pr-adapter*.test.ts`, `pr-state-scan.integration.test.ts`,
`decisions.integration.test.ts`, `decision-sources.test.ts`,
`decision-surface-single-source.test.ts`, `run-status-sets.test.ts`,
`work-stage` suites, `inspector-actions.test.ts`, `run-continuation-actions.test.ts`,
`i18n-parity.test.ts`, `migration-journal-integrity`, `openapi`/contract suites,
the whole supervisor suite (untouched).

### Lane hygiene

- Quiet machine; sets compared by **name** against a `master` run; `pmset -g log`
  before attributing a timeout; `grep '| N skipped'` per lane (a module-scope call
  into a partially mocked module fails whole files as SKIPS).
- `pnpm <script> -- <args>` leaks the `--`; pass vitest file lists without it; in
  zsh use `${=FILES}` for word splitting.
- Ports 3100/7788 and `maister_e2e` are shared across worktrees; free them first;
  `--workers=2`; no `networkidle`; diagnose the FIRST e2e attempt.
- Integration lane ≈ 25 min; `sequence 0 / duplicate` every 2 s during the
  `prompt-owners` files is normal.

---

## Traps

1. **`discard` is taken** (C1): route `/discard` and op name `discard` mean workspace
   removal. Never reuse either; the new op is `discardChanges` / `discard-changes`.
2. **`--set-upstream` with a refspec writes `branch.<internal>.merge =
   refs/heads/<public>`**: every helper keyed by the LOCAL name must take
   `remoteBranch` (D4/D7); the sync verify gate's `HEAD is not on <branch>` stays on
   the internal name.
3. **`isBranchPublished` on the live sync path has no `.catch`** by design
   (`branch-published.ts:16-19`) — keep it; panel rendering degrades on its own.
4. **`finalizePullRequest` extraction must keep the fence (`:1426-1452`), the
   sibling flip (`:1520-1555`) and `mergeCommitSha: null`**; `pr_state` is never
   written by finalize.
5. **`git-state` is ~10 git calls + one network call**: own route, lazy, never in
   `getRunDetail`/layout; a grep control enforces it (RED 10).
6. **`deriveInspectorActions` got `Boolean(detail.worktreePath)` with the repo-path
   fallback** (`run.ts:502`) — feed it `workspaceId != null` and the real presence.
7. **`deriveStage` sends `Failed` (and `Abandoned`) to Backlog**; the card menu
   comes from the latest run's workspace facts, never from `tasks.status`.
8. **Scratch base/target live on `scratch_runs`** (`:5099-5101`), not `workspaces`;
   the scratch `workspaces` insert is not widened.
9. **`.tsx` test files are silently uncollected** (`vitest.workspace.ts:52-65`);
   jsdom suites are `*.dom.test.ts` with the per-file pragma; route suites load the
   module in `beforeAll`.
10. **`pnpm lint` is `eslint --fix`** and mutates the tree — `git status` before
    staging. Node ≥ 24.15 < 25 (26 hangs the AB lane).
11. **Migrations are generated** (`drizzle-kit generate`); the triple is SQL +
    journal + snapshot; `db:erd` regenerates `erd.dbml` or `validate:docs` is red;
    journal `when` strictly increasing.
12. **Gitea/GitVerse draft is version-dependent** and the provider boundary is
    mocked in CI — T4.2 is the only live evidence; record versions.
13. **Child-process env**: git goes through `runGit` (`cLocaleGitEnv`) or
    `NETWORK_GIT_ENV` (`GIT_TERMINAL_PROMPT=0`, BatchMode SSH); never a third env
    builder; URLs through `redactUrl`; ADR-153's allow-list governs agent processes
    (untouched here).
14. **`git stash` is shared across worktrees** — WIP commit, or
    `git stash push -u -m "<tag>"` + `apply <sha>`, never bare `pop`.
15. **`workbench-git.md` Expectations is at 12** (R5a cap; not in a gated group) —
    edit in place, never add; `branch-sync.md` and `attention.md` likewise at 12.
16. **`run.promoted` has no domain-event kind** — emit it through
    `emitWebhookEvent` only; the AsyncAPI payload change is additive.
17. **The attention stream reuses `ACTIVE_RUN_STATUSES` as a change-scan
    predicate** (`route.ts:149,183`) — `Failed` joining it adds refresh ticks, never
    a count; RED 3 pins `decisions.count`.
18. **`addWorktreeForBranch` never fetches and maps "already exists" to
    `PRECONDITION`** — the occupied-path `CONFLICT` check runs before it (D10).
19. **`parseGiteaRemote` forces `https://` and drops the port** (C16) — the e2e
    provider is a fake `gh` on PATH, never a local Gitea.
20. **`errorPayload` forwards two `reason` tokens and no `details`** (C15) — D24
    widens it; the top-level `reason` enum stays two values; the UI reads
    `details.reason`.
21. **`crashRunningRun` and `markAbandoned` keep the execution assignment `active`**
    (C14) — never gate a parked run on it; the status class is the witness.

---

## Out of scope

- AI resolver outside `Review`; relaunch from a run branch; per-file discard;
  ext API / MCP exposure of push/PR; Bitbucket; a task-level PR entity; auto-`Done`
  on external merge; widening `pr_state_scan` to scratch (Q5); rescue-ref GC (Q10).
- The `handoff-branch` dialog and `GET handoff-metadata` route stay as they are
  (the panel replaces the Export dialog only); folding handoff into the panel is a
  separate, smaller change.
- Re-syncing `docs/configuration.md:322-323`'s phantom `repo_path`/`default_branch`
  rows (T0.8 TODO) and the pre-existing WORKSPACES ERD gaps (T0.8 TODO).
- Editing `public_branch_template` from the settings UI (Q1).

## Follow-ups

Everything above ships in this plan; the two R9 TODOs are recorded defects, not
deferred work of this change. Two scope questions were found (Phase 2, T4.4) and
are put to the owner rather than widened silently:

- **Recover does not respect the workspace lifecycle slot (found in T2.1) →
  fixed in T5.1 (owner, 2026-09-23).**
  `resumeCrashedRun` flips `Crashed → Running` without reading
  `workspaces.lifecycle_operation_*`, and `claimLifecycleOperation` does not
  re-check the run's status under its lock (`expectedRunStatus` is recorded,
  never compared; `recordDrop` alone re-checks, at its final write). So an agent
  can be resumed into a worktree a lifecycle op is rewriting. This is
  pre-existing (M27: archive / drop / export on a `Crashed` run), widened by
  this plan: discard (Phase 1) and update (Phase 2) now also run on `Crashed`.
  Sync's own claim re-validates the status under the run lock, so the gap is
  only "claim first, recover second". The fix is two fences: recover refuses
  while a live lifecycle claim holds the workspace (a new recover refusal —
  OpenAPI, error taxonomy, the ext twin), and the lifecycle claim compares
  `expectedRunStatus` under a run row lock.
- **`Failed` rows are never reclaimed, so D14's lists have no bound (found in
  T4.4) → a TTL, T5.2 (owner, 2026-09-23).** `DISPOSABLE_WORKSPACE_RUN_STATUSES` is `Done | Abandoned`: a `Failed`
  run's worktree stays on disk (pre-existing) and, since D14, stays listed in the
  rail, the portfolio and the project workspace list — one `fs.stat` per row, and
  `getRailWorkspaceGroups` has no page bound. ADR-181 accepts that "portfolio
  counts and the rail grow accordingly"; it does not decide a bound (a `Failed`
  TTL, or a page), which is the owner's call. Measured on the e2e database (33
  rail rows): the rail query plus presence is ~50 ms median per page render, the
  git fact loader ~26 ms. The attention stream's change scan inherits the same set
  (D14, accepted); its comment's "capped by `MAISTER_MAX_CONCURRENT_RUNS`" was
  already loose (`Review` / `Crashed` hold no slot) and is looser now.

- **Update with push drops remote-only commits without asking (found while
  sweeping force paths for review finding M1) → option C, every run-branch
  force-push (owner, 2026-09-25): Commits 40-43.**
  - What happens: `syncRunTarget` force-pushes the rebased branch with an
    explicit-SHA lease. That is ADR-141's rule, and ADR-181 D9 made it reachable
    from the panel in every parked status. The lease is the `ls-remote` head
    read at the moment of the update, not the head the operator saw.
  - The effect: an update onto `target` or `base` with push replaces commits
    that exist only on the public branch (for example a reviewer's fixup).
  - What the panel shows: those commits as `published: behind N`, and the
    "remote moved" hint when the tracking ref lags. The push itself asks
    nothing.
  - Option A: keep ADR-141's rule.
  - Option B: when `behind > 0` and `onto` is not `published`, confirm in the
    shared dialog and bind the lease to the head the panel read, as publish now
    does.

---

## Unresolved questions (batch — ALL answered 2026-09-22, see Resolved questions)

1. **Шаблон публичного имени редактировать в UI?** (a) только через `maister.yaml`
   + read-only строка в настройках (как `branch_prefix`), per-run поле `branchName`
   закрывает срочную нужду — минимум кода, буква ADR соблюдена; (b) добавить в
   `PATCH /settings` + запись в `maister.yaml` (сегодня PATCH yaml не пишет —
   новая проводка). **Рекомендую (a)**: серверная установка без shell всё равно
   правит yaml через git, а (b) — отдельная мелкая задача после.
2. **`finalizePr` при удалённом worktree** (Abandoned после GC): (a) по ADR D1 —
   сначала `reattach`, потом finalize (один предикат, один клик лишний); (b)
   допускать finalize без worktree, если `pr_url` есть (head берём с remote).
   **Рекомендую (a)** — не размывать предикат; (b) можно ослабить позже одной
   строкой в policy.
3. **`git-state` и сеть**: (a) один best-effort `ls-remote` опубликованной ветки
   при каждом открытии панели (таймаут 60 с существующий, `remoteReachable:false`
   при ошибке) — панель честно показывает «remote ушёл вперёд»; (b) без сети,
   только tracking-ref (быстрее, но «ваши пуши с ноутбука» не видны до Update).
   **Рекомендую (a)**.
4. **Меню карточек/рейла**: deep-link в панель (`?git=<section>`), без слепых
   мутаций с карточки. Подтвердить. **Рекомендую да** — publish без имени и update
   без `onto` с карточки не имеют смысла.
5. **`pr_state_scan` для scratch**: (a) оставить `run_kind <> 'scratch'` (текст
   ADR; scratch-PR через `promote(pull_request)` финализируется сразу, standalone
   Open PR показывает «open (not tracked)»); (b) убрать фильтр — scratch PR
   отслеживаются. **Рекомендую (a)** в этом плане; (b) — однострочный follow-up,
   если standalone Open PR на scratch окажется нужным.
6. **ROADMAP**: завести веху (например «M52. Run git panel», ADR-181, миграция
   0173) через `/aif-roadmap`, или без записи (план ссылается на ADR)?
   **Рекомендую завести** — есть ADR, миграция и 8 коммитов, это веха.
7. **Ветка**: остаёмся на `claude/worktree-run-management-0603cc` (файл плана назван
   по ветке, как у шести предыдущих планов) или создать `feature/run-git-panel` от
   неё? **Рекомендую остаться**.
8. **Co-nullity CHECK на `published_*`** (три колонки либо все NULL, либо все
   заданы): включить в миграцию 0173 (рекомендую, дисциплина как у
   `lifecycle_claim_shape_check`) или строго «nullable» по тексту ADR?
9. **Дефолт `agent` для Update вне Review** — механический (ADR: резолвер только в
   Review); в Review дефолт остаётся ON (ADR-141). Подтвердить, что панель всегда
   шлёт `agent` явно и legacy-вызовы без `agent` вне Review не 409, а идут
   механически. **Рекомендую да**.
10. **Срок жизни rescue-ref** (`refs/maister/rescue/<runId>/<n>`): (a) не чистить
    в этом плане (репозиторные ref-ы, копятся); (b) удалять вместе с
    `maister/archive/<runId>` в retention GC. **Рекомендую (a)** сейчас +
    отдельная GC-политика, чтобы не расширять сweep в этом плане.

## Resolved questions

| # | Question | Answer (owner, 2026-09-22) | Where it landed |
|---|---|---|---|
| 1 | Public-name template editing | **(a)**: `maister.yaml` only + read-only settings row beside `branch_prefix`; per-run `branchName` covers the urgent case | D6, T1.2, Out of scope |
| 2 | `finalizePr` with a removed worktree | **(a)**: reattach first; the predicate is not widened | D1, D12 |
| 3 | `git-state` and the network | **(a)**: one best-effort `ls-remote` of the public name per read; `remoteReachable:false` on failure | D3, T1.9, RED 10 |
| 4 | Card / rail menus | **yes**: deep links into the panel (`?git=<section>`), never blind mutations from a card | D16, T1.11, RED 12 |
| 5 | `pr_state_scan` for scratch | **(a)**: keep `run_kind <> 'scratch'`; a standalone scratch PR shows "open (not tracked)" | D13, T3.5 |
| 6 | ROADMAP milestone | **create one** — via `/aif-roadmap` after implementation (not edited by this plan) | Roadmap Linkage |
| 7 | Branch | **stay** on `claude/worktree-run-management-0603cc` | header |
| 8 | Co-nullity CHECK on `published_*` | **include** in `0173` | D6, T1.1, RED 5 |
| 9 | `agent` default outside `Review` | **mechanical**; `agent ?? (status === "Review")`; the panel always sends `agent`; legacy calls without `agent` outside `Review` run mechanically, never 409 | D9, T2.1, RED 14 |
| 10 | Rescue-ref lifetime | **(a)**: not collected in this plan | D8, Out of scope |
| 12 | C23 — finalize from `Review` and `reviewedTargetCommit` | **(a)**: body `{reviewedTargetCommit?, allowTargetDrift?}`, forwarded to `promoteRun` from `Review` only (400 outside); `git-state.targetHead`; "Finalize anyway" on drift | C23, D12, T0.1, T3.3, T3.5 |
| 11 | C14 — the execution-assignment arm on parked runs | **(a)**: not an admission condition; a parked status is the witness; `hasActiveAssignment` informational; ADR-181 amendment | C14, D1 (busy arm), D1a, T0.7, RED 1, falsification 16, trap 21 |

## Post-implementation decisions (owner, 2026-09-23, after Commit 8)

| # | Question | Answer | Where it landed |
|---|---|---|---|
| 1 | Recover vs the lifecycle slot (Follow-up 1) | **fix** | T5.1, Commit 9 |
| 2 | `0173` vs `master`'s `0173`/`0174` | **renumber at merge** (to `0175`) | merge step — became `0176` (master reached `0175`), Commit 16; master reached `0178` during the lanes, so the final sync takes the next free number (`0179` as of `8ff196d4`) |
| 3 | T4.2 live provider check | **after rollout** | T4.2 |
| 4 | Unbounded `Failed` rows (Follow-up 2) | **TTL for `Failed`** (over pagination) | T5.2, Commit 10 |
| 5 | The three master-side e2e names | **diagnose here**, own commit | T5.3, Commit 11 |

## Post-implementation decisions (owner, 2026-09-24, after Commit 13)

| # | Question | Answer | Where it landed |
|---|---|---|---|
| 1 | The observatory seed's task-less `Pending` run | **fix** | T5.4, Commit 14 |
| 2 | `permission-deadline` RED 13 red under load | **make it not red** | T5.5, Commit 15; resolved by master's `04a3a39a`, Commit 17 |

## Post-verify decisions (owner, 2026-09-25, after `/aif-verify`)

| # | Question | Answer | Where it landed |
|---|---|---|---|
| 1 | The three verify blockers (Commit without a remote; the master sync + renumber; T5.5 vs master) | **`/aif-fix`, fix now** | Commits 16-18 |
| 2 | `MOCK_ACP_HOLD_AFTER_CANCELLED` after the master sync | **drop it** | Commit 17 |
| 3 | The final master sync: now or right before the merge | **right before the merge** | merge step |
| 4 | Run `/aif-review` from this session | **no** — the owner invoked `/aif-review` of the whole branch directly | the review below |

## Post-review decisions (owner, 2026-09-25, after `/aif-review`)

| # | Question | Answer | Where it landed |
|---|---|---|---|
| 1 | Fix the MAJOR findings now, or together with codex's | **now** | Commits 20-36 |
| 2 | MINOR too | **all** | Commits 20-36 |
| 3 | An update's push drops commits only the publication has: A (keep ADR-141), B (confirm when behind), or C (count them, refuse, confirm only in the panel) | **C, now, everywhere** | Commits 40-43 |
