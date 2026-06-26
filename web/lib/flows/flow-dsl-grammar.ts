// SSOT for the Flow DSL grammar shown to the Studio assistant (every turn) and
// shipped as the `/flow-authoring` skill's `references/flow-dsl.md`. Pure +
// deterministic. A drift guard (flow-dsl-grammar.test.ts) introspects
// config.schema.ts and fails if any node type / settings key / enum value is
// absent here, so this reference stays complete and accurate as the schema moves.

export function buildFlowDslGrammar(): string {
  return GRAMMAR;
}

const GRAMMAR = `# Flow DSL grammar (authoritative, typed-node graph)

This reference is generated from the runtime Zod schema (\`config.schema.ts\`) and
is drift-guarded — when it lists a field, type, or enum value, that is the exact
accepted shape. A flow manifest declares \`nodes[]\` (the canonical runtime graph)
wired by named \`transitions\`, OR a legacy linear \`steps[]\` list. Author new
flows as graphs.

## Manifest header

\`\`\`yaml
schemaVersion: 1
name: my-flow
runner_profiles:
  claude-code: { capability_agent: claude, adapter: claude, model: claude-sonnet-4-6, provider: { kind: anthropic } }
compat: { engine_min: 1.3.0 }   # graph floor; gates/artifacts/agent bind push it higher
nodes: [ ... ]                   # exactly one of nodes[] or steps[]
\`\`\`

## Node types (discriminated by \`type\`)

Fields common to every node: \`id\`, \`type\`, \`transitions\`, \`input\`, \`output\`,
\`pre_finish\`, \`finish\`, \`rework\`, \`decide\`, \`retry_safe\`, \`session\`.

- **ai_coding** — an ACP agent coding session. \`action: { prompt }\` (required).
  \`settings\` = ai_coding settings (below). May add \`retry_policy\` and
  \`session_policy\`.
- **orchestrator** — a supervisory agent session that spawns and coordinates
  child runs/tasks. \`action: { prompt }\`. \`settings\` = ai_coding settings plus a
  \`delegation: { max_fanout, max_depth }\` block.
- **consensus** — a FIRST-CLASS multi-agent agreement node. Emit
  \`type: consensus\` directly with \`prompt\`, \`participants\` (≥2, each
  \`{ id, agent|runner, workspace? }\`), a \`synthesizer\` (\`{ agent|runner }\`),
  \`material_axes\` (≥1), \`workspace\`, \`rounds: { mode, max }\`, and
  \`on_no_consensus\`. It MUST also declare \`output.produces\` with EXACTLY these
  two artifacts or compile fails (CONFIG):
  \`{ id: consensus_plan, kind: plan, current: true }\` and
  \`{ id: debate_log, kind: human_note, current: true }\`. N independent drafters
  fan out and the synthesizer merges them into one result. **NEVER emulate
  consensus with two judge nodes** — it is a native fan-out/merge node.
- **judge** — an LLM verdict (no code changes). \`action: { prompt }\`. A
  RUNNER-BEARING node: it resolves via \`settings.runner\` (or its \`session:\`).
  \`settings\` = judge settings (below).
- **cli** — a shell command, no agent. \`action: { command }\`. \`settings\` =
  cli/check settings. May add \`retry_policy\`.
- **check** — a shell command, gate-style. \`action: { command }\`. \`settings\` =
  cli/check settings.
- **human** — a HITL decision. No \`action\`; \`finish.human:
  { role, decisions, commentsVar }\`. \`settings\` = human settings.
- **form** — a HITL form collection. No \`action\`; \`settings.form_schema\`
  (required) is the JSON form it collects against, finishing on
  \`transitions.success\`.

## Node \`settings\` by type

- **ai_coding / orchestrator**: \`runner_type\`, \`runner\`, \`agent\`, \`model\`,
  \`thinkingEffort\`, \`mcps\`, \`tools\`, \`skills\`, \`settingsProfile\`,
  \`workspaceAccess\`, \`artifactAccess\`, \`permissionMode\`, \`limits\`,
  \`restrictions\`, \`enforcement\`, \`hooks\` (orchestrator also: \`delegation\`).
- **judge**: \`runner\`, \`mcps\`, \`tools\`, \`skills\`, \`restrictions\`,
  \`permissionMode\`, \`thinkingEffort\`, \`limits\`, \`enforcement\`, \`hooks\`
  (\`settings.model\` was REMOVED — judge is runner-bearing).
- **human**: \`roles\`, \`assignees\`, \`decisions\`, \`allowFurtherTracks\`,
  \`allowTakeover\`, \`slaHours\`, \`stalenessHint\`, \`returnRequires\`,
  \`criticality\`.
- **form**: \`form_schema\`, \`roles\`, \`criticality\`.
- **cli / check**: \`command\`, \`timeoutMs\`, \`environmentPolicy\`,
  \`inputArtifacts\`, \`outputArtifacts\`, \`failureClass\`.

## Enums

- \`thinkingEffort\`: low | medium | high
- \`permissionMode\`: ask | allow | deny
- \`workspaceAccess\`: read | write | none
- \`criticality\`: low | medium | high | critical
- \`environmentPolicy\`: inherit | clean | whitelist
- \`failureClass\`: blocking | advisory | retryable
- gate \`kind\`: command_check | skill_check | ai_judgment | artifact_required | external_check | human_review
- gate \`mode\`: blocking | advisory
- \`rework.workspacePolicies\` / \`retry_policy.workspace\`: keep | rewind-to-node-checkpoint | fresh-attempt
- consensus \`rounds.mode\`: single_pass | iterate
- consensus \`on_no_consensus\`: escalate
- \`enforcement\` per-class mode: strict | instruct | off
- \`session_policy\`: resume | new_session

## Sessions & the unified runner config (engine_min >= 2.0.0)

A flow groups runner-bearing nodes into **sessions** — one ACP process + one
continuous \`acp_session_id\` resumed in graph order. A node opts in via a
top-level \`session: <name>\` field (a key in the manifest \`sessions:\` map):

\`\`\`yaml
sessions:
  review: { runner: claude-opus }   # runner is a profile-ref OR an inline config
nodes:
  - { id: implement, type: ai_coding, action: { prompt: ... } }   # implicit 'default' session
  - { id: review, type: ai_coding, session: review, action: { prompt: ... } }
\`\`\`

- A node with neither \`session:\` nor \`settings.runner\` joins the implicit
  **\`default\`** session; \`settings.runner\` + no \`session:\` → a solo session.
- \`judge\` is runner-bearing — it resolves via \`settings.runner\` (or its
  \`session:\`); \`judge.settings.model\` is REMOVED.
- \`consensus\` is EXCLUDED from \`sessions:\` — a consensus node MUST NOT declare a
  \`session:\` (compile fails CONFIG); its participants/synthesizer carry their own
  \`runner\`.
- A node \`session:\` that is neither \`default\` nor a declared \`sessions:\` key
  fails to compile (CONFIG).

**Unified runner config** — \`runner_profiles\` values, \`sessions[].runner\`, node
\`settings.runner\`, and consensus participant/synthesizer \`runner\` all accept the
same shape (a profile-ref string OR an inline object):
\`{ runner_type, capability_agent, adapter?, model?, model_family?, provider?, permission_policy, sidecar?, effort?, env? }\`.
\`effort\` is the thinking effort (low | medium | high); \`env\` is a passthrough
NAME map whose values are \`env:NAME\` references only (never literal secrets).

## Gates — \`pre_finish.gates[]\` (these BLOCK)

Each gate: \`{ id, kind, mode, command?, prompt?, skill?, inputArtifacts?,
output?, staleFrom?, external?, calibration?, must_touch?, must_not_touch? }\`.
A \`blocking\` gate that fails halts the node; \`advisory\` only records a signal.
\`must_touch\`/\`must_not_touch\` are valid ONLY on \`kind: artifact_required\`.

## Typed artifacts

- \`output.produces: [{ id, kind, requiredFor?: [review|merge] }]\`
- \`output.result: { schema, required?, on_mismatch? }\` — opt-in structured output
- \`input.requires: [{ artifact: <id>, kind }]\`

Artifact \`kind\` is a platform artifact kind (e.g. \`diff\`, \`test_report\`,
\`ai_judgment\`, \`generic_file\`). A required-but-absent artifact fails as
PRECONDITION.

## Transitions, rework, decide

\`transitions\` maps a node's decision/outcome to the next node id (\`done\` is the
implicit terminal). \`rework: { allowedTargets, workspacePolicies, maxLoops,
commentsVar?, session_policy? }\` bounds a feedback loop. \`decide: { from, cases? }\`
routes dynamically (\`from: verdict\` with a \`cases\` table, or
\`from: output.<dot.path>\`).

## Complete example

\`\`\`yaml
schemaVersion: 1
name: bugfix
runner_profiles:
  claude-code: { capability_agent: claude, adapter: claude, model: claude-sonnet-4-6, provider: { kind: anthropic } }
compat: { engine_min: 1.3.0 }
nodes:
  - id: fix
    type: ai_coding
    action:
      prompt: |
        /aif-fix {{ task.prompt }}
        {{ review_comments }}
    output:
      produces:
        - id: impl-diff
          kind: diff
          requiredFor: [review]
    transitions:
      success: review

  - id: review
    type: human
    input:
      requires:
        - artifact: impl-diff
          kind: diff
    pre_finish:
      gates:
        - id: impl-diff-required
          kind: artifact_required
          mode: blocking
          inputArtifacts: [impl-diff]
    finish:
      human:
        role: maintainer
        decisions: [approve, rework]
        commentsVar: review_comments
    transitions:
      approve: commit
      rework: fix
    rework:
      allowedTargets: [fix]
      workspacePolicies: [rewind-to-node-checkpoint]
      maxLoops: 3
      commentsVar: review_comments

  - id: commit
    type: ai_coding
    action: { prompt: "/aif-commit" }
    transitions:
      success: done
\`\`\`

\`done\` is the implicit terminal target — no node needs to declare it.

## Templating

Prompts/commands use Mustache (\`{{ task.prompt }}\`, \`{{ steps.<id>.output }}\`,
\`{{ <commentsVar> }}\`). Strict mode: an unknown variable throws CONFIG.
`;
