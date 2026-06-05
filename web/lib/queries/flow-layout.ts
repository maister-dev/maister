import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { flowGraphLayouts } = schema;

const log = pino({
  name: "flow-layout",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
type Db = NodePgDatabase<typeof schema>;

export type FlowLayout = Record<string, { x: number; y: number }>;

/**
 * Stored manual node positions for a flow, as a nodeId -> {x,y} override map.
 * Auto-layout (dagre) seeds the baseline at render; these rows override it.
 */
export async function getFlowLayout(
  flowId: string,
  db?: Db,
): Promise<FlowLayout> {
  const client = db ?? (getDb() as unknown as Db);

  const rows = await client
    .select({
      nodeId: flowGraphLayouts.nodeId,
      x: flowGraphLayouts.x,
      y: flowGraphLayouts.y,
    })
    .from(flowGraphLayouts)
    .where(eq(flowGraphLayouts.flowId, flowId));

  const map: FlowLayout = {};

  for (const row of rows) {
    map[row.nodeId] = { x: row.x, y: row.y };
  }

  log.debug({ flowId, count: rows.length }, "[flow-layout.get]");

  return map;
}
