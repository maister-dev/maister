# Feature M41 - Consensus Flow-Graph Node

## Status

**Designed / frozen SSOT.** This document is the single source of truth for the
M41 `consensus` graph-node implementation until the feature lands. Every
behavioral deviation requires amending this spec before code changes.

- Plan: `.ai-factory/plans/feature-m41-consensus-node.md`
- Branch: `feature/m41-consensus-node`
- Engine floor: `1.9.0`
- ADR: `ADR-109`
- Migration: `0068`
- Primary runtime boundary: `web/lib/flows/graph/runner-graph.ts`

## Value

MAIster can already execute graph nodes, run gates, and delegate governed child
runs through the orchestrator engine. It cannot yet ask several independent
agents to draft the same answer, verify one another against declared material
axes, and produce one durable synthesized answer only when the engine can prove
agreement or a human explicitly resolves disagreement.

M41 adds a first-class `consensus` node. The engine owns fan-out, verification,
tally, escalation, synthesis, artifacts, and recovery. Agents may draft,
verify, and synthesize, but no agent decides that consensus exists.

## Non-goals

- No writable competing-code draft branches in v1. Draft child runs are
  `repo_read` and settle directly to `Done`.
- No majority, weighted vote, quorum, confidence threshold, or synthesizer
  override policy. V1 is unanimous across author-declared `material_axes`.
- No free-form delegation MCP toolset exposed to the consensus node or its
  participants.
- No new public route unless implementation proves an existing route cannot
  express the needed HITL or DTO shape.
- No new `MaisterError` code.
- No new process, port, sidecar, package dependency, or environment variable.
- No screenshots in documentation. Screen behavior is documented in
  `docs/screens/` using the existing screenshot-free template.

## DSL

```yaml
engine_min: "1.9.0"
nodes:
  - id: decide_release_plan
    type: consensus
    prompt: |
      Produce a release plan for the package authoring milestone.
    participants:
      - id: architect
        agent: architecture-reviewer
      - id: implementer
        runner: codex
      - id: qa
        agent: qa-reviewer
    workspace:
      mode: repo_read
    material_axes:
      - scope_matches_milestone
      - migration_order_is_safe
      - human_handoff_is_clear
    rounds:
      mode: iterate
      max: 3
    on_no_consensus: escalate
    synthesizer:
      agent: plan-synthesizer
    output:
      produces:
        - id: consensus_plan
          kind: plan
          current: true
        - id: debate_log
          kind: human_note
          current: true
    transitions:
      on_success: implement
```

## Schema Contract

- `type: consensus` is a sibling of `orchestrator`, not a specialization of
  `ai_coding`, `judge`, or `human`.
- `participants` is a non-empty ordered array with at least 2 entries and at
  most `MAISTER_MAX_ORCHESTRATOR_FANOUT` entries.
- Each participant has a stable `id` and exactly one of `agent` or `runner`.
- Participant refs are re-resolved at launch. Static known-bad refs are
  `CONFIG`; launch-time stale or untrusted refs are `PRECONDITION`.
- `workspace.mode` defaults to `repo_read`. V1 refuses writable participant
  workspaces.
- `material_axes` is a non-empty ordered list of unique author-declared axis
  identifiers.
- `rounds.mode` is `single_pass` or `iterate`; default is `single_pass`.
  `rounds.max` must be a positive bounded integer. `single_pass` behaves as
  `max = 1`.
- `on_no_consensus` is `escalate` in v1.
- `synthesizer` is required, resolves like a participant, and has no vote.
- `output.produces` must contain exactly current `consensus_plan` kind `plan`
  and current `debate_log` kind `human_note`.
- A manifest declaring a consensus node must set `engine_min >= "1.9.0"`.

## Runtime Model

### Entities

- **Consensus node** - graph node recorded in `node_attempts.node_type` as
  `consensus`.
- **Draft child run** - governed `run_kind = "agent"` row with
  `parent_run_id`, `root_run_id`, `delegation_snapshot`, `runner_snapshot`, and
  `launch_mode` set by server code.
- **Consensus round** - one fan-out plus one cross-verification pass over the
  settled draft set.
- **Consensus verdict** - one verifier's parsed judgment of one target draft for
  one round.
- **Consensus ledger row** - durable verdict row keyed by
  `(node_attempt_id, round, verifier_key, target_key)`.
- **Consensus HITL** - `human` HITL kind with a consensus schema discriminator
  and an allow-list of server-derived decisions.

### Lifecycle

1. Validate config, resolve participants/synthesizer, and create a consensus
   node attempt.
2. Fan out N governed `repo_read` draft child runs. Agent participants resolve
   through the effective agent definition. Runner-only participants resolve
   directly through the platform runner chain and do not require agent catalog
   rows.
3. Park the parent flow run as `WaitingOnChildren`, checkpoint the parent
   session, and release the scheduler slot.
4. Resume only when all draft children for the current round have settled.
   Failed draft children count as settled unavailable evidence unless parent
   cancellation or abandon policy is active.
5. Recollect settled drafts from durable run rows and artifacts; never respawn
   a draft that already settled for the same round.
6. Run in-node cross-verification sessions. Verifier `i` audits target
   `(i + 1) mod N`. These sessions are not `runs` rows, but they consume the
   same numeric host-capacity ceiling as `MAISTER_MAX_CONCURRENT_AGENTS`.
7. Parse verdict output fail-closed and persist each verifier-target row
   idempotently.
8. Tally deterministically:
   - all verifier verdicts `agree` and all material axes `true`: synthesize.
   - not reached and `rounds.mode = iterate` with rounds remaining: re-fan
     drafts with union disagreements injected as critique context.
   - not reached and single-pass/exhausted: create consensus HITL and set the
     run to `NeedsInput`.
9. After consensus or human resolution, run the synthesizer and durably write
   `consensus_plan` and `debate_log` before the generic `output.produces`
   backstop checks and before success transition.
10. Follow `transitions.on_success`.

## Structured Verdict Contract

Verifier output is untrusted ACP text. The parser uses the shared tolerant JSON
object extraction primitive used by AI verdict parsing, validates shape, and
fails closed.

```json
{
  "verdict": "agree",
  "axes": {
    "scope_matches_milestone": true
  },
  "disagreements": [
    {
      "axis": "scope_matches_milestone",
      "claim": "The plan includes writable code drafts.",
      "counter_evidence": "The node is declared read-only in v1."
    }
  ],
  "confidence": 0.72
}
```

- `verdict` must be `agree` or `disagree`.
- Every declared material axis must be present as a boolean.
- Unknown axes, missing axes, invalid disagreement rows, invalid JSON, and
  unparseable output become a parsed failed-closed `disagree` result.
- `confidence` is advisory only and never changes tally.

## HITL Contract

Consensus uses the existing HITL respond route:
`POST /api/runs/{runId}/hitl/{hitlRequestId}/respond`.

The HITL row uses kind `human` with a consensus schema discriminator. The schema
contains server-derived draft choices, artifact references, capped excerpts, the
round number, material-axis disagreement summary, and allowed decisions.

Allowed decisions:

- `pick-draft-N` - select a server-listed draft as the source for synthesis.
- `provide-resolution` - provide trusted human resolution text for synthesis.
- `re-run-round` - re-fan another round when policy permits.
- `abort` - stop the node/run through existing abort/failure semantics.

Response handling must mirror existing form/human recovery:

- Route params identify `runId` and `hitlRequestId`.
- Draft ids, participant ids, output ids, and transition targets come from the
  stored HITL schema, never the response body.
- The route stores the response and never flips `runs.status` directly.
- If delivery is already complete while the run remains `NeedsInput`, the route
  schedules runner re-drive so a duplicate/already-delivered response cannot
  strand the run.
- Free-form resolution text is never logged.

## Persistence

Migration `0068` adds:

- `node_attempts.node_type = "consensus"`.
- artifact kind `plan`.
- `consensus_round_verdicts`, keyed by
  `(node_attempt_id, round, verifier_key, target_key)`.

The verdict ledger stores at minimum:

- node attempt id.
- round number.
- verifier key and target participant key.
- parse status.
- verdict.
- axis booleans.
- disagreements.
- raw-output reference or capped excerpt, not unbounded model text.
- timestamps.

`gate_results` is not reused because it is gate-id oriented and cannot express
round/verifier/target identity without losing the consensus invariant.

## Recovery And Concurrency

- Fan-out writes child runs durably before the parent parks.
- Parking and node-attempt cursor updates are atomic with the status transition
  that makes the parent `WaitingOnChildren`.
- The parked-child resume consumer must be generalized from orchestrator or
  implemented separately. It must re-read parent status under lock, confirm the
  current node is `consensus`, and skip parents whose pointer advanced.
- `WaitingOnChildren` consensus runs do not hold scheduler slots.
- Verification/synthesis capacity tokens are released in `finally`, including
  parse failure, spawn failure, cancellation, and checkpoint failure.
- Crash recovery recollects child runs and verdict ledger rows by round and
  continues from the first incomplete deterministic stage.
- `EXECUTOR_UNAVAILABLE` while re-driving a parked parent cannot advance the
  node to success.
- Cancel/abandon cascades through durable draft children using the existing
  orchestrator run-tree cascade semantics.

## Error Taxonomy

No new `MaisterError` code is added.

| Condition | Code |
| --- | --- |
| Invalid DSL shape, engine floor, missing mandatory outputs, too few/many participants, empty axes, missing synthesizer | `CONFIG` |
| Stale or untrusted participant/synthesizer at launch | `PRECONDITION` |
| Participant, verifier, or synthesizer session cannot be admitted or spawned | `EXECUTOR_UNAVAILABLE` |
| Checkpoint/resume failure | `CHECKPOINT` |
| Racing HITL response, stale parent status, or duplicate terminal transition | `CONFLICT` |

Malformed verifier output is not an exception path. It is persisted as a
failed-closed disagree verdict and then fed into tally.

## UI Surface Contract

Consensus must preserve MAIster's existing dense operational UI. The primary
references are the existing Flow Studio editor, read-only FlowGraphView, run
detail, workbench, and inbox screen docs. The Lazyweb reference pass reinforced
the same local pattern: workflow builders keep a scannable canvas, use a focused
right-side inspector for properties, and render approval decisions as explicit
controls with context.

### Read-only graph view

- Consensus nodes use the shared node visual scheme: icon chip + type tint +
  status chip, not a bespoke card style.
- Node tooltip names the node type, participant count, rounds mode, current
  round, and consensus state when runtime status is available.
- Graph topology and outcome labels include the success path and
  no-consensus/HITL state without raw JSON labels.

### Flow editor and properties

- The toolbar adds one consensus node option using the same icon-button/tooltip
  pattern as the existing node palette.
- Blank consensus node defaults are valid enough to edit without crashing:
  empty prompt, two participant slots, empty axes list requiring fill-in,
  `rounds.mode = single_pass`, `on_no_consensus = escalate`, required outputs
  prefilled.
- The right properties panel owns all consensus fields. It groups them under
  Identity, Behavior, Participants, Verification, Synthesis, Outputs,
  Transitions, and Presentation.
- Property fill-ins use the existing control vocabulary: inputs/textareas for
  text, segmented controls for mode, steppers/number inputs for bounded counts,
  menus for runner/agent refs, and icon buttons with tooltips for add/remove.
- The editor shows validation issues in `EditorValidationSummary`, not as
  persistent instructional banners on the canvas.
- EN/RU message keys are required for every visible label, tooltip, validation
  message, and decision action.

### HITL, inbox, and run detail

- Consensus HITL cards render bounded context: draft names, participant labels,
  material-axis disagreements, artifact refs, capped excerpts, and debate-log
  pointer.
- Decision controls are first-class actions: pick draft, provide resolution,
  rerun round, abort. The default must not be a generic JSON editor.
- Run detail selects the blocked consensus node when the run is `NeedsInput`.
  The selected-node panel shows round, participants, verifier status, tally, and
  links to `consensus_plan` / `debate_log`.
- Workbench Evidence exposes `consensus_plan` kind `plan` and `debate_log` kind
  `human_note` without new nested cards or layout shifts.
- Short mobile and desktop viewports must not clip decision labels, tooltips,
  node cards, or properties controls.

### Screen docs

The applicable screen docs must be updated in the implementation:

- `docs/screens/studio/editor.md` - consensus authoring, node visual language,
  properties fill-ins, tooltips, validation, and acceptance criteria.
- `docs/screens/runs/flow-run.md` - selected consensus node runtime view and
  NeedsInput focus behavior.
- `docs/screens/inbox.md` - consensus HITL card context and decision controls.
- `docs/screens/runs/workbench.md` - `plan` artifact display and evidence links.

Each touched screen doc must preserve the existing template and include the
applicable JTBD, role/capability impact, layout expectations, states, data/API
links, i18n namespaces, and compact acceptance criteria for the consensus
surface.

## Logging Contract

Runtime logs use structured fields. Never interpolate prompt text, draft body
text, verifier output, free-form resolution text, artifact body text, secrets,
or full worktree paths.

Required event families and fields:

- `consensus.fanout.started|completed`: `runId`, `nodeId`, `nodeAttemptId`,
  `round`, `participantCount`, `participantId`, `runnerId`, `childRunId`,
  `workspaceMode`.
- `consensus.parked|resume.started|resume.skipped|resume.completed`:
  `runId`, `nodeId`, `nodeAttemptId`, `round`, `childRunIds`, `parkStatus`,
  `resumeReason`, `currentNodeType`.
- `consensus.verify.started|completed`: `runId`, `nodeId`, `nodeAttemptId`,
  `round`, `verifierId`, `targetParticipantId`, `parseStatus`, `verdict`,
  `capacityTokenReleased`, `durationMs`.
- `consensus.tally.completed`: `runId`, `nodeId`, `nodeAttemptId`, `round`,
  `agreementReached`, `axisCount`, `disagreementCount`, `nextRound`.
- `consensus.hitl.created|responded|redrive_scheduled`: `runId`, `nodeId`,
  `hitlRequestId`, `round`, `decision`, `actorId`.
- `consensus.synth.started|completed`: `runId`, `nodeId`, `nodeAttemptId`,
  `synthesizerId`, `source`, `artifactIds`, `durationMs`.
- `consensus.recovery.completed|cascade.completed`: `runId`, `nodeId`,
  `nodeAttemptId`, `round`, `recoveryStage`, `cascadeReason`, `childRunIds`.

## Expectations

- A manifest declaring `type: consensus` MUST require `engine_min >= "1.9.0"`.
- A consensus node MUST create durable read-only child draft runs before parking
  the parent.
- A consensus parent MUST resume only after every child draft in the current
  round has settled.
- A failed draft child MUST be treated as settled unavailable evidence, not as
  an immediate parent failure.
- Cross-verification MUST be deterministic by participant order and fail-closed
  on malformed verifier output.
- Tally MUST be unanimous over every verifier verdict and every declared
  material axis.
- Human resolution MUST use the existing HITL route with server-derived
  decisions and idempotent re-drive behavior.
- Synthesis MUST run only after unanimous consensus or explicit human
  resolution.
- `consensus_plan` and `debate_log` MUST both be durable and current before the
  node transitions success.
- Cancel, abandon, crash, retry, and resume paths MUST leave no duplicate draft
  runs, duplicate verdict rows, or stranded capacity tokens.
- UI surfaces MUST use the existing graph, properties, HITL, inbox, and
  workbench patterns, with EN/RU parity and no generic JSON-only consensus
  fallback.

## Acceptance Criteria

- AC1 - A valid consensus node compiles and records
  `node_attempts.node_type = "consensus"`.
- AC2 - Invalid participants, axes, outputs, synthesizer, or engine floor fail
  manifest validation with actionable `CONFIG` context.
- AC3 - A happy path with all verifiers agreeing writes one current
  `consensus_plan` artifact and one current `debate_log` artifact, then follows
  `transitions.on_success`.
- AC4 - A malformed verifier output is persisted as failed-closed disagreement
  and drives iterate/escalate policy without losing lifecycle state.
- AC5 - Iterate mode re-fans with union disagreements and stops at
  `rounds.max`.
- AC6 - No-consensus escalation creates a consensus HITL with bounded context
  and the four allowed decisions.
- AC7 - Duplicate/already-delivered consensus HITL responses are idempotent and
  re-drive a stored `NeedsInput` run when needed.
- AC8 - A crashed parent recollects settled drafts and persisted verdict rows
  without respawning or recharging completed work.
- AC9 - A child-settled event wakes a parent parked on a consensus node and
  ignores a parent whose current node is not consensus.
- AC10 - The Flow editor can author a consensus node through the existing
  toolbar and properties panel, with complete EN/RU labels and validation.
- AC11 - The inbox/run HITL UI exposes purpose-built consensus decisions and
  does not fall back to a generic JSON editor.
- AC12 - The applicable `docs/screens/*` docs describe the consensus view,
  tooltips, flow editing, property fill-ins, JTBDs, expectations, and acceptance
  criteria.
- AC13 - `git grep` confirms docs, OpenAPI/AsyncAPI, DB docs, system analytics,
  i18n, read models, and topology surfaces agree with the implemented
  `consensus` node and `plan` artifact kind.

## Contract Trace

- DSL/schema: `web/lib/config.schema.ts`, `web/lib/config.ts`,
  `web/lib/flows/engine-version.ts`, `docs/flow-dsl.md`,
  `docs/configuration.md`.
- Runtime: `web/lib/flows/graph/runner-graph.ts`,
  `web/lib/domain-events/orchestrator-resume.ts` or a generalized child-resume
  consumer, `web/lib/agents/launch.ts`.
- Helpers: `web/lib/flows/graph/consensus/tally.ts`,
  `web/lib/flows/graph/consensus/verdict.ts`,
  `web/lib/flows/graph/consensus/rotation.ts`,
  `web/lib/flows/graph/consensus/ledger.ts`.
- HITL: `web/lib/services/hitl.ts`, `web/lib/flows/hitl-validate.ts`,
  `web/components/board/run-hitl-response.tsx`,
  `web/components/board/hitl-decision-controls.tsx`,
  `web/components/inbox/hitl-card.tsx`.
- UI authoring/read-only graph: `web/lib/flows/editor/node-form.ts`,
  `web/components/flows/flow-graph-editor.tsx`,
  `web/components/flows/node-form/node-side-form.tsx`,
  `web/components/board/flow-graph-view.tsx`,
  `web/lib/flows/graph/topology.ts`, `web/lib/flows/node-visuals.ts`.
- Persistence: `web/lib/db/schema.ts`, `web/lib/db/migrations/0068_*`,
  `docs/database-schema.md`, `docs/db/runs-domain.md`.
- API/docs: `docs/api/web.openapi.yaml`,
  `docs/api/external/operations.openapi.yaml`,
  `docs/api/async/web-runs.asyncapi.yaml`,
  `docs/api/async/outbound-webhooks.asyncapi.yaml`,
  `docs/system-analytics/consensus.md`, `docs/system-analytics/flow-graph.md`,
  `docs/system-analytics/orchestrator.md`, `docs/system-analytics/hitl.md`.
- Screen docs: `docs/screens/studio/editor.md`,
  `docs/screens/runs/flow-run.md`, `docs/screens/inbox.md`,
  `docs/screens/runs/workbench.md`.
