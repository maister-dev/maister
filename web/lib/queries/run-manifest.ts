import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { flowRevisions, flows, runs } = schema;

const log = pino({
  name: "run-manifest",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
type Db = NodePgDatabase<typeof schema>;

export interface RunManifest {
  flowId: string;
  manifest: FlowYamlV1;
}

/**
 * Resolve a run's flow id and pinned manifest. Prefer the immutable
 * flow_revisions.manifest (launch-time snapshot); fall back to the mutable
 * flows.manifest for legacy rows. Returns null for a flow-less run (e.g.
 * scratch) or when no manifest is reachable. Mirrors the resolution in
 * lib/queries/run.ts getRunSettings.
 */
export async function loadRunManifest(
  runId: string,
  db?: Db,
): Promise<RunManifest | null> {
  const client = db ?? (getDb() as unknown as Db);

  const rows = await client
    .select({
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row?.flowId) {
    log.debug({ runId }, "[run-manifest] run has no flow");

    return null;
  }

  let manifest: FlowYamlV1 | null = null;

  if (row.flowRevisionId) {
    const revisionRows = await client
      .select({ manifest: flowRevisions.manifest })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, row.flowRevisionId));

    manifest = (revisionRows[0]?.manifest as FlowYamlV1 | undefined) ?? null;
  }

  if (!manifest) {
    const flowRows = await client
      .select({ manifest: flows.manifest })
      .from(flows)
      .where(eq(flows.id, row.flowId));

    manifest = (flowRows[0]?.manifest as FlowYamlV1 | undefined) ?? null;
  }

  if (!manifest) {
    log.debug({ runId, flowId: row.flowId }, "[run-manifest] no manifest");

    return null;
  }

  return { flowId: row.flowId, manifest };
}
