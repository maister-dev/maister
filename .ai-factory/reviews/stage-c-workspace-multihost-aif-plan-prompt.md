# Stage C planning request — Run board tasks on a selected supervisor

Copy the block below into a planning session. It asks for an implementation plan for Stage C and a target architecture for the subsequent remote-host and workload-backend stages. [Project roadmap](../ROADMAP.md)

```text
$aif-plan full

Write the plan in English. Link it to the roadmap milestone “Run board tasks on a selected supervisor”.
Deliver a target architecture for the whole operator journey, and implementation tasks for Stage C.

Testing = yes
Logging = verbose
Documentation = yes

Objective

Make the execution host the sole executor/owner of its repository caches,
materialized workspaces, Git/CLI processes and execution filesystem effects.
An operator selects a specific eligible supervisor for a project or board launch.
Persist that choice and return the actual host and attempt in the Run view. The
selected supervisor prepares the checkout, runs the agent and checks, and returns
the result. Keep the default one-host installation simple. Plan a separately
reviewable pilot with two trusted local supervisors and disjoint storage. The
first delivery must work with one explicitly selected supervisor. Completing
the pilot is required before advertising simultaneous multi-host support.

Current baseline and prerequisite evidence

Starting evidence on 2026-11-23: master at 271ec245d. Record the actual
planning SHA and verify the following through normal entry points:

- web/lib/execution-host/placement.ts defaults to localHost(). The registrar,
  the active local_direct DB constraint and the single MAISTER_SUPERVISOR_URL
  resolve one host. Replacing its URL can retire the previous identity.
- Web creates worktrees and runs CLI steps locally. Supervisor adoption checks
  real paths and linked Git metadata. Inventory current preparation claims and
  recovery in web/lib/agents/preparation-resource.ts and
  docs/system-analytics/agent-preparation.md before designing remote effects.
- Stage A/B already provides host identity, assignment epochs, command receipts,
  durable event replay and runtime objects. The admin execution-host screen
  already reports status. Reuse these contracts and the existing board launch.
- Inspect feature/isolated-execution-host separately if available (reviewed at
  4554e33ae). Check isolation, workload dispatch and Git protections by workload
  class and actual caller. Mark reusable prerequisites and branch-only changes.
  Qualification of a diagnostic command does not establish board Run execution.

Read:
- .ai-factory/reviews/stage-ab-execution-host-audit-2026-09-05.md
- .ai-factory/plans/stage-ab-stabilization.md and .ai-factory/plans/codex-stage-ab-ci-r9.md
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
- Stage D delivers trusted, easy enrollment and connectivity for physical hosts.
  Include its contracts in the architecture now. Schedule its implementation separately.

Target architecture and boundaries

Trace these interactions in the plan with component ownership, a command/event
sequence and a failure sequence. Identify what ships in Stage C, what Stage D
must add and what a future workload backend can implement independently.
Include one deployment diagram for the three topologies and a compact interaction
table covering initiator, peer, identity, authorization, durable owner, payload
and recovery on lost reply. Recommend one design for each boundary, record the
trade-offs and name the existing MAIster contract to extend.

1. Board -> Web -> placement. Web authorizes the user's project and host choice,
   records the requested host and reserves an attempt on its persistent host ID.
   Make the binding survive queueing, approval and retry. If a pinned host is
   asleep, draining, full, revoked or incompatible, show why work is waiting
   or refused. Moving work requires an authorized new placement and a viable
   workspace. Keep personal developer hosts private until explicitly granted
   to particular users/projects. Define who can pair, share, select and revoke.
2. Web <-> supervisor. Route typed commands, receipts, cancellation, heartbeat,
   events, replay and object reads by host identity across connection changes.
   For Stage C use trusted local endpoints. For Stage D design the operator
   experience from a clean laptop: install/start the supervisor, point it at
   https://app.imaister.dev (an example Web origin), approve pairing in that
   Web instance and see the host become available on the board. Show a proposed
   CLI invocation, for example `maister supervisor connect --web https://app.imaister.dev`
   (proposed syntax), with the corresponding UI and status/error states.
   Explain installation, starting on login, and how the host owner
   limits local capacity, pauses new tasks and disconnects the machine. Prefer an
   outbound authenticated connection over HTTPS/WSS that works behind NAT
   with no inbound laptop port or hand-maintained SSH tunnel. Specify short-lived
   single-use pairing approval, instance and user binding, host key storage,
   rotation, revoke/unpair, reconnect after sleep and command deduplication.
   Distinguish transport authentication from permission to run a project.
3. Supervisor -> Git source and execution backend. Fetch the authorized commit
   into a private per-host repository cache, create the worktree locally and
   mount approved inputs. A later Run requesting a new SHA must fetch it while
   an active Run retains its own revision and edits. For a Web-local repository
   specify an explicit authorized transfer of a verifiable snapshot or a clear
   refusal with a way to supply a reachable Git source. Identify where private
   Git/provider credentials live. Scope MCP access to the Run and the correct
   Web origin; inspect web/lib/agents/facade-launch.ts and the API base URL
   issued by web/lib/agents/launch.ts for manager-local executable/path assumptions.
4. Execution backend -> supervisor -> Web. Define where workspace, processes,
   limits, cancellation, exit, evidence and cleanup belong. Implement the host
   process backend in Stage C using existing mechanisms. Show how a future
   supervisor could execute ACP and checks in Kubernetes Pods/Jobs: map
   host ID, assignment epoch and attempt to workload UID, storage lifetime,
   scoped credentials, resource limits, log/artifact capture, cancellation and
   reconciliation after a Pod or supervisor restart. Keep the Kubernetes API
   behind the supervisor. A reconnecting laptop and a replaced Pod are distinct
   lifecycle events. Kubernetes deployment and cloud provisioning are future work.

Use the existing competitor research as design input and refresh any changed
mechanisms against primary sources. Compare the direction of the connection,
runtime identity, who owns the working tree, who can assign work, and what
survives disconnection. For each comparison state the choice for MAIster:
- Herdr's persistent session server and remote client attachment: https://herdr.dev/tui/docs/how-to-work/
- Maestro's agent-to-SSH-remote selection: https://github.com/RunMaestro/Maestro/blob/main/docs/cli.md
- Multica's per-machine daemon, runtimes and sharing: https://multica.ai/docs/daemon-runtimes

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

Inspect when each normal, agent and recovery entry point reserves the Run and
workspace relative to addWorktree. Reuse its durable preparation/operation
identity before the host effect, then specify dispatch, result application and
orphan cleanup. Resolve any pre-admission ownership gap in the existing ledger.

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

Introduce host-addressed transport and explicit selection for the first
selected-host Run. Bootstrap one default host without enrollment/UI setup.
For the two-host pilot, configure two trusted endpoints with independent
identities and remove the singleton storage constraint through a migration.
Explain how staging and version negotiation prevent old singleton writers
from retiring or misaddressing either host during upgrades.

Define registry identity versus boot/incarnation, readiness versus liveness,
draining versus unavailable/retired, capability snapshots and freshness.
Host heartbeat is distinct from ACP child heartbeat.

Define deterministic placement, eligibility, per-host capacity, pending reasons,
fairness and atomic capacity reservation. Include concurrent manager workers,
capacity release, shared workspace affinity, capability loss and drain:
no new placement while draining; preserve existing permitted work.

Pin the Run and its writer claim across stale heartbeat, partitions, and Web
or Supervisor restart. Before releasing ownership for an explicit retry,
require positive quiescence from the owning host for the exact assignment epoch
and its outstanding process and command obligations.

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
quiescence witness, stale rejection, host heartbeat age, drain progress,
placement decisions/queue age, per-host capacity, GC preservation and failures.

Do not log source/prompt/evidence bodies, secrets or raw private paths.
Keep the current UI functional: actionable unavailable/capacity/drain/recovery
states, safe artifact links, and correct run/workspace status after asynchronous
commands. Preserve EN/RU and current UI conventions where changed.
Stage C needs a board launch or project control to select an eligible host,
the selected host on the Run, and a visible reason when it cannot start.
Extend the current admin diagnostics with per-host status for the pilot.
Design the later pairing, sharing and revoke UI in the remote-host stage.

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

Use separate acceptance gates. Identify the smallest shippable Stage C slice
and the additional requirements for declaring the local pilot successful.

G1: Ownership cut works on one host.
- Launch a real project task from the board targeting a configured supervisor.
  Verify its stable ID and assignment in the Run and on the host. Start with an
  empty host cache, fetch the approved SHA, run ACP and a project check there,
  then read the diff, evidence and terminal result in Web. Change the upstream
  revision and prove a new Run uses the new pinned SHA.
- Web has no OS access to host repository/worktree/runtime roots.
- Launch/materialization, CLI/check, agent work, evidence, checkpoint, HITL
  resume/cancel/complete, diff/sync/promotion/archive/GC all work through contracts.
- Existing local histories and workspace modes remain usable.
- Post-run Git/GC works after execution assignment release.
- Duplicate commands and lost ACKs do not repeat side effects or lose ownership.

G2: Two isolated local hosts work after G1.
- Pin one board Run to B while A continues to accept other work. Capture the
  command/process owner for a representative feature build on B, resource
  accounting there and its result in Web. Disconnect B after command acceptance,
  reconnect it and verify one effect. A pinned Run must never build on A by accident.
- Separate roots and SQLite identity/outbox stores; no shared repository/runtime
  filesystem and no web access to either private root.
- Capability/capacity placement and shared-worktree affinity choose legal hosts.
- Concurrent admissions cannot exceed capacity or create two workspace writers.
- Drain, stale heartbeat, partition, host restart and web restart behave as specified.
- Heartbeat timeout keeps the original writer claim. Late ACKs and old epochs cannot mutate current state or repeat effects.
- No cross-host ACP resume claim; recovery uses explicit new-attempt boundaries.
- Re-run G1 and A/B durability/deferred-release tests without regression.

Future acceptance (design now, run in the corresponding delivery stage):
- Remote developer host: Web and the existing supervisor run on A. A developer
  connects a macOS laptop or Linux host B from a different network to the same
  Web instance. An authorized user assigns a board task to B. B builds the pinned
  revision on its own disk. Web receives live progress, diff and verified results.
  Exercise denied project access, sleep/reconnect and revocation. Record the
  instance, host identity and attempt that produced the evidence. A local pilot
  cannot qualify this network and trust boundary.
- Container backend: run one board task via a supervisor-managed Pod with the
  same Web contract. Verify workspace continuity or explicit new-attempt recovery,
  enforce resource limits, cancel and clean up. Specify this test in the design.

Evaluate these dependency-ordered increments:
 C0. Record the target architecture, trust boundaries, contracts and test topology.
 C1. Materialize pinned repositories/workspaces on a selected host.
 C2. Dispatch CLI/checks and materialize approved inputs there.
 C3. Move Git, checkpoint, sync, promotion and cleanup under workspace ownership.
 C4. Wire explicit board selection and host-addressed dispatch end to end,
     migrate existing single-host data and qualify G1.
 C5. Extend registry, liveness, drain and addressed transport to two local hosts.
 C6. Enforce per-host capacity, affinity and positive quiescence before retry.
 C7. Qualify the local pilot (G2) and document remaining remote delivery work.

Adjust this sequence based on actual dependencies. Keep workstreams and acceptance
independently verifiable; no phase can depend on an undocumented later fix.

Required documentation:
OpenAPI web/supervisor, AsyncAPI events, typed error taxonomy, architecture,
supervisor, deployment/configuration, database schema/ERD, relevant system analytics
(repository/workspace/materialization/Git/CLI/placement/liveness/recovery/GC),
and an ADR with the next available number at implementation time.
Include complete requirements-to-enforcement-to-test traceability, a risk register,
two-phase side-effect failure tables and a coherent commit plan.

Keep public relay infrastructure, fleet provisioning, object storage deployment,
live cross-host ACP migration and multi-repository orchestration outside Stage C.
Preserve existing context-repository support.

Output one English implementation plan with the target architecture, a Stage C
task/commit sequence, separately labelled pilot, and explicit handoffs for
remote enrollment and a container backend. For each handoff give the contract
provided by C, the open decision and the end-to-end acceptance test. Stop at
the planning artifact. Live pairing and execution are future operator actions.
```
