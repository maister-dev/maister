import "server-only";
import type { Db } from "@/lib/execution-host/db";
import type { InstallResult } from "@/lib/flows";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  flowRunnerRemaps,
  flowRevisions,
  flows,
  platformAcpRunners,
  projectFlowRunnerDefaults,
} from "@/lib/db/schema";
import { syncFlowRunnerReconfigurationRequirements } from "@/lib/acp-runners/flow-reconfiguration";
import { MaisterError } from "@/lib/errors";
export async function prepareDependencyFlow(
  tx: Db,
  projectId: string,
  flow: Pick<InstallResult, "flowRowId" | "manifest" | "revisionId">,
  declaredRunner?: string,
): Promise<void> {
  const runner = declaredRunner === "inherit" ? undefined : declaredRunner;
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
      .values({
        id: randomUUID(),
        projectId,
        flowId: flow.flowRowId,
        runnerId: runner,
      })
      .onConflictDoNothing({
        target: [
          projectFlowRunnerDefaults.projectId,
          projectFlowRunnerDefaults.flowId,
        ],
      });
  const bindings = missing.length
    ? await tx
        .select()
        .from(flowRunnerRemaps)
        .where(
          and(
            eq(flowRunnerRemaps.projectId, projectId),
            eq(flowRunnerRemaps.flowRevisionId, flow.revisionId),
          ),
        )
    : [];
  const mapped = new Set(
    bindings
      .filter(
        (row) =>
          row.status === "Mapped" &&
          row.mappedRunnerId &&
          current.has(row.mappedRunnerId),
      )
      .map((row) => row.slotKey),
  );
  const [effectiveDefault] = runner
    ? await tx
        .select({ id: projectFlowRunnerDefaults.runnerId })
        .from(projectFlowRunnerDefaults)
        .where(
          and(
            eq(projectFlowRunnerDefaults.projectId, projectId),
            eq(projectFlowRunnerDefaults.flowId, flow.flowRowId),
          ),
        )
    : [];

  if (
    missing.some((slot) => !mapped.has(slot.slotKey)) ||
    (runner && !current.has(effectiveDefault?.id ?? runner))
  )
    await tx
      .update(flows)
      .set({ enablementState: "Disabled", updatedAt: new Date() })
      .where(eq(flows.id, flow.flowRowId));
}
