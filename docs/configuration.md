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
| `executors[].agent` | `claude` or `codex` only. POC ships both adapters. |
| `executors[].model` | Non-empty. Free-form — the adapter validates. |
| `default_executor` | Must reference an `id` present in `executors[]`. |
| `flows[].id` | Unique within the file. |
| `flows[].source` | Non-empty. Resolved by the Flow loader (`git clone --branch <version>`). |
| `flows[].version` | Tag-pinned (lock semantics). Non-empty. |

### Optional fields

| Field | Default | Notes |
| ----- | ------- | ----- |
| `project.main_branch` | `main` | Merge target for runs on this project. |
| `project.branch_prefix` | `maister/` | Run-branch prefix; combined with the slug. |
| `executors[].env` | `null` | Map of env vars passed to the spawned agent (env-router pattern). |
| `executors[].router` | unset | `ccr` enables `@musistudio/claude-code-router` multi-provider routing inside the session. |
| `flows[].executor_override` | unset | When set, must reference an `id` in `executors[]`. Wins over Flow's `recommended_executor`. |

### Cross-reference checks

`loadProjectConfig()` runs these after schema validation:

1. `default_executor` must exist in `executors[].id`.
2. Every `flows[].executor_override` must exist in `executors[].id`.
3. No duplicate executor IDs; no duplicate flow IDs.

Any failure throws `MaisterError({ code: "CONFIG" })` with the offending
field path in the message.

### Per-step executor override resolution

Highest priority wins:

1. **Run launcher override** (UI Launch click).
2. **Project per-flow override** (`flows[].executor_override`).
3. **Project default** (`default_executor`).
4. **Flow's `recommended_executor`** from `flow.yaml` (optional).

If none of the above resolves to a registered executor, the loader
throws `MaisterError({ code: "EXECUTOR_UNAVAILABLE" })`.

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
    cost: 5                             # POC: parsed and persisted, not enforced
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

### Guard semantics (POC)

`cost` / `time` / `regex` guard fields are **parsed and persisted as
metrics on disk** under `.maister/<slug>/runs/<run-id>/cost.jsonl`. They
are **NOT enforced** in the POC — no kill-on-cap. Enforcement is Phase 2.

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

Field types are limited to `string | number | boolean | enum | array` on
POC. Add new types by extending `formFieldSchema` in
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
| `ANTHROPIC_API_KEY` | yes for default | — | Claude executor (unless overridden by per-executor `env`) |
| `ANTHROPIC_BASE_URL` | no | api.anthropic.com | Per-executor `env` overrides the global default |
| `ANTHROPIC_AUTH_TOKEN` | no | uses `ANTHROPIC_API_KEY` | Required when `ANTHROPIC_BASE_URL` points at a third-party (z.ai GLM, OpenRouter, …) |

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

## See Also

- [Error Taxonomy](error-taxonomy.md) — `CONFIG` semantics; what the UI
  shows on each rejection
- [Database Schema](database-schema.md) — how `maister.yaml` registration
  writes `projects + executors + flows` rows
- [Architecture](../.ai-factory/ARCHITECTURE.md) — dependency rules
  enforced around `lib/config.ts`
