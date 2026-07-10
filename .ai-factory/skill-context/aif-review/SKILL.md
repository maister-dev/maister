# Project Rules for /aif-review

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-07-11
> Based on: 2 analyzed patches + 1 adversarial-review pass-through (M7 / 2026-05-28)
> + /aif-evolve patch analysis (M9-M10 docs-drift + auth-first, 2026-05-30;
> M11b/M11c adversarial-review batch, 2026-06-01)
> + /aif-evolve 107-patch batch (2026-06-17, cursor 2026-05-30 → 2026-06-16)
> + /aif-evolve 114-patch batch (2026-07-11, cursor 2026-06-16 → 2026-07-07)

## Rules

### Body-controlled cross-resource identifier — flag as CRITICAL when server-state holds the same value
**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: For every HTTP route handler in the diff (Next.js Route Handler, Fastify route, Server Action), enumerate every field consumed from the request body. For each body field that NAMES a cross-resource locator — project slug, run id, step id, workspace id, tenant id, any filesystem path component — locate whether the handler has access to the same value from a `server-state` source on the same request:

- Session registry / connection record (e.g. `registry.get(sessionId).record`).
- DB row fetched via a URL parameter (e.g. `db.select … where id = urlParams.runId`).
- Auth context / JWT claim / API key binding.

If the answer is yes (server-state has it), the body field is **redundant AND a trust-boundary smell**. Flag as CRITICAL `#trust-boundary`. The expected fix is to drop the body field and derive from server-state, NOT add a regex to the body field — regex only protects against syntactic abuse, not against using `sessionA`'s valid id to operate on `sessionB`'s resources.

When the body field genuinely IS needed (e.g. multi-tenant route not yet authenticated), confirm there is an explicit comparison against the corresponding `server-state` value AND a stated mismatch response (typically 409). Absence of either → flag.

Severity stays CRITICAL even when the affected service is documented as "internal-network only" — that assumption rots.

### Idempotency marker committed before downstream side-effect — flag as CRITICAL
**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: For every state-changing route handler in the diff, locate any column that functions as an idempotency / completion marker (`respondedAt`, `completedAt`, `processedAt`, `deliveredAt`, `acknowledgedAt`, `finishedAt`). For each marker, walk the handler in execution order and identify:

1. The DB statement that writes the marker (or relies on a default `now()`).
2. Every downstream side-effect that happens AFTER the marker write (HTTP call to a sibling service, file write to disk, queue publish, RPC call, subprocess spawn).

If any downstream side-effect runs AFTER the marker is committed, the route is **non-retryable on side-effect failure** — flag as CRITICAL `#retry-semantics`. The expected fix is the two-phase pattern documented in `.ai-factory/skill-context/aif-plan/SKILL.md` ("Plan MUST specify two-phase commit for routes with downstream side-effects"):

- Phase 1 commits user intent (request body, response choice) WITHOUT the marker.
- Side-effect runs outside the transaction.
- Phase 2 commits the marker only after the side-effect acks.

Also flag if the failure classification is missing — a route that returns identical 4xx/5xx on every failure flavor cannot distinguish retryable from terminal. The diff should include separate handler branches with separate status codes for: downstream 404 (terminal), downstream 5xx (retryable), network/timeout (retryable), validation errors (4xx terminal).

Severity stays CRITICAL even when the downstream service is co-located in the same compose stack — "supervisor restarts mid-deploy" is a real failure mode the route must survive.

Extensions: a resume/idempotent handler re-drives on STATUS, not the idempotency marker — the resource stays in the awaiting state (`NeedsInput|NeedsInputIdle`) until the runner claims it via an idempotent CAS claim (`claimAndResumeAgentRun`, 0 rows = already advanced = no double-spawn) callable from both the response path and the already-delivered retry; never CAS `NeedsInput→Running` inside the response tx — the runner owns that transition. Flag a handler with multiple outcomes (insert / reinforce-update / no-op) whose idempotency is keyed on ONE branch's side-effect — require a consumption ledger (`brain_harvested_events`) written on ALL branches in the effect's transaction. A composite with an unrollbackable external side effect needs a durable idempotency key persisted BEFORE it (retry adopts the already-launched run, never relaunches). Operator/human input files deleted before downstream durable side-effects succeed = a durability-boundary violation — flag it.
**Source (additions)**: 2026-06-24-02.29, 2026-07-02-15.32, 2026-07-03-00.00-budget-breach-review-followup, 2026-06-24-18.46

### catch block in deferred-creating code path — flag as CRITICAL when explicit release is missing
**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: For every catch block in the diff, ask: does the try block (or the SSE event handler / queue consumer / etc enclosing the catch) observe a remote-deferred-creation signal — a "request created", "permission requested", "tool call awaiting approval", or any signal where another process has registered a pending promise / timer / handle that THIS code path is expected to release?

If yes, the catch block MUST contain an explicit call to release the deferred (resolve / cancel / reject — pick the right semantic for the failure cause). "Log the error and continue" is wrong here — flag as CRITICAL `#hidden-deferred`. The deferred-creating side is now leaked until its own timeout fires (typically 30+ min), invisible to operators.

Concrete patterns to spot:

- A handler for an SSE event named `*.request`, `*.permission_request`, `*.awaiting_approval`, `*.requested` whose catch block does not call a sibling `*.cancel` / `*.reject` / `*.deny` API.
- A consumer of a queue message of type "request" whose catch block does not publish a corresponding "cancel" / "reject" / "ack-failed" message.
- A callback registered for a long-poll handle whose catch block does not call the corresponding "abort" / "close" API.

Also flag tests in the same diff: a regression test MUST exist that simulates a failure in the deferred-releasing code path AND asserts the release API was invoked exactly once with the right arguments (spy / mock assertion). Without that test, the rule cannot regress safely.

### Path-operation audit: trace every path operation back to its validator
**Source**: 2026-05-26-12.45.md
**Rule**: For every `path.resolve` / `path.join` / `fs.*` / `child_process.spawn` argv (including `cwd`) usage in the diff, locate the upstream validator that produced the input. If the input arrived as `z.string()`, `z.string().min(N)`, or any other "open" string type without a regex constraint (`^[A-Za-z0-9._-]+$` for filesystem path segments) or a path-shape `.refine()` (`startsWith("/")` + no `..` for absolute paths) — flag as CRITICAL `#path-traversal`. Apply the same scrutiny to SQL parameter construction and any raw HTML/`innerHTML` sink. Severity stays CRITICAL even when the affected service is documented as "internal-network only" — that assumption rots.

### Boolean simplification: flag `A && X !== K` where A constrains X
**Source**: 2026-05-26-12.45.md
**Rule**: Flag conditions of the shape `A && X !== K` where `A` already implies the right side. Example: `res.ok && res.status !== 204` — `res.ok` is true iff status is in [200, 299], so the `!== 204` branch is dead code. ESLint will not catch this class of redundancy; the reviewer must. Tag findings as `#dead-code`. Add to the "Best Practices" section of the review summary, not "Critical".

### When the diff adds a Zod regex/refine to one field, check sibling fields
**Source**: 2026-05-26-12.53.md
**Rule**: When reviewing a Zod schema where the diff adds a security regex / `.refine()` to one field, scan every sibling field of similar type in the same schema. Flag any sibling that flows into a filesystem / subprocess argv / SQL / HTML sink without an equivalent constraint. Same finding type as the first field — do not let partial-coverage waves through.

### Review exit MUST re-derive every analytics/spec surface from the diff and treat drift as a must-fix
**Source**: M7 adversarial review passes 3-4 (2026-05-28-20.01, 2026-05-28-20.32); M9 branch review (2026-05-29-15.38); M10 verify pass-through (2026-05-30)
**Rule**: Before a review can exit clean, enumerate every analytics/spec surface the diff touches and reconcile EACH against the code at HEAD — never trust the doc's own status tag. The reconciliation set, by changed area:

- **state machine / lifecycle change** → the matching `docs/system-analytics/*.md` `stateDiagram` AND its Expectations + Edge-cases bullets AND its refusal/precondition table must match the code's actual transitions and guards (M10: the analytics refusal table was a deny-list while the code was a stricter allow-list);
- **DB schema change** → `docs/database-schema.md` AND the relevant `docs/db/*.md` `erDiagram` both updated (M10: the ERDs were left stale);
- **HTTP/SSE wire change** → `docs/api/*.openapi.yaml` / `docs/api/async/*.asyncapi.yaml` paths, bodies, status codes, and example payloads;
- **error-code / semantic change** → `docs/error-taxonomy.md`;
- **a route target newly referenced by the UI** → a matching `page.tsx` (a link to a route is a contract).

Per `docs/CLAUDE.md`'s "code wins" policy, analytics drift is a MUST-FIX in the SAME review, not a follow-up — "code lands, docs follow" is the exact pattern that produced consecutive M7 review rounds describing pre-Mx behavior. Also flag any spec section that describes behavior absent at HEAD unless it is explicitly tagged Designed Mx / Phase 2 (R6). The review summary MUST list each analytics surface checked (even "no change required"), mirroring the `/aif-verify` contract-surface enumeration on the review side.

**Highest-risk drift sub-surfaces (re-found across M18-M34):** a **documented edge-case bullet** is the most dangerous drift — it reads as a reviewed invariant and steers future implementers back to the old shape, so a converged/removed special case MUST delete or rewrite its edge-case bullet (not just the diagrams/enums). On a **dormant-capability flip** (a previously-off actor/kind going live), grep older-stage analytics for `never` / `not yet` / `MUST NOT` claims + `(Designed)` status tags the flip invalidates. Derive DB cascade/default claims from the migration SQL `ON DELETE`, not prose. A retirement (a dropped route/status/field) is a contract-WIDE sweep: grep the whole docs tree for the old token (`413`, `files/content`) across Expectations bullets, mermaid labels, edge-case lists, error-taxonomy, env tables, and ADR wording — they drift independently of the primary prose. A `[ADR-NNN]` cite with no `### ADR-NNN` header at HEAD, or a migration number that disagrees with `_journal.json`, is a build break — grep `git show main:docs/decisions.md` for the number before approving a merge.

Contract-fidelity additions: code must enforce the CONTRACT, not a stricter paraphrase — when a guard's comment and OpenAPI say "resolvable from A OR B" and the code checks only A, the CODE is the defect (the spec was right); cross-check guards against the published spec and require the B-path regression. A documented MUST/edge-case bullet the code doesn't satisfy is a must-fix, not a doc-only nit — and prefer implementing the SAFER documented behavior over downgrading the doc to match weaker code. When a diff touches ANY part of an operation (one response field, one example), reconcile the operation's WHOLE request+response surface against code at HEAD — "I only touched `count`" does not scope the review. A mermaid step below an early `return` is drift — verify neither diagrammed branch returns before the step (`squashRunBranch` was diagrammed feeding both merge and PR while the code returned first for PR mode, making `commits=squash_rework` a silent no-op for PR promotions).
**Source (additions)**: 2026-06-25-19.58, 2026-06-25-17.42, 2026-07-02-16.42, 2026-06-20-18.20

### Auth-first ordering — authenticate before any resource lookup, read routes included
**Source**: M9 adversarial review rounds 2-3 (2026-05-29-13.52, 2026-05-29-14.38); M9 branch review (2026-05-29-15.38)
**Rule**: For every route handler / server action in the diff, confirm the FIRST awaited operation is the session/active-session gate (`requireActiveSession` or equivalent, INCLUDING the forced-password-change gate) BEFORE any DB lookup of the named resource. A handler that reads `hitl_requests` / `runs` / `projects` before authenticating lets an unauthenticated or password-gated caller probe resource existence (a timing / error-shape oracle). This applies to READ routes (GET / stream) too, not only state-changing ones. Project-role authz then runs against a server-DERIVED `projectId` (from the resource row), never a body field. Flag ordering violations as a security finding, not a nit. (Three consecutive M9 review rounds re-found this on different routes — it is a systemic ordering bug, not a one-off.)

**Extends to body-parse and write-scope (re-found across the M16/M17/M27/M34 routes):**
- The auth gate MUST be the FIRST `await` BEFORE `req.json()` / Zod `.parse()` — parsing the body first returns `422 CONFIG` (leaking the body schema) to an unauthenticated caller instead of `401`. Flag any `req.json()` / `.parse(` appearing above `requireActiveSession`/`requireGlobalRole`/`ctx.authorize`. After reordering N routes, grep EVERY changed route — an "auth-first on all routes" claim was refuted by a `tasks` POST still parsing first.
- `ctx.authorize` runs immediately after the minimal lookups that resolve `projectId`; every other precondition/classification/enriched error (launchability, archived, `KEY-N` blocker ids) comes AFTER it (else it leaks state to an unauthorized caller).
- **Authz scope must match WRITE scope:** a project-URL route whose handler mutates platform-scoped rows (fans `setup.sh` trust across every project on a shared `package_installs` row) needs `requireGlobalRole("admin")`, not project `managePackages`. A project route updating rows with no `projectId` in the WHERE is a red flag.
- **Fanout tables are not authorization:** a read model over per-recipient fanout rows (`inbox_items` filtered only by `(recipient_type, recipient_id)`) must re-derive visibility at read time (membership inner-join on `project_members` for non-admin + `archived_at IS NULL`); apply to the unused-but-exported sibling too.
- Server-authoritative fields (`readinessStatus`, ids, timestamps) must NOT appear in request Zod schemas — `.strict()` then rejects them (422); a present-but-overridden field is still a trust smell.
- **`requireSession(` is the password-change escape hatch ONLY** (it enforces neither `accountStatus === active` nor `mustChangePassword === false`): every state-changing or role-scoped route uses `requireActiveSession()` / `requireGlobalRole` / `requireProjectAction` — grep `requireSession(` in route handlers during review; a single route gated weaker than its siblings is the tell. Confirm the error taxonomy maps ALL auth codes (`ACCOUNT_INACTIVE → 403` was missing, surfacing a disabled session as 500).
- **Auth-first applies to CHANGED routes, not only new ones** — an "auth-first on all routes" claim was refuted twice by a missed twin (a `tasks` POST; the promotion-hold PUT next to the fixed settings PATCH); grep every changed route AND its route-class siblings, and require the regression test asserting unauthenticated-malformed-body → 401/403, never 422.
**Source (additions)**: 2026-06-20-21.18-m36-flow-package-viewer, 2026-06-23-14.56, 2026-06-30-12.23, 2026-07-01-11.45, 2026-07-03-14.58

## Auto-generated rules (managed by `/aif-evolve` — do not hand-edit below this line)

### Multi-write transition without one transaction / CAS-first ordering — flag as CRITICAL
**Source**: 2026-05-31-22.46, 2026-05-31-23.49, 2026-06-01-12.55
**Rule**: For every state-changing handler OR background sweep/watchdog in the diff that writes more than one row (status column + ledger/`node_attempts` row + cursor + artifact), walk it in execution order and check four things:

1. **Atomicity + crash windows.** Are all the persistent writes inside ONE `db.transaction`/CAS? If not, is there a reachable PROCESS-DEATH partial state (crash between two independent commits) with no tested recovery path? A recovery sweep that filters on a single status only rescues states that reach it. Missing recovery for a reachable partial state → flag CRITICAL `#atomicity`.
2. **Guard-before-side-effect (CAS first).** When a contention guard (status CAS) coexists with another write that has its OWN unique constraint, the CAS MUST run FIRST so only the winner performs the constrained insert. If the constrained insert runs before the CAS, a concurrent loser raises a raw Postgres `23505` that surfaces as 500 instead of the documented 409 → flag CRITICAL `#error-contract`.
3. **Ledger clobber.** A background sweep that updates a ledger row with NO status predicate (`markNodeFailed(id, …)` not guarded by `WHERE status='Running' AND current_step_id=<node>`) can overwrite a concurrently-`Succeeded` attempt to `Failed` → flag `#ledger-clobber`.
4. **Lie about terminal state / store split.** Anything marked terminal `Failed` BEFORE the underlying execution is confirmed stopped or absent (a retryable teardown error treated as "give up") → flag `#split-brain`. A release/abandon that flips `runs.status` but leaves the takeover `node_attempts` row open → flag `#store-split`.

Require a REAL concurrency test (two racers) for the 409-vs-500 contract, not a single-threaded one. Severity stays CRITICAL even after a green per-phase gate — these are the exact edges per-phase reviews miss.

### New run status / enum value / state-changing route not fanned out to ALL consumers — flag drift; deny-list guards are a finding
**Source**: 2026-05-31-22.46 (#3/#4), 2026-05-31-23.49 (#1), 2026-06-01-12.55 (#3)
**Rule**: When the diff adds a `runs.status` value, an enum case, or a state-changing route, grep the new value into EVERY consumer and flag the misses:

- present in one read model but absent from another (board has it, portfolio/home does not — a claimed run vanishes from the home grid while holding a slot) → `#read-model-drift`;
- absent from the scheduler/cap predicate or a recovery/idle sweep's candidate filter → `#consumer-miss`;
- a state guard written as a deny-list of a coarse property (`!terminal`) rather than an allow-list of exact valid states (`status ∈ {NeedsInput, NeedsInputIdle}`) → flag as a security/correctness finding `#guard-denylist`: it silently admits the new status (M11b: `HumanWorking` slipped a `!terminal` HITL guard and let a stale pre-takeover decision be stored);
- a new terminal transition that frees a concurrency slot but never calls `promoteNextPending`/`releaseSlotOnIdle` → `#stranded-queue`;
- a new state-changing route shipped with no OpenAPI/AsyncAPI path → `#missing-contract`.

These are not nits — a claimed run holding a slot invisibly and a guard admitting an un-vetted status are real availability/correctness defects.

Extensions: reusing an existing status SET for a new concern without a semantics check is the same defect class as a deny-list guard — `SETTLED` (= done WRITING) was silently reused as "safe to AUTO-merge" while failure-terminal siblings are settled-for-writing but not shippable; require a concern-named predicate (`countFailureTerminalSharedSiblings`). A schema accepting an enum value with NO implementation → `#silent-noop` (require implement-or-reject-at-boundary via `assertExecutionPolicySupported`-style typed `CONFIG`; grep every consumer of the enum's resolver). A column going NULLABLE fans out like a new enum value (slot counters, per-project sweep candidate queries, authz gates that throw on null). A new enum/kind value fans into AUTH surfaces too: actor-authorization guards (default new HITL/escalation kinds to the HUMAN-ONLY side — a machine token could dismiss its own `hook_trip` guardrail), TS Extract/narrowing types, dispatch switches, i18n, AND the agent-token grant list (`AGENT_TOKEN_SCOPES` + scope→action map move with the route scope). Two independent enumerations of one closed set (schema union + UI mirror constant) → require derive-from-schema or a compile-time exhaustiveness assertion (`satisfies Record<SchemaType, …>`); a map keyed by a closed union whose miss silently falls back (`Record<string, …>` + runtime default) hides drift — require `Record<Union, …>` so a missing key is a compile error.
**Source (additions)**: 2026-06-22-11.08, 2026-06-22-13.40, 2026-06-20-18.20, 2026-06-27-23.45, 2026-06-23-13.22, 2026-06-24-19.45

### Public response returns a DB row or a server-only handle — flag as #response-leak
**Source**: 2026-05-30-13.38, 2026-05-31-23.58, 2026-06-01-01.29
**Rule**: For every public route handler / server action response in the diff, flag `#response-leak` if it returns a DB row or a service object verbatim, OR includes any server-only operational field: `acp_session_id`, supervisor session id, adapter launch argv/env, materialized paths, worktree paths, internal cost handles. The expected fix is an explicit response-DTO projection at the boundary mirrored in `docs/api/web.openapi.yaml` + a test that asserts the EXACT shape (no extra keys) — never redaction-by-hope or "the service type is internal so it's fine". Also flag a public response whose documented shape does not match the route's actual return (duplicate OpenAPI 409 entries, a `capabilityProfile` schema that diverges from the handler) — a contract that lies is a review finding. (M11/scratch-runs leaked supervisor/materialization handles and shipped register routes returning richer-than-contracted bodies.)

**Project DTOs PER discriminant, and treat any guarded field as sensitive at ALL boundaries.** A shared read-model DTO that crosses to the browser must be projected per `kind`/variant — a `permission` HITL row carries `supervisorSessionId` / `requestId` / `toolCall` in its `schema`, so the projection must be `row.kind === "permission" ? null : row.rawSchema`. This exact leak shipped across FOUR readers (board, inbox, run-detail, ext `GET …/hitl`) and into the RSC flight payload — when one boundary already guards a field, that is a signal it is sensitive at EVERY boundary; grep all sibling readers. A `{ ok, id }` response (not the stored row) is the secure default for create/mutate routes. Flag a "present for `<variant>`" field note in a shared schema the moment a second variant gains the field (same instinct as sibling-Zod-sweep, for docs).

### Concurrency review red-flags — a transaction is atomicity, NOT serialization
**Source**: 2026-06-02-18.44, 2026-06-03-00.52, 2026-06-03-01.27, 2026-06-07-18.35, 2026-06-08-13.13, 2026-06-10-11.42, 2026-06-10-20.48, 2026-06-11-15.00
**Rule**: For every concurrent read-then-write / check-then-act in the diff, flag:
- `SELECT … FOR UPDATE` + an unconditional `UPDATE … WHERE id` → last-writer-wins disguised as a lock. The write predicate must carry the client-observed value (`WHERE version = expected` / `WHERE role = expectedRole` / `WHERE status = observed RETURNING`); 0 rows → typed `CONFLICT`. → `#optimistic-concurrency`.
- A `SELECT id … FOR UPDATE` that selects only `id` and never re-reads the guarded column (`status`) under the lock → the guard is on the optimistic pre-read, not the locked path. → `#toctou`.
- A lock taken on table A (`runs`) while the mutation writes table B (`gate_results`) that other writers touch without A's lock → wrong-lock-scope; lock the row whose invariant you protect. → `#wrong-lock-scope`.
- A set-membership CAS (`status IN (...)`) where the requirement is "reject if it changed under me" — use the EXACT observed value (`status = live.status`); a set CAS silently permits within-set transitions (a `stale` gate restored by a racing report). → `#cas`.
- An insert gated by a read-then-write `SELECT` instead of `onConflictDoNothing().returning()` (TOCTOU → raw `23505` → 500 instead of 409). → `#race-condition`.
- A CAS whose guard state is re-enterable by a timeout/reclaim with no fencing token (per-attempt stamp, `eq(lastFiredAt, stagedAt)`) → a hung attempt overwrites a newer reclaim's marker. → `#fencing`.
- A batch loop staging side-effects that reads a pre-batch count (`countLiveRuns`) for each item instead of threading `reservedSlots` → cap-3 launched 10. → `#batch-state`.
- `NOT (nullable_col = X AND …)` — three-valued logic drops NULL rows; require `IS DISTINCT FROM` / explicit `IS NULL` arms. → `#sql-null`.
- A write-once/idempotency marker set AFTER a destructive or divergent side-effect (irreversible `discard` before the CAS) → claim-before-side-effect; marker-after is acceptable ONLY when every racer's effect is idempotent AND identical. → `#claim-order`.
Require a REAL two-racer test (uncommitted write on a 2nd pg connection + `pg_stat_activity` wait, or one-shot `vi.spyOn(db,"transaction")`) for any 409-vs-500 contract — a single-threaded test is not evidence.
- An UPDATE acting on a row selected EARLIER without re-asserting the selecting predicate in its WHERE (+ `RETURNING`) → `#read-committed-toctou` (a racing decay sweep expired the row mid-reinforce and the domain event was silently consumed); a claim tx that re-reads only `status` while trusting caller-read preconditions written by out-of-band transactions (`promotion_hold`, master toggles) has one TOCTOU per un-rechecked predicate.
- A lock-free pre-read feeding a decision made after the lock (`loadRun` before the claim) → the lock is defeated; require re-read UNDER the lock (and fix inverted lock orders by re-reading, not second-locking).
- A guard on ONE of N transitions into the guarded state (`tryStartRun` but not `promoteNextPending`) → `#guard-every-edge`.
- Concurrent ops on a shared NAMED resource (a reused git remote like `maister-publish`, a temp branch, a singleton row) without per-op isolation or a mutex → cross-request corruption (committed content pushed to the wrong repo).
- A capped background sweep: ask "if the first N rows are permanently ineligible and never change, does row N+1 ever get processed?" — no durable attempt-marker/rotating cursor → `#starvation`.
- One `try` spanning an irreversible side-effect AND a best-effort follow-up, whose `catch` means "the side-effect failed" → `#try-scope`; follow-ups get their own WARN-only catch.
**Source (additions)**: 2026-07-02-17.52, 2026-07-03-14.58, 2026-06-22-14.06, 2026-06-21-03.05, 2026-06-25-20.14, 2026-07-03-16.16

### Establish branch scope with merge-base before trusting a diff — guard against the false-revert
**Source**: 2026-06-09-14.23, 2026-06-09-18.47, 2026-06-05-15.06
**Rule**: Before reviewing/diff-reasoning, run `git merge-base main HEAD`; if main is AHEAD of the merge-base, review `main...HEAD` (THREE-dot), never `main..HEAD` (two-dot) — a diverged base renders main-only files as branch "deletions" (false-revert) and contaminates `--stat`. A reviewer claim of "feature removed" MUST be backed by a removing hunk in a branch commit (`git log -p --follow <file>`), not mere absence in `base..HEAD`. Separately, for `git diff` RANGES in the code under review: a fixed stored SHA base → `base..branch` (literal tree delta); two moving branch tips → `base...branch`. A `...` against a fixed point silently omits committed changes; flag every diff helper and confirm which side is fixed. The project has multiple base→branch diff sites (`diffRange`, `diffRunWorkspace`, `diffNameStatus`) — they must share one semantic; a "match the other helper" comment is a consistency argument, not a correctness one.

### DRY/SSOT — a `// mirrors X` comment is a must-fix, and a verdict must come from the one function that computes it
**Source**: 2026-06-02-02.50, 2026-06-03-02.56, 2026-06-04-12.33, 2026-06-04-16.25, 2026-06-13-20.02
**Rule**: A `// mirrors X:line`, `// Task N reconciles both`, or `byte-equivalent to X` comment is the author confessing duplication that WILL drift — treat it as a must-fix and require extracting the shared core (not "shared leaf helpers" — the COMPOSITION must be shared; a read model re-assembling shared primitives is a divergence waiting to happen). A user-facing capability flag (`isRunRecoverable`, badge readiness, "needs you" count) MUST derive from the ONE function that performs the capability (`classifyRecover`, `assertEvidenceReady`, `portfolio.totalNeeds`), never a re-implemented predicate that "should match"; when re-eval needs DB state, factor the pure DECISION into the shared module and keep the FETCH in the caller (don't drag IO into the SSOT). Flag a value that is a server-degradation signal (truncated/capped diff) smuggled as an in-band marker string instead of a structured `{ text, truncated }` flag — and flag any "can't fully see X" state at a promote/merge/approve gate that only annotates instead of blocking (or blocking + explicit override).

Parity/SSOT additions: a SECOND classifier/verdict parallel to an existing one (force vs manual launchability) is diffed against the original's COMPOSITION — every layer it applies (flow-setup issues via `flowIssue ?? "launchable"`, supervisor readiness, archived) is applied or consciously documented as excluded; "verdict B mirrors A" is checked end-to-end, not at the base classifier. A load-time scanner that mirrors a runtime executor derives the scanned FIELDS from the executor's actual per-branch selection through ONE shared helper (`renderedGateField`) used by both — with `.passthrough()` schemas "unused field" is representable, so scan `action.prompt` only for prompt-action node types and `action.command` only for command-action types, tested per kind × field. A hardcoded constant where every sibling reads a config value (`workspacePolicy: "keep"` next to `workspacePolicies[0]`) is a parity must-check. Protocol encoders live in the schema-owning module so serialization cannot drift from validation. UI permission props mirror backend action gates at the SAME granularity — no collapsing kind-specific route authz into one screen-level boolean. Contract mirrors drift BOTH directions: flag phantom spec params the code never reads AND code fields the spec lost; a route must accept the documented optional/empty body (map to the documented default, e.g. `{ stopLiveRuns: true }`); the UI must expose the documented contract range (the server accepted 2..12 variants while the screen offered fixed A/B).
**Source (additions)**: 2026-06-30-13.02, 2026-07-01-01.27, 2026-07-01-12.38, 2026-06-22-20.53, 2026-06-25-17.16, 2026-07-04-01.04, 2026-07-02-14.14, 2026-07-04-14.25, 2026-07-04-00.47

### Run an adversarial/invariant pass on security- and state-machine-heavy diffs; stated invariants are checklist items
**Source**: 2026-06-21-11.58, 2026-06-18-15.42, 2026-07-01-12.55, 2026-07-02-17.03
**Rule**: For diffs touching trust boundaries, filesystem mutation, error classification, or run-state machines, run an explicit adversarial pass that challenges invariants under edge/terminal conditions — it finds a different bug class than defect-focused review (it caught two holes a normal /aif-review plus six review subagents all missed; four completeness/consistency self-review passes still shipped a supply-chain hole). Every stated invariant (INV-N in a `system-analytics` Expectations section) becomes a review checklist item: enumerate EVERY code path that could violate it — "unconditional / both pools" means ALL paths including sibling subsystems (hook_trip approve, budget-raise, orchestrator transitions), not the one the feature author had in mind.

### Any-ever-true reads over append-only ledgers — flag as #temporal
**Source**: 2026-07-03-16.40
**Rule**: `rows.some(passed)` (or any historical-max read) over a temporal, append-only table (`gate_results`) is almost always wrong — the latest LIVE record governs, not the historical max: a stale `passed` from a superseded attempt must not satisfy a gate over a newer `pending`/`failed`, and advisory external checks bypass `readinessGreen()`. Require the SSOT reducer helpers (latest-attempt filter + newest-report collapse + allow-list readiness predicate) and a temporal test case (older passed attempt + newer live pending ⇒ `declared_not_passed`).

### force/skip/already-done flags computed from side-effect returns — flag as #retry-safety
**Source**: 2026-06-20-19.48
**Rule**: Any new `force`/`overwrite`/`skip`/`already-done` flag derived from a non-idempotent operation's RETURN value, on a path guarded by a durable claim/reclaim, is a retry-safety smell — the second attempt sees the already-consumed state (no-op squash → `forcePush=false` → non-fast-forward `CONFLICT`). Require derivation from the durable snapshot (a pure predicate like `squashesRunHistory(claim)`) and a reclaim-path regression test (stale claim + no-op side-effect + assert the flag).

### Authority gates keyed on data attributes instead of the actor — flag as #actor-authority
**Source**: 2026-06-22-12.47
**Rule**: A gate deciding "automated vs human" from a data attribute of the object acted upon (`launchMode === "auto"` describes the child's ORIGIN) is wrong the moment a human acts on such an object — key on the actor/context (`isHumanPromotion(ctx)`: actor absent or `kind === "user"` ⇒ human; `system`/`agent` ⇒ unattended). Ask: "would a human ever act on an entity with that attribute?" — if yes, flag. Also verify a test's ACTOR matches its stated intent: a "manual promote" test driving the system/token entry point lies about its actor — check that before weakening a gate to keep it green.

### Kill-switches, disable paths, and gated resources — review as recovery paths
**Source**: 2026-07-04-14.30, 2026-07-02-15.32, 2026-07-02-17.52, 2026-06-30-13.02
**Rule**: A soft-disable/kill-switch operation must not require the broken dependency it is disabling — `updateAgentLink(..., { enabled: false })`-style pure metadata updates skip content validation (readability stays required for enabled-state edits); test disable-of-broken-resource separately from happy-path disable. When a feature has a disable switch or authorization gate, enumerate EVERY consumer of the gated resource and confirm each asserts the gate (ambient recall checked launch-time `runs.brain_context` but not live `projects.brain_enabled` — "disabled → no-op" must hold for every door) — prefer ONE predicate enforced INSIDE the performing service (`guard.ts` inside `recall()`/`retain()`) over copy-pasted caller checks (callers keep checks only for ordering/UX). "Already configured" (an id/fk exists) ≠ "currently valid/launchable" (the referenced resource still resolves and is enabled) — a gate relying on the former silently admits the latter's failure modes.
