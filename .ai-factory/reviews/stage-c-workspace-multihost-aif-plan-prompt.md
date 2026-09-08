# Copy-paste prompt: Stage C ownership cut and local multi-host execution

Use after the separate A/B stabilization plan has passed its acceptance gates. Planning may proceed earlier, but Stage C implementation must retain that hard dependency.

```text
$aif-plan full

Create an implementation-ready, SDD-driven plan for:
Stage C — Host-Owned Repositories and Workspaces, followed by Local Multi-Host Execution.

Testing = yes
Logging = verbose
Documentation = yes

Objective

Make the execution host the sole executor/owner of its repository caches,
materialized workspaces, Git/CLI processes and execution filesystem effects.
Then prove host registry, liveness/heartbeat, drain, capability matching,
placement, leases/epochs and per-host capacity on at least two isolated local
execution-host processes with different private state, runtime and repository roots.

Keep the default one-host installation simple and fully supported.
Two local hosts are a correctness qualification target, not a production remote
trust claim.

Baseline and hard prerequisite

Inspect current main and the actual current checkout. Previous audit baseline:
33f9d34f4 over main 5b458457a94b689713491d158e751553d676be6a.
Stage A baseline: 06aa7f7e137773cb31d55610148fe138f14c7be8.

Read:
- .ai-factory/reviews/stage-ab-execution-host-audit-2026-09-05.md
- .ai-factory/reviews/stage-ab-stabilization-aif-plan-prompt.md and its resulting
  implementation plan and verification record, if present
- .ai-factory/plans/claude-stage-a-execution-host-plan-6d70f9.md
- .ai-factory/plans/feature-stage-b-durable-execution-host-data-plane.md
- ADR-023, ADR-166, ADR-167, current architecture and repository/workspace ADRs
- actual source, routes/actions/jobs, tests, Drizzle schema, migrations,
  journal/snapshots, OpenAPI/AsyncAPI, system analytics and deployment files.

A/B stabilization is a separately executable prerequisite. Revalidate R01–R17
against the current checkout and require closure or concrete counterevidence
before Stage C production implementation. Do not hide A/B bugs inside a large
new feature phase or assume checked boxes prove acceptance.

Naming:
- Stage B B2 was canonical manager projections/browser SSE, not Workspace/Git.
- Stage C ownership cut must pass on one host before activating two-host placement.
- Stage D retains trusted remote enrollment/auth/relay/secret-delivery work.

Architecture constraints

Preserve and evolve ExecutionHosts, opaque WorkspaceHandle, host identity,
assignments/epochs, command IDs/receipt ledger, canonical manager events,
runtime objects and typed errors. Domain contracts remain transport-neutral.
Do not add a generic RPC shell, new workflow engine, broker, distributed database,
or abstraction without a concrete ownership/lifecycle need.

The manager owns:
- authentication/authorization, source/project/package identities and trust;
- admission policy, immutable approved execution inputs and consent;
- orchestration/Flow/node_attempts, HITL, scheduling policy;
- review/promotion authorization and expected target identity;
- canonical events, durable operation intents/results and read models.

The host owns:
- clone/fetch/repository cache and local materialization;
- worktree creation/removal/adoption migration/reconciliation;
- CLI/check cwd, child process lifetime and cancellation;
- Git status/diff/log/checkpoint/rewind/sync/push/promotion side effects;
- capability/skill/instruction/context materialization;
- its runtime logs and execution-produced evidence payloads;
- local filesystem GC, archive preservation and private file paths.

Keep manager-authored evaluation/configuration/catalog content under its proper
authority. Moving execution effects does not mean moving product policy or all
manager files to the supervisor.

Repository-grounded inventory

Audit every web-side fs read/write, Git/subprocess call, cwd construction and
path-derived ID across app/lib/scripts/instrumentation and .ts/.tsx entry points.
Classify each operation as manager-owned, host-owned, migration-only or deferred.
Use function/call-site granularity; a filename whitelist is insufficient.

Start from:
web/lib/repo-source.ts
web/lib/worktree.ts
web/lib/git-remotes.ts
web/lib/services/runs.ts
web/lib/scratch-runs/service.ts
web/lib/agents/launch.ts
web/lib/flows/runner-cli.ts
web/lib/flows/graph/workspace-checkpoint.ts
web/lib/flows/graph/artifact-content.ts
web/lib/runs/sync-target.ts
web/lib/runs/promote.ts
web/lib/context-mounts/service.ts
web/lib/capabilities/materialize-bundle.ts
web/lib/capabilities/materialize.ts
web/lib/gc/workspace-gc.ts
web/lib/gc/workspace-reconciler.ts
web/lib/workbench-lifecycle/service.ts
web/lib/scheduler/handlers/repo-delivery-scan.ts
web/lib/reconcile.ts
web/lib/execution-host/adoption.ts
supervisor/src/workspace-registry.ts

Also inspect package/config discovery, maister.yaml/bootstrap/write-back,
credential references, adapter homes, private agent-memory bytes,
context consent, manual/human takeover, archive paths and recovery consumers.
Do not assume a repo_path column is a portable identity.

Required design areas

1. Repository and workspace identities

Separate central repository identity from a host-local materialization/cache ID
and a run workspace ID. Define host ownership, lifecycle, immutable revision
snapshot, workspace generation/operation fence, state/error metadata and references.
Use opaque host locators; no public/web-executed raw paths.

Specify each existing workspace mode:
own worktree, shared parent worktree, plain directory, repo_read/context checkout,
scratch and workspace-less execution. Shared-worktree roots and children must
retain one host affinity. Define read-only mounts and writer exclusion.

2. Creation/admission and post-run operations

Current addWorktree occurs before run-row commit. Define a durable reservation/
operation identity before the host effect, then dispatch/result/application and
orphan cleanup. Resolve whether the existing command ledger can reference the
pre-admission owner without inventing a parallel side-effect ledger.

Execution assignments are released before some Review/Done promotion/GC work.
Reuse existing workspace lifecycle operation claims and command receipts with
immutable workspace ownership and an appropriate operation fence. Do not mint a
fake active run assignment solely for post-run sync, promotion, archive or GC.

Specify non-atomic failure windows, cancellation, lost ACKs, duplicate/reordered
results, stale command completion, restart reconciliation and preservation before
deletion. A successful host side effect plus failed DB commit must have a precise
adoption/reconciliation path.

3. Typed host commands and queries

Inventory exact typed commands/queries for materialize/cache/fetch/worktree,
CLI/check, status/diff/log, checkpoint/rewind, sync/push/promote/archive/delete.
Keep public domain contracts operation-specific and free of raw filesystem paths.

Use accepted durable commands, queryable receipts/results and canonical events
for long operations. Define idempotency/request digest, progress, result schema,
bounded open JSON extensions, limits, streaming/ranges, timeouts, cancellation,
resource ownership, replay and poison handling. Reuse the corrected A/B protocol.

For each route/message, classify identifiers as URL-selected, authenticated
principal-derived, server-derived or request-body supplied. Derive cross-resource
identifiers from manager/host authoritative records. Validate repository URLs,
refs, relative content paths and executable tool declarations; address traversal,
symlinks, argument injection and unintended credential exposure.

4. Git authority and promotion

Choose an explicit canonical target repository/ref authority for single-host
and two-host cases. Each host cache must not independently claim to own the same
mutable canonical local branch.

Preserve review/trust/precondition policy centrally. Define expected base SHA/ref,
remote identity and update checks for sync/push/promotion, branch conflict,
dirty workspace, uncertain remote push outcome, concurrent project operations,
manual local changes and replay after partial success.

Do not equate ACP checkpoint with Git workspace checkpoint. Preserve both
contracts, their retention and recovery boundaries.

5. Immutable execution inputs and host materialization

Freeze source revision, package/Flow/capability/skill/context versions and hashes,
instructions, workspace requirements, logical credential requirements and consent
before dispatch. Host applies the approved snapshot; it must not re-resolve mutable
manager/local install pointers at spawn or resume.

Choose explicit ownership/versioning for existing private agent-memory bytes
needed by execution. A DB lock cannot synchronize separate host-local memory.md
files. Limit work to portability/coherence of existing inputs; do not add a
long-term memory/self-improvement product.

Separate host credentials from manager secrets. For local hosts, use configured
host-local credential profiles/references and capability readiness; defer remote
secret enrollment/delivery. Specify adapter-home and ambient skill/config policy.

6. Registry, liveness, drain and placement after ownership-cut acceptance

Remove the one-active-local-host/global-URL assumption through host-addressed
transport resolution. Bootstrap one default host without enrollment/UI setup.
Support a small validated static local-host configuration and an optional
two-host qualification topology.

Define registry identity versus boot/incarnation, readiness versus liveness,
draining versus unavailable/retired, capability snapshots and freshness.
Host heartbeat is distinct from ACP child heartbeat.

Define deterministic placement, eligibility, per-host capacity, pending reasons,
fairness and atomic capacity reservation. Include concurrent manager workers,
capacity release, shared workspace affinity, capability loss and drain:
no new placement while draining; preserve existing permitted work.

Activate explicit assignment lease/renewal/expiry semantics as required for safe
local multi-host execution. Specify clock assumptions, host self-fencing,
partitions, late renewal/result, manager restart and prevention of two concurrent
owners. “Host did not answer” alone does not prove its side effect stopped.

For host loss, define wait/operator/recovery decisions and new-attempt boundaries.
No cross-host live ACP or mid-turn session resume. Do not auto-migrate a dirty
workspace without an explicit verified materialization/recovery contract.

7. Cutover, schema and deployment

Choose a bounded migration/adoption strategy for existing local repositories,
workspaces, historical runs and active sessions. Every increment must remain
operable on one host. Define drain/version gates, supervisor-first/web-first
upgrade behavior, rollback/roll-forward and coordinated DB/host backup recovery.
Do not leave permanent ambiguous path fallback or dual authority.

Use generated forward Drizzle migrations with SQL checks/indexes/FKs, journal and
snapshots. Recheck all ADR/migration/artifact numbers against main at implementation
time. Preserve historical workspace/session/object associations or fail loudly.

Wire each new setting through runtime configuration, validation, Dockerfile,
compose.yml, compose.production.yml, .env.example and deployment/configuration
docs. Default compose needs no second host, relay, enrollment, object storage or
additional manual setup. Optional two-host tests use disjoint volumes/identities.

8. Observability and product behavior

Specify bounded structured metrics/logs for materialization/Git/CLI latency and
bytes, cache hits, orphan workspaces, operation retries/unknown outcomes,
lease renewal/expiry/stale rejection, host heartbeat age, drain progress,
placement decisions/queue age, per-host capacity, GC preservation and failures.

Do not log source/prompt/evidence bodies, secrets or raw private paths.
Keep the current UI functional: actionable unavailable/capacity/drain/recovery
states, safe artifact links, and correct run/workspace status after asynchronous
commands. Preserve EN/RU and current UI conventions where changed.
A full host-administration product is not required.

SDD and acceptance

Produce contracts, state machines, refusal/precondition tables and a recovery
matrix for each reachable status/mode before implementation tasks.
For each task specify owner, dependencies, files/symbols/routes/tables,
requirements, failure table, primary test and observable acceptance criteria.
Tests must distinguish the promised invariant from the known failure; do not
accept schema/parser success or a mocked return value as proof of behavior.

Implementation must be TDD: RED -> GREEN -> REFACTOR, minimal production changes,
strict types, SOLID/KISS/DRY, existing module conventions, phase-level commits.
Prefer real Postgres, real Git repositories and real supervisor processes with
deterministic ACP fixtures. Use unit tests only for pure protocol transformations.

Two separate delivery gates are mandatory:

G1: Ownership cut works on one host.
- Web has no OS access to host repository/worktree/runtime roots.
- Launch/materialization, CLI/check, agent work, evidence, checkpoint, HITL
  resume/cancel/complete, diff/sync/promotion/archive/GC all work through contracts.
- Existing local histories and workspace modes remain usable.
- Post-run Git/GC works after execution assignment release.
- Duplicate commands and lost ACKs do not repeat side effects or lose ownership.

G2: Two isolated local hosts work after G1.
- Separate roots and SQLite identity/outbox stores; no shared repository/runtime
  filesystem and no web access to either private root.
- Capability/capacity placement and shared-worktree affinity choose legal hosts.
- Concurrent admissions cannot exceed capacity or create two workspace writers.
- Drain, stale heartbeat, partition, host restart and web restart behave as specified.
- Lease expiry/late ACK/old epoch cannot mutate current state or repeat effects.
- No cross-host ACP resume claim; recovery uses explicit new-attempt boundaries.
- Re-run G1 and A/B durability/deferred-release tests without regression.

Evaluate dependency-ordered increments:
C0 ownership inventory, target contracts, schema/ADR and test topology;
C1 host-created repository/workspace materialization on one host;
C2 host CLI/check and capability/context materialization;
C3 host Git/checkpoint/sync/promotion/GC and post-run operation fencing;
C4 bounded local adoption/cutover and G1;
C5 host registry/liveness/drain/addressed transport;
C6 capacity/placement/lease enforcement;
C7 two-host qualification, G2 and final contract/analytics reconciliation.

Adjust this sequence based on actual dependencies. Keep workstreams and acceptance
independently verifiable; no phase can depend on an undocumented later fix.

Required documentation:
OpenAPI web/supervisor, AsyncAPI events, typed error taxonomy, architecture,
supervisor, deployment/configuration, database schema/ERD, relevant system analytics
(repository/workspace/materialization/Git/CLI/placement/liveness/recovery/GC),
and an ADR with the next available number at implementation time.
Include complete requirements-to-enforcement-to-test traceability, a risk register,
two-phase side-effect failure tables and a coherent commit plan.

Non-goals:
remote trusted enrollment/authentication, Internet-facing relay, cloud provisioning,
object-storage deployment, host administration UI, live cross-host ACP resume,
multi-repository product orchestration, swarm/fleet coordination, long-term memory
or self-improvement. Do not remove existing context-repository support merely
because new multi-repository orchestration is out of scope.

Output an implementation plan only. Do not modify production code or begin
implementation. Distinguish as-built A/B, prerequisite fixes, Stage C work and
deferred Stage D work throughout.
```
