import type { FlowYamlV1 } from "@/lib/config.schema";
import type { GraphTopology } from "@/lib/flows/graph/topology";

type NodeDef = NonNullable<FlowYamlV1["nodes"]>[number];
type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return value && typeof value === "object" ? (value as Rec) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function countLabel(count: number, singular: string): string | null {
  if (count <= 0) return null;

  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function listLabel(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  const items = value.map(String).filter(Boolean);

  return items.length > 0 ? items.join(", ") : null;
}

function mcpLabel(value: unknown): string | null {
  if (Array.isArray(value)) return listLabel(value);

  const record = asRec(value);
  const refs = [
    ...(Array.isArray(record.required) ? record.required : []),
    ...(Array.isArray(record.additional) ? record.additional : []),
  ]
    .map(String)
    .filter(Boolean);
  const uniqueRefs = [...new Set(refs)];

  return uniqueRefs.length > 0 ? uniqueRefs.join(", ") : null;
}

export function buildFlowNodeTooltipsFromNodes(
  nodes: readonly NodeDef[],
): Record<string, string> {
  return Object.fromEntries(
    nodes.map((node) => {
      const n = asRec(node);
      const settings = asRec(n.settings);
      const action = asRec(n.action);
      const rework = asRec(n.rework);
      const transitions = asRec(n.transitions);
      const gates = (asRec(n.pre_finish).gates as unknown[] | undefined) ?? [];
      const skills = listLabel(settings.skills);
      const mcps = mcpLabel(settings.mcps);
      const reworkTargets = listLabel(rework.allowedTargets);

      return [
        String(n.id ?? ""),
        [
          `${String(n.id ?? "")} · ${String(n.type ?? "")}`,
          str(settings.model) ? `model: ${str(settings.model)}` : null,
          str(action.command) ? `command: ${str(action.command)}` : null,
          str(action.prompt) ? `prompt: ${str(action.prompt)}` : null,
          str(settings.permissionMode)
            ? `permission: ${str(settings.permissionMode)}`
            : null,
          str(settings.workspaceAccess)
            ? `workspace: ${str(settings.workspaceAccess)}`
            : null,
          skills ? `skills: ${skills}` : null,
          mcps ? `mcps: ${mcps}` : null,
          countLabel(Object.keys(transitions).length, "transition"),
          countLabel(gates.length, "gate"),
          reworkTargets ? `rework: ${reworkTargets}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ];
    }),
  );
}

export function buildFlowNodeTooltipsFromManifest(
  manifest: FlowYamlV1,
): Record<string, string> {
  return buildFlowNodeTooltipsFromNodes(manifest.nodes ?? []);
}

export function buildFlowNodeTooltipsFromTopology(
  topology: GraphTopology,
): Record<string, string> {
  return Object.fromEntries(
    topology.nodes.map((node) => {
      const outgoing = topology.edges.filter(
        (edge) => edge.source === node.id,
      ).length;

      return [
        node.id,
        [
          `${node.displayLabel} · ${node.nodeTypeLabel}`,
          countLabel(node.declaredGateSummary.total, "gate"),
          countLabel(outgoing, "transition"),
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ];
    }),
  );
}
