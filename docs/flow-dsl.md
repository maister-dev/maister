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
> inline: the node `settings` block → **Implemented (M11c subset)** (typed
> shape + launch-time enforcement boundary; capability-reference resolution and
> per-session materialization remain **M14 (Designed)**); manual takeover /
> `human_edit` /
> `merge` nodes → **M11b (Designed)**; typed artifact instances
> (`input.requires` / `output.produces`) → **M12**. Decisions:
> [ADR-026](decisions.md#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump),
> [ADR-027](decisions.md#adr-027-append-only-node_attempts-run-ledger),
> [ADR-028](decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped),
> [ADR-029](decisions.md#adr-029-split-m11-into-m11a--m11b--m11c). The node
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
    # settings: Implemented (M11c subset) — typed per-node-type shape, validated
    # at compile time; OPTIONAL. The per-class `enforcement` intent gates launch
    # (strict on a class the build cannot enforce → refusal). M11c resolves NO
    # capability refs and materializes NOTHING — ref resolution + per-session
    # materialization are M14 (Designed).
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
      enforcement:
        restrictions: strict    # strict | instruct (default) | off, per class
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
          visibility: internal
        - id: implementation-diff
          kind: diff
          path: "."
          visibility: shared
          requiredFor: [review]
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
      takeover: checks       # M11b (Implemented): takeover returns to a real
                             # validation node (`checks`) so the gates rerun over
                             # the human's commits — NOT `implement` (would clobber
                             # the human edits), NOT the `human_edit` node TYPE
                             # below (that type is M18-Designed).
    rework:
      allowedTargets: [implement]
      # M11a executes `keep`; rewind-to-node-checkpoint / fresh-attempt are
      # validated + recorded but execution is deferred to M11b.
      workspacePolicies: [keep, rewind-to-node-checkpoint, fresh-attempt]
      maxLoops: 3
      commentsVar: review_comments

  # human_edit node TYPE: M18 (Designed) — not executed in M11a/M11b. M11b models
  # manual takeover as a run-state transition (`HumanWorking`) off the existing
  # `human_review` node, NOT as this node type. See ADR-030 and manual-takeover.md.
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
          requiredFor: [review]
        - id: returned-diff
          kind: diff
          requiredFor: [review]
```

> The `transitions` above reference upstream node ids (`review`, `checks`) that
> are **gate-bearing validation nodes elided from this snippet for brevity** —
> the snippet shows only the review and `human_edit` nodes. A complete graph
> wires `… → checks → … → review`; `transitions.takeover: checks` therefore
> re-enters that validation node so its gates rerun over the human's commits.

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

**Top-level `retry_safe?` (boolean, default `false`).** A per-node opt-in
(also accepted on linear `steps[]`) that gates operator crash-recovery
re-dispatch of a **session-less** node (`cli`/`check`/`judge`/`guard`/`human`).
A `Crashed` run whose recover target is session-less is redispatch-recoverable
only when its config declares `retry_safe: true` — re-running a session-less
node repeats its side effects (accepted-risk). `ai_coding` nodes ignore
`retry_safe` (they recover via `--resume`, never a fresh re-run). See
[ADR-034](decisions.md#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)
and [`system-analytics/reconciliation-gc.md`](system-analytics/reconciliation-gc.md).

**Node `settings` — Implemented (M11c subset).** The `settings` block is parsed
into a typed, per-node-type discriminated shape and validated at compile time
(the M11a opaque passthrough and the `SETTINGS_NOT_ENFORCED_WARN` no longer
exist). It is **OPTIONAL on every node type** — a settings-less node validates
and runs unchanged, and absence of `settings` NEVER triggers a refusal. **M11c
performs no materialization**: it neither resolves capability references nor
writes any per-session settings file (those are M14, below).

Node-specific settings are intentionally first-class product configuration:
AI-coding nodes constrain executors, agent definitions, MCP servers, tools,
skills, thinking effort, permissions, workspace access, and limits. Human nodes
constrain project roles, allowed decisions, manual takeover, further tracks,
SLA/staleness hints, and return requirements. CLI/check/judge nodes constrain
commands, environment policy, artifact inputs/outputs, timeout, and failure
classification.

**Per-class `enforcement` intent (M11c).** Each of the six capability classes —
`mcps`, `tools`, `skills`, `restrictions`, `permissionMode`, `workspaceAccess` —
carries an optional `enforcement` intent of `strict | instruct | off`, default
`instruct`, declared in `settings.enforcement`. At launch, MAIster evaluates each
declared class against the static `ENFORCEABILITY_BY_AGENT` table for the
resolved agent. If an `ai_coding`/`judge` node declares `enforcement: strict` on
a class MAIster cannot strictly enforce for that agent, the launch is **refused**
before any worktree/run/workspace side-effect — `MaisterError("CONFIG")` when no
agent can enforce the class at all, or `MaisterError("EXECUTOR_UNAVAILABLE")`
when some agent can but the resolved one cannot. **No new error code** is
introduced ([ADR-008](decisions.md#adr-008-typed-error-taxonomy-maistererror)
closed union). The full truth table, the frozen `ENFORCEABILITY_BY_AGENT` seed
(all-`instructed` in M11c), and the refusal allow-list are specified in
[`system-analytics/flow-settings.md`](system-analytics/flow-settings.md);
rationale is in [ADR-032](decisions.md#adr-032-settings-enforcement-refusal-boundary).

**M14 (Designed, Phase 0 spec) — registry-resolved refs and native materialization.**
Every `settings.mcps[]`, `settings.skills[]`, `settings.restrictions[]`,
`settings.settingsProfile`, and `settings.tools.{claude|codex}[]` entry is
validated at project-load and run-launch time against the project capability
registry (`capability_records`). An unknown ref, or a ref present in the
registry but not supported for the selected executor agent, is rejected with
`MaisterError("CONFIG")` before any worktree/run side-effect (see ADR-040 and
[`configuration.md`](configuration.md) §cross-reference-checks). This validation
is the "carve-b" boundary — a stub existed in M11c but resolution was deferred.

The resolved profile is agent-aware: the same abstract tool id (e.g.
`tools: [shell]`) maps to different concrete Claude or Codex tool names via
`web/lib/capabilities/agent-map.ts`. M14 also flips `ENFORCEABILITY_BY_AGENT`
cells `instructed → enforced` as spike-verified materialization lands (the
contract only ever tightens, never loosens — see ADR-041).

For long-living ACP sessions (`slash-in-existing` mode), every AI node that
reuses the session MUST share the same resolved `profileDigest`. On digest
mismatch, the runner either starts a fresh session at a Flow-declared session
boundary, or rejects with `MaisterError("CONFIG")` ("capability profile changes
mid-session require a declared session boundary"). This is enforced by comparing
`node_attempts.materialization_plan.profileDigest` across the session scope
(see ADR-040, AC #5 and #9).

The M14 runner enforces the resolved profile at the AI session scope. For a
per-node session, the profile is effectively node-scoped: before the node
starts, the runner materializes only that node's allowed skills, MCP config,
adapter `settings.json` or equivalent settings file, environment profile, and
tool restrictions, then removes/restores them when the node ends. For a
long-living ACP session, skills, MCPs, settings, and tool restrictions are
session-wide: every AI node inside that session must share the same resolved
capability profile. If a later node needs different capabilities, the Flow must
declare a new session boundary unless the adapter supports explicit safe profile
swap. None of this materialization runs in M11c.

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

**Manual takeover — M11b local-handoff subset (Implemented).** Manual takeover is
a LOCAL worktree handoff ([ADR-030](decisions.md#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status)),
NOT a `human_edit` node type. It is a run-state transition off the existing
`human_review` node: the reviewer's `takeover` decision drives
`NeedsInput → HumanWorking` (a real `runs.status`), MAIster exposes the EXISTING
worktree path + run branch (`workspaces.branch` — no new branch/target/PR/push/
remote), the reviewer commits in place on the same host, and a UI **Return**
records the returned commit set (`git log <base>..<branch>`) + raw diff
(`git diff <base>..<branch>`) on the takeover `node_attempts` row, marks the
`transitions.takeover` validation node (`checks`) + its downstream STALE (M11a
`markDownstreamStale`), and resumes the runner so those gates rerun and a fresh
`human_review` gate is produced. The run-detail **timeline** (the runs domain)
renders owner, elapsed time, branch, returned commits, returned diff, stale-vs-
current gates, and rerun results in one view. See
[`system-analytics/manual-takeover.md`](system-analytics/manual-takeover.md) and
[`system-analytics/runs.md`](system-analytics/runs.md#m11b-manual-takeover-status-humanworking-implemented).

Two halves remain deferred:

- **Typed `commit_set` / `diff` artifact instances — M12 (Designed).** M11b
  records raw `git log`/`git diff` TEXT in the ledger only; the typed artifact
  instances + evidence-graph explorer land with the M12 artifact graph (below).
- **`human_edit` / `merge` node TYPES — M18 (Designed).** The first-class
  `human_edit` node type (shown in the example above) and the `merge` node type +
  conflict-handoff promotion are M18; M11b implements neither.

## Gate execution (M11a — Implemented)

> **Status (M11a).** Gate execution is **Implemented** in M11a (per
> [ADR-028](decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)).
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

**Staleness.** When a reviewer reworks (or returns a manual takeover — M11b,
Implemented), `markDownstreamStale` flips dependent `gate_results`
`passed → stale`; a stale blocking gate must rerun before the node can finish
again.

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

**`output.produces[]`.** A node's `output` block declares the typed artifacts it
produces. Each entry:

| field | type | meaning |
| ----- | ---- | ------- |
| `id` | string, **unique within the manifest** | Stable artifact id other nodes' `input.requires` and `artifact_required` gates reference. |
| `kind` | enum (closed catalog) | One of `diff`, `log`, `test_report`, `lint_report`, `ai_judgment`, `human_note`, `commit_set`, `checkpoint`, `preview`, `generic_file`. |
| `schema?` | string | Optional schema id/ref describing the payload shape. |
| `path?` | string | Optional run-relative / worktree path to the payload. |
| `ref?` | string | Optional git ref (used by `commit_set` / `diff`). |
| `visibility?` | `internal` \| `shared` | Who may read the artifact. **Declared/recorded in M12; access enforcement is M14.** |
| `retention?` | `run` \| `ephemeral` | Lifetime policy. **Declared/recorded in M12; enforcement is M14.** |
| `requiredFor?` | (`"review"` \| `"merge"`)[] | Phases this artifact blocks if missing/stale. It is a field ON a `produces[]` entry, so the artifact is always produced by the declaring node. |

**`input.requires[]`.** A node's `input` block declares the typed artifacts it
consumes. Each entry is **either** a bare artifact id (string) — referencing an
`output.produces[].id` — **or** an object `{ artifact, kind }` that additionally
pins the expected `kind`. An unknown ref or `kind` mismatch is a manifest
violation (`CONFIG`). A required input that is missing or `stale` at runtime
fails the node BEFORE its action (`PRECONDITION`).

**`artifact_required` gate.** This gate references artifact ids through its
`inputArtifacts` field and **passes ONLY when every referenced artifact instance
is `current`** (not missing, `stale`, `superseded`, `failed`, or `skipped`).

- `mode: blocking` — an unsatisfied gate is a **blocking failure that stops the
  node finishing**. Placed in a `human_review` node's `pre_finish`, this is the
  **review-refusal mechanism**: review cannot complete until the required
  evidence is `current`.
- `mode: advisory` — an unsatisfied gate is **recorded non-blocking**; the node
  continues.

**Manifest validation (`CONFIG`).** At load/validate time the manifest is
rejected (`CONFIG`) for: a duplicate `output.produces[].id` within the manifest;
an `input.requires` ref (bare id or `{ artifact, kind }`) to an unknown artifact
id; an `input.requires` object whose declared `kind` mismatches the producing
artifact's `kind`; an unsupported artifact `kind`; an invalid `path`/`ref`; or an
`artifact_required` gate whose `inputArtifacts` reference unknown artifact ids.

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

> **Re-scoped (ADR-028).** M11a annexed gate *execution* — the kinds, status
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
([ADR-027](decisions.md#adr-027-append-only-node_attempts-run-ledger)).

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

The checkpoint path adds `NeedsInput -> NeedsInputIdle -> Running` via
`acp_session_id` resume; the supervisor checkpoint endpoint and web resume
driver are implemented.

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
