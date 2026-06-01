import "server-only";

import type { AiCodingSettings, JudgeSettings } from "@/lib/config.schema";
import type { EnforcementSnapshotEntry } from "@/lib/db/schema";

import { evaluateNodeEnforcement } from "@/lib/flows/enforcement";

export interface SettingsClassView {
  class: EnforcementSnapshotEntry["class"];
  verdict: EnforcementSnapshotEntry["verdict"];
}

export interface SettingsNodeView {
  nodeId: string;
  nodeType: "ai_coding" | "judge";
  classes: SettingsClassView[];
}

export interface SettingsViewNode {
  id: string;
  type: string;
  settings?: AiCodingSettings | JudgeSettings | unknown;
}

// The capability-class view-model for the run-detail settings panel. Carries
// ONLY {nodeId, nodeType, classes:[{class, verdict}]} — never executor env,
// tokens, or any secret material (server-only-secrets invariant; the panel and
// the serialized view are guarded against /token|key|secret/i).
//
// Per node:
//  - cli/check/human/anything-else → excluded (no capability classes).
//  - a recorded snapshot for the node (node_attempts.enforcement_snapshot,
//    keyed by nodeId) projects {class, verdict} from the audit record so a
//    refused-at-launch run shows the recorded verdict it never executed under.
//  - otherwise live `evaluateNodeEnforcement` resolves each declared class.
//  - a capability node with no declared/strict classes → present, classes: [].
export function buildSettingsView(
  nodes: SettingsViewNode[],
  agent: "claude" | "codex",
  snapshotByNode?: Record<string, EnforcementSnapshotEntry[]>,
): SettingsNodeView[] {
  const view: SettingsNodeView[] = [];

  for (const node of nodes) {
    if (node.type !== "ai_coding" && node.type !== "judge") continue;

    const recorded = snapshotByNode?.[node.id];
    const entries = recorded
      ? recorded
      : evaluateNodeEnforcement(
          node.settings as AiCodingSettings | JudgeSettings | undefined,
          agent,
        );

    view.push({
      nodeId: node.id,
      nodeType: node.type,
      classes: entries.map((e) => ({ class: e.class, verdict: e.verdict })),
    });
  }

  return view;
}
