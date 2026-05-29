# Flow DSL Reference

This document describes the Flow DSL used by `flow.yaml` manifests inside
Flow plugins, plus how the runner interprets it.

## Step types

A Flow is an ordered list of steps. Each step has an `id` (unique within
the flow) and a `type` chosen from:

| type    | what it does                                                              |
| ------- | ------------------------------------------------------------------------- |
| `cli`   | shells out to `bash -c <command>` with `cwd = worktreePath`               |
| `agent` | drives an ACP session through `claude-agent-acp` / `codex-acp`           |
| `guard` | observational gate — writes metrics, never blocks today                   |
| `human` | suspends the run, writes `needs-input.json`, inserts a `hitl_requests` row|

### `cli` step

```yaml
- id: lint
  type: cli
  command: "pnpm lint"
  pre_guards:   []   # optional, observational only
  post_guards:  []
```

The `command` is rendered via the templating engine before execution. The
captured stdout becomes `steps.<id>.output` for subsequent templates.
Non-zero exit maps the step to `errorCode: PRECONDITION` and aborts the
flow with `runs.status = "Failed"`. Timeout default is 5 min
(`timeoutMs` configurable at the call site).

### `agent` step

```yaml
- id: plan
  type: agent
  mode: new-session            # OR slash-in-existing
  prompt: "/aif-plan {{ task.prompt }}"
  pre_guards:  []
  post_guards: []
```

`mode` selects how supervisor sessions are reused:

- **`new-session`** — every step spawns a fresh adapter process and
  initialises a new ACP session. Deleted on `end_turn`. Cleanest
  isolation; loses cached context between steps.
- **`slash-in-existing`** — the first agent step seeds one supervisor
  session; subsequent steps reuse it via `POST /sessions/:id/prompt`.
  Slash commands like `/aif-plan` accumulate context across turns. The
  session is deleted at the end of the run (or on `human` step
  suspension).

The step completes when `PromptResponse.stopReason` resolves. `end_turn`
is success; `max_tokens` / `max_turn_requests` / `refusal` map to
`errorCode: ACP_PROTOCOL` (run → `Failed`); `cancelled` raises a
`SupervisorError("ACP_PROTOCOL", ...)`.

### `guard` step

```yaml
- id: budget
  type: guard
  cost: 10000   # tokens
  time: 300     # seconds
  regex: "ERROR"
```

A standalone observational step. The runner evaluates the guard against
the previous step's metrics (observational today), writes a metric line
to `.maister/<slug>/runs/<run-id>/guards.jsonl`, and always returns
success.

### `human` step

```yaml
- id: review
  type: human
  form_schema: ./schemas/review.json
  on_reject:
    goto_step: implement
    comments_var: review_comments
```

Inserts a `hitl_requests` row of `kind: "human"`, transitions the run to
`NeedsInput`, and returns. The response route writes
`input-<stepId>.json` after the HITL row is claimed, then schedules
`runFlow`; the runner owns the `NeedsInput -> Running` transition.
`on_reject.goto_step` is recorded but not yet executed by the runner.

## Pre- and post-guards (observational)

Guards attached to `cli` and `agent` steps are evaluated **before** the
step (`pre_guards`, against zero observed metrics) and **after** the step
(`post_guards`, against `{durationMs, stdout, costTokens}`). Cost guard
evaluation reads token totals from `cost.jsonl` when present. Cap
exceedance emits a `WARN` log line but never aborts. Guard metrics are
written to `.maister/<slug>/runs/<run-id>/guards.jsonl`.

Phase 2 will add enforcement (cancel on cost/time cap).

## Templating

Templates use Mustache strict mode (`mustache@4`). Undefined paths throw
`MaisterError("CONFIG", "undefined template var: <path>")` instead of
rendering as empty string. HTML escaping is disabled — prompts/commands
are not HTML.

Context paths available inside templates:

| path                             | source                                     |
| -------------------------------- | ------------------------------------------ |
| `task.id`                        | `tasks.id`                                 |
| `task.title`                     | `tasks.title`                              |
| `task.prompt`                    | `tasks.prompt`                             |
| `task.attemptNumber`             | `tasks.attempt_number`                     |
| `run.id`                         | `runs.id`                                  |
| `run.attemptNumber`              | mirrors `task.attemptNumber` until run-level attempts land |
| `run.projectSlug`                | `projects.slug`                            |
| `executor.id`                    | `executors.id`                             |
| `executor.agent`                 | `claude \| codex`                          |
| `executor.model`                 | `executors.model`                          |
| `executor.router`                | `ccr` if set, else undefined               |
| `steps.<id>.output`              | `step_runs.stdout`, truncated to 8 KiB     |
| `steps.<id>.vars.<name>`         | `step_runs.vars` jsonb                     |
| `steps.<id>.exitCode`            | `step_runs.exit_code`                      |
| `env.<KEY>`                      | filtered process.env (see below)           |

Highest-attempt-wins: when a step has been retried, `steps.<id>` resolves
to the row with the highest `attempt`.

## env whitelist + secret blocklist

`env.*` exposes a filtered subset of `process.env`. Deny patterns (case-
insensitive):

```
*TOKEN*  *KEY*  *SECRET*  *PASSWORD*  *AUTH*
ANTHROPIC_*  OPENAI_*  DB_URL  MAISTER_SUPERVISOR_URL
*CREDENTIAL*  *PRIVATE*
```

Allow patterns: `LANG`, `LC_*`, `TZ`, `PATH`, `HOME`, `USER`, `SHELL`,
`TERM`. Tests may inject extra allow patterns via the
`envWhitelist: RegExp[]` arg of `buildContext()`.

## Step output vars

`step_runs.vars` is `{}` for `cli` and `agent` steps today — the runner
does not yet extract structured output. The column + UNIQUE constraint
ship now so future work (tool-call extraction, retry, etc.) can populate
it without another migration.

## ACP wire

The supervisor speaks ACP via `@agentclientprotocol/sdk@0.22.1`'s
`ClientSideConnection`. One ACP session per `POST /sessions` (per
`agent` step in `new-session` mode, or per run in `slash-in-existing`
mode).

- `initialize` is called once at connection time.
- `newSession` produces the `acpSessionId` (persisted on `runs.acp_session_id`).
- `prompt` is the per-turn driver; its `PromptResponse.stopReason` IS
  the end-of-turn detector — no marker hunting, no idle-timeout
  fallback.
- `sessionUpdate` notifications stream during the turn; the supervisor
  re-emits them as `session.update` SSE events.
- `requestPermission` emits `session.permission_request`; the runner
  persists a permission HITL row and moves the run to `NeedsInput`.
  The user response route calls `POST /sessions/:id/input` with
  `{kind:"permission", action:"select", requestId, optionId}`.

## Run state machine

```
Pending  ─tryStartRun─►  Running  ─runFlow─►  Review     (success)
                                    │
                                    └──┬──►   Failed     (step ok=false / throw)
                                       ├──►   Crashed    (crash-class error)
                                       └──►   NeedsInput (permission/form/human)
                                                  │
                                                  └──► Running (runner-owned resume)
```

The designed checkpoint path adds `NeedsInput -> NeedsInputIdle ->
Running` via `acp_session_id` resume. The checkpoint endpoint is still a
deferred stub.

## Example minimal `flow.yaml`

```yaml
schemaVersion: 1
name: greet
steps:
  - id: hello
    type: cli
    command: "echo Hello, {{ task.prompt }}"
```

Install: `pnpm install-flow --source /abs/path/to/this/dir --version
local-dev --flow-id greet --project <slug>`.

Launch a run: `POST /api/runs` with `{ taskId }` (after seeding a task
that references this flow).

## See also

- `docs/flow-aif-plugin.md` — walkthrough of the bundled `aif` plugin.
- `docs/flow-installer.md` — install pipeline + local-source path.
- `docs/supervisor.md` — ACP wire, SSE events, prompt endpoint.
- `docs/getting-started.md` — end-to-end "Launch a run" recipe.
