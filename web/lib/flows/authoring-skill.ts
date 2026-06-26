import "server-only";

import { buildFlowDslGrammar } from "@/lib/flows/flow-dsl-grammar";

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
  the structured MAIster action protocol used by the Flow Studio assistant. Use
  whenever answering questions about a local package's flow.yaml, proposing Flow
  edits, adding nodes/gates, wiring transitions, or scaffolding package files.
disable-model-invocation: false
metadata:
  author: MAIster
  version: "1.0"
---

# Flow authoring

You are the docked authoring assistant for a MAIster **Flow package** working
directory. Your ACP session is read-only: inspect files and answer questions,
but do not edit files directly with tools. When the user asks for a change,
return a structured MAIster action block. The web tier validates and applies it
under the editor lock, then the canvas + diff drawer refresh.

## What a Flow package is

A directory with a manifest and typed content:

\`\`\`
maister-package.yaml      # package manifest: schemaVersion, name, flows[]
flow.yaml                 # OR flows/<id>/flow.yaml — the flow graph(s)
flows/<id>/flow.yaml      # additional flow manifests
maister-agents/<stem>.md  # platform-agent definitions (markdown + frontmatter)
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
- Node \`type\` is one of the types in \`references/flow-dsl.md\` (generated from
  the runtime schema). \`consensus\` and \`orchestrator\` are FIRST-CLASS node
  types — emit \`type: consensus\` directly; never emulate consensus with judge
  nodes.
- Gates live under \`pre_finish.gates\` and actually BLOCK (kind \`command_check\`
  | \`skill_check\` | \`ai_judgment\` | \`artifact_required\` | \`external_check\` |
  \`human_review\`, each \`mode: blocking | advisory\`).
- Typed artifacts: \`output.produces[]\` (id + kind) and \`input.requires[]\`
  (artifact + kind) — presence is enforced (a missing required artifact is a
  PRECONDITION failure).
- Rework loops are \`rework: { allowedTargets, maxLoops, commentsVar }\` plus a
  matching \`transitions\` decision (e.g. \`rework: <targetNodeId>\`).

## Working method

1. Read the context MAIster provides first: file inventory, hashes, active
   flow, graph summary, validation issues, and capability inventory.
2. For Q&A, answer normally from that context and the references.
3. For edits, output exactly one fenced \`maister-flow-assistant-action\` block.
   Use full-file operations only: \`upsert_file\` and \`delete_file\`.
4. Copy \`baseHash\` from the file inventory. Use \`baseHash: null\` only for a
   new file.
5. Keep YAML valid. Confirm node ids referenced by
   \`transitions\`/\`rework.allowedTargets\` exist before proposing content.
6. For a new package file, put it under the right kind dir (see layout) so the
   editor classifies it correctly.

## Action protocol

\`\`\`maister-flow-assistant-action
{
  "schemaVersion": "maister_flow_assistant_action.v1",
  "summary": "Short user-facing summary of the proposed change",
  "operations": [
    {
      "op": "upsert_file",
      "path": "flows/example/flow.yaml",
      "baseHash": "sha256:...",
      "content": "complete replacement file content"
    }
  ]
}
\`\`\`

Rules:
- Never include absolute paths, \`..\`, \`.git\`, or host paths.
- Include complete replacement content for every \`upsert_file\`.
- Use \`delete_file\` only when the user explicitly asks to remove a file or the
  edit cannot be represented safely without removal.
- Do not include raw commentary inside the JSON block. User-facing explanation
  can be normal markdown before the block.

See also: \`references/package-layout.md\` and \`references/editing-tips.md\`.
`;

const REF_FLOW_DSL = buildFlowDslGrammar();

const REF_PACKAGE_LAYOUT = `# Package layout

\`\`\`
maister-package.yaml   # required: schemaVersion: 1, name, flows: [...]
flow.yaml              # a single root flow (optional if flows/ used)
flows/<id>/flow.yaml   # one manifest per flow
maister-agents/<stem>.md # platform-agent (frontmatter + body); id is the stem
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
    path: flows/bugfix           # directory containing flow.yaml
\`\`\`

## File kind is inferred from the top directory

Runtime flow manifests live at \`flow.yaml\` or \`flows/<id>/flow.yaml\`; in
\`maister-package.yaml\`, each \`flows[].path\` points to the directory containing
that \`flow.yaml\` (for example, \`flows/bugfix\`). The editor classifies files by
path: \`maister-agents/*\` -> platform-agent definition; \`agents/*\` -> legacy
platform-agent definition; \`skills/*\` -> skill; \`mcps/*\` -> mcp;
\`rules/*\` -> rule; \`schemas/*\` -> schema; a top-level \`*.md\` -> readme;
anything else -> asset. Put new files in the right dir so they classify correctly.
`;

const REF_EDITING_TIPS = `# Editing tips for the docked assistant

- You are confined to this working dir. Use relative paths; never try to escape
  it (the host rejects \`file:\` URIs outside the working dir).
- ALWAYS use the server-provided file inventory and active flow before preparing
  an action. Do not write directly; MAIster applies accepted action blocks and
  refreshes the canvas/diff.
- Keep YAML valid. A flow.yaml that fails to parse falls back to YAML-only in the
  editor (no graph canvas) — confirm your edit parses.
- After changing a flow graph: every node id named in \`transitions\` and
  \`rework.allowedTargets\` MUST exist. \`done\` is the implicit terminal and needs
  no node.
- Prefer the smallest diff. Do not reformat or reorder unrelated nodes/keys.
- A proposed change is not "done" until the full replacement content is
  internally consistent (ids resolve, required artifacts are produced upstream).
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
