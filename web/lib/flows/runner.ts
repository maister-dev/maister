import { readWorkspaceIntegrityLimit } from "@/lib/agents/operational-diagnostics";
import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  loadRun,
  CompanyFlowLoadFailure,
  resolveFlowRuntimeRoot,
  type Db,
  type LoadedRun,
  type RunFlowOptions,
} from "./graph/runner-core";
import { runGraph } from "./graph/runner-graph";
import { compileManifest } from "./graph/compile";
import { bindExecution } from "./runner-agent";
import {
  claimFlowDriver,
  claimUnplacedSessionlessFlowDriver,
  isFlowDriverClaimLost,
} from "./graph/driver-claim";
import { flowTraversalRequirements } from "./graph/traversal-requirements";
import { flowDriverDatabase } from "./graph/driver-db";
import { withFlowDriver } from "./graph/driver-lifetime";
import { wakeParkedCoordinator } from "./graph/coordinator-wake";

import { getDb } from "@/lib/db/client";
import {
  executionAssignments,
  flowNodeRestartCheckpoints,
} from "@/lib/db/schema";
import { isProjectionTransactionUnavailable } from "@/lib/execution-host/events/projection-transaction";
import { promoteNextPending } from "@/lib/scheduler";
import { finalizeCompanyFlowRun } from "@/lib/run-results/company-flow-terminal";
import {
  createExecutionHosts,
  ensureAssignment,
  isFencedError,
} from "@/lib/execution-host";

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

export type { RunFlowOptions } from "./graph/runner-core";

export async function runFlow(
  runId: string,
  opts: RunFlowOptions = {},
): Promise<void> {
  const db: Db = opts.db ?? getDb();
  const runtimeRoot = resolveFlowRuntimeRoot(opts.runtimeRoot);
  const logger = log.child({ runId });

  logger.info({ runtimeRoot }, "runFlow start");

  let loaded: LoadedRun;

  try {
    loaded = await loadRun(db, runId);
  } catch (error) {
    if (error instanceof CompanyFlowLoadFailure) {
      const finalized = await finalizeCompanyFlowRun({
        db,
        rootDb: db,
        runId,
        requested: "Failed",
        errorCode: error.code,
        admissionRefusedBeforeTraversal: true,
        integrityLimit: readWorkspaceIntegrityLimit(error),
        reason:
          typeof error.details?.reason === "string"
            ? error.details.reason
            : "company_flow_admission_refused",
        hosts: opts.executionHosts,
      });

      // Early authority refusal releases a slot before graph traversal owns its
      // normal exit wake. Continue the existing queue only after terminal CAS.
      if (finalized)
        await promoteNextPending({
          db,
          runFlow: (nextRunId) =>
            runFlow(nextRunId, {
              db,
              runtimeRoot,
              executionHosts: opts.executionHosts,
            }),
        });
    }
    logger.error({ error, runId }, "runFlow loadRun failed");
    throw error;
  }

  if (loaded.run.companyCancellationIntent) {
    logger.info(
      { companyId: loaded.run.companyId },
      "company graph continuation deferred to retained cancellation",
    );

    return;
  }
  const graph = compileManifest(loaded.manifest);
  const requirements = flowTraversalRequirements(graph);

  if (!["Running", "NeedsInput"].includes(loaded.run.status)) {
    await runGraph(loaded, { ...opts, db, runtimeRoot });
    await wakeParkedCoordinator({
      db,
      parentRunId: runId,
      cause: "post_park",
      resumeOptions: { runtimeRoot, executionHosts: opts.executionHosts },
    });

    return;
  }
  // Keep host registration, canonical consumers and owner application on the
  // root database. Only this graph's traversal receives the fenced handle.
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });
  const requiresWorkspaceCommand = [...graph.nodes.values()].some(
    (node) => node.nodeType === "wait" || node.nodeType === "publish",
  );
  const execution =
    requirements.ownedPrompts || requiresWorkspaceCommand
      ? (opts.execution ??
        (await bindExecution(hosts, runId, {
          assignmentId: loaded.run.executionAssignmentId,
        })))
      : opts.execution;
  // CLI-only traversal owns a database lease without creating an ACP session.
  // ADR-166's existing backfill handles only never-placed historical rows.
  const assignmentId =
    execution?.client.assignment.id ??
    loaded.run.executionAssignmentId ??
    (requirements.ownedPrompts || requirements.cliActions
      ? (
          await ensureAssignment(db, runId, "legacy_backfill", {
            transport: hosts.transport,
          })
        ).id
      : null);
  const claim = assignmentId
    ? await claimFlowDriver(db, { runId, assignmentId })
    : await claimUnplacedSessionlessFlowDriver(db, runId);

  if (!claim) {
    logger.info({}, "flow-driver-already-owned");

    return;
  }
  try {
    await withFlowDriver(
      db,
      claim,
      async (signal) => {
        const scoped = flowDriverDatabase(db, claim, signal);
        const current = await loadRun(scoped, runId);
        const [placement] =
          current.run.resumeStartedAt &&
          current.run.currentStepId &&
          claim.scope === "assignment"
            ? await scoped
                .select({
                  reason: executionAssignments.placementReason,
                  checkpoint: flowNodeRestartCheckpoints,
                })
                .from(executionAssignments)
                .leftJoin(
                  flowNodeRestartCheckpoints,
                  eq(
                    flowNodeRestartCheckpoints.assignmentId,
                    executionAssignments.id,
                  ),
                )
                .where(eq(executionAssignments.id, claim.assignmentId))
            : [];
        const crashResume =
          placement?.reason === "node_restart" && current.run.currentStepId
            ? {
                targetStepId: current.run.currentStepId,
                freshSession: true as const,
                ...(placement.checkpoint
                  ? { checkpoint: placement.checkpoint }
                  : {}),
              }
            : opts.crashResume?.freshSession
              ? undefined
              : opts.crashResume;

        await runGraph(current, {
          ...opts,
          crashResume,
          db: scoped,
          runtimeRoot,
          executionHosts: hosts,
          execution,
          driver: { rootDb: db, claim, signal },
        });
      },
      opts.signal,
    );
  } catch (error) {
    if (
      !isFlowDriverClaimLost(error) &&
      !isFencedError(error) &&
      !isProjectionTransactionUnavailable(error)
    )
      throw error;
    logger.warn({ assignmentId: claim.assignmentId }, "flow-driver-yielded");
  }
  await wakeParkedCoordinator({
    db,
    parentRunId: runId,
    cause: "post_park",
    resumeOptions: { runtimeRoot, executionHosts: hosts },
  });
}
