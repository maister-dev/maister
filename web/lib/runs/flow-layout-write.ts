import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { loadRunManifest } from "@/lib/queries/run-manifest";

const { flowGraphLayouts } = schema;

const log = pino({
  name: "flow-layout-write",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
type Db = NodePgDatabase<typeof schema>;

const COORD_BOUND = 1e7;

export interface UpsertNodeLayoutArgs {
  runId: string;
  nodeId: string;
  x: number;
  y: number;
  userId: string | null;
  db?: Db;
}

function isValidCoord(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= COORD_BOUND;
}

/**
 * Upsert one manual node position for the run's flow. flow_id is server-state
 * (resolved from the run); a flow-less run is refused. nodeId is validated
 * against the run's pinned-manifest node set (allow-list) before any write, and
 * coordinates are bounded floats. Keyed (flow_id, node_id), last-writer-wins.
 */
export async function upsertNodeLayout(
  args: UpsertNodeLayoutArgs,
): Promise<{ ok: true }> {
  const { runId, nodeId, x, y, userId } = args;
  const client = args.db ?? (getDb() as unknown as Db);

  log.debug({ runId, nodeId, x, y }, "[flow-layout.upsert] request");

  const loaded = await loadRunManifest(runId, client);

  if (!loaded) {
    log.warn({ runId }, "[flow-layout.upsert] refused: run has no flow");
    throw new MaisterError("CONFIG", `run has no flow: ${runId}`);
  }

  const graph = compileManifest(loaded.manifest);

  if (!graph.nodes.has(nodeId)) {
    log.warn({ runId, nodeId }, "[flow-layout.upsert] refused: unknown node");
    throw new MaisterError(
      "CONFIG",
      `unknown node "${nodeId}" for run ${runId}`,
    );
  }

  if (!isValidCoord(x) || !isValidCoord(y)) {
    log.warn(
      { runId, nodeId, x, y },
      "[flow-layout.upsert] refused: coordinates out of bounds",
    );
    throw new MaisterError(
      "CONFIG",
      `position out of bounds for node "${nodeId}" (run ${runId})`,
    );
  }

  await client
    .insert(flowGraphLayouts)
    .values({
      flowId: loaded.flowId,
      nodeId,
      x,
      y,
      updatedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [flowGraphLayouts.flowId, flowGraphLayouts.nodeId],
      set: { x, y, updatedByUserId: userId, updatedAt: new Date() },
    });

  log.info(
    { runId, flowId: loaded.flowId, nodeId },
    "[flow-layout.upsert] upserted",
  );

  return { ok: true };
}
