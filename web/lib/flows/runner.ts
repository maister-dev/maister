import "server-only";

import pino from "pino";

import {
  loadRun,
  resolveFlowRuntimeRoot,
  type Db,
  type LoadedRun,
  type RunFlowOptions,
} from "./graph/runner-core";
import { runGraph } from "./graph/runner-graph";
import { compileManifest } from "./graph/compile";
import { bindExecution } from "./runner-agent";
import { claimFlowDriver, isFlowDriverClaimLost } from "./graph/driver-claim";
import { flowDriverDatabase } from "./graph/driver-db";
import { withFlowDriver } from "./graph/driver-lifetime";

import { getDb } from "@/lib/db/client";
import { createExecutionHosts, isFencedError } from "@/lib/execution-host";

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
    logger.error({ error, runId }, "runFlow loadRun failed");
    throw error;
  }

  const graph = compileManifest(loaded.manifest);
  const hasOwnedPrompts = [...graph.nodes.values()].some(
    (node) =>
      ["ai_coding", "judge", "orchestrator"].includes(node.nodeType) ||
      node.gates.some(
        (gate) => gate.kind === "ai_judgment" || gate.kind === "skill_check",
      ),
  );

  if (
    !hasOwnedPrompts ||
    !["Running", "NeedsInput"].includes(loaded.run.status)
  ) {
    await runGraph(loaded, { ...opts, db, runtimeRoot });

    return;
  }
  // Keep host registration, canonical consumers and owner application on the
  // root database. Only this graph's traversal receives the fenced handle.
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });
  const execution =
    opts.execution ??
    (await bindExecution(hosts, runId, {
      assignmentId: loaded.run.executionAssignmentId,
    }));
  const claim = await claimFlowDriver(db, {
    runId,
    assignmentId: execution.client.assignment.id,
  });

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

        await runGraph(current, {
          ...opts,
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
    if (!isFlowDriverClaimLost(error) && !isFencedError(error)) throw error;
    logger.warn({ assignmentId: claim.assignmentId }, "flow-driver-yielded");
  }
}
