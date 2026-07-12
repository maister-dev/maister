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

export type OverlayCapabilityClass = "rules" | "skills" | "mcps" | "subagents";

export type OverlayClassSupportTable = Record<
  AgentName,
  Record<OverlayCapabilityClass, boolean>
>;

// ADR-130 (docs/system-analytics/flow-settings.md + capabilities.md): `tools`,
// `mcps`, and `hooks` are `enforced` for ALL adapters via the adapter-agnostic
// capability_guard seam interceptor; per-adapter admission is the async launch
// evidence gate (`assertEnforcementEvidence`), NOT the static table. The four
// remaining classes stay `instructed` — each lacks a tool-identity seam mechanism:
//   skills          — instructions/materialized files, not tool calls
//   restrictions    — path-based mustNotTouch deny-sets (mutation-check gate), not
//                     tool identity (a deny-set is not an allow-list complement)
//   permissionMode  — claude-only settings.local.json defaultMode, unverified;
//                     a 3-valued ask|allow|deny intent is not a tool-identity allow-list
//   workspaceAccess — not delivered to the seam on the flow path (follow-up)
// The table is uniform across adapters (the interceptor is one code path). The
// M14-deferred flip is complete — see ADR-130 §scope refinement for why the four
// classes above stay instructed.
const SEAM_ENFORCED_ROW: Record<CapabilityClass, Capability> = {
  mcps: "enforced", // capability_guard MCP-server allow-list (evidence-gated at launch)
  tools: "enforced", // capability_guard tool-name allow-list (evidence-gated at launch)
  skills: "instructed", // not seam-interceptable (materialized files, not tool calls)
  restrictions: "instructed", // path deny-set via mutation-check gate, not tool identity
  permissionMode: "instructed", // claude-only defaultMode, unverified; not an allow-list
  workspaceAccess: "instructed", // not delivered to the seam on the flow path (follow-up)
  hooks: "enforced", // supervisor-enforced at the ACP seam since M40 (ADR-108); label corrected by ADR-130
};

export const ENFORCEABILITY_BY_AGENT: EnforceabilityTable = {
  claude: { ...SEAM_ENFORCED_ROW },
  codex: { ...SEAM_ENFORCED_ROW },
  gemini: { ...SEAM_ENFORCED_ROW },
  opencode: { ...SEAM_ENFORCED_ROW },
  mimo: { ...SEAM_ENFORCED_ROW },
};

export const OVERLAY_CLASS_SUPPORT_BY_AGENT: OverlayClassSupportTable = {
  claude: {
    rules: true,
    skills: true,
    mcps: true,
    subagents: true,
  },
  codex: {
    rules: true,
    skills: true,
    mcps: true,
    subagents: false,
  },
  gemini: {
    rules: true,
    skills: true,
    mcps: true,
    subagents: false,
  },
  opencode: {
    rules: true,
    skills: true,
    mcps: true,
    subagents: false,
  },
  mimo: {
    rules: true,
    skills: true,
    mcps: true,
    subagents: false,
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
