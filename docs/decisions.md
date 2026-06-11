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
**Status:** Accepted
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
