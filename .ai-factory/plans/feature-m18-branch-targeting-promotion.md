# Implementation Plan: M18 — Branch Targeting, Diff Review, and Manual Promotion

Branch: `feature/m18-branch-targeting-promotion` (created from `main` in this
managed worktree at plan time). Consumer skills (`/aif-implement`,
`/aif-verify`, `/aif-rules-check`) discover this file by the current branch
stem.
Created: 2026-06-03
Refined: 2026-06-03 (post Codex adversarial review — F1 durable promotion claim,
F2 M18/M15 scope boundary §0.5, F3 authed branch-options route, F4 legacy-row
compatibility §3.6).
Refined #2: 2026-06-03 (second Codex adversarial pass — F5 durable
`promotion_attempt_id` claim-identity token §3.2, F6 promote-time target-drift
gate §3.7, F7 retryable transient PR failure → `EXECUTOR_UNAVAILABLE`/503 §3.2).
Methodology: **SDD** (docs-first Phase 0 = single source of truth) +
**TDD per code phase** (QA writes RED tests → implementor makes GREEN →
adversarial reviewer pass), with an executable green gate at every phase exit.

## Settings
- Testing: yes
- Logging: verbose  # detailed DEBUG on every git side-effect, promote decision, readiness verdict, provider-CLI invocation (never log credentials/tokens/remote URLs with embedded secrets)
- Docs: yes  # mandatory docs checkpoint; Phase 0 is docs-first and is the source of truth the code phases follow
- Roadmap: linked (below)

## Roadmap Linkage
Milestone: "M18. Branch targeting, diff review, and manual promotion"
Rationale: Implements the M18 line verbatim — launch-time base/target branch
selection, worktree-from-base, run-ledger branch fields, the base→run→target
review surface with readiness summary + raw diff, `local_merge` **and**
`pull_request` promotion for **flow** runs, promote-time readiness refusal,
idempotent promotion, and conflict handoff. Also absorbs the M21/[ADR-025]
deferral "provider-specific PR/push … stay with M18" — at **credential model B**
(host git credentials + provider CLI on PATH, no secrets stored). **Explicitly
NOT in M18** (deferred, confirmed with user 2026-06-03): in-platform SSH-key /
password / token storage ("model C"), deploy/release management, PR-merge
tracking.

---

## 0. Scope, decisions, and what already exists

### 0.1 What the milestone delivers (confirmed with user 2026-06-03)

| # | Deliverable | Decision |
|---|-------------|----------|
| A | Launch picks **base branch** + optional **target branch**; normal path stays one-click | Compact dialog, advanced disclosure; base defaults to `project.default_branch`, target defaults to base |
| B | Worktree is created **from the selected base commit**; run ledger records base branch, base commit, run branch, target branch, promotion mode | New `workspaces` columns; `addWorktree` `startPoint` (already supported) wired through |
| C | Promotion for **flow** runs (today: scratch-only) | **Shared promotion service** drives both run kinds; scratch behavior pinned by regression tests |
| D | Promotion modes `local_merge` + `pull_request` | `local_merge` = `git merge --no-ff` (exists); `pull_request` = host `gh`/`glab` push + PR (new, **model B**) |
| E | Promotion **refuses unless required blocking gates are current/passed or overridden** | Re-use M16 `assertEvidenceReady(runId,"review")` as a **second** enforcement point at promote time — **no M15 dependency** |
| F | Review surface: base→run→target, returned takeover diffs, readiness summary, raw diff, "Promote to `<target>`" | New run-detail `ReviewPanel` for flow runs in `Review` |
| G | Conflict handoff: never auto-resolve; create a manual-takeover/assignment with repo path, target, run branch, failing command | Re-use `createMergeConflictAssignment` |
| H | Promotion is **idempotent** across retryable failures; never duplicate PRs; never double-finalize across a stale-claim reclaim | Durable `workspace.promotion_state` claim + per-attempt `promotion_attempt_id` token (CAS, committed before side-effects) + stored `pr_url`; concurrency serialized by the claim, finalize gated on the attempt token, not a held lock (Codex F1/F5, §3.2) |
| I | Promotion **refuses if the target branch advanced since review** (stale-target guard) | ReviewPanel sends the target HEAD it rendered against (`reviewedTargetCommit`); promote refuses `PRECONDITION` on drift unless `allowTargetDrift` override (Codex F6, §3.7) |

### 0.2 What ALREADY exists (do NOT rebuild — verified during exploration)

- **Promotion exists for scratch runs, `local_merge` only.** `POST /api/runs/[runId]/promote/route.ts` rejects `runKind !== "scratch"` (line 90-91) and `mode:"pull_request"` throws `CONFIG` "not implemented" (line 224-228). `assertPromotionTargetAllowed` (line 130) hard-locks target to `scratch.baseBranch` — M18 relaxes this for flow runs.
- **Flow runs DEAD-END at `Review`.** `runner-graph.ts:1652` flips `Running→Review` (CAS-guarded); `promoteAfterExit` only calls `promoteNextPending` (scheduler), nothing promotes the current run.
- **`promoteLocalMerge`** (`web/lib/worktree.ts:350-406`) already does `git switch <target>; git merge --no-ff --no-edit <source>` under a per-repo promotion lock; throws `MaisterError("CONFLICT")` + `git merge --abort` on conflict. Re-used as-is.
- **`addWorktree` already supports `startPoint`** (`web/lib/worktree.ts:134`) — `git worktree add -b <br> -- <wt> <startPoint>`. `launchRun` (`web/lib/services/runs.ts:437`) currently passes **no** `startPoint` (worktree forks parent `HEAD`). M18 wires the resolved base commit in. `resolveBaseCommit`, `branchExists`, `listBranches`, `diffRange`, `logRange`, `resolveBaseRef` all exist.
- **NO git push / NO PR creation anywhere.** `web/lib/repo-source.ts` detects provider (`github|gitlab|gitea|gitverse|generic`) but only records it; `cloneRepo` is plain `git clone` (host creds). Phase 3 is greenfield push+PR.
- **Readiness machinery exists (M16).** `getRunReadiness` (`web/lib/queries/readiness.ts:100`) → `ready|blocked|stale|failed|waiting`. `assertEvidenceReady(runId,"review",db)` (`web/lib/flows/graph/evidence-readiness.ts:61`) is enforced **once**, at the Review chokepoint (`runner-graph.ts:1481`). M18 adds a **second** call at promote time (gates can go stale between Review-entry and the promote click). `isExternalGateReady` allow-list = `{passed, overridden}` (`external-gate-readiness.ts:13`). Overridden gates satisfy promotion — that is the "explicitly overridden" path.
- **Branch fields live on `scratch_runs`**, absent from `runs`. `database-schema.md:514` already pre-declares "Planned M18 adds `baseBranch`, `baseCommit`, `targetBranch`, `promotionMode`" to **`workspaces`** — M18 lands them there (the run branch is `workspaces.branch`).
- **`run.status` enum**: `Pending|Running|NeedsInput|NeedsInputIdle|HumanWorking|Review|Crashed|Done|Abandoned|Failed`. **M18 adds NO new status** — both modes terminate at `Done` (see 0.4). This deliberately avoids the new-status fan-out blast radius.
- **Evidence graph (M12)** artifact kinds include `diff` and `commit_set` (`schema.ts:992`); locator `git-range` already resolves diffs (`artifacts/.../payload/route.ts:236`). No `pr_link` kind — M18 reuses `commit_set`/`generic_file` + `pr_url` in the payload (no new artifact kind; see unresolved Q3).
- **i18n**: `web/messages/en.json` + `web/messages/ru.json`. Existing keys: `scratch.diff/promote`, `run.returnedDiff`, `board.mergeBlocked`, `board.colReview`.
- **Migrations**: highest = `0020_m16_api_tokens.sql`. **Next = `0021`.** **Highest ADR = ADR-047. Next = ADR-048** (and ADR-049).
- **Test infra**: `web/vitest.workspace.ts` — project **`unit`** (`lib/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`, `components/**`; node env, mocked I/O) and **`integration`** (`lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts`; Testcontainers Postgres). Scripts: `test:unit` / `test:integration` / `test:e2e` / `typecheck` / `lint`. E2E: seeded dedicated Postgres + stub supervisor; runs are planted at a target status by **direct SQL insert** (the runner graph is not driven live in e2e) — `web/e2e/_seed/seed-e2e.ts` (`seedM16Fixture` plants a run parked at the review node, line 1898).

### 0.3 The current promote route is NOT retry-safe (the core hardening target)

`promote/route.ts` today: loads rows (no `FOR UPDATE`), then calls
`promoteLocalMerge()` **outside any transaction**, then flips `Done` in a tx.
There is **no `SELECT FOR UPDATE`, no terminal-status guard**. Two concurrent
promotes can both pass the `dialogStatus==="Review"` load-time check and both
call the git merge. M18 MUST close this (skill-rule: two-phase commit +
multi-store atomic) for both the existing scratch path and the new flow path. The
fix is a **durable promotion claim** committed before the side-effect (§3.2,
Codex F1), not merely a longer-held row lock.

### 0.4 Decisions taken as defaults (stated, not silently assumed)

- **Terminal status = `Done` for both modes.** `local_merge` success → `Done`
  (matches scratch + `runs.md` state machine). `pull_request` success → `Done`
  with `pr_url`/`pr_number` recorded; MAIster does not track the PR to merge in
  M18 (deferred). Rationale: avoids adding a `runs.status` value and its
  ALL-consumers fan-out (skill-rule), per Simplicity-First. (Confirmed
  2026-06-03.)
- **Readiness re-gate re-uses M16, no M15.** Promote-time refusal calls the same
  `assertEvidenceReady(runId,"review")`; M15's readiness-policy DSL is not a
  blocker. ADR-048 records this carve (parallel to ADR-045's M16/M15/M18 carve).
- **Provider scope for PR mode (confirmed 2026-06-03): all four providers**, via
  a **hybrid** mechanism behind one `PrAdapter` interface: `github`→`gh` CLI,
  `gitlab`→`glab` CLI, `gitea`+`gitverse`→one shared **Gitea-compatible REST
  adapter** (host-env token `GITEA_TOKEN`/`GITVERSE_TOKEN`; API base + owner/repo
  derived from the repo remote). `git push` always uses the host git credential
  helper. `generic` (unknown host) → `PRECONDITION` "PR mode unsupported for
  provider" (local_merge always available). GitVerse's Gitea-API compatibility is
  verified in Phase 3 (fallback: a gitverse path on the same shared adapter).
- **PR-failure errors reuse the closed `MaisterError` union (ADR-008)**:
  `PRECONDITION` (CLI-missing / remote-not-configured / push-rejected-config /
  provider-unsupported / target-invalid / target-drift / readiness-not-ready) →
  HTTP 409; `CONFLICT` (merge conflict / promotion superseded by a stale reclaim)
  → 409; retryable transient push/PR-API 5xx → **`EXECUTOR_UNAVAILABLE` → HTTP
  503** (Codex F7 — the route's `httpStatusForCode` is code-only, so `PRECONDITION`
  can map ONLY to 409; a retryable status needs a distinct retryable code, and
  `EXECUTOR_UNAVAILABLE` is already a member of the closed union). No NEW error code
  (confirmed 2026-06-03 — reuse the closed union; `EXECUTOR_UNAVAILABLE` is a
  member, not an addition).

### 0.5 Scope boundary — this is **M18 only, not M15** (Codex F2)

This plan delivers **M18** (branch targeting, diff review, manual promotion). It
is **not** an M15 plan and must not be read as covering M15. The promote-time
readiness check **reuses the M16 `assertEvidenceReady` chokepoint** — a
deliberate, ADR-045-consistent M18 carve (ADR-048 records it), **not** an
implementation of M15. Explicitly **out of M18 scope** (owned by **M15**, to be
planned separately via `/aif-plan` when scheduled):

- the readiness-policy **DSL** (Flow-declared which gates are required, reusable
  command/skill/capability profiles, default timeout/cost overrides);
- **verdict calibration** (confidence thresholds → readiness state per gate/Flow);
- **`external_check` ingestion semantics** beyond the M16 generic report contract
  (staleness rules over external commits);
- the `ready|blocked|stale|failed|waiting|overridden` readiness summary as an
  M15-policy product (M18 only *reads* the existing M16 summary for display + the
  promote gate).

M18 promotion can therefore ship against **pre-M15 readiness semantics**; that is
intended. When M15 lands, its readiness policy plugs into the same
`assertEvidenceReady` chokepoint M18 already calls — no rework of the promote
path. (If an M15 plan is wanted now, generate it as a separate
`feature-m15-*.md` via `/aif-plan`; do not fold M15 work into this file.)

---

## 1. Deployment wiring (skill-rule: every new env var / runtime dep lands in deploy artifacts)

| New dependency | Lands in |
|----------------|----------|
| **PR-mode deps (model B), per provider** — `github`/`gitlab`: `gh`/`glab` CLI on the web-host PATH (+ host auth: `gh auth` / `GH_TOKEN`,`GITLAB_TOKEN`). `gitea`/`gitverse`: host-env `GITEA_TOKEN`/`GITVERSE_TOKEN` for the Gitea REST API (no CLI). All: host git push credential helper. Required **only** when a run promotes via `pull_request` | `docs/getting-started.md` prerequisites + `docs/configuration.md` (per-provider PR-mode note) + `docs/deployment.md` (amend "No `gh` CLI required") + `.env.example` (`GH_TOKEN`/`GITLAB_TOKEN`/`GITEA_TOKEN`/`GITVERSE_TOKEN` comments, server-only) |
| Migration `0021` (workspaces branch/promotion columns + claim columns incl. `promotion_attempt_id` + legacy backfill) | Drizzle migration committed + `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/db/erd.md` |
| `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` (default 300) — stale-`claiming` reclaim window (Codex F1) | `.env.example` + `docs/configuration.md` env-var table (compose stays Postgres-only per [ADR-023]; host/service-env only) |
| `POST /api/runs/{runId}/promote` now serves **flow** runs; `POST /api/runs` + `POST /api/v1/ext/runs:launch` gain optional `baseBranch`/`targetBranch`; project-scoped **branch-options GET** (existing `GET /api/scratch-runs/launch-options` pattern, reused/extended — Codex F3) consumed by the board launch UI | already on the existing web port (no new port/sidecar) — documented in `docs/api/web.openapi.yaml` + `docs/api/external/operations.openapi.yaml` |

**Compose skew, documented (skill-rule):** PR mode runs in the **web tier** (the
Next.js promote route shells `gh`/`glab` *or* calls the Gitea API, plus
`git push`). Per [ADR-023] the default compose stays Postgres-only and does NOT
provision provider CLIs, API tokens, or push credentials in the web container —
PR promotion is a **host-operator concern**. Phase 0/3 adds an explicit "Not
provisioned in the default compose — per the run's provider the operator must
supply `gh`/`glab` on PATH (github/gitlab) or `GITEA_TOKEN`/`GITVERSE_TOKEN` env
(gitea-family), plus a git push credential helper; `local_merge` needs none"
note to `getting-started.md` + `configuration.md`. No silent dev/prod skew. **No new bound port, no new sidecar binary, no Dockerfile change.**

---

## 2. Contract-surface → spec-file map (skill-rule: trace every contract surface)

| Surface | Spec file(s) |
|---------|--------------|
| `POST /api/runs` body gains optional `baseBranch`,`targetBranch` (validated, server-allow-listed) | `docs/api/web.openapi.yaml` (`PostRunBody`) + `docs/system-analytics/workspaces.md` |
| `POST /api/v1/ext/runs:launch` body gains optional `baseBranch`,`targetBranch` (M16 acceptance: "…including base branch and target branch once branch targeting lands") | `docs/api/external/operations.openapi.yaml` (`ExtLaunchRunBody`) |
| **Branch-options GET** consumed by the board launch UI — session-authed, project-read-scoped branch listing (reuse/extend `GET /api/scratch-runs/launch-options` or a project-scoped `GET /api/projects/{slug}/branches`; Codex F3) | `docs/api/web.openapi.yaml` (the chosen route + `BranchOptions` response) + `docs/system-analytics/workspaces.md` |
| `POST /api/runs/{runId}/promote` now serves flow runs; `pull_request` mode now implemented; body gains `reviewedTargetCommit`+`allowTargetDrift?` (Codex F6 drift guard); response carries `pullRequestUrl`+`prNumber` | `docs/api/web.openapi.yaml` (`PromoteRunBody`/`PromoteRunResponse`, remove "returns CONFIG", add `503`) + `docs/system-analytics/workspaces.md` + `runs.md` |
| `runs.status` `Review → Done` via flow-run promotion (no new enum value) | `docs/system-analytics/runs.md` state machine |
| `workspaces` new columns `base_branch`,`base_commit`,`target_branch`,`promotion_mode`,`pr_url`,`pr_number`,`promoted_at` + claim columns `promotion_state`,`promotion_claimed_at`,`promotion_owner_user_id`,`promotion_attempt_id` (Codex F1/F5) | `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/db/erd.md` |
| PR / promotion diff artifact (`commit_set`/`diff` kind + `pr_url` payload) | `docs/system-analytics/artifacts.md` |
| Provider PR creation now invoked — `gh`/`glab` CLI (github/gitlab) **and** Gitea REST API (gitea/gitverse) — reverses a documented invariant | `docs/system-analytics/git-integration.md` ("gh is NEVER invoked" → conditional provider PR calls) + `docs/system-analytics/instance-config.md` (gh/glab + Gitea-API token: informational → required-for-PR) |
| Promotion error codes (caller rows; no new code — ADR-008) | `docs/error-taxonomy.md` (`CONFLICT`,`PRECONDITION`,`EXECUTOR_UNAVAILABLE` retryable→503 — Codex F7) |
| Design rationale | `docs/decisions.md` **ADR-048** (branch targeting + shared promotion + promote-time readiness carve) + **ADR-049** (PR mode via host `gh`/`glab`, model B, provider dispatch, idempotent PR, invariant reversal) |
| No new SSE event | `docs/api/async/web-runs.asyncapi.yaml` UNCHANGED — the stream already closes on `runs.status→Done`; verify, do not add an event. |

*Roadmap ownership boundary (rule #9): this plan does NOT edit `ROADMAP.md`. The
M18 checkbox flip is done via `/aif-roadmap` at milestone close.*

---

## 3. Decisions (skill-mandated checklists)

### 3.1 Identifiers per route (skill-rule: body-controlled vs server-state)

| Route | Identifier | Label | Handling |
|-------|-----------|-------|----------|
| `POST /api/runs`, ext launch | `taskId` | body-controlled | existing — resolves task→project (server-state) |
| same | `baseBranch`, `targetBranch` | **body-controlled** | **MUST** be validated against `listBranches(project.repoPath)` (server-state allow-list) BEFORE any use as a git ref / `startPoint`. Unknown branch → `PRECONDITION`. Never interpolate into a shell; pass as array args + `--end-of-options`. |
| `POST /api/runs/{runId}/promote` | `runId` | url-param | trusted via route shape + `requireProjectAction(run.projectId,"promoteRun")` |
| same | `mode` | body-controlled | enum allow-list `{local_merge,pull_request}` |
| same | `targetBranch` (override) | **body-controlled** | validated against `listBranches`; for flow runs may differ from base (relaxes scratch's `assertPromotionTargetAllowed`); default = `workspace.target_branch` (server-state). |
| same | `reviewedTargetCommit` | **body-controlled** | the target HEAD the ReviewPanel rendered against; compared to the live `resolveBaseCommit(target)` at claim time (optimistic concurrency). Drift (mismatch) → `PRECONDITION` unless `allowTargetDrift` (Codex F6, §3.7). Validated as a commit-sha shape; never shell-interpolated. A non-UI caller that omits it is refused `PRECONDITION` (never promoted blind). |
| same | `allowTargetDrift` | **body-controlled** | boolean override (default false); set only by an explicit "Promote anyway" after the panel shows drift. |
| **branch-options GET** (Codex F3) | `slug`/`projectId` | url-param / query | **MUST** require an active session FIRST (`requireActiveSession`), then resolve `project` from the id (server-state) and authorize project-read BEFORE calling `listBranches` — never an unauthenticated repo-metadata lookup. Tests cover unauth → 401, wrong/forbidden project → 404, authorized → branch list. |

`projectId`, `repoPath`, `provider`, `workspace.branch`, base/target stored at
launch are all **server-state** — derived, never trusted from the promote body.

### 3.2 Two-phase commit + failure classification (skill-rule)

**Order of operations for `promoteRun` — durable claim → side-effect → finalize
(Codex F1 hardening).** A held row lock cannot span the slow git/PR side-effect
(it would be a long transaction around external calls); and committing the guard
*before* the side-effect would release the lock while the run is still `Review`,
so a concurrent promote could pass the same guard and duplicate the merge/PR. The
serialization point is therefore a **durable promotion claim committed BEFORE any
side-effect** — not the row lock. The claim lives on `workspace.promotion_state`
(`none|claiming|done|failed`, workspace is 1:1 with the run, so a per-row CAS is
race-safe without a partial index):

1. **Claim tx (short; commits BEFORE any side-effect):** `BEGIN; SELECT … FOR
   UPDATE` on the **workspace**. Assert, in this tx: run terminal allow-list
   (flow `runs.status="Review"` / scratch `dialogStatus="Review"`); readiness
   (`assertEvidenceReady(runId,"review")`, flow) — not ready → `PRECONDITION` 409,
   no claim, run stays `Review`; **target-drift guard (Codex F6, §3.7)** — unless
   `allowTargetDrift`, `reviewedTargetCommit` MUST equal the live
   `resolveBaseCommit(target_branch)`; drift → `PRECONDITION` 409 ("target advanced
   since review"), no claim, run stays `Review`; **no active claim**
   (`promotion_state ∈ {none, failed}`, OR `claiming` whose `promotion_claimed_at`
   is older than `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` ⇒ reclaimable after a
   crash). Then **mint a fresh `promotion_attempt_id` (opaque token, e.g.
   `crypto.randomUUID()`)** and CAS `promotion_state→'claiming'` + set
   `promotion_attempt_id=<fresh token>`, `promotion_claimed_at=now`,
   `promotion_owner_user_id`, `promotion_mode`, `target_branch`. A stale reclaim
   **overwrites** `promotion_attempt_id` with its own fresh token, so the superseded
   attempt can no longer finalize (Codex F5). `COMMIT`. The request keeps its minted
   token in memory for step 3. A concurrent promote loses the CAS (a fresh
   `claiming` already present) → **409 `CONFLICT`** ("promotion already in
   progress"). **No DB lock is held past this commit.**
2. **Side-effects (NO open transaction, NO lock held):** target validation
   (`targetBranch ∈ listBranches`, `branchExists`); then mode-specific:
   - `local_merge`: `promoteLocalMerge(target, source)`. Conflict → `git merge
     --abort` + `createMergeConflictAssignment`; the finalize tx sets
     `promotion_state='failed'`, run stays `Review` (retryable).
   - `pull_request`: provider preflight (github/gitlab: `gh`/`glab` on PATH;
     gitea/gitverse: `*_TOKEN` env + API reachable; all: remote configured;
     `generic`: unsupported → `PRECONDITION`) → `pushBranch` →
     `PrAdapter.createOrUpdatePr`. Idempotent by stored `workspace.pr_url`: if set
     → **update** the existing PR (push commits), never create a duplicate.
3. **Finalize tx (single multi-store transaction):** `SELECT … FOR UPDATE` on the
   workspace; **assert `promotion_state='claiming'` AND `promotion_attempt_id =
   <this request's minted token>` (Codex F5)** — if the token no longer matches (a
   same-user stale reclaim replaced it while this slow side-effect ran), this
   attempt was **superseded**: write NOTHING (no `Done`, no `pr_url`, no `failed`)
   and return **409 `CONFLICT`** ("promotion superseded by a newer attempt"); the
   newer attempt owns finalization. On match, every CAS below carries `… WHERE
   promotion_attempt_id = <token>`: CAS `promotion_state→'done'`, `runs.status→Done`,
   `endedAt=now`, clear `acpSessionId`/`currentStepId`; workspace
   `promoted_at`+`pr_url`+`pr_number`; `systemCloseActiveAssignmentsForRun`;
   `scheduledRemovalAt` (GC); record the promotion `diff`/`commit_set` artifact.
   Terminal-config failure (conflict / preflight) → CAS `promotion_state→'failed'`
   (token-matched, reclaimable), run stays `Review`. Transient failure (push /
   PR-API 5xx) → leave `promotion_state='claiming'` (a same-attempt retry resumes;
   a stale claim past the timeout is reclaimable). **The idempotency markers
   (`promotion_state`, `pr_url`, `promoted_at`) are AFTER-side writes** — never set
   before the side-effect succeeds. The attempt-token CAS prevents a **double
   finalize**; the stored `pr_url` + provider query (§3.3) prevent a **double
   side-effect** — the two mechanisms compose.

The CAS on `workspace.promotion_state` keyed by `promotion_attempt_id` (not a held
row lock) is the single serialization point. **Mandatory integration tests:** (a)
two concurrent `promoteRun` calls on the same run yield exactly ONE side-effect
(one `Done`, one `409 CONFLICT`; the git/PR spy is invoked once); (b) **same-user
stale-reclaim (Codex F5):** the original (slow) attempt finishes its side-effect
AFTER a same-user reclaim past the timeout has re-minted the token — the original
finalize matches no token, is refused `409 CONFLICT`, and writes neither `Done` nor
`pr_url`; the reclaiming attempt finalizes exactly once.

**Failure classification table:**

| Failure | HTTP | Run row | Retry behavior |
|---------|------|---------|----------------|
| Already `Done`/non-`Review` (retry after success) | 409 | unchanged | terminal — no re-attempt |
| Concurrent promote (fresh active `claiming`) | 409 `CONFLICT` | unchanged | wait for the in-flight promotion |
| Readiness not ready/stale | 409 `PRECONDITION` | stays `Review` (no claim) | retry after gate passes/overridden |
| Target advanced since review (drift, no override — Codex F6) | 409 `PRECONDITION` | stays `Review` (no claim) | re-review the updated diff, then `allowTargetDrift` |
| Target branch invalid/missing | 409 `PRECONDITION` | stays `Review` | retry with valid target |
| `local_merge` conflict | 409 `CONFLICT` | stays `Review` + conflict assignment | human resolves, returns via assignment path |
| PR preflight (gh/glab missing on PATH OR `*_TOKEN` unset for gitea-family / remote unset / `generic` provider) | 409 `PRECONDITION` | stays `Review` | fix host, retry |
| `push` rejected / PR-API 5xx (transient — Codex F7) | **503 `EXECUTOR_UNAVAILABLE`** | stays `Review`, **no `pr_url`** | retry; idempotent |
| Finalize superseded by a same-user stale reclaim (Codex F5) | 409 `CONFLICT` | unchanged by the superseded attempt | the reclaiming attempt owns finalize |
| Crash AFTER claim, BEFORE finalize tx | — | stays `Review`, `promotion_state='claiming'` | reclaimable past `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` (§3.3) |

### 3.3 Multi-store atomicity + crash windows (skill-rule)

The claim tx (step 1) and the finalize tx (step 3) are each **one transaction**,
so neither leaves a torn multi-store state (no status flipped with an assignment
still open, no `pr_url` stored with status still `Review`). The crash window is
**between the claim commit (step 1) and the finalize commit (step 3)** — a
durable `promotion_state='claiming'` row with the side-effect possibly already
done. Recovery is **the durable claim + an idempotent side-effect + a timeout
reclaim**, NOT a held lock:

- `local_merge`: target may already have the `--no-ff` merge commit, run still
  `Review`, `promotion_state='claiming'`. Recovery: once the claim is older than
  `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` a re-promote reclaims it; the re-merge
  of an already-merged source is a no-op/`Already up to date`, then it finalizes
  `Done`. Regression test for this window.
- `pull_request`: PR created/pushed but `pr_url` not yet stored,
  `promotion_state='claiming'`. Recovery: the reclaiming re-promote's
  `createOrUpdatePr` detects the existing PR for `(run branch → target)` via the
  provider (`gh pr list --head` / `glab mr list` / Gitea `GET …/pulls`) and
  **updates instead of duplicating**, then finalizes. The `pr_url`/`promoted_at`
  markers are AFTER-side, so a crash never strands a half-recorded PR that
  duplicates on retry. Regression test: "PR exists upstream, `pr_url` unset,
  claim stale → re-promote updates, single PR".

No reconcile-sweep change is required (the run is left in `Review`, a valid
holding state owned by the user via the review surface, not a stranded
`Running`). A stale `claiming` claim is reclaimed lazily by the next promote
attempt, which **re-mints `promotion_attempt_id`** (Codex F5) — so even if the
crashed/slow original attempt later resumes, its finalize CAS no longer matches and
is refused; no background sweeper is added.

### 3.4 Config-state symmetry for `promotion_mode` (skill-rule: YAML→DB SET/CLEAR/re-set)

`workspaces.promotion_mode` is resolved at launch from the override chain
(launch override > project `promotion.mode` > default `local_merge`). It is a
per-run snapshot, not a live-synced column, so the SET/CLEAR/re-set loop applies
to the **resolution**, not a reconciliation:
1. SET: launch with `promotion.mode: pull_request` in config → column = `pull_request`.
2. CLEAR: config field removed → next launch column = default `local_merge`.
3. Re-set: re-added → column = `pull_request` again.
All three are unit-tested in Phase 1 (the resolver), not deferred.

### 3.5 New-route / state-change consumer fan-out (skill-rule, allow-list guards)

Promotion changes run state and adds a route surface. Even though **no new
`runs.status` value** is introduced (terminal stays `Done`), enumerate every
consumer of "flow run reached/left Review" and "promotion happened":

| Consumer | Update |
|----------|--------|
| Board read model (`web/lib/queries/board.ts`) | Surface a "ready-to-promote / PR #N" indicator alongside the existing `mergeBlocked`; verify `Done` removal from In-Flight |
| Portfolio/home read model (`web/lib/queries/portfolio.ts`) | Same terminal handling for flow promotion as scratch; verify no capacity-slot leak (promote frees the slot via `Done`) |
| Scheduler / cap | `Done` already frees a slot + `promoteNextPending`; verify flow promote honors it |
| Promote guard | **allow-list** `status ∈ {Review}` (flow) — NOT `if (!terminal)`; a future status is rejected by default |
| Readiness guard | allow-list `gate ∈ {passed, overridden}` (reuse `isExternalGateReady`) |
| API spec | promote-serves-flow + launch branch fields land in OpenAPI in the SAME change (Phase 0) |
| Audit/ledger | promote attributes actor + mode + target; PR records `pr_url`/`pr_number` |

### 3.6 Legacy-row compatibility — pre-M18 workspaces with null branch metadata (Codex F4)

Migration `0021` adds the branch/promotion columns **nullable**, so workspaces
(and their `Review` runs) created before M18 have null `base_branch`/
`base_commit`/`target_branch`/`promotion_mode`. The later promote service and
`ReviewPanel` must NOT assume these are present (else: late promote failure,
broken review UI, or nulls passed into git/diff helpers). Two-layer handling:

1. **Migration backfill (derivable fields):** in `0021`, backfill existing
   workspace rows — `promotion_mode := <project default ?? 'local_merge'>` and
   `target_branch := <project default_branch>`. `base_branch`/`base_commit` are
   historically unknowable and stay null.
2. **Code-path fallback / explicit refusal:** the promote service and
   `ReviewPanel` derive safe fallbacks at read time — `targetBranch :=
   override ?? workspace.target_branch ?? project.default_branch`; the diff base
   `:= resolveBaseRef(project.default_branch, workspace.branch)` (M11b, already
   exists); `promotion_mode := workspace.promotion_mode ?? project default`. If a
   required value genuinely cannot be derived, **refuse with a typed
   `PRECONDITION`** ("legacy run lacks branch metadata — relaunch to promote"),
   never a silent null into git. Mandatory integration test: a pre-M18 `Review`
   run with null branch metadata → promote either derives the fallback and
   succeeds OR returns `PRECONDITION` (assert both paths; never an unhandled
   null).

### 3.7 Target-branch drift gate — promote against the reviewed target HEAD (Codex F6)

The reviewer approves a `base→run→target` surface computed against whatever the
target branch pointed at **when the ReviewPanel rendered**. Between that render and
the Promote click the target can advance (another run merged into it). The plan
records `base_commit` and validates only that the target branch still *exists*, so
a clean-but-semantically-stale merge into a moved target would pass silently, and
the readiness evidence would be outdated relative to the merge result. M18 closes
this with **optimistic concurrency on the target HEAD** — no new column; promote is
UI-only (resolved-decision #6), so there is no programmatic promote consumer to
break:

1. The `ReviewPanel` server-render resolves the live target HEAD
   (`resolveBaseCommit({projectRepoPath, baseRef: target_branch})`) and embeds it in
   the promote form as `reviewedTargetCommit`.
2. The promote claim tx (§3.2 step 1) re-resolves the live target HEAD and asserts
   it equals `reviewedTargetCommit`. Mismatch → **`PRECONDITION` 409 ("target
   advanced since review — re-review or override")**, no claim, run stays `Review`.
3. Override path: an explicit "Promote anyway" sets `allowTargetDrift: true`, which
   skips the equality assertion (the user has chosen to merge into the moved
   target). The override is a deliberate human action, never a default.
4. On a drift refusal the panel re-fetches and re-renders against the new target
   HEAD, so the user sees the updated diff before deciding.

`local_merge` still catches *textual* conflicts independently; this gate adds the
**semantic** protection (a clean merge into an unexpected target state) and keeps
the readiness evidence honest. **Mandatory tests (Codex F6):** target advances
between Review and promote → promote refused `PRECONDITION`; the same call with
`allowTargetDrift` → succeeds — asserted for **both** `local_merge` and (mocked)
`pull_request`. There is no null path for `reviewedTargetCommit` (the panel always
supplies it from the live render); a body that omits it (non-UI caller) is refused
`PRECONDITION` rather than promoted blind.

---

## Phase 0 — Spec freeze (docs-first SDD; NO code)

**Exit gate:** all artifacts below complete, internally consistent, tagged
(`Designed` where the code lands later this milestone); `pnpm validate:docs:all`
(mermaid) green; `npx @redocly/cli lint docs/api/web.openapi.yaml` and
`docs/api/external/operations.openapi.yaml` lint-clean; adversarial reviewer
confirms the spec set is the single source of truth the code phases can follow.

- **T0.1 — ADR-048 + ADR-049.** `docs/decisions.md`.
  - ADR-048 "Branch targeting at launch, shared promotion service, promote-time
    readiness re-gate (M18/M15 carve)": workspace ledger columns; shared
    `promoteRun` over both run kinds; reuse M16 `assertEvidenceReady` at promote
    time (no M15 dep); terminal stays `Done` (no new status); two-phase +
    idempotency contract from §3.2.
  - ADR-049 "PR promotion via a hybrid provider `PrAdapter` (credential model B);
    reverses the 'gh is never invoked' invariant": dispatch on `projects.provider`
    — `github`→`gh` CLI, `gitlab`→`glab` CLI, `gitea`+`gitverse`→one shared
    Gitea-compatible REST adapter (host-env token), `generic`→unsupported;
    per-provider preflight; idempotent PR by stored `pr_url` (+ provider query as
    crash-window fallback); model-C credential storage explicitly deferred.
    Logging: DEBUG on each ADR-referenced decision point (never log tokens).
- **T0.2 — system-analytics.** Rewrite `workspaces.md` (base/target/promotion-mode
  domain entities, Promote-on-Review for flow runs, `local_merge` **and** PR
  sequence diagrams, state machine, concurrent-promote edge case from §3.2-3.3);
  update `runs.md` (flow `Review→Done` promotion path, promote-time readiness
  gate); `git-integration.md` (conditional `gh`/`glab` invocation, reverse the
  "NEVER invoked" line); `instance-config.md` (`gh`/`glab` informational →
  required-for-PR); `artifacts.md` (promotion diff/PR artifact). All per docs R5,
  tagged `Designed`.
- **T0.3 — DB ERD + narrative.** Add `base_branch,base_commit,target_branch,
  promotion_mode,pr_url,pr_number,promoted_at` **plus the claim columns
  `promotion_state,promotion_claimed_at,promotion_owner_user_id,
  promotion_attempt_id` (Codex F1/F5)** to `WORKSPACES` in `docs/db/runs-domain.md`
  AND `docs/db/erd.md` (both — skill-rule) AND the `docs/database-schema.md`
  narrative (flip the "Planned M18" para to the column list + the durable-claim +
  attempt-token note, tagged `Designed` until Phase 1 HEAD).
- **T0.4 — OpenAPI (both specs).** `web.openapi.yaml`: `PostRunBody`
  +`baseBranch?`/`targetBranch?`; `PromoteRunBody` +`reviewedTargetCommit`
  +`allowTargetDrift?` (Codex F6 drift guard) / `PromoteRunResponse` (PR fields
  + remove "returns CONFIG"); promote description = serves flow + scratch;
  **document the `503` retryable response (`EXECUTOR_UNAVAILABLE`, Codex F7)
  alongside `409`**; **the branch-options GET route + `BranchOptions` response
  (Codex F3)** with its session/project-read security requirement.
  `external/operations.openapi.yaml`: `ExtLaunchRunBody`
  +`baseBranch?`/`targetBranch?`. Redocly lint green.
- **T0.5 — error-taxonomy.** `docs/error-taxonomy.md`: add promote/PR caller rows
  to `CONFLICT` (merge conflict / promotion superseded by a stale reclaim — Codex
  F5), `PRECONDITION` (CLI-missing / remote-unset / provider-unsupported /
  push-rejected-config / target-invalid / target-drift / readiness-not-ready), and
  **`EXECUTOR_UNAVAILABLE` (retryable transient push/PR-API 5xx → 503, Codex F7 —
  add the `EXECUTOR_UNAVAILABLE→503` case to the route's `httpStatusForCode`)**;
  state the no-new-code decision (ADR-008 closed union — `EXECUTOR_UNAVAILABLE` is
  an existing member, not an addition).
- **T0.6 — configuration / getting-started / deployment / .env.example.** Flip
  `promotion.mode`/`promotion.remote` from "Planned M18" → Implemented (Designed
  tag until Phase 3 HEAD); add the `gh`/`glab` PATH + push-credentials
  prerequisite and the **compose-skew note** from §1; `.env.example` optional
  `GH_TOKEN`/`GITLAB_TOKEN`/`GITEA_TOKEN`/`GITVERSE_TOKEN` comments (server-only,
  never logged) + `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` (default 300, Codex
  F1) in the `configuration.md` env-var table.

---

## Phase 1 — Branch targeting at launch (TDD)

**Exit gate:** typecheck 0; `test:unit` + `test:integration` green; existing
launch tests migrated; e2e unaffected; Phase-1 doc tags flipped
Designed→Implemented (DB ERD + launch OpenAPI).

- **T1.1 — (RED) tests.** Name + place exactly:
  - unit `web/lib/services/__tests__/runs-launch-branch.test.ts`: default
    resolution (base=`default_branch`, target=base); `promotion_mode` resolver
    SET/CLEAR/re-set (§3.4); unknown base/target rejected via `listBranches`
    allow-list (mocked) → `PRECONDITION`; `startPoint` passed to `addWorktree`
    (spy).
  - unit `web/app/api/runs/__tests__/post-branch.test.ts`: body schema accepts
    optional `baseBranch`/`targetBranch`; ext-launch passthrough.
  - unit `web/app/api/.../branch-options/__tests__/route.test.ts` (Codex F3):
    **unauthenticated → 401**, authenticated-but-forbidden project → 404,
    authorized → branch list; assert `listBranches` is reached only AFTER
    session + project-read authz.
  - integration `web/app/api/runs/__tests__/launch-branch.integration.test.ts`
    (matches `app/**/*.integration.test.ts`): real DB — workspace row persists
    `base_branch`/`base_commit`/`target_branch`/`promotion_mode`; ext launch
    with branch fields.
- **T1.2 — Migration `0021_m18_workspace_branch_promotion.sql`.** Additive:
  `workspaces` += `base_branch text`, `base_commit text`, `target_branch text`,
  `promotion_mode text`, `pr_url text`, `pr_number integer`, `promoted_at
  timestamp` (all nullable; PR cols populated Phase 3) **+ claim columns (Codex
  F1/F5): `promotion_state text NOT NULL DEFAULT 'none'`
  (`none|claiming|done|failed`), `promotion_claimed_at timestamp`,
  `promotion_owner_user_id text` (FK users, nullable), `promotion_attempt_id text`
  (nullable; the per-attempt CAS-identity token, §3.2)**. **Legacy backfill (Codex
  F4): `UPDATE workspaces SET promotion_mode = <project default ?? 'local_merge'>,
  target_branch = <project default_branch> WHERE promotion_mode IS NULL`**
  (`base_branch`/`base_commit` stay null — historically unknowable, handled by the
  §3.6 code fallback). Update `schema.ts`. DEBUG log on column population.
- **T1.3 — launchRun service.** `web/lib/services/runs.ts`: `LaunchRunInput`
  +`baseBranch?`/`targetBranch?`; resolve defaults; **validate both against
  `listBranches(project.repoPath)` (server-state allow-list) BEFORE worktree**
  (§3.1); `resolveBaseCommit(base)` → record; pass `startPoint=baseCommit` to
  `addWorktree`; resolve `promotion_mode` via the override chain (§3.4); persist
  branch/promotion columns on workspace insert. Verbose DEBUG: resolved base/
  target/commit/mode.
- **T1.4 — route + ext route.** `web/app/api/runs/route.ts` body schema
  +`baseBranch`/`targetBranch`; `web/app/api/v1/ext/runs/launch/route.ts` (M16 ext
  launch) same; thread through the shared service; audit attribution unchanged.
- **T1.5 — Board launch UI.** Convert `web/components/board/launch-button.tsx`
  one-click button → a compact `LaunchPopover` (default one-click preserved;
  "Advanced" disclosure → base-branch select + optional target-branch select,
  mirroring `web/components/scratch/scratch-launcher.tsx` branch pill). Branch
  options come from the **existing session-authed source** `GET
  /api/scratch-runs/launch-options` (`requireActiveSession` + `listBranches`),
  reused/extended (or a project-scoped `GET /api/projects/{slug}/branches` twin
  with the same auth) — **never a new unauthenticated branch lookup** (Codex F3);
  the route is in `web.openapi.yaml` (T0.4) with the auth tests (T1.1). i18n EN+RU
  (`run.baseBranch`, `run.targetBranch`, `launch.advanced`).
- **T1.6 — (GREEN) + doc-tag flip.** Make the suite green; migrate any launch
  tests whose assertions the new fields touch; flip Phase-1 doc tags.

---

## Phase 2 — Shared promotion service + flow-run `local_merge` + promote-time readiness gate (TDD)

**Exit gate:** typecheck 0; full suite green; the 8 existing scratch promote
tests stay green (regression pin); Phase-2 doc tags flipped.

- **T2.1 — (RED) tests.**
  - unit `web/lib/runs/__tests__/promote-service.test.ts`: terminal allow-list
    guard (non-`Review` flow → 409); readiness-not-ready → `PRECONDITION`, **git
    spy NOT called**; **target-drift (`reviewedTargetCommit` ≠ live HEAD) →
    `PRECONDITION`, git spy NOT called; `allowTargetDrift` bypasses (Codex F6)**;
    **finalize attempt-token mismatch → `CONFLICT`, no `Done`/`pr_url` write (Codex
    F5)**; idempotent re-promote (already `Done` → 409); conflict →
    `createMergeConflictAssignment` + stays `Review`; scratch path unchanged
    (dispatch).
  - integration `web/app/api/runs/[runId]/__tests__/promote-flow.integration.test.ts`
    (**real worktree + real DB**): flow run at `Review` →
    `local_merge` → `Done`, target has `--no-ff` commit; custom target ≠ base
    allowed; conflict → assignment + `promotion_state='failed'` + stays `Review`;
    **two-racer** concurrent promote → exactly ONE side-effect (one `Done`, one
    409 `CONFLICT`, git/PR spy invoked once — Codex F1); **stale-claim reclaim** (a
    `claiming` workspace past `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` →
    re-promote reclaims + finalizes `Done`, no duplicate, §3.3); **same-user
    stale-reclaim double-finalize refusal (Codex F5):** the original slow attempt
    finalizes AFTER a same-user reclaim re-minted `promotion_attempt_id` → original
    refused `409 CONFLICT`, no second `Done`, side-effect not re-finalized;
    **target-drift (Codex F6):** target branch advances between Review and promote →
    promote refused `PRECONDITION`; the same call with `allowTargetDrift` → `Done`;
    **legacy row** (pre-M18 `Review` run, null branch metadata) → derive-fallback
    success OR typed `PRECONDITION` (Codex F4, §3.6).
  - keep `web/app/api/runs/[runId]/promote/__tests__/route.test.ts` green (scratch
    regression).
- **T2.2 — Shared service + durable claim.** Extract `web/lib/runs/promote.ts`
  `promoteRun(runId, {mode, targetBranch?, reviewedTargetCommit, allowTargetDrift?},
  ctx)`; the route dispatches on `runKind`. Implement the **durable promotion
  claim** (§3.2, Codex F1/F5): claim tx asserts terminal allow-list + readiness +
  **target-drift guard (`reviewedTargetCommit` vs live HEAD unless
  `allowTargetDrift` — Codex F6)**, then **mints a fresh `promotion_attempt_id`**
  and CAS `workspace.promotion_state {none|failed|stale}→claiming` (committed
  **before** any side-effect) → side-effects with no lock held → finalize tx **keyed
  on `promotion_attempt_id`** `claiming→done`/`failed` (token mismatch → `CONFLICT`,
  write nothing — Codex F5). Concurrency serialized by the attempt-id claim CAS, not
  a held `SELECT FOR UPDATE`. Legacy-row fallback per §3.6.
- **T2.3 — Promote-time readiness.** Call `assertEvidenceReady(runId,"review")`
  for flow runs after the lock, before git (§3.2 step 2); overridden gates count
  via the `{passed,overridden}` allow-list. Verbose DEBUG: readiness verdict +
  blocking reasons.
- **T2.4 — Two-phase finalize + artifact.** Implement §3.2 steps 3-5 as the
  ordered side-effect → single finalize tx; record the promotion `diff`/
  `commit_set` artifact (`recordArtifact`, locator `git-range` base→run). Relax
  `assertPromotionTargetAllowed` for flow runs (validated target may differ from
  base). Enumerate the crash-window recovery (§3.3) in code comments (WHY-only).
- **T2.5 — Consumer fan-out (§3.5).** Board + portfolio read models reflect flow
  promotion → `Done` + a ready-to-promote indicator; verify slot release +
  `promoteNextPending`.
- **T2.6 — (GREEN) + i18n + doc-tag flip.**

---

## Phase 3 — `pull_request` promotion mode (model B: hybrid gh/glab CLI + Gitea API) (TDD)

**Exit gate:** typecheck 0; full suite green (the provider boundary — `gh`/`glab`
exec AND the Gitea-API `fetch` — is **mocked** in CI; live `gh`/`glab` push+PR
and a live Gitea/GitVerse PR are exercised only in manual verification, logged
explicitly per skill-rule "no silent caps"); Phase-3 doc tags flipped.

- **T3.1 — (RED) tests** `web/lib/runs/__tests__/promote-pr.test.ts` +
  `web/lib/runs/__tests__/pr-adapter.test.ts` (the `child_process` exec boundary
  AND the Gitea-API `fetch` both mocked): dispatch over all four providers —
  github→`gh` CLI, gitlab→`glab` CLI, gitea+gitverse→Gitea REST adapter,
  `generic`→`PRECONDITION` unsupported; per-provider preflight failure (gh/glab
  missing on PATH OR `*_TOKEN` unset → `PRECONDITION`); happy path per provider →
  `push` + create PR → `pr_url`/`pr_number` + `Done` + PR artifact; **idempotent
  re-promote updates the same PR** (existing `pr_url` → update, single PR);
  **retryable-vs-config split (Codex F7): `remote unset` → `PRECONDITION`/HTTP 409,
  but push-rejected / PR-API 5xx → `EXECUTOR_UNAVAILABLE`/HTTP 503** — assert BOTH
  the code AND the mapped status via `httpStatusForCode`; stays `Review`, no
  `pr_url`; crash-window (PR upstream exists, `pr_url` unset) → re-promote detects
  (provider query) + updates, no duplicate (§3.3).
- **T3.2 — push + `PrAdapter` interface.** `web/lib/worktree.ts`:
  `pushBranch(repoPath, remote, branch)` (host git creds). New
  `web/lib/runs/pr-adapter.ts`: a `PrAdapter` interface
  `createOrUpdatePr({repoPath, remote, sourceBranch, targetBranch, title, body})
  → {url, number}` with three implementations selected by `projects.provider`:
  `GhCliAdapter` (`gh pr create` / `gh pr list --head`), `GlabCliAdapter`
  (`glab mr create` / `glab mr list --source-branch`), and `GiteaApiAdapter`
  (gitea+gitverse — `GET`/`POST /api/v1/repos/{owner}/{repo}/pulls`, API base +
  owner/repo derived from the remote URL, bearer `GITEA_TOKEN`/`GITVERSE_TOKEN`).
  **Hardened**: CLI via array args + `--end-of-options` (no shell interpolation);
  API via typed `fetch`; never log tokens / credentials / secret-bearing URLs.
  Per-provider preflight. **Verify GitVerse Gitea-API compatibility here**
  (fallback: a `gitverse` branch on the shared `GiteaApiAdapter`).
- **T3.3 — promoteRun PR branch.** Wire the PR side-effect into `promoteRun`
  (§3.2 step 4 `pull_request` + step 5 PR finalize). Idempotency by stored
  `workspace.pr_url`; failure classification table (§3.2) — terminal-config →
  `PRECONDITION` 409, transient → **`EXECUTOR_UNAVAILABLE` 503 (Codex F7); add the
  `EXECUTOR_UNAVAILABLE→503` case to the route `httpStatusForCode`**.
- **T3.4 — error-taxonomy finalize + PR artifact.** Flip the Phase-0 `Designed`
  taxonomy rows → Implemented; record the PR as a `commit_set`/`generic_file`
  artifact carrying `pr_url`/`pr_number` in the payload (no new artifact kind —
  Q3).
- **T3.5 — (GREEN) + doc-tag flip + skew note.** Flip `git-integration.md` /
  `instance-config.md` / `deployment.md` / `configuration.md` PR rows to
  Implemented; the plan's manual-verification note records that live `gh`/`glab`
  push+PR was (or must be) exercised outside CI on a real remote.

---

## Phase 4 — Review surface UI + conflict handoff + e2e (TDD)

**Exit gate:** typecheck 0; full suite green; `m18` Playwright e2e green
(authed, seeded).

- **T4.1 — (RED) component + e2e specs.** unit
  `web/components/runs/__tests__/review-panel.test.tsx`
  (`renderToStaticMarkup`, no jsdom — per repo testing convention): renders
  base→run→target, readiness summary, raw diff, "Promote to `<target>`" naming
  the exact target; **emits the live target HEAD as `reviewedTargetCommit` in the
  promote form, and on a `PRECONDITION` "target advanced" refusal shows the drift
  warning + an explicit "Promote anyway" (`allowTargetDrift`) (Codex F6)**;
  conflict → assignment card. e2e
  `web/e2e/m18-branch-promotion.spec.ts` + `seedM18Fixture` in
  `web/e2e/_seed/seed-e2e.ts` (direct-SQL plant a flow run at `Review` with
  workspace base/target set): diff visible → promote (`local_merge`) → `Done`;
  conflict path → assignment; PR-mode display with a pre-seeded `pr_url`
  (exec not run in CI). Register in `playwright.config.ts` authed project.
- **T4.2 — `ReviewPanel`.** New `web/components/runs/review-panel.tsx` rendered
  from `web/app/(app)/runs/[runId]/page.tsx` when `status==="Review"` &&
  `runKind==="flow"`: base branch, base commit, run branch (`workspace.branch`),
  target branch, promotion-mode selector (`local_merge|pull_request`), readiness
  summary (`getRunReadiness`), raw diff (`diffRange`), returned takeover diffs,
  "Promote to `<target>`" action → `POST promote`. Final action label names the
  exact target. **Target-drift guard (Codex F6, §3.7):** the server render resolves
  the live target HEAD (`resolveBaseCommit({baseRef: target})`) and sends it as
  `reviewedTargetCommit`; on a `PRECONDITION` "target advanced" response the panel
  re-renders against the new HEAD, shows a drift warning, and offers "Promote
  anyway" (`allowTargetDrift: true`). **Legacy-row safe (Codex F4, §3.6):** when
  `workspace` base/target/mode are null (pre-M18 run), derive display fallbacks
  (`project.default_branch`, `resolveBaseRef`) — never render a null branch or
  pass null into `diffRange`; if a fallback is impossible, show the
  `PRECONDITION` "relaunch to promote" state instead of the Promote action.
- **T4.3 — Conflict handoff UX.** On `CONFLICT`, surface the manual-resolution
  assignment (parent repo path, target branch, run branch, exact failing
  command) via the existing assignment card; resolve-by-hand returns through the
  normal assignment/artifact/gate path.
- **T4.4 — Board flight-card + i18n.** Extend `flight-card.tsx` with the
  ready-to-promote / `PR #N` / merge-blocked badge; all new EN+RU keys in
  `en.json`/`ru.json` (`run.promoteTo`, `run.promotionMode`, `run.readiness*`,
  `run.prLink`, `run.targetDrift`, `run.promoteAnyway`, `board.readyToPromote`).
- **T4.5 — (GREEN).** Seed helper + stub green; full e2e green; final doc-tag
  sweep; `pnpm validate:docs:all` + both OpenAPI lints green.

---

## Commit Plan (per-phase checkpoint — matches the repo's milestone pattern)

| Checkpoint | After | Conventional message |
|-----------|-------|----------------------|
| C0 | Phase 0 | `docs(m18): spec-freeze branch targeting + promotion (ADR-048/049, openapi, ERD, analytics)` |
| C1 | Phase 1 | `feat(m18): launch-time base/target branch selection + worktree-from-base + ledger columns` |
| C2 | Phase 2 | `feat(m18): shared promotion service + flow-run local_merge + promote-time readiness gate` |
| C3 | Phase 3 | `feat(m18): pull_request promotion — hybrid gh/glab CLI + Gitea API (model B), idempotent PR` |
| C4 | Phase 4 | `feat(m18): base→run→target review surface, conflict handoff, e2e` |

Each checkpoint requires its phase exit-gate green BEFORE committing (skill-rule:
per-phase suite-green; a touched test left red fails the phase). Pre-existing red
or harness-limited tests get an explicit `*.skip` + reason + tracked follow-up,
never silent tolerance.

---

## Resolved decisions (confirmed 2026-06-03 — no open questions)

1. **Код ошибки PR-провала** — переиспользуем закрытый union (ADR-008), нового кода
   нет: `PRECONDITION`/`CONFLICT` → 409 для конфигурации/конфликта/дрейфа;
   ретраябельный transient push/PR-5xx → `EXECUTOR_UNAVAILABLE` → 503 (Codex F7),
   т.к. `httpStatusForCode` маппит по коду и `PRECONDITION` не может дать 503.
2. **Терминальный статус** — оба режима → `Done`, без нового статуса. PR как
   артефакт; мердж PR в M18 не трекаем.
3. **Артефакт PR** — `pr_url`/`pr_number` в payload `commit_set`, без отдельного
   kind `pr_link`.
4. **Провайдеры PR** — все четыре. Механизм **гибрид**: `gh`/`glab` CLI для
   github/gitlab, общий Gitea-совместимый REST-адаптер (host-env токен) для
   gitea/gitverse; `generic` → `PRECONDITION`.
5. **Target-ветка** обязана существовать (валидация на launch и на promote);
   создание на лету — нет.
6. **ext-promote** — остаётся внутренним (UI). Внешний `promote`-эндпоинт в M18
   не входит; ext получает только branch targeting на **launch**.

**Verification item (не вопрос):** Gitea-API-совместимость GitVerse
подтверждается в Phase 3 (T3.2); fallback — gitverse-ветка в общем
`GiteaApiAdapter`.
