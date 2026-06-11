# Implementation Plan: Gate-Chat, Node retry_policy, Rework session_policy, workspacePolicy Execution

Branch: feature/gate-chat-retry-rework-workspace-policy
Created: 2026-06-11

## Settings
- Testing: yes (TDD — QA writes failing tests first from Phase-A acceptance criteria)
- Logging: verbose (DEBUG-level structured logs; prefixes `[gate-chat] [retry] [checkpoint] [session-policy] [diff-scope] [dirty] [neutrality]`)
- Docs: yes (mandatory docs checkpoint — Phase A IS the docs phase; `/aif-docs` routing at completion)

## Roadmap Linkage (optional)
Milestone: "M30. Gate-chat + flow attempt/rework policies (workspacePolicy execution, retry_policy, session_policy, review-diff completeness)"  *(proposed — newest existing is M29; run `/aif-roadmap` to register, this plan only labels it)*
Rationale: Completes the M11b `workspacePolicy` execution deferral (`TODO(M11b)` at `runner-graph.ts:1950`) and adopts gate-chat (+ workspace-neutrality), retry_policy, session_policy, and the review-diff dirty-state protocol + scope switcher on the existing graph/HITL/ledger/diff substrate.

---

## 0. Verified ground truth (re-confirmed in code 2026-06-11 against branch HEAD `19888156`, main-equivalent)

**Numbering (collision-critical — RE-VERIFY at B0 against then-current main):**
- ADRs run **001–074** contiguously (073 `decisions.md:4748`, 074 `:4854` — the recon summary that said "073 next-free" was WRONG; grep HEAD directly). **Next-free = ADR-075.** Reserve **ADR-075…079** (5 new) + amend-in-place.
- Migrations: highest `0039_review_comments` (idx 39). **Next-free = `0040`** — **one** migration for all deltas (single Drizzle writer; parallel-generate is a documented snapshot hazard).
- ⚠ **Latest snapshot `meta/0039_snapshot.json` is STALE** (verified 2026-06-11: zero `run_schedules` mentions while `schema.ts:1114` + `0038_run_schedules.sql` define it) — `drizzle-kit generate` diffs against this snapshot and would re-emit `run_schedules` DDL into 0040. **B1 preflight repairs the baseline FIRST.**
- ⚠ **Sibling claim:** unmerged `feature/outbound-webhooks` (implemented, gate-green) also reserves **ADR-075 + migration 0040** at its rebase-onto-main — merge order decides who renumbers (handled at B0).

**Anchor sites (file:line):**
| Concern | Site |
| --- | --- |
| workspacePolicy execution gap (TODO) | `web/lib/flows/graph/runner-graph.ts:1937-1958` (warn-only `:1947-1952`) |
| Attempt-row create / counter | `web/lib/flows/graph/ledger.ts:72-109`, `:54-69` |
| workspace_policy / acp_session_id write | `ledger.ts:150-151`, `:327`; enforcement_snapshot write `:208` |
| Agent dispatch (hard-coded fresh session) | `runner-graph.ts:518-524` (`mode:"new-session"` `:522`) |
| session/resume call site | `supervisor/src/acp-client.ts:202-219` |
| Resume-flavor claim block | `runner-graph.ts:921-1112` |
| node_attempts schema | `web/lib/db/schema.ts:1444-1520` |
| workspacePolicySchema / reworkSchema | `web/lib/config.schema.ts:309-313`, `:472-477`, attach `:690` |
| reviewer policy validation | `web/lib/flows/hitl-validate.ts:154-182` |
| engine version constant | `web/lib/flows/engine-version.ts:18` (`"1.3.0"`) |
| MaisterError codes | `web/lib/errors-core.ts:8-24` |
| hitl_requests schema | `web/lib/db/schema.ts:1871-1905` (kind = `permission\|form\|human`) |
| review_comments schema (anchor CHECK) | `web/lib/db/schema.ts:1907-1978` (CHECK `:1965-1968`) |
| rework compose | `web/lib/review-comments/serialize.ts`; consumed `runner-graph.ts:1984-2035` |
| keepalive bump / sweeper | `state-transitions.ts:161-183`; `web/lib/runs/keepalive-sweeper.ts` |
| HITL respond route + invariant | `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`; `web/lib/services/hitl.ts:53-54,925-926` |
| supervisor `/sessions/:id/prompt` | `supervisor/src/http-api.ts:251` (409 unless `live`) |
| SSE bridge | `web/app/api/runs/[runId]/stream/route.ts` |
| SessionEvent union | `supervisor/src/types.ts:283-323`; `SendPromptRequestSchema` `:178` (`{stepId,prompt}`) |
| run artifacts base (OUTSIDE worktree) | `supervisor/src/spawn.ts:132-139` → `runtimeRoot/.maister/<slug>/runs/<runId>/` |
| scratch chat substrate (reuse) | `web/lib/scratch-runs/events.ts:510`; table-agnostic seam `web/lib/supervisor-client.ts:480` |
| **ADR-041 enforcement model** | `docs/system-analytics/flow-settings.md:38-90`; `web/lib/flows/enforcement.ts` (`ENFORCEABILITY_BY_AGENT`, all `instructed`); snapshot write `runner-graph.ts:1290-1295` |
| **agent prompt assembly (instruction seam)** | `web/lib/flows/runner-agent.ts:485-489` (`renderStrict`→`resolvedPrompt`), send `:544-547` — NO existing wrap mechanism |
| **permission requestPermission callback** | `acp-client.ts:106-151`; toolCall shape (`kind`) `:51-55`; pending-permissions `supervisor/src/pending-permissions.ts` register `:70` resolve `:129` cancel `:148` |
| **hitl persist on permission (bypass for chat)** | flow `runner-agent.ts:233-285`; scratch `scratch-runs/events.ts:177-234,438` |
| **runner permission policy** | `platform_acp_runners.permission_policy`; applied `supervisor/src/runner-provisioner.ts:64-75` (`--dangerously-skip-permissions`); `permissionMode:allow`→`bypassPermissions` `web/lib/capabilities/agent-map.ts:50-56`, `materialize.ts:226,250` |
| **mutating-vs-read classifier** | ACP `toolCall.kind`; M29 sensor `web/lib/flows/graph/mutation-check.ts` (`touchedPaths:98`, `resolveDiffRange:63`, fail-closed `:292`) |
| **GET /diff route + base** | `web/app/api/runs/[runId]/diff/route.ts:128`, base 170-181, `loadFlowDiffRows:101-126` |
| **ADR-066 diff pipeline + truncation** | `web/lib/diff/prepare.ts:142` (`prepareDiff`), `_getFullBundle:139`; byte-cap guard in `worktree.ts` (`diffRunWorkspace:379-391`, `diffRange:1026-1038`, `streamGitDiffTruncated:1048+`) |
| **read-only worktree git ops** | `worktree.ts`: `statusPorcelain:1167` (✅ exists, incl untracked), `diffRange:1008`, `diffNameStatus:1118`, `resolveRefSha:1290`, `headCommit:591`, `resolveBaseRef:1241`. **MISSING: `git diff HEAD`+untracked helper; discard primitive** |
| **M27 snapshot-commit** | `snapshotDirtyWorktree(worktreePath,msg)` `worktree.ts:1214`; lifecycle `workbench-lifecycle/service.ts:613` |
| **review-gate HITL insert / base_commit** | `runner-graph.ts:286-294` (kind `human`); `workspaces.base_commit` `schema.ts:1075` |
| **pending-HITL payload / dirty precedent** | `getRunDetail` `web/lib/queries/run.ts:152` (`RunPendingHitl:66-80` — NOT `services/`); `buildReviewPanelData` `layout.tsx:91`; review-panel `web/components/runs/review-panel.tsx`; takeover dirty-refuse precedent `takeover/return/route.ts:210-213` |

---

## 1. Key design decisions (each LOCKED in a Phase-A ADR before any code)

**DD1 — Gate-chat persistence = new sibling table `gate_chat_messages`, NOT `review_comments`** (its anchor CHECK `schema.ts:1965` requires file/line + has no agent-author role). Justify in **ADR-075**.

**DD2 — Availability = session-presence-driven, answer-only, permission & HumanWorking EXCLUDED.** Chat enabled iff: run status ∈ `{NeedsInput, NeedsInputIdle}` AND the open HITL `kind ∈ {human, form}` (no `human_review` DB kind — review gates persist as `kind:"human"`) AND `runs.acp_session_id ≠ null`. Excluded by construction: `permission`-kind (session mid-prompt-turn — proven via `acp-client.ts:106-151` in-flight `conn.prompt()` promise + `supervisor.openapi.yaml:167-172` + scratch `state.ts:25`); `HumanWorking` (manual takeover — the human owns the worktree, no live agent session); the empty (no `acp_session_id`) case → explanatory empty-state.

**DD3 — Live vs idle chat turn; chat NEVER resolves the HITL, NEVER flips →Running.**
- `NeedsInput` (live, turn complete): prompt the live session; reply streams over the SSE bridge; status stays `NeedsInput`.
- `NeedsInputIdle`: **chat-resume** = respawn + `session/resume` on `runs.acp_session_id` + `markResumed` (Idle→NeedsInput) + bump keepalive + prompt; the run re-idles via the sweeper. MUST NOT call `scheduleResumedSessionDrive` (no runner re-drive) and MUST NOT touch the `hitl_requests` row. Surface the ~$0.28 respawn cost before the first idle question.
- Allow-list invariant (tested): chat may drive `Idle→NeedsInput`; NEVER `→Running`; never writes `hitl_requests.responded_at`.

**DD4 — New SSE event kind `session.chat_turn`** (DD-locked shape in ADR-075 + both AsyncAPI files) so the UI renders chat without polluting the flow timeline. Carries a `mutation_reverted` flag for the DD11 layer-3 notice. Chat route tags its prompt with a server-derived marker (`stepId="gate-chat-<hitlRequestId>"` — dash, NOT colon: supervisor `SendPromptRequestSchema.stepId` enforces `SAFE_PATH_SEGMENT /^[A-Za-z0-9._-]+$/` (`types.ts:9`), a colon 400s the first chat prompt; the stepId also names the per-step log file).

**DD5 — Node checkpoint capture = namespaced dangling git refs** `refs/maister/checkpoints/<runId>/<nodeAttemptId>` (temp-index commit of HEAD+tracked+untracked, NOT on the run branch). Record on `node_attempts.checkpoint_ref`. Keeps the promoted branch clean, crash-safe (reconcile tolerates orphans), GC'd with the worktree. Locked in **ADR-076**.

**DD6 — `fresh-attempt` vs `rewind-to-node-checkpoint` vs `keep` locked:** `keep` = no-op. The DD5 checkpoint commit is parented on the then-current branch tip, so `<ck>^` = the pre-attempt tip for free. `rewind-to-node-checkpoint` = branch back to the pre-attempt tip + working tree restored to the captured state WITHOUT staging it (`git reset --hard <ck>^`, then overlay the captured tree — `git read-tree --reset -u <ck>^{tree}` + `git reset --mixed <ck>^` family; exact incantation locked in ADR-076). Result: captured-tracked content restored, captured-untracked files come back UNTRACKED, attempt-created untracked files survive, attempt commits are discarded. **NEVER `git reset --hard <checkpoint>`** — that grafts the temp-index commit onto the run branch (violates DD5 "branch NOT advanced" + the B5 promoted-branch-clean assert) and converts captured-untracked files into tracked ones. `fresh-attempt` = `git reset --hard <ck>^` + `git clean -fd` (discard untracked **source**, **KEEP ignored** like `node_modules`/build caches) + re-materialization per DD6-note-2. Locked in **ADR-076**.
  - *DD6-note (q#5 resolved):* both `fresh-attempt` and the DD12 discard use `git clean -fd`, **never `-fdx`**. `-x` would delete ignored files (`node_modules`, `.next/`, `target/`, `.venv/`) the checkpoint does NOT contain (temp-index `git add -A` excludes ignored) → a slow `pnpm install`/rebuild on every retry/discard, and is *more dangerous* (an ignored `.maister/` symlink inside a worktree would be nuked by `-x`; `-fd` respects the ignore). A future per-policy `clean_ignored:true` opt-in can re-enable `-x` for flows needing a pristine build; not v1.
  - *DD6-note-2 (materialization interplay — verified):* capability bundles are materialized ONCE at launch (`web/lib/services/runs.ts:734` — `copyBundleArtifactsToWorktree` + `writeAiFactoryConfigOverride` + `ensureWorktreeGitignore`); bundle artifacts land **untracked + UN-ignored** (only `/.gitignore` + `/.ai-factory/config.yaml` are gitignored — patch 2026-06-09-20.30), so `git clean -fd` (fresh-attempt, DD12 discard) deletes them with nothing re-creating them, and index rewrites drop the tracked-override `skip-worktree` state. **Fix:** extract the launch materialization block into a reusable helper and RE-RUN it (idempotent) after every `fresh-attempt` and dirty-resolution discard (B3/B8). Consumer-project review gates will list materialized artifacts in `dirtySummary` — known v1 noise, documented in A3 (dogfood unaffected: its skills/agents are repo-local, nothing is materialized).

**DD7 — `retry_policy`** on `ai_coding`/`cli`: `{attempts≥1, on_errors:[code…], workspace=rewind-to-node-checkpoint}`. Auto-retry on `MaisterError.code ∈ on_errors`; `on_errors` validated at manifest-load against the retryable allow-list `{SPAWN, EXECUTOR_UNAVAILABLE, CHECKPOINT, ACP_PROTOCOL}`, else `CONFIG`. Always fresh session, applies `workspace` via the DD5/DD6 engine first, respects the concurrency cap, never bypasses gates, observable on the ledger (`auto_retry`), distinct exhaustion signal. Locked in **ADR-077**.

**DD8 — `session_policy` for rework** `resume|new_session`, resolved highest-wins: rework-transition (`rework.session_policy`) → node (`session_policy`) → flow (`defaults.session_policy`) → engine default **`resume`** (a deliberate flip). `resume` resumes the prior attempt's session; gone/unresumable → fall back to `new_session` + `node_attempts.session_fallback=true`. Snapshot effective into `node_attempts.session_policy`. **Idle/checkpointed prior session still resumes** (q#4 resolved — NO special-casing: the ~$0.28 respawn buys back the critique context, which is the point of the resume-default; surface the cost in the UI). Manual-takeover return + slash-in-existing interplay locked in **ADR-078**.

**DD9 — One migration `0040`, one engine bump `1.3.0→1.4.0`** (`engine-version.ts:18`) gating the new DSL keys (`retry_policy`, `session_policy`, `defaults`); graph flows using them declare `compat.engine_min ≥ 1.4.0`. Feature 4 + review-diff need no bump (no new flow DSL).

**DD10 — Rewind/discard are worktree-only and CANNOT touch run artifacts.** Logs/inputs/`cost.jsonl`/`run.events.jsonl` live at `runtimeRoot/.maister/<slug>/runs/<runId>/` (`spawn.ts:132-139`), separate from `request.worktreePath`. All git mutations scope `-C <worktreePath>`; a test asserts artifacts survive. Phase A also documents the operational precondition that `MAISTER_RUNTIME_ROOT` resolves outside every `repo_path` (else a non-ignored artifacts path inside the worktree could be reached by `git clean -fd` — hard-block in code with a path-containment assertion; note `-fd` already spares an *ignored* `.maister/`, but the assert covers the non-ignored case).

**DD11 — Gate-chat workspace-neutrality (3-layer; layer-3 is the only hard guarantee).** Chat is answer-only: reads allowed (grounding), mutations forbidden. Consistent with the ADR-041 `instruct`-only reality (`flow-settings.md:88-90`: every cell is `instructed`; strict prevention is deferred) — so this MIRRORS the ADR-074 "detect-after" stance.
- **L1 Instruct:** prepend a "read-only Q&A, do not modify the workspace" preamble to every chat prompt (new wrap at the chat send seam — none exists today; `runner-agent.ts:485` is the analog).
- **L2 Permission auto-deny (best-effort):** add `readOnlyTurn:true` to `SendPromptRequestSchema` (`types.ts:178`) + the session record; inside `requestPermission` (`acp-client.ts:106`) classify `params.toolCall.kind` — unambiguous mutating kinds `{edit, write/create, delete, move}` → auto-resolve with a reject option from `params.options` BEFORE the SSE emit + `pendingPermissions.register` (so NO `session.permission_request` event fires → NO `hitl_requests` row). `{read, fetch}` pass. **`execute` (bash) passes L2** (so read-only commands like `grep`/`cat` work) and relies on L3 to catch+revert any actual write — q#2 resolved: let-through + L3 guarantee, NOT blanket-deny `execute`. **L2 is a no-op when the runner uses `--dangerously-skip-permissions` or `permissionMode:allow`** — documented, hence L3.
- **L3 Mutation sensor (hard guarantee):** capture ONE known-good baseline via the **Feature-4 machinery** at the *first* chat turn of a pause (`refs/maister/chat-checkpoints/<runId>/<hitlRequestId>`, **bounded at 1** — the post-attempt under-review state, distinct from the node's pre-attempt `checkpoint_ref`); reuse it to verify EVERY subsequent turn (`statusPorcelain` + `git diff` vs the baseline). On delta → restore to the baseline (Feature-4 rewind overlay + **targeted deletion of rogue untracked paths absent from the baseline tree** — the sensor's own delta set; NEVER a blanket `git clean`, which would nuke baseline-untracked files + materialized artifacts; never touching `.maister/`), set `gate_chat_messages.mutation_reverted=true`, emit an audit signal (Observatory-ready), surface a UI notice on the turn. **Anchor to the FIRST turn (not refreshed per turn)** so an undetected-then-detected mutation still restores to the original good state. GC the ref when the HITL resolves / the run leaves the pause. **A DD12 dirty-resolution executed mid-pause DELETES the ref** (B3 `deleteChatCheckpoint`; the next turn re-anchors fresh) — else the sensor would "revert" the reviewer's explicit Discard, i.e. un-discard it. Per-turn forensic *history* lives in the `gate_chat_messages` rows + `mutation_reverted` flags + audit signals — NOT N git refs (q#7 resolved). L3 runs unconditionally (covers permissive runners). **This makes Feature 1 depend on Feature 4 (B3).**
- **Feature-3 interplay:** when a later rework resumes the SAME session (`session_policy:resume`), the rework prompt MUST explicitly lift the chat-time read-only restriction (the prior turns in conversation context said "don't edit"), else the agent may refuse legitimate edits. Handled as an L1-style preamble on the rework prompt (B14 + the rework-compose payload).
Locked in **ADR-075**, amending **ADR-041** (best-effort L2 within instructed-only) and **ADR-074** (reuse the detect-after sensor).

**DD12 — Review-diff completeness: dirty-state protocol + 4-mode scope switcher** (replaces/extends Feature 4 item 7).
- **Pre-review dirty detection:** when a review gate opens, the runner runs `statusPorcelain` (incl untracked) — **no auto-commit**. A dirty worktree does NOT block the gate; the gate payload carries a `dirtySummary` (file list + staged/unstaged/untracked counts).
- **Reviewer's explicit dirty-resolution** (surfaced in the review/HITL panel, recorded on the HITL row + audit): "Commit as snapshot" (reuse `snapshotDirtyWorktree`, auto-message `"wip after node <id>"`; scopes recompute after the tip moves) · "Discard" (NEW primitive `git restore --staged --worktree . && git clean -fd` — **`-fd` not `-fdx`** per DD6-note, scoped `-C <worktree>`, hard `.maister/`-containment assert, followed by re-materialization per DD6-note-2; v1 all-or-nothing) · "Proceed as-is" (review committed state; persistent dirty badge stays). Every executed choice also deletes the DD11 chat-checkpoint ref (B3 `deleteChatCheckpoint`) so the L3 sensor re-anchors — no false un-discard. The gate is never blocked — the choice is part of review, not a precondition.
- **4-mode diff scope switcher** (UI toggle + `scope` query param on `GET /api/runs/{runId}/diff`; OpenAPI updated; all share the ADR-066 `prepareDiff` pipeline + byte-cap truncation guard):
  - `run` (default): `workspace.baseCommit..branch` — current behavior.
  - `since-last-review`: `<prev-review-visit-sha>..branch`; record the branch tip SHA per review-gate visit (NEW column `hitl_requests.review_tip_sha`, stamped via `headCommit` at the `runner-graph.ts:286` insert).
  - `last-node`: `<pre-attempt-checkpoint-sha>..branch` for the latest completed agent node — base from the **Feature-4 checkpoint refs** (exact even with zero/many agent commits), NOT commit_set artifacts.
  - `uncommitted`: `HEAD` vs working tree (tracked) + untracked rendered as additions — needs the NEW `git diff HEAD`+untracked helper; never mutate the index.
- **Graceful degrade:** scopes whose base ref is missing (pre-feature runs, first review visit) are hidden/disabled with a reason, not erroring.
Locked in **ADR-079**, amending **ADR-066** (diff stack — new scopes) and reusing M27 snapshot (workbench-lifecycle).

---

## 2. Cross-cutting invariants (project skill-context rules — applied to EVERY relevant task)

- **X-CONTRACT** — Phase A maps every changed surface → spec file: HTTP route → `web.openapi.yaml` + prose; SSE event → `async/*.asyncapi.yaml` + `system-analytics/*`; DB column/table → migration + `database-schema.md` + `db/*.md` ERD; new Flow DSL key → `flow-dsl.md` + `config.schema.ts`. No new MaisterError code is introduced (all reused) — assert explicitly.
- **X-IDENT** — every new/changed route labels each identifier `url-param|auth-context|server-state|body-controlled`; no `body-controlled` cross-resource locator when a `server-state` value exists. Chat body = `{message}`; dirty-resolution body = `{choice}`; diff `scope` is an enum query param validated against an allow-list; all session/slug/step/run ids are server-state-derived.
- **X-2PC** — routes with a downstream side-effect (supervisor prompt/respawn; git commit/discard) specify order-of-ops (intent BEFORE the side-effect; the idempotency/`responded`/`seq` marker AFTER), a failure-classification table, and a `SELECT … FOR UPDATE` guard checking terminal-status + marker first.
- **X-DEFER** — code creating a deferred (in-flight ACP prompt, respawn handle, the L2 permission deferral) names every release path; every catch releases it; a regression test asserts release on simulated failure.
- **X-ATOMIC** — multi-store transitions (auto-retry: ledger+cursor; rework: ledger+status+cursor+git; checkpoint: ref+ledger; dirty-resolution: git+ledger+audit) use one `db.transaction`/CAS for persistent writes; git side-effects BEFORE the tx; async runner/resume AFTER commit; enumerate each crash window + its tested recovery; reconcile + GC tolerate orphaned `checkpoint_ref` / chat-checkpoint refs.
- **X-FANOUT** — the new `session.chat_turn` event + new `session_policy` enum fan out to ALL consumers: both AsyncAPI files, `supervisor/src/types.ts` union, the SSE bridge typing, the scratch `MinimalSupervisorEvent` union (`events.ts:57-81`), the run-detail consumer. New enums validated by allow-list.
- **X-NEUTRAL** — chat input is NEVER Mustache-evaluated; the L1 preamble is server-side, not user text; the L3 sensor is unconditional and fail-closed (a sensor that cannot sense must not pass — mirror `mutation-check.ts:292`).
- **X-TEST** — every test names its runner project (`unit`/`integration`/supervisor `vitest`/playwright `e2e`); confirm the `include` glob matches (`web/vitest.workspace.ts`); each phase exits on full suite green; assertion migration for touched existing tests is in-scope + enumerated (`hitl-validate.test.ts`, `ledger.integration.test.ts`, `m11a-review-rework.spec.ts`, `review-comments.spec.ts`, the diff route tests).
- **X-DEPLOY** — any new env var/port/sidecar → `.env.example` + compose + `docs/configuration.md`; a deferred dep gets a documented gap. (Candidates: `MAISTER_GATE_CHAT_ENABLED`, a chat/checkpoint ref namespace, the `MAISTER_RUNTIME_ROOT` containment precondition — audit at B20.)

---

## 3. Dependency graph

```
Phase A (docs) ── strictly before ── Phase B (code)
A1(numbering+ADR-075..079) · A2(F4 exec) · A3(F4 review-diff) · A4(F2) · A5(F3) · A6(F1+neutrality) · A7(cross-cut)
        └────────────────── A8 (Phase-A consistency gate) ──> B0

B0 (re-verify numbering + engine 1.4.0)
 └─> B1 (schema.ts + migration 0040 — ALL deltas, single writer)
       ├─ Feature 4a workspacePolicy exec: B2 QA ─> B3 impl ─> B4 reconcile/GC ─> B5 review   ◀── FOUNDATION
       │      └────────────────────── shared dep (checkpoint machinery) ──────────────────────┐
       ├─ Feature 4b review-diff:   B6 QA ─> B7 scope-switcher ─> B8 dirty-protocol ─> B9 review   (B7 last-node base ← B3)
       ├─ Feature 2 retry_policy:   B10 QA ─> B11 impl (← B3) ─> B12 review
       ├─ Feature 3 session_policy: B13 QA ─> B14 impl ─> B15 review        ◀── only fully-independent track
       └─ Feature 1 gate-chat:      B16 QA ─> B17 backend (L3 ← B3) ─> B18 UI ─> B19 review   (B16 dirty-interplay case ← B8)
                                              └ Feature-3 interplay: rework-resume lifts L1 (couples B14↔B17/B18)
B20 deployment-wiring audit  (after B3,B8,B17)
B21 final verification gate  (after B5,B9,B12,B15,B19,B20)
```

Parallelism after **B3**: Feature 4b, Feature 2, Feature 1 each consume Feature-4a's checkpoint machinery → they run in parallel with each other and with the fully-independent Feature 3. (Revised from the original: gate-chat is NO LONGER independent — DD11 L3 needs B3.)

---

## Commit Plan
- **Commit 1** — Phase A (A1–A8): `docs: M30 analytics — gate-chat+neutrality, retry/session policy, workspacePolicy exec, review-diff (ADR-075..079)`
- **Commit 2** — B0–B1: `feat(db): migration 0040 + engine 1.4.0 — chat table, checkpoint_ref, session_policy, review_tip_sha, dirty_resolution`
- **Commit 3** — Feature 4a (B2–B5): `feat(flows): execute workspacePolicy — checkpoints + rewind/fresh-attempt (M11b deferral)`
- **Commit 4** — Feature 4b (B6–B9): `feat(runs): review-diff dirty-state protocol + 4-mode scope switcher`
- **Commit 5** — Feature 2 (B10–B12): `feat(flows): node-level retry_policy`
- **Commit 6** — Feature 3 (B13–B15): `feat(flows): session_policy for rework (resume-by-default)`
- **Commit 7** — Feature 1 (B16–B19): `feat(runs): gate-chat at HITL pauses + workspace-neutrality`
- **Commit 8** — B20–B21: `chore: deployment wiring + final verification gate (M30)`

---

## Tasks

### Progress (implement tracker — source of truth for resume)
- [x] A1 — ADR audit + numbering reservation
- [x] A2 — Feature 4a analytics (workspacePolicy execution)
- [x] A3 — Feature 4b analytics (review-diff completeness)
- [x] A4 — Feature 2 analytics (retry_policy)
- [x] A5 — Feature 3 analytics (session_policy)
- [x] A6 — Feature 1 analytics (gate-chat + neutrality)
- [x] A7 — Cross-cutting analytics
- [x] A8 — Phase-A consistency gate
- [x] B0 — Re-verify numbering + engine bump
- [x] B1 — Schema + migration 0040
- [x] B2 — QA: checkpoint/rewind/fresh-attempt (red)
- [x] B3 — Impl: workspacePolicy engine
- [x] B4 — Reconcile + GC tolerance
- [x] B5 — Reviewer pass Feature 4a
- [x] B6 — QA: dirty protocol + scope switcher (red)
- [x] B7 — Impl: diff scope switcher
- [x] B8 — Impl: dirty-state protocol
- [x] B9 — Reviewer pass Feature 4b
- [x] B10 — QA: retry_policy (red)
- [x] B11 — Impl: retry_policy
- [x] B12 — Reviewer pass Feature 2
- [x] B13 — QA: session_policy (red)
- [x] B14 — Impl: session_policy
- [x] B15 — Reviewer pass Feature 3
- [x] B16 — QA: gate-chat + neutrality (red)
- [x] B17 — Impl: gate-chat backend + neutrality (L1/L2/L3)
- [x] B18 — Impl: gate-chat UI
- [x] B19 — Reviewer pass Feature 1
- [ ] B20 — Deployment wiring audit
- [ ] B21 — Final verification gate

### Phase A — Documentation-first analytics (complete + internally consistent before ANY code)

#### A1 — ADR audit + numbering reservation
**Deliverable:** Audit overlapping ADRs; write **ADR-075** (gate-chat + DD11 neutrality), **ADR-076** (workspacePolicy exec + checkpoints, DD5/DD6/DD10), **ADR-077** (retry_policy, DD7), **ADR-078** (session_policy, DD8), **ADR-079** (review-diff completeness, DD12). Amend in place: ADR-072 (review_comments — compose folds chat), ADR-027 (ledger new columns), ADR-026 (engine 1.4.0 + DSL keys), ADR-066 (diff scopes), ADR-041 (best-effort L2 within instructed-only), ADR-074 (L3 reuses the detect-after sensor), ADR-006 (idle-resume reuse), ADR-030 (takeover interplay). Update the index table `decisions.md:97-99` — it currently ENDS at the ADR-072 row while sections ADR-073/074 exist (`:4748`/`:4854`, harness-loop omission): **backfill the missing 073/074 index rows first**, then add 075–079.
**Files:** `docs/decisions.md`. **Verify:** ADRs 075–079 unique; amended ADRs keep numbers; each DD1–DD12 maps to an ADR section; `pnpm validate:docs:adr` green (`scripts/validate-docs-adr-anchors.mjs` — known blind spot: `_` slugs, eyeball those). **(X-CONTRACT)**

#### A2 — Feature 4a analytics (workspacePolicy execution)
**Deliverable:** `docs/system-analytics/flow-graph.md`: checkpoint capture (DD5), the three policy semantics (DD6) as a state machine, `checkpoint_ref` ledger field, run-artifact safety + `MAISTER_RUNTIME_ROOT` containment (DD10). `docs/flow-dsl.md`: drop "execution deferred to M11b" (`:151`). **Remove every "execution deferred"/"TODO(M11b)" doc mention** + correct the workspacePolicy enum prose: `docs/database-schema.md`, `docs/db/{erd,runs-domain,hitl-domain}.md`, `docs/api/web.openapi.yaml:7296` (+ `:2192,:2197,:7250`). User story + DoD.
**Verify:** `grep -rnE "deferred to M11b|M11a executes|TODO\(M11b\)" docs/` == 0 — NB the live phrasing is "execution **is** deferred to M11b" (`flow-dsl.md:151`) and the OpenAPI prose says "M11a executes `keep`"; the original narrower grep (`"execution deferred"`) matches NOTHING even before this work and would gate nothing. Each policy has explicit semantics + orphan-ref crash note. **(X-CONTRACT, X-ATOMIC doc)**

#### A3 — Feature 4b analytics (review-diff completeness)
**Deliverable:** `docs/system-analytics/`: dirty-state protocol (detection, the three reviewer choices, ledger/audit recording, gate-never-blocked), the 4-mode scope switcher table (bases per DD12), graceful-degrade rule, the discard `.maister/`-safety guarantee, the chat-baseline invalidation rule (every dirty-resolution deletes the DD11 chat-checkpoint ref), and the consumer-project caveat that launch-materialized bundle artifacts appear in `dirtySummary` (known v1 noise per DD6-note-2; dogfood unaffected). `docs/api/web.openapi.yaml`: `GET /api/runs/{runId}/diff` `scope` query param (enum, default `run`) + the new dirty-resolution route `POST /api/runs/{runId}/hitl/{hitlRequestId}/dirty-resolution` (X-IDENT labels, X-2PC failure table). DB docs: `hitl_requests.review_tip_sha` + `hitl_requests.dirty_resolution`. User story + DoD. Cross-link ADR-066/ADR-079.
**Files:** `docs/system-analytics/{flow-graph,hitl,workbench-lifecycle}.md` (choose the home + cross-link), `docs/api/web.openapi.yaml`, `docs/database-schema.md`, `docs/db/{erd,hitl-domain}.md`. **Verify:** all four scopes + three dirty choices documented exactly as coded; the discard `.maister/` invariant stated. **(X-CONTRACT, X-IDENT, X-2PC)**

#### A4 — Feature 2 analytics (retry_policy)
**Deliverable:** `docs/flow-dsl.md` `retry_policy` key (fields, defaults, retryable allow-list, manifest-validation rejection→CONFIG, floor `≥1.4.0`); `flow-graph.md` auto-retry ledger semantics (`auto_retry`), cap-respect, gate non-bypass, exhaustion signal; `web.openapi.yaml` auto-retry on the attempt DTO. User story + DoD. **Verify:** allow-list written as allow-list. **(X-CONTRACT, X-FANOUT doc)**

#### A5 — Feature 3 analytics (session_policy)
**Deliverable:** `docs/flow-dsl.md` `session_policy` + `defaults:` block + 3-level resolution (DD8) + floor; `flow-graph.md` rework-resume semantics, fallback (`session_fallback`), snapshot (`session_policy`), interplay matrix; `manual-takeover.md` interplay paragraph; DB docs for the two columns. The "deliberate flip" rationale in ADR-078 + the L1-restriction-lift interplay with DD11. User story + DoD. **Verify:** resolution highest-wins + default `resume` explicit. **(X-CONTRACT)**

#### A6 — Feature 1 analytics (gate-chat + neutrality)
**Deliverable:** `docs/system-analytics/hitl.md`: gate-chat lifecycle, the DD2 availability rule (with permission + HumanWorking exclusion + evidence), the live/idle state diagram (DD3), the "never resolves HITL / never →Running" allow-list, AND the DD11 3-layer neutrality model (L1 instruct, L2 best-effort auto-deny + the permissive-runner no-op caveat, L3 sensor-as-guarantee + restore + audit + UI notice, Feature-3 lift interplay, the DD12 dirty-resolution baseline-invalidation rule). `review-comments.md`: extend rework-compose to fold chat history (doc-frozen `serialize.ts` → doc FIRST). `scratch-runs.md`: reuse note. New `gate_chat_messages` table (+`mutation_reverted`) in `database-schema.md`+`db/{erd,hitl-domain}.md`. `web.openapi.yaml`: `POST/GET /api/runs/{runId}/hitl/{hitlRequestId}/chat` (X-IDENT, X-2PC, idle-cost surfacing). Both `async/*.asyncapi.yaml`: `session.chat_turn` (DD4) into `oneOf` + `type` enum. User story + DoD. **Verify:** availability = `status∈{NeedsInput,NeedsInputIdle} ∧ kind∈{human,form} ∧ acp_session_id≠null`; L1/L2/L3 each have a paragraph; event added to BOTH async files. **(X-CONTRACT, X-IDENT, X-2PC, X-FANOUT, X-NEUTRAL)**

#### A7 — Cross-cutting analytics (engine, contract-surface map, fan-out, deployment)
**Deliverable:** engine-bump doc; the **contract-surface→spec-file table** for the whole milestone; the X-FANOUT consumer set for the new event + enum; config-state symmetry note (DSL keys live in `flow_revisions.manifest`, parsed fresh — natural CLEAR, no upsert defect); the X-DEPLOY candidate-env-var list for B20. **Verify:** the table lists every route/event/column/DSL-key + spec file. **(X-CONTRACT, X-DEPLOY, X-FANOUT)**

**A7 contract-surface map (produced — every row B21 must confirm in code; all Designed until Phase B):**

| Surface | Kind | Spec file(s) | Code site (Phase B) |
| --- | --- | --- | --- |
| `GraphNodeStatus.autoRetry` | HTTP DTO field | `web.openapi.yaml` | graph-status query/route |
| `GET /api/runs/{runId}/diff?scope=` | HTTP query param | `web.openapi.yaml` | `diff/route.ts` (B7) |
| `POST .../hitl/{id}/dirty-resolution` | HTTP route | `web.openapi.yaml` | new route (B8) |
| `GET`+`POST .../hitl/{id}/chat` | HTTP route | `web.openapi.yaml` | new route (B17) |
| `session.chat_turn` | SSE event | `web-runs.asyncapi.yaml` + `supervisor-sse.asyncapi.yaml` | supervisor `types.ts` union + bridge + scratch union (B17) |
| `node_attempts.checkpoint_ref` | DB column | migration `0040` + `database-schema.md` + `db/{erd,runs-domain}.md` | `schema.ts` (B1) |
| `node_attempts.auto_retry` | DB column | migration `0040` + `database-schema.md` + `db/{erd,runs-domain}.md` | `schema.ts` (B1) |
| `node_attempts.session_policy` | DB column | migration `0040` + `database-schema.md` + `db/{erd,runs-domain}.md` | `schema.ts` (B1) |
| `node_attempts.session_fallback` | DB column | migration `0040` + `database-schema.md` + `db/{erd,runs-domain}.md` | `schema.ts` (B1) |
| `hitl_requests.review_tip_sha` | DB column | migration `0040` + `database-schema.md` + `db/{erd,hitl-domain}.md` | `schema.ts` (B1) |
| `hitl_requests.dirty_resolution` | DB column | migration `0040` + `database-schema.md` + `db/{erd,hitl-domain}.md` | `schema.ts` (B1) |
| `gate_chat_messages` (table) | DB table | migration `0040` + `database-schema.md` + `db/{erd,hitl-domain}.md` | `schema.ts` (B1) |
| `retry_policy` | Flow DSL key | `flow-dsl.md` + `flow-graph.md` | `config.schema.ts` (B11) |
| `session_policy` / `defaults` | Flow DSL key | `flow-dsl.md` + `flow-graph.md` | `config.schema.ts` (B14) |
| workspacePolicy execution | engine behavior | `flow-graph.md` + `flow-dsl.md` | `runner-graph.ts` (B3) |
| engine `1.4.0` | code constant | `configuration.md` + `flow-dsl.md` | `engine-version.ts` (B0) |

**X-FANOUT consumer set** (new event + enum fan out to ALL consumers):
- `session.chat_turn` → `web-runs.asyncapi.yaml` (EventBase enum + message + oneOf), `supervisor-sse.asyncapi.yaml` (EventBase enum + message + `SessionChatTurnEvent` + oneOf), supervisor `types.ts` `SessionEvent` union, SSE bridge typing, scratch `MinimalSupervisorEvent` union (`events.ts:57-81`), run-detail/`useRunStream` consumer.
- `session_policy` enum (`resume|new_session`) + `dirty_resolution` enum (`commit|discard|proceed`) + diff `scope` enum → validated by allow-list at each boundary (`config.schema.ts`, route parse, ledger snapshot).

**X-DEPLOY candidates (B20 audit):** `MAISTER_GATE_CHAT_ENABLED` (candidate toggle), `MAISTER_RUNTIME_ROOT` containment precondition (DD10 — assert + doc), checkpoint ref namespaces `refs/maister/checkpoints/*` + `refs/maister/chat-checkpoints/*` (code constants, not env).

#### A8 — Phase-A consistency gate (exit criteria)
**Deliverable:** Verify COMPLETE + INTERNALLY CONSISTENT: every transition + refusal/precondition row enumerated as coded (allow-lists written as allow-lists); ERD in BOTH `database-schema.md` AND `db/*.md` mermaid for all new columns/table; OpenAPI + both AsyncAPI updated for all routes/events; Implemented/Designed tags correct (Designed until Phase B flips them); DD1–DD12 ↔ ADR mapping complete. **Phase A does not exit until this passes.**

---

### Phase B — TDD implementation (red→green→refactor; orchestrator coordinates QA→implementer→reviewer per task)

#### B0 — Re-verify numbering + engine bump
Re-check next-free ADR (expect 075) + migration (expect 0040) vs then-current main; renumber if drift — KNOWN sibling: unmerged `feature/outbound-webhooks` also claims ADR-075 + migration 0040, so drift is EXPECTED if it merges first. Any renumber = scoped, file-by-file replace + `pnpm validate:docs:adr`, never a blind global sed (patch 2026-06-10-23.57: over-reach/under-reach/corruption). Bump `MAISTER_ENGINE_VERSION` `1.3.0→1.4.0`. **Verify:** `grep -oE "ADR-[0-9]{3}" docs/decisions.md|sort -u|tail -1`; `tail _journal.json`; `vitest run --project unit …engine-version*`. **Logging:** `INFO [engine] floor 1.3.0->1.4.0`. **Depends:** A8.

#### B1 — Schema + migration 0040 (single writer; ALL deltas)
Edit `web/lib/db/schema.ts` once, generate ONE migration `0040`:
- `node_attempts` (+): `checkpoint_ref text`, `session_policy text` enum `resume|new_session`, `session_fallback boolean default false`, `auto_retry boolean default false`.
- `hitl_requests` (+): `review_tip_sha text` (per review-visit branch tip), `dirty_resolution text` enum `commit|discard|proceed` (nullable).
- new table `gate_chat_messages`: `id` PK, `run_id`→runs cascade, `hitl_request_id`→hitl_requests cascade, `node_id`, `gate_attempt int`, `role` enum `user|agent`, `author_user_id`→users set null, `author_label`, `body`, `acp_session_id`, `seq int`, `mutation_reverted boolean default false`, `created_at`; indexes `(run_id)`,`(hitl_request_id)`.
QA writes the migration-shape integration test first (testcontainers).
**PREFLIGHT (stale baseline — verified 2026-06-11):** `meta/0039_snapshot.json` lacks `run_schedules` (`schema.ts:1114`, `0038_run_schedules.sql`) — repair the snapshot baseline FIRST (regenerate the latest snapshot to match current `schema.ts` minus the 0040 deltas; repair recipe in memory `drizzle-snapshot-custom-gotcha`), else `drizzle-kit generate` re-emits `run_schedules` DDL into 0040 and `db:migrate` breaks on "already exists". After generate: assert `0040_*.sql` contains ONLY the new deltas; `migration-journal-integrity.test.ts` stays green; snapshot-chain gaps elsewhere (25 snapshots / 40 migrations) are pre-existing and out of scope.
**Files:** `schema.ts`, `migrations/0040_*.sql` (drizzle-kit; do NOT hand-edit `_journal.json when`). **Verify:** `vitest run --project integration …migration-0040…`; `drizzle-kit check`. **Depends:** B0.

---
**Feature 4a — workspacePolicy execution (FOUNDATION; shared dep of 4b, F1, F2)**

#### B2 — QA: checkpoint capture + rewind + fresh-attempt (FAILING)
Git-level integration (real temp repos modeled on the local `createGitWorkbench()` helper in `workbench-lifecycle/__tests__/real-git.integration.test.ts:76` — it is file-local, not importable): capture writes a namespaced ref (tracked+untracked captured, ignored EXCLUDED, branch NOT advanced); DD6 invariants: post-rewind branch tip == pre-attempt tip (`<ck>^`), the checkpoint commit is NOT reachable from the run branch, captured-untracked files are STILL untracked after rewind, attempt-created untracked files survive rewind; `fresh-attempt` = reset to `<ck>^` + `git clean -fd` (removes untracked source, **KEEPS ignored** — seed an ignored file e.g. `node_modules/x`, assert it survives) + re-materialization hook invoked (seed a fake bundle artifact, assert restored — DD6-note-2); `keep` no-op; **rewind never touches `.maister/<slug>/runs/<runId>/`** (DD10 — seed artifact, rewind, assert survival); `checkpoint_ref` on the attempt row. **Files:** `web/lib/flows/graph/__tests__/workspace-policy.integration.test.ts`. **Verify (red).** **Depends:** B1.

#### B3 — Impl: workspacePolicy engine + wire into rework path
New `web/lib/flows/graph/workspace-checkpoint.ts`: `captureCheckpoint(worktreePath, ns, id)` (temp-index commit **parented on the current tip** → namespaced ref; rewind target = `<ck>^`, DD6), `applyWorkspacePolicy(policy, worktreePath, ref)` (DD6 mechanics — never `reset --hard <ck>`), `containmentAssert(worktreePath)` (DD10 hard guard), `deleteChatCheckpoint(worktreePath, runId, hitlRequestId)` (DD11/DD12 baseline invalidation — consumed by B8/B17). Extract the launch materialization block (`runs.ts:734-740`: `copyBundleArtifactsToWorktree` + `writeAiFactoryConfigOverride` + `ensureWorktreeGitignore`) into a reusable helper; `applyWorkspacePolicy` re-runs it after `fresh-attempt` (DD6-note-2). Capture before each `ai_coding`/`cli` attempt; record `checkpoint_ref` (`ledger.ts`). Replace the warn-only TODO `runner-graph.ts:1947-1952` with a real apply, git-before-tx (X-ATOMIC). Typed `MaisterError("CHECKPOINT")` on git failure. **Verify (green):** B2 passes; `eslint` scoped. **Logging:** `DEBUG [checkpoint] capture …`; `INFO [checkpoint] apply policy=…`; `ERROR [checkpoint] git failed …`. **Depends:** B2.

#### B4 — Reconcile + GC tolerance
Reconcile tolerates orphaned `refs/maister/checkpoints/*` + `refs/maister/chat-checkpoints/*`; worktree GC (`system_sweep`) deletes them; chat-checkpoint refs are ALSO GC'd when their HITL resolves / the run leaves the pause, and deleted in-pause by every dirty-resolution (B8 → B3 `deleteChatCheckpoint`; bounded at 1 per hitlRequest, DD11 L3). Crash-window: capture-before-attempt → orphan ref on crash → harmless, GC'd. QA-first. **Verify:** `vitest run --project integration <reconcile+gc globs>`. **Logging:** `INFO [checkpoint] GC removed N refs run=…`. **Depends:** B3.

#### B5 — Reviewer pass Feature 4a
Review vs A2 + CLAUDE.md §1/§7 + DD5/DD6/DD10; assert promoted branch history clean (no checkpoint commits reachable from the run branch in a test promotion). **Depends:** B4.

---
**Feature 4b — review-diff completeness (← B3 for the `last-node` base)**

#### B6 — QA: dirty protocol + 4-mode scope switcher (FAILING)
Integration: `GET /diff?scope=run|since-last-review|last-node|uncommitted` returns the correct base→head (table DD12); missing-base scopes degrade (hidden/disabled, not error); `uncommitted` shows tracked working-tree changes + untracked as additions, index never mutated; review-gate open records `review_tip_sha` + emits `dirtySummary` when dirty; the three dirty-resolution choices: commit (snapshot, tip moves, scopes recompute), discard (tracked restored + untracked removed, **`.maister/` untouched** — seed+assert), proceed (committed state + dirty badge); every choice recorded on the HITL row + audit; **gate not blocked** by dirty. e2e (playwright): scope toggle + dirty banner choices. **Files:** `web/app/api/runs/__tests__/diff-scope.integration.test.ts`, `web/lib/flows/graph/__tests__/dirty-protocol.integration.test.ts`, `web/e2e/review-diff-scopes.spec.ts`. **Verify (red).** **(X-2PC, X-ATOMIC, DD10)** **Depends:** B1; the `last-node` assertions depend on B3.

#### B7 — Impl: diff scope switcher
Add `scope` query param to `web/app/api/runs/[runId]/diff/route.ts` (parse `req`, validate enum allow-list); branch base selection (170-181): `run`=current; `since-last-review`=prior visit's `review_tip_sha`; `last-node`=latest node `checkpoint_ref` SHA (Feature-4); `uncommitted`=new `diffWorkingTree(worktreePath)` helper in `worktree.ts` (model on `diffRange`: copy the real index to a temp file, then under `GIT_INDEX_FILE=<tmp>` run `git add -N` intent-to-add for untracked → `git diff HEAD`, `{text,truncated}`, `-C <worktree>`, `--end-of-options`, byte-cap; the REAL index is never written — a bare `git add -N` mutates it and would break B6's "index never mutated" assertion). All feed `prepareDiff`. Record `review_tip_sha` via `headCommit` at the review-gate insert `runner-graph.ts:286`. Graceful-degrade availability map. **Verify (green):** B6 scope tests; `eslint` scoped. **Logging:** `DEBUG [diff-scope] run=… scope=… base=…`. **Depends:** B6, B3.

#### B8 — Impl: dirty-state protocol (payload + resolution route + discard primitive)
`buildReviewPanelData` (`layout.tsx:91`) computes `dirtySummary` via `statusPorcelain`; add to `RunPendingHitl` + thread into `ReviewPanel`. New `POST /api/runs/{runId}/hitl/{hitlRequestId}/dirty-resolution` (X-IDENT: ids url-param, body `{choice}` only; X-2PC: git side-effect AFTER intent row, failure table; X-ATOMIC: record `dirty_resolution` + audit in one tx). Reuse `snapshotDirtyWorktree` (auto-msg `"wip after node <id>"`) for commit; NEW `discardWorktree(worktreePath)` in `worktree.ts` (`git restore --staged --worktree .` + `git clean -fd`, `-C <worktree>`, **hard `.maister/`-containment assert**, then RE-RUN the B3 materialization helper — DD6-note-2) for discard; every executed choice calls `deleteChatCheckpoint` (B3) so the L3 chat baseline re-anchors (DD11/DD12 — no false un-discard); proceed = persist badge. UI: dirty banner + 3 actions + dirty badge in `review-panel.tsx`, EN+RU i18n. Gate never blocked. **Verify (green):** B6 dirty + e2e; `eslint` scoped. **Logging:** `INFO [dirty] run=… choice=… files=…`; `ERROR [dirty] discard refused — path escapes worktree`. **Depends:** B7.

#### B9 — Reviewer pass Feature 4b
Review vs A3 + DD12 + ADR-066/079; verify the discard `.maister/` guarantee + the gate-not-blocked invariant; truncation guard shared across scopes. **Depends:** B8.

---
**Feature 2 — retry_policy (← B3)**

#### B10 — QA: retry_policy (FAILING)
(unit) manifest validation accepts on-list codes, rejects `PRECONDITION/CONFIG`/unknown → `CONFIG`; `attempts≥1`. (integration) on-list failure auto-schedules N attempts then normal failure; each retry = new row `auto_retry=true`, fresh session, `workspace` applied via Feature-4 first, cap-respected, gates not bypassed; exhaustion signal. **Files:** `…/__tests__/retry-policy.test.ts` (unit), `…/graph/__tests__/retry-policy.integration.test.ts` (integration). **Verify (red).** **Depends:** B1, B3.

#### B11 — Impl: retry_policy
`retryPolicySchema` (`config.schema.ts`, only `ai_coding`/`cli`); manifest-load allow-list validation → `CONFIG`. In `runner-graph.ts` `markNodeFailed` site: on `code ∈ on_errors` and attempts left → apply `workspace` (B3 engine), append fresh-session attempt (`auto_retry=true`) under X-ATOMIC + cap accounting; exhaustion → normal failure + signal. **Verify (green):** B10; `eslint`. **Logging:** `INFO [retry] node=… code=… attempt=n/N`; `WARN [retry] exhausted node=…`. **Depends:** B10, B3.

#### B12 — Reviewer pass Feature 2
Vs A4 + DD7 + CLAUDE.md §1/§4; allow-list (not deny-list). **Depends:** B11.

---
**Feature 3 — session_policy (fully independent)**

#### B13 — QA: session_policy (FAILING)
(unit) 3-level resolution + default `resume`. (integration, mock ACP adapter per `supervisor/src/__tests__/m8-resume-spike.integration.test.ts`) `resume` resumes prior `acp_session_id`; `new_session` fresh; gone→fallback `new_session` + `session_fallback=true`; effective snapshot; interplay (idle prior resumes, takeover-return unaffected, slash-in-existing unchanged). **Files:** `…/__tests__/session-policy.test.ts`, `…/graph/__tests__/session-policy.integration.test.ts`. **Verify (red).** **Depends:** B1.

#### B14 — Impl: session_policy
`session_policy` on node schema, `rework.session_policy`, flow `defaults` block (`config.schema.ts`); resolver (DD8). Thread the resolved policy into dispatch at `runner-graph.ts:518-524` — on rework with `resume`, pass `resumeSessionId=priorAttempt.acpSessionId` into `runAgentStep`/`createSession` (today hard `new-session`); resume failure → new-session + `session_fallback`. Snapshot on the new attempt (`ledger.ts`). **Add the DD11 interplay: the rework prompt lifts the chat read-only restriction** (preamble on resume). **Verify (green):** B13; `eslint`. **Logging:** `INFO [session-policy] node=… resolved=… source=…`; `WARN [session-policy] unresumable → new_session`. **Depends:** B13.

#### B15 — Reviewer pass Feature 3
Vs A5 + DD8 + ADR-006/027/030; default-flip rationale documented; the L1-lift interplay present. **Depends:** B14.

---
**Feature 1 — gate-chat + workspace-neutrality (← B3 for L3)**

#### B16 — QA: gate-chat + neutrality (FAILING)
(unit) availability predicate (DD2: status∈{NeedsInput,Idle} ∧ kind∈{human,form} ∧ session≠null; permission + HumanWorking excluded; empty-state). (integration, mock ACP adapter) live turn streams a reply, persists `gate_chat_messages` (user→agent), bumps keepalive, HITL stays open, status `NeedsInput`; idle chat-resume respawns + `session/resume` + `markResumed`, NO resume-driver, never resolves HITL, never →Running (allow-list); X-2PC failure table; X-DEFER release on simulated failure; rework-compose folds chat history; a dirty-resolution executed BETWEEN chat turns deletes the baseline ref and the next turn re-anchors (Discard then chat → NO false revert — this case additionally depends on B8). **Neutrality:** L2 auto-denies a mutating-kind permission WITHOUT creating a `hitl_requests` row (mock adapter raises a mutating `requestPermission`); L3 captures ONE baseline at the first turn and reuses it — a clean turn leaves it intact; a simulated agent mutation on a LATER turn reverts to the first-turn baseline + sets `mutation_reverted=true` + emits audit (incl. the permissive-runner path where L2 is a no-op); the baseline ref is GC'd on HITL resolve. (e2e) question box renders the streamed answer; idle cost warning; mutation-revert notice. **Files:** `web/lib/services/__tests__/gate-chat.test.ts`, `…/gate-chat.integration.test.ts`, `supervisor/src/__tests__/readonly-turn.integration.test.ts` (L2), `web/e2e/gate-chat.spec.ts`. Preflight e2e: kill 3100/7788, baseline-prove reds. **Verify (red).** **(X-IDENT, X-2PC, X-DEFER, X-FANOUT, X-NEUTRAL, DD2, DD3, DD11)** **Depends:** B1; L3 + neutrality assertions depend on B3; the dirty-resolution-interplay case depends on B8.

#### B17 — Impl: gate-chat backend + neutrality (L1/L2/L3)
`POST/GET /api/runs/{runId}/hitl/{hitlRequestId}/chat` — X-IDENT (`{message}` body only; session/slug/step server-state-derived); availability guard (DD2 allow-list). X-2PC: persist user row → start prompt+projection (reuse `supervisor-client.ts:480` `sendPrompt` + a gate-chat projector modeled on `scratch-runs/events.ts`, table-bound to `gate_chat_messages`) → persist agent row + `seq` AFTER; failure table; row-lock idempotency. Idle = chat-resume (DD3). New `session.chat_turn` event → `supervisor/src/types.ts` union + both AsyncAPI + scratch union + bridge typing (X-FANOUT). **Neutrality:** L1 prepend read-only preamble to the chat prompt; L2 add `readOnlyTurn` to `SendPromptRequestSchema` + session record + auto-deny mutating `toolCall.kind` in `requestPermission` (`acp-client.ts:106`) before emit/register (no hitl row); L3 capture ONE first-turn baseline (B3 machinery, `refs/maister/chat-checkpoints/<runId>/<hitlRequestId>`, bounded at 1) → verify each turn via `statusPorcelain`/diff vs the baseline → on delta revert to baseline + `mutation_reverted=true` + audit + chat-turn notice, unconditional + fail-closed; GC the ref on HITL resolve. Chat input never Mustache-evaluated. **Verify (green):** B16 unit+integration + the supervisor L2 test; `pnpm --filter @maister/supervisor test`. **Logging:** `DEBUG [gate-chat] send run=… live=…`; `INFO [gate-chat] idle resume (~$0.28)`; `WARN [neutrality] reverted mutation turn=… files=…`; `ERROR [gate-chat] prompt failed — released deferred`. **Depends:** B16, B3.

#### B18 — Impl: gate-chat UI
Question box + streamed-answer view in `layout.tsx:618-712` pendingHitl (new client component modeled on `scratch-transcript.tsx`; first streaming consumer of `useRunStream` payloads here). Disabled empty-state (DD2). Idle ~$0.28 cost warning before the first idle question (first resume-cost UI affordance). Mutation-revert notice on the turn (DD11 L3). EN+RU under `run`/`hitl` namespace; HeroUI v3. **Verify (green):** B16 e2e (preflight 3100/7788); locale key-parity. **Logging:** client `DEBUG [gate-chat] stream connected`. **Depends:** B17.

#### B19 — Reviewer pass Feature 1
Vs A6 + DD1–DD4 + DD11 + CLAUDE.md §1/§3 + X-IDENT/X-2PC/X-DEFER/X-FANOUT/X-NEUTRAL; confirm never flips status / never resolves HITL, no body-controlled ids, no secret leakage, no template eval, L3 unconditional + fail-closed, L2 no-op caveat documented. **Depends:** B18.

---

#### B20 — Deployment wiring audit (X-DEPLOY)
Grep the diff for new env vars/ports/sidecars. If `MAISTER_GATE_CHAT_*`, a checkpoint ref namespace, or the `MAISTER_RUNTIME_ROOT` containment precondition is introduced → `.env.example` + compose + `docs/configuration.md` env-table + `docs/getting-started.md`. Assert (test+doc) `MAISTER_RUNTIME_ROOT` resolves outside every `repo_path` (DD10). Else record "no deployment surface" + grep evidence. **Depends:** B3, B8, B17.

#### B21 — Final verification gate
- `cd web && pnpm test:unit && pnpm test:integration` green (quarantine pre-existing red with a tracked reason).
- e2e: `lsof -ti:3100|xargs kill`; kill 7788; `NODE_ENV=test pnpm test:e2e e2e/gate-chat.spec.ts e2e/review-diff-scopes.spec.ts e2e/m11a-review-rework.spec.ts e2e/m11b-takeover.spec.ts review-comments.spec.ts`; baseline-prove reds at base first.
- supervisor: `pnpm --filter @maister/supervisor test`.
- lint check-only: `cd web && eslint .` (NEVER bare `pnpm --filter maister-web lint` — it `--fix`-reformats; memory).
- docs/code consistency: `grep -rnE "deferred to M11b|M11a executes|TODO\(M11b\)" docs/ web/`==0 (broadened — the live phrasing is "execution **is** deferred"); every A7 contract-surface row exists in code; Designed→Implemented flipped.
- numbering: ADR 075–079 unique; migration 0040 single, applied.
**Depends:** B5, B9, B12, B15, B19, B20.

---

## Unresolved questions (ответить до старта Phase B)

**ВСЕ вопросы закрыты — план готов к `/aif-implement`.**

Раунд 1 (2026-06-11): #branch → создана `feature/...`; #roadmap → `M30` (новая веха).
Раунд 2: #2 `execute` проходит L2, гарантия — L3 (DD11); #5 `fresh-attempt`+discard = `git clean -fd`, `-x` отклонён (DD6-note); #7 один baseline chat-checkpoint на hitlRequest, привязан к ПЕРВОМУ ходу, GC при resolve, history — через audit-строки (DD11 L3).
Раунд 3: #1 веха `M30` финализирована; #2(DD4) **отдельный** тип события `session.chat_turn`; #3(DD12) **отдельная колонка** `hitl_requests.review_tip_sha`; #4(DD8) idle prior session **всё равно resume** (без спец-кейса, ~$0.28 окупает контекст критики).
Раунд 4 (`/aif-improve` 2026-06-11, все правки верифицированы по коду): stale snapshot `0039` → B1 preflight; rewind = `<ck>^` + overlay (не `reset --hard <ck>`); re-materialization после `clean -fd` (B3/B8, DD6-note-2); dirty-resolution инвалидирует L3 baseline (B8↔B16/B17); `stepId` маркер dash вместо colon (SAFE_PATH_SEGMENT); `GIT_INDEX_FILE` temp-index для `uncommitted` scope (B7); расширен verify-grep (A2/B21); backfill ADR-073/074 в index + `validate:docs:adr` (A1); sibling-claim outbound-webhooks (B0); anchor `web/lib/queries/run.ts`.

---
*Confidence: 🟢 High on the verified file:line anchors, numbering (ADR-075…079 / migration 0040), the six designs, and the skill-context invariants. 🟡 Medium on two impl-time confirmations: fronting the blocking supervisor `/prompt` behind a 202 chat route (mirror scratch's concurrent projector), and the vendored ACP SDK's behavior on a literal concurrent second `conn.prompt()` (node_modules absent during recon — inspect `@agentclientprotocol/sdk` `ClientSideConnection.prompt` at B16/B17). The L2 auto-deny relies on ACP `toolCall.kind` fidelity per adapter — verify claude/codex emit accurate kinds at B17, and treat L3 as the guarantee regardless.*
