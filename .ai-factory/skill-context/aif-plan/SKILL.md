# Project Rules for /aif-plan

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-09-04
> Based on: 2 adversarial-review pass-throughs (M6 / 2026-05-28, M7 / 2026-05-28)
>
> - M10 verify pass-through (2026-05-30); /aif-evolve patch analysis (2026-05-30,
>   2026-06-01 — M11b/M11c adversarial-review batch)
> - /aif-evolve 107-patch batch (2026-06-17, cursor 2026-05-30 → 2026-06-16)
> - /aif-evolve 114-patch batch (2026-07-11, cursor 2026-06-16 → 2026-07-07)
> - /aif-evolve 74-patch batch (2026-09-04, cursor 2026-07-07 → 2026-09-04)

## Rules

### Plan MUST enumerate deployment touchpoints

**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: For every task that introduces a new env var, config file path, sidecar binary, bound port, or host-mounted file, the plan MUST include a dedicated "Deployment wiring" task in the same phase (or a clearly named follow-up). That task touches the deployment artifacts: `Dockerfile`, `compose.yml`, `compose.override.yml`, `compose.production.yml`, `.env.example`. The task's acceptance criteria explicitly call out which file each new dep lands in.

If runtime wiring is deliberately deferred, the plan MUST include an explicit "Not yet supported in Docker — enable in Phase X by …" doc task that updates `docs/getting-started.md` AND the relevant `docs/configuration.md` section. Silent dev/prod skew is not an option — either wire it or document the gap.

Concrete checklist to apply at plan-write time:

| If the plan adds …                                 | The plan MUST include a task that touches …                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A new env var the web or supervisor reads          | `.env.example` + the relevant service's `environment:` block in `compose.yml` (+ prod overlay if production-relevant)        |
| A new config file read at runtime                  | A bind mount or named volume on the consuming service in compose + a `.env.example` toggle for the host path if it's tunable |
| A new sidecar process spawned by web or supervisor | Dep listed in the consuming `package.json` + lockfile commit + smoke check that the binary is on PATH inside the container   |
| A new bound port                                   | Port mapping on the service in compose (if externally reachable) + collision check against the existing service set          |

Reason: a runtime feature can be wired end-to-end in code while its compose configuration remains untouched. The shipped runtime then cannot exercise the feature, and the gap may surface only at adversarial review.

### Plan MUST trace every contract surface to its spec file

**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: Separate from "what narrative docs to update", the plan's docs phase MUST list every external-facing CONTRACT surface that changes and the spec file that names it. The plan is the place to enumerate this so the implementation phase has an explicit checklist — `/aif-verify` then re-derives the same list from the diff as a cross-check.

Surfaces to enumerate (the right side names the spec file by default; add others as the project grows):

| Surface                                                                | Default spec location                                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| HTTP route added/changed (path, method, status codes, body shape)      | `docs/api/<service>.openapi.yaml` + the prose contract doc (e.g. `docs/supervisor.md` for the supervisor) |
| Wire field changing semantics (e.g. from "reserved" to "load-bearing") | The same `.openapi.yaml` AND the same prose contract doc — both prose and example payloads need to move   |
| SSE / WebSocket event added/changed                                    | `docs/api/async/<channel>.asyncapi.yaml` + the relevant `docs/system-analytics/*.md`                      |
| New domain error code                                                  | `docs/error-taxonomy.md`                                                                                  |
| New env var or config-file path                                        | env-vars table in `docs/configuration.md` (the table is canonical) AND `.env.example`                     |
| New DB column / table / index                                          | Drizzle migration + `docs/database-schema.md` + the relevant `docs/db/*.md` ERD                           |
| New `package.json` script or CLI entry point                           | `docs/getting-started.md` "Scripts" section + the relevant `CLAUDE.md` slice                              |
| New Flow DSL step type / mode / field                                  | `docs/flow-dsl.md` + the schema in `web/lib/config.schema.ts`                                             |

Reason: a load-bearing `POST /sessions` field can introduce new 503 paths while `docs/supervisor.md` remains stale if the prose contract is omitted from the plan. Tracing each surface to a spec file at plan-write time prevents this.

In-code SSOTs count as contract surfaces: grammar/prompt/assistant files shipped to agents every turn (`flow-dsl-grammar.ts`, also shipped as the `/flow-authoring` skill) and their drift-guard tests must be enumerated alongside `docs/` whenever the schema/DSL they teach changes — a docs-only surface sweep misses them.
**Source (addition)**: 2026-07-01-11.19

### Plan MUST call out config-state symmetry for YAML→DB persistence tasks

**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: For any task that persists a YAML/config field into a DB column (or any other persistent store) that downstream readers consume, the task's acceptance criteria MUST include the round-trip:

1. **SET**: field present in YAML → column equals resolved value.
2. **CLEAR**: field removed from YAML on the next run → column equals the column's default (typically null).
3. **Idempotent re-set**: field re-added → column equals resolved value again.

Both halves are mandatory tests. The plan MUST NOT mark the SET-only test as sufficient and MUST NOT include language that documents the CLEAR-half as "current behavior" or "deferred". An asymmetric write loop (`if (!entry.field) continue`) is a defect; the plan should call it out before implementation, not after.

Reason: M6's `upsertExecutorsFromConfig()` skipped flows without an `executor_override` entry, leaving a stale `flows.executor_override_id` after operator-removal. The integration test then enshrined this stale behavior as "documented" — a defect promoted to contract.

### Plan MUST identify body-controlled cross-resource identifiers and require server-state derivation

**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: For every new or modified HTTP route in the plan that operates on a server-held resource (live session, run, project, tenant, workspace), the Decisions section MUST enumerate every identifier the handler consumes and label each as one of:

| Label             | Source                                        | Trust-boundary implication                                                                                                                                                                                   |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url-param`       | path parameter validated by route shape       | Trusted iff the URL itself is access-controlled.                                                                                                                                                             |
| `auth-context`    | session / JWT claim / API key binding         | Trusted (server-issued).                                                                                                                                                                                     |
| `server-state`    | registry lookup, DB join through a trusted id | Trusted (server-derived).                                                                                                                                                                                    |
| `body-controlled` | request body field                            | **Untrusted** — every downstream use (filesystem path, cross-resource lookup, SQL WHERE) requires either strict validation against an allow-list OR comparison against a corresponding `server-state` value. |

When a `body-controlled` field names a cross-resource locator (project slug, run id, step id, filesystem path component) AND the handler already has a `server-state` source for the same locator (registry record, current session, authenticated context), the plan MUST default to deriving from server state. Body fields naming such locators are a code smell — challenge each one in the plan and either drop it or explicitly compare against the server-state value with a stated mismatch response (e.g. 409).

Concrete checklist to apply at plan-write time:

- [ ] Every HTTP route in the plan has an "identifiers" sub-bullet enumerating each field with a label from the table above.
- [ ] No `body-controlled` field names a filesystem path component (project slug, run id, step id, workspace dir) when the same handler has a `server-state` value for it.
- [ ] If a `body-controlled` cross-resource id is genuinely required (e.g. the route is multi-tenant and not yet authenticated), the plan must add either an allow-list refinement OR an explicit mismatch-rejection sub-task — never assume regex on the field alone is enough.

Reason: M7's first design accepted `runId`/`projectSlug`/`stepId` as body fields on the supervisor's `POST /sessions/:id/input` route. Because the session registry already held those three values for the live session, the body fields were redundant AND opened a path-injection vector across runs. Codex caught it in adversarial review. The fix was to drop the body fields entirely and derive from `registry.get(sessionId).record`. The lesson generalizes: redundant body identifiers are a trust-boundary gap waiting to happen.

### Plan MUST specify two-phase commit for routes with downstream side-effects

**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: For every plan task that introduces a route whose successful terminal response (200 / 202 / 410-with-side-effect) depends on a downstream side-effect outside the route's own DB (HTTP call to a sibling service, file write to disk, queue publish, supervisor RPC), the task's Decisions sub-bullet MUST explicitly specify:

1. **Order of operations**: which DB writes happen BEFORE the side-effect (durable record of "user intent"), which happen AFTER (durable record of "successful delivery"). The idempotency marker (`respondedAt`, `completedAt`, `processedAt`, `deliveredAt`) MUST be the AFTER-side write — never the BEFORE.
2. **Failure classification table**: for each failure class of the side-effect (HTTP 4xx, HTTP 5xx, network/timeout, downstream-specific errors), one row stating:
   - HTTP response status the route returns (200 / 4xx / 5xx).
   - Whether the row is left in a retryable state (`response set, respondedAt null`) or marked terminal (`respondedAt set, runs.status='Failed'`).
   - For retryable failures: what mutates on retry (typically: the user's intent overwrites the previous attempt; the idempotency marker stays null).
   - For terminal failures: what run/resource state transitions (typically: `status='Failed'` plus `endedAt=now()`).
3. **Idempotency guard**: a SELECT FOR UPDATE under the row lock that checks the idempotency marker AND the resource's terminal-status set before any work begins. The terminal-status check is mandatory — a successful retry against a row whose run is already `Failed` must return 409, not re-attempt.

Concrete bad pattern (the one Codex caught in M7):

```
UPDATE response=?, respondedAt=now() WHERE id=?;  // idempotency mark BEFORE delivery
await deliverToSupervisor();                       // side-effect AFTER mark
// → on supervisor 404, row is non-retryable; retry hits already-responded 409
```

Concrete good pattern (the M7 fix):

```
BEGIN; SELECT FOR UPDATE; assert not terminal, not responded;
UPDATE response=? (NO respondedAt yet);
COMMIT;
try { await deliverToSupervisor(); UPDATE respondedAt=now(); return 200; }
catch (err) {
  if (terminal) { UPDATE respondedAt=now(), runs.status='Failed'; return 410; }
  if (retryable) { /* leave row in retryable state */ return 503; }
}
```

Reason: M7's first design committed `respondedAt` before calling `deliverPermission()`. On supervisor 404, the route returned 410 to the user but the row was already marked responded — the next retry hit the already-responded 409 and the user's selection was effectively lost. Codex flagged this as the second high-severity finding. The two-phase pattern is the only way to make response routes retry-safe; the plan must enforce it at design time, not catch it at review.

### Plan MUST require explicit deferred-release on every failure path in code that creates a deferred

**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: When a plan task involves code that creates a deferred (a pending promise registered with a remote process, a setTimeout-armed entry in an in-memory map, an outstanding ACP request, a long-poll handle), the task MUST identify:

1. Every consumer code path that is expected to release the deferred (resolve / cancel / reject).
2. For each such consumer, every failure mode that could prevent it from releasing the deferred (DB error during a persist step, network error during a translate step, validation failure on the path that was supposed to write the row).
3. For each failure mode, the explicit deferred-release call that MUST be made before the failure handler returns.

"Log the error and continue" is NEVER an acceptable handler for code that created a deferred elsewhere. The deferred-creating side and the deferred-releasing side are joined by an implicit contract; failures in the releasing side leak the resource on the creating side until its own timeout fires — invisible to operators, visible to users only as "the agent hangs".

Concrete checklist to apply at plan-write time:

- [ ] For each task that observes a "request created" event from another process (SSE event, queue message, callback), list the deferred(s) on the other side that will be created by that event.
- [ ] For each task's catch / error-handler description, name the deferred-release call the handler must make.
- [ ] Tests in the same plan MUST include at least one regression case asserting "after a simulated failure in the releasing-side code, the deferred-creating side received an explicit release call" (e.g. a spy on the cancel API verifies it was invoked).

Reason: M7's first design specced `runner-agent.ts` to log-and-continue on DB-insert failure when handling a `session.permission_request` SSE event. The supervisor was holding a deferred ACP promise for that request; the runner-agent was the only consumer that could trigger its release (via the response route). On DB-insert failure, the deferred stayed pending until the 30-min keep-alive timeout — invisible to the user, who saw the run as `Running` with no actionable prompt. Codex flagged it as the third finding. The fix was to add `cancelPermission(sessionId, requestId, reason)` and call it from every catch path that breaks the happy-path persistence; the plan now enforces a regression test asserting no hidden deferred remains.

### Plan MUST make test-runnability and per-phase suite-green explicit acceptance

**Source**: M10 verify pass-through (2026-05-30)
**Rule**: A plan that promises tests but never states they must EXECUTE and the suite must stay GREEN lets the implementation ship dead or stale tests under deadline pressure. Every plan whose phases add or change behavior MUST encode three test-integrity acceptance criteria:

1. **Runnability.** Each promised test names the runner project that will execute it, and the plan requires confirming the runner's `include` glob actually matches the file (`vitest list` or equivalent). When a test lands in a new path family (e.g. `app/**/*.integration.test.ts` where only `lib/**` was globged before), the plan MUST include a task to extend the runner config in the same phase. Do not list a test as a deliverable without stating where it runs.
2. **Per-phase green checkpoint.** Each phase's exit criteria include "full suite green (`pnpm test:unit && pnpm test:integration`)". A test the phase touches that is left red fails the phase. Pre-existing red or harness-limited tests surfaced by the phase MUST be handled by an explicit quarantine task (config `exclude` or `*.skip` with a reason + tracked follow-up), never by silently tolerating red or deleting the test.
3. **Assertion migration is in-scope.** When a phase changes observable behavior existing tests assert (error text, resolved paths, addressing), updating those assertions is a task IN that phase, not a follow-up. The plan must name the existing tests that will need migration.

The plan's "migrate the existing suite" task (when present) MUST enumerate each existing test file by path AND the specific assertions/fixtures that the behavior change invalidates — a bare "migrate existing tests" line reliably gets trimmed and leaves stale red tests. `/aif-verify` re-derives this list from the diff as a cross-check.

Reason: M10's T7.3 said "migrate the existing suite" and promised lifecycle/two-phase/RBAC/trust-boundary tests, but the trust-boundary test was committed under a path no runner globbed (never ran), three loader assertions went stale against the new behavior, and the promised lifecycle/integration tests were never written — none of which blocked a phase because no phase had a runnability + green gate.

### Plan MUST front-load a complete, internally consistent analytics/design spec before any code phase

**Source**: M7 adversarial review passes 3-4 (2026-05-28-20.01, 2026-05-28-20.32); M10 verify pass-through (2026-05-30)
**Rule**: Analytics is an INPUT to implementation, not a trailing sync task. For any milestone or feature that changes a state machine, a wire/API surface, a DB schema, or a process flow, the plan MUST place a docs-first/analytics phase (a "Phase 0") BEFORE any code phase, and that phase's exit criteria MUST require the analytics artifacts to be COMPLETE and INTERNALLY CONSISTENT so implementation can follow them as the single source of truth. The Phase-0 exit checklist MUST cover, for every domain the milestone touches:

- **system-analytics doc** per `docs/CLAUDE.md` R5 (Purpose, Domain entities, State machine, Process flows, Expectations, Edge cases, Linked artifacts) — with EVERY state transition AND every refusal/precondition row enumerated, stated exactly as the code will gate (an allow-list vs deny-list must be written the way it will be implemented);
- **the ERD, both artifacts**: `docs/database-schema.md` narrative AND the relevant `docs/db/*.md` Mermaid `erDiagram`, for every new table/column/index (updating one is not updating the other);
- **API/event specs**: `docs/api/*.openapi.yaml` and `docs/api/async/*.asyncapi.yaml` for every route/event the milestone adds (paths, bodies, status codes, example payloads);
- **implementation-status tags** (Implemented / Designed / Phase 2 per `docs/CLAUDE.md` R6) on every described piece, so no spec section describes code that will not exist at the phase's HEAD.

A plan that schedules "docs as a final as-built sync" after the code phases is the drift pattern that produced repeated "specs still describe pre-Mx behavior" review rounds. (M10 verify: the analytics launch-refusal table described a deny-list while the shipped code used a stricter allow-list, and the `docs/db/*.md` ERDs were never updated — both because the analytics work was treated as a trailing sync rather than a leading source of truth.)

2026-07..09 additions: every Expectation bullet NAMES what enforces it (a constraint, a CAS, a singleton, a test) — a MUST without an enforcement point is a convention and must be weakened to the mechanism's scope or given a mechanism (load gate, runtime guard); motivation prose is never copied into Expectations or operation descriptions; when spec PROSE and a spec TABLE disagree, reconcile before implementing (the code follows whichever is closer to the keyboard); process analytics cover failure AND cancellation paths, not only the happy path; a plan requirement that names a MECHANISM is either met literally or amended when the implementer chooses otherwise; a "best-effort, keep going" policy states the degenerate case it does NOT cover; re-enabling a dormant gate is planned as TWO tasks (re-enable, then re-derive the never-exercised semantics); Studio and package lifecycle gates are specified to enforce the same capability-profile / agent-definition / schema contracts as runtime.
**Source (additions)**: 2026-07-27-09.30, 2026-08-01-09.09, 2026-09-03-17.20, 2026-07-13-00.59-unified-test-database-review-remediation, 2026-07-11-21.30, 2026-09-02-12.10, 2026-09-03-15.06, 2026-07-11-13.34

### Plan MUST physically separate trust from execution for any fetch-then-execute of third-party content

**Source**: M10 second adversarial review (2026-05-30-13.03)
**Rule**: Any feature whose code path fetches/installs external content (clone a repo, download a package, pull a plugin) and later EXECUTES code from it (`setup.sh`, `postinstall`, hooks, plugin entrypoints) MUST be planned so that:

1. The steps are ordered **fetch/install → establish trust → execute** — never fetch-then-execute in one breath.
2. The execution call lives in a function PHYSICALLY SEPARATE from the fetch/install function, so execution cannot be invoked before a trust decision (the install function must not be able to run the hook).
3. Execution is gated on an explicit trust state persisted in the store (`trusted_by_policy` or operator-confirmed), never on "we just installed it".

Plan acceptance criteria MUST name, for each executable hook the feature ships: WHERE it runs and WHAT trust gate precedes that exact line. Mandatory regression: install an untrusted source carrying a `setup.sh` → assert the script did NOT run (no side effect / sentinel absent) until an explicit trust + enable. (M10: `installRevision` ran `bash setup.sh` from a possibly-untrusted source during install — arbitrary code execution before any trust decision.)

## Auto-generated rules (managed by `/aif-evolve` — do not hand-edit below this line)

### Plan MUST make a multi-store state transition atomic and enumerate its crash-window recovery

**Source**: 2026-05-31-22.46, 2026-05-31-23.49, 2026-06-01-12.55
**Rule**: This GENERALIZES the existing "two-phase commit" rule (single DB write + one external side-effect) to a transition that performs N persistent writes across MORE THAN ONE store — e.g. `runs.status` column + a `node_attempts`/ledger row + the `current_step_id` cursor + an on-disk artifact. For every such transition the plan MUST require:

1. **One transaction / one CAS-guarded claim for all the persistent writes.** Fold the ledger write, the status CAS, and the cursor repark into a SINGLE `db.transaction` so there is no committed intermediate state: either fully transitioned or fully not (and retryable). Git/external side-effects stay BEFORE the tx (a failure is a clean 409 with no ledger write); an async runner/resume stays AFTER the commit (a death there is recoverable by the sweep).
2. **If full atomicity is impossible**, the plan MUST enumerate every CRASH WINDOW — process death BETWEEN each pair of independent commits, not just the exception paths — and give EACH reachable partial state an explicit, _tested_ recovery path. A recovery sweep that filters on a single status (`status='Running'`) only rescues partial states that reach that status; the plan MUST name which partial states the sweep covers and which it does not.
3. **A release / abandon / terminal transition MUST close EVERY store that represents the lifecycle** (status column + ledger row + artifact) in the same transaction — updating only `runs.status` while leaving an open `node_attempts` row makes `getActiveTakeover` report an active handoff on a released run.

Reason: M11b's takeover _return_ made two of four writes atomic and left the status flip + cursor repark as separate auto-commits; a crash between them stranded the run (`HumanWorking` with an ended ledger row had no rescuer; `Running` with the cursor still at the review node re-dispatched at the wrong node, skipping re-validation gates). M11c's duration-cap watchdog clobbered a concurrently-`Succeeded` attempt because the ledger write had no status predicate. "Two-phase commit" was reasoned about as exception-handling, never as process-crash windows.

Compensation completeness: sequence durable/shared-state mutations as LATE as possible after all cheap deterministic preconditions, hoisting the dominant failure ahead of the mutation (`checkSupervisorHealth()` pre-adopt); when a mutation must precede fallible work, the compensation `try` spans the ENTIRE fallible remainder — not the convenient tail (the pin-advance boundary drawn at "after `addWorktree`" left refusals, health checks, preconditions, and `addWorktree` itself uncompensated) — and the mutator returns an UNDO handle (`AdoptRevert[]`, `[]` on no-op, never a boolean) applied on the throw path with per-revert catch+log. "Deterministic, the user chose it, they'll re-run" is NOT a reason to leave SHARED state (pins, defaults, enablement) mutated on failure — per-request determinism ≠ safe for shared state. Every accepted residual crash window is documented in the ADR; compensation reverts get their own failure-simulation test.

Recovery predicates: a "the reconcile/crash sweep will handle it" justification must name the EXACT state the sweep filters on and assert reachability with a test — a `Running` run whose session is live-but-halted never reaches a sweep that reclaims `Running`-with-no-live-session. A crash-window composite persists a durable idempotency key BEFORE any unrollbackable external side effect (a deterministic `budget_restart` trigger payload lets a retry adopt the already-launched run instead of relaunching), and persists the recovery handle (preserved park ref) BEFORE the terminalization boundary so a retry is distinguishable from an unrecoverable half-step.
**Source (additions)**: 2026-06-25-20.14, 2026-06-25-17.19, 2026-06-24-03.08, 2026-07-03-00.00-budget-breach-review-followup

2026-07..09 additions: filesystem mutation stays OUTSIDE the terminal DB transaction — the plan orders "commit terminal state → release materialization → log refusals without reverting", and every single-owner artifact writes its ownership MARKER before its content with a marker-attributed reclaim; DB-to-filesystem workflows are specified as a PUBLICATION PROTOCOL (private operation-UUID staging, atomic rename after journal + commit, compensation of private state only). Every irreversible external effect (force-push, PR create, publish) has an explicit POINT-OF-NO-RETURN flag that all compensating paths consult, and the post-effect branch settles FORWARD, never restores; the plan reasons about BOTH directions of every side-effect-before-transaction ("the side effect succeeds and the tx fails" is the one that gets skipped). If a handler can refuse, its precondition runs BEFORE the first irreversible act — a trailing status-guarded CAS is concurrency control, not a precondition; destructive side effects come AFTER the claim (lock → verify → commit intent → effect), with resolution split from application. Any hard DELETE lists the inbound `ON DELETE CASCADE` FKs first (`tasks` ← `runs`, `domain_events`) and usually becomes `Abandoned`; supersessions live in the successor's insert tx. Before inverting an ordering to close a race, the plan enumerates the recovery for the NEW partial state.
**Source (additions)**: 2026-07-11-12.25, 2026-07-17-00.10, 2026-07-12-11.21, 2026-07-15-18.10, 2026-07-17-00.00, 2026-09-03-15.37, 2026-09-01-04.15, 2026-09-02-03.51, 2026-07-14-human-ask-review-remediation, 2026-09-03-17.21

### Plan MUST fan a new run status / enum value / state-changing route out to ALL consumers, and require allow-list guards

**Source**: 2026-05-31-22.46 (#3/#4), 2026-05-31-23.49 (#1), 2026-06-01-12.55 (#3)
**Rule**: Adding a `runs.status` value, an enum case, or a state-changing route, the plan's acceptance MUST enumerate the FULL consumer set — not only the narrative docs the contract-surface rule already covers, but every CODE consumer:

| Consumer class              | What to update                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read models                 | EVERY one — board read model AND portfolio/home (cross-project) read model AND any rail/sidebar query. A status added to one read model but not another makes a claimed run vanish from the home grid while still holding a capacity slot. |
| Scheduler / concurrency cap | the active-status predicate and the cap accounting.                                                                                                                                                                                        |
| Recovery / idle sweeps      | each sweep's candidate filter — does the new status belong in its WHERE clause?                                                                                                                                                            |
| State / precondition guards | every state guard INCLUDING the HITL form/human-response guard.                                                                                                                                                                            |
| API spec                    | a new state-changing route gets an OpenAPI/AsyncAPI path in the SAME change.                                                                                                                                                               |

Two hard requirements on the guards themselves:

- **Allow-list exact states, never deny-list a coarse complement.** A guard written `if (terminal) reject` (deny-list) silently ADMITS every future non-terminal status — M11b's `HumanWorking` slipped past a `!terminal` HITL guard and let a reviewer store a stale pre-takeover approve. Specify guards as `status ∈ {NeedsInput, NeedsInputIdle}` (allow-list) so a new status is rejected by default until explicitly admitted.
- **A new terminal transition that frees a concurrency slot MUST honor the slot-release contract** (`promoteNextPending` / `releaseSlotOnIdle`) — M11c's duration-cap kill freed a slot but never promoted the queue, stranding `Pending` runs.

Reason: a new enum/route was propagated to the surfaces named in the plan's file list but not to _every_ consumer (a second read model, the scheduler, the API spec, a coarse guard). The plan/file-list was the checklist and predated the later-added surfaces; the plan must require grepping the new value into every consumer class above.

Fanout extensions: a column going NULLABLE is a new-value fanout exactly like a new enum member — grep every consumer that branches on it (slot counters, per-project sweep candidate queries that structurally never see `IS NULL` rows, route authz gates that throw on null). Changing an identifier SCHEME whose prefix downstream code decodes is a grep-every-DECODER task — enumerate every reader of the id FIRST and pre-commit that gate in the plan (the launch resolver + attach gate + available-list all parse `<flowRefId>:<stem>`; the gate blocked a plausible false fix). Relocating a canonical path moves EVERY coupled consumer in the same pass (inventory moved while registration/effective-resolution/attach still read the old location = a visible-but-unusable surface). An "agent gains an op" change moves the route scope + scope→action map + `AGENT_TOKEN_SCOPES` grant list together.
**Source (additions)**: 2026-06-27-23.45, 2026-06-23-18.38, 2026-07-02-11.12

2026-07..09 additions: a new scheduler kind fans out to registration, lifecycle, the `claimDueJobs` CTE, dispatch, admin, OpenAPI AND the localized admin label map; a real third state gets a discriminated-union MEMBER (never an `else` fallthrough); a widened jsonb discriminant lists every reader that field-sniffs it and every DTO/UI read model that projects it; a cancel/stop tool on a child names the admission counter it must free and the status that frees it; a shared emit helper gaining writers gets a REQUIRED cause discriminant and the plan states what each consumer does with the new population. Status guards are specified as exhaustive `satisfies Record<RunStatus, boolean>` maps shared by every consumer. The one legitimate inversion: a RECOVERY arm over a phase set that grows on the producer's side derives the complement instead of listing phases. Under a dead coordinator the plan enumerates what each child can be HOLDING and the per-status outcome (`Pending → Abandoned`; awaiting states → `Crashed` with HITL rows closed; `HumanWorking` left; sub-orchestrators via the stuck path).
**Source (additions)**: 2026-07-12-20.46-observatory-agentization-review-remediation, 2026-08-06-19.10, 2026-09-02-03.51, 2026-09-02-12.10, 2026-09-04-00.21, 2026-07-16-11.20, 2026-09-03-21.47

### Plan MUST allocate ADR + migration numbers up front for parallel branches and budget a renumber pass

**Source**: 2026-06-05-14.42, 2026-06-07-20.16, 2026-06-09-18.47, 2026-06-09-20.30, 2026-06-11-09.20, 2026-06-12-12.46, 2026-06-10-23.57, 2026-06-11-12.51
**Rule**: ADR numbers (`### ADR-NNN` in `docs/decisions.md`) and Drizzle migration `idx`/`tag` (in `migrations/meta/_journal.json`) are a GLOBALLY sequential, shared namespace. Two branches forked from one base each grab "the next number" and the clash is invisible on each branch (every gate is green) until merge. For any plan that adds an ADR or a migration:

1. **Reserve the number first.** The next free ADR number is `max(### ADR-NNN)` at **main's HEAD** (`git show main:docs/decisions.md`), NOT the fork point and NOT the author's mental count. Write the `### ADR-NNN` header (even a one-line stub) before citing it — a cited ADR with no header at HEAD is a build break, not a doc nit. The next free migration number is `max` over `_journal.json`, not the highest file on the branch.
2. **When milestones run in parallel, allocate both branches' ADR + migration numbers from a single source up front** so neither squats the other's number.
3. **Budget an explicit renumber pass** (its own focused session, AFTER rebasing onto main) into every long-lived branch — it is a deliverable, not a merge-time surprise.
4. `pnpm validate:docs` only parses Mermaid; it does NOT resolve `[ADR-NNN](decisions.md#...)` anchors. Plan a real anchor check (`scripts/validate-docs-adr-anchors.mjs`) and treat a green docs gate as non-evidence for ADR/migration numbering.
5. A new migration is a TRIPLE — SQL file + `_journal.json` entry + `meta/<NNNN>_snapshot.json`; plan the integrity check that the NEWEST journal entry has a matching snapshot (a missing snapshot silently starves future `db:generate`). Budget prose-form greps (`pre-NNNN`, `since NNNN`, `as of NNNN`) into the renumber pass and prefer number-agnostic phrasing (`pre-ADR-118`) in long-lived comments. Migrations introduced mid-implementation beyond the plan's frozen preflight set are folded back into plan/preflight artifacts in the same pass.
   **Source (additions)**: 2026-07-07-13.51, 2026-06-30-00.47, 2026-07-04-01.04

6. A cross-cutting constraint receives its OWN migration number (never folded into a feature's migration); a migration that DROP+re-CREATEs a CHECK/enum on a SHARED table is re-derived from `schema.ts` at rebase; `schema.ts` is the FOURTH leg of the migration contract — the plan's migration task ends with `drizzle-kit generate` reporting "No schema changes"; in-place amendment of migration SQL is allowed only under a recorded "applied nowhere durable" premise re-confirmed with the owner before merge.
   **Source (additions)**: 2026-07-15-11.19-gate-chat-recovery, 2026-07-18-13.35, 2026-09-01-05.40

### Plan MUST persist the launch-time decision the terminal path reads, and branch shared dispatch on run_kind

**Source**: 2026-06-13-16.55, 2026-06-16-22.45
**Rule**: When a launch resolves a field X from an "effective"/pinned/mutable source (a catalog projection, a package's newest revision, a policy snapshot), the plan MUST require persisting X on the run row at spawn (e.g. `runs.agent_workspace`, the runner snapshot, the delivery-policy snapshot) so the terminal/enforcement path acts on **what the run actually launched with**, never re-derives it from a projection that can drift after launch. The acceptance criteria must name: where X is snapshotted, and that the terminal path reads the snapshot (`row.x ?? wsCtx?.x`). Separately: any SHARED dispatch site that feeds a kind-specific mechanism (reconcile classifier, sweep, a composed/aggregating op switching on `run_kind`) MUST branch on `run_kind`/the discriminant BEFORE routing — a scratch/agent run driven into the flow-only resume driver replies context-less and `Crashed`s. Require a guard at the irreversible apply site in addition to the pure classifier, and a test per discriminant arm (half-A-tested + half-B-tested ≠ A∘B-tested).

### Plan MUST design background automation for progress, bounded retries, and poison items

**Source**: 2026-06-25-17.42, 2026-06-25-19.58, 2026-06-29-17.25, 2026-07-03-14.58, 2026-07-02-17.03
**Rule**: For any timer/sweep/unattended launcher, the plan MUST specify:

1. **Progress guarantee** for capped scans — a durable per-item attempt marker stamped on every attempt AND/OR a rotating keyset cursor persisted in the job's state, answering the reviewer question "if the first N rows are permanently ineligible and never change, does row N+1 ever get processed?".
2. **Bounded retries with an intent-scoped budget** — an attempt cap filtered by `armed_at` (a deliberate re-arm earns a fresh budget) plus explicit backoff; auto-launchers never reuse a human-retry launchability classifier without re-deriving what each terminal state means for an unattended caller.
3. **A poison-item policy** — deterministic per-item failure → permanent `failed` + recorded evidence; transient → bounded retry — so one bad row cannot stall the singleton job into platform-wide disablement.
4. **A wiring-seam test** — for a new scheduler jobKind / dispatch arm / consumer registration, ONE end-to-end test drives the real claim→dispatch path (`runSchedulerTick({jobKind})`); a registration checklist nothing executes is an unverified claim (a missing `case "auto_promote"` left every direct-handler test green while production ticks never promoted).
5. **Exactly one achievable validation gate**, naming the exact command — "validator-clean" AND "zero-new-vs-count-baseline" cannot both be the gate (a count delta masks a new error when a pre-existing one coincidentally resolves); pin baselines by enumerated `{ruleId, pointer}`.

6. **Lease arithmetic and renewal** — `batch × per-call budget` is compared against the lease that contains it and the deadline is derived from the container's real value; a lease around a long external operation specifies renewal (fenced heartbeat renewing the EXPIRY) and a fence at the persistence boundary, with tests for renewal AND stale completion after expiry; recovery leases are acquired at PROCESSING time; a fresh clock is threaded through reconciliation mutations.
7. **Recovery owners** — any durable interaction settled by an in-memory callback (lease timers, pending turns, answered-but-unmarked decisions) names its reconciliation owner after a restart; a lease expiry is a cancellation deadline, not a terminal outcome.
8. **Failed reads never write terminal state** (a provider's 404 for permission-denied is retryable; an attempt-counter recreates the class), and service-level bundle failure is a distinct persisted outcome from per-candidate retry.
9. **Targeted loaders** — a new arm loads only rows that can trip it (`NOT EXISTS parent alive`) instead of widening a hot sweep; lookups/registrars never await domain sweeps (schedule them out-of-band).
10. **Cut-overs** — an irreversible migration/cut-over plans BOTH a DB backstop against stale binaries (a trigger) and a post-migration reconciliation of orphaned external resources; conflict-ignore seeding needs an explicit reactivation transition.
    **Source (additions)**: 2026-07-15-18.10, 2026-07-16-13.06, 2026-07-17-00.10-workspace-lifecycle-review-remediation, 2026-07-15-11.19-gate-chat-recovery, 2026-07-14-23.40-flow-review-workspace-findings, 2026-07-16-16.05, 2026-09-03-21.47, 2026-09-04-00.21, 2026-07-12-11.42, 2026-07-12-23.49-observatory-agentization-review-fixes

### Plan MUST treat statuses as signals and predicates as per-concern

**Source**: 2026-06-20-23.22, 2026-06-22-11.08, 2026-07-01-12.55
**Rule**: When a plan adds or uses a run status that gates a coordinator/loop, it MUST answer "what WAKES the waiter when a child reaches it?" — a status nothing emits on is a deadlock (Review children never woke `WaitingOnChildren`). Enumerated status sets in feature code are a smell: derive a `SETTLED`/`PENDING` predicate from ONE source (`run-status-sets.ts`) so every counter agrees. Never reuse a status set across CONCERNS without checking semantics align — "done writing" (writer-safety) ≠ "safe to auto-merge" (a `Failed|Crashed|Abandoned` sibling is settled-for-writing but its partial work is NOT auto-shippable); name predicates after the concern (`countFailureTerminalSharedSiblings` vs `countUnsettledSharedSiblings`). Slot-freed states (`NeedsInputIdle | WaitingOnChildren | Review`) reclaiming a slot on any transition back to live MUST be cap-gated or explicitly exempted with a recorded reason.

2026-07..09 additions: every feature that parks a run/turn/claim ships a NORMATIVE recovery-window table (each `status × mode` cell with its arm) in the ADR/analytics — the implementation must not define the windows it happens to satisfy (`Running`-only reconcile left a resolver parked in `NeedsInput` and a mechanical sync parked in `Review` with no owner); coordinator death is ANY terminal parent, derived from the TS constant.
**Source (additions)**: 2026-07-16-16.05, 2026-07-16-11.20, 2026-09-03-23.46

### Plan MUST make migrations preserve live data or refuse loudly

**Source**: 2026-06-27-16.03, 2026-06-24-18.55, 2026-06-29-17.25, 2026-07-04-01.04
**Rule**: A migration that DROPs a column or re-keys a table holding LIVE state ships with either a backfill (`INSERT INTO … SELECT … ON CONFLICT DO NOTHING` before the drops) or an abort-guard (`RAISE EXCEPTION` if non-empty) — the plan states which and why; when the new key is not SQL-derivable from the old (multiple old rows collapse onto one slot), the loud guard is the honest choice, never a guessed mapping. A migration opening with `DELETE FROM <table>` whose FKs cascade over per-project attachments/config is acceptable only pre-release/single-operator — the plan flags the re-attach requirement or re-keys instead. A NOT-NULL-default column needing per-row computation plans the backfill explicitly — a constant default is a "looks populated but isn't" trap that permanently excludes pre-migration rows from sweeps (a NULL marker is the natural "never swept" seed). Migrations added mid-implementation beyond the frozen preflight set are folded back into the plan artifacts in the same pass.

2026-07..09 additions: a migration that STRENGTHENS a multi-column invariant (a claim = state + attempt id + op name + expected status + unexpired lease) lists every writer and fixture of that state as tasks and requires the owning real-Postgres suite; lifecycle terminal-state invariants (`completed` requires the agent message + timestamp; `failed`/`aborted` require an error; non-negative counters) are planned as generated CHECK constraints with real-Postgres coverage.
**Source (additions)**: 2026-07-16-22.26-workspace-reconciliation-review-fixes, 2026-07-15-11.19-gate-chat-recovery, 2026-07-17-00.10-workspace-lifecycle-review-remediation

### Plan MUST carry launch preconditions into create/picker UIs and test policy-axis interactions

**Source**: 2026-07-04-22.53-experiment-create-flow-advisory-json, 2026-06-20-18.20, 2026-07-02-17.03
**Rule**: When a create UI feeds a later launch path, the plan requires the picker/inline-create payload to enforce the downstream launch preconditions (filter task options to tasks whose `flowId` is in the launchable set; require `flowId` on inline creation) — "creatable now, unlaunchable later" is a design defect. When two policy axes can act on the same site (`reworkExhaustion=escalate` × `humanGate=auto_pass`), the plan requires explicit interaction tests — full single-axis coverage with zero interaction coverage is how emergent, undocumented invariants ship one refactor away from a stuck run. Any feature that auto-actions dependency/lockfile diffs gates specifier SHAPE both-sided (`isRegistryVersionSpecifier` rejecting `file:` / `git` / `github:` / `http(s):` / `workspace:` / path forms) and disqualifies lockfile-only diffs; security-sensitive autopilot features budget an adversarial refute-the-design pass — completeness/consistency self-review passes miss this class.

2026-07..09 additions: preflight probes may assert only revision-INVARIANT state (host tools); anything branch-owned is validated from the EXECUTION revision (ADR-091 probes run in `project.repoPath` before the worktree exists); a trust/gate transition also advances the dependent rows waiting on it (with a one-time repair migration); intake/UI SHAPE validation may accept a well-formed future-engine graph while only EXECUTION requires the host-compatibility check.
**Source (additions)**: 2026-08-01-09.09, 2026-07-15-18.13-trusted-package-flow-enablement, 2026-07-11-22.35-m43-review-remediation

### Plan MUST match each lock's scope to its invariant's scope and design the racer from the invariant

**Source**: 2026-09-03-14.30, 2026-09-01-04.15, 2026-07-27-20.55, 2026-07-16-13.06
**Rule**: For every guard the plan introduces, the Decisions section states the INVARIANT's scope and the LOCK's key, and they must be the same object: a global invariant (count, cap, quota) with per-row updates gets the existing advisory lock (`takeSchedulerLock`) BEFORE the count; an ancestor-scoped bound (`max_child_runs` over a subtree) gets a TREE-ROOT lock in a fixed parent-then-root order; a read → compare → write over a FILESYSTEM is check-then-act until a `pg_advisory_xact_lock` holds the interval (`atomicWrite*` is not a CAS); a lease around a LONG external operation (launch: fetch + worktree + materialization) gets renewal AND a durable fence at the persistence boundary. The plan then specifies the two-racer FROM the invariant, not from the lock: racers that could BOTH violate the property (two different parents), the winner performing the real writes uncommitted, the loser asserted PARKED via `pg_stat_activity`, at the layer that OWNS the invariant (store, not route), with a guard-disabled mutation check — a racer chosen to hit the lock you wrote only proves the lock works.

### Plan MUST enumerate frozen-source read paths and put validation on the action path for pin/snapshot features

**Source**: 2026-07-26-12.32, 2026-07-25-11.14, 2026-07-24-15.19, 2026-07-27-20.55, 2026-07-11-22.35-m43-review-remediation
**Rule**: For any feature that freezes, pins, seals, or snapshots (evidence snapshots, immutable recipes, pinned revisions, controlled launches) the plan lists EVERY read path that must switch to the frozen source (judge context, fan-out, aggregation, launch resolution) and names the LIVE accessor each must stop using (`orderedStudyParticipantIds`, `isNull(removedAt)`, `flow.enabledRevisionId`) — "recorded for provenance" with an unswitched read path is the defect shape; a fan-out and its aggregation share ONE set function. Validation for declared inputs the seam cannot honor lives ON THE ACTION PATH (the launch route blocks on hard refusals before any write), never only on an optional preview; any WARN or provenance record over a known gap is tracked as an open defect in the plan, not treated as handled. An entry point serving two lifecycles (`start*` with a `resumeSessionId`) gets an explicit gate per lifecycle. Pinned `flow_revisions.manifest` stays authoritative over the mutable Flow cache.

### Plan MUST design idempotency and provenance: deterministic digest inputs, content-guarded keys, outcome not intent

**Source**: 2026-07-25-11.14, 2026-07-25-12.09, 2026-09-01-04.15, 2026-09-02-12.10, 2026-07-14-23.40-flow-review-workspace-findings
**Rule**: When a task introduces an idempotency key, dedup digest, or replay branch, the Decisions section states: every input to the digest is reproducible from the key (no `Date.now()`/random above the dedup); a stored result is returned only after a content/digest compare, and a changed payload under a used key CONFLICTS (cover same-key/same-payload AND same-key/different-payload); an already-delivered branch mutates NOTHING unless the arriving payload is byte-identical to the stored decision (`sameDecision`, not `sameRequest`); retry equality compares canonicalized bodies (sorted keys, array order preserved); dependent rows and the keyed record that can reject them commit in ONE transaction. Provenance records capture the OUTCOME (what actually ran, read back post-seam), and when a later stage re-derives a value an earlier stage wrote into an "immutable" record, the later stage owns the record.

### Plan MUST derive authorization from data class and response shape, and budget parity tests, positive grant tests, and per-cycle adversarial review

**Source**: 2026-07-27-21.50, 2026-08-06-17.03, 2026-08-06-19.10, 2026-07-22-01.14, 2026-09-04-00.21, 2026-09-03-17.21, 2026-07-11-14.47
**Rule**: For every read route the plan labels the CLASS of data that can appear in the response and picks the gate from it (a file an agent writes with repo access → `readRepoFiles`), never from the route's neighbourhood; for a read spanning two authorization domains it re-derives the question from the RESPONSE SHAPE (redact foreign content behind an explicit `redacted` flag, keep the address the contract needs). Every allow-list/scope entry's justification is checked against the grant — a per-row justification ("the edge it created") becomes a predicate in the operation's own WHERE. Client-minted session/bearer tokens are bound to a server-authoritative principal at every privileged write. Acceptance includes at least one POSITIVE test per new grant (deny-only tests cannot distinguish "refused" from "broken"). When a contract is split across two processes, the plan budgets a PARITY suite (one scenario table against the fake AND the real peer). The plan budgets an adversarial review of EVERY fix cycle, not only the original change, and specifically for interceptor / launch-wiring / event-ordering diffs.
