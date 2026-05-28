# Project Rules for /aif-review

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-05-28
> Based on: 2 analyzed patches + 1 adversarial-review pass-through (M7 / 2026-05-28)

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

## Auto-generated rules (managed by `/aif-evolve` — do not hand-edit below this line)
