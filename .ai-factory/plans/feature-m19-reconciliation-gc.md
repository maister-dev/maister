# Implementation Plan: M19 — Reconciliation + GC

Branch: `claude/suspicious-chatelet-2b3a22` (worktree). Intended feature branch
`feature/m19-reconciliation-gc` — NOT auto-created (we are inside a managed
worktree). Create it at `/aif-implement` time if desired; this file already uses
that branch stem so consumer skills discover it.
Created: 2026-06-01

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint; Phase 0 is docs-first (source of truth)

## Roadmap Linkage
Milestone: "M19. Reconciliation + GC"
Rationale: Implements the M19 line verbatim (startup reconcile, supervisor-heartbeat
dead-worker → Crashed, cron GC of Abandoned/Done worktrees + checkpointed sessions,
Recover/discard UI) PLUS the M10 deferred follow-up "automatic GC of unreferenced
`Removed` flow_revisions (→ M19)".

---

## 0. Scope, decisions, and what already exists

### 0.1 What the milestone delivers (confirmed with user 2026-06-01)

| # | Deliverable | User decision |
|---|-------------|---------------|
| A | Detect a **stranded `Running` run** (runner loop gone after web/supervisor restart, or a session-less node left dangling) and reconcile it | **Startup reconcile + periodic reconcile sweeper** |
| B | **Recover** a `Crashed` flow (graph) run | **Full ACP `--resume`** — refined to a **hybrid**: `--resume` for agent nodes, `runFlow` re-dispatch for session-less gate nodes |
| C | **GC** of old worktrees + flow revisions | **Both** delivery surfaces (background sweeper **and** token-guarded HTTP cron route) |
| D | GC scope | **Worktrees of Abandoned/Done runs + unreferenced `Removed` flow_revisions** (on-disk ACP `.jsonl` pruning deferred) |
| C′ | GC must **not** be destructive | **Preserve-then-prune**: before removing a worktree with unmerged work, archive its branch (+ optional remote push). Never auto-merge into main/target (that stays M18 promotion). |
| C″ | GC age | **14 days** default (env-tunable), with a **2-day** warning window |
| E | UI | Distinct **Crashed** card + Recover/Discard actions for flow runs; **worktree TTL color ramp** (green→amber→red) counting down to GC removal; archived indication |

### 0.2 What ALREADY exists (do not rebuild — verified during exploration)

- `runs.status` already includes `Crashed` and `Failed` (`web/lib/db/schema.ts:390`). Distinction is locked: `Crashed` = unrecoverable/owes-recovery; `Failed` = step rejected. See `web/lib/flows/runner.ts:509-524`.
- **Live mid-stream crash already → `Crashed`**: `runner-agent.ts` consumes `session.crashed`/`session.exited`; a persist/crash failure surfaces `errorCode:"CRASH"`, and `runFlow` ends `Crashed` (`web/lib/flows/runner.ts:515`). M19 does NOT touch the live path.
- **Cross-process `--resume` plumbing exists**: `web/lib/runs/resume.ts:230` (`createSession({resumeSessionId})`), `web/lib/runs/resume-driver.ts` (`scheduleResumedSessionDrive`), and `web/app/api/scratch-runs/[runId]/recover/route.ts:242`. Recover reuses this — it is NOT greenfield.
- `crashResumedRun(runId)` already transitions **`NeedsInput` → `Crashed`** (`web/lib/runs/state-transitions.ts:415`). There is **no** helper for **`Running` → `Crashed`** — that is the new transition M19 adds (T1.2).
- Startup recovery sweeps already run from `web/instrumentation.ts`: `runResumeRecoverySweep` (NeedsInput claimed-but-undelivered) + `runTakeoverReturnRecoverySweep` (stranded `Running` after a takeover return). The reconcile sweep is the **third** sweep and must NOT double-handle their candidate sets.
- **Critical guard** (`web/lib/runs/resume-recovery.ts:328-331`): *"A naive `Running + no live session → Crashed` sweep is FORBIDDEN — it would false-positive on a session-less `command_check` gate executing after the return."* The reconcile classifier (ADR-033) is built around this.
- `listWorktrees(projectRepoPath)` → `WorktreeInfo[]` (`web/lib/worktree.ts`), `removeOwnedWorktree`, `logRange`, `diffRange`, `branchExists`, `removeBranch`, `promoteLocalMerge` — all present.
- `listSessions()` → `SupervisorSessionRecord[]` with `status: 'live'|'exited'|'crashed'` + `acpSessionId` (`web/lib/supervisor-client.ts`). Supervisor heartbeat detects orphans every 5 s and emits `session.crashed` (`supervisor/src/heartbeat.ts`), but the web tier only sees it while actively streaming — hence the reconcile sweep.
- Scheduler cap counts `status IN ('Running','NeedsInput','HumanWorking')` (`web/lib/scheduler.ts:136,218`); `NeedsInputIdle` is free. `promoteNextPending` / `releaseSlotOnIdle` exist. **`Crashed` currently frees no slot** — must be wired (T1.3).
- Portfolio already labels `Crashed` with tone `"crashed"` and offers scratch recover/discard (`web/lib/queries/portfolio.ts`). **Board maps `Crashed`→"running"** (`web/lib/board.ts`) — must become distinct (T1.4).
- `flow_revisions.packageStatus` includes `Removed`; `removeRevision` (`web/lib/flows/lifecycle.ts:386`) sets it under FK guards (`runs.flow_revision_id`, `flows.enabled_revision_id`). Comment line 385: *"Automatic GC of unreferenced revisions is M19."*
- Background-sweeper pattern: `globalThis` singleton + `setInterval(...).unref()`, env interval, booted from `instrumentation.ts` (`web/lib/runs/keepalive-sweeper.ts:621`).
- Last ADR = **ADR-032**. Next migration ≈ **0014** (M11c shipped 0013 — verify the highest file in the drizzle migrations dir at implement time).

### 0.3 Reconcile classification — the core design (ADR-033)

For each run at reconcile time, gather: `run.status`, `run.runKind`, `run.acpSessionId`, `run.currentStepId`, the workspace `worktreePath`, the **node type of `currentStepId`** (from the run's pinned `flow_revisions.manifest`, compiled to the graph; legacy `steps[]` compile to single-action nodes), `worktreeExists` (path ∈ `listWorktrees`), `liveSession` (`acpSessionId` ∈ live `listSessions` map). Then:

| Run state | Condition | Action | Reason |
|-----------|-----------|--------|--------|
| status ∉ `{Running}` | any | **SKIP** | reconcile is **allow-list `Running`-only**; `NeedsInput`/`NeedsInputIdle`/`HumanWorking`/terminal owned by other sweeps |
| `Running` | worktree MISSING | **CRASH** (`crashRunningRun`, reason `worktree-gone`) | the "runs vs `git worktree list`" check; cannot continue |
| `Running` | worktree present, `liveSession` present | **RE-ATTACH** (`scheduleResumedSessionDrive`) or re-dispatch `runFlow` | live agent session with no attached runner (post web restart) — not crashed |
| `Running` | worktree present, no live session, current node is a **retry-safe gate eval** (`check`/`judge` — read-only) | **RE-DISPATCH** `runFlow` (CAS-guarded) | safe re-run of a read-only evaluation; avoids the FORBIDDEN false-positive crash on a gate executing between sessions |
| `Running` | worktree present, no live session, current node is **`cli`** (arbitrary side effects, NOT retry-safe) | **CRASH** (`crashRunningRun`, reason `cli-not-retry-safe`) | CAS prevents concurrent runners, NOT re-run idempotency (Codex F4); a half-run `cli` may have partial file/network side effects — never silently re-run. Recoverable via explicit human Recover (accepted-risk re-dispatch). A future manifest `retry_safe: true` opt-in can widen this. |
| `Running` | worktree present, no live session, current node is **agent**, **recently started** (`resume_started_at` OR latest `node_attempts.started_at` within `MAISTER_RECONCILE_GRACE_SECONDS`) | **SKIP** (grace window) | a launch/recover is still spinning its ACP session up — do NOT crash an in-flight session |
| `Running` | worktree present, no live session, current node is **agent**, **past grace** | **CRASH** (`crashRunningRun`, reason `agent-session-gone`) | recoverability computed at UI render from `acpSessionId` presence; auto-resume of a mid-turn agent is unsafe → explicit human Recover |
| `Running`, `runKind='scratch'` | session gone, past grace | **CRASH** via `markScratchCrashed` (sets both `runs.status` and `scratchRuns.dialogStatus`) | scratch parity |

Periodic-sweep safety: the paths to CRASH on a healthy box are worktree-gone, agent-session-gone **past the grace window**, or a half-run **`cli`** node (a genuine death). The **grace guard** (`MAISTER_RECONCILE_GRACE_SECONDS`, default 90) is REQUIRED so a periodic tick never crashes a `Running` agent run whose ACP session is still being created — by a fresh launch OR by an in-flight Recover (which flips `Crashed→Running` + stamps `resume_started_at` *before* `createSession`; see §3.2). **Retry-safety split (Codex F4):** only read-only gate evals (`check`/`judge`) auto-RE-DISPATCH (a CAS no-op when the real runner still holds the run — the contract `runTakeoverReturnRecoverySweep` relies on); a `cli` node is NOT idempotent and is CRASHED instead (explicit human Recover re-dispatches with accepted risk). Supervisor `listSessions` failure → **skip the whole tick** (like `resume-recovery`); never crash on transient supervisor unavailability.

---

## 1. Deployment wiring (skill-rule: every new env var/route lands in deploy artifacts)

| New dependency | Lands in |
|----------------|----------|
| `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS` (default 60) | `.env.example` + `compose.yml` web `environment:` + `compose.production.yml` + `docs/configuration.md` env table |
| `MAISTER_RECONCILE_GRACE_SECONDS` (default 90) | same set — grace window before a no-live-session agent run is crashed (protects in-flight launches/recovers) |
| `MAISTER_GC_SWEEP_INTERVAL_SECONDS` (default 3600) | same set |
| `MAISTER_GC_AGE_DAYS` (default 14) | same set |
| `MAISTER_GC_WARNING_DAYS` (default 2) | same set |
| `MAISTER_GC_ARCHIVE_PUSH` (default `false`) | same set |
| `MAISTER_CRON_TOKEN` (no default; empty ⇒ cron route returns 503 disabled) | same set; **server-only secret**, never logged/streamed |
| `GET`/`POST /api/cron/gc` route | already on the web service port (3000, mapped) — no new port; documented in `web.openapi.yaml` + `getting-started.md` |
| Migration 0014 (workspaces columns) | Drizzle migration committed + `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/db/erd.md` |

No new sidecar binary, no new bound port, no Dockerfile change (host-/service-env only). The cron route is reachable on the existing web port; the background sweepers need no external surface.

---

## 2. Contract-surface → spec-file map (skill-rule: trace every contract surface)

| Surface | Spec file |
|---------|-----------|
| `POST /api/runs/{runId}/recover` (200/202/409/410/503) | `docs/api/web.openapi.yaml` + `docs/system-analytics/runs.md` |
| `POST /api/runs/{runId}/discard` (200/409; marks Abandoned + enters GC countdown, no synchronous worktree removal) | `docs/api/web.openapi.yaml` + `docs/system-analytics/workspaces.md` |
| `GET`/`POST /api/cron/gc` (200/207/401/503, token header) | `docs/api/web.openapi.yaml` + `docs/system-analytics/reconciliation-gc.md` (new) |
| `runs.status` `Running → Crashed` (reconcile-driven) | `docs/system-analytics/runs.md` state machine |
| `workspaces` new columns (`scheduled_removal_at`, `archived_branch`, `archived_at`) + `runs.resume_started_at` | `docs/database-schema.md` + `docs/db/runs-domain.md` + `docs/db/erd.md` |
| New env vars | `docs/configuration.md` env-var table (canonical) + `.env.example` |
| Reuse of `CHECKPOINT`/`EXECUTOR_UNAVAILABLE`/`CONFLICT`/`PRECONDITION` by recover/discard/gc | `docs/error-taxonomy.md` (caller rows; **no new error code** — ADR-008 closed union) |
| New domain analytics | `docs/system-analytics/reconciliation-gc.md` (new, per docs R5) |

---

## 3. Decisions (skill-mandated checklists)

### 3.1 Identifiers per route (skill-rule: body-controlled vs server-state)

- `POST /api/runs/{runId}/recover` & `/discard`: `runId` = **url-param** (trusted via route shape + RBAC). `projectId` = **server-state** (DB join `runs→project`), passed to `requireProjectAction`. **No body cross-resource identifiers.** Bodies are empty (server derives base/target refs, current node, acpSessionId). ✅
- `GET`/`POST /api/cron/gc`: auth via `X-Maister-Cron-Token` header = **auth-context** (compared in constant time to `MAISTER_CRON_TOKEN`; mismatch/empty-config → 401/503, no work). **No body cross-resource identifiers**; the sweep derives its candidate set from server state only. ✅

### 3.2 Two-phase commit + failure classification (skill-rule)

**Recover (agent node) — durable marker BEFORE the side-effect (Codex #1 fix).** The earlier "flip on ack" design left a crash window where `createSession` succeeded but the run was still `Crashed` with no durable in-flight record. Corrected ordering:

- **Phase 1 (durable intent + cap admission, one tx under the scheduler advisory lock — Codex F2 fix):** `SELECT ... FOR UPDATE`; CAS `WHERE status='Crashed'` (allow-list, not `!terminal`). A `Crashed` run already **released** its slot (`crashRunningRun→promoteNextPending`), so Recover is a re-launch and MUST re-admit through the cap — it does NOT bypass it (unlike M8 idle-resume, which never vacated its slot). Take the scheduler advisory lock and count live (`Running`/`NeedsInput`/`HumanWorking`):
  - **slot free** → flip `status→Running`, set `resume_started_at = now()`, set `currentStepId` = resume target → proceed to Phase 2.
  - **cap full** → flip `status→Pending` (keep `acpSessionId` + set `resume_started_at` + `currentStepId`) → return **202 `{state:"queued"}`**, no `createSession`. The scheduler resumes it when a slot frees (T1.3). A `Pending` run is NOT a reconcile candidate (allow-list is `Running`-only), so it waits safely.
  This tuple (`Running`/`Pending` + `resume_started_at` + `acpSessionId`) **IS** the durable in-flight/queued marker — committed *before* any supervisor call.
- **Phase 2 (side-effect, only when admitted):** supervisor `createSession({resumeSessionId: acpSessionId})` → on ack `scheduleResumedSessionDrive` at `currentStepId`. The driver/runner clears `resume_started_at` once the session attaches and progresses.
- **Queued resume:** `promoteNextPending` (T1.3) branches on `acpSessionId` — a promoted `Pending` run **with** `acpSessionId` is resumed via the Phase-2 path (refreshing `resume_started_at` at promotion so the grace guard covers the new in-flight window); **without** it, a fresh `runFlow` launch (unchanged). `acpSessionId` is non-null only on a recover-queued `Pending` (a fresh queued launch has it null), so the discriminator is unambiguous.

The **reconcile engine is the single recovery mechanism** for every crash/ambiguity window (no bespoke recover sweep):

| Window / failure | HTTP | Row state & who recovers |
|------------------|------|--------------------------|
| cap full at admission | 202 `{state:"queued"}` | `Crashed→Pending` (acpSessionId retained); scheduler resumes on slot free. No `createSession` → **no over-spawn (Codex F2)** |
| concurrent 2nd Recover click | 409 | Phase-1 CAS on `status='Crashed'` fails (now `Running`/`Pending`) → **duplicate `createSession` impossible** |
| crash **before** `createSession` | — | `Running` + `acpSessionId` not live + past grace → reconciler **re-crashes** to `Crashed` (clears `resume_started_at`); user retries. No session leaked. |
| crash **after** `createSession` success | — | `Running` + `acpSessionId` now live → reconciler **re-attaches** the driver. |
| supervisor 5xx / network / timeout (ambiguous) | 503 | **leave `Running`** (do NOT roll back — the ack may have been lost and a session may be live); reconciler reattaches if it came up, else re-crashes past grace. Retryable. |
| supervisor 4xx `CHECKPOINT` (unresumable acp session) | 410 | `crashRunningRun` → `Crashed` (clears `resume_started_at`); surface discard-only. |

Idempotency marker = the Phase-1 `resume_started_at` (set before the side-effect, cleared on progress/terminal). The grace window (§0.3) keeps the reconciler from racing this in-flight `Running` state.

**Discard — enters the GC countdown, no synchronous removal (Codex #2/#3 fix).** Discard is a single terminal action, NOT a synchronous worktree delete:

- One tx: `markAbandoned` (allow-list incl. `Crashed`) → stamps `scheduled_removal_at = endedAt + MAISTER_GC_AGE_DAYS` (via the T1.3 terminal-stamp path) → then `promoteNextPending`.
- The worktree is **left in place** showing the TTL color-ramp countdown and is **preserved-then-pruned by the GC sweep** (T4.2), exactly like any other Abandoned run — one lifecycle. Discard therefore does **not** call `preserveWorktree`/`removeOwnedWorktree` (so T3.3 no longer depends on Phase 4).
- **Backfill-free coverage (Codex F3):** the GC sweep and TTL read models compute the **effective deadline** as `scheduled_removal_at ?? (runs.ended_at + MAISTER_GC_AGE_DAYS)` for `Abandoned`/`Done` runs, so terminal runs that pre-date migration 0014 (null `scheduled_removal_at`) are still collected — no separate backfill migration is needed.
- **Dirty-state safety (Codex F1):** GC preserve (T4.1) snapshots uncommitted **and** untracked worktree changes into the archive ref *before* any removal, and removal is **gated on preserve success** — so a Discard that schedules a worktree carrying un-committed agent edits never loses them. See §3.5.
- Idempotent on already-terminal: same-state retry → 200, conflicting state → 409. No worktree side-effect means no AFTER-side removal-failure path.
- Immediate "force delete now" is deferred to Phase 2 (a separate explicit affordance), not built here.

### 3.3 Multi-store atomic transition + crash windows (skill-rule)

- `crashRunningRun`: ONE `db.transaction` writes `status→Crashed` (CAS `WHERE status='Running'`) + `endedAt` + `currentStepId=null`. Slot release (`promoteNextPending`) runs AFTER commit (a death there is recovered by the next sweep tick / startup reconcile — Pending promotion is idempotent).
- GC preserve-then-prune crash windows: **dirty-not-snapshotted** (porcelain dirty, snapshot commit not yet made) → next tick re-runs `statusPorcelain`+snapshot (a re-commit of the same tree is a no-op / new empty-diff commit avoided by checking porcelain first); **archived-not-pruned** (archive branch exists, worktree still there, `removed_at` null) → next GC tick re-runs preserve (idempotent `git branch -f`, clean tree → skip snapshot) then removes; **pruned-not-marked** (worktree gone, `removed_at` null) → next tick: `removeOwnedWorktree` is a no-op on a missing path, then sets `removed_at`. Removal only ever runs after preserve succeeds (Codex F1), so no window deletes un-preserved state. All partial states converge on re-run; no slot is involved (run already terminal).
- Reconcile re-dispatch / re-attach: CAS-guarded in `runFlow`; a death after commit is re-handled at the next sweep tick.
- Recover crash windows (§3.2): the Phase-1 `Crashed→Running`+`resume_started_at` commit precedes `createSession`, so every death/ambiguity reduces to a `Running`+marker state the reconcile engine already owns — re-attach if the resumed session is live, re-crash past grace if not. No standalone recover-recovery sweep is added; no orphaned ACP session leaks beyond one grace window.

### 3.4 Fan-out of the reconcile-driven `Crashed` + new routes to ALL consumers (skill-rule, allow-list guards)

| Consumer class | Update |
|----------------|--------|
| Read models | `web/lib/board.ts` (distinct `crashed` card — currently `→"running"`); `web/lib/queries/portfolio.ts` (confirm `crashed` tone covers flow runs + recover/discard action for `runKind='flow'`); `web/lib/queries/activity.ts` (already "run crashed"); run-detail timeline read model |
| Scheduler / cap | `promoteNextPending` invoked on every `Running→Crashed`; cap predicate unchanged (`Crashed` already excluded) |
| Recovery / idle sweeps | reconcile is allow-list `Running`-only; `resume-recovery` (`NeedsInput`) and `takeover-return` (`Running`-with-takeover-ledger) candidate sets must stay disjoint — reconcile must skip a `Running` row that the takeover sweep owns (carry the same `returned_diff`+`ended_at`+stale-gate predicate as an exclusion) |
| State / precondition guards | recover/discard/activity/HITL guards as **allow-list** sets (`status ∈ {...}`), never `!terminal`; `Crashed` admitted only where intended (recover, discard, abandon) |
| API spec | recover/discard/cron get `web.openapi.yaml` paths in the same change |
| Terminal slot-release contract | new `Running→Crashed` honors `promoteNextPending` (parity with `markAbandoned`) |

### 3.5 GC preserve semantics — preserve EVERYTHING, then prune (Codex F1)

GC is **preserve, not merge-to-main**, and it must never destroy un-committed work. Order inside `preserveWorktree`, **before** any `removeOwnedWorktree`:

1. `statusPorcelain(worktree)` (existing util, `--untracked-files=all`) to detect **staged + unstaged + untracked** changes.
2. **Dirty** (porcelain non-empty) → make a snapshot commit IN the worktree that captures tracked **and** untracked state: `git add -A && git commit --no-verify -m "maister: GC snapshot of <runId>"`. The run is terminal and the worktree is about to be deleted, so advancing its branch HEAD is safe; the snapshot lands on the archive ref.
3. Point the **archive branch** `maister/archive/<runId>` at the (snapshot-or-) branch HEAD (`git branch -f`) when there is anything to preserve — i.e. `statusPorcelain` was dirty OR `logRange base..branch` is non-empty. If a remote exists and `MAISTER_GC_ARCHIVE_PUSH=true`, push it (host git creds per ADR-025/M21). Record `workspaces.archived_branch` / `archived_at`.
4. **Only after preserve succeeds** is the worktree removed (T4.2). **Preserve/commit/branch failure → DO NOT remove**: skip the row, log `WARN`, leave for the next tick / operator. Forcibly removing un-preserved dirty state is FORBIDDEN.

Auto-merging into the project default/target branch is explicitly OUT (that is M18 promotion, and a silent GC merge is dangerous). A clean worktree with no commit divergence has nothing to preserve → skip straight to removal. Open for confirmation — see Unresolved Q1.

### 3.6 Trust/execution (skill-rule)

GC `revision-gc` only **removes** (`rm installedPath`) under the existing dual-FK guard; it never runs `setup.sh` or any plugin hook. No fetch-then-execute path is introduced. ✅

---

## Commit Plan

- **Commit 1** (Phase 0, T0.1–T0.8): `docs: M19 analytics, ADR-033..036, reconcile/GC contracts`
- **Commit 2** (Phase 1, T1.1–T1.5): `feat(m19): Running→Crashed transition, schema, scheduler+read-model fanout`
- **Commit 3** (Phase 2, T2.1–T2.4): `feat(m19): reconcile engine — startup + periodic sweeper`
- **Commit 4** (Phase 3, T3.1–T3.4): `feat(m19): recover/discard routes (ACP --resume hybrid)`
- **Commit 5** (Phase 4, T4.1–T4.6): `feat(m19): preserve-then-prune GC + revision GC + cron route`
- **Commit 6** (Phase 5, T5.1–T5.4): `feat(m19): Crashed UI, TTL color ramp, recover/discard UX, i18n, e2e`

Every phase exit requires (executable gate — run from repo root): `pnpm --filter maister-web typecheck` (0 errors) · `pnpm --filter maister-web test:unit` · `pnpm --filter maister-web test:integration` · `pnpm validate:docs:all` — all green. (Root `package.json` exposes ONLY `validate:docs*`; typecheck/test:* live in the `maister-web` package and MUST be run with `--filter maister-web`. `pnpm --filter maister-web test` runs unit+integration together.) Any test the phase touches that is left red fails the phase (quarantine only via explicit `*.skip` + tracked follow-up).

---

## Tasks

### Phase 0 — Analytics, ADRs & contracts (docs-first, source of truth; NO code)

- [x] **T0.1** — ADR-033 *Crash reconciliation model*. In `docs/decisions.md` (next number, ADR-033). Capture: startup + periodic sweeper; the **classification table from §0.3 written exactly as the code will gate**, INCLUDING the **grace guard** (`MAISTER_RECONCILE_GRACE_SECONDS`) that skips a no-live-session agent run still within `resume_started_at`/latest-attempt grace (allow-list `Running`-only; worktree-gone → Crash; agent-session-gone-past-grace → Crash; session-less → re-dispatch; live → re-attach; supervisor-down → skip tick); disjointness from `resume-recovery`/`takeover-return` sweeps; statement that the periodic poll is the sanctioned recovery path, not a banned live-path poll. Logging: n/a (doc). Files: `docs/decisions.md`.
- [x] **T0.2** — ADR-034 *Crashed-run recovery semantics*. Hybrid Recover: `--resume` for agent nodes (reuse `resume.ts`/`resume-driver.ts`), `runFlow` re-dispatch for session-less nodes, discard-only when `acpSessionId` absent/unresumable. Specify the **durable-marker-before-side-effect** ordering (`runs.resume_started_at` + Phase-1 `Crashed→Running` committed before `createSession`), **cap re-admission (Codex F2): Recover acquires a scheduler slot before `createSession`; cap-full → `Crashed→Pending` queued (202), resumed by the scheduler on slot-free** (NOT a cap bypass — a Crashed run already released its slot), the reconcile engine as the single crash-window recovery, and the §3.2 failure table (202/409/410/503; transient leaves `Running`, no rollback). Discard = Abandoned + GC countdown (no synchronous removal). Files: `docs/decisions.md`.
- [x] **T0.3** — ADR-035 *Graceful workspace GC (preserve-then-prune)*. 14-day age, 2-day warning ramp; archive-branch (+ optional push) never merge-to-main; dual delivery (background sweeper + token cron). **Dirty-state preservation (Codex F1): `statusPorcelain` + snapshot commit captures tracked+untracked before any removal; removal gated on preserve success.** **Backfill-free coverage (Codex F3): effective GC deadline = `scheduled_removal_at ?? ended_at + AGE`, so pre-0014 terminal runs are still collected.** Files: `docs/decisions.md`.
- [x] **T0.4** — ADR-036 *Flow-revision GC*. Auto-delete unreferenced `Removed` revisions past age under the existing dual-FK guard; reuse `removeRevision` guards. Files: `docs/decisions.md`.
- [x] **T0.5** — New `docs/system-analytics/reconciliation-gc.md` per docs R5 (Purpose, Domain entities, **State machine** `stateDiagram-v2` for the run reconcile + workspace GC lifecycle, **Process flows** `flowchart` for startup-reconcile / periodic-sweep / cron-gc / preserve-then-prune, **Expectations** ≤12 testable MUST bullets referencing `runs.status`, `workspaces.scheduled_removal_at`, env vars verbatim, **Edge cases** linked to `MaisterError` codes, **Linked artifacts**). Update `docs/system-analytics/runs.md` (`Running→Crashed` reconcile transition + Recover), `docs/system-analytics/workspaces.md` (GC lifecycle, TTL ramp, archive, reconciliation section), `docs/system-analytics/flow-packages.md` (revision GC). Add the new doc to `docs/CLAUDE.md` glossary. Tag every piece Implemented/Designed per R6. Logging: n/a. 
- [x] **T0.6** — DB design for migration 0014: `workspaces` add `scheduled_removal_at timestamptz null`, `archived_branch text null`, `archived_at timestamptz null` (derive UI TTL state + pruned/archived from these + existing `removed_at`; **no `gc_state` enum** — fewer fanout points) AND `runs.resume_started_at timestamptz null` (durable Recover in-flight marker + reconcile grace anchor). Document all four in `docs/database-schema.md` (narrative + cascade) AND `docs/db/runs-domain.md` `erDiagram` AND `docs/db/erd.md`. Logging: n/a. (depends on T0.5)
- [x] **T0.7** — Contract specs: add to `docs/api/web.openapi.yaml` the three routes (recover/discard/cron) with status codes, empty/standard bodies, token security scheme; update `docs/configuration.md` env-var table (all six new vars, defaults, semantics, server-only flag on `MAISTER_CRON_TOKEN`); add caller rows to `docs/error-taxonomy.md`. Logging: n/a. (depends on T0.2, T0.3, T0.4)
- [x] **T0.8** — Phase-0 exit gate: run `pnpm validate:docs:all` (Mermaid) → green; **cross-consistency check**: the §0.3 classification table is byte-identical in ADR-033 and `reconciliation-gc.md`; every described route/column/env is tagged and matches the planned code; no spec describes code that won't exist at the phase HEAD. Logging: n/a. (depends on T0.1–T0.7)
<!-- Commit checkpoint: T0.1–T0.8 -->

### Phase 1 — Schema + `Running→Crashed` transition + consumer fan-out

- [ ] **T1.1** — Migration 0014 + `web/lib/db/schema.ts`: add the three `workspaces` columns (`scheduled_removal_at`, `archived_branch`, `archived_at`; additive, nullable) AND `runs.resume_started_at timestamptz null` (the durable Recover in-flight marker + reconcile grace anchor, per §3.2). Verify the highest existing migration number first; generate via the project's drizzle flow. LOGGING: log migration apply at INFO via existing harness; n/a in code. Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0014_*.sql`. (depends on T0.6)
- [ ] **T1.2** — `web/lib/runs/state-transitions.ts`: add `crashRunningRun(runId, {reason}, opts)` — single `db.transaction`, CAS `WHERE status='Running'` (allow-list), set `status→Crashed`, `endedAt`, `currentStepId=null`, **`resume_started_at=null`** (clear the in-flight marker so a re-crash leaves a clean, re-recoverable row). Return `{ok, reason}`. Extend the scratch crash path (`web/lib/scratch-runs/service.ts markScratchCrashed`) to also accept a `Running` source for reconcile. LOGGING: DEBUG entry `{runId, reason}`, INFO on CAS win, WARN on CAS miss (concurrent transition), format `[state-transitions.crashRunningRun]`. Files: `web/lib/runs/state-transitions.ts`, `web/lib/scratch-runs/service.ts`. (depends on T1.1)
- [ ] **T1.3** — Scheduler slot-release + terminal deadline stamping + **resume-on-promote (Codex F2)**: every `Running→Crashed` caller invokes `promoteNextPending` (parity with `markAbandoned`); stamp `workspaces.scheduled_removal_at = run.endedAt + MAISTER_GC_AGE_DAYS` on the **Abandoned** and **Done** transitions (`markAbandoned`, the merge/done path, discard) — in the same tx as the status flip. Extend the `promoteNextPending` promote path so a promoted `Pending` run **with `acpSessionId != null`** is RESUMED (Phase-2 `createSession({resumeSessionId})` via the T3.1 path, refreshing `resume_started_at` at promotion) instead of fresh-launched — the discriminator is unambiguous (a fresh queued launch has `acpSessionId = null`). Add `gcAgeDays()`/`gcWarningDays()` parsers to `web/lib/instance-config.ts` (mirror `sweepIntervalSeconds`). LOGGING: INFO `[scheduler] slot released on Crashed {runId, promotedRunId}`; INFO `[scheduler] promoting queued resume {runId}`; DEBUG `scheduled_removal_at stamped {runId, at}`. Files: `web/lib/scheduler.ts`, `web/lib/runs/state-transitions.ts`, `web/lib/instance-config.ts`. (depends on T1.2)
- [ ] **T1.4** — Fan-out (allow-list): `web/lib/board.ts` map `Crashed` to a distinct `crashed` card status (not `running`) + surface recover/discard affordance for `runKind='flow'`; `web/lib/queries/portfolio.ts` confirm/extend `crashed` tone + action for flow runs (not just scratch); run-detail read model exposes crash recoverability (`acpSessionId` present + current node agent). Audit every run-status guard touched (activity/HITL/stream terminal sets) to ensure `Crashed` admission is allow-list-explicit. LOGGING: none (pure read models). Files: `web/lib/board.ts`, `web/lib/queries/portfolio.ts`, run-detail query module. (depends on T1.2)
- [ ] **T1.5** — Tests P1. Unit: `crashRunningRun` CAS win/miss; slot release calls `promoteNextPending`; `scheduled_removal_at` stamped on Abandoned/Done; board maps `Crashed`→`crashed` (assertion migration of the existing board-card test). Integration (testcontainers `integration` project): `Running→Crashed` frees a slot and promotes the oldest `Pending`; terminal transition stamps the deadline. Name each file's vitest project; confirm `include` globs match. LOGGING: tests assert log side-effects where relevant. Files: `web/lib/runs/__tests__/state-transitions*.test.ts`, `web/lib/__tests__/scheduler*.test.ts`, `web/lib/__tests__/board*.test.ts`. (depends on T1.2, T1.3, T1.4)
<!-- Commit checkpoint: T1.1–T1.5 -->

### Phase 2 — Reconcile engine (startup + periodic sweeper)

- [ ] **T2.1** — `web/lib/reconcile.ts` pure classifier `classifyRunReconcile(input) → {action: 'skip'|'reattach'|'redispatch'|'crash', reason}` implementing the §0.3 table exactly, **including (a) the grace guard** — a `Running` + agent + no-live-session run whose `resume_started_at` OR latest `node_attempts.started_at` is within `MAISTER_RECONCILE_GRACE_SECONDS` → `skip`, only past grace → `crash`; **and (b) the retry-safety split (Codex F4)** — a `Running` + no-live-session run whose current node is a read-only gate eval (`check`/`judge`) → `redispatch`, but a `cli` node (arbitrary, non-idempotent side effects) → `crash` (reason `cli-not-retry-safe`), NEVER auto-redispatch. Inputs are plain data (run row incl. `resume_started_at`, latest-attempt `startedAt`, `nowMs`, `graceSeconds`, `worktreeExists`, `liveSession`, `currentNodeKind`) so it is fully unit-testable (no clock/db access inside). Resolve `currentNodeKind` from the run's pinned `flow_revisions.manifest` compiled to the graph (reuse `web/lib/flows/graph/compile`). LOGGING: DEBUG per-run classification `{runId, action, reason}`, format `[reconcile.classify]`. Files: `web/lib/reconcile.ts`. (depends on T1.2)
- [ ] **T2.2** — `runReconcileSweep(opts)` in `web/lib/reconcile.ts`: per project, load `Running` runs (allow-list) joined to workspaces + pinned manifest; fetch `listWorktrees` + `listSessions` once; **exclude the takeover-return sweep's candidate set** (returned_diff + ended_at + stale re-entry gate) to keep sweeps disjoint; apply each action with bounded concurrency (reuse `runWithConcurrency`); supervisor-`listSessions` failure → skip whole tick. `crash`→`crashRunningRun`+`promoteNextPending`; `redispatch`→`runFlow`; `reattach`→`scheduleResumedSessionDrive`; scratch kind → `markScratchCrashed`. Return a summary `{candidates, crashed, redispatched, reattached, skipped}`. LOGGING: INFO start/summary, WARN on supervisor-down skip, per-action INFO. Files: `web/lib/reconcile.ts`. (depends on T2.1)
- [ ] **T2.3** — Boot wiring: in `web/instrumentation.ts` call `runReconcileSweep()` once at startup (AFTER the two existing recovery sweeps, BEFORE `startKeepaliveSweeper`) inside the existing try/catch (failure must not block boot); add `startReconcileSweeper()` periodic singleton (`web/lib/reconcile.ts`, `globalThis`-stored handle, `setInterval(...).unref()`, `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS`, HMR-safe clear). Deployment: add **both** `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS` and `MAISTER_RECONCILE_GRACE_SECONDS` to `.env.example` + `compose.yml`/`compose.production.yml` web `environment:` + `docs/configuration.md`. Add `reconcileSweepIntervalSeconds()`/`reconcileGraceSeconds()` parsers to `web/lib/instance-config.ts`. LOGGING: INFO sweeper start/tick. Files: `web/instrumentation.ts`, `web/lib/reconcile.ts`, `web/lib/instance-config.ts`, `.env.example`, `compose.yml`, `compose.production.yml`, `docs/configuration.md`. (depends on T2.2)
- [ ] **T2.4** — Tests P2. Unit (`unit` project, mocked db/`listSessions`/`listWorktrees`): every classification-table row incl. allow-list excludes `NeedsInput`/`HumanWorking`; **retry-safety split (F4)** — `check`/`judge` no-live-session → `redispatch`, but a `cli` node mid-step (no live session) → `crash` (reason `cli-not-retry-safe`), NOT redispatch; **grace guard** — agent + no-live-session within `MAISTER_RECONCILE_GRACE_SECONDS` (via `resume_started_at` AND via fresh `node_attempts.started_at`) → `skip`, past grace → `crash`; supervisor-down → skip; takeover-return candidate excluded. Integration: orphan `Running` worktree-gone → `Crashed` + slot promoted; agent-session-gone past grace → `Crashed`; live session (incl. a recovered run) → `reattach` (no crash); in-flight recover within grace not crashed; non-idempotent `cli` mid-step → `Crashed` (no re-run). LOGGING: assert summary counts. Files: `web/lib/__tests__/reconcile*.test.ts`. Phase-2 exit gate: `pnpm --filter maister-web typecheck` 0 + `test:unit` + `test:integration` green. (depends on T2.2, T2.3)
<!-- Commit checkpoint: T2.1–T2.4 -->

### Phase 3 — Recover/discard for flow runs (ACP `--resume` hybrid)

- [ ] **T3.1** — `web/lib/runs/recover.ts`: `classifyRecover(run, currentNodeKind) → 'resume-agent'|'redispatch'|'discard-only'`; `resumeCrashedRun(runId, opts)` implementing the §3.2 **durable-marker-first + cap-admission** ordering — **Phase 1 (one tx, under the scheduler advisory lock):** CAS `WHERE status='Crashed'`; count live (`Running`/`NeedsInput`/`HumanWorking`) vs `MAISTER_MAX_CONCURRENT_RUNS` — **slot free** → `status='Running'` + `resume_started_at=now()` + `currentStepId`=resume target → Phase 2; **cap full** → `status='Pending'` (keep `acpSessionId`, set `resume_started_at`+`currentStepId`) → return queued, NO `createSession` (Codex F2: a Crashed run already freed its slot, so Recover must re-admit and never over-spawn). **Phase 2 (only when admitted):** agent node → `createSession({resumeSessionId: run.acpSessionId})` then `scheduleResumedSessionDrive` at `currentStepId`; session-less gate node → `runFlow` re-dispatch (no `createSession`). On transient/ambiguous supervisor failure DO NOT roll back — leave `Running` (reconciler reattaches-or-recrashes); on terminal `CHECKPOINT` → `crashRunningRun`. The driver/runner clears `resume_started_at` on first progress. Queued (`Pending`+`acpSessionId`) runs are resumed by the scheduler (T1.3) on slot-free. **Spike sub-step**: verify mid-turn continuation semantics on the mock ACP adapter (re-issue node prompt vs continue from `.jsonl`) and document the chosen contract in `reconciliation-gc.md`; if unsafe, fall back to `redispatch` for agent nodes too (update ADR-034 first). LOGGING: DEBUG classify, INFO phase-1 flip/queue / phase-2 resume / redispatch, ERROR on supervisor failure with code, format `[recover]`. Files: `web/lib/runs/recover.ts`. (depends on T2.1, T1.3)
- [ ] **T3.2** — `POST /api/runs/[runId]/recover/route.ts`: `requireActiveSession` + `requireProjectAction(projectId /* server-state */, 'launchRun')` (or new `recoverRun` action — see Unresolved Q3); empty body (runId = url-param only); Phase-1 cap-admission + durable flip + Phase-2 side-effect per §3.2 (`FOR UPDATE`, allow-list `status='Crashed'`, marker = `resume_started_at`, terminal-status check); failure mapping **200 (resumed now) / 202 `{state:"queued"}` (cap full → `Crashed→Pending`, no `createSession`)** / 409 (concurrent or not-Crashed) / 410 (`CHECKPOINT`) / 503 (transient — row left `Running`, NOT rolled back). LOGGING: INFO request/result (incl. queued), WARN on classification refusal. Files: `web/app/api/runs/[runId]/recover/route.ts`. (depends on T3.1)
- [ ] **T3.3** — `POST /api/runs/[runId]/discard/route.ts`: `requireProjectAction(projectId /* server-state */, 'answerHitl' or 'launchRun')`; empty body; **single terminal action** — `markAbandoned` (one tx, allow-list incl. `Crashed`/`Review`/`NeedsInput*`, stamps `scheduled_removal_at` via T1.3) → `promoteNextPending`. **No synchronous preserve/worktree-removal** — the worktree enters the GC countdown and is preserved-then-pruned by the GC sweep (T4.2), one unified lifecycle (§3.2). Idempotent on already-terminal: same-state → 200, conflict → 409. LOGGING: INFO request/result. Files: `web/app/api/runs/[runId]/discard/route.ts`. (depends on T1.3 — **no longer depends on T4.1**)
- [ ] **T3.4** — Tests P3: recover-resume (agent, mock adapter round-trip); recover-redispatch (gate); recover Phase-1-before-side-effect ordering (durable `Running`+`resume_started_at` committed before `createSession`); **cap admission (F2)** — cap full → recover returns 202 + `Crashed→Pending` with NO `createSession`; concurrent recovers never exceed `MAISTER_MAX_CONCURRENT_RUNS`; a queued `Pending`+`acpSessionId` run is resumed (not fresh-launched) when a slot frees; **crash-window/idempotency** — concurrent 2nd recover → 409 / no duplicate `createSession`; transient 5xx → 503 leaves `Running` (not rolled back); `CHECKPOINT` → 410 → `Crashed` with `resume_started_at` cleared; reconciler re-attaches a post-`createSession` `Running`+live-session row and re-crashes a pre-`createSession` past-grace row (cross-check with T2.4); discard → Abandoned + `scheduled_removal_at` stamped + slot promoted, worktree NOT removed synchronously; RBAC denial; idempotent retry. Name vitest projects; confirm globs. Files: `web/app/api/runs/[runId]/recover/__tests__/*`, `.../discard/__tests__/*`, `web/lib/runs/__tests__/recover*.test.ts`. Phase-3 exit gate: `pnpm --filter maister-web typecheck` 0 + `test:unit` + `test:integration` green. (depends on T3.2, T3.3)
<!-- Commit checkpoint: T3.1–T3.4 -->

### Phase 4 — Graceful GC (preserve-then-prune) + revision GC + cron

- [ ] **T4.1** — `web/lib/gc/preserve.ts` `preserveWorktree({workspace, run, db}) → {ok, archivedBranch?}` (Codex F1 — preserve EVERYTHING before any removal): (1) `statusPorcelain(worktree)` (`--untracked-files=all`); (2) **dirty** → `git add -A && git commit --no-verify -m "maister: GC snapshot of <runId>"` IN the worktree to capture tracked+untracked; (3) when dirty OR `logRange(base..branch)` non-empty → `git branch -f maister/archive/<runId> <HEAD>` + (remote present && `MAISTER_GC_ARCHIVE_PUSH`) push; set `archived_branch`/`archived_at`; (4) return `ok:false` (NOT throwing into a removal) on any git failure so the caller skips removal. Idempotent (clean tree → skip snapshot; re-run safe). Never merge to main/target. LOGGING: INFO archived/pushed/snapshotted, DEBUG skip-when-clean-and-merged, ERROR on git failure (surfaced). Files: `web/lib/gc/preserve.ts`. (depends on T1.1)
- [ ] **T4.2** — `web/lib/gc/workspace-gc.ts` `runWorkspaceGcSweep`: candidate select = `workspaces.removed_at IS NULL` joined to `runs.status IN ('Abandoned','Done')` where the **effective deadline** `COALESCE(scheduled_removal_at, ended_at + MAISTER_GC_AGE_DAYS) <= now()` (Codex F3 — the `ended_at` fallback collects pre-0014 terminal runs with null `scheduled_removal_at`, no backfill migration); per row `preserveWorktree` → **only if `ok` → `removeOwnedWorktree(force, allowedRoot=worktreesRoot())` → set `removed_at`** (preserve-failure → skip + WARN, never force-remove unpreserved state, Codex F1); batch + bounded concurrency; crash-window-safe per §3.3. LOGGING: INFO summary `{scanned, preserved, pruned, skippedUnpreserved, failed}`. Files: `web/lib/gc/workspace-gc.ts`. (depends on T4.1)
- [ ] **T4.3** — `web/lib/gc/revision-gc.ts` `runRevisionGcSweep`: select `flow_revisions` `packageStatus='Removed'` with `installedAt`/removed-age past `MAISTER_GC_AGE_DAYS`, `FOR UPDATE`, re-assert zero `runs.flow_revision_id` and zero `flows.enabled_revision_id` references → delete row + `rm(installedPath, {recursive,force})`. Reuse the guard logic from `lifecycle.removeRevision`. LOGGING: INFO `{scanned, deleted, skippedReferenced}`, WARN on fs failure. Files: `web/lib/gc/revision-gc.ts`. (depends on T0.4)
- [ ] **T4.4** — GC delivery: `startGcSweeper()` singleton (`web/lib/gc/sweeper.ts`, `globalThis`, `setInterval(...).unref()`, `MAISTER_GC_SWEEP_INTERVAL_SECONDS`) booted from `instrumentation.ts`; AND `GET`/`POST /api/cron/gc/route.ts` guarded by constant-time `X-Maister-Cron-Token` vs `MAISTER_CRON_TOKEN` (empty config → 503; mismatch → 401) running both sweeps and returning a JSON summary (200, or 207 if a sub-sweep partially failed). Identifiers per §3.1. LOGGING: INFO invocation source (sweeper vs cron), summary; NEVER log the token. Files: `web/lib/gc/sweeper.ts`, `web/app/api/cron/gc/route.ts`, `web/instrumentation.ts`. (depends on T4.2, T4.3)
- [ ] **T4.5** — Deployment wiring for all GC vars: `.env.example`, `compose.yml`, `compose.override.yml`, `compose.production.yml` web `environment:`, `docs/configuration.md` env table, `docs/getting-started.md` (cron-route usage + any new script). Confirm `MAISTER_GC_AGE_DAYS`/`WARNING_DAYS`/`SWEEP_INTERVAL_SECONDS`/`ARCHIVE_PUSH`/`CRON_TOKEN` each land per the §1 table. LOGGING: n/a. Files: deploy artifacts + docs. (depends on T4.4)
- [ ] **T4.6** — Tests P4: `preserveWorktree` (committed-divergence → archive branch + optional push; **dirty tracked changes → snapshot commit captures them**; **untracked files → captured in snapshot**; clean+merged → skip; **git failure → `ok:false`**); `runWorkspaceGcSweep` (effective-deadline gating; **pre-0014 terminal run with null `scheduled_removal_at` collected via `ended_at` fallback (F3)**; preserve-then-remove; **preserve-failure → worktree NOT removed (F1)**; idempotent re-run on each partial crash-window state); `runRevisionGcSweep` (FK-referenced skip both FKs; unreferenced delete + `rm` called); cron route (empty token 503; wrong token 401; valid token runs both, 200/207). Files: `web/lib/gc/__tests__/*`, `web/app/api/cron/gc/__tests__/*`. Phase-4 exit gate: `pnpm --filter maister-web typecheck` 0 + `test:unit` + `test:integration` green. (depends on T4.4)
<!-- Commit checkpoint: T4.1–T4.6 -->

### Phase 5 — UI (Crashed card + recover/discard + TTL color ramp + archive) + i18n + e2e

- [ ] **T5.1** — Crashed surface for flow runs: `web/components/board/flight-card.tsx` distinct Crashed stripe + Recover/Discard buttons (POST to the new routes); `web/app/(app)/runs/[runId]/page.tsx` Recover/Discard actions + crash reason + recoverable hint (new `components/runs/run-recover-actions.tsx`). **Recover confirm dialog MUST warn that recovery re-runs the current node** (Codex F4 — explicit, accepted-risk re-dispatch of a possibly non-idempotent `cli`); surface a "cap full — queued" state when recover returns 202. Follow the data-management page patterns (actions in buttons/modal, accessible: focus trap, `aria-live` on async result). LOGGING: client → no `console`; use existing error boundary. Files: board card, run-detail page, new actions component. (depends on T3.2, T3.3, T1.4)
- [ ] **T5.2** — Worktree TTL color ramp: read models expose the **effective deadline** `effectiveRemovalAt = scheduled_removal_at ?? (ended_at + MAISTER_GC_AGE_DAYS)` for `Abandoned`/`Done` (Codex F3 — matches the GC sweep so pre-0014 rows show a countdown too) + derived `ttlState` (`active`→green, `warning`→amber when `now >= effectiveRemovalAt - WARNING_DAYS`, `due`→red when `>= effectiveRemovalAt`) + `archived`/`pruned`; render on `web/components/chrome/left-rail.tsx` (portfolio rail), board, and run-detail. Countdown computed via `Intl` with `suppressHydrationWarning`. LOGGING: n/a. Files: `web/lib/queries/portfolio.ts`, board/run-detail read models, `left-rail.tsx`, board card, run-detail. (depends on T1.3, T1.1)
- [ ] **T5.3** — i18n EN+RU: add `run.recover`, `run.recoverConfirm`, `run.discard`, `run.discardConfirm`, `run.crashReason.*`, `gc.ttl.active|warning|due`, `gc.archived`, `gc.pruned` to `web/messages/en.json` + `web/messages/ru.json` (mirror the existing `scratch.*` / `portfolio.workspaceAction` structure). LOGGING: n/a. Files: `web/messages/en.json`, `web/messages/ru.json`. (depends on T5.1, T5.2)
- [ ] **T5.4** — Playwright e2e (seeded, authed; dedicated test DB) `web/e2e/m19-reconcile-gc.spec.ts`: (a) seed a `Running` run with a dead supervisor session past grace → run reconcile → board shows distinct Crashed card → Recover (mock adapter) resumes → progresses; (b) Discard → run becomes Abandoned + worktree shows the TTL countdown (NOT removed synchronously); then a cron/GC sweep preserves (archive branch present) + prunes it; (c) an Abandoned run with `scheduled_removal_at` inside the warning window renders the amber/red TTL ramp; (d) cron route with valid token prunes a past-deadline workspace, wrong/empty token → 401/503. Confirm the spec is in the e2e project's glob. LOGGING: n/a. Files: `web/e2e/m19-reconcile-gc.spec.ts`, seed helpers. Final gate: `pnpm --filter maister-web typecheck` 0 · `test:unit` · `test:integration` · `test:e2e` · root `pnpm validate:docs:all` — all green. (depends on T5.1, T5.2, T5.3, T4.4)
<!-- Commit checkpoint: T5.1–T5.4 -->

### Final gate
- [ ] `pnpm --filter maister-web typecheck` (0) · `pnpm --filter maister-web test:unit` · `pnpm --filter maister-web test:integration` · `pnpm --filter maister-web test:e2e` (M19 spec + prior specs) · `pnpm validate:docs:all` — all green · roadmap: tick M19 in `.ai-factory/ROADMAP.md` + Completed table (done by `/aif-verify`, not here).

---

## Risks / watch-items

- **Graph-run mid-turn resume** (T3.1) is the heaviest unknown: live-agent graph `--resume` has never been CI-verified (only the M8 mock-adapter spike + M0 single-session live spike). The spike sub-step de-risks it; if continuation semantics prove unsafe, fall back to `redispatch` (re-run node fresh) for agent nodes too, and reflect that in ADR-034 before coding T3.2.
- **Periodic reconcile vs the "no polling" house rule**: the sweep polls `listSessions`/`listWorktrees`. It is the sanctioned *recovery* path (heartbeat + reconcile), NOT a live-path transition; ADR-033 must state this explicitly so reviewers don't read it as a banned poll.
- **Sweep disjointness**: reconcile, `resume-recovery`, and `takeover-return` all scan non-terminal runs. A regression that lets two sweeps act on one run is the top correctness risk — the exclusion predicates (T2.2) need integration coverage.
- **`cli` retry-safety is convention-based (Codex F4)**: M19 treats every `cli` node as non-idempotent (→ Crash, no auto-redispatch) and `check`/`judge` as retry-safe. This is a heuristic — a `command_check` that writes files is technically a side-effecting "gate". If that proves too coarse, add a manifest `retry_safe: true` opt-in (later milestone) rather than widening the auto-redispatch set.
- **GC snapshot commit mutates the terminal run branch (Codex F1)**: preserving dirty state advances the run branch HEAD with a `maister: GC snapshot` commit before archiving. This is intentional and safe (the run is terminal, the worktree is being deleted, the commit is captured on `maister/archive/<runId>`), but reviewers should expect the archive branch to carry one extra synthetic commit over the last agent commit.

---

## Resolved during refinement (Codex pass)

- **Discard lifecycle** (was Q2): RESOLVED → Discard marks `Abandoned` + enters the GC countdown (no synchronous worktree removal); GC sweep preserves-then-prunes. Immediate force-delete deferred to Phase 2. (§3.2, T3.3.)
- **Recover durable marker** (Codex #1): RESOLVED → `runs.resume_started_at` + Phase-1-before-side-effect ordering; reconcile engine owns all crash windows. (§3.2, T1.1/T3.1.)
- **Phase 3 ↔ Phase 4 ordering** (Codex #2): RESOLVED → discard no longer depends on `preserveWorktree`. (T3.3.)
- **Gate commands** (Codex #4): RESOLVED → all gates use `pnpm --filter maister-web …` + root `pnpm validate:docs:all`. (Commit Plan, T2.4/T3.4, Final gate.)

## Unresolved questions (ответьте кратко)

1. **GC «preserve»**: подтвердить — архив = отдельная ветка `maister/archive/<runId>` (+ опц. push), БЕЗ авто-merge в main/target? (план исходит из этого; merge-в-main = M18).
2. **`MAISTER_CRON_TOKEN`** сейчас (общий секрет), или ждать токены M16? (план — общий секрет сейчас.)
3. **RBAC**: новый action `recoverRun`=`member`, или переиспользовать `launchRun`?
4. **GC возраст/окно**: 14 дней + предупреждение 2 дня — ок как дефолты?
5. **Reconcile «reattach»** живой сессии после рестарта web: переподключать драйвер или проще пометить и дать пользователю Recover вручную? (план — авто-reattach.)
6. **Reconcile grace**: `MAISTER_RECONCILE_GRACE_SECONDS=90` — ок? (защищает запускающиеся/восстанавливаемые сессии от ложного crash.)
