# Implementation Plan: Flow Review Workspace

Branch: `feature/flow-review-workspace`
Created: 2026-07-14

## Settings

- Testing: yes — test-first at every behaviour boundary; RED → GREEN → refactor.
- Logging: standard — structured identifiers/counts/digests only; never log review
  text, prompt text, or full feedback packets.
- Docs: yes — Phase 0 is a blocking SDD contract; as-built reconciliation is a
  separate final gate.

## Roadmap Linkage

Milestone: `none`

Rationale: Skipped by user.

## Goal

Make a human Flow review a single trustworthy activity inside MAIster:

1. Inbox routes a reviewer to code rather than inviting a blind decision.
2. The gate opens one Review Workspace with a complete current-review diff,
   inline threads, feedback preview, and exactly one decision control.
3. `Request changes` can only proceed when MAIster can prove which Flow target
   consumes the feedback; the reviewer sees the exact packet before sending it
   and the runner records the packet actually delivered.
4. Human-facing confidence self-report is removed without breaking the
   established external/API persistence contract.

## Scope and non-goals

**In scope**

- A Flow-only `review` diff scope: workspace base commit → current working
  tree, including committed, staged, unstaged, and untracked reviewable files.
- One gate-specific Review Workspace, Inbox deep links, inline review comments,
  deterministic feedback-preview/proof, strict Flow feedback validation, and
  durable coordination with the existing gate-chat transcript.
- Removing confidence controls and client emission from human UI surfaces.
- SDD artifacts, API contract, analytics, screen references, TDD/integration,
  and Playwright coverage.

**Out of scope**

- GitHub/GitLab PR synchronization, suggested edits, multi-reviewer approval
  policy, fuzzy re-anchoring, or changing Files-pane tracked-file policy.
- Changing final-delivery `ReviewPanel` semantics: it remains a promotion
  surface (`base → run → target`), not a human rework gate. Shared diff
  primitives are allowed; merging the two meanings is not.
- Removing `human_confidence` from the public/external HITL transport or DB.
  That would be a separate breaking API and migration project.
- Giving external tokens a second, blind code-review decision surface. A
  `schema.review === true` gate is decided only from the authenticated Review
  Workspace; external tokens remain supported for every other eligible human
  HITL kind.

## Locked decisions and invariants

### D1. Canonical review source

`scope=review` is Flow-only and computes
`workspace.base_commit (or resolveBaseRef) → working tree` through
`diffWorkingTree(worktreePath, base)`. It includes committed, staged,
unstaged, and untracked changes; its text and `nameStatus` use the same
reviewable-change filter. The REST default stays `scope=run` for compatibility.
Only the Review Workspace opens with `scope=review`; `run`,
`since-last-review`, `last-node`, and `uncommitted` remain explicitly labelled
secondary forensic scopes.

Comments authored in the Review Workspace use `scope=review`. Existing rows
do not store a scope, so their placement is recalculated against the selected
read source; no historical comment data is rewritten.

### D2. One review decision location

For `schema.review === true` Inbox is triage, not a decision form. The card
shows its normal task/branch/iteration/change summary and a **Review code**
CTA to the run’s Review Workspace. The generic inline response remains for
permissions, forms, clarification, consensus, budget, and non-review human
HITL. A run with an open review gate renders only the workspace decision rail;
it must not also render `RunHitlResponse` elsewhere on that page.

### D3. Review feedback is a verifiable server contract

Add a side-effect-free endpoint:

`POST /api/runs/{runId}/hitl/{hitlRequestId}/review-feedback-preview`

The body contains only the proposed review response:

```json
{
  "response": {
    "decision": "rework",
    "comments": "Please validate empty input.",
    "workspacePolicy": "keep"
  }
}
```

`runId` and `hitlRequestId` are URL parameters; the authenticated actor is
auth context. `projectId`, open HITL row, transition target, `commentsVar`,
thread ids, gate-chat messages, workspace, and pinned Flow graph all come from
server state. No body field may name a run, workspace, Flow node, path, comment
id, target, or template variable.

The endpoint validates the same stored allow-list as the response route and
returns only for a live rework decision:

```json
{
  "reviewSource": { "scope": "review", "baseCommit": "<sha>", "fingerprint": "sha256:<digest>" },
  "feedback": {
    "fingerprint": "sha256:<digest>",
    "target": { "nodeId": "fix", "commentsVar": "review_comments" },
    "openThreadIds": ["<uuid>"],
    "resolvedThreadCount": 1,
    "gateChatMessageCount": 2,
    "payload": "<exact deterministic markdown>"
  }
}
```

The existing `composeReworkPayload` byte format remains frozen. A shared
feedback-packet service loads the same open roots/replies and deciding-gate
chat, builds the payload, and derives both digests; the preview and graph
runner must call that service. Resolved roots are excluded. The pre-submission
dialog shows the payload, target, included counts, and an explicit
"resolved threads are excluded" fact.

Only the session-auth **rework** response accepts the two opaque preview
fingerprints. Under the existing HITL row lock, a *fresh* claim
recomputes/compares the packet fingerprint and rejects mismatch with
`409 PRECONDITION`, without a response, artifact, or runner wake. The review
source fingerprint likewise rejects a changed worktree with `409 PRECONDITION`;
the UI announces refresh and requires a new preview. A rework additionally
needs a non-blank summary or at least one open root, otherwise it is `422
NEEDS_INPUT`. This removes reasonless rework.

The initial fresh-claim branch and the idempotent-retry branch are deliberately
different. Preview fingerprints are transport-only and are never stored in the
canonical response or input artifact. Once a row has a canonical response, an
identical retry compares that canonical payload, returns the established
idempotent outcome, and does **not** recompute the live source/packet (the
runner may already have changed the worktree). A different canonical response
still returns `409 CONFLICT`. `approve` keeps its existing response contract
and does not call the rework-preview endpoint.

Review-comment mutations serialize on the same HITL row and require both
`response IS NULL` and `responded_at IS NULL`; after a claim they cannot alter
the packet between preview and runner consumption. Gate chat has a longer ACP
side effect and therefore must not hold a database lock across the prompt. A
durable `gate_chat_turns` lifecycle records a single `pending` turn before the
prompt, atomically marks it `completed` with its agent message afterward, and
marks failed/expired/aborted turns terminally. Response claim refuses a live
pending turn with retryable `409 PRECONDITION`; packet composition includes
only completed turns. A lease expiry lets a crashed prompt be finalized without
blocking the review forever; a late agent reply for an aborted turn is dropped.
The existing runner `human_note` evidence gains the derived digest and remains
the durable proof of the payload actually supplied to the target.

The external v1 respond endpoint must reject every `schema.review === true`
gate with `409 PRECONDITION` before it calls `respondToHitl`; it has no matching
code/diff/preview surface. Its contract explicitly directs the caller to the
authenticated Review Workspace. Other eligible human/form/permission responses
retain their current external compatibility.

### D4. Fail closed before a reviewer can lose feedback

For every human-review transition that leads to a rework target, graph
compile/load validation must prove:

- an effective `commentsVar` exists (`rework.commentsVar`, otherwise
  `finish.human.commentsVar`) and is a valid top-level template key;
- every allowed rework target is a renderer;
- the renderer reads that exact key in the field it actually renders:
  `action.prompt` for `ai_coding`, `judge`, and `orchestrator`; `action.command`
  for `cli` and `check`.

Missing variables, unsupported target types, or a non-consuming template throw
`MaisterError("CONFIG")` with node, target, and variable context before
publish/install/launch. Existing open legacy gates that predate the rule must
fail the preview/request-changes precondition visibly rather than silently
dropping feedback. The built-in AIF-flow matrix becomes an inventory regression
over the generic compiler rule, not the only protection.

### D5. Confidence compatibility

Remove `ConfidenceInput`, confidence state, and browser payload emission from
all human/form/review decision controls. Preserve the optional top-level
`confidence` transport, `hitl_requests.human_confidence`, external HITL route,
and historical documentation as API compatibility for non-UI callers. This
requires no migration and no Drizzle schema change.

### D6. Database and migration decision

One migration is required: the gate-chat coordinator needs durable state that
the current append-only transcript cannot safely infer while an ACP prompt is
in flight. Add `gate_chat_turns` with server-generated id, `run_id`,
`hitl_request_id`, `user_message_id`, `state` (`pending | completed | failed |
aborted`), `lease_expires_at`, terminal timestamp/reason, and timestamps. Add
a partial unique constraint/index permitting at most one unexpired `pending`
turn per HITL plus the lookup index used by response claim and packet loading.
The migration must be represented in Drizzle schema, SQL, journal, and snapshot
and documented in `docs/database-schema.md`.

`review_comments` continues to store anchors/status/reply graph,
`hitl_requests` continues to hold the canonical decision, and
`artifact_instances` continues to hold the runner’s `human_note` proof. There
is deliberately no packet table, response-column change, or migration for
confidence: packet digests remain derived request/evidence data. A different
durable feedback entity still requires an explicit SDD amendment before code.

### ADR reservation

`main` at planning time is `387d2e3d5`; its latest ADR is 136. Reserve
**ADR-137: Flow Review Workspace — complete working-tree review and verified
rework feedback delivery**. Phase 0 writes the ADR-137 header before linking
to it. Before implementation/rebase, recheck main; if another branch has used
137, renumber the ADR and all plan/docs links in one focused pass. Reserve the
next migration number only after Phase 0 rechecks the migration journal; it is
expected to follow `0099_agent_human_ask.sql`.

## Contract-surface checklist

| Surface | Change | Source of truth / documentation |
| --- | --- | --- |
| `GET /api/runs/{runId}/diff` | Add `review` enum and response source fingerprint; keep default `run`. | `docs/api/web.openapi.yaml`, `docs/system-analytics/workbench.md`, `docs/screens/runs/workbench.md` |
| `GET /api/runs/{runId}/change-summary` | Add the same `review` enum/source semantics so inspector links cannot disagree with the diff. | `docs/api/web.openapi.yaml`, `docs/screens/runs/run-inspector.md` |
| Review-comment collection | Add documented `scope=review`; root anchors/list placement use the same review source. | `docs/api/web.openapi.yaml`, `docs/system-analytics/review-comments.md` |
| `POST …/review-feedback-preview` | New read-only preview body, identifiers, response, errors, and no-side-effect guarantee. | `docs/api/web.openapi.yaml`, `docs/system-analytics/hitl.md`, ADR-137 |
| Session `POST …/respond` | Add opaque preview fingerprints only for a first rework claim; stale packet/source is refusal and canonical retries remain idempotent. | `docs/api/web.openapi.yaml`, `docs/system-analytics/hitl.md` |
| External `POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond` | Reject `schema.review === true` with `409 PRECONDITION`; retain all other existing eligibility. | `docs/api/external/operations.openapi.yaml`, `docs/system-analytics/hitl.md` |
| Gate-chat lifecycle | Persist and recover one active ACP chat turn so packet composition and response claim cannot race. | `web/lib/db/schema.ts`, migration SQL/journal/snapshot, `docs/database-schema.md`, `docs/system-analytics/hitl.md` |
| Flow graph / DSL | Static feedback-consumer invariant and exact renderer fields. | `docs/flow-dsl.md`, `web/lib/flows/flow-dsl-grammar.ts`, `web/lib/flows/authoring-skill.ts`, `docs/system-analytics/flow-graph.md` |
| Evidence | Existing `human_note` locator records actual packet digest and included thread ids. | `docs/system-analytics/review-comments.md`, `docs/system-analytics/flow-graph.md` |
| UI URL state | `wb=review` and `scope=review` open the workspace; invalid/non-review runs have a visible unavailable state, not a silent committed-only substitute. | `docs/screens/runs/workbench.md`, `docs/screens/runs/flow-run.md` |
| Human confidence UI | Remove control/client emission; retain external compatibility. | `docs/system-analytics/hitl.md`, `docs/screens/inbox.md` |

No SSE event, environment variable, config path, port, sidecar, deployment
file, or new `MaisterError` code is added. The gate-chat lifecycle migration is
the sole schema/deployment-state change. `docs/error-taxonomy.md`, Docker/
Compose, and `.env.example` remain unchanged; Phase 0 records this bounded
negative decision.

## Commit Plan

- **Commit 1** (Phase 0): `docs: specify verified flow review workspace`
- **Commit 2** (Phase 1): `feat(review): add complete current-review diff scope`
- **Commit 3** (Phase 2): `feat(review): coordinate chat and verify feedback delivery`
- **Commit 4** (Phase 3): `feat(review): unify code review workspace`
- **Commit 5** (Phases 4–5): `test(review): cover end-to-end review workflow`

## Tasks

### Phase 0 — SDD contract freeze and baseline (blocking)

- [x] **Task 1: Freeze ADR-137 and the review-domain specification before code.**
  - Files: `docs/decisions.md`, `docs/system-analytics/review-comments.md`,
    `docs/system-analytics/hitl.md`, `docs/system-analytics/workbench.md`,
    `docs/system-analytics/flow-graph.md`, `docs/flow-dsl.md`,
    `docs/screens/inbox.md`, `docs/screens/runs/flow-run.md`,
    `docs/screens/runs/workbench.md`, `docs/screens/runs/run-inspector.md`,
    `docs/api/web.openapi.yaml`, `docs/api/external/operations.openapi.yaml`,
    and `docs/database-schema.md`.
  - Write ADR-137 before any citation, covering the scope/source distinction,
    one decision location, preview→claim→runner/evidence sequence, stale
    fingerprint refusal, canonical-retry rule, gate-chat lifecycle, external
    review refusal, and the one bounded migration. Update the ADR index in the
    same edit.
  - Update each analytics artifact in its required order (Purpose, entities,
    state/process diagrams, Expectations, edge cases, linked artifacts). Add
    exact allow-lists/refusals and explicit `Implemented`/`Designed` tags;
    no section may imply code exists before its phase lands.
  - Specify the UX language and screen contract: Inbox triage, workspace
    columns, reviewed-source statement, review freshness, feedback preview,
    final delivery review distinction, read-only viewer state, mobile collapse,
    keyboard order, aria-live/error handling, and EN/RU parity.
  - **Acceptance criteria:** every changed HTTP surface has path, body,
    response, status/error mapping, identifier provenance, and example in
    OpenAPI; every changed process has a Mermaid flow; the docs distinguish the
    required gate-chat migration from the deliberately unchanged deployment and
    error-taxonomy surfaces.
  - **Logging:** no runtime logging change; document that preview/runner logs
    carry ids/counts/digests only and never payload text.

- [x] **Task 2: Establish executable acceptance matrix and test migration map.**
  - Files: this plan plus test files named in Tasks 3–13; no production change.
  - Inventory every existing fixture with `rework` under
    `web/test-fixtures/aif-flows/`, `web/lib/flows/**/_fixtures/`, and graph
    integration tests. Classify it as valid renderer/var, non-human rework, or
    invalid expected refusal; do not preserve an invalid fixture merely because
    it predates the invariant.
  - Record behaviour-to-test ownership: pure packet/digest → unit; route/DB
    locks and real git worktree diff → integration; browser navigation and
    single-form UX → Playwright. Avoid redundant shallow snapshots.
  - Confirm runner discovery before writing tests:
    `pnpm --dir web exec vitest list --project unit` includes `*.test.ts`,
    `pnpm --dir web exec vitest list --project integration` includes
    `*.integration.test.ts`, and `web/playwright.config.ts` matches the added
    `*.spec.ts`. Extend globs in the same task if any promise is not runnable.
  - **Acceptance criteria:** every existing assertion invalidated by the new
    scope/one-form behaviour is listed: `run-diff.test.ts`,
    `hitl-card.test.ts`, `run-hitl-response.test.ts`,
    `hitl-decision-controls.test.ts`, `review-comments.spec.ts`,
    `review-diff-scopes.spec.ts`, `m11a-review-rework.spec.ts`, external HITL
    respond integration tests, and gate-chat lifecycle integration tests.
  - **Logging:** none; test fixtures must assert that logs exclude comment and
    feedback text where a route/runner logger is observed.

#### Task 2 evidence: fixture inventory and test ownership

| Existing fixture or suite | Classification | Required migration / owning test |
| --- | --- | --- |
| `web/test-fixtures/aif-flows/bugfix/flow.yaml` | Human rework; `fix` is an `ai_coding` renderer. | Keep valid only with `review_comments` rendered in `fix.action.prompt`; compiler fixture test. |
| `web/test-fixtures/aif-flows/dev/flow.yaml` | Two human reworks: `plan_review → plan`, `review → fix`. | Keep valid only with `plan_review_comments` / `review_comments` respectively rendered; fixture inventory test. |
| `web/test-fixtures/aif-flows/evolve/flow.yaml` | Human rework; `review → evolve`. | Keep valid only with `review_comments` rendered in target prompt; compiler fixture test. |
| `web/lib/flows/__tests__/_fixtures/aif-flow/flow.yaml` | Human rework; `review → implement`. | Keep valid only with `review_comments` rendered; graph compile integration fixture. |
| `web/test-fixtures/aif-flows/roadmap/flow.yaml` | Human approve-only gate. | Non-rework control: compiler must not impose a feedback-consumer requirement. |
| `compile.test.ts`, `node-output.integration.test.ts`, and other inline graph fixtures with rework | Deliberate invariant cases. | Make fixtures either valid by rendering their variable or assert contextual `CONFIG`; do not leave accidental invalid fixtures green. |
| `runner-graph-*.integration.test.ts` `on_mismatch`/non-human loops | Non-human rework. | Control: consumer invariant applies only to human-review transitions. |

| Behaviour | Primary test layer | Concrete owner |
| --- | --- | --- |
| Deterministic packet order/digest, completed-chat filtering, no payload logging | Unit | `web/lib/review-comments/__tests__/feedback-packet.test.ts` |
| Real Git base→working-tree union, untracked intent-to-add, materialized rename/copy filter | Integration | `web/app/api/runs/__tests__/diff-scope.integration.test.ts` |
| Diff/change-summary/comment-source scopes and stale root anchoring | Route/unit | existing `diff/route.test.ts`, `change-summary/route.test.ts`, `run-diff-source.test.ts`, `review-comments/route.test.ts` |
| Preview/claim lock, fingerprint staleness, canonical retry, external refusal, chat lifecycle | DB integration | `hitl.integration.test.ts`, `gate-chat.integration.test.ts`, external HITL route integration |
| One decision surface, Inbox deep link, confidence removal, preview/rework path | Playwright | existing review-diff-scopes, review-comments, m11a-review-rework, and gate-chat specs |

Discovery is already wired by `web/vitest.workspace.ts`: unit includes
`lib/**`, `app/**`, `components/**`, and integration has matching
`*.integration.test.ts` globs. `web/playwright.config.ts` includes the existing
`review-comments`, `review-diff-scopes`, `m11a-review-rework`, and `gate-chat`
spec names in its authenticated project regexp. No glob change is required.
The attempted Vitest listing is temporarily blocked because this worktree has no
installed dependencies and registry DNS is unavailable; re-run discovery at each
phase checkpoint once the locked workspace dependencies are present.

**Phase 0 exit gate:** `pnpm validate:docs:all` and
`pnpm validate:contracts` are green; ADR anchors resolve; the spec contains no
contradiction between `review`, `run`, and `uncommitted`; all later tasks trace
to a numbered acceptance criterion.

### Phase 1 — Current-review source and safe comment anchoring

- [x] **Task 3 (RED): Prove the five diff-source cases before implementation.**
  - Files: `web/app/api/runs/[runId]/diff/__tests__/route.test.ts`,
    `web/app/api/runs/__tests__/diff-scope.integration.test.ts`,
    `web/app/api/runs/[runId]/change-summary/__tests__/route.test.ts`,
    `web/lib/review-comments/__tests__/run-diff-source.test.ts`,
    `web/app/api/runs/[runId]/review-comments/__tests__/route.test.ts`.
  - Add failing real-git coverage that creates one committed run change, one
    staged change, one unstaged change, and one untracked change. Assert
    `scope=review` returns their union; `run` remains committed range only;
    `uncommitted` remains HEAD→working tree only; `review` text and
    `nameStatus` use the same reviewable filter; scratch behaviour is unchanged.
    Add both directions of a rename/copy that crosses a materialized
    `.claude/*` path: a section is reviewable only when every old/new path is
    reviewable, and the file summary applies the identical rule.
  - Add failing checks for bad scope `400 CONFIG`, gone/removed workspace
    `409 PRECONDITION`, availability/source fingerprint response, review-scope
    root-anchor server extraction, and historic comments becoming `outdated`
    rather than failing the read.
  - **Acceptance criteria:** each test is integration where it needs actual
    git/index/untracked behaviour; no mocked test claims coverage of an
    `intent-to-add` worktree diff.
  - **Logging:** assert structured diff logs include `runId`, `scope`, base,
    file count/summary and never raw diff content.

- [x] **Task 4 (GREEN → refactor): Add `review` to diff and change-summary without changing the REST default.**
  - Files: `web/app/api/runs/[runId]/diff/route.ts`,
    `web/app/api/runs/[runId]/change-summary/route.ts`,
    `web/lib/runs/change-summary.ts`, `web/lib/runs/run-query-state.ts`,
    `web/lib/worktree.ts`, `web/lib/runs/reviewable-changes.ts`, and their
    focused tests from Task 3.
  - Implement a typed shared scope resolver rather than duplicate conditional
    git branches. `review` resolves the Flow workspace base exactly as `run`
    does, then calls `diffWorkingTree(worktreePath, base)`. It must preserve
    the real Git index, return untracked additions, filter text and status rows
    symmetrically, and derive an opaque source fingerprint from one canonical
    server-owned `ReviewSourceFingerprintInput` containing the resolved base,
    filtered diff bytes, filtered name-status entries, and `truncated` flag.
    Do not hash Shiki/React render bundles or rely on incidental JSON key order.
  - Keep `scope=run` as the omitted-query default and preserve all existing
    scratch response shapes. Add `review` to inspector/change-summary only
    where the same source semantics can be honored.
  - Refactor to one typed scope definition shared by route, change summary,
    client type, and availability DTO; do not use independent string unions.
    Extend the reviewable entry contract with optional `oldPath` and make both
    diff-section and name-status filtering inspect every endpoint of a
    rename/copy before it is exposed.
  - **Acceptance criteria:** all Task 3 RED cases pass; old four scopes retain
    their bytes/semantics; no workspace path, Git index path, or raw diff leaks
    in an error response.
  - **Logging:** `debug` at resolved source (runId/scope/base/fingerprint,
    counts only), `warn` for render degradation, `error` only for unexpected
    failure; no full source or path outside existing authorized DTOs.

- [x] **Task 5 (RED → GREEN → refactor): Make review comments use the canonical source and close the response race.**
  - Files: `web/lib/review-comments/run-diff-source.ts`,
    `web/lib/review-comments/service.ts`,
    `web/app/api/runs/[runId]/review-comments/route.ts`, and the focused
    review-comment route/service integration tests.
  - Extend the explicit review-comment scope union with `review`; preserve
    legacy `run`/`uncommitted` reads, but require Review Workspace mutations to
    pass `scope=review`. Root anchoring and placement must consume the same
    prepared source the viewport renders.
  - Change review-comment mutations to lock the live HITL row and require
    `response IS NULL` **and** `respondedAt IS NULL`. This shares the response
    claim serialization boundary and prevents post-preview packet mutation.
    Reads stay lock-free. Gate-chat coordination is intentionally deferred to
    Task 6 because its ACP side effect must never run under this row lock.
  - Test concurrent/reordered cases: a mutation before claim is included; a
    mutation that races after a claim refuses without write; resolved roots and
    their replies are excluded; reply/edit/status/delete preserve their
    existing authorization and root-only constraints.
  - **Acceptance criteria:** comment writes never alter `runs.status`, create
    no artifact, and do not introduce a deadlock; cross-run `parentId` remains
    server-state checked; direct legacy-scope history remains readable.
  - **Logging:** retain ids, action, status, and body length only; add no
    reviewer-content logging.

- [ ] **Task 6 (RED → GREEN → refactor): Add durable gate-chat turn coordination.**
  - Files: `web/lib/db/schema.ts`, the next numbered
    `web/lib/db/migrations/0100_*.sql`,
    `web/lib/db/migrations/meta/_journal.json`,
    `web/lib/db/migrations/meta/0100_snapshot.json`,
    `web/lib/services/gate-chat.ts`,
    `web/lib/services/hitl.ts`, `web/lib/flows/graph/runner-graph.ts`,
    `web/lib/services/__tests__/gate-chat.integration.test.ts`, and
    `web/lib/services/__tests__/hitl.integration.test.ts`.
  - RED first: add database-backed tests for exactly one pending turn, response
    refusal while its lease is live, successful finalization atomically writing
    the agent message plus `completed`, supervisor/persistence failure becoming
    `failed`, expiry/abandon recovery, and a late reply being discarded after
    the response or lease winner has closed the turn.
  - Add `gate_chat_turns` as specified in D6. Admission locks the HITL row,
    verifies that it is unclaimed and awaiting input, finalizes any expired
    pending turn, then persists the user message and `pending` turn in one
    short transaction. The ACP prompt executes outside a transaction. Its
    completion re-locks the HITL row and atomically writes the agent message
    with `completed`; a claimed/aborted turn never appends a late answer.
    Response claim refuses a live pending turn before it can freeze a packet.
  - Migrate packet loading so it includes only completed post-migration turns
    while preserving already-stored pre-migration transcript rows as immutable
    legacy history. The lease duration is an explicit server constant bounded
    by the supervisor prompt timeout and documented as a recovery policy.
  - **Acceptance criteria:** no database transaction remains open across an
    ACP/supervisor call; an interrupted turn cannot block a review forever or
    append content after a response claim; chat stays answer-only and never
    changes `runs.status`; migration upgrade is tested from the current schema.
  - **Logging:** lifecycle logs contain ids, state transition, lease outcome,
    counts, and error code only; message bodies never enter logs.

**Phase 1 exit gate:** focused unit/integration tests execute under their
declared projects, then `pnpm --dir web test:unit`,
`pnpm --dir web test:integration`, and `pnpm --dir web typecheck` are green.

### Phase 2 — Verified feedback delivery and Flow fail-closed invariant

- [ ] **Task 7 (RED): Define feedback packet parity, identifiers, and failure behaviour in tests.**
  - Files: new `web/lib/review-comments/__tests__/feedback-packet.test.ts`,
    new `web/app/api/runs/[runId]/hitl/[hitlRequestId]/review-feedback-preview/__tests__/route.integration.test.ts`,
    `web/lib/flows/graph/__tests__/review-comments-compose.integration.test.ts`,
    `web/lib/services/__tests__/hitl.integration.test.ts`.
  - Start with failing tests for exact deterministic packet/digest, summary +
    ordered open roots/replies + ordered **completed** chat turns, resolved
    exclusion, no-input
    passthrough, target/var derived from stored schema, and preview packet
    equal to target stdout plus the stored `human_note` proof.
  - Test the preview trust boundary: authenticate before lookup; URL run/HITL
    relation must match; body cannot forge node/target/path/thread ids; non-
    review, non-rework, closed gate, invalid decision, malformed body, or
    invalid legacy feedback configuration each returns its documented refusal
    with no mutation. Test stale source/packet fingerprints and no-summary/no-
    open-thread rework refusal before any artifact or resume. Add first-claim
    stale-token refusal, canonical same-response retry after a worktree change,
    different-response retry conflict, and `approve` without preview-token
    coverage.
  - **Acceptance criteria:** preview tests invoke the real packet service and
    use a database-backed gate; they never duplicate the serializer in test
    setup as an oracle.
  - **Logging:** assert all route/runner observations are identifiers, counts,
    lengths, and digest only.

- [ ] **Task 8 (GREEN → refactor): Implement the shared packet service, preview route, and atomic response check.**
  - Files: new `web/lib/review-comments/feedback-packet.ts`,
    `web/lib/review-comments/serialize.ts`,
    `web/lib/flows/graph/runner-graph.ts`,
    `web/lib/services/hitl.ts`,
    `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`, new
    `web/app/api/runs/[runId]/hitl/[hitlRequestId]/review-feedback-preview/route.ts`,
    `web/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`,
    `docs/api/external/operations.openapi.yaml`, and tests from Task 7.
  - Factor the runner’s DB loading/orchestration around the frozen pure
    serializer into a typed feedback-packet service. It loads the exact
    deciding HITL visit, open threads/replies, and completed gate-chat turns;
    derives target
    and `commentsVar` from server state; returns packet/source digests without
    mutating anything.
  - Implement the preview route as read-only. Identifier classification:
    `runId`/`hitlRequestId` = URL params, actor = auth context, project/gate/
    workspace/graph/target/commentsVar/thread ids = server state,
    decision/summary/workspace policy = body-controlled and validated against
    the stored allow-list. It must never accept filesystem components.
  - Extend the session-auth response body only with opaque fingerprints and
    enforce a strict review-rework transport schema: identifiers, target,
    template variable, path, thread id, and unknown transport fields are
    refused. Specify one bounded summary limit and apply it identically in
    preview and response validation. On a fresh rework claim, validate the
    response, lock the HITL row, reject a live pending chat turn, recompute the
    canonical source/packet, compare fingerprints, enforce nonempty feedback,
    then follow the existing claim → artifact → `respondedAt` → runner-wake
    order. Mismatch is retryable `409 PRECONDITION` with the row unclaimed.
    Once a canonical response is stored, compare it before any live recompute;
    a same canonical response is idempotent even if the worktree changed, and a
    different response is `409 CONFLICT`. `approve` has no preview requirement.
  - Before calling `respondToHitl`, make the external v1 route load the stored
    schema and reject any review gate with documented `409 PRECONDITION`.
    Preserve existing external human/form/permission paths and their scope/audit
    semantics; do not silently strip a preflight token and route around the
    session-auth guard.
  - Have the runner consume the same packet service and record digest plus
    included thread ids in the existing `human_note` locator. A proof-write
    failure keeps the existing best-effort evidence policy and must not change
    rework delivery semantics.
  - **Acceptance criteria:** preview and actual delivery are byte-equal for a
    stable gate; a refresh after changes is mandatory; all failure paths leave
    the request retryable when existing semantics require it; the only database
    changes are the reviewed Task 6 gate-chat migration and its artifacts.
  - **Logging:** preview `debug` and delivery `info` include run/HITL/node,
    target, counts, digest, and result; rejection is `warn`; no payload,
    summary, comment body, or chat body is logged.

- [ ] **Task 9 (RED → GREEN → refactor): Enforce feedback consumption for every human rework Flow.**
  - Files: `web/lib/flows/graph/compile.ts`, `web/lib/config.ts`,
    `web/lib/config.schema.ts` only if needed for top-level key grammar,
    `web/lib/flows/flow-dsl-grammar.ts`, `web/lib/flows/authoring-skill.ts`,
    `web/lib/flows/graph/__tests__/compile*.test.ts`,
    `web/lib/flows/graph/__tests__/rework-comments.test.ts`, relevant config
    load tests, and affected `flow.yaml` fixtures.
  - Add failing generic compiler/load cases for a missing effective var, bad
    key, rendererless target, unused var, wrong rendered field, valid prompt,
    valid CLI command, `??` fallback use, and all shipped AIF-flow wiring.
  - Implement one pure validator called by every manifest compile/load path.
    It applies only to human-review decisions that transition into declared
    rework targets; non-human retry/rework retains existing semantics. It must
    name node, target, and variable in `MaisterError("CONFIG")` and reject
    before an agent process starts.
  - Update the DSL grammar and authoring skill in the same patch so agent
    authored manifests cannot learn the old, silently ineffective pattern.
  - **Acceptance criteria:** an invalid authored/package manifest is refused
    consistently at validation, publish/install, and launch; valid legacy
    shipped flows pass without changing their intended prompt content; runtime
    remains defense in depth for an already-open legacy gate.
  - **Logging:** configuration refusal logs the Flow/node/target/variable and
    error code only; never log full templates or feedback content.

**Phase 2 exit gate:** focused chat-lifecycle/packet/route/graph tests are green and listed
by Vitest, followed by complete `pnpm --dir web test:unit`,
`pnpm --dir web test:integration`, `pnpm --dir web typecheck`, and
`pnpm validate:contracts`.

### Phase 3 — One human-facing Review Workspace

- [ ] **Task 10 (RED → GREEN → refactor): Teach the reusable diff UI about the review scope and workspace composition.**
  - Files: `web/components/workbench/run-diff.tsx`,
    `web/components/workbench/diff-view.tsx`, new
    `web/components/runs/review-workspace.tsx`, new corresponding component
    tests, and `web/components/workbench/__tests__/run-diff.test.ts`.
  - Add failing component tests that `scope=review` is selectable/labelled
    **Current review**, enables comment fetch/mutation with `?scope=review`,
    preserves file/deep-link selection, and never treats the review source as
    `uncommitted`. Migrate snapshots/assertions that enumerate four scopes.
  - Create a gate-only `ReviewWorkspace` composed from the existing diff,
    comment threads, review summary, source statement, feedback-preview
    dialog/rail, and one decision component. It owns preview-before-rework,
    busy state, stale/fresh refresh state, and an evidence link after resume;
    it does not duplicate the final promotion panel.
  - Preserve Files-pane `readRepoFiles` policy: untracked code is reviewable in
    Diff under `readBoard`, but it never silently appears in Files. Render
    empty/binary/truncated/outdated/read-only states explicitly; line comments
    are unavailable only where the prepared source cannot anchor them.
  - **Acceptance criteria:** the workspace has semantic Diff and Decision
    regions/headings, an accessible file-rail → diff → decision keyboard order,
    labelled textarea, aria-live loading/refresh/error/preview notices, and
    count/status text not conveyed only by color. Preserve drafts while moving
    between file, preview, and decision controls.
  - **Logging:** client logs nothing; all errors use localized server code
    mapping and the standard route diagnostics from Phase 2.

- [ ] **Task 11 (RED → GREEN → refactor): Make run and Inbox navigation lead to exactly one review surface.**
  - Files: `web/app/(app)/runs/[runId]/layout.tsx`,
    `web/components/workbench/workbench-panel.tsx`,
    `web/components/workbench/workbench-tabs.tsx`,
    `web/lib/runs/run-query-state.ts`, `web/components/inbox/hitl-card.tsx`,
    `web/lib/queries/inbox-context.ts` if review-only summary metadata is
    needed, `web/components/inbox/__tests__/hitl-card.test.ts`, run-page tests,
    and `web/messages/en.json`, `web/messages/ru.json`.
  - Add `wb=review` as the canonical deep link and use
    `?wb=review&scope=review` from a review gate Inbox card. Validate it only
    for a pending human-review gate; an invalid/non-review link shows a clear
    unavailable state rather than rendering the committed `run` diff as a
    false substitute. Add `review` deliberately to both currently independent
    tab unions (`RunWorkbenchTab` and `WorkbenchTab`), their labels, and
    `WorkbenchPanel`; no query parser is allowed to silently fall back to
    `timeline` for this recognised-but-unavailable review link.
  - Replace the pending review branch in the run layout with `ReviewWorkspace`.
    Do not mount generic `RunHitlResponse` for that same HITL, and ensure the
    ordinary Workbench does not render a competing editable review form.
    Keep gate chat as a secondary, contextual section/drawer.
  - Change Inbox review cards from inline **Respond** to code-change signal +
    **Review code** CTA; keep assignment actions and every non-review HITL
    behaviour intact. Do not calculate full diff bodies in the cross-project
    list; lazy summary is bounded and authorization-preserving.
  - Add EN/RU copy for source inclusion, stale/refresh, preview, packet
    delivery/proof, no-feedback validation, and unavailable legacy Flow. Remove
    stale "reviewing committed state" wording that contradicts Current review.
  - **Acceptance criteria:** Inbox → CTA → Workspace exposes the complete diff
    and only one decision form; a viewer sees read-only code and a role reason;
    a member can comment and decide; direct normal forms/permissions still
    respond inline; final `ReviewPanel` keeps promotion semantics.
  - **Logging:** no client content logs; server-side query failures stay
    structured/redacted.

- [ ] **Task 12 (RED → GREEN → refactor): Remove human confidence input without breaking supported callers.**
  - Files: `web/components/board/run-hitl-response.tsx`,
    `web/components/board/hitl-decision-controls.tsx`, their tests, and EN/RU
    message keys only when no longer referenced.
  - Start with tests proving all browser human/form/review submissions omit
    `confidence`, no confidence field is rendered, and server/API callers that
    do send a valid optional confidence still receive the existing behaviour.
  - Remove control, local state, and client payload wiring; retain route Zod,
    service validation/persistence, external endpoint, OpenAPI compatibility
    description, DB column, and migration history unchanged.
  - **Acceptance criteria:** no interactive human UI asks for confidence;
    malformed/valid legacy transport tests retain their current status/error
    semantics; this task makes no confidence schema/journal change beyond the
    independently required Task 6 gate-chat migration.
  - **Logging:** no new logs; existing confidence server logs remain
    identifiers/value policy only and never user text.

**Phase 3 exit gate:** all changed unit tests run under `unit`; the full
`pnpm --dir web test:unit`, `pnpm --dir web test:integration`, and
`pnpm --dir web typecheck` are green. EN/RU key parity is checked by build/type
validation before this phase can close.

### Phase 4 — End-to-end proof and as-built specification reconciliation

- [ ] **Task 13 (RED → GREEN → refactor): Exercise the reviewer journey through the real browser and runner.**
  - Files: `web/e2e/_seed/seed-e2e.ts`, `web/e2e/inbox.spec.ts`,
    `web/e2e/review-comments.spec.ts`, `web/e2e/review-diff-scopes.spec.ts`,
    `web/e2e/m11a-review-rework.spec.ts`, and the Playwright config only if a
    new filename requires its intentional allow-list.
  - Seed a parked review gate whose worktree contains committed, staged,
    unstaged, and untracked files. RED flow: Inbox review CTA opens the
    workspace; source statement and all four file classes are visible; create
    an inline comment; preview shows target/var, summary, only open threads,
    and digest; request changes; runner evidence/target receives that exact
    packet. The flow must fail before implementation because today the form and
    diff are separated.
  - Cover minimal non-overlapping edge cases: resolved root excluded; empty
    summary plus no open root refuses; stale source/packet requires refresh;
    ordinary form/permission Inbox items still answer inline; unavailable
    legacy feedback contract blocks rework visibly; final delivery review is
    not relabelled as a rework workspace.
  - **Acceptance criteria:** each spec uses a unique seeded project/run under
    parallel execution, passes through the configured Playwright matcher, and
    validates observed user outcomes rather than implementation CSS classes
    alone.
  - **Logging:** E2E captures request status/digest metadata for diagnosis but
    redacts review text in failure output.

- [ ] **Task 14: Reconcile every SDD artifact against the implemented code and release contract.**
  - Files: all Phase 0 documentation plus `docs/api/web.openapi.yaml`,
    `docs/api/external/operations.openapi.yaml`, `docs/database-schema.md`,
    and any changed Flow grammar/authoring references.
  - Re-read the finished handlers, shared packet service, compiler, runner,
    route tests, and screen components. Update Phase-0 `Designed` labels to
    `Implemented` only where the final code and green test demonstrate the
    stated contract. Do not describe aspirational multi-reviewer/PR features
    as shipped.
  - Reconcile precise details often missed in as-built docs: scope default
    remains `run`; `review` includes worktree union; comments use selected
    source; preview has no side effects; fingerprints refuse stale inputs;
    locks stop post-claim mutation; response/evidence order; external review
    refusal; no confidence UI but compatible API; and the bounded gate-chat
    migration/lease recovery policy.
  - **Acceptance criteria:** Mermaid/ADR anchors/OpenAPI examples validate;
    every affected external contract appears in the checklist; docs do not
    contradict actual status codes, authorization, identifier sources, or
    runner evidence.
  - **Logging:** document, rather than add, the redaction/count/digest policy.

**Phase 4 exit gate:** `pnpm --dir web test:e2e` is green, followed by
`pnpm validate:docs:all`, `pnpm validate:contracts`, full unit/integration,
and `pnpm --dir web typecheck`.

### Phase 5 — Completeness, consistency, and merge-readiness review

- [ ] **Task 15: Perform adversarial completeness review and final verification.**
  - Inspect the final diff against this plan’s scope/non-goals, the contract
    surface checklist, generated migration state, route identifier table, and
    all acceptance criteria. Grep every new `review` enum member and every
    `reviewFeedbackFingerprint` consumer to prove no read model, OpenAPI enum,
    UI union, comment source, or test fixture was skipped.
  - Specifically refute: default API accidentally changed; `uncommitted`
    semantics changed; packet preview differs from runner; comment/chat can
    change after response claim; a pending/expired chat turn cannot deadlock
    review; a Flow target ignores feedback; the external route can bypass the
    preview; confidence was removed from supported API; final promotion review
    was conflated with human rework; or a DB migration/schema/journal file
    outside the explicit Task 6 lifecycle migration was added.
  - Run: `git diff --check`; `pnpm --dir web exec vitest list --project unit`;
    `pnpm --dir web exec vitest list --project integration`;
    `pnpm --dir web test:unit`; `pnpm --dir web test:integration`;
    `pnpm --dir web typecheck`; targeted ESLint on changed web files;
    `pnpm --dir web test:e2e`; `pnpm validate:docs:all`; and
    `pnpm validate:contracts`.
  - **Acceptance criteria:** all requested tests are discovered and green; no
    stale red tests are tolerated (quarantine requires a separately documented
    cause and follow-up); no unrelated file change or deployment/migration
    change remains; the Task 6 migration and generated artifacts exactly match
    the ADR/schema/docs; every Phase exit gate has evidence.
  - **Logging:** verify production logs remain structured/redacted and neither
    tests nor docs normalize logging feedback bodies.

## Final acceptance checklist

- [ ] Inbox never offers a blind inline decision for a Flow review gate; it
  opens code review with a useful bounded change signal.
- [ ] A Flow review workspace defaults to `base → working tree`, displaying
  committed + staged + unstaged + untracked changes and inline comments on the
  same source.
- [ ] The current review has one editable decision rail and one submit path.
- [ ] Request changes has a server-derived preview, target/variable provenance,
  open/resolved accounting, freshness checks, and a durable actual-delivery
  evidence record; a same-payload retry stays idempotent and a stale first
  claim never writes an artifact.
- [ ] An invalid Flow feedback channel fails before it can silently drop human
  review feedback; old live invalid gates fail visibly and safely.
- [ ] External v1 HITL cannot issue a blind decision for a `schema.review`
  gate; all other documented external HITL eligibility remains compatible.
- [ ] Gate chat has one durable active-turn lifecycle: no ACP call holds a DB
  transaction, incomplete turns recover by lease policy, and only completed
  turns enter the feedback packet.
- [ ] No human-facing confidence input remains; public compatibility and
  historical `human_confidence` data are retained.
- [ ] Exactly one reviewed gate-chat lifecycle migration and its schema,
  journal, snapshot, and database documentation change exist; no packet table,
  confidence migration, deployment change, or new error code is introduced.
- [ ] Documentation, OpenAPI, analytics, screens, grammar/authoring guidance,
  tests, i18n, and code all express the same source and delivery contract.
