import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  TemplateVariableCatalogWarning,
  TemplateVariableEntry,
  TemplateVariablePackageFile,
  TemplateVariableUsageWarning,
} from "@/lib/flows/editor/template-variable-catalog";

import {
  STATIC_TEMPLATE_VARIABLES,
  analyzeTemplateVariableUsage,
  buildTemplateVariableCatalog,
} from "@/lib/flows/editor/template-variable-catalog";

type NodeDef = NonNullable<FlowYamlV1["nodes"]>[number];

export type PromptAssistsForNode = {
  variableCatalog: TemplateVariableEntry[];
  variableWarnings: TemplateVariableUsageWarning[];
  catalogWarnings: TemplateVariableCatalogWarning[];
};

export type BuildPromptAssistsForNodeInput = {
  manifest: FlowYamlV1;
  selectedNodeId: string | null;
  files: readonly TemplateVariablePackageFile[];
};

const EMPTY_ASSISTS: PromptAssistsForNode = {
  variableCatalog: [],
  variableWarnings: [],
  catalogWarnings: [],
};

export function buildPromptAssistsForNode({
  manifest,
  selectedNodeId,
  files,
}: BuildPromptAssistsForNodeInput): PromptAssistsForNode {
  if (selectedNodeId === null) {
    return {
      variableCatalog: [...STATIC_TEMPLATE_VARIABLES],
      variableWarnings: [],
      catalogWarnings: [],
    };
  }

  const node = findNode(manifest, selectedNodeId);

  if (!node || !isPromptNode(node)) return EMPTY_ASSISTS;

  const catalog = buildTemplateVariableCatalog({
    manifest,
    selectedNodeId,
    files,
  });
  const usage = analyzeTemplateVariableUsage(promptForNode(node), catalog);

  return {
    variableCatalog: catalog.entries,
    variableWarnings: usage.warnings,
    catalogWarnings: catalog.warnings,
  };
}

function findNode(manifest: FlowYamlV1, nodeId: string): NodeDef | null {
  return manifest.nodes?.find((node) => node.id === nodeId) ?? null;
}

function isPromptNode(node: NodeDef): boolean {
  return (
    node.type === "ai_coding" ||
    node.type === "judge" ||
    node.type === "orchestrator"
  );
}

function promptForNode(node: NodeDef): string {
  if (!isPromptNode(node)) return "";

  const action = isRecord(node.action) ? node.action : {};

  return typeof action.prompt === "string" ? action.prompt : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
