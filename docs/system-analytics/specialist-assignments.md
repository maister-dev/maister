# Durable specialist assignments

## Purpose

**Implemented: persistence, input/state services and native company execution; Designed: complete invocation routing and verified assignment completion — ADR-203.** A specialist assignment preserves requested work, responsibility, input and outcome across runs. It is distinct from [human work assignments](assignments.md), execution-host placement, private memory and long-term [Company Brain](company-brain.md).

## Domain entities

The base store supports company-only assignments without a repository or run,
current user authority, pinned standing definitions, immutable input inspection
and append, exact business CAS, existing-run links, cancellation and reopening.
Current source access also gates historical input bytes; a content-free cancel
receipt requires cancellation authority without redisclosing inaccessible input.
Input append preserves standing instructions, recurring request and result
requirements, and refuses overflow rather than truncating. Recurring snapshots
must identify the exact scheduled origin. Linking a successful run never
completes its assignment. New company execution admission, intake receipt
deduplication, context/HITL cooperation, owner fencing and verified acceptance
remain in their owning slices; their public routes are still designed.

- Specialist assignment: objective, expected outcome, requester, responsible specialist/coordinator, company/project owner, targets, references, constraints, result/verification requirements and origin/destination.
- Input/authority revision: immutable standing-definition, recurring-request, current assignment input, retrieved references and historical grants in separate fields.
- Intake receipt: trusted source delivery identity and canonical payload digest mapped to a disposition/assignment.
- Working context revision: objective/constraints, sources, hypotheses/findings, questions, decisions/authors, accepted work and blockers.
- Question: exact assignment/input/owner/turn and existing HITL/human assignment reference.
- Acceptance: actor, expected input/context, exact result revision, required verification receipts and decision.
- Delivery receipt: server-bound destination and idempotent outbox intent. See [ERD](../db/specialist-assignments-domain.md).

## State machine

Assignment transitions are business state, not additional `runs.status` values.

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> active: existing run admitted
    queued --> waiting_input: durable pre-admission question
    active --> waiting_input: durable question
    active --> waiting_children: governed child work
    active --> waiting_resource: conflicting resource claim
    active --> reconciling: uncertain external effect
    active --> awaiting_acceptance: expected result available
    waiting_input --> queued: answer appended and continuation requested
    waiting_children --> queued: child settled wakes coordinator
    waiting_resource --> queued: evidenced release
    reconciling --> queued: evidence or authorized successor ready
    awaiting_acceptance --> completed: exact result and obligations accepted
    awaiting_acceptance --> queued: bounded rework
    active --> failed: stopped execution and unrecoverable refusal
    queued --> cancelled: authorized cancel
    active --> cancelled: stopped agent and retained effects
    failed --> queued: explicit authorized recovery revision
    cancelled --> queued: explicit authorized recovery revision
```

## Process flows

Every existing intake entry resolves meaning before reserving work.

```mermaid
sequenceDiagram
    actor U as Requester or source
    participant I as Existing intake adapter
    participant DB as PostgreSQL
    participant C as Coordinator
    participant O as Existing outbox
    U->>I: source delivery, request and trusted correlation
    I->>DB: lock receipt key, compare canonical digest
    alt Exact repeated delivery
        DB-->>I: original safe disposition/receipt
    else New or correlated input
        I->>DB: assignment or input revision plus receipt atomically
        I->>C: existing cap-governed run/continuation
        C->>DB: context and exact accepted result/evidence
        DB->>O: transactionally committed delivery intent
        O-->>U: current-access-filtered result in frozen origin
    end
```

### Input/transition contract

The assignment read model exposes a positive business `revision`. Assignment
state/input mutations compare the caller's `expectedRevision` against it in the
same transaction. It is separate from `inputRevision` (frozen inputs) and
`contextRevision` (working context). Context patches compare their
`expectedRevision` against the context revision, work decisions against the work
revision, and answers against the question revision. Each accepted change to the
assignment advances its business revision under the stable parent lock. A client
reads the exact subject revision rather than substituting another counter.

Assignment reads also return the exact specialist binding, current input
references and constraints, and server-recorded origin and frozen destination.
Origin variants carry the identity of the actual manual interaction, task
comment, scheduled trigger, event subscription, webhook delivery or delegated
work. Destination variants identify a user Inbox, task thread or configured
outbound subscription; they never contain a caller-supplied endpoint URL.
An accepted result is an exact `{id, revision}` reference, not a floating result
identity. Its assignment/run membership and verification obligations are
validated before acceptance. Historical input/authority revision contents remain
separate immutable snapshots; the current read projection must not replace them.
The assignment's expected result exposes the server-selected schema reference,
version and digest with `required: true`. Launch must match that descriptor using
the existing `RunResultContract` builder and immutable binding. This is a business
requirement pointing to the existing result contract, not another output grammar.

All assignments require nonblank objective (<=8000 characters), expected outcome (<=4000), explicit requester/responsible principal, owner, <=32 canonical targets, <=64 input/knowledge refs, <=16 typed verification obligations and one server-validated origin/destination. Pure research may declare zero operation obligations; configured restart policy always injects required effect and independent-health obligations. A model cannot clear them. Context <=128 KiB, update <=32 KiB/64 entries, per-entry text <=8000; no silent truncation.

| Incoming meaning | Correlation/admission | Durable result |
| --- | --- | --- |
| Duplicate delivery | Owner/source/stable delivery ID and same canonical digest | Return original safe receipt; no run, input, alert or operation repeated |
| Same ID/different body | Existing key with changed canonical payload | `CONFLICT` before dependent writes |
| Clarification/update | Trusted assignment/question/work/thread reference plus current grant and expected revision | Append input/context revision; preserve attempts and previous evidence |
| Independent request | New delivery/logical request, even if role is busy | Separate queued assignment under existing capacity |
| Missing/ambiguous input | Durable assignment/receipt, no guessed target/correlation | Existing human question; wait with exact owner/input revision |
| Conflicting mutation | Canonical resource claim conflicts | Wait or actionable conflict, never simultaneous mutation |
| Unknown external outcome | Existing operation identity/receipt uncertain | Reconcile before any original mutation retry |

| Transition group | Allowed source and current authority | Commit and wake |
| --- | --- | --- |
| Admit | queued, active company/project binding and expected input | Existing run reservation/claim linked atomically; active only after actual admission |
| Park for input/children/resource/reconcile | active with current coordinator epoch | Persist question/work/blocker/operation pointer and state/CAS/outbox together; release slot only by owning run contract |
| Continue parked work | corresponding wait state, expected input and evidence/reply, current authority | Append input or accepted evidence; queue existing governed continuation; cap-gated activation |
| Result ready | active or reconciling after coordinator evaluation | Exact valid result revision and obligation set; awaiting_acceptance, never completed automatically |
| Accept | awaiting_acceptance, responsible/current acceptance authority, exact input/context/result and satisfied policy obligations | Acceptance/state/completion timestamp/delivery outbox in one transaction |
| Request rework | awaiting_acceptance or settled work item, current responsible actor, remaining budget | New work/input revision; old result immutable; governed continuation |
| Cancel | Any non-completed state, current cancel authority, expected revision; stop owned agents first | Record cancelled with reason, close owned waits/claims/outbox; preserve confirmed/unknown effects for independent reconciliation |
| Fail | Nonterminal state, stopped execution and classified unrecoverable error | Preserve diagnostic/effect history; failed reason/time, never infer not-applied |
| Explicit reopen | failed/cancelled only, current recovery authority and fresh recovery/input revision | New owner epoch; preserve original terminal event; outstanding unknown effect routes to reconciling, not dispatch |
| Completed replay | completed and exact original request/decision | Safe existing receipt only; independent new objective is new assignment |

Business transitions append the existing transactional `specialist.assignment_changed`
outbox fact with business revision, previous/current state, safe cause and server
actor in the same transaction as the assignment head. Reopening cannot erase a
prior failed/cancelled fact. Facts contain no objective, input, source excerpt or
free-text terminal reason and are not agent triggers. Input/context/result
contents remain in their current-access-controlled owning stores; this is not an
additional execution or attempt ledger.

### Canonical intake receipt boundary

The intake service receives a validated request containing owner, specialist binding,
objective, expected outcome, literal input, targets, references, constraints and
verification requirements. The authenticated source adapter supplies the canonical
origin; no caller-supplied origin, requester, standing definition, permissions or
content digest enters the public create contract. Manual input defaults to an
explicit empty string when omitted. Provider pins, expected result schema and
historical authority are prepared by the server and frozen separately.

One immutable `specialist_intake_receipts` row binds the source kind/key, original
request digest, server actor and exact assignment/input revision. The key hashes
the owner and canonical origin; manual interactions additionally include the
current user identity. Task-comment delivery additionally includes the addressed
specialist binding, allowing one comment to request independent work from
multiple specialists. Other adapters retain their existing canonical delivery,
trigger, event/subscription or parent/work identities. Payload hashing
uses the original normalized request, excluding mutable standing/authority data.
The transaction serializes the key before lookup. Concurrent identical requests
produce one assignment; changed payload conflicts without dependent writes.
Replay checks current assignment/source and submission authority and returns the
original input receipt without resolving a changed or disabled provider again.

Adapters prepare new work only after the receipt lookup and persist any Run
reservation in the same outer transaction. There is no external mutation inside
that transaction and no additional execution scheduler or attempt ledger. Receipt
storage and manual admission are qualified independently of actual scheduled,
event and webhook dispatch (T22.1), clarification continuation (T24) and native
agent delegation (T27). A matching source identity alone never authorizes an
adapter to act as another principal.

### Company manual reservation

The server accepts the original bounded request and manual idempotency key. It
derives the interaction identity and requester from the authenticated user,
resolves the exact current owned specialist binding and its declared coordinator,
and builds the expected result from the actual pinned provider. Caller-supplied
actors, grants, result schemas, package pins and origin/destination are refused.
New reservations require current company read, submit and update authority;
exact duplicate inspection requires current read/submit and source access and
performs no new reservation. A changed/disabled provider is not re-resolved for
duplicate work.

Receipt creation, the assignment/input and the existing agent or Flow reservation
share one outer database transaction, reusing the existing launchers' transaction
helpers. Host/event-consumer activation uses a stable pooled database before that
transaction; a background consumer must never retain a transaction handle after
commit. Exact replay is inspected before any host/provider preflight. Reconnect
diagnostics retain sanitized error type, SQLSTATE and constraint, without query
parameters, raw database causes or input content. Failure rolls back Run/session/placement/link/state/receipt
data together. The returned assignment includes the actual retained Run links.
Business responsibility becomes active at reservation; the existing Run remains
Pending until its existing scheduler pool grants capacity. This does not grant
an execution slot or start an agent process inside the intake transaction.
Actual source/API adapters wake existing dispatch after commit and never repeat
reservation for an exact duplicate. Project repository admission remains its own
existing project boundary.

### Project manual admission

Project manual work resolves `specialistBindingId` through the current project
agent attachment, with current read/launch authority and the actual trusted
project package pin. The original receipt, assignment and input commit together
before the existing launcher performs repository/workspace admission. An unavailable
selected runner or refused repository admission leaves one queued assignment;
retrying the same request can admit that retained work after the precondition is
repaired. No fallback runner or fabricated project is selected.

Inside the existing Run transaction, the service locks the assignment revision,
rechecks current attachment/package/configuration/policy and compares its frozen
expected result. Run, session, placement and initial assignment link/state commit
atomically. Concurrent admission adopts the winner; the losing allocator follows
the launcher's existing owned-worktree cleanup. Original assignment input is a
separate prompt section and exact input inspection, alongside standing configuration,
recurring request and permissions. Current source policy shares only the exact
server-appointed input with the active role and initiating user; it grants no
general Brain read access or confirmation authority. Later input heads cannot
rewrite the retained prompt. Technical Done leaves business acceptance separate.

A declared project coordinator additionally retains standing snapshot v2 with the
exact project Flow ID/ref, installed revision ID, resolved revision and manifest
witness. Existing v1 snapshots remain byte-for-byte unchanged. The current trusted,
enabled provider and mandatory public-result contract are checked separately from
physical runner availability. A provider change refuses admission instead of
silently selecting a different graph.

The assignment retains its initial existing Task identity once. Task creation and
that link commit under the assignment lock; retries reuse it. Its shared title is
the role name and its stored prompt is only the role identity. The runtime overlays
the private original assignment input without copying it to the task board. The
existing Flow reservation transaction binds the exact task/provider/input, source
role/configuration and result contract, then links and activates the assignment.
A duplicate arriving between task retention and Run reservation can observe the
same queued assignment; it cannot mint a second task. Later continuations retain
separate work/Run links rather than replacing this initial identity.

The session `POST /api/specialist-assignments` exposes company-owned and project operational-specialist/coordinator manual
submission with the bounded original request and idempotency key. It returns the
existing assignment DTO (201 for new work, 200 for exact replay), then uses the
existing pool scheduler after the reservation commits. Host pressure/capacity can
leave execution Pending. A replay can signal interrupted pending admission without
allocating another execution. `GET /api/specialist-assignments/{id}` supports
currently authorized company/project inspection; both responses are private and
no-store. Personal user-token `POST /api/v1/ext/specialist-assignments` and exact GET reuse the same intake/reader and immutable manual identity, so switching between browser and API does not repeat work. Both require the corresponding token scope and current owner/source authority; project/agent/librarian tokens cannot impersonate the user. The existing token audit records authenticated success/refusal, CONFIG/JSON validation uses external 422, and responses remain private/no-store. Source-specific and governed agent-principal adapters remain Designed. Fresh company standalone submission is qualified through the actual
session route, default scheduler dispatch, real supervisor/ACP process, validated
operational result and physical cleanup. Completed HTTP replay issues no second
create/prompt command. Coordinator intake is qualified through queued HTTP
admission and its existing driver. Project coordinator intake uses the actual attached Flow, repository admission and native result-only terminal path; the stand pilot remains unqualified.


### Clarification and context

Existing agent-question/HITL services gain an assignment subject without a task requirement. Human `assignments` retains claim/answer ownership; company actor scope and role mapping come from the company Flow binding. A question stores assignment, expected input revision, coordinator epoch, prompt/turn and source principal. Same answer replay is inert; changed/late/wrong-assignment/terminal answer returns 409. Persist answer intent before delivery and mark delivered only after ACK. Failed DB/delivery handling explicitly cancels/releases the supervisor's owned permission deferred; no hidden promise waits.

The response body carries `response` as a bounded object validated against the exact stored native question FormSchema, not a replacement free-text-only grammar or caller-supplied schema. Required string answers are nonblank; human question suggestions permit custom text as the existing contract specifies, while permission/transition enums stay closed. Work `clarify` decisions may omit resultRevision when no result exists; accept/reject/rework of a result require the exact ready result revision at the service boundary. Context entry IDs are assignment/revision-local logical keys, not caller-authoritative global database row IDs.

Context changes lock the stable assignment, check expected context revision/epoch and current source grants, then append one immutable revision and attributed decision. A losing patch returns 409 and must be explicitly rebased; no automatic last-writer merge. Accepted findings refer to exact child result revisions. Server-derived source restrictions propagate through summaries and context even if a model omits citations. Current permission is rechecked at read/share/accept/action; snapshots are history, not grants.

### Delivery and cancellation windows

Destinations are a task/comment thread, current user Inbox, or existing configured outbound subscription/event reply. Endpoint/credentials come from server configuration, not model-supplied URL. Internal comment/Inbox delivery has a unique receipt key and is idempotent. External delivery carries a stable ID and is at-least-once unless the peer proves stronger semantics. Lost delivery ACK retries delivery only; never reruns the assignment/effect. Current access gates content before delivery, including changed recipients.

Crash before intake commit leaves no assignment orphan; after commit reuses source receipt/reserved run. Crash after answer intent but before ACK leaves delivery retryable under its exact binding. Crash after acceptance but before message delivery is owned by the existing outbox. Cancelling the assignment never deletes its operation/accepted evidence; reconciliation can continue under a dedicated current recovery grant without reviving the cancelled agent. Missing access results in a safe blocker and actionable authorized-owner incident.


## Expectations

- **CBA-01:** Assignment responsibility and all required request/result/origin fields survive retries/cancellation with existing run links, enforced by the assignment store and versioned input rows (`IT-CBA-01`).
- **CBA-02:** All six origins classify duplicate/update/clarification/independent/missing/conflicting/unknown requests without losing work, enforced by canonical intake receipts and adapters (`IT-CBA-02`).
- **CBA-03:** Standing, recurring, assignment, knowledge and authority inputs remain separately frozen and inspectable, enforced by launch/input snapshots (`IT-CBA-03`).
- **CBA-04:** Context preserves attributed structured work and rejects conflicting updates, enforced by assignment-row lock and revision/epoch CAS (`IT-CBA-04`).
- **CBA-05:** Clarification resumes the exact assignment/question/input and releases failed owned deferreds, enforced by existing human-ask/HITL delivery with assignment subjects (`IT-CBA-05`).
- **CBA-06:** Origin delivery is current-access-filtered, durable and cannot repeat business effects, enforced by typed destinations/outbox receipts (`IT-CBA-06`).
- **CBA-07:** Completion requires exact expected result and verification acceptance, enforced by transactional acceptance and terminal CHECKs (`IT-CBA-07`).
- **CBU-02:** EN/RU assignment UX exposes responsibility, questions, children, accepted evidence and authorized recovery, enforced by existing agent/history/Inbox extensions (`E2E-CBU-02`).

## Edge cases

- **EDGE-CBA-01:** Identical and changed-payload retries are distinct; changed payload rolls back dependent writes (`IT-CBA-02`).
- **EDGE-CBA-02:** Out-of-order/late answers cannot resume a newer input or different assignment (`IT-CBA-05`).
- **EDGE-CBA-03:** Two context writers cannot silently lose a decision; loser sees `CONFLICT` with safe current revision (`IT-CBA-04`).
- **EDGE-CBA-04:** Child Done, stale result or missing independent verification cannot satisfy completion (`IT-CBA-07`).
- **EDGE-CBA-05:** Lost origin ACK repeats only delivery, not accepted work or external mutation (`IT-CBA-06`).

## Linked artifacts

- [ADR-203](../decisions.md#adr-203-durable-specialist-assignments-and-company-coordinator-flows), [persistence](../db/specialist-assignments-domain.md), [runtime](specialist-runtime.md), [cooperation](specialist-cooperation.md).
- [Human assignments](assignments.md), [HITL](hitl.md), [scheduled requests](scheduled-agent-requests.md), [web API](../api/web.openapi.yaml), [error taxonomy](../error-taxonomy.md).
- Implementation: `web/lib/specialist-assignments/` (base store implemented), existing agent-question, prompt-owner, result and outbox services; invocation/cooperation remain designed.
