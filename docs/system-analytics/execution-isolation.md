# Execution isolation

## Purpose

**Designed.** Constrain untrusted workload processes, network access and credentials on an execution host while retaining the existing Run, Flow and session contracts. [ADR-210](../decisions/adr-210.md)

## Domain entities

- **Manager.** The web service authorizes an owner and records immutable dispatch intent. The supervisor authenticates it independently of workspace or workload identity.
- **Host.** The trusted supervisor owns the process gate, private state database, outbox, credential connector, proxy and any narrow privilege-switch helper.
- **Workload.** An ACP session, CLI/check/gate command, requirement probe, package install or independent diagnostic. Descendants inherit its physical boundary.
- **Grant.** A revisioned ceiling, runner profile, project command override, or owner-scoped binding to an allowed credential, file or network service.
- **Evidence.** An immutable launch capture, applied policy receipt, process obligation, terminal receipt or sealed result. Each binds the actual owner and generation. [Execution-host ERD](../db/execution-hosts-domain.md)

## State machine

```mermaid
stateDiagram-v2
    [*] --> Intent
    Intent --> Refused: authorize or validate fails
    Intent --> Accepted: durable fenced receipt
    Accepted --> Running: launch gate applies boundary
    Accepted --> Settling: spawn failure
    Running --> Settling: exit, cancel, revocation or lease loss
    Settling --> Terminal: effects and quiescence known
    Settling --> Indeterminate: evidence missing
    Indeterminate --> Terminal: reconcile exact receipt and effects
    Indeterminate --> Quarantined: unsafe to retry or publish
```

## Process flows

```mermaid
sequenceDiagram
    participant M as Web manager
    participant H as Execution host
    participant W as Workload
    participant P as Host proxy
    M->>M: Authorize owner and persist intent and policy
    M->>H: Authenticated fenced start with digest and handle
    H->>H: Check assignment and applied capabilities
    H-->>M: Durable acceptance or typed refusal
    H->>W: Start gated process with scoped environment
    W->>P: Request a connection using its bound grant
    P->>P: Recheck audience, destination and revocation
    W-->>H: Bounded output and exit
    H->>H: Verify quiescence and seal required result
    H-->>M: Publish terminal receipt on durable stream
    M->>M: Commit projection and wake owning waiter
    M->>H: Acknowledge committed contiguous stream position
```

### Principals and process entry points

| Class | Present execution path | Required placement and owner |
| --- | --- | --- |
| Project and company Run sessions, scratch, librarian, gate chat and repair | `supervisor/src/spawn.ts` and the process gate | Logical Run session capture with an incarnation-specific assignment. |
| Version, model, smoke and MCP diagnostics | `supervisor/src/http-api.ts`, `model-catalog/sources/acp-probe.ts`, `mcp-probe.ts` | Bounded diagnostic operation. Explicit upstream credential scope where necessary. |
| CLI, check and automated gates | `web/lib/flows/runner-cli.ts`, `web/lib/flows/graph/gates-exec.ts` | Exact Run command attempt, immutable descriptor and captured command policy. |
| Requirement probes | `web/lib/flows/requirements-check.ts` | Project preflight operation using a scoped host handle. |
| Package and capability setup | `web/lib/flows.ts`, `web/lib/capabilities/import.ts` | Exact package revision operation with a private staging directory and publication receipt. |
| Privileged Git | `web/lib/project-config-persistence/git-process.ts`, `worktree.ts`, `worktree-provenance.ts` and direct repository consumers | Trusted, centralized invocation and actor-attributed ref updates. Keep repository execution inside workload isolation. |

Auto-promotion dependency comparisons read both selected refs under the shared
Git inspection environment. They ignore ambient Git repository routing and
resolve exact objects without replacement refs.

Manager credential files belong to the manager and trusted host principals only. The trusted host owns provider credentials, deployment configuration, app secrets and private runtime state. Workloads receive an explicit environment and opaque grants. Reserve the manager, supervisor, databases, local credential stores, runtime state and privileged sockets from workload mounts and general egress. The brokered façade authorizes a specific audience, operation and resource.

### Local transport activation

The shipped systemd units require a readable manager credential file before
startup. The web unit also requires the expected host key. Directly
launched processes still activate authenticated loopback transport through
configuration. The supervisor validates the credential before opening the
listener, and the manager validates the expected host key before dispatch.
Each service reads its own private file outside repos and runtime roots.
Fastify checks the credential and execution host key before invoking a route.
The manager checks the host key on responses. The same checks cover health,
JSON commands, SSE reconnects and byte-range reads. Redirects stay disabled.
Each new request reads the current credential file. Rotation replaces both
files atomically per service and closes existing SSE connections by restarting
the manager after a drained cutover. Full credential confinement still depends
on the service identity split and the same-user workload boundary. The
host-key check binds application responses to the configured host key. Plain
loopback HTTP requires an OS boundary that keeps workloads away from the
listener and credential files.

The P1 Flow child policy uses the ADR-153 allow-list plus explicitly supplied
execution plumbing. Exclude the SSH agent socket and remove full inheritance.
Flow and capability package setup use the same allow-list.
The host ACP, version and MCP diagnostic paths use explicit startup
environments. Pre-confinement deployment may still resolve deliberately
configured provider or MCP credentials. OS identity and filesystem policy
protect host configuration.

### Settlement and recovery

| Boundary | Durable action and owner | Observable outcome |
| --- | --- | --- |
| Edit under a stale revision | Manager rejects before write using CAS | 409 conflict and current revision on authorized refresh. |
| Delivery interrupted before acceptance | Manager retries identical bytes under the active assignment | Existing receipt or one execution. |
| Accepted process or output interrupted | Host recovers the obligation from its journal, then manager reconciles the exact receipt | Terminal only after quiescence and required output evidence. |
| Credential revoked or operation superseded | Host closes scoped listeners, connections and forwards, then fences execution | A later stale event remains forensic only. |
| Publish interrupted or unowned ref move observed | Trusted ref publisher locks the physical repository and compares expected OIDs before restoration | Current authorized ref preserved, unresolved effects quarantined. |
| Migration between peers | Stop admission, drain, expand both stores, negotiate and activate | Legacy v1 replay works. Unsupported peer or store version refuses writable activation. |

## Expectations

- **ISO-01:** Every host route must authenticate before accessing state or starting an effect under split service identities.
- **ISO-02:** Policy resolution must enforce the ceiling, apply the strictest approval and reject stale edits without a write.
- **ISO-03:** Both storage upgrades must retain v1 receipts and negotiate mixed-owner replay without duplicate application.
- **ISO-04:** Resume and later named-session startup must use the frozen capture while checking current resource and credential authority.
- **ISO-05:** A qualified driver must apply namespace or Seatbelt restrictions, sanitized environments and verified process teardown at every covered entry point.
- **ISO-06:** Git operations must preserve foreign refs and privilege boundaries while attributing each permitted update to an exact writer and receipt.
- **ISO-07:** Network and credential grants must enforce exact audiences and direct destination denials with attributable, redacted events.
- **ISO-08:** Provider readiness must bind a proven OS, adapter, version and credential mode, including native resume where claimed.
- **ISO-09:** Run commands must stream bounded evidence and advance graph state once after the declared result contract is satisfied.
- **ISO-10:** Preflight, setup and diagnostics must hold real operation ownership and reconcile effects without creating a Run.
- **ISO-11:** Admin and project surfaces must show effective authority, typed refusals and exceptions to authorized readers in EN and RU.
- **ISO-12:** Local toolchain, cache and preview grants must stay within the exact workload scope and release on teardown.

## Edge cases

- **EDGE-ISO-13:** Unconfirmed termination, an ambiguous effect, a mismatched receipt or expired enforcement evidence must block further effects until reconciled or quarantined. An unavailable driver refuses with `PRECONDITION/isolation_unavailable`. A host spawn failure uses `EXECUTOR_UNAVAILABLE`.

## Linked artifacts

- [Acceptance traceability](execution-isolation-traceability.md)
- [Execution hosts](execution-hosts.md)
- [Execution-host data model](../db/execution-hosts-domain.md)
- [Supervisor OpenAPI](../api/supervisor.openapi.yaml)
- [Web OpenAPI](../api/web.openapi.yaml)
- [Canonical execution-host events](../api/async/execution-host-events.asyncapi.yaml)
