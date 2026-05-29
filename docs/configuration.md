[← Error Taxonomy](error-taxonomy.md) · [Back to README](../README.md)

# Configuration

Two layered manifests define how MAIster runs:

- **`maister.yaml` v2** — per-project: which executors, which Flow plugins,
  which default executor. Lives in the registered repo root.
- **`flow.yaml` v1** — per-Flow-plugin: the step DSL (cli / agent / guard /
  human), recommended executor, optional `setup.sh`. Lives in each
  plugin's git repo.

Plus environment variables for the server tier itself.

All validators live in `web/lib/config.ts` (zod schemas in
`web/lib/config.schema.ts`). Every failure path throws
[`MaisterError({ code: "CONFIG" })`](error-taxonomy.md).

## `maister.yaml` v2

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  main_branch: main           # default: main
  branch_prefix: maister/     # default: maister/
executors:
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
  - id: claude-glm-ccr
    agent: claude
    model: glm-4.6
    router: ccr               # optional: route via @musistudio/claude-code-router
  - id: claude-glm-env
    agent: claude
    model: glm-4.6
    env:                      # env-router: any Anthropic-compatible provider
      ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
      ANTHROPIC_AUTH_TOKEN: ${Z_AI_TOKEN}
  - id: codex-default
    agent: codex
    model: gpt-5-codex
default_executor: claude-sonnet
flows:
  - id: bugfix
    source: github.com/org/maister-flow-bugfix
    version: v1.2.3
  - id: spec-kit
    source: github.com/org/maister-flow-spec-kit
    version: v0.4.1
    executor_override: claude-glm-ccr     # optional per-flow override
```

### Required fields

| Field | Rule |
| ----- | ---- |
| `schemaVersion` | Must be the integer `2`. Loader refuses on any other value. |
| `project.name` | Non-empty string. The `slug` is derived from this (kebab-case). |
| `project.repo_path` | Non-empty absolute path. UNIQUE across registered projects. |
| `executors[]` | At least one entry. Each `id` must be unique within the file. |
| `executors[].agent` | `claude` or `codex` only. Current adapters cover both. |
| `executors[].model` | Non-empty. Free-form — the adapter validates. |
| `default_executor` | Must reference an `id` present in `executors[]`. |
| `flows[].id` | Unique within the file. |
| `flows[].source` | Non-empty. Resolved by the Flow loader (`git clone --branch <version>`). |
| `flows[].version` | Tag-pinned (lock semantics). Non-empty. The tag is the user-facing pin; at install the loader records the resolved git commit SHA in `flows.revision` and at run launch snapshots it into `runs.flow_revision`. The runner derives the bundle path from `(flowRefId, flow_revision)`, so a tag re-pointed upstream after the run launched does not affect that run. |

### Optional fields

| Field | Default | Notes |
| ----- | ------- | ----- |
| `project.main_branch` | `main` | Merge target for runs on this project. |
| `project.branch_prefix` | `maister/` | Run-branch prefix; combined with the slug. |
| `executors[].env` | `null` | Map of env vars passed to the spawned agent (env-router pattern). |
| `executors[].router` | unset | `ccr` enables `@musistudio/claude-code-router` multi-provider routing inside the session. |
| `flows[].executor_override` | unset | When set, must reference an `id` in `executors[]`. Persisted to `flows.executor_override_id` by `upsertExecutorsFromConfig()` and slots into the override chain at tier 3 (between task override and project default). |

### Cross-reference checks

`loadProjectConfig()` runs these after schema validation:

1. `default_executor` must exist in `executors[].id`.
2. Every `flows[].executor_override` must exist in `executors[].id`.
3. No duplicate executor IDs; no duplicate flow IDs.

Any failure throws `MaisterError({ code: "CONFIG" })` with the offending
field path in the message.

### Per-step executor override resolution

Highest priority wins. The chain is five tiers — per-task choice
beats per-flow rule:

1. **Run launcher override** (`POST /api/runs body.executorOverrideId`).
2. **Task override** (`tasks.executor_override_id`).
3. **Project per-flow override** (`flows.executor_override_id`, populated from `flows[].executor_override` in `maister.yaml`).
4. **Project default** (`projects.default_executor_id`, populated from `default_executor` in `maister.yaml`).
5. **Flow's `recommended_executor`** from `flow.yaml` (optional).

Implementation lives in `web/lib/executors.ts:resolveExecutor()` and is
called by `POST /api/runs`. The function is pure — no DB access, no
log side effects — and returns `{executorId, tier}`. Callers can pass
`override: undefined` to get the "computed executor for display" path
used by a task-card computed-executor badge.

If none of the above resolves to a registered executor, the resolver
throws `MaisterError({ code: "EXECUTOR_UNAVAILABLE" })` (HTTP 503).

## `flow.yaml` v1

The manifest each Flow plugin ships in its git repo.

```yaml
schemaVersion: 1
name: Bugfix
recommended_executor: claude-sonnet     # optional
setup: ./setup.sh                       # optional one-time install hook
steps:
  - id: plan
    type: agent
    mode: new-session                   # or slash-in-existing
    prompt: "/aif-plan {{ task.prompt }}"
  - id: lint
    type: cli
    command: pnpm lint
  - id: budget
    type: guard
    cost: 5                             # parsed and persisted, not enforced today
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: review_comments
```

### Step types

Discriminated on `type`:

| Type | Required fields | Optional fields |
| ---- | --------------- | --------------- |
| `cli` | `id`, `type=cli`, `command` | `pre_guards`, `post_guards` |
| `agent` | `id`, `type=agent`, `mode=new-session\|slash-in-existing`, `prompt` | `pre_guards`, `post_guards` |
| `guard` | `id`, `type=guard` + at least one of `cost`, `time`, `regex` | — |
| `human` | `id`, `type=human`, `form_schema` (path to JSON schema with `schemaVersion`) | `on_reject.goto_step`, `on_reject.comments_var` |

### Cross-reference checks

`loadFlowManifest()` runs:

1. No duplicate step IDs.
2. Every `on_reject.goto_step` must reference an existing step id.

`recommended_executor`, if present, is a non-empty string. Its existence in
the project's `executors[]` is validated at project-load time, not here —
the manifest can be loaded standalone for testing.

### Guard semantics

`cost` / `time` / `regex` guard fields are parsed and evaluated as
observational signals. Guard results are written to
`.maister/<slug>/runs/<run-id>/guards.jsonl`. Cost guards compare
against token totals from `cost.jsonl` when the supervisor has emitted
usage records. Guards do not kill a run today; enforcement is Phase 2.

## `form_schema` versioning

Every HITL `human` step's form payload includes a required `schemaVersion`
integer. The runtime compares this against the version the agent step
expected; mismatch → `MaisterError({ code: "CONFIG" })`.

```ts
import { validateFormSchemaVersion } from "@/lib/config";

validateFormSchemaVersion(readBackJson, 1);   // ok if readBackJson.schemaVersion === 1
validateFormSchemaVersion(readBackJson, 2);   // throws CONFIG with both versions named
```

Schema shape:

```yaml
schemaVersion: 1
fields:
  - name: comment
    label: Reviewer comment
    type: string             # string | number | boolean | enum | array
    required: true
  - name: severity
    type: enum
    options: [low, medium, high]
  - name: confirm
    type: boolean
    default: false
```

Field types are limited to `string | number | boolean | enum | array`.
Add new types by extending `formFieldSchema` in
`web/lib/config.schema.ts`.

## Environment variables (server tier)

Read by Next.js (`web/`) and `supervisor/` at startup:

| Var | Required | Default | Used by |
| --- | -------- | ------- | ------- |
| `DB_URL` | yes | — | `lib/db/client.ts`; accepts `postgres://...` or `file:...` |
| `MAISTER_DB_POOL_MAX` | no | `10` | Postgres pool size in `lib/db/client.ts` |
| `MAISTER_MAX_CONCURRENT_RUNS` | no | `3` | Global concurrency cap (across all projects) |
| `MAISTER_KEEPALIVE_MINUTES` | no | `30` | NeedsInput keep-alive window (extended by web-console activity) |
| `MAISTER_PROJECTS_DIR` | no | unset | Auto-discovery root; every `maister.yaml` under this dir is registered on startup |
| `MAISTER_SUPERVISOR_URL` | no | `http://localhost:7777` | Web → supervisor HTTP+SSE base URL — see [Supervisor](supervisor.md) |
| `MAISTER_SUPERVISOR_PORT` | no | `7777` | Supervisor bind port (read by `supervisor/src/main.ts`) |
| `MAISTER_RUNTIME_ROOT` | no | supervisor `cwd` | Root under which `.maister/<slug>/runs/...` is written |
| `MAISTER_HEARTBEAT_INTERVAL_MS` | no | `5000` | Supervisor orphan-child detection |
| `MAISTER_KILL_GRACE_MS` | no | `5000` | SIGTERM → SIGKILL grace per session |
| `MAISTER_SHUTDOWN_GRACE_MS` | no | `15000` | Total budget for graceful supervisor shutdown |
| `LOG_LEVEL` | no | `debug` (dev) / `info` (prod) | pino level for both web and supervisor |
| `ANTHROPIC_API_KEY` | yes for default | — | Claude executor (unless overridden by per-executor `env`) |
| `ANTHROPIC_BASE_URL` | no | api.anthropic.com | Per-executor `env` overrides the global default |
| `ANTHROPIC_AUTH_TOKEN` | no | uses `ANTHROPIC_API_KEY` | Required when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …) |
| `MAISTER_CCR_AUTH_TOKEN` | no | unset | Fallback for `ANTHROPIC_AUTH_TOKEN` when an executor has `router: ccr` and does not pin the token in `executor.env`. Missing token → `EXECUTOR_UNAVAILABLE` (503). |
| `MAISTER_CCR_CONFIG_PATH` | no | `/app/.ccr/config.json` in Docker, `~/.claude-code-router/config.json` otherwise | Container-side path the supervisor reads for CCR host+port. In compose this aligns with the bind-mount target — leave unset unless changing the layout. |
| `MAISTER_CCR_CONFIG_HOST_PATH` | no (Docker only) | `${HOME}/.claude-code-router` | Host directory bind-mounted at `/app/.ccr` (read-only) in the supervisor service. Point at a secret-mount directory for hardened deployments. |

Secrets MUST live in `.env` server-side. Never logged, never streamed via
SSE, never embedded in `session/update` payloads visible to the browser.

`.env.example` in the repo root documents the full set with safe placeholder
values.

## Public API

### `lib/config.ts`

| Export | Signature | Throws on |
| ------ | --------- | --------- |
| `loadProjectConfig(path)` | `(string) => Promise<MaisterYamlV2>` | Missing file, invalid YAML, schema error, cross-ref failure. All → `MaisterError({ code: "CONFIG" })`. |
| `loadFlowManifest(path)` | `(string) => Promise<FlowYamlV1>` | Missing file, invalid YAML, schema error, dup step ids, dangling `goto_step`. All → `MaisterError({ code: "CONFIG" })`. |
| `validateFormSchemaVersion(obj, expected)` | `(unknown, number) => void` | Malformed form schema OR version mismatch. → `MaisterError({ code: "CONFIG" })` with both versions in the message. |

### `lib/config.schema.ts`

Zod schemas + inferred types:

```ts
import {
  maisterYamlV2Schema, type MaisterYamlV2,
  flowYamlV1Schema, type FlowYamlV1,
  executorSchema, type ExecutorConfig,
  flowEntrySchema, type FlowEntry,
  stepSchema, type Step,
  formSchemaSchema, type FormSchema,
} from "@/lib/config.schema";
```

Import the inferred types in Route Handlers / components instead of
hand-rolling DTOs — the zod schema is the single source of truth.

## CCR (Claude Code Router) bundling

When an executor sets `router: ccr`, MAIster spawns the bundled
[`@musistudio/claude-code-router@2.0.0`](https://www.npmjs.com/package/@musistudio/claude-code-router)
daemon and routes the adapter through it for in-session multi-provider
routing (z.ai GLM, MiniMax, OpenRouter, …).

- The npm package is an exact-pinned **supervisor** dep — operators do
  NOT need to install `ccr` globally. The bin is on the workspace path.
- The supervisor owns the daemon lifecycle. The first `router=ccr`
  spawn lazily starts CCR; subsequent spawns within the same supervisor
  process reuse the same daemon; supervisor SIGTERM/SIGINT stops it.
- The daemon's own configuration file
  (`~/.claude-code-router/config.json`) is **user-managed**. MAIster
  reads `HOST` / `PORT` from it (defaults `127.0.0.1:3456`) but never
  writes the file. Provider keys, default models, routing rules — all
  in that file. In Docker, the host directory (default
  `~/.claude-code-router`, overridable via `MAISTER_CCR_CONFIG_HOST_PATH`)
  is bind-mounted **read-only** at `/app/.ccr` inside the supervisor
  container; the supervisor reads `/app/.ccr/config.json`.
- The adapter token sent in `ANTHROPIC_AUTH_TOKEN` resolves from
  `executor.env.ANTHROPIC_AUTH_TOKEN` ∨ `MAISTER_CCR_AUTH_TOKEN`
  (server env). Missing token surfaces as `EXECUTOR_UNAVAILABLE`
  (503).
- See [executors §CCR setup](system-analytics/executors.md#ccr-setup)
  for the full failure-mode table (config missing, malformed JSON,
  health-check timeout, token missing).

Example executor entry routing GLM-4.6 through CCR:

```yaml
executors:
  - id: claude-glm-ccr
    agent: claude
    model: glm-4.6
    router: ccr
    env:
      # Token consumed by the adapter (CCR currently accepts any non-empty
      # value because routing decisions live in config.json). The vendor
      # provider keys themselves go in ~/.claude-code-router/config.json,
      # NOT here. Placeholders only.
      ANTHROPIC_AUTH_TOKEN: ${CCR_ADAPTER_TOKEN}
```

Example `~/.claude-code-router/config.json` (placeholders — replace
with real values):

```json
{
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "Providers": [
    {
      "name": "z.ai",
      "api_base_url": "https://api.z.ai/api/anthropic",
      "api_key": "<Z_AI_KEY_PLACEHOLDER>",
      "models": ["glm-4.6"]
    }
  ],
  "Router": {
    "default": "z.ai,glm-4.6"
  }
}
```

## See Also

- [Supervisor](supervisor.md) — the ACP daemon that consumes
  `executors[].env` + `executors[].router` and the supervisor-specific
  env vars listed above
- [Error Taxonomy](error-taxonomy.md) — `CONFIG` semantics; what the UI
  shows on each rejection
- [Database Schema](database-schema.md) — how `maister.yaml` registration
  writes `projects + executors + flows` rows
- [Architecture](../.ai-factory/ARCHITECTURE.md) — dependency rules
  enforced around `lib/config.ts`
