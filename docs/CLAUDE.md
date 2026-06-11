# CLAUDE.md — `docs/` (MAIster Documentation)

> Read `../CLAUDE.md` first for the product spine, locked decisions, and
> current scope labels. This file is the contract for **how** to maintain the
> `docs/` folder — what lives where, in what format, and which rules apply
> when editing.

## Purpose of this folder

`docs/` is the canonical knowledge base for MAIster. It answers four
questions a human or agent should never have to dig through code for:

1. **What is the product?** — Vision, product view, JTBD.
2. **Why does it look like that?** — Architectural decisions and trade-offs.
3. **How is it built?** — C4 architecture, components, contracts.
4. **What are the contracts?** — OpenAPI, AsyncAPI, ERDs, error taxonomy.

When code and docs disagree, the **source code wins** (code is executable
truth). The fix is to update docs in the same PR.

## Artifact glossary

### Product layer

| File | What it answers |
| ---- | ---------------- |
| [`VISION.md`](VISION.md) | Product one-liner, principles, MVP goal. |
| [`PRODUCT_VIEW.md`](PRODUCT_VIEW.md) | Target user, product model, JTBD, current scope, Phase 2. |
| [`getting-started.md`](getting-started.md) | Local setup, scripts, prerequisites. |

### Architecture layer

| File | What it answers |
| ---- | ---------------- |
| [`architecture.md`](architecture.md) | C4 Context + Container + Component diagrams, component table, dependency rules. |
| [`decisions.md`](decisions.md) | ADR log. Every locked architectural decision lives here. |

### Contract layer (`api/`)

| Path | Content | Format |
| ---- | ------- | ------ |
| [`api/web.openapi.yaml`](api/web.openapi.yaml) | Web tier HTTP API (REST). | OpenAPI 3.0.3 |
| [`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml) | Supervisor HTTP API (REST). | OpenAPI 3.0.3 |
| [`api/async/web-runs.asyncapi.yaml`](api/async/web-runs.asyncapi.yaml) | Browser-facing run SSE stream. | AsyncAPI 2.6.0 |
| [`api/async/supervisor-sse.asyncapi.yaml`](api/async/supervisor-sse.asyncapi.yaml) | Supervisor SSE event stream. | AsyncAPI 2.6.0 |
| [`api/async/outbound-webhooks.asyncapi.yaml`](api/async/outbound-webhooks.asyncapi.yaml) | Outbound webhook wire contract: envelope v1, headers, HMAC signature, per-type payloads (ADR-077). | AsyncAPI 2.6.0 |
| [`api/external/acp.asyncapi.yaml`](api/external/acp.asyncapi.yaml) | Narrow ACP stdio contract used by the supervisor. | AsyncAPI 2.6.0 |

### Data layer (`db/`)

| File | What it answers |
| ---- | ---------------- |
| [`db/erd.md`](db/erd.md) | Full Mermaid ERD across all tables. |
| [`db/projects-domain.md`](db/projects-domain.md) | Projects + Executors + Flows ERD. |
| [`db/runs-domain.md`](db/runs-domain.md) | Tasks + Runs + Workspaces ERD. |
| [`db/hitl-domain.md`](db/hitl-domain.md) | HITL Requests ERD + form-schema shape. |
| [`db/artifacts-domain.md`](db/artifacts-domain.md) | Artifact instances + projection cursors ERD. |
| [`db/webhooks.md`](db/webhooks.md) | Webhook subscriptions + events outbox + deliveries + attempts ERD, plus the `webhooks_enabled` settings column (ADR-077). |
| [`db/domain-events.md`](db/domain-events.md) | Domain-event outbox ERD: `domain_events` fact log + per-consumer cursor rows (ADR-086). |
| [`database-schema.md`](database-schema.md) | Narrative DB reference (columns, indexes, cascade chain). |

### System analysis (`system-analytics/`)

Domain-grouped analyst artifacts: state machines, sequence diagrams, use
cases, process flows. One file per domain.

| File | Domain |
| ---- | ------ |
| [`system-analytics/identity-access.md`](system-analytics/identity-access.md) | Users, Auth.js sessions, RBAC gates, account settings. |
| [`system-analytics/projects.md`](system-analytics/projects.md) | Project registration, Flow plugin install. |
| [`system-analytics/flows.md`](system-analytics/flows.md) | Flow plugin packaging, step DSL, executor override. |
| [`system-analytics/flow-graph.md`](system-analytics/flow-graph.md) | Flow graph v1: node lifecycle, `node_attempts` ledger, gate execution, staleness, review-driven rework (M11a). |
| [`system-analytics/tasks.md`](system-analytics/tasks.md) | Backlog/board lifecycle, task ↔ run 1:N. |
| [`system-analytics/runs.md`](system-analytics/runs.md) | Run state machine, ACP keep-alive + checkpoint. |
| [`system-analytics/executors.md`](system-analytics/executors.md) | Executor identity, model routing (env-router vs CCR). |
| [`system-analytics/workspaces.md`](system-analytics/workspaces.md) | Worktree lifecycle, promotion policy, reconciliation. |
| [`system-analytics/reconciliation-gc.md`](system-analytics/reconciliation-gc.md) | Crash reconciliation + workspace/revision GC (preserve-then-prune, TTL ramp, cron route) — M19. |
| [`system-analytics/hitl.md`](system-analytics/hitl.md) | Human input loop (permission + form + human-review). |
| [`system-analytics/review-comments.md`](system-analytics/review-comments.md) | Line-anchored review-comment threads on the gate diff: placement, rework compose into `commentsVar`, loop-exhaustion guard (ADR-072). |
| [`system-analytics/manual-takeover.md`](system-analytics/manual-takeover.md) | Manual takeover (local worktree handoff): `HumanWorking`, claim/return, downstream staleness, run-detail timeline (M11b). |
| [`system-analytics/flow-settings.md`](system-analytics/flow-settings.md) | Node typed settings, declared `enforcement` intent, static `ENFORCEABILITY_BY_AGENT`, launch-time refusal boundary, time-limit watchdog, settings-visibility UI (M11c). |
| [`system-analytics/artifacts.md`](system-analytics/artifacts.md) | Typed artifacts + evidence graph: artifact_instances index, validity FSM, runner-inline + projector write paths, review refusal (M12). |
| [`system-analytics/readiness.md`](system-analytics/readiness.md) | Readiness policy: promotion-gating over blocking gates, verdict calibration, unified readiness summary (M15). |
| [`system-analytics/observatory.md`](system-analytics/observatory.md) | Read-only Observatory metrics: correction rate, Autonomy Score, and repeatable signal clusters (M23). |
| [`system-analytics/instance-config.md`](system-analytics/instance-config.md) | Read-only host roots, host-tool status, admin `/settings` page. |
| [`system-analytics/git-integration.md`](system-analytics/git-integration.md) | Provider detection + host-credential, provider-neutral git ops. |
| [`system-analytics/workbench.md`](system-analytics/workbench.md) | Workbench visibility (M22): flow-graph view + live node-status coloring, git-tracked file-tree, base→run diff, authored layout in `flow.yaml` (ADR-064). |
| [`system-analytics/workbench-lifecycle.md`](system-analytics/workbench-lifecycle.md) | Workbench lifecycle actions (M27): stop, archive, drop, snapshot commit, export, and handoff branch. |
| [`system-analytics/project-membership.md`](system-analytics/project-membership.md) | Project membership management: roster, add/change-role/remove, manageMembers action, no last-owner guard (M-admin-surface). |
| [`system-analytics/acp-runners.md`](system-analytics/acp-runners.md) | Platform ACP runner catalog CRUD on `/settings`: create/edit/delete + default + enable/disable, usage-guarded hard delete, readiness recompute (ADR-065). |
| [`system-analytics/run-schedules.md`](system-analytics/run-schedules.md) | User-facing cron schedules: `run_schedules` table, the seeded `run_schedule.dispatcher` job on the M24 tick, overlap policy × cap matrix, trigger-now, launchability classifier (M28). |
| [`system-analytics/model-catalog.md`](system-analytics/model-catalog.md) | Model discovery + application: supervisor-side resolver (ACP probe / provider API / curated GLM / CCR sources), in-memory TTL cache, passive harvest, per-adapter model pinning + mismatch advisory (ADR-076). |
| [`system-analytics/outbound-webhooks.md`](system-analytics/outbound-webhooks.md) | Outbound webhooks: transactional-outbox capture, 12-type taxonomy + envelope v1, singleton-drainer fanout/delivery, HMAC signing, retry/replay/ping, delivery FSM (ADR-077). |
| [`system-analytics/social-board.md`](system-analytics/social-board.md) | Social board substrate (ADR-083, Implemented): task comments with expanded `KEY-N` mentions, domain-written activity, auto-subscriptions, per-recipient inbox, polymorphic actor pair. |
| [`system-analytics/domain-events.md`](system-analytics/domain-events.md) | Domain-event outbox / shared trigger bus (ADR-086): same-transaction emission, 8-kind taxonomy v1, per-consumer cursor dispatcher with xid8 commit horizon on the M24 clock, webhooks-takeover path. |

### Cross-cutting reference

| File | What it answers |
| ---- | ---------------- |
| [`configuration.md`](configuration.md) | `maister.yaml` v2 + `flow.yaml` v1 + env vars. |
| [`error-taxonomy.md`](error-taxonomy.md) | `MaisterError` codes + UI actions. |
| [`supervisor.md`](supervisor.md) | Supervisor daemon prose reference. |
| [`flow-dsl.md`](flow-dsl.md) | Flow step DSL and runner behavior. |
| [`flow-installer.md`](flow-installer.md) | Flow plugin install pipeline. |
| [`flow-aif-plugin.md`](flow-aif-plugin.md) | Bundled `aif` Flow plugin. |
| [`deployment.md`](deployment.md) | Production VPS install: systemd, Postgres, reverse proxy, git auth. |

## Rules

### R1. Format whitelist

Allowed in `docs/`:

- **Markdown** (CommonMark + GitHub-flavored tables and code fences).
- **Mermaid** diagrams, fenced as ` ```mermaid `.
- **YAML** for OpenAPI 3.0.3, AsyncAPI 2.6.0, JSON Schema, and `*.yaml`
  config examples inside Markdown fences.

Anything else (PlantUML, draw.io XML, PNG screenshots, PDF) needs an ADR
in `decisions.md` first.

### R2. Mermaid is the only diagramming language

Every architectural, sequence, state, ERD, or flow diagram MUST be a
Mermaid block. The reasons are version control, AI-readability, and
zero-tool review. Hand-drawn images are rejected.

Mermaid usage requirements:

- First line declares the type: `C4Context`, `C4Container`, `C4Component`,
  `flowchart TD|LR`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`,
  `classDiagram`.
- Every diagram must render in the [Mermaid Live Editor](https://mermaid.live)
  without errors. Validate before committing — see §Validation.
- Use C4 notation (`C4Context`, `C4Container`, `C4Component`) for the
  three top architectural views in `architecture.md`. Use plain
  `flowchart` / `sequenceDiagram` / `stateDiagram-v2` everywhere else.
- One diagram per concept. If a diagram exceeds ~25 nodes, split it.
- Add a sentence of prose above each diagram naming the purpose. Never
  leave a diagram unannotated — readers should know what to look for
  before they scan it.

### R3. API contracts are OpenAPI 3.0.3 (REST) or AsyncAPI 2.6.0 (events)

- HTTP and HTTPS APIs are described as **OpenAPI 3.0.3** YAML files under
  `docs/api/`. One file per logical service.
- Event-based interactions (SSE, WebSocket, MQ, Kafka, intra-process event
  buses with cross-boundary semantics) are described as **AsyncAPI 2.6.0**
  YAML files under `docs/api/async/`. One file per channel set.
- Third-party APIs MAIster consumes are described in `docs/api/external/`.
  Use the upstream spec verbatim if it is published; otherwise write a
  narrow OpenAPI/AsyncAPI excerpt covering only the surface MAIster uses.
- Every spec MUST be valid against its meta-schema (Swagger/OpenAPI
  validator, AsyncAPI validator). See §Validation.
- API specs are the source of truth for the surface they describe.
  Implementation drift is a bug — fix code OR fix the spec, never both
  silently. Code-first generation is allowed; hand-edits must round-trip
  through the validator.

### R4. The ADR template is the only way to record decisions

New decisions go in [`decisions.md`](decisions.md) using the template
at the bottom of that file. Numbering is sequential and immutable
(superseded ADRs stay; do not renumber). One decision per ADR.

Outside `decisions.md`, prose may *cite* an ADR (`see ADR-005`) but MUST
NOT restate its rationale at length. Single source of truth.

### R5. Process and domain description structure

Every `system-analytics/*.md` file MUST contain, in this order:

1. **Purpose** — one paragraph, name the domain and its boundary.
2. **Domain entities** — bulleted list of nouns (link to ERD if persisted).
3. **State machine** (where applicable) — `stateDiagram-v2`.
4. **Process flows** — `flowchart` or `sequenceDiagram` for each
   end-to-end scenario.
5. **Expectations** — bulleted acceptance contract. See §R5a for
   fill-in rules. Domains added after this rule landed MUST include
   this section.
6. **Edge cases** — bulleted list of known failure / boundary modes,
   each linked to the relevant `MaisterError` code.
7. **Linked artifacts** — pointers to API spec, ERD, ADR, source files.

The diagrams and bullets are the artifact. Prose between them is glue,
not commentary.

### R5a. Expectations section fill-in rules

The **Expectations** section is the steady-state contract for the
domain — what a reviewer (human or AI) can use as an acceptance
checklist against the code, the DB, and the wire.

- One bullet = one MUST-hold invariant, guarantee, or observable
  behavior. One sentence each.
- Phrase as a normative statement (MUST / NEVER / always / exactly /
  at most / at least), not a description. RFC-2119 spirit; no formal
  capitalization required.
- Cover at minimum, when applicable to the domain: cardinality and
  uniqueness rules, state-transition invariants, concurrency / cap
  behavior, persistence vs in-memory boundaries, idempotence, retry /
  recovery semantics, security-relevant defaults.
- Every bullet MUST be testable — turnable into an assertion, a SQL
  constraint check, or a review checklist item. If it cannot, it does
  not belong here.
- DO NOT restate diagrams or duplicate Edge cases. Expectations are
  the contract; Edge cases are the named deviations from it.
- Reference identifiers verbatim (`runs.status`, `worktree_path`,
  `MaisterError("CONFIG")`, env-var names). No paraphrasing.
- Cap at ≤ 12 bullets. If a domain needs more, the boundary is wrong —
  split the file.
- Tag implementation status only when the expectation does NOT hold
  yet at the current milestone (e.g. `(Phase 2)`).

### R6. Implementation status is explicit

Every architecture or system-analytics file MUST mark each described
piece as one of:

- **Implemented** — present in the current branch.
- **Designed** — contract accepted, not yet coded.
- **Phase 2** — plausible later work, not part of the current target.

Use a parenthetical tag such as `(Implemented)`, `(Designed)`, or
`(Phase 2 — see PRODUCT_VIEW §Phase 2)`. This keeps the docs honest
about what is real today without turning old milestone labels into
blockers.

### R7. Cross-reference, do not duplicate

Configuration, error taxonomy, DB schema, supervisor wire contract,
ADRs — each has exactly one canonical file. Other docs link to it.
If two files describe the same thing, one of them is wrong; collapse
them.

### R8. Russian and English

The product UI is bilingual (EN + RU). Documentation in `docs/` is
**English only** — it is a contract for code and AI agents, both of
which read English. Russian-language artifacts go in i18n message
catalogs under `web/`, not here.

### R9. Surgical edits

Apply the root CLAUDE.md surgical-changes rule to docs too:

- Touch only what the request requires.
- Don't reformat adjacent prose, don't reflow tables, don't "improve"
  unrelated diagrams while passing through.
- If you spot a real bug in an unrelated section, file it as a TODO at
  the bottom of `decisions.md` — do not fix it silently.

## Validation

Before any docs PR merges, the diff MUST pass:

| Artifact | Validator | How |
| -------- | --------- | --- |
| Mermaid blocks | `pnpm validate:docs` (repo root) | Parses every changed `docs/**/*.md` block via `mermaid.parse()`; exits non-zero on any syntax error. Use `pnpm validate:docs:all` to check the entire `docs/` tree regardless of git status. The Claude Code Stop hook in `.claude/settings.json` runs this gate automatically before the agent finishes a turn. |
| OpenAPI 3.0.3 | `npx @redocly/cli lint <file>` or [editor.swagger.io](https://editor.swagger.io) | Zero errors; warnings reviewed. |
| AsyncAPI 2.6.0 | `npx @asyncapi/cli validate <file>` | Zero errors. |
| Markdown | `pnpm lint:md` (when present) | No broken intra-doc links. |

CI gates land in Phase 2. Until then, the author runs the checks
locally; the Mermaid gate runs automatically through the hook above.
The `Validate all artifacts` task in the implementation plan covers
this for the initial bulk migration.

## Adding a new artifact

1. **New domain doc** → add a file under `system-analytics/` following §R5.
   Link from this file's glossary.
2. **New API** → create the OpenAPI/AsyncAPI YAML under `api/` (or
   `api/external/` if upstream). Link from `architecture.md` Component
   table. Reference it from the spec that *invokes* it.
3. **New decision** → append an ADR to `decisions.md` (next sequential
   number). Do not rewrite history; supersede if needed.
4. **New ERD** → add a Mermaid `erDiagram` to the relevant `db/*.md`.
   Update the consolidated `db/erd.md`.

## Anti-patterns

- ❌ Writing an architecture decision in `architecture.md` instead of
  `decisions.md`.
- ❌ Embedding a screenshot of a diagram instead of the Mermaid source.
- ❌ Restating the `maister.yaml` schema in a system-analytics file —
  link to `configuration.md` instead.
- ❌ Reintroducing old planning archives as active docs. Git history keeps
  those records; active docs describe current contracts.
- ❌ Adding a "see also" section that duplicates the glossary above.
- ❌ Letting an OpenAPI/AsyncAPI file diverge from code without filing
  the diff as a defect.

## See also

- [`../CLAUDE.md`](../CLAUDE.md) — root contract for the whole repo.
- [`../web/CLAUDE.md`](../web/CLAUDE.md) — web slice contract.
- [`decisions.md`](decisions.md) — every locked decision behind the docs
  themselves.
