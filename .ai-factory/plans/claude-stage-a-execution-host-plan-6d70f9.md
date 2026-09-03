# Implementation Plan: Stage A — Local Execution-Host Contract

**Branch:** `claude/stage-a-execution-host-plan-6d70f9` (harness-created isolated
worktree branch; used as-is — rename to `feature/stage-a-execution-host-contract`
together with this file in one commit at the start of `/aif-implement` if the
`feature/` convention is wanted; consumers derive the plan stem from the branch)
**Created:** 2026-09-02 · **Improved:** 2026-09-02 (`/aif-improve`, SDD + TDD pass)
**Mode:** Full · spec-driven (Phase 0 specs are the SSOT) · TDD implementation
(RED → GREEN → REFACTOR per task) · docs-first Phase 0 inside this branch

## Improve-pass changelog (2026-09-02)

Owner accepted all 11 recommendations. Applied:

1. **D1 pin semantics changed:** a pinned `MAISTER_EXECUTION_HOST_KEY` that
   conflicts with the stored key REFUSES BOOT (exit 1) instead of overriding
   with WARN (X-EH-01).
2. **Logical holes closed by the self-review:** teardown-class commands are
   allowed under a `released` assignment (X-EH-20; the orchestrator park
   checkpoint would otherwise be locally fenced); driver **yield rule** on
   `assignment_fenced` so an evicted incarnation never writes run state
   (E-EH-11, X-EH-19); an evicted session's pending prompt returns 409
   `FENCED`; post-acceptance transport failure does ONE receipt lookup before
   classification (X-EH-15); ledger retries reuse a command id ONLY for
   unknown-outcome failures (X-EH-14); in-flight join applies to every command
   kind (X-EH-08); the dead ">1 active host rows" refusal is removed (the
   partial unique index makes it unreachable) and replaced by "no registered
   local host → skip"; assignments are minted only on the run-INSERT branch of
   launch (the ADR-150 adopted-run branch inserts nothing); `execution_commands`
   gets a retention prune; `SupervisorErrorBody` gains a typed
   `details.reason` so tests assert tokens, not message text.
3. **Ordering hole closed:** the e2e in-process test supervisor moves to
   Phase 2 (T2.6) so the Playwright lane stays green through the migration
   waves; T5.1 only flips it strict.
4. **SDD structure added:** Appendix A (requirements R-xx, expectations
   E-EH-xx with their enforcement point, edge cases X-EH-xx, traceability to
   tests), Appendix B (wire schemas field-by-field), Appendix C (authoritative
   migration SQL), Appendix D (test-level ownership matrix + TDD protocol +
   anti-trivial-test rules).
5. **Every implementation task rewritten as RED / GREEN / REFACTOR** with
   named test cases mapped to spec ids, and shared test doubles
   (`fake-execution-host.ts`, `real-supervisor.ts`) introduced once in Phase 3
   so the 89 existing supervisor-fake test files migrate to ONE helper (DRY).
6. Indexes added: `runs_execution_assignment_idx`, `run_sessions_host_session_idx`,
   `run_sessions_assignment_idx`, `node_attempts_assignment_idx`.

## Settings

- **Testing:** YES — TDD. Each implementation task lists its RED tests first
  (file, runner project, cases by spec id), then the minimal GREEN, then the
  REFACTOR targets. Test levels are owned per Appendix D so no behavior is
  asserted twice at different levels. No trivial tests (Appendix D §D.3).
  Phase exits require the suites named in §Phase exit gates to be green and
  regressions judged on test NAME sets, never counts.
- **Logging:** VERBOSE — pino structured fields on every host interaction
  (`hostKey, bootId, assignmentId, assignmentEpoch, commandId, commandKind,
  runId, hostSessionId, attempt, state, latencyMs, outcome, replayed`). NEVER
  prompt bodies, `payload` contents, env values, tokens, or filesystem paths
  above `debug`. `LOG_LEVEL` controls verbosity.
- **Docs:** YES — mandatory. Phase 0 specs are the single source of truth for
  every later task (`Designed` tags); Phase 7 flips to `Implemented`
  (as-built checkpoint). `pnpm validate:docs` + redocly + asyncapi validators
  at every phase exit.

## Roadmap Linkage

Milestone: "none"
Rationale: no existing milestone names execution hosts / remote supervisors /
multi-host (`.ai-factory/ROADMAP.md` grep: zero hits). Skipped per request.

## Preflight — reserved identifiers (verified 2026-09-02)

| Namespace | Verified source | Reserved |
| --- | --- | --- |
| ADR | `git show main:docs/decisions.md` → max `### ADR-162` (main HEAD `73fa99915`); ADR-163 squatted by unmerged local branch `claude/flow-target-delegation-178968` | **ADR-164** (stub header written in T0.1 before any citation) |
| Drizzle migration | `_journal.json` max `idx 127` / `0127_output_contract`, snapshot present, `when` monotonic (last `1788257531779`); no local branch carries `0128+` | **`0128_execution_hosts`** (single additive migration; Appendix C) |
| Engine version | untouched | — |
| Supervisor OpenAPI / AsyncAPI | both `v0.7.0` | bump to `v0.8.0` |
| Web OpenAPI | untouched (no new web route) | — |

T7.3 re-verifies at main HEAD after rebase; if ADR-163's branch dies first, ADR-164
stays (gaps allowed; migration journal already has gaps 64/69/74/75).

---

## Goal

Refactor the single-host Web Core ↔ Supervisor integration so Web Core addresses
execution through a durable **execution host** identity, a durable per-run
**execution assignment** with a monotonically increasing **epoch**, an opaque
host-scoped **execution workspace** handle, a unique **command id** on every
host-bound command, and load-bearing **fencing** at the execution boundary —
while everything stays deployable on one host with loopback HTTP and the
current shared filesystem, and every current user-visible behavior is preserved.

### Stage A boundary (out of scope — seams only, §D12)

Remote transport / relay / enrollment / multiple simultaneous hosts / placement /
host UI / object storage / canonical host→web event ingestion / removal of
`run.events.jsonl` / moving git, diff, checks, artifacts to the host / cross-host
ACP resume / cloud provisioning / multi-repo materialization / swarm / long-lived
agent identity.

---

## Verified current state (load-bearing findings — read before implementing)

1. **One URL, no routing model.** `web/lib/supervisor-client.ts:420-422` is the
   ONLY place a supervisor URL is built (`MAISTER_SUPERVISOR_URL ?? http://
   localhost:7777`). 17 exports, ~102 non-test call sites in ~30 files (§D10),
   no auth header, no retry anywhere in the web tier, no timeout on
   `sendPrompt`/`streamSession` (`undici Agent({headersTimeout:0, bodyTimeout:0})`).
2. **ADR-023 is the truth.** `docs/architecture.md:71, 415-418` claim the
   supervisor "MAY run on a different host"; the code refutes it: the browser
   stream route `web/app/api/runs/[runId]/stream/route.ts:105-116` tails
   `run.events.jsonl` via local `node:fs`; `docs/deployment.md:114-116` requires
   an identical `MAISTER_RUNTIME_ROOT`; worktree/diff/promotion are web-side git
   ops. Shared filesystem is REQUIRED today.
3. **The supervisor is fully in-memory and unauthenticated.** `SessionRegistry`
   (`supervisor/src/registry.ts:47`) is a `Map` rebuilt empty at boot; no
   startup reconciliation, no host identity, no state dir. Durable per-run
   artifacts: `<stepId>.log`, `run.events.jsonl`, `cost.jsonl` under
   `<MAISTER_RUNTIME_ROOT>/.maister/<projectSlug>/runs/<runId>/`
   (`spawn.ts:143-163`, `cost.ts:66-73`) with body-controlled path segments.
   **No `supervisor/src/checkpoint.ts`**: checkpoint is the inline handler at
   `http-api.ts:913`. Binds `0.0.0.0:7777`.
4. **`node:sqlite` is already a production pattern** on both sides
   (`supervisor/src/adapter-smoke-cache-lock.ts`, `web/lib/agents/
   materialization-lock.ts`) with vitest shims in both workspaces. CI runs
   Node 24. → host state store uses `node:sqlite`; no new dependency.
5. **Two session id spaces, asymmetrically persisted.** The supervisor
   `sessionId` is persisted ONLY for scratch (`scratch_runs.supervisor_session_id`);
   flow/agent runs `listSessions()`-scan by `acpSessionId`, `(runId, stepId)`
   or `runId`. `run_sessions.acp_session_id` is written only AFTER the prompt
   returns for flow runs (`runner-graph.ts:3281-3292`), hence reconcile's second
   index (`reconcile.ts:1054-1057`). → the ledger records `{hostSessionId,
   acpSessionId}` at acceptance and `run_sessions.host_session_id` closes it.
6. **Probable identity bug** at `web/lib/services/hitl.ts:3545`
   (`checkpointBudgetLiveSession` passes `run_sessions.acp_session_id` to
   `checkpointSession()`, keyed by the supervisor's own id at `http-api.ts:928`).
   T4.2 reproduces first, then fixes through the branded `HostSessionId`.
7. **Prompt completion is HTTP-only.** `POST /sessions/:id/prompt` blocks for the
   turn (`http-api.ts:579-745`); no turn-completed SSE event exists. Every SSE
   event is appended to `run.events.jsonl` (`registry.ts:84`). → the new
   `session.command` event rides this durable channel.
8. **Launch ordering** (`web/lib/services/runs.ts:775-1960`): health → package
   pin adopt → preconditions → `addWorktree` → ONE tx (`runs`, `run_sessions`,
   `workspaces`, task latch; `:1648-1850`; the ADR-150 branch may ADOPT an
   existing run and insert nothing) → `tryStartRun` → `void runFlow(runId)`.
   The FIRST supervisor call for a flow run is inside `runAgentStep`
   (`runner-agent.ts:867-885`). Scratch creates its session right after its tx
   (`scratch-runs/service.ts:1083`).
9. **Placement re-entry points** (each already a CAS claim): `resume.ts:230-267`,
   `recover.ts` (`driveResume`), `scratch-runs/[runId]/recover/route.ts:373`,
   `agents/launch.ts:2800-2810` (`messageChildRun` idle), `gate-chat.ts:1060`
   (`chatResume`), `state-transitions.ts:288` (`markResumedFromWait`), `:790`
   (`markReturnedToRunning`), `sync-resolver.ts:219`, node-interrupt restart.
10. **Six DI facades** typed `typeof <client fn>` (`runner-agent.ts:116-137`,
    `agents/launch.ts:3022`, `scratch-runs/events.ts:70`, `gate-chat.ts:305`,
    `sync-resolver.ts:42`, `agent-question.ts:77` / `workbench-lifecycle/
    service.ts:165`) + function injection in reconcile / sync-recovery /
    hook-trip / node-interrupt / recover / resume-recovery / probe-service. 89
    test files build these fakes (list in §T4).
11. **Paths in the wire contract.** `StartSessionRequest` carries `worktreePath`
    (cwd, ACP `session/new|resume` cwd, `path_guard` root, confinement root),
    `repoPath`, `confineRoot`, `contextMounts[].path`, `capabilityProfilePath`
    (inside the worktree) plus path-segment ids `projectSlug`, `runId`, `stepId`.
    `GET /sessions` echoes every raw path. Worktrees: `<MAISTER_WORKTREES_ROOT
    (~/.maister/worktrees)>/<slug>/<runId>` (`runs.ts:1358-1361`); agent cwds:
    `agentWorkdirPath` = the same root (`agents/launch.ts:630`), shared trees
    `sharedAgentWorktreePath`, `repo_read` on the parent checkout =
    `projects.repo_path` (`:1037`, `:3313`), read-only ephemeral checkouts
    `agentReadOnlyWorkdirPath`; local packages under `~/.maister/local`.
12. **Reusable patterns:** `scheduled_task_launches` (state + `claim_fence` +
    shape CHECK, `schema.ts:1078-1198`) for assignments; `webhook_deliveries`
    (`:5760`) for command delivery state; `takeSchedulerLock` (`scheduler.ts:87`);
    `startMainPostgresTestDbUpTo` + `applyMainMigration` (`test-support/
    pg-container.ts:333-346`); enums are `text` + `check()` (zero `pgEnum`).
13. **Test topology.** Web `integration` globs `lib/**/*.integration.test.ts`,
    `app/**/*.integration.test.ts`; supervisor `integration` globs
    `src/**/*.integration.test.ts`; fake adapters `supervisor/test/fixtures/*.mjs`
    via `spawnOverrides.binary` or `MAISTER_ADAPTER_BINARY_<AGENT>`. Web
    integration tests mock the seam in-process; Playwright boots the in-process
    `web/e2e/_seed/test-supervisor.ts` (port 7788). CI: unit + supervisor
    integration always; web integration behind the `integration` label; e2e and
    docs gates local only.
14. **Deployment.** Only Postgres is in compose (ADR-023). Env lives in
    `.env.example`, `deploy/maister.env.example`, `supervisor/.env.sample`,
    `web/.env.sample`, and the canonical table `docs/configuration.md:1005-1115`.
    `Dockerfile:70` pre-creates `/app/.maister`; `.gitignore:40` ignores `.maister/`.
15. **`MaisterError` supports `details`** (`errors-core.ts:60`, ADR-093) but
    `asMaisterError` (`supervisor-client.ts:441-468`) drops it; the supervisor
    error body is `{code, message}` only. → typed `details.reason` (Appendix B).
16. **`run-transcript-projector.ts`** branches on `RESET_EVENT_TYPES.has(type)`
    and otherwise ignores unknown types (`:171`, `:456`) — `session.command`
    lines are safe once a test pins it (T2.4).

---

## Target design — decisions (locked)

### D1. Execution-host identity bootstrap and persistence

- **Minting:** the supervisor mints `hostKey = "eh_" + randomUUID()` without
  dashes (regex `^[A-Za-z0-9_-]{8,64}$`) on first boot into the host state
  store (`<MAISTER_EXECUTION_HOST_STATE_DIR>/state.sqlite`, `node:sqlite`, WAL,
  `synchronous=NORMAL`). A per-process `bootId` (`randomUUID()`) marks restarts.
- **Pin (accepted change):** `MAISTER_EXECUTION_HOST_KEY` applies when no key
  is stored (first boot, restored state dir, migration to a new machine) or when
  it equals the stored key. A pin that CONFLICTS with a stored key refuses boot:
  fatal log `execution-host-key-conflict {storedKeyPrefix, pinnedKeyPrefix}` +
  remediation ("unset the pin, or deliberately wipe the state dir"), exit 1
  (X-EH-01). No silent identity change is possible.
- **State dir:** `MAISTER_EXECUTION_HOST_STATE_DIR`, default
  `<MAISTER_RUNTIME_ROOT>/.maister/execution-host/` (runtime-root-relative so
  per-lane runtime roots never collide; inside gitignored `.maister/`).
  Supervisor-private; the web never reads it. Tables: `host_identity`,
  `run_fences`, `workspaces`, `command_receipts`. Unwritable dir → fatal boot
  error `execution-host-state-unwritable`.
- **Web resolution:** `ensureLocalExecutionHost()` at startup (before
  `runResumeRecoverySweep`) and lazily by the resolver (memoized 30 s):
  `GET /health` on `MAISTER_SUPERVISOR_URL` → `host.{hostKey, bootId,
  protocolVersion}` → upsert `execution_hosts` (`kind='local_direct'`,
  `transport={"kind":"local_direct"}`). The URL is transport configuration read
  at call time by the local-direct transport; never stored, never a domain concept.
- **Identity-change policy** (`registerLocalHost()`; the partial unique index
  guarantees at most one non-retired `local_direct` row):

  | Observed | Action |
  | --- | --- |
  | no active local row | insert; INFO `execution-host-registered` |
  | active row, same key | touch `last_seen_at`, `last_boot_id`, `capabilities`, `readiness='ready'`; bootId changed → INFO `execution-host-restarted` + one debounced `runReconcileSweep()` |
  | active row, different key, old row owns ZERO `active` assignments of non-terminal runs | retire old (`retired_at`), insert new; WARN `execution-host-retired-idle` |
  | active row, different key, old row still owns non-terminal runs | REFUSE: rows unchanged, `readiness='unavailable'`, `readiness_reason='identity_changed'`, ERROR with remediation (pin the old key on the new supervisor, or stop/abandon the listed runs); every command issue fails `EXECUTOR_UNAVAILABLE {details.reason:"host_identity_mismatch"}` (X-EH-02) |
  | health unreachable/malformed | rows unchanged; `readiness='unavailable'` (+reason) at most once per 30 s; launches keep today's 503 |

- **Capabilities/readiness:** `capabilities = {protocolVersion, supervisorVersion,
  adapters[]}`; `readiness ∈ {unknown, ready, unavailable}` + `readiness_reason`;
  refreshed only by the registrar (no new scheduler job).
- **Survives restarts:** hostKey, fences, receipts, workspace handles. Not:
  live sessions (unchanged).
- **New env vars (supervisor only):** `MAISTER_EXECUTION_HOST_STATE_DIR`,
  `MAISTER_EXECUTION_HOST_KEY`, `MAISTER_WORKSPACE_ROOTS` (D7). None on the web.

### D2. Assignment scope and schema

One Run ↔ at most one `active` assignment ↔ one host; the workspace handle is
run-scoped and lives on the assignment. Verified against every path:

| Path | Workspace | Sessions | Verdict |
| --- | --- | --- | --- |
| Flow run, own tree | 1 worktree | N sequential sessions (ADR-114) + gate-chat sub-session on a live `NeedsInput` run | one assignment per incarnation; all its sessions share it |
| Orchestrator child, `workspace_mode=shared` | parent's worktree (no own `workspaces` row) | own sessions | own assignment; adopting the same path yields its own handle (handles keyed `(runId, realpath)`) |
| Scratch run | 1 worktree | 1 long-lived session, many turns | one assignment; recover route mints |
| Local-package assistant (`runs.project_id` NULL) | `local_packages.working_dir` | 1 read-only session | kind `directory` |
| Agent `worktree` / `repo_read` parent checkout / `repo_read`+`workspace_ref` / `none` | `agentWorkdirPath` / `projects.repo_path` / `agentReadOnlyWorkdirPath` / `agentWorkdirPath` (plain dir, `launch.ts:3330`) | 1 session | `git_worktree` / `repo_checkout` / `directory` / `directory` |
| Consensus participants | child runs | — | own assignments |
| Orchestrator parent parked `WaitingOnChildren` | — | none live | `released` on park; `markResumedFromWait` mints |
| Branch-sync AI resolver on `Review` | existing worktree | 1 session | mints `sync_resolver` |
| Gate chat on `NeedsInputIdle` / on live `NeedsInput` | existing worktree | resumed / live session | mints `gate_chat` / reuses current |
| Rework return / node-interrupt restart / recover | existing worktree | new incarnation | mints |

Attribution: `run_sessions.execution_assignment_id` (updated per spawn),
`node_attempts.execution_assignment_id` (stamped at attempt start, immutable);
full spawn history = `execution_commands` rows of kind `session.create`.

Schema: Appendix C (authoritative SQL) mirrors this pseudo-shape:

```ts
execution_hosts        { id PK, host_key UNIQUE, kind CHECK('local_direct'), display_name, transport jsonb,
                         capabilities jsonb DEFAULT '{}', readiness CHECK('unknown'|'ready'|'unavailable'),
                         readiness_reason?, last_boot_id?, last_seen_at?, registered_at, updated_at, retired_at? }
execution_assignments  { id PK, run_id FK CASCADE, execution_host_id FK RESTRICT, epoch >= 1,
                         state CHECK('active'|'superseded'|'released'), placement_reason CHECK(10 tokens),
                         execution_workspace_id?, workspace_adopted_at?, lease_expires_at? (reserved, always NULL in Stage A),
                         superseded_by_id? self-FK SET NULL, released_reason?, created_at, updated_at, ended_at? }
execution_commands     { id PK (= command id), run_id FK CASCADE, execution_assignment_id FK CASCADE,
                         execution_host_id FK RESTRICT, assignment_epoch, kind CHECK(8 tokens), target_session_id?,
                         payload jsonb DEFAULT '{}' (REDACTED), state CHECK(6 tokens) DEFAULT 'queued', attempts DEFAULT 0,
                         max_attempts, next_attempt_at?, delivering_since?, accepted_at?, completed_at?, result?, last_error?,
                         driverless bool DEFAULT false, created_at, updated_at }
runs          + execution_assignment_id? FK SET NULL (circular via AnyPgColumn, like parent_run_id)
run_sessions  + execution_assignment_id? FK SET NULL, host_session_id?
node_attempts + execution_assignment_id? FK SET NULL
```

`scratch_runs.supervisor_session_id` stays (scratch dialog owns it) and is
mirrored into `run_sessions.host_session_id`; the mirror is removed in Stage B.

### D3. Epoch authority and fencing enforcement

- **Authority = Postgres.** `mintAssignment(tx, {runId, hostId, reason})` runs in
  the same tx as the placement CAS: `SELECT … FOR UPDATE` the active row → set
  `superseded` (+`superseded_by_id`, `ended_at`) → insert `epoch =
  COALESCE(max,0)+1` (the `(run_id, epoch)` UNIQUE + partial active UNIQUE are
  the race backstops; `23505` maps to `CONFLICT`) → `UPDATE runs SET
  execution_assignment_id`. The new row copies `execution_workspace_id` forward
  when the host is unchanged (Stage A: always).
- **Epoch = driver-ownership generation.** Minted exactly when a driver takes
  over a run with no live driver (reasons: `launch`, `resume`, `recover`,
  `wait_resume`, `rework_return`, `gate_chat`, `sync_resolver`,
  `scratch_recover`, `node_interrupt`, `legacy_backfill`). Session switches
  inside one `runFlow`, gate chat on a live session, and prompt turns reuse
  the current epoch. Mint happens ONLY on the run-INSERT branch of launch.
- **Release** (`released`, `released_reason`) via `releaseAssignmentForRun(tx,
  runId, reason)` from the transitions that end an incarnation
  (`markCheckpointed`, `markCheckpointedFromExit`, `markWaitingOnChildren`,
  `markAbandoned`, `crashRunningRun`, `crashResumedRun`, `crashWaitingOnChildren`,
  `failResumedRun`, `rollbackResumedRun` (`released_reason='resume_rollback'`),
  `runFlow` terminal writers, `finalizeAgentRun`, scratch crash/stop/discard,
  workbench stop, budget terminate / time-limit kill, reconcile crash). Release
  is ADVISORY for fencing (the next mint supersedes anything), so correctness
  never depends on the fan-out; the sweep is the backstop (`active` assignment
  whose run is parked/terminal → `released`, reason `sweep`, WARN once).
- **Command admission by assignment state (accepted fix, X-EH-20):**
  `active` → all kinds; `released` → teardown kinds only (`session.checkpoint`,
  `session.delete`, `session.cancel`, `session.input{action:"cancel"}`,
  `workspace.release`); `superseded` → nothing (local `fenced`, no wire call).
  `session.create`, `session.prompt`, `session.input{select}`, `workspace.adopt`
  require `active`.
- **Host enforcement:** every enveloped command carries
  `fence = {hostKey, assignmentId, assignmentEpoch, runId}`. The host keeps
  `run_fences(run_id PK, assignment_id, epoch, updated_at)` in sqlite, written
  BEFORE execution, mirrored in memory. Rules in order: `hostKey ≠ own` → 409
  `PRECONDITION host_mismatch`; `epoch < stored` → **409 `FENCED`**
  (`details: {reason:"assignment_fenced", runId, commandEpoch, hostEpoch}`);
  `epoch = stored ∧ assignmentId ≠ stored` → 409 `PRECONDITION
  assignment_mismatch`; `epoch > stored` → persist, then **evict** every live
  session of that run under a lower epoch (cancel its deferreds,
  `markIntentionalShutdown(reason="fenced")`, SIGTERM with kill grace,
  `session.exited {reason:"fenced"}`; its pending prompt request answers 409
  `FENCED`), then execute. Session routes also require `fence.runId ===
  record.runId` → 409 `PRECONDITION run_mismatch`.
- **After a host restart** fences reload from sqlite; if the state dir is lost,
  the first command re-establishes the high-water (documented degradation).
- ACP sessions stay host-affine; no cross-host migration.

### D4. Command envelope and state machine

Envelope (JSON body on every host-bound mutating route; the session id stays in
the URL): `{ command: {id, kind, issuedAt}, fence: {hostKey, assignmentId,
assignmentEpoch, runId}, payload: {…} }` (Appendix B).

| Kind | Route | Effect | Duration | Completion signal(s) |
| --- | --- | --- | --- | --- |
| `workspace.adopt` | `POST /workspaces/adopt` | register path → handle (idempotent on `(runId, realpath)`) | immediate | HTTP 200 |
| `workspace.release` | `DELETE /workspaces/{id}` | unregister handle | immediate | HTTP 200 |
| `session.create` | `POST /sessions` | spawn + ACP handshake | ≤ 60 s | HTTP 201 `{sessionId, pid, acpSessionId}` |
| `session.prompt` | `POST /sessions/{id}/prompt` | start a turn | long | SSE `session.command{accepted}` → HTTP 200 `{stopReason}` and/or SSE `session.command{completed}` and receipt |
| `session.input` | `POST /sessions/{id}/input` | resolve a deferred | immediate | HTTP 200 |
| `session.cancel` | `POST /sessions/{id}/cancel` | ACP cancel | immediate | HTTP 200 |
| `session.checkpoint` | `POST /sessions/{id}/checkpoint` | cancel deferreds + SIGTERM + wait | ≤ kill grace | HTTP 200 + SSE `session.exited{reason:"checkpoint"}` |
| `session.delete` | `DELETE /sessions/{id}` | SIGTERM/SIGKILL | ≤ kill grace | HTTP 204 + SSE `session.exited` |

State machine (`execution_commands.state`):

```
queued ──(claim: attempts+1, delivering_since)───────────────▶ delivering
delivering ──(2xx, immediate kind)────────────────────────────▶ succeeded
delivering ──(prompt: SSE accepted OR receipt phase=accepted)─▶ accepted
delivering ──(unknown-outcome failure, attempts < max)────────▶ queued (next_attempt_at)
delivering ──(definitive error OR attempts = max)─────────────▶ failed
delivering ──(409 FENCED)──────────────────────────────────────▶ fenced
accepted ──(HTTP 200 OR SSE completed OR receipt completed)───▶ succeeded
accepted ──(completion error, receipt turn_lost, receipt 404)─▶ failed
queued ──(assignment not admissible at delivery time)─────────▶ fenced   (no wire call)
queued ──(startup recovery, non-driverless kind)──────────────▶ failed {code:"ORPHANED"}
```

Terminal: `succeeded | failed | fenced`. Every transition is a CAS
(`UPDATE … WHERE id=$1 AND state IN (<expected>) AND attempts=$attempt`); a
late signal for a terminal row logs `command-late-signal` and is ignored.

### D5. Acknowledgement, retry, and crash semantics

- **Ordering:** (1) `queued` row committed (in the caller's tx where one exists);
  (2) wire call outside any tx; (3) ack tx AFTER the response together with the
  result-derived domain writes (`run_sessions.host_session_id`,
  `.acp_session_id`, `.execution_assignment_id` for create;
  `execution_assignments.execution_workspace_id` + `workspace_adopted_at` for
  adopt). Idempotency markers are `accepted_at` / `completed_at`.
- **Classification per attempt (web):**

  | Host response | Class | Row | Caller sees |
  | --- | --- | --- | --- |
  | network error, timeout, non-JSON 5xx (outcome UNKNOWN) | retry SAME command id up to budget, then `failed` | `queued`+backoff | `EXECUTOR_UNAVAILABLE` after budget |
  | parsed 503 `EXECUTOR_UNAVAILABLE` (definitive) | `failed`; the caller's own retry issues a NEW command (sweeper tick, user retry) — unchanged semantics | `failed` | `EXECUTOR_UNAVAILABLE` |
  | 409 `FENCED` | terminal | `fenced` | `CONFLICT {details.reason:"assignment_fenced"}` |
  | 404 / 410 / 409 `PRECONDITION` (any reason) | terminal | `failed` | existing per-endpoint mapping unchanged, `details` passed through |
  | 409 `PRECONDITION unknown_workspace` on create | terminal for this command | `failed` | client re-adopts ONCE and issues a NEW create |
  | prompt after `accepted`: transport failure | ONE receipt lookup: `completed` → `succeeded{stopReason}`; `accepted` w/o in-flight → `failed{turn_lost}`; 404 → `failed{receipt_missing}` | as looked up | `stopReason` returned to the driver when completed, else `ACP_PROTOCOL` |

  Budgets (unknown-outcome only): adopt 3 (0.5 s·2ⁿ), create 3 (1 s·2ⁿ),
  prompt 3 before acceptance / 0 after, input 3, cancel 3, checkpoint 3, delete 3
  (`driverless`), release 3 (`driverless`). Transport timeouts: adopt 10 s,
  create 60 s, input/cancel 10 s, checkpoint/delete 30 s, prompt none.
- **Crash windows (web death):**

  | Window | Row on restart | Recovery (`recoverExecutionCommands()`: startup + `system_sweep` pass) |
  | --- | --- | --- |
  | W1 after `queued`, before send | `queued` | driverless → deliver; else `failed{ORPHANED}` (existing reconcile handles the run) |
  | W2 after send, before ack | `delivering` older than 60 s | `GET /commands/{id}` → fold receipt + derived writes in one tx; 404 → treat as W1 |
  | W3 after ack, before domain write | impossible (same tx) | — |
  | W4 mid-prompt | `accepted` | receipt `completed` → `succeeded`; `accepted` w/o in-flight → `failed{turn_lost}`; run then follows existing reconcile |
  | host died between execute and receipt write | (host) | web retry re-executes; safe because non-durable effects died with the host and durable ones (adopt, fence, receipt) are idempotent/monotonic |

- **Driver yield rule (E-EH-11, accepted fix):** any command outcome carrying
  `details.reason="assignment_fenced"` (from the wire or locally) means THIS
  driver's assignment is superseded: the driver logs `driver-yielded` and
  returns WITHOUT writing run, node-attempt, HITL, or scratch state.
  `runAgentStep` returns `{ok:false, fenced:true}` and `runFlow` returns before
  any ledger/status write; scratch, agent, gate-chat, resume and sync drivers
  apply the same rule at their catch sites.
- **No second completion protocol:** completion rides the long-lived HTTP
  response AND the per-session SSE `session.command` event (also in
  `run.events.jsonl`) AND the receipt. `PromptHandle.completion` resolves from
  whichever durable signal arrives first (Stage B seam).
- **Poison:** attempts exhausted → `failed` + `last_error`; a `queued` row whose
  assignment is not admissible is `fenced` locally.
- **Retention:** terminal `execution_commands` rows older than 7 days are pruned
  by the `system_sweep` pass (constant, no env var); assignments are kept.

### D6. Supervisor-side idempotency persistence

`command_receipts(command_id PK, run_id, kind, epoch, phase
('accepted'|'completed'|'rejected'), http_status, body_json, received_at,
completed_at)`. Handler order for every enveloped route: parse envelope → fence
(D3) → receipt lookup: `completed|rejected` → replay verbatim + header
`X-Maister-Command-Replayed: true`; in-flight promise for that id (any kind) →
**join**; `accepted` without in-flight (restart mid-turn) → 409
`PRECONDITION turn_lost` (recorded `rejected`) → else execute → write receipt →
respond. Receipt write failure → 500 `ACP_PROTOCOL` (definitive; the effect may
have happened — X-EH-21 — and the existing reconcile catches an orphaned
session). Receipts prune at boot + hourly (7-day TTL). `GET /commands/{commandId}`
→ receipt or 404.

### D7. Workspace adoption and opaque addressing

- **Handle:** `executionWorkspaceId = "ws_" + uuid`, host-scoped, keyed
  `(runId, realpath)`; re-adoption returns the same id. Host row:
  `id, run_id, project_slug, kind, path, repo_path?, run_dir, context_mounts
  json?, adopted_at, released_at?`. `run_dir` is derived by the host from
  `runtimeRoot + projectSlug + runId` at adoption and stored — later routes
  derive every path from the handle.
- **Kinds and validation** (all: absolute, no `..`, realpath exists, no symlink
  escape, not inside the state dir; rule tokens in Appendix B):

  | Kind | Extra rule | Used by |
  | --- | --- | --- |
  | `git_worktree` | realpath under `MAISTER_WORKSPACE_ROOTS`; `.git` FILE whose `gitdir:` resolves under `<repoPath>/.git/worktrees/`; `repoPath` is a git repo root | flow, scratch, agent `worktree`, shared-tree children |
  | `repo_checkout` | path is a git repo root AND equals `repoPath` (arbitrary location, ADR-023) | agent `repo_read` on the parent checkout |
  | `directory` | realpath under `MAISTER_WORKSPACE_ROOTS`; `repoPath` absent | local-package assistant, ephemeral read-only checkouts, agent `none` |

  `MAISTER_WORKSPACE_ROOTS` (colon-separated absolute dirs), default
  `~/.maister/worktrees:~/.maister/local:<MAISTER_RUNTIME_ROOT>/.maister`. A
  moved `MAISTER_WORKTREES_ROOT` / `MAISTER_LOCAL_PACKAGES_ROOT` on the web MUST
  be mirrored here (documented in both env samples; a rejection at adopt time
  logs the remediation).
- **Adoption is the only path-bearing operation.** The web derives every value
  from server state (`workspaces.worktree_path`, `projects.repo_path`,
  `local_packages.working_dir`, the agent launch snapshot, `runs.context_mounts`)
  — never from any HTTP request body it received.
- **Session routes after the strict flip (T5.1):** `POST /sessions` payload =
  `{executionWorkspaceId, stepId, nodeAttemptId?, sessionName?, executor,
  runner?, resumeSessionId?, capabilityProfilePath?, adapterLaunch?, mcpServers?,
  readOnlySession?, autoApprovePermissions?, reapOnEndTurn?, hooksConfig?,
  enforcementProfile?}`. Removed: `runId, projectSlug, worktreePath, repoPath,
  confineRoot, contextMounts`. Residual path `capabilityProfilePath` is
  validated inside the handle's path (leaves with Stage C materialization).
- **When:** `ensureWorkspaceAdopted(assignment)` before the first
  `session.create` of an assignment (idempotent; skipped when the assignment
  carries a handle; on `unknown_workspace` from create it re-adopts ONCE and
  issues a new create). Launch paths are untouched.
- **Release:** `workspace.release` (`driverless`) from the GC workspace
  reconciler after worktree removal and from run terminalization that drops
  the workspace; a released handle refuses create (`workspace_released`).
- **Restart/reconcile:** handles persist in host sqlite; reconcile adds a
  read-only `GET /workspaces/{id}` check for `active` assignments → 404 → WARN
  `workspace-handle-lost` (self-heals on the next create).
- **Stage C seam:** `POST /workspaces/materialize` returns the same handle type.
- **Clean-room inspiration (Superset, architectural ideas only):** a workspace
  lives on the machine that hosts its files; a host daemon registers itself and
  claims itself to its user on first registration; clients address a specific
  host rather than an anonymous endpoint.

### D8. Restarts

- **Supervisor:** identity/fences/receipts/handles reload; new `bootId`; live
  sessions gone (unchanged). The registrar sees the bootId change →
  `runReconcileSweep()` once. Commands for dead sessions → 404/503 as today.
- **Web:** `instrumentation.ts` order: migrations check →
  `ensureLocalExecutionHost()` → `recoverExecutionCommands()` →
  `adoptLegacyActiveRuns()` → `runResumeRecoverySweep` →
  `runTakeoverReturnRecoverySweep` → `runReconcileSweep` → unchanged tail.
  Periodic `executionCommandReconcilePass` + `pruneExecutionCommands` join
  `runSystemSweep()` (no new `job_kind`).

### D9. Migration of current and active runs

- SQL migration additive-only, never data-dependent (Appendix C). Historical
  runs keep `execution_assignment_id = NULL` forever (documented meaning:
  "pre-Stage-A, never placed").
- **Evidence-based backfill at startup** (`adoptLegacyActiveRuns()`): runs with
  NULL assignment AND status ∈ `{Running, NeedsInput}`: a live session for the
  run on the local host (`GET /sessions`) → mint epoch 1
  (`legacy_backfill`); no live session → leave NULL (reconcile classifies).
  Parked/queued statuses are not touched; their next placement mints.
  No registered local host (registrar refused/unreachable) → skip, log once per
  boot, retry on the next sweep (X-EH-22).
- **Lazy assignment:** a command issuer meeting a NULL assignment calls
  `ensureAssignment(runId, "legacy_backfill")` (WARN `legacy-run-assigned-lazily`);
  deterministic because exactly one non-retired local host can exist. MUST be
  deleted in Stage C (recorded in ADR-164).
- Operator guidance: draining before upgrade is recommended, not required.

### D10. Compatibility strategy

- Module `web/lib/execution-host/`: `types.ts` (branded `HostSessionId`,
  `ExecutionWorkspaceId`, `AssignmentId`, `CommandId`; `ExecutionHostResolver`,
  `ExecutionHostTransport`, `CommandLedger`, `ExecutionHostClient` →
  `BoundClient` / `HostAdminClient`), `transports/local-direct.ts`, `hosts.ts`,
  `assignments.ts`, `commands.ts`, `redact.ts`, `ledger.ts`, `deliverer.ts`,
  `adoption.ts`, `recovery.ts`, `registrar.ts`, `resolver.ts`, `legacy.ts`,
  `client.ts`, `index.ts`. Dependency direction: `deliverer` depends on the
  `CommandLedger` and `ExecutionHostTransport` INTERFACES; neither the ledger
  nor the transport knows the other (DIP); per-kind policy is a data table
  (OCP: a new kind is a row, not a switch arm).
- **Waves** T4.1–T4.6; the six facade types are deleted and replaced by
  `BoundClient`; tests use ONE shared fake (`web/test-support/fake-execution-host.ts`).
- **Transitional wire acceptance (T2.2–T2.3):** envelope optional +
  `executionWorkspaceId` XOR legacy path fields (Zod union, WARN
  `legacy-unfenced-command`). T5.1 flips strict. A schema union, time-boxed in
  this branch — not a runtime flag.
- **Lint fence:** ESLint `no-restricted-imports` forbids `@/lib/supervisor-client`
  outside `web/lib/execution-host/**` and its own unit test. Admin surfaces use
  `executionHosts.local()` explicitly.

### D11. Ownership boundaries

| Owner | Owns (Stage A) | Does NOT own |
| --- | --- | --- |
| Web Core | run state machine; placement (assignments/epochs); command intent + delivery ledger; worktree creation, git ops, diff, promotion (transitional); browser event tailing (transitional shared FS); legacy backfill | process ownership; wire fence enforcement |
| Postgres | SSOT for hosts/assignments/commands/run state | host-private state |
| Local execution host | adapter processes + ACP sessions; identity; fence high-water; receipts; workspace registry + path validation; pipe-to-disk logs/events (transitional) | run state; placement; git |

### D12. Deferred to Stages B–E (seams only)

| Stage | Deferred | Seam prepared here |
| --- | --- | --- |
| B — durable event/data plane | host→web event ingestion; artifact reads via host API; retiring the `run.events.jsonl` tail and the long-lived prompt HTTP; dropping the `scratch_runs.supervisor_session_id` mirror | `PromptHandle`; `session.command`; receipts endpoint |
| C — host-owned FS/repos + multi-host | `POST /workspaces/materialize`; git ops on host; placement over N hosts; host UI; deleting `ensureAssignment`; `lease_expires_at` renewal | opaque handle on all session routes; `execution_hosts.kind/transport`; epochs + fences; `lease_expires_at` |
| D — trusted remote hosts | host auth/enrollment; relay/WebSocket; secret confinement via env-router proxy | `ExecutionHostTransport`; pin = enrollment hook; `transport jsonb` |
| E — cloud hosts | provisioner; ephemeral hosts | `retired_at` lifecycle; readiness model |

---

## Route identifier classification (every new or changed HTTP route)

Labels: `url-param` · `auth-context` (none: unauthenticated loopback, Stage D
adds host auth; documented limitation) · `server-state` (registry/sqlite lookup)
· `body-controlled` (validated as stated).

| Route | Identifier | Label | Handling |
| --- | --- | --- | --- |
| `GET /health` (changed: `+host{hostKey,bootId,protocolVersion}`) | — | — | no ids in; no paths out |
| `POST /workspaces/adopt` (new) | `command.id` | body-controlled | uuid; receipt dedup key |
| | `fence.*` | body-controlled | hostKey vs own (server-state) → `host_mismatch`; epoch vs `run_fences` (server-state) → `FENCED` |
| | `payload.runId`, `payload.projectSlug` | body-controlled | existing regexes; stored on the handle (become server-state for later routes) |
| | `payload.kind`, `payload.path`, `payload.repoPath?`, `payload.contextMounts[]?` | body-controlled (ONLY path-bearing route) | D7 matrix → 409 `PRECONDITION {reason:"workspace_rejected", rule}`; realpath stored |
| `GET /workspaces/{id}` (new) | `id` | url-param | 200 projection (no paths) / 404 |
| `DELETE /workspaces/{id}` (new) | `id` + envelope | url-param + body-controlled | fence checked against the handle's `run_id` (server-state) → `run_mismatch` |
| `GET /commands/{commandId}` (new) | `commandId` | url-param | receipt / 404 |
| `POST /sessions` (changed) | envelope | body-controlled | fence rules; `fence.runId === handle.run_id` → `run_mismatch` |
| | `payload.executionWorkspaceId` | body-controlled | registry lookup → `unknown_workspace` / `workspace_released`; cwd, confinement roots, run dir, mounts derived from the handle (server-state) |
| | `payload.stepId`, `sessionName`, `nodeAttemptId`, `resumeSessionId` | body-controlled | existing safe-segment regexes; `stepId` is a log-file segment under the handle's `run_dir` |
| | `payload.capabilityProfilePath` | body-controlled (residual path) | must resolve inside the handle's `path` → `workspace_rejected:outside_workspace` |
| | ~~`runId, projectSlug, worktreePath, repoPath, confineRoot, contextMounts`~~ | removed (T5.1) | presence → 409 `PRECONDITION legacy_field` |
| `POST /sessions/{id}/prompt` · `/cancel` · `/checkpoint` · `/input`, `DELETE /sessions/{id}` (changed: + envelope) | `id` | url-param | registry lookup → 404 unchanged |
| | envelope | body-controlled | fence rules + `fence.runId === record.runId` → `run_mismatch`; duplicate id → replay/join |
| | kind payloads | body-controlled | unchanged validation (content-block URI confinement against the handle's roots) |
| `GET /sessions` (changed) | — | — | projection `+executionWorkspaceId, assignmentId, assignmentEpoch, createdByCommandId`; `−worktreePath, repoPath, confineRoot, logPath, contextMounts` after T5.1 (T5.1 proves no web reader of `logPath`) |

No new **web** HTTP route. Web routes whose internals change (HITL respond,
node-interrupt, scratch recover/discard/interrupt/stop, workbench lifecycle)
keep their identifier model; their supervisor side effect goes through the ledger.

---

## DB + host operation matrix (per command kind)

| Kind | Issued by (after waves) | Intent tx contents | Result-derived writes (ack tx) | Terminal behavior for the caller | Crash windows |
| --- | --- | --- | --- | --- | --- |
| `workspace.adopt` | bound client before first create | command row | assignment `execution_workspace_id`, `workspace_adopted_at` | `PRECONDITION` (rejected) or `EXECUTOR_UNAVAILABLE` after budget → the driver's existing step-failure path | W1/W2; idempotent on host |
| `session.create` | runner-agent, scratch launch/recover, agents launch, resume/recover drivers, gate-chat idle resume, sync resolver | command row (+ the driver's own CAS claim when inside one) | `run_sessions.host_session_id`, `.acp_session_id`, `.execution_assignment_id`; `node_attempts.execution_assignment_id` (flow) | today's mapping; `unknown_workspace` → one re-adopt + fresh create | W2 fold yields the session identity mid-prompt (closes #5); an orphan session after W1 → existing reconcile |
| `session.prompt` | same drivers | command row | `accepted_at` on SSE accepted; `completed_at` + `result.stopReason` on any completion | unchanged (`STEP_CHECKPOINTED`, `end_turn`); `assignment_fenced` → yield | W4 fold; duplicate joins |
| `session.input` (select/cancel) | HITL respond (Phase 2 of its two-phase), auto-deliver on resume, persist-failure cancel paths | HITL `response` (existing) + command row in the same Phase-1 tx | `hitl_requests.responded_at` + command `succeeded` in one tx; `_audit.deliveredOptionId` from the result when it differs from the row's latest `response` | 410/503 unchanged (503 leaves `respondedAt` NULL; the user's retry issues a NEW command) | "no hidden deferred" contract kept: every failure path still cancels, now as a `session.input{cancel}` command |
| `session.cancel` | scratch interrupt, gate-chat lease timer/recovery | command row | none | unchanged (idempotent ack) | none material |
| `session.checkpoint` | keepalive P1, hook-trip, node-interrupt, budget escalate/park, orchestrator park | command row | none (`markCheckpointed*` follows on success as today) | unchanged: 503 → leave `NeedsInput`, retry next tick; 404/other → proceed to `markCheckpointed` | W2 fold; replay idempotent (`alreadyCheckpointed`) |
| `session.delete` (`driverless`) | runner-agent/resume-driver finally, scratch stop/discard, workbench stop, budget terminate, time-limit, eval reaper, agent-question activation, sync-target teardown, reconcile stale-session stop | command row | none | unchanged ("never terminal before teardown confirmed") | W1 rows re-delivered by recovery (idempotent kill) |
| `workspace.release` (`driverless`) | GC reconciler after worktree removal; run terminal drop paths | command row | host handle `released_at` | best-effort; 404 = gone | re-delivered by recovery |

---

## Contract surface trace (Phase 0 writes `Designed`; Phase 7 flips)

| Surface | Spec file(s) | Change |
| --- | --- | --- |
| Tables/columns/indexes | `web/lib/db/schema.ts`; `web/lib/db/migrations/0128_execution_hosts.sql` + `meta/_journal.json` + `meta/0128_snapshot.json` (Appendix C); `docs/database-schema.md` (new family section "Execution-host tables" + edits to `## runs`, `## run_sessions`, `## node_attempts`); `docs/db/execution-hosts-domain.md` (new) + `docs/db/README.md` row; `docs/db/runs-domain.md` FK lines; `docs/db/erd.dbml` regenerated | D2 |
| Supervisor HTTP | `docs/api/supervisor.openapi.yaml` 0.8.0 (Appendix B schemas; paths per §Route table; `HealthResponse.host`; `StartSessionRequest` handle shape with legacy fields `deprecated: true` until T5.1; `SessionRecord` projection; `SupervisorErrorBody.details`; `SupervisorErrorCode += FENCED`; `SendPromptStopReason += cancelled` (drift #8)); `docs/supervisor.md` prose | D3–D7 |
| Supervisor SSE | `docs/api/async/supervisor-sse.asyncapi.yaml` 0.8.0 (`session.command`; `session.exited.reason += fenced`; channel param = supervisor session id (drift #10)); `docs/api/async/web-runs.asyncapi.yaml` (`session.command` opaque pass-through) | D5 |
| Errors | `docs/error-taxonomy.md`: blockquote "ADR-164 adds NO new `MaisterError` code" (`CONFLICT` + `details.reason`, `EXECUTOR_UNAVAILABLE`, `PRECONDITION` reuse) + supervisor code table `FENCED` (409) + reason-token table; `docs/supervisor.md` §Errors | D5 |
| System analytics | NEW `docs/system-analytics/execution-hosts.md` (Appendix A is its content skeleton) + README row; cross-refs in `sessions.md`, `runs.md`, `hitl.md`, `reconciliation-gc.md`, `scratch-runs.md`, `agents.md`, `workspaces.md` | D1–D9 |
| ADR | `docs/decisions/adr-164.md` + stub + index; `docs/decisions/adr-023.md` amendment | all |
| Architecture | `docs/architecture.md` (component rows; Deployment rewrite: single host, shared FS REQUIRED, host addressing); `.ai-factory/ARCHITECTURE.md`; root `CLAUDE.md` §1/§7 note + §Conventions boundary rule; `.ai-factory/rules/backend.md` | D10/D11 |
| Env / state dir | `docs/configuration.md` rows; `.env.example`; `supervisor/.env.sample`; `deploy/maister.env.example`; `web/.env.sample` (comment); `docs/deployment.md` §5/§10/upgrade; `docs/getting-started.md` | D1/D7 |
| In-code SSOTs | `supervisor/src/types.ts` Zod schemas; `web/lib/execution-host/types.ts`; `web/lib/supervisor-client.ts` event union; `scripts/validate-contracts.mjs` (already lints both supervisor specs — T0.5 confirms it parses the new `$ref`s) | — |

---

## Deployment touchpoints

| Adds | Files (T6.1) |
| --- | --- |
| `MAISTER_EXECUTION_HOST_STATE_DIR` (supervisor) | `supervisor/.env.sample`, `.env.example`, `docs/configuration.md`, `docs/deployment.md` §5; `web/playwright.live.config.ts` supervisor `webServer.env` (`e2e/.runtime-live-supervisor/...`); e2e in-process supervisor configured programmatically |
| `MAISTER_EXECUTION_HOST_KEY` (supervisor, optional) | same files; live config pins a fixed key |
| `MAISTER_WORKSPACE_ROOTS` (supervisor) | same files + `docs/deployment.md` mirror rule; live config passes the lane's worktrees root; `web/test-support/real-supervisor.ts` passes the vitest lane root |
| State dir `<runtimeRoot>/.maister/execution-host/` | `docs/deployment.md`, `docs/getting-started.md`; verify `Dockerfile:70`, `.dockerignore`, `.gitignore` need no change; `scripts/blast-maister-local-state.mjs` reset scope (+ its `node --test`) |
| compose | `compose.yml` / `compose.production.yml` = Postgres only (ADR-023): reviewed, explicitly unchanged in T6.1 acceptance |
| sidecar / port / package | none (`node:sqlite` built-in) |

---

## Logging contract (all tasks)

- pino children: web `execution-host` (+ `component: ledger|deliverer|resolver|
  registrar|adoption|recovery|legacy`), supervisor `host-state`,
  `execution-fence`, `workspace-registry`, `command-receipts`.
- `debug`: every command transition, receipt lookup, fence compare, adoption
  validation step (path at debug only). `info`: host registered/restarted/
  retired, assignment minted/superseded/released, command succeeded (+latency),
  workspace adopted/released, eviction, driver yielded. `warn`: retry,
  legacy-unfenced-command, lazy legacy assignment, workspace-handle-lost, late
  signal. `error`: key conflict (fatal), identity-changed refusal, fenced
  command (web), state store unwritable, orphaned commands at recovery.
- Never: prompt text, payloads, env values, tokens, file contents.

---

## Commit Plan

- **Commit 1** (T0.1–T0.5): `docs(execution-host): Stage A contracts — ADR-164, execution-hosts analytics, OpenAPI/AsyncAPI 0.8.0, ERD (Designed)`
- **Commit 2** (T1.1–T1.3): `feat(db): execution_hosts / execution_assignments / execution_commands + attribution columns (migration 0128)`
- **Commit 3** (T2.1–T2.3): `feat(supervisor): host identity + state store, command fences and receipts, workspace adoption`
- **Commit 4** (T2.4–T2.6): `feat(supervisor): session.command events, contract parity, e2e test supervisor speaks the transitional contract`
- **Commit 5** (T3.1–T3.5): `feat(web): execution-host module — transport, registrar/resolver, ledger/deliverer, recovery, adoption client`
- **Commit 6** (T4.1–T4.3): `refactor(runs): flow launch/runner/HITL/sweeper/resume through the execution-host client`
- **Commit 7** (T4.4–T4.6): `refactor(runs): scratch/agents/gate-chat/sync/reconcile/admin through the execution-host client; lint fence`
- **Commit 8** (T5.1–T5.3): `feat(execution-host): strict envelope + opaque workspace contract, legacy backfill, legacy path removal`
- **Commit 9** (T6.1–T6.2): `chore(deploy): execution-host env wiring, live-lane smoke, deployment docs`
- **Commit 10** (T7.1–T7.3): `docs(execution-host): as-built flip to Implemented; e2e regression; renumber pass`

Conventional commits, no AI trailer (project convention).

---

## Tasks

Format of every implementation task: **Spec** (ids from Appendix A + contract
sections) · **RED** (test file, runner project, cases by id; each case must fail
for the intended reason before GREEN — Appendix D §D.2) · **GREEN** (files,
minimal behavior) · **REFACTOR** (named targets; suites stay green) · **Depends
on** · **Logging/Failure** · **Acceptance**. "Suite green" = the package's
`test:unit` + `test:integration`, `pnpm --filter maister-web typecheck`,
`pnpm exec eslint .` check-only (never `--fix`), `pnpm validate:docs`.

### Phase 0 — Specs first (all `Designed`)

- [x] **T0.1 Reserve numbers; ADR-164; ADR-023 amendment.**
  Deliverables: `docs/decisions/adr-164.md` (Context = §Verified condensed;
  Decision = D1–D12 incl. Appendix A/B/C by reference, the admission-by-state
  rule, the driver yield rule, the pin-conflict refusal, the accepted residual
  windows X-EH-21/X-EH-22, the Stage-C deletion obligation for `ensureAssignment`;
  Alternatives = per-session assignment, host-side epoch authority, async-only
  prompt, `better-sqlite3`, JSON fence file, pin-overrides-with-WARN, new
  `MaisterError` code, storing the URL in DB, auto-retire-always); stub + index
  row in `docs/decisions.md` (`Status: Proposed` until T7.2); `adr-023.md`
  `**Amendments:**` bullet dated 2026-09-02. Re-run the preflight commands and
  paste outputs into the ADR Context.
  Acceptance: `pnpm validate:docs` green (stub↔record bijection, anchors); no
  code cited without a `Designed` tag.
- [x] **T0.2 `docs/system-analytics/execution-hosts.md` + README row + cross-refs.**
  Deliverables: R5 structure filled from Appendix A verbatim: Purpose; Domain
  entities (host, assignment, command, workspace handle, receipt, fence);
  three `stateDiagram-v2` (host registration incl. the identity-change policy as
  transitions; assignment; command FSM exactly as D4); `sequenceDiagram`s for
  bootstrap+registration, launch → lazy adopt → create → prompt → completion
  signals, HITL respond Phase 1/2 via ledger, keepalive checkpoint → idle →
  resume mint → stale checkpoint FENCED → old driver yields, web crash W1/W2/W4
  recovery, supervisor restart, legacy backfill; the host refusal table
  (Appendix B §B.7); Expectations = E-EH-01..12 each ending with
  "Enforced by: …"; Edge cases = X-EH-01..22 each with its code; Linked
  artifacts. Cross-reference sentences (R7) in `sessions.md`, `runs.md`,
  `hitl.md`, `reconciliation-gc.md`, `scratch-runs.md`, `agents.md`, `workspaces.md`.
  Acceptance: every D3–D9 transition and refusal appears exactly once; every
  Expectation names its enforcement mechanism (patch rule 2026-07-27-09.30);
  `pnpm validate:docs` green.
- [x] **T0.3 Data contracts (`Designed`).** `docs/database-schema.md` family
  section + column blocks (house `ts` pseudo-object style) for the three tables
  and four columns, indexes and CHECKs named exactly as Appendix C;
  `docs/db/execution-hosts-domain.md` (`erDiagram` + `## Keys and constraints`
  + `## Cascade chain` + `## Retention` + `## Linked artifacts`);
  `docs/db/README.md` row; `docs/db/runs-domain.md` FK lines.
  Acceptance: ERD attributes == Appendix C 1:1; `pnpm validate:docs` green.
- [x] **T0.4 Wire, error, architecture, configuration contracts (`Designed`).**
  `docs/api/supervisor.openapi.yaml` 0.8.0 with Appendix B schemas and one
  request+response example per route (examples are the test fixtures — Appendix
  D §D.4); `docs/api/async/supervisor-sse.asyncapi.yaml` 0.8.0;
  `docs/api/async/web-runs.asyncapi.yaml`; `docs/supervisor.md` (routes,
  envelope, fences, receipts, adoption, state dir, restart, limitations:
  single host, shared FS, unauthenticated loopback, one local host);
  `docs/error-taxonomy.md`; `docs/architecture.md`; `.ai-factory/ARCHITECTURE.md`;
  root `CLAUDE.md` + `.ai-factory/rules/backend.md` boundary rule;
  `docs/configuration.md` rows; `docs/deployment.md`; `docs/getting-started.md`.
  Acceptance: `npx @redocly/cli lint docs/api/supervisor.openapi.yaml` zero
  errors; `npx @asyncapi/cli validate` zero errors (both files);
  `pnpm validate:contracts` green; `pnpm validate:docs` green; no sentence
  claims remote/multi-host support.
- [x] **T0.5 Phase-0 exit review.** Checklist: each D-decision has exactly one
  canonical home (R7); each route in §Route table has an OpenAPI path with
  examples; each command kind has an FSM row; each env var is in the
  configuration table; each E/X id in Appendix A maps to ≥1 test in Appendix D
  §D.5 and to exactly one owning level; reviewer sign-off in progress notes;
  **Commit 1**.

### Phase 1 — Persistence (TDD on the DB layer)

- [x] **T1.1 Drizzle schema + migration triple + ERD.**
  Spec: Appendix C; E-EH-01, E-EH-02.
  RED (web `unit`, existing `web/lib/db/__tests__/migration-journal-integrity.test.ts`
  — no new test; the RED signal is `db:generate` proposing statements that
  differ from Appendix C).
  GREEN: `web/lib/db/schema.ts` (three tables, four columns, `AnyPgColumn` for
  the circular FK, `text` + `check()` enums, indexes named as Appendix C);
  `pnpm --filter maister-web db:generate` → `0128_execution_hosts.sql`; review
  the diff against Appendix C (names, actions, predicates); add the prose header
  ("additive; NULL assignment = never placed"); journal `idx 128` with monotonic
  `when`; snapshot present; `db:erd` regenerated.
  REFACTOR: none (schema).
  Depends on: T0.3. Failure: `db:generate` proposing any statement outside
  Appendix C means `schema.ts` drifted — stop and fix (fourth-leg rule); run
  `db:generate` a second time and require an EMPTY diff (idempotency).
  Acceptance: journal-integrity test green; `pnpm validate:docs` green (DBML
  gate); `db:check` green on a migrated testcontainer.
- [x] **T1.2 DB layer: hosts / assignments / commands / redaction.**
  Spec: E-EH-01, E-EH-02, E-EH-06, E-EH-12; X-EH-20.
  RED (web `integration`, `web/lib/execution-host/__tests__/assignments.integration.test.ts`):
  A1 mint on a run without assignment → epoch 1, `active`, `runs.execution_assignment_id` set;
  A2 second mint → epoch 2, previous `superseded` with `superseded_by_id` and `ended_at`, exactly one `active`;
  A3 two concurrent mints with a barrier, BOTH orderings → one winner, loser `CONFLICT`, epochs distinct (mutation proof: with the `FOR UPDATE` removed the test must go red);
  A4 `releaseAssignmentForRun` on an active row → `released`, `ended_at`, reason stored; on an already-released row → no change, no throw;
  A5 admission: `isAdmissible(kind, state)` table — active/all true; released/teardown true, released/create false; superseded/all false.
  RED (web `integration`, `commands.integration.test.ts`):
  C1 insert → `queued`, `payload` redacted (no key matching `/token|secret|key/i` values, no `prompt`);
  C2 CAS chain `queued→delivering→succeeded` with `attempts` predicate: an ack carrying a stale attempt number is ignored (`{changed:false}`);
  C3 terminal guard: signal on `succeeded` row → unchanged + `command-late-signal` logged (spy on logger);
  C4 `failRetryable` stamps `next_attempt_at` and returns to `queued` while `attempts < max`, else `failed`;
  C5 `loadOpenCommands` returns only `queued|delivering|accepted` (partial index predicate mirrored).
  GREEN: `hosts.ts`, `assignments.ts`, `commands.ts`, `redact.ts` (D10 API).
  REFACTOR: one `casTransition(tx, id, from[], patch)` helper used by every
  command transition (DRY); reason/kind enums exported ONCE from `types.ts` and
  reused by `schema.ts` CHECK arrays (patch rule: alias, never hand-mirror).
  Depends on: T1.1. Logging: `debug` per transition; `info` mint/supersede/release.
  Acceptance: A1–A5, C1–C5 green; suite green.
- [x] **T1.3 Migration behavior with historical + active runs.**
  Spec: D9; X-EH-16 (data shape half).
  RED (web `integration`, `web/lib/db/__tests__/migration-0128-execution-hosts.integration.test.ts`):
  M1 DB at `0127_output_contract` seeded with runs in all 11 statuses +
  `run_sessions` + `node_attempts` → `applyMainMigration("0128_execution_hosts")`
  → row counts unchanged, new columns NULL, `pg_constraint` names of Appendix C
  present, partial unique indexes present (`pg_indexes` predicate asserted);
  M2 inserting a second non-retired `local_direct` host → unique violation;
  M3 `(state='active') = (ended_at IS NULL)` CHECK rejects an active row with `ended_at`.
  GREEN: none beyond T1.1 (the test proves the migration).
  Depends on: T1.1. Acceptance: M1–M3 green; **Commit 2**.

### Phase 2 — Supervisor host substrate

- [x] **T2.1 Host state store + identity bootstrap + `/health.host`.**
  Spec: D1; E-EH-01 (host side); X-EH-01, X-EH-03.
  RED (supervisor `integration`, `supervisor/src/__tests__/host-identity.integration.test.ts`):
  H1 fresh state dir → key matches the regex, `/health.host` returns it with a `bootId`;
  H2 second `openHostState` on the same dir → same key, different `bootId`;
  H3 pin on a fresh dir → stored key == pin;
  H4 pin equal to stored → boots; H5 pin ≠ stored → `openHostState` throws `HostKeyConflictError` naming both key prefixes (the process wrapper exits 1);
  H6 unwritable dir → throws `HostStateUnwritableError`;
  H7 `/health` body contains no path and no full state-dir string.
  GREEN: `supervisor/src/host-state.ts` (`openHostState`, tables, `hostKey()`,
  `bootId`, prune scheduler), `main.ts` (open before `registerRoutes`; fatal
  exit on the two errors), `http-api.ts` `/health.host`, `types.ts` schema,
  `RegisterRoutesOptions.hostState` (tests inject a temp dir), envs
  `MAISTER_EXECUTION_HOST_STATE_DIR`, `MAISTER_EXECUTION_HOST_KEY`.
  REFACTOR: `main.ts` error handling for boot-fatal errors in one place.
  Depends on: T0.4. Logging: `execution-host-identity {hostKey, bootId}`;
  fatal `execution-host-key-conflict`. Acceptance: H1–H7 green; existing
  `main-wiring.test.ts` updated; supervisor suites green.
- [x] **T2.2 Envelope, fence enforcement, receipts, `GET /commands/:id`, typed error details.**
  Spec: D3, D4, D6; E-EH-03, E-EH-04, E-EH-05; X-EH-04..09, X-EH-19, X-EH-21.
  RED (supervisor `integration`, `execution-fence.integration.test.ts`, fixture `mock-acp-lifecycle.mjs`; every assertion checks `details.reason` or a state, never only the status code):
  F1 enveloped create with epoch 1 → 201, `run_fences` row persisted (read via the store API);
  F2 same run, epoch 0 → 409 `FENCED` `{reason:"assignment_fenced", commandEpoch:0, hostEpoch:1}`;
  F3 epoch 1 with a different `assignmentId` → 409 `PRECONDITION assignment_mismatch`;
  F4 `fence.hostKey` ≠ own → 409 `PRECONDITION host_mismatch`;
  F5 prompt whose `fence.runId` ≠ session's run → 409 `run_mismatch`;
  F6 epoch 2 checkpoint arrives while an epoch-1 session is live → epoch-1 session receives `session.exited{reason:"fenced"}`, its pending prompt request resolves 409 `FENCED`, fence row shows 2, then the command executes;
  F7 restart the in-process app on the same state dir → F2 still 409 (fence survived);
  F8 missing envelope (transitional) → executes + WARN `legacy-unfenced-command` (logger spy).
  RED (`command-receipts.integration.test.ts`):
  R1 duplicate create id → same 201 body, `X-Maister-Command-Replayed: true`, exactly one child process (registry size 1);
  R2 duplicate prompt id while the turn is in flight → both requests resolve with the same `stopReason` (join);
  R3 restart between `accepted` and completion → duplicate prompt id → 409 `PRECONDITION turn_lost`, receipt `rejected`;
  R4 `GET /commands/:id` → receipt fields per Appendix B; unknown → 404;
  R5 receipt write failure (injected) → 500 `ACP_PROTOCOL`, no receipt row;
  R6 receipts older than TTL pruned at boot (clock injected).
  GREEN: `supervisor/src/execution-fence.ts`, `command-receipts.ts`,
  `types.ts` (`CommandEnvelopeSchema`, `FenceSchema`, `SupervisorErrorBody.details`,
  `SupervisorErrorCode += FENCED` → 409), `http-api.ts` `withCommand(handler)`
  applied to the six session routes + `GET /commands/:commandId`, registry
  `intentionalReason += "fenced"`, heartbeat propagates `reason: "fenced"`,
  prompt handler maps an evicted session to `FENCED`.
  REFACTOR: no fence/receipt code in route bodies (only in `withCommand`);
  one `sendSupervisorError(reply, err)` path for `details`.
  Depends on: T2.1. Logging: `debug` fence compare; `info` eviction; `warn`
  legacy-unfenced. Failure: per D6. Acceptance: F1–F8, R1–R6 green; suites green.
- [x] **T2.3 Workspace registry, adoption routes, handle-based session create.**
  Spec: D7; E-EH-08, E-EH-09; X-EH-10..13.
  RED (supervisor `integration`, `workspace-adoption.integration.test.ts`; positive cases FIRST — patch rule 2026-08-06-19.10):
  W1 valid `git_worktree` (real `git worktree add` under a temp root passed as `MAISTER_WORKSPACE_ROOTS`) → 200 `{executionWorkspaceId, kind, replayed:false}`; re-adopt → same id, `replayed:true`;
  W2 valid `repo_checkout` at an arbitrary path → 200; W3 valid `directory` under roots → 200;
  W4 same path adopted by two runIds → two ids;
  W5 rejection matrix, one case per rule token: `relative_path`, `parent_segment`, `not_found`, `outside_roots`, `symlink_escape` (symlinked dir under a root pointing outside), `gitdir_mismatch` (worktree of repo A claimed with repo B), `not_a_repo`, `repo_path_mismatch`, `inside_state_dir` → each 409 `PRECONDITION {reason:"workspace_rejected", rule}`;
  W6 create with an unknown handle → `unknown_workspace`; with a released handle → `workspace_released`;
  W7 create via handle: child cwd, `<stepId>.log` location, `cost.jsonl`, content-block confinement and `MAISTER_CONTEXT_REPOS` are byte-identical to the legacy path form (captured from `mock-acp-record-newsession.mjs`);
  W8 `capabilityProfilePath` outside the handle path → `workspace_rejected:outside_workspace`;
  W9 handles survive an in-process restart on the same state dir; `GET /workspaces/:id` never returns a path.
  GREEN: `supervisor/src/workspace-registry.ts`, `workspace-roots.ts`
  (`MAISTER_WORKSPACE_ROOTS`, `~` expansion, realpath at boot, WARN on missing
  roots), `types.ts` (`AdoptWorkspaceRequestSchema`, `WorkspaceKindSchema`,
  transitional `StartSessionRequestSchema` union), `http-api.ts` routes,
  `spawn.ts` / `acp-client.ts` / `prompt-confinement.ts` / `cost.ts` /
  `context-mounts.ts` consume a resolved `WorkspaceResolution` object;
  `SessionRecord += executionWorkspaceId, assignmentId, assignmentEpoch, createdByCommandId`.
  REFACTOR: exactly one path-derivation function (`resolveForSession`) feeds
  spawn, confinement, cost and events-log — the three duplicated
  `resolve(runtimeRoot, ".maister", …)` sites collapse into it.
  Depends on: T2.2. Logging: `debug` validation steps; `info` adopted/released.
  Failure: fs errors → 409, never 500. Acceptance: W1–W9 green; existing
  `lifecycle`, `m8-resume-spike`, `guardrail-interceptor`, `mcp-forwarding`,
  `adapter-compatibility` integration tests migrated to adopt-then-create;
  suites green; **Commit 3**.
- [x] **T2.4 `session.command` events + prompt receipts + fenced exit reason.**
  Spec: D5; E-EH-10 (host half); X-EH-15, X-EH-19.
  RED (extend `command-receipts.integration.test.ts`):
  S1 a prompt turn emits `session.command{phase:"accepted"}` then `{phase:"completed", status:"succeeded", result:{stopReason}}` with strictly increasing `monotonicId`, both lines present in `run.events.jsonl`;
  S2 cancel/checkpoint/input/delete each emit exactly one `completed` event after their effect;
  S3 eviction emits `session.exited{reason:"fenced"}` (from F6, asserted here on the durable log).
  RED (web `unit`, `web/lib/runs/__tests__/run-transcript-projector.test.ts` — existing file, one new case): P1 a `session.command` line is ignored by the projector (no message, no reset).
  GREEN: `types.ts` `SessionEvent += session.command`, `session.exited.reason += fenced`;
  `http-api.ts` emits around receipts; `web/lib/supervisor-client.ts` event union
  (parse only).
  REFACTOR: one `emitCommandEvent(entry, phase, …)` helper.
  Depends on: T2.2. Acceptance: S1–S3, P1 green; suites green.
- [x] **T2.5 Contract parity + validators.** Update OpenAPI/AsyncAPI examples to
  payloads captured by F1/W1/S1 (Appendix D §D.4 makes them fixtures);
  `scripts/validate-contracts.mjs` resolves the new `$ref`s; the mirrors check
  (`scripts/validate-adapter-mirrors.ts`) reviewed for `SessionRecord`.
  RED: contract test `supervisor/src/__tests__/openapi-examples.test.ts` (supervisor `unit`): every example under `components/schemas/{CommandEnvelope, AdoptWorkspaceRequest, StartSessionRequest, CommandReceipt, SessionCommandEvent}` parses with the Zod schema; a deliberately broken example fixture fails (proves the harness).
  Depends on: T2.1–T2.4. Acceptance: redocly + asyncapi + `validate:contracts` green.
- [x] **T2.6 e2e in-process test supervisor speaks the transitional contract (moved up).**
  Spec: keeps the Playwright lane green from T4.1 on.
  RED (Playwright `authed`, existing `scratch-launch.spec.ts` — no new spec here): the existing lane must stay green after T4.1; T2.6 delivers the capability ahead of it.
  GREEN: `web/e2e/_seed/test-supervisor.ts` and `stub-supervisor.ts` implement
  `/health.host` (fixed key), `POST /workspaces/adopt` (in-memory registry, D7
  matrix reduced to absolute-path + existence), `GET/DELETE /workspaces/:id`,
  envelope validation (fence per run, in-memory), receipts (in-memory —
  documented as acceptable for the stub), `session.command` events, `GET /commands/:id`.
  Depends on: T2.4. Acceptance: `pnpm --filter maister-web test:e2e` green (unchanged specs); **Commit 4**.

### Phase 3 — Web execution-host module

- [x] **T3.1 Types, transport interface, local-direct transport, shared fakes.**
  Spec: D10; E-EH-08 (web half), E-EH-12.
  RED (web `unit`, `web/lib/execution-host/__tests__/wire-shape.test.ts`):
  T1 `buildEnvelope()` output matches the OpenAPI `CommandEnvelope` example shape and never contains `worktreePath|repoPath|confineRoot|runId|projectSlug` inside a `session.create` payload (fixture-driven, Appendix D §D.4);
  T2 `asMaisterError` passes `details.reason` through and maps `FENCED` → `CONFLICT {details.reason:"assignment_fenced"}`;
  T3 the transport module has no DB import (static import-graph assertion) — redaction is the ledger's job (proved in T3.3 L1/C1), not the transport's.
  GREEN: `web/lib/execution-host/types.ts`, `transports/local-direct.ts`
  (wraps `supervisor-client.ts`, which gains enveloped variants +
  `adoptWorkspace/getWorkspace/releaseWorkspace/getCommandReceipt`, event union,
  projection fields), `index.ts`; `web/test-support/fake-execution-host.ts`
  (in-memory `ExecutionHostTransport` with programmable responses/faults +
  a `fakeBoundClient()` for driver tests) and `web/test-support/real-supervisor.ts`
  (spawns `tsx ../supervisor/src/main.ts` with a free port, per-test state dir,
  `MAISTER_ADAPTER_BINARY_CLAUDE=<fixture>`, `MAISTER_WORKSPACE_ROOTS=<lane root>`,
  health-gated start, SIGKILL/restart helpers).
  REFACTOR: `supervisor-client.ts` keeps ONE `request()` helper; enveloped
  variants share it.
  Depends on: T2.5. Acceptance: T1–T3 green; `web/lib/__tests__/supervisor-client.test.ts` extended; typecheck green.
- [x] **T3.2 Local host registrar + resolver.**
  Spec: D1, D8; E-EH-01; X-EH-02, X-EH-03, X-EH-22.
  RED (web `integration`, `registrar.integration.test.ts`, real supervisor child):
  G1 first boot → one row, `readiness='ready'`, `capabilities.protocolVersion=1`;
  G2 restart the child on the same state dir → same row, `last_boot_id` changed, `runReconcileSweep` spy called once;
  G3 second child with another state dir while the first row owns ZERO active assignments → old `retired_at` set, new row inserted, exactly one non-retired;
  G4 same but the old row owns an active assignment of a `Running` run → rows unchanged, `readiness='unavailable'`, `readiness_reason='identity_changed'`, `hostForAssignment` throws `EXECUTOR_UNAVAILABLE {details.reason:"host_identity_mismatch"}`;
  G5 child stopped → `readiness='unavailable'` written at most once per 30 s (clock injected), boot does not throw;
  G6 `localHost()` memoizes for 30 s (one health call per window).
  GREEN: `registrar.ts` (policy table under a `SELECT … FOR UPDATE` of the
  active row: lock → verify → commit — patch rule 2026-09-01-04.15),
  `resolver.ts`, `web/instrumentation.ts` position.
  REFACTOR: policy table as data (`decideRegistration(observed) → action`)
  unit-testable without DB — its unit test replaces no integration case.
  Depends on: T1.2, T3.1. Acceptance: G1–G6 green; suite green.
- [x] **T3.3 Command ledger + deliverer + bound client.**
  Spec: D4, D5; E-EH-03 (web side), E-EH-06, E-EH-07, E-EH-11; X-EH-04, X-EH-07, X-EH-08, X-EH-14, X-EH-15, X-EH-20.
  RED (web `integration` + fake transport, `ledger.integration.test.ts`):
  L1 `issue()` persists `queued` BEFORE the transport is called (transport spy records DB state at call time);
  L2 immediate kind 2xx → `succeeded` + `completed_at`; `session.create` ack tx also writes `run_sessions.host_session_id/acp_session_id/execution_assignment_id`;
  L3 unknown-outcome failure (transport throws `ECONNREFUSED`) → retried with the SAME command id up to the kind's budget, backoff stamps `next_attempt_at`, then `failed`;
  L4 definitive 503 body → `failed` after ONE attempt (no same-id retry);
  L5 409 `FENCED` → `fenced`, caller gets `CONFLICT assignment_fenced`;
  L6 admission: create on a `released` assignment → local `fenced`, transport NOT called; checkpoint on `released` → sent; anything on `superseded` → local `fenced`;
  L7 prompt: SSE `session.command{accepted}` folds `accepted_at`; HTTP response after that → `succeeded`; SSE completed BEFORE the HTTP promise → `PromptHandle.completion` resolves from SSE and the late HTTP fold is a no-op (`command-late-signal`);
  L8 prompt post-acceptance transport failure → exactly one `GET /commands/:id`; `completed` → `succeeded{stopReason}` returned to the caller; `accepted`-no-inflight → `failed{turn_lost}`; 404 → `failed{receipt_missing}`.
  RED (web `integration` + REAL supervisor, `deliverer.integration.test.ts`): D1 create/prompt/input/cancel/checkpoint/delete happy path through the real wire with the fake ACP fixture, ledger rows terminal `succeeded`, `run_sessions.host_session_id` equals `GET /sessions[0].sessionId`; D2 mint a second assignment, retry the first assignment's checkpoint → `fenced` row + `CONFLICT`.
  GREEN: `ledger.ts`, `deliverer.ts` (policy table), `client.ts`
  (`forAssignment`, `local`), `commandSignals` emitter fed by SSE consumers.
  REFACTOR: `BoundClient` methods are thin wrappers over ONE `issue()`; no
  kind-specific branches outside the policy table; `HostAdminClient` and
  `BoundClient` share the transport instance.
  Depends on: T1.2, T3.1, T3.2. Logging: per contract. Acceptance: L1–L8, D1–D2 green; suite green.
- [x] **T3.4 Startup + periodic recovery + retention.**
  Spec: D5, D8; E-EH-10; X-EH-16, X-EH-17.
  RED (web `integration` + REAL supervisor, `command-recovery.integration.test.ts`):
  V1 W2: fault-inject the ack write after a real create → row stays `delivering`; `recoverExecutionCommands()` → `succeeded`, `host_session_id` persisted, `GET /sessions` shows exactly ONE session (no re-spawn);
  V2 W1: a `queued` `session.delete` (driverless) → delivered; a `queued` `session.create` → `failed{ORPHANED}`, transport not called;
  V3 W4: SIGKILL the supervisor mid-prompt, restart on the same state dir → recovery folds `failed{turn_lost}`; the same key + new bootId observed; the run is then classified by the existing reconcile (assert `Crashed`);
  V4 a `delivering` row younger than 60 s is left alone (in-flight protection);
  V5 sweep backstop: `active` assignment on a `Review` run → `released{sweep}`; V6 `pruneExecutionCommands` deletes terminal rows older than 7 days only.
  GREEN: `recovery.ts`, `instrumentation.ts` order, `system-sweeps.ts` pass + summary field.
  REFACTOR: recovery reuses the deliverer for driverless re-delivery (no second send path).
  Depends on: T3.3. Acceptance: V1–V6 green; suite green.
- [x] **T3.5 Workspace adoption client.**
  Spec: D7; E-EH-08, E-EH-09; X-EH-11.
  RED (web `integration` + REAL supervisor, `adoption.integration.test.ts`):
  K1 flow-run assignment → adopt payload derived from `workspaces.worktree_path` + `projects.repo_path` (kind `git_worktree`), handle stored on the assignment, second call skips the wire;
  K2 local-package assistant → `directory` from `local_packages.working_dir`;
  K3 `repo_read` agent → `repo_checkout` = `projects.repo_path`; K4 agent `none` → `directory` = `agentWorkdirPath`;
  K5 wipe the host state dir + restart → create returns `unknown_workspace` → client re-adopts once → create succeeds; a second `unknown_workspace` → `PRECONDITION` surfaced (no loop);
  K6 `runs.context_mounts` snapshot travels in the adopt payload (asserted via the recording fixture).
  GREEN: `adoption.ts`.
  REFACTOR: kind mapping is one pure function `workspaceSpecFor(run, …)` unit-tested by K1–K4 shapes only through the integration cases (no duplicate unit test).
  Depends on: T3.3. Acceptance: K1–K6 green; **Commit 5**.

### Phase 4 — Call-site migration waves (assertion migration in scope)

- [x] **T4.1 Flow launch + runner-agent + runner-graph.**
  Spec: D3 (mint `launch`), D5 yield rule; E-EH-02, E-EH-07, E-EH-11.
  RED (web `integration` + REAL supervisor, `launch-paths.integration.test.ts`, flow half):
  P1 `launchRun` → assignment epoch 1 `launch` in the same tx as the run (assert via a tx-abort fault: no run ⇒ no assignment); the ADR-150 adopted-run branch mints nothing;
  P2 first node → adopt + create + prompt commands rows, `node_attempts.execution_assignment_id` stamped, `run_sessions.host_session_id` set BEFORE the prompt completes (read mid-turn using the fixture's pause);
  P3 yield: mint a second assignment while the first driver's prompt is in flight → first driver's `runAgentStep` returns `{fenced:true}`, `runFlow` writes no status/ledger change (row snapshot diff), `driver-yielded` logged;
  P4 checkpoint mid-permission still yields `STEP_CHECKPOINTED` (regression, unchanged).
  GREEN: `web/lib/services/runs.ts` (mint in the run-insert tx after the
  `run_sessions` insert; insert branch only), `runner-agent.ts` (`SupervisorApi`
  → `BoundClient`; `ensureWorkspaceAdopted` → create → prompt handle → delete in
  `finally`; `fenced:true` result), `runner-graph.ts` (`:3281` late acp persist
  removed — the ack tx owns it; `parkCoordinatorSession` checkpoint via the
  persisted `host_session_id`; release on terminal writes and
  `markWaitingOnChildren`; early return on `fenced`).
  REFACTOR: delete `SupervisorApi`; runner-agent no longer resolves session ids by scanning.
  Depends on: T3.5. Acceptance: P1–P4 green; migrated to `fakeBoundClient()`:
  `web/lib/flows/__tests__/runner-agent.test.ts`, `runner-agent-hooks.test.ts`,
  `web/lib/flows/graph/__tests__/{gates-exec,node-output,orchestrator-park,run-context,runner-graph-decide-routing,runner-graph.enforcement,runner-graph.materialize,runner-graph.matplan,artifact-inject,calibrate-verdict-exec,exec-trust-mcp-gate,resolved-set-snapshot}.integration.test.ts`,
  `web/app/api/runs/__tests__/*.integration.test.ts` (6) via a new
  `seedExecutionAssignment` in `graph-run-seed.ts`; suites green.
- [x] **T4.2 HITL respond + keepalive sweeper + hook-trip + node-interrupt + budget paths.**
  Spec: operation matrix rows `session.input`, `session.checkpoint`, `session.delete`; X-EH-20; Verified #6.
  RED: `web/lib/services/__tests__/hitl-budget-breach.integration.test.ts` (existing, REAL supervisor for this case): B1 budget park checkpoints the HOST session id — reproduce first against the current code (expected: 404 → `CHECKPOINT`); if it passes unchanged, keep the case as a pin and record "not reproducible" in the plan notes;
  `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts` (existing, fake client): I1 Phase-1 tx contains the `session.input` row; I2 503 leaves `respondedAt` NULL and the command `failed`, the user's retry issues a NEW command; I3 replay result with a different `optionId` than the row's latest `response` → `_audit.deliveredOptionId` recorded; I4 persist-failure path issues exactly one `session.input{cancel}` command (deferred-release regression, spy);
  `web/lib/runs/__tests__/keepalive-sweeper.test.ts` (existing): K1 P1 checkpoint issued under the run's assignment; 503 → `NeedsInput` retained; `fenced` → treated like 404 (proceed to `markCheckpointed`, WARN);
  `hook-trip-escalate`, `budget-watchdog`, `time-limit-watchdog`, `agent-hook-trip` integration tests migrated (teardown kinds under `released` assignments allowed — one explicit case).
  GREEN: `hitl.ts` (`:1179`, `:1419`, `:3545`), `keepalive-sweeper.ts`,
  `hook-trip.ts`, `node-interrupt.ts` (restart mints `node_interrupt`),
  `state-transitions.ts` release hooks.
  REFACTOR: the three `listSessions()`-by-key lookups collapse into
  `BoundClient.sessionsForRun()`.
  Depends on: T4.1. Acceptance: all listed cases green; suites green.
- [x] **T4.3 Resume / recover / resume-driver / resume-recovery / rework return / wait-resume.**
  Spec: D3 mint sites; X-EH-04 end-to-end.
  RED (web `integration` + REAL supervisor, `lifecycle-regression.integration.test.ts` — the ONLY end-to-end web test): E1 permission round-trip via ledger → keepalive checkpoint → `NeedsInputIdle` (assignment `released`) → respond → `resumeRun` mints epoch 2, adopt skipped (handle copied), create with `resumeSessionId` → stale epoch-1 checkpoint command → 409 `FENCED` → `CONFLICT assignment_fenced` → delete → reconcile leaves the run consistent; E2 `rollbackResumedRun` on `EXECUTOR_UNAVAILABLE` marks the fresh assignment `released{resume_rollback}`; E3 `markResumedFromWait` and `markReturnedToRunning` mint with their reasons.
  Migrated: `web/lib/runs/__tests__/{resume,resume-driver,resume-recovery}.test.ts`, `recover.integration.test.ts`.
  GREEN: `resume.ts`, `recover.ts`, `resume-driver.ts`, `resume-recovery.ts`, `state-transitions.ts`, `rework-claim-ingest.ts` (if it spawns).
  REFACTOR: one `mintForClaim(tx, runId, reason)` used by every claim site.
  Depends on: T4.2. Acceptance: E1–E3 + migrated green; **Commit 6**.
- [x] **T4.4 Scratch runs + local-package assistant + gate-chat + agent-question.**
  Spec: D2 rows scratch/assistant/gate-chat; yield rule.
  RED: `launch-paths.integration.test.ts` (scratch half, REAL supervisor): Q1 scratch launch mints `launch`, adopt+create, `scratch_runs.supervisor_session_id == run_sessions.host_session_id`; Q2 interrupt → `session.cancel` row; Q3 recover route mints `scratch_recover`; Q4 assistant → `directory` adoption; Q5 gate chat on a live `NeedsInput` run reuses the current epoch, on idle mints `gate_chat`.
  Migrated: `web/app/api/scratch-runs/**/__tests__/route.test.ts` (6), `web/lib/scratch-runs/__tests__/{local-package-assistant.integration,transcript}.test.ts`, `web/lib/services/__tests__/gate-chat.integration.test.ts`, `web/app/api/v1/ext/projects/[slug]/tasks/[taskId]/human-asks/__tests__/route.integration.test.ts`.
  GREEN: `scratch-runs/service.ts`, `scratch-runs/events.ts`, the five scratch routes, `gate-chat.ts`, `agent-question.ts`.
  REFACTOR: delete `ScratchSupervisorApi`, `GateChatSupervisorApi`, `ActivationDeps` supervisor members.
  Depends on: T4.3. Acceptance: Q1–Q5 + migrated green.
  **Done (2026-09-02):** `scratch-runs/{service,events}.ts`, the recover/discard routes, `gate-chat.ts`, `agent-question.ts` (+ `reconcile.ts` caller, `adoption.ts` derives the assistant's `directory` spec from the local package) bind through `ExecutionHosts`; `ScratchSupervisorApi`/`GateChatSupervisorApi`/`ActivationDeps` supervisor members deleted. Q1–Q3 live in NEW `lib/scratch-runs/__tests__/scratch-placement.integration.test.ts` on the fake host (real DB + real git worktree; the real-supervisor scratch half was folded into E1 of `lifecycle-regression` rather than a second harness): Q1 `launch` mint + ONE `git_worktree` adopt + handle-form create (`stepId: "dialog"`, no path fields) + `scratch_runs.supervisor_session_id == run_sessions.host_session_id`; Q2 `session.cancel` ledger row `succeeded` at epoch 1; Q3 recover route (202) mints `scratch_recover` over the `crashed`-released launch generation, resumes on the ACP handle, copies the workspace handle forward (adopt count stays 1). Q4 in the assistant suite (`{kind:"directory", path: workingDir}`), Q5 in `gate-chat.integration` (live turn stays on epoch 1 `launch`; idle turn mints epoch 2 `gate_chat` over the `checkpointed` release; a failed respawn releases it `resume_rollback`; claim-before-spawn pinned via an `onCall("createSession")` hook). Migrated: 6 scratch route unit suites (`executionHostModuleMock`), `transcript`/`services`/`emit-run-status`/`emit-hitl` (`legacyScratchApiToExecution` typed as `ScratchExecution`), `local-package-assistant.integration` (spy-backed fake transport; its "compensates materialization" case fails on main too — pre-existing), `agent-question.integration` (16, per-case fresh fake; `failOnce`/`onCall` model the retryable/gone/refused teardowns), `human-asks` route (fake transport routed to the suite's spies), `gate-chat.integration` (17, `scriptHost()` per case with `pushEvent` replies).
- [x] **T4.5 Platform agents + consensus draft + branch-sync + evaluations + workbench lifecycle + GC + reconcile.**
  Spec: D2 agent rows; operation matrix teardown rows; D7 release; D8 reconcile check.
  RED: `launch-paths.integration.test.ts` (agent half): N1 agent `worktree`/`repo_read`/`none` each adopt with the expected kind (K1–K4 shapes reused, not re-asserted — assert only the kind token here); N2 `messageChildRun` idle branch mints `resume`; N3 sync resolver mints `sync_resolver` and its fail-closed teardown is a `session.delete` row; N4 workbench stop issues one delete per live session and releases; N5 GC worktree removal issues `workspace.release` (driverless) and a stopped supervisor leaves it `queued` for recovery; N6 reconcile emits `workspace-handle-lost` WARN on 404 and does not crash the tick.
  Migrated: `web/lib/agents/__tests__/*.integration.test.ts` (6), `web/lib/context-mounts/__tests__/*.test.ts` (3), `web/lib/runs/__tests__/{sync-resolver,sync-recovery}.integration.test.ts`, `web/lib/evaluations/__tests__/*.integration.test.ts` (2), `web/lib/__tests__/{reconcile-sweep,reconcile-capability-cleanup}.integration.test.ts`, `web/lib/gc/__tests__/workspace-reconciler.integration.test.ts`, `web/lib/orchestrator/__tests__/e2e-loop.integration.test.ts`, `web/app/api/v1/ext/runs/__tests__/*.integration.test.ts` (6), `web/lib/review-comments/__tests__/service*.test.ts`, `web/lib/scheduler/handlers/__tests__/pr-state-scan.integration.test.ts`.
  GREEN: `agents/launch.ts`, `sync-resolver.ts`, `sync-target.ts`, `sync-recovery.ts`, `evaluations/dispatcher/tick.ts`, `workbench-lifecycle/service.ts`, `gc/workspace-reconciler.ts` (ONE `listSessions` per sweep), `reconcile.ts`.
  REFACTOR: delete `AgentSupervisorApi`, `SyncResolverSupervisorApi`, `WorkbenchLifecycleDeps` supervisor members; GC's three `listSessions` calls collapse to one.
  Depends on: T4.4. Acceptance: N1–N6 + migrated green.
  **Done (2026-09-03):** `agents/launch.ts` (launch = `localHost` gate + `launch` mint in the insert tx; `startAgentSession`/consensus draft/`sendAgentMessage`/`reworkChildRun`/`consumeAgentSession` bind through `AgentExecution = {client, admin}`; idle re-message mints `resume`, rework mints `rework_return`, park releases `parked`, `finalizeAgentRun` releases `run_terminal`; fenced errors yield), `sync-resolver.ts` (`ResolverSessionInput` handle-form, `teardownResolverSession` = fenced `session.delete`), `sync-target.ts` (`sync_resolver` mint inside the CAS tx, `executionHosts` threaded), `sync-recovery.ts`, `state-transitions.ts` (`markSyncReviewFrom*` release `sync_finished`), `evaluations/dispatcher/tick.ts` (reaper through `forRun(…,{teardown})`), `workbench-lifecycle/service.ts` (`executionHosts` dep; stop releases `stopped`), `gc/workspace-reconciler.ts` (ONE `listSessions` per sweep; `workspace.release` after removal via `getLatestAssignment`), `reconcile.ts` (`checkWorkspaceHandles` → `handlesLost` + WARN `workspace-handle-lost`). Admin surface: `HostAdminClient.diagnostics()` (transport + local-direct + fake). Deliverer: a driverless kind stops after ONE unknown outcome (`delivery_deferred`, row stays `queued` for recovery). `AgentSupervisorApi`/`SyncResolverSupervisorApi`/`WorkbenchLifecycleDeps.{listSessions,deleteSession}` deleted. N1 (`agent-execution-policy`: `directory`/`repo_checkout`/`git_worktree` adopt kinds), N2 (`ext/runs/message`: `resume` generation + fenced create), N3 (`sync-resolver.integration`: `sync_resolver` generation released `sync_finished`; teardown rows), N4 (`workbench-stop.integration`: `run_terminal`/`stopped` releases; unit suite pins one delete per live session via the DB-less `memoryExecutionHosts`), N5 (`workspace-reconciler.integration`: release row `succeeded`, and `queued` under a host outage), N6 (`reconcile-sweep.integration`: `handlesLost: 1`, tick continues). Every agent-launching suite registers a fake host (`fakeExecutionHosts(db)`); `fakeAgentExecution` streams end after their script; the fake's resume keeps the ACP id. Pre-existing-on-main failures left as is: dirty-watchdog (7), worktree-modes C4 race, sync-recovery (18, `workspaces_lifecycle_claim_shape_check`), sync-resolver abandon-mid-resolve, promote-rework 409s (3), assistant compensation.
- [x] **T4.6 Admin/diagnostic surfaces + lint fence.**
  Spec: D10 lint fence; R-14.
  RED: ESLint rule active → `pnpm exec eslint .` fails on any remaining direct import (the RED is the lint run itself); migrated route tests listed below.
  GREEN: `web/app/(app)/layout.tsx`, `(auth)/layout.tsx`, `login/page.tsx`, `projects/[slug]/page.tsx`, `tasks/[number]/page.tsx`, `settings/page.tsx`, `web/app/api/admin/{acp-runners,router-sidecars,mcp-servers}/**/route.ts`, `web/lib/acp-runners/native-defaults.ts`, `web/lib/flows/enforcement-evidence.ts`, `web/lib/mcp/probe-service.ts`, `web/lib/services/runs.ts` + `scratch-runs/service.ts` health gates → `executionHosts.local()`; `web/eslint.config.mjs` `no-restricted-imports`.
  REFACTOR: `getPlatformStatus` = React `cache` over `local().health()`.
  Depends on: T4.5. Acceptance: eslint zero errors; grep gate
  `grep -rn "supervisor-client" web/lib web/app --include='*.ts*' | grep -v execution-host | grep -v __tests__` empty; migrated: admin route tests (9), `settings/__tests__/page-contract.test.ts`, `acp-runners/__tests__/{native-defaults.integration,readiness-summary}.test.ts`, `mcp/__tests__/readiness.test.ts`, `flows/__tests__/enforcement-evidence.test.ts`; **Commit 7**.
  **Done (2026-09-03):** `HostAdminClient` (+ transport, local-direct, fake) grew the host-scoped admin surface — `diagnostics()`, `platformStatus()`, `startSidecar()`, `stopSidecar()`, `resolveModelSuggestions()`, `probeMcp()`; NEW `lib/execution-host/platform-status.ts` = React-`cache`d `getPlatformStatus` / `getPlatformDiagnostics` over `executionHosts.local()` (re-exported by the barrel with `PlatformStatus` and the sidecar wire types). Consumers rewired: the 6 app pages/layouts, the 9 admin routes, `acp-runners/native-defaults.ts`, `flows/enforcement-evidence.ts` (`checkDiagnostics` default), `mcp/probe-service.ts` (`probeMcp` default); the type-only importers (`readiness-summary`, `spawn-intent`, `scratch-runs/{attachments,recovery,events}`, `runs/{recover,resume-driver,resume-recovery}`, `services/{agent-question,gate-chat}`, `components/settings/adapter-support-panel.tsx`) now name the barrel. ESLint: `no-restricted-imports` fences `@/lib/supervisor-client` everywhere except `lib/execution-host/**`, `lib/supervisor-client.ts`, `test-support/**`, `e2e/**`, `**/__tests__/**` (croner restriction kept via a shared const); `pnpm exec eslint .` = 0 errors. Grep gate empty. Route/page tests keep their `@/lib/supervisor-client` module mocks (the local-direct transport reads the wire lazily); only `settings/__tests__/page-contract.test.ts` now mocks `@/lib/execution-host` (`getPlatformDiagnostics`) because the barrel drags the strictly-mocked schema; the four type-only test imports retargeted. Lanes: admin routes + mcp + native-defaults integration 69/69; unit 394/394.

### Phase 5 — Strict contract + legacy

- [ ] **T5.1 Supervisor strict flip + strict e2e test supervisor.**
  Spec: E-EH-08 strict; X-EH-13.
  RED (supervisor `integration`, `strict-envelope.integration.test.ts`): Z1 create without envelope → 409 `PRECONDITION missing_envelope`; Z2 create with `worktreePath` → 409 `legacy_field`; Z3 `GET /sessions` body contains no key from `{worktreePath, repoPath, confineRoot, logPath, contextMounts}`; Z4 `grep -rn "logPath" web/lib web/app --include='*.ts'` is empty (a script assertion in the task, not a test).
  GREEN: `types.ts` strict schemas, `http-api.ts` projection, remove the
  transitional union + WARN, `docs/api/supervisor.openapi.yaml` drops the
  deprecated fields, `web/e2e/_seed/test-supervisor.ts` + `stub-supervisor.ts`
  strict.
  Depends on: T4.6. Acceptance: Z1–Z4; full e2e lane green.
- [ ] **T5.2 Legacy backfill + lazy assignment.**
  Spec: D9; X-EH-18, X-EH-22.
  RED (web `integration` + REAL supervisor, `legacy-backfill.integration.test.ts`): Y1 `Running` run with a live fixture session and NULL assignment → minted `legacy_backfill` epoch 1; Y2 `Running` without a session → NULL and reconcile marks `Crashed`; Y3 `NeedsInputIdle` → NULL, then resume mints normally; Y4 no registered host → skipped, logged once, no throw; Y5 lazy: a sweeper checkpoint on a legacy `NeedsInput` run mints lazily with WARN.
  GREEN: `legacy.ts`, `instrumentation.ts`, issuers call `ensureAssignment`.
  Depends on: T3.4. Acceptance: Y1–Y5 green.
- [ ] **T5.3 Remove legacy path fields from the web wire types.**
  Spec: E-EH-08.
  RED: typecheck (the RED is the compiler after the type change) + `wire-shape.test.ts` T1 stays green.
  GREEN: `CreateSessionInput` loses `runId, projectSlug, worktreePath, repoPath, confineRoot, contextMounts`; only `adoption.ts` builds a path-bearing body.
  Depends on: T5.1, T5.2. Acceptance: typecheck green; grep gate `grep -rn "worktreePath" web/lib/supervisor-client.ts web/lib/execution-host/transports` shows only the adoption payload; suites green; **Commit 8**.

### Phase 6 — Deployment wiring + smoke

- [ ] **T6.1 Deployment wiring (dedicated task).**
  Files: `.env.example`, `supervisor/.env.sample`, `deploy/maister.env.example`,
  `web/.env.sample` (comment), `docs/configuration.md` (rows `Implemented`),
  `docs/deployment.md` (§5 state dir + roots mirror rule; §10 smoke: `curl /health`
  shows `host.hostKey`, web log `execution-host-registered`; upgrade note;
  key-conflict remediation), `docs/getting-started.md`, `web/playwright.live.config.ts`,
  `scripts/blast-maister-local-state.mjs` (+ `node --test`) if the reset must
  cover the state dir; verify `Dockerfile:70`, `.dockerignore`, `.gitignore`;
  compose files reviewed and explicitly unchanged.
  RED: `pnpm test:local-reset` (existing node test) for the reset-scope change.
  Depends on: T5.3. Acceptance: every new var in the configuration table AND both env samples; docs gates green.
- [ ] **T6.2 Live-lane smoke + authed e2e contract spec.**
  RED (Playwright `authed`, `web/e2e/execution-host-contract.spec.ts`, registered in `AUTHED_SPEC`): U1 launch a scratch run via the UI → DB shows `runs.execution_assignment_id`, epoch 1, one host row; U2 flow run through a permission HITL checkpoint/resume → epoch 2 (DB via `DB_URL`).
  RED (Playwright `live-supervisor`, `web/e2e/live-execution-host.spec.ts`, `testMatch` extended to `/live-.*\.spec\.ts$/`): S1 `/health.host` present; S2 a scratch launch against the REAL adapter yields an assignment + adopted handle (`GET /workspaces/:id` 200).
  Depends on: T6.1. Acceptance: `test:e2e` green; `test:e2e:live` run once locally, recorded in progress notes; **Commit 9**.

### Phase 7 — Regression, as-built docs, renumber

- [ ] **T7.1 Full regression pass.** Web unit + integration, supervisor unit +
  integration, e2e, `pnpm validate:docs`, typecheck, eslint check-only.
  Compare failure NAME sets against a baseline run on main (never counts).
  Pre-existing red → explicit quarantine task with reason + follow-up.
- [ ] **T7.2 As-built documentation checkpoint (mandatory).** Flip `Designed` →
  `Implemented` where true (sweep both forms: `(Designed …)` in prose and
  `| Designed |` in tables); ADR-164 `Implemented`; limitations list final;
  `docs/db/erd.dbml` regenerated; `CLAUDE.md` §Built-since line.
  Acceptance: `grep -rniE "different host|remote host|multi-host" docs/*.md docs/system-analytics/*.md` reviewed line by line; validators green.
- [ ] **T7.3 Rebase + renumber pass (own session).** Rebase onto `main`; re-run
  preflight; renumber ADR/migration if squatted (grep prose forms `ADR-164`,
  `0128`, `pre-0128`); `git diff <backup> HEAD --quiet -- web/lib/db/migrations`
  proves migration bytes unchanged when no renumber was needed; full gates;
  **Commit 10**. Integration is rebase + FF by the owner.

---

## Phase exit gates

| Phase | Gate |
| --- | --- |
| 0 | `pnpm validate:docs`; redocly + asyncapi; `validate:contracts`; T0.5 checklist incl. E/X ↔ test traceability |
| 1 | web `test:unit` + `test:integration`; `db:check`; DBML gate; `db:generate` empty diff |
| 2 | supervisor `test:unit` + `test:integration`; `validate:contracts`; e2e lane green (T2.6) |
| 3 | web suites incl. real-supervisor tests; typecheck |
| 4 (each wave) | web + supervisor suites; eslint check-only; the wave's migrated list green; e2e lane green |
| 5 | strict tests; full e2e lane |
| 6 | docs gates; `test:local-reset`; live smoke recorded |
| 7 | everything + name-set regression diff + grep gates |

## Stage-A exit criteria → where satisfied

| Criterion | Task(s) |
| --- | --- |
| Current workflows still work | T4.x migrated suites, T2.6/T5.1 e2e, T7.1 |
| Every new Run has an assignment + epoch | T4.1, T4.4, T4.5; T6.2 U1 |
| Every execution command addressed through the assignment | T3.3; T4.6 lint fence |
| No anonymous global Supervisor in domain code | T4.6 |
| Transport replaceable behind a typed boundary | T3.1 |
| Stale epochs rejected at the boundary | T2.2 F2; T4.3 E1 |
| Duplicate commands safe | T2.2 R1–R3; T3.4 V1 |
| Intent + delivery state durable/recoverable | T1.2, T3.3, T3.4 |
| Session APIs carry no raw paths | T2.3, T5.1, T5.3 |
| Opaque adopted-workspace handle | T2.3, T3.5 |
| HITL/checkpoint/cancel/recovery/reconcile operational | T4.2–T4.5, T7.1 |
| Shared FS documented as next-stage limitation; no remote claims | T0.4, T7.2 |

---

## Appendix A — Specification skeleton (content of `docs/system-analytics/execution-hosts.md`)

### A.1 Requirements (source: owner brief 2026-09-02)

| Id | Requirement |
| --- | --- |
| R-01 | The local execution host has a stable identity that survives supervisor restarts. |
| R-02 | Web Core resolves the host through a durable registration; the transport URL is configuration, not a domain concept. |
| R-03 | Every newly launched run has a durable assignment with a monotonically increasing epoch. |
| R-04 | Assignment history is immutable and auditable; sessions and attempts are attributable to the assignment that created them. |
| R-05 | Every host-bound command carries `hostKey`, `assignmentId`, `assignmentEpoch`, and a unique `commandId`. |
| R-06 | The host rejects stale epochs; fencing survives host restart. |
| R-07 | Duplicate delivery of any command is safe (host receipts). |
| R-08 | Command intent is persisted before the side effect; delivery state only after acknowledgement. |
| R-09 | Every Web crash window has a defined, tested recovery. |
| R-10 | A long-lived HTTP request is never the only durable completion signal. |
| R-11 | Normal session APIs carry no raw paths; adoption is the only path-bearing operation and validates against configured roots. |
| R-12 | Flow runs, scratch/assistant runs, ACP lifecycle, HITL, checkpoint/resume, cancel/abandon, reconcile, concurrency accounting, local delivery/promotion behave as today. |
| R-13 | Shared filesystem and local event coupling are documented as limitations; no remote/multi-host claims. |
| R-14 | Domain code addresses hosts only through a typed boundary; the loopback transport is replaceable. |

### A.2 Expectations (≤ 12; each names its enforcement point)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| E-EH-01 | At most one non-retired `local_direct` execution host exists. | `execution_hosts_local_active_uq` partial unique index; registrar policy under row lock. |
| E-EH-02 | A run has at most one `active` assignment and its epochs are strictly increasing; a mint never reuses an epoch. | `execution_assignments_run_active_uq`, `execution_assignments_run_epoch_uq`, `mintAssignment` in the claim tx. |
| E-EH-03 | Every enveloped command carries a fence; the host persists the per-run high-water BEFORE executing and rejects `epoch < high-water` with 409 `FENCED`. | `withCommand` wrapper; `run_fences` sqlite write; tests F1–F2, F7. |
| E-EH-04 | When a higher epoch arrives, every live session of that run under a lower epoch is evicted (`session.exited{reason:"fenced"}`) before the command executes. | `execution-fence.ts` eviction; test F6. |
| E-EH-05 | A command id is executed at most once per host: a duplicate returns the stored receipt (or joins the in-flight execution). | `command_receipts` PK + in-flight map; tests R1–R3. |
| E-EH-06 | An `execution_commands` row exists in state `queued` before any wire call, and `accepted_at`/`completed_at` are written only after the host's response. | ledger API is the only transport caller; test L1. |
| E-EH-07 | Result-derived domain writes (`run_sessions.host_session_id`, `acp_session_id`, `execution_assignment_id`; assignment handle) commit in the same transaction as the acknowledgement. | ledger ack takes a tx; test L2. |
| E-EH-08 | `POST /sessions` and all `/sessions/{id}/*` routes accept only `executionWorkspaceId`; `POST /workspaces/adopt` is the only route accepting a path and validates it per the kind matrix. | Zod strict schemas; tests W5, Z1–Z3, T1. |
| E-EH-09 | Adoption is idempotent on `(runId, realpath)` and handles survive a host restart. | sqlite `workspaces` table; tests W1, W9. |
| E-EH-10 | After a Web restart, `delivering`/`accepted` rows are reconciled from receipts and non-driverless `queued` rows are never re-sent. | `recovery.ts`; tests V1–V3. |
| E-EH-11 | A driver whose command returns `assignment_fenced` writes no run, attempt, HITL, or scratch state. | `fenced:true` result + early returns; test P3. |
| E-EH-12 | No secret value or prompt body is persisted in `execution_commands.payload`, receipt bodies, or logs. | `redact()` at ledger insert; sentinel tests C1, H7. |

### A.3 Edge cases (each with its code and owning test)

| Id | Case | Outcome / code | Test |
| --- | --- | --- | --- |
| X-EH-01 | Pinned key conflicts with the stored key | supervisor refuses boot, exit 1, `execution-host-key-conflict` | H5 |
| X-EH-02 | New identity at the configured URL while the old host owns non-terminal runs | registration refused, `readiness='unavailable'`, `EXECUTOR_UNAVAILABLE {host_identity_mismatch}` | G4 |
| X-EH-03 | Host state dir lost | new key (unless pinned) → idle-retire or X-EH-02; fences restart at the first command; handles re-adopted lazily | G3, K5 |
| X-EH-04 | Command epoch below the host high-water | 409 `FENCED` → `CONFLICT assignment_fenced` | F2, E1 |
| X-EH-05 | Same epoch, different assignment id | 409 `PRECONDITION assignment_mismatch` | F3 |
| X-EH-06 | `fence.runId` differs from the session's run | 409 `PRECONDITION run_mismatch` | F5 |
| X-EH-07 | Duplicate command with a completed/rejected receipt | verbatim replay + `X-Maister-Command-Replayed` | R1 |
| X-EH-08 | Duplicate command while the original is executing | join, same result | R2 |
| X-EH-09 | Receipt `accepted`, no in-flight (host restarted mid-turn) | 409 `PRECONDITION turn_lost` | R3 |
| X-EH-10 | Adopt path outside roots / relative / `..` / missing / symlink escape / gitdir mismatch / not a repo / repo path mismatch / inside state dir | 409 `PRECONDITION {workspace_rejected, rule}` | W5 |
| X-EH-11 | Create with an unknown handle | 409 `unknown_workspace` → client re-adopts once | W6, K5 |
| X-EH-12 | Create with a released handle | 409 `workspace_released` | W6 |
| X-EH-13 | Legacy path field or missing envelope after the strict flip | 409 `legacy_field` / `missing_envelope` | Z1–Z2 |
| X-EH-14 | Transport failure with unknown outcome before any receipt | retry the same command id up to budget, then `failed` | L3 |
| X-EH-15 | Transport failure after prompt acceptance | one receipt lookup → `succeeded{stopReason}` / `failed{turn_lost}` / `failed{receipt_missing}` | L8 |
| X-EH-16 | Web crash W1 / W2 / W4 | per D5 recovery table | V1–V3 |
| X-EH-17 | Supervisor restart during delivery | same key, new bootId, fences+receipts survive, sessions gone, reconcile classifies | V3, G2 |
| X-EH-18 | Legacy run (NULL assignment) reaches a command issuer | lazy mint `legacy_backfill` with WARN | Y5 |
| X-EH-19 | Evicted session's pending prompt | 409 `FENCED` to the old driver → driver yields | F6, P3 |
| X-EH-20 | Teardown command on a `released` assignment / any command on `superseded` | sent / locally `fenced` | A5, L6 |
| X-EH-21 | Host receipt write fails after executing | 500 `ACP_PROTOCOL`; effect may exist; reconcile catches an orphan session | R5 |
| X-EH-22 | Host unreachable at Web boot | readiness unavailable, backfill skipped once-logged, sweeps retry | G5, Y4 |

### A.4 State machines (to render as `stateDiagram-v2` in T0.2)

Host registration: `(none) → registered → [same key: touched | new key ∧ idle: retired ⇒ registered(new) | new key ∧ busy: refused(readiness=unavailable)]`.
Assignment: `(none) → active → superseded | released`, terminal both.
Command: D4 diagram verbatim.

---

## Appendix B — Wire schemas (field-level; source for OpenAPI/AsyncAPI 0.8.0)

### B.1 `CommandEnvelope` (request body of every enveloped route)

| Field | Type | Constraints |
| --- | --- | --- |
| `command.id` | string | uuid; required |
| `command.kind` | enum | `workspace.adopt \| workspace.release \| session.create \| session.prompt \| session.input \| session.cancel \| session.checkpoint \| session.delete`; must match the route |
| `command.issuedAt` | string | RFC 3339; required |
| `fence.hostKey` | string | `^[A-Za-z0-9_-]{8,64}$` |
| `fence.assignmentId` | string | uuid |
| `fence.assignmentEpoch` | integer | ≥ 1 |
| `fence.runId` | string | existing `runId` regex |
| `payload` | object | kind-specific (below); `.strict()` |

### B.2 Payloads

- `workspace.adopt`: `{ runId, projectSlug, kind: "git_worktree"|"repo_checkout"|"directory", path (absolute), repoPath? (required for git_worktree and repo_checkout, forbidden for directory), contextMounts?: [{slug, path, ref, commit}] (≤ 8) }` → 200 `{ executionWorkspaceId: "ws_…", kind, replayed: boolean }`.
- `workspace.release`: `{}` → 200 `{ released: boolean }` (false when already released); 404 unknown.
- `session.create`: D7 list → 201 `{ sessionId, pid, acpSessionId }` (unchanged shape).
- `session.prompt`: existing `SendPromptRequest` fields → 200 `{ stopReason, meta? }` (unchanged).
- `session.input`: existing `InputBody` (`action`, `requestId`, `optionId?`, `reason?`) → 200 `{ ok: true }`.
- `session.cancel`: `{}` → 200 `{ cancelled, sessionId }`; `session.checkpoint`: `{}` → 200 `{ alreadyCheckpointed, sessionId, monotonicId }`; `session.delete`: `{}` → 204.

### B.3 `GET /health` addition

`host: { hostKey: string, bootId: string (uuid), protocolVersion: 1 }`.

### B.4 `WorkspaceRecord` (`GET /workspaces/{id}`)

`{ executionWorkspaceId, runId, projectSlug, kind, adoptedAt, releasedAt? }` — no paths.

### B.5 `CommandReceipt` (`GET /commands/{commandId}`)

`{ commandId, runId, kind, assignmentEpoch, phase: "accepted"|"completed"|"rejected", httpStatus: integer, body: object, receivedAt, completedAt? }`.

### B.6 `SessionRecord` projection (`GET /sessions`, strict phase)

`{ sessionId, runId, projectSlug, stepId, nodeAttemptId?, sessionName, status, pid, startedAt, exitedAt?, exitCode?, signal?, monotonicId, acpSessionId?, executionWorkspaceId?, assignmentId?, assignmentEpoch?, createdByCommandId? }`.

### B.7 `SupervisorErrorBody` and reason tokens

`{ code: SupervisorErrorCode, message: string, details?: { reason?: ReasonToken, rule?: WorkspaceRule, runId?, commandEpoch?, hostEpoch? } }`.
`SupervisorErrorCode += "FENCED"` (HTTP 409).
`ReasonToken = host_mismatch | assignment_mismatch | run_mismatch | assignment_fenced | turn_lost | unknown_workspace | workspace_released | workspace_rejected | legacy_field | missing_envelope`.
`WorkspaceRule = relative_path | parent_segment | not_found | outside_roots | symlink_escape | gitdir_mismatch | not_a_repo | repo_path_mismatch | inside_state_dir | outside_workspace`.
Web mapping: `FENCED → CONFLICT`; every other code unchanged; `details` passed through; `EXECUTOR_UNAVAILABLE {reason:"host_identity_mismatch"}` is web-minted.

### B.8 SSE `session.command` (supervisor stream, also in `run.events.jsonl`)

`{ type: "session.command", sessionId, monotonicId, commandId, kind, phase: "accepted"|"completed", status?: "succeeded"|"failed"|"fenced", result?: object, error?: SupervisorErrorBody }`; `session.exited.reason ∈ checkpoint | intentional | fenced`.

---

## Appendix C — Migration `0128_execution_hosts` (authoritative; names declared in `schema.ts`)

```sql
CREATE TABLE "execution_hosts" (
  "id" text PRIMARY KEY NOT NULL,
  "host_key" text NOT NULL,
  "kind" text NOT NULL,
  "display_name" text NOT NULL,
  "transport" jsonb NOT NULL,
  "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "readiness" text DEFAULT 'unknown' NOT NULL,
  "readiness_reason" text,
  "last_boot_id" text,
  "last_seen_at" timestamp with time zone,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone,
  CONSTRAINT "execution_hosts_host_key_unique" UNIQUE("host_key"),
  CONSTRAINT "execution_hosts_kind_check" CHECK ("execution_hosts"."kind" in ('local_direct')),
  CONSTRAINT "execution_hosts_readiness_check" CHECK ("execution_hosts"."readiness" in ('unknown','ready','unavailable'))
);--> statement-breakpoint
CREATE TABLE "execution_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "execution_host_id" text NOT NULL,
  "epoch" integer NOT NULL,
  "state" text NOT NULL,
  "placement_reason" text NOT NULL,
  "execution_workspace_id" text,
  "workspace_adopted_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "superseded_by_id" text,
  "released_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  CONSTRAINT "execution_assignments_run_epoch_uq" UNIQUE("run_id","epoch"),
  CONSTRAINT "execution_assignments_epoch_check" CHECK ("execution_assignments"."epoch" >= 1),
  CONSTRAINT "execution_assignments_state_check" CHECK ("execution_assignments"."state" in ('active','superseded','released')),
  CONSTRAINT "execution_assignments_placement_reason_check" CHECK ("execution_assignments"."placement_reason" in ('launch','resume','recover','wait_resume','rework_return','gate_chat','sync_resolver','scratch_recover','node_interrupt','legacy_backfill')),
  CONSTRAINT "execution_assignments_active_shape_check" CHECK (("execution_assignments"."state" = 'active') = ("execution_assignments"."ended_at" IS NULL))
);--> statement-breakpoint
CREATE TABLE "execution_commands" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "execution_assignment_id" text NOT NULL,
  "execution_host_id" text NOT NULL,
  "assignment_epoch" integer NOT NULL,
  "kind" text NOT NULL,
  "target_session_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "delivering_since" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "result" jsonb,
  "last_error" jsonb,
  "driverless" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt','workspace.release','session.create','session.prompt','session.input','session.cancel','session.checkpoint','session.delete')),
  CONSTRAINT "execution_commands_state_check" CHECK ("execution_commands"."state" in ('queued','delivering','accepted','succeeded','failed','fenced')),
  CONSTRAINT "execution_commands_terminal_shape_check" CHECK (("execution_commands"."state" in ('succeeded','failed','fenced')) = ("execution_commands"."completed_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_assignment_id" text;--> statement-breakpoint
ALTER TABLE "run_sessions" ADD COLUMN "execution_assignment_id" text;--> statement-breakpoint
ALTER TABLE "run_sessions" ADD COLUMN "host_session_id" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "execution_assignment_id" text;--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_superseded_by_id_execution_assignments_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sessions" ADD CONSTRAINT "run_sessions_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_hosts_local_active_uq" ON "execution_hosts" USING btree ("kind") WHERE "execution_hosts"."kind" = 'local_direct' AND "execution_hosts"."retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_assignments_run_active_uq" ON "execution_assignments" USING btree ("run_id") WHERE "execution_assignments"."state" = 'active';--> statement-breakpoint
CREATE INDEX "execution_assignments_host_state_idx" ON "execution_assignments" USING btree ("execution_host_id","state");--> statement-breakpoint
CREATE INDEX "execution_commands_open_idx" ON "execution_commands" USING btree ("state","next_attempt_at") WHERE "execution_commands"."state" in ('queued','delivering','accepted');--> statement-breakpoint
CREATE INDEX "execution_commands_run_created_idx" ON "execution_commands" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_commands_assignment_idx" ON "execution_commands" USING btree ("execution_assignment_id");--> statement-breakpoint
CREATE INDEX "runs_execution_assignment_idx" ON "runs" USING btree ("execution_assignment_id");--> statement-breakpoint
CREATE INDEX "run_sessions_host_session_idx" ON "run_sessions" USING btree ("host_session_id");--> statement-breakpoint
CREATE INDEX "run_sessions_assignment_idx" ON "run_sessions" USING btree ("execution_assignment_id");--> statement-breakpoint
CREATE INDEX "node_attempts_assignment_idx" ON "node_attempts" USING btree ("execution_assignment_id");
```

`drizzle-kit generate` may order statements differently; names, actions and
predicates must match exactly. FK constraint names follow drizzle's
`<table>_<col>_<reftable>_<refcol>_fk` convention.

---

## Appendix D — Test strategy (TDD protocol, level ownership, anti-trivial rules)

### D.1 Levels and ownership

| Level | Runner project | What it owns |
| --- | --- | --- |
| S | supervisor `integration` (in-process Fastify + fake ACP fixture) | identity (H*), fences (F*), receipts (R*), adoption validation (W*), SSE events (S*), strict flip (Z*) |
| SU | supervisor `unit` | contract examples ↔ Zod (T2.5) |
| WU | web `unit` | envelope shape + error mapping (T*), projector tolerance (P1), registrar policy table |
| WI | web `integration` + Postgres + fake transport | assignments (A*), commands (C*), migration (M*), ledger FSM (L*), recovery FSM with injected receipts |
| WR | web `integration` + Postgres + REAL supervisor child | boundary cases only: deliverer (D*), recovery with real receipts/restart (V*), adoption client (K*), launch paths (P*, Q*, N*), lifecycle regression (E*), legacy backfill (Y*), the `hitl.ts:3545` pin (B1) |
| E2E | Playwright `authed` | UI-visible launch + DB provenance (U*) |
| LIVE | Playwright `live-supervisor` (opt-in) | real adapter smoke (S1–S2) |

Rule: each E/X id is asserted at exactly one level (Appendix A tables name it);
WR cases assert boundary outcomes, not host-side validation details already
proven at S. Existing tests migrate to `fakeBoundClient()`; they keep their
original assertions and gain none.

### D.2 TDD protocol per task

1. Write the RED tests listed in the task; run only that project; every case
   must FAIL for the intended reason (assert a reason token, a state, or a row
   shape — never a status code alone). A case that passes before GREEN is
   deleted or rewritten. Concurrency cases run BOTH orderings and carry a
   mutation proof (disable the guard, observe RED, restore).
2. GREEN: the minimal code that passes; no speculative branches.
3. REFACTOR: apply the task's named targets; suites stay green; no behavior
   change without a test.
4. Contract conformance: for touched wire objects, the OpenAPI examples are
   parsed in the SU/WU contract tests (§D.4).
5. Commit at the checkpoint with the wave's migrated tests green; report
   regressions as NAME sets.

### D.3 Anti-trivial rules

No tests for: type exports, constant values, pass-through getters, Zod schemas
without behavior, whole-object snapshots, mocks that only echo their input,
"function was called" without an outcome assertion, and no duplicate of a
host-side rule from the web level.

### D.4 Contract fixtures

`docs/api/supervisor.openapi.yaml` examples are the shared fixtures: supervisor
`openapi-examples.test.ts` and web `wire-shape.test.ts` read the YAML
(relative path from each package) and validate examples with the local Zod
schemas; a broken-fixture case proves the harness. No JSON fixture files under
`docs/` (R1 format whitelist).

### D.5 Traceability (id → owning test) — the T0.5 checklist source

E-EH-01: M2, G3–G4 · E-EH-02: A1–A3 · E-EH-03: F1–F2, F7 · E-EH-04: F6 ·
E-EH-05: R1–R3 · E-EH-06: L1 · E-EH-07: L2 · E-EH-08: W5, Z1–Z3, T1 · E-EH-09:
W1, W9 · E-EH-10: V1–V3 · E-EH-11: P3 · E-EH-12: C1, H7 · X-EH-01..22: per
Appendix A.3.

---

## Progress notes

(filled by `/aif-implement`: reproduction result of B1; live smoke run; quarantines)

- **2026-09-02 Phase 0 (T0.1–T0.5) — DONE, Commit 1.** Preflight re-run at
  main `73fa99915`: max ADR 162 (163 squatted by
  `claude/flow-target-delegation-178968`), journal `idx 127`, no branch with
  `0128+` → ADR-164 + `0128_execution_hosts` confirmed. Gates:
  `pnpm validate:docs` (88 mermaid blocks, 336 ADR anchors, 874 links, ERD
  current), `validate:contracts` all ok, `asyncapi validate` 0 errors on both
  files, `redocly lint` valid — 5 warnings = the 4 pre-existing on main
  (`no-server-example.com`, 3× `operation-4xx-response`) + 1
  `no-unused-components` for the generic `CommandEnvelope` base schema, kept
  on purpose as the contract-test fixture (T2.5) and prose anchor. Decision
  taken while writing the specs: the per-kind command schemas are explicit
  objects (not `allOf` over `CommandEnvelope`) because redocly's example
  validator applies `unevaluatedProperties` across `allOf` and rejected every
  enveloped example; `SessionCommandEvent` lives ONLY in
  `supervisor-sse.asyncapi.yaml` (R7) — T2.5's contract test reads it from
  there, not from the OpenAPI. `web/CLAUDE.md` boundary sentences were also
  updated (not in the plan's surface table, but a contradicting boundary rule
  would have violated R7). `SendPromptStopReason += cancelled` records the
  existing `/cancel` behavior (drift #8).
- **2026-09-02 Phase 2 events + e2e stub (T2.4–T2.6) — DONE, Commit 4.**
  `session.command` rides the supervisor event union (web parse only) and the
  scratch `MinimalSupervisorEvent`; the transcript projector ignores it (P1).
  Both e2e supervisors (`stub-supervisor.ts`, `test-supervisor.ts`) speak the
  transitional contract: `/health.host`, `POST /workspaces/adopt`,
  `GET|DELETE /workspaces/:id`, per-run fence, in-memory receipts,
  `session.command` emits, `GET /commands/:id`. **T2.6 acceptance is a SET
  DIFF, not "green":** the full Playwright lane fails 35 specs on main
  `73fa99915` itself (a detached baseline worktree was installed and run for
  the comparison — `ORDER BY 0` in `lib/scheduled-launches/queries.ts:380`
  crashes the project board for automation-bearing projects,
  `manifest?.spec.flows` in `lib/queries/packages.ts:197`, the intl
  `Page {page}` FORMATTING_ERROR, drift in run-sync/m11c/evaluation-lab
  specs — none touch execution-host code). Branch: 35 failed / 123 passed;
  baseline: 35 failed / 1 flaky / 122 passed; the failing NAME sets are
  identical (comm: zero entries either way). Five stub log lines
  `orchestrator session missing facade token/baseUrl` exist on main's stub
  too (line 166). Quarantine list for T7.1 = `scratchpad/base-failed.txt`.
- **2026-09-02 Phase 3 (T3.1–T3.5) — DONE, Commit 5.** `web/lib/execution-host/`
  gained `contracts.ts` (transport interface + wire DTOs), `signals.ts`
  (process-local `session.command` bus), `ledger.ts` (`issueCommand` →
  `queued` row + local admission fence), `deliverer.ts` (`COMMAND_POLICY`
  table; `deliverCommand` claim→wire→ack-tx; `deliverPrompt` with the
  first-durable-signal completion), `registrar.ts` (`REGISTRATION_POLICY`
  as data under `lockActiveLocalHost`), `resolver.ts` (30 s memo,
  `hostForAssignment` verifies the live key), `placement.ts`
  (`mintPlacement` inside the caller's tx + D9 `ensureAssignment`),
  `adoption.ts` (`workspaceSpecFor` kind map + `ensureWorkspaceAdopted`),
  `client.ts` (`BoundClient`/`HostAdminClient`, `executionHosts`
  singleton), `recovery.ts` (W1/W2/W4 + stale-active release + 7-day prune),
  `transports/local-direct.ts`; `supervisor-client.ts` gained ONE
  `request()` helper, `supervisorErrorToMaister` (details pass-through,
  FENCED→CONFLICT) and the enveloped/workspace/receipt variants;
  `persistRunSessionHostBinding` (upsert on `(run_id, session_name)`);
  `instrumentation.ts` order + the `executionHost` arm of `runSystemSweep`.
  Test harnesses: `test-support/fake-execution-host.ts` (fence high-water,
  receipts, faults, scripted prompt turns), `real-supervisor.ts` (node
  `--import tsx` child on a temp runtime root, health-gated, SIGKILL/restart
  on the same state dir), `git-fixture.ts`. Cases green: T1–T3, G1–G6,
  L1–L8, D1–D2, V1–V6, K1–K6. Findings: (1) **`GET /commands/{id}` gained
  `inflight`** (process-memory flag next to the durable row) — the plan's
  "`accepted` w/o in-flight → turn_lost" needs it to be decidable from the
  web without re-sending a prompt into a possibly-live turn; OpenAPI/Zod/
  stubs/analytics updated. (2) **A receipt lookup that fails on the wire is
  not a 404**: the driver's first lookup after a host SIGKILL raced the
  restart and folded `receipt_missing`; the deliverer now retries the lookup
  (0.5 s·2ⁿ, 5 attempts) before `receipt_lookup_failed`. (3) The
  `repo_read` + `workspace_ref` checkout is a detached LINKED worktree
  (`addDetachedWorktree`), so it adopts as `git_worktree`, not
  `repo_checkout` (the registry's `repo_path_mismatch` rule would reject the
  latter). (4) pnpm's `.bin/tsx` shim and the tsx CLI both proxy the real
  process — SIGKILL never reached the supervisor until the harness ran node
  with `--import tsx` directly. (5) D1's "input happy path" is the cancel of
  an unknown permission (the lifecycle fixture never asks for one): the wire
  answers 410 → definitive `HITL_TIMEOUT`, ledger `failed` after ONE
  attempt — recorded, not hidden. (6) The supervisor lists exited sessions
  and answers 200 on deleting an exited record (`outcome: terminated`).
  (7) `hostForAssignment`/`mintPlacement` take the caller's db (never
  `getDb()`), so the integration DB is honored. Baseline reminder: the
  supervisor-client unit test (56) and `system-sweeps.test.ts` (8, with the
  new arm mocked like every other) are green.
- **2026-09-02 Phase 1 (T1.1–T1.3) — DONE, Commit 2.** `db:generate --name
  execution_hosts` produced `0128_execution_hosts.sql` matching Appendix C
  name-for-name (this drizzle-kit wraps in `IF NOT EXISTS` / `DO $$`; journal
  `idx 128`, `when` monotonic, snapshot present; second generate = "No schema
  changes"). ERD regenerated (109 tables). Findings: (1) **Postgres truncates
  four drizzle-convention FK names to 63 bytes** (`…superseded_by_id_…`,
  `execution_commands_execution_assignment_id_…`, `node_attempts_…`,
  `run_sessions_…`) — the migration keeps drizzle's names (future diffs
  truncate identically); M1 asserts the STORED names. (2) **A3 semantics:**
  the run-row `FOR UPDATE` in `mintAssignment` serializes concurrent mints so
  BOTH succeed with distinct epochs (2 then 3, single `active`, superseded
  pointer chain) — that is the D3 "next mint supersedes anything" contract;
  mutation proof done (lock removed → A3 red — the second mint parks on the
  superseded-row UPDATE instead and the detector times out; restored). A live
  `(run_id, epoch)` race cannot be staged because an FK insert takes `FOR KEY
  SHARE` on the run row and serializes behind the same lock, so A3b exercises
  the `23505 → CONFLICT {details.reason:"assignment_mint_race"}` mapping via a
  primary-key collision (`mintAssignment` gained an optional `id`). (3) The
  self-FK forced a three-statement supersede (unpoint → insert → point).
  (4) No prose header on the SQL: no migration in this lineage carries one.
  Suite: web unit 728 files / 7283 tests green; `lib/db` + `lib/execution-host`
  integration green except `repair-trusted-package-flow-enablement`
  (`migration 0103 …`), which fails IDENTICALLY on main `73fa99915` —
  pre-existing, quarantine-by-name for T7.1's set diff.
- **2026-09-02 Phase 2 supervisor substrate (T2.1–T2.5) — DONE, Commit 3.**
  `host-state.ts` (node:sqlite, WAL; `openHostState` mints/pins/refuses;
  `inMemory` for route-only boots), `execution-fence.ts` (rules in order +
  lower-epoch eviction, legacy epoch-less sessions never evicted),
  `command-receipts.ts` (replay/join/turn_lost; `accepted` receipt written for
  EVERY kind before execution; write failure → 500 `ACP_PROTOCOL`),
  `workspace-roots.ts` + `workspace-registry.ts` (`resolveForSession` is the
  ONE path-derivation site — `legacyResolution` reproduces the pre-ADR-164
  bytes; handles keyed `(runId, realpath)` but `cwd` keeps the lexical path
  the web passed, so W7 is byte-identical on macOS `/tmp`), `http-api.ts`
  pipeline `parseCommandBody → applyFence/evict → receipts.execute →
  session.command`. Findings: (1) the checkpoint route must VALIDATE the body
  before the session lookup (a unit test pins 409-before-404); (2) post-terminal
  `session.command{completed}` (checkpoint/delete) is appended straight to
  `run.events.jsonl` because the registry closes the writer on
  `session.exited` — `EventsLogWriter.isClosed()` added; (3) a killed child
  rejects its pending ACP prompt, so the evicted prompt maps to `FENCED`
  without any SDK change (F6 uses the new `--hang-prompt` fixture flag); (4)
  Zod shape-validates adopt paths only — the registry owns the rule tokens
  (`relative_path`/`parent_segment` were being pre-empted by the old absolute
  refinement); (5) `SendPromptStopReason += cancelled` already lived in the
  code (`/cancel`). Suites: supervisor unit 413/413, integration 129/129 (17
  files incl. H1–H7, F1–F8, R1–R6, S1–S3, W1–W9), `openapi-examples` 7/7; lint
  warnings identical to main's baseline set (11 untouched files).

---

### Phase 4 progress — T4.1 (flow launch + runner-agent + runner-graph) DONE 2026-09-02

- `AgentExecution = { client: BoundClient; admin: HostAdminClient }` is bound ONCE per driver generation (`bindExecution(hosts, runId)`), lazily in `runGraph` at the first agent-kind need (attempt stamping, gates with `ai_judgment|skill_check`, consensus) — a cli-only flow never touches the host. `runAgentStep(step, ctx, execution?)` builds the handle-form create body; `SupervisorApi`/`defaultSupervisor` deleted. `StepResult.fenced` + `isFencedError` early-returns in `runGraph` write nothing (`driver-yielded` WARN at both layers).
- Launch: `localHost` replaces the two `checkSupervisorHealth` gates; `mintPlacement(tx, {reason:"launch", host})` runs after the `run_sessions` insert in the run-insert tx (P1: a tx-abort fault leaves no run AND no assignment).
- `node_attempts.execution_assignment_id` is stamped only for agent-kind nodes; `run_sessions.host_session_id` lands in the create-ack tx (`persistRunSessionHostBinding`) — the late `acp_session_id` UPDATE at `runner-graph.ts:3281` is gone; `parkCoordinatorSession` checkpoints by the persisted `host_session_id`; `releaseAssignmentForRun` at the Crashed/Failed/Review terminal writers and `markWaitingOnChildren`.
- Cases: P1–P4 green in `lib/execution-host/__tests__/launch-paths.integration.test.ts` (flow half). Suites migrated to `fakeGraphHosts`/`fakeAgentExecution`: runner-agent (22), runner-agent-hooks (9), 14 graph/context/agent integration suites, orchestrator-park (seeded `host_session_id` + fake session), orchestrator-node/session-policy/retry-policy (partial runner-agent mock keeps `bindExecution` real; `executionHosts` injected), 6 `app/api/runs` launch suites + 4 launch unit suites (`@/lib/execution-host` seam mocked — the fake db has no row locks). Pre-existing failures kept as-is: matplan `cleanup pending`, route.enforcement strict-mcps 400 (both identical on main).
- Findings: `mintPlacement`/`ensureAssignment` must resolve the host through the CALLER's transport (`localHost({db, transport})`) — the resolver defaults to the real wire otherwise, which surfaced as "local execution host unavailable" in every fake-host suite; `promoteAfterExit` must pass `executionHosts`, never this run's bound `execution`.

### Phase 4 progress — T4.2 (HITL respond + sweeper + hook-trip + node-interrupt + budget) DONE 2026-09-02

- `BoundClient.prepareInput(tx, sessionId, payload) → PreparedInput{commandId, payload, deliver({onAck})}`: the permission `session.input` row is queued INSIDE the Phase-1 claim tx (`claimed` and `noop-idempotent` branches, live `NeedsInput` only — the idle branch keeps re-issuing through the resume) and delivered after commit; the Phase-2 domain writes (respondedAt, scratch flip, assignment completion, audit, webhook) ride the ack tx with the `succeeded` row. `deliverInput` now returns `{ok, replayed}` (the wire's `x-maister-command-replayed`); a replay stamps `_audit.deliveredOptionId`. Failure paths cancel through `client.deliverInput({action:"cancel"})` (I4: exactly one); a fenced delivery logs and rethrows without cancelling or writing (yield rule). `respondToHitl(deps.executionHosts?)` is the injection seam (default `createExecutionHosts({db})`).
- `checkpointBudgetLiveSession` (Verified #6) addresses `run_sessions.host_session_id` through `forRun(runId, {teardown:true})`; B1 pinned in `hitl-budget-breach.integration.test.ts` (restart + park) against a fake host session keyed by the HOST id — reproduction note: that suite could not even load on main (its supervisor-client mock lacked `listSessions`; one of the 61 baseline failures), so B1 was pinned directly rather than reproduced live.
- `ExecutionHosts.forRun(runId, {teardown:true})` binds the run's newest assignment even when `released` (X-EH-20) via `getLatestAssignment`; `BoundClient.sessionsForRun()` replaces the sweeper's three `listSessions()`-by-key lookups: P1 checkpoints the host session id directly (no list call; null id → mark directly), time-limit/budget passes bind per acting candidate and match `(runId, stepId)`; EXECUTOR_UNAVAILABLE and a host-lookup failure leave the candidate for the next tick, `fenced` is treated like 404 in P1 and as "not ours — skip" in the kill/terminate paths. `runSweepTick({db, executionHosts?})`.
- node-interrupt route uses `host_session_id` + `executionHosts.forRun(runId).checkpoint`; the `restart_node|restart_from` claim mints `node_interrupt` (host resolved through the injected transport BEFORE the tx so an unavailable host refuses the restart whole); `resume` mints nothing. `state-transitions.ts` releases: `markCheckpointed`/`markCheckpointedFromExit` (now one tx: CAS + release), `markAbandoned`, `crashResumedRun`/`crashRunningRun`/`crashWaitingOnChildren`, `failResumedRun`, `rollbackResumedRun` (`resume_rollback`).
- Cases: I1–I3 + yield on real Postgres in NEW `lib/services/__tests__/hitl-permission-ledger.integration.test.ts`; I1–I4 at the route level (`respond/__tests__/route.test.ts`, 62 green, `@/lib/execution-host` seam mocked over the hand-rolled db); K1 in `keepalive-sweeper.test.ts` (6 cases); budget-watchdog (32) + time-limit-watchdog (9) migrated with a spy-backed fake transport; node-interrupt integration (15, incl. 2 new placement cases); hitl.integration (14). `agent-hook-trip.integration.test.ts` is coupled to `AgentSupervisorApi` → migrated with `agents/launch.ts` in T4.5.
- Findings: the fake host's `listSessions` must carry the create payload's `stepId` (was the constant "fake") for `(runId, stepId)` matching; `MaisterError` identity across `vi.resetModules()` — unit tests must re-import `@/lib/errors` after the reset or `isMaisterError` misclassifies their thrown errors.

### Phase 4 progress — T4.3 (resume / recover / drivers / claims) DONE 2026-09-02

- Mint sites live INSIDE the claim transitions (`StateTransitionOptions.placement?`): `markResumed` → `resume`, `markResumedFromWait` → `wait_resume`, `markReturnedToRunning` → `rework_return` (takeover AND rework-claim returns); `rollbackResumeFromWait` releases `wait_resume_rollback`, `rollbackResumedRun` releases `resume_rollback` (E2). `mintPlacement` is the single "mintForClaim" helper (callers that resolved the host pass it; otherwise the memoized local host resolves inside the tx). `resumeCrashedRun` mints `recover` on BOTH flips (Running and the cap-full Pending queue — the scheduler's later `driveResume` binds that active assignment); `resumeRun`/`resumeCrashedRun` resolve the host BEFORE their claim so an unavailable host is a retryable refusal with no claim taken.
- Drivers: `resumeRun` → `hosts.forRun(runId).createSession({resumeSessionId})` (no adopt: the handle is copied forward); `driveResume` → `forRun(runId, {reason:"recover"})`; `runResumedSession` binds once (`forRun`), streams via `hosts.local()`, delivers/cancels through `deliverInput`, prompts via `PromptHandle.completion`, deletes through the client, and yields on `assignment_fenced` (no terminal decision, no intent write, no teardown); `runResumeRecoverySweep` lists sessions through `hosts.local()`. Legacy `createSession` injection on `ResumeCrashedRunOptions` replaced by `executionHosts`.
- `mintAssignment` now copies the adopted handle from the run's NEWEST prior generation on the same host (released included) — the resume after a checkpoint no longer re-adopts (E1 pinned it; the old rule only copied from an ACTIVE row, which a checkpoint had already released).
- runner-agent: a prompt failure that coincides with OUR checkpoint (host answers the in-flight turn with `ACP_PROTOCOL: ACP connection closed` when the adapter is SIGTERMed mid-turn) is a paused turn, not a step failure: the consumer exposes an awaitable `checkpointObserved(waitMs)` and the runner synthesizes `{stopReason:"cancelled"}` → STEP_CHECKPOINTED. Found by E1 against the REAL supervisor; on main the same race marks the node Failed.
- `lib/execution-host/default-transport.ts`: `defaultTransport()` + `setDefaultTransportForTests()` — the ONE default the registrar/client/recovery use; `fakeExecutionHosts(db)` installs the fake for the process so production paths without an injection seam (claim transitions minting through `localHost({db: tx})`, routes, event consumers) bind to the fake in real-Postgres suites (state-transitions, gate-chat, orchestrator-resume, takeover/rework return routes are primed this way).
- Lazy binding (fix for a T4.1 regression seen in the full lane): the attempt is appended BEFORE any host binding; `bindExecution` is passed as a provider on the step ctx and resolved at the first real `runAgentStep` (mocked steps never bind; a failed binding surfaces as that attempt's failure — `runner.integration` pins "attempt appended, run terminal"); the create ack stamps `node_attempts.execution_assignment_id` (op-matrix ack tx). The pre-gate bind is gone (agent gates bind lazily the same way).
- Cases: E1 + E2 in NEW `lib/execution-host/__tests__/lifecycle-regression.integration.test.ts` against the REAL supervisor with `mock-acp-adapter-resumable.mjs` (permission → keepalive checkpoint → NeedsInputIdle + released generation → respond → epoch 2 `resume`, ONE adopt total, create carries `resumeSessionId` → a stale epoch-1 checkpoint over the wire → 409 FENCED → `CONFLICT {assignment_fenced}` → auto-delivered intent (`_audit.deliveredViaResume`) → run finishes → no live session, both generations released, nothing to fold); E3 as four placement cases in `state-transitions.integration.test.ts`. Migrated: `resume.test` (8), `resume-driver.test` (7), `resume-recovery.test` (5), `recover.integration` (11, spy-backed fake transport), `state-transitions.integration` (38), gate-chat (17), orchestrator-resume (11), takeover/rework return routes (57).

### Commit 6 gate (2026-09-02) — full lanes vs the main baseline

- unit: 7300 tests, 0 failed (baseline 7283/0). integration: 3225 tests; every NEW failure vs the baseline set was triaged: `admission-gate` (6) + ext `hitl` idle branch (1) needed a registered fake host now that the resume claim resolves the host BEFORE claiming; `orchestrator-node` (1) was this plan's own scripted-step mock predating lazy binding; `lifecycle-regression` E1 (1) timed out under lane load → the runner's checkpoint-exit grace is 10 s. `lib/runs/__tests__/dirty-resolution-race.integration.test.ts` (2 cases) is a PRE-EXISTING flake: it never touches the host, fails 1 of 2 standalone runs here and fails on the main baseline worktree — recorded, not fixed. `hitl-budget-breach` is FIXED vs the baseline (its mock could not load on main).

## Owner decisions (2026-09-02, all recommendations accepted)

1 `node:sqlite` · 2 `eh_<uuid>` + pin, conflict refuses boot · 3 refusal on busy
identity change · 4 eviction on epoch advance · 5 fix `hitl.ts:3545` in T4.2
after reproduction · 6 evidence-based backfill + lazy single-host assignment ·
7 long-lived prompt HTTP + SSE `session.command` · 8 no new `MaisterError`
code · 9 `MAISTER_WORKSPACE_ROOTS` defaults + git-root check · 10 ADR-164 +
0128 · 11 stay on the harness branch now, optional rename at implement start.
