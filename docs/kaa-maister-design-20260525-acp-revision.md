# Design Revision 2 — ACP Pivot (2026-05-25)

> This document is a **focused delta** on the 2026-05-22 locked design
> (`docs/kaa-maister-design-20260522-174429.md`). Sections not mentioned
> here are unchanged. Where this revision conflicts with the 2026-05-22
> doc, **this revision wins**.

## Why this revision exists

After re-reading the locked design and surveying the 2026 OSS landscape
(Superset, Composio AO, Nimbalyst, Claude Squad, Mission Control,
OpenHands), three things became obvious:

1. The "multi-workspace orchestrator" wedge is commoditizing fast — the
   block-based "no live process" pattern, while crash-safe, gives up the
   ACP-native live UX that competitors are about to ship.
2. `aif` is a Node CLI + slash-command installer, not a Python subprocess
   runner. The locked `uv run aif run --flow X` `maister.yaml` command
   template doesn't match how `aif` actually works.
3. Single hard-coded executor leaves MAIster strategically pinned to one
   vendor; ACP standardization already gives us cheap multi-executor
   support if we don't actively avoid it.

User-side direction (chat 2026-05-25):

- Run Claude Code via ACP in a worker server, push back logs/HITL/etc
  from the active session.
- Drop "uv is a must" — Python only when a specific Flow plugin ships
  Python CLIs.
- Flow = installable plugin bundle (CLIs + setup + skills + agents +
  YAML DSL), not a flat `command:` string.
- Multi-executor IN now — pay the cost of `runs.executor_id` migration
  later if it's deferred.
- "Let's do it right" — accept the scope expansion, save calendar time
  on parallel agent runs later.

## What changed at a glance

| Topic | 2026-05-22 (locked) | 2026-05-25 (revised) |
|---|---|---|
| HITL model | Block-based, exit-code-driven, no live process during wait | **ACP-driven hybrid**: live ACP session + artifact `needs-input.json`, keep-alive ≤30 min with web-activity sliding window, then checkpoint+respawn via `--resume <session-id>` |
| Run state machine | `Pending \| Running \| NeedsInput \| Review \| Done \| Abandoned \| Crashed \| Failed` | Adds `NeedsInputIdle` between `NeedsInput` and `Abandoned` (checkpointed waiting state) |
| Executor | Claude Code only, hard-coded, no adapter interface | **claude + codex both required**, ACP IS the adapter, per-step override resolution (run launcher → project override → project default → flow recommended), CCR bundled for z.ai GLM / MiniMax |
| Flow shape | Flat `flows: [{ id, command: "uv run aif run …" }]` | **Plugin bundles**: git-tag-pinned, installed to `~/.maister/flows/<id>@<tag>/`, symlinked per project. `flow.yaml` manifest with `cli \| agent \| guard \| human` step DSL, pre/post guards, full Mustache templating |
| Runtime split | Single Next.js process, subprocess per block | **Two processes**: Next.js (web tier) + separate `supervisor/` Node daemon owning ACP sessions, HTTP+SSE IPC, supervisor may live on a different host |
| Python in container | Required (Node 24 + Python 3.12 + uv, ~1-2GB) | Optional (only when a specific Flow plugin ships Python CLIs) |
| Error taxonomy | `PRECONDITION \| SPAWN \| NEEDS_INPUT \| HITL_TIMEOUT \| CRASH \| CONFLICT \| CONFIG` | Adds `EXECUTOR_UNAVAILABLE \| FLOW_INSTALL \| ACP_PROTOCOL \| CHECKPOINT` |
| HITL UI surface | Run-detail form panel only | + portfolio "Needs you (N)" badge + per-project **Inbox** block + `human` step type with review / send-back-with-comments / `goto_step` loop |
| i18n | Not gated to a phase | **EN + RU REQUIRED from day one** |
| POC timeline | T+1 to T+1.5 weeks | T+4 to T+5 weeks (scope expansion explicitly accepted) |
| Dogfood / external | T+1.5–2w / T+3w with 2 named friends | T+5–6w / T+8w with 3 installations (no names required) |

## Decision deltas (per-section of the locked design)

### §"Recommended Approach" — Concrete stack

**Adds:**

- **Agent runtime**: ACP (Zed-standard Agent Client Protocol) via a
  library wrapping the Claude Code SDK. Working assumption is
  `@zed-industries/claude-code-acp` (or its current successor — user
  referenced `agentclientprotocol/claude-agent-acp`). Exact package +
  version verified in M0 spike.
- **Model routing**: CCR (Claude Code Router) bundled out-of-the-box,
  enabling `router: ccr` executor flag for routing through
  Anthropic-API-compatible third-party providers (z.ai GLM, MiniMax,
  etc.) using the same `claude` CLI.
- **Web ↔ supervisor IPC**: HTTP for command-and-control, SSE for
  `session/update` event stream. Supervisor reachable over the network,
  not via Unix-socket — explicit goal so the supervisor can run on a
  more capable host than the web tier.

**Removes / softens:**

- "Python bridge `uv run <flow-cmd>` in the same container image (single
  image, ~1-2GB, accepted)" — Python is now optional, image shrinks
  proportionally.
- "No long-running process across HITL waits" — held processes are now
  the **default** during the keep-alive window; checkpoint+respawn is
  the explicit recovery path.

### §"`maister.yaml` minimal v1 schema" → v2

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  main_branch: main
  branch_prefix: maister/
executors:                             # NEW — project-scoped executor catalog
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
  - id: claude-glm-ccr
    agent: claude
    model: glm-4.6
    router: ccr
  - id: codex-default
    agent: codex
    model: gpt-5-codex
default_executor: claude-sonnet        # NEW
flows:                                 # CHANGED — no inline `command:`, just plugin refs
  - id: bugfix
    source: github.com/<org>/maister-flow-bugfix
    version: v1.2.3                    # tag-pinned (lock semantics)
  - id: spec-kit
    source: github.com/<org>/maister-flow-spec-kit
    version: v0.4.1
    executor_override: claude-glm-ccr  # NEW — optional per-flow override
```

Plus a new per-plugin `flow.yaml` manifest inside each Flow repo:

```yaml
schemaVersion: 1
name: Bugfix
recommended_executor: claude-sonnet    # optional
setup: ./setup.sh                      # optional one-time install script
steps:
  - id: plan
    type: agent
    mode: new-session                  # or slash-in-existing
    prompt: "/aif-plan {{ task.prompt }}"
    pre_guards: []                     # cost/time/regex — metric-only on POC
    post_guards: []
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: review_comments
```

**New rejection rules** for project registration:
- `schemaVersion` mismatch in the project file OR any installed Flow's
  manifest
- Unknown `executor` or `executor_override` reference
- Unknown `goto_step` target inside a Flow manifest
- (Retained) slug collision, `repo_path` collision, duplicate IDs

### §"Concrete first vertical slice" — block-based → ACP-driven

Items **1, 2, 3, 4, 7, 8, 9, 10** are unchanged in intent (multi-project
registry, task creation, board, portfolio home, diff, merge buttons,
reconciliation, concurrency cap).

Items **5, 6** are rewritten:

- **5 (was: SSE log stream)** → Supervisor publishes ACP `session/update`
  events; Next.js Route Handler bridges to browser SSE; per-step log
  file tailed for `lastEventId` reconnect. Same disk-pipe pattern, new
  source.
- **6 (was: block-based HITL)** → Hybrid HITL: live path is ACP
  `session/request_permission` (binary) + structured-form artifact
  `needs-input.json`; recovery path is checkpoint + `--resume` if the
  user takes more than 30 min (extended by web-console activity).

**New item 11**: Flow plugin install pipeline — `git clone --branch <tag>`
into `~/.maister/flows/<id>@<tag>/`, symlink into project subtree, run
`setup.sh` on first install. Trust all sources on POC (internal Flows
only — sandboxing is Phase 2).

**New item 12**: HITL Inbox block on per-project board + "Needs you (N)"
badge on portfolio home.

## New components introduced by this revision

### `supervisor/` — separate Node daemon

```
supervisor/
├── package.json                    # separate npm package
├── tsconfig.json
└── src/
    ├── main.ts                     # HTTP+SSE entry: POST /sessions, etc.
    ├── acp-client.ts               # ACP client wrapping claude-code-acp
    ├── spawn.ts                    # child_process per session (claude/codex)
    ├── heartbeat.ts                # crash detection → mark Crashed
    ├── checkpoint.ts               # graceful pause on idle timeout
    └── http-api.ts                 # Route handlers (Express/Fastify)
```

API surface (web tier consumes this via `lib/supervisor-client.ts`):

- `POST /sessions` — start a new ACP session (or resume an existing one
  via `resume_session_id`)
- `DELETE /sessions/:id` — terminate (SIGTERM → SIGKILL after grace)
- `GET /sessions/:id/stream` — SSE of `session/update` events
- `POST /sessions/:id/input` — deliver HITL response to a live session
- `POST /sessions/:id/checkpoint` — force graceful pause (used by GC)
- `GET /sessions` — list live sessions (for reconcile + admin UI)

Lives in its own process so HMR / hot-reload of `web/` doesn't kill
running agents.

### `lib/flows.ts` (web tier) — Flow plugin loader

Responsibilities:
- `git clone --branch <tag>` into `~/.maister/flows/<id>@<tag>/`
- Symlink into `.maister/<slug>/flows/<id>/`
- Parse + validate `flow.yaml` manifest (zod)
- Run `setup.sh` once on first install (trust on POC)
- Detect version drift (project pins v1.2.3 but cache has v1.2.2 →
  fetch + relink)

### `lib/executors.ts` (web tier) — Executor registry

Responsibilities:
- Persist `executors[]` from `maister.yaml` to DB table
- Resolve per-step executor: run launcher → project override → project
  default → flow recommended
- Construct env vars for CCR routing (`router: ccr`)
- Validate executor availability at run start (`EXECUTOR_UNAVAILABLE`
  error if `claude` / `codex` binary missing)

### `lib/supervisor-client.ts` (web tier) — HTTP+SSE client

The only place in `web/lib/*` that talks to `supervisor/`. Wire-format
contract; no shared types between processes (DTO duplication is
intentional to keep the boundary explicit).

## Net scope / timeline impact

| Stream | Delta vs locked | POC days added |
|---|---|---|
| ACP supervisor daemon | NEW | +3-4 |
| Flow plugin install pipeline | NEW (replaces flat `command:`) | +4-5 |
| Flow DSL parser + step executor | NEW (replaces single subprocess) | +5-7 |
| Multi-executor schema + override resolution | NEW | +2-3 |
| HITL hybrid (artifact + ACP) + Inbox surface | EXPANDS scope | +2-3 |
| RU i18n | EXPANDS scope (was undated) | +2 |

**Total delta: +18-24 working days.** Locked POC target was T+1-1.5
weeks. Revised POC target: **T+4 to T+5 weeks** for end-to-end vertical
slice including multi-executor verification.

Calendar trade-off accepted by user with reasoning: "parallel coding
agents will save time back later, do it right now."

## Cut-set accepted (what we explicitly do NOT build on POC)

Carried over from chat decisions on 2026-05-25:

- **AI-Judge** — design-time presence in DSL OK, implementation Phase 2.
- **Cost / time / regex guard enforcement** — parse-and-persist as
  metrics on disk only; no kill-on-cap on POC.
- **Plugin trust UI / sandboxing** — trust all (internal sources only).
- **HITL as separate swimlane cards** — POC = badge + Inbox block on
  existing board.
- **Cursor / opencode / Aider executors** — POC = claude + codex only.
- **Custom ACP extensions** — Stage 1 = Zed-standard ACP only;
  structured-form HITL via artifact (no custom `session/request_*`).

## First Flow plugins for development & validation

- **Primary: `aif`** — already in use in this repo (Node CLI installing
  slash commands into the agent). Flow manifest wraps `/aif-explore`,
  `/aif-plan`, `/aif-implement`, `/aif-fix` as `slash-in-existing-session`
  agent steps. `setup.sh` ensures `ai-factory init` has been run against
  the agent in the worktree.
- **Fallback for simpler bring-up: `superpowers`** — skills-only
  plugin (no extra CLI). Useful as the minimum-viable Flow plugin to
  prove the loader + manifest + slash-command-step path without dragging
  in aif's full setup surface.

Both validate the plugin model surface; aif additionally validates the
`setup.sh` install path and per-plugin CLI shipping.

## Unresolved → now resolved

| Was | Resolution |
|---|---|
| `aif --resume <block-id>` semantics — native or shim? | Moot — block model dropped; resume is ACP-level via `--resume <session-id>` on the agent process |
| Claude Code headless binary — `claude`, `claude-code`, `openclaw`? | `claude` (per docs.claude.com/docs/en/headless and SDK package conventions) |
| `uv run` stdin propagation? | Not relevant — `uv` no longer mandatory in image |
| Single vs multi-executor in POC | Multi (claude + codex) |
| `maister.yaml` schema growth | Explicit v2 + Flow manifest |
| HITL kanban surface | Badge + Inbox block (not separate swimlane cards on POC) |

## Unresolved → resolved by M0 spike (2026-05-25)

All four spike items closed. Full report:
**`docs/kaa-maister-m0-spike-findings-20260525.md`**.

1. ✅ **ACP packages**: `@agentclientprotocol/claude-agent-acp@0.37.0` +
   `@agentclientprotocol/codex-acp@0.0.44` +
   `@agentclientprotocol/sdk@0.22.1`. All Apache-2.0. Canonical org is
   vendor-neutral `@agentclientprotocol` (Zed staff maintain, but the
   name was deliberately moved out of `@zed-industries`).
2. ✅ **Cross-process `claude --resume`** verified live. Sessions at
   `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`, append-only JSONL.
   No separate checkpoint format needed — `runs.acp_session_id` IS the
   handle.
3. ✅ **Codex** via `codex-acp` adapter binary (bundles `@openai/codex`
   0.128+). Same wire protocol as `claude-agent-acp`. Supervisor
   `spawn.ts` dispatches on `executor.agent`.
4. ✅ **z.ai GLM** works as plain env-router
   (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` +
   `ANTHROPIC_AUTH_TOKEN`) — CCR not required for single-provider
   third-party. CCR (`@musistudio/claude-code-router@2.0.0`, MIT) stays
   optional for intelligent multi-provider routing.

## New finding from M0 (not in original scope)

5. ⚠ **Cache-creation cost per respawn** — each cross-process resume
   rebuilds the full ~45-50k-token prompt cache (~$0.28 per cycle).
   Cache key does not survive process boundary even within 5-min TTL.
   **Reinforces the 30-min keep-alive design**: aggressive
   checkpointing on short HITL waits would multiply cost. Surface
   `MAISTER_KEEPALIVE_MINUTES` env var (default 30) for ops tuning.
   Record `cache_creation_input_tokens` per spawn into `cost.jsonl`
   for empirical validation.

## Still open (non-blocking)

- **tausik** — repo URL still TBD; defer to Phase 2.

External validation framing unchanged: 3 installations target, friend
names not required in advance.

## Where to read next

- `CLAUDE.md` (root) — canonical statement of §1-8 architectural
  commitments (post-revision)
- `web/CLAUDE.md` — web slice modules, Drizzle schema, run lifecycle
  with NeedsInputIdle
- `.ai-factory/ARCHITECTURE.md` — folder structure, dependency rules,
  anti-patterns (web/supervisor split)
- `.ai-factory/ROADMAP.md` — 13 milestones across 5 phases reflecting
  this revision
- `docs/kaa-maister-design-20260522-174429.md` — historical baseline
  (kept for archaeology; do not edit)
