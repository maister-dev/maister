import "server-only";
import type { Db } from "@/lib/execution-host/db";
import type { InstallResult } from "@/lib/flows";
import { randomUUID } from "node:crypto";
import { and,eq } from "drizzle-orm";
import { flowRevisions,flows,platformAcpRunners,projectFlowRunnerDefaults } from "@/lib/db/schema";
import { syncFlowRunnerReconfigurationRequirements } from "@/lib/acp-runners/flow-reconfiguration";
import { MaisterError } from "@/lib/errors";
export async function prepareDependencyFlow(
  tx: Db,
  projectId: string,
  flow: Pick<InstallResult, "flowRowId" | "manifest" | "revisionId">,
  runner?: string,
): Promise<void> {
  const [rev] = await tx
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flow.revisionId));
  if (rev.setupStatus === "failed")
    throw new MaisterError("FLOW_INSTALL", "Flow setup failed", {
      details: { reason: "setup_failed" },
    });
  const runners = await tx
    .select({ id: platformAcpRunners.id })
    .from(platformAcpRunners)
    .where(
      and(
        eq(platformAcpRunners.enabled, true),
        eq(platformAcpRunners.readinessStatus, "Ready"),
      ),
    );
  const current = new Set(runners.map((r) => r.id));
  const missing = await syncFlowRunnerReconfigurationRequirements({
    db: tx,
    projectId,
    flowRevisionId: flow.revisionId,
    flowId: flow.manifest.name,
    manifest: flow.manifest,
    platformRunnerIds: current,
  });
  if (runner && current.has(runner))
    await tx
      .insert(projectFlowRunnerDefaults)
      .values({id:randomUUID(), projectId, flowId: flow.flowRowId, runnerId: runner })
      .onConflictDoUpdate({
        target: [
          projectFlowRunnerDefaults.projectId,
          projectFlowRunnerDefaults.flowId,
        ],
        set: { runnerId: runner, updatedAt: new Date() },
      });
  if (missing.length || (runner && !current.has(runner)))
    await tx
      .update(flows)
      .set({ enablementState: "Disabled", updatedAt: new Date() })
      .where(eq(flows.id, flow.flowRowId));
}

