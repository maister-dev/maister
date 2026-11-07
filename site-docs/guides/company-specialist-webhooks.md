---
title: "Send a specialist request by webhook"
description: "Submit a company or project assignment and safely repeat a delivery without creating another Run."
---

Use the existing agent-event endpoint for company or project work. Company-owned
work needs no repository; project work uses its actual project attachment and
repository admission. The example below is company-owned; the project variant is
described after it. Ask an administrator for the company ID, reviewed specialist binding
ID and professional's qualified agent ID, such as `operations:diagnostician`.
The installed specialist must declare the `webhook` trigger, have an enabled
reviewed binding and a Ready runner. A coordinator also needs its enabled,
reviewed result-only Flow on engine 3.12.0 or newer.

## Prepare access and a delivery identity

Use a global personal API token with both `agents:trigger` and
`assignments:submit`. For company work, your active user account must currently hold company
`assignments:read`, `assignments:submit` and `assignments:update` authority.
Installing a package or selecting a company does not grant those permissions.
Project, agent and librarian tokens cannot act as a personal user here.

Choose a stable `Idempotency-Key` for each independent request: 8–128 ASCII
letters, digits, dots, underscores, colons or hyphens. Preserve it when retrying
the same delivery. Rotating your personal token preserves this identity when the
owner, authenticated user and addressed professional stay the same. Changed
content under an existing key conflicts; independent work needs a new key.

## Submit the assignment

Send `POST /api/agents/{agentId}/event` with `Authorization: Bearer …`,
`Content-Type: application/json`, `X-Maister-Owner-Kind: company` and
`Idempotency-Key: …`. The company header selects this contract. The body is a
closed version-one envelope, at most 32 KiB of UTF-8 JSON:

```json
{
  "schemaVersion": 1,
  "assignment": {
    "owner": { "kind": "company", "companyId": "company-id" },
    "specialistBindingId": "reviewed-binding-id",
    "objective": "Diagnose the configured component",
    "expectedOutcome": "An evidence-linked diagnosis with explicit missing checks",
    "input": "Inspect the authorized target without mutation.",
    "targetIds": ["stand:configured"],
    "inputRefs": [],
    "constraints": ["No unapproved mutation"],
    "verification": [
      { "kind": "result", "referenceId": null, "required": true }
    ]
  }
}
```

Replace the example IDs with administrator-provided identities. The server checks
that the binding belongs to the selected company and addressed professional,
resolves its mandatory result contract and records your actual identity. The
literal input remains separate from standing instructions and permissions.
Requester, origin, permissions, expected result contract and arbitrary reply URLs
are server-controlled. The legacy project-token `X-Maister-Trigger-Event-Id` header is
refused on both native assignment branches.

## Submit project work

Use `X-Maister-Owner-Kind: project` and the same global personal token scopes,
version-one envelope and delivery key. In the example, replace `owner` with
`{"kind":"project","projectId":"project-id"}` and `specialistBindingId` with the
actual project specialist attachment ID. The addressed role must declare `webhook`
and use its current trusted project package pin. Your account needs current
project read/launch authority; company grants do not substitute for it. A project
coordinator additionally needs its enabled, configured result-only Flow.

A project coordinator webhook is an automatic request. Its carrier task needs a
current accepted ready assessment bound to the original private assignment input.
Until then, `201` (new) or `200` (replay) returns queued work with an empty Run
list. An authorized user records the assessment through the existing task
qualification controls. Qualification events and the existing scheduler resume
the same assignment; preserve the original delivery key. A personal API token
does not grant one-shot interactive launch authority.

Interrupted intake preserves the original input. The existing scheduler recovers
unused carrier and source reservations; a Run receipt or launch intent prevents
that reservation from being reused.

Original input is retained before repository/workspace admission. If readiness
refuses execution, repair the named prerequisite and repeat the same body/key to
admit that queued input. An exact retained delivery is inspected under current
permissions even if the provider was subsequently disabled. Private request text
stays in the assignment input; stored native trigger metadata carries only its
delivery identity. A new key creates independent queued work. Company and project
assignments expose progress and results through the retained Run under current
access. The assignment records the user's Inbox as its destination; result availability is delivered there under current recipient/source access.
Assignment acceptance remains a separate decision.

Omitting the owner header selects the older project-token webhook payload
contract and its `202` Run response. Use the explicit project header for a durable
specialist assignment.

## Inspect the receipt and handle retries

A new delivery returns `201` with the assignment, exact owner, origin and Run IDs.
An unchanged replay returns `200` with the same identities. Capacity pressure can
leave that Run queued; retrying the delivery wakes the existing work. Follow the
retained Run to inspect progress and its structured result. Run success and
assignment acceptance are separate decisions; neither confirms a Brain assertion.

Responses are private and are not cached. Use the status to decide the next step:

| Status | Action                                                                       |
| ------ | ---------------------------------------------------------------------------- |
| 401    | Replace a missing, invalid, expired or revoked token.                        |
| 403    | Check both token scopes and your current company or project authority.                  |
| 404    | Check the owned binding and addressed professional with the administrator.   |
| 409    | Inspect the original delivery or repair the reviewed execution precondition. |
| 413    | Reduce the body below 32 KiB.                                                |
| 422    | Correct the closed envelope, delivery key or incompatible header.            |
| 503    | Repair runner/host readiness, then retry the same delivery key.              |

If a response is lost, repeat the exact request and key. A retained reservation
reuses its assignment and Run. Use a new key only for intentionally independent
work. Revocation applies to subsequent reads and actions even when older input
and authority snapshots remain inspectable.

## Find a queued coordinator's qualification task

Use `GET /api/specialist-assignments/{assignmentId}/admission` with your browser
session, or add `/v1/ext` after `/api` for a global personal token with
`assignments:read`. No query parameters are accepted. Current assignment and
source access are required; other credential kinds cannot act as a human reader.

For a project coordinator, `carrier.taskHref` opens the retained task and its
existing qualification controls. The view shows the original input revision and
digest, qualification summary and active launch when present. The current
assignment input revision remains separate from that original carrier input.
`carrier_input_unavailable` means its original linkage cannot be verified; inspect
that conflict before continuing. A queued `project_flow` with no carrier is still
waiting for intake recovery. Preserve the original request key.

Company work and standalone project specialists have no carrier. Inspection
creates no task, assessment or Run and remains available when a provider is
disabled, subject to current access. `repository_evidence_not_checked` means a
ready assessment does not guarantee launch: actual dispatch rechecks repository
evidence, permissions and execution readiness.

When dispatch detects that repository evidence has advanced, it requests a fresh
assessment for the same retained work. Refresh the task's qualification controls
and review the current evidence; preserve the assignment and request key. A
repeated or delayed refusal cannot invalidate a newer accepted assessment.

## Inspect result delivery and replay a failed cycle

Use `GET /api/specialist-assignments/{assignmentId}/delivery?runId={runId}`
with your browser session, or add `/v1/ext` after `/api` with a global personal
`assignments:read` token. Select a Run from the assignment. Optional
`resultRevision` selects an exact retained revision; omission selects the latest
retained receipt. Current assignment and source access are required, including
for historical results.

The response shows the frozen destination, exact input/result witnesses and
transport state: `awaiting_dispatch`, `pending`, `delivered` or `dead`. It includes
bounded attempt metadata and `stateSha256`; result bodies, endpoint credentials
and raw transport responses are excluded. Cancellation or a superseded result
does not erase delivery history that you can still access.

To retry delivery, send `POST` to
`/api/specialist-assignments/{assignmentId}/delivery/{deliveryId}/replay` with
`Content-Type: application/json` and the inspected witness:

```json
{
  "schemaVersion": 1,
  "expectedStateSha256": "replace-with-the-inspected-64-hex-digest"
}
```

Use the actual returned digest. The body is limited to 4 KiB. Browser writes must
originate from the same MAIster origin. Personal API clients use the external
path and `assignments:recover`; project and agent credentials cannot perform this
human recovery action. Your current read/recovery authority, the original
recipient's current access, destination and exact current result are rechecked.

A successful `200` queues delivery only. It preserves the delivery identity,
Inbox read state and existing task reply; it does not repeat specialist work or
complete the assignment. A pending cycle or stale witness returns `409`. Inspect
the latest state before deciding whether to retry. Cancelled or superseded work
cannot be revived through delivery replay. A lost replay response can be checked
by inspecting the same receipt; repeating an old witness cannot queue another
cycle, even after an intervening delivery finishes.

## Inspect and update working context

With an active browser session and current assignment read authority, use
`GET /api/specialist-assignments/{assignmentId}/context`. An optional `revision`
selects retained history. Revision zero means no recorded context; its objective
and constraints come from the current assignment input. Recorded revisions show
their exact input, original authors and explicit supersession. Access to every
inherited source is checked before returning context, including historical reads.

Session users with current update authority can send `PATCH` to the same URL.
Include `expectedRevision`, `expectedInputRevision`, a stable `idempotencyKey` and
`updates` containing distinct entries with `id`, `kind`, `text`, `state` and
`references`. Use kinds such as `question`, `hypothesis`, `decision`, `work` or
`blocker`; finding entries additionally require the structured findings envelope.
Use `supersedesEntryId` to replace an existing entry with a new identity. Keep the
JSON body below 32 KiB. A stale revision returns 409: inspect the latest context
and explicitly rebase. Repeating the exact key and content returns the original
accessible revision. Notes cannot accept work or confirm a Brain assertion. The session endpoint supports human edits. A global personal token with
`assignments:read` can inspect context through
`GET /api/v1/ext/specialist-assignments/{assignmentId}/context`. A company
specialist whose reviewed role allows that scope can use `assignment_context_get`
to read its own appointed context through its current Run credential. Other
assignments and unavailable sources are withheld. This read scope does not grant
Brain access or context editing.

To edit context through the external API, use `PATCH` on that external URL with
both `assignments:read` and `assignments:update` token scopes and the same
revisioned body. A personal client retains your user identity. An active
specialist can use `assignment_context_update`; company roles also need a
reviewed update limit and explicit current professional update authority, while
your initiating account must retain its update authority. Project specialists
keep their current project appointment and initiating membership. Queued and
reviewed Runs cannot write context. The server records the actual Run/node author
and carries forward all sources the Run consumed, including omitted citations.
Read access and working notes never accept work or confirm a Brain assertion.

New standalone generations and Flow-node prompts include the authorized working
context. Company roles need the reviewed `assignments:read` limit. If a source is
unavailable, the new dispatch refuses; it does not supply a partial summary.
Recovering an already retained prompt keeps its original context snapshot. Use
`assignment_context_get` to inspect the current revision during ongoing work.

Use `assignment_get` with `assignmentId` to inspect your appointed assignment's
responsibility, expected result and current revisions. The same read scope uses
`GET /api/v1/ext/specialist-assignments/{assignmentId}`. Its `revision` is the
business revision; `inputRevision` and `contextRevision` identify separate
histories. Preserve the appropriate exact values for each update. Current source
access applies to the entire assignment and its working context. Sharing another
Run's input does not expose that Run's assignment or later working notes.

Company-only clarification appears under **Company** in Inbox when you currently hold explicit assignment read and answer grants and can access its sources. Losing either grant removes the card and its count. A project-scoped queue does not include company work. Expanded context and the Run link work without a repository.

When a specialist assignment clarification appears in Inbox, answer its displayed
form under your current answer authority. Suggested text choices permit your own
answer. The accepted answer becomes a new attributed input revision; the Run's
original input and standing instructions remain inspectable. Capacity or host
pressure can leave the same Run queued for resume. An exact repeated answer is
safe; a changed or late answer and a cancelled assignment require inspection.
Submitting an answer does not complete the assignment or confirm Brain knowledge.

A specialist can request that clarification with `assignment_question_ask`. First
read `assignment_get`, then send `assignmentId`, the exact `expectedRevision`
(business revision), `inputRevision`, `question`, a version-one MAIster `schema`,
and a stable `idempotencyKey`. Use distinct, safe form field names; each object
supports at most 64 fields. Do not put server question, prompt or session metadata
in the form. A Run supports up to 32 native answers; after that, another new
question requires an authorized continuation, while prior work remains retained. The whole request is bounded to 32 KiB and the retained
question plus original input must leave room within the 8,000-character input.
Current read/update authority and all source permissions are required. The server
records the actual Run or Flow node and pauses its owned prompt; callers cannot
choose authorship or grant themselves authority. Exact repeated requests reuse the
question. Rotated or revoked credentials require current inspection and access.

The native session endpoint is `POST /api/specialist-assignments/{assignmentId}/questions`;
its bearer equivalent adds `/v1/ext` after `/api`. A new active question returns
201, exact replay 200 and pending checkpoint activation 202. An HTTP dependency
failure may leave a retained pending question: retry the same key/content and
inspect Inbox rather than create independent work.

A human API client can use `assignment_question_respond` or
`POST /api/v1/ext/specialist-assignments/{assignmentId}/questions/{questionId}/respond`
with its current personal `assignments:answer` credential, exact business/input
revisions, `response` and stable answer key. This queues continuation with 202;
exact authorized replay returns 200. Machine credentials cannot answer human work,
and the company agent toolset omits this answer tool. The existing Inbox form
supplies these retained selectors automatically. The same Flow node resumes under
a new execution epoch after capacity and host admission; its original Run input,
completed work and checkpoint evidence remain inspectable.
