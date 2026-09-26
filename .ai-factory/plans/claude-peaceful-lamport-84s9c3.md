# Implementation Plan: Personal librarian (complete first release)

**Branch**: `claude/peaceful-lamport-84s9c3` (session-assigned; `/aif-plan` branch creation skipped)
**Created**: 2026-09-26 · **Base**: local `master` @ `3c02c739`
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
evidence came from three codebase sweeps (MCP identity and scopes; agent runtime and
execution host; tasks, triage, inbox and UI shell). Every file:line cited below was true
at `3c02c739`; each task re-verifies before editing.

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
pinned by a regression case). Every requirement names ≥ 1 task; every task in Phases
1–6 is named by ≥ 1 requirement. Phase 0 writes the specs and Phase 7 qualifies them, so
neither owns a row (M51 precedent).

### The requirements

**`LCV` — conversation and runtime** (12, at cap)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LCV-01 | Exactly one `librarian_conversations` row per user; no route or tool creates a second | UNIQUE `user_id` + `IT-LCV-01` |
| LCV-02 | An owner message is committed before any turn admission; a repeated `(conversation_id, client_message_id)` returns the stored message | partial UNIQUE + `IT-LCV-02` |
| LCV-03 | At most one turn per conversation is `admitted` or `running`; later messages queue in `seq` order and can be withdrawn only while `queued` | partial UNIQUE index + conversation row lock + `IT-LCV-03` |
| LCV-04 | A turn runs as `runs.run_kind='librarian'` with `project_id IS NULL`, `task_id IS NULL`, on a per-conversation directory workspace, and every prompt carries owner kind `librarian_turn` | CHECK + `execution_commands_prompt_owner_required` + `IT-LCV-04` |
| LCV-05 | A conversation holds a concurrency slot only while its run is `Running`; between turns the run is parked `NeedsInputIdle`; a full `MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS` pool queues, never refuses | `tryStartRun` pool arm + `IT-LCV-05` |
| LCV-06 | ACP `session/resume` is used only when the session's recorded `context_epoch` equals the conversation's current one; otherwise a fresh session starts from a composed context | composer guard + `IT-LCV-06` |
| LCV-07 | A context snapshot (message ids, summary and memory revisions, instructions version, authz fingerprint) commits before the turn's prompt command is queued | FK `librarian_turns.context_snapshot_id` NOT NULL on `running` (CHECK) + `IT-LCV-07` |
| LCV-08 | Stop cancels the turn's prompt and revokes its token; it never cancels a task run and never deletes an operation row | `IT-LCV-08` |
| LCV-09 | After a restart or adapter loss, a `running` turn with no live session resolves to `failed` with a reason through the reconcile arm; queued messages stay queued and admit afterwards | reconcile arm + `IT-LCV-09` |
| LCV-10 | Turn deadline, context character cap and per-user daily turn cap are finite; exhaustion refuses with `BUDGET_EXCEEDED` in a visible state, and the owner's latest message is never truncated away | `IT-LCV-10` |
| LCV-11 | With the librarian disabled or no ready runner, admission refuses (`CONFIG` / `EXECUTOR_UNAVAILABLE`); admitted operations still reconcile; nothing is deleted | `IT-LCV-11` |
| LCV-12 | `GET /api/librarian/stream` emits only the owner's conversation and replays from durable `seq` via `lastEventId` | `IT-LCV-12` |

Edge: `EDGE-LCV-01` two tabs submit one `client_message_id` concurrently · `EDGE-LCV-02`
message arrives while a turn runs · `EDGE-LCV-03` the configured runner is disabled
between turns · `EDGE-LCV-04` deadline expires during a tool call.

**`LAU` — authority** (11)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LAU-01 | The owner comes only from the authenticated session (`auth-context`); no librarian route or tool accepts a user id | route identifier table (D16) + `IT-LAU-01` |
| LAU-02 | Each turn gets a fresh `project_tokens` row `kind='librarian'`, `owner_user_id`=owner, `project_id` NULL, `librarian_turn_id` set, expiring at the turn deadline, revoked when the turn ends | CHECK + `IT-LAU-02` |
| LAU-03 | Every librarian-token request re-checks, at request time: owner active, no pending password change, live project role for the scope's action, scope ∈ `LIBRARIAN_TOKEN_SCOPES` | `handleExt` librarian arm + `IT-LAU-03` |
| LAU-04 | `LIBRARIAN_TOKEN_SCOPES` excludes `hitl:respond:human`, `runs:promote`, `runs:discard`, `runs:delegate`, token/settings/admin/package/flow-authoring scopes; `AGENT_TOKEN_SCOPES` is byte-identical to before | `UT-LAU-04` |
| LAU-05 | A follow-up (Explain) turn receives the read-only subset of `LIBRARIAN_TOKEN_SCOPES` | `IT-LAU-05` |
| LAU-06 | Every list, search and count admitted for librarian tokens filters by the owner's visible projects before aggregation; a foreign project answers exactly like a missing one | `IT-LAU-06` |
| LAU-07 | Every librarian-token request writes `token_audit_log` with `on_behalf_of_user_id`, `librarian_turn_id` and, for effects, `operation_id`; an audit failure fails the request | `IT-LAU-07` |
| LAU-08 | Effects made through the librarian record the owner as social actor plus `via_operation_id`; human-only answers and promotions execute only from an owner click in the session UI | `IT-LAU-08` |
| LAU-09 | No role, including global admin, can read another user's conversation, memory or snapshots through any route | `IT-LAU-09` |
| LAU-10 | Deactivation or loss of membership applies to the next request of an in-flight turn and to every queued turn at admission | `IT-LAU-10` |
| LAU-11 | The librarian session attaches only the `maister` MCP server; built-in read, search, fetch, execute and edit tools are denied at the supervisor seam (L1) and in materialized adapter settings (L2) | `IT-LAU-11` (supervisor) |

Edge: `EDGE-LAU-01` token replay after revocation · `EDGE-LAU-02` global admin opens the
panel (sees only their own conversation) · `EDGE-LAU-03` project archived mid-turn.

**`LOP` — operations and follow-up** (12, at cap)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| LOP-01 | Every effectful librarian request carries an `Idempotency-Key`; the operation row commits before the effect, and a DB-only effect finalizes the operation in the same transaction | `IT-LOP-01` |
| LOP-02 | Same key + same canonical digest returns the stored result; same key + different digest → `CONFLICT`; a new key whose digest matches a succeeded operation in the same segment → `CONFLICT{reason:"duplicate_of_operation"}` unless `allowDuplicate` | UNIQUE `(conversation_id, idempotency_key)` + `IT-LOP-02` |
| LOP-03 | An operation with an unknown outcome is settled by domain lookup on its `via_operation_id` result column, never re-issued; the next turn is not admitted until the conversation has no `admitted` operation older than the reconcile window | UNIQUE result columns + `IT-LOP-03` |
| LOP-04 | Each batch item is its own operation; the receipt lists per-item status; a retry re-submits only non-terminal items | `IT-LOP-04` |
| LOP-05 | A task created through the librarian gets `launch_intent='none'`; under `none` a triage verdict never arms `launch_mode='auto'` and C2 never admits the task | `IT-LOP-05` |
| LOP-06 | Send-to-triage records `launch_intent ∈ {triage_only, triage_then_launch}`; `applyTriageVerdict` arms auto-launch only under `triage_then_launch` | `IT-LOP-06` (+ interaction table) |
| LOP-07 | A librarian launch returns the actual run id and `Pending` or `Running`; admission uses `launchRun` preconditions unchanged | `IT-LOP-07` |
| LOP-08 | A confirmation card binds kind, target ids, target revision (task revision, run head SHA, HITL id) and payload digest; deciding a stale or expired card → `CONFLICT` | `IT-LOP-08` |
| LOP-09 | Human-only actions (human HITL answers, promotion, discard) run only from the owner's confirmation click through a session route | `IT-LOP-09` |
| LOP-10 | An operator message to an existing run returns exactly one of `delivered`, `queued`, `refused_requires_rework`, and never uses `runs:delegate` | `IT-LOP-10` |
| LOP-11 | A follow-up update is unique per `(conversation_id, domain_event_id)`, is inserted only while the owner can read the task, and renders as a deterministic card without a model turn | `IT-LOP-11` |
| LOP-12 | A failed update delivery retries a bounded number of times, then records `failed` with evidence; delivery never repeats the business effect | `IT-LOP-12` |

Edge: `EDGE-LOP-01` response lost after task create · `EDGE-LOP-02` batch where item 2
fails · `EDGE-LOP-03` launch refused by cap or dependency · `EDGE-LOP-04` triager says
enqueue under `launch_intent='none'`.

**`TST` — statements and provenance** (8)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| TST-01 | A statement revision holds `context, goal, acceptance[], constraints[], outOfScope[], links[], openQuestions[]`; accepted revisions are immutable | zod schema + UPDATE-refusing trigger + `IT-TST-01` |
| TST-02 | `tasks.revision` increments on every content write (UI PATCH, ext PATCH, statement accept) under a row lock; a stale `expectedRevision` → `CONFLICT` | `IT-TST-02` |
| TST-03 | Accepting a statement renders it deterministically into `tasks.prompt`, so an executor never needs the conversation | `UT-TST-03` |
| TST-04 | Conversation↔task links are many-to-many with meaning `created_from | refined_in | mentioned`, message range and statement revision | `IT-TST-04` |
| TST-05 | Publishing an excerpt is an explicit operation that copies text into a task comment under task visibility; no link grants access to the transcript | `IT-TST-05` |
| TST-06 | Reset or history deletion never deletes tasks, statements or published excerpts; a link to a deleted message renders an explicit unavailable state | `IT-TST-06` |
| TST-07 | A statement change for a task with an active run never mutates the run's launch snapshot; the change is delivered through LOP-10 or reported as requiring rework | `IT-TST-07` |
| TST-08 | Task chips and operation receipts render key and live status from one batched, visibility-filtered read | `IT-TST-08` |

**`CLR` — clarification before execution** (10)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| CLR-01 | A user-origin clarification carries requester, recipient, question, reason, answer format, blocking flag and source message; `origin_kind='user'` rows have NULL `origin_run_id`/`origin_agent_id` | discriminated CHECK + `IT-CLR-01` |
| CLR-02 | The recipient must hold `readBoard` on the task's project at creation and at answer time | `IT-CLR-02` |
| CLR-03 | Creation writes an `inbox_items` row for the recipient and counts in the recipient's `decisions` | ADR-169 amendment + `IT-CLR-03` |
| CLR-04 | Lifecycle `open → answered | cancelled | superseded`; an answered row's answer is never overwritten; a correction creates a superseding row | CHECK + `IT-CLR-04` |
| CLR-05 | An open blocking clarification yields launchability `clarification_pending`; launch and C2 refuse it; no task status is added | `IT-CLR-05` |
| CLR-06 | The answer shows on task detail and reaches the requester's conversation only while the requester can read the task | `IT-CLR-06` |
| CLR-07 | Answering never changes the statement or launches work; it may produce a proposed revision card | `IT-CLR-07` |
| CLR-08 | Recipient deactivation, task abandonment and owner cancellation each produce `cancelled` with a reason and a delivered update | `IT-CLR-08` |
| CLR-09 | Only the human recipient answers — session auth, or a global personal token holding exact `hitl:respond:human`; never a librarian or agent token | `IT-CLR-09` |
| CLR-10 | `composeEffectivePrompt` folds answered user-origin clarifications exactly like agent-origin ones | `IT-CLR-10` |

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
| LMM-08 | Clear history deletes messages, summaries, snapshots and search rows, keeps operations and audit with message refs nulled, and purges the conversation's host workspace | `IT-LMM-08` |
| LMM-09 | Rendering masks librarian messages whose source projects are no longer visible; the owner's own messages always render | `IT-LMM-09` |
| LMM-10 | A `system_sweep` pass purges messages older than `MAISTER_LIBRARIAN_HISTORY_RETENTION_DAYS` (default 365) and snapshots older than `MAISTER_LIBRARIAN_SNAPSHOT_RETENTION_DAYS` (default 30) | `IT-LMM-10` |
| LMM-11 | Personal memory never writes to Project Brain or to an agent's `memory.md` | `IT-LMM-11` |
| LMM-12 | Each reply shows which memory items its snapshot used | `IT-LMM-12` |

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
- A test that stays green with the implementation deleted is trivial — delete it.
- Redaction/visibility proofs feed an input that CONTAINS the forbidden data (a foreign
  project, a secret, another user's message) and assert the exact output key set.
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
  task names them by path (see T3.3, T4.3, T4.4).

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
  firing, skipped updates for lost access.
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
  `0180_agent_turn_steering`; brain lineage untouched):
  `0181` token kind + audit columns · `0182` conversation tables + platform settings ·
  `0183` `runs` changes (run kind, owner kind, placement reason, `librarian_operation_id`) ·
  `0184` `tasks` changes (revision, launch intent, statement revision, via column) ·
  `0185` operations, cards, statement revisions, task links, `task_comments.via_operation_id` ·
  `0186` clarification widening, inbox kind, domain-event kinds · `0187` update deliveries ·
  `0188` memory, tombstones, summaries, search column.
  Shared-table constraint changes (`runs`, `tasks`) get their own numbers (0183, 0184).
  Each migration is the four-legged set: SQL + `_journal.json` entry + `meta/<NNNN>_snapshot.json`
  + `schema.ts`, ending with `drizzle-kit generate` reporting "No schema changes".
- **Renumber pass**: if master moves before merge, one focused pass after rebasing
  renumbers ADRs, migrations and prose (`pre-NNNN`, `since NNNN`).

### D2 — Runtime representation: `run_kind='librarian'`

Owner decision at planning. One `runs` row per conversation, created on the first turn,
`project_id NULL`, `task_id NULL`, reused across turns and parked between them.

- Placement: `mintPlacement` with a new reason `librarian_turn`
  (`web/lib/execution-host/types.ts` `PLACEMENT_REASONS`).
- Workspace: `kind:"directory"` at `<runtimeRoot>/.maister/_platform/librarian/<conversationId>/`,
  a new branch in `workspaceSpecFor` (`web/lib/execution-host/adoption.ts:52`); the refusal
  of project-less, package-less runs (`adoption.ts:182`) gains a librarian arm. The
  directory holds no repository and no host data.
- Prompt owner: new kind `librarian_turn`, variants `owner_message | explain | summary`
  (`prompt-owner-contract.ts`, `PROMPT_OWNER_SHAPES`, owner-kind CHECK, a registry in
  `PRODUCTION_PROMPT_OWNER_REGISTRIES`; `composePromptOwnerRegistry` fails boot on drift).
  `createOwnedSession`'s `create_intent` CHECK gains variant `librarian`.
- Pool: a fourth pool `librarian` in `web/lib/scheduler.ts` (today flow/scratch 6,
  agent 3, assistants 5), counted over `SLOT_HOLDING_RUN_STATUSES` and queued FIFO like
  agent C3 resumes — never `CONFLICT` like scratch.
- **Fan-out (T2.3)**: grep every consumer of `RunKind` / `run_kind` and every read model
  over `runs`, and turn each kind branch into an exhaustive
  `satisfies Record<RunKind, …>` map. Known consumers at planning: board and portfolio
  read models, `/runs` ledger, work table, attention/decision queries, Observatory,
  reconcile, keep-alive sweeper, GC, continuation workers (`agents/continuation-worker.ts:48`),
  `requireRunProjectId` (`runs/run-kind-invariants.ts:96`), domain-event emitters
  (`domain_events.project_id` is NOT NULL — librarian runs emit none), token issuers,
  run stream authz. Librarian runs are excluded from every project-scoped read model and
  every project-scoped metric.
- Rejected: widening `run_kind='agent'` to be project-less (touches every agent-path
  assumption the brief asks to preserve).

### D3 — Session per turn, context epoch, resume rule

- The durable records are the source of truth; the ACP session is a cache. Each turn
  composes a bounded context (instructions version, active-segment summaries + newest
  messages within `MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS`, memory items, subject,
  settled/non-terminal operation receipts of the segment) and writes a snapshot first.
- `librarian_conversations.context_epoch` bumps on reset, forget, clear history, and
  whenever the authz fingerprint changes (sha256 over the owner's active flag, global
  role and sorted `(project_id, role)` visibility set — computed at admission).
- `run_sessions` records the epoch its ACP session was created under. Resume
  (`session/resume` on `acp_session_id`) is allowed only when epochs match; otherwise
  `session/new` with the composed context. This is what stops retained ACP context from
  repeating revoked facts (LIB-13, L-06).
- After `end_turn`: delete the session process (persistent-agent precedent,
  `agents/prompt-owner.ts:627`), park the run `NeedsInputIdle`, release the slot.

### D4 — Delegated authority

- Token: `project_tokens.kind='librarian'`, `owner_user_id` NOT NULL, `project_id` NULL,
  `agent_id` NULL, new `librarian_turn_id` NOT NULL for this kind (CHECK), name
  `librarian-turn:<turnId>` (reserved in `web/lib/tokens/lifecycle.ts`), `expires_at` =
  turn deadline, revoked in the turn-end transaction. Issued by
  `web/lib/librarian/authority.ts`; injected as `MAISTER_ACCESS_TOKEN` into the stdio
  facade for that turn's session only (one process per turn → no cross-user reuse).
- Principal: `TokenActor` gains `tokenKind:'librarian'`, `ownerUserId`,
  `librarianTurnId`; `socialActorForToken` returns the owner user.
- Admission in `handleExt` (`web/lib/tokens/ext-handler.ts`): a librarian arm resolves
  the project per resource (slug or `resolveProjectId`), then checks, **per request**:
  user active and not password-change-pending (as `verify.ts:117-146` does for user
  tokens), `requireProjectActionForUser(owner, project, PROJECT_ACTION_BY_SCOPE[scope])`,
  scope ∈ the token's scopes, and the turn still `running`. Unlike project-bound user
  tokens (checked only at issue), nothing is cached.
- Routes that today refuse non-project-bound tokens with 403 (`ext-handler.ts:473-491`:
  run launch/get/activity, pulse, hitl list, discard, delegation) admit the librarian
  kind where the scope allows, resolving the project from the run.
- `LIBRARIAN_TOKEN_SCOPES` (explicit list in `web/types/token-scopes.ts`): tasks
  read/create/update/triage; comments; relations; flows:read; runners:read; runs
  read/launch/cancel/recover/rework/sync/reopen/message; hitl read (list/inbox) but not
  respond; decisions:read; memory:read (Brain); projects:read; librarian:* (cards,
  memory, history). Excluded: `hitl:respond`, `hitl:respond:human`, `runs:promote`,
  `runs:discard`, `runs:delegate|collect`, tokens, settings, admin, packages, flow
  authoring, `agent_memory:write`. `AGENT_TOKEN_SCOPES` and
  `CROSS_PROJECT_AGENT_SCOPES` are unchanged (snapshot test).
- Explain turns (D11) get `LIBRARIAN_READ_SCOPES`, the read-only subset — teammate
  answers and retrieved text never run with effect authority (LIB-08).
- Audit: `token_audit_log` gains nullable `on_behalf_of_user_id`, `librarian_turn_id`,
  `operation_id`; `actor_label` = `librarian:<ownerUserId>`. The per-turn project set is
  `DISTINCT project_id` over the turn's audit rows — reused by LMM-09 masking.
- Human-only boundary: the token can never answer human HITL kinds, promote or discard.
  Those appear as confirmation cards (D7) whose click goes through the existing
  session-auth routes as the owner.

### D5 — MCP-only session (LIB-05)

`readOnlySession` is not enough: it auto-allows `read`, `search` and `fetch`
(`supervisor/src/acp-client.ts:133-138`), i.e. host files and generic HTTP. The
librarian session uses three layers:

- **L1** — a session enforcement profile with a `tools` allow-list of only
  `mcp__maister__*` names and `mcps: ["maister"]`, enforced by `capability_guard`
  (`supervisor/src/guardrail-hooks.ts:104`), which governs every call reaching the seam.
- **L2** — materialized adapter settings denying built-ins (claude `settings.local.json`
  deny rules for Read/Glob/Grep/WebFetch/WebSearch/Bash/Edit/Write/NotebookEdit; codex
  composed home with the equivalent) via `web/lib/capabilities/adapter-home.ts`.
- **L3** — an empty per-conversation cwd and no `context_repos`.
Runner guard: the librarian runner must be `readOnlyCapable` and never
`dangerously_skip_permissions` (reuse `acp-runners/resolve.ts:215-233`). T2.8 proves L1
denies a scripted built-in call; T7.2 proves L1+L2 against the live adapters. If a live
adapter executes a built-in without reaching the seam, ADR-183 records it as a blocking
defect for that adapter — the librarian runner select refuses it.

### D6 — Operation ledger and crash windows

`librarian_operations(id, conversation_id, segment_id, turn_id, card_id, idempotency_key,
kind, request_digest, target jsonb, status admitted|succeeded|refused|failed|unknown,
result jsonb, error_code, created_at, settled_at)`, UNIQUE `(conversation_id, idempotency_key)`.

- Effectful MCP tools require `operationKey`; the facade sends it as `Idempotency-Key`.
  `handleExt`'s librarian arm upserts the operation before the route's work and finalizes
  it inside `successAuditInWork` (the transaction the mutating routes already use for
  audit), so DB-only effects are atomic with their operation.
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
| op inserted, domain tx not committed | op `admitted`, no result row | reconcile: no result row after window → `failed{reason:"not_applied"}`; safe because the domain tx is atomic with finalize |
| DB effect committed with finalize | op `succeeded` | none needed |
| `launchRun` row committed, supervisor spawn pending/lost | op `succeeded{runId}`, run `Pending`/`Crashed` | existing run reconcile; receipt reads live run status (TST-08) |
| run launch tx failed | op `admitted`, no run with that `librarian_operation_id` | reconcile → `failed` |
| response lost to the model | op terminal | next call with the same key returns stored result |

### D7 — Cards (proposals and confirmations)

`librarian_cards(id, conversation_id, segment_id, message_id, kind
statement_proposal|confirmation|memory_suggestion, status
pending|accepted|rejected|expired|superseded|cleared_by_reset, target jsonb,
target_revision text, payload jsonb, payload_digest, requires_owner boolean,
expires_at, decided_at)`.

- The librarian creates cards through `POST /api/v1/ext/librarian/cards`
  (`librarian_card_propose` tool). A confirmation binds exact target ids and revision:
  task → `tasks.revision`; run promotion → reviewed head SHA; HITL → request id + the
  question's stored revision; discard → run id + status.
- The owner decides through `POST /api/librarian/cards/{cardId}/decide
  {decision, expectedRevision}` (session auth). The server re-reads the target under
  lock, refuses drift with `CONFLICT{reason:"target_changed"}`, then executes through the
  same domain service the existing UI uses, recording an operation with key
  `card:<cardId>` (so a double click is one effect).
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
  (`scheduler/handlers/auto-launch-triaged.ts` and `promoteNextPending` C2) skips `none`.
- New ext route `POST /api/v1/ext/projects/{slug}/tasks/{taskId}/send-to-triage
  {launchIntent}` wraps `sendTaskToTriage` (`triage.ts:416`) and writes the intent in
  the same transaction.
- A human Launch click is unaffected by intent.
- **Interaction table** (policy axes, tested in T3.5): triager `enqueue ∈ {true,false}` ×
  intent `∈ {NULL, none, triage_only, triage_then_launch}` × project auto-launch
  enabled/disabled → expected `launch_mode`.

### D9 — Statements and task revision

- `task_statement_revisions(task_id, revision, statement jsonb, author_actor_type,
  author_actor_id, via_operation_id, created_at)`, PK `(task_id, revision)`, UPDATE and
  DELETE refused by trigger (task deletion cascades as today).
- `tasks.revision integer NOT NULL DEFAULT 0` and `tasks.statement_revision integer NULL`.
  `updateTask` (`web/lib/services/tasks.ts:414`) today reads then updates with no lock;
  it becomes `SELECT … FOR UPDATE` → compare optional `expectedRevision` → update →
  `revision = revision + 1`. The UI PATCH and ext PATCH both accept it
  (`If-Match` precedent: `web/lib/scheduled-launches/http.ts:71`).
- Accept = one transaction: insert revision, render `tasks.prompt` from a pure
  `renderStatementPrompt(statement)` (deterministic markdown), bump revision, write the
  `refined_in`/`created_from` link, record `task_activity` (`statement_accepted`, new kind).
- Links: `librarian_task_links(conversation_id, task_id, meaning, from_message_id,
  to_message_id, statement_revision, created_at)`; message FKs `ON DELETE SET NULL`
  (TST-06 unavailable state).
- Running work (TST-07): a statement accept on a task whose latest run is active never
  touches the run; the librarian then uses the operator-message seam (D10b) and reports
  its outcome.

### D10 — Clarifications before execution

- Widen `task_clarifications` (`schema.ts:6324`) instead of adding a parallel table, so
  `composeEffectivePrompt` (`web/lib/tasks/clarifications.ts:76`) folds answers from both
  origins: add `origin_kind agent_run|user` (backfill `agent_run`), make
  `origin_run_id`/`origin_agent_id` nullable under a discriminated CHECK, add
  `requester_user_id`, `recipient_user_id`, `reason`, `answer_format`, `blocking`,
  `status open|answered|cancelled|superseded`, `superseded_by`, `cancel_reason`,
  `source_message_id` (SET NULL), `requested_via_operation_id` UNIQUE, `answered_by_user_id`.
  **Nullable fan-out**: T4.1 greps every reader of `origin_run_id`/`origin_agent_id` and
  gives each a branch.
- No `hitl_requests` row and no dummy run: `hitl_requests.run_id` stays NOT NULL.
- Recipient surface: `inbox_items.event_kind` gains `clarification_requested` (CHECK at
  `schema.ts:7698`), `source_ref.kind` gains `clarification`; the ATN-01 decision queue
  gains a fifth population (open user-origin clarifications addressed to the reader) —
  an ADR-169 amendment with the "count equals list" invariant kept.
- Launchability gains `clarification_pending` (`web/lib/runs/launchability.ts:16-23`),
  precedence after `flagged`, before `blocked`; fan out to the launch route, C2, board,
  `deriveWorkStage` inputs and the triage prompt.
- Answer: `POST /api/projects/{slug}/tasks/{number}/clarifications/{id}/answer` (session)
  and the ext twin requiring exact `hitl:respond:human` on a global personal token.
- Domain events `task.clarification_requested`, `task.clarification_cancelled` (the
  existing `task.clarification_answered` is reused). The migration re-derives the
  `domain_events` kind CHECK from migration `0167`'s 15 kinds — `schema.ts:7759` lists
  only 13 today (drift found at planning); T4.1 fixes `schema.ts` in the same change.

### D10b — Operator message seam

`POST /api/v1/ext/runs/{runId}/operator-message {message, operationKey}` →
`{outcome: delivered|queued|refused_requires_rework, reason?}`, scope `runs:message`,
action = the run's existing "send message" action:

- scratch run → `sendScratchUserMessage` only if the owner is the scratch owner;
- persistent agent run → `sendAgentMessage` with the user as principal (a new user
  principal on `agent_turns`, never `runs:delegate`);
- flow run → `refused_requires_rework` naming the existing node-interrupt/rework
  controls (ADR-160/161) the owner can use from the run page.

### D11 — Follow-up updates

- Domain-event consumer `librarian_followup` in `DOMAIN_EVENT_CONSUMERS`
  (`web/lib/domain-events/consumers.ts:64`). Kinds: `run.done|failed|crashed|abandoned|
  review|review_opened|needs_input|escalated`, `task.clarification_answered|cancelled`,
  plus `run.launched` if present in the taxonomy (verify). A task is followed by a
  conversation when a `librarian_task_links` row or a succeeded operation targets it.
- `librarian_updates(id, conversation_id, domain_event_id, task_id, run_id, kind, status
  pending|delivered|skipped_no_access|failed, attempts, message_id, last_error_code,
  created_at)`, UNIQUE `(conversation_id, domain_event_id)`. Delivery inserts an
  `author_kind='update'` message with a deterministic card — no model turn, no tokens.
- Access check at insert and at render; lost access → `skipped_no_access`.
- "Explain" on an update card enqueues an `explain` turn (read-only token, D4).
- Result semantics (L-12): the card derives its label from `deriveWorkStage` (M51) plus
  promotion facts; "deployed" is never claimed — a merged run shows
  "merged · deployment unknown".
- Automation policy: at-least-once dispatch, idempotent by the unique; attempts ≤ 5 with
  backoff; a deterministic failure (e.g. conversation missing) → `failed` with evidence and
  the cursor advances, so one poison event never stalls the consumer.

### D12 — Memory, summaries, retrieval

- `librarian_memory_items(id, user_id, kind preference|goal|commitment|fact, content,
  scope general|project, project_id, source_refs jsonb, source_project_ids uuid[],
  origin explicit|accepted_suggestion, valid_until, revision, forgotten_at, created_at,
  updated_at)`; history of edits in `librarian_memory_item_revisions`.
- `librarian_memory_tombstones(user_id, content_digest, created_at)`; digest =
  sha256 of normalized content.
- `librarian_segment_summaries(id, segment_id, revision, from_seq, to_seq, content jsonb
  {decisions[], proposals[], uncertainties[]}, source_project_ids, forget_generation,
  history_generation, invalidated_at)`, UNIQUE `(segment_id, revision)`.
- Summaries are produced by a tool-less `summary` turn after a turn ends when the
  segment's unsummarized tail exceeds half the context cap; at most one pending per
  segment; ≤ 2 attempts; on failure the composer truncates and records it in the snapshot.
- Writes are CAS on `(segment ordinal = current, forget_generation = current,
  history_generation = current)` — a late writer after reset/forget/clear writes nothing.
- Retrieval re-checks `source_project_ids` against current visibility on every use.
- History search: `GET /api/v1/ext/librarian/history/search?q=` (librarian token only)
  over a generated `tsvector` on `librarian_messages.body`, bounded to 20 hits, older
  segments included, results labelled `from earlier conversation`.
- Nothing writes to Project Brain or `agents/.../memory.md` (LMM-11: test asserts no
  write path from `web/lib/librarian/**` imports those stores — an ESLint
  `no-restricted-imports` fence plus the IT).

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
(`workspace.release`), which removes the cwd.
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
| task revision | task | task row lock |
| clarification answer once | clarification | row lock + status CAS |
| card decision once | card | row lock + status CAS |

The two-racer tests are written against the invariant: two tabs posting different
messages at once (both queue, one turn active), and reset racing admission (either the
turn is admitted into the old segment and then stopped, or refused — never admitted
into the new segment with old context).

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
| Ext routes (projects, directory, task search, work, activity feed, send-to-triage, statement, clarifications, operator-message, `librarian/*`) + `Idempotency-Key` + `expectedRevision` on tasks PATCH + librarian token on existing routes | `docs/api/external/operations.openapi.yaml` + `docs/system-analytics/external-operations.md` |
| Librarian stream | new `docs/api/async/librarian-stream.asyncapi.yaml`, added to `ASYNCAPI_FILES` in `scripts/validate-contracts.mjs` with a `validateLibrarianStreamContract` assertion |
| Session enforcement profile on `POST /sessions` (if its shape changes) | `docs/api/supervisor.openapi.yaml` + `docs/supervisor.md` |
| New domain-event kinds | `docs/system-analytics/domain-events.md` + `docs/db/domain-events.md` |
| MCP tools | `mcp/src/tools.ts` + `docs/system-analytics/external-operations.md` MCP table |
| Tables/columns | Drizzle migrations + `docs/database-schema.md` + new `docs/db/librarian-domain.md` ERD + updates to `projects-domain.md`, `runs-domain.md`, `hitl-domain.md`, `attention-domain.md` + regenerated `docs/db/erd.dbml` (`pnpm --filter maister-web db:erd`) |
| Env vars | `docs/configuration.md` + `.env.example` |
| Errors | no new `MaisterError` code (reuse `PRECONDITION`, `CONFLICT`, `CONFIG`, `BUDGET_EXCEEDED`, `EXECUTOR_UNAVAILABLE`, `UNAUTHORIZED`); new `details.reason` values listed in `docs/error-taxonomy.md` |
| i18n | `web/messages/en.json` + `ru.json` namespace `librarian` (+ additions to `taskDetail`, `inbox`) |
| Agent-facing SSOT | `web/lib/librarian/instructions.ts` (versioned) + its drift test against the MCP tool list |

### D19 — Turn recovery windows

| Turn status × run status | Arm |
| --- | --- |
| `queued` × any | admitted by the next admission pass (event-driven + `system_sweep` backstop) |
| `admitted` × `Pending` | pool promotion (`promoteNextPending` librarian arm) |
| `admitted` × `Running`, no prompt command after 60 s | re-issue start (prompt logical key `librarian_turn:<variant>:<turnId>` makes it idempotent); 3 failures → `failed{reason:"start_failed"}` |
| `running` × `Running`, live session | none (deadline watchdog) |
| `running` × run not live (restart, adapter loss) | reconcile → turn `failed{reason:"host_lost"}`, token revoked, run parked `NeedsInputIdle`, next queued turn admitted |
| `running` past deadline | watchdog: cancel prompt, turn `failed{reason:"deadline"}` |
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

---

## Phases and tasks

Task body format: **what** · **files** · **RED** (test file + id + the assertion that must
fail first) · **Log**. Requirement ids in the heading are the coverage gate's input.

### Phase 0 — Specifications and contracts (no application code)

- [x] **T0.1 — Save the brief.** `docs/pv/personal-librarian.md`, verbatim; 26 relative
  links resolve (`node scripts/validate-docs-links.mjs`). Done during planning.
- [ ] **T0.2 — Supersession banner.** In `docs/pv/team-visibility-and-po-intake.md`, add
  one status line naming what `personal-librarian.md` replaces (D1, D2, D5, D7, librarian
  parts of F1/F2, owner decisions §7 rows 2 and 7). Surgical: no other edits (R9).
- [ ] **T0.3 — Reserve numbers.** ADR stubs `### ADR-183` … `### ADR-189` in
  `docs/decisions.md` + `docs/decisions/adr-183.md` … `adr-189.md` from the template;
  record migration numbers 0181–0188 in the plan header. *Verify*:
  `node scripts/validate-docs-adr-anchors.mjs --all`.
- [ ] **T0.4 — ADR-183: librarian runtime.** D2, D3, D19, D20, D5's runner guard, pool and
  budgets. Amends ADR-166/167 (owner kind, placement reason, project-less directory
  adoption) via their `**Amendments:**` lists. Owns `LCV-*`.
- [ ] **T0.5 — ADR-184: delegated authority.** D4 + D5 + D16. States explicitly: no
  `AGENT_TOKEN_SCOPES` change, no admin inspection in this release, follow-up turns
  read-only. Owns `LAU-*`.
- [ ] **T0.6 — ADR-185: operation ledger.** D6, D7, D8, D10b, D11 with the crash-window
  and interaction tables. Amends the triage ADR/analytics for `launch_intent`. Owns
  `LOP-*`.
- [ ] **T0.7 — ADR-186: statements and provenance.** D9; the rendering function contract;
  `task_activity` kind `statement_accepted`. Owns `TST-*`.
- [ ] **T0.8 — ADR-187: clarification before execution.** D10; amends ADR-169 (fifth
  decisions population) and the launchability precedence. Owns `CLR-*`.
- [ ] **T0.9 — ADR-188: memory, history, reset, retention + transcript spike.** D12–D14;
  retention defaults (365 / 30 days, owner-chosen). Spike: locate each ready adapter's
  transcript storage for a cwd and whether the supervisor can delete it; record the
  outcome (purge mechanism or honest residual). Owns `LMM-*`.
- [ ] **T0.10 — ADR-189: librarian surface.** Top-nav entry + right panel (brief §4),
  breakpoints (docked ≥ `xl`, sheet `md`–`xl`, full screen < `md`), Studio/scratch
  composer coexistence (the panel never absorbs their history; focus owner rule), no
  Cmd/Ctrl+K, indicator semantics. Confirm layout on Desk, task detail, workbench, Studio
  and 390 px with a mockup attached to the ADR. Owns `LUI-*`.
- [ ] **T0.11 — Analytics documents.** The seven documents above, R5 sections in order,
  `stateDiagram-v2` for turn lifecycle, operation lifecycle, card lifecycle, clarification
  lifecycle and reset barrier; Expectations carry the ids above verbatim (≤ 12 each);
  Edge cases carry `EDGE-*` ids linked to `MaisterError` codes; every bullet names its
  enforcement point; R6 tags `(Designed)`. Update `triage.md`, `tasks.md`, `attention.md`
  (ATN-01 population), `domain-events.md`, `external-operations.md`, `inbox` behaviour.
  Index rows in `docs/system-analytics/README.md`.
- [ ] **T0.12 — Screen docs.** New `docs/screens/chrome/librarian-panel.md` on the
  9-section template (roles table, entry/exit links, regions, states diagram for
  closed/idle/running/queued/resetting/disabled/no-runner, data & APIs, i18n). Update
  `chrome/top-nav.md` (new entry), `docs/screens/projects/…task detail` doc
  (clarifications section), `inbox.md` (clarification card), `settings-acp-runners.md`
  (librarian card). Index rows in `docs/screens/README.md`.
- [ ] **T0.13 — API, ERD, configuration specs.** Every D18 row with exact DDL (types,
  constraint and index names) so migrations implement the spec. Register the new
  AsyncAPI file and its assertion in `scripts/validate-contracts.mjs`.
  *Verify*: break the new AsyncAPI file (RED) → `pnpm validate:contracts` fails → fix
  (GREEN).
- [ ] **T0.14 — Enforce the ids.** Add `LIBRARIAN_GROUP` (7 documents, 7 prefixes,
  `librarian-traceability.md`) to `scripts/validate-docs-indexes.mjs` + a test case in
  `validate-docs-indexes.test.mjs`. Generalize `validate-m51-coverage.mjs` into
  `validate-requirement-coverage.mjs --group m51|librarian` with a regression case
  pinning M51's current result. The task parser accepts both plan formats
  (`**T0.1 [x] — …**` in the M51 plan, `- [ ] **T0.1 — …**` here). *RED*: register the
  group before the documents exist → "missing Librarian analytics document".
- [ ] **T0.15 — Traceability matrix.** `docs/system-analytics/librarian-traceability.md`:
  one row per id and `EDGE-*` id (contract, tasks, primary test, `Planned`), plus the
  `LIB-01..16` / `L-01..12` mapping table (every LIB and every L maps to ≥ 1 id; every
  L maps to its `E2E-L-NN` and `QL-L-NN` where applicable). Index row in the README.
- [ ] **T0.16 — Roadmap amendment (via `/aif-roadmap`).** Amend the M51 entry: add the
  librarian scope line and remove "PO intake" from its non-goals, only with the owner's
  confirmation. If the owner prefers a separate milestone, update this plan's linkage.
- [ ] **T0.17 — Phase 0 exit.** `pnpm validate:docs`, `pnpm validate:contracts`, the
  coverage gate green. Owner confirms: breakpoints, env defaults (D17), retention,
  confirmation TTL, the transcript-purge outcome. Anything a later task needs that the
  specs do not state is fixed here.

> **Checkpoint 1** — `docs(librarian): specify runtime, authority, operations, statements, clarifications, memory and surface (ADR-183..189)`

### Phase 1 — Delegated authority and the read surface · `LAU-02..07`, `LAU-10`

- [ ] **T1.1 — Migration 0181: librarian token kind + audit columns.** `project_tokens`
  kind `librarian`, `librarian_turn_id uuid` (no FK yet — 0182 adds
  `project_tokens_librarian_turn_fk` after creating `librarian_turns`), CHECK owner NOT
  NULL / project NULL / agent NULL / turn NOT NULL for the kind; `token_audit_log` gains `on_behalf_of_user_id`, `librarian_turn_id`,
  `operation_id`. Files: `web/lib/db/migrations/0181_*.sql`, journal, snapshot,
  `schema.ts`. *RED*: `web/lib/db/__tests__/librarian-token-kind.integration.test.ts`
  `IT-LAU-02` inserts a librarian token with a `project_id` and expects the CHECK to
  refuse. **Log**: none (DDL).
- [ ] **T1.2 — Issue, verify, revoke.** `web/lib/librarian/authority.ts`
  (`issueLibrarianTurnToken`, `revokeLibrarianTurnToken`); `web/lib/tokens/verify.ts`
  `TokenActor` librarian arm; `socialActorForToken` → owner; reserved name in
  `tokens/lifecycle.ts`. *RED*: `web/lib/librarian/__tests__/authority.integration.test.ts`
  `IT-LAU-02` — a revoked or expired turn token is refused on the next request
  (`EDGE-LAU-01`). **Log**: `info` issue/revoke `{turnId, tokenId, expiresAt}`.
- [ ] **T1.3 — Scope policy and live admission.** `LIBRARIAN_TOKEN_SCOPES`,
  `LIBRARIAN_READ_SCOPES` in `web/types/token-scopes.ts`; librarian arm in
  `web/lib/tokens/ext-handler.ts` (per-request active/password/role/scope/turn-running
  checks; project resolution for today's project-bound-only routes). Existing tests that
  assert the 403 "project-bound token required" for global tokens stay green (the arm is
  kind-specific) — list them in the task when found. *RED*:
  `web/app/api/v1/ext/__tests__/librarian-admission.integration.test.ts` `IT-LAU-03`
  (viewer owner → task create 403 while task read 200), `IT-LAU-10` (membership removed
  between two calls of one turn → second call 404), `UT-LAU-04` (exact scope set; agent
  sets unchanged), `IT-LAU-05` (read scopes refuse `task_create`). **Log**: `debug`
  `{turnId, scope, action, projectId, decision}`; `warn` on deny.
- [ ] **T1.4 — Audit attribution.** Write the three columns from the librarian arm in
  the existing mandatory audit path. *RED*: `IT-LAU-07` asserts the row for a
  `task_create` carries owner, turn and operation ids, and an audit write failure fails
  the request. **Log**: none beyond existing audit.
- [ ] **T1.5 — Discovery and cross-project reads.** Ext routes: `GET /ext/projects`
  (`getVisibleProjects`), `GET /ext/projects/{slug}/directory` (purpose from project
  config/README excerpt, launchable flows, default runner, triager configured, Brain
  enabled, `asOf`), `GET /ext/tasks/search?q=&cursor=` (visible projects, title/key/prompt
  match, page 25, `truncated` flag), `GET /ext/work` (`web/lib/queries/work-table.ts`),
  `GET /ext/activity/feed` (`web/lib/queries/activity-feed.ts`); admit librarian tokens on
  `GET /ext/decisions` (owner's human authority: the queue is read, never answered).
  Files under `web/app/api/v1/ext/**` + `web/lib/queries/**`. *RED*:
  `web/app/api/v1/ext/__tests__/librarian-visibility.integration.test.ts` `IT-LAU-06` —
  seed a project the owner cannot see containing a matching task; search, work, feed,
  decisions and directory return no row, no count and an identical 404 for its slug.
  **Log**: `debug` `{route, visibleProjects, rows, truncated}`.
- [ ] **T1.6 — MCP facade tools.** `mcp/src/tools.ts`: `project_list`, `project_get`,
  `task_search`, `work_list`, `decisions_list`, `activity_feed`; `operationKey` argument
  on every effectful tool (sent as `Idempotency-Key`); `MAISTER_MCP_TOOLSET=librarian`
  lists only librarian-permitted tools (enforcement stays server-side). *RED*:
  `mcp/src/__tests__/librarian-tools.test.ts` `CT-LAU-06` — tool→route mapping for each
  new tool and header forwarding of `operationKey`. **Log**: facade `debug` per call
  `{tool, status}` without bodies.
> **Checkpoint 2** — `feat(librarian): delegated per-turn authority and visibility-scoped read surface`

### Phase 2 — Durable conversation, runtime and panel shell · `LCV-01..12`, `LAU-01`, `LAU-09`, `LAU-11`, `LUI-01..09`

- [ ] **T2.1 — Migration 0182: conversation tables + platform settings.**
  `librarian_conversations`, `librarian_segments`, `librarian_messages`,
  `librarian_turns`, `librarian_context_snapshots`; `platform_runtime_settings`
  `librarian_enabled boolean NOT NULL DEFAULT false`, `librarian_runner_id` FK nullable.
  Partial unique indexes for LCV-02/03. *RED*:
  `web/lib/librarian/__tests__/schema.integration.test.ts` `IT-LCV-01` (second
  conversation for one user refused), `IT-LCV-03` (second `running` turn refused).
- [ ] **T2.2 — Migration 0183: `runs` changes.** `run_kind` CHECK + `librarian`,
  `runs.librarian_operation_id` UNIQUE nullable, owner-kind CHECK + `librarian_turn`,
  `create_intent` variant, placement reason. Re-derive shared CHECKs from `schema.ts` at
  rebase. *RED*: `IT-LCV-04` part 1 — a `librarian` run with a `project_id` is refused;
  a prompt command without owner is refused.
- [ ] **T2.3 — `run_kind` fan-out.** Enumerate (grep `run_kind|runKind|RunKind`) every
  consumer; convert kind branches to exhaustive `satisfies Record<RunKind, …>` maps;
  exclude librarian runs from every project-scoped read model and metric; add the
  librarian arm to `run-kind-invariants.ts`. The task body lists every file touched.
  *RED*: `web/lib/runs/__tests__/run-kind-fanout.integration.test.ts` `IT-LCV-04` part 2
  — a parked librarian run appears in no board, portfolio, `/runs`, work, decisions,
  Observatory or GC candidate query. **Log**: none.
- [ ] **T2.4 — Conversation service.** `web/lib/librarian/conversation.ts`:
  `getOrCreateConversation(ownerId)`, `appendOwnerMessage` (dedup by
  `client_message_id`, subject captured), `withdrawMessage` (queued only),
  `listMessages(beforeSeq)`, `advanceReadCursor` (GREATEST). *RED*: `IT-LCV-01`,
  `IT-LCV-02` (two concurrent inserts of one client id → one row, same response —
  `EDGE-LCV-01`), `IT-LUI-04` (subject stored at send; a later subject change does not
  alter the queued message). **Log**: `info` `{conversationId, seq, deduped}`.
- [ ] **T2.5 — Admission, pool, budgets.** `web/lib/librarian/admission.ts` + a
  `librarian` pool in `web/lib/scheduler.ts` + promotion arm in `promoteNextPending`;
  daily cap; enabled/runner-ready checks; authz fingerprint → epoch bump.
  *RED*: `IT-LCV-03` (message while running stays queued — `EDGE-LCV-02`), `IT-LCV-05`
  (pool of 1: second user's turn `Pending`, admitted when the first parks; parked run
  counts in no pool), `IT-LCV-10` (daily cap → `BUDGET_EXCEEDED`), `IT-LCV-11`
  (disabled → `CONFIG`; runner not ready → `EXECUTOR_UNAVAILABLE` — `EDGE-LCV-03`),
  `IT-LAU-10` part 2 (deactivated owner's queued turn refused at admission). Two-racer
  per D15. **Log**: `debug` pool counts and queue position; `warn` refusals.
- [ ] **T2.6 — Context composer and snapshot.** `web/lib/librarian/composer.ts` (pure
  selection over supplied rows) + `snapshot.ts` (persist before prompt). Memory and
  summaries are empty inputs until Phase 6. *RED*:
  `web/lib/librarian/__tests__/composer.test.ts` `UT-LCV-10` part (owner's latest
  message always included when over budget); `IT-LCV-07` (no prompt command exists
  without a committed snapshot); `IT-LCV-06` (epoch mismatch → `session/new`, match →
  `session/resume`). **Log**: `debug` `{turnId, messages, chars, truncated, epochMatch}`.
- [ ] **T2.7 — Instructions SSOT.** `web/lib/librarian/instructions.ts` (versioned):
  role, the LIB-08 intent rules, ask-when-ambiguous, duplicate check via `task_search`
  before create, operation keys, cards for human-only actions, never claim deployment.
  A drift test asserts every tool named in the instructions exists in the librarian
  toolset and vice versa. *RED*: `UT-LCV-07` (version recorded in the snapshot; drift test
  fails on a renamed tool). **Log**: none.
- [ ] **T2.8 — Supervisor MCP-only enforcement.** Enforcement profile (`tools` allow-list
  of `mcp__maister__*`, `mcps:["maister"]`) + L2 adapter deny settings via
  `web/lib/capabilities/adapter-home.ts`; runner guard. *RED*:
  `supervisor/src/__tests__/librarian-mcp-only.integration.test.ts` `IT-LAU-11` using
  `mock-acp-guardrail.mjs`: a scripted `read` and `fetch` call are denied, a
  `mcp__maister__task_get` call is allowed. **Log**: supervisor `warn` on deny with
  `{sessionId, toolName}`.
- [ ] **T2.9 — Turn runtime.** `web/lib/librarian/runtime.ts`: first-turn run insert +
  `run_sessions` + `mintPlacement` in one tx; directory adoption; token issue; facade
  mcpServer with the turn token; `createOwnedSession` (resume per D3);
  `issueOwnedPrompt` with owner `librarian_turn:owner_message:<turnId>`; prompt-owner
  registry `web/lib/librarian/prompt-owner.ts` that, on `end_turn`, in one tx: stores the
  librarian reply message (from the prompt projector's assistant text), records source
  projects from the turn's audit rows, completes the turn, revokes the token, parks the
  run `NeedsInputIdle`; after commit: `releaseSlotOnIdle` + `promoteNextPending` (the
  slot-release contract) and admission of the next queued turn. Each turn records its
  `runner_snapshot` on `librarian_turns` (the runner can change between turns; a change
  forces `session/new`). **Deferred release**: every failure path after the prompt was
  issued (reply persistence error, snapshot error, token-revoke error) cancels the prompt
  through `BoundClient` before returning; a regression test injects a persistence failure
  and asserts the cancel was issued and the token revoked. *RED*: `IT-LCV-04` part 3 +
  `IT-LCV-05` part 2 against a mock adapter that ends the turn. **Log**: `info` turn
  transitions `{turnId, runId, from, to, durationMs}`; `error` on the failure paths with
  `{turnId, code}`.
- [ ] **T2.10 — Stop, deadline, reconcile.** Stop route + service (cancel prompt via
  `BoundClient`, revoke token, turn `stopped`); deadline watchdog (existing duration
  watchdog pattern); reconcile arms per D19 in the web reconcile and `system_sweep`.
  *RED*: `IT-LCV-08` (stop leaves a launched task run and its operation row untouched),
  `IT-LCV-09` (kill the host mid-turn → `failed{host_lost}`, queued message admits
  after), `EDGE-LCV-04` (deadline during a tool call → token revoked, operation settles
  by reconcile). **Log**: `warn` on each reconcile arm firing.
- [ ] **T2.11 — Session routes and stream.** `web/app/api/librarian/**` routes from D16
  (conversation, messages, withdraw, stop, read-cursor, stream). Stream: server-side poll
  of durable tables — 500 ms while a turn is running, 2 s idle, closes after 5 min quiet;
  frames `librarian.message | librarian.turn | librarian.indicator`; replay by `seq`.
  *RED*: `web/app/api/librarian/__tests__/routes.integration.test.ts` `IT-LAU-01` (a
  `userId` in body/query is ignored or refused; owner from session), `IT-LAU-09` (global
  admin gets only their own conversation; no route returns another user's rows),
  `IT-LCV-12` (replay from `lastEventId`; no foreign frame). **Log**: `debug` stream
  open/close `{conversationId, lastEventId}`.
- [ ] **T2.12 — Admin enablement and readiness.** `PATCH /api/admin/platform/librarian`
  + a Librarian card on the ACP runners settings screen (enable toggle, runner select
  limited to ready read-only-capable runners, readiness line). Disable = stop admission;
  running turn finishes or hits its deadline; nothing deleted. `librarian_runner_id` is
  `ON DELETE SET NULL`; the settings round trip is tested SET → CLEAR (runner removed or
  unset → column NULL, readiness "not configured") → re-SET. *RED*: `IT-LCV-11` part 2
  (disable during a queued backlog: queued stay queued and visible, no admission; the
  SET/CLEAR/re-SET round trip);
  component test for the card's disabled reasons. EN/RU strings. **Log**: `info`
  `{enabled, runnerId, actorUserId}`.
- [ ] **T2.13 — Mock librarian adapter + round-trip test.**
  `supervisor/test/fixtures/mock-acp-librarian.mjs`: reads a scripted plan from the
  prompt (a fenced JSON block), calls the attached `maister` stdio MCP server's tools,
  then replies. Integration test drives: owner message → admission → real supervisor →
  mock adapter → real facade → ext route with the turn token → reply stored → run parked.
  *RED*: `web/lib/librarian/__tests__/round-trip.integration.test.ts` `IT-LCV-04`
  (end-to-end) fails before T2.9 wiring is complete. **Log**: fixture logs to stderr only.
- [ ] **T2.14 — Panel shell UI.** `web/components/librarian/` — `librarian-trigger.tsx`
  (top-nav entry, indicator), `librarian-panel.tsx` (docked/sheet/full-screen, mounted in
  `web/app/(app)/layout.tsx`), message list on `TranscriptView`
  (`components/run-transcript/transcript-view.tsx:414`), composer (Send, Stop response,
  queued chips with Withdraw, draft persisted per user in `localStorage` with try/catch),
  subject chip, jump-to-latest, focus management reusing `useModalFocusTrap` in modal
  modes, no key binding. Wire `top-nav.tsx` right group. i18n namespace `librarian`.
  *RED*: `web/components/librarian/__tests__/panel.test.tsx` `UT-LUI-01`, `UT-LUI-06`,
  `UT-LUI-07`, `UT-LUI-08`; `web/e2e/librarian-panel.spec.ts` `E2E-LUI-01/02/03/05/09`
  (added to `AUTHED_SPEC`). **Log**: client — none; server components — none.
- [ ] **T2.15 — Deployment wiring.** D17's pool, deadline, context and daily-cap vars in
  `.env.example`, compose files, `docs/configuration.md`; read through the existing env
  loader with validation (positive integers, refuse boot on garbage with `CONFIG`).
  *RED*: `web/lib/librarian/__tests__/config.test.ts` `UT-LCV-10` part (invalid value →
  `CONFIG`). **Log**: `info` resolved config at boot (numbers only).

> **Checkpoint 3** — `feat(librarian): durable personal conversation on a project-less librarian run with MCP-only sessions`

### Phase 3 — Operations and the work cycle · `LOP-01..10`, `TST-01..05`, `TST-07..08`, `LAU-08`, `LUI-10`

- [ ] **T3.1 — Migrations 0184 + 0185.** 0184 (`tasks`): `revision`, `statement_revision`,
  `launch_intent` + CHECK, `created_via_operation_id` UNIQUE. 0185: `librarian_operations`,
  `librarian_cards`, `task_statement_revisions` (+ immutability trigger),
  `librarian_task_links`, `task_comments.via_operation_id` UNIQUE, `task_activity` kind
  `statement_accepted`. *RED*: `IT-TST-01` (UPDATE on a statement revision refused),
  `IT-LOP-02` part 1 (duplicate key refused by the unique).
- [ ] **T3.2 — Idempotency in `handleExt`.** Librarian arm: required `Idempotency-Key` on
  routes declared effectful; upsert operation; digest compare; duplicate-digest guard;
  finalize in `successAuditInWork`; reconcile-by-lookup for `admitted`; admission gate
  (LOP-03). Files: `web/lib/tokens/ext-handler.ts`, `web/lib/librarian/operations.ts`.
  *RED*: `web/lib/librarian/__tests__/operations.integration.test.ts` `IT-LOP-01` (effect
  and finalize atomic: inject a failure after the domain write → neither persists),
  `IT-LOP-02` (same key/same body → same result, no second row; same key/other body →
  `CONFLICT`; new key/same digest → `duplicate_of_operation`), `IT-LOP-03` (crash-window
  table rows 1 and 4). **Log**: `info` settle `{operationId, kind, status}`; `warn`
  conflicts.
- [ ] **T3.3 — Task revision.** `updateTask` under row lock with `expectedRevision`; UI
  PATCH (`web/app/api/projects/[slug]/tasks/[number]/route.ts`) and ext PATCH accept it
  (`If-Match` or body). Migrate existing tests asserting the PATCH response shape — list
  them by path after grepping `tasks/[number]/route` and `ext/**/tasks/[taskId]` tests.
  *RED*: `web/lib/services/__tests__/task-revision.integration.test.ts` `IT-TST-02`
  (two concurrent PATCHes with the same `expectedRevision` → one `CONFLICT`). **Log**:
  `debug` `{taskId, from, to}`; `warn` stale.
- [ ] **T3.4 — Statements and task create/update via the librarian.**
  `web/lib/tasks/statement.ts` (zod schema, `renderStatementPrompt`, `acceptStatement`);
  ext `POST …/tasks` gains `statement` (renders prompt, revision 1, link
  `created_from`, `launch_intent='none'` for librarian tokens);
  `POST …/tasks/{taskId}/statement {statement, expectedRevision}`; MCP
  `task_create` (statement), `task_statement_accept`. Create sets `flowId` when the
  project has exactly one launchable flow or the owner named one; otherwise the receipt
  shows the task's launchability (`unconfigured`) and the next step (triage or pick a
  flow), so no task is reported as launchable when it is not. *RED*: `UT-TST-03` (byte-identical
  render for equal input; section order fixed), `IT-TST-04` (links with meaning and
  message range), `IT-LOP-05` part 1 (librarian create → intent `none`). **Log**: `info`
  `{taskId, revision, operationId}`.
- [ ] **T3.5 — Launch intent and send-to-triage.** `applyTriageVerdict` and C2 honour
  `launch_intent`; ext `send-to-triage` + MCP `task_send_to_triage`. *RED*:
  `web/lib/services/__tests__/launch-intent.integration.test.ts` `IT-LOP-05` (triager
  `enqueue:true` under `none` → `launch_mode` stays NULL and `runSchedulerTick` C2 admits
  nothing — `EDGE-LOP-04`), `IT-LOP-06` + the D8 interaction table as a parameterized
  test. **Log**: `debug` `{taskId, intent, enqueue, armed}`.
- [ ] **T3.6 — Comments, relations, excerpts.** Operation-wrapped `comment_create` /
  `relation_add|remove` for librarian tokens; `task_publish_excerpt` tool = explicit
  comment with a quoted excerpt and a `mentioned` link; no transcript link is rendered to
  other users. *RED*: `IT-TST-05` (another member sees the excerpt comment and cannot
  load any `/api/librarian/*` resource for it), `IT-LAU-08` part 2 (comment shows owner
  + "via Librarian"). **Log**: `info` `{taskId, commentId, operationId}`.
- [ ] **T3.7 — Launch and existing-work actions.** Admit librarian tokens on
  `run_launch`, `run_cancel`, `run_recover`, `run_rework`, `run_sync`, `run_reopen`
  (live RBAC per D4); `runs.librarian_operation_id` written in `launchRun`'s insert tx;
  receipts per item. *RED*: `IT-LOP-07` (launch returns `Pending` with queue position
  when the pool is full — `EDGE-LOP-03`), `IT-LOP-04` (batch: item 2 refused by a
  dependency, item 1 kept and linked, retry re-issues item 2 only — `EDGE-LOP-02`),
  `IT-LOP-03` part 2 (launch crash window). **Log**: `info` `{runId, status, operationId}`.
- [ ] **T3.8 — Operator message seam.** D10b route + MCP `run_operator_message`;
  `agent_turns` user principal. *RED*: `IT-LOP-10` (scratch → delivered or queued; flow
  → `refused_requires_rework`; token lacking ownership → 404), `IT-TST-07` (statement
  accept on a task with a running flow run leaves `runs` launch snapshot unchanged).
  **Log**: `info` `{runId, runKind, outcome}`.
- [ ] **T3.9 — Cards and human-only actions.** Ext `POST /ext/librarian/cards` + MCP
  `librarian_card_propose`; session `POST /api/librarian/cards/{id}/decide` executing
  through existing services (human HITL answer via the `hitl.ts` human path as the
  owner; promotion with expected head SHA; discard). *RED*:
  `web/lib/librarian/__tests__/cards.integration.test.ts` `IT-LOP-08` (task revision
  bumped after card creation → decide refused), `IT-LOP-09` (librarian token calling
  `hitl_respond` on a human kind, `run_promote`, `run_discard` → refused; the card click
  succeeds; the HITL row's responder is the user with no `via`), `IT-LAU-08` part 3.
  **Log**: `info` `{cardId, kind, decision}`; `warn` drift.
- [ ] **T3.10 — Cards and receipts UI.** Statement card (diff against current revision),
  proposal/confirmation cards, batch receipt, task chips, Needs attention / Related work
  region, all fed by one batched live read `web/lib/librarian/read-models.ts`
  (`getLinkedWork(ownerId)`). EN/RU. *RED*: `IT-TST-08` (receipts show live status after
  the run changes; foreign task in a stale link renders unavailable), `IT-LUI-10`,
  component tests for card states. **Log**: `debug` read-model row counts.

> **Checkpoint 4** — `feat(librarian): operation ledger, statements, triage intent, launch and confirmation cards`

### Phase 4 — Clarification before execution · `CLR-01..10`

- [ ] **T4.1 — Migration 0186.** `task_clarifications` widening (D10) with backfill
  `origin_kind='agent_run'`; `inbox_items` kind + `source_ref` kind; domain-event kinds
  and the re-derived 15+2 CHECK, fixing `schema.ts:7759`'s drift in the same change.
  Nullable fan-out: list every reader of `origin_run_id`/`origin_agent_id` and give each
  a branch. *RED*: `IT-CLR-01` (user-origin row with a run id refused; agent-origin row
  without one refused).
- [ ] **T4.2 — Services and routes.** `web/lib/tasks/clarification-requests.ts`:
  `requestClarification` (operation-wrapped, recipient eligibility, inbox item,
  subscription, event), `answerClarification` (human only, row lock, status CAS),
  `cancelClarification`, `supersede`. Ext `POST …/clarifications`, `DELETE …/{id}`; MCP
  `clarification_request`, `clarification_cancel`; session answer route + ext twin.
  *RED*: `IT-CLR-02`, `IT-CLR-04`, `IT-CLR-07` (answer leaves statement, revision and
  launch state unchanged), `IT-CLR-09` (librarian and agent tokens refused; global
  personal token without exact `hitl:respond:human` refused). **Log**: `info`
  `{clarificationId, taskId, status}` — never question or answer text.
- [ ] **T4.3 — Launchability `clarification_pending`.** `web/lib/runs/launchability.ts`
  + every consumer (launch route, C2 admission, board card, work-stage inputs, triage
  context). Migrate existing launchability tests whose precedence tables change (list
  them). *RED*: `IT-CLR-05` (blocking open clarification → launch `PRECONDITION` with
  classification; non-blocking → launchable). **Log**: `debug` classification.
- [ ] **T4.4 — Decisions and inbox.** Fifth population in `getDecisionsQueue` /
  `getDecisionsCount` (`web/lib/queries/decisions.ts`), ordering rule from ADR-169
  amendment, attention stream `changed[]`. Migrate `IT-ATN-01` fixtures (count equals list
  with the new population). *RED*: `IT-CLR-03` (recipient's count and list both include
  it; the requester's do not). **Log**: `debug` population counts.
- [ ] **T4.5 — Cascades and return path.** Cancel on recipient deactivation (users
  service), task abandonment (task status path), owner cancel; requester access check
  before delivery (D11 consumer handles delivery; this task emits the events). *RED*:
  `IT-CLR-08` (each cause → `cancelled` with reason + event), `IT-CLR-06` (requester
  removed from project → answer visible on task, not delivered to conversation).
  **Log**: `info` `{clarificationId, cause}`.
- [ ] **T4.6 — Prompt folding.** `composeEffectivePrompt` includes answered user-origin
  rows with attribution. *RED*: `IT-CLR-10`. **Log**: none.
- [ ] **T4.7 — UI (`CLR-03`, `CLR-06`).** Task detail clarifications section (open/answered/cancelled,
  answer form for the recipient, cancel for the requester), inbox card, librarian
  clarification card. EN/RU. *RED*: component tests; `web/e2e/task-clarification.spec.ts`
  covering request → inbox → answer (added to `AUTHED_SPEC`). **Log**: none.

> **Checkpoint 5** — `feat(tasks): addressed clarification before execution with launch hold`

### Phase 5 — Follow-up delivery · `LOP-11..12`, `LAU-05`, `LUI-01`

- [ ] **T5.1 — Migration 0187.** `librarian_updates` per D11. *RED*: `IT-LOP-11` part 1
  (duplicate `(conversation_id, domain_event_id)` refused).
- [ ] **T5.2 — `librarian_followup` consumer.** `web/lib/librarian/followup.ts` registered
  in `DOMAIN_EVENT_CONSUMERS`; follow set = links ∪ succeeded operations; access check;
  deterministic card payload (stage via `deriveWorkStage`, "deployment unknown" after
  merge). *RED*: `IT-LOP-11` (one event dispatched twice → one card; lost access →
  `skipped_no_access`), `IT-LOP-12` (forced failure 5× → `failed` with error code; cursor
  advanced; no duplicate business effect). Wiring test through `dispatchDomainEvents`.
  **Log**: `info` delivered `{conversationId, eventId, kind}`; `warn` skipped/failed.
- [ ] **T5.3 — Update cards, Explain, indicator.** Update card component; `POST
  /api/librarian/updates/{id}/explain` enqueues an `explain` turn with read scopes;
  indicator `unread` from `read_through_seq`, `action_required` from pending owner
  cards. *RED*: `IT-LAU-05` part 2 (Explain turn's token cannot create a task even if the
  update text instructs it), `UT-LUI-01` part 2 (indicator states). **Log**: `info`
  `{updateId, turnId}`.

> **Checkpoint 6** — `feat(librarian): deduplicated follow-up updates with on-demand explanation`

### Phase 6 — Memory, summaries, reset, forget, history · `LMM-01..12`, `TST-06`

- [ ] **T6.1 — Migration 0188.** Memory items + revisions, tombstones, segment summaries,
  conversation generations, `librarian_messages.body_tsv` generated column + GIN index.
  *RED*: `IT-LMM-02` part 1 (edit creates a revision row).
- [ ] **T6.2 — Memory service, tools, UI.** `web/lib/librarian/memory.ts`; ext
  `POST /ext/librarian/memory` (owner-message turns only) and suggestion cards; session
  memory routes; Memory dialog (list, edit, forget, "use memory in next segment" toggle,
  "used in this reply" chips). ESLint fence: `web/lib/librarian/**` may not import Brain
  or agent memory stores. *RED*: `IT-LMM-01` (explain-turn token refused; suggestion only
  persists on accept), `IT-LMM-02`, `IT-LMM-11`, `IT-LMM-12`. **Log**: `info`
  `{itemId, action}` — never content.
- [ ] **T6.3 — Summary turns.** `summary` variant: tool-less session, output validated
  against the summary schema, CAS write per D12. *RED*: `IT-LMM-07` (reset between summary
  start and write → nothing written; forget between → nothing written). **Log**: `info`
  `{segmentId, revision, fromSeq, toSeq}`; `warn` fenced.
- [ ] **T6.4 — Retrieval and masking.** Composer consumes memory + summaries with
  visibility re-check; message render masks by `source_project_ids`. *RED*: `IT-LMM-03`
  (mixed summary with a revoked source dropped and rebuild queued), `IT-LMM-09` (the
  owner's own messages still render; librarian message sourced from a revoked project
  renders the unavailable marker), `IT-LMM-04` (pre-reset messages absent from the
  snapshot). **Log**: `debug` `{dropped, masked}` counts.
- [ ] **T6.5 — Reset barrier.** `web/lib/librarian/reset.ts` + route + `system_sweep`
  backstop + UI progress state. *RED*: `IT-LMM-05` (admitted operation of the old segment
  → reset stays `resetting` until it settles; queued message withdrawn; pending card
  `cleared_by_reset`; epoch bumped), reset-vs-admission two-racer (D15). **Log**: `info`
  `{conversationId, phase}`.
- [ ] **T6.6 — Forget.** Tombstone + epoch bump; suggestion and summary writers consult
  tombstones. *RED*: `IT-LMM-06` (forgotten fact not re-suggested from an older summary;
  explicit re-remember creates a new item). **Log**: `info` `{itemId}`.
- [ ] **T6.7 — History search tool.** Ext route + MCP `librarian_history_search`;
  labelled results. *RED*: `IT-LMM-04` part 2 (older segment hit returned with label;
  masked messages excluded). **Log**: `debug` `{hits}`.
- [ ] **T6.8 — Clear history.** Preview + clear per D14; host workspace release and the
  transcript purge decided in T0.9. *RED*: `IT-LMM-08` (all personal rows gone;
  operations and audit kept with nulled refs; subsequent turn uses `session/new`),
  `IT-TST-06` (tasks, statements, excerpts intact; source link renders unavailable).
  **Log**: `info` counts per table.
- [ ] **T6.9 — Retention pass + wiring.** `system_sweep` pass with keyset cursor; env
  vars for retention and TTL in `.env.example`, compose files, `docs/configuration.md`.
  *RED*: `IT-LMM-10` via `runSchedulerTick` (old messages and snapshots purged, newer
  kept; progress across batches). **Log**: `info` batch totals.

> **Checkpoint 7** — `feat(librarian): personal memory, fenced summaries, reset barrier, forget and history deletion`

### Phase 7 — Qualification, documentation, reconciliation

- [ ] **T7.1 — Acceptance E2E `L-01..L-12`.** `web/e2e/librarian-*.spec.ts` on the mock
  librarian adapter (all added to `AUTHED_SPEC`), one spec per scenario or a small group;
  L-04 and L-07 include web and supervisor restarts; L-05 and L-06 run with seeded
  viewer/unrelated-member/admin users; mobile viewport 390 px for L-01.
- [ ] **T7.2 — Live-adapter qualification.** `scripts/qualify-librarian.mjs` + an
  evidence record under `docs/spikes/2026-…-librarian-qualification.md`: claude and codex
  runners, representative PO scenarios (L-01, L-02 with a real duplicate, L-03, L-04,
  L-08 with an injected instruction in a teammate answer, L-12), plus the D5 L1/L2
  built-in denial check. Records runner, model, package/engine provenance and outcome
  per scenario; no private bodies. Not in CI. **Parity**: the scenario table is the same
  one T7.1 runs against the mock adapter, so fake and real peers are compared on one
  table.
- [ ] **T7.3 — Operator and user documentation.** EN: how the librarian works, admin
  enablement, budgets, retention, what reset/forget/clear do. RU: the user manual
  section (ADR-158) under `docs/ru/`. Update `README.md` "What MAIster does" only if the
  owner wants the librarian listed.
- [ ] **T7.4 — Adversarial review.** One refute-the-design pass over authority (token
  scope, live RBAC, visibility), intent (teammate text, retrieved text, Explain turns),
  idempotency and the reset barrier; each finding fixed or recorded in the ADR with a
  reason. Repeat after each fix cycle.
- [ ] **T7.5 — As-built reconciliation.** Flip `(Designed)` → `(Implemented)` only for
  pieces with executed tests; traceability `Status` → `Implemented`; ROADMAP via
  `/aif-roadmap`; `CLAUDE.md`/`web/CLAUDE.md` one-line mentions where the root file
  lists shipped domains.
- [ ] **T7.6 — Release gate.** Full unit/integration suites, supervisor and mcp suites,
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
| 3 | T2.1–T2.15 | `feat(librarian): durable personal conversation on a project-less librarian run with MCP-only sessions` |
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
- **Model behaviour**: intent classification, duplicate checks and operation-key reuse
  are instruction-driven. Server guards (read-only Explain turns, duplicate-digest
  refusal, cards for human-only actions, live RBAC) bound the damage; T7.2 measures the
  behaviour. Deterministic tests alone do not prove usefulness (brief §10).
- **Roadmap text conflict**: M51's non-goals exclude PO intake until T0.16 lands.
- **Scale of fan-out**: `run_kind`, `launchability`, `task_clarifications` nullability
  and the decisions queue each touch many consumers; T2.3, T4.1, T4.3 and T4.4 list
  every file they change.
- **Cost**: each fresh-context turn pays full prompt cost; the epoch rule resumes when
  safe. Budgets (D17) are finite and owner-confirmed.
