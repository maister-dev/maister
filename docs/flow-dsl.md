# Flow DSL Reference

This document describes the Flow DSL used by `flow.yaml` manifests inside
Flow plugins, plus how the runner interprets it.

Package install, trust, enablement, upgrade, rollback, and removal are tracked
separately from the DSL itself. See
[`system-analytics/flow-packages.md`](system-analytics/flow-packages.md) for
the planned M10 package lifecycle.

Authored Flows use the same `flow.yaml` DSL. The platform `/flows` editor may
store invalid draft YAML while an author is working, but publish/export/install
requires the manifest and graph validation described in this document. Authoring
does not run `setup.sh`, scripts, agents, or hooks.

## Step types

A Flow is an ordered list of steps. Each step has an `id` (unique within
the flow) and a `type` chosen from:

| type    | what it does                                                               |
| ------- | -------------------------------------------------------------------------- |
| `cli`   | shells out to `bash -c <command>` with `cwd = worktreePath`                |
| `agent` | drives an ACP session through `claude-agent-acp` / `codex-acp`             |
| `guard` | observational gate — writes metrics, never blocks today                    |
| `human` | suspends the run, writes `needs-input.json`, inserts a `hitl_requests` row |

## Flow graph node lifecycle (M11a — Designed)

> **Status (M11a).** Flow graph v1 — the `nodes[]` manifest, node-lifecycle
> compile, the append-only `node_attempts` ledger, the review-driven rework
> loop, and gate execution — is **Implemented** in M11a, shipped on the
> `feature/m11a-flow-graph-lifecycle` branch. Sub-parts owned by later
> milestones are tagged
> inline: the node `settings` block → **Implemented (M11c subset)** (typed
> shape + launch-time enforcement boundary; capability-reference resolution and
> per-session materialization are **M14 (Implemented)**); manual takeover /
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
    # materialization are M14 (Implemented).
    settings:
      runner_type: acp
      runner: claude-code
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
        restrictions: strict # strict | instruct (default) | off, per class
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
      takeover:
        checks # M11b (Implemented): takeover returns to a real
        # validation node (`checks`) so the gates rerun over
        # the human's commits — NOT `implement` (would clobber
        # the human edits), NOT the `human_edit` node TYPE
        # below (that type is M18-Designed).
    rework:
      allowedTargets: [implement]
      # (M30 — Implemented, ADR-076) all three execute against the node's
      # pre-attempt checkpoint: keep (no-op), rewind-to-node-checkpoint,
      # fresh-attempt. Pre-M30 only keep ran.
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

| section       | purpose                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `input`       | Declares required artifacts, prior outputs, human answers, and environment.                    |
| `settings`    | Holds type-specific capability, role, policy, timeout, cost, and restriction controls.         |
| `action`      | Performs the node work: AI coding, CLI, check, judge, human review, human edit, or merge.      |
| `output`      | Declares typed artifacts the node produces for later inputs, gates, review, and merge.         |
| `pre_finish`  | Runs Flow-declared gates before the node can finish.                                           |
| `finish`      | Captures final gates such as human review, branch return, or merge acceptance.                 |
| `transitions` | Maps declared outcomes to declared node ids.                                                   |
| `rework`      | Defines allowed targets, workspace policy, loop limits, and where comments become later input. |

**Top-level `retry_safe?` (boolean, default `false`).** A per-node opt-in
(also accepted on linear `steps[]`) that gates operator crash-recovery
re-dispatch of a **session-less** node (`cli`/`check`/`judge`/`guard`/`human`/`form`).
A `Crashed` run whose recover target is session-less is redispatch-recoverable
only when its config declares `retry_safe: true` — re-running a session-less
node repeats its side effects (accepted-risk). `ai_coding` nodes ignore
`retry_safe` (they recover via `session/resume`, never a fresh re-run). See
[ADR-034](decisions.md#adr-034-crashed-run-recovery-semantics-hybrid---resume--re-dispatch-durable-marker-first-cap-re-admission)
and [`system-analytics/reconciliation-gc.md`](system-analytics/reconciliation-gc.md).

**Node `settings` — Implemented (M11c subset).** The `settings` block is parsed
into a typed, per-node-type discriminated shape and validated at compile time
(the M11a opaque passthrough and the `SETTINGS_NOT_ENFORCED_WARN` no longer
exist). It is **OPTIONAL on every node type except `form`** — a settings-less
node validates and runs unchanged, and absence of `settings` NEVER triggers a
refusal. The sole exception is the `form` (intake) node, whose `settings` is
**required** because its `settings.form_schema` (the JSON form doc it collects
against) is mandatory. **M11c
performs no materialization**: it neither resolves capability references nor
writes any per-session settings file (those are M14, below).

**`form` (intake) node — Implemented (T4).** A `form` node is the one node type
with **no `action`**: it collects values against its required
`settings.form_schema` (a JSON form doc), pauses the run as a `kind:"form"` HITL
(`runFormCollect`), and on response finishes via `transitions.success` with the
submitted object exposed as the node's output vars (`node_attempts.vars`, read
downstream as `{{ steps.<id>.vars.<field> }}`). Unlike a `human` review node it
carries no decision. See [`system-analytics/hitl.md`](system-analytics/hitl.md).

Node-specific settings are intentionally first-class product configuration:
AI-coding nodes constrain ACP runner targets, agent definitions, MCP servers, tools,
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

**M14 (Implemented) — registry-resolved refs and native materialization.**
Every `settings.mcps[]`, `settings.skills[]`, `settings.restrictions[]`,
`settings.settingsProfile`, and `settings.tools.{claude|codex}[]` entry is
validated at project-load and run-launch time against the project capability
registry (`capability_records`). An unknown ref, or a ref present in the
registry but not supported for the selected executor agent, is rejected with
`MaisterError("CONFIG")` before any worktree/run side-effect (see ADR-041 and
[`configuration.md`](configuration.md) §cross-reference-checks). This validation
is the "carve-b" boundary — a stub existed in M11c but resolution was deferred.

The resolved profile is agent-aware: the same abstract tool id (e.g.
`tools: [shell]`) maps to different concrete Claude or Codex tool names via
`web/lib/capabilities/agent-map.ts`. M14 also flips `ENFORCEABILITY_BY_AGENT`
cells `instructed → enforced` as spike-verified materialization lands (the
contract only ever tightens, never loosens — see ADR-042).

**M27 (Implemented) — node `settings.mcps` required vs additional distinction.**
`settings.mcps` is extended to discriminate REQUIRED from ADDITIONAL MCP refs.
A bare `string[]` remains back-compat (treated as `additional`). The explicit form:

```yaml
settings:
  mcps:
    required: [github]      # launch refused if cannot resolve+materialize
    additional: [filesystem] # non-fatal if absent; session augmented if present
```

`judge` settings carry the same extension. The `required` / `additional` split is
validated by `config.schema.ts:mcpCapabilitySchema`. A REQUIRED MCP that cannot
resolve+materialize at launch throws `MaisterError("CONFIG")` (unknown ref) or
`MaisterError("EXECUTOR_UNAVAILABLE")` (agent does not support it); an ADDITIONAL
MCP that is absent is silently non-fatal. For long-living `slash-in-existing`
sessions the resolved MCP profile is shared across nodes via the existing
`profileDigest` consistency (see `runner-agent.ts`). See
[`configuration.md`](configuration.md) §MCP capability template and
[`system-analytics/flow-studio.md`](system-analytics/flow-studio.md).

**M27 (Implemented) — flow-package top-level `mcps?` declaration.**
A `flow.yaml` may declare `mcps?` at the top level to list the capability ref-ids
the flow package requires as MCP capabilities. This is validated by the
`validateGraphManifest` hard-gate: an unknown ref (not present in any
`capability_records` for the project) → `CONFIG` (422). Removing an `mcps?`
entry from the flow package and republishing clears the requirement (SET/CLEAR
symmetry). Re-adding it restores the requirement. Example:

```yaml
schemaVersion: 1
name: bugfix
mcps:
  - github          # capability ref-id; validated at publish/install time
  - filesystem
steps:
  - id: implement
    ...
```

See `config.schema.ts:flowYamlV1Schema` (`mcps?` field) and
[`system-analytics/flow-studio.md`](system-analytics/flow-studio.md).

For long-living ACP sessions (`slash-in-existing` mode), every AI node that
reuses the session MUST share the same resolved `profileDigest`. On digest
mismatch, the runner either starts a fresh session at a Flow-declared session
boundary, or rejects with `MaisterError("CONFIG")` ("capability profile changes
mid-session require a declared session boundary"). This is enforced by comparing
`node_attempts.materialization_plan.profileDigest` across the session scope
(see ADR-041, AC #5 and #9).

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

**`rework.commentsVar` composed payload — (Implemented — ADR-072).** The value
injected as the top-level `{{ <commentsVar> }}` template var on the rework
target's next attempt becomes a *composed* payload: the reviewer's free-text
`comments` summary first, then the run's OPEN line-anchored review-comment
threads serialized as deterministic markdown (file/line-ordered, each root's
exact `line_content` snapshot quoted, replies included; resolved threads never
serialize). **Backward-compatible by construction:** with zero open threads
the injected value is byte-identical to the raw summary (and nothing is
injected when no summary was submitted) — no flow.yaml grammar change, no
engine version bump; `{{ review_comments }}` keeps working as-is. Format and
guard rules:
[`system-analytics/review-comments.md`](system-analytics/review-comments.md).

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

## Node `retry_policy` (M30 — Implemented)

**(M30 — Implemented, [ADR-080](decisions.md#adr-080-node-level-retry-policy).)** An
optional `retry_policy` on `ai_coding` / `cli` nodes auto-retries the node on
transient infrastructure failures without bouncing the run to a human.

```yaml
nodes:
  - id: implement
    type: ai_coding
    retry_policy:
      attempts: 3                     # integer >= 1 (total attempts incl. the first)
      on_errors: [SPAWN, EXECUTOR_UNAVAILABLE, ACP_PROTOCOL, CHECKPOINT]
      workspace: rewind-to-node-checkpoint
```

- **`attempts`** — integer `>= 1`; total attempts including the first. `< 1` →
  `MaisterError("CONFIG")` at manifest load.
- **`on_errors`** — the `MaisterError.code`s that trigger an auto-retry, validated
  at manifest load against the **retryable allow-list**
  `{ SPAWN, EXECUTOR_UNAVAILABLE, CHECKPOINT, ACP_PROTOCOL }`. Any other code (e.g.
  `PRECONDITION`, `CONFIG`, `CONFLICT`) or an unknown value → `CONFIG`. It is an
  allow-list, not a deny-list: only infrastructure codes retry; logic/precondition
  failures still stop the run.
- **`workspace`** — the workspace policy applied (via the ADR-079 checkpoint engine)
  BEFORE each retry attempt; `rewind-to-node-checkpoint` resets to the pre-attempt
  checkpoint.

On a failure whose `code ∈ on_errors` with attempts remaining, the engine applies
`workspace`, then appends a **fresh-session** attempt
(`node_attempts.auto_retry = true`), respecting the global concurrency cap and
never bypassing gates. Exhausting `attempts` ends in normal node failure plus a
distinct exhaustion signal. `retry_policy` is valid ONLY on `ai_coding` / `cli`
(zod refine, else `CONFIG`).

**Engine floor.** Declaring `retry_policy` (or the
[ADR-081](decisions.md#adr-081-rework-session-policy-with-resume-by-default)
`session_policy` / `defaults`) requires `compat.engine_min >= 1.4.0`, else
`CONFIG`; `MAISTER_ENGINE_VERSION` bumps `1.3.0 → 1.4.0` (see
[`configuration.md`](configuration.md) §M30 engine bump). Flows using none of
these keys stay valid at any `engine_min`.

## Node `agent` binding (M34 — Implemented)

**(M34 — Implemented, [ADR-089](decisions.md#adr-089-platform-agent-catalog-with-per-agent-runner-and-a-five-source-trigger-model).)**
An optional `agent: <agent-id>` on `ai_coding` node settings binds the node to
a catalog agent — `agents/<stem>.md` inside a flow package, referenced by its
package-qualified id `<flowRefId>:<stem>` (ADR-089 rework; no bare-stem
same-package sugar in v1) — instead of relying solely on the inline prompt.

```yaml
nodes:
  - id: review
    type: ai_coding
    action:
      prompt: "Review the diff for {{ task.title }}"
    settings:
      agent: aif:code-reviewer        # package-qualified catalog agent id
```

- **Resolution** — the binding resolves through the HOST RUN project's pinned
  revision of the providing package behind the flow-launch enablement+trust
  gates (RD4); the effective definition's `triggers` must include `flow`,
  else `MaisterError("CONFIG")`.
- **`mode: session` agents** — the catalog profile substitutes the inline
  prompt: the agent's `.md` body becomes the system prompt, the node's
  `action.prompt` is appended as the task block, and the agent's
  `capability_profile` merges with node settings (node settings win on
  collision).
- **`mode: subagent` agents** — the `.md` is materialized into the run
  worktree's `.claude/agents/<stem>.md` (the file STEM — a `:` in the
  filename is hostile to the convention) so the Claude session can
  self-delegate. Requires a runner whose `capability_agent` is `claude`;
  any other resolved runner → `MaisterError("EXECUTOR_UNAVAILABLE")` before
  spawn (the partial-runner-independence boundary, ADR-089).
- **Runner** — flow-bound nodes keep the existing six-tier flow resolution
  chain; the agent's own `runner` binding participates only in standalone
  agent runs.
- The binding executes inside the flow run's session — no separate agent-run
  row is created in this stage.

**Engine floor.** Declaring `settings.agent` requires
`compat.engine_min >= 1.5.0`, else `CONFIG`; `MAISTER_ENGINE_VERSION` bumps
`1.4.0 → 1.5.0`. Flows without the key stay valid at any `engine_min`.

## Node `orchestrator` (M36 — Implemented)

**(M36 — Implemented, [ADR-095](decisions.md#adr-095-orchestrator-engine--supervisory-node-governed-run-tree-delegation-toolset-success-gated-task-dag-idle-checkpoint-waitresume).)**
`type: orchestrator` is a long-lived **SUPERVISORY** node, not a run-to-terminal
step. The flow **parks** on it: the node spawns and coordinates **child Runs**,
idle-checkpoints while blocked (run status `WaitingOnChildren`, which holds **no**
scheduler slot), and transitions downstream — to the normal judge / readiness /
promote path — only when the agent declares the goal met. Governance is
structural: every delegation hop routes through this one node, so policy, gates,
HITL, and audit attach there.

```yaml
nodes:
  - id: orchestrate
    type: orchestrator
    action:
      prompt: "Decompose {{ task.prompt }} into child tasks, dispatch them, and merge the results."
    settings:
      runner: claude-code              # inherits the ai_coding capability shape
      thinkingEffort: high
      mcps: [github]
      delegation:
        max_fanout: 16                  # optional; defaults to MAISTER_MAX_ORCHESTRATOR_FANOUT
        max_depth: 3                    # optional; defaults to MAISTER_ORCHESTRATOR_MAX_DEPTH
    transitions:
      success: review
```

- **`action.prompt`** — the coordinator instruction, templated like any
  agent-executed node.
- **Capability settings** — an `orchestrator` node **inherits the `ai_coding`
  capability settings shape** (`runner`, `model`, `thinkingEffort`, `mcps`,
  `tools`, `skills`, `permissionMode`, `limits`, `restrictions`, `enforcement`,
  …); the same registry resolution (M14) and per-class `enforcement` intent
  apply.
- **`delegation` sub-block** (optional) — `max_fanout` (the per-plan task cap for
  `run_plan`) and `max_depth` (the run-tree recursion bound). When omitted they
  default to env `MAISTER_MAX_ORCHESTRATOR_FANOUT` (`16`) and
  `MAISTER_ORCHESTRATOR_MAX_DEPTH` (`3`). An over-fanout or over-depth request is
  refused pre-transaction with `MaisterError("CONFIG")`; no partial run-tree is
  created.

**Delegation semantics (brief; full contract in
[ADR-095](decisions.md#adr-095-orchestrator-engine--supervisory-node-governed-run-tree-delegation-toolset-success-gated-task-dag-idle-checkpoint-waitresume)
+ [`system-analytics/orchestrator.md`](system-analytics/orchestrator.md)).** The
orchestrator coordinates through a **delegation toolset** exposed over the MAIster
MCP facade (a per-launch ephemeral `agent:<id>` token scoped `runs:delegate`,
materialized into the orchestrator session's ACP `mcpServers` for
`orchestrator` nodes only, revoked on terminal):

- `run_delegate` — spawn one child as `as-task` (a child task + run, board card via
  `parent_of`) or `as-run` (a child run only, `runs.parent_run_id`, workbench
  subtree, **no** board card).
- `run_plan` — write a **success-gated** task DAG (N child tasks wired by the
  `requires` relation kind, which releases a dependent **only** on `Done` —
  `Failed`/`Abandoned` keeps it blocked and wakes the orchestrator) in one
  transaction after pre-tx cycle / depth / fanout validation.
- `run_collect` — read each child's terminal status, `{{ steps.<id>.output }}`
  stdout var, produced-artifact manifest, and base→run diff ref (never the child
  worktree directly — the reviewer-isolation contract).
- `run_cancel` — cancel a child run.

Children are **catalog-resolved governed Runs** (M34 effective definition through
the project's enabled + trusted catalog, ADR-089/090; never runtime-authored) —
each is a real Run with a worktree, gates, promotion, the concurrency cap, and a
launch-time snapshot. They form a run-tree via `runs.parent_run_id` /
`runs.root_run_id`. As with `ai_coding`, **all capability classes resolve as
`instructed`** (no `enforced` cell) at this milestone.

**Engine floor.** A flow declaring an `orchestrator` node requires
`compat.engine_min >= 1.6.0`, else the manifest is refused at load with
`MaisterError("CONFIG")`; `MAISTER_ENGINE_VERSION` bumps `1.5.0 → 1.6.0` (the
orchestrator node debuts at `1.6.0`, the new engine floor). Flows without an
`orchestrator` node stay valid at any `engine_min`.

> **Persistent-swarm Layer 2 is Implemented (ADR-096).** Addressable long-lived
> child sessions (`runs.persistent`/`addressable_key`, re-messaged via
> `run_message`), star-routed messaging through the orchestrator, shared-vs-own
> worktree modes (`workspace_mode`), and per-agent read-only enforcement ship in
> M36 (**Implemented — see
> [ADR-096](decisions.md#adr-096-persistent-swarm-layer-2--addressable-sessions-star-routed-messaging-worktree-modes-per-agent-read-only)**).
> The one carve-out remains **path-scoped** write enforcement ("tester edits only
> tests"): a `strict` path-scope declaration is still refused (`CONFIG`) until the
> deferred policy layer lands — maister enforces read-only-vs-full only, so
> path-scope ships `instructed`-only **(Phase 2)**.

## Rework `session_policy` (M30 — Implemented)

**(M30 — Implemented, [ADR-081](decisions.md#adr-081-rework-session-policy-with-resume-by-default).)**
`session_policy` controls whether a rework re-uses the prior attempt's agent
session (keeping the critique context) or starts fresh.

```yaml
defaults:
  session_policy: resume            # flow-level default for all rework

nodes:
  - id: implement
    type: ai_coding
    session_policy: resume          # node-level override
    rework:
      allowedTargets: [implement]
      session_policy: new_session   # per-transition override (highest priority)
```

- **Values** — `resume | new_session`.
- **Resolution (highest wins)** — rework-transition `rework.session_policy` → node
  `session_policy` → flow `defaults.session_policy` → engine default **`resume`** (a
  deliberate flip from the pre-M30 implicit `new_session`).
- **`resume`** resumes the prior attempt's `acp_session_id` via the
  [ADR-006](decisions.md#adr-006-hybrid-hitl-keep-alive--checkpointresume) idle
  checkpoint / ACP `session/resume` path (the ~$0.28 respawn buys back the critique
  context — surfaced in the UI). An idle/checkpointed prior session still resumes.
- **Fallback** — if the prior session is gone or unresumable, the engine falls back
  to `new_session` and sets `node_attempts.session_fallback = true`. The effective
  policy is snapshotted into `node_attempts.session_policy`.
- **DD11 interplay** — when a rework resumes the SAME session, the rework prompt MUST
  lift any gate-chat read-only restriction
  ([ADR-078](decisions.md#adr-078-gate-chat-at-hitl-pauses-with-three-layer-workspace-neutrality)),
  else the agent may refuse legitimate edits.
- **Manual-takeover** ([ADR-030](decisions.md#adr-030-manual-takeover-as-a-local-worktree-handoff-humanworking-status))
  is unaffected (no live session to resume); slash-in-existing dispatch is unchanged.

Engine floor `>= 1.4.0` (shared with `retry_policy`; see above).

## Flow `requirements` (ADR-091 — Implemented)

A flow may declare host/runtime preconditions that are probed at launch, BEFORE
any worktree or ACP session is created. This is how a CLI-driven package (e.g.
`openspec`, which shells out to the `openspec` binary from `cli` nodes) declares
the external tool it needs:

```yaml
requirements:
  - name: "openspec CLI present"
    probe: "command -v openspec"
    hint: "run the os-init flow, or: npm i -g @fission-ai/openspec@1.4.1"
  - name: "node >= 20"
    probe: "node -e \"process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)\""
```

- Each `probe` runs with `bash -c` in the **project repo** (10s timeout). A
  non-zero exit or a timeout marks the requirement unmet.
- If any are unmet, the launch is refused with a single `PRECONDITION` listing
  every failure and its `hint` — no worktree, session, or token spend.
- **Check-only.** MAIster never auto-installs; remediation is the package's
  `setup.sh` or an init-style flow's job (gated by `exec_trust`). The `hint`
  points the operator at it.
- A probe is general — it covers a binary (`command -v`), a version
  (`node -e ...`), network reachability, or project state (`test -d openspec`).
- **Per-flow**, not package-wide: an installer flow that provisions the
  dependency omits the requirement it satisfies, avoiding a chicken-and-egg
  block.
- Additive + launch-checked (the runner/engine never read it at compile) →
  **no `compat.engine_min` floor**.

Fields: `name` (required), `probe` (required shell command), `hint` (optional
remediation string). Probes run with runner authority, like `command_check`
gates — only trusted flows reach this path. See
[ADR-091](decisions.md#adr-091-flow-requirements-launch-precondition).

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

| kind                | purpose                                                                                                               | M11a                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command_check`     | Runs formatter, test, lint, typecheck, build, or custom command via `bash -c`; exit 0 = `passed`, else `failed`.      | **Executes**                                                                                                                                                          |
| `ai_judgment`       | Produces a structured model verdict over the diff/logs/requirements via an agent session (defaults to `new-session`). | **Executes**                                                                                                                                                          |
| `human_review`      | Captures approve/rework decisions through the review HITL.                                                            | **Executes**                                                                                                                                                          |
| `skill_check`       | Runs an internal slash command (e.g. `/aif-review`) via an agent session.                                             | **Executes (best-effort)** — no capability scoping until M14                                                                                                          |
| `artifact_required` | Verifies required evidence exists and is current.                                                                     | **Stubbed** → `skipped` + WARN + `TODO(M12)` (needs M12 artifact instances)                                                                                           |
| `external_check`    | Waits for CI / another system to report through the operations API.                                                   | **Executes (M16)** → report ingestion via `POST /api/v1/ext/runs/{runId}/gates/{gateId}/report` flips `pending → passed\|failed` and records a `test_report` artifact |

### `gates[].external` block (M16 — Implemented)

`external_check` gates accept an optional additive `external` block. Old manifests without it remain valid; **no engine-version bump** is required.

```yaml
- id: ci
  kind: external_check
  mode: blocking
  external:
    description: "GitHub Actions full test suite on the run branch." # optional
    staleOnNewCommit: true # optional; default true
```

| field              | type             | default | meaning                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`      | `string` (min 1) | (none)  | Human-readable label surfaced in the `GET /api/v1/ext/runs/{runId}/readiness` response so CI consumers know what each gate expects.                                                                                                                                        |
| `staleOnNewCommit` | `boolean`        | `true`  | When `true` (or absent), a new gate report that carries a different `commitSha` than the current `passed` report supersedes the prior result and marks the gate `stale`. Set to `false` to opt out of commit-based staleness for gates whose result is commit-independent. |

The block is meaningful only for `kind: external_check`. Placing it on any other gate kind is a manifest validation error (`CONFIG`).

### `gates[].must_touch` / `gates[].must_not_touch` mutation assertions (M29 — Implemented)

> **Status (M29 — Implemented).** Deterministic post-condition assertions over the
> run worktree's git diff, valid ONLY on `kind: artifact_required` gates.
> Rationale, range semantics, and the `mutation_report` shape are normative in
> [ADR-074](decisions.md#adr-074-artifact-post-conditions--deterministic-mutation-sensor-on-artifact_required-gates)
> — not restated here.

```yaml
- id: impl-mutation
  kind: artifact_required
  mode: blocking
  inputArtifacts: [implementation-diff]
  must_touch: ["src/**", "web/lib/**"] # ≥1 glob; fail when the node's diff touches NONE
  must_not_touch: restrictions # v1: the only legal value
  output:
    id: impl-mutation-report
    kind: mutation_report # declared output kind MUST be mutation_report
```

| field            | type                     | meaning                                                                                                                                                                                                                       |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `must_touch?`    | `string[]` (min 1 glob)  | The gate FAILS when the **node-scoped** diff range (since this node's first attempt started; cumulative fallback when no start capture exists) touches NONE of the globs. Matched with `picomatch`, `dot: true`, repo-relative POSIX paths. |
| `must_not_touch?`| `"restrictions"` literal | The gate FAILS when the **cumulative** branch diff (merge-base vs main → HEAD) touches any `paths` entry of the node's resolved M14 restriction set. Restrictions without `paths` are reported `unmatchable`, never failed on. |

Both assertions evaluate under the gate's existing `mode`
(`blocking | advisory`). Declaring either field on any other gate kind is a
manifest validation error (`CONFIG`). When assertions are configured the gate
ALWAYS records a `mutation_report` artifact (pass AND fail; see
[`system-analytics/artifacts.md`](system-analytics/artifacts.md)). When git is
unavailable at gate time a blocking gate FAILS (a sensor that cannot sense must
not pass); an advisory gate records `evaluated: false`.

**Restriction `paths` (capability config, M29 — Implemented).** A `restriction`
capability gains an optional machine-readable subset:

```yaml
kind: restriction
id: no-engine-edits
content: "Do not modify the flow engine or generated migrations."
paths: # optional; the subset the mutation sensor can check
  - "web/lib/flows/graph/**"
  - "web/lib/db/migrations/**"
```

The same record feeds M14 instruction materialization AND this sensor (single
source of truth; ADR-041 strict enforcement reads the same field later).
`paths` is capability config, not graph-manifest surface — additive, no engine
floor.

**Engine gate — no bump.** `MAISTER_ENGINE_VERSION` stays `1.3.0`. The existing
`compat.engine_min >= 1.3.0` manifest check (introduced for `output.result`,
M26) is **widened**: a manifest declaring `must_touch`/`must_not_touch` OR a
gate `output.kind: mutation_report` is rejected with `MaisterError("CONFIG")`
unless `compat.engine_min >= 1.3.0`. Flows using neither feature stay valid at
any `engine_min`.

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

| field          | type                                   | meaning                                                                                                                                        |
| -------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | string, **unique within the manifest** | Stable artifact id other nodes' `input.requires` and `artifact_required` gates reference.                                                      |
| `kind`         | enum (closed catalog)                  | One of `diff`, `log`, `test_report`, `lint_report`, `ai_judgment`, `human_note`, `commit_set`, `checkpoint`, `preview`, `generic_file`.        |
| `schema?`      | string                                 | Optional schema id/ref describing the payload shape.                                                                                           |
| `path?`        | string                                 | Optional run-relative / worktree path to the payload.                                                                                          |
| `ref?`         | string                                 | Optional git ref (used by `commit_set` / `diff`).                                                                                              |
| `visibility?`  | `internal` \| `shared`                 | Who may read the artifact. **Declared/recorded in M12; access enforcement is M14.**                                                            |
| `retention?`   | `run` \| `ephemeral`                   | Lifetime policy. **Declared/recorded in M12; enforcement is M14.**                                                                             |
| `requiredFor?` | (`"review"` \| `"merge"`)[]            | Phases this artifact blocks if missing/stale. It is a field ON a `produces[]` entry, so the artifact is always produced by the declaring node. |

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

## M26: structured node output channel (`output.result`) (P1 Implemented)

> **Status (M26 — P1 Implemented; the run-context file (P7) stays Designed).** Opt-in schema-validated structured output for
> every graph node type, folded into the existing `node_attempts.vars` channel.
> Decision: [ADR-063](decisions.md#adr-063-structured-node-output-channel-p1--run-context-file-p7);
> frozen SSOT:
> `.ai-factory/specs/feature-m26-structured-output-run-context.md`. The
> post-action validate seam, the run-context file, and the per-node-type
> transport are drawn in
> [`system-analytics/flow-graph.md`](system-analytics/flow-graph.md).

Today only `human`/HITL nodes write a structured result into
`node_attempts.vars`; `ai_coding`/`cli`/`check`/`judge` nodes leave `vars: {}`.
M26 lets any graph node emit a **schema-validated** structured result into that
same `vars` channel, declared **opt-in** per node. A node without `output.result`
behaves byte-identically to today (no transport provisioning, no parsing).

**`output.result`.** A new field on a node's `output` block, **sibling of the M12
`output.produces[]`**:

```yaml
output:
  result:
    schema: ./schemas/plan-output.json # path, resolved against the flow install dir
    required: false # default false
  produces: # M12, unchanged
    - id: plan-summary
      kind: generic_file
```

| field       | type    | meaning                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`    | string  | A **path** (not inline) resolved against the flow install dir with the same escape-guard as `form_schema`; the resolved file is validated as a `formSchemaSchema` document. M26 **adds** a nested `object` type to that grammar (flat today: `string \| number \| boolean \| enum \| array`) — net-new work, still no `ajv` and no new dep. |
| `required?` | boolean | Default `false`. When `true`, an absent payload fails the attempt; when `false`, an absent payload leaves `vars: {}` and the node proceeds.                                                                                                                                                                                                 |

**Per-node-type output transport.** Transport is chosen by the node's execution
mechanism, not declared:

| Node types                            | Transport                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_coding`, `judge` (agent-executed) | The agent ends its response with a **single** sentinel-tagged fenced block ` ```json maister:output … ``` `; the runner extracts the **last** such block from the **1 MiB-capped** `result.stdout` capture (a block pushed past the cap is treated as **absent** → `CONFIG` if `required`). The agent writes **no file** (it cannot write outside its worktree `cwd`). |
| `cli`, `check` (cli-executed)         | The runner injects `MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json` into the command env; the command writes its JSON there and the runner reads that file. The filename is **per-attempt**, so a non-writing rework attempt never inherits a prior attempt's file.                                                                                       |

`human` nodes are unchanged — their `vars` come from the HITL input artifact.

**Engine gate.** Any flow using `output.result` on **any** node MUST declare
`compat.engine_min: 1.3.0`. `MAISTER_ENGINE_VERSION` bumps `1.2.0 → 1.3.0`; a
manifest that declares `output.result` without `compat.engine_min >= 1.3.0` is
rejected with `MaisterError("CONFIG")` (mirrors the `ARTIFACT_ENGINE_MIN = 1.2.0`
gate). A flow that does **not** declare `output.result` stays valid at any
`engine_min` (back-compat). The post-action validate seam, the size cap
(`MAISTER_NODE_OUTPUT_MAX_BYTES`), and the run-context file are specified in
[`system-analytics/flow-graph.md`](system-analytics/flow-graph.md); env wiring is
in [`configuration.md`](configuration.md). Rationale lives in
[ADR-063](decisions.md#adr-063-structured-node-output-channel-p1--run-context-file-p7)
— not restated here.

## Planned M15: readiness policy and verdict calibration

> **Re-scoped (ADR-028).** M11a annexed gate _execution_ — the kinds, status
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
a `pending` gate — is delivered with the M16 operations API (see the M16
operations-API section below); M15 owns the readiness policy that consumes it.

## External operations API and MCP facade (M16 — Implemented)

Flow plugins may declare `external_check` gates when evidence must arrive from
outside the runner: CI, a local script, a repository-hosted check, or another
tool. The runner creates the pending gate result and exposes a report contract
through the project-scoped operations API. External systems do not mutate run
state directly; they attach evidence to the gate.

An external check report `POST /api/v1/ext/runs/{runId}/gates/{gateId}/report`
carries this body (the `gateId` is in the URL, not the body):

| field            | purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `status`         | `passed` or `failed`. A gate with no report stays `pending`.        |
| `externalRunUrl` | Optional URL to the external job/check.                             |
| `commitSha`      | Optional commit checked by the external system. Used for staleness. |
| `summary`        | Short human-readable result.                                        |
| `payload`        | Structured reporter-specific details.                               |

The server records `reporterTokenId` and `reportedAt` in the gate verdict from
the authenticated token — they are not client-supplied.

The report becomes a normal artifact in the run evidence graph. If the
dependent commit, upstream artifact, or gate input changes, the external check
becomes stale and must be reported again or overridden through human review.

The MAIster MCP server exposes a thin facade over the operations API: 10 tools
(create/list/get/update task; launch/get run; get readiness; report a gate
result; list and respond to HITL requests) where the token is authorized. The
two HITL tools — `hitl_list` and `hitl_respond` — are backed by the
`GET /api/v1/ext/runs/{runId}/hitl` (`hitl:read`) and
`POST /api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond` (`hitl:respond`)
ext routes (Implemented — M17). MCP tools never bypass Flow validation,
token authorization, readiness, or artifact recording.

### `cli` step

```yaml
- id: lint
  type: cli
  command: "pnpm lint"
  pre_guards: [] # optional, observational only
  post_guards: []
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
  mode: new-session # OR slash-in-existing
  prompt: "/aif-plan {{ task.prompt }}"
  pre_guards: []
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
  cost: 10000 # tokens
  time: 300 # seconds
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
  criticality: high # optional — low | medium | high | critical
  on_reject:
    goto_step: implement
    comments_var: review_comments
```

Inserts a `hitl_requests` row of `kind: "human"`, transitions the run to
`NeedsInput`, and returns. The response route writes
`input-<stepId>.json` after the HITL row is claimed, then schedules
`runFlow`; the runner owns the `NeedsInput -> Running` transition.

**`criticality`** (optional, `low | medium | high | critical`) — flow-author-declared
severity. Stored on `hitl_requests.criticality` at row creation; write-once.
Controls inbox sort order and badge display. Additive — no engine bump; absent
means no severity declared.

**Responder `confidence`** — a response-time self-report (`number 0..1`)
supplied by the human when answering. Captured from the response body; stored
as `hitl_requests.human_confidence` and echoed in the `response` jsonb.
`confidence` is NOT a flow-declared field — flow authors cannot pre-declare it;
it is submitted with the answer, not specified in `flow.yaml`.

**`on_reject.goto_step` + `comments_var`** (Implemented — M17): for linear
`steps[]` flows, submitting a reject response reparks the runner to the named
step via a single atomic `currentStepId` CAS, bounded by a re-entry guard
(`maxLoops`, default 5). Comments travel via a dedicated
`rework-comments-<gotoStepId>.json` artifact — they are **never** written to
`input-<gotoStepId>.json`, which would falsely auto-satisfy a re-reached
human/form step. Completion sentinels (`input-<stepId>.json`) for every step in
the window `[gotoTarget..humanStep]` are deleted before the repark commit so
re-reached human/form steps re-prompt instead of auto-satisfying from a prior
pass. Exceeding `maxLoops` terminates the run with `MaisterError("CONFIG")`
(parity with the graph runner's `rework.maxLoops` breach).
In a graph flow (`nodes[]`) `on_reject` is **superseded** by node
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

| path                     | source                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `task.id`                | `tasks.id`                                                                                      |
| `task.title`             | `tasks.title`                                                                                   |
| `task.prompt`            | `tasks.prompt`                                                                                  |
| `task.attemptNumber`     | `tasks.attempt_number`                                                                          |
| `run.id`                 | `runs.id`                                                                                       |
| `run.attemptNumber`      | mirrors `task.attemptNumber` until run-level attempts land                                      |
| `run.projectSlug`        | `projects.slug`                                                                                 |
| `runner.id`              | Resolved platform ACP runner id                                                                 |
| `runner.capabilityAgent` | Adapter-registry identity, e.g. `claude` or `codex`                                             |
| `runner.model`           | Snapshotted runner model label                                                                  |
| `runner.providerKind`    | Snapshotted provider kind                                                                       |
| `runner.resolutionTier`  | Launch override, step target, project Flow, platform Flow, project default, or platform default |
| `steps.<id>.output`      | `node_attempts.stdout` (highest attempt), `step_runs.stdout` fallback, truncated to 8 KiB       |
| `steps.<id>.vars.<name>` | `node_attempts.vars` jsonb (highest attempt), `step_runs.vars` fallback                         |
| `steps.<id>.exitCode`    | `node_attempts.exit_code` (highest attempt), `step_runs.exit_code` fallback                     |
| `env.<KEY>`              | filtered process.env (see below)                                                                |

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

## Authored package files

An authored Flow package is portable when `flow.yaml` is accompanied by typed
text artifacts that can be committed to git and imported into another MAIster
installation. The DSL remains the execution contract; package files carry the
supporting artifacts.

Supported authored package artifact kinds:

| Kind               | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `skill`            | Agent skill instructions shipped with the Flow package.     |
| `rule`             | Project or Flow-specific rule text.                         |
| `script`           | CLI/helper script shipped with the package.                 |
| `agent_definition` | Adapter or agent profile material.                          |
| `schema`           | JSON schema such as HITL form schemas.                      |
| `template`         | Text templates used by scripts or agents.                   |
| `readme`           | Human package documentation.                                |
| `setup`            | Setup hook content; executed only by M10 trust-gated setup. |
| `asset`            | Unclassified portable text files retained during import.    |

Before publish/export, package file paths must be safe relative text paths with
no duplicate normalized path and no file-vs-directory collisions. Package file
content must be valid UTF-8 text. Authored package validation also re-runs
manifest schema checks, graph checks, and engine compatibility checks. Project
reference checks run on project-context install, load, and launch paths that
provide role/capability registries.

## See also

- `docs/flow-aif-plugin.md` — walkthrough of the bundled `aif` plugin.
- `docs/system-analytics/flow-packages.md` — package lifecycle, trust, revisions.
- `docs/flow-installer.md` — install pipeline + local-source path.
- `docs/supervisor.md` — ACP wire, SSE events, prompt endpoint.
- `docs/getting-started.md` — end-to-end "Launch a run" recipe.
