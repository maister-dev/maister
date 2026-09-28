# Fix Plan: whole-branch review remediation — outbox pressure fence, skipped-terminal quarantine, queue backstop, HITL/interrupt UX (ADR-183/184)

**Problem:** the whole-branch `/aif-review` of `claude/outbox-pressure-semantics-5a2eff` over `master`
(HEAD `5f914f09`) confirmed five merge blockers and ~30 minor/nit findings. Verdicts with evidence:
`scratchpad/review-verdicts.md` of session 5ba84a38 (copied into the Analysis below; the plan is
self-contained).
**Created:** 2026-09-28 16:40
**Branch:** `claude/outbox-pressure-semantics-5a2eff` — work here, never push, never merge.
**Mode:** SDD first (Phase 0: amendments, analytics, contracts, gate-clean), then TDD (RED → GREEN,
each guard falsified), one commit per phase, no `Co-Authored-By` trailer.

## Owner decisions (2026-09-28)

1. **(1a)** The host carries the refusal cause on the wire and publishes in `GET /health` whether it
   admits new work; the manager clears its pressure record by that signal, never by the unACKed-only
   `pressured` bit.
2. **(2a)** A prompt whose terminal sequence sits in `execution_event_skips` is quarantined visibly with
   a typed cause — v1 and v2 commands alike.
3. **(3a)** ADR-183 D11 stays: a refused agent *generation* dispatch fails the run
   (`agent_session_create_failed`); the ADR records the window it is now confined to.
4. **(4 yes)** Keep-alive Pass 2 never TTL-abandons a host-parked run.
5. **(plan Q1 a)** The unsettled-quarantine class is fixed whole in this branch: flow (live session or
   not), agent and scratch owners end it visibly; the watchdog stops deferring it.
6. **(plan Q2 a)** Pass 2 excludes every run with `resume_requested_at IS NOT NULL` (plus the flow
   host-pressure interrupt predicate); no migration.
7. **(plan Q3 a)** The auto-resume backs off exponentially (cap 16 ticks) with an ERROR line; it never
   gives up and never reopens an answered row.

## Analysis

### Blockers (all confirmed in source at `5f914f09`)

**M2 — the pressure fence flaps on refusals that are not unACKed pressure.**
`runtimeEventSupervisorError` (`supervisor/src/http-api.ts:320-357`) folds every outbox reason onto
the one wire token `409 PRECONDITION event_outbox_backpressure`: unACKed soft
(`assertOutboxAdmission`, `outbox-budget.ts:373`), retained ≥ hard (`assertRetainedBelowHard`,
`:394`; regular append `:777`), producer control capacity (`reserveProducerWallet`, `:472`), per-wallet
teardown serialization / credit (`admitTeardown`, `:592/:607/:632`; control spends `:786/:817/:838`),
and physical SQLite headroom — which is even minted internally as `event_outbox_soft_limit`
(`assertPhysicalAdmission`, `host-state.ts:981-991`). The folding predates the branch; the branch made
it load-bearing: the manager's refusal writer (`deliverer.ts:357-393, 776-812` →
`recordHostPressureRefusal`) closes the admission fence on ANY such refusal, while
`recordHostPressureSample` (`host-pressure.ts:123-228`) deletes the record whenever
`stream.pressured` (unACKed only) is false. Under low disk / a full state file / retained at hard,
every `system_sweep` tick clears the record, auto-resumes host-paused interrupts, drains the queue
into fresh refusals (flow: a new `node_interrupt` + `run.escalated` + webhooks per run per tick;
agent generation: `Failed`), then the next refusal closes the fence again. Adjacent race (adversarial
F2): a sample fetched before a refusal commits deletes the fresher refusal record (no timestamp
compare). Adjacent surface: the admin `PressureCell` (`web/components/admin/execution-host-status.tsx:203-240`)
shows "clear" for a host that refuses new work for any non-unACKed reason.

**M1 — a prompt whose terminal row is a skip hangs silently.** Ingest records an unstorable terminal
(`22P05/22P02/22021`, e.g. a NUL) in `execution_event_skips` (`ingest.ts:1644-1700`) and the frontier
walks past it. ADR-184 D3.7 then answers `canonical_available` (`prompt-span-pages.ts:141-142, 212-213`)
and `attemptHostSpan` records no verdict (`prompt-reconciliation.ts:343-349`), but the canonical feed
cannot settle it: `reconcileStoredPromptEvidence` (`prompt-evidence.ts:705-760`) finds no
`execution_events` row and returns `waiting`; the projector never reads skips. Nothing fails the
command; the stream is healthy, so the stream-lost resolver never engages. Pre-branch the host span
settled it and the owner's canonical read failed visibly with `event_span_gap`. v1 commands (no
`receiptSpan`) hung before the branch too. Downstream, an UNSETTLED quarantined prompt (the state this
fix creates, and one the existing `receipt_binding` / `receipt_shape` / `receipt_replacement` /
`*_protocol` quarantines already reach) has no visible end for a flow node with a live session (the
sweep `reattach`es, the driver yields again), for agent turns (continuation pending forever), for
scratch turns (yielded forever), and the watchdog's `completedTurnWitness`
(`keepalive-sweeper.ts:654-681`) defers it forever via the receipt probe. The wording "a skipped row
of the prompt's own run is unverifiable, as before" (ADR-184 L120-125, L213-215; EDGE-PRM-17) is false:
before ADR-184 the host served that row.

**M5 — a fence-queued `Pending` run can be stranded.** `applyHostPressureSample`
(`system-sweeps.ts:638-671`) drains the queue only on the `cleared` transition, after the record
delete committed in its own transaction. A process death in between, a throw from
`resumeHostPausedInterrupts` (its top-level selects are outside the per-row catch) or from the flow
pool's `promoteNextPending` (e.g. an agent C3 `EXECUTOR_UNAVAILABLE`, `scheduler.ts:1112-1118`) loses
the drain: later ticks see `clear` and promote nothing. No periodic promoter exists for the flow pool
(`agent_tick` covers the agent pool once per 60 s, `agents/triggers.ts:278`). Same effect when the
local host is re-registered: `localHostPressuredSince` joins only the non-retired host, so the fence
opens without any `cleared` transition.

**M3 — the HITL card mistreats a stored answer.** On `503 EXECUTOR_UNAVAILABLE
event_outbox_backpressure` the answer IS stored ("Your answer is saved; delivery is pending",
`hitl.ts:1495-1504`), but the card enters the stored/"Retry delivery" view only for
`delivery_unavailable` (`web/components/board/run-hitl-response.tsx:285-296`) and suppresses
`answerSaved` only for that key (`:797-798`): live option buttons plus a red error; after refresh
"Answer saved — delivery pending" and "Your answer was not delivered" together. Same predicate in the
scratch dialog (`web/components/scratch/scratch-conversation.tsx:580`). The copy
`run.errorReasons.event_outbox_backpressure` (`web/messages/{en,ru}.json:2667`) also says "running work
continues … your answer was not delivered", both false at the hard/physical bound.

**M4 — a host-paused interrupt's default action is destructive.** `deriveNodeInterruptOptions`
(`web/lib/runs/node-interrupt.ts:627-675`) always returns `defaultOptionId: "restart_node"`, and the
controls paint `restart_node` amber regardless (`node-interrupt-controls.tsx:199-213`). For
`cause: "host_pressure"` the card promises an automatic resume while the highlighted one-click action
discards the ACP context the park preserved and spends an operator restart.

### Minor / nit (confirmed; R = event plane, S = supervisor, U = UI, P = park/resume, D = docs, A = adversarial)

- R3 `web/lib/flows/graph/consensus/capacity.ts:35` reads `maxConcurrentAgentRunsCap()` unfenced; it is
  in neither ADR-183 D9's exemption list nor `execution-hosts.md`; `pool-cap-fence.test.ts` watches
  only `capForPool(`.
- R4 `web/test-support/execution-host-seed.ts:150-163` raw-SQL insert and
  `runtime-object-declarations-migration.integration.test.ts:41-43` `select({id})` justified by a false
  claim (0182 adds no `execution_hosts` column; no migration after 0162 alters it).
- R5 `wire-shape.test.ts:176` asserts a token (`event_outbox_hard_limit`) that never crosses the wire.
- R6 `prompt-span-pages.ts:325` `byId.get(item.id)!` → `TypeError` instead of typed `event_span_gap`;
  nit: `a.hostSequence!` on a non-nullable bigint (`:294-297`); unused exported `ExecutionHostPressure`
  type.
- R7 `prompt-output-frontier.integration.test.ts` foreign-skip case collects `events` and never asserts
  them nor that the read was canonical.
- S1 `host-state.ts:1365` a SUCCESSFUL frame reservation still `notifyCapacity()` → every paused producer
  retries into a refusal (linear; no listener gains — the pruner listener reads `snapshot.regular`).
- S2 the retained-pressure stall gate (`host-state.ts:3239-3243`) has no discriminating test (H3 stays
  green without it).
- S3 `ReceiptAdmission` is required for settle-phase writes that ignore it → fabricated values at
  `runtime-object-recovery.ts:91-94`, `command-receipts.ts:46,58`, tests.
- S4 `host-state.ts:1015` boot refresh runs before `observedPressure` is seeded → a boot flip is never
  logged (ADR-183 D2 "every flip logs").
- S5 `checkpoint-teardown.ts:27-28` "nothing branches on it" — `throwIfParkedByPressure` does.
- S6 `outbox-pressure-semantics.integration.test.ts:596` wall-clock `< 250 ms` adds flake, no
  discrimination.
- S7 `refreshOutboxPressure(…, nowMs = Date.now())` default at three in-transaction sites
  (`outbox-budget.ts:325, 371, 599`).
- S8 D3-perm (`producer-pause-bound.integration.test.ts`) asserts only the 410, not the prompt
  rejection `{session_checkpointed, cause: outbox_pressure}`.
- U3 copy — see M3. U4 `web/lib/queries/run.ts:857` `client as never`. U5 scratch host-paused notice
  (`scratch-conversation.tsx:825-833`) lacks the column's outer margin. U6 untested:
  `HitlDecisionControls → NodeInterruptControls` `cause` forwarding; `PressureCell` branches
  (`pressured && pressure === null`, `telemetry === null`). U7 run-header chip liveness — **no change**:
  a `Pending` page is static until the run starts, exactly like `queuePosition` (documented instead).
- P3a `docs/api/external/operations.openapi.yaml:1455-1468` ext launch 202 lacks `queueReason` (code
  returns it). P3b `hitl.ts:6053` answers `resume-in-progress` even when the claim was `deferred`
  (`resume-queued` exists in `web.openapi.yaml:7869`).
- P4 the in-process poison (`HOST_PRESSURE_RESUME_MAX_FAILURES = 3`, `hitl.ts:5724-5760`) stops the
  auto-resume AND the re-drive silently; an answered row has no card, a `NeedsInput` run keeps its slot.
- P5 tests: (a) `hitl-node-interrupt` idle cases flip `NeedsInputIdle` by direct UPDATE leaving the
  assignment active; W6 seeds a response without `actor`/`cause`; (b) the refused-create park-failure
  (W2) arm is untested (its recovery owner exists: the flow continuation worker admits a `Running`
  ai_coding attempt); (c) the `redriven` arm is untested.
- P6 `hitl.ts` `handleNodeInterruptResponse` maps any non-user actor to `system` (non-exhaustive).
- D1 `execution-event-plane.md:362` "ADR-184, Designed" → Implemented. D2 ADR-183 D5 table: file
  pressure gates only `session.*`. D3 ADR-183 D11: the slot hold is bounded by Pass 1 at
  `keepalive_until`. D4 "the one refusal" of a teardown — wallet credit exhaustion is a third.
  D5 `queueReason` prose (flow-run.md, runs.md, `PostRunResponse`) implies a cause discrimination the
  read model does not make (every `Pending` run while fenced). D6 `adr-167.md:339` stale span-stop clause
  lacks an inline supersession note. D7 `docs/supervisor.md:806-810` input 409 omits physical headroom.
  D8 "protected range" (`execution-event-plane.md:367`) now reads as the retired span stop. D9
  undocumented log lines: `command-refused-host-pressure`, `execution-host-pressure-record-failed`,
  `run-host-pressure-resumed`, `agent-turn-host-pressure-requeued`,
  `agent-dispatch-host-pressure-requeued`, `scratch-idle-resume-queued`.
- A3 → decision 4. A2 → M2 (stale-sample guard).
- Refuted (no change): X-EH test citations use plan ids like every sibling row; the refused-create W2
  arm does have a recovery owner.

## Design (normative for Phase 0)

### D-A — refusal cause on the wire + "admits new work" in health (M2, decision 1a)

- **Host internal reasons** become one per cause: `event_outbox_soft_limit` (unACKed only),
  `event_outbox_hard_limit` (retained / regular append at hard), new `event_outbox_physical_limit`
  (`assertPhysicalAdmission`), `event_outbox_terminal_reserve_exhausted` split by call site into
  `…_terminal_reserve_exhausted` (producer control capacity, `reserveProducerWallet`) and new
  `event_outbox_wallet_exhausted` (teardown serialization / credit, emergency and control spends).
- **Wire:** the token stays `409 PRECONDITION details.reason: "event_outbox_backpressure"` (compatible);
  new `details.outboxLimit: "unacknowledged" | "retained" | "physical" | "control" | "wallet"`.
  `outboxLimit` is required on every `event_outbox_backpressure` refusal; the OpenAPI
  `SupervisorErrorDetails` (`additionalProperties: false`) gains it; `REASON_TOKENS` unchanged.
- **Health:** `GET /health?stream` `stream.newWorkRefusedBy: "unacknowledged" | "retained" | "physical" |
  "control" | null` — null means a `session.create` with no output bindings and a `session.prompt`
  would pass every host-wide outbox gate right now. Computed on read in this order: persisted unACKed
  bit → `retainedAtThreshold(reservedRegularUsage)` at hard → `canAdmitPhysical()` (its WAL checkpoint /
  hysteresis side effects accepted, as `constrained()` already does — a cached flag could keep a
  healed host fenced forever) → producer control fit for `n = 0`. Per-wallet and file-budget
  (`runtime_storage_pressure`, 503) conditions are not host-wide outbox limits and stay out.
  `stream.pressured` keeps its meaning (unACKed episode).
- **Manager record (host-pressure.ts):** the record means "the host refuses new work".
  - Refusal writer: records for `outboxLimit ∈ {unacknowledged, retained, physical, control}` or when
    `outboxLimit` is absent (older host); a `wallet` refusal parks the command but closes no fence.
    `command-refused-host-pressure` logs `outboxLimit`.
  - Sample writer: with `newWorkRefusedBy` present, set/hold iff non-null, clear iff null; without it
    (older host) the current `pressured` rule. `unacknowledged_at_start` is filled only for
    `unacknowledged`.
  - Stale-sample guard: `recordHostPressureSample` takes `sampledAt` (manager clock captured BEFORE the
    health fetch, `system-sweeps.ts:449`) and deletes only `WHERE pressured_since <= sampledAt`; a
    fresher refusal record survives and the transition reads `held`.
- **Admin:** `PressureCell` shows a warn badge "refusing new work: {limit}" whenever
  `newWorkRefusedBy` is non-null; the unACKed episode block stays for `unacknowledged`.
- No migration (supervisor SQLite unchanged, Postgres unchanged).

### D-B — skipped terminal ⇒ typed quarantine that ends its owner (M1, decision 2a)

- **One choke point:** `reducePromptEvidence`'s null-evidence branch (`prompt-evidence.ts:316`, under
  `lockPrompt`), reached by every waiter / recovery / deposit / output read / stream-lost offer through
  `reconcileStoredPromptEvidence`. Condition: receipt present, `terminalEventId` and
  `terminalEvidenceSha256` null, and a skip row matches `receiptEvidence.eventId` (unique
  `execution_event_skips_event_unique`) with the same `execution_host_id`, `run_id`,
  `event_type = 'session.command'`; v2 additionally `event_stream_id` (via `(executionHostId,
  terminal.streamId)`) and `host_sequence = terminal.sequence`. Then `quarantine(tx, command,
  "terminal_unstorable")` → `application_error {reason: "prompt_terminal_conflict", phase: "prepare",
  causeCode: "terminal_unstorable"}`; ERROR `prompt-evidence-quarantined` names the skip reason. The
  reason stays `prompt_terminal_conflict`, so all ten existing consumers converge; no migration
  (`application_error` is unconstrained jsonb).
- **Post-hoc (host_span-settled, then the canonical terminal lands as a skip):** the confirmation step
  that today leaves `hostSpanUnconfirmed` forever quarantines it the same way (like the B3 post-hoc
  digest conflict), so retirement no longer reports `terminal_evidence_missing` forever.
- **D3.7 stays** (`canonical_available` → the canonical feed); its sentence becomes "settles or, for a
  skipped terminal, quarantines". ADR-184's "unverifiable, as before" becomes the truth: an own-run skip
  is no longer served from the host (the rescue ADR-184 retired), and is `event_span_gap`.
- **Every owner ends an UNSETTLED quarantined prompt visibly** (the class gap; also closes the
  pre-existing hang of `receipt_*`/`*_protocol` quarantines): `promptEvidenceConflict` carries
  `details.settled: false` and `causeCode`; an owner that sees `settled: false` stops yielding —
  flow node: the shared turn-lost boundary with `owner-poisoned` (run `Crashed`, cause `owner_poisoned`,
  the same outcome a settled quarantine gets), whether or not the session is live (the reattached driver
  hits the same check); agent turn: the run crashes `owner_poisoned` through the agent crash path;
  scratch turn: the turn fails, the dialog returns to `WaitingForUser` with
  `error_metadata {reason: "prompt_terminal_conflict", causeCode}` and the existing error notice.
  The watchdog's `completedTurnWitness` answers `null` for `quarantined`/`poisoned` before the receipt
  probe. (Scope fork — question 1 below.)

### D-C — queue backstop, isolated sweep steps (M5)

- `applyHostPressureSample` drains both pools on EVERY sample whose host admits new work (`clear` and
  `cleared`), not only on `cleared`: `promoteNextPending` is lock-, cap- and fence-checked and returns
  null at once when nothing is queued. The interrupt auto-resume, the flow drain and the agent drain
  each run in their own try/catch; failures go to the sweep's `errors`. Covers a crash between the
  delete and the drain, a throw in either step, and a re-registered host. The drain is skipped while
  the record exists (no fenced info line per tick).

### D-D — Pass 2 never abandons a host-parked run (decision 4)

- `fetchPass2Candidates` excludes (a) a flow run whose latest `node_interrupt` at `current_step_id` has
  `schema->>'cause' = 'host_pressure'` and is open or answered `resume`; (b) a run with
  `resume_requested_at IS NOT NULL` — the only durable trace of an agent host park (the cause is not
  persisted), and every other owed resume. (b) is broader than host pressure (question 2).

### D-E — the auto-resume never gives up silently (P4)

- The in-process poison becomes a per-row backoff (after k consecutive throws the row is retried after
  `2^(k-1)` ticks, capped at 16 ticks) for both the auto-resume and the re-drive; ERROR
  `run-host-pressure-resume-stuck {runId, hitlRequestId, failures}` at the third consecutive throw and
  every doubling after; a success resets. ADR-183 D11's "left to the operator" sentence is replaced.

## Fix Steps

### Phase 0 — SDD (docs only; gate-clean before any code). Commit: `docs(outbox-review): remediation SDD — refusal cause and new-work signal, skipped-terminal quarantine, queue backstop, Pass 2 exclusion`

1. [x] **ADR-183 amendment (dated 2026-09-28)** — D-A (internal reasons, `outboxLimit`, `newWorkRefusedBy`,
   record = "refuses new work", refusal writer skip for `wallet`, sample set/clear rule, stale-sample
   guard, older-host fallback), D-C, D-D, D-E; D5 table: split the physical / file column (file = `session.*`
   only, 503); teardown refusal wording "its wallet's serialization or exhausted credit"; D11: slot hold
   bounded by Pass 1 at `keepalive_until` (matches run-continuation W3); D11 agent bullet: the refused
   generation stays a failure (decision 3a) and is now confined to pressure arising between the fence
   read and the dispatch (W9) — the fence no longer re-opens into a refusal; W-table rows for the new
   windows (stale sample, drain crash/throw, re-registered host, auto-resume backoff).
2. [x] **ADR-184 amendment (dated 2026-09-28)** — D-B: the skipped-terminal quarantine, D3.7 wording,
   post-hoc confirmation, "unverifiable, as before" corrected (own-run skip no longer host-served),
   Consequences bullet; owner outcomes for an unsettled quarantine.
3. [x] **Analytics** — `execution-hosts.md` (record semantics, fence rows X-EH-24/25 + new edge rows,
   D9 exemption list + consensus capacity, `newWorkRefusedBy`); `execution-event-plane.md` (D1
   Designed→Implemented, "protected range" → grace window, EDGE-EVT-08 skipped terminal ⇒ quarantine,
   log table + the six log lines of D9); `execution-prompt-lifecycle.md` (state diagram
   `accepted → quarantined: skipped terminal`, outcome table rows per owner kind, recovery-window row
   L447, EDGE-PRM-10 watchdog, EDGE-PRM-17); `run-continuation.md` (W-rows, backoff, Pass 2 exclusion);
   `runs.md` + `docs/screens/runs/flow-run.md` (queueReason = every `Pending` run while fenced; U7
   static-page note; M4 default option); `scheduler.md` (drain on every admitting sample);
   `scratch-runs.md` (quarantined turn notice); `reconciliation-gc.md` L782 (sub-reason drift: it rides
   `application_error.causeCode`, not `node_attempts.error_code`) and L825-863; `docs/supervisor.md`
   (input/other 409 causes, `outboxLimit`, health field); `adr-167.md:339` inline supersession note.
4. [x] **Contracts** — `supervisor.openapi.yaml`: `SupervisorErrorDetails.outboxLimit` (enum,
   description), every `event_outbox_backpressure` route description names `outboxLimit`, one refusal
   example per affected route family; `SupervisorEventStreamHealth.newWorkRefusedBy` (required,
   nullable enum) + every `/health` example; `web.openapi.yaml`: node-interrupt resume response
   `resume-queued` when deferred; `operations.openapi.yaml`: ext launch 202 `queueReason`;
   `error-taxonomy.md`: `prompt_terminal_conflict` cause codes incl. `terminal_unstorable`,
   `event_outbox_backpressure` + `outboxLimit`.
5. [x] Gates: `CI=true pnpm validate:docs:all`, `CI=true pnpm validate:contracts`; redocly counts at
   master's baseline. *(Done: 477 Mermaid blocks, 945 ADR anchors, 3718 links, 183 stubs in sync;
   contracts 7/7; redocly supervisor 4/21, web 8/48, operations 1/3 — at or below baseline.
   Also amended beyond the list: `agents.md` (narrowed W9 window, agent quarantine outcome),
   `database-schema.md` + `web.openapi.yaml` `errorMetadata` shape, screens admin/inbox/scratch-run.)*

### Phase 1 — supervisor (TDD). Commit: `fix(supervisor): refusal cause on the wire and a new-work signal in /health; a successful reservation wakes nobody; boot flip logged`

6. [x] REDs: `outbox-admission-kinds` CASES — each refusal carries its `outboxLimit` (soft →
   `unacknowledged`, hard → `retained`, physical → `physical`, wallet-less create at control budget →
   `control`, teardown serialization → `wallet`); `/health` `newWorkRefusedBy` for each condition and
   `null` when healthy (health `pressured:false` under hard/physical stays pinned); `openapi-examples`
   parses the new examples; S1 attempt counter: K paused producers + M successful reservations ⇒ no
   producer attempt per success (H6 shape); S4 boot flip logs `outbox-pressure-changed`; S2 appends after
   a stalled pass start no prune pass (spy on the page function); S8 D3-perm asserts the prompt
   rejection token.
7. [x] Implement D-A host side (`host-runtime-errors.ts`, `host-state.ts:988`, `outbox-budget.ts`
   split sites, `http-api.ts` mapping + details, `types.ts` details + health zod, health SQL/read);
   S1 `observeCapacity()` on success; S3 `ReceiptAdmission` only on the accepted transition
   (discriminated `putReceipt*` input; drop fabricated values and their comments); S4 seed
   `observedPressure` before the boot refresh and route it through `observeCapacity`; S5 comment; S6
   drop the 250 ms bound; S7 make `nowMs` required and thread the injected clock.
8. [x] Supervisor lane green; falsify each new guard once (revert, RED, restore).
   *(Done: supervisor 85 files / 798 tests green, tsc clean. REDs watched failing first: wire
   mapping (unexported), health strict parse, admission table ×3 + healthy + control, boot flip,
   wallet reason, H7. Falsified after GREEN: H3b fails (9 vs 3 pages) without the stall gate;
   the control test fails without the control check; the physical case fails (`control`)
   without physical-first. Health order follows admission order (physical, unacknowledged,
   retained, control) — ADR/OpenAPI/analytics aligned. `NEW_WORK_REFUSALS` +
   `outboxLimitOf` (exhaustive over every reason) live in `host-runtime-errors.ts`; the zod
   schema requires `newWorkRefusedBy` non-null while `pressured`. S3 by interface overloads
   (`SettledReceiptRow` needs no admission); S7 `nowMs` required and threaded.)*

### Phase 2 — manager fence, sweeps, recovery (TDD). Commit: `fix(execution-host): the fence follows the host's new-work signal; the queue drains on every admitting sample; host parks survive Pass 2; the auto-resume backs off`

9. [x] REDs (`launch-paths`, `host-pressure-park`, `hitl-node-interrupt`, `keepalive-persistent`,
   `system-sweeps.test.ts`, `wire-shape.test.ts`, `pool-cap-fence.test.ts`):
   - M2: physical/retained refusal → record; next sample with `newWorkRefusedBy: "physical"` holds it (no
     auto-resume, no promote); `null` clears and drains once; `wallet` refusal parks without a record;
     older-host sample (no field) keeps the `pressured` rule; stale sample (fetched before a refusal)
     does not delete the fresher record.
   - M5: the drain step throws on tick 1 (flow pool) → the agent pool still drains, and tick 2 (`clear`)
     drains the flow queue; a record left on a retired host → the next sample drains.
   - D-D: a host-parked flow run and an agent host park past TTL are not abandoned; an operator-silent
     `NeedsInputIdle` run still is.
   - D-E: three throws then success resumes on a later tick; the stuck ERROR line appears once.
   - R3 guard: readers of `maxConcurrent{Runs,AgentRuns,AssistantRuns}Cap(` outside an explicit
     exempt allow-list (each with its reason) fail the grep test.
   - R5: wire-shape asserts the real wire shape (`event_outbox_backpressure` + each `outboxLimit`).
   - P3b: a deferred interrupt resume answers `resume-queued`. P6: an unknown actor kind throws.
   - P5: realistic idle seeds (production idle helper, assignment released), W6 seed with
     `actor`/`cause`, refused-create W2 park failure replays through the continuation worker, the
     `redriven` arm.
10. [x] Implement: `host-pressure.ts` (D-A manager side, `sampledAt`), `deliverer.ts` (log +
    `wallet` skip), `supervisor-client.ts` + `platform-status.ts` (optional `newWorkRefusedBy`,
    `outboxLimit` passthrough), `system-sweeps.ts` (D-C), `keepalive-sweeper.ts` (D-D),
    `services/hitl.ts` (D-E, P3b, P6), `pool-cap-fence.test.ts` + D9 exemption for consensus capacity
    (R3); U4 remove `client as never`.
11. [x] Web unit + the focused integration files green; falsify each guard once.
   *(Done: web unit 870 files / 9116 tests; the 22 integration files touching the changed code
   (`grep` of runPass2 / runSweepTick / applyHostPressureSample / recordHostPressureSample /
   resumeHostPausedInterrupts / createOwnedSession / event_outbox_backpressure / host_pressured,
   R20 excluded) 349 tests green; web tsc clean. Falsified after GREEN, each RED then restored:
   the sample following `pressured` (R-M2 physical), the `sampledAt` guard (stale sample), the
   `wallet` skip (teardown seam test), the create choke point (W2), both Pass 2 exclusions,
   `resume-queued`, and the raw-cap guard (a probe reader). FOUND while writing W2 — not in the
   review: `createOwnedSession` rethrew a refused create's STORED failure (`PRECONDITION
   event_outbox_backpressure`), so the driver never saw D8's `host_pressured` and FAILED the node
   instead of parking it; the real-supervisor suite missed it because the adoption is refused
   first there. Fixed at the create choke point (every create owner). P4's backoff is a pure
   module (`host-pressure-resume-backoff.ts`, unit-tested) because `localHost` memoizes and gives
   no deterministic throw seam. P5a: the W6 seed is realistic (a `stop` writes no response) — left;
   the three idle seeds now use `markCheckpointed`. P6: a non-user actor on the resume arm throws
   the same UNAUTHORIZED the human-only guard does. U4 cast removed.)*

### Phase 3 — event plane: skipped-terminal quarantine and its owners (TDD). Commit: `fix(execution-host): a prompt whose terminal is a skip is quarantined and ends its owner visibly`

12. [x] REDs (`prompt-host-span-fake`, `prompt-output-frontier`, `commands` (v1),
    `ingest-batch` 22P05 trigger keyed on the terminal, `reconcile-sweep`, `time-limit-watchdog`,
    agent and scratch owner suites): v2 and v1 skipped terminal ⇒ `application_error.causeCode =
    "terminal_unstorable"` within one reconcile; flow node with a LIVE session ⇒ `Crashed
    owner_poisoned`; without a session ⇒ same; agent turn ⇒ run crashes `owner_poisoned`; scratch turn ⇒
    `WaitingForUser` + `error_metadata.causeCode`; watchdog does not defer a quarantined command;
    host_span-settled then canonical skip ⇒ post-hoc quarantine; R6 a vanished event yields
    `event_span_gap` (typed); R7 asserts the event count and zero `readRuntimeEventSpan` calls.
13. [x] Implement D-B (`prompt-evidence.ts` choke point + post-hoc confirmation,
    `promptEvidenceConflict` details, flow/agent/scratch owner arms, `keepalive-sweeper.ts` witness);
    R6 typed throw + drop the `!`s; R4 restore master's Drizzle seed insert and bare select; drop the
    unused `ExecutionHostPressure` export.
14. [x] Focused suites green; falsify each guard once.
   *(Done: 37 integration files / 371 tests green (the Phase 3 files plus the agent, scratch,
   reconcile, keepalive, deliverer and span neighbours), web unit 870 files / 9123 tests with one
   red — the D10 fs inventory named `startAgentSession` for the `mkdir` the body now makes as
   `driveAgentSession`; renamed, 9/9 — web tsc clean, docs gates green. Falsified after GREEN, each
   RED then restored: the reducer's skip check (v1 + v2), the live-session resolver and its session
   stop, the watchdog witness, the agent detection, the agent outer rethrow, the agent session stop
   and turn close, the scratch settle, its metadata, the GET projection and the yielded
   classification, R6's typed gap (the reader returned `[undefined]`), R7's host-read assertion.
   NOT covered by a test (review only): the rethrow in the agent create-continuation catch and in
   the runner consensus-draft catch — no harness drives either path, and without them the turn
   still ends through the next driver (create continuation) or as `Failed
   consensus_draft_spawn_failed` (runner draft). Deviations from the plan: the agent owner is ONE
   wrapper around `startAgentSession` (every drive path, not two catch sites); a consensus draft is
   crashed like any agent run (the consensus counts a `Crashed` draft as settled) instead of
   yielding — the reconcile consensus arm only reads verifier/synthesis commands, so a yielding
   draft would have hung; the scratch owner is ONE choke point in
   `sendScratchPromptAndProjectEvents` (all six scratch drivers) and its error is a typed
   `CONFLICT {reason: prompt_terminal_conflict, causeCode, settled: false}`, not a pending
   subclass. R4 restored; R6's `!` nit refuted (`execution_events.host_sequence` is nullable in
   the schema type); the unused `ExecutionHostPressure` export dropped. ADR-184 item 3,
   `execution-prompt-lifecycle`, `reconciliation-gc` (a live-session row), `agents`, `scratch-runs`
   and `error-taxonomy` now say what the code does: owners read the command state, the flow
   verdict is the reconcile sweep's.)*

### Phase 4 — UI (TDD, jsdom). Commit: `fix(ui): a stored answer under host backpressure shows as stored; a host-paused node defaults to Resume; refusing-new-work in the admin panel`

15. [x] REDs: `run-hitl-response` jsdom — a 503 `event_outbox_backpressure` enters the stored view at
    once and never shows both lines after refresh; scratch dialog the same; `node-interrupt-controls` —
    `host_pressure` ⇒ `resume` is the default and the primary (amber) button, `operator` unchanged;
    `deriveNodeInterruptOptions` unit per cause; `HitlDecisionControls` forwards `cause` (U6a);
    `PressureCell` branches incl. `newWorkRefusedBy` (U6b).
16. [x] Implement: one shared predicate `isStoredAnswerDeliveryReason` in
    `web/lib/hitl-response-contract.ts` used at both card sites and the scratch dialog (M3);
    `deriveNodeInterruptOptions({…, cause})` REQUIRED parameter, controls paint the default option
    primary (M4); EN/RU copy for `event_outbox_backpressure` (answer saved, delivery pending, retried
    when the host admits work) and the admin "refusing new work" badge; U5 notice margin. ADDED in
    Phase 3: the scratch dialog shows a notice for `errorMetadata.reason = "prompt_terminal_conflict"`
    (the last turn's result could not be stored; send a new message to continue) with the
    `causeCode` as a diagnostic — without it the quarantined turn is visible only as a stopped
    spinner (the UI renders no `errorCode`).
17. [x] Web unit lane green; `pnpm lint` scoped to changed files, `git status` checked.
   *(Done: web unit 870 files / 9135 tests, 0 failures; web tsc clean; lint scoped to the 13
   changed files. RED before each change, then falsified by reverting one site at a time: the
   run card's stored-view entry, its one-line suppression (the refusal now carries its `reason`
   instead of matching a message key), the scratch dialog's entry; `defaultOptionId` from the
   cause, the default painted primary, and `HitlDecisionControls` forwarding `cause` (U6a). The
   admin badge and the scratch quarantine notice and gutter were RED before implementation; the
   U6b branches (no telemetry, pressured with no episode) were already right and are now pinned.
   The run card's live region still announces "Answer saved" for a stored answer — only the
   visible block keeps one line. `deriveNodeInterruptOptions` now returns `cause` itself.)*

### Phase 5 — close-out. Commit: `docs(outbox-review): lanes, falsification and truth pass on the remediated tip`

18. [ ] Gate battery on the exact tree (a snapshot worktree; HEAD never moves under a lane):
    `validate:docs:all`, `validate:contracts`, web typecheck, `supervisor tsc --noEmit`,
    `git diff --check`; web unit, web integration, supervisor lanes — failures classified by idle
    re-run on name sets.
19. [ ] R20 at default budgets once (the S1 change touches the hot path T3.5 measured): all D7 gates,
    `newWorkRefusedBy` null at every sample.
20. [ ] Docs truth pass: every Phase 0 statement re-verified against the code; plan/ADR status lines;
    `web/CLAUDE.md` baselines.
21. [ ] Adversarial re-review of the fix cycle (a different model), findings triaged and fixed in the
    same pass; patch file under `.ai-factory/patches/`; delete this FIX_PLAN.md.

## Files to Modify

- Supervisor: `supervisor/src/{host-runtime-errors,host-state,outbox-budget,http-api,types,command-receipts,runtime-object-recovery,checkpoint-teardown}.ts`; tests `outbox-admission-kinds`, `outbox-pressure-semantics`, `openapi-examples`, `producer-pause-bound`, `runtime-storage`, `runtime-event-outbox`, `runtime-event-backpressure`.
- Web: `web/lib/execution-host/{host-pressure,deliverer,prompt-evidence,prompt-span-pages,prompt-reconciliation}.ts`, `web/lib/supervisor-client.ts`, `web/types/platform-status.ts`, `web/lib/scheduler/system-sweeps.ts`, `web/lib/runs/{keepalive-sweeper,node-interrupt}.ts`, `web/lib/services/hitl.ts`, flow/agent/scratch prompt owners (`web/lib/flows/{runner-agent,graph/prompt-owner}.ts`, `web/lib/agents/prompt-owner.ts`, `web/lib/scratch-runs/prompt-owner.ts`), `web/lib/queries/run.ts`, `web/lib/hitl-response-contract.ts`, `web/components/{board/run-hitl-response,scratch/scratch-conversation,runs/node-interrupt-controls,admin/execution-host-status}.tsx`, `web/messages/{en,ru}.json`, `web/test-support/execution-host-seed.ts`.
- Docs: `docs/decisions/{adr-183,adr-184,adr-167}.md`, `docs/decisions.md` (stub lines if a status changes), the analytics, contracts and taxonomy listed in Phase 0.

## Risks & Considerations

- **Mixed versions:** an older supervisor sends neither `outboxLimit` nor `newWorkRefusedBy`; the manager keeps today's behaviour for it (tested). The supervisor's strict health zod means the OpenAPI examples and schema change in the same commit.
- **Health side effects:** `canAdmitPhysical()` on every health read may WAL-checkpoint; accepted and documented — a cached flag could deadlock the fence.
- **Periodic drain:** the flow pool's `promoteNextPending` scans C2 candidates each tick (the 60 s C2 poll already does); it inherits `promoteNextPending`'s existing rough edges (C1 ignores `queue_paused`; a task-less `Pending` fails at dispatch) at a higher frequency — recorded, not widened.
- **Owner arms for unsettled quarantine** touch the flow driver, the agent crash path and the scratch dialog; each gets its own RED against the real seam, and the settled-quarantine path stays unchanged.
- **Pass 2 exclusion (b)** also keeps answered-but-deferred runs alive past the TTL (they have a resume owner); a run whose owner is broken now stays `NeedsInputIdle` (it holds no slot).
- **Numbering:** no new ADR, no migration — Librarian's ADR-185+/0183+ reservation is untouched.

## Test Coverage

REDs are listed per phase; each is watched failing on the unfixed code, then each guard is falsified
once after GREEN (revert the guard, see the RED, restore). Race guards (stale sample, drain throw) keep
the window open deliberately (the sample is fetched, then the refusal commits, then the sample
applies) and name what would have collided.

## Questions (owner) — answered 2026-09-28: 1 a, 2 a, 3 a (decisions 5–7 above)

1. **M1 — масштаб «видимого» карантина.** (а) Класс целиком в этой ветке: flow с живой сессией, агент и scratch завершаются видимо, watchdog не откладывает — заодно чинит старые зависания `receipt_*`/`*_protocol` карантинов; (б) только skipped-terminal + flow + watchdog, агент/scratch — отдельным планом. Рекомендую (а): M1 открывает новый путь в этот класс, а три владельца — одна и та же правка по `details.settled: false`.
2. **Pass 2 для агентов.** (а) Исключать все раны с `resume_requested_at` (шире: любой ответленный, но отложенный resume — тоже не молчание оператора); (б) миграция с колонкой причины парковки, исключать только host-park. Рекомендую (а): без миграции и не двигает нумерацию Librarian, а TTL по смыслу — таймер молчания оператора, которого у отложенного resume нет.
3. **Auto-resume после ошибок.** (а) Экспоненциальный backoff (до 16 тиков) + ERROR-строка, без сдачи; (б) оставить «3 ошибки — оператору», но возвращать карточку (переоткрыть строку). Рекомендую (а): (б) мутирует ответленную HITL-строку и спорит с `respondedAt`-идемпотентностью.
