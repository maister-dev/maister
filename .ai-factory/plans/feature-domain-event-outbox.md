# Implementation Plan: Domain-Event Outbox Core (shared trigger bus) — M32

Branch: feature/domain-event-outbox (from main @ c104f66b)
Created: 2026-06-11

## Settings
- Testing: yes (TDD — integration-first per phase; per-phase suite-green gates `pnpm test:unit && pnpm test:integration`)
- Logging: verbose (DEBUG per emit, INFO per dispatch batch, WARN per consumer failure/lease event; payloads never dumped wholesale)
- Docs: yes (mandatory docs checkpoint; Phase 0 is docs-FIRST per project rules)

## Roadmap Linkage
Milestone: "M32. Domain-event outbox core (shared trigger bus)"
Rationale: Stage 2 of the validated platform-agents/social-board design (Layer 3 — trigger bus under future agent actors); next milestone slot after M31 (social board Stage 1). The roadmap row itself is added at close-out via `/aif-roadmap` (ownership boundary — this plan does not edit `ROADMAP.md`).

## Scope source (IMPORTANT)
The referenced design doc `docs/plans/2026-06-11-platform-agents-social-board-design.md` (§Layer 3, Stage 2) does **not exist on disk in any checkout** — it was validated in session but never committed. Scope authority for this plan = the task statement (2026-06-11) + the validated-design memory:
- `domain_events`: immutable append-only log, emitted from the domain layer **inside the same transaction** as the state change (transactional outbox).
- Initial kinds: `task.created`, `task.comment_added`, `task.triage_requeued`, `run.*` terminal transitions, `gate.failed`.
- Dispatcher seam: singleton job kind on the M24 scheduler clock; per-consumer cursors/claims; at-least-once; no duplicates under concurrent ticks; **no real consumers this stage** — seam + no-op/test consumer only.
- Catch-up semantics: missed events caught up by cursor on next tick; live path = dispatch, recovery = sweep (ADR #1 preserved).
- Coordination: outbound-webhooks (ADR-077, merged) keeps its own outbox for now; its drainer plugs into `domain_events` later — note left in its plan file.

Owner decision (2026-06-11): the design doc is **not restored**. The roadmap rows + per-stage specs/ADRs (this plan, ADR-086, the analytics docs, and the T11 SDD-freeze spec at `.ai-factory/specs/domain-event-outbox.spec.md`) are the durable record of the staged design going forward.

## Context: what exists (verified against code @ c104f66b, 2026-06-11)

- **Numbering verified against main HEAD (re-verified @ c104f66b after the 2026-06-11 rebase)**: highest ADR = **ADR-084** (gemini/opencode ACP adapter families), highest migration = `0044_mcp_supported_agents_all_adapters.sql` → this plan takes **ADR-086** and **migration `0046`**. All former sibling claims (075-084) are merged; no live contention. The gemini/opencode commit did NOT touch any DD7 emission-site file or the scheduler — the inventory below stands.
- **Webhooks outbox (ADR-077)** is the proven in-repo transactional-outbox precedent:
  - `webhook_events {id, project_id NOT NULL, run_id NOT NULL, type, data, payload, occurred_at, fanout_at}` — `run_id NOT NULL` makes it **structurally unable to carry task-scoped events** (task.created has no run). A new table is required, not a preference.
  - `emitWebhookEvent({db, ...})` (`web/lib/webhooks/outbox.ts`) — single INSERT riding the caller's tx via a dual db/tx handle. ~40 call sites, all tx-coupled.
  - Drainer = `webhook_delivery` singleton job (`web/lib/scheduler/handlers/webhook-delivery.ts`): fanout pass (`FOR UPDATE SKIP LOCKED` on `fanout_at IS NULL`), drain pass (durable lease `lease_expires_at = now()+5min`), prune pass. Cadence 60s, budget 1.
- **M24 scheduler** (`web/lib/scheduler/`): kinds union in `web/lib/db/schema.ts:566-595` + `SCHEDULER_JOB_KINDS` (`jobs.ts:18-27`); dispatch switch `tick-service.ts:84-141`; budgets `budgets.ts`; singleton seeds via `ensureDefaultSchedulerJobs()` (`jobs.ts:162-245`, `ON CONFLICT DO NOTHING`, self-healing per tick); claim CTE with `FOR UPDATE SKIP LOCKED` + lease + budget CAS; `reapStuckSchedulerAttempts()` before claims; catch-up = one fire per outage, no backfill; stale-handler fencing in `recordJobAttemptResult`. `run_schedule` is deliberately **excluded** from `job-admin-schema.ts` (singleton not user-creatable) — precedent for our kind.
- **Social board Stage 1 (ADR-083, migration 0043)**: `createTask` (`web/lib/services/tasks.ts:39`, tx at :68 — counter + insert + `recordTaskActivity` + auto-subscribe, one tx); `addTaskComment` (`web/lib/social/comments.ts:48`, tx at :59 — mentions + insert + activity + subscribe + inbox fanout, one tx). `task_activity` is the **domain-facing audit feed** (ADR-078/D7: writers always pass tx) — it is NOT a trigger bus and stays untouched.
- **No `triage` concept exists in code** (`grep -ri triage web/` → empty). `task.triage_requeued` is the Stage-3 triager's event; it gets a taxonomy entry but **no emitter** this stage.
- **Run terminal sites** (status → `Done|Failed|Crashed|Abandoned`) are fully enumerated below (DD7); all but one already pair a `db.transaction` with `emitWebhookEvent`. The exception: `keepalive-sweeper.ts` `runPass2` (NeedsInputIdle→Abandoned TTL) does a **bare `.update()` — no tx, no emit**. This plan wraps it and emits the domain event there.
- **Gate writes** (`web/lib/flows/graph/gate-store.ts`): `transition()` (:127, own tx, emits `gate.decided` at terminal), `createGateResult` terminal-insert path (:85), `reportExternalGate` in-place CAS path (:363, rides caller's handle).
- **Test conventions**: integration = `lib/**/*.integration.test.ts` + `app/**/*.integration.test.ts` (vitest.workspace.ts:31, 60s timeouts), testcontainers `postgres:16-alpine`, migrations via `drizzle-orm/node-postgres/migrator` against `./lib/db/migrations`. Canonical model to mimic: `web/lib/webhooks/__tests__/emit-run-status.integration.test.ts` (same-tx capture + CAS-winner-only assertions). `migration-journal-integrity.test.ts` guards journal bijection.

## Design Decisions (DD1–DD11, resolved)

### DD1 — New `domain_events` table; webhooks outbox is NOT generalized in place
`webhook_events.run_id NOT NULL` + its delivery-tier columns (`payload`, `fanout_at`) disqualify in-place generalization. `domain_events` is the durable domain fact log; `webhook_events` remains the webhooks-private capture until that feature's drainer is re-pointed (future stage, note in its plan). **Accepted transitional duplication**: run-terminal/gate sites emit BOTH `emitWebhookEvent` and `emitDomainEvent` in the same tx — mechanical, grep-auditable, removed when webhooks migrates.

### DD2 — Schema
`domain_events` (append-only; no UPDATE/DELETE app paths):

| column | type | notes |
|---|---|---|
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` PK | dispatch ordering key |
| `kind` | `text NOT NULL` + CHECK (DD6 set) | |
| `project_id` | `text NOT NULL` FK projects ON DELETE CASCADE | all stage-2 kinds are project-scoped |
| `task_id` | `text` NULL, FK tasks ON DELETE CASCADE | task.* kinds |
| `run_id` | `text` NULL, FK runs ON DELETE CASCADE | run.*/gate.* kinds |
| `actor_type` / `actor_id` | `text` NULL + CHECK `actor_type IN ('user','system','agent')` | polymorphic, mirrors ADR-083 `task_activity` |
| `payload` | `jsonb NOT NULL` | kind-specific (DD8) |
| `occurred_at` | `timestamptz NOT NULL` | domain time |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `tx_id` | `xid8 NOT NULL DEFAULT pg_current_xact_id()` | commit-visibility horizon (DD3) |

No secondary indexes this stage (dispatch reads by PK range; webhooks `webhook_events` precedent also carries no FK indexes; events are triggers, not a query surface). CASCADE matches the webhook_events precedent — `task_activity` remains the durable audit; `domain_events` rows are trigger material.

`domain_event_consumers`:

| column | type |
|---|---|
| `consumer_id` | `text` PK |
| `cursor_event_id` | `bigint NOT NULL DEFAULT 0` |
| `lease_expires_at` | `timestamptz` NULL |
| `last_dispatched_at` | `timestamptz` NULL |
| `last_error` | `text` NULL |
| `consecutive_failures` | `integer NOT NULL DEFAULT 0` |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

Migration `0046_domain_events.sql` is produced by `drizzle-kit generate` from schema.ts changes (xid8 via `customType` + `default(sql\`pg_current_xact_id()\`)`) — NOT hand-written SQL (snapshot-staleness gotcha, see Risks).

### DD3 — Cursor + claim mechanics (the correctness core)
Per-consumer **cursor row with CAS lease**; reads gated by an **xid8 commit horizon**:

1. **Claim (CAS, satisfies "no double-claim under concurrent ticks")**: `UPDATE domain_event_consumers SET lease_expires_at = now() + 5min WHERE consumer_id = $1 AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING cursor_event_id` — zero rows ⇒ another claimer is live ⇒ skip this consumer. Defense in depth on top of the scheduler's budget=1 + job lease.
2. **Read window**: `SELECT … WHERE id > $cursor AND tx_id < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY id LIMIT $batch` (batch = 100). The horizon predicate solves the identity-out-of-order-commit hole: an open tx holding a lower `id` holds back ALL later events until it resolves, so the cursor can never skip a late-committing event. (Pure `id > cursor` without the horizon is the classic lost-event bug — explicitly rejected.)
3. **Invoke** `consumer.handle(events)` (side effect outside our tables).
4. **Advance (fenced CAS)**: `UPDATE … SET cursor_event_id = $lastId, lease_expires_at = NULL, consecutive_failures = 0, last_dispatched_at = now() WHERE consumer_id = $1 AND cursor_event_id = $cursorReadAtClaim` — a zombie ticker whose lease was reaped cannot clobber a newer cursor.
5. Loop 2–4 up to `MAX_BATCHES_PER_TICK = 10` while batches come back full (flood control; remainder next tick).

Failure classification (two-phase-commit rule):

| Failure | Row state after | Next tick |
|---|---|---|
| `handle()` throws | cursor unchanged; `lease_expires_at = NULL`; `consecutive_failures++`; `last_error` set; WARN log | redelivers same window (at-least-once) |
| process crash mid-handle | lease held until TTL (5 min) | claim CAS succeeds after expiry → redelivery |
| zombie advance after reap+reclaim | cursor-CAS no-ops | duplicates possible, never lost events |

Crash windows enumerated: (a) after claim / before handle — lease expiry rescues; (b) after handle / before advance — redelivery. Both are tested. **Consumer contract: handlers MUST be idempotent** (documented in analytics doc + ADR). No poison-pill auto-disable this stage — retry forever + `consecutive_failures` observability (real-consumer concern, deferred with rationale).

### DD4 — Dispatcher = singleton M24 job; ADR #1 preserved
New job kind `domain_event_dispatch`, singleton row `domain_event_dispatch.default`, cadence 60s, budget 1, seeded by `ensureDefaultSchedulerJobs` (`ON CONFLICT DO NOTHING`). **Excluded** from `job-admin-schema.ts` (not user-creatable — `run_schedule` precedent). No fs.watch/chokidar/polling-for-run-state: capture rides the existing domain write path; the tick draining a DB queue is the sanctioned M24 clock doing queue work (same argument as ADR-077 DQ1); the dispatcher drives only consumer-cursor state, never run state. Live path = emission inside the domain tx + tick dispatch; recovery = the same cursor on the next tick after any outage (no separate sweep machinery needed — the cursor IS the catch-up).

### DD5 — Consumer registry seam + no-op consumer
Code-level registry `DOMAIN_EVENT_CONSUMERS: DomainEventConsumer[]` in `web/lib/domain-events/consumers.ts`:
```ts
interface DomainEventConsumer {
  id: string;                          // cursor row key, e.g. "noop"
  startFrom: "beginning" | "now";      // first-registration cursor: 0 | MAX(id)
  handle(events: DomainEvent[]): Promise<void>;
}
```
`ensureConsumerRows()` runs at the start of each dispatch job (`INSERT … ON CONFLICT DO NOTHING`; `startFrom:"now"` seeds cursor with `COALESCE(MAX(id),0)` in the same statement). Removing a consumer from the registry leaves its row dormant (documented; cleanup deferred until pruning exists). Ships with one registered `noop` consumer (`startFrom:"now"`, DEBUG-logs `{count, fromId, toId}`, no side effects) — proves the seam live in prod and doubles as an ops liveness signal. Owner-confirmed (2026-06-11): permanently registered, not test-only. Tests register their own recording consumers via an injection point (registry override parameter on the dispatch service — no module mutation).

### DD6 — Kind taxonomy (`web/lib/domain-events/taxonomy.ts`)
`DOMAIN_EVENT_KINDS = ["task.created", "task.comment_added", "task.triage_requeued", "run.done", "run.failed", "run.crashed", "run.abandoned", "gate.failed"]` (as-const + type guard + DB CHECK). `run.*` terminal set = exactly the 4 terminal run statuses. `task.triage_requeued` is **registered with no emitter** (emitter lands with the Stage-3 triager; documented in the analytics doc with a Designed tag). Extension rule mirrors ADR-077: one taxonomy entry + emit site(s) in the owning domain tx + one doc row (+ CHECK update via migration).

### DD7 — Emission sites (enumerated inventory; line numbers are anchors, not contracts — re-grep at implementation)
New helper `emitDomainEvent({db, kind, projectId, taskId?, runId?, actor?, payload, occurredAt?})` in `web/lib/domain-events/outbox.ts` — single INSERT, dual db/tx handle (copy the `web/lib/webhooks/outbox.ts` pattern).

| Kind | Site (same tx as the domain write) |
|---|---|
| `task.created` | `web/lib/services/tasks.ts` `createTask` tx (:68) — alongside `recordTaskActivity` |
| `task.comment_added` | `web/lib/social/comments.ts` `addTaskComment` tx (:59) |
| `task.triage_requeued` | none this stage (Stage-3 triager) |
| `run.failed` | `state-transitions.ts:218` (failResumedRun); `runner.ts:921`; `runner-graph.ts` Failed flip; `keepalive-sweeper.ts:500` (time-limit watchdog); `services/hitl.ts:672` (respond-failure Failed branch) |
| `run.crashed` | `state-transitions.ts:479/539` (crashResumedRun/crashRunningRun); `runner.ts:356/897`; `runner-graph.ts` Crashed flips; `runner-agent.ts` crash path; `scratch-runs/service.ts:554`; `hitl.ts` Crashed branch |
| `run.done` | `promote.ts` 3 finalize paths (local_merge / PR / scratch); `runner-graph.ts` Done flip |
| `run.abandoned` | `state-transitions.ts:412` (markAbandoned); `workbench-lifecycle/service.ts` dropWorkbench Abandoned path; **`keepalive-sweeper.ts` `runPass2` (:269)** — currently TWO bare updates (runs CAS flip :269 + `hitl_requests` close-out :295, verified): fold BOTH into one `db.transaction` + emit BOTH the domain event AND the previously missing webhook `run.abandoned` (owner-approved gap closure, 2026-06-11) |
| `gate.failed` | `gate-store.ts` `transition()` when new status = `failed` (:151 region); `createGateResult` terminal-insert path when initial status = `failed` (:85 region); `reportExternalGate` in-place CAS path failed case (:363 region — emit must share the CAS statement's tx: wrap CAS+emit in one tx there) |

Acceptance grep gate (recorded in T6): every `emitWebhookEvent` call with `type ∈ {run.done, run.failed, run.crashed, run.abandoned}` has an adjacent `emitDomainEvent`; `gate.decided` terminal-failed paths pair with `gate.failed`; plus the three webhook-less sites above (`createTask`, `addTaskComment`, `runPass2`). Scratch runs (`run_kind=scratch`) are **included** (consumers filter; `payload.runKind` carries the discriminator).

### DD8 — Payload shapes (typed, minimal; no secret material by construction)
- `task.created`: `{taskKey, title}`; actor = creator via `actorForUserId(ctx.actorUserId)` (`web/lib/social/activity.ts`); `taskKey` = `${projects.taskKey}-${number}` where number = allocated − 1 — both available in-tx (verified).
- `task.comment_added`: `{taskKey, commentId, mentionedTaskIds?}`; actor = commenter (`SocialActor`); `expandMentions` returns mentioned task **ids**, not keys (verified).
- `run.done|failed|crashed|abandoned`: `{runId, taskId?, flowId?, runKind, reason?}`; actor = `system` (or user for explicit abandon).
- `gate.failed`: `{runId, gateId, gateKind, gateResultId, nodeAttemptId, blocking}` (gate rows anchor on `nodeAttemptId`, not a bare node id — verified at implementation).
The envelope IS the row (id, kind, occurredAt, projectId, taskId, runId, actor, payload). No frozen delivery envelope — that is consumer-tier concern (webhooks builds its own at its fanout).

### DD9 — Contract surfaces → spec files (skill-context rule)

| Surface | Spec artifact |
|---|---|
| `domain_events`, `domain_event_consumers` tables | migration `0046` + `docs/database-schema.md` narrative + **new** `docs/db/domain-events.md` Mermaid ERD |
| Scheduler job kind `domain_event_dispatch` | `docs/system-analytics/scheduler.md` (Domain entities + Expectations) + `docs/system-analytics/domain-events.md` |
| Event-kind taxonomy + same-tx emit discipline + consumer contract | **new** `docs/system-analytics/domain-events.md` (R5 sections) + ADR-086 |
| SDD freeze (Stage-2 durable record, replaces the lost design doc) | **new** `.ai-factory/specs/domain-event-outbox.spec.md` (T11) |
| Webhooks takeover path | ADR-086 + note appended to `.ai-factory/plans/feature-outbound-webhooks.md` |
| HTTP routes / SSE / OpenAPI / AsyncAPI / error codes / Flow DSL | **none changed** — no external wire surface this stage (stated deliberately) |

### DD10 — Deployment touchpoints: none (deliberate)
No new env vars (cadence 60s / batch 100 / lease 5min / max-batches 10 are code constants — tuning knobs arrive with the first real consumer), no ports, no sidecars, no config files, no compose/.env.example changes. `MAISTER_CRON_TOKEN` + external cron already drive the tick.

### DD11 — Retention: none this stage
`domain_events` is unbounded append-only for now (low volume: ~1-2 terminal events/run + task/comment activity). Pruning lands with the first real consumer and MUST honor `min(cursor_event_id)` across registered consumers — recorded in ADR-086 + analytics doc as a deferred-with-guard decision.

## Specification: acceptance criteria (SDD traceability)

Task-mandated scenarios → tests (all integration, real Postgres via testcontainers):

| # | Mandated criterion | Test |
|---|---|---|
| AC1 | Transactional emission — event visible **iff** the domain write committed | T-E1/E2 (helper commit/rollback), T-E3 (`createTask` + injected failure → no task AND no event), T-E4 (`addTaskComment` symmetric) |
| AC2 | Cursor isolation between consumers | T-D1 (A advances; B unaffected; both eventually see all events) |
| AC3 | No double-claim under concurrent ticks | T-D2 (concurrent dispatch invocations, recording consumer: each event handled exactly once) + T-D6 (zombie advance fenced) |
| AC4 | Catch-up after simulated clock outage | T-D3 (backlog accumulated while dispatcher quiet → one tick drains it via batch loop; scheduler-side no-backfill arithmetic already proven in `jobs.integration.test.ts:85-101`) |

Additional invariants under test: T-E5 run-terminal paired emission incl. CAS-loser → zero rows (mimics `emit-run-status.integration.test.ts`); T-E6 `gate.failed` only on failed (passed ⇒ no domain event); T-E7 `runPass2` tx-wrap + emit; T-D4 at-least-once on handler throw (no advance, `consecutive_failures++`, redelivery, success resets); T-D5 xid8 horizon (open earlier tx holds back later committed events; commit releases both in id order); T-D7 `startFrom:"now"` semantics; T-D8 singleton job seeding. Unit: taxonomy set + guard; `jobs.test.ts` budget round-trip extended with the new kind.

Runnability (skill-context rule): all new integration files live under `web/lib/domain-events/__tests__/*.integration.test.ts` — already matched by the `lib/**/*.integration.test.ts` glob (vitest.workspace.ts:31); unit files match the unit project glob. No runner-config change needed (verified).

Existing tests requiring migration (enumerated): `web/lib/scheduler/__tests__/jobs.test.ts` (kind round-trip array gains `domain_event_dispatch`); `web/lib/scheduler/__tests__/jobs.integration.test.ts` (if seed assertions enumerate the exact default-job set, extend); any exhaustive-switch type assertions in `tick-service` tests.

## Commit Plan
- **Commit 1** (T1-T2, T11): `docs(domain-events): ADR-086 + analytics/ERD/spec-freeze artifacts for the domain-event outbox (Designed)`
- **Commit 2** (T3): `feat(domain-events): domain_events + consumer cursor schema, migration 0045, kind taxonomy`
- **Commit 3** (T4-T6): `feat(domain-events): transactional emitDomainEvent + emission at task/run/gate sites`
- **Commit 4** (T7-T9): `feat(domain-events): cursor dispatcher seam on the M24 clock + noop consumer`
- **Commit 5** (T10): `docs(domain-events): flip to Implemented, roadmap M32, close-out gates`

## Tasks

### Phase 0 — SDD artifacts (docs-first; exit = complete & internally consistent specs, validators green)

- [x] **T1. ADR-086 + system-analytics spec.** Append `### ADR-086: Domain-event outbox as shared trigger bus` to `docs/decisions.md` (context: ADR-077 reopen→generalization path, Stage 2 of platform-agents design; decisions DD1-DD11 condensed; webhooks-takeover plan; rejected alternatives: in-place webhook_events generalization, fanout-marker tables for N consumers, cursor-without-horizon). Create `docs/system-analytics/domain-events.md` per R5: Purpose; Domain entities (event, consumer cursor, dispatcher job, taxonomy incl. emitter-less `task.triage_requeued`); State machine (consumer-cursor lifecycle: idle→claimed→advanced/failed/reaped); Process flows (emit-in-tx, dispatch tick, catch-up, late-committing-tx horizon hold-back); Expectations (MUST list: same-tx emission, append-only, at-least-once, idempotent consumers, CAS claim, fenced advance, horizon predicate, no-prune-this-stage + min-cursor guard rule, ADR-#1 compliance); Edge cases (open long tx head-of-line, lease expiry mid-handle, consumer removed from registry, zombie advance, empty registry); Linked artifacts. Implementation-status tags: **Designed** (R6). Logging: n/a (docs). Verify: `pnpm validate:docs:all` green; every transition/refusal stated exactly as code will gate it.
- [x] **T2. ERD pair + scheduler doc + webhooks-plan note.** *(Done: global `erd.md` deliberately deferred to T10 — it draws implemented tables only; `runPass2` webhook emit extends `run.abandoned` `source` enum with `"ttl"` — asyncapi + analytics-doc rows sync in T6.)* New `docs/db/domain-events.md` (Mermaid `erDiagram`: domain_events, domain_event_consumers, FK edges to projects/tasks/runs) + `docs/database-schema.md` narrative section (both artifacts — never one without the other) + a row in the `docs/db/README.md` index + check whether the global `docs/db/erd.md` diagram needs the two tables. `docs/system-analytics/scheduler.md`: add `domain_event_dispatch` to Domain entities + an Expectations bullet (singleton, cadence 60s, budget 1, not user-creatable, cursor catch-up semantics) tagged Designed. Append a short "Domain-event outbox takeover (M32+)" note to `.ai-factory/plans/feature-outbound-webhooks.md`: ADR-086 owns the generic outbox core; the webhooks fanout pass is re-pointed at `domain_events` in a later stage (webhooks becomes a registered consumer; `webhook_events` then retires); until then both outboxes coexist by design; M32 also closes the `runPass2` `run.abandoned` webhook-emit gap (see T6). Logging: n/a. Verify: docs validators green; mermaid renders (note the `;`-in-note gotcha).
- [x] **T11. SDD spec freeze.** Create `.ai-factory/specs/domain-event-outbox.spec.md` (repo convention — newest precedent `acp-opencode-gemini-adapters.spec.md`, "SDD freeze for Phase 0"): Purpose; scope-source note (the lost design doc is NOT restored — this spec + ADR-086 + the roadmap row are the durable record, owner decision 2026-06-11); table + consumer-cursor + dispatcher contracts (DD2/DD3 condensed, incl. the xid8 horizon rule and the failure-classification table); kind taxonomy + payload shapes (DD6/DD8); AC traceability (AC1-4 → named tests); explicit non-goals (no real consumers, no retention/pruning, no HTTP/SSE surface, no webhooks migration yet). Status header: "SDD freeze for Phase 0. No production code is implemented by this spec." Depends on T1. Logging: n/a. Verify: internally consistent with ADR-086 + the analytics doc (no contradicting numbers/kinds); `pnpm validate:docs:all` unaffected. *(Commit checkpoint 1.)*

### Phase 1 — Schema (exit: migration applies on fresh DB, suites green)

- [x] **T3. Drizzle schema + migration 0045 + taxonomy module.** *(Done; bonus: 24 integration fixtures + 2 typecheck reds repaired — pre-existing gemini×social-board cross-merge debt on main, commit 1cb2a890.)* `web/lib/db/schema.ts`: `domainEvents` + `domainEventConsumers` tables per DD2 (xid8 via `customType` + `default(sql`pg_current_xact_id()`)`; kind CHECK from taxonomy; actor CHECK; identity PK) + inferred types. `web/lib/domain-events/taxonomy.ts`: `DOMAIN_EVENT_KINDS` as-const, `DomainEventKind`, `isDomainEventKind`. Generate `web/lib/db/migrations/0046_domain_events.sql` with `drizzle-kit generate` (NO hand-written SQL — snapshot gotcha; verify `meta/_journal.json` entry appended without editing prior `when` values). Tests (TDD): `web/lib/domain-events/__tests__/taxonomy.test.ts` (set + guard) written first; `migration-journal-integrity.test.ts` stays green; any existing integration test boot proves the migration applies. Logging: n/a. Verify: `pnpm typecheck` 0, `pnpm test:unit && pnpm test:integration` green. *(Commit checkpoint 2.)*

### Phase 2 — Emission (TDD: tests first per task)

- [x] **T4. `emitDomainEvent` helper (test-first).** Write failing `web/lib/domain-events/__tests__/emit.integration.test.ts`: T-E1 insert inside committed tx → row visible with kind/ids/actor/payload/`tx_id` populated; T-E2 tx rollback → zero rows. Then implement `web/lib/domain-events/outbox.ts` (`emitDomainEvent`, dual db/tx handle copied from `web/lib/webhooks/outbox.ts`; input typed per DD8). LOGGING: DEBUG `[domain-events.emit] {kind, projectId, taskId?, runId?}` (no payload dump). Verify: new tests green, suites green.
- [x] **T5. Task-domain emission (test-first).** Failing tests first (extend emit suite or `emit-sites.integration.test.ts`): T-E3 `createTask` → exactly one `task.created` row, same-tx (injected post-insert failure ⇒ no task AND no event); T-E4 `addTaskComment` → `task.comment_added` with `mentionedTaskKeys`, symmetric rollback. Then wire `emitDomainEvent` into `createTask` tx (`web/lib/services/tasks.ts:68` region) and `addTaskComment` tx (`web/lib/social/comments.ts:59` region) — alongside `recordTaskActivity`, actor propagated from the authenticated caller (Stage-1 coordination point: emission lands in merged Stage-1 code now). LOGGING: covered by T4 helper. Verify: suites green; `task_activity` behavior unchanged.
- [x] **T6. Run-terminal + gate emission sweep (test-first).** *(Done: 22 webhook-terminal sites paired + runPass2 dual-emit tx; grep-gate 22/22; asyncapi `source` enum +ttl; emitDomainEvent is a plain INSERT — unit fakeDb stubs don't implement `.returning()`.)* Failing tests first mimicking `web/lib/webhooks/__tests__/emit-run-status.integration.test.ts`: T-E5 `markAbandoned`/`failResumedRun`/`crashRunningRun`/`crashResumedRun` each produce exactly one paired domain event; CAS-loser produces zero; promote-path `run.done`; T-E6 gate `transition()` to failed ⇒ `gate.failed`, to passed ⇒ none; T-E7 `runPass2` TTL abandon ⇒ ONE tx folding BOTH bare updates (runs flip :269 + `hitl_requests` close-out :295) AND emitting BOTH `run.abandoned` domain + webhook events. Then add `emitDomainEvent` adjacent to every DD7 site (re-grep inventory at implementation; line anchors may drift), wrap `runPass2` in `db.transaction` folding BOTH bare updates (runs flip + `hitl_requests` close-out) and emitting BOTH the domain event and the previously missing webhook `run.abandoned` (owner-approved; also sync the `run.abandoned` emit-site row in `docs/system-analytics/outbound-webhooks.md`), and wrap the `reportExternalGate` in-place CAS path (`casLiveTransition` + webhook emit + domain emit) in one tx — nested-tx/savepoint is safe on drizzle pg; the `GateNotReportableError` throw moves inside the tx, rollback semantics unchanged. Record the DD7 grep-gate output in the task notes. LOGGING: helper-level. Verify: suites green; grep gate clean (no terminal webhook emit without a domain pair; no unpaired site). *(Commit checkpoint 3.)*

### Phase 3 — Dispatcher seam (TDD)

- [x] **T7. Dispatch integration test suite (written first, failing).** `web/lib/domain-events/__tests__/dispatch.integration.test.ts` against the DD3/DD5 service API (recording consumers injected via registry parameter): T-D1 cursor isolation; T-D2 concurrent dispatch (Promise.all ×2) → each event handled exactly once per consumer; T-D3 catch-up (N=250 backlog events, one dispatch run drains via batch loop ≤ MAX_BATCHES); T-D4 handler throw → no advance + `consecutive_failures`=1 + `last_error` set + redelivery next run + success resets to 0; T-D5 horizon: connection A opens tx and inserts (uncommitted), connection B inserts + commits later id → dispatch sees nothing; A commits → next dispatch delivers both in id order; T-D6 zombie advance after lease reap+reclaim no-ops (cursor CAS); T-D7 `startFrom:"now"` consumer registered after N events starts at MAX(id). Logging: n/a (tests). Verify: suite fails for the right reason (service not implemented), typecheck green.
- [x] **T8. Cursor dispatcher service + registry + noop consumer.** *(Impl note: lease is held across batches and released by the final advance or the empty-read path — both fenced; the empty-read release was a TDD-caught leak.)* `web/lib/domain-events/consumers.ts` (interface + `DOMAIN_EVENT_CONSUMERS` with `noop`) and `web/lib/domain-events/dispatch.ts` (`ensureConsumerRows`, `dispatchDomainEvents({db?, now?, consumers?})` implementing DD3 steps 1-5 exactly: CAS claim, horizon read window, fenced advance, failure accounting, batch loop). LOGGING (verbose): INFO `[domain-events.dispatch] {consumer, claimed, fromId, toId, count, ms}` per batch; WARN `[domain-events.dispatch] consumer failed {consumer, consecutiveFailures, error}`; DEBUG `[domain-events.noop] {count, fromId, toId}`; DEBUG skip-on-lease. Verify: T7 suite fully green; suites green.
- [x] **T9. Scheduler wiring (fan-out checklist).** *(Fan-out found an undocumented 4th registration point: claimDueJobs' SQL budget CTE hardcodes kind→budget in a VALUES list + 3 CASE expressions — all extended.)* Add `domain_event_dispatch`: kind union + Drizzle enum (`web/lib/db/schema.ts:566-595`), `SCHEDULER_JOB_KINDS` (`jobs.ts`), `schedulerBudgetForKind` case, `budgets.ts` key (`domainEventDispatch: 1`), `tick-service.ts` switch arm → new `web/lib/scheduler/handlers/domain-event-dispatch.ts` (thin: calls `dispatchDomainEvents`), `ensureDefaultSchedulerJobs` seed block (`domain_event_dispatch.default`, cadence 60s), **deliberately NOT** added to `job-admin-schema.ts` (singleton; run_schedule precedent). i18n (verified contract): add `domain_event_dispatch` to the scheduler `kind` label map in `web/messages/en.json` (~:1149) AND `ru.json` — non-creatable kinds DO appear there (`run_schedule` precedent); do NOT add a `targetHint` entry (`run_schedule` precedent — singletons are not offered by the edit modal). Migrate enumerated existing tests (jobs.test.ts round-trip; jobs.integration.test.ts seed-set assertions if exact). Test (TDD): T-D8 seeding test mirroring `webhook-delivery.integration.test.ts` (`ensureDefaultSchedulerJobs` creates the singleton; tick with `jobKind=domain_event_dispatch` claims and runs it). LOGGING: handler INFO start/finish `{consumers, totalDispatched}`. Verify: suites green; fan-out grep (`domain_event_dispatch` present in schema enum, SCHEDULER_JOB_KINDS, budgetForKind, budgets, tick switch, seed, docs — and absent from job-admin-schema) recorded. *(Commit checkpoint 4.)*

### Phase 4 — Close-out

- [x] **T10. Docs flip + roadmap + full gates.** *(Final gates: tsc 0; scoped eslint 0 errors; unit 313 files / 3630; integration 161 files / 1265 — all green; validate:docs:all 198/198 mermaid + 440 anchors; asyncapi valid. Bonus catch at gate time: hitl.ts HITL_TIMEOUT site uses a DYNAMIC ternary type the literal grep missed — paired + 3 fakeDb stubs taught domain_events.)* Flip Designed→Implemented tags in `docs/system-analytics/domain-events.md`, `scheduler.md` rows, `docs/db/domain-events.md`, `database-schema.md`; ADR-086 status stays Accepted with implementation note. Add roadmap row `M32. Domain-event outbox core (shared trigger bus)` via `/aif-roadmap` (owner command). One-line "Built since" mention in root `CLAUDE.md` (docs-wins sync). Re-verify ADR/migration numbering against live main before merge (renumber recipe in Risks if contested). FULL gate: `pnpm typecheck` 0, scoped eslint clean (NEVER bare `pnpm --filter maister-web lint` — it reformats the repo; use `eslint <changed paths>`), `pnpm test:unit`, `pnpm test:integration`, `pnpm validate:docs:all`; DD7 + T9 grep gates re-run and recorded. e2e: no UI/HTTP surface was touched — run the e2e suite only as a regression check if time permits; any reds must be proven pre-existing on main before blaming this branch (shared-infra trap: kill :3100/:7788 first). LOGGING: n/a. *(Commit checkpoint 5.)*

## Risks & notes
- **ADR/migration collision**: ADR-086 + migration 0045 verified free against main @ c104f66b (2026-06-11, post-rebase — the original ADR-084/0044 claim was already taken once by the gemini/opencode commit and renumbered, proving the recipe). If a new sibling lands first: renumber with the reserve-the-slot recipe (highest-first substitution, both `ADR-` and lowercase `adr-` anchor forms need a second sed pass; `validate-docs-adr-anchors` is blind to `_` slugs; journal idx gaps are safe — `migration-journal-integrity.test.ts` catches mistakes).
- **Drizzle xid8 + identity**: `customType` for `xid8` with a SQL default is unusual — confirm `drizzle-kit generate` emits it; if manual SQL touch-up is unavoidable, follow the snapshot-repair recipe (never edit prior `_journal.json` `when` values — "already exists" on db:migrate is that drift).
- **Horizon head-of-line**: one long-running open tx anywhere in the DB stalls dispatch past its first inserted event until it resolves. Acceptable: domain txs are short; migrations run offline. Documented in Edge cases.
- **Transitional double-emission**: run/gate sites write both `webhook_events` and `domain_events` rows until the webhooks drainer migrates. Bounded, documented in ADR-086.
- **Emit-site drift**: DD7 file:line anchors verified 2026-06-11 @ c104f66b — re-grep at implementation time (T6 includes the sweep as its acceptance gate).
- **`runPass2` webhook gap (RESOLVED — owner yes, 2026-06-11)**: NeedsInputIdle→Abandoned TTL today emits NO `run.abandoned` webhook (pre-existing ADR-077 gap). T6 pairs BOTH emits inside the new tx and syncs the webhooks analytics emit-site table.
- **Identifiers/trust boundary**: no HTTP routes added — N/A by construction (dispatcher inputs are server-state only).

## Resolved questions (owner, 2026-06-11)
1. runPass2 (idle-TTL abandon): **да** — pair the missing webhook `run.abandoned` emit with the domain emit inside the new tx (T6).
2. `noop` consumer: **постоянно** — permanently registered in the prod registry (DD5).
3. Design doc: **not restored** — the roadmap + per-stage specs/ADRs are the durable record of the staged design.

No open questions remain.
