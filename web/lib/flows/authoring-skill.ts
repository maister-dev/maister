import "server-only";

// M36 Phase 5 (ADR-097) T5.3: the `flow-authoring` skill shipped INTO the docked
// local-package AI assistant session. The content is held in-memory (not read off
// a bundled asset path — robust against the Next/Turbopack server-bundle layout)
// and written verbatim into the session's per-adapter skill target at launch (see
// materializeFlowAuthoringSkill). Discoverable by the agent as `/flow-authoring`.

export const FLOW_AUTHORING_SKILL_ID = "flow-authoring";

const SKILL_MD = `---
name: flow-authoring
description: >-
  Author and edit MAIster Flow packages: the flow.yaml typed-node graph DSL
  (nodes, transitions, gates, rework, typed artifacts), the package layout
  (flows/, agents/, skills/, mcps/, rules/, schemas/, maister-package.yaml), and
  the per-kind file editors. Use whenever editing a local package's flow.yaml,
  adding nodes/gates, wiring transitions, or scaffolding package files.
disable-model-invocation: false
metadata:
  author: MAIster
  version: "1.0"
---

# Flow authoring

You are the docked authoring assistant for a MAIster **Flow package** working
directory. Every file you read or write lives UNDER this working dir (the host
confines all file access to it). Edit files directly with your file tools; the
editor canvas + diff drawer re-read the working dir after each write.

## What a Flow package is

A directory with a manifest and typed content:

\`\`\`
maister-package.yaml      # package manifest: schemaVersion, name, flows[]
flow.yaml                 # OR flows/<id>.yaml — the flow graph(s)
flows/                    # additional flow manifests
agents/<stem>.md          # platform-agent definitions (markdown + frontmatter)
skills/<name>/SKILL.md    # bundled skills
mcps/                     # MCP server capability descriptors
rules/                    # rule capability descriptors
schemas/                  # JSON schemas referenced by form/human nodes
\`\`\`

The **canonical runtime DSL is the typed-node graph** (\`nodes:\` with named
\`transitions\`), engine \`1.3.0+\`. A legacy linear \`steps:\` list still parses but
is degenerate — author new flows as graphs.

## The flow.yaml graph (the part you edit most)

Read \`references/flow-dsl.md\` for the full node/gate/artifact reference and a
complete worked example. Key rules:

- Each \`nodes[]\` entry has \`id\`, \`type\`, an \`action\`, and \`transitions\`
  (decision/outcome -> target node id). The first node is the entry.
- Node \`type\`: \`ai_coding\` | \`judge\` | \`cli\` | \`check\` | \`human\` | \`form\`.
- Gates live under \`pre_finish.gates\` and actually BLOCK (kind \`command_check\`
  | \`skill_check\` | \`ai_judgment\` | \`artifact_required\` | \`external_check\` |
  \`human_review\`, each \`mode: blocking | advisory\`).
- Typed artifacts: \`output.produces[]\` (id + kind) and \`input.requires[]\`
  (artifact + kind) — presence is enforced (a missing required artifact is a
  PRECONDITION failure).
- Rework loops are \`rework: { allowedTargets, maxLoops, commentsVar }\` plus a
  matching \`transitions\` decision (e.g. \`rework: <targetNodeId>\`).

## Working method

1. Read the file you are about to change FIRST (\`maister-package.yaml\`, the
   relevant \`flow.yaml\`). Never guess the current shape.
2. Make the smallest edit that satisfies the request. Keep the YAML valid — an
   invalid manifest drops the editor to YAML-only (no canvas).
3. After editing a flow, re-read it to confirm node ids referenced by
   \`transitions\`/\`rework.allowedTargets\` all exist (a dangling target is a
   validation error).
4. For a new package file, put it under the right kind dir (see layout) so the
   editor classifies it correctly.

See also: \`references/package-layout.md\` and \`references/editing-tips.md\`.
`;

const REF_FLOW_DSL = `# flow.yaml — typed-node graph reference

## Manifest header

\`\`\`yaml
schemaVersion: 1
name: my-flow
runner_profiles:
  claude-code:
    capability_agent: claude
    adapter: claude
    model: claude-sonnet-4-6
    provider: { kind: anthropic }
compat:
  engine_min: 1.3.0          # graph DSL floor (gates/artifacts push higher)
\`\`\`

## Node types

| type        | action            | runs as                          |
| ----------- | ----------------- | -------------------------------- |
| \`ai_coding\` | \`{ prompt }\`      | an ACP agent session             |
| \`judge\`     | \`{ prompt }\`      | an LLM verdict (no code changes) |
| \`cli\`       | \`{ command }\`     | a shell command (no agent)       |
| \`check\`     | \`{ command }\`     | a shell command, gate-style      |
| \`human\`     | (none) + \`finish.human\` | a HITL decision           |
| \`form\`      | (none) + \`settings.form_schema\` | a HITL form collect |

## Gate kinds (under \`pre_finish.gates\`)

\`command_check\` · \`skill_check\` · \`ai_judgment\` · \`artifact_required\` ·
\`external_check\` · \`human_review\`. Each: \`{ id, kind, mode: blocking|advisory }\`.
A blocking gate that fails halts the node; advisory only records a signal.

## Typed artifacts

- \`output.produces: [{ id, kind, requiredFor?: [nodeId...] }]\`
- \`input.requires: [{ artifact: <id>, kind }]\`

Artifact \`kind\` is one of the platform artifact kinds (e.g. \`diff\`,
\`test_report\`, \`ai_judgment\`, \`generic_file\`). A required-but-absent artifact
fails as PRECONDITION.

## Transitions + rework

\`transitions\` maps a node's decision/outcome to the next node id:

\`\`\`yaml
transitions:
  success: next_node
  approve: commit
  rework: fix
rework:
  allowedTargets: [fix]
  maxLoops: 3
  commentsVar: review_comments
\`\`\`

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

const REF_PACKAGE_LAYOUT = `# Package layout

\`\`\`
maister-package.yaml   # required: schemaVersion: 1, name, flows: [...]
flow.yaml              # a single root flow (optional if flows/ used)
flows/<id>.yaml        # one manifest per flow
agents/<stem>.md       # platform-agent (frontmatter + body); id is the stem
skills/<name>/SKILL.md # a bundled skill (+ optional references/)
mcps/<name>.yaml       # MCP capability descriptor
rules/<name>.md        # rule capability
schemas/<name>.json    # JSON schema referenced by a form/human node
\`\`\`

## maister-package.yaml

\`\`\`yaml
schemaVersion: 1
name: my-package
flows:
  - id: bugfix
    path: flows/bugfix.yaml      # or the root flow.yaml
\`\`\`

## File kind is inferred from the top directory

The editor classifies a file by its path: \`flow.yaml\` / \`flows/*\` -> flow;
\`agents/*\` -> agent; \`skills/*\` -> skill; \`mcps/*\` -> mcp; \`rules/*\` -> rule;
\`schemas/*\` -> schema; a top-level \`*.md\` -> readme; anything else -> asset. Put
new files in the right dir so they classify correctly.
`;

const REF_EDITING_TIPS = `# Editing tips for the docked assistant

- You are confined to this working dir. Use relative paths; never try to escape
  it (the host rejects \`file:\` URIs outside the working dir).
- ALWAYS read a file before editing it. The editor and you share the same
  working dir, so an edit you make is reflected on the canvas/diff on the next
  refresh.
- Keep YAML valid. A flow.yaml that fails to parse falls back to YAML-only in the
  editor (no graph canvas) — confirm your edit parses.
- After changing a flow graph: every node id named in \`transitions\` and
  \`rework.allowedTargets\` MUST exist. \`done\` is the implicit terminal and needs
  no node.
- Prefer the smallest diff. Do not reformat or reorder unrelated nodes/keys.
- A change is not "done" until you have re-read the file and it is internally
  consistent (ids resolve, required artifacts are produced upstream).
`;

// The materialized skill tree: a `skills/<id>/...` layout so it drops straight
// into the existing per-adapter capability-home materializer (treated as a
// synthetic installed bundle whose only content is this skill).
export const FLOW_AUTHORING_SKILL_FILES: ReadonlyArray<{
  /** Path RELATIVE to the synthetic bundle root (skills/<id>/...). */
  relativePath: string;
  content: string;
}> = [
  {
    relativePath: `skills/${FLOW_AUTHORING_SKILL_ID}/SKILL.md`,
    content: SKILL_MD,
  },
  {
    relativePath: `skills/${FLOW_AUTHORING_SKILL_ID}/references/flow-dsl.md`,
    content: REF_FLOW_DSL,
  },
  {
    relativePath: `skills/${FLOW_AUTHORING_SKILL_ID}/references/package-layout.md`,
    content: REF_PACKAGE_LAYOUT,
  },
  {
    relativePath: `skills/${FLOW_AUTHORING_SKILL_ID}/references/editing-tips.md`,
    content: REF_EDITING_TIPS,
  },
];
