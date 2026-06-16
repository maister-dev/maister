import type { RunInspectorFlowSummary } from "@/components/runs/run-inspector";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { scratchCapabilityProfiles, scratchRuns } = schema;

export interface ScratchSessionSummary {
  dialogStatus: string;
  mcpCount: number;
  skillCount: number;
  ruleCount: number;
}

export interface ScratchSessionLabels {
  title: string;
  dialog: string;
  capabilities: string;
}

// Pure flow-summary builder (M35 T5.3): a scratch run has no flow graph, so the
// inspector's flow tab shows a compact Session summary instead — the live
// dialog status plus the selected capability profile (MCP / skill / rule
// counts). Reuses the RunInspectorFlowSummary node shape (label + status rows).
export function buildScratchSessionFlowSummary(
  session: ScratchSessionSummary,
  labels: ScratchSessionLabels,
): RunInspectorFlowSummary {
  return {
    title: labels.title,
    subtitle: session.dialogStatus,
    nodes: [
      { id: "dialog", label: labels.dialog, status: session.dialogStatus },
      {
        id: "capabilities",
        label: labels.capabilities,
        status: `${session.mcpCount} · ${session.skillCount} · ${session.ruleCount}`,
      },
    ],
  };
}

export async function getScratchSessionSummary(
  runId: string,
): Promise<ScratchSessionSummary | null> {
  const db = getDb() as unknown as NodePgDatabase<typeof schema>;
  const [scratchRows, profileRows] = await Promise.all([
    db
      .select({ dialogStatus: scratchRuns.dialogStatus })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId)),
    db
      .select({
        selectedMcpIds: scratchCapabilityProfiles.selectedMcpIds,
        selectedSkillIds: scratchCapabilityProfiles.selectedSkillIds,
        selectedRuleIds: scratchCapabilityProfiles.selectedRuleIds,
      })
      .from(scratchCapabilityProfiles)
      .where(eq(scratchCapabilityProfiles.runId, runId)),
  ]);
  const scratch = scratchRows[0];

  if (!scratch) return null;

  const profile = profileRows[0];

  return {
    dialogStatus: scratch.dialogStatus,
    mcpCount: profile?.selectedMcpIds?.length ?? 0,
    skillCount: profile?.selectedSkillIds?.length ?? 0,
    ruleCount: profile?.selectedRuleIds?.length ?? 0,
  };
}
