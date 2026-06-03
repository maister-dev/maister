# Flow graph domain

> **Status: Implemented (M11a).** Everything in this file is the M11a Flow graph
> v1 execution model, shipped on the `feature/m11a-flow-graph-lifecycle` branch.
> Sub-parts owned by
> later milestones are tagged inline: manual takeover / `human_edit` → **M11b**;
> node `settings` enforcement → **M11c**; typed artifact instances + the
> `artifact_required` gate → **M12**; `external_check` ingestion → **M16**;
> promotion-gating readiness policy → **M15**. Decisions:
> [ADR-026](../decisions.md#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump),
> [ADR-027](../decisions.md#adr-027-append-only-node_attempts-run-ledger),
> [ADR-028](../decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped),
> [ADR-029](../decisions.md#adr-029-split-m11-into-m11a--m11b--m11c).

## Purpose

The **flow graph** domain is M11a's execution-model foundation: it replaces the
strictly linear `for (const step of steps)` walker with a validated **node
graph**, an append-only **`node_attempts`** ledger, **gate execution**, and a
**review-driven rework loop**. Its boundary is the *runtime* of a single run's
traversal — how a node enters, acts, gates, finishes, and transitions, and how a
reviewer's `rework` decision jumps the pointer back and re-stales downstream
work. Package install/trust/enablement is [`flows.md`](flows.md) /
[`flow-packages.md`](flow-packages.md); the run status machine and
keep-alive/checkpoint are [`runs.md`](runs.md); the human-ask protocol is
[`hitl.md`](hitl.md); promotion readiness is M15/M18. Linear `steps[]` flows stay
valid by compiling to single-action nodes, so this domain governs **all** runs.

## Domain entities

- **Node** — a typed unit of work in a graph manifest (`nodes[]`):
  `ai_coding | cli | check | judge | human`. Carries `input.requires?`,
  `output.produces?` (typed artifact decls, **M12**), a type-specific `action`,
  `pre_finish.gates?`, `finish` (auto or `human`), `transitions`, and `rework?`.
- **FlowGraph** — the normalized in-memory graph produced by `compileManifest`:
  nodes + adjacency + entry node. **Both** `steps[]` (compiled to a linear chain)
  and `nodes[]` produce one.
- **Node attempt** — `node_attempts` row; one immutable record per execution of a
  node. `attempt` auto-increments per `(run_id, node_id)`. See ERD
  [`../db/runs-domain.md`](../db/runs-domain.md).
- **Gate** — a `pre_finish` readiness check on a node:
  `command_check | skill_check | ai_judgment | artifact_required | external_check
  | human_review`, with `mode: blocking | advisory`.
- **Gate result** — `gate_results` row; one per gate execution, holding the
  structured verdict and lifecycle status. FK to the producing `node_attempts`
  row.
- **Decision** — a declared human outcome on a `finish.human` node (e.g.
  `approve`, `rework`); maps through `transitions` to a target node id.
- **Workspace policy** — declared rework worktree treatment: `keep` (M11a),
  `rewind-to-node-checkpoint` / `fresh-attempt` (validated + recorded, execution
  **M11b**).
- **Rework config** — `rework.{ allowedTargets[], workspacePolicies[], maxLoops,
  commentsVar }` on a node; bounds and routes the loop.

## State machine — node attempt (execution axis)

A node attempt is one immutable ledger row. PascalCase, extending the
`step_runs` vocabulary (see [Status vocabularies](#status-vocabularies-dual-casing--intentional)).

```mermaid
stateDiagram-v2
    [*] --> Pending: appendNodeAttempt<br/>(attempt = nextAttemptFor(run,node))
    Pending --> Running: action starts
    Running --> NeedsInput: human finish or<br/>agent permission/form ask
    NeedsInput --> Running: operator responds<br/>(runner-owned resume)
    Running --> Succeeded: action + blocking gates pass
    Running --> Failed: action error, blocking gate fails<br/>(no rework), or maxLoops exhausted
    Succeeded --> Stale: markDownstreamStale<br/>(downstream of a rework jump)
    NeedsInput --> Reworked: review node, rework decision<br/>(pointer moves to target)
    Reworked --> [*]: a NEW attempt opens on the target node
    Stale --> [*]: a NEW attempt re-runs this node
    Succeeded --> [*]
    Failed --> [*]
```

## State machine — gate result (verdict axis)

A gate result is lowercase — the M15 gate-verdict vocabulary
([ADR-028](../decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped)).

```mermaid
stateDiagram-v2
    [*] --> pending: createGateResult
    pending --> running: dispatch by kind
    running --> passed: command exit 0 / verdict ok
    running --> failed: non-zero exit / unparseable verdict
    running --> skipped: artifact_required (TODO M12)
    pending --> passed: external_check report (POST .../gates/{gateId}/report)
    pending --> failed: external_check report (POST .../gates/{gateId}/report)
    passed --> stale: markDownstreamStale on rework
    failed --> stale: markDownstreamStale on rework
    stale --> running: re-run on next node attempt
    passed --> overridden: declared human_review override<br/>(original verdict retained)
    failed --> overridden: declared human_review override<br/>(original verdict retained)
    passed --> [*]
    overridden --> [*]
```

### Status vocabularies (dual-casing — intentional)

The two ledgers use **different casing on purpose** — they model distinct
domains (node lifecycle vs. gate verdict), and the casing keeps them
un-confusable in code and queries:

| Ledger | Casing | Values |
| ------ | ------ | ------ |
| `node_attempts.status` | **PascalCase** | `Pending \| Running \| Succeeded \| Failed \| NeedsInput \| Reworked \| Stale` |
| `gate_results.status` | **lowercase** | `pending \| running \| passed \| failed \| stale \| skipped \| overridden` |

`node_attempts.status` **extends** the existing `step_runs.status` vocabulary
(`Pending | Running | Succeeded | Failed | Skipped | NeedsInput`): it **adds**
`Reworked` and `Stale`, and **omits** `Skipped` (a *node* is never skipped — only
a *gate* is, via `gate_results.status = 'skipped'`).

**Legacy `step_runs` → `node_attempts` mapping** (templating
highest-attempt-wins union, [ADR-027](../decisions.md#adr-027-append-only-node_attempts-run-ledger)):
the five overlapping values map **identically** (`Pending→Pending`,
`Running→Running`, `Succeeded→Succeeded`, `Failed→Failed`,
`NeedsInput→NeedsInput`). `step_runs.Skipped` has no `node_attempts` counterpart;
`node_attempts.Reworked`/`Stale` have no `step_runs` counterpart. Because the
overlap is value-identical, the templating union needs no value remapping — it
reads the highest-`attempt` `node_attempts` row for `steps.<id>` and falls back
to the `step_runs` row only when no `node_attempts` exist (legacy runs).

## Process flows

### Graph traversal + finish + transition

```mermaid
flowchart TD
    Entry([entry / resume node]) --> Append[appendNodeAttempt<br/>attempt = nextAttemptFor]
    Append --> Act[run action<br/>cli / agent / check / judge / human]
    Act --> Gates[run pre_finish.gates in order]
    Gates --> Block{blocking gate failed?}
    Block -- yes, rework target exists --> Stale[markDownstreamStale<br/>jump to rework target]
    Block -- yes, no rework --> Fail[node Failed -> run Failed]
    Block -- no --> Finish{finish}
    Finish -- auto --> Pick[evaluate transitions]
    Finish -- human --> Hitl[emit review HITL<br/>run NeedsInput]
    Hitl --> Decision[operator decision<br/>validated vs allow-list]
    Decision -- approve --> Pick
    Decision -- rework --> Stale
    Stale --> NextAttempt[attempt N+1 on target<br/>inject commentsVar]
    NextAttempt --> Act
    Pick --> More{transition target?}
    More -- node id --> Append
    More -- terminal --> Done([run Review / Done])
```

### Review-driven rework loop (criterion #3)

The migrated `aif` flow runs `plan → implement → checks → judge → review`. A
`rework` decision at `review` re-stales `checks`/`judge` and re-runs them before
the run can reach a fresh `review`.

```mermaid
sequenceDiagram
    participant RG as Graph runner
    participant DB as Postgres
    participant W as Respond route
    actor U as Reviewer

    Note over RG: review node finishes human -> emit HITL
    RG->>DB: hitl_requests {kind=human, schema.allowedDecisions/transitions/reworkTargets/workspacePolicies}
    RG->>DB: runs.status = NeedsInput
    U->>W: POST /api/runs/{runId}/hitl/{hitlRequestId}/respond<br/>response = {decision: rework, comments, workspacePolicy: keep}
    W->>DB: validate decision/target/policy vs row allow-list (server-state)
    alt invalid / undeclared decision
        W-->>U: 422 (no artifact write, no mutation)
    end
    W->>DB: claim row, persist decision/workspace_policy/rework_target
    W-->>RG: schedule runFlow (runner owns NeedsInput -> Running)
    RG->>DB: review node_attempts.status = Reworked
    RG->>DB: markDownstreamStale(review): checks/judge gate_results passed -> stale
    RG->>DB: implement node_attempts attempt N+1, commentsVar injected
    RG->>RG: re-run implement -> checks -> judge (stale gates rerun)
    RG->>DB: fresh review HITL (run NeedsInput)
    U->>W: respond {decision: approve}
    W-->>RG: schedule runFlow
    RG->>DB: follow transitions.approve -> run Review
```

### Gate dispatch by kind

```mermaid
flowchart TD
    G([gate]) --> Row[createGateResult: running]
    Row --> K{kind?}
    K -- command_check --> CC[bash -c command<br/>exit 0 = passed, else failed]
    K -- ai_judgment --> AI[agent session new-session<br/>parse structured verdict]
    K -- skill_check --> SK[slash command via agent<br/>best-effort, TODO M14 scoping]
    K -- human_review --> HR[emit review HITL]
    K -- artifact_required --> AR[skipped + WARN + TODO M12]
    K -- external_check --> EC[pending; flipped by external report endpoint]
    CC --> Mode{mode?}
    AI --> Mode
    SK --> Mode
    Mode -- blocking + failed --> Abort[abort node finish]
    Mode -- advisory --> Cont[record verdict, continue]
```

### `steps[]` → nodes compile (back-compat)

```mermaid
flowchart LR
    S1[step 1] --> N1[node 1<br/>single action]
    S2[step 2] --> N2[node 2]
    S3[step N] --> N3[node N]
    N1 -->|transitions.success| N2
    N2 -->|transitions.success| N3
    N3 -->|terminal| End([Review])
```

A `steps[]` step compiles to a single-action node with
`transitions.success → next` and **no rework**; the legacy
`on_reject.goto_step` stays recorded-but-unexecuted for linear flows. Linear
flows write `node_attempts` and behave identically to the pre-M11a runner.

## Expectations

- A graph manifest declares **exactly one** of `steps` or `nodes`; both-present
  and neither-present are refused with `MaisterError("CONFIG")`.
- A graph flow (`nodes[]`) MUST declare `compat.engine_min >= 1.1.0`; otherwise
  enablement/launch refuses it with `CONFIG`.
- `node_attempts` is **append-only**: rework and retries never mutate a prior
  row; `attempt` auto-increments per `(run_id, node_id)` under
  `UNIQUE (run_id, node_id, attempt)`.
- Templating `steps.<id>.output`/`.vars`/`.exitCode` resolves the
  **highest-`attempt`** `node_attempts` row, falling back to `step_runs` only for
  legacy runs with no `node_attempts`.
- Rework is a **node-pointer move within `runs.status = 'Running'`** — never a
  new run status; there is no `HumanWorking` in M11a (that is M11b).
- `runs.current_step_id` carries the **node id** (≡ step id for compiled-linear
  nodes); the existing fail-closed resume check (unknown id in the pinned
  manifest → `Crashed` + `CONFIG`) applies to the compiled graph.
- A `blocking` gate failure aborts the node finish (run → `Failed` unless a
  rework target exists); an `advisory` gate records its verdict and the node
  continues.
- On a rework jump, `markDownstreamStale` flips dependent `gate_results`
  `passed → stale` and stale blocking gates MUST re-run before the node finishes
  again.
- A human override sets `gate_results.status = 'overridden'` and **never deletes**
  the original failed/stale verdict (override-without-erasure).
- A review `decision`/`workspacePolicy`/`reworkTarget` is validated against the
  manifest-derived allow-list stored on the `hitl_requests` row at creation time
  (server-state); an undeclared decision is refused **before** any artifact write
  or state mutation.
- `rework.maxLoops` bounds the loop (plus a hard const ceiling); exhausting it
  ends the run `Failed` with a clear error — never an unbounded cycle.
- M11a `gate_results` **feed but do not gate promotion**; refusing a merge on an
  unsatisfied required gate is the M15/M18 readiness policy, not M11a.

## Edge cases

- **Unknown node id** in `transitions` / `rework.allowedTargets` / `staleFrom` /
  `input.requires` → `CONFIG` at `loadFlowManifest`.
- **Duplicate node id or gate id** → `CONFIG`.
- **Unknown gate kind** → `CONFIG`.
- **Cycle without `rework.maxLoops`** (graph cycle detection) → `CONFIG`.
- **Unsupported workspace policy** → `CONFIG`.
- **Human `decisions` targeting an undeclared transition** → `CONFIG` at load.
- **Both / neither of `steps`/`nodes`** → `CONFIG`.
- **Graph flow without `compat.engine_min >= 1.1.0`** → `CONFIG`.
- **Invalid / undeclared review decision at respond time** → 422 with no artifact
  write and no state mutation (validated against the row's server-state
  allow-list). No new `MaisterError` code.
- **`maxLoops` exhausted** → run `Failed` with a clear error.
- **Unparseable `ai_judgment` verdict** → `gate_results.status = 'failed'` with
  raw prose kept as evidence — **not** a thrown domain code
  ([ADR-008](../decisions.md#adr-008-typed-error-taxonomy-maistererror) closed
  union).
- **`artifact_required` gate** → `skipped` + WARN + `TODO(M12)` (no artifact
  instances until M12). **`external_check` gate** → starts `pending`; an external
  runner flips it via `POST /api/v1/ext/runs/{runId}/gates/{gateId}/report`, which
  drives the gate `pending → passed|failed`, records a `test_report` artifact, and
  gates review through `assertEvidenceReady` (M16).
- **Untrusted revision** → launch is refused by the M10 trust precondition
  ([ADR-021](../decisions.md#adr-021-flow-package-lifecycle-multi-revision-trust-and-compatibility))
  **before** any gate command/agent runs — no gate side-effect occurs.
- **Legacy pre-M11a `NeedsInput` run** (has `step_runs`, no `node_attempts`) →
  graph runner seeds the resume entry from the latest `step_runs` row for
  `current_step_id`; resumes without fail-closed/restart.
- **Node `settings` block present** → preserved as opaque passthrough (never
  silently stripped), `SETTINGS_NOT_ENFORCED_WARN` fires once; enforcement is
  M11c.

## Linked artifacts

- ADRs:
  [ADR-026 Graph manifest](../decisions.md#adr-026-flow-graph-manifest-v1-nodes--engine-version-bump),
  [ADR-027 node_attempts ledger](../decisions.md#adr-027-append-only-node_attempts-run-ledger),
  [ADR-028 Gate execution](../decisions.md#adr-028-full-featured-gate-execution-in-m11a-m15-re-scoped),
  [ADR-029 M11 split](../decisions.md#adr-029-split-m11-into-m11a--m11b--m11c).
- ERD: [`../db/runs-domain.md`](../db/runs-domain.md),
  narrative [`../database-schema.md`](../database-schema.md).
- DSL: [`../flow-dsl.md`](../flow-dsl.md) §Flow graph node lifecycle, §Gate
  execution.
- Config: [`../configuration.md`](../configuration.md) §Package contract +
  compatibility (engine bump).
- API: [`../api/web.openapi.yaml`](../api/web.openapi.yaml) (`respond` review
  decision).
- Related: [`runs.md`](runs.md), [`hitl.md`](hitl.md), [`flows.md`](flows.md).
- Source (Implemented): `web/lib/config.schema.ts` (node/gate schema),
  `web/lib/config.ts` (`loadFlowManifest`),
  `web/lib/flows/graph/compile.ts`, `web/lib/flows/graph/runner-graph.ts`,
  `web/lib/flows/graph/ledger.ts`, `web/lib/flows/graph/gate-store.ts`,
  `web/lib/flows/graph/gates-exec.ts`, `web/lib/db/schema.ts`
  (`node_attempts`, `gate_results`).
```
