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
| [ADR-004](#adr-004-multi-executor-claude--codex-on-current-target) | Multi-executor: claude + codex on current target | Accepted | 2026-05-25 |
| [ADR-005](#adr-005-model-routing-env-router-default-ccr-optional) | Model routing: env-router default, CCR optional | Accepted | 2026-05-25 |
| [ADR-006](#adr-006-hybrid-hitl-keep-alive--checkpointresume) | Hybrid HITL: keep-alive + checkpoint/resume | Accepted | 2026-05-25 |
| [ADR-007](#adr-007-sse-pipe-to-disk-for-step-output) | SSE pipe-to-disk for step output | Accepted | 2026-05-22 |
| [ADR-008](#adr-008-typed-error-taxonomy-maistererror) | Typed error taxonomy (`MaisterError`) | Accepted | 2026-05-22 |
| [ADR-009](#adr-009-global-concurrency-cap--3) | Global concurrency cap = 3 | Accepted | 2026-05-22 |
| [ADR-010](#adr-010-flow-engine-v2-plugin-packaging--step-dsl) | Flow Engine v2: plugin packaging + step DSL | Accepted | 2026-05-25 |
| [ADR-011](#adr-011-workspace-lifecycle-via-git-worktree) | Workspace lifecycle via git worktree | Accepted | 2026-05-22 |
| [ADR-012](#adr-012-local-promotion-merge-policy-no-ff-abort-on-conflict) | Local promotion merge policy: `--no-ff`, abort on conflict | Accepted | 2026-05-22 |
| [ADR-013](#adr-013-postgres-16-primary-sqlite-dev-drizzle-orm) | Postgres 16 primary, SQLite dev, Drizzle ORM | Accepted | 2026-05-22 |
| [ADR-014](#adr-014-i18n-en--ru-from-day-one) | i18n: EN + RU from day one | Accepted | 2026-05-22 |
| [ADR-015](#adr-015-pnpm-workspace-node-24) | pnpm workspace, Node 24 | Accepted | 2026-05-22 |
| [ADR-016](#adr-016-mermaid-as-the-only-diagramming-language-for-docs) | Mermaid as the only diagramming language for docs | Accepted | 2026-05-26 |
| [ADR-017](#adr-017-openapi-303--asyncapi-260-as-api-contract-formats) | OpenAPI 3.0.3 + AsyncAPI 2.6.0 as API contract formats | Accepted | 2026-05-26 |
| [ADR-018](#adr-018-task--run-cardinality-is-1n) | Task ↔ Run cardinality is 1:N | Accepted | 2026-05-22 |
| [ADR-019](#adr-019-project-slug--repo_path-uniqueness-soft-archival) | Project slug + repo_path uniqueness, soft archival | Accepted | 2026-05-22 |
| [ADR-020](#adr-020-fastify--pino-in-the-supervisor) | Fastify + pino in the supervisor | Accepted | 2026-05-25 |
| [ADR-021](#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility) | Flow package lifecycle: multi-revision, trust, and compatibility | Accepted | 2026-05-30 |

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

### ADR-004: Multi-executor: claude + codex on current target

**Date:** 2026-05-25
**Status:** Accepted
**Context:** Validating MAIster's portfolio thesis requires more than
one executor to prove the abstraction is real. M0 confirmed both ACP
adapters work and the supervisor's spawn dispatch on
`executor.agent` covers both.

**Decision:** Current target ships with **both** Claude Code AND Codex executors.
Both are required to pass success criteria. Cursor, opencode,
Aider, and OpenHands are Phase 2 executor candidates.

**Consequences:**

- The `executors[]` table is real, not a placeholder. The override
  resolution chain (run launcher -> task override -> project per-flow
  override -> project default -> flow recommended) gets exercised
  end-to-end.
- Per-step executor override is verified on at least one Flow in
  acceptance.
- Adding a third agent is Phase 2 work.

**Alternatives Considered:**

- **Single executor (Claude only):** the original M0 plan. Rejected because it postpones the most architecturally informative test (does the abstraction hold?).

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
   schema_version/recommended_executor_id/executor_override_id` columns as a
   denormalized cache of the *currently enabled* revision. `runs` gains
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

- `compose.yml` / `compose.override.yml` / `compose.production.yml` carry only
  Postgres; web + supervisor start with `pnpm --filter …`.
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
- Impl is `Designed` (M16), largely independent of M11/M12 but sequenced after
  the foundation.

**Alternatives Considered:**

- **External actor auto-answers human review gates:** defeats the gate's purpose; only confidence-thresholded auto-proceed *inside the Flow* is allowed.
- **MCP as a second orchestration backend:** must be a thin facade over the same services and audit, or it forks the control plane.
- **Granular scopes up front:** premature without concrete consumers; v1 grants full project API per token, scopes later.

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
