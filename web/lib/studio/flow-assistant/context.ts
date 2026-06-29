import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { LocalPackage } from "@/lib/db/schema";
import type { TemplateVariableCatalogResult } from "@/lib/flows/editor/template-variable-catalog";
import type { FlowAssistantIntent } from "./protocol";

import { parse as parseYaml } from "yaml";
import pino from "pino";

import { packageFileHash } from "./actions";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import { buildTemplateVariableCatalog } from "@/lib/flows/editor/template-variable-catalog";
import { buildFlowDslGrammar } from "@/lib/flows/flow-dsl-grammar";
import { readWorkingDirArtifactFiles } from "@/lib/local-packages/service";
import { validatePackageArtifacts } from "@/lib/local-packages/validate";
import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";

const log = pino({
  name: "studio/flow-assistant/context",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowAssistantFocus = {
  path?: string;
  selectedNodeId?: string;
};

export type FlowAssistantContext = {
  prompt: string;
  focusPath: string | null;
  selectedNodeId: string | null;
  rejectedFocus: string[];
};

type FlowAssistantContextSections = {
  files: Awaited<ReturnType<typeof readWorkingDirArtifactFiles>>;
  byPath: ReadonlyMap<string, string>;
  inventory: Array<{
    path: string;
    hash: string;
    kind: string;
    bytes: number;
  }>;
  focus: {
    focusPath: string | null;
    selectedNodeId: string | null;
    rejectedFocus: string[];
  };
  flowPath: string | null;
  graph: ReturnType<typeof buildGraphSection> | null;
  validationIssues: ReturnType<typeof validatePackageArtifacts>;
  selectedNodeId: string | null;
  variableCatalog: TemplateVariableCatalogResult | null;
  rejectedFocus: string[];
  grammar: string;
};

type CapabilityCounts = {
  flows: number;
  agents: number;
  skills: number;
  mcps: number;
  rules: number;
  schemas: number;
};

const ACTIVE_FLOW_MAX = 24_000;
const MANIFEST_MAX = 8_000;
const INVENTORY_MAX = 160;
const TEMPLATE_VARIABLE_MAX = 120;

export async function buildFlowAssistantContext(args: {
  localPackage: LocalPackage;
  intent: FlowAssistantIntent;
  focus?: FlowAssistantFocus;
  runnerLabel?: string | null;
}): Promise<FlowAssistantContext> {
  const sections = await loadFlowAssistantContextSections(args);
  const manifest = sections.byPath.get("maister-package.yaml") ?? null;
  const capabilityCounts = countCapabilities(
    sections.files.map((file) => file.path),
  );

  return {
    prompt: [
      "# MAIster Flow Studio context",
      "",
      `Package: ${args.localPackage.name}`,
      `Package id: ${args.localPackage.id}`,
      `Package slug: ${args.localPackage.slug}`,
      `Intent: ${args.intent}`,
      `Runner: ${args.runnerLabel ?? "platform default"}`,
      "Project context: none for this project-less local-package assistant run.",
      "",
      editingContractSection(),
      "",
      actionJsonShapeSection(),
      "",
      sections.grammar,
      "",
      "## File inventory",
      formatInventory(sections.inventory),
      "",
      "## Capability inventory",
      formatCapabilityCounts(capabilityCounts),
      "",
      "## Capability sources",
      "This package's authorable capabilities live as files under the package",
      "root (see the File inventory above, tagged by `kind`):",
      "- skills: `skills/<name>/SKILL.md`",
      "- subagents: `agents/<name>.md` or `maister-agents/<name>.md`",
      "- MCP servers: `mcps/...`",
      "- rules: `rules/...`",
      "- schemas: `schemas/...`",
      "You MAY read any of these files read-only, on demand, to learn which",
      "skills, subagents, MCPs, or schemas exist before referencing them in a",
      "node's prompt or `settings`. Scope is package-local only — there is no",
      "platform or project catalog in this project-less assistant session.",
      "",
      "## Package manifest",
      manifest
        ? truncate(manifest, MANIFEST_MAX)
        : "No maister-package.yaml found.",
      "",
      activeFlowSection(sections),
      "",
      "## Graph summary",
      sections.graph ? formatGraph(sections.graph) : "Graph unavailable.",
      "",
      "## Selected node template variables",
      formatTemplateVariableCatalog({
        selectedNodeId: sections.selectedNodeId,
        catalog: sections.variableCatalog,
      }),
      "",
      validationIssuesSection(sections.validationIssues),
      "",
      editorFocusSection(sections),
    ].join("\n"),
    focusPath: sections.focus.focusPath,
    selectedNodeId: sections.selectedNodeId,
    rejectedFocus: sections.rejectedFocus,
  };
}

export async function buildFlowAssistantFollowUpContext(args: {
  localPackage: LocalPackage;
  intent: FlowAssistantIntent;
  focus?: FlowAssistantFocus;
}): Promise<FlowAssistantContext> {
  const sections = await loadFlowAssistantContextSections(args);

  return {
    prompt: [
      "# MAIster Flow Studio current state",
      "",
      `Intent: ${args.intent}`,
      "This is the fresh package state for the current turn. Prior file hashes in the conversation may be stale; use the File inventory below for every `baseHash`.",
      "",
      editingContractSection(),
      "",
      actionJsonShapeSection(),
      "",
      sections.grammar,
      "",
      "## File inventory",
      formatInventory(sections.inventory),
      "",
      activeFlowSection(sections),
      "",
      "## Graph summary",
      sections.graph ? formatGraph(sections.graph) : "Graph unavailable.",
      "",
      "## Selected node template variables",
      formatTemplateVariableCatalog({
        selectedNodeId: sections.selectedNodeId,
        catalog: sections.variableCatalog,
      }),
      "",
      validationIssuesSection(sections.validationIssues),
      "",
      editorFocusSection(sections),
    ].join("\n"),
    focusPath: sections.focus.focusPath,
    selectedNodeId: sections.selectedNodeId,
    rejectedFocus: sections.rejectedFocus,
  };
}

async function loadFlowAssistantContextSections(args: {
  localPackage: LocalPackage;
  intent: FlowAssistantIntent;
  focus?: FlowAssistantFocus;
}): Promise<FlowAssistantContextSections> {
  const files = await readWorkingDirArtifactFiles(args.localPackage);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const inventory = files.map((file) => ({
    path: file.path,
    hash: packageFileHash(file.content),
    kind: classifyPackageFilePath(file.path),
    bytes: Buffer.byteLength(file.content, "utf8"),
  }));
  const focus = validateFocus({
    requested: args.focus,
    filePaths: new Set(files.map((file) => file.path)),
  });
  const flowPath = selectFlowPath({
    focusPath: focus.focusPath,
    paths: files.map((file) => file.path),
  });
  const graph = flowPath
    ? buildGraphSection(flowPath, byPath.get(flowPath))
    : null;
  const validationIssues = validatePackageArtifacts({
    files,
    changedPaths: files.map((file) => file.path),
  });
  const selectedNodeId =
    focus.selectedNodeId && graph?.nodeIds.has(focus.selectedNodeId)
      ? focus.selectedNodeId
      : null;
  const variableCatalog =
    graph?.manifest && selectedNodeId
      ? buildTemplateVariableCatalog({
          manifest: graph.manifest,
          selectedNodeId,
          files,
        })
      : null;
  const rejectedFocus =
    focus.selectedNodeId && selectedNodeId === null
      ? [
          ...focus.rejectedFocus,
          `selected node not found: ${focus.selectedNodeId}`,
        ]
      : focus.rejectedFocus;

  const grammar = buildFlowDslGrammar();

  log.debug(
    {
      localPackageId: args.localPackage.id,
      intent: args.intent,
      fileCount: files.length,
      grammarChars: grammar.length,
      flowPath,
      nodeCount: graph?.nodes.length ?? 0,
      edgeCount: graph?.edges.length ?? 0,
      validationIssueCount: validationIssues.length,
      focusPath: focus.focusPath,
      selectedNodeId,
      variableCount: variableCatalog?.entries.length ?? 0,
      variableWarningCount: variableCatalog?.warnings.length ?? 0,
      rejectedFocusCount: rejectedFocus.length,
    },
    "built flow assistant context",
  );

  return {
    files,
    byPath,
    inventory,
    focus,
    flowPath,
    graph,
    validationIssues,
    selectedNodeId,
    variableCatalog,
    rejectedFocus,
    grammar,
  };
}

function validateFocus(args: {
  requested?: FlowAssistantFocus;
  filePaths: ReadonlySet<string>;
}): {
  focusPath: string | null;
  selectedNodeId: string | null;
  rejectedFocus: string[];
} {
  const rejectedFocus: string[] = [];
  const requestedPath = args.requested?.path?.trim();
  const focusPath =
    requestedPath && args.filePaths.has(requestedPath) ? requestedPath : null;

  if (requestedPath && focusPath === null) {
    rejectedFocus.push(`focus path not found: ${requestedPath}`);
  }

  return {
    focusPath,
    selectedNodeId: args.requested?.selectedNodeId?.trim() || null,
    rejectedFocus,
  };
}

function editingContractSection(): string {
  return [
    "## Editing contract",
    "- You are in a read-only ACP session. Do not edit files directly.",
    "- For Q&A, answer from the context below and the authoritative Flow DSL grammar section below.",
    "- For edits, return exactly one fenced `maister-flow-assistant-action` block after any short explanation.",
    "- Use only `upsert_file` and `delete_file` full-file operations.",
    [
      "- Copy `baseHash` from the fresh file inventory for every edited file,",
      "including flows, schemas, skills, agents, rules, and MCP files.",
      "Use `baseHash: null` only for a new file.",
    ].join(" "),
    "- Never use absolute paths. Paths are relative to the package root.",
  ].join("\n");
}

function actionJsonShapeSection(): string {
  return [
    "## Action JSON shape",
    "```json",
    JSON.stringify(
      {
        schemaVersion: "maister_flow_assistant_action.v1",
        actionId: "short-optional-id",
        summary: "What changes",
        operations: [
          {
            op: "upsert_file",
            path: "flows/example/flow.yaml",
            baseHash: "sha256:...",
            content: "complete new file content",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function activeFlowSection(sections: FlowAssistantContextSections): string {
  return [
    "## Active flow",
    sections.flowPath
      ? `Path: ${sections.flowPath}`
      : "No flow.yaml file found.",
    sections.flowPath
      ? truncate(sections.byPath.get(sections.flowPath) ?? "", ACTIVE_FLOW_MAX)
      : "",
  ].join("\n");
}

function validationIssuesSection(
  validationIssues: ReturnType<typeof validatePackageArtifacts>,
): string {
  return [
    "## Validation issues",
    validationIssues.length > 0
      ? validationIssues
          .slice(0, 30)
          .map((issue) => `- ${issue.path}: ${issue.message}`)
          .join("\n")
      : "No current package validation issues.",
  ].join("\n");
}

function editorFocusSection(sections: FlowAssistantContextSections): string {
  const rejectedFocus =
    sections.rejectedFocus.length > 0
      ? [
          "Rejected focus hints:",
          ...sections.rejectedFocus.map((item) => `- ${item}`),
        ].join("\n")
      : "Rejected focus hints: none";

  return [
    "## Editor focus",
    `Focus path: ${sections.focus.focusPath ?? "none"}`,
    `Selected node: ${sections.selectedNodeId ?? "none"}`,
    rejectedFocus,
  ].join("\n");
}

function selectFlowPath(args: {
  focusPath: string | null;
  paths: readonly string[];
}): string | null {
  if (args.focusPath && isFlowPath(args.focusPath)) return args.focusPath;
  if (args.paths.includes("flow.yaml")) return "flow.yaml";

  return (
    args.paths.filter(isFlowPath).sort((a, b) => a.localeCompare(b))[0] ?? null
  );
}

function buildGraphSection(
  flowPath: string,
  content: string | undefined,
): {
  nodes: Array<{ id: string; type: string; label: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
  nodeIds: Set<string>;
  manifest: FlowYamlV1 | null;
  error: string | null;
} {
  if (content === undefined) {
    return {
      nodes: [],
      edges: [],
      nodeIds: new Set(),
      manifest: null,
      error: "flow file missing",
    };
  }

  try {
    const data = parseYaml(content);
    const parsed = flowYamlV1Schema.parse(data);
    const graph = buildAuthoredFlowGraph(parsed, 0);
    const nodes = graph.topology.nodes.map((node) => ({
      id: node.id,
      type: node.nodeType,
      label: node.displayLabel,
    }));
    const edges = graph.topology.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.displayLabel,
    }));

    return {
      nodes,
      edges,
      nodeIds: new Set(nodes.map((node) => node.id)),
      manifest: parsed,
      error: null,
    };
  } catch (err) {
    log.warn(
      { flowPath, err: err instanceof Error ? err.message : String(err) },
      "flow assistant context graph build failed",
    );

    return {
      nodes: [],
      edges: [],
      nodeIds: new Set(),
      manifest: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function countCapabilities(paths: readonly string[]): CapabilityCounts {
  const counts: CapabilityCounts = {
    flows: 0,
    agents: 0,
    skills: 0,
    mcps: 0,
    rules: 0,
    schemas: 0,
  };

  for (const path of paths) {
    if (isFlowPath(path)) counts.flows += 1;
    else if (/^(?:maister-agents|agents)\/[^/]+\.md$/.test(path))
      counts.agents += 1;
    else if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) counts.skills += 1;
    else if (/^mcps\/.+/.test(path)) counts.mcps += 1;
    else if (/^rules\/.+/.test(path)) counts.rules += 1;
    else if (/^schemas\/.+/.test(path)) counts.schemas += 1;
  }

  return counts;
}

function formatInventory(
  inventory: ReadonlyArray<{
    path: string;
    hash: string;
    kind: string;
    bytes: number;
  }>,
): string {
  const visible = inventory.slice(0, INVENTORY_MAX);
  const lines = visible.map(
    (file) =>
      `- ${file.path} | ${file.kind} | ${file.hash} | ${file.bytes} bytes`,
  );

  if (inventory.length > visible.length) {
    lines.push(`- ... ${inventory.length - visible.length} more files omitted`);
  }

  return lines.length > 0 ? lines.join("\n") : "No files found.";
}

function formatCapabilityCounts(counts: CapabilityCounts): string {
  return [
    `- flows: ${counts.flows}`,
    `- agents: ${counts.agents}`,
    `- skills: ${counts.skills}`,
    `- mcps: ${counts.mcps}`,
    `- rules: ${counts.rules}`,
    `- schemas: ${counts.schemas}`,
  ].join("\n");
}

function formatGraph(graph: ReturnType<typeof buildGraphSection>): string {
  if (graph.error) return `Graph error: ${graph.error}`;

  return [
    `Nodes (${graph.nodes.length}):`,
    ...graph.nodes
      .slice(0, 80)
      .map((node) => `- ${node.id} | ${node.type} | ${node.label}`),
    `Edges (${graph.edges.length}):`,
    ...graph.edges
      .slice(0, 120)
      .map((edge) => `- ${edge.source} -> ${edge.target} | ${edge.label}`),
  ].join("\n");
}

function formatTemplateVariableCatalog(args: {
  selectedNodeId: string | null;
  catalog: TemplateVariableCatalogResult | null;
}): string {
  if (!args.selectedNodeId) {
    return "No selected node. Variable availability cannot be scoped.";
  }

  if (!args.catalog) {
    return "Variable catalog unavailable because the active flow could not be parsed.";
  }

  const visibleEntries = args.catalog.entries.slice(0, TEMPLATE_VARIABLE_MAX);
  const lines = [
    `Selected node: ${args.selectedNodeId}`,
    "Use `insertText` exactly inside prompts/commands. Bare paths are safe only when availability=definite and presence=required; optional/conditional entries include a `?? '<literal>'` guard.",
    "Available variables:",
    ...visibleEntries.map(formatTemplateVariableEntry),
  ];

  if (args.catalog.entries.length > visibleEntries.length) {
    lines.push(
      `- ... ${args.catalog.entries.length - visibleEntries.length} more variables omitted`,
    );
  }

  if (args.catalog.unavailablePaths.length > 0) {
    lines.push(
      "Unavailable at selected node:",
      ...args.catalog.unavailablePaths.slice(0, 30).map((path) => `- ${path}`),
    );
  }

  if (args.catalog.warnings.length > 0) {
    lines.push(
      "Catalog warnings:",
      ...args.catalog.warnings
        .slice(0, 30)
        .map(
          (warning) =>
            `- ${warning.nodeId} ${warning.schemaRef}: ${warning.message}`,
        ),
    );
  }

  return lines.join("\n");
}

function formatTemplateVariableEntry(
  entry: TemplateVariableCatalogResult["entries"][number],
): string {
  const details = [
    `source=${entry.source}`,
    `availability=${entry.availability}`,
    `presence=${entry.presence}`,
    `insertText=\`{{ ${entry.insertText} }}\``,
  ];

  if (entry.valueType) details.push(`type=${entry.valueType}`);
  if (entry.nodeId) details.push(`node=${entry.nodeId}`);

  return `- ${entry.path} | ${details.join(" | ")}`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function isFlowPath(path: string): boolean {
  return path === "flow.yaml" || /^flows\/.+\/flow\.yaml$/.test(path);
}
