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
| [ADR-004](#adr-004-multi-executor-claude--codex-on-poc) | Multi-executor: claude + codex on POC | Accepted | 2026-05-25 |
| [ADR-005](#adr-005-model-routing-env-router-default-ccr-optional) | Model routing: env-router default, CCR optional | Accepted | 2026-05-25 |
| [ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume) | Hybrid HITL: keep-alive + checkpoint/resume | Accepted | 2026-05-25 |
| [ADR-007](#adr-007-sse-pipe-to-disk-for-step-output) | SSE pipe-to-disk for step output | Accepted | 2026-05-22 |
| [ADR-008](#adr-008-typed-error-taxonomy-maistererror) | Typed error taxonomy (`MaisterError`) | Accepted | 2026-05-22 |
| [ADR-009](#adr-009-global-concurrency-cap--3) | Global concurrency cap = 3 | Accepted | 2026-05-22 |
| [ADR-010](#adr-010-flow-engine-v2-plugin-packaging--step-dsl) | Flow Engine v2: plugin packaging + step DSL | Accepted | 2026-05-25 |
| [ADR-011](#adr-011-workspace-lifecycle-via-git-worktree) | Workspace lifecycle via git worktree | Accepted | 2026-05-22 |
| [ADR-012](#adr-012-merge-policy-no-ff-abort-on-conflict) | Merge policy: `--no-ff`, abort on conflict | Accepted | 2026-05-22 |
| [ADR-013](#adr-013-postgres-16-primary-sqlite-dev-drizzle-orm) | Postgres 16 primary, SQLite dev, Drizzle ORM | Accepted | 2026-05-22 |
| [ADR-014](#adr-014-i18n-en--ru-from-day-one) | i18n: EN + RU from day one | Accepted | 2026-05-22 |
| [ADR-015](#adr-015-pnpm-workspace-node-24) | pnpm workspace, Node 24 | Accepted | 2026-05-22 |
| [ADR-016](#adr-016-mermaid-as-the-only-diagramming-language-for-docs) | Mermaid as the only diagramming language for docs | Accepted | 2026-05-26 |
| [ADR-017](#adr-017-openapi-303--asyncapi-260-as-api-contract-formats) | OpenAPI 3.0.3 + AsyncAPI 2.6.0 as API contract formats | Accepted | 2026-05-26 |
| [ADR-018](#adr-018-task--run-cardinality-is-1n) | Task ↔ Run cardinality is 1:N | Accepted | 2026-05-22 |
| [ADR-019](#adr-019-project-slug--repo_path-uniqueness-soft-archival) | Project slug + repo_path uniqueness, soft archival | Accepted | 2026-05-22 |
| [ADR-020](#adr-020-fastify--pino-in-the-supervisor) | Fastify + pino in the supervisor | Accepted | 2026-05-25 |

---

### ADR-001: Next.js 16 + HeroUI v3 as the web stack

**Date:** 2026-05-22
**Status:** Accepted
**Context:** The control plane needs a rich UI with server-rendered
read pages, live updates, and a single TypeScript codebase shared with
server actions and route handlers. The audience is one solo-technical
operator on the POC; later, small teams.

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
- Two processes to operate. Docker Compose handles this for POC.
- The wire contract between web and supervisor is HTTP + SSE — the only
  coupling surface, documented in `api/supervisor.openapi.yaml` and
  `api/async/supervisor-sse.asyncapi.yaml`.
- Secrets and agent stdio stay inside the supervisor process; the web
  tier sees only the SSE event stream.

**Alternatives Considered:**

- **In-Next.js spawn:** the original M0 design. Killed by the HMR / restart fragility above.
- **Per-run container (Docker-in-Docker):** higher operational overhead; not justified for a single-host POC.

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
- Cross-process resume works via `--resume <session-id>` — verified in
  M0 spike ("ALBATROSS-42" round-trip).
- Sessions persist as JSONL files at
  `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`. The agent's own
  session store IS the checkpoint — no separate checkpoint format.
- Cache key does NOT survive process boundary; each respawn costs
  ~$0.28 of cache_creation tokens. Drives [ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume) keep-alive budget.

**Alternatives Considered:**

- **Bespoke shim per agent CLI:** N×N adapter matrix. ACP collapses it to N×1.
- **MCP-only orchestration:** MCP is for tools, not session lifecycle; wrong abstraction layer.

---

### ADR-004: Multi-executor: claude + codex on POC

**Date:** 2026-05-25
**Status:** Accepted
**Context:** Validating MAIster's portfolio thesis requires more than
one executor to prove the abstraction is real. M0 confirmed both ACP
adapters work and the supervisor's spawn dispatch on
`executor.agent` covers both.

**Decision:** POC ships with **both** Claude Code AND Codex executors.
Both are required to pass POC success criteria. Cursor, opencode,
Aider, OpenHands stay out of POC scope.

**Consequences:**

- The `executors[]` table is real, not a placeholder. The override
  resolution chain (run launcher → project per-flow override → project
  default → flow recommended) gets exercised end-to-end.
- Per-step executor override is verified on at least one Flow in
  acceptance.
- Adding a third agent is Phase 2 work — out of scope for POC.

**Alternatives Considered:**

- **Single executor on POC (Claude only):** the original M0 plan. Rejected because it postpones the most architecturally informative test (does the abstraction hold?).

---

### ADR-005: Model routing: env-router default, CCR optional

**Date:** 2026-05-25
**Status:** Accepted
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
3. **Resume via `--resume`** — when the user responds, supervisor
   spawns a fresh adapter process with `--resume <session-id>`.

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
HTTP clients. The Next.js Route Handler
(`/api/runs/[id]/stream`, planned M7+) tails the file for reconnect.

**Consequences:**

- Bounded memory in both tiers.
- `Last-Event-ID` reconnect works without replaying from RAM.
- Logs survive supervisor restart — they are durable.
- Cost accounting (`cost.jsonl`) follows the same pattern.

**Alternatives Considered:**

- **In-memory ring buffer only:** M3 ships a 1000-entry buffer for hot replay, but the file is the long-term truth.
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

**Decision:** `MAISTER_MAX_CONCURRENT_RUNS=3` for POC,
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

- **Per-project cap in `maister.yaml`:** rejected — POC is single-tenant, simpler global cap covers it.
- **No cap:** OOM risk on the demo host.

---

### ADR-010: Flow Engine v2: plugin packaging + step DSL

**Date:** 2026-05-25
**Status:** Accepted
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
- Trust model on POC: trust all internal Flow sources. Sandboxing /
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

### ADR-012: Merge policy: `--no-ff`, abort on conflict

**Date:** 2026-05-22
**Status:** Accepted
**Context:** The product needs a predictable merge path for clean
merges and a safe failure mode for conflicts. Auto-resolving conflicts
in code generated by an LLM is dangerous.

**Decision:** `git merge --no-ff` on the parent's `main_branch`.
Conflict → abort the merge, leave the run in `Review`, UI surfaces
"Conflict — resolve manually" with the parent repo path. No
auto-resolve.

**Consequences:**

- Every merge produces a merge commit (`--no-ff`) — traceability per run.
- Conflict handling is a human decision; the product never overwrites human work.

**Alternatives Considered:**

- **Rebase + fast-forward:** no merge commit, harder to attribute a run to a single revision.
- **Auto-resolve conflicts:** unacceptable; LLM-generated code can quietly clobber human edits.

---

### ADR-013: Postgres 16 primary, SQLite dev, Drizzle ORM

**Date:** 2026-05-22
**Status:** Accepted
**Context:** The control plane needs a relational store for projects,
tasks, runs, workspaces, executors, flows, HITL requests. JSON for
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
- **SQLite only:** runs out of headroom (no `jsonb`, weaker FK enforcement) past the POC.

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

- **EN-only on POC, i18n later:** every screen would need rewriting, accumulating retrofit cost.
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
run is the one shown on the card. Database UNIQUE
`(task_id, attempt_number)` guards against duplicate attempts.

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
against collisions. No hard delete in POC.

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
