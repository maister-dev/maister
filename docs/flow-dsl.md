# Flow DSL Reference

This document describes the Flow DSL used by `flow.yaml` manifests inside
Flow plugins, plus how the runner interprets it.

Package install, trust, enablement, upgrade, rollback, and removal are tracked
separately from the DSL itself. See
[`system-analytics/flow-packages.md`](system-analytics/flow-packages.md) for
the planned M10 package lifecycle.

## Step types

A Flow is an ordered list of steps. Each step has an `id` (unique within
the flow) and a `type` chosen from:

| type    | what it does                                                              |
| ------- | ------------------------------------------------------------------------- |
| `cli`   | shells out to `bash -c <command>` with `cwd = worktreePath`               |
| `agent` | drives an ACP session through `claude-agent-acp` / `codex-acp`           |
| `guard` | observational gate — writes metrics, never blocks today                   |
| `human` | suspends the run, writes `needs-input.json`, inserts a `hitl_requests` row|

## Flow graph node lifecycle (M11a — Designed)

> **Status (M11a).** Flow graph v1 — the `nodes[]` manifest, node-lifecycle
> compile, the append-only `node_attempts` ledger, the review-driven rework
> loop, and gate execution — is **Implemented** in M11a, shipped on the
> `feature/m11a-flow-graph-lifecycle` branch. Sub-parts owned by later
> milestones are tagged
> inline: the node `settings` block → **M11c (Designed)** (parsed as opaque
> passthrough in M11a, enforced in M11c); manual takeover / `human_edit` /
> `merge` nodes → **M11b (Designed)**; typed artifact instances
> (`input.requires` / `output.produces`) → **M12**. Decisions:
> [ADR-022](decisions.md#adr-022-flow-graph-manifest-v1-nodes--engine-version-bump),
> [ADR-023](decisions.md#adr-023-append-only-node_attempts-run-ledger),
> [ADR-024](decisions.md#adr-024-full-featured-gate-execution-in-m11a-m15-re-scoped),
> [ADR-025](decisions.md#adr-025-split-m11-into-m11a--m11b--m11c). The node
> lifecycle state machine, traversal, staleness, and rework loop are drawn in
> [`system-analytics/flow-graph.md`](system-analytics/flow-graph.md).

The current runner executes ordered `steps[]`. M11a keeps that path backwards
compatible and introduces Flow graph v1 as the product-grade execution model: a
manifest declares an optional top-level `nodes[]` (mutually exclusive with
`steps[]`), and the runner compiles **both** forms to a normalized node graph.
Every legacy `steps[]` step compiles to a single-action node with default
`transitions.success → next` and no rework, so linear Flows run exactly as
before. Graph flows MUST declare `compat.engine_min: 1.1.0`.

```yaml
nodes:
  - id: implement
    type: ai_coding
    input:
      requires:
        - task.prompt
        - steps.plan.output
        - artifact: plan-summary
          kind: generic_file
    # settings: M11c (Designed) — in M11a this block is parsed as an opaque
    # passthrough (preserved, not enforced) and emits SETTINGS_NOT_ENFORCED_WARN;
    # typed validation + enforcement land in M11c.
    settings:
      executors: [codex-fast, claude-strong]
      thinkingEffort: high
      mcps: [github, filesystem]
      skills: [aif-implement, aif-best-practices]
      settingsProfile: codex-default-step
      tools:
        codex: [shell, apply_patch]
        claude: [Read, Edit, Bash]
      restrictions:
        - no-global-installs
        - no-secret-env
      permissionMode: ask
      limits:
        maxDurationMinutes: 45
        maxCostUsd: 5
    action:
      prompt: "/aif-implement {{ task.prompt }}"
    output:
      produces:
        - id: implementation-log
          kind: log
          path: ".maister/{{ run.id }}/implement.log"
          visibility: timeline
        - id: implementation-diff
          kind: diff
          path: "."
          visibility: review
          requiredForReview: true
    pre_finish:
      gates:
        - id: format
          kind: command_check
          mode: blocking
          command: "pnpm prettier --check ."
          output:
            id: format-report
            kind: lint_report
        - id: test
          kind: command_check
          mode: blocking
          command: "pnpm test"
          output:
            id: test-report
            kind: test_report
        - id: implementation-quality
          kind: ai_judgment
          mode: advisory
          prompt: "Review the diff against the task requirements."
          output:
            id: quality-judgment
            kind: ai_judgment
        - id: internal-review
          kind: skill_check
          mode: blocking
          skill: aif-review
          command: "/aif-review"
          inputArtifacts: [implementation-diff, test-report]
          output:
            id: internal-review-result
            kind: ai_judgment
    finish:
      human:
        role: maintainer
        decisions: [approve, rework, takeover]
    transitions:
      approve: review
      rework: implement
      takeover: human-edit   # takeover decision + human-edit target: M11b (Designed)
    rework:
      allowedTargets: [implement]
      # M11a executes `keep`; rewind-to-node-checkpoint / fresh-attempt are
      # validated + recorded but execution is deferred to M11b.
      workspacePolicies: [keep, rewind-to-node-checkpoint, fresh-attempt]
      maxLoops: 3
      commentsVar: review_comments

  # human_edit node (manual takeover): M11b (Designed) — not executed in M11a.
  - id: human-edit
    type: human_edit
    settings:
      roles: [maintainer, project-owner]
      allowFurtherTracks: true
      returnRequires:
        - pushed-commit
        - summary
      staleFrom: implement
    output:
      produces:
        - id: returned-commits
          kind: commit_set
          requiredForReview: true
        - id: returned-diff
          kind: diff
          requiredForReview: true
```

Lifecycle sections:

| section | purpose |
| ------- | ------- |
| `input` | Declares required artifacts, prior outputs, human answers, and environment. |
| `settings` | Holds type-specific capability, role, policy, timeout, cost, and restriction controls. |
| `action` | Performs the node work: AI coding, CLI, check, judge, human review, human edit, or merge. |
| `output` | Declares typed artifacts the node produces for later inputs, gates, review, and merge. |
| `pre_finish` | Runs Flow-declared gates before the node can finish. |
| `finish` | Captures final gates such as human review, branch return, or merge acceptance. |
| `transitions` | Maps declared outcomes to declared node ids. |
| `rework` | Defines allowed targets, workspace policy, loop limits, and where comments become later input. |

**Node `settings` — M11c (Designed).** In M11a the `settings` block is parsed
as an opaque passthrough: it is preserved on the node (never silently stripped),
records a one-time `SETTINGS_NOT_ENFORCED_WARN`, and is **not enforced**. Typed
validation and the runtime enforcement boundary (refuse undeclared
MCP/tool/skill/restriction) land in M11c, resolving registry refs through the
M14 capability registry.

Node-specific settings are intentionally first-class product configuration:
AI-coding nodes constrain executors, agent definitions, MCP servers, tools,
skills, thinking effort, permissions, workspace access, and limits. Human nodes
constrain project roles, allowed decisions, manual takeover, further tracks,
SLA/staleness hints, and return requirements. CLI/check/judge nodes constrain
commands, environment policy, artifact inputs/outputs, timeout, and failure
classification.

Planned M14 resolves every `settings.executors`, `settings.mcps`,
`settings.skills`, `settings.settingsProfile`, `settings.tools`, and
`settings.restrictions` entry through the project capability registry before
execution. The resolved profile is agent-aware: the same abstract tool id can
map to different concrete Claude or Codex tool names.

The runner enforces the resolved profile at the AI session scope. For a
per-node session, the profile is effectively node-scoped: before the node
starts, the runner materializes only that node's allowed skills, MCP config,
adapter `settings.json` or equivalent settings file, environment profile, and
tool restrictions, then removes/restores them when the node ends. For a
long-living ACP session, skills, MCPs, settings, and tool restrictions are
session-wide: every AI node inside that session must share the same resolved
capability profile. If a later node needs different capabilities, the Flow must
declare a new session boundary unless the adapter supports explicit safe profile
swap.

If a Flow requires strict enforcement and the selected executor can only receive
the restriction as an instruction, MAIster refuses the node launch instead of
silently weakening the capability boundary.

**Review-driven rework — M11a (Implemented).** Human review does not execute
arbitrary `goto_step`. The Flow declares allowed decisions and targets; the
reviewer chooses one allowed decision, adds structured instructions, and chooses
an allowed workspace policy. The submitted decision is validated against the
manifest-derived allow-list stored on the `hitl_requests` row at creation time
(server-state, never body-trusted). Any rework return marks downstream gates,
checks, and AI judgments **stale**; the run cannot reach a fresh review until
the Flow-declared validation path reruns and produces current results. In a
graph flow the legacy `human` step `on_reject.goto_step` is **superseded** by
node `transitions` + `finish.human.decisions`; linear `steps[]` flows retain the
documented (still-unexecuted) `on_reject.goto_step` behavior.

**Manual takeover — M11b (Designed).** Manual takeover is modeled as a
human-edit node. A reviewer claims the task in MAIster, receives an editable
branch, checks it out on the developer machine, commits and pushes changes, then
returns the branch through the UI. The run ledger records owner, elapsed time,
handoff branch, returned commits, returned diff, checkpoint refs, stale gate
markers, and rerun results. Not executed in M11a (no `HumanWorking` run status).

## Gate execution (M11a — Implemented)

> **Status (M11a).** Gate execution is **Implemented** in M11a (per
> [ADR-024](decisions.md#adr-024-full-featured-gate-execution-in-m11a-m15-re-scoped)).
> The gate STATUS lifecycle, structured
> verdicts, blocking/advisory modes, staleness propagation, and
> override-without-erasure live here, not in M15. M15 (below) keeps only the
> readiness-policy DSL, verdict calibration, and `external_check` ingestion.

A node's `pre_finish.gates` run in declared order before the node can finish.
Each gate writes a `gate_results` row. Gate kinds and their M11a execution
status:

| kind | purpose | M11a |
| ---- | ------- | ---- |
| `command_check` | Runs formatter, test, lint, typecheck, build, or custom command via `bash -c`; exit 0 = `passed`, else `failed`. | **Executes** |
| `ai_judgment` | Produces a structured model verdict over the diff/logs/requirements via an agent session (defaults to `new-session`). | **Executes** |
| `human_review` | Captures approve/rework decisions through the review HITL. | **Executes** |
| `skill_check` | Runs an internal slash command (e.g. `/aif-review`) via an agent session. | **Executes (best-effort)** — no capability scoping until M14 |
| `artifact_required` | Verifies required evidence exists and is current. | **Stubbed** → `skipped` + WARN + `TODO(M12)` (needs M12 artifact instances) |
| `external_check` | Waits for CI / another system to report through the operations API. | **Stubbed** → `pending` + WARN + `TODO(M16)` (no ingestion endpoint until M16) |

Every gate has `mode: blocking | advisory`, optional input artifacts, an
optional produced artifact, stale-from dependencies, and a status:
`pending | running | passed | failed | stale | skipped | overridden`. A
`blocking` gate failure aborts the node finish (the run goes `Failed` unless a
rework target is available); an `advisory` gate records its result and the node
continues.

AI and skill gates produce **structured verdicts**: `{ verdict, confidence,
reasons, recommendedAction }`. Readable prose is still stored as evidence, but
UI readiness reads the typed result. An unparseable verdict is recorded as
`gate_results.status = 'failed'` with the raw prose kept as evidence — **no new
`MaisterError` code** is thrown
([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror) closed union).

**Staleness.** When a reviewer reworks (manual-takeover return is M11b),
`markDownstreamStale` flips dependent `gate_results` `passed → stale`; a stale
blocking gate must rerun before the node can finish again.

**Override without erasure.** A human override is allowed only through a declared
`human_review` decision; it sets the gate `overridden` and records the deciding
HITL, but it **never deletes** the original failed/stale verdict.

> **M11a gates feed but do NOT gate promotion.** Writing a `gate_results` row
> does not block merge in M11a. Promotion readiness (refusing merge on a missing/
> failed/stale required gate) is the M15/M18 readiness policy described below.

## Planned M12: typed artifacts and evidence graph

Flow graph nodes can declare typed artifacts as inputs and outputs. Runtime
records artifact metadata in the database and keeps payloads in the run
directory, worktree, or git repository. The first artifact kinds are:
`diff`, `log`, `test_report`, `lint_report`, `ai_judgment`, `human_note`,
`commit_set`, `checkpoint`, `preview`, and `generic_file`.

Each artifact instance belongs to a run, node, and attempt. It records the
artifact definition id, kind, producer, uri/path, hash, size, created time, and
validity: `current`, `stale`, `superseded`, `failed`, or `skipped`.

The run detail UI includes an evidence graph explorer. It connects task inputs,
node attempts, artifacts, gates, human decisions, returned commits, and merge
readiness. This graph is read-only: it helps the operator inspect evidence,
filter by node/kind/state, open raw payloads, and understand which stale or
missing artifact blocks review or merge. It is not the Flow designer.

Deferred for now: content-addressed blob storage, artifact marketplace,
benchmark datasets, rich preview sandboxing, cross-run artifact reuse, full
payload-schema validation for every artifact kind, provider-specific CI apps,
and CI ingestion beyond the generic external gate report contract.

## Planned M15: readiness policy and verdict calibration

> **Re-scoped (ADR-024).** M11a annexed gate *execution* — the kinds, status
> lifecycle, structured verdicts, blocking/advisory modes, staleness, and
> override-without-erasure now live under **Gate execution (M11a)** above. M15
> keeps only the readiness-policy DSL, verdict calibration, and `external_check`
> ingestion.

Flow plugins distribute readiness policy with the Flow. Project config supplies
reusable command profiles, skill mappings, capabilities, env profiles, and
default limits, but the Flow declares which gates are required for its delivery
process, and the readiness policy decides when a run may promote.

Review and merge refuse when any required blocking gate is missing, pending,
running, failed, stale, or skipped. **M11a records gate results but does not
enforce this promotion-gating** — refusing a merge on an unsatisfied required
gate is the M15/M18 readiness check. Human override stays a declared
`human_review` decision that produces a human-note artifact and never deletes
the failed evidence (override-without-erasure itself ships in M11a).

Verdict calibration tunes confidence thresholds per gate / Flow. `external_check`
ingestion — the report contract that lets CI or another external system satisfy
a `pending` gate — is delivered with the M16 operations API (see Planned M16
below); M15 owns the readiness policy that consumes it.

## Planned M16: external operations API and MCP facade

Flow plugins may declare `external_check` gates when evidence must arrive from
outside the runner: CI, a local script, a repository-hosted check, or another
tool. The runner creates the pending gate result and exposes a report contract
through the project-scoped operations API. External systems do not mutate run
state directly; they attach evidence to the gate.

An external check report records:

| field | purpose |
| ----- | ------- |
| `gateId` | Flow-declared gate being satisfied or failed. |
| `status` | `passed`, `failed`, or `skipped`; missing reports stay `pending`. |
| `source` | Reporter label such as `github-actions`, `jenkins`, `local-ci`, or `agent-mcp`. |
| `externalRunUrl` | Optional URL to the external job/check. |
| `commitSha` | Optional commit checked by the external system. Used for staleness. |
| `summary` | Short human-readable result. |
| `payload` | Structured reporter-specific details. |
| `reportedBy` | API token or MCP actor id. |
| `reportedAt` | Server timestamp. |

The report becomes a normal artifact in the run evidence graph. If the
dependent commit, upstream artifact, or gate input changes, the external check
becomes stale and must be reported again or overridden through human review.

The MAIster MCP server exposes only a thin facade over the same operations:
create/list/get/update task, launch run, get run, get readiness, and report a
gate result where the token scope permits. MCP tools never bypass Flow
validation, token scopes, readiness, or artifact recording.

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
`on_reject.goto_step` is recorded but not executed by the runner for linear
`steps[]` flows. In a graph flow (`nodes[]`) it is **superseded** by node
`transitions` + `finish.human.decisions`, which drive the validated
review-driven rework loop (M11a — see
[`system-analytics/flow-graph.md`](system-analytics/flow-graph.md)).

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
| `steps.<id>.output`              | `node_attempts.stdout` (highest attempt), `step_runs.stdout` fallback, truncated to 8 KiB |
| `steps.<id>.vars.<name>`         | `node_attempts.vars` jsonb (highest attempt), `step_runs.vars` fallback |
| `steps.<id>.exitCode`            | `node_attempts.exit_code` (highest attempt), `step_runs.exit_code` fallback |
| `env.<KEY>`                      | filtered process.env (see below)           |

Highest-attempt-wins: when a node has been retried (or reworked, M11a),
`steps.<id>` resolves to the highest-`attempt` `node_attempts` row, falling back
to `step_runs` for legacy runs that predate the ledger
([ADR-023](decisions.md#adr-023-append-only-node_attempts-run-ledger)).

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

In a graph flow (M11a — Designed) the review-driven rework loop is a **node-
pointer move inside `Running`**, not a new run status: a `rework` decision on a
review node sets the node pointer back to the rework target, marks downstream
gates stale, and continues — there is no `HumanWorking` status in M11a (that is
M11b). The full node lifecycle state machine lives in
[`system-analytics/flow-graph.md`](system-analytics/flow-graph.md).

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

## Package contract fields (M10)

Beyond `steps`, a `flow.yaml` may declare optional package-contract fields
(ADR-021): `compat: { engine_min, engine_max }`, and the opaque string lists
`capabilities`, `gates`, `artifacts`, `external_ops`. They are recorded in
`flow_revisions.contract`, digested into `flow_revisions.manifest_digest`, and
shown in the Flow Packages UI. Only `compat` + `schemaVersion` are enforced at
enablement/launch (`web/lib/flows/engine-version.ts`); the lists are opaque
until M11+ gives them runtime meaning. See
[`configuration.md`](configuration.md) and
[`system-analytics/flow-packages.md`](system-analytics/flow-packages.md).

## See also

- `docs/flow-aif-plugin.md` — walkthrough of the bundled `aif` plugin.
- `docs/system-analytics/flow-packages.md` — package lifecycle, trust, revisions.
- `docs/flow-installer.md` — install pipeline + local-source path.
- `docs/supervisor.md` — ACP wire, SSE events, prompt endpoint.
- `docs/getting-started.md` — end-to-end "Launch a run" recipe.
