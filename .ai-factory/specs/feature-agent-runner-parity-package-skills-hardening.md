# Agent Runner Parity and Package Skills Hardening

## Status

Verified on `feature/agent-runner-parity-package-skills-hardening`. Task 6.2
required suites are green, the review-fix crash windows have direct regression
coverage, and the traceability table records the final acceptance evidence.

## Value

Package-backed standalone agents can use every proven ACP adapter in read-only workspaces, receive their providing package's passive skills, and fail closed when evidence, package content, or profile configuration is invalid. Operator and Studio surfaces expose the same contract the runtime enforces.

## Scope

- Adapter-id-based read-only eligibility with versioned, fresh wire evidence.
- Descriptor-owned L2 materialization with adapter-generic L1 and L3 enforcement.
- Pinned-package wholesale skill materialization and Claude package subagents.
- Run-scoped, path-confined, concurrent-safe materialization ownership and cleanup.
- Strict `{ mcps?: string[] }` agent capability profiles through definition, resync, launch, and Studio.
- Supervisor diagnostics API, system analytics, screens, and verification parity.

## Non-goals

- No ADR-041 flow-run enforcement flip.
- No agent `model`, inline `mcp_servers`, `multiagent`, freeform metadata, YAML container, converter, import/export, continuous daemon, or managed-agent runner contract.
- No package-skill selection UI or cross-package skill additions.
- No change to flow-driven or flow-node-bound skill behavior.
- No DB schema, migration, new route, SSE event, environment variable, sidecar, port, or deployment mount.

## Requirements

| Id | Requirement |
| --- | --- |
| A1 | Read-only compatibility and evidence are keyed by stable adapter id; web and supervisor mirrors agree. |
| A2 | Evidence-required adapters launch read-only only with generic smoke `ok` plus read-only wire evidence that is `ok`, current-probe compatible, not future-dated, and younger than seven days. Refusal precedes every launch side effect. |
| A3 | L1 allows read and denies write/unknown inline without HITL leakage; L2 is descriptor-owned best effort; L3 detects real repo dirt. |
| A4 | `dangerously_skip_permissions` stays refused for read-only workspaces and non-Claude `mode=subagent` stays refused. |
| A5 | OpenCode native persona materialization ships only if its installed source proves a bounded file-only contract; otherwise the explicit no-tract result is documented. |
| B1 | Standalone sessions materialize every passive skill root from the pinned attached providing package; catalog selection flags cannot omit them. |
| B2 | Claude receives package skills and subagents. Other adapters receive only descriptor-supported skills. |
| B3 | Ownership is run-scoped, atomic, path-confined, concurrent-safe, crash-recoverable, and never deletes user-owned content. |
| B4 | Manual, cron, domain-event, and webhook paths converge on `launchAgentRun`; `none`, `repo_read`, and `worktree` use their actual launch cwd. |
| B5 | Attached-package trust authorizes passive skills; stdio MCP execution still requires exec trust. |
| C1 | `capability_profile` is strict `{ mcps?: string[] }`, using the canonical id schema, stable deduplication, max 32 entries, and no unknown keys. |
| C2 | Invalid definitions report source context and are never inserted/updated/disabled by that resync; genuinely missing definitions retain disable behavior. |
| C3 | Studio shows strict profile issues and blocks commit/cut/publish until valid. |
| Q1 | Delivery follows SDD then TDD RED -> GREEN -> behavior-preserving refactor with runnable, minimally overlapping, non-trivial tests. |
| Q2 | Code stays strictly typed, structured-logged, fail-fast, and consistent with SOLID, KISS, DRY, and project dependency rules. |

## Core invariants

- Cache v1 remains readable for generic readiness but its read-only evidence is diagnostically `stale`; cache v2 carries `probeVersion`.
- Diagnostic `stale` is derived, never persisted as successful evidence.
- A probe invalidates targeted read-only evidence before work; only complete read/write/unknown observations may write `ok`.
- Materialization ownership uses `.maister/agent-materialization/` with a cwd index, per-run records, and `preparing | active | releasing` states under a bounded filesystem lock.
- Ownership paths are normalized relative paths under adapter-approved roots. Absolute, empty, traversal, duplicate, out-of-root, and symlink-escape paths are invalid.
- `runs.agent_workspace` is the durable workspace decision. No migration is required; if a new durable decision is discovered, implementation stops for contract replanning.
- Known domain refusals use `MaisterError`; API/UI never string-match messages.

## State and refusal contracts

### Evidence

```mermaid
stateDiagram-v2
    [*] --> Missing
    Missing --> Probing: smoke command
    Ok --> Probing: re-probe invalidates old evidence
    Probing --> Ok: generic + read/write/unknown observations pass
    Probing --> Error: any observation fails or process exits
    Ok --> Stale: age, future timestamp, cache v1, or probe-version mismatch
    Stale --> Probing: operator re-probes
```

Read-only launch allow-list:

1. Workspace is `worktree`; read-only evidence is not required, or
2. Workspace is `none | repo_read`, permission policy is not dangerous, adapter descriptor is read-only capable, and its evidence policy is `not_required`, or
3. Same read-only workspace/policy/capability conditions and both generic plus nested evidence evaluate `ok` and fresh.

Every other state refuses with `EXECUTOR_UNAVAILABLE` before workspace creation, run/session insert, or token issuance.

### Materialization ownership

```mermaid
stateDiagram-v2
    [*] --> Preparing: durable intent written
    Preparing --> Active: paths copied and index committed
    Preparing --> Recovered: crash reconciliation rolls back or finishes
    Active --> Releasing: terminal cleanup intent
    Releasing --> [*]: last lease deleted and records removed
    Releasing --> Recovered: cleanup retries idempotently
    Recovered --> Active: live owner remains
    Recovered --> [*]: terminal owner cleaned
```

Corrupt ownership state preserves files and fails loudly. It never guesses ownership.
Terminal DB state commits before filesystem release. Preparing cleanup removes
only unleased intent paths, foreign leases always win, and releasing cleanup may
finish an index update that committed before its run record was removed. A
corrupt or symlinked release target is structured-ERROR logged after commit and
cannot roll back the terminal run state.

## API contract

- Existing `GET /diagnostics`; no new route.
- Nested `smoke.readOnlySession.status` adds diagnostic-only `stale`.
- Nested `smoke.readOnlySession.probeVersion` is `integer | null`.
- `checkedAt` remains nullable ISO date-time; `protocolVersion` keeps ACP wire-version meaning.
- Web OpenAPI and all AsyncAPI event schemas are unchanged.

## DB and artifact contract

- No Drizzle schema or migration change.
- Existing `runs.agent_workspace` is the terminal enforcement snapshot.
- New durable state is filesystem-only under `.maister/agent-materialization/`, written atomically and excluded/restored by the dirty watchdog.

## UI expectations

- Settings separates normal Ready from read-only eligibility and shows missing, stale-age, stale-version, error, ok, and not-required states with `checkedAt` and one smoke remediation.
- Project-agent launch keeps the typed refusal context and never displays a partial run.
- Studio retains the compact structural editor, surfaces exact profile issue paths, and blocks artifact lifecycle actions while invalid.
- Every new label is localized in EN and RU; no raw enum label is rendered.

## Test strategy

- Pure unit tests: evidence evaluator boundaries, strict profile schema, path validation, ownership state reducers.
- Supervisor contract/wire tests: cache compatibility, diagnostics schema,
  every capable adapter reaching the read-only seam, and one adapter-generic
  read/write/unknown arbitration proof.
- Web integration tests: pre-side-effect launch refusal, pinned package inventory, workspace/finalize cleanup, trigger convergence, resync non-mutation.
- Component tests: Settings evidence states and Studio strict errors.
- One behavior axis per test; no full adapter x workspace x trigger Cartesian repetition.

## Acceptance criteria

- Every A/B/C/Q requirement has a green test or explicit unchanged-surface verification.
- Supervisor OpenAPI, supervisor/web Zod schemas, analytics, screens, and runtime agree.
- No migration or deployment artifact changes exist.
- Every new test is listed by exactly one Vitest project and full relevant suites are green after refactor.
- Docs, contracts, ADR anchors, typecheck, check-only ESLint, focused suites, and full suites pass.
- Live smoke may be environment-unavailable, but no required adapter becomes eligible without valid cached evidence.

## Traceability

| Requirement | As-built surface | Verification |
| --- | --- | --- |
| A1-A2 | Adapter-id launch gate, cache v2, `probeVersion`, derived freshness | Supervisor cache/unit tests; web resolver/client tests |
| A3-A5 | Layered ACP wire arbitration; descriptor-selected Claude L2; no OpenCode native-persona tract | Every capable adapter reaches the shared seam; adapter-generic read/write/unknown cases avoid a redundant Cartesian matrix |
| B1-B2 | Pinned manifest member-root inventory; descriptor-supported skills/subagents | Adapter-home and effective-definition tests |
| B3 | `.maister/agent-materialization/` index, per-run states, lock heartbeat, leases, confinement and recovery | Dirty-watchdog ownership, concurrency, symlink and crash-window unit tests |
| B4-B5 | Central `launchAgentRun` materialization/finalization; existing trigger normalization and stdio exec-trust gate | Launch/trigger/effective tests; four feature real-PG suites passed 37/37 |
| C1 | Canonical strict capability-profile schema through launch | Definition, artifact-validation and Studio component tests |
| C2 | Invalid-existing resync protected from missing-row cleanup | Registry real-PG integration test passed in the 37/37 feature gate |
| C3 | Strict Studio field validation plus existing artifact lifecycle blocking | Studio editor and artifact-validation unit tests |
| Q1-Q2 | SDD artifact, RED evidence, GREEN implementation, refactor, phase commits | Full web unit 6116/6116 and integration 2224/2224; supervisor unit 329/329 and integration 87/87; MCP 201/201; focused ownership/settings 24/24; docs/contracts/typecheck/lint gates green |

No Drizzle schema/migration, web OpenAPI, AsyncAPI, deployment, environment,
port, sidecar, or mount changed in this slice.
