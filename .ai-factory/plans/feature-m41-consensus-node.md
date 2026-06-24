# Implementation Plan: M41 Consensus Flow-Graph Node

Branch: `feature/m41-consensus-node`
Plan id: `feature-m41-consensus-node`
Plan date: 2026-06-24
Base observed: `main` at `3488a417`
Engine floor target: `1.9.0`
Reserved ADR: `ADR-109`
Reserved migration: `0068`

## Settings

- Testing: yes. Use RED -> GREEN -> refactor for the pure parser/tally/schema
  work, then integration-first coverage for lifecycle behavior.
- Documentation: yes. Complete the SSOT spec and analytics/design docs before
  implementation code.
- Logging: verbose. Runtime logs must use structured fields, never interpolated
  dynamic values in message strings.
- Branch setup: use `feature/m41-consensus-node` because
  `feature/fusion-consensus` already exists and is unrelated scratch-run work.
- Scope: first-class `consensus` graph node only. Do not implement writable
  competing-code drafts, majority/quorum policies, or free-form MCP delegation
  tools.

## Roadmap Linkage

- Milestone: M41, immediately after the guardrail/hook engine line.
- Engine version: bump `web/lib/flows/engine-version.ts` from `1.8.0` to
  `1.9.0`.
- M39 is reserved by the Studio package-authoring stream and owns ADR-105 to
  ADR-107. Guardrail/hook design already reserved ADR-108 and migration 0066.
- Current migration journal reaches 0067, so consensus reserves 0068.
- `feature/fusion-consensus` is not the implementation branch for this feature;
  observed diff only touches scratch-run launch tests/service code.

## Ground Truth Checked

- Read root `CLAUDE.md`, `web/CLAUDE.md`, `AGENTS.md`,
  `.ai-factory/DESCRIPTION.md`, `.ai-factory/ARCHITECTURE.md`,
  `.ai-factory/ROADMAP.md`, and `.ai-factory/skill-context/aif-plan/SKILL.md`.
- Flow graph schema lives in `web/lib/config.schema.ts`.
- Graph manifest validation and engine floors live in `web/lib/config.ts`.
- Graph compilation lives in `web/lib/flows/graph/compile.ts`.
- Graph runtime lives primarily in `web/lib/flows/graph/runner-graph.ts`.
- Existing tolerant AI verdict parsing lives in
  `web/lib/flows/graph/gates-exec.ts`.
- Delegated agent run internals live in `web/lib/agents/launch.ts`.
- HITL response handling lives in `web/lib/services/hitl.ts`; reusable
  human/review response validation lives in `web/lib/flows/hitl-validate.ts`.
- `WaitingOnChildren` resume is currently orchestrator-specific in
  `web/lib/domain-events/orchestrator-resume.ts` and must be generalized or
  given a consensus-specific consumer before consensus child drafts can wake
  the parent flow.
- Flow graph topology/read-model labels live in
  `web/lib/flows/graph/topology.ts`, run/HITL queries, inbox labels, and
  observatory labels.
- Flow graph authoring UI lives in `web/lib/flows/editor/node-form.ts`,
  `web/components/flows/flow-graph-editor.tsx`,
  `web/components/flows/node-form/node-side-form.tsx`, and `web/messages`.
- HITL response UI lives in `web/components/board/run-hitl-response.tsx`,
  `web/components/board/hitl-decision-controls.tsx`, inbox cards, and shared
  HITL labels.
- DB enum types and run tree columns live in `web/lib/db/schema.ts`.
- Current docs contracts include `docs/flow-dsl.md`,
  `docs/configuration.md`, `docs/database-schema.md`,
  `docs/db/runs-domain.md`, `docs/system-analytics/flow-graph.md`, and
  `docs/system-analytics/orchestrator.md`.

## Locked Product Decisions

- Add `consensus` as a first-class graph node type, sibling to
  `orchestrator`.
- The engine owns the consensus protocol and tally. No agent, orchestrator
  preset, synthesizer, or judge can decide that consensus exists.
- The node is both producer and self-gate. It produces exactly one synthesized
  answer artifact, and only after consensus or explicit human resolution.
- Drafts are governed `repo_read` child runs in the orchestrator run tree.
  They reuse M37 delegation internals through server-side consensus driver
  calls. No free-form delegation MCP toolset is exposed to the node agent.
- Cross-verification uses in-node ad-hoc ACP sessions and reuses the
  `ai_judgment` gate spawn plus tolerant parser pattern. Cross-verification
  sessions are not child runs.
- Consensus rule v1 is unanimous over author-declared `material_axes`.
  Majority, weighted votes, quorum, and synthesizer override are out of scope.
- `on_no_consensus` v1 is `escalate`. The engine creates a human HITL payload
  with drafts, disagreements, and debate log.
- Human decisions are `pick-draft-N`, `provide-resolution`, `re-run-round`,
  and `abort`.
- `rounds.mode` is `single_pass` or `iterate`; default is `single_pass`.
  Iteration re-fans drafts with union disagreements injected as critique
  context and is bounded by `rounds.max`. Exhaustion escalates instead of
  failing the node as CONFIG.
- Participants are declared in `participants[]`; each entry is either a
  runner ref or an agent catalog ref. The minimum is 2 and the maximum is
  `MAISTER_MAX_ORCHESTRATOR_FANOUT`.
- Cross-verification rotates as `i audits (i + 1) mod N`.
- The synthesizer is a separately declared `consensus.synthesizer` role. It
  may reuse a participant runner, but it has no vote.
- `material_axes` is a non-empty author-declared list. The engine checks
  verifier verdict booleans for those axes.
- Draft workspaces default to `repo_read`; participant-level overrides are
  allowed but remain read-only for v1.
- Drafts produce text or structured artifacts only. They do not create
  branches and settle directly to `Done`.
- Mandatory artifacts are `consensus_plan` with kind `plan` and `debate_log`
  with kind `human_note`.
- Add `node_attempts.node_type = "consensus"` and one migration.
- No new `MaisterError` code. Reuse `CONFIG`, `PRECONDITION`,
  `EXECUTOR_UNAVAILABLE`, `CHECKPOINT`, and `CONFLICT`.
- Writable competing-code drafts are Phase 2 and need ADR-102-class design
  work before implementation.

## Resolved Implementation Decisions

- The frozen SSOT will be
  `.ai-factory/specs/feature-m41-consensus-node.md`. It must be written before
  code and treated as the single source for lifecycle, DSL, and acceptance
  behavior.
- Use `ADR-109` and migration `0068`. Include a final rebase/renumber pass in
  case main advances before implementation lands.
- Add a dedicated consensus verdict ledger table instead of overloading
  `gate_results`. `gate_results` is gate-id oriented and lacks durable
  round/verifier/target identity.
- Implement pure consensus helpers outside the large runner file, then call
  them from `runner-graph.ts`:
  - `web/lib/flows/graph/consensus/tally.ts`
  - `web/lib/flows/graph/consensus/verdict.ts`
  - `web/lib/flows/graph/consensus/rotation.ts`
  - `web/lib/flows/graph/consensus/ledger.ts`
- Keep the lifecycle driver wired from `runner-graph.ts`, adjacent to the
  orchestrator dispatch path, so parking, resume, node attempts, and artifact
  finalization stay in one runtime boundary.
- Add a thin internal `launchConsensusDraftRun` helper that reuses the same
  lower-level launch/delegation pieces as `launchAgentRun` without forcing
  runner-only participants through agent catalog rows. Agent participants
  resolve through `resolveEffectiveAgentDefinition`; runner participants
  resolve directly through `resolveAgentRunner` and persist a runner-based
  `delegation_snapshot`.
- Draft child runs are `run_kind = "agent"` with `parent_run_id`,
  `root_run_id`, `delegation_snapshot`, `runner_snapshot`, and `launch_mode`
  populated by server code.
- Cross-verification and synthesis ACP sessions are not `runs` rows, but they
  acquire the same numeric host-capacity ceiling as
  `MAISTER_MAX_CONCURRENT_AGENTS` through an internal limiter and always
  release tokens in `finally`.
- The consensus node itself must not be added to the generic
  `ai_coding | judge | orchestrator` capability-materialization branch.
  Participant draft runs and synthesis/verification sessions own their own
  runner/capability context.
- Extract or expose a shared tolerant JSON-object extraction helper before
  implementing `parseConsensusVerdict`; do not copy the private
  `balancedJsonObjects` logic from verdict parsing.
- Generalize parked-child resume or add a consensus-specific equivalent so
  child-run settled events can re-drive a parent flow whose current node is
  `consensus`.
- No new route is planned. Reuse the existing HITL respond route and run SSE
  stream unless OpenAPI/AsyncAPI review proves a new public field is required.
- `consensus_plan` is the single synthesized answer artifact. `debate_log` is
  a required evidence/human-note artifact, not a second synthesized answer.
- The synthesizer writes both mandatory artifacts through the existing
  artifact-instance machinery before the node transitions and before the
  generic `output.produces` backstop checks run.

## Target DSL

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

## Lifecycle Contract

1. Fan out N governed `repo_read` draft child runs.
2. Park parent node as `Running -> WaitingOnChildren`, checkpoint session state,
   and release the scheduler slot.
3. Resume when all draft child runs have settled. A failed draft child counts
   as settled unavailable evidence unless parent cancellation/abandon policy is
   active; consensus does not wake early on the first failed draft.
4. Run cross-verification sessions with rotation `i audits (i + 1) mod N`.
5. Parse structured verdicts fail-closed and persist per-round verdict rows.
6. Tally deterministically:
   - reached: synthesize, write artifacts, finish node, follow success
     transition.
   - not reached and `iterate` with remaining rounds: re-fan with union
     disagreements injected as critique context.
   - not reached and `single_pass` or exhausted: create bounded human HITL
     context with artifact refs plus capped excerpts, move run to `NeedsInput`,
     then let the runner own `NeedsInput -> Running` after resolution.
7. Reuse orchestrator cancel/abandon cascade for any durable child draft runs.

## Structured Verdict Contract

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
- Tally is reached only when every verifier verdict is `agree` and every
  declared axis is `true` in every verifier result.
- Missing, malformed, unknown-axis, or unparseable verdicts count as
  `disagree`.
- `confidence` is advisory only.
- Prompts should request instrumental evidence. Requiring durable
  `counter_evidence` refs is Phase 2.

## Contract Surface Trace

| Surface | Files | Required change |
| --- | --- | --- |
| Flow DSL schema | `web/lib/config.schema.ts` | Add `consensus` node variant, participant refs, synthesizer ref, material axes, rounds, and `on_no_consensus`. |
| Manifest validation | `web/lib/config.ts` | Add `CONSENSUS_ENGINE_MIN = "1.9.0"`, `declaresConsensusNode`, participant limits, required outputs, and semantic errors. |
| Engine compile | `web/lib/flows/graph/compile.ts` | Map `type: "consensus"` to node attempts and preserve consensus config for runtime. |
| Runtime lifecycle | `web/lib/flows/graph/runner-graph.ts` | Add consensus dispatch, fan/park/resume, verify/tally/synth/HITL state transitions. |
| Parked child resume | `web/lib/domain-events/orchestrator-resume.ts` and related domain-event wiring | Generalize or add a consensus-specific consumer so settled child draft runs wake the parent flow only when the current node is `consensus`. |
| Draft launch | `web/lib/agents/launch.ts` and new helper | Reuse M37 delegation/run-tree internals for governed child draft runs. |
| Verdict parsing | `web/lib/flows/graph/gates-exec.ts`, shared extraction helper, and new consensus parser | Reuse tolerant JSON extraction without copy-pasting the private helper, add per-axis consensus verdict parsing. |
| Tally | New `web/lib/flows/graph/consensus/tally.ts` | Pure deterministic unanimous tally. |
| HITL response | `web/lib/services/hitl.ts`, `web/lib/flows/hitl-validate.ts` | Reuse human-review route with consensus schema discriminator, allow-list validation, and already-delivered self-heal. |
| HITL response UI | `web/components/board/run-hitl-response.tsx`, `web/components/board/hitl-decision-controls.tsx`, inbox cards, messages | Add first-class controls for pick draft, provide resolution, rerun round, and abort with bounded context rendering. |
| Flow editor authoring UI | `web/lib/flows/editor/node-form.ts`, `web/components/flows/*`, `web/messages/en.json`, `web/messages/ru.json` | Make `consensus` authorable with participant, synthesizer, axes, rounds, and output controls. |
| Topology/read models | `web/lib/flows/graph/topology.ts`, run/HITL queries, inbox and observatory labels | Add node-role/label fan-out for `consensus` and artifact kind `plan` where user-visible. |
| DB schema | `web/lib/db/schema.ts`, `web/lib/db/migrations/0068_*` | Add node type, artifact kind `plan`, consensus verdict ledger, and migration metadata. |
| Docs | `docs/flow-dsl.md`, `docs/configuration.md`, `docs/database-schema.md`, `docs/db/runs-domain.md`, `docs/system-analytics/*.md`, `docs/decisions.md` | Document current-state behavior and contracts. |
| API docs | `docs/api/*` | Keep route/SSE reuse explicit; update schema examples/enums whenever HITL payload, response body, node type, artifact kind, or DTO fields become public. |
| Product docs | `CLAUDE.md`, `docs/PRODUCT_VIEW.md` | Add Phase 2 backlog line for writable competing-code drafts. |

## Deployment Touchpoints

- No new process, port, sidecar, or package-level dependency is planned.
- No new environment variable is planned.
- Existing limits used:
  - `MAISTER_MAX_ORCHESTRATOR_FANOUT`
  - `MAISTER_ORCHESTRATOR_MAX_DEPTH`
  - `MAISTER_MAX_CONCURRENT_AGENTS`
- `docs/configuration.md` must still document how consensus uses these limits
  through the existing `orchestratorMaxFanout()`, `orchestratorMaxDepth()`,
  and agent-capacity helpers.
- If implementation discovers a necessary new environment variable, stop and
  update this plan plus `.env.example`, `docs/configuration.md`, deployment
  docs, and validation tests before adding runtime reads.

## Identifier And Trust Boundaries

- Config-authored node IDs, participant IDs, runner refs, and agent refs are
  trusted only after zod parsing plus semantic validation.
- Participant runner/agent refs must be re-resolved at launch. Stale or
  untrusted refs become `PRECONDITION`, not silent fallback.
- Draft child `parent_run_id`, `root_run_id`, `delegation_snapshot`, and
  `runner_snapshot` are server-derived. They must never come from HITL response
  bodies.
- HITL `runId` and `hitlRequestId` come from route params and are checked
  against stored DB rows. Draft selection and allowed decisions come from
  server-stored HITL schema, not arbitrary body IDs.
- `provide-resolution` text is untrusted human input. It can become synthesis
  input but cannot mutate participant IDs, runner refs, output IDs, or graph
  transitions.
- Cross-verification verdict JSON is untrusted ACP output. Parse fail-closed
  and persist parsed verdicts only after schema validation.

## Atomicity And Recovery

- Fan-out writes child runs durably before parent node parks.
- Parking must checkpoint and release the scheduler slot even if the node
  cannot continue in the same process.
- Resume recollects already settled draft child runs from DB/artifacts and does
  not respawn them.
- Per-round verifier results are persisted with a unique key on
  `(node_attempt_id, round, verifier_key, target_key)`, so crash recovery does
  not repay completed verification sessions.
- Synthesizer output writes both mandatory artifacts in one node-finalization
  path. If either artifact write fails, the node remains resumable and does not
  transition success.
- HITL creation and parent run status update are a two-phase transition:
  create the request and durable payload first, then set run status to
  `NeedsInput`. Recovery can discover an open consensus HITL and keep the run
  parked.
- Consensus HITL response handling must mirror existing form/human recovery:
  store the response, never flip `runs.status` directly, and if delivery is
  already complete while the run is still `NeedsInput`, schedule the runner
  re-drive so the response cannot strand the run.
- Human HITL payloads and browser DTOs must carry draft/debate artifact refs
  plus capped excerpts, not unbounded prompt, draft, or debate bodies.
- All acquired capacity tokens for ephemeral verify/synthesis sessions must be
  released in `finally`, including parser failure, ACP spawn failure, and
  cancellation.

## Failure Table

| Failure | Expected behavior |
| --- | --- |
| Less than 2 participants | `CONFIG` during manifest validation. |
| More than fanout cap | `CONFIG` during validation or launch preflight with cap context. |
| Empty `material_axes` | `CONFIG`. |
| Unknown verifier axis | Parsed as invalid verdict and counted as disagree; config-authored unknown axes are `CONFIG`. |
| Missing synthesizer | `CONFIG`. |
| Unresolvable participant/synthesizer at compile | `CONFIG` when statically known. |
| Unresolvable or untrusted participant/synthesizer at launch | `PRECONDITION`. |
| Engine minimum below `1.9.0` | `CONFIG`. |
| Malformed verifier output | Fail-closed disagree, persist failed verdict state, then iterate/escalate by policy. |
| Draft child run fails | Parent waits for all sibling drafts to settle, treats the failed draft as unavailable evidence, and then iterates or escalates with failure context unless cancellation/abandon policy is active. |
| HITL `abort` decision | Node/run follows existing abort/failure semantics with `CHECKPOINT` or `CONFLICT` where applicable. |
| Duplicate or already-delivered HITL response | Stored response is idempotent; if the run remains `NeedsInput`, schedule runner re-drive instead of leaving it stranded. |
| Capacity unavailable | Existing queue/admission behavior or `EXECUTOR_UNAVAILABLE`, with context fields. |

## Test Strategy

- Unit tests:
  - `tallyConsensus` unanimous success/failure, missing axes, unknown axes,
    malformed verdicts, confidence ignored.
  - `parseConsensusVerdict` tolerant JSON extraction, nested JSON, prose
    wrappers, invalid enum, missing axes, disagreement shape.
  - Rotation helper for N participants.
  - Manifest validation for participants, synthesizer, axes, rounds, outputs,
    and engine floor.
  - Topology/read-model label fan-out for node type `consensus` and artifact
    kind `plan`.
- Integration tests with real DB and mock ACP:
  - Happy path fan -> verify -> consensus -> synth -> artifacts -> success
    transition.
  - Child-settled domain event wakes a parent parked on a consensus node and
    ignores parents whose current node is not consensus.
  - No-consensus HITL with `pick-draft-N`, `provide-resolution`,
    `re-run-round`, and `abort`.
  - Duplicate/already-delivered consensus HITL response re-drives a stored
    `NeedsInput` run instead of stranding it.
  - Iterate mode injects union disagreements and stops at `rounds.max`.
  - Cancel/abandon cascade reaches child draft runs.
  - Crash/resume recollects drafts and persisted verifier results.
  - Capacity cap queues or defers as expected.
  - Budget/policy escalation reuses ADR-101 behavior.
- E2E if feasible:
  - Authored flow containing a consensus node and mock ACP responses, verifying
    user-visible NeedsInput/resume and final artifacts.
  - Flow editor can author a consensus node and the HITL panel exposes the four
    consensus decisions without clipped text on a short viewport.
- Every phase that adds tests must document exact runner globs and leave the
  phase-specific suite green before continuing.

## Tasks

### Phase 0 - SDD And Contract Freeze

- [x] Task 1: Write the frozen SSOT spec at
  `.ai-factory/specs/feature-m41-consensus-node.md`.
  Include lifecycle, target DSL, structured verdict schema, tally rule,
  participant/synthesizer semantics, HITL decisions, recovery rules, error
  taxonomy, and out-of-scope Phase 2 work.
  Acceptance: the spec includes every locked product decision in this plan and
  states ADR-109, migration 0068, and engine 1.9.0.
  Tests: docs-only; run `git --no-pager diff --check`.
  Logging: no runtime logging; spec must require structured fields for all new
  runtime logs.

- [x] Task 2: Add the design and docs contract skeleton.
  Update `docs/decisions.md` with ADR-109, create
  `docs/system-analytics/consensus.md` using the R5 structure, add the
  consensus glossary/cross-link to `docs/CLAUDE.md`, and cross-reference from
  `docs/system-analytics/flow-graph.md` and
  `docs/system-analytics/orchestrator.md`.
  Acceptance: docs describe current-state behavior, not a changelog.
  Tests: run `pnpm validate:docs`.
  Logging: no runtime logging; docs must name expected structured log fields
  for fan, verify, tally, synth, HITL, and resume events.

- [x] Task 3: Update product/config/DSL/database docs before code.
  Touch `docs/flow-dsl.md`, `docs/configuration.md`,
  `docs/database-schema.md`, `docs/db/runs-domain.md`, `CLAUDE.md`, and
  `docs/PRODUCT_VIEW.md`.
  Acceptance: DSL includes the target example, configuration docs explain
  reused limits, DB docs include the verdict ledger and `plan` artifact kind,
  and Product View/CLAUDE include the Phase 2 writable-drafts backlog line.
  Tests: run `pnpm validate:docs`.
  Logging: no runtime logging; docs must preserve the structured-log
  requirement.

Commit plan after Tasks 1-3: `docs(consensus): freeze M41 consensus contracts`.

### Phase 1 - Schema, Pure Functions, And Persistence

- [x] Task 4: Add RED schema and manifest-validation tests.
  Cover the consensus node shape, participant min/max, material axes,
  synthesizer requirement, exact mandatory outputs, `rounds.max`, engine floor,
  and no mixed legacy `steps`/graph misuse.
  Files: add tests near current config/graph manifest tests.
  Acceptance: tests fail for missing implementation and use exact runner globs.
  Tests: run the focused web unit/config test command discovered in
  `web/package.json`.
  Logging: no runtime logging; failed validation assertions must check clear
  actionable error messages.

- [x] Task 5: Implement schema, engine floor, and compile mapping.
  Files: `web/lib/config.schema.ts`, `web/lib/config.ts`,
  `web/lib/flows/engine-version.ts`, `web/lib/flows/graph/compile.ts`.
  Acceptance: `type: "consensus"` compiles to `nodeType: "consensus"`,
  engine floor is `1.9.0`, validation rejects every Task 4 invalid case with
  `CONFIG`, and consensus is not added to the generic
  `ai_coding | judge | orchestrator` capability-materialization branch.
  Tests: rerun Task 4 focused tests.
  Logging: validation code must not log; errors carry enough path/context to
  debug the invalid manifest.

- [x] Task 6: Add RED pure helper tests and implement shared parser plus
  consensus helpers.
  Files: new `web/lib/flows/graph/consensus/tally.ts`,
  `web/lib/flows/graph/consensus/verdict.ts`,
  `web/lib/flows/graph/consensus/rotation.ts`, shared tolerant JSON extraction
  helper used by both verdict parsers, plus colocated tests.
  Acceptance: parser is tolerant but fail-closed, no copy of the private
  `balancedJsonObjects` helper remains, tally is pure and deterministic, and
  rotation is stable by participant order.
  Tests: run focused helper test globs.
  Logging: helpers are pure and must not log; callers log parsed verdict
  status with structured fields.

- [x] Task 7: Add migration 0068 and DB types.
  Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0068_*`,
  migration metadata, and DB docs if generated snapshots require it.
  Add `node_type = "consensus"`, artifact kind `plan`, and
  `consensus_round_verdicts` with unique
  `(node_attempt_id, round, verifier_key, target_key)`.
  Acceptance: migration applies on a fresh DB and existing DB; schema types
  expose strict TS shapes.
  Tests: run focused migration/schema tests or the existing DB integration
  command.
  Logging: migration has no runtime logging; DB errors must include migration
  number and statement context through existing tooling.

- [x] Task 8: Add schema fan-out for topology, read models, and public
  contracts.
  Files: `web/lib/flows/graph/topology.ts`, run/HITL query DTOs, inbox and
  observatory labels, `docs/api/web.openapi.yaml`,
  `docs/api/external/operations.openapi.yaml`, and AsyncAPI docs if their
  schemas expose node types, artifact kinds, HITL payloads, or response bodies.
  Acceptance: every client-visible enum/schema knows about `consensus` and
  artifact kind `plan`, or the plan notes that the surface is not publicly
  exposed.
  Tests: run focused DTO/API-doc validation plus the tests added for Task 4.
  Logging: no runtime logging; docs/examples must not include prompt or draft
  body text.

Commit plan after Tasks 4-8:
`feat(consensus): add schema validation and verdict primitives`.

### Phase 2 - Draft Fan-Out, Parking, And Resume

- [ ] Task 9: Add RED integration tests for draft fan-out and parking.
  Use the mock ACP/supervisor pattern already used by graph integration tests.
  Cover agent participant, runner participant, repo_read default, participant
  override, run-tree IDs, delegation snapshots, WaitingOnChildren, and scheduler
  slot release.
  Acceptance: tests prove no draft branches are created and child runs settle
  directly to `Done`.
  Tests: run the focused graph integration command.
  Logging: assertions should capture expected structured log event names and
  fields when the existing test harness supports logs.

- [x] Task 10: Implement participant resolution and draft launch.
  Files: `web/lib/agents/launch.ts` and/or a new internal helper under
  `web/lib/flows/graph/consensus/`.
  Acceptance: server-side code resolves participants via
  `resolveAgentRunner`/`resolveEffectiveAgentDefinition`, runner-only
  participants do not require agent catalog rows, trust is enforced, M37
  run-tree fields are used, and delegation tools are never exposed to node
  agents.
  Tests: rerun Task 9 focused tests.
  Logging: emit structured fan-out logs with `runId`, `nodeId`,
  `nodeAttemptId`, `round`, `participantId`, `runnerId`, `childRunId`, and
  `workspaceMode`.

- [x] Task 11: Add RED integration tests for consensus parked-child resume.
  Files: current graph/domain-event integration tests around
  `web/lib/domain-events/orchestrator-resume.ts` or the generalized
  replacement.
  Cover all draft children settled, one child failed while siblings still run,
  failed child plus all siblings settled, parent no longer on the consensus
  node, and `EXECUTOR_UNAVAILABLE` while re-driving the flow.
  Acceptance: tests prove consensus parents are woken only when the current
  node is `consensus`, and that failed drafts are settled evidence rather than
  an early wake/fail path.
  Tests: run focused graph/domain-event integration tests.
  Logging: assertions should capture resume logs with `resumeReason`,
  `settledChildRunIds`, and `currentNodeType` when supported.

- [x] Task 12: Wire consensus dispatch, park/recollect, and resume consumer.
  File: `web/lib/flows/graph/runner-graph.ts`, with helper modules where
  useful, plus `web/lib/domain-events/orchestrator-resume.ts` or a replacement
  consumer.
  Acceptance: parent node parks as `WaitingOnChildren`, releases the scheduler
  slot, a child-settled event re-drives only consensus parents after all drafts
  settle, existing settled drafts are recollected after crash/retry without
  respawning, and `EXECUTOR_UNAVAILABLE` cannot silently advance to success.
  Tests: rerun Tasks 9 and 11 focused tests.
  Logging: emit structured park/resume logs with `runId`, `nodeId`,
  `nodeAttemptId`, `round`, `childRunIds`, `parkStatus`, and `resumeReason`.

Commit plan after Tasks 9-12:
`feat(consensus): fan out governed draft child runs`.

### Phase 3 - Verification, Tally, And Rounds

- [ ] Task 13: Add RED integration tests for cross-verification.
  Cover rotational audit assignment, ACP spawn failures, malformed output,
  missing axes, unknown axes, persisted verdict rows, and capacity release on
  failure.
  Acceptance: malformed or missing verifier output fails closed into a
  disagree result instead of throwing away the node lifecycle.
  Tests: run focused graph integration tests plus helper unit tests.
  Logging: test expected structured verify logs with `verifierId`,
  `targetParticipantId`, `round`, `verdict`, `parseStatus`, and
  `capacityTokenReleased`.

- [x] Task 14: Implement in-node cross-verification sessions and verdict
  persistence.
  Files: `web/lib/flows/graph/runner-graph.ts`,
  `web/lib/flows/graph/consensus/ledger.ts`, and ACP/gate helper imports.
  Acceptance: verifier sessions use the `ai_judgment` spawn/parser pattern,
  are not child runs, persist per-round verdicts idempotently, and are bounded
  by the existing agent-concurrency ceiling.
  Tests: rerun Task 13 focused tests.
  Logging: emit structured verify start/finish logs with no prompt/body
  interpolation; include IDs, round, parse status, and duration.

- [x] Task 15: Implement deterministic tally and iteration.
  Files: `runner-graph.ts` and consensus helper modules.
  Acceptance: unanimous consensus goes to synthesis; non-consensus in iterate
  mode re-fans with union disagreements as critique context until
  `rounds.max`; malformed verifier output is failed-closed evidence;
  failed draft children are unavailable evidence once all siblings settle; and
  exhausted/single-pass paths escalate to HITL without CONFIG failure.
  Tests: run focused unit and integration tests for rounds.
  Logging: emit structured tally and iteration logs with `axes`,
  `agreementReached`, `round`, `nextRound`, and `disagreementCount`.

Commit plan after Tasks 13-15:
`feat(consensus): verify drafts and tally unanimous agreement`.

### Phase 4 - HITL Resolution, Synthesis, And Artifacts

- [x] Task 16: Add RED tests for consensus HITL decisions.
  Cover `pick-draft-N`, `provide-resolution`, `re-run-round`, `abort`,
  allow-list enforcement, stale HITL IDs, human actor requirement,
  server-derived child draft selection, bounded draft/debate excerpts, and
  duplicate/already-delivered response self-heal.
  Acceptance: body-controlled cross-resource IDs are rejected or ignored in
  favor of stored server state, and large draft/debate bodies do not enter the
  HITL DTO unbounded.
  Tests: run focused HITL service tests and route tests if they exist.
  Logging: tests should assert existing audit/log hooks receive decision type,
  run ID, node ID, and HITL ID without logging resolution body text.

- [x] Task 17: Implement consensus HITL payload and response handling.
  Files: `web/lib/services/hitl.ts`,
  `web/lib/flows/hitl-validate.ts`, any HITL schema/types files, and
  existing API docs if public examples change.
  Acceptance: no new route is added; human-review HITL kind is reused with a
  consensus schema discriminator; decisions store durable response artifacts;
  the route never flips `runs.status` directly; already-delivered responses
  schedule runner re-drive when the run is still `NeedsInput`; and consensus
  context is exposed as artifact refs plus capped excerpts.
  Tests: rerun Task 16 focused tests.
  Logging: emit structured HITL logs with `runId`, `nodeId`, `hitlRequestId`,
  `decision`, `round`, and `actorId`; never log free-form resolution text.

- [x] Task 18: Add RED tests for synthesis and mandatory artifacts.
  Cover consensus success, human-picked draft, human-provided resolution,
  missing synthesizer output, artifact write failure, and `output.produces`
  backstop behavior.
  Acceptance: exactly one synthesized `consensus_plan` artifact and one
  `debate_log` evidence artifact are current when the node succeeds.
  Tests: run focused artifact/graph integration tests.
  Logging: assert structured synth logs include artifact IDs/kinds and omit
  artifact body text.

- [x] Task 19: Implement synthesis and artifact finalization.
  Files: `runner-graph.ts`, artifact helper modules, and any typed artifact
  definitions.
  Acceptance: synthesizer has no vote, runs only after consensus or human
  resolution, writes `consensus_plan` kind `plan` and `debate_log` kind
  `human_note`, writes both artifacts before generic `output.produces`
  backstop checks, and transitions only after both artifacts are durable.
  Tests: rerun Task 18 focused tests.
  Logging: emit structured synthesis logs with `runId`, `nodeId`,
  `nodeAttemptId`, `synthesizerId`, `source`, `artifactIds`, and `duration`.

Commit plan after Tasks 16-19:
`feat(consensus): resolve HITL and synthesize artifacts`.

### Phase 5 - Cancellation, Recovery, Docs, And UI Surfaces

- [ ] Task 20: Add tests for cancellation, abandon cascade, and crash windows.
  Cover parent cancel while drafts run, cancel during verification, cancel
  while HITL is open, resume after crash before/after verdict persistence, and
  resume after one artifact write fails.
  Acceptance: no stranded child drafts, no duplicate verifier charges, and no
  premature success transition.
  Tests: run focused graph recovery integration tests.
  Logging: expected logs include `cascadeReason`, `childRunIds`,
  `recoveryStage`, and `idempotencyKey`.

- [ ] Task 21: Implement cascade/recovery hardening.
  Files: `runner-graph.ts`, consensus ledger helpers, and existing
  orchestrator cascade helpers.
  Acceptance: consensus reuses orchestrator cancel/abandon cascade, recovers
  from every Task 20 crash window, and releases all deferred capacity on
  failure paths.
  Tests: rerun Task 20 focused tests.
  Logging: emit structured recovery/cascade logs with IDs and stage names, not
  raw prompts or artifact contents.

- [x] Task 22: Add RED tests for consensus authoring UI.
  Files: `web/lib/flows/editor/node-form.ts`,
  `web/components/flows/flow-graph-editor.tsx`,
  `web/components/flows/node-form/node-side-form.tsx`,
  `web/components/flows/__tests__/*`, and `web/messages`.
  Cover toolbar/type selection, blank consensus node defaults, participant
  entries, synthesizer selection, material axes, rounds, required outputs, EN/RU
  strings, and existing node types remaining unchanged.
  Acceptance: tests fail until consensus is authorable through the existing
  editor surface.
  Tests: run focused flow-editor component/unit tests.
  Logging: UI code must not add client-side console logs.

- [x] Task 23: Implement consensus authoring UI and i18n.
  Files: same surfaces as Task 22.
  Acceptance: users can create and edit a consensus node with all required DSL
  fields, text fits at mobile and desktop widths, and EN/RU strings are
  complete.
  Tests: rerun Task 22 focused tests plus typecheck for touched components.
  Logging: UI code must not log prompts, participant outputs, or draft content.

- [x] Task 24: Implement consensus HITL response UI and viewport checks.
  Files: `web/components/board/run-hitl-response.tsx`,
  `web/components/board/hitl-decision-controls.tsx`, inbox cards, run detail
  HITL surfaces, and `web/messages`.
  Acceptance: users can inspect bounded draft/disagreement/debate context,
  choose `pick-draft-N`, `provide-resolution`, `re-run-round`, or `abort`, and
  the controls do not clip or overlap on short mobile/desktop viewports.
  Tests: run focused component/typecheck checks; add Playwright coverage for
  the consensus HITL user-visible flow if the component tests cannot cover the
  viewport behavior.
  Logging: UI code must not add client-side console logs for HITL contents.

- [x] Task 25: Finish docs and contract validation.
  Reconcile SSOT, ADR-109, DSL docs, configuration docs, DB docs, API docs,
  analytics docs, product docs, and `.env.example` if needed.
  Acceptance: docs describe the implemented current state and contain no stale
  majority/quorum/agent-driven-gate language.
  Tests: run `pnpm validate:docs`.
  Logging: no runtime logging; docs must list structured fields used by the
  final implementation.

Commit plan after Tasks 20-25:
`feat(consensus): harden recovery and document M41 behavior`.

### Phase 6 - Final Verification And Rebase Hygiene

- [x] Task 26: Run full relevant verification.
  Commands to consider, adjusted to exact touched surfaces:
  `pnpm --filter maister-web typecheck`,
  `pnpm --filter maister-web lint`,
  focused unit tests, focused integration tests,
  `pnpm validate:docs`, and E2E for the consensus authored-flow path if added.
  Acceptance: every relevant suite is green or the failure is explicitly
  identified as unrelated with evidence.
  Tests: this task is the final verification gate.
  Logging: if failures occur, capture command, exit code, and failing test name
  in notes without dumping secrets or prompt bodies.

- [x] Task 27: Rebase/renumber and final contract pass.
  Before merge, re-check ADR numbers, migration number, engine version,
  sibling branch changes, and `feature/fusion-consensus` collision risk.
  Acceptance: no duplicate ADR/migration, no stale engine floor, and no plan
  language contradicts implementation, API docs, editor UI, HITL UI, or
  read-model labels.
  Tests: run `git --no-pager diff --check` and rerun any suite affected by
  renumbering.
  Logging: no runtime logging; final notes should identify any renumbered
  files.

Commit plan after Tasks 26-27:
`chore(consensus): verify M41 implementation`.

## Acceptance Gates

- The SSOT spec exists and is complete before code changes.
- `consensus` is a typed graph node with engine floor `1.9.0`.
- Drafts are durable child runs, read-only, governed, and server-launched.
- Cross-verification is in-node, fail-closed, bounded, and idempotent.
- Tally is pure, unanimous, and not delegated to any agent.
- No-consensus escalates through existing human HITL and resumes correctly.
- Synthesis runs only after consensus or human resolution.
- `consensus_plan` and `debate_log` are typed current artifacts.
- Cancellation and crash recovery leave no duplicate drafts, duplicate verifier
  rows, or stranded capacity tokens.
- Docs, DB migration, API contracts, and system analytics all match the code.
- Flow editor and HITL response UI can author and resolve consensus without
  generic JSON-only fallbacks or clipped controls.
