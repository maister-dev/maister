# Architectural Decisions

> **Purpose.** The ADR log is the single source of truth for every locked
> architectural and technical decision in MAIster. Every entry is an ADR
> — Architectural Decision Record — that captures _why_ the project does
> something a particular way, what was rejected, and at what cost.
>
> **Layout.** This file is the **hub**: the index, one stub per ADR
> (heading + `Status` + `Date` + link), the template, and the doc-defect
> TODO list. Each full record lives in
> [`decisions/adr-NNN.md`](decisions/). The `### ADR-NNN:` headings here
> are the anchor targets every `decisions.md#adr-NNN` link in docs and
> code resolves against — never rename or remove them.
>
> **When to add an ADR.** During feature discussion, modeling, or
> documenting. If a code-level discussion turns into a tradeoff that
> shapes more than one component, lift the answer into an ADR before
> writing the code.
>
> **Editing rules.**
>
> - Numbering is sequential and **immutable**. Never reuse a number.
> - The original decision text of an `Accepted` ADR stays immutable. To
>   change direction, write a **new ADR** that supersedes it and set the
>   old one's `Status` to `Superseded by ADR-XXX`.
> - **Amendments.** A delta that does NOT change the direction (a default
>   raised, a mechanism refined by a follow-on ADR) MAY be recorded by
>   appending a dated bullet to an `**Amendments:**` list at the end of
>   the record body — never by rewriting the decision text.
> - `Status` and `**Amendments:**` are living metadata: keep them current
>   (`Implemented`, `Amended by ADR-YYY`, `Superseded by ADR-ZZZ`). Edit
>   the record body first, then mirror the stub here — `pnpm
validate:docs` enforces stub ↔ body equality and the file bijection.
> - One decision per ADR. If you feel a need for "ADR-007a" / "ADR-007b",
>   split into two ADRs.
> - **New ADR flow:** create `decisions/adr-NNN.md` from the template at
>   the bottom, then add the stub section and the index row here.

---

## Index

| #                                                                                                                                                            | Title                                                                                                                                          | Status                                                               | Date       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------- |
| [ADR-001](#adr-001-nextjs-16--heroui-v3-as-the-web-stack)                                                                                                    | Next.js 16 + HeroUI v3 as the web stack                                                                                                        | Accepted                                                             | 2026-05-22 |
| [ADR-002](#adr-002-supervisor-runs-as-a-separate-node-daemon)                                                                                                | Supervisor runs as a separate Node daemon                                                                                                      | Accepted                                                             | 2026-05-25 |
| [ADR-003](#adr-003-acp-as-the-agent-runtime-protocol)                                                                                                        | ACP as the agent runtime protocol                                                                                                              | Accepted                                                             | 2026-05-25 |
| [ADR-004](#adr-004-multi-runner-claude--codex-on-current-target)                                                                                             | Multi-runner: claude + codex on current target                                                                                                 | Accepted                                                             | 2026-05-25 |
| [ADR-005](#adr-005-model-routing-env-router-default-ccr-optional)                                                                                            | Model routing: env-router default, CCR optional                                                                                                | Partially superseded by ADR-164                                      | 2026-05-25 |
| [ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume)                                                                                                 | Hybrid HITL: keep-alive + checkpoint/resume                                                                                                    | Accepted                                                             | 2026-05-25 |
| [ADR-007](#adr-007-sse-pipe-to-disk-for-step-output)                                                                                                         | SSE pipe-to-disk for step output                                                                                                               | Accepted                                                             | 2026-05-22 |
| [ADR-008](#adr-008-typed-error-taxonomy-maistererror)                                                                                                        | Typed error taxonomy (`MaisterError`)                                                                                                          | Accepted                                                             | 2026-05-22 |
| [ADR-009](#adr-009-global-concurrency-cap--3)                                                                                                                | Global concurrency cap = 3                                                                                                                     | Accepted; amended by ADR-089/090                                     | 2026-05-22 |
| [ADR-010](#adr-010-flow-engine-v2-plugin-packaging--step-dsl)                                                                                                | Flow Engine v2: plugin packaging + step DSL                                                                                                    | Accepted                                                             | 2026-05-25 |
| [ADR-011](#adr-011-workspace-lifecycle-via-git-worktree)                                                                                                     | Workspace lifecycle via git worktree                                                                                                           | Accepted                                                             | 2026-05-22 |
| [ADR-012](#adr-012-local-promotion-merge-policy---no-ff-abort-on-conflict)                                                                                   | Local promotion merge policy: `--no-ff`, abort on conflict                                                                                     | Accepted                                                             | 2026-05-22 |
| [ADR-013](#adr-013-postgres-16-primary-sqlite-dev-drizzle-orm)                                                                                               | Postgres 16 primary, SQLite dev, Drizzle ORM                                                                                                   | Superseded by ADR-131                                                | 2026-05-22 |
| [ADR-014](#adr-014-i18n-en--ru-from-day-one)                                                                                                                 | i18n: EN + RU from day one                                                                                                                     | Accepted                                                             | 2026-05-22 |
| [ADR-015](#adr-015-pnpm-workspace-node-24)                                                                                                                   | pnpm workspace, Node 24                                                                                                                        | Accepted                                                             | 2026-05-22 |
| [ADR-016](#adr-016-mermaid-as-the-only-diagramming-language-for-docs)                                                                                        | Mermaid as the only diagramming language for docs                                                                                              | Accepted                                                             | 2026-05-26 |
| [ADR-017](#adr-017-openapi-303--asyncapi-260-as-api-contract-formats)                                                                                        | OpenAPI 3.0.3 + AsyncAPI 2.6.0 as API contract formats                                                                                         | Accepted                                                             | 2026-05-26 |
| [ADR-018](#adr-018-task--run-cardinality-is-1n)                                                                                                              | Task ↔ Run cardinality is 1:N                                                                                                                 | Accepted                                                             | 2026-05-22 |
| [ADR-019](#adr-019-project-slug--repopath-uniqueness-soft-archival)                                                                                          | Project slug + repo_path uniqueness, soft archival                                                                                             | Accepted                                                             | 2026-05-22 |
| [ADR-020](#adr-020-fastify--pino-in-the-supervisor)                                                                                                          | Fastify + pino in the supervisor                                                                                                               | Accepted                                                             | 2026-05-25 |
| [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility)                                                                            | Flow package lifecycle: multi-revision, trust, and compatibility                                                                               | Accepted (amended by ADR-088: a package groups multiple flow source… | 2026-05-30 |
| [ADR-022](#adr-022-structured-run-data-projection--runeventsjsonl-is-the-event-log-postgres-holds-derived-read-models)                                       | Structured run-data projection — `run.events.jsonl` is the event log, Postgres holds derived read-models                                       | Accepted                                                             | 2026-05-30 |
| [ADR-023](#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)                                                                               | Run `web` + `supervisor` on the host; containerize only Postgres                                                                               | Accepted                                                             | 2026-05-30 |
| [ADR-024](#adr-024-external-operations-surface--rest--thin-mcp-facade-project-tokens-mandatory-audit-hitl-assessment--flow-owned-escalation)                 | External operations surface — REST + thin MCP facade, project tokens, mandatory audit, HITL assessment & Flow-owned escalation                 | Accepted                                                             | 2026-05-30 |
| [ADR-025](#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)                                                 | Project repo onboarding — URL clone or local path, host-credential auth, configurable roots                                                    | Accepted                                                             | 2026-05-31 |
| [ADR-026](#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump)                                                                                        | Flow graph manifest v1 (`nodes[]`) + engine version bump                                                                                       | Accepted                                                             | 2026-05-30 |
| [ADR-027](#adr-027-append-only-nodeattempts-run-ledger)                                                                                                      | Append-only `node_attempts` run ledger                                                                                                         | Accepted                                                             | 2026-05-30 |
| [ADR-028](#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)                                                                                       | Full-featured gate execution in M11a; M15 re-scoped                                                                                            | Accepted                                                             | 2026-05-30 |
| [ADR-029](#adr-029-split-m11-into-m11a--m11b--m11c)                                                                                                          | Split M11 into M11a / M11b / M11c                                                                                                              | Accepted                                                             | 2026-05-30 |
| [ADR-030](#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status)                                                                          | Manual takeover as a local worktree handoff (`HumanWorking` status)                                                                            | Accepted                                                             | 2026-05-31 |
| [ADR-031](#adr-031-node-typed-settings-schema-carve-b)                                                                                                       | Node typed settings schema (carve (b))                                                                                                         | Accepted                                                             | 2026-06-01 |
| [ADR-032](#adr-032-settings-enforcement-refusal-boundary)                                                                                                    | Settings-enforcement refusal boundary                                                                                                          | Accepted                                                             | 2026-06-01 |
| [ADR-033](#adr-033-crash-reconciliation-model-startup--periodic-sweeper-allow-list-running-only)                                                             | Crash reconciliation model (startup + periodic sweeper, allow-list `Running`-only)                                                             | Accepted                                                             | 2026-06-01 |
| [ADR-034](#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)                                        | Crashed-run recovery semantics (hybrid `--resume` + re-dispatch, durable-marker-first, cap re-admission)                                       | Accepted                                                             | 2026-06-01 |
| [ADR-035](#adr-035-graceful-workspace-gc-preserve-then-prune)                                                                                                | Graceful workspace GC (preserve-then-prune)                                                                                                    | Accepted                                                             | 2026-06-01 |
| [ADR-036](#adr-036-flow-revision-gc)                                                                                                                         | Flow-revision GC                                                                                                                               | Accepted                                                             | 2026-06-01 |
| [ADR-037](#adr-037-typed-artifact-model)                                                                                                                     | Typed artifact model                                                                                                                           | Accepted                                                             | 2026-06-01 |
| [ADR-038](#adr-038-hybrid-write-path-for-artifactinstances-refines-adr-022)                                                                                  | Hybrid write path for `artifact_instances` (refines ADR-022)                                                                                   | Accepted                                                             | 2026-06-01 |
| [ADR-039](#adr-039-xyflowreact--dagrejsdagre-as-the-evidence-graph-renderer)                                                                                 | `@xyflow/react` + `@dagrejs/dagre` as the evidence-graph renderer                                                                              | Accepted                                                             | 2026-06-01 |
| [ADR-040](#adr-040-assignment-actors-and-role-owned-work-queue)                                                                                              | Assignment actors and role-owned work queue                                                                                                    | Accepted                                                             | 2026-06-02 |
| [ADR-041](#adr-041-capability-registry-refs--agent-aware-mapping--runner-owned-native-materialization)                                                       | Capability registry refs + agent-aware mapping + runner-owned native materialization                                                           | Accepted; delivery half superseded by ADR-044                        | 2026-06-02 |
| [ADR-042](#adr-042-conservative-spike-gated-enforcement-flip-claude-first)                                                                                   | Conservative spike-gated enforcement flip; claude-first                                                                                        | Superseded by ADR-130                                                | 2026-06-02 |
| [ADR-043](#adr-043-capability-import-reuses-the-flow-install-fetchtrustexecute-pipeline)                                                                     | Capability import reuses the flow-install fetch→trust→execute pipeline                                                                         | Accepted                                                             | 2026-06-02 |
| [ADR-045](#adr-045-externalcheck-enforcement-via-the-review-chokepoint-m16m15m18-carve)                                                                      | External_check enforcement via the Review chokepoint; M16/M15/M18 carve                                                                        | Accepted                                                             | 2026-06-02 |
| [ADR-046](#adr-046-project-api-token-model)                                                                                                                  | Project API token model                                                                                                                        | Accepted                                                             | 2026-06-02 |
| [ADR-047](#adr-047-thin-mcp-facade-as-a-standalone-rest-client-package)                                                                                      | Thin MCP facade as a standalone REST-client package                                                                                            | Accepted                                                             | 2026-06-02 |
| [ADR-048](#adr-048-readiness-enforcement-over-all-blocking-gate-kinds--verdict-calibration-m15)                                                              | Readiness enforcement over all blocking gate kinds + verdict calibration (M15)                                                                 | Accepted                                                             | 2026-06-03 |
| [ADR-044](#adr-044-capability-delivery-via-settingslocaljson--acp-newsession-cli-flag-mechanism-disproven)                                                   | Capability delivery via `settings.local.json` + ACP `newSession` (CLI-flag mechanism disproven)                                                | Accepted                                                             | 2026-06-03 |
| [ADR-058](#adr-058-branch-targeting-at-launch-shared-promotion-service-promote-time-readiness-re-gate-m18m15-carve)                                          | Branch targeting at launch, shared promotion service, promote-time readiness re-gate (M18/M15 carve)                                           | Accepted                                                             | 2026-06-03 |
| [ADR-049](#adr-049-pr-promotion-via-a-hybrid-provider-pradapter-credential-model-b-reverses-the-gh-is-never-invoked-invariant)                               | PR promotion via a hybrid provider `PrAdapter` (credential model B); reverses the "gh is never invoked" invariant                              | Accepted                                                             | 2026-06-03 |
| [ADR-050](#adr-050-platform-acp-runners-adapter-provisioners-and-router-sidecars)                                                                            | Platform ACP runners, adapter provisioners, and router sidecars                                                                                | Partially superseded by ADR-164                                      | 2026-06-03 |
| [ADR-051](#adr-051-flow-graph-layout-metadata-store-project-scoped-flowid-keyed)                                                                             | Flow-graph layout metadata store (project-scoped, `flow_id`-keyed)                                                                             | Accepted                                                             | 2026-06-05 |
| [ADR-052](#adr-052-live-node-status-coloring-via-sse-triggered-graph-status-refetch)                                                                         | Live node-status coloring via SSE-triggered `graph-status` refetch                                                                             | Accepted                                                             | 2026-06-05 |
| [ADR-053](#adr-053-workbench-file-tree-git-tracked-only-member-gated-reads)                                                                                  | Workbench file-tree: git-tracked-only, member-gated reads                                                                                      | Accepted _(partially superseded)_                                    | 2026-06-05 |
| [ADR-054](#adr-054-hitl-assessment-taxonomy--flow-declared-criticality-vs-responder-humanconfidence-annotate-not-re-gate)                                    | HITL assessment taxonomy — flow-declared `criticality` vs responder `human_confidence`, annotate-not-re-gate                                   | Implemented                                                          | 2026-06-05 |
| [ADR-055](#adr-055-hitl-response-service--hitl-over-mcp--token-actor--actor-kindscope-auth-gates)                                                            | HITL response service + HITL-over-MCP + token-actor + actor-kind/scope auth gates                                                              | Implemented                                                          | 2026-06-05 |
| [ADR-056](#adr-056-flat-runner-onrejectgotostep-atomic-execution--single-tx-repark-dedicated-comments-channel-window-sentinel-invalidation)                  | Flat-runner `on_reject.goto_step` atomic execution — single-tx repark, dedicated comments channel, window-sentinel invalidation                | Superseded by ADR-131                                                | 2026-06-05 |
| [ADR-057](#adr-057-hitl-hybrid-surface-composition--cross-project-inbox-block-inline-response-component-numeric-needs-you-n-badge)                           | HITL hybrid-surface composition — cross-project Inbox block, inline response component, numeric "Needs you (N)" badge                          | Implemented                                                          | 2026-06-05 |
| [ADR-059](#adr-059-read-only-observatory-formulas-and-harvest-priority)                                                                                      | Read-only Observatory formulas and harvest priority                                                                                            | Accepted                                                             | 2026-06-05 |
| [ADR-060](#adr-060-unified-scheduler-clock-and-polymorphic-job-budgets)                                                                                      | Unified scheduler clock and polymorphic job budgets                                                                                            | Accepted                                                             | 2026-06-05 |
| [ADR-061](#adr-061-local-authored-capability-catalog-lifecycle)                                                                                              | Local authored capability catalog lifecycle                                                                                                    | Implemented                                                          | 2026-06-05 |
| [ADR-062](#adr-062-platform-user-administration--project-member-management-admin-surface-carve)                                                              | Platform user administration + project member management (admin-surface carve)                                                                 | Implemented                                                          | 2026-06-07 |
| [ADR-063](#adr-063-structured-node-output-channel-p1--run-context-file-p7)                                                                                   | Structured node output channel (P1) + run-context file (P7)                                                                                    | Accepted                                                             | 2026-06-07 |
| [ADR-064](#adr-064-authored-flow-graph-layout-in-the-flowyaml-presentation-section)                                                                          | Authored flow-graph layout in the flow.yaml presentation section                                                                               | Implemented                                                          | 2026-06-07 |
| [ADR-065](#adr-065-platform-acp-runner-crud-in-settings--hard-delete-blocked-by-any-usage-reference)                                                         | Platform ACP runner CRUD in `/settings` — hard delete blocked by any usage reference                                                           | Implemented                                                          | 2026-06-08 |
| [ADR-067](#adr-067-flow-editor-write-path--canvas-edits-as-m25-authored-flow-drafts-with-hard-gate-before-persist)                                           | Flow editor write path — canvas edits as M25 authored flow drafts with hard-gate before persist                                                | Accepted                                                             | 2026-06-08 |
| [ADR-068](#adr-068-authoredexecutable-flow-bridge--two-axis-trust-gate-supersedes-adr-061-publish-boundary)                                                  | Authored→executable flow bridge + two-axis trust gate (supersedes ADR-061 publish boundary)                                                    | Accepted                                                             | 2026-06-08 |
| [ADR-069](#adr-069-versionbinding-pinnedlatest--resolve-at-launch--unified-resolved-set-snapshot)                                                            | `version_binding` (pinned\|latest) + resolve-at-launch + unified resolved-set snapshot                                                         | Implemented                                                          | 2026-06-08 |
| [ADR-070](#adr-070-mcp--capability-management-model--3-scope-identity-local-first-precedence-platform-storage-setup-time-resolve)                            | MCP + capability management model — 3-scope identity, local-first precedence, platform storage, setup-time resolve                             | Implemented                                                          | 2026-06-08 |
| [ADR-071](#adr-071-user-facing-run-schedules-on-the-m24-clock)                                                                                               | User-facing run schedules on the M24 clock                                                                                                     | Accepted                                                             | 2026-06-10 |
| [ADR-072](#adr-072-pr-grade-review-comments--reviewcomments-table-snapshot-anchoring-runner-side-rework-compose-open-gate-guard)                             | PR-grade review comments — `review_comments` table, snapshot anchoring, runner-side rework compose, open-gate guard                            | Implemented                                                          | 2026-06-10 |
| [ADR-066](#adr-066-editor-and-diff-rendering-stack-shiki-git-diff-view-codemirror)                                                                           | Editor and diff rendering stack (Shiki, git-diff-view, CodeMirror)                                                                             | Implemented                                                          | 2026-06-08 |
| [ADR-073](#adr-073-harness-adequacy--coherence-metrics-read-only-observatory-extension)                                                                      | Harness adequacy & coherence metrics (read-only Observatory extension)                                                                         | Accepted                                                             | 2026-06-10 |
| [ADR-074](#adr-074-artifact-post-conditions--deterministic-mutation-sensor-on-artifactrequired-gates)                                                        | Artifact post-conditions — deterministic mutation sensor on `artifact_required` gates                                                          | Implemented                                                          | 2026-06-10 |
| [ADR-077](#adr-077-outbound-webhooks-generic-event-delivery-primitive-transactional-outbox--singleton-drainer)                                               | Outbound webhooks: generic event-delivery primitive, transactional outbox + singleton drainer                                                  | Implemented                                                          | 2026-06-10 |
| [ADR-075](#adr-075-flow-studio-phase-2-viewer-fork-to-authored-draft-kind-by-path-and-content-validation-severity)                                           | Flow Studio Phase 2 viewer, fork-to-authored-draft, kind-by-path, and content-validation severity                                              | Implemented                                                          | 2026-06-10 |
| [ADR-076](#adr-076-acp-runner-model-discovery-resolver-on-supervisor--configured-model-application)                                                          | ACP runner model discovery (resolver-on-supervisor) + configured-model application                                                             | Partially superseded by ADR-164                                      | 2026-06-11 |
| [ADR-078](#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality)                                                                           | Gate-chat at HITL pauses with three-layer workspace-neutrality                                                                                 | Implemented                                                          | 2026-06-11 |
| [ADR-079](#adr-079-node-workspacepolicy-execution-and-checkpoint-capture)                                                                                    | Node workspacePolicy execution and checkpoint capture                                                                                          | Implemented                                                          | 2026-06-11 |
| [ADR-080](#adr-080-node-level-retry-policy)                                                                                                                  | Node-level retry policy                                                                                                                        | Implemented                                                          | 2026-06-11 |
| [ADR-081](#adr-081-rework-session-policy-with-resume-by-default)                                                                                             | Rework session policy with resume-by-default                                                                                                   | Implemented                                                          | 2026-06-11 |
| [ADR-082](#adr-082-review-diff-completeness-with-dirty-state-protocol-and-scope-switcher)                                                                    | Review-diff completeness with dirty-state protocol and scope switcher                                                                          | Implemented                                                          | 2026-06-11 |
| [ADR-083](#adr-083-social-board-substrate--per-project-task-numbering-typed-relations-polymorphic-actor)                                                     | Social board substrate — per-project task numbering, typed relations, polymorphic actor                                                        | Implemented                                                          | 2026-06-11 |
| [ADR-084](#adr-084-acp-adapter-families-for-gemini-cli-and-opencode)                                                                                         | ACP adapter families for Gemini CLI and OpenCode                                                                                               | Implemented                                                          | 2026-06-11 |
| [ADR-085](#adr-085-mimo-code-as-a-distinct-acp-adapter-family)                                                                                               | MiMo Code as a distinct ACP adapter family                                                                                                     | Implemented                                                          | 2026-06-11 |
| [ADR-086](#adr-086-domain-event-outbox-as-the-shared-trigger-bus)                                                                                            | Domain-event outbox as the shared trigger bus                                                                                                  | Implemented                                                          | 2026-06-11 |
| [ADR-087](#adr-087-multi-run-launch-cost-accounting-and-delivery-policy-surfaces)                                                                            | Multi-run launch, cost accounting, and delivery-policy surfaces                                                                                | Implemented                                                          | 2026-06-11 |
| [ADR-088](#adr-088-multi-flow-package-management)                                                                                                            | Multi-flow package management                                                                                                                  | Implemented                                                          | 2026-06-12 |
| [ADR-089](#adr-089-platform-agent-catalog-with-per-agent-runner-and-a-five-source-trigger-model)                                                             | Platform agent catalog with per-agent runner and a five-source trigger model                                                                   | Implemented                                                          | 2026-06-12 |
| [ADR-090](#adr-090-agent-workspace-axis-with-three-layer-read-only-enforcement-and-quarantine)                                                               | Agent workspace axis with three-layer read-only enforcement and quarantine                                                                     | Accepted                                                             | 2026-06-12 |
| [ADR-091](#adr-091-flow-requirements-launch-precondition)                                                                                                    | Flow requirements launch precondition                                                                                                          | Accepted                                                             | 2026-06-13 |
| [ADR-092](#adr-092-flow-studio-redesign--unified-studio-ia--editable-local-package-model)                                                                    | Flow Studio redesign — unified Studio IA + editable-local-package model                                                                        | Accepted                                                             | 2026-06-15 |
| [ADR-093](#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)                                   | Project onboarding — optional `maister.yaml`, host-ambient git auth, onboarding modes, advisory clone reasons                                  | Implemented                                                          | 2026-06-17 |
| [ADR-094](#adr-094-default-runner-materialization-honest-readiness-and-ccr-admin-lifecycle)                                                                  | Default-runner materialization, honest readiness, and CCR admin lifecycle                                                                      | Partially superseded by ADR-164                                      | 2026-06-18 |
| [ADR-096](#adr-096-flow-studio-phase-c--editable-local-packages-variant-b-substrate-session-lock-member-rbac-git-backed-fork)                                | Flow Studio Phase C — editable local packages (Variant B): substrate, session lock, member RBAC, git-backed fork                               | Implemented                                                          | 2026-06-16 |
| [ADR-097](#adr-097-docked-ai-authoring-assistant--project-less-scratch-at-local-package-run-m36-phase-5)                                                     | Docked AI authoring assistant — project-less scratch-at-local-package run (M36 Phase 5)                                                        | Accepted                                                             | 2026-06-20 |
| [ADR-095](#adr-095-flow-execution-control-policy--snapshotted-preset--composable-autonomy-axes-fail-closed-no-blind-ship)                                    | Flow execution-control policy — snapshotted preset + composable autonomy axes, fail-closed, no-blind-ship                                      | Implemented                                                          | 2026-06-20 |
| [ADR-098](#adr-098-orchestrator-engine--supervisory-node-governed-run-tree-delegation-toolset-success-gated-task-dag-idle-checkpoint-waitresume)             | Orchestrator engine — supervisory node, governed run-tree, delegation toolset, success-gated task-DAG, idle-checkpoint wait/resume             | Implemented                                                          | 2026-06-20 |
| [ADR-099](#adr-099-persistent-swarm-layer-2--addressable-sessions-star-routed-messaging-worktree-modes-per-agent-read-only)                                  | Persistent swarm Layer 2 — addressable sessions, star-routed messaging, worktree modes, per-agent read-only                                    | Implemented                                                          | 2026-06-20 |
| [ADR-100](#adr-100-delegated-child-review-settle--promoterework)                                                                                             | delegated-child Review settle + promote/rework                                                                                                 | Implemented                                                          | 2026-06-20 |
| [ADR-101](#adr-101-cost-budget-governance--budget-execution-policy-axis-token-metered-warn-escalate-terminate-ladder-fail-open)                              | Cost-budget governance — budget execution-policy axis, token-metered, warn-escalate-terminate ladder, fail-open                                | Implemented                                                          | 2026-06-22 |
| [ADR-102](#adr-102-shared-worktree-tree-level-reviewpromote-ownership)                                                                                       | Shared-worktree tree-level review/promote ownership                                                                                            | Implemented                                                          | 2026-06-21 |
| [ADR-103](#adr-103-output-driven-dynamic-routing-decide--onmismatch-rework--engine-170)                                                                      | Output-driven dynamic routing (`decide`) + `on_mismatch` rework + engine 1.7.0                                                                 | Implemented                                                          | 2026-06-22 |
| [ADR-104](#adr-104-global-personal-api-tokens-via-nullable-project-token-binding)                                                                            | Global personal API tokens via nullable project token binding                                                                                  | Accepted                                                             | 2026-06-23 |
| [ADR-105](#adr-105-first-class-authored-package-kinds-and-centralized-studio-package-model)                                                                  | First-class authored package kinds and centralized Studio package model                                                                        | Implemented                                                          | 2026-06-22 |
| [ADR-106](#adr-106-package-based-platform-agents--package-identity-attachment-gating-optional-flow-enrichment-and-per-agent-runner-policy)                   | Package-based platform agents — package identity, attachment gating, optional-flow enrichment, and per-agent runner policy                     | Implemented                                                          | 2026-06-23 |
| [ADR-107](#adr-107-version-adopt-launch--adopt-a-newer-central-package-cut-at-launch)                                                                        | Version-adopt launch — adopt a newer central package cut at launch                                                                             | Implemented                                                          | 2026-06-25 |
| [ADR-108](#adr-108-declarative-guardrailhook-engine--universal-supervisor-acp-seam-interceptor-native-materializer-seam-and-hook-trip-hitl-escalation)       | Declarative guardrail/hook engine — universal supervisor ACP-seam interceptor, native materializer seam, and hook-trip HITL escalation         | Implemented                                                          | 2026-06-23 |
| [ADR-109](#adr-109-consensus-flow-graph-node--engine-owned-unanimous-draft-verification-and-human-resolution)                                                | Consensus flow-graph node — engine-owned unanimous draft verification and human resolution                                                     | Implemented                                                          | 2026-06-24 |
| [ADR-110](#adr-110-flow-studio-ai-assistant-read-only-acp--structured-server-applied-actions)                                                                | Flow Studio AI assistant: read-only ACP + structured server-applied actions                                                                    | Implemented                                                          | 2026-06-25 |
| [ADR-111](#adr-111-generic-agent-configuration-framework--declared-config-params-per-instance-values-resolved-snapshot-prompt-injection)                     | Generic agent configuration framework — declared config params, per-instance values, resolved snapshot, prompt injection                       | Implemented                                                          | 2026-06-25 |
| [ADR-112](#adr-112-triager-agent--duplicateofflagged-dedup-substrate-autolaunchtriaged-tick-flowrunner-discovery-no-silent-stall-guards)                     | Triager agent — duplicate_of/flagged dedup substrate, auto_launch_triaged tick, flow/runner discovery, no-silent-stall guards                  | Implemented                                                          | 2026-06-25 |
| [ADR-113](#adr-113-pr-to-source-for-local-packages--trusted-source-picker--stable-publish-branch)                                                            | PR-to-source for local packages — trusted-source picker + stable publish branch                                                                | Implemented                                                          | 2026-06-25 |
| [ADR-114](#adr-114-unified-flow-runner-config-first-class-sessions-per-project-connect-time-bindings-and-runsessions-as-the-sole-run-runner-source-of-truth) | Unified Flow runner config, first-class sessions, per-project connect-time bindings, and `run_sessions` as the sole run-runner source of truth | Implemented                                                          | 2026-06-26 |
| [ADR-115](#adr-115-strict-template-default-operator-for-prompt-authoring)                                                                                    | Strict template default operator for prompt authoring                                                                                          | Partially superseded by ADR-164                                       | 2026-06-28 |
| [ADR-116](#adr-116-local-package-composition-view-shared-package-bom-source-abstraction-tabbed-editor-ia)                                                    | Local-package composition view: shared package BOM source abstraction, tabbed editor IA                                                        | Implemented                                                          | 2026-06-28 |
| [ADR-117](#adr-117-reliable-cost-rollup-reconciliation-and-per-runner-cost-attribution)                                                                      | Reliable cost-rollup reconciliation and per-runner cost attribution                                                                            | Implemented                                                          | 2026-06-29 |
| [ADR-118](#adr-118-rework-loop-onexhaustion-routing--human-driven-counter-reset-resettargets--engine-210)                                                    | Rework loop `onExhaustion` routing + human-driven counter reset (`resetTargets`) + engine 2.1.0                                                | Implemented                                                          | 2026-06-29 |
| [ADR-119](#adr-119-manual-force-relaunch-additive-concurrent-runs-per-task--atomic-attempt-number-allocation)                                                | Manual force-relaunch (additive concurrent runs per task) + atomic attempt-number allocation                                                   | Implemented                                                          | 2026-06-30 |
| [ADR-120](#adr-120-artifact-body-injection-into-prompts)                                                                                                     | Artifact body injection into prompts                                                                                                           | Implemented                                                          | 2026-06-30 |
| [ADR-121](#adr-121-priority-ordered-dependency-draining-task-queue-unified-admission-gate)                                                                   | Priority-ordered dependency-draining task queue (unified admission gate)                                                                       | Implemented                                                          | 2026-06-30 |
| [ADR-122](#adr-122-project-brain-per-project-memory-substrate)                                                                                               | Project Brain (per-project memory substrate)                                                                                                   | Accepted; D3 superseded by ADR-131                                   | 2026-07-02 |
| ADR-123                                                                                                                                                      | _Reserved — number burned by the unlanded Tact-0 plan (workspace-boundary default-deny + agent token scopes); do not reuse_                    | Reserved                                                             | —          |
| [ADR-124](#adr-124-experiment-comparison-studio-for-pinned-base-comparison-runs)                                                                             | Experiment Comparison Studio for pinned-base comparison runs                                                                                   | Accepted                                                             | 2026-07-03 |
| [ADR-125](#adr-125-budget-breach-four-way-fork-with-staged-claims)                                                                                           | Budget-breach four-way fork with staged claims                                                                                                 | Implemented                                                          | 2026-07-02 |
| [ADR-126](#adr-126-auto-promotion-lanes)                                                                                                                     | Auto-promotion lanes                                                                                                                           | Implemented                                                          | 2026-07-03 |
| [ADR-127](#adr-127-project-brain-consultant-indexed-tier)                                                                                                    | Project Brain Consultant indexed tier                                                                                                          | Implemented                                                          | 2026-07-03 |
| [ADR-128](#adr-128-project-brain-self-improvement-proposal-bridge)                                                                                           | Project Brain self-improvement proposal bridge                                                                                                 | Implemented                                                          | 2026-07-03 |
| [ADR-129](#adr-129-mcp-management-v2--requirements--bindings-per-project-overlay-trust--health-activation)                                                   | MCP management v2 — requirements & bindings, per-project overlay, trust & health activation                                                    | Implemented                                                          | 2026-07-11 |
| [ADR-130](#adr-130-adapter-agnostic-capability-enforcement-at-the-acp-seam)                                                                                  | Adapter-agnostic capability enforcement at the ACP seam                                                                                        | Implemented                                                          | 2026-07-11 |
| [ADR-131](#adr-131-postgres-only-and-graph-only-engine-300-cut-over)                                                                                         | Postgres-only and graph-only engine 3.0.0 cut-over                                                                                             | Accepted                                                             | 2026-07-11 |
| [ADR-132](#adr-132-forked-package-loop--ephemeral-pins-package-experiment-axis-local-sources-upstream-sync)                                                  | Forked-package loop — ephemeral pins, package experiment axis, local sources, upstream sync                                                    | Implemented                                                          | 2026-07-11 |
| [ADR-133](#adr-133-versioned-read-only-evidence-and-run-owned-package-materialization)                                                                       | Versioned read-only evidence and run-owned package materialization                                                                             | Implemented                                                          | 2026-07-11 |
| [ADR-134](#adr-134-observatory-agentization-and-commit-provenance)                                                                                           | Observatory agentization and commit provenance                                                                                                 | Implemented (2026-07-12)                                             | 2026-07-12 |
| [ADR-135](#adr-135-testcontainers-only-ephemeral-postgres-for-database-backed-tests)                                                                         | Testcontainers-only ephemeral Postgres for database-backed tests                                                                               | Implemented                                                          | 2026-07-12 |
| [ADR-136](#adr-136-task-bound-human-ask-clarification-handoff)                                                                                               | Task-bound Human-ask clarification handoff                                                                                                     | Implemented                                                          | 2026-07-13 |
| [ADR-137](#adr-137-typed-plan-review-artifacts-and-flow-native-decision-requests)                                                                            | Typed Plan-review artifacts and Flow-native decision requests                                                                                  | Implemented                                                          | 2026-07-14 |
| [ADR-138](#adr-138-flow-review-workspace--complete-working-tree-review-and-verified-rework-feedback-delivery)                                                | Flow Review Workspace — complete working-tree review and verified rework feedback delivery                                                     | Implemented                                                          | 2026-07-14 |
| [ADR-139](#adr-139-project-automations--one-time-task-launch-reservation-and-truthful-agent-binding-telemetry)                                               | Project Automations — one-time task-launch reservation and truthful agent-binding telemetry                                                    | Implemented (migration 0104)                                         | 2026-07-15 |
| [ADR-140](#adr-140-pr-lifecycle-tracking)                                                                                                                    | PR lifecycle tracking                                                                                                                          | Implemented                                                          | 2026-07-14 |
| [ADR-141](#adr-141-branch-sync-with-ai-conflict-resolver-and-reopen)                                                                                         | Branch sync with AI conflict resolver and reopen                                                                                               | Implemented                                                          | 2026-07-14 |
| [ADR-142](#adr-142-evaluation-study-domain-and-legacy-experiment-compatibility)                                                                              | Evaluation Study domain and legacy Experiment compatibility                                                                                    | Implemented                                                          | 2026-07-16 |
| [ADR-143](#adr-143-package-sourced-evaluation-methods-and-trust-compatibility)                                                                               | Package-sourced Evaluation Methods and trust compatibility                                                                                     | Accepted                                                             | 2026-07-16 |
| [ADR-144](#adr-144-immutable-private-evidence-and-bounded-evaluator-retrieval)                                                                               | Immutable private evidence and bounded evaluator retrieval                                                                                     | Accepted                                                             | 2026-07-16 |
| [ADR-145](#adr-145-multi-judge-execution-aggregation-disagreement-and-human-verdict)                                                                         | Multi-judge execution aggregation disagreement and human verdict                                                                               | Accepted                                                             | 2026-07-16 |
| [ADR-146](#adr-146-controlled-evaluation-recipes-and-slot-keyed-execution-profiles)                                                                          | Controlled Evaluation recipes and slot-keyed execution profiles                                                                                | Accepted                                                             | 2026-07-16 |
| [ADR-147](#adr-147-advanced-evaluation-suites-calibration-and-recipe-standardization)                                                                        | Advanced evaluation suites calibration and recipe standardization                                                                              | Implemented                                                          | 2026-07-16 |
| [ADR-148](#adr-148-run-workspace-lifecycle-cleanup-and-reconciliation)                                                                                       | Run workspace lifecycle cleanup and reconciliation                                                                                             | Implemented                                                          | 2026-07-16 |
| [ADR-149](#adr-149-authored-capability-editor-session-edit-lock)                                                                                             | Authored-capability editor session edit-lock                                                                                                   | Implemented                                                          | 2026-07-21 |
| [ADR-150](#adr-150-experiments-cut-over-completion)                                                                                                          | Experiments cut-over completion                                                                                                                | Implemented                                                          | 2026-07-21 |
| [ADR-151](#adr-151-agent-mentions-in-task-comments-as-directed-summons)                                                                                      | Agent mentions in task comments as directed summons                                                                                            | Implemented                                                          | 2026-07-26 |
| [ADR-152](#adr-152-assistant-pulse-promotion-readiness--summonable-agent-metadata-and-per-attachment-agent-memory-files)                                     | Assistant pulse promotion-readiness + summonable-agent metadata, and per-attachment agent memory files                                         | Implemented                                                          | 2026-07-27 |
| [ADR-153](#adr-153-flow-child-process-env-isolation--allow-listed-env-for-clicheckprobe-children)                                                            | Flow child-process env isolation — allow-listed env for cli/check/probe children                                                               | Implemented                                                          | 2026-07-31 |
| [ADR-154](#adr-154-maisterflowdir-for-clicheck-node-actions--packaged-script-execution--engine-330)                                                          | `MAISTER_FLOW_DIR` for cli/check node actions — packaged-script execution + engine 3.3.0                                                       | Implemented                                                          | 2026-07-31 |
| [ADR-155](#adr-155-cross-project-task-relations)                                                                                                             | Cross-project task relations                                                                                                                   | Implemented                                                          | 2026-08-05 |
| [ADR-156](#adr-156-cross-project-agent-facade-reach)                                                                                                         | Cross-project agent facade reach                                                                                                               | Implemented                                                          | 2026-08-05 |
| [ADR-157](#adr-157-read-only-sibling-repo-context-mounts)                                                                                                    | Read-only sibling-repo context mounts                                                                                                          | Implemented                                                          | 2026-08-05 |
| [ADR-158](#adr-158-russian-user-manual-with-screenshots-under-docsrumanual)                                                                                  | Russian user manual with screenshots under `docs/ru/manual/`                                                                                   | Implemented                                                          | 2026-08-12 |
| [ADR-159](#adr-159-dbml-as-the-format-of-the-generated-consolidated-erd)                                                                                     | DBML as the format of the generated consolidated ERD                                                                                           | Implemented                                                          | 2026-08-31 |
| [ADR-160](#adr-160-review-run-rework-claim-with-fast-forward-only-handoff-round-trip)                                                                        | Review-run rework claim with fast-forward-only handoff round-trip                                                                              | Accepted                                                             | 2026-08-31 |
| [ADR-161](#adr-161-operator-node-interrupt-with-corrective-restart)                                                                                          | Operator node interrupt with corrective restart                                                                                                | Accepted                                                             | 2026-08-31 |
| [ADR-162](#adr-162-universal-structured-node-result--transport-matrix-open-json-grammar-schema-identity)                                                     | Universal structured node result — transport matrix, open JSON grammar, schema identity                                                        | Implemented                                                          | 2026-09-01 |
| [ADR-163](#adr-163-flow-target-delegation--carrier-task-shared-admission-canonical-flow-launcher)                                                            | Flow-target delegation — carrier task, shared admission, canonical Flow launcher                                                               | Implemented                                                          | 2026-09-01 |
| [ADR-164](#adr-164-remove-managed-claude-code-router-support)                                                                                                | Remove managed Claude Code Router support                                                                                                      | Implemented                                                          | 2026-09-02 |
| [ADR-165](#adr-165-governed-recursive-agent-harness--public-run-results-result-profiles-effective-recursion-bounds-result-only-completion)                   | Governed recursive agent harness — public run results, result profiles, effective recursion bounds, result-only completion                     | Implemented                                                          | 2026-09-02 |
| [ADR-166](#adr-166-local-execution-host-contract--durable-host-identity-epoch-fenced-assignments-command-ledger-opaque-adopted-workspaces) | Local execution-host contract — durable host identity, epoch-fenced assignments, command ledger, opaque adopted workspaces | Implemented | 2026-09-02 |
| [ADR-167](#adr-167-durable-execution-host-event-and-runtime-data-plane) | Durable execution-host event and runtime-data plane | Designed | 2026-09-04 |

---

### ADR-001: Next.js 16 + HeroUI v3 as the web stack

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-001.md`](decisions/adr-001.md)

---

### ADR-002: Supervisor runs as a separate Node daemon

**Status:** Accepted
**Date:** 2026-05-25

Full record: [`decisions/adr-002.md`](decisions/adr-002.md)

---

### ADR-003: ACP as the agent runtime protocol

**Status:** Accepted
**Date:** 2026-05-25

Full record: [`decisions/adr-003.md`](decisions/adr-003.md)

---

### ADR-004: Multi-runner: claude + codex on current target

**Status:** Accepted
**Date:** 2026-05-25

Full record: [`decisions/adr-004.md`](decisions/adr-004.md)

---

### ADR-005: Model routing: env-router default, CCR optional

**Status:** Partially superseded by ADR-164
**Date:** 2026-05-25

Full record: [`decisions/adr-005.md`](decisions/adr-005.md)

---

### ADR-006: Hybrid HITL: keep-alive + checkpoint/resume

**Status:** Accepted
**Date:** 2026-05-25

Full record: [`decisions/adr-006.md`](decisions/adr-006.md)

---

### ADR-007: SSE pipe-to-disk for step output

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-007.md`](decisions/adr-007.md)

---

### ADR-008: Typed error taxonomy (`MaisterError`)

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-008.md`](decisions/adr-008.md)

---

### ADR-009: Global concurrency cap = 3

**Status:** Accepted; amended by ADR-089/090 — flow/scratch default cap is 6 (`MAISTER_MAX_CONCURRENT_RUNS`), agents cap 3
**Date:** 2026-05-22

Full record: [`decisions/adr-009.md`](decisions/adr-009.md)

---

### ADR-010: Flow Engine v2: plugin packaging + step DSL

**Status:** Accepted
**Date:** 2026-05-25

Full record: [`decisions/adr-010.md`](decisions/adr-010.md)

---

### ADR-011: Workspace lifecycle via git worktree

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-011.md`](decisions/adr-011.md)

---

### ADR-012: Local promotion merge policy: `--no-ff`, abort on conflict

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-012.md`](decisions/adr-012.md)

---

### ADR-013: Postgres 16 primary, SQLite dev, Drizzle ORM

**Status:** Superseded by ADR-131
**Date:** 2026-05-22

Full record: [`decisions/adr-013.md`](decisions/adr-013.md)

---

### ADR-014: i18n: EN + RU from day one

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-014.md`](decisions/adr-014.md)

---

### ADR-015: pnpm workspace, Node 24

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-015.md`](decisions/adr-015.md)

---

### ADR-016: Mermaid as the only diagramming language for docs

**Status:** Accepted
**Date:** 2026-05-26

Full record: [`decisions/adr-016.md`](decisions/adr-016.md)

---

### ADR-017: OpenAPI 3.0.3 + AsyncAPI 2.6.0 as API contract formats

**Status:** Accepted
**Date:** 2026-05-26

Full record: [`decisions/adr-017.md`](decisions/adr-017.md)

---

### ADR-018: Task ↔ Run cardinality is 1:N

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-018.md`](decisions/adr-018.md)

---

### ADR-019: Project slug + repo_path uniqueness, soft archival

**Status:** Accepted
**Date:** 2026-05-22

Full record: [`decisions/adr-019.md`](decisions/adr-019.md)

---

### ADR-020: Fastify + pino in the supervisor

**Status:** Accepted
**Date:** 2026-05-25

Full record: [`decisions/adr-020.md`](decisions/adr-020.md)

---

### ADR-021: Flow package lifecycle: multi-revision, trust, and compatibility

**Status:** Accepted (amended by [ADR-088](#adr-088-multi-flow-package-management): a package groups multiple flow sources under one import; the per-revision model below is unchanged)
**Date:** 2026-05-30

Full record: [`decisions/adr-021.md`](decisions/adr-021.md)

---

### ADR-022: Structured run-data projection — `run.events.jsonl` is the event log, Postgres holds derived read-models

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-022.md`](decisions/adr-022.md)

---

### ADR-023: Run `web` + `supervisor` on the host; containerize only Postgres

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-023.md`](decisions/adr-023.md)

---

### ADR-024: External operations surface — REST + thin MCP facade, project tokens, mandatory audit, HITL assessment & Flow-owned escalation

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-024.md`](decisions/adr-024.md)

---

### ADR-025: Project repo onboarding — URL clone or local path, host-credential auth, configurable roots

**Status:** Accepted
**Date:** 2026-05-31

Full record: [`decisions/adr-025.md`](decisions/adr-025.md)

---

### ADR-026: Flow graph manifest v1 (`nodes[]`) + engine version bump

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-026.md`](decisions/adr-026.md)

---

### ADR-027: Append-only `node_attempts` run ledger

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-027.md`](decisions/adr-027.md)

---

### ADR-028: Full-featured gate execution in M11a; M15 re-scoped

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-028.md`](decisions/adr-028.md)

---

### ADR-029: Split M11 into M11a / M11b / M11c

**Status:** Accepted
**Date:** 2026-05-30

Full record: [`decisions/adr-029.md`](decisions/adr-029.md)

---

### ADR-030: Manual takeover as a local worktree handoff (`HumanWorking` status)

**Status:** Accepted
**Date:** 2026-05-31

Full record: [`decisions/adr-030.md`](decisions/adr-030.md)

---

### ADR-031: Node typed settings schema (carve (b))

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-031.md`](decisions/adr-031.md)

---

### ADR-032: Settings-enforcement refusal boundary

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-032.md`](decisions/adr-032.md)

---

### ADR-033: Crash reconciliation model (startup + periodic sweeper, allow-list `Running`-only)

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-033.md`](decisions/adr-033.md)

---

### ADR-034: Crashed-run recovery semantics (hybrid `--resume` + re-dispatch, durable-marker-first, cap re-admission)

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-034.md`](decisions/adr-034.md)

---

### ADR-035: Graceful workspace GC (preserve-then-prune)

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-035.md`](decisions/adr-035.md)

---

### ADR-036: Flow-revision GC

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-036.md`](decisions/adr-036.md)

---

### ADR-037: Typed artifact model

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-037.md`](decisions/adr-037.md)

---

### ADR-038: Hybrid write path for `artifact_instances` (refines ADR-022)

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-038.md`](decisions/adr-038.md)

---

### ADR-039: `@xyflow/react` + `@dagrejs/dagre` as the evidence-graph renderer

**Status:** Accepted
**Date:** 2026-06-01

Full record: [`decisions/adr-039.md`](decisions/adr-039.md)

---

### ADR-040: Assignment actors and role-owned work queue

**Status:** Accepted
**Date:** 2026-06-02

Full record: [`decisions/adr-040.md`](decisions/adr-040.md)

---

### ADR-041: Capability registry refs + agent-aware mapping + runner-owned native materialization

**Status:** Accepted; delivery half superseded by [ADR-044](#adr-044)
**Date:** 2026-06-02

Full record: [`decisions/adr-041.md`](decisions/adr-041.md)

---

### ADR-042: Conservative spike-gated enforcement flip; claude-first

**Status:** Superseded by [ADR-130](#adr-130) — the adapter-agnostic ACP-seam flip replaced the claude-first native-deny plan
**Date:** 2026-06-02

Full record: [`decisions/adr-042.md`](decisions/adr-042.md)

---

### ADR-043: Capability import reuses the flow-install fetch→trust→execute pipeline

**Status:** Accepted
**Date:** 2026-06-02

Full record: [`decisions/adr-043.md`](decisions/adr-043.md)

---

### ADR-045: External_check enforcement via the Review chokepoint; M16/M15/M18 carve

**Status:** Accepted
**Date:** 2026-06-02

Full record: [`decisions/adr-045.md`](decisions/adr-045.md)

---

### ADR-046: Project API token model

**Status:** Accepted
**Date:** 2026-06-02

Full record: [`decisions/adr-046.md`](decisions/adr-046.md)

---

### ADR-047: Thin MCP facade as a standalone REST-client package

**Status:** Accepted
**Date:** 2026-06-02

Full record: [`decisions/adr-047.md`](decisions/adr-047.md)

---

### ADR-048: Readiness enforcement over all blocking gate kinds + verdict calibration (M15)

**Status:** Accepted
**Date:** 2026-06-03

Full record: [`decisions/adr-048.md`](decisions/adr-048.md)

---

### ADR-044: Capability delivery via `settings.local.json` + ACP `newSession` (CLI-flag mechanism disproven)

**Status:** Accepted
**Date:** 2026-06-03

Full record: [`decisions/adr-044.md`](decisions/adr-044.md)

---

### ADR-058: Branch targeting at launch, shared promotion service, promote-time readiness re-gate (M18/M15 carve)

**Status:** Accepted
**Date:** 2026-06-03

Full record: [`decisions/adr-058.md`](decisions/adr-058.md)

---

### ADR-049: PR promotion via a hybrid provider `PrAdapter` (credential model B); reverses the "gh is never invoked" invariant

**Status:** Accepted
**Date:** 2026-06-03

Full record: [`decisions/adr-049.md`](decisions/adr-049.md)

---

### ADR-050: Platform ACP runners, adapter provisioners, and router sidecars

**Status:** Partially superseded by ADR-164
**Date:** 2026-06-03

Full record: [`decisions/adr-050.md`](decisions/adr-050.md)

---

### ADR-051: Flow-graph layout metadata store (project-scoped, `flow_id`-keyed)

**Status:** Accepted
**Date:** 2026-06-05

Full record: [`decisions/adr-051.md`](decisions/adr-051.md)

---

### ADR-052: Live node-status coloring via SSE-triggered `graph-status` refetch

**Status:** Accepted
**Date:** 2026-06-05

Full record: [`decisions/adr-052.md`](decisions/adr-052.md)

---

### ADR-053: Workbench file-tree: git-tracked-only, member-gated reads

**Status:** Accepted. The file **render** path below (the `…/files/content` HTTP route and its `413`/`415` responses) is superseded by [ADR-066](#adr-066-editor-and-diff-rendering-stack-shiki-git-diff-view-codemirror): blobs now render via the `?file=` RSC path as `file-too-large`/`file-binary` page states (no HTTP `413`/`415`). The git-tracked tree-read model, `readBlob` size/binary caps, and the `readRepoFiles` gate stand.
**Date:** 2026-06-05

Full record: [`decisions/adr-053.md`](decisions/adr-053.md)

---

### ADR-054: HITL assessment taxonomy — flow-declared `criticality` vs responder `human_confidence`, annotate-not-re-gate

**Status:** Implemented
**Date:** 2026-06-05

Full record: [`decisions/adr-054.md`](decisions/adr-054.md)

---

### ADR-055: HITL response service + HITL-over-MCP + token-actor + actor-kind/scope auth gates

**Status:** Implemented
**Date:** 2026-06-05

Full record: [`decisions/adr-055.md`](decisions/adr-055.md)

---

### ADR-056: Flat-runner `on_reject.goto_step` atomic execution — single-tx repark, dedicated comments channel, window-sentinel invalidation

**Status:** Superseded by ADR-131
**Date:** 2026-06-05

Full record: [`decisions/adr-056.md`](decisions/adr-056.md)

---

### ADR-057: HITL hybrid-surface composition — cross-project Inbox block, inline response component, numeric "Needs you (N)" badge

**Status:** Implemented
**Date:** 2026-06-05

Full record: [`decisions/adr-057.md`](decisions/adr-057.md)

---

### ADR-059: Read-only Observatory formulas and harvest priority

**Status:** Accepted
**Date:** 2026-06-05

Full record: [`decisions/adr-059.md`](decisions/adr-059.md)

---

### ADR-060: Unified scheduler clock and polymorphic job budgets

**Status:** Accepted
**Date:** 2026-06-05

Full record: [`decisions/adr-060.md`](decisions/adr-060.md)

---

### ADR-061: Local authored capability catalog lifecycle

**Status:** Implemented
**Date:** 2026-06-05

Full record: [`decisions/adr-061.md`](decisions/adr-061.md)

---

### ADR-062: Platform user administration + project member management (admin-surface carve)

**Status:** Implemented
**Date:** 2026-06-07

Full record: [`decisions/adr-062.md`](decisions/adr-062.md)

---

### ADR-063: Structured node output channel (P1) + run-context file (P7)

**Status:** Accepted — P1 Implemented (2026-06-10, `feature/harness-loop-foundation`); P7 run-context file stays Designed
**Date:** 2026-06-07

Full record: [`decisions/adr-063.md`](decisions/adr-063.md)

---

### ADR-064: Authored flow-graph layout in the flow.yaml presentation section

**Status:** Implemented
**Date:** 2026-06-07

Full record: [`decisions/adr-064.md`](decisions/adr-064.md)

---

### ADR-065: Platform ACP runner CRUD in `/settings` — hard delete blocked by any usage reference

**Status:** Implemented
**Date:** 2026-06-08

Full record: [`decisions/adr-065.md`](decisions/adr-065.md)

---

### ADR-067: Flow editor write path — canvas edits as M25 authored flow drafts with hard-gate before persist

**Status:** Accepted
**Date:** 2026-06-08

Full record: [`decisions/adr-067.md`](decisions/adr-067.md)

---

### ADR-068: Authored→executable flow bridge + two-axis trust gate (supersedes ADR-061 publish boundary)

**Status:** Accepted
**Date:** 2026-06-08

Full record: [`decisions/adr-068.md`](decisions/adr-068.md)

---

### ADR-069: `version_binding` (pinned|latest) + resolve-at-launch + unified resolved-set snapshot

**Status:** Implemented
**Date:** 2026-06-08

Full record: [`decisions/adr-069.md`](decisions/adr-069.md)

---

### ADR-070: MCP + capability management model — 3-scope identity, local-first precedence, platform storage, setup-time resolve

**Status:** Implemented
**Date:** 2026-06-08

Full record: [`decisions/adr-070.md`](decisions/adr-070.md)

---

### ADR-071: User-facing run schedules on the M24 clock

**Status:** Accepted
**Date:** 2026-06-10

Full record: [`decisions/adr-071.md`](decisions/adr-071.md)

---

### ADR-072: PR-grade review comments — `review_comments` table, snapshot anchoring, runner-side rework compose, open-gate guard

**Status:** Implemented
**Date:** 2026-06-10

Full record: [`decisions/adr-072.md`](decisions/adr-072.md)

---

### ADR-066: Editor and diff rendering stack (Shiki, git-diff-view, CodeMirror)

**Status:** Implemented
**Date:** 2026-06-08

Full record: [`decisions/adr-066.md`](decisions/adr-066.md)

---

### ADR-073: Harness adequacy & coherence metrics (read-only Observatory extension)

**Status:** Accepted
**Date:** 2026-06-10

Full record: [`decisions/adr-073.md`](decisions/adr-073.md)

---

### ADR-074: Artifact post-conditions — deterministic mutation sensor on `artifact_required` gates

**Status:** Implemented
**Date:** 2026-06-10

Full record: [`decisions/adr-074.md`](decisions/adr-074.md)

---

### ADR-077: Outbound webhooks: generic event-delivery primitive, transactional outbox + singleton drainer

**Status:** Implemented
**Date:** 2026-06-10

Full record: [`decisions/adr-077.md`](decisions/adr-077.md)

---

### ADR-075: Flow Studio Phase 2 viewer, fork-to-authored-draft, kind-by-path, and content-validation severity

**Status:** Implemented
**Date:** 2026-06-10

Full record: [`decisions/adr-075.md`](decisions/adr-075.md)

---

### ADR-076: ACP runner model discovery (resolver-on-supervisor) + configured-model application

**Status:** Partially superseded by ADR-164
**Date:** 2026-06-11

Full record: [`decisions/adr-076.md`](decisions/adr-076.md)

---

### ADR-078: Gate-chat at HITL pauses with three-layer workspace-neutrality

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-078.md`](decisions/adr-078.md)

---

### ADR-079: Node workspacePolicy execution and checkpoint capture

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-079.md`](decisions/adr-079.md)

---

### ADR-080: Node-level retry policy

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-080.md`](decisions/adr-080.md)

---

### ADR-081: Rework session policy with resume-by-default

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-081.md`](decisions/adr-081.md)

---

### ADR-082: Review-diff completeness with dirty-state protocol and scope switcher

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-082.md`](decisions/adr-082.md)

---

### ADR-083: Social board substrate — per-project task numbering, typed relations, polymorphic actor

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-083.md`](decisions/adr-083.md)

---

### ADR-084: ACP adapter families for Gemini CLI and OpenCode

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-084.md`](decisions/adr-084.md)

---

### ADR-085: MiMo Code as a distinct ACP adapter family

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-085.md`](decisions/adr-085.md)

---

### ADR-086: Domain-event outbox as the shared trigger bus

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-086.md`](decisions/adr-086.md)

---

### ADR-087: Multi-run launch, cost accounting, and delivery-policy surfaces

**Status:** Implemented
**Date:** 2026-06-11

Full record: [`decisions/adr-087.md`](decisions/adr-087.md)

---

### ADR-088: Multi-flow package management

**Status:** Implemented
**Date:** 2026-06-12

Full record: [`decisions/adr-088.md`](decisions/adr-088.md)

---

### ADR-089: Platform agent catalog with per-agent runner and a five-source trigger model

**Status:** Implemented
**Date:** 2026-06-12

Full record: [`decisions/adr-089.md`](decisions/adr-089.md)

---

### ADR-090: Agent workspace axis with three-layer read-only enforcement and quarantine

**Status:** Accepted
**Date:** 2026-06-12

Full record: [`decisions/adr-090.md`](decisions/adr-090.md)

---

### ADR-091: Flow requirements launch precondition

**Status:** Accepted
**Date:** 2026-06-13

Full record: [`decisions/adr-091.md`](decisions/adr-091.md)

---

### ADR-092: Flow Studio redesign — unified Studio IA + editable-local-package model

**Status:** Accepted
**Date:** 2026-06-15

Full record: [`decisions/adr-092.md`](decisions/adr-092.md)

---

### ADR-093: Project onboarding — optional `maister.yaml`, host-ambient git auth, onboarding modes, advisory clone reasons

**Status:** Implemented
**Date:** 2026-06-17

Full record: [`decisions/adr-093.md`](decisions/adr-093.md)

---

### ADR-094: Default-runner materialization, honest readiness, and CCR admin lifecycle

**Status:** Partially superseded by ADR-164
**Date:** 2026-06-18

Full record: [`decisions/adr-094.md`](decisions/adr-094.md)

---

### ADR-096: Flow Studio Phase C — editable local packages (Variant B): substrate, session lock, member RBAC, git-backed fork

**Status:** Implemented
**Date:** 2026-06-16

Full record: [`decisions/adr-096.md`](decisions/adr-096.md)

---

### ADR-097: Docked AI authoring assistant — project-less scratch-at-local-package run (M36 Phase 5)

**Status:** Accepted
**Date:** 2026-06-20

Full record: [`decisions/adr-097.md`](decisions/adr-097.md)

---

### ADR-095: Flow execution-control policy — snapshotted preset + composable autonomy axes, fail-closed, no-blind-ship

**Status:** Implemented
**Date:** 2026-06-20

Full record: [`decisions/adr-095.md`](decisions/adr-095.md)

---

### ADR-098: Orchestrator engine — supervisory node, governed run-tree, delegation toolset, success-gated task-DAG, idle-checkpoint wait/resume

**Status:** Implemented
**Date:** 2026-06-20

Full record: [`decisions/adr-098.md`](decisions/adr-098.md)

---

### ADR-099: Persistent swarm Layer 2 — addressable sessions, star-routed messaging, worktree modes, per-agent read-only

**Status:** Implemented
**Date:** 2026-06-20

Full record: [`decisions/adr-099.md`](decisions/adr-099.md)

---

### ADR-100: delegated-child Review settle + promote/rework

**Status:** Implemented
**Date:** 2026-06-20

Full record: [`decisions/adr-100.md`](decisions/adr-100.md)

---

### ADR-101: Cost-budget governance — budget execution-policy axis, token-metered, warn-escalate-terminate ladder, fail-open

**Status:** Implemented
**Date:** 2026-06-22

Full record: [`decisions/adr-101.md`](decisions/adr-101.md)

---

### ADR-102: Shared-worktree tree-level review/promote ownership

**Status:** Implemented
**Date:** 2026-06-21

Full record: [`decisions/adr-102.md`](decisions/adr-102.md)

---

### ADR-103: Output-driven dynamic routing (`decide`) + `on_mismatch` rework + engine 1.7.0

**Status:** Implemented
**Date:** 2026-06-22

Full record: [`decisions/adr-103.md`](decisions/adr-103.md)

---

### ADR-104: Global personal API tokens via nullable project token binding

**Status:** Accepted
**Date:** 2026-06-23

Full record: [`decisions/adr-104.md`](decisions/adr-104.md)

---

### ADR-105: First-class authored package kinds and centralized Studio package model

**Status:** Implemented
**Date:** 2026-06-22

Full record: [`decisions/adr-105.md`](decisions/adr-105.md)

---

### ADR-106: Package-based platform agents — package identity, attachment gating, optional-flow enrichment, and per-agent runner policy

**Status:** Implemented
**Date:** 2026-06-23

Full record: [`decisions/adr-106.md`](decisions/adr-106.md)

---

### ADR-107: Version-adopt launch — adopt a newer central package cut at launch

**Status:** Implemented
**Date:** 2026-06-25

Full record: [`decisions/adr-107.md`](decisions/adr-107.md)

---

### ADR-108: Declarative guardrail/hook engine — universal supervisor ACP-seam interceptor, native materializer seam, and hook-trip HITL escalation

**Status:** Implemented
**Date:** 2026-06-23

Full record: [`decisions/adr-108.md`](decisions/adr-108.md)

---

### ADR-109: Consensus flow-graph node — engine-owned unanimous draft verification and human resolution

**Status:** Implemented
**Date:** 2026-06-24

Full record: [`decisions/adr-109.md`](decisions/adr-109.md)

---

### ADR-110: Flow Studio AI assistant: read-only ACP + structured server-applied actions

**Status:** Implemented
**Date:** 2026-06-25

Full record: [`decisions/adr-110.md`](decisions/adr-110.md)

---

### ADR-111: Generic agent configuration framework — declared config params, per-instance values, resolved snapshot, prompt injection

**Status:** Implemented
**Date:** 2026-06-25

Full record: [`decisions/adr-111.md`](decisions/adr-111.md)

---

### ADR-112: Triager agent — duplicate_of/flagged dedup substrate, auto_launch_triaged tick, flow/runner discovery, no-silent-stall guards

**Status:** Implemented
**Date:** 2026-06-25

Full record: [`decisions/adr-112.md`](decisions/adr-112.md)

---

### ADR-113: PR-to-source for local packages — trusted-source picker + stable publish branch

**Status:** Implemented
**Date:** 2026-06-25

Full record: [`decisions/adr-113.md`](decisions/adr-113.md)

---

### ADR-114: Unified Flow runner config, first-class sessions, per-project connect-time bindings, and `run_sessions` as the sole run-runner source of truth

**Status:** Implemented
**Date:** 2026-06-26

Full record: [`decisions/adr-114.md`](decisions/adr-114.md)

---

### ADR-115: Strict template default operator for prompt authoring

**Status:** Partially superseded by ADR-164
**Date:** 2026-06-28

Full record: [`decisions/adr-115.md`](decisions/adr-115.md)

---

### ADR-116: Local-package composition view: shared package BOM source abstraction, tabbed editor IA

**Status:** Implemented
**Date:** 2026-06-28

Full record: [`decisions/adr-116.md`](decisions/adr-116.md)

---

### ADR-117: Reliable cost-rollup reconciliation and per-runner cost attribution

**Status:** Implemented
**Date:** 2026-06-29

Full record: [`decisions/adr-117.md`](decisions/adr-117.md)

---

### ADR-118: Rework loop `onExhaustion` routing + human-driven counter reset (`resetTargets`) + engine 2.1.0

**Status:** Implemented
**Date:** 2026-06-29

Full record: [`decisions/adr-118.md`](decisions/adr-118.md)

---

### ADR-119: Manual force-relaunch (additive concurrent runs per task) + atomic attempt-number allocation

**Status:** Implemented
**Date:** 2026-06-30

Full record: [`decisions/adr-119.md`](decisions/adr-119.md)

---

### ADR-120: Artifact body injection into prompts

**Status:** Implemented
**Date:** 2026-06-30

Full record: [`decisions/adr-120.md`](decisions/adr-120.md)

---

### ADR-121: Priority-ordered dependency-draining task queue (unified admission gate)

**Status:** Implemented
**Date:** 2026-06-30

Full record: [`decisions/adr-121.md`](decisions/adr-121.md)

---

### ADR-122: Project Brain (per-project memory substrate)

**Status:** Accepted; D3 superseded by ADR-131
**Date:** 2026-07-02

Full record: [`decisions/adr-122.md`](decisions/adr-122.md)

---

### ADR-124: Experiment Comparison Studio for pinned-base comparison runs

**Status:** Accepted
**Date:** 2026-07-03

Full record: [`decisions/adr-124.md`](decisions/adr-124.md)

---

### ADR-125: Budget-breach four-way fork with staged claims

**Status:** Implemented
**Date:** 2026-07-02

Full record: [`decisions/adr-125.md`](decisions/adr-125.md)

---

### ADR-126: Auto-promotion lanes

**Status:** Implemented
**Date:** 2026-07-03

Full record: [`decisions/adr-126.md`](decisions/adr-126.md)

---

### ADR-127: Project Brain Consultant indexed tier

**Status:** Implemented
**Date:** 2026-07-03

Full record: [`decisions/adr-127.md`](decisions/adr-127.md)

---

### ADR-128: Project Brain self-improvement proposal bridge

**Status:** Implemented
**Date:** 2026-07-03

Full record: [`decisions/adr-128.md`](decisions/adr-128.md)

---

### ADR-129: MCP management v2 — requirements & bindings, per-project overlay, trust & health activation

**Status:** Implemented
**Date:** 2026-07-11

Full record: [`decisions/adr-129.md`](decisions/adr-129.md)

---

### ADR-130: Adapter-agnostic capability enforcement at the ACP seam

**Status:** Implemented
**Date:** 2026-07-11

Full record: [`decisions/adr-130.md`](decisions/adr-130.md)

---

### ADR-131: Postgres-only and graph-only engine 3.0.0 cut-over

**Status:** Accepted
**Date:** 2026-07-11

Full record: [`decisions/adr-131.md`](decisions/adr-131.md)

---

### ADR-132: Forked-package loop — ephemeral pins, package experiment axis, local sources, upstream sync

**Status:** Implemented
**Date:** 2026-07-11

Full record: [`decisions/adr-132.md`](decisions/adr-132.md)

---

### ADR-133: Versioned read-only evidence and run-owned package materialization

**Status:** Implemented
**Date:** 2026-07-11

Full record: [`decisions/adr-133.md`](decisions/adr-133.md)

---

### ADR-134: Observatory agentization and commit provenance

**Status:** Implemented (2026-07-12)
**Date:** 2026-07-12

Full record: [`decisions/adr-134.md`](decisions/adr-134.md)

---

### ADR-135: Testcontainers-only ephemeral Postgres for database-backed tests

**Status:** Implemented
**Date:** 2026-07-12

Full record: [`decisions/adr-135.md`](decisions/adr-135.md)

---

### ADR-136: Task-bound Human-ask clarification handoff

**Status:** Implemented
**Date:** 2026-07-13

Full record: [`decisions/adr-136.md`](decisions/adr-136.md)

---

### ADR-137: Typed Plan-review artifacts and Flow-native decision requests

**Status:** Implemented
**Date:** 2026-07-14

Full record: [`decisions/adr-137.md`](decisions/adr-137.md)

---

### ADR-138: Flow Review Workspace — complete working-tree review and verified rework feedback delivery

**Status:** Implemented
**Date:** 2026-07-14

Full record: [`decisions/adr-138.md`](decisions/adr-138.md)

---

### ADR-139: Project Automations — one-time task-launch reservation and truthful agent-binding telemetry

**Status:** Implemented (migration 0104)
**Date:** 2026-07-15

Full record: [`decisions/adr-139.md`](decisions/adr-139.md)

---

### ADR-140: PR lifecycle tracking

**Status:** Implemented
**Date:** 2026-07-14

Full record: [`decisions/adr-140.md`](decisions/adr-140.md)

---

### ADR-141: Branch sync with AI conflict resolver and reopen

**Status:** Implemented
**Date:** 2026-07-14

Full record: [`decisions/adr-141.md`](decisions/adr-141.md)

---

### ADR-142: Evaluation Study domain and legacy Experiment compatibility

**Status:** Implemented
**Date:** 2026-07-16

Full record: [`decisions/adr-142.md`](decisions/adr-142.md)

---

### ADR-143: Package-sourced Evaluation Methods and trust compatibility

**Status:** Accepted
**Date:** 2026-07-16

Full record: [`decisions/adr-143.md`](decisions/adr-143.md)

---

### ADR-144: Immutable private evidence and bounded evaluator retrieval

**Status:** Accepted
**Date:** 2026-07-16

Full record: [`decisions/adr-144.md`](decisions/adr-144.md)

---

### ADR-145: Multi-judge execution aggregation disagreement and human verdict

**Status:** Accepted
**Date:** 2026-07-16

Full record: [`decisions/adr-145.md`](decisions/adr-145.md)

---

### ADR-146: Controlled Evaluation recipes and slot-keyed execution profiles

**Status:** Accepted
**Date:** 2026-07-16

Full record: [`decisions/adr-146.md`](decisions/adr-146.md)

---

### ADR-147: Advanced evaluation suites calibration and recipe standardization

**Status:** Implemented
**Date:** 2026-07-16

Full record: [`decisions/adr-147.md`](decisions/adr-147.md)

---

### ADR-148: Run workspace lifecycle cleanup and reconciliation

**Status:** Implemented
**Date:** 2026-07-16

Full record: [`decisions/adr-148.md`](decisions/adr-148.md)

---

### ADR-149: Authored-capability editor session edit-lock

**Status:** Implemented
**Date:** 2026-07-21

Full record: [`decisions/adr-149.md`](decisions/adr-149.md)

---

### ADR-150: Experiments cut-over completion

**Status:** Implemented
**Date:** 2026-07-21

Full record: [`decisions/adr-150.md`](decisions/adr-150.md)

---

### ADR-151: Agent mentions in task comments as directed summons

**Status:** Implemented
**Date:** 2026-07-26

Full record: [`decisions/adr-151.md`](decisions/adr-151.md)

---

### ADR-152: Assistant pulse promotion-readiness + summonable-agent metadata, and per-attachment agent memory files

**Status:** Implemented
**Date:** 2026-07-27

Full record: [`decisions/adr-152.md`](decisions/adr-152.md)

---

### ADR-153: Flow child-process env isolation — allow-listed env for cli/check/probe children

**Status:** Implemented
**Date:** 2026-07-31

Full record: [`decisions/adr-153.md`](decisions/adr-153.md)

---

### ADR-154: `MAISTER_FLOW_DIR` for cli/check node actions — packaged-script execution + engine 3.3.0

**Status:** Implemented
**Date:** 2026-07-31

Full record: [`decisions/adr-154.md`](decisions/adr-154.md)

---

### ADR-155: Cross-project task relations

**Status:** Implemented
**Date:** 2026-08-05

Full record: [`decisions/adr-155.md`](decisions/adr-155.md)

---

### ADR-156: Cross-project agent facade reach

**Status:** Implemented
**Date:** 2026-08-05

Full record: [`decisions/adr-156.md`](decisions/adr-156.md)

---

### ADR-157: Read-only sibling-repo context mounts

**Status:** Implemented
**Date:** 2026-08-05

Full record: [`decisions/adr-157.md`](decisions/adr-157.md)

---

### ADR-158: Russian user manual with screenshots under `docs/ru/manual/`

**Status:** Implemented
**Date:** 2026-08-12

Full record: [`decisions/adr-158.md`](decisions/adr-158.md)

---

### ADR-159: DBML as the format of the generated consolidated ERD

**Status:** Implemented
**Date:** 2026-08-31

Full record: [`decisions/adr-159.md`](decisions/adr-159.md)

---

### ADR-160: Review-run rework claim with fast-forward-only handoff round-trip

**Status:** Accepted
**Date:** 2026-08-31

Full record: [`decisions/adr-160.md`](decisions/adr-160.md)

---

### ADR-161: Operator node interrupt with corrective restart

**Status:** Accepted
**Date:** 2026-08-31

Full record: [`decisions/adr-161.md`](decisions/adr-161.md)

---

### ADR-162: Universal structured node result — transport matrix, open JSON grammar, schema identity

**Status:** Implemented
**Date:** 2026-09-01

Full record: [`decisions/adr-162.md`](decisions/adr-162.md)

---

### ADR-163: Flow-target delegation — carrier task, shared admission, canonical Flow launcher

**Status:** Implemented
**Date:** 2026-09-01

Full record: [`decisions/adr-163.md`](decisions/adr-163.md)

---

### ADR-164: Remove managed Claude Code Router support

**Status:** Implemented
**Date:** 2026-09-02

Full record: [`decisions/adr-164.md`](decisions/adr-164.md)

### ADR-165: Governed recursive agent harness — public run results, result profiles, effective recursion bounds, result-only completion

**Status:** Implemented
**Date:** 2026-09-02

Full record: [`decisions/adr-165.md`](decisions/adr-165.md)

### ADR-166: Local execution-host contract — durable host identity, epoch-fenced assignments, command ledger, opaque adopted workspaces

**Status:** Implemented
**Date:** 2026-09-02

Full record: [`decisions/adr-166.md`](decisions/adr-166.md)

---

### ADR-167: Durable execution-host event and runtime-data plane

**Status:** Designed
**Date:** 2026-09-04

Full record: [`decisions/adr-167.md`](decisions/adr-167.md)

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

**Amendments:** _(optional; dated deltas that do not change the direction)_

- YYYY-MM-DD — [what changed, which ADR/commit drove it]
```

---

_Decisions are numbered sequentially. Do not reuse numbers._

---

## TODO (tracked doc defects)

- **`operations.openapi.yaml` fails `redocly lint` on one pre-existing error
  (open, found 2026-08-05).** `#/components/schemas/ExtActivityRunSnapshot/
properties/lastAction` sets `nullable: true` beside an `allOf` with no sibling
  `type`, which the `nullable-type-sibling` rule rejects. Predates the
  multi-repo branch — proved by stashing that branch's only edit to the file and
  re-running, which reports the identical single error. `pnpm validate:contracts`
  (the repo's own gate) passes, so this is invisible to CI; it surfaces only when
  following docs/CLAUDE.md's "zero errors" redocly instruction by hand. One-line
  fix, left alone here because R9 forbids touching an unrelated schema in passing.

- **`workspaces.md` auto-promotion-lanes status contradicts itself and ADR-126
  (open, found 2026-08-05).** The `## Auto-promotion lanes` section ends
  "Everything here is **Designed**", while its own header and
  [ADR-126](#adr-126-auto-promotion-lanes) both say Implemented. Spotted
  twice while writing the F3 mount sections that sit beside it; left untouched
  because R9 forbids fixing an unrelated section in passing, and this is the
  prescribed place to record it instead. One word, but it is the kind of stale
  status tag R6 exists to prevent — a reader trusts the trailing sentence over
  the header.

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
- **`docs/db/erd.md` entity drift vs the per-domain ERDs (filed 2026-07-27).**
  Noticed while adding the ADR-152 columns; NOT fixed, per docs R9. The
  consolidated `erd.md` `AGENT_PROJECT_LINKS` block omits `branch_base`,
  `execution_policy_override`, `can_read_brain`, `can_write_brain`, and
  `schedules_revision`, all of which `db/agents-domain.md` carries; the `erd.md`
  `RUNS` block similarly omits `brain_context`, `budget_state`, `withheld_mcps`,
  `promoted_head_sha`, `merge_commit_sha`, and `diff_stat` relative to
  `db/runs-domain.md`. Either `erd.md` is intentionally a summary — in which
  case say so in its header — or it is stale. Reconcile when either ERD is next
  reworked.
- **`web.openapi.yaml` pre-existing redocly errors (filed 2026-07-11).** Two
  `nullable-type-sibling` errors: the experiment `verdict` fields
  (`ExperimentDetail` + `ExperimentComparison`) declare `nullable: true`
  beside an `allOf` ref, which OpenAPI 3.0 ignores without a sibling `type`.
  Pre-dates the forked-package-loop branch (ADR-132, baseline-verified); fix
  when the experiment schemas are next reworked.
- **Periodic reconcile crashes a `Running` run at a `cli` node with no live
  session (`cli-not-retry-safe`, pre-existing, `web/lib/reconcile.ts`; filed
  2026-09-03 during the ADR-166 review).** A `cli` node has no ACP session by
  design, so "no live session" is not evidence of a dead driver there. Verify
  the reconcile candidate query excludes runs with a live in-process driver;
  if it cannot, add a graph-driver registry like `sync-driver-registry` and
  gate the classification on it. Not fixed here — it is a code fix on an
  unrelated path (R9).
