# HITL domain

## Purpose

**HITL** — human-in-the-loop — covers every transition where a run
needs an operator decision before it can continue. HITL is not a
sidecar feature; it is a first-class state of a run. The domain spans
three kinds of human ask, the lifecycle that surrounds them, and the
artifact protocol used when the worker is checkpointed.

## Domain entities

- **HITL request** — `hitl_requests` row. FK to `runs`.
- **Kind** — `'permission' | 'form' | 'human'`:
  - `permission` — binary approve/deny via ACP
    `session/request_permission`.
  - `form` — structured form, schema declared in the Flow's
    `human` step `form_schema`.
  - `human` — full human-review step with an `on_reject.goto_step`
    loopback.
- **Form schema** — JSON Schema-like object with required
  `schemaVersion: integer`. Field types: `string | number | boolean |
enum | array` on POC.
- **`needs-input.json`** — artifact written by the agent at
  `.maister/<slug>/runs/<runId>/needs-input.json` when raising a
  structured-form request from a checkpointable boundary.
- **`input-<stepId>.json`** — atomic-written response payload.

## Three kinds — when to use which

| Kind | Trigger | Form? | Loop on reject? | Wire |
| ---- | ------- | ----- | --------------- | ---- |
| `permission` | Agent emits `session/request_permission` mid-step | No (binary) | No | Live ACP request/response |
| `form` | Agent writes `needs-input.json` mid-step | Yes (`form_schema`) | No | Artifact + ACP message OR resume |
| `human` | Flow step `type: human` | Yes (`form_schema`) | Yes (`on_reject.goto_step`) | Artifact only |

The decision tree:

```mermaid
flowchart TD
    Step{Flow step type?} -- agent --> AgentRun[agent runs]
    Step -- human --> HumanStep[human step]
    AgentRun --> Ask{Agent needs input?}
    Ask -- binary tool/file permission --> Perm[kind=permission<br/>via session/request_permission]
    Ask -- structured data --> Form[kind=form<br/>write needs-input.json]
    HumanStep --> Review[kind=human<br/>write needs-input.json with on_reject]
```

## State machine — HITL request

```mermaid
stateDiagram-v2
    [*] --> Open: agent emits request<br/>or writes needs-input.json
    Open --> Open: web activity bumps<br/>keepalive_until
    Open --> Responded: operator submits<br/>atomicWriteJson input-{step}.json
    Open --> Expired: 24h elapsed<br/>(run -> Abandoned)
    Responded --> [*]
    Expired --> [*]
```

## Process flows

### Live path — permission request (Designed M7)

```mermaid
sequenceDiagram
    participant A as Adapter
    participant SV as Supervisor
    participant W as Web tier
    participant DB as Postgres
    actor U as Operator

    A-->>SV: jsonrpc session/request_permission
    SV-->>W: SSE session.line (parsed in M7)
    W->>DB: INSERT hitl_requests { kind=permission, prompt, ... }
    W->>DB: UPDATE runs SET status=NeedsInput, keepalive_until=now+30min
    W-->>U: UI renders approve/deny prompt
    U->>W: POST /api/runs/[id]/hitl-response { granted: true/false, comment? }
    W->>SV: POST /sessions/[id]/input (M7)
    SV->>A: jsonrpc response { result: { granted } }
    A-->>SV: continues
    W->>DB: UPDATE hitl_requests SET response, responded_at
    W->>DB: UPDATE runs SET status=Running
```

### Recovery path — structured form after checkpoint (Designed M8)

```mermaid
sequenceDiagram
    participant A as Adapter
    participant SV as Supervisor
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres
    actor U as Operator

    Note over A: Earlier — agent wrote needs-input.json,<br/>run was checkpointed (NeedsInputIdle).
    U->>W: Submit form response on run page
    W->>FS: atomicWriteJson input-{stepId}.json
    W->>DB: INSERT hitl_requests.response, responded_at
    W->>SV: POST /sessions { resumeSessionId: acp_session_id, ... }
    SV->>A: spawn --resume {id}
    A->>FS: read input-{stepId}.json
    A-->>SV: session.line resumed
    SV-->>W: SSE session.line
    W->>DB: UPDATE runs SET status=Running, keepalive_until=null
```

### Human-review send-back loop (Designed M7)

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Web tier
    participant FS as Filesystem
    participant DB as Postgres
    participant A as Adapter (re-spawned at goto_step)

    Note over W: Flow reached a step type=human with on_reject.goto_step=plan
    W->>FS: render form_schema in UI
    U->>W: Reject with comments
    W->>FS: atomicWriteJson input-{stepId}.json { rejected: true, comments: "..." }
    W->>DB: hitl_requests.response, on_reject_goto=plan
    W->>SV: POST /sessions ({ stepId: plan, prompt with comments_var injected })
    SV->>A: spawn fresh adapter at the earlier step
    Note over A: Flow loops back to "plan" step with the human comments<br/>available as the configured comments_var (e.g. {{review_comments}})
```

## Keep-alive activity tracking (Designed M8)

The flow below describes the M8 target state. M5 does not implement
any of it: `runs.keepalive_until` ships unused, no
`POST /api/runs/[id]/activity` route exists, supervisor
`POST /sessions/:id/checkpoint` still returns the deferred stub, and
no `NeedsInput → NeedsInputIdle` transition fires today. The diagram
is kept as the design contract M8 builds against.

While a run is in `NeedsInput`, the run-detail page is responsible for
keeping the worker alive:

```mermaid
flowchart TD
    Open["Open run page"] --> Send["POST /api/runs/[id]/activity"]
    Send --> DB["UPDATE keepalive_until = now + 30min"]
    Focus["Window focus"] --> Send
    Type["Form field change"] --> Send
    Idle["Idle > 30min OR tab closed"] --> Tick["scheduled tick:<br/>now > keepalive_until"]
    Tick --> Checkpoint["supervisor checkpoint<br/>run -> NeedsInputIdle"]
```

## Form schema versioning

Every form payload includes a required `schemaVersion: integer`.
`validateFormSchemaVersion(payload, expected)` throws
`MaisterError("CONFIG")` on mismatch with both versions named.

```yaml
schemaVersion: 1
fields:
  - name: comment
    label: Reviewer comment
    type: string
    required: true
  - name: severity
    type: enum
    options: [low, medium, high]
  - name: confirm
    type: boolean
    default: false
```

## Expectations

- HITL kind is exactly `permission | form | human`; mapping to wire
  matches the three-kinds table verbatim.
- Every HITL request is persisted as a `hitl_requests` row before the
  run transitions to `NeedsInput`; UI never derives HITL state from
  supervisor in-memory state.
- **(Designed M8)** A run in `NeedsInput` extends `keepalive_until` by
  `MAISTER_KEEPALIVE_MINUTES` (default 30) on every operator activity
  event (page open, focus, form change). M5 has neither the
  `POST /api/runs/[id]/activity` route nor a writer for
  `runs.keepalive_until`; the column ships unused.
- **(Designed M8)** Idle past `keepalive_until` triggers checkpoint →
  run becomes `NeedsInputIdle` with `acp_session_id` retained. M5
  supervisor `POST /sessions/:id/checkpoint` still returns the M8
  deferred stub, so `NeedsInputIdle` is never reached today.
- **(Designed M8)** 24 h elapsed in `NeedsInputIdle` without response
  → `HITL_TIMEOUT`, run `Abandoned`, task → `Backlog`. Depends on the
  checkpoint path above; no timeout watcher exists in M5.
- Every form payload includes `schemaVersion: integer`; mismatch with
  the Flow's declared version raises `CONFIG` with both versions
  named.
- Form-schema field types on POC are exactly `string | number |
  boolean | enum | array`; unknown type refused with `CONFIG` at Flow
  load.
- **(Implemented M7)** Operator responses go through
  `POST /api/runs/[runId]/hitl/[hitlRequestId]/respond`. Permission
  responses are routed through the supervisor's
  `POST /sessions/:id/input` (permission-only, discriminated `action:
  "select" | "cancel"`). Form / `human` responses are written via
  `atomicWriteJson` (tmp + rename) to
  `.maister/<slug>/runs/<runId>/input-<stepId>.json` by the web tier
  AFTER the row-level CAS claim succeeds — concurrent double-submits
  with conflicting payloads return 409 before any artifact is
  touched, and same-payload retries are idempotent. The supervisor
  never writes input artifacts.
- **(Implemented M7)** `human` step rejection without `on_reject`
  defined → run `Failed`; task returns to `Backlog` per the 1:N
  retry contract. **(Designed M8)** `on_reject.goto_step` resume
  routing in `runHumanStep`.
- **(Implemented M7)** `hitl_requests.response` and `.responded_at`
  use two-phase commit semantics:
  * **Phase 1 (atomic claim).** `response` is stored under a row-level
    `SELECT ... FOR UPDATE` only if the row is unclaimed, or claimed
    with the same payload (idempotent retry). Different payload on
    retry → 409.
  * **Phase 2 (durable side-effect).** For permission, the supervisor
    deferred is resolved; for form/human, `input-<stepId>.json` is
    written from the STORED response.
  * **Phase 3 (delivered marker).** `responded_at` is set ONLY after
    the side-effect succeeds. The route does NOT flip `runs.status`
    back to `Running` — the runner owns that transition on resume so
    its `isResume` gate can match.
  * Retry classification: supervisor 410 → `HITL_TIMEOUT` terminal
    (run → `Failed`); supervisor 503 / network → `EXECUTOR_UNAVAILABLE`
    retryable (row stays claimed, `responded_at` NULL); artifact
    write I/O failure → 503 retryable.
  * Same-payload retry on an already-delivered row re-queues
    `runFlow` so a process crash between Phase 3 commit and the
    original microtask cannot strand the run in `NeedsInput`.
- **(Designed M8)** HITL request lost during supervisor shutdown is
  recoverable via the standard `acp_session_id` resume on next launch —
  no separate reconciliation needed. Depends on M8 checkpoint/resume
  landing the `--resume <id>` re-spawn path.

## Edge cases

- **24h elapsed in `NeedsInputIdle`** → `HITL_TIMEOUT`. Run →
  `Abandoned`, task → `Backlog`.
- **Form payload `schemaVersion` mismatch** → `CONFIG`. Worker stays
  in `NeedsInput`; operator sees a validation error in the form.
- **Unsupported field type in `form_schema`** → `CONFIG` at Flow load
  time (`web/lib/config.ts`).
- **Operator submits twice in quick succession** — the response
  route's row-level CAS (`SELECT ... FOR UPDATE` + conditional
  UPDATE) ensures only one submission claims the deferred. A
  same-payload retry is idempotent (200 + re-queue resume); a
  different-payload retry is rejected with 409 BEFORE any artifact
  or supervisor side-effect runs.
- **Supervisor restart while the user response is in-flight** —
  supervisor returns 503 `EXECUTOR_UNAVAILABLE` for the
  "unknown session" case (distinct from 410 `HITL_TIMEOUT` for
  expired deferred). The web tier treats 503 as retryable: the
  `responded_at` marker stays NULL, the response column holds the
  user's intent, and a retry replays through the normal flow.
- **Agent reads a malformed `input-<stepId>.json`** — adapter exits
  non-zero → `Crashed`. Operator decides whether to Recover or
  Discard.
- **HITL on `human`-step rejected with no `on_reject` defined** →
  treated as `human_review` rejection but no loop-back; run goes to
  `Failed` (task returns to Backlog).
- **`session/request_permission` arrives while the supervisor is
  shutting down** — request lost; agent will retry on next launch
  through the standard `acp_session_id` resume.

## Linked artifacts

- ADRs: [ADR-006 Hybrid HITL](../decisions.md#adr-006-hybrid-hitl-keep-alive--checkpointresume),
  [ADR-008 Typed error taxonomy](../decisions.md#adr-008-typed-error-taxonomy-maistererror).
- ERD: [`../db/hitl-domain.md`](../db/hitl-domain.md).
- Config reference: [`../configuration.md`](../configuration.md)
  §`form_schema versioning`;
  §`Environment variables (server tier)` for
  `MAISTER_KEEPALIVE_MINUTES`.
- API (external, planned for M7): [`../api/external/acp.asyncapi.yaml`](../api/external/acp.asyncapi.yaml)
  §`session.request_permission`.
- Related: [`runs.md`](runs.md), [`flows.md`](flows.md).
- Source: `web/lib/config.ts` (`validateFormSchemaVersion`),
  `web/lib/atomic.ts` (`atomicWriteJson`),
  `web/lib/db/schema.ts` (hitl_requests table).
