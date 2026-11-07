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

Original input is retained before repository/workspace admission. If readiness
refuses execution, repair the named prerequisite and repeat the same body/key to
admit that queued input. An exact retained delivery is inspected under current
permissions even if the provider was subsequently disabled. Private request text
stays in the assignment input; stored native trigger metadata carries only its
delivery identity. A new key creates independent queued work. Company and project
assignments expose progress and results through the retained Run under current
access. The assignment records the user's Inbox as its destination; automatic
final-result delivery there is still in progress.

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
