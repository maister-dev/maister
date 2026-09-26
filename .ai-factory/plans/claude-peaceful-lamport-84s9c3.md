# Implementation Plan: Personal librarian (complete first release)

**Branch**: `claude/peaceful-lamport-84s9c3` (session-assigned; `/aif-plan` branch creation skipped)
**Created**: 2026-09-26 · **Refined**: 2026-09-26 (`/aif-improve` — SDD + TDD pass against the code)
**Base**: local `master` @ `3c02c739`
**Source brief**: [`docs/pv/personal-librarian.md`](../../docs/pv/personal-librarian.md)
(saved verbatim during planning). `LIB-01..16` and `L-01..12` below are the brief's
ids. The brief supersedes the librarian parts of
[`docs/pv/team-visibility-and-po-intake.md`](../../docs/pv/team-visibility-and-po-intake.md)
(D1, D2, D5, D7, the librarian parts of F1/F2, the initiative dependency).

One plan, one branch, one release scope, eight phases. Specifications come first and
carry **enforced requirement IDs**; implementation is **test-first**. Increments are
dependency-ordered; none of them is a separate definition of "done" (brief §1).

## Settings

- **Testing**: yes. RED → GREEN → REFACTOR per task (see "TDD protocol"). Real
  Postgres for every invariant that lives in the DB; real supervisor + a scripted mock
  ACP adapter for the ACP/internal-MCP round trip; a small live-adapter qualification
  for the user journeys (brief §10).
- **Logging**: verbose (see "Logging contract").
- **Docs**: yes — mandatory. Phase 0 is spec-first and machine-validated; Phase 7
  reconciles as-built status.
- **i18n**: EN + RU in the task that adds the string. Never a follow-up.

## Roadmap Linkage

**Milestone**: "M51. See everything" (owner choice at planning, 2026-09-26).
**Rationale**: the librarian extends M51's Desk, attention counters and cross-project
readers, and the owner chose to track it under the open milestone rather than open M52.
**Conflict to resolve (T0.16)**: the M51 roadmap entry lists "PO intake" among its
explicit non-goals (`.ai-factory/ROADMAP.md:790`). `/aif-plan` does not edit the
roadmap; T0.16 amends the M51 entry through `/aif-roadmap` (scope line added, the
non-goal removed) with the owner's confirmation. Until then `/aif-verify --strict`
will see a linkage that contradicts the milestone text.

## Research Context

No `.ai-factory/RESEARCH.md`. Requirements source: the brief above. Planning-time
evidence came from six codebase sweeps (MCP identity and scopes; agent runtime and
execution host; tasks, triage, inbox and UI shell; then a verification pass over the
ext handler, the execution-host/scheduler seams, and the task/clarification/docs
seams). Every file:line cited below was true at `3c02c739`; each task re-verifies
before editing.

## Scope

| Brief | Deliverable | Requirements | Phase |
| --- | --- | --- | --- |
| LIB-02, LIB-05, LIB-07 | Delegated per-turn authority, live RBAC, librarian scope policy, audit, discovery/read MCP surface | `LAU-01..11` | 1 (LAU-01/09/11 in 2, LAU-08 in 3) |
| LIB-01, LIB-06, LIB-15 | One durable conversation, turn queue, `run_kind='librarian'` runtime, context composer, stop/restart, admin enablement, panel shell | `LCV-01..12`, `LUI-01..09` | 2 |
| LIB-03, LIB-04, LIB-08, LIB-09, LIB-10 | Operation ledger + idempotency, statements + revisions + provenance, create/update, triage + launch intent, launch, existing-work actions, confirmation cards | `LOP-01..10`, `TST-01..05`, `TST-07..08`, `LUI-10` | 3 |
| LIB-11 | Task clarification before any run | `CLR-01..10` | 4 |
| LIB-16 | Deduplicated follow-up updates + on-demand Explain | `LOP-11..12` | 5 |
| LIB-12, LIB-13, LIB-14 | Memory, summaries, retrieval fences, reset barrier, forget, clear history, retention | `LMM-01..12`, `TST-06` | 6 |
| §10 | L-01..L-12 E2E, live-adapter qualification, EN/RU operator docs | all | 7 |

**Out of this release** (brief §5): infrastructure administration, credential
management, package/Flow authoring, arbitrary code execution, a second Git UI, a chat
list or shared rooms, an initiative entity, periodic model-generated digests, admin
inspection of personal conversations, embedding-based history search.

---

## Requirement IDs and traceability (the SDD contract)

Reuse the mechanism M51 generalized: `scripts/validate-docs-indexes.mjs`
`validateAnalyticsGroup({label, documents, prefixes, traceabilityFile})` enforces the
seven R5 sections, ≤ 12 Expectations bullets, an id on every Expectation
(`- **LCV-01:** …`) and Edge case (`**EDGE-LCV-01:** …`), global uniqueness, and a
traceability row with a primary test per id. T0.14 registers a new `LIBRARIAN_GROUP`.

| Document (`docs/system-analytics/`) | Prefix | Domain |
| --- | --- | --- |
| `librarian-conversation.md` | `LCV` | conversation, messages, turns, runtime, queue, budgets, stream |
| `librarian-authority.md` | `LAU` | delegated token, live RBAC, scope policy, visibility, audit, MCP-only session |
| `librarian-operations.md` | `LOP` | operation ledger, idempotency, batches, launch intent, confirmations, follow-up delivery |
| `task-statements.md` | `TST` | statement schema, task revision, provenance links, excerpts |
| `task-clarifications.md` | `CLR` | pre-execution clarification lifecycle |
| `librarian-memory.md` | `LMM` | memory, summaries, retrieval, reset barrier, forget, clear history, retention |
| `librarian-surface.md` | `LUI` | top-nav entry, panel, focus, layout, i18n |

**Traceability matrix**: `docs/system-analytics/librarian-traceability.md`, the exact
five-column shape the validator parses:
`| Requirement | Contract/schema | Enforcement/task | Primary test | Status |`.
It carries a second table mapping `LIB-01..16` and `L-01..12` to requirement ids, so the
brief is traceable end to end. Test ids: `UT-` unit · `IT-` integration · `CT-` contract ·
`E2E-` Playwright · `QL-` live-adapter qualification, suffixed with the requirement id.

**Bidirectional coverage gate (T0.14)**: generalize `scripts/validate-m51-coverage.mjs`
into `scripts/validate-requirement-coverage.mjs --group <name>` (DRY; M51 behaviour
pinned by a regression case). The task-id regex stays as it is
(`/\*\*(T\d+\.\d+)\s*\[[ x]\]\s*—/g`, `:139`) — **this plan's task lines use that format**
— and the group parameterizes the plan path, the documents, the prefixes and the
implementation-phase filter (`/^T[1-6]\./` here: Phase 0 writes the specs, Phase 7
qualifies them, so neither owns a requirement row). Every requirement names ≥ 1 task;
every Phase 1–6 task is named by ≥ 1 requirement.

### The requirements

**`LCV` — conversation and runtime** (12, at cap)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LCV-01 | Exactly one `librarian_conversations` row per user; no route or tool creates a second | UNIQUE `librarian_conversations_user_uq` + `IT-LCV-01` |
| LCV-02 | An owner message is committed before any turn admission; a repeated `(conversation_id, client_message_id)` returns the stored message | partial UNIQUE `librarian_messages_client_id_uq` + `IT-LCV-02` |
| LCV-03 | At most one turn per conversation is `admitted` or `running`; later messages queue in `seq` order and can be withdrawn only while `queued` | partial UNIQUE `librarian_turns_one_active_uq` + conversation row lock + `IT-LCV-03` |
| LCV-04 | A turn runs on the conversation's single `runs` row: `run_kind='librarian'`, `project_id IS NULL`, `task_id IS NULL`, `persistent=true`, `flow_version='librarian'`, `created_by_user_id`=owner, adopted as a `directory` workspace under `<runtimeRoot>/.maister/_librarian/<conversationId>/`; every prompt carries owner kind `librarian_turn` | CHECK `runs_librarian_shape_check` + `execution_commands_prompt_owner_required` + `IT-LCV-04` |
| LCV-05 | A conversation holds a slot only while its run is `Running`; between turns it is parked `NeedsInputIdle` and never TTL-abandoned; a full `MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS` pool queues, never refuses | `tryStartRun` pool arm + `persistent=true` Pass2 exemption + `IT-LCV-05` |
| LCV-06 | ACP `session/resume` is used only when `run_sessions.librarian_context_epoch` equals the conversation's current `context_epoch` and the runner snapshot is unchanged; otherwise a fresh session starts from a composed context | composer guard + `IT-LCV-06` |
| LCV-07 | A context snapshot (message ids, summary and memory revisions, instructions version, authz fingerprint) commits before the turn's prompt command is queued | CHECK `librarian_turns_running_has_snapshot_check` + `IT-LCV-07` |
| LCV-08 | Stop cancels the turn's prompt through `BoundClient` and revokes its token; it never cancels a task run and never deletes an operation row | `IT-LCV-08` |
| LCV-09 | After a restart or adapter loss, a `running` turn with no live session resolves to `failed{host_lost}` through the reconcile `librarian` arm and the run is parked; queued messages stay queued and admit afterwards | reconcile arm + `IT-LCV-09` |
| LCV-10 | Turn deadline, context character cap and per-user daily turn cap are finite; exhaustion refuses with `BUDGET_EXCEEDED` in a visible state, and the owner's latest message is never truncated away | `IT-LCV-10` |
| LCV-11 | With the librarian disabled or no ready runner, admission refuses (`CONFIG` / `EXECUTOR_UNAVAILABLE`); admitted operations still reconcile; nothing is deleted | `IT-LCV-11` |
| LCV-12 | `GET /api/librarian/stream` emits only the owner's conversation and replays from durable `seq` via `lastEventId`; live tokens of the running turn ride the existing run stream, whose project-less authz is `created_by_user_id = viewer` | `IT-LCV-12` |

Edge: `EDGE-LCV-01` two tabs submit one `client_message_id` concurrently · `EDGE-LCV-02`
message arrives while a turn runs · `EDGE-LCV-03` the configured runner is disabled
between turns · `EDGE-LCV-04` deadline expires during a tool call · `EDGE-LCV-05` a
run parked 25 h is still `NeedsInputIdle` after the keep-alive sweep.

**`LAU` — authority** (11)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LAU-01 | The owner comes only from the authenticated session (`auth-context`); no librarian route or tool accepts a user id | route identifier table (D16) + `IT-LAU-01` |
| LAU-02 | Each turn gets a fresh `project_tokens` row `token_kind='librarian'`, `owner_user_id`=owner, `project_id` NULL, `agent_id` NULL, `librarian_turn_id` set, `expires_at` = turn deadline, revoked in the turn-end transaction | CHECK `project_tokens_librarian_check` + `IT-LAU-02` |
| LAU-03 | Every librarian-token request re-checks, at request time: owner active, no pending password change, live project role for the scope's action, scope ∈ the token's scopes, turn `running` | `handleExt` librarian arm + `IT-LAU-03` |
| LAU-04 | A librarian token is refused on `hitl_respond` (any kind), `run_promote`, `run_discard`, `run_delegate`, `run_collect`, `agent_memory_write`, token/settings/admin routes; an agent token is refused on every `/ext/librarian/*` route | `IT-LAU-04` |
| LAU-05 | A follow-up (Explain) turn receives `LIBRARIAN_READ_SCOPES`, whose token is refused on every effectful route | `IT-LAU-05` |
| LAU-06 | Every list, search and count admitted for librarian tokens filters by the owner's visible projects before aggregation; a foreign project answers exactly like a missing one | `IT-LAU-06` |
| LAU-07 | Every librarian-token request writes `token_audit_log` with `on_behalf_of_user_id`, `librarian_turn_id` and, for effects, `operation_id`; an audit failure fails the request | `IT-LAU-07` |
| LAU-08 | Effects made through the librarian record the owner as social actor plus `via_operation_id`; human-only answers and promotions execute only from an owner click in the session UI | `IT-LAU-08` |
| LAU-09 | No role, including global admin, can read another user's conversation, memory or snapshots through any route | `IT-LAU-09` |
| LAU-10 | Deactivation or loss of membership applies to the next request of an in-flight turn and to every queued turn at admission | `IT-LAU-10` |
| LAU-11 | A librarian session carries the enforcement profile `{tools:{allow:<librarian tool names>}, mcps:{allowServers:["maister"]}, enforcedClasses:["tools","mcps"]}`, execution policy `permissions=auto_approve`, no `readOnlySession`, L2 adapter deny settings, and attaches only the `maister` server; a built-in call is denied at the seam, a threshold halt fails the turn `capability_trip`, and no `hitl_requests` row is ever created for a librarian run | `IT-LAU-11` (supervisor) + `IT-LCV-04` part |

Edge: `EDGE-LAU-01` token replay after revocation · `EDGE-LAU-02` global admin opens the
panel (sees only their own conversation) · `EDGE-LAU-03` project archived mid-turn ·
`EDGE-LAU-04` a summary turn (no server attached) that emits any tool call fails.

**`LOP` — operations and follow-up** (12, at cap)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LOP-01 | Every effectful librarian request carries an `Idempotency-Key`; the operation row commits before the effect, and the finalize rides `recordRequiredTokenAudit` inside the route's transaction, so a DB-only effect and its operation result commit together | `IT-LOP-01` |
| LOP-02 | Same key + same canonical digest returns the stored result; same key + different digest → `CONFLICT{reason:"idempotency_payload_mismatch"}`; a new key whose digest matches a succeeded operation in the same segment → `CONFLICT{reason:"duplicate_of_operation"}` unless `allowDuplicate` | UNIQUE `librarian_operations_key_uq` + `IT-LOP-02` |
| LOP-03 | An operation with an unknown outcome is settled by lookup on its result column (`via_operation_id` / `librarian_operation_id`), never re-issued; a turn is not admitted while the conversation has an `admitted` operation older than `MAISTER_LIBRARIAN_OPERATION_RECONCILE_SECONDS` | UNIQUE result columns + `IT-LOP-03` |
| LOP-04 | Each batch item is its own operation; the receipt lists per-item status; a retry re-submits only non-terminal items | `IT-LOP-04` |
| LOP-05 | A task created through the librarian gets `launch_intent='none'`; under `none` a triage verdict never arms `launch_mode='auto'` and C2 never admits the task | `IT-LOP-05` |
| LOP-06 | Send-to-triage records `launch_intent ∈ {triage_only, triage_then_launch}`; `applyTriageVerdict` arms auto-launch only under `triage_then_launch` | `IT-LOP-06` (+ interaction table) |
| LOP-07 | A librarian launch returns the actual run id and `Pending` or `Running`; admission uses `launchRun` preconditions unchanged; `runs.librarian_operation_id` is written in the run's insert transaction | `IT-LOP-07` |
| LOP-08 | A confirmation card binds kind, target ids, target revision (task revision, run head SHA, HITL id) and payload digest; deciding a stale or expired card → `CONFLICT{reason:"target_changed"}` | `IT-LOP-08` |
| LOP-09 | Human-only actions (human HITL answers, promotion, discard) run only from the owner's confirmation click through a session route as `HitlActor{kind:"user"}` | `IT-LOP-09` |
| LOP-10 | An operator message to an existing run returns exactly one of `delivered`, `queued`, `refused_requires_rework`, and never uses `runs:delegate` | `IT-LOP-10` |
| LOP-11 | A follow-up update is unique per `(conversation_id, domain_event_id)`, is inserted only while the owner can read the task, and renders as a deterministic card without a model turn | `IT-LOP-11` |
| LOP-12 | A failed update delivery retries at most 5 times, then records `failed` with evidence; delivery never repeats the business effect | `IT-LOP-12` |

Edge: `EDGE-LOP-01` response lost after task create · `EDGE-LOP-02` batch where item 2
fails · `EDGE-LOP-03` launch refused by cap or dependency · `EDGE-LOP-04` triager says
enqueue under `launch_intent='none'`.

**`TST` — statements and provenance** (8)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| TST-01 | A statement revision holds `context, goal, acceptance[], constraints[], outOfScope[], links[], openQuestions[]`; accepted revisions are immutable | zod schema + trigger `task_statement_revisions_immutable` + `IT-TST-01` |
| TST-02 | `tasks.revision` increments on every content write (UI PATCH, ext PATCH, statement accept) under `SELECT … FOR UPDATE`; a stale `expectedRevision` → `CONFLICT{reason:"stale_revision"}` | `IT-TST-02` |
| TST-03 | Accepting a statement renders it deterministically into `tasks.prompt`, so an executor never needs the conversation | `UT-TST-03` |
| TST-04 | Conversation↔task links are many-to-many with meaning `created_from | refined_in | mentioned`, message range and statement revision | `IT-TST-04` |
| TST-05 | Publishing an excerpt is an explicit operation that copies text into a task comment under task visibility; no link grants access to the transcript | `IT-TST-05` |
| TST-06 | Reset or history deletion never deletes tasks, statements or published excerpts; a link to a deleted message renders an explicit unavailable state | `IT-TST-06` |
| TST-07 | Statement accept obeys the existing `BACKLOG_GATED_FIELDS` gate: refused `PRECONDITION` unless `tasks.status='Backlog'`; the receipt names the operator-message seam and the rework claim, because a flow run re-reads `tasks.prompt` at every re-entry | `IT-TST-07` |
| TST-08 | Task chips and operation receipts render key and live status from one batched, visibility-filtered read | `IT-TST-08` |

Edge: `EDGE-TST-01` accept on an `InFlight` task · `EDGE-TST-02` link whose source
message was deleted.

**`CLR` — clarification before execution** (10)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| CLR-01 | A user-origin clarification carries requester, recipient, question, reason, answer format, blocking flag and source message; `origin_kind='user'` rows have NULL `origin_run_id`, `origin_agent_id`, `source_hitl_request_id` and `retrigger_mode='none'` | CHECK `task_clarifications_origin_shape_check` + `IT-CLR-01` |
| CLR-02 | The recipient must hold the `answerHitl` action's minimum project role (`member`) at creation and at answer time | `IT-CLR-02` |
| CLR-03 | Creation writes an `inbox_items` row (`event_kind='clarification_requested'`) for the recipient and a `clarification` item in the recipient's `decisions` queue, kept in the same array as the four existing populations so count equals list length | ADR-169 amendment + `IT-CLR-03` |
| CLR-04 | Lifecycle `open → answered | cancelled | superseded`; an answered row's answer is never overwritten; a correction creates a superseding row | CHECK `task_clarifications_status_shape_check` + `IT-CLR-04` |
| CLR-05 | An open blocking clarification yields launchability `clarification_pending` and the work-stage attribute `clarificationPending`; launch, C2 and `decideFire` refuse it explicitly; no task status is added | `IT-CLR-05` |
| CLR-06 | The answer shows on task detail and reaches the requester's conversation only while the requester can read the task | `IT-CLR-06` |
| CLR-07 | Answering never changes the statement or launches work; it may produce a proposed revision card | `IT-CLR-07` |
| CLR-08 | Recipient deactivation, task abandonment and owner cancellation each produce `cancelled` with a reason and a delivered update | `IT-CLR-08` |
| CLR-09 | Only the human recipient answers — session auth, or a global personal token holding exact `hitl:respond:human`; never a librarian or agent token | `IT-CLR-09` |
| CLR-10 | `composeEffectivePrompt` folds answered user-origin clarifications exactly like agent-origin ones | `IT-CLR-10` |

Edge: `EDGE-CLR-01` recipient loses membership while the request is open ·
`EDGE-CLR-02` two answers race (one wins, the other → `CONFLICT`).

**`LMM` — memory, history, reset** (12, at cap)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LMM-01 | Memory items are written only on an explicit "remember" in an owner-message turn or on acceptance of a visible suggestion card; inferred items stay suggestions | `IT-LMM-01` |
| LMM-02 | An item carries kind, scope, source refs, origin, validity and revision; an edit writes a new revision | `IT-LMM-02` |
| LMM-03 | Every use re-checks visibility of each item's and summary's source projects; a mixed summary with an invisible source is dropped and queued for rebuild | `IT-LMM-03` |
| LMM-04 | Automatic context includes only the active segment's messages and summaries; older segments are reachable only through the explicit history-search tool, labelled in the reply | `IT-LMM-04` |
| LMM-05 | Reset is a barrier: acknowledged only after old-segment operations are terminal and queued messages withdrawn; it bumps `context_epoch` and clears pending cards | `IT-LMM-05` |
| LMM-06 | Forget sets `forgotten_at` and writes a tombstone digest; summary and suggestion writers refuse tombstoned content; the epoch bumps | `IT-LMM-06` |
| LMM-07 | Summary and memory writes are fenced on `(segment ordinal, forget_generation, history_generation)`; a writer that lost the fence writes nothing | CAS + `IT-LMM-07` |
| LMM-08 | Clear history deletes messages, summaries, snapshots and search rows, keeps operations and audit with message refs nulled, and releases the conversation's host workspace | `IT-LMM-08` |
| LMM-09 | Rendering masks librarian messages whose source projects are no longer visible; the owner's own messages always render | `IT-LMM-09` |
| LMM-10 | A `system_sweep` pass purges messages older than `MAISTER_LIBRARIAN_HISTORY_RETENTION_DAYS` (default 365) and snapshots older than `MAISTER_LIBRARIAN_SNAPSHOT_RETENTION_DAYS` (default 30) | `IT-LMM-10` |
| LMM-11 | Personal memory never writes to Project Brain or to an agent's `memory.md` | ESLint fence + `IT-LMM-11` |
| LMM-12 | Each reply shows which memory items its snapshot used | `IT-LMM-12` |

Edge: `EDGE-LMM-01` reset while a summary turn is running · `EDGE-LMM-02` forget during
a running owner turn (the reply may still cite the item; the next snapshot cannot).

**`LUI` — surface** (10)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LUI-01 | The top-nav entry renders on every `(app)` route with an accessible name and an indicator of `running | unread | action_required`, never a numeric global count | `UT-LUI-01` + `E2E-LUI-01` |
| LUI-02 | The panel is mounted in `(app)/layout.tsx`; navigation and collapse preserve conversation, draft and scroll; reload restores messages and pending operations | `E2E-LUI-02` |
| LUI-03 | ≥ `xl` docked non-modal; `md`–`xl` modal sheet; < `md` full screen; at 390 px no horizontal overflow and Send stays visible | `E2E-LUI-03` |
| LUI-04 | A message stores its subject at send time; a route change never retargets a queued message or a pending card | `IT-LUI-04` |
| LUI-05 | Opening focuses the composer; closing restores focus to the invoker; modal modes trap focus | `E2E-LUI-05` |
| LUI-06 | Arriving messages never move a reader who scrolled up; a jump-to-latest control appears | `UT-LUI-06` |
| LUI-07 | "Stop response" and "Stop run" are distinct named controls; every disabled control states its reason | `UT-LUI-07` |
| LUI-08 | Every string in the `librarian` namespace exists in EN and RU with distinct copy | `UT-LUI-08` |
| LUI-09 | The librarian binds no Cmd/Ctrl+K; the scratch shortcut still works while the panel is docked | `E2E-LUI-09` |
| LUI-10 | The Needs attention / Related work region renders from live domain reads | `IT-LUI-10` |

---

## TDD protocol

Same protocol as M51 (`.ai-factory/plans/feature-m51-see-everything.md` "TDD protocol"),
restated as binding here:

1. **RED** — write the named test, run it, record a specific assertion failure (an
   import or type error proves nothing).
2. **GREEN** — minimum code for the assertion.
3. **REFACTOR** — with the suite green, apply `web/CLAUDE.md` conventions; re-run.

- One primary test per requirement; a second test at the same level needs its own
  `EDGE-*` id. `E2E-` proves wiring, `UT-`/`IT-` prove logic.
- A test that stays green with the implementation deleted is trivial — delete it. No
  test asserts a constant's own literal values (a scope list, an enum, a label map):
  assert the behaviour the constant produces.
- Redaction/visibility proofs feed an input that CONTAINS the forbidden data (a foreign
  project, a secret, another user's message) and assert the exact output key set.
- **Two-racer tests are designed from the invariant, not from the lock**: both racers
  could violate the property; the winner performs the real writes uncommitted; the loser
  is asserted parked via `pg_stat_activity`; the test lives at the layer that owns the
  invariant (store, not route).
- **Runnability**: `web/vitest.workspace.ts` splits by suffix — `*.test.ts` → `unit`,
  `*.integration.test.ts` → `integration`; `components/**` runs in `unit` only, so every
  integration test lands under `lib/**` or `app/**`. Supervisor tests run in
  `supervisor/vitest.workspace.ts`; MCP tests in `mcp/vitest.workspace.ts`. Every new
  Playwright spec basename is added to `AUTHED_SPEC` in `web/playwright.config.ts`
  (a spec absent from the regex never runs). Each task confirms its tests appear in
  `vitest list` / `playwright test --list`.
- **Phase exit** = lint clean · `pnpm --filter maister-web test:unit && … test:integration`
  green · supervisor and mcp suites green when touched · `pnpm validate:docs` and
  `pnpm validate:contracts` green · every requirement owned by the phase is `Implemented`
  in the matrix. A pre-existing red surfaced by a phase gets an explicit quarantine task
  with a reason and a tracked follow-up — never tolerated, never deleted.
- Existing tests whose assertions a phase invalidates are migrated in that phase; the
  task names them by path (see T1.3, T3.3, T4.3, T4.4).

## Logging contract

`pino`, `LOG_LEVEL`-gated, module tags `librarian.<area>` (`conversation`, `admission`,
`composer`, `runtime`, `authority`, `ops`, `cards`, `clarify`, `followup`, `memory`,
`reset`, `retention`). Every task below ends with a **Log** line naming its events.

- `debug`: admission decisions (queue position, pool counts), composer selection
  (counts, char totals, epoch match/miss), authz decisions (scope, action, allow/deny),
  digest comparisons.
- `info`: turn lifecycle transitions, operation settle, reset start/ack, forget, clear
  history, retention batch totals, update delivery.
- `warn`: refusals (budget, fenced, stale revision, duplicate operation), reconcile arms
  firing, skipped updates for lost access, capability halts.
- `error`: unexpected failures with `MaisterError.code`.
- **Never logged** at any level: message bodies, statement text, memory content,
  clarification questions or answers, prompts, token secrets, project names of projects
  the owner cannot see. Ids, counts, codes and durations only.

---

## Decisions

Each decision below is the plan's recommendation; the named Phase 0 ADR ratifies or
amends it before code. If an ADR amends it, the plan is amended in the same pass.

### D1 — Reserved numbers

- **ADRs**: `ADR-183` runtime, `ADR-184` authority, `ADR-185` operations,
  `ADR-186` statements, `ADR-187` clarifications, `ADR-188` memory/history/reset,
  `ADR-189` surface. Highest at `3c02c739` is ADR-182. Re-verify on master before
  writing stubs: `git show master:docs/decisions.md | grep -o '^### ADR-[0-9]*' | tail -1`.
- **Migrations** (main lineage; highest at `3c02c739` is idx 180,
  `0180_agent_turn_steering`; brain lineage untouched): see Appendix A for each
  migration's DDL. `0181` token kind + audit columns · `0182` conversation tables +
  platform settings + token FK · `0183` `runs` / `execution_commands` /
  `execution_assignments` changes · `0184` `tasks` changes · `0185` operations, cards,
  statement revisions, task links, `task_comments.via_operation_id`, `agent_turns`
  user source · `0186` clarification widening, inbox/activity kinds, domain-event kinds ·
  `0187` update deliveries · `0188` memory, tombstones, summaries, search column.
  Shared-table constraint changes (`runs`, `tasks`, `agent_turns`) sit in their own
  numbers. Each migration is the four-legged set: SQL + `_journal.json` entry +
  `meta/<NNNN>_snapshot.json` + `schema.ts`, ending with `drizzle-kit generate`
  reporting "No schema changes".
- **Renumber pass**: if master moves before merge, one focused pass after rebasing
  renumbers ADRs, migrations and prose (`pre-NNNN`, `since NNNN`). Record the rule, not
  the number: "the next free number at merge".

### D2 — Runtime representation: `run_kind='librarian'`

Owner decision at planning. One `runs` row per conversation, created on the first turn,
reused across turns and parked between them.

- Row shape (verified: `runs` has only `id` and `flow_version` NOT NULL without
  default; no `run_kind` CHECK exists today — TS enum only): `run_kind='librarian'`,
  `project_id NULL`, `task_id NULL`, `flow_version='librarian'` (sentinel precedent:
  `"scratch"`, `"agent"`), `persistent=true` (the keep-alive Pass2 exemption —
  `keepalive-sweeper.ts:274` — so the parked run is never TTL-abandoned),
  `created_by_user_id`=owner (the project-less run-stream authz —
  `app/api/runs/[runId]/stream/route.ts:337-346` → `createdByUserId === userId`),
  `agent_workspace='none'`. 0183 adds `runs_run_kind_check` (4 kinds) and
  `runs_librarian_shape_check`.
- Placement: `mintPlacement(tx, {runId, reason:"librarian_turn"})`; `PLACEMENT_REASONS`
  (`execution-host/types.ts:26`) gains the reason, the generated CHECK follows.
- Workspace: `workspaceSpecFor` (`adoption.ts:54`) gains a `librarian` arm → `directory`
  at `<runtimeRoot>/.maister/_librarian/<conversationId>/`; the refusal at
  `adoption.ts:182` (no project, no package) gains the arm and the wire's required
  `projectSlug` carries the reserved value `_librarian` (the supervisor validates
  adopted paths against configured roots — `supervisor/src/workspace-roots.ts` —
  not against registered slugs; T0.4 verifies and documents the reserved slug in
  `docs/api/supervisor.openapi.yaml`). The directory holds no repository.
- Prompt owner: new kind `librarian_turn`, variants `owner_message | explain | summary`,
  ref `{turnId, promptOrdinal}` + common; added to `PROMPT_OWNER_SHAPES`
  (`prompt-owner-contract.ts:160`) so `execution_commands_request_v2_check` regenerates;
  `owner_kind` enum (`schema.ts:2316`) and `execution_commands_owner_shape_check`
  (`:2528`) are hard-coded and re-derived in 0183; `create_intent` CHECK
  (`schema.ts:2423-2461`) gains variant `librarian` with keys `{variant, turnId,
  promptOrdinal}` and `operationKey = 'librarian-create:'||turnId||':'||promptOrdinal`.
  Registry `librarianPromptOwners` joins `PRODUCTION_PROMPT_OWNER_REGISTRIES`
  (`workers/runtime.ts:46`); `composePromptOwnerRegistry` fails boot on drift.
  Logical key `librarian_turn:<variant>:<assignmentId>:<promptOrdinal>`.
- Pool: `SchedulerPool` gains `librarian`; `POOL_RUN_KINDS`, `poolForRunKind`,
  `capForPool` (`scheduler.ts:92-160`), the C1/C3 `isAgent` two-way dispatch
  (`:886-993`, `:1166-1187`) becomes a three-way; `assertScratchCapacityAvailableInTransaction`
  (`:298`) is unaffected (counts by kind). Counted over `SLOT_HOLDING_RUN_STATUSES`;
  queued FIFO like C3, never `CONFLICT`.
- **Fan-out (T2.3)**: grep `run_kind|runKind|RunKind` and turn each kind branch into an
  exhaustive `satisfies Record<RunKind, …>` map. Verified consumers: `workspaceSpecFor`
  (`WorkspaceSpecInput.run.runKind` is typed to three kinds), reconcile classifier and
  crash arm (`reconcile.ts:465-546`, `:1947-2038` — the crash arm's `else` is the flow
  path; a `librarian` arm fails the turn and parks), keep-alive budget pass
  (`keepalive-sweeper.ts:948`, branches agent/scratch), `agents/continuation-worker.ts:48`,
  `runs/run-kind-invariants.ts:96`, transcript projector turn boundaries
  (`events/transcript-projector.ts:112`, keyed on scratch — not used by the librarian),
  board / portfolio / `/runs` / work-table / decisions / Observatory read models, GC
  (`lib/gc/**` — nothing targets `NeedsInputIdle`; librarian runs never gain a
  `workspaces` row), token issuers, `agent_turns` trigger `guard_agent_turn_source`
  (raises for non-agent kinds — the librarian never writes `agent_turns`).
- Rejected: widening `run_kind='agent'` to be project-less (touches every agent-path
  assumption the brief asks to preserve).

### D3 — Session per turn, context epoch, park/resume primitives

- The durable records are the source of truth; the ACP session is a cache. Each turn
  composes a bounded context (instructions version, active-segment summaries + newest
  messages within `MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS`, memory items, subject,
  settled/non-terminal operation receipts of the segment) and writes a snapshot first.
- `librarian_conversations.context_epoch` bumps on reset, forget, clear history, and
  whenever the authz fingerprint changes (sha256 over the owner's active flag, global
  role and sorted `(project_id, role)` visibility set — computed at admission).
- `run_sessions` gains `librarian_context_epoch` (nullable) recording the epoch its ACP
  session was created under, and `librarian_turns.runner_snapshot` records the runner.
  Resume (`session/resume` on `acp_session_id`) is allowed only when epoch and runner
  match; otherwise `session/new` with the composed context. This is what stops
  retained ACP context from repeating revoked facts (LIB-13, L-06).
- **Own park/resume primitives** (verified: `applyPersistentAgentPark` CASes on
  `run_kind='agent'`, `claimAgentIdleResumeInTransaction` inserts into `agent_turns`
  whose trigger refuses other kinds): `applyLibrarianPark(tx, runId)` — CAS
  `run_kind='librarian' AND status='Running'` → `NeedsInputIdle`, `checkpoint_at`,
  `releaseAssignmentForRun(tx, runId, "parked")`; `claimLibrarianResumeInTransaction(tx,
  runId, turnId)` — CAS `status='NeedsInputIdle'` → `Running`, `mintPlacement(reason:
  "librarian_turn")`, pool cap check under the scheduler advisory lock. Both share the
  assignment primitives; neither touches `agent_turns` or `resume_requested_at`
  (patch 2026-09-23: never give an existing column a second meaning — `librarian_turns`
  is the turn ledger).
- After `end_turn`: the owner adapter's `apply` stores the reply, completes the turn,
  revokes the token and parks; `afterCommit` runs `releaseSlotOnIdle` +
  `promoteNextPending` and admits the next queued turn; then the session process is
  deleted (persistent-agent precedent, `agents/prompt-owner.ts:627`).

### D4 — Delegated authority

- Token: `project_tokens.token_kind='librarian'`, `owner_user_id` NOT NULL, `project_id`
  NULL, `agent_id` NULL, new `librarian_turn_id` NOT NULL for this kind, name
  `librarian-turn:<turnId>` (reserved in `web/lib/tokens/lifecycle.ts`), `expires_at` =
  turn deadline, revoked in the turn-end transaction. `token_kind` has **no DB CHECK
  today** (TS enum only, `schema.ts:7066`): 0181 adds `project_tokens_kind_check` over
  the four kinds and `project_tokens_librarian_check` (Appendix A). Issued by
  `web/lib/librarian/authority.ts` when the run flips `Running` (not at admission — a
  `Pending` turn holds no token); injected as `MAISTER_ACCESS_TOKEN` into the stdio
  facade for that turn's session only (one process per turn → no cross-user reuse).
- Principal: `TokenKind` (`tokens/issue.ts:28`) and `TokenActor` (`verify.ts:42-55`)
  gain `librarian`, `librarianTurnId`; `verifyToken` (`:71`, no cache, per request)
  applies the `user`-kind checks (`:117-146`: owner active, not password-change) to the
  librarian kind too; `actorUserIdForToken` (`:164`) and `socialActorForToken` (`:171`)
  return the owner.
- Admission in `handleExt` (`web/lib/tokens/ext-handler.ts`): the two `tokenKind ===
  "user"` gates for global tokens (`:312` slug path, `:419` `resolveProjectId` path)
  admit `librarian` and then call `requireProjectActionForUser(owner, project,
  projectActionForScope(scopeLabel))` (`:334`, `:441`) — live, per request; plus scope
  ∈ token scopes (`:512`) and turn `running` (new). The 403 block at `:473-492` fires
  for routes with neither `slug` nor `resolveProjectId` nor
  `allowGlobalActorWithoutProject`; the run routes the librarian needs (`runs` POST,
  `runs/[runId]`, `runs/[runId]/{activity,readiness,hitl}`, `runs/{cancel,rework}`,
  `activity`) gain `resolveProjectId` (project from the run) so the live RBAC check
  applies; `runs/{promote,discard,delegate,collect,message,plan}` stay closed to the
  kind. The three inline "global personal token only" checks (`ext/hitl/route.ts:27-45`,
  `ext/decisions/route.ts:51-60`, `notification-subscriptions/route.ts:33`) are
  extracted into one `requirePersonalOrLibrarianActor(actor, {allowLibrarian})` helper
  used by all four call sites (DRY; adding a fourth copy is the anti-pattern).
- `LIBRARIAN_TOKEN_SCOPES` (explicit list in `web/types/token-scopes.ts`): tasks
  read/create/update/triage; comments; relations; flows:read; runners:read; runs
  read/launch/cancel/recover/rework/sync/reopen/message; hitl read (list/inbox) but not
  respond; decisions:read; memory:read (Brain); projects:read; librarian:* (cards,
  memory, history). Excluded: `hitl:respond`, `hitl:respond:human`, `runs:promote`,
  `runs:discard`, `runs:delegate|collect`, tokens, settings, admin, packages, flow
  authoring, `agent_memory:write`. `AGENT_TOKEN_SCOPES` and
  `CROSS_PROJECT_AGENT_SCOPES` are not touched (review-enforced; the existing agent
  scope tests stay green).
- Explain turns (D11) get `LIBRARIAN_READ_SCOPES`, the read-only subset — teammate
  answers and retrieved text never run with effect authority (LIB-08).
- Audit: `token_audit_log` gains nullable `on_behalf_of_user_id`, `librarian_turn_id`,
  `operation_id`; `actor_label` = `librarian:<ownerUserId>`. Written through the
  existing mandatory path (`recordRequiredTokenAudit`, `ext-handler.ts:47`, inside the
  route's transaction). The per-turn project set is `DISTINCT project_id` over the
  turn's audit rows — reused by LMM-09 masking.
- Human-only boundary: the token can never answer human HITL kinds
  (`services/hitl.ts:6094-6119` refuses non-user actors), promote or discard. Those
  appear as confirmation cards (D7) whose click goes through session-auth routes as
  `HitlActor{kind:"user", userId}` (`respond/route.ts:117-149` precedent) — which also
  keeps the budget-breach restart paths working, since they call session-bound
  `requireProjectAction` unconditionally (`hitl.ts:3998`, `:4168`).

### D5 — MCP-only session (LIB-05)

`readOnlySession` cannot be used: it arbitrates first and returns
(`supervisor/src/acp-client.ts:516-545`), so `capability_guard` at the permission step
(`:744`) never runs when both are set; it also auto-allows `read`, `search` and `fetch`
(`:133-138`) — host files and generic HTTP. The librarian session uses:

- **L1** — `enforcementProfile` (`SessionEnforcementProfileSchema`,
  `supervisor/src/types.ts:354`): `tools.allow` = the librarian tool names
  (`mcp__maister__<tool>`, generated from the librarian toolset — one source with the
  instructions drift test), `mcps.allowServers: ["maister"]`,
  `enforcedClasses: ["tools","mcps"]`, `escalationThreshold: 3`. Verified: today only the
  flow graph passes a profile (`runner-graph.ts:1733`); the librarian runtime passes
  its own. A deny answers the call `cancelled` inline; the Nth consecutive deny halts
  the session (`acp-client.ts:788-818`: `hook_trip … halt`, pending permissions
  cancelled) — the owner adapter sees the halt in `outcome.events` and fails the turn
  `capability_trip`; no `hook_trip` HITL row is created (the run has no project and no
  inbox).
- **L3 policy** — execution policy `permissions=auto_approve` so an L1-admitted MCP
  call never raises a `requestPermission` that would need a `hitl_requests` row.
- **L2** — materialized adapter settings denying built-ins (claude `settings.local.json`
  deny rules for Read/Glob/Grep/WebFetch/WebSearch/Bash/Edit/Write/NotebookEdit; codex
  composed home with the equivalent) via `web/lib/capabilities/adapter-home.ts`.
- **Empty cwd** — no repository, no `context_repos`.
- **Summary turns** attach no MCP server and carry no token: `mcps.allowServers: []`,
  `enforcedClasses: ["mcps"]` (`tools.allow` has `min(1)` and cannot be empty), L2
  denies; any tool call observed in `outcome.events` fails the turn (`EDGE-LAU-04`).
- Runner guard: the librarian runner must be `readOnlyCapable` and never
  `dangerously_skip_permissions` (reuse `acp-runners/resolve.ts:215-233`).
  T2.8 proves L1 denies a scripted built-in call; T7.2 proves L1+L2 against the live
  adapters. An adapter that executes a built-in without reaching the seam is recorded in
  ADR-183 as a blocking defect and is not selectable as the librarian runner.

### D6 — Operation ledger and crash windows

`librarian_operations` (Appendix A), UNIQUE `(conversation_id, idempotency_key)`.

- Effectful MCP tools require `operationKey`; the facade sends it as `Idempotency-Key`.
  `handleExt` gains `idempotency: "required"` (an option beside `successAuditInWork`,
  `:185`): the librarian arm reads the header, canonicalizes the validated body,
  upserts the operation `admitted` before `work`, and refuses per LOP-02. Verified:
  `handleExt` never hands a tx to `work`; every mutating route opens its own
  transaction and calls `recordRequiredTokenAudit(input, tx)` inside it — so the
  **finalize rides that call**: its input gains `operation?: {id, result}` and it
  UPDATEs `librarian_operations` in the same tx. Routes without `successAuditInWork`
  (reads) never carry an operation.
- Result tables carry UNIQUE nullable `via_operation_id` / `librarian_operation_id`:
  `tasks.created_via_operation_id`, `task_comments.via_operation_id`,
  `task_clarifications.requested_via_operation_id`, `runs.librarian_operation_id`.
  A racing retry hits the unique and returns the existing result; reconcile of an
  `admitted`/`unknown` operation is a lookup on that column.
- Digest: canonical JSON (sorted keys, arrays in order) of the route's validated body
  minus the key. Same-digest duplicate guard per LOP-02.
- **Crash windows** (each gets a test in T3.2/T3.7):

| Window | State left | Recovery owner |
| --- | --- | --- |
| op inserted, domain tx not committed | op `admitted`, no result row | reconcile: no result row after `MAISTER_LIBRARIAN_OPERATION_RECONCILE_SECONDS` → `failed{reason:"not_applied"}`; safe because the domain tx is atomic with finalize |
| DB effect committed with finalize | op `succeeded` | none needed |
| `launchRun` row committed, supervisor spawn pending/lost | op `succeeded{runId}`, run `Pending`/`Crashed` | existing run reconcile; receipt reads live run status (TST-08) |
| run launch tx failed | op `admitted`, no run with that `librarian_operation_id` | reconcile → `failed` |
| response lost to the model | op terminal | next call with the same key returns stored result |

### D7 — Cards (proposals and confirmations)

`librarian_cards` (Appendix A).

- The librarian creates cards through `POST /api/v1/ext/librarian/cards`
  (`librarian_card_propose` tool). A confirmation binds exact target ids and revision:
  task → `tasks.revision`; run promotion → reviewed head SHA; HITL → request id + the
  question's stored revision; discard → run id + status.
- The owner decides through `POST /api/librarian/cards/{cardId}/decide
  {decision, expectedRevision}` (session auth). The server re-reads the target under
  lock, refuses drift with `CONFLICT{reason:"target_changed"}`, then executes through the
  same domain service the existing UI uses (`respondToHitl` with
  `HitlActor{kind:"user"}`, `promoteRun`, the discard service), recording an operation
  with key `card:<cardId>` (so a double click is one effect).
- TTL `MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES` (default 60). Reset marks pending
  cards `cleared_by_reset`.
- Explicit instructions do not need a card (LIB-08): "create these and launch the first"
  runs as operations inside the owner-message turn. Cards are required for human-only
  actions and whenever the librarian judges the target ambiguous.

### D8 — Launch intent

`tasks.launch_intent` nullable text CHECK `none | triage_only | triage_then_launch`;
NULL = today's behaviour for every non-librarian path.

- Librarian `task_create` sets `none`. The triager still runs on `task.created`
  (dedup, clarifying questions) but `applyTriageVerdict` (`web/lib/services/triage.ts:187`)
  does not arm `launch_mode='auto'` unless intent is `triage_then_launch`; C2 admission
  (`scheduler/c2-eligibility.ts`, `scheduler/handlers/auto-launch-triaged.ts`) skips `none`.
- New ext route `POST /api/v1/ext/projects/{slug}/tasks/{taskId}/send-to-triage
  {launchIntent}` wraps `sendTaskToTriage` (`triage.ts:416`) and writes the intent in
  the same transaction.
- A human Launch click is unaffected by intent.
- **Interaction table** (policy axes, tested in T3.5): triager `enqueue ∈ {true,false}` ×
  intent `∈ {NULL, none, triage_only, triage_then_launch}` × project auto-launch
  enabled/disabled → expected `launch_mode`.

### D9 — Statements and task revision

- `task_statement_revisions` (Appendix A), UPDATE and DELETE refused by trigger
  `task_statement_revisions_immutable` (task deletion cascades as today).
- `tasks.revision integer NOT NULL DEFAULT 0` and `tasks.statement_revision integer NULL`.
  `updateTask` (`web/lib/services/tasks.ts:414`: plain SELECT → UPDATE → SELECT, no
  lock) becomes `SELECT … FOR UPDATE` → compare optional `expectedRevision` → update →
  `revision = revision + 1`; `TaskDTO` (`:253-274`) gains `revision`. The UI PATCH
  (`patchBodySchema`, `tasks/[number]/route.ts:21-43`, `.strict()`) and the ext PATCH
  (`{title?, prompt?}`, `.strict()`) both accept `expectedRevision`
  (`If-Match` precedent: `web/lib/scheduled-launches/http.ts:71`); the UI PATCH's
  `{ok:true}` gains `revision`.
- Accept = one transaction: insert revision, render `tasks.prompt` from a pure
  `renderStatementPrompt(statement)` (deterministic markdown), bump revision, write the
  `refined_in`/`created_from` link, record `task_activity` (`statement_accepted`, new kind).
- **Backlog gate (TST-07)**: `updateTask` already refuses `prompt` changes off-Backlog
  (`BACKLOG_GATED_FIELDS`, `tasks.ts:360-371`). Statement accept goes through the same
  gate. This matters because a flow run re-reads `tasks.prompt` at every re-entry
  (`runner.ts:43/98` → `loadRun` → `runner-core.ts:193`; resume, recover, rework and
  interrupt all re-enter) and an agent run reads it on every `startAgentSession`
  (`launch.ts:1769-1806`). There is no launch snapshot to protect; the gate is the
  protection. A refused accept returns the operator-message seam (D10b) and the
  rework claim as next steps.
- Links: `librarian_task_links` (Appendix A); message FKs `ON DELETE SET NULL`
  (TST-06 unavailable state).

### D10 — Clarifications before execution

- Widen `task_clarifications` (`schema.ts:6324-6404`) instead of adding a parallel
  table, so `composeEffectivePrompt` (`web/lib/tasks/clarifications.ts:76`; its filter
  `orderedAnsweredClarifications` never reads origin) folds answers from both origins.
  Verified NOT NULL columns to relax: `source_hitl_request_id` (UNIQUE
  `task_clarifications_source_hitl_request_uq` — NULLs are distinct, so the index
  stays), `origin_run_id`, `origin_agent_id`, `question_schema`; `retrigger_mode` CHECK
  `task_clarifications_retrigger_mode_check` gains `none`. Added columns and the
  discriminated CHECK are in Appendix A. `answered_by_user_id` stays under
  `task_clarifications_answer_shape_check`. **Nullable fan-out**: T4.1 greps every
  reader of `origin_run_id`/`origin_agent_id`/`source_hitl_request_id`
  (`lib/queries/task-clarifications.ts:44-60` selects them; the HITL response path;
  the triage prompt) and gives each a branch.
- No `hitl_requests` row and no dummy run: `hitl_requests.run_id` stays NOT NULL.
- Activity and inbox: `TASK_ACTIVITY_EVENT_KINDS` (`schema.ts:7530`) gains
  `clarification_requested | clarification_answered | clarification_cancelled` →
  `task_activity_event_kind_check` (`:7591`) re-derived; `inbox_items_event_kind_check`
  (`:7697`, 11 kinds today) gains `clarification_requested` only; `InboxSourceRef`
  (`:7653`) gains `{kind:"clarification", taskId, clarificationId, activityId}`.
  `ATTENTION_EVENT_KINDS` (ADR-169 D4: a `domain_events` kind with a `task_activity`
  twin is not counted) gains `task.clarification_answered`, which now has a twin.
- Decisions queue: `computeDecisionsQueue` (`web/lib/queries/decisions.ts:178`) reads
  four sources via `Promise.all` into one array (`count = items.length`, `:326`) — a
  fifth source `listOpenClarificationsForRecipient` keeps ATN-01 by construction.
  Fan-out for the new kind `clarification`: `DECISION_KINDS` (`:52`), `NON_HITL_RANK`
  (`:120`), `STAGE_BY_KIND` (`:160`), `compareDecisions`, `nextActionOf` in
  `ext/decisions/route.ts:18`, the inbox card. Scoping stays "projects the reader can
  act in" (member+), which is why CLR-02 requires `member` (= `PROJECT_ACTION_MIN.answerHitl`).
- Launchability: `TaskLaunchability` (`web/lib/runs/launchability.ts:16-23`) gains
  `clarification_pending`, precedence after `flagged`, before `blocked`. Verified
  consumers to fan out: `services/runs.ts:711`, `services/hitl.ts:4047`,
  `scheduler/c2-eligibility.ts:287`, `run-schedules/dispatch.ts:58-100` (`decideFire`
  is an if-chain that falls through to `launch` — gets an explicit arm),
  `runs/task-launch-config.ts:290`, `app/api/runs/launch-options/route.ts:490`,
  the task page `:179`, and the hand-mirrored classifiers `components/board/board.tsx:172-194`
  and `launch-popover.tsx:144,833` (get the value + a parity test against the shared
  classifier). `deriveWorkStage` (`web/lib/work/stage.ts:39-58`) has **no launchability
  input**: it gains `openBlockingClarificationCount` and the attribute
  `clarificationPending` (mirroring `blocked`/`blockingRelationCount`; ADR-170
  amendment); its two callers (`queries/work-table.ts:321`, `queries/board.ts:795`)
  batch the count.
- Answer: `POST /api/projects/{slug}/tasks/{number}/clarifications/{id}/answer` (session)
  and the ext twin requiring exact `hitl:respond:human` on a global personal token.
- Domain events `task.clarification_requested`, `task.clarification_cancelled` (the
  existing `task.clarification_answered` is reused). 0186 re-derives
  `domain_events_kind_check` from migration `0167`'s 15 kinds plus the two —
  `schema.ts:7759` lists only 13 today (drift found at planning); T4.1 fixes
  `schema.ts` in the same change.

### D10b — Operator message seam

`POST /api/v1/ext/runs/{runId}/operator-message {message, operationKey}` →
`{outcome: delivered|queued|refused_requires_rework, reason?}`, scope `runs:message`,
action = the run's existing "send message" action:

- scratch run → `sendScratchUserMessage` only if the owner is the scratch owner;
- persistent agent run → `sendAgentMessage` with a user principal: `agent_turns.source`
  gains `user` + `requested_by_user_id`, and trigger `guard_agent_turn_source`
  (`0153:71`, `0180:37`) is re-derived in 0185 — never `runs:delegate`;
- flow run → `refused_requires_rework` naming the existing node-interrupt/rework
  controls (ADR-160/161) the owner can use from the run page.

### D11 — Follow-up updates

- Domain-event consumer `librarian_followup` in `DOMAIN_EVENT_CONSUMERS`
  (`web/lib/domain-events/consumers.ts:64`). Kinds (verified against
  `taxonomy.ts:5-48`; there is no `run.launched`): `run.done | run.failed | run.crashed
  | run.abandoned | run.review | run.review_opened | run.needs_input | run.escalated |
  run.rework_claimed | run.rework_returned | gate.failed | task.clarification_answered |
  task.clarification_cancelled`. A task is followed by a conversation when a
  `librarian_task_links` row or a succeeded operation targets it.
- `librarian_updates` (Appendix A), UNIQUE `(conversation_id, domain_event_id)`.
  Delivery inserts an `author_kind='update'` message with a deterministic card — no
  model turn, no tokens. The queue→running transition has no event; the card reads
  live run status at render (TST-08).
- Access check at insert and at render; lost access → `skipped_no_access`.
- "Explain" on an update card enqueues an `explain` turn (read-only token, D4).
- Result semantics (L-12): the card derives its label from `deriveWorkStage` (M51) plus
  promotion facts; "deployed" is never claimed — a merged run shows
  "merged · deployment unknown".
- Automation policy: at-least-once dispatch, idempotent by the unique; attempts ≤ 5 with
  backoff; a deterministic failure (e.g. conversation missing) → `failed` with evidence and
  the cursor advances, so one poison event never stalls the consumer.

### D12 — Memory, summaries, retrieval

- Tables in Appendix A: `librarian_memory_items`, `librarian_memory_item_revisions`,
  `librarian_memory_tombstones`, `librarian_segment_summaries`.
- Summaries are produced by a tool-less `summary` turn after a turn ends when the
  segment's unsummarized tail exceeds half the context cap; at most one pending per
  segment; ≤ 2 attempts; on failure the composer truncates and records it in the snapshot.
- Writes are CAS on `(segment ordinal = current, forget_generation = current,
  history_generation = current)` — a late writer after reset/forget/clear writes nothing.
- Retrieval re-checks `source_project_ids` against current visibility on every use.
- History search: `GET /api/v1/ext/librarian/history/search?q=` (librarian token only)
  over a generated `tsvector` on `librarian_messages.body`, bounded to 20 hits, older
  segments included, results labelled `from earlier conversation`.
- Nothing writes to Project Brain or `agents/.../memory.md` (LMM-11: an ESLint
  `no-restricted-imports` fence on `web/lib/librarian/**` plus the IT).

### D13 — Reset barrier (recovery-window table)

`POST /api/librarian/reset` → one transaction under the conversation row lock: set
`reset_state='resetting'`, withdraw `queued` messages (`delivery_state='withdrawn_by_reset'`),
request stop of the current turn, revoke its token. A barrier pass (called inline, and by
the `system_sweep` backstop) acknowledges when no operation of the old segment is
`admitted|unknown` and no turn is `admitted|running`: insert the new segment, bump
`context_epoch`, mark pending cards `cleared_by_reset`, clear subject, set
`reset_state='none'`.

| State at crash | Left as | Owner |
| --- | --- | --- |
| reset tx committed, turn still running | `resetting`, turn `running` | stop request retried by the barrier pass; deadline watchdog as last resort |
| turn stopped, operations `admitted` | `resetting` | op reconcile (D6) then barrier pass |
| barrier pass crashed mid-ack | tx rolled back, still `resetting` | next pass (idempotent) |
| late summary/memory writer | fenced (D12) | none |
| late update for old-segment task | delivered into the new segment as a bounded update card | D11 (by design: tasks continue) |

### D14 — Clear history and host purge

`GET /api/librarian/history/clear-preview` returns counts (messages, summaries,
snapshots, cards, links that become unavailable, operations kept) and a preview digest;
`POST /api/librarian/history/clear {previewDigest}` refuses a stale digest. One
transaction deletes messages, summaries, snapshots, cards, updates' message refs;
nulls message refs on links and operations; bumps `history_generation` and
`context_epoch`. After commit: release the conversation workspace through the host
(`workspace.release`), which removes the cwd; the next turn re-adopts once (ADR-166:
the host refuses a released handle and the client re-adopts).
**Open (spike T0.9)**: where each ready adapter persists its session transcript for a
given cwd (claude: `~/.claude/projects/<encoded cwd>/`; codex: its composed
`CODEX_HOME`). ADR-188 records either a supervisor-side purge of that location on
release, or the residual plus the guarantee that the epoch bump makes it unreachable.
Stating a purge that does not happen is not allowed.

### D15 — Locks and invariants

| Invariant | Scope | Lock |
| --- | --- | --- |
| ≤ 1 active turn per conversation; queue order; reset vs admission | conversation | `SELECT … FOR UPDATE` on `librarian_conversations` + partial unique index |
| per-user daily turn cap | user = conversation (1:1) | same row lock |
| librarian pool cap | global | existing scheduler advisory lock in `tryStartRun` |
| operation uniqueness | conversation | UNIQUE `(conversation_id, idempotency_key)` |
| task revision | task | task row lock (`FOR UPDATE`) |
| clarification answer once | clarification | row lock + status CAS |
| card decision once | card | row lock + status CAS |

Lock order when a librarian write touches a task: conversation → operation → task
(the peer writers of `tasks` take task first and never touch librarian rows, so no
inversion exists; patch 2026-09-xx lock-order rule). The two-racer tests are written
against the invariant: two tabs posting different messages at once (both queue, one
turn active), and reset racing admission (either the turn is admitted into the old
segment and then stopped, or refused — never admitted into the new segment with old
context).

### D16 — Route identifiers

| Route | Identifiers |
| --- | --- |
| `GET /api/librarian/conversation`, `GET /api/librarian/messages` | owner `auth-context`; conversation `server-state` (by owner); `beforeSeq`,`limit` body-controlled (bounded ints) |
| `POST /api/librarian/messages` | owner `auth-context`; `clientMessageId` body-controlled (uuid, scoped to the owner's conversation); `subject.taskIds` body-controlled → visibility-checked, 404 on foreign |
| `DELETE /api/librarian/messages/{messageId}` | `url-param` compared to the owner's conversation (`server-state`); mismatch → 404 |
| `POST /api/librarian/turns/current/stop`, `POST /api/librarian/reset`, `…/history/clear[-preview]`, `POST /api/librarian/read-cursor` | owner only; no ids in body except `previewDigest` / `seq` |
| `POST /api/librarian/cards/{cardId}/decide` | `url-param` checked against owner; `expectedRevision` body-controlled, compared to `server-state` |
| `GET/POST/PATCH/DELETE /api/librarian/memory[/{id}]` | owner only; `id` url-param checked against owner |
| `POST /api/librarian/updates/{updateId}/explain` | url-param checked against owner |
| `GET /api/librarian/stream` | owner only; `lastEventId` body-controlled (int) |
| `POST /api/v1/ext/librarian/*` | owner from token (`auth-context`); no user or conversation id accepted |
| Ext routes admitting librarian tokens | project from slug/`resolveProjectId` (`url-param`/`server-state`), always RBAC-checked live |
| `PATCH /api/admin/platform/librarian` | `requireGlobalRole('admin')`; `runnerId` body-controlled → must exist, be enabled and read-only-capable |

No route accepts a `userId`. None of the web routes is reachable with a token.

### D17 — Deployment touchpoints

New env vars (all read by `web` only): `MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS=3`,
`MAISTER_LIBRARIAN_TURN_MAX_MINUTES=10`, `MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS=60000`,
`MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER=200`,
`MAISTER_LIBRARIAN_OPERATION_RECONCILE_SECONDS=120`,
`MAISTER_LIBRARIAN_HISTORY_RETENTION_DAYS=365`,
`MAISTER_LIBRARIAN_SNAPSHOT_RETENTION_DAYS=30`,
`MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES=60`. Each lands in `.env.example`, the
`web` `environment:` block of `compose.yml`, `compose.production.yml` and
`compose.public.yml` (verify which of them define the web service), and the env table
in `docs/configuration.md`. No new port, sidecar binary or bind mount: the workspace
lives under the existing runtime root. Defaults are proposals confirmed by the owner in
T0.17.

### D18 — Contract surfaces → spec files

| Surface | Spec |
| --- | --- |
| Session routes `/api/librarian/*`, card decide, clarification answer, admin librarian settings | `docs/api/web.openapi.yaml` |
| Ext routes (projects, directory, task search, work, activity feed, send-to-triage, statement, clarifications, operator-message, `librarian/*`) + `Idempotency-Key` + `expectedRevision` on tasks PATCH + a `librarianTurnToken` security scheme beside `projectToken` (`operations.openapi.yaml:3435`) on every route that admits the kind | `docs/api/external/operations.openapi.yaml` + `docs/system-analytics/external-operations.md` |
| Librarian stream | new `docs/api/async/librarian-stream.asyncapi.yaml`, added to `ASYNCAPI_FILES` in `scripts/validate-contracts.mjs` with a `validateLibrarianStreamContract` assertion |
| `POST /sessions` enforcement profile use and `POST /workspaces/adopt` reserved `projectSlug` | `docs/api/supervisor.openapi.yaml` + `docs/supervisor.md` |
| New domain-event kinds | `docs/system-analytics/domain-events.md` + `docs/db/domain-events.md` |
| MCP tools | `mcp/src/tools.ts` + `docs/system-analytics/external-operations.md` MCP table |
| Tables/columns | Drizzle migrations + `docs/database-schema.md` (newer sections use `sql` DDL blocks with normative constraint names — follow that style) + new `docs/db/librarian-domain.md` ERD (format of `attention-domain.md`: status blockquote, `erDiagram`, keys, indexes, cascade chain) + updates to `projects-domain.md`, `runs-domain.md`, `hitl-domain.md`, `attention-domain.md` + regenerated `docs/db/erd.dbml` |
| Env vars | `docs/configuration.md` + `.env.example` |
| Errors | no new `MaisterError` code; new `details.reason` values (`idempotency_payload_mismatch`, `duplicate_of_operation`, `target_changed`, `stale_revision`, `capability_trip`, `host_lost`) listed in `docs/error-taxonomy.md` |
| i18n | `web/messages/en.json` + `ru.json` namespace `librarian` (+ additions to `taskDetail`, `inbox`, `workStage`) |
| Agent-facing SSOT | `web/lib/librarian/instructions.ts` (versioned) + its drift test against the librarian toolset and the L1 allow-list |

### D19 — Turn recovery windows

| Turn status × run status | Arm |
| --- | --- |
| `queued` × any | admitted by the next admission pass (event-driven + `system_sweep` backstop) |
| `admitted` × `Pending` | pool promotion (`promoteNextPending` librarian arm); no token issued yet |
| `admitted` × `Running`, no prompt command after 60 s | re-issue start (logical key `librarian_turn:<variant>:<assignmentId>:<ordinal>` makes it idempotent); 3 failures → `failed{reason:"start_failed"}` |
| `running` × `Running`, live session | none (deadline watchdog); after a web restart the prompt command is settled by the owner-registry worker (`workers/runtime.ts`), which is registry-generic |
| `running` × run not live (restart, adapter loss) | reconcile `librarian` arm (`reconcile.ts` crash arm gains the kind) → turn `failed{reason:"host_lost"}`, token revoked, run parked `NeedsInputIdle`, next queued turn admitted |
| `running` past deadline | watchdog: cancel prompt, turn `failed{reason:"deadline"}` |
| `running`, guard halt observed | owner adapter → turn `failed{reason:"capability_trip"}` |
| `stopped|failed|completed` × `Running` | park the run (idempotent) |

### D20 — Background automation

| Loop | Progress | Retries / poison | Wiring test |
| --- | --- | --- | --- |
| turn admission | FIFO by `seq` per conversation; pool FIFO by `admitted_at` | 3 start attempts → `failed` | `runSchedulerTick({jobKind:"system_sweep"})` admits a stranded `admitted` turn |
| `librarian_followup` consumer | domain-event cursor | ≤ 5 attempts, deterministic failure → `failed`, cursor advances | dispatcher test through `dispatchDomainEvents` |
| summary turns | one pending per segment | ≤ 2 attempts, then truncation | end-of-turn hook test |
| retention pass | keyset cursor in sweep state, batch 500 | per-row failure logged, batch continues | `runSchedulerTick` |
| card expiry | lazy on decide + sweep | none | sweep test |
| reset barrier backstop | per conversation in `resetting` | idempotent | sweep test |

All four librarian passes are added as sequential calls inside `runSystemSweep`
(`web/lib/scheduler/system-sweeps.ts:295`), each wrapped like the existing passes so
one failure never blocks the next.

---

## Phases and tasks

Task line format is the coverage gate's: `**Tn.m [ ] — Title.**` Body: **what** ·
**files** · **RED** (test file + id + the assertion that must fail first) · **Log**.
Requirement ids in the heading are the coverage gate's input.

### Phase 0 — Specifications and contracts (no application code)

**T0.1 [x] — Save the brief.** `docs/pv/personal-librarian.md`, verbatim; 26 relative
links resolve (`node scripts/validate-docs-links.mjs`). Done during planning.

**T0.2 [ ] — Supersession banner.** In `docs/pv/team-visibility-and-po-intake.md`, add
one status line naming what `personal-librarian.md` replaces (D1, D2, D5, D7, librarian
parts of F1/F2, owner decisions §7 rows 2 and 7). Surgical: no other edits (R9).

**T0.3 [ ] — Reserve numbers.** ADR stubs `### ADR-183` … `### ADR-189` in
`docs/decisions.md` + `docs/decisions/adr-183.md` … `adr-189.md` from the template;
migration numbers 0181–0188 recorded in Appendix A. *Verify*:
`node scripts/validate-docs-adr-anchors.mjs --all`.

**T0.4 [ ] — ADR-183: librarian runtime.** D2, D3, D19, D20, D5's runner guard, pool and
budgets. Amends ADR-166/167 (owner kind, placement reason, project-less directory
adoption, reserved `projectSlug='_librarian'`) via their `**Amendments:**` lists.
**Verification inside the ADR**: read `supervisor/src/workspace-registry.ts` and
`workspace-roots.ts` and state exactly how the adopted path is derived and validated
for the reserved slug; if any code path resolves the slug against registered projects,
record the change needed. Owns `LCV-*`.

**T0.5 [ ] — ADR-184: delegated authority.** D4 + D5 + D16. States explicitly: no
`AGENT_TOKEN_SCOPES` change, no admin inspection in this release, follow-up turns
read-only, `readOnlySession` not used and why (`acp-client.ts:516-545`). Owns `LAU-*`.

**T0.6 [ ] — ADR-185: operation ledger.** D6, D7, D8, D10b, D11 with the crash-window
and interaction tables. Amends the triage ADR/analytics for `launch_intent`. Owns
`LOP-*`.

**T0.7 [ ] — ADR-186: statements and provenance.** D9 including the Backlog gate and
the re-entry fact behind it; the rendering function contract; `task_activity` kind
`statement_accepted`. Owns `TST-*`.

**T0.8 [ ] — ADR-187: clarification before execution.** D10; amends ADR-169 (fifth
decisions population) and ADR-170 (`clarificationPending` attribute) and the
launchability precedence. Owns `CLR-*`.

**T0.9 [ ] — ADR-188: memory, history, reset, retention + transcript spike.** D12–D14;
retention defaults (365 / 30 days, owner-chosen). Spike: locate each ready adapter's
transcript storage for a cwd and whether the supervisor can delete it; record the
outcome (purge mechanism or honest residual). Owns `LMM-*`.

**T0.10 [ ] — ADR-189: librarian surface.** Top-nav entry + right panel (brief §4),
breakpoints (docked ≥ `xl`, sheet `md`–`xl`, full screen < `md`), Studio/scratch
composer coexistence (the panel never absorbs their history; focus owner rule), no
Cmd/Ctrl+K, indicator semantics, live-token streaming via the run stream. Confirm
layout on Desk, task detail, workbench, Studio and 390 px with a mockup attached to the
ADR. Owns `LUI-*`.

**T0.11 [ ] — Analytics documents.** The seven documents above, R5 sections in order,
`stateDiagram-v2` for the five machines in Appendix D; Expectations carry the ids above
verbatim (≤ 12 each); Edge cases carry `EDGE-*` ids linked to `MaisterError` codes;
every bullet names its enforcement point; R6 tags `(Designed)`. Update `triage.md`,
`tasks.md`, `attention.md` (ATN-01 population, `ATTENTION_EVENT_KINDS`),
`work-stages.md` (attribute), `domain-events.md`, `external-operations.md`,
`agent-mentions.md` (one line: the librarian is not a summon). Index rows in
`docs/system-analytics/README.md`.

**T0.12 [ ] — Screen docs.** New `docs/screens/chrome/librarian-panel.md` on the
9-section template (roles table, entry/exit links, regions, states diagram for
closed/idle/running/queued/resetting/disabled/no-runner, data & APIs, i18n). Update
`chrome/top-nav.md` (new entry), the task detail screen doc (clarifications section),
`inbox.md` (clarification card), `settings-acp-runners.md` (librarian card). Index rows
in `docs/screens/README.md`.

**T0.13 [ ] — API, ERD, configuration specs.** Every D18 row, using Appendix A–C as the
source: `docs/database-schema.md` sections in the `sql` DDL style with the constraint
names given here; the ERD file; OpenAPI entries modelled on `extCreateTask`
(`operations.openapi.yaml:120-165`: tags, summary, scope+audit description,
operationId, security, `$ref` bodies, `$ref` error responses) plus the new
`librarianTurnToken` scheme; the session routes in `web.openapi.yaml`; the AsyncAPI
file registered in `scripts/validate-contracts.mjs` with an assertion function.
*Verify*: break the new AsyncAPI file (RED) → `pnpm validate:contracts` fails → fix
(GREEN).

**T0.14 [ ] — Enforce the ids.** Add `LIBRARIAN_GROUP` (7 documents, 7 prefixes,
`librarian-traceability.md`) to `scripts/validate-docs-indexes.mjs` + a test case in
`validate-docs-indexes.test.mjs`. Generalize `validate-m51-coverage.mjs` into
`validate-requirement-coverage.mjs --group m51|librarian`: group = `{planPath,
documents, prefixes, matrixPath, implementationPhases}`; the task regex (`:139`) and the
matrix regex (`:84`, prefixes parameterized) are unchanged; a regression case pins M51's
current result. *RED*: register the group before the documents exist → "missing
Librarian analytics document".

**T0.15 [ ] — Traceability matrix.** `docs/system-analytics/librarian-traceability.md`:
one row per id and `EDGE-*` id (contract, tasks, primary test, `Planned`), plus the
`LIB-01..16` / `L-01..12` mapping table (every LIB and every L maps to ≥ 1 id; every
L maps to its `E2E-L-NN` and `QL-L-NN` where applicable). Index row in the README.

**T0.16 [ ] — Roadmap amendment (via `/aif-roadmap`).** Amend the M51 entry: add the
librarian scope line and remove "PO intake" from its non-goals, only with the owner's
confirmation. If the owner prefers a separate milestone, update this plan's linkage.

**T0.17 [ ] — Phase 0 exit.** `pnpm validate:docs`, `pnpm validate:contracts`, the
coverage gate green. Owner confirms: breakpoints, env defaults (D17), retention,
confirmation TTL, the transcript-purge outcome, the reserved-slug verification.
Anything a later task needs that the specs do not state is fixed here.

> **Checkpoint 1** — `docs(librarian): specify runtime, authority, operations, statements, clarifications, memory and surface (ADR-183..189)`

### Phase 1 — Delegated authority and the read surface · `LAU-02..07`, `LAU-10`

**T1.1 [ ] — Migration 0181: librarian token kind + audit columns.** Appendix A/0181.
Adding `project_tokens_kind_check` over existing rows fails loudly on any foreign value
(none can exist: TS-enforced). Files: `web/lib/db/migrations/0181_*.sql`, journal,
snapshot, `schema.ts` (`tokenKind` enum + constraints). *RED*:
`web/lib/db/__tests__/librarian-token-kind.integration.test.ts` `IT-LAU-02` part 1 —
inserting a librarian token with a `project_id`, or without `librarian_turn_id`, is
refused by the CHECK. **Log**: none (DDL).

**T1.2 [ ] — Issue, verify, revoke.** `web/lib/librarian/authority.ts`
(`issueLibrarianTurnToken`, `revokeLibrarianTurnToken`); `TokenKind` + `TokenActor`
librarian arm (`tokens/issue.ts:28`, `verify.ts:42-55`); `verifyToken` applies the
owner-active/password checks to the kind (`verify.ts:117-146`); `actorUserIdForToken`,
`socialActorForToken` → owner; reserved name in `tokens/lifecycle.ts`. *RED*:
`web/lib/librarian/__tests__/authority.integration.test.ts` `IT-LAU-02` part 2 — a
revoked or expired turn token is refused on the next request (`EDGE-LAU-01`); a
deactivated owner's live token is refused (`IT-LAU-10` part 1). **Log**: `info`
issue/revoke `{turnId, tokenId, expiresAt}`.

**T1.3 [ ] — Scope policy and live admission.** `LIBRARIAN_TOKEN_SCOPES`,
`LIBRARIAN_READ_SCOPES` in `web/types/token-scopes.ts`; librarian arms at
`ext-handler.ts:312` and `:419` calling `requireProjectActionForUser` per request; the
turn-`running` check; `resolveProjectId` added to the run routes named in D4; the
shared `requirePersonalOrLibrarianActor` helper replacing the three inline checks. The
one existing test asserting the 403 for global tokens
(`app/api/v1/ext/activity/__tests__/route.integration.test.ts:111-129`) stays green
(the arm is kind-specific); the three personal-route tests (`decisions/…:342`,
`hitl/…:356`, `relations/…:485`) stay green. *RED*:
`web/app/api/v1/ext/__tests__/librarian-admission.integration.test.ts` `IT-LAU-03`
(viewer owner → task create 403 while task read 200; turn `stopped` → 403),
`IT-LAU-10` part 2 (membership removed between two calls of one turn → second call
404), `IT-LAU-04` (librarian token on `hitl_respond`, `run_promote`, `run_discard`,
`run_delegate` → 403; agent token on `/ext/librarian/cards` → 403), `IT-LAU-05`
(read-scope token on `task_create` → 403, on `task_get` → 200). **Log**: `debug`
`{turnId, scope, action, projectId, decision}`; `warn` on deny.

**T1.4 [ ] — Audit attribution.** `recordRequiredTokenAudit` input gains
`onBehalfOfUserId`, `librarianTurnId`, `operationId`; the librarian arm fills them.
*RED*: `IT-LAU-07` asserts the row for a `task_create` carries owner, turn and
operation ids, and an injected audit write failure fails the request with no task row.
**Log**: none beyond existing audit.

**T1.5 [ ] — Discovery and cross-project reads.** Ext routes: `GET /ext/projects`
(`getVisibleProjects`, `queries/visible-projects.ts:89`), `GET
/ext/projects/{slug}/directory` (purpose from project config/README excerpt, launchable
flows, default runner, triager configured, Brain enabled, `asOf`), `GET
/ext/tasks/search?q=&cursor=` (visible projects, title/key/prompt match, page 25,
`truncated` flag), `GET /ext/work` (`queries/work-table.ts`), `GET /ext/activity/feed`
(`queries/activity-feed.ts`); admit librarian tokens on `GET /ext/decisions` (owner's
human authority: the queue is read, never answered). Files under
`web/app/api/v1/ext/**` + `web/lib/queries/**`. *RED*:
`web/app/api/v1/ext/__tests__/librarian-visibility.integration.test.ts` `IT-LAU-06` —
seed a project the owner cannot see containing a matching task; search, work, feed,
decisions and directory return no row, no count and an identical 404 for its slug.
**Log**: `debug` `{route, visibleProjects, rows, truncated}`.

**T1.6 [ ] — MCP facade tools.** `mcp/src/tools.ts`: `project_list`, `project_get`,
`task_search`, `work_list`, `decisions_list`, `activity_feed`; `operationKey` argument
on every effectful tool (sent as `Idempotency-Key`); `MAISTER_MCP_TOOLSET=librarian`
lists only librarian-permitted tools (enforcement stays server-side). Appendix C.
*RED*: `mcp/src/__tests__/librarian-tools.test.ts` `CT-LAU-06` — tool→route mapping
for each new tool and header forwarding of `operationKey`. **Log**: facade `debug` per
call `{tool, status}` without bodies.

> **Checkpoint 2** — `feat(librarian): delegated per-turn authority and visibility-scoped read surface`

### Phase 2 — Durable conversation, runtime and panel shell · `LCV-01..12`, `LAU-01`, `LAU-09`, `LAU-11`, `LUI-01..09`

**T2.1 [ ] — Migration 0182: conversation tables + platform settings.** Appendix
A/0182. *RED*: `web/lib/librarian/__tests__/schema.integration.test.ts` `IT-LCV-01`
(second conversation for one user refused), `IT-LCV-03` part 1 (second `running` turn
refused by `librarian_turns_one_active_uq`), `IT-LCV-07` part 1 (a `running` turn
without `context_snapshot_id` refused).

**T2.2 [ ] — Migration 0183: `runs` / `execution_commands` / assignments.** Appendix
A/0183: `runs_run_kind_check`, `runs_librarian_shape_check`,
`runs.librarian_operation_id`, `run_sessions.librarian_context_epoch`, owner-kind enum
+ `execution_commands_owner_shape_check` re-derived, `create_intent` variant,
placement reason. Re-derive shared CHECKs from `schema.ts` at rebase. *RED*:
`IT-LCV-04` part 1 — a `librarian` run with a `project_id`, or with `persistent=false`,
is refused; a prompt command without owner is refused.

**T2.3 [ ] — `run_kind` fan-out.** Every consumer in D2's verified list, converted to
exhaustive `satisfies Record<RunKind, …>` maps; reconcile crash arm `librarian`
(D19); `workspaceSpecFor` + adoption refusal arm; keep-alive budget pass arm;
`run-kind-invariants.ts` arm; librarian runs excluded from every project-scoped read
model and metric. The task body lists every file touched. *RED*:
`web/lib/runs/__tests__/run-kind-fanout.integration.test.ts` `IT-LCV-04` part 2 — a
parked librarian run appears in no board, portfolio, `/runs`, work, decisions,
Observatory or GC candidate query; `EDGE-LCV-05` — a librarian run parked 25 h survives
the keep-alive sweep (`persistent=true`); `IT-LCV-09` part 1 — reconcile with a dead
host classifies the librarian run into its own arm, not `crashRunningRun`. **Log**:
`warn` on the reconcile arm.

**T2.4 [ ] — Conversation service.** `web/lib/librarian/conversation.ts`:
`getOrCreateConversation(ownerId)`, `appendOwnerMessage` (dedup by
`client_message_id`, subject captured), `withdrawMessage` (queued only),
`listMessages(beforeSeq)`, `advanceReadCursor` (GREATEST). *RED*: `IT-LCV-02` (two
concurrent inserts of one client id → one row, same response — `EDGE-LCV-01`),
`IT-LUI-04` (subject stored at send; a later subject change does not alter the queued
message). **Log**: `info` `{conversationId, seq, deduped}`.

**T2.5 [ ] — Admission, pool, budgets.** `web/lib/librarian/admission.ts` + the
`librarian` pool (D2's verified list: `SchedulerPool`, `POOL_RUN_KINDS`,
`poolForRunKind`, `capForPool`, the C1/C3 three-way dispatch) + daily cap +
enabled/runner-ready checks + authz fingerprint → epoch bump. *RED*: `IT-LCV-03` part 2
(message while running stays queued — `EDGE-LCV-02`), `IT-LCV-05` (pool of 1: second
user's turn `Pending`, admitted when the first parks; parked run counts in no pool),
`IT-LCV-10` (daily cap → `BUDGET_EXCEEDED`), `IT-LCV-11` part 1 (disabled → `CONFIG`;
runner not ready → `EXECUTOR_UNAVAILABLE` — `EDGE-LCV-03`), `IT-LAU-10` part 3
(deactivated owner's queued turn refused at admission), the two-tab two-racer (D15).
**Log**: `debug` pool counts and queue position; `warn` refusals.

**T2.6 [ ] — Context composer and snapshot.** `web/lib/librarian/composer.ts` (pure
selection over supplied rows) + `snapshot.ts` (persist before prompt). Memory and
summaries are empty inputs until Phase 6. *RED*:
`web/lib/librarian/__tests__/composer.test.ts` `UT-LCV-10` (owner's latest message
always included when over budget); `IT-LCV-07` part 2 (no prompt command exists
without a committed snapshot); `IT-LCV-06` (epoch mismatch → `session/new`; match →
`session/resume`; runner change → `session/new`). **Log**: `debug` `{turnId,
messages, chars, truncated, epochMatch}`.

**T2.7 [ ] — Instructions SSOT.** `web/lib/librarian/instructions.ts` (versioned):
role, the LIB-08 intent rules, ask-when-ambiguous, duplicate check via `task_search`
before create, operation keys, cards for human-only actions, never claim deployment.
The librarian toolset is exported once and feeds the instructions, the facade toolset
and the L1 allow-list; a drift test asserts the three agree. *RED*: `UT-LCV-07`
(version recorded in the snapshot; the drift test fails on a renamed tool). **Log**: none.

**T2.8 [ ] — Supervisor MCP-only enforcement.** The librarian runtime builds the D5
profile; L2 adapter deny settings via `web/lib/capabilities/adapter-home.ts`; execution
policy `auto_approve`; runner guard. *RED*:
`supervisor/src/__tests__/librarian-mcp-only.integration.test.ts` `IT-LAU-11` using
`mock-acp-guardrail.mjs`: a scripted `read` and a `fetch` call are denied; a
`mcp__maister__task_get` call is allowed; three consecutive denials halt the session
with a `hook_trip … halt` event; and `readOnlySession` is absent from the create
payload. **Log**: supervisor `warn` on deny with `{sessionId, toolName}`.

**T2.9 [ ] — Park and resume primitives.** `web/lib/librarian/park.ts`:
`applyLibrarianPark(tx, runId)` and `claimLibrarianResumeInTransaction(tx, runId,
turnId)` per D3, over `releaseAssignmentForRun` / `mintPlacement` / the scheduler
advisory lock; no `agent_turns`, no `resume_requested_at`. *RED*:
`web/lib/librarian/__tests__/park.integration.test.ts` `IT-LCV-05` part 2 — park
releases the assignment as `parked` and the slot; a resume claim on a `Running` run is
refused; a claim under a full pool leaves the run `NeedsInputIdle` and the turn
`admitted`. **Log**: `info` `{runId, from, to}`.

**T2.10 [ ] — Turn runtime and prompt owner.** `web/lib/librarian/runtime.ts`:
first-turn run insert (row shape per D2) + `run_sessions` + `mintPlacement` in one tx;
directory adoption with the reserved slug; token issue at `Running`; facade
`mcpServers` entry with the turn token; `createOwnedSession` (resume per D3);
`issueOwnedPrompt` with owner `librarian_turn:owner_message:<assignmentId>:<ordinal>`.
`web/lib/librarian/prompt-owner.ts`: a `definePromptOwnerAdapter` whose `prepare`
drains `outcome.events` collecting assistant text (`agentMessageText` precedent,
`agents/prompt-owner.ts:643-651`) and watching for a `hook_trip … halt`; `apply(tx)`
stores the reply message, records source projects from the turn's audit rows,
completes or fails the turn, revokes the token, parks the run; `afterCommit` runs
`releaseSlotOnIdle` + `promoteNextPending` and admits the next queued turn; a
`failed|fenced` outcome fails the turn (`host_lost` on turn-lost) and parks. **Deferred
release**: every failure path after the prompt was issued (reply persistence error,
snapshot error, token-revoke error) cancels the prompt through `BoundClient` before
returning; a regression test injects a persistence failure and asserts the cancel was
issued and the token revoked. *RED*: `IT-LCV-04` part 3 + `IT-LAU-11` part 2 (a turn
whose adapter emits a halt ends `failed{capability_trip}` with no `hitl_requests` row)
against a mock adapter. **Log**: `info` turn transitions `{turnId, runId, from, to,
durationMs}`; `error` on failure paths with `{turnId, code}`.

**T2.11 [ ] — Stop, deadline, reconcile.** Stop route + service (cancel prompt via
`BoundClient`, revoke token, turn `stopped`); deadline watchdog (existing duration
watchdog pattern); D19 arms in the reconcile `librarian` arm and `system_sweep`.
*RED*: `IT-LCV-08` (stop leaves a launched task run and its operation row untouched),
`IT-LCV-09` part 2 (kill the host mid-turn → `failed{host_lost}`, queued message admits
after), `EDGE-LCV-04` (deadline during a tool call → token revoked, operation settles by
reconcile). **Log**: `warn` on each arm firing.

**T2.12 [ ] — Session routes and stream.** `web/app/api/librarian/**` routes from D16
(conversation, messages, withdraw, stop, read-cursor, stream). Stream: server-side poll
of durable tables — 500 ms while a turn is running, 2 s idle, closes after 5 min quiet;
frames per Appendix B; replay by `seq`. The running turn's tokens come from the
existing run stream (owner authz already holds). *RED*:
`web/app/api/librarian/__tests__/routes.integration.test.ts` `IT-LAU-01` (a `userId`
in body/query is ignored or refused; owner from session), `IT-LAU-09` (global admin
gets only their own conversation; no route returns another user's rows), `IT-LCV-12`
(replay from `lastEventId`; no foreign frame; the run stream admits the owner and
refuses another member). **Log**: `debug` stream open/close `{conversationId,
lastEventId}`.

**T2.13 [ ] — Admin enablement and readiness.** `PATCH /api/admin/platform/librarian`
+ a Librarian card on the ACP runners settings screen (enable toggle, runner select
limited to ready read-only-capable runners, readiness line). Disable = stop admission;
running turn finishes or hits its deadline; nothing deleted. `librarian_runner_id` is
`ON DELETE SET NULL`; the settings round trip is tested SET → CLEAR (runner removed or
unset → column NULL, readiness "not configured") → re-SET. *RED*: `IT-LCV-11` part 2
(disable during a queued backlog: queued stay queued and visible, no admission; the
SET/CLEAR/re-SET round trip); component test for the card's disabled reasons. EN/RU
strings. **Log**: `info` `{enabled, runnerId, actorUserId}`.

**T2.14 [ ] — Mock librarian adapter + round-trip test.**
`supervisor/test/fixtures/mock-acp-librarian.mjs`: reads a scripted plan from the
prompt (a fenced JSON block), calls the attached `maister` stdio MCP server's tools,
then replies. Integration test drives: owner message → admission → real supervisor →
mock adapter → real facade → ext route with the turn token → reply stored → run parked.
*RED*: `web/lib/librarian/__tests__/round-trip.integration.test.ts` `IT-LCV-04`
(end-to-end) fails before T2.10 wiring is complete. **Log**: fixture logs to stderr only.

**T2.15 [ ] — Panel shell UI.** `web/components/librarian/` — `librarian-trigger.tsx`
(top-nav entry, indicator), `librarian-panel.tsx` (docked/sheet/full-screen, mounted in
`web/app/(app)/layout.tsx`), message list on `TranscriptView`
(`components/run-transcript/transcript-view.tsx:414`), live tokens via `useRunStream`
on the active turn's run, composer (Send, Stop response, queued chips with Withdraw,
draft persisted per user in `localStorage` with try/catch), subject chip,
jump-to-latest, focus management reusing `useModalFocusTrap` in modal modes, no key
binding. Wire `top-nav.tsx` right group. i18n namespace `librarian`. *RED*:
`web/components/librarian/__tests__/panel.test.tsx` `UT-LUI-01`, `UT-LUI-06`,
`UT-LUI-07`, `UT-LUI-08`; `web/e2e/librarian-panel.spec.ts` `E2E-LUI-01/02/03/05/09`
(added to `AUTHED_SPEC`). **Log**: client — none.

**T2.16 [ ] — Deployment wiring.** D17's pool, deadline, context, daily-cap and
reconcile-window vars in `.env.example`, compose files, `docs/configuration.md`; read
through the existing env loader with validation (positive integers, refuse boot on
garbage with `CONFIG`). *RED*: `web/lib/librarian/__tests__/config.test.ts`
`UT-LCV-10` part (invalid value → `CONFIG`). **Log**: `info` resolved config at boot
(numbers only).

> **Checkpoint 3** — `feat(librarian): durable personal conversation on a project-less librarian run with MCP-only sessions`

### Phase 3 — Operations and the work cycle · `LOP-01..10`, `TST-01..05`, `TST-07..08`, `LAU-08`, `LUI-10`

**T3.1 [ ] — Migrations 0184 + 0185.** Appendix A/0184 (`tasks`) and A/0185
(operations, cards, statement revisions, links, `task_comments.via_operation_id`,
`agent_turns` user source + trigger, `task_activity` kind `statement_accepted`).
*RED*: `IT-TST-01` (UPDATE on a statement revision refused by the trigger),
`IT-LOP-02` part 1 (duplicate key refused by `librarian_operations_key_uq`).

**T3.2 [ ] — Idempotency in `handleExt`.** `idempotency: "required"` option; librarian
arm: header, digest, upsert `admitted`, LOP-02 refusals, reconcile-by-lookup for
`admitted`, admission gate (LOP-03); `recordRequiredTokenAudit` finalize (`operation?:
{id, result}`). Files: `web/lib/tokens/ext-handler.ts`, `web/lib/librarian/operations.ts`.
*RED*: `web/lib/librarian/__tests__/operations.integration.test.ts` `IT-LOP-01`
(effect and finalize atomic: inject a failure after the domain write → neither
persists), `IT-LOP-02` (same key/same body → same result, no second row; same
key/other body → `idempotency_payload_mismatch`; new key/same digest →
`duplicate_of_operation`), `IT-LOP-03` (crash-window table rows 1 and 4). **Log**:
`info` settle `{operationId, kind, status}`; `warn` conflicts.

**T3.3 [ ] — Task revision.** `updateTask` under `FOR UPDATE` with `expectedRevision`;
`TaskDTO.revision`; UI PATCH and ext PATCH accept it and return it. Existing tests to
migrate: `app/api/v1/ext/projects/[slug]/tasks/[taskId]/__tests__/route.integration.test.ts:314-317,359`
(gains a `revision` assertion), `app/api/projects/[slug]/tasks/[number]/__tests__/route.test.ts:105`
(`updateTask` call arguments gain the option). *RED*:
`web/lib/services/__tests__/task-revision.integration.test.ts` `IT-TST-02` (two
concurrent PATCHes with the same `expectedRevision` → one `stale_revision`
`CONFLICT`; the racer is parked on the row lock). **Log**: `debug` `{taskId, from,
to}`; `warn` stale.

**T3.4 [ ] — Statements and task create/update via the librarian.**
`web/lib/tasks/statement.ts` (zod schema, `renderStatementPrompt`, `acceptStatement`
through the Backlog gate); ext `POST …/tasks` gains `statement` (renders prompt,
revision 1, link `created_from`, `launch_intent='none'` for librarian tokens); `POST
…/tasks/{taskId}/statement {statement, expectedRevision}`; MCP `task_create`
(statement), `task_statement_accept`. Create sets `flowId` when the project has exactly
one launchable flow or the owner named one; otherwise the receipt shows the task's
launchability (`unconfigured`) and the next step (triage or pick a flow), so no task is
reported as launchable when it is not. *RED*: `UT-TST-03` (byte-identical render for
equal input; section order fixed), `IT-TST-04` (links with meaning and message range),
`IT-TST-07` (accept on an `InFlight` task → `PRECONDITION` naming the seam —
`EDGE-TST-01`; `tasks.prompt` unchanged), `IT-LOP-05` part 1 (librarian create →
intent `none`). **Log**: `info` `{taskId, revision, operationId}`.

**T3.5 [ ] — Launch intent and send-to-triage.** `applyTriageVerdict` and C2 honour
`launch_intent`; ext `send-to-triage` + MCP `task_send_to_triage`. *RED*:
`web/lib/services/__tests__/launch-intent.integration.test.ts` `IT-LOP-05` (triager
`enqueue:true` under `none` → `launch_mode` stays NULL and `runSchedulerTick` C2 admits
nothing — `EDGE-LOP-04`), `IT-LOP-06` + the D8 interaction table as a parameterized
test. **Log**: `debug` `{taskId, intent, enqueue, armed}`.

**T3.6 [ ] — Comments, relations, excerpts.** Operation-wrapped `comment_create` /
`relation_add|remove` for librarian tokens; `task_publish_excerpt` tool = explicit
comment with a quoted excerpt and a `mentioned` link; no transcript link is rendered to
other users. *RED*: `IT-TST-05` (another member sees the excerpt comment and cannot
load any `/api/librarian/*` resource for it), `IT-LAU-08` part 1 (comment shows owner
+ "via Librarian"). **Log**: `info` `{taskId, commentId, operationId}`.

**T3.7 [ ] — Launch and existing-work actions.** Admit librarian tokens on
`run_launch`, `run_cancel`, `run_recover`, `run_rework`, `run_sync`, `run_reopen`
(live RBAC per D4); `runs.librarian_operation_id` written in `launchRun`'s insert tx;
receipts per item. *RED*: `IT-LOP-07` (launch returns `Pending` with queue position
when the pool is full — `EDGE-LOP-03`), `IT-LOP-04` (batch: item 2 refused by a
dependency, item 1 kept and linked, retry re-issues item 2 only — `EDGE-LOP-02`),
`IT-LOP-03` part 2 (launch crash window row 3/4). **Log**: `info` `{runId, status,
operationId}`.

**T3.8 [ ] — Operator message seam.** D10b route + MCP `run_operator_message`;
`agent_turns.source='user'` path in `sendAgentMessage`. *RED*: `IT-LOP-10` (scratch →
delivered or queued; persistent agent → queued with `source='user'`; flow →
`refused_requires_rework`; token lacking ownership → 404). **Log**: `info` `{runId,
runKind, outcome}`.

**T3.9 [ ] — Cards and human-only actions.** Ext `POST /ext/librarian/cards` + MCP
`librarian_card_propose`; session `POST /api/librarian/cards/{id}/decide` executing
through existing services as `HitlActor{kind:"user"}` (human HITL answer), `promoteRun`
with expected head SHA, discard. *RED*:
`web/lib/librarian/__tests__/cards.integration.test.ts` `IT-LOP-08` (task revision
bumped after card creation → decide refused `target_changed`), `IT-LOP-09` (the card
click succeeds; the HITL row's responder is the user with no `via`; a budget-breach
restart card works through the session path), `IT-LAU-08` part 2. **Log**: `info`
`{cardId, kind, decision}`; `warn` drift.

**T3.10 [ ] — Cards and receipts UI.** Statement card (diff against current revision),
proposal/confirmation cards, batch receipt, task chips, Needs attention / Related work
region, all fed by one batched live read `web/lib/librarian/read-models.ts`
(`getLinkedWork(ownerId)`). EN/RU. *RED*: `IT-TST-08` (receipts show live status after
the run changes; foreign task in a stale link renders unavailable), `IT-LUI-10`,
component tests for card states. **Log**: `debug` read-model row counts.

> **Checkpoint 4** — `feat(librarian): operation ledger, statements, triage intent, launch and confirmation cards`

### Phase 4 — Clarification before execution · `CLR-01..10`

**T4.1 [ ] — Migration 0186.** Appendix A/0186: `task_clarifications` widening with
backfill `origin_kind='agent_run'`, `retrigger_mode` CHECK + `none`, the origin-shape
CHECK; `TASK_ACTIVITY_EVENT_KINDS` + `task_activity_event_kind_check`;
`inbox_items_event_kind_check` + `InboxSourceRef`; `domain_events_kind_check`
re-derived (15 + 2) fixing `schema.ts:7759`; `ATTENTION_EVENT_KINDS`. Nullable
fan-out: every reader of `origin_run_id`/`origin_agent_id`/`source_hitl_request_id`
listed and branched. *RED*: `IT-CLR-01` (user-origin row with a run id, or agent-origin
row without one, refused; `retrigger_mode='none'` accepted only for user origin).

**T4.2 [ ] — Services and routes.** `web/lib/tasks/clarification-requests.ts`:
`requestClarification` (operation-wrapped, recipient `member` check, inbox item,
subscription, event), `answerClarification` (human only, row lock, status CAS),
`cancelClarification`, `supersede`. Ext `POST …/clarifications`, `DELETE …/{id}`; MCP
`clarification_request`, `clarification_cancel`; session answer route + ext twin.
*RED*: `IT-CLR-02` (viewer recipient refused at creation; recipient demoted before
answering refused — `EDGE-CLR-01`), `IT-CLR-04` (second answer → `CONFLICT` —
`EDGE-CLR-02`; correction creates a superseding row), `IT-CLR-07` (answer leaves
statement, revision and launch state unchanged), `IT-CLR-09` (librarian and agent
tokens refused; global personal token without exact `hitl:respond:human` refused).
**Log**: `info` `{clarificationId, taskId, status}` — never question or answer text.

**T4.3 [ ] — Launchability and work-stage fan-out.** `clarification_pending` in
`TaskLaunchability` + precedence; every consumer in D10's verified list including the
`decideFire` explicit arm and the two hand-mirrored board classifiers with a parity
test; `deriveWorkStage` input `openBlockingClarificationCount` + attribute
`clarificationPending`; both callers batch the count. Existing tests to migrate:
`lib/runs/__tests__/launchability.test.ts` (precedence table),
`lib/run-schedules/__tests__/dispatch-decision.test.ts`,
`app/api/runs/launch-options/__tests__/route.test.ts`, `lib/work/__tests__/stage.test.ts`
(`UT-STG-01` totality over the new input). *RED*: `IT-CLR-05` (blocking open
clarification → launch `PRECONDITION` with classification, C2 skips, `decideFire`
refuses, `/work` row carries `clarificationPending`; non-blocking → launchable).
**Log**: `debug` classification.

**T4.4 [ ] — Decisions and inbox.** Fifth source in `computeDecisionsQueue`, the
`clarification` kind fan-out (D10 list), attention stream `changed[]`,
`ATTENTION_EVENT_KINDS`. Existing tests to migrate: `IT-ATN-01` fixtures (count
equals list with the new population), `IT-ATN-02` (the answered event's twin is not
double-counted). *RED*: `IT-CLR-03` (recipient's count and list both include it; the
requester's do not; ext decisions row carries `next_action`). **Log**: `debug`
population counts.

**T4.5 [ ] — Cascades and return path.** Cancel on recipient deactivation (users
service), task abandonment (task status path), owner cancel; requester access check
before delivery (D11 consumer handles delivery; this task emits the events). *RED*:
`IT-CLR-08` (each cause → `cancelled` with reason + event), `IT-CLR-06` (requester
removed from project → answer visible on task, not delivered to conversation).
**Log**: `info` `{clarificationId, cause}`.

**T4.6 [ ] — Prompt folding.** `composeEffectivePrompt` includes answered user-origin
rows with attribution; `lib/queries/task-clarifications.ts` selects the new columns.
*RED*: `IT-CLR-10`. **Log**: none.

**T4.7 [ ] — UI (`CLR-03`, `CLR-06`).** Task detail clarifications section
(open/answered/cancelled, answer form for the recipient, cancel for the requester),
inbox card, librarian clarification card. EN/RU. *RED*: component tests;
`web/e2e/task-clarification.spec.ts` covering request → inbox → answer (added to
`AUTHED_SPEC`). **Log**: none.

> **Checkpoint 5** — `feat(tasks): addressed clarification before execution with launch hold`

### Phase 5 — Follow-up delivery · `LOP-11..12`, `LAU-05`, `LUI-01`

**T5.1 [ ] — Migration 0187.** Appendix A/0187 `librarian_updates`. *RED*: `IT-LOP-11`
part 1 (duplicate `(conversation_id, domain_event_id)` refused).

**T5.2 [ ] — `librarian_followup` consumer.** `web/lib/librarian/followup.ts`
registered in `DOMAIN_EVENT_CONSUMERS`; follow set = links ∪ succeeded operations;
access check; deterministic card payload (stage via `deriveWorkStage`, "deployment
unknown" after merge). *RED*: `IT-LOP-11` (one event dispatched twice → one card; lost
access → `skipped_no_access`), `IT-LOP-12` (forced failure 5× → `failed` with error
code; cursor advanced; no duplicate business effect). Wiring test through
`dispatchDomainEvents`. **Log**: `info` delivered `{conversationId, eventId, kind}`;
`warn` skipped/failed.

**T5.3 [ ] — Update cards, Explain, indicator.** Update card component; `POST
/api/librarian/updates/{id}/explain` enqueues an `explain` turn with read scopes;
indicator `unread` from `read_through_seq`, `action_required` from pending owner
cards. *RED*: `IT-LAU-05` part 2 (Explain turn's token cannot create a task even if the
update text instructs it), `UT-LUI-01` part 2 (indicator states). **Log**: `info`
`{updateId, turnId}`.

> **Checkpoint 6** — `feat(librarian): deduplicated follow-up updates with on-demand explanation`

### Phase 6 — Memory, summaries, reset, forget, history · `LMM-01..12`, `TST-06`

**T6.1 [ ] — Migration 0188.** Appendix A/0188. *RED*: `IT-LMM-02` part 1 (edit creates
a revision row; `librarian_memory_items` UPDATE of `content` refused by trigger).

**T6.2 [ ] — Memory service, tools, UI.** `web/lib/librarian/memory.ts`; ext `POST
/ext/librarian/memory` (owner-message turns only) and suggestion cards; session memory
routes; Memory dialog (list, edit, forget, "use memory in next segment" toggle, "used
in this reply" chips). ESLint fence: `web/lib/librarian/**` may not import
`lib/brain/**` or `lib/agents/memory-store`. *RED*: `IT-LMM-01` (explain-turn token
refused; suggestion only persists on accept), `IT-LMM-02`, `IT-LMM-11` (fence + no
Brain/agent-memory row after a remember), `IT-LMM-12`. **Log**: `info` `{itemId,
action}` — never content.

**T6.3 [ ] — Summary turns.** `summary` variant: no server attached, no token, D5's
summary profile; output validated against the summary schema; CAS write per D12.
*RED*: `IT-LMM-07` (reset between summary start and write → nothing written —
`EDGE-LMM-01`; forget between → nothing written), `EDGE-LAU-04` (a summary adapter
emitting a tool call → turn `failed`). **Log**: `info` `{segmentId, revision, fromSeq,
toSeq}`; `warn` fenced.

**T6.4 [ ] — Retrieval and masking.** Composer consumes memory + summaries with
visibility re-check; message render masks by `source_project_ids`. *RED*: `IT-LMM-03`
(mixed summary with a revoked source dropped and rebuild queued), `IT-LMM-09` (the
owner's own messages still render; librarian message sourced from a revoked project
renders the unavailable marker), `IT-LMM-04` (pre-reset messages absent from the
snapshot). **Log**: `debug` `{dropped, masked}` counts.

**T6.5 [ ] — Reset barrier.** `web/lib/librarian/reset.ts` + route + `system_sweep`
backstop + UI progress state. *RED*: `IT-LMM-05` (admitted operation of the old segment
→ reset stays `resetting` until it settles; queued message withdrawn; pending card
`cleared_by_reset`; epoch bumped), reset-vs-admission two-racer (D15). **Log**: `info`
`{conversationId, phase}`.

**T6.6 [ ] — Forget.** Tombstone + epoch bump; suggestion and summary writers consult
tombstones. *RED*: `IT-LMM-06` (forgotten fact not re-suggested from an older summary;
explicit re-remember creates a new item; `EDGE-LMM-02`). **Log**: `info` `{itemId}`.

**T6.7 [ ] — History search tool.** Ext route + MCP `librarian_history_search`;
labelled results. *RED*: `IT-LMM-04` part 2 (older segment hit returned with label;
masked messages excluded). **Log**: `debug` `{hits}`.

**T6.8 [ ] — Clear history.** Preview + clear per D14; host workspace release and the
transcript purge decided in T0.9; the next turn re-adopts. *RED*: `IT-LMM-08` (all
personal rows gone; operations and audit kept with nulled refs; subsequent turn uses
`session/new` and a fresh adoption), `IT-TST-06` (tasks, statements, excerpts intact;
source link renders unavailable — `EDGE-TST-02`). **Log**: `info` counts per table.

**T6.9 [ ] — Retention pass + wiring.** `system_sweep` pass with keyset cursor; env
vars for retention and TTL in `.env.example`, compose files, `docs/configuration.md`.
*RED*: `IT-LMM-10` via `runSchedulerTick` (old messages and snapshots purged, newer
kept; progress across batches). **Log**: `info` batch totals.

> **Checkpoint 7** — `feat(librarian): personal memory, fenced summaries, reset barrier, forget and history deletion`

### Phase 7 — Qualification, documentation, reconciliation

**T7.1 [ ] — Acceptance E2E `L-01..L-12`.** `web/e2e/librarian-*.spec.ts` on the mock
librarian adapter (all added to `AUTHED_SPEC`), one spec per scenario or a small group;
L-04 and L-07 include web and supervisor restarts; L-05 and L-06 run with seeded
viewer/unrelated-member/admin users; mobile viewport 390 px for L-01.

**T7.2 [ ] — Live-adapter qualification.** `scripts/qualify-librarian.mjs` + an
evidence record under `docs/spikes/2026-…-librarian-qualification.md`: claude and codex
runners, representative PO scenarios (L-01, L-02 with a real duplicate, L-03, L-04,
L-08 with an injected instruction in a teammate answer, L-12), plus the D5 L1/L2
built-in denial check. Records runner, model, package/engine provenance and outcome
per scenario; no private bodies. Not in CI. **Parity**: the scenario table is the same
one T7.1 runs against the mock adapter, so fake and real peers are compared on one
table.

**T7.3 [ ] — Operator and user documentation.** EN: how the librarian works, admin
enablement, budgets, retention, what reset/forget/clear do. RU: the user manual
section (ADR-158) under `docs/ru/`. Update `README.md` "What MAIster does" only if the
owner wants the librarian listed.

**T7.4 [ ] — Adversarial review.** One refute-the-design pass over authority (token
scope, live RBAC, visibility), intent (teammate text, retrieved text, Explain turns),
idempotency and the reset barrier; each finding fixed or recorded in the ADR with a
reason. Repeat after each fix cycle.

**T7.5 [ ] — As-built reconciliation.** Flip `(Designed)` → `(Implemented)` only for
pieces with executed tests; traceability `Status` → `Implemented`; ROADMAP via
`/aif-roadmap`; `CLAUDE.md`/`web/CLAUDE.md` one-line mentions where the root file
lists shipped domains.

**T7.6 [ ] — Release gate.** Full unit/integration suites, supervisor and mcp suites,
`pnpm validate:docs`, `pnpm validate:contracts`, coverage gate, Playwright librarian
specs, lint and typecheck green; qualification record complete.

> **Checkpoint 8** — `test(librarian): L-01..L-12 acceptance, live-adapter qualification and docs`

---

## Commit Plan

| Commit | After | Message |
| --- | --- | --- |
| 0 | planning | `docs(pv): add personal librarian brief; plan the first release` |
| 1 | T0.2–T0.17 | `docs(librarian): specify runtime, authority, operations, statements, clarifications, memory and surface (ADR-183..189)` |
| 2 | T1.1–T1.6 | `feat(librarian): delegated per-turn authority and visibility-scoped read surface` |
| 3 | T2.1–T2.16 | `feat(librarian): durable personal conversation on a project-less librarian run with MCP-only sessions` |
| 4 | T3.1–T3.10 | `feat(librarian): operation ledger, statements, triage intent, launch and confirmation cards` |
| 5 | T4.1–T4.7 | `feat(tasks): addressed clarification before execution with launch hold` |
| 6 | T5.1–T5.3 | `feat(librarian): deduplicated follow-up updates with on-demand explanation` |
| 7 | T6.1–T6.9 | `feat(librarian): personal memory, fenced summaries, reset barrier, forget and history deletion` |
| 8 | T7.1–T7.6 | `test(librarian): L-01..L-12 acceptance, live-adapter qualification and docs` |

Phases 2 and 3 are large; split a commit at a green sub-checkpoint when useful, never
with a red suite.

## Risks and open items

- **Live adapter tool routing (D5)**: if an adapter runs built-in tools without a
  permission request, L1 never sees them. L2 settings are the mitigation; T7.2 is the
  proof. An adapter that fails it is not selectable as the librarian runner.
- **Transcript purge (D14)**: unknown until the T0.9 spike. The plan refuses to claim a
  purge it cannot perform.
- **Reserved slug adoption (D2)**: the supervisor validates paths against roots, not
  slugs, at `3c02c739`; T0.4 re-verifies `workspace-registry.ts` before the ADR is final.
- **Model behaviour**: intent classification, duplicate checks and operation-key reuse
  are instruction-driven. Server guards (read-only Explain turns, duplicate-digest
  refusal, cards for human-only actions, live RBAC, the Backlog gate) bound the damage;
  T7.2 measures the behaviour. Deterministic tests alone do not prove usefulness (brief
  §10).
- **Roadmap text conflict**: M51's non-goals exclude PO intake until T0.16 lands.
- **Scale of fan-out**: `run_kind`, `TaskLaunchability`, `task_clarifications`
  nullability, the decisions queue and the activity/inbox kind CHECKs each touch many
  consumers; T2.3, T4.1, T4.3 and T4.4 list every file they change.
- **Cost**: each fresh-context turn pays full prompt cost; the epoch rule resumes when
  safe. Budgets (D17) are finite and owner-confirmed.

---

## Appendix A — Migration DDL (normative for T0.13 and the migration tasks)

Types: `text` ids (`randomUUID` default, repo convention), `timestamptz` for times,
`jsonb` for structured payloads. Constraint names are the ones the traceability rows
and tests cite.

**0181 `librarian_token_kind`** — `project_tokens`: `token_kind` enum + `'librarian'`;
`librarian_turn_id text NULL`; `ADD CONSTRAINT project_tokens_kind_check CHECK
(token_kind IN ('project','user','agent','librarian'))`; `ADD CONSTRAINT
project_tokens_librarian_check CHECK (token_kind <> 'librarian' OR (owner_user_id IS
NOT NULL AND project_id IS NULL AND agent_id IS NULL AND librarian_turn_id IS NOT NULL
AND expires_at IS NOT NULL))`; index `project_tokens_librarian_turn_idx
(librarian_turn_id)`. `token_audit_log`: `on_behalf_of_user_id text NULL REFERENCES
users ON DELETE SET NULL`, `librarian_turn_id text NULL`, `operation_id text NULL`;
index `token_audit_librarian_turn_idx`. Existing `project_tokens_agent_kind_check`
(`(token_kind='agent') = (agent_id IS NOT NULL)`) already holds for the new kind.

**0182 `librarian_conversations`** —
- `librarian_conversations(id PK, user_id NOT NULL REFERENCES users ON DELETE CASCADE,
  run_id text NULL REFERENCES runs ON DELETE SET NULL, context_epoch integer NOT NULL
  DEFAULT 0, forget_generation integer NOT NULL DEFAULT 0, history_generation integer
  NOT NULL DEFAULT 0, current_segment_id text NULL, reset_state text NOT NULL DEFAULT
  'none' CHECK (reset_state IN ('none','resetting')), subject jsonb NULL,
  read_through_seq bigint NOT NULL DEFAULT 0, memory_enabled_next_segment boolean NOT
  NULL DEFAULT true, daily_turn_date date NULL, daily_turn_count integer NOT NULL
  DEFAULT 0, created_at, updated_at)`; UNIQUE `librarian_conversations_user_uq
  (user_id)`; UNIQUE `librarian_conversations_run_uq (run_id)`.
- `librarian_segments(id PK, conversation_id NOT NULL REFERENCES … ON DELETE CASCADE,
  ordinal integer NOT NULL, started_at NOT NULL, ended_at NULL)`; UNIQUE
  `librarian_segments_ordinal_uq (conversation_id, ordinal)`.
- `librarian_messages(id PK, conversation_id NOT NULL … CASCADE, segment_id NOT NULL
  REFERENCES librarian_segments, seq bigint NOT NULL, author_kind text NOT NULL CHECK
  (author_kind IN ('owner','librarian','update','system')), client_message_id text
  NULL, body text NOT NULL, body_tsv tsvector GENERATED ALWAYS AS
  (to_tsvector('simple', body)) STORED, subject jsonb NULL, delivery_state text NOT
  NULL DEFAULT 'accepted' CHECK (delivery_state IN
  ('accepted','queued','withdrawn','withdrawn_by_reset','processed')), turn_id text
  NULL, source_project_ids text[] NOT NULL DEFAULT '{}', card_id text NULL, update_id
  text NULL, created_at)`; UNIQUE `librarian_messages_seq_uq (conversation_id, seq)`;
  partial UNIQUE `librarian_messages_client_id_uq (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL`; GIN `librarian_messages_body_tsv_idx`.
- `librarian_turns(id PK, conversation_id NOT NULL … CASCADE, segment_id NOT NULL,
  message_id text NULL REFERENCES librarian_messages ON DELETE SET NULL, variant text
  NOT NULL CHECK (variant IN ('owner_message','explain','summary')), status text NOT
  NULL CHECK (status IN ('queued','admitted','running','completed','stopped','failed')),
  failure_reason text NULL, context_snapshot_id text NULL, runner_snapshot jsonb NULL,
  token_id text NULL, deadline_at NULL, admitted_at, started_at, ended_at, created_at)`;
  partial UNIQUE `librarian_turns_one_active_uq (conversation_id) WHERE status IN
  ('admitted','running')`; CHECK `librarian_turns_running_has_snapshot_check (status
  <> 'running' OR context_snapshot_id IS NOT NULL)`; CHECK
  `librarian_turns_failed_has_reason_check (status <> 'failed' OR failure_reason IS NOT
  NULL)`.
- `librarian_context_snapshots(id PK, turn_id NOT NULL REFERENCES librarian_turns ON
  DELETE CASCADE, instructions_version text NOT NULL, message_ids text[] NOT NULL,
  summary_revisions jsonb NOT NULL, memory_item_revisions jsonb NOT NULL,
  authz_fingerprint text NOT NULL, context_epoch integer NOT NULL, char_count integer
  NOT NULL, truncated boolean NOT NULL, created_at)`.
- `platform_runtime_settings`: `librarian_enabled boolean NOT NULL DEFAULT false`,
  `librarian_runner_id text NULL REFERENCES platform_acp_runners ON DELETE SET NULL`.
- `project_tokens`: `ADD CONSTRAINT project_tokens_librarian_turn_fk FOREIGN KEY
  (librarian_turn_id) REFERENCES librarian_turns ON DELETE CASCADE`.

**0183 `librarian_run_kind`** — `runs`: `ADD CONSTRAINT runs_run_kind_check CHECK
(run_kind IN ('flow','scratch','agent','librarian'))`; `ADD CONSTRAINT
runs_librarian_shape_check CHECK (run_kind <> 'librarian' OR (project_id IS NULL AND
task_id IS NULL AND persistent = true AND created_by_user_id IS NOT NULL AND
agent_workspace = 'none'))`; `librarian_operation_id text NULL`, UNIQUE
`runs_librarian_operation_uq`. `run_sessions`: `librarian_context_epoch integer NULL`.
`execution_commands`: `owner_kind` enum + `'librarian_turn'`;
`execution_commands_owner_shape_check` re-derived from `PROMPT_OWNER_SHAPES` (new
variants with keys `{turnId, promptOrdinal}`); `create_intent` CHECK re-derived with
variant `'librarian'` and prefix `'librarian-create:'`. `execution_assignments`:
placement reason CHECK regenerated with `'librarian_turn'`.

**0184 `task_revision_launch_intent`** — `tasks`: `revision integer NOT NULL DEFAULT
0`, `statement_revision integer NULL`, `launch_intent text NULL CHECK (launch_intent
IN ('none','triage_only','triage_then_launch'))`, `created_via_operation_id text NULL`
UNIQUE `tasks_created_via_operation_uq`.

**0185 `librarian_operations`** —
- `librarian_operations(id PK, conversation_id NOT NULL … CASCADE, segment_id NOT
  NULL, turn_id text NULL, card_id text NULL, idempotency_key text NOT NULL, kind text
  NOT NULL, request_digest text NOT NULL, target jsonb NOT NULL, status text NOT NULL
  CHECK (status IN ('admitted','succeeded','refused','failed','unknown')), result jsonb
  NULL, error_code text NULL, created_at, settled_at)`; UNIQUE
  `librarian_operations_key_uq (conversation_id, idempotency_key)`; index
  `librarian_operations_segment_digest_idx (segment_id, request_digest)`; CHECK
  `librarian_operations_terminal_shape_check (status NOT IN ('refused','failed') OR
  error_code IS NOT NULL)`.
- `librarian_cards(id PK, conversation_id NOT NULL … CASCADE, segment_id NOT NULL,
  message_id text NULL … SET NULL, kind text NOT NULL CHECK (kind IN
  ('statement_proposal','confirmation','memory_suggestion')), status text NOT NULL
  CHECK (status IN
  ('pending','accepted','rejected','expired','superseded','cleared_by_reset')), target
  jsonb NOT NULL, target_revision text NULL, payload jsonb NOT NULL, payload_digest text
  NOT NULL, requires_owner boolean NOT NULL, expires_at NOT NULL, decided_at NULL,
  created_at)`; index `librarian_cards_pending_idx (conversation_id) WHERE status =
  'pending'`.
- `task_statement_revisions(task_id NOT NULL REFERENCES tasks ON DELETE CASCADE,
  revision integer NOT NULL, statement jsonb NOT NULL, author_actor_type text NOT NULL,
  author_actor_id text NULL, via_operation_id text NULL, created_at)`; PK `(task_id,
  revision)`; trigger `task_statement_revisions_immutable` raising on UPDATE/DELETE.
- `librarian_task_links(id PK, conversation_id NOT NULL … CASCADE, task_id NOT NULL
  REFERENCES tasks ON DELETE CASCADE, meaning text NOT NULL CHECK (meaning IN
  ('created_from','refined_in','mentioned')), from_message_id text NULL … SET NULL,
  to_message_id text NULL … SET NULL, statement_revision integer NULL, created_at)`;
  index `librarian_task_links_task_idx (task_id)`.
- `task_comments`: `via_operation_id text NULL` UNIQUE `task_comments_via_operation_uq`.
- `agent_turns`: `source` enum + `'user'`, `requested_by_user_id text NULL REFERENCES
  users ON DELETE SET NULL`; trigger `guard_agent_turn_source` re-derived (a `user`
  source requires `requested_by_user_id`).
- `task_activity_event_kind_check` + `'statement_accepted'`.

**0186 `task_clarifications_user_origin`** — `task_clarifications`: `origin_kind text
NOT NULL DEFAULT 'agent_run' CHECK (origin_kind IN ('agent_run','user'))` (backfilled
by the default, then the default dropped); `source_hitl_request_id`, `origin_run_id`,
`origin_agent_id`, `question_schema` → NULL-able; `retrigger_mode` CHECK + `'none'`;
new `requester_user_id text NULL`, `recipient_user_id text NULL`, `reason text NULL`,
`answer_format text NULL CHECK (answer_format IN ('text','choice','yes_no'))`,
`blocking boolean NOT NULL DEFAULT false`, `status text NOT NULL DEFAULT 'open' CHECK
(status IN ('open','answered','cancelled','superseded'))` (backfill: `answered` where
`answered_at IS NOT NULL`, `superseded` where `superseded_at IS NOT NULL`), `cancel_reason
text NULL`, `superseded_by_clarification_id text NULL`, `source_message_id text NULL
REFERENCES librarian_messages ON DELETE SET NULL`, `requested_via_operation_id text
NULL` UNIQUE; `ADD CONSTRAINT task_clarifications_origin_shape_check CHECK ((origin_kind
= 'agent_run' AND source_hitl_request_id IS NOT NULL AND origin_run_id IS NOT NULL AND
origin_agent_id IS NOT NULL AND question_schema IS NOT NULL AND retrigger_mode <> 'none')
OR (origin_kind = 'user' AND source_hitl_request_id IS NULL AND origin_run_id IS NULL
AND origin_agent_id IS NULL AND requester_user_id IS NOT NULL AND recipient_user_id IS
NOT NULL AND retrigger_mode = 'none'))`; `task_clarifications_supersession_check`
re-derived to admit `superseded_by_clarification_id`; `ADD CONSTRAINT
task_clarifications_status_shape_check CHECK ((status = 'answered') = (answered_at IS
NOT NULL) AND (status <> 'cancelled' OR cancel_reason IS NOT NULL))`. `task_activity`
kinds + `clarification_requested | clarification_answered | clarification_cancelled`;
`inbox_items_event_kind_check` + `clarification_requested`; `domain_events_kind_check`
re-derived = 0167's 15 + `task.clarification_requested`, `task.clarification_cancelled`.

**0187 `librarian_updates`** — `librarian_updates(id PK, conversation_id NOT NULL …
CASCADE, domain_event_id text NOT NULL REFERENCES domain_events, task_id text NULL,
run_id text NULL, kind text NOT NULL, status text NOT NULL CHECK (status IN
('pending','delivered','skipped_no_access','failed')), attempts integer NOT NULL DEFAULT
0 CHECK (attempts >= 0), message_id text NULL … SET NULL, last_error_code text NULL,
created_at, delivered_at NULL)`; UNIQUE `librarian_updates_event_uq (conversation_id,
domain_event_id)`; CHECK `librarian_updates_failed_has_error_check`.

**0188 `librarian_memory`** —
- `librarian_memory_items(id PK, user_id NOT NULL … CASCADE, kind text NOT NULL CHECK
  (kind IN ('preference','goal','commitment','fact')), content text NOT NULL, scope
  text NOT NULL CHECK (scope IN ('general','project')), project_id text NULL REFERENCES
  projects ON DELETE CASCADE, source_refs jsonb NOT NULL DEFAULT '[]', source_project_ids
  text[] NOT NULL DEFAULT '{}', origin text NOT NULL CHECK (origin IN
  ('explicit','accepted_suggestion')), valid_until NULL, revision integer NOT NULL
  DEFAULT 1, forgotten_at NULL, created_at, updated_at)`; trigger
  `librarian_memory_items_content_immutable` (content changes go through revisions);
  index `librarian_memory_items_user_active_idx (user_id) WHERE forgotten_at IS NULL`.
- `librarian_memory_item_revisions(item_id NOT NULL … CASCADE, revision integer NOT
  NULL, content text NOT NULL, created_at)`; PK `(item_id, revision)`.
- `librarian_memory_tombstones(user_id NOT NULL … CASCADE, content_digest text NOT
  NULL, created_at)`; PK `(user_id, content_digest)`.
- `librarian_segment_summaries(id PK, segment_id NOT NULL REFERENCES librarian_segments
  ON DELETE CASCADE, revision integer NOT NULL, from_seq bigint NOT NULL, to_seq bigint
  NOT NULL, content jsonb NOT NULL, source_project_ids text[] NOT NULL DEFAULT '{}',
  forget_generation integer NOT NULL, history_generation integer NOT NULL,
  invalidated_at NULL, created_at)`; UNIQUE `librarian_segment_summaries_revision_uq
  (segment_id, revision)`.

## Appendix B — Route contracts (normative for T0.13)

Session routes (`web.openapi.yaml`; cookie session; owner = session user; errors map
`PRECONDITION|CONFLICT → 409`, `CONFIG → 422`, `BUDGET_EXCEEDED → 429`,
`EXECUTOR_UNAVAILABLE → 503`, `UNAUTHORIZED → 403`):

| Method · path | Body | 2xx | Notes |
| --- | --- | --- | --- |
| `GET /api/librarian/conversation` | — | 200 `{conversation, segment, indicator, pendingCards[], queuedMessages[], activeTurn?}` | creates the conversation on first call |
| `GET /api/librarian/messages?beforeSeq&limit≤100` | — | 200 `{messages[], hasMore}` | masked per LMM-09 |
| `POST /api/librarian/messages` | `{clientMessageId, body, subject?}` | 202 `{message, turn:{id,status,queuePosition?}}` | 200 with the stored message on dedup |
| `DELETE /api/librarian/messages/{id}` | — | 204 | only `queued`; else 409 |
| `POST /api/librarian/turns/current/stop` | — | 202 | no active turn → 409 |
| `POST /api/librarian/read-cursor` | `{seq}` | 204 | GREATEST |
| `POST /api/librarian/cards/{id}/decide` | `{decision:accept\|reject, expectedRevision?}` | 200 `{card, operation?}` | `target_changed` → 409 |
| `GET /api/librarian/memory` · `POST` · `PATCH /{id}` · `DELETE /{id}` | item fields | 200/201/200/204 | DELETE = forget |
| `POST /api/librarian/reset` | — | 202 `{resetState}` | barrier |
| `GET /api/librarian/history/clear-preview` | — | 200 `{counts, previewDigest}` | |
| `POST /api/librarian/history/clear` | `{previewDigest}` | 202 | stale digest → 409 |
| `POST /api/librarian/updates/{id}/explain` | — | 202 `{turn}` | read-only turn |
| `GET /api/librarian/stream` | `Last-Event-ID` | SSE | frames below |
| `PATCH /api/admin/platform/librarian` | `{enabled, runnerId?}` | 200 `{settings, readiness}` | admin |

Stream frames (`librarian-stream.asyncapi.yaml`): `librarian.message {id, seq,
messageId}` · `librarian.turn {id, seq, turnId, status, reason?}` ·
`librarian.indicator {id, seq, state}` · `librarian.reset {id, seq, resetState,
segmentId?}`; heartbeat every 15 s; `id` = monotonic `seq`.

Ext routes (`operations.openapi.yaml`; bearer; new security scheme
`librarianTurnToken`; every effectful route lists `Idempotency-Key` as a required header
for that scheme):

| Method · path | Scope | Notes |
| --- | --- | --- |
| `GET /ext/projects` | `projects:read` | visible projects |
| `GET /ext/projects/{slug}/directory` | `projects:read` | purpose, flows, runner, triager, brain, `asOf` |
| `GET /ext/tasks/search?q&cursor` | `tasks:read` | page 25, `truncated` |
| `GET /ext/work` · `GET /ext/activity/feed` · `GET /ext/decisions` | `work:read` · `activity:read` · `decisions:read` | librarian + personal tokens |
| `POST /ext/projects/{slug}/tasks` (+`statement`) · `PATCH …/{taskId}` (+`expectedRevision`) · `POST …/{taskId}/statement` | `tasks:create` · `tasks:update` | effectful |
| `POST …/{taskId}/send-to-triage {launchIntent}` | `tasks:triage` | effectful |
| `POST …/{taskId}/clarifications` · `DELETE …/clarifications/{id}` · `POST …/clarifications/{id}/answer` | `hitl:request` · `hitl:request` · exact `hitl:respond:human` (personal token only) | effectful |
| `POST /ext/runs/{runId}/operator-message` | `runs:message` | effectful; outcome enum |
| `POST /ext/librarian/cards` · `POST /ext/librarian/memory` · `GET /ext/librarian/history/search?q` | `librarian:cards` · `librarian:memory` · `librarian:history` | librarian token only |
| Existing routes admitting the kind | as today | `runs` POST, `runs/[runId]` GET + `activity`/`readiness`/`hitl`, `runs/{cancel,rework}`, `runs/[runId]/recover`, `runs/{sync,reopen}`, `activity`, tasks/comments/relations/triage/memory reads |

## Appendix C — MCP tools (normative for T1.6 / T2.7)

New: `project_list`, `project_get`, `task_search`, `work_list`, `decisions_list`,
`activity_feed`, `task_statement_accept`, `task_send_to_triage`,
`task_publish_excerpt`, `clarification_request`, `clarification_cancel`,
`run_operator_message`, `librarian_card_propose`, `librarian_memory_remember`,
`librarian_history_search`. Extended: `task_create` (+`statement`), `task_update`
(+`expectedRevision`), every effectful tool (+`operationKey` → `Idempotency-Key`).
`MAISTER_MCP_TOOLSET=librarian` = the new tools + `task_list`, `task_get`,
`task_create`, `task_update`, `flow_list`, `runner_list`, `memory_recall`,
`run_launch`, `run_get`, `run_activity`, `readiness_get`, `run_cancel`, `run_recover`,
`run_rework`, `run_sync`, `run_reopen`, `hitl_list`, `hitl_inbox`, `comment_list`,
`comment_create`, `relation_list`, `relation_add`, `relation_remove`. Excluded:
`hitl_respond`, `run_promote`, `run_discard`, `run_delegate`, `run_collect`,
`run_message`, `run_plan`, `ask_human`, `triage_set`, `gate_report`,
`agent_memory_write`, `evaluation_*`, `memory_propose`, `memory_retain`.

## Appendix D — State machines (normative for T0.11)

**Turn** `queued → admitted → running → completed | stopped | failed(reason)`;
`queued → withdrawn` (owner or reset); `admitted → failed(start_failed)`;
`running → failed(host_lost | deadline | capability_trip)`.

**Operation** `admitted → succeeded | refused | failed | unknown`; `unknown →
succeeded | failed` (reconcile only).

**Card** `pending → accepted | rejected | expired | superseded | cleared_by_reset`.

**Clarification** `open → answered | cancelled(reason) | superseded`; `answered →
superseded` (correction creates the successor first).

**Conversation reset** `none → resetting → none` (ack inserts the segment and bumps
`context_epoch`); every write of summaries/memory carries the generation fence.

**Run (librarian kind)** `Pending → Running ⇄ NeedsInputIdle`; never `NeedsInput`,
`HumanWorking`, `Review`, `Done`, `Abandoned`; `Crashed` never (the reconcile arm
parks instead).
