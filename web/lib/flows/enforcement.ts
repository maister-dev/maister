import "server-only";

import type {
  AiCodingSettings,
  CapabilityAgent,
  EnforcementMode,
  JudgeSettings,
  NodeDef,
} from "@/lib/config.schema";
import type { EnforcementSnapshotEntry } from "@/lib/db/schema";

import { MaisterError } from "@/lib/errors";

export type CapabilityClass = EnforcementSnapshotEntry["class"];

type AgentName = CapabilityAgent;
type Capability = EnforcementSnapshotEntry["capability"];

export type EnforceabilityTable = Record<
  AgentName,
  Record<CapabilityClass, Capability>
>;

// FROZEN M11c table (docs/system-analytics/flow-settings.md + ADR-032): every
// cell is `instructed`. Nothing is hard-enforced per session yet, so a `strict`
// intent on any class cannot be honored and MUST refuse the launch rather than
// silently degrade to instruction (the silent-escape-hatch invariant).
export const ENFORCEABILITY_BY_AGENT: EnforceabilityTable = {
  claude: {
    mcps: "instructed", // TODO(M14): flip to "enforced" once mcps is materialized per session
    tools: "instructed", // TODO(M14): flip to "enforced" once tools is materialized per session
    skills: "instructed", // TODO(M14): flip to "enforced" once skills is materialized per session
    restrictions: "instructed", // TODO(M14): flip to "enforced" once restrictions is materialized per session
    permissionMode: "instructed", // TODO(M14): flip to "enforced" once permissionMode is materialized per session
    workspaceAccess: "instructed", // TODO(M14): flip to "enforced" once workspaceAccess is materialized per session
    hooks: "instructed", // ADR-104: supervisor-enforced at the ACP seam; kept instructed (ADR-041 frozen)
  },
  codex: {
    mcps: "instructed", // TODO(M14): flip to "enforced" once mcps is materialized per session
    tools: "instructed", // TODO(M14): flip to "enforced" once tools is materialized per session
    skills: "instructed", // TODO(M14): flip to "enforced" once skills is materialized per session
    restrictions: "instructed", // TODO(M14): flip to "enforced" once restrictions is materialized per session
    permissionMode: "instructed", // TODO(M14): flip to "enforced" once permissionMode is materialized per session
    workspaceAccess: "instructed", // TODO(M14): flip to "enforced" once workspaceAccess is materialized per session
    hooks: "instructed", // ADR-104: supervisor-enforced at the ACP seam; kept instructed (ADR-041 frozen)
  },
  gemini: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
  opencode: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
  mimo: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
};

const ALL_CLASSES: CapabilityClass[] = [
  "mcps",
  "tools",
  "skills",
  "restrictions",
  "permissionMode",
  "workspaceAccess",
  "hooks",
];

type CapabilityBearingSettings = AiCodingSettings | JudgeSettings | undefined;

// A class is "declared" by a node when its data field is present on settings OR
// an explicit `enforcement[class]` entry is present. Data-field-only declares
// default to the `instruct` intent.
function isDeclared(
  settings: NonNullable<CapabilityBearingSettings>,
  cls: CapabilityClass,
): boolean {
  const data = (settings as Record<string, unknown>)[cls];

  if (data !== undefined) return true;

  return settings.enforcement?.[cls] !== undefined;
}

// Pure resolution of every DECLARED capability class to its launch verdict. No
// DB, no logging. `off` classes are omitted entirely.
export function evaluateNodeEnforcement(
  settings: CapabilityBearingSettings,
  agent: AgentName,
  table: EnforceabilityTable = ENFORCEABILITY_BY_AGENT,
): EnforcementSnapshotEntry[] {
  if (!settings) return [];

  const entries: EnforcementSnapshotEntry[] = [];

  for (const cls of ALL_CLASSES) {
    if (!isDeclared(settings, cls)) continue;

    const declared: EnforcementMode = settings.enforcement?.[cls] ?? "instruct";

    if (declared === "off") continue;

    const capability = table[agent][cls];
    const verdict =
      declared === "strict"
        ? capability === "enforced"
          ? "enforced"
          : "refused"
        : "instructed";

    entries.push({ class: cls, declared, capability, verdict });
  }

  return entries;
}

export type LaunchableNode = {
  id: string;
  type?: string;
  nodeType?: string;
  settings?: CapabilityBearingSettings;
};

function resolveNodeType(node: LaunchableNode): string | undefined {
  return node.type ?? node.nodeType;
}

// Refuse to launch a capability-bearing node whose strict intent cannot be
// honored by the resolved agent. CONFIG when NO agent in the table can enforce
// the class at all (the build cannot strictly enforce it) → a config error the
// author must fix. EXECUTOR_UNAVAILABLE when SOME agent enforces it but the
// resolved one does not → a different executor would launch. Throws on the
// first refused class. Non-capability nodes are a no-op.
export function assertNodeLaunchable(
  node: LaunchableNode,
  agent: AgentName,
  table: EnforceabilityTable = ENFORCEABILITY_BY_AGENT,
): void {
  const nodeType = resolveNodeType(node);

  if (
    nodeType !== "ai_coding" &&
    nodeType !== "judge" &&
    nodeType !== "orchestrator"
  )
    return;

  const verdicts = evaluateNodeEnforcement(node.settings, agent, table);

  for (const entry of verdicts) {
    if (entry.verdict !== "refused") continue;

    const enforceableByAnyAgent = (Object.keys(table) as AgentName[]).some(
      (a) => table[a][entry.class] === "enforced",
    );

    const detail = `node "${node.id}" declares strict enforcement of "${entry.class}" but resolved agent "${agent}" can only ${entry.capability} it (declared=${entry.declared}, capability=${entry.capability})`;

    throw enforceableByAnyAgent
      ? new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          `${detail} — another executor can enforce this class`,
        )
      : new MaisterError(
          "CONFIG",
          `${detail} — no executor can strictly enforce this class`,
        );
  }
}

// Narrow a CompiledNode's union settings to the capability-bearing shape the
// evaluator accepts. ai_coding/judge settings ARE that shape; other node types'
// settings are not capability-bearing and resolve to undefined.
export function capabilityBearingSettings(
  nodeType: NodeDef["type"] | string | undefined,
  settings: NodeDef["settings"],
): CapabilityBearingSettings {
  if (
    nodeType === "ai_coding" ||
    nodeType === "judge" ||
    nodeType === "orchestrator"
  ) {
    return settings as CapabilityBearingSettings;
  }

  return undefined;
}
