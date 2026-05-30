# Project Rules for /aif-plan

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-05-30
> Based on: 2 adversarial-review pass-throughs (M6 / 2026-05-28, M7 / 2026-05-28)
> + M10 verify pass-through (2026-05-30); /aif-evolve patch analysis (2026-05-30)

## Rules

### Plan MUST enumerate deployment touchpoints
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: For every task that introduces a new env var, config file path, sidecar binary, bound port, or host-mounted file, the plan MUST include a dedicated "Deployment wiring" task in the same phase (or a clearly named follow-up). That task touches the deployment artifacts: `Dockerfile`, `compose.yml`, `compose.override.yml`, `compose.production.yml`, `.env.example`. The task's acceptance criteria explicitly call out which file each new dep lands in.

If runtime wiring is deliberately deferred (e.g. "CCR is dev-only on POC"), the plan MUST include an explicit "Not yet supported in Docker — enable in Phase X by …" doc task that updates `docs/getting-started.md` AND the relevant `docs/configuration.md` section. Silent dev/prod skew is not an option — either wire it or document the gap.

Concrete checklist to apply at plan-write time:

| If the plan adds … | The plan MUST include a task that touches … |
| ------------------ | -------------------------------------------- |
| A new env var the web or supervisor reads | `.env.example` + the relevant service's `environment:` block in `compose.yml` (+ prod overlay if production-relevant) |
| A new config file read at runtime | A bind mount or named volume on the consuming service in compose + a `.env.example` toggle for the host path if it's tunable |
| A new sidecar process spawned by web or supervisor | Dep listed in the consuming `package.json` + lockfile commit + smoke check that the binary is on PATH inside the container |
| A new bound port | Port mapping on the service in compose (if externally reachable) + collision check against the existing service set |

Reason: M6 added `router=ccr` end-to-end in code, including new env vars and a new sidecar daemon, but the compose files were untouched. The shipped runtime cannot exercise the feature, and the gap surfaced only at adversarial review.

### Plan MUST trace every contract surface to its spec file
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: Separate from "what narrative docs to update", the plan's docs phase MUST list every external-facing CONTRACT surface that changes and the spec file that names it. The plan is the place to enumerate this so the implementation phase has an explicit checklist — `/aif-verify` then re-derives the same list from the diff as a cross-check.

Surfaces to enumerate (the right side names the spec file by default; add others as the project grows):

| Surface | Default spec location |
| ------- | --------------------- |
| HTTP route added/changed (path, method, status codes, body shape) | `docs/api/<service>.openapi.yaml` + the prose contract doc (e.g. `docs/supervisor.md` for the supervisor) |
| Wire field changing semantics (e.g. from "reserved" to "load-bearing") | The same `.openapi.yaml` AND the same prose contract doc — both prose and example payloads need to move |
| SSE / WebSocket event added/changed | `docs/api/async/<channel>.asyncapi.yaml` + the relevant `docs/system-analytics/*.md` |
| New domain error code | `docs/error-taxonomy.md` |
| New env var or config-file path | env-vars table in `docs/configuration.md` (the prose CCR-bundling section is not enough — the table is canonical) AND `.env.example` |
| New DB column / table / index | Drizzle migration + `docs/database-schema.md` + the relevant `docs/db/*.md` ERD |
| New `package.json` script or CLI entry point | `docs/getting-started.md` "Scripts" section + the relevant `CLAUDE.md` slice |
| New Flow DSL step type / mode / field | `docs/flow-dsl.md` + the schema in `web/lib/config.schema.ts` |

Reason: in M6 the `POST /sessions` body field `router: ccr` became load-bearing (could return 503 for missing config / token / health failures), but `docs/supervisor.md` (the supervisor's prose contract doc) was not on the plan's docs list and remained stale. Tracing each surface to a spec file at plan-write time prevents this.

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

| Label | Source | Trust-boundary implication |
| ----- | ------ | -------------------------- |
| `url-param` | path parameter validated by route shape | Trusted iff the URL itself is access-controlled. |
| `auth-context` | session / JWT claim / API key binding | Trusted (server-issued). |
| `server-state` | registry lookup, DB join through a trusted id | Trusted (server-derived). |
| `body-controlled` | request body field | **Untrusted** — every downstream use (filesystem path, cross-resource lookup, SQL WHERE) requires either strict validation against an allow-list OR comparison against a corresponding `server-state` value. |

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

### Plan MUST physically separate trust from execution for any fetch-then-execute of third-party content
**Source**: M10 second adversarial review (2026-05-30-13.03)
**Rule**: Any feature whose code path fetches/installs external content (clone a repo, download a package, pull a plugin) and later EXECUTES code from it (`setup.sh`, `postinstall`, hooks, plugin entrypoints) MUST be planned so that:

1. The steps are ordered **fetch/install → establish trust → execute** — never fetch-then-execute in one breath.
2. The execution call lives in a function PHYSICALLY SEPARATE from the fetch/install function, so execution cannot be invoked before a trust decision (the install function must not be able to run the hook).
3. Execution is gated on an explicit trust state persisted in the store (`trusted_by_policy` or operator-confirmed), never on "we just installed it".

Plan acceptance criteria MUST name, for each executable hook the feature ships: WHERE it runs and WHAT trust gate precedes that exact line. Mandatory regression: install an untrusted source carrying a `setup.sh` → assert the script did NOT run (no side effect / sentinel absent) until an explicit trust + enable. (M10: `installRevision` ran `bash setup.sh` from a possibly-untrusted source during install — arbitrary code execution before any trust decision.)

## Auto-generated rules (managed by `/aif-evolve` — do not hand-edit below this line)
