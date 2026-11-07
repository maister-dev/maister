---
title: "Send a company specialist request by webhook"
description: "Submit an authenticated company-owned assignment and safely repeat a delivery without creating another Run."
---

Use the existing agent-event endpoint to submit company-owned work without a
repository. Ask an administrator for the company ID, reviewed specialist binding
ID and professional's qualified agent ID, such as `operations:diagnostician`.
The installed specialist must declare the `webhook` trigger, have an enabled
reviewed binding and a Ready runner. A coordinator also needs its enabled,
reviewed result-only Flow on engine 3.12.0 or newer.

## Prepare access and a delivery identity

Use a global personal API token with both `agents:trigger` and
`assignments:submit`. Your active user account must currently hold company
`assignments:read`, `assignments:submit` and `assignments:update` authority.
Installing a package or selecting a company does not grant those permissions.
Project, agent and librarian tokens cannot act as a personal user here.

Choose a stable `Idempotency-Key` for each independent request: 8–128 ASCII
letters, digits, dots, underscores, colons or hyphens. Preserve it when retrying
the same delivery. Rotating your personal token preserves this identity when the
company, authenticated user and addressed professional stay the same. Changed
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
are server-controlled. The project-only `X-Maister-Trigger-Event-Id` header is
refused on this company branch.

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
| 403    | Check both token scopes and your current company authority.                  |
| 404    | Check the owned binding and addressed professional with the administrator.   |
| 409    | Inspect the original delivery or repair the reviewed execution precondition. |
| 413    | Reduce the body below 32 KiB.                                                |
| 422    | Correct the closed envelope, delivery key or incompatible header.            |
| 503    | Repair runner/host readiness, then retry the same delivery key.              |

If a response is lost, repeat the exact request and key. A retained reservation
reuses its assignment and Run. Use a new key only for intentionally independent
work. Revocation applies to subsequent reads and actions even when older input
and authority snapshots remain inspectable.
