import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { WorkspaceInputFile } from "@/lib/execution-host/workspace-inputs";
import type { FlowGraph } from "./graph/compile";
import type { WorkspaceWorkloadDeclaration } from "../../../runtime/workspace-prepare";

import {
  WORKSPACE_FLOW_SETUP_COMMAND,
  WORKSPACE_FLOW_SETUP_ID,
  WORKSPACE_FLOW_SETUP_TIMEOUT_MS,
  WORKSPACE_WORKLOAD_DEFAULT_TIMEOUT_MS,
  WORKSPACE_WORKLOAD_FILE,
  WORKSPACE_WORKLOAD_FILE_MAX_BYTES,
  WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH,
  WORKSPACE_WORKLOAD_MAX_DECLARATIONS,
  WORKSPACE_WORKLOAD_MAX_TIMEOUT_MS,
  workspaceEvidenceDigest,
} from "../../../runtime/workspace-prepare";

import { FLOW_REQUIREMENT_TIMEOUT_MS } from "./requirements-check";

import { MaisterError } from "@/lib/errors";

export function nodeWorkloadDeclarationId(nodeId: string): string {
  return `node:${workspaceEvidenceDigest(nodeId)}`;
}

export function gateWorkloadDeclarationId(
  nodeId: string,
  gateId: string,
): string {
  return `gate:${workspaceEvidenceDigest([nodeId, gateId])}`;
}

export function addressedFlowUsesPackageAssets(graph: FlowGraph): boolean {
  return [...graph.nodes.values()].some(({ source: { node }, gates }) =>
    ((node.type === "cli" || node.type === "check") &&
      node.action.command.includes("MAISTER_FLOW_DIR")) ||
    gates.some((gate) => gate.kind === "command_check" && gate.command?.includes("MAISTER_FLOW_DIR"))
  );
}

/** Freeze declarations from the compiled revision at the same boundary as the Run inputs. */
export function captureAddressedFlowWorkloads(
  graph: FlowGraph,
  requirements: FlowYamlV1["requirements"],
  setupRevisionId?: string,
): readonly WorkspaceInputFile[] {
  const declarations: WorkspaceWorkloadDeclaration[] = (requirements ?? []).map(
    ({ probe }, index) => ({
      id: `probe:${index}`,
      workload: "requirementProbe",
      command: probe,
      timeoutMs: FLOW_REQUIREMENT_TIMEOUT_MS,
    }),
  );
  if (setupRevisionId) declarations.push({
    id: WORKSPACE_FLOW_SETUP_ID,
    workload: "setup",
    command: WORKSPACE_FLOW_SETUP_COMMAND,
    timeoutMs: WORKSPACE_FLOW_SETUP_TIMEOUT_MS,
    flowAssets: true,
    flowSetup: setupRevisionId,
  });
  const assetBinding = (command: string) =>
    command.includes("MAISTER_FLOW_DIR")
      ? { flowAssets: true as const, ...(setupRevisionId ? { flowSetup: setupRevisionId } : {}) }
      : {};

  for (const node of graph.nodes.values()) {
    const definition = node.source.node;
    if (definition.type === "cli" || definition.type === "check") {
      declarations.push({
        id: nodeWorkloadDeclarationId(node.id),
        workload: definition.type,
        command: definition.action.command,
        timeoutMs: Math.min(
          definition.settings?.timeoutMs ??
            WORKSPACE_WORKLOAD_DEFAULT_TIMEOUT_MS,
          WORKSPACE_WORKLOAD_MAX_TIMEOUT_MS,
        ),
        ...(definition.output?.result ? { structuredOutput: "jsonFile" } : {}),
        ...assetBinding(definition.action.command),
      });
    }
    for (const gate of node.gates) {
      if (gate.kind !== "command_check" || !gate.command) continue;
      declarations.push({
        id: gateWorkloadDeclarationId(node.id, gate.id),
        workload: "check",
        command: gate.command,
        timeoutMs: WORKSPACE_WORKLOAD_DEFAULT_TIMEOUT_MS,
        ...assetBinding(gate.command),
      });
    }
  }

  if (declarations.length === 0) return [];
  const bytes = Buffer.from(JSON.stringify(declarations));
  if (
    declarations.length > WORKSPACE_WORKLOAD_MAX_DECLARATIONS ||
    bytes.byteLength > WORKSPACE_WORKLOAD_FILE_MAX_BYTES ||
    declarations.some(
      ({ command }) =>
        command.length > WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH ||
        command.includes("\0"),
    )
  )
    throw new MaisterError(
      "CONFIG",
      "The Flow exceeds the selected supervisor's workload declaration limits",
      {
        details: { reason: "launch_input_limit" },
      },
    );

  return [{ path: WORKSPACE_WORKLOAD_FILE, bytes }];
}
