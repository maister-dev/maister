import "server-only";

import type { LocalPackage } from "@/lib/db/schema";
import type { FlowAssistantIntent } from "./protocol";

import { parse as parseYaml } from "yaml";
import pino from "pino";

import { packageFileHash } from "./actions";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
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

export async function buildFlowAssistantContext(args: {
  localPackage: LocalPackage;
  intent: FlowAssistantIntent;
  focus?: FlowAssistantFocus;
  runnerLabel?: string | null;
}): Promise<FlowAssistantContext> {
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
  const manifest = byPath.get("maister-package.yaml") ?? null;
  const validationIssues = validatePackageArtifacts({
    files,
    changedPaths: files.map((file) => file.path),
  });
  const capabilityCounts = countCapabilities(files.map((file) => file.path));
  const selectedNodeId =
    focus.selectedNodeId && graph?.nodeIds.has(focus.selectedNodeId)
      ? focus.selectedNodeId
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
      fileCount: files.length,
      grammarChars: grammar.length,
      flowPath,
      nodeCount: graph?.nodes.length ?? 0,
      edgeCount: graph?.edges.length ?? 0,
      validationIssueCount: validationIssues.length,
      focusPath: focus.focusPath,
      selectedNodeId,
      rejectedFocusCount: rejectedFocus.length,
    },
    "built flow assistant context",
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
      "## Editing contract",
      "- You are in a read-only ACP session. Do not edit files directly.",
      "- For Q&A, answer from the context below and the authoritative Flow DSL grammar section below.",
      "- For edits, return exactly one fenced `maister-flow-assistant-action` block after any short explanation.",
      "- Use only `upsert_file` and `delete_file` full-file operations.",
      "- Copy `baseHash` from the file inventory. Use `baseHash: null` for a new file.",
      "- Never use absolute paths. Paths are relative to the package root.",
      "",
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
      "",
      grammar,
      "",
      "## File inventory",
      formatInventory(inventory),
      "",
      "## Capability inventory",
      formatCapabilityCounts(capabilityCounts),
      "",
      "## Package manifest",
      manifest
        ? truncate(manifest, MANIFEST_MAX)
        : "No maister-package.yaml found.",
      "",
      "## Active flow",
      flowPath ? `Path: ${flowPath}` : "No flow.yaml file found.",
      flowPath ? truncate(byPath.get(flowPath) ?? "", ACTIVE_FLOW_MAX) : "",
      "",
      "## Graph summary",
      graph ? formatGraph(graph) : "Graph unavailable.",
      "",
      "## Validation issues",
      validationIssues.length > 0
        ? validationIssues
            .slice(0, 30)
            .map((issue) => `- ${issue.path}: ${issue.message}`)
            .join("\n")
        : "No current package validation issues.",
      "",
      "## Editor focus",
      `Focus path: ${focus.focusPath ?? "none"}`,
      `Selected node: ${selectedNodeId ?? "none"}`,
      rejectedFocus.length > 0
        ? `Rejected focus hints:\n${rejectedFocus.map((item) => `- ${item}`).join("\n")}`
        : "Rejected focus hints: none",
    ].join("\n"),
    focusPath: focus.focusPath,
    selectedNodeId,
    rejectedFocus,
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
  error: string | null;
} {
  if (content === undefined) {
    return {
      nodes: [],
      edges: [],
      nodeIds: new Set(),
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

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function isFlowPath(path: string): boolean {
  return path === "flow.yaml" || /^flows\/.+\/flow\.yaml$/.test(path);
}
