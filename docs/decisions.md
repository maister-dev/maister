# Architectural Decisions

> **Purpose.** This file is the single source of truth for every locked
> architectural and technical decision in MAIster. Every entry is an ADR
> — Architectural Decision Record — that captures *why* the project does
> something a particular way, what was rejected, and at what cost.
>
> **When to add an ADR.** During feature discussion, modeling, or
> documenting. If a code-level discussion turns into a tradeoff that
> shapes more than one component, lift the answer into an ADR before
> writing the code.
>
> **Editing rules.**
>
> - Numbering is sequential and **immutable**. Never reuse a number.
> - Once an ADR is `Accepted`, you do not edit its body. To change
>   direction, write a **new ADR** that supersedes it and set the old
>   one's `Status` to `Superseded by ADR-XXX`.
> - One decision per ADR. If you feel a need for "ADR-007a" / "ADR-007b",
>   split into two ADRs.
> - The template lives at the bottom. Copy it verbatim.

---

## Index

| # | Title | Status | Date |
| - | ----- | ------ | ---- |
| [ADR-001](#adr-001-nextjs-16--heroui-v3-as-the-web-stack) | Next.js 16 + HeroUI v3 as the web stack | Accepted | 2026-05-22 |
| [ADR-002](#adr-002-supervisor-runs-as-a-separate-node-daemon) | Supervisor runs as a separate Node daemon | Accepted | 2026-05-25 |
| [ADR-003](#adr-003-acp-as-the-agent-runtime-protocol) | ACP as the agent runtime protocol | Accepted | 2026-05-25 |
| [ADR-004](#adr-004-multi-runner-claude--codex-on-current-target) | Multi-executor: claude + codex on current target | Accepted | 2026-05-25 |
| [ADR-005](#adr-005-model-routing-env-router-default-ccr-optional) | Model routing: env-router default, CCR optional | Accepted | 2026-05-25 |
| [ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume) | Hybrid HITL: keep-alive + checkpoint/resume | Accepted | 2026-05-25 |
| [ADR-007](#adr-007-sse-pipe-to-disk-for-step-output) | SSE pipe-to-disk for step output | Accepted | 2026-05-22 |
| [ADR-008](#adr-008-typed-error-taxonomy-maistererror) | Typed error taxonomy (`MaisterError`) | Accepted | 2026-05-22 |
| [ADR-009](#adr-009-global-concurrency-cap--3) | Global concurrency cap = 3 | Accepted | 2026-05-22 |
| [ADR-010](#adr-010-flow-engine-v2-plugin-packaging--step-dsl) | Flow Engine v2: plugin packaging + step DSL | Accepted | 2026-05-25 |
| [ADR-011](#adr-011-workspace-lifecycle-via-git-worktree) | Workspace lifecycle via git worktree | Accepted | 2026-05-22 |
| [ADR-012](#adr-012-local-promotion-merge-policy---no-ff-abort-on-conflict) | Local promotion merge policy: `--no-ff`, abort on conflict | Accepted | 2026-05-22 |
| [ADR-013](#adr-013-postgres-16-primary-sqlite-dev-drizzle-orm) | Postgres 16 primary, SQLite dev, Drizzle ORM | Accepted | 2026-05-22 |
| [ADR-014](#adr-014-i18n-en--ru-from-day-one) | i18n: EN + RU from day one | Accepted | 2026-05-22 |
| [ADR-015](#adr-015-pnpm-workspace-node-24) | pnpm workspace, Node 24 | Accepted | 2026-05-22 |
| [ADR-016](#adr-016-mermaid-as-the-only-diagramming-language-for-docs) | Mermaid as the only diagramming language for docs | Accepted | 2026-05-26 |
| [ADR-017](#adr-017-openapi-303--asyncapi-260-as-api-contract-formats) | OpenAPI 3.0.3 + AsyncAPI 2.6.0 as API contract formats | Accepted | 2026-05-26 |
| [ADR-018](#adr-018-task--run-cardinality-is-1n) | Task ↔ Run cardinality is 1:N | Accepted | 2026-05-22 |
| [ADR-019](#adr-019-project-slug--repo_path-uniqueness-soft-archival) | Project slug + repo_path uniqueness, soft archival | Accepted | 2026-05-22 |
| [ADR-020](#adr-020-fastify--pino-in-the-supervisor) | Fastify + pino in the supervisor | Accepted | 2026-05-25 |
| [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility) | Flow package lifecycle: multi-revision, trust, and compatibility | Accepted | 2026-05-30 |
| [ADR-022](#adr-022-structured-run-data-projection--runeventsjsonl-is-the-event-log-postgres-holds-derived-read-models) | Structured run-data projection: `run.events.jsonl` is the event log, Postgres holds derived read-models | Accepted | 2026-05-30 |
| [ADR-023](#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres) | Run `web` + `supervisor` on the host; containerize only Postgres | Accepted | 2026-05-30 |
| [ADR-024](#adr-024-external-operations-surface--rest--thin-mcp-facade-project-tokens-mandatory-audit-hitl-assessment--flow-owned-escalation) | External operations surface: REST + thin MCP facade, project tokens, mandatory audit, HITL assessment, Flow-owned escalation | Accepted | 2026-05-30 |
| [ADR-025](#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots) | Project repo onboarding: URL clone or local path, host-credential auth, configurable roots | Accepted | 2026-05-31 |
| [ADR-026](#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump) | Flow graph manifest v1 (`nodes[]`) + engine version bump | Accepted | 2026-05-30 |
| [ADR-027](#adr-027-append-only-node_attempts-run-ledger) | Append-only `node_attempts` run ledger | Accepted | 2026-05-30 |
| [ADR-028](#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped) | Full-featured gate execution in M11a; M15 re-scoped | Accepted | 2026-05-30 |
| [ADR-029](#adr-029-split-m11-into-m11a--m11b--m11c) | Split M11 into M11a / M11b / M11c | Accepted | 2026-05-30 |
| [ADR-030](#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status) | Manual takeover as a local worktree handoff (`HumanWorking` status) | Accepted | 2026-05-31 |
| [ADR-031](#adr-031-node-typed-settings-schema-carve-b) | Node typed settings schema (carve (b): schema + shape-validation + visibility now; capability resolution + materialization → M14) | Accepted | 2026-06-01 |
| [ADR-032](#adr-032-settings-enforcement-refusal-boundary) | Settings-enforcement refusal boundary (declared `enforcement` intent, static `ENFORCEABILITY_BY_AGENT`, CONFIG/EXECUTOR_UNAVAILABLE, no new code) | Accepted | 2026-06-01 |
| [ADR-033](#adr-033-crash-reconciliation-model-startup--periodic-sweeper-allow-list-running-only) | Crash reconciliation model (startup + periodic sweeper, allow-list `Running`-only) | Accepted | 2026-06-01 |
| [ADR-034](#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission) | Crashed-run recovery semantics (hybrid `--resume` + re-dispatch, durable-marker-first, cap re-admission) | Accepted | 2026-06-01 |
| [ADR-035](#adr-035-graceful-workspace-gc-preserve-then-prune) | Graceful workspace GC (preserve-then-prune) | Accepted | 2026-06-01 |
| [ADR-036](#adr-036-flow-revision-gc) | Flow-revision GC | Accepted | 2026-06-01 |
| [ADR-037](#adr-037-typed-artifact-model) | Typed artifact model: `artifact_instances` is the queryable evidence index only (payloads on disk/worktree/git), closed `kind` catalog, validity FSM, M12 deferral list | Accepted | 2026-06-01 |
| [ADR-038](#adr-038-hybrid-write-path-for-artifact_instances-refines-adr-022) | Hybrid write path for `artifact_instances` (refines ADR-022): runner-inline + scoped web-side projector, deterministic-PK idempotency, per-RUN cursor, no watcher | Accepted | 2026-06-01 |
| [ADR-039](#adr-039-xyflowreact--dagrejsdagre-as-the-evidence-graph-renderer) | `@xyflow/react` + `@dagrejs/dagre` as the read-only evidence-graph renderer (sanctioned exception to "no other component lib") | Accepted | 2026-06-01 |
| [ADR-040](#adr-040-assignment-actors-and-role-owned-work-queue) | Assignment actors and role-owned work queue: Flow roles route work, actors attribute ownership, no new M13 ingress | Accepted | 2026-06-02 |
| [ADR-041](#adr-041-capability-registry-refs--agent-aware-mapping--runner-owned-native-materialization) | Capability registry refs + agent-aware mapping + runner-owned native materialization (`node_attempts.materialization_plan` ledger column, no new artifact kind, secret-channel boundary, recoverable cleanup) | Accepted | 2026-06-02 |
| [ADR-042](#adr-042-conservative-spike-gated-enforcement-flip-claude-first) | Conservative spike-gated `instructed→enforced` flip; claude-first (codex stays instructed, `permissionMode` re-run live, contract only tightens) | Accepted | 2026-06-02 |
| [ADR-043](#adr-043-capability-import-reuses-the-flow-install-fetchtrustexecute-pipeline) | Capability import reuses the flow-install fetch→trust→execute pipeline (physically separate `setup.sh`, trust route ships, path-safety) | Accepted | 2026-06-02 |
| [ADR-044](#adr-044-capability-delivery-via-settingslocaljson--acp-newsession-cli-flag-mechanism-disproven) | Capability delivery via `<worktree>/.claude/settings.local.json` + ACP `newSession` params (the ADR-041 CLI-flag mechanism was disproven against `claude-agent-acp@0.37.0`; supersedes the delivery half of ADR-041) | Accepted | 2026-06-03 |
| [ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve) | External_check enforcement via the Review chokepoint; M16/M15/M18 carve | Accepted | 2026-06-02 |
| [ADR-046](#adr-046-project-api-token-model) | Project API token model | Accepted | 2026-06-02 |
| [ADR-047](#adr-047-thin-mcp-facade-as-a-standalone-rest-client-package) | Thin MCP facade as a standalone REST-client package | Accepted | 2026-06-02 |
| [ADR-048](#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15) | Readiness enforcement over all blocking gate kinds + verdict calibration (M15) | Accepted | 2026-06-03 |
| [ADR-049](#adr-049-pr-promotion-via-a-hybrid-provider-pradapter-credential-model-b-reverses-the-gh-is-never-invoked-invariant) | PR promotion via a hybrid provider `PrAdapter` (credential model B); reverses the "gh is never invoked" invariant | Accepted | 2026-06-03 |
| [ADR-050](#adr-050-platform-acp-runners-adapter-provisioners-and-router-sidecars) | Platform ACP runners, adapter provisioners, and router sidecars | Accepted | 2026-06-03 |
| [ADR-051](#adr-051-flow-graph-layout-metadata-store-project-scoped-flow_id-keyed) | Flow-graph layout metadata store (project-scoped, `flow_id`-keyed) | Accepted | 2026-06-05 |
| [ADR-052](#adr-052-live-node-status-coloring-via-sse-triggered-graph-status-refetch) | Live node-status coloring via SSE-triggered `graph-status` refetch | Accepted | 2026-06-05 |
| [ADR-053](#adr-053-workbench-file-tree-git-tracked-only-member-gated-reads) | Workbench file-tree: git-tracked-only, member-gated reads | Accepted | 2026-06-05 |
| [ADR-054](#adr-054-hitl-assessment-taxonomy--flow-declared-criticality-vs-responder-human_confidence-annotate-not-re-gate) | HITL assessment taxonomy — flow-declared `criticality` vs responder `human_confidence`, annotate-not-re-gate | Accepted | 2026-06-05 |
| [ADR-055](#adr-055-hitl-response-service--hitl-over-mcp--token-actor--actor-kindscope-auth-gates) | HITL response service + HITL-over-MCP + token-actor + actor-kind/scope auth gates | Accepted | 2026-06-05 |
| [ADR-056](#adr-056-flat-runner-on_rejectgoto_step-atomic-execution--single-tx-repark-dedicated-comments-channel-window-sentinel-invalidation) | Flat-runner `on_reject.goto_step` atomic execution — single-tx repark, dedicated comments channel, window-sentinel invalidation | Accepted | 2026-06-05 |
| [ADR-057](#adr-057-hitl-hybrid-surface-composition--cross-project-inbox-block-inline-response-component-numeric-needs-you-n-badge) | HITL hybrid-surface composition — cross-project Inbox block, inline response component, numeric "Needs you (N)" badge | Accepted | 2026-06-05 |
| [ADR-058](#adr-058-branch-targeting-at-launch-shared-promotion-service-promote-time-readiness-re-gate-m18m15-carve) | Branch targeting at launch, shared promotion service, promote-time readiness re-gate (M18/M15 carve) | Accepted | 2026-06-03 |
| [ADR-059](#adr-059-read-only-observatory-formulas-and-harvest-priority) | Read-only Observatory formulas and harvest priority | Accepted | 2026-06-05 |
| [ADR-060](#adr-060-unified-scheduler-clock-and-polymorphic-job-budgets) | Unified scheduler clock and polymorphic job budgets | Accepted | 2026-06-05 |
| [ADR-061](#adr-061-local-authored-capability-catalog-lifecycle) | Local authored capability catalog lifecycle | Accepted | 2026-06-05 |
| [ADR-062](#adr-062-platform-user-administration--project-member-management-admin-surface-carve) | Platform user administration + project member management (admin-surface carve) | Accepted | 2026-06-07 |
| [ADR-063](#adr-063-structured-node-output-channel-p1--run-context-file-p7) | Structured node output channel (P1) + run-context file (P7) | Accepted | 2026-06-07 |
| [ADR-064](#adr-064-authored-flow-graph-layout-in-the-flowyaml-presentation-section) | Authored flow-graph layout in the flow.yaml presentation section | Accepted | 2026-06-07 |
| [ADR-065](#adr-065-platform-acp-runner-crud-in-settings--hard-delete-blocked-by-any-usage-reference) | Platform ACP runner CRUD in `/settings` — hard delete blocked by any usage reference | Accepted | 2026-06-08 |
| [ADR-066](#adr-066-editor-and-diff-rendering-stack-shiki-git-diff-view-codemirror) | Editor and diff rendering stack (Shiki, git-diff-view, CodeMirror) | Accepted | 2026-06-08 |
| [ADR-067](#adr-067-flow-editor-write-path--canvas-edits-as-m25-authored-flow-drafts-with-hard-gate-before-persist) | Flow editor write path — canvas edits as M25 authored flow drafts with hard-gate before persist | Accepted | 2026-06-08 |
| [ADR-068](#adr-068-authoredexecutable-flow-bridge--two-axis-trust-gate-supersedes-adr-061-publish-boundary) | Authored→executable flow bridge + two-axis trust gate (supersedes ADR-061 publish boundary) | Accepted | 2026-06-08 |
| [ADR-069](#adr-069-version_binding-pinnedlatest--resolve-at-launch--unified-resolved-set-snapshot) | `version_binding` (pinned\|latest) + resolve-at-launch + unified resolved-set snapshot | Accepted | 2026-06-08 |
| [ADR-070](#adr-070-mcp--capability-management-model--3-scope-identity-local-first-precedence-platform-storage-setup-time-resolve) | MCP + capability management model: 3-scope identity, local-first precedence, platform storage, setup-time resolve | Accepted | 2026-06-08 |
| [ADR-071](#adr-071-user-facing-run-schedules-on-the-m24-clock) | User-facing run schedules on the M24 clock | Accepted | 2026-06-10 |
| [ADR-072](#adr-072-pr-grade-review-comments--review_comments-table-snapshot-anchoring-runner-side-rework-compose-open-gate-guard) | PR-grade review comments — `review_comments` table, snapshot anchoring, runner-side rework compose, open-gate guard | Accepted | 2026-06-10 |
| [ADR-073](#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension) | Harness adequacy & coherence metrics (read-only Observatory extension) | Accepted | 2026-06-10 |
| [ADR-074](#adr-074-artifact-post-conditions--deterministic-mutation-sensor-on-artifact_required-gates) | Artifact post-conditions — deterministic mutation sensor on `artifact_required` gates | Accepted | 2026-06-10 |
| [ADR-075](#adr-075-flow-studio-phase-2-viewer-fork-to-authored-draft-kind-by-path-and-content-validation-severity) | Flow Studio Phase 2 viewer, fork-to-authored-draft, kind-by-path, and content-validation severity | Accepted | 2026-06-11 |
| [ADR-076](#adr-076-acp-runner-model-discovery-resolver-on-supervisor--configured-model-application) | ACP runner model discovery (resolver-on-supervisor) + configured-model application | Accepted | 2026-06-11 |
| [ADR-077](#adr-077-outbound-webhooks-generic-event-delivery-primitive-transactional-outbox--singleton-drainer) | Outbound webhooks: generic event-delivery primitive, transactional outbox + singleton drainer | Accepted | 2026-06-10 |
| [ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality) | Gate-chat at HITL pauses with three-layer workspace-neutrality | Accepted | 2026-06-11 |
| [ADR-079](#adr-079-node-workspacepolicy-execution-and-checkpoint-capture) | Node workspacePolicy execution and checkpoint capture | Accepted | 2026-06-11 |
| [ADR-080](#adr-080-node-level-retry-policy) | Node-level retry policy | Accepted | 2026-06-11 |
| [ADR-081](#adr-081-rework-session-policy-with-resume-by-default) | Rework session policy with resume-by-default | Accepted | 2026-06-11 |
| [ADR-082](#adr-082-review-diff-completeness-with-dirty-state-protocol-and-scope-switcher) | Review-diff completeness with dirty-state protocol and scope switcher | Accepted | 2026-06-11 |
| [ADR-083](#adr-083-social-board-substrate--per-project-task-numbering-typed-relations-polymorphic-actor) | Social board substrate — per-project task numbering, typed relations, polymorphic actor | Accepted | 2026-06-11 |
| [ADR-084](#adr-084-acp-adapter-families-for-gemini-cli-and-opencode) | ACP adapter families for Gemini CLI and OpenCode | Accepted | 2026-06-11 |
| [ADR-085](#adr-085-mimo-code-as-a-distinct-acp-adapter-family) | MiMo Code as a distinct ACP adapter family | Accepted | 2026-06-11 |
| [ADR-086](#adr-086-domain-event-outbox-as-the-shared-trigger-bus) | Domain-event outbox as the shared trigger bus | Accepted | 2026-06-11 |
| [ADR-087](#adr-087-multi-run-launch-cost-accounting-and-delivery-policy-surfaces) | Multi-run launch, cost accounting, and delivery-policy surfaces | Accepted | 2026-06-11 |
| [ADR-088](#adr-088-multi-flow-package-management) | Multi-flow package management | Accepted | 2026-06-12 |
| [ADR-089](#adr-089-platform-agent-catalog-with-per-agent-runner-and-a-five-source-trigger-model) | Platform agent catalog with per-agent runner and a five-source trigger model | Accepted | 2026-06-12 |
| [ADR-090](#adr-090-agent-workspace-axis-with-three-layer-read-only-enforcement-and-quarantine) | Agent workspace axis with three-layer read-only enforcement and quarantine | Accepted | 2026-06-12 |
| [ADR-091](#adr-091-flow-requirements-launch-precondition) | Flow requirements launch precondition | Accepted | 2026-06-13 |
| [ADR-092](#adr-092-flow-studio-redesign--unified-studio-ia--editable-local-package-model) | Flow Studio redesign — unified Studio IA + editable-local-package model | Accepted | 2026-06-15 |
| [ADR-093](#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons) | Project onboarding — optional `maister.yaml`, host-ambient git auth, onboarding modes, advisory clone reasons | Accepted | 2026-06-17 |
| [ADR-094](#adr-094-default-runner-materialization-honest-readiness-and-ccr-admin-lifecycle) | Default-runner materialization, honest readiness, and CCR admin lifecycle | Accepted | 2026-06-18 |
| [ADR-095](#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship) | Flow execution-control policy — snapshotted preset + composable autonomy axes, fail-closed, no-blind-ship | Accepted | 2026-06-20 |
| [ADR-096](#adr-096-flow-studio-phase-c--editable-local-packages-variant-b-substrate-session-lock-member-rbac-git-backed-fork) | Flow Studio Phase C — editable local packages (Variant B): substrate, session lock, member RBAC, git-backed fork | Accepted | 2026-06-20 |
| [ADR-097](#adr-097-docked-ai-authoring-assistant--project-less-scratch-at-local-package-run-m36-phase-5) | Docked AI authoring assistant — project-less scratch-at-local-package run (M36 Phase 5) | Accepted | 2026-06-20 |
| [ADR-098](#adr-098-orchestrator-engine--supervisory-node-governed-run-tree-delegation-toolset-success-gated-task-dag-idle-checkpoint-waitresume) | Orchestrator engine — supervisory node, governed run-tree, delegation toolset, success-gated task-DAG, idle-checkpoint wait/resume | Accepted | 2026-06-20 |
| [ADR-099](#adr-099-persistent-swarm-layer-2--addressable-sessions-star-routed-messaging-worktree-modes-per-agent-read-only) | Persistent swarm Layer 2 — addressable sessions, star-routed messaging, worktree modes, per-agent read-only | Accepted | 2026-06-20 |
| [ADR-100](#adr-100-delegated-child-review-settle--promoterework) | Delegated-child Review settle + promote/rework | Accepted | 2026-06-20 |
| [ADR-101](#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open) | Cost-budget governance — budget execution-policy axis, token-metered, warn-escalate-terminate ladder, fail-open | Accepted | 2026-06-22 |
| [ADR-102](#adr-102-shared-worktree-tree-level-reviewpromote-ownership) | Shared-worktree tree-level review/promote ownership | Accepted | 2026-06-21 |
| [ADR-103](#adr-103-output-driven-dynamic-routing-decide--onmismatch-rework--engine-170) | Output-driven dynamic routing (`decide`) + `on_mismatch` rework + engine 1.7.0 | Accepted | 2026-06-22 |
| [ADR-104](#adr-104-global-personal-api-tokens-via-nullable-project-token-binding) | Global personal API tokens via nullable project token binding | Accepted | 2026-06-23 |
| [ADR-105](#adr-105-first-class-authored-package-kinds-and-centralized-studio-package-model) | First-class authored package kinds and centralized Studio package model | Accepted | 2026-06-22 |
| [ADR-106](#adr-106-package-based-platform-agents--package-identity-attachment-gating-optional-flow-enrichment-and-per-agent-runner-policy) | Package-based platform agents — package identity, attachment gating, optional-flow enrichment, and per-agent runner policy | Accepted | 2026-06-23 |
| [ADR-107](#adr-107-version-adopt-launch--adopt-a-newer-central-package-cut-at-launch) | Version-adopt launch — adopt a newer central package cut at launch (M39 Stream B) | Accepted | 2026-06-25 |
| [ADR-108](#adr-108-declarative-guardrailhook-engine--universal-supervisor-acp-seam-interceptor-native-materializer-seam-and-hook-trip-hitl-escalation) | Declarative guardrail/hook engine — universal supervisor ACP-seam interceptor (3 rules), native materializer seam, `hook_trip` HITL, engine 1.8.0 | Accepted | 2026-06-23 |
| [ADR-109](#adr-109-consensus-flow-graph-node--engine-owned-unanimous-draft-verification-and-human-resolution) | Consensus flow-graph node — engine-owned unanimous draft verification and human resolution | Accepted | 2026-06-24 |
| [ADR-110](#adr-110-flow-studio-ai-assistant-read-only-acp--structured-server-applied-actions) | Flow Studio AI assistant: read-only ACP + structured server-applied actions | Accepted | 2026-06-25 |
| [ADR-111](#adr-111-generic-agent-configuration-framework--declared-config-params-per-instance-values-resolved-snapshot-prompt-injection) | Generic agent configuration framework — declared config params, per-instance values, resolved snapshot, prompt injection | Accepted | 2026-06-25 |
| [ADR-112](#adr-112-triager-agent--duplicate_offlagged-dedup-substrate-auto_launch_triaged-tick-flowrunner-discovery-no-silent-stall-guards) | Triager agent — duplicate_of/flagged dedup substrate, auto_launch_triaged tick, flow/runner discovery, no-silent-stall guards | Accepted | 2026-06-25 |
| [ADR-113](#adr-113-pr-to-source-for-local-packages--trusted-source-picker--stable-publish-branch) | PR-to-source for local packages — trusted-source picker + stable publish branch (M39 Stream B) | Accepted | 2026-06-25 |
| [ADR-114](#adr-114-unified-flow-runner-config-first-class-sessions-per-project-connect-time-bindings-and-run_sessions-as-the-sole-run-runner-source-of-truth) | Unified Flow runner config, first-class sessions, per-project connect-time bindings, `run_sessions` sole source of truth, engine 2.0.0 (M42) | Accepted | 2026-06-26 |
| [ADR-115](#adr-115-strict-template-default-operator-for-prompt-authoring) | Strict template default operator for prompt authoring | Accepted | 2026-06-28 |
| [ADR-116](#adr-116-local-package-composition-view-shared-package-bom-source-abstraction-tabbed-editor-ia) | Local-package composition view: shared package BOM source abstraction, tabbed editor IA | Accepted | 2026-06-28 |
| [ADR-117](#adr-117-reliable-cost-rollup-reconciliation-and-per-runner-cost-attribution) | Reliable cost-rollup reconciliation (sweep guarantee + fast-path consumer) + per-runner cost attribution | Accepted | 2026-06-29 |
| [ADR-118](#adr-118-rework-loop-onexhaustion-routing--human-driven-counter-reset-resettargets--engine-210) | Rework loop `onExhaustion` routing + human-driven counter reset (`resetTargets`) + engine 2.1.0 | Accepted | 2026-06-29 |
| [ADR-119](#adr-119-manual-force-relaunch-additive-concurrent-runs-per-task--atomic-attempt-number-allocation) | Manual force-relaunch (additive concurrent runs per task) + atomic attempt-number allocation | Accepted | 2026-06-30 |
| [ADR-120](#adr-120-artifact-body-injection-into-prompts) | Artifact body injection into prompts (`{{ artifacts.X.content }}` + `input.requires.inline`) + engine 2.2.0 | Accepted | 2026-06-30 |

---

### ADR-001: Next.js 16 + HeroUI v3 as the web stack

**Date:** 2026-05-22
**Status:** Accepted
**Context:** The control plane needs a rich UI with server-rendered
read pages, live updates, and a single TypeScript codebase shared with
server actions and route handlers. The audience is one solo-technical
operator on the current target; later, small teams.

**Decision:** Next.js 16 (App Router) + React 19 + HeroUI v3 (Tailwind 4)
+ `next-themes`. TypeScript strict end-to-end. No other component
libraries.

**Consequences:**

- Server Components, Route Handlers, server actions are first-class —
  no separate API server for the web tier itself.
- HeroUI ships every primitive needed (Navbar, Modal, Input, Button,
  Card). No shadcn/ui, no MUI, no hand-rolled equivalents.
- React 19 + Next.js 16 require Node 24. See [ADR-015](#adr-015-pnpm-workspace-node-24).

**Alternatives Considered:**

- **SvelteKit / Remix:** smaller ecosystem for our specific needs, no team familiarity.
- **shadcn/ui:** copy-paste model fragments the design system; HeroUI v3 ships them as a coherent library.

---

### ADR-002: Supervisor runs as a separate Node daemon

**Date:** 2026-05-25
**Status:** Accepted
**Context:** Agent processes (`claude-agent-acp`, `codex-acp`) can run
for tens of minutes per session. Holding them inside Next.js means every
HMR reload (dev) and every Next.js restart (prod) kills live runs.
Tying agent lifetimes to the web tier is operationally fragile.

**Decision:** A separate Node process — `supervisor/` — owns ACP
sessions, spawns agent processes, runs the heartbeat watcher, and
streams events via HTTP + SSE. The web tier talks to it through
`web/lib/supervisor-client.ts`. The supervisor MAY run on a different
host than the web tier.

**Consequences:**

- HMR / Next.js restarts no longer kill agents.
- Two processes to operate; both run on the host via `pnpm`, only Postgres is containerized — see ADR-023.
- The wire contract between web and supervisor is HTTP + SSE — the only
  coupling surface, documented in `api/supervisor.openapi.yaml` and
  `api/async/supervisor-sse.asyncapi.yaml`.
- Secrets and agent stdio stay inside the supervisor process; the web
  tier sees only the SSE event stream.

**Alternatives Considered:**

- **In-Next.js spawn:** the original M0 design. Killed by the HMR / restart fragility above.
- **Per-run container (Docker-in-Docker):** higher operational overhead; not justified for a single-host target.

---

### ADR-003: ACP as the agent runtime protocol

**Date:** 2026-05-25
**Status:** Accepted
**Context:** MAIster needs to support multiple coding-agent CLIs
(Claude Code, Codex, eventually Cursor / Aider) without a custom
adapter per agent. M0 spike validated that ACP — the vendor-neutral
Agent Client Protocol from `@agentclientprotocol/sdk@0.22.1` — has
adapter binaries for both targets.

**Decision:** Agent processes are launched as ACP adapter binaries:
`claude-agent-acp` (from `@agentclientprotocol/claude-agent-acp@0.37.0`,
wraps `@anthropic-ai/claude-agent-sdk@0.3.146`) and `codex-acp` (from
`@agentclientprotocol/codex-acp@0.0.44`, bundles `@openai/codex@^0.128.0`).
Supervisor spawns one adapter process per active session via
`child_process.spawn`. The wire is ACP `session/update` notifications
over stdio JSONL.

**Consequences:**

- Adding a third executor (Cursor, Aider) is "find or write the ACP
  adapter binary, add an entry to `BINARY_BY_AGENT`" — no protocol
  changes in MAIster.
- Cross-process resume works by spawning a fresh adapter and restoring the
  prior conversation via the ACP `session/resume` protocol call on the stored
  `acp_session_id`. (The M0 spike verified the round-trip with the raw CLI's
  `claude --resume <uuid>`, "ALBATROSS-42"; the ACP **adapter** does not take a
  `--resume` CLI flag — it ignores argv flags — so the supervisor uses the
  `session/resume` call (both bundled adapters advertise
  `sessionCapabilities.resume`). Using `session/new` on resume silently starts
  an empty session; corrected 2026-06-08, see `supervisor/src/acp-client.ts`.)
- Sessions persist as JSONL files at
  `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`. The agent's own
  session store IS the checkpoint — no separate checkpoint format.
- Cache key does NOT survive process boundary; each respawn costs
  ~$0.28 of cache_creation tokens. Drives [ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume) keep-alive budget.

**Alternatives Considered:**

- **Bespoke shim per agent CLI:** N×N adapter matrix. ACP collapses it to N×1.
- **MCP-only orchestration:** MCP is for tools, not session lifecycle; wrong abstraction layer.

---

### ADR-004: Multi-runner: claude + codex on current target

**Date:** 2026-05-25
**Status:** Accepted
> **Partially superseded by [ADR-050](#adr-050-platform-acp-runners-adapter-provisioners-and-router-sidecars):** the project-scoped executor-identity mechanism was replaced by the platform ACP runner catalog (`platform_acp_runners`, `runs.runner_id`); the two-runner (claude + codex) decision itself stands.
**Context:** Validating MAIster's portfolio thesis requires more than
one runner to prove the abstraction is real. M0 confirmed both ACP
adapters work and the supervisor's spawn dispatch on
runner adapter identity covers both.

**Decision:** Current target ships with **both** Claude Code AND Codex runners.
Both are required to pass success criteria. Cursor, opencode,
Aider, and OpenHands are Phase 2 runner candidates.

**Consequences:**

- The platform ACP runner catalog is real, not a placeholder. The resolution
  chain (launch override -> Flow step target -> project Flow default ->
  platform Flow default -> project default -> platform default) gets exercised
  end-to-end.
- Per-step runner target/remap is verified on at least one Flow in
  acceptance.
- Adding a third agent is Phase 2 work.

**Alternatives Considered:**

- **Single executor (Claude only):** the original M0 plan. Rejected because it postpones the most architecturally informative test (does the abstraction hold?).

---

### ADR-005: Model routing: env-router default, CCR optional

**Date:** 2026-05-25
**Status:** Accepted
> **Partially superseded by [ADR-050](#adr-050-platform-acp-runners-adapter-provisioners-and-router-sidecars):** the env-router-default / CCR-optional decision stands, but the config surface moved — `maister.yaml` no longer carries `executors[]`/`router: ccr` (now `z.never()` in config.schema.ts); CCR is a platform router sidecar.
**Context:** Users want to route their Claude session through
third-party Anthropic-API-compatible providers (z.ai GLM, OpenRouter,
anyscale). M0 verified that setting `ANTHROPIC_BASE_URL` +
`ANTHROPIC_AUTH_TOKEN` in the spawned process env is sufficient for
single-provider routing.

**Decision:** Two modes:

1. **env-router** (default, no extra dependency): set
   `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in
   `executor.env` inside `maister.yaml`.
2. **CCR** (`router: ccr`): bundle
   `@musistudio/claude-code-router@2.0.0` (MIT) for intelligent
   multi-provider routing within one session. Opt-in per executor.

**Consequences:**

- The default path has zero extra dependencies. Simplest hot path stays simple.
- CCR is opt-in, marked `router: ccr` on the executor row.
- `executor.env` from `maister.yaml` overlays on top of the supervisor's
  process env; per-executor secrets always win (see `supervisor/src/spawn.ts`).

**Alternatives Considered:**

- **CCR-only:** unnecessary dependency for the common single-provider case.
- **Build a router ourselves:** scope creep; both alternatives above are mature.

---

### ADR-006: Hybrid HITL: keep-alive + checkpoint/resume

**Date:** 2026-05-25
**Status:** Accepted
> **Amended by [ADR-081](#adr-081-rework-session-policy-with-resume-by-default) (2026-06-11):** rework `session_policy: resume` and idle gate-chat resume ([ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality)) reuse this keep-alive + `session/resume` path.
**Context:** Human review is slow (minutes to hours). Holding a Claude
process in memory for the entire review wastes RAM; killing it
immediately wastes ~$0.28 of cache_creation tokens on respawn (M0).
Neither extreme works.

**Decision:** Hybrid lifecycle in three phases:

1. **Keep-alive window** — when a run enters `NeedsInput`, the ACP
   session stays live for `MAISTER_KEEPALIVE_MINUTES` (default 30).
   Each user activity on the run page (open / focus / form keystroke)
   bumps `keepalive_until` by another 30 min.
2. **Graceful checkpoint** — when `now > keepalive_until`, supervisor
   asks the agent to exit gracefully (the agent persists its own JSONL
   session store). Run state → `NeedsInputIdle`. `runs.acp_session_id`
   is the resume handle.
3. **Resume via `session/resume`** — when the user responds, the supervisor
   spawns a fresh adapter process and restores the prior conversation with the
   ACP `session/resume` call on `<session-id>` (no history replay; not a CLI
   flag; both bundled adapters advertise `sessionCapabilities.resume`).

**Consequences:**

- An active human review never times out mid-thought.
- An abandoned tab releases memory within 30 min and accepts the $0.28
  respawn cost on return.
- 24h in `NeedsInputIdle` without response → run `Abandoned`, task
  returns to Backlog.
- `MAISTER_KEEPALIVE_MINUTES` is the cost lever for ops.

**Alternatives Considered:**

- **Always keep alive:** unbounded memory, no cost cap.
- **Always checkpoint immediately:** every NeedsInput pays the cache-creation cost on resume.
- **Custom checkpoint format:** M0 proved the agent's JSONL store survives kill; no need.

---

### ADR-007: SSE pipe-to-disk for step output

**Date:** 2026-05-22
**Status:** Accepted
**Context:** A Claude run can produce >10 MB of stdout per step.
Holding that in memory in either the supervisor or the web tier risks
OOM. Browsers reconnecting via `Last-Event-ID` also need a durable
event log to replay from.

**Decision:** Supervisor writes every child stdout line to
`.maister/<project-slug>/runs/<run-id>/<step-id>.log` via
`fs.createWriteStream` **in parallel** with the SSE emission to its
HTTP clients. The supervisor also appends structured session events to
`run.events.jsonl`; the Next.js Route Handler
(`/api/runs/[id]/stream`) tails that durable run log for reconnect.

**Consequences:**

- Bounded memory in both tiers.
- `Last-Event-ID` reconnect works without replaying from RAM.
- Logs survive supervisor restart — they are durable.
- Cost accounting (`cost.jsonl`) follows the same pattern.

**Alternatives Considered:**

- **In-memory ring buffer only:** the supervisor keeps a 1000-entry buffer for hot replay, but the file is the long-term truth.
- **Per-run database row per event:** wrong tool — sequential append-only fits a file better than a relational table.

---

### ADR-008: Typed error taxonomy (`MaisterError`)

**Date:** 2026-05-22
**Status:** Accepted
**Context:** UI components and the SSE bridge need to branch on
*kinds* of failures, not on `err.message`. String-matching errors is a
classic source of regressions.

**Decision:** Every domain failure throws `MaisterError extends Error`
with a discriminated `code: MaisterErrorCode` field. Codes are a
closed string union in `web/lib/errors.ts`:
`PRECONDITION | SPAWN | NEEDS_INPUT | HITL_TIMEOUT | CRASH | CONFLICT |
CONFIG | EXECUTOR_UNAVAILABLE | FLOW_INSTALL | ACP_PROTOCOL |
CHECKPOINT`. UI branches on `err.code`. The supervisor maintains its
own narrower `SupervisorErrorCode` subset and the web client translates
at the boundary.

**Consequences:**

- Adding a code is a four-step ritual (see `error-taxonomy.md` §Adding a new code).
- Exhaustiveness assertions in tests prevent silent additions.
- UI and observability can group by `code` reliably.

**Alternatives Considered:**

- **Plain `Error` + message convention:** invites string-matching bugs.
- **One class per code:** more boilerplate, no upside; the discriminated union is the modern TS pattern.

---

### ADR-009: Global concurrency cap = 3

**Date:** 2026-05-22
**Status:** Accepted
**Context:** A single host running multiple Claude / Codex processes
has finite RAM and a finite token budget. Without a cap, three
projects competing for runs would OOM the host.

**Decision:** `MAISTER_MAX_CONCURRENT_RUNS=3` by default,
env-configurable. Cap is **global** across all registered projects, not
per-project. Runs above the cap go to `Pending` and auto-start when a
slot frees. UI shows a queue position badge. No per-project override
from `maister.yaml`.

**Consequences:**

- RAM and token spend bounded predictably on a single host.
- Hard cap — operators tune via env var, not in-app config.
- Multi-host deployment in Phase 2 will revisit (probably per-host
  concurrent + a global scheduler hint).

**Alternatives Considered:**

- **Per-project cap in `maister.yaml`:** rejected — current target is single-tenant, simpler global cap covers it.
- **No cap:** OOM risk on the demo host.

---

### ADR-010: Flow Engine v2: plugin packaging + step DSL

**Date:** 2026-05-25
**Status:** Accepted
> **Extended by [ADR-026](#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump):** the linear `steps[]` DSL is superseded for execution by the graph `nodes[]` manifest; the plugin-packaging decision here stands.
**Context:** Hard-coding Flows inside MAIster ties the product release
to every Flow change. Hard-coded Flows also can't ship with their own
skills, agents, or setup scripts. Users need to add a Flow without
rebuilding MAIster.

**Decision:** Flows are **plugin bundles** — git repos with a manifest
(`flow.yaml` v1), shipped CLIs, optional `setup.sh`, skills, agents,
and a step-typed YAML DSL with four step types: `cli`, `agent`,
`guard`, `human`. Installed system-wide to
`~/.maister/flows/<id>@<tag>/` and symlinked into each consuming
project's `.maister/<slug>/flows/`. Version-pinned by git tag in the
project's `maister.yaml`.

**Consequences:**

- Adding a Flow is `git URL + tag` in `maister.yaml`. No MAIster
  rebuild.
- Tag-pinned versions give lock semantics — Flow upgrades are
  explicit.
- Trust model today: trust all internal Flow sources. Sandboxing /
  trust UI is Phase 2 (see PRODUCT_VIEW §Phase 2).
- Templating is full Mustache-style: session context, task fields,
  per-step output vars, executor metadata.

**Alternatives Considered:**

- **Hard-coded Flows:** ties product release to every Flow change.
- **Single-file YAML Flow without plugin packaging:** no place to ship `setup.sh`, skills, agent bundles.

---

### ADR-011: Workspace lifecycle via git worktree

**Date:** 2026-05-22
**Status:** Accepted
**Context:** Multiple concurrent runs on the same project must not
contend on the working tree. Cloning per run is expensive and
duplicates `.git`. Branching without isolation conflates state.

**Decision:** Every run gets a fresh `git worktree add` against the
project's parent repo, isolated under
`.maister/<project-slug>/runs/<run-id>/`. The worktree is the cwd for
the spawned agent. Per-run artifacts (logs, `needs-input.json`,
`input-<step-id>.json`, `cost.jsonl`, `session.json`) live alongside.

On Next.js + supervisor startup: reconcile `runs` table vs `git worktree
list` per project vs supervisor's live session set. Orphan `Running`
rows with no live ACP session and no checkpoint → `Crashed`, surface
"Recover or discard". A cron route GCs `Abandoned/Done` worktrees +
checkpointed sessions older than 7d across all projects.

**Consequences:**

- No working-tree contention; runs are isolated.
- One `.git` per project, shared across worktrees.
- Reconciliation on startup catches crashes from Next.js restart, supervisor restart, and host reboot.

**Alternatives Considered:**

- **Per-run `git clone`:** O(N) disk and time for every Launch.
- **Per-run branch on the main worktree:** still contends on the working tree; agents would block on each other.

---

### ADR-012: Local promotion merge policy: `--no-ff`, abort on conflict

**Date:** 2026-05-22
**Status:** Accepted
**Context:** The product needs a predictable local promotion path for clean
run branches and a safe failure mode for conflicts. Auto-resolving conflicts
in code generated by an LLM is dangerous. The original MVP assumed a hard-coded
parent `main_branch`; the current product contract generalizes that into a
selected target branch and treats local merge as one promotion mode.

**Decision:** for `promotion.mode = local_merge`, run
`git merge --no-ff <run-branch>` into the selected target branch. Conflict →
abort the merge, leave the run in `Review`, and surface "Conflict — resolve
manually" with parent repo path, run branch, target branch, and failing command.
No auto-resolve.

**Consequences:**

- Every local promotion produces a merge commit (`--no-ff`) — traceability per
  run.
- Conflict handling is a human decision; the product never overwrites human work.

**Alternatives Considered:**

- **Rebase + fast-forward:** no merge commit, harder to attribute a run to a single revision.
- **Auto-resolve conflicts:** unacceptable; LLM-generated code can quietly clobber human edits.

---

### ADR-013: Postgres 16 primary, SQLite dev, Drizzle ORM

**Date:** 2026-05-22
**Status:** Accepted
**Context:** The control plane needs a relational store for projects,
tasks, runs, workspaces, platform ACP runners, flows, HITL requests. JSON for
arbitrary fields (manifests, form schemas, env). Operators want a
single docker compose to come up.

**Decision:** Postgres 16 as the production target (Docker Compose,
named volume). SQLite supported via Drizzle dialect switch
(`DB_URL=file:./dev.db`) for ultra-light dev only — never production.
Drizzle ORM for both, SQL-flavored, JOOQ-like mental model. Migrations
generated by `drizzle-kit` into `web/lib/db/migrations/`.

**Consequences:**

- Same TypeScript schema for both dialects.
- Postgres `jsonb` for manifest / env / response payloads.
- No Prisma — different mental model, different generated client, would fight Drizzle in PRs.

**Alternatives Considered:**

- **Prisma:** different mental model, harder to drop into raw SQL.
- **SQLite only:** runs out of headroom (no `jsonb`, weaker FK enforcement) past local dev.

---

### ADR-014: i18n: EN + RU from day one

**Date:** 2026-05-22
**Status:** Accepted
**Context:** Primary operator is Russian-speaking; product audience
includes other Russian-speaking solo-CIO / solo-architect personas.
Retrofitting i18n after building EN-only is more expensive than
designing for it from the first component.

**Decision:** Every user-facing string in `web/` ships in EN + RU
message catalogs from day one. Docs in `docs/` are English only (they
are contracts for code and AI agents, both of which read English).

**Consequences:**

- Every new UI string adds a row to both catalogs.
- Component-level review must check both locales render.
- Docs stay single-language; no translation overhead there.

**Alternatives Considered:**

- **EN-only first, i18n later:** every screen would need rewriting, accumulating retrofit cost.
- **RU-only:** rules out non-RU dogfooders.

---

### ADR-015: pnpm workspace, Node 24

**Date:** 2026-05-22
**Status:** Accepted
**Context:** Two-package monorepo (`web/` + `supervisor/`) with shared
lockfile. Next.js 16 + React 19 need recent Node. `pre-commit` hook
needs a deterministic install.

**Decision:** pnpm as the single package manager (lockfile at repo
root). Node 24 as the container target. `pre-commit install` writes
the git hook on setup.

**Consequences:**

- One install command reproduces both workspaces.
- npm or yarn lockfiles would diverge from pnpm — CI rejects.
- Node 22 / 20 are not tested; do not assume compatibility.

**Alternatives Considered:**

- **npm workspaces:** weaker hoisting, slower installs.
- **Yarn berry:** less familiar to the maintainer; no upside.

---

### ADR-016: Mermaid as the only diagramming language for docs

**Date:** 2026-05-26
**Status:** Accepted
**Context:** Architecture and process diagrams need to be
version-controlled, AI-readable, and reviewable in a pull request
without specialised tooling.

**Decision:** Every diagram in `docs/` is a Mermaid fenced block
(` ```mermaid `). C4 notation (`C4Context`, `C4Container`,
`C4Component`) for the three architectural levels in
`architecture.md`. `flowchart`, `sequenceDiagram`, `stateDiagram-v2`,
`erDiagram`, `classDiagram` elsewhere. PlantUML, draw.io XML, and PNG
screenshots of diagrams are rejected.

**Consequences:**

- Diff-friendly diagrams.
- AI agents can read and update them directly.
- A diagram with rendering errors can't merge — Mermaid Live or the
  Mermaid CLI is part of the docs validation step.

**Alternatives Considered:**

- **PlantUML:** richer notation but heavier tooling and weaker GitHub rendering.
- **Excalidraw / draw.io:** binary or XML formats, not diff-friendly.

---

### ADR-017: OpenAPI 3.0.3 + AsyncAPI 2.6.0 as API contract formats

**Date:** 2026-05-26
**Status:** Accepted
**Context:** APIs and event streams must be documented as machine-checkable
contracts, not prose. The contract is the source of truth for the
surface; implementation drift is a defect.

**Decision:** HTTP/HTTPS APIs are described as **OpenAPI 3.0.3** YAML
under `docs/api/`. Event-based interactions (SSE, WebSocket, MQ) are
described as **AsyncAPI 2.6.0** YAML under `docs/api/async/`.
Third-party APIs MAIster consumes live under `docs/api/external/` —
upstream spec verbatim if published, otherwise a narrow excerpt.
Specs validate against meta-schemas before merge.

**Consequences:**

- New endpoints / events must arrive with a spec edit, or the PR is incomplete.
- OpenAPI tooling (Redocly, swagger-cli, openapi-typescript) works out of the box.
- 3.0.3 over 3.1.x because tooling support is more mature; revisit when 3.1 adoption is broader.

**Alternatives Considered:**

- **Prose-only API docs:** invites drift, can't be validated.
- **gRPC `.proto`:** wrong protocol for the web tier; HTTP/SSE is the wire.

---

### ADR-018: Task ↔ Run cardinality is 1:N

**Date:** 2026-05-22
**Status:** Accepted
**Context:** Coding agents fail. Sometimes a Flow needs to be retried
against the same task with a fresh worktree (ralph-loop pattern).
Recreating the task loses history; treating each retry as a new task
fragments the backlog.

**Decision:** A task is the user's unit of intent; a run is one
execution attempt. One task can spawn many runs over its lifetime. If
a run terminates with `Failed | Crashed | Abandoned`, the task
auto-returns to `Backlog` and the Launch button re-appears. The latest
run is the one shown on the card. Designed database UNIQUE
`(task_id, attempt_number)` on `runs` guards against duplicate
attempts. Current schema ships only `tasks.attempt_number` as a mutable
high-water mark (the `tasks_id_attempt_uq` UNIQUE on `(id,
attempt_number)` is vacuous because `tasks.id` is the PK) and uses
`ORDER BY started_at DESC LIMIT 1` for latest-run lookups.

**Consequences:**

- Retry is one click, not a re-create.
- Task history (all attempts) is queryable.
- Latest-run lookup needs an explicit index — added on `runs.task_id`.

**Alternatives Considered:**

- **One run per task (delete on failure):** loses retry history.
- **Run as the primary entity:** harder for users to think about backlog state.

---

### ADR-019: Project slug + repo_path uniqueness, soft archival

**Date:** 2026-05-22
**Status:** Accepted
**Context:** Two projects pointing at the same `repo_path` would
contend on worktrees. Two projects with the same slug would collide on
`.maister/<slug>/` paths. Hard-deleting projects loses run history.

**Decision:** `projects.slug` AND `projects.repo_path` are both
UNIQUE. Slug is derived from `project.name` (kebab-case). Archival is
soft (`archived_at` timestamp); archived `repo_path` stays reserved
against collisions. No hard delete in the current target.

**Consequences:**

- Re-registering the same repo path under a new name requires unarchiving.
- Run history is preserved across archival.
- A "delete forever" path is Phase 2.

**Alternatives Considered:**

- **Slug-only uniqueness:** two slugs could point to the same repo path and contend on worktrees.
- **Hard delete:** loses run history and breaks FK chains.

---

### ADR-020: Fastify + pino in the supervisor

**Date:** 2026-05-25
**Status:** Accepted
**Context:** The supervisor needs a minimal HTTP server with SSE
support, structured logging, and a graceful shutdown path. Express is
heavier and has no first-class TypeScript story; hono is fine but the
team has more Fastify experience.

**Decision:** Fastify for HTTP + SSE. pino for structured logging.
Graceful shutdown with `MAISTER_SHUTDOWN_GRACE_MS` budget and
`MAISTER_KILL_GRACE_MS` per child.

**Consequences:**

- Fast startup, low overhead.
- pino-pretty in dev, JSON in prod.
- SSE writes go straight to `reply.raw.write` — no middleware buffer.

**Alternatives Considered:**

- **Express:** larger, slower, weaker types.
- **Hono:** fine, but less familiar; no compelling reason to switch.

---

### ADR-021: Flow package lifecycle: multi-revision, trust, and compatibility

**Date:** 2026-05-30
**Status:** Accepted (amended by [ADR-088](#adr-088-multi-flow-package-management): a package groups multiple flow sources under one import; the per-revision model below is unchanged)
**Context:** ADR-010 packaged Flows as git-tag-pinned plugin bundles and M4
shipped the loader. But the loader stores exactly one row per
`(project_id, flow_ref_id)` (`UNIQUE` constraint) and the runner reads the
manifest from the live `flows.manifest` column. That makes upgrade, rollback,
and coexisting revisions unrepresentable, and means a future "upgrade" would
silently corrupt the manifest of any in-flight run (the run's bytes are already
pinned on disk via the content-addressed cache, but its manifest is not).
M10 needs Flow packages to be operable by a product user — installed, trusted,
upgraded, rolled back, disabled — and safe for every later milestone (M11–M16)
that ships capabilities/gates/artifacts *inside* a package.

**Decision:**

1. **Multi-revision model.** Introduce an immutable `flow_revisions` table,
   globally content-addressed by `(flow_ref_id, resolved_revision)` (the system
   cache `~/.maister/flows/<id>@<sha>/` is already shared across projects). It
   holds the manifest snapshot, `manifest_digest`, schema version, engine
   compatibility range, opaque package contract, install path, `setup_status`,
   and a **global** revision lifecycle `package_status`
   (`Discovered|Installing|Installed|Failed|Removed`). The existing `flows` row
   is repurposed as a **project enablement pointer** (`enabled_revision_id`,
   project-relative `enablement_state`
   `Installed|Enabled|UpdateAvailable|Deprecated|Disabled|Failed`,
   `trust_status`), keeping its `source/version/revision/installed_path/manifest/
   schema_version` columns as a denormalized cache of the *currently enabled*
   revision while runner recommendations remain portable manifest data.
   `runs` gains
   `flow_revision_id` (nullable FK); the runner reads the manifest + install path
   from this pinned revision, falling back to `flows.manifest` only for legacy
   rows. Authority for runtime bytes is `flow_revisions`, never the cache.
2. **Two-phase install.** `installFlowPlugin` records a `flow_revisions` row at
   `package_status='Installing'` before any disk side-effect, then flips to
   `Installed` (the AFTER-side marker) or `Failed`. Install/upgrade failures
   surface as `FLOW_INSTALL` carrying `{source, version, stage, command,
   exitStatus, output}`.
3. **Trust policy.** `local`/`file://` sources and git sources whose URL matches
   `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` are `trusted_by_policy`; everything
   else is `untrusted` until an explicit per-(project, revision) trust
   confirmation. Launch and enablement refuse untrusted revisions.
4. **Compatibility: enforce engine + schema only.** The package contract
   (declared capabilities, gates, artifacts, external ops, setup hooks) is
   *recorded and displayed* as opaque metadata in M10; only
   `SUPPORTED_FLOW_SCHEMA_VERSIONS` and the `MAISTER_ENGINE_VERSION` range
   (`compat.engine_min/max`) are enforced at enablement. Semantic validation of
   each contract element is deferred to the milestone that introduces it (M11
   graph, M12 artifacts, M14 capabilities, M15 gates).

**Consequences:**

- Multiple revisions of the same Flow coexist; upgrade installs beside the old,
  rollback flips the enablement pointer, and in-flight/completed runs keep their
  pinned revision through upgrade/rollback/disable.
- `removeRevision` is refused while any run references the revision or it is an
  enabled revision (`CONFLICT`); automatic GC stays M19.
- A schema migration (`0007`) plus a TS backfill (`backfill-flow-revisions`,
  digests need sha256 of canonical JSON) is required; existing installs are
  grandfathered as `trusted_by_policy` + `Enabled`.
- One new env var (`MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES`). No new
  `MaisterError` code — `FLOW_INSTALL` carries richer detail.

**Alternatives Considered:**

- **Keep one row, add a history table only:** leaves `flows.manifest` as live
  authority — the in-flight upgrade-corruption bug persists. Rejected.
- **Drop the denormalized `flows.*` columns entirely:** cleaner single source,
  but large churn in `resolveExecutor`/queries/launch and a heavier migration
  for marginal benefit. Rejected for surgical scope.
- **Adopt [microsoft/apm](https://github.com/microsoft/apm) (Agent Package
  Manager) as the package backend:** APM manages static agent *context*
  primitives (skills/prompts/agents/MCP) via `apm.yml` + lockfile + trust
  policy, but has no flow/step/run concept, so it cannot replace `flow.yaml`,
  the loader, or the runner. It is a standalone Python CLI whose install model
  conflicts with the web-tier/no-mandatory-Python architecture, and its
  distinctive features (content scanning, signed packages, org policy, dependency
  solver) are exactly what M10 defers. Rejected for M10; recorded as a reference
  for **M14 (scoped capability materialization)**, where a Flow's shipped
  skills/agents/MCP servers are actually installed — APM and the AGENTS.md /
  Agent Skills / MCP standards it builds on are candidates there.

---

### ADR-022: Structured run-data projection — `run.events.jsonl` is the event log, Postgres holds derived read-models

**Date:** 2026-05-30
**Status:** Accepted
> **Refined by [ADR-038](#adr-038-hybrid-write-path-for-artifact_instances-refines-adr-022):** the artifact projector (per-run cursor) is Implemented (M12).
**Context:** The UI needs a live timeline of agent tool calls and file
changes, reviewers need queryable evidence, and analytics needs cross-run
facts. Today the supervisor's ACP `session.update` payloads (`tool_call`,
`tool_call_update` carrying `diff` content) are persisted only as raw lines in
`run.events.jsonl` (ADR-007) — there is no structured, queryable projection.

**Decision:** `run.events.jsonl` is the durable, append-only,
`monotonicId`-ordered event log and the single replay source — it *is* the
"queue". A **web-side projector** consumes the supervisor event stream and
derives Postgres read-models: the M11 run ledger (node attempts, decisions,
checkpoints) and M12 typed artifacts (`diff`, `log`, …). Writes are idempotent —
`upsert` keyed on `(runId, monotonicId)` — and the projector persists a per-run
cursor so it resumes by replay after a web restart. The supervisor is
unchanged: it already owns the log; only the web tier projects. Postgres is the
source of truth for structured state because the UI, RBAC, and analytics read
it.

**Consequences:**

- One durable log, one queryable store; no new infrastructure to operate.
- Projection is replayable and crash-safe via the `(runId, monotonicId)`
  cursor — at-least-once delivery folded into idempotent upserts.
- The projector lands with M11/M12 (the ledger/artifact schema it writes to);
  this ADR fixes the shape, not the code (impl `Designed`).
- Co-located / shared-filesystem topology assumed for v1 (see ADR-023); the
  projector tails the same `.maister/` the supervisor writes.

**Alternatives Considered:**

- **Message broker (Kafka / Redis Streams / NATS):** disproportionate for a single-host, cap-3, solo-operator control plane; the jsonl log already is an ordered, durable, replayable queue.
- **A second database on the supervisor:** a second source of truth that must be reconciled into web's Postgres anyway (UI / RBAC / analytics read there); the durable-local-buffer need it would serve is already met by the jsonl log.

---

### ADR-023: Run `web` + `supervisor` on the host; containerize only Postgres

**Date:** 2026-05-30
**Status:** Accepted
**Context:** The compose stack containerized `app`, `supervisor`, and
`postgres`. But the supervisor spawns agent adapter binaries
(`claude-agent-acp`, `codex-acp`) that need host-side agent credentials
(`~/.claude`, `~/.codex`), the project repositories at arbitrary `repo_path`,
`git worktree add` on the same filesystem as the parent repo, and ACP resume
journals at `~/.claude/projects/<cwd>/<uuid>.jsonl`. The web tier likewise runs
`git worktree`, diff, and promotion against host repos. Containerizing the
agent-spawning layer forces named-volume gymnastics for `.maister/` and breaks
agent auth and arbitrary repo paths.

**Decision:** `app` and `supervisor` run as **host processes** via `pnpm`
(as `CLAUDE.md` "How to run" already documents). Only **Postgres** is
containerized, published on `127.0.0.1:5432` so the host processes connect over
loopback. The co-located / shared-filesystem assumption (host `.maister/`) is
the v1 topology ADR-022's projector relies on.

**Consequences:**

- `compose.yml` / `compose.production.yml` carry only Postgres; web +
  supervisor start with `pnpm --filter …`.
- `MAISTER_SUPERVISOR_URL` and `DB_URL` default to `localhost` for host-run.
- Sandboxing untrusted agents belongs at the **agent process** level (Phase 2),
  not at the supervisor; this ADR does not weaken that future option.
- Multi-host / fully-containerized deployment is a Phase-2 revisit (would need
  the supervisor to serve durable HTTP replay from jsonl — deferred).

**Alternatives Considered:**

- **Full containerization (prior compose):** breaks agent auth and arbitrary `repo_path`, and forces `.maister/` into a named volume detached from the host repos.
- **Per-run Docker-in-Docker:** already rejected in ADR-002; higher operational overhead, not justified single-host.

---

### ADR-024: External operations surface — REST + thin MCP facade, project tokens, mandatory audit, HITL assessment & Flow-owned escalation

**Date:** 2026-05-30
**Status:** Accepted
> **Implemented across [ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve) (carve), [ADR-046](#adr-046-project-api-token-model) (tokens), [ADR-047](#adr-047-thin-mcp-facade-as-a-standalone-rest-client-package) (MCP facade), [ADR-054](#adr-054-hitl-assessment-taxonomy--flow-declared-criticality-vs-responder-human_confidence-annotate-not-re-gate) (HITL assessment):** the reserved HITL responder field shipped as `human_confidence` (renamed from `confidence` by ADR-054).
**Context:** MAIster needs a machine-facing surface so external systems (CI,
local scripts, autonomous assistant agents) can create tasks, read the board
and run readiness, and route/answer pending HITL requests — without
piggybacking on the human Auth.js session. This must not become a second
orchestration backend or bypass the run ledger.

**Decision:** External clients integrate via **project-scoped API tokens** over
a REST API, with a **thin MCP facade over the same service layer** (MCP is a
facade — it never bypasses authorization, readiness, or ledger rules). **Every
token-attributed action is written to an audit trail**: token id, actor label,
scope, project, endpoint/tool, and result. HITL requests carry a standard
assessment — `confidence` + `criticality` (+ optional `category`, `reasons`);
`criticality` drives delivery *urgency* only, never who answers. The escalation
decision — "does a human need to answer?" — is a **Flow gate by confidence**
(M11 node settings / M15 gates), not the external actor's: an external actor is
a conduit that delivers a request to a human and relays the human's answer.
Granular token scopes are deferred — v1 issues a token that authorizes the full
project API; the scope taxonomy (board-card create, HITL pull/respond,
flow-completion notification, …) is defined once concrete external consumers
exist. Refines ROADMAP M16; the assessment standard aligns with M15 structured
verdicts and the typed taxonomy of ADR-008.

**Consequences:**

- An external agent can read the board and deliver/relay HITL answers; the
  human (or the Flow) remains the decider.
- Audit attribution is mandatory for every external call — no anonymous writes.
- HITL gains `confidence` / `criticality` fields (small schema add, M15-aligned).
- Impl is `Implemented` (M16, 2026-06-02), largely independent of M11/M12 but sequenced after
  the foundation.

**Alternatives Considered:**

- **External actor auto-answers human review gates:** defeats the gate's purpose; only confidence-thresholded auto-proceed *inside the Flow* is allowed.
- **MCP as a second orchestration backend:** must be a thin facade over the same services and audit, or it forks the control plane.
- **Full-project-only tokens:** too coarse once external task/run/gate/HITL consumers exist; scoped tokens keep the default broad `*` compatibility path while allowing least-privilege automation.

---

### ADR-025: Project repo onboarding — URL clone or local path, host-credential auth, configurable roots

**Date:** 2026-05-31
**Status:** Accepted
**Context:** Project registration today requires a pre-existing local
`repo_path` (`web/lib/config.schema.ts`); the operator must clone the repo onto
the host first. For smoother onboarding (and the external-installation goal)
MAIster should accept a git URL and clone it itself — for GitHub, GitLab, and
Gitea-family hosts (incl. GitVerse) — while never becoming a holder of git
provider secrets: the control plane already spawns code-modifying agents, so
push-capable credentials at rest would widen the blast radius dramatically.

**Decision:** Project source is a union: a registration-time **`repo_url`**
(Add-Project field / CLI) OR an existing local **`repo_path`**. `maister.yaml`
lives in the repo, so `repo_path` becomes optional/derived. Resolution: if the
target directory exists, use it (no clone — existing repos are never
re-cloned); otherwise `git clone <repo_url>` into `<MAISTER_REPOS_ROOT>/<slug>`,
then read `<clone>/maister.yaml` and register. **Auth is host-credential only
(model B):** clone/fetch/push run as the `maister` OS user using the host's
`~/.ssh` keys or git credential helper — MAIster stores no provider secrets.
Provider is auto-detected from the URL host into a metadata tag
(`github | gitlab | gitea | gitverse | generic`; GitVerse is Gitea-family) used
for future PR-mode (M18) and web links; cloning itself is provider-neutral. Two
configurable roots (env now, settings UI later): `MAISTER_REPOS_ROOT`
(default `~/.maister/repos`) and `MAISTER_WORKTREES_ROOT`
(default `~/.maister/worktrees`); the Flow cache stays at `~/.maister/flows`.
All git operations (worktree, flow-finish merge, optional commit) remain local,
provider-neutral git against the resolved path. Scheduled as ROADMAP M21;
independent of M11/M12.

**Consequences:**

- One onboarding path covers URL-clone and pre-existing local repos; existing
  repos are never force-re-cloned.
- Zero provider secrets at rest in MAIster — same trust model as today; the OS
  owns the credentials. `known_hosts` must be seeded for SSH (deploy guide).
- Per-project least-privilege credentials are NOT possible under model B (all
  clones share the host identity); managed per-project credentials (model C) are
  a separate, security-reviewed capability shared with M18 push/PR — deferred.
- New `projects` columns (`repo_url`, `provider`) + a config-schema union; the
  worktree path builder reads `MAISTER_WORKTREES_ROOT`.

**Alternatives Considered:**

- **Local `repo_path` only (status quo):** secure and simple but a manual clone step; kept as a supported mode, not the only one.
- **MAIster-managed per-project credentials (model C):** per-project least privilege, but secret-at-rest, rotation, audit, and blast-radius make it a deliberate security design tied to M16/M18, not a registration add-on.
- **Single unified `MAISTER_HOME` root:** rejected to avoid refactoring the hardcoded `~/.maister/flows` path; two explicit roots chosen instead.

---

### ADR-026: Flow graph manifest v1 (`nodes[]`) + engine version bump

**Date:** 2026-05-30
**Status:** Accepted
> **Amended by [ADR-079](#adr-079-node-workspacepolicy-execution-and-checkpoint-capture) (2026-06-11):** `MAISTER_ENGINE_VERSION` bumped `1.3.0 → 1.4.0`; the new DSL keys `retry_policy` ([ADR-080](#adr-080-node-level-retry-policy)) and `session_policy`/`defaults` ([ADR-081](#adr-081-rework-session-policy-with-resume-by-default)) require `compat.engine_min ≥ 1.4.0`.
**Context:** [ADR-010](#adr-010-flow-engine-v2-plugin-packaging--step-dsl)'s
step DSL is **strictly linear** — the runner walks `steps[]` in order and
`on_reject.goto_step` is parsed and validated but never executed, so
review-driven rework does not work. M11 needs a validated Flow **graph** with
node lifecycle, gates, and a rework loop, without orphaning every installed Flow
package (a `schemaVersion` bump re-pins everything) or breaking simple linear
Flows.

**Decision:** Keep the manifest at `schemaVersion: 1`. Add an **optional
top-level `nodes[]`**, mutually exclusive with `steps[]` (zod `.refine`: exactly
one present — which requires relaxing the currently-required
`steps: z.array(...).min(1)` to optional). Node types are
`ai_coding | cli | check | judge | human`, each with `input.requires?`,
`output.produces?`, a type-specific `action`, `pre_finish.gates?`,
`finish.human?`, `transitions` (decision→nodeId), and `rework?`
(`allowedTargets[]`, `workspacePolicies[]`, `maxLoops`, `commentsVar`). Graph
flows MUST declare `compat.engine_min: 1.1.0`. Bump the engine constant
`MAISTER_ENGINE_VERSION` `1.0.0 → 1.1.0` in
`web/lib/flows/engine-version.ts` — it is a **code constant, not an env var**
(no compose/`.env` wiring). `SUPPORTED_FLOW_SCHEMA_VERSIONS` stays `[1]`.

**Consequences:**

- Linear `steps[]` flows are untouched and need no graph syntax; they compile to
  default single-action nodes (see [ADR-027](#adr-027-append-only-node_attempts-run-ledger)).
- A graph flow on an engine `< 1.1.0` is refused at enablement by the existing
  [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
  `compat.engine_min/max` check — no new gate needed.
- No `schemaVersion` bump means no forced re-pin of installed packages.
- The engine bump is a code constant: **no new env var, port, or deployment
  touchpoint** in M11a.

**Alternatives Considered:**

- **Bump `schemaVersion` to 2:** orphans every installed Flow package and forces
  a re-pin; the graph is additive, so the schema version need not move. Rejected.
- **A separate graph-manifest file alongside `flow.yaml`:** two sources of truth
  for one Flow. Rejected.

---

### ADR-027: Append-only `node_attempts` run ledger

**Date:** 2026-05-30
**Status:** Accepted
> **Amended by [ADR-079](#adr-079-node-workspacepolicy-execution-and-checkpoint-capture) / [ADR-080](#adr-080-node-level-retry-policy) / [ADR-081](#adr-081-rework-session-policy-with-resume-by-default) (2026-06-11):** adds ledger columns `checkpoint_ref`, `session_policy`, `session_fallback`, and `auto_retry` (migration 0041).
**Context:** The current `step_runs` table reuses the same row on resume and
hard-codes `attempt = 1`, so there is no append-only execution history. A rework
loop re-runs nodes; templating must resolve `steps.<id>.output` to the **latest**
attempt; an audit trail must never be mutated. None of this is expressible by
overwriting one row per step.

**Decision:** Introduce a new **append-only `node_attempts`** table. `attempt`
auto-increments per `(run_id, node_id)` with `UNIQUE (run_id, node_id,
attempt)`. Linear `steps[]` flows compile to nodes and write `node_attempts`
too. `step_runs` is **retained for back-compat reads and migration only** — the
graph runner writes `node_attempts`, and templating
`steps.<id>.output`/`.vars`/`.exitCode` reads from `node_attempts`
(highest-attempt-wins), falling back to `step_runs` for legacy rows. A pre-M11a
in-flight `NeedsInput` run that has `step_runs` rows but no `node_attempts` seeds
its resume entry from the latest `step_runs` row for `current_step_id` (the
compiled-linear node id ≡ the step id). `node_attempts.status` uses the PascalCase
node-lifecycle vocabulary (`Pending | Running | Succeeded | Failed | NeedsInput |
Reworked | Stale`).

**Consequences:**

- Every node execution is an immutable ledger row; rework never mutates prior
  rows; the full attempt history is queryable.
- `step_runs` enters gradual deprecation — legacy-read only, no new writes from
  the graph runner.
- Templating must union both tables (highest-attempt `node_attempts`, else
  `step_runs`) during the deprecation window.
- Adds migration `0010`; the change is additive (existing rows unaffected).

**Alternatives Considered:**

- **Add an `attempt` column to `step_runs` and mutate in place:** loses
  immutability and makes highest-attempt-wins a row-overwrite race. Rejected.
- **Drop `step_runs` entirely and backfill `node_attempts`:** breaks legacy
  resume of in-flight runs and forces a heavier, riskier migration for marginal
  benefit. Rejected — deprecate gradually instead.

---

### ADR-028: Full-featured gate execution in M11a; M15 re-scoped

**Date:** 2026-05-30
**Status:** Accepted
> **Delivered:** the M15 re-scope landed in [ADR-048](#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15); `external_check` execution in [ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve).
**Context:** Review-driven rework is only demonstrable if gates actually
execute, go **stale** on rework, and **rerun** — a status lifecycle plus
structured verdicts, not metric-only guards. The roadmap originally assigned
gate *execution* to M15. The user directed (this session) that M11a ship
**real, full-featured** gates within its dependency limits.

**Decision:** A node's `pre_finish.gates` execute by kind, each recorded in a
`gate_results` row. `command_check`, `ai_judgment`, and `human_review` **fully
execute**. `skill_check` runs a slash command via an agent session
(**best-effort, no capability scoping** until M14). `artifact_required` and
`external_check` are **schema-valid and status-modelled but NOT executed** in
M11a (they depend on M12 artifact instances and M16 ops ingestion respectively).
The gate status lifecycle is
`pending | running | passed | failed | stale | skipped | overridden` (lowercase,
distinct from the PascalCase node lifecycle in
[ADR-027](#adr-027-append-only-node_attempts-run-ledger)); modes are
`blocking | advisory`; verdicts are structured
(`{ verdict, confidence, reasons, recommendedAction }`); staleness propagates on
rework; overrides never erase the original verdict. **No new `MaisterError`
code** is added ([ADR-008](#adr-008-typed-error-taxonomy-maistererror) closed
union) — an unparseable verdict is a `gate_results.status='failed'`, not a
thrown code. Because M11a annexes the gate-execution engine, **M15 is re-scoped**
to "readiness-policy DSL + verdict calibration + `external_check` ingestion
ONLY"; the status lifecycle, structured verdicts, and override-without-erasure
move to M11a.

**Consequences:**

- The rework loop can mark downstream gates `passed → stale` and force a rerun
  before a node finishes again — the core M11a demo.
- M11a `gate_results` **feed but do not gate promotion**; promotion-gating
  (readiness policy) stays M15/M18.
- Deferred kinds are explicitly stubbed (`artifact_required` → `skipped` +
  `TODO(M12)`, `external_check` → `pending` + `TODO(M16)`), never silently
  passed.
- M15's roadmap entry must read as re-scoped, not as a duplicate/false-failure.

**Alternatives Considered:**

- **Defer all gate execution to M15:** review-driven rework could not demonstrate
  `stale → rerun`, which is the entire point of M11a. Rejected.
- **Execute `artifact_required`/`external_check` now:** requires the M12 artifact
  graph and the M16 ops API, neither of which exists. Rejected — stub with a
  visible WARN + TODO.

---

### ADR-029: Split M11 into M11a / M11b / M11c

**Date:** 2026-05-30
**Status:** Accepted
> **Fully delivered:** M11a/M11b/M11c all shipped; surviving contracts live in ADR-026/027/028/030/031/032. Historical planning record.
**Context:** Roadmap M11 ("Flow graph maturity") bundles the graph engine,
ledger, rework, and gate execution together with manual human takeover, the rich
run-detail timeline, typed node settings, and a runtime enforcement boundary —
and its acceptance criteria reach into territory later milestones own (M12
artifacts, M14 capabilities, M15 readiness policy, M18 promotion). Shipping it as
one milestone is too large and entangles those dependencies.

**Decision:** Split M11 into three sequential sub-milestones:

- **M11a** — Flow graph v1 manifest + node lifecycle compile + append-only
  `node_attempts` ledger + review-driven rework loop + full-featured gate
  execution. Linear `steps[]` flows stay valid by compiling to single-action
  nodes. Ships **first**.
- **M11b** — manual takeover (local worktree handoff, consistent with
  [ADR-011](#adr-011-workspace-lifecycle-via-git-worktree)) + the rich
  run-detail timeline (current vs stale gates; attempts/decisions/handoffs/
  returned commits) + a board `HumanWorking` surface.
- **M11c** — node-specific **typed settings** + a runtime **enforcement
  boundary** (refuse undeclared MCP/tool/skill/restriction), anticipating the
  M14 capability registry.

The roadmap is renumbered M11 → M11a/M11b/M11c via the roadmap owner
(`/aif-roadmap`), distributing the 8 roadmap M11 criteria with **no clause
dropped and none double-listed**: M11a owns its AC-1..AC-8; manual-takeover and
the run-detail timeline (#4, #5, #7-takeover, #8-takeover) → M11b; node
`settings` enforced and the settings-schema docs (#6, #8-settings) → M11c;
unknown-**role** refs (#1-roles) → M13; unknown **MCP/tool/skill/agent/
restriction** refs (#1) → M14; node-level **executor** refs (#1) → M11c.

**Consequences:**

- Each slice is independently shippable and reviewable; criteria stay distinct.
- The graph engine is not blocked on manual takeover or the timeline UI.
- Node-level enforcement lands after the engine proves out, alongside the M14
  capability registry it depends on.

**Alternatives Considered:**

- **Ship M11 monolithically:** too large; entangles M12/M14/M15/M18
  dependencies inside one milestone. Rejected.
- **Split by layer (schema / DB / runner / UI):** each layer slice is
  unshippable on its own and proves nothing end-to-end. Rejected — split by
  capability instead.

---

### ADR-030: Manual takeover as a local worktree handoff (`HumanWorking` status)

**Date:** 2026-05-31
**Status:** Accepted
> **Amended by [ADR-081](#adr-081-rework-session-policy-with-resume-by-default) (2026-06-11):** `session_policy` resolution leaves the takeover-return path unaffected (no live session to resume); the interplay is documented in `manual-takeover.md`.
**Context:** M11b ([ADR-029](#adr-029-split-m11-into-m11a--m11b--m11c)) ships
**manual takeover** — a reviewer parked at an M11a `human_review` node takes the
run over to edit it by hand, then returns it for re-validation. The run already
owns an isolated worktree (`workspaces.worktree_path`) on a run branch
(`workspaces.branch`) cut from the project default branch
([ADR-011](#adr-011-workspace-lifecycle-via-git-worktree)). The open questions
are: is "claimed by a human" a real run status or a pointer move inside
`Running`; does takeover create a new branch/target; how are the human's commits
recorded; how do downstream gates re-validate the human's work; and does any of
this need a new `MaisterError` code. M11a's review-driven rework is a
node-pointer move *within* `Running`
([ADR-027](#adr-027-append-only-node_attempts-run-ledger)) — but a human holding
a worktree open for hours is operationally unlike an in-flight agent run and must
not look like one on the board, must hold a concurrency slot
([ADR-009](#adr-009-global-concurrency-cap--3)), and must survive a process
restart without being swept to `Crashed`.

**Decision:** Manual takeover is a **LOCAL worktree handoff** with five locked
properties:

1. **`HumanWorking` is a real `runs.status` enum value** — distinct from the M11a
   in-`Running` rework pointer move. A run enters `HumanWorking` on a takeover
   **claim** (`NeedsInput → HumanWorking`) and leaves it on **return**
   (`HumanWorking → Running`, the graph runner reruns the declared validation
   path), on **release** without changes (`HumanWorking → NeedsInput`, the
   original review HITL re-opens), or on **abandon** (`HumanWorking → Abandoned`).
   It counts against the global concurrency cap
   ([ADR-009](#adr-009-global-concurrency-cap--3)) exactly like
   `Running`/`NeedsInput` — a claimed worktree holds a real slot — through both
   scheduler cap-check predicates. It is **session-less by design** (the human
   edits locally; no live ACP session) yet holds a worktree, so it is **excluded
   from the startup recovery sweep** (which classifies only orphaned
   `NeedsInput`-with-`acp_session_id` rows) and is therefore never mis-classified
   `Crashed`.
2. **The takeover branch IS the existing run branch** (`workspaces.branch`);
   MAIster exposes the existing `worktree_path` + branch and the reviewer commits
   in place on the same host. No new branch, target, base-branch selection, PR,
   push, remote, or network git op — those are
   **M18** ([ADR-011](#adr-011-workspace-lifecycle-via-git-worktree) local-handoff
   spirit). The claim route returns `{ worktreePath, branch, ownerUserId }` so the
   UI can show checkout context; nothing is created.
3. **Return records commits + diff MINIMALLY as raw text in the ledger.** The
   return route runs `git log <base>..<branch>` (oneline) and
   `git diff <base>..<branch>` against the *existing* worktree (`<base>` is the
   `merge-base` of the run branch and the project default branch) and stores the
   raw output on the takeover `node_attempts` row (new columns
   `returned_commits`, `returned_diff`, `base_ref`, `owner_user_id`). The full
   typed `commit_set`/`diff` **artifact instances** + evidence-graph explorer are
   **M12** — M11b creates no artifact rows.
4. **On return, reuse M11a staleness.** The return path resolves the validation
   re-entry node from the **current `human_review` node's `transitions.takeover`**
   read off the run's pinned-revision manifest
   ([ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility),
   server-state, not a hard-coded id) — a gate-bearing validation node (`checks`),
   never `implement` (would re-run the agent and clobber the human's edits) and
   never `human_edit` (an M18 node type) — and stales **the re-entry node AND its
   downstream**:
   `markDownstreamStale(runId, [reentryNode, ...downstreamOf(graph, reentryNode)], db)`.
   The explicit `reentryNode` inclusion is REQUIRED: the as-built `downstreamOf`
   (module-private in `web/lib/flows/graph/runner-graph.ts` — M11b **exports** it)
   **excludes its start node**, but the takeover re-entry is a gate-bearing node
   whose prior PASS validated *pre-takeover* code and MUST flip stale so the
   human's commits are re-validated. `markDownstreamStale(runId, nodeIds, db)` is
   the 2-arg M11a helper in `web/lib/flows/graph/ledger.ts`. The graph runner then
   resumes at the re-entry so those gates rerun over the human's commits — reusing
   the M11a gate-execution engine and its `passed → stale → rerun` lifecycle
   ([ADR-028](#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)) — and a
   fresh `human_review` gate is produced. No new staleness machinery.
5. **No new `MaisterError` code** ([ADR-008](#adr-008-typed-error-taxonomy-maistererror)
   closed union). Takeover precondition failures map to existing codes:
   not-claimable / wrong run state / non-`human_review` node → `PRECONDITION`
   (409); concurrent claim (CAS lost) or conflicting return → `CONFLICT` (409);
   git-op failure on return → `CONFLICT` (the `worktree.ts` convention for failed
   git ops); a ledger/staleness write throwing mid-side-effect →
   `EXECUTOR_UNAVAILABLE` (503, retryable). The **return** route is a two-phase
   commit: a `SELECT … FOR UPDATE` intent read (assert `HumanWorking` + owner)
   precedes the git/ledger side-effect; the AFTER-side idempotency marker is the
   `status='Running'` flip plus the takeover row's `ended_at`, never set before
   the side-effect completes.
6. **Durability of the return flip.** If the process dies after the AFTER-side
   `HumanWorking → Running` flip but before the runner attaches, the run is
   recovered on startup by an **idempotent takeover-return re-dispatch**, NOT left
   stranded. The recovery candidate is a `Running` run whose latest ledger
   activity is a recorded takeover return (takeover `node_attempts` row has
   `returned_diff` / `ended_at` set, re-entry `gate_results` still `stale`) with no
   subsequent re-entry (`checks`) attempt; the sweep re-dispatches the graph runner
   at `runs.current_step_id` (the `transitions.takeover` re-entry). Safety rests on
   M11a's CAS-guarded resume — a live runner makes it a no-op, a genuinely stale
   pointer fails closed to `Crashed`. A naive "`Running` + no live session →
   `Crashed`" sweep is **rejected**: it would false-positive on a session-less
   `command_check` gate executing after the return.

**Consequences:**

- The board renders `HumanWorking` as a distinct takeover surface (owner, elapsed
  time, branch, pending-return action) that is **not** a normal running card.
- `HumanWorking` consumes one of the `MAISTER_MAX_CONCURRENT_RUNS` slots while a
  human holds the worktree, so concurrency accounting stays honest.
- The migration is **additive** (`0011`, on top of M11a's `0010`): one new
  `runs.status` enum value (TS-level, the column is plain `text`) and four
  nullable `node_attempts` columns populated only on takeover attempts.
- Takeover spawns **no supervisor deferred** (no agent) — the only resource a
  claim holds is the status + the slot; the release paths are
  `releaseHumanWorking` (abandon/release) and `markReturnedToRunning` (return).
- A mid-return git failure leaves the run `HumanWorking` with no ledger write and
  no status flip (retryable), so the handoff never partial-commits.

**Alternatives Considered:**

- **Model takeover as an in-`Running` pointer move (like M11a rework):** a
  human-held worktree is operationally distinct from an agent run — it needs its
  own board surface, must hold a slot, and must survive restart differently.
  Folding it into `Running` would mis-render the card and entangle the recovery
  sweep. Rejected — a real `HumanWorking` status.
- **Create a new takeover branch / target / PR on claim:** that is branch
  targeting + promotion mode, owned by **M18**, and violates the ADR-011
  local-handoff model. Rejected — the takeover branch IS the existing run branch.
- **Record returned commits as typed `commit_set`/`diff` artifact instances now:**
  requires the M12 artifact graph that does not exist. Rejected — store raw
  `git log`/`git diff` text on the ledger row; typed artifacts are M12.
- **Add a `TAKEOVER`/`HANDOFF` `MaisterError` code:** the closed union
  ([ADR-008](#adr-008-typed-error-taxonomy-maistererror)) already covers every
  takeover failure via `PRECONDITION`/`CONFLICT`/`EXECUTOR_UNAVAILABLE`. Rejected
  — no new code.

---

### ADR-031: Node typed settings schema (carve (b))

**Date:** 2026-06-01
**Status:** Accepted
**Context:** M11a shipped the Flow graph manifest (`nodes[]`,
[ADR-026](#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump)) but
deliberately punted on node `settings`: the block is parsed as an opaque
passthrough (`z.record(z.string(), z.unknown())` in `nodeCommon`) and
`loadFlowManifest` emits a one-time `SETTINGS_NOT_ENFORCED_WARN`. Roadmap
criterion #6 ("AI node settings are visible in the UI and enforced by runtime
boundaries: no undeclared MCP/tool/skill/restriction escape hatch is silently
allowed") and the node-settings half of criterion #8 (docs) remain open. Real
*positive* enforcement of #6 depends on **M14** (scoped capability
materialization): the named-capability registry, import-from-git resolved SHA,
agent-aware mapping (`tools:[shell]`→concrete names), and per-session
materialization of `settings.json` / MCP config / skills. M11c cannot resolve
`mcps:[github]` to an enforceability verdict without the M14 registry, and must
not duplicate M14's registry-reference validation (roadmap #1, assigned to M14)
or M13's role validation.

**Decision:** Adopt **carve (b)**. M11c replaces the M11a opaque passthrough
with a **typed, per-node-type discriminated `settings` schema** and **removes**
`SETTINGS_NOT_ENFORCED_WARN`. Each node `type` gets a distinct shape: `ai_coding`
and `judge` carry the agent-capability shape (`runner_type`, `runner`, `model`,
`thinkingEffort`, `mcps`, `tools` (agent-aware map), `skills`, `settingsProfile`,
`workspaceAccess`, `artifactAccess`, `permissionMode`, `limits`, `restrictions`,
plus a per-class `enforcement` map); `human` carries
roles/assignees/decisions/takeover/SLA/return shape; `cli`/`check` carry
command/timeout/environmentPolicy/artifacts/failureClass shape. `settings` is
OPTIONAL on every node type (back-compat: compiled-linear and minimal graph
nodes carry none; absence never triggers a refusal). M11c validates settings
**shape + enum + numeric bounds + intra-manifest/server-state references only**:
`settings.runner` against portable Flow runner targets (resolved/remapped at
attach or launch), `human.decisions[]` against the node's `transitions` (the M11a validator),
and `enforcement` keys only on classes the node type owns. M11c **never** reads a
capability registry, resolves an abstract capability id, validates an
MCP/tool/skill/agent/restriction *reference*, or materializes a settings file —
all of that is M14.

**Consequences:**

- The `z.unknown()` passthrough and `SETTINGS_NOT_ENFORCED_WARN` (and its WARN
  emission) are deleted from `web/lib/config.schema.ts` / `web/lib/config.ts`;
  the M11a tests asserting the constant/WARN are superseded (assert against the
  removed named symbol, not a string match).
- Settings ride in the already-pinned `flow_revisions.manifest` (server-state,
  immutable per run); there is no YAML→DB persistence of settings in M11c, so
  the config-state SET/CLEAR round-trip rule is N/A.
- The criterion-#6 slice is honest and non-silent: schema + visibility are real
  now, the refusal boundary ([ADR-032](#adr-032-settings-enforcement-refusal-boundary))
  is real now, and M14 later flips capability classes from `instructed` to
  `enforced` and adds registry-ref resolution **without weakening** the contract.
- Docs: `flow-dsl.md` node `settings` is promoted Designed→Implemented for the
  M11c subset; M14 parts stay Designed.

**Alternatives Considered:**

- **Ship full enforcement now (resolve refs + materialize):** requires the M14
  registry + spawn-env layer that does not exist; would either fabricate
  verdicts or silently weaken the boundary. Rejected — carve at the M14
  dependency.
- **Keep the opaque passthrough and only add a UI view:** leaves criterion #6
  "no silent escape hatch" unmet (undeclared shape still accepted). Rejected —
  the typed schema is the contract.
- **A single shared settings shape across node types:** `cli`/`check` have no
  capabilities and `human` has no MCP/tools; a flat shape would accept nonsense
  (`mcps` on a `human` node). Rejected — discriminate by node `type`.

---

### ADR-032: Settings-enforcement refusal boundary

**Date:** 2026-06-01
**Status:** Accepted
**Context:** Carve (b) ([ADR-031](#adr-031-node-typed-settings-schema-carve-b))
ships the typed settings now but defers materialized enforcement to M14.
Criterion #6 forbids a "silent escape hatch": a flow that *declares* it needs
strict enforcement of a capability class MAIster cannot yet strictly enforce
must NOT launch as if it could. Until M14 owns the materializing registry,
MAIster can only *gate* whether a node is allowed to launch.

**Decision:** Record an explicit per-class **`enforcement` intent**
(`strict | instruct | off`, default `instruct`) on each capability-bearing
setting, resolved against a **static per-agent enforceability table** — a code
constant `ENFORCEABILITY_BY_AGENT` in `web/lib/flows/enforcement.ts` mapping
`agent → capabilityClass → 'enforced' | 'instructed' | 'unsupported'`. The table
is **conservatively seeded all-`instructed`** (no `enforced` cell) for M11c: the
`permissionMode`-on-`claude` cell is the only candidate for `enforced`, and only
if `claude-agent-acp@0.37.0` is verified end-to-end to honor
`--permission-mode deny|ask`; that spike (Phase 0.10) had **no live adapter** in
M11c, so the whole table stays `instructed`. A pure evaluator
`evaluateNodeEnforcement(settings, agent, table)` returns, per declared class,
`verdict='refused'` iff `declared==='strict' && table[agent][class]!=='enforced'`,
`'enforced'` iff `declared==='strict' && table[agent][class]==='enforced'`,
`'instructed'` otherwise (`off`→omitted). `assertNodeLaunchable(node, agent,
table)` throws on any `refused` class: **`MaisterError("CONFIG")`** when no agent
in the table can `enforced` the class (the build cannot strictly enforce it at
all — internal over-declaration), **`MaisterError("EXECUTOR_UNAVAILABLE")`** when
some agent can `enforced` it but the resolved executor's agent cannot. **No new
error code** ([ADR-008](#adr-008-typed-error-taxonomy-maistererror) closed
union). The refusal attaches at TWO points: the **launch precondition** in
`web/app/api/runs/route.ts` (whole-manifest static check, AFTER trust +
enablement + executor resolution, BEFORE worktree creation) and the **per-node
runtime gate** in `web/lib/flows/graph/runner-graph.ts` (immediately before a
node's `action` is built, post per-node executor resolution), so a future
per-node executor override cannot smuggle an unenforceable class past launch. The
refusal fires BEFORE any ACP session / permission deferred is created (no leaked
deferred). Resolved per-class verdicts are snapshotted to
`node_attempts.enforcement_snapshot` (migration `0013`) at launch/first-attempt
for audit, on both the pass and refusal paths. The supervisor `spawn.ts` env
construction is **unchanged** in M11c — M11c only gates whether the node may
launch; the materialized env layer is M14.

Time-limit enforcement (`limits.maxDurationMinutes`) is separate: it is
MAIster-side and agent-agnostic, therefore inherently `enforced` and NOT subject
to the strict/instruct table. It is a **web-side watchdog**, not a launch
refusal — the existing keep-alive / scheduler sweep computes elapsed from the
active `node_attempts.started_at` and terminates a past-cap run via the existing
supervisor `DELETE /sessions/:id`, marking the node `Failed`. Cost limits remain
record-only.

**Consequences:**

- With the all-`instructed` table, every `strict` declaration on any capability
  class refuses launch with `CONFIG`; the `EXECUTOR_UNAVAILABLE` branch is
  exercised by tests that inject a table with an `enforced` cell. The
  evaluator/asserter take the table as an injectable parameter (default
  `ENFORCEABILITY_BY_AGENT`).
- The contract only ever tightens: M14 flips cells `instructed→enforced` and
  adds registry-ref resolution; a flow that launched under M11c never *starts*
  failing because a class became enforceable. Each `instructed` cell carries a
  `TODO(M14)`.
- The refusal applies to `ai_coding` AND `judge` nodes (both spawn an agent
  session). Capability-scoping of gate agent-sessions
  (`skill_check`/`ai_judgment`) stays M14.
- No new env var / port / sidecar / config path (the table is a code constant;
  settings ride in the manifest) → no `Dockerfile` / `compose.*` /
  `.env.example` change.

**Alternatives Considered:**

- **A new `MaisterError` code (`ENFORCEMENT` / `CAPABILITY`):**
  [ADR-008](#adr-008-typed-error-taxonomy-maistererror) is a closed union;
  `CONFIG` (build-cannot-enforce) and `EXECUTOR_UNAVAILABLE` (not-for-this-agent)
  already model both failure modes precisely. Rejected — no new code.
- **Seed `permissionMode=enforced` for claude without the spike:** a
  wrongly-`enforced` cell lets a `strict permissionMode` PASS the launch gate
  while nothing enforces it — the exact silent escape hatch #6 forbids. Rejected
  — conservative `instructed` until verified end-to-end.
- **Supervisor-side time-limit timer (arm in `spawn.ts`):** the web tier owns
  the run state machine and the DB, so a supervisor kill would still need a
  web-side mark-`Failed`; arming a timer in `spawn.ts` also breaks this ADR's
  "spawn.ts unchanged" freeze and the `POST /sessions` wire. For
  minute-granularity caps the sweep overshoot is negligible. **Revisit at M14**,
  when the materialization / spawn-env layer moves supervisor-side, the freeze
  lifts, and second-precise, outage-surviving kills become worth the wire change.
  Rejected for M11c — web-side watchdog reusing the keep-alive sweep.
- **Enforce only at the supervisor wire (single gate):** a per-node executor
  override (M14-era) could then smuggle an unenforceable class past a
  manifest-level launch check. Rejected — gate at the launch precondition AND
  the per-node runtime build (belt-and-suspenders).

---

### ADR-033: Crash reconciliation model (startup + periodic sweeper, allow-list `Running`-only)

**Date:** 2026-06-01
**Status:** Accepted
**Context:** A run is `Running` only while a runner loop is attached to its
ACP session. A Next.js restart, a supervisor restart, or a host reboot kills
that loop while the `runs` row stays `Running` — a stranded run that no live
event will ever advance. The supervisor heartbeat
(`supervisor/src/heartbeat.ts`) detects an orphaned agent process every 5 s
and emits `session.crashed`, but the web tier only observes that while it is
actively streaming the run, so a crash during a restart window is invisible.
Two recovery sweeps already run from `web/instrumentation.ts` —
`runResumeRecoverySweep` (claimed-but-undelivered `NeedsInput`) and
`runTakeoverReturnRecoverySweep` (stranded `Running` after a takeover return,
[ADR-030](#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status)).
Neither covers a plain stranded `Running` run, and a naive
"`Running` + no live session → `Crashed`" sweep is **FORBIDDEN**
(`web/lib/runs/resume-recovery.ts:328-331`): it false-positives on a
session-less `check`/`judge` gate executing between agent sessions. M19 needs
a third sweep whose classifier is precise enough to never crash a healthy run.

**Decision:** Add a **reconcile engine** that runs once at startup
(`web/instrumentation.ts`, after the two existing recovery sweeps, before the
keep-alive sweeper) and on a periodic singleton interval
(`MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS`, default 60). Its core is a pure
classifier `classifyRunReconcile(input) → {action, reason}` (`web/lib/reconcile.ts`)
that, per run, gathers `run.status`, `run.runKind`, `run.acpSessionId`,
`run.currentStepId`, the node type of `currentStepId` (resolved from the run's
pinned `flow_revisions.manifest` compiled to the graph; legacy `steps[]` compile
to single-action nodes), `worktreeExists` (path ∈ `listWorktrees`), and
`liveSession` (`acpSessionId` ∈ live `listSessions` map). It gates **exactly** as:

| Run state | Condition | Action | Reason |
|-----------|-----------|--------|--------|
| status ∉ `{Running}` | any | **SKIP** | reconcile is **allow-list `Running`-only**; `NeedsInput`/`NeedsInputIdle`/`HumanWorking`/terminal owned by other sweeps |
| `Running` | worktree MISSING | **CRASH** (`crashRunningRun`, reason `worktree-gone`) | the "runs vs `git worktree list`" check; cannot continue |
| `Running` | worktree present, `liveSession` present | **RE-ATTACH** (`scheduleResumedSessionDrive`) or re-dispatch `runFlow` | live agent session with no attached runner (post web restart) — not crashed |
| `Running` | worktree present, no live session, current node is a **retry-safe gate eval** (`check`/`judge` — read-only) | **RE-DISPATCH** `runFlow` (CAS-guarded) | safe re-run of a read-only evaluation; avoids the FORBIDDEN false-positive crash on a gate executing between sessions |
| `Running` | worktree present, no live session, current node is **`cli`** (arbitrary side effects, NOT retry-safe) | **CRASH** (`crashRunningRun`, reason `cli-not-retry-safe`) | CAS prevents concurrent runners, NOT re-run idempotency (Codex F4); a half-run `cli` may have partial file/network side effects — never silently re-run. Recoverable via explicit human Recover (accepted-risk re-dispatch). A future manifest `retry_safe: true` opt-in can widen this. |
| `Running` | worktree present, no live session, current node is **agent**, **recently started** (`resume_started_at` OR latest `node_attempts.started_at` within `MAISTER_RECONCILE_GRACE_SECONDS`) | **SKIP** (grace window) | a launch/recover is still spinning its ACP session up — do NOT crash an in-flight session |
| `Running` | worktree present, no live session, current node is **agent**, **past grace** | **CRASH** (`crashRunningRun`, reason `agent-session-gone`) | recoverability computed at UI render from `acpSessionId` presence; auto-resume of a mid-turn agent is unsafe → explicit human Recover |
| `Running`, `runKind='scratch'` | session gone, past grace | **CRASH** via `markScratchCrashed` (sets both `runs.status` and `scratchRuns.dialogStatus`) | scratch parity |

Locked properties of the engine:

1. **Allow-list `Running`-only.** The classifier returns `skip` for every
   non-`Running` status; `NeedsInput`/`NeedsInputIdle`/`HumanWorking`/terminal
   rows belong to other sweeps and are never touched here.
2. **Grace guard.** A `Running` agent run with no live session whose
   `resume_started_at` OR latest `node_attempts.started_at` is within
   `MAISTER_RECONCILE_GRACE_SECONDS` (default 90) → `skip`. This is REQUIRED so
   a periodic tick never crashes a run whose ACP session is still being created —
   by a fresh launch OR by an in-flight Recover, which flips `Crashed→Running` +
   stamps `resume_started_at` *before* `createSession`
   ([ADR-034](#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)).
   Only past the grace window does it `crash`.
3. **Retry-safety split (Codex F4).** Only read-only gate evals (`check`/`judge`)
   auto-`redispatch` (a CAS no-op when the real runner still holds the run — the
   contract `runTakeoverReturnRecoverySweep` already relies on). A `cli` node is
   NOT idempotent and is `crash`ed (reason `cli-not-retry-safe`), never
   auto-redispatched; its half-run side effects are recovered only via explicit
   human Recover.
4. **Disjoint sweeps.** Reconcile, `resume-recovery`, and `takeover-return` all
   scan non-terminal runs but MUST act on disjoint sets. The reconcile sweep
   excludes the takeover-return candidate set (carry its `returned_diff` +
   `ended_at` + stale-re-entry-gate predicate as an exclusion) and is allow-list
   `Running`-only so it never overlaps the `NeedsInput`-scoped resume-recovery
   sweep.
5. **Transient supervisor unavailability → skip the whole tick.** If
   `listSessions` fails, the engine skips the entire tick (like
   `resume-recovery`) — it NEVER crashes a run on a transient supervisor outage.
6. **Sanctioned recovery path, not a banned poll.** The periodic
   `listSessions`/`listWorktrees` poll is the heartbeat + reconcile **recovery**
   path, NOT a live-path state-transition poll. The house rule forbidding
   `fs.watch`/`chokidar`/polling (root `CLAUDE.md` §1) governs the *live* path
   — ACP notifications drive transitions while a runner is attached. Reconcile
   is the explicitly-sanctioned recovery channel for the restart/crash window,
   stated here so reviewers do not read it as a forbidden live poll.

**Consequences:**

- A stranded `Running` run is detected and resolved within one sweep interval
  of any restart, without a banned live-path poll.
- The classifier is pure (inputs are plain data: run row incl.
  `resume_started_at`, latest-attempt `startedAt`, `nowMs`, `graceSeconds`,
  `worktreeExists`, `liveSession`, `currentNodeKind`) → every table row is
  unit-testable with no clock/db access.
- On a healthy box the only paths to CRASH are worktree-gone,
  agent-session-gone **past grace**, or a half-run `cli` node — all genuine
  deaths; an in-flight launch/recover within grace is never crashed.
- Each `Running→Crashed` releases its scheduler slot
  (`promoteNextPending`, parity with `markAbandoned`,
  [ADR-009](#adr-009-global-concurrency-cap--3)).
- Two new env vars (`MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS`,
  `MAISTER_RECONCILE_GRACE_SECONDS`); no new port, sidecar, or wire change.

**Alternatives Considered:**

- **Naive "`Running` + no live session → `Crashed`" sweep:** false-positives on
  a session-less `check`/`judge` gate executing between agent sessions
  (`web/lib/runs/resume-recovery.ts:328-331`). Rejected — the classifier splits
  retry-safe gates (redispatch) from non-idempotent `cli` (crash) and guards
  in-flight agent sessions with the grace window.
- **`fs.watch`/`chokidar` on the worktree or session journal:** a banned
  live-path mechanism (root `CLAUDE.md` §1); the live path is ACP notifications.
  Rejected — reconcile is the recovery path, driven by heartbeat + periodic
  poll, not a filesystem watcher.
- **Fold reconciliation into the existing resume-recovery or takeover-return
  sweep:** their candidate sets (`NeedsInput`-claimed, takeover-returned
  `Running`) are deliberately narrow; widening either to cover plain stranded
  `Running` runs would entangle the disjointness invariant and re-introduce the
  forbidden false-positive. Rejected — a third, allow-list-`Running` sweep.

---

### ADR-034: Crashed-run recovery semantics (hybrid `--resume` + re-dispatch, durable-marker-first, cap re-admission)

**Date:** 2026-06-01
**Status:** Accepted
**Context:** A `Crashed` flow run owes recovery
([ADR-011](#adr-011-workspace-lifecycle-via-git-worktree)). The cross-process
resume plumbing already exists (`web/lib/runs/resume.ts`,
`web/lib/runs/resume-driver.ts`, the scratch recover route — resume is the ACP
`session/resume` call, not a CLI flag), and
`crashRunningRun` ([ADR-033](#adr-033-crash-reconciliation-model-startup--periodic-sweeper-allow-list-running-only))
produces the `Crashed` row. M19 must decide *how* a user recovers a `Crashed`
flow run: a mid-turn agent node and a session-less gate node need different
mechanisms; the recovery must survive a crash *during* recovery without leaking
an ACP session or double-spawning; and because a `Crashed` run already released
its concurrency slot (`crashRunningRun → promoteNextPending`), a Recover is a
**re-launch** that MUST respect the global cap
([ADR-009](#adr-009-global-concurrency-cap--3)), unlike the M8 idle-resume which
never vacated its slot.

**Decision:** Recover is **hybrid**, classified by the current node type
(`classifyRecover(run, currentNodeKind) → 'resume-agent' | 'redispatch' | 'discard-only'`):

- **agent node** → `createSession({resumeSessionId: run.acpSessionId})` reusing
  `resume.ts`/`resume-driver.ts`, then `scheduleResumedSessionDrive` at
  `currentStepId`.
- **session-less gate node** (`check`/`judge`) → `runFlow` re-dispatch (no
  `createSession`).
- **`acpSessionId` absent or unresumable** → `discard-only` (no resume offered;
  the UI surfaces Discard).

Recovery is ordered **durable-marker-BEFORE-side-effect** (Codex #1), in two
phases under the scheduler advisory lock:

- **Phase 1 (durable intent + cap admission, one tx):** `SELECT … FOR UPDATE`;
  CAS `WHERE status='Crashed'` (allow-list, not `!terminal`); count live
  (`Running`/`NeedsInput`/`HumanWorking`) vs `MAISTER_MAX_CONCURRENT_RUNS`.
  - **slot free** → flip `status→Running`, set `resume_started_at = now()`, set
    `currentStepId` = resume target → proceed to Phase 2.
  - **cap full** → flip `status→Pending` (keep `acpSessionId`, set
    `resume_started_at` + `currentStepId`) → return **202 `{state:"queued"}`**,
    NO `createSession`. The scheduler resumes it on slot-free (Codex F2 — a
    Crashed run already freed its slot, so Recover re-admits through the cap and
    never over-spawns; this is **not** a cap bypass). A promoted `Pending` run
    **with** `acpSessionId` is resumed via the Phase-2 path (refreshing
    `resume_started_at` at promotion); **without** it (a fresh queued launch,
    `acpSessionId` null) it is fresh-launched — an unambiguous discriminator.
  This tuple (`Running`/`Pending` + `resume_started_at` + `acpSessionId`) **IS**
  the durable in-flight/queued marker, committed *before* any supervisor call.
- **Phase 2 (side-effect, only when admitted):** the resume/redispatch above.
  The driver/runner clears `resume_started_at` on first progress.

The **reconcile engine is the single crash-window recovery mechanism** — there
is no bespoke recover-recovery sweep. Every death/ambiguity during recovery
reduces to a `Running` + `resume_started_at` + `acpSessionId` state the
reconciler already owns (re-attach if the resumed session is live, re-crash past
grace if not). The §3.2 failure mapping:

| Window / failure | HTTP | Row state & who recovers |
|------------------|------|--------------------------|
| cap full at admission | 202 `{state:"queued"}` | `Crashed→Pending` (acpSessionId retained); scheduler resumes on slot free. No `createSession` → no over-spawn (Codex F2) |
| concurrent 2nd Recover click | 409 | Phase-1 CAS on `status='Crashed'` fails (now `Running`/`Pending`) → duplicate `createSession` impossible |
| crash **before** `createSession` | — | `Running` + `acpSessionId` not live + past grace → reconciler re-crashes to `Crashed` (clears `resume_started_at`); user retries. No session leaked |
| crash **after** `createSession` success | — | `Running` + `acpSessionId` now live → reconciler re-attaches the driver |
| supervisor 5xx / network / timeout (ambiguous) | 503 | leave `Running` (do NOT roll back — the ack may have been lost and a session may be live); reconciler reattaches if it came up, else re-crashes past grace. Retryable |
| supervisor 4xx `CHECKPOINT` (unresumable acp session) | 410 | `crashRunningRun` → `Crashed` (clears `resume_started_at`); surface discard-only |

**Discard** is a single terminal action, NOT a synchronous worktree delete
(Codex #2/#3): one tx `markAbandoned` (allow-list incl. `Crashed`) stamps
`scheduled_removal_at = endedAt + MAISTER_GC_AGE_DAYS` then `promoteNextPending`.
The worktree is left in place showing the TTL countdown and is preserved-then-
pruned by the GC sweep
([ADR-035](#adr-035-graceful-workspace-gc-preserve-then-prune)) — one lifecycle;
Discard never calls `preserveWorktree`/`removeOwnedWorktree`. Idempotent on
already-terminal (same-state → 200, conflict → 409); immediate force-delete is
Phase 2.

**RBAC:** recover and discard are gated by a **new project action `recoverRun`
with min role `member`** (added to `PROJECT_ACTION_MIN`) — distinct from
`launchRun`, so recovery permission is granted independently of launch. `runId`
is the url-param (trusted via route shape + RBAC); `projectId` is server-state
(DB join `runs→project`); bodies are empty.

**Consequences:**

- A mid-turn agent crash resumes via `session/resume`; a session-less gate crash
  re-dispatches; an unresumable run offers discard-only — no false resume.
- No crash window leaves a leaked ACP session or a double-spawn: the durable
  marker precedes the side-effect, the CAS makes a second Recover a 409, and the
  cap admission makes over-spawn impossible.
- A transient supervisor failure (503) leaves the run `Running` (NOT rolled
  back) and is retryable; the reconciler resolves it within one grace window.
- `recoverRun=member` lets a member recover/discard without launch rights;
  no new `MaisterError` code ([ADR-008](#adr-008-typed-error-taxonomy-maistererror)
  closed union — recover/discard reuse `CHECKPOINT`/`CONFLICT`/`PRECONDITION`/
  `EXECUTOR_UNAVAILABLE`).
- `runs.resume_started_at` (migration 0015) is the durable in-flight marker AND
  the reconcile grace anchor.
- Live-agent graph `session/resume` continuation semantics are CI-verified only on the
  mock adapter (M8) + the M0 single-session live spike; if mid-turn continuation
  proves unsafe, agent nodes fall back to `redispatch` (re-run the node fresh) —
  this ADR is updated before that code change.

**Alternatives Considered:**

- **Flip `Crashed→Running` on supervisor ack (marker-after-side-effect):**
  leaves a crash window where `createSession` succeeded but the row is still
  `Crashed` with no durable in-flight record — the reconciler cannot tell a
  recovered run from a dead one. Rejected — durable marker first.
- **Recover bypasses the concurrency cap (resume in-place like M8 idle-resume):**
  a `Crashed` run already vacated its slot, so resuming without re-admission
  would exceed `MAISTER_MAX_CONCURRENT_RUNS`. Rejected — Recover re-admits;
  cap-full queues to `Pending` (202).
- **A bespoke recover-recovery sweep for the recover crash window:** duplicates
  what the reconcile engine already does for every `Running` + marker state.
  Rejected — the reconcile engine is the single crash-window recovery.
- **Discard synchronously removes the worktree:** couples Discard to GC preserve
  logic, adds an AFTER-side removal-failure path, and risks losing un-committed
  agent edits. Rejected — Discard enters the GC countdown; preserve-then-prune
  is one unified lifecycle.

**Amendment (2026-06-02).** The shipped classifier is
`classifyRecover(run, nodeKind, retrySafe) → 'resume-agent' | 'redispatch' |
'discard-only'`, gated on a new per-node manifest opt-in and a new retained
target column:

- **`retry_safe` opt-in.** A per-node boolean (`flow.yaml` `nodes[]` AND linear
  `steps[]`, default `false`) gates the session-less `redispatch` plan. A
  crashed session-less node (`cli`/`check`/`judge`/`guard`/`human`) is
  redispatch-recoverable **only** when its config declares `retry_safe: true` —
  re-running a session-less node repeats its side effects (accepted-risk),
  so the opt-in is explicit. This is the manifest opt-in foreshadowed in
  `system-analytics/reconciliation-gc.md`. `ai_coding` ignores `retry_safe`
  (it is always recovered via `session/resume`, never re-run from scratch).
- **`runs.resume_target_step_id` retention (migration 0016, nullable text).**
  `crashRunningRun` copies `current_step_id → resume_target_step_id` and nulls
  `current_step_id` (the clean-terminal read of §ADR-033 is preserved). Recover
  resolves the node kind + `retry_safe` from `resume_target_step_id` (falling
  back to `current_step_id` for live/hand-seeded rows). Without this column a
  reconcile-crashed run had no node to resume to — this fixes recovery for BOTH
  agent and session-less crashed runs.
- **Runner crash-resume mode.** `driveResume` flips `Crashed → Running` and
  calls `runFlow(runId, { crashResume: { targetStepId } })`. The graph runner
  (`runGraph`) and the linear runner (`runFlow`) treat this as a resume FROM the
  target node — re-running it once as a fresh attempt — instead of (graph)
  no-op'ing on the already-owned guard or (linear) restarting from step 0. This
  is a **third** resume mode alongside NeedsInput-resume and takeover-resume. The
  claim is single-winner via a CAS-clear of the in-flight marker
  (`UPDATE runs SET resume_started_at = NULL WHERE id = ? AND resume_started_at
  IS NOT NULL`): the winner drives, the loser bails.

---

### ADR-035: Graceful workspace GC (preserve-then-prune)

**Date:** 2026-06-01
**Status:** Accepted
**Context:** [ADR-011](#adr-011-workspace-lifecycle-via-git-worktree) promised a
cron GC of `Abandoned`/`Done` worktrees, deferred to M19. A worktree of a
terminal run can still carry valuable work: committed run-branch divergence, or
uncommitted/untracked agent edits left when the run crashed or was discarded
([ADR-034](#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)).
A naive `git worktree remove` would destroy that work. GC must also not become a
promotion path — silently merging a GC'd branch into the project default is
dangerous and is M18's job, not GC's.

**Decision:** GC of terminal-run worktrees is **preserve-then-prune**. Age =
`MAISTER_GC_AGE_DAYS` (default 14) with a `MAISTER_GC_WARNING_DAYS` (default 2)
warning ramp surfaced as a TTL color ramp (green → amber → red). Delivery is
**dual**: a background sweeper singleton (`MAISTER_GC_SWEEP_INTERVAL_SECONDS`,
default 3600) AND a token-guarded HTTP cron route `GET`/`POST /api/cron/gc`
(constant-time `X-Maister-Cron-Token` vs `MAISTER_CRON_TOKEN`; empty config →
503 disabled, mismatch → 401). `MAISTER_CRON_TOKEN` is a **server-only secret**
— never logged, never streamed.

Candidate select = `workspaces.removed_at IS NULL` joined to
`runs.status IN ('Abandoned','Done')` where the **effective deadline**
`COALESCE(scheduled_removal_at, ended_at + MAISTER_GC_AGE_DAYS) <= now()`
(Codex F3 — the `ended_at` fallback collects pre-migration-0015 terminal runs
whose `scheduled_removal_at` is null, so **no backfill migration is needed**).
The same effective deadline drives the TTL read models so pre-0015 rows show a
countdown too.

Order inside `preserveWorktree`, BEFORE any `removeOwnedWorktree` (Codex F1 —
preserve EVERYTHING first):

1. `statusPorcelain(worktree)` (`--untracked-files=all`) to detect staged +
   unstaged + untracked changes.
2. **Dirty** → a snapshot commit IN the worktree capturing tracked AND untracked
   state: `git add -A && git commit --no-verify -m "maister: GC snapshot of <runId>"`.
   The run is terminal and the worktree is about to be deleted, so advancing its
   branch HEAD is safe; the snapshot lands on the archive ref.
3. When dirty OR `logRange(base..branch)` non-empty → point the archive branch
   `maister/archive/<runId>` at the (snapshot-or-)branch HEAD (`git branch -f`);
   if a remote exists and `MAISTER_GC_ARCHIVE_PUSH=true` (default `false`), push
   it (host git creds per [ADR-025](#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)).
   Record `workspaces.archived_branch` / `archived_at`.
4. **Removal is gated on preserve success.** Only after preserve succeeds is the
   worktree removed; on ANY git failure `preserveWorktree` returns `ok:false`
   and the caller SKIPS removal (log WARN, leave for the next tick / operator).
   Forcibly removing un-preserved dirty state is FORBIDDEN.

GC **never auto-merges** into the project default/target branch (that is M18
promotion, [ADR-012](#adr-012-local-promotion-merge-policy---no-ff-abort-on-conflict)).
A clean worktree with no commit divergence has nothing to preserve → skip
straight to removal. The migration 0015 adds three nullable `workspaces` columns
(`scheduled_removal_at`, `archived_branch`, `archived_at`) — no `gc_state` enum.

**Consequences:**

- No GC run ever loses committed, uncommitted, or untracked agent work — preserve
  precedes and gates every removal.
- Pre-0015 terminal runs are collected via the `ended_at + AGE` fallback without
  a backfill migration.
- Discard and the natural Abandoned/Done lifecycle share one GC path
  ([ADR-034](#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)).
- Preserving dirty state advances the run branch HEAD with one synthetic
  `maister: GC snapshot` commit on the archive branch — intentional and safe
  (the run is terminal, the worktree is being deleted).
- All partial crash-window states (dirty-not-snapshotted, archived-not-pruned,
  pruned-not-marked) converge on a re-run; no window deletes un-preserved state.
- Six new env vars total across M19 GC + reconcile;
  `MAISTER_CRON_TOKEN` is server-only.

**Alternatives Considered:**

- **Plain `git worktree remove` on age:** destroys uncommitted/untracked agent
  edits and committed run-branch divergence. Rejected — preserve-then-prune,
  removal gated on preserve success.
- **Auto-merge the run branch into the default/target on GC:** a silent merge is
  dangerous and is M18 promotion, not GC. Rejected — archive branch only, never
  merge-to-main.
- **A backfill migration to stamp `scheduled_removal_at` on pre-0015 terminal
  runs:** unnecessary — the `COALESCE(scheduled_removal_at, ended_at + AGE)`
  effective-deadline fallback (Codex F3) covers them. Rejected — no backfill.
- **A `gc_state` enum column:** more fan-out points; the UI derives TTL / pruned
  / archived state from `scheduled_removal_at` + `archived_at`/`archived_branch`
  + existing `removed_at`. Rejected — three nullable columns, no enum.

---

### ADR-036: Flow-revision GC

**Date:** 2026-06-01
**Status:** Accepted
**Context:** [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
introduced immutable `flow_revisions` and `removeRevision`
(`web/lib/flows/lifecycle.ts:386`), which marks a revision `packageStatus='Removed'`
under a dual-FK guard (refused while any `runs.flow_revision_id` references it or
it is a `flows.enabled_revision_id`). That ADR explicitly deferred automatic GC
of unreferenced `Removed` revisions to M19 (lifecycle comment line 385:
"Automatic GC of unreferenced revisions is M19"). A `Removed` revision still
occupies its content-addressed install path on disk
(`~/.maister/flows/<id>@<sha>/`) until something reclaims it.

**Decision:** A `runRevisionGcSweep` (`web/lib/gc/revision-gc.ts`), delivered by
the same dual surface as workspace GC
([ADR-035](#adr-035-graceful-workspace-gc-preserve-then-prune) — background
sweeper + token cron), auto-deletes unreferenced `Removed` revisions past
`MAISTER_GC_AGE_DAYS`. Per candidate: `SELECT … FOR UPDATE`, **re-assert** the
existing dual-FK guard (zero `runs.flow_revision_id` references AND zero
`flows.enabled_revision_id` references) — reusing the guard logic from
`lifecycle.removeRevision` — then delete the `flow_revisions` row and
`rm(installedPath, {recursive, force})`. The sweep **only removes**; it NEVER
runs `setup.sh` or any plugin hook, so no fetch-then-execute path is introduced
([ADR-010](#adr-010-flow-engine-v2-plugin-packaging--step-dsl) trust model
unchanged).

**Consequences:**

- Disk reclaimed for revisions no run or enablement pointer references, past the
  age window, with no manual step.
- The dual-FK guard is re-asserted under `FOR UPDATE` at delete time, so a
  revision that gained a reference between mark and sweep is skipped — never a
  dangling FK.
- Removal is purely destructive (`rm` + row delete); no `setup.sh`/hook
  execution → no new trust/execution surface.
- Shares the `MAISTER_GC_AGE_DAYS` age and the GC delivery surfaces; no new env
  var of its own.

**Alternatives Considered:**

- **A separate FK / age guard for revision GC:** the
  [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
  dual-FK guard already encodes exactly "unreferenced", and `MAISTER_GC_AGE_DAYS`
  already times workspace GC. Rejected — reuse both.
- **Run `setup.sh`/plugin teardown hooks on revision removal:** introduces a
  fetch-then-execute path GC has no reason to open; M19 GC only reclaims disk.
  Rejected — remove-only, no hooks.
### ADR-037: Typed artifact model

**Date:** 2026-06-01
**Status:** Accepted
**Context:** M12 introduces an evidence graph: review gates and the run-detail
UI need to query *what evidence a run produced* (diffs, logs, test/lint
reports, AI judgments, human notes, commit sets, checkpoints, previews) without
re-parsing logs or re-running git on every read. Run artifacts already live in
the run dir (`.maister/<projectSlug>/runs/<runId>/`), the worktree, and git;
duplicating their bytes into Postgres would double-store, drift, and bloat the
DB. M11 owns the runner-side `node_attempts` ledger; M12 must add a queryable
evidence index over the *same* on-disk/in-git truth, not a parallel payload
store.

**Decision:** Add one new table, `artifact_instances`, that is the **queryable
evidence INDEX only**. Payloads stay where they are produced — on disk in the
run dir, in the worktree, or in git. Postgres holds **metadata plus a typed
discriminated `locator`** that points at the payload (run-dir relative path, git
ref/range, supervisor log offset, external URL — discriminated by locator
kind). The artifact `kind` is a **closed catalog**: `diff | log | test_report |
lint_report | ai_judgment | human_note | commit_set | checkpoint | preview |
generic_file`. Each row carries a **validity FSM**: `current | stale |
superseded | failed | skipped`. Supersession and staleness **mutate** `validity`
and set `superseded_by_id` — rows are **never deleted** (append-and-mark, so the
evidence graph stays historically complete and auditable).

The following are **explicitly out of M12 scope** (deferral list, recorded so
they are not silently assumed): a content-addressed blob store; an artifact
marketplace; benchmark datasets; rich preview sandboxing; cross-run artifact
reuse; full payload-schema validation for every `kind`; external ingestion
beyond M16.

**Consequences:**

- Enables the M12 evidence graph and review-refusal gates: a gate can query
  `artifact_instances` for `current` evidence of a required `kind` and refuse
  when it is missing or `stale`, without touching the payload bytes.
- No new `MaisterError` code — `CONFIG` (malformed/over-declared artifact intent)
  and `PRECONDITION` (required evidence absent) cover the failure modes;
  [ADR-008](#adr-008-typed-error-taxonomy-maistererror) stays a closed union.
- The DB never holds payload bytes, so it cannot drift from disk/git; the
  `locator` is the single dereference path and git remains the source for diffs.
- The closed `kind` catalog and validity FSM are a contract: adding a `kind` or a
  validity state is itself an ADR-worthy change, not a silent schema edit.

**Alternatives Considered:**

- **Store payloads in Postgres (bytes or JSONB per artifact):** double-stores
  what is already on disk/in git, bloats the DB, and drifts. Rejected — index
  metadata + `locator` only.
- **Open/free-form `kind` string:** loses the discriminated payload contract and
  lets nodes emit un-gateable evidence types. Rejected — closed catalog.
- **Hard-delete on supersession/staleness:** breaks audit and the historical
  evidence graph; a superseded judgment must remain inspectable. Rejected —
  mutate `validity` + `superseded_by_id`, never delete.

---

### ADR-038: Hybrid write path for `artifact_instances` (refines ADR-022)

**Date:** 2026-06-01
**Status:** Accepted
**Context:** [ADR-037](#adr-037-typed-artifact-model) makes
`artifact_instances` the evidence index. Two producers see different slices of
the truth: the **runner** (graph + linear) knows node/step boundaries and the
artifacts a node deterministically produces (diff, commit set, lint/test report,
AI judgment, human note, checkpoint, default log, guard metrics); the **web
tier** sees the supervisor **event stream** and can derive evidence the runner
cannot observe (per-tool-call activity, preview URLs). The no-`fs.watch` /
no-`chokidar` / no-polling rule (root CLAUDE.md §1) forbids a watcher driving
state. [ADR-022](#adr-022-structured-run-data-projection--runeventsjsonl-is-the-event-log-postgres-holds-derived-read-models) is the web-side projector pattern that this ADR refines and
scopes.

**Decision:** Two write paths into **one** index:

1. **Runner-inline.** Graph and linear runners record artifacts at node/step
   boundaries: `diff`, `commit_set`, `lint_report`, `test_report`,
   `ai_judgment`, `human_note`, `checkpoint`, a default `log`, plus guard
   metrics. Deterministic primary keys: `run:<nodeAttemptId>:<artifactDefId>`
   for declared artifacts and `run:<nodeAttemptId>:default:<kind>` for the
   per-node defaults.
2. **A scoped ADR-022 web-side projector.** It derives **event-stream-only**
   evidence the runner cannot see: tool-call activity (`log`) and `preview`
   URLs.

Idempotency is by **deterministic PK**: re-execution / replay **upserts**
(`onConflictDoUpdate`) — no partial-unique-index gymnastics. The projector uses
**two-phase cursor ordering**: in ONE db transaction it upserts the derived
artifacts THEN advances the cursor `last_monotonic_id`. There is **no watcher** —
the projector is a **PULL** at runner sync points plus an **idempotent startup
catch-up sweep**. This honors the no-`fs.watch`/`chokidar`/polling rule: the
projector *derives data, never drives state*.

**Phase-0 re-confirmation correction (stated explicitly):** the supervisor event
log is the **RUN-scoped** `.maister/<projectSlug>/runs/<runId>/run.events.jsonl`
— one file per run, shared across all steps (confirmed at
`supervisor/src/spawn.ts:124-136`). `monotonicId` is **RUN-GLOBAL** and strictly
increasing (seeded by `tailMaxMonotonicId` on each spawn, `spawn.ts:32` and
`spawn.ts:140-143`); event lines carry `sessionId`, **not** `stepId`.
Therefore:

- the projector cursor scope is **per-RUN** (cursor PK `<runId>`);
- the projector artifact PK is `proj:<runId>:<monotonicId>` (**NOT**
  `proj:<runId>:<stepId>:<monotonicId>`);
- node-attempt attribution is by joining `event.sessionId ===
  node_attempts.acp_session_id` (unmatched → run-level `NULL`).

This corrects the plan's §11.1 ratified default, which assumed a per-step log.

**Consequences:**

- [ADR-022](#adr-022-structured-run-data-projection--runeventsjsonl-is-the-event-log-postgres-holds-derived-read-models) stays "lands with M12" — this ADR scopes it, it does not reopen it.
- The M11 `node_attempts` ledger remains **runner-owned**; the projector never
  writes it.
- The projector **never reassembles diffs** — git is the source for diff
  payloads; the projector only derives `log` and `preview` evidence from the
  event stream.
- One index, two producers, deterministic PKs → replay/restart is safe (upsert),
  and the per-RUN cursor + two-phase transaction guarantee at-least-once derive
  with exactly-once effect.

**Alternatives Considered:**

- **Per-step event log + `proj:<runId>:<stepId>:<monotonicId>` PK (plan §11.1
  default):** the supervisor log is per-RUN with a RUN-GLOBAL `monotonicId` and
  no `stepId` on event lines (verified, `spawn.ts:124-136`). Rejected — corrected
  to per-RUN cursor and `proj:<runId>:<monotonicId>`.
- **A single runner-only write path:** the runner cannot see tool-call activity
  or preview URLs that exist only in the event stream. Rejected — the scoped
  projector covers the event-stream-only slice.
- **A watcher (`fs.watch`/`chokidar`) feeding the projector:** violates root
  CLAUDE.md §1 and lets a derived index drive state. Rejected — PULL at sync
  points + idempotent startup sweep.
- **Partial-unique-index idempotency instead of deterministic PKs:** more moving
  parts and brittle under replay. Rejected — deterministic PK + `onConflictDoUpdate`.

---

### ADR-039: `@xyflow/react` + `@dagrejs/dagre` as the evidence-graph renderer

**Date:** 2026-06-01
**Status:** Accepted
**Context:** M12 ships a **read-only evidence-graph explorer** in the web UI:
nodes (run nodes + their typed artifacts from
[ADR-037](#adr-037-typed-artifact-model)) and edges (flow transitions,
supersession, staleness). It must render HeroUI chips *inside* graph nodes,
auto-layout a directed graph left-to-right, and be read-only (no editing
affordances). `web/CLAUDE.md` says "no other component lib" — that rule needs an
explicit carve-out before adopting a graph renderer.

**Decision:** Adopt **React Flow** (`@xyflow/react` v12+; React 19.2 peer
dependency verified at install) plus **`@dagrejs/dagre`** for the read-only
evidence-graph explorer. Rationale: graph nodes are **React components** (HeroUI
chips render inside them), React Flow has **first-class read-only mode**,
`@dagrejs/dagre` gives **LR auto-layout**, and both are **React 19 compatible**.
This ADR records the **sanctioned exception** to `web/CLAUDE.md` "no other
component lib": that rule governs **component KITS** (HeroUI is the sole kit);
React Flow is a **visualization primitive**, not a component kit, so it does not
breach the rule. The explorer is **client-only** (`"use client"` +
`next/dynamic` with `ssr:false`) and imports `@xyflow/react/dist/style.css`.

**Consequences:**

- MAIster's **first interactive UI dependency beyond HeroUI**; the exception is
  scoped to graph visualization, not general components.
- **Client-bundle only** — no env var, no port, no `compose.*` change; the
  dependency never reaches the supervisor or the server tier.
- `web/CLAUDE.md` is updated to cite this ADR at the "no other component lib"
  rule so the carve-out is discoverable from the rule it qualifies.

**Alternatives Considered:**

- **Cytoscape.js:** nodes are not React components, so HeroUI chips cannot render
  inside them. Rejected — graph nodes must be React.
- **reaflow:** maintenance concerns. Rejected.
- **Hand-rolled SVG:** explicitly rejected by the user; reinvents layout,
  panning, and read-only interaction that React Flow provides. Rejected.

---

### ADR-040: Assignment actors and role-owned work queue

**Date:** 2026-06-02
**Status:** Accepted
**Context:** M13 turns waiting human work into a durable, queryable queue without
changing the existing HITL, manual-takeover, or M12 evidence contracts.
`hitl_requests` currently stores the payload that unblocks a run; manual
takeover ownership lives on `node_attempts.owner_user_id`; and M12
`artifact_instances` is the queryable evidence index. None of those tables is
the right place to model "who owns this waiting item now" or "which Flow role
should see it." At the same time, an actor in MAIster is not always a human:
future external systems will act through project API tokens, internal MAIster
agents may perform system work, and lifecycle automation already needs system
attribution. M13 must model those identities now without enabling new
token-authenticated write paths before the external-operations milestone.

**Decision:** Add an assignment layer with four concepts:

1. **Flow role registry.** `project_flow_roles` stores project-scoped routing
   labels such as `reviewer`, `qa`, or `release-manager`. These roles come from
   `maister.yaml` / Flow configuration and are validated at launch and sync
   boundaries, but they are **not RBAC** and do not replace
   `project_members.role`. Authorization remains
   `requireProjectAction(..., "answerHitl")`; in M13 a role mismatch is visible
   context only and never blocks claim, release, HITL response, takeover,
   return, abandon, or promotion.
2. **Actor identities.** `actor_identities` is the attribution primitive for
   `user`, `api_token`, `internal_agent`, and `system` actors. M13 resolves UI
   and web API requests only to `user` actors derived from Auth.js plus project
   authorization. `api_token` rows are schema-supported for future M16 external
   operations and read-only imported attribution; M13 does not add token
   secrets, token authentication, token-scoped permissions, or any unauthenticated
   write route.
3. **Assignments.** `assignments` is the durable wait/ownership object over
   existing waits: ACP permission HITL, form/human HITL, graph human review, and
   manual takeover. It stores the current status, role snapshot, optional claim
   actor, and links to the relevant run, HITL request, node attempt, and evidence
   where applicable. `hitl_requests` remains the response payload source of
   truth; `node_attempts` remains the runner/takeover ledger; `artifact_instances`
   remains the evidence source of truth.
4. **Assignment events.** `assignment_events` is append-only audit for create,
   claim, transfer, release, complete, cancel, and stale/terminal closure. Events
   reference `actor_identities`, including `system` for lifecycle closures. A
   completion event is written only after the side effect it describes succeeds:
   HITL delivery, takeover return/evidence recording, release, abandon, or run
   terminal reconciliation.

M13 keeps the existing run status vocabulary (`NeedsInput`, `NeedsInputIdle`,
`HumanWorking`, terminal states), supervisor API, and `MaisterError` union. No
new deployment wiring, environment variable, supervisor route, or external-token
ingress is introduced.

**Consequences:**

- Boards and inboxes can query one assignment surface instead of inferring
  ownership from raw HITL rows or takeover fields.
- Flow-role configuration becomes fail-fast and testable while staying separate
  from project authorization.
- Non-human actors are represented consistently before M16, avoiding a later
  human-only schema migration, but those rows do not grant access in M13.
- M12 evidence remains authoritative for stale/merge-blocked/readiness badges;
  assignments may summarize or link evidence, but never duplicate artifact
  validity state.
- Route DTOs must project assignment fields explicitly and must not expose
  `acp_session_id`, supervisor handles, filesystem worktree paths, token
  material, or raw DB rows. Assignment write routes derive project, run, HITL,
  node-attempt, and actor identifiers from URL parameters, Auth.js context, and
  server state; request bodies never carry cross-resource IDs.

**Alternatives Considered:**

- **Overload `project_members.role` as Flow routing.** Rejected because project
  membership is authorization and Flow roles are delivery labels; mixing them
  would make role mismatch a security decision and block useful work.
- **Use `hitl_requests` as the queue table.** Rejected because HITL rows carry
  unblock payloads, not ownership lifecycle, and manual takeover is not always a
  HITL payload.
- **Add human-only owner columns.** Rejected because MAIster actors include
  external systems, internal agents, and system automation; a human-only schema
  would force a redesign for M16.
- **Implement API-token ingress in M13.** Rejected because the external
  operations surface belongs to M16. M13 stores attribution-ready identities but
  only Auth.js users can act through the web routes.
- **Add new run statuses or supervisor routes.** Rejected because assignment
  ownership is a web-tier durable read/write model over existing lifecycle
  states and does not require supervisor protocol changes.
---

### ADR-041: Capability registry refs + agent-aware mapping + runner-owned native materialization

**Date:** 2026-06-02
**Status:** Accepted
> **Delivery half superseded by [ADR-044](#adr-044-capability-delivery-via-settingslocaljson--acp-newsession-cli-flag-mechanism-disproven):** the CLI-flag/preArgs delivery mechanism was disproven; capability now ships via `.claude/settings.local.json` + ACP `newSession`. The registry/resolver/ledger half here stands.
> **Amended by [ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality) (2026-06-11):** gate-chat L2 permission auto-deny is best-effort within this instructed-only model; the L3 mutation sensor is the hard neutrality guarantee.
**Context:** [ADR-031](#adr-031-node-typed-settings-schema-carve-b) shipped typed
node `settings` but deferred the **positive** half of roadmap criterion #6 to
M14: resolving `mcps:[github]` / `skills:[…]` / `tools:[…]` /
`restrictions:[…]` / `settingsProfile` references against a project capability
registry, mapping abstract capability names to concrete per-agent artifacts, and
**materializing** real adapter config (`settings.json`, `.mcp.json`, skill dirs)
into the run so the boundary is genuinely enforced rather than merely declared.
The scratch-run capability libraries (`web/lib/capabilities/{types,catalog,
resolver,materialize}.ts`) already exist but are wired for scratch runs only and
their materializer is a load-bearing stub (`provisioningBoundary: "…native
adapter provisioning is future work."`). M14 must wire that path to Flow runs,
record the result as run evidence, and provision natively — **without** reopening
M12's closed artifact-kind catalog ([ADR-037](#adr-037-typed-artifact-model)),
its projector / validity-FSM, or the supervisor wire contract. The supervisor
already accepts `capabilityProfilePath` + `adapterLaunch.env/preArgs/postArgs`
(`supervisor/src/types.ts`) and stays dumb. Two non-obvious hazards must be
locked here: (1) secret leakage into the agent worktree, and (2) cleanup of
scoped materialized files running OUTSIDE any live `runFlow` (the abandon route
and the crash reconciler act on already-terminal rows, where throwing is
incoherent).

**Decision:**

1. **AD-1 — Materialization plan lives in the ledger, not a new artifact kind.**
   The resolved + materialized per-node plan is stored as a
   **`node_attempts.materialization_plan` jsonb column** (migration `0019`),
   mirroring the existing `enforcement_snapshot` column — NOT an
   `artifact_instances` row and NOT a new `kind`. This satisfies "records it in
   the run ledger" and the snapshot-immutability requirement without touching
   M12's closed artifact-kind catalog, projector, validity FSM, or evidence-graph
   fan-out. The jsonb shape is
   `{ profileDigest, resolvedRevisions:[{refId,kind,sha}], materializedFiles:[paths],
   enforcedClasses, instructedClasses, refusedClasses, cleanup:{status,error?,at} }`.
2. **AD-2 — No separate flow-run profile table.** `scratch_capability_profiles`
   stays scratch-only. Flow runs persist the resolved profile INSIDE
   `materialization_plan` (digest + per-capability resolved revisions +
   materialized file paths). One source of truth, no second table to reconcile.
3. **AD-3 — Native provisioning is per-agent, per-session-scope, inside the
   worktree, runner-owned.** Concrete files are written into
   `worktreePath/.maister/capabilities/<runId>/<nodeAttemptId>/` (node-scoped)
   **before** `POST /sessions`; the dir is passed via `capabilityProfilePath` and
   concrete adapter flags via `adapterLaunch.preArgs`. The supervisor stays dumb
   (it already supports both fields). **All** adapter-specific knowledge lives in
   a new pure module `web/lib/capabilities/agent-map.ts`
   (`mapProfileToAgentArtifacts(profile, agent)`), which closes the
   `config.ts:745` carve-b stub by validating node-settings refs
   (`mcps/skills/restrictions/settingsProfile/tools`) against the project
   capability registry.
4. **Secret boundary.** Secret values — env-profile values AND any credential an
   MCP-server config carries — are **NEVER** written into the agent worktree and
   **NEVER** persisted to the ledger or surfaced in the UI. They reach the adapter
   ONLY via `adapterLaunch.env`, which `spawn.ts` injects into the child process
   and never writes to disk. Worktree config files (`settings.json`, `.mcp.json`)
   reference secrets **by env-var NAME only** (e.g. `"token": "${GITHUB_TOKEN}"`,
   never the literal). Catalog / ledger / logs / SSE keep env redacted to
   key-names.
5. **Cleanup is a RECOVERABLE state machine, not a hard crash.** A scoped-cleanup
   substate `{status: pending|done|failed, error?, at}` persists inside
   `materialization_plan.cleanup`. In-`runFlow` seams best-effort `rm` the node
   dir after `deleteSession`; on failure they record `cleanup.failed`, ERROR-log,
   and continue (a leftover non-secret config dir is low-severity — secrets are no
   longer in the worktree). **Post-terminal seams** (the abandon route, the crash
   reconciler) best-effort `rm`, record `cleanup.failed`, and **NEVER throw
   `CRASH`** — the row is already terminal. A strict cleanup sweeper (extending the
   existing GC pass) and the M19 worktree GC are the two backstops; a persistently
   `cleanup.failed` plan stays operator-visible in run-detail.

No new `MaisterError` code — [ADR-008](#adr-008-typed-error-taxonomy-maistererror)
stays a closed union; `CONFIG` (over-declaration / mid-session profile mismatch)
and the now-live `EXECUTOR_UNAVAILABLE` ([ADR-042](#adr-042-conservative-spike-gated-enforcement-flip-claude-first))
cover the new failure modes. Imports reuse the flow-install pipeline per
[ADR-043](#adr-043-capability-import-reuses-the-flow-install-fetchtrustexecute-pipeline).

**Consequences:**

- One migration (`0019`) adds the `capability_imports` table AND the
  `node_attempts.materialization_plan` column (the cleanup substate rides in the
  same jsonb — no extra column for cleanup tracking).
- The closed M12 artifact catalog is untouched: no `materialization_plan` kind,
  no projector edit, no validity-FSM change.
- The supervisor wire contract is unchanged; the materialized dir + adapter flags
  flow through the already-existing `capabilityProfilePath` / `adapterLaunch`
  fields.
- A grep of the entire materialized `.maister/capabilities/**` tree, the
  `materialization_plan` ledger, and any UI payload for every secret value MUST
  return absent — this is a standing regression.
- Cleanup failure never crashes a terminal run; the residual risk (an operator
  ignoring a persistently-failing sweep) is surfaced in the run-detail capability
  view, not hidden.

**Alternatives Considered:**

- **New `artifact_instances` kind for the materialization plan:** reopens M12's
  closed catalog and forces projector / validity-FSM / evidence-graph fan-out for
  an internal evidence object the UI reads once. Rejected — ledger jsonb column.
- **Separate flow-run profile table:** a second source of truth to reconcile
  against the ledger. Rejected — the plan rides in `materialization_plan`.
- **Teach the supervisor to materialize:** spreads adapter-specific knowledge
  across the wire boundary and breaks the "supervisor stays dumb" invariant
  ([ADR-002](#adr-002-supervisor-runs-as-a-separate-node-daemon)). Rejected — all
  mapping lives in `web/lib/capabilities/agent-map.ts`; the supervisor only
  injects env and forwards flags.
- **Write a plaintext env file into the worktree for the adapter to read:** puts
  secrets on disk in the worktree the agent can read and exfiltrate. Rejected —
  secrets travel ONLY through `adapterLaunch.env`.
- **Throw `MaisterError("CRASH")` on any cleanup failure (the strict model):**
  incoherent on the post-terminal seams (abandon route, crash reconciler) that run
  outside `runFlow` on already-terminal rows. Rejected — recoverable substate +
  sweeper backstop.

---

### ADR-042: Conservative spike-gated enforcement flip; claude-first

**Date:** 2026-06-02
**Status:** Accepted
> **Status note (2026-06):** the `instructed → enforced` flip authorized here is NOT yet executed — `ENFORCEABILITY_BY_AGENT` remains all-`instructed` (every cell `TODO(M14)`) as of M17, and the verdict table is unfilled. The gating policy is active; only the flip pends a live spike.
**Context:** [ADR-032](#adr-032-settings-enforcement-refusal-boundary) froze
`ENFORCEABILITY_BY_AGENT` (`web/lib/flows/enforcement.ts`) **all-`instructed`**
across both agents and all six capability classes (`mcps`, `tools`, `skills`,
`restrictions`, `permissionMode`, `workspaceAccess`), with a `TODO(M14)` on every
cell and an explicit note that the `permissionMode` spike (M11c Phase 0.10) was
**unverifiable** — no live adapter. ADR-032 also locked that the contract may
only ever *tighten*: a cell may flip `instructed → enforced` but never the
reverse, and flipping a cell activates the previously-dead `EXECUTOR_UNAVAILABLE`
branch in `assertNodeLaunchable`. M14 now materializes real adapter config
([ADR-041](#adr-041-capability-registry-refs--agent-aware-mapping--runner-owned-native-materialization)),
so cells *can* become genuinely enforced — but native provisioning does not
automatically mean the adapter honors it. A wrongly-`enforced` cell lets a
`strict` declaration PASS the launch gate while nothing constrains the agent —
the exact silent escape hatch criterion #6 forbids.

**Decision:** An `ENFORCEABILITY_BY_AGENT` cell flips `instructed → enforced`
ONLY after a **per-class, per-agent live-adapter spike** proves the materialized
config genuinely constrains the agent (a denied tool is unavailable; a
non-configured MCP server is absent; an unselected skill is not loaded;
`permissionMode` is honored). **Claude-first:** only `claude` cells are
candidates for flipping this milestone; **ALL six `codex` cells stay
`instructed`** with a documented rationale (codex-acp sandbox/config enforcement
is unproven), and codex enforced mapping is **Phase 2**. The `permissionMode`
cell MUST be **re-run live** before flipping — the M11c spike was unverifiable.
Where no live adapter is available in CI, the flip is gated on a documented manual
spike PLUS a CI mock asserting the *mechanism* (the correct flags/files are
emitted), stated explicitly — never a silent cap. Each `claude` cell NOT flipped
keeps `instructed` and replaces its `TODO(M14)` with a rationale comment
(`// M14: stays instructed — <reason from spike>`); each `codex` cell keeps
`instructed` with the codex-deferral rationale. No deny-list anywhere — the
launch/runtime guard stays an allow-list of `enforced` cells. This ADR tightens
ADR-032's frozen all-`instructed` table; it never loosens it.

**Verdict table (filled in Phase 5).** Rows are the six classes for **claude**;
`codex` is omitted (all cells stay `instructed`, Phase 2). To be completed from
the Phase-5 spike evidence:

| claude class | mechanism (materialized artifact / flag) | spike verdict | flipped? |
| ------------ | ---------------------------------------- | ------------- | -------- |
| `mcps` | `.mcp.json` (`--mcp-config`) | *(Phase 5)* | *(Phase 5)* |
| `tools` | `settings.json` allow/deny + agent-aware map | *(Phase 5)* | *(Phase 5)* |
| `skills` | materialized skill dirs | *(Phase 5)* | *(Phase 5)* |
| `restrictions` | `settings.json` restriction policy | *(Phase 5)* | *(Phase 5)* |
| `permissionMode` | `--permission-mode` (MUST re-run live) | *(Phase 5)* | *(Phase 5)* |
| `workspaceAccess` | workspace-scoping flags | *(Phase 5)* | *(Phase 5)* |

`spike verdict ∈ {enforced, not-verifiable}`; a cell flips iff `enforced`.

**Consequences:**

- Flipping any cell activates the previously-dead `EXECUTOR_UNAVAILABLE` branch
  in `assertNodeLaunchable`: a `strict` declaration on a class enforced for some
  agent but `instructed`/`unsupported` for the *resolved* executor's agent now
  refuses with `503`, not `400`.
- The M11c frozen-invariant test ("every cell is `instructed`") is **superseded**
  in this milestone — its assertion migrates to "cells {…flipped…} are
  `enforced`, the rest `instructed`"; this is the only milestone permitted to flip
  cells.
- A flow that launched under M11c never *starts* failing because a class became
  enforceable — the contract only tightens, so a previously-`instructed` strict
  declaration that was refused stays refused or becomes accepted, never the
  reverse.
- The bundled `aif` flow flips `enforcement.{tools|skills|permissionMode}` from
  `instruct → strict` ONLY for classes this ADR's table marks `enforced`; the rest
  stay `instruct`.
- Codex remains a fully-supported executor whose capability classes are
  `instructed` only — declaring `strict` on a codex-resolved node refuses with
  `CONFIG` until Phase 2.

**Alternatives Considered:**

- **Flip all cells now that materialization exists:** materializing config does
  not prove the adapter honors it; flipping unverified cells recreates the silent
  escape hatch. Rejected — per-(agent,class) spike gate.
- **Spike claude AND codex this milestone:** doubles the spike surface for an
  agent whose config-enforcement is unproven; codex enforced mapping
  (`config.toml` / `--sandbox`) is a separate Phase-2 design. Rejected —
  claude-first.
- **Trust the M11c `permissionMode` verdict and flip on materialization alone:**
  that verdict was explicitly *unverifiable* (no live adapter). Rejected — re-run
  live before flipping.
- **A deny-list of unenforceable classes:** inverts the safe default; a new class
  would be silently enforceable. Rejected — allow-list of `enforced` cells only.

---

### ADR-043: Capability import reuses the flow-install fetch→trust→execute pipeline

**Date:** 2026-06-02
**Status:** Accepted
**Context:** A project's named capabilities (MCP servers, skills, agent
definitions, restriction/settings profiles) can ship from git, exactly as Flow
packages do. [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
already established the Flow-install pipeline — clone-by-tag, record the resolved
40-hex SHA + manifest digest, two-phase install with a `package_status` marker, a
trust policy (`local`/`file://` + `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` ⇒
`trusted_by_policy`, else `untrusted`), and the **carryover rule that `setup.sh`
is NEVER run at install** (fetch and execute are physically separate). M14 must
import capability packages with the same safety properties; rebuilding a parallel
pipeline would duplicate the trust/path-safety machinery and risk diverging from
it. Two questions were open: (Q1) does M14 ship a trust-confirm route/UI or defer
it, and what is the idempotency marker; and how is path-traversal prevented when
an import `id`/`version` reaches a filesystem path or git op.

**Decision:** Capability imports **mirror** `installRevision`
(`web/lib/flows.ts`): clone-by-tag → `gitRevParseHead` → record the resolved
40-hex SHA + manifest digest + manifest jsonb + `trustStatus = resolveTrust(source)`
+ `setupStatus`, in a new `installCapabilityRevision` (`web/lib/capabilities/
import.ts`). Cache at `~/.maister/capabilities/<id>@<sha[:12]>/`; the
`capability_imports` row is keyed unique on `(projectId, capabilityRefId,
resolvedRevision)`. Trust is resolved via `resolveTrust` plus a new
`MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES` env var.

1. **Fetch and execute are PHYSICALLY SEPARATE functions.** `installCapabilityRevision`
   MUST NOT run `setup.sh` ([ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)
   carryover). `setup.sh` runs only via a separate `runCapabilityRevisionSetup`,
   gated on `trustStatus ∈ {trusted, trusted_by_policy}` AND
   `setupStatus ∈ {pending, failed}` — **idempotently re-runnable** after a
   transient failure, NOT one-shot.
2. **Trust route ships (Q1 decision).** M14 ships
   `POST /api/projects/[slug]/capabilities/[capabilityRefId]/trust` plus a UI
   confirm; third-party (untrusted) sources are visually marked and require
   explicit confirm before setup runs. The route's identifiers are
   `slug` (url-param → project server-state), `capabilityRefId` (url-param,
   validated against the project's import rows = server-state), and a body of
   only `{confirm:true}` (no cross-resource locator). Under `SELECT … FOR UPDATE`
   the order is `trustStatus='trusted'` (BEFORE) → `runCapabilityRevisionSetup`
   (side-effect) → `setupStatus='done'` (AFTER). The **idempotency marker is
   `setupStatus`, NOT `trustStatus`**: a post-trust setup failure leaves
   `trusted` + `failed`, and a re-POST re-runs setup; the route returns `409` ONLY
   when `setupStatus ∈ {done, not_required}` (genuinely nothing to do), NEVER
   merely because `trustStatus` is already set. Setup failure → `setupStatus='failed'`,
   `503` (retryable); setup network/timeout → `setupStatus` left `pending`, `503`.
3. **Path safety.** Every capability/import `id` and `version` that can reach a
   filesystem path or git op MUST validate against `SAFE_PATH_SEGMENT`
   (`/^[A-Za-z0-9._-]+$/`) + `notDotRef` (no `.`/`..`/embedded `..`), mirroring
   `flowIdSchema`/`versionSchema` (`web/lib/flow-paths.ts`). Validation is enforced
   **twice** (defence-in-depth): at the Zod schema AND inside the path builder
   `systemCapabilityCachePath`, which re-validates before constructing the path.
   An import `id` of `../evil`, `..`, or `a/b` is rejected at both layers and
   never reaches `~/.maister/capabilities/`; a traversal id passed directly to the
   path builder throws `MaisterError("FLOW_INSTALL")` and writes nothing outside
   the cache.

No new `MaisterError` code — `FLOW_INSTALL` carries import/path failures and
`CONFIG`/`EXECUTOR_UNAVAILABLE` cover the rest
([ADR-008](#adr-008-typed-error-taxonomy-maistererror) closed union).

**Consequences:**

- The import pipeline inherits ADR-021's two-phase-install + trust safety for
  free; no parallel machinery.
- One new env var (`MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES`) and one new
  on-disk cache prefix (`~/.maister/capabilities/`, sharing the existing
  `~/.maister` volume that already holds `flows/`).
- The trust route is **retry-safe**: a setup that fails after the trust write is
  recoverable by re-POST because the marker is `setupStatus`, not `trustStatus` —
  no spurious `409` strands a `trusted`+`failed` row.
- An untrusted source carrying an executable `setup.sh` MUST NOT execute it at
  install — a standing regression (sentinel-absent + `trustStatus='untrusted'`).
- Removing a `capability_imports[]` entry disables its `capability_records`
  (config-state symmetry).

**Alternatives Considered:**

- **A bespoke capability-import pipeline:** duplicates ADR-021's trust /
  path-safety / two-phase machinery and will drift from it. Rejected — mirror
  `installRevision`.
- **Run `setup.sh` at install (single fetch-and-execute function):** executes
  untrusted code before any trust decision — the exact hazard ADR-021 forbids.
  Rejected — physically separate fetch and execute.
- **Defer the trust route/UI to Phase 2:** leaves third-party imports either
  silently trusted or unusable; the roadmap "trust/install UX" expectation needs
  it now. Rejected — Q1 ships the route.
- **Use `trustStatus` as the route's idempotency marker:** a post-trust setup
  failure would strand a `trusted` row at `409` with setup never completed.
  Rejected — `setupStatus` is the marker, so a re-POST re-runs setup.
- **Single-layer path validation (schema only):** a path built from a
  server-state id that bypassed the schema would be unchecked. Rejected —
  defence-in-depth at schema AND path builder.
### ADR-045: External_check enforcement via the Review chokepoint; M16/M15/M18 carve

**Date:** 2026-06-02
**Status:** Accepted
> **Closed clause:** the "HITL `confidence`/`criticality` re-scoped to M17" pointer here is now resolved by [ADR-054](#adr-054-hitl-assessment-taxonomy--flow-declared-criticality-vs-responder-human_confidence-annotate-not-re-gate).
**Context:** M11a ([ADR-028](#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)) stubbed
`external_check` gates as `pending + TODO(M16)` — they are schema-valid and status-modelled but
not executed. M16 must wire the stub to a real outcome without introducing new `runs.status` values
or a suspend/resume cycle. The review chokepoint — `assertEvidenceReady(runId, phase, db)` in
`web/lib/flows/graph/evidence-readiness.ts` — already blocks promotion for engine ≥ 1.2.0 (see
[ADR-026](#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump)). ADR-024 deferred
`confidence`/`criticality` on HITL requests to a later milestone; their exact milestone must be
locked now to prevent double-engineering.

**Decision:** Enforce `external_check` gates by **extending `assertEvidenceReady`** — no new
`runs.status` value, no suspend/resume. A blocking `external_check` gate that is `pending | failed |
stale | skipped` resolves as NOT ready; `passed` and `overridden` are the only allow-listed states.
The report endpoint (`POST /api/v1/ext/runs/{runId}/gates/{gateId}/report`) flips the live gate
result row and records a `test_report` artifact in one transaction. Staleness is event-driven only:
(a) downstream rework via the existing `markDownstreamStale`; (b) `staleOnNewCommit` in the gate's
`flow.yaml` `external` block when a new `commitSha` supersedes the prior passed report. No sweeper.
Override path is the existing `markGateOverridden`. Milestone carve: **M16** owns the external-gate
loop end-to-end through review and mechanical staleness; **M15** owns readiness DSL, verdict
calibration, and readiness roll-up; **M18** promotion reuses the same readiness check without new
gate logic. HITL `confidence`/`criticality` (ADR-024 clause) are re-scoped to **M17**, not M16.

**Consequences:**

- No new `runs.status` value; the existing `Review` chokepoint is the single enforcement gate for
  all gate kinds including `external_check`.
- `assertEvidenceReady` gains an `external_check` allow-list branch — the only code change in the
  readiness evaluator.
- `staleOnNewCommit` is evaluated at report time (event-driven); no background staleness sweeper is
  introduced.
- M15 and M18 can be designed and implemented without revisiting the `external_check` execution
  model — the boundary is clean.
- HITL `confidence`/`criticality` fields are deferred to M17; M16 route handlers and schemas must
  not add them prematurely.

**Alternatives Considered:**

- **New `ExternalReview` run status (suspend/resume):** would require a new status enum value, a
  new keep-alive path, and a new recovery sweep — significant scope for a gate whose outcome
  already maps cleanly onto `passed`/`failed`/`stale`. Rejected — extend the existing chokepoint.
- **Execute at promotion time only (not at review):** leaves the run in a `passed-review` state
  with an unresolved external gate, which the readiness check must then re-evaluate at promotion.
  Rejected — single evaluation point at the Review chokepoint is simpler and consistent with all
  other gate kinds.
- **Assign `confidence`/`criticality` to M16:** they belong to the HITL assessment taxonomy,
  which is structurally aligned with M17 structured verdicts. Including them in M16 would
  couple the external-gate feature to an unrelated HITL schema change. Rejected — M17.

---

### ADR-046: Project API token model

**Date:** 2026-06-02
**Status:** Accepted
**Context:** ADR-024 reserved a project-scoped token model for the external surface but left the
implementation to M16. The token must be usable by CI pipelines, local scripts, and the MCP facade
([ADR-047](#adr-047-thin-mcp-facade-as-a-standalone-rest-client-package)) without piggybacking on
an Auth.js session. The threat model is a compromised token: it must grant only the addressed
project's API, must be revocable, and must leave an audit trail. The verification scheme must be
timing-safe and must not require a pepper or bcrypt (which are slow and unnecessary for
256-bit-random secrets).

**Decision:** Tokens are **project-scoped, 256-bit random**, formatted as `mai_` + base64url(32 bytes).
The first 12 characters of the full string serve as a `prefix` for indexed lookup. The secret is
stored as `sha256_hex(fullToken)` — no pepper, no bcrypt. Verification: extract prefix → `SELECT
WHERE prefix = ?` → `timingSafeEqual(sha256_hex(presented), row.token_hash)` → assert
`revoked_at IS NULL` AND (`expires_at IS NULL` OR `expires_at > now()`) → cross-check the addressed
resource's project against `token.projectId` (mismatch → 404, existence-hide). Token `scopes` are
enforced for every `/api/v1/ext/...` route: `*` grants the full project API for broad automation,
otherwise the route's required scope must be present. Every token-attributed call writes a row to
`token_audit_log` — mandatory per ADR-024. Auth errors are modeled as
`TokenAuthError(kind)` resolved by `httpStatusForTokenAuth(kind)` — **not** a `MaisterError` code
([ADR-008](#adr-008-typed-error-taxonomy-maistererror) closed union), mirroring the existing
`httpStatusForAuthz` pattern. Session-auth routes never accept tokens; token-auth routes never
accept sessions. Business logic (`createTask`, `launchRun`) is **decoupled from auth** into
`web/lib/services/*` so session-auth routes, token-auth routes, and the MCP facade all share one
service core without duplicating domain logic.

**Consequences:**

- Two new tables (`project_tokens`, `token_audit_log`) in migration `0020_m16_api_tokens.sql`;
  cascade chain: project → tokens → audit rows.
- The plaintext token is returned once at creation and is never stored or re-derivable; loss
  requires re-issuance.
- `sha256` at rest is appropriate for 256-bit-random secrets (brute-force is infeasible);
  bcrypt would add latency with no security benefit here.
- Scope enforcement is route-level: valid + active + project-matched is necessary, but the route's
  required scope must also be present unless the token holds `*`.
- The service-layer decoupling means MCP tool implementations are thin REST callers — they carry
  no business logic and cannot exceed the token's authority, satisfying ADR-024's thin-facade
  invariant.
- 403 (scope) is reserved but unused in v1; 404 is used for wrong-project (existence-hide).

**Alternatives Considered:**

- **bcrypt for token storage:** bcrypt is designed for low-entropy passwords; a 256-bit random
  token needs no stretching and bcrypt's latency would penalize every API call. Rejected — sha256.
- **Server pepper:** adds operational complexity (pepper rotation, secret management) with no
  material benefit for a 256-bit random secret. Rejected — no pepper.
- **Granular scope enforcement in v1:** requires concrete external consumers to know which scopes
  to request; none exist yet. A binary valid/invalid model is correct for v1. Rejected — scope
  labels for forward-compat only.
- **Session-token hybrid (accept either on all routes):** blurs the auth boundary, complicates
  audit attribution, and makes it impossible to audit-trace which surface a call used. Rejected —
  strict route-level separation.

---

### ADR-047: Thin MCP facade as a standalone REST-client package

**Date:** 2026-06-02
**Status:** Accepted
**Context:** ADR-024 mandated a thin MCP facade over the REST service layer. The facade must expose
MAIster capabilities to MCP-speaking clients (Claude Desktop, autonomous agents) without becoming
a second orchestration backend, bypassing authorization, or holding secrets that belong to the
web tier. The physical location of the package — inside the web package, in the supervisor, or as
a standalone workspace package — determines its coupling surface and its ability to be deployed
independently.

**Decision:** The MCP facade is a **standalone top-level `mcp/` workspace package** (`@maister/mcp`,
`@modelcontextprotocol/sdk`). It exposes **10 MCP tools** (8 core + `hitl_list`/`hitl_respond` added by [ADR-055](#adr-055-hitl-response-service--hitl-over-mcp--token-actor--actor-kindscope-auth-gates)) (task CRUD, run launch/read/readiness,
gate report) each implemented as a thin HTTP client of the corresponding `/api/v1/ext` route —
no DB access, no Drizzle, no supervisor dependency. **Transport-scoped auth**: under
**Streamable-HTTP** (the default, remote transport), the MCP server requires a per-request
inbound bearer token from the caller and forwards it verbatim to `/api/v1/ext`; it holds no
ambient token and returns 401 to the caller when the inbound bearer is absent or rejected by the
REST layer. Under **stdio** (local-only transport), the server reads `MAISTER_PROJECT_TOKEN` from
env. The two transports are explicitly separate; `MAISTER_PROJECT_TOKEN` is ignored under
Streamable-HTTP. `MAISTER_API_BASE_URL` configures the target REST endpoint in both transports.
Because all calls are proxied through `/api/v1/ext`, the audit trail in `token_audit_log` is
complete — the MCP facade produces the same audit rows as a direct REST caller. The facade
provably cannot exceed the token's authority (ADR-024 thin-facade invariant): it has no path
to the DB and every action is constrained by the REST layer's auth and validation.

**Consequences:**

- Zero coupling between `mcp/` and `web/` beyond the REST contract
  (`docs/api/external/operations.openapi.yaml`); the facade can be published and installed
  independently.
- No ambient token under Streamable-HTTP — each MCP tool invocation carries its own bearer,
  so multi-project MCP clients can use different tokens in the same session.
- The `stdio` transport is for local, trusted use (e.g. Claude Desktop on the same host);
  `MAISTER_PROJECT_TOKEN` is NOT a web-tier secret and is documented accordingly.
- Adding an MCP tool is adding one thin REST-call wrapper; no service logic lives in `mcp/`.
- The same `token_audit_log` that records direct REST calls records MCP-originated calls —
  one audit trail, no blind spots.

**Alternatives Considered:**

- **MCP facade inside `web/` (e.g. a route or a server-action):** couples the MCP transport to
  the Next.js lifecycle, prevents independent deployment, and requires exposing the MCP wire
  through Next.js middleware. Rejected — standalone package.
- **MCP facade with direct DB access (bypass REST):** violates ADR-024's thin-facade invariant,
  forks authorization and audit logic, and makes the facade a second control plane. Rejected —
  REST client only.
- **Single ambient token stored in the MCP server (no per-request bearer under Streamable-HTTP):**
  a stolen server process leaks a long-lived credential; multiple projects cannot share one
  running MCP server. Rejected — per-request inbound bearer, no ambient token.

---

### ADR-048: Readiness enforcement over all blocking gate kinds + verdict calibration (M15)

**Date:** 2026-06-03
**Status:** Accepted
**Context:** M11a ([ADR-028](#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)) ships
full gate _execution_ — the six gate kinds, the
`pending|running|passed|failed|stale|skipped|overridden` status lifecycle, `blocking|advisory`
modes, structured verdicts (incl. a parsed `confidence`), staleness propagation, and
override-without-erasure. M16 ([ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve))
added `external_check` ingestion and enforcement at the Review chokepoint via
`assertEvidenceReady(runId, "review")`. But three gaps remain, which are M15's scope:

1. **Partial enforcement.** `assertEvidenceReady` only consults two of the six gate kinds
   (`artifact_required` + `external_check`), and only when the engine gate
   `artifactEnforcementActive` (`compat.engine_min ≥ 1.2.0`, `runner-graph.ts`) is true. A blocking
   `ai_judgment`/`skill_check`/`command_check` gate that _executed and failed_ does not block
   promotion today.
2. **Verdict calibration is dead.** `parseVerdict` extracts a numeric `confidence` from
   `ai_judgment`/`skill_check` output and stores it on `GateVerdict`, but nothing ever consults it —
   a low-confidence "pass" passes.
3. **Fragmented readiness summary.** The board carries three bespoke badges
   (`externalGatePending`/`mergeBlocked`/`evidenceStale`), portfolio carries only
   `externalGatePending`, run-detail carries none, and `getRunReadiness` rolls up five states with
   no `overridden`. Each surface re-derives the verdict inline, risking divergence.

Bounded by [ADR-028](#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped) (gate execution is
M11a, not re-built here) and [ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve)
(the `external_check` loop is M16; **flow-run merge** enforcement is M18, which reuses this evaluator).

**Decision:**

- **Required-gate signal = the existing `mode: blocking`.** No new `readiness_policy` grammar (the AC
  defers a "complex policy language"). `blocking` already means "execution-abort on failure"; M15
  additionally reads it as "promotion-required". This conflation is accepted; a future
  `readiness_policy` block is purely additive.
- **Verdict calibration** = a per-gate `calibration.confidence_min` (0..1) plus an optional flow-level
  `verdict_calibration.confidence_min` default. The flow default is **folded into each gate's
  effective `calibration` at compile time** (`compile.ts`), so `gates-exec.ts` only ever reads
  `gate.calibration`. Calibration is applied **at execution** in the shared `ai_judgment` +
  `skill_check` case: it sets `gate_results.status` to the calibrated truth and persists the outcome in
  the existing `verdict` JSONB as `calibration: { confidenceMin, rawVerdict, outcome }` for
  observability. Because calibration decides `status` at execution time, the readiness evaluator only
  ever reads `status` and never needs to understand confidence.
  - **Fail-closed on missing confidence.** A pass-string with `confidence` **below** the threshold →
    `failed` (`outcome: "below_threshold"`). A pass-string with **no** `confidence` while a threshold
    is configured → **`failed`** (`outcome: "no_confidence"`) — fail-closed, because a promotion gate
    must not pass an unverifiable verdict (a fail-open here would be invisible downstream, since the
    evaluator reads only `status`). A per-gate `allow_missing_confidence: true` restores the lenient
    pass (intended for `skill_check` gates that legitimately emit no confidence). No threshold
    configured → unchanged legacy pass (`isPassVerdict`).
- **Drop the engine gate at the readiness chokepoint; enforce for all graph flows.** The
  `artifactEnforcementActive` guard wrapping the `assertEvidenceReady` call in `runner-graph.ts` is
  removed (surgically — only that call site), and the evaluator is extended from two kinds to **all
  evaluated blocking gate kinds**. `MAISTER_ENGINE_VERSION` stays **1.2.0** (no bump). Justified by
  "no production flows yet" and by the new fields being optional/additive. Linear `steps[]` flows
  (old `runner.ts`) never call the evaluator and are unaffected.
- **Blocking `human_review` is rejected at validation (`CONFIG`).** `gates-exec.ts` always records a
  `human_review` gate as `skipped` (the real human decision happens at node finish), so a _blocking_
  one would make the run permanently un-promotable. `validateGraphManifest` now rejects it. Advisory
  `human_review` is allowed; the bundled `aif` flow uses a human _node_, not a `human_review` gate.
- **Single source of truth: `readiness-core.ts`.** A new pure module owns live-attempt collection,
  external-gate collapse, the per-kind allow-list (`passed`/`overridden` clear a blocking gate), and
  the priority classifier. It is consumed by the enforcer (`assertEvidenceReady`), the read-model
  (`getRunReadiness`), and the board/portfolio bulk queries — so all four classify identically. The
  board and portfolio call it over **bulk-fetched** rows (no per-run `getRunReadiness`, no N+1).
- **`overridden` is a distinct surfaced state.** The unified summary is
  `ready | blocked | stale | failed | waiting | overridden`, with priority
  **`failed > stale > blocked > waiting > overridden > ready`**.
- **Merge-phase guard is wired into the scratch promote route as a reusable call site only.**
  `assertEvidenceReady(runId, "merge")` is invoked in the scratch promote route for future-proofing
  and call-site reuse. This is **NOT** M15 coverage of the AC's "merge refuse" clause: scratch runs
  carry no flow gates, so the check is vacuously ready in production. Real flow-run merge enforcement
  is **deferred to M18**, which owns flow-run promotion and reuses this same evaluator.
- **No schema migration, no new error code, no new run status.** Calibration rides the existing
  `verdict` JSONB; `gate_results.status` already includes `overridden`; the existing `CONFIG` and
  `PRECONDITION` codes cover the new failures.

**Consequences:**

- A blocking gate of any executed kind (`command_check`/`ai_judgment`/`skill_check`/
  `artifact_required`/`external_check`) that is missing, pending, running, failed, stale, or skipped
  now refuses Review for **every** graph flow — not just the two kinds, not just engine-gated flows.
  Existing integration tests asserting the old two-kind / engine-gated behavior are updated in lockstep.
- `assertEvidenceReady` returns `{ ready, reasons }` (it does not throw); the runner converts a
  not-ready verdict into a `PRECONDITION` node/run failure at the Review transition — unchanged call
  convention, broadened inputs.
- Calibration changing `status` at execution means a calibrated-down `ai_judgment` shows as `failed`
  everywhere (board badge, run-detail, read-model) with no extra wiring, because every surface reads
  `status` through the shared core.
- Fail-closed missing-confidence can surprise a flow author who sets a threshold but whose agent emits
  no `confidence`; `allow_missing_confidence` and the `no_confidence` outcome string make the failure
  self-explaining.
- The scratch merge guard is honest future-proofing; the M15 as-built note and the readiness domain
  doc both record that genuine merge enforcement is M18.

**Alternatives Considered:**

- **A new `readiness_policy` DSL block (per-gate required/optional, phase lists).** Rejected for M15 —
  the AC explicitly defers a complex policy language; `mode: blocking` already carries the signal.
  Additive later.
- **Calibrate in the readiness evaluator (read confidence at Review time).** Rejected — it would force
  the evaluator, the read-model, and both bulk card queries to each re-implement the
  confidence→status mapping, multiplying the divergence risk the shared core exists to remove.
  Deciding `status` once at execution keeps every downstream reader confidence-agnostic.
- **Fail-open on missing confidence.** Rejected — a promotion gate that passes an unverifiable verdict
  defeats its purpose, and the failure would be invisible downstream. Fail-closed with an explicit
  opt-in is the conservative default.
- **Bump `MAISTER_ENGINE_VERSION` and gate enforcement on the new version.** Rejected — there are no
  production flows to protect, the new config fields are optional, and a version gate would silently
  exempt every existing flow from the very enforcement M15 adds.
- **Per-card `getRunReadiness` for board/portfolio badges.** Rejected — N+1 over every active run.
  The shared classifier runs over bulk-fetched rows instead.

### ADR-044: Capability delivery via `settings.local.json` + ACP `newSession` (CLI-flag mechanism disproven)

**Date:** 2026-06-03
**Status:** Accepted
**Context:** [ADR-041](#adr-041-capability-registry-refs--agent-aware-mapping--runner-owned-native-materialization)
specified native materialization as writing per-node config files and passing them to the claude
adapter via CLI flags (`--settings`, `--mcp-config`, `--permission-mode`). Before the Phase-5 flip, a
code-level spike against the installed `@agentclientprotocol/claude-agent-acp@0.37.0` +
`@anthropic-ai/claude-agent-sdk@0.3.146` **disproved that mechanism**: the adapter entry
(`dist/index.js`) only checks `--cli` and ignores every other argv in ACP mode; the supervisor's
`newSession` hardcoded `mcpServers: []`; and the SDK reads settings only from
`<cwd>/.claude/{settings.json,settings.local.json}` (cwd = the worktree) and MCP servers from ACP
`newSession params.mcpServers`. So the ADR-041 materialized files/flags were written but never
applied — the agent ran unconstrained. R-CONSERVATIVE forbids flipping a disproven mechanism.

**Decision:** Deliver capability config through the channels the adapter actually reads. This
**supersedes the delivery half of ADR-041** (the registry/resolver/ledger/cleanup machinery of
ADR-041 stands unchanged; only the agent-facing delivery surface changes):

- **`tools` + `permissionMode`** → written into `<worktree>/.claude/settings.local.json` (the SDK
  "local" settings tier; highest-precedence, conventionally gitignored, MAIster-owned, easy cleanup).
  `permissions.allow` = the node's `tools.<agent>` allow-list; `permissions.defaultMode` maps the
  node `permissionMode` `ask→default`, `allow→bypassPermissions`, `deny→plan`. A pre-existing
  settings.local.json is backed up once (`.maister-bak`) and restored at run-terminal cleanup.
- **`mcps`** → ACP `newSession params.mcpServers`. The web→supervisor `StartSessionRequest.mcpServers`
  carries env-var **names only** (`envKeys`); the supervisor resolves each name → value from its OWN
  `process.env` at spawn time. Secrets therefore never travel the web→supervisor wire, never hit disk
  (no `.mcp.json` in the worktree), and are never logged/persisted — a net R-SECRET improvement over
  ADR-041's `adapterLaunch.env` value-on-wire path, which this removes.
- The dead `--settings`/`--mcp-config`/`--permission-mode` `preArgs` are removed.
- `skills`, `restrictions`, `workspaceAccess` map to settings.local.json fields the adapter supports
  (`skillOverrides`, `permissions.deny`, `permissions.additionalDirectories`) but are NOT emitted this
  milestone — they stay `instructed` (Phase 2 / follow-up).

The delivery **mechanism** is CI-verified (the runner writes the correct settings.local.json and the
supervisor forwards the resolved `mcpServers` to `newSession` — asserted by mock-adapter tests).
Whether the delivered config actually CONSTRAINS the agent is still gated on the
[ADR-042](#adr-042-conservative-spike-gated-enforcement-flip-claude-first) live spike.

**Consequences:**

- settings.local.json / `.maister-bak` live in the agent worktree root and are reclaimed once per run
  by `cleanupRunMaterializations`; they cannot reach a `local_merge`/PR promotion (merge uses committed
  history; the run diff is commit-range) — a defensive `.git/info/exclude` is a tracked follow-up.
- `allow→bypassPermissions` silently degrades to `default` when the supervisor runs as root (the
  adapter disables bypass as root) — the live spike must run non-root to verify the `allow` path.
- MCP server definitions are passed transiently over ACP, never written to the worktree.

**Alternatives Considered:**

- **Patch/fork the adapter to parse `--settings`.** Rejected — forking a pinned upstream binary for a
  flag it deliberately ignores; the SDK already reads `.claude/settings.local.json` natively.
- **`.mcp.json` at the worktree root for MCP.** Rejected — `.mcp.json` is conventionally committed, so
  writing/removing it clobbers the project's real MCP config and risks promotion leakage; ACP
  `params.mcpServers` is transient and clobber-free.
- **Keep delivering secret VALUES via `adapterLaunch.env`/`.mcp.json` placeholders.** Rejected — both
  put secret material on the wire or on disk; resolving env names host-side in the supervisor keeps
  secrets in `process.env` only.

---

### ADR-058: Branch targeting at launch, shared promotion service, promote-time readiness re-gate (M18/M15 carve)

**Date:** 2026-06-03
**Status:** Accepted
**Context:** Before M18 a run's worktree always forked the parent repo `HEAD` and promotion existed
only for **scratch** runs in `local_merge` mode: `POST /api/runs/{runId}/promote` rejects
`runKind !== "scratch"`, `mode: "pull_request"` throws `CONFIG` "not implemented", and
`assertPromotionTargetAllowed` hard-locks the target to the scratch base branch. **Flow** runs
dead-end at `Review` — `promoteAfterExit` only schedules the next pending run, nothing promotes the
current one. The branch fields needed to record what a run was built from and merges into
(`baseBranch`/`baseCommit`/`targetBranch`/`promotionMode`) live on `scratch_runs` and are absent from
the flow run ledger; `database-schema.md` already pre-declares them as "Planned M18" on `workspaces`.
The existing promote route is also **not retry-safe**: it loads rows with no `FOR UPDATE` and no
terminal-status guard, then calls `promoteLocalMerge()` outside any transaction, so two concurrent
promotes can both pass the load-time `Review` check and both run the merge. M18 must (a) let launch
pick where a run builds from and merges into, (b) generalize promotion to flow runs across both
modes, (c) re-check readiness at promote time because gates can go stale between Review-entry and the
promote click, and (d) close the concurrency hole — all without introducing a new `runs.status`
value and its all-consumers fan-out. The readiness machinery itself (M16 `assertEvidenceReady`,
`getRunReadiness`) already exists; the M15 readiness-policy DSL does not, and M18 must not depend on
it ([ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve) drew the
M16/M15/M18 carve).

**Decision:** Ship branch targeting and a shared promotion service for M18, against pre-M15 readiness
semantics:

- **Branch targeting at launch.** Launch picks a **base branch** (default `project.default_branch`)
  plus an optional **target branch** (default = base); the normal path stays one-click via an
  advanced disclosure. The worktree is created **from the selected base commit** (`addWorktree`'s
  existing `startPoint`, wired through from `resolveBaseCommit(base)`). The run ledger
  (`workspaces` table) records `base_branch`, `base_commit` (the resolved commit), the run branch
  (`workspaces.branch`), `target_branch`, and `promotion_mode`. Both `baseBranch` and `targetBranch`
  are body-controlled and MUST be validated against `listBranches(project.repoPath)` (a server-state
  allow-list) before any use as a git ref or `startPoint`; an unknown branch is refused
  `PRECONDITION`. Branch names are never shell-interpolated.
- **Shared `promoteRun` service drives BOTH run kinds.** The route dispatches on `runKind`; one
  service generalizes today's scratch-only `local_merge` to flow runs and (per
  [ADR-049](#adr-049-pr-promotion-via-a-hybrid-provider-pradapter-credential-model-b-reverses-the-gh-is-never-invoked-invariant))
  `pull_request`. `assertPromotionTargetAllowed` is relaxed for flow runs (the validated target may
  differ from base). The pre-M18 **scratch behavior is pinned by regression tests** — the existing
  scratch promote suite stays green.
- **Promote-time readiness re-gate reuses the M16 chokepoint.** Promotion calls the same
  `assertEvidenceReady(runId, "review")` as a **second** enforcement point (the first is at
  Review-entry); gates can go stale between Review-entry and the promote click. Overridden gates
  satisfy promotion via the existing `{passed, overridden}` allow-list — that is the "explicitly
  overridden" path. This is an **ADR-045-consistent M18/M15 carve, NOT an implementation of M15**:
  the M15 readiness-policy DSL, verdict calibration, and `external_check` ingestion semantics beyond
  the M16 generic report contract are explicitly out of M18 scope. When M15 lands, its readiness
  policy plugs into the same chokepoint with no rework of the promote path.
- **Terminal status stays `Done` for both modes.** M18 adds **NO** new `runs.status` value — this
  deliberately avoids the all-consumers fan-out blast radius. `local_merge` success → `Done` (matches
  scratch and the `runs.md` state machine). `pull_request` success → `Done` with `pr_url`/`pr_number`
  recorded; MAIster does not track the PR to merge in M18 (deferred).
- **Two-phase commit + idempotency contract.** The serialization point is a **durable promotion
  claim committed BEFORE any side-effect**, not a held row lock (a held lock cannot span the slow
  git/PR call without becoming a long transaction around external I/O). The claim lives on
  `workspace.promotion_state` (`none | claiming | done | failed`); the workspace is 1:1 with the run,
  so a per-row CAS is race-safe without a partial index. **Claim tx** (short, commits before any
  side-effect): `SELECT … FOR UPDATE` the workspace, assert the run terminal allow-list
  (`status = "Review"`), readiness (`assertEvidenceReady`), the target-drift guard (below), and no
  active claim; then **mint a fresh `promotion_attempt_id`** (opaque token, e.g.
  `crypto.randomUUID()`) and CAS `promotion_state → 'claiming'`; `COMMIT`. A concurrent promote loses
  the CAS → `409 CONFLICT` "promotion already in progress". **Side-effects** run with no lock held.
  **Finalize tx** is keyed on `promotion_attempt_id`: if the token no longer matches (a stale reclaim
  re-minted it while this slow side-effect ran), the attempt was **superseded** — write nothing
  (no `Done`, no `pr_url`, no `failed`) and return `409 CONFLICT`; the newer attempt owns
  finalization. The idempotency markers (`promotion_state`, `pr_url`, `promoted_at`) are **AFTER-side
  writes** — never set before the side-effect succeeds. A stale `claiming` claim is reclaimable once
  older than `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` (default 300); a reclaim **re-mints** the
  token, so a crashed or slow original attempt can never double-finalize. The attempt-token CAS
  prevents a double **finalize**; the stored `pr_url` plus a provider query (see ADR-049) prevent a
  double **side-effect** — the two mechanisms compose.
- **Target-drift guard (optimistic concurrency on the target HEAD).** The `ReviewPanel` server-render
  resolves the live target HEAD and embeds it in the promote form as `reviewedTargetCommit`; the
  claim tx re-resolves the live target HEAD and refuses `PRECONDITION` ("target advanced since
  review") on a mismatch, leaving the run in `Review`. An explicit "Promote anyway"
  (`allowTargetDrift: true`) skips the equality assertion. `local_merge` still catches *textual*
  conflicts independently; this guard adds the **semantic** protection (a clean merge into an
  unexpected target state) and keeps the readiness evidence honest. A non-UI caller that omits
  `reviewedTargetCommit` is refused `PRECONDITION` rather than promoted blind.
- **Legacy-row compatibility.** Migration `0021` adds the branch/promotion columns **nullable** and
  backfills the derivable ones (`promotion_mode := project default ?? 'local_merge'`,
  `target_branch := project default_branch`); `base_branch`/`base_commit` are historically unknowable
  and stay null. At read time the promote service and `ReviewPanel` derive safe fallbacks
  (`targetBranch := override ?? workspace.target_branch ?? project.default_branch`; diff base via the
  existing `resolveBaseRef`); if a required value genuinely cannot be derived they refuse with a typed
  `PRECONDITION` ("legacy run lacks branch metadata — relaunch to promote"), never a silent null into
  git.

The decision is **Accepted** now (docs-first spec freeze); the corresponding code lands later this
milestone and is tagged `Designed` in the system-analytics and DB docs until each phase's HEAD.

**Consequences:**

- No new `runs.status` value; `Review → Done` is the only added transition for flow promotion, so no
  consumer of the status enum fans out. Promote guards are written as a `status ∈ {Review}`
  allow-list, not `if (!terminal)`, so a future status is rejected by default.
- `workspaces` gains `base_branch`, `base_commit`, `target_branch`, `promotion_mode`, `pr_url`,
  `pr_number`, `promoted_at` plus the claim columns `promotion_state`, `promotion_claimed_at`,
  `promotion_owner_user_id`, `promotion_attempt_id` (migration `0021`, additive + backfill).
- One `promoteRun` service serves both scratch and flow runs; the scratch regression suite is the
  guard against behavior drift.
- M18 promotion ships against pre-M15 readiness semantics by design; the M15 policy DSL is a clean
  later plug-in at the same `assertEvidenceReady` chokepoint with no promote-path rework.
- Concurrency is closed by the durable attempt-token claim, not a long-held lock around external I/O;
  the crash window (claim committed, finalize not reached) is recovered by the timeout reclaim plus
  an idempotent side-effect, so no background sweeper is added.
- A new env var `MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS` (default 300) tunes the stale-claim reclaim
  window; per [ADR-023](#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres) the default compose stays
  Postgres-only and this is a host/service-env concern.

**Alternatives Considered:**

- **A new `runs.status` (e.g. `Promoting`/`Promoted`) for the promotion lifecycle:** would force every
  consumer of the status enum (board, portfolio, scheduler, reconciler, SSE, i18n) to fan out for a
  state whose outcome already maps cleanly onto `Done`. Rejected — terminal stays `Done`, no new
  status.
- **A held `SELECT … FOR UPDATE` row lock spanning the git/PR side-effect:** turns the promotion into
  a long transaction wrapping external calls (merge, push, PR API), holding a DB connection for the
  full latency and risking lock-timeout cascades. Rejected — durable claim committed before the
  side-effect, lock released immediately.
- **Committing the guard before the side-effect without an attempt token:** releases the
  serialization point while the run is still `Review`, so a concurrent or reclaiming promote could
  pass the same guard and duplicate the merge/PR or double-finalize. Rejected — the per-attempt
  `promotion_attempt_id` token gates finalize, so a superseded attempt writes nothing.
- **Depending on the M15 readiness-policy DSL for the promote gate:** couples M18 delivery to an
  unscheduled milestone for a check the M16 chokepoint already performs. Rejected — reuse
  `assertEvidenceReady`; M15 plugs in later (ADR-045 carve).
- **Validating only that the target branch still exists at promote time:** a clean merge into a target
  that advanced since review would pass silently with stale readiness evidence. Rejected — optimistic
  concurrency on the target HEAD via `reviewedTargetCommit`, with an explicit `allowTargetDrift`
  override.
- **Making the branch/promotion columns `NOT NULL` and backfilling all of them:** `base_branch`/
  `base_commit` for pre-M18 runs are historically unknowable, so a non-null constraint would either
  fabricate data or block the migration. Rejected — nullable columns with derivable backfill and a
  typed `PRECONDITION` fallback for genuinely unrecoverable cases.

---

### ADR-049: PR promotion via a hybrid provider `PrAdapter` (credential model B); reverses the "gh is never invoked" invariant

**Date:** 2026-06-03
**Status:** Accepted
**Context:** ADR-058 generalizes promotion to flow runs across `local_merge` **and** `pull_request`
modes, but until M18 there is **no git push and no PR creation anywhere** in the platform:
`web/lib/repo-source.ts` detects the provider (`github | gitlab | gitea | gitverse | generic`) but
only records it, `cloneRepo` is a plain `git clone` on host credentials, and the promote route throws
`CONFIG` "not implemented" for `pull_request`. `docs/system-analytics/git-integration.md` documents
an explicit invariant that **"gh is NEVER invoked"**. M18 must implement PR promotion for the
configured providers while keeping the credential surface minimal — the milestone deliberately
**defers** in-platform credential storage (SSH-key / password / token vaulting, "model C"),
deploy/release management, and PR-to-merge tracking (confirmed with the user 2026-06-03). The
`MaisterError` union ([ADR-008](#adr-008-typed-error-taxonomy-maistererror)) is closed; PR failures
must map onto existing codes, and the route's `httpStatusForCode` is code-only, so a config error and
a retryable-transient error cannot share one code if they need different HTTP statuses.

**Decision:** Implement `pull_request` promotion behind a single `PrAdapter` interface
(`createOrUpdatePr({ repoPath, remote, sourceBranch, targetBranch, title, body }) → { url, number }`),
dispatched on `projects.provider`, under **credential model B**:

- **Provider dispatch (hybrid).** `github` → `gh` CLI; `gitlab` → `glab` CLI; `gitea` + `gitverse` →
  one shared **Gitea-compatible REST adapter** (`GET`/`POST /api/v1/repos/{owner}/{repo}/pulls`, with
  the API base and `owner`/`repo` derived from the repo's remote URL, bearer token from the host-env
  `GITEA_TOKEN`/`GITVERSE_TOKEN`); `generic` (unknown host) → unsupported, refused `PRECONDITION`
  "PR mode unsupported for provider" (`local_merge` is always available).
- **Credential model B — no secrets stored in-platform.** Authentication is host git credentials plus
  a provider CLI on PATH (`gh`/`glab`, with `gh auth` / `GH_TOKEN` / `GITLAB_TOKEN`) or a host-env
  token (`GITEA_TOKEN`/`GITVERSE_TOKEN`) for the REST adapter. `git push` **always** uses the host git
  credential helper. Model C (in-platform SSH-key / password / token storage), deploy/release
  management, and PR-merge tracking are explicitly **deferred** (confirmed 2026-06-03).
- **Per-provider preflight before any side-effect.** Assert the provider CLI is present (github/gitlab)
  or the `*_TOKEN` is set and the API is reachable (gitea/gitverse), and that the remote is configured
  — each failure refuses `PRECONDITION` before the durable claim's side-effect phase touches the
  remote.
- **Idempotent PR by stored `workspace.pr_url`.** If `pr_url` is set, the adapter **updates** the
  existing PR (pushes commits), never creating a duplicate. The crash-window fallback (PR created
  upstream but `pr_url` not yet persisted, because the markers are AFTER-side writes per ADR-058) is a
  provider query — `gh pr list --head` / `glab mr list --source-branch` / Gitea
  `GET …/pulls` — to detect an existing upstream PR for `(run branch → target)` and update instead of
  duplicating.
- **Reverses a documented invariant.** This explicitly reverses the
  `docs/system-analytics/git-integration.md` "gh is NEVER invoked" line: provider PR creation is now
  invoked conditionally on `pull_request` promotion. The reversal is recorded here and in
  `git-integration.md`.
- **Hardening.** CLI calls use array args plus `--end-of-options` (no shell interpolation); the REST
  adapter uses a typed `fetch`; tokens, credentials, and secret-bearing URLs are **never** logged
  (the verbose DEBUG on each provider invocation redacts them).
- **Error-code mapping (reuse the closed union, no new code).** Config / conflict / drift errors
  (CLI missing, remote unset, provider unsupported, push-rejected-config, target invalid, target
  drift, readiness not ready, promotion superseded) → `PRECONDITION`/`CONFLICT` → HTTP 409. A
  **retryable transient** push rejection or PR-API 5xx → **`EXECUTOR_UNAVAILABLE` → HTTP 503**, which
  is an existing member of the ADR-008 union — the run stays `Review` with **no `pr_url`** and the
  attempt is idempotently retryable. No new error code is added; `EXECUTOR_UNAVAILABLE` carries the
  retryable status because `httpStatusForCode` maps by code and `PRECONDITION` can only yield 409.

GitVerse's Gitea-API compatibility is **verified in Phase 3** (the implementation phase); the fallback
if it diverges is a dedicated `gitverse` branch on the shared REST adapter. PR-mode dependencies land
in the **web tier** (the Next.js promote route shells `gh`/`glab` or calls the Gitea API, plus
`git push`); per [ADR-023](#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres) the default compose stays
Postgres-only and does **not** provision provider CLIs, API tokens, or push credentials in the web
container — PR promotion is a **host-operator concern**, documented as such with no silent dev/prod
skew. The decision is **Accepted** now; the code lands in Phase 3 and is tagged `Designed` in the
provider/config docs until that phase's HEAD.

**Consequences:**

- The "gh is NEVER invoked" invariant is reversed; `git-integration.md` and `instance-config.md` move
  `gh`/`glab` and the Gitea-API token from informational to required-for-PR.
- No in-platform secret storage: a compromised MAIster process exposes no PR/push credentials beyond
  what the host already grants the operator; the cost is that the operator must provision CLIs/tokens
  on the host (no new bound port, no new sidecar, no Dockerfile change).
- PR promotion is idempotent across retries — stored `pr_url` plus a provider query prevent duplicate
  PRs even across a crash between push and marker persistence.
- A retryable transient failure is observably distinct from a config failure at the HTTP layer
  (503 vs 409), so callers can retry the former and must fix the latter.
- `generic` provider repos cannot use `pull_request` (refused `PRECONDITION`), but `local_merge`
  remains available for them.
- New optional server-only env vars `GH_TOKEN`/`GITLAB_TOKEN`/`GITEA_TOKEN`/`GITVERSE_TOKEN` are
  documented in `.env.example` and `configuration.md`; they are never logged.

**Alternatives Considered:**

- **In-platform credential storage (model C) for M18:** introduces a secret-vaulting surface,
  rotation, and a new threat model far beyond the milestone's wedge. Rejected — model B (host
  credentials + host-env tokens), model C deferred.
- **A per-provider native SDK instead of CLI + one shared REST adapter:** triples the dependency
  surface and the auth-config matrix for four providers, two of which (gitea, gitverse) share a wire
  protocol. Rejected — `gh`/`glab` CLIs for github/gitlab, one Gitea-compatible REST adapter for the
  gitea family.
- **A new `MaisterError` code for PR failures:** the union is closed (ADR-008) and the existing
  `PRECONDITION`/`CONFLICT`/`EXECUTOR_UNAVAILABLE` members already cover config, conflict, and
  retryable-transient cases with the right HTTP statuses. Rejected — reuse the closed union.
- **Mapping transient push/PR-API 5xx to `PRECONDITION`:** `httpStatusForCode` maps by code, so
  `PRECONDITION` can only yield 409, hiding the retryable nature of a transient failure from callers.
  Rejected — `EXECUTOR_UNAVAILABLE` → 503 for the retryable case.
- **Shell-interpolating branch/title/body into the provider CLI:** opens command-injection on
  attacker-influenceable branch names or PR bodies. Rejected — array args plus `--end-of-options`,
  typed `fetch` for the REST path.

---

### ADR-050: Platform ACP runners, adapter provisioners, and router sidecars

**Date:** 2026-06-03
**Status:** Accepted
> **Supersedes (in part) [ADR-004](#adr-004-multi-runner-claude--codex-on-current-target) and [ADR-005](#adr-005-model-routing-env-router-default-ccr-optional):** this ADR replaces the project-scoped executor-identity + model-routing config those defined.
**Context:** MAIster is moving from project-scoped executor rows to operator-managed ACP launch
configuration. The same platform must support Claude Code direct, Claude Code through Claude Code
Router (CCR), Claude Code with explicit dangerous permission policy, Codex with OpenAI-compatible
providers such as z.ai GLM/Qwen, and future adapters such as Gemini or OpenCode. Treating all of
that as one `{agent, model, env, router}` object would blur three different responsibilities:
selecting a named launch profile, translating MAIster restrictions into adapter-specific launch
material, and operating long-lived router daemons such as CCR.

**Decision:** ACP launch configuration has three separate layers.

1. **Platform ACP Runner.** Runners are platform-level catalog entries, not project-owned launch
   definitions. They carry a `runner_type`, currently `acp`, so future non-ACP/headless CLI
   runners can be added without overloading ACP semantics. The platform MUST have exactly one valid
   default runner. Projects, platform Flow defaults, project Flow defaults, Flow-step target runner
   ids, and workspace launch overrides all reference runner ids from this catalog when
   `runner_type=acp`. Runtime resolution is allow-listed in this order: launch/workspace override
   -> AI-coding step target -> project Flow default -> platform Flow default -> project default ->
   platform default. Missing referenced runner ids never silently fall back; platform Flow load and
   project Flow attachment block on a reconfiguration dialog.
2. **Runner Adapter.** Each adapter family (`claude`, `codex`, and future `gemini`/`opencode`) owns
   validation, readiness, provisioning, spawn mapping, and cleanup for its concrete runner. The
   adapter translates typed MAIster constraints (permission policy, MCP refs, settings/restriction
   profiles, provider env refs, model/provider shape) into the exact files, ACP `newSession` params,
   env vars, and argv the adapter actually supports. Unsupported combinations fail before child
   spawn with existing `CONFIG` or `EXECUTOR_UNAVAILABLE` semantics; MAIster does not pretend a
   restriction is enforced unless the adapter proves the delivery path.
3. **Router Sidecar.** CCR and similar routers are platform router instances, not per-run ACP
   profiles. A runner may reference a router instance id such as `ccr-default`. The supervisor owns
   lifecycle for each configured instance: typed command preset, config path, port/base URL,
   healthcheck, auth/env refs, provider config refs, `ensureRunning` before spawn, and shutdown with
   the supervisor. The default target is one CCR instance per supervisor host; multiple instances
   are allowed only when explicitly configured for distinct configs/ports/providers.

Launch options are typed and allow-listed. Platform runner and sidecar configuration is admin-only.
The UI MUST NOT accept arbitrary shell scripts, raw argv, or raw token values. Dangerous modes are
explicit enum policies, visible in readiness, and adapter verified before being offered as ready.
Secrets are always secret refs (`env:NAME`, or a future secret-store ref) and are resolved only at
the supervisor boundary.

The web tier resolves runner ids and sends a normalized, versioned spawn intent. The supervisor is
the only layer that turns the intent into child-process env/argv and router sidecar lifecycle.
Supervisor `/health` stays focused on liveness/readiness and may carry only a compact availability
summary. Adapter/sidecar diagnostics and runner/sidecar configuration use separate typed endpoints.

**Consequences:**

- The platform has one canonical ACP runner catalog; projects and Flows carry references and
  inheritance state instead of duplicating launch definitions.
- CCR moves from an executor flag/singleton assumption to a typed platform sidecar resource while
  preserving the current singleton-as-default operational model.
- Router sidecars need first-class DB/API/UI support because they are operator-managed platform
  resources with lifecycle and readiness. Adapter families are code-owned registry entries in the
  first slice: exposed through API/UI for diagnostics, not created as arbitrary DB rows.
- Per-adapter provisioners become the boundary for enforcement truth. Claude, Codex, Gemini, and
  OpenCode can support different concrete mechanisms without weakening the product contract.
- Flow import/attach UX must include required ACP remapping for unknown step targets; launch-time
  fallback is not an acceptable recovery path.
- Deployment docs/config must include router instance paths, env refs, readiness checks, and
  supervisor lifecycle behavior.
- Codex/Claude provider presets are ready only after source-backed adapter verification; unsupported
  exact provider/model endpoints remain visible as `NotReady` rather than being silently mapped.

**Alternatives Considered:**

- **Keep project-scoped executor definitions:** duplicates launch definitions across projects and
  cannot express platform default inheritance. Rejected.
- **One generic adapter mapper:** hides the fact that Claude, Codex, Gemini, and OpenCode accept
  different files, env vars, ACP params, and safety controls. Rejected.
- **Make CCR a per-runner/per-run process:** wastes startup time, complicates ports, and turns a
  shared router config into repeated process state. Rejected; runners reference platform sidecars.
- **Only support externally managed CCR:** makes readiness invisible to MAIster and prevents truthful
  launch gating. Rejected; external-only can be a future mode, but managed typed instances are the
  product default.
- **Allow arbitrary scripts/argv from the UI:** creates injection and reproducibility risk. Rejected;
  only typed, allow-listed lifecycle commands and adapter policies are accepted.

---

### ADR-051: Flow-graph layout metadata store (project-scoped, `flow_id`-keyed)

**Date:** 2026-06-05
**Status:** Accepted
**Context:** M22 adds a per-run flow-graph VIEW (reusing the ADR-039 `@xyflow/react` + `@dagrejs/dagre` renderer) where dagre seeds an auto-layout but an operator may drag nodes to reposition them, and those positions MUST persist and round-trip across reloads. The product constraint (root command + roadmap §E1) is absolute: manual node positions are presentation metadata that MUST live in a SEPARATE store, NEVER in the `flow.yaml` manifest — the DSL stays logic-only (engine stays `1.2.0`, no manifest schema change). The backlog doc floated an in-manifest "presentation section"; that is rejected here. The open question was the store's key. A `flow_revision_id` key would tie layout to one immutable revision, but `flow_revisions` rows are shared across projects that install the same flow source — a member of project A could overwrite the layout project B sees (a cross-project write leak Codex flagged in the adversarial pass).

**Decision:** A new DB table `flow_graph_layouts` (migration `0024`), one row per pinned node, keyed `UNIQUE (flow_id, node_id)`:

- `flow_id` FK → `flows.id` ON DELETE CASCADE; `node_id` text; `x`/`y` double precision; `updated_by_user_id` FK → `users.id` ON DELETE SET NULL; `updated_at` timestamptz.
- **Keying on `flows.id`** (the per-project flow binding) makes the layout **project-isolated by construction**: `flows` is per-project, so a write authorized against the run's project can only ever touch that project's `flow_id` rows. It is also **upgrade-stable** — it survives a `flow_revisions` bump (`runs.flow_revision_id` is nullable anyway).
- **Round-trip** = dagre always computes a baseline; stored rows are **overrides merged on top**. No flag — a node with a row is pinned; a node with no row is dagre-seeded. **Stale** node-ids (a revision dropped a node) are **ignored at render** (the row is skipped; dagre seeds the rest).
- **Write** = a single-store idempotent upsert `PUT /api/runs/{runId}/graph/layout {nodeId,x,y}` → `onConflictDoUpdate` on `(flow_id, node_id)`, last-writer-wins. `runId` = url-param; `flow_id` = server-state (resolved from the run, refuse a flow-less scratch run with `CONFIG`); `nodeId` = body, validated against the run's pinned-manifest node set (allow-list) before write (unknown id → `CONFIG`/400, no write); `x`/`y` bounded floats.
- **RBAC** = a new `editFlowLayout` action (min role `member`), distinct from `readBoard`, tunable to `admin` later without touching call sites (layout is shared *within* the project).
- **GC**: `flow_graph_layouts` rows are children of `flows` (CASCADE), NOT of `flow_revisions` — M19 revision-GC does NOT delete layout; only deleting the project/flow removes it.

**Consequences:**
- Manual positions persist and round-trip with no `flow.yaml`/engine change; the DSL stays logic-only.
- Cross-project layout writes are structurally impossible (a project-A member can never touch project-B rows); proven by a two-project integration test (M22 T1.5).
- A revision upgrade keeps positions for still-present nodes; dropped nodes' rows are inert (ignored at render), tolerated rather than eagerly GC'd.
- One more table + one write route; no new `MaisterError` code (reuses `CONFIG` / `UNAUTHENTICATED` / `UNAUTHORIZED`).

**Alternatives Considered:**
- **Positions in `flow.yaml` (manifest "presentation section"):** violates the logic-only DSL invariant, forces an engine bump, and couples shared bundle bytes to per-project view state. Rejected.
- **Key on `flow_revision_id`:** `flow_revisions` is shared across projects → cross-project write leak, and layout dies on every revision bump. Rejected.
- **Key on `run_id` (per-run layout):** positions would not survive across a task's many runs (1:N retry loop), defeating "persist my layout". Rejected.
- **A `presentation jsonb` blob on `flows`:** loses per-node upsert idempotency and concurrent-edit granularity (a whole-blob write races). Rejected for the per-row `(flow_id, node_id)` table.

---

### ADR-052: Live node-status coloring via SSE-triggered `graph-status` refetch

**Date:** 2026-06-05
**Status:** Accepted
**Context:** The M22 flow-graph view colors each node by its live execution status (highest-attempt `node_attempts.status` + gate rollup) and emphasizes `runs.current_step_id`. The run-detail page is a pure Server Component with no live subscription, and the existing run SSE stream (`GET /api/runs/{runId}/stream`) carries only supervisor session events (`session.line|update|permission_request|exited|crashed`) — it has NO `nodeId→status` delta. [ADR #1 / ADR-007](#adr-007-sse-pipe-to-disk-for-step-output) forbid `fs.watch` / `chokidar` / polling for state transitions; a naive `setInterval` recolor would violate that, and a reviewer could read any periodic refetch as a banned poll.

**Decision:** A `"use client"` `<FlowGraphView>` (mounted through the `{ssr:false}` dynamic wrapper, the ADR-039 pattern) colors from a server-rendered initial snapshot, then keeps colors live WITHOUT polling:

- **Server (run-detail, static at render):** `compileManifest(pinnedManifest)` → topology; `getFlowLayout(run.flow_id)` → overrides; `getRunNodeStatuses(runId)` → initial node/gate statuses + `currentStepId`. Topology + layout are stable, so dagre runs **once** on the client.
- **Live coloring:** the client subscribes to the EXISTING `useRunStream(runId)` SSE. On each SSE event it **debounces (~1 s)** and refetches the lightweight `GET /api/runs/{runId}/graph-status` JSON (node→status + gate rollup + `currentStepId`), recoloring in place (no dagre re-run, no `router.refresh()`). The refetch is **TRIGGERED BY an SSE event, never by a timer** — it is the sanctioned ACP-notification-bridged-through-SSE path, not a poll.
- **Terminal freeze:** when `runs.status` is terminal (`Done | Failed | Abandoned | Crashed`) there is no live session, so statuses are frozen and the client does NOT refetch — the server snapshot is authoritative. The e2e asserts **zero** `…/graph-status` traffic after a run goes terminal.
- **Color map:** `colorForNodeStatus(status, isCurrent)` mirrors the evidence-graph `colorForState` → HeroUI `<Chip color>`; the current node gets ring emphasis; a blocking-gate `failed`/`stale` rollup tints the node.

**Consequences:**
- Live status without polling and without a new SSE event type — reuses the existing run stream as a change-trigger only.
- A debounce collapses event bursts into at most ~1 refetch/sec; the status route is a cheap read model that returns an explicit DTO (no secrets, no internal handles).
- The "is this a poll?" review risk is closed in writing: SSE-triggered + terminal-freeze + an e2e traffic assertion.
- No supervisor change (the stream already exists); the recolor adds one small read route.

**Alternatives Considered:**
- **`setInterval` polling of `…/graph-status`:** the banned poll; violates ADR #1. Rejected.
- **Add a `node.status` delta to the SSE payload:** a larger supervisor + web change, and the status read model already exists server-side; the refetch-on-tick is far smaller. Deferred (a Phase-2 optimization if the refetch proves heavy).
- **`router.refresh()` per SSE event:** re-runs the whole Server Component (re-compiles, re-lays-out, refetches everything) and flickers; the in-place recolor is cheaper. Rejected.

---

### ADR-053: Workbench file-tree: git-tracked-only, member-gated reads

**Date:** 2026-06-05
**Status:** Accepted. The file **render** path below (the `…/files/content` HTTP route and its `413`/`415` responses) is superseded by [ADR-066](#adr-066-editor-and-diff-rendering-stack-shiki-git-diff-view-codemirror): blobs now render via the `?file=` RSC path as `file-too-large`/`file-binary` page states (no HTTP `413`/`415`). The git-tracked tree-read model, `readBlob` size/binary caps, and the `readRepoFiles` gate stand.
**Context:** M22 adds a read-only file browser over a run's worktree and a project's repo. A raw `fs.readdir` / `readFile` of an arbitrary worktree/repo path is a secret-disclosure surface: it would expose `.git/`, gitignored secrets (`.env*`), `node_modules`, and untracked agent output, and is one path-traversal bug away from reading outside the tree. The board's `readBoard` action is `viewer`; source code is more sensitive than board metadata.

**Decision:** The browser reads ONLY git-tracked content via git plumbing, behind a dedicated permission:

- **Reads:** `listTree({repo, ref, dir})` via `git ls-tree -z --end-of-options <ref> -- <dir>/` (one level) and `readBlob({repo, ref, path, maxBytes})` via `git cat-file -s` (size) then `git cat-file blob <ref>:<path>`, capped at `MAISTER_WORKBENCH_MAX_FILE_BYTES` (default `524288` = 512 KiB). Both new in `web/lib/worktree.ts`, **on-demand (NOT a watcher → ADR #1-compliant)**.
- **Trust boundary = "what is committed":** `.git/`, gitignored (`.env*`), `node_modules`, and untracked output are unreachable **by construction** (not in the tree object DB), not by a leaky denylist.
- **`ref` is server-state:** the run branch tip (run workbench) or `projects.main_branch` HEAD (project page) — never body-controlled. **`path`/`dir` is body/query-controlled and UNTRUSTED** → a new `repoRelPathSchema` rejects `..` segments, absolute, leading `/` or `-`, and NUL; git plumbing additionally cannot leave the repo object DB (double confinement).
- **RBAC** = a new `readRepoFiles` action (min role `member`), strictly above `readBoard`/`viewer` — a viewer cannot browse source at all. The workbench **diff** stays `readBoard`/`viewer` (it is run-scoped: only that run's `base..branch` changes, matching the M18 review-panel visibility).
- **Routes:** `GET /api/runs/{runId}/files[/content]` (worktree) and `GET /api/projects/{slug}/files[/content]` (project repo); over-cap → `413`, binary → `415`, unknown path → `404` (uniform existence-hide), traversal → `400` (`CONFIG`).
- **Untracked-file viewing is explicitly deferred** (it is the secret-disclosure surface we are excluding); a later opt-in member+ "show untracked" mode with an explicit secret denylist can be added if dogfood demands it.

**Consequences:**
- A low-privilege `viewer` cannot read source; even a `member` cannot reach `.git` / secrets / untracked output.
- No raw `fs` read of arbitrary paths and no execute-path (no `setup.sh` / hook / `child_process` of repo content) — both the path-traversal risk and the fetch-then-execute separation rule are satisfied.
- Listing is lazy-per-level and blob reads are capped — no full-tree walk, no unbounded read on big repos/files.
- One new env var (`.env.example` + `docs/configuration.md`; `web` runs on the host, so no compose `web` block per [ADR-023](#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)); no new `MaisterError` code (reuses `CONFIG` / `PRECONDITION` + HTTP 404/413/415).

**Alternatives Considered:**
- **Raw `fs` read of the worktree with a secret denylist:** denylists leak (new secret patterns, symlinks, `.git` internals); tracked-only excludes by construction. Rejected.
- **Reuse `readBoard` (`viewer`) for file reads:** exposes source to view-only accounts; M22 raises the bar with `readRepoFiles = member`. Rejected.
- **Show untracked / working-copy files now:** the highest secret-disclosure surface (uncommitted `.env`, agent scratch output); deferred behind an explicit future opt-in. Rejected for Wave-1.

---

### ADR-054: HITL assessment taxonomy — flow-declared `criticality` vs responder `human_confidence`, annotate-not-re-gate

**Date:** 2026-06-05
**Status:** Accepted
**Context:** [ADR-024](#adr-024-external-operations-surface--rest--thin-mcp-facade-project-tokens-mandatory-audit-hitl-assessment--flow-owned-escalation)
reserved a "HITL assessment & Flow-owned escalation" clause but left the concrete fields unspecified,
and [ADR-045](#adr-045-external_check-enforcement-via-the-review-chokepoint-m16m15m18-carve) re-pointed
that clause forward to M17 rather than implementing it. Two distinct quantities have been informally
conflated under the word "confidence": (a) how *severe* a human decision is — declared by the Flow
author when they place a `human` step/node — and (b) how *certain* the responding human felt when they
answered. A third, already-shipped quantity is the M15 AI-judge machine confidence parsed onto
`GateVerdict.confidence` and stored in `gate_results.verdict`
([ADR-048](#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15)), which
calibration already maps to a gate `status` at execution time. M17 must name the two human-facing
quantities, anchor each to a concrete column and write-time, and decide whether they participate in
readiness — without re-deriving or re-litigating the M15 machine-confidence path.

**Decision:** Introduce two named, orthogonal HITL annotations and forbid them from re-gating readiness:

- **`criticality` = flow-author-declared severity.** A flow-author field on the `human` node/step,
  enum **exactly `low | medium | high | critical`** (four values, includes `critical`). It is stored on
  `hitl_requests.criticality` (text, **nullable, no DB default** — `NULL` when the author did not
  declare it). It is **write-once at the `hitl_requests` INSERT** in both creation paths
  (`runner-human.ts` for linear `human` steps, `runner-graph.ts::runReviewHuman` for graph
  `human_review`) and is **never updated afterward** — each request is a fresh row, so there is no
  SET/CLEAR round-trip and the config-state-symmetry rule does not apply.
- **`human_confidence` = responder self-reported certainty.** Captured at **response time** from the
  answering human, a numeric `real` in `[0,1]` inclusive. It is stored on
  `hitl_requests.human_confidence` (real, nullable) **and** echoed into the `response` JSONB as
  `{ "confidence": <number> }`. Server validation is `z.number().min(0).max(1)`, **optional** — an
  absent value is permitted and stays `NULL`. The bound is enforced server-side in the respond path
  (the shared `respondToHitl` service, [ADR-055](#adr-055-hitl-response-service--hitl-over-mcp--token-actor--actor-kindscope-auth-gates)),
  never UI-only.
- **Distinct from `GateVerdict.confidence` (M15 AI-judge).** `criticality` and `human_confidence`
  annotate the HITL *surface* (criticality badge / sort key on the inbox; confidence on the
  decision/evidence record). They are **NOT** the machine confidence on `gate_results.verdict`, which
  M15 calibration already resolves to a gate `status` at execution. The two families never mix.
- **Annotate, do NOT re-gate.** Neither field feeds the readiness evaluator
  (`readiness-core.ts`/`assertEvidenceReady`). The escalate-to-human decision stays the Flow's
  `human_review` gate (the ADR-024 clause), **never** an external actor's and never a function of a
  recorded `human_confidence` value. A low self-reported confidence is observable but does not by itself
  block or re-open promotion.
- This **closes the ADR-024 HITL-assessment clause** and **supersedes the ADR-045 M17 pointer** for it:
  the fields are now named and placed; M17's remaining work is to surface and persist them, not to
  re-decide them.

No engine bump: `MAISTER_ENGINE_VERSION` stays **1.2.0**. The columns ride additive migration `0025_m17_hitl_assessment.sql`.

**Consequences:**

- `criticality` and `human_confidence` are nullable and additive, so every pre-M17 `hitl_requests` row
  and every flow manifest without a declared `criticality` stays valid; legacy reads see `NULL`.
- A reviewer reading a HITL surface can distinguish "the Flow author said this is `critical`" from "the
  human who answered was only `0.4` sure" from "the AI judge passed at `0.9`" — three sources, three
  storage sites, never collapsed into one number.
- Because the fields are pure annotation, no readiness-evaluator, board-badge, or promote-path consumer
  has to re-classify on them; the M15 shared `readiness-core.ts` is untouched.
- `criticality` being write-once means there is no edit/clear path to test or guard — the only write is
  at creation, asserted by the fan-out check on both creation paths.

**Alternatives Considered:**

- **A 3-level `criticality` (`low|medium|high`).** The plan body proposed three; the user overrode to
  the **four-level** enum including `critical`. Rejected — `low|medium|high|critical`.
- **Discrete `human_confidence` buckets (`low|med|high`).** Rejected — a `real` in `[0,1]` is finer,
  trivially bucketable for display, and matches the `z.number().min(0).max(1)` server bound.
- **Feeding `human_confidence` (or `criticality`) into readiness re-gating.** Rejected — it would make a
  human's self-doubt silently block promotion and would fork the escalate-to-human authority away from
  the Flow's `human_review` gate, violating the ADR-024 clause. Annotate-only.
- **Reusing `GateVerdict.confidence` for the human self-report.** Rejected — that column is the M15
  machine verdict consumed by calibration; overloading it would corrupt the calibration semantics and
  conflate machine and human certainty.

---

### ADR-055: HITL response service + HITL-over-MCP + token-actor + actor-kind/scope auth gates

**Date:** 2026-06-05
**Status:** Accepted
**Context:** The HITL respond logic — Phase-0 validation, the Phase-1 row-lock CAS write, the Phase-2
`atomicWriteJson` (form/human) or `deliverPermission` supervisor RPC (permission), and the Phase-3
`respondedAt` stamp + resume — lives **inline** in the session route
(`web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts`). [ADR-024](#adr-024-external-operations-surface--rest--thin-mcp-facade-project-tokens-mandatory-audit-hitl-assessment--flow-owned-escalation)
reserved "route/answer pending HITL" as part of the external surface, but the M16 external slice
([ADR-046](#adr-046-project-api-token-model),
[ADR-047](#adr-047-thin-mcp-facade-as-a-standalone-rest-client-package)) shipped task/run/readiness/gate
tools and **deferred HITL-over-MCP to here**. Exposing HITL to a token actor without first extracting
the logic would fork the two-phase commit; exposing it without an actor-kind gate would let a machine
token satisfy a human escalation; exposing it without enforced scope labels would let any broad project
token answer regardless of its issued capability. Two of these were raised as CRITICAL findings in
adversarial review (D7, D8).

**Decision:** Extract one shared service and expose it externally behind two new routes and two MCP
tools, gated by actor-kind and an opt-in scope check:

- **Extract `respondToHitl` into `web/lib/services/hitl.ts`.** The session route and the new ext routes
  both call it; the extraction is **zero behavior change** — the two-phase commit discipline is kept
  byte-for-byte (Phase-1 `db.transaction` row-lock CAS write of `response` + `reviewFields` +
  `human_confidence`, idempotency marker `respondedAt` stays the **AFTER**-side write; the
  `PENDING_FORM_RUN_STATUS = {NeedsInput, NeedsInputIdle}` allow-list and the `assertReviewDecision`
  Phase-0 validation are unchanged). The actor is a typed union
  `{ kind:"user"; … } | { kind:"api_token"; tokenId; projectId; … }`; the session route always passes
  `{kind:"user"}`. This mirrors the M16 `createTask`/`launchRun` service extraction precedent.
- **New external REST routes** under the existing
  [ADR-046](#adr-046-project-api-token-model) `projectToken` scheme:
  `GET /api/v1/ext/runs/{runId}/hitl` (scope `hitl:read`) lists a run's pending HITL, and
  `POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond` (scope `hitl:respond`) answers one. Both
  go through `handleExt` (existence-hide + mandatory audit). The **existence-hide trust boundary** is
  `run.projectId == token.projectId` else **404** (and `hitlRow.runId == runId` else 404) — a
  cross-project run is indistinguishable from a non-existent one.
- **New MCP tools `hitl_list` / `hitl_respond`** in the existing `@maister/mcp` package, each a thin
  REST client of the two routes above — no DB access, no business logic, satisfying the ADR-024 /
  [ADR-047](#adr-047-thin-mcp-facade-as-a-standalone-rest-client-package) thin-facade invariant and
  inheriting the complete `token_audit_log` trail.
- **Token actor identity.** A new `ensureApiTokenActor({projectId, tokenId, label})` upserts the
  `actor_identities` row for assignment attribution, backed by a new **unique partial index on
  `(project_id, token_id)` WHERE `kind = 'api_token'`** (migration `0026_m17_actor_token_uniqueness.sql`; user rows with `NULL`
  `token_id` stay distinct). In Phase 1 the `api_token` branch of `respondToHitl` is a typed stub that
  throws `UNAUTHORIZED`; it is wired live in Phase 6.
- **D7 — answering a `human`-kind HITL requires a human actor.** `respondToHitl` refuses any
  `actor.kind !== "user"` when `hitlRow.kind === "human"` → **403** (covers both the linear `on_reject`
  human step and graph `human_review`). Token and internal-agent actors may answer only
  `kind ∈ {permission, form}`. This makes ADR-024's "escalate-to-human is a Flow gate, never the external
  actor's" *executable*: a machine token can never satisfy a human gate, even holding `hitl:respond`.
  Supersedes the prior Open Question on MCP answering `human_review` (→ no).
- **D8 — scoped external credentials.** `handleExt` enforces each route's `scopeLabel` by default:
  `actor.scopes` MUST contain that scope or `"*"`, else **403**. The two HITL routes use
  `hitl:read` / `hitl:respond`; task/run/readiness/gate routes use their own labels. Routes may pass
  `requireScope: false` only for an explicitly documented compatibility carve. **403 responses MUST
  NOT leak which scopes a token holds.**
- The external actor can **answer** a pending request but can **never create or skip a gate** — gate
  placement stays the Flow's (ADR-024). The real-time human boundary is D7; the credential boundary is
  D8; they compose.

No new `runs.status`, no engine bump (`MAISTER_ENGINE_VERSION` stays **1.2.0**); the actor-token index
rides additive migration `0026_m17_actor_token_uniqueness.sql`.

**Consequences:**

- One implementation of the HITL two-phase commit serves the UI, REST, and MCP; there is no second copy
  to drift, and the ext route adds no side-effect beyond what the session route already performs.
- A token holding `hitl:respond` can clear machine-appropriate `permission`/`form` HITL via MCP/REST
  through the same audited path as the UI, but provably cannot answer a `human`/`human_review` request
  (D7) — HITL-over-MCP stays useful without weakening the human escalation contract.
- Default `handleExt` scope enforcement closes the old non-enforced-scope gap across the external
  surface while preserving `*` as the broad compatibility path.
- `ensureApiTokenActor` plus the partial unique index give token responses real assignment attribution
  without colliding with the existing `(project_id, user_id)` user-actor uniqueness.
- 403 (insufficient scope) and 403 (wrong actor kind) become live external statuses for the first time;
  the external OpenAPI and error taxonomy document both, and the 403 body never enumerates held scopes.

**Alternatives Considered:**

- **Duplicating the respond logic into the ext route instead of extracting a service.** Rejected —
  forks the two-phase commit and the idempotency/deferred discipline; a single `respondToHitl` is the
  only way to guarantee parity between the UI and the external surface.
- **Letting a token actor answer `human`/`human_review` if it holds `hitl:respond`.** Rejected (D7) — it
  would let a machine satisfy a Flow's human-escalation gate, defeating ADR-024's Flow-owned escalation.
- **Globally enforcing scope labels for all ext routes (reversing ADR-046's binary model).** Rejected
  for M17 — that is a separate, deferred decision with a wider blast radius; D8 carves only the HITL
  routes via an opt-in flag and explicitly leaves the global model intact.
- **Returning the token's held scopes in the 403 body for debuggability.** Rejected — leaks the token's
  capability set to a caller that just proved it lacks the required scope; the 403 is opaque.
- **A dedicated HITL token model separate from the ADR-046 project token.** Rejected — the project token
  already scopes to a project and audits; HITL reuses it with the new scope labels, no new credential.

---

### ADR-056: Flat-runner `on_reject.goto_step` atomic execution — single-tx repark, dedicated comments channel, window-sentinel invalidation

**Date:** 2026-06-05
**Status:** Accepted
**Context:** The graph runner (`runner-graph.ts`) implements review-driven rework fully — backward jump,
`commentsVar` injection, bounded `rework.maxLoops`. The **linear `steps[]` runner** (`runner.ts`) does
not: `runHumanStep` (`runner-human.ts`) persists `on_reject` only into `needs-input.json`, never onto the
`hitl_requests` row, and on resume returns `{ok:true}` so the flat loop **advances unconditionally** —
`on_reject.goto_step` and `comments_var` are never read. Closing this is a multi-store transition over
`runs.currentStepId`, the per-pass `step_runs` rows, the on-disk `input-<stepId>.json` completion
sentinels, and a comments side-channel. Two adversarial-review findings shaped it: (HIGH) the comments
channel must not be a completion sentinel, and (the deeper bug behind it) stale completion sentinels in
the re-execution window would auto-satisfy a re-reached human/form step with its *prior* reject so the
loop never re-prompts. No shipped flow uses flat `human`+`on_reject` today (only test fixtures), so the
risk is bounded to the linear path, but the atomicity must be correct before any flow relies on it.

**Decision:** Execute the linear `on_reject.goto_step` + `comments_var` path with a single durable
repark and explicit crash-window reasoning:

- **The comments channel is NOT a completion sentinel.** `runHumanStep` treats
  `input-<stepId>.json` as the step's completion artifact (its presence returns `ok:true` and SKIPS HITL
  creation). Rework comments therefore ride a **dedicated `rework-comments-<gotoStepId>.json`**
  (overwrite-safe, written via `atomicWriteJson`, never a completion sentinel), injected into the target
  step's context under `comments_var` through a new `injectedVars` param on `buildContext`/`executeStep`
  — the durable analogue of the graph runner's in-memory `pendingInjectedVars`. Writing comments into
  `input-<gotoStep.id>.json` is **forbidden** — it would falsely auto-satisfy a human/form goto target.
- **Stale completion sentinels are invalidated for the re-execution window.** A backward repark
  re-reaches the triggering human step (and any human/form step between the goto target and it); their
  prior-pass `input-<stepId>.json` would auto-satisfy with the stale reject. On repark the runner
  **deletes `input-<stepId>.json` for every step in `[gotoTarget..humanStep]`** so each re-reached step
  re-prompts cleanly. The canonical `input-<stepId>.json` contract for the **non-rework path is
  unchanged**.
- **One transaction for the durable repark.** A single `db.transaction` performs a CAS
  `runs {currentStepId := gotoStep.id}` guarded on `status='Running' AND currentStepId=<humanStepId>`
  (the just-claimed resume state). New `step_runs` are created per pass by the existing loop, so
  re-execution versions naturally — **no separate `step_runs` supersede write**. The runner then
  `break`s and re-enters via the existing resume-claim path at the reparked `currentStepId` (chosen over
  a mutable in-loop pointer: smaller blast radius, reuses the resume claim).
- **Ordering is delete-sentinels (fs) → repark-CAS-commit (DB).** This makes every crash window
  benign-or-correct (below).
- **Bounded re-entry guard.** A reject→goto→reject cycle is bounded by a re-entry guard with
  **default `maxLoops = 5`** (the linear path has no DSL field; the **graph keeps its explicit DSL
  `rework.maxLoops`**); exceeding it terminates the run with `MaisterError("CONFIG")` (parity with
  the graph runner's `rework.maxLoops` breach) rather than looping forever.
- **Crash-window enumeration** (justifying the delete→commit ordering):
  - **(a) death before sentinel-delete** → `currentStepId` still = human step, sentinels intact; resume
    re-drives the stored reject (idempotent) and reparks again. Correct.
  - **(b) death after sentinel-delete, before repark commit** → `currentStepId` still = human step but
    its sentinel is gone; resume re-prompts the human (the reject response is lost — a **benign
    degradation, never corruption**).
  - **(c) death after repark commit** → `currentStepId` = goto target, window sentinels already gone;
    reconciliation classifies the run as **Crashed**. A flat `steps[]` run has no graph mid-flow
    resume, so reconcile crashes ANY session-less linear gate/human orphan **directly** (reason
    `linear-gate-orphan`), never auto-redispatching it through a bare `runFlow` (which would restart
    at step 0 and re-run prior side-effects); a `cli`/`agent` goto crashes via the standard
    `cli-not-retry-safe` / `agent-session-gone` paths. `crashRunningRun` retains the goto target in
    `resume_target_step_id`. This is a **benign Crashed degradation** — no data corruption. The
    operator recovers via the standard Recover button (`resumeCrashedRun` → `driveResume`), which
    passes `crashResume` and resumes cleanly from the retained goto target. The orphan
    `rework-comments-*.json` is harmless (ignored unless the target expects `comments_var`;
    overwritten on the next repark).
- This flips the linear `on_reject.goto_step` + `comments_var` path **Designed → Implemented** (in
  Phase 3) in `hitl.md`, `flow-dsl.md`, and `database-schema.md`. The graph runner is untouched.

**Consequences:**

- The linear runner reaches parity with the graph runner's send-back loop, with full multi-store
  atomicity and a bounded cycle — a flow author can now rely on flat `human`+`on_reject`.
- A re-reached human/form step re-prompts on the second pass instead of silently auto-satisfying from a
  stale prior response — the loop is correct, not just present.
- Comments are observable to the goto target without ever masquerading as a completion artifact; the
  non-rework `input-<stepId>.json` contract is unchanged, so existing linear flows are unaffected.
- Every crash window is enumerated and either correct, a benign re-prompt, or a benign Crashed
  degradation recoverable via the standard Recover button; no background sweeper and no new status are
  introduced, and the worst case is a run that shows Crashed but resumes cleanly from the goto target,
  never corruption.

**Alternatives Considered:**

- **Writing `comments_var` into `input-<gotoStepId>.json`.** Rejected (HIGH finding) — that file is the
  completion sentinel; a human/form goto target would be auto-satisfied with the comments payload and
  never re-prompt. Dedicated `rework-comments-<gotoStepId>.json` instead.
- **Not invalidating window sentinels (repark `currentStepId` only).** Rejected — the re-reached human
  step's stale `input-<stepId>.json` would auto-satisfy the second pass with the prior reject, so the
  loop never re-prompts; the runner deletes the window sentinels first.
- **A mutable in-loop pointer instead of break + re-enter via the resume claim.** Rejected — larger
  blast radius and a second code path for state entry; reusing the existing resume claim keeps one
  entry point and one CAS.
- **Commit the repark before deleting sentinels (DB → fs ordering).** Rejected — a crash after commit
  but before delete would leave `currentStepId` at the goto target with stale sentinels still in the
  window, risking auto-satisfy; delete-first makes the crash windows benign.
- **An unbounded reject→goto loop.** Rejected — a flow that always rejects would spin forever; the
  re-entry guard (`maxLoops` default 5) terminates with `MaisterError("CONFIG")`.

---

### ADR-057: HITL hybrid-surface composition — cross-project Inbox block, inline response component, numeric "Needs you (N)" badge

**Date:** 2026-06-05
**Status:** Accepted
**Context:** The HITL machinery is shipped piecemeal — M11a typed-decision buttons
(`run-hitl-response.tsx`), M13 per-project inbox + assignment actions
(`getHitlInbox(projectId)`), M15 readiness summary, and the M9 portfolio feed
(`getPortfolio` → `effectiveNeedRows`, `totalNeeds`, `pendingHitlCount`) with a one-item-per-project
`NeedsYouStrip`. But there is no cross-project HITL view: a user with several projects must visit each
board; `run-hitl-response.tsx` is a `"use client"` hook component with a hard `router.refresh()` and no
`onRespond` callback or `compact` variant, so it cannot be embedded inline on a board flight card; and
`ProjectCard` carries `pendingHitlCount` in its DTO but renders **no badge**. M17 composes these into a
single hybrid surface without adding a route, a status, or new machinery.

**Decision:** Compose the existing pieces into a portfolio-home hybrid surface:

- **Cross-project Inbox as a portfolio-home BLOCK**, rendered in `app/(app)/page.tsx` — **not** a new
  `/inbox` route. A new `getCrossProjectHitlInbox` lifts `getHitlInbox` from project scope to
  **membership scope** (admin sees all visible projects; a member sees only their `project_members`
  projects), reusing the same assignment ∪ legacy `hitl_requests` dedup-by-`runId` as `getPortfolio`
  and batching reads (no N+1). The one-item-per-project `NeedsYouStrip` is **absorbed** into this full
  block; the compact numeric badge survives (below).
- **Inline embeddable response component.** Refactor `run-hitl-response.tsx` so a pure display
  subcomponent (e.g. `HitlDecisionControls`) is renderable via `renderToStaticMarkup`, add an
  `onRespond?: () => void` callback (replacing the hard `router.refresh()`, which becomes the default),
  and a `compact?: boolean` variant. The board flight card is un-`Link`ed on `NeedsInput*` (nav moved
  off the `<a>` so a `<form>` is not nested in `<a>`) and renders the inline response; the same
  component renders in the cross-project Inbox block and on run-detail. It surfaces the ADR-054
  `criticality` badge and the `human_confidence` input.
- **Numeric "Needs you (N)" badge.** A compact badge derived from `portfolio.totalNeeds` on the home,
  plus a `pendingHitlCount` chip on `ProjectCard` (the DTO field that was previously unrendered). The
  badge count equals the Inbox block item count.

No new route, no new `runs.status`, no engine bump; this is pure composition over the M9/M11a/M13/M15
machinery.

**Consequences:**

- A multi-project user resolves HITL from one place (the portfolio home) without visiting each board,
  and can respond inline on a board flight card without a full page navigation.
- One response component serves the board card, the cross-project Inbox block, and run-detail; the hard
  `router.refresh()` becomes an opt-out default, so existing run-detail behavior is preserved.
- The "Needs you (N)" badge and the `ProjectCard` chip are now precise (derived from the same
  `totalNeeds`/`pendingHitlCount` the Inbox block counts), removing the prior unrendered-DTO gap.
- RBAC is preserved by construction: membership-scoped `getCrossProjectHitlInbox` means a member never
  sees another project's HITL; the dedup matches `getPortfolio` so the badge and block agree.

**Alternatives Considered:**

- **A dedicated `/inbox` route.** Rejected — adds a nav destination and a route to maintain for what is
  a composition of existing read models; a portfolio-home block reuses the existing page and feed.
- **Keeping `NeedsYouStrip` as a one-per-project strip above the block.** Rejected — it would duplicate
  the block's first row per project; the full block absorbs it and the compact badge carries the count.
- **A second, board-only response component.** Rejected — two components drift; one component with
  `onRespond`/`compact` serves every surface, with a pure subcomponent for `renderToStaticMarkup`
  testability.
- **Per-card `getHitlInbox` calls for the cross-project view.** Rejected — N+1 over every project; a
  single membership-scoped batched query mirrors `getPortfolio`.

### ADR-059: Read-only Observatory formulas and harvest priority

**Date:** 2026-06-05
**Status:** Accepted
**Context:** Wave-1 E2 introduces an Observatory surface to prove whether MAIster's
existing ledgers contain repeatable correction and autonomy signals before the product
builds a write-side harvester or proposal inbox. The data already spans `runs`,
`node_attempts`, `gate_results`, `hitl_requests`, `artifact_instances`, Flow package
metadata, and M15 readiness verdict calibration. The milestone must not quietly add
background actors, mutable learning state, raw prompt inspection, migrations, or new
public API contracts. It also must not depend on M17 `criticality` or `human_confidence`,
which are future priority multipliers rather than prerequisites.

**Decision:** Implement M23 Observatory as a read-only read-model surface with three
frozen contracts:

1. **Correction rate.** `correction_rate = (rework_count + retry_count) / run_count`,
   grouped by flow, node, and artifact. `run_count` is the distinct set of flow runs in
   scope that have at least one `node_attempts` row. `retry_count` is the sum of
   `max(node_attempts.attempt) - 1` per `(run_id, node_id)`. `rework_count` is sourced
   from the writer path, not observed row folklore: the graph runner classifies a
   human decision as rework only when the selected transition target is in
   `node.rework.allowedTargets`, and `markNodeReworked` persists
   `node_attempts.status = 'Reworked'`. The UI renders the resulting value as an
   unbounded pressure ratio, never as a percentage.
2. **Autonomy Score.** `autonomy_score = 1 - sum(gate_wait_time) / total_run_time`.
   Formula helpers receive an explicit `now` value. HITL waits are intervals from
   `hitl_requests.created_at` to `coalesce(responded_at, now)`, clamped to the run's
   `[started_at, coalesce(ended_at, now)]` interval and merged before summing so
   overlapping waits cannot exceed run duration. Review or promotion dwell without an
   open `hitl_requests` row is out of M23 and is labeled as excluded metadata.
3. **Harvestable signals.** Signal clusters are observations, not recommendations.
   M23 clusters structured metadata first: rework `decision`, `rework_target`,
   `workspace_policy`, `step_id`, joined `runs.flow_id`; gate kind/id/status/verdict
   calibration fields; retry flow/node/error/exit metadata; and artifact kind/definition
   ids where linked. Raw HITL responses, prompts, artifact payloads, cost payloads,
   env values, and token-like strings are not read. Free-text extraction remains off
   unless a later ADR approves a bounded, redacted subset. Priority is driven by
   repeatability (`occurrenceCount`, `affectedRunCount`, `affectedProjectCount`) with
   extra weight for blocking failed/stale gates. M17 fields may multiply priority later
   but are optional slots, not part of the M23 formula contract.

M23 adds no DB tables, columns, indexes, env vars, supervisor behavior, agent behavior,
state-changing routes, cron jobs, or external HTTP API by default. If Phase 0 or RED
tests prove an index is required for the pre-dogfood volume target, that becomes an
explicit migration task with `docs/database-schema.md` and `docs/db/*.md` updates.
Server components call typed read-model helpers directly; public responses remain DTO
projections and never leak server-only handles.

**Consequences:**

- Observatory can be implemented with batched Drizzle reads and pure rollup helpers,
  reusing the M15 readiness SSOT pattern without adding a state machine.
- Active runs are included but marked volatile because open waits and attempts can still
  change their numerator and denominator.
- `tasks.attempt_number` stays a mutable board high-water mark and is not used as retry
  evidence for M23.
- Drill-down reconciliation distinguishes additive event counts from distinct run sets:
  child `runCount` values reconcile by set union, not by numeric sum.
- The write half of learning remains future work. The UI must say "signals" or
  "patterns", not "recommended fixes" or "auto-improvements".

**Alternatives Considered:**

- **Use sampled `hitl_requests.decision` strings to infer rework:** decisions are
  manifest-defined labels, not a global enum. Rejected; the writer path's
  `Reworked` node-attempt status is the durable source of truth.
- **Count raw wait durations without interval union:** overlapping HITL rows can make
  wait time exceed total run time and produce false zero-autonomy readings. Rejected.
- **Inspect HITL comments and artifact payloads in v1:** it may improve clustering, but
  it risks surfacing code, credentials, or user-sensitive context before redaction
  policy exists. Rejected for M23.
- **Persist signal clusters or recommendations now:** that starts the write half of the
  learning loop and introduces proposal lifecycle semantics. Rejected; M23 is read-only.

---

### ADR-060: Unified scheduler clock and polymorphic job budgets

**Date:** 2026-06-05
**Status:** Accepted
**Context:** MAIster already has a token-guarded GC cron route and several
sanctioned recovery/cleanup sweeps. Wave-1 long-lead work needs a broader clock
for system sweeps, narrow commands, future agent ticks, and scheduled Flow runs.
Putting that clock in the supervisor would force DB access into the process that
is deliberately DB-free and owns only ACP sessions. Adding multiple cron routes
would duplicate auth, scheduling, budget, and observability behavior.

**Decision:** The scheduler is one stateless Next.js tick route,
`GET`/`POST /api/cron/tick`, guarded by `X-Maister-Cron-Token` and driven
primarily by an external cron. The web tier owns scheduler DB state and handler
dispatch. The supervisor remains DB-free and owns only process/session lifecycle.
M24 supports fixed-interval cadence only through
`scheduler_jobs.cadence_interval_seconds`; cron expressions and RRULEs are
deferred. A due job is claimed atomically with an `UPDATE ... WHERE
next_run_at <= now() ... RETURNING` transaction that also creates the attempt
ledger row and refuses overlap when an unexpired attempt lease exists. Clock
outage catch-up fires once and advances to the first future occurrence; missed
intervals are not backfilled.

Scheduler job kinds are `system_sweep`, `command`, `agent_tick`, and
`flow_run`. `flow_run` uses the existing `MAISTER_MAX_CONCURRENT_RUNS` and
`tryStartRun` path. `command` uses `MAISTER_MAX_CONCURRENT_COMMANDS`.
`agent_tick` uses `MAISTER_MAX_CONCURRENT_AGENTS` and, until an actor launcher
exists, production targets without a launcher record terminal `Skipped` with
`PRECONDITION` and auto-disable after
`MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES`. The tick service idempotently seeds
`system_sweep.default` so existing recovery sweeps keep running after migration
without a hand-authored scheduler row. The existing `/api/cron/gc` route remains
as a compatibility wrapper over the same `system_sweep` service and keeps its
response/status contract. A single-box fallback timer is allowed only when
`MAISTER_SCHEDULER_TIMER_ENABLED=true`; it calls the same tick service and is not
the preferred production clock.

**Consequences:**
- Scheduler logic can reuse Drizzle, run creation, recovery, and GC services
  without teaching the supervisor about DB state.
- Operators get one cron secret and one clock target while `/api/cron/gc`
  remains compatible during migration.
- Job-kind budgets are explicit and do not let agent/command work steal Flow
  run slots.
- `agent_tick` has an explicit no-launcher seam in M24; repeated no-launcher
  skips self-disable instead of creating endless scheduler noise.
- Fixed-interval cadence keeps M24 small and avoids a premature cron/RRULE
  parser contract.
- Attempt leases and reaping make crash windows visible and retryable.

**Alternatives Considered:**
- **Supervisor-owned scheduler:** duplicates web DB/orchestration logic and
  violates the supervisor-owns-agents boundary. Rejected.
- **Independent route per job class:** repeats auth, claim, budget, and
  observability logic. Rejected.
- **Cron/RRULE support in the first slice:** adds a wider authoring contract than
  Wave 1 needs. Rejected for M24.
- **Automatic fallback timer when the cron token is unset:** hides deployment
  misconfiguration and risks a resident timer running unexpectedly. Rejected;
  fallback is explicit opt-in.

---

### ADR-061: Local authored capability catalog lifecycle

**Date:** 2026-06-05
**Status:** Accepted
**Context:** ADR-043 made capability imports git-installed and read-only, using
the Flow install fetch/trust/execute pipeline. Wave-1 authoring groundwork needs
a local DB model for drafting and versioning rules, skills, and flows without
changing git import trust semantics or pretending local authored flows are
runnable Flow packages.

**Decision:** Authored capabilities are first-class project-local DB records,
not edits to `maister.yaml`. The M25 lifecycle is `Draft -> Published ->
Archived`. `Published` means visible inside the MAIster instance only; external
catalog PR publication and two-way sync are later work. Draft updates use
optimistic concurrency through `draft_version`; stale updates fail with
`CONFLICT`. Published revisions are immutable. Local publish of authored
`rule` and `skill` revisions projects into `capability_records` as
`source='project'` with `material.origin='authored'` in the same transaction.
Local publish of authored `flow` revisions stores immutable catalog content only
and never mutates `flows`, `flow_revisions`, install caches, setup status, or
project enablement.

Because config-owned project capability rows also use `source='project'`,
same `(project_id, kind, slug)` collisions with non-authored project rows are
refused with `CONFLICT`; authored origin never silently wins. Config SET/CLEAR
logic must explicitly exclude `material.origin='authored'`, so resyncing
`maister.yaml` never disables local authored projections. Authored content is
operator input and inert in M25: no authored draft runs `setup.sh`, hooks, or
package code.

**Consequences:**
- The existing git-installed import path remains read-only and trust-gated.
- Local authored rules/skills can be selected through the same
  `capability_records` read path as other project capabilities.
- Authored flow publication cannot be mistaken for Flow package enablement.
- Config resyncs stop being dangerous for authored rows despite the shared
  `source='project'` label.
- External catalog publication can add a separate state/table later without
  renaming M25's project-local lifecycle.

**Alternatives Considered:**
- **Write authored caps back into `maister.yaml`:** blurs operator config with
  app-authored content and bypasses revision lifecycle. Rejected.
- **Use a `LocalPublished` lifecycle value:** adds naming noise to the local data
  model. Rejected; `Published` is explicitly project-local in this ADR.
- **Let authored rows override config rows on slug collision:** would create
  silent priority rules and surprising resolver output. Rejected.
- **Turn authored flows directly into `flow_revisions`:** bypasses the package
  lifecycle and trust model. Rejected for M25.

---

### ADR-062: Platform user administration + project member management (admin-surface carve)

**Date:** 2026-06-07
**Status:** Accepted
**Context:** M9 shipped the RBAC enforcement layer (`web/lib/authz.ts`:
`requireGlobalRole` / `requireProjectRole` / `requireProjectAction`,
DB-authoritative, global-admin-implicit-owner, last-active-admin + no-self
guards). That layer is complete and not modified here. This ADR records the
**admin surface** built on top of it: user provisioning, deletion policy,
lightweight audit stamps, and project membership management. Team/org
governance stays deferred (Wave-4/E5).

**Decision:**

**D1 — Provisioning.** Global admins create accounts with an admin-set one-time
temporary password (primary path) or an auto-generated password when the field
is left blank. `must_change_password=true` is set unconditionally on creation.
There are NO email invites, SMTP, forgot-password, or email-verification flows.
Recovery stays admin-reset only. Generated password length is controlled by
`MAISTER_TEMP_PASSWORD_LENGTH` (default 12, clamped ≥ 12); admin-typed passwords
enforce a minimum of 12 characters. The temporary password is returned exactly
once in the create response and is never logged.

**D2 — Deletion.** Soft-disable (`account_status='disabled'`) is the default
and the terminal-safe path for accounts that have been used. Hard-delete is
permitted only for unused accounts — eligible iff `account_status='pending'`
AND `last_login_at IS NULL` AND zero referencing rows exist in
`runs`, `scratch_runs`, `node_attempts`, `actor_identities`, `project_tokens`,
`workspaces`, `flow_graph_layouts`. `password_hash` is excluded from the
eligibility check. On hard-delete, `project_members`, `accounts`, and `sessions`
cascade. Any account with referencing rows receives a `PRECONDITION` (409)
response; the UI offers Disable as the only action.

**D3 — Audit stamps.** Lightweight who/when columns on the affected rows,
generalizing the existing `account_status_updated_by` / `account_status_updated_at`
pattern. New nullable columns: `users.{created_by, updated_at, updated_by}` and
`project_members.{added_by, updated_at, updated_by}`. There is NO separate
append-only audit-log table.

**D4 — Project member add.** Adding a member to a project attaches an existing
platform user (searchable by email or display name). User creation cannot happen
at the project level.

**D6 — Members surface.** A new `members` tab on the project page shows the
full member roster. Roster reads are visible to any project member; role changes
and removals are gated to project-admin+ / global-admin via a new
`PROJECT_ACTION_MIN` action `manageMembers`.

**D8 — No last-owner guard on project members.** `project_members.role='owner'`
confers no capability beyond `admin` today — nothing in `PROJECT_ACTION_MIN`
requires the owner role. Global admins are implicit owners of every project,
so a project can never become inaccessible regardless of member roster state.
No last-owner guard is implemented.

**Consequences:**
- User provisioning and lifecycle is fully admin-driven with no mail infrastructure
  dependency.
- Hard-delete is safe because it is structurally gated on zero referencing rows;
  soft-disable is always available as the fallback.
- Audit visibility comes at zero schema overhead beyond nullable stamp columns.
- Project membership is always a two-step flow: user must exist before being
  added to a project, preventing orphaned invites.
- Dropping the last-owner guard keeps the membership model simple; the invariant
  is covered by global-admin implicit ownership.

**Alternatives Considered:**
- **SMTP email invites:** out of scope — no mail infrastructure on the current
  target. Rejected.
- **Separate append-only audit-log table:** D3 lightweight stamps on the affected
  rows are sufficient for the current admin surface; a separate audit log adds
  schema and query complexity without observable benefit today. Rejected.
- **Per-field user mutation routes (status / role / password-reset):** the
  codebase already uses a single aggregating `PATCH /api/admin/users/{userId}`;
  project memory (prefer-aggregating-endpoint) mandates aggregating PATCH over
  per-field routes. OpenAPI documenting separate routes is drift to be fixed, not
  a model to follow. Rejected.
- **Last-owner guard on project members:** D8 rationale — `owner` role confers no
  extra capability and global admins are implicit owners, so the guard would be
  purely cosmetic overhead. Rejected.

---

### ADR-063: Structured node output channel (P1) + run-context file (P7)

**Date:** 2026-06-07
**Status:** Accepted — P1 Implemented (2026-06-10, `feature/harness-loop-foundation`); P7 run-context file stays Designed
**Context:** Today only `human`/HITL nodes write a structured result into
`node_attempts.vars`; `ai_coding`, `cli`, `check`, and `judge` nodes emit only
free `stdout` text and files-on-disk (`vars` is always `{}` for them). The flow
engine therefore cannot pass a node's *structured* result to a later node, route
on a node's self-reported outcome, or feed first-class node signals to the
Observatory. A cleared/resumed agent session also has no session-independent view
of run-level state. M26 delivers the Wave-1 keystone pair (P1 + P7) with **no DB
migration and no new dependency**. Frozen SSOT:
`.ai-factory/specs/feature-m26-structured-output-run-context.md`.

**Decision:**

**D1 — Opt-in per node.** P1 activates for a node only when its manifest declares
`output.result`. A node without it behaves byte-identically to today (`vars: {}`,
no transport provisioning, no parsing). Graph (`nodes[]`) engine only; legacy
linear `steps[]` is out of scope.

**D2 — One grammar, no new dependency.** The existing `formSchemaSchema` grammar
is reused (no `ajv`): `validateHitlResponse` is generalized into a single shared
`validateStructuredOutput(value, schema)`; HITL forms keep delegating to it. The
grammar gains a nested `object` type with recursive `fields`; all prior flat types
(`string | number | boolean | enum | array`) are unchanged.

**D3 — Schema is a `./path`.** `output.result = { schema: <"./path">, required? }`
attaches to the node `output` block (sibling of the M12 `produces[]`). `schema`
is resolved against the flow install dir with the same escape-guard +
`realpath` canonicalization as `form_schema`, then validated as a
`formSchemaSchema` document. `required` defaults to `false`.

**D4 — Hybrid transport by execution mechanism.** `ai_coding`/`judge` (agent):
the agent ends its response with a single sentinel-tagged ` ```json maister:output `
fenced block; the runner extracts the **last** such block from the 1 MiB-capped
`result.stdout` (a block pushed past the cap is **absent**); the agent writes no
file (it cannot write outside its worktree cwd). `cli`/`check`: the runner injects
`MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json`; the command writes
JSON there and the runner reads it.

**D5 — Failure → `CONFIG`.** Payload absent-while-`required`, oversize, invalid
JSON, or schema mismatch fails the attempt with `MaisterError("CONFIG")` — no new
error code. Validated `vars` fold into the **existing single** `markNodeSucceeded`
UPDATE: no new write, no new crash window.

**D6 — Run-context file in the worktree.** `<worktreePath>/.maister/run.json`
(inside the agent cwd → readable by `claude` and `codex`). The runner idempotently
appends `.maister/` to the repo's git exclude (`git rev-parse --git-path
info/exclude`) so `run.json` never appears in `git status` or the base→run diff.
Shape: `{ intent, nodes:{<id>:{summary,vars}}, gates:{<id>:{status,verdict?}},
promoted:{} }` — `status` always present (the signal for null-verdict
`command_check`/`human_review`). Run **logs** stay at `<runDir>`.

**D7 — P7 is a derived projection.** `run.json` is rebuilt idempotently from
`node_attempts` + `gate_results` + `task.prompt` after each ledger terminal
transition. It is self-healing — correctness **never** depends on it; a fresh,
cleared, or resumed session reconstructs identical state from the ledger. It draws
only from `vars` + gate results + intent, **never** from `context.env` (no env
secret can enter the file).

**D8 — Engine gate `1.2.0 → 1.3.0`.** `MAISTER_ENGINE_VERSION` bumps to `1.3.0`;
`OUTPUT_ENGINE_MIN = "1.3.0"` mirrors `ARTIFACT_ENGINE_MIN`. A manifest declaring
`output.result` on any node MUST declare `compat.engine_min >= 1.3.0`, else
`validateGraphManifest` rejects it with `CONFIG`. A manifest without
`output.result` stays valid at any `engine_min` (back-compat). `aif` declares no
`engine_max`, so the bump is safe.

**D9 — Size cap is an env var.** `MAISTER_NODE_OUTPUT_MAX_BYTES` (default
`262144` = 256 KiB) caps the raw payload before parse, read via an
`instance-config.ts` helper mirroring `workbenchMaxFileBytes()`. Wired into
`.env.example` + `docs/configuration.md` **only** — never `compose.yml` (`web`
runs on the host, ADR-023; matches the `MAISTER_WORKBENCH_MAX_FILE_BYTES`
precedent).

**D10 — P7 projection hardcoded "all".** M26 projects intent + every node's
`vars` + every gate result; a config-driven selector is deferred to a later wave.

**D11 — Per-attempt cli file.** `output-<nodeId>-<attempt>.json` so a non-writing
rework attempt N never inherits attempt N-1's file. Agents have no file → moot.

**D12 — No new surface.** No DB migration, no HTTP route, no `runs.status`/enum,
no new `MaisterError` code. P1/P7 converge on the existing `node_attempts.vars`
channel and the M17 `extraVars` rework-comment channel — never a parallel store.

**Consequences:**
- A downstream node resolves `{{steps.<id>.vars.<key>}}` from an upstream node's
  validated output via `reduceLedger` (highest-attempt-wins), with no new plumbing.
- Richer Observatory (E2) signals and the unblock of Wave-2 (P2 prompt injection,
  P4 dynamic routing, P3 diff-path assertions, P6 session continuity).
- Zero migration, zero new dependency.
- Delivery is **phased**: Phase 1 (the shared validator, the `output.result`
  manifest field, and the engine 1.3.0 gate) is implemented; the runtime transport
  + validate seam (Phase 2) and the `run.json` projection (Phase 3) follow. Until
  Phase 2 lands, `output.result` parses and is engine-gated but is not yet read at
  run time.

**Alternatives Considered:**
- **`ajv` / JSON-Schema dependency:** rejected — the existing `formSchemaSchema`
  grammar (extended with a nested `object` type) covers the need with no new dep.
- **Inline schema in the manifest:** rejected — a `./path` is consistent with
  `form_schema` and the M12 `produces[].schema` precedent.
- **Agent writes the output file directly:** rejected — agents cannot write outside
  their worktree cwd; hence the hybrid agent-stdout / cli-file transport.
- **`run.json` under `<runDir>`:** rejected — the agent cannot read outside its
  worktree cwd; the worktree location is the only one both `claude` and `codex`
  can read with no `.claude`-settings assumption.
- **A new parallel structured-output channel:** rejected — P1/P7 converge on
  `node_attempts.vars` + the M17 `extraVars` channel; a second store would split
  the source of truth.

---

### ADR-064: Authored flow-graph layout in the flow.yaml presentation section

**Date:** 2026-06-07
**Status:** Accepted
**Supersedes:** ADR-051 (the interim `flow_graph_layouts` DB layout store).
**Context:** M22 shipped the workbench flow-graph view. ADR-051 stored per-node
manual positions in a project-scoped `flow_graph_layouts` table (migration
`0024`), written by a runtime drag-persist route
(`PUT /api/runs/{runId}/graph/layout`, gated by an `editFlowLayout` member
action). That made layout a **per-project runtime write against an immutable,
shared, tag-pinned bundle**: layout state diverged from the flow it describes and
required a table, an RBAC action, and a write route to maintain.

**Decision:** Reverse the layout store. Authored node positions live in the
`flow.yaml` `presentation` section — `presentation.nodes[].{id, x, y, width,
height, color}` — shipped with the immutable bundle. The section is **additive and
runner/engine-ignored**, so the logic-only DSL invariant holds with **no engine
bump**. The read-only flow-graph view projects positions via
`presentationLayout(manifest)` into a `nodeId → {x,y}` map; `dagre` seeds any node
without an entry; entries for ids absent from the topology are harmless (no
phantom nodes). Size/color are accepted in the manifest but **not** projected — the
live run view colors by node status, so authored color must not override it. The
`flow_graph_layouts` table is dropped (migration `0030`, `DROP TABLE IF EXISTS`),
along with the layout write route, the `editFlowLayout` authz action, the
per-project drag-persist (`nodesDraggable=false`), and the `saveError` i18n key.
Layout **editing** is a flow-editor concern on the source `flow.yaml` (deferred),
not a runtime write.

**Consequences:**
- No DB layout store, no layout write route, no `editFlowLayout` action; the view
  is read-only.
- Layout is versioned with the flow it describes and shared identically across
  every project and run that pins the bundle.
- One fewer table + RBAC action + i18n key; net code reduction.
- Per-project runtime drag-persist is deliberately unsupported — a pinned bundle is
  immutable and shared, so layout editing belongs on the source file.

**Alternatives Considered:**
- **Keep the ADR-051 DB store:** rejected — a per-project mutable layout against an
  immutable, shared bundle is a category error; the layout diverges from the flow.
- **Inline positions in the `steps[]`/`nodes[]` DSL:** rejected — it pollutes the
  logic-only DSL and would force an engine bump; presentation is a separate,
  runner-ignored section.
- **Runtime drag-persist into the `presentation` section:** rejected — the bundle
  is immutable and shared; editing belongs to the flow editor on the source
  `flow.yaml`, not a runtime write into a pinned artifact.

---

### ADR-065: Platform ACP runner CRUD in `/settings` — hard delete blocked by any usage reference

**Date:** 2026-06-08
**Status:** Accepted
**Context:** The platform ACP runner catalog (`platform_acp_runners`, ADR-005
runner identity) had server-side `POST` (create) and `PATCH` (update) routes and
an admin `/settings` panel that could only set the platform default and toggle
`enabled`. There was **no `DELETE` route** and **no create/edit UI** — runners
could only be born via a raw API call, never removed. Worse, the `/settings`
page was unreachable: its `left-rail.tsx` entry was hard-coded `ready: false`
(rendered as a non-navigating "coming soon" span), and no other nav surface
linked it. The OpenAPI contract (`web.openapi.yaml`) already documented
`deleteAdminAcpRunner` returning **204** and `postAdminAcpRunner` returning
**409** on id conflict — the code lagged the contract.

**Decision:** Ship full CRUD for the runner catalog **inside `/settings`** (no
separate route or menu item) and make the page reachable.

- **Delete semantics:** `DELETE /api/admin/acp-runners/{runnerId}` is a **hard
  delete** (the `enabled` flag already covers soft-disable). It is refused with
  `MaisterError("CONFLICT")` (409) when `loadRunnerUsageReferences` returns **any**
  reference — **symmetric with the existing `assertCanDisable` guard** — and
  enumerates the blocking kinds (platform/project/flow default, flow-step remap,
  active run, historical run snapshot, scratch run). Zero references → **204**.
  The NOT-NULL FK `platform_runtime_settings.default_runner_id` is a second,
  DB-level guard for the platform-default case; the app check returns the
  friendly enumerated message first. Historical run autonomy is preserved by the
  self-contained `runs.runner_snapshot` (ADR-005), so the "block on any ref"
  rule is conservative, not a correctness requirement.
- **Create hardening:** `POST` pre-checks id existence and returns
  `MaisterError("CONFLICT")` (409) on a duplicate instead of a raw DB
  unique-violation 500 — matching the published contract.
- **UI:** a view-only runner table (the data-management bar, `users-table.tsx`)
  with an `acp-runner-modal.tsx` (one component, `create | edit` mode) for
  create/edit/delete; `id`/`adapter` immutable on edit; secrets only as
  `env:NAME`; readiness computed server-side; mutations reconcile via
  `router.refresh()`. Adapter-driven field logic is a pure, unit-tested
  `lib/acp-runners/runner-form.ts`.
- **Reachability:** the `settings` entry moves into the admin-only section of
  `left-rail.tsx` as `ready: true` (mirrors `users`/`scheduler`); the route still
  enforces `requireGlobalRole("admin")`.
- **Layout:** `/settings` becomes full-width, two-column on desktop; modals/forms
  stay narrow.

**Consequences:**
- The runner catalog is fully manageable from the UI; code now matches the
  OpenAPI contract (204 delete, 409 dup-id).
- Delete and disable share one usage-guard, so a runner used by any past run can
  be soft-disabled and deleted only after its references clear — predictable but
  conservative (a runner referenced solely by a historical snapshot cannot be
  hard-deleted until that run is GC'd).
- No new table, migration, or RBAC action; the surface reuses existing routes
  plus one `DELETE` handler.

**Alternatives Considered:**
- **Block delete only on *live* references** (allow delete when only historical
  snapshots remain): rejected — asymmetric with `assertCanDisable` and
  surprising; the conservative rule is simpler and snapshots are GC'd anyway.
- **Soft-delete only (no hard delete):** rejected — `enabled=false` already is
  the soft path; admins need real cleanup.
- **A separate `/admin/runners` page or top-level nav item:** rejected — the
  catalog is one admin concern that belongs with the rest of platform settings.
- **Two modal components (create + edit):** rejected — one `mode`-switched modal
  is less code for an identical adapter-driven form.

---

### ADR-067: Flow editor write path — canvas edits as M25 authored flow drafts with hard-gate before persist

**Date:** 2026-06-08
**Status:** Accepted
**Context:** The M22 workbench ships a read-only flow-graph view (`flow-graph-view.tsx`,
`nodesDraggable=false`). M27 turns it into an editor for any installed flow. The
key constraint is that a pinned flow bundle is immutable and shared across projects
(ADR-021); editors must never mutate the installed bundle in `~/.maister/flows/<id>@<tag>/`.
A second constraint is that invalid manifests must never reach the DB — the runner
reads manifests and an invalid stored draft would silently corrupt a future launch.

**Decision:** Editing any installed flow seeds an M25 authored draft (ADR-061 reuse)
from the pinned manifest — the draft lives in `authored_capabilities`/`authored_capability_revisions`,
NOT in the flow bundle. The new `authored_capabilities.source_flow_ref_id` column
(SDD §3.1) links the draft back to the installed flow's `flow_ref_id` so a later
publish targets the same `flows` lineage.

Canvas edits serialize into the manifest + `flow.yaml` `presentation` section
(ADR-064: `nodes[].{id,x,y,width,height,color}`; logic DSL is runner-facing,
presentation is runner-ignored). Before any `draft_version` CAS write, the server
runs `validateGraphManifest` + `compileManifest` in full; an invalid manifest throws
`MaisterError("CONFIG")` with HTTP 422 and the draft row is NOT mutated. Stale
`expectedDraftVersion` fails with `MaisterError("CONFLICT")` / 409. The CAS itself
is the `updateAuthoredDraft` path at `web/lib/catalog/authored-service.ts:279-352`.

The editor is `manageCatalog`-gated (write). The run-scoped flow-graph view stays
read-only (`readBoard`), consistent with ADR-052.

**Consequences:**
- The installed flow bundle is never touched by editor operations; ADR-021 immutability holds.
- Invalid manifests are structurally impossible to persist — the hard-gate is the only write path.
- The `source_flow_ref_id` link enables publish→bridge to land in the correct `flows` lineage without a parallel catalog store.
- `draft_version` CAS prevents lost-update races between concurrent editors (same guarantee as rules/skills, ADR-061).

**Alternatives Considered:**
- **Mutate the installed bundle in place:** rejected — the bundle is shared and
  immutable; editing it would corrupt other projects pinned to the same revision.
- **Validate only on publish, not on save:** rejected — a stored invalid draft
  would silently break any subsequent launch that resolves `latest`; fail fast at
  the earliest write.
- **Store canvas layout separately from the manifest (ADR-051 DB store):** rejected
  by ADR-064; presentation is versioned with the flow source, not stored per-project
  at runtime.

---

### ADR-068: Authored→executable flow bridge + two-axis trust gate (supersedes ADR-061 publish boundary)

**Date:** 2026-06-08
**Status:** Accepted
**Context:** ADR-061 explicitly prohibited authored `flow` revisions from becoming
`flow_revisions`: "Local publish of authored `flow` revisions … never mutates `flows`,
`flow_revisions`, install caches, setup status, or project enablement." That boundary
was correct for M25 (authoring only, no execution). M27 introduces in-app publish
that must produce a runnable flow — the ADR-061 boundary must be superseded for the
publish step only.

Additionally, the existing single trust axis (`flows.trustStatus`: logic trust) gates
launch but also gates `runRevisionSetup` (setup.sh execution), creating a conflation:
logic trust (`trusted_by_policy` from the in-app bridge) could inadvertently permit
`setup.sh` execution. A second, independent axis is required.

**Decision:** This ADR supersedes the ADR-061 prohibition on authored flows producing
`flow_revisions` and the ADR-061 rejected alternative "Turn authored flows directly
into `flow_revisions`."

The in-app publish path **reuses** `installAuthoredFlowPackageBridge`
(`web/lib/flows.ts:999`, previously CLI-only), parameterized to `trustStatus=trusted_by_policy`
(logic trust, gates launch precondition #9). The bridge's two-phase intent→finalize
path (`ensureRevisionIntentRow` at `:507`, finalize at `:588`/`:811`) is called
unchanged; the authored revision lands in the installed flow's **own** `flows`/`flow_revisions`
lineage (same `flow_ref_id`, recorded via `authored_capabilities.source_flow_ref_id`).
There is no parallel catalog store and no merge problem; "authored wins" is the
tie-break in the `latest` selector (ADR-069).

A **net-new second trust axis** `flow_revisions.exec_trust` (`untrusted | trusted`,
default `untrusted`) gates `runRevisionSetup` (setup.sh) AND MCP stdio `command`
spawn — independently of `flows.trustStatus`. The bridge sets `exec_trust=untrusted`
on publish. An explicit operator action (`POST /api/projects/[slug]/flows/[flowId]/trust-executable`)
flips it to `trusted`. `runRevisionSetup`'s guard changes from `flows.trustStatus`
to `flow_revisions.exec_trust === 'trusted'`. **Invariant:** logic-trust alone
(`trusted_by_policy`) never executes setup.sh or an MCP stdio command.

**Consequences:**
- Authored flow revisions become runnable after publish + exec_trust flip — the M27 goal.
- The two-axis model eliminates the "trusted_by_policy accidentally runs setup.sh" risk.
- `installAuthoredFlowPackageBridge` is unchanged at the call site; parameterization is
  a single new `trustStatusOverride` arg.
- Operators must make two explicit decisions (publish → exec_trust flip) to reach shell
  execution — a deliberate friction point against accidental privilege escalation.
- ADR-061's authored-inert-in-M25 guarantee is preserved for rules and skills; only
  the `flow` kind publish boundary is superseded here.

**Alternatives Considered:**
- **Keep ADR-061 as-is, add a separate bridge table:** rejected — a parallel store
  for "runnable authored flows" with its own merge logic is more complex than routing
  the existing bridge.
- **Single trust axis (fold exec_trust into trustStatus):** rejected — a third enum
  value on `flows.trustStatus` would be per-flow (not per-revision) and would require
  downgrade semantics when a new revision is published; per-revision `exec_trust` is
  cleaner and more auditable.
- **Auto-flip exec_trust on publish for internal/authored flows:** rejected — setup.sh
  execution must be an explicit operator decision regardless of source.

---

### ADR-069: `version_binding` (pinned|latest) + resolve-at-launch + unified resolved-set snapshot

**Date:** 2026-06-08
**Status:** Accepted
**Context:** M10 introduced `flows.enabled_revision_id` as the pinned-revision pointer
for launch. M14 introduced capability-revision snapshots into runs. M27 adds authored
revisions that can become `flow_revisions` (ADR-068) and a `latest` selection mode,
which requires a deterministic "newest published, never draft" resolver. The two
snapshot mechanisms (M10 flow-revision pointer, M14 capability-revision) are currently
separate; a unified resolved-set snapshot is needed so in-flight runs are fully
immutable regardless of catalog changes during execution (ADR-021).

**Decision:** A new `flows.version_binding` column (`pinned | latest`, default `latest`)
controls how `resolveEffectiveFlowRevision` selects the revision at launch.

- `pinned`: resolves to `flows.enabled_revision_id` (the existing M10 pointer).
- `latest`: resolves to the newest PUBLISHED `flow_revisions` row for the `flow_ref_id`,
  **never a draft**, with **authored-wins** tie-break when an authored and a git revision
  share the same recency.

`resolveEffectiveFlowRevision` runs at launch inside `launchRun`
(`web/lib/services/runs.ts:215-543`), inserted after the existing trust/setup/engine-compat
guards and before the worktree creation + snapshot write (SDD §6.3 insertion point 1).
The resolved revision still passes trust precondition #9 + setupStatus + engine-compat.

A new `runs.resolved_capability_set jsonb NULL` column (SDD §3.1) unifies the M10
flow-revision snapshot and the M14 capability-revision snapshot into a single frozen
record: `{ flowRevisionId, flowOrigin: "authored"|"git", capabilities: [{refId,kind,sha}],
mcps: [{refId,sha,scope}] }`. This is written in the existing `runs` INSERT transaction
(`runs.ts:590`). The runner reads the snapshot via `runner-core.ts:loadRun` and never
queries the live catalog for a run already in flight (invariant from ADR-021).

No new `runs.status` values are introduced.

**Consequences:**
- Catalog edits (publish, version-binding change, capability CRUD) during an active run
  do not affect that run — the snapshot is the only source of truth for runners.
- `version_binding=latest` with authored-wins gives authors immediate "use my latest
  publish" semantics without manual pin updates.
- The unified resolved-set replaces the implicit "read M10 pointer at runner start"
  pattern that was vulnerable to TOCTOU races on `enabled_revision_id`.
- Migration `0033+` adds `version_binding` (DDL in SDD §3.1).

**Alternatives Considered:**
- **Two separate snapshots (M10 pointer + M14 caps) retained as-is:** rejected — they
  are written at different points in `launchRun` and can diverge on a retry; a single
  atomic snapshot eliminates the race.
- **`latest` resolves to any revision including drafts:** rejected — an in-progress
  draft being resolved at launch would produce non-deterministic run behaviour; PUBLISHED
  is the only safe boundary.
- **authored-wins tie-break removed (git wins on tie):** rejected — the primary use
  case for `latest` in M27 is testing the just-published authored revision; demoting it
  behind git on equal timestamps defeats the purpose.

---

### ADR-070: MCP + capability management model — 3-scope identity, local-first precedence, platform storage, setup-time resolve

**Date:** 2026-06-08
**Status:** Accepted
**Context:** Three independent gaps accumulated in the capability resolution layer:
(1) `web/lib/capabilities/resolver.ts:selectedRecords` (`134-164`) returns ALL
matching `capability_records` without a winner-picking rule, producing latent
duplicate materialization when the same `(kind, refId)` appears at multiple scopes.
(2) Platform-level MCP servers had no dedicated storage table — they were seeded via
a JSON registry shim, unlike `platform_acp_runners` which have a proper CRUD table.
(3) The MCP transport shape in `mcpCapabilitySchema` was stdio-only; `sse`/`http`
transports required for remote MCP servers were not represented.

**Decision:**

**Precedence (all capability kinds).** The resolver picks exactly ONE winner per
`(kind, capability_ref_id)` using **project > platform > flow-package** precedence —
local-first, consistent with the runner-resolution chain documented in the root
CLAUDE.md §5 (project default outranks platform default). Lower-precedence records are
shadowed with no merge and no duplicate emitted. This supersedes the current
return-all/no-winner behaviour in `resolver.ts` and fixes its latent
duplicate-materialization bug.

**Platform MCP storage.** A new `platform_mcp_servers` table (SDD §3.1) mirrors
`platform_acp_runners` (ADR-065): admin CRUD at `/api/admin/mcp-servers/**`, the same
usage-guard hard-delete pattern (`assertCanDisable`-equivalent: 409 while any usage
reference exists, 204 on zero refs), and 409 on duplicate id. Rows are projected into
`capability_records` as `source='platform'`, replacing the JSON-registry seam.

**Transport.** `mcpCapabilitySchema` becomes a discriminated union: `stdio` `{command,
args?, env?}` | `sse` | `http` `{url, headers?}`. Secrets accepted only as `env:NAME`
(regex `^env:[A-Za-z_][A-Za-z0-9_]*$`); values resolved supervisor-side and never
stored, logged, or echoed in any response.

**Required vs additional MCP at launch.** Flow-package `flow.yaml` declares
`mcps: string[]` (capability ref ids). Node `settings.mcps` distinguishes
`required` vs `additional` (back-compat: bare `string[]` treated as `additional`).
At launch (SDD §6.3 insertion point 2, after the M14 cap-ref check at `runs.ts:475`):
REQUIRED MCP that cannot resolve + materialize → launch refused (`MaisterError("CONFIG")`
/ 409, or `EXECUTOR_UNAVAILABLE` / 503 if the agent does not support MCP). ADDITIONAL
MCP absence is non-fatal.

**Setup-time resolve.** A `POST /api/projects/[slug]/mcp/resolve` route accepts
operator-confirmed params (env:NAME references only). Present-by-id → reuse/dedupe
(no silent duplicate). Absent REQUIRED → propose-to-configure; remains unresolved →
blocks launch. Resolved MCP revisions are included in the `runs.resolved_capability_set`
snapshot (ADR-069).

**Codex MCP.** Materialization reuses M14 (`materialize.ts` / `agent-map.ts` /
supervisor `acp-client.ts:172`). Codex MCP support: materialized if `codex-acp`
supports it at integration time; otherwise explicitly documented as a gap (no silent
degrade). No parallel materialization path.

**Consequences:**
- Duplicate capability materialization is eliminated at the resolver layer — one winner
  per `(kind, refId)`, deterministic.
- Platform MCP servers are first-class catalog rows with the same lifecycle guarantees as
  platform ACP runners (ADR-065).
- `sse`/`http` transport support unblocks remote MCP servers without a schema change.
- Required MCP blocking launch gives operators a clear failure signal and a resolve path
  instead of silent omission.
- Secrets never appear in DB, logs, or wire — supervisor-side resolution is the only
  place env values are materialised.

**Alternatives Considered:**
- **Project < platform precedence (platform wins):** rejected — inconsistent with the
  local-first runner chain; operators would lose the ability to override platform-wide
  MCP settings at the project level.
- **Merge configs across scopes (additive):** rejected — additive merge of MCP args/env
  across scopes produces unpredictable effective configs; a clean shadow is safer.
- **Keep JSON-registry seam for platform MCPs:** rejected — a DB table gives the same
  CRUD, usage-guard, and audit trail as other platform catalog entities; JSON seam was
  always a temporary shim.
- **Block launch on absent ADDITIONAL MCPs:** rejected — additional MCPs are
  best-effort augmentation; a missing optional capability should degrade gracefully, not
  refuse the run.

---

### ADR-071: User-facing run schedules on the M24 clock

**Date:** 2026-06-10
**Status:** Accepted
**Context:** M24 shipped the unified scheduler clock
([ADR-060](#adr-060-unified-scheduler-clock-and-polymorphic-job-budgets)):
one polymorphic tick, atomic `FOR UPDATE SKIP LOCKED` claim, per-kind budgets,
attempt ledger. The owner-directed roadmap builds **user-facing cron
schedules** on that substrate: a per-project, member-gated recurring schedule
that launches a real Flow run for a task on a cron expression (IANA timezone)
with an overlap policy. Three constraints shape the design: (1) the engine
reschedules jobs **generically in the claim CTE SQL** as pure interval math
(`floor(elapsed/interval)+1` — `web/lib/scheduler/jobs.ts`), so a cron-next
instant cannot be computed inside the claim; (2) `agent_schedules` is the
reserved bridge for the E4 agents-as-actors epic and has the wrong shape
(`agent_ref NOT NULL`, no task/cron/overlap columns); (3) `tasks.status` is a
one-way latch — `launchRun` requires `Backlog`, but no code path ever resets
`InFlight` back, so the documented retry rule ("latest run Failed|Abandoned →
task returns to Backlog") exists only as a board projection
(`web/lib/board.ts`) and every relaunch — scheduled or manual — would refuse
with `PRECONDITION` after the first failed attempt.

**Decision:**

**Storage: dedicated `run_schedules` table + ONE singleton dispatcher job.**
Schedules are data rows in a new `run_schedules` table (cron expression,
IANA timezone, overlap policy `skip | queue_one | start_anyway`, enabled flag,
precomputed `next_fire_at`, queue-one catch-up flag, last-fire feedback
columns). A single seeded engine job (`job_kind = 'run_schedule'`, id
`run_schedule.dispatcher`, 60s cadence, budget 1, `max_failures` 3) is claimed
by the normal M24 tick; its handler claims due schedule **rows** with the same
`FOR UPDATE SKIP LOCKED` idiom and computes cron-next in TypeScript. The
engine core (claim CTE, budgets SQL, lease/reap) stays byte-identical;
`scheduler_jobs.cadence_interval_seconds` remains the only engine cadence
model, so the ADR-060 invariant survives. The dispatcher is seeded by
`ensureDefaultSchedulerJobs` (`ON CONFLICT DO NOTHING`, like
`system_sweep.default`); `createSchedulerJobSchema` deliberately does NOT
accept the new kind (admins cannot create duplicate dispatchers; disabling the
seeded row on `/admin/scheduler` is the global kill switch). Fire precision is
the dispatcher cadence (60s) — identical to the tick's own resolution. This is
NOT a second scheduler: no new clock, no new timer, no polling of run state.

**Cron library: `croner@^10`, wrapped.** Zero-dependency, MIT, native IANA
timezone support via `Intl`, documented DST behavior, and a pure
`nextRun(from)` API that computes occurrences without starting timers.
`web/lib/run-schedules/cron.ts` is the ONLY module importing `croner`
(enforced by `no-restricted-imports`); it validates **5-field** expressions
only (seconds-field and `@nicknames` rejected so resolution can never
undercut the 60s tick) and throws `MaisterError("CONFIG")` on invalid
expression/timezone/never-matching schedules.

**Target model: TASK relaunch (attempt N+1).** Each fire relaunches the
schedule's existing task through `launchRun` — full preconditions, gates,
HITL, promotion; one `runs` row + workspace + worktree per fire, exactly like
a manual Launch. Cron fires pass `{actorUserId: null, authorize: noop}`
(trusted-scheduler precedent from the `flow_run` handler); trigger-now passes
the clicking user's id. A flow-target mode ("mint a task per fire") is
deferred — additive later via a `target_kind` column defaulting to `'task'`.

**`launchRun` gate fix: effective-Backlog classifier.** A shared
`classifyTaskLaunchability(task, latestRun)` becomes the single source of
truth for "can this task launch", encoding the board's documented retry rule:
`task.status ∈ {Done, Abandoned}` → `target_terminal`; fresh `Backlog` →
`launchable`; `InFlight` with no run → `busy` (anomalous remnant, refuse);
latest run `Failed | Abandoned` → `launchable` (attempt N+1); latest run
`Crashed` → `crashed` (owes recover/discard); latest run `Done` →
`target_terminal`; any active latest run → `busy`. Both branches are explicit
allow-lists with a TS exhaustiveness assertion over the `RunStatus` union so a
future status fails compilation until classified. `launchRun` replaces its
`status !== "Backlog"` throw with `classification !== 'launchable'` → same
`MaisterError("PRECONDITION")`. This also un-breaks manual relaunch from the
board's derived Backlog column — a deliberate behavior change beyond the
schedule feature.

**Overlap × cap: two orthogonal blocked-dimensions, decided per fire.** Inputs
read inside the claim transaction: task launchability (any non-terminal run on
the target task blocks, regardless of who launched it) and cap fullness (the
EXISTING live-run predicate `status IN ('Running','NeedsInput','HumanWorking')`
vs `MAISTER_MAX_CONCURRENT_RUNS`, extracted from `web/lib/scheduler.ts` as an
exported helper — never re-implemented). Precedence: `target_terminal` and
`crashed` skip under every policy (no `queue_one` flag — they need human
action); task-busy → `skip`/`start_anyway` record `skipped_task_busy` (a
second concurrent run per task is structurally impossible — `start_anyway`
only overrides the CAP dimension), `queue_one` flags a non-stacking catch-up;
cap-full on a launchable task → `skip` records `skipped_cap`, `queue_one`
flags, `start_anyway` launches into the existing `Pending` queue
(`queued_pending` + queue position). The `queue_one` flag is consumed inside
the dispatcher tick by the same single claim query (`due OR
queue_one_pending`); a successful due fire also clears it. Pause clears the
flag; resume does not recreate it.

**At-most-once fire (two-phase pipeline).** tx1 (short, row-locked, no side
effects): claim + policy decision; non-launch outcomes commit their final
outcome and advance `next_fire_at` atomically; launch outcomes durably record
intent (`last_fire_outcome = 'dispatching'`, `last_fired_at = now`, advance
`next_fire_at`) and commit. `launchRun` runs OUTSIDE the row lock. tx2 writes
the final outcome (`launched | queued_pending | launch_failed`) + `last_run_id`,
CAS-guarded by `WHERE last_fire_outcome = 'dispatching'` — a concurrent
edit/delete/later-fire wins and the stale result is dropped with a WARN, never
clobbered. Crash window W1 (after tx1, before `launchRun`): the fire is LOST
BY DESIGN — at-most-once launch; a retry here is what double-fires runs; the
next cron fire overwrites the stale `dispatching` outcome. Crash window W2
(after `launchRun`, before tx2): the run exists and is fully owned by the
normal run lifecycle; the schedule self-heals at the next fire. A
`launch_failed` fire records the `MaisterError` code on the schedule row but
the dispatcher job attempt itself records `Succeeded` — a refused fire is a
schedule outcome, not an engine failure, so one schedule's dirty repo cannot
auto-disable the shared dispatcher. The dispatcher claims at most 10 schedules
per tick (lease protection); unclaimed due rows stay due.

**Trigger-now: inline dispatch through the same claim+fire core.**
`POST …/trigger` claims THE row by id (ignoring `next_fire_at`), refuses with
`CONFLICT` while the row is lock-held or while `last_fire_outcome =
'dispatching'` is fresher than the 300s scheduler attempt timeout (an older
`dispatching` remnant — a W1 crash — is past the window and may be triggered),
respects the overlap policy and the cap (no bypass), does NOT advance
`next_fire_at` (manual fires are out-of-band), and is allowed on a paused
schedule (explicit user intent). The response carries the outcome for the UI.

**Last-run feedback: write at dispatch, JOIN at read.** `last_fire_outcome` /
`last_fired_at` / `last_fire_error` are written synchronously by the
dispatcher (it IS the transition actor). The launched run's terminal status is
read by joining `runs` on `last_run_id` at query time (`lastRunStatus` in the
DTO) — run rows are never GC-deleted, so the join never goes stale. No hooks
on the ~10 scattered run terminal-write sites, no polling.

**Surface.** Five member-gated routes under
`/api/projects/{slug}/schedules` (list/create/patch/delete/trigger; view =
`readBoard`, mutate = new `PROJECT_ACTION_MIN.manageSchedules = "member"`), a
`schedules` tab on the project board page (query-param tab like `mcps`),
EN+RU i18n, and the dispatcher row on `/admin/scheduler` (kill switch). No new
env vars; the cap ([ADR-009](#adr-009-global-concurrency-cap--3)) is reused
as-is.

**Consequences:**
- Schedules ride the proven M24 claim/ledger/budget machinery; the engine core
  is untouched and `cadence_interval_seconds` stays the only engine cadence
  model (ADR-060 invariant preserved).
- Cron math lives in one TS module; the DB stores only the precomputed
  `next_fire_at` instant, so the due-scan stays a pure index scan.
- A second (row-level) claim layer exists inside the dispatcher handler —
  covered by its own no-double-fire concurrency test, mirroring the engine's.
- Fire precision is bounded by the tick cadence (60s) — acceptable: equal to
  the resolution cron itself provides at 5 fields.
- A process crash in window W1 loses that fire (at-most-once by design);
  operators see the stale `dispatching` outcome until the next fire overwrites
  it.
- The launchability classifier changes `launchRun` behavior for ALL callers:
  manual relaunch of a task whose latest run Failed/Abandoned now succeeds
  (attempt N+1) instead of throwing `PRECONDITION` — the persisted-status gap
  is fixed at the root rather than patched in the dispatcher.
- `start_anyway` can place runs into the `Pending` queue above the cap —
  bounded by the existing queue semantics, no cap bypass.

**Alternatives Considered:**
- **Extend `scheduler_jobs` with cron/tz/overlap columns (one engine job per
  schedule):** rejected — the claim CTE advances `next_run_at` with SQL
  interval math; cron-next cannot be computed there, so TS code would re-write
  the instant post-claim, opening a crash window where a daily schedule
  re-fires 60s later (double launch). Also invasive surgery on the
  battle-tested claim SQL and a violation of the ADR-060 cadence invariant.
- **Activate `agent_schedules`:** rejected — wrong shape (`agent_ref NOT
  NULL`, no task/cron/overlap columns) and it is the reserved E4
  agents-as-actors bridge; hijacking it blocks that epic.
- **`cron-parser` + luxon:** rejected — equally capable parser but drags
  `luxon` in as a runtime dependency; the repo deliberately has no date
  library. `croner` is zero-dep with native `Intl` timezones.
- **Denormalized `last_run_status` updated at run terminal transitions:**
  rejected — there is no single terminal choke point (~10 scattered write
  sites across runner/graph-runner/state-transitions/promote); instrumenting
  all of them (and every future one) for a value a read-time JOIN gives for
  free violates simplicity-first.
- **Event-driven `queue_one` consumption (hook `promoteNextPending` / terminal
  writes):** rejected — more coupling and new crash windows to win ≤60s of
  latency over tick-driven consumption; `Pending` runs from `start_anyway`
  already get strict event-driven priority via the existing engine.
- **`next_run_at = past` for trigger-now:** rejected — waits up to one tick
  (bad button UX) and conflates manual fires with the cron rhythm; inline
  dispatch through the shared core respects policy/cap and reports the outcome
  synchronously.
### ADR-072: PR-grade review comments — `review_comments` table, snapshot anchoring, runner-side rework compose, open-gate guard

**Date:** 2026-06-10
**Status:** Accepted
> **Amended by [ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality) (2026-06-11):** runner-side rework compose also folds `gate_chat_messages` history into `commentsVar`; gate-chat persists in a sibling table, not `review_comments`.
**Context:** The M11a review gate offers one free-text `comments` box. That is
too coarse to dogfood real PR-grade reviews (M20): a reviewer cannot anchor a
remark to a diff line, track which remarks were addressed across rework
iterations, or see how close the loop is to `rework.maxLoops` — today a rework
submitted on the final allowed loop silently fails the whole run via the engine
`CONFIG` throw. The diff substrate is already comment-ready (`@git-diff-view/react`,
ADR-066), the rework engine (`rework.{allowedTargets,maxLoops,commentsVar}`,
`node_attempts` ledger, `pendingInjectedVars` injection) is shipped, and the
HITL respond route's two-phase commit + idempotency CAS are locked invariants
that must not change.

**Decision:**

**Storage — one new DB table `review_comments`, 1-level threads.** Comments
span multiple `hitl_requests` rows (gate visits) and rework iterations within
one run; they need open/resolved queryability at compose time, RBAC-gated
writes, survival across worktree GC, and evidence-graph linkage
(`artifact_instances` is DB-side) — so they are DB rows, NOT a `.maister/`
artifact. The `.maister/` artifact pattern remains the *delivery* channel:
comments reach the agent only as the composed `commentsVar` payload. Threads
are 1-level: a root (`parent_id IS NULL`, carries anchor + status) and replies
(`parent_id = root.id`, no anchor). Columns: `id` (text PK, `randomUUID`),
`run_id` (FK → `runs.id`, cascade), `hitl_request_id` (FK → `hitl_requests.id`,
cascade — the gate visit of authoring), `node_id` (text), `gate_attempt` (int —
iteration tag), `parent_id` (self-FK, cascade), `author_user_id` (FK →
`users.id`, SET NULL) + `author_label` (text snapshot), `file_path` (text),
`side` (text enum `old | new`), `line` (int), `line_content` (text,
server-extracted), `body` (text), `status` (text enum `open | resolved`,
default `open`), `resolved_by_user_id` (FK → `users.id`, SET NULL),
`resolved_at`, `created_at`, `updated_at`. CHECK constraint: the anchor fields
(`file_path`, `side`, `line`, `line_content`) are non-null **iff** the row is a
root (`parent_id IS NULL`). Indexes: `(run_id, created_at)`,
`(run_id, status)`, `(hitl_request_id)`, `(parent_id)`.

**Anchoring — `(file_path, side, line)` + exact `line_content` snapshot, no
SHA.** POST validates the anchor against the server-recomputed current diff
(the same `diffRunWorkspace` + `lib/diff/prepare.ts` source the view renders)
and stores the server-extracted `line_content` — the client never supplies it.
Cross-iteration validity = exact content match at the same position in the
*current* diff, computed server-side in GET as `placement: "inline" |
"outdated"`. No fuzzy re-anchoring in v1 (GitHub-style "outdated" semantics —
deterministic, and the agent always receives content snapshots, so staleness
never corrupts the rework payload). Edges: diff `truncated`, or the anchored
file absent from the parsed diff → POST rejects 409 `PRECONDITION` (mirrors
the truncated-diff promotion acknowledgement).

**Rework serialization — runner-side compose at consumption.** In the existing
rework branch (`runner-graph.ts` `if (commentsVar)`), the runner loads OPEN
root threads (+ replies) for the run, composes deterministic markdown — user
summary first, then file/line-ordered anchored threads with quoted
`line_content` and replies — and injects it as
`pendingInjectedVars[commentsVar]`. **Zero open threads → composed value ≡ raw
summary, byte-identical to today** — full backward compatibility with every
existing flow and test. The respond route, its two-phase commit, and its
idempotency CAS are UNTOUCHED; `hitl_requests.response` and
`input-<stepId>.json` stay pristine user-submitted payloads. Resolved threads
never serialize; open-but-outdated threads do (their content snapshot is
quoted; compose does not recompute placement). No flow.yaml/DSL change —
`{{ review_comments }}` keeps working as-is. The exact serialization shape is
frozen in `docs/system-analytics/review-comments.md`.

**Evidence.** At compose time the runner records the composed payload as an
`artifact_instances` row (`kind: human_note`, `producer: runner`, locator
`inline` with the composed text plus additive `{hitlRequestId, threadIds}`
metadata), linked to the gate's `node_attempt`. Implementation first inspects
`recordDefaultArtifacts`/the existing hitl-response capture to avoid
duplication.

**Loop visibility + exhaustion guard.** At gate creation (`runReviewHuman`)
the stored review schema additionally carries `{ maxLoops, gateAttempt }` —
server-state, both derivable from the `node_attempts` count the runner already
loads (`gateAttempt` is the 1-based visit number of the current gate, initial
visit = 1). Total allowed gate visits = `maxLoops + 1` (the engine's
prior-count check runs BEFORE the attempt row is appended:
`nodeAttemptCount > maxLoops` throws `CONFIG` → run `Failed`).
`hitl-validate.validateReviewDecision` gains: a rework decision is rejected
(`NEEDS_INPUT`, 422) when `gateAttempt ≥ maxLoops + 1` — equivalently,
**reject rework when `gateAttempt > maxLoops`; total visits = `maxLoops + 1`**
— preventing the today-possible foot-gun where a final-loop rework silently
fails the whole run. The engine throw stays as the backstop. The UI shows
"Rework loop N of M", disables rework at the boundary, and soft-warns (never
blocks) approve while open threads exist. Both sides of the boundary are
pinned by unit test before the validate rule lands.

**Routes — a new family, NOT the respond route** (comments are drafted
incrementally before the decision):

- `GET /api/runs/{runId}/review-comments` — `readBoard` (viewer), not
  status-gated (history stays visible like the diff). Returns threads with
  computed `placement`.
- `POST /api/runs/{runId}/review-comments` — `answerHitl` (member) +
  open-review-gate guard. Body: root `{filePath, side, line, body}` | reply
  `{parentId, body}`.
- `PATCH /api/runs/{runId}/review-comments/{commentId}` — `answerHitl` + gate
  guard. `{body}` (author-only edit) | `{status: open|resolved}` (root-only;
  any `answerHitl` member).
- `DELETE /api/runs/{runId}/review-comments/{commentId}` — `answerHitl` + gate
  guard, author-only; a root delete cascades its replies.

**Open-review-gate guard (allow-list):** `runs.status ∈
PENDING_HITL_RUN_STATUS` (= `{NeedsInput, NeedsInputIdle}` — the existing
constant, exported as part of this work; never a `!terminal` complement) AND a pending
`hitl_requests` row (`respondedAt IS NULL`) with `kind = 'human'` AND
`schema.review === true` exists; new comments FK that row. Otherwise 409
`PRECONDITION`. Comment writes NEVER touch `runs.status` (the runner owns it).
Every comment operation is a single DB transaction with no external
side-effects, so the respond route's two-phase-commit rule is satisfied
trivially (no artifact write, no supervisor call, no deferred created or
released). **No new `MaisterError` codes**: reuse `PRECONDITION | CONFLICT |
UNAUTHORIZED | NEEDS_INPUT` (+ zod-invalid body → 400 `CONFIG`). The closed
taxonomy is preserved.

**Identifiers (trust-boundary labels):**

| Route | Identifier | Label | Handling |
| --- | --- | --- | --- |
| all four | `runId` | url-param | access-controlled via run row → project → `requireProjectAction` |
| PATCH/DELETE | `commentId` | url-param | row loaded, `row.run_id === runId` compared (server-state) → 404 on mismatch |
| POST (reply) | `parentId` | body-controlled | must resolve to a ROOT comment of the SAME run (server-state compare) → 409 `CONFLICT` otherwise |
| POST (root) | `filePath`, `side`, `line` | body-controlled | validated against the server-computed diff (anchor must exist → else 409 `PRECONDITION`); `filePath` is opaque anchor DATA — **never used as a filesystem path component anywhere** |
| POST/PATCH | `body` | body-controlled | content data; zod: non-empty, ≤ 10 000 chars |
| all writes | author | auth-context | `author_user_id`/`author_label` from the session, never from the body |

`projectId` is always derived from the run row (server-state). No body field
names a cross-resource locator that has a server-state counterpart.

**Service/authz split.** Route handlers own `requireProjectAction`
(`projectId` server-derived from the run row, never the body);
`lib/review-comments/service.ts` is authz-free logic taking `(db, actor)` —
integration-testable against testcontainers without session stubs (follows the
`lib/users.ts updateAdminUser` aggregating-endpoint pattern; hitl.ts's
in-service authz exists only because two routes share it).

**UI — native `@git-diff-view/react` comment API** (spike-confirmed in 0.1.5
typings): `diffViewAddWidget` + `onAddWidgetClick(lineNumber, side)` +
`renderWidgetLine` (composer) + `extendData {oldFile/newFile:
Record<String(line), {data}>}` + `renderExtendLine` (thread display). No
overlay hacks. `extendData` is per-active-file — threads filter by selected
path. Outdated threads render in a collapsible "Outdated" list (file:line +
quoted stale content), resolvable there. Thread-card actions (edit / delete /
resolve / unresolve / reply) are icon-only buttons with translated
`aria-label`s following the house inline-SVG pattern (no icon library
dependency). Refetch-on-mutation + `router.refresh()` for gate-panel counts —
**no polling, no fs.watch, no new SSE events** (multi-tab sync deferred; HITL
state is DB-only today anyway).

**i18n.** All new strings land in `web/messages/en.json` + `ru.json` (the
parity test enforces); labels flow server→client as typed label bundles per
the house pattern.

**Explicitly NOT changed:** no new `runs.status`, no new `MaisterError` code,
no new env var/port/sidecar/dependency, no engine version bump, no flow.yaml
DSL grammar change; the diff stays committed-only `base..branch` and
`readBoard`-gated.

**Consequences:**
- Reviewers leave line-anchored, threaded, resolvable comments on the review
  gate diff; the rework agent receives them as deterministic markdown inside
  the existing `{{ <commentsVar> }}` injection — no new delivery channel.
- Zero-thread behaviour is byte-identical to today, so every existing flow and
  test keeps passing without migration; the regression is pinned by test.
- The respond route's two-phase commit and idempotency CAS stay untouched
  (runner-side compose is what makes that possible); comment routes are
  single-transaction, single-store — no new crash windows.
- A final-loop rework is rejected at validate time (422) instead of silently
  failing the run; the engine `CONFIG` throw remains the backstop. As-built,
  that engine check was additionally fixed to fire only when a FRESH visit
  would be appended (the `reusesCurrentAttempt` exemption in
  `runner-graph.ts`) — it previously also fired on resume-reuse re-entries,
  killing ANY decision processed at the final allowed visit; a rework that
  slips past the validate rule still dies at the visit `maxLoops + 2`
  append.
- Outdated anchors are detected (exact-match placement) but never re-anchored;
  a moved line shows as "outdated" until a human resolves or re-creates the
  thread — accepted v1 trade-off (fuzzy/`git-blame` re-anchoring is a v2
  candidate).
- GET recomputes placement per request (one DB query + one in-memory diff
  parse, no N+1) — no placement cache to invalidate, at the cost of a diff
  parse per read.
- No live multi-tab sync: a second tab sees new comments on
  refetch-after-mutation or reload only.

**Alternatives Considered:**
- **Store comments as `.maister/` run artifacts:** rejected — comments span
  multiple gate visits and rework iterations, need open/resolved queryability
  at compose time, RBAC-gated writes, GC survival, and evidence linkage; a
  file per gate visit gives none of that.
- **Carry comments inside the respond route's `response` payload:** rejected —
  comments are drafted incrementally BEFORE the decision; the respond route's
  two-phase commit + idempotency CAS are locked invariants and
  `hitl_requests.response` must stay a pristine user-submitted payload.
- **Compose the payload at respond time (web-side) into the input artifact:**
  rejected — it would change the respond route's artifact contents and break
  the "response/input artifacts are user payloads" invariant; runner-side
  compose keeps the route untouched and the zero-thread path byte-identical.
- **SHA-pinned or fuzzy (`git-blame`) re-anchoring:** rejected for v1 —
  non-deterministic placement corrupts evidence; exact content match at the
  same position gives GitHub-style "outdated" semantics deterministically.
- **Two tables (`review_threads` + `review_comments`):** rejected — a 1-level
  self-FK on one table expresses root+replies with a single CHECK constraint
  and fewer joins.
- **New SSE event / polling for live comment sync:** rejected — violates the
  no-polling invariant for marginal v1 value; HITL state is DB-only today.

---

### ADR-066: Editor and diff rendering stack (Shiki, git-diff-view, CodeMirror)

**Date:** 2026-06-08
**Status:** Accepted
> **Amended by [ADR-082](#adr-082-review-diff-completeness-with-dirty-state-protocol-and-scope-switcher) (2026-06-11):** the review-diff 4-mode `scope` switcher reuses this `prepareDiff` pipeline + byte-cap truncation guard.
**Context:** Three code-content surfaces render with no syntax highlighting.
(1) The M22 workbench (ADR-053) shows git-tracked repo files in a plain `<pre>`
(`file-viewer.tsx`) — no highlighting, no line numbers, read-only. (2) The same
workbench renders the base→branch diff as raw `git diff` text in a `<pre>`
(`raw-diff.tsx`) — no side-by-side, no line numbers, no per-file `+`/`−` counts.
(3) The M25 authored-Flow catalog (ADR-061) edits `flow.yaml` and typed package
files (`skill`/`rule`/`agent_definition`/`schema`/…) in plain `<textarea>`s — no
highlighting, no inline validation. We need: highlighted multi-format file
viewing (first priority), a real diff (side-by-side + inline, line numbers,
per-file `+`/`−` counts, collapsible hunks), and smart editing for authored Flow
artifacts (highlighting + inline validation + context autocomplete). Stack
constraints: Next 16 App Router (RSC + SSR), React 19, Tailwind 4 + HeroUI v3,
`.light`/`.dark` class on `<html>`, MIT-only deps, a self-hosted (offline-capable)
host, i18n EN/RU.

**Decision:** Adopt a best-of-breed **hybrid**, not a single all-in-one editor.
Monaco is rejected for the current surfaces (see Alternatives).

- **Repo file viewing (read-only, first priority) — Shiki, server-rendered.** A
  React Server Component highlights the blob with `shiki` and ships HTML (**0 KB
  client**, no worker, no `ssr:false`). Dual-theme output emits CSS variables
  switched by the existing `.light`/`.dark` class on `<html>` — no theme
  parameter to the server, no re-render on toggle, no FOUC. The selected file
  moves into the URL (`?file=`, deep-linkable) per the data-management URL-state
  convention; the server component reads the blob via the existing
  `readBlob`/`readRepoFiles` path (git-tracked-only; the size/binary caps are
  preserved but surface as `file-too-large`/`file-binary` page states on the
  `?file=` RSC render, not the retired `…/files/content` route's HTTP `413`/`415`).
  The interactive file tree stays a client component.
- **Diff — `@git-diff-view/react`.** Split (side-by-side) + unified (inline),
  line numbers, collapsible hunks. Per-file additions/deletions are **computed
  server-side** in `GET /api/runs/[id]/diff` (the library's
  `additionLength`/`deletionLength` are not populated via the public init path —
  spike-confirmed), and the response gains `additions`/`deletions` per file.
  Highlighting is the shared Shiki, run **server-side**: the `DiffFile` + bundle
  are built on the server and hydrated on the client, so **no Shiki ships to the
  client**; the library's default lowlight/highlight.js highlighter is
  overridden. The component is comment-ready (`extendData` / `renderExtendLine` /
  `DiffViewWithMultiSelect`), so the future Human-Gate code-review/rework feature
  builds on the same diff without re-doing it. Spike-verified: v0.1.5, React 19
  peer, MIT.
- **Authored-Flow editing — CodeMirror 6** (`@uiw/react-codemirror`, dynamic
  `ssr:false`) replaces the `<textarea>`s. Per-kind language (yaml / json /
  markdown+frontmatter / shell). "Smart" editing = inline validation (a
  **client-side** `@codemirror/lint` source — `validateAuthoredFlowPackageBody`
  is `server-only`, so the lint reuses its client-safe primitives `parseYaml`
  (precise YAML line markers) + `flowYamlV1Schema` (file-level schema issues);
  graph/digest validation stays server-side on save) + context autocomplete
  (step types `cli|agent|guard|human`, runner names, known frontmatter/tool keys).
- **Single Shiki major — `shiki@4`.** The read-view and the diff share `shiki@4`
  (it dropped legacy Node support — smaller and more stable), run server-side
  only. The diff plugs Shiki in through a thin custom `DiffHighlighter` adapter
  (`getAST` → Shiki `codeToHast`), avoiding `@git-diff-view/shiki` (which pins a
  stale `shiki@3`). Shiki never ships to the client.

The workbench **read-only boundary** (ADR-053/064) and the M25 **authored-draft**
lifecycle (ADR-061) are unchanged: repo files stay view-only (no write route —
confirmed scope), and authored editing keeps its `manageCatalog` gate, optimistic
lock, and validation gates. Only presentation and the `/diff` response shape
change.

**Consequences:**
- Repo viewing adds ~0 KB to the client (server-rendered); the diff tab adds the
  `@git-diff-view/react` runtime (~30–60 KB) + a serialized syntax bundle (data,
  not a highlighter); CodeMirror loads only on the authored-editing route via
  `ssr:false`.
- One highlighting system (Shiki) is shared by read-view and diff; CodeMirror is
  the only editor, used only where a cursor is needed.
- New MIT deps: `shiki`, `@git-diff-view/react`, `@uiw/react-codemirror` +
  `@codemirror/*`. `@git-diff-view/react` is `0.x` → pin the exact version.
- `GET /api/runs/[id]/diff` gains per-file `additions`/`deletions` and a
  structured `truncated` flag (set when the diff exceeds the 4 MiB
  `EXEC_MAX_BUFFER` bound, so the diff readers degrade to a bounded prefix
  instead of throwing); `web.openapi.yaml` updates with the code. The review
  panel blocks promotion behind an explicit acknowledgement when `truncated`.
- New syntax-token surface in `globals.css` (Shiki dual-theme CSS vars + a forest
  CodeMirror theme mirroring them); the forest palette previously had no
  keyword/string/comment tokens.
- The diff substrate is comment-ready, lowering the cost of the separate
  Human-Gate code-review/rework feature (its own ADR, TBD).
- Domain contracts (`workbench.md`, `capability-catalog.md`) carry a `(Designed)`
  pointer to this ADR now and are rewritten to the shipped contract per slice.

**Alternatives Considered:**
- **Monaco everywhere:** rejected for current surfaces — 2–5 MB on the client on
  every surface incl. the read-first viewer, client-only (loses RSC/SSR), default
  worker load from the jsDelivr CDN (bad for a self-hosted/offline host;
  self-hosting workers is extra Turbopack config), and its TS IntelliSense is
  overkill for YAML/JSON/Markdown. Reserved for Phase 2 (true in-browser TS
  IntelliSense, e.g. test-run UI / live agent editing).
- **CodeMirror everywhere** (read + edit + `@codemirror/merge`): rejected as the
  default — loses Shiki's 0-KB server-rendered read view; `@codemirror/merge` is a
  merge view, a weaker git-patch renderer than git-diff-view (per-file `+`/`−` +
  collapsible multi-file).
- **`@git-diff-view/shiki`:** avoided — it pins a stale `shiki@3`; instead a thin
  custom `DiffHighlighter` adapter wraps the shared `shiki@4`, and highlighting
  runs server-side (the bundle is passed to the client), so Shiki never ships to
  the browser.
- **`codemirror-json-schema` for YAML/JSON schema:** rejected — pins a stale
  `shiki@^1` transitive; reuse the existing `yaml` + `zod` validator via
  `@codemirror/lint`.
- **react-diff-view / diff2html / react-diff-viewer-continued:** rejected —
  refractor/Prism/highlight.js/Emotion fragment the highlighting + theme story
  away from Shiki; the git-diff-view spike cleared every diff requirement plus
  first-class inline comments.

---

### ADR-073: Harness adequacy & coherence metrics (read-only Observatory extension)

**Date:** 2026-06-10
**Status:** Accepted
**Context:** Observatory (ADR-059, M23) reports correction pressure, autonomy,
and signal clusters, but says nothing about whether the **harness itself** is
adequate: which declared gates (sensors) actually fire, which have never caught
anything, which controls (gates, capability records) correlate with less
downstream rework, and which flow nodes carry guidance (skills/rules/
restrictions) with no sensor verifying compliance. This sensing layer is a
prerequisite for the later automatic self-correction loop
(`docs/pv/improvement-roadmap.md`); without it, harness changes are blind. The
data already exists in `gate_results`, `node_attempts`,
`runs.resolved_capability_set` (ADR-069), `runs.flow_revision_id`, and
`flow_revisions.manifest` — no new collection is needed.

**Decision:** Extend Observatory with four read-only metric families, computed
on-the-fly per the ADR-059 model (pure rollups over bulk rows, explicit `now`
and thresholds as parameters, no new tables, no new routes). Formulas are
normative here and are NOT restated elsewhere (R7).

1. **Sensor firing-rate.** Per `(projectId, flowId, nodeId, gateId)` group and
   rolled up per gate `kind`:
   `executions` = count of `gate_results` rows in scope with a **terminal**
   status (`passed | failed | stale | skipped | overridden`); per-status counts
   for each of those five statuses; `fail_rate = failed / executions`
   (`stale` is surfaced as its own count, not folded into `fail_rate`).
   Non-terminal rows (`pending | running`) are excluded from `executions`.
2. **Never-fired flag.** A gate is flagged "never fired — verify gate quality or
   a blind spot" when ALL hold over the window: (a) it is declared in at least
   one flow revision actually used by a scoped run (joined via
   `runs.flow_revision_id`); (b) `executions >= MAISTER_HARNESS_NEVER_FIRED_MIN`
   (env, default `10`, read at the query layer via `instance-config` and passed
   into the pure rollup as `minExecutions`); (c) `failed + stale == 0`.
   A per-flow threshold override is deliberately NOT in v1: this is a
   sensing-display heuristic, not flow behavior — putting it in the manifest
   would add engine surface for no loop value. Revisit only if the flag proves
   noisy in practice.
3. **Per-control effectiveness.**
   (a) *Per gate:* over node attempts whose gate `g` reached a terminal verdict,
   `rework_followed(attempt)` = a later attempt exists for the same
   `(run_id, node_id)` OR the attempt's `node_attempts.status = 'Reworked'`.
   Report `P(rework_followed | g failed)` vs `P(rework_followed | g passed)`
   and `lift = P(rework | failed) / P(rework | passed)`. Lift far above 1 means
   the sensor's firings are consequential (corrections follow); lift near 1
   means firing changes nothing — a noise candidate.
   (b) *Per capability:* for each capability `refId` appearing in
   `runs.resolved_capability_set.capabilities[]`, compute the existing
   correction-rate (`rollupCorrectionMetrics`, ADR-059) over runs WITH the
   capability vs runs WITHOUT it. Runs with a NULL `resolved_capability_set`
   (pre-ADR-069 launches) are **excluded entirely** — never counted as
   "without".
4. **Coverage map.** Per flow, over the distinct `flow_revisions` referenced by
   scoped runs (`runs.flow_revision_id`; null-revision legacy runs are excluded
   from the declared/coverage side, their firing stats remain counted): per
   node — declared gate count by `mode`, blocking-gate count, and guide-side
   presence (node `settings` declare ≥1 skill, rule, or restriction). A node
   with guides ≥ 1 AND blocking gates == 0 is flagged
   **"guides without sensors"** (instructions exist, nothing verifies them).

Query-layer contract: extend the existing `loadObservatoryRows` bulk loader to
also select `runs.resolved_capability_set` + `runs.flow_revision_id`, and add
exactly ONE new bulk SELECT — `flow_revisions WHERE id IN (distinct revision ids
of scoped runs)` — with manifests parsed in TS for declared gates and node
settings. No caching, no read-model table, no read cursor, no per-run query
loops, no schema change, no new HTTP route (rendering lives on the two existing
observatory pages, RBAC inherited).

Honest-N display rule: every rate is displayed WITH its denominator (n runs /
n executions); a group with `executions < 3` (`MIN_GROUP_EXECUTIONS`) renders
as "—" (insufficient data), never as `0%`.

**Consequences:**
- Operators see, per flow and per project, which sensors fire, which are
  plausibly dead weight, which correlate with corrective action, and where
  flows instruct without verifying — the inputs a human (and later the loop)
  needs to tune the harness.
- One additional bulk SELECT per observatory page load plus in-TS manifest
  parsing of the (few) distinct revisions in scope; acceptable at current
  single-host scale, measured before any caching is considered.
- Lift and with/without comparisons are correlational, not causal; the UI
  labels them as signals (consistent with the M23 "signals, not
  recommendations" rule).
- Legacy runs (null `flow_revision_id` / null `resolved_capability_set`) thin
  the denominators; honest-N rendering keeps that visible instead of implying
  precision.
- New env knob `MAISTER_HARNESS_NEVER_FIRED_MIN` (host env only, ADR-023
  precedent — `.env.example` + `configuration.md`, never compose files).

**Alternatives Considered:**
- **Persisted harness read-model table (nightly rollup):** rejected — premature
  caching; ADR-059's on-the-fly model is proven at current scale and a table
  adds migration + staleness surface for no present need.
- **Per-flow never-fired threshold in the flow manifest:** rejected for v1 —
  display heuristic, not flow behavior; manifest surface would demand an engine
  floor and import/remap handling for no loop value.
- **New dedicated `/harness` route + API:** rejected — duplicates RBAC and
  filter plumbing; the portfolio and project observatory pages already carry
  the correct guards and filters.
- **Counting `stale` into `fail_rate`:** rejected — staleness is rework-driven
  invalidation, not a verdict; folding it in would overstate sensor firing.
  `stale` still counts toward the never-fired test (a gate participating in
  rework loops is not silent).

---

### ADR-074: Artifact post-conditions — deterministic mutation sensor on `artifact_required` gates

**Date:** 2026-06-10
**Status:** Accepted
> **Amended by [ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality) (2026-06-11):** gate-chat L3 neutrality reuses this detect-after mutation-sensor stance with its own first-turn chat-checkpoint baseline.
**Context:** The harness can verify that evidence EXISTS (`artifact_required`,
M12) but not WHAT a node actually changed. Two recurring defect classes are
invisible today: (1) a node that claims success without touching the files its
contract implies (`must_touch`), and (2) a node that modifies paths an M14
restriction forbids — M14 enforcement is `"instructed"` only (ADR-041 defers
strict prevention), so violations currently go undetected. A deterministic
post-condition sensor over `git diff --name-only` closes both gaps cheaply and
feeds the Observatory adequacy layer (ADR-073) and the later self-correction
loop. Detection beats attribution while prevention is blocked.

**Decision:** Extend the `artifact_required` gate with two optional mutation
assertions, evaluated by the existing gate executor against git diff path sets,
always emitting a `mutation_report` artifact when configured.

1. **Gate fields (DSL).** On `gateSchema`, valid ONLY when
   `kind: artifact_required` (zod refine in `validateGraphManifest`, violation →
   `CONFIG`):
   - `must_touch?: string[]` — ≥1 glob; the gate FAILS when the node-scoped
     diff range touches NONE of the globs.
   - `must_not_touch?: "restrictions"` — v1 accepts only this literal: the
     check reads the node's resolved M14 restriction set, never an own path
     list (an explicit list would be new engine surface; future work).
   Assertions evaluate under the gate's existing `mode`
   (`blocking | advisory`) — no new default is invented.
2. **Restriction `paths` contract.** `restrictionCapabilitySchema` gains an
   optional `paths: string[]` — the machine-readable subset of a restriction.
   The sensor checks `diff ∩ paths`; free-text-only restrictions (no `paths`)
   are listed in the report as `unmatchable` (counted, never failed on). Single
   source of truth: the same capability record feeds M14 instruction
   materialization AND this sensor; ADR-041 strict enforcement can later read
   the same field. The node's resolved restriction records are threaded into
   `GateRunContext` (new optional `restrictionPaths`) from the node-start
   materialization site.
3. **Range semantics.**
   - `must_touch` is **node-scoped**: range = `<HEAD at this node's FIRST
     attempt start>..<HEAD at gate time>` — "did this node, across its
     attempts, touch X since it first began". Capture: immediately after the
     `node_attempts` row creation, write `node-start-<nodeId>.json` `{head}`
     into the run dir via `atomicWriteJson`, **write-if-absent** — one file per
     `(run, node)`; attempt 2+ and checkpoint/resume keep the original, so the
     true start survives process death and rework loops (a no-op rework attempt
     does not false-fail: attempt 1's commits are inside the range). Accepted
     inaccuracy: changes by OTHER nodes executed between this node's rework
     loops fall inside the range (tightly bounded; per-attempt strict deltas
     are out of scope). File absent (legacy run, git unavailable at start) →
     fall back to the cumulative range with `basis: "cumulative-fallback"` in
     the report.
   - `must_not_touch` is **cumulative** (a safety net): range = `<merge-base vs
     main>..<HEAD>` via a shared `resolveDiffRange(workspace)` helper extracted
     from the diff-artifact recording block (same `resolveBaseRef` /
     `resolveRefSha`). A restricted-path violation anywhere on the branch flags
     at every checking node.
   - Git unavailable at gate time: blocking → gate FAILS with reason
     `"git unavailable — cannot evaluate mutation assertions"`; advisory →
     WARN + report records `evaluated: false`. A blocking sensor that cannot
     sense must not pass.
   - Touched paths = `git diff --name-only <base>..<head>`, matched with
     `picomatch` (`dot: true`) against repo-relative POSIX paths.
4. **`mutation_report` artifact.** ALWAYS recorded when assertions are
   configured — on pass AND fail: `producer: "gate"`,
   `kind: "mutation_report"` (new closed-catalog member; DB `kind` is a text
   column with a TS-level enum — no migration), locator
   `{ kind: "inline", text: JSON.stringify(report) }`. Report shape:
   `{basis: "node" | "cumulative-fallback", nodeRange: {base, head},
   cumulativeRange?: {base, head}, touched: string[] (node range, truncated at
   500 with a truncated flag), mustTouch: {globs, matched: string[] (truncated
   at 500 with a matchedTruncated flag; the pass/fail decision runs on the
   full set), matchedTruncated: boolean},
   restrictions: {checked: [{id, paths, violations: string[]}],
   unmatchable: string[]}, violations: string[], evaluated: boolean}`.
   Touched paths are read with `core.quotePath=false` so non-ASCII paths
   match globs verbatim (a C-quoted path would silently never match — a
   false-negative on the `must_not_touch` direction).
   The row writes `hash` (sha256 of the locator `text`) and `size_bytes` (its
   byte length) — the first writer of those columns.
   `artifact_def_id = gate.output.id` when declared (the declared kind must
   then be `mutation_report`), else `null` with deterministic instance id
   `run:<nodeAttemptId>:mutation:<gateId>`. The artifact is recorded BEFORE the
   terminal gate transition (a crash between leaves the gate `running` →
   re-executed on rework; same crash-window shape as the existing
   gate/artifact sequence).
5. **Engine gating — NO version bump.** `MAISTER_ENGINE_VERSION` stays
   `1.3.0`; the fields are additive-optional. Drift protection widens the
   EXISTING `validateGraphManifest` floor check: a manifest declaring
   `must_touch`/`must_not_touch` OR `gate.output.kind === "mutation_report"`
   also requires `compat.engine_min >= 1.3.0` (same constant, broader
   trigger). Flows not using the features stay valid at any `engine_min`.
   `restriction.paths` is capability config, not graph-manifest surface —
   additive, no floor.
6. **Readiness integration.** The mutation verdict is stored in
   `gate_results.verdict` (`payload.assertionFailed: true` + reasons). The
   `readiness-core.ts` `artifact_required` failed-gate re-evaluation MUST NOT
   clear a failed gate whose verdict carries `assertionFailed` — inputs-present
   is no longer sufficient (an assertion-failed gate HAS its inputs present and
   would otherwise silently self-clear). Rework that re-runs the gate and
   passes clears it naturally. Blocking/advisory, rollup, staleness, and
   rework re-execution are inherited unchanged.

**Consequences:**
- Mutation defects become first-class, queryable evidence: every configured
  gate leaves a `mutation_report`, pass or fail, feeding the evidence graph and
  the ADR-073 firing-rate metrics.
- M14 restrictions get their first teeth — detect-after instead of
  instruct-and-hope — without preempting ADR-041 strict enforcement; both read
  the same `restriction.paths` field.
- The `must_touch` node range is deliberately approximate across interleaved
  rework (other nodes' commits can fall inside it); accepted in v1 for
  durability and simplicity.
- New prod dependency `picomatch` (tiny, zero-dep, the de-facto glob standard);
  pure JS — lockfile-only deployment change (web runs on host per ADR-023).
- `artifact_instances.hash`/`size_bytes` gain their first writer; readers must
  keep treating them as nullable (legacy rows).
- Gates without assertions are byte-identical to today; no migration, no new
  error code (`CONFIG`/`PRECONDITION` reused), no new HTTP surface.

**Alternatives Considered:**
- **Engine version bump to 1.4.0:** rejected — no installed base of older
  engines exists; bumping is ceremony. Widening the existing 1.3.0 check gives
  the same drift protection without a new floor.
- **Explicit path lists on `must_not_touch`:** rejected for v1 — duplicates the
  restriction catalog and would need its own engine floor; the restriction
  record stays the single source of truth.
- **Per-attempt strict diff deltas for `must_touch`:** rejected — requires
  per-attempt head capture plus attribution of interleaved commits; the
  since-first-attempt range is durable (write-if-absent file), survives resume,
  and cannot false-fail a no-op rework attempt.
- **Glob matching via minimatch/micromatch or hand-rolled matching:** rejected —
  picomatch is the smallest battle-tested matcher (micromatch wraps it);
  hand-rolled glob semantics are a defect farm.
- **Recording the report only on failure:** rejected — a pass with an empty
  match set vs a pass with rich touches are different signals; ADR-073
  effectiveness metrics need both sides.
### ADR-077: Outbound webhooks: generic event-delivery primitive, transactional outbox + singleton drainer

**Date:** 2026-06-10
**Status:** Accepted
**Context:** `PRODUCT_VIEW.md` "Deferred For Now" and the improvement roadmap
(`docs/pv/improvement-roadmap.md:83,189-190`) deferred "generic outbound webhooks
and provider-specific apps" in favour of inbound gate-unblock + agent-over-MCP.
Three forces reopen that deferral as a single, narrow primitive: (1) the roadmap's
own E5 / Wave-4 attention-routing, Telegram, and CI/board-sync bets all need the
SAME thing — a reliable way to push a curated run lifecycle fact to an external
endpoint; building a bespoke notifier per consumer would duplicate signing,
retry, and audit machinery. (2) The curated lifecycle facts (run started / needs
input / review / promoted / done / failed / crashed / abandoned, HITL
requested/responded, gate decided) already exist as DB transitions scattered
across `state-transitions.ts`, the runners, `promote.ts`, `services/hitl.ts`,
`gate-store.ts`, and `workbench-lifecycle/service.ts` — but there is no fan-out
seam. (3) The M24 scheduler (ADR-060) gives a sanctioned single background clock,
so delivery can be tick-driven without a new watcher, honouring the ADR-§1 "no
`fs.watch` / `chokidar` / polling for state transitions" rule. This ADR records
the reopen and the architecture; it does NOT pull any consumer (agent-over-MCP,
Telegram, CI) into scope — those become subscribers, not replacements.

**Decision:** Build outbound webhooks as a generic, vendor-neutral event-delivery
primitive on a **transactional-outbox** seam drained by a **singleton scheduler
job**. Consumers (agent-over-MCP, Telegram / attention routing, CI triggers,
board sync) subscribe to it later; none is built here.

- **Capture seam = transactional outbox at the transition writepoints.** A tiny
  `emitWebhookEvent(tx, …)` INSERT into a `webhook_events` outbox row runs inside
  the SAME transaction as each taxonomy-mapped DB transition (where a transition
  is a bare CAS UPDATE today, the UPDATE + INSERT are wrapped in one
  `db.transaction`). Emit fires only on the CAS-winner path. The write-path
  addition is one INSERT with no reads and no network, so it can only fail if the
  surrounding transaction was already failing — delivery can never block or fail
  a run. Fanout, subscription matching, signing, and HTTP I/O happen entirely OFF
  the run path inside the M24 tick.
- **Taxonomy = 12 curated types, never raw `session/update`.** `run.started`,
  `run.needs_input`, `hitl.requested`, `hitl.responded`, `run.review`,
  `run.promoted`, `run.done`, `run.failed`, `run.crashed`, `run.abandoned`,
  `gate.decided`, and a synthetic unpersisted `ping`. The not-emitted set
  (checkpoint/resume, `HumanWorking`, `Pending`, keepalive, non-terminal gate
  states, `gate.opened`, `node_attempts`, all `session.*`) is additive later
  (one type + one emit + one doc row). Both `run.done` and `run.promoted` are
  kept (promotion success and run completion are distinct consumer facts).
- **Envelope v1 frozen at fanout.** Emit sites store only the minimal record
  (`type`, `projectId`, `runId`, `occurredAt`, per-type `data` — no joins on the
  write path). The full envelope is built ONCE at fanout via a single batched
  join (`runs ⋈ projects ⋈ workspaces ⋈ tasks` — `runs` has no `branch` column),
  frozen into `webhook_events.payload` in the fanout transaction, and reused
  byte-identically by every retry and replay; only `deliveryId`/`attempt` are
  injected at send. `data` carries ids/statuses/titles ONLY — never secrets, env,
  tokens, or raw agent output.
- **Singleton drainer job, NOT one scheduler_job per delivery.** One recurring
  `webhook_delivery.default` job (cadence 60s, budget `webhookDelivery: 1`,
  seeded in `ensureDefaultSchedulerJobs`) whose handler does fanout + drain +
  prune. Retry state lives on `webhook_deliveries.next_attempt_at`; the job's own
  `consecutiveFailures` tracks only handler crashes. Per-delivery scheduler jobs
  would flood the admin jobs catalog, fight `cadence_interval_seconds NOT NULL`
  recurrence semantics, and trip the `max_failures=3` auto-disable against the
  8-attempt curve.
- **At-least-once, unordered; consumer dedupes via idempotency key.**
  Per-subscription ordering is rejected (one delivery in a 24h backoff would dam
  every later event for that endpoint — head-of-line blocking). Every crash
  window converges to a duplicate send; `X-Maister-Idempotency-Key =
  hex(sha256("<subscriptionId>:<eventId>"))` (stable across retries AND replays)
  gives consumers exactly-once effect. `FOR UPDATE SKIP LOCKED` + a delivery
  lease prevents concurrent double-send. Retry curve `1m, 5m, 15m, 1h, 4h, 12h,
  24h` (`±20%` jitter, floor = 60s tick), max 8 attempts → terminal `dead`; HTTP
  `410 Gone → dead` immediately, any 2xx → `delivered`, everything else (incl.
  3xx, `redirect:"manual"`) → retry.
- **Signing = HMAC-SHA256 (Stripe-style), `env:`-ref secrets.** Signature base
  string `"${t}.${deliveryId}.${rawBody}"` (`t` = unix seconds at send), hex
  digest in `X-Maister-Signature: t=<unix>,v1=<hex>`. Secrets are stored only as
  `env:NAME` references, resolved server-side at send, never logged or echoed.
  Rotation appends a second `v1=` from an optional `secondary_signing_secret_ref`.
- **Usage-guarded DELETE.** A subscription DELETE is refused with 409 `CONFLICT`
  while ANY delivery history exists (retire via `enabled=false`); hard delete
  works only for never-delivered subscriptions — matching the
  `platform_mcp_servers` / `platform_acp_runners` usage-guard precedent
  (ADR-065/070) and the project's append-only-ledger DNA.
- **Disable = skip, not buffer** (user-confirmed 2026-06-10). With the global
  `webhooks_enabled=false` kill-switch the drain runs a skip pass — un-fanned
  events are stamped `fanout_at` with zero delivery inserts — and a disabled
  subscription is simply not matched at fanout: disabled-window events are
  never delivered retroactively. Already-fanned-out pending deliveries pause
  and resume on re-enable.
- **SSRF stance (revised 2026-06-11).** Scheme allow-list `http`/`https` only,
  PLUS an enforced destination egress policy (`web/lib/webhooks/destination.ts`):
  blocked ranges are loopback (`127.0.0.0/8`, `::1`), private (`10/8`,
  `172.16/12`, `192.168/16`, `fc00::/7`), link-local incl. the
  `169.254.169.254` cloud-metadata endpoint (`169.254/16`, `fe80::/10`),
  multicast, and unspecified (`0.0.0.0/8`, `::`); IPv4-mapped IPv6 classifies
  by the embedded IPv4. An IP-literal destination in a blocked range is
  refused `CONFIG` → 422 at write time; the single `signAndSend` chokepoint
  (drain AND ping) re-checks literals and resolves hostnames (`dns.lookup`,
  all records — ANY blocked answer refuses) BEFORE the wire, then connects
  through an undici dispatcher pinned to the vetted addresses so the
  connect-time answer cannot differ from the checked one (DNS-rebind TOCTOU
  closed; TLS SNI keeps the hostname). A refused destination records
  `error_kind: config` — nothing is sent. `MAISTER_WEBHOOK_ALLOW_HOSTS`
  (comma-separated exact hosts, operator env) exempts known-internal
  endpoints (e.g. `127.0.0.1` for a local consumer in dev/e2e). The v1
  "operator-trusted" deferral was dropped: a `member`-created subscription or
  ping plus the persisted, viewer-readable response snippet forms a cloud-IMDS
  credential read primitive.
- **No new error code.** Reuse `CONFIG` (bad `env:` ref / validation), `CONFLICT`
  (replay state / dup / usage-guarded delete), `PRECONDITION`, `UNAUTHORIZED`;
  `docs/error-taxonomy.md` is untouched. The attempt `error_kind`
  (`timeout|network|http|config`) is a LOCAL enum, not a `MaisterError`.

**Consequences:**
- One reusable primitive serves every current and future notifier; the E5 /
  Wave-4 agent-over-MCP, Telegram, CI, and board-sync bets become SUBSCRIBERS,
  not bespoke integrations.
- Capture is exactly-once (shares the transition's transaction — no jsonl replay
  to dedupe); fanout is exactly-once (`fanout_at` set in the same tx as the
  delivery inserts, with `UNIQUE (subscription_id, event_id)` as belt-and-braces);
  delivery is at-least-once (crash windows + lease expiry).
- Delivery latency ≈ one tick (60s cadence + external cron period) — accepted for
  notification/CI semantics; a sub-tick in-process drain kick is a future additive
  change (still no new clock).
- Four new tables (`webhook_subscriptions`, `webhook_events`,
  `webhook_deliveries`, `webhook_delivery_attempts`) + one column
  (`platform_runtime_settings.webhooks_enabled`) land in migration `0040`. A new
  `job_kind: webhook_delivery` joins the scheduler enums + budgets + dispatch.
- The outbox grows on every transition; zero-delivery events (matched no
  subscription) are pruned after 7 days, while any event referenced by a delivery
  is kept forever for replay/audit.
- New env knobs: `MAISTER_WEBHOOK_DELIVERY_BATCH`, `MAISTER_WEBHOOK_TIMEOUT_MS`,
  `MAISTER_WEBHOOK_MAX_ATTEMPTS`.

**Alternatives Considered:**
- **Projector hook (advance `artifact-projector` to drive webhooks):** rejected —
  the projector sees low-level `session.*` noise, not curated lifecycle
  transitions, and is barred from run-status semantics (ADR-022/038); it is the
  wrong event source and a layering violation.
- **jsonl-cursor consumer drained by the tick:** rejected — `run.events.jsonl`
  carries session events, not the curated taxonomy, and would require its own
  replay-dedupe machinery the DB outbox makes unnecessary.
- **Inline fanout at the transition (read subscriptions + N inserts in the hot
  tx):** rejected — puts subscription reads and N delivery inserts into hot run
  transactions for no latency win that matters (delivery is tick-paced anyway).
- **One `scheduler_jobs` row per delivery:** rejected — floods the admin jobs
  catalog, fights `cadence_interval_seconds NOT NULL` recurrence, and trips
  `max_failures=3` auto-disable against the 8-attempt curve.
- **Per-subscription ordered delivery:** rejected — serial per-endpoint delivery
  makes one stuck delivery (24h backoff) dam every later event (head-of-line
  blocking), fatal for notification semantics; unordered + idempotency key is
  safe and live.
- **Private-address SSRF blocking in v1:** initially deferred (endpoints
  self-hosted and operator-trusted, M16 precedent) — revised 2026-06-11: a
  `member`-created `http://169.254.169.254/…` destination plus the persisted,
  viewer-readable response snippet is an IMDS credential-exfil primitive on a
  cloud host, sharper than the deferral's rationale. The destination egress
  policy in the Decision is now part of v1; `MAISTER_WEBHOOK_ALLOW_HOSTS`
  covers legitimate internal endpoints.
- **A new `MaisterError` code (e.g. `WEBHOOK`):** rejected — `CONFIG`/`CONFLICT`/
  `PRECONDITION`/`UNAUTHORIZED` cover every failure; a new code would churn
  `error-taxonomy.md` and the UI branch table for no behavioural gain.

---

### ADR-075: Flow Studio Phase 2 viewer, fork-to-authored-draft, kind-by-path, and content-validation severity

**Date:** 2026-06-10
**Status:** Accepted
**Context:** M27 Stage 1 shipped the authored-flow graph editor write path but
left INSTALLED (git-pinned) flow packages unviewable from the project UI (decoy
`cursor-pointer` cards that navigate nowhere) and the package-file editor a flat
generic-CodeMirror list with a manual, divergence-prone kind `<select>`.
Installed `flow_revisions` are immutable and store only the parsed `manifest`
jsonb + `manifest_digest` in the DB — raw `flow.yaml` text and bundled artifact
files exist ONLY on disk at `flow_revisions.installed_path`. Phase 2 (part 1)
must make a package browsable + forkable and give its artifacts real editors,
WITHOUT a migration, engine bump, or new `runs.status` / `MaisterError` code.
(Numbered ADR-075 — renumbered from 072 at verification on 2026-06-11: while
this branch was in flight, main took 071 (run schedules), 072 (review
comments), and 073/074 (harness metrics, artifact post-conditions); 075 is the
next free number, ADR numbers being globally sequential across parallel
branches.)

**Decision:** Eight locked choices (D1–D8):

1. **Installed-content source + viewer route (D1).** File bodies and raw
   `flow.yaml` come from DISK at `flow_revisions.installed_path`; graph topology
   compiles from the DB `manifest` jsonb (digest-pinned, survives disk loss). The
   viewer is a NEW project-scoped RSC page
   `app/(app)/projects/[slug]/packages/[flowRefId]/page.tsx` — the URL segment is
   the human-readable `flow_ref_id` (unique per project via
   `(project_id, flow_ref_id)`), never a row UUID. `?rev=` selects a non-enabled
   revision; `?file=` selects an artifact. NO new GET content API routes — server
   components read disk directly (ADR-066 RSC-reads precedent). Authz
   `requireProjectAction(projectId, "readRepoFiles")` (member). Degraded mode: a
   missing `installed_path` still renders metadata + graph from the DB `manifest`,
   with a typed "bundle not available on disk" files state — never a throw.

2. **Fork-to-edit (D2).** Installed revisions are immutable; editing always forks
   to an M25 authored `flow` draft. NEW route
   `POST /api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork`
   (`manageCatalog`). Body `{slug?, title?}` names only the NEW resource — NO
   filesystem / cross-resource locator (`installed_path` is read from the DB row).
   Server: resolve flow+revision (project-scoped) →
   `readAuthoredFlowPackageDirectory(revision.installedPath)` →
   `createAuthoredCapability({kind:"flow", …, sourceFlowRefId: flow.flowRefId})`
   in ONE transaction → 201 `{capId, projectSlug, slug}`. Slug defaults to
   `flowRefId`; collision probes `-fork`/`-fork-N`; an EXPLICIT colliding slug →
   409. All reads precede the single write; no idempotency marker. The fork reads
   `setup.sh`/scripts as draft TEXT and executes nothing.

3. **Static read-only graph (D3).** `FlowGraphView` gains optional `runContext?`;
   absent → static mode (no `useRunStream`, no `/graph-status` fetch, no status
   chips / current-node ring). Existing run callers pass `runContext` unchanged.
   The viewer compiles `compileManifest(revision.manifest)` →
   `buildGraphTopology` + `presentationLayout` server-side and passes plain DTOs.

4. **File model: tree + kind-by-path (D4).** The persisted model stays
   `files[{path, content}]`; the tree is a derived client view. Kind is STRICTLY
   inferred from path via `classifyPackageFile` (the manual `<select>` is removed
   — install/bridge classify by path only, so a hand-set kind silently diverges
   at publish). Add = a new path; rename/move = ONE path-edit operation, kind
   re-inferred.

5. **`form_schema` builder (D5).** A structured field editor over
   `formSchemaSchema` with a raw-JSON CodeMirror toggle + a LIVE preview rendering
   `HitlDecisionControls` via `formFieldsFromSchema` (no-op callbacks). Same
   builder serves `output.result` schemas (same grammar, ADR-063). No full visual
   drag-builder.

6. **Per-kind validation severity (D6).** One shared module emits
   `{severity:"block"|"warn", code, path, message}`; the BLOCK subset is wired
   into the server draft-save hard-gate (alongside
   `assertAuthoredFlowManifestValid`, BEFORE the `draft_version` CAS → `CONFIG`
   422), mirrored client-side. BLOCK: malformed `schemas/*.json`; a manifest-
   REFERENCED schema failing `formSchemaSchema`; skill/agent md with
   missing/unparseable frontmatter or missing `name`/`description`. WARN (never
   blocks): rule-guardrail frontmatter shape, shell heuristic lint,
   unreferenced-schema grammar, unknown frontmatter keys. Manifest-reference
   resolution runs only when the manifest parses; file-level BLOCK checks run
   regardless. An installed package with pre-existing BLOCK violations still
   forks; the first save surfaces the blocks.

7. **Typed edges: one source of truth (D7).** The connect-modal and the side-form
   both write through `setTransition(manifest, source, outcome, target)` →
   `applyManifest`. On connect: a modal collects the outcome (default `success`);
   a duplicate outcome for the source warns it will retarget. No second edge
   store.

8. **Presentation completion (D8).** `addNode` writes the canvas spawn x/y into
   `presentation` at add time; `presentationLayout` / `toFlowGraphView` carry and
   apply `width/height/color`; the node side-form gains three optional inputs. No
   canvas resize-handles / colour palette. The YAML-tab ↔ canvas state fork is
   fixed by making `FlowEditorTabs` the single manifest-state owner with a
   debounced YAML→graph re-seed (a parse error keeps the last-good graph + an
   inline banner).

**Consequences:**
- No migration, no engine bump, no new `runs.status`, no new `MaisterError` code
  — every column relied on (`source_flow_ref_id`, `installed_path`, `exec_trust`,
  `version_binding`, `manifest`, `manifest_digest`, `enabled_revision_id`)
  already exists.
- `flow_revisions.installed_path` (absolute server path) becomes a read source
  but MUST NEVER appear in a client DTO / prop / log / error (explicit-DTO
  projection discipline).
- `compileManifest` + the topology builder become client-safe (errors-core swap,
  drop `server-only`, extract the topology builder) to enable the live
  YAML→graph preview; `server-only` leaks are caught only by the e2e
  client-bundle smoke, not unit tests.
- Kind-by-path removes a latent publish-time divergence; the editor shows a
  read-only inferred-kind badge.
- `createAuthoredCapabilitySchema` is unchanged: the fork calls
  `createAuthoredCapability` with the TS input directly (no zod re-parse), so
  `source_flow_ref_id` is server-seeded without widening the public `POST /caps`
  create body (fork is the only setter).
- Trust / execution stays separated: this feature DISPLAYS `exec_trust` and
  executes nothing.

**Alternatives Considered:**
- **New GET content API routes for file bodies:** rejected — ADR-066 retired the
  run/project `files/content` routes in favor of RSC disk reads; page query
  params are documented in system-analytics, not OpenAPI.
- **Editing installed package files in place:** rejected — installed revisions
  are immutable; in-place edits would break the digest-pinned / run-pinned
  contract. Edit = fork to an authored draft.
- **Manual kind `<select>` retained:** rejected — install/bridge classify by path
  only; a hand-set kind silently diverges at publish. Path is the single source.
- **shellcheck host binary for script lint:** rejected — it would add a
  deployment touchpoint (container wiring); a pure-JS heuristic WARN-only lint is
  sufficient and dependency-free.
- **Blocking on rule-guardrail frontmatter shape:** rejected — no web runtime
  parser consumes those fields, so a block would be a false compliance signal;
  WARN-only.

---


### ADR-076: ACP runner model discovery (resolver-on-supervisor) + configured-model application

**Date:** 2026-06-11
**Status:** Accepted
**Context:** Two stacked, code-confirmed gaps in the runner catalog domain.
(1) **No discovery.** `platform_acp_runners.model` is free text
(`z.string().min(1)`), rendered as a bare `<input type="text">` in
`acp-runner-modal.tsx`; the only guidance is seven hardcoded presets in
`web/lib/acp-runners/presets.ts`. An operator must already know the exact model
id for the selected adapter+provider. (2) **No application.** The configured
model never reaches the agent. `spawn.ts` only *logs* `executor.model` — no env
var, no settings write, no ACP call — so the adapter runs its own default and
`cost.ts` scrapes the *actual* model from the wire after the fact. A dropdown
without the application fix would be decorative. Both are control-plane
correctness gaps, not new product surface; they ship together. ACP already
carries model state we ignore: `NewSessionResponse.models` (`{ availableModels[],
currentModelId }`, also on Resume/Load/Fork) and a client `setSessionModel`. The
supervisor today reads only `sessionId` from `session/new` and ignores the
`session/resume` response entirely (`acp-client.ts`).

**Decision:** Add a **model-catalog resolver on the supervisor** plus a **model
application channel per adapter**, with the web tier as a thin admin-gated config
surface. Seven locked sub-decisions:

1. **Resolver-on-supervisor.** Discovery and `env:NAME` secret resolution happen
   supervisor-side (the supervisor may run on another host and already owns
   `process.env`, the adapter binaries, and `CcrManager`). A new supervisor route
   `POST /model-catalog/resolve` takes a runner **draft** (`{ adapter, provider,
   router?, sidecarId? }` + bare env-ref **names**) and returns
   `{ models, sources, resolvedAt, ttlSeconds }`. The web proxies it through an
   admin-gated route; secrets never reach the browser, and raw secret values are
   never accepted (only `env:NAME` references, regex-validated, resolved
   server-side).
2. **Pluggable `ModelSource` registry** keyed by `(adapter, provider.kind,
   router)`. `resolveModelCatalog(draft)` runs every source whose `supports(draft)`
   is true, **merges + dedupes by model `id`** (first-source-wins on a dup; the
   `origins` tags accumulate), and aggregates a per-source `status`
   (`ok | skipped | error`). A per-source failure NEVER fails the whole resolve.
   Adding a provider/adapter = a new `ModelSource` module registered in
   `registry.ts`; the resolver core is untouched.
3. **ACP active probe (A2) is the primary source.** Synthesize a throwaway
   `RunnerLaunch` from the draft, spawn the already-trusted adapter binary in an
   isolated tmp cwd, `initialize` → `session/new`, read `NewSessionResponse.models`,
   then **tear down** (`SIGTERM`, escalating to `SIGKILL` after a bounded grace).
   A promptless handshake spends ~0 tokens (no `session/prompt`
   is sent). A **passive harvest** of the same `models` from *real* session spawns
   (and the previously-ignored `session/resume` response) also lands — free, same
   code path. Secondary sources: **provider-API** (`anthropic`/`openai`/
   `openai_compatible` `GET /v1/models`; OpenRouter is keyless; the plain
   `anthropic`/`openai` kinds carry no env-ref field, so the source reads the
   conventional host keys `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` and reports
   `skipped` when unset), **curated GLM
   static list** for `anthropic_compatible` (z.ai has no listing endpoint — verified
   2026-06-10 — with one optional best-effort authed `GET {base}/models` that
   gracefully falls back to curated), and **CCR** (`GET {proxy}/api/config` →
   flatten `Providers[].models`).
4. **In-memory cache, no DB persistence.** A single supervisor host caches resolve
   results keyed by a stable hash of `(adapter, provider.kind, base_url, sorted
   env-ref NAMES, router, sidecarId)` — **names, never secret values**. TTL is a
   code constant (~3600 s); `force` bypasses and repopulates. The same cache
   singleton backs the route and the passive harvest. Harvest writes MERGE into a
   live entry (union by model id) and preserve its expiry window — they never
   replace a resolved catalog and never extend a stale row's TTL. The catalog is
   not persisted to Postgres and `platform_acp_runners.model` stays free text.
5. **Application channel per adapter.** **claude →** the M14/ADR-043
   `settings.local.json { model, availableModels }` materialization channel (the
   adapter calls `query.setModel()` from settings at startup; the materializer
   already receives `executor.model`. The scratch path materializes
   unconditionally, but a capability-less graph node previously skipped
   materialization entirely — so the fix is content PLUS an explicit-empty
   materialization: write a non-null `settingsLocal` whenever `model` is set, and
   materialize claude `ai_coding`/`judge` nodes with an explicit-empty profile
   when they declare no capabilities).
   **codex →** ACP `unstable_setSessionModel(runner.model)` after `session/new`
   and after every `session/resume` when `runner.model !== currentModelId` (an
   absent `currentModelId` counts as different). See
   the Phase 0A spike note (`docs/spikes/2026-06-11-acp-model-discovery-spikes.md`).
6. **Model mismatch is advisory, never a run failure.** claude is verify-only: a
   reported `currentModelId` differing from the configured model emits an
   **advisory** informational event and the run continues. codex applies actively:
   a failed `setSessionModel` call emits the advisory (there is no read-back /
   re-apply loop — the set response is not re-checked). Env-router slot-mapping
   legitimately reports a mapped name, so a mismatch is expected and benign.
   `cost.jsonl` model attribution stays ground truth.
7. **No new error code, no new status, no new enum, no new DB/migration, no new
   required env-var** (the provider source optionally reads the conventional
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` host keys — see sub-decision 3 and
   `configuration.md`).
   Consistent with sub-decision 2 (*a per-source failure NEVER fails the whole
   resolve*), the supervisor resolve route throws exactly ONE status for request
   problems — **`PRECONDITION`→409** on a malformed draft (unknown adapter, an
   `env:`-prefixed or raw-secret value in an env-ref field, a malformed provider
   union, `router` without `sidecarId`). Every **source-level** failure (a missing
   provider env-ref, CCR unreachable, an ACP-probe reject/timeout, or a malformed
   adapter/CCR/provider decode of `ACP_PROTOCOL` class) is captured as that
   source's `status:"error"|"skipped"` **inside a 200** response and never throws.
   The **web admin proxy** adds `CONFIG`→422 (a raw/non-`env:` secret, an unknown
   env-ref name, or an unknown `sidecarId`) and `EXECUTOR_UNAVAILABLE`→503 (the
   supervisor unreachable or returning 5xx). The mismatch advisory rides the
   existing `session.update` SSE event as a supervisor-synthesized `update` payload
   variant (`{ sessionUpdate: "model_advisory", … }`) — the closed `SessionEvent`
   union (`types.ts`) is **not** extended, and the web SSE bridge / transcript
   tolerate it because `session.update.update` is already opaque.

**Consequences:**
- The configured model now actually pins the agent for claude (settings) and codex
  (`setSessionModel`), closing the silent "ran the default model" gap; the runner
  modal gains a discovery-backed combobox instead of a blind text field.
- Discovery is best-effort and layered: if the probe is skipped (codex without
  non-interactive auth) or a provider source errors, the resolver still returns the
  other sources and the offline presets remain the UI fallback — discovery never
  blocks a save (`model` stays `min(1)` free text; an unknown model on save is an
  advisory hint, not a validation error).
- One supervisor host = one in-memory cache. Multi-host or persisted catalog is out
  of scope; revisit only if a second supervisor host lands.
- The probe spawns a child process + ACP connection — a deferred-like resource.
  EVERY probe exit path (success, `initialize`/`session/new` reject, parse error,
  timeout) MUST tear the child down (`SIGTERM` → bounded grace → `SIGKILL`) and
  close the connection ("log and continue" is forbidden); this is carried as a
  T2.1 acceptance test.
- `cost.jsonl` remains the single source of truth for billed model attribution; the
  advisory event is observability only and never drives run state.

**Alternatives Considered:**
- **Resolver on the web tier:** rejected — the web tier does not (and must not)
  hold provider secrets or spawn adapter binaries, and the supervisor may run on a
  different host. Resolving web-side would either leak `env:NAME` values to the
  browser host or duplicate the adapter/CCR lifecycle the supervisor already owns.
- **Persist the discovered catalog to Postgres:** rejected for v1 — a single
  supervisor host needs no shared store, and a TTL'd in-memory cache avoids a
  migration, a projection, and a staleness-vs-DB reconciliation problem for data
  that is cheap to re-fetch.
- **`unstable_setSessionModel` for claude too (uniform channel):** rejected — it
  pins *after* `session/new` and needs a read-back, whereas the adapter already
  consults `settings.json`'s `model` at startup; the settings channel is the
  M14-blessed, already-wired path and avoids an extra protocol round-trip. codex
  keeps `setSessionModel` because its settings surface differs.
- **A dedicated `session.model_advisory` SSE event (extend the union):** rejected —
  it would touch the closed `SessionEvent` union, both AsyncAPI `EventBase` enums,
  and force the web bridge to learn a new kind, for an informational signal that
  rides the already-opaque `session.update` channel with zero new surface.
- **Fail the run on a model mismatch:** rejected — env-router and CCR legitimately
  remap model names, so a strict equality gate would false-positive and break valid
  runs; advisory + `cost.jsonl`-as-truth is correct.
- **Probe timeout / cache TTL as env vars:** rejected for v1 — keeping them code
  constants holds the deployment surface flat (no new `.env`/compose wiring); they
  graduate to env vars only if operations proves a tunable is needed.

---

### ADR-078: Gate-chat at HITL pauses with three-layer workspace-neutrality

**Date:** 2026-06-11
**Status:** Accepted
**Context:** When a run parks at a human gate (`human_review` persisted as a
`human`-kind HITL, or a `form`), the reviewer often needs to ask the agent a
clarifying question ("why did you choose X?", "where is Y handled?") without
resolving the gate or mutating the worktree under review. Today the only options
are approve/reject or a full manual takeover
([ADR-030](#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status)).
There is no answer-only back-channel to the parked agent session. The chat must
also be *workspace-neutral*: a Q&A turn must not silently change files. M14
enforcement is `instructed`-only
([ADR-041](#adr-041-capability-registry-refs--agent-aware-mapping--runner-owned-native-materialization))
and the
[ADR-074](#adr-074-artifact-post-conditions--deterministic-mutation-sensor-on-artifact_required-gates)
mutation sensor proved a deterministic "detect-after" stance is viable, so
neutrality is layered, not a hard sandbox.

**Decision:** Add an answer-only **gate-chat** channel at HITL pauses plus a
three-layer workspace-neutrality guarantee. Chat NEVER resolves the HITL and
NEVER flips the run to `Running`.

1. **Persistence — new sibling table `gate_chat_messages`** (NOT
   `review_comments`, whose anchor CHECK requires a file/line and has no
   agent-author role): `run_id`, `hitl_request_id`, `node_id`, `gate_attempt`,
   `role ∈ {user, agent}`, `author_user_id`, `author_label`, `body`,
   `acp_session_id`, `seq`, `mutation_reverted`, `created_at`. Rework compose
   ([ADR-072](#adr-072-pr-grade-review-comments--review_comments-table-snapshot-anchoring-runner-side-rework-compose-open-gate-guard))
   folds chat history into `commentsVar`.
2. **Availability** — session-presence-driven, answer-only. Enabled iff
   `runs.status ∈ {NeedsInput, NeedsInputIdle}` AND the open HITL
   `kind ∈ {human, form}` AND `runs.acp_session_id ≠ null`. Excluded by
   construction: `permission`-kind (session mid-prompt-turn), `HumanWorking`
   (manual takeover owns the worktree, no live agent), and the no-session case
   (explanatory empty state).
3. **Live vs idle turn.** `NeedsInput` → prompt the live session; the reply
   streams over the existing SSE bridge; status stays `NeedsInput`.
   `NeedsInputIdle` → chat-resume = `markResumed` claim (Idle→NeedsInput)
   BEFORE the respawn with ACP `session/resume` on `acp_session_id`, then
   keepalive bump + prompt, then the sweeper re-idles — claim-before-spawn
   (the `resumeRun` order): a lost CAS is `CONFLICT` (no duplicate spawn), a
   failed spawn rolls the claim back to `NeedsInputIdle`. Chat-resume MUST
   NOT call the resumed-session driver and MUST NOT touch the
   `hitl_requests` row. The ~$0.28 respawn cost
   ([ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume)) is surfaced
   before the first idle question. Allow-list invariant (tested): chat may drive
   `Idle→NeedsInput`, NEVER `→Running`, and never writes
   `hitl_requests.responded_at`.
4. **New SSE event `session.chat_turn`** carries the streamed reply plus a
   `mutation_reverted` flag; added to both AsyncAPI files, the supervisor event
   union, the SSE bridge typing, and the scratch event union so chat renders
   without polluting the flow timeline. The chat prompt is tagged with a
   server-derived marker `stepId = "gate-chat-<hitlRequestId>"` (dash, not colon
   — the supervisor `SAFE_PATH_SEGMENT` rejects a colon, and the marker also
   names the per-step log file).
5. **Three-layer neutrality — L3 is the only hard guarantee** (mirrors ADR-041
   instructed-only + ADR-074 detect-after):
   - **L1 Instruct** — prepend a "read-only Q&A, do not modify the workspace"
     preamble to every chat prompt.
   - **L2 Permission auto-deny (best-effort)** — a `readOnlyTurn` flag on the
     prompt + session record makes `requestPermission` auto-reject unambiguous
     mutating `toolCall.kind` (`edit | write/create | delete | move`) before any
     SSE emit or pending-permission registration (so no
     `session.permission_request` and no `hitl_requests` row). `read`/`fetch`
     pass; `execute` (bash) passes and relies on L3. L2 is a no-op under
     `--dangerously-skip-permissions` / `permissionMode:allow` — documented,
     hence L3.
   - **L3 Mutation sensor (hard guarantee)** — capture ONE known-good baseline
     at the FIRST chat turn of a pause via the
     [ADR-079](#adr-079-node-workspacepolicy-execution-and-checkpoint-capture)
     checkpoint machinery (`refs/maister/chat-checkpoints/<runId>/<hitlRequestId>`,
     bounded at 1), and verify EVERY subsequent turn against it
     (`statusPorcelain` + `git diff`). On a delta, restore to the baseline
     (overlay + targeted deletion of only the rogue untracked paths absent from
     the baseline tree — never a blanket `git clean`, never touching
     `.maister/`), set `gate_chat_messages.mutation_reverted = true`, emit an
     Observatory-ready audit signal, and surface a UI notice. L3 runs
     unconditionally and fail-closed (a sensor that cannot sense must not pass).
     The ref is GC'd when the HITL resolves; a mid-pause dirty-resolution
     ([ADR-082](#adr-082-review-diff-completeness-with-dirty-state-protocol-and-scope-switcher))
     deletes it so the next turn re-anchors (no false un-discard). This makes
     gate-chat depend on the ADR-079 checkpoint engine.
   - **Feature-3 interplay** — when a later rework resumes the SAME session
     ([ADR-081](#adr-081-rework-session-policy-with-resume-by-default)
     `session_policy: resume`), the rework prompt MUST explicitly lift the
     chat-time read-only restriction, else the agent may refuse legitimate edits.
6. Chat input is NEVER Mustache-evaluated; the L1 preamble is server-side, not
   user text.

**Consequences:**
- Reviewers get a grounded, answer-only conversation with the parked agent
  without taking over the worktree or resolving the gate; chat history feeds the
  rework compose.
- Neutrality is honest about its limits: L1/L2 are best-effort, L3 is the
  deterministic guarantee and the only layer that holds under permissive runners.
- New table + new SSE event + a `readOnlyTurn` prompt flag fan out to the DB
  docs, both AsyncAPI files, and the scratch event union.
- An idle gate-chat question pays the ~$0.28 respawn (ADR-006); the cost is
  surfaced in the UI.
- Amends ADR-041 (best-effort L2 within the instructed-only model) and ADR-074
  (L3 reuses the detect-after sensor stance), and extends ADR-072 (rework
  compose folds chat).

**Alternatives Considered:**
- **Reuse `review_comments` for chat:** rejected — its anchor CHECK requires
  file/line and there is no agent-author role; chat is unanchored and
  bi-directional.
- **Let chat resolve the HITL / drive →Running:** rejected — conflates Q&A with
  the gate decision; the runner owns `NeedsInput→Running`. Chat is strictly
  answer-only.
- **Blanket-deny `execute` (bash) on read-only turns:** rejected — kills
  legitimate read commands (`grep`, `cat`); let-through + the L3 guarantee is
  safer and more useful.
- **Per-turn forensic git refs:** rejected — one baseline anchored to the first
  turn restores to the original good state even for an undetected-then-detected
  mutation; per-turn history lives in `gate_chat_messages` rows + audit signals.
- **A real read-only sandbox (mount/overlayfs):** rejected for v1 — heavy,
  runner-specific, and inconsistent with the instructed-only enforcement
  reality; revisit if a hard sandbox lands platform-wide.

---

### ADR-079: Node workspacePolicy execution and checkpoint capture

**Date:** 2026-06-11
**Status:** Accepted
**Context:** The graph engine parses `rework.workspacePolicies` but does not
execute them — `runner-graph.ts` only warns where the policy should apply (the
M11b execution deferral). Rework therefore always reuses whatever the prior attempt
left in the worktree; there is no way to rewind to the pre-attempt state or start
an attempt clean. Closing this M11b deferral also yields the checkpoint primitive
that gate-chat neutrality
([ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality)
L3), node-level retry
([ADR-080](#adr-080-node-level-retry-policy)), and the review-diff `last-node`
scope
([ADR-082](#adr-082-review-diff-completeness-with-dirty-state-protocol-and-scope-switcher))
all need. Checkpoints must not pollute the promoted run branch and must survive
crashes.

**Decision:** Execute `workspacePolicy` with namespaced dangling git refs as node
checkpoints, and a strict rewind/fresh-attempt/keep state machine.

1. **Checkpoint capture** — before each `ai_coding`/`cli` attempt, capture
   HEAD + tracked + untracked (ignored EXCLUDED) as a temp-index commit
   **parented on the current branch tip**, stored as a dangling ref
   `refs/maister/checkpoints/<runId>/<nodeAttemptId>` (NOT on the run branch).
   Record the ref on `node_attempts.checkpoint_ref`. The promoted branch stays
   clean; reconcile tolerates orphans; the worktree GC removes them.
2. **Policy semantics.** `keep` = no-op. Because the checkpoint commit is
   parented on the then-current tip, `<ck>^` is the pre-attempt tip for free.
   - `rewind-to-node-checkpoint` = branch back to `<ck>^` and restore the working
     tree to the captured state WITHOUT staging it: `git reset --hard <ck>^`,
     then overlay the captured tree (`read-tree --reset -u <ck>^{tree}` +
     `reset --mixed <ck>^` family). Captured-tracked content restored,
     captured-untracked files come back UNTRACKED, attempt-created untracked
     files survive, attempt commits are discarded.
   - `fresh-attempt` = `git reset --hard <ck>^` + `git clean -fd` (discard
     untracked **source**, KEEP ignored — `-fd`, never `-fdx`) +
     re-materialization (see 4).
   - **NEVER `git reset --hard <checkpoint>`** — that grafts the temp-index
     commit onto the run branch (violates "branch NOT advanced") and converts
     captured-untracked files into tracked ones.
3. **`-fd` not `-fdx`.** `-x` would delete ignored files (`node_modules`,
   `.next/`, `target/`, `.venv/`) the checkpoint does not contain, forcing a slow
   reinstall on every retry/discard, and is more dangerous (an ignored
   `.maister/` symlink inside a worktree would be nuked). A future per-policy
   `clean_ignored: true` opt-in can re-enable `-x`; not v1.
4. **Re-materialization.** Capability bundles are materialized once at launch and
   land **untracked + un-ignored**, so `git clean -fd` deletes them with nothing
   re-creating them, and index rewrites drop the tracked-override `skip-worktree`
   state. The launch materialization block (`copyBundleArtifactsToWorktree` +
   `writeAiFactoryConfigOverride` + `ensureWorktreeGitignore`) is extracted into a
   reusable helper and RE-RUN (idempotent) after every `fresh-attempt` and after
   the ADR-082 dirty discard. Consumer-project review gates will list
   materialized artifacts in `dirtySummary` — known v1 noise; dogfood is
   unaffected (its skills/agents are repo-local).
5. **Run-artifact safety.** Rewind/discard are worktree-only. Logs/inputs/
   `cost.jsonl`/`run.events.jsonl` live at
   `runtimeRoot/.maister/<slug>/runs/<runId>/`, separate from the worktree. All
   git mutations scope `-C <worktreePath>`; a `containmentAssert` hard-blocks any
   policy run when `MAISTER_RUNTIME_ROOT` does not resolve outside the worktree's
   `repo_path` (a non-ignored artifacts path inside the worktree could otherwise
   be reached by `git clean -fd`). A test asserts artifacts survive rewind.
6. Git failure during capture/apply throws the existing `MaisterError("CHECKPOINT")`
   — no new error code
   ([ADR-008](#adr-008-typed-error-taxonomy-maistererror) closed union).

**Consequences:**
- Rework can rewind to the exact pre-attempt state or start clean, executing the
  long-parsed `workspacePolicy` and closing the M11b deferral.
- A reusable checkpoint engine (`captureCheckpoint`, `applyWorkspacePolicy`,
  `containmentAssert`, `deleteChatCheckpoint`) backs ADR-078 L3, ADR-080 retry,
  and ADR-082 `last-node`.
- Checkpoints never touch the promoted branch; orphaned refs after a crash are
  harmless and GC'd.
- `node_attempts.checkpoint_ref` is a new ledger column (migration 0041); amends
  [ADR-027](#adr-027-append-only-node_attempts-run-ledger).
- `MAISTER_RUNTIME_ROOT` must resolve outside every `repo_path` — a deployment
  precondition asserted in code + docs.

**Alternatives Considered:**
- **`git stash` per attempt:** rejected — the stash stack is global/fragile,
  drops untracked nuance, and is not crash-durable per `(run, node)`.
- **`git reset --hard <checkpoint>` (the checkpoint commit itself):** rejected —
  advances the run branch onto the temp-index commit and tracks formerly-untracked
  files; `<ck>^` is the correct target.
- **`git clean -fdx` for fresh-attempt:** rejected — nukes ignored build caches
  and an ignored `.maister/`, forcing reinstalls and risking the artifacts tree.
- **Checkpoints as real commits on the run branch:** rejected — pollutes the
  promoted history and breaks the branch-clean assertion.

---

### ADR-080: Node-level retry policy

**Date:** 2026-06-11
**Status:** Accepted
**Context:** Transient infrastructure failures (adapter spawn races, executor
unavailability, ACP protocol hiccups, checkpoint git failures) currently fail a
node outright, bouncing the whole run to a human even though a fresh-session
retry would succeed. There is no declarative, observable auto-retry on the graph
node.

**Decision:** Add an optional `retry_policy` to `ai_coding` and `cli` nodes:
`{ attempts ≥ 1, on_errors: [code…], workspace: rewind-to-node-checkpoint }`. On
a node failure whose `MaisterError.code ∈ on_errors` with attempts remaining, the
engine applies the `workspace` policy via the
[ADR-079](#adr-079-node-workspacepolicy-execution-and-checkpoint-capture) engine
first, then appends a fresh-session attempt marked `node_attempts.auto_retry =
true`. `on_errors` is validated at manifest-load against the retryable allow-list
`{ SPAWN, EXECUTOR_UNAVAILABLE, CHECKPOINT, ACP_PROTOCOL }`; any other code (e.g.
`PRECONDITION`, `CONFIG`) or unknown value is a manifest `CONFIG` error.
Auto-retry always uses a fresh session, respects the global concurrency cap, never
bypasses gates, is observable on the ledger, and emits a distinct exhaustion
signal when `attempts` is reached (then normal failure). The new DSL key requires
`compat.engine_min ≥ 1.4.0`
([ADR-026](#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump) amendment).

**Consequences:**
- Transient failures self-heal without a human round-trip, each retry an
  immutable `auto_retry` ledger row with the workspace reset to the pre-attempt
  checkpoint.
- The retryable set is an allow-list (not a deny-list): only infrastructure codes
  retry; logic/precondition failures still stop.
- Depends on the ADR-079 checkpoint engine for
  `workspace: rewind-to-node-checkpoint`.
- Exhaustion is a distinct, observable signal, not a silent give-up.

**Alternatives Considered:**
- **Retry any `MaisterError`:** rejected — retrying `PRECONDITION`/`CONFIG`/
  `CONFLICT` masks real defects and can loop forever; an explicit allow-list is
  the safe default.
- **Global retry knob instead of per-node:** rejected — different nodes have
  different idempotency/cost profiles; the policy belongs on the node.
- **Reuse the prior session on retry:** rejected — a transient-failed session may
  be half-dead; a fresh session is the clean baseline (session reuse is the
  separate ADR-081 rework concern).

---

### ADR-081: Rework session policy with resume-by-default

**Date:** 2026-06-11
**Status:** Accepted
**Context:** When a review gate sends a node back for rework, the engine today
always dispatches a brand-new agent session (hard-coded `mode: "new-session"`).
The agent loses the prior attempt's conversation context — including the critique
it must address — and pays to rebuild it from the rework prompt alone. Some flows
want a fresh session; most want continuity.

**Decision:** Add `session_policy ∈ {resume, new_session}` for rework, resolved
highest-wins: rework-transition (`rework.session_policy`) → node
(`session_policy`) → flow (`defaults.session_policy`) → engine default
**`resume`** (a deliberate flip from today's implicit new-session). `resume`
resumes the prior attempt's `acp_session_id` via the
[ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume) idle checkpoint / ACP
`session/resume` path; if that session is gone or unresumable, fall back to
`new_session` and set `node_attempts.session_fallback = true`. The effective
policy is snapshotted into `node_attempts.session_policy`. An idle/checkpointed
prior session still resumes (no special-casing — the ~$0.28 respawn buys back the
critique context, which is the point; the cost is surfaced in the UI).
Manual-takeover return
([ADR-030](#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status))
is unaffected (no live session to resume), and slash-in-existing dispatch is
unchanged. When a rework resumes the SAME session, the rework prompt MUST lift any
ADR-078 chat-time read-only restriction. The new DSL keys require
`compat.engine_min ≥ 1.4.0`.

**Consequences:**
- Rework keeps the critique context by default, improving correction quality and
  avoiding a cold rebuild.
- `resume` degrades safely to `new_session` with an observable `session_fallback`
  flag; the effective policy is snapshotted per attempt.
- Two new ledger columns (`session_policy`, `session_fallback`, migration 0041);
  amends [ADR-027](#adr-027-append-only-node_attempts-run-ledger) and reuses
  ADR-006.
- Couples to ADR-078: a resumed rework must explicitly re-enable edits the chat
  preamble forbade.

**Alternatives Considered:**
- **Keep new-session as the default:** rejected — discards the exact context (the
  critique conversation) that rework most needs; the deliberate flip to `resume`
  is the whole value.
- **Resume but never fall back (hard-fail when the session is gone):** rejected —
  an unresumable session is common after long idles/crashes; a silent, observable
  fallback keeps rework moving.
- **Special-case idle sessions to force new-session (avoid the respawn cost):**
  rejected — the respawn cost is what buys the critique context back; surface it,
  don't avoid it.

---

### ADR-082: Review-diff completeness with dirty-state protocol and scope switcher

**Date:** 2026-06-11
**Status:** Accepted
**Context:** The review gate shows exactly one diff:
`workspace.baseCommit..branch`. A reviewer cannot see only what changed since
their last visit, only the latest node's output, or uncommitted working-tree
edits; and a dirty worktree at gate time (uncommitted/untracked work) is
invisible, so reviews silently miss it. Closing this needs both more diff scopes
and an explicit protocol for dirty state.

**Decision:** Add a 4-mode diff scope switcher and a pre-review dirty-state
protocol; the gate is never blocked by dirty state.

1. **Pre-review dirty detection.** When a review gate opens, the runner runs
   `statusPorcelain` (incl. untracked) — **no auto-commit**. A dirty worktree
   does NOT block the gate; the gate payload carries a `dirtySummary` (file list
   + staged/unstaged/untracked counts).
2. **Reviewer's explicit dirty-resolution** (recorded on
   `hitl_requests.dirty_resolution` + audit):
   - **Commit as snapshot** — reuse `snapshotDirtyWorktree` (auto-message
     `"wip after node <id>"`); scopes recompute after the tip moves.
   - **Discard** — NEW primitive `git restore --staged --worktree . &&
     git clean -fd` (`-fd` not `-fdx` per ADR-079, scoped `-C <worktree>`, hard
     `.maister/`-containment assert, followed by re-materialization per ADR-079);
     v1 is all-or-nothing.
   - **Proceed as-is** — review the committed state; a persistent dirty badge
     stays.
   Every executed choice also deletes the ADR-078 chat-checkpoint ref (so the L3
   sensor re-anchors — no false un-discard). The choice is part of review, not a
   precondition.
3. **4-mode scope switcher** — a `scope` query param on
   `GET /api/runs/{runId}/diff` (enum allow-list, default `run`), all sharing the
   [ADR-066](#adr-066-editor-and-diff-rendering-stack-shiki-git-diff-view-codemirror)
   `prepareDiff` pipeline + byte-cap truncation guard:
   - `run` (default): `workspace.baseCommit..branch` (current behavior).
   - `since-last-review`: `<prev-review-visit-sha>..branch`; the branch tip is
     recorded per review-gate visit in the NEW column
     `hitl_requests.review_tip_sha`.
   - `last-node`: `<pre-attempt-checkpoint-sha>..branch` for the latest completed
     agent node, based on the ADR-079 checkpoint refs (exact even with zero/many
     agent commits).
   - `uncommitted`: `HEAD` vs working tree (tracked) + untracked rendered as
     additions, via a NEW `git diff HEAD`+untracked helper that runs under a temp
     `GIT_INDEX_FILE` (intent-to-add) and NEVER mutates the real index.
4. **Graceful degrade.** A scope whose base ref is missing (pre-feature run,
   first review visit) is hidden/disabled with a reason, never an error.

**Consequences:**
- Reviewers can scope the diff to the review delta, the last node, or uncommitted
  work, and dirty state is explicit with three recorded resolutions instead of
  silently missed.
- The discard primitive is hard-guarded against escaping the worktree and
  re-materializes capability bundles afterward; `.maister/` is never touched.
- New columns `hitl_requests.review_tip_sha` + `hitl_requests.dirty_resolution`
  (migration 0041); a new
  `POST /api/runs/{runId}/hitl/{hitlRequestId}/dirty-resolution` route; amends
  ADR-066 (new scopes) and reuses the M27 snapshot.
- No engine bump (no new flow DSL).

**Alternatives Considered:**
- **Auto-commit the dirty worktree at gate open:** rejected — silently rewrites
  the reviewer's pending work into history; detection + explicit choice is safer.
- **Block the gate until the worktree is clean:** rejected — turns a review into
  a chore and contradicts the "review the work as it is" model; dirty is
  annotated, never a precondition.
- **`commit_set`-artifact base for `last-node`:** rejected — checkpoint refs are
  exact with zero or many agent commits; commit_set is a lossy proxy.
- **Mutate the index for the `uncommitted` diff (`git add -N`):** rejected —
  corrupts the live index; a temp `GIT_INDEX_FILE` keeps the real index
  untouched.

---

### ADR-083: Social board substrate — per-project task numbering, typed relations, polymorphic actor

**Date:** 2026-06-11
**Status:** Accepted
**Context:** Tasks are addressable only by UUID: there is no human-readable
identity to reference in a discussion, no way to express "this task waits on
that one", and no record of what happened to a task beyond its mutable
status. The validated platform-agents + social-board design needs a substrate
that later agent actors can write into without another migration: stable task
identity (`KEY-N`), typed inter-task relations that gate launching,
domain-written activity, auto-subscriptions, and a per-recipient inbox.
Stage 1 ships the substrate with `user`/`system` writers only; `agent` is
schema-legal everywhere but never written (no agent runtime exists yet).

**Decision:** Five new tables (`task_relations`, `task_comments`,
`task_activity`, `task_subscribers`, `inbox_items`) plus three new columns
(`projects.task_key`, `projects.next_task_number`, `tasks.number`) in one
migration, with these locked semantics:

1. **Numbering** — `projects.next_task_number integer NOT NULL DEFAULT 1`,
   allocated inside the `createTask` transaction via
   `UPDATE projects SET next_task_number = next_task_number + 1 … RETURNING`;
   the projects-row lock serializes concurrent creates and
   `UNIQUE(tasks.project_id, tasks.number)` is the backstop (violation ⇒ bug,
   not user error). Numbers are never reused; deleting a task leaves a hole.
2. **Task key** — `projects.task_key` matches `^[A-Z][A-Z0-9]{1,9}$` and is
   **platform-wide UNIQUE** (mention resolution is global; two projects
   sharing `MAI` would make `MAI-12` ambiguous). Settable only at
   registration (optional `taskKey` body field, regex allow-list; collision
   with an explicit OR derived key → `CONFLICT`), default derived from the
   project name (first 3 letters, uppercased). Immutable in Stage 1 because
   comment bodies store expanded `KEY-N` links; rename tooling is Stage 2.
   Migration backfill auto-uniquifies (widen to 4 letters, then numeric
   suffix), ordered by `created_at`.
3. **Polymorphic actor = `(actor_type, actor_id)` pair** on all four social
   tables: `actor_type CHECK IN ('user','agent','system')` with
   `CHECK ((actor_type = 'system') = (actor_id IS NULL))`, and **no FK to
   `users`** (polymorphic target; a deleted user renders under a
   "former user" fallback label). The existing `actor_identities` registry
   (`user|api_token|internal_agent|system`) is deliberately NOT reused: its
   taxonomy mismatches the design's `user|agent|system`, there is no agents
   table to join yet, and the self-contained pair lets inbox fanout compare
   subscriber vs actor in plain SQL without joins. Stage-1 write
   restriction: only `user` and `system` actors are ever written.
4. **Relations** — canonical one-direction rows
   (`from_task_id`, `kind ∈ {blocks, depends_on, parent_of}`, `to_task_id`)
   with `UNIQUE(from_task_id, kind, to_task_id)`,
   `CHECK (from_task_id <> to_task_id)`, both task FKs `ON DELETE cascade`.
   Inverse labels ("blocked by", "required by", "child of") are render-time
   only — never stored. Same-project only in Stage 1, enforced in the domain
   layer (cross-table CHECK is impossible) → `CONFIG`. No cycle detection:
   a mutual block makes both tasks unlaunchable until one relation is
   removed; the UI always renders blockers as removable chips, so the state
   is recoverable.
5. **Launchability** — `classifyTaskLaunchability` gains optional relation
   context and a new `"blocked"` classification with precedence
   `target_terminal > crashed > busy > blocked > launchable` (relations gate
   *launching* only; they never mask an active run's state). Task T is
   blocked iff ∃ relation `(X blocks T)` or `(T depends_on Y)` where the
   counterpart task's status ∈ {`Backlog`, `InFlight`} — `Done` AND
   `Abandoned` both release, so a discarded blocker cannot deadlock its
   dependents. `parent_of` never gates. Every classifier consumer threads
   the relation context: `launchRun` (the single choke point for internal
   AND ext launches), the run-schedules dispatcher (skip with reason in the
   attempt summary), and the board/portfolio read models.
6. **Mentions expand at write time** — `KEY-N` tokens in comment bodies
   (outside fenced code, inline code, and existing markdown links) resolve
   against `(projects.task_key, tasks.number)` and are stored as expanded
   markdown links; unresolved tokens stay literal text. Single render path,
   immutable history; stale links after a project slug rename are accepted
   and documented.
7. **Comment pipeline is ONE transaction** — insert comment → write
   `comment_added` activity on the commented task + `task_mentioned` on each
   mentioned task → upsert subscriptions (`ON CONFLICT DO NOTHING`, first
   reason wins) → inbox fanout. No external side-effects inside the tx.
8. **Activity is domain-written only** — `task_activity` rows are written
   exclusively by `web/lib/social/*` via `recordTaskActivity` plus the named
   service write-sites (`createTask`, the `launchRun` task-flip tx); route
   handlers never insert directly. Event kinds (text + CHECK):
   `task_created | comment_added | task_mentioned | relation_added |
   relation_removed | run_launched`. `task_status_changed` was cut — the
   only real task-status writer today is the launch flip, already covered by
   `run_launched` in the same tx. `run_finished` is deferred until a
   `setRunStatus` choke point exists (run-terminal writes are scattered
   across ~10 sites today; wiring activity into all of them is high-risk
   noise).
9. **Subscriptions + inbox** — `task_subscribers` reasons
   `creator | commenter | mentioned | manual` with
   `UNIQUE(task_id, subscriber_type, subscriber_id)`; `subscriber_type ∈
   {user, agent}` (`system` never subscribes). Auto-subscribe: task creation
   → creator; comment → commenter; mention of task B in a comment on task A
   → B's creator subscribed to A (`mentioned` — brings the owner of the
   referenced work into the discussion). Inbox fanout is one batch
   `INSERT … SELECT` over the task's subscribers excluding the acting pair,
   inside the triggering tx. Stage-1 fanout triggers: `comment_added` and
   `task_mentioned` only — the Log page covers the rest; the inbox stays
   high-signal. Read tracking: per-item `read_at` (recipient-owned) +
   read-all.
10. **Ext/MCP comment ops reuse the domain path** — ext routes map the
    token to an actor via the existing `actorUserIdForToken` helper:
    user-owned token → `('user', userId)`, ownerless project token →
    `('system', NULL)` with `{via: 'ext', tokenId}` recorded in the activity
    payload. New token scopes `comments:read` / `comments:create`; audit
    rows written in-tx exactly like existing ext routes. MCP facade gains
    `comment_create` / `comment_list` over the same routes.

**Consequences:**
- Tasks get a stable human identity (`KEY-N`) usable in comments, UI chips,
  and later agent prompts; numbering survives deletion as documented holes.
- Relations gate launching at every entry point (internal route, ext API,
  schedules) through the single classifier — no parallel UI-only logic to
  drift.
- The actor pair makes Stage-2 agent actors a data change, not a schema
  change: `agent` writers slot into existing columns and CHECKs.
- A deleted user leaves dangling `actor_id`s by design; every renderer
  carries a "former user" fallback.
- `actor_identities` and the actor pair coexist as two actor models with
  different jobs (token/credential identity vs social attribution); this ADR
  records the divergence as deliberate.
- Expanded-at-write mentions mean a project slug rename strands old comment
  links; accepted in exchange for immutable history and a single render
  path.

**Alternatives Considered:**
- **`max(number)+1` at insert:** rejected — racy under concurrent creates.
- **Per-project Postgres sequences:** rejected — DDL at runtime per project.
- **One global sequence:** rejected — numbers must be per-project
  dense-ish.
- **FK to `actor_identities`:** rejected — taxonomy mismatch
  (`api_token`/`internal_agent` vs `agent`), no agents table to join, and
  fanout SQL would need joins; revisit if the two models converge.
- **Bidirectional relation rows (store both `A blocks B` and
  `B blocked-by A`):** rejected — double writes and dedup burden; inverses
  are pure rendering.
- **Mention expansion at render time:** rejected — every renderer
  re-resolves (N+1 and drift); stored expansion keeps history immutable.
- **Storing pre-rendered HTML for comments:** rejected — XSS surface in the
  DB; bodies stay markdown, rendered through the existing remark-only
  `react-markdown` wrapper.

---

### ADR-084: ACP adapter families for Gemini CLI and OpenCode

**Date:** 2026-06-11
**Status:** Accepted
**Context:** ADR-050 established the platform ACP runner catalog and explicitly
named future adapter families such as Gemini and OpenCode. ADR-076 added
model discovery and model application for the existing Claude/Codex pair.
The next runner-catalog widening needs a contract decision before code because
Gemini CLI and OpenCode are not simple enum additions:

- `supervisor/src/spawn.ts`, `supervisor/src/http-api.ts`,
  `supervisor/src/types.ts`, `web/lib/supervisor-client.ts`,
  `web/lib/acp-runners/schema.ts`, readiness, settings, recovery, and
  capability materialization all encode `claude | codex`.
- Gemini CLI `0.46.0` exposes `gemini --acp`; its installed docs and upstream
  docs state JSON-RPC over stdio and list `initialize`, `authenticate`,
  `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, and
  `unstable_setSessionModel`. The observed bundle advertises `loadSession`
  but not `sessionCapabilities.resume`.
- OpenCode `1.16.2` is installed at `/opt/homebrew/bin/opencode` and exposes
  `opencode acp`; upstream docs describe JSON-RPC over stdio, while local help
  also exposes `--port`, `--hostname`, mDNS, and CORS flags. Its first-run
  writable state under `~/.local/share/opencode` is an operational readiness
  concern.
- MAIster currently advertises `clientCapabilities: { fs: {} }` to every ACP
  adapter even though it has not implemented a confined ACP filesystem proxy.
- Capability enforcement is still truth-sensitive: ADR-032/ADR-041/ADR-044
  require refusal instead of silent downgrades when strict settings cannot be
  proven for the selected adapter.

**Decision:** Add Gemini CLI and OpenCode as first-class **adapter families**
behind the same platform runner catalog, but gate runtime readiness on
adapter-specific evidence. Eight locked sub-decisions:

1. **Single adapter registry per process.** The web tier owns catalog/schema and
   readiness metadata; the supervisor owns binary/spawn/protocol metadata. The
   registries must agree on ids (`claude`, `codex`, `gemini`, `opencode`),
   provider families, permission policies, model channel, resume strategy, MCP
   transport support, and client-capability policy. Scattered
   `claude | codex` literals are removed only where this feature touches the
   runner contract.
2. **Launch commands.** `gemini` launches as `gemini --acp`. `opencode`
   launches as `opencode acp`. OpenCode's HTTP-looking help flags are treated as
   a smoke-test question, not as permission to add an HTTP ACP transport in this
   feature.
3. **Operator-controllable binary resolution.** Supervisor diagnostics and spawn
   use the adapter registry's binary resolver. A default PATH lookup is enough
   for Claude/Codex compatibility; Gemini/OpenCode must also support an explicit
   supervisor-side binary override. Diagnostics report binary source, path,
   version/probe outcome, and execution/writable-state failures without leaking
   env values.
4. **Provider/auth shapes are adapter-specific.** Gemini gets Google-oriented
   provider kinds and env-ref-only secrets. OpenCode starts with an
   `agent_native` provider that relies on OpenCode's own credential/config
   store, with optional env refs only when the spec explicitly freezes them.
   Existing Codex `openai_compatible` refusal stays in place until Codex
   materialization is proven.
5. **ACP client capabilities are explicit.** MAIster must stop advertising
   generic `fs:{}` to every adapter. No adapter receives `fs.readTextFile` or
   `fs.writeTextFile` capability until MAIster implements and documents the
   confinement boundary. MCP servers continue to flow through ACP
   `newSession`/`loadSession`/`resumeSession` params when the adapter supports
   them.
6. **Resume is strategy-based.** Claude/Codex keep ACP `session/resume`.
   Gemini's `loadSession` is not equivalent to MAIster's checkpoint resume until
   an SDK smoke proves it restores the same conversation without replaying
   history. OpenCode resume support must also be proven by SDK smoke. If the
   strategy is unsupported or unproven, launch fails readiness or throws
   `CHECKPOINT` with an actionable reason; it never falls back to `newSession`.
7. **Model application follows ADR-076 metadata.** Claude remains
   `settings.local.json`. Codex, Gemini, and OpenCode use
   `unstable_setSessionModel` only when the adapter supports it; otherwise the
   run receives an advisory and continues. Model suggestions for Gemini/OpenCode
   are explicit sources or typed skips, never Claude/Codex defaults reused under
   a different adapter.
8. **No strict-enforcement flip.** Gemini/OpenCode capability classes start as
   `instructed` or `unsupported`. No cell becomes `enforced` until a
   per-class/per-adapter live spike proves the adapter honors the materialized
   configuration. `strict` unsupported classes refuse launch with the existing
   `CONFIG` or `EXECUTOR_UNAVAILABLE` errors.

Prompt stop-reason policy is part of the contract freeze: supervisor types,
web client types, OpenAPI, runner-agent handling, and resume-driver handling
must all agree whether ACP `cancelled` is returned as a typed prompt result or
converted to a typed `ACP_PROTOCOL`/checkpoint path. No raw 500 or string-match
branching is allowed.

**Consequences:**
- Gemini/OpenCode appear as real platform runner families, but readiness stays
  honest: a missing binary, first-run state failure, missing auth env ref,
  protocol mismatch, unsupported checkpoint strategy, or unproven MCP/model
  behavior is user-visible and typed.
- The supervisor remains the only process that spawns adapters. The web tier
  continues to reach it exclusively through `web/lib/supervisor-client.ts`.
- The feature adds no generic "any command" runner and no non-ACP
  Gemini/OpenCode automation path.
- The SDK smoke scripts become a release gate, not a nicety: docs-first support
  is insufficient to mark an adapter Ready.
- Deployment symmetry applies if new env vars, binary overrides, or writable
  state paths become runtime knobs: `.env.example`, compose overlays, and docs
  must be updated in the same implementation slice.

**Alternatives Considered:**
- **Generic custom command runner:** rejected — it bypasses ACP contracts,
  makes capability/readiness truth unverifiable, and would create a shell
  execution surface broader than this feature needs.
- **Treat Gemini `loadSession` as MAIster checkpoint resume by name:** rejected
  — the invariant is semantic, not lexical. It must be proven against the SDK
  and documented before checkpointed workflows become Ready.
- **Trust OpenCode CLI help and add HTTP transport now:** rejected — upstream ACP
  docs say stdio and MAIster's supervisor is currently stdio-oriented. HTTP or
  remote ACP is a separate transport feature.
- **Flip Gemini/OpenCode capability classes to `enforced` with no live proof:**
  rejected — it recreates the false-compliance state ADR-032 forbids.
- **Fork/patch upstream adapter binaries:** rejected for this feature. MAIster
  should adapt through published ACP and CLI surfaces; forking would add
  dependency ownership and upgrade burden without evidence it is required.

---

### ADR-085: MiMo Code as a distinct ACP adapter family

**Date:** 2026-06-11
**Status:** Accepted
**Context:** Xiaomi MiMo Code publishes an ACP CLI surface at `mimo acp`.
The public source identifies the npm package as `@mimo-ai/cli`, binary
`mimo`, and implements ACP over stdio via `AgentSideConnection` and
`ndJsonStream`. It is OpenCode-derived, but it has separate binary, config, and
auth state: docs and source reference `.mimocode/mimocode.json` /
`~/.config/mimocode/mimocode.json`, while some ACP auth messages still mention
`opencode auth login`. Its ACP SDK dependency is `@agentclientprotocol/sdk`
`0.16.1`, older than the supervisor's `0.22.1`. The local implementation host
does not currently have `mimo` on PATH.

**Decision:** Add `mimo` as its own platform ACP adapter id, not as an
`opencode` alias.

- Launch contract: default binary `mimo`, default args `acp`, override env
  `MAISTER_ADAPTER_BINARY_MIMO`.
- Provider contract: `agent_native` only for V1. MAIster does not synthesize
  MiMo provider files or accept MiMo-specific raw secrets.
- Readiness: `mimo` is `NotReady` until diagnostics find an executable binary
  and cached ACP smoke reports `status="ok"`.
- Model discovery: the ACP probe returns a typed `skipped` source for MiMo until
  the smoke proves non-interactive probing is safe.
- Capabilities: MiMo starts with every enforcement class as `instructed`; no
  `enforced` cell lands without live proof.
- MCP: MiMo is included in default supported-agent sets and receives MCP servers
  through ACP session params, not through OpenCode-specific settings files.

**Consequences:**

- Existing OpenCode readiness, auth, and resume assumptions do not silently
  apply to MiMo.
- Operators can create a MiMo runner row before installing the binary, but it
  cannot become default or launch-ready until diagnostics and smoke pass.
- Existing `platform_mcp_servers.supported_agents` rows that exactly matched
  the previous all-adapters default are migrated to include `mimo`; custom
  subsets remain unchanged.

---

### ADR-086: Domain-event outbox as the shared trigger bus

**Date:** 2026-06-11
**Status:** Accepted
**Context:** ADR-077 proved the transactional-outbox capture seam, but its
outbox is structurally webhook-shaped: `webhook_events.run_id` is `NOT NULL`
(task-scoped facts like `task.created` cannot ride it) and the row carries
delivery-tier columns (`payload`, `fanout_at`) that belong to webhook fanout,
not to the fact itself. Stage 2 of the platform-agents/social-board design
(Layer 3) needs a **shared trigger bus**: multiple independent consumers — the
future agent-trigger dispatcher (platform agents), the outbound-webhooks
drainer itself, notifiers — must each consume the same durable domain-fact log
at their own pace, with at-least-once delivery and catch-up after outages. The
social board (ADR-083) added the task/comment domain writes with the
polymorphic `(actor_type, actor_id)` pair; the M24 scheduler (ADR-060) is the
sanctioned background clock. The original design doc for the staged
platform-agents work was never committed (owner decision: not restored); the
spec freeze at `.ai-factory/specs/domain-event-outbox.spec.md` plus this ADR
are the durable record of Stage 2.

**Decision:** Add `domain_events` — an immutable, append-only domain-fact log
emitted from the domain layer **inside the same transaction as the state
change** — plus a per-consumer cursor dispatcher running as a singleton job on
the M24 clock.

- **Capture seam mirrors ADR-077.** `emitDomainEvent({db, …})` is a single
  INSERT riding the caller's transaction (dual db/tx handle, copied from
  `web/lib/webhooks/outbox.ts`); it fires only on the CAS-winner path of the
  surrounding transition. No reads, no joins, no network on the write path.
- **New table, NOT an in-place generalization of `webhook_events`.**
  `domain_events {id bigint identity PK, kind, project_id NOT NULL FK,
  task_id? FK, run_id? FK, actor_type?, actor_id?, payload jsonb, occurred_at,
  created_at, tx_id xid8 DEFAULT pg_current_xact_id()}`. The webhook outbox
  stays as-is until the webhooks drainer is re-pointed at `domain_events` in a
  later stage (it becomes a registered consumer; `webhook_events` then
  retires). Until then run-terminal/gate sites emit BOTH rows in the same
  transaction — accepted, bounded, grep-audited duplication.
- **Kind taxonomy v1 = 8 kinds.** `task.created`, `task.comment_added`,
  `task.triage_requeued` (registered, **no emitter yet** — lands with the
  Stage-3 triager), `run.done`, `run.failed`, `run.crashed`, `run.abandoned`
  (the four terminal run statuses), `gate.failed`. Extension rule mirrors
  ADR-077: one taxonomy entry + emit site(s) in the owning domain transaction
  + one doc row (+ CHECK update via migration).
- **Per-consumer cursors with CAS lease + xid8 commit horizon.** Each consumer
  owns a `domain_event_consumers` row `{consumer_id PK, cursor_event_id,
  lease_expires_at, consecutive_failures, last_error, …}`. A dispatch pass
  claims the row by CAS on `lease_expires_at` (zero rows ⇒ another claimer is
  live ⇒ skip), reads `WHERE id > cursor AND tx_id <
  pg_snapshot_xmin(pg_current_snapshot()) ORDER BY id LIMIT batch`, invokes
  the consumer, then advances the cursor with a CAS fenced on the cursor value
  read at claim. The horizon predicate closes the identity-out-of-order-commit
  hole: an open transaction holding a lower `id` holds back ALL later events
  until it resolves, so a cursor can never skip a late-committing event.
  Delivery is **at-least-once** (crash after handle, before advance ⇒
  redelivery); consumers MUST be idempotent.
- **Dispatcher = singleton M24 job.** New `job_kind: domain_event_dispatch`,
  one seeded `domain_event_dispatch.default` row (cadence 60s, budget
  `domainEventDispatch: 1`, `ensureDefaultSchedulerJobs` `ON CONFLICT DO
  NOTHING`), deliberately **excluded** from `createSchedulerJobSchema`
  (`run_schedule` precedent — the seeded singleton is the only instance). The
  consumer registry is code-owned (`DOMAIN_EVENT_CONSUMERS`); v1 ships exactly
  one permanently-registered `noop` consumer (`startFrom: "now"`) as the
  liveness proof of the seam. ADR-§1 is preserved: the live path is emission
  inside the domain transaction + tick dispatch; recovery after any outage is
  the same cursor on the next tick — no fs.watch, no polling for run state,
  and the dispatcher drives only consumer-cursor state, never run state.
- **Retention: none in this stage.** `domain_events` is unbounded append-only
  (volume ≈ a few rows per run/task interaction). Pruning lands with the first
  real consumer and MUST honor `min(cursor_event_id)` across registered
  consumers. FKs cascade on project/task/run delete — events are trigger
  material, not the audit log (`task_activity` keeps that role, ADR-083).
- **No HTTP surface, no new error code, no env knobs.** Cadence/batch/lease
  (60s / 100 / 5min / max 10 batches per tick) are code constants until a real
  consumer needs tuning.

**Consequences:**
- Future consumers (agent triggers, webhooks, notifiers) plug in by adding one
  registry entry + cursor row — no new capture machinery, no new clock.
- Run-terminal/gate sites carry two adjacent emit calls during the coexistence
  period; the sweep is grep-gated (`every terminal emitWebhookEvent has a
  paired emitDomainEvent`) and collapses when the webhooks drainer migrates.
- One long-running open transaction anywhere in the DB stalls dispatch past
  its first inserted event until it resolves (horizon head-of-line) — accepted:
  domain transactions are short, migrations run offline, and the stall is
  bounded by the transaction's lifetime, never lossy.
- Two new tables (`domain_events`, `domain_event_consumers`) land in migration
  `0046`; a new `job_kind: domain_event_dispatch` joins the scheduler enums,
  budgets, dispatch switch, seeds, and the admin `kind` label map (EN+RU,
  without a `targetHint` — not user-creatable).
- The previously emit-less `NeedsInputIdle → Abandoned` TTL transition
  (`keepalive-sweeper runPass2`) becomes transactional and emits both the
  domain event and the previously missing `run.abandoned` webhook (closing an
  ADR-077 gap; its "deliberately NOT emitted" entry is superseded).

**Alternatives Considered:**
- **Generalize `webhook_events` in place (relax `run_id`, add task/actor
  columns):** rejected — entangles the fact log with webhook delivery columns,
  forces the webhook fanout/prune machinery to filter foreign kinds, and makes
  the later consumer-model migration harder than standing up the clean table
  now.
- **Fanout-marker rows per (event, consumer) — the webhook-deliveries shape:**
  rejected — write amplification per registered consumer for no gain (no
  per-event retry state is needed at this layer), and it double-bookkeeps once
  the webhooks drainer (which already owns a marker table) plugs in. The
  task's catch-up semantics are cursor-shaped.
- **Pure `id > cursor` reads without the xid8 horizon:** rejected — identity
  assignment order ≠ commit order; a cursor that advances past a still-open
  transaction's lower id loses that event permanently. This is the classic
  outbox-cursor bug; the horizon predicate is the textbook fix.
- **Postgres LISTEN/NOTIFY as the dispatch trigger:** rejected — delivery
  still needs the durable table for at-least-once + catch-up, NOTIFY adds an
  unsanctioned push channel alongside the M24 clock for no latency requirement
  (60s tick is fine for triggers), and it dies with the connection.
- **One scheduler job per consumer:** rejected — same reasons ADR-077 rejected
  per-delivery jobs (admin catalog flooding, `max_failures` auto-disable
  fighting consumer-level retry); consumer failure accounting lives on the
  cursor row instead.

---

### ADR-087: Multi-run launch, cost accounting, and delivery-policy surfaces

**Date:** 2026-06-11
**Status:** Accepted
**Context:** The task/run schema is already 1:N, but the UI still behaves like
launch is mostly a Backlog-only action. Cost records are written to
`cost.jsonl`, but they are not attributed to node attempts or surfaced as read
models. Promotion mode is snapshotted as `local_merge | pull_request`, but the
operator needs a declarative policy that flows from project default to launch
override to promote-time override.

**Decision:**
1. Manual task launchability is split from schedule launchability. Manual
   "Run again" is a positive allow-list over `Done`, `Review`, `Failed`,
   `Abandoned`, and `Crashed`; busy states and relation blockers remain visible
   disabled reasons. The scheduler keeps its conservative `target_terminal` and
   `crashed` skip outcomes unless a later ADR explicitly changes scheduled
   replay semantics.
2. Task launches keep `launchRun` as the only run-creation service. Internal
   `POST /api/runs` accepts selected Flow, runner/model, base/target branch,
   and delivery-policy overrides after deriving the project from the task. The
   token-auth external route remains v1-compatible unless a future API version
   opts into the same override body.
3. Cost attribution is exact or fail-fast: `cost.jsonl` remains the source of
   truth, enriched with `runId`, `stepId`, `nodeAttemptId`, `sessionId`, token
   kind totals, model, and resume marker. The web/supervisor prompt boundary
   carries active node-attempt attribution for shared `slash-in-existing`
   sessions; ambiguous concurrent prompt attribution is refused or serialized.
   DB rollups are derived and reconcilable. Run and node durations derive from
   existing `started_at`/`ended_at` columns, not redundant duration columns.
4. Delivery policy resolves in order: project default -> launch override ->
   promote-time override. The resolved run snapshot is immutable by later
   project-default edits. Strategies are `merge`, `rebase_merge`,
   `pull_request`, and separable `ai_rebase_merge`; triggers are `manual` and
   `auto_on_ready`. `auto_on_ready` only fires after the existing readiness
   gate and degrades to manual with the failing command/path/status surfaced.
5. Project delivery-policy editing uses one aggregating project settings PATCH
   route. Existing one-off settings routes may stay compatibility wrappers, but
   the new policy editor writes through the aggregate route.
6. Scratch promotion remains legacy M18 behavior in this slice. The shared
   `promoteRun` service must preserve scratch semantics unless a later ADR opts
   scratch into policy snapshots.
7. `ai_rebase_merge` reuses the standard run event stream and standard
   assignment/inbox surfaces. Conflict HITL uses the existing `merge_conflict`
   assignment kind unless implementation proves a distinct user action is
   required.

**Consequences:**
- Every acceptance criterion has a UI surface, EN/RU strings,
  empty/disabled/error states, and Playwright coverage before the feature is
  done.
- Public route responses remain explicit DTO projections; server-only handles,
  worktree paths, and raw cost payloads are not returned.
- Observatory remains read-only. It may add cost dimensions computed from bulk
  DB rows and derived cost rollups, but it adds no mutating route, background
  job, or recommendation write path.
- The schema migration for this decision is `0047`; the ADR number is ADR-087
  after ADR-085 and ADR-086 on the rebased `main`.

---

### ADR-088: Multi-flow package management

**Date:** 2026-06-12
**Status:** Accepted
**Context:** A delivery process ships as a set of flows plus the capability
content they need (skills, agents, MCP server templates, restriction
path-sets). Today each flow is its own `maister.yaml` source: the extracted
AIF package costs six entries (5 `flows[]` + 1 `capability_imports[]`)
version-pinned in lockstep, the bundle ingests as one opaque
`agent_definition` record, packages cannot ship MCP templates or restriction
sets, there is no update discovery, and nothing groups the parts as one unit.
The AIF package now lives in the external `maister-plugins` monorepo
(`packages/aif`, tag `aif/v2.0.0`). The deferred single-import plan
(2026-06-09) locked the two-scope direction; the owner-approved design is
`docs/pv/package-management.md`. ADR-021's per-revision install/trust model
stays the substrate — this decision groups revisions into packages above it.

**Decision:** Packages become the first-class distribution unit, sourced from
git monorepos and managed as a platform catalog with per-project attachments.

- **Package repos are git monorepos** (`packages/<name>/…`); more than one
  repo can be configured. Versions are per-package tags `<name>/vX.Y.Z` — the
  tag is the user-facing pin, the resolved SHA is runtime truth (ADR-021
  semantics unchanged).
- **`maister-package.yaml` v1** at the package root declares the contents:
  `flows[{id, path}]`, `capabilities[{id, path}]`, `mcps[]` (server templates;
  secret values are `env:NAME` references only), `restrictions[{id, paths[]}]`
  (path-sets that unlock `must_not_touch` for package flows). No `version`
  field — the git tag is the only pin. New content kinds arrive via
  `schemaVersion` bump.
- **`maister.yaml` gains `packages[] = {id, source, version, path?}`** —
  declarative bootstrap at registration and the durable record for re-raising
  a project on another instance. Registration materializes the SAME
  `package_installs` + attachment group as the UI attach path, so
  bootstrapped packages stay manageable. Runtime source of truth is the DB,
  managed from the UI; every attach/detach/upgrade **writes the pin back** to
  `maister.yaml` (comment-preserving, atomic; a write-back failure warns and
  never rolls back the attach).
- **Two-scope model:** `package_sources` (platform config; discovery via
  `git ls-remote --tags` + a shallow default-branch manifest scan, refreshed
  on demand and by a startup debounce gated by
  `MAISTER_PACKAGE_DISCOVERY_STALE_HOURS`, default 24) → `package_installs`
  (immutable installed package revisions in the content-addressed cache) →
  `project_package_attachments` (per-project enablement). Existing `flows`
  and `capability_imports` rows join a package group via nullable
  `package_install_id` FKs; standalone flows keep working.
- **Revision inheritance:** the package resolves ONE revision (git: tag SHA;
  local: content digest of the package dir) and every member flow/capability
  sub-install records that revision, so `runs.flow_revision` pinning and the
  content-addressed cache keep their immutability contract. Sub-installs
  receive a path-safe version label (`aif/v2.0.0` → `aif-v2.0.0`) because
  `versionTagSchema` forbids `/`.
- **Attach is one transaction** (member flow rows + capability rows + typed
  ingestion + attachment + FK links), guarded against `flows_project_ref_uq`
  collisions with standalone flows (CONFLICT) and detach-guarded against live
  runs (PRECONDITION). Typed ingestion replaces the opaque record: manifest
  inventory on the install row, `mcps[]` → project MCP catalog entries
  (package-provided, removed on detach), `restrictions[]` →
  flow-package-scoped restriction capability records. Ingested records are
  owned per install (`material.packageInstallId`): a same-`(kind, id)` record
  from another attached package refuses attach (CONFLICT), and detach removes
  only the rows the install owns.
- **Local versions are first-class:** a package installed from a local
  directory gets a `local-<digest>` label and attaches like any version — the
  fork-it/adapt-it/test-it loop, and the landing spot for future Studio forks.
- **Trust:** one operator decision per package revision fans
  `trust_status`/`exec_trust` to member rows in the same transaction;
  the decision is gated on the GLOBAL admin role because the fan-out crosses
  every project attached to the install (project-scoped `managePackages` is
  not sufficient). `setup.sh` still NEVER runs at install — only through the
  existing post-trust setup path (ADR-021/ADR-042/ADR-069 unchanged).

**Consequences:**
- Migration `0048` adds the three tables + two FK columns; package installs
  join the M19 preserve-then-prune GC story.
- Exactly one new env var (`MAISTER_PACKAGE_DISCOVERY_STALE_HOURS`) wired
  through `.env.example`, compose, and the configuration docs.
- The dogfood `maister.yaml` collapses from six lockstep entries to one
  `packages[]` entry; per-flow `flows[]` remains supported indefinitely.
- Write-back dirties the consuming repo's working tree by design (the file is
  MAIster's own config there; the user commits when ready).
- Package-shipped restriction sets unlock `must_not_touch` gates for package
  flows (AIF `v2.1.0` follow-up in `maister-plugins`).
- PR-back channels (repo-as-project promotion; Studio propose-upstream) ride
  later phases — see `docs/pv/package-management.md` §8.

**Alternatives Considered:**
- **Keep per-flow sources only:** rejected — six-entry lockstep per package
  ("config/version hell"), no grouping, no typed contents.
- **`version` field inside `maister-package.yaml`:** rejected — duplicates
  the tag pin and invites drift; ADR-021's "tag = user-facing pin" stands.
- **Repo-wide tags (`vX.Y.Z` for the whole monorepo):** rejected — releasing
  one package would bump all, and per-package change history blurs.
- **A new scheduler job kind for discovery:** rejected — the kind registry
  fans out across four code points for no latency need; a startup debounce +
  manual refresh covers "при старте или по кнопке".
- **Generalizing `capability_imports` into packages:** rejected — its
  ingestion is deliberately opaque (one `agent_definition` row) and its local
  revision hashes the source STRING, not content; packages need typed
  contents and content-addressed local versions.
### ADR-089: Platform agent catalog with per-agent runner and a five-source trigger model

**Date:** 2026-06-12
**Status:** Accepted
**Context:** Stage 3 of the platform-agents staged design (Stage 1 = social
board, ADR-083/M31; Stage 2 = domain-event outbox, ADR-086/M32). The vision
record is `docs/pv/agents-as-environment-actors.md` (2026-06-03 brainstorm);
the committed design doc was lost and is not restored (owner decision, same as
ADR-086) — this ADR plus `docs/system-analytics/agents.md` are the durable
Stage-3 record. Three owner amendments over the Stage-0 vision: **per-agent
runner** (an agent may carry its own runner binding instead of only a
recommendation), **standalone-first** (triggered one-shot agents ship before
flow-binding polish), and **social layer** (agents act through the ADR-083
comment/activity substrate — the schema-ready `actor_type='agent'` and the
emitter-less `task.triage_requeued` kind finally get writers). Prerequisites
already on main: polymorphic actor pair, per-recipient inbox, `agent_tick`
job-kind stub, dead `agent_schedules` table (M24, zero readers/writers),
consumer seam on the outbox.

**Decision:** An **Agent** is a first-class `.md`-defined actor (frontmatter +
body prompt) shipped INSIDE a flow package, projected into an `agents`
catalog table, attachable to projects, executed as ACP sessions on the
existing `runs` substrate, and triggered from five sources.

*(Amended in-branch 2026-06-13 — the pre-merge rework per owner decisions
1–8: the original host-catalog draft was replaced by the package-source
model below before this ADR ever merged.)*

> **Superseded in part by [ADR-105](#adr-105-first-class-authored-package-kinds-and-centralized-studio-package-model):** the
> platform-agent definition directory converged from `agents/<stem>.md` to
> `maister-agents/<stem>.md` in M39 Stream A. References to `agents/<stem>.md`
> below are historical; the runtime now reads `maister-agents/`.

- **Definition = `agents/<stem>.md` inside a flow package; DB row = catalog
  projection.** Agents ride the SAME trust contour, versioning, and Studio
  authoring/publish path as flows — no separate package type, no host
  catalog, no settings-panel creation (Studio/git package is the one
  creation+distribution path). The platform id is package-qualified
  **`<flowRefId>:<stem>`** — collisions are impossible by construction; the
  UI names the package to disambiguate. Registration scans
  `flow_revisions.installed_path/agents/*.md` after install finalize (git
  install, upgrade, and the authored bridge share the hook) and upserts the
  index with provenance (`flow_ref_id`, `version_label`, `origin:
  git|authored`) under SET/CLEAR symmetry; `resync` re-projects from the
  NEWEST Installed revision per flow_ref and disables rows whose providing
  package (or file within it) vanished — never silently deletes.
  Frontmatter: `name`, `description`, `runner` (optional runner id),
  `workspace: none|repo_read|worktree` (ADR-090), `workspace_ref` (ADR-090
  amendment), `mode: session|subagent`, `triggers:
  (manual|cron|domain_event|webhook|flow)[]`, `capability_profile` (M14
  shape, optional), `risk_tier: read_only|standard|destructive`, and
  `recommended` (`{runner?, cron?{expr,timezone}, events?[]}` — pre-fills
  the attach panel; nothing auto-applies without Save). The pre-rework
  `scope`/`project` keys are refused loudly (strict schema). Invalid
  definitions are reported by the registration summary and never written;
  registration parses only — no executable hooks, so no fetch-then-execute
  trust gap. Studio drafts validate `agents/*.md` with the SAME parser at
  save time (the old Claude-subagent key allowance for that path is gone).
- **Per-project effective definition behind the flow trust gates.** The
  catalog row is a projection carrying the platform kill-switches (enabled,
  quarantine). What a launch in project P actually RUNS is the
  `agents/<stem>.md` inside P's pinned revision of the providing package,
  resolved behind the exact flow-launch gate chain (configured pin →
  enabled-revision pointer → enablement ∈ {Enabled, UpdateAvailable} →
  trust ≠ untrusted → revision Installed) — at launch for the guards
  (mode/triggers/risk_tier/workspace + the runner tier) and again at spawn
  for the prompt body. **Pin divergence** — the index advertises a trigger
  the pinned version lacks — refuses `PRECONDITION`. Flow `agent:` bindings
  resolve through the host run's project pin the same way. "Update the
  agents a project uses" IS the existing package upgrade flow.
- **Attachment = `agent_project_links`.** `{agent_id, project_id, enabled,
  runner_override_id?}` with `UNIQUE(agent_id, project_id)`. Attaching
  requires the providing package configured+enabled in the project
  (`PRECONDITION` otherwise); the attach panel's available list filters by
  the same rule and opens pre-filled from the definition's `recommended`
  block.
- **Upgrade break-impact (owner decision 7).** The package upgrade preview
  gains an `agents` section — added/removed/changed (field diffs + dropped
  triggers) JOINED against the requesting project's live attachments and
  schedule bindings; the packages panel renders explicit "will stop working
  here" warnings before enable.
- **Per-agent runner, standalone resolution chain.** For standalone agent
  runs: `launch override → agent_project_links.runner_override_id → the
  effective definition's runner → projects.default_runner_id → platform
  default`, each tier validated by the existing `assertLaunchableRunner`
  (exists + enabled + ready; refusal = `EXECUTOR_UNAVAILABLE`, no silent
  fallback), snapshot into `runs.runner_snapshot` as today. Three
  compatibility refusals fire **before spawn** with `EXECUTOR_UNAVAILABLE`:
  `mode=subagent` on a runner whose `capability_agent ≠ claude`
  (`.claude/agents/*.md` is a Claude-SDK artifact); `workspace ∈ {none,
  repo_read}` on a runner with `permission_policy =
  dangerously_skip_permissions` (suppressed permission requests make ADR-090
  L1 impossible); and `workspace ∈ {none, repo_read}` on a runner whose
  `capability_agent ≠ claude` (the L1 `readOnlySession` arbitration is
  Claude-adapter-specific, so a non-Claude read-only agent would run
  unenforced). Flow-bound nodes keep the existing six-tier flow chain.
- **Capability-profile MCPs at spawn.** The effective definition's
  `capability_profile.mcps` refs resolve through the existing capability
  machinery (project>platform>flow-package precedence) and the stdio
  exec-trust gate keyed on the PROVIDING package revision's `exec_trust`;
  gated servers ride `createSession.mcpServers` alongside the maister
  facade. An absent declaration injects NO catalog MCPs — agents never
  inherit the project default set implicitly.
- **Execution substrate = `runs`, separate budget.** `run_kind` gains
  `'agent'`; new nullable `agent_id` FK, `trigger_source`
  (`manual|cron|domain_event|webhook|flow`), `trigger_event_id` (bigint →
  `domain_events.id`), `trigger_payload` (jsonb, ≤ 32 KB). One SSE pipeline,
  one HITL substrate, one reconciliation. Concurrency: new
  `MAISTER_MAX_CONCURRENT_AGENTS` budget (default 3) counted over
  `run_kind='agent'`; the existing pool keeps counting
  `run_kind IN ('flow','scratch')` — two independent FIFO Pending queues and
  per-kind slot release. (Same milestone, owner-requested:
  `MAISTER_MAX_CONCURRENT_RUNS` default 3 → 6; semantics unchanged.)
  Task-bound agent runs are commentary/triage machinery: they NEVER flip
  `tasks.status`, never bump `attempt_number`, and never count as the task's
  latest delivery run.
- **Five trigger sources** (persisted on `runs.trigger_source`):
  1. **manual** — `POST /api/projects/{slug}/agents/{id}/launch` (session RBAC,
     project-scoped) + catalog row button + task-card/detail button (passes
     `task_id`).
  2. **cron** — `agent_schedules` reworked in place (the table was dead M24
     code): text `agent_ref` and `scheduler_job_id`/`desired_state` dropped;
     real `agent_id` FK plus `cron_expr`/`timezone`/`next_fire_at`/
     `last_fired_at` added; rows claimed by the M28-proven atomic UPDATE
     (`SET next_fire_at = <next> WHERE id = ? AND next_fire_at <= now()
     RETURNING`) from a seeded singleton **`agent_tick.dispatcher`** job
     (60s) — the `agent_tick` stub handler finally gets its launcher.
     `agent_tick` leaves the user-creatable admin job kinds (seeded-singleton
     precedent: `run_schedule`, `domain_event_dispatch`). Missed ticks fire
     once (no backfill).
  3. **domain_event** — new `agent_triggers` consumer on the ADR-086 bus
     (`startFrom: "now"`): matches event kind + project against enabled
     `agent_schedules` event rows (`event_match.kinds`) joined to enabled
     links; **self-exclusion guard** — an event whose actor IS the matched
     agent never triggers it (the anti-loop invariant of the triage Q&A
     loop); claim-first spawn — the `Pending` run row INSERT carries
     `(agent_id, trigger_event_id)` under a partial UNIQUE index, so
     at-least-once redelivery converges to exactly one run
     (`ON CONFLICT DO NOTHING`).
  4. **webhook** — `POST /api/agents/[id]/event`, authenticated by a project
     token with the new `agents:trigger` scope; body → `trigger_payload`. An
     optional `X-Maister-Trigger-Event-Id` header supplies the idempotency key
     (`trigger_event_id`) — caller-controlled and sharing the bigint namespace
     with `domain_events.id`; the token scopes it to its own project, so the
     worst case is a caller deduping its own retries.
  5. **flow** — `agent: <id>` on `ai_coding` node settings (engine floor
     `1.5.0`): `mode=session` substitutes the agent body as the system prompt
     (node prompt appended as the task block); the bound definition's
     `capability_profile` is NOT merged into the flow node — the node's own
     capabilities govern (capability-profile MCP resolution is wired for
     standalone agent runs only, RD7); `mode=subagent` materializes the `.md`
     into the run
     worktree's `.claude/agents/` (Claude self-delegates). In Stage 3 the
     binding runs inside the flow run's session — no separate run row, so
     `trigger_source='flow'` is reserved wire vocabulary (mirrors how
     `task.triage_requeued` landed emitter-less in ADR-086).
- **Triage verdict + Q&A loop (social layer).** `tasks.flow_id` becomes
  nullable (simple-intent creation: title + prompt suffice — web form and
  ext/MCP `task_create` alike); flowless tasks classify as a new
  `unconfigured` launchability value (board chip, `PRECONDITION` refusal at
  `launchRun`, `skipped_unconfigured` in the schedules dispatcher, 409 on ext
  `run_launch`). New task verdict columns: `runner_id`, `target_branch`,
  `promotion_mode`, `triage_status` (single value `'triaged'`, NULL =
  untriaged — no `needs_human` state; missing fields prompt the human in the
  launch popover). New ext op `POST
  /api/v1/ext/projects/{slug}/tasks/{taskId}/triage` (scope `tasks:triage`)
  sets any subset of the verdict fields and always stamps
  `triage_status='triaged'` in one transaction + `triage_set` activity. The
  triager asks questions as ordinary task comments (agent actor, M31 fanout
  notifies the creator); a human reply re-triggers it via
  `task.comment_added`; a "Send to triage" action re-queues explicitly
  (`triage_status = NULL` + the first `task.triage_requeued` emit + activity,
  one transaction). Relations get ext ops + MCP tools
  (`relations:read|create|delete`).
- **Agent tokens = per-launch ephemeral.** `project_tokens.token_kind` gains
  `'agent'` with an `agent_id` FK. A token is issued at agent-run spawn
  (fixed scope set: `tasks:read`, `tasks:triage`, `comments:read`,
  `comments:create`, `relations:*`), injected server-side into the session's
  MCP-facade `mcpServers` entry (never streamed, never logged), and revoked
  at the run's terminal transition, on link detach, and by GC. Rationale:
  the token store is hash-only (sha256) — a durable attach-time token cannot
  be re-read for injection at later spawns without storing plaintext;
  per-launch issuance is strictly stronger rotation than rotate-on-detach.
  Token-derived actor maps to `{type: 'agent', id: agent_id}` —
  `task_comments`/`task_activity`/`task_relations` finally exercise the
  ADR-083 `agent` actor — and `token_audit_log.actor_label` records
  `agent:<id>`.

**Consequences:**
- Migrations: `0049_platform_agents.sql` (`agents`, `agent_project_links`,
  the `agent_schedules` rework, `runs`/`tasks`/`project_tokens` alters, the
  partial unique trigger-claim index, the `unconfigured`-enabling
  `tasks.flow_id` NULLABLE change), `0050_agent_activity_kinds.sql`
  (`task_activity` kind CHECK), and the rework's
  `0051_agents_package_source.sql` (DROP `scope`/`project_id`, ADD
  `flow_ref_id`/`version_label`/`origin` NOT NULL + `recommended` +
  `workspace_ref`; pre-release reshape deletes existing rows — the catalog
  re-registers from installed packages).
- Admin agents API shrinks to read + kill-switches (GET list/read, PATCH
  `enabled`/`unquarantine`); create/definition-edit/delete endpoints and the
  settings-panel agent modal are GONE — definitions change only through
  their providing package. The catalog panel shows `pkg@version` provenance
  + origin instead of scope.
- Qualified-id fan-out: the agent-id regex allows exactly one `:`
  (admin/attach/launch routes, `settings.agent` flow bindings — no bare-stem
  same-package sugar in v1); webhook routes URL-encode the id; subagent
  materialization writes `.claude/agents/<stem>.md`.
- Flow engine version bumps `1.4.0 → 1.5.0` (the `agent:` binding is
  floor-gated like `retry_policy` was in ADR-080).
- `agent_tick` disappears from `createSchedulerJobSchema` (job-kind admin
  enums re-sync in `web.openapi.yaml`); the seeded job count grows to 5.
- New scopes (`tasks:triage`, `relations:read|create|delete`,
  `agents:trigger`) and four MCP facade tools (`triage_set`, `relation_add`,
  `relation_remove`, `relation_list`).
- Two budgets mean a full flow pool can no longer starve monitoring agents
  and vice versa; portfolio/read models grow a `kind` badge + trigger chip.
- The `MAISTER_MAX_CONCURRENT_RUNS` default bump (3 → 6) fans out to
  `.env.example`, compose, `docs/configuration.md`, root `CLAUDE.md` §4, and
  every test asserting the old default.

**Alternatives Considered:**
- **Host-local owner-editable catalog (`~/.maister/agents/`, the original
  Stage-3 draft):** rejected in the pre-merge rework (owner decisions 1–2,
  5–6) — a hidden host dir is not transferable between hosts, splits agent
  trust/versioning from the package contour, and adds a second creation
  path beside Studio. Agents are package contents with all correspondence.
- **A separate package type for agents:** rejected — no value over flow
  packages today; skills carry risk too, so the trust contour is required
  either way and one package model keeps install/upgrade/trust singular.
- **Project-scope agent files inside the project repo
  (`.maister/<slug>/agents/`):** rejected by owner — keeps project repos
  free of agent artifacts; per-project availability is derived from the
  project's package pin, not a file location.
- **Per-schedule `scheduler_jobs` rows (the original M24 `agent_schedules`
  shape with `scheduler_job_id`):** rejected — `scheduler_jobs` has fixed
  `cadence_interval_seconds`, not cron; M28 already proved the dispatcher
  pattern (one seeded job + `next_fire_at` rows + atomic claim) for
  `run_schedules`; reusing it avoids a second cadence model.
- **Durable attach-time agent tokens ("rotated on detach"):** rejected —
  incompatible with the hash-only token store; would require storing
  recoverable plaintext server-side.
- **A separate `agent_runs` table:** rejected — Stage-0 locked decision #5
  (reuse `runs` with a kind discriminator) holds: one SSE pipeline, one
  reconciliation, one HITL substrate, one concurrency accounting seam.

---

### ADR-090: Agent workspace axis with three-layer read-only enforcement and quarantine

**Date:** 2026-06-12
**Status:** Accepted
**Context:** Most standalone agents (triager, monitors, stats collectors)
need project *context* but no delivery workspace — a git worktree + branch +
promotion path per ADR-007 is waste, and a writable parent checkout is a
hazard. ADR-041 keeps strict capability enforcement blocked (M14 is
materialize-only), so "the agent must not write" cannot yet be enforced at
the capability layer. Two shipped precedents provide the mechanics: the M30
gate-chat `readOnlyTurn` (per-prompt permission auto-deny inside the ACP
layer, ADR-078) and the GC preserve mutation sensor
(`statusPorcelain` snapshots, ADR-063).

**Decision:** Agent definitions declare a **workspace axis** —
`none | repo_read | worktree` — and `none`/`repo_read` runs are wrapped in
three independent no-write layers plus a quarantine consequence. The
invariant: **an agent run may only ever mutate its own worktree; a
`none`/`repo_read` run must leave the host byte-identical** (modulo the
tracked materialization manifest, restored before the check).

- **Workspace axis.**
  - `none` — cwd = the run's artifacts workdir
    (`.maister/<slug>/runs/<run-id>/work/`, plain mkdir); no git, no
    `workspaces` row, no promotion.
  - `repo_read` — cwd = the project's parent checkout (`repo_path`), for
    agents that read the codebase; no worktree, no `workspaces` row, no
    promotion. Launch precondition: `statusPorcelain(repo_path)` is EMPTY —
    a dirty baseline makes the no-write contract unverifiable →
    `PRECONDITION`.
  - `worktree` — the full existing lifecycle (`addWorktree`, `workspaces`
    row, diff/review/promotion) unchanged.
  - Run artifacts (`*.log`, `run.events.jsonl`, `session.json`, `cost.jsonl`)
    live under `.maister/<slug>/runs/<run-id>/` for every axis value.
- **`workspace_ref` — ephemeral checkout at a trigger-derived ref**
  *(amended in-branch 2026-06-13, rework owner decisions 4+8).* A
  `repo_read` definition may add `workspace_ref: trigger | <branch>`: the
  run then gets an EPHEMERAL detached worktree (`git worktree add
  --detach`) at the resolved ref under `worktreesRoot()/<slug>/<runId>-ro`
  — the user's checkout is never switched, and a tests-readiness agent
  checks out exactly the change that triggered it. Ref resolution (v1): a
  literal value is a branch/ref resolved against the local repo; `trigger`
  derives from context — `run.*` domain events use the triggering run's
  workspace branch, webhooks use the conventional payload `branch`
  (fallback `ref`) field; manual/cron/`task.*` refuse `PRECONDITION`.
  Unresolvable refs refuse — no auto-fetch in v1; `task.*` derivation and
  configurable payload extraction are deferred. The clean-baseline
  precondition is SKIPPED (a fresh checkout is clean by construction); L3
  targets the ephemeral dir when it exists (a dirty PARENT checkout no
  longer attributes to the agent); the dir is removed AFTER the terminal
  status-flip transaction commits (fs cleanup never rolls back the flip;
  crashed runs re-finalize through the same choke, which doubles as the
  cleanup backstop). L1/L2 are unchanged (keyed off the session cwd).
- **L1 — supervisor session-level auto-deny (live).** New
  `readOnlySession: boolean` on the supervisor's `POST /sessions` body —
  the session-scoped generalization of M30's per-prompt `readOnlyTurn`. The
  ACP permission handler auto-DENIES write-class tool permission requests
  and auto-APPROVES an allow-list of read-safe kinds for the whole session
  (a headless cron agent must not stall on its first file read). No
  pending-permission deferreds are created — `readOnlySession` sessions
  never reach the HITL inbox, and no deferred can leak. Runners with
  `permission_policy = dangerously_skip_permissions` are refused for these
  agents before spawn (ADR-089) because they suppress the very requests L1
  arbitrates.
- **L2 — M14 materialize-only deny rules (instructed, not enforced).** The
  capability materializer writes `.claude/settings.local.json` deny rules
  for write-class tools plus the agent's `capability_profile` roster into
  the session cwd. For `repo_read` the cwd is the user's parent checkout, so
  every materialized file is recorded in a **manifest** (the existing
  `.maister-owned` marker pattern) and removed/restored after the run; the
  L3 diff excludes exactly the manifest paths. Honest-visibility rule:
  L2 remains best-effort instruction — the ADR-041 enforcement boundary is
  unchanged, and surfaces describing it say so.
- **L3 — dirty-watchdog + quarantine (the hard layer).** Porcelain snapshot
  before spawn (must be clean); re-check at the run's terminal transition,
  INSIDE the terminal choke point — the check and the ephemeral-token
  revoke are sequenced before/within the status-flip transaction, and no
  run-row write may follow the terminal flip. Dirty beyond the manifest →
  one **quarantine transaction**: `agents.quarantined_at = now()` +
  `quarantine_reason`, a system comment on the task when the run is
  task-bound, and an `agent_quarantined` `task_activity` entry — all in ONE
  `db.transaction`. Quarantined agents are refused at every launch entry
  point (`PRECONDITION`: manual, cron, domain_event, webhook, flow binding)
  until an explicit un-quarantine action clears the flag. Taskless runs get
  the flag + catalog/portfolio badges only (no new notification plumbing in
  this stage).
- **ADR-041 boundary unchanged.** `risk_tier=destructive` definitions are
  refused at launch (`PRECONDITION`) until the enforcement flip lands;
  read-only/standard agents ship now precisely because L1+L3 do not depend
  on capability enforcement.

**Consequences:**
- The supervisor wire contract grows one field (`readOnlySession`) —
  `supervisor.openapi.yaml` + `docs/supervisor.md`; the mock ACP fixture
  must learn to emit `session.permission_request` so the auto-deny
  round-trip is testable.
- Concurrent `repo_read` runs against one repo are safe (read-only by
  contract) and allowed.
- False-positive quarantine is possible if a human edits the parent checkout
  while a `repo_read` agent runs — accepted: the watchdog cannot attribute
  dirt, it errs toward freezing the agent, the reason is recorded, and
  un-quarantine is one click. The launch-time clean-baseline precondition
  keeps the window small.
- A `repo_read` agent crash can strand L2-materialized files in the parent
  checkout until the terminal sweep restores them; the manifest makes the
  restore idempotent and the files are deny-rule content, not user data.

**Alternatives Considered:**
- **OS-level sandboxing (containers/seccomp/read-only bind mounts):**
  rejected for this stage — adapter-portable sandboxing is the Phase-2
  plugin-trust track; the three layers are implementable today inside the
  existing supervisor + materializer + git seams.
- **Auto-restore (stash/reset) instead of quarantine:** rejected — silently
  mutating the user's parent checkout to undo agent damage is worse than the
  damage; freezing the offending agent + surfacing the diff keeps the human
  in charge.
- **cwd = scratch dir + repo passed as a read path:** rejected — ACP
  adapters derive project context from cwd; a non-repo cwd degrades every
  codebase-reading agent to explicit-path archaeology.
- **Skip L2 (L1+L3 only):** rejected — the deny-rule materialization is one
  function call on an existing seam and instructs well-behaved agents away
  from denied tools before they burn permission round-trips.

---

## Open questions

These are tracked as TODOs against future ADRs. They are NOT decisions.

- **Per-host vs global concurrency cap when multi-host lands.** Revisit
  ADR-009 in Phase 2.
- **Plugin sandbox / trust UI for third-party Flow sources.** Defers
  ADR-010's "trust all internal sources" caveat.
- **Custom ACP extensions vs artifact-based structured HITL.** Stage 1
  is artifact-only; revisit if the standard ACP surface grows.
- **Cost / time / regex guard *enforcement* (kill-on-cap).** Today it's
  metric-only. Revisit when Phase 2 data shows guard breaches are real.

---

### ADR-091: Flow requirements launch precondition

**Date:** 2026-06-13
**Status:** Accepted
**Context:** Flow packages had no way to declare external host/runtime
dependencies — an external CLI a node shells out to, a Node version, network
egress, or required project state. The vendored `aif` / `superpowers` packages
bundle everything they need, but a CLI-driven package such as `openspec` drives
the `openspec` binary (via `cli` nodes) and needs that binary present on the
host. A missing dependency surfaced only at `cli`/agent runtime as a failed
command — after worktree creation, ACP session spawn, and token spend — instead
of as a clean launch refusal. The only declarable external dependency was an MCP
server (`mcps[]`); there was no general precondition, and OpenSpec ships no MCP.

**Decision:** Add an optional per-flow `requirements: [{ name, probe, hint? }]`
block to `flow.yaml`. Each `probe` is a shell command run (`bash -c`, in the
project repo, 10s timeout) during the `launchRun` precondition, BEFORE any
worktree/session is created. A non-zero exit or timeout refuses the launch with
one `PRECONDITION` listing every unmet requirement and its `hint`. It is
**check-only** — MAIster never auto-installs; provisioning stays the package's
job (`setup.sh` or an init-style flow such as OpenSpec's `os-init`, gated by
`exec_trust`). The block is additive and launch-checked (never read at compile),
so it carries **no `compat.engine_min` floor**. Placement is **per-flow**, not
package-wide, so an installer flow that provisions a dependency can omit the
requirement it satisfies — avoiding a chicken-and-egg block.

**Consequences:**
- External-CLI packages become first-class: a missing binary / wrong Node /
  absent project state fails fast and clearly, before any spend.
- One general mechanism (a shell probe) covers binaries, version checks,
  network reachability, and project state (`test -d openspec`) — no brittle
  per-kind parsing.
- Probes run with runner authority, like `command_check` gates and `cli` nodes;
  only trusted flows reach this path (`trustStatus` is gated earlier), so no new
  trust surface.
- Check-only: MAIster does not remediate; a missing dependency still needs
  operator / `setup.sh` action — the `hint` guides it.
- A probe is arbitrary shell; a hanging probe is bounded by the 10s timeout but
  still adds launch latency proportional to the number of probes.

**Alternatives Considered:**
- **Structured `{ binary, minVersion }` schema:** less general (no
  project-state / network / composite checks) and needs per-tool version-output
  parsing. A shell probe subsumes it.
- **Package-wide `requirements` in `maister-package.yaml`:** blocks an installer
  flow meant to satisfy the requirement (chicken-and-egg). Per-flow avoids it; a
  package-wide layer can be added later if a real need appears.
- **Auto-install on a missing requirement:** turns the launch path into an
  arbitrary-code installer — the `exec_trust` sandboxing concern (Phase 2).
  Kept check-only; installation stays in `setup.sh` / an init flow.
- **MCP-only (`mcps[]`):** only covers tools that ship an MCP server; OpenSpec
  ships none. A general probe is required.

---

### ADR-092: Flow Studio redesign — unified Studio IA + editable-local-package model

**Date:** 2026-06-15
**Status:** Accepted
**Context:** Flow/package authoring and management are scattered across four
surfaces: the `/flows` landing (an unbalanced two-column drafts|installed grid),
admin `/settings` (git sources + discovery + install), the project board
`?tab=packages` (attach/detach/upgrade/trust), and the
`/projects/{slug}/packages/{flowRefId}` viewer (ADR-075). The landing conflates
*flows* with *packages* — "Installed packages (6)" actually lists five flows from
one `aif` package plus one `bugfix` flow — and there is no unified home, no
package-grouped view, and no instance-level place to author a standalone artifact.
Only `kind=flow` has a create form + editor (ADR-067/068/069/070); skills, agents,
and MCP-templates are editable solely as files bundled inside a flow. A
local-source install already mints an immutable `local-<digest>` revision
(ADR-088), but there is no *editable* layer above it.

**Decision:** Adopt a unified **Studio** section (`/studio/*`) as the single IA for
sources → packages → artifacts → authoring, and adopt the **editable local
package** as the editing spine. Sequence the work **A → B → C**, each its own plan:

- **Phase A (Accepted, built now):** the Studio shell + surfacing over the
  *existing* backend — overview, sources (the relocated `PackageSourcesPanel`,
  admin), a packages list **grouped by package**, and a merged package-detail (BoM
  + read-only preview reusing the static `FlowGraphView`, ADR-075) with
  attach/trust/versions/fork. No migration, no new HTTP/SSE route, no new
  `MaisterError` code. The board `?tab=packages` config surface stays put
  (config-vs-content split) and gains an "Open in Studio" deep-link.
- **Phase B (Designed):** the storage-agnostic big-canvas editor redesign behind a
  load/save seam — node visual scheme, named-outcome handles, properties panel,
  top-bar drawers, hideable rail; drag-move persists to `presentation` (ADR-064).
- **Phase C (Designed):** the editable-local-package backend — **Variant B**: a
  `local_packages` table whose row points at a mutable working directory; "cut
  version" runs the existing installer over the dir → a `local-<digest>`
  `package_installs` revision; standalone artifact kinds (`agent`/`mcp` beyond
  `rule|skill|flow`); move-to-package; the editor's package-coupled half (Files
  drawer, cross-artifact reference pickers, "new artifact", cut-version). Plus
  `/studio/local`.

Git write-back to an upstream source stays **Phase 2**.

**Consequences:**
- One IA replaces four scattered surfaces; packages are presented as packages
  (grouped), not flattened to flows — directly fixing the landing's conflation.
- Phase A ships pure frontend value (no migration) and is the read-only twin the
  Phase B editor and Phase C local-package backend build on, so nothing is rebuilt:
  the package-detail preview is the read-only form of the Phase B canvas.
- Config (board) and content (Studio) stay separated, joined only by a deep-link
  and a project filter — the board's attach/trust contract is untouched.
- Variant B keeps platform scope clean: an editable local package *is* "a local
  source dir you cut versions from", symmetric with the existing git-package →
  install → attach pipeline, instead of invasively re-scoping the project-keyed
  `authored_capabilities` drafts table.
- `ref = name` is sufficient for Phase A; cross-source name collisions render a
  disambiguation list. A durable `base64url(source::name)` encoding can land later
  if collisions bite.

**Alternatives Considered:**
- **Extend `authored_capabilities` for editable local packages:** rejected —
  invasively re-scopes a project-keyed drafts table to a platform-level package
  concept; Variant B (a working dir + the existing installer) is symmetric with
  the git-package pipeline and matches the file-based editors.
- **Redesign the editor in one pass (no A/B/C split):** rejected — the editor's
  package-coupled half (Files drawer, cross-artifact pickers, cut-version) needs
  the Phase C local-package backend; the split ships the storage-agnostic ~90% of
  the usability win early with zero rework.
- **Keep the four surfaces, just polish `/flows`:** rejected — does not fix the
  flow≠package conflation, the missing unified home, or the flow-only authoring.
- **Redirect/delete `/flows` immediately:** the **landing** is deleted on Phase A
  completion (owner decision — no critical installs/users yet); the editor
  sub-routes (`/flows/{slug}/{capId}`, `/flows/new`) stay until Phase B relocates
  them to `/studio/edit`. The Sources panel is likewise removed from `/settings`
  (now only at `/studio/sources`).

---

### ADR-093: Project onboarding — optional `maister.yaml`, host-ambient git auth, onboarding modes, advisory clone reasons

**Date:** 2026-06-17
**Status:** Accepted
**Context:** The Add-project flow shipped with M21 (URL clone + configurable
roots, ADR-025) leaves five onboarding gaps. (1) Entering a Git URL does not
prefill the project name or task key — both are derived server-side and never
shown. (2) The task key is likewise invisible until after registration. (3)
Clone failures surface as a generic `PRECONDITION` 409: the real git stderr is
computed but discarded, and `gitExecOptions` forces `ssh -o BatchMode=yes`, so a
passphrase-encrypted key not loaded in the agent silently fails
`Permission denied (publickey)` with no actionable message (reproduced against
`git@gitverse.ru:…`). (4) `maister.yaml` is **mandatory** to register —
`register()` calls `loadProjectConfig()` before any DB write, so a repo that does
not already contain a manifest (every new or external repo) returns `CONFIG` 422
with no row, even though the source resolver already half-supports bare repos
(`gitStatus: "initialized" | "no-remote"`). (5) There is no greenfield
onboarding (a no-URL path that does not exist throws "directory not found") and
no way to attach a git remote to a local-only project later, which blocks PR
promotion.

**Decision:**
- **`maister.yaml` is OPTIONAL at manual registration.** Absent → register from
  DB defaults with the repo left untouched and `projects.maister_yaml_path = NULL`
  (the "config lives only in the DB" signal). A present-but-**invalid** manifest
  still fails `CONFIG` 422 — only a *missing* file takes the DB-default branch.
- **Three onboarding modes:** clone-from-URL, existing-local-repo, and
  new-empty-project (`mkdir -p` + `git init`, created **only** on an explicit
  `mode="new"`, never on a typo).
- **Live, editable URL→name+task-key prefill** (client), kept in sync until the
  user edits a field; explicit values win server-side (per ADR-078 D2).
- **Clone failures are classified** (`SSH_AUTH | SSH_HOSTKEY | HTTPS_AUTH |
  NOT_FOUND | NETWORK | UNKNOWN`) and carry the **real, redacted** git stderr as
  **advisory `{ reason, detail }` context on the unchanged `PRECONDITION` code**
  (the UI keeps branching on `code` and maps `reason` → a specific remediation),
  plus an optional one-off **HTTPS token** (askpass-injected, never persisted),
  best-effort **GitHub `gh auth token`**, and **SSH guidance** (no in-app keygen).
- **Opt-in persist** of the DB config back to `maister.yaml` as a commit on the
  main branch (with an opt-in push); a dismissible banner nudges it and **Project
  Settings → Git** is the durable entry point.
- **Git remote management** in Project Settings (list/add/edit/remove + push/
  fetch); adding/setting `origin` syncs `projects.repo_url` + `provider`.
- **Q2 = A — host-ambient git auth.** "Platform-managed" means managed by this
  MAIster instance via the **host's** mechanisms — ssh-agent/keys, `gh` when
  present, env vars, and the ephemeral one-off token field. No managed credential
  store is introduced now; push (persist / remotes) reuses host-ambient auth.

**Consequences:**
- The registration blocker is removed: greenfield, existing-local, and clone all
  register without a pre-existing manifest. `projects.maister_yaml_path` becomes
  nullable (one migration, no backfill — existing rows keep their path), and
  `NULL` is a first-class signal fanned out to both read models (board +
  portfolio), `writeBackPackagesPin` (early-returns `"skipped"` when null), and
  the persist banner.
- No new managed secret storage. The one-off token lives only in the git
  child-process env + a `0700` askpass file (removed in `finally`); it is never in
  argv, a key file, `.git/config`, `projects.repo_url`, or any log. **No new
  host-read env var** is added (`MAISTER_GIT_TOKEN` is transient child-process env).
- `gh` is an **optional** host tool; absent or unauthed degrades gracefully to the
  unified token / SSH path.
- **Default commit author when host identity is unset.** Host-ambient auth covers
  *credentials* but not the git *author* (`user.name`/`user.email`), which a
  freshly-provisioned host or CI runner may lack — a bare `git commit` then aborts
  with "empty ident name not allowed". Every MAIster-authored commit therefore
  supplies a per-field default identity (`maister` / `noreply@maister.local`) via
  `-c user.*` only for whichever field is unset (a configured host value is never
  overridden), through the shared `commitIdentityArgs` helper in
  `web/lib/worktree.ts`. Applies to all commit sites: `commitFile` (persist-config),
  `snapshotDirtyWorktree` (auto-commit-dirty before a review gate), and
  `squashRunBranch` (squash-on-promote).
- Work is phased and each phase is independently shippable: **P1** onboarding core
  (optional manifest + three modes + prefill; owns the migration) → **P2** git
  access (clone classification + token + `gh` + SSH) → **P3** Git in settings
  (remotes CRUD + persist with opt-in push).

**Alternatives Considered:**
- **Managed per-provider credential store now (Q2 = B):** rejected for this work —
  host-ambient auth covers the wedge without introducing new secret storage; a
  managed store is a cross-cutting future phase (clone + fetch + push + promotion)
  with its own design.
- **Keep `maister.yaml` mandatory, require users to author one first:** rejected —
  every new or external repo would be un-addable, and the source resolver already
  models bare repos (`gitStatus`).
- **Create the directory on any non-existent path:** rejected — only an explicit
  `mode="new"` creates a directory, so a mistyped existing-repo path fails loudly
  instead of silently scaffolding an empty project.
- **In-app SSH key generation:** rejected — guidance only; generating/storing keys
  is an additional security surface out of scope here.

---

### ADR-094: Default-runner materialization, honest readiness, and CCR admin lifecycle

**Date:** 2026-06-18
**Status:** Accepted
**Context:** The admin `/settings` → runners area was dishonest and noisy. The
seed (`web/lib/db/seed.ts` `ensurePlatformRuntimeDefaults`) inserted the **entire**
`platformRunnerPresetRows()` catalog (10 rows) into `platform_acp_runners` on
every install, so a fresh instance showed a large table of runners the operator
never created — including a "Ready" z.ai/CCR/GLM runner whose readiness was a
**hardcoded** preset field (`readinessStatus: "Ready"`), never verified against
live diagnostics. The same preset list was *also* rendered as an always-on
"Provider presets" card grid (double exposure), the "Adapter support" cards
were oversized with repeated textual badges, and platform agents (M34) lived on
the same admin settings page as the runner catalog. Separately, the CCR router
sidecar had no admin-triggered start path: the supervisor only spawned CCR
lazily on a `router:ccr` launch, and its keyed manager's `shutdown()` stops
**all** instances at once (`supervisor/src/ccr-manager.ts`) — there was no
per-instance stop to wire a UI button to.

**Decision:**
1. **Preset catalog = templates only.** `platformRunnerPresetRows()` is kept
   unchanged (still consumed by the Add-runner modal, the
   `GET /api/admin/acp-runners` response, and a new *collapsed* reference list)
   but is **no longer seeded** into `platform_acp_runners`. Fresh installs start
   with an empty runner catalog.
2. **Default runners are materialized from the adapter scan**, not seeded. A new
   `reconcilePlatformRunners({ db, diagnostics })` runs at admin `/settings` load
   (where supervisor diagnostics are already fetched). For each adapter reported
   **available** by diagnostics it upserts-if-absent that adapter's native
   default runner (`claude→claude-code`, `codex→codex-openai`,
   `gemini→gemini-cli`, `opencode→opencode-native`, `mimo→mimo-code-native`),
   recomputes `readiness_status`/`readiness_reasons` for **all** rows via
   `evaluateRunnerReadiness` against live diagnostics, and **creates the
   singleton `platform_runtime_settings` row** pointing at a `Ready` default
   when none exists yet (deterministic adapter preference: claude > codex >
   gemini > opencode > mimo). `default_runner_id` is **NOT NULL** with an FK to
   `platform_acp_runners`, so the pre-configuration state is an *absent*
   singleton — not a null column — which every reader already tolerates (launch
   paths raise `EXECUTOR_UNAVAILABLE` "platform default ACP runner is not
   configured"; UI/launch-option reads fall back to no-default). It **never
   auto-deletes**: a materialized row is a normal
   editable runner, and an adapter going unavailable leaves the row reading
   not-ready rather than removing it. The reconcile is the **single writer** of
   runner AND router-sidecar `readiness_status` outside create/edit — it
   recomputes sidecar readiness from the same diagnostics before runner
   readiness, since a sidecar-backed runner keys on the stored sidecar status;
   every downstream reader keeps consuming the stored column unchanged.
3. **Honest readiness, with a stated limitation.** The UI shows a readiness
   color dot + tooltip driven by the stored column, never a hardcoded label.
   **Verified limitation:** `evaluateRunnerReadiness` does **not**
   credential-verify the native `anthropic` / `openai` providers — for
   `claude-code` / `codex-openai`, readiness = the adapter binary is available
   (`--version` ok), with **no** API-key/login check. Such a native default
   therefore reads `Ready` whenever the binary is installed; the UI labels this
   state **"Available (ambient credentials — key/login not verified)"** rather
   than a verified "Ready". A real per-adapter auth-smoke (parallel to the
   gemini/opencode/mimo smoke gate) is **deferred** (owner decision 2026-06-18).
4. **Reconcile robustness.** When supervisor diagnostics are **unavailable**
   (null), the reconcile is a **no-op** — it preserves last-known readiness and
   never clobbers every runner to `NotReady` on a transient outage. A row is
   persisted only when its `readiness_status` / `readiness_reasons` actually
   changed (no `updated_at` churn).
5. **CCR admin start/stop reuses the existing supervisor `CcrManager`.** New
   `POST /sidecars/{id}/start` + `POST /sidecars/{id}/stop` supervisor routes and
   `POST /api/admin/router-sidecars/{sidecarId}/start` + `/stop` web proxies
   expose start/stop; no new process manager is introduced. Because the keyed
   manager's `shutdown()` stops **all** instances and clears the map, a new
   per-instance `CcrManager.stop(instanceId?)` is added and the stop route
   targets only that instance. After the supervisor acks, each web proxy calls
   `reconcilePlatformRunnersFromSupervisor` so the just-changed sidecar — and the
   runners that depend on it — refresh their stored readiness from fresh
   diagnostics immediately, not only at the next `/settings` load (otherwise a
   successful Start reports `ready` while the dependent runner stays `NotReady`
   and launch is refused with `EXECUTOR_UNAVAILABLE`). CCR **runner
   configuration** (config.json contents + runners routing through CCR) is
   **deferred** to a later session; admin Start just launches the process, and
   the healthcheck stays red until a config exists — honestly.
6. **No DB schema change, no migration.** Existing auto-seeded preset rows on a
   local dev DB are removed by a one-off cleanup, not a migration; fresh
   installs are clean because the seed no longer inserts the catalog **nor the
   `platform_runtime_settings` singleton** — it cannot, since `default_runner_id`
   is NOT NULL and would have no catalog row to point at; the singleton is
   instead created by the reconcile once a default materializes. No new env var
   and no new bound port (CCR's 3456 is pre-existing).

**Consequences:**
- A fresh admin instance no longer shows fabricated "Ready" runners; the catalog
  reflects only adapters the host can actually launch, materialized on first
  `/settings` load.
- Readiness stops lying: the single-writer reconcile recomputes it from live
  diagnostics, and the native-provider state is explicitly labeled as
  ambient-credential availability rather than a verified credential check.
- **Known limitation (accepted):** runner rows + honest readiness
  materialize/refresh when an admin first opens `/settings`. Until then launch
  dialogs show no platform runners on a brand-new instance. Acceptable for an
  admin-operated host; eager materialization is a later option if needed.
- CCR can be started from MAIster, but a started-without-config CCR healthchecks
  red — start ≠ usable routing until the deferred config work lands.
- Moving platform agents to a dedicated admin-only `/agents` route declutters
  `/settings`; the runner catalog and agents are separate admin concerns again.

**Alternatives Considered:**
- **Keep seeding the catalog, just fix the readiness field:** rejected — the
  seeded rows are still runners the operator never made; honest readiness alone
  does not remove the "huge table of fake runners" complaint.
- **Eager materialization at startup / migration:** rejected for now — adds a
  startup dependency on supervisor diagnostics and a migration for a UX that an
  admin-operated instance gets on first settings load anyway.
- **Credential-verify native anthropic/openai at reconcile time:** deferred —
  a real auth-smoke is a separate, owner-gated effort; labeling the state
  honestly ("ambient credentials") is the correct interim contract.
- **Wire the CCR Stop button to `CcrManager.shutdown()`:** rejected — it stops
  **every** CCR instance and any live session routing through CCR; a
  per-instance `stop(id)` is required.

> **Numbering note.** This ADR was renumbered from a draft `ADR-093` to
> **ADR-094** when rebased onto main — main's onboarding work (`ADR-093`) and
> migration `0054` had already landed. This plan adds **no** migration, so only
> the ADR number collided. After any renumber run
> `node scripts/validate-docs-adr-anchors.mjs` (`pnpm validate:docs` does not
> resolve ADR anchors).

### ADR-096: Flow Studio Phase C — editable local packages (Variant B): substrate, session lock, member RBAC, git-backed fork

**Date:** 2026-06-16
**Status:** Accepted
**Context:** ADR-092 accepted the unified Studio IA and named the **editable local package** as the editing spine, leaving the Phase C backend *Designed* (Variant B). Phase C needs the concrete contract — how a local package is stored, edited, version-controlled, made attachable, who may do it, and how concurrent edits are guarded — without re-scoping the project-keyed `authored_capabilities` table or pulling git write-back (Phase 2) into scope. The owner answered six open questions that refine the model (member RBAC, a session lock, MCP-from-catalog, git-backed forks, no auto-GC, read-only-preview-plus-fork for git packages).

**Decision:** Build the Phase C backend per Variant B (ADR-092) plus the owner's refinements:

1. **Substrate (Variant B).** A platform-scoped `local_packages` table; each row points at a mutable, **git-backed working directory** under `localPackagesRoot()` (`MAISTER_LOCAL_PACKAGES_ROOT`, default `~/.maister/local`). `working_dir` is server-only (never sent to the client, mirroring `package_installs.installed_path`). Artifacts are **files** in the dir (`flows/ agents/ skills/ mcps/ rules/ schemas/`) — the authored kind enum (`rule|skill|flow`) is **NOT** extended; the file editors operate on files, not `authored_capabilities` rows.
2. **Cut version.** "Cut version" exports a clean copy of the working dir (excluding VCS metadata) and calls the *existing* installer `installPackageRevision({ source, version: "local" })` → an immutable `local-<digest>` `package_installs` revision, then optionally `attachPackage(...)`. No new installer. Local sources are `trusted_by_policy` via `resolveTrust`, so `setup.sh` runs post-attach with no extra trust step (ADR-021 fetch-then-execute separation preserved — install never runs `setup.sh` inline).
3. **Editor route.** `/studio/edit/{localPackageId}/{artifactPath}` — local-only, keyed on `local_packages.id` (sidesteps the deferred `base64url(source::name)` ref). Git packages get a **read-only preview + "Fork to local"**; no in-place git-package editing. Reuses the Phase B `FlowEditorTabs` seam with a working-dir-targeting save action (no `authored_capabilities` `draft_version` CAS).
4. **Concurrency = session-scoped working-dir lock.** `local_packages` carries `locked_by_user_id` / `locked_by_session` / `lock_expires_at` (mirroring `runs.keepalive_until`). Opening the editor acquires the lock iff free or expired (lazy stale-takeover — **no sweeper**); the editor refreshes it (mirroring `POST /api/runs/{id}/activity`); every write asserts a live lock or fails `CONFLICT`; a second session is read-only.
5. **RBAC = member-level local loop.** Creating / forking / editing / cutting a local package = any authenticated user (`requireSession`; Studio is member-accessible). **Attaching a cut version to a project** = project `member` via a new `manageLocalPackages: "member"` action. The existing **git-package** install/attach/trust gates stay **admin** (`managePackages`/`manageCatalog`) — Phase C does not widen them (asymmetry by design).
6. **Fork = git-backed.** A from-scratch local package is `git init` + a branch; a fork of a git package seeds from the source at the installed revision and records `source_repo_url` / `source_ref` / `branch_name`. **PR-to-source is Phase 2** (`pushBranch` exists in `lib/worktree.ts`; a PR-creation helper does not).
7. **MCP-template from the catalog.** The MCP-template editor sources from the platform MCP catalog (`platform_mcp_servers`): pick a server → materialize its template (transport/command/args/url/`env_keys`, `env:NAME` refs only). Today packages carry self-contained MCP templates with no catalog reference; this adds a catalog-pick + an optional `platform_mcp_server_id` provenance field, validated against a real `/mcps` entry.
8. **No new `MaisterError` code** (ADR-008 closed union): path-confinement → `PRECONDITION`, invalid working-dir → `CONFIG`, lock held/expired → `CONFLICT`.
9. **No automatic GC** (owner decision): orphaned working dirs / abandoned `Installing` installs are cleaned manually; explicit `deleteLocalPackage` removes its own dir.

**Consequences:**
- Reuses the installer, attach pipeline, trust policy, the Phase B editor seam, the run keep-alive pattern, and `lib/worktree.ts` — the genuinely-new backend is the `local_packages` table + working-dir CRUD + the lock + the MCP-template editor.
- A member can author and apply their own forks without admin rights, while platform git-package management stays admin-gated.
- The git-backed working dir makes a fork a real branch, so the Phase-2 PR-back is additive (the schema already stores the source repo/ref/branch).
- Migration `0057` adds `local_packages` (incl. lock + source columns). New env vars `MAISTER_LOCAL_PACKAGES_ROOT`, `MAISTER_LOCAL_PACKAGE_LOCK_MINUTES`; `.maister` stays host-only (no Docker mount, ADR-023) — documented, not wired.

**Alternatives Considered:**
- **Content-hash ETag instead of a lock:** rejected by owner in favor of a session-scoped working-dir lock — clearer multi-tab semantics, no silent overwrite.
- **Admin-gated cut/attach:** rejected — members own the fork-and-apply loop for their own projects.
- **Plain copied working dir (no git):** rejected — a fork should be a branch so the Phase-2 PR-back has clean history; `git init` is cheap and adds local version control.
- **Self-contained MCP templates only (no catalog link):** not chosen — sourcing from the platform MCP catalog avoids re-entering server config and keeps one source of truth.
- **Extend `authored_capabilities` with `agent`/`mcp` kinds:** rejected (ADR-092) — Variant B keeps platform scope clean; files in a working dir, not project-keyed draft rows.

**M36 extension (Flow Package Viewer + Local Editing).** The salvaged substrate
is extended without re-scoping it: (1) **both-grain fork** — a package-level
fork (whole bundle → a new `<source>-local` package) AND an element-level fork
(one flow/skill/agent/rule → the project's default package); (2) a **per-project
default "virtual" local package** (`local_packages.is_default` + nullable
`project_id`, migration `0058`, partial-unique `(project_id) WHERE is_default`)
that element-forks land in, created on first use (race-safe); (3) the
**MCP-template editor** sources the platform MCP catalog but persists no
provenance column — the catalog pick is **display-only**, materializing
`env:NAME` references only (no schema delta, no secret values). Fork copies the
installed bundle's bytes (excluding `.git`) and executes nothing; cut-version is
two-phase (export+install before the durable stamp/attach, crash-window
recoverable). See [`system-analytics/local-packages.md`](system-analytics/local-packages.md).

> **Numbering note.** This ADR is **ADR-096** and its substrate migration is
> **0057** after M36 was rebased onto `main`: onboarding / CCR / execution-policy
> had taken ADR-093–095, and execution-policy + scheduler had taken migrations
> 0055 / 0056. Run `node scripts/validate-docs-adr-anchors.mjs` after any renumber.

### ADR-097: Docked AI authoring assistant — project-less scratch-at-local-package run (M36 Phase 5)

**Date:** 2026-06-20
**Status:** Accepted
**Context:** M36 Phase 5 docks an AI authoring assistant inside the Flow Studio
local-package editor: an ACP session that edits the local-package working-dir
files directly, with live canvas/file refresh and inline HITL. It reuses the
**scratch-run substrate** (`run_kind = "scratch"`, runner resolution, capability
materialization, supervisor session, HITL, diff, the run keep-alive/recover
plumbing) but is rooted at a **local-package working dir** that has **no project
and no managed git worktree**. A local package is platform-scoped: a
package-level fork (`forkPackageToLocal`) has `project_id = NULL`, while a
per-project default fork (`forkElementToDefault`) carries a `project_id`. The
editor opens either, so the assistant cannot always carry a project — the run
must be genuinely **project-less**.

**Decision:** Model the assistant as a **project-less scratch run** rooted at the
local-package `working_dir`. No `git worktree add`, no `workspaces` row, no new
`runs.status`, no engine bump, no new `MaisterError` code (reuse
`PRECONDITION | CONFIG | CONFLICT`). The session runs IN the existing git-backed
working dir; base branch/commit are read from it.

1. **Nullable owner + launch snapshot (migration 0059).** `runs.project_id` and
   `scratch_runs.project_id` become **nullable**. `scratch_runs.local_package_id`
   (FK `local_packages`, `ON DELETE CASCADE`) is the project-less owner;
   `runs.local_package_id` is the **launch-time snapshot** every terminal/read
   path reads (never re-derived). A DB **CHECK** (`scratch_runs_owner_xor_check`)
   enforces **exactly one of** `project_id` / `local_package_id`. The
   `scratch_runs_project_status_idx` is made **partial**
   (`WHERE project_id IS NOT NULL`) so it still serves project rows, plus a new
   partial `scratch_runs_local_package_idx`.
2. **Launch fan-out (`launchLocalPackageAssistant`).** A sibling of
   `launchScratchRunStaged`: `worktreePath = <working_dir>`, NO worktree add, NO
   workspace row. One launch insert writes the project-less `runs` +
   `scratch_runs` rows (snapshotting `local_package_id`), resolves the runner via
   launch-override → **platform default** only (no project-default tier), and
   materializes a bare per-adapter capability profile (the flow-authoring skill
   is seeded by the Studio surface). Member-level RBAC (`requireActiveSession`,
   per ADR-096). Counts against the scratch (flow-pool) concurrency cap.
3. **Supervisor working-dir confinement.** The session-create input carries an
   optional `confineRoot`; when set it is the **SOLE** content-block file-URI
   allow-root (the run dir stays allowed for uploads), **replacing** the
   worktree ∪ repo allow-set. The web `createSession` passes
   `confineRoot = working_dir`; the web tier confines too (defense in depth). A
   `file:` URI outside the working dir is rejected (`PRECONDITION`).
4. **No project-scoped events.** A project-less run has no project to attribute
   domain/webhook events to (both outboxes + `domain_events.project_id` are
   NOT NULL and project-scoped). `markScratchCrashed`, the keepalive TTL pass,
   and the live scratch terminal emitter all **skip** the emits when
   `project_id` is null; the run's own `runs`/`scratch_runs` terminal rows are
   the record.

**`run_kind` consumer checklist (every site grepped; how each is branched):**
- `lib/reconcile.ts` — a project-less run has `project_id` NULL ⇒
  `loadCandidates` (which iterates `projects`) **never selects it** → never
  Crashed for a missing project worktree. The pure classifier already
  `skip`s a live scratch session and **refuses `reattach`** for non-flow runs
  (resume-driver guard). ✔ tested.
- `lib/runs/resume-driver.ts` — only invoked via reconcile `reattach` (refused
  for scratch) or the scratch recover route (`session/resume`, not the flow
  `RESUME_CONTINUATION_PROMPT`). Never drives a project-less run. ✔
- `lib/runs/keepalive-sweeper.ts` — pass1/pass2 select by status only; pass2
  scratch branch skips the project-scoped emits when `project_id` is null. ✔
- `lib/scheduler.ts` — scratch is in the **flow pool**; the assistant launches
  straight to `Running` (never `Pending`), so `tryStartRun`/`promoteNextPending`
  are not on its path; counting is status+kind based (project-agnostic). ✔
- `lib/queries/portfolio.ts` — `getPortfolio`/rail/inbox filter
  `inArray(runs.project_id, projectIds)` (+ rail inner-joins `workspaces`), so a
  project-less run is **excluded** by construction; loops carry a defensive
  null-skip. Studio surfaces it, not a project board. ✔
- `lib/board.ts` — pure stage derivation over a task+run pair; assistant runs
  are board-less (no task), never passed here. ✔
- `lib/queries/run.ts` (`getRunDetail`), `lib/runs/change-summary.ts`,
  `lib/queries/run-manifest.ts`, `lib/runs/cost-rollups.ts`,
  `lib/queries/observatory.ts`, `lib/flows/graph/runner-core.ts`,
  `lib/workbench-lifecycle/service.ts`, `lib/acp-runners/usage.ts`,
  the takeover + review-comments routes, `…/diff/route.ts` — all are flow/
  project-scratch paths that resolve a project via inner join or required
  field. They narrow `project_id` through `requireRunProjectId(...)` (throws
  `CONFIG` if a project-less run ever reaches a project-scoped path) or return
  404/PRECONDITION for the project-less variant; usage-references keep the
  project-less run (it still pins a runner → still blocks deletion). ✔
- `components/workbench/lifecycle-actions.tsx` (`endpointFor`) — the assistant
  is not surfaced on the rail/board (excluded above), so its `⋯` lifecycle
  endpoints are never targeted at a project-less run.

**Consequences:**
- One internally-consistent model: the run is project-less, every automatic
  sweep/query excludes it or narrows safely, and the launch-time snapshot keeps
  terminal/read paths free of re-derivation.
- `runs.project_id` becoming nullable touches ~13 flow/project-scratch consumers;
  each narrows at its load boundary via `requireRunProjectId` (a single helper),
  so the nullable column never silently coerces and a regression surfaces as
  `CONFIG` rather than a crash.
- The assistant's diff is the Studio editor's git-working-tree view (Phase 4),
  not the project workspace diff route; the project-scoped run diff/change-summary
  routes 404 for it.
- The turn/recovery surface (`sendScratchUserMessage`, the scratch recover
  route) branches RBAC to `requireActiveSession` (member-level) when the run is
  project-less; the diff/file/lifecycle UI for the assistant is the Studio
  editor (separate task), so the project-scoped scratch routes that require a
  `workspaces` row stay project-only.

**Alternatives Considered:**
- **Keep `runs.project_id` NOT NULL, reuse a project:** rejected — a named
  local package has no project; there is nothing valid to reference.
- **Restrict the assistant to per-project default packages (always a project):**
  rejected — contradicts the design (the editor opens any local package) and the
  project-less framing; it would block authoring a named platform-scoped fork.
- **A new `run_kind` for the assistant:** rejected — it reuses the entire
  scratch substrate (runner/capabilities/session/HITL/diff/recover); a new kind
  would fork all of it. The project-less variant is a property of a scratch run,
  not a new kind.
- **Emit project-scoped events with a sentinel project:** rejected — there is no
  honest project; skipping the emit is correct (the assistant has no webhook
  subscribers and no project board).

---

### ADR-095: Flow execution-control policy — snapshotted preset + composable autonomy axes, fail-closed, no-blind-ship

**Date:** 2026-06-20
**Status:** Accepted
**Context:** A flow run's autonomy was implicit (always-supervised: every gate
blocks, every permission asks, every promote is manual). Driving runs
unattended needs explicit, composable control over *where the machine acts on
its own* — across machine self-correction, human escalation, and output shaping —
without ever silently shipping unvalidated work.

**Decision:** Introduce a per-run **execution policy** — a `preset`
(`supervised | assisted | unattended`) that expands to nine composable axes,
each overridable, snapshotted onto `runs.execution_policy` at launch (immutable
for the run's life; resume/recover/finalize read the snapshot, never a mutable
catalog row — same discipline as `runner_snapshot` / `deliveryPolicySnapshot`).
The axes, grouped:
- **A (self-correction):** `reworkExhaustion` (escalate | ship_with_warning |
  fail) at the rework-cap; `crashRetry` (fail | ralph_loop | auto_retry) bounded
  auto-relaunch on Failed; `checks` (strict | advisory | skip) non-review
  check-gate promotion-strictness.
- **B (escalation):** `permissions` (ask | auto_approve) supervisor-side inline
  L3 below the read-only layers; `humanGate` (stop | auto_pass) auto-resolve a
  human gate only after `assertEvidenceReady`; `onStuck` (escalate |
  ship_with_warning | notify_only) routes the can't-auto-pass branch.
- **C (output shaping):** `promotion` (manual | auto_on_ready) OR-combined with
  the delivery-policy trigger; `commits` (keep_all | squash_rework |
  squash_on_promote | defer) deterministic tree-preserving squash-on-promote;
  `dirtyResolve` (ask | commit | proceed) auto-resolve a dirty worktree at a
  review gate (`discard` never automatic).

Two cross-cutting invariants are load-bearing:
1. **Fail closed.** Every axis is read back from the open jsonb snapshot through
   a `*FromSnapshot` resolver that defaults to the SAFE value on a null / absent /
   malformed policy (`checks→strict`, `crashRetry→fail`, `reworkExhaustion→escalate`,
   `permissions→ask`, `humanGate→stop`, `onStuck→escalate`, `promotion→manual`,
   `commits→keep_all`, `dirtyResolve→ask`). A corrupt policy can never silently
   relax validation, ship, or auto-act.
2. **No blind ship.** Relaxing the check gates (`checks` advisory/skip) is
   forbidden in combination with EITHER auto-passing the human gate OR
   auto-promotion — at least one validation floor (strict checks, a human review,
   or a manual promote) always remains. Enforced client-side (the launch dialog
   disables the conflicting option) AND server-side (`assertNoBlindShip` at
   launch, `code: PRECONDITION`). `unattended` keeps `checks: strict`, so its
   auto-pass + auto-promote always sit behind the machine judge/check loop.

`onStuck`/`reworkExhaustion` stay **separate** axes (not unified): rework-cap
exhaustion is `reworkExhaustion`; the human-gate-can't-auto-pass branch is
`onStuck`. `squash_rework` is reinterpreted as **squash-on-promote** (collapse
`base..branch` into one commit pre-merge, tree-preserving — there are no
per-node-attempt commits to collapse) with a guard that reverts to `keep_all` on
any tree drift or git failure. See
[`system-analytics/execution-policy.md`](system-analytics/execution-policy.md)
for the per-axis mechanisms and call sites.

**Consequences:**
- One snapshot column drives all autonomy; resume/recover are deterministic.
- Every autonomy action funnels through `logExecPolicyAction` (a typed audit
  boundary) and, for on-stuck, a new `run.escalated` domain-event + webhook kind
  (migration `0056`).
- The privileged `launchUnattended` project action gates any policy that lowers
  oversight below the supervised floor (auto_pass / auto_on_ready / relaxed
  checks / non-escalate on-stuck).
- Squash/auto-promote/auto-resolve are best-effort and never fail their host
  operation — a botched history or a git error degrades to the safe default.

**Alternatives Considered:**
- **A single boolean "autonomous" flag:** rejected — autonomy is not one
  dimension; teams need to relax permissions without auto-shipping, or
  auto-promote while keeping human review.
- **Embed numeric bounds (rework cap, max attempts) in the policy:** rejected —
  the author's `rework.maxLoops` is authoritative (policy picks only the
  on-exhaustion action), and ralph `maxAttempts` is a host env knob
  (`MAISTER_RALPH_MAX_ATTEMPTS`); embedding numbers would reopen the schema.
- **Re-validate the no-blind-ship guard at promote time:** rejected — the policy
  is an immutable launch snapshot, so launch-time validation is sufficient;
  promote already re-gates on `assertEvidenceReady`.
- **Unify `reworkExhaustion` into `onStuck`:** rejected — they fire at distinct,
  separately-tested engine sites; one axis would churn shipped code for no gain.

---

### ADR-098: Orchestrator engine — supervisory node, governed run-tree, delegation toolset, success-gated task-DAG, idle-checkpoint wait/resume

**Date:** 2026-06-20
**Status:** Accepted
**Context:** MAIster executes **static** Flow graphs — a fixed `nodes[]`/`transitions`
DAG authored ahead of time (`docs/flow-dsl.md`, `flow-graph.md`). A running agent
cannot decide *at runtime* to decompose its work, dispatch sub-units, and
coordinate their results: there is no governed dynamic delegation. The
constraints earned in prior review passes bound the design: every delegated unit
must stay a **governed Run** (worktree, gates, promotion, board visibility,
concurrency cap); dynamism lives only in *coordination*, never in bypassing
governance; children are **catalog-resolved** (M34 effective definition, ADR-089/090),
never runtime-authored; and the agent pool is small (`MAISTER_MAX_CONCURRENT_AGENTS`,
default 3), so a long-lived coordinator must not hold a scheduler slot while blocked.

**Decision:**
1. **The orchestrator is a long-lived SUPERVISORY flow node**, not a
   run-to-terminal step. The flow *parks* on it: it spawns/coordinates children,
   idle-checkpoints while blocked, and reaches a terminal verdict only when the
   agent declares the goal met → normal downstream transitions
   (judge/readiness/promote). Governance is **structural**: every delegation hop
   routes through this one node, so policy / ensure-gate / HITL / audit attach
   there. New node type `orchestrator` (`node_attempts.node_type`), engine floor
   **`1.6.0`**, inherits the `ai_coding` capability shape.
2. **Children are governed Runs; dynamism is in coordination.** `as-task` → a
   child task via `parent_of` (Kanban card) + a run; `as-run` → a child run only
   (`runs.parent_run_id`, workbench subtree, **no** board card); `as-plan` → a
   DAG of child tasks wired by `requires` edges. Each child is a real Run
   (worktree, gates, promotion, cap, snapshot).
3. **New run status `WaitingOnChildren`** holds **no** scheduler slot — the
   orchestrator idle-checkpoints (releasing its agent-pool slot via
   `releaseSlotOnIdle`→`promoteNextPending`) and is resumed by a child-terminal
   domain event. Allow-listed in every run-status consumer (read models,
   scheduler `countLiveRuns` exclusion, sweeps, guards, board).
4. **Run-tree columns on `runs`** (migration 0060): `parent_run_id` (FK→runs,
   on-delete set-null), `root_run_id` (FK→runs), `delegation_snapshot` (jsonb;
   **only** the effective agent-definition id + pinned revision — the resolved
   runner stays in the existing `runner_snapshot`, never duplicated), `launch_mode`
   (`auto`|`manual`). Indexed on `parent_run_id`, `root_run_id`.
5. **Success-gated `requires` relation kind.** `depends_on`/`blocks` release on
   Done **and** Abandoned (correct for a human board, wrong for auto-execution);
   `requires` releases **only** on Done — Failed/Abandoned keeps dependents
   blocked and wakes the orchestrator. `parent_of` never gates. `requires` is
   wired into the shared launchability classifier (`web/lib/runs/launchability.ts`)
   so it gates at **every** launch entry point, not just the board read model.
6. **Snapshot the launch-time effective definition on the child run row**
   (skill-context rule 207). The catalog-resolved child's effective definition +
   resolved runner are snapshotted at spawn; the terminal/enforcement path reads
   the snapshot, never re-derives from a drifting projection.
7. **Branch shared dispatch on `run_kind` BEFORE routing** (skill-context rule 207).
   The child-terminal resume consumer and the reconcile classifier MUST branch on
   `run_kind`/parent-linkage before driving a run into the flow resume driver — an
   orchestrator-child driven into the flow-only path `Crashes` context-less. Guard
   at the irreversible apply site plus a test per discriminant arm.
8. **Trust: catalog-resolved, never runtime-authored.** Child resolution goes
   through M34 `resolveEffectiveAgentDefinition` (enablement + trust gates, pinned
   revision) + `resolveAgentRunner`. A `run_delegate`/`run_plan` naming an agent
   not resolvable through the project's enabled+trusted catalog is refused
   (`PRECONDITION`) — "resolve+trust" is physically separate from "launch", and
   **no child run is created** on refusal.
9. **Delegation toolset over the MCP facade.** A per-launch ephemeral `agent:<id>`
   token scoped `runs:delegate` is materialized into the orchestrator session's ACP
   `mcpServers` (gated to `orchestrator` nodes only; revoked on terminal). Tools:
   `run_delegate` (as-task|as-run), `run_plan` (task-DAG), `run_collect` (reads each
   child's terminal status + `{{ steps.<id>.output }}` stdout var + a produced-artifact
   manifest + the base→run diff ref — **never** the child worktree directly, matching
   the reviewer-isolation contract), `run_cancel`.
10. **Two-phase commit / multi-store atomicity.** Child run creation calls
    `POST /api/v1/ext/runs` so the **web tier owns the transaction** (run row +
    task/relation rows); supervisor `POST /sessions` happens **after** commit; an
    orphan (committed run, no session) reconciles to `Crashed`. `run_plan` writes N
    tasks + M `requires` relations in **one** `db.transaction` after pre-tx
    cycle/depth/fanout validation (clean `CONFIG`/`PRECONDITION`, no partial DAG).
    Auto-launch on dependency-clear calls `launchAgentRun` **directly** for the
    unblocked dependent — that launch path does its own cap admission (a
    Pending/Running decision under the global cap), so the consumer does not need
    a separate `promoteNextPending` mark; idempotency is the per-task `hasAnyRun`
    belt on the singleton dispatcher, backed at the DB by the
    `runs_auto_task_uq` partial unique index (ADR-100, migration 0060 — one auto
    run per task), so even concurrent dispatch can never double-launch a
    dependent. Wait/resume each close status + `node_attempts` cursor in one tx.
11. **Bounds.** `MAISTER_MAX_ORCHESTRATOR_FANOUT` (per-plan task cap, default 16)
    and `MAISTER_ORCHESTRATOR_MAX_DEPTH` (run-tree recursion bound, default 3),
    enforced pre-tx; over-limit → `CONFIG`.
12. **No new `MaisterError` code** (ADR-008 closed union). Reuse `PRECONDITION`
    (unresolvable/untrusted target, cross-batch dep ref), `CONFIG` (engine floor,
    over-fanout/over-depth, cyclic DAG, strict path-scope), `CONFLICT` (concurrent
    resume), `CHECKPOINT` (resume failure), `EXECUTOR_UNAVAILABLE` (cap/spawn).

**Consequences:**
- maister gains its first **dynamic-orchestration** capability while keeping every
  delegated unit governed (worktree/gates/promotion/cap/board) — the foundation for
  the parked dynamic-flow-synthesis milestone (~M38).
- The agent pool (cap 3) cannot starve: a blocked orchestrator holds **no** slot.
- The run-tree is observable end-to-end (workbench subtree + board decomposition).
- **Path-scoped write enforcement** ("tester edits only tests") is **not** delivered
  — read-only-vs-full is the only enforced axis; path-scope ships `instructed`-only and
  a `strict` declaration is refused (`CONFIG`) until the policy layer lands (ADR-099).
- Persistent swarm sessions, star-routed messaging, worktree modes, and per-agent
  read-only perms are Layer 2 (**ADR-099**).

**Alternatives Considered:**
- **Run-to-terminal orchestrator that blocks on children:** rejected — it holds a
  scheduler slot the whole time and starves the cap-3 agent pool; the idle-checkpoint
  wait is the entire point.
- **Runtime-authored children (omnigent `config_path`):** rejected — bypasses the
  trust contour; children are catalog-resolved only.
- **A new `run.delegated`/`run.child_done` event kind:** rejected — reuse
  `run.done/failed/crashed/abandoned` and widen the payload with `parent_run_id`;
  fewer kinds to register across the kind-registration sites.
- **`depends_on` with a "success only" flag:** rejected — a boolean on an existing
  kind muddies the human-board semantics; a distinct `requires` kind keeps
  `parent_of`/`depends_on`/`blocks` intact.
- **Mesh messaging (direct child↔child):** rejected (deferred to ADR-099 as
  star-only) — star-through-orchestrator keeps every hop auditable on one node.

> **Numbering note.** Renumbered at the merge onto main. The
> `feature/orchestrator-engine` branch authored this as ADR-095/096 over
> migrations 0055–0060, but main shipped ADR-095/096/097 (Flow execution-control
> policy / Flow Studio Phase C / Docked AI assistant) and migrations 0055–0059
> first, so this engine is **ADR-098/099/100** and milestone **M37**. The six
> branch migrations were folded into the single consolidated
> **migration 0060** (`0060_m37_orchestrator_engine`) at integration — the run-tree
> columns, the `requires`/`run.review` CHECK extensions, the
> `persistent`/`addressable_key`/`workspace_mode` columns, and the
> `runs_auto_task_uq` index all ship in 0060. Run
> `node scripts/validate-docs-adr-anchors.mjs` after any further renumber
> (`pnpm validate:docs` does not resolve ADR anchors).

---

### ADR-099: Persistent swarm Layer 2 — addressable sessions, star-routed messaging, worktree modes, per-agent read-only

**Date:** 2026-06-20
**Status:** Accepted — §4's shared writable-worktree GATE superseded by [ADR-102](#adr-102-shared-worktree-tree-level-reviewpromote-ownership)
**Context:** ADR-098 ships the orchestrator foundation (run-tree + delegation +
task-DAG + wait/resume). Layer 2 turns ephemeral child runs into a coordinated,
addressable **swarm**: a child you can re-message over time, inter-agent results
routed through the orchestrator, shared vs own worktrees, and reviewer read-only
roles. Migration 0060 (persistent/addressable_key + workspace_mode).

**Decision:**
1. **Persistent addressable child sessions.** Reuse the scratch-session lifecycle
   (`scratchRuns.acpSessionId`, `classifyScratchRecovery`) so an orchestrator child
   can receive a follow-up message after it parked. Migration 0060 adds a
   `persistent`/`addressable_key` axis on the child run so the orchestrator can
   address it. **Sleep = idle-checkpoint; wake = `session/resume`.**
2. **Re-message tool.** `run_message` (or a `run_delegate` extension) sends a
   follow-up to an existing addressable child by orchestrator-scoped key, via
   supervisor input delivery. Branch on `run_kind`.
3. **Star-routed messaging.** Inter-agent messages go A→orchestrator→B only — **no
   mesh**, no direct child-to-child channel. Every hop is observable on the
   orchestrator node (audit).
4. **Worktree allocation modes.** `workspace_mode: own | shared` on the delegation
   input, snapshotted on the child run. `own` (default) = today's per-run worktree
   from the base branch. `shared` (N children → one pre-allocated tree) is **GATED
   at launch** (`MaisterError("CONFIG")`, Phase 2) pending the shared-tree
   review/promote ownership design (Codex adversarial review): a *reuser* shared
   child has no `workspaces` row, so finalization lands it `Done` not `Review` (an
   unreviewable / strandable diff). The serialized-writer guard (one active writer
   per shared tree, enforced in BOTH `tryStartRun` and `promoteNextPending`) and the
   idempotent shared-allocation path stay in code but dormant for that redesign;
   `own` is unaffected.
5. **Per-agent permissions.** A `workspace: repo_read` child reuses the L1/L2/L3
   read-only enforcement (supervisor `readOnlySession` inline arbitration +
   materialized deny rules + dirty-watchdog quarantine; ADR-041 untouched).
   **Path-scoped write ("tester edits only tests") is INSTRUCTED-only** — expressed as
   a `restrictions` instruction, NOT enforced (maister enforces read-only-vs-full
   only); a `strict` path-scope declaration is refused at launch (`CONFIG`) until the
   deferred policy layer lands.

**Consequences:**
- The orchestrator can run a durable, addressable swarm with auditable star messaging.
- Shared worktrees enable a coordinated team on one tree at the cost of serialized writers.
- Path-scoped write enforcement remains genuinely blocked on the deferred policy layer
  — shipped honestly as instructed-only; do **not** claim enforcement.

**Alternatives Considered:**
- **Mesh (direct A→B) messaging:** rejected — unauditable; star-through-orchestrator
  keeps governance on one node.
- **OS-sandbox `write_paths` for path-scope now:** deferred — couples to a sandbox
  dependency; the policy layer is the chosen home for path-scoped enforcement.

---

### ADR-100: delegated-child Review settle + promote/rework

**Date:** 2026-06-20
**Status:** Accepted
**Context:** ADR-098/096 ship the orchestrator with a child-completion model keyed
on **terminal** statuses only (`run.done/failed/crashed/abandoned` wake the parent
and release `requires` dependents). But a `worktree` child does not run straight to
a terminal — it produces a diff and lands in `Review`, awaiting a promote/rework
decision. With the terminal-only model a parked orchestrator never learns its child
reached `Review`, never promotes it, and (for an as-plan DAG) the dependent stays
blocked forever because the producer task never reaches `Done`. The coordinator
needs (a) a wake signal on `Review`, (b) tools to promote or rework a reviewed
child, and (c) an unattended auto-promote for as-plan DAGs that have no live
coordinator.

**Decision:**
1. **New domain-event kind `run.review`** (migration 0060 extends the
   `domain_events_kind` CHECK to 10 kinds). It is **settled but NOT terminal**
   (`Review → Done` via promote, `Review → Running` via rework). `finalizeAgentRun`
   emits it ONLY for a **delegated** child reaching `Review` (carries
   `parent_run_id`); a top-level Review emits nothing. The exception to the
   "no new kind, widen the payload" rule of ADR-098 is deliberate: `Review` is not a
   run-terminal transition, so it cannot ride a run-terminal payload.
2. **C-2 completion model: a shared `SETTLED_RUN_STATUSES` = terminal + `Review`**
   (`web/lib/runs/run-status-sets.ts`), the single source of truth for the three
   child-pending counters (`runner-graph` `countPendingChildren`, `orchestrator-resume`
   `pendingChildCount`, reconcile `hasPendingChildren`). A parked orchestrator
   COMPLETES once no NON-settled child remains, and is WOKEN on each child
   `run.review` — `orchestrator_resume` now reacts to the SETTLED set, not just
   terminal (a `Failed`/`Crashed`/`Abandoned` child wakes unconditionally; a
   success-side settle — `run.done` OR `run.review` — wakes only once the last
   non-settled sibling clears). Reconcile's grace window keeps the model
   deadlock-free.
3. **Preserve `acp_session_id` on the delegated-Review flip.** A delegated child
   reaching `Review` keeps its session handle (a top-level Review still nulls it),
   so `run_rework` can `session/resume` the same conversation rather than orphan it.
4. **Promote / rework ext routes + MCP tools.**
   `POST /api/v1/ext/runs/promote` (scope **`runs:promote`**, body `{childRunId}`,
   200 `{childRunId, status:"Done", commit?}`) merges a reviewed child → `Done`; a
   merge conflict returns `CONFLICT` (409) and leaves the child in `Review` —
   **never auto-resolved** (§8). `POST /api/v1/ext/runs/rework` (scope
   `runs:delegate`, body `{childRunId, prompt}`, 200 `{childRunId, status:"Running"}`)
   CAS-flips `Review → Running` and resumes with an override prompt. Both require the
   child be a direct child of the bound orchestrator and currently in `Review`. MCP
   tools `run_promote` / `run_rework` (`mcp/src/tools.ts`). New scope `runs:promote`
   added to `ORCHESTRATOR_TOKEN_SCOPES` (`web/lib/agents/tokens.ts`) + `TOKEN_SCOPES`
   (`web/types/token-scopes.ts`); it is held ONLY by the run-bound orchestrator
   token, so a child→child promote is a 403 by scope.
5. **As-plan auto-promote.** The `auto_launch_run_plan` consumer
   (`web/lib/domain-events/auto-launch.ts`) reacts to `run.review` for a
   `launch_mode='auto'` child and auto-promotes it (system actor, `local_merge`) so
   the auto-DAG flows without a live coordinator; the resulting `run.done` re-enters
   the consumer to advance the task + release dependents. A merge conflict leaves the
   child in `Review` (logged). Manual (as-run) children are coordinator-driven via
   `run_promote`, never auto-promoted here.
6. **Workspace axis is an HONORED per-child override.** The delegation `workspace`
   (`none|repo_read|worktree`) was parsed then dropped; it is now threaded through
   the delegate route + the as-plan `delegationSpec` into
   `LaunchAgentRunInput.workspace`, defaulting to the resolved definition's
   recommended workspace when omitted.
7. **No new `MaisterError` code** (ADR-008 closed union). The merge conflict reuses
   `CONFLICT` (HTTP 409); promote/rework preconditions reuse `PRECONDITION` (409).

**Consequences:**
- A delegated `worktree` child's `Review` diff is now actionable by the coordinator
  (collect → promote/rework) and, for as-plan DAGs, advances unattended.
- The completion model can no longer deadlock on a child stuck in `Review`: `Review`
  is a settled state for the parent's completion check while still triggering a wake.
- One new domain-event kind is added — the kind count moves 9 → 10; every
  kind-registration site is updated.
- The auto-launcher's exactly-once `hasAnyRun` check-then-act gains a DB backstop:
  the `runs_auto_task_uq` partial unique index (`runs(task_id) WHERE
  launch_mode='auto'`, migration 0060) makes a concurrent second insert dedup via
  `launchAgentRun`'s `onConflictDoNothing()`, so a released dependent can never
  double-launch even outside the singleton dispatcher.

**Alternatives Considered:**
- **Treat `Review` as terminal for the orchestrator:** rejected — the coordinator
  must still act on the diff (promote/rework), so a settled-not-terminal state is
  the correct shape; collapsing it to terminal loses the rework path.
- **Widen a run-terminal payload instead of a new kind:** rejected — `Review` is not
  a run-terminal transition, so there is no terminal event to ride; a distinct
  `run.review` kind is unavoidable.
- **Coordinator-only promote (no as-plan auto-promote):** rejected — an as-plan DAG
  has no live coordinator parked on it, so its `worktree` children would never leave
  `Review` and the DAG would stall.

> **Numbering note.** Renumbered to **ADR-100** at the merge onto main (see the
> ADR-098 numbering note). The `run.review` kind CHECK and the `runs_auto_task_uq`
> index — authored as standalone branch migrations 0059/0060 — were folded into
> the single consolidated **migration 0060** (`0060_m37_orchestrator_engine`).

---

### ADR-101: Cost-budget governance — budget execution-policy axis, token-metered, warn-escalate-terminate ladder, fail-open

**Date:** 2026-06-22
**Status:** Accepted
**Context:** The execution-control policy (ADR-095), `ralph_loop` auto-relaunch,
and the M37 orchestrator swarm (ADR-098/099/100) let a run drive itself
unattended — but the only spend-shaped bounds are **count** caps
(`MAISTER_RALPH_MAX_ATTEMPTS`, `MAISTER_AUTO_RETRY_MAX_ATTEMPTS`,
`MAISTER_ORCHESTRATOR_MAX_DEPTH/FANOUT`). There is **no token ceiling**: an
`unattended` orchestrator can fan out an as-plan DAG and ralph-loop on crashes
with no spend rail, and `limits.maxCostUsd` is record-only by design. This is the
"генератор счёта" gap.

**Decision:** Add a tenth execution-policy axis **`budget`** (`BudgetAxis = {run?,
task?, tree?}` of `BudgetLimits`) enforcing **token / consecutive-failure /
wall-clock** ceilings at **run / task / tree** scope via a **warn → escalate →
terminate** ladder evaluated each keepalive sweep tick. The meter is **tokens**
(sum of the four `run_cost_rollups` token columns, resume tax included) — **no
USD, no price table**. Enforcement is **opt-in, fail-OPEN**: absent or `0` ⇒
unlimited; `budgetFromSnapshot` resolves a null/absent/malformed snapshot to
all-unset (the deliberate inversion of ADR-095's fail-closed-to-`strict`
resolvers, because "no limit ⇒ don't constrain" and a corrupt snapshot must never
*add* a constraint). There is **no launch refusal** — a convenience
`applyDefaultBudgetForUnattended` may fill `tree.maxTokens` from
`MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS` for an `unattended` launch, never a
`PRECONDITION`. The ladder reuses existing machinery and introduces **no new
`runs.status`**: ESCALATE → `NeedsInput` with a new `hitl_requests.kind =
budget_breach` (mirrors `infra_recovery`), worktree kept, `run.escalated`
(`reason=budget_exceeded`); TERMINATE → `deleteSession` then terminal `Failed`
with a new error code `BUDGET_EXCEEDED`, tree breach via `cascadeAbandonRunTree`.
The breach mechanism **branches on `run_kind`** (flow/agent/scratch) before
routing. Raise-and-resume writes an additive `runs.budget_state.ceilingOverride`
(migration 0061) the watchdog reads ON TOP of the immutable snapshot; idempotency
is `runs.status` (escalate/terminate) + `runs.budget_state.notified[scope]`
(warn-once).

**Consequences:**
- One enforcing spend rail closes the unattended/swarm cost gap; the warn rung
  surfaces the approach ~a tick before the hard kill (≤60s overshoot bound by a
  forced, cursor-throttled `reconcileRunCostRollups`).
- New audit kinds `budget_warned | budget_escalated | budget_terminated |
  budget_raised` on `ExecPolicyActionKind`; new error `BUDGET_EXCEEDED`; new env
  vars `MAISTER_BUDGET_HARD_MULTIPLIER` (default 1.25) +
  `MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS`.
- Migration 0061 adds only `runs.budget_state jsonb` —
  `runs_root_run_id_idx` already exists (M37).
- Tree scope has no escalate rung (a parked `WaitingOnChildren` root has no
  `→ NeedsInput` transition) — a tree breach terminates the tree.

**Alternatives Considered:**
- **Meter in USD with a model-price table:** rejected — prices drift and are
  costly to maintain; tokens are a stable proxy and already on disk.
- **Fail-closed budget resolver (like the safety axes):** rejected — a malformed
  snapshot adding a spend constraint contradicts "no limit ⇒ don't constrain" and
  would change behaviour for existing unbudgeted launches.
- **A new `runs.status` (e.g. `BudgetExceeded`):** rejected — a ~17-site status
  fan-out for no semantic gain; `NeedsInput` + `Failed` already model pause and
  terminal-fail.
- **A `budget_ceiling_override`-only column with audit-row idempotency:** rejected
  — `logExecPolicyAction` is a log boundary, not a queryable table, so warn-once
  needs persisted state; `runs.budget_state` carries both the override and the
  per-scope `notified` rung in one column.
- **Supervisor-side inline per-step enforcement:** rejected — over-built for a
  token ceiling; the ~60s sweep with a warn rung is sufficient.

---

### ADR-102: Shared-worktree tree-level review/promote ownership

**Date:** 2026-06-21
**Status:** Accepted
**Context:** ADR-099 §4 added `workspace_mode: own | shared` on a delegation but
**GATED `shared` for a writable `worktree`** at launch (`MaisterError("CONFIG")`,
Phase 2) because the tree-level review/promote ownership model was unspecified.
The open problem (Codex adversarial review): N children share **one** pre-allocated
worktree = **one** branch = **one** cumulative diff, but only the FIRST ("allocator")
child gets a `workspaces` row; a *reuser* shared child has no row, so with the M34
finalize path it would land `Done` (not `Review`) with an unreviewable / strandable
diff, and per-child review of the same cumulative diff would be wrong. This ADR
specifies that model and **re-enables** shared writable worktrees. It does NOT
re-open the serialized-writer guard (ADR-099 §4), `own` mode, `repo_read`, or the
ADR-041/043 enforcement boundary — those stand. The serialized-writer guard
(`sharedWriterSiblingActive`, one active writer per shared tree, wired into both
`tryStartRun` and `promoteNextPending`) is RETAINED unchanged; this ADR governs
the *review/promote* axis on top of it. **No migration** (reuses
`runs.root_run_id`, `runs.workspace_mode`, `runs.agent_workspace`,
`runs.parent_run_id`, and the allocator's existing `workspaces` row). **No new
`MaisterError` code** (ADR-008 closed union).

**Decision:**
1. **Review granularity is per-tree.** A shared tree is ONE branch with ONE
   cumulative diff → exactly ONE Review and ONE promote for the whole tree. Per-child
   review of the same cumulative diff is rejected as wrong; every shared writable
   child finalizes to `Review` (never straight to `Done`).
2. **Ownership = allocator row + orchestrator-driven tree promote.** The FIRST shared
   child to allocate keeps its existing `workspaces` row (`worktree_path` UNIQUE) as
   the tree handle; reuser children get NO row (accepted). The orchestrator drives a
   single tree-level promote — it alone holds `runs:promote` in
   `ORCHESTRATOR_TOKEN_SCOPES`. Promote resolves the tree workspace by
   `(root_run_id, workspace_mode='shared')`, NOT by the promoting child's own (absent)
   row. No schema change, no migration.
3. **Ordering = wake + promote-time settled re-check (defense in depth).** The existing
   `orchestrator_resume` wake (success-side settle waits for the last non-settled
   sibling) is KEPT, AND a promote-time guard re-checks under lock that NO shared
   sibling (same `root_run_id`) is in a writable status before merging. Reuses
   `SETTLED_RUN_STATUSES` (terminal + `Review`) and the `sharedWriterSiblingActive`
   shape; a still-writable sibling (`Running | NeedsInput | NeedsInputIdle |
   HumanWorking | Pending | WaitingOnChildren`) refuses the promote with
   `PRECONDITION` (409) and merges nothing.
4. **Promotable handle = uniform Review + idempotent tree-promote settling all
   siblings.** `run_promote` on ANY shared child resolves the tree workspace by
   `root_run_id`, merges the tree branch ONCE, and flips ALL shared children of that
   tree `Review → Done` in one transaction. Exactly-once falls out of two mechanisms:
   (a) the M18 durable-claim CAS on the shared `workspaces` row — concurrent promotes
   → one wins, the losers get `CONFLICT` (409); and (b) the `status === 'Review'`
   re-check at promote load — a sequential re-promote finds nothing in `Review` and
   refuses `PRECONDITION` (409), a no-op. The cross-tree `Review → Done` CAS is the
   single settle. Crash window (merge committed, finalize tx not): re-promote is safe
   because `git merge` is idempotent / already-up-to-date and the finalize then flips
   the tree. A tree merge conflict (`local_merge`) returns `CONFLICT` (409), leaves
   ALL shared children in `Review`, flips no sibling (the conflict path runs BEFORE
   the tree-settle flip) — never auto-resolved (§8).

**Consequences:**
- Shared writable worktrees are usable: a coordinated team on one tree produces one
  reviewable diff and one promote, with siblings settled atomically.
- Opening ANY shared child's diff resolves the shared TREE workspace by `root_run_id`
  and shows the one shared diff — never an empty diff or a `PRECONDITION` "workspace
  not found"; this applies to the run-diff route and the review-comments gate-diff
  source.
- Portfolio / board / activity / inbox read-models that `innerJoin workspaces` stay
  as-is: reuser shared children remain absent from those worktree-bearing rows
  (accepted — they are visible through the tree, the run row, and the board task).
- GC must be tree-aware: the shared worktree is NEVER GC-removed while any shared
  sibling (same `root_run_id`) is still non-terminal.
- ADR-099 §4's "GATED / Phase-2" status for shared writable worktrees is superseded;
  ADR-100's promote/rework is extended with the shared-tree variant (single tree
  promote settling all siblings, vs the `own`-mode per-child promote).

**As-built hardening (Codex adversarial-review follow-up):** three fixes landed on
the shared-tree branch, all migration-free and adding NO new `MaisterError` code.
(F1) A `run_rework` on a shared writable child now fences on the tree allocator
`workspaces` row (`promotion_state ∈ {'claiming','done'}` under FOR UPDATE — the same
row the promote claim/finalize locks) and is refused `CONFLICT` while a promote is in
progress / done; this closes the target-mutation-before-fence window (a rework could
previously open during the lockless merge), with the finalize-tx settled re-check kept
as a backstop. (F2) The as-plan AUTO-promoter SKIPS a tree containing a failure-terminal
shared sibling (`FAILURE_TERMINAL_RUN_STATUSES` = `Failed | Crashed | Abandoned` =
TERMINAL minus `Done`), leaving it for human attention so an unattended merge cannot
absorb partial work; a MANUAL `run_promote` stays allowed and the writer-safety
settled-gate (`SETTLED_RUN_STATUSES`, which still counts a failure as settled) is
unchanged. (F3) Shared-tree allocator-vs-reuser is decided from the `workspaces` row
(DB-truth), NOT the filesystem; a crashed allocation (dir on disk, no row) is
orphan-claimed on the next shared launch (insert is `onConflictDoNothing(worktree_path)`,
`base_commit=null`) and recovered by `recoverOrphanSharedTrees` in the reconcile sweep
(synthetic row on the earliest shared child).

**Later-round hardening (Codex adversarial review, migration-free, no new error code):**
(FIX C) The failure-terminal check (F2's twin) is ALSO enforced in the promote CLAIM
tx, before any git side-effect: a NON-human promote (the orchestrator's `run_promote`
AND the as-plan auto-promoter — neither reviews the tree-diff) is refused `PRECONDITION`
when a shared sibling is already in `FAILURE_TERMINAL_RUN_STATUSES`, so the target is
never merged/pushed before the gate (the earlier finalize-tx re-check ran only AFTER the
lockless merge, and the `run_promote` route had no pre-check — so a pre-existing failed
sibling would mutate the target, then abort `CONFLICT`). The finalize re-check stays the
under-lock backstop for a sibling that fails DURING the merge window; a human manual
promote stays allowed (Option B). (F1-twin) The F1 rework fence is extended to OWN
(non-shared) worktree children — `reworkChildRun` locks the child's own `workspaces` row
and refuses `CONFLICT` while `promotion_state ∈ {'claiming','done'}` — and the non-shared
promote CLAIM re-reads `run.status` under that lock; together they close the non-shared
promote-vs-rework lost-update (an unfenced rework that won `Review → Running` in the merge
window was clobbered back to `Done` by the no-status-guard non-shared finalize, both
reporting success). The shared path keeps its first read (the C1 finalize re-check covers
it; re-reading would turn a concurrent-promote loser's `CONFLICT` into `PRECONDITION`).

**Alternatives Considered:**
- **Per-child Review + per-child promote of the shared tree:** rejected — N children
  share one cumulative diff, so N reviews of the same diff is redundant and N promotes
  of one branch race / double-merge; one tree-level Review + promote is correct.
- **A new "tree owner" / allocator schema column (migration):** rejected — the FIRST
  child's `workspaces` row + `(root_run_id, workspace_mode='shared')` resolution is a
  sufficient handle with no migration.
- **A new `MaisterError` code for the settled-gate refusal:** rejected — ADR-008 is a
  closed union; the settled-gate and the "nothing in `Review`" refusals reuse
  `PRECONDITION`, the merge conflict reuses `CONFLICT`.

---

### ADR-103: Output-driven dynamic routing (`decide`) + `on_mismatch` rework + engine 1.7.0

**Date:** 2026-06-22
**Status:** Accepted
**Context:** M26 (ADR-063) shipped P1 — a graph node may emit a schema-validated
structured result into `node_attempts.vars` — but the engine still routes every
non-`human` node on the hardcoded outcome `"success"` (`runner-graph.ts`, the
single outcome site), so a node cannot branch on *its own* output or on a
gate/judge **verdict**. Two consequences fall out: (1) a flow that wants
triage/classification routing must encode it as separate human-decision nodes or
as N parallel flows; and (2) a node whose structured output fails validation
hard-fails the run with `CONFIG` — there is no in-flow "the output was malformed,
try again with the error" loop, even though the rework machinery (feedback via
`commentsVar`, `maxLoops` bound, workspace/session policy) already exists for
human-driven rework. M26 also left **P7** (the `<worktree>/.maister/run.json`
run-context blackboard) **Designed but unbuilt** — `buildRunContext` does not
exist anywhere in `web/`. This ADR adds output/verdict-driven dynamic routing
(P4), an opt-in malformed-output rework loop, and lands P7, reusing the existing
transition + rework + ledger machinery with **no DB migration** and **no new
`MaisterError` code** (ADR-008 closed union — every new refusal reuses `CONFIG`).

**Decision:**
1. **`decide` is a node-level routing table.** A node may declare
   `decide: { from, cases?, default? }`. `from` is either `verdict` (route on the
   node's verdict-producing gate — `ai_judgment | skill_check`) or
   `output.<dot.path>` (route on a nested path into the node's validated
   structured output — M26's `object`-with-`fields` grammar, e.g.
   `output.triage.outcome`). When `node.decide` is present it **replaces** the
   hardcoded `"success"` at the single outcome site; when absent the outcome is
   byte-identical to today (action → `"success"`, `human` → `result.decision`).
   `decide` works on **any** node that declares `output.result`
   (`ai_coding | cli | check | judge`) for `from: output`, or any node with a
   verdict-producing gate for `from: verdict` — NOT judge-only.
2. **`from: output.<path>`** resolves the outcome to the value at the `vars`
   dot-path via a shared safe getter `getPath(obj, dotpath)` (missing →
   `undefined`, never throws), coerced to string for the transition key. A
   missing/`undefined` value yields no transition (terminal/Review), surfaced by
   the runtime allow-list guard, never a thrown getter.
3. **`from: verdict` makes the verdict gate routing-input, engine-owned.** Today a
   blocking verdict gate `markNodeFailed`s + `break`s *before* the outcome site,
   so the verdict never reaches routing. When `node.decide.from === "verdict"` the
   **engine itself** treats that gate as routing-input (not a hard-fail) — **no
   author-declared `mode: advisory` is required** (keeps the YAML clean). The
   gate's **raw parsed** verdict (calibration is bypassed under `decide` — the
   `when` predicates do the thresholding) is surfaced out of gate execution; the
   `decide.cases` are evaluated against the verdict object (`verdict`,
   `confidence`, nested fields via `getPath`): first `when`-matching case wins,
   else the single `default`. `confidence_min` **without** `decide` keeps today's
   blocking behavior; it is also expressible as a 2-case `decide:{from:verdict}`
   (sugar). This is the highest-risk seam and is frozen in the M26 spec.
4. **`when` grammar v1 = one predicate + exactly one `default`.** A case is
   `{ when: "<field> <op> <number>", target }` or `{ default: true, target }`.
   Ops: `>= > <= < == !=`. `<field>` may be a nested dot-path (e.g.
   `verdict.confidence`) resolved by the same `getPath`. AND/OR compound
   predicates are explicit future headroom, not v1. A malformed predicate, a
   `case.outcome` ∉ `transitions` keys, zero or >1 `default`, a malformed
   `from` dot-path, a `from: verdict` node without exactly one verdict-producing
   gate, a `from: output` node without `output.result`, or `on_mismatch` without
   `rework.commentsVar` is refused at compile/load with `CONFIG`.
5. **`on_mismatch` = engine-initiated rework on validation failure.** A node's
   `output.result.on_mismatch` (opt-in; default-absent = today's `CONFIG`-fail)
   drives the **existing rework path from a non-`human` node** when structured-output
   validation fails (`!structuredOutput.ok`), bounded by `rework.maxLoops`, with the
   validation-error text (`structuredOutput.reason`) injected via `commentsVar`. Two
   readable forms — node ids are human-readable slugs (verified, not UUIDs):
   - **`on_mismatch: retry`** — reserved literal = self-target re-run of the same
     node with the error fed back. Requires a `rework` block **with `commentsVar`**
     (the validation error is injected there; the block also carries
     `maxLoops`/workspace/session policy) but does NOT require the node's own id
     in `transitions`/`rework.allowedTargets`. The common case.
   - **`on_mismatch: <outcome>`** — a transition outcome routed via
     `transitions[outcome]` to another node, which MUST be ∈
     `rework.allowedTargets`.
6. **ADR-080 auto-retry is rejected for `on_mismatch`.** `CONFIG ∉
   RETRYABLE_ERROR_CODES` and `scheduleAutoRetry` injects no error feedback. The
   rework machinery (feedback + `maxLoops` + workspace/session policy) is the only
   fit for both the `retry` self-target and the `<outcome>` redirect — a uniform
   path, no `scheduleAutoRetry` change.
7. **Engine `1.6.0 → 1.7.0`.** A manifest declaring `decide` or
   `output.result.on_mismatch` on any node MUST declare `compat.engine_min >=
   1.7.0`; `validateGraphManifest` rejects otherwise (`CONFIG`), mirroring the
   `OUTPUT_ENGINE_MIN` gate. Manifests declaring neither stay valid at their
   pinned floor.
8. **P7 run-context blackboard lands.** `buildRunContext(...)` is a pure
   projection of `node_attempts` + `gate_results` + `task.prompt` (reuses
   `reduceLedger`), `atomicWriteJson`'d to `<worktree>/.maister/run.json` at run
   start and after every `node_attempts` terminal transition, with a
   `[Run context: <abs>]` pointer appended to each agent prompt. `.maister/` is
   git-excluded by extending `WORKTREE_EXCLUDE_PATTERNS` (materialized before the
   first write). Secret-safe (never from `context.env`), idempotent, self-healing —
   run correctness never depends on it (ledger + worktree are the source of truth).

**Consequences:**
- A single node now expresses triage/classification/confidence routing inline;
  the transition fan-out (`resolveTransition`, review-readiness guard, loop-advance,
  `isRework`) is unchanged — it already maps any outcome string → target/terminal.
- Defense in depth on outcome strings: a **runtime allow-list guard** asserts the
  `decide`-chosen outcome ∈ `node.transitions` keys (else `CONFIG`), on top of the
  compile-time check that every *producible* outcome ⊆ transitions keys. `decide`
  introduces arbitrary outcome strings, so the guard prevents a silent dead-end.
- A malformed-output node can self-correct in-flow instead of dead-ending the run,
  but only when the author opts in with `on_mismatch` + a `rework` block; the
  default stays the M26 `CONFIG`-fail.
- **Crash-window parity:** `on_mismatch` reuses the *existing* human-rework write
  sequence (`markNodeReworked` → `markDownstreamStale` → `pendingInjectedVars`),
  which is not a single transaction today and is the established contract. This
  change does NOT refactor it into a transaction (surgical — untouched code,
  separate concern); it introduces **no new partial state** beyond human-triggered
  rework: same writes, same order, run stays `Running`, identical recovery profile.
  A crash between `markNodeReworked` and `markDownstreamStale` leaves the same
  recoverable state as a human rework.
- **Known limitation (tech debt):** `on_mismatch` exhaustion fails the run
  `CONFIG` via the loop-top `maxLoops` backstop, abandoning the worktree's
  accumulated work — unlike `escalateAutoRetryExhaustion` it does not pause
  work-preserving for a human, so the next attempt starts from a fresh worktree.
  Fail-closed is intentional for v1 (unfixable malformed output is an author bug,
  not a stuck review); routing exhaustion through the execution-policy axis
  (escalate/ship) or resuming the failed node from the existing worktree is
  deferred.
- P7 `run.json` is a pure projection — a crash mid-write leaves a stale/absent file
  the next terminal transition regenerates; no two-phase commit (`atomicWriteJson`
  is tmp+rename, so no torn file).
- **No migration, no new env var, no new HTTP route, no SSE/AsyncAPI event, no
  `runs.status`/enum value, no new `MaisterError` code, no `compose.yml` change.**
  Reuses `node_attempts.vars` + the rework machinery; `MAISTER_NODE_OUTPUT_MAX_BYTES`
  already shipped with M26.

**Alternatives Considered:**
- **`route` field name / reuse the flow-level `route_when` hint:** rejected — the
  field is named **`decide`** (a node-level routing table); the flow-level
  `flowMetadataSchema.route_when` NL hint stays runner-ignored and untouched.
- **An explicit author-declared `mode: advisory` to make the verdict gate
  routing-input:** rejected — the engine owns this when `decide:{from:verdict}` is
  present (cleaner YAML; the table owns approve/review/rework).
- **`scheduleAutoRetry` (ADR-080) for malformed output:** rejected — `CONFIG` is not
  retryable and auto-retry injects no error feedback (see Decision §6).
- **AND/OR compound `when` predicates in v1:** rejected — one predicate + one
  `default` covers triage/confidence routing; compound grammar is explicit future
  headroom.
- **A config-driven P7 projection selector:** rejected for v1 — M26's hardcoded
  "all" (intent + every node's vars + every gate result) stands; a selector is a
  later wave.

---

### ADR-104: Global personal API tokens via nullable project token binding

**Date:** 2026-06-23
**Status:** Accepted
**Context:** ADR-046 established project-bound API tokens and `token_audit_log`;
ADR-055 added HITL-over-MCP and token actor gates. That model is sufficient for
project automation, agent launches, and run-scoped MCP tools, but it cannot
support a user's personal agent that needs to see HITL work across all projects
the user can currently access. Creating a parallel token table would duplicate
hashing, prefix lookup, revocation, scopes, and audit attribution. Treating `*`
as permission to answer human gates would also make broad automation tokens
silently become human approvers.

**Decision:** Global personal API tokens reuse `project_tokens`. A global
personal token is `token_kind='user'`, `owner_user_id NOT NULL`, and
`project_id IS NULL`; existing project, project-scoped user, and agent tokens
remain project-bound. Migration `0063` makes `project_tokens.project_id`
nullable, keeps its FK `ON DELETE CASCADE` for project-bound rows, makes
`token_audit_log.project_id` nullable with `ON DELETE SET NULL`, and adds
owner-listing/check constraints for valid token shapes. External routes derive
the target project from URL/server-state, then global personal tokens authorize
the owner explicitly against that project; body-supplied ids never expand
authority. Human-only HITL responses (`human`, `infra_recovery`,
`budget_breach`) require exact `hitl:respond:human` on a global personal token;
`*` does not imply it. Permission/form HITL remains available to tokens holding
`hitl:respond` or `*`. The cross-project HITL inbox uses
`GET /api/v1/ext/hitl`, requires `hitl:inbox:read`, and writes audit rows with
`project_id = NULL`.

**Consequences:**
- One token table remains the operational source of truth: prefix lookup,
  hashing, revocation, expiry, scope storage, owner attribution, and agent-token
  compatibility stay in the existing domain.
- Owner state becomes part of bearer verification for global personal tokens:
  deleted/disabled/password-change-required owners fail closed even if the
  token row is otherwise active.
- Audit rows can represent both project-targeted calls and cross-project
  personal inbox reads. Target project deletion preserves direct audit lineage
  by setting `token_audit_log.project_id = NULL`; deleting a token still drops
  its audit rows.
- The `/account` UX owns global personal tokens. Project Integrations remains
  project-bound and may link to `/account`, but it must not create or list
  global tokens.
- The MCP facade keeps `MAISTER_PROJECT_TOKEN` first for compatibility and adds
  `MAISTER_ACCESS_TOKEN` as the personal-token fallback.

**Alternatives Considered:**
- **New `user_access_tokens` table:** rejected because it duplicates token
  issuance, prefix/hash verification, expiry, revocation, scope enforcement,
  and audit joins while adding no required isolation boundary.
- **Make project-scoped user tokens multi-project:** rejected because a
  non-null `project_id` currently means an exact project binding throughout
  ext-route authorization and audit semantics.
- **Let `*` imply human HITL approval:** rejected because it would turn broad
  automation tokens into human approvers without an explicit grant.
- **Skip nullable `token_audit_log.project_id`:** rejected because
  cross-project inbox reads have no single target project and target-project
  hard-delete should not erase the existence of an identified external call.

### ADR-105: First-class authored package kinds and centralized Studio package model

**Date:** 2026-06-22
**Status:** Accepted
**Context:** M36 (ADR-096/097) shipped editable local packages — create/fork, edit
flows/agents/skills/rules/MCP/schemas, file CRUD, git diff/commit/discard,
cut-version→attach, a docked AI assistant, and the `/studio/{local,edit}` routes
under a session lock. Dogfooding surfaced the authoring gaps this change closes:
(1) the editor lands on an empty flow canvas with a spurious "YAML is invalid"
banner when no flow file is selected, is stuck read-only (`heldByMe` hardcoded
false), and has no real "End edit"; (2) `maister-package.yaml` has no form
(classified `asset`); (3) the four authorable kinds are not all first-class —
Claude **subagents** (`capability/<id>/agents/`) and platform **agents**
(package-root) are conflated by the path classifier, and there is no per-kind
create wizard; (4) `forkPackageToLocal` always INSERTs (fork spam, no dedup);
(5) commit is buried in the diff drawer with no validation; (6) the
platform-agent directory diverges — the Studio viewer/BOM read package-root
`maister-agents/<stem>.md` while the M34 catalog/registry (ADR-089) read
`agents/<stem>.md`, a split [agents.md](system-analytics/agents.md) flagged as a
Phase-2 non-goal. This ADR also locks the **package ownership model** after
several rounds: project-scoping was evaluated and **rejected**; M36's
platform-scoping (ADR-096/097) **stands**.

This is **Stream A** of the M39 "Flow Studio package authoring" work (the
editor/kinds half) — **web-only, NO migration**. The package-based platform-agent
half (ADR-106, migration 0068) landed alongside it; version-adopt launch +
PR-to-source (ADR-107) remains a separate, unbuilt branch.

**Decision:**
1. **Centralized packages + per-project version pins.** Packages are
   instance-level and Studio-edited (serialized by the M36 session lock); a
   project consumes a package at a **cut version** (a pin). Editing in Studio
   produces new cuts; at launch a project adopts a newer cut or keeps its pin (the
   adopt path is Stream B). Cross-project divergence is rare and explicit:
   **"Customize for this project"** forks the whole package into a labeled copy
   (auto-named `P (for <project>)`, editable — a name convention, **NO schema
   field**), attached and PR'd independently. No auto-merge, ever.
2. **Two new first-class authored file kinds — `manifest` and `subagent`** — added
   to `AuthoredFlowPackageFileKind` (an 8-site union fan-out). `maister-package.yaml`
   gets a `PackageManifestForm` (+ raw-YAML toggle; strict parse → `CONFIG`).
   Claude subagents become a distinct kind from platform agents: the path
   classifier splits `capability/<id>/agents/` → `subagent` (**lenient + open**
   frontmatter — the known Claude-Code fields `name`/`description`/`tools`/`model`/
   `color` typed AND unknown/custom keys preserved as passthrough; New-template
   `model: inherit`, `tools` omitted) from package-root → platform
   `agent_definition` (the existing strict schema, unknown → `CONFIG`). Subagents
   materialize into the run's `.claude/agents/` (M34, unchanged) and are EXCLUDED
   from the `/agents` catalog projection.
3. **`maister-agents/` is the canonical platform-agent directory.** The M34
   catalog / registry / effective-definition read paths move from `agents/<stem>.md`
   to package-root `maister-agents/<stem>.md`, converging with the Studio
   viewer/BOM/attach (which already read `maister-agents/`) — closing the split
   agents.md deferred to Phase 2. Subagents keep `capability/<id>/agents/`
   (path-distinguishable by depth).
4. **Commit is the validation gate.** A prominent top-bar "Commit state" action +
   dirty indicator; ALL commit entry points route through
   `validatePackageArtifacts`, which validates the **changed** artifacts in the
   commit — already-committed artifacts are assumed valid — covering flow.yaml
   parse+compile, manifest parse, platform-agent strict frontmatter, subagent
   lenient frontmatter, and skill `SKILL.md` presence, and **hard-blocks** the
   commit on any invalid artifact (`PRECONDITION`/`CONFIG`, error list). Since a
   launch needs a committed state, an invalid artifact is inherently
   un-launchable; WIP lives in the uncommitted, lock-preserved working dir. A
   shared `ChangeReviewDialog` (diff + editable, prefilled commit message) is
   introduced here and reused by Stream B for the PR flow.
5. **Fork dedup.** `forkPackageToLocal` checks for an existing fork by
   `source_install_id` and returns `{ localPackageId, alreadyExists: true }` (HTTP
   200) instead of a duplicate INSERT (201 for a fresh fork); the element fork
   stays idempotent on the project default. "Customize for this project" reuses
   this dedup path so a project's copy is not duplicated.

**Consequences:**
- The editor opens on a **package-home** landing (overview + manifest form + file
  tree) when no flow file is selected — eliminating the empty-canvas /
  invalid-YAML banner and the rework-empty symptom — with a real End-edit (lock
  release + navigate) and a correct initial `heldByMe`.
- All four authorable kinds (flows / platform agents / subagents / skills) get a
  per-kind form editor + raw view + a create wizard, even when the kind dir is
  empty.
- Changing the canonical platform-agent dir to `maister-agents/` is a breaking
  change for any installed package that ships platform agents at
  `agents/<stem>.md`; authors must use `maister-agents/`. Accepted (owner) for the
  disambiguation from subagents' `capability/<id>/agents/`.
- NO migration, NO new `MaisterError` code (reuses the ADR-008 closed union
  `PRECONDITION | CONFLICT | CONFIG`), NO `authored_capabilities` enum change
  (subagents stay file-based, Variant B). RBAC stays the M36 model (Studio-member
  authoring; project-member attach).

**Alternatives Considered:**
- **Project-scoped (project-owned) packages:** rejected — per-project editing
  fights reuse and creates cross-project merge conflicts; central editing +
  per-project version pins is both manageable and reuse-friendly (M36 ADR-096/097
  stands).
- **Canonical `agents/` (align Studio down to the M34 runtime):** rejected by the
  owner in favor of `maister-agents/` — the louder disambiguation from subagents
  is worth changing the (merged) runtime read paths.
- **"Commit anyway (WIP)" override on invalid artifacts:** rejected — it would let
  an invalid artifact become a cut → un-launchable version, defeating the gate;
  WIP already survives in the uncommitted working dir.
- **A schema field for the "Customize for project" copy:** rejected — a name
  convention keeps Stream A web-only (no migration); the copy is just another
  instance-level local package.

**Numbering note.** ADR-103 (flow-routing, M38) is merged; ADR-104 (G4
guardrail-hooks) is reserved by an implemented-but-unmerged sibling
(`.ai-factory/requests/2026-06-22-g4-guardrail-hooks.md`). This ADR takes **105**
to avoid squatting 104; a renumber pass may run at merge if the ordering changes.

### ADR-106: Package-based platform agents — package identity, attachment gating, optional-flow enrichment, and per-agent runner policy

**Date:** 2026-06-23
**Status:** Accepted
**Context:** M34 (ADR-089/090) shipped platform agents keyed PER FLOW: the catalog
row's provenance is `agents.flow_ref_id`, the id is `<flowRefId>:<stem>`, and
registration (`registerAgentsForRevision`) scans
`flow_revisions.installed_path/maister-agents/*.md` once per flow revision. M39
Stream A (ADR-105) made `maister-agents/` the canonical platform-agent directory
at the PACKAGE ROOT — but a package install is one `package_installs` row that
fans out to MANY member flow revisions, and `flow_revisions.installed_path` is a
PER-FLOW cache subdir (`~/.maister/flows/<flowRefId>@<sha>/`), whereas the package
root that actually holds `maister-agents/` is `package_installs.installed_path`
(`~/.maister/packages/<name>@<rev>/`). So today a package-root
`maister-agents/<stem>.md` is registered only for a member flow whose manifest
`path` is `"."`, and identity is per-flow even though the file is package-scoped.
This is the F4 finding from this branch's Codex adversarial review. Separately,
agent runs never snapshot an execution policy (`launchAgentRun` omits
`execution_policy`/`budget_state`), so every agent run inherits the
`{preset:"supervised"}` column default and an unbounded budget; the budget
terminal path (`keepalive-sweeper.ts`) force-terminates every non-flow breach and
resumes only via `runFlow` (flow-only). This ADR re-keys agent identity to the
package, re-frames the launch gate as an attachment allow-list, adds optional
same-package flow enrichment, and adds a per-agent runner policy (auto-apply +
budget-breach handling) that rides the existing `ExecutionPolicy` snapshot.

**Decision:**

1. **Package identity.** A platform agent is `maister-agents/<stem>.md` at the
   PACKAGE ROOT; its platform id is `<packageName>:<stem>` where `packageName =
   package_installs.name` (the `maister-package.yaml` `name`, capabilityRefId-
   shaped). `agents.flow_ref_id` is replaced by `agents.package_name` (text NOT
   NULL); the index `agents_flow_ref_idx` becomes `agents_package_name_idx`. The
   `AGENT_ID_PATTERN` `<x>:<stem>` grammar is unchanged; `qualifyAgentId` /
   `splitQualifiedAgentId` re-key their prefix from flowRefId to packageName.

2. **Package-level registration.** Registration projects ONE catalog row per
   package per `maister-agents/<stem>.md`, scanning
   `package_installs.installed_path/maister-agents/*.md` (the package root, NOT a
   flow revision's per-flow dir). The per-flow `registerAgentsForRevision` call in
   `lib/flows.ts` is dropped; package-level registration is wired into
   `installPackageRevision` (`lib/packages/attach.ts`) AFTER the member flow
   installs. `resyncAgents` projects the NEWEST Installed `package_installs` per
   `name`; a `.md` (or its providing package) that vanished disables — never
   deletes — its row. SET/CLEAR column symmetry on every sync. Registration NEVER
   executes `.md` content.

3. **Optional same-package flow.** An agent MAY declare `flow: <flowId>` in its
   frontmatter; the value MUST be a member of the providing package's manifest
   (`package_installs.manifest.spec.flows[].id`) or the definition is reported
   invalid and never written (a later upgrade that REMOVES the referenced flow
   re-flags it on resync → launch refuses `PRECONDITION`). Stored as
   `agents.flow_ref` (text, nullable).

4. **Launch gate = attachment allow-list.** A package agent launches when, and
   only when: (a) the providing package is ATTACHED to the project
   (`project_package_attachments` row for `(projectId, packageName)` — the
   attachment IS the enable; packages have no flow-style `enablementState`); (b)
   the attached install is TRUSTED (`package_installs.trust_status ∈ {trusted,
   trusted_by_policy}`); (c) the agent is ENABLED (`agent_project_links.enabled`
   for the project AND catalog `agents.enabled`, and `agents.quarantined_at IS
   NULL`). The gate is an allow-list — any state not on it is refused
   `PRECONDITION` by default. The EFFECTIVE definition resolves through the
   attached install's pinned revision →
   `package_installs.installed_path/maister-agents/<stem>.md`, at launch (guards)
   and again at spawn (prompt). `projectId` is server-derived, never body.

5. **Optional-flow enrichment — `run_kind` by discriminant.** Launch branches on
   has-flow BEFORE routing:
   - **WITHOUT `flow_ref` → `run_kind='agent'`** — the existing standalone
     ACP-session path (workspace axis `none|repo_read|worktree`, agent token,
     agent pool `MAISTER_MAX_CONCURRENT_AGENTS`).
   - **WITH `flow_ref` → `run_kind='flow'`** — the agent's same-package flow is
     launched as a normal flow run (flow pool, worktree, the flow engine drives
     nodes/gates/rework/promotion), carrying `runs.agent_id` (the persona + policy
     source) + `flowId`. On EVERY `ai_coding` node the agent's `.md` body is
     injected as the persona/system layer — AUGMENT, not replace: the node keeps
     its own task prompt, order persona-then-task — reusing the `mode=session`
     flow-binding injection across all nodes. Budget escalate + raise-resume,
     gates, promotion, and human-node auto-pass are inherited with no new engine
     code. The workspace axis `none|repo_read` is meaningful only for the
     read-only standalone kind; a flow-driving agent is a worktree run by
     construction.

6. **Per-agent runner policy on the existing `ExecutionPolicy` snapshot.** The
   agent definition carries `recommended.executionPolicy: { autoApply?,
   onBudgetBreach? }`, a simplified projection over the rich `ExecutionPolicy`
   (preset + axes, ADR-095/101) snapshotted onto `runs.execution_policy` at spawn:
   - **`autoApply: 'off' | 'permissions' | 'full'`** maps to axes B1 `permissions`
     + B2 `humanGate`: `off`→`{permissions:'ask', humanGate:'stop'}`;
     `permissions`→`{permissions:'auto_approve', humanGate:'stop'}` (the "с чел"
     variant — auto-approve ACP tool permissions, but `human`/`form` still pause);
     `full`→`{permissions:'auto_approve', humanGate:'auto_pass'}` (the "без чел"
     variant). At the HITL boundary the run reads `permissionsFromSnapshot` /
     `humanGateFromSnapshot`; `form` and `infra_recovery` HITL ALWAYS pause
     regardless of mode; `budget_breach` is never auto-applied (the budget axis
     owns it). Future per-kind toggles are a non-breaking superset of this enum.
   - **`onBudgetBreach: 'escalate' | 'terminate' | 'terminate_restorable'`** is a
     NEW optional `ExecutionPolicy` axis read by the budget terminal path
     (`keepalive-sweeper.ts`). UNSET preserves the existing run_kind-based default
     (flow non-tree scope → escalate; otherwise terminate). Set: `escalate` = live
     pause + `budget_breach` HITL, run stays live and HOLDS its slot (raise-resume
     via `runFlow` for `run_kind='flow'`, via `session/resume` for
     `run_kind='agent'`); `terminate` = `Failed`, non-recoverable;
     `terminate_restorable` (NEW, the owner's "no-escalate") = in ONE transaction
     checkpoint the session (keep `acp_session_id`), free the slot
     (`promoteNextPending`), transition to the EXISTING recoverable
     `NeedsInputIdle`, record a `budget_breach` HITL — restore = raise the budget +
     `session/resume`. No new run status (reuses `NeedsInputIdle`).

7. **Config home + per-instance override.** `recommended` SEEDS the defaults
   (`runner`, `branch_base`, `executionPolicy.{autoApply,onBudgetBreach}`); the
   per-project agent INSTANCE (`agent_project_links`) overrides EVERY field via new
   nullable columns `branch_base` (text) and `execution_policy_override` (jsonb).
   Effective resolution = instance override → agent `recommended` → project/
   platform default, snapshotted onto the run (`runs.execution_policy` + runner
   snapshot + branch base) at launch — the terminal path reads the snapshot, never
   a post-launch projection.

8. **Branch base.** Optional `recommended.branch_base` (text, defaulting to the
   project's main branch), overridable on the instance
   (`agent_project_links.branch_base`). Stored as `agents.branch_base` (nullable).
   The workspace axis (`none|repo_read|worktree`) + `workspace_ref` are unchanged.

9. **Trigger toggle coupled to enable.** Disabling an agent's project link disables
   its `agent_schedules` rows (`enabled=false`) AND revokes live agent tokens, in
   addition to failing the launch gate (today disabling only fails the gate;
   schedules keep firing-then-refusing and burning their cron catch-up window each
   tick). Enabling re-enables the schedules — it does NOT resurrect the revoked
   ephemeral per-launch tokens.

10. **Migration data policy.** Pre-release: migration 0068 runs `DELETE FROM
    agents` then re-projects via `resyncAgents`. The FK fan-out is verified:
    `agent_project_links` and `agent_schedules` CASCADE-delete; `runs.agent_id` is
    `ON DELETE SET NULL`, so run history survives as NULL. A post-migration resync
    trigger (the startup reconcile path + the existing admin
    `POST /api/admin/agents/resync`) re-projects from installed packages so the
    catalog is not empty until the next package install.

**Consequences:**
- The package-root `maister-agents/<stem>.md` is registered exactly once per
  package (the F4 split closes); a multi-flow package no longer mis-registers or
  drops its package-scoped agents.
- The launch gate is a clean three-term allow-list (attached + trusted + enabled)
  replacing the per-flow `enablementState` chain; "attached IS enabled" removes a
  state machine.
- A coding agent and its flow are one reusable unit: the with-flow run is a full
  flow run, inheriting budget/gates/promotion/human-gate machinery with no new
  engine code.
- `onBudgetBreach` becomes a first-class `ExecutionPolicy` axis affecting all runs;
  its UNSET default preserves today's flow behavior, so flow runs are unchanged
  unless they opt in.
- `terminate_restorable` gives agents (and flows) a recoverable, slot-freeing
  budget terminal without a new run status; standalone-agent `escalate` resumes via
  `session/resume` (a new non-flow branch in the raise path).
- Migration 0068 is destructive to the `agents` catalog only; attachments/schedules
  cascade and re-project, run history is preserved via SET NULL.
- NO new `MaisterError` code (reuses `PRECONDITION | CONFLICT | CONFIG`). EN+RU
  i18n for the new project-settings Agents surface.

**Alternatives Considered:**
- **Keep per-flow agent identity (`flow_ref_id`):** rejected — the canonical file
  is package-root (ADR-105); per-flow keying mis-registers package-scoped agents
  (the F4 bug) and makes "this agent belongs to package P" un-expressible.
- **`run_kind='agent'` executes the flow graph:** rejected — either the
  orchestrator-via-MCP model (ADR-098; an agent calling delegation tools, not
  per-node persona augmentation) or relabeling a flow run as `agent`, forcing the
  flow engine to special-case `run_kind` for budget/resume/reconcile/promotion.
  Both are more code for less reuse than launching the flow as a flow run with the
  agent as trigger+persona+policy.
- **A brand-new agent-policy table/column set instead of riding `ExecutionPolicy`:**
  rejected — `runs.execution_policy` already snapshots permission/human-gate
  autonomy + the budget axis with fail-closed resolvers; `autoApply` /
  `onBudgetBreach` are a thin projection over it, so the terminal/HITL paths reuse
  the existing `*FromSnapshot` readers.
- **A new run status for the no-escalate budget terminal:** rejected — a new status
  fans out to every run consumer; `NeedsInputIdle` is already the recoverable,
  slot-freed checkpoint state and fits exactly.

**Numbering note.** ADR-103 (flow-routing, M38) is merged; ADR-104 (G4
guardrail-hooks) is reserved by an implemented-but-unmerged sibling; ADR-105 (M39
Stream A) is this branch. This ADR is **106**. The package-agents re-key migration
landed as `0068` (the `0062` slot that the ADR-105 note originally reserved was
taken by an unrelated migration; the ADR number stays 106).

### ADR-107: Version-adopt launch — adopt a newer central package cut at launch

**Date:** 2026-06-25
**Status:** Accepted
**Context:** ADR-105 locked the **centralized package model**: packages are
instance-level and Studio-edited, and a project consumes a package at an immutable
**cut version** (a per-project pin), never a live edit. ADR-105/106 built the
authoring + agent halves but left the *consumption* side unbuilt — a project
attaches a cut, but there is no path to pick up a **newer** cut, and no link from
the attached `package_installs` row back to the `local_packages` package + commit
it was cut from (only the forward `local_packages.last_cut_install_id` exists). A
`/aif-improve` trace of current main fixed the runtime model: flow runs are
**task-bound** (`POST /api/runs` needs a `taskId`); materialization is
**project-scoped** (`materializeProjectBundlesIntoWorktree` copies the project's
attached `Installed` revisions), so adopting a newer version = advancing the
project's attached revision, then normal materialization runs — no run-scoped
override; and `runs.local_package_id` is **hard-blocked for non-scratch runs**
(`run-kind-invariants.ts`), so provenance must live on the cut install, not on
`runs`. This is **Stream B** of M39 (the runtime half).

**Decision:**
1. **Source link on the cut.** `package_installs` gains `source_local_package_id`
   (FK → `local_packages`, `ON DELETE SET NULL`) + `source_commit_sha`, written when
   a local package is cut (the Studio `cut-version` path threads its
   `local_packages.id` + working-dir HEAD sha into `installPackageRevision`).
   `local_packages.last_cut_install_id` remains the package's newest cut.
   (Migration **0074**, shared with ADR-113.)
2. **Attach = pin a version.** A project attaches package P at a chosen cut (the
   existing `attachPackage`); the attached member flow's `enabled_revision_id`
   points at that cut's revision. Cross-project reuse = attach a chosen cut to any
   project; the Stream-A "Customize for this project" copy attaches the same way.
3. **Launch-time adopt.** In the existing `launchRunStaged` precondition chain —
   after the flow row loads, before the enablement check reads its
   `enabled_revision_id` — detect, for each package P backing the task's flow,
   whether (a) P has a **newer cut** than the pin (`P.last_cut_install_id` ≠ the
   attached install) and/or (b) P has **uncut Studio edits** (working dir dirty vs
   the pinned cut's `source_commit_sha`). The launch prompt offers, per backing
   package, one of **`keep` | `adopt` | `cut_and_adopt`**:
   - `adopt` → advance the project's attachment to P's newest cut via the existing
     `upgradeAttachment` (re-wires members, advances `enabled_revision_id`), then
     **re-read the flow** and launch.
   - `cut_and_adopt` → run the Studio cut gate first (assert the package's
     edit-lock is free + `validatePackageArtifacts` → `installPackageRevision`
     [with the source link] → `stampLastCutInstall`), then `upgradeAttachment` to
     the fresh cut and launch. Locked-by-another-session or invalid artifacts →
     `PRECONDITION` (the user can still `keep`).
   - `keep` → launch on the pin (no-op).
4. **Contract.** `POST /api/runs` gains `packageVersions` (map
   `packageInstallId → keep|adopt|cut_and_adopt`), **server-constrained** to the
   detected available-version set — an unknown or ineligible key is a 409. The
   advance runs as its own transaction(s) **before** the run-insert transaction; the
   run row's `flowRevisionId` then resolves to the adopted cut. Flow runs keep
   `runs.local_package_id` **NULL**.
5. **Provenance is derivable.**
   `run.flowRevisionId → package_installs.(source_local_package_id, source_commit_sha)`
   answers "which package @ which commit this run used", reproducibly. No `runs`
   column.

**Consequences:**
- Reuses `launchRunStaged` + the scheduler + ~20 preconditions + `upgradeAttachment`
  + the Studio cut gate. B1 adds only the source link, the version-availability
  check (`web/lib/local-packages/versions.ts`), the adopt precondition + body field,
  and the advance step.
- Adopt-at-launch is one logical decision per package, each its own tx before the
  run insert. **Adopt+launch is atomic by compensation:** the supervisor's
  readiness is gated BEFORE the advance (the dominant transient failure), and an
  outer compensation `try` spans the WHOLE post-advance remainder of
  `launchRunStaged` — so ANY failure after the advance re-pins the attachment to
  its prior install (`revertPackageVersionChoices`): the dropped-flow refusal (the
  adopted cut no longer ships the launched flow), a later precondition
  (incompatible / un-enabled / bad target branch / missing host requirement), the
  `addWorktree` step, materialization, and the run-insert tx all roll the pin back.
  A multi-package adopt is likewise all-or-nothing — `applyPackageVersionChoices`
  reverts any attachment it already advanced before rethrowing, so one package's
  later failure never leaves an earlier package's pin moved.
  **Residual (accepted):** a process crash between the advance and the run-insert
  is recoverable, not corrupting — the next launch sees no newer version (already
  adopted) and runs it. (An ACP-cancel routes through the compensation via the
  abort signal; a generator abandoned WITHOUT signalling abort is the only
  uncompensated edge, and the SSE launch path wires the signal.) The run-insert tx
  is unchanged (`(agent_id, trigger_event_id)` dedup; a board launch carries no
  trigger and never conflicts).
- A project never sees working-dir drift — only immutable cuts. `cut_and_adopt`
  is the only launch path that mints a cut, and it does so through the Studio gate
  (lock + validate), never by editing.
- Migration **0074** (the source-link cols, shared with ADR-113's PR cols). NO new
  `MaisterError` code (reuses the closed union `PRECONDITION | CONFLICT | CONFIG`).
  NO `runs` column.

**Alternatives Considered:**
- **Project-side "Update available → Update" button** (advance the pin outside
  launch): rejected for v1 (owner) — the pin advances only via the
  adopt/keep/cut_and_adopt choice at launch, keeping a single decision surface.
- **Cut-first only** (no uncut edits at launch): rejected (owner) — `cut_and_adopt`
  lets uncut Studio edits be picked up at launch without a separate Studio
  round-trip.
- **Run-scoped materialization overlay / binding `runs.local_package_id` on a flow
  run:** rejected — flow runs are task-bound and materialization is project-scoped;
  the invariant hard-blocks it. Advancing the project attachment is the existing
  lever.
- **A denormalized `runs` provenance column:** deferred — derivable via
  `flowRevisionId → install`.

**Numbering note.** This ADR fills the reserved **107** gap (108 guardrail-hooks /
109 consensus took the slots after ADR-106). The PR-to-source half is **ADR-113**
(110–112 were taken by the AI-assistant / agent-config / triager siblings that
merged to main first). The shared source-link + PR migration is **0074** and the
publish mutex is **0075**, both following `0073_task_launch_armed_at` (renumbered
from 0071/0072 when this branch rebased onto main).

---

### ADR-108: Declarative guardrail/hook engine — universal supervisor ACP-seam interceptor, native materializer seam, and hook-trip HITL escalation

**Date:** 2026-06-23
**Status:** Accepted
**Context:** MAIster's two existing safety primitives act at the wrong granularity for an unattended loop: Flow **gates** evaluate *after* a node finishes, and the ADR-101 budget meters *totals* (tokens / failures / wall-clock). Neither can stop a run that, mid-node, repeats the same tool call forever, writes outside its lane, or stalls without producing a diff. The one place a decision can be made *before* a tool executes is the supervisor's ACP `requestPermission` callback in `acp-client.ts`, which already does hardcoded pre-hoc enforcement: ADR-090 `readOnlySession` (L1, allow-set `{read, search, fetch, think}`) and ADR-078 `readOnlyTurn` (L2, mutating-set `{edit, write, create, delete, move}`) both run and resolve *before* the SDK runs the tool (the callback `await`s the decision). `readOnlySession` is a hardcoded special case of a more general idea: a declarative, vendor-neutral rule set evaluated at that seam. This ADR generalizes it into a **guardrail/hook engine** — the per-tool-call enforcement primitive that makes unattended overnight loops safe. A Phase-0 spike corrected the original "the file path is in an opaque, adapter-specific toolCall body" assumption: the ACP SDK standardizes the write path at `toolCall.locations[].path` (verified in `@agentclientprotocol/claude-agent-acp`; schema-backed for `codex-acp`), so path extraction is adapter-agnostic with a kind-only fallback for adapters that do not populate `locations`.

**Decision:**
1. **Universal mechanism first, claude-native particular second — both in this milestone (M40).** The supervisor ACP-seam interceptor is the universal, vendor-neutral mechanism (all 5 adapter families, all 3 rules, complete on its own). No universal native-hook file exists across agents, so "native" is a per-adapter particular delivered through a clean `NativeHookMaterializer` seam: the seam interface ships with the universal core; the claude `PreToolUse` implementation ships after the core is proven, spike-gated (see §9).
2. **The seam is `requestPermission` in `acp-client.ts`, after L1 (`readOnlySession`) / L2 (`readOnlyTurn`) and BEFORE B1 (`autoApprovePermissions`) + the HITL-deferred path.** The interceptor is pre-hoc for the two `pre_tool_call` rules (the callback `await`s; the SDK does not run the tool until it resolves) and post-hoc for the one `post_turn` rule (driven from `sessionUpdate`, which fires after a tool already ran). The before-B1 ordering (amended in Phase 2, 2026-06-23; the freeze said after-B1) is required: B1 returns inline on any allow-shaped option, and every `unattended` preset resolves to `permissions=auto_approve`, so after-B1 placement would silently no-op `path_guard` + `repetition` on the exact runs the two-tier default arms guardrails for (`repetition` would be dead code). Guardrails are deny/halt layers like L1/L2 and precede the B1 approve layer.
3. **Exactly three MVP rules.** (a) **path_guard** — a write-class tool call whose `toolCall.locations[].path` falls outside the resolved `allowedPaths` (or a write-kind with no extractable path under the kind-only fallback) is **denied and the run continues** (deny-and-continue; the agent adapts). (b) **repetition** — a per-session signature (tool kind + normalized args) that recurs `>= max` times **halts**. (c) **no_progress** — `>= maxTurns` `sessionUpdate` turns since the last edit/diff-producing tool call **halts**. Secret-scan and other rules are explicit fast-follow.
4. **Path extraction is adapter-agnostic** via the standardized ACP `toolCall.locations[].path`, with a kind-only coarse fallback for adapters/shapes that do not populate it (the 3 smoke-gated families gemini / opencode / mimo emit no live evidence of `locations`). The owner's all-5-adapter coverage is preserved; the spike removed the need for per-adapter body parsers.
5. **Trip dispatch is event-driven; the state transition is web-owned (D1).** The supervisor emits `session.hook_trip { rule, lifecycle, disposition: "deny" | "halt", toolCall? }`. `deny` (path_guard) returns the reject/cancel option inline — no web round-trip. `halt` (repetition / no_progress) returns cancelled, stops issuing work, and the **web** consumer performs checkpoint + escalate (the runner owns `NeedsInput`; the supervisor never self-kills).
6. **Escalate branches on `run_kind` BEFORE routing (D2), honors `onStuck`, and reuses each kind's existing resume path.** flow + agent → checkpoint + `NeedsInput` + a `hook_trip` HITL, resumable (flow → `runFlow`; agent → the agent permission-HITL resume that already drives agent runs); scratch → in-session deny + chat notice, no `NeedsInput`. `onStuck = escalate | ship_with_warning` → assigned HITL; `notify_only` → unassigned. This mirrors the ADR-101 budget `actBudgetEscalate` one-transaction pattern but is **not** flow-only — the budget's flow-only limitation is an artifact of its `raise → runFlow` path, which a hook-trip resume does not use.
7. **`hook_trip` is a dedicated HITL kind** (and `assignments.action_kind`), added by **migration 0066** — the one schema change. Follows the `budget_breach` precedent (one kind per escalation cause; `budget_breach` is already in both enums).
8. **Two-tier default (D4).** Under the `unattended` execution-policy preset, and only when the node did not opt out, the two liveness breakers auto-arm with `MAISTER_HOOK_REPETITION_MAX` (default **5**) and `MAISTER_HOOK_NO_PROGRESS_TURNS` (default **15**). `supervised` / `assisted` are opt-in; `path_guard` is always opt-in (it needs an explicit writable set). An absent execution-policy snapshot is treated as non-unattended (fail-safe to opt-in).
9. **`hooksConfig` is the resolved, materialized rule set, delivered via `StartSessionRequest` beside `readOnlySession` (D3).** `readOnlySession` is left intact and documented as a stricter special case of the same seam; the two compose (both pre-hoc denies; `readOnlySession` is the stricter superset). The `NativeHookMaterializer` registry resolves an adapter → materializer; the universal core registers a no-op, and the claude `PreToolUse` path-guard materializer (writing a `hooks` key into the M14-owned `.claude/settings.local.json`, respecting the ownership-marker / reclaim / cleanup protocol) registers **only after a spike confirms the bundled `@anthropic-ai/claude-agent-sdk` honors settings-file hooks**. If it does not, the native backend is documented N/A and the universal supervisor layer carries enforcement — no dead code. Native covers **only** path_guard (rule 2); rules 1 & 3 are supervisor-only (they need cross-turn session state). The native hook's `allowedPaths` derive from the SAME resolved `hooksConfig.pathGuard` (one source of truth — the two backends cannot diverge).
10. **No new `MaisterError` code; `hooks` enforceability is `instructed`.** A trip is recoverable (`NeedsInput`), never a `Failed`-terminate, so no new code is warranted (ADR-008 closed union; reuses `CONFIG` for an invalid hooks block at compile/load). `hooks` is `instructed` for every agent in `ENFORCEABILITY_BY_AGENT`; a `strict` hooks declaration is refused at launch by the existing M11c boundary. Supervisor enforcement is deterministic but is **not** modeled as `enforced` in the static table — the ADR-041 strict-capability flip stays frozen. Engine `1.7.0 → 1.8.0`; a node/agent declaring `hooks` requires `compat.engine_min >= 1.8.0` (`HOOKS_ENGINE_MIN`).

**Consequences:**
- MAIster gains the per-tool-call enforcement primitive that gates (post-node) and the budget (totals) structurally cannot provide — the safety floor for unattended autonomy.
- Counters (`lastToolCallSig`, `repeatCount`, `turnsSinceProgress`) live on the in-memory `SessionRecord` only. A supervisor crash loses them; the run reconciles to `Crashed` via the existing sweep. A resumed run starts its counts fresh (documented; a resume resets the liveness breakers).
- **Crash windows** reuse the budget escalate analysis: checkpoint pre-tx (bail on `EXECUTOR_UNAVAILABLE`, retry next signal), one `db.transaction` { `Running → NeedsInput` CAS, `markNodeNeedsInput`, `hitl_requests.insert(kind:"hook_trip")`, optional assignment, `run.needs_input` + `run.escalated{reason:"hook_trip", rule}` }, post-commit `logExecPolicyAction`. A web crash after checkpoint but before the escalate tx leaves the run `Running` + a valid checkpoint → the existing crash-reconcile sweep handles it.
- `readOnlySession` is **not** refactored into the engine in this milestone — it remains the lone behavioral-policy field beside the new `hooksConfig`, documented as a conceptual special case.
- Renumbered at the 2026-06-24 rebase onto main: this ADR is **ADR-108** and the schema change is **migration 0066** (main had taken ADR-104 + migrations 0063–0065; the Flow-Studio-package-authoring stream holds ADR-105–107 / M39). Milestone **M40** and engine **1.8.0** are uncontested.

**Alternatives Considered:**
- **Reuse `infra_recovery` / `budget_breach` for the trip HITL:** rejected — one kind per escalation cause keeps the inbox / timeline / Observatory read models legible; `hook_trip` follows the `budget_breach` precedent.
- **Pure opt-in everywhere:** rejected — the unattended overnight loop is exactly the run where no human is present to arm a breaker; the liveness breakers default-on under `unattended` (per-node opt-out).
- **Halt on the first out-of-path write:** rejected — deny-and-continue lets the agent re-plan; repeated denials feed the repetition / no-progress breakers, which then halt + escalate.
- **Ship the claude-native backend before the universal core:** rejected — no universal native-hook file exists across the 5 adapters, so the supervisor layer must carry enforcement first; native is an optimization (defense-in-depth, claude-only, path-guard-only).
- **Per-adapter opaque toolCall-body parsers:** rejected after the Phase-0 spike — the write path is standardized at `toolCall.locations[].path`; one extractor plus a kind-only fallback covers all families.
- **A new `MaisterError` code, or modeling `hooks` as `enforced`:** rejected — a trip is a recoverable `NeedsInput` pause, not a terminal failure, and modeling supervisor enforcement as `enforced` in the static table would reopen the frozen ADR-041 strict-flip.

---

### ADR-109: Consensus flow-graph node — engine-owned unanimous draft verification and human resolution

**Date:** 2026-06-24
**Status:** Accepted
**Context:** The orchestrator engine can delegate governed child runs, and the
flow graph can execute typed nodes, gates, dynamic routing, HITL, and artifact
post-conditions. It still lacks a first-class way to ask several independent
agents for competing read-only drafts, verify them against author-declared
material axes, and produce a single synthesized answer only when the engine can
prove agreement or a human explicitly resolves disagreement. Modeling this as an
agent convention, an orchestrator prompt preset, or a judge gate would make the
agent the authority on whether consensus exists. That would defeat the purpose:
consensus must be a deterministic control-plane protocol.

**Decision:** Add `consensus` as a first-class graph node with engine floor
`1.9.0` and migration `0070`. The engine fans out governed `repo_read` draft
child runs, parks the parent as `WaitingOnChildren`, resumes only after all
drafts in the round settle, runs in-node rotational cross-verification, parses
verdicts fail-closed, and tallies unanimity over author-declared
`material_axes`. On agreement, a separately declared synthesizer writes exactly
one current `consensus_plan` artifact (`kind = plan`) and one current
`debate_log` artifact (`kind = human_note`) before the node transitions success.
On no agreement, v1 escalates through the existing human HITL route with a
consensus schema discriminator and allow-listed decisions: pick draft, provide
resolution, rerun round, or abort. Cross-verification and synthesis sessions are
not child runs, but they consume the same numeric agent-capacity ceiling as
`MAISTER_MAX_CONCURRENT_AGENTS` and release tokens in `finally`.

The consensus node reuses orchestrator run-tree mechanics where they are already
the durable model (`parent_run_id`, `root_run_id`, cascade), but it does not
expose the orchestrator delegation toolset to participants. Runner-only
participants resolve through the platform runner chain without requiring agent
catalog rows. Consensus-specific verdicts live in a dedicated
`consensus_round_verdicts` table keyed by
`(node_attempt_id, round, verifier_key, target_key)`, not in `gate_results`.

**Consequences:**
- Consensus is auditable as a control-plane protocol: the tally is pure,
  deterministic, persisted, and not delegated to an agent.
- `WaitingOnChildren` wake-up must be generalized or given a consensus-specific
  consumer; the current `orchestrator_resume` consumer is not sufficient by
  itself.
- UI fan-out is required: Flow Studio authoring, read-only graph view,
  run-detail selected node, inbox/HITL controls, workbench evidence, topology
  labels, EN/RU strings, and screen docs all need first-class consensus
  treatment rather than a generic JSON fallback.
- DB/API/docs contract symmetry applies in the same change: node type
  `consensus`, artifact kind `plan`, verdict ledger, HITL schema examples, and
  public DTOs must agree.
- No new process, sidecar, port, package dependency, env var, public route, or
  `MaisterError` code is introduced.

**Alternatives Considered:**
- **Orchestrator prompt convention:** rejected because the agent would decide
  whether consensus exists, and recovery/audit would depend on prompt discipline
  rather than a durable engine protocol.
- **Judge gate over multiple drafts:** rejected because gates are gate-id
  oriented and do not model round/verifier/target identity or child-run
  recollection.
- **Majority/quorum/weighted policies in v1:** rejected to keep the first
  contract explainable and fail-closed. V1 is unanimous over material axes;
  other policies can be a future ADR.
- **Writable competing-code drafts:** rejected for v1 because shared or
  competing worktrees reopen ADR-102-class promotion ownership questions.
- **New HITL route:** rejected because the existing route can carry a human HITL
  schema discriminator and server-derived decision allow-list.

---

### ADR-110: Flow Studio AI assistant: read-only ACP + structured server-applied actions

**Date:** 2026-06-25
**Status:** Accepted
**Context:** ADR-097 introduced the docked Flow Studio assistant as a
project-less scratch run rooted at a local-package working dir. That substrate
made the assistant convenient, but the initial direct-edit model put too much
trust in the ACP process: the model could mutate files directly, users could see
raw protocol-looking output, and the web tier had no deterministic place to
validate Flow grammar, package artifacts, base versions, or current editor lock
state before writes. The product requirement is narrower and safer: the
assistant should answer from the current Flow/package context, and when asked to
change the Flow it should return structured intent that MAIster validates and
applies.

**Decision:** Flow Studio assistant sessions are read-only ACP sessions
(`readOnlySession: true`). Agents may inspect files and answer questions, but
they must not mutate the local package working dir. For edit requests, the
assistant must emit one structured `maister_flow_assistant_action.v1` block with
full-file `upsert_file` / `delete_file` operations, relative paths, and
base hashes copied from the server-provided context snapshot. The web tier
parses and strips that protocol block from the assistant transcript, validates
paths through local-package confinement, checks base hashes, applies the
operation set to an in-memory virtual package, reuses existing package/Flow
validation, and only then writes in-place through the existing lock-guarded
local-package file helpers.

`intent` (`auto | ask | edit`) is prompt-only in V1. It changes the grounded
instructions and logging context, but it is not an authorization or apply gate:
if any turn emits a valid structured action block, MAIster parses and applies it
through the same lock, hash, confinement, and package-validation pipeline.

The local package working tree plus the existing git diff drawer is the
user-visible proposal/review buffer. Commit/Discard remains the durable
accept/revert boundary. V1 does not add a proposal table, run kind, run status,
supervisor process model, DB migration, sidecar, port, env var, or package
dependency. Redacted structured action metadata and lifecycle states
(`received`, `validated`, `applied`, `rejected`, `interrupted`) are stored as
server-only run-scoped JSONL under
`.maister/<local-package-slug>/runs/<runId>/`. Upsert file contents are redacted
to content hashes and byte counts. The database stores only sanitized
`scratch_messages` system payloads of kind
`flow_action_result`, which render reload-stable user cards without raw JSON,
absolute paths, or file contents.

Launch and follow-up turns share the same pipeline: server context snapshot,
read-only ACP prompt, parse/sanitize, optional validated apply, JSONL audit, and
sanitized result card. Follow-up sends use a Studio-specific message route that
joins `runs.local_package_id`, `scratch_runs.run_id`, and the current user
before sending anything to the supervisor; the generic scratch route remains
unchanged. Runner selection is allowed only through enabled Ready platform ACP
runners and the platform default. Editor buffers must be saved first or the send
is blocked, so server apply never races unsaved canvas/YAML/package-file state.

Crash windows are explicit. Stale hashes, path escapes, malformed actions, and
invalid virtual package artifacts reject before writes. An unexpected failure
after writes begin is recorded as `interrupted`; the working tree remains the
source of truth and the existing diff/Discard path is the recovery surface.
Recovery never auto-replays action JSONL.

**Consequences:**
- The model can no longer bypass MAIster validation by writing through ACP
  tools; every mutation crosses the same confinement and package validation
  boundary as manual Studio writes.
- Users see prose and change/result cards, not protocol JSON. Reloads stay
  stable because cards are stored as sanitized scratch system messages.
- The first implementation keeps persistence simple: no proposal table or new
  lifecycle state, and git diff continues to be the review buffer.
- Full-file operations are simpler and safer than hunk patches, but can be
  heavier for large files. Hunk-level actions require a future ADR if needed.
- JSONL is audit evidence, not state. Debug tooling must tolerate partial final
  lines and must not become the source of truth for current package files.
- Structured logs must include `localPackageId`, `runId`, `actionId`, `intent`,
  `runnerId`, `focusPath`, `operationCount`, `status`, and validation issue
  counts, while excluding prompts, raw action JSON, file contents, absolute
  working dirs, and secrets.

**Alternatives Considered:**
- **Direct ACP file edits:** rejected because the model could mutate before
  MAIster validates Flow grammar, package shape, base hashes, or lock state.
- **Persist proposals in a DB table:** rejected for V1. The working tree already
  gives a durable review/revert buffer, and storing proposals would introduce a
  second state machine without clear product value yet.
- **Client-side apply:** rejected because the client cannot be the path
  confinement, lock, base-hash, or package validation authority.
- **Generic scratch message route with package-only body fields:** rejected
  because it would widen a project scratch surface with local-package-only trust
  boundaries. Studio assistant turns need their own route.
- **Hunk patches:** deferred. Full-file operations reuse existing save and
  validation primitives and make stale-hash conflicts deterministic.

**Amendment (2026-06-29) — staged-stream launch (surface `runId` before the
first turn):** The assistant launch (`POST
/studio/local-packages/{id}/assistant`) now streams its staged launch progress
over `text/event-stream` instead of blocking until the whole first turn
completes and returning `202` JSON. It reuses the scratch FR-F1/F2 staged-stream
pattern: `launchLocalPackageAssistant` is refactored into an async generator
(`launchLocalPackageAssistantStaged`) that yields `precondition → materializing
→ spawning → session_ready` and returns the same terminal `ScratchRunResponse`;
`launchLocalPackageAssistant` stays a thin drain wrapper for existing callers.
The route drives the generator head (a throw before the first `precondition`
yield stays a JSON `MaisterErrorBody` with its HTTP status), then streams the
frames, mapping the terminal `ScratchRunResponse` down to the **unchanged**
narrow `StudioAssistantLaunchResponse` (`{ runId, dialogStatus, actionResult }`)
for the `scratch.launch_result` frame. `session_ready` carries `runId` **before**
`sendScratchPromptAndProjectEvents`, so the editor attaches the live run SSE
(incremental transcript + working badge) while turn 1 streams — fixing the
first-turn "stuck on Запускается…, no output until the turn finishes" defect.
Success contract is `200` event-stream; pre-stream gate failures stay JSON
errors; a post-open failure is an in-stream `error` frame with the existing
session-teardown compensation. **No migration** — the run/`scratch_runs` rows
are still inserted before `createSession` and `session_ready` is emitted after
the existing status-update transaction. The follow-up `messages` route is
unchanged.

### ADR-111: Generic agent configuration framework — declared config params, per-instance values, resolved snapshot, prompt injection

**Date:** 2026-06-25
**Status:** Accepted
**Context:** Platform agents (ADR-089/090, package-keyed by ADR-106) ship as
`.md` definitions whose behavior is fixed at author time and tuned only through
the per-agent runner chain and the per-project attachment fields
(`agent_project_links.runner_override_id`, `branch_base`,
`execution_policy_override`). There is no way for an agent author to expose
*behavioral* knobs — a boolean, an enum, a threshold — that a project operator
sets per instance and the runtime feeds to the agent. The triager (ADR-112) is
the first agent that needs this: it must be configurable per project for
auto-enqueue behavior, duplicate detection, and intake mode without forking the
definition or hard-coding a triager-specific column. The owner asked for a
*generic* framework, not a triager-specific hack, so the model extension is
authored once and the triager is merely its first consumer. The existing
attachment plumbing, the `recommended`-binding SET/CLEAR resync symmetry, and
the immutable launch-snapshot discipline (`runs.execution_policy`,
`runs.runner_snapshot`) are the seams this reuses.

**Decision:**
1. **Agents declare a typed `config:` block in `.md` frontmatter.** It is an
   array of parameter declarations, each with `key`, `type ∈ {boolean, enum,
   string, number}`, `default`, optional `label`/`description`, and (for `enum`)
   a `values` list. Parsing and strict validation happen in
   `web/lib/agents/definition.ts`: an unknown type, an `enum` without `values`,
   a `default` outside `values`, or a duplicate `key` is a hard
   `MaisterError("CONFIG")` — the catalog row is **not** written on a bad schema
   (matching the existing behavior for invalid agent frontmatter). The type set
   is deliberately minimal; richer types are a future ADR.
2. **The declared schema is projected to `agents.config_schema` (jsonb) under
   SET/CLEAR resync symmetry.** On install/resync the parsed `config:` is written
   to the column so the UI can render a form without re-reading the package; an
   `.md` that drops `config:` re-syncs the column back to `null`, and re-adding
   it restores the value (idempotent round-trip — the same symmetry the
   `recommended` bindings already follow).
3. **Per-instance values live in `agent_project_links.config` (jsonb).** `null`
   means "all declared defaults". Values are written through the **one
   aggregating PATCH** the per-instance admin panel already uses (no per-field
   route), SET/CLEAR symmetric.
4. **Resolution is two-level: instance value → declared default.**
   `resolveAgentConfig(declared, instanceValue)` merges the per-instance value
   over the declared default; a `null` instance yields all defaults, a partial
   instance overrides only the present keys, and an unknown instance key is
   ignored. There is no project/platform tier (YAGNI).
5. **The resolved config is snapshotted once at spawn to `runs.agent_config`
   (jsonb, immutable).** It is computed in the run-insert path beside
   `execution_policy` and `runner_snapshot` and never re-resolved afterward —
   the launch-time-snapshot rule. A later edit to the link or definition does not
   change a live run's effective config.
6. **The agent reads its config by prompt injection from the snapshot.** The
   system prompt gains a small "Effective configuration" context block built
   **from `runs.agent_config`** (the snapshot), inserted before the task block.
   No new MCP tool and no new run-time resolution path: the injected block and
   the snapshot are the single source of truth, so they cannot diverge.
7. **The change is migration `0071`** (three additive jsonb columns:
   `agents.config_schema`, `agent_project_links.config`, `runs.agent_config`).
   No new `MaisterError` code (reuses `CONFIG` for a bad schema).

**Consequences:**
- Agent authors gain a first-class, per-instance behavioral surface without
  forking definitions or adding bespoke columns; the triager (ADR-112) consumes
  it directly and any future agent inherits it for free.
- The injected "Effective configuration" block reads from the immutable
  `runs.agent_config` snapshot, so a config edit mid-run is correctly invisible
  to the in-flight run — config follows the same audit/immutability contract as
  the execution policy and runner snapshot.
- The per-instance panel (M39 `agents-attach-panel.tsx` /
  `agents-attach-edit-modal.tsx`) grows a Configuration section that renders each
  declared param (toggle / select / input) seeded from the effective values and
  saves through the existing aggregating PATCH (EN + RU).
- A malformed `config:` block fails closed at parse time (`CONFIG`, no catalog
  row), so a broken declaration can never reach a launch.

**Alternatives Considered:**
- **A triager-specific config column / hard-coded knobs:** rejected — the owner
  asked for a generic framework; a per-agent column does not scale to the next
  configurable agent and couples the schema to one consumer.
- **A three-tier resolver (platform → project → instance):** rejected as YAGNI;
  the per-instance value over the declared default covers the need, and the
  extra tier adds resolution surface with no current consumer.
- **Reading config via a new MCP tool at run time:** rejected — re-resolving at
  read time would let a mid-run link edit mutate a live run's behavior and break
  the launch-snapshot invariant; prompt injection from the immutable snapshot is
  both simpler and audit-correct.
- **A new `MaisterError` code for bad config:** rejected — an invalid schema is a
  configuration fault; `CONFIG` already covers it and the ADR-008 union stays
  closed.

---

### ADR-112: Triager agent — duplicate_of/flagged dedup substrate, auto_launch_triaged tick, flow/runner discovery, no-silent-stall guards

**Date:** 2026-06-25
**Status:** Accepted
**Context:** We want a single **triager** platform agent that, given a task's
request, sets its flow, runner, and base branch, detects duplicates, forms
dependencies on other tasks, judges clarity, and (optionally) places the task
into the execution queue. Research showed ~80% of the substrate already exists
on the M34 platform-agent stack (ADR-089/090; package-keyed by ADR-106): the
triage verdict ops (`triage_set` → `flowId`/`runnerId`/`baseBranch`), typed task
relations with launch-gating (`blocks`/`depends_on`/`requires`), the
domain-event triggers (`task.created`, `task.triage_requeued`,
`task.comment_added`) with agent self-exclusion, the comment Q&A loop, and the
per-instance overrides plumbing were all built in anticipation of this agent.
Three concrete gaps remain: an agent cannot enumerate a project's flows/runners,
there is no model for "this is a duplicate" or "a human must look", and the only
auto-launcher (`auto_launch_run_plan`, ADR-098) is orchestrator-specific and
does not launch ordinary triaged **flow** tasks. The generic agent-config
framework (ADR-111) supplies the per-instance knobs the triager needs. PRD
authoring is explicitly **not** the triager's job — flow selection is driven by
each flow's self-describing `metadata.route_when`, and a PRD, in the limit, is a
node inside an execution flow (M12 artifact), authored separately.

**Decision:**
1. **One triager platform agent, shipped as `maister-agents/triager.md` in a new
   "core" package in the `maister-plugins` repo.** Frontmatter: `workspace:
   none`, `mode: session`, `risk_tier: read_only`, `triggers: [domain_event,
   manual]`, `recommended.events: [task.created, task.triage_requeued,
   task.comment_added]`, no `flow:` (so it runs as a standalone
   `run_kind='agent'` session on the agent budget). Config (ADR-111):
   `auto_enqueue (off | when_confident | always = off)`, `detect_duplicates
   (boolean = true)`, `intake_mode (triage_only | clarify = clarify)`.
2. **Clarity is two thresholds, not one.** A **routing-floor** check is
   unconditional in both modes: a black box that cannot be matched to a flow is
   never triaged — `clarify` asks the creator via a comment (driving "Needs
   you"), `triage_only` flags it for a human. **Execution-clarity** (detail
   questions) is mode-dependent: `clarify` refines the task statement *before*
   triaging; `triage_only` triages on the best obvious route and defers detail to
   the **flow's own HITL during the run**. So it is "routing always before;
   details by mode", with a max-rounds guard (3) falling back to `flagged`.
3. **Duplicates use a new `task_relations.kind` value `duplicate_of` —
   informational and NON-blocking.** `getOpenRelationBlockers` queries only
   `blocks`/`depends_on`/`requires`, so `duplicate_of` is never queried and never
   gates launch (the held state is what stops the task). On a strong match the
   triager links `duplicate_of`, comments, sets `flagged`, fills **no** verdict,
   and does **not** enqueue.
4. **A held task uses a new `tasks.triage_status` value `flagged`.** `flagged` is
   **not launchable even when `flowId` is set** (a human could attach a flow to a
   flagged duplicate; it must still be held). It is fanned out to every
   launchability consumer as an **allow-list** arm ranked **above** `unconfigured`
   in BOTH `classifyTaskLaunchability` and `classifyManualTaskLaunchability`. It
   is set via a triage `flag` op (mutually exclusive with verdict fields →
   `CONFIG`) and cleared only by a human (removing the `duplicate_of` relation or
   re-sending to triage).
5. **Enqueue is intent-only; a system tick performs the launch.** A triage op
   `enqueue:true` sets `tasks.launch_mode='auto'` in the verdict transaction
   (valid only with a verdict that yields a `flowId`). A new scheduler tick
   **`auto_launch_triaged`** on the M24 polymorphic clock (`systemManaged`,
   budget 1, 60s cadence) sweeps tasks that are `triaged` + `launch_mode='auto'`
   + `flowId` present + `classifyTaskLaunchability` launchable + no live run + not
   an orchestrator as-plan task, and launches a **standard flow run** through the
   normal precondition choke point (cap → `Pending`). Reusing
   `classifyTaskLaunchability` + `getOpenRelationBlockers` means a
   dependency-blocked task self-launches once its blocker clears, handled by one
   sweep with no extra wiring. The predicate is **disjoint** from
   `auto_launch_run_plan` (ADR-098), which requires a `parent_of`-under-orchestrator
   parent + `delegation_spec.agentId` and launches *agent* runs. The triager has
   **no** `runs:launch` scope and never calls launch itself.
6. **Discovery is two read-only ext routes plus two MCP tools.** `GET
   /api/v1/ext/projects/{slug}/flows` (scope `flows:read`) and `…/runners` (scope
   `runners:read`), surfaced as MCP `flow_list` / `runner_list`. New token scopes
   `flows:read` / `runners:read` are added to the agent token scope set. `flow_list`
   returns per flow `id` + `metadata.{title, summary, route_when, labels}` — the
   "when/what to apply" the triager matches against; `runner_list` returns enabled
   platform runners (`id`, `adapter`, `model`, `capabilityAgent`, `readinessStatus`).
7. **No-silent-stall is a two-sided contract.** A triager could otherwise stamp
   `triaged` + `auto` on a disabled/untrusted flow and the tick would refuse the
   launch forever while WARN-spamming. **Read side:** `flow_list` returns ONLY
   assignable flows (`enablementState ∈ {Enabled, UpdateAvailable}` ∧
   `trustStatus ≠ untrusted`), so the agent can only pick launchable flows.
   **Write side:** `validateVerdictRefs` validates the verdict flow's enablement +
   trust → `CONFIG`, so `triage_set` with a disabled/untrusted flow returns 422.
   **Give-up:** if a flow becomes unlaunchable AFTER a valid triage, the tick
   treats a terminal `PRECONDITION` refusal as give-up — it clears `launch_mode`,
   posts a system comment, and logs INFO (no WARN loop); a transient cap-hit
   stays `auto` and is retried.
8. **No new `MaisterError` code.** The whole feature reuses `CONFIG` (bad config
   schema, disabled/untrusted verdict flow, verdict+flag conflict),
   `PRECONDITION` (launch refusals), and `NOT_FOUND` (cross-project locator). The
   DB change is one migration: `0072` carries the `duplicate_of` relation widening
   (the `task_relations_kind_check` CHECK). The `flagged` `triage_status` widening
   is app-level only — the column is plain `text` with no DB CHECK (migration 0049
   created it that way), so it needs no migration. (The ADR-111 config columns are
   `0071`.)

**Consequences:**
- A triager can route, dedup, form dependencies, and enqueue tasks end-to-end on
  the existing M34 substrate, with only `read_only`/`workspace:none` blast radius
  and no launch authority of its own.
- The auto-launch tick handles dependency release for free: a `triaged` + `auto`
  task blocked by `depends_on` waits in queue and flies once the blocker reaches
  `Done`, with no event subscription (a timer was accepted; event-driven enqueue
  is a later optional upgrade).
- The `flagged` state must be fanned out to every launchability consumer
  (classifiers, the 5 classifier call-sites, read models, the user-cron
  dispatcher, and i18n) as an allow-list arm; `duplicate_of` must be kept out of
  the blocking-relation set by construction (explicit regression).
- `flagged` and `auto_launch_triaged` follow the existing snapshot/idempotency
  discipline: the tick writes no idempotency mark before `launchRun` and relies on
  a live-run guard plus singleton scheduling (budget 1).
- A triaged + auto task can never stall on a non-launchable flow: the read-side
  filter and the write-side validation jointly guarantee the verdict flow is
  assignable, and the give-up path bounds any post-triage staleness.
- The triager definition itself is an external deliverable in the
  `maister-plugins` core package; in-repo work ships a fixture and the
  register/enable/trust path.

**Alternatives Considered:**
- **Two agents (a router and a clarifier), or a triager-specific config column:**
  rejected — one agent configured per instance via the generic ADR-111 framework
  is simpler and the owner's explicit call.
- **The triager calls `run_launch` directly:** rejected — keeping the agent to an
  enqueue *intent* (`launch_mode='auto'`) and launching under system authority
  through the same precondition choke point keeps its blast radius minimal and
  reuses every launch safety.
- **Extending `auto_launch_run_plan` (ADR-098) to also launch flow tasks:**
  rejected — its predicate (orchestrator parent + `delegation_spec.agentId`,
  agent runs) is disjoint from a plain triaged flow task; a separate, disjoint
  tick avoids collision and keeps each launcher legible.
- **An event consumer instead of a tick:** rejected for v1 — a tick naturally
  re-evaluates dependency release without subscribing to every run-terminal
  event; `task.triaged`-driven enqueue is a noted future upgrade with the tick as
  the dependency-release backstop.
- **`duplicate_of` as a blocking relation, or a `prd` intake mode / `tasks.prd`
  column:** rejected — duplicates are held by the `flagged` state (the relation
  stays informational), and PRD authoring is a flow-execution concern (a typed
  M12 artifact), not the triager's job.
- **A new `MaisterError` code:** rejected — `CONFIG`/`PRECONDITION`/`NOT_FOUND`
  already cover every refusal on the triage → enqueue → tick path; the ADR-008
  union stays closed.

---

### ADR-113: PR-to-source for local packages — trusted-source picker + stable publish branch

**Date:** 2026-06-25
**Status:** Accepted
**Context:** A local package forked from a git source stores `source_repo_url` /
`source_ref` / `branch_name` (ADR-096/105) **only** to enable a future upstream PR;
M39 Stream A explicitly deferred the publish path. `pushBranch`
(`web/lib/worktree.ts`) + the `PrAdapter` family (gh / glab / Gitea / Gitverse,
`web/lib/runs/pr-adapter.ts`) already exist but are **project-repo-only** (run
promotion). `package_sources` (`schema.ts`) is a platform-global, URL-keyed
allow-list of registered git sources, pushed with **host-ambient credentials**
(`GH_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` / `GITVERSE_TOKEN`, or the host git
credential helper / SSH key). This ADR adds the PR-to-source publish path — the
Stream-B half of M39 paired with ADR-107.

**Decision:**
1. **`publishLocalPackage(id, { targetSourceId, branchName })`.** Resolve the target
   from the `package_sources` **allow-list** (server-state — a body-supplied raw URL
   is never accepted) → add/set a git remote in the package working dir →
   `pushBranch(workingDir, branch)` → if a provider + token is detected
   (`detectProvider` + the `PrAdapter` for gh/glab/Gitea/Gitverse), open or update a
   PR; else push-only + a best-effort compare URL. The PR adapters are parameterized
   for a package working dir + an arbitrary target source (no longer
   project-repo-only). Branch names are validated at the git sink (`branchNameSchema`
   / `assertSafeBranchRefs`); a `targetSourceId` not in the allow-list is a 409.
2. **UI.** A dedicated **`PublishDialog`** — a sibling of `ChangeReviewDialog`
   (ADR-105) reusing its modal pattern, kept separate so the tested commit flow is
   untouched — with a **target-source picker** (registered sources; preselect the one
   mapped from `local_packages.source_repo_url` by URL equality, retarget allowed), a
   **branch-name** input prefilled with a stable **`maister/<pkg-slug>`** (editable),
   a **cross-repo warning** when the target source ≠ the fork origin, and a **result
   panel** (the PR url, or the branch + a compare url). It publishes the **committed
   HEAD** (no commit happens at publish), so it steers the author to commit pending
   edits first (via the Commit-state `ChangeReviewDialog`) rather than showing a
   working-tree diff that would not be published.
3. **Stable, reusable branch.** Re-publish updates `maister/<pkg-slug>` and the
   existing PR — never duplicates it. `local_packages.{last_pushed_branch,
   last_pr_url}` persist the result, written **after** the push succeeds (two-phase).

**Consequences:**
- Reuses `pushBranch` + `selectPrAdapter` / `createOrUpdatePr` + `detectProvider` +
  `branchNameSchema` / `assertSafeBranchRefs` at the sink. The adapters are
  idempotent (existing-PR detection), so re-publish updates rather than spams.
- **Two-phase publish:** the push is the external side-effect; `last_pushed_branch`
  / `last_pr_url` are written only after it acks. Failure table: non-fast-forward
  push → `CONFLICT` (retryable, markers unset); auth / no-remote → `PRECONDITION`;
  no source url / unsupported provider → `CONFIG` / `PRECONDITION`.
- PR automation needs the provider CLI + a host-ambient token; absent → a push-only
  fallback with a compare URL + a manual-PR hint (documented in
  `docs/configuration.md`). No new env var, no compose change (`.maister` is
  host-only, ADR-023).
- Migration **0074** (the PR cols, shared with ADR-107's source-link cols). NO new
  `MaisterError` code (reuses `PRECONDITION | CONFLICT | CONFIG`).

**Alternatives Considered:**
- **Body-supplied raw target URL:** rejected — the registered `package_sources`
  allow-list is the only valid target set (a body URL is a cross-resource injection
  vector).
- **Timestamped per-publish branch (`maister/<pkg>-<ts>`):** rejected (owner) — a
  stable `maister/<pkg-slug>` keeps one reusable branch + one PR; re-publish updates
  rather than spamming.
- **A new `MaisterError` code for publish failures:** rejected — the closed union
  already covers push-rejected (`CONFLICT`), auth/no-remote (`PRECONDITION`), and
  config (`CONFIG`).
- **Hiding cross-repo push behind "advanced":** rejected (owner) — a visible warning
  is clearer than burying a valid "pull from A, push to B" workflow.

**Numbering note.** PR-to-source is the Stream-B publish half of M39 (paired with
ADR-107). It takes **113** (110–112 went to the AI-assistant / agent-config /
triager siblings that merged to main first). Shares migration **0074** with
ADR-107; the publish mutex is **0075**.

---

### ADR-114: Unified Flow runner config, first-class sessions, per-project connect-time bindings, and `run_sessions` as the sole run-runner source of truth

**Date:** 2026-06-26
**Status:** Accepted
**Context:** MAIster grew three divergent per-node runner mechanisms with no
shared shape: (a) `runner_profiles` manifest values (`flowRunnerProfileSchema`,
`web/lib/config.schema.ts`) keyed by `capability_agent` + `permission_policy`
with **no** `effort`/`env`; (b) a per-step `flow_runner_remaps` table keyed
`(projectId, flowRevisionId, stepId, sourceRunnerId)`; (c) consensus
participant/synthesizer runners resolved by a **direct** `platformAcpRunners.id`
lookup (`consensus/roles.ts`) that bakes a host runner id into the git artifact —
so a consensus flow is not portable across hosts. Three findings from a code read
are load-bearing and shaped this decision: (1) `judge.settings.model` is **never
read at runtime** — `materializeNodeCapabilities` always uses the run's single
`loaded.executor.model`; the field only feeds a tooltip
(`node-tooltips.ts`). (2) No `session.json` exists on disk — `acp_session_id`
lives only in `runs.acp_session_id`, and reconciliation is **web-tier + DB-driven**
(`web/lib/reconcile.ts`) under the hard no-`fs.watch`/polling invariant, so a
disk-only per-session mirror cannot drive reconcile/resume. (3) The "one runner
per run" lock is entirely web-tier — the supervisor registry is already keyed by
supervisor `sessionId` (not `runId`), and `run.events.jsonl` / `cost.jsonl` are
per-run with monotonic seeding designed for multi-session. The product need is a
single portable runner config, "one runner per **session**" (not per run), and
runner intent bound to concrete host runners **per project at connect-time** —
never baked into the git artifact.

**Decision:**
1. **One unified runner config** (`flowRunnerConfigSchema`): `runner_type`,
   `capability_agent`, `adapter?`, `model?`, `model_family?`, `provider?`,
   `permission_policy`, `sidecar?`, **plus new `effort?`** (reusing the
   `thinkingEffort` enum) and **`env?`** (a passthrough NAME map whose values are
   `env:NAME` references only — never secret literals). The same shape is used for
   `runner_profiles` values, `sessions[].runner`, node `settings.runner`
   (ai_coding / orchestrator / judge), and consensus participant/synthesizer
   `runner`. Any runner slot accepts a profile-ref **string** OR an inline
   **object**. Node **capability** settings (mcps / skills / restrictions / tools /
   enforcement / hooks) stay on the node, unchanged.
2. **First-class sessions** (top-level `sessions:` + node `session:`). A node with
   neither `session:` nor `runner:` joins the implicit **`default`** session
   (preserves today's single-session behavior, zero ceremony); a node with
   `runner:` and no `session:` gets its own **solo** one-node session; a node with
   `session:` joins that named group. A session shares one ACP process + one
   continuous `acp_session_id` resumed in graph order; **all** sessions share the
   run's single worktree; sessions are **sequential** (not parallel); a session
   switch reuses checkpoint → `session/resume` (≈ `$0.28`/respawn,
   ADR-spike cost). **`judge` becomes an ordinary runner-bearing node** (via
   `runner:`/`session:`); **`judge.settings.model` is removed entirely** (clean
   cutover — it was never read), including its `node-tooltips.ts` reference.
   **`consensus` stays a fan-out node excluded from `sessions:`**; its
   participants/synthesizer use the unified runner config and are made portable via
   bindings (3).
3. **Per-project bindings, at connect-time OR first launch** (whichever first).
   Bind **every** runner slot whose config has no unique host auto-match — covering
   all sessions **and** all consensus slots, not just `default`. The binding table
   is keyed `(project_id, flow_revision_id, slot_key)` where `slot_key ∈
   {session:<name>, consensus:<nodeId>:<participantId>,
   consensus:<nodeId>:synthesizer}`. **`slot_key` is REQUIRED, not a
   dedup-by-intent convenience:** a consensus node may legitimately declare N
   participants with identical runner intent (LLMs are non-deterministic, so two
   `claude+opus` participants can and should yield different drafts) — intent-dedup
   would erase a valid configuration, so slot enumeration **and** the binding UI
   MUST NOT dedup by intent. `mapped_runner_id → platform_acp_runners`; status
   `Pending|Mapped`; auto-match by intent (agent + model + provider); a flow
   revision that introduces new slots re-prompts. `flow.yaml` never names a host
   runner or a secret.
4. **`run_sessions` is the SOLE source of truth for run runner state.** Columns:
   `id, run_id, session_name, runner_id, runner_resolution_tier, capability_agent,
   runner_snapshot, acp_session_id, resolution_source, timestamps`, with
   `UNIQUE(run_id, session_name)`. The run-level columns
   `runs.{runner_id, runner_resolution_tier, capability_agent, runner_snapshot,
   acp_session_id}` are **DROPPED** in `0082` — which first backfills the same
   state into each run's `default` `run_sessions` row, so live runs are
   preserved — and the FK `runs.runner_id → platform_acp_runners` + index
   `runs_runner_idx` are recreated on `run_sessions.runner_id`. Non-flow runs
   (scratch / agent) have exactly one `default` row. **`step_runs.acp_session_id`
   stays** — it is a separate per-step-run column recording which session a step
   used; it is neither dropped nor migrated.
5. **Per-session resolution precedence** (per slot): connect-time/first-launch
   **binding** for any slot whose runner config lacks a unique host auto-match →
   **auto-match** → for the `default` session **with no explicit runner only**:
   project-flow → platform-flow → project → platform default. This re-maps the
   existing 6-tier `resolve.ts` chain onto the session model — the top two tiers
   are **not** dropped: `launchOverride` becomes the **optional ephemeral per-run
   per-session override** offered at the Launch dialog (does not persist), and
   `stepTarget` becomes the session runner config.
6. **Supervisor gains a `sessionName` field on `POST /sessions`** so `cost.jsonl`
   and `run.events.jsonl` are attributable per logical session, not only per
   supervisor `sessionId`.
7. **No new `MaisterError` code.** An invalid/unbound session graph reuses
   `CONFIG`; the absence of a concrete host runner reuses `EXECUTOR_UNAVAILABLE`
   (ADR-008 closed union, ADR-026/065 precedent).
8. **Engine `2.0.0` — first stable clean-cutover baseline.**
   `MAISTER_ENGINE_VERSION → "2.0.0"`; the new features' floor is `2.0.0`; all
   rewritten manifests declare `compat.engine_min: 2.0.0`. (Engine `1.9.0` was
   taken by ADR-109 consensus; this milestone is a clean cutover with no backward
   compatibility — the `runs` runner mirror is dropped with no compat path —
   which earns the major bump; migration `0082` backfills that state into
   `run_sessions` first, so the cutover preserves live runs rather than
   discarding them.)

**Consequences:**
- Flow packages become **portable**: runner intent travels as agent+model+provider
  in the git artifact, and the concrete host runner is bound per project at
  connect-time — a package installs and runs on any host without editing
  `flow.yaml`.
- The `run_sessions` cutover is a **full schema migration with a one-shot
  run-data preservation backfill**, split across three migrations: `0080`
  creates `run_sessions`; `0081` re-keys `flow_runner_remaps` to `slot_key`;
  and `0082` backfills each existing run's runner/resume state into a `default`
  `run_sessions` row **before** dropping the `runs.{runner_id,
  runner_resolution_tier, capability_agent, runner_snapshot, acp_session_id}`
  mirror columns (plus `runs_runner_idx` and the runner FK). Because `0082`
  preserves the resume handle + runner snapshot, **in-flight runs survive the
  deploy** — recovery, resume, stop, gate-chat, and diagnostics still target the
  correct ACP session, so they do NOT need to be terminated or abandoned first.
  The single remaining deploy precondition is `flow_runner_remaps`: if it holds
  rows, `0081` aborts (the per-step key is not deterministically mappable to
  `slot_key`), so operators MUST export/record those bindings and clear the
  table **before** running migrations, then re-map per slot via the project
  Flow runner UI **after** the upgrade succeeds.
- Crash recovery, resume, reconcile, promote, and workbench-lifecycle all read the
  **snapshotted `run_sessions`** rows, never a mutable catalog/projection that can
  drift after launch (extends the ADR-089/106 "enforce on what the run DID"
  discipline to the session axis). Terminal/abandon transitions MUST close **every**
  `run_sessions` live process; HITL/gate live-delivery MUST target the **active**
  session's `acp_session_id`.
- **Deployment touchpoints: NONE.** No new host env var, sidecar, bound port, or
  runtime config file — the `env` field is a flow-authored passthrough-NAME map and
  secrets stay `env:NAME`. No `Dockerfile` / `compose*.yml` / `.env.example` change
  (stated explicitly so the absence is intentional, per the runtime-contract-symmetry
  rule, not an omission).
- Migration **0080** + ADR **114** reserved at HEAD `fa68deec` (next after `0079` /
  ADR-113). Parallel branches may collide — Phase 7 budgets a renumber check vs
  `main` (`git show main:docs/decisions.md`, `_journal.json`).

**Alternatives Considered:**
- **Keep the per-run single runner + per-step `flow_runner_remaps`:** rejected —
  three divergent runner shapes, no session axis, and a host runner id baked into
  the consensus git artifact (not portable).
- **Disk `sessions/<name>.json` per-session mirror:** rejected — reconcile/resume is
  web-tier + DB-driven under the hard no-`fs.watch`/polling invariant, so disk-only
  state cannot drive recovery; `run_sessions` (DB) is the sole source of truth.
- **Dedup binding slots by runner intent:** rejected — two consensus participants
  with identical `claude+opus` intent are a valid, deliberate configuration
  (non-deterministic drafts); `slot_key` keeps each a distinct, independently
  bindable slot. Slot enumeration and the binding UI never dedup by intent.
- **Keep `judge.settings.model`:** rejected — it is never read at runtime (only a
  tooltip); judge becomes an ordinary runner-bearing node and the field is removed.
- **A new `MaisterError` code for unbound/invalid sessions:** rejected — `CONFIG`
  (invalid graph) and `EXECUTOR_UNAVAILABLE` (no host runner) already cover both.
- **A `1.x` minor engine bump:** rejected — `1.9.0` is taken, and this is a no-compat
  clean cutover; `2.0.0` marks the first stable clean-cutover baseline.

**Numbering note.** Unified runner & session model is **M42**, engine **2.0.0**,
ADR **114**, migration **0080** — all reserved at HEAD `fa68deec`. If a parallel
branch lands 114/`0080` first, Phase 7 renumbers (the ADR body, the Index row, the
migration file + `_journal.json` entry, and every `ADR-114`/`0080` cross-reference).

---

### ADR-115: Strict template default operator for prompt authoring

**Date:** 2026-06-28
**Status:** Accepted
**Context:** Flow Studio prompt assists need to show authors variables that are
available at the selected node. Graph availability alone is insufficient because
`renderStrict` throws when a key is missing or present-but-`undefined`.
Legitimate runtime values such as `executor.router`, non-CLI/check
`steps.<id>.exitCode`, JSON-Schema optional fields, and `artifacts.<id>.uri` may
be absent even when their producer ran. Suggesting those as bare
`{{ path }}` variables would create launch-time `CONFIG` failures.

**Decision:** Keep bare Mustache tags strict and add a single render-time default
operator: `{{ <dotpath> ?? <quoted-string-literal> }}`. If the dot path resolves,
the value is rendered. If the path is missing or resolves to `undefined`, the
literal is rendered and no `CONFIG` error is thrown. The editor inserts bare
`{{ path }}` only for `definite + required` variables and inserts
`{{ path ?? '' }}` for `conditional` or `optional` variables. The operator is
implemented in `web/lib/flows/templating.ts` and documented in `docs/flow-dsl.md`.

**Consequences:**
- Prompt authors get safe autocomplete for optional context, optional schema
  fields, and conditional predecessors without weakening typo protection.
- Existing prompts are byte-identical: no prompt currently uses `??`, and bare
  `{{ path }}` remains strict.
- No `compat.engine_min` floor is required. The feature is a render-time additive
  behavior, matching ADR-091's precedent for launch/render-time additions that do
  not change manifest shape or compile semantics.
- No new `MaisterError` code is added; the guarded form removes an existing
  throw, while the bare form keeps throwing `CONFIG`.

**Alternatives Considered:**
- **Omit optional variables from suggestions:** rejected because values such as
  `executor.router`, optional schema fields, and artifact URIs are legitimate
  authoring needs.
- **Render all missing variables as empty strings:** rejected because it destroys
  the current strict typo-protection contract.
- **Mustache sections for presence checks:** rejected because the strict proxy
  throws before a missing section can behave like an ordinary Mustache guard.
- **Full expression language:** rejected as too broad; string-literal defaults
  solve the prompt-assist need without changing the DSL shape.

---

### ADR-116: Local-package composition view: shared package BOM source abstraction, tabbed editor IA

**Date:** 2026-06-28
**Status:** Accepted
**Context:** The **installed**-package viewer (`/studio/packages/{ref}`,
`PackageDetail` → `PackageTabs` + `ElementCard`) answers "what is in this package,
how much of each kind, what are they" at a glance via a computed `PackageBom`
(`getStudioPackageBom`, `web/lib/queries/packages.ts`). The **editable
local**-package editor (`/studio/edit/{id}`) does not: its no-path landing
(`PackageHome`) shows flows as opaque badges plus a raw, non-interactive file
tree (`PackageFilesEditor`), and skills/agents/subagents/MCPs/rules are visible
only as scattered files. The BOM builder is hard-wired to a `package_installs`
row (`installedPath` + stored `manifest`), so the local editor — whose content
lives in a git-backed `working_dir` and whose inventory is not pre-computed in a
stored manifest — cannot reuse it. Two further frictions: file moves work only
through a free-text "Rename path" popup (no drag-and-drop, folder creation, or
batch import surfaced from the landing); and `classifyPackageFilePath` returns
`"asset"` for `mcps/` so MCP descriptors are invisible to any kind-grouped view.

**Decision:**
1. **Decouple the BOM from install.** Introduce a `PackageSource` abstraction
   (`{ logLabel, spec: { flows, mcps }, inventory, listFiles(), readFile(),
   loadFlow() }` — `spec` is a narrowed projection, NOT the full
   `MaisterPackageManifest`, so a local source can synthesize `mcps` from files;
   `loadFlow()` is the single confinement chokepoint for compiling a flow's
   `flow.yaml`) and a pure
   `buildPackageBom(source)` (`web/lib/queries/package-bom.ts`). `getStudioPackageBom`
   is re-pointed at it through an **installed** source (today's behavior, kept
   byte-identical — a characterization snapshot is the regression guard). A new
   `getLocalPackageBom(pkg)` (`web/lib/local-packages/bom.ts`) builds a **local**
   source over the `working_dir`: `spec` (flows + MCP descriptors) projected from `maister-package.yaml`,
   `inventory` **computed** at BOM time by walking the working dir (the
   install-time `collectInventory` logic factored to run over a file list),
   `listFiles`/`readFile` confined to `working_dir`. Per-element parse failures
   degrade to id-only cards; the builder never throws.
2. **Tabbed-by-kind composition landing.** Replace `PackageHome` with a
   `PackageComposition` view reusing `PackageTabs`/`ElementCard`/`FlowPreviewCard`.
   Seven tabs with live counts — `Flows · Skills · Subagents · Agents · MCP ·
   Rules · Files` — where empty kinds hide their tab and Files is always shown.
   **Open model per kind:** flows route to the existing canvas
   (`FlowEditorTabs`); skills route to a dedicated skill screen (own nested
   file-navigator, because skills have nested folders); subagents / platform
   agents / MCP / rules open **inline** master-detail (card list + side editor
   reusing `FrontmatterArtifactEditor` / `McpTemplateEditor`); Files is a
   file-manager tab (raw tree + breadcrumbs + drag-and-drop + create/rename
   folder + a shared Import button).
3. **Create + rename are identity operations on the draft file set.** Per-tab
   `+ Add <Kind>` scaffolds the exact file shape (and appends `manifest.spec.flows[]`
   for flows) into the draft set and opens the right editor. A card-level
   `Rename <Kind>` renames the artifact **identity** (file / folder; the id derives
   from the filename/folder), distinct from editing **metadata** (frontmatter) in
   the editor. Both reduce to the existing lock-guarded save-diff (`PUT`/`DELETE
   /api/studio/local-packages/{id}/files/{path}`) — **no new HTTP route, no new
   `MaisterError` code, no DB migration**. Collisions → `CONFLICT`; path escape /
   missing → `PRECONDITION` via the existing `resolveWithinWorkingDir` confinement.
4. **BOM is server-computed, last-saved-disk truth.** The composition `PackageBom`
   is derived at RSC load and re-derived on `router.refresh()` after a save
   (matching the existing editor refresh pattern). Inline content edits mutate the
   existing `draftFiles` and persist through the existing save channel; identity
   changes (create/rename/delete) are save-then-refresh, so a new/renamed card
   appears after the round-trip. No client-side flow compilation (KISS).
5. **MCP descriptors handled by a local predicate.** A small `isMcpDescriptorPath`
   (`mcps/*.yaml`) is used at the composition + editor-routing call sites;
   `classifyPackageFilePath` is **not** broadened (that would ripple into the
   installed reader).
6. **New folder is virtual (client-only), no sentinel.** The draft model is a
   flat `{path, content}[]`; an empty folder that never receives a file simply
   never reaches disk — no `.gitkeep` is written. Empty-folder persistence, if ever
   needed, is a cut-version concern, out of scope.

**Consequences:**
- Installed and local packages share one BOM parser; the installed output is
  pinned by a byte-identical characterization test, so the refactor cannot
  regress the existing viewer.
- The local editor gains the same readability + create/rename/file-manager/import
  affordances as the installed viewer, layered over the existing
  draft-files + lock + save substrate with zero new wire surface.
- `PackageHome` (and the flow-badge helpers / tests it pulled in) is deleted; the
  manifest form is reused inside the composition header.
- Because the BOM reflects last-saved disk state, a created/renamed artifact
  appears only after the save round-trip — an accepted, documented invariant.

**Alternatives Considered:**
- **Broaden `classifyPackageFilePath` to recognize `mcps/`:** rejected — it is
  shared with the installed reader and would change installed-package file
  classification; a local predicate keeps the blast radius contained.
- **Client-side flow compilation for instant card updates:** rejected — pulls
  the compiler into the browser and duplicates server logic; save-then-refresh is
  simpler and already the editor's pattern.
- **A `move` HTTP route (the OpenAPI `POST .../files/{path}/move`, Designed):**
  rejected for this plan — this Designed route is a *cross-package* relocation
  (move a file into another local package's working dir), orthogonal to the
  in-package identity rename/move this ADR ships, which reduces to the existing
  save-diff (PUT new + DELETE old). The Designed route stays Designed and
  unimplemented.
- **`.gitkeep` sentinels for empty folders:** rejected — local empty dirs are
  harmless; manufacturing sentinels litters the working tree for a push/cut-only
  concern.

**Numbering note.** Originally reserved as ADR-115 at branch HEAD; renumbered to
**ADR-116** on rebase onto main, which had landed ADR-115 (strict template default
operator) first. No migration is taken (the next free `0083` stays unused).

---

### ADR-117: Reliable cost-rollup reconciliation and per-runner cost attribution

**Date:** 2026-06-29
**Status:** Accepted
**Context:**

Two defects in the Observatory cost dimension (see
[observatory.md](system-analytics/observatory.md) "Cost dimension"):

1. **Scratch runs are invisible until opened.** `getCostSummary`
   (`web/lib/queries/observatory.ts`) sums `run_cost_rollups` with no
   `run_kind` filter — a run is counted **iff a rollup row exists**. Rollup rows
   are written only by `reconcileRunCostRollups`, triggered lazily: run-detail
   open, task-detail open, and the budget watchdog (runs with a *set* budget
   limit only). A scratch run has no task and usually no budget, so its **only**
   trigger is a human opening the run. An un-opened scratch run never gets a
   rollup row and is structurally absent from project/portfolio cost totals.
   The asymmetry is sharp: **scratch success emits no terminal domain event**
   (`run.done` is emitted only by `promote.ts`; only `run.failed` /
   `run.crashed` / TTL-`run.abandoned` are emitted), so an event-driven trigger
   alone cannot guarantee inclusion.

2. **No per-runner cost breakdown, and the project breakdown ignores
   `by_model`.** `run_cost_rollups.by_model` is written per run but
   `getCostSummary` never reads it; there is no runner attribution anywhere.

The read-only boundary (observatory.md "Read-only boundary",
[ADR-059](#adr-059-read-only-observatory-formulas-and-harvest-priority)) forbids
reconciliation in the read path — Observatory reads derived rollups only. So the
fix cannot be "reconcile on read".

**Decision:**

1. **Two reconcile triggers with split roles, both on write paths.**
   - The **`system_sweep` backstop is the completeness guarantee.** It keys on
     `runs.ended_at` (set on *every* terminal transition, NULL for active runs)
     — **not** on a terminal-status allow-list and **not** on a domain event.
     `ended_at` catches every finished run regardless of which terminal status
     it reached or whether any event fired, so it is what guarantees
     scratch-success inclusion, pre-existing history, and late cost-flush races.
     Progress is tracked by a **durable per-run marker** `runs.cost_reconciled_at`
     (migration `0084`), stamped on *every* sweep attempt — reconciled,
     missing-cost, OR error. Candidate predicate: `ended_at IS NOT NULL AND
     ended_at > now − lookback AND (cost_reconciled_at IS NULL OR
     cost_reconciled_at < ended_at + SETTLE_GRACE)`. Keying progress on the marker
     (NOT `run_cost_rollups` row state) is what makes the backstop actually
     complete + non-starving: a run with no `cost.jsonl` is attempted ONCE then
     settled — instead of staying eligible every tick and monopolizing the
     bounded oldest-first scan ahead of newer runs — and a pre-`0083` rollup with
     an empty `by_runner` (NULL marker, since the migration default can't derive
     per-runner splits) is re-reconciled once to backfill it. The `+ SETTLE_GRACE`
     (~2 min) term forces one extra re-reconcile of a just-ended run so the
     supervisor's async final `cost.jsonl` flush (`stream.end`) is captured; once
     the marker advances past `ended_at + SETTLE_GRACE` the run is skipped (no
     disk thrash). Lookback is env-tuned via
     `MAISTER_COST_RECONCILE_LOOKBACK_HOURS` (default 168h = the 7-day GC
     horizon); per-tick bound reuses the existing sweep limit.
   - The **`cost-rollup-reconcile` domain-event consumer is a low-latency
     fast-path**, not the completeness guarantee. It subscribes to the existing
     terminal kinds (`run.done | run.failed | run.crashed | run.abandoned`) —
     **no new event kind** — so the rollup appears seconds after a terminal that
     *does* emit, instead of waiting for the next sweep tick. `startFrom: "now"`
     (forward-only — the sweep owns historical backfill; a `"beginning"` replay
     would be wasteful). It is **poison-safe**: `handle(events[])` filters to
     terminal kinds, dedupes `runId`, and reconciles each **inside a per-run
     try/catch that logs WARN and never throws** — because the dispatcher
     `break`s without advancing the cursor when `handle` throws
     (`dispatch.ts`), a single permanently-failing run would otherwise stall the
     cursor and block all later events forever. A transient disk error is
     retried by the next sweep; a permanent one (`CONFIG` no-slug) is skipped.

2. **Per-runner attribution via a new `by_runner` jsonb column on
   `run_cost_rollups`**, symmetric to `by_model`, populated at reconcile by
   bucketing cost records by `sessionName` and joining `(run_id, session_name) →
   run_sessions`. Each cost record carries `sessionName` (M42,
   [ADR-114](#adr-114-unified-flow-runner-config-first-class-sessions-per-project-connect-time-bindings-and-run_sessions-as-the-sole-run-runner-source-of-truth));
   `run_sessions` carries `runner_snapshot` keyed by `(run_id, session_name)`
   for every run kind. The group key is a **snapshot-derived stable label**
   `runnerKey = "<adapter>/<model>"` (e.g. `claude/claude-sonnet-4-6`) — derived
   from `run_sessions.runner_snapshot`, **not** the catalog FK, so a deleted
   `platform_acp_runners` row never erases historical attribution. A cost record
   whose `sessionName` has no matching `run_sessions` row (legacy pre-M42 /
   missing `sessionName`) buckets under `runnerKey = "unknown"`.

3. **Conditional precision.** The multi-runner split is *exact* only when a flow
   declares multiple logical sessions (distinct `sessionName` per node → distinct
   `run_sessions` rows with distinct snapshots). A single-session flow, and every
   scratch/agent run, maps all cost to one runner via `sessionName = "default"`
   — which is correct, not a loss. There is **no per-node runner split below
   session granularity**; "by runner" is scoped to session granularity by design.

4. **Idempotency.** Dispatch is at-least-once and the sweep re-reconciles;
   `reconcileRunCostRollups` is idempotent (delete-then-insert nodes,
   `onConflictDoUpdate` run row, `sourceCursor`). A re-reconcile after a
   runner/session change MUST refresh `by_runner` with no stale buckets.

5. **Remove dead `reconcileProjectScopeCostRollups`.** It is a full-project disk
   re-scan, never called, and read-path-unsafe; the event consumer + sweep
   supersede it.

**Consequences:**

- Un-opened scratch runs (and all finished runs) appear in cost totals within
  one sweep tick at worst, seconds at best for event-emitting terminals.
- Project/portfolio Observatory gains `byModel` + `byRunner` breakdowns
  (`CostDimensionRow[]`), pure reads over the two jsonb columns.
- The read-only boundary is preserved: no reconcile or `cost.jsonl` read in any
  read path; both triggers run on write paths (event consumer + sweep).
- The poison-safe consumer contract is a hard invariant — a throwing `handle`
  stalls the whole consumer cursor.
- `run_cost_rollups` gains one column (`by_runner jsonb not null default '{}'`)
  and `runs` gains one partial index (`runs_ended_at_idx on runs(ended_at) where
  ended_at is not null`) to support the sweep's bounded `order by ended_at`
  scan (migration `0083`). `runs` also gains the durable `cost_reconciled_at`
  timestamp marker (migration `0084`). Both schema-only — no env/port change for
  the columns.

**Alternatives Considered:**

- **Read-time reconcile** (reconcile inside `getCostSummary`): rejected — breaks
  the Observatory read-only boundary (ADR-059) and re-reads `cost.jsonl` in a
  request loop.
- **Consumer-only (no sweep):** rejected — scratch success emits no terminal
  event, so the consumer cannot guarantee inclusion. Correctness MUST NOT depend
  on the consumer for completeness.
- **Sweep-only (no consumer):** workable but adds up to one tick of latency for
  every terminal; the consumer is a cheap fast-path over events that already
  fire.
- **Status-allow-list sweep predicate** (sweep on terminal `status`): rejected —
  `ended_at` is the single field set on *every* terminal transition; a status
  list would have to enumerate and track the full terminal set and would still
  miss nothing `ended_at` does not.
- **Catalog-FK runner key** (`runner_id`): rejected as the primary key — a
  deleted runner row would erase historical attribution; `runner_id` is carried
  only as a secondary display field.

---

### ADR-118: Rework loop `onExhaustion` routing + human-driven counter reset (`resetTargets`) + engine 2.1.0

**Date:** 2026-06-29
**Status:** Accepted
**Context:** A bounded `rework` loop (`rework.maxLoops`) on a graph node — the
spine of the autonomous fix↔verify↔review loops authored in flow packages — has
exactly one terminal behavior on attempt exhaustion: the execution-policy **A1
`reworkExhaustion`** action (`fail | escalate | ship_with_warning`,
[ADR-095](#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship)/[ADR-101](#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open)).
Two capabilities are missing for an autonomous loop that wants a human in the
exhaustion path *without* discarding its accumulated worktree:

1. There is no way for the loop author to route exhaustion to a **specific**
   node (e.g. a `human_review` that renders "the loop spent its budget —
   decide") instead of the policy-driven A1 action. A1 is run-policy-scoped, not
   author-scoped, so a flow cannot express "on this loop, hand off to *this*
   reviewer node".
2. Even when a human is reached, there is no way for that human to **restart the
   loop with a fresh budget**. A node's `node_attempts` counter is monotonic;
   once `attemptNumber > maxLoops` the loop is permanently exhausted for the life
   of the run. A reviewer who says "try N more times with this guidance" has no
   engine primitive to grant it.

[ADR-103](#adr-103-output-driven-dynamic-routing-decide--on_mismatch-rework--engine-170)'s
`on_mismatch` exhaustion carries the same fail-closed limitation (noted there as
tech debt). This ADR adds the two missing primitives as additive, opt-in
`rework` fields, reusing the existing transition fan-out + `node_attempts` ledger
+ `commentsVar` injection machinery, gated behind an engine bump.
[ADR-041](#adr-041-capability-registry-refs--agent-aware-mapping--runner-owned-native-materialization)
(capability enforcement) is untouched; **no migration of `runs`**, **no new
`MaisterError` code** (ADR-008 closed union → every refusal reuses `CONFIG`),
**no HITL wire change**.

**Decision:**

1. **`rework.onExhaustion: <outcome>` (on the loop-owning node) overrides A1 at
   that node.** When a node carries `rework` and the decision-time exhaustion
   check fires (`isRework && effective > maxLoops`), if `rework.onExhaustion` is
   set the runner routes via `transitions[onExhaustion]` through the **unchanged**
   `resolveTransition` + staleness/transition fan-out — it does NOT call
   `reworkExhaustionFromSnapshot` (the A1 path). The outcome is a free transition
   key (any string ∈ `transitions`), typically wired to a `human_review` node so
   the reviewer renders exhaustion context. When `onExhaustion` is **absent** the
   A1 branch (`fail | escalate | ship_with_warning`) runs **byte-identical** to
   today. `onExhaustion` is a routing transition, not a rework jump: it does not
   itself stale or increment the loop node further. A runtime allow-list guard
   re-asserts `onExhaustion ∈ transitions` keys (defense in depth, `CONFIG`
   otherwise) — mirroring the `decide` outcome guard.

2. **`rework.resetTargets: [<nodeId>...]` (on a human node) re-baselines loop
   counters.** When a `human` node finishes with a **rework** decision and its
   `rework.resetTargets` is set, each listed loop node's attempt counter is
   re-baselined to its current persisted attempt count, granting it a full fresh
   `maxLoops` budget on re-entry. The human's comment rides the existing
   `commentsVar → pendingInjectedVars` top-level-var channel into the re-entered
   loop (per the rework-prompt contract). `resetTargets` is **server-side**, not a
   reviewer choice — the HITL wire contract is unchanged (§8 below).

3. **Baseline storage = `node_attempts.rework_baseline` (migration `0086`, nullable
   integer, no default).** Chosen over a jsonb map on `runs`: the value is
   per-node and lives on the same ledger row that already owns attempt counting,
   so it is normalized, carries forward with each attempt, and needs no cross-row
   coordination. **Semantics:** `NULL ⇒ baseline 0` (byte-identical to today's
   ledger). The value is the attempt number at which the node's current rework
   *epoch* began. **Carry-forward (write):** `appendNodeAttempt` stamps the new
   row's `rework_baseline` = the node's prior attempt's `rework_baseline` (or
   `NULL`/0 if none). **Reset (write):** `UPDATE` the node's latest attempt row's
   `rework_baseline` to that node's current persisted attempt count; the next
   `appendNodeAttempt` carries it forward.

4. **Effective attempts are baseline-aware at BOTH exhaustion sites.**
   `effective = nodeAttemptNumber − (baseline ?? 0)`, evaluated identically at the
   loop-top backstop and the decision-time exhaustion check (total allowed =
   `maxLoops + 1`, no off-by-one). A shared pure helper
   `effectiveAttempts(attemptNumber, baseline)` owns the subtraction (DRY,
   unit-tested at the `maxLoops+1` boundary). A flow using neither new field has a
   `NULL` baseline at every node → effective == attemptNumber → identical
   exhaustion behavior and an identical attempt ledger vs `main` (back-compat).

5. **Compile-time + load-time validation.** A node is refused (`CONFIG`) when:
   `onExhaustion` is present without `rework` or with an outcome ∉ `transitions`
   keys; `resetTargets` is present without `rework`; any `resetTargets[i]` is not a
   graph node id, is not itself a rework-loop node (target has no `rework`), or is
   not reachable from the human node via its `rework.allowedTargets` transitive
   forward chain (a reset must target a loop the rework re-enters). The validator
   `verifyReworkReset` mirrors `verifyDecideAndOnMismatch` and wires into
   `compileGraph`.

6. **Engine `2.0.0 → 2.1.0` (additive, backward compatible).** A manifest where
   ANY node's `rework` declares `onExhaustion` or `resetTargets` MUST declare
   `compat.engine_min >= 2.1.0`; `loadFlowManifest` rejects otherwise (`CONFIG`),
   mirroring the `DECIDE_ENGINE_MIN`/`SESSIONS_ENGINE_MIN` gates
   (`REWORK_RESET_ENGINE_MIN = "2.1.0"`). Manifests declaring neither field stay
   valid at their pinned floor.

7. **Bounding — two independent `maxLoops` close the recursion hole.** The loop
   node's `maxLoops` bounds iterations **per round**; the human node's OWN
   `rework.maxLoops` bounds the number of **reset rounds** (each human rework is a
   visit to the human node → its `gateAttempt` increments). The human node's own
   exhaustion uses the STANDARD A1 path (it is a human node with a non-empty
   `finishHuman.decisions`), which default-`escalate`s to re-pause it
   ("rounds spent — approve or end"). No recursion; naturally bounded.

8. **Single-transaction reset; HITL wire unchanged.** The reset `UPDATE`s commit
   in the SAME `db.transaction` as `markNodeReworked` (human node) +
   `markDownstreamStale` — no partial-state crash window, and a crash after commit
   self-heals because the next `appendNodeAttempt` reads the persisted baseline. A
   target with zero prior attempts is a no-op (its epoch already starts at 0). The
   human node's HITL already carries `{allowedDecisions, transitions,
   reworkTargets, workspacePolicies, maxLoops, gateAttempt}`; `resetTargets` is a
   server-side rework effect, not a reviewer-selectable field → **no new HITL wire
   field**.

**Consequences:**
- An authored autonomous loop can deterministically escalate exhaustion to a
  named human node and let that human grant a fresh budget — closing the
  ADR-103 "fail-closed, discards the worktree" gap for human-supervised loops,
  without an execution-policy dependency.
- The transition fan-out, readiness guard, and `isRework`/loop-advance logic are
  **unchanged** — `onExhaustion` is just another outcome string the existing
  machinery maps to a target/terminal.
- **Crash-window parity for reset:** unlike ADR-103's non-transactional
  `on_mismatch` rework, the `resetTargets` re-baseline is folded into the
  existing human-rework transaction (`markNodeReworked` + `markDownstreamStale`),
  so there is no new partial state; recovery is the persisted-baseline carry
  forward.
- **One column added** (`node_attempts.rework_baseline integer`, nullable,
  migration `0086`) and a `+1` engine minor. No `runs` migration, no env var, no
  port, no sidecar, no HTTP route, no SSE/AsyncAPI event, no `runs.status`/enum
  value, no new `MaisterError` code, no `compose.yml` change.
- **Two `maxLoops` is now a documented contract** (loop iterations per round ≠
  reset rounds) — a flow author wiring `onExhaustion`/`resetTargets` must
  understand both bounds (captured in `flow-dsl.md` + `flow-graph.md`).

**Alternatives Considered:**
- **jsonb baseline map on `runs`:** rejected — the baseline is per-node and the
  `node_attempts` row already owns attempt counting; a normalized column carries
  forward per attempt with no cross-row coordination, whereas a `runs` jsonb
  would need a read-modify-write under the run lock on every reset and a parallel
  read at both exhaustion sites.
- **Reuse the A1 `escalate` action for the human handoff:** rejected — A1 is
  run-policy-scoped (`reworkExhaustion`), so it cannot target a specific author-
  chosen node, and it does not grant a fresh budget. `onExhaustion` is an
  author-scoped routing override that composes with `resetTargets`.
- **A fixed `exhausted` literal outcome** (instead of a free transition key):
  rejected — a free key lets the author name the outcome to match their
  transition table (`exhausted`, `escalate_to_lead`, …) and render distinct
  human context; the compile + runtime allow-list guards already constrain it to
  declared `transitions`.
- **A `rework_epoch` counter column** (increment per reset) instead of
  `rework_baseline` (snapshot the attempt count): rejected — the baseline is read
  directly as the subtrahend at both exhaustion sites (`attemptNumber − baseline`)
  with no extra arithmetic, and carry-forward is a literal copy; an epoch counter
  would require a second per-attempt count to derive the effective number.

---

### ADR-119: Manual force-relaunch (additive concurrent runs per task) + atomic attempt-number allocation

**Date:** 2026-06-30
**Status:** Accepted
**Context:** A task → runs relationship is 1:N (retry / ralph-loop), but every
launch entry point gates on `classifyManualTaskLaunchability`, whose
`MANUAL_RUN_STATUS_LAUNCHABILITY` map returns `busy` for every non-terminal run
status (`Pending/Running/NeedsInput/NeedsInputIdle/HumanWorking/WaitingOnChildren`).
So a new run cannot start while a prior run for the same task is still active.
Operators running supervised loops want to fire **another** run from the task
runs-history view *while one is still running* — without cancelling or
superseding the active attempt. The board flight-card and all scheduled /
auto-launch paths must keep the `busy` gate (the one-way latch + auto-launch
tick must never fan out concurrent runs on their own).

Relaxing the run-status gate exposes a latent race: the run branch is
`${branchPrefix}task-${taskId}/attempt-${task.attemptNumber + 1}`, computed from
a **stale read** of `tasks.attempt_number`; the increment commits later in the
main launch transaction. Today the `busy` gate makes two concurrent launches of
one task impossible, so the race is unreachable. Force-relaunch makes it
reachable: two simultaneous launches both compute `attempt-2`, the first
`git worktree add -b` creates the branch, the second collides and fails
`CONFLICT`. (Worktree *paths* are `runId`-keyed, so they never collide — only
branch names do.) **ADR-008** (closed `MaisterError` union) and **ADR-009**
(global concurrency cap) are untouched; **no migration**, **no new error code**,
**no deployment change**.

**Decision:**

1. **A force-relaunch classifier widens only the run-status gate.**
   `classifyForceRelaunchLaunchability(task, latestRun, relationGate)` mirrors
   `classifyManualTaskLaunchability`'s signature (no `flowId` ⇒ no
   `unconfigured` case) and reuses the same `flagged`/`blocked` predicate
   helpers (DRY). It NEVER produces the `busy` run-status verdict — run status is
   deliberately not consulted. Precedence, highest refusal first:
   `flagged (task.triageStatus==="flagged") > blocked (open blocking relation) >
   launchable`. The allow-list (only `flagged`/`blocked` refuse) is documented so
   a future `RunStatus` cannot silently change force behaviour.

2. **`allowConcurrent` body flag selects the classifier.** `POST /api/runs`
   gains an optional `allowConcurrent` boolean (default `false`). When `true`,
   `launchRunStaged` gates on `classifyForceRelaunchLaunchability`; otherwise on
   `classifyManualTaskLaunchability` (byte-identical to today). The
   throw-on-not-launchable behaviour is unchanged — only the classifier swaps, so
   a `blocked`/`flagged` task with `allowConcurrent:true` still gets
   `PRECONDITION`. The flag is gated behind the existing
   `requireProjectAction(projectId,"launchRun")` — no new auth path; it widens
   only the run-status gate, never the task gates. It is a body-controlled
   behaviour flag, not a cross-resource locator (`projectId` is still derived
   from the task row).

3. **`GET /api/runs/launch-options` carries an additive `relaunch` field.** The
   response gains `relaunch: { launchable: boolean, reason: VerdictCode }`
   computed with `classifyForceRelaunchLaunchability`, alongside the unchanged
   `launchability` (manual). One fetch serves both the header (manual) and the
   runs-history (force) buttons with the correct verdict each; fully
   backward-compatible (no param change, existing callers ignore the field). The
   second classifier runs over the same in-memory data — negligible cost. Chosen
   over a `mode` query param because the page renders both buttons; one response
   avoids a second fetch and any chance of the wrong classifier. The `relaunch`
   verdict layers the SAME flow-setup issues as the manual `launchability` (a flow
   disabled/dropped after the task's first run → `not_enabled`/`flow_missing`/…):
   run status is still never consulted, but a non-launchable flow disables the
   runs-history button up-front instead of failing the launch after submit — the
   server's flow-enablement checks in `launchRunStaged` remain the authoritative
   backstop.

4. **Atomic attempt-number allocation.**
   `UPDATE tasks SET attempt_number = attempt_number + 1 WHERE id = $taskId
   RETURNING attempt_number` reserves a distinct value per launch. This becomes
   the **sole** writer of `attempt_number`: the `attemptNumber` write is removed
   from the main launch transaction (the tx still writes `tasks.status="InFlight"`).
   Leaving it would let a slower concurrent launch clobber a higher value. The
   allocation runs **after every cheap precondition** (the launchability gate, the
   branch allow-list validation, base-commit resolution) and immediately before
   `addWorktree`, so an input-driven refusal never burns a number — important
   because `attempt_number` doubles as the ralph-loop retry high-water mark. Crash
   windows are clean retryable non-states: only an `addWorktree`/tx failure after
   allocation burns the number (a monotonic-counter gap, no meaning) and leaves no
   run row / no worktree / `tasks.status` untouched; the existing
   post-`addWorktree` `removeWorktree` compensation is unchanged.

5. **Additive concurrency is latest-run-safe.** >1 non-terminal run per task is
   allowed. Board column, manual launchability, reconcile, promotion, and
   scheduler are all latest-run / per-run / global-count based, so they tolerate
   multiple live runs unchanged. The concurrency cap counts live runs globally —
   two live runs of one task correctly count as 2; extras queue `Pending` with a
   `queuePosition`. The runs-history `totals`/`latest` keep reducing over **all**
   runs even after display rows are capped to the 10 newest.

6. **Same `run_launched` activity; no new kind.** A force-relaunch reuses
   `launchRun`, so each launch records the same `run_launched` `task_activity`
   (ADR-078) and the social-board `inbox_items` fan-out — per launch, even when
   the task is already `InFlight` (a creation, not a restart). No new
   activity/event kind, and **no** `domain_events` outbox row is involved.

**Consequences:**
- Operators can fan out additional runs from the task runs-history view while a
  prior run is live, bounded by the global cap; the running attempt is never
  cancelled or superseded.
- The branch-name race that the relaxed gate would otherwise expose is closed by
  the atomic counter bump — proven against real Postgres (mocked-unit tests are
  blind to the row-level race).
- Scheduled / auto-launch / run-schedule paths and the board flight-card keep
  the `busy` gate (they never set `allowConcurrent`), so no path auto-fans
  concurrent runs.
- Per-relaunch `run_launched` + inbox fan-out volume grows with long ralph-loops
  (pre-existing in kind, new in frequency) — flagged for throttling if it
  becomes noisy; no schema change.
- **Manual relaunches share the ralph-loop attempt budget (intended).** Each
  successful force-relaunch bumps `tasks.attempt_number`, which the ralph-loop
  consumer (`MAISTER_RALPH_MAX_ATTEMPTS`) reads as the per-task max-attempt
  high-water mark. So manual and auto relaunches draw from ONE bounded counter:
  several manual relaunches advance the auto-relaunch ceiling. This is the desired
  semantics (total attempts per task are bounded regardless of who fired them),
  not a leak — but it means a long manual fan-out can reach the ralph cap and
  quiesce auto-relaunch.
- **Zero migration / zero new error code / zero deployment touchpoint**: only
  allocation timing and gate selection change.

**Alternatives Considered:**
- **A `mode=manual|force` query param on launch-options** instead of an additive
  `relaunch` field: rejected — the page renders both buttons, so a single
  response carrying both verdicts avoids a second fetch and removes the risk of
  the client sending the wrong mode.
- **A separate force-relaunch route / new error code:** rejected — the launch
  path, permission, and refusal codes are identical; only the classifier
  differs. Reusing `POST /api/runs` + `PRECONDITION`/`CONFLICT` keeps ADR-008's
  closed union intact.
- **Cancel/supersede the running attempt (one-active-run invariant preserved):**
  rejected — the product wants additive concurrency (ralph-loop), and the
  scheduler + cap already bound resource spend.
- **Keep the stale-read allocation and serialize launches with an advisory
  lock:** rejected — an atomic `UPDATE … RETURNING` is simpler, needs no lock
  bookkeeping, and makes each launch's attempt number self-evidently distinct.

---

### ADR-120: Artifact body injection into prompts

**Date:** 2026-06-30
**Status:** Accepted
**Context:** A graph flow node can already reference a prior artifact's
**metadata** in its prompt — `{{ artifacts.<id>.kind / uri / validity / nodeId }}`
(M12, ADR-037) — and the prior step's stdout via an 8 KiB-capped
`{{ steps.<id>.output }}` slice. What it cannot reach is the artifact **body**:
the resolved diff, plan, log, test report, or JSON verdict a previous node
produced. The payload is reachable only over the browser-facing
`GET /api/runs/{runId}/artifacts/{artifactId}/payload` route. Without a render-time
accessor, a downstream node must re-derive context a prior node already produced
(re-run the diff, re-read the plan) — wasted tokens and a correctness risk when the
re-derivation drifts from the original. This is PV-gap **P2** (forward-handoff of
one node's output into the next node's prompt).

**Decision:** Add two render-time surfaces, both **graph-only** (the canonical
`nodes[]` runtime), no DB migration, no new HTTP route/event, no new
`MaisterError` code (reuse `CONFIG` / `PRECONDITION`):

1. **Manual placement** — `{{ artifacts.<id>.content }}` resolves the `current`
   artifact's body at render time. Author controls position. Absent content with
   no `?? default` ⇒ strict `CONFIG` (`undefined template var`), consistent with
   every other strict template var.

2. **Auto placement** — `input.requires: [{ artifact: <id>, kind: <k>, inline: true }]`
   appends a deterministic XML-tag-delimited block to the **rendered** prompt:
   `\n<artifact id="X" kind="K">\n…body…\n</artifact>`. The block is injected as a
   `{{ artifacts.X.content }}` **template tag** (resolved later by the shared
   `renderStrict`), NOT a string-concatenated body — so an artifact body containing
   literal `{{ … }}` is never re-processed (the **mustache re-render invariant**).

Locked sub-decisions:

- **D1 — XML-tag delimiter, not a markdown fence.** Artifact bodies routinely
  contain ` ``` ` fences (diffs, code, logs, plans); a fence wrapper collides and
  the boundary collapses. An XML tag has no fence collision (only a literal
  `</artifact>` in the body breaks it — far rarer) and Anthropic models are trained
  to respect XML document delimiters. The prompt stays markdown; only the delimiter
  is XML.
- **D5 — Engine floor `2.2.0` gates BOTH surfaces.** `inline: true` (grammar) AND
  any `{{ artifacts.<id>.content }}` reference (detected by a delimiter-aware
  manifest-load template scan sharing the runtime `collectContentArtifactIds`
  regex; the scan covers `action.prompt` + `cli.command` + **the field each
  `pre_finish` gate executor actually renders** — `ai_judgment`→`prompt`,
  `skill_check`/`command_check`→`command` — so load-time and runtime can never
  disagree) require `compat.engine_min >= 2.2.0`. Gating only `inline:true` left a
  cross-host hole — a package declaring `engine_min: 1.2.0` + `.content`, shared to
  an older host, would be accepted at load yet fail at runtime instead of being
  refused. The feature debuts at `2.2.0`; `MAISTER_ENGINE_VERSION` bumps
  `2.1.0 → 2.2.0`.
- **D7 — Shared resolver returns RAW content, no cap.** Locator→content resolution
  is extracted from `payload/route.ts`'s `switch(locator.kind)` into a server-only
  `resolveArtifactContent()` returning the **uncapped** value
  (`{kind:"text"} | {kind:"json"} | {kind:"gone"} | {kind:"notfound"}`), reused by
  **both** the route (delegates → HTTP contract byte-identical, incl. >256 KiB
  payloads) and the runner. Putting the inline cap inside the resolver would
  silently truncate the payload API.
- **D3/D11 — Cap at the injection seam only.** `capForInline()` truncates to
  256 KiB (`MAISTER_ARTIFACT_INLINE_MAX_BYTES`, default `262144`), UTF-8-boundary-
  safe, with an in-band marker, applied ONLY in the runner injection pipeline —
  never inside `resolveArtifactContent` and never on the payload route. The ordered
  named pipeline is `resolveArtifactContent` (raw) → `artifactContentToTemplateText`
  (json pretty-print) → `capForInline` (256 KiB) → `{ text, truncated }`. On the
  injection path the `file`-locator **read** is bounded to the cap (at most
  `cap + 1` bytes via a positioned read) and the `git-log` read streams bounded via
  `logRangeBounded` (truncating instead of throwing on overflow, unlike the
  uncapped `logRange`), so a huge artifact never loads its full payload into the web
  process before truncation; the payload route passes no bound (full read, contract
  unchanged).
- **Injectable id grammar.** An artifact id used via `inline: true` is
  interpolated into the auto-append XML attribute AND a dotted Mustache path, so it
  MUST be a slug (`^[A-Za-z0-9_-]+$`, the scan's character class). A non-slug id is
  refused at load (`CONFIG`) — it would otherwise render malformed XML / an
  unresolvable template at run time.
- **Skipped gates are excluded from resolution; everything resolved is strict.**
  Pre-action content resolution collects `action.prompt`/`cli.command`/`inline` ids
  PLUS the refs of NON-skipped gates only — the runner passes a skip-aware
  `includeGate` predicate (`!isPolicySkippedGate(checks, kind)`) so an
  execution-policy-skipped gate (`checks=skip`) does no content work and its gone
  payload can never fail the node. Every ref that IS resolved is strict: a
  gone/notfound payload fails the node with a controlled `CONFIG` before spawn
  (parity with the `input.requires` PRECONDITION) — never an uncontrolled mid-gate
  `renderStrict` throw that would leave a half-created gate row. (Revised from the
  round-2 tolerant-defer, which turned a non-skipped gate's gone ref into that
  uncontrolled throw.)
- **D9 — `gate-verdict`/`hitl-response` inject as pretty JSON** via the single
  named converter `artifactContentToTemplateText(result)` (`kind:"json"` →
  `JSON.stringify(value, null, 2)`; `kind:"text"` → `text`), so a JSON locator can
  never silently become `[object Object]`. Inline is allowed for every locator kind.
- **D8 — Validity = current-wins.** Content resolves from the `current` artifact
  row. No current row → strict `CONFIG` (`{{…content}}`) or the existing
  `input.requires` `PRECONDITION` (`inline:true`).
- **D12 — `inline: true` valid ONLY on prompt-bearing runner nodes**
  (`ai_coding` / `judge` / `orchestrator`); on `cli` / `check` / `human` / `form`
  it is refused at manifest validation (`CONFIG`). Auto-append only makes sense for
  a prompt — appending an XML block to a shell `command` would corrupt it, and
  `human`/`form` have no prompt. Manual `{{ artifacts.X.content }}` still renders in
  any template (incl. `cli.command`).
- **D2 — Dedup guard.** If the node's `action.prompt` (the auto-append target)
  already references `artifacts.X.content`, the engine does NOT auto-append for `X`
  and emits a `WARN` — manual placement wins, single injection into the action
  prompt. Gate `prompt`s render in separate agent sessions, so a content ref there
  is not a double-injection of the action prompt and does not suppress the append;
  the gate-field + `cli.command` scan in `collectContentArtifactIds` drives content
  *resolution* and the engine *floor*, not this per-action-prompt dedup.
- **D4 — Graph `nodes[]` only.** `.content` lives in the shared
  `buildContext`/`reduceArtifacts` seam; the linear `runner.ts` path never populates
  it (no shipped flow uses linear `steps[]`). A linear flow referencing
  `{{ artifacts.X.content }}` gets a clean strict `CONFIG`.

**Consequences:**
- Forward-handoff needs zero prompt edits with `inline: true`; authors who want
  precise placement use the manual tag. No re-derivation of prior output.
- `compat.engine_min` stays honest across hosts — a `.content`-using package is
  refused at load on a sub-2.2.0 host, never silently broken at runtime.
- The payload API contract is preserved byte-for-byte: a >256 KiB `inline`/`file`
  artifact returns its full untruncated body through the route (the cap lives only
  at the prompt-injection seam). Existing payload-route tests pass unmodified.
- One shared resolver removes the route-vs-runner locator-switch drift (SRP/DRY);
  one named json→text converter removes the `[object Object]` failure mode.
- **Zero migration / zero new error code / zero new HTTP route / zero new event.**

**Alternatives Considered:**
- **Markdown ` ``` ` fence delimiter:** rejected (D1) — collides with fenced
  content in artifact bodies.
- **`.content` rides the existing 1.2.0 artifact floor:** rejected (D5) — leaves a
  cross-host portability hole; the whole feature debuts at 2.2.0 and gates both
  surfaces.
- **Cap inside `resolveArtifactContent` / on the payload route:** rejected (D7) —
  silently truncates the payload API; the cap is an injection-only concern.
- **String-concatenate the resolved body into the prompt then re-render:** rejected
  (D11) — re-processes literal `{{ … }}` in the body (corruption/`CONFIG`); inject
  only via the context var so mustache substitutes literally.
- **Allow `inline: true` on any node:** rejected (D12) — auto-append corrupts a CLI
  command and is a silent no-op on `human`/`form`; explicit refusal is clearer.

---

## Template for New Decisions

```markdown
---

### ADR-XXX: [Title]

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded
**Context:** [What is the issue and why does it need a decision?]

**Decision:** [What was decided?]

**Consequences:**
- [Positive/negative outcomes]
- [Trade-offs accepted]

**Alternatives Considered:**
- [Alternative 1]: [Why rejected]
- [Alternative 2]: [Why rejected]
```

---

*Decisions are numbered sequentially. Do not reuse numbers.*

---

## TODO (tracked doc defects)

- **acp-runner GET/POST/PATCH contract drift (resolved 2026-06-08).** Earlier the
  `web.openapi.yaml` admin acp-runner block documented `getAdminAcpRunners`
  returning `platformDefaultRunnerId` and
  `postAdminAcpRunner`/`patchAdminAcpRunner` returning `{ runner }`, while the
  code returned `defaultRunnerId` (+ `adapters`/`sidecars`) on GET and
  `{ ok, id }` / `{ ok }` on POST/PATCH. The OpenAPI block was synced to the code
  in the same `feature/acp-runner-crud-config` branch (GET →
  `defaultRunnerId`/`adapters`/`sidecars`; POST → `{ ok, id }`; PATCH → `{ ok }`),
  alongside the ADR-065 DELETE (204) + dup-id (409) alignment.
- **Duplicate `### ADR-048` heading (resolved).** The collision was resolved by renumbering the M18
  "Branch targeting at launch, shared promotion service, promote-time readiness re-gate" ADR to
  **ADR-058**; the M15 "Readiness enforcement over all blocking gate kinds + verdict calibration" ADR
  keeps **ADR-048**.
- **Stale `artifact_required` branch in `flow-graph.md` "Gate dispatch by kind" diagram (filed
  2026-06-10).** The diagram (and one Edge-cases bullet) still shows `artifact_required` as
  `skipped + WARN + TODO(M12)`, but the executor shipped with M12 (`gates-exec.ts` checks
  `inputArtifacts` currency). The M11a-era diagram branch should be redrawn to the implemented
  dispatch when that file is next reworked.
- **Missing Index rows for ADR-098/099/100 (filed 2026-06-22, RESOLVED 2026-06-22).** The M37 merge
  added the ADR-098/099/100 bodies but not their `## Index` rows; the shared-worktree branch
  (ADR-102) backfilled them during its rebase onto the cost-budget-merged main — the Index now lists
  097 → 098 → 099 → 100 → 101 → 102 with correct anchor slugs.
