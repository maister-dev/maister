import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  classifyStoredFlowManifest,
  type FlowManifestIncompatibility,
} from "@/lib/flows/manifest-parser";
import { requireRunProjectId } from "@/lib/runs/run-kind-invariants";

const { flowRevisions, flows, runs } = schema;

const log = pino({
  name: "run-manifest",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

type RunManifestIdentity = {
  flowId: string;
  projectId: string;
};

export type RunManifest = RunManifestIdentity &
  (
    | { compatible: true; manifest: FlowYamlV1; incompatibility: null }
    | {
        compatible: false;
        manifest: null;
        incompatibility: FlowManifestIncompatibility;
      }
  );

/**
 * Resolve a run's flow id, owning project id, and pinned manifest. Prefer the
 * immutable flow_revisions.manifest (launch-time snapshot); fall back to the
 * mutable flows.manifest for legacy rows. Returns null for a flow-less run
 * (e.g. scratch) or when no manifest is reachable. Mirrors the resolution in
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
      projectId: runs.projectId,
      flowRevisionId: runs.flowRevisionId,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row?.flowId) {
    log.debug({ runId }, "[run-manifest] run has no flow");

    return null;
  }

  let manifest: unknown = null;

  if (row.flowRevisionId) {
    const revisionRows = await client
      .select({ manifest: flowRevisions.manifest })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, row.flowRevisionId));

    manifest = revisionRows[0]?.manifest ?? null;
  }

  if (!manifest) {
    const flowRows = await client
      .select({ manifest: flows.manifest })
      .from(flows)
      .where(eq(flows.id, row.flowId));

    manifest = flowRows[0]?.manifest ?? null;
  }

  if (!manifest) {
    log.debug({ runId, flowId: row.flowId }, "[run-manifest] no manifest");

    return null;
  }

  const identity = {
    flowId: row.flowId,
    projectId: requireRunProjectId(row.projectId, runId),
  };
  const compatibility = classifyStoredFlowManifest(manifest);

  if (!compatibility.compatible) {
    log.warn(
      {
        runId,
        flowId: row.flowId,
        kind: compatibility.reason.kind,
        manifestShape: compatibility.manifestShape,
      },
      "stored run manifest is incompatible",
    );

    return {
      ...identity,
      compatible: false,
      manifest: null,
      incompatibility: compatibility.reason,
    };
  }

  return {
    ...identity,
    compatible: true,
    manifest: compatibility.manifest,
    incompatibility: null,
  };
}
