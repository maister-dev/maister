---
title: "Users, project access, and API tokens"
description: "Activate accounts, assign global and project roles, and issue scoped personal or project access tokens."
---

MAIster separates a person's platform account, membership in a project, and
credentials used by external tools. Treat them as three independent grants.

## Prerequisites

- Global `admin` access for account lifecycle and global roles.
- Project `admin` or `owner` access for project membership and project tokens.
- Any active user can manage their own profile and personal API tokens.

## Account lifecycle

Public registration creates a `pending` account with the global `member` role.
A global administrator opens **Users** and activates it before the user can sign
in. Accounts move between:

| Status | Effect |
| --- | --- |
| Pending | Credentials exist, but sign-in is refused until approval. |
| Active | The user can sign in and use granted global and project permissions. |
| Disabled | Existing browser sessions and personal tokens lose authority. |

The Users screen also supports administrator-created accounts, role changes,
password reset, activation, and disabling. MAIster prevents an administrator
from disabling or demoting themselves and prevents removal of the last active
global administrator.

## Global and project roles

Global roles are `viewer`, `member`, and `admin`. Project roles are `viewer`,
`member`, `admin`, and `owner`.

Open **Project → Members** to add an existing platform user, change their
project role, or remove them. Adding a project member never creates a platform
account. Global administrators have implicit owner-level access to all projects.

Use the smallest role that covers the person's work. A viewer can inspect Runs
and evidence. A member can operate delivery work and answer human-in-the-loop
requests. Project administrators manage packages, agents, integrations, and
membership.

## Personal API tokens

Open **Account → Personal API tokens** to connect a personal assistant or a
user-owned automation.

1. Choose a descriptive name and optional expiration.
2. Select only the capability groups the client needs.
3. Enable human HITL response only when the client is allowed to submit a
   person's decision.
4. Copy the token from the once-only reveal and store it in the client's secret
   store.

The plaintext begins with `mai_`, is returned only once, and is never stored by
MAIster. A personal token can act only in projects its active owner can access.
Revoking it or disabling the owner blocks later calls.

The `hitl:respond:human` scope is deliberately separate: a wildcard does not
grant it. This permits a personal assistant to read the cross-project Inbox
without authorizing it to answer decisions. When explicitly granted, the
assistant can relay an Inbox request to chat, return the person's answer, and
close the request in MAIster. The built-in Inbox remains the primary in-product
surface; chat is one optional API client.

## Project API tokens

Open **Project → Integrations** for a token owned by the project rather than a
person. Use it for CI, webhooks, or a service whose authority should remain
stable when team membership changes.

Project tokens are bound to one project and expose selected operations under
the versioned external API. Every identified call records token, actor, scope,
method, endpoint, result, and target project in the audit log without storing
the plaintext secret.

## Platform-agent tokens

Platform-agent Runs receive short-lived, project-bound tokens at launch. MAIster
creates and injects them, applies the agent's fixed scope set and project grants,
and revokes them at terminal state or when the attachment is disabled. Operators
do not copy these tokens into package files.

Cross-project agent access is off by default. Enabling it on the target
project's agent attachment grants only the restricted cross-project operation
set and still respects the agent-chain depth limit.

## Failure signals

- Pending or disabled account: sign-in is refused with an account-status reason.
- Forced password change: normal application actions stay blocked until the new
  password is saved.
- `401`: token missing, expired, revoked, or no longer backed by an active owner.
- `403`: the authenticated actor lacks the required global or project action.
- Hidden `404` on cross-project agent calls: the target may not exist or the
  target project has not granted that agent access.

## Related guides

- [Project workspace](/product-tour/project-workspace)
- [MCP servers and secret references](/administration/mcp-and-secrets)
- [Human-in-the-loop](/guides/human-in-the-loop)
