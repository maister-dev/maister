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

import { getDb } from "@/lib/db/client";

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

  await runGraph(loaded, { ...opts, db, runtimeRoot });
}
